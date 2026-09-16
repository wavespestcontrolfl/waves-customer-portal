const { RETIRED_NAME_RE, NONCANONICAL_SUFFIX_RE } = require('../customer-company-name');

// Inline Markdown emphasis renders without its paired delimiters. Requiring
// nonspace content leaves unmatched punctuation in place.
function normalizeCompanyCopy(text) {
  let normalized = String(text || '').normalize('NFKC')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[‘’]/g, "'");
  let previous;
  do {
    previous = normalized;
    normalized = normalized.replace(
      /(\*\*\*|___|\*\*|__|\*|_)([^\s*_](?:[^\r\n]*?[^\s*_])?)\1/g,
      '$2',
    );
  } while (normalized !== previous);
  return normalized;
}

const NONCANONICAL_SERVICE_NAME_RE = /\bWaves\s+(?:Lawn\b|Pest\b(?!\s+Control\b)|(?:Termite|Mosquito)\s+(?:Control|Services?)\b|Exterminating\b)/i;

// An inactive company-name policy. Passing this screen establishes neither
// factual accuracy nor authorization to create or send a reply.
function verifyEmailReplyCompanyName({ text } = {}) {
  const copy = normalizeCompanyCopy(text);
  const violations = [];
  if (RETIRED_NAME_RE.test(copy)
    || NONCANONICAL_SUFFIX_RE.test(copy)
    || NONCANONICAL_SERVICE_NAME_RE.test(copy)) violations.push('customer_copy_compliance');
  return { ok: violations.length === 0, violations };
}

module.exports = { verifyEmailReplyCompanyName };
