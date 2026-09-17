const { recognizeEmailReplyPricingClauses } = require('./email-reply-pricing-clauses');

const QUALIFIERS = [
  'no more than', 'no less than', 'not more than', 'not less than', 'as low as',
  'as high as', 'up to', 'at least', 'at most', 'less than', 'more than',
  'only', 'just', 'about', 'around', 'approximately', 'roughly', 'exactly',
  'nearly', 'almost', 'under', 'over',
].map((text) => text.split(' ')).sort((a, b) => b.length - a.length);
const PRONOUNS = new Set(['i', 'we', 'you', 'he', 'she', 'it', 'they', 'me', 'us', 'him', 'her', 'them']);
const DETERMINERS = new Set(['a', 'an', 'the', 'this', 'that', 'these', 'those', 'each', 'every',
  'my', 'our', 'your', 'his', 'her', 'its', 'their', 'any']);
const PARTICIPANTS = new Set(['customer', 'customers', 'client', 'clients', 'account', 'accounts']);
const NOUNS = new Set(['bill', 'charge', 'invoice', 'fee', 'rate', 'amount', 'balance', 'total',
  'cost', 'price', 'payment', 'dues', 'subscription', 'subscriptions', 'spread', 'surcharge', 'surcharges']);
const PRICE_ACTIONS = new Set(['bill', 'charge', 'pay', 'invoice', 'price', 'cost', 'run', 'incur',
  'total', 'totals', 'equal', 'equals', 'come to', 'amount to']);
// These generic actions need separate currency or nominal price evidence.
const GENERIC_ACTIONS = new Set(['generate', 'apply', 'occur', 'has', 'due', 'required', 'payable', 'range']);
const ACTIONS = new Set([...PRICE_ACTIONS, ...GENERIC_ACTIONS]);
const HEADS = new Map([...NOUNS].map((head) => [head, { head, roles: ['noun'] }]));
for (const head of ACTIONS) {
  HEADS.set(head, { head, roles: [...(HEADS.get(head)?.roles ?? []), 'action'] });
}
const PREFIX_WORDS = new Set(['has', 'do', 'does', 'did', 'not', 'never', 'separately', 'individually']);
const MAX_PREFIX_TOKENS = 12;

function qualifierAt(tokens, start) {
  return QUALIFIERS.find((words) => words.every((word, offset) => (
    tokens[start + offset]?.kind === 'word' && tokens[start + offset].text === word
  )));
}

function headAt(tokens, start) {
  const token = tokens[start];
  if (token?.kind !== 'word') return null;
  if (['come', 'comes', 'amount'].includes(token.text)
      && tokens[start + 1]?.kind === 'word' && tokens[start + 1].text === 'to') {
    return { head: token.text === 'amount' ? 'amount to' : 'come to', roles: ['action'], end: start + 2 };
  }
  const head = HEADS.get(token.text);
  return head ? { ...head, end: start + 1 } : null;
}

function span(tokens, type, start, end, fields = {}) {
  return { type, start, end, text: tokens.slice(start, end).map((token) => token.text).join(' '), ...fields };
}

function predicateAt(tokens, start) {
  let at = start;
  let candidate = null;
  let negated = false;
  while (at < tokens.length && at - start <= MAX_PREFIX_TOKENS) {
    const action = headAt(tokens, at);
    if (action?.roles.includes('action')) {
      candidate = span(tokens, 'predicate', start, action.end, {
        head: action.head, headStart: at, headEnd: action.end, negated,
        priceCue: PRICE_ACTIONS.has(action.head),
        prefix: tokens.slice(start, at).map((token, offset) => ({
          start: start + offset, end: start + offset + 1, text: token.text,
        })),
      });
    }
    const qualifier = qualifierAt(tokens, at);
    if (qualifier) {
      at += qualifier.length;
      continue;
    }
    const token = tokens[at];
    if (token.kind === 'be' || token.kind === 'modal' || (
      token.kind === 'word' && PREFIX_WORDS.has(token.text)
    )) {
      negated ||= token.kind === 'word' && ['not', 'never'].includes(token.text);
      at += 1;
      continue;
    }
    break;
  }
  return candidate;
}

function recognizeClause(tokens) {
  const phrases = [];
  const predicates = new Map();
  let qualifierEnd = 0;
  let participantEnd = 0;
  for (let start = 0; start < tokens.length; start += 1) {
    const token = tokens[start];
    const qualifier = qualifierAt(tokens, start);
    if (qualifier && start >= qualifierEnd) {
      qualifierEnd = start + qualifier.length;
      phrases.push(span(tokens, 'qualifier', start, qualifierEnd));
    }
    if (token.kind === 'word') {
      const determined = DETERMINERS.has(token.text)
        && tokens[start + 1]?.kind === 'word' && PARTICIPANTS.has(tokens[start + 1].text);
      if (start >= participantEnd && (determined || PRONOUNS.has(token.text) || PARTICIPANTS.has(token.text))) {
        participantEnd = start + (determined ? 2 : 1);
        phrases.push(span(tokens, 'participant', start, participantEnd));
      }
      const head = headAt(tokens, start);
      if (head) {
        phrases.push(span(tokens, 'billing_head', start, head.end, {
          head: head.head, roles: [...head.roles],
        }));
        if (head.end > start + 1 && NOUNS.has(token.text)) {
          phrases.push(span(tokens, 'billing_head', start, start + 1, {
            head: token.text, roles: ['noun'],
          }));
        }
      }
    }
    const predicate = predicateAt(tokens, start);
    // Retain the longest supported prefix for each head; candidate families may overlap.
    if (predicate && !predicates.has(predicate.headStart)) predicates.set(predicate.headStart, predicate);
  }
  phrases.push(...predicates.values());
  phrases.sort((a, b) => a.start - b.start || b.end - a.end || a.type.localeCompare(b.type));
  return { tokens, phrases };
}

// Lexical candidates are deliberately incomplete evidence, never a policy verdict.
function recognizeEmailReplyPricingPhrases(text = '') {
  const scanned = recognizeEmailReplyPricingClauses(text);
  if (!scanned.ok) return scanned;
  return { ok: true, disposition: 'needs_review', clauses: scanned.clauses.map(recognizeClause) };
}

module.exports = { recognizeEmailReplyPricingPhrases };
