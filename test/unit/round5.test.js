// 25-28 fix round 5 (Codex round 5 INTRODUCED HIGH; the orchestrator's ruling: round-4 Q1 is now (b)).
// A send marked replaced has had its reservation given back. When a receipt of one of its own hashes appears later,
// the reservation (with every fee-bump increase) is held again first, whole, before any read that can fail: the send
// goes back to pending. Only a receipt bound to its block (ownIn 'bound') then marks it confirming, and only a final
// one settles it. Round 4 checked the binding first, so a failed block read or an unbound receipt left the send
// replaced with nothing held, and another full reservation fitted beside it.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CapReached } from '../../src/cap.js';
import { CHAIN, inBlock, receipt, setup, spentDay, tx } from '../helpers/node.js';

const OTHER = `0x${'ab'.repeat(32)}`;

/**
 * Caps of 1,000. One send at nonce 5 reserves 1,000 (first sent at block 100); OTHER takes nonce 5 at block 103,
 * finalized at 105, so the send is proven replaced and its reservation given back. The head then moves to 113.
 */
async function replacedSend() {
  const ctx = setup({ dayWei: 1000n, monthWei: 1000n });
  const sent = await ctx.queue.enqueue(CHAIN, () => tx(), { reservation: ctx.cap.reserve(CHAIN, 1000n) });
  ctx.node.state.mined.push({ hash: OTHER, nonce: 5, block: 103n });
  ctx.node.state.latest = 6;
  ctx.node.state.block = 111n;
  ctx.node.state.finalized = 105n;
  await ctx.queue.tick();
  assert.equal(ctx.db.listPending()[0].status, 'replaced');
  assert.equal(spentDay(ctx.cap), 0n);
  ctx.node.state.block = 113n;
  return { ...ctx, sent };
}

const reversals = (db) => db.listEvents().filter((e) => e.kind === 'send_release_reversed');

/** The send held again, unresolved: pending, the whole 1,000 counted, no receipt kept, one reversal event. */
function heldAgain({ db, cap }, name) {
  const row = db.listPending()[0];
  assert.equal(row.status, 'pending', `${name}: back to pending`);
  assert.equal(spentDay(cap), 1000n, `${name}: the whole reservation is held again`);
  assert.equal(row.consumedBy, null, `${name}: no consuming hash kept`);
  assert.equal(row.consumedBlock, null, `${name}: no block kept`);
  assert.equal(row.minedBlockHash, null, `${name}: no block hash kept`);
  assert.equal(reversals(db).length, 1, `${name}: one send_release_reversed event`);
  assert.throws(() => cap.reserve(CHAIN, 1000n), CapReached, `${name}: a second 1,000 does not fit`);
}

describe('round 5: a replaced send whose own receipt appears is held again before the binding read', () => {
  test('round 5: Codex repro: caps of 1,000, the send is replaced, its own receipt appears and the block read fails: 1,000 is held again and a second 1,000 does not fit', async () => {
    const { db, cap, node, queue, sent } = await replacedSend();
    node.state.receipts[sent.hash] = receipt(sent.hash, 50n, 3n, 108n);
    node.state.proofError = (method) => method === 'block';
    await queue.tick();
    assert.equal(db.listPending()[0].status, 'pending');
    assert.equal(spentDay(cap), 1000n);
    assert.throws(() => cap.reserve(CHAIN, 1000n), CapReached);
  });

  test('round 5: a replaced send whose late own-hash receipt is not bound to its block is held again at 1,000 and never settled', async () => {
    const ctx = await replacedSend();
    const { db, node, queue, sent } = ctx;
    // The receipt names block 108, but block 108 does not list the transaction (no inBlock): the evidence disagrees.
    node.state.receipts[sent.hash] = receipt(sent.hash, 50n, 3n, 108n);
    await queue.tick();
    heldAgain(ctx, 'first pass');
    // Block 108 is final now; the receipt is still unbound, so the send stays held and is not settled.
    node.state.finalized = 120n;
    node.state.block = 121n;
    await queue.tick();
    heldAgain(ctx, 'once final');
  });

  test('round 5: a replaced send whose binding read fails is held again; once the read answers it confirms', async () => {
    const cases = {
      'the block read fails': (n) => { n.state.proofError = (m) => m === 'block'; },
      'the proof endpoint receipt read fails': (n) => { n.state.proofError = (m) => m === 'receipt'; },
    };
    for (const [name, spoil] of Object.entries(cases)) {
      const ctx = await replacedSend();
      const { db, node, queue, sent } = ctx;
      node.state.receipts[sent.hash] = inBlock(node, receipt(sent.hash, 50n, 3n, 108n));
      spoil(node);
      await queue.tick();
      heldAgain(ctx, name);
      await queue.tick();
      heldAgain(ctx, `${name}, a second pass`);
      node.state.proofError = () => false;
      await queue.tick();
      assert.equal(db.listPending()[0].status, 'confirming', name);
      assert.equal(spentDay(ctx.cap), 1000n, name);
      assert.equal(reversals(db).length, 1, `${name}: still one reversal`);
    }
  });

  test('round 5: a replaced send with a bound late receipt is held again, then confirming, and at finality stays held against the finalized OTHER (dedupe MEDIUM)', async () => {
    const { db, cap, node, queue, sent } = await replacedSend();
    node.state.receipts[sent.hash] = inBlock(node, receipt(sent.hash, 50n, 3n, 108n));
    const written = [];
    const update = db.updatePending;
    db.updatePending = (id, row) => {
      written.push(row.status);
      return update(id, row);
    };
    await queue.tick();
    db.updatePending = update;
    assert.deepEqual(written, ['pending', 'confirming'], 'held again first, then marked confirming');
    const row = db.listPending()[0];
    assert.equal(row.status, 'confirming');
    assert.equal(row.consumedBy, sent.hash);
    assert.equal(row.sentBlock, '113', 'the bump timer restarts at the head of the pass that held it again');
    assert.equal(spentDay(cap), 1000n);
    assert.throws(() => cap.reserve(CHAIN, 1000n), CapReached);
    const ev = reversals(db);
    assert.equal(ev.length, 1);
    assert.equal(JSON.parse(ev[0].detail).replacedBy, OTHER);
    assert.equal(JSON.parse(ev[0].detail).hash, sent.hash);

    // OTHER at 103 and the own hash at 108 cannot both be on the finalized chain (Codex round-5 re-check MEDIUM).
    node.state.finalized = 108n;
    await queue.tick();
    assert.equal(db.listPending()[0].status, 'confirming');
    assert.equal(spentDay(cap), 1000n, 'the whole reservation stays held');
    assert.equal(reversals(db).length, 1);
  });
});
