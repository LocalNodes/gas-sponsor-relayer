// POST /send/safe-create: deploy one Group's first Safe (1.4.1) through the canonical proxy factory and pay its gas
// (Sponsored Fund Creation). The site names owners, threshold and salt; the relayer builds the factory call and
// the CREATE2 address itself, so the body can never carry calldata, a target or a value.
import { concat, encodeFunctionData, getAddress, getContractAddress, isAddress, keccak256, pad, parseAbi, stringToHex, toHex, zeroAddress } from 'viem';
import { buildCreation, CREATION_SELECTORS } from '../allowlist.js';
import { CapReached } from '../cap.js';
import { chainIsConfigured, chainIsSponsored, NOT_SPONSORED } from '../config.js';
import { boundSite, quotaVerdict, slotState, UUID } from '../creations.js';

/**
 * Safe 1.4.1, the only version the relayer creates. The factory, L2 singleton and fallback handler addresses are the
 * chain's networks.json entry (safeProxyFactory, safeSingletonL2, safeFallbackHandler). The CREATE2 init code is
 * SafeProxyFactory 1.4.1's proxyCreationCode() followed by the singleton as a uint256. The relayer keeps only the
 * hash of that code: it reads the code from the factory itself, once per chain, and refuses a factory whose code
 * has another hash (creationCodeReader). The code is the Safe project's; its bytes stay out of this repository.
 */
export const SAFE_VERSION = '1.4.1';
export const PROXY_CREATION_CODE_141_KECCAK = '0x1856e0ee08399d74e0ea0b03adca210aeade6f748969ac023cdcb4dd62dcaf5f';
export const proxyCreationCodeAbi = parseAbi(['function proxyCreationCode() pure returns (bytes)']);

/** The chain's Safe 1.4.1 set-up contracts from its networks.json entry, or null when it has none. */
export function deploymentOf(entry) {
  const d = { factory: entry?.safeProxyFactory, singleton: entry?.safeSingletonL2, fallbackHandler: entry?.safeFallbackHandler };
  return Object.values(d).every((a) => typeof a === 'string' && isAddress(a, { strict: false })) ? d : null;
}

export const setupAbi = parseAbi([
  'function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
]);
export const factoryAbi = parseAbi([
  'function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)',
]);

/** Safe.setup(owners, threshold, 0x0, 0x, fallbackHandler, 0x0, 0, 0x0): no module call, no payment, no refund. */
export function buildInitializer(deployment, owners, threshold) {
  return encodeFunctionData({
    abi: setupAbi,
    functionName: 'setup',
    args: [owners.map((o) => getAddress(o)), BigInt(threshold), zeroAddress, '0x', deployment.fallbackHandler, zeroAddress, 0n, zeroAddress],
  });
}

/** keccak256 of the CREATE2 init code: the factory's proxy creation code followed by the singleton as a uint256. */
export function initCodeHashOf(proxyCreationCode, singleton) {
  return keccak256(concat([proxyCreationCode, pad(singleton, { size: 32 })]));
}

/** The address SafeProxyFactory 1.4.1 gives createProxyWithNonce(singleton, initializer, saltNonce). */
export function predictAddress(deployment, initializer, saltNonce, initCodeHash) {
  const salt = keccak256(concat([keccak256(initializer), pad(toHex(BigInt(saltNonce)), { size: 32 })]));
  return getContractAddress({ opcode: 'CREATE2', from: deployment.factory, salt, bytecodeHash: initCodeHash });
}

/**
 * The init code hash for a chain's factory and singleton, read from the factory's own proxyCreationCode() and
 * checked against the expected hash. One read per chain, factory and singleton; only a good answer is kept, so a
 * failed read or a wrong code is asked again next time. Returns {ok: true, hash} or {ok: false, reason} with reason
 * 'unreadable' (the node did not answer) or 'mismatch' (the factory's code is not Safe 1.4.1's).
 */
