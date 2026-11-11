// 25-28 fix round 2, HIGH 4 and MEDIUM 6 (Codex round 2, ruling (a)): a reservation is given back only with proof
// of the transaction that took the send's nonce, read on one endpoint in one pass:
//   (i)   at the `finalized` block, the relayer's nonce count is past the send's nonce;
//   (ii)  the relayer's transaction with that nonce is found in a block from the send's first broadcast block to
//         `finalized`, and it is none of the send's own hashes;
//   (iii) both on the proof endpoint only, never mixed with the fallback reads;
//   (iv)  a read that fails or disagrees leaves the send unresolved;
//   (v)   a send marked replaced is still looked up under its own hashes: a late receipt settles the real cost;
//   (vi)  GET /sends/:hash shows the outcome to Drupal: not_sent with the consuming hash.
// Receipt absence and a nonce taken 12 blocks deep no longer release anything. Stuck sends stay in reconcile.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createCap } from '../../src/cap.js';
import { createEvents } from '../../src/events.js';
import { createQueue } from '../../src/queue.js';
import { RELAYER_ACCOUNT, startStub } from '../helpers/stub.js';
import { CHAIN, inBlock, ME, NOW, quiet, receipt, serialize, setup, spentDay, STRANGER, tx } from '../helpers/node.js';

const OTHER = `0x${'ab'.repeat(32)}`;

/** One reserved send at nonce 5, first broadcast at block 100. */
async function oneSend(o = {}) {
  const ctx = setup(o);
  const reservation = ctx.cap.reserve(CHAIN, 1000n);
  const sent = await ctx.queue.enqueue(CHAIN, () => tx(), { reservation });
  return { ...ctx, sent, reservation };
}

/**
 * The relayer's nonce 5 was taken at `block` by `hash`; `finalized` is the finalized block. The head stays below
 * the fee-bump threshold (sent at 100, bumped from 112) unless the test moves it.
 */
function takenAt(node, hash, block = 103n, finalized = 105n) {
  node.state.mined.push({ hash, nonce: 5, block });
  node.state.latest = 6;
  if (node.state.block < 111n) node.state.block = 111n;
  node.state.finalized = finalized;
}

/** A queue started again over the same database and node, as after a restart. */
function restart({ db, node }) {
  const events = createEvents({ db });
  const cap = createCap({ db, caps: { dayWei: 10n ** 18n, monthWei: 10n ** 19n }, now: () => NOW, events });
  return { cap, queue: createQueue({ db, chains: node.chains, cap, address: ME, logger: quiet, events }) };
}

