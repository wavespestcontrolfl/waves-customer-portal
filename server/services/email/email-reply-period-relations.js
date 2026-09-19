const { recognizeEmailReplyPricingContext } = require('./email-reply-pricing-context');

// No price vocabulary of its own: a price label is a pricing-phrases
// billing_head noun (or a predicate carrying its priceCue) that the pricing
// context does not also mark as account evidence (payment, balance, pay).
const PAYMENT_ACTIONS = new Set(['total', 'totals', 'equal', 'equals', 'come to']);
const BILLING_PREDICATES = new Set(['bill', 'charge', 'invoice', 'pay']);
const CLAIM_BREAK_WORDS = new Set(['and', 'or', 'but']);
const JOIN_WORDS = new Set(['the', 'a', 'an', 'our', 'your', 'my', 'their', 'his', 'her', 'its']);
const ACTIVITY_PERIOD_FORMS = new Set(['monthly', 'yearly', 'annual', 'annually', 'annualized']);
const UNIT_FAMILY = { unit: 'visit', forVisit: 'visit', visit: 'visit', visits: 'visit',
  eachVisit: 'visit', application: 'application', period: 'period', timing: 'timing' };
const VISIT_FAMILIES = new Set(['visit', 'application']);
const isWord = (token, words) => token?.kind === 'word' && words.has(token.text);
const isPastCopula = (token) => /^(?:was|were|had been)$/i.test(token?.text ?? '');

