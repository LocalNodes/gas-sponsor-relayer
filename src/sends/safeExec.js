// POST /send/safe-exec: send an owner-signed Safe.execTransaction and pay its gas (RESEARCH Pattern 5).
// Every sponsored send follows one order: field rules, registration, allowlist, gas and fee estimate,
// cap.reserve, eth_call simulation, queue.enqueue. The real cost is recorded by the queue when the
// receipt arrives (cap.record), so nothing is broadcast before the cap has said yes.
import { decodeFunctionResult, encodeFunctionData, getAddress, isAddress, isHex, parseAbi, zeroAddress } from 'viem';
import { build, SELECTORS } from '../allowlist.js';
import { isRegistered } from '../registration.js';
import { CapReached } from '../cap.js';
import { chainIsSponsored, NOT_SPONSORED } from '../config.js';

const execAbi = parseAbi([
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) returns (bool success)',
]);

const safeAbi = parseAbi(['function nonce() view returns (uint256)']);

const MAX_DATA_HEX = 2 + 2 * 32768;
const MAX_SIG_HEX = 2 + 2 * 65 * 32;
const UINT256_MAX = (1n << 256n) - 1n;

function uint(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value)) {
    const n = BigInt(value);
    return n <= UINT256_MAX ? n : null;
  }
  return null;
}

/** Validate the wire body. Returns {ok, value} or {ok: false, error}. */
export function parseSafeExecBody(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be a JSON object' };
  const bad = (field, why) => ({ ok: false, error: `${field} ${why}` });
  if (!Number.isInteger(body.chainId) || body.chainId <= 0) return bad('chainId', 'must be a positive integer');
  for (const f of ['safe', 'to', 'gasToken', 'refundReceiver']) {
    if (typeof body[f] !== 'string' || !isAddress(body[f], { strict: false })) return bad(f, 'must be an address');
  }
  const nums = {};
  for (const f of ['value', 'safeTxGas', 'baseGas', 'gasPrice']) {
    const n = uint(body[f]);
    if (n === null) return bad(f, 'must be a uint256 as a decimal string');
    nums[f] = n;
  }
  if (body.operation !== 0 && body.operation !== 1) return bad('operation', 'must be 0 or 1');
  if (typeof body.data !== 'string' || !isHex(body.data) || body.data.length % 2 !== 0 || body.data.length > MAX_DATA_HEX) {
    return bad('data', 'must be even-length hex');
  }
  if (typeof body.signatures !== 'string' || !isHex(body.signatures) || body.signatures.length % 2 !== 0 || body.signatures.length < 132 || body.signatures.length > MAX_SIG_HEX) {
    return bad('signatures', 'must be hex, 65 bytes per owner');
  }
  return {
    ok: true,
    value: {
      chainId: body.chainId,
      safe: getAddress(body.safe),
      to: getAddress(body.to),
      value: nums.value,
      data: body.data,
      operation: body.operation,
      safeTxGas: nums.safeTxGas,
      baseGas: nums.baseGas,
      gasPrice: nums.gasPrice,
      gasToken: getAddress(body.gasToken),
      refundReceiver: getAddress(body.refundReceiver),
      signatures: body.signatures,
    },
  };
}

const refuse = (reason) => ({ status: 403, body: { error: 'forbidden', reason }, refusal: reason });

/**
 * Every send passes, in order: field rules, registration, the allowlist, an eth_call simulation.
 * Returns {status, body, refusal?}; the server turns a refusal into a log line.
 */
