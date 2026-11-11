// 25-28 round 3, #3 (Codex round 3 HIGH 3): the release proof is bound to the finalized chain.
// The proof read the finalized block's number and dropped its hash. The block it then found by number, and the
// transaction in it, were never tied to that finalized block, so one endpoint that answered with two different blocks
// at one height could release a send whose own transaction had mined.
// Now, on the proof endpoint and in one pass:
// - the finalized block's hash is pinned;
// - the consuming block must be on the chain that ends in it: parent hashes are followed down from the pinned block to
//   the consuming block's height, and must arrive at the consuming block's hash (at the finalized height itself, the
//   two hashes must be equal);
// - the consuming transaction's blockHash and blockNumber must be that block's; on our own hash, so must its receipt's;
// - any mismatch, or a read that fails, or a walk not finished within the pass's budget, leaves the send unresolved.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { blockHash, CHAIN, receipt, setup, spentDay, tx } from '../helpers/node.js';

const OTHER = `0x${'ab'.repeat(32)}`;

async function oneSend(o = {}) {
  const ctx = setup(o);
  const sent = await ctx.queue.enqueue(CHAIN, () => tx(), { reservation: ctx.cap.reserve(CHAIN, 1000n) });
  return { ...ctx, sent };
}

/** Another transaction from the relayer took nonce 5 at `block` (on fork `fork`); `finalized` is the finalized block. */
function takenAt(node, block = 103n, finalized = 105n, fork = 0) {
  node.state.mined.push({ hash: OTHER, nonce: 5, block, fork });
  node.state.latest = 6;
  node.state.block = 111n; // below the fee-bump threshold (sent at 100, bumped from 112): the reservation stays 1,000
  node.state.finalized = finalized;
}

const held = ({ db, cap }, name) => {
  assert.equal(db.listPending()[0].status, 'pending', name);
  assert.equal(spentDay(cap), 1000n, name);
};

describe('round 3 #3: the release proof is bound to the finalized chain', () => {
  test('proof-binding: Codex repro: finalized block 105 is hash A holding our own transaction; block 105 read by number is hash B holding another at nonce 5: nothing is released', async () => {
    const ctx = await oneSend();
    const { node, queue, sent } = ctx;
    // Fork 0 (hash A at 105) holds our own transaction; fork 1 (hash B at 105) holds another one with the same nonce.
    node.state.mined.push({ hash: sent.hash, nonce: 5, block: 105n, fork: 0 }, { hash: OTHER, nonce: 5, block: 105n, fork: 1 });
    node.state.forks = { 1: 105n };
    node.state.canon = 1; // reads by number answer from fork 1 (hash B)
    node.state.finalizedFork = 0; // the finalized read names fork 0 (hash A)
    node.state.finalized = 105n;
    node.state.latest = 6;
    node.state.block = 111n;
    await queue.tick();
    held(ctx, 'block 105 by number is not the pinned finalized block');
    assert.ok(!ctx.db.listEvents().some((e) => e.kind === 'send_replaced'));
  });

  test('proof-binding: a consuming block below finalized that is not an ancestor of the pinned finalized block releases nothing', async () => {
    const ctx = await oneSend();
    takenAt(ctx.node, 103n, 110n, 1);
    ctx.node.state.forks = { 1: 103n };
    ctx.node.state.canon = 1; // block 103 by number is fork 1's, with the other transaction
    ctx.node.state.finalizedFork = 0; // the finalized block 110 is fork 0's: its block 103 is another
    await ctx.queue.tick();
    held(ctx, 'side block');
  });

  test('proof-binding: the consuming transaction must report the consuming block as its own', async () => {
    const cases = {
      'another block hash': (t) => blockHash(t.blockNumber, 7),
      'no block hash': () => undefined,
    };
    for (const [name, txHash] of Object.entries(cases)) {
      const ctx = await oneSend();
      takenAt(ctx.node);
      ctx.node.state.txBlockHash = txHash;
      await ctx.queue.tick();
      held(ctx, name);
    }
  });

  test('proof-binding: our own transaction in the consuming block settles only from a receipt that names that block', async () => {
    const ctx = await oneSend();
    const { node, queue, sent } = ctx;
    node.state.mined.push({ hash: sent.hash, nonce: 5, block: 103n });
    node.state.latest = 6;
    node.state.block = 111n;
    node.state.finalized = 105n;
    node.state.receipts = {}; // the read client has no receipt yet
    node.state.proofReceipts = { [sent.hash]: receipt(sent.hash, 40n, 2n, 103n, 3) }; // a receipt naming another block
    await queue.tick();
    held(ctx, 'receipt in another block');
    node.state.proofReceipts = { [sent.hash]: receipt(sent.hash, 40n, 2n, 103n) };
    await queue.tick();
    assert.equal(ctx.db.listPending()[0].status, 'mined');
    assert.equal(spentDay(ctx.cap), 80n);
  });

  test('proof-binding: a read by hash that fails leaves the send unresolved; the next pass releases it', async () => {
    const ctx = await oneSend();
    takenAt(ctx.node, 103n, 110n);
    ctx.node.state.proofError = (m) => m === 'blockHash';
    await ctx.queue.tick();
    held(ctx, 'by-hash read failed');
    ctx.node.state.proofError = () => false;
    await ctx.queue.tick();
    assert.equal(ctx.db.listPending()[0].status, 'replaced');
    assert.equal(spentDay(ctx.cap), 0n);
  });

  test('proof-binding: a walk longer than one pass\'s budget goes on in the next pass from where it stopped', async () => {
    const ctx = await oneSend();
    takenAt(ctx.node, 103n, 103n + 300n); // 300 blocks between the consuming block and the finalized one
    await ctx.queue.tick();
    held(ctx, 'the walk is not finished in the first pass');
    const before = ctx.node.state.reads.filter((r) => r[0] === 'proof' && r[1] === 'block').length;
    await ctx.queue.tick();
    assert.equal(ctx.db.listPending()[0].status, 'replaced');
    assert.equal(spentDay(ctx.cap), 0n);
    const second = ctx.node.state.reads.filter((r) => r[0] === 'proof' && r[1] === 'block').length - before;
    assert.ok(second < 100, `the second pass read only the rest of the walk (${second} block reads)`);
  });

  test('proof-binding: a block read by hash must be the block asked for, at the height expected', async () => {
    const cases = {
      'another hash': (b) => ({ ...b, hash: blockHash(b.number, 9) }),
      'another height': (b) => ({ ...b, number: b.number + 1n }),
      'no parent hash': (b) => ({ ...b, parentHash: undefined }),
    };
    for (const [name, tamper] of Object.entries(cases)) {
      const ctx = await oneSend();
      takenAt(ctx.node, 103n, 110n);
      ctx.node.state.byHashTamper = tamper;
      await ctx.queue.tick();
      held(ctx, name);
    }
  });

  test('proof-binding: at the finalized height itself, the consuming block must be the pinned block', async () => {
    const ctx = await oneSend();
    takenAt(ctx.node, 105n, 105n);
    await ctx.queue.tick();
    assert.equal(ctx.db.listPending()[0].status, 'replaced', 'the same block: released');
    const other = await oneSend();
    takenAt(other.node, 105n, 105n, 1);
    other.node.state.forks = { 1: 105n };
    other.node.state.canon = 1;
    other.node.state.finalizedFork = 0;
    await other.queue.tick();
    held(other, 'another block at the finalized height');
  });
});
