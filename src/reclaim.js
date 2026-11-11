// Bond reclaim (25-07, TM-82). A bond the relayer posted with submitAnswer counts as spend until it comes back.
// Every minute this loop works through the questions the relayer answered (the reality_questions table):
//
//   answered  the bond is paid. Once Reality says the question is final, the answer history is rebuilt from the
//             LogNewAnswer events and claimWinnings is sent. If no answer of the relayer's matches the final one,
//             the bond was lost to a challenger: nothing is sent and the cap keeps counting it.
//   claimed   the winnings sit in the relayer's Reality balance. withdraw is sent.
//   done      withdrawn and credited, lost, or nothing to take.
//
// The cap is credited only after the withdraw receipt says status 1. A step that fails is stored as an event and the
// question stays where it was, so the next tick tries it again. The credit is the smaller of the bond and what the
// withdraw moved, never more: a question that paid out more than its bond is a gain, not spend to give back.
import { encodeFunctionData, encodePacked, keccak256, parseAbi, parseAbiItem, zeroHash } from 'viem';
import { build } from './allowlist.js';
import { createPipeline } from './sends/pipeline.js';

export const RECLAIM_INTERVAL_MS = 60_000;

const realityAbi = parseAbi([
  'function isFinalized(bytes32 question_id) view returns (bool)',
  'function resultFor(bytes32 question_id) view returns (bytes32)',
  'function balanceOf(address) view returns (uint256)',
  'function claimWinnings(bytes32 question_id, bytes32[] history_hashes, address[] addrs, uint256[] bonds, bytes32[] answers)',
  'function withdraw()',
]);
const newAnswer = parseAbiItem('event LogNewAnswer(bytes32 answer, bytes32 indexed question_id, bytes32 history_hash, address indexed user, uint256 bond, uint256 ts, bool is_commitment)');

const lower = (s) => String(s).toLowerCase();

/** A step failed in a way worth storing: the question stays open and the next tick tries again. */
class StepError extends Error {
  constructor(step, reason) {
    super(`${step}:${reason}`);
    this.step = step;
  }
}

/**
 * The history Reality.eth wants for claimWinnings, from LogNewAnswer events oldest first: newest answer first,
 * each with the hash the history had before it, and an empty hash for the oldest. Each entry's hash is checked
 * against the one its event carries, so a history that starts too late (missing events) is caught before sending.
 */
export function claimHistory(entries) {
  let before = zeroHash;
  for (const e of entries) {
    if (e.isCommitment) throw new StepError('history', 'has_commitments');
    const expect = keccak256(encodePacked(['bytes32', 'bytes32', 'uint256', 'address', 'bool'], [before, e.answer, e.bond, e.user, false]));
    if (expect !== e.historyHash) throw new StepError('history', 'incomplete');
    before = e.historyHash;
  }
  const newestFirst = [...entries].reverse();
  return {
    historyHashes: newestFirst.map((e, i) => (i === newestFirst.length - 1 ? zeroHash : newestFirst[i + 1].historyHash)),
    addrs: newestFirst.map((e) => e.user),
    bonds: newestFirst.map((e) => e.bond),
    answers: newestFirst.map((e) => e.answer),
  };
}

