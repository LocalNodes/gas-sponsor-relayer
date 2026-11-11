// Fix A (25-28, Codex concern 3 and the Argon review): the spend cap holds for fee bumps and for broadcasts whose
// outcome is uncertain, and every reservation lives exactly as long as a broadcast of its send can still mine.
// Real cap, queue, pipeline and server modules over an in-memory database; only the RPC is stubbed.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createWalletClient, custom, defineChain, HttpRequestError, keccak256, parseTransaction, recoverTransactionAddress, serializeTransaction, TimeoutError, TransactionReceiptNotFoundError } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createCap } from '../../src/cap.js';
import { openDb } from '../../src/db.js';
import { createEvents } from '../../src/events.js';
import { bumpFee, createQueue } from '../../src/queue.js';
import { createPipeline } from '../../src/sends/pipeline.js';
import { loadNetworks } from '../../src/config.js';
import { execBody, privateKeyOf, RELAYER_ACCOUNT, SAFE, startStub } from '../helpers/stub.js';
import { blockHash, finalBlocks, listed, refusal, topOf } from '../helpers/node.js';

const ME = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const CHAIN = 11155111;
const NOW = 1_700_000_000_000;
const quiet = { info() {}, warn() {}, error() {} };
const lost = () => new TimeoutError({ body: { method: 'eth_sendRawTransaction' }, url: 'http://rpc.invalid' });
const down = () => new HttpRequestError({ url: 'http://rpc.invalid', details: 'fetch failed' });

const serialize = (tx) => serializeTransaction({
  chainId: CHAIN, type: 'eip1559', to: tx.to, data: tx.data, value: tx.value, gas: tx.gas,
  maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, nonce: tx.nonce,
});

/**
 * A node stub. The wallet client signs, then sends the raw transaction; the same transaction always has the same hash. A transaction the node takes raises its pending count.
 *   refuse        thrown before the node takes the transaction (a definite refusal)
 *   afterAccept   thrown once after the node took it (the answer was lost)
 *   blockError()  true while getBlockNumber should fail
 *   countAt(n)    the confirmed nonce count at block n (default: `latest`)
 *   receiptError  thrown by every receipt lookup (a lookup that failed, not "not found")
 *   hang          the node takes the transaction and never answers (the process stops first)
 */
function fakeChain(o = {}) {
  const s = { latest: 5, pending: 5, block: 100n, receipts: {}, included: [], sent: [], refuse: null, afterAccept: null, hang: false, blockError: () => false, countAt: null, receiptError: null, gas: 100n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n, ...o };
  const signed = new Map();
  const publicClient = {
    async getTransactionCount({ blockTag, blockNumber }) {
      if (blockNumber !== undefined && s.countAt) return s.countAt(BigInt(blockNumber));
      return blockTag === 'pending' ? s.pending : s.latest;
    },
    async getBlockNumber() { if (s.blockError()) throw down(); return s.block; },
    // Every block this fake has used is final (25-28 round 3: a receipt settles at finality).
    getBlock: finalBlocks(() => topOf(s.block, s.receipts), () => s.included),
    async getTransactionReceipt({ hash }) {
      if (s.receiptError) throw s.receiptError;
      const r = s.receipts[hash];
      if (!r) throw new TransactionReceiptNotFoundError({ hash });
      return r;
    },
    async estimateGas() { return s.gas; },
    async estimateFeesPerGas() { return { maxFeePerGas: s.maxFeePerGas, maxPriorityFeePerGas: s.maxPriorityFeePerGas }; },
  };
  const walletClient = {
    async signTransaction(tx) { const raw = serialize(tx); signed.set(raw, tx); return raw; },
    async sendRawTransaction({ serializedTransaction }) {
      if (s.refuse) throw s.refuse;
      const tx = signed.get(serializedTransaction);
      s.sent.push(tx);
      if (tx.nonce >= s.pending) s.pending = tx.nonce + 1;
      if (s.afterAccept) { const e = s.afterAccept; s.afterAccept = null; throw e; }
      if (s.hang) return new Promise(() => {});
      return keccak256(serializedTransaction);
    },
  };
  return { state: s, chains: { get: (id) => (Number(id) === CHAIN ? { publicClient, walletClient } : null) } };
}

