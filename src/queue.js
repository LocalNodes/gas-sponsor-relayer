// One serial send queue per chain (D-01, RESEARCH Pattern 5 "Nonce").
//
// The queue owns the nonce: it hands them out in request order, one send at a time per chain, and
// passes the nonce and both fees explicitly to the wallet client. Every send is stored in the
// `pending` table. A poll loop looks for receipts, records the real cost in the cap ledger and
// resends a stuck send with the same nonce and fees raised by 9/8 (the nodes' minimum bump for a
// replacement is 10%), at most three times; after that an alert event is stored.
// Fees are BigInt wei throughout. `onMined(row, receipt)` is called once for each send that mines.
//
// Spend safety (25-28 fix A and round 2). A broadcast never exists without a `pending` row and a held reservation:
// - Every read happens before the broadcast. The transaction is signed first and its row, with its hash,
//   is stored before it goes to the node, so a restart always finds a send that may be live.
// - The broadcast goes to one endpoint, once (chain.js). Only that node's exact refusal (broadcastOutcome) means
//   nothing went out: the row is deleted and enqueue rejects, so the caller gives the reservation back.
//   Anything else (a lost answer, "already known", "nonce too low", an error not recognised) keeps the row and
//   the reservation; the poll loop and reconcile resolve it.
// - One broadcast at a time per send: while one is on its way, the row is not bumped, resent or resolved, and
//   an older broadcast's answer never deletes newer state of the row.
// - A fee bump first extends the reservation to the replacement's maximum cost (gas limit x
//   maxFeePerGas + value). When the cap has no room, nothing is sent and the send waits as it is.
// - A receipt of one of the send's own hashes makes it `confirming` (25-28 round 3, #2): its whole reservation stays
//   held, it is never bumped or rebroadcast, and every pass reads its receipt and the block at that height again on
//   the proof endpoint. When the receipt is gone or another block holds that height, it goes back to pending, its
//   maximum still held. Once the finalized block is at or past the receipt's block and that block is on the
//   finalized chain (parent hashes followed down from the pinned finalized block), the send is settled: the real
//   cost from that receipt replaces the reservation.
// - Settling, releasing, marking confirming and going back on a reorg are each one DB transaction (round 3, #1).
// - A reservation is given back for a send that went out only with proof that it never can mine (`consumer`):
//   on the proof endpoint alone and in one pass, the relayer's nonce count at the `finalized` block is past the
//   send's nonce, and the relayer's transaction with that nonce, found in a block from the send's first
//   broadcast block to `finalized`, is none of the send's own hashes. That block is bound to the finalized chain
//   (25-28 round 3, #3): the finalized block's hash is pinned, parent hashes followed down from it must arrive at
//   the consuming block's hash, and the transaction (and, on our own hash, its receipt) must name that block. The
//   send is marked `replaced` with that hash. A read that fails or disagrees, or a walk not finished in the pass,
//   leaves the send unresolved, its reservation held.
// - A `replaced` send is still looked up under its own hashes; a late receipt holds its whole reservation again and
//   makes it confirming, so the real cost is settled at finality.
// - A `stuck` send stays in reconcile and resolves only as above, from the chain.

import { keccak256 } from 'viem';
import { CapReached } from './cap.js';
import { createEvents } from './events.js';

export const BUMP_AFTER_BLOCKS = 12n;
export const MAX_BUMPS = 3;
export const DEFAULT_POLL_MS = 6000;
// Blocks read by hash per chain in one pass, to walk from the finalized block down to a block a proof names. The walk
// goes on in the next pass from where it stopped: a block read by hash never changes, so it is kept.
export const WALK_BUDGET = 256;
const KEPT_BLOCKS = 50_000;

/** Raise a fee by one eighth, rounded up, and by at least 1 wei. */
export function bumpFee(fee) {
  const up = (fee * 1125n + 999n) / 1000n;
  return up > fee ? up : fee + 1n;
}

const KNOWN = /already known|known transaction|already imported/i;
// The node's own refusals of a raw transaction, in the exact words geth-family nodes use. Only these, answered as a
// JSON-RPC error by the one endpoint the broadcast went to, mean nothing went out (25-28 round 2, HIGH 1).
// "nonce too low" is not one: the nonce may have been taken by this very send.
const REFUSALS = [
  /^insufficient funds for gas \* price \+ value/i,
  /^intrinsic gas too low/i,
  /^exceeds block gas limit/i,
  /^transaction underpriced/i,
  /^replacement transaction underpriced/i,
  /^max priority fee per gas higher than max fee per gas/i,
  /^max fee per gas less than block base fee/i,
  /^nonce too high/i,
  /^invalid sender/i,
  /^oversized data/i,
  /^txpool is full/i,
];
// The JSON-RPC code geth-family nodes give a refused transaction (viem: InvalidInputRpcError).
const REFUSAL_CODE = -32000;
// viem's errors for a request whose answer never arrived or could not be read.
const TRANSPORT = new Set(['HttpRequestError', 'TimeoutError', 'SocketClosedError', 'WebSocketRequestError']);

const causes = (e) => {
  const out = [];
  for (let c = e; c && out.length < 16; c = c.cause) out.push(c);
  return out;
};
const text = (e) => `${e?.shortMessage ?? ''} ${e?.details ?? ''} ${e?.message ?? ''}`;

