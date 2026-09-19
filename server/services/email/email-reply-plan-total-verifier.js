const { recognizeEmailReplyPriceEvidence } = require('./email-reply-price-evidence');

// Inactive findings only. Absence of a violation never approves a reply.
// A recognized period-family price (month/year unit joined to an amount)
// is a plan-total claim. Trusted legacyMonthlyPlan permits monthly dues
// only; yearly aggregates still produce the finding.
function inspectEmailReplyPlanTotal({ text = '', commercialProposal = false, legacyMonthlyPlan = false } = {}) {
  const result = recognizeEmailReplyPriceEvidence(text);
  if (!result.ok) return { disposition: 'needs_review', violations: [result.reason] };
  const blocked = commercialProposal !== true && result.clauses.some((clause) => (
    clause.priceEvidence.some((evidence) => evidence.family === 'period'
      && !(legacyMonthlyPlan === true && evidence.unit.period === 'month'))
  ));
  return { disposition: 'needs_review', violations: blocked ? ['customer_copy_compliance'] : [] };
}

module.exports = { inspectEmailReplyPlanTotal };
