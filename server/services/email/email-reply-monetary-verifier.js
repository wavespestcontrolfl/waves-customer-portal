const { normalizeEmailReplyCopy } = require('./email-reply-copy-normalizer');

// Keep a visit's adjectives local to the unit. In particular, a correct
// "per application" amount must not absorb a separate reference to a visit.
const VISIT_SRC = '(?:(?!applications?\\b)(?:[a-z]+(?:-[a-z]+)*|\\d+(?:\\.\\d+)?-(?:minute|hour|day|week|month|year)s?)\\s+)*visits?\\b';
const VISIT_UNIT_SRC = `(?:each|every|a|an|one|the|your|our|my|their|his|her|its|this|that|any)\\s+${VISIT_SRC}`;
const PRICE_UNIT_SRC = `(?:(?:(?:for|on)\\s+)?${VISIT_UNIT_SRC}|per[\\s-]+${VISIT_SRC}|/\\s*${VISIT_SRC})`;
const POSSESSIVE_VISIT_SRC = `${VISIT_UNIT_SRC}(?:'s|')`;

// Bound numeric components so malformed long tokens cannot trigger
// quadratic retries. Bare numbers require a price noun or billing verb.
const NUMBER_SRC = '\\d{1,9}(?:,\\d{3}){0,3}(?:\\.\\d{1,2})?';
const NUMERIC_PRICE_SRC = `${NUMBER_SRC}(?:\\s*(?:-|to)\\s*(?:(?:\\$\\s*|USD\\s+))?${NUMBER_SRC})?`;
const AMOUNT_SRC = `(?:(?:only|just|about|around|approximately|roughly|exactly|nearly|almost|up\\s+to|at\\s+least|as\\s+low\\s+as)\\s+){0,3}(?:(?:\\$\\s*|\\bUSD\\s+)${NUMERIC_PRICE_SRC}|\\b${NUMERIC_PRICE_SRC}\\s+(?:dollars?|bucks?|USD)\\b)`;
const PRICE_NOUN_SRC = '(?:prices?|amounts?|costs?|charges?|rates?|fees?|invoices?)';
const CONTEXT_AMOUNT_SRC = `(?:${AMOUNT_SRC}|${NUMERIC_PRICE_SRC}\\b)`;

const VISIT_MONETARY_PRICE_RE = new RegExp([
  `${AMOUNT_SRC}(?:\\s+${PRICE_NOUN_SRC}(?:\\s+(?:is|will\\s+be))?)?\\s*(?:[(:,-]\\s*)?${PRICE_UNIT_SRC}`,
  `\\b${PRICE_UNIT_SRC}\\s*(?:[,:(-]\\s*)?(?:(?:the|our|your|a)\\s+)?${PRICE_NOUN_SRC}\\s+(?:is|are|was|were|will\\s+be|of)\\s*${CONTEXT_AMOUNT_SRC}`,
  `\\b${PRICE_UNIT_SRC}\\s*(?:[,:(-]\\s*)?(?:(?:we|you)\\s+)?(?:charge|bill|pay|invoice)\\s+${CONTEXT_AMOUNT_SRC}`,
  `\\b${VISIT_UNIT_SRC}\\s+(?:(?:is|was|will\\s+be)\\s+(?:(?:priced|billed|charged|invoiced)\\s+(?:at\\s+)?)?|(?:costs?|runs?|will\\s+cost)\\s+)${AMOUNT_SRC}`,
  `\\b${VISIT_UNIT_SRC}\\s+(?:(?:is|was|will\\s+be)\\s+(?:priced|billed|charged|invoiced)\\s+(?:at\\s+)?|(?:costs?|will\\s+cost)\\s+)${NUMERIC_PRICE_SRC}\\b`,
  `\\b${VISIT_UNIT_SRC}\\s+has\\s+(?:a\\s+)?${AMOUNT_SRC}\\s+${PRICE_NOUN_SRC}\\b`,
  `\\bvisits\\s+(?:(?:are|were|will\\s+be)\\s+(?:(?:priced|billed|charged|invoiced)\\s+(?:at\\s+)?)?|(?:cost|run|will\\s+cost)\\s+)${AMOUNT_SRC}\\s+(?:each|apiece)\\b`,
  `\\bvisits\\s+(?:(?:are|were|will\\s+be)\\s+(?:priced|billed|charged|invoiced)\\s+(?:at\\s+)?|(?:cost|will\\s+cost)\\s+)${NUMERIC_PRICE_SRC}\\s+(?:each|apiece)\\b`,
  `\\b${PRICE_NOUN_SRC}\\s+(?:is|are|was|were|will\\s+be|of)\\s+${CONTEXT_AMOUNT_SRC}\\s*[,:(-]?\\s*${PRICE_UNIT_SRC}`,
  `\\b(?:charge|charges|charged|charging|bill|billed|invoice|invoiced|pay|paid)\\s+${CONTEXT_AMOUNT_SRC}\\s*[,:(-]?\\s*${PRICE_UNIT_SRC}`,
  `\\b${PRICE_NOUN_SRC}\\s+(?:for\\s+)?${PRICE_UNIT_SRC}\\s+(?:is|are|was|were|will\\s+be|of)\\s*${CONTEXT_AMOUNT_SRC}`,
  `\\b${POSSESSIVE_VISIT_SRC}\\s+${PRICE_NOUN_SRC}\\s+(?:is|are|was|were|will\\s+be|of)\\s*${CONTEXT_AMOUNT_SRC}`,
].join('|'), 'i');

// Inactive wording policy only. A future caller must establish commercial
// proposal context from trusted data; this does not verify monetary facts.
function verifyEmailReplyMonetaryPricing({ text = '', commercialProposal = false } = {}) {
  const normalized = normalizeEmailReplyCopy(text);
  if (!normalized.ok) return { ok: false, violations: [normalized.reason] };

  const blocked = commercialProposal !== true && VISIT_MONETARY_PRICE_RE.test(normalized.text);
  return { ok: !blocked, violations: blocked ? ['customer_copy_compliance'] : [] };
}

module.exports = { verifyEmailReplyMonetaryPricing };
