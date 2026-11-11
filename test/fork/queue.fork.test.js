// Cap reserve, serial queue and spend recording, end to end on the Sepolia fork (25-05, D-19).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress, parseEther, zeroAddress } from 'viem';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { account, CHAIN_ID, deploySafe, forkClients, settleSends, signRegistration, signSafeTx, startRelayer, untilFinalized } from '../helpers/fork.js';

describe('queue (fork)', () => {
  let pub;
  let wallet;
  let relayer;
  let capped;
  const owners = [account(0), account(1)];
  const safes = {};

  const payment = (to) => ({
    to,
    value: parseEther('0.001'),
    data: '0x',
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: zeroAddress,
    refundReceiver: zeroAddress,
  });
  const wire = (safe, tx, signatures) => ({
    chainId: CHAIN_ID,
    safe,
    to: tx.to,
    value: tx.value.toString(),
    data: tx.data,
    operation: tx.operation,
    safeTxGas: tx.safeTxGas.toString(),
    baseGas: tx.baseGas.toString(),
    gasPrice: tx.gasPrice.toString(),
    gasToken: tx.gasToken,
    refundReceiver: tx.refundReceiver,
    signatures,
  });
  const fresh = () => getAddress(privateKeyToAddress(generatePrivateKey()));
  const rpc = (method, params = []) => pub.request({ method, params });

  async function register(r, safe, space) {
    const signature = await signRegistration({ relayer: r.relayer, safe, space, signers: owners });
    const res = await r.call('POST', '/groups', { chainId: CHAIN_ID, safe, space, signature });
    assert.equal(res.status, 201, res.text);
  }

  before(async () => {
    const clients = await forkClients();
    pub = clients.pub;
    wallet = clients.wallet;
    relayer = await startRelayer();
    // A tiny day cap: every reservation is above 1 wei.
    capped = await startRelayer({ SPONSOR_RELAYER_CAP_DAY_WEI: '1' });
    for (const name of ['a', 'b', 'c', 'd']) {
      safes[name] = await deploySafe(pub, wallet, owners, 2);
      const hash = await wallet(account(2)).sendTransaction({ to: safes[name], value: parseEther('0.01') });
      await pub.waitForTransactionReceipt({ hash });
    }
    await register(relayer, safes.a, 'queue-a.eth');
    await register(relayer, safes.b, 'queue-b.eth');
    await register(relayer, safes.d, 'queue-d.eth');
    await register(capped, safes.c, 'queue-c.eth');
  });
  after(async () => {
    await rpc('anvil_setAutomine', [true]).catch(() => {});
    await relayer?.close();
    await capped?.close();
  });

  test('queue: two sends at the same moment get consecutive nonces and /status shows the receipts\' gas', async () => {
    const before = await pub.getTransactionCount({ address: relayer.relayer, blockTag: 'pending' });
    const txA = payment(fresh());
    const txB = payment(fresh());
    const sigA = await signSafeTx(pub, safes.a, txA, owners);
    const sigB = await signSafeTx(pub, safes.b, txB, owners);
    const [r1, r2] = await Promise.all([
      relayer.call('POST', '/send/safe-exec', wire(safes.a, txA, sigA)),
      relayer.call('POST', '/send/safe-exec', wire(safes.b, txB, sigB)),
    ]);
    assert.equal(r1.status, 202, r1.text);
    assert.equal(r2.status, 202, r2.text);
    const txs = await Promise.all([pub.getTransaction({ hash: r1.json.hash }), pub.getTransaction({ hash: r2.json.hash })]);
    assert.deepEqual(txs.map((t) => t.nonce).sort((x, y) => x - y), [before, before + 1]);
    const receipts = await Promise.all([r1, r2].map((r) => pub.waitForTransactionReceipt({ hash: r.json.hash })));
    for (const rc of receipts) assert.equal(rc.status, 'success');

    // The cap settles a receipt once its block is finalized (25-28 round 3, #2).
    await settleSends(pub, relayer);
    const expected = receipts.reduce((sum, rc) => sum + rc.gasUsed * rc.effectiveGasPrice, 0n);
    const status = await relayer.call('GET', '/status');
    assert.equal(status.status, 200, status.text);
    assert.equal(status.json.cap.spentDayWei, expected.toString());
    assert.equal(status.json.cap.spentMonthWei, expected.toString());
    assert.equal(status.json.cap.dayWei, '50000000000000000');
    assert.equal(status.json.cap.monthWei, '500000000000000000');
    assert.match(status.json.cap.dayResetsAt, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
    assert.match(status.json.cap.monthResetsAt, /^\d{4}-\d\d-01T00:00:00\.000Z$/);
  });

  test('queue: a send over the cap answers 429 with an ISO until time and nothing is broadcast', async () => {
    const tx = payment(fresh());
    const signatures = await signSafeTx(pub, safes.c, tx, owners);
    const nonceBefore = await pub.getTransactionCount({ address: capped.relayer, blockTag: 'pending' });
    const safeBefore = await pub.getBalance({ address: safes.c });
    const res = await capped.call('POST', '/send/safe-exec', wire(safes.c, tx, signatures));
    assert.equal(res.status, 429, res.text);
    assert.equal(new Date(res.json.until).toISOString(), res.json.until);
    assert.equal(await pub.getTransactionCount({ address: capped.relayer, blockTag: 'pending' }), nonceBefore);
    assert.equal(await pub.getBalance({ address: safes.c }), safeBefore);
  });

  test('queue: a send dropped from the pool is resent with the same nonce and higher fees after 12 blocks, then mines', async () => {
    const payee = fresh();
    const tx = payment(payee);
    const signatures = await signSafeTx(pub, safes.d, tx, owners);
    try {
      await rpc('anvil_setAutomine', [false]);
      const res = await relayer.call('POST', '/send/safe-exec', wire(safes.d, tx, signatures));
      assert.equal(res.status, 202, res.text);
      const original = await pub.getTransaction({ hash: res.json.hash });
      await rpc('anvil_dropTransaction', [res.json.hash]);
      await rpc('anvil_setAutomine', [true]);
      await rpc('anvil_mine', ['0xc']);

      await relayer.queue.tick();
      const row = relayer.db.listPending().find((p) => p.hash !== res.json.hash && p.nonce === original.nonce);
      assert.ok(row, `a resent pending entry with the same nonce and a new hash; logs: ${relayer.logs.slice(-4).join(' / ')}; rows: ${JSON.stringify(relayer.db.listPending().map((p) => [p.nonce, p.status, p.attempts, p.sentBlock]))}`);
      assert.equal(row.attempts, 1);
      assert.ok(BigInt(row.maxFeePerGas) > original.maxFeePerGas, 'fees went up');
      assert.ok(BigInt(row.maxPriorityFeePerGas) > original.maxPriorityFeePerGas, 'the tip went up');

      const receipt = await pub.waitForTransactionReceipt({ hash: row.hash });
      assert.equal(receipt.status, 'success');
      assert.equal((await pub.getTransaction({ hash: row.hash })).nonce, original.nonce);
      assert.equal(await pub.getBalance({ address: payee }), parseEther('0.001'));
      // A receipt settles only once its block is finalized (25-28 round 3, #2); anvil's finalized tag trails latest.
      await untilFinalized(pub, receipt.blockNumber);
      await relayer.queue.tick();
      assert.equal(relayer.db.listPending().find((p) => p.hash === row.hash).status, 'mined');
    } finally {
      await rpc('anvil_setAutomine', [true]);
    }
  });
});