/**
 * What a failed broadcast means. 'accepted': the node already holds this very transaction. 'refused': the node
 * answered no, in one of the exact known refusals above, as its own JSON-RPC error (an RpcRequestError with code
 * -32000): nothing went out. 'uncertain': anything else, including a lost or unreadable answer, "nonce too low", an
 * error not recognised here, or a refusal in other words: the send may be live, so its row and reservation stay.
 */
export function broadcastOutcome(e) {
  const list = causes(e);
  if (list.some((x) => KNOWN.test(text(x)))) return 'accepted';
  const answer = list.find((x) => x?.name === 'RpcRequestError' && x.code === REFUSAL_CODE);
  if (answer && REFUSALS.some((r) => r.test(String(answer.details ?? '').trim()))) return 'refused';
  return 'uncertain';
}

/** True when a receipt lookup said "no such receipt", false when the lookup itself failed. */
function receiptMissing(e) {
  const list = causes(e);
  if (list.some((x) => TRANSPORT.has(x?.name))) return false;
  return list.some((x) => x?.name === 'TransactionReceiptNotFoundError' || /could not be found|not found/i.test(text(x)));
}

/** The plain reasons an operator sees (needsOperator). */
export const HELD_CONFLICT = 'the node gave conflicting evidence for this send';
export const HELD_STUCK = 'the send has not mined after its fee bumps';