describe('round 2 HIGH 4: a release needs the transaction that took the nonce', () => {
  test('release-proof: another transaction took the nonce in a finalized block: replaced, reservation given back, consuming hash stored', async () => {
    const { db, cap, node, queue, sent } = await oneSend();
    takenAt(node, OTHER);
    await queue.tick();
    const row = db.listPending()[0];
    assert.equal(row.status, 'replaced');
    assert.equal(row.consumedBy, OTHER);
    assert.equal(row.consumedBlock, '103');
    assert.equal(spentDay(cap), 0n);
    const ev = db.listEvents().find((e) => e.kind === 'send_replaced');
    assert.ok(ev);
    assert.deepEqual(JSON.parse(ev.detail), { nonce: 5, hash: sent.hash, consumedBy: OTHER, block: '103' });
  });

  test('release-proof: Codex repro: a lagging receipt index: our own hash took the nonce, its receipt reads "not found": nothing is released', async () => {
    const { db, cap, node, queue, sent } = await oneSend();
    takenAt(node, sent.hash); // our own transaction mined; neither endpoint has indexed its receipt yet
    node.state.block = 130n; // well past 12 blocks deep, where the old rule released
    for (let i = 0; i < 3; i += 1) {
      node.state.finalized += 5n;
      await queue.tick();
    }
    const row = db.listPending()[0];
    assert.notEqual(row.status, 'replaced');
    assert.ok(spentDay(cap) >= 1000n, 'held: the send is spent, its real cost is not known yet');

    // Its receipt names block 103, where the transaction is (round 4, HIGH 1: a receipt must agree with the block).
    node.state.receipts[sent.hash] = receipt(sent.hash, 50n, 3n, 103n);
    await queue.tick();
    assert.equal(db.listPending()[0].status, 'mined');
    assert.equal(spentDay(cap), 150n, 'the real cost is recorded');
  });

  test('release-proof: our own hash found in the block, with its receipt on the proof endpoint: settled to its real cost', async () => {
    const { db, cap, node, queue, sent } = await oneSend();
    takenAt(node, sent.hash);
    node.state.proofReceipts = { [sent.hash]: receipt(sent.hash, 40n, 2n, 103n) }; // in the block that holds it (round 3, #3)
    await queue.tick();
    const row = db.listPending()[0];
    assert.equal(row.status, 'mined');
    assert.equal(row.consumedBy, sent.hash);
    assert.equal(spentDay(cap), 80n);
  });

  test('release-proof: a nonce taken after the finalized block keeps the send until that block is finalized', async () => {
    const { db, cap, node, queue } = await oneSend();
    takenAt(node, OTHER, 108n, 105n);
    await queue.tick();
    assert.equal(db.listPending()[0].status, 'pending');
    assert.equal(spentDay(cap), 1000n);
    node.state.finalized = 108n;
    await queue.tick();
    assert.equal(db.listPending()[0].status, 'replaced');
    assert.equal(spentDay(cap), 0n);
  });

  test('release-proof: one endpoint only: the fallback reads say another transaction took the nonce, the proof endpoint does not: nothing is released', async () => {
    const { db, cap, node, queue } = await oneSend();
    node.state.publicMined = [{ hash: OTHER, nonce: 5, block: 103n }];
    node.state.latest = 6;
    node.state.block = 111n;
    node.state.finalized = 105n;
    await queue.tick();
    assert.equal(db.listPending()[0].status, 'pending');
    assert.equal(spentDay(cap), 1000n);
    const mixed = node.state.reads.filter((r) => r[0] === 'public' && (r[1] === 'block' || (r[1] === 'count' && typeof r[2] === 'bigint')));
    assert.deepEqual(mixed, [], 'no proof read went to the fallback client');
  });

  test('release-proof: conflicting or missing reads leave the send unresolved', async () => {
    const cases = {
      'the finalized block cannot be read': (n) => { n.state.proofError = (m) => m === 'finalized'; },
      'a nonce count cannot be read': (n) => { n.state.proofError = (m) => m === 'count'; },
      'the consuming block cannot be read': (n) => { n.state.proofError = (m) => m === 'block'; },
      'the count says taken, the block holds no transaction of ours with that nonce': (n) => { n.state.mined = []; n.state.countAt = (b) => (b >= 103n ? 6 : 5); },
      'the transaction in the block is from another address': (n) => { n.state.mined = [{ hash: OTHER, nonce: 5, block: 103n, from: STRANGER }]; n.state.countAt = (b) => (b >= 103n ? 6 : 5); },
      'the nonce was taken before the first broadcast block': (n) => { n.state.mined = [{ hash: OTHER, nonce: 5, block: 90n }]; },
      'taken before the first broadcast block, and a later block also shows a transaction with that nonce': (n) => {
        n.state.mined = [{ hash: `0x${'cd'.repeat(32)}`, nonce: 5, block: 90n }, { hash: OTHER, nonce: 5, block: 100n }];
      },
      'the count at the finalized block says not taken, the finalized block holds the transaction': (n) => {
        n.state.mined = [{ hash: OTHER, nonce: 5, block: 105n }];
        n.state.countAt = () => 5;
      },
      'no finalized block yet': (n) => { n.state.finalized = null; },
    };
    for (const [name, spoil] of Object.entries(cases)) {
      const { db, cap, node, queue } = await oneSend();
      takenAt(node, OTHER);
      spoil(node);
      await queue.tick();
      assert.equal(db.listPending()[0].status, 'pending', name);
      assert.equal(spentDay(cap), 1000n, name);
    }
  });

  test('release-proof: a nonce taken 12 blocks deep with every own hash "not found" is no longer enough', async () => {
    const { db, cap, node, queue } = await oneSend();
    takenAt(node, OTHER, 150n, 140n); // taken 50 blocks deep, but not yet finalized
    node.state.block = 200n;
    await queue.tick();
    assert.equal(db.listPending()[0].status, 'pending');
    assert.ok(spentDay(cap) >= 1000n, 'not given back');
  });

  test('release-proof: a replaced send whose own hash later shows a receipt has the release undone, and is held, not settled, against the finalized OTHER (dedupe MEDIUM)', async () => {
    const { db, cap, node, queue, sent } = await oneSend();
    takenAt(node, OTHER);
    await queue.tick();
    assert.equal(db.listPending()[0].status, 'replaced');
    assert.equal(spentDay(cap), 0n);

    node.state.receipts[sent.hash] = inBlock(node, receipt(sent.hash, 60n, 5n));
    await queue.tick();
    const row = db.listPending()[0];
    assert.equal(row.status, 'confirming');
    assert.equal(row.consumedBy, sent.hash);
    assert.equal(spentDay(cap), 1000n);
    assert.ok(db.listEvents().some((e) => e.kind === 'send_release_reversed'));
  });

  test('release-proof: a late receipt for a send whose reservation entry is gone (released before round 2) records the real cost as a new entry', async () => {
    const { db, cap, node, queue } = setup();
    const h = `0x${'0e'.repeat(32)}`;
    // A safe-exec send from an older database: replaced, its reservation deleted (spend id 999 no longer exists).
    const id = db.insertPending({ chainId: CHAIN, nonce: 5, hash: h, to: ME, data: '0x', value: 0n, gas: 100n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n, sentBlock: 90n, spendId: 999, kind: 'safe-exec' });
    db.updatePending(id, { ...db.listPending()[0], status: 'replaced' });
    node.state.receipts[h] = receipt(h, 70n, 2n);
    node.state.mined.push({ hash: h, nonce: 5, block: 101n }); // block 101 lists it (round 4, HIGH 1)
    await queue.tick();
    assert.equal(db.listPending()[0].status, 'mined');
    assert.equal(spentDay(cap), 140n);
  });

  test('release-proof: reconcile at boot uses the same proof', async () => {
    const first = await oneSend();
    takenAt(first.node, OTHER);
    first.node.state.pending = 6;
    const { cap, queue } = restart(first);
    const r = await queue.reconcile();
    assert.equal(r.replaced, 1);
    assert.equal(first.db.listPending()[0].status, 'replaced');
    assert.equal(spentDay(cap), 0n);
  });

  test('release-proof: the first broadcast block survives fee bumps and bounds the search', async () => {
    const { db, node, queue } = await oneSend();
    node.state.block += 12n;
    await queue.tick();
    const row = db.listPending()[0];
    assert.equal(row.attempts, 1);
    assert.equal(row.firstBlock, '100');
    assert.equal(row.sentBlock, '112');
  });

  test('release-proof: a bond whose send was replaced earns no later credit, so other spend is never offset', async () => {
    const { db, cap, node, queue } = setup();
    cap.reserve(CHAIN, 500n);
    const bond = cap.reserve(CHAIN, 1000n, { kind: 'bond', ref: 'bond:q9' });
    await queue.enqueue(CHAIN, () => tx({ value: 900n, gas: 10n }), { reservation: bond });
    takenAt(node, OTHER);
    await queue.tick();
    assert.equal(db.listPending()[0].status, 'replaced');
    assert.equal(spentDay(cap), 500n);
    assert.equal(cap.credit('bond:q9', 1000n), null);
    assert.equal(spentDay(cap), 500n, 'no bond entry left: nothing to offset');
  });
});

