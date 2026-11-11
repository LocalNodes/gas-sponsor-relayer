// A passed payment carried out on a fork: add, answer, wait, execute, every step sent and paid by the relayer
// against a canned hub (GOV-02, GOV-04, UX-01). Members and organizers sign nothing here after the Group exists.
// FORK_NETWORK picks the fork (ethereum_sepolia by default); 25-26 runs the same flow on Base Sepolia.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { getAddress, keccak256, pad, toBytes, toEventSelector } from 'viem';
import { CHAIN_ID, forkClients, startRelayer } from '../helpers/fork.js';
import { createGroup, GROUP, latestTimestamp, mineAt, moduleAbi, moduleTxHash, realityAbi, registerGroup, settle } from '../helpers/group.js';
import { hubProposal, startHubStub } from '../stub/hub-stub.js';

process.env.WEB3_ENABLED = 'true';

const ONE = `0x${'00'.repeat(31)}01`;
const PAYMENT = 10n ** 15n; // 0.001 ETH
const MODULE_SUCCESS = toEventSelector('ExecutionFromModuleSuccess(address)');
const newProposalId = () => `0x${randomBytes(32).toString('hex')}`;

describe('reality (fork)', () => {
  let pub;
  let wallet;
  let relayer;
  let hub;
  let group;
  let reality;
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
    group = await createGroup(pub, wallet);
    await registerGroup(relayer, group);
  });
  after(async () => {
    await relayer?.close();
    await hub?.close();
  });

  const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });

  test('reality: add, answer, wait and execute, each sent and paid by the relayer', async () => {
    const proposalId = newProposalId();
    const tx = { to: payee, value: PAYMENT, data: '0x', operation: 0 };
    hub.set(hubProposal({ id: proposalId, space: group.space, module: group.module, chainId: CHAIN_ID, txs: [tx], scores: [2, 0, 1], quorum: 2 }));

    // What the module itself says the question is (not the relayer's formula).
    const txHash = await moduleTxHash(pub, group.module, tx, 0);
    const question = await read(group.module, moduleAbi, 'buildQuestion', [proposalId, [txHash]]);
    const questionHash = keccak256(toBytes(question));
    const expectedQid = await read(group.module, moduleAbi, 'getQuestionId', [question, 0n]);
    assert.equal(await read(group.module, moduleAbi, 'questionIds', [questionHash]), pad('0x00', { size: 32 }), 'nothing asked yet');

    // Step 1: addProposal. The relayer reads the hub itself; the request names the proposal and nothing else.
    const added = await relayer.call('POST', '/send/reality/add', { chainId: CHAIN_ID, safe: group.safe, proposalId });
    assert.equal(added.status, 202, added.text);
    assert.equal(added.json.questionId, expectedQid);
    const addReceipt = await settle(pub, relayer, added.json.hash);
    assert.equal(addReceipt.status, 'success');
    assert.equal(getAddress(addReceipt.from), relayer.relayer, 'the relayer sent addProposal');
    assert.equal(await read(group.module, moduleAbi, 'questionIds', [questionHash]), expectedQid);
    assert.ok(hub.callsOf('graphql', proposalId).length >= 1, 'the relayer read the hub');

    // Step 2: submitAnswer. The body carries fields that try to pick the answer and the bond; they are ignored.
    const answered = await relayer.call('POST', '/send/reality/answer', {
      chainId: CHAIN_ID,
      safe: group.safe,
      proposalId,
      answer: `0x${'00'.repeat(32)}`,
      bond: '1',
      value: '1',
    });
    assert.equal(answered.status, 202, answered.text);
    assert.equal(answered.json.answer, 'yes');
    const answerReceipt = await settle(pub, relayer, answered.json.hash);
    assert.equal(answerReceipt.status, 'success');
    assert.equal(getAddress(answerReceipt.from), relayer.relayer, 'the relayer sent submitAnswer');
    assert.equal(await read(reality, realityAbi, 'getBestAnswer', [expectedQid]), ONE);
    assert.equal(await read(reality, realityAbi, 'getBond', [expectedQid]), GROUP.bond, 'the bond is the module minimumBond');

    // Step 3: execute. Before the question finalizes the relayer refuses and sends nothing.
    const nonceBefore = await pub.getTransactionCount({ address: relayer.relayer, blockTag: 'pending' });
    const early = await relayer.call('POST', '/send/reality/execute', { chainId: CHAIN_ID, safe: group.safe, proposalId });
    assert.equal(early.status, 409, early.text);
    assert.equal(early.json.reason, 'not_finalized');

    const finalizeTs = BigInt(await read(reality, realityAbi, 'getFinalizeTS', [expectedQid]));
    // Exactly finalize time + cooldown: the module needs a block strictly after it, so the relayer waits.
    await mineAt(pub, finalizeTs + BigInt(GROUP.cooldown));
    assert.equal(await latestTimestamp(pub), finalizeTs + BigInt(GROUP.cooldown));
    const atCooldown = await relayer.call('POST', '/send/reality/execute', { chainId: CHAIN_ID, safe: group.safe, proposalId });
    assert.equal(atCooldown.status, 409, atCooldown.text);
    assert.equal(atCooldown.json.reason, 'cooldown');
    assert.equal(await pub.getTransactionCount({ address: relayer.relayer, blockTag: 'pending' }), nonceBefore, 'nothing was sent while the module would refuse');
    assert.equal(await pub.getBalance({ address: payee }), 0n);

    // One second later it sends.
    await mineAt(pub, finalizeTs + BigInt(GROUP.cooldown) + 1n);
    const ran = await relayer.call('POST', '/send/reality/execute', { chainId: CHAIN_ID, safe: group.safe, proposalId });
    assert.equal(ran.status, 202, ran.text);
    const execReceipt = await settle(pub, relayer, ran.json.hash);
    assert.equal(execReceipt.status, 'success');
    assert.equal(getAddress(execReceipt.from), relayer.relayer, 'the relayer sent executeProposalWithIndex');
    const fromSafe = execReceipt.logs.filter((l) => getAddress(l.address) === group.safe && l.topics[0] === MODULE_SUCCESS);
    assert.equal(fromSafe.length, 1, 'one ExecutionFromModuleSuccess log from the Safe');
    assert.equal(getAddress(`0x${fromSafe[0].topics[1].slice(26)}`), group.module, 'the log names the module');
    assert.equal(await pub.getBalance({ address: payee }), PAYMENT, 'the payee received the payment');
    assert.equal(await read(group.module, moduleAbi, 'executedProposalTransactions', [questionHash, txHash]), true);

    // Executed once; the relayer says so instead of sending again.
    const again = await relayer.call('POST', '/send/reality/execute', { chainId: CHAIN_ID, safe: group.safe, proposalId });
    assert.equal(again.status, 409, again.text);
    assert.equal(again.json.reason, 'already_executed');
  });

  test('reality: add is refused while the hub says scores are pending, and the relayer asks the sequencer itself', async () => {
    const proposalId = newProposalId();
    hub.set(hubProposal({ id: proposalId, space: group.space, module: group.module, chainId: CHAIN_ID, txs: [{ to: payee, value: PAYMENT }], state: 'closed', scoresState: 'pending', scores: [] }));
    const nonceBefore = await pub.getTransactionCount({ address: relayer.relayer, blockTag: 'pending' });
    const res = await relayer.call('POST', '/send/reality/add', { chainId: CHAIN_ID, safe: group.safe, proposalId });
    assert.equal(res.status, 409, res.text);
    assert.equal(res.json.reason, 'proposal_not_final');
    assert.ok(hub.callsOf('scores', proposalId).length >= 1, 'the relayer called GET /scores/<id> itself');
    assert.equal(await pub.getTransactionCount({ address: relayer.relayer, blockTag: 'pending' }), nonceBefore);
  });
});
