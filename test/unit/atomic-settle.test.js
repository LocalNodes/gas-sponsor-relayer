// 25-28 round 3, #1 (Codex round 3 HIGH 1): an interrupted settlement must never become uncharged spend.
// - settle() wrote the row's status `mined` and then the real cost to the ledger, as separate writes. A crash or a
//   failed write between them left a mined row with an open reservation, and releaseOrphans() at boot gave that
//   reservation back as if nothing had been sent. Now the status, the ledger change and the event of a settlement
//   (and of a release) are one DB transaction: all of it happens, or none of it.
// - At boot an open reservation is released only when no send row at all holds it. A mined row with an open
//   reservation (from a database written before this fix) is recovered: settled from its receipt, never released.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CapReached, createCap } from '../../src/cap.js';
import { createEvents } from '../../src/events.js';
import { createQueue } from '../../src/queue.js';
import { CHAIN, inBlock, ME, NOW, quiet, receipt, setup, spentDay, tx } from '../helpers/node.js';

const OTHER = `0x${'ab'.repeat(32)}`;

/** A queue and cap started again over the same database and node, as after a restart. */
function restart({ db, node }, caps = { dayWei: 1000n, monthWei: 1000n }) {
  const events = createEvents({ db });
  const cap = createCap({ db, caps, now: () => NOW, events });
  return { cap, queue: createQueue({ db, chains: node.chains, cap, address: ME, logger: quiet, events }) };
}

/** Make db[method] throw once: before it writes, or after (the write is done, then the process fails). */
function crashAt(db, method, { after = false } = {}) {
  const original = db[method];
  let armed = true;
  db[method] = (...args) => {
    if (!armed) return original(...args);
    armed = false;
    if (after) {
      original(...args);
      throw new Error(`crash after ${method}`);
    }
    throw new Error(`crash at ${method}`);
  };
  return () => !armed;
}

/** What a crash must leave alone: the row's status and every ledger entry, as they were before. */
const snapshot = (db) => ({
  rows: db.listPending().map((r) => ({ id: r.id, status: r.status, consumedBy: r.consumedBy })),
  spend: Array.from({ length: 50 }, (_, i) => db.getSpend(i + 1)).filter(Boolean).map((e) => ({ id: e.id, wei: e.wei, state: e.state, at: e.at })),
  events: db.listEvents().map((e) => e.kind),
});

