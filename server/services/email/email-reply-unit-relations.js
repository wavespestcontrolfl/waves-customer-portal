const { recognizeEmailReplyAmountRelations } = require('./email-reply-amount-relations');

const UNITS = new Set(['unit', 'application', 'timing', 'forVisit', 'eachVisit', 'visits', 'visit', 'period']);
const SINGLE_GAPS = [new Set(['sep::', 'sep:-', 'sep:,', 'be']), new Set(['sep::', 'sep:-'])];
const ARTICLES = new Set(['a', 'an']);
const NOMINAL_DETERMINERS = new Set(['the', 'our', 'your', 'a', 'an']);
const NEGATIONS = new Set(['not', 'never']);
const TAX_HEADS = new Set(['tax', 'taxes', 'fee']);
const TRAILING_PREDICATES = new Set(['apply', 'occur', 'due', 'required', 'payable']);
const RANGE_INTRODUCERS = new Set(['from', 'between']);
const wordIn = (token, words) => token?.kind === 'word' && words.has(token.text);

function nominal(chosen) {
  return chosen.anchor?.anchor.type === 'billing_head'
    && chosen.anchor.anchor.roles.includes('noun');
}

function copulaGap(tokens, phrases, start, end) {
  let at = start;
  if (tokens[at]?.kind === 'modal') {
    at += 1;
    const prefix = phrases.find((phrase) => phrase.type === 'qualifier' && phrase.start === at);
    if (!prefix) return false;
    at = prefix.end;
  }
  if (tokens[at]?.kind !== 'be') return false;
  at += 1;
  let qualifier = phrases.find((phrase) => phrase.type === 'qualifier' && phrase.start === at);
  if (!qualifier && tokens[at]?.kind === 'word' && NEGATIONS.has(tokens[at].text)) at += 1;
  qualifier = phrases.find((phrase) => phrase.type === 'qualifier' && phrase.start === at);
  at = qualifier?.end ?? at;
  if (tokens[at]?.kind === 'word' && ARTICLES.has(tokens[at].text)) at += 1;
  return at === end;
}

function frontedGap(tokens, phrases, start, end, chosen) {
  let at = start;
  const comma = tokens[at]?.kind === 'sep' && tokens[at].text === ',';
  if (comma) at += 1;
  if (tokens[at]?.kind === 'word' && tokens[at].text === 'there') {
    at += 1;
    return copulaGap(tokens, phrases, at, end);
  }
  if (!comma || chosen.anchor === null) return false;
  const participant = phrases.find((phrase) => phrase.type === 'participant' && phrase.start === at);
  if (participant?.end === end || at === end) return true;
  return nominal(chosen) && at + 1 === end && tokens[at]?.kind === 'word'
    && NOMINAL_DETERMINERS.has(tokens[at].text);
}

function nominalGap(tokens, phrases, start, end, chosen) {
  if (!nominal(chosen)) return false;
  if (end === start + 1 && tokens[start]?.kind === 'possessive') return true;
  const predicate = phrases.find((phrase) => phrase.type === 'predicate'
    && phrase.start === start);
  if (!predicate) return false;
  // A dual-role noun can be the retained predicate head in "has price".
  // Its existing prefix still records the bounded has chain up to the noun.
  let at = predicate.head === 'has' ? predicate.end
    : predicate.prefix.findLast((part) => part.text === 'has')?.end;
  if (at === undefined) return false;
  at = phrases.find((phrase) => phrase.type === 'qualifier' && phrase.start === at)?.end ?? at;
  if (tokens[at]?.kind === 'word' && ARTICLES.has(tokens[at].text)) at += 1;
  return at === end;
}

function labelGap(tokens, phrases, start, end) {
  if (tokens[start]?.kind !== 'sep' || ![',', ':', '-'].includes(tokens[start].text)) return false;
  let at = start + 1;
  at = phrases.find((phrase) => phrase.type === 'qualifier' && phrase.start === at)?.end ?? at;
  if (wordIn(tokens[at], RANGE_INTRODUCERS)) at += 1;
  return at === end;
}

