// Anchored, bounded amount recognition. The caller normalizes reply copy and
// decides what a monetary or measurement token means in its clause.
const MAX_SOURCE_BYTES = 8192;

const DIGITS = '(?:\\d{1,3}(?:,\\d{3}){1,3}|\\d{1,9})(?:\\.\\d{1,2})?';
const RANGE_JOIN = '(?:\\s*-\\s*|\\s+to\\s+)';
const NUMERIC_RANGE = `${DIGITS}(?:${RANGE_JOIN}(?:(?:\\$\\s*|usd\\s+))?${DIGITS})?`;
const ONE_TO_NINETEEN = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)';
const TENS = '(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)';
const UNDER_HUNDRED = `(?:${ONE_TO_NINETEEN}|${TENS}(?:[-\\s](?:one|two|three|four|five|six|seven|eight|nine))?)`;
const WORD_JOIN = '(?:\\s+|-)';
const WRITTEN = `(?:(?:a|one|two|three|four|five|six|seven|eight|nine)${WORD_JOIN}hundred(?:${WORD_JOIN}(?:and${WORD_JOIN})?${UNDER_HUNDRED})?|${UNDER_HUNDRED})`;
const PREFIXED_VALUE = `(?:\\.\\d{1,2}|${NUMERIC_RANGE})`;
const CURRENCY = `(?:(?:\\$\\s*|\\busd\\s+)${PREFIXED_VALUE}|\\b${NUMERIC_RANGE}(?:\\s+|-)(?:dollars?|bucks?|cents?|usd)\\b|\\b${WRITTEN}(?:\\s+|-)(?:dollars?|bucks?|cents?)\\b|\\b${DIGITS}\\s*¢)`;
const ADDEND = `(?:(?:[a-z]+\\s+)?(?:tax(?:es)?|fees?)\\b|${CURRENCY}|\\d)`;
const MONEY = `(?:${CURRENCY})(?:\\+(?!\\s*${ADDEND})|\\s+\\+(?=\\s*(?:$|[.,!?;:)]))|\\s+(?:and\\s+up(?!\\s+to\\b)|or\\s+more)\\b(?![-\u2010\u2011]))?`;

const DURATION = '(?:minutes?|hours?|days?|weeks?|months?|years?|mins?|hrs?)';
const MEASURE_SPAN = `(?:between\\s+${DIGITS}\\s+and\\s+${DIGITS}|from\\s+${DIGITS}\\s+to\\s+${DIGITS}|${DIGITS}${RANGE_JOIN}${DIGITS}|${DIGITS}|${WRITTEN})`;
const MEASUREMENT = `(?:${MEASURE_SPAN}\\s+(?:${DURATION}|photos?|pictures?|points?|ounces?|gallons?|reminders?)|${DIGITS}(?:mins?|hrs?))\\b`;
const NUMBER = `(?:${DIGITS}${RANGE_JOIN}${DIGITS}|${DIGITS})`;

const MATCHERS = [
  ['money', MONEY],
  ['measurement', MEASUREMENT],
  ['number', NUMBER],
].map(([kind, source]) => ({ kind, re: new RegExp(source, 'iy') }));
const DIGITS_AT = new RegExp(DIGITS, 'iy');

