// 25-28 fix round 2, HIGH 2 (Codex round 2): the first broadcast and every replacement of one send run one at a
// time. While a broadcast's answer is outstanding nothing else is sent for that row, and an older broadcast's answer
// can never delete or overwrite newer state of the row.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAIN, flush, hashOf, inBlock, receipt, refusal, settle, setup, spentDay, tx } from '../helpers/node.js';

describe('round 2 HIGH 2: one broadcast at a time per send', () => {
  test('serialise: Codex repro: while the first answer is delayed, 12 blocks pass and the poll loop runs: no fee bump is sent', async () => {
    const { db, cap, node, queue } = setup({ node: { defer: true } });
    const reservation = cap.reserve(CHAIN, 1000n);
    const job = settle(queue.enqueue(CHAIN, () => tx(), { reservation }));
    await flush();
    assert.ok(node.state.answer, 'the first broadcast is waiting for its answer');
    node.state.block += 12n;
    await queue.tick();
    node.state.block += 12n;
    await queue.tick();
    assert.equal(node.state.sent.length, 0, 'no replacement went out while the first broadcast was unanswered');
    const row = db.listPending()[0];
    assert.equal(row.attempts, 0);
    assert.equal(row.hashes.length, 1);

    // The original is then refused. Nothing of this send is live, so its row goes and the caller gives the reservation back.
    node.state.answer(refusal('replacement transaction underpriced'));
    const out = await job;
    assert.ok(out.error);
    assert.equal(db.listPending().length, 0);
    assert.equal(node.state.sent.length, 0);
  });

  test('serialise: Codex repro: a replacement accepted while the original\'s answer was delayed survives the original\'s refusal, with the row and the reservation', async () => {
    const { db, cap, node, queue } = setup({ node: { defer: true } });
    const reservation = cap.reserve(CHAIN, 1200n);
    const job = settle(queue.enqueue(CHAIN, () => tx(), { reservation }));
    await flush();
    // Newer state of the row: a replacement accepted by the node while the original's answer was still out.
    const row = db.listPending()[0];
    const bumped = tx({ nonce: row.nonce, maxFeePerGas: 12n, maxPriorityFeePerGas: 2n });
    node.state.sent.push(bumped);
    db.updatePending(row.id, { ...row, hash: hashOf(bumped), hashes: [...row.hashes, hashOf(bumped)], maxFeePerGas: 12n, maxPriorityFeePerGas: 2n, attempts: 1 });

    node.state.answer(refusal('replacement transaction underpriced'));
    const out = await job;
    assert.equal(out.error, undefined, 'the send is live under its replacement: it is not reported as failed');
    const rows = db.listPending();
    assert.equal(rows.length, 1, 'the row survives');
    assert.equal(rows[0].hash, hashOf(bumped), 'the older answer did not overwrite the newer hash');
    assert.equal(rows[0].attempts, 1);
    assert.equal(spentDay(cap), 1200n, 'the reservation survives');
  });

  test('serialise: reconcile does not broadcast a send whose first answer is still outstanding', async () => {
    const { db, cap, node, queue } = setup({ node: { defer: true } });
    const job = settle(queue.enqueue(CHAIN, () => tx(), { reservation: cap.reserve(CHAIN, 1000n) }));
    await flush();
    // The node does not show the send yet (pending count 5 = its nonce), so reconcile would send it again.
    const r = await queue.reconcile();
    assert.equal(r.rebroadcast, 0);
    assert.equal(node.state.sent.length, 0);
    node.state.answer();
    const out = await job;
    assert.equal(out.error, undefined);
    assert.equal(node.state.sent.length, 1, 'one broadcast');
    assert.equal(db.listPending().length, 1);
  });

  test('serialise: a row the poll loop listed, then deleted by its first broadcast\'s refusal while the loop waited, is never acted on', async () => {
    const { db, cap, node, queue } = setup({ node: { defer: true } });
    const job = settle(queue.enqueue(CHAIN, () => tx(), { reservation: cap.reserve(CHAIN, 10n ** 6n) }));
    await flush();
    node.state.block = 112n; // old enough to be bumped
    let open;
    node.state.blockGate = new Promise((r) => { open = r; });
    const pass = queue.tick(); // lists the row, then waits for the head block
    await flush();
    node.state.answer(refusal('insufficient funds for gas * price + value'));
    assert.ok((await job).error, 'refused: the row is gone');
    assert.equal(db.listPending().length, 0);
    node.state.blockGate = null;
    open();
    await pass;
    assert.equal(node.state.sent.length, 0, 'no bump of a row that no longer exists');
    assert.equal(db.listPending().length, 0);
  });

  test('serialise: the poll loop and reconcile leave a row alone while its first answer is outstanding, even with its receipt visible', async () => {
    for (const step of ['tick', 'reconcile']) {
      const { db, cap, node, queue } = setup({ node: { defer: true } });
      const job = settle(queue.enqueue(CHAIN, () => tx(), { reservation: cap.reserve(CHAIN, 1000n) }));
      await flush();
      const { hash } = db.listPending()[0];
      node.state.receipts[hash] = inBlock(node, receipt(hash));
      node.state.latest = 6;
      await queue[step]();
      assert.equal(db.listPending()[0].status, 'pending', `${step}: untouched while the broadcast is on its way`);
      assert.equal(spentDay(cap), 1000n, step);
      node.state.answer();
      await job;
      await queue.tick();
      assert.equal(db.listPending()[0].status, 'mined', step);
      assert.equal(spentDay(cap), 150n, step);
    }
  });

  test('serialise: once the first answer is in, the poll loop bumps the send as before', async () => {
    const { db, cap, node, queue } = setup({ node: { defer: true } });
    const job = settle(queue.enqueue(CHAIN, () => tx(), { reservation: cap.reserve(CHAIN, 10n ** 6n) }));
    await flush();
    node.state.answer();
    await job;
    node.state.block += 12n;
    await queue.tick();
    assert.equal(node.state.sent.length, 2);
    assert.equal(db.listPending()[0].attempts, 1);
  });
});