export async function safeExec({ value: tx, config, networks, db, chains, cap, queue, logger }) {
  // Sponsored transactions never refund the relayer or pay with a token: the relayer pays all gas.
  if (tx.gasPrice !== 0n || tx.gasToken !== zeroAddress || tx.refundReceiver !== zeroAddress) return refuse('refund_fields_must_be_zero');
  if (!isRegistered(db, tx.chainId, tx.safe)) return refuse('safe_not_registered');
  const allowlist = build(networks, db.listGroups());
  const verdict = allowlist.check(tx.chainId, tx.safe, SELECTORS.execTransaction, tx.operation, tx.to);
  if (!verdict.ok) return refuse(verdict.reason);

  const clients = chains.get(tx.chainId);
  if (!clients?.walletClient) return { status: 503, body: { error: 'unavailable', reason: 'chain_not_available' } };
  // Before the estimate and the reservation (25-28 round 3, #4): nothing is held or sent on a chain not sponsored.
  if (!chainIsSponsored(networks, tx.chainId)) return { status: 503, body: { ...NOT_SPONSORED } };
  // The Safe's nonce names the request (25-28 dedupe): an owner-signed transaction can execute once per Safe nonce, so a
  // retry of it carries the same nonce until the first mines. Read before the estimate; a failed read sends nothing.
  let safeNonce;
  try {
    safeNonce = await clients.publicClient.readContract({ address: tx.safe, abi: safeAbi, functionName: 'nonce' });
  } catch {
    return { status: 502, body: { error: 'send_failed', reason: 'safe_nonce_unreadable', broadcast: false } };
  }
  const dedupeKey = `safe-exec:${tx.chainId}:${tx.safe.toLowerCase()}:${safeNonce}`;
  const data = encodeFunctionData({
    abi: execAbi,
    functionName: 'execTransaction',
    args: [tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, tx.signatures],
  });

  // Gas and fees first: the cap reserves gas limit x maxFeePerGas, an upper bound of what the send can cost.
  let gas;
  try {
    gas = await clients.publicClient.estimateGas({ account: config.address, to: tx.safe, data });
  } catch (e) {
    return { status: 409, body: { error: 'conflict', reason: 'simulation_failed', detail: e.shortMessage ?? 'reverted' } };
  }
  let fees;
  try {
    fees = await clients.publicClient.estimateFeesPerGas();
  } catch {
    return { status: 502, body: { error: 'send_failed', reason: 'fee_estimate_failed', broadcast: false } };
  }
  const gasLimit = (gas * 12n) / 10n;

  let reservation;
  try {
    reservation = cap.reserve(tx.chainId, gasLimit * fees.maxFeePerGas);
  } catch (e) {
    if (e instanceof CapReached) {
      logger.warn(`cap reached (${e.limit}) ${tx.chainId} ${tx.safe}`);
      return { status: 429, body: { error: 'cap_reached', limit: e.limit, until: e.until, monthStartsAt: e.monthStartsAt } };
    }
    throw e;
  }

  try {
    const sim = await clients.publicClient.call({ account: config.address, to: tx.safe, data });
    const ok = sim?.data ? decodeFunctionResult({ abi: execAbi, functionName: 'execTransaction', data: sim.data }) : false;
    if (ok !== true) {
      cap.release(reservation);
      return { status: 409, body: { error: 'conflict', reason: 'simulation_failed' } };
    }
  } catch (e) {
    cap.release(reservation);
    return { status: 409, body: { error: 'conflict', reason: 'simulation_failed', detail: e.shortMessage ?? 'reverted' } };
  }

  // enqueue rejects only when nothing was broadcast (queue.js, 25-28 fix A), so only then is the reservation given
  // back. Once it resolves the send may be live: nothing after it may release the reservation.
  let sent;
  try {
    sent = await queue.enqueue(
      tx.chainId,
      () => ({ to: tx.safe, data, value: 0n, gas: gasLimit, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas }),
      { reservation, safe: tx.safe, kind: 'safe-exec', dedupeKey },
    );
  } catch (e) {
    cap.release(reservation);
    logger.warn(`send failed safe-exec ${tx.chainId} ${tx.safe}: ${e.shortMessage ?? e.name}`);
    return { status: 502, body: { error: 'send_failed', reason: e.shortMessage ?? 'send failed', broadcast: false } };
  }
  // Nothing was sent for this request: the reservation goes back and the existing send is answered (25-28 dedupe).
  if (sent.duplicate) {
    cap.release(reservation);
    logger.info(`duplicate safe-exec ${tx.chainId} ${tx.safe} ${sent.hash}`);
    return { status: 202, body: { hash: sent.hash, status: 'pending', duplicate: true } };
  }
  const { hash } = sent;
  // The send is out: a bookkeeping failure is logged and the caller still gets the hash (25-28 round 2, MEDIUM 5).
  try {
    db.recordSend({ chainId: tx.chainId, safe: tx.safe, kind: 'safe-exec', txHash: hash });
  } catch (e) {
    logger.error(`recording sent safe-exec ${tx.chainId} ${tx.safe} ${hash} failed: ${e?.name ?? 'Error'}`);
  }
  logger.info(`sent safe-exec ${tx.chainId} ${tx.safe} ${hash}`);
  return { status: 202, body: { hash, status: 'pending' } };
}
