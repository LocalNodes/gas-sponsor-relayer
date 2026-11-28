// The relayer's own answer to a Reality question, decided from its own reads of the hub (D-09, D-16, TM-79, TM-80).
//
// Drupal never says what the answer is. For a proposal the relayer reads the hub itself (asking the sequencer to
// finalize the scores first, because nothing else does), binds the proposal to the Safe's registered space, applies
// the pass rule, builds the module's transaction hashes from the proposal's safeSnap plugin for this module and
// compares their hash with the question's. Only decide() and decideFromVerdict() choose an answer, and the
// answer endpoint and the watcher post exactly what they return; the execute endpoint sends only on yes:
//   invalid  the question was asked before the vote ended (its Reality `created` time is before the hub's `end`),
//            whatever the vote did afterwards: the module's question says such a question is always invalid.
//            Also a question that is not, as a whole, the question the module builds from a proposal of this
//            Safe's space and this module's transactions: a proposal the hub does not know, another space, no
//            transactions for this module, or any other text (another hash, a separator inside the id).
//   yes      the proposal passed and the question is the one the module builds from it
//   no       a question that is the module's question for a proposal that did not pass
// No answer (answer null, with a reason) when either time cannot be read, or when the question was asked after the
// vote ended but its count is not final yet. Nothing is posted on a guess.
import { getAddress, isAddress, isHex, pad } from 'viem';
import { passed } from './passRule.js';
import { moduleTransactionHash, packedTxHashes, buildQuestion, questionHashOf } from './realityHash.js';

export const ANSWER_BYTES = Object.freeze({
  yes: pad('0x01', { size: 32 }),
  no: pad('0x00', { size: 32 }),
  // Reality.eth INVALID is the all-ones value.
  invalid: `0x${'ff'.repeat(32)}`,
});

const MAX_TRANSACTIONS = 64;
const BASIC_CHOICES = 3;
const UINT256_MAX = (1n << 256n) - 1n;
const lower = (s) => String(s).toLowerCase();

function uintOf(v) {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v)) {
    const n = BigInt(v);
    return n <= UINT256_MAX ? n : null;
  }
  return null;
}

/**
 * The module transactions in a proposal's safeSnap plugin, in the proposal's order, for one module on one chain.
 * Accepts the sx-monorepo shape: plugins.safeSnap.safes[] = { network, realityAddress, txs: [[tx, ...], ...] }.
 * Returns { ok: true, txs: [{to, value, data, operation}] } or { ok: false, reason }.
 */
export function moduleTransactions(plugins, { chainId, module }) {
  const safes = plugins?.safeSnap?.safes;
  if (!Array.isArray(safes) || safes.length === 0) return { ok: false, reason: 'no_transactions' };
  const mine = safes.filter((s) => String(s?.network) === String(chainId) && typeof s?.realityAddress === 'string' && lower(s.realityAddress) === lower(module));
  if (mine.length === 0) return { ok: false, reason: 'plugin_other_module' };
  if (mine.length > 1) return { ok: false, reason: 'bad_plugin' };
  const rows = Array.isArray(mine[0].txs) ? mine[0].txs.flatMap((t) => (Array.isArray(t) ? t : [t])) : [];
  if (rows.length === 0) return { ok: false, reason: 'no_transactions' };
  if (rows.length > MAX_TRANSACTIONS) return { ok: false, reason: 'bad_plugin' };
  const txs = [];
  for (const r of rows) {
    const value = uintOf(r?.value ?? '0');
    const data = r?.data ?? '0x';
    const operation = Number(r?.operation ?? 0);
    if (typeof r?.to !== 'string' || !isAddress(r.to, { strict: false }) || value === null) return { ok: false, reason: 'bad_plugin' };
    if (typeof data !== 'string' || !isHex(data) || data.length % 2 !== 0) return { ok: false, reason: 'bad_plugin' };
    if (operation !== 0 && operation !== 1) return { ok: false, reason: 'bad_plugin' };
    txs.push({ to: getAddress(r.to), value, data, operation });
  }
  return { ok: true, txs };
}

/**
 * The relayer's reads for one proposal and one Safe, as a verdict.
 * kind is one of: unknown_group, unknown_proposal, wrong_space, not_final, not_passed, no_transactions,
 * plugin_other_module, bad_plugin, ok. `txHashes` and `packedHash` are present whenever the plugin read fine
 * (also when the proposal is not final: the question may have been asked early and still has to be found).
 */