export function creationCodeReader({ expectedKeccak = PROXY_CREATION_CODE_141_KECCAK } = {}) {
  const known = new Map();
  return async function initCodeHash(chainId, deployment, publicClient) {
    const key = `${chainId}:${deployment.factory.toLowerCase()}:${deployment.singleton.toLowerCase()}`;
    if (known.has(key)) return { ok: true, hash: known.get(key) };
    let code;
    try {
      code = await publicClient.readContract({ address: deployment.factory, abi: proxyCreationCodeAbi, functionName: 'proxyCreationCode' });
    } catch {
      return { ok: false, reason: 'unreadable' };
    }
    if (typeof code !== 'string' || !/^0x([0-9a-fA-F]{2})+$/.test(code) || keccak256(code) !== expectedKeccak.toLowerCase()) return { ok: false, reason: 'mismatch' };
    const hash = initCodeHashOf(code, deployment.singleton);
    known.set(key, hash);
    return { ok: true, hash };
  };
}

/** The factory calldata the relayer sends, value 0. */
export function creationCalldata(deployment, initializer, saltNonce) {
  return encodeFunctionData({ abi: factoryAbi, functionName: 'createProxyWithNonce', args: [deployment.singleton, initializer, BigInt(saltNonce)] });
}

// ---- The request -------------------------------------------------------------------------------------------------

export const REQUEST_KEYS = Object.freeze(['actor', 'chainId', 'expiresAt', 'groupUuid', 'intentUuid', 'issuedAt', 'owners', 'predictedAddress', 'safeVersion', 'saltNonce', 'siteUuid', 'threshold']);
const ACTOR_KEYS = ['address', 'uuid'];
const MAX_OWNERS = 10;
const UINT256_MAX = (1n << 256n) - 1n;
const SALT = /^(0|[1-9][0-9]{0,77})$/;
const VERSION = /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/;
// The envelope (contract rules.envelope): a request lives 1 to 300 seconds and may be issued up to 60 seconds ahead.
export const ENVELOPE_MAX_S = 300;
export const CLOCK_SKEW_S = 60;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isSeconds = (v) => Number.isSafeInteger(v) && v > 0;

/**
 * Validate the wire body against the contract's request rules. Exactly the contract's keys: any other key (calldata,
 * a target, a value, a payment receiver) is refused as unexpected_field before anything else is looked at.
 * Returns {ok, value} or {ok: false, reason}.
 */
export function parseSafeCreateBody(body) {
  if (!isPlainObject(body)) return { ok: false, reason: 'the body must be a JSON object' };
  if (Object.keys(body).some((k) => !REQUEST_KEYS.includes(k))) return { ok: false, reason: 'unexpected_field' };
  if (isPlainObject(body.actor) && Object.keys(body.actor).some((k) => !ACTOR_KEYS.includes(k))) return { ok: false, reason: 'unexpected_field' };
  const bad = (reason) => ({ ok: false, reason });
  for (const f of ['siteUuid', 'groupUuid', 'intentUuid']) if (typeof body[f] !== 'string' || !UUID.test(body[f])) return bad(`${f} must be a lower-case UUID`);
  if (!isPlainObject(body.actor) || typeof body.actor.uuid !== 'string' || !UUID.test(body.actor.uuid) || typeof body.actor.address !== 'string' || !isAddress(body.actor.address, { strict: false })) {
    return bad('actor must be {"uuid": a lower-case UUID, "address": an address}');
  }
  if (!Number.isSafeInteger(body.chainId) || body.chainId <= 0) return bad('chainId must be a positive integer');
  if (typeof body.safeVersion !== 'string' || !VERSION.test(body.safeVersion)) return bad('safeVersion must be a version such as 1.4.1');
  const owners = body.owners;
  if (
    !Array.isArray(owners) || owners.length < 1 || owners.length > MAX_OWNERS
    || owners.some((o) => typeof o !== 'string' || !isAddress(o, { strict: false }) || BigInt(o) === 0n)
    || new Set(owners.map((o) => o.toLowerCase())).size !== owners.length
  ) {
    return bad('owners must be 1 to 10 distinct non-zero addresses');
  }
  if (!Number.isInteger(body.threshold) || body.threshold < 1 || body.threshold > owners.length) return bad('threshold must be a whole number from 1 to the number of owners');
  if (typeof body.saltNonce !== 'string' || !SALT.test(body.saltNonce) || BigInt(body.saltNonce) > UINT256_MAX) return bad('saltNonce must be a decimal string below 2^256 with no leading zeros');
  if (typeof body.predictedAddress !== 'string' || !isAddress(body.predictedAddress, { strict: false })) return bad('predictedAddress must be an address');
  if (!isSeconds(body.issuedAt) || !isSeconds(body.expiresAt)) return bad('issuedAt and expiresAt must be whole seconds');
  return {
    ok: true,
    value: {
      siteUuid: body.siteUuid,
      groupUuid: body.groupUuid,
      intentUuid: body.intentUuid,
      actor: { uuid: body.actor.uuid, address: getAddress(body.actor.address) },
      chainId: body.chainId,
      safeVersion: body.safeVersion,
      owners: owners.map((o) => getAddress(o)),
      threshold: body.threshold,
      saltNonce: BigInt(body.saltNonce).toString(),
      predictedAddress: getAddress(body.predictedAddress),
      issuedAt: body.issuedAt,
      expiresAt: body.expiresAt,
    },
  };
}

