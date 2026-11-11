// The wrong-answer watcher against a stubbed chain and a canned hub (25-08, D-16, TM-83, TM-84): what it challenges,
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
import { buildQuestion, moduleTransactionHash } from '../../src/realityHash.js';
import { createWatcher, DEFAULT_WATCH_INTERVAL_S, LOG_RANGE_BLOCKS, MAX_CHALLENGE_ATTEMPTS, watchSettingsFromEnv } from '../../src/watcher.js';
import { hubProposal, startHubStub } from '../stub/hub-stub.js';

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
    async getLogs({ fromBlock, toBlock, args }) {
      s.ranges.push([fromBlock, toBlock]);
      return s.logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock && l.args.user.toLowerCase() === args.user.toLowerCase());
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
async function world({ caps = { dayWei: 10n ** 18n, monthWei: 10n ** 19n }, latest = 1000n, lookback = 1000n, balance = 10n ** 18n, lowBalanceWei } = {}) {
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
    logger: quiet,
  });
  const w = { db, cap, chain, hubStub, events, watcher, sent };
  /**
   * A question asked to the module. `hub` is what the hub holds for the proposal (null: unknown to the hub; a
   * `state` makes it an open vote); `txs` are the transactions the question's hash covers.
   */
  w.ask = ({ proposalId = newId(), txs = [TX_A], hub = { txs: [TX_A] }, best = YES, bond = BOND, blockNumber = 900n } = {}) => {
    if (hub) {
      hubStub.set(hubProposal({ id: proposalId, space: SPACE, module: MODULE, chainId: CHAIN, txs: hub.txs, scores: hub.state ? [] : [2, 0, 1], quorum: 2, state: hub.state ?? 'closed', scoresState: hub.state ? 'pending' : 'final' }));
    }
    const question = buildQuestion(proposalId, txs.map((t, i) => moduleTransactionHash(CHAIN, MODULE, t, i)));
    const questionId = newId();
    chain.state.logs.push({ blockNumber, args: { question_id: questionId, user: MODULE, question } });
    chain.state.questions.set(questionId, { bond, best, finalized: false, finalizeTs: FINALIZE_TS });
    return { proposalId, questionId };
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
      assert.equal(e.proposalId, proposalId);
      assert.equal(e.detail.reason, 'cap_reached');
      assert.equal(e.detail.currentBondWei, BOND.toString());
      assert.equal(e.detail.neededBondWei, (2n * BOND).toString());
      assert.equal(e.detail.deadline, new Date(Number(FINALIZE_TS) * 1000).toISOString(), 'the deadline is the question finalize time');
      assert.equal(e.detail.currentAnswer, 'yes');
      assert.equal(e.detail.expectedAnswer, 'no');

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

  test('watcher: a question for a proposal the hub does not know is challenged with no, double the bond, max_previous = the current bond',
    withWorld({}, async (w) => {
      const { questionId } = w.ask({ hub: null });
      const actions = await w.watcher.tick();
      assert.equal(w.sent.length, 1);
      const tx = w.sent[0];
      assert.equal(tx.to, REALITY);
      assert.equal(tx.value, 2n * BOND);
      const { args } = decodeFunctionData({ abi: answerAbi, data: tx.data });
      assert.deepEqual(args, [questionId, NO, BOND]);
      assert.equal(actions[0].action, 'challenged');
      const row = w.db.getQuestion(CHAIN, questionId);
      assert.equal(row.bondWei, 2n * BOND, 'the bond is stored for the reclaim loop');
      assert.equal(row.fromBlock, 900n, 'the history starts at the block the question was asked in');
    }));

  test('watcher: the in-flight mark is written before the challenge\'s bond is stored (25-28 dedupe, round-2 Q6)',
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

  test('watcher: storing the challenge fails after its broadcast: the next tick does not challenge again (25-28 dedupe, round-2 Q6)',
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
      assert.equal(e.detail.expectedAnswer, 'no');
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
      const { questionId } = w.ask({ txs: [TX_A], blockNumber: 4600n });
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
