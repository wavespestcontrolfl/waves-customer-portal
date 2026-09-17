const { findBannedCustomerCopy } = require('../service-report/activity-indicators');
const { reentrySafetyClaimFinding } = require('../content/content-guardrails');
const { decodeHTML } = require('entities');

// Normalize typography before matching the customer-visible copy. This
// includes nonbreaking hyphens in compliance claims.
function normalizeCopy(text) {
  let copy = decodeHTML(String(text || '')).normalize('NFKC')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[‘’]/g, "'")
    // CommonMark punctuation escapes render without the backslash. Keep
    // unmatched backslashes and escapes before nonpunctuation characters.
    .replace(/\\([-!"#$%&'()*+,.\/:;<=>?@[\]^_`{|}~\\])/g, '$1')
    .replace(/\s+/g, ' ');
  // Peel paired inline-code and emphasis layers until stable; every changed
  // pass removes delimiters, including nested wrappers, while leaving stray
  // punctuation.
  let previous;
  do {
    previous = copy;
    copy = copy
      .replace(/(?<!`)(`+)(?!`)([^`]+?)\1(?!`)/g, (_, delimiter, contents) => contents.replace(/\r\n?|\n/g, ' '))
      .replace(/(\*\*\*|___|\*\*|__|\*|_)([^\s*_](?:[^\r\n]*?[^\s*_])?)\1/g, '$2');
  } while (copy !== previous);
  return copy
    .replace(/\bEPA\s*-\s*(?=(?:approved|certif(?:ied|ies|ications?)|registered|exempt)\b)/gi, 'EPA-')
    .replace(/\s+/g, ' ');
}

const EPA_CERTIFIED_RE = /\bEPA(?:'s\s+(?:(?:full|formal|official|officially)\s+)?|[\s-]*(?:(?:has|have|had)\s+)?(?:(?:full|formal|formally|official|officially|recent|recently)\s+)?)certif(?:ied|ies|ications?)\b|\bcertif(?:ied|ies|ications?)\b[^.!?]{0,20}\b(?:by|from)\s+(?:the\s+)?(?:U\.?S\.?\s+)?EPA\b/i;

// A claims-only, inactive policy. Factual grounding and send authorization
// require separate checks; passing this screen establishes neither.
function verifyEmailReplyClaims({ text } = {}) {
  const draft = String(text || '');
  const normalized = normalizeCopy(draft);
  const violations = [];
  if (findBannedCustomerCopy(normalized).length > 0
    || EPA_CERTIFIED_RE.test(normalized)
    || reentrySafetyClaimFinding(draft)
    || reentrySafetyClaimFinding(normalized)) violations.push('customer_copy_compliance');
  return { ok: violations.length === 0, violations };
}

module.exports = { verifyEmailReplyClaims };
