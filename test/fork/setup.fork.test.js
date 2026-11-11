// One owner-signed, relayer-sent Safe transaction builds a Group's governance on a Sepolia fork, and
// the Safe is the owner of every part of it from the first block (D-07, D-13, D-17, Ostrom 7).
// The batch bytes come from test/fixtures/vectors/setup-batch.json, the same file the PHP SetupPlanner
// test (25-16) compares against. That file holds a 0xfe stand-in where the batch has Reality.eth's
// Arbitrator creation code (GPL-3.0-only, so not in this repository). The real vector is loaded from
// test/fixtures/private/setup-batch.real.json (or the path in LN_SETUP_BATCH_REAL) when it is there;
// without it, the two tests that need the real code are skipped. See test/fixtures/vectors/README.md.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress, parseAbi, toHex, zeroAddress } from 'viem';
import { SELECTORS } from '../../src/allowlist.js';
import { account, CHAIN_ID, deploySafe, forkClients, signRegistration, signSafeTx, startRelayer } from '../helpers/fork.js';
import { loadSetupVector, SKIP_REAL_REASON } from '../helpers/setup-vector.js';

process.env.WEB3_ENABLED = 'true';

const { vector, real: haveRealCode, diagnostic: vectorChoice } = loadSetupVector();
const needsRealCode = haveRealCode ? false : SKIP_REAL_REASON;
const { predicted, inputs } = vector;
const a = inputs.a;

// Hats keeps lastTopHatId in storage slot 5 (read below: the slot holds exactly lastTopHatId and nothing else).
const HATS_LAST_TOP_HAT_SLOT = '0x5';

const hatsAbi = parseAbi([
  'function lastTopHatId() view returns (uint32)',
  'function isWearerOfHat(address _user, uint256 _hatId) view returns (bool)',
  'function isAdminOfHat(address _user, uint256 _hatId) view returns (bool)',
  'function viewHat(uint256 _hatId) view returns (string details, uint32 maxSupply, uint32 supply, address eligibility, address toggle, string imageURI, uint16 lastHatId, bool mutable_, bool active)',
]);
const safeAbi = parseAbi([
  'function isModuleEnabled(address module) view returns (bool)',
  'function nonce() view returns (uint256)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
]);
const arbitratorAbi = parseAbi(['function owner() view returns (address)', 'function realitio() view returns (address)']);
const moduleAbi = parseAbi([
  'function owner() view returns (address)',
  'function avatar() view returns (address)',
  'function target() view returns (address)',
  'function oracle() view returns (address)',
  'function questionTimeout() view returns (uint32)',
  'function questionCooldown() view returns (uint32)',
  'function answerExpiration() view returns (uint32)',
  'function minimumBond() view returns (uint256)',
  'function template() view returns (uint256)',
  'function questionArbitrator() view returns (address)',
]);

