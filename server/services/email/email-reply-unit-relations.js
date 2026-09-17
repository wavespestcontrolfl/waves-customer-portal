const { recognizeEmailReplyAmountRelations } = require('./email-reply-amount-relations');

const UNITS = new Set(['unit', 'application', 'timing', 'forVisit', 'eachVisit', 'visits', 'visit', 'period']);
const SEPARATORS = new Set([':', '-']);

function recognizeClause(clause) {
  const { tokens, phrases, amountRelations } = clause;
  const spans = amountRelations.flatMap(({ amount, candidates }) => [
    { amount, anchor: null, start: amount.start, end: amount.end },
    ...candidates.map((anchor) => ({ amount, anchor, start: anchor.start, end: anchor.end })),
  ]);
  const unitRelations = tokens.flatMap((token, start) => UNITS.has(token.kind)
    ? [{ unit: { start, end: start + 1, kind: token.kind, text: token.text }, candidates: [] }] : []);

  for (const record of unitRelations) {
    const { unit } = record;
    const participant = phrases.find((phrase) => phrase.type === 'participant'
      && phrase.start === unit.end + 1);
    for (const chosen of spans) {
      const before = chosen.end <= unit.start;
      const after = unit.end <= chosen.start;
      if (!before && !after) continue;
      const start = before ? chosen.end : unit.end;
      const end = before ? unit.start : chosen.start;
      const punctuation = tokens[start].kind === 'sep' ? tokens[start].text : null;
      const adjacent = start === end;
      const separator = end === start + 1 && SEPARATORS.has(punctuation);
      const fronted = after && chosen.anchor !== null && punctuation === ','
        && (end === start + 1 || end === participant?.end);
      if (!adjacent && !separator && !fronted) continue;
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