function setup({ dayWei = 10n ** 18n, chain: chainOpts = {} } = {}) {
  const db = openDb(':memory:');
  const events = createEvents({ db });
  const cap = createCap({ db, caps: { dayWei, monthWei: 10n ** 19n }, now: () => NOW, events });
  const chain = fakeChain(chainOpts);
  const queue = createQueue({ db, chains: chain.chains, cap, address: ME, logger: quiet, events });
  return { db, events, cap, chain, queue };
}

/** A queue started again over the same database, as after a restart. */
function restart({ db, chain }) {
  const events = createEvents({ db });
  const cap = createCap({ db, caps: { dayWei: 10n ** 18n, monthWei: 10n ** 19n }, now: () => NOW, events });
  return { cap, queue: createQueue({ db, chains: chain.chains, cap, address: ME, logger: quiet, events }) };
}

const tx = (o = {}) => ({ to: ME, data: '0x', value: 0n, gas: 100n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n, ...o });
const spent = (cap) => BigInt(cap.status().spentDayWei);
const maxCost = (t) => t.gas * t.maxFeePerGas + (t.value ?? 0n);
const receipt = (hash, gasUsed = 50n, price = 3n) => ({ gasUsed, effectiveGasPrice: price, status: 'success', transactionHash: hash, blockNumber: 101n, blockHash: blockHash(101n) });
const settle = (p) => p.then((v) => ({ value: v }), (error) => ({ error }));
const allowAll = { check: () => ({ ok: true }) };

describe('fix A: fee bumps stay inside the spend cap', () => {
  test('spend-safety: at a full cap (1000 of 1000 wei reserved) a fee bump is never broadcast; the send stays pending', async () => {
    const { db, cap, chain, queue } = setup({ dayWei: 1000n });
    const reservation = cap.reserve(CHAIN, 1000n);
    await queue.enqueue(CHAIN, () => tx(), { reservation });
    for (let i = 0; i < 4; i += 1) {
      chain.state.block += 12n;
      await queue.tick();
    }
    assert.equal(chain.state.sent.length, 1, 'no replacement went out: its maximum cost (1200 wei) is over the cap');
    assert.equal(spent(cap), 1000n, 'spend never passes the cap');
    const row = db.listPending()[0];
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 0);
    assert.equal(row.hashes.length, 1);
    assert.ok(db.listEvents().some((e) => e.kind === 'cap_reached'), 'the refusal reaches the event feed');
  });

  test('spend-safety: a fee bump extends the reservation to its maximum cost when the cap has room, and waits while it has not', async () => {
    const { db, cap, chain, queue } = setup({ dayWei: 1200n });
    const reservation = cap.reserve(CHAIN, 1000n);
    const other = cap.reserve(CHAIN, 100n);
    await queue.enqueue(CHAIN, () => tx(), { reservation });
    chain.state.block += 12n;
    await queue.tick();
    assert.equal(chain.state.sent.length, 1, '1100 reserved + 200 more for the bump would be 1300 > 1200: no bump');
    assert.equal(spent(cap), 1100n);

    cap.release(other);
    await queue.tick();
    assert.equal(chain.state.sent.length, 2, 'room again: the bump goes out');
    const bumped = chain.state.sent[1];
    assert.equal(bumped.maxFeePerGas, bumpFee(10n));
    assert.equal(spent(cap), maxCost(bumped), 'the reservation now covers the replacement: 100 x 12 = 1200');
    assert.equal(db.listPending()[0].attempts, 1);
    for (const t of chain.state.sent) assert.ok(maxCost(t) <= spent(cap), 'every broadcast is covered by the reservation');
  });
});

