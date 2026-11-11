// 25-28 fix round 4 (Codex round 4 HIGH 1, HIGH 2 and MEDIUM 4; Flash round 4's two LOWs; the orchestrator's ruling).
// - HIGH 1: every path that settles a send or marks it confirming binds the receipt to the transaction, as the release
//   proof does: the block at the receipt's height lists the send's own transaction by hash, and the transaction's and
//   the receipt's blockHash and blockNumber are that block's. A receipt read for one hash must be that hash's.
//   Contradictory evidence leaves the send unresolved, its whole maximum held.
// - HIGH 2: on a chain the relayer does not sponsor, a stored send is held read-only: receipts and the proof still
//   run, its reservation stays, and nothing is broadcast again or bumped.
// - MEDIUM 4: a block read by hash at another height than expected is never kept, so a later pass reads it again.
// - LOW 1: a send found reorged at boot waits a full bump interval from the boot head.
// - LOW 2: boot recovery clears a recovered row's block hash with the rest of its receipt.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CapReached, createCap } from '../../src/cap.js';
import { createEvents } from '../../src/events.js';
import { createQueue } from '../../src/queue.js';
import { blockHash, CHAIN, inBlock, ME, NOW, quiet, receipt, setup, spentDay, STRANGER, tx } from '../helpers/node.js';

/** A queue and cap started again over the same database and node, as after a restart. */
function restart({ db, node }, caps = { dayWei: 10n ** 18n, monthWei: 10n ** 19n }) {
  const events = createEvents({ db });
  const cap = createCap({ db, caps, now: () => NOW, events });
  return { cap, queue: createQueue({ db, chains: node.chains, cap, address: ME, logger: quiet, events }) };
}

/** One send at nonce 5 holding a reservation of 1,000 wei (gas 100 x maxFeePerGas 10), first sent at block 100. */
async function oneSend(o = {}) {
  const ctx = setup(o);
  const sent = await ctx.queue.enqueue(CHAIN, () => tx(), { reservation: ctx.cap.reserve(CHAIN, 1000n) });
  return { ...ctx, sent };
}

describe('round 4: Flash LOWs', () => {
  test('round 4 LOW 1: a confirming send found reorged at boot waits a full bump interval from the boot head', async () => {
    const ctx = await oneSend({ node: { finalized: 90n } });
    const { db, node, sent } = ctx;
    node.state.receipts[sent.hash] = inBlock(node, receipt(sent.hash));
    await ctx.queue.tick();
    assert.equal(db.listPending()[0].status, 'confirming');
    // While the relayer is down, block 101 is reorged out and the head moves on to 150.
    delete node.state.receipts[sent.hash];
    node.state.block = 150n;
    const booted = restart(ctx);
    booted.queue.releaseOrphans();
    await booted.queue.reconcile();
    const row = db.listPending()[0];
    assert.equal(row.status, 'pending');
    assert.equal(BigInt(row.sentBlock), 150n, 'the bump timer restarts at the boot head');
    await booted.queue.tick();
    assert.equal(node.state.sent.length, 1, 'not bumped at once');
  });

  test('round 4 LOW 2: boot recovery clears the recovered row\'s block hash', async () => {
    const ctx = await oneSend();
    const { db, sent } = ctx;
    const row = db.listPending()[0];
    db.updatePending(row.id, { ...row, status: 'mined', consumedBy: sent.hash, consumedBlock: 101n, minedBlockHash: blockHash(101n) });
    const booted = restart(ctx);
    booted.queue.releaseOrphans();
    const after = db.listPending()[0];
    assert.equal(after.status, 'pending');
    assert.equal(after.consumedBy, null);
    assert.equal(after.minedBlockHash, null);
    assert.equal(spentDay(booted.cap), 1000n);
  });
});

const OTHER = `0x${'ab'.repeat(32)}`;

/** Another transaction from the relayer took nonce 5 at block 103; the finalized block is 110. */
function takenAt(node, block = 103n, finalized = 110n) {
  node.state.mined.push({ hash: OTHER, nonce: 5, block });
  node.state.latest = 6;
  node.state.block = 111n; // below the fee-bump threshold (sent at 100, bumped from 112): the reservation stays 1,000
  node.state.finalized = finalized;
}

describe('round 4 MEDIUM 4: a wrong-height block is never kept', () => {
  test('round 4 MEDIUM 4: Codex repro: one wrong-height answer to a read by hash, then correct ones: the proof completes', async () => {
    const ctx = await oneSend();
    const { db, cap, node, queue } = ctx;
    takenAt(node);
    let bad = 1;
    node.state.byHashTamper = (b) => {
      if (bad === 0) return b;
      bad -= 1;
      return { ...b, number: b.number + 1n };
    };
    await queue.tick();
    assert.equal(db.listPending()[0].status, 'pending', 'the wrong height leaves the send unresolved');
    assert.equal(spentDay(cap), 1000n);
    await queue.tick();
    const byHash = node.state.reads.filter((r) => r[0] === 'proof' && r[1] === 'block' && r[2] === blockHash(110n));
    assert.ok(byHash.length >= 2, `the block is read again after the wrong answer (${byHash.length} reads)`);
    assert.equal(db.listPending()[0].status, 'replaced');
    assert.equal(spentDay(cap), 0n);
  });
});

