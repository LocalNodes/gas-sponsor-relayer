// D-39: carrying out a passed payment (POST /send/reality/execute) says definitely
// when the community's fee account cannot pay, under the same three conditions as safe-exec, through the pipeline's
// opt-in feeVerdict. Every other pipeline caller (add, answer, the bond reclaim) answers exactly as before.
// The set-up follows realityService() in duplicate.test.js, but over the real pipeline and the stub chain, whose
// options drive the balance, the estimates, the eth_call and the broadcast.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { BaseError, ExecutionRevertedError, getAddress, HttpRequestError, zeroHash } from 'viem';
import { loadNetworks } from '../../src/config.js';
import { openDb } from '../../src/db.js';
import { createCap } from '../../src/cap.js';
import { createQueue } from '../../src/queue.js';
import { createPipeline } from '../../src/sends/pipeline.js';
import { createReality } from '../../src/sends/reality.js';
import { ANSWER_BYTES } from '../../src/answer.js';
import { SAFE, stubChains } from '../helpers/stub.js';
import { CHAIN, ME, quiet, refusal } from '../helpers/node.js';

const networks = loadNetworks();
const MODULE = getAddress(`0x${'4d'.repeat(20)}`);
const QID = `0x${'7a'.repeat(32)}`;
const PROPOSAL = `0x${'5c'.repeat(32)}`;
const TXHASH = `0x${'11'.repeat(32)}`;
const COMMUNITY = 'Test Community';
const GAS = 100000n;
const FEE = 10n ** 9n;
const COST = ((GAS * 12n) / 10n) * FEE;
const URL = 'http://rpc.invalid';
const KEY = `reality-execute:${CHAIN}:${QID}:0`;
const v = { chainId: CHAIN, safe: SAFE, proposalId: PROPOSAL };

const down = () => new HttpRequestError({ url: URL, details: 'fetch failed' });
const revert = () => new ExecutionRevertedError({});
const opaque = () => new BaseError('estimate did not answer', { cause: new BaseError('node said no') });

/** A Reality service over the real pipeline and queue, on the stub chain; the proposal passed, is final and cooled down. */
// `onBroadcast`, when given, runs as the send reaches the node (to write a row while the broadcast is under way).
function service(chainsOpts = {}, { asked = true, onBroadcast = null } = {}) {
  const db = openDb(':memory:');
  const cap = createCap({ db, caps: { dayWei: 10n ** 18n, monthWei: 10n ** 19n } });
  const read = ({ functionName }) => ({
    buildQuestion: 'Q', questionIds: asked ? QID : zeroHash, getQuestionId: QID, isFinalized: true, getBond: 0n, minimumBond: 10n,
    executedProposalTransactions: false, resultFor: ANSWER_BYTES.yes, getFinalizeTS: 0, questionCooldown: 0,
  })[functionName];
  const base = stubChains(networks, { gas: GAS, maxFeePerGas: FEE, readResult: read, ...chainsOpts });
  const chains = {
    ...base,
    get(id) {
      const c = base.get(id);
      if (c) c.publicClient.getBlock = async () => ({ timestamp: 10n });
      return c;
    },
  };
  if (onBroadcast) {
    const wallet = base.get(CHAIN).walletClient;
    const send = wallet.sendRawTransaction.bind(wallet);
    wallet.sendRawTransaction = async (args) => { onBroadcast(); return send(args); };
  }
  const queue = createQueue({ db, chains, cap, address: ME, logger: quiet });
  db.addGroup({ chainId: CHAIN, safe: SAFE, space: 'a.eth', community: COMMUNITY });
  const answerer = {
    async evaluate() { return { kind: 'ok', question: 'Q', txHashes: [TXHASH], packedHash: TXHASH, txs: [{ to: ME, value: 0n, data: '0x', operation: 0 }] }; },
    decideFromVerdict() { return { answer: 'yes', reason: 'passed' }; },
  };
  const pipeline = createPipeline({ config: { address: ME }, db, chains, cap, queue, logger: quiet });
  const reality = createReality({
    db, config: { configured: true, address: ME }, networks, chains, cap, queue,
    groupModules: { async modulesFor() { return [MODULE]; } }, hub: null, answerer, pipeline, logger: quiet,
  });
  const close = () => { queue.stop(); db.close(); };
  return { db, cap, chains: base, reality, pipeline, close, spent: () => BigInt(cap.status().spentDayWei) };
}