describe('fix A: a broadcast whose outcome is uncertain keeps its reservation', () => {
  test('spend-safety: POST /send/safe-exec: a failing block-number read after the node took the send keeps the reservation and the pending row', async () => {
    const networks = loadNetworks();
    let s;
    const block = () => {
      if (s && s.chains.calls.send > 0) throw down();
      return 1000n;
    };
    s = await startStub({ groups: [{ chainId: CHAIN, safe: SAFE, space: 'a.eth' }], chainsOpts: { block } });
    try {
      const res = await s.call('POST', '/send/safe-exec', execBody(networks));
      const rows = s.db.listPending();
      assert.equal(s.chains.calls.send, 1);
      assert.equal(rows.length, 1, 'the live broadcast has a pending row, so a restart can find it');
      assert.equal(BigInt(s.cap.status().spentDayWei), (100000n * 12n / 10n) * 10n ** 9n, 'the reservation is held');
      assert.notEqual(rows[0].spendId, null);
      assert.equal(res.status, 202);
      assert.equal(res.json.hash, rows[0].hash);
    } finally {
      await s.close();
    }
  });

  test('spend-safety: pipeline: a failing block-number read after the node took the send keeps the reservation and the pending row', async () => {
    const { db, cap, chain, queue } = setup({ chain: { blockError: () => chain.state.sent.length > 0 } });
    const pipe = createPipeline({ config: { address: ME }, db, chains: chain.chains, cap, queue, logger: quiet });
    const out = await pipe.send({ chainId: CHAIN, safe: SAFE, to: ME, selectorName: 'addProposal', data: '0x', kind: 'reality-add', list: allowAll });
    assert.equal(chain.state.sent.length, 1);
    assert.equal(db.listPending().length, 1);
    assert.equal(spent(cap), (100n * 12n / 10n) * 10n);
    assert.equal(out.ok, true);
  });

  test('spend-safety: an answer lost in transport (timeout) after the node took the send keeps the reservation and the row', async () => {
    const { db, cap, chain, queue } = setup({ chain: { afterAccept: lost() } });
    const reservation = cap.reserve(CHAIN, 1000n);
    const out = await settle(queue.enqueue(CHAIN, () => tx(), { reservation }));
    assert.equal(out.error, undefined, 'the send may be live, so it is not reported as failed');
    assert.equal(out.value.hash, keccak256(serialize(chain.state.sent[0])));
    assert.equal(db.listPending().length, 1);
    assert.equal(spent(cap), 1000n);
  });

  test('spend-safety: "already known" and "nonce too low" at broadcast keep the reservation and the row', async () => {
    for (const msg of ['already known', 'nonce too low: next nonce 6, tx nonce 5']) {
      const { db, cap, chain, queue } = setup();
      chain.state.afterAccept = Object.assign(new Error('RPC Request failed.'), { name: 'RpcRequestError', details: msg, shortMessage: 'RPC Request failed.' });
      const reservation = cap.reserve(CHAIN, 1000n);
      const out = await settle(queue.enqueue(CHAIN, () => tx(), { reservation }));
      assert.equal(out.error, undefined, msg);
      assert.equal(db.listPending().length, 1, msg);
      assert.equal(spent(cap), 1000n, msg);
    }
  });

  test('spend-safety: a send the node definitely refused gives its reservation back and leaves no row', async () => {
    const { db, cap, chain, queue } = setup({ chain: { refuse: refusal('insufficient funds for gas * price + value') } });
    const pipe = createPipeline({ config: { address: ME }, db, chains: chain.chains, cap, queue, logger: quiet });
    const out = await pipe.send({ chainId: CHAIN, safe: SAFE, to: ME, selectorName: 'addProposal', data: '0x', kind: 'reality-add', list: allowAll });
    assert.equal(out.ok, false);
    assert.equal(out.status, 502);
    assert.equal(db.listPending().length, 0);
    assert.equal(spent(cap), 0n);
  });

  test('spend-safety: pipeline: a failure to record the send after the broadcast keeps the reservation', async () => {
    const { db, cap, chain, queue } = setup();
    db.recordSend = () => { throw new Error('disk full'); };
    const pipe = createPipeline({ config: { address: ME }, db, chains: chain.chains, cap, queue, logger: quiet });
    await settle(pipe.send({ chainId: CHAIN, safe: SAFE, to: ME, selectorName: 'addProposal', data: '0x', kind: 'reality-add', list: allowAll }));
    assert.equal(chain.state.sent.length, 1);
    assert.equal(db.listPending().length, 1);
    assert.equal(spent(cap), (100n * 12n / 10n) * 10n, 'the send is live, so its reservation stays');
  });

  test('spend-safety: POST /send/safe-exec: a failure to record the send after the broadcast keeps the reservation', async () => {
    const networks = loadNetworks();
    const s = await startStub({ groups: [{ chainId: CHAIN, safe: SAFE, space: 'a.eth' }] });
    try {
      s.db.recordSend = () => { throw new Error('disk full'); };
      await s.call('POST', '/send/safe-exec', execBody(networks));
      assert.equal(s.chains.calls.send, 1);
      assert.equal(s.db.listPending().length, 1);
      assert.equal(BigInt(s.cap.status().spentDayWei), (100000n * 12n / 10n) * 10n ** 9n);
    } finally {
      await s.close();
    }
  });
});

