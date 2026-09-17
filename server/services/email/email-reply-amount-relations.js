const { recognizeEmailReplyPricingPhrases } = require('./email-reply-pricing-phrases');

const AMOUNTS = new Set(['money', 'number']);
const DETERMINERS = new Set(['a', 'an', 'the']);
const NEGATIONS = new Set(['not', 'never']);

function recognizeClause(clause) {
  const { tokens, phrases } = clause;
  const at = (type, start) => phrases.find((phrase) => phrase.type === type && phrase.start === start);
  const amountRelations = tokens.flatMap((token, start) => AMOUNTS.has(token.kind)
    ? [{ amount: { start, end: start + 1, kind: token.kind, text: token.text }, candidates: [] }] : []);
  const amounts = new Map(amountRelations.map((record) => [record.amount.start, record]));

  function copulaEnd(start, allowQualifier) {
    if (tokens[start]?.kind !== 'be') return start;
    const next = tokens[start + 1];
    // Comparative qualifiers such as "not more than" retain their original phrase span.
    return start + (next?.kind === 'word' && NEGATIONS.has(next.text)
      && !(allowQualifier && at('qualifier', start + 1)) ? 2 : 1);
  }

  function add(record, relation, anchor, qualifier = null) {
    const { amount } = record;
    const before = anchor.start < amount.start;
    const start = before ? anchor.end : amount.end;
    const end = before ? amount.start : anchor.start;
    record.candidates.push({
      relation, start: Math.min(anchor.start, amount.start), end: Math.max(anchor.end, amount.end),
      anchor,
      connector: start === end ? null : {
        start, end, text: tokens.slice(start, end).map((token) => token.text).join(' '),
      },
      qualifier,
    });
  }

  for (const anchor of phrases) {
    const predicate = anchor.type === 'predicate';
    const noun = anchor.type === 'billing_head' && anchor.roles.includes('noun');
    if (!predicate && !noun) continue;
    let end = anchor.end;
    if (predicate) end = at('participant', end)?.end ?? end;
    else end = copulaEnd(end, true);
    const qualifier = at('qualifier', end);
    if (qualifier) end = qualifier.end;
    const record = amounts.get(end);
    if (record) add(record, predicate ? 'predicate_amount' : 'head_amount', anchor, qualifier);
  }

  for (const record of amountRelations) {
    let end = copulaEnd(record.amount.end, false);
    if (tokens[end]?.kind === 'word' && DETERMINERS.has(tokens[end].text)) end += 1;
    for (const anchor of phrases) {
      if (anchor.type === 'billing_head' && anchor.roles.includes('noun') && anchor.start === end) {
        add(record, 'amount_head', anchor);
      }
    }
  }
  return { ...clause, amountRelations };
}

// Inactive lexical evidence only: an empty candidate list is unresolved, never authorization.
function recognizeEmailReplyAmountRelations(text = '') {
  const recognized = recognizeEmailReplyPricingPhrases(text);
  if (!recognized.ok) return recognized;
  return { ...recognized, disposition: 'needs_review', clauses: recognized.clauses.map(recognizeClause) };
}

module.exports = { recognizeEmailReplyAmountRelations };
