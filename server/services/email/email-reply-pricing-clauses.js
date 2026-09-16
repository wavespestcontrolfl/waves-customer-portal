const { normalizeEmailReplyCopy } = require('./email-reply-copy-normalizer');

// The lexicon is intentionally finite. It classifies syntax for the two
// pricing policies; it does not infer a policy verdict or arbitrary meaning.
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
const STOP_WORDS = [
  'a', 'access', 'account', 'accounts', 'after', 'an', 'and', 'any', 'are', 'at',
  'balance', 'balances', 'be', 'been', 'before', 'being', 'buck', 'bucks', 'but', 'by', 'can',
  'client', 'clients', 'could', 'cover', 'covered', 'covering', 'covers',
  'customer', 'customers', 'did', 'do', 'does', 'dollar', 'dollars', 'during', 'each', 'every',
  'for', 'from', 'had', 'has', 'have', 'her', 'his', 'if', 'include', 'included',
  'includes', 'including', 'in', 'into', 'is', 'its', 'may', 'might', 'must',
  'my', 'of', 'on', 'one', 'or', 'our', 'payment', 'payments', 'per', 'please',
  'should', 'since', 'than', 'that', 'the', 'their', 'then', 'these', 'this',
  'those', 'through', 'to', 'until', 'usd', 'was', 'we', 'were', 'when', 'where',
  'while', 'will', 'with', 'without', 'would', 'you', 'your',
  'amount', 'apply', 'bill', 'charge', 'cost', 'fee', 'generate', 'incur',
  'invoice', 'occur', 'pay', 'price', 'range', 'rate', 'run',
  ...Object.keys(STEM),
];
const STOP = `(?:${[...new Set(STOP_WORDS)].join('|')})`;
const DURATION = '(?:minutes?|hours?|days?|weeks?|months?|years?)';
const MODIFIER = `(?!(?:applications?|${STOP})(?=\\s|$))(?:[a-z]+(?:-(?!(?:dollars?|bucks?)\\b)[a-z]+)*|\\d{1,9}(?:\\.\\d{1,2})?(?:-(?:minute|hour|day|week|month|year)s?|\\s+${DURATION}))`;
const VISIT = `(?:${MODIFIER}\\s+){0,8}(?:service-)?visit\\b`;
const VISITS = `(?:${MODIFIER}\\s+){0,8}(?:service-)?visits\\b`;
const SINGULAR_DET = '(?:a|an|one|the|your|our|my|their|his|her|its|this|that)';
const PLURAL_DET = '(?:the|your|our|my|their|his|her|its|these|those)';
const APPLICATION_DET = `(?:each|every|any|${SINGULAR_DET}|${PLURAL_DET})`;
const ONE_VISIT = `(?:${SINGULAR_DET}\\s+)?${VISIT}`;
const MANY_VISITS = `(?:${PLURAL_DET}\\s+)?${VISITS}`;
const EACH_VISIT = `(?:each|every|any)\\s+(?:${VISIT}|${VISITS})`;
const RECURRING = `(?:${EACH_VISIT}|${MANY_VISITS})`;
const SINGLE_VISIT = `(?:${ONE_VISIT})`;
const APPLICATION = `(?:${MODIFIER}\\s+){0,4}applications?\\b`;

