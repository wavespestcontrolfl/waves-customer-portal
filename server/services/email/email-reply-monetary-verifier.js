const { recognizeEmailReplyPricingClauses } = require('./email-reply-pricing-clauses');

// These patterns relate recognized evidence within one clause. Currency,
// measurements, auxiliaries and visit noun phrases are classified upstream.
const MONEY = '<money>';
const AMOUNT = '(?:<money>|<number>)';
const VISIT = '<(?:visit|visits|eachVisit)>';
const UNIT = '<(?:unit|forVisit)>';
const NOUN = '(?:price|amount|cost|charge|rate|fee|invoice|payment)';
const BILL = '(?:charge|bill|invoice|pay|price)';
const QUALIFIER = '(?:(?:only|just|about|around|approximately|roughly|exactly|nearly|almost|up to|at (?:least|most)|as low as) ){0,3}';
const SEPARATOR = '(?: <sep>)*';
const SUBJECT = '(?:(?:we|you|it|customers?|clients?|they) )?';
const PRICE_PREDICATE = `(?:(?:<modal> )?(?:has )?(?:${BILL}(?: at)?|cost|run|incur|generate|apply|occur)|<be> ${BILL}(?: at)?)`;
const LINK = `(?:<be>|${PRICE_PREDICATE}|<sep>|of|amount to)`;
const TAX = '(?: (?:plus|before) (?:tax|taxes|fee))?';
const RANGE_START = '(?:(?:between|from) )?';
const PRICE_AMOUNT = `${RANGE_START}${AMOUNT}`;
const PRICE_COMPLEMENT = `(?:for )?(?:(?:a|an) )?${QUALIFIER}${PRICE_AMOUNT}`;
const NOMINAL_PRICE = `(?:${QUALIFIER}${MONEY} ${NOUN}|${NOUN} of ${QUALIFIER}${PRICE_AMOUNT})`;

const PRICE_CLAUSES = [
  // Amount-first prices, including a fee label or a passive billing predicate.
  `${MONEY}(?: ${NOUN})?(?: <be>)?(?: (?:${PRICE_PREDICATE}|due))?${TAX}(?: ${VISIT}|${SEPARATOR} ${UNIT})`,
  `<number> <be> ${BILL}${TAX}${SEPARATOR} ${UNIT}`,
  `${MONEY} ${VISIT} ${NOUN}`,
  `${MONEY} <be> (?:the |our |your |a )?${NOUN}${SEPARATOR} ${UNIT}`,
  // Visit subjects and labels. An unmarked number needs a pricing predicate;
  // a plain copula or colon needs an explicitly monetary amount.
  `${VISIT} (?:(?:<modal> )?${QUALIFIER}<be>|<sep>) ${QUALIFIER}${RANGE_START}${MONEY}`,
  `${VISIT} <be> (?:a|an) ${NOMINAL_PRICE}`,
  `${VISIT} ${PRICE_PREDICATE} ${PRICE_COMPLEMENT}`,
  `${VISIT}(?: <possessive>)? ${NOUN} ${LINK} ${QUALIFIER}${AMOUNT}`,
  `${VISIT} <possessive> ${QUALIFIER}${MONEY} ${NOUN}`,
  `${VISIT}(?: <modal>)? has ${QUALIFIER}(?:a |an )?${NOMINAL_PRICE}`,
  // Fronted visit units may label money directly or introduce pricing context.
  `${UNIT}${SEPARATOR} ${QUALIFIER}${RANGE_START}${MONEY}`,
  `${UNIT}${SEPARATOR} there <be> ${QUALIFIER}(?:a |an )?${QUALIFIER}${MONEY}`,
  `${UNIT}${SEPARATOR} (?:the |our |your |a )?(?:${NOUN} ${LINK}|${SUBJECT}${PRICE_PREDICATE}) ${PRICE_COMPLEMENT}`,
  `${NOUN} (?:for )?${UNIT} (?:${LINK}|range(?: from)?) ${QUALIFIER}${PRICE_AMOUNT}`,
  // Explicit price context is required for bare numbers before a unit.
  `(?:${NOUN} <be>|${PRICE_PREDICATE}) ${PRICE_COMPLEMENT}${TAX}${SEPARATOR} ${UNIT}`,
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