/** The intent's identity (contract rules.intentDigest): neither the actor nor the envelope is part of it. */
export function intentDigest(v) {
  return keccak256(stringToHex(JSON.stringify([v.chainId, v.intentUuid, v.owners.map((o) => getAddress(o)), getAddress(v.predictedAddress), v.safeVersion, String(v.saltNonce), v.threshold])));
}

/** A new acceptance needs a live envelope: 1 to 300 seconds long, issued no more than 60 seconds ahead, not expired. */
export function envelopeLive(v, nowS) {
  const span = v.expiresAt - v.issuedAt;
  return span >= 1 && span <= ENVELOPE_MAX_S && v.issuedAt <= nowS + CLOCK_SKEW_S && nowS <= v.expiresAt;
}

// ---- The send ----------------------------------------------------------------------------------------------------

const forbidden = (reason) => ({ status: 403, body: { error: 'forbidden', reason }, refusal: reason });
const badRequest = (reason) => ({ status: 400, body: { error: 'bad_request', reason }, refusal: reason });
const conflict = (reason) => ({ status: 409, body: { error: 'conflict', reason }, refusal: reason });
const seconds = (t) => Math.floor((typeof t === 'number' ? t : Date.parse(t)) / 1000);
// What a node says when the estimate fails because the sender cannot pay: geth-family, erigon and viem's own words.
// geth's 'gas required exceeds allowance (0)' is not here: it is also what a funded call that runs out of gas says,
// so only a balance read of exactly zero may turn it into payer_empty (D-15).
const INSUFFICIENT_ESTIMATE = /insufficient funds|exceeds transaction sender account balance|exceeds the balance of the account/i;
// payer_empty (contract rules.codes): the fee account cannot pay; nothing was sent, the same intent may resend (D-04).
const payerEmpty = () => ({ status: 502, body: { error: 'send_failed', reason: 'payer_empty', broadcast: false } });
const causeText = (e) => {
  const out = [];
  for (let c = e; c && out.length < 16; c = c.cause) out.push(`${c.shortMessage ?? ''} ${c.details ?? ''} ${c.message ?? ''}`);
  return out.join(' ');
};
const TRANSPORT_NAMES = new Set(['HttpRequestError', 'TimeoutError', 'SocketClosedError', 'WebSocketRequestError']);
// What a node or socket says when the call never got an answer (read along the whole cause chain).
const TRANSPORT_TEXT = /socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|HTTP request failed|took too long|timed out|timeout|network error/i;
const causeNames = (e) => {
  const out = [];
  for (let c = e; c && out.length < 16; c = c.cause) out.push(c.name);
  return out;
};
/**
 * Whether an estimate failed because the call itself fails (a revert, or running out of gas with no balance cap), as
 * the node reports it. A transport failure anywhere in the cause chain (16 links at most), or any other answer, is
 * not: the estimate could not be had, and the same intent may try again (D-15, for the first estimate
 * too).
 */
