// A scriptable node for the spend-safety tests (25-28 fix round 2). No network: every RPC answer comes from `state`.
//
// The relayer sees a chain through three clients, as src/chain.js builds them:
//   publicClient  ordinary reads; in production a fallback over every RPC URL
//   proofClient   one endpoint: the release proof and the first-broadcast block are read here only
//   walletClient  signs, then broadcasts on that one endpoint, once
// A test can give the two read clients different views of the chain (a lagging receipt index, a conflicting
// endpoint) to check that a release never mixes them.
import {
  HttpRequestError,
  InvalidInputRpcError,
  keccak256,
  RpcRequestError,
  serializeTransaction,
  TimeoutError,
  TransactionReceiptNotFoundError,
} from 'viem';
import { createCap } from '../../src/cap.js';
import { openDb } from '../../src/db.js';
import { createEvents } from '../../src/events.js';
import { createQueue } from '../../src/queue.js';

export const ME = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
export const STRANGER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
export const CHAIN = 11155111;
export const NOW = 1_700_000_000_000;
export const quiet = { info() {}, warn() {}, error() {} };

/** An answer that never arrived. */
export const lost = () => new TimeoutError({ body: { method: 'eth_sendRawTransaction' }, url: 'http://rpc.invalid' });
/** A request that failed in transport. */
export const down = () => new HttpRequestError({ url: 'http://rpc.invalid', details: 'fetch failed' });
/** The node's own JSON-RPC refusal, as viem's http transport raises it for code -32000. */
export const refusal = (message, code = -32000) =>
  new InvalidInputRpcError(new RpcRequestError({ body: { method: 'eth_sendRawTransaction' }, error: { code, message }, url: 'http://rpc.invalid' }));

export const serialize = (tx) => serializeTransaction({
  chainId: CHAIN, type: 'eip1559', to: tx.to, data: tx.data, value: tx.value, gas: tx.gas,
  maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, nonce: tx.nonce,
});
export const hashOf = (tx) => keccak256(serialize(tx));
export const tx = (o = {}) => ({ to: ME, data: '0x', value: 0n, gas: 100n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n, ...o });
export const maxCost = (t) => t.gas * t.maxFeePerGas + (t.value ?? 0n);
/**
 * The hash of block `n` on fork `fork` of the fake chain (fork 0 is the main chain). A hash names its fork and height,
 * so a block read by hash can be answered whatever the node now follows, as a real node keeps side blocks.
 */
export const blockHash = (n, fork = 0) => `0x${fork.toString(16).padStart(2, '0')}${'b1'.repeat(23)}${BigInt(n).toString(16).padStart(16, '0')}`;
const BLOCK_HASH = /^0x([0-9a-f]{2})(?:b1){23}([0-9a-f]{16})$/;
export const receipt = (hash, gasUsed = 50n, price = 3n, blockNumber = 101n, fork = 0) => ({ gasUsed, effectiveGasPrice: price, status: 'success', transactionHash: hash, blockNumber, blockHash: blockHash(blockNumber, fork) });
/**
 * State that the block a receipt names lists the receipt's transaction, on the fake node `node` (round 5). The fake
 * never infers that from a receipt: a receipt alone binds nothing, so every test whose receipt should settle says so
 * here. Returns the receipt, to write `node.state.receipts[h] = inBlock(node, receipt(h))`.
 */
export function inBlock(node, r) {
  const m = BLOCK_HASH.exec(String(r.blockHash).toLowerCase());
  node.state.blockTxs.push({ hash: r.transactionHash, block: BigInt(r.blockNumber), fork: m ? parseInt(m[1], 16) : 0 });
  return r;
}
/**
 * Block reads for a fake chain with no forks on which every block up to `top()` is final: the finalized block, and any
 * block by number or by hash, with hashes and parents that agree (round 3: a receipt settles only from a finalized
 * block on the finalized chain). For the fakes in the older tests, which only ever mine on one chain.
 * `included()` returns [{ hash, block }]: the transactions each block lists. Nothing is inferred from a receipt (dedupe
 * round, Codex round-5 LOW): a test states every inclusion, with `listed(list, receipt)` for a receipt's own.
 */