const DIGITS = '\\d{1,9}(?:,\\d{3}){0,3}(?:\\.\\d{1,2})?';
const NUMERIC_RANGE = `${DIGITS}(?:\\s*(?:-|to)\\s*(?:(?:\\$\\s*|usd\\s+))?${DIGITS})?`;
const ONE_TO_NINETEEN = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)';
const TENS = '(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)';
const UNDER_HUNDRED = `(?:${ONE_TO_NINETEEN}|${TENS}(?:[-\\s](?:one|two|three|four|five|six|seven|eight|nine))?)`;
const WRITTEN = `(?:(?:a|one|two|three|four|five|six|seven|eight|nine)\\s+hundred(?:\\s+(?:and\\s+)?${UNDER_HUNDRED})?|${UNDER_HUNDRED})`;
const CURRENCY = `(?:(?:\\$\\s*|\\busd\\s+)${NUMERIC_RANGE}|\\b${NUMERIC_RANGE}(?:\\s+|-)(?:dollars?|bucks?|usd)\\b|\\b${WRITTEN}(?:\\s+|-)(?:dollars?|bucks?)\\b)`;
const MONEY = `(?:${CURRENCY})(?:\\s*\\+(?!\\s*(?:tax(?:es)?|fees?)\\b)|\\s+(?:and\\s+up|or\\s+more))?`;
const MEASURE_SPAN = `(?:between\\s+${DIGITS}\\s+and\\s+${DIGITS}|from\\s+${DIGITS}\\s+to\\s+${DIGITS}|${DIGITS}\\s*(?:-|to)\\s*${DIGITS}|${DIGITS}|${WRITTEN})`;
const MEASURE = `${MEASURE_SPAN}\\s+(?:minutes?|hours?|days?|weeks?|months?|years?|photos?|pictures?|points?|ounces?|gallons?|reminders?)\\b`;

// Longest anchored match wins. The stable order breaks equal-length ties;
// unit/application/measurement forms precede their shorter constituents.
const PATTERNS = [
  ['unit', `(?:(?:on\\s+(?:a|the)\\s+)?visit-by-visit(?:\\s+basis)?|(?:-?per[\\s-]+|/\\s*|by\\s+(?:(?:the|each)\\s+)?)${VISIT}|(?:-?per[\\s-]+|/\\s*|by\\s+(?:(?:the|each)\\s+)?)${VISITS}|(?:for|on|at)\\s+${RECURRING})`],
  ['application', `(?:-?per[\\s-]+|for\\s+(?:${APPLICATION_DET}\\s+)?|/\\s*)${APPLICATION}`],
  ['timing', `(?:on|at)\\s+${SINGLE_VISIT}`],
  ['forVisit', `for\\s+${SINGLE_VISIT}`],
  ['eachVisit', EACH_VISIT],
  ['visits', MANY_VISITS],
  ['visit', ONE_VISIT],
  ['money', MONEY],
  ['measurement', MEASURE],
  ['number', `${DIGITS}(?![\\d,]|\\.\\d)`],
  ['be', '(?:will|would|should|could|may|might|must|shall|can)\\s+be\\b|(?:has|have|had)\\s+been\\b|(?:is|are|was|were|be|been|being|gets?|got)\\b'],
  ['modal', '(?:will|would|should|could|may|might|must|shall|can)\\b'],
  ['possessive', "(?:'s|')"],
  ['word', '\\+(?=\\s*(?:tax(?:es)?|fees?)\\b)'],
  ['sep', '[,:()\\-]'],
  ['word', '[a-z]+(?:-(?!per-)[a-z]+)*\\b'],
].map(([kind, source]) => ({ kind, re: new RegExp(source, 'iy') }));

function recognizeEmailReplyPricingClauses(text = '') {
  const normalized = normalizeEmailReplyCopy(text);
  if (!normalized.ok) return { ok: false, reason: normalized.reason };

  const source = normalized.text.toLowerCase();
  const clauses = [];
  let clause = [];
  for (let at = 0; at < source.length;) {
    const char = source[at];
    if (/\s/.test(char)) { at += 1; continue; }
    if (/[.!?;]/.test(char)) {
      if (clause.length) clauses.push(clause);
      clause = [];
      at += 1;
      continue;
    }

    let longest = null;
    for (const pattern of PATTERNS) {
      pattern.re.lastIndex = at;
      const matched = pattern.re.exec(source);
      if (matched && (!longest || matched[0].length > longest.text.length)) {
        longest = { kind: pattern.kind, text: matched[0] };
      }
    }
    if (longest) {
      clause.push({ kind: longest.kind, text: longest.kind === 'word'
        ? (longest.text === '+' ? 'plus' : STEM[longest.text] || longest.text) : longest.text });
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