describe('group setup (fork)', () => {
  let pub;
  let wallet;
  let relayer;
  let safe;
  let receipt;
  const owners = [account(0), account(1)];

  before(async (t) => {
    t.diagnostic(vectorChoice);
    const clients = await forkClients();
    pub = clients.pub;
    wallet = clients.wallet;

    // The next top hat id must be the vector's. Hats' slot 5 is lastTopHatId alone, so the write replaces nothing else.
    const last = await pub.readContract({ address: a.hats, abi: hatsAbi, functionName: 'lastTopHatId' });
    assert.ok(last <= inputs.lastTopHatIdBefore, `the fork already has top hat ${last}; the vector needs ${inputs.lastTopHatIdBefore} to be free`);
    const slot = await pub.getStorageAt({ address: a.hats, slot: HATS_LAST_TOP_HAT_SLOT });
    assert.equal(BigInt(slot), BigInt(last), 'Hats storage slot 5 is not lastTopHatId alone');
    await pub.request({
      method: 'anvil_setStorageAt',
      params: [a.hats, HATS_LAST_TOP_HAT_SLOT, toHex(BigInt(inputs.lastTopHatIdBefore), { size: 32 })],
    });
    assert.equal(await pub.readContract({ address: a.hats, abi: hatsAbi, functionName: 'lastTopHatId' }), inputs.lastTopHatIdBefore);

    // The Safe lands on the vector's predicted address: same owners, threshold and salt nonce.
    assert.deepEqual(owners.map((o) => o.address), inputs.owners);
    safe = await deploySafe(pub, wallet, owners, inputs.threshold, inputs.safeSaltNonce);
    assert.equal(safe, predicted.safe, 'the deployed Safe is not at the vector address (proxy creation code or initializer drifted)');

    relayer = await startRelayer();
    const signature = await signRegistration({ relayer: relayer.relayer, safe, space: 'gov-vectors.eth', signers: owners });
    const reg = await relayer.call('POST', '/groups', { chainId: CHAIN_ID, safe, space: 'gov-vectors.eth', signature });
    assert.equal(reg.status, 201, reg.text);
  });
  after(async () => {
    await relayer?.close();
  });

  // Runs with either vector: the fork is a fresh chain for the Group, with nothing the batch creates.
  test('setup: the Safe is fresh and nothing the batch creates exists yet', async () => {
    assert.equal(await pub.readContract({ address: safe, abi: safeAbi, functionName: 'nonce' }), 0n);
    for (const addr of [predicted.arbitrator, predicted.module]) assert.equal(await pub.getCode({ address: addr }) ?? '0x', '0x', `${addr} already has code`);
  });

  // Needs the real code: safeTxHash and the owner signatures were made over the real batch, so the Safe
  // computes this hash only for the real bytes.
  test('setup: the vector\'s SafeTx hash and owner signatures match the chain', { skip: needsRealCode }, async () => {
    const tx = txFromVector();
    const live = await pub.readContract({
      address: safe,
      abi: parseAbi(['function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)']),
      functionName: 'getTransactionHash',
      args: [tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, 0n],
    });
    assert.equal(live, vector.safeTxHash, 'the Safe computes another hash than the vector');
    assert.equal(await signSafeTx(pub, safe, tx, owners), vector.signaturesConcatenated, 'owner signatures differ from the vector');
  });

  // Needs the real code: the batch's first call deploys it, and the Arbitrator's owner() and realitio() are read back.
  test('setup: the relayer sends the batch and the Safe owns, wears and administers everything it created', { skip: needsRealCode }, async () => {
    const tx = txFromVector();
    const signatures = await signSafeTx(pub, safe, tx, owners);
    const beforeStatus = await relayer.call('GET', '/status');
    assert.equal(beforeStatus.json.groups.find((g) => g.safe === safe).module, null, 'a module before the setup mined');
    const res = await relayer.call('POST', '/send/safe-exec', {
      chainId: CHAIN_ID,
      safe,
      to: tx.to,
      value: tx.value.toString(),
      data: tx.data,
      operation: tx.operation,
      safeTxGas: '0',
      baseGas: '0',
      gasPrice: '0',
      gasToken: zeroAddress,
      refundReceiver: zeroAddress,
      signatures,
    });
    assert.equal(res.status, 202, res.text);
    receipt = await pub.waitForTransactionReceipt({ hash: res.json.hash });
    assert.equal(receipt.status, 'success');
    assert.equal(getAddress(receipt.from), relayer.relayer, 'the relayer sent the transaction');
    assert.equal(getAddress(receipt.to), safe);
    assert.equal(await pub.readContract({ address: safe, abi: safeAbi, functionName: 'nonce' }), 1n);

    // Arbitrator (D-07): at the predicted address, owned by the Safe, pointed at Reality 3.0.
    for (const [what, addr] of [['Arbitrator', predicted.arbitrator], ['module', predicted.module]]) {
      const code = await pub.getCode({ address: addr });
      assert.ok(code && code !== '0x', `no code at the predicted ${what} address`);
    }
    assert.equal(await pub.readContract({ address: predicted.arbitrator, abi: arbitratorAbi, functionName: 'owner' }), safe);
    assert.equal(await pub.readContract({ address: predicted.arbitrator, abi: arbitratorAbi, functionName: 'realitio' }), a.reality);

    // Reality module (D-04): enabled, owner = avatar = target = the Safe, settings equal the vector inputs.
    assert.equal(await pub.readContract({ address: safe, abi: safeAbi, functionName: 'isModuleEnabled', args: [predicted.module] }), true);
    const read = (functionName) => pub.readContract({ address: predicted.module, abi: moduleAbi, functionName });
    assert.equal(await read('owner'), safe);
    assert.equal(await read('avatar'), safe);
    assert.equal(await read('target'), safe);
    assert.equal(await read('oracle'), a.reality);
    assert.equal(await read('questionTimeout'), inputs.timeout);
    assert.equal(await read('questionCooldown'), inputs.cooldown);
    assert.equal(await read('answerExpiration'), inputs.expiration);
    assert.equal(await read('minimumBond'), BigInt(inputs.bond));
    assert.equal(await read('template'), BigInt(inputs.templateId));
    assert.equal(await read('questionArbitrator'), predicted.arbitrator);

    // Hats (D-13, D-17): top hat worn by the Safe, member and proposer hats with eligibility and toggle = the Safe.
    const [top, member, proposer] = [predicted.topHat, predicted.memberHat, predicted.proposerHat].map(BigInt);
    const wears = (who, hat) => pub.readContract({ address: a.hats, abi: hatsAbi, functionName: 'isWearerOfHat', args: [who, hat] });
    assert.equal(await wears(safe, top), true, 'the Safe does not wear the top hat');
    for (const [hat, name] of [[member, 'Member'], [proposer, 'Proposer']]) {
      const view = await pub.readContract({ address: a.hats, abi: hatsAbi, functionName: 'viewHat', args: [hat] });
      assert.equal(view[0], name);
      assert.equal(view[3], safe, `${name} hat eligibility is not the Safe`);
      assert.equal(view[4], safe, `${name} hat toggle is not the Safe`);
      assert.equal(view[7], true, `${name} hat is not mutable by its admin`);
      assert.equal(view[8], true, `${name} hat is not active`);
      for (const owner of owners) assert.equal(await wears(owner.address, hat), true, `${owner.address} does not wear the ${name} hat`);
    }
    assert.equal(await pub.readContract({ address: a.hats, abi: hatsAbi, functionName: 'lastTopHatId' }), inputs.topHatNumber);

    // Ostrom 7: the host holds no power over any of it. The relayer owns, wears and administers nothing.
    const host = relayer.relayer;
    assert.notEqual(host, safe);
    assert.notEqual(await pub.readContract({ address: predicted.arbitrator, abi: arbitratorAbi, functionName: 'owner' }), host, 'the relayer owns the Arbitrator');
    assert.notEqual(await read('owner'), host, 'the relayer owns the module');
    for (const hat of [top, member, proposer]) {
      assert.equal(await wears(host, hat), false, 'the relayer wears a Group hat');
      assert.equal(await pub.readContract({ address: a.hats, abi: hatsAbi, functionName: 'isAdminOfHat', args: [host, hat] }), false, 'the relayer administers a Group hat');
    }
    assert.deepEqual((await pub.readContract({ address: safe, abi: safeAbi, functionName: 'getOwners' })).map((x) => x.toLowerCase()).sort(), inputs.owners.map((x) => x.toLowerCase()).sort());

    // The relayer finds the module from the chain only: once the send has mined, /status names it and the allowlist covers it.
    await relayer.queue.tick();
    const afterStatus = await relayer.call('GET', '/status');
    assert.equal(afterStatus.json.groups.find((g) => g.safe === safe).module, predicted.module);
    const list = await relayer.groupModules.allowlist(relayer.db.listGroups());
    assert.equal(list.check(CHAIN_ID, predicted.module, SELECTORS.addProposal).ok, true);
    assert.equal(list.check(CHAIN_ID, predicted.module, SELECTORS.executeProposalWithIndex).ok, true);
    assert.equal(list.check(CHAIN_ID, predicted.arbitrator, SELECTORS.addProposal).ok, false, 'the Arbitrator is not a sponsored target');

    // No earlier block held any of it: it all appeared in the one transaction.
    for (const addr of [predicted.arbitrator, predicted.module]) {
      const before = await pub.getCode({ address: addr, blockNumber: receipt.blockNumber - 1n });
      assert.ok(!before || before === '0x', `${addr} existed before the setup block`);
    }
  });

  function txFromVector() {
    const t = vector.safeTx;
    return {
      to: t.to,
      value: BigInt(t.value),
      data: t.data,
      operation: t.operation,
      safeTxGas: BigInt(t.safeTxGas),
      baseGas: BigInt(t.baseGas),
      gasPrice: BigInt(t.gasPrice),
      gasToken: t.gasToken,
      refundReceiver: t.refundReceiver,
    };
  }
});
