// Inactive anchored lexer. The caller normalizes copy and decides policy.
const STOP_WORDS = [
  'a', 'access', 'account', 'accounts', 'after', 'an', 'and', 'any', 'are', 'at',
  'balance', 'balances', 'be', 'been', 'before', 'being', 'buck', 'bucks', 'but', 'by', 'can',
  'cent', 'cents', 'client', 'clients', 'could', 'cover', 'covered', 'covering', 'covers',
  'customer', 'customers', 'did', 'do', 'does', 'dollar', 'dollars', 'during', 'each', 'every',
  'for', 'from', 'had', 'has', 'have', 'her', 'his', 'if', 'include', 'included',
  'includes', 'including', 'in', 'into', 'is', 'its', 'may', 'might', 'must',
  'my', 'of', 'on', 'one', 'or', 'our', 'payment', 'payments', 'per', 'please',
  'should', 'since', 'than', 'that', 'the', 'their', 'then', 'these', 'this',
  'those', 'through', 'to', 'until', 'usd', 'was', 'we', 'were', 'when', 'where',
  'while', 'will', 'with', 'without', 'would', 'you', 'your',
  'amount', 'apply', 'bill', 'charge', 'cost', 'fee', 'generate', 'incur',
  'invoice', 'occur', 'pay', 'price', 'range', 'rate', 'run',
  'bills', 'billed', 'billing', 'charges', 'charged', 'charging', 'invoices', 'invoiced', 'invoicing', 'pays', 'paid', 'paying', 'prices', 'priced', 'pricing', 'costs', 'costing', 'runs', 'running', 'occurs', 'occurred', 'occurring', 'applies', 'applied', 'applying', 'incurs', 'incurred', 'incurring', 'generates', 'generated', 'generating', 'have', 'had', 'amounts', 'rates', 'fees', 'payments', 'range', 'ranges', 'ranged', 'ranging',
];
const STOP = `(?:${[...new Set(STOP_WORDS)].join('|')})`;
const DURATION = '(?:minutes?|hours?|days?|weeks?|months?|years?|mins?|hrs?)';
const MODIFIER = `(?!(?:applications?|${STOP})(?=\\s|$))(?:[a-z]+(?:-(?!(?:dollars?|bucks?|cents?)\\b)[a-z]+)*|\\d{1,3}(?:st|nd|rd|th)|\\d{1,9}(?:\\.\\d{1,2})?(?:-|\\s+)${DURATION})`;
const VISIT = `(?:${MODIFIER}\\s+){0,8}(?:service-)?visit\\b(?!-[a-z])`;
const VISITS = `(?:${MODIFIER}\\s+){0,8}(?:service-)?visits\\b(?!-[a-z])`;
const SINGULAR_DET = '(?:a|an|one|the|your|our|my|their|his|her|its|this|that)';
const PLURAL_DET = '(?:the|your|our|my|their|his|her|its|these|those)';
const APPLICATION_DET = `(?:each|every|any|${SINGULAR_DET}|${PLURAL_DET})`;
const ONE_VISIT = `(?:${SINGULAR_DET}\\s+)?${VISIT}`;
const MANY_VISITS = `(?:${PLURAL_DET}\\s+)?${VISITS}`;
const EACH_VISIT = `(?:each|every|any)\\s+(?:${VISIT}|${VISITS})`;
const RECURRING = `(?:${EACH_VISIT}|${MANY_VISITS})`;
const SINGLE_VISIT = `(?:${ONE_VISIT})`;
const PREFIXED_VISIT = `(?:${EACH_VISIT}|${ONE_VISIT}|${MANY_VISITS})`;
const WEEKDAY = '(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)';
const TEMPORAL_POSSESSIVE = `(?:today|tomorrow|yesterday|(?:(?:this|next|last)\\s+)?${WEEKDAY})'s`;
const APPLICATION = `(?:${MODIFIER}\\s+){0,4}applications?\\b(?!-[a-z])`;
const PREFIXED_APPLICATION = `(?:${APPLICATION_DET}\\s+)?${APPLICATION}`;

