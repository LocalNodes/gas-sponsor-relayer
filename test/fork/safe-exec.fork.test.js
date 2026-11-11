import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress, parseEther, zeroAddress } from 'viem';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { account, CHAIN_ID, deploySafe, forkClients, signRegistration, signSafeTx, startRelayer } from '../helpers/fork.js';

describe('safe-exec (fork)', () => {
  let pub;
  let wallet;
  let relayer;
  let registered;
  let unregistered;
  const owners = [account(0), account(1)];

  before(async () => {
    const clients = await forkClients();
    pub = clients.pub;
    wallet = clients.wallet;
    relayer = await startRelayer();
    registered = await deploySafe(pub, wallet, owners, 2);
    unregistered = await deploySafe(pub, wallet, owners, 2);
    for (const s of [registered, unregistered]) {
      const hash = await wallet(account(2)).sendTransaction({ to: s, value: parseEther('0.01') });
      await pub.waitForTransactionReceipt({ hash });
    }
    const signature = await signRegistration({ relayer: relayer.relayer, safe: registered, space: 'exec-valid.eth', signers: owners });
    const reg = await relayer.call('POST', '/groups', { chainId: CHAIN_ID, safe: registered, space: 'exec-valid.eth', signature });
    assert.equal(reg.status, 201, reg.text);
  });
  after(async () => {
    await relayer?.close();
  });

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

  test('safe-exec: a registered Safe pays 0.001 ETH and the relayer pays the gas', async () => {
    const payee = getAddress(privateKeyToAddress(generatePrivateKey()));
    const tx = payment(payee);
    const signatures = await signSafeTx(pub, registered, tx, owners);
    const safeBefore = await pub.getBalance({ address: registered });
    const relayerBefore = await pub.getBalance({ address: relayer.relayer });

    const res = await relayer.call('POST', '/send/safe-exec', wire(registered, tx, signatures));
    assert.equal(res.status, 202, res.text);
    assert.match(res.json.hash, /^0x[0-9a-f]{64}$/);

    const receipt = await pub.waitForTransactionReceipt({ hash: res.json.hash });
    assert.equal(receipt.status, 'success');
    assert.equal(await pub.getBalance({ address: payee }), parseEther('0.001'));
    assert.equal(await pub.getBalance({ address: registered }), safeBefore - parseEther('0.001'), 'the Safe paid no gas');
    assert.ok((await pub.getBalance({ address: relayer.relayer })) < relayerBefore, 'the relayer paid the gas');
  });

  test('safe-exec: an unregistered Safe is refused with 403 and nothing is sent', async () => {
    const payee = getAddress(privateKeyToAddress(generatePrivateKey()));
    const tx = payment(payee);
    const signatures = await signSafeTx(pub, unregistered, tx, owners);
    const nonceBefore = await pub.getTransactionCount({ address: relayer.relayer, blockTag: 'pending' });
    const safeBefore = await pub.getBalance({ address: unregistered });

    const res = await relayer.call('POST', '/send/safe-exec', wire(unregistered, tx, signatures));
    assert.equal(res.status, 403, res.text);
    assert.equal(await pub.getTransactionCount({ address: relayer.relayer, blockTag: 'pending' }), nonceBefore);
    assert.equal(await pub.getBalance({ address: unregistered }), safeBefore);
    assert.equal(await pub.getBalance({ address: payee }), 0n);
  });
});
