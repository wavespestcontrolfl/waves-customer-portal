const { normalizeEmailReplyCopy } = require('./email-reply-copy-normalizer');

const VISIT_SRC = '(?:(?!applications?\\b)(?:[a-z]+(?:-[a-z]+)*|\\d+(?:\\.\\d+)?-(?:minute|hour|day|week|month|year)s?)\\s+)*visits?\\b';
const VISIT_UNIT_SRC = `(?:each|every|a|an|one|the|your|our|my|their|his|her|its|this|that|any)\\s+${VISIT_SRC}`;
const PRICE_UNIT_SRC = `(?:(?:(?:for|on)\\s+)?${VISIT_UNIT_SRC}|per[\\s-]+${VISIT_SRC}|/\\s*${VISIT_SRC})`;
const BILLING_TERM_SRC = '(?:prices?|amounts?|costs?|charges?|fees?|(?:the|a|our|your|its)\\s+rates?|rates?(?=\\s+(?:is|are|was|were|will\\s+be|per)\\b)|invoices?|invoiced|invoicing|billing|billed|bills?|charging|charged|charges?|pricing|priced|payments?|pay|paid)';

const AMOUNTLESS_BILLING_RE = new RegExp([
  `\\b${BILLING_TERM_SRC}(?:\\s+(?:is|are|was|were|will\\s+be))?\\s+${PRICE_UNIT_SRC}`,
  `\\b${VISIT_UNIT_SRC}\\s+(?:is|are|was|were|will\\s+be)\\s+(?:billed|charged|invoiced)\\s+(?:separately|individually|on\\s+(?:its|their)\\s+own)\\b`,
].join('|'), 'i');

// Inactive wording policy only. A future caller must establish commercial
// proposal context from trusted data; this does not verify monetary facts.
function verifyEmailReplyBilling({ text = '', commercialProposal = false } = {}) {
  const normalized = normalizeEmailReplyCopy(text);
  if (!normalized.ok) return { ok: false, violations: [normalized.reason] };

  const blocked = commercialProposal !== true && AMOUNTLESS_BILLING_RE.test(normalized.text);
  return { ok: !blocked, violations: blocked ? ['customer_copy_compliance'] : [] };
}

module.exports = { verifyEmailReplyBilling };
