const { recognizeEmailReplyBillingFrames } = require('./email-reply-billing-frames');

const DETERMINERS = new Set(['a', 'an', 'the', 'our', 'your', 'its', 'their']);
const COMPLEMENTS = new Set(['apply', 'occur', 'due', 'required', 'payable']);
const NEGATIONS = new Set(['not', 'never']);
const isWord = (token, words) => token?.kind === 'word' && words.has(token.text);

function trailing(clause, from, to) {
  const { tokens, phrases } = clause;
  let at = from;
  let negated = false;
  const predicate = phrases.find((phrase) => phrase.type === 'predicate' && phrase.start === at
    && COMPLEMENTS.has(phrase.head) && phrase.end <= to);
  if (predicate) { at = predicate.end; negated = predicate.negated; }
  else {
    const modal = tokens[at].kind === 'modal';
    for (const kind of ['modal', 'negative', 'be', 'negative']) {
      const negative = kind === 'negative' && isWord(tokens[at], NEGATIONS);
      if (negative || tokens[at].kind === kind) { at += 1; negated ||= negative; }
    }
    if (modal && !tokens.slice(from, at).some((token) => token.kind === 'be')) return null;
  }
  // At most three local separators; parenthesized units must be matched.
  const separatorEnd = Math.min(to, at + 3);
  while (at < separatorEnd && tokens[at].kind === 'sep') {
    if (tokens[at].text === '(' && (tokens[at + 1].text === '(' || tokens[to + 1]?.text !== ')')) return null;
    if (tokens[at].text === ')') return null;
    at += 1;
  }
  if (isWord(tokens[at], NEGATIONS)) { negated = true; at += 1; }
  return at === to ? { negated } : null;
}

function leading(clause, from, to, frameType) {
  const { tokens, phrases } = clause;
  if (from === to) return { position: 'after', negated: false };
  if (tokens[from]?.kind === 'possessive' && from + 1 === to && frameType === 'nominal') {
    return { position: 'possessive', negated: false };
  }
  let at = from;
  const comma = tokens[at].text === ',';
  if (comma) at += 1;
  if (tokens[at]?.text === 'there' && tokens[at + 1]?.kind === 'be') at += 2;
  else {
    if (!comma) return null;
    const participant = phrases.find((phrase) => phrase.type === 'participant' && phrase.start === at);
    if (participant && frameType === 'predicate') at = participant.end;
  }
  if (frameType === 'nominal') {
    if (isWord(tokens[at], DETERMINERS)) at += 1;
    if (['separate', 'individual'].includes(tokens[at]?.text)) at += 1;
  }
  return at === to ? { position: 'fronted', negated: false } : null;
}

function endings(clause, frame, frameType) {
  const direct = { end: frame.end, amountRelation: null, negated: false };
  if (frameType !== 'nominal') return [direct];
  const amounts = clause.amountRelations.flatMap(({ candidates }) => candidates
    .filter((candidate) => candidate.anchor === frame.head && candidate.start >= frame.start)
    .map((candidate) => ({ end: candidate.end, amountRelation: candidate,
      negated: clause.tokens.slice(frame.end, candidate.end).some((token, offset) => (
        isWord(token, NEGATIONS) && !(candidate.qualifier
          && frame.end + offset >= candidate.qualifier.start && frame.end + offset < candidate.qualifier.end)
      )) })));
  return [direct, ...amounts];
}

function recognizeClause(clause) {
  const { tokens } = clause;
  const frames = [
    ...clause.nominalFrames.map((frame) => ({ frame, frameType: 'nominal' })),
    ...clause.predicateFrames.map((frame) => ({ frame, frameType: 'predicate' })),
  ];
  const billingRelations = clause.unitRelations.map(({ unit }) => ({ unit, candidates: [] }));
  for (const record of billingRelations) {
    const { unit } = record;
    for (const { frame, frameType } of frames) {
      if (frameType === 'predicate' && frame.object?.visit === unit) {
        record.candidates.push({ relation: 'frame_object', frameType, frame,
          start: frame.start, end: frame.end, position: 'object',
          connector: { start: unit.start, end: unit.start, negated: false }, via: null });
      }
      if (unit.end <= frame.start) {
        const link = leading(clause, unit.end, frame.start, frameType);
        if (link) record.candidates.push({ relation: 'unit_frame', frameType, frame,
          start: unit.start, end: frame.end, position: link.position,
          connector: { start: unit.end, end: frame.start, negated: link.negated }, via: null });
      }
      for (const { end, amountRelation, negated } of endings(clause, frame, frameType)) {
        if (end > unit.start) continue;
        const link = trailing(clause, end, unit.start);
        if (link) record.candidates.push({ relation: 'frame_unit', frameType, frame,
          start: frame.start, end: unit.end, position: 'before', amountRelation,
          connector: { start: end, end: unit.start, negated: link.negated || negated }, via: null });
      }
    }
  }
  // Coordination inherits only an immediately preceding linked unit. No clause scan.
  for (let index = 1; index < billingRelations.length; index += 1) {
    const prior = billingRelations[index - 1];
    const current = billingRelations[index];
    const explicit = ['unit', 'period', 'forVisit'].includes(current.unit.kind)
      || (current.unit.kind === 'application' && /^(?:-?per\b|for\b|\/)/.test(current.unit.text));
    if (!explicit) continue;
    const gap = tokens.slice(prior.unit.end, current.unit.start);
    if (gap.length !== 1 || gap[0].kind !== 'word' || !['and', 'or'].includes(gap[0].text)) continue;
    for (const candidate of prior.candidates.filter((entry) => entry.relation === 'frame_unit')) {
      current.candidates.push({ ...candidate, end: current.unit.end, via: prior.unit,
        connector: { start: prior.unit.end, end: current.unit.start, negated: candidate.connector.negated } });
    }
  }
  return { ...clause, billingRelations };
}

// Inactive relationship candidates, not policy assertions or application exemptions.
function recognizeEmailReplyBillingRelations(text = '') {
  const result = recognizeEmailReplyBillingFrames(text);
  if (!result.ok) return result;
  return { ...result, disposition: 'needs_review', clauses: result.clauses.map(recognizeClause) };
}

module.exports = { recognizeEmailReplyBillingRelations };
