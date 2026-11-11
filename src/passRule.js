// The pass rule (GOV-04), one function shared in meaning with PHP's PassRule and tested against the same vector file
// (test/fixtures/vectors/pass-rule.json):
//   passed <=> state == 'closed' and scores_state == 'final' and scores_total >= quorum and scores[0] > scores[1]
// scores[0] is For, scores[1] Against and scores[2] Abstain, which counts toward scores_total and so toward the quorum.
// Fewer than two scores never passes. The input uses the hub's field names; anything that is not a plain finite
// number cannot pass.
const isNumber = (n) => typeof n === 'number' && Number.isFinite(n);

/** Returns { passed, reason }. */
export function passed(proposal) {
  const p = proposal ?? {};
  if (p.state !== 'closed') return { passed: false, reason: 'not-closed' };
  if (p.scores_state !== 'final') return { passed: false, reason: 'scores-not-final' };
  if (!Array.isArray(p.scores) || p.scores.length < 2 || !p.scores.every(isNumber)) return { passed: false, reason: 'scores-missing' };
  if (!isNumber(p.scores_total) || !isNumber(p.quorum)) return { passed: false, reason: 'scores-missing' };
  if (p.scores_total < p.quorum) return { passed: false, reason: 'quorum-not-met' };
  if (!(p.scores[0] > p.scores[1])) return { passed: false, reason: 'for-not-above-against' };
  return { passed: true, reason: 'passed' };
}