async function execute(chainsOpts) {
  const s = service(chainsOpts);
  const seen = { count: 0 };
  const reserve = s.cap.reserve.bind(s.cap);
  s.cap.reserve = (...args) => { seen.count += 1; return reserve(...args); };
  try {
    const res = await s.reality.execute(v);
    return { res, calls: { ...s.chains.calls, sent: s.chains.calls.sent.length }, spent: s.spent(), queued: s.db.listPending().length, reserves: seen.count };
  } finally {
    s.close();
  }
}

function assertPayerEmpty(out, label = '', { broadcastTried = false } = {}) {
  assert.equal(out.res.status, 502, `${label} ${JSON.stringify(out.res.body)}`);
  assert.deepEqual(Object.keys(out.res.body), ['error', 'reason', 'broadcast'], label);
  assert.deepEqual(out.res.body, { error: 'send_failed', reason: 'payer_empty', broadcast: false }, label);
  assert.equal(out.calls.sent, 0, `${label} nothing went out`);
  assert.equal(out.spent, 0n, `${label} nothing reserved`);
  assert.equal(out.queued, 0, `${label} nothing queued`);
  // Before the queue nothing is reserved, even for a moment (TM-324); a refused broadcast gave its reservation back.
  assert.equal(out.reserves, broadcastTried ? 1 : 0, `${label} reserve calls`);
}

function assertStatus(out, status, reason, label = '') {
  assert.equal(out.res.status, status, `${label} ${JSON.stringify(out.res.body)}`);
  assert.equal(out.res.body.reason, reason, label);
  if (status === 502) assert.equal(out.res.body.broadcast, false, label);
  assert.equal(out.calls.sent, 0, `${label} nothing went out`);
  assert.equal(out.spent, 0n, `${label} nothing reserved`);
}

