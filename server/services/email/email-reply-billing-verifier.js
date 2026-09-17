const { recognizeEmailReplyPricingClauses } = require('./email-reply-pricing-clauses');

const BILLING_WORDS = new Set([
  'bill', 'charge', 'cost', 'fee', 'invoice', 'payment', 'pay', 'price', 'amount', 'rate',
]);
const BILLING_VERBS = new Set(['bill', 'charge', 'invoice', 'pay', 'price']);
const BILLING_NOUNS = new Set(['bill', 'charge', 'cost', 'fee', 'invoice', 'payment', 'price', 'amount', 'rate']);
const SEPARATE_WORDS = new Set(['separately', 'individually']);
const CHARGE_NOUNS = new Set(['charge', 'fee', 'invoice']);

const isKind = (token, kind) => token?.kind === kind;
const isWord = (token, ...words) => isKind(token, 'word') && words.includes(token.text);
const isVisit = (token) => ['visit', 'visits', 'eachVisit'].includes(token?.kind);
const isUnit = (token) => ['unit', 'visit', 'visits', 'eachVisit'].includes(token?.kind);
const isBillingWord = (token) => isKind(token, 'word') && BILLING_WORDS.has(token.text);
const isBillingVerb = (token) => isKind(token, 'word') && BILLING_VERBS.has(token.text);
const isBillingNoun = (token) => isKind(token, 'word') && BILLING_NOUNS.has(token.text);
const isChargeNoun = (token) => isKind(token, 'word') && CHARGE_NOUNS.has(token.text);
const isSeparate = (token) => isKind(token, 'word') && SEPARATE_WORDS.has(token.text);
const isRecipient = (token) => isWord(token, 'you', 'us', 'them', 'him', 'her', 'customer', 'customers', 'client', 'clients');

function skipSeparators(tokens, from) {
  return isKind(tokens[from], 'sep') ? from + 1 : from;
}

function skipRecipient(tokens, from) {
  if (isRecipient(tokens[from])) return from + 1;
  if (isWord(tokens[from], 'your', 'our', 'their', 'his', 'her', 'my', 'the')
    && isWord(tokens[from + 1], 'account')) return from + 2;
  return from;
}

function isFeedbackRate(tokens, at) {
  return isWord(tokens[at], 'rate')
    && (isWord(tokens[at - 1], 'please') || isKind(tokens[at - 1], 'modal'));
}

function hasBillingUnit(tokens, at) {
  if (!isBillingWord(tokens[at]) || isFeedbackRate(tokens, at)) return false;
  let next = at + 1;
  if (isBillingVerb(tokens[at])) {
    const afterRecipient = skipRecipient(tokens, next);
    if (isWord(tokens[at], 'pay')
      && isKind(tokens[afterRecipient], 'visit')
      && tokens[afterRecipient].text === 'a visit') return false;
    next = afterRecipient;
  }
  if (isWord(tokens[next], 'frequency')) next += 1;
  if (isKind(tokens[next], 'be') || isWord(tokens[next], 'occur', 'apply')) next += 1;
  next = skipSeparators(tokens, next);
  if (isWord(tokens[next], 'not', 'never')) next += 1;
  if (isWord(tokens[at], 'rate') && !isKind(tokens[next], 'unit')) return false;
  return isUnit(tokens[next]);
}

function hasInverseBillingUnit(tokens, at) {
  if (!isKind(tokens[at], 'unit')) return false;
  const next = skipSeparators(tokens, at + 1);
  return isBillingNoun(tokens[next]);
}

function hasSeparatePredicate(tokens, at) {
  if (!isVisit(tokens[at])) return false;
  let next = at + 1;
  if (isKind(tokens[next], 'modal')) next += 1;
  if (!isKind(tokens[next], 'be')) return false;
  next += 1;
  if (isSeparate(tokens[next]) && isBillingVerb(tokens[next + 1])) return true;
  if (!isBillingVerb(tokens[next])) return false;
  return isSeparate(tokens[next + 1])
    || (isWord(tokens[next + 1], 'on')
      && isWord(tokens[next + 2], 'its', 'their')
      && isWord(tokens[next + 3], 'own'));
}

function hasActiveSeparateBilling(tokens, at) {
  let next = at;
  if (isSeparate(tokens[next]) && isBillingVerb(tokens[next + 1])) next = skipRecipient(tokens, next + 2);
  else if (isBillingVerb(tokens[next])) {
    next = skipRecipient(tokens, next + 1);
    if (!isSeparate(tokens[next])) return false;
    next += 1;
  } else return false;
  return isKind(tokens[next], 'unit');
}

function hasNominalBillingPredicate(tokens, at) {
  if (!isVisit(tokens[at])) return false;
  let next = at + 1;
  const action = tokens[next]?.text;
  if (!isWord(tokens[next], 'has', 'incur', 'generate')) return false;
  next += 1;
  if (isWord(tokens[next], 'its', 'their')) {
    if (action !== 'generate' || !isWord(tokens[next + 1], 'own')) return false;
    next += 2;
  } else if (isWord(tokens[next], 'a', 'an')) {
    next += 1;
    if (isWord(tokens[next], 'separate', 'individual')) next += 1;
    else if (action !== 'incur') return false;
  } else return false;
  return isChargeNoun(tokens[next]);
}

function hasBillingClaim(tokens) {
  for (let index = 0; index < tokens.length; index += 1) {
    if (hasBillingUnit(tokens, index)
      || hasInverseBillingUnit(tokens, index)
      || hasSeparatePredicate(tokens, index)
      || hasActiveSeparateBilling(tokens, index)
      || hasNominalBillingPredicate(tokens, index)) return true;
  }
  return false;
}

// Inactive wording policy only. The caller supplies commercial context from
// trusted data; the recognizer owns normalization and clause boundaries.
function verifyEmailReplyBilling({ text = '', commercialProposal = false } = {}) {
  const recognized = recognizeEmailReplyPricingClauses(text);
  if (!recognized.ok) return { ok: false, violations: [recognized.reason] };

  const blocked = commercialProposal !== true && recognized.clauses.some(hasBillingClaim);
  return { ok: !blocked, violations: blocked ? ['customer_copy_compliance'] : [] };
}

module.exports = { verifyEmailReplyBilling };
