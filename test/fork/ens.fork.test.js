// The relayer pays for an ENSv2 name and the Group's Safe owns it from the register call (D-08, TM-76).
// Runs against a Sepolia fork. The wait between commit and register is advanced with anvil's clock.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress, parseAbi, toHex } from 'viem';
import { packetToBytes } from 'viem/ens';
import { randomBytes } from 'node:crypto';
import { account, CHAIN_ID, deploySafe, forkClients, signRegistration, startRelayer } from '../helpers/fork.js';
import { loadNetworks } from '../../src/config.js';

process.env.WEB3_ENABLED = 'true';

const net = loadNetworks()[String(CHAIN_ID)];
const helperAbi = parseAbi(['function findExactOwner(bytes name) view returns (address)']);
const registrarAbi = parseAbi([
  'function isAvailable(string label) view returns (bool)',
  'function MIN_COMMITMENT_AGE() view returns (uint256)',
]);
const tokenAbi = parseAbi(['function balanceOf(address account) view returns (uint256)']);

async function until(fn, what, ms = 90_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe('ens (fork)', () => {
  let pub;
  let wallet;
  let relayer;
  let safe;
  const owners = [account(0), account(1)];
  const label = `gov-ens-${randomBytes(4).toString('hex')}`;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });

  before(async () => {
    const clients = await forkClients();
    pub = clients.pub;
    wallet = clients.wallet;
    // The relayer waits between commit and register by asking for this hook: hold it until the test has looked at the
    // committed job, then move anvil's clock past MIN_COMMITMENT_AGE + 1 s and mine a block.
    relayer = await startRelayer({}, {
      ensWait: async ({ target }) => {
        await gate;
        const latest = await pub.getBlock();
        if (latest.timestamp < target) {
          await pub.request({ method: 'evm_increaseTime', params: [Number(target - latest.timestamp)] });
        }
        await pub.request({ method: 'evm_mine', params: [] });
      },
    });
    safe = await deploySafe(pub, wallet, owners, 2);
    const signature = await signRegistration({ relayer: relayer.relayer, safe, space: `${label}.eth`, signers: owners });
    const reg = await relayer.call('POST', '/groups', { chainId: CHAIN_ID, safe, space: `${label}.eth`, signature });
    assert.equal(reg.status, 201, reg.text);
  });
  after(async () => {
    release?.();
    await relayer?.close();
  });

  test('ens: refusals happen before anything is sent', async () => {
    const nonceBefore = await pub.getTransactionCount({ address: relayer.relayer, blockTag: 'pending' });
    for (const [body, status, reason] of [
      [{ chainId: CHAIN_ID, safe, label: 'Bad-Label' }, 400, 'invalid_label'],
      [{ chainId: CHAIN_ID, safe, label: 'another-name' }, 403, 'label_not_space'],
      [{ chainId: 84532, safe, label }, 403, 'no_ens_on_network'],
    ]) {
      const res = await relayer.call('POST', '/send/ens', body);
      assert.equal(res.status, status, res.text);
      assert.equal(res.json.reason, reason);
    }
    assert.equal(await pub.getTransactionCount({ address: relayer.relayer, blockTag: 'pending' }), nonceBefore);
  });

  test('ens: the relayer registers <label>.eth to the Safe and GET /jobs/:id reports committed, then registered', async () => {
    assert.equal(await pub.readContract({ address: net.ensRegistrar, abi: registrarAbi, functionName: 'isAvailable', args: [label] }), true, 'the label is free');
    const relayerEthBefore = await pub.getBalance({ address: relayer.relayer });
    const relayerTokenBefore = await pub.readContract({ address: net.ensPaymentToken, abi: tokenAbi, functionName: 'balanceOf', args: [relayer.relayer] });

    const res = await relayer.call('POST', '/send/ens', { chainId: CHAIN_ID, safe, label });
    assert.equal(res.status, 202, res.text);
    const { jobId } = res.json;
    assert.match(jobId, /^[0-9a-f]{32}$/);

    const committed = await until(async () => {
      const j = await relayer.call('GET', `/jobs/${jobId}`);
      assert.notEqual(j.json.status, 'failed', j.text);
      return j.json.status === 'committed' ? j.json : null;
    }, 'status committed');
    assert.equal(committed.txHashes.length, 3, 'mint, approve, commit');
    for (const h of committed.txHashes) assert.equal((await pub.getTransactionReceipt({ hash: h })).status, 'success');

    release();
    const done = await until(async () => {
      const j = await relayer.call('GET', `/jobs/${jobId}`);
      assert.notEqual(j.json.status, 'failed', j.text);
      return j.json.status === 'registered' ? j.json : null;
    }, 'status registered');
    assert.ok(done.txHashes.length >= 3);
    assert.equal(done.txHashes.length, 4);
    assert.equal(done.label, label);
    assert.equal(done.safe, safe);

    // The Safe owns the name; it was never the relayer's.
    const owner = await pub.readContract({ address: net.ensUniversalHelper, abi: helperAbi, functionName: 'findExactOwner', args: [toHex(packetToBytes(`${label}.eth`))] });
    assert.equal(getAddress(owner), safe);
    assert.notEqual(getAddress(owner), relayer.relayer);
    assert.equal(await pub.readContract({ address: net.ensRegistrar, abi: registrarAbi, functionName: 'isAvailable', args: [label] }), false);

    // The wait was at least MIN_COMMITMENT_AGE + 1 s on the chain's clock.
    const age = await pub.readContract({ address: net.ensRegistrar, abi: registrarAbi, functionName: 'MIN_COMMITMENT_AGE' });
    const [commitRc, registerRc] = await Promise.all([done.txHashes[2], done.txHashes[3]].map((hash) => pub.getTransactionReceipt({ hash })));
    const [commitBlock, registerBlock] = await Promise.all([commitRc, registerRc].map((rc) => pub.getBlock({ blockNumber: rc.blockNumber })));
    assert.ok(registerBlock.timestamp - commitBlock.timestamp >= age + 1n, `register came ${registerBlock.timestamp - commitBlock.timestamp} s after commit`);

    // The relayer paid: gas in ETH, the price in the payment token (minted on this testnet, then spent).
    assert.ok((await pub.getBalance({ address: relayer.relayer })) < relayerEthBefore);
    // Minted exactly the price, then paid exactly the price: the relayer's token balance is where it started.
    assert.equal(await pub.readContract({ address: net.ensPaymentToken, abi: tokenAbi, functionName: 'balanceOf', args: [relayer.relayer] }), relayerTokenBefore, 'the price was minted and paid in full');
    assert.equal(await pub.readContract({ address: net.ensPaymentToken, abi: tokenAbi, functionName: 'balanceOf', args: [safe] }), 0n, 'the Safe paid nothing');
  });

  test('ens: a second request for the same label answers 409', async () => {
    const nonceBefore = await pub.getTransactionCount({ address: relayer.relayer, blockTag: 'pending' });
    const res = await relayer.call('POST', '/send/ens', { chainId: CHAIN_ID, safe, label });
    assert.equal(res.status, 409, res.text);
    assert.equal(res.json.reason, 'name_taken');
    assert.equal(await pub.getTransactionCount({ address: relayer.relayer, blockTag: 'pending' }), nonceBefore);
  });
});
