// 25-28 fix round 2, MEDIUM 5 (Codex round 2): once a send is broadcast, the caller always gets 202 with its hash.
// A failure in the bookkeeping after the broadcast (recording the send, storing the Reality question) is logged and
// never turned into a 500 or a 502 without the hash, which would invite a retry and a second sponsored transaction.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress, zeroHash } from 'viem';
import { loadNetworks } from '../../src/config.js';
import { createPipeline } from '../../src/sends/pipeline.js';
import { createReality } from '../../src/sends/reality.js';
import { COMMUNITY, execBody, SAFE, startStub } from '../helpers/stub.js';
import { CHAIN, ME, quiet, setup, spentDay } from '../helpers/node.js';

const networks = loadNetworks();
const MODULE = getAddress(`0x${'4d'.repeat(20)}`);
const QID = `0x${'7a'.repeat(32)}`;
const PROPOSAL = `0x${'5c'.repeat(32)}`;
const allowAll = { check: () => ({ ok: true }) };

/** A Reality service over the scriptable node: the hub's verdict is "passed", the question is asked when `asked`. */
function reality({ asked }) {
  const ctx = setup({
    node: {
      read: ({ functionName }) => ({
        buildQuestion: 'Q',
        questionIds: asked ? QID : zeroHash,
        getQuestionId: QID,
        isFinalized: false,
        getBond: 0n,
        minimumBond: 10n,
      })[functionName],
    },
  });
  ctx.db.addGroup({ chainId: CHAIN, safe: SAFE, space: 'a.eth', community: COMMUNITY });
  const answerer = {
    async evaluate() { return { kind: 'ok', question: 'Q', txHashes: [`0x${'11'.repeat(32)}`], packedHash: `0x${'11'.repeat(32)}`, txs: [] }; },
    decideFromVerdict() { return { answer: 'yes', reason: 'passed' }; },
  };
  const service = createReality({
    db: ctx.db, config: { configured: true, address: ME }, networks, chains: ctx.node.chains, cap: ctx.cap, queue: ctx.queue,
    groupModules: { async modulesFor() { return [MODULE]; } }, hub: null, answerer, logger: quiet,
  });
  return { ...ctx, service };
}

describe('round 2 MEDIUM 5: after a broadcast, 202 with the hash', () => {
  test('after-broadcast: POST /send/safe-exec: recording the send fails after the broadcast: 202 with the hash, reservation held', async () => {
    const s = await startStub({ groups: [{ chainId: CHAIN, safe: SAFE, space: 'a.eth' }] });
    try {
      s.db.recordSend = () => { throw new Error('disk full'); };
      const res = await s.call('POST', '/send/safe-exec', execBody(networks));
      assert.equal(res.status, 202, res.text);
      assert.equal(res.json.status, 'pending');
      assert.equal(res.json.hash, s.db.listPending()[0].hash);
      assert.equal(s.chains.calls.send, 1);
      assert.ok(BigInt(s.cap.status().spentDayWei) > 0n);
    } finally {
      await s.close();
    }
  });

  test('after-broadcast: pipeline: recording the send fails after the broadcast: still ok, with the hash', async () => {
    const { db, cap, node, queue } = setup();
    db.recordSend = () => { throw new Error('disk full'); };
    const pipe = createPipeline({ config: { address: ME }, db, chains: node.chains, cap, queue, logger: quiet });
    const out = await pipe.send({ chainId: CHAIN, safe: SAFE, to: ME, selectorName: 'addProposal', data: '0x', kind: 'reality-add', list: allowAll });
    assert.equal(out.ok, true);
    assert.equal(out.hash, db.listPending()[0].hash);
    assert.equal(node.state.sent.length, 1);
    assert.equal(spentDay(cap), 1200n);
  });

  test('after-broadcast: POST /send/reality/answer: storing the question fails after the broadcast: 202 with the hash, not 502 read_failed', async () => {
    const r = reality({ asked: true });
    r.db.insertQuestion = () => { throw new Error('disk full'); };
    const out = await r.service.answer({ chainId: CHAIN, safe: SAFE, proposalId: PROPOSAL });
    assert.equal(out.status, 202, JSON.stringify(out.body));
    assert.equal(out.body.hash, r.db.listPending()[0].hash);
    assert.equal(out.body.status, 'pending');
    assert.equal(out.body.questionId, QID);
    assert.equal(r.node.state.sent.length, 1);
  });

  test('after-broadcast: POST /send/reality/add: recording the send fails after the broadcast: 202 with the hash', async () => {
    const r = reality({ asked: false });
    r.db.recordSend = () => { throw new Error('disk full'); };
    const out = await r.service.add({ chainId: CHAIN, safe: SAFE, proposalId: PROPOSAL });
    assert.equal(out.status, 202, JSON.stringify(out.body));
    assert.equal(out.body.hash, r.db.listPending()[0].hash);
    assert.equal(out.body.questionId, QID);
  });

  test('after-broadcast: POST /send/reality/answer: a read that fails before any broadcast is still 502 read_failed, and nothing is sent', async () => {
    const r = reality({ asked: true });
    r.node.state.read = () => { throw new Error('rpc down'); };
    const out = await r.service.answer({ chainId: CHAIN, safe: SAFE, proposalId: PROPOSAL });
    assert.equal(out.status, 502);
    assert.deepEqual(out.body, { error: 'read_failed', broadcast: false });
    assert.equal(r.node.state.sent.length, 0);
  });
});
