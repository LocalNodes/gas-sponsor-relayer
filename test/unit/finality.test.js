// 25-28 round 3, #2 (Codex round 3 HIGH 2, ruling (a)): a receipt settles the spend cap only once its block is
// finalized. Until then the send's whole reservation (its maximum, with every fee-bump increase) stays held.
// - A receipt of one of the send's own hashes marks the send "mined, awaiting finality" (status `confirming`). It stays
//   in the poll loop and in reconcile; it is never bumped or rebroadcast.
// - Each pass reads, on the proof endpoint, the receipt again and the block at its height. When the receipt is gone, or
//   the block at that height has another hash, the block was reorged out: the send goes back to pending with its
//   maximum still reserved, and a later receipt starts over.
// - Once the finalized block is at or past the receipt's block, and the receipt's block is on the finalized chain,
//   the send settles to the real cost from that receipt.
// Callers (waitMined, the ENS, reclaim and Reality flows, onMined) still act on the first receipt for their own flow.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CapReached, createCap } from '../../src/cap.js';
import { createEvents } from '../../src/events.js';
import { createQueue } from '../../src/queue.js';
import { createPipeline } from '../../src/sends/pipeline.js';
import { RELAYER_ACCOUNT, startStub } from '../helpers/stub.js';
import { blockHash, CHAIN, inBlock, ME, NOW, quiet, receipt, setup, spentDay, tx } from '../helpers/node.js';

/** One send at nonce 5 holding a reservation of 1,000 wei (gas 100 x maxFeePerGas 10), first sent at block 100. */
async function oneSend(o = {}) {
  const ctx = setup(o);
  const reservation = ctx.cap.reserve(CHAIN, 1000n);
  const sent = await ctx.queue.enqueue(CHAIN, () => tx(), { reservation });
  return { ...ctx, sent, reservation };
}

