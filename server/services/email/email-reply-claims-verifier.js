const { findBannedCustomerCopy } = require('../service-report/activity-indicators');
const { reentrySafetyClaimFinding } = require('../content/content-guardrails');

// Normalize typography before matching the customer-visible copy. This
// includes nonbreaking hyphens in compliance claims.
function normalizeCopy(text) {
  return String(text || '').normalize('NFKC')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[‘’]/g, "'")
    // Inline Markdown emphasis renders without its paired delimiters.
    // Requiring nonspace content avoids turning stray punctuation into a
    // clean claim. The canonical re-entry guard handles richer markup.
    .replace(/(\*\*\*|___|\*\*|__|\*|_)([^\s*_](?:[^\r\n]*?[^\s*_])?)\1/g, '$2');
}

const EPA_CERTIFIED_RE = /\bEPA(?:'s)?[\s-]*(?:(?:has|have|had)\s+)?(?:officially\s+)?certif(?:ied|ies|ication)\b|\bcertif(?:ied|ication)\b[^.!?]{0,20}\b(?:by|from)\s+(?:the\s+)?EPA\b/i;

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