export function createReclaim({ db, config, networks, chains, cap, queue, pipeline = null, logger = console, intervalMs = RECLAIM_INTERVAL_MS }) {
  const pipe = pipeline ?? createPipeline({ config, db, chains, cap, queue, logger });
  let timer = null;
  let ticking = false;

  const readReality = (clients, reality, functionName, args = []) => clients.publicClient.readContract({ address: reality, abi: realityAbi, functionName, args });

  /** Send one step and wait for its receipt; anything but status 1 is an error. */
  async function sendStep(q, list, reality, name, selectorName, data, kind) {
    const sent = await pipe.send({ chainId: q.chainId, safe: q.safe, to: reality, selectorName, data, kind, list });
    if (!sent.ok) throw new StepError(name, sent.body?.reason ?? sent.body?.error ?? 'send_failed');
    const receipt = await pipe.waitMined(q.chainId, sent);
    if (receipt.status !== 'success') throw new StepError(name, 'reverted');
    return sent.hash;
  }

  /** The answers given on the question, oldest first, from the events. */
  async function history(clients, reality, q) {
    const logs = await clients.publicClient.getLogs({ address: reality, event: newAnswer, args: { question_id: q.questionId }, fromBlock: q.fromBlock, toBlock: 'latest' });
    return logs
      .sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1))
      .map((l) => ({ answer: l.args.answer, historyHash: l.args.history_hash, user: l.args.user, bond: l.args.bond, isCommitment: l.args.is_commitment }));
  }

  /** Work one question as far as it will go. Returns a result, or null when it is not final yet. */
  async function reclaimOne(q) {
    const clients = chains.get(q.chainId);
    const reality = networks[String(q.chainId)]?.reality;
    if (!clients?.walletClient || !reality) return null;
    if (!(await readReality(clients, reality, 'isFinalized', [q.questionId]))) return null;

    const list = build(networks, db.listGroups());
    const result = { chainId: q.chainId, questionId: q.questionId, outcome: 'done' };
    let status = q.status;

    if (status === 'answered') {
      const entries = await history(clients, reality, q);
      const best = await readReality(clients, reality, 'resultFor', [q.questionId]);
      result.historyLength = entries.length;
      if (!entries.some((e) => lower(e.user) === lower(config.address) && e.answer === best)) {
        // A challenger's answer won. The bond is gone, and the cap keeps counting it.
        db.insertEvent({ kind: 'reality_bond_lost', chainId: q.chainId, detail: { questionId: q.questionId, bondWei: q.bondWei.toString(), proposalId: q.proposalId } });
        db.updateQuestion(q.chainId, q.questionId, { status: 'done' });
        return { ...result, outcome: 'lost' };
      }
      const h = claimHistory(entries);
      const data = encodeFunctionData({ abi: realityAbi, functionName: 'claimWinnings', args: [q.questionId, h.historyHashes, h.addrs, h.bonds, h.answers] });
      try {
        result.claimHash = await sendStep(q, list, reality, 'claim', 'claimWinnings', data, 'reality-claim');
      } catch (e) {
        // Anyone may call claimWinnings. If someone already did, the winnings are in the balance and the step is moot.
        const already = e instanceof StepError && e.message === 'claim:simulation_failed' && (await readReality(clients, reality, 'balanceOf', [config.address])) > 0n;
        if (!already) throw e;
      }
      db.updateQuestion(q.chainId, q.questionId, { status: 'claimed' });
      status = 'claimed';
    }

    if (status === 'claimed') {
      const balance = await readReality(clients, reality, 'balanceOf', [config.address]);
      if (balance === 0n) {
        db.insertEvent({ kind: 'reality_nothing_to_withdraw', chainId: q.chainId, detail: { questionId: q.questionId } });
        db.updateQuestion(q.chainId, q.questionId, { status: 'done' });
        return { ...result, outcome: 'done', creditedWei: 0n };
      }
      const data = encodeFunctionData({ abi: realityAbi, functionName: 'withdraw' });
      result.withdrawHash = await sendStep(q, list, reality, 'withdraw', 'withdraw', data, 'reality-withdraw');
      // Only now, with a mined withdraw, does the cap get its credit.
      // A bond with no spend entry left (its send was replaced and the reservation given back, 25-28 fix A) gets no
      // credit; the result says 0 and an audit line records what was withdrawn and why nothing was credited.
      const credit = balance < q.bondWei ? balance : q.bondWei;
      const creditId = cap.credit(q.bondRef, credit);
      if (creditId == null) {
        db.insertEvent({ kind: 'reality_credit_skipped', chainId: q.chainId, detail: { questionId: q.questionId, bondRef: q.bondRef, reason: 'no_bond_entry', withdrawnWei: balance.toString(), uncreditedWei: credit.toString() } });
      }
      db.updateQuestion(q.chainId, q.questionId, { status: 'done' });
      result.creditedWei = creditId == null ? 0n : credit;
    }
    return result;
  }

  return {
    /** One pass over every open question. Returns what happened to each question that was final. */
    async tick() {
      if (ticking) return [];
      ticking = true;
      const out = [];
      try {
        for (const q of db.listOpenQuestions()) {
          try {
            const r = await reclaimOne(q);
            if (r) out.push(r);
          } catch (e) {
            const reason = e instanceof StepError ? e.message : (e?.shortMessage ?? e?.name ?? 'error');
            db.insertEvent({ kind: 'reality_reclaim_error', chainId: q.chainId, detail: { questionId: q.questionId, error: reason } });
            db.updateQuestion(q.chainId, q.questionId, { status: db.getQuestion(q.chainId, q.questionId)?.status ?? q.status, error: reason });
            logger.warn(`reclaim ${q.chainId} ${q.questionId}: ${reason}`);
            out.push({ chainId: q.chainId, questionId: q.questionId, outcome: 'error', error: reason });
          }
        }
      } finally {
        ticking = false;
      }
      return out;
    },

    start() {
      if (timer) return;
      timer = setInterval(() => {
        this.tick().catch((e) => logger.error(`reclaim tick failed: ${e?.name ?? 'Error'}`));
      }, intervalMs);
      timer.unref();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