describe('round 3 #2: the cap settles a receipt only at finality', () => {
  test('finality: Codex repro: caps of 1,000; the receipt (100 wei) is not final, its block is reorged out, the send mines again for 400: liability is never under-counted', async () => {
    const { db, cap, node, queue, sent } = await oneSend({ dayWei: 1000n, monthWei: 1000n, node: { finalized: 100n } });
    node.state.receipts[sent.hash] = inBlock(node, receipt(sent.hash, 50n, 2n, 101n)); // 100 wei, in block 101, not final
    node.state.block = 102n;
    await queue.tick();
    assert.equal(db.listPending()[0].status, 'confirming');
    assert.equal(spentDay(cap), 1000n, 'the maximum stays held until finality');
    assert.throws(() => cap.reserve(CHAIN, 900n), CapReached, 'a second 900 does not fit beside the unfinal send');

    // Block 101 is reorged out: the receipt is gone and block 101 now has another hash.
    delete node.state.receipts[sent.hash];
    node.state.forks = { 1: 101n };
    node.state.canon = 1;
    await queue.tick();
    assert.equal(db.listPending()[0].status, 'pending', 'back to waiting');
    assert.equal(spentDay(cap), 1000n, 'with its maximum');
    assert.ok(db.listEvents().some((e) => e.kind === 'send_reorged'));

    // The same transaction mines again, more expensively (400 wei), in block 103 of the new chain.
    node.state.receipts[sent.hash] = inBlock(node, receipt(sent.hash, 100n, 4n, 103n, 1));
    node.state.block = 104n;
    await queue.tick();
    assert.equal(db.listPending()[0].status, 'confirming');
    assert.equal(spentDay(cap), 1000n);
    node.state.finalized = 110n;
    node.state.block = 111n;
    await queue.tick();
    const row = db.listPending()[0];
    assert.equal(row.status, 'mined');
    assert.equal(spentDay(cap), 400n, 'the later, more expensive receipt is the one charged');
    assert.throws(() => cap.reserve(CHAIN, 900n), CapReached);
    assert.ok(cap.reserve(CHAIN, 600n));
  });

  test('finality: a receipt marks the send confirming; no fee bump while it waits; it settles to the real cost once its block is finalized', async () => {
    const { db, cap, node, queue, sent } = await oneSend({ node: { finalized: 90n } });
    node.state.receipts[sent.hash] = inBlock(node, receipt(sent.hash));
    await queue.tick();
    assert.equal(db.listPending()[0].status, 'confirming');
    assert.equal(db.listPending()[0].consumedBy, sent.hash);
    assert.equal(spentDay(cap), 1000n);
    for (let i = 0; i < 3; i += 1) {
      node.state.block += 12n;
      await queue.tick();
    }
    assert.equal(node.state.sent.length, 1, 'never bumped');
    assert.equal(db.listPending()[0].status, 'confirming');
    node.state.finalized = 101n;
    await queue.tick();
    assert.equal(db.listPending()[0].status, 'mined');
    assert.equal(spentDay(cap), 150n);
    assert.deepEqual(db.openSpend(), []);
  });

  test('finality: the receipt is read again on the proof endpoint; a reorg in any form puts the send back to pending with its maximum', async () => {
    const cases = {
      'the receipt is gone': (n, h) => { delete n.state.receipts[h]; },
      'the receipt now names another block': (n, h) => { n.state.receipts[h] = receipt(h, 50n, 3n, 102n); },
      'the block at that height has another hash': (n) => { n.state.forks = { 1: 101n }; n.state.canon = 1; },
      'finalized past it, and the finalized chain holds another block there': (n) => {
        n.state.forks = { 1: 100n };
        n.state.canon = 0;
        n.state.finalizedFork = 1;
        n.state.finalized = 105n;
      },
    };
    for (const [name, reorg] of Object.entries(cases)) {
      const { db, cap, node, queue, sent } = await oneSend({ node: { finalized: 90n } });
      node.state.receipts[sent.hash] = inBlock(node, receipt(sent.hash));
      await queue.tick();
      assert.equal(db.listPending()[0].status, 'confirming', name);
      reorg(node, sent.hash);
      // The public client still has the old receipt: only the proof endpoint's reads decide.
      node.state.proofReceipts = { ...node.state.receipts };
      node.state.receipts = { [sent.hash]: receipt(sent.hash) };
      if (name === 'the receipt is gone') delete node.state.proofReceipts[sent.hash];
      await queue.tick();
      const row = db.listPending()[0];
      assert.notEqual(row.status, 'mined', name);
      assert.equal(spentDay(cap), 1000n, `${name}: the maximum stays`);
      assert.ok(db.listEvents().some((e) => e.kind === 'send_reorged'), name);
    }
  });

  test('finality: a read that fails on a confirming send changes nothing: it keeps waiting with its maximum', async () => {
    for (const failing of ['receipt', 'block', 'finalized', 'blockHash']) {
      const { db, cap, node, queue, sent } = await oneSend({ node: { finalized: 90n } });
      node.state.receipts[sent.hash] = inBlock(node, receipt(sent.hash));
      await queue.tick();
      assert.equal(db.listPending()[0].status, 'confirming', failing);
      node.state.finalized = 120n;
      node.state.proofError = (m) => m === failing;
      await queue.tick();
      assert.equal(db.listPending()[0].status, 'confirming', failing);
      assert.equal(spentDay(cap), 1000n, failing);
      node.state.proofError = () => false;
      await queue.tick();
      assert.equal(db.listPending()[0].status, 'mined', failing);
      assert.equal(spentDay(cap), 150n, failing);
    }
  });

  test('finality: a send back to pending after a reorg is not bumped at once: its bump timer starts again at the head', async () => {
    const { db, node, queue, sent } = await oneSend({ node: { finalized: 90n } });
    node.state.receipts[sent.hash] = inBlock(node, receipt(sent.hash));
    node.state.block = 130n; // sent at 100: far past the fee-bump threshold
    await queue.tick();
    assert.equal(db.listPending()[0].status, 'confirming');
    delete node.state.receipts[sent.hash];
    await queue.tick();
    assert.equal(db.listPending()[0].status, 'pending');
    assert.equal(db.listPending()[0].sentBlock, '130');
    node.state.block = 131n;
    await queue.tick();
    assert.equal(node.state.sent.length, 1, 'no fee bump right after the reorg');
  });

  test('finality: a receipt only the read client has (the proof endpoint has none yet) changes nothing, and the send is not bumped', async () => {
    const { db, cap, node, queue, sent } = await oneSend();
    node.state.receipts[sent.hash] = inBlock(node, receipt(sent.hash));
    node.state.proofReceipts = {};
    node.state.block = 130n;
    await queue.tick();
    assert.equal(db.listPending()[0].status, 'pending');
    assert.equal(spentDay(cap), 1000n);
    assert.equal(node.state.sent.length, 1, 'its own transaction mined: no bump');
    assert.equal(db.listPending()[0].consumedBy, null, 'never marked confirming from the read client\'s receipt');
    assert.equal(db.listPending()[0].sentBlock, '100');
    assert.ok(!db.listEvents().some((e) => e.kind === 'send_reorged'), 'no confirm-then-reorg round trip');
    node.state.proofReceipts = null;
    await queue.tick();
    assert.equal(db.listPending()[0].status, 'mined');
  });

  test('finality: a bumped send keeps its whole raised maximum until finality', async () => {
    const { cap, node, queue, db } = await oneSend({ node: { finalized: 90n } });
    node.state.block += 12n;
    await queue.tick();
    const held = spentDay(cap);
    assert.ok(held > 1000n);
    const bumped = db.listPending()[0].hash;
    node.state.receipts[bumped] = inBlock(node, receipt(bumped, 60n, 4n, 113n));
    node.state.block = 114n;
    await queue.tick();
    assert.equal(spentDay(cap), held);
    node.state.finalized = 113n;
    await queue.tick();
    assert.equal(spentDay(cap), 240n);
  });

  test('finality: reconcile at boot keeps a confirming send, never rebroadcasts it, and settles it once final', async () => {
    const first = await oneSend({ node: { finalized: 90n } });
    first.node.state.receipts[first.sent.hash] = inBlock(first.node, receipt(first.sent.hash));
    await first.queue.tick();
    assert.equal(first.db.listPending()[0].status, 'confirming');
    first.node.state.pending = 5; // a node that lost its pool: a pending send there would be rebroadcast
    const events = createEvents({ db: first.db });
    const cap = createCap({ db: first.db, caps: { dayWei: 10n ** 18n, monthWei: 10n ** 19n }, now: () => NOW, events });
    const queue = createQueue({ db: first.db, chains: first.node.chains, cap, address: ME, logger: quiet, events });
    assert.equal(queue.releaseOrphans(), 0);
    let r = await queue.reconcile();
    assert.equal(r.rebroadcast, 0);
    assert.equal(first.node.state.sent.length, 1);
    assert.equal(spentDay(cap), 1000n);
    first.node.state.finalized = 101n;
    r = await queue.reconcile();
    assert.equal(r.mined, 1);
    assert.equal(spentDay(cap), 150n);
  });

  test('finality: a confirming send keeps its nonce: the next send never takes it', async () => {
    const { db, node, queue, sent } = await oneSend({ node: { finalized: 90n } });
    node.state.receipts[sent.hash] = inBlock(node, receipt(sent.hash));
    await queue.tick();
    assert.equal(db.listPending()[0].status, 'confirming');
    node.state.pending = 5; // the node's view went back (a reorg)
    node.state.latest = 5;
    const next = await queue.enqueue(CHAIN, () => tx({ data: '0x01' }), {});
    assert.equal(next.nonce, 6);
  });

  test('finality: a send marked replaced whose own receipt appears holds its maximum again, and never settles against the finalized OTHER (dedupe MEDIUM)', async () => {
    const OTHER = `0x${'ab'.repeat(32)}`;
    const { db, cap, node, queue, sent } = await oneSend();
    node.state.mined.push({ hash: OTHER, nonce: 5, block: 103n });
    node.state.latest = 6;
    node.state.block = 111n;
    node.state.finalized = 105n;
    await queue.tick();
    assert.equal(db.listPending()[0].status, 'replaced');
    assert.equal(spentDay(cap), 0n);
    node.state.receipts[sent.hash] = inBlock(node, receipt(sent.hash, 50n, 3n, 108n));
    await queue.tick();
    assert.equal(db.listPending()[0].status, 'confirming');
    assert.equal(spentDay(cap), 1000n, 'the release is undone at the maximum');
    assert.ok(db.listEvents().some((e) => e.kind === 'send_release_reversed'));
    // OTHER took nonce 5 at 103 on the finalized chain, so an own inclusion at 108 contradicts it: held, not settled.
    node.state.finalized = 108n;
    await queue.tick();
    assert.equal(db.listPending()[0].status, 'confirming');
    assert.equal(spentDay(cap), 1000n);
  });
});