/** The node's chains as chain.js gives them for a chain the relayer does not sponsor (84532). */
const unsponsored = (node) => ({
  get: (id) => {
    const c = node.chains.get(id);
    return c ? { ...c, sponsored: false } : c;
  },
});

describe('round 4 HIGH 2: on a chain not sponsored, a stored send is held read-only', () => {
  test('round 4 HIGH 2: Codex repro: a stored send, then the chain is not sponsored: no rebroadcast at boot, no fee bump, the reservation stays 1,000; its receipt still settles it', async () => {
    const ctx = await oneSend();
    const { db, node, sent } = ctx;
    assert.equal(node.state.sent.length, 1);
    node.state.pending = 5; // the node no longer holds it: reconcile would broadcast it again
    const events = createEvents({ db });
    const cap = createCap({ db, caps: { dayWei: 10n ** 18n, monthWei: 10n ** 19n }, now: () => NOW, events });
    const queue = createQueue({ db, chains: unsponsored(node), cap, address: ME, logger: quiet, events });
    queue.releaseOrphans();
    const out = await queue.reconcile();
    assert.equal(out.rebroadcast, 0);
    assert.equal(node.state.sent.length, 1, 'not broadcast again at boot');
    node.state.block = 112n; // past the fee-bump threshold
    await queue.tick();
    node.state.block = 130n;
    await queue.tick();
    assert.equal(node.state.sent.length, 1, 'never bumped');
    assert.equal(db.listPending()[0].hashes.length, 1, 'no replacement signed and stored');
    assert.equal(spentDay(cap), 1000n, 'the reservation is unchanged');
    assert.equal(db.listPending()[0].status, 'pending');
    // Receipts and the proof still run: the send settles from its own receipt at finality.
    node.state.receipts[sent.hash] = inBlock(node, receipt(sent.hash));
    await queue.tick();
    assert.equal(db.listPending()[0].status, 'mined');
    assert.equal(spentDay(cap), 150n);
  });

  test('round 4 HIGH 2: on a chain not sponsored, a stored send another transaction replaced is still released by the proof', async () => {
    const ctx = await oneSend();
    const { db, node } = ctx;
    const events = createEvents({ db });
    const cap = createCap({ db, caps: { dayWei: 10n ** 18n, monthWei: 10n ** 19n }, now: () => NOW, events });
    const queue = createQueue({ db, chains: unsponsored(node), cap, address: ME, logger: quiet, events });
    takenAt(node, 103n, 105n);
    await queue.tick();
    assert.equal(db.listPending()[0].status, 'replaced');
    assert.equal(spentDay(cap), 0n);
    assert.equal(node.state.sent.length, 1);
  });
});