describe('round 3 #1: a settlement is one transaction', () => {
  test('atomic-settle: Codex repro: 1,000 reserved at caps of 1,000, the settlement fails, boot: the real cost is charged and no second 1,000 fits', async () => {
    const ctx = setup({ dayWei: 1000n, monthWei: 1000n });
    const { db, cap, node, queue } = ctx;
    const reservation = cap.reserve(CHAIN, 1000n);
    const sent = await queue.enqueue(CHAIN, () => tx(), { reservation });
    node.state.receipts[sent.hash] = inBlock(node, receipt(sent.hash)); // 50 x 3 = 150 wei
    node.state.latest = 6;
    node.state.pending = 6;
    crashAt(db, 'settleSpend');
    await queue.tick().catch(() => {});

    // Boot.
    const booted = restart(ctx);
    booted.queue.releaseOrphans();
    await booted.queue.reconcile();
    await booted.queue.tick();
    assert.equal(db.listPending()[0].status, 'mined');
    assert.equal(spentDay(booted.cap), 150n, 'the real cost is charged');
    assert.throws(() => booted.cap.reserve(CHAIN, 1000n), CapReached, 'another 1,000 does not fit');
  });

  // Each write of a settlement, a crash at it (before it writes) and right after it (written, then the process fails).
  const crashes = (methods) => methods.flatMap((m) => [[m, {}], [m, { after: true }]]);
  const named = (method, how) => `${how.after ? 'after' : 'at'} ${method}`;

  test('atomic-settle: a crash between any two steps of a settlement leaves nothing half done; the next pass settles it once', async () => {
    // A settlement (round 3, #2: once the receipt's block is final): the row's status, then the ledger (the reservation
    // and its bump increase become the real cost).
    for (const [method, how] of crashes(['updatePending', 'settleSpend'])) {
      const name = named(method, how);
      const { db, cap, node, queue } = setup({ node: { finalized: 90n } });
      const sent = await queue.enqueue(CHAIN, () => tx(), { reservation: cap.reserve(CHAIN, 1000n) });
      // A fee bump: the reservation gets an increase entry, and the send a second hash.
      node.state.block += 12n;
      await queue.tick();
      assert.equal(db.listPending()[0].attempts, 1, name);
      node.state.receipts[sent.hash] = inBlock(node, receipt(sent.hash));
      await queue.tick();
      assert.equal(db.listPending()[0].status, 'confirming', name);
      node.state.finalized = 120n;

      const before = snapshot(db);
      const fired = crashAt(db, method, how);
      await queue.tick().catch(() => {});
      assert.ok(fired(), `${name}: the crash happened`);
      assert.deepEqual(snapshot(db), before, `${name}: nothing of the settlement was kept`);

      await queue.tick();
      assert.equal(db.listPending()[0].status, 'mined', name);
      assert.equal(spentDay(cap), 150n, `${name}: the real cost, once`);
      assert.deepEqual(db.openSpend(), [], `${name}: nothing left open`);
    }
  });

  test('atomic-settle: a crash while a replaced send whose own receipt appeared is held again leaves it as it was; the next pass holds it once', async () => {
    // Marking a replaced send confirming: its reservation and increase are held again, its status, its event.
    for (const [method, how] of crashes(['reopenSpend', 'updatePending', 'insertEvent'])) {
      const name = named(method, how);
      const { db, cap, node, queue } = setup();
      const sent = await queue.enqueue(CHAIN, () => tx(), { reservation: cap.reserve(CHAIN, 1000n) });
      node.state.block += 12n;
      await queue.tick();
      // Marked replaced (proven at the finalized block), then its own first hash shows a receipt after all, not final.
      node.state.mined.push({ hash: OTHER, nonce: 5, block: 103n });
      node.state.latest = 6;
      node.state.finalized = 105n;
      await queue.tick();
      assert.equal(db.listPending()[0].status, 'replaced', name);
      assert.equal(spentDay(cap), 0n, name);
      node.state.receipts[sent.hash] = inBlock(node, receipt(sent.hash, 50n, 3n, 108n));

      const before = snapshot(db);
      const fired = crashAt(db, method, how);
      let mined = 0;
      const hooked = createQueue({ db, chains: node.chains, cap, address: ME, logger: quiet, onMined: () => { mined += 1; } });
      await hooked.tick().catch(() => {});
      assert.ok(fired(), `${name}: the crash happened`);
      assert.deepEqual(snapshot(db), before, `${name}: nothing of it was kept`);
      assert.equal(mined, 0, `${name}: onMined runs only after the change is stored`);

      await hooked.tick();
      assert.equal(db.listPending()[0].status, 'confirming', name);
      assert.equal(spentDay(cap), 1200n, `${name}: the whole raised maximum is held again`);
      assert.equal(db.listEvents().filter((e) => e.kind === 'send_release_reversed').length, 1, name);
      assert.equal(mined, 1, name);
    }
  });

  test('atomic-settle: a crash while a reorged send goes back to pending leaves it confirming with its maximum; the next pass moves it once', async () => {
    for (const [method, how] of crashes(['updatePending', 'insertEvent'])) {
      const name = named(method, how);
      const { db, cap, node, queue } = setup({ node: { finalized: 90n } });
      const sent = await queue.enqueue(CHAIN, () => tx(), { reservation: cap.reserve(CHAIN, 1000n) });
      node.state.receipts[sent.hash] = inBlock(node, receipt(sent.hash));
      await queue.tick();
      assert.equal(db.listPending()[0].status, 'confirming', name);
      delete node.state.receipts[sent.hash];

      const before = snapshot(db);
      const fired = crashAt(db, method, how);
      await queue.tick().catch(() => {});
      assert.ok(fired(), `${name}: the crash happened`);
      assert.deepEqual(snapshot(db), before, `${name}: nothing of it was kept`);

      await queue.tick();
      assert.equal(db.listPending()[0].status, 'pending', name);
      assert.equal(spentDay(cap), 1000n, name);
      assert.equal(db.listEvents().filter((e) => e.kind === 'send_reorged').length, 1, name);
    }
  });
  test('atomic-settle: a crash between the steps of a release leaves the send unresolved with its reservation; the next pass releases it once', async () => {
    const steps = [
      ['updatePending', {}],
      ['updatePending', { after: true }],
      ['releaseSpend', {}],
      ['releaseSpend', { after: true }],
      ['insertEvent', {}],
      ['insertEvent', { after: true }],
    ];
    for (const [method, how] of steps) {
      const name = `${how.after ? 'after' : 'at'} ${method}`;
      const { db, cap, node, queue } = setup();
      await queue.enqueue(CHAIN, () => tx(), { reservation: cap.reserve(CHAIN, 1000n) });
      node.state.mined.push({ hash: OTHER, nonce: 5, block: 103n });
      node.state.latest = 6;
      node.state.block = 111n;
      node.state.finalized = 105n;
      const before = snapshot(db);
      const fired = crashAt(db, method, how);
      await queue.tick().catch(() => {});
      assert.ok(fired(), `${name}: the crash happened`);
      assert.deepEqual(snapshot(db), before, `${name}: nothing of the release was kept`);
      assert.equal(spentDay(cap), 1000n, name);

      await queue.tick();
      assert.equal(db.listPending()[0].status, 'replaced', name);
      assert.equal(spentDay(cap), 0n, name);
      assert.equal(db.listEvents().filter((e) => e.kind === 'send_replaced').length, 1, name);
    }
  });
});

