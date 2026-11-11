// The relayer's own answer decision (D-09, D-16, TM-79, TM-80): yes, no or invalid from its own reads of the hub.
// Transaction and question hashes are held to the shared Reality vector; the hub and the database are fakes.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ANSWER_BYTES, createAnswerer, moduleTransactions } from '../../src/answer.js';
import { createHub, HubError, normalizeProposal } from '../../src/hub.js';
import { buildQuestion, moduleTransactionHash, packedTxHashes, questionHashOf } from '../../src/realityHash.js';
import { hubProposal } from '../stub/hub-stub.js';

const vector = JSON.parse(readFileSync(new URL('../fixtures/vectors/reality.json', import.meta.url), 'utf8'));
const CASE = vector.cases.find((c) => c.params.timeout === 600);
const MODULE = CASE.predictedModule;
const CHAIN = vector.chainId;
const SAFE = '0x5afe5afE5afE5afE5afE5aFe5aFe5Afe5Afe5AfE';
const SPACE = 'gov-vectors.eth';
const [SINGLE, DOUBLE] = CASE.proposals;
const silent = { info() {}, warn() {}, error() {} };

/** A proposal in the hub's shape for one of the vector's proposals. */
function proposalFor(vp, patch = {}) {
  return hubProposal({
    id: vp.proposalId,
    space: SPACE,
    module: MODULE,
    chainId: CHAIN,
    txs: vp.txs.map((t) => ({ to: t.to, value: t.value, data: t.data, operation: t.operation })),
    scores: [2, 0, 1],
    quorum: 2,
    ...patch,
  });
}

function answerer({ proposal, group = { chainId: CHAIN, safe: SAFE, space: SPACE }, scoresCall = null, hubError = null }) {
  let current = proposal;
  const hub = {
    getCalls: 0,
    scoresCalls: 0,
    async getProposal() {
      hub.getCalls += 1;
      if (hubError) throw hubError;
      return current ? normalizeProposal(current) : null;
    },
    async finalizeScores() {
      hub.scoresCalls += 1;
      if (scoresCall) current = scoresCall(current);
    },
  };
  const db = { getGroup: () => group };
  return { hub, ...createAnswerer({ hub, db, logger: silent }) };
}

const ask = (a, vp, extra = {}) =>
  a.decide({ chainId: CHAIN, safe: SAFE, module: MODULE, proposalId: vp.proposalId, questionHashHex: packedTxHashes(vp.txHashes), ...extra });

