// D-35, D-37: POST /send/safe-exec says definitely when the community's fee account cannot pay a send
// (502 payer_empty, exactly three keys, read before anything is reserved), and only then: a send that would fail is
// 409, a check that could not be made is a retryable 502, and a request already in the queue gets the queue's answer.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BaseError, ExecutionRevertedError, HttpRequestError, RpcRequestError, SocketClosedError, TimeoutError,
} from 'viem';
import { loadNetworks } from '../../src/config.js';
import { execBody, SAFE, SIM_FALSE, SIM_TRUE, startStub } from '../helpers/stub.js';
import { refusal } from '../helpers/node.js';

const networks = loadNetworks();
const CHAIN = 11155111;
const GROUP = [{ chainId: CHAIN, safe: SAFE, space: 'a.eth' }];
const GAS = 100000n;
const FEE = 10n ** 9n;
// The cost the cap reserves: (estimate x 12 / 10) x maxFeePerGas.
const COST = ((GAS * 12n) / 10n) * FEE;
const URL = 'http://rpc.invalid';
const KEY = (nonce) => `safe-exec:${CHAIN}:${SAFE.toLowerCase()}:${nonce}`;

const down = () => new HttpRequestError({ url: URL, details: 'fetch failed' });
const revert = (cause) => new ExecutionRevertedError(cause ? { cause } : {});
// An estimate error that names no cause the relayer knows: no transport class, no revert class, no telling words.
const opaque = () => new BaseError('estimate did not answer', { cause: new BaseError('node said no') });
const rpc = (code) => new RpcRequestError({ body: { method: 'eth_estimateGas' }, error: { code, message: 'node answer' }, url: URL });
const throws = () => { throw new Error('balance read failed'); };

async function stub(chainsOpts = {}) {
  return startStub({ groups: GROUP, chainsOpts: { gas: GAS, maxFeePerGas: FEE, ...chainsOpts } });
}

// Counts cap.reserve calls: a payer_empty answered before the queue must never have reserved, even for a moment (TM-324).
function spyReserve(cap) {
  const seen = { count: 0 };
  const reserve = cap.reserve.bind(cap);
  cap.reserve = (...args) => { seen.count += 1; return reserve(...args); };
  return seen;
}

async function once(chainsOpts, body = {}) {
  const s = await stub(chainsOpts);
  const reserves = spyReserve(s.cap);
  try {
    const res = await s.call('POST', '/send/safe-exec', execBody(networks, body));
    return { res, calls: { ...s.chains.calls, sent: s.chains.calls.sent.length }, spent: BigInt(s.cap.status().spentDayWei), reserves: reserves.count, logs: [...s.logs] };
  } finally {
    await s.close();
  }
}

function assertPayerEmpty(out, label = '', { broadcastTried = false } = {}) {
  assert.equal(out.res.status, 502, `${label} ${out.res.text}`);
  assert.deepEqual(Object.keys(out.res.json), ['error', 'reason', 'broadcast'], label);
  assert.equal(out.res.json.error, 'send_failed', label);
  assert.equal(out.res.json.reason, 'payer_empty', label);
  assert.equal(out.res.json.broadcast, false, label);
  // A refused broadcast was tried and nothing went out; every other payer_empty is answered before any broadcast.
  if (broadcastTried) assert.equal(out.calls.sent, 0, `${label} nothing went out`);
  else assert.equal(out.calls.send, 0, `${label} nothing sent`);
  assert.equal(out.reserves, broadcastTried ? 1 : 0, `${label} reserve calls`);
  assert.equal(out.spent, 0n, `${label} nothing reserved`);
}

function assertStatus(out, status, reason, label = '') {
  assert.equal(out.res.status, status, `${label} ${out.res.text}`);
  assert.equal(out.res.json.reason, reason, label);
  assert.notEqual(out.res.json.reason, 'payer_empty', label);
  if (status === 502) assert.equal(out.res.json.broadcast, false, label);
  assert.equal(out.calls.send, 0, `${label} nothing sent`);
  assert.equal(out.spent, 0n, `${label} nothing reserved`);
}

