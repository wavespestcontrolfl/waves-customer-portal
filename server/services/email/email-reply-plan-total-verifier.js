const { recognizeEmailReplyPricingClauses } = require('./email-reply-pricing-clauses');

// These are canonical scanner words, not raw-copy patterns. The finite policy
// joins a price amount to a month/year token only inside one clause.
const PRICE_WORDS = new Set([
  'price', 'cost', 'fee', 'rate', 'charge', 'bill', 'invoice', 'amount', 'total', 'run',
  'dues', 'subscription',
]);
const PLAN_WORDS = new Set(['plan', 'program', 'package']);
const PRICING_LABEL_WORDS = new Set([...PRICE_WORDS, ...PLAN_WORDS]);
const PRICE_QUALIFIER = '(?:only|just|about|around|approximately|roughly|exactly|nearly|almost|up to|at least|as low as)';
const PRICE_HEAD = `(?:${[...PRICE_WORDS].join('|')}|(?:${[...PRICING_LABEL_WORDS].join('|')}) <(?:be|pastBe)>)`;
const QUALIFIED_END = `(?: ${PRICE_QUALIFIER}){0,3}(?: <sep>)?$`;
const PRICE_LABEL = new RegExp(`(?:^| )${PRICE_HEAD}${QUALIFIED_END}`);
const PAYMENT_LABEL = new RegExp(`(?:^| )payment <be>(?: <period>)?${QUALIFIED_END}`);
const BE_AMOUNT = new RegExp(`(?:^| )<(?:be|pastBe)>${QUALIFIED_END}`);
const PAYMENT_SUFFIX = /^<(?:money|number)> <be> (?:the |our |your |a )?(?:<period> payment|payment <period>)(?: |$)/;
const PRICE_SUFFIX = new RegExp(`^<(?:money|number)> <(?:be|pastBe)> (?:the |our |your |a )?(?:<period> (?:${[...PRICING_LABEL_WORDS].join('|')})|(?:${[...PRICING_LABEL_WORDS].join('|')}) <period>)(?: |$)`);
const ACCOUNT_WORDS = new Set([
  'account', 'balance', 'payment', 'refund', 'credit', 'deposit', 'receipt',
  'received', 'pay', 'due',
]);
const UNIT_KINDS = new Set(['unit', 'application', 'forVisit', 'eachVisit', 'visit', 'visits']);
const JOIN_WORDS = new Set(['the', 'a', 'an', 'our', 'your', 'my', 'their', 'his', 'her', 'its']);
const ACCOUNT_EVENTS = new Set(['posted', 'cleared', 'received', 'refunded', 'credited', 'pay']);
const PERIOD_ACTIVITY_WORDS = new Set([
  'reminder', 'reminders', 'update', 'updates', 'schedule', 'scheduling', 'appointment', 'appointments',
]);
const CLAIM_BREAK_WORDS = new Set(['and', 'or', 'but']);
const PERIOD_DETERMINERS = new Set(['a', 'each', 'every']);
const PERIOD_NOUNS = new Set(['month', 'mo', 'year', 'yr']);
const isWord = (token, words) => token?.kind === 'word' && words.has(token.text);
const isAmount = (token) => token.kind === 'money' || token.kind === 'number';

function canonicalToken(token) {
  if (token.kind === 'word') return token.text;
  if (token.kind === 'be' && /^(?:was|were|had been)$/.test(token.text)) return '<pastBe>';
  return `<${token.kind}>`;
}

function withDeterminedPeriods(clause) {
  const tokens = [];
  for (let index = 0; index < clause.length; index += 1) {
    if (isWord(clause[index], PERIOD_DETERMINERS)
      && isWord(clause[index + 1] || {}, PERIOD_NOUNS)
      && !(clause[index].text === 'a' && clause[index + 2]?.kind === 'word'
        && clause[index + 2].text === 'ago')) {
      tokens.push({ kind: 'period', text: `${clause[index].text} ${clause[index + 1].text}` });
      index += 1;
    } else tokens.push(clause[index]);
  }
  return tokens;
}

function isPricingUnit(token) {
  return token?.kind === 'unit' || token?.kind === 'forVisit'
    || (UNIT_KINDS.has(token?.kind) && /^(?:-?per\b|for\b|each\b|every\b|a\b|\/)/.test(token.text));
}

function tiedToVisitOrApplication(clause, at) {
  if (isPricingUnit(clause[at + 1])) return true;
  if (clause[at + 1]?.kind === 'sep' && clause[at + 1].text !== ','
    && isPricingUnit(clause[at + 2])) return true;
  for (let index = Math.max(0, at - 4); index < at; index += 1) {
    if (!UNIT_KINDS.has(clause[index].kind)) continue;
    const between = clause.slice(index + 1, at);
    if (between.every((token) => token.kind === 'be'
      || (token.kind === 'sep' && token.text !== ',')
      || token.kind === 'possessive' || isWord(token, PRICE_WORDS)
      || isWord(token, JOIN_WORDS))) return true;
  }
  return false;
}

