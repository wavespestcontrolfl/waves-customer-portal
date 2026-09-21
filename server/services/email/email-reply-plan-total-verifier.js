const { recognizeEmailReplyPeriodRelations } = require('./email-reply-period-relations');

// Inactive findings only. Absence of a violation never approves a reply.
// A recognized plan-total period relation (month/year price joined to an
// amount) is a plan-total claim. Trusted legacyMonthlyPlan permits monthly
// dues only; yearly aggregates still produce the finding.
function inspectEmailReplyPlanTotal({ text = '', commercialProposal = false, legacyMonthlyPlan = false } = {}) {
  const result = recognizeEmailReplyPeriodRelations(text);
  if (!result.ok) return { disposition: 'needs_review', violations: [result.reason] };
  const blocked = commercialProposal !== true && result.clauses.some((clause) => (
    clause.periodRelations.some((relation) => relation.relation === 'plan_total'
      && !(legacyMonthlyPlan === true && relation.period.period === 'month'))
  ));
  return { disposition: 'needs_review', violations: blocked ? ['customer_copy_compliance'] : [] };
}

module.exports = { inspectEmailReplyPlanTotal };
