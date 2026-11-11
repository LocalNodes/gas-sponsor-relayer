// Spend caps (D-01, D-19). A compromised Drupal can drain at most the cap, so the cap lives here.
//
// Two windows: a rolling 24 hours and the calendar month in UTC. All amounts are integer wei held
// as BigInt; nothing in this file touches floating point. The ledger is the `spend` table:
//   send    gas (and value) of one sponsored transaction. Starts as a reservation made before
//           the send (gas limit x maxFeePerGas + value) and is replaced by the real cost,
//           gasUsed x effectiveGasPrice + value, when the receipt arrives.
//   bond    a Reality.eth bond. It counts as spend until it is reclaimed.
//   credit  an offset for a reclaimed bond. It carries the bond's own timestamp, so the pair
//           leaves a window together.
// Each entry has a state (25-28 round 2, HIGH 3):
//   open      an unresolved reservation, or a fee-bump increase of one. It counts against the current day AND
//             month windows, whatever its time, until it is settled or released: a live liability never ages out.
//   settled   real spend (or a credit). It counts in the windows its time falls in. A reservation is settled at
//             the time the relayer saw its receipt, so it counts where it was paid.
//   released  given back (nothing went out, or nothing of the send can mine any more). Counted nowhere.
// A fee bump's increase is its own open entry at the time it was checked, pointing at its reservation; settling
// folds it into the real cost. Net spend of a window is settled entries in it plus every open entry, minus credits,
// never below zero.

import { randomUUID } from 'node:crypto';

export const DAY_MS = 86_400_000;
export const DEFAULT_CAP_DAY_WEI = 50_000_000_000_000_000n;
export const DEFAULT_CAP_MONTH_WEI = 500_000_000_000_000_000n;

const WEI_PATTERN = /^(0|[1-9][0-9]*)$/;

/** A send would take spend over a cap. `until` is the ISO time the send could fit again. */
export class CapReached extends Error {
  constructor({ limit, until, monthStartsAt }) {
    super(`spend cap reached (${limit})`);
    this.name = 'CapReached';
    this.limit = limit;
    this.until = until;
    this.monthStartsAt = monthStartsAt;
  }
}

function parseWei(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string' || !WEI_PATTERN.test(raw)) {
    throw new Error(`${name} must be a whole number of wei (digits only), got ${JSON.stringify(String(raw).slice(0, 40))}`);
  }
  return BigInt(raw);
}

/** Caps from the environment. A value that is not a whole number refuses to start. */
export function capsFromEnv(env = process.env) {
  return {
    dayWei: parseWei(env, 'SPONSOR_RELAYER_CAP_DAY_WEI', DEFAULT_CAP_DAY_WEI),
    monthWei: parseWei(env, 'SPONSOR_RELAYER_CAP_MONTH_WEI', DEFAULT_CAP_MONTH_WEI),
  };
}

const iso = (ms) => new Date(ms).toISOString();

/** Start of the UTC calendar month holding `ms`, and of the next one. */
function monthBounds(ms) {
  const d = new Date(ms);
  return {
    start: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1),
    next: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1),
  };
}

const signed = (e) => (e.kind === 'credit' ? -e.wei : e.wei);
const clamp = (n) => (n < 0n ? 0n : n);

/**
 * The spend ledger over a sqlite handle from db.js.
 * `now` returns integer milliseconds and can be replaced in tests.
 * `events` (events.js) receives one cap_reached event per window: after a refusal that names `until`, further refusals
 * of the same limit before that time add nothing (25-08, the feed Drupal turns into organizer alerts).
 */
