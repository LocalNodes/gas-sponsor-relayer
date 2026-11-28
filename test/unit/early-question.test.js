// A question asked before the vote ended is answered invalid, and stays so after the vote closes: the answer endpoint
// answers invalid, the execute endpoint sends nothing for it. Times come from Reality's LogNewQuestion (`created`)
// and the hub's `end`; when either cannot be read nothing is answered or sent. The watcher's side is in watcher.test.js.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, getAddress, parseAbi } from 'viem';
import { loadNetworks } from '../../src/config.js';
import { ANSWER_BYTES, createAnswerer } from '../../src/answer.js';
import { normalizeProposal } from '../../src/hub.js';
import { createReality } from '../../src/sends/reality.js';
import { buildQuestion, moduleTransactionHash } from '../../src/realityHash.js';
import { hubProposal } from '../stub/hub-stub.js';
import { CHAIN, ME, quiet, setup } from '../helpers/node.js';
import { questionLog } from '../helpers/questionLog.js';

const networks = loadNetworks();
const REALITY = networks[String(CHAIN)].reality;
const SAFE = getAddress(`0x${'5a'.repeat(20)}`);
const MODULE = getAddress(`0x${'4d'.repeat(20)}`);
const PAYEE = getAddress(`0x${'33'.repeat(20)}`);
const QID = `0x${'7a'.repeat(32)}`;
const PROPOSAL = `0x${'5c'.repeat(32)}`;
const SPACE = 'a.eth';
const END = 1_700_000_000;
const answerAbi = parseAbi(['function submitAnswer(bytes32 question_id, bytes32 answer, uint256 max_previous)']);
const v = { chainId: CHAIN, safe: SAFE, proposalId: PROPOSAL };
const TX = { to: PAYEE, value: '1000', data: '0x', operation: 0 };
/** The module's question for the hub's proposal, as Reality's log carries it. */
const QUESTION = buildQuestion(PROPOSAL, [moduleTransactionHash(CHAIN, MODULE, { ...TX, value: 1000n }, 0)]);

/**
 * The Reality service with the real answerer over a fake hub, on a node that answers every read. `created` is the
 * time in the question's LogNewQuestion at block `askedBlock` (undefined: no such log), `vote` patches the hub's
 * proposal (closed, final and passed by default), `question` is Reality's state of the question.
 */
function world({ created, askedBlock = 95n, vote = {}, question = {}, latest = 100n, logsError = null, finalized } = {}) {
  const q = { finalized: false, bond: 0n, result: ANSWER_BYTES.yes, finalizeTs: 0, ...question };
  const ctx = setup({
    node: {
      block: latest,
      read: ({ functionName }) => ({
        questionIds: QID, getQuestionId: QID, isFinalized: q.finalized, getBond: q.bond, minimumBond: 10n,
        executedProposalTransactions: false, resultFor: q.result, getFinalizeTS: q.finalizeTs, questionCooldown: 0,
      })[functionName],
    },
  });
  const ranges = [];
  const chain = { logsError, askedBlock, created, finalized };
  ctx.node.publicClient.getLogs = async ({ address, args, fromBlock, toBlock }) => {
    ranges.push([fromBlock, toBlock]);
    if (chain.logsError) throw chain.logsError;
    ({ askedBlock, created } = chain);
    if (created === undefined || address.toLowerCase() !== REALITY.toLowerCase() || args.question_id !== QID) return [];
    if (askedBlock < fromBlock || askedBlock > toBlock) return [];
    return [questionLog({ blockNumber: askedBlock, questionId: QID, user: MODULE, question: QUESTION, created: created })];
  };
  // The finalized block is the one before the head unless the test names it; the latest block is far in the future.
  ctx.node.publicClient.getBlock = async ({ blockTag } = {}) => (blockTag === 'finalized' ? { number: chain.finalized ?? ctx.node.state.block - 1n } : { timestamp: 10n ** 10n });
  ctx.db.addGroup({ chainId: CHAIN, safe: SAFE, space: SPACE, community: 'c' });
  const proposal = { ...hubProposal({ id: PROPOSAL, space: SPACE, module: MODULE, chainId: CHAIN, txs: [TX], end: END }), ...vote };
  const hub = { async getProposal() { return normalizeProposal(proposal); }, async finalizeScores() {} };
  const sends = [];
  const pipeline = { async send(a) { sends.push(a); return { ok: true, hash: `0x${'ab'.repeat(32)}`, nonce: 1 }; } };
  const reality = createReality({
    db: ctx.db, config: { configured: true, address: ME }, networks, chains: ctx.node.chains, cap: ctx.cap, queue: ctx.queue,
    groupModules: { async modulesFor() { return [MODULE]; } }, hub, answerer: createAnswerer({ hub, db: ctx.db, logger: quiet }), pipeline, logger: quiet,
  });
  const answered = () => decodeFunctionData({ abi: answerAbi, data: sends[0].data }).args[1];
  const setQuestion = (patch) => Object.assign(q, patch);
  const store = (patch = {}) => ctx.db.insertWatched({ chainId: CHAIN, questionId: QID, module: MODULE, safe: SAFE, proposalId: PROPOSAL, questionHash: 'ab'.repeat(32), createdBlock: chain.askedBlock, createdTs: chain.created, ...patch });
  return { ...ctx, chain, reality, sends, ranges, answered, setQuestion, store, close: () => { ctx.queue.stop(); ctx.db.close(); } };
}

