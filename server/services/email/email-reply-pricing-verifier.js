// Normalize typography before matching the customer-visible copy. This
// includes nonbreaking hyphens in visit units.
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

// Keep a visit's adjectives local to the unit. In particular, a correct
// "per application" price must not absorb a separate reference to a visit.
const VISIT_SRC = '(?:(?!applications?\\b)[a-z]+(?:-[a-z]+)*\\s+)*visits?\\b';
const VISIT_UNIT_SRC = `(?:each|every|a)\\s+${VISIT_SRC}`;
const PRICE_UNIT_SRC = `(?:(?:(?:for|on)\\s+)?${VISIT_UNIT_SRC}|per[\\s-]+${VISIT_SRC}|/\\s*${VISIT_SRC})`;
const AMOUNT_SRC = '(?:(?:\\$\\s*|\\bUSD\\s+)\\d(?:[\\d,.]*\\d)?|\\b\\d(?:[\\d,.]*\\d)?\\s+(?:dollars?|bucks?|USD)\\b)';
const PRICE_NOUN_SRC = '(?:price|amount|cost|charge|rate|fee)';
const VISIT_PRICE_RE = new RegExp([
  `${AMOUNT_SRC}(?:\\s+${PRICE_NOUN_SRC}(?:\\s+(?:is|will\\s+be))?)?\\s*(?:[(:-]\\s*)?${PRICE_UNIT_SRC}`,
  `\\b(?:price|amount|cost|charge|fee|(?:the|a|our|your|its)\\s+rate|rate(?=\\s+(?:is|are|was|were|will\\s+be)\\b)|billing|billed|bills?|charging|charged|charges?|pricing|priced|payments?|pay|paid)(?:\\s+(?:is|are|was|were|will\\s+be))?\\s+${PRICE_UNIT_SRC}`,
  `\\b${PRICE_UNIT_SRC}\\s*(?:[,:(-]\\s*)?(?:(?:the|our|your|a)\\s+)?${PRICE_NOUN_SRC}\\s+(?:is|was|will\\s+be|of)\\s+${AMOUNT_SRC}`,
  `\\b${PRICE_UNIT_SRC}\\s*(?:[,:(-]\\s*)?(?:(?:we|you)\\s+)?(?:charge|bill|pay)\\s+${AMOUNT_SRC}`,
  `\\b${VISIT_UNIT_SRC}\\s+(?:(?:is|was|will\\s+be)\\s+(?:(?:priced|billed|charged)\\s+(?:at\\s+)?)?|(?:costs?|runs?|will\\s+cost)\\s+)${AMOUNT_SRC}`,
  `\\b${VISIT_UNIT_SRC}\\s+has\\s+(?:a\\s+)?${AMOUNT_SRC}\\s+${PRICE_NOUN_SRC}\\b`,
  `\\bvisits\\s+(?:(?:are|were|will\\s+be)\\s+(?:(?:priced|billed|charged)\\s+(?:at\\s+)?)?|(?:cost|run|will\\s+cost)\\s+)${AMOUNT_SRC}\\s+(?:each|apiece)\\b`,
].join('|'), 'i');

// Inactive wording policy only. A future caller must establish commercial
// proposal context from trusted data; this does not verify monetary facts.
function verifyEmailReplyPricing({ text, commercialProposal = false } = {}) {
  const blocked = commercialProposal !== true && VISIT_PRICE_RE.test(normalizeCopy(text));
  return { ok: !blocked, violations: blocked ? ['customer_copy_compliance'] : [] };
}

module.exports = { verifyEmailReplyPricing };