describe('safe-exec D-35: the fee account cannot pay', () => {
  test('safe-exec D-35: a good estimate and a balance one wei below the cost answers payer_empty, three keys, nothing reserved', async () => {
    const out = await once({ balance: COST - 1n });
    assertPayerEmpty(out);
    assert.equal(out.calls.call, 1, 'the one read-only simulation');
    assert.ok(!out.logs.some((l) => l.includes(String(COST - 1n))), 'no balance figure in a log line');
  });

  test('safe-exec D-35: a send that would fail is never told payer_empty (balance below the cost)', async () => {
    assertStatus(await once({ balance: COST - 1n, sim: SIM_FALSE }), 409, 'simulation_failed', 'SIM_FALSE');
    assertStatus(await once({ balance: COST - 1n, sim: revert() }), 409, 'simulation_failed', 'typed revert');
    assertStatus(await once({ balance: COST - 1n, sim: down() }), 502, 'fee_estimate_failed', 'transport');
    assertStatus(await once({ balance: COST - 1n, sim: new Error('unknown') }), 502, 'fee_estimate_failed', 'plain Error');
  });

  test('safe-exec D-35: the cost line: a balance of exactly the cost sends, the cost without the margin does not', async () => {
    const exact = await once({ balance: COST });
    assert.equal(exact.res.status, 202, exact.res.text);
    assert.equal(exact.calls.send, 1);
    assertPayerEmpty(await once({ balance: GAS * FEE }), 'no margin');
  });

  test('safe-exec D-35: an unreadable balance after a good estimate goes on as today and sends', async () => {
    const out = await once({ balance: throws });
    assert.equal(out.res.status, 202, out.res.text);
    assert.equal(out.calls.send, 1);
  });

  test('safe-exec D-35: an empty or dust account whose own estimate fails is decided by the estimate without an account', async () => {
    const accountOnly = { estimateError: opaque(), estimateErrorAccountOnly: true };
    assertPayerEmpty(await once({ ...accountOnly, balance: 0n }), 'empty');
    assertPayerEmpty(await once({ ...accountOnly, balance: COST - 1n }), 'dust');
    assertStatus(await once({ estimateError: revert(), estimateErrorAccountOnly: true, balance: COST }), 409, 'simulation_failed', 'dust at the cost, typed revert first');
    assertStatus(await once({ ...accountOnly, balance: COST }), 502, 'fee_estimate_failed', 'dust at the cost, unrecognised first');
    assertStatus(await once({ ...accountOnly, balance: 0n, sim: SIM_FALSE }), 409, 'simulation_failed', 'empty, SIM_FALSE');
  });

  test('safe-exec D-35: a genuine revert with an empty account is 409, never payer_empty', async () => {
    assertStatus(await once({ estimateError: revert(), balance: 0n }), 409, 'simulation_failed');
  });

  test('safe-exec D-35: a first estimate that fails in transport is a retryable 502 with no second estimate', async () => {
    const wrappedTimeout = new BaseError('estimate failed', { cause: new TimeoutError({ body: { method: 'eth_estimateGas' }, url: URL }) });
    const socketCode = new BaseError('estimate failed', { cause: Object.assign(new Error('socket'), { code: 'ECONNRESET' }) });
    for (const [label, e] of [['HttpRequestError', down()], ['TimeoutError', wrappedTimeout], ['ECONNRESET', socketCode], ['-32005', rpc(-32005)]]) {
      const out = await once({ estimateError: e, balance: 0n });
      assertStatus(out, 502, 'fee_estimate_failed', label);
      assert.equal(out.calls.estimate, 1, `${label}: no second estimate`);
    }
  });

  test('safe-exec D-35: a socket failure inside a revert-typed second estimate is a retryable 502', async () => {
    const out = await once({ estimateError: opaque(), estimateErrorAccountOnly: true, plainEstimateError: revert(new SocketClosedError({ url: URL })), balance: 0n });
    assertStatus(out, 502, 'fee_estimate_failed');
  });

  test('safe-exec D-35: no words are read: a revert whose text names a timeout is 409, "insufficient funds" text decides nothing', async () => {
    const wordy = new ExecutionRevertedError({ message: 'timeout ECONNRESET socket hang up' });
    assertStatus(await once({ estimateError: opaque(), estimateErrorAccountOnly: true, plainEstimateError: wordy, balance: 0n }), 409, 'simulation_failed', 'wordy revert');
    const funds = new BaseError('insufficient funds for gas * price + value');
    assertStatus(await once({ estimateError: funds, estimateErrorAccountOnly: true, plainEstimateError: revert(), balance: 0n }), 409, 'simulation_failed', 'funds words first');
  });

  test('safe-exec D-35: an untyped second estimate is the unrecognised default; RPC code 3 is a revert', async () => {
    const accountOnly = { estimateError: opaque(), estimateErrorAccountOnly: true, balance: 0n };
    assertStatus(await once({ ...accountOnly, plainEstimateError: new Error('execution reverted') }), 502, 'fee_estimate_failed', 'plain Error');
    assertStatus(await once({ ...accountOnly, plainEstimateError: rpc(3) }), 409, 'simulation_failed', 'code 3');
  });

  test('safe-exec D-35: after the account-less estimate answers, unreadable fees or balance are a retryable 502', async () => {
    const accountOnly = { estimateError: opaque(), estimateErrorAccountOnly: true };
    assertStatus(await once({ ...accountOnly, balance: 0n, feeError: down() }), 502, 'fee_estimate_failed', 'fees');
    assertStatus(await once({ ...accountOnly, balance: throws }), 502, 'fee_estimate_failed', 'balance');
  });

  test('safe-exec D-35: a broadcast the node refuses for lack of funds is a retryable could-not-check, never payer_empty, and gives the reservation back', async () => {
    // Once queued, a funds refusal cannot rule out a send of
    // the same Safe nonce coming back to life during the broadcast, so the definite answer stays on the pre-queue paths.
    const words = 'insufficient funds for gas * price + value: balance 0, tx cost 1';
    for (const [label, e] of [['-32003', refusal(words, -32003)], ['-32000', refusal(words, -32000)], ['wrapped', new BaseError('send failed', { cause: refusal(words, -32003) })]]) {
      const out = await once({ sendError: e });
      assert.equal(out.res.status, 502, `${label} ${out.res.text}`);
      assert.equal(out.res.json.broadcast, false, label);
      assert.notEqual(out.res.json.reason, 'payer_empty', label);
      assert.equal(out.calls.sent, 0, `${label} nothing went out`);
      assert.equal(out.spent, 0n, `${label} the reservation is given back`);
    }
    const under = await once({ sendError: refusal('transaction underpriced') });
    assert.equal(under.res.status, 502, under.res.text);
    assert.equal(under.res.json.broadcast, false);
    assert.notEqual(under.res.json.reason, 'payer_empty');
    assert.equal(under.spent, 0n);
  });

  test('safe-exec D-35: a request already in the queue gets the duplicate answer, never payer_empty', async () => {
    let balance = 5n * 10n ** 18n;
    const s = await stub({ safeNonce: 7, balance: () => balance });
    try {
      const first = await s.call('POST', '/send/safe-exec', execBody(networks));
      assert.equal(first.status, 202, first.text);
      const spent = BigInt(s.cap.status().spentDayWei);
      balance = COST - 1n;
      const again = await s.call('POST', '/send/safe-exec', execBody(networks));
      assert.equal(again.status, 202, again.text);
      assert.deepEqual(again.json, { hash: first.json.hash, status: 'pending', duplicate: true });
      assert.equal(BigInt(s.cap.status().spentDayWei), spent, 'nothing more reserved');
      // The dust path of point 2 with the same live row.
      s.chains.options.estimateError = opaque();
      s.chains.options.estimateErrorAccountOnly = true;
      const dust = await s.call('POST', '/send/safe-exec', execBody(networks));
      assert.equal(dust.status, 202, dust.text);
      assert.deepEqual(dust.json, { hash: first.json.hash, status: 'pending', duplicate: true });
      assert.equal(BigInt(s.cap.status().spentDayWei), spent, 'nothing more reserved');
    } finally {
      await s.close();
    }
  });

  test('safe-exec D-35: a row that becomes live while the balance is read is answered as a duplicate (interleaving)', async () => {
    for (const path of ['point 1', 'point 2']) {
      let s;
      let wrote = false;
      const hash = `0x${'cd'.repeat(32)}`;
      const balance = () => {
        if (!wrote) {
          wrote = true;
          s.db.insertPending({
            chainId: CHAIN, nonce: 3, hash, to: SAFE, data: '0x', value: 0n, gas: GAS, maxFeePerGas: FEE, maxPriorityFeePerGas: 1n,
            sentBlock: 1000n, safe: SAFE, kind: 'safe-exec', dedupeKey: KEY(7),
          });
        }
        return COST - 1n;
      };
      const extra = path === 'point 2' ? { estimateError: opaque(), estimateErrorAccountOnly: true } : {};
      s = await stub({ safeNonce: 7, balance, ...extra });
      try {
        const res = await s.call('POST', '/send/safe-exec', execBody(networks));
        assert.equal(res.status, 202, `${path} ${res.text}`);
        assert.deepEqual(res.json, { hash, status: 'pending', duplicate: true }, path);
        assert.equal(BigInt(s.cap.status().spentDayWei), 0n, `${path}: nothing reserved`);
      } finally {
        await s.close();
      }
    }
  });

  test('safe-exec D-35: the simulation after the reservation: could not check is 502 simulation_unavailable, a revert stays 409', async () => {
    for (const [label, sim] of [['transport', down()], ['plain Error', new Error('unknown')]]) {
      const out = await once({ sim });
      assert.equal(out.res.status, 502, `${label} ${out.res.text}`);
      assert.deepEqual(out.res.json, { error: 'send_failed', reason: 'simulation_unavailable', broadcast: false }, label);
      assert.equal(out.spent, 0n, `${label}: the reservation is given back`);
      assert.equal(out.calls.send, 0);
    }
    const reverted = revert();
    const typed = await once({ sim: reverted });
    assertStatus(typed, 409, 'simulation_failed', 'typed revert');
    assert.deepEqual(typed.res.json, { error: 'conflict', reason: 'simulation_failed', detail: reverted.shortMessage }, 'the 409 keeps its detail');
    const decoded = await once({ sim: SIM_FALSE });
    assertStatus(decoded, 409, 'simulation_failed', 'SIM_FALSE');
    assert.deepEqual(decoded.res.json, { error: 'conflict', reason: 'simulation_failed' }, 'a false result has no detail, as before');
    const ok = await once({ sim: SIM_TRUE });
    assert.equal(ok.res.status, 202, ok.res.text);
  });
});