export function createCap({ db, caps = capsFromEnv({}), now = () => Date.now(), events = null }) {
  const reachedUntil = new Map();
  function window() {
    const t = now();
    const { start, next } = monthBounds(t);
    const dayStart = t - DAY_MS;
    const entries = db.spendSince(Math.min(start, dayStart + 1)).filter((e) => e.at <= t);
    // Day window is (now - 86400 s, now]: an entry exactly 86400 s old is out. Only settled entries are in `day`
    // and `month`; they are the ones that can leave a window.
    const day = entries.filter((e) => e.at > dayStart);
    const month = entries.filter((e) => e.at >= start);
    // Every unresolved reservation counts in both current windows (HIGH 3, ruling (a)).
    const open = db.openSpend().reduce((s, e) => s + e.wei, 0n);
    const sum = (list) => clamp(list.reduce((s, e) => s + signed(e), open));
    return { t, start, next, day, month, spentDay: sum(day), spentMonth: sum(month) };
  }

  /** The first moment `need` wei of settled spend would have left the window, as ms. Null when it never would. */
  function dayFreeAt(list, need) {
    let freed = 0n;
    for (const e of list) {
      freed += signed(e);
      if (freed >= need) return e.at + DAY_MS;
    }
    return null;
  }

  /** Throw CapReached (and store one cap_reached event per window) when `wei` more would pass a cap. */
  function refuseOver(w, chainId, wei) {
    const overDay = w.spentDay + wei > caps.dayWei;
    const overMonth = w.spentMonth + wei > caps.monthWei;
    if (!overDay && !overMonth) return;
    let until = 0;
    let limit = 'day';
    if (overDay) {
      const free = dayFreeAt(w.day, w.spentDay + wei - caps.dayWei);
      until = free === null ? w.t + DAY_MS : free;
    }
    if (overMonth && w.next >= until) {
      until = w.next;
      limit = 'month';
    }
    if (events && !(reachedUntil.get(limit) > w.t)) {
      reachedUntil.set(limit, until);
      try {
        events.add('cap_reached', { chainId, detail: { limit, until: iso(until), monthStartsAt: iso(w.start), refusedWei: wei, spentDayWei: w.spentDay, spentMonthWei: w.spentMonth } });
      } catch {
        // the feed never stops a refusal
      }
    }
    throw new CapReached({ limit, until: iso(until), monthStartsAt: iso(w.start) });
  }

  return {
    caps,

    /**
     * Hold `wei` against both caps before a send. Returns the reservation, or throws CapReached.
     * Spend exactly equal to a cap is allowed; one wei more is not. The check and the insert run
     * in one synchronous step, so two requests cannot both pass on the last of the room.
     */
    reserve(chainId, wei, { kind = 'send', ref = null } = {}) {
      if (typeof wei !== 'bigint' || wei < 0n) throw new TypeError('reserve: wei must be a non-negative bigint');
      const w = window();
      refuseOver(w, chainId, wei);
      const entryRef = ref ?? `${kind}:${randomUUID()}`;
      const id = db.insertSpend({ chainId, at: w.t, wei, kind, ref: entryRef, state: 'open' });
      return { id, chainId, wei, kind, ref: entryRef };
    },

    /**
     * Raise a reservation to `wei` in all before a fee bump (25-28 fix A): the replacement may cost up to its own gas
     * limit x maxFeePerGas + value, more than was reserved. The increase is checked against both current windows,
     * which already hold the unresolved reservation, and stored as its own open entry at this time: it is charged
     * to the window it was checked in (round 2, HIGH 3). Throws CapReached and changes nothing when it does not fit.
     * A reservation already holding `wei` or more is left as it is. Only an unresolved reservation can be raised.
     */
    extend(id, wei, chainId = null) {
      if (typeof wei !== 'bigint' || wei < 0n) throw new TypeError('extend: wei must be a non-negative bigint');
      const entry = db.getSpend(id);
      if (!entry || entry.state !== 'open') throw new Error('reservation_missing');
      const held = db.spendParts(id).reduce((s, e) => s + e.wei, entry.wei);
      if (wei <= held) return { ...entry, wei: held };
      const w = window();
      refuseOver(w, chainId ?? entry.chainId, wei - held);
      db.insertSpend({ chainId: entry.chainId, at: w.t, wei: wei - held, kind: 'send', ref: `${entry.ref}:bump`, state: 'open', parentId: id });
      return { ...entry, wei };
    },

    /**
     * Give an unresolved reservation back, with its increases: no broadcast of the send happened, or none can mine
     * any more (queue.js). Spend already settled from a receipt is never given back.
     */
    release(reservation) {
      if (reservation?.id !== undefined && reservation?.id !== null) db.releaseSpend(reservation.id);
    },

    /**
     * Replace a reservation with the real cost from the receipt: gasUsed x effectiveGasPrice + value, settled now,
     * so it counts in the windows where it was paid. This also undoes a release (a send marked replaced whose own
     * hash mined after all). Without a reservation, a new entry is added (kind and chainId come from `entry`).
     */
    record(receipt, value = 0n, entry = {}) {
      const wei = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice) + BigInt(value);
      if (entry.id !== undefined && entry.id !== null && db.getSpend(entry.id)) {
        db.settleSpend(entry.id, wei, now());
        return { id: entry.id, wei };
      }
      const id = db.insertSpend({ chainId: entry.chainId ?? 0, at: now(), wei, kind: entry.kind ?? 'send', ref: entry.ref ?? `send:${receipt.transactionHash}` });
      return { id, wei };
    },

    /**
     * A bond came back: offset `wei` against the bond entry `ref`, at the bond's own time. Without a bond entry
     * (its send was replaced and the reservation given back, 25-28 fix A) there is nothing to offset: no credit is
     * stored, so a credit can never reduce other spend. Returns the credit's id, or null.
     */
    credit(ref, wei) {
      const bond = db.findSpend(ref, 'bond');
      if (!bond) return null;
      return db.insertSpend({ chainId: bond.chainId, at: bond.at, wei, kind: 'credit', ref });
    },

    /** The readout for GET /status. Wei are decimal strings, times are ISO. */
    status() {
      const w = window();
      // Only settled spend leaves the day window; an unresolved reservation never resets by time.
      const oldest = w.day.find((e) => e.kind !== 'credit');
      return {
        dayWei: caps.dayWei.toString(),
        monthWei: caps.monthWei.toString(),
        spentDayWei: w.spentDay.toString(),
        spentMonthWei: w.spentMonth.toString(),
        dayResetsAt: oldest ? iso(oldest.at + DAY_MS) : null,
        monthResetsAt: iso(w.next),
        monthStartsAt: iso(w.start),
      };
    },
  };
}
