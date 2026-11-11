// 25-28 dedupe round (orchestrator, 2026-11-11).
// 1. Codex round-5 re-check, inherited MEDIUM: confirm() settled an own-hash inclusion that contradicts a finalized
//    consumer of the same nonce. With OTHER taking nonce 5 at block 103 and the send's own hash "included" at 108 on
//    the same chain, both cannot be true; only inconsistent RPC evidence produces it. The send must not settle: the
//    whole reservation stays held.
// 2. Round-5 Q1 pinning: the release is positive-only. An own-receipt lookup that throws plus a positive finalized
//    consumer releases; one that throws with no positive consumer holds.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CapReached } from '../../src/cap.js';
import { blockHash, CHAIN, down, inBlock, receipt, setup, spentDay, tx } from '../helpers/node.js';

const OTHER = `0x${'ab'.repeat(32)}`;

describe('dedupe: confirm() refuses an own inclusion that contradicts a finalized consumer', () => {
  test('dedupe MEDIUM: OTHER takes nonce 5 at 103, the own hash shows at 108; at finality the send does not settle and 1,000 stays held', async () => {
    const { db, cap, node, queue } = setup({ dayWei: 1000n, monthWei: 1000n });
    const sent = await queue.enqueue(CHAIN, () => tx(), { reservation: cap.reserve(CHAIN, 1000n) });
    node.state.mined.push({ hash: OTHER, nonce: 5, block: 103n });
    node.state.latest = 6;
    node.state.block = 110n;
    // Not final yet: the consumer proof cannot release, and the own receipt marks the send confirming.
    node.state.finalized = 102n;
    node.state.receipts[sent.hash] = inBlock(node, receipt(sent.hash, 50n, 3n, 108n));
    await queue.tick();
    assert.equal(db.listPending()[0].status, 'confirming');

    node.state.finalized = 108n;
    await queue.tick();
    await queue.tick();
    const row = db.listPending()[0];
    assert.notEqual(row.status, 'mined', 'an inclusion contradicting the finalized consumer never settles');
    assert.equal(spentDay(cap), 1000n, 'the whole reservation stays held');
    assert.throws(() => cap.reserve(CHAIN, 1000n), CapReached);
  });

  test('dedupe MEDIUM control: the same own inclusion at 108 with no other consumer settles to the real cost', async () => {
    const { db, cap, node, queue } = setup({ dayWei: 1000n, monthWei: 1000n });
    const sent = await queue.enqueue(CHAIN, () => tx(), { reservation: cap.reserve(CHAIN, 1000n) });
    node.state.mined.push({ hash: sent.hash, nonce: 5, block: 108n });
    node.state.latest = 6;
    node.state.block = 110n;
    node.state.finalized = 102n;
    // `mined` already lists the transaction in block 108.
    node.state.receipts[sent.hash] = receipt(sent.hash, 50n, 3n, 108n);
    await queue.tick();
    assert.equal(db.listPending()[0].status, 'confirming');
    node.state.finalized = 108n;
    await queue.tick();
    assert.equal(db.listPending()[0].status, 'mined');
    assert.equal(spentDay(cap), 150n);
  });
});

describe('dedupe: Q1 pinning, the release is positive-only', () => {
  test('dedupe Q1: the own-receipt lookup throws and a finalized consumer names OTHER: released', async () => {
    const { db, cap, node, queue } = setup({ dayWei: 1000n, monthWei: 1000n });
    await queue.enqueue(CHAIN, () => tx(), { reservation: cap.reserve(CHAIN, 1000n) });
    node.state.mined.push({ hash: OTHER, nonce: 5, block: 103n });
    node.state.latest = 6;
    node.state.block = 111n;
    node.state.finalized = 105n;
    node.state.receiptError = down();
    await queue.tick();
    const row = db.listPending()[0];
    assert.equal(row.status, 'replaced');
    assert.equal(row.consumedBy, OTHER);
    assert.equal(spentDay(cap), 0n);
  });

  test('dedupe Q1: the own-receipt lookup throws and no consumer is proven (the nonce only advanced): held', async () => {
    const { db, cap, node, queue } = setup({ dayWei: 1000n, monthWei: 1000n });
    await queue.enqueue(CHAIN, () => tx(), { reservation: cap.reserve(CHAIN, 1000n) });
    node.state.latest = 6;
    node.state.block = 111n;
    node.state.finalized = 105n;
    node.state.receiptError = down();
    await queue.tick();
    const row = db.listPending()[0];
    assert.equal(row.status, 'pending');
    assert.equal(spentDay(cap), 1000n);
    assert.throws(() => cap.reserve(CHAIN, 1000n), CapReached);
  });
});