function callFailed(e) {
  const names = causeNames(e);
  // A typed transport failure outranks everything; a typed revert outranks words (a URL or a message may hold
  // 'timeout'); only an untyped error is read by its words.
  if (names.some((n) => TRANSPORT_NAMES.has(n))) return false;
  if (names.some((n) => n === 'ExecutionRevertedError' || n === 'ContractFunctionRevertedError')) return true;
  if (TRANSPORT_TEXT.test(causeText(e))) return false;
  return /revert|exceeds allowance|out of gas/i.test(causeText(e));
}
const feeEstimateFailed = () => ({ status: 502, body: { error: 'send_failed', reason: 'fee_estimate_failed', broadcast: false } });

/** The fee account's balance, or null when the node cannot say: an unreadable balance is not an empty one. */
async function readBalance(clients, config) {
  try {
    return await clients.publicClient.getBalance({ address: config.address });
  } catch {
    return null; // unreadable, not empty
  }
}

export const dedupeKeyOf = (siteUuid, groupUuid) => `safe-create:${siteUuid}:${groupUuid}`;

function answer(slot, state, status = 202, duplicate = false) {
  return {
    status,
    body: { intentUuid: slot.intentUuid, status: state.status, hash: state.hash, predictedAddress: slot.predictedAddress, chainId: slot.chainId, ...(duplicate ? { duplicate: true } : {}) },
  };
}

/**
 * POST /send/safe-create, after the body rules. In order: the operator's policy, the network, the relayer's own
 * initializer and CREATE2 address, then one synchronous transaction that answers an existing slot, checks the
 * envelope and the quotas, and claims the slot and an attempt. Only then the estimate, fees, cap and queue. Every exit
 * before the queue has the send gives the slot (not_sent) and the attempt back; once the queue has it, neither is
 * given back. Returns {status, body, refusal?}.
 */