describe('fix A: a restart finds a live broadcast', () => {
  test('spend-safety: restart with the send still in the node\'s pool: reconcile finds it, holds the reservation and sends nothing again', async () => {
    const first = setup({ chain: { afterAccept: lost() } });
    const reservation = first.cap.reserve(CHAIN, 1000n);
    const out = await settle(first.queue.enqueue(CHAIN, () => tx(), { reservation }));
    assert.equal(out.error, undefined);
    first.queue.stop();

    const { cap, queue } = restart(first);
    const r = await queue.reconcile();
    assert.deepEqual(r, { mined: 0, replaced: 0, rebroadcast: 0 });
    assert.equal(first.chain.state.sent.length, 1, 'nothing is sent twice');
    assert.equal(first.db.listPending()[0].status, 'pending');
    assert.equal(spent(cap), 1000n, 'the reservation is held across the restart');

    const hash = first.db.listPending()[0].hash;
    first.chain.state.receipts[hash] = listed(first.chain.state.included, receipt(hash));
    first.chain.state.latest = 6;
    await queue.tick();
    assert.equal(first.db.listPending()[0].status, 'mined');
    assert.equal(spent(cap), 150n, 'the real cost replaced the reservation');
  });

  test('spend-safety: restart after the node dropped the send: reconcile broadcasts the identical transaction, never a second one', async () => {
    const first = setup({ chain: { afterAccept: lost() } });
    const reservation = first.cap.reserve(CHAIN, 1000n);
    await settle(first.queue.enqueue(CHAIN, () => tx(), { reservation }));
    first.chain.state.pending = 5; // the node lost it from its pool

    const { cap, queue } = restart(first);
    const r = await queue.reconcile();
    assert.equal(r.rebroadcast, 1);
    const [a, b] = first.chain.state.sent;
    assert.equal(serialize(b), serialize(a), 'the same signed transaction, so the same hash');
    assert.deepEqual(first.db.listPending()[0].hashes, [keccak256(serialize(a))]);
    assert.equal(spent(cap), 1000n);
  });
});

