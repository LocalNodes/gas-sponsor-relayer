// The wrong-answer watcher against a stubbed chain and a canned hub (D-16, TM-83, TM-84): what it challenges,
// what it leaves alone, how it behaves at the cap's edge, and what it reports. The fork test covers the real contracts.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { decodeFunctionData, pad, parseAbi } from 'viem';
import { createCap } from '../../src/cap.js';
import { createHub } from '../../src/hub.js';
import { openDb } from '../../src/db.js';
import { loadNetworks } from '../../src/config.js';
import { createEvents } from '../../src/events.js';
import { buildQuestion, moduleTransactionHash, packedTxHashes, QUESTION_SEPARATOR, questionHashOf } from '../../src/realityHash.js';
import { createWatcher, DEFAULT_WATCH_INTERVAL_S, LOG_RANGE_BLOCKS, MAX_CHALLENGE_ATTEMPTS, watchSettingsFromEnv } from '../../src/watcher.js';
import { hubProposal, startHubStub } from '../stub/hub-stub.js';
import { questionLog } from '../helpers/questionLog.js';

const CHAIN = 11155111;
const networks = loadNetworks();
const REALITY = networks[String(CHAIN)].reality;
const MODULE = '0x1111111111111111111111111111111111111111';
const SAFE = '0x2222222222222222222222222222222222222222';
const RELAYER = '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc';
const PAYEE = '0x3333333333333333333333333333333333333333';
const ATTACKER = '0x4444444444444444444444444444444444444444';
const SPACE = 'watch.eth';
const YES = pad('0x01', { size: 32 });
const NO = pad('0x00', { size: 32 });
const INVALID = `0x${'ff'.repeat(32)}`;
const BOND = 10n ** 15n;
const FINALIZE_TS = 2_000_000_000n;
/** When the hub says the vote on a proposal ended. */
const END = 1_700_000_000n;
const TX_A = { to: PAYEE, value: 10n ** 15n, data: '0x', operation: 0 };
const TX_B = { to: ATTACKER, value: 5n * 10n ** 15n, data: '0x', operation: 0 };
const quiet = { info() {}, warn() {}, error() {} };
const answerAbi = parseAbi(['function submitAnswer(bytes32 question_id, bytes32 answer, uint256 max_previous)']);
const newId = () => `0x${randomBytes(32).toString('hex')}`;

/** A chain stub holding Reality questions. The watcher's reads and its log scan go through it. */
function fakeChain({ latest, balance }) {
  const s = { latest, balance, questions: new Map(), logs: [], ranges: [], cooldown: 300 };
  const publicClient = {
    async getBlockNumber() { return s.latest; },
    // The chain's finalized block: the head unless the test sets `finalized` (an Error makes the read fail).
    async getBlock({ blockTag }) {
      if (blockTag !== 'finalized') throw new Error(`unexpected block read ${blockTag}`);
      if (s.finalized instanceof Error) throw s.finalized;
      return { number: s.finalized ?? s.latest };
    },
    async getLogs({ fromBlock, toBlock, args }) {
      s.ranges.push([fromBlock, toBlock]);
      if (s.logsError && args.question_id) throw s.logsError;
      const match = (l) => Object.entries(args).every(([k, v]) => String(l.args[k]).toLowerCase() === String(v).toLowerCase());
      // `ignoreRange`: a node that answers with logs outside the blocks asked for.
      return s.logs.filter((l) => (s.ignoreRange || (l.blockNumber >= fromBlock && l.blockNumber <= toBlock)) && match(l));
    },
    async getBalance() { return s.balance; },
    async readContract({ functionName, args }) {
      if (functionName === 'questionCooldown') return s.cooldown;
      const q = s.questions.get(args[0]);
      if (functionName === 'isFinalized') return q.finalized;
      if (functionName === 'getBond') return q.bond;
      if (functionName === 'getBestAnswer') return q.best;
      if (functionName === 'resultFor') return q.result;
      if (functionName === 'getFinalizeTS') return q.finalizeTs;
      throw new Error(`unexpected read ${functionName}`);
    },
    async estimateGas() { return 100_000n; },
    async estimateFeesPerGas() { return { maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 10n ** 8n }; },
  };
  return { state: s, chains: { get: (id) => (Number(id) === CHAIN ? { publicClient, walletClient: {} } : null) } };
}

/** A watcher over a stubbed chain, a stub hub, the real cap and the real pipeline; the queue only records. */
async function world({ caps = { dayWei: 10n ** 18n, monthWei: 10n ** 19n }, latest = 1000n, lookback = 1000n, balance = 10n ** 18n, lowBalanceWei, logger = quiet } = {}) {
  const db = openDb(':memory:');
  db.addGroup({ chainId: CHAIN, safe: SAFE, space: SPACE, community: 'c' });
  const hubStub = await startHubStub();
  const config = { address: RELAYER, hubUrls: { [CHAIN]: hubStub.url }, sequencerUrls: { [CHAIN]: hubStub.url } };
  const events = createEvents({ db });
  const chain = fakeChain({ latest, balance });
  const cap = createCap({ db, caps, now: () => 1_700_000_000_000 });
  const sent = [];
  let nonce = 100;
  const queue = {
    async enqueue(chainId, build, meta) {
      const tx = await build();
      sent.push(tx);
      const n = nonce;
      nonce += 1;
      const hash = `0x${n.toString(16).padStart(64, '0')}`;
      db.insertPending({ chainId, nonce: n, hash, to: tx.to, data: tx.data, value: tx.value, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, sentBlock: 1n, spendId: meta.reservation?.id ?? null, safe: meta.safe, kind: meta.kind });
      return { hash, nonce: n };
    },
  };
  const watcher = createWatcher({
    db,
    config,
    networks,
    chains: chain.chains,
    cap,
    queue,
    groupModules: { modulesFor: async () => [MODULE] },
    hub: createHub({ networks, config, sleep: async () => {} }),
    events,
    lookbackBlocks: lookback,
    ...(lowBalanceWei === undefined ? {} : { lowBalanceWei }),
    logger,
  });
  const w = { db, cap, chain, hubStub, events, watcher, sent };
  /**
   * A question asked to the module. `hub` is what the hub holds for the proposal (null: unknown to the hub; a
   * `state` makes it an open vote); `txs` are the transactions the question's hash covers. `created` is the time
   * Reality gives the question; by default it was asked while the vote was open when `hub.state` is given, else after
   * the vote ended at `END`.
   */
  w.ask = ({ proposalId = newId(), txs = [TX_A], hub = { txs: [TX_A] }, best = YES, bond = BOND, blockNumber = 900n, created, asked: text = (q) => q } = {}) => {
    if (hub) w.vote(proposalId, hub);
    const question = text(buildQuestion(proposalId, txs.map((t, i) => moduleTransactionHash(CHAIN, MODULE, t, i))));
    const questionId = newId();
    const asked = created === undefined ? (hub?.state ? END - 100n : END + 100n) : created;
    chain.state.logs.push(questionLog({ blockNumber, questionId, user: MODULE, question, created: asked }));
    chain.state.questions.set(questionId, { bond, best, finalized: false, finalizeTs: FINALIZE_TS });
    return { proposalId, questionId };
  };
  /** What the hub holds for a proposal: closed, final and passed, unless `state` makes it an open vote. */
  w.vote = (proposalId, { txs = [TX_A], state, end = Number(END) } = {}) => {
    hubStub.set(hubProposal({ id: proposalId, space: SPACE, module: MODULE, chainId: CHAIN, txs, scores: state ? [] : [2, 0, 1], quorum: 2, state: state ?? 'closed', scoresState: state ? 'pending' : 'final', end }));
  };
  w.q = (id) => chain.state.questions.get(id);
  w.count = (type, questionId) => events.list(0).events.filter((e) => e.type === type && (questionId === undefined || e.questionId === questionId)).length;
  w.close = () => hubStub.close();
  return w;
}