describe('round 4 HIGH 1: every settlement binds the receipt to the transaction', () => {
  test('round 4 HIGH 1: Codex repro: our own transaction is in finalized block 103, its receipt names canonical block 104 for 1 wei: nothing settles, and no second 999 fits', async () => {
    const ctx = await oneSend({ dayWei: 1000n, monthWei: 1000n });
    const { db, cap, node, queue, sent } = ctx;
    node.state.mined.push({ hash: sent.hash, nonce: 5, block: 103n });
    node.state.receipts[sent.hash] = receipt(sent.hash, 1n, 1n, 104n); // 1 wei, naming block 104
    node.state.latest = 6;
    node.state.block = 111n;
    node.state.finalized = 105n;
    for (let i = 0; i < 2; i += 1) {
      await queue.tick();
      const row = db.listPending()[0];
      assert.equal(row.status, 'pending', 'not marked confirming, not settled');
      assert.equal(spentDay(cap), 1000n, 'the whole maximum stays held');
    }
    assert.throws(() => cap.reserve(CHAIN, 999n), CapReached);
    assert.equal(node.state.sent.length, 1, 'a send with a receipt is not bumped');
  });

  test('round 4 HIGH 1: Codex repro: the lookup of our hash returns an unrelated transaction\'s receipt: nothing settles', async () => {
    const ctx = await oneSend({ dayWei: 1000n, monthWei: 1000n });
    const { db, cap, node, queue, sent } = ctx;
    // An unrelated transaction (another sender), really in block 101, its receipt coherent on its own.
    node.state.mined.push({ hash: OTHER, nonce: 0, block: 101n, from: STRANGER });
    const unrelated = receipt(OTHER, 1n, 1n, 101n);
    node.state.receipts[OTHER] = unrelated;
    node.state.receipts[sent.hash] = unrelated; // the endpoint answers our hash with it
    node.state.block = 111n;
    node.state.finalized = 105n;
    await queue.tick();
    await queue.tick();
    const row = db.listPending()[0];
    assert.equal(row.status, 'pending');
    assert.equal(row.consumedBy, null);
    assert.equal(spentDay(cap), 1000n);
    assert.throws(() => cap.reserve(CHAIN, 999n), CapReached);
  });

  test('round 4 HIGH 1: a confirming send whose block no longer lists its transaction (the same block hash) does not settle at finality', async () => {
    const ctx = await oneSend({ node: { finalized: 90n } });
    const { db, cap, node, queue, sent } = ctx;
    node.state.receipts[sent.hash] = inBlock(node, receipt(sent.hash)); // block 101, which lists it
    await queue.tick();
    assert.equal(db.listPending()[0].status, 'confirming');
    // The endpoint now lists our transaction in block 102 while its receipt still names block 101.
    node.state.mined.push({ hash: sent.hash, nonce: 5, block: 102n });
    node.state.blockTxs = []; // block 101 (same hash) no longer lists it
    node.state.finalized = 110n;
    node.state.block = 111n;
    await queue.tick();
    await queue.tick();
    assert.equal(db.listPending()[0].status, 'confirming', 'unresolved');
    assert.equal(spentDay(cap), 1000n, 'the whole maximum stays held');
    assert.ok(!db.listEvents().some((e) => e.kind === 'send_reorged'), 'contradiction, not a reorg');
  });

  test('round 4 HIGH 1: the transaction listed in the block must name that block, by hash and by height', async () => {
    const cases = {
      'another block hash': { txBlockHash: (t) => blockHash(t.blockNumber, 7) },
      'no block hash': { txBlockHash: () => undefined },
      'another height': { txTamper: (t) => ({ ...t, blockNumber: t.blockNumber + 1n }) },
      'no height': { txTamper: (t) => ({ ...t, blockNumber: null }) },
      'listed twice': { txTamper: null, twice: true },
    };
    for (const [name, o] of Object.entries(cases)) {
      const ctx = await oneSend();
      const { db, cap, node, queue, sent } = ctx;
      // Listed once in block 101 as its receipt says, or (listed twice) twice by `mined`.
      node.state.receipts[sent.hash] = o.twice ? receipt(sent.hash) : inBlock(node, receipt(sent.hash));
      if (o.twice) node.state.mined.push({ hash: sent.hash, nonce: 5, block: 101n }, { hash: sent.hash, nonce: 5, block: 101n });
      node.state.txBlockHash = o.txBlockHash ?? null;
      node.state.txTamper = o.txTamper ?? null;
      await queue.tick();
      assert.equal(db.listPending()[0].status, 'pending', name);
      assert.equal(spentDay(cap), 1000n, name);
    }
  });

  test('round 4 HIGH 1: a coherent receipt still settles at finality (the binding holds)', async () => {
    const ctx = await oneSend();
    const { db, cap, node, queue, sent } = ctx;
    node.state.receipts[sent.hash] = inBlock(node, receipt(sent.hash)); // 150 wei in block 101, which lists it
    await queue.tick();
    assert.equal(db.listPending()[0].status, 'mined');
    assert.equal(spentDay(cap), 150n);
  });
});

describe('round 4 HIGH 1: guard tests (one guard each, where another guard would mask it)', () => {
  test('round 4 HIGH 1: a receipt of another transaction is no answer: the proof still releases a send another transaction replaced', async () => {
    const ctx = await oneSend();
    const { db, cap, node, queue, sent } = ctx;
    const UNRELATED = `0x${'cd'.repeat(32)}`;
    node.state.mined.push({ hash: UNRELATED, nonce: 0, block: 101n, from: STRANGER });
    node.state.receipts[UNRELATED] = receipt(UNRELATED, 1n, 1n, 101n);
    node.state.receipts[sent.hash] = node.state.receipts[UNRELATED]; // the endpoint answers our hash with it
    takenAt(node, 103n, 105n); // another transaction of ours took nonce 5 in finalized block 103
    await queue.tick();
    assert.equal(db.listPending()[0].status, 'replaced', 'the unrelated receipt does not stop the proof');
    assert.equal(spentDay(cap), 0n);
  });

  test('round 4 HIGH 1: a confirming row whose stored hash is not one of its own (a damaged database) never settles', async () => {
    const ctx = await oneSend();
    const { db, cap, node, queue } = ctx;
    // OTHER is really in block 101, with a coherent receipt; the row says it is this send's.
    node.state.mined.push({ hash: OTHER, nonce: 0, block: 101n, from: STRANGER });
    node.state.receipts[OTHER] = receipt(OTHER, 1n, 1n, 101n);
    const row = db.listPending()[0];
    db.updatePending(row.id, { ...row, status: 'confirming', consumedBy: OTHER, consumedBlock: 101n, minedBlockHash: blockHash(101n) });
    await queue.tick();
    assert.equal(db.listPending()[0].status, 'confirming', 'unresolved');
    assert.equal(spentDay(cap), 1000n, 'the whole maximum stays held');
  });
});
