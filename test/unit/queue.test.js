// The serial nonce queue: ordering, reconcile, fee bumps, alerts (25-05).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createCap } from '../../src/cap.js';
import { openDb } from '../../src/db.js';
import { bumpFee, createQueue } from '../../src/queue.js';
import { rawWallet } from '../helpers/stub.js';
import { blockHash, finalBlocks, listed, refusal, setup as nodeSetup, topOf } from '../helpers/node.js';

const ME = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const CHAIN = 11155111;
const quiet = { info() {}, warn() {}, error() {} };

/** A chain stub with mutable state. `receipts` maps a hash to a receipt; sends are recorded. */
function fakeChain(o = {}) {
  const s = { latest: 5, pending: 5, block: 100n, receipts: {}, included: [], sent: [], failNext: 0, sendError: null, ...o };
  const publicClient = {
    async getTransactionCount({ blockTag }) { return blockTag === 'pending' ? s.pending : s.latest; },
    async getBlockNumber() { return s.block; },
    async getTransactionReceipt({ hash }) { const r = s.receipts[hash]; if (!r) throw new Error('not found'); return r; },
    // Every block this fake has used is final (25-28 round 3: a receipt settles at finality).
    getBlock: finalBlocks(() => topOf(s.block, s.receipts), () => s.included),
  };
  const walletClient = rawWallet((tx, hash) => {
    if (s.failNext > 0) { s.failNext -= 1; throw refusal('insufficient funds for gas * price + value: rejected'); }
    if (s.sendError) throw s.sendError;
    s.sent.push(tx);
    return hash;
  });
  return { state: s, chains: { get: (id) => (id === CHAIN ? { publicClient, walletClient } : null) } };
}

function setup(o = {}) {
  const db = openDb(':memory:');
  const cap = createCap({ db, caps: { dayWei: 10n ** 18n, monthWei: 10n ** 19n }, now: () => 1_700_000_000_000 });
  const chain = fakeChain(o);
  const queue = createQueue({ db, chains: chain.chains, cap, address: ME, logger: quiet });
  return { db, cap, chain, queue };
}
/** A queue over the scriptable node (test/helpers/node.js), for the release proof. */
const proofSetup = (node) => nodeSetup({ node });
const tx = (n = 0) => ({ to: ME, data: '0x', value: 0n, gas: 21000n + BigInt(n), maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 100_000_000n });

