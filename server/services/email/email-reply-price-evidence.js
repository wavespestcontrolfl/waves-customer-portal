const { recognizeEmailReplyUnitRelations } = require('./email-reply-unit-relations');

const SUBJECT_UNITS = new Set(['visit', 'visits', 'eachVisit']);
const UNIT_FAMILIES = { unit: 'visit', forVisit: 'visit', visit: 'visit', visits: 'visit',
  eachVisit: 'visit', application: 'application', period: 'period', timing: 'timing' };

function hasPriceAnchor(clause, unit, edge) {
  if (edge.amount.kind === 'money') return true;
  if (!edge.anchor) return false;
  const anchor = edge.anchor.anchor;
  if (anchor.type === 'billing_head' || anchor.priceCue) return true;
  const amount = clause.amountRelations.find((record) => record.amount === edge.amount);
  if (amount.candidates.some((candidate) => candidate.anchor.type === 'billing_head')) return true;
  return anchor.head === 'range' && clause.phrases.some((phrase) => phrase.type === 'billing_head'
    && phrase.roles.includes('noun') && (phrase.end === unit.start || phrase.end === anchor.start));
}

function recognizeClause(clause) {
  const priceEvidence = clause.unitRelations.flatMap(({ unit, candidates }) => candidates
    .filter((edge) => {
      if (!hasPriceAnchor(clause, unit, edge)) return false;
      // A bare visit subject after sentence punctuation is unresolved context.
      if (SUBJECT_UNITS.has(unit.kind) && edge.amount.end <= unit.start && edge.connector
        && clause.tokens.slice(edge.connector.start, edge.connector.end)
          .some((token) => token.kind === 'sep' && ['-', ','].includes(token.text))) return false;
      return true;
    }).map((edge) => ({ family: UNIT_FAMILIES[unit.kind], unit, edge })));
  return { ...clause, priceEvidence };
}

// Inactive candidate evidence, including negation/ambiguity; never send authorization.
function recognizeEmailReplyPriceEvidence(text = '') {
  const result = recognizeEmailReplyUnitRelations(text);
  if (!result.ok) return result;
  return { ...result, disposition: 'needs_review', clauses: result.clauses.map(recognizeClause) };
}

module.exports = { recognizeEmailReplyPriceEvidence };