export function finalBlocks(top, included = () => []) {
  return async ({ blockTag, blockNumber, blockHash: byHash } = {}) => {
    let n;
    if (blockTag === 'finalized' || blockTag === 'latest') n = BigInt(top());
    else if (byHash !== undefined) {
      const m = BLOCK_HASH.exec(String(byHash).toLowerCase());
      if (!m || m[1] !== '00') throw new Error('block not found');
      n = BigInt(`0x${m[2]}`);
    } else n = BigInt(blockNumber);
    const hash = blockHash(n);
    const transactions = (included() ?? [])
      .filter((t) => BigInt(t.block) === n)
      .map((t) => ({ hash: t.hash, blockNumber: n, blockHash: hash }));
    return { number: n, hash, parentHash: blockHash(n - 1n), transactions };
  };
}
/**
 * State that the block a receipt names lists its transaction, for a `finalBlocks` fake: adds { hash, block } to `list`
 * and returns the receipt, to write `receipts[h] = listed(included, receipt)`.
 */
export function listed(list, r) {
  list.push({ hash: r.transactionHash, block: BigInt(r.blockNumber) });
  return r;
}
/** The highest of a head block and the blocks of some receipts: everything a fake has used. */
export const topOf = (head, receipts) => Object.values(receipts).reduce((a, r) => (r?.blockNumber !== undefined && BigInt(r.blockNumber) > a ? BigInt(r.blockNumber) : a), BigInt(head));
export const settle = (p) => p.then((v) => ({ value: v }), (error) => ({ error }));
export const spentDay = (cap) => BigInt(cap.status().spentDayWei);
export const spentMonth = (cap) => BigInt(cap.status().spentMonthWei);

/**
 * state:
 *   me                    the relayer's address (default ME)
 *   latest, pending       the relayer's nonce counts at `latest` and `pending` (publicClient)
 *   block                 the head block number
 *   finalized             the finalized block number on the proof endpoint, or null when it cannot be read. Left
 *                         undefined, every block the test has used is final (the head, and every block of a receipt
 *                         or a mined transaction)
 *   mined                 [{ hash, nonce, block, from?, fork? }]: the relayer's transactions in blocks, as the proof
 *                         endpoint sees them; `fork` (default 0) is the fork whose block holds it
 *   forks                 { [fork]: first height }: side chains; block n of fork f exists from that height on, and its
 *                         parent below it is the main chain's
 *   canon                 the fork reads by number follow, from its first height (default 0, the main chain)
 *   finalizedFork         when set, the fork whose block the finalized read names, whatever `canon` says: an endpoint
 *                         that disagrees with itself (Codex round 3, the two-hash repro)
 *   txBlockHash(t)        when set, the blockHash a transaction object in a block reports
 *   txTamper(t)           when set, changes every transaction object a block lists
 *   byHashTamper(b)       when set, changes a block the proof endpoint answers to a read by hash
 *   base                  the relayer's nonce count before any block in `mined`
 *   receipts              hash -> receipt, as publicClient sees them. A receipt places nothing in a block (round 5):
 *                         its transaction is listed only where `blockTxs` or `mined` says
 *   blockTxs              [{ hash, block, fork?, nonce? }]: transactions listed in a block (fork default 0) without
 *                         moving the nonce counts, as `mined` does; `inBlock(node, receipt)` adds a receipt's own. The
 *                         nonce defaults to the one the wallet signed it with
 *   proofReceipts         hash -> receipt on the proof endpoint (default: `receipts`)
 *   publicMined           when set, publicClient answers block and nonce-at-block reads from this list instead
 *   proofPending          when set, the proof endpoint's `pending` nonce count (default `pending`)
 *   feeError              thrown by estimateFeesPerGas (dedupe round: a pre-broadcast 502)
 *   refuse                thrown at broadcast before the node takes the transaction
 *   afterAccept           thrown once after the node took it (its answer was lost)
 *   defer                 the next broadcast waits until the test calls state.answer(error?) (no error: the node took it)
 *   receiptError          thrown by every publicClient receipt lookup
 *   proofError(method)    true when that proof-endpoint read should fail ('finalized', 'count', 'block', 'blockHash',
 *                         'receipt', 'blockNumber')
 *   countAt(n)            when set, the proof endpoint's nonce count at block n (to make it disagree with `mined`)
 *   blockError()          true while getBlockNumber should fail
 *   read(req)             answers publicClient.readContract
 *   blockGate             a promise publicClient.getBlockNumber waits for (to hold the poll loop mid-pass)
 */