describe('dedupe: Q2, onMined sees the stored change', () => {
  /** A queue whose onMined hook records the row's stored status and the cap's spend at the moment it runs. */
  function watched() {
    const calls = [];
    const ctx = setup({ dayWei: 1000n, monthWei: 1000n, queueOpts: { onMined: (row) => calls.push({ status: ctx.db.getPending(row.id).status, spent: spentDay(ctx.cap) }) } });
    return { ...ctx, calls };
  }

  test('dedupe Q2: markConfirming stores confirming before onMined runs', async () => {
    const { node, queue, cap, calls } = watched();
    const sent = await queue.enqueue(CHAIN, () => tx(), { reservation: cap.reserve(CHAIN, 1000n) });
    node.state.finalized = 102n;
    node.state.block = 110n;
    node.state.receipts[sent.hash] = inBlock(node, receipt(sent.hash, 50n, 3n, 108n));
    await queue.tick();
    assert.deepEqual(calls, [{ status: 'confirming', spent: 1000n }]);
  });

  test('dedupe Q2 (M57): a replaced send held again is stored, its reservation reopened, before onMined runs', async () => {
    const { db, node, queue, cap, calls } = watched();
    const sent = await queue.enqueue(CHAIN, () => tx(), { reservation: cap.reserve(CHAIN, 1000n) });
    node.state.mined.push({ hash: OTHER, nonce: 5, block: 103n });
    node.state.latest = 6;
    node.state.block = 111n;
    node.state.finalized = 105n;
    await queue.tick();
    assert.equal(db.listPending()[0].status, 'replaced');
    node.state.receipts[sent.hash] = inBlock(node, receipt(sent.hash, 50n, 3n, 108n));
    await queue.tick();
    assert.ok(calls.length >= 1);
    for (const c of calls) {
      assert.notEqual(c.status, 'replaced', 'onMined never runs while the row still reads replaced');
      assert.equal(c.spent, 1000n, 'onMined never runs before the reservation is held again');
    }
  });
});

describe('dedupe: Q2, the re-hold clears every field of the release', () => {
  test('dedupe Q2 (M97): a replaced row that still carries a block hash (an older database) has it cleared when held again', async () => {
    const { db, cap, node, queue } = setup({ dayWei: 1000n, monthWei: 1000n });
    const sent = await queue.enqueue(CHAIN, () => tx(), { reservation: cap.reserve(CHAIN, 1000n) });
    node.state.mined.push({ hash: OTHER, nonce: 5, block: 103n });
    node.state.latest = 6;
    node.state.block = 111n;
    node.state.finalized = 105n;
    await queue.tick();
    const replaced = db.listPending()[0];
    assert.equal(replaced.status, 'replaced');
    // replace() never sets a block hash; a row written by an older relayer can carry one.
    db.updatePending(replaced.id, { ...replaced, minedBlockHash: blockHash(103n) });
    node.state.receipts[sent.hash] = receipt(sent.hash, 50n, 3n, 108n);
    node.state.proofError = (method) => method === 'block';
    await queue.tick();
    const row = db.listPending()[0];
    assert.equal(row.status, 'pending');
    assert.equal(row.minedBlockHash, null);
    assert.equal(spentDay(cap), 1000n);
  });
});

