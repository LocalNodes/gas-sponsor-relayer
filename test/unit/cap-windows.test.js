// 25-28 fix round 2, HIGH 3 (Codex round 2, ruling (a)): an unresolved reservation counts against the current day and
// month windows until it is settled or released, whatever time it was made. Each fee-bump increase is a ledger entry
// of its own, at the time it was checked. A settled send counts from the time it was settled.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CapReached, createCap, DAY_MS } from '../../src/cap.js';
import { openDb } from '../../src/db.js';
import { CHAIN, inBlock, receipt, setup, spentDay, spentMonth, tx } from '../helpers/node.js';

const OCT31 = Date.UTC(2026, 9, 31, 23, 0, 0); // 31 October 2026, 23:00 UTC
const NOV2 = OCT31 + 2 * DAY_MS; // past the day window and the month boundary

function ledger({ dayWei, monthWei, at = OCT31 }) {
  const db = openDb(':memory:');
  const clock = { t: at };
  const cap = createCap({ db, caps: { dayWei, monthWei }, now: () => clock.t });
  return { db, clock, cap };
}

describe('round 2 HIGH 3: unresolved reservations stay in the current windows', () => {
  test('cap-windows: Codex repro: at a 1,200 cap a reservation made before the day and month boundaries still counts after them, so live liability never passes 1,200', () => {
    const { cap, clock } = ledger({ dayWei: 1200n, monthWei: 1200n });
    const old = cap.reserve(CHAIN, 1000n);
    clock.t = NOV2;
    assert.equal(spentDay(cap), 1000n, 'the unresolved reservation counts for today');
    assert.equal(spentMonth(cap), 1000n, 'and for November');
    assert.throws(() => cap.reserve(CHAIN, 1000n), CapReached, '1,000 live + 1,000 more would be 2,000 at a 1,200 cap');
    cap.extend(old.id, 1200n, CHAIN);
    assert.equal(spentDay(cap), 1200n);
    assert.throws(() => cap.reserve(CHAIN, 200n), CapReached, 'the cap is full: 1,200 of live liability');
    assert.equal(spentMonth(cap), 1200n);
  });

  test('cap-windows: a bump increase is checked against the current windows, which hold the old unresolved reservation', () => {
    const { cap, clock } = ledger({ dayWei: 10n ** 9n, monthWei: 1100n });
    const old = cap.reserve(CHAIN, 1000n);
    clock.t = NOV2;
    assert.throws(() => cap.extend(old.id, 1200n, CHAIN), CapReached, '1,000 live in November + 200 > 1,100');
    assert.equal(spentMonth(cap), 1000n, 'a refused extension changes nothing');
    cap.extend(old.id, 1100n, CHAIN);
    assert.equal(spentMonth(cap), 1100n);
  });

  test('cap-windows: each bump increase is its own entry, at the time it was checked; the reservation keeps its own time', () => {
    const { db, cap, clock } = ledger({ dayWei: 10n ** 9n, monthWei: 10n ** 9n });
    const r = cap.reserve(CHAIN, 1000n);
    clock.t = NOV2;
    cap.extend(r.id, 1200n, CHAIN);
    clock.t = NOV2 + 3600_000;
    cap.extend(r.id, 1500n, CHAIN);
    const open = db.openSpend().sort((a, b) => a.id - b.id);
    assert.deepEqual(open.map((e) => [e.wei, e.at]), [[1000n, OCT31], [200n, NOV2], [300n, NOV2 + 3600_000]]);
    assert.equal(spentDay(cap), 1500n);
  });

  test('cap-windows: a send settled after a boundary counts in the window it was settled in, not the one it was reserved in', () => {
    const { cap, clock } = ledger({ dayWei: 10n ** 9n, monthWei: 10n ** 9n });
    const r = cap.reserve(CHAIN, 1000n);
    clock.t = NOV2;
    cap.extend(r.id, 1200n, CHAIN);
    cap.record({ gasUsed: 30n, effectiveGasPrice: 30n }, 0n, r);
    assert.equal(spentMonth(cap), 900n, 'the real cost counts for November, where it was paid');
    assert.equal(spentDay(cap), 900n);
    clock.t = NOV2 + DAY_MS;
    assert.equal(spentDay(cap), 0n, 'then it leaves the day window');
    assert.equal(spentMonth(cap), 900n);
  });

  test('cap-windows: a released reservation and its increases stop counting; a settled cost is never given back', () => {
    const { cap, clock } = ledger({ dayWei: 10n ** 9n, monthWei: 10n ** 9n });
    const r = cap.reserve(CHAIN, 1000n);
    cap.extend(r.id, 1300n, CHAIN);
    cap.release(r);
    assert.equal(spentDay(cap), 0n);
    clock.t = NOV2;
    assert.equal(spentMonth(cap), 0n);
    const s = cap.reserve(CHAIN, 1000n);
    cap.record({ gasUsed: 10n, effectiveGasPrice: 10n }, 0n, s);
    cap.release(s);
    assert.equal(spentDay(cap), 100n, 'release after settlement changes nothing');
  });

  test('cap-windows: only an unresolved reservation can be raised; a released or settled one cannot', () => {
    const { cap } = ledger({ dayWei: 10n ** 9n, monthWei: 10n ** 9n });
    const released = cap.reserve(CHAIN, 1000n);
    cap.release(released);
    assert.throws(() => cap.extend(released.id, 1200n, CHAIN), /reservation_missing/);
    const settled = cap.reserve(CHAIN, 1000n);
    cap.record({ gasUsed: 10n, effectiveGasPrice: 10n }, 0n, settled);
    assert.throws(() => cap.extend(settled.id, 1200n, CHAIN), /reservation_missing/);
    assert.equal(spentDay(cap), 100n);
  });

  test('cap-windows: dayResetsAt comes from settled spend only, never from an old unresolved reservation', () => {
    const { cap, clock } = ledger({ dayWei: 10n ** 9n, monthWei: 10n ** 9n });
    cap.reserve(CHAIN, 1000n);
    clock.t = NOV2;
    assert.equal(cap.status().dayResetsAt, null, 'an unresolved reservation never resets by time');
    cap.record({ gasUsed: 1n, effectiveGasPrice: 1n }, 0n, cap.reserve(CHAIN, 5n));
    assert.equal(cap.status().dayResetsAt, new Date(NOV2 + DAY_MS).toISOString());
  });
});

