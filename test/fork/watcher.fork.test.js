// A front-run wrong answer is challenged within one watcher tick, finalizes against the attacker, and the attacker's
// transaction never executes (D-16, OQ-3, TM-83). Nobody acts besides the relayer's own watcher.
// FORK_NETWORK picks the fork (ethereum_sepolia by default); 25-26 runs the same flow on Base Sepolia.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { getAddress, keccak256, pad, parseAbi, toBytes } from 'viem';
import { CHAIN_ID, account, forkClients, startRelayer } from '../helpers/fork.js';
import { createGroup, GROUP, mineAt, moduleAbi, moduleTxHash, realityAbi, registerGroup } from '../helpers/group.js';
import { hubProposal, startHubStub } from '../stub/hub-stub.js';
import { createHub } from '../../src/hub.js';
import { createEvents } from '../../src/events.js';
import { createWatcher } from '../../src/watcher.js';

process.env.WEB3_ENABLED = 'true';

const YES = pad('0x01', { size: 32 });
const NO = pad('0x00', { size: 32 });
const PAYMENT = 10n ** 15n; // the real proposal's payment, 0.001 ETH
const STEAL = 5n * 10n ** 15n; // what the attacker's transaction would take from the Safe, 0.005 ETH
const ATTACKER = account(7);
const newProposalId = () => `0x${randomBytes(32).toString('hex')}`;

// The module's two permissionless calls, which anyone (the attacker included) may make.
const attackAbi = parseAbi([
  'function addProposal(string proposalId, bytes32[] txHashes)',
  'function executeProposalWithIndex(string proposalId, bytes32[] txHashes, address to, uint256 value, bytes data, uint8 operation, uint256 txIndex)',
]);