describe('dedupe: rows an operator must look at, and the recheck that only reads the chain', () => {
  /** The MEDIUM's held row: OTHER at 103 finalized, the own hash at 108, held at 1,000 in confirming. */
  async function conflicted(logs) {
    const logger = { info() {}, warn() {}, error: (m) => logs.push(m) };
    const ctx = setup({ dayWei: 1000n, monthWei: 1000n, queueOpts: { logger } });
    const sent = await ctx.queue.enqueue(CHAIN, () => tx(), { reservation: ctx.cap.reserve(CHAIN, 1000n) });
    ctx.node.state.mined.push({ hash: OTHER, nonce: 5, block: 103n });
    ctx.node.state.latest = 6;
    ctx.node.state.block = 110n;
    ctx.node.state.finalized = 102n;
    ctx.node.state.receipts[sent.hash] = inBlock(ctx.node, receipt(sent.hash, 50n, 3n, 108n));
    await ctx.queue.tick();
    ctx.node.state.finalized = 108n;
    return { ...ctx, sent };
  }

  test('dedupe ops: a send held on conflicting evidence logs one line however many passes see it, and is listed with a plain reason', async () => {
    const logs = [];
    const { queue, sent } = await conflicted(logs);
    for (let i = 0; i < 3; i += 1) await queue.tick();
    assert.equal(logs.filter((m) => m.includes('conflicting evidence')).length, 1, logs.join(' / '));
    assert.deepEqual(queue.needsOperator(), [{ hash: sent.hash, chainId: CHAIN, nonce: 5, status: 'confirming', reason: 'the node gave conflicting evidence for this send' }]);
  });

  test('dedupe ops: a stuck send is listed for the operator too', async () => {
    const { db, queue } = setup();
    const sent = await queue.enqueue(CHAIN, () => tx(), {});
    const row = db.listPending()[0];
    db.updatePending(row.id, { ...row, status: 'stuck' });
    assert.deepEqual(queue.needsOperator(), [{ hash: sent.hash, chainId: CHAIN, nonce: 5, status: 'stuck', reason: 'the send has not mined after its fee bumps' }]);
  });

  test('dedupe ops: recheck reads the chain for one send and moves it only on its evidence; an unknown hash is null', async () => {
    const { db, cap, node, queue } = setup({ dayWei: 1000n, monthWei: 1000n });
    const sent = await queue.enqueue(CHAIN, () => tx(), { reservation: cap.reserve(CHAIN, 1000n) });
    const row = db.listPending()[0];
    db.updatePending(row.id, { ...row, status: 'stuck' });
    // Nothing on the chain says what happened: the recheck leaves it as it is.
    assert.equal((await queue.recheck(sent.hash)).status, 'stuck');
    assert.equal(spentDay(cap), 1000n);
    node.state.mined.push({ hash: OTHER, nonce: 5, block: 103n });
    node.state.latest = 6;
    node.state.block = 111n;
    node.state.finalized = 105n;
    assert.equal((await queue.recheck(sent.hash)).status, 'replaced');
    assert.equal(spentDay(cap), 0n);
    assert.equal(await queue.recheck(`0x${'99'.repeat(32)}`), null);
  });

  test('dedupe ops: once the conflicting receipt is gone (reorged), the row leaves the list', async () => {
    const logs = [];
    const { node, queue, sent } = await conflicted(logs);
    await queue.tick();
    assert.equal(queue.needsOperator().length, 1);
    delete node.state.receipts[sent.hash];
    await queue.tick();
    assert.deepEqual(queue.needsOperator().filter((r) => r.reason.includes('conflicting')), []);
  });
});