describe('queue', () => {
  test('queue: three enqueues issued without awaiting get nonces n, n+1, n+2 in call order', async () => {
    const { chain, queue } = setup({ latest: 7, pending: 7 });
    const jobs = [queue.enqueue(CHAIN, () => tx(0)), queue.enqueue(CHAIN, () => tx(1)), queue.enqueue(CHAIN, () => tx(2))];
    const out = await Promise.all(jobs);
    assert.deepEqual(out.map((o) => o.nonce), [7, 8, 9]);
    assert.deepEqual(chain.state.sent.map((t) => [t.nonce, t.gas]), [[7, 21000n], [8, 21001n], [9, 21002n]]);
  });

  test('queue: an async buildTx still runs in call order', async () => {
    const { chain, queue } = setup();
    const slow = queue.enqueue(CHAIN, async () => { await new Promise((r) => setTimeout(r, 30)); return tx(0); });
    const fast = queue.enqueue(CHAIN, () => tx(1));
    await Promise.all([slow, fast]);
    assert.deepEqual(chain.state.sent.map((t) => t.gas), [21000n, 21001n]);
  });

  test('queue: a send the node rejects does not use up its nonce', async () => {
    const { chain, queue } = setup({ latest: 3, pending: 3 });
    chain.state.failNext = 1;
    await assert.rejects(queue.enqueue(CHAIN, () => tx(0)), (e) => /rejected/.test(e.cause?.details ?? ''));
    const ok = await queue.enqueue(CHAIN, () => tx(1));
    assert.equal(ok.nonce, 3);
    const after = await queue.enqueue(CHAIN, () => tx(2));
    assert.equal(after.nonce, 4, 'consecutive although the node still reports 3');
  });

  test('queue: a restart with two stored sends and a chain count of n+1 marks the first mined and keeps the second', async () => {
    const { db, cap, chain, queue } = setup({ latest: 11, pending: 11 });
    const r1 = cap.reserve(CHAIN, 5000n);
    const r2 = cap.reserve(CHAIN, 5000n);
    const base = { chainId: CHAIN, to: ME, data: '0x', value: 0n, gas: 21000n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n, sentBlock: 90n, kind: 'send' };
    const h1 = `0x${'01'.repeat(32)}`;
    const h2 = `0x${'02'.repeat(32)}`;
    db.insertPending({ ...base, nonce: 10, hash: h1, spendId: r1.id });
    db.insertPending({ ...base, nonce: 11, hash: h2, spendId: r2.id });
    chain.state.receipts[h1] = listed(chain.state.included, { gasUsed: 21000n, effectiveGasPrice: 3n, status: 'success', transactionHash: h1, blockNumber: 101n, blockHash: blockHash(101n) });

    const out = await queue.reconcile();
    assert.deepEqual(out, { mined: 1, replaced: 0, rebroadcast: 1 });
    const rows = db.listPending();
    assert.equal(rows.find((r) => r.nonce === 10).status, 'mined');
    assert.equal(rows.find((r) => r.nonce === 11).status, 'pending');
    assert.equal(chain.state.sent.length, 1, 'the second send is no longer in the node\'s pool, so it goes out again');
    assert.equal(chain.state.sent[0].nonce, 11);
    // The first reservation became the real cost; the second is still the reservation.
    assert.equal(cap.status().spentDayWei, (21000n * 3n + 5000n).toString());
  });

  test('queue: a send overtaken by another transaction with its nonce, in a finalized block, is marked replaced and stored as an audit line', async () => {
    const { db, node, queue } = proofSetup({ latest: 12, pending: 12, base: 10, block: 120n, finalized: 110n, mined: [{ hash: `0x${'04'.repeat(32)}`, nonce: 10, block: 95n }, { hash: `0x${'05'.repeat(32)}`, nonce: 11, block: 96n }] });
    db.insertPending({ chainId: CHAIN, nonce: 10, hash: `0x${'03'.repeat(32)}`, to: ME, data: '0x', value: 0n, gas: 21000n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n, sentBlock: 90n, kind: 'send' });
    const out = await queue.reconcile();
    assert.equal(out.replaced, 1);
    assert.equal(db.listPending()[0].status, 'replaced');
    assert.equal(db.listPending()[0].consumedBy, `0x${'04'.repeat(32)}`);
    assert.equal(db.listEvents()[0].kind, 'send_replaced');
    assert.equal(node.state.sent.length, 0);
  });

  test('queue: the bump of 1000000000 wei is 1125000000 and of 1 wei is 2', () => {
    assert.equal(bumpFee(1_000_000_000n), 1_125_000_000n);
    assert.equal(bumpFee(1n), 2n);
    assert.equal(bumpFee(0n), 1n);
    assert.equal(bumpFee(9n), 11n, 'rounded up: 10.125 -> 11');
    assert.equal(bumpFee(8n), 9n);
  });

  test('queue: a send not mined after 12 blocks is resent with the same nonce and higher fees, 3 times at most, then an alert', async () => {
    const { db, chain, queue } = setup({ latest: 5, pending: 5 });
    const { hash, nonce } = await queue.enqueue(CHAIN, () => tx(0));
    chain.state.block += 11n;
    await queue.tick();
    assert.equal(chain.state.sent.length, 1, '11 blocks: not yet');

    let fee = 1_000_000_000n;
    let tip = 100_000_000n;
    const seen = new Set([hash]);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      chain.state.block += 12n;
      await queue.tick();
      fee = bumpFee(fee);
      tip = bumpFee(tip);
      const last = chain.state.sent.at(-1);
      assert.equal(last.nonce, nonce);
      assert.equal(last.maxFeePerGas, fee);
      assert.equal(last.maxPriorityFeePerGas, tip);
      const row = db.listPending()[0];
      assert.equal(row.attempts, attempt);
      assert.equal(row.status, 'pending');
      seen.add(row.hash);
      assert.equal(row.hashes.length, attempt + 1);
    }
    assert.equal(seen.size, 4);
    assert.equal(db.listEvents().length, 0, 'no alert while bumps remain');

    chain.state.block += 12n;
    await queue.tick();
    assert.equal(chain.state.sent.length, 4, 'a fourth resend never happens');
    assert.equal(db.listPending()[0].status, 'stuck');
    const events = db.listEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'send_stuck');
  });

  test('queue: a receipt under an earlier hash settles the send and records its real cost', async () => {
    const { db, cap, chain, queue } = setup();
    const reservation = cap.reserve(CHAIN, 9999n);
    const { hash } = await queue.enqueue(CHAIN, () => tx(0), { reservation });
    chain.state.block += 12n;
    await queue.tick(); // bumped once: a second hash exists
    chain.state.receipts[hash] = listed(chain.state.included, { gasUsed: 20000n, effectiveGasPrice: 7n, status: 'success', transactionHash: hash, blockNumber: 101n, blockHash: blockHash(101n) });
    await queue.tick();
    assert.equal(db.listPending()[0].status, 'mined');
    assert.equal(cap.status().spentDayWei, '140000');
  });

  test('queue: a reverted receipt still counts: the gas was spent', async () => {
    const { cap, chain, queue } = setup();
    const reservation = cap.reserve(CHAIN, 9999n);
    const { hash } = await queue.enqueue(CHAIN, () => tx(0), { reservation });
    chain.state.receipts[hash] = listed(chain.state.included, { gasUsed: 30000n, effectiveGasPrice: 2n, status: 'reverted', transactionHash: hash, blockNumber: 101n, blockHash: blockHash(101n) });
    await queue.tick();
    assert.equal(cap.status().spentDayWei, '60000');
  });
});