describe('fix A: the reservation lifecycle (Argon review)', () => {
  /** Enqueue one reserved send at nonce 5 (sent at block 100). */
  async function oneSend(o = {}) {
    const ctx = setup(o);
    const reservation = ctx.cap.reserve(CHAIN, 1000n);
    const sent = await ctx.queue.enqueue(CHAIN, () => tx(), { reservation });
    return { ...ctx, sent };
  }

  test('spend-safety: a stuck send keeps its reservation; when one of its own hashes mines, the spend is settled to its real gas', async () => {
    const { db, cap, chain, queue, sent } = await oneSend();
    for (let i = 0; i < 4; i += 1) {
      chain.state.block += 12n;
      await queue.tick();
    }
    const row = db.listPending()[0];
    assert.equal(row.status, 'stuck');
    assert.equal(spent(cap), maxCost(chain.state.sent.at(-1)), 'held at the maximum cost of the last replacement');
    chain.state.receipts[sent.hash] = listed(chain.state.included, receipt(sent.hash));
    chain.state.latest = 6;
    await queue.tick();
    assert.equal(db.listPending()[0].status, 'mined');
    assert.equal(spent(cap), 150n);
  });

  test('spend-safety: when a receipt lookup fails (not "not found"), the send and its reservation are kept', async () => {
    const first = await oneSend();
    first.chain.state.latest = 6;
    first.chain.state.pending = 6;
    first.chain.state.countAt = () => 6;
    first.chain.state.receiptError = lost();
    const { cap, queue } = restart(first);
    const r = await queue.reconcile();
    assert.equal(r.replaced, 0);
    await queue.tick();
    assert.equal(first.db.listPending()[0].status, 'pending');
    assert.equal(spent(cap), 1000n);
  });

  test('spend-safety: an HTTP failure on a receipt lookup is not a "not found", even when its text says Not Found (HTTP 404)', async () => {
    const first = await oneSend();
    first.chain.state.latest = 6;
    first.chain.state.pending = 6;
    first.chain.state.countAt = () => 6;
    first.chain.state.receiptError = new HttpRequestError({ url: 'http://rpc.invalid', status: 404, details: 'Not Found' });
    const { cap, queue } = restart(first);
    assert.equal((await queue.reconcile()).replaced, 0);
    await queue.tick();
    assert.equal(first.db.listPending()[0].status, 'pending');
    assert.equal(spent(cap), 1000n);
  });

  test('spend-safety: a restart while a fee bump was on its way to the node still knows the bumped hash', async () => {
    const { db, chain, queue } = await oneSend();
    chain.state.block += 12n;
    chain.state.hang = true; // the node takes the replacement, then the process stops before the answer
    queue.tick();
    await new Promise((r) => setImmediate(r));
    assert.equal(chain.state.sent.length, 2, 'the replacement reached the node');
    const bumpedHash = keccak256(serialize(chain.state.sent[1]));

    chain.state.hang = false;
    const after = restart({ db, chain });
    chain.state.receipts[bumpedHash] = listed(chain.state.included, receipt(bumpedHash));
    chain.state.latest = 6;
    chain.state.countAt = () => 6;
    await after.queue.tick();
    assert.equal(db.listPending()[0].status, 'mined', 'settled under the bumped hash, not replaced');
    assert.equal(spent(after.cap), 150n);
  });

  // The release rule itself (a nonce taken by another transaction, proven at the finalized block) is in
  // release-proof.test.js (25-28 round 2): it replaced the 12-blocks-deep rule these tests used to hold.
});

describe('fix A: the real viem wallet client signs before it sends', () => {
  test('spend-safety: with a real viem wallet client the stored hash is the hash the node answers, and a resend signs the same bytes', async () => {
    const account = privateKeyToAccount(privateKeyOf(RELAYER_ACCOUNT));
    const chain = defineChain({ id: CHAIN, name: 'test', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['http://rpc.invalid'] } } });
    const raws = [];
    const node = { pending: 5, block: 100n };
    // An in-memory node: no network. It answers eth_sendRawTransaction with the keccak of the bytes, as nodes do.
    const transport = custom({
      async request({ method, params }) {
        if (method === 'eth_chainId') return `0x${CHAIN.toString(16)}`;
        if (method === 'eth_sendRawTransaction') { raws.push(params[0]); return keccak256(params[0]); }
        throw new Error(`unexpected ${method}`);
      },
    });
    const walletClient = createWalletClient({ account, chain, transport });
    const publicClient = {
      async getTransactionCount() { return node.pending; },
      async getBlockNumber() { return node.block; },
      async getTransactionReceipt({ hash }) { throw new TransactionReceiptNotFoundError({ hash }); },
    };
    const db = openDb(':memory:');
    const cap = createCap({ db, caps: { dayWei: 10n ** 18n, monthWei: 10n ** 19n }, now: () => NOW });
    const queue = createQueue({ db, chains: { get: () => ({ publicClient, walletClient }) }, cap, address: account.address, logger: quiet });
    const out = await queue.enqueue(CHAIN, () => tx(), { reservation: cap.reserve(CHAIN, 1000n) });
    assert.equal(raws.length, 1);
    assert.equal(out.hash, keccak256(raws[0]));
    assert.equal(db.listPending()[0].hash, out.hash);
    const parsed = parseTransaction(raws[0]);
    assert.equal(parsed.type, 'eip1559');
    assert.equal(parsed.nonce, 5);
    assert.equal(parsed.chainId, CHAIN);
    assert.equal(parsed.maxFeePerGas, 10n);
    assert.equal(await recoverTransactionAddress({ serializedTransaction: raws[0] }), account.address);

    node.pending = 5; // the node dropped it: reconcile sends it again
    const r = await queue.reconcile();
    assert.equal(r.rebroadcast, 1);
    assert.equal(raws[1], raws[0], 'signing is deterministic: the same transaction, never a second one');
    assert.deepEqual(db.listPending()[0].hashes, [out.hash]);
  });
});
