const { recognizeEmailReplyPricingClauses } = require('./email-reply-pricing-clauses');

// These are canonical scanner words, not raw-copy patterns. The finite policy
// joins a price amount to a month/year token only inside one clause.
const PRICE_WORDS = new Set([
  'price', 'cost', 'fee', 'rate', 'charge', 'bill', 'invoice', 'amount', 'total', 'run',
]);
const PLAN_WORDS = new Set(['plan', 'program', 'package']);
const ACCOUNT_WORDS = new Set([
  'account', 'balance', 'payment', 'refund', 'credit', 'deposit', 'receipt',
  'received', 'pay', 'due',
]);
const UNIT_KINDS = new Set(['unit', 'application', 'forVisit', 'eachVisit', 'visit', 'visits']);
const JOIN_WORDS = new Set(['the', 'a', 'an', 'our', 'your', 'my', 'their', 'his', 'her', 'its']);
const GAP_STOP_WORDS = new Set(['and', 'or', 'but', 'account', 'balance', 'payment', 'refund', 'credit']);
const PERIOD_ACTIVITY_WORDS = new Set(['reminders', 'updates', 'schedule', 'scheduling', 'appointments']);
const CLAIM_BREAK_WORDS = new Set(['and', 'or', 'but']);
const isWord = (token, words) => token.kind === 'word' && words.has(token.text);
const isAmount = (token) => token.kind === 'money' || token.kind === 'number';

function tiedToVisitOrApplication(clause, at) {
  if (UNIT_KINDS.has(clause[at + 1]?.kind)) return true;
  if (clause[at + 1]?.kind === 'sep' && UNIT_KINDS.has(clause[at + 2]?.kind)) return true;
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

function breaksClaim(token) {
  return token.kind === 'barrier' || token.kind === 'period' || isAmount(token)
    || UNIT_KINDS.has(token.kind) || (token.kind === 'sep' && token.text === ',')
    || isWord(token, CLAIM_BREAK_WORDS);
}

function claimContext(clause, first, last) {
  let start = first;
  let end = last;
  while (start > 0 && first - start < 5 && !breaksClaim(clause[start - 1])) start -= 1;
  while (end + 1 < clause.length && end - last < 4 && !breaksClaim(clause[end + 1])) end += 1;
  return clause.slice(start, end + 1);
}

function isPlanTotalPair(clause, amountAt, periodAt) {
  if (Math.abs(amountAt - periodAt) > 5) return false;
  const amount = clause[amountAt];
  const period = clause[periodAt];
  if (/^(?:monthly|yearly|annual|annually)$/.test(period.text)
    && isWord(clause[periodAt + 1] || {}, PERIOD_ACTIVITY_WORDS)) return false;
  const first = Math.min(amountAt, periodAt);
  const last = Math.max(amountAt, periodAt);
  const gap = clause.slice(first + 1, last);
  if (gap.some((token) => token.kind === 'barrier' || UNIT_KINDS.has(token.kind)
    || token.kind === 'period' || isAmount(token) || isWord(token, GAP_STOP_WORDS))) return false;

  const context = claimContext(clause, first, last);
  const priceCue = context.some((token) => isWord(token, PRICE_WORDS));
  if (amount.kind === 'number') return priceCue;
  const planCue = context.some((token) => isWord(token, PLAN_WORDS));
  const accountOnly = context.some((token) => isWord(token, ACCOUNT_WORDS))
    && !priceCue && !planCue;
  const direct = gap.every((token) => token.kind === 'sep');
  if (direct && /^(?:\/|per\b)/.test(period.text)) return true;
  return !accountOnly && (direct || priceCue || planCue);
}

function containsPlanTotal(clause) {
  for (let amountAt = 0; amountAt < clause.length; amountAt += 1) {
    if (!isAmount(clause[amountAt]) || tiedToVisitOrApplication(clause, amountAt)) continue;
    for (let periodAt = Math.max(0, amountAt - 5);
      periodAt <= Math.min(clause.length - 1, amountAt + 5); periodAt += 1) {
      if (clause[periodAt].kind === 'period'
        && isPlanTotalPair(clause, amountAt, periodAt)) return true;
    }
  }
  return false;
}

function verifyEmailReplyPlanTotal({ text = '', commercialProposal = false, legacyMonthlyPlan = false } = {}) {
  const recognized = recognizeEmailReplyPricingClauses(text);
  if (!recognized.ok) return { ok: false, violations: [recognized.reason] };
  if (commercialProposal === true || legacyMonthlyPlan === true) return { ok: true, violations: [] };
  const violations = recognized.clauses.some(containsPlanTotal) ? ['customer_copy_compliance'] : [];
  return { ok: violations.length === 0, violations };
}

module.exports = { verifyEmailReplyPlanTotal };
