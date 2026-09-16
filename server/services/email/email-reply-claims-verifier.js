const { findBannedCustomerCopy } = require('../service-report/activity-indicators');
const { reentrySafetyClaimFinding } = require('../content/content-guardrails');

// Normalize typography before matching the customer-visible copy. This
// includes nonbreaking hyphens in compliance claims.
function normalizeCopy(text) {
  let copy = String(text || '').normalize('NFKC')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[‘’]/g, "'");
  // Peel paired emphasis layers until stable; every changed pass removes
  // delimiters, including nested wrappers, while leaving stray punctuation.
  let previous;
  do {
    previous = copy;
    copy = copy.replace(/(\*\*\*|___|\*\*|__|\*|_)([^\s*_](?:[^\r\n]*?[^\s*_])?)\1/g, '$2');
  } while (copy !== previous);
  return copy;
}

const EPA_CERTIFIED_RE = /\bEPA(?:'s)?[\s-]*(?:(?:has|have|had)\s+)?(?:officially\s+)?certif(?:ied|ies|ication)\b|\bcertif(?:ied|ication)\b[^.!?]{0,20}\b(?:by|from)\s+(?:the\s+)?(?:U\.?S\.?\s+)?EPA\b/i;

// A claims-only, inactive policy. Factual grounding and send authorization
// require separate checks; passing this screen establishes neither.
function verifyEmailReplyClaims({ text } = {}) {
  const draft = String(text || '');
  const normalized = normalizeCopy(draft);
  const violations = [];
  if (findBannedCustomerCopy(normalized).length > 0
    || EPA_CERTIFIED_RE.test(normalized)
    || reentrySafetyClaimFinding(draft)) violations.push('customer_copy_compliance');
  return { ok: violations.length === 0, violations };
}

module.exports = { verifyEmailReplyClaims };
