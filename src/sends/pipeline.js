// One sponsored send, in the order every send follows: allowlist, gas estimate (which runs the call
// as a simulation and fails on a revert), fee estimate, cap.reserve, queue.enqueue. The real cost replaces the
// reservation when the queue sees the receipt. sends/reality.js and reclaim.js both use it.
import { CapReached } from '../cap.js';
import { SELECTORS } from '../allowlist.js';
import { NOT_SPONSORED } from '../config.js';
import { afterFailedEstimate, costOf, readBalance, simulate } from '../feeAccount.js';
import { fundsRefusal } from '../queue.js';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Every fee_estimate_failed answer is this one body: the fee service could not check, so the caller may retry.
const feeEstimateFailed = () => ({ ok: false, status: 502, body: { error: 'send_failed', reason: 'fee_estimate_failed', broadcast: false } });
// The fee account cannot pay this send now (D-39): exactly three keys, no balance figure.
const payerEmpty = () => ({ ok: false, status: 502, body: { error: 'send_failed', reason: 'payer_empty', broadcast: false } });
export const MINED_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Every hash the send with hash `sent.hash` has had (its fee bumps change the hash), from the row that holds that
 * hash; just `sent.hash` before the row can be read. Never the hashes of another row at the same nonce: a different
 * send there may have mined, and its receipt says nothing about this one.
 */
export function ownHashes(db, sent) {
  return db.findPendingByHash(sent.hash)?.hashes ?? [sent.hash];
}