export function createQueue({
  db,
  chains,
  cap,
  address,
  logger = console,
  bumpAfterBlocks = BUMP_AFTER_BLOCKS,
  maxBumps = MAX_BUMPS,
  pollMs = DEFAULT_POLL_MS,
  onMined = null,
  events = createEvents({ db }),
  walkBudget = WALK_BUDGET,
  keptBlocks = KEPT_BLOCKS,
}) {
  const tails = new Map();
  // Per chain: hash -> { number, parentHash } of every block read by hash. A block's contents never change under its
  // hash, so what was read once is good for every later walk.
  const knownBlocks = new Map();
  // Rows with a broadcast on its way (the first one or a replacement). Nothing else is sent for such a row, and the
  // poll loop and reconcile leave it alone until the answer is in (25-28 round 2, HIGH 2).
  const busy = new Set();
  let timer = null;
  let ticking = false;

  /** Run `fn` holding the row: null, without running it, when another broadcast of the row is on its way. */
  async function holding(id, fn) {
    if (busy.has(id)) return null;
    busy.add(id);
    try {
      return await fn();
    } finally {
      busy.delete(id);
    }
  }

  /** The one endpoint the release proof reads (chain.js); a test stub may only have the public client. */
  const readerOf = (clients) => clients.proofClient ?? clients.publicClient;
  const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

  /** Sign without sending: the hash is known before the node sees the transaction. */
  async function sign(walletClient, f) {
    return walletClient.signTransaction({
      to: f.to, data: f.data, value: f.value, gas: f.gas,
      maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas, nonce: f.nonce, type: 'eip1559',
    });
  }

  async function sendNext(chainId, buildTx, meta) {
    const clients = chains.get(chainId);
    if (!clients?.walletClient) throw new Error('chain_not_available');
    // A chain the relayer does not sponsor (chain.js): nothing is built, signed or sent (25-28 round 3, #4).
    if (clients.sponsored === false) throw new Error('chain_not_sponsored');
    // A request that repeats a send already pending, stuck, confirming or mined (25-28 dedupe): nothing is built, signed,
    // stored or sent, and the caller gets the existing send's current hash. This runs under the chain's serialisation, so
    // two concurrent requests cannot both pass it. A replaced send never happened and is no duplicate.
    if (meta.dedupeKey) {
      const existing = db.findDuplicate(chainId, meta.dedupeKey);
      if (existing) return { hash: existing.hash, nonce: existing.nonce, duplicate: true };
    }
    const tx = await buildTx();
    // Every read and the signature come before the broadcast: once the node may hold the send, nothing may fail
    // before its row is stored, or a caller would give back the reservation of a live send.
    // The first broadcast block is read on the proof endpoint before the nonce: no transaction can take the nonce
    // in an earlier block, so the release proof searches from here.
    const sentBlock = await readerOf(clients).getBlockNumber({ cacheTime: 0 });
    // The pending count on the proof endpoint and on the fallback both (25-28 dedupe, round-2 Q5): the higher wins, so
    // one lagging endpoint cannot hand out a nonce already used.
    const counts = await Promise.all([readerOf(clients), clients.publicClient].map((c) => c.getTransactionCount({ address, blockTag: 'pending' })));
    const chainPending = Math.max(...counts.map(Number));
    const waiting = db.maxPendingNonce(chainId);
    // The node may lag behind sends it has accepted; never reuse a nonce that still waits for a receipt.
    const nonce = waiting === null ? chainPending : Math.max(chainPending, waiting + 1);
    const fields = {
      to: tx.to,
      data: tx.data ?? '0x',
      value: tx.value ?? 0n,
      gas: tx.gas,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      nonce,
    };
    const serializedTransaction = await sign(clients.walletClient, fields);
    const hash = keccak256(serializedTransaction);
    const id = db.insertPending({
      chainId,
      ...fields,
      hash,
      sentBlock,
      firstBlock: sentBlock,
      spendId: meta.reservation?.id ?? null,
      safe: meta.safe ?? null,
      kind: meta.kind ?? 'send',
      dedupeKey: meta.dedupeKey ?? null,
    });
    // Held from the insert on (no await between), so the poll loop never sees this row without the hold.
    busy.add(id);
    try {
      await clients.walletClient.sendRawTransaction({ serializedTransaction });
    } catch (e) {
      const outcome = broadcastOutcome(e);
      // A refusal of this one broadcast deletes the row only while the row is still just this broadcast.
      if (outcome === 'refused' && db.deleteUntouchedPending(id, hash)) throw e;
      logger.warn(`send of nonce ${nonce} on ${chainId}: the node's answer was ${outcome === 'accepted' ? '"already known"' : outcome === 'refused' ? 'a refusal, but the send has newer broadcasts' : 'lost or unclear'}; kept as pending (${e.shortMessage ?? e.name})`);
    } finally {
      busy.delete(id);
    }
    return { hash, nonce };
  }

  /**
   * The first receipt found among every hash this send has had, with the hash it was asked for. `unclear` when a
   * lookup failed. A receipt of another transaction than the hash asked for is no answer (25-28 round 4, HIGH 1).
   */
  async function findReceipt(publicClient, row) {
    let unclear = false;
    for (const hash of [...row.hashes].reverse()) {
      try {
        const receipt = await publicClient.getTransactionReceipt({ hash });
        if (receipt && same(receipt.transactionHash, hash)) return { receipt, hash, unclear: false };
        if (receipt) unclear = true;
      } catch (e) {
        if (!receiptMissing(e)) unclear = true;
      }
    }
    return { receipt: null, hash: null, unclear };
  }

  /** Tell the owner of the queue what mined (groups.js drops a Safe's module cache here), once it is stored. */
  function notify(row, receipt) {
    try {
      onMined?.(row, receipt);
    } catch (e) {
      logger.warn(`onMined hook failed: ${e?.name ?? 'Error'}`);
    }
  }

  /**
   * Settle a send whose own receipt is in a finalized block on the finalized chain: its reservation becomes the real
   * cost. The status, the ledger and the block are one transaction (25-28 round 3, #1): a crash or a failed write
   * anywhere in it leaves the send as it was, its reservation open, for the next pass. Never a mined row with an
   * open reservation, which boot would otherwise take for an orphan.
   */
  function settle(row, receipt) {
    db.atomically(() => {
      db.updatePending(row.id, { ...row, status: 'mined', consumedBy: receipt.transactionHash ?? null, consumedBlock: receipt.blockNumber ?? null, minedBlockHash: receipt.blockHash ?? null });
      // A ledger entry's kind is send, bond or credit, never the send's own kind (safe-exec, reality-add, ...).
      if (row.spendId !== null) cap.record(receipt, BigInt(row.value), { id: row.spendId, chainId: row.chainId });
      else cap.record(receipt, BigInt(row.value), { chainId: row.chainId });
    });
    // A send that was confirming has already told the owner, when its receipt was first seen.
    if (row.status !== 'confirming') notify(row, receipt);
  }

  /**
   * One of the send's own hashes has a receipt bound to its block, not final yet (25-28 round 3, #2): the send is
   * confirming. Its whole reservation stays held until the receipt's block is finalized. A send marked replaced never
   * gets here as such: seen() holds its reservation again first (25-28 round 5). Returns the row as stored.
   */
  function markConfirming(row, receipt) {
    db.atomically(() => {
      db.updatePending(row.id, { ...row, status: 'confirming', consumedBy: receipt.transactionHash, consumedBlock: BigInt(receipt.blockNumber), minedBlockHash: receipt.blockHash.toLowerCase() });
    });
    notify(row, receipt);
    return db.getPending(row.id);
  }

  /**
   * The block of a confirming send's receipt is no longer the chain's (the receipt is gone, or names another block, or
   * another block holds that height): the send waits again, its maximum still reserved. The bump timer restarts at
   * `head`, so a send that may still be in the pool is not bumped at once.
   */
  function reorged(row, why, head) {
    db.atomically(() => {
      db.updatePending(row.id, { ...row, status: 'pending', consumedBy: null, consumedBlock: null, minedBlockHash: null, sentBlock: head ?? row.sentBlock });
      if (row.heldReason) db.setHeldReason(row.id, null);
      db.insertEvent({ kind: 'send_reorged', chainId: row.chainId, detail: { nonce: row.nonce, hash: row.consumedBy, block: row.consumedBlock, blockHash: row.minedBlockHash, why } });
    });
    logger.warn(`send on ${row.chainId}: nonce ${row.nonce}, its receipt's block ${row.consumedBlock} is no longer the chain's (${why}); it waits again with its reservation`);
    return 'reorged';
  }

  /** Proven: another transaction took this send's nonce in a finalized block, so no broadcast of it can mine. */
  function replace(row, proof) {
    // One transaction, like a settlement (25-28 round 3, #1): replaced and released together, or neither.
    db.atomically(() => {
      db.updatePending(row.id, { ...row, status: 'replaced', consumedBy: proof.hash, consumedBlock: proof.block });
      if (row.spendId !== null) cap.release({ id: row.spendId });
      db.insertEvent({ kind: 'send_replaced', chainId: row.chainId, detail: { nonce: row.nonce, hash: row.hash, consumedBy: proof.hash, block: proof.block } });
    });
    logger.warn(`send replaced on ${row.chainId}: nonce ${row.nonce} was taken by ${proof.hash} at finalized block ${proof.block}; its reservation is given back`);
  }

  /**
   * One pass of the release proof on one chain: every read on the proof endpoint, the finalized block read once.
   * `consumer(row)` returns { hash, block, own, receipt? } for the relayer's transaction that took the row's nonce,
   * or null when that is not proven (not finalized yet, a read failed, or the reads disagree).
   */
  function proofPass(clients, chainId) {
    const reader = readerOf(clients);
    const key = String(chainId);
    let blocks = knownBlocks.get(key);
    if (!blocks) {
      blocks = new Map();
      knownBlocks.set(key, blocks);
    } else if (blocks.size > keptBlocks) {
      // Pruned outside the walks, never cleared under one (25-28 dedupe, round-3 Q2 (b)): a walk runs from the
      // finalized block down to a send's first broadcast block or its receipt's block, so no walk reaches below the
      // lowest such height of the sends still unresolved on this chain. Only blocks below it go.
      let floor = null;
      for (const r of db.listPending()) {
        if (String(r.chainId) !== key || !(r.status === 'pending' || r.status === 'stuck' || r.status === 'confirming')) continue;
        for (const h of [r.firstBlock, r.consumedBlock]) {
          if (h === null || h === undefined) continue;
          const n = BigInt(h);
          if (floor === null || n < floor) floor = n;
        }
      }
      for (const [hash, b] of blocks) if (floor === null || b.number <= floor) blocks.delete(hash);
    }
    let walked = 0;
    const counts = new Map();
    let head;
    const countAt = (n) => {
      if (!counts.has(n)) counts.set(n, reader.getTransactionCount({ address, blockNumber: n }).then((c) => BigInt(c)));
      return counts.get(n);
    };
    // The finalized block, read once per pass, its hash pinned: every proof of this pass is checked against it.
    const finalized = () => {
      head ??= (async () => {
        const block = await reader.getBlock({ blockTag: 'finalized' });
        if (typeof block?.hash !== 'string') throw new Error('finalized_block_without_hash');
        const number = BigInt(block.number);
        return { number, hash: block.hash.toLowerCase(), count: await countAt(number) };
      })();
      return head;
    };
    /** The parent hash of block `hash`, which must be at height `number`; read by hash once, then kept. */
    async function parentOf(hash, number) {
      let b = blocks.get(hash);
      if (!b) {
        if (walked >= walkBudget) throw new Error('walk_budget');
        walked += 1;
        const block = await reader.getBlock({ blockHash: hash });
        if (!same(block?.hash, hash) || typeof block.parentHash !== 'string') throw new Error('block_by_hash');
        b = { number: BigInt(block.number), parentHash: block.parentHash.toLowerCase() };
        // Kept only at the height expected: a wrong answer is read again next pass (25-28 round 4, MEDIUM 4).
        if (b.number === number) blocks.set(hash, b);
      }
      if (b.number !== number) throw new Error('block_height');
      return b.parentHash;
    }
    /**
     * True when block `hash` at height `number` is the pinned finalized block or one of its ancestors, false when the
     * finalized chain has another block at that height: parent hashes are followed down from the finalized block.
     * Throws when a read fails, when this pass's walk budget runs out, or when the height is past finalized.
     */
    async function onFinalChain(number, hash) {
      const f = await finalized();
      if (number > f.number) throw new Error('not_final');
      let h = f.hash;
      for (let n = f.number; n > number; n -= 1n) h = await parentOf(h, n);
      return same(h, hash);
    }
    /**
     * The binding of a receipt of one of the send's own hashes to its transaction (25-28 round 4, HIGH 1), as the
     * consuming-transaction proof binds them: the block at the receipt's height, read by number with its
     * transactions, must list exactly one transaction with the receipt's hash, and the transaction and the receipt
     * must both name that block, by hash and by height. 'bound' when they agree; 'moved' when the block at that
     * height has another hash than the receipt names (the chain has another block there now); 'unbound' for any
     * other answer: the evidence contradicts itself. Throws when a read fails. Whether the block is on the finalized
     * chain is onFinalChain's question.
     */
    async function ownIn(row, receipt) {
      const hash = receipt.transactionHash;
      if (typeof hash !== 'string' || !row.hashes.some((h) => same(h, hash))) return 'unbound';
      const height = BigInt(receipt.blockNumber);
      const block = await reader.getBlock({ blockNumber: height, includeTransactions: true });
      if (BigInt(block.number) !== height || typeof block.hash !== 'string') throw new Error('block_by_number');
      if (!same(block.hash, receipt.blockHash)) return 'moved';
      const hits = (block.transactions ?? []).filter((t) => typeof t === 'object' && t !== null && same(t.hash, hash));
      if (hits.length !== 1) return 'unbound';
      const t = hits[0];
      if (!same(t.blockHash, block.hash)) return 'unbound';
      if (t.blockNumber === undefined || t.blockNumber === null || BigInt(t.blockNumber) !== height) return 'unbound';
      return 'bound';
    }
    return {
      reader,
      finalized,
      onFinalChain,
      ownIn,
      async consumer(row) {
        try {
          const nonce = BigInt(row.nonce);
          const f = await finalized();
          // (i) At the finalized block the relayer's nonce count is past this nonce.
          if (!(f.count > nonce)) return null;
          if (row.firstBlock === null) return null;
          const first = BigInt(row.firstBlock);
          if (first > f.number) return null;
          // Taken before the send's first broadcast block: the reads disagree with the stored send.
          if (first > 0n && (await countAt(first - 1n)) > nonce) return null;
          // (ii) The first block in [first, finalized] whose count is past the nonce holds the transaction.
          let lo = first;
          let hi = f.number;
          while (lo < hi) {
            const mid = (lo + hi) / 2n;
            if ((await countAt(mid)) > nonce) hi = mid;
            else lo = mid + 1n;
          }
          const block = await reader.getBlock({ blockNumber: lo, includeTransactions: true });
          if (BigInt(block.number) !== lo || typeof block.hash !== 'string') return null;
          const hits = (block.transactions ?? []).filter((t) => typeof t === 'object' && same(t.from, address) && BigInt(t.nonce) === nonce);
          if (hits.length !== 1 || typeof hits[0].hash !== 'string') return null;
          const t = hits[0];
          // (round 3, #3) The transaction names this block as its own, and this block is on the chain that ends in
          // the pinned finalized block: parent hashes followed down from it arrive at this hash at this height.
          if (!same(t.blockHash, block.hash) || t.blockNumber === undefined || t.blockNumber === null || BigInt(t.blockNumber) !== lo) return null;
          if (!(await onFinalChain(lo, block.hash))) return null;
          const hash = t.hash.toLowerCase();
          if (!row.hashes.some((h) => same(h, hash))) return { hash, block: lo, own: false };
          // One of the send's own hashes took the nonce: it mined, in a finalized block. Settle from its receipt on the
          // same endpoint, which must name that same block.
          const receipt = await reader.getTransactionReceipt({ hash });
          if (!receipt || !same(receipt.transactionHash, hash)) return null;
          if (!same(receipt.blockHash, block.hash) || receipt.blockNumber === undefined || receipt.blockNumber === null || BigInt(receipt.blockNumber) !== lo) return null;
          return { hash, block: lo, own: true, receipt };
        } catch {
          // (iv) A read that failed, or a walk not finished within this pass's budget, leaves the send unresolved.
          return null;
        }
      },
    };
  }

  /**
   * A confirming send, on the proof endpoint: its receipt read again and the block at its height read by number must
   * still name the block stored, or the send goes back to pending (reorged). Once the finalized block is at or past
   * that height and the block is on the finalized chain, the send settles to the real cost from that receipt.
   * Returns 'mined', 'reorged', 'confirming' (still waiting for finality) or null (a read failed: nothing changes).
   */
  async function confirm(row, proof, head) {
    const { reader } = proof;
    const height = BigInt(row.consumedBlock);
    let receipt;
    try {
      receipt = await reader.getTransactionReceipt({ hash: row.consumedBy });
    } catch (e) {
      return receiptMissing(e) ? reorged(row, 'receipt_gone', head) : null;
    }
    if (!receipt) return reorged(row, 'receipt_gone', head);
    if (!same(receipt.transactionHash, row.consumedBy)) return null;
    if (!same(receipt.blockHash, row.minedBlockHash) || BigInt(receipt.blockNumber) !== height) return reorged(row, 'receipt_moved', head);
    // The block at that height must still be the receipt's and list the transaction (25-28 round 4, HIGH 1).
    let where;
    try {
      where = await proof.ownIn(row, receipt);
    } catch {
      return null;
    }
    if (where === 'moved') return reorged(row, 'block_replaced', head);
    // The same block, but it and the receipt disagree about the transaction: unresolved, the whole maximum held.
    if (where !== 'bound') return null;
    let onChain;
    try {
      if (height > (await proof.finalized()).number) return 'confirming';
      onChain = await proof.onFinalChain(height, row.minedBlockHash);
    } catch {
      return null;
    }
    if (!onChain) return reorged(row, 'not_on_finalized_chain', head);
    // (25-28 dedupe, Codex round-5 MEDIUM) The finalized chain can hold only one transaction at this nonce. When the
    // consuming-transaction proof names another one, or another block, the evidence contradicts itself (only
    // inconsistent RPC answers produce it): unresolved, the whole maximum held. A proof that cannot be read now
    // contradicts nothing.
    const c = await proof.consumer(row);
    if (c !== null && (!c.own || !same(c.hash, row.consumedBy) || c.block !== height)) {
      // Held for good, out of the cap, until the evidence changes: listed for an operator (needsOperator), and logged
      // once, when it first enters this state (orchestrator 2026-11-11).
      if (row.heldReason !== HELD_CONFLICT) {
        db.setHeldReason(row.id, HELD_CONFLICT);
        logger.error(`ALERT send on ${row.chainId} nonce ${row.nonce} held: the node gave conflicting evidence (own hash ${row.consumedBy} at block ${height}, finalized consumer ${c.hash} at block ${c.block}); its maximum stays reserved until an operator looks at it`);
      }
      return null;
    }
    settle(row, receipt);
    return 'mined';
  }

  /**
   * One of the send's own hashes has a receipt on the read client. A send marked replaced is held again first, before
   * any read that can fail (25-28 round 5): its reservation and every fee-bump increase count again, and it goes back
   * to pending. The receipt the relayer keeps is the proof endpoint's: when that endpoint does not have it yet, or the
   * receipt is not bound to its block, nothing more changes ('seen': no fee bump, no proof). Then the send is
   * confirming, and settles at once when its block is already final.
   */
  async function seen(row, found, proof, head) {
    if (row.status === 'replaced') {
      // findReceipt returns only a receipt of the hash it asked for, one of the send's own: evidence the release was
      // wrong. One transaction, like a release: held again and pending, or neither.
      db.atomically(() => {
        if (row.spendId !== null) db.reopenSpend(row.spendId);
        db.updatePending(row.id, { ...row, status: 'pending', consumedBy: null, consumedBlock: null, minedBlockHash: null, sentBlock: head ?? row.sentBlock });
        db.insertEvent({ kind: 'send_release_reversed', chainId: row.chainId, detail: { nonce: row.nonce, hash: found.hash, replacedBy: row.consumedBy } });
      });
      logger.error(`ALERT send on ${row.chainId} marked replaced has mined after all: nonce ${row.nonce}; its reservation is held again until the receipt is final`);
      row = db.getPending(row.id);
    }
    let receipt;
    try {
      receipt = await proof.reader.getTransactionReceipt({ hash: found.hash });
    } catch {
      return 'seen';
    }
    if (!receipt || !same(receipt.transactionHash, found.hash) || typeof receipt.blockHash !== 'string' || receipt.blockNumber === undefined || receipt.blockNumber === null) return 'seen';
    // Marked confirming only when the receipt is bound to the transaction, as at settlement (25-28 round 4, HIGH 1).
    try {
      if ((await proof.ownIn(row, receipt)) !== 'bound') return 'seen';
    } catch {
      return 'seen';
    }
    const marked = markConfirming(row, receipt);
    return (await confirm(marked, proof, head)) ?? 'confirming';
  }

  /**
   * Move a send on from the chain's evidence: a confirming send toward settlement (or back, on a reorg); a send with a
   * receipt of its own hashes to confirming; a waiting send to replaced on proof that another transaction took its
   * nonce. A send marked replaced is only looked up under its own hashes.
   */
  async function resolve(publicClient, row, proof, head = null) {
    if (row.status === 'confirming') return confirm(row, proof, head);
    const found = await findReceipt(publicClient, row);
    if (found.receipt) return seen(row, found, proof, head);
    if (row.status === 'replaced') return null;
    // Receipts that read "not found" prove nothing (an index may lag): only the consuming transaction does.
    const c = await proof.consumer(row);
    if (c === null) return null;
    if (c.own) {
      settle(row, c.receipt);
      return 'mined';
    }
    replace(row, c);
    return 'replaced';
  }

  /**
   * Broadcast the row's transaction again with `fees`. The new hash is stored before the broadcast.
   * Returns { outcome, hash, row, error? }; outcome is 'sent' or one of broadcastOutcome's.
   */
  async function resend(clients, row, fees) {
    const serializedTransaction = await sign(clients.walletClient, {
      to: row.to, data: row.data, value: BigInt(row.value), gas: BigInt(row.gas), ...fees, nonce: row.nonce,
    });
    const hash = keccak256(serializedTransaction);
    let stored = row;
    if (!row.hashes.includes(hash)) {
      stored = { ...row, hashes: [...row.hashes, hash] };
      db.updatePending(row.id, stored);
    }
    try {
      await clients.walletClient.sendRawTransaction({ serializedTransaction });
      return { outcome: 'sent', hash, row: stored };
    } catch (e) {
      return { outcome: broadcastOutcome(e), hash, row: stored, error: e };
    }
  }

  /**
   * One row's chain evidence read again now, as a pass would (25-28 dedupe, round-2 Q2 (b)): an operator can trigger a
   * check, never declare an outcome. Returns the row as stored afterwards, or null for an unknown hash. A row with a
   * broadcast on its way, or a pass already running, is left alone.
   */
  async function recheck(hash) {
    const found = db.findPendingByHash(hash);
    if (!found) return null;
    if (ticking || busy.has(found.id)) return found;
    const clients = chains.get(found.chainId);
    if (!clients?.walletClient) return found;
    ticking = true;
    try {
      const row = db.getPending(found.id);
      if (row.status === 'mined') return row;
      let block;
      try {
        block = await clients.publicClient.getBlockNumber({ cacheTime: 0 });
      } catch {
        return row;
      }
      await resolve(clients.publicClient, row, proofPass(clients, row.chainId), block);
      return db.getPending(row.id);
    } finally {
      ticking = false;
    }
  }

  return {
    recheck,
    /** The sends an operator should look at, each with a plain reason: stuck ones, and ones held on conflicting evidence. */
    needsOperator() {
      return db.listPending()
        .map((r) => ({ r, reason: r.status === 'stuck' ? HELD_STUCK : r.status === 'confirming' && r.heldReason ? r.heldReason : null }))
        .filter((x) => x.reason !== null)
        .map(({ r, reason }) => ({ hash: r.hash, chainId: r.chainId, nonce: r.nonce, status: r.status, reason }));
    },
    /**
     * Queue a send. `buildTx` returns {to, data, value, gas, maxFeePerGas, maxPriorityFeePerGas}
     * (or a promise of it) and runs when the send reaches the front of its chain's queue.
     * Resolves to {hash, nonce} once the node accepted the transaction, or to {hash, nonce, duplicate: true} when
     * `meta.dedupeKey` names a send already pending, stuck, confirming or mined: then nothing was sent.
     */
    enqueue(chainId, buildTx, meta = {}) {
      const key = String(chainId);
      const prev = tails.get(key) ?? Promise.resolve();
      const job = prev.then(() => sendNext(chainId, typeof buildTx === 'function' ? buildTx : () => buildTx, meta));
      tails.set(key, job.catch(() => {}));
      return job;
    },

    /**
     * At boot, before anything sends.
     * - A reservation still open on a send row that says it is resolved (mined or replaced) is recovered, never given
     *   back: a database from before 25-28 round 3 could store the status without the ledger change. The row goes
     *   back to pending, so it settles from its receipt or is released only by the proof, as any waiting send.
     * - An unresolved reservation that no send row holds, in any status, is given back. A row is always stored before
     *   its broadcast, so without one nothing went out (the process stopped between the reserve and the row, or after
     *   a refusal and before the caller gave the reservation back). Returns how many were given back.
     */
    releaseOrphans() {
      const open = new Set(db.openSpend().filter((e) => e.parentId === null).map((e) => e.id));
      for (const r of db.listPending()) {
        if ((r.status !== 'mined' && r.status !== 'replaced') || r.spendId === null || !open.has(r.spendId)) continue;
        db.atomically(() => {
          db.updatePending(r.id, { ...r, status: 'pending', consumedBy: null, consumedBlock: null, minedBlockHash: null });
          db.insertEvent({ kind: 'send_recovered', chainId: r.chainId, detail: { nonce: r.nonce, hash: r.hash, was: r.status, spendId: r.spendId } });
        });
        logger.warn(`recovered send on ${r.chainId}: nonce ${r.nonce} was ${r.status} with its reservation still open; it waits again`);
      }
      const held = new Set(db.listPending().map((r) => r.spendId).filter((id) => id !== null));
      let n = 0;
      for (const e of db.openSpend()) {
        if (e.parentId !== null || held.has(e.id)) continue;
        cap.release({ id: e.id });
        db.insertEvent({ kind: 'reservation_released', chainId: e.chainId, detail: { id: e.id, wei: e.wei, reason: 'no_send_row' } });
        n += 1;
      }
      if (n) logger.warn(`released ${n} reservation(s) with no send row (nothing was broadcast for them)`);
      return n;
    },

    /**
     * At boot: sends that the chain has mined are marked mined (and their real cost recorded);
     * sends the node no longer holds in its pool are broadcast again as they were.
     */
    async reconcile() {
      const out = { mined: 0, replaced: 0, rebroadcast: 0 };
      // Stuck sends too (round 2, MEDIUM 6): they resolve only from the chain, like any other. Confirming sends too
      // (round 3, #2): they settle at finality, or go back to pending on a reorg.
      const waiting = (s) => s === 'pending' || s === 'stuck' || s === 'confirming';
      const rows = db.listPending().filter((r) => waiting(r.status));
      const passes = new Map();
      // The head per chain, read once: a send found reorged here waits a full bump interval from now (25-28 round 4,
      // Flash LOW 1). Unreadable: null, and the send keeps its own first block.
      const heads = new Map();
      for (const listed of rows) {
        // Read again: an earlier step may have changed or deleted the row.
        const row = db.getPending(listed.id);
        if (!row || busy.has(row.id) || !waiting(row.status)) continue;
        const clients = chains.get(row.chainId);
        if (!clients?.walletClient) continue;
        const { publicClient } = clients;
        if (!passes.has(row.chainId)) {
          passes.set(row.chainId, proofPass(clients, row.chainId));
          heads.set(row.chainId, await publicClient.getBlockNumber({ cacheTime: 0 }).catch(() => null));
        }
        const head = heads.get(row.chainId);
        if (row.status === 'confirming') {
          // Its own transaction mined: never rebroadcast, only confirmed or found reorged.
          if ((await resolve(publicClient, row, passes.get(row.chainId), head)) === 'mined') out.mined += 1;
          continue;
        }
        const [latest, pending] = await Promise.all([
          publicClient.getTransactionCount({ address, blockTag: 'latest' }),
          publicClient.getTransactionCount({ address, blockTag: 'pending' }),
        ]);
        if (row.nonce < latest) {
          // Mined, replaced (proven at the finalized block), or kept for the poll loop to decide.
          const r = await resolve(publicClient, row, passes.get(row.chainId), head);
          if (r === 'mined') out.mined += 1;
          if (r === 'replaced') out.replaced += 1;
        } else if (row.nonce >= pending && clients.sponsored !== false) {
          // The node no longer holds it: the identical signed transaction goes out again (same hash). For a stuck
          // send that is its last replacement, which its reservation already covers. Never on a chain the relayer
          // does not sponsor (25-28 round 4, HIGH 2): there a stored send is held read-only, its reservation kept.
          try {
            const r = await holding(row.id, () => resend(clients, row, { maxFeePerGas: BigInt(row.maxFeePerGas), maxPriorityFeePerGas: BigInt(row.maxPriorityFeePerGas) }));
            if (r === null) continue;
            if (r.outcome === 'refused') logger.warn(`reconcile: rebroadcast of nonce ${row.nonce} on ${row.chainId} failed: ${r.error.shortMessage ?? r.error.name}`);
            else out.rebroadcast += 1;
          } catch (e) {
            logger.warn(`reconcile: rebroadcast of nonce ${row.nonce} on ${row.chainId} failed: ${e.shortMessage ?? e.name}`);
          }
        }
      }
      return out;
    },

    /** One pass of the poll loop: receipts, fee bumps and alerts. */
    async tick() {
      if (ticking) return;
      ticking = true;
      try {
        // Replaced sends too: their own hashes are still looked up, so a late receipt settles the real cost. Confirming
        // sends too: they settle once their receipt's block is finalized (25-28 round 3, #2).
        const rows = db.listPending().filter((r) => r.status === 'pending' || r.status === 'stuck' || r.status === 'replaced' || r.status === 'confirming');
        const byChain = new Map();
        for (const r of rows) byChain.set(r.chainId, [...(byChain.get(r.chainId) ?? []), r]);
        for (const [chainId, list] of byChain) {
          const clients = chains.get(chainId);
          if (!clients?.walletClient) continue;
          const { publicClient } = clients;
          let block;
          try {
            block = await publicClient.getBlockNumber({ cacheTime: 0 });
          } catch {
            continue;
          }
          const proof = proofPass(clients, chainId);
          for (const listed of list) {
            // A row with a broadcast on its way is left alone: its answer may still change it. The row is read again
            // here, so a first broadcast answered (or a row deleted) while this pass waited is never acted on stale.
            if (busy.has(listed.id)) continue;
            const row = db.getPending(listed.id);
            if (!row || row.status !== listed.status) continue;
            if ((await resolve(publicClient, row, proof, block)) !== null || row.status === 'replaced') continue;
            // A chain the relayer does not sponsor (chain.js): receipts and the proof run above, but nothing is bumped
            // or sent again; the send keeps its reservation until the chain resolves it (25-28 round 4, HIGH 2).
            if (clients.sponsored === false) continue;
            if (row.status !== 'pending' || block - BigInt(row.sentBlock) < bumpAfterBlocks) continue;
            if (row.attempts >= maxBumps) {
              db.updatePending(row.id, { ...row, status: 'stuck' });
              events.add('send_stuck', { chainId, safe: row.safe ?? null, detail: { nonce: row.nonce, hash: row.hash, attempts: row.attempts, kind: row.kind } });
              logger.warn(`ALERT send stuck on ${chainId}: nonce ${row.nonce} after ${row.attempts} fee bumps`);
              continue;
            }
            const fees = { maxFeePerGas: bumpFee(BigInt(row.maxFeePerGas)), maxPriorityFeePerGas: bumpFee(BigInt(row.maxPriorityFeePerGas)) };
            // The replacement may cost up to its own maximum: the reservation must cover that first (25-28 fix A).
            // A send queued without a reservation has no ledger entry to extend; every route reserves before it queues.
            if (row.spendId !== null) {
              try {
                cap.extend(row.spendId, BigInt(row.gas) * fees.maxFeePerGas + BigInt(row.value), chainId);
              } catch (e) {
                logger.warn(`fee bump of nonce ${row.nonce} on ${chainId} waits: ${e instanceof CapReached ? `spend cap (${e.limit}) reached until ${e.until}` : e.message}`);
                continue;
              }
            }
            let r;
            try {
              r = await holding(row.id, () => resend(clients, row, fees));
            } catch (e) {
              logger.warn(`resend of nonce ${row.nonce} on ${chainId} failed before the broadcast: ${e.shortMessage ?? e.name}`);
              continue;
            }
            if (r === null) continue;
            if (r.outcome === 'refused') {
              logger.warn(`resend of nonce ${row.nonce} on ${chainId} failed: ${r.error.shortMessage ?? r.error.name}`);
              continue;
            }
            // Sent, or possibly live: from now on the send is this replacement.
            db.updatePending(row.id, { ...r.row, hash: r.hash, ...fees, sentBlock: block, attempts: row.attempts + 1 });
            logger.info(`resent nonce ${row.nonce} on ${chainId} with fees raised (attempt ${row.attempts + 1})`);
          }
        }
      } finally {
        ticking = false;
      }
    },

    start() {
      if (timer) return;
      timer = setInterval(() => {
        this.tick().catch((e) => logger.error(`queue tick failed: ${e?.name ?? 'Error'}`));
      }, pollMs);
      timer.unref();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
