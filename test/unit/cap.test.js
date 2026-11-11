// The spend caps at their edges (25-05, D-19): boundary, window, month, bonds, integer math.
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CapReached, capsFromEnv, createCap, DAY_MS } from '../../src/cap.js';
import { loadConfig, loadNetworks } from '../../src/config.js';
import { openDb } from '../../src/db.js';

const T0 = Date.UTC(2026, 10, 15, 12, 0, 0); // 15 November 2026, 12:00 UTC

function setup({ dayWei = 1000n, monthWei = 100000n, at = T0 } = {}) {
  const db = openDb(':memory:');
  const clock = { t: at };
  const cap = createCap({ db, caps: { dayWei, monthWei }, now: () => clock.t });
  return { db, clock, cap };
}

describe('cap', () => {
  test('cap: spend exactly equal to the cap is allowed and one wei more is refused', () => {
    const { cap } = setup({ dayWei: 1000n });
    cap.reserve(1, 600n);
    cap.reserve(1, 400n);
    assert.equal(cap.status().spentDayWei, '1000');
    assert.throws(() => cap.reserve(1, 1n), CapReached);
    assert.equal(cap.status().spentDayWei, '1000', 'a refused reservation leaves no entry');
  });

  test('cap: one wei over from a fresh start is refused, the cap itself is allowed', () => {
    const { cap } = setup({ dayWei: 1000n });
    assert.throws(() => cap.reserve(1, 1001n), CapReached);
    cap.reserve(1, 1000n);
  });

  test('cap: an entry exactly 86400 s old has left the window, one 86399 s old is still inside', () => {
    const { db, cap } = setup({ dayWei: 1000n });
    db.insertSpend({ chainId: 1, at: T0 - DAY_MS, wei: 700n, kind: 'send', ref: 'old' });
    assert.equal(cap.status().spentDayWei, '0');
    cap.reserve(1, 1000n);
    const b = setup({ dayWei: 1000n });
    b.db.insertSpend({ chainId: 1, at: T0 - (DAY_MS - 1000), wei: 700n, kind: 'send', ref: 'inside' });
    assert.equal(b.cap.status().spentDayWei, '700');
    assert.throws(() => b.cap.reserve(1, 301n), CapReached);
    b.cap.reserve(1, 300n);
  });

  test('cap: the 429 until time is when enough old spend has left the window', () => {
    const { db, cap } = setup({ dayWei: 100n });
    db.insertSpend({ chainId: 1, at: T0 - 5 * 3600_000, wei: 60n, kind: 'send', ref: 'a' });
    db.insertSpend({ chainId: 1, at: T0 - 3600_000, wei: 30n, kind: 'send', ref: 'b' });
    // 90 spent; 50 more needs 40 to leave: the first entry (60) is enough.
    try {
      cap.reserve(1, 50n);
      assert.fail('should refuse');
    } catch (e) {
      assert.ok(e instanceof CapReached);
      assert.equal(e.limit, 'day');
      assert.equal(e.until, new Date(T0 - 5 * 3600_000 + DAY_MS).toISOString());
    }
    // 85 needs both entries gone.
    try {
      cap.reserve(1, 95n);
      assert.fail('should refuse');
    } catch (e) {
      assert.equal(e.until, new Date(T0 - 3600_000 + DAY_MS).toISOString());
    }
  });

  test('cap: spend settled on 31 January 23:59 UTC counts for January only', () => {
    const { cap, clock } = setup({ at: Date.UTC(2027, 0, 31, 23, 59, 0), monthWei: 100000n });
    // Settled in January (an unresolved reservation counts against every current window: cap-windows.test.js).
    cap.record({ gasUsed: 777n, effectiveGasPrice: 1n }, 0n, cap.reserve(1, 1000n));
    let s = cap.status();
    assert.equal(s.spentMonthWei, '777');
    assert.equal(s.monthStartsAt, '2027-01-01T00:00:00.000Z');
    assert.equal(s.monthResetsAt, '2027-02-01T00:00:00.000Z');
    clock.t = Date.UTC(2027, 1, 1, 0, 0, 0);
    s = cap.status();
    assert.equal(s.spentMonthWei, '0', 'February starts empty');
    assert.equal(s.spentDayWei, '777', 'it still counts for the rolling day');
    assert.equal(s.monthStartsAt, '2027-02-01T00:00:00.000Z');
    assert.equal(s.monthResetsAt, '2027-03-01T00:00:00.000Z');
  });

  test('cap: a month-cap refusal resets at 00:00 UTC on the 1st and names the month window', () => {
    const { cap } = setup({ dayWei: 10n ** 9n, monthWei: 500n, at: Date.UTC(2026, 11, 20, 8, 0, 0) });
    cap.reserve(1, 500n);
    try {
      cap.reserve(1, 1n);
      assert.fail('should refuse');
    } catch (e) {
      assert.ok(e instanceof CapReached);
      assert.equal(e.limit, 'month');
      assert.equal(e.until, '2027-01-01T00:00:00.000Z');
      assert.equal(e.monthStartsAt, '2026-12-01T00:00:00.000Z');
    }
  });

  test('cap: a bond counts until it is credited, then net spend is as before', () => {
    const { cap } = setup({ dayWei: 10000n });
    cap.reserve(1, 100n);
    const before = cap.status();
    cap.reserve(1, 1000n, { kind: 'bond', ref: 'bond:q1' });
    assert.equal(cap.status().spentDayWei, '1100');
    cap.credit('bond:q1', 1000n);
    const after = cap.status();
    assert.equal(after.spentDayWei, before.spentDayWei);
    assert.equal(after.spentMonthWei, before.spentMonthWei);
  });

  test('cap: a credit carries its bond\'s time, so both leave the day window together', () => {
    const { cap, clock } = setup({ dayWei: 10000n });
    // The bond's send mined at T0 (a credit only ever follows a posted bond).
    cap.record({ gasUsed: 0n, effectiveGasPrice: 1n }, 1000n, cap.reserve(1, 1000n, { kind: 'bond', ref: 'bond:q2' }));
    clock.t = T0 + DAY_MS - 1000;
    cap.credit('bond:q2', 1000n);
    assert.equal(cap.status().spentDayWei, '0');
    clock.t = T0 + DAY_MS + 1000;
    assert.equal(cap.status().spentDayWei, '0', 'no negative balance after the bond left the window');
  });

  test('cap: the receipt replaces the reservation with gasUsed x effectiveGasPrice + value', () => {
    const { cap } = setup();
    const r = cap.reserve(1, 900n);
    cap.record({ gasUsed: 21000n, effectiveGasPrice: 3n }, 5n, r);
    assert.equal(cap.status().spentDayWei, '63005');
  });

  test('cap: a released reservation frees its room', () => {
    const { cap } = setup({ dayWei: 1000n });
    const r = cap.reserve(1, 1000n);
    cap.release(r);
    cap.reserve(1, 1000n);
  });

  test('cap: defaults are 5e16 and 5e17 wei when the env vars are unset', () => {
    assert.deepEqual(capsFromEnv({}), { dayWei: 50000000000000000n, monthWei: 500000000000000000n });
    assert.deepEqual(capsFromEnv({ SPONSOR_RELAYER_CAP_DAY_WEI: '7', SPONSOR_RELAYER_CAP_MONTH_WEI: '9' }), { dayWei: 7n, monthWei: 9n });
    const c = loadConfig({ WEB3_ENABLED: 'true' }, loadNetworks());
    assert.equal(c.caps.dayWei, 50000000000000000n);
    assert.equal(c.caps.monthWei, 500000000000000000n);
  });

  test('cap: a non-numeric cap refuses to start with a message naming the variable', () => {
    for (const bad of ['abc', '1.5', '-1', '1e18', '0x10', ' 5']) {
      assert.throws(() => capsFromEnv({ SPONSOR_RELAYER_CAP_DAY_WEI: bad }), /SPONSOR_RELAYER_CAP_DAY_WEI must be a whole number of wei/, bad);
      assert.throws(() => capsFromEnv({ SPONSOR_RELAYER_CAP_MONTH_WEI: bad }), /SPONSOR_RELAYER_CAP_MONTH_WEI must be a whole number of wei/, bad);
      assert.throws(
        () => loadConfig({ WEB3_ENABLED: 'true', SPONSOR_RELAYER_CAP_DAY_WEI: bad }, loadNetworks()),
        /SPONSOR_RELAYER_CAP_DAY_WEI/,
        `config with ${bad}`,
      );
    }
  });

  test('cap: integer math only, no floating point in cap.js or queue.js', () => {
    for (const f of ['cap.js', 'queue.js']) {
      const src = readFileSync(new URL(`../../src/${f}`, import.meta.url), 'utf8');
      assert.doesNotMatch(src, /parseFloat/, `${f}: parseFloat`);
      assert.doesNotMatch(src, /Math\.round/, `${f}: Math.round`);
      assert.doesNotMatch(src, /(?<![A-Za-z])Number\(/, `${f}: Number( on a wei value`);
      assert.doesNotMatch(src, /(?<![A-Za-z0-9_.])[0-9]+\.[0-9]+(?![A-Za-z0-9_])/, `${f}: decimal literal with a point`);
    }
  });
});