describe('round 3 #1: boot recovers, never releases, a reservation a send row holds', () => {
  /** A row in `status` whose reservation of 1,000 wei is still open, as an older database or a crash could leave it. */
  async function leftOver(status) {
    const ctx = setup({ dayWei: 1000n, monthWei: 1000n });
    const { db, cap, queue } = ctx;
    const sent = await queue.enqueue(CHAIN, () => tx(), { reservation: cap.reserve(CHAIN, 1000n) });
    const row = db.listPending()[0];
    db.updatePending(row.id, { ...row, status, consumedBy: status === 'mined' ? sent.hash : status === 'replaced' ? OTHER : null, consumedBlock: status === 'pending' ? null : 101n });
    return { ...ctx, sent };
  }

  test('atomic-settle: releaseOrphans gives back only a reservation no send row holds, whatever the row\'s status', async () => {
    for (const status of ['pending', 'stuck', 'mined', 'replaced']) {
      const ctx = await leftOver(status);
      const { queue } = restart(ctx);
      assert.equal(queue.releaseOrphans(), 0, status);
      assert.equal(ctx.db.openSpend().length, 1, `${status}: the reservation is kept`);
    }
    const ctx = setup();
    ctx.cap.reserve(CHAIN, 7n);
    const { queue } = restart(ctx);
    assert.equal(queue.releaseOrphans(), 1, 'a reservation with no row is given back');
    assert.deepEqual(ctx.db.openSpend(), []);
  });

  test('atomic-settle: at boot a mined row with an open reservation is settled from its receipt', async () => {
    const ctx = await leftOver('mined');
    ctx.node.state.receipts[ctx.sent.hash] = inBlock(ctx.node, receipt(ctx.sent.hash));
    ctx.node.state.latest = 6;
    ctx.node.state.pending = 6;
    const booted = restart(ctx);
    booted.queue.releaseOrphans();
    await booted.queue.reconcile();
    await booted.queue.tick();
    assert.equal(ctx.db.listPending()[0].status, 'mined');
    assert.equal(spentDay(booted.cap), 150n);
    assert.deepEqual(ctx.db.openSpend(), []);
  });

  test('atomic-settle: at boot a mined row with an open reservation whose receipt is not readable keeps the whole reservation', async () => {
    const ctx = await leftOver('mined');
    ctx.node.state.latest = 6;
    ctx.node.state.pending = 6;
    const booted = restart(ctx);
    booted.queue.releaseOrphans();
    await booted.queue.reconcile();
    await booted.queue.tick();
    assert.notEqual(ctx.db.listPending()[0].status, 'replaced');
    assert.equal(spentDay(booted.cap), 1000n);
  });

  test('atomic-settle: at boot a replaced row with an open reservation goes back to the proof, and is released only by it', async () => {
    const ctx = await leftOver('replaced');
    ctx.node.state.latest = 6;
    ctx.node.state.pending = 6;
    const booted = restart(ctx);
    booted.queue.releaseOrphans();
    await booted.queue.reconcile();
    assert.equal(spentDay(booted.cap), 1000n, 'no proof yet: held');
    ctx.node.state.mined.push({ hash: OTHER, nonce: 5, block: 103n });
    ctx.node.state.block = 111n;
    ctx.node.state.finalized = 105n;
    await booted.queue.tick();
    assert.equal(ctx.db.listPending()[0].status, 'replaced');
    assert.equal(spentDay(booted.cap), 0n);
  });
});
