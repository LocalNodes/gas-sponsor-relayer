// The reclaim loop without a chain: the shape of the history Reality.eth wants, and the rule that the cap is credited
// only after the withdraw receipt says status 1 (TM-82). The fork test covers the real contract.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { encodePacked, keccak256, zeroHash, pad } from 'viem';
import { claimHistory, createReclaim } from '../../src/reclaim.js';
import { openDb } from '../../src/db.js';
import { createCap } from '../../src/cap.js';

const RELAYER = '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc';
const OTHER = '0x976EA74026E726554dB657fA54763abd0C3a0aa9';
const REALITY = '0xaf33DcB6E8c5c4D9dDF579f53031b514d19449CA';
const QID = `0x${'ab'.repeat(32)}`;
const YES = pad('0x01', { size: 32 });
const NO = pad('0x00', { size: 32 });

/** LogNewAnswer entries, oldest first, with the history hash each event carries. */
function entries(list) {
  let before = zeroHash;
  return list.map(([user, answer, bond]) => {
    const historyHash = keccak256(encodePacked(['bytes32', 'bytes32', 'uint256', 'address', 'bool'], [before, answer, bond, user, false]));
    before = historyHash;
    return { user, answer, bond, historyHash, isCommitment: false };
  });
}

describe('reclaim', () => {
  test('reclaim: the history is newest first, each entry with the hash before it, and an empty hash for the oldest', () => {
    const [a, b, c] = entries([[RELAYER, YES, 10n], [OTHER, NO, 20n], [RELAYER, YES, 40n]]);
    const h = claimHistory([a, b, c]);
    assert.deepEqual(h.historyHashes, [b.historyHash, a.historyHash, zeroHash]);
    assert.deepEqual(h.addrs, [RELAYER, OTHER, RELAYER]);
    assert.deepEqual(h.bonds, [40n, 20n, 10n]);
    assert.deepEqual(h.answers, [YES, NO, YES]);
  });

  test('reclaim: a single answer gives a single empty hash', () => {
    const [a] = entries([[RELAYER, YES, 10n]]);
    assert.deepEqual(claimHistory([a]).historyHashes, [zeroHash]);
  });

  test('reclaim: a history that starts late or has a commitment is refused before anything is sent', () => {
    const [a, b] = entries([[RELAYER, YES, 10n], [OTHER, NO, 20n]]);
    assert.throws(() => claimHistory([b]), /history:incomplete/);
    assert.throws(() => claimHistory([{ ...a, isCommitment: true }]), /history:has_commitments/);
    assert.throws(() => claimHistory([a, { ...b, bond: 21n }]), /history:incomplete/);
  });

  /** A reclaim loop over a fake chain: the question is final and claimed, the relayer's Reality balance is `balance`. */
  function claimedQuestion({ balance, withdrawStatus }) {
    const db = openDb(':memory:');
    const cap = createCap({ db });
    const bondRef = `bond:1:${QID}`;
    db.insertSpend({ chainId: 1, at: Date.now(), wei: 10n, kind: 'bond', ref: bondRef });
    db.insertQuestion({ chainId: 1, questionId: QID, module: OTHER, safe: OTHER, proposalId: `0x${'cd'.repeat(32)}`, answer: 'yes', bondWei: 10n, bondRef, fromBlock: 1n, txHash: zeroHash });
    db.updateQuestion(1, QID, { status: 'claimed' });
    const sent = [];
    const chains = {
      get: () => ({
        walletClient: {},
        publicClient: { readContract: async ({ functionName }) => ({ isFinalized: true, balanceOf: balance })[functionName] },
      }),
    };
    const pipeline = {
      send: async (s) => (sent.push(s.selectorName), { ok: true, hash: `0x${'11'.repeat(32)}`, nonce: 0 }),
      waitMined: async () => ({ status: withdrawStatus }),
    };
    const networks = { 1: { name: 'x', reality: REALITY } };
    const reclaim = createReclaim({ db, config: { address: RELAYER }, networks, chains, cap, queue: null, pipeline, logger: { info() {}, warn() {}, error() {} } });
    return { db, reclaim, sent, bondRef, credits: () => db.spendSince(0).filter((e) => e.kind === 'credit') };
  }

  test('reclaim: a withdraw that reverted credits nothing and leaves the question to try again', async () => {
    const t = claimedQuestion({ balance: 10n, withdrawStatus: 'reverted' });
    const [r] = await t.reclaim.tick();
    assert.equal(r.outcome, 'error');
    assert.equal(r.error, 'withdraw:reverted');
    assert.deepEqual(t.sent, ['withdraw']);
    assert.equal(t.credits().length, 0);
    assert.equal(t.db.getQuestion(1, QID).status, 'claimed');
    assert.ok(t.db.listEvents().some((e) => e.kind === 'reality_reclaim_error' && e.detail.includes('withdraw:reverted')));
  });

  test('reclaim: a withdraw that mined credits the bond once', async () => {
    const t = claimedQuestion({ balance: 10n, withdrawStatus: 'success' });
    const [r] = await t.reclaim.tick();
    assert.equal(r.outcome, 'done');
    assert.equal(r.creditedWei, 10n);
    assert.deepEqual(t.credits().map((e) => [e.ref, e.wei]), [[t.bondRef, 10n]]);
    assert.equal(t.db.getQuestion(1, QID).status, 'done');
    assert.deepEqual(await t.reclaim.tick(), []);
    assert.equal(t.credits().length, 1);
  });

  test('reclaim: the credit is never more than the bond, nor more than the withdraw moved', async () => {
    const more = claimedQuestion({ balance: 25n, withdrawStatus: 'success' });
    assert.equal((await more.reclaim.tick())[0].creditedWei, 10n);
    const less = claimedQuestion({ balance: 4n, withdrawStatus: 'success' });
    assert.equal((await less.reclaim.tick())[0].creditedWei, 4n);
  });

  test('reclaim: a bond with no entry left (its send was replaced) reports 0 credited and an audit line says why', async () => {
    const t = claimedQuestion({ balance: 10n, withdrawStatus: 'success' });
    // The bond's send was replaced and its reservation given back (25-28 fix A): no bond entry is left.
    t.db.deleteSpend(t.db.findSpend(t.bondRef, 'bond').id);
    const [r] = await t.reclaim.tick();
    assert.equal(r.outcome, 'done');
    assert.deepEqual(t.sent, ['withdraw']);
    assert.equal(t.credits().length, 0);
    assert.equal(r.creditedWei, 0n, 'nothing was stored, so nothing is reported as credited');
    assert.equal(t.db.getQuestion(1, QID).status, 'done');
    const skipped = t.db.listEvents().filter((e) => e.kind === 'reality_credit_skipped');
    assert.equal(skipped.length, 1);
    const detail = JSON.parse(skipped[0].detail);
    assert.equal(detail.reason, 'no_bond_entry');
    assert.equal(detail.questionId, QID);
    assert.equal(detail.bondRef, t.bondRef);
    assert.equal(detail.withdrawnWei, '10');
    assert.equal(detail.uncreditedWei, '10');
  });

  test('reclaim: a stored credit writes no skipped audit line', async () => {
    const t = claimedQuestion({ balance: 10n, withdrawStatus: 'success' });
    await t.reclaim.tick();
    assert.equal(t.db.listEvents().filter((e) => e.kind === 'reality_credit_skipped').length, 0);
  });

  test('reclaim: an empty Reality balance sends nothing and credits nothing', async () => {
    const t = claimedQuestion({ balance: 0n, withdrawStatus: 'success' });
    const [r] = await t.reclaim.tick();
    assert.equal(r.outcome, 'done');
    assert.deepEqual(t.sent, []);
    assert.equal(t.credits().length, 0);
    assert.equal(t.db.getQuestion(1, QID).status, 'done');
  });
});
