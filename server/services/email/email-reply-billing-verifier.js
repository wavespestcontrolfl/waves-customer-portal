const { recognizeEmailReplyPricingClauses } = require('./email-reply-pricing-clauses');
const { normalizeEmailReplyCopy } = require('./email-reply-copy-normalizer');

const BILLING_WORDS = new Set([
  'bill', 'charge', 'cost', 'fee', 'invoice', 'payment', 'pay', 'price', 'amount', 'rate', 'surcharge', 'surcharges',
]);
const BILLING_VERBS = new Set(['bill', 'charge', 'invoice', 'pay', 'price']);
const BILLING_NOUNS = new Set(['bill', 'charge', 'cost', 'fee', 'invoice', 'payment', 'price', 'amount', 'rate', 'surcharge', 'surcharges']);
const SEPARATE_WORDS = new Set(['separately', 'individually']);
const CHARGE_NOUNS = new Set(['charge', 'fee', 'invoice', 'surcharge', 'surcharges']);
const APPLICATION_CONTINUATIONS = new Set(['after', 'before', 'when', 'while', 'with', 'without', 'including', 'excluding', 'plus', 'and', 'or', 'but', 'for', 'on', 'at', 'to', 'as']);

const isKind = (token, kind) => token?.kind === kind;
const isAmount = (token) => ['money', 'number'].includes(token?.kind);
const isWord = (token, ...words) => isKind(token, 'word') && words.includes(token.text);
const isVisit = (token) => ['visit', 'visits', 'eachVisit'].includes(token?.kind);
const isBareRecurringPassive = (visit, afterVerb) => ['eachVisit', 'visits'].includes(visit.kind)
  && (!afterVerb || isKind(afterVerb, 'sep'));
const isUnit = (token) => ['unit', 'visit', 'visits', 'eachVisit'].includes(token?.kind);
const isBillingWord = (token) => isKind(token, 'word') && BILLING_WORDS.has(token.text);
const isBillingVerb = (token) => isKind(token, 'word') && BILLING_VERBS.has(token.text);
const isBillingNoun = (token) => isKind(token, 'word') && BILLING_NOUNS.has(token.text);
const isChargeNoun = (token) => isKind(token, 'word') && CHARGE_NOUNS.has(token.text);
const isSeparate = (token) => isKind(token, 'word') && SEPARATE_WORDS.has(token.text);
const isApplicationObject = (tokens, at, separated) => isKind(tokens[at], 'application')
  && (!separated || /^(?:-?per\b|for\b|\/)/.test(tokens[at].text))
  && (!tokens[at + 1] || isKind(tokens[at + 1], 'sep')
    || (isKind(tokens[at + 1], 'word') && APPLICATION_CONTINUATIONS.has(tokens[at + 1].text))
    || (isWord(tokens[at + 1], 'only') && (!tokens[at + 2] || isKind(tokens[at + 2], 'sep'))));
const isRecipient = (token) => isWord(token, 'you', 'us', 'them', 'him', 'her', 'customer', 'customers', 'client', 'clients');
const isDeterminer = (token) => isWord(token, 'a', 'an', 'one', 'the', 'your', 'our', 'my', 'their', 'his', 'her', 'its', 'this', 'that', 'these', 'those', 'each', 'every', 'any');

function skipSeparators(tokens, from) {
  let next = from;
  while (isKind(tokens[next], 'sep')) next += 1;
  return next;
}

function skipCopulas(tokens, from) {
  let next = from;
  while (isKind(tokens[next], 'be')) next += 1;
  return next;
}

function skipSubject(tokens, from) {
  if (isWord(tokens[from], 'we', 'you', 'they', 'he', 'she', 'it', 'there')) return from + 1;
  const noun = isDeterminer(tokens[from]) ? from + 1 : from;
  return isWord(tokens[noun], 'customer', 'customers', 'client', 'clients') ? noun + 1 : from;
}

function skipRecipient(tokens, from) {
  if (isRecipient(tokens[from])) return from + 1;
  if (isDeterminer(tokens[from])
    && isWord(tokens[from + 1], 'account', 'customer', 'customers', 'client', 'clients')) return from + 2;
  return from;
}

function isFeedbackRate(tokens, at) {
  const object = isDeterminer(tokens[at + 1]) ? at + 2 : at + 1;
  return isWord(tokens[at], 'rate')
    && (isWord(tokens[at - 1], 'please') || isKind(tokens[at - 1], 'modal')
      || isWord(tokens[at + 1], 'how')
      || isWord(tokens[object], 'technician', 'technicians', 'service', 'services',
        'experience', 'experiences', 'appointment', 'appointments', 'it', 'them'));
}

