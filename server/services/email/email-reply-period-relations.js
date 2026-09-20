const { recognizeEmailReplyPricingContext } = require('./email-reply-pricing-context');

// Positive evidence first (owner ruling 2026-09-19): a money amount in the same
// claim as a month/year period IS a plan-total claim. The only exclusions are a
// bare measurement, an amount already tied to a visit/application unit, and a
// bare number with no price cue. Account notices and activity cadence beside a
// money+period pair are findings for a reviewer, never silent allowances.
const BILLING_PREDICATES = new Set(['bill', 'charge', 'invoice', 'pay']);
const CLAIM_BREAK_WORDS = new Set(['and', 'or', 'but']);
const JOIN_WORDS = new Set(['the', 'a', 'an', 'our', 'your', 'my', 'their', 'his', 'her', 'its']);
const UNIT_FAMILY = { unit: 'visit', forVisit: 'visit', visit: 'visit', visits: 'visit',
  eachVisit: 'visit', application: 'application', period: 'period', timing: 'timing' };
const VISIT_FAMILIES = new Set(['visit', 'application']);
const isWord = (token, words) => token?.kind === 'word' && words.has(token.text);

function recognizeClause(clause) {
  const { tokens, phrases, contextPhrases, amountRelations, unitRelations, periodPhrases } = clause;
  const amountByStart = new Map(amountRelations.map((record) => [record.amount.start, record.amount]));
  const amountByEnd = new Map(amountRelations.map((record) => [record.amount.end, record.amount]));
  const periodByStart = new Map(periodPhrases.map((period) => [period.start, period]));
  const heads = phrases.filter((phrase) => phrase.type === 'billing_head');
  let anchors = [];
  const rolesIn = (from, to) => new Set(contextPhrases
    .filter((phrase) => phrase.start >= from && phrase.end <= to)
    .flatMap((phrase) => phrase.roles));
  const accountAt = (pos) => contextPhrases.some((phrase) => phrase.start === pos
    && !phrase.embedded && phrase.roles.includes('account'));
  // No price vocabulary of its own: a price label is a pricing-phrases
  // billing_head noun (or a dual-role head whose predicate carries priceCue)
  // that the pricing context does not also mark as account evidence.
  const cueAt = (pos) => phrases.some((phrase) => phrase.type === 'predicate'
    && phrase.headStart === pos && phrase.priceCue === true);
  const priceLabel = (phrase) => !!phrase && !accountAt(phrase.start)
    && (phrase.roles.includes('noun') || cueAt(phrase.start));
  // A bare number needs a price cue in its claim: any billing_head noun
  // (price or payment alike) or a priceCue predicate.
  const priceCueIn = (from, to) => heads.some((head) => head.start >= from && head.end <= to
    && (head.roles.includes('noun') || cueAt(head.start)))
    || phrases.some((phrase) => phrase.type === 'predicate' && phrase.priceCue === true
      && phrase.headStart >= from && phrase.headEnd <= to);

  // A visit token whose embedded period modifies a following plan word
  // ("monthly visit plan costs $98") is a period anchor, not a visit price.
  function embeddedPlanPeriod(pos) {
    const period = periodByStart.get(pos);
    return period?.embedded && rolesIn(pos + 1, pos + 2).has('plan') ? period : null;
  }
  function isPricingUnit(unit) {
    return unit.kind === 'unit' || unit.kind === 'forVisit'
      || /^(?:-?per\b|for\b|each\b|every\b|a\b|\/)/.test(unit.text);
  }
  // A unit before the amount ties it; a unit after the amount only ties it
  // when it is a genuine pricing unit ("$98 per visit"), never across a comma.
  const connectorHasComma = (connector) => !!connector
    && tokens.slice(connector.start, connector.end).some((token) => token.kind === 'sep' && token.text === ',');
  function tiedToUnit(amount) {
    return unitRelations.some((record) => VISIT_FAMILIES.has(UNIT_FAMILY[record.unit.kind])
      && !embeddedPlanPeriod(record.unit.start)
      && record.candidates.some((candidate) => {
        if (candidate.amount !== amount || connectorHasComma(candidate.connector)) return false;
        return record.unit.start < amount.start || isPricingUnit(record.unit);
      }));
  }
  function bareMeasurement(amount) {
    return amount.kind === 'number'
      && contextPhrases.some((phrase) => phrase.roles.includes('measurement') && phrase.start === amount.end);
  }

  // Claim boundaries: a barrier, a visit/application unit, or a comma /
  // and / or / but ends a claim, except for three bounded continuations.
  function frontedPeriodComma(claimStart, at) {
    return periodPhrases.some((period) => period.start === claimStart && period.end === at);
  }
  // "For the monthly plan, the price is $98": a bounded fronted plan phrase
  // may keep its comma when a pricing copula continues right after it.
  function frontedPlanComma(claimStart, at) {
    if (at - claimStart > 4 || !isWord(tokens[claimStart], new Set(['for']))) return false;
    let pos = claimStart + 1;
    if (isWord(tokens[pos], JOIN_WORDS)) pos += 1;
    const period = periodByStart.get(pos);
    if (!period || period.end + 1 !== at || !rolesIn(period.end, at).has('plan')) return false;
    pos = at + 1;
    if (isWord(tokens[pos], JOIN_WORDS)) pos += 1;
    return (priceLabel(heads.find((head) => head.start === pos)) || rolesIn(pos, pos + 1).has('plan'))
      && tokens[pos + 1]?.kind === 'be';
  }
  // "$98 and is billed monthly", "$98, and it is billed monthly": an amount
  // may keep a comma/and before a bounded [pronoun] [copula] billing
  // predicate + period; independent facts still break the claim.
  function continuesPrice(at) {
    let next = at + 1;
    let amountEnd = at;
    if (isWord(tokens[at], new Set(['and']))) {
      if (tokens[at - 1]?.kind === 'sep' && tokens[at - 1].text === ',') amountEnd = at - 1;
    } else if (!(tokens[at].kind === 'sep' && tokens[at].text === ',')) return false;
    if (isWord(tokens[next], new Set(['and']))) next += 1;
    const participant = phrases.find((phrase) => phrase.type === 'participant' && phrase.start === next);
    if (participant) next = participant.end;
    if (tokens[next]?.kind === 'be') next += 1;
    return !!amountByEnd.get(amountEnd) && isWord(tokens[next], BILLING_PREDICATES)
      && !!periodByStart.get(next + 1);
  }
  // "The plan is billed monthly and costs $98": when the claim so far holds a
  // period and no amount, "and" may continue into a bounded [pronoun]
  // [copula] price predicate whose amount follows within four tokens.
  function continuesPeriod(at) {
    if (!anchors.some((anchor) => anchor.kind === 'period') || anchors.some((anchor) => anchor.kind === 'amount')) return false;
    let next = at + 1;
    const participant = phrases.find((phrase) => phrase.type === 'participant' && phrase.start === next);
    if (participant) next = participant.end;
    if (tokens[next]?.kind === 'be') next += 1;
    const cue = cueAt(next) || (heads.find((head) => head.start === next) && priceLabel(heads.find((head) => head.start === next)));
    if (!cue) return false;
    for (let pos = next + 1; pos <= next + 4 && pos < tokens.length; pos += 1) if (amountByStart.has(pos)) return true;
    return false;
  }
  function breaksClaim(claimStart, at) {
    const token = tokens[at];
    if (token.kind === 'barrier') return true;
    if (VISIT_FAMILIES.has(UNIT_FAMILY[token.kind])) return !embeddedPlanPeriod(at);
    if (token.kind === 'sep' && token.text === ',') {
      return !frontedPeriodComma(claimStart, at) && !frontedPlanComma(claimStart, at) && !continuesPrice(at);
    }
    return isWord(token, CLAIM_BREAK_WORDS) && !(token.text === 'and' && (continuesPrice(at) || continuesPeriod(at)));
  }

  function classify(amount, from, to) {
    if (bareMeasurement(amount)) return { relation: 'excluded', reason: 'bare_measurement' };
    if (tiedToUnit(amount)) return { relation: 'excluded', reason: 'visit_tied' };
    if (amount.kind === 'money') return { relation: 'plan_total', reason: 'money_period_claim' };
    return priceCueIn(from, to)
      ? { relation: 'plan_total', reason: 'bare_number_price_cue' }
      : { relation: 'excluded', reason: 'no_price_cue' };
  }

  const periodRelations = [];
  let claimStart = 0;
  anchors = [];
  // Anchors are bounded by claim breaks, so only adjacent, differing-type pairs
  // are ever compared; each token is inspected a constant number of times.
  for (let at = 0; at <= tokens.length; at += 1) {
    if (at < tokens.length && !breaksClaim(claimStart, at)) {
      const amount = amountByStart.get(at);
      const period = periodByStart.get(at);
      if (amount) anchors.push({ kind: 'amount', pos: at, data: amount });
      else if (period && (!period.embedded || embeddedPlanPeriod(at))) anchors.push({ kind: 'period', pos: at, data: period });
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
      const result = classify(amountAnchor.data, from, to);
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