describe('reality-execute D-39: the fee account cannot pay', () => {
  test('reality-execute D-39: a balance one wei below the cost answers payer_empty, three keys, nothing queued or reserved; the cost itself sends', async () => {
    assertPayerEmpty(await execute({ balance: COST - 1n }));
    const exact = await execute({ balance: COST });
    assert.equal(exact.res.status, 202, JSON.stringify(exact.res.body));
    assert.equal(exact.calls.sent, 1);
  });

  test('reality-execute D-39: an execute whose simulation fails is never told payer_empty', async () => {
    assertStatus(await execute({ balance: COST - 1n, sim: revert() }), 409, 'simulation_failed', 'typed revert');
    assertStatus(await execute({ balance: COST - 1n, sim: down() }), 502, 'fee_estimate_failed', 'transport');
  });

  test('reality-execute D-39: a failed first estimate is decided by the estimate without an account', async () => {
    assertPayerEmpty(await execute({ estimateError: opaque(), estimateErrorAccountOnly: true, balance: 0n }), 'empty');
    assertStatus(await execute({ estimateError: revert(), balance: 0n }), 409, 'simulation_failed', 'both revert');
    assertStatus(await execute({ estimateError: down(), balance: 0n }), 502, 'fee_estimate_failed', 'transport');
  });

  test('reality-execute D-39: after queueing, a broadcast refused for lack of funds is a retryable could-not-check, never payer_empty', async () => {
    // The service's rule: the definite "the fee account is empty" is only ever given before
    // anything is queued. After queueing, a funds refusal keeps the node's own reason, 502 broadcast false.
    for (const [label, e] of [['-32003', refusal('insufficient funds for gas * price + value: balance 0', -32003)], ['-32000', refusal('insufficient funds for gas * price + value: balance 0')]]) {
      const out = await execute({ sendError: e });
      assert.equal(out.res.status, 502, `${label} ${JSON.stringify(out.res.body)}`);
      assert.equal(out.res.body.broadcast, false, label);
      assert.notEqual(out.res.body.reason, 'payer_empty', label);
      assert.equal(out.calls.sent, 0, `${label} nothing went out`);
      assert.equal(out.spent, 0n, `${label} the reservation is given back`);
      assert.equal(out.queued, 0, `${label} nothing left queued`);
    }
  });

  test('reality-execute D-39: a request already in the queue gets the duplicate answer, also when the row appears mid-read', async () => {
    const hash = `0x${'cd'.repeat(32)}`;
    const row = (db) => db.insertPending({
      chainId: CHAIN, nonce: 3, hash, to: MODULE, data: '0x', value: 0n, gas: GAS, maxFeePerGas: FEE, maxPriorityFeePerGas: 1n,
      sentBlock: 1000n, safe: SAFE, kind: 'reality-execute', dedupeKey: KEY,
    });
    const before = service({ balance: COST - 1n });
    try {
      row(before.db);
      const res = await before.reality.execute(v);
      assert.equal(res.status, 202, JSON.stringify(res.body));
      assert.equal(res.body.hash, hash);
      assert.equal(res.body.duplicate, true);
      assert.equal(before.spent(), 0n);
    } finally {
      before.close();
    }
    let s;
    let wrote = false;
    s = service({ balance: () => { if (!wrote) { wrote = true; row(s.db); } return COST - 1n; } });
    try {
      const res = await s.reality.execute(v);
      assert.equal(res.status, 202, JSON.stringify(res.body));
      assert.equal(res.body.hash, hash);
      assert.equal(res.body.duplicate, true);
      assert.equal(s.spent(), 0n);
    } finally {
      s.close();
    }
  });

  test('reality-execute D-39: a row that goes live while the broadcast is refused is answered as a duplicate', async () => {
    // A send with the same key can come to life while this one's broadcast is under way. After the
    // refusal it is answered as the queue would, 202 already pending.
    const hash = `0x${'ef'.repeat(32)}`;
    let s;
    let wrote = false;
    const onBroadcast = () => {
      if (wrote) return;
      wrote = true;
      s.db.insertPending({
        chainId: CHAIN, nonce: 4, hash, to: MODULE, data: '0x', value: 0n, gas: GAS, maxFeePerGas: FEE, maxPriorityFeePerGas: 1n,
        sentBlock: 1000n, safe: SAFE, kind: 'reality-execute', dedupeKey: KEY,
      });
    };
    s = service({ sendError: refusal('insufficient funds for gas * price + value: balance 0', -32003) }, { onBroadcast });
    try {
      const res = await s.reality.execute(v);
      assert.ok(wrote, 'the row was written during the broadcast');
      assert.equal(res.status, 202, JSON.stringify(res.body));
      assert.equal(res.body.hash, hash);
      assert.equal(res.body.duplicate, true);
      assert.equal(s.spent(), 0n, 'the refused send gave its reservation back');
    } finally {
      s.close();
    }
  });

  test('reality-execute D-39: every other pipeline caller answers as before (add, the bond claim, a refusal on add)', async () => {
    const add = service({ estimateError: opaque(), estimateErrorAccountOnly: true, balance: 0n }, { asked: false });
    try {
      const res = await add.reality.add(v);
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(res.body.reason, 'simulation_failed');
    } finally {
      add.close();
    }
    // The bond reclaim's claim step sends through the pipeline without feeVerdict, and reads its 409 as
    // claim:simulation_failed (reclaim.js); no existing test pins that answer.
    const claim = service({ estimateError: opaque(), estimateErrorAccountOnly: true, balance: 0n });
    try {
      const out = await claim.pipeline.send({ chainId: CHAIN, safe: SAFE, to: MODULE, selectorName: 'claimWinnings', data: '0x', kind: 'reality-claim', list: { check: () => ({ ok: true }) } });
      assert.equal(out.ok, false);
      assert.equal(out.status, 409);
      assert.equal(out.body.reason, 'simulation_failed');
    } finally {
      claim.close();
    }
    const refused = service({ sendError: refusal('insufficient funds for gas * price + value: balance 0', -32003) }, { asked: false });
    try {
      const res = await refused.reality.add(v);
      assert.equal(res.status, 502, JSON.stringify(res.body));
      assert.equal(res.body.broadcast, false);
      assert.notEqual(res.body.reason, 'payer_empty');
    } finally {
      refused.close();
    }
  });
});