function connected(tokens, phrases, start, end, after, chosen) {
  if (start === end) return true;
  const first = tokens[start];
  const single = first.kind === 'sep' ? `sep:${first.text}` : first.kind;
  if (end === start + 1 && SINGLE_GAPS[Number(after)].has(single)) return true;
  if (after) return copulaGap(tokens, phrases, start, end)
    || nominalGap(tokens, phrases, start, end, chosen)
    || frontedGap(tokens, phrases, start, end, chosen)
    || labelGap(tokens, phrases, start, end);
  const predicate = phrases.find((phrase) => phrase.type === 'predicate' && phrase.start === start);
  if (predicate?.end === end && TRAILING_PREDICATES.has(predicate.head)) return true;
  if (end === start + 1 && tokens[start].text === 'pay'
    && tokens[end].text.startsWith('-per-')) return true;
  return end === start + 2 && tokens[start].kind === 'word'
    && ['plus', 'before'].includes(tokens[start].text) && tokens[start + 1]?.kind === 'word'
    && TAX_HEADS.has(tokens[start + 1].text);
}

function recognizeClause(clause) {
  const { tokens, phrases, amountRelations } = clause;
  const spans = amountRelations.flatMap(({ amount, candidates }) => [
    { amount, anchor: null, start: amount.start, end: amount.end },
    ...candidates.map((anchor) => ({ amount, anchor, start: anchor.start, end: anchor.end })),
  ]);
  const unitRelations = tokens.flatMap((token, start) => UNITS.has(token.kind)
    ? [{ unit: { start, end: start + 1, kind: token.kind, text: token.text }, candidates: [] }] : []);
  const brackets = tokens.flatMap((token, at) => token.kind === 'sep' && ['(', ')'].includes(token.text)
    ? [at] : []);

  for (const record of unitRelations) {
    const { unit } = record;
    for (const chosen of spans) {
      const before = chosen.end <= unit.start;
      const after = unit.end <= chosen.start;
      if (!before && !after) continue;
      const start = before ? chosen.end : unit.end;
      const end = before ? unit.start : chosen.start;
      const adjacent = start === end;
      let gapStart = start;
      let gapEnd = end;
      const crossedBrackets = brackets.filter((at) => at >= start && at < end);
      if (crossedBrackets.length) {
        // Validate only the crossed delimiter; unrelated punctuation retains existing evidence.
        if (crossedBrackets.length !== 1) continue;
        const wrapped = [unit, chosen].some((span) => tokens[span.start - 1]?.text === '('
          && tokens[span.end]?.text === ')' && [span.start - 1, span.end].includes(crossedBrackets[0]));
        if (!wrapped) continue;
        if (crossedBrackets[0] === gapStart) gapStart += 1;
        else if (crossedBrackets[0] === gapEnd - 1) gapEnd -= 1;
        else continue;
      }
      if (!connected(tokens, phrases, gapStart, gapEnd, after, chosen)) continue;
      const candidate = {
        relation: 'amount_unit',
        start: Math.min(unit.start, chosen.start), end: Math.max(unit.end, chosen.end),
        amount: chosen.amount, anchor: chosen.anchor,
        connector: adjacent ? null : {
          start, end, text: tokens.slice(start, end).map((token) => token.text).join(' '),
        },
      };
      record.candidates.push(candidate);
    }
  }
  return { ...clause, unitRelations };
}

// Inactive lexical evidence only: even linked units remain unresolved policy evidence.
function recognizeEmailReplyUnitRelations(text = '') {
  const recognized = recognizeEmailReplyAmountRelations(text);
  if (!recognized.ok) return recognized;
  return { ...recognized, disposition: 'needs_review', clauses: recognized.clauses.map(recognizeClause) };
}

module.exports = { recognizeEmailReplyUnitRelations };
