const { findBannedCustomerCopy } = require('../service-report/activity-indicators');
const { reentrySafetyClaimFinding } = require('../content/content-guardrails');
const { RETIRED_NAME_RE, NONCANONICAL_SUFFIX_RE } = require('../customer-company-name');

// Normalize typography before matching the customer-visible copy. This
// includes nonbreaking hyphens in both visit units and compliance claims.
function normalizeCopy(text) {
  return String(text || '').normalize('NFKC')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[‘’]/g, "'")
    // Inline Markdown emphasis renders without its paired delimiters.
    // Requiring nonspace content avoids turning stray punctuation into a
    // clean claim. The canonical re-entry guard handles richer markup.
    .replace(/(\*\*\*|___|\*\*|__|\*|_)([^\s*_](?:[^\r\n]*?[^\s*_])?)\1/g, '$2');
}

// Keep a visit's adjectives local to the unit. In particular, a correct
// "per application" price must not absorb a separate reference to a visit.
const VISIT_SRC = '(?:(?!applications?\\b)[a-z]+(?:-[a-z]+)*\\s+)*visits?\\b';
const VISIT_UNIT_SRC = `(?:each|every|a)\\s+${VISIT_SRC}`;
const PRICE_UNIT_SRC = `(?:(?:(?:for|on)\\s+)?${VISIT_UNIT_SRC}|per[\\s-]+${VISIT_SRC}|/\\s*${VISIT_SRC})`;
const AMOUNT_SRC = '(?:\\$\\s*\\d[\\d,.]*|\\b\\d[\\d,.]*\\s+dollars?)';
const PRICE_NOUN_SRC = '(?:price|amount|cost|charge|rate|fee)';
const VISIT_PRICE_RE = new RegExp([
  `${AMOUNT_SRC}(?:\\s+${PRICE_NOUN_SRC}(?:\\s+(?:is|will\\s+be))?)?\\s*${PRICE_UNIT_SRC}`,
  `\\b(?:${PRICE_NOUN_SRC}|billing|billed|bills?|charging|charged|charges?|pricing|priced|payments?|pay|paid)(?:\\s+(?:is|are|was|were|will\\s+be))?\\s+${PRICE_UNIT_SRC}`,
  `\\b${VISIT_UNIT_SRC}\\s+(?:(?:is|was|will\\s+be)\\s+(?:(?:priced|billed|charged)\\s+(?:at\\s+)?)?|(?:costs?|runs?|will\\s+cost)\\s+)${AMOUNT_SRC}`,
  `\\b${VISIT_UNIT_SRC}\\s+has\\s+(?:a\\s+)?${AMOUNT_SRC}\\s+${PRICE_NOUN_SRC}\\b`,
  `\\bvisits\\s+(?:(?:are|were|will\\s+be)\\s+(?:(?:priced|billed|charged)\\s+(?:at\\s+)?)?|(?:cost|run|will\\s+cost)\\s+)${AMOUNT_SRC}\\s+(?:each|apiece)\\b`,
].join('|'), 'i');

const EPA_CERTIFIED_RE = /\bEPA[\s-]*(?:(?:has|have|had)\s+)?(?:officially\s+)?certif(?:ied|ies|ication)\b|\bcertif(?:ied|ication)\b[^.!?]{0,20}\b(?:by|from)\s+(?:the\s+)?EPA\b/i;
const RETIRED_SHORT_NAME_RE = /\bWaves\s+(?:Lawn\b|Pest\b(?!\s+Control\b))/i;

// A copy-only, inactive policy. Factual grounding and send authorization
// require separate checks; passing this screen establishes neither.
function verifyEmailReplyCustomerCopy({ text, commercialProposal = false } = {}) {
  const draft = String(text || '');
  const normalized = normalizeCopy(draft);
  const violations = [];
  if (findBannedCustomerCopy(normalized).length > 0
    || (commercialProposal !== true && VISIT_PRICE_RE.test(normalized))
    || RETIRED_NAME_RE.test(normalized)
    || NONCANONICAL_SUFFIX_RE.test(normalized)
    || RETIRED_SHORT_NAME_RE.test(normalized)
    || EPA_CERTIFIED_RE.test(normalized)
    || reentrySafetyClaimFinding(draft)) violations.push('customer_copy_compliance');
  return { ok: violations.length === 0, violations };
}

module.exports = { verifyEmailReplyCustomerCopy };