export function createAnswerer({ hub, db, logger = console }) {
  /** The proposal, with the sequencer asked to finalize the scores when it is closed and still pending. */
  async function load(chainId, proposalId) {
    let p = await hub.getProposal(chainId, proposalId);
    if (p && p.state === 'closed' && p.scoresState !== 'final') {
      try {
        await hub.finalizeScores(chainId, proposalId);
      } catch (e) {
        logger.warn(`sequencer scores call failed for ${proposalId}: ${e?.code ?? e?.name}`);
      }
      p = await hub.getProposal(chainId, proposalId);
    }
    return p;
  }

  async function evaluate({ chainId, safe, module, proposalId }) {
    const group = db.getGroup(chainId, safe);
    if (!group) return { kind: 'unknown_group' };
    const proposal = await load(chainId, proposalId);
    if (!proposal) return { kind: 'unknown_proposal' };
    if (lower(proposal.spaceId) !== lower(group.space)) return { kind: 'wrong_space', proposal };

    const plug = moduleTransactions(proposal.plugins, { chainId, module });
    const out = { proposal };
    if (!plug.ok) out.pluginReason = plug.reason;
    if (plug.ok) {
      out.txs = plug.txs;
      out.txHashes = plug.txs.map((tx, i) => moduleTransactionHash(chainId, module, tx, i));
      out.packedHash = packedTxHashes(out.txHashes);
      out.question = buildQuestion(proposalId, out.txHashes);
    }
    if (proposal.state !== 'closed' || proposal.scoresState !== 'final') return { ...out, kind: 'not_final' };
    const rule = passed({ state: proposal.state, scores_state: proposal.scoresState, scores: proposal.scores, scores_total: proposal.scoresTotal, quorum: proposal.quorum });
    if (!rule.passed) return { ...out, kind: 'not_passed', reason: rule.reason };
    // Every proposal Drupal creates is a basic vote with three choices (For, Against, Abstain), so a shorter scores array
    // is not ours. The shared rule would accept two scores; the relayer, which spends money on the answer, does not.
    if (proposal.scores.length < BASIC_CHOICES) return { ...out, kind: 'not_passed', reason: 'scores_shape' };
    if (!plug.ok) return { ...out, kind: plug.reason };
    return { ...out, kind: 'ok' };
  }

  /**
   * The answer for a verdict, the question's key (keccak256 of the question's whole text, the module's questionIds
   * key) and the time the question was asked (Reality's `created`, seconds, a bigint; null when it could not be read).
   */
  function decideFromVerdict(verdict, questionKey, askedAt) {
    const end = verdict.proposal?.end;
    const endKnown = Number.isSafeInteger(end) && end > 0;
    const askedKnown = typeof askedAt === 'bigint' && askedAt > 0n;
    // A proposal the hub knows has a vote end: a question asked before it is invalid, whatever came after.
    if (endKnown && askedKnown && askedAt < BigInt(end)) return { answer: 'invalid', reason: 'asked_before_resolution' };
    // The question is compared whole with the one the module builds from the hub's proposal.
    if (!isQuestionOf(verdict, questionKey)) {
      const reason = ['unknown_group', 'unknown_proposal', 'wrong_space'].includes(verdict.kind) ? verdict.kind
        : verdict.question ? 'question_mismatch' : verdict.pluginReason ?? verdict.kind;
      return { answer: 'invalid', reason };
    }
    if (verdict.proposal) {
      if (!endKnown) return { answer: null, reason: 'resolution_time_unknown' };
      if (!askedKnown) return { answer: null, reason: 'question_time_unknown' };
    }
    switch (verdict.kind) {
      case 'not_final':
        return { answer: null, reason: 'not_final' };
      case 'ok':
        return { answer: 'yes', reason: 'passed' };
      default:
        return { answer: 'no', reason: verdict.kind === 'not_passed' ? verdict.reason : verdict.kind };
    }
  }

  /** Is the question with this key, as a whole, the one the module builds from the verdict's proposal? */
  const isQuestionOf = (verdict, questionKey) => typeof verdict.question === 'string' && typeof questionKey === 'string' && lower(questionKey) === questionHashOf(verdict.question);

  return {
    load,
    evaluate,
    decideFromVerdict,
    isQuestionOf,
    /** decide(): read the hub and answer yes, no or invalid (or null: not now) for the question with this key and time. */
    async decide({ chainId, safe, module, proposalId, questionKey, askedAt }) {
      return decideFromVerdict(await evaluate({ chainId, safe, module, proposalId }), questionKey, askedAt);
    },
  };
}