const withWorld = (opts, fn) => async () => {
  const w = await world(opts);
  try {
    await fn(w);
  } finally {
    await w.close();
  }
};

describe('watcher', () => {
  test('watcher: a wrong answer the cap cannot cover sends nothing and stores one escalation_needed with the finalize time, however many ticks pass',
    withWorld({ caps: { dayWei: 2n * BOND - 1n, monthWei: 10n ** 19n } }, async (w) => {
      const { questionId, proposalId } = w.ask({ txs: [TX_B] });
      for (let i = 0; i < 3; i += 1) await w.watcher.tick();
      assert.equal(w.sent.length, 0, 'nothing was broadcast');
      assert.equal(w.count('escalation_needed', questionId), 1, 'one escalation after three ticks');
      assert.equal(w.count('answer_challenged'), 0);
      const [e] = w.events.list(0).events;
      assert.equal(e.proposalId, '', 'the question is not the proposal\'s, so the event names no proposal');
      assert.notEqual(e.proposalId, proposalId);
      assert.equal(e.detail.reason, 'cap_reached');
      assert.equal(e.detail.currentBondWei, BOND.toString());
      assert.equal(e.detail.neededBondWei, (2n * BOND).toString());
      assert.equal(e.detail.deadline, new Date(Number(FINALIZE_TS) * 1000).toISOString(), 'the deadline is the question finalize time');
      assert.equal(e.detail.currentAnswer, 'yes');
      assert.equal(e.detail.expectedAnswer, 'invalid', 'the question is not the proposal\'s');

      // The cap frees up before the deadline: the next tick challenges, and the escalation is not repeated.
      w.cap.caps.dayWei = 10n ** 18n;
      await w.watcher.tick();
      assert.equal(w.sent.length, 1);
      assert.equal(w.count('answer_challenged', questionId), 1);
      assert.equal(w.count('escalation_needed', questionId), 1);
    }));

  test('watcher: a higher wrong answer on an escalated question is a new escalation, the same answer is not',
    withWorld({ caps: { dayWei: 2n * BOND - 1n, monthWei: 10n ** 19n } }, async (w) => {
      const { questionId } = w.ask({ txs: [TX_B] });
      await w.watcher.tick();
      await w.watcher.tick();
      assert.equal(w.count('escalation_needed', questionId), 1);
      w.q(questionId).bond = 4n * BOND; // the attacker outbid
      await w.watcher.tick();
      await w.watcher.tick();
      const all = w.events.list(0).events.filter((e) => e.type === 'escalation_needed');
      assert.deepEqual(all.map((e) => e.detail.currentBondWei), [BOND.toString(), (4n * BOND).toString()]);
    }));

  test('watcher: a yes on a question for a proposal the hub does not know is challenged with invalid, double the bond, max_previous = the current bond',
    withWorld({}, async (w) => {
      const { questionId } = w.ask({ hub: null });
      const actions = await w.watcher.tick();
      assert.equal(w.sent.length, 1);
      const tx = w.sent[0];
      assert.equal(tx.to, REALITY);
      assert.equal(tx.value, 2n * BOND);
      const { args } = decodeFunctionData({ abi: answerAbi, data: tx.data });
      assert.deepEqual(args, [questionId, INVALID, BOND]);
      assert.equal(actions[0].action, 'challenged');
      const row = w.db.getQuestion(CHAIN, questionId);
      assert.equal(row.bondWei, 2n * BOND, 'the bond is stored for the reclaim loop');
      assert.equal(row.fromBlock, 900n, 'the history starts at the block the question was asked in');
    }));

  test('watcher: the in-flight mark is written before the challenge\'s bond is stored',
    withWorld({}, async (w) => {
      const { questionId } = w.ask({ hub: null });
      const insert = w.db.insertQuestion;
      let flaggedWhenStored = null;
      w.db.insertQuestion = (...args) => {
        flaggedWhenStored = w.db.getWatched(CHAIN, questionId).flagged;
        return insert.apply(w.db, args);
      };
      await w.watcher.tick();
      assert.equal(w.sent.length, 1);
      assert.equal(flaggedWhenStored, true, 'the mark that stops a second challenge comes first');
    }));

  test('watcher: storing the challenge fails after its broadcast: the next tick does not challenge again',
    withWorld({}, async (w) => {
      w.ask({ hub: null });
      const insert = w.db.insertQuestion;
      let failed = 0;
      w.db.insertQuestion = (...args) => {
        if (failed === 0) {
          failed += 1;
          throw new Error('disk full');
        }
        return insert.apply(w.db, args);
      };
      await w.watcher.tick().catch(() => {});
      assert.equal(w.sent.length, 1);
      await w.watcher.tick().catch(() => {});
      await w.watcher.tick().catch(() => {});
      assert.equal(w.sent.length, 1, 'one challenge, however many ticks follow');
    }));

  test('watcher: a correct answer sends nothing and stores nothing',
    withWorld({}, async (w) => {
      w.ask({ txs: [TX_A], best: YES });
      await w.watcher.tick();
      await w.watcher.tick();
      assert.equal(w.sent.length, 0);
      assert.equal(w.events.list(0).events.length, 0);
    }));

  test('watcher: a question nobody has answered is left alone (its best answer reads as zero, which is no)',
    withWorld({}, async (w) => {
      w.ask({ txs: [TX_A], best: NO, bond: 0n });
      await w.watcher.tick();
      await w.watcher.tick();
      assert.equal(w.sent.length, 0, 'no zero-bond challenge');
      assert.equal(w.events.list(0).events.length, 0);
    }));

  test('watcher: a question asked before the vote resolved is answered invalid, whatever the best answer is',
    withWorld({}, async (w) => {
      w.ask({ txs: [TX_A], hub: { txs: [TX_A], state: 'active' }, best: YES });
      await w.watcher.tick();
      assert.equal(w.sent.length, 1);
      assert.equal(decodeFunctionData({ abi: answerAbi, data: w.sent[0].data }).args[1], INVALID);
    }));

  test('watcher: a question asked while the vote was open stays invalid after the vote closes and passes: the standing invalid is not challenged',
    withWorld({}, async (w) => {
      const { proposalId, questionId } = w.ask({ txs: [TX_A], hub: { txs: [TX_A], state: 'active' }, best: INVALID });
      await w.watcher.tick();
      assert.equal(w.sent.length, 0, 'while the vote is open, invalid is right');
      w.vote(proposalId, { txs: [TX_A] });
      await w.watcher.tick();
      await w.watcher.tick();
      assert.equal(w.sent.length, 0, 'after the vote passed, invalid is still right for a question asked before it ended');
      assert.equal(w.count('answer_challenged', questionId), 0);
      assert.equal(w.count('escalation_needed', questionId), 0);
    }));

  test('watcher: a question asked while the vote was open and answered yes after it passed is challenged with invalid',
    withWorld({}, async (w) => {
      const { proposalId } = w.ask({ txs: [TX_A], hub: { txs: [TX_A], state: 'active' }, best: YES });
      w.vote(proposalId, { txs: [TX_A] });
      await w.watcher.tick();
      assert.equal(w.sent.length, 1);
      assert.equal(decodeFunctionData({ abi: answerAbi, data: w.sent[0].data }).args[1], INVALID);
    }));

  test('watcher: a question asked at the second the vote ended is judged by the vote',
    withWorld({}, async (w) => {
      w.ask({ txs: [TX_A], best: INVALID, created: END });
      await w.watcher.tick();
      assert.equal(w.sent.length, 1);
      assert.equal(decodeFunctionData({ abi: answerAbi, data: w.sent[0].data }).args[1], YES);
    }));

  test('watcher: a question asked when the vote ended, its count not final yet, is not challenged; a standing yes is one escalation_needed',
    withWorld({}, async (w) => {
      const { questionId: invalidOne } = w.ask({ txs: [TX_A], hub: { txs: [TX_A], state: 'closed' }, best: INVALID, created: END + 100n });
      const { questionId: yesOne } = w.ask({ txs: [TX_A], hub: { txs: [TX_A], state: 'closed' }, best: YES, created: END + 100n });
      await w.watcher.tick();
      await w.watcher.tick();
      assert.equal(w.sent.length, 0, 'no challenge on a guess');
      assert.equal(w.count('escalation_needed', invalidOne), 0, 'a standing invalid moves no money');
      assert.equal(w.count('escalation_needed', yesOne), 1, 'one alert for a standing yes, however many ticks');
      const e = w.events.list(0).events.find((x) => x.questionId === yesOne);
      assert.equal(e.detail.reason, 'cannot_decide');
      assert.equal(e.detail.expectedAnswer, null);
      assert.equal(e.detail.deadlineTs, Number(FINALIZE_TS));
    }));

  test('watcher: a question whose asking time cannot be read, or whose vote has no end time, is not challenged',
    withWorld({}, async (w) => {
      const { questionId: noTime } = w.ask({ txs: [TX_A], best: YES, created: 'x' });
      const { proposalId, questionId: noEnd } = w.ask({ txs: [TX_A], best: YES });
      w.vote(proposalId, { txs: [TX_A], end: null });
      await w.watcher.tick();
      assert.equal(w.sent.length, 0, 'no challenge on a guess');
      assert.equal(w.count('escalation_needed', noTime), 1);
      assert.equal(w.count('escalation_needed', noEnd), 1);
      assert.equal(w.events.list(0).events.every((e) => e.detail.reason === 'cannot_decide'), true);
    }));

  test('watcher: a question an older watcher stored, beyond the first look back, is read once at the block it was asked in, from a final block',
    withWorld({ lookback: 50n }, async (w) => {
      const { proposalId, questionId } = w.ask({ txs: [TX_A], hub: { txs: [TX_A], state: 'active' }, best: YES, blockNumber: 900n });
      w.vote(proposalId, { txs: [TX_A] });
      // A question stored by an older watcher, which kept no asking time.
      const questionHash = packedTxHashes([moduleTransactionHash(CHAIN, MODULE, TX_A, 0)]).slice(2);
      w.db.insertWatched({ chainId: CHAIN, questionId, module: MODULE, safe: SAFE, proposalId, questionHash, createdBlock: 900n });
      await w.watcher.tick();
      assert.equal(w.sent.length, 1);
      assert.equal(decodeFunctionData({ abi: answerAbi, data: w.sent[0].data }).args[1], INVALID);
      const row = w.db.getWatched(CHAIN, questionId);
      assert.equal(row.createdTs, END - 100n, 'stored');
      assert.equal(row.createdFinal, true);
      assert.ok(row.questionKey, 'the whole question is stored as its key');
      assert.equal(w.chain.state.ranges.filter(([a, b]) => a === 900n && b === 900n).length, 1, 'one read at the block it was asked in');
      await w.watcher.tick();
      assert.equal(w.chain.state.ranges.filter(([a, b]) => a === 900n && b === 900n).length, 1, 'not read again');
    }));

  test('watcher: a finalized question that cannot be decided stays open, with no event, until it can',
    withWorld({}, async (w) => {
      const { proposalId, questionId } = w.ask({ txs: [TX_A], hub: { txs: [TX_A], state: 'closed' }, created: END + 100n });
      Object.assign(w.q(questionId), { finalized: true, result: NO });
      await w.watcher.tick();
      assert.equal(w.events.list(0).events.length, 0, 'no wrong_final on a guess');
      assert.equal(w.db.getWatched(CHAIN, questionId).status, 'open');
      w.vote(proposalId, { txs: [TX_A] });
      await w.watcher.tick();
      assert.equal(w.count('wrong_final', questionId), 1);
      assert.equal(w.db.getWatched(CHAIN, questionId).status, 'closed');
    }));

  test('watcher: a question found by the watcher in a final block is stored with its time, its key and the final mark, and used as stored',
    withWorld({}, async (w) => {
      const { questionId } = w.ask({ txs: [TX_A], created: END + 7n });
      await w.watcher.tick();
      await w.watcher.tick();
      const row = w.db.getWatched(CHAIN, questionId);
      assert.equal(row.createdTs, END + 7n);
      assert.equal(row.createdFinal, true);
      assert.ok(row.questionKey);
      assert.equal(w.chain.state.ranges.filter(([a, b]) => a === 900n && b === 900n).length, 0, 'no second read');
    }));

  test('watcher: a question in a block above the finalized block is not read; the cursor stops at the finalized block, and the question is read once its block is final',
    withWorld({}, async (w) => {
      w.chain.state.finalized = 800n;
      const { questionId } = w.ask({ txs: [TX_A], best: YES, blockNumber: 900n, created: END - 5n });
      await w.watcher.tick();
      assert.equal(w.db.getWatched(CHAIN, questionId), null, 'not stored');
      assert.equal(w.chain.state.ranges.every(([, to]) => to <= 800n), true, JSON.stringify(w.chain.state.ranges.map(String)));
      // The chain replaces block 900 before it is final; the same question is in block 905 now, asked after the vote ended.
      const log = w.chain.state.logs.find((l) => l.args.question_id === questionId);
      log.blockNumber = 905n;
      log.args = { ...log.args, created: END + 5n };
      w.chain.state.finalized = 950n;
      await w.watcher.tick();
      assert.equal(w.sent.length, 0, 'yes is right for a question asked after the vote ended');
      const row = w.db.getWatched(CHAIN, questionId);
      assert.equal(row.createdBlock, 905n);
      assert.equal(row.createdTs, END + 5n);
      assert.equal(row.createdFinal, true);
      assert.equal(w.chain.state.ranges.filter(([from]) => from <= 800n && from !== 0n).length, 0, 'blocks up to 800 are not read twice');
    }));

  test('watcher: a log the node returns from outside the blocks asked for is not stored',
    withWorld({}, async (w) => {
      w.chain.state.finalized = 800n;
      w.chain.state.ignoreRange = true;
      const { questionId } = w.ask({ txs: [TX_A], best: YES, blockNumber: 900n });
      await w.watcher.tick();
      assert.equal(w.db.getWatched(CHAIN, questionId), null);
    }));

  test('watcher: an older row whose block was not final is not used; its log is read again, only in final blocks',
    withWorld({ lookback: 50n }, async (w) => {
      const { proposalId, questionId } = w.ask({ txs: [TX_A], hub: { txs: [TX_A], state: 'active' }, best: YES, blockNumber: 900n });
      w.vote(proposalId, { txs: [TX_A] });
      // Stored near the head by an older watcher: a time, not final, no key.
      const questionHash = packedTxHashes([moduleTransactionHash(CHAIN, MODULE, TX_A, 0)]).slice(2);
      w.db.insertWatched({ chainId: CHAIN, questionId, module: MODULE, safe: SAFE, proposalId, questionHash, createdBlock: 900n, createdTs: END + 100n });
      w.chain.state.logsError = new Error('rpc down');
      await w.watcher.tick();
      assert.equal(w.sent.length, 0, 'no challenge on a time that could not be checked');
      assert.equal(w.count('answer_challenged'), 0);
      w.chain.state.logsError = null;
      w.chain.state.finalized = 899n;
      const before = w.chain.state.ranges.length;
      await w.watcher.tick();
      assert.equal(w.sent.length, 0, 'block 900 is not final yet: not read');
      assert.equal(w.chain.state.ranges.slice(before).every(([, to]) => to <= 899n), true, 'no read past the finalized block');
      assert.equal(w.db.getWatched(CHAIN, questionId).createdFinal, false);
      w.chain.state.finalized = 1000n;
      await w.watcher.tick();
      assert.equal(w.sent.length, 1, 'read again, it is early: invalid');
      assert.equal(decodeFunctionData({ abi: answerAbi, data: w.sent[0].data }).args[1], INVALID);
      assert.equal(w.db.getWatched(CHAIN, questionId).createdTs, END - 100n);
    }));

  test('watcher: an older row read at a final block but stored without the question\'s key is read again for its whole question, then decided',
    withWorld({ lookback: 50n }, async (w) => {
      const { questionId } = w.ask({ txs: [TX_B], best: YES, blockNumber: 900n });
      // A row of the previous release: time and final mark, the parts of the question, no key.
      const questionHash = packedTxHashes([moduleTransactionHash(CHAIN, MODULE, TX_B, 0)]).slice(2);
      w.db.insertWatched({ chainId: CHAIN, questionId, module: MODULE, safe: SAFE, proposalId: newId(), questionHash, createdBlock: 900n, createdTs: END + 100n, createdFinal: true });
      await w.watcher.tick();
      assert.equal(w.chain.state.ranges.filter(([a, b]) => a === 900n && b === 900n).length, 1, 'read once for its whole question');
      assert.ok(w.db.getWatched(CHAIN, questionId).questionKey);
      assert.equal(w.sent.length, 1);
      assert.equal(decodeFunctionData({ abi: answerAbi, data: w.sent[0].data }).args[1], INVALID);
    }));

  test('watcher: an older row inside the first look back is refreshed by the scan from final blocks, with no read of its own',
    withWorld({}, async (w) => {
      const { questionId, realId } = separated(w, YES);
      // The previous release split at the first separator and kept the honest proposal's id.
      w.db.insertWatched({ chainId: CHAIN, questionId, module: MODULE, safe: SAFE, proposalId: realId, questionHash: '', createdBlock: 900n, createdTs: END + 100n });
      await w.watcher.tick();
      const row = w.db.getWatched(CHAIN, questionId);
      assert.equal(row.proposalId, '');
      assert.equal(row.createdFinal, true);
      assert.equal(w.chain.state.ranges.filter(([a, b]) => a === 900n && b === 900n).length, 0);
      assert.equal(decodeFunctionData({ abi: answerAbi, data: w.sent[0].data }).args[1], INVALID);
    }));

  test('watcher: a finalized block that cannot be read stops the scan: no log is read and the cursor does not move',
    withWorld({}, async (w) => {
      w.chain.state.finalized = new Error('no finalized tag');
      const { questionId } = w.ask({ txs: [TX_A], best: NO, blockNumber: 900n });
      await w.watcher.tick();
      await w.watcher.tick();
      assert.deepEqual(w.chain.state.ranges, []);
      assert.equal(w.db.getWatched(CHAIN, questionId), null);
      assert.equal(w.db.getCursor(`questions-final:${CHAIN}:${MODULE.toLowerCase()}`), null);
      w.chain.state.finalized = 950n;
      await w.watcher.tick();
      await w.watcher.tick();
      assert.equal(w.db.getWatched(CHAIN, questionId).createdFinal, true);
      assert.equal(w.db.getCursor(`questions-final:${CHAIN}:${MODULE.toLowerCase()}`), '950');
    }));

  test('watcher: the cursor of an older relayer, which read up to the head, does not stop the first scan from final blocks',
    withWorld({}, async (w) => {
      w.db.setCursor(`questions:${CHAIN}:${MODULE.toLowerCase()}`, '1000');
      const { questionId } = w.ask({ txs: [TX_A], best: YES, blockNumber: 990n });
      await w.watcher.tick();
      assert.ok(w.db.getWatched(CHAIN, questionId));
    }));

  test('watcher: on a move from an older relayer, the first scan starts at the older cursor minus the look-back, so no question asked since is skipped, and a wrong yes on it is challenged',
    withWorld({ latest: 5000n }, async (w) => {
      w.db.setCursor(`questions:${CHAIN}:${MODULE.toLowerCase()}`, '3000');
      const skipped = w.ask({ txs: [TX_B], best: YES, blockNumber: 3500n });
      const nearOld = w.ask({ txs: [TX_B], best: YES, blockNumber: 2100n });
      await w.watcher.tick();
      const scans = w.chain.state.ranges.filter(([from]) => typeof from === 'bigint');
      assert.equal(scans[0][0], 2000n, 'the first scan starts at the older cursor minus the look-back');
      for (const q of [skipped, nearOld]) {
        assert.ok(w.db.getWatched(CHAIN, q.questionId), 'stored');
        assert.ok(w.sent.some((t) => decodeFunctionData({ abi: answerAbi, data: t.data }).args[0] === q.questionId), 'its wrong yes is challenged');
      }
      assert.equal(w.db.getCursor(`questions-final:${CHAIN}:${MODULE.toLowerCase()}`), '5000');
    }));

  test('watcher: a first scan with no cursor at all says in one log line how far back it looked, and that older questions are not read',
    async () => {
      const lines = [];
      const logger = { ...quiet, warn: (m) => lines.push(m), info: (m) => lines.push(m), log: (m) => lines.push(m) };
      const w = await world({ latest: 5000n, logger });
      try {
        await w.watcher.tick();
        await w.watcher.tick();
        const said = lines.filter((m) => m.includes('first scan'));
        assert.equal(said.length, 1, 'one line, on the first scan only');
        assert.match(said[0], /blocks 4000 to 5000/);
        assert.match(said[0], /questions asked before block 4000 are not read/);
        assert.doesNotMatch(said[0], /0x[0-9a-fA-F]{40}/, 'names no address');
      } finally {
        await w.close();
      }
    });

  // A question whose id holds the separator: the module executes the hash after the last one.
  const separated = (w, best, extraId = '') => {
    const realId = newId();
    w.vote(realId, { txs: [TX_A] });
    const packed = packedTxHashes([moduleTransactionHash(CHAIN, MODULE, TX_A, 0)]).slice(2);
    const asked = w.ask({ proposalId: `${realId}${QUESTION_SEPARATOR}${packed}${extraId}`, txs: [TX_B], hub: null, best });
    return { ...asked, realId };
  };

  test('watcher: a yes on a question whose id holds the separator and the proposal\'s own hash is challenged with invalid, and its events name no proposal',
    withWorld({}, async (w) => {
      const { questionId, realId } = separated(w, YES);
      await w.watcher.tick();
      assert.equal(w.sent.length, 1);
      assert.equal(decodeFunctionData({ abi: answerAbi, data: w.sent[0].data }).args[1], INVALID);
      const row = w.db.getWatched(CHAIN, questionId);
      assert.equal(row.proposalId, '', 'the question commits to no hub proposal');
      assert.equal(row.questionHash, packedTxHashes([moduleTransactionHash(CHAIN, MODULE, TX_B, 0)]).slice(2), 'the hash the module would execute');
      const [e] = w.events.list(0).events;
      assert.equal(e.type, 'answer_challenged');
      assert.equal(e.proposalId, '');
      assert.notEqual(e.proposalId, realId);
      assert.equal(e.detail.answer, 'invalid');
      assert.equal(e.detail.reason, 'question_mismatch');
      assert.equal(e.detail.questionHash, row.questionKey, 'the module\'s key of the whole question');
      assert.equal(w.hubStub.callsOf('graphql', realId).length, 0, 'the honest proposal is not read for it');
    }));

  test('watcher: a standing no or invalid on a question whose id holds the separator is left alone, and so is one with a separator at the end',
    withWorld({}, async (w) => {
      separated(w, NO);
      separated(w, INVALID);
      separated(w, INVALID, QUESTION_SEPARATOR);
      await w.watcher.tick();
      await w.watcher.tick();
      assert.equal(w.sent.length, 0, 'no bond spent on an answer that already stops the payment');
      assert.equal(w.events.list(0).events.length, 0);
    }));

  test('watcher: a final yes on a question whose id holds the separator is one wrong_final; a final no or invalid on it is closed quietly',
    withWorld({}, async (w) => {
      const yes = separated(w, YES);
      const no = separated(w, NO);
      const inv = separated(w, INVALID);
      Object.assign(w.q(yes.questionId), { finalized: true, result: YES });
      Object.assign(w.q(no.questionId), { finalized: true, result: NO });
      Object.assign(w.q(inv.questionId), { finalized: true, result: INVALID });
      await w.watcher.tick();
      assert.equal(w.count('wrong_final', yes.questionId), 1);
      assert.equal(w.events.list(0).events.length, 1);
      const [e] = w.events.list(0).events;
      assert.equal(e.detail.expectedAnswer, 'invalid');
      assert.equal(e.detail.questionHash, questionHashOf(buildQuestion(`${yes.realId}${QUESTION_SEPARATOR}${packedTxHashes([moduleTransactionHash(CHAIN, MODULE, TX_A, 0)]).slice(2)}`, [moduleTransactionHash(CHAIN, MODULE, TX_B, 0)])));
      for (const q of [yes, no, inv]) assert.equal(w.db.getWatched(CHAIN, q.questionId).status, 'closed');
    }));

  test('watcher: a standing no or invalid on a question that is not the proposal\'s is left alone; a yes on it is challenged with invalid',
    withWorld({}, async (w) => {
      w.ask({ txs: [TX_B], best: NO });
      w.ask({ txs: [TX_B], best: INVALID });
      w.ask({ hub: null, best: NO });
      w.ask({ hub: null, best: INVALID });
      const { questionId } = w.ask({ txs: [TX_B], best: YES });
      await w.watcher.tick();
      assert.equal(w.sent.length, 1);
      const { args } = decodeFunctionData({ abi: answerAbi, data: w.sent[0].data });
      assert.deepEqual(args, [questionId, INVALID, BOND]);
    }));

  test('watcher: a standing invalid on a proposal that did not pass is left alone; a yes on it is challenged with no',
    withWorld({}, async (w) => {
      const lost = (best) => {
        const proposalId = newId();
        w.hubStub.set(hubProposal({ id: proposalId, space: SPACE, module: MODULE, chainId: CHAIN, txs: [TX_A], scores: [0, 2, 0], quorum: 1, end: Number(END) }));
        return w.ask({ proposalId, txs: [TX_A], hub: null, best });
      };
      lost(INVALID);
      const { questionId } = lost(YES);
      await w.watcher.tick();
      assert.equal(w.sent.length, 1);
      assert.deepEqual(decodeFunctionData({ abi: answerAbi, data: w.sent[0].data }).args, [questionId, NO, BOND]);
    }));

  test('watcher: the passed proposal\'s question asked before the vote ended: a standing no is challenged with invalid, so the proposal can be asked again',
    withWorld({}, async (w) => {
      const { proposalId, questionId } = w.ask({ txs: [TX_A], hub: { txs: [TX_A], state: 'active' }, best: NO });
      w.vote(proposalId, { txs: [TX_A] });
      await w.watcher.tick();
      assert.equal(w.sent.length, 1);
      assert.deepEqual(decodeFunctionData({ abi: answerAbi, data: w.sent[0].data }).args, [questionId, INVALID, BOND]);
    }));

  test('watcher: a question asked before the vote ended whose proposal did not pass: a standing no is left alone',
    withWorld({}, async (w) => {
      const proposalId = newId();
      w.hubStub.set(hubProposal({ id: proposalId, space: SPACE, module: MODULE, chainId: CHAIN, txs: [TX_A], scores: [0, 2, 0], quorum: 1, end: Number(END) }));
      w.ask({ proposalId, txs: [TX_A], hub: null, best: NO, created: END - 100n });
      await w.watcher.tick();
      assert.equal(w.sent.length, 0);
    }));

  test('watcher: a rightful yes is put on a passed proposal\'s question whose standing answer is no or invalid',
    withWorld({}, async (w) => {
      w.ask({ txs: [TX_A], best: NO });
      w.ask({ txs: [TX_A], best: INVALID });
      await w.watcher.tick();
      assert.equal(w.sent.length, 2);
      for (const tx of w.sent) assert.equal(decodeFunctionData({ abi: answerAbi, data: tx.data }).args[1], YES);
    }));

  test('watcher: a question that is not, byte for byte, the module\'s question for a passed proposal is invalid: a standing yes is challenged with invalid, and its events name no proposal',
    withWorld({}, async (w) => {
      const { proposalId, questionId } = w.ask({ txs: [TX_A], best: YES, asked: (q) => `﻿${q}` });
      w.vote(proposalId, { txs: [TX_A] });
      await w.watcher.tick();
      assert.equal(w.sent.length, 1, 'the yes is challenged');
      assert.equal(decodeFunctionData({ abi: answerAbi, data: w.sent[0].data }).args[1], INVALID);
      const e = w.events.list(0).events.find((x) => x.type === 'answer_challenged');
      assert.equal(e.proposalId, '');
      assert.notEqual(e.detail.questionHash, questionHashOf(buildQuestion(proposalId, [moduleTransactionHash(CHAIN, MODULE, TX_A, 0)])));
      assert.equal(w.db.getWatched(CHAIN, questionId).proposalId, '');
    }));

  test('watcher: a standing no on a question that is not, byte for byte, the module\'s question for a passed proposal is left alone',
    withWorld({}, async (w) => {
      const { proposalId } = w.ask({ txs: [TX_A], best: NO, asked: (q) => `﻿${q}` });
      w.vote(proposalId, { txs: [TX_A] });
      await w.watcher.tick();
      await w.watcher.tick();
      assert.equal(w.sent.length, 0, 'no bond is spent to put yes on it');
    }));

  test('watcher: only the bytes the module builds from a passed proposal\'s exact id and hashes are its question; any other bytes, each standing at yes, are challenged with invalid',
    withWorld({}, async (w) => {
      const hashAt = (q) => q.length - 64;
      const variants = {
        'a leading invisible mark': (q) => `﻿${q}`,
        'an invisible mark inside': (q) => `${q.slice(0, 2)}​${q.slice(2)}`,
        'a look-alike letter': (q) => `0х${q.slice(2)}`,
        'changed case in the id': (q) => `0x${q.slice(2, 66).toUpperCase()}${q.slice(66)}`,
        'changed case in the hash': (q) => `${q.slice(0, hashAt(q))}${q.slice(hashAt(q)).toUpperCase()}`,
        'a leading space': (q) => ` ${q}`,
        'a space before the separator': (q) => `${q.slice(0, 66)} ${q.slice(66)}`,
        'a trailing space': (q) => `${q} `,
        'a different normal form': (q) => `０${q.slice(1)}`,
      };
      const asked = Object.entries(variants).map(([name, change]) => {
        const { proposalId, questionId } = w.ask({ txs: [TX_A], best: YES, asked: change });
        w.vote(proposalId, { txs: [TX_A] });
        return { name, questionId };
      });
      await w.watcher.tick();
      const challenged = new Map(w.sent.map((tx) => decodeFunctionData({ abi: answerAbi, data: tx.data }).args).map(([id, answer]) => [id, answer]));
      for (const { name, questionId } of asked) {
        assert.equal(challenged.get(questionId), INVALID, `${name}: challenged with invalid`);
        const events = w.events.list(0).events.filter((e) => e.questionId === questionId);
        assert.equal(events.length > 0 && events.every((e) => e.proposalId === ''), true, `${name}: its events name no proposal`);
      }
    }));

  test('watcher: the module\'s own question and a byte-different copy of it, both standing at yes on a passed proposal: exactly one is let through',
    withWorld({}, async (w) => {
      const proposalId = newId();
      const own = w.ask({ proposalId, txs: [TX_A], best: YES });
      const copy = w.ask({ proposalId, txs: [TX_A], best: YES, asked: (q) => `﻿${q}` });
      w.vote(proposalId, { txs: [TX_A] });
      await w.watcher.tick();
      const challenged = w.sent.map((tx) => decodeFunctionData({ abi: answerAbi, data: tx.data }).args);
      assert.deepEqual(challenged, [[copy.questionId, INVALID, challenged[0]?.[2]]], 'only the copy is challenged, with invalid');
      assert.notEqual(w.db.getWatched(CHAIN, own.questionId).questionKey, w.db.getWatched(CHAIN, copy.questionId).questionKey);
    }));

  test('watcher: escalation_needed carries the question\'s key, and an event names the proposal only for its own question',
    withWorld({ caps: { dayWei: 2n * BOND - 1n, monthWei: 10n ** 19n } }, async (w) => {
      const own = w.ask({ txs: [TX_A], hub: { txs: [TX_A], state: 'active' }, best: YES });
      w.vote(own.proposalId, { txs: [TX_A] });
      await w.watcher.tick();
      const [e] = w.events.list(0).events;
      assert.equal(e.type, 'escalation_needed');
      assert.equal(e.proposalId, own.proposalId, 'the proposal\'s own question, asked too early');
      assert.equal(e.detail.questionHash, w.db.getWatched(CHAIN, own.questionId).questionKey);
      assert.match(e.detail.questionHash, /^0x[0-9a-f]{64}$/);
    }));

  test('watcher: a final no on a proposal\'s own question asked before its vote ended stays watched; once the vote passes it is one wrong_final, once it fails it is closed quietly',
    withWorld({}, async (w) => {
      const passes = w.ask({ txs: [TX_A], hub: { txs: [TX_A], state: 'active' }, best: NO });
      const fails = w.ask({ txs: [TX_A], hub: { txs: [TX_A], state: 'active' }, best: NO });
      for (const q of [passes, fails]) Object.assign(w.q(q.questionId), { finalized: true, result: NO });
      await w.watcher.tick();
      await w.watcher.tick();
      assert.equal(w.events.list(0).events.length, 0, 'nothing told while the vote is open');
      for (const q of [passes, fails]) assert.equal(w.db.getWatched(CHAIN, q.questionId).status, 'open', 'still watched');
      w.vote(passes.proposalId, { txs: [TX_A] });
      w.hubStub.set(hubProposal({ id: fails.proposalId, space: SPACE, module: MODULE, chainId: CHAIN, txs: [TX_A], scores: [0, 2, 0], quorum: 1, end: Number(END) }));
      await w.watcher.tick();
      assert.equal(w.count('wrong_final', passes.questionId), 1);
      assert.equal(w.count('wrong_final', fails.questionId), 0);
      const e = w.events.list(0).events.find((x) => x.type === 'wrong_final');
      assert.equal(e.proposalId, passes.proposalId);
      assert.equal(e.detail.questionHash, w.db.getWatched(CHAIN, passes.questionId).questionKey);
      for (const q of [passes, fails]) assert.equal(w.db.getWatched(CHAIN, q.questionId).status, 'closed');
      assert.equal(w.sent.length, 0, 'no bond spent on any of it');
    }));

  test('watcher: another question under a proposal\'s id, asked before its vote ended, with a standing no is left alone after the proposal passes',
    withWorld({}, async (w) => {
      const { proposalId } = w.ask({ txs: [TX_B], hub: { txs: [TX_A], state: 'active' }, best: NO });
      w.vote(proposalId, { txs: [TX_A] });
      await w.watcher.tick();
      assert.equal(w.sent.length, 0);
    }));

  test('watcher: a challenge on an older row moved to an earlier block stores the new block for reclaim',
    withWorld({ lookback: 50n }, async (w) => {
      const { proposalId, questionId } = w.ask({ txs: [TX_A], hub: { txs: [TX_A], state: 'active' }, best: YES, blockNumber: 899n });
      w.vote(proposalId, { txs: [TX_A] });
      // Stored by the previous release at block 900, near the head, before the chain moved it to 899.
      const questionHash = packedTxHashes([moduleTransactionHash(CHAIN, MODULE, TX_A, 0)]).slice(2);
      w.db.insertWatched({ chainId: CHAIN, questionId, module: MODULE, safe: SAFE, proposalId, questionHash, createdBlock: 900n, createdTs: END - 100n });
      await w.watcher.tick();
      assert.equal(w.sent.length, 1);
      assert.equal(w.db.getWatched(CHAIN, questionId).createdBlock, 899n);
      assert.equal(w.db.getQuestion(CHAIN, questionId).fromBlock, 899n, 'reclaim starts where the question really is');
    }));

  test('watcher: a log the node returns from below the blocks asked for is not stored',
    withWorld({ latest: 1000n, lookback: 50n }, async (w) => {
      w.chain.state.ignoreRange = true;
      const { questionId } = w.ask({ txs: [TX_A], best: YES, blockNumber: 900n });
      await w.watcher.tick();
      assert.equal(w.db.getWatched(CHAIN, questionId), null, 'block 900 is below the scan from 950');
    }));

  test('watcher: a hub that cannot be read causes no challenge, and the next tick that can read it does',
    withWorld({}, async (w) => {
      w.ask({ txs: [TX_B] });
      w.hubStub.forceStatus('/graphql', [500]);
      await w.watcher.tick();
      assert.equal(w.sent.length, 0, 'an unreadable hub is not an answer');
      assert.equal(w.events.list(0).events.length, 0);
      await w.watcher.tick();
      assert.equal(w.sent.length, 1);
    }));

  test('watcher: a question that finalized wrong is one wrong_final event with the end of the cooldown',
    withWorld({}, async (w) => {
      const { questionId } = w.ask({ txs: [TX_B] });
      Object.assign(w.q(questionId), { finalized: true, result: YES });
      for (let i = 0; i < 3; i += 1) await w.watcher.tick();
      assert.equal(w.sent.length, 0, 'a final answer cannot be challenged');
      assert.equal(w.count('wrong_final', questionId), 1);
      const [e] = w.events.list(0).events;
      assert.equal(e.detail.finalAnswer, 'yes');
      assert.equal(e.detail.expectedAnswer, 'invalid');
      assert.equal(e.detail.executableAfter, new Date((Number(FINALIZE_TS) + 300) * 1000).toISOString());
    }));

  test('watcher: a question the watcher flagged that finalized right is one resolved event, and a right one it never flagged is silent',
    withWorld({}, async (w) => {
      const wrong = w.ask({ txs: [TX_B] });
      const right = w.ask({ txs: [TX_A], best: YES });
      await w.watcher.tick(); // challenges the wrong one
      assert.equal(w.count('answer_challenged', wrong.questionId), 1);
      Object.assign(w.q(wrong.questionId), { finalized: true, result: NO });
      Object.assign(w.q(right.questionId), { finalized: true, result: YES });
      await w.watcher.tick();
      await w.watcher.tick();
      assert.equal(w.count('resolved', wrong.questionId), 1);
      assert.equal(w.count('resolved', right.questionId), 0);
      assert.equal(w.count('wrong_final'), 0);
      const resolved = w.events.list(0).events.find((e) => e.type === 'resolved');
      assert.equal(resolved.detail.questionHash, w.db.getWatched(CHAIN, wrong.questionId).questionKey);
      assert.match(resolved.detail.questionHash, /^0x[0-9a-f]{64}$/);
    }));

  test('watcher: a challenge that is still waiting for its receipt is not repeated; one that mined without taking the answer is retried, three times at most',
    withWorld({}, async (w) => {
      const { questionId } = w.ask({ txs: [TX_B] });
      const settleLast = () => {
        const row = w.db.listPending().at(-1);
        w.db.updatePending(row.id, { ...row, status: 'mined' });
      };
      await w.watcher.tick();
      await w.watcher.tick();
      assert.equal(w.sent.length, 1, 'still pending: not sent twice');
      for (let n = 2; n <= MAX_CHALLENGE_ATTEMPTS; n += 1) {
        settleLast(); // mined, yet the best answer is still wrong: it reverted
        await w.watcher.tick();
        assert.equal(w.sent.length, n, `attempt ${n}`);
      }
      settleLast();
      await w.watcher.tick();
      await w.watcher.tick();
      assert.equal(w.sent.length, MAX_CHALLENGE_ATTEMPTS, 'no fourth attempt');
      assert.equal(w.count('escalation_needed', questionId), 1);
      assert.equal(w.events.list(0).events.find((e) => e.type === 'escalation_needed').detail.reason, 'challenge_failed');
    }));

  test('watcher: the interval is 60 s by default and SPONSOR_RELAYER_WATCH_INTERVAL_S overrides it; bad values refuse to start', () => {
    assert.equal(DEFAULT_WATCH_INTERVAL_S, 60);
    assert.equal(watchSettingsFromEnv({}).intervalMs, 60_000);
    assert.equal(watchSettingsFromEnv({ SPONSOR_RELAYER_WATCH_INTERVAL_S: '' }).intervalMs, 60_000);
    assert.equal(watchSettingsFromEnv({ SPONSOR_RELAYER_WATCH_INTERVAL_S: '5' }).intervalMs, 5_000);
    assert.equal(watchSettingsFromEnv({ SPONSOR_RELAYER_WATCH_INTERVAL_S: '3600' }).intervalMs, 3_600_000);
    for (const bad of ['0', '-1', '1.5', 'abc', '3601', '1e2', ' 5', '05']) {
      assert.throws(() => watchSettingsFromEnv({ SPONSOR_RELAYER_WATCH_INTERVAL_S: bad }), /SPONSOR_RELAYER_WATCH_INTERVAL_S/, bad);
    }
    assert.equal(watchSettingsFromEnv({}).lowBalanceWei, 20_000_000_000_000_000n);
    assert.equal(watchSettingsFromEnv({ SPONSOR_RELAYER_LOW_BALANCE_WEI: '123' }).lowBalanceWei, 123n);
    assert.throws(() => watchSettingsFromEnv({ SPONSOR_RELAYER_LOW_BALANCE_WEI: '1.5' }), /SPONSOR_RELAYER_LOW_BALANCE_WEI/);
  });

  test('watcher: question logs are read in ranges of at most 2,000 blocks, and a second tick reads only the new blocks',
    withWorld({ latest: 5000n, lookback: 4499n }, async (w) => {
      // Unanswered, so it is found but not judged: only the scan reads logs.
      const { questionId } = w.ask({ txs: [TX_A], blockNumber: 4600n, bond: 0n });
      await w.watcher.tick();
      assert.deepEqual(w.chain.state.ranges, [[501n, 2500n], [2501n, 4500n], [4501n, 5000n]]);
      for (const [from, to] of w.chain.state.ranges) assert.ok(to - from + 1n <= LOG_RANGE_BLOCKS);
      assert.ok(w.db.getWatched(CHAIN, questionId), 'the question in the last range was found');
      w.chain.state.latest = 5100n;
      await w.watcher.tick();
      assert.deepEqual(w.chain.state.ranges.slice(3), [[5001n, 5100n]]);
    }));

  test('watcher: low_balance is stored once when the balance falls under the line, and again only after it recovered',
    withWorld({ balance: 10n, lowBalanceWei: 100n }, async (w) => {
      await w.watcher.tick();
      await w.watcher.tick();
      assert.equal(w.count('low_balance'), 1);
      assert.equal(w.events.list(0).events[0].detail.balanceWei, '10');
      w.chain.state.balance = 1000n;
      await w.watcher.tick();
      w.chain.state.balance = 10n;
      await w.watcher.tick();
      assert.equal(w.count('low_balance'), 2);
    }));
});
