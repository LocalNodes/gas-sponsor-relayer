// 25-28 round 3, #5 (Codex round 3 MEDIUM 5): a stuck send keeps its nonce, and a waiter only ever accepts a receipt
// of its own send.
// - Nonce allocation counted only `pending` rows. A stuck send the node had forgotten gave its nonce to the next
//   request, so two different sends, A and B, both held nonce 5.
// - The waiters (pipeline.waitMined for Reality and reclaim, the ENS job's) looked up "the newest row at this chain
//   and nonce" and used its hashes, so waitMined(A) returned B's receipt and a flow went on after an unrelated
//   transaction. They now use the hashes of the row that holds the send's own hash, and nothing else.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createPipeline } from '../../src/sends/pipeline.js';
import { CHAIN, ME, quiet, receipt, setup, tx } from '../helpers/node.js';

const A = `0x${'a1'.repeat(32)}`;
const B = `0x${'b2'.repeat(32)}`;

/** A send row stored as the queue stores one, at `nonce`, with its one hash. */
const row = (db, hash, nonce, o = {}) => db.insertPending({ chainId: CHAIN, nonce, hash, to: ME, data: '0x', value: 0n, gas: 100n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n, sentBlock: 100n, kind: 'send', ...o });

describe('round 3 #5: a stuck send keeps its nonce', () => {
  test('nonce-binding: Codex repro: a stuck send the node forgot keeps nonce 5; the next send gets 6, not 5', async () => {
    const { db, node, queue } = setup();
    const first = await queue.enqueue(CHAIN, () => tx(), {});
    assert.equal(first.nonce, 5);
    for (let i = 0; i < 4; i += 1) {
      node.state.block += 12n;
      await queue.tick();
    }
    assert.equal(db.listPending()[0].status, 'stuck');
    // The node forgets the stuck send: its pending count is back at 5.
    node.state.pending = 5;
    node.state.latest = 5;
    const second = await queue.enqueue(CHAIN, () => tx({ data: '0x01' }), {});
    assert.equal(second.nonce, 6, 'the stuck send still holds nonce 5');
  });
});

describe('round 3 #5: a waiter accepts only its own send\'s receipt', () => {
  test('nonce-binding: Codex repro: sends A and B both at nonce 5, B mined: waitMined(A) never returns B\'s receipt', async () => {
    const { db, cap, node, queue } = setup();
    row(db, A, 5);
    row(db, B, 5); // the newer row at this nonce
    node.state.receipts[B] = receipt(B);
    const pipe = createPipeline({ config: { address: ME }, db, chains: node.chains, cap, queue, logger: quiet, sleep: async () => {}, timeoutMs: 20 });
    await assert.rejects(pipe.waitMined(CHAIN, { hash: A, nonce: 5 }), /timeout/);
    assert.ok(!node.state.reads.some((r) => r[1] === 'receipt' && r[2] === B), 'B\'s hash is never looked up for A');

    node.state.receipts[A] = receipt(A, 70n);
    const got = await pipe.waitMined(CHAIN, { hash: A, nonce: 5 });
    assert.equal(got.transactionHash, A);
  });

  test('nonce-binding: waitMined follows the send\'s own fee bumps (its row\'s hashes), whatever its nonce now holds', async () => {
    const { db, cap, node, queue } = setup();
    const id = row(db, A, 5);
    const bumped = `0x${'a3'.repeat(32)}`;
    db.updatePending(id, { ...db.getPending(id), hashes: [A, bumped], hash: bumped });
    row(db, B, 5);
    node.state.receipts[B] = receipt(B);
    node.state.receipts[bumped] = receipt(bumped, 80n);
    const pipe = createPipeline({ config: { address: ME }, db, chains: node.chains, cap, queue, logger: quiet, sleep: async () => {}, timeoutMs: 20 });
    const got = await pipe.waitMined(CHAIN, { hash: A, nonce: 5 });
    assert.equal(got.transactionHash, bumped);
  });
});