export function createPipeline({ config, db, chains, cap, queue, logger = console, sleep = defaultSleep, pollMs = 1000, timeoutMs = MINED_TIMEOUT_MS }) {
  return {
    /**
     * Send `data` to `to` (with `value` wei) from the relayer.
     * `list` is an allowlist from allowlist.build; `selectorName` names the function in SELECTORS.
     * `reserve` ({kind, ref}) records the reservation as a bond when the value is one.
     * `dedupeKey` names the request: when a send with it is pending, stuck, confirming or mined, nothing is sent and the
     * answer is { ok: true, hash, nonce, duplicate: true } with that send's hash.
     * `feeVerdict` (D-39; only the voted path's execute passes it): say definitely when the fee account cannot
     * pay (502 payer_empty), by D-37 points 1 to 3, and tell a check that could not be made from a failed call. Off,
     * every step runs as before.
     * Returns { ok: true, hash, nonce } or { ok: false, status, body, refusal? }.
     */
    async send({ chainId, safe, to, selectorName, data, value = 0n, kind, list, reserve = {}, dedupeKey = null, feeVerdict = false }) {
      const verdict = list.check(chainId, to, SELECTORS[selectorName]);
      if (!verdict.ok) return { ok: false, status: 403, body: { error: 'forbidden', reason: verdict.reason }, refusal: verdict.reason };
      const clients = chains.get(chainId);
      if (!clients?.walletClient) return { ok: false, status: 503, body: { error: 'unavailable', reason: 'chain_not_available' } };
      // Before the estimate and the reservation: nothing is held or sent on a chain the relayer does not sponsor.
      if (clients.sponsored === false) return { ok: false, status: 503, body: { ...NOT_SPONSORED } };
      const { publicClient } = clients;
      // A request already in the queue is answered as the queue would, never told payer_empty. Read synchronously
      // just before each payer_empty answer, with no await between the read and the return (D-35 (c)).
      const live = () => {
        const row = db.findDuplicate(chainId, dedupeKey);
        if (row) return { ok: true, hash: row.hash, nonce: row.nonce, duplicate: true };
        logger.warn(`send refused ${kind} ${chainId} ${safe}: the fee account cannot pay`);
        return payerEmpty();
      };

      let gas;
      try {
        gas = await publicClient.estimateGas({ account: config.address, to, data, value });
      } catch (e) {
        if (feeVerdict) {
          const after = await afterFailedEstimate({ publicClient, address: config.address, to, data, error: e, decode: null, value });
          if (after.answer === 'cannot_pay') return live();
          if (after.answer === 'could_not_check') return feeEstimateFailed();
        }
        return { ok: false, status: 409, body: { error: 'conflict', reason: 'simulation_failed', detail: e.shortMessage ?? 'reverted' } };
      }
      let fees;
      try {
        fees = await publicClient.estimateFeesPerGas();
      } catch {
        return feeEstimateFailed();
      }
      const gasLimit = (gas * 12n) / 10n;
      // D-37 point 1: a readable balance below the cost, before anything is reserved. An unreadable balance goes on;
      // the broadcast refusal below is its backstop.
      if (feeVerdict) {
        const balance = await readBalance(publicClient, config.address);
        if (balance !== null && balance < costOf(gas, fees) + value) {
          const sim = await simulate(publicClient, config.address, to, data, null, value);
          if (sim === 'fails') return { ok: false, status: 409, body: { error: 'conflict', reason: 'simulation_failed' } };
          if (sim === 'unknown') return feeEstimateFailed();
          return live();
        }
      }

      let reservation;
      try {
        reservation = cap.reserve(chainId, gasLimit * fees.maxFeePerGas + value, reserve);
      } catch (e) {
        if (e instanceof CapReached) {
          logger.warn(`cap reached (${e.limit}) ${chainId} ${safe}`);
          return { ok: false, status: 429, body: { error: 'cap_reached', limit: e.limit, until: e.until, monthStartsAt: e.monthStartsAt } };
        }
        throw e;
      }

      // enqueue rejects only when nothing was broadcast (queue.js), so only then is the reservation given
      // back. Once it resolves the send may be live: nothing after it may release the reservation.
      let sent;
      try {
        sent = await queue.enqueue(
          chainId,
          () => ({ to, data, value, gas: gasLimit, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas }),
          { reservation, safe, kind, dedupeKey },
        );
      } catch (e) {
        cap.release(reservation);
        // After queueing, a refusal for lack of funds is never the definite answer (the service's rule). A send
        // with this key that came to life during the broadcast is answered as already pending; otherwise the node's
        // own reason below, retryable.
        if (feeVerdict && fundsRefusal(e)) {
          const row = db.findDuplicate(chainId, dedupeKey);
          if (row) return { ok: true, hash: row.hash, nonce: row.nonce, duplicate: true };
        }
        logger.warn(`send failed ${kind} ${chainId} ${safe}: ${e.shortMessage ?? e.name}`);
        return { ok: false, status: 502, body: { error: 'send_failed', reason: e.shortMessage ?? 'send failed', broadcast: false } };
      }
      // Nothing was sent for this request: its reservation is given back and the existing send is not recorded again.
      if (sent.duplicate) {
        cap.release(reservation);
        logger.info(`duplicate ${kind} ${chainId} ${safe} ${sent.hash}`);
        return { ok: true, hash: sent.hash, nonce: sent.nonce, duplicate: true };
      }
      // The send is out: bookkeeping that fails from here on is logged, never turned into a failure.
      // The caller must get the hash, or it may send again.
      try {
        db.recordSend({ chainId, safe, kind, txHash: sent.hash });
      } catch (e) {
        logger.error(`recording sent ${kind} ${chainId} ${safe} ${sent.hash} failed: ${e?.name ?? 'Error'}`);
      }
      logger.info(`sent ${kind} ${chainId} ${safe} ${sent.hash}`);
      return { ok: true, hash: sent.hash, nonce: sent.nonce, reservation };
    },

    /** The first receipt among the send's own hashes (a fee bump changes the hash); never another send's. */
    async waitMined(chainId, sent) {
      const { publicClient } = chains.get(chainId);
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        for (const hash of [...ownHashes(db, sent)].reverse()) {
          try {
            const receipt = await publicClient.getTransactionReceipt({ hash });
            if (receipt) return receipt;
          } catch {
            // not mined under this hash yet
          }
        }
        if (Date.now() > deadline) throw new Error('timeout');
        await sleep(pollMs);
      }
    },
  };
}
