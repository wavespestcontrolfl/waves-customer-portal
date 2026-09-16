const { normalizeEmailReplyCopy } = require('./email-reply-copy-normalizer');

// Keep a visit's modifiers local to its noun phrase. Clause boundaries,
// prepositions, determiners, and account/payment/access nouns cannot bridge a
// price to a later scheduling reference; eight modifiers preserve known copy.
const VISIT_MODIFIER_STOP_SRC = '(?:a|access|account|accounts|after|an|and|any|are|at|balance|balances|be|been|before|being|but|by|can|could|cover|covered|covering|covers|did|do|does|during|each|every|for|from|had|has|have|her|his|if|include|included|includes|including|in|into|is|its|may|might|must|my|of|on|one|or|our|payment|payments|per|should|since|than|that|the|their|then|these|this|those|through|to|until|was|were|when|where|while|will|with|without|would|your)';
const VISIT_MODIFIER_SRC = `(?!(?:applications?|${VISIT_MODIFIER_STOP_SRC})(?=\\s|$))(?:[a-z]+(?:-[a-z]+)*|\\d+(?:\\.\\d+)?(?:-(?:minute|hour|day|week|month|year)s?|\\s+(?:minutes?|hours?|days?|weeks?|months?|years?)))`;
const VISIT_SRC = `(?:${VISIT_MODIFIER_SRC}\\s+){0,8}visits?\\b`;
const BARE_VISITS_SRC = `(?:${VISIT_MODIFIER_SRC}\\s+){0,8}visits\\b`;
const VISIT_UNIT_SRC = `(?:each|every|a|an|one|the|your|our|my|their|his|her|its|this|that|any)\\s+${VISIT_SRC}`;
const VISIT_REFERENCE_SRC = `(?:${VISIT_UNIT_SRC}|${VISIT_SRC})`;
const ON_RECURRING_VISIT_SRC = `(?:(?:each|every|any)\\s+${VISIT_SRC}|(?:(?:the|your|our|my|their|his|her|its|these|those)\\s+)?${BARE_VISITS_SRC})`;
const PRICE_UNIT_SRC = `(?:for\\s+${VISIT_REFERENCE_SRC}|on\\s+${ON_RECURRING_VISIT_SRC}|${VISIT_UNIT_SRC}|at\\s+(?:each|every)\\s+${VISIT_SRC}|per[\\s-]+${VISIT_SRC}|/\\s*${VISIT_SRC})`;
const POSSESSIVE_VISIT_SRC = `${VISIT_REFERENCE_SRC}(?:'s|')`;

// Bound numeric components so malformed long tokens cannot trigger
// quadratic retries. Bare numbers require a price noun or billing verb.
const NUMBER_SRC = '\\d{1,9}(?:,\\d{3}){0,3}(?:\\.\\d{1,2})?';
const NUMERIC_PRICE_SRC = `${NUMBER_SRC}(?:\\s*(?:-|to)\\s*(?:(?:\\$\\s*|USD\\s+))?${NUMBER_SRC})?`;
const ONE_TO_NINETEEN_SRC = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)';
const TENS_SRC = '(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)';
const UNDER_HUNDRED_SRC = `(?:${ONE_TO_NINETEEN_SRC}|${TENS_SRC}(?:[-\\s](?:one|two|three|four|five|six|seven|eight|nine))?)`;
const WRITTEN_NUMBER_SRC = `(?:(?:a|one|two|three|four|five|six|seven|eight|nine)\\s+hundred(?:\\s+(?:and\\s+)?${UNDER_HUNDRED_SRC})?|${UNDER_HUNDRED_SRC})`;
const WRITTEN_AMOUNT_SRC = `\\b${WRITTEN_NUMBER_SRC}\\s+(?:dollars?|bucks?)\\b`;
const AMOUNT_SRC = `(?:(?:only|just|about|around|approximately|roughly|exactly|nearly|almost|up\\s+to|at\\s+least|as\\s+low\\s+as)\\s+){0,3}(?:(?:\\$\\s*|\\bUSD\\s+)${NUMERIC_PRICE_SRC}|\\b${NUMERIC_PRICE_SRC}\\s+(?:dollars?|bucks?|USD)\\b|${WRITTEN_AMOUNT_SRC})`;
const PRICE_NOUN_SRC = '(?:prices?|amounts?|costs?|charges?|rates?|fees?|invoices?)';
const CONTEXT_AMOUNT_SRC = `(?:${AMOUNT_SRC}|${NUMERIC_PRICE_SRC}\\b)`;
const AMOUNT_UNIT_QUALIFIER_SRC = `(?:\\s+(?:(?:plus|before)\\s+(?:tax(?:es)?|fees?)|\\+\\s*(?:tax(?:es)?|fees?)))?`;
const VISIT_FEE_PHRASE_SRC = `(?:${VISIT_SRC}|service-visits?)`;
const SERVICE_PRICE_SUBJECT_SRC = `(?:(?:(?:the|our|your)\\s+)?services?|pest\\s+control)`;