const run = async (opts, fn) => {
  const w = world(opts);
  try {
    await fn(w);
  } finally {
    w.close();
  }
};

const refused = (w, res, status, reason) => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body.reason ?? res.body.error, reason);
  assert.equal(w.sends.length, 0, 'nothing sent');
};

describe('early question: the answer endpoint', () => {
  test('early question: a question asked while the vote was open is answered invalid after the vote closed and passed', () =>
    run({ created: BigInt(END - 60) }, async (w) => {
      const res = await w.reality.answer(v);
      assert.equal(res.status, 202, JSON.stringify(res.body));
      assert.equal(res.body.answer, 'invalid');
      assert.equal(res.body.reason, 'asked_before_resolution');
      assert.equal(w.answered(), ANSWER_BYTES.invalid);
    }));

  test('early question: a question asked after the vote ended is answered by the vote, also at the second it ended', async () => {
    for (const created of [BigInt(END), BigInt(END + 60)]) {
      await run({ created }, async (w) => {
        const res = await w.reality.answer(v);
        assert.equal(res.status, 202, JSON.stringify(res.body));
        assert.equal(w.answered(), ANSWER_BYTES.yes, String(created));
      });
    }
  });

  test('early question: a question asked after the vote ended whose count is not final is not answered', () =>
    run({ created: BigInt(END + 60), vote: { state: 'closed', scores_state: 'pending', scores: [] } }, async (w) => {
      refused(w, await w.reality.answer(v), 409, 'proposal_not_final');
    }));

  test('early question: no asking time on the chain, or no end time on the hub, answers nothing', async () => {
    await run({ created: undefined }, async (w) => refused(w, await w.reality.answer(v), 409, 'question_time_unknown'));
    await run({ created: 'x' }, async (w) => refused(w, await w.reality.answer(v), 409, 'question_time_unknown'));
    await run({ created: BigInt(END + 60), vote: { end: null } }, async (w) => refused(w, await w.reality.answer(v), 409, 'resolution_time_unknown'));
  });

  test('early question: a log for another question, given by the node, is not taken for this one', () =>
    run({ created: undefined }, async (w) => {
      w.node.publicClient.getLogs = async () => [questionLog({ blockNumber: 95n, questionId: `0x${'7b'.repeat(32)}`, user: MODULE, question: QUESTION, created: BigInt(END + 60) })];
      refused(w, await w.reality.answer(v), 409, 'question_time_unknown');
    }));

  test('early question: a log read that fails answers nothing and says nothing was broadcast', () =>
    run({ created: BigInt(END + 60), logsError: new Error('rpc down') }, async (w) => {
      const res = await w.reality.answer(v);
      refused(w, res, 502, 'read_failed');
      assert.equal(res.body.broadcast, false);
    }));

  test('early question: the asking time is searched for only in the final blocks just before the finalized block', () =>
    run({ created: BigInt(END + 60), askedBlock: 10n, latest: 10_000n, finalized: 9_000n }, async (w) => {
      refused(w, await w.reality.answer(v), 409, 'question_time_unknown');
      assert.equal(w.ranges.every(([from, to]) => from >= 9_000n - 2400n && to <= 9_000n && to - from < 2000n), true, JSON.stringify(w.ranges.map(String)));
    }));

  test('early question: a question in a block that is not final yet is not answered or stored; once its block is final it is, and its row is final', () =>
    run({ created: BigInt(END + 60), askedBlock: 95n, latest: 100n, finalized: 90n }, async (w) => {
      refused(w, await w.reality.answer(v), 409, 'question_time_unknown');
      assert.equal(w.ranges.every(([, to]) => to <= 90n), true, JSON.stringify(w.ranges.map(String)));
      assert.equal(w.db.getWatched(CHAIN, QID), null, 'nothing stored');
      w.chain.finalized = 95n;
      const res = await w.reality.answer(v);
      assert.equal(res.status, 202, JSON.stringify(res.body));
      assert.equal(w.answered(), ANSWER_BYTES.yes);
      const row = w.db.getWatched(CHAIN, QID);
      assert.equal(row.createdFinal, true);
      assert.equal(row.createdBlock, 95n);
      assert.equal(typeof row.questionKey, 'string');
    }));

  test('early question: a log the node returns from below the blocks asked for is not taken', () =>
    run({ created: undefined, latest: 10_000n, finalized: 9_000n }, async (w) => {
      w.node.publicClient.getLogs = async ({ fromBlock, toBlock }) => {
        w.ranges.push([fromBlock, toBlock]);
        return [questionLog({ blockNumber: 10n, questionId: QID, user: MODULE, question: QUESTION, created: BigInt(END + 60) })];
      };
      refused(w, await w.reality.answer(v), 409, 'question_time_unknown');
      assert.equal(w.db.getWatched(CHAIN, QID), null);
    }));

  test('early question: a finalized block that cannot be read answers nothing and reads no log', () =>
    run({ created: BigInt(END + 60) }, async (w) => {
      w.node.publicClient.getBlock = async ({ blockTag } = {}) => { if (blockTag === 'finalized') throw new Error('no finalized tag'); return { timestamp: 10n ** 10n }; };
      refused(w, await w.reality.answer(v), 409, 'question_time_unknown');
      assert.deepEqual(w.ranges, []);
    }));

  test('early question: a log the node returns from outside the blocks asked for is not taken', () =>
    run({ created: undefined, latest: 100n, finalized: 90n }, async (w) => {
      // A node that ignores the range: it answers with a question in block 95, above the finalized block.
      w.node.publicClient.getLogs = async ({ fromBlock, toBlock }) => {
        w.ranges.push([fromBlock, toBlock]);
        return [questionLog({ blockNumber: 95n, questionId: QID, user: MODULE, question: QUESTION, created: BigInt(END + 60) })];
      };
      refused(w, await w.reality.answer(v), 409, 'question_time_unknown');
      assert.equal(w.db.getWatched(CHAIN, QID), null);
    }));
});