function recognizeClause(clause) {
  const { tokens, phrases, contextPhrases, amountRelations, unitRelations, periodPhrases } = clause;
  const amountByStart = new Map(amountRelations.map((record) => [record.amount.start, record]));
  const amountByEnd = new Map(amountRelations.map((record) => [record.amount.end, record.amount]));
  const periodByStart = new Map(periodPhrases.map((period) => [period.start, period]));
  const heads = phrases.filter((phrase) => phrase.type === 'billing_head');
  const participants = phrases.filter((phrase) => phrase.type === 'participant');
  const headAt = (pos) => heads.find((head) => head.start === pos);
  const rolesIn = (from, to) => new Set(contextPhrases
    .filter((phrase) => phrase.start >= from && phrase.end <= to)
    .flatMap((phrase) => phrase.roles));
  const accountAt = (pos) => contextPhrases.some((phrase) => phrase.start === pos
    && !phrase.embedded && phrase.roles.includes('account'));
  // A dual-role head such as "run"/"charge" is a price label through the
  // predicate candidate pricing-phrases emits at the same start (priceCue).
  const cueAt = (pos) => phrases.some((phrase) => phrase.type === 'predicate'
    && phrase.headStart === pos && phrase.priceCue === true);
  const priceLabel = (phrase) => !!phrase && !accountAt(phrase.start)
    && (phrase.type === 'billing_head' ? (phrase.roles.includes('noun') || cueAt(phrase.start))
      : phrase.priceCue === true);
  const priceHeadIn = (from, to) => heads.some((head) => head.start >= from && head.end <= to
    && priceLabel(head));

  // A unit before the amount always ties it; a unit after the amount only ties
  // it when the unit itself is a genuine pricing unit (per/each/every/for/a/-)
  // or directly adjacent — a colon/dash/comma before an unrelated plural noun
  // ("$98: applications are scheduled separately") does not shield the amount.
  function isPricingUnit(unit) {
    return unit.kind === 'unit' || unit.kind === 'forVisit'
      || /^(?:-?per\b|for\b|each\b|every\b|a\b|\/)/.test(unit.text);
  }
  function tiedToUnit(amount) {
    return unitRelations.some((record) => VISIT_FAMILIES.has(UNIT_FAMILY[record.unit.kind])
      && record.candidates.some((candidate) => {
        if (candidate.amount !== amount || candidate.connector?.text === ',') return false;
        return record.unit.start < amount.start || isPricingUnit(record.unit);
      }));
  }
  function bareMeasurement(amount) {
    return amount.kind === 'number'
      && contextPhrases.some((phrase) => phrase.roles.includes('measurement') && phrase.start === amount.end);
  }
  function directGap(gap) {
    return gap.every((token) => token.kind === 'sep' || token.kind === 'be')
      && gap.filter((token) => token.kind === 'be').length <= 1;
  }
  function explicitCurrencyPeriod(amount, period, gap) {
    return amount.kind === 'money' && directGap(gap)
      && (/^(?:\/|per\b|a\b|each\b|every\b)/.test(period.text) || gap.some((token) => token.kind === 'be'));
  }
  // A period noun/copula suffix ("$98 is the monthly PRICE") sits between the copula
  // and the noun, which the generic amount-relations copula scan does not traverse.
  function suffixNounAfterPeriod(amount, period) {
    if (amount.end > period.start) return null;
    const gap = tokens.slice(amount.end, period.start);
    const bare = gap.length === 1 && gap[0].kind === 'be';
    const withDeterminer = gap.length === 2 && gap[0].kind === 'be' && isWord(gap[1], JOIN_WORDS);
    return bare || withDeterminer ? headAt(period.end) ?? null : null;
  }
  // Walks back through a CHAINED run of qualifier phrases (pricing-phrases only
  // links one hop at a time, e.g. "just" then "about" as two separate spans)
  // and one optional separator, so a multi-qualifier label still resolves.
  function skipQualifiers(pos) {
    let at = pos;
    if (tokens[at - 1]?.kind === 'sep') at -= 1;
    for (let q = phrases.find((p) => p.type === 'qualifier' && p.end === at); q;
      q = phrases.find((p) => p.type === 'qualifier' && p.end === at)) at = q.start;
    return at;
  }
  function activityCadence(period) {
    if (!ACTIVITY_PERIOD_FORMS.has(period.text)) return false;
    let activity = -1;
    for (let index = period.end; index < Math.min(tokens.length, period.end + 5); index += 1) {
      const roles = rolesIn(index, index + 1);
      if (roles.has('activity')) { activity = index; continue; }
      if (tokens[index].kind !== 'word' || priceLabel(headAt(index))
        || roles.has('plan') || roles.has('account')) break;
    }
    if (activity < 0) return false;
    const next = tokens[activity + 1]?.kind === 'be' ? activity + 2 : activity + 1;
    return !priceLabel(headAt(next));
  }
  // The head or bare copula immediately before the amount, chasing the same
  // qualifier chain: {head} for a predicate/billing_head label, or
  // {copulaAt, present} for a bare copula ("was"/"were"/"had been" are past).
  function labelBefore(amountStart) {
    const at = skipQualifiers(amountStart);
    const head = phrases.find((phrase) => (phrase.type === 'predicate' || phrase.type === 'billing_head')
      && phrase.end === at);
    if (head) return { head: head.head, phrase: head };
    if (tokens[at - 1]?.kind !== 'be') return null;
    return { copulaAt: at - 1, present: !isPastCopula(tokens[at - 1]) };
  }
  // "Your payment is monthly exactly $98" — the payment label's optional period
  // sits between the copula and any qualifiers, ahead of the amount itself.
  function paymentPeriodOrder(amount, period) {
    if (skipQualifiers(amount.start) !== period.end) return false;
    const copula = tokens[period.start - 1];
    return copula?.kind === 'be' && !isPastCopula(copula)
      && headAt(period.start - 2)?.head === 'payment';
  }
  function paymentAssertion(amount, period) {
    if (paymentPeriodOrder(amount, period)) return true;
    const record = amountByStart.get(amount.start);
    const asserted = record?.candidates.some((candidate) => {
      const { anchor } = candidate;
      if (candidate.relation === 'predicate_amount' && anchor.head === 'pay') {
        return participants.some((participant) => participant.end === anchor.start);
      }
      if (candidate.relation === 'predicate_amount' && PAYMENT_ACTIONS.has(anchor.head)) {
        return headAt(anchor.start - 1)?.head === 'payment';
      }
      if (candidate.relation === 'amount_head' && anchor.head === 'payment') {
        return !isPastCopula(tokens[amount.end]);
      }
      return false;
    });
    if (asserted) return true;
    const label = labelBefore(amount.start);
    if (label?.present && headAt(label.copulaAt - 1)?.head === 'payment') return true;
    const suffix = suffixNounAfterPeriod(amount, period);
    return suffix?.head === 'payment' && !isPastCopula(tokens[amount.end]);
  }
  function assertedPriceLabel(amount, period, claimStart) {
    const label = labelBefore(amount.start);
    if (label?.phrase && priceLabel(label.phrase)) return true;
    const suffix = suffixNounAfterPeriod(amount, period);
    if (priceLabel(suffix)) return true;
    if (!label || label.head) return false;
    return priceHeadIn(claimStart, label.copulaAt) || rolesIn(claimStart, label.copulaAt).has('plan');
  }

  function pricingStartsAt(from, bound) {
    let pos = from;
    if (isWord(tokens[pos], JOIN_WORDS)) pos += 1;
    if (!(priceLabel(headAt(pos)) || rolesIn(pos, pos + 1).has('plan'))) return false;
    return tokens[pos + 1]?.kind === 'be' && pos + 2 <= bound;
  }
  function frontedPeriodComma(claimStart, at) {
    return periodPhrases.some((period) => period.start === claimStart && period.end === at);
  }
  // "For the monthly plan, the price is $98" — a bounded fronted plan phrase
  // may retain its comma when a pricing copula continues right after it.
  function frontedPlanComma(claimStart, at) {
    if (at - claimStart > 4 || !isWord(tokens[claimStart], new Set(['for']))) return false;
    let pos = claimStart + 1;
    if (isWord(tokens[pos], JOIN_WORDS)) pos += 1;
    const period = periodByStart.get(pos);
    if (!period || period.end + 1 !== at || !rolesIn(period.end, at).has('plan')) return false;
    return pricingStartsAt(at + 1, at + 5);
  }
  // An asserted price may retain "and is billed monthly" or a comma before the
  // same billing predicate + period; independent facts still break the claim.
  function continuesPrice(claimStart, at) {
    let next = at + 1;
    if (isWord(tokens[at], new Set(['and']))) {
      if (tokens[next]?.kind === 'be') next += 1;
    } else if (!(tokens[at].kind === 'sep' && tokens[at].text === ',')) return false;
    const amount = amountByEnd.get(at);
    const period = periodByStart.get(next + 1);
    if (!amount || !period || !isWord(tokens[next], BILLING_PREDICATES)) return false;
    return assertedPriceLabel(amount, period, claimStart) || paymentAssertion(amount, period);
  }
  function breaksClaim(claimStart, at) {
    const token = tokens[at];
    if (token.kind === 'barrier') return true;
    if (VISIT_FAMILIES.has(UNIT_FAMILY[token.kind])) return true;
    if (token.kind === 'sep' && token.text === ',') {
      return !frontedPeriodComma(claimStart, at) && !frontedPlanComma(claimStart, at)
        && !continuesPrice(claimStart, at);
    }
    return isWord(token, CLAIM_BREAK_WORDS) && !(token.text === 'and' && continuesPrice(claimStart, at));
  }

  function classify(amount, period, gap, claimStart, from, to) {
    if (bareMeasurement(amount)) return { relation: 'excluded', reason: 'bare_measurement' };
    if (tiedToUnit(amount)) return { relation: 'excluded', reason: 'visit_tied' };
    if (activityCadence(period)) return { relation: 'excluded', reason: 'activity_cadence' };
    if (paymentAssertion(amount, period)) return { relation: 'plan_total', reason: 'payment_assertion' };
    if (explicitCurrencyPeriod(amount, period, gap)) return { relation: 'plan_total', reason: 'direct_currency_period' };
    const roles = rolesIn(from, to);
    const accountEvent = roles.has('account_event');
    if (accountEvent && !assertedPriceLabel(amount, period, claimStart)) {
      return { relation: 'excluded', reason: 'account_event' };
    }
    const priceCue = priceHeadIn(from, to);
    if (amount.kind === 'number') {
      return priceCue ? { relation: 'plan_total', reason: 'bare_number_price_cue' }
        : { relation: 'excluded', reason: 'no_price_cue' };
    }
    if (priceCue) return { relation: 'plan_total', reason: 'price_cue' };
    if (roles.has('plan')) return { relation: 'plan_total', reason: 'plan_cue' };
    if (directGap(gap) && !roles.has('account')) return { relation: 'plan_total', reason: 'direct_gap' };
    return { relation: 'excluded', reason: 'no_price_cue' };
  }

  const periodRelations = [];
  let claimStart = 0;
  let anchors = [];
  // Anchors are bounded by claim breaks, so only adjacent, differing-type pairs
  // are ever compared; each token is inspected a constant number of times.
  for (let at = 0; at <= tokens.length; at += 1) {
    if (at < tokens.length && !breaksClaim(claimStart, at)) {
      const amount = amountByStart.get(at)?.amount;
      const period = periodByStart.get(at);
      if (amount) anchors.push({ kind: 'amount', pos: at, data: amount });
      else if (period) anchors.push({ kind: 'period', pos: at, data: period });
      continue;
    }
    for (let pair = 1; pair < anchors.length; pair += 1) {
      const previous = anchors[pair - 1];
      const current = anchors[pair];
      if (previous.kind === current.kind) continue;
      const amountAnchor = previous.kind === 'amount' ? previous : current;
      const periodAnchor = previous.kind === 'period' ? previous : current;
      const [earlier, later] = amountAnchor.pos < periodAnchor.pos
        ? [amountAnchor, periodAnchor] : [periodAnchor, amountAnchor];
      const gap = tokens.slice(earlier.data.end, later.pos);
      const from = pair > 1 ? anchors[pair - 2].data.end : claimStart;
      const to = pair + 1 < anchors.length ? anchors[pair + 1].pos : at;
      const result = classify(amountAnchor.data, periodAnchor.data, gap, claimStart, from, to);
      periodRelations.push({
        amount: amountAnchor.data,
        period: periodAnchor.data,
        relation: result.relation,
        connector: gap.length ? { start: earlier.data.end, end: later.pos,
          text: gap.map((token) => token.text).join(' ') } : null,
        claim: { start: claimStart, end: at },
        context: { roles: [...rolesIn(from, to)] },
        evidence: { reason: result.reason },
      });
    }
    claimStart = at + 1;
    anchors = [];
  }
  return { ...clause, periodRelations };
}

// Every record is evidence describing why an amount/period anchor pair does or
// does not read as a plan-total claim; this module never returns a verdict.
function recognizeEmailReplyPeriodRelations(text = '') {
  const result = recognizeEmailReplyPricingContext(text);
  if (!result.ok) return result;
  return { ...result, disposition: 'needs_review', clauses: result.clauses.map(recognizeClause) };
}

module.exports = { recognizeEmailReplyPeriodRelations };
