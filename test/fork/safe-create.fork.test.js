// Sponsored fund creation on a Sepolia fork: the relayer's own factory call deploys the Safe the site predicted,
// with exactly the owners and threshold asked for, the payer is not an owner and holds no authority, and the payer
// pays the whole fee. Fails, never skips, when the fork is not reachable.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { getAddress, hexToBigInt, keccak256, parseAbi, stringToHex, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { account, CHAIN_ID, forkClients, settleSends, startRelayer } from '../helpers/fork.js';
import { readFileSync } from 'node:fs';
import { loadNetworks } from '../../src/config.js';
import { parseCreationPolicy } from '../../src/creations.js';
import { broadcastOutcome } from '../../src/queue.js';
import { buildInitializer, creationCodeReader, deploymentOf, initCodeHashOf, predictAddress, PROXY_CREATION_CODE_141_KECCAK } from '../../src/sends/safeCreate.js';
import { SEPOLIA_INIT_CODE_HASH } from '../helpers/creation.js';

const fx = JSON.parse(readFileSync(new URL('../fixtures/fund-creation-contract.json', import.meta.url), 'utf8'));

process.env.WEB3_ENABLED = 'true';

const SITE = '5b0e7c1e-2f43-4a8e-9d55-0c6f6a0e9b11';
const GROUP = 'a3f1c2d4-6b7e-4f80-9a1b-2c3d4e5f6a7b';
const GROUP_DEPLOYED = '00000000-0000-4000-8000-000000000001';
const GROUP_EMPTY = '00000000-0000-4000-8000-000000000002';
const safeAbi = parseAbi([
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function nonce() view returns (uint256)',
  'function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)',
]);
// Safe storage: slot 0 is the singleton; the fallback handler and the guard sit at these keccak slots.
const FALLBACK_SLOT = keccak256(stringToHex('fallback_manager.handler.address'));
const GUARD_SLOT = keccak256(stringToHex('guard_manager.guard.address'));
const SENTINEL = '0x0000000000000000000000000000000000000001';
const word = (v) => getAddress(`0x${v.slice(-40)}`);

function body(owners, threshold, saltNonce, groupUuid, nowS, d) {
  const predictedAddress = predictAddress(d, buildInitializer(d, owners, threshold), saltNonce, SEPOLIA_INIT_CODE_HASH);
  return {
    siteUuid: SITE, groupUuid, intentUuid: crypto.randomUUID(), actor: { uuid: crypto.randomUUID(), address: owners[0] },
    chainId: CHAIN_ID, safeVersion: '1.4.1', owners, threshold, saltNonce, predictedAddress, issuedAt: nowS, expiresAt: nowS + 300,
  };
}