describe('answer', () => {
  test('answer: transaction hashes, the packed hash and the question equal the shared vector', () => {
    for (const tx of CASE.txs) assert.equal(moduleTransactionHash(CHAIN, MODULE, tx, tx.nonce), tx.txHash, tx.label);
    for (const vp of CASE.proposals) {
      assert.equal(packedTxHashes(vp.txHashes), vp.txHashesPackedKeccak);
      assert.equal(buildQuestion(vp.proposalId, vp.txHashes), vp.question);
      assert.match(questionHashOf(vp.question), /^0x[0-9a-f]{64}$/);
    }
  });

  test('answer: the answer bytes are 0, 1 and all ones', () => {
    assert.equal(ANSWER_BYTES.no, `0x${'00'.repeat(32)}`);
    assert.equal(ANSWER_BYTES.yes, `0x${'00'.repeat(31)}01`);
    assert.equal(ANSWER_BYTES.invalid, `0x${'ff'.repeat(32)}`);
  });

  test('answer: yes for a passed proposal in the Safe space whose transactions hash to the question hash', async () => {
    const a = answerer({ proposal: proposalFor(SINGLE) });
    assert.deepEqual(await ask(a, SINGLE), { answer: 'yes', reason: 'passed' });
    const two = answerer({ proposal: proposalFor(DOUBLE) });
    assert.deepEqual(await ask(two, DOUBLE), { answer: 'yes', reason: 'passed' });
  });

  test('answer: the hash may be given with or without 0x and in any case', async () => {
    const a = answerer({ proposal: proposalFor(SINGLE) });
    const hex = packedTxHashes(SINGLE.txHashes);
    for (const h of [hex, hex.slice(2), hex.toUpperCase().replace('0X', '0x')]) {
      assert.equal((await ask(a, SINGLE, { questionHashHex: h })).answer, 'yes', h);
    }
  });

  test('answer: invalid when the proposal is not closed and final yet', async () => {
    for (const patch of [
      { state: 'active', scoresState: 'pending', scores: [] },
      { state: 'closed', scoresState: 'pending', scores: [] },
      { state: 'pending', scoresState: 'pending', scores: [] },
    ]) {
      const a = answerer({ proposal: proposalFor(SINGLE, patch) });
      assert.deepEqual(await ask(a, SINGLE), { answer: 'invalid', reason: 'not_final' }, JSON.stringify(patch));
    }
  });

  test('answer: a closed proposal with pending scores makes the relayer ask the sequencer, then reads again', async () => {
    const pending = proposalFor(SINGLE, { state: 'closed', scoresState: 'pending', scores: [] });
    const a = answerer({ proposal: pending, scoresCall: () => proposalFor(SINGLE) });
    assert.deepEqual(await ask(a, SINGLE), { answer: 'yes', reason: 'passed' });
    assert.equal(a.hub.scoresCalls, 1);
    assert.equal(a.hub.getCalls, 2);
    // An active proposal gets no sequencer call: its scores are not due.
    const active = answerer({ proposal: proposalFor(SINGLE, { state: 'active', scoresState: 'pending', scores: [] }) });
    await ask(active, SINGLE);
    assert.equal(active.hub.scoresCalls, 0);
  });

  test('answer: a failing sequencer call does not stop the decision; scores that stay pending are invalid', async () => {
    const a = answerer({ proposal: proposalFor(SINGLE, { state: 'closed', scoresState: 'pending', scores: [] }) });
    a.hub.finalizeScores = async () => {
      throw new HubError('hub_unavailable');
    };
    assert.deepEqual(await ask(a, SINGLE), { answer: 'invalid', reason: 'not_final' });
  });

  test('answer: no for a closed, final proposal that did not pass', async () => {
    const cases = [
      [{ scores: [1, 2, 0] }, 'for-not-above-against'],
      [{ scores: [2, 2, 0], quorum: 1 }, 'for-not-above-against'],
      [{ scores: [1, 0, 0], quorum: 2 }, 'quorum-not-met'],
    ];
    for (const [patch, reason] of cases) {
      const a = answerer({ proposal: proposalFor(SINGLE, patch) });
      assert.deepEqual(await ask(a, SINGLE), { answer: 'no', reason }, JSON.stringify(patch));
    }
  });

  test('answer: no when the hub scores array holds fewer than the three choices of a basic proposal', async () => {
    const a = answerer({ proposal: proposalFor(SINGLE, { scores: [3, 1], scoresTotal: 4, quorum: 4 }) });
    assert.deepEqual(await ask(a, SINGLE), { answer: 'no', reason: 'scores_shape' });
  });

  test('answer: no for a proposal in another space, and the plugin is not even read', async () => {
    const other = proposalFor(SINGLE);
    other.space.id = 'someone-else.eth';
    assert.deepEqual(await ask(answerer({ proposal: other }), SINGLE), { answer: 'no', reason: 'wrong_space' });
    // The comparison ignores case, like ENS names do.
    const upper = proposalFor(SINGLE);
    upper.space.id = SPACE.toUpperCase();
    assert.equal((await ask(answerer({ proposal: upper }), SINGLE)).answer, 'yes');
  });

  test('answer: no when the question hash is not the hash of the proposal transactions', async () => {
    const a = answerer({ proposal: proposalFor(SINGLE) });
    assert.deepEqual(await ask(a, SINGLE, { questionHashHex: packedTxHashes(DOUBLE.txHashes) }), { answer: 'no', reason: 'hash_mismatch' });
    assert.deepEqual(await ask(a, SINGLE, { questionHashHex: `0x${'11'.repeat(32)}` }), { answer: 'no', reason: 'hash_mismatch' });
    assert.deepEqual(await ask(a, SINGLE, { questionHashHex: '' }), { answer: 'no', reason: 'hash_mismatch' });
  });

  test('answer: transaction order matters: swapping two transactions gives no', async () => {
    const swapped = proposalFor(DOUBLE);
    const rows = swapped.plugins.safeSnap.safes[0].txs[0];
    swapped.plugins.safeSnap.safes[0].txs[0] = [rows[1], rows[0]];
    assert.deepEqual(await ask(answerer({ proposal: swapped }), DOUBLE), { answer: 'no', reason: 'hash_mismatch' });
    assert.equal((await ask(answerer({ proposal: proposalFor(DOUBLE) }), DOUBLE)).answer, 'yes');
  });

  test('answer: a changed payment (value, recipient, data, operation) gives no', async () => {
    for (const edit of [
      (t) => { t.value = String(BigInt(t.value) + 1n); },
      (t) => { t.to = '0x0000000000000000000000000000000000000001'; },
      (t) => { t.data = '0x00'; },
      (t) => { t.operation = '1'; },
    ]) {
      const p = proposalFor(SINGLE);
      edit(p.plugins.safeSnap.safes[0].txs[0][0]);
      assert.deepEqual(await ask(answerer({ proposal: p }), SINGLE), { answer: 'no', reason: 'hash_mismatch' });
    }
  });

  test('answer: no for a proposal the hub does not know and for a Safe that is not registered', async () => {
    assert.deepEqual(await ask(answerer({ proposal: null }), SINGLE), { answer: 'no', reason: 'unknown_proposal' });
    assert.deepEqual(await ask(answerer({ proposal: proposalFor(SINGLE), group: null }), SINGLE), { answer: 'no', reason: 'unknown_group' });
  });

  test('answer: no when the plugin names another module, another network or holds no transactions', async () => {
    const otherModule = proposalFor(SINGLE);
    otherModule.plugins.safeSnap.safes[0].realityAddress = '0x0000000000000000000000000000000000000002';
    assert.deepEqual(await ask(answerer({ proposal: otherModule }), SINGLE), { answer: 'no', reason: 'plugin_other_module' });

    const otherNetwork = proposalFor(SINGLE);
    otherNetwork.plugins.safeSnap.safes[0].network = '1';
    assert.deepEqual(await ask(answerer({ proposal: otherNetwork }), SINGLE), { answer: 'no', reason: 'plugin_other_module' });

    const empty = proposalFor(SINGLE);
    empty.plugins.safeSnap.safes[0].txs = [[]];
    assert.deepEqual(await ask(answerer({ proposal: empty }), SINGLE), { answer: 'no', reason: 'no_transactions' });

    const noPlugin = proposalFor(SINGLE);
    noPlugin.plugins = {};
    assert.deepEqual(await ask(answerer({ proposal: noPlugin }), SINGLE), { answer: 'no', reason: 'no_transactions' });
  });

  test('answer: the module match ignores address case, and a plugin given as JSON text is read', async () => {
    const p = proposalFor(SINGLE);
    p.plugins.safeSnap.safes[0].realityAddress = MODULE.toLowerCase();
    p.plugins = JSON.stringify(p.plugins);
    assert.equal((await ask(answerer({ proposal: p }), SINGLE)).answer, 'yes');
  });

  test('answer: a malformed plugin transaction is bad_plugin, and the decision is no', () => {
    const base = proposalFor(SINGLE).plugins;
    const tx = () => base.safeSnap.safes[0].txs[0][0];
    for (const [edit, label] of [
      [(t) => { t.to = 'not-an-address'; }, 'address'],
      [(t) => { t.value = '-1'; }, 'negative value'],
      [(t) => { t.value = '1.5'; }, 'decimal value'],
      [(t) => { t.data = '0xabc'; }, 'odd hex'],
      [(t) => { t.operation = '2'; }, 'operation'],
    ]) {
      const plugins = structuredClone(base);
      edit(plugins.safeSnap.safes[0].txs[0][0]);
      assert.deepEqual(moduleTransactions(plugins, { chainId: CHAIN, module: MODULE }), { ok: false, reason: 'bad_plugin' }, label);
    }
    assert.ok(tx());
  });

  test('answer: a hub that cannot be read is an error, never an answer', async () => {
    const a = answerer({ proposal: proposalFor(SINGLE), hubError: new HubError('hub_unavailable') });
    await assert.rejects(() => ask(a, SINGLE), (e) => e instanceof HubError && e.code === 'hub_unavailable');
  });

  test('answer: the hub client backs off on 429 and gives up with hub_rate_limited', async () => {
    const delays = [];
    let calls = 0;
    const answers = [429, 429, 200];
    const fetchImpl = async () => {
      calls += 1;
      const status = answers.shift() ?? 429;
      return new Response(JSON.stringify({ data: { proposal: null } }), { status });
    };
    const hub = createHub({ networks: { 1: { hub: 'http://hub.invalid' } }, fetchImpl, sleep: async (ms) => { delays.push(ms); }, baseDelayMs: 100 });
    assert.equal(await hub.getProposal(1, '0x00'), null);
    assert.equal(calls, 3);
    assert.deepEqual(delays, [100, 200]);

    delays.length = 0;
    calls = 0;
    const always = createHub({ networks: { 1: { hub: 'http://hub.invalid' } }, fetchImpl: async () => { calls += 1; return new Response('{}', { status: 429 }); }, sleep: async (ms) => { delays.push(ms); }, baseDelayMs: 100, maxRetries: 3 });
    await assert.rejects(() => always.getProposal(1, '0x00'), (e) => e.code === 'hub_rate_limited');
    assert.equal(calls, 4);
    assert.deepEqual(delays, [100, 200, 400]);
  });

  test('answer: a hub answer with errors, a server error or a network failure is a HubError', async () => {
    const make = (fetchImpl) => createHub({ networks: { 1: { hub: 'http://hub.invalid' } }, fetchImpl, sleep: async () => {} });
    await assert.rejects(() => make(async () => new Response(JSON.stringify({ errors: [{ message: 'x' }] }), { status: 200 })).getProposal(1, '0x00'), (e) => e.code === 'hub_bad_response');
    await assert.rejects(() => make(async () => new Response('nope', { status: 500 })).getProposal(1, '0x00'), (e) => e.code === 'hub_unavailable');
    await assert.rejects(() => make(async () => { throw new Error('connect ECONNREFUSED http://hub.invalid/secret'); }).getProposal(1, '0x00'), (e) => e.code === 'hub_unavailable' && !/secret/.test(e.message));
  });
});
