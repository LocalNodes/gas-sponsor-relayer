// D-35, D-37: whether the community's fee account can pay a send, decided by type and code only.
// A send is told "the fee account cannot pay" (payer_empty) only when a read-only simulation from the fee account
// shows the send itself would succeed and a readable balance is below its cost. A send that would fail is a 409
// (affirmative evidence only: a typed revert, or a result that does not decode to success), and a check that could
// not be made is a retryable 502. No function here classifies an error by its message, short message, details or
// reason text (simulate only passes a revert's short message on as the route's shown detail), and no balance figure
// leaves this file.

// viem's errors for a request whose answer never arrived or could not be read.
const TRANSPORT_NAMES = new Set(['HttpRequestError', 'TimeoutError', 'SocketClosedError', 'WebSocketRequestError']);
// A socket that failed under the request.
const SOCKET_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ECONNABORTED']);
// JSON-RPC: limit exceeded (-32005) and resource unavailable (-32002): the node did not answer the question.
const TRANSPORT_CODES = new Set([-32005, -32002]);
// The names viem gives a call that reverted.
const REVERT_NAMES = new Set(['ExecutionRevertedError', 'ContractFunctionRevertedError']);
// JSON-RPC code 3: execution reverted.
const REVERT_CODE = 3;

const links = (e) => {
  const out = [];
  for (let c = e; c && out.length < 16; c = c.cause) out.push(c);
  return out;
};

/** The cost the cap reserves for a send: the estimate with a 12/10 margin, at the highest fee per gas. */
export const costOf = (gas, fees) => ((gas * 12n) / 10n) * fees.maxFeePerGas;

/** The fee account's balance, or null when the node cannot say: an unreadable balance is not an empty one. */
export async function readBalance(publicClient, address) {
  try {
    return await publicClient.getBalance({ address });
  } catch {
    return null;
  }
}

/** True when any link of the cause chain (16 at most) is a transport failure: the question was never answered. */
export function isTransport(e) {
  return links(e).some((x) => TRANSPORT_NAMES.has(x?.name) || SOCKET_CODES.has(x?.code) || TRANSPORT_CODES.has(x?.code));
}

/** True when the call itself reverted, as a typed error says, with no transport failure anywhere in the chain. */
export function isRevert(e) {
  if (isTransport(e)) return false;
  return links(e).some((x) => REVERT_NAMES.has(x?.name) || x?.code === REVERT_CODE);
}

/**
 * The send, simulated read-only from the fee account with no fee fields. 'succeeds', 'fails' (a typed revert, or
 * `decode` not giving true) or 'unknown' (the simulation could not be had). `decode` is required: a function that
 * reads the returned data (true means success), or null, for a call whose return without a revert is its success.
 * `seen`, when given, gets the revert's `detail` for a caller that shows it, as the route did before (never read here).
 */
export async function simulate(publicClient, from, to, data, decode, value = 0n, seen = null) {
  let sim;
  try {
    sim = await publicClient.call({ account: from, to, data, value });
  } catch (e) {
    if (!isRevert(e)) return 'unknown';
    if (seen) seen.detail = e.shortMessage ?? 'reverted';
    return 'fails';
  }
  if (decode === null) return 'succeeds';
  try {
    return (sim?.data ? decode(sim.data) : false) === true ? 'succeeds' : 'fails';
  } catch {
    return 'fails';
  }
}

/**
 * After the estimate made as the fee account failed (D-37 point 2). Returns {answer}: 'could_not_check',
 * 'cannot_pay' (only after the simulation says the send succeeds) or 'simulation_failed'.
 */
export async function afterFailedEstimate({ publicClient, address, to, data, error, decode, value = 0n }) {
  if (isTransport(error)) return { answer: 'could_not_check' };
  let plain;
  try {
    plain = await publicClient.estimateGas({ to, data, value });
  } catch (e) {
    return { answer: isRevert(e) ? 'simulation_failed' : 'could_not_check' };
  }
  let fees;
  try {
    fees = await publicClient.estimateFeesPerGas();
  } catch {
    return { answer: 'could_not_check' };
  }
  const balance = await readBalance(publicClient, address);
  if (balance === null) return { answer: 'could_not_check' };
  if (balance < costOf(plain, fees) + value) {
    const sim = await simulate(publicClient, address, to, data, decode, value);
    if (sim === 'succeeds') return { answer: 'cannot_pay' };
    return { answer: sim === 'fails' ? 'simulation_failed' : 'could_not_check' };
  }
  // The balance covers the call: only a typed revert of the first estimate says the call fails.
  return { answer: isRevert(error) ? 'simulation_failed' : 'could_not_check' };
}
