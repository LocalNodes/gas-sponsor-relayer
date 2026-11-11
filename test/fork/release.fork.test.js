// 25-28 fix round 2, HIGH 4 on a real node (the anvil fork; the ruling's two fork tests):
// - a send whose nonce another transaction took is released, and only once that transaction is in a block at or
//   below `finalized`; GET /sends/:hash then answers not_sent with the consuming hash;
// - a send whose own transaction mined while its receipt lookups read "not found" (a lagging index) is never
//   released; once the receipt is readable, the real cost is recorded.
// 25-28 round 3 adds two:
// - #2: a receipt whose block is reorged out (evm_revert, then another block at that height) puts the send back to
//   pending with its whole reservation; the send mines again and settles to its real cost only once final;
// - #3: an endpoint whose block by number is not on the finalized chain (a lagging backend still showing a side block
//   with another transaction at the nonce) releases nothing.
// Only anvil's public dev keys sign here, and only on the local fork.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress, TransactionReceiptNotFoundError } from 'viem';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { CHAIN_ID, forkClients, RELAYER_ACCOUNT, startRelayer, untilFinalized } from '../helpers/fork.js';

const RESERVED = 10n ** 15n;

describe('release proof (fork)', () => {
  let pub;
  let wallet;
  let relayer;
  const rpc = (method, params = []) => pub.request({ method, params });
  const fresh = () => getAddress(privateKeyToAddress(generatePrivateKey()));
  const spent = async () => BigInt((await relayer.call('GET', '/status')).json.cap.spentDayWei);

  before(async () => {
    ({ pub, wallet } = await forkClients());
    relayer = await startRelayer();
  });
  after(async () => {
    await rpc('anvil_setAutomine', [true]).catch(() => {});
    await relayer?.close();
  });

  /** Mine until the node's `finalized` block reaches `block`. anvil's finalized tag trails latest. */
  async function finalize(block, rounds = 40) {
    for (let i = 0; i < rounds; i += 1) {
      const f = await pub.getBlock({ blockTag: 'finalized' });
      if (f.number >= block) return f.number;
      await rpc('anvil_mine', ['0x10']);
    }
    throw new Error(`finalized never reached block ${block}`);
  }

  /**
   * One plain sponsored send through the relayer's queue, with a reservation of RESERVED wei. It carries no value: on
   * the Sepolia fork at the pinned block (11-11 run on the Pocket source) anvil's default accounts carry an EIP-7702
   * delegation, and every value transfer from them reverts, while a zero-value one succeeds.
   */
  async function send() {
    const fees = await pub.estimateFeesPerGas();
    const reservation = relayer.cap.reserve(CHAIN_ID, RESERVED);
    const sent = await relayer.queue.enqueue(
      CHAIN_ID,
      () => ({ to: fresh(), data: '0x', value: 0n, gas: 21000n, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas }),
      { reservation },
    );
    return sent;
  }

  test('release-fork: a send replaced by another transaction with its nonce is released once that transaction is finalized, and reads not_sent', async () => {
    const before = await spent();
    let sent;
    let other;
    try {
      await rpc('anvil_setAutomine', [false]);
      sent = await send();
      assert.equal(await spent(), before + RESERVED);
      // The node loses the relayer's send; another transaction from the same key takes its nonce.
      await rpc('anvil_dropTransaction', [sent.hash]);
      const fees = await pub.estimateFeesPerGas();
      other = await wallet(RELAYER_ACCOUNT).sendTransaction({
        to: fresh(), value: 2n, nonce: sent.nonce, gas: 21000n, maxFeePerGas: fees.maxFeePerGas * 2n, maxPriorityFeePerGas: fees.maxPriorityFeePerGas * 2n,
      });
    } finally {
      await rpc('anvil_setAutomine', [true]);
    }
    await rpc('anvil_mine', ['0x1']);
    const rc = await pub.waitForTransactionReceipt({ hash: other });
    assert.equal((await pub.getTransaction({ hash: other })).nonce, sent.nonce);

    // Not yet finalized: the send keeps its reservation.
    const fin = await pub.getBlock({ blockTag: 'finalized' });
    if (fin.number < rc.blockNumber) {
      await relayer.queue.tick();
      assert.equal(relayer.db.listPending().find((r) => r.hash === sent.hash).status, 'pending', 'not released before finality');
      assert.equal(await spent(), before + RESERVED);
    }

    await finalize(rc.blockNumber);
    await relayer.queue.tick();
    const row = relayer.db.findPendingByHash(sent.hash);
    assert.equal(row.status, 'replaced', `logs: ${relayer.logs.slice(-4).join(' / ')}`);
    assert.equal(row.consumedBy, other.toLowerCase());
    assert.equal(BigInt(row.consumedBlock), rc.blockNumber);
    assert.equal(await spent(), before, 'the reservation is given back');

    const res = await relayer.call('GET', `/sends/${sent.hash}`);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.status, 'not_sent');
    assert.equal(res.json.consumedBy, other.toLowerCase());
  });

  test('release-fork: a send that mined while its receipt lookups read "not found" is never released; the receipt then settles its real cost', async () => {
    const before = await spent();
    const sent = await send();
    const rc = await pub.waitForTransactionReceipt({ hash: sent.hash });
    assert.equal(rc.status, 'success');

    // A lagging receipt index, on both of the relayer's read clients.
    const clients = relayer.chains.get(CHAIN_ID);
    const patched = [clients.publicClient, clients.proofClient];
    const originals = patched.map((c) => c.getTransactionReceipt);
    patched.forEach((c, i) => {
      c.getTransactionReceipt = async (args) => {
        if (String(args.hash).toLowerCase() === sent.hash.toLowerCase()) throw new TransactionReceiptNotFoundError({ hash: args.hash });
        return originals[i].call(c, args);
      };
    });
    try {
      await finalize(rc.blockNumber);
      for (let i = 0; i < 3; i += 1) {
        await rpc('anvil_mine', ['0x4']);
        await relayer.queue.tick();
      }
      const row = relayer.db.findPendingByHash(sent.hash);
      assert.notEqual(row.status, 'replaced', 'our own transaction took the nonce: never released');
      assert.notEqual(row.status, 'mined');
      assert.ok((await spent()) >= before + RESERVED, 'the reservation is held');
      const res = await relayer.call('GET', `/sends/${sent.hash}`);
      assert.equal(res.json.status, 'pending');
    } finally {
      patched.forEach((c, i) => { c.getTransactionReceipt = originals[i]; });
    }

    await relayer.queue.tick();
    const row = relayer.db.findPendingByHash(sent.hash);
    assert.equal(row.status, 'mined');
    assert.equal(await spent(), before + rc.gasUsed * rc.effectiveGasPrice, 'the real cost replaced the reservation');
    const res = await relayer.call('GET', `/sends/${sent.hash}`);
    assert.equal(res.json.status, 'mined');
    assert.equal(res.json.minedHash, sent.hash);
  });

  test('release-fork: round 3 #2: a receipt whose block is reorged out sends the send back to pending with its maximum; it settles only once final', async () => {
    const before = await spent();
    const snap = await rpc('evm_snapshot');
    const sent = await send();
    const rc = await pub.waitForTransactionReceipt({ hash: sent.hash });
    await relayer.queue.tick();
    let row = relayer.db.findPendingByHash(sent.hash);
    assert.equal(row.status, 'confirming', `anvil's finalized block trails the receipt; logs: ${relayer.logs.slice(-3).join(' / ')}`);
    assert.equal(await spent(), before + RESERVED, 'the maximum is held while the receipt is not final');
    let res = await relayer.call('GET', `/sends/${sent.hash}`);
    assert.equal(res.json.status, 'mined');
    assert.equal(res.json.finalized, false);

    // The reorg: back to before the send, then another block at the receipt's height.
    await rpc('evm_revert', [snap]);
    await rpc('anvil_mine', ['0x2']);
    assert.notEqual((await pub.getBlock({ blockNumber: rc.blockNumber })).hash, rc.blockHash, 'another block at that height');
    await relayer.queue.tick();
    row = relayer.db.findPendingByHash(sent.hash);
    assert.equal(row.status, 'pending', `logs: ${relayer.logs.slice(-3).join(' / ')}`);
    assert.equal(await spent(), before + RESERVED, 'with its maximum still held');
    assert.ok(relayer.db.listEvents().some((e) => e.kind === 'send_reorged'));

    // The same signed transaction goes out again (the node lost it) and mines in a new block.
    const again = await pub.getTransactionReceipt({ hash: sent.hash }).catch(() => null);
    if (!again) await relayer.queue.reconcile();
    const rc2 = await pub.waitForTransactionReceipt({ hash: sent.hash });
    await relayer.queue.tick();
    assert.ok(['confirming', 'mined'].includes(relayer.db.findPendingByHash(sent.hash).status));
    await untilFinalized(pub, rc2.blockNumber);
    await relayer.queue.tick();
    row = relayer.db.findPendingByHash(sent.hash);
    assert.equal(row.status, 'mined');
    assert.equal(await spent(), before + rc2.gasUsed * rc2.effectiveGasPrice, 'the real cost of the receipt that stayed');
    res = await relayer.call('GET', `/sends/${sent.hash}`);
    assert.equal(res.json.finalized, true);
  });

  test('release-fork: round 3 #3: a block by number that is not on the finalized chain releases nothing', async () => {
    const before = await spent();
    const nonce = await pub.getTransactionCount({ address: RELAYER_ACCOUNT.address, blockTag: 'pending' });
    // A side block: another transaction of the relayer's key at the nonce the next send will take, then reverted.
    const snap = await rpc('evm_snapshot');
    const fees = await pub.estimateFeesPerGas();
    const other = await wallet(RELAYER_ACCOUNT).sendTransaction({
      to: fresh(), value: 3n, nonce, gas: 21000n, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
    const side = await pub.getBlock({ blockNumber: (await pub.waitForTransactionReceipt({ hash: other })).blockNumber, includeTransactions: true });
    await rpc('evm_revert', [snap]);

    // Our own send takes that nonce in the canonical block at the same height, which is then finalized.
    const sent = await send();
    assert.equal(sent.nonce, nonce);
    const rc = await pub.waitForTransactionReceipt({ hash: sent.hash });
    assert.equal(rc.blockNumber, side.number, 'the same height');
    assert.notEqual(rc.blockHash, side.hash);
    await untilFinalized(pub, rc.blockNumber);

    // The proof endpoint behaves like a lagging backend: by number it still shows the side block, and no receipt of
    // our own hash is indexed on either read client yet.
    const clients = relayer.chains.get(CHAIN_ID);
    const getBlock = clients.proofClient.getBlock;
    clients.proofClient.getBlock = async (args) => (args?.blockNumber === side.number ? side : getBlock.call(clients.proofClient, args));
    const patched = [clients.publicClient, clients.proofClient];
    const originals = patched.map((c) => c.getTransactionReceipt);
    patched.forEach((c, i) => {
      c.getTransactionReceipt = async (args) => {
        if (String(args.hash).toLowerCase() === sent.hash.toLowerCase()) throw new TransactionReceiptNotFoundError({ hash: args.hash });
        return originals[i].call(c, args);
      };
    });
    try {
      await relayer.queue.tick();
      const row = relayer.db.findPendingByHash(sent.hash);
      assert.equal(row.status, 'pending', `the side block is not on the finalized chain; logs: ${relayer.logs.slice(-3).join(' / ')}`);
      assert.equal(await spent(), before + RESERVED, 'nothing released');
    } finally {
      clients.proofClient.getBlock = getBlock;
      patched.forEach((c, i) => { c.getTransactionReceipt = originals[i]; });
    }

    await relayer.queue.tick();
    assert.equal(relayer.db.findPendingByHash(sent.hash).status, 'mined');
    assert.equal(await spent(), before + rc.gasUsed * rc.effectiveGasPrice);
  });
});