const LEFT_JOIN = /[\p{L}\p{M}\p{N}\p{Sc}_.,'‘’\-]/u;
const LETTER = /\p{L}/u;
const RIGHT_JOIN = /[\p{L}\p{M}\p{N}\p{Sc}_]/u;
const DIGIT = /\d/;
const OPEN_QUOTE_PUNCT = new Set(['(', '[', '{', ':', ';', ',', '"', '“', '‘']);
const WRITTEN_PREFIX_WORDS = new Set([
  'a', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'hundred', 'and', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy',
  'eighty', 'ninety',
]);

function previousCodePoint(source, at) {
  if (at < 1) return null;
  let start = at - 1;
  const tail = source.charCodeAt(start);
  if (tail >= 0xDC00 && tail <= 0xDFFF && start > 0) {
    const head = source.charCodeAt(start - 1);
    if (head >= 0xD800 && head <= 0xDBFF) start -= 1;
  }
  return { text: source.slice(start, at), start };
}

function nextCodePoint(source, at) {
  return at < source.length ? String.fromCodePoint(source.codePointAt(at)) : null;
}

function openingQuoteBefore(source, previous) {
  if (!['\'', '‘', '’'].includes(previous.text)) return false;
  const before = previousCodePoint(source, previous.start)?.text;
  return !before || /\s/u.test(before) || OPEN_QUOTE_PUNCT.has(before);
}

function validStart(source, at) {
  const previous = previousCodePoint(source, at);
  return !previous || !LEFT_JOIN.test(previous.text)
    || (source[at] === '$' && (LETTER.test(previous.text) || previous.text === ','))
    || (previous.text === ',' && /^usd\s+/i.test(source.slice(at)))
    || openingQuoteBefore(source, previous);
}

function validEnd(source, end) {
  const next = nextCodePoint(source, end);
  if (!next) return true;
  if (next === '+' && source[end - 1] === '+') return false;
  if (next === '$') return false;
  if (RIGHT_JOIN.test(next)) return false;
  if ((next === '.' || next === ',') && /^[.,]+\d/.test(source.slice(end))) return false;
  if (['-', "'", '‘', '’'].includes(next)
    && RIGHT_JOIN.test(nextCodePoint(source, end + next.length) || '')) return false;
  return true;
}

function previousToken(source, at) {
  let end = at;
  while (end > 0 && /\s/u.test(source[end - 1])) end -= 1;
  if (end === 0) return null;
  let start = end;
  const last = source[end - 1];
  if (/[a-z]/i.test(last)) {
    while (start > 0 && /[a-z]/i.test(source[start - 1])) start -= 1;
  } else if (/[\d,.]/.test(last)) {
    while (start > 0 && /[\d,.]/.test(source[start - 1])) start -= 1;
  } else if (last === '-') {
    start -= 1;
  } else {
    return null;
  }
  return { text: source.slice(start, end).toLowerCase(), start, end };
}

function previousWrittenWord(source, at) {
  const token = previousToken(source, at);
  return token?.text === '-' ? previousToken(source, token.start) : token;
}

function fullDigitsAt(source, token) {
  DIGITS_AT.lastIndex = token.start;
  const match = DIGITS_AT.exec(source);
  return match && token.start + match[0].length === token.end;
}

function currencyPrefixStart(source, numberAt) {
  let before = numberAt;
  while (before > 0 && /\s/u.test(source[before - 1])) before -= 1;
  if (source[before - 1] === '$') return before - 1;
  const word = previousToken(source, numberAt);
  return word?.text === 'usd' ? word.start : numberAt;
}

function longerRangeCovers(source, start, at) {
  if (!validStart(source, start)) return false;
  for (const { re } of MATCHERS) {
    re.lastIndex = start;
    const match = re.exec(source);
    if (match && start + match[0].length > at
      && validEnd(source, start + match[0].length)) return true;
  }
  return false;
}

function insideEarlierRange(source, at) {
  const isNumericOrCurrency = DIGIT.test(source[at]) || source[at] === '$'
    || (source.slice(at, at + 3).toLowerCase() === 'usd' && /\s/u.test(source[at + 3] || ''));
  if (!isNumericOrCurrency) return false;
  if (DIGIT.test(source[at])) {
    const prefix = currencyPrefixStart(source, at);
    if (prefix !== at && longerRangeCovers(source, prefix, at)) return true;
  }
  const connector = previousToken(source, at);
  if (!connector) return false;
  if (['between', 'from'].includes(connector.text)) {
    return longerRangeCovers(source, connector.start, at);
  }
  if (!['to', 'and', '-'].includes(connector.text)) return false;
  const first = previousToken(source, connector.start);
  if (!first || !fullDigitsAt(source, first)) return false;
  if (longerRangeCovers(source, first.start, at)) return true;
  const prefix = currencyPrefixStart(source, first.start);
  if (prefix !== first.start && longerRangeCovers(source, prefix, at)) return true;
  const intro = previousToken(source, first.start);
  if (!intro || !['between', 'from'].includes(intro.text)) return false;
  return longerRangeCovers(source, intro.start, at);
}

function insideEarlierWrittenAmount(source, at) {
  if (!/[a-z]/i.test(source[at])) return false;
  let before = at;
  for (let words = 0; words < 4; words += 1) {
    const previous = previousWrittenWord(source, before);
    if (!previous || !WRITTEN_PREFIX_WORDS.has(previous.text)) return false;
    if (longerRangeCovers(source, previous.start, at)) return true;
    before = previous.start;
  }
  return false;
}

function matchEmailReplyAmountAt(source, at = 0) {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES
    || !Number.isInteger(at) || at < 0 || at >= source.length) return null;
  if (!validStart(source, at)) return null;
  if (insideEarlierRange(source, at)) return null;
  if (insideEarlierWrittenAmount(source, at)) return null;

  let longest = null;
  let invalidEnd = at;
  for (const { kind, re } of MATCHERS) {
    re.lastIndex = at;
    const match = re.exec(source);
    if (!match) continue;
    const end = at + match[0].length;
    if (!validEnd(source, end)) {
      invalidEnd = Math.max(invalidEnd, end);
      continue;
    }
    if (!longest || end > longest.end) {
      longest = { kind, text: match[0], start: at, end };
    }
  }
  return longest && longest.end >= invalidEnd ? longest : null;
}

module.exports = { matchEmailReplyAmountAt };
