const { normalizeEmailReplyCopy } = require('./email-reply-copy-normalizer');

const VISIT_MODIFIER_STOP_SRC = '(?:a|access|account|accounts|after|an|and|any|are|at|balance|balances|be|been|before|being|but|by|can|could|cover|covered|covering|covers|did|do|does|during|each|every|for|from|had|has|have|her|his|if|include|included|includes|including|in|into|is|its|may|might|must|my|of|on|one|or|our|payment|payments|per|should|since|than|that|the|their|then|these|this|those|through|to|until|was|were|when|where|while|will|with|without|would|your)';
const VISIT_MODIFIER_SRC = `(?!(?:applications?|${VISIT_MODIFIER_STOP_SRC})(?=\\s|$))(?:[a-z]+(?:-[a-z]+)*|\\d+(?:\\.\\d+)?(?:-(?:minute|hour|day|week|month|year)s?|\\s+(?:minutes?|hours?|days?|weeks?|months?|years?)))`;
const VISIT_SRC = `(?:${VISIT_MODIFIER_SRC}\\s+){0,8}visits?\\b`;
const BARE_VISITS_SRC = `(?:${VISIT_MODIFIER_SRC}\\s+){0,8}visits\\b`;
const VISIT_UNIT_SRC = `(?:each|every|a|an|one|the|your|our|my|their|his|her|its|this|that|any)\\s+${VISIT_SRC}`;
const RECURRING_VISIT_UNIT_SRC = `(?:(?:each|every|any)\\s+${VISIT_SRC}|(?:(?:the|your|our|my|their|his|her|its|these|those)\\s+)?${BARE_VISITS_SRC})`;
const PRICE_UNIT_SRC = `(?:(?:for|on)\\s+${RECURRING_VISIT_UNIT_SRC}|${VISIT_UNIT_SRC}|per[\\s-]+${VISIT_SRC}|/\\s*${VISIT_SRC})`;
const VISIT_SUBJECT_SRC = `(?:${VISIT_UNIT_SRC}|${BARE_VISITS_SRC})`;
const BILLING_TERM_SRC = '(?:prices?|amounts?|costs?|charges?|fees?|(?:the|a|our|your|its)\\s+rates?|rates?(?=(?:\\s+(?:is|are|was|were|will\\s+be|per)\\b|\\s*[:,-]))|invoices?|invoiced|invoicing|billing|billed|bills?|charging|charged|charges?|pricing|priced|payments?|pay|paid)';
const BILLING_UNIT_CONNECTOR_SRC = '(?:occurs?|occurred|occurring|appl(?:y|ies|ied|ying)|frequency\\s+(?:is|are|was|were|will\\s+be))';
const BILLING_UNIT_SEPARATOR_SRC = `(?:\\s+(?:is|are|was|were|will\\s+be)(?:\\s+|\\s*[:,-]\\s*)|\\s+${BILLING_UNIT_CONNECTOR_SRC}\\s+|\\s+|\\s*[:,-]\\s*)`;
const BILLING_NEGATION_SRC = '(?:(?:not|never)\\s+)?';
const ACTIVE_BILLING_VERB_SRC = '(?:bills?|billed|billing|charges?|charged|charging|invoices?|invoiced|invoicing|pays?|paid|paying)';
const SEPARATE_BILLING_PREDICATE_SRC = `(?:(?:billed|charged|invoiced|paid)\\s+(?:separately|individually|on\\s+(?:its|their)\\s+own)|(?:separately|individually)\\s+(?:billed|charged|invoiced|paid))`;
const NOMINAL_BILLING_PREDICATE_SRC = '(?:(?:has|have|had)\\s+(?:a|an)\\s+(?:separate|individual)\\s+(?:charge|fee|invoice)|(?:incurs?|incurred|incurring)\\s+(?:a|an)\\s+(?:(?:separate|individual)\\s+)?(?:charge|fee|invoice)|(?:generates?|generated|generating)\\s+(?:(?:its|their)\\s+own|(?:a|an)\\s+(?:separate|individual))\\s+(?:charge|fee|invoice))';

const AMOUNTLESS_BILLING_RE = new RegExp([
  `\\b${BILLING_TERM_SRC}${BILLING_UNIT_SEPARATOR_SRC}${BILLING_NEGATION_SRC}${PRICE_UNIT_SRC}`,
  `\\b${VISIT_SUBJECT_SRC}\\s+(?:is|are|was|were|will\\s+be|gets?|got|(?:has|have|had)\\s+been)\\s+${SEPARATE_BILLING_PREDICATE_SRC}\\b`,
  `\\b(?:(?:${ACTIVE_BILLING_VERB_SRC})\\s+(?:separately|individually)|(?:separately|individually)\\s+(?:${ACTIVE_BILLING_VERB_SRC}))\\s+(?:for|on)\\s+${RECURRING_VISIT_UNIT_SRC}`,
  `\\b${VISIT_SUBJECT_SRC}\\s+${NOMINAL_BILLING_PREDICATE_SRC}\\b`,
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