function hasBillingUnit(tokens, at) {
  if (!isBillingWord(tokens[at]) || isFeedbackRate(tokens, at)) return false;
  let next = at + 1;
  if (isBillingVerb(tokens[at])) {
    const afterRecipient = skipRecipient(tokens, next);
    if (isWord(tokens[at], 'pay')
      && isKind(tokens[afterRecipient], 'visit')) return false;
    next = afterRecipient;
  }
  if (isWord(tokens[next], 'frequency')) next += 1;
  if (isKind(tokens[next], 'modal')) next += 1;
  if (isWord(tokens[next], 'not', 'never')) next += 1;
  if (isWord(tokens[next], 'do', 'does', 'did', 'has')) next += 1;
  if (isWord(tokens[next], 'not', 'never')) next += 1;
  next = skipCopulas(tokens, next);
  if (isWord(tokens[next], 'not', 'never')) next += 1;
  if (isWord(tokens[next], 'occur', 'apply')) next += 1;
  const afterSeparators = skipSeparators(tokens, next);
  const hasSeparator = afterSeparators !== next;
  next = afterSeparators;
  if (isWord(tokens[next], 'not', 'never')) next += 1;
  if (isWord(tokens[at], 'rate') && !isKind(tokens[next], 'unit')) return false;
  if (isVisit(tokens[next]) && !hasBillingObjectPredicate(tokens, next, true)) return false;
  return hasSeparator ? isKind(tokens[next], 'unit') : isUnit(tokens[next]);
}

function hasApplicationComplement(tokens, at) {
  let next = at + 1;
  if (isKind(tokens[next], 'modal')) next += 1;
  if (isWord(tokens[next], 'not', 'never')) return false;
  if (isWord(tokens[next], 'do', 'does', 'did', 'has')) next += 1;
  if (isWord(tokens[next], 'not', 'never')) return false;
  next = skipCopulas(tokens, next);
  if (isWord(tokens[next], 'not', 'never')) return false;
  if (isSeparate(tokens[next])) next += 1;
  if (isWord(tokens[next], 'apply', 'occur')) next += 1;
  next = skipSeparators(tokens, next);
  if (isWord(tokens[next], 'not', 'never')) return false;
  if (isWord(tokens[next], 'of', 'at')
    && isAmount(tokens[next + 1])) next += 1;
  if (isAmount(tokens[next])) next += 1;
  next = skipSeparators(tokens, next);
  if (isWord(tokens[next], 'not', 'never')) return false;
  return isApplicationObject(tokens, next, true);
}

function hasBillingObjectPredicate(tokens, at, passive) {
  if (hasApplicationComplement(tokens, at)) return false;
  let object = skipRecipient(tokens, at + 1);
  const recipient = object > at + 1;
  let separated = isKind(tokens[object], 'sep');
  object = skipSeparators(tokens, object);
  if (isSeparate(tokens[object])) object += 1;
  if (isWord(tokens[object], 'on') && isWord(tokens[object + 1], 'its', 'their')
    && isWord(tokens[object + 2], 'own')) object += 3;
  if (isDeterminer(tokens[object])) object += 1;
  if (isWord(tokens[object], 'own')) object += 1;
  if (isWord(tokens[object], 'separate', 'individual')) object += 1;
  const amount = isAmount(tokens[object]);
  if (amount) object += 1;
  separated = separated || isKind(tokens[object], 'sep');
  object = skipSeparators(tokens, object);
  if (isDeterminer(tokens[object])) object += 1;
  if (isWord(tokens[object], 'separate', 'individual')) object += 1;
  const noun = isBillingNoun(tokens[object]);
  const application = isApplicationObject(tokens, object, separated);
  if (application || (noun && hasApplicationComplement(tokens, object))) return false;
  return passive || recipient || amount || isKind(tokens[object], 'unit') || noun;
}