export function fakeNode(o = {}) {
  const s = {
    me: ME, latest: 5, pending: 5, block: 100n, finalized: undefined, mined: [], blockTxs: [], forks: {}, canon: 0, finalizedFork: null, txBlockHash: null, byHashTamper: null, base: 5, receipts: {}, proofReceipts: null, publicMined: null,
    sent: [], refuse: null, afterAccept: null, defer: false, answer: null, receiptError: null,
    proofError: () => false, blockError: () => false, countAt: null, read: null, blockGate: null, gas: 100n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n, reads: [], txTamper: null, ...o,
  };
  const signed = new Map();
  // hash -> nonce of every transaction the wallet signed, for a transaction `blockTxs` lists without one.
  const nonces = new Map();
  // The fork reads by number follow at height n, and the parent of block n on fork f.
  const forkAt = (n) => (s.canon !== 0 && BigInt(n) >= BigInt(s.forks[s.canon]) ? s.canon : 0);
  const parentOf = (f, n) => blockHash(n - 1n, f !== 0 && n - 1n >= BigInt(s.forks[f]) ? f : 0);
  const countAt = (list, n) => list.filter((m) => m.block <= BigInt(n) && (m.fork ?? 0) === forkAt(m.block) && (m.from ?? s.me) === s.me).reduce((c, m) => Math.max(c, m.nonce + 1), s.base);
  const blockAt = (list, n, f) => {
    const number = BigInt(n);
    const hash = blockHash(number, f);
    // Only what the test placed: `mined` (or `publicMined`), and `blockTxs`. Never inferred from a receipt (round 5).
    const listed = s.blockTxs
      .filter((b) => BigInt(b.block) === number && (b.fork ?? 0) === f)
      .map((b) => ({ hash: b.hash, nonce: b.nonce ?? nonces.get(String(b.hash).toLowerCase()), block: number }));
    return {
      number,
      hash,
      parentHash: parentOf(f, number),
      transactions: [...list.filter((m) => m.block === number && (m.fork ?? 0) === f), ...listed].map((m) => {
        let t = { hash: m.hash, from: m.from ?? s.me, nonce: m.nonce, blockNumber: number, blockHash: hash };
        if (s.txBlockHash) t = { ...t, blockHash: s.txBlockHash(t) };
        return s.txTamper ? s.txTamper(t) : t;
      }),
    };
  };
  const blockOf = (list, n) => blockAt(list, n, forkAt(n));
  // Every block the test has used is final, unless the test names the finalized block.
  const finalNumber = () => {
    if (s.finalized !== undefined) return s.finalized;
    const heights = [s.block, ...s.mined.map((m) => m.block), ...Object.values(s.receipts), ...Object.values(s.proofReceipts ?? {})].map((x) => (typeof x === 'bigint' ? x : BigInt(x?.blockNumber ?? 0)));
    return heights.reduce((a, b) => (b > a ? b : a), 0n);
  };
  const findReceipt = (map, hash) => {
    const r = map[hash];
    if (!r) throw new TransactionReceiptNotFoundError({ hash });
    return r;
  };
  const publicClient = {
    async getTransactionCount({ blockTag, blockNumber }) {
      s.reads.push(['public', 'count', blockTag ?? blockNumber]);
      if (blockNumber !== undefined) return countAt(s.publicMined ?? s.mined, blockNumber);
      return blockTag === 'pending' ? s.pending : s.latest;
    },
    async getBlockNumber() {
      s.reads.push(['public', 'blockNumber']);
      if (s.blockGate) await s.blockGate;
      if (s.blockError()) throw down();
      return s.block;
    },
    async getBlock({ blockTag, blockNumber }) {
      s.reads.push(['public', 'block', blockTag ?? blockNumber]);
      if (blockTag === 'finalized') return { number: s.block - 1n, transactions: [] };
      return blockOf(s.publicMined ?? s.mined, blockNumber);
    },
    async getTransactionReceipt({ hash }) {
      s.reads.push(['public', 'receipt', hash]);
      if (s.receiptError) throw s.receiptError;
      return findReceipt(s.receipts, hash);
    },
    async estimateGas() { return s.gas; },
    async estimateFeesPerGas() { if (s.feeError) throw s.feeError; return { maxFeePerGas: s.maxFeePerGas, maxPriorityFeePerGas: s.maxPriorityFeePerGas }; },
    async readContract(req) {
      if (!s.read) throw new Error(`unexpected read ${req.functionName}`);
      return s.read(req);
    },
  };
  const proofClient = {
    async getTransactionCount({ blockTag, blockNumber }) {
      s.reads.push(['proof', 'count', blockTag ?? blockNumber]);
      if (s.proofError('count')) throw down();
      if (blockNumber !== undefined) return s.countAt ? s.countAt(BigInt(blockNumber)) : countAt(s.mined, blockNumber);
      return blockTag === 'pending' ? (s.proofPending ?? s.pending) : s.latest;
    },
    async getBlockNumber() {
      s.reads.push(['proof', 'blockNumber']);
      if (s.blockError() || s.proofError('blockNumber')) throw down();
      return s.block;
    },
    async getBlock({ blockTag, blockNumber, blockHash: byHash }) {
      s.reads.push(['proof', 'block', blockTag ?? blockNumber ?? byHash]);
      if (s.proofError(blockTag === 'finalized' ? 'finalized' : byHash !== undefined ? 'blockHash' : 'block')) throw down();
      if (blockTag === 'finalized') {
        const n = finalNumber();
        if (n === null) throw down();
        const f = s.finalizedFork ?? forkAt(n);
        return { ...blockAt(s.mined, n, f), transactions: [] };
      }
      if (byHash !== undefined) {
        const m = BLOCK_HASH.exec(String(byHash).toLowerCase());
        if (!m) throw new Error('block not found');
        const f = parseInt(m[1], 16);
        const n = BigInt(`0x${m[2]}`);
        if (f !== 0 && (s.forks[f] === undefined || n < BigInt(s.forks[f]))) throw new Error('block not found');
        const b = blockAt(s.mined, n, f);
        return s.byHashTamper ? s.byHashTamper(b) : b;
      }
      if (blockTag === 'latest') return blockOf(s.mined, s.block);
      return blockOf(s.mined, blockNumber);
    },
    async getTransactionReceipt({ hash }) {
      s.reads.push(['proof', 'receipt', hash]);
      if (s.proofError('receipt')) throw down();
      return findReceipt(s.proofReceipts ?? s.receipts, hash);
    },
  };
  const take = (t) => {
    s.sent.push(t);
    if (t.nonce >= s.pending) s.pending = t.nonce + 1;
  };
  const walletClient = {
    async signTransaction(t) {
      const raw = serialize(t);
      signed.set(raw, t);
      nonces.set(keccak256(raw).toLowerCase(), t.nonce);
      return raw;
    },
    async sendRawTransaction({ serializedTransaction }) {
      const t = signed.get(serializedTransaction);
      if (s.defer) {
        s.defer = false;
        return new Promise((resolve, reject) => {
          s.answer = (err) => {
            s.answer = null;
            if (err) return reject(err);
            take(t);
            return resolve(keccak256(serializedTransaction));
          };
        });
      }
      if (s.refuse) throw s.refuse;
      take(t);
      if (s.afterAccept) {
        const e = s.afterAccept;
        s.afterAccept = null;
        throw e;
      }
      return keccak256(serializedTransaction);
    },
  };
  return { state: s, publicClient, proofClient, walletClient, chains: { get: (id) => (Number(id) === CHAIN ? { publicClient, proofClient, walletClient } : null) } };
}

/** Cap, queue and node over one in-memory database. `clock.t` is the cap's time and can be moved. */
export function setup({ dayWei = 10n ** 18n, monthWei = 10n ** 19n, node: nodeOpts = {}, db = openDb(':memory:'), clock = { t: NOW }, queueOpts = {} } = {}) {
  const events = createEvents({ db });
  const cap = createCap({ db, caps: { dayWei, monthWei }, now: () => clock.t, events });
  const node = fakeNode(nodeOpts);
  const queue = createQueue({ db, chains: node.chains, cap, address: ME, logger: quiet, events, ...queueOpts });
  return { db, events, cap, node, queue, clock };
}

/** Let pending promise callbacks run. */
export const flush = () => new Promise((r) => setImmediate(r));