const VISIT_MONETARY_PRICE_RE = new RegExp([
  `${AMOUNT_SRC}(?:\\s+${PRICE_NOUN_SRC}(?:\\s+(?:is|will\\s+be))?)?${AMOUNT_UNIT_QUALIFIER_SRC}\\s*(?:[(:,-]\\s*)?${PRICE_UNIT_SRC}`,
  `\\b${PRICE_UNIT_SRC}\\s*(?:[,:(-]\\s*)?(?:(?:the|our|your|a)\\s+)?${PRICE_NOUN_SRC}\\s+(?:is|are|was|were|will\\s+be|of)\\s*${CONTEXT_AMOUNT_SRC}`,
  `\\b${PRICE_UNIT_SRC}\\s*(?:[,:(-]\\s*)?(?:(?:we|you)\\s+)?(?:charge|bill|pay|invoice)\\s+${CONTEXT_AMOUNT_SRC}`,
  `\\b${VISIT_REFERENCE_SRC}\\s+(?:(?:is|was|will\\s+be)\\s+(?:(?:priced|billed|charged|invoiced)\\s+(?:at\\s+)?)?|(?:costs?|runs?|will\\s+cost)\\s+)${AMOUNT_SRC}`,
  `\\b${VISIT_REFERENCE_SRC}\\s+(?:(?:is|was|will\\s+be)\\s+(?:priced|billed|charged|invoiced)\\s+(?:at\\s+)?|(?:costs?|will\\s+cost)\\s+)${NUMERIC_PRICE_SRC}\\b`,
  `\\b${VISIT_REFERENCE_SRC}\\s+has\\s+(?:an?\\s+)?${AMOUNT_SRC}\\s+${PRICE_NOUN_SRC}\\b`,
  `\\b${VISIT_REFERENCE_SRC}\\s+has\\s+(?:an?\\s+)?${PRICE_NOUN_SRC}\\s+of\\s+${CONTEXT_AMOUNT_SRC}`,
  `\\bvisits\\s+(?:(?:are|were|will\\s+be)\\s+(?:(?:priced|billed|charged|invoiced)\\s+(?:at\\s+)?)?|(?:cost|run|will\\s+cost)\\s+)${AMOUNT_SRC}\\s+(?:each|apiece)\\b`,
  `\\bvisits\\s+(?:(?:are|were|will\\s+be)\\s+(?:priced|billed|charged|invoiced)\\s+(?:at\\s+)?|(?:cost|will\\s+cost)\\s+)${NUMERIC_PRICE_SRC}\\s+(?:each|apiece)\\b`,
  `\\b${PRICE_NOUN_SRC}\\s+(?:is|are|was|were|will\\s+be|of)\\s+${CONTEXT_AMOUNT_SRC}${AMOUNT_UNIT_QUALIFIER_SRC}\\s*[,:(-]?\\s*${PRICE_UNIT_SRC}`,
  `\\b(?:charge|charges|charged|charging|bill|billed|invoice|invoiced|pay|paid)\\s+${CONTEXT_AMOUNT_SRC}${AMOUNT_UNIT_QUALIFIER_SRC}\\s*[,:(-]?\\s*${PRICE_UNIT_SRC}`,
  `\\b(?:charge|charged|charging|bill|billed|billing|invoice|invoiced|invoicing)\\s+${VISIT_REFERENCE_SRC}\\s+(?:at\\s+)?${CONTEXT_AMOUNT_SRC}`,
  `\\b${PRICE_NOUN_SRC}\\s+(?:for\\s+)?${PRICE_UNIT_SRC}\\s*(?:(?:is|are|was|were|will\\s+be|of)\\s*|[:\\-]\\s*)${CONTEXT_AMOUNT_SRC}`,
  `\\b${POSSESSIVE_VISIT_SRC}\\s+${PRICE_NOUN_SRC}\\s+(?:is|are|was|were|will\\s+be|of)\\s*${CONTEXT_AMOUNT_SRC}`,
  `${AMOUNT_SRC}\\s+${VISIT_FEE_PHRASE_SRC}\\s+${PRICE_NOUN_SRC}\\b`,
  `\\b${VISIT_REFERENCE_SRC}\\s*[:\\-]\\s*${AMOUNT_SRC}`,
  `\\b${SERVICE_PRICE_SUBJECT_SRC}\\s+(?:costs?|runs?|will\\s+cost|(?:is|was|will\\s+be)\\s+priced\\s+at)\\s+${NUMERIC_PRICE_SRC}\\s+${PRICE_UNIT_SRC}`,
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