function hasInverseBillingUnit(tokens, at) {
  if (!isKind(tokens[at], 'unit')) return false;
  let next = skipSeparators(tokens, at + 1);
  const afterSubject = skipSubject(tokens, next);
  if (afterSubject !== next) {
    next = afterSubject;
    if (isKind(tokens[next], 'modal')) next += 1;
    if (isWord(tokens[next], 'not', 'never')) next += 1;
    if (isWord(tokens[next], 'do', 'does', 'did', 'has')) next += 1;
    if (isWord(tokens[next], 'not', 'never')) next += 1;
    const passive = isKind(tokens[next], 'be');
    if (passive) next = skipCopulas(tokens, next);
    if (isWord(tokens[next], 'not', 'never')) next += 1;
    if (isBillingVerb(tokens[next])) return hasBillingObjectPredicate(tokens, next, passive);
  }
  if (isDeterminer(tokens[next])) next += 1;
  if (isWord(tokens[next], 'separate', 'individual')) next += 1;
  if (!isBillingNoun(tokens[next]) || isFeedbackRate(tokens, next)) return false;
  if (isWord(tokens[next], 'amount') && isWord(tokens[next + 1], 'of')
    && isWord(tokens[next + 2], 'product', 'products')) {
    return isBillingNoun(tokens[next + 3]) && !hasApplicationComplement(tokens, next + 3);
  }
  if (isWord(tokens[next + 1], 'reminder', 'reminders', 'status', 'method', 'methods', 'detail', 'details')) {
    return isBillingNoun(tokens[next + 2]) && !hasApplicationComplement(tokens, next + 2);
  }
  return !hasApplicationComplement(tokens, next);
}

function hasSeparatePredicate(tokens, at) {
  if (!isVisit(tokens[at])) return false;
  let next = at + 1;
  if (isKind(tokens[next], 'modal')) next += 1;
  if (isWord(tokens[next], 'not', 'never')) next += 1;
  const separateBeforeCopula = isSeparate(tokens[next]);
  if (separateBeforeCopula) next += 1;
  if (!isKind(tokens[next], 'be')) return false;
  next = skipCopulas(tokens, next);
  if (isWord(tokens[next], 'not', 'never')) next += 1;
  if (separateBeforeCopula && isBillingVerb(tokens[next])) return hasBillingObjectPredicate(tokens, next, true);
  if (isSeparate(tokens[next]) && isBillingVerb(tokens[next + 1])) return hasBillingObjectPredicate(tokens, next + 1, true);
  if (!isBillingVerb(tokens[next])) return false;
  if (!hasBillingObjectPredicate(tokens, next, true)) return false;
  if (isBareRecurringPassive(tokens[at], tokens[next + 1])) return true;
  let object = next + 1;
  if (isWord(tokens[object], 'a', 'an')) {
    object += 1;
    if (isWord(tokens[object], 'separate', 'individual')) object += 1;
    return isChargeNoun(tokens[object]) && !hasApplicationComplement(tokens, object);
  }
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
    next = skipRecipient(tokens, next + 1);
  } else return false;
  return isKind(tokens[next], 'unit')
    || (['eachVisit', 'visits'].includes(tokens[next]?.kind)
      && hasBillingObjectPredicate(tokens, next, true));
}

function hasNominalBillingPredicate(tokens, at) {
  if (!isVisit(tokens[at])) return false;
  let next = at + 1;
  if (isKind(tokens[next], 'modal')) next += 1;
  if (isWord(tokens[next], 'not', 'never')) next += 1;
  if (isWord(tokens[next], 'do', 'does', 'did')
    || (isWord(tokens[next], 'has') && isWord(tokens[next + (isWord(tokens[next + 1], 'not', 'never') ? 2 : 1)], 'incur', 'generate', 'has'))) next += 1;
  if (isWord(tokens[next], 'not', 'never')) next += 1;
  const action = tokens[next]?.text;
  if (!isWord(tokens[next], 'has', 'incur', 'generate')) return false;
  next += 1;
  if (isWord(tokens[next], 'its', 'their')) {
    if (!isWord(tokens[next + 1], 'own')) return false;
    next += 2;
  } else if (isWord(tokens[next], 'a', 'an')) {
    next += 1;
    if (isWord(tokens[next], 'separate', 'individual')) next += 1;
    else if (action !== 'incur' && !['eachVisit', 'visits'].includes(tokens[at].kind)) return false;
  } else return false;
  return isChargeNoun(tokens[next]) && !hasApplicationComplement(tokens, next);
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
  const normalized = normalizeEmailReplyCopy(text);
  if (!normalized.ok) return { ok: false, violations: [normalized.reason] };
  if (/\[[^\[\]]*\]\([^\[\])]*\)|<\/?[a-z][^<>]*>/i.test(normalized.text)) {
    return { ok: false, violations: ['copy_markup'] };
  }
  const recognized = recognizeEmailReplyPricingClauses(normalized.text);
  if (!recognized.ok) return { ok: false, violations: [recognized.reason] };

  const blocked = commercialProposal !== true && recognized.clauses.some(hasBillingClaim);
  return { ok: !blocked, violations: blocked ? ['customer_copy_compliance'] : [] };
}

module.exports = { verifyEmailReplyBilling };
