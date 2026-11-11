// Bond reclaim on a fork (25-07 Task 3, TM-82). The relayer answers a Reality question with a bond; once the question
// finalizes, reclaim.js rebuilds the answer history from LogNewAnswer events, claims the winnings, withdraws them and
// credits the spend cap. FORK_NETWORK picks the fork (ethereum_sepolia by default).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { getAddress, pad } from 'viem';
import { CHAIN_ID, account, forkClients, settleSends, startRelayer } from '../helpers/fork.js';
import { createGroup, GROUP, mineAt, realityAbi, registerGroup, settle } from '../helpers/group.js';
import { hubProposal, startHubStub } from '../stub/hub-stub.js';
import { createReclaim } from '../../src/reclaim.js';

process.env.WEB3_ENABLED = 'true';

const PAYMENT = 10n ** 15n;
const YES = pad('0x01', { size: 32 });
const NO = pad('0x00', { size: 32 });
const newProposalId = () => `0x${randomBytes(32).toString('hex')}`;
const CHALLENGER = account(6);

describe('reclaim (fork)', () => {
  let pub;
  let wallet;
  let relayer;
  let hub;
  let group;
  let reality;
  let reclaim;
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
    // Anvil's well-known account keys are swept on public chains: on a Sepolia fork this account can carry an EIP-7702
    // delegation, and Reality.eth's withdraw() pays with transfer() (2300 gas), which a delegated account cannot receive.
    // A fresh relayer key has no such code, so the fork's copy of the account is cleared to look like one.
    await pub.request({ method: 'anvil_setCode', params: [relayer.relayer, '0x'] });
    assert.equal(await pub.getCode({ address: relayer.relayer }), undefined, 'the relayer account holds no code');
    group = await createGroup(pub, wallet);
    await registerGroup(relayer, group);
    reclaim = createReclaim({ db: relayer.db, config: relayer.config, networks: relayer.networks, chains: relayer.chains, cap: relayer.cap, queue: relayer.queue, logger: { info() {}, warn() {}, error() {} } });
  });
  after(async () => {
    await relayer?.close();
    await hub?.close();
  });

  const read = (functionName, args = []) => pub.readContract({ address: reality, abi: realityAbi, functionName, args });
  const gasCost = async (hash) => {
    const r = await pub.getTransactionReceipt({ hash });
    return r.gasUsed * r.effectiveGasPrice;
  };

  /** A passed payment proposal, added and answered by the relayer. Returns the question and the relayer's balance before the bond. */
  async function answeredQuestion() {
    const proposalId = newProposalId();
    hub.set(hubProposal({ id: proposalId, space: group.space, module: group.module, chainId: CHAIN_ID, txs: [{ to: payee, value: PAYMENT }], scores: [2, 0, 1], quorum: 2 }));
    const added = await relayer.call('POST', '/send/reality/add', { chainId: CHAIN_ID, safe: group.safe, proposalId });
    assert.equal(added.status, 202, added.text);
    await settle(pub, relayer, added.json.hash);
    const balanceBeforeBond = await pub.getBalance({ address: relayer.relayer });
    const answered = await relayer.call('POST', '/send/reality/answer', { chainId: CHAIN_ID, safe: group.safe, proposalId });
    assert.equal(answered.status, 202, answered.text);
    await settle(pub, relayer, answered.json.hash);
    return { proposalId, questionId: added.json.questionId, answerHash: answered.json.hash, balanceBeforeBond };
  }

  /** Move the fork's clock to the moment the question finalizes. */
  async function finalize(questionId) {
    await mineAt(pub, BigInt(await read('getFinalizeTS', [questionId])));
    assert.equal(await read('isFinalized', [questionId]), true);
  }

  async function challenge(questionId, answer, bond) {
    const call = { account: CHALLENGER, address: reality, abi: realityAbi, functionName: 'submitAnswer', args: [questionId, answer, 0n], value: bond };
    const sim = await pub.simulateContract(call);
    const rc = await pub.waitForTransactionReceipt({ hash: await wallet(CHALLENGER).writeContract(sim.request) });
    if (rc.status !== 'success') {
      // Replay one block earlier so a revert names its reason.
      const why = await pub.simulateContract({ ...call, blockNumber: rc.blockNumber - 1n }).then(() => 'the replay succeeds', (e) => e.shortMessage);
      assert.fail(`the challenge reverted: ${why}`);
    }
  }

  const show = (r) => JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  const resultOf = (results, questionId) => results.find((r) => r.questionId === questionId);

  test('reclaim: a finalized question is claimed and withdrawn, and the relayer ends within gas of where it started', async () => {
    const q = await answeredQuestion();
    const row = relayer.db.getQuestion(CHAIN_ID, q.questionId);
    assert.equal(row.status, 'answered');
    assert.equal(row.bondWei, GROUP.bond);
    assert.ok((await pub.getBalance({ address: relayer.relayer })) < q.balanceBeforeBond - GROUP.bond + 1n, 'the bond left the relayer');

    // Not final yet: nothing happens and nothing is sent.
    const nonceBefore = await pub.getTransactionCount({ address: relayer.relayer, blockTag: 'pending' });
    assert.equal(resultOf(await reclaim.tick(), q.questionId), undefined, 'a question that is not final is left alone');
    assert.equal(await pub.getTransactionCount({ address: relayer.relayer, blockTag: 'pending' }), nonceBefore);

    await finalize(q.questionId);
    // The cap settles a receipt once its block is finalized (25-28 round 3, #2).
    await settleSends(pub, relayer);
    const spentBefore = BigInt(relayer.cap.status().spentDayWei);

    const result = resultOf(await reclaim.tick(), q.questionId);
    assert.ok(result, 'the finalized question was handled');
    assert.equal(result.outcome, 'done', show(result));
    assert.equal(result.creditedWei, GROUP.bond);
    await settleSends(pub, relayer);

    // The relayer's Reality balance is empty again and its ETH is back, less the gas of its own sends.
    assert.equal(await read('balanceOf', [relayer.relayer]), 0n);
    const gas = (await gasCost(q.answerHash)) + (await gasCost(result.claimHash)) + (await gasCost(result.withdrawHash));
    assert.equal(q.balanceBeforeBond - (await pub.getBalance({ address: relayer.relayer })), gas, 'the whole bond came back');

    // The cap holds a credit equal to the bond, written after the withdraw mined.
    const entries = relayer.db.spendSince(0).filter((e) => e.ref === row.bondRef);
    assert.equal(entries.filter((e) => e.kind === 'bond').length, 1);
    assert.equal(entries.find((e) => e.kind === 'credit')?.wei, GROUP.bond);
    const spentAfter = BigInt(relayer.cap.status().spentDayWei);
    assert.equal(spentBefore - spentAfter + (await gasCost(result.claimHash)) + (await gasCost(result.withdrawHash)), GROUP.bond, 'spend fell by the bond; the two reclaim sends cost their own gas');
    assert.equal(relayer.db.getQuestion(CHAIN_ID, q.questionId).status, 'done');

    // Done once: a second pass sends nothing and credits nothing.
    const nonceDone = await pub.getTransactionCount({ address: relayer.relayer, blockTag: 'pending' });
    assert.equal(resultOf(await reclaim.tick(), q.questionId), undefined);
    assert.equal(await pub.getTransactionCount({ address: relayer.relayer, blockTag: 'pending' }), nonceDone);
    assert.equal(relayer.db.spendSince(0).filter((e) => e.kind === 'credit' && e.ref === row.bondRef).length, 1);
  });

  test('reclaim: with a second answer on the question the history is rebuilt from events and the relayer is repaid', async () => {
    const q = await answeredQuestion();
    // Another account gives the same answer with a double bond. Two entries now sit in the question's history.
    await challenge(q.questionId, YES, GROUP.bond * 2n);
    await finalize(q.questionId);
    const challengerBefore = await read('balanceOf', [CHALLENGER.address]);

    const result = resultOf(await reclaim.tick(), q.questionId);
    assert.ok(result, 'the finalized question was handled');
    assert.equal(result.outcome, 'done', show(result));
    assert.equal(result.historyLength, 2, 'both LogNewAnswer events were read');
    assert.equal(result.creditedWei, GROUP.bond);
    await relayer.queue.tick();
    assert.equal(await read('balanceOf', [relayer.relayer]), 0n);
    const gas = (await gasCost(q.answerHash)) + (await gasCost(result.claimHash)) + (await gasCost(result.withdrawHash));
    // What the relayer withdrew from Reality: its ETH now, plus the gas it paid, plus the bond it put in, less what it had before.
    const withdrawn = (await pub.getBalance({ address: relayer.relayer })) + gas + GROUP.bond - q.balanceBeforeBond;
    assert.ok(withdrawn >= GROUP.bond, 'the relayer got at least its own bond back');
    // The claim covered the whole history, so the later answerer's winnings were assigned in the same call: together the
    // two are the three bonds paid in, less a small remainder Reality.eth keeps (25000000000000 wei on the fork run).
    // Had the history held only the relayer's entry, the total would have been about one bond.
    const paidOut = withdrawn + (await read('balanceOf', [CHALLENGER.address])) - challengerBefore;
    assert.ok(paidOut <= GROUP.bond * 3n && paidOut >= (GROUP.bond * 29n) / 10n, `paid out ${paidOut}`);
  });

  test('reclaim: when a challenger wins with another answer the loss stays in the cap and nothing is sent', async () => {
    const q = await answeredQuestion();
    await challenge(q.questionId, NO, GROUP.bond * 2n);
    await finalize(q.questionId);
    // The cap settles a receipt once its block is finalized (25-28 round 3, #2).
    await settleSends(pub, relayer);
    const spentBefore = BigInt(relayer.cap.status().spentDayWei);
    const nonceBefore = await pub.getTransactionCount({ address: relayer.relayer, blockTag: 'pending' });

    const result = resultOf(await reclaim.tick(), q.questionId);
    assert.ok(result, 'the finalized question was handled');
    assert.equal(result.outcome, 'lost', show(result));
    assert.equal(await pub.getTransactionCount({ address: relayer.relayer, blockTag: 'pending' }), nonceBefore, 'no claim and no withdraw were sent');
    assert.equal(BigInt(relayer.cap.status().spentDayWei), spentBefore, 'the bond stays counted');
    assert.equal(relayer.db.getQuestion(CHAIN_ID, q.questionId).status, 'done');
    assert.ok(relayer.db.listEvents().some((e) => e.kind === 'reality_bond_lost' && e.detail.includes(q.questionId)));
  });
});
