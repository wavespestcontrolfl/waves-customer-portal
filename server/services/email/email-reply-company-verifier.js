const { RETIRED_NAME_RE, NONCANONICAL_SUFFIX_RE } = require('../customer-company-name');
const { decodeHTML } = require('entities');

// Rendered inline formatting loses paired delimiters. Repeat because code and
// emphasis may nest; run boundaries and the nonspace guard leave unmatched
// delimiters in place.
function normalizeCompanyCopy(text) {
  let normalized = decodeHTML(String(text || '')).normalize('NFKC')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/\\([-!"#$%&'()*+,.\/:;<=>?@[\]^_`{|}~\\])/g, '$1')
    .replace(/\\\r?\n/g, ' ')
    .replace(/\s+/g, ' ');
  let previous;
  do {
    previous = normalized;
    normalized = normalized
      .replace(
        /(?<!`)(`+)(?!`)([^`]+?)\1(?!`)/g,
        (_span, _ticks, content) => content.replace(/\r\n?|\n/g, ' '),
      )
      .replace(
        /(\*\*\*|___|\*\*|__|\*|_)([^\s*_](?:[^\r\n]*?[^\s*_])?)\1/g,
        '$2',
      );
  } while (normalized !== previous);
  return normalized;
}

const NONCANONICAL_SERVICE_NAME_RE = /\bwaves[\s-]+(?!pest\s+control\b)(?:(?:lawn|pest|termite|mosquito|rodent|wildlife|turf|shrub|tree|bed\s*bug)[\s-]+(?:control|care|services?|exterminating)|exterminating|lawn\b|pest\b)/gi;
const GENERIC_INTRODUCED_NAME_RE = /\bwaves\s+(?!pest\s+control\b)((?:(?!(?:a|an|and|about|for|of|on|or|regarding|the|to|with|your)\b)[a-z][a-z'-]*\s+){1,3})(?:control|care|services?|exterminating|solutions?|company|group|enterprises|holdings|partners|brands)\b/gi;
const COMPANY_INTRO_RE = /(?:\b(?:contacted|called|emailed|hired|booked|chose|selected|reached|from)\s+(?:the\s+)?(?:(?:company|business)\s+)?|\b(?:company|business)(?:\s+name)?\s+(?:is|was)\s+)$/i;
const EXPLICIT_NAME_ASSERTION_RE = /\b(?:company|business)(?:\s+name)?\s+(?:is|was)\s+$/i;
const CANONICAL_DESCRIPTIVE_SUFFIX_RE = /\b(Waves\s+Pest\s+Control)\s+(?:lawn|pest|termite|mosquito|rodent|wildlife|turf|shrub|tree|bed\s*bug)(?:\s+(?:care|control|services?))?(?=\s+(?:team|crew|technicians?|specialists?|plans?|programs?)\b)/gi;
const CANONICAL_SERVICE_SUFFIX_RE = /\bwaves\s+pest\s+control\s+((?:lawn|pest|termite|mosquito|rodent|wildlife|turf|shrub|tree|bed\s*bug)\s+(?:control|care|services?|exterminating))\b/gi;

function normalizedIntroduction(copy, index) {
  return copy.slice(0, index).replace(/[\s:;,.!?\-'"“”()[\]{}]+$/g, ' ');
}

function hasCompanyIntroduction(copy, index) {
  return COMPANY_INTRO_RE.test(normalizedIntroduction(copy, index));
}

function hasNoncanonicalServiceName(copy) {
  return [...copy.matchAll(NONCANONICAL_SERVICE_NAME_RE)].some((match) => {
    const alias = match[0];
    return alias !== alias.toLowerCase() || hasCompanyIntroduction(copy, match.index);
  });
}

function hasIntroducedGenericName(copy) {
  return [...copy.matchAll(GENERIC_INTRODUCED_NAME_RE)]
    .some((match) => hasCompanyIntroduction(copy, match.index));
}

function hasNoncanonicalServiceSuffix(copy) {
  return [...copy.matchAll(CANONICAL_SERVICE_SUFFIX_RE)].some((match) => {
    const suffix = match[1];
    return suffix !== suffix.toLowerCase() || hasCompanyIntroduction(copy, match.index);
  });
}

// An inactive company-name policy. Passing this screen establishes neither
// factual accuracy nor authorization to create or send a reply.
function verifyEmailReplyCompanyName({ text } = {}) {
  const copy = normalizeCompanyCopy(text);
  const suffixCopy = copy.replace(CANONICAL_DESCRIPTIVE_SUFFIX_RE,
    (match, canonicalName, offset) => (EXPLICIT_NAME_ASSERTION_RE.test(normalizedIntroduction(copy, offset))
      ? match
      : canonicalName));
  const violations = [];
  if (RETIRED_NAME_RE.test(copy)
    || NONCANONICAL_SUFFIX_RE.test(suffixCopy)
    || hasNoncanonicalServiceName(copy)
    || hasIntroducedGenericName(copy)
    || hasNoncanonicalServiceSuffix(suffixCopy)) violations.push('customer_copy_compliance');
  return { ok: violations.length === 0, violations };
}

module.exports = { verifyEmailReplyCompanyName };
