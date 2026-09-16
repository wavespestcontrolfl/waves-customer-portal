const { recognizeEmailReplyPricingClauses } = require('./email-reply-pricing-clauses');

// These patterns relate recognized evidence within one clause. Currency,
// measurements, auxiliaries and visit noun phrases are classified upstream.
const MONEY = '<money>';
const AMOUNT = '(?:<money>|<number>)';
const VISIT = '<(?:visit|visits|eachVisit)>';
const UNIT = '<(?:unit|forVisit)>';
const NOUN = '(?:price|amount|cost|charge|rate|fee|invoice)';
const BILL = '(?:charge|bill|invoice|pay|price)';
const QUALIFIER = '(?:(?:only|just|about|around|approximately|roughly|exactly|nearly|almost|up to|at least|as low as) ){0,3}';
const SEPARATOR = '(?: <sep>)*';
const SUBJECT = '(?:(?:we|you|it|customers?|clients?|they) )?';
const PRICE_PREDICATE = `(?:${BILL}(?: at)?|cost|run|<be> ${BILL}(?: at)?|<modal> (?:cost|run))`;
const LINK = `(?:<be>|${PRICE_PREDICATE}|<sep>|of)`;
const TAX = '(?: (?:plus|before) (?:tax|taxes|fee))?';
const RANGE_START = '(?:(?:between|from) )?';
const PRICE_AMOUNT = `(?:${RANGE_START}${MONEY}|<number>)`;

const PRICE_CLAUSES = [
  // Amount-first prices, including a fee label or a passive billing predicate.
  `${MONEY}(?: ${NOUN}(?: <be>)?)?(?: <be> ${BILL})?${TAX}${SEPARATOR} (?:${UNIT}|${VISIT})`,
  `${MONEY} ${VISIT} ${NOUN}`,
  // Visit subjects and labels. An unmarked number needs a pricing predicate;
  // a plain copula or colon needs an explicitly monetary amount.
  `${VISIT} (?:<be>|<sep>) ${QUALIFIER}${RANGE_START}${MONEY}`,
  `${VISIT} ${PRICE_PREDICATE} ${QUALIFIER}${PRICE_AMOUNT}`,
  `${VISIT}(?: <possessive>)? ${NOUN} ${LINK} ${QUALIFIER}${AMOUNT}`,
  `${VISIT} has (?:a |an )?(?:${MONEY} ${NOUN}|${NOUN} of ${AMOUNT})`,
  // Fronted visit units may introduce a price noun or a bounded subject.
  `${UNIT}${SEPARATOR} (?:the |our |your |a )?(?:${NOUN} ${LINK}|${SUBJECT}${PRICE_PREDICATE}) ${QUALIFIER}${PRICE_AMOUNT}`,
  `${NOUN} (?:for )?${UNIT} (?:${LINK}|range(?: from)?) ${QUALIFIER}${PRICE_AMOUNT}`,
  // Explicit price context is required for bare numbers before a unit.
  `(?:${NOUN} <be>|${PRICE_PREDICATE}) ${QUALIFIER}${AMOUNT}${TAX}${SEPARATOR} ${UNIT}`,
  `${BILL} ${VISIT} (?:at )?${AMOUNT}`,
].map((source) => new RegExp(`(?:^| )${source}(?= |$)`));

function verifyEmailReplyMonetaryPricing({ text = '', commercialProposal = false } = {}) {
  const recognized = recognizeEmailReplyPricingClauses(text);
  if (!recognized.ok) return { ok: false, violations: [recognized.reason] };
  const blocked = commercialProposal !== true && recognized.clauses.some((tokens) => {
    const clause = tokens.map(({ kind, text: token }) => (kind === 'word' ? token : `<${kind}>`)).join(' ');
    return PRICE_CLAUSES.some((pattern) => pattern.test(clause));
  });
  return { ok: !blocked, violations: blocked ? ['customer_copy_compliance'] : [] };
}

module.exports = { verifyEmailReplyMonetaryPricing };
