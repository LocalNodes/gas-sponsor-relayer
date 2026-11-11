// 25-28 dedupe round (orchestrator ruling): a retried send request must never become a second transaction. A request
// that repeats one already sent or waiting answers 202 with the existing hash and "duplicate": true, and nothing is
// reserved, signed or broadcast for it. The check is made inside queue.enqueue, under the chain's serialisation, so
// two concurrent requests cannot both pass it. A replaced send never happened, so it is no duplicate.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress, zeroHash } from 'viem';
import { loadNetworks } from '../../src/config.js';
import { createPipeline } from '../../src/sends/pipeline.js';
import { createReality } from '../../src/sends/reality.js';
import { ANSWER_BYTES } from '../../src/answer.js';
import { COMMUNITY, execBody, SAFE, startStub } from '../helpers/stub.js';
import { CHAIN, ME, quiet, refusal, setup, spentDay } from '../helpers/node.js';

const networks = loadNetworks();
const GROUP = [{ chainId: CHAIN, safe: SAFE, space: 'a.eth' }];
const allowAll = { check: () => ({ ok: true }) };
const KEY = 'reality-add:11155111:0xaa';
const MODULE = getAddress(`0x${'4d'.repeat(20)}`);
const QID = `0x${'7a'.repeat(32)}`;
const PROPOSAL = `0x${'5c'.repeat(32)}`;
const TXHASH = `0x${'11'.repeat(32)}`;

function pipeline() {
  const ctx = setup();
  const pipe = createPipeline({ config: { address: ME }, db: ctx.db, chains: ctx.node.chains, cap: ctx.cap, queue: ctx.queue, logger: quiet });
  return { ...ctx, pipe, send: (extra = {}) => pipe.send({ chainId: CHAIN, safe: SAFE, to: ME, selectorName: 'addProposal', data: '0x', kind: 'reality-add', list: allowAll, ...extra }) };
}

describe('duplicate: safe-exec', () => {
  test('duplicate: two requests with the same Safe nonce: the second is 202 duplicate with the first hash, one transaction, one reservation', async () => {
    const s = await startStub({ groups: GROUP, chainsOpts: { safeNonce: 7 } });
    try {
      const first = await s.call('POST', '/send/safe-exec', execBody(networks));
      assert.equal(first.status, 202, first.text);
      assert.equal(first.json.duplicate, undefined);
      const held = BigInt(s.cap.status().spentDayWei);
      assert.ok(held > 0n);
      const second = await s.call('POST', '/send/safe-exec', execBody(networks));
      assert.equal(second.status, 202, second.text);
      assert.deepEqual(second.json, { hash: first.json.hash, status: 'pending', duplicate: true });
      assert.equal(s.chains.calls.send, 1);
      assert.equal(s.db.listPending().length, 1);
      assert.equal(BigInt(s.cap.status().spentDayWei), held, 'the duplicate holds nothing');
    } finally {
      await s.close();
    }
  });

  test('duplicate: a different Safe nonce is a new send', async () => {
    const nonces = [7, 8];
    const s = await startStub({ groups: GROUP, chainsOpts: { safeNonce: () => BigInt(nonces.shift()) } });
    try {
      const a = await s.call('POST', '/send/safe-exec', execBody(networks));
      const b = await s.call('POST', '/send/safe-exec', execBody(networks));
      assert.equal(a.status, 202, a.text);
      assert.equal(b.status, 202, b.text);
      assert.notEqual(a.json.hash, b.json.hash);
      assert.equal(b.json.duplicate, undefined);
      assert.equal(s.chains.calls.send, 2);
    } finally {
      await s.close();
    }
  });

  test('duplicate: two concurrent requests with the same Safe nonce: exactly one broadcast', async () => {
    const s = await startStub({ groups: GROUP, chainsOpts: { safeNonce: 3 } });
    try {
      const [a, b] = await Promise.all([s.call('POST', '/send/safe-exec', execBody(networks)), s.call('POST', '/send/safe-exec', execBody(networks))]);
      assert.equal(a.status, 202, a.text);
      assert.equal(b.status, 202, b.text);
      assert.equal(a.json.hash, b.json.hash);
      assert.equal([a, b].filter((r) => r.json.duplicate === true).length, 1);
      assert.equal(s.chains.calls.send, 1);
      assert.equal(s.db.listPending().length, 1);
    } finally {
      await s.close();
    }
  });

  test('duplicate: the Safe nonce cannot be read: 502 safe_nonce_unreadable with broadcast false, nothing reserved or sent', async () => {
    const s = await startStub({ groups: GROUP, chainsOpts: { safeNonce: new Error('rpc down') } });
    try {
      const res = await s.call('POST', '/send/safe-exec', execBody(networks));
      assert.equal(res.status, 502, res.text);
      assert.deepEqual(res.json, { error: 'send_failed', reason: 'safe_nonce_unreadable', broadcast: false });
      assert.equal(s.chains.calls.send, 0);
      assert.equal(BigInt(s.cap.status().spentDayWei), 0n);
    } finally {
      await s.close();
    }
  });

  test('duplicate: the Safe nonce is read after the allowlist check: a Safe that is not registered is refused without a read', async () => {
    const s = await startStub({ chainsOpts: { safeNonce: 1 } });
    try {
      const res = await s.call('POST', '/send/safe-exec', execBody(networks));
      assert.equal(res.status, 403, res.text);
      assert.equal(s.chains.calls.nonce, 0);
    } finally {
      await s.close();
    }
  });
});