function breaksClaim(clause, at, start) {
  const token = clause[at];
  const frontedPeriod = at - 1 === start && clause[at - 1]?.kind === 'period'
    && /^(?:monthly|yearly|annually)$/.test(clause[at - 1].text);
  return token.kind === 'barrier' || UNIT_KINDS.has(token.kind)
    || (token.kind === 'sep' && token.text === ',' && !frontedPeriod)
    || isWord(token, CLAIM_BREAK_WORDS);
}

function periodDescribesActivity(clause, at) {
  if (!/^(?:monthly|yearly|annual|annually)$/.test(clause[at].text)) return false;
  // At most four ordinary modifiers may precede a cadence/activity noun.
  for (let index = at + 1; index <= at + 5 && index < clause.length; index += 1) {
    const token = clause[index];
    if (isWord(token, PERIOD_ACTIVITY_WORDS)) {
      const predicate = clause[index + 1]?.kind === 'be' ? clause[index + 2] : clause[index + 1];
      return !isWord(predicate || {}, PRICE_WORDS);
    }
    if (token.kind !== 'word' || isWord(token, PRICE_WORDS)
      || isWord(token, PLAN_WORDS) || isWord(token, ACCOUNT_WORDS)) break;
  }
  return false;
}

function isPlanTotalPair(clause, amountAt, periodAt, context, legacyMonthlyPlan) {
  const amount = clause[amountAt];
  const period = clause[periodAt];
  if (legacyMonthlyPlan === true && /\b(?:mos?|months?|monthly)\b/.test(period.text)) return false;
  if (periodDescribesActivity(clause, periodAt)) return false;
  const first = Math.min(amountAt, periodAt);
  const last = Math.max(amountAt, periodAt);
  const gap = clause.slice(first + 1, last);
  const accountEvent = context.some((token) => isWord(token, ACCOUNT_EVENTS));
  // Payment copulas must join the amount through this finite grammar, rather
  // than describe a posted/received event. Prefix and suffix scans are bounded.
  const amountLabel = clause.slice(Math.max(0, amountAt - 13), amountAt).map(canonicalToken).join(' ');
  const amountTail = clause.slice(amountAt, amountAt + 5).map(canonicalToken).join(' ');
  if (PAYMENT_LABEL.test(amountLabel) || PAYMENT_SUFFIX.test(amountTail)) return true;
  const priceCue = context.some((token) => isWord(token, PRICE_WORDS));
  const planCue = context.some((token) => isWord(token, PLAN_WORDS));
  const direct = gap.every((token) => token.kind === 'sep');
  if (amount.kind === 'money' && direct && /^(?:\/|per\b|a\b|each\b|every\b)/.test(period.text)) return true;
  const assertionLabels = amountAt < periodAt ? [...gap, clause[periodAt + 1] || {}] : gap;
  const assertedPrice = PRICE_LABEL.test(amountLabel) || PRICE_SUFFIX.test(amountTail)
    || (BE_AMOUNT.test(amountLabel)
      && assertionLabels.some((token) => isWord(token, PRICING_LABEL_WORDS)));
  if (accountEvent && !assertedPrice) return false;
  if (amount.kind === 'number') return priceCue;
  return priceCue || planCue || (direct && !context.some((token) => isWord(token, ACCOUNT_WORDS)));
}

function containsPlanTotal(clause, legacyMonthlyPlan) {
  let start = 0;
  let anchors = [];
  // Only adjacent amount/period anchors can pair. Context stops at neighboring
  // anchors or claim boundaries, so every token is examined a constant number
  // of times instead of rescanning the clause for every amount/period pair.
  for (let end = 0; end <= clause.length; end += 1) {
    if (end < clause.length && !breaksClaim(clause, end, start)) {
      if (isAmount(clause[end]) || clause[end].kind === 'period') anchors.push(end);
      continue;
    }
    for (let pair = 1; pair < anchors.length; pair += 1) {
      const first = anchors[pair - 1];
      const last = anchors[pair];
      if (isAmount(clause[first]) === isAmount(clause[last])) continue;
      const amountAt = isAmount(clause[first]) ? first : last;
      const periodAt = amountAt === first ? last : first;
      if (tiedToVisitOrApplication(clause, amountAt)) continue;
      const context = clause.slice(pair > 1 ? anchors[pair - 2] + 1 : start,
        pair + 1 < anchors.length ? anchors[pair + 1] : end);
      if (isPlanTotalPair(clause, amountAt, periodAt, context, legacyMonthlyPlan)) return true;
    }
    start = end + 1;
    anchors = [];
  }
  return false;
}

function verifyEmailReplyPlanTotal({ text = '', commercialProposal = false, legacyMonthlyPlan = false } = {}) {
  const recognized = recognizeEmailReplyPricingClauses(text);
  if (!recognized.ok) return { ok: false, violations: [recognized.reason] };
  if (commercialProposal === true) return { ok: true, violations: [] };
  const violations = recognized.clauses.some((clause) => containsPlanTotal(withDeterminedPeriods(clause), legacyMonthlyPlan))
    ? ['customer_copy_compliance'] : [];
  return { ok: violations.length === 0, violations };
}

module.exports = { verifyEmailReplyPlanTotal };
