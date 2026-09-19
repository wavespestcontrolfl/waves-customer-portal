const { recognizeEmailReplyPriceEvidence } = require('./email-reply-price-evidence');
const { matchEmailReplyPeriodAt } = require('./email-reply-unit-lexer');

const UNIT_KINDS = new Set(['unit', 'application', 'timing', 'forVisit', 'eachVisit', 'visits', 'visit']);

function recognizeClause(clause) {
  const { tokens } = clause;
  const periodPhrases = [];
  for (let start = 0; start < tokens.length; start += 1) {
    const token = tokens[start];
    if (UNIT_KINDS.has(token.kind)) {
      // Try every lexical start inside the token ("/monthly visit" starts
      // with a slash), not only each whitespace chunk's first offset.
      for (const word of token.text.matchAll(/[a-z]+/gi)) {
        const matched = matchEmailReplyPeriodAt(token.text, word.index);
        if (!matched) continue;
        periodPhrases.push({ start, end: start + 1, text: matched.text, period: matched.period,
          embedded: true, tokens: [token], offsets: { start: matched.start, end: matched.end } });
      }
      continue;
    }
    if (!['word', 'period'].includes(token.kind)) continue;
    const selected = [token];
    if (token.kind === 'word') {
      // Up to six following words feed the matcher so its bounded temporal
      // lookahead ("a month or two ago") can see the whole construction; only
      // the matched span is consumed.
      for (let at = start + 1; at < Math.min(tokens.length, start + 7); at += 1) {
        if (tokens[at].kind !== 'word') break;
        selected.push(tokens[at]);
      }
    }
    const matched = matchEmailReplyPeriodAt(selected.map((part) => part.text).join(' '));
    if (!matched) continue;
    let width = 0;
    const consumed = selected.filter((part) => {
      const included = width < matched.end;
      width += part.text.length + 1;
      return included;
    });
    periodPhrases.push({ start, end: start + consumed.length, text: matched.text,
      period: matched.period, embedded: false, tokens: consumed, offsets: null });
    start += consumed.length - 1;
  }
  return { ...clause, periodPhrases };
}

// Supplemental typed period evidence; original scanner tokens are never rewritten.
function recognizeEmailReplyPeriodPhrases(text = '') {
  const result = recognizeEmailReplyPriceEvidence(text);
  if (!result.ok) return result;
  return { ...result, disposition: 'needs_review', clauses: result.clauses.map(recognizeClause) };
}

module.exports = { recognizeEmailReplyPeriodPhrases };
