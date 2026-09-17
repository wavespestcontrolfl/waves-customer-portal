const { recognizeEmailReplyPriceEvidence } = require('./email-reply-price-evidence');

const DETERMINERS = new Set(['a', 'an', 'the', 'our', 'your', 'its', 'their']);
const SEPARATE = new Set(['separate', 'individual', 'separately', 'individually']);
const VISITS = new Set(['visit', 'visits', 'eachVisit']);
const isWord = (token, words) => token?.kind === 'word' && words.has(token.text);

function modifiersAt(tokens, start) {
  let end = start;
  const separate = [];
  if (isWord(tokens[end], DETERMINERS)) end += 1;
  if (end > start && ['its', 'their'].includes(tokens[end - 1].text)
    && tokens[end]?.kind === 'word' && tokens[end].text === 'own') {
    separate.push({ start: end - 1, end: end + 1 });
    end += 1;
  }
  if (isWord(tokens[end], SEPARATE)) {
    separate.push({ start: end, end: end + 1 });
    end += 1;
  }
  return { start, end, separate };
}

function nominalAt(clause, start) {
  const { tokens, phrases } = clause;
  const heads = phrases.filter((phrase) => phrase.type === 'billing_head' && phrase.roles.includes('noun'));
  const first = heads.find((head) => head.start === start);
  if (!first) return null;
  let head = first;
  // Retain bounded compound heads, not a growing allowlist of operational nouns.
  // Only word modifiers between known nominal heads can extend a nominal span.
  for (let at = first.end; at < Math.min(tokens.length, first.end + 6); at += 1) {
    if (tokens[at].kind !== 'word') break;
    if (phrases.some((phrase) => phrase.start === at
      && ['predicate', 'participant'].includes(phrase.type))) break;
    const next = heads.find((candidate) => candidate.start === at);
    if (next) head = next;
    if (['and', 'or', 'but', 'not', 'never'].includes(tokens[at].text)) break;
  }
  const frequency = head.head === 'bill' && tokens[head.end]?.text === 'frequency'
    ? { start: head.end, end: head.end + 1, token: tokens[head.end] } : null;
  return { start, end: frequency?.end ?? head.end, head, frequency,
    modifiers: tokens.slice(first.end, head.start) };
}

function separationAt(tokens, start) {
  if (isWord(tokens[start], SEPARATE)) return { start, end: start + 1 };
  if (tokens[start]?.text === 'on' && ['its', 'their'].includes(tokens[start + 1]?.text)
    && tokens[start + 2]?.text === 'own') return { start, end: start + 3 };
  return null;
}

function objectAt(clause, start) {
  const { tokens, amountRelations, unitRelations } = clause;
  const modifiers = modifiersAt(tokens, start);
  let at = modifiers.end;
  const visit = unitRelations.find(({ unit }) => unit.start === at && VISITS.has(unit.kind))?.unit ?? null;
  const visitModifiers = visit ? modifiersAt(tokens, visit.end) : { end: at, separate: [] };
  at = visitModifiers.end;
  let amount = amountRelations.find((record) => record.amount.start === at)?.amount ?? null;
  if (amount) at = amount.end;
  const inner = amount ? modifiersAt(tokens, at) : { end: at, separate: [] };
  const nominal = nominalAt(clause, inner.end);
  if (nominal) at = nominal.end;
  if (!amount && nominal) {
    let amountAt = at;
    if (['of', 'at'].includes(tokens[amountAt]?.text)) amountAt += 1;
    amount = amountRelations.find((record) => record.amount.start === amountAt)?.amount ?? null;
    if (amount) at = amount.end;
  }
  if (!visit && !amount && !nominal) return null;
  return { start, end: at, visit, amount, nominal,
    separate: [...modifiers.separate, ...visitModifiers.separate, ...(nominal ? inner.separate : [])] };
}

function recognizeClause(clause) {
  const { tokens, phrases } = clause;
  const nominalFrames = phrases.filter((phrase) => phrase.type === 'billing_head'
    && phrase.roles.includes('noun')).map((head) => nominalAt(clause, head.start));
  const predicateFrames = phrases.filter((phrase) => phrase.type === 'predicate').map((predicate) => {
    let at = predicate.end;
    const separate = [];
    const before = separationAt(tokens, at);
    if (before) { separate.push(before); at = before.end; }
    const recipient = phrases.find((phrase) => phrase.type === 'participant' && phrase.start === at) ?? null;
    if (recipient) at = recipient.end;
    const after = separationAt(tokens, at);
    if (after) { separate.push(after); at = after.end; }
    const object = objectAt(clause, at);
    if (object) at = object.end;
    return { start: predicate.start, end: at, predicate, recipient, separate, object };
  });
  return { ...clause, nominalFrames, predicateFrames };
}

// Frames are bounded lexical evidence, including incomplete objects, never approval.
function recognizeEmailReplyBillingFrames(text = '') {
  const result = recognizeEmailReplyPriceEvidence(text);
  if (!result.ok) return result;
  return { ...result, disposition: 'needs_review', clauses: result.clauses.map(recognizeClause) };
}

module.exports = { recognizeEmailReplyBillingFrames };
