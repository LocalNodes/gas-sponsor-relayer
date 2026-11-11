// The event store, the GET /events feed, and the events the queue and the cap emit (25-08, D-16).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CapReached, createCap, DAY_MS } from '../../src/cap.js';
import { openDb } from '../../src/db.js';
import { createEvents, EVENT_TYPES, FEED_LIMIT, UnknownEventType } from '../../src/events.js';
import { createQueue } from '../../src/queue.js';
import { rawWallet, startStub } from '../helpers/stub.js';

const CHAIN = 11155111;
const ME = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const SAFE = '0x2222222222222222222222222222222222222222';
const quiet = { info() {}, warn() {}, error() {} };

describe('events', () => {
  test('events: since=0 returns the first 100 in id order with a next cursor, and since=next continues', () => {
    const db = openDb(':memory:');
    const events = createEvents({ db });
    for (let i = 0; i < 150; i += 1) events.add(EVENT_TYPES[i % EVENT_TYPES.length], { chainId: CHAIN, detail: { n: i } });
    const first = events.list(0);
    assert.equal(FEED_LIMIT, 100);
    assert.equal(first.events.length, 100);
    assert.deepEqual(first.events.map((e) => e.id), Array.from({ length: 100 }, (_, i) => i + 1));
    assert.equal(first.next, 100);
    const second = events.list(first.next);
    assert.equal(second.events.length, 50);
    assert.equal(second.events[0].id, 101);
    assert.equal(second.next, 150);
    const empty = events.list(second.next);
    assert.deepEqual(empty, { events: [], next: 150 });
    assert.deepEqual(events.list(7).events.map((e) => e.id).slice(0, 2), [8, 9]);
  });

  test('events: an unknown type is refused at add() and nothing is stored', () => {
    const db = openDb(':memory:');
    const events = createEvents({ db });
    for (const bad of ['reality_bond_lost', 'send_replaced', '', 'ANSWER_CHALLENGED', undefined, null]) {
      assert.throws(() => events.add(bad, { detail: {} }), UnknownEventType, String(bad));
    }
    assert.equal(db.listEvents().length, 0);
    assert.deepEqual([...EVENT_TYPES].sort(), ['answer_challenged', 'cap_reached', 'escalation_needed', 'low_balance', 'resolved', 'send_stuck', 'wrong_final']);
  });

  test('events: an entry is {id, type, chainId, safe, module, questionId, proposalId, detail, at} with the detail as an object, BigInts as strings and at in ISO', () => {
    const db = openDb(':memory:');
    const events = createEvents({ db });
    events.add('answer_challenged', { chainId: CHAIN, safe: SAFE, module: ME, questionId: `0x${'ab'.repeat(32)}`, proposalId: `0x${'cd'.repeat(32)}`, detail: { bondWei: 2n * 10n ** 15n, answer: 'no' } });
    events.add('low_balance', { chainId: CHAIN, detail: { balanceWei: 5n } });
    const [a, b] = events.list(0).events;
    assert.deepEqual(Object.keys(a), ['id', 'type', 'chainId', 'safe', 'module', 'questionId', 'proposalId', 'detail', 'at']);
    assert.equal(a.type, 'answer_challenged');
    assert.equal(a.chainId, CHAIN);
    assert.equal(a.safe, SAFE);
    assert.deepEqual(a.detail, { bondWei: '2000000000000000', answer: 'no' });
    assert.match(a.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(b.safe, null);
    assert.equal(b.questionId, null);
    assert.equal(b.proposalId, null);
  });

  test('events: audit rows (send_replaced, reality_*) stay in the table and are not served by the feed', () => {
    const db = openDb(':memory:');
    const events = createEvents({ db });
    db.insertEvent({ kind: 'send_replaced', chainId: CHAIN, detail: { nonce: 1 } });
    db.insertEvent({ kind: 'reality_bond_lost', chainId: CHAIN, detail: { bondWei: 3n } });
    events.add('resolved', { chainId: CHAIN });
    assert.equal(db.listEvents().length, 3);
    assert.deepEqual(events.list(0).events.map((e) => e.type), ['resolved']);
  });

  test('events: a send still stuck after the third fee bump is a send_stuck event in the feed, naming the Safe', async () => {
    const db = openDb(':memory:');
    const events = createEvents({ db });
    const state = { block: 100n };
    const chains = {
      get: () => ({
        publicClient: {
          async getTransactionCount() { return 5; },
          async getBlockNumber() { return state.block; },
          async getTransactionReceipt() { throw new Error('not found'); },
        },
        walletClient: rawWallet((tx, hash) => hash),
      }),
    };
    const cap = createCap({ db, caps: { dayWei: 10n ** 18n, monthWei: 10n ** 19n } });
    const queue = createQueue({ db, chains, cap, address: ME, logger: quiet, events });
    await queue.enqueue(CHAIN, () => ({ to: ME, data: '0x', value: 0n, gas: 21000n, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 10n ** 8n }), { safe: SAFE, kind: 'safe-exec' });
    for (let i = 0; i < 3; i += 1) {
      state.block += 12n;
      await queue.tick();
      assert.equal(events.list(0).events.length, 0, 'no alert while bumps remain');
    }
    state.block += 12n;
    await queue.tick();
    state.block += 12n;
    await queue.tick();
    const stuck = events.list(0).events;
    assert.equal(stuck.length, 1, 'one alert, not one per tick');
    assert.equal(stuck[0].type, 'send_stuck');
    assert.equal(stuck[0].chainId, CHAIN);
    assert.equal(stuck[0].safe, SAFE);
    assert.equal(stuck[0].detail.attempts, 3);
    assert.equal(stuck[0].detail.nonce, 5);
  });

  test('events: the cap stores cap_reached once per window, and again once the window it named has passed', () => {
    const db = openDb(':memory:');
    const events = createEvents({ db });
    const clock = { t: Date.UTC(2026, 10, 15, 12, 0, 0) };
    const cap = createCap({ db, caps: { dayWei: 1000n, monthWei: 10n ** 9n }, now: () => clock.t, events });
    const firstSpend = cap.reserve(CHAIN, 1000n);
    for (let i = 0; i < 3; i += 1) assert.throws(() => cap.reserve(CHAIN, 1n), CapReached);
    const first = events.list(0).events;
    assert.equal(first.length, 1, 'three refusals in one window are one event');
    assert.equal(first[0].type, 'cap_reached');
    assert.equal(first[0].chainId, CHAIN);
    assert.equal(first[0].detail.limit, 'day');
    assert.equal(first[0].detail.until, new Date(clock.t + DAY_MS).toISOString());

    // The first send mines (it is settled now), then leaves the window a day later; fill it again.
    cap.record({ gasUsed: 1000n, effectiveGasPrice: 1n }, 0n, firstSpend);
    clock.t += DAY_MS;
    cap.reserve(CHAIN, 1000n);
    assert.throws(() => cap.reserve(CHAIN, 1n), CapReached);
    assert.equal(events.list(0).events.length, 2, 'a new window, a new event');

    // The month cap is its own window.
    const month = createCap({ db: openDb(':memory:'), caps: { dayWei: 10n ** 9n, monthWei: 500n }, now: () => clock.t, events });
    month.reserve(CHAIN, 500n);
    assert.throws(() => month.reserve(CHAIN, 1n), CapReached);
    const last = events.list(0).events.at(-1);
    assert.equal(last.detail.limit, 'month');
    assert.equal(events.list(0).events.length, 3);
  });

  test('events: GET /events needs the bearer token, serves what was stored, pages with since, and refuses a bad since', async () => {
    const r = await startStub();
    try {
      for (let i = 0; i < 3; i += 1) r.db.insertEvent({ kind: 'resolved', chainId: CHAIN, questionId: `0x${String(i).repeat(64)}`, detail: { i } });
      r.db.insertEvent({ kind: 'send_replaced', chainId: CHAIN, detail: {} });
      assert.equal((await r.call('GET', '/events', undefined, null)).status, 401);
      assert.equal((await r.call('GET', '/events?since=0', undefined, 'wrong')).status, 401);

      const all = await r.call('GET', '/events');
      assert.equal(all.status, 200);
      assert.deepEqual(all.json.events.map((e) => e.id), [1, 2, 3]);
      assert.equal(all.json.next, 3);
      assert.equal(all.json.events[0].type, 'resolved');

      const rest = await r.call('GET', '/events?since=1');
      assert.deepEqual(rest.json.events.map((e) => e.id), [2, 3]);
      const none = await r.call('GET', '/events?since=3');
      assert.deepEqual(none.json, { events: [], next: 3 });

      for (const bad of ['-1', '1.5', 'abc', '1e3', '99999999999999999']) {
        const res = await r.call('GET', `/events?since=${bad}`);
        assert.equal(res.status, 400, bad);
        assert.equal(res.json.error, 'bad_request');
      }
    } finally {
      await r.close();
    }
  });
});