describe('dedupe: a reorg clears the held reason, and the walk cache floor counts confirming sends', () => {
  test('dedupe ops: a held send that goes back to pending on a reorg no longer carries its held reason', async () => {
    const { db, node, queue, sent } = await (async () => {
      const logger = { info() {}, warn() {}, error() {} };
      const ctx = setup({ dayWei: 1000n, monthWei: 1000n, queueOpts: { logger } });
      const sent = await ctx.queue.enqueue(CHAIN, () => tx(), { reservation: ctx.cap.reserve(CHAIN, 1000n) });
      ctx.node.state.mined.push({ hash: OTHER, nonce: 5, block: 103n });
      ctx.node.state.latest = 6;
      ctx.node.state.block = 110n;
      ctx.node.state.finalized = 102n;
      ctx.node.state.receipts[sent.hash] = inBlock(ctx.node, receipt(sent.hash, 50n, 3n, 108n));
      await ctx.queue.tick();
      ctx.node.state.finalized = 108n;
      await ctx.queue.tick();
      return { ...ctx, sent };
    })();
    assert.equal(db.listPending()[0].heldReason, 'the node gave conflicting evidence for this send');
    delete node.state.receipts[sent.hash];
    await queue.tick();
    const row = db.listPending()[0];
    assert.equal(row.status, 'pending');
    assert.equal(row.heldReason, null);
  });

  test('dedupe walk: a confirming send settles through a walk longer than the kept-blocks limit, over several passes', async () => {
    const { db, cap, node, queue } = setup({ dayWei: 1000n, monthWei: 1000n, queueOpts: { walkBudget: 3, keptBlocks: 2 } });
    const sent = await queue.enqueue(CHAIN, () => tx(), { reservation: cap.reserve(CHAIN, 1000n) });
    node.state.latest = 6;
    node.state.block = 111n;
    node.state.finalized = 102n;
    node.state.receipts[sent.hash] = inBlock(node, receipt(sent.hash, 50n, 3n, 103n));
    await queue.tick();
    assert.equal(db.listPending()[0].status, 'confirming');
    node.state.finalized = 110n;
    for (let i = 0; i < 8 && db.listPending()[0].status !== 'mined'; i += 1) await queue.tick();
    assert.equal(db.listPending()[0].status, 'mined', 'the 7-block walk of a confirming send finished');
  });
});

describe('dedupe: Q5, the nonce is read on the proof client too', () => {
  test('dedupe Q5: a lagging fallback (pending 5) beside the proof endpoint (pending 7): the send takes nonce 7', async () => {
    const { node, queue } = setup({ node: { pending: 5, proofPending: 7 } });
    const sent = await queue.enqueue(CHAIN, () => tx(), {});
    assert.equal(sent.nonce, 7);
    assert.ok(node.state.reads.some((r) => r[0] === 'proof' && r[1] === 'count' && r[2] === 'pending'));
  });

  test('dedupe Q5: a lagging proof endpoint (pending 5) beside the fallback (pending 9): the send takes nonce 9', async () => {
    const { queue } = setup({ node: { pending: 9, proofPending: 5 } });
    const sent = await queue.enqueue(CHAIN, () => tx(), {});
    assert.equal(sent.nonce, 9);
  });
});

describe('dedupe: round-3 Q2 (b), the walk cache is pruned outside the walk, never cleared under it', () => {
  test('dedupe walk: a proof walk longer than the kept-blocks limit finishes over several passes', async () => {
    const { db, cap, node, queue } = setup({ dayWei: 1000n, monthWei: 1000n, queueOpts: { walkBudget: 3, keptBlocks: 2 } });
    await queue.enqueue(CHAIN, () => tx(), { reservation: cap.reserve(CHAIN, 1000n) });
    node.state.mined.push({ hash: OTHER, nonce: 5, block: 103n });
    node.state.latest = 6;
    node.state.block = 111n;
    node.state.finalized = 110n;
    for (let i = 0; i < 6 && db.listPending()[0].status !== 'replaced'; i += 1) await queue.tick();
    assert.equal(db.listPending()[0].status, 'replaced', 'the 7-block walk finished');
    assert.equal(spentDay(cap), 0n);
  });
});