describe('duplicate: the queue', () => {
  test('duplicate: two concurrent pipeline sends with one dedupeKey: exactly one broadcast, one reservation held', async () => {
    const p = pipeline();
    const [a, b] = await Promise.all([p.send({ dedupeKey: KEY }), p.send({ dedupeKey: KEY })]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(a.hash, b.hash);
    assert.equal([a, b].filter((r) => r.duplicate === true).length, 1);
    const dup = a.duplicate ? a : b;
    assert.equal(dup.reservation, undefined);
    assert.equal(p.node.state.sent.length, 1);
    assert.equal(p.db.listPending().length, 1);
    assert.equal(p.db.listPending()[0].dedupeKey, KEY);
    assert.equal(spentDay(p.cap), 1200n);
  });

  test('duplicate: a later send with the key answers the row\'s current hash, also after a fee bump', async () => {
    const p = pipeline();
    const first = await p.send({ dedupeKey: KEY });
    const row = p.db.listPending()[0];
    const bumped = `0x${'ee'.repeat(32)}`;
    p.db.updatePending(row.id, { ...row, hash: bumped, hashes: [...row.hashes, bumped], attempts: 1, status: 'stuck' });
    const again = await p.send({ dedupeKey: KEY });
    assert.equal(again.ok, true);
    assert.equal(again.duplicate, true);
    assert.equal(again.hash, bumped);
    assert.equal(again.nonce, first.nonce);
    assert.equal(p.node.state.sent.length, 1);
  });

  test('duplicate: a duplicate is not recorded as a send', async () => {
    const p = pipeline();
    let recorded = 0;
    const record = p.db.recordSend;
    p.db.recordSend = (...a) => { recorded += 1; return record.apply(p.db, a); };
    await p.send({ dedupeKey: KEY });
    await p.send({ dedupeKey: KEY });
    assert.equal(recorded, 1);
  });

  for (const status of ['pending', 'stuck', 'confirming', 'mined']) {
    test(`duplicate: a ${status} row with the key is a duplicate: nothing is sent`, async () => {
      const p = pipeline();
      const first = await p.send({ dedupeKey: KEY });
      const row = p.db.listPending()[0];
      p.db.updatePending(row.id, { ...row, status });
      const again = await p.send({ dedupeKey: KEY });
      assert.equal(again.duplicate, true);
      assert.equal(again.hash, first.hash);
      assert.equal(p.node.state.sent.length, 1);
      assert.equal(spentDay(p.cap), 1200n);
    });
  }

  test('duplicate: a replaced row with the key never happened: a new send goes out and carries the key', async () => {
    const p = pipeline();
    const first = await p.send({ dedupeKey: KEY });
    const row = p.db.listPending()[0];
    p.db.updatePending(row.id, { ...row, status: 'replaced' });
    const again = await p.send({ dedupeKey: KEY });
    assert.equal(again.ok, true);
    assert.equal(again.duplicate, undefined);
    assert.notEqual(again.hash, first.hash);
    assert.equal(p.node.state.sent.length, 2);
    assert.equal(p.db.listPending().filter((r) => r.dedupeKey === KEY).length, 2);
  });

  test('duplicate: the same key on another chain is not a duplicate', async () => {
    const p = pipeline();
    await p.send({ dedupeKey: KEY });
    const row = p.db.listPending()[0];
    p.db.updatePending(row.id, { ...row, status: 'mined' });
    // A row of chain 1 holding the key does not stop a send on CHAIN.
    p.db.insertPending({ chainId: 1, nonce: 0, hash: `0x${'dd'.repeat(32)}`, to: ME, data: '0x', value: 0n, gas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, sentBlock: 1n, kind: 'x', dedupeKey: 'other-chain-key' });
    const other = p.db.listPending().find((r) => r.chainId === 1);
    assert.equal(other.dedupeKey, 'other-chain-key');
    assert.equal(p.db.findDuplicate(1, KEY), null);
    assert.equal(p.db.findDuplicate(CHAIN, KEY).hash, row.hash);
  });

  test('duplicate: no key (the watcher\'s challenges): two sends both go out', async () => {
    const p = pipeline();
    const a = await p.send();
    const b = await p.send();
    assert.notEqual(a.hash, b.hash);
    assert.equal(a.duplicate, undefined);
    assert.equal(b.duplicate, undefined);
    assert.equal(p.node.state.sent.length, 2);
    assert.equal(p.db.listPending().every((r) => r.dedupeKey === null), true);
    assert.equal(spentDay(p.cap), 2400n);
  });

  test('duplicate: a send that is refused by the node leaves no row, so the key is free again', async () => {
    const p = pipeline();
    p.node.state.refuse = refusal('insufficient funds for gas * price + value');
    const out = await p.send({ dedupeKey: KEY });
    assert.equal(out.ok, false);
    assert.equal(p.db.findDuplicate(CHAIN, KEY), null);
  });
});

/** A Reality service over a recording pipeline and a node that answers every read the three steps make. */
function realityService({ asked = true } = {}) {
  const ctx = setup({
    node: {
      read: ({ functionName }) => ({
        buildQuestion: 'Q', questionIds: asked ? QID : zeroHash, getQuestionId: QID, isFinalized: true, getBond: 0n, minimumBond: 10n,
        executedProposalTransactions: false, resultFor: ANSWER_BYTES.yes, getFinalizeTS: 0, questionCooldown: 0,
      })[functionName],
    },
  });
  ctx.node.publicClient.getBlock = async () => ({ timestamp: 10n });
  ctx.db.addGroup({ chainId: CHAIN, safe: SAFE, space: 'a.eth', community: COMMUNITY });
  const answerer = {
    async evaluate() { return { kind: 'ok', question: 'Q', txHashes: [TXHASH, TXHASH], packedHash: TXHASH, txs: [{ to: ME, value: 0n, data: '0x', operation: 0 }, { to: ME, value: 0n, data: '0x', operation: 0 }] }; },
    decideFromVerdict() { return { answer: 'yes', reason: 'passed' }; },
  };
  const sends = [];
  let out = (a) => ({ ok: true, hash: `0x${'ab'.repeat(32)}`, nonce: 1 });
  const pipeline = { async send(a) { sends.push(a); return out(a); } };
  const service = createReality({
    db: ctx.db, config: { configured: true, address: ME }, networks, chains: ctx.node.chains, cap: ctx.cap, queue: ctx.queue,
    groupModules: { async modulesFor() { return [MODULE]; } }, hub: null, answerer, pipeline, logger: quiet,
  });
  return { ...ctx, service, sends, answerWith: (f) => { out = f; } };
}

describe('duplicate: Reality keys', () => {
  const v = { chainId: CHAIN, safe: SAFE, proposalId: PROPOSAL };

  test('duplicate: add sends with reality-add:<chainId>:<questionId>', async () => {
    const r = realityService({ asked: false });
    const res = await r.service.add(v);
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(r.sends[0].dedupeKey, `reality-add:${CHAIN}:${QID}`);
    assert.equal(res.body.duplicate, undefined);
  });

  test('duplicate: answer sends with reality-answer:<chainId>:<questionId>', async () => {
    const r = realityService();
    r.node.state.read = ({ functionName }) => ({ questionIds: QID, isFinalized: false, getBond: 0n, minimumBond: 10n })[functionName];
    r.node.publicClient.getBlockNumber = async () => 5n;
    const res = await r.service.answer(v);
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(r.sends[0].dedupeKey, `reality-answer:${CHAIN}:${QID}`);
  });

  test('duplicate: execute sends with reality-execute:<chainId>:<questionId>:<txIndex>', async () => {
    const r = realityService();
    const a = await r.service.execute(v);
    const b = await r.service.execute({ ...v, txIndex: 1 });
    assert.equal(a.status, 202, JSON.stringify(a.body));
    assert.equal(b.status, 202, JSON.stringify(b.body));
    assert.equal(r.sends[0].dedupeKey, `reality-execute:${CHAIN}:${QID}:0`);
    assert.equal(r.sends[1].dedupeKey, `reality-execute:${CHAIN}:${QID}:1`);
  });

  test('duplicate: a duplicate from the pipeline is answered 202 with duplicate true and the existing hash', async () => {
    const r = realityService({ asked: false });
    r.answerWith(() => ({ ok: true, hash: `0x${'cd'.repeat(32)}`, nonce: 4, duplicate: true }));
    const res = await r.service.add(v);
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(res.body.duplicate, true);
    assert.equal(res.body.hash, `0x${'cd'.repeat(32)}`);
    assert.equal(res.body.status, 'pending');
    assert.equal(res.body.questionId, QID);
  });

  test('duplicate: a duplicate answer does not store the question again', async () => {
    const r = realityService();
    r.node.state.read = ({ functionName }) => ({ questionIds: QID, isFinalized: false, getBond: 0n, minimumBond: 10n })[functionName];
    r.node.publicClient.getBlockNumber = async () => 5n;
    r.answerWith(() => ({ ok: true, hash: `0x${'cd'.repeat(32)}`, nonce: 4, duplicate: true }));
    const res = await r.service.answer(v);
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(res.body.duplicate, true);
    assert.equal(r.db.getQuestion(CHAIN, QID), null);
  });
});
