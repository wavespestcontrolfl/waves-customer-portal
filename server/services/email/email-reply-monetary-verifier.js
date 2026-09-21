const { recognizeEmailReplyPriceEvidence } = require('./email-reply-price-evidence');

// Inactive findings only. Absence of a violation never approves a reply.
function inspectEmailReplyMonetaryPricing({ text = '', commercialProposal = false } = {}) {
  const result = recognizeEmailReplyPriceEvidence(text);
  if (!result.ok) return { disposition: 'needs_review', violations: [result.reason] };
  const blocked = commercialProposal !== true && result.clauses.some((clause) => (
    clause.priceEvidence.some((evidence) => evidence.family === 'visit')
  ));
  return { disposition: 'needs_review', violations: blocked ? ['customer_copy_compliance'] : [] };
}

module.exports = { inspectEmailReplyMonetaryPricing };
