// Anchored, bounded amount recognition. The caller normalizes reply copy and
// decides what a monetary or measurement token means in its clause.
const MAX_SOURCE_BYTES = 8192;

const DIGITS = '\\d{1,9}(?:,\\d{3}){0,3}(?:\\.\\d{1,2})?';
const NUMERIC_RANGE = `${DIGITS}(?:\\s*(?:-|to)\\s*(?:(?:\\$\\s*|usd\\s+))?${DIGITS})?`;
const ONE_TO_NINETEEN = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)';
const TENS = '(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)';
const UNDER_HUNDRED = `(?:${ONE_TO_NINETEEN}|${TENS}(?:[-\\s](?:one|two|three|four|five|six|seven|eight|nine))?)`;
const WORD_JOIN = '(?:\\s+|-)';
const WRITTEN = `(?:(?:a|one|two|three|four|five|six|seven|eight|nine)${WORD_JOIN}hundred(?:${WORD_JOIN}(?:and${WORD_JOIN})?${UNDER_HUNDRED})?|${UNDER_HUNDRED})`;
const PREFIXED_VALUE = `(?:\\.\\d{1,2}|${NUMERIC_RANGE})`;
const CURRENCY = `(?:(?:\\$\\s*|\\busd\\s+)${PREFIXED_VALUE}|\\b${NUMERIC_RANGE}(?:\\s+|-)(?:dollars?|bucks?|cents?|usd)\\b|\\b${WRITTEN}(?:\\s+|-)(?:dollars?|bucks?|cents?)\\b|\\b${DIGITS}\\s*¢)`;
const MONEY = `(?:${CURRENCY})(?:\\s*\\+(?!\\s*(?:tax(?:es)?|fees?)\\b)|\\s+(?:and\\s+up|or\\s+more))?`;

const DURATION = '(?:minutes?|hours?|days?|weeks?|months?|years?|mins?|hrs?)';
const MEASURE_SPAN = `(?:between\\s+${DIGITS}\\s+and\\s+${DIGITS}|from\\s+${DIGITS}\\s+to\\s+${DIGITS}|${DIGITS}\\s*(?:-|to)\\s*${DIGITS}|${DIGITS}|${WRITTEN})`;
const MEASUREMENT = `(?:${MEASURE_SPAN}\\s+(?:${DURATION}|photos?|pictures?|points?|ounces?|gallons?|reminders?)|${DIGITS}(?:mins?|hrs?))\\b`;
const NUMBER = `(?:${DIGITS}\\s*(?:-|to)\\s*${DIGITS}|${DIGITS})`;

const MATCHERS = [
  ['money', MONEY],
  ['measurement', MEASUREMENT],
  ['number', NUMBER],
].map(([kind, source]) => ({ kind, re: new RegExp(source, 'iy') }));

const LEFT_JOIN = /[\p{L}\p{N}_.$¢,'‘’\-]/u;
const LETTER = /\p{L}/u;
const RIGHT_JOIN = /[\p{L}\p{N}_¢]/u;
const DIGIT = /\d/;
const OPEN_QUOTE_PUNCT = new Set(['(', '[', '{', ':', ';', ',', '"', '“', '‘']);

function openingQuoteBefore(source, at) {
  if (!['\'', '‘', '’'].includes(source[at - 1])) return false;
  if (at === 1) return true;
  const before = source[at - 2];
  return /\s/u.test(before) || OPEN_QUOTE_PUNCT.has(before);
}

function validEnd(source, end) {
  const next = source[end];
  if (!next) return true;
  if (RIGHT_JOIN.test(next)) return false;
  if ((next === '.' || next === ',') && DIGIT.test(source[end + 1] || '')) return false;
  if ((next === '-' || next === "'") && RIGHT_JOIN.test(source[end + 1] || '')) return false;
  return true;
}

function matchEmailReplyAmountAt(source, at = 0) {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES
    || !Number.isInteger(at) || at < 0 || at >= source.length) return null;
  if (at > 0 && LEFT_JOIN.test(source[at - 1])
    && !(source[at] === '$' && (LETTER.test(source[at - 1]) || source[at - 1] === ','))
    && !openingQuoteBefore(source, at)) return null;

  let longest = null;
  for (const { kind, re } of MATCHERS) {
    re.lastIndex = at;
    const match = re.exec(source);
    if (!match) continue;
    const end = at + match[0].length;
    if (!validEnd(source, end)) continue;
    if (!longest || end > longest.end) {
      longest = { kind, text: match[0], start: at, end };
    }
  }
  return longest;
}

module.exports = { matchEmailReplyAmountAt };