export async function safeCreate({ value: v, config, networks, db, chains, cap, queue, policy, creationCode, now = Date.now, logger = console }) {
  // b. The operator's policy: on, the bound site (the policy file's, else the one POST /site stored), an enrolled Group when a list is set.
  if (!policy?.enabled) return forbidden('creation_disabled');
  if (v.siteUuid !== boundSite(policy, db)) return forbidden('site_mismatch');
  // An empty list means every group of the bound site; a list is an operator allow-list (D-06, D-21).
  if (policy.groups.length > 0 && !policy.groups.includes(v.groupUuid)) return forbidden('group_not_enrolled');

  // The stored slot first (D-03, D-16; BUILD-GUIDANCE §4 (b)): an address is never predicted again once a slot holds it,
  // so a repeat is answered from the slot whatever the factory, its code or networks.json say now. The transaction
  // below decides every race again.
  const digest = intentDigest(v);
  const stored = db.getCreation(v.siteUuid, v.groupUuid, v.chainId);
  if (stored && stored.digest !== digest) return conflict('slot_taken');
  const early = stored ? slotState(db, stored) : null;
  if (early && early.status !== 'not_sent') return answer(stored, early, 202, true);
  // A not_sent slot of the same intent is a retry: it sends the call stored at its claim. A row migrated from before
  // the call was stored has none, and takes the full path, whose prediction check refuses any other address.
  const retry = stored?.callTarget && stored?.callData ? stored : null;

  // c. The network: a chain marked for fund creation, Safe 1.4.1 only; before any estimate or reservation.
  const entry = networks?.[String(v.chainId)];
  // D-07 (TM-283): fund creation is only ever served on a network flagged as a testnet, whatever else the entry says.
  if (entry?.testnet !== true) return forbidden('network_not_supported');
  const deployment = deploymentOf(entry);
  if (entry?.fundCreation !== true || !chainIsConfigured(networks, v.chainId) || v.safeVersion !== SAFE_VERSION || !deployment) return forbidden('network_not_supported');
  if (!chainIsSponsored(networks, v.chainId)) return { status: 503, body: { ...NOT_SPONSORED }, refusal: 'chain_not_sponsored' };

  // d. The chain.
  const clients = chains.get(v.chainId);
  if (!clients?.walletClient) return { status: 503, body: { error: 'unavailable', reason: 'chain_not_available' } };

  let call;
  if (retry) {
    // D-03, D-16: the call that was validated and allow-listed at the first claim, to the address already stored.
    call = { to: retry.callTarget, data: retry.callData };
  } else {
    // The factory's own creation code: read once per chain, refused unless it is Safe 1.4.1's.
    const code = await creationCode(v.chainId, deployment, clients.publicClient);
    if (!code.ok && code.reason === 'mismatch') {
      logger.error(`safe-create ${v.chainId}: the factory ${deployment.factory} does not have Safe 1.4.1's proxy creation code; refused`);
      return forbidden('network_not_supported');
    }
    if (!code.ok) return { status: 503, body: { error: 'unavailable', reason: 'chain_not_available' } };

    // d. Then the relayer's own call: its initializer, its CREATE2 address, its calldata.
    const initializer = buildInitializer(deployment, v.owners, v.threshold);
    if (predictAddress(deployment, initializer, v.saltNonce, code.hash) !== v.predictedAddress) return badRequest('prediction_mismatch');
    const data = creationCalldata(deployment, initializer, v.saltNonce);
    const verdict = buildCreation(networks).check(v.chainId, deployment.factory, data.slice(0, 10));
    if (!verdict.ok || data.slice(0, 10) !== CREATION_SELECTORS.createProxyWithNonce) return forbidden('network_not_supported');
    call = { to: deployment.factory, data };
  }
  // The payer is never an owner (a retry's owners are the stored ones: the same digest names the same owners).
  if (config.address && v.owners.some((o) => o.toLowerCase() === config.address.toLowerCase())) return badRequest('payer_is_owner');

  // e-h. One synchronous transaction, no await inside: two requests can never both claim one slot, or both take the
  // site's last attempt.
  const dedupeKey = dedupeKeyOf(v.siteUuid, v.groupUuid);
  const nowS = Math.floor(now() / 1000);
  const step = db.atomically(() => {
    const slot = db.getCreation(v.siteUuid, v.groupUuid, v.chainId);
    if (slot) {
      if (slot.digest !== digest) return { kind: 'taken' };
      const state = slotState(db, slot);
      // An exact repeat gets the slot's answer, whatever the envelope, quotas or caps say (C13, C18).
      if (state.status !== 'not_sent') return { kind: 'duplicate', slot, state };
    }
    if (!envelopeLive(v, nowS)) return { kind: 'expired' };
    const limit = quotaVerdict(db, policy, v.siteUuid, v.chainId, v.actor.uuid, nowS);
    if (limit) return { kind: 'limit', limit };
    const attemptId = db.insertCreationAttempt({ siteUuid: v.siteUuid, groupUuid: v.groupUuid, chainId: v.chainId, actorUuid: v.actor.uuid }, nowS);
    const rowFloor = db.findLatestByDedupeKey(v.chainId, dedupeKey)?.id ?? 0;
    const claimed = {
      siteUuid: v.siteUuid, groupUuid: v.groupUuid, intentUuid: v.intentUuid, digest, chainId: v.chainId, safeVersion: v.safeVersion,
      owners: v.owners, threshold: v.threshold, saltNonce: v.saltNonce, predictedAddress: v.predictedAddress,
      callTarget: call.to, callData: call.data,
      actorUuid: v.actor.uuid, actorAddress: v.actor.address, status: 'sending', hash: null, dedupeKey, rowFloor, attemptId,
    };
    if (slot) db.updateCreation(claimed, nowS);
    else db.insertCreation(claimed, nowS);
    return { kind: 'claimed', slot: claimed };
  });
  if (step.kind === 'taken') return conflict('slot_taken');
  if (step.kind === 'duplicate') return answer(step.slot, step.state, 202, true);
  if (step.kind === 'expired') return badRequest('expired');
  if (step.kind === 'limit') return { status: 429, body: { error: 'setup_limit', scope: step.limit.scope, until: step.limit.until }, refusal: `setup_limit_${step.limit.scope}` };
  const slot = step.slot;

  // Nothing was broadcast for this claim: the slot is not_sent and its attempt counts no more.
  const giveBack = () => db.atomically(() => {
    db.updateCreation({ ...slot, status: 'not_sent', hash: null }, Math.floor(now() / 1000));
    db.returnCreationAttempt(slot.attemptId);
  });
  const settleTo = (hash, rowFloor = slot.rowFloor) => db.updateCreation({ ...slot, status: 'pending', hash, rowFloor }, Math.floor(now() / 1000));

  // i. Estimate (a revert is the simulation), fees, the cap, then the queue.
  let gas;
  try {
    gas = await clients.publicClient.estimateGas({ account: config.address, to: call.to, data: call.data, value: 0n });
  } catch (e) {
    giveBack();
    // The node says the fee account cannot pay, or says nothing useful while the account holds exactly nothing: wait.
    if (INSUFFICIENT_ESTIMATE.test(causeText(e))) {
      logger.warn(`safe-create ${v.chainId} ${v.groupUuid}: the fee account cannot pay (the estimate said so); nothing was sent`);
      return payerEmpty();
    }
    // The estimate could not be had (an outage, a timeout, an answer that is no revert): wait, never held.
    if (!callFailed(e)) {
      logger.warn(`safe-create ${v.chainId} ${v.groupUuid}: the estimate could not be read; nothing was sent`);
      return feeEstimateFailed();
    }
    const empty = await readBalance(clients, config);
    if (empty === 0n) {
      logger.warn(`safe-create ${v.chainId} ${v.groupUuid}: the fee account holds nothing, so the estimate failed; nothing was sent`);
      return payerEmpty();
    }
    // Dust (0 < balance < cost): a node caps the estimate at balance / gasPrice and fails it ('gas required exceeds
    // allowance (N)', or 'execution reverted' when the inner call runs out of gas). The create call does not depend on
    // the sender, so ask again without the fee account: if that answers and the dust cannot pay it, the account waits
    // (retryable); if it fails too, or the balance covers the cost, the failure is the call's own (D-04, D-15).
    if (empty !== null && empty > 0n) {
      let plain;
      try {
        plain = await clients.publicClient.estimateGas({ to: call.to, data: call.data, value: 0n });
      } catch (second) {
        // Only an execution failure the node reports (a revert, or running out of gas with no balance cap) is the
        // call's own. A timeout, an outage or any other answer says nothing about the call: the same intent may try
        // again, and is never held for good.
        if (!callFailed(second)) return feeEstimateFailed();
        plain = null; // a genuine failure of the call itself
      }
      if (plain !== null) {
        let dustFees;
        try {
          dustFees = await clients.publicClient.estimateFeesPerGas();
        } catch {
          return { status: 502, body: { error: 'send_failed', reason: 'fee_estimate_failed', broadcast: false } };
        }
        if (empty < ((plain * 12n) / 10n) * dustFees.maxFeePerGas) {
          logger.warn(`safe-create ${v.chainId} ${v.groupUuid}: the fee account holds too little, so the estimate failed; nothing was sent`);
          return payerEmpty();
        }
      }
    }
    logger.warn(`safe-create ${v.chainId} ${v.groupUuid}: simulation failed (${e?.shortMessage ?? e?.name ?? 'reverted'})`);
    return conflict('simulation_failed');
  }
  let fees;
  try {
    fees = await clients.publicClient.estimateFeesPerGas();
  } catch {
    giveBack();
    return { status: 502, body: { error: 'send_failed', reason: 'fee_estimate_failed', broadcast: false } };
  }
  const gasLimit = (gas * 12n) / 10n;
  const cost = gasLimit * fees.maxFeePerGas;
  // D-04: a fee account that cannot pay the send's cost waits, before anything is reserved or queued.
  const funds = await readBalance(clients, config);
  if (funds !== null && funds < cost) {
    giveBack();
    logger.warn(`safe-create ${v.chainId} ${v.groupUuid}: the fee account cannot pay (balance read before the reservation); nothing was sent`);
    return payerEmpty();
  }
  let reservation;
  try {
    reservation = cap.reserve(v.chainId, cost);
  } catch (e) {
    giveBack();
    if (e instanceof CapReached) {
      logger.warn(`cap reached (${e.limit}) ${v.chainId} safe-create ${v.groupUuid}`);
      return { status: 429, body: { error: 'cap_reached', limit: e.limit, until: seconds(e.until), monthStartsAt: seconds(e.monthStartsAt) } };
    }
    throw e;
  }
  const sendTx = () => ({ to: call.to, data: call.data, value: 0n, gas: gasLimit, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });

  let sent;
  try {
    sent = await queue.enqueue(v.chainId, sendTx, { reservation, safe: v.predictedAddress, kind: 'safe-create', dedupeKey });
  } catch (e) {
    // The queue rejects only when nothing was broadcast (its row is stored before the broadcast and deleted only on an
    // exact refusal). Decided by the row, as at start: a row of this claim means the send may be live.
    const row = db.findLatestByDedupeKey(v.chainId, dedupeKey);
    if (row && row.id > slot.rowFloor && row.status !== 'replaced') {
      settleTo(row.hash);
      logger.error(`safe-create ${v.chainId} ${v.groupUuid}: the queue rejected (${e?.name ?? 'Error'}) but holds the send ${row.hash}; kept`);
      return answer(slot, { status: 'pending', hash: row.hash });
    }
    cap.release(reservation);
    giveBack();
    // After queueing, a funds refusal is never the definite payer_empty (the service's rule):
    // nothing was sent and the same intent may resend; payer_empty is answered only before the queue.
    const reason = 'send failed';
    logger.warn(`send failed safe-create ${v.chainId} ${v.groupUuid}: ${e?.shortMessage ?? e?.name}`);
    return { status: 502, body: { error: 'send_failed', reason, broadcast: false } };
  }
  if (sent.duplicate) {
    // The queue already holds a live send for this slot (it should not: the slot said not_sent). Nothing was sent for
    // this request, so its reservation and attempt go back, and the slot follows the live send.
    cap.release(reservation);
    const live = db.findDuplicate(v.chainId, dedupeKey);
    db.atomically(() => {
      db.returnCreationAttempt(slot.attemptId);
      settleTo(sent.hash, live ? live.id - 1 : slot.rowFloor);
    });
    logger.warn(`safe-create ${v.chainId} ${v.groupUuid}: the queue already had ${sent.hash}`);
    return answer(slot, { status: 'pending', hash: sent.hash }, 202, true);
  }
  // The send is out: from here nothing gives back the reservation or the attempt.
  try {
    settleTo(sent.hash);
  } catch (e) {
    logger.error(`recording safe-create ${v.chainId} ${v.groupUuid} ${sent.hash} failed: ${e?.name ?? 'Error'}`);
  }
  logger.info(`sent safe-create ${v.chainId} ${v.groupUuid} ${v.predictedAddress} ${sent.hash}`);
  return answer(slot, { status: 'pending', hash: sent.hash });
}