const PATTERNS = [
  ['unit', `(?:(?:on\\s+(?:a|the)\\s+)?visit-by-visit(?:\\s+basis)?\\b(?!-[a-z])|(?:-?per[\\s-]+|/\\s*|by\\s+)${PREFIXED_VISIT}|(?:for|on|at)\\s+${RECURRING})`],
  ['application', `(?:-?per[\\s-]+|for\\s+|/\\s*)${PREFIXED_APPLICATION}`],
  ['application', PREFIXED_APPLICATION],
  ['timing', `(?:on|at)\\s+(?:${TEMPORAL_POSSESSIVE}\\s+${VISIT}|${SINGLE_VISIT})`],
  ['forVisit', `for\\s+${SINGLE_VISIT}`],
  ['eachVisit', EACH_VISIT],
  ['visits', MANY_VISITS],
  ['visit', ONE_VISIT],
  ['period', '(?:/\\s*|per\\s+)(?:months?|mos?|years?|yrs?)\\b(?!-[a-z])'],
  ['period', '(?:monthly|yearly|annually|annual)\\b(?!-[a-z])'],
].map(([kind, source]) => ({ kind, re: new RegExp(source, 'iy') }));

const PERIOD_PATTERNS = [
  ...PATTERNS.filter((pattern) => pattern.kind === 'period'),
  ...[
    // "a month ago", "a month or two ago", "a year and a half ago" stay temporal.
    '(?:a|each|every)\\s+(?:months?|mos?|years?|yrs?)\\b(?!-[a-z]|(?:\\s+(?:or|and)\\s+(?:a\\s+)?(?:[a-z]+|\\d+)(?:\\s+[a-z]+)?)?\\s+ago\\b)',
    'for\\s+the\\s+(?:months?|mos?|years?|yrs?)\\b(?!-[a-z])',
    // "every calendar month", "per calendar year": the calendar qualifier is
    // part of the period, never a separate word.
    '(?:per|a|each|every)\\s+calendar\\s+(?:months?|mos?|years?|yrs?)\\b(?!-[a-z])',
    'annualized\\b(?!-[a-z])',
  ].map((source) => ({ kind: 'period', re: new RegExp(source, 'iy') })),
];

function previousCharacter(source, at) {
  const previousCodeUnit = source.charCodeAt(at - 1);
  const previousWidth = previousCodeUnit >= 0xdc00 && previousCodeUnit <= 0xdfff ? 2 : 1;
  return source.slice(Math.max(0, at - previousWidth), at);
}

function matchUnitPatternsAt(source, at, patterns) {
  if (typeof source !== 'string' || source.length > 8192
    || Buffer.byteLength(source, 'utf8') > 8192
    || !Number.isInteger(at) || at < 0 || at >= source.length) return null;
  if (/[\p{L}\p{N}\p{M}_]/u.test(previousCharacter(source, at)) && !/[-/]/.test(source[at])) return null;
  let longest = null;
  for (const pattern of patterns) {
    pattern.re.lastIndex = at;
    const matched = pattern.re.exec(source);
    if (matched && /^(?:[\p{L}\p{N}\p{M}_]|-[\p{L}\p{N}\p{M}_])/u
      .test(source.slice(at + matched[0].length))) continue;
    if (matched && (!longest || matched[0].length > longest.text.length)) {
      longest = { kind: pattern.kind, text: matched[0], start: at, end: at + matched[0].length };
    }
  }
  if (longest?.kind === 'period') {
    longest.period = /(?:mo|month)/i.test(longest.text) ? 'month' : 'year';
  }
  return longest;
}

function matchEmailReplyUnitAt(source, at = 0) {
  return matchUnitPatternsAt(source, at, PATTERNS);
}

// Separate period candidates retain periods embedded inside a longer visit token.
function matchEmailReplyPeriodAt(source, at = 0) {
  return matchUnitPatternsAt(source, at, PERIOD_PATTERNS);
}

module.exports = { matchEmailReplyUnitAt, matchEmailReplyPeriodAt };
