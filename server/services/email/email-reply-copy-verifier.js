const { findBannedCustomerCopy } = require('../service-report/activity-indicators');
const { reentrySafetyClaimFinding } = require('../content/content-guardrails');

// Normalize typography before matching the customer-visible copy. This
// includes nonbreaking hyphens in both visit units and compliance claims.
function normalizeCopy(text) {
  return String(text || '').normalize('NFKC')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[‘’]/g, "'");
}

// Keep a visit's adjectives local to the unit. In particular, a correct
// "per application" price must not absorb a separate reference to a visit.
const VISIT_SRC = '(?:(?!applications?\\b)[a-z]+(?:-[a-z]+)*\\s+)*visit\\b';
const VISIT_UNIT_SRC = `(?:each|every|a)\\s+${VISIT_SRC}`;
const PRICE_UNIT_SRC = `(?:(?:for\\s+)?${VISIT_UNIT_SRC}|per[\\s-]+${VISIT_SRC}|/\\s*${VISIT_SRC})`;
const AMOUNT_SRC = '(?:\\$\\s*\\d[\\d,.]*|\\b\\d[\\d,.]*\\s+dollars?)';
const VISIT_PRICE_RE = new RegExp([
  `${AMOUNT_SRC}\\s*${PRICE_UNIT_SRC}`,
  `\\b(?:price|amount|cost|charge|rate)\\s+${PRICE_UNIT_SRC}`,
  `\\b${VISIT_UNIT_SRC}\\s+(?:(?:is|was|will\\s+be)\\s+(?:(?:priced|billed|charged)\\s+at\\s+)?|(?:costs?|runs?|will\\s+cost)\\s+)${AMOUNT_SRC}`,
].join('|'), 'i');

// The previsit brief's retired-name shape also recognizes reordered words
// and punctuation separators. A connector after the canonical name is a
// different, retired brand; ordinary prose about its lawn team is not.
const RETIRED_NAME_RE = /waves\W+(?:lawn\W*(?:and\W+)?\W*pest|pest\W*(?:and\W+)?\W*lawn)|\bWaves\s+Pest\s+Control\s*(?:[-+&/]|and)\s*Lawn\b/i;
const EPA_CERTIFIED_RE = /\bEPA[\s-]*certified\b|\bcertified\b[^.!?]{0,20}\b(?:by|from)\s+(?:the\s+)?EPA\b/i;

// A copy-only, inactive policy. Factual grounding and send authorization
// require separate checks; passing this screen establishes neither.
function verifyEmailReplyCustomerCopy({ text } = {}) {
  const draft = String(text || '');
  const normalized = normalizeCopy(draft);
  const violations = [];
  if (findBannedCustomerCopy(normalized).length > 0
    || VISIT_PRICE_RE.test(normalized)
    || RETIRED_NAME_RE.test(normalized)
    || EPA_CERTIFIED_RE.test(normalized)
    || reentrySafetyClaimFinding(draft)) violations.push('customer_copy_compliance');
  return { ok: violations.length === 0, violations };
}

module.exports = { verifyEmailReplyCustomerCopy };
