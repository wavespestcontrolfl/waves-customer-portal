const { decodeHTML } = require('entities');

// Normalize typography before matching the customer-visible copy. This
// includes nonbreaking hyphens in visit units.
function normalizeCopy(text) {
  let copy = decodeHTML(String(text || '')).normalize('NFKC')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/\\(?:\r\n?|\n)/g, ' ')
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
  return copy;
}

// Keep a visit's adjectives local to the unit. In particular, a correct
// "per application" price must not absorb a separate reference to a visit.
const VISIT_SRC = '(?:(?!applications?\\b)(?:[a-z]+(?:-[a-z]+)*|\\d+(?:\\.\\d+)?-(?:minute|hour|day|week|month|year)s?)\\s+)*visits?\\b';
const VISIT_UNIT_SRC = `(?:each|every|a|an|one|the|your|our|my|their|his|her|its|this|that|any)\\s+${VISIT_SRC}`;
const PRICE_UNIT_SRC = `(?:(?:(?:for|on)\\s+)?${VISIT_UNIT_SRC}|per[\\s-]+${VISIT_SRC}|/\\s*${VISIT_SRC})`;
// Bound numeric components so malformed long tokens cannot trigger quadratic retries.
const NUMBER_SRC = '\\d{1,9}(?:,\\d{3}){0,3}(?:\\.\\d{1,2})?';
const NUMERIC_PRICE_SRC = `${NUMBER_SRC}(?:\\s*(?:-|to)\\s*(?:(?:\\$\\s*|USD\\s+))?${NUMBER_SRC})?`;
const AMOUNT_SRC = `(?:(?:only|just|about|around|approximately|roughly|exactly|nearly|almost|up\\s+to|at\\s+least|as\\s+low\\s+as)\\s+){0,3}(?:(?:\\$\\s*|\\bUSD\\s+)${NUMERIC_PRICE_SRC}|\\b${NUMERIC_PRICE_SRC}\\s+(?:dollars?|bucks?|USD)\\b)`;
const PRICE_NOUN_SRC = '(?:prices?|amounts?|costs?|charges?|rates?|fees?|invoices?)';
const CONTEXT_AMOUNT_SRC = `(?:${AMOUNT_SRC}|${NUMERIC_PRICE_SRC}\\b)`;
const VISIT_PRICE_RE = new RegExp([
  `${AMOUNT_SRC}(?:\\s+${PRICE_NOUN_SRC}(?:\\s+(?:is|will\\s+be))?)?\\s*(?:[(:,-]\\s*)?${PRICE_UNIT_SRC}`,
  `\\b(?:prices?|amounts?|costs?|charges?|fees?|(?:the|a|our|your|its)\\s+rates?|rates?(?=\\s+(?:is|are|was|were|will\\s+be|per)\\b)|invoices?|invoiced|invoicing|billing|billed|bills?|charging|charged|charges?|pricing|priced|payments?|pay|paid)(?:\\s+(?:is|are|was|were|will\\s+be))?\\s+${PRICE_UNIT_SRC}`,
  `\\b${PRICE_UNIT_SRC}\\s*(?:[,:(-]\\s*)?(?:(?:the|our|your|a)\\s+)?${PRICE_NOUN_SRC}\\s+(?:is|was|will\\s+be|of)\\s+${AMOUNT_SRC}`,
  `\\b${PRICE_UNIT_SRC}\\s*(?:[,:(-]\\s*)?(?:(?:we|you)\\s+)?(?:charge|bill|pay|invoice)\\s+${CONTEXT_AMOUNT_SRC}`,
  `\\b${VISIT_UNIT_SRC}\\s+(?:(?:is|was|will\\s+be)\\s+(?:(?:priced|billed|charged|invoiced)\\s+(?:at\\s+)?)?|(?:costs?|runs?|will\\s+cost)\\s+)${AMOUNT_SRC}`,
  `\\b${VISIT_UNIT_SRC}\\s+has\\s+(?:a\\s+)?${AMOUNT_SRC}\\s+${PRICE_NOUN_SRC}\\b`,
  `\\bvisits\\s+(?:(?:are|were|will\\s+be)\\s+(?:(?:priced|billed|charged|invoiced)\\s+(?:at\\s+)?)?|(?:cost|run|will\\s+cost)\\s+)${AMOUNT_SRC}\\s+(?:each|apiece)\\b`,
  `\\b${PRICE_NOUN_SRC}\\s+(?:is|are|was|were|will\\s+be|of)\\s+${CONTEXT_AMOUNT_SRC}\\s*[,:(-]?\\s*${PRICE_UNIT_SRC}`,
  `\\b(?:charge|charges|charged|charging|bill|billed|invoice|invoiced|pay|paid)\\s+${CONTEXT_AMOUNT_SRC}\\s*[,:(-]?\\s*${PRICE_UNIT_SRC}`,
  `\\b${PRICE_UNIT_SRC}\\s+(?:(?:the|our|your|a)\\s+)?${PRICE_NOUN_SRC}\\s+(?:is|are|was|were|will\\s+be|of)\\s+${CONTEXT_AMOUNT_SRC}`,
  `\\b${VISIT_UNIT_SRC}\\s+(?:(?:costs?|will\\s+cost)\\s+|(?:is|was|will\\s+be)\\s+(?:priced|billed|charged|invoiced)\\s+(?:at\\s+)?)${CONTEXT_AMOUNT_SRC}`,
  `\\b${VISIT_UNIT_SRC}\\s+(?:is|was|will\\s+be)\\s+(?:billed|charged|invoiced)\\s+(?:separately|individually|on\\s+its\\s+own)\\b`,
].join('|'), 'i');

// Inactive wording policy only. A future caller must establish commercial
// proposal context from trusted data; this does not verify monetary facts.
function verifyEmailReplyPricing({ text, commercialProposal = false } = {}) {
  const blocked = commercialProposal !== true && VISIT_PRICE_RE.test(normalizeCopy(text));
  return { ok: !blocked, violations: blocked ? ['customer_copy_compliance'] : [] };
}

module.exports = { verifyEmailReplyPricing };