describe('watcher (fork)', () => {
  let pub;
  let wallet;
  let relayer;
  let hub;
  let group;
  let reality;
  let watcher;
  let events;
  const payee = getAddress(`0x${randomBytes(20).toString('hex')}`);

  before(async () => {
    const clients = await forkClients();
    pub = clients.pub;
    wallet = clients.wallet;
    hub = await startHubStub();
    relayer = await startRelayer({
      [`SPONSOR_RELAYER_HUB_URL_${CHAIN_ID}`]: hub.url,
      [`SPONSOR_RELAYER_SEQUENCER_URL_${CHAIN_ID}`]: hub.url,
    });
    reality = relayer.networks[String(CHAIN_ID)].reality;
    // Anvil's well-known keys are swept on public chains; the fork's copy of the relayer account can carry an EIP-7702
    // delegation. A fresh relayer key has no code, so clear it (25-07 finding).
    await pub.request({ method: 'anvil_setCode', params: [relayer.relayer, '0x'] });
    group = await createGroup(pub, wallet);
    await registerGroup(relayer, group);
    events = createEvents({ db: relayer.db });
    watcher = createWatcher({
      db: relayer.db,
      config: relayer.config,
      networks: relayer.networks,
      chains: relayer.chains,
      cap: relayer.cap,
      queue: relayer.queue,
      groupModules: relayer.groupModules,
      hub: createHub({ networks: relayer.networks, config: relayer.config }),
      events,
      // The first tick sets the cursor at the chain's head. Blocks before it are the provider's, not anvil's.
      lookbackBlocks: 0,
      logger: { info() {}, warn() {}, error() {} },
    });
    await watcher.tick();
  });
  after(async () => {
    await relayer?.close();
    await hub?.close();
  });

  const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });
  const feed = async () => {
    const res = await relayer.call('GET', '/events?since=0');
    assert.equal(res.status, 200, res.text);
    return res.json.events;
  };

  test('watcher: a front-run wrong answer is challenged within one tick, finalizes no, and the attacker transaction never executes', async () => {
    const proposalId = newProposalId();
    const txA = { to: payee, value: PAYMENT, data: '0x', operation: 0 };
    const txB = { to: ATTACKER.address, value: STEAL, data: '0x', operation: 0 };
    // The real proposal passed and carries transaction A.
    hub.set(hubProposal({ id: proposalId, space: group.space, module: group.module, chainId: CHAIN_ID, txs: [txA], scores: [2, 0, 1], quorum: 2 }));

    // The attacker asks the module about the same proposal id with a different transaction, and answers yes with the
    // minimum bond. Both calls are open to anyone.
    const hashB = await moduleTxHash(pub, group.module, txB, 0);
    const question = await read(group.module, moduleAbi, 'buildQuestion', [proposalId, [hashB]]);
    const questionId = await read(group.module, moduleAbi, 'getQuestionId', [question, 0n]);
    const added = await pub.simulateContract({ account: ATTACKER, address: group.module, abi: attackAbi, functionName: 'addProposal', args: [proposalId, [hashB]] });
    assert.equal((await pub.waitForTransactionReceipt({ hash: await wallet(ATTACKER).writeContract(added.request) })).status, 'success');
    const yes = await pub.simulateContract({ account: ATTACKER, address: reality, abi: realityAbi, functionName: 'submitAnswer', args: [questionId, YES, 0n], value: GROUP.bond });
    const attackerAnswer = await pub.waitForTransactionReceipt({ hash: await wallet(ATTACKER).writeContract(yes.request) });
    assert.equal(attackerAnswer.status, 'success');
    assert.equal(await read(reality, realityAbi, 'getBestAnswer', [questionId]), YES, 'the front-run answer stands before the watcher looks');
    assert.equal(await read(reality, realityAbi, 'getBond', [questionId]), GROUP.bond);

    // One tick: the relayer answers no with twice the bond.
    await watcher.tick();
    await relayer.queue.tick();
    assert.equal(await read(reality, realityAbi, 'getBestAnswer', [questionId]), NO, 'the relayer answered no');
    assert.equal(await read(reality, realityAbi, 'getBond', [questionId]), 2n * GROUP.bond, 'with double the bond');

    const challenged = (await feed()).filter((e) => e.type === 'answer_challenged' && e.questionId === questionId);
    assert.equal(challenged.length, 1, 'one answer_challenged event for the question');
    assert.equal(challenged[0].proposalId, proposalId);
    assert.equal(challenged[0].safe, group.safe);
    assert.equal(challenged[0].module, group.module);
    assert.equal(challenged[0].chainId, CHAIN_ID);

    // The bond is tracked for reclaim, from a block that holds the attacker's answer too.
    const row = relayer.db.getQuestion(CHAIN_ID, questionId);
    assert.ok(row, 'the challenge is stored for the reclaim loop');
    assert.equal(row.bondWei, 2n * GROUP.bond);
    assert.ok(row.fromBlock <= attackerAnswer.blockNumber, 'the history starts at or before the attacker answer');

    // A second tick has nothing to do: the answer is right now.
    await watcher.tick();
    assert.equal(await read(reality, realityAbi, 'getBond', [questionId]), 2n * GROUP.bond);
    assert.equal((await feed()).filter((e) => e.type === 'answer_challenged' && e.questionId === questionId).length, 1);

    // Move past the timeout and the cooldown: the question finalized no, and the attacker's transaction reverts.
    const finalizeTs = BigInt(await read(reality, realityAbi, 'getFinalizeTS', [questionId]));
    await mineAt(pub, finalizeTs + BigInt(GROUP.cooldown) + 1n);
    assert.equal(await read(reality, realityAbi, 'isFinalized', [questionId]), true);
    assert.equal(await read(reality, realityAbi, 'resultFor', [questionId]), NO);
    const safeBefore = await pub.getBalance({ address: group.safe });
    await assert.rejects(
      pub.simulateContract({ account: ATTACKER, address: group.module, abi: attackAbi, functionName: 'executeProposalWithIndex', args: [proposalId, [hashB], txB.to, txB.value, '0x', 0, 0n] }),
      (e) => /Transaction was not approved/.test(`${e.shortMessage} ${e.details}`),
      'executeProposalWithIndex for the attacker transaction reverts because the question did not finalize yes',
    );
    assert.equal(await read(group.module, moduleAbi, 'executedProposalTransactions', [keccak256(toBytes(question)), hashB]), false);
    assert.equal(await pub.getBalance({ address: group.safe }), safeBefore, 'the Safe still holds its funds');

    // The next tick records that the question resolved the right way.
    await watcher.tick();
    const resolved = (await feed()).filter((e) => e.type === 'resolved' && e.questionId === questionId);
    assert.equal(resolved.length, 1, 'one resolved event');
    await watcher.tick();
    assert.equal((await feed()).filter((e) => e.type === 'resolved' && e.questionId === questionId).length, 1, 'not repeated');
  });
});
