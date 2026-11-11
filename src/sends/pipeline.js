// One sponsored send, in the order every send follows (25-05): allowlist, gas estimate (which runs the call
// as a simulation and fails on a revert), fee estimate, cap.reserve, queue.enqueue. The real cost replaces the
// reservation when the queue sees the receipt. sends/reality.js and reclaim.js both use it.
import { CapReached } from '../cap.js';
import { SELECTORS } from '../allowlist.js';
import { NOT_SPONSORED } from '../config.js';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const MINED_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Every hash the send with hash `sent.hash` has had (its fee bumps change the hash), from the row that holds that
 * hash; just `sent.hash` before the row can be read. Never the hashes of another row at the same nonce: a different
 * send there may have mined, and its receipt says nothing about this one (25-28 round 3, #5).
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
     * Returns { ok: true, hash, nonce } or { ok: false, status, body, refusal? }.
     */
    async send({ chainId, safe, to, selectorName, data, value = 0n, kind, list, reserve = {}, dedupeKey = null }) {
      const verdict = list.check(chainId, to, SELECTORS[selectorName]);
      if (!verdict.ok) return { ok: false, status: 403, body: { error: 'forbidden', reason: verdict.reason }, refusal: verdict.reason };
      const clients = chains.get(chainId);
      if (!clients?.walletClient) return { ok: false, status: 503, body: { error: 'unavailable', reason: 'chain_not_available' } };
      // Before the estimate and the reservation: nothing is held or sent on a chain the relayer does not sponsor.
      if (clients.sponsored === false) return { ok: false, status: 503, body: { ...NOT_SPONSORED } };
      const { publicClient } = clients;

      let gas;
      try {
        gas = await publicClient.estimateGas({ account: config.address, to, data, value });
      } catch (e) {
        return { ok: false, status: 409, body: { error: 'conflict', reason: 'simulation_failed', detail: e.shortMessage ?? 'reverted' } };
      }
      let fees;
      try {
        fees = await publicClient.estimateFeesPerGas();
      } catch {
        return { ok: false, status: 502, body: { error: 'send_failed', reason: 'fee_estimate_failed', broadcast: false } };
      }
      const gasLimit = (gas * 12n) / 10n;

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

      // enqueue rejects only when nothing was broadcast (queue.js, 25-28 fix A), so only then is the reservation given
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
        logger.warn(`send failed ${kind} ${chainId} ${safe}: ${e.shortMessage ?? e.name}`);
        return { ok: false, status: 502, body: { error: 'send_failed', reason: e.shortMessage ?? 'send failed', broadcast: false } };
      }
      // Nothing was sent for this request: its reservation is given back and the existing send is not recorded again.
      if (sent.duplicate) {
        cap.release(reservation);
        logger.info(`duplicate ${kind} ${chainId} ${safe} ${sent.hash}`);
        return { ok: true, hash: sent.hash, nonce: sent.nonce, duplicate: true };
      }
      // The send is out: bookkeeping that fails from here on is logged, never turned into a failure (25-28 round 2,
      // MEDIUM 5). The caller must get the hash, or it may send again.
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