describe('round 2 MEDIUM 6: stuck sends stay in reconcile and resolve only from chain evidence', () => {
  async function stuck() {
    const ctx = await oneSend();
    for (let i = 0; i < 4; i += 1) {
      ctx.node.state.block += 12n;
      await ctx.queue.tick();
    }
    assert.equal(ctx.db.listPending()[0].status, 'stuck');
    return ctx;
  }

  test('release-proof: at boot, a stuck send the node lost is sent again as its last signed replacement, and keeps its reservation', async () => {
    const first = await stuck();
    const last = first.node.state.sent.at(-1);
    first.node.state.pending = 5; // the node dropped it
    const held = spentDay(first.cap);
    const { cap, queue } = restart(first);
    const r = await queue.reconcile();
    assert.equal(r.rebroadcast, 1);
    assert.equal(serialize(first.node.state.sent.at(-1)), serialize(last), 'the identical bytes: no new transaction');
    assert.equal(first.db.listPending()[0].hashes.length, 4, 'no new hash');
    assert.equal(first.db.listPending()[0].status, 'stuck');
    assert.equal(spentDay(cap), held);
  });

  test('release-proof: a stuck send is not released by a nonce taken deep; the finalized proof releases it', async () => {
    const { db, cap, node, queue } = await stuck();
    takenAt(node, OTHER, 150n, 140n); // taken 50 blocks deep, but not yet finalized
    node.state.block = 200n;
    await queue.tick();
    assert.equal(db.listPending()[0].status, 'stuck');
    assert.ok(spentDay(cap) > 0n);
    node.state.finalized = 150n;
    await queue.tick();
    assert.equal(db.listPending()[0].status, 'replaced');
    assert.equal(spentDay(cap), 0n);
  });

  test('release-proof: at boot, a stuck send whose own hash mined is settled', async () => {
    const first = await stuck();
    const hash = first.db.listPending()[0].hash;
    first.node.state.receipts[hash] = inBlock(first.node, receipt(hash));
    first.node.state.latest = 6;
    first.node.state.pending = 6;
    const { cap, queue } = restart(first);
    const r = await queue.reconcile();
    assert.equal(r.mined, 1);
    assert.equal(spentDay(cap), 150n);
  });
});

