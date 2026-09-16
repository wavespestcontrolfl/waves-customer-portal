const { normalizeEmailReplyCopy } = require('./email-reply-copy-normalizer');
const { matchEmailReplyAmountAt } = require('./email-reply-amount-lexer');
const { matchEmailReplyUnitAt } = require('./email-reply-unit-lexer');

const STEM = Object.freeze({
  bills: 'bill', billed: 'bill', billing: 'bill',
  charges: 'charge', charged: 'charge', charging: 'charge',
  invoices: 'invoice', invoiced: 'invoice', invoicing: 'invoice',
  pays: 'pay', paid: 'pay', paying: 'pay',
  prices: 'price', priced: 'price', pricing: 'price',
  costs: 'cost', costing: 'cost', runs: 'run', running: 'run',
  occurs: 'occur', occurred: 'occur', occurring: 'occur',
  applies: 'apply', applied: 'apply', applying: 'apply',
  incurs: 'incur', incurred: 'incur', incurring: 'incur',
  generates: 'generate', generated: 'generate', generating: 'generate',
  have: 'has', had: 'has',
  amounts: 'amount', rates: 'rate', fees: 'fee', payments: 'payment',
  range: 'range', ranges: 'range', ranged: 'range', ranging: 'range',
});

const PATTERNS = [
  ['be', '(?:will|would|should|could|may|might|must|shall|can)\\s+be\\b|(?:has|have|had)\\s+been\\b|(?:is|are|was|were|be|been|being|gets?|got)\\b'],
  ['modal', '(?:will|would|should|could|may|might|must|shall|can)\\b'],
  ['possessive', "(?:'s|')"],
  ['word', '\\+(?=\\s*(?:tax(?:es)?|fees?)\\b)'],
  ['sep', '[,:()\\-]'],
  ['word', '[a-z]+(?:-(?!per-)[a-z]+)*\\b'],
].map(([kind, source]) => ({ kind, re: new RegExp(source, 'iy') }));

function wordText(text) {
  if (text === '+') return 'plus';
  return Object.hasOwn(STEM, text) ? STEM[text] : text;
}

function recognizeEmailReplyPricingClauses(text = '') {
  const normalized = normalizeEmailReplyCopy(text);
  if (!normalized.ok) return { ok: false, reason: normalized.reason };

  const source = normalized.text.toLowerCase();
  const clauses = [];
  let clause = [];
  for (let at = 0; at < source.length;) {
    const char = source[at];
    if (/\s/.test(char)) { at += 1; continue; }
    if (/[.!?;]/.test(char) && !matchEmailReplyAmountAt(source, at)) {
      if (clause.length) clauses.push(clause);
      clause = [];
      at += 1;
      continue;
    }

    let longest = null;
    for (const match of [matchEmailReplyUnitAt(source, at), matchEmailReplyAmountAt(source, at)]) {
      if (match && (!longest || match.text.length > longest.text.length)) longest = match;
    }
    for (const pattern of PATTERNS) {
      pattern.re.lastIndex = at;
      const matched = pattern.re.exec(source);
      if (matched && (!longest || matched[0].length > longest.text.length)) {
        longest = { kind: pattern.kind, text: matched[0] };
      }
    }
    if (longest) {
      clause.push({ kind: longest.kind, text: longest.kind === 'word'
        ? wordText(longest.text) : longest.text });
      at += longest.text.length;
    } else {
      // Never erase syntax the bounded grammar cannot classify.
      clause.push({ kind: 'barrier', text: char });
      at += 1;
    }
  }
  if (clause.length) clauses.push(clause);
  return { ok: true, clauses };
}

module.exports = { recognizeEmailReplyPricingClauses };