describe('safe-create (fork)', () => {
  let pub;
  let relayer;
  const networks = loadNetworks();
  const d = deploymentOf(networks[String(CHAIN_ID)]);
  const policy = parseCreationPolicy({ enabled: true, siteUuid: SITE, groups: [GROUP, GROUP_DEPLOYED, GROUP_EMPTY], limits: { perActorPerDay: 5, perSitePerDay: 5 } }).policy;

  before(async () => {
    ({ pub } = await forkClients());
    relayer = await startRelayer({}, { creationPolicy: policy });
  });
  after(async () => {
    await relayer?.close();
  });

  test('safe-create fork: only Ethereum Sepolia creates; on another fork the route refuses before any estimate', async (t) => {
    if (CHAIN_ID === 11155111) {
      assert.equal(networks['11155111'].fundCreation, true);
      return;
    }
    const nowS = Math.floor(Date.now() / 1000);
    const res = await relayer.call('POST', '/send/safe-create', { ...body([account(0).address], 1, '1', GROUP, nowS, deploymentOf(networks['11155111'])), chainId: CHAIN_ID });
    assert.equal(res.status, 403, res.text);
    assert.equal(res.json.reason, 'network_not_supported');
    t.diagnostic(`fork ${CHAIN_ID}: refused as expected`);
  });

  test("safe-create fork: the factory's own proxyCreationCode() is the code the relayer predicts with, and matches the contract hash", { skip: CHAIN_ID !== 11155111 ? `fund creation is Sepolia only; this run forks ${CHAIN_ID}` : false }, async () => {
    // The contract file keeps only the hash, so no copy of the bytes sits under test/ (licence guard).
    const factoryAbi = parseAbi(['function proxyCreationCode() pure returns (bytes)']);
    const onChain = await pub.readContract({ address: d.factory, abi: factoryAbi, functionName: 'proxyCreationCode' });
    assert.equal(keccak256(onChain), fx.vectors.proxyCreationCodeKeccak256);
    assert.equal(keccak256(onChain), PROXY_CREATION_CODE_141_KECCAK);
    // The unit suites predict with this init code hash; here it is checked against the factory's own code.
    assert.equal(initCodeHashOf(onChain, d.singleton), SEPOLIA_INIT_CODE_HASH);
    // The relayer's own reader gives the same hash from the fork, and refuses a factory with other code.
    assert.deepEqual(await creationCodeReader()(CHAIN_ID, d, pub), { ok: true, hash: SEPOLIA_INIT_CODE_HASH });
    assert.deepEqual(await creationCodeReader({ expectedKeccak: keccak256('0x00') })(CHAIN_ID, d, pub), { ok: false, reason: 'mismatch' });
  });

  test('safe-create fork: the relayer deploys the predicted Safe with the asked owners and threshold and pays the whole fee', { skip: CHAIN_ID !== 11155111 ? `fund creation is Sepolia only; this run forks ${CHAIN_ID} (checked by the test above)` : false }, async () => {
    const owners = [account(0).address, account(1).address, account(3).address];
    const salt = hexToBigInt(toHex(randomBytes(16))).toString();
    // The relayer judges the envelope by its own clock, not the fork's (earlier fork suites move the chain's time).
    const req = body(owners, 2, salt, GROUP, Math.floor(Date.now() / 1000), d);
    assert.equal(await pub.getCode({ address: req.predictedAddress }), undefined);
    const before = await pub.getBalance({ address: relayer.relayer });

    const res = await relayer.call('POST', '/send/safe-create', req);
    assert.equal(res.status, 202, res.text);
    assert.equal(res.json.status, 'pending');
    const rc = await pub.waitForTransactionReceipt({ hash: res.json.hash });
    assert.equal(rc.status, 'success');
    const tx = await pub.getTransaction({ hash: res.json.hash });
    assert.equal(getAddress(tx.from), getAddress(relayer.relayer));
    assert.equal(getAddress(tx.to), d.factory);
    assert.equal(tx.value, 0n);

    // The Safe the site predicted, set up exactly as asked.
    const safe = req.predictedAddress;
    assert.ok((await pub.getCode({ address: safe }))?.length > 2, 'code at the predicted address');
    const read = (functionName, args = []) => pub.readContract({ address: safe, abi: safeAbi, functionName, args });
    assert.deepEqual((await read('getOwners')).map((a) => getAddress(a)), owners);
    assert.equal(await read('getThreshold'), 2n);
    assert.equal(await read('nonce'), 0n);
    assert.deepEqual((await read('getModulesPaginated', [SENTINEL, 10n]))[0], []);
    assert.equal(word(await pub.getStorageAt({ address: safe, slot: '0x0' })), d.singleton);
    assert.equal(word(await pub.getStorageAt({ address: safe, slot: FALLBACK_SLOT })), d.fallbackHandler);
    assert.equal(hexToBigInt(await pub.getStorageAt({ address: safe, slot: GUARD_SLOT })), 0n);
    // The payer: not an owner, and it paid exactly the fee and nothing else.
    assert.ok(!(await read('getOwners')).map((a) => getAddress(a)).includes(getAddress(relayer.relayer)));
    const afterBal = await pub.getBalance({ address: relayer.relayer });
    assert.equal(before - afterBal, rc.gasUsed * rc.effectiveGasPrice);

    // Settled: the slot reads confirmed, and a repeat is that answer with no second send.
    await settleSends(pub, relayer);
    const got = await relayer.call('GET', `/creations/${GROUP}`);
    assert.equal(got.json.status, 'confirmed', got.text);
    assert.equal(got.json.hash, res.json.hash);
    const again = await relayer.call('POST', '/send/safe-create', { ...req, issuedAt: req.issuedAt + 1 });
    assert.equal(again.json.duplicate, true);
    assert.equal(again.json.status, 'confirmed');
    assert.equal(relayer.db.listPending().filter((r) => r.kind === 'safe-create').length, 1);
  });

  test('safe-create fork: an address that already has a Safe is a simulation failure, nothing sent, the attempt given back', { skip: CHAIN_ID !== 11155111 ? 'Sepolia only (see above)' : false }, async () => {
    const owners = [account(0).address, account(1).address];
    const salt = hexToBigInt(toHex(randomBytes(16))).toString();
    const req = body(owners, 1, salt, GROUP_DEPLOYED, Math.floor(Date.now() / 1000), d);
    // Someone else deploys the same set-up first (the factory is permissionless).
    const { wallet } = await forkClients();
    const payer = account(2);
    const factoryAbi = parseAbi(['function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)']);
    const h = await wallet(payer).writeContract({ address: d.factory, abi: factoryAbi, functionName: 'createProxyWithNonce', args: [d.singleton, buildInitializer(d, owners, 1), BigInt(salt)], chain: null });
    assert.equal((await pub.waitForTransactionReceipt({ hash: h })).status, 'success');
    const sends = relayer.db.listPending().length;
    const res = await relayer.call('POST', '/send/safe-create', req);
    assert.equal(res.status, 409, res.text);
    assert.deepEqual(res.json, { error: 'conflict', reason: 'simulation_failed' });
    assert.equal(relayer.db.listPending().length, sends);
    assert.equal((await relayer.call('GET', `/creations/${GROUP_DEPLOYED}`)).json.status, 'not_sent');
  });
  // D-04 (TM-287): on a real node an empty fee wallet passes the estimate and is refused at the broadcast; the relayer
  // reads the balance first, so the answer is a retryable payer_empty with nothing left behind.
  test('safe-create fork D-04: an empty fee wallet is payer_empty with nothing left behind, and the same intent confirms once it is funded', async () => {
    const owners = [account(0).address, account(1).address];
    const salt = hexToBigInt(toHex(randomBytes(16))).toString();
    const req = body(owners, 1, salt, GROUP_EMPTY, Math.floor(Date.now() / 1000), d);
    const funded = await pub.getBalance({ address: relayer.relayer });
    const setBalance = (wei) => pub.request({ method: 'anvil_setBalance', params: [relayer.relayer, toHex(wei)] });
    const pendingBefore = relayer.db.listPending().length;
    const openBefore = relayer.db.openSpend().length;
    let empty;
    try {
      await setBalance(0n);
      empty = await relayer.call('POST', '/send/safe-create', req);
    } finally {
      await setBalance(funded > 0n ? funded : 10n ** 21n);
    }
    assert.equal(empty.status, 502, empty.text);
    assert.deepEqual(empty.json, { error: 'send_failed', reason: 'payer_empty', broadcast: false });
    assert.equal(relayer.db.listPending().length, pendingBefore, 'no queue row');
    assert.equal(relayer.db.openSpend().length, openBefore, 'no open reservation');
    assert.equal((await relayer.call('GET', `/creations/${GROUP_EMPTY}`)).json.status, 'not_sent');
    assert.equal(await pub.getCode({ address: req.predictedAddress }), undefined);

    const res = await relayer.call('POST', '/send/safe-create', req);
    assert.equal(res.status, 202, res.text);
    assert.equal(res.json.duplicate, undefined);
    assert.equal((await pub.waitForTransactionReceipt({ hash: res.json.hash })).status, 'success');
    await settleSends(pub, relayer);
    const got = await relayer.call('GET', `/creations/${GROUP_EMPTY}`);
    assert.equal(got.json.status, 'confirmed', got.text);
    assert.ok((await pub.getCode({ address: req.predictedAddress }))?.length > 2, 'code at the predicted address');
  });
  // D-15: what a real node says to a sender that cannot pay. A throwaway key (never a fixed one) with no balance signs
  // a plain transfer; the node refuses it and the relayer's own classification reads that refusal as "nothing went out".
  test('safe-create fork D-15: a node refuses a broadcast from an empty account and broadcastOutcome reads it as refused', async (t) => {
    const empty = privateKeyToAccount(generatePrivateKey());
    assert.equal(await pub.getBalance({ address: empty.address }), 0n);
    const fees = await pub.estimateFeesPerGas();
    const serializedTransaction = await empty.signTransaction({
      chainId: CHAIN_ID, type: 'eip1559', nonce: 0, to: account(0).address, value: 0n, gas: 21000n,
      maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
    let refused;
    try {
      await pub.sendRawTransaction({ serializedTransaction });
    } catch (e) {
      refused = e;
    }
    assert.ok(refused, 'the node must refuse a transaction from an account with no balance');
    t.diagnostic(`node refusal: ${refused.name}, code ${refused.code ?? refused.cause?.code}`);
    assert.equal(broadcastOutcome(refused), 'refused', `${refused.name}: ${refused.details ?? refused.shortMessage}`);
  });
});