describe('round 2 HIGH 3: fee bumps across boundaries, through the queue', () => {
  test('cap-windows: a value-bearing send reserved in October and bumped in November: the bump is checked against November with the October reservation in it', async () => {
    // gas 100 x maxFee 10 + value 500 = 1,500 reserved; the bump's maximum is 100 x 12 + 500 = 1,700.
    const clock = { t: OCT31 };
    const tight = setup({ dayWei: 10n ** 9n, monthWei: 1600n, clock });
    const send = tx({ value: 500n });
    await tight.queue.enqueue(CHAIN, () => send, { reservation: tight.cap.reserve(CHAIN, 1500n) });
    clock.t = NOV2;
    tight.node.state.block += 12n;
    await tight.queue.tick();
    assert.equal(tight.node.state.sent.length, 1, 'no bump: 1,500 live in November + 200 more would pass 1,600');
    assert.equal(spentMonth(tight.cap), 1500n);

    const roomy = setup({ dayWei: 10n ** 9n, monthWei: 1700n, clock: { t: OCT31 } });
    await roomy.queue.enqueue(CHAIN, () => send, { reservation: roomy.cap.reserve(CHAIN, 1500n) });
    roomy.clock.t = NOV2;
    roomy.node.state.block += 12n;
    await roomy.queue.tick();
    assert.equal(roomy.node.state.sent.length, 2, 'room: the bump goes out');
    assert.equal(spentMonth(roomy.cap), 1700n, 'November holds the October reservation and the November increase');
    const increase = roomy.db.openSpend().find((e) => e.wei === 200n);
    assert.ok(increase, 'the increase is its own entry');
    assert.equal(increase.at, NOV2, 'charged to November, where it was checked');

    const hash = roomy.db.listPending()[0].hash;
    roomy.node.state.receipts[hash] = inBlock(roomy.node, receipt(hash, 50n, 3n));
    roomy.node.state.latest = 6;
    await roomy.queue.tick();
    assert.equal(spentMonth(roomy.cap), 650n, 'settled: 50 x 3 gas + 500 value, in November');
    assert.equal(spentDay(roomy.cap), 650n);
  });

  test('cap-windows: at boot, an unresolved reservation with no send row (the process stopped before it was stored) is released; one with a row is kept', async () => {
    const { db, cap, queue } = setup();
    const orphan = cap.reserve(CHAIN, 700n);
    const kept = cap.reserve(CHAIN, 1000n);
    await queue.enqueue(CHAIN, () => tx(), { reservation: kept });
    assert.equal(spentDay(cap), 1700n);
    const released = queue.releaseOrphans();
    assert.equal(released, 1);
    assert.equal(spentDay(cap), 1000n);
    assert.equal(db.openSpend().length, 1);
    assert.equal(db.openSpend()[0].id, kept.id);
    assert.ok(orphan.id);
  });
});