describe('round 2 HIGH 4 (vi): GET /sends/:hash tells Drupal what happened to a send', () => {
  test('release-proof: GET /sends/:hash answers pending, then not_sent with the consuming hash; any of the send\'s hashes finds it; unknown is 404', async () => {
    const ctx = setup({ node: { me: RELAYER_ACCOUNT.address } });
    const s = await startStub({ chains: ctx.node.chains });
    try {
      const reservation = s.cap.reserve(CHAIN, 1000n);
      const sent = await s.queue.enqueue(CHAIN, () => tx(), { reservation });
      let res = await s.call('GET', `/sends/${sent.hash}`);
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(res.json, { hash: sent.hash, chainId: CHAIN, nonce: 5, status: 'pending', stuck: false, hashes: [sent.hash] });

      ctx.node.state.block += 12n;
      await s.queue.tick();
      const bumped = s.db.listPending()[0].hash;
      takenAt(ctx.node, OTHER, 103n, 130n);
      ctx.node.state.block = 140n;
      await s.queue.tick();
      for (const h of [sent.hash, bumped, sent.hash.toUpperCase().replace('0X', '0x')]) {
        res = await s.call('GET', `/sends/${h}`);
        assert.equal(res.status, 200, res.text);
        assert.equal(res.json.status, 'not_sent');
        assert.equal(res.json.consumedBy, OTHER);
        assert.equal(res.json.consumedBlock, '103');
        assert.deepEqual(res.json.hashes, [sent.hash, bumped]);
      }

      res = await s.call('GET', `/sends/0x${'0'.repeat(64)}`);
      assert.equal(res.status, 404);
      assert.deepEqual(res.json, { error: 'not_found', reason: 'send_not_found' });
      res = await s.call('GET', '/sends/0x1234');
      assert.equal(res.status, 404);
      res = await s.call('GET', `/sends/${sent.hash}`, undefined, null);
      assert.equal(res.status, 401);
    } finally {
      await s.close();
    }
  });

  test('release-proof: GET /sends/:hash answers mined with the hash that mined, and stuck as pending with stuck true', async () => {
    const ctx = setup({ node: { me: RELAYER_ACCOUNT.address } });
    const s = await startStub({ chains: ctx.node.chains });
    try {
      const sent = await s.queue.enqueue(CHAIN, () => tx(), { reservation: s.cap.reserve(CHAIN, 10n ** 6n) });
      for (let i = 0; i < 4; i += 1) {
        ctx.node.state.block += 12n;
        await s.queue.tick();
      }
      let res = await s.call('GET', `/sends/${sent.hash}`);
      assert.equal(res.json.status, 'pending');
      assert.equal(res.json.stuck, true);
      ctx.node.state.receipts[sent.hash] = inBlock(ctx.node, receipt(sent.hash));
      await s.queue.tick();
      res = await s.call('GET', `/sends/${s.db.listPending()[0].hashes.at(-1)}`);
      assert.equal(res.json.status, 'mined');
      assert.equal(res.json.minedHash, sent.hash);
      assert.equal(res.json.consumedBy, undefined);
    } finally {
      await s.close();
    }
  });
});