describe('early question: the execute endpoint', () => {
  const finalYes = { finalized: true, bond: 10n, result: ANSWER_BYTES.yes };

  test('early question: a yes that finalized on a question asked while the vote was open is not executed', () =>
    run({ created: BigInt(END - 60), question: finalYes }, async (w) => {
      refused(w, await w.reality.execute(v), 409, 'asked_before_resolution');
    }));

  test('early question: a yes on a question asked after the vote ended is executed', () =>
    run({ created: BigInt(END + 60), question: finalYes }, async (w) => {
      const res = await w.reality.execute(v);
      assert.equal(res.status, 202, JSON.stringify(res.body));
      assert.equal(w.sends.length, 1);
    }));

  test('early question: hours after the ask, the time the watcher stored is read once at its final block; with none stored and no log near the head, nothing is sent', async () => {
    await run({ created: BigInt(END + 60), askedBlock: 10n, latest: 10_000n, question: finalYes }, async (w) => {
      w.store();
      const res = await w.reality.execute(v);
      assert.equal(res.status, 202, JSON.stringify(res.body));
      assert.deepEqual(w.ranges, [[10n, 10n]], 'one read, at the block it was asked in');
      assert.equal(w.db.getWatched(CHAIN, QID).createdFinal, true);
      w.sends.length = 0;
      await w.reality.execute(v);
      assert.equal(w.ranges.length, 1, 'trusted from then on');
    });
    await run({ created: BigInt(END + 60), askedBlock: 10n, latest: 10_000n, question: finalYes }, async (w) => {
      refused(w, await w.reality.execute(v), 409, 'question_time_unknown');
    });
  });

  test('early question: a time the answer endpoint found is kept, so the execute hours later still has it', async () => {
    const w = world({ created: BigInt(END + 60), askedBlock: 95n, latest: 100n });
    try {
      const res = await w.reality.answer(v);
      assert.equal(res.status, 202, JSON.stringify(res.body));
      const row = w.db.getWatched(CHAIN, QID);
      assert.equal(row.createdTs, BigInt(END + 60));
      assert.equal(row.createdBlock, 95n);
      assert.equal(row.proposalId, PROPOSAL);
      // Hours later: the log is far from the head, and Reality says yes.
      w.node.state.block = 100_000n;
      w.setQuestion({ finalized: true, bond: 10n, result: ANSWER_BYTES.yes });
      const ran = await w.reality.execute(v);
      assert.equal(ran.status, 202, JSON.stringify(ran.body));
    } finally {
      w.close();
    }
  });

  test('early question: a stored time whose block is not final and whose log cannot be read sends nothing, at the answer and the execute', async () => {
    for (const step of ['answer', 'execute']) {
      await run({ created: BigInt(END + 60), finalized: 50n, question: step === 'execute' ? finalYes : {} }, async (w) => {
        w.store();
        w.chain.logsError = new Error('rpc down');
        const res = await w.reality[step](v);
        refused(w, res, 502, 'read_failed');
        assert.equal(res.body.broadcast, false, step);
      });
    }
  });

  test('early question: an older row read near the head is read again, only in final blocks: moved by the chain to after the vote ended, the answer is yes once that block is final', () =>
    run({ created: BigInt(END - 60), askedBlock: 90n, finalized: 50n }, async (w) => {
      w.store();
      w.chain.askedBlock = 97n;
      w.chain.created = BigInt(END + 60);
      refused(w, await w.reality.answer(v), 409, 'question_time_unknown');
      assert.equal(w.ranges.every(([, to]) => to <= 50n), true, JSON.stringify(w.ranges.map(String)));
      assert.equal(w.db.getWatched(CHAIN, QID).createdFinal, false, 'the older row is not taken as final');
      w.chain.finalized = 99n;
      const res = await w.reality.answer(v);
      assert.equal(res.status, 202, JSON.stringify(res.body));
      assert.equal(w.answered(), ANSWER_BYTES.yes);
      const row = w.db.getWatched(CHAIN, QID);
      assert.equal(row.createdBlock, 97n);
      assert.equal(row.createdTs, BigInt(END + 60));
    }));

  test('early question: no end time on the hub sends nothing', () =>
    run({ created: BigInt(END + 60), vote: { end: null }, question: finalYes }, async (w) => {
      refused(w, await w.reality.execute(v), 409, 'resolution_time_unknown');
    }));
});