describe('round 3 #2: what callers see before finality', () => {
  test('finality: waitMined returns the receipt as soon as it is seen, while the cap still holds the maximum', async () => {
    const { db, cap, node, queue, sent } = await oneSend({ node: { finalized: 90n } });
    node.state.receipts[sent.hash] = inBlock(node, receipt(sent.hash));
    const pipe = createPipeline({ config: { address: ME }, db, chains: node.chains, cap, queue, logger: quiet, sleep: async () => {}, timeoutMs: 50 });
    const got = await pipe.waitMined(CHAIN, sent);
    assert.equal(got.transactionHash, sent.hash);
    await queue.tick();
    assert.equal(spentDay(cap), 1000n);
  });

  test('finality: onMined runs when the receipt is seen, not 13 minutes later at finality', async () => {
    const ctx = setup({ node: { finalized: 90n } });
    const seen = [];
    const queue = createQueue({ db: ctx.db, chains: ctx.node.chains, cap: ctx.cap, address: ME, logger: quiet, onMined: (row) => seen.push(row.nonce) });
    const sent = await queue.enqueue(CHAIN, () => tx(), { reservation: ctx.cap.reserve(CHAIN, 1000n) });
    ctx.node.state.receipts[sent.hash] = inBlock(ctx.node, receipt(sent.hash));
    await queue.tick();
    assert.deepEqual(seen, [5]);
    ctx.node.state.finalized = 101n;
    await queue.tick();
    assert.deepEqual(seen, [5], 'once');
  });

  test('finality: GET /sends/:hash says mined with finalized false while it waits, then finalized true', async () => {
    const ctx = setup({ node: { me: RELAYER_ACCOUNT.address, finalized: 90n } });
    const s = await startStub({ chains: ctx.node.chains });
    try {
      const sent = await s.queue.enqueue(CHAIN, () => tx(), { reservation: s.cap.reserve(CHAIN, 1000n) });
      ctx.node.state.receipts[sent.hash] = inBlock(ctx.node, receipt(sent.hash));
      await s.queue.tick();
      let res = await s.call('GET', `/sends/${sent.hash}`);
      assert.equal(res.json.status, 'mined');
      assert.equal(res.json.minedHash, sent.hash);
      assert.equal(res.json.finalized, false);
      ctx.node.state.finalized = 101n;
      await s.queue.tick();
      res = await s.call('GET', `/sends/${sent.hash}`);
      assert.equal(res.json.status, 'mined');
      assert.equal(res.json.finalized, true);
    } finally {
      await s.close();
    }
  });
});

// The fake's block hashes are what the relayer compares; a sanity check that they name fork and height.
test('finality: the fake chain names a block by fork and height', () => {
  assert.notEqual(blockHash(101n), blockHash(101n, 1));
  assert.equal(blockHash(101n), blockHash(101));
});
