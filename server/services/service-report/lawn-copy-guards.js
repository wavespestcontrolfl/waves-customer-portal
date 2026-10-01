/**
 * Lawn copy guards (lawn report rebuild P11).
 *
 * Pure checks for MODEL-written lawn report copy. P14's v6 writer runs
 * checkLawnModelCopy on every model field and falls back to the deterministic
 * string on any failure. This PR wires nothing: the live narrative overlay
 * (lawn-report-narrative.js safeText / the rain-window regexes) keeps running
 * untouched until P14 replaces it behind GATE_LAWN_REPORT_COPY_V6.
 *
 * The model owns prose only. It never writes numbers the facts did not hand it,
 * watering / rain / mowing text (the banner and the water card own those),
 * weekdays, dates or clock times (the server prints those), progress words that
 * contradict the progress engine, or a stay-off / wait / dry sentence carrying
 * an hours or minutes figure (banned re-entry pattern, SCOPE s3).
 *
 * No DB: this module requires only activity-indicators (findBannedCustomerCopy,
 * a pure regex list) and nothing that loads models/db.js. The tests pin that.
 *
 * Rules (each exported as a check returning an array of reasons; a reason is
 * { rule, match, detail? }):
 *   numeric            G3: number+unit / range / spelled / vague timing phrases
 *                      must appear in facts.allowedText; bare numbers and
 *                      non-time measures (inches, %, degrees) in
 *                      facts.allowedNumbers.
 *   water_mow          G7: water, irrigation, sprinkler, zone, rain, moisture,
 *                      damp, mow, run time. dry / drier / drought only when
 *                      facts.droughtFlagged (a technician drought flag).
 *   weekday_clock      G9: weekdays, tomorrow / tonight / noon / weekend, dates,
 *                      clock times (4 PM, 4pm, 16:00).
 *   progress_coupling  G5: improving / worse / on track ... only when the
 *                      supplied progress state says so.
 *   reentry_figure     SCOPE s3: keep ... off / stay off / wait / dry in the same
 *                      sentence as an hours or minutes figure.
 *   banned_copy        G1/G6: the shared findBannedCustomerCopy list (cleared,
 *                      resolved, gone, guarantee, fixed re-entry figures ...).
 *   safety_claim       AGENTS.md: no pesticide is "safe" (pet-safe, safe for kids,
 *                      non-toxic, kid-friendly, natural, organic ...). Only the
 *                      "safe once dry" re-entry idiom is allowed.
 *   overpromise        G1: lawn-only list the shared list lacks (eliminate,
 *                      cure, permanent, ordinance, blackout, county ...).
 *
 * facts = {
 *   allowedText:       string[]  approved sentences / windows whose number+unit
 *                      phrases the model may repeat ("3 to 7 days").
 *   allowedNumbers:    number[]  score values etc. (licenses bare numbers and
 *                      non-time units; never licenses "7 days").
 *   approvedSentences: string[]  sentences the writer was told to copy verbatim
 *                      from approved rows; exempt from numeric and progress
 *                      rules only (every other rule still applies).
 *   progress:          'up' | 'down' | 'flat' | 'unknown'  overall direction.
 *   progressStates:    string[]  per-item states (on_track, ahead, behind,
 *                      too_early, unclear).
 *   droughtFlagged:    boolean   a technician drought flag exists.
 * }
 *
 * Judgment calls (documented, tested):
 *  - Spelled numbers count only next to a unit: "two weeks" is the same token as
 *    "2 weeks"; a bare "two issues" is not checked (too many false positives).
 *  - "2 weeks" never matches a "14 days" row, and "7 days" never matches a
 *    "3 to 7 days" row: no unit conversion, no range splitting. Fail closed.
 *  - "a week", "an hour", "every week", "next week", "overnight", "within the
 *    week", "a few days", "a couple of hours" are timing claims and need a row.
 *    "this week" and "last week" are not.
 *  - "coverage" is NOT denied (lead's WATERING_WORDS denies it for sprinkler
 *    coverage; "thin coverage" is ordinary turf talk). Sprinkler coverage is
 *    caught by "sprinkler".
 */

const { findBannedCustomerCopy } = require('./activity-indicators');

// ---------------------------------------------------------------------------
// Normalization

const VULGAR_FRACTIONS = {
  '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅕': 0.2, '⅖': 0.4, '⅗': 0.6, '⅘': 0.8,
  '⅙': 1 / 6, '⅚': 5 / 6, '⅐': 1 / 7, '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875, '⅑': 1 / 9, '⅒': 0.1,
};
const VULGAR_CLASS = Object.keys(VULGAR_FRACTIONS).join('');

function normalizeCopy(text) {
  let t = String(text == null ? '' : text);
  t = t.normalize('NFC')
    .replace(/[     ]/g, ' ')
    .replace(/[​‌‍﻿]/g, '')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/′/g, "'")
    .replace(/″/g, '"');
  // "1½" / "1 ½" -> 1.5 ; "½" -> 0.5
  // fullwidth and Arabic-Indic digits read as ASCII digits
  t = t.replace(/[\uff10-\uff19]/g, (d) => String(d.charCodeAt(0) - 0xff10))
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  t = t.replace(new RegExp(`(\\d)\\s*([${VULGAR_CLASS}])`, 'g'), (_, whole, f) => ` ${round(Number(whole) + VULGAR_FRACTIONS[f])}`);
  t = t.replace(new RegExp(`[${VULGAR_CLASS}]`, 'g'), (f) => ` ${round(VULGAR_FRACTIONS[f])}`);
  // 1,000 -> 1000
  t = t.replace(/(\d),(?=\d{3}\b)/g, '$1');
  // a.m. / p.m. -> am / pm so the period does not split a sentence
  t = t.replace(/\b([ap])\.\s?m\b\.?/gi, '$1m');
  return t;
}

function splitSentences(text) {
  return normalizeCopy(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function sentenceKey(s) {
  return normalizeCopy(s).toLowerCase().replace(/[\s.!?;:,"']+$/g, '').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Numeric whitelist (G3)

// Number words. A spelled quantity is tokenized as a WHOLE phrase and parsed
// by parseNumberWords; a phrase the parser cannot read in full is an
// "unparsed" token that is always rejected, never partially matched (so "two
// hundred days" can never be licensed by "one hundred days", and "twenty-one"
// is read as 21, not as the suffix "one").
const ONES = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
};
const TEENS = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const FRACTIONS = { half: 0.5, quarter: 0.25, quarters: 0.25 };
const NUMBER_WORDS = new Set([
  ...Object.keys(ONES), ...Object.keys(TEENS), ...Object.keys(TENS), ...Object.keys(FRACTIONS),
  'hundred', 'thousand', 'dozen',
]);

const NUMWORD_SRC = `(?:${[...NUMBER_WORDS].sort((a, b) => b.length - a.length).join('|')})`;
// integers, decimals with or without a leading digit (".5", "0.5", "1.5"),
// fractions ("1/2") and mixed numbers ("1 1/2")
const DIGIT_SRC = '(?:\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d*\\.\\d+|\\d+)';
// One whole number phrase: digits, or a run of number words joined by space,
// hyphen or "and" ("twenty-one", "two hundred and five"). Greedy, so the phrase
// is never cut at its tail.
const NUMRUN_SRC = `(?:${DIGIT_SRC}|${NUMWORD_SRC}(?![a-z])(?:(?:[-\\s]+(?:and\\s+)?)${NUMWORD_SRC}(?![a-z]))*)`;
const VAGUE_SRC = '(?:a\\s+few|a\\s+couple(?:\\s+of)?|couple(?:\\s+of)?|several|a\\s+handful(?:\\s+of)?|a\\s+number\\s+of|few)';
// A quantity: a vague word (optionally glued to number words, which is
// unparsed), an article plus a number phrase ("a hundred"), a number phrase,
// or a bare article ("a week").
const QTY_SRC = `(?:${VAGUE_SRC}(?:[-\\s]+${NUMRUN_SRC})?|(?:an?[-\\s]+)?${NUMRUN_SRC}|an?(?![a-z]))`;
const CADENCE_SRC = '(?:every\\s+other|every|each\\s+other|each|per)';
const RANGE_SEP_SRC = '(?:\\s*-\\s*|\\s+to\\s+|\\s+or\\s+|\\s+through\\s+|\\s+thru\\s+)';
const UNIT_SRC = '(days?|weeks?|wks?|hours?|hrs?|minutes?|mins?|seconds?|secs?|months?|mos?|years?|yrs?|inch(?:es)?|in\\.|"|%|percent|per\\s?cent|degrees?|°|feet|foot|ft)';

function unitKey(raw) {
  const u = raw.toLowerCase().replace(/\s+/g, '');
  if (/^days?$/.test(u)) return 'day';
  if (/^(?:weeks?|wks?)$/.test(u)) return 'week';
  if (/^(?:hours?|hrs?)$/.test(u)) return 'hour';
  if (/^(?:minutes?|mins?)$/.test(u)) return 'minute';
  if (/^(?:seconds?|secs?)$/.test(u)) return 'second';
  if (/^(?:months?|mos?)$/.test(u)) return 'month';
  if (/^(?:years?|yrs?)$/.test(u)) return 'year';
  if (/^(?:inch(?:es)?|in\.|")$/.test(u)) return 'inch';
  if (/^(?:%|percent)$/.test(u)) return 'percent';
  if (/^(?:degrees?|°)$/.test(u)) return 'degree';
  if (/^(?:feet|foot|ft)$/.test(u)) return 'foot';
  return u;
}
const TIME_UNITS = new Set(['day', 'week', 'hour', 'minute', 'second', 'month', 'year']);

// Whole-phrase parse of spelled numbers. Returns NaN for any phrase that is not
// a complete, well-formed number ("one two", "twenty twenty", "twenty hundred",
// "one and half").
function parseNumberWords(phrase) {
  const tokens = phrase.toLowerCase().split(/[-\s]+/).filter(Boolean);
  if (!tokens.length) return NaN;
  let total = 0;
  let group = 0;
  let last = 'start'; // start | O (1-9) | E (10-19) | T (20-90) | H (hundred) | K (thousand) | Z | END
  let pendingAnd = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const w = tokens[i];
    if (last === 'END' || last === 'Z') return NaN;
    if (w === 'and') {
      if (!(last === 'H' || last === 'K') || pendingAnd || i === tokens.length - 1) return NaN;
      pendingAnd = true;
      continue;
    }
    const startsGroup = last === 'start' || last === 'H' || last === 'K';
    if (w === 'zero') {
      if (last !== 'start' || tokens.length !== 1) return NaN;
      last = 'Z';
    } else if (w in ONES) {
      if (!(startsGroup || last === 'T')) return NaN;
      group += ONES[w];
      last = 'O';
    } else if (w in TEENS) {
      if (!startsGroup) return NaN;
      group += TEENS[w];
      last = 'E';
    } else if (w in TENS) {
      if (!startsGroup) return NaN;
      group += TENS[w];
      last = 'T';
    } else if (w === 'hundred') {
      if (!(last === 'start' || last === 'O' || last === 'E')) return NaN;
      group = (group || 1) * 100;
      last = 'H';
    } else if (w === 'thousand') {
      if (last === 'K') return NaN;
      total += (group || 1) * 1000;
      group = 0;
      last = 'K';
    } else if (w === 'dozen') {
      if (!(last === 'start' || last === 'O') || total) return NaN;
      group = (group || 1) * 12;
      last = 'END';
    } else if (w in FRACTIONS) {
      if (!(last === 'start' || last === 'O') || total) return NaN;
      if (w === 'quarters' && last === 'start') return NaN;
      group = (group || 1) * FRACTIONS[w];
      last = 'END';
    } else {
      return NaN;
    }
    if (pendingAnd && last !== 'END') pendingAnd = false;
  }
  if (pendingAnd) return NaN;
  return total + group;
}

function atomValue(raw) {
  const a = raw.trim();
  let m = a.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  m = a.match(/^(\d+)\/(\d+)$/);
  if (m) return Number(m[1]) / Number(m[2]);
  if (/^\d*\.?\d+$/.test(a)) return Number(a);
  return parseNumberWords(a);
}

const round = (n) => Math.round(n * 1000) / 1000;

// Reads one quantity (no cadence, no unit) as
//   { kind: 'num', value } | { kind: 'vague', phrase } | { kind: 'unparsed' }.
// A vague word is its own exact phrase ("several", "a couple of", "a few" and
// "few" are four distinct keys); a vague word glued to number words
// ("a couple hundred") is unparsed.
function readQuantity(raw) {
  const q = raw.toLowerCase().trim().replace(/\s+/g, ' ');
  if (/^an?$/.test(q)) return { kind: 'num', value: 1 };
  const vague = q.match(new RegExp(`^(${VAGUE_SRC})(?:[-\\s]+(.+))?$`));
  if (vague) return vague[2] ? { kind: 'unparsed' } : { kind: 'vague', phrase: vague[1].replace(/\s+/g, ' ') };
  const art = q.match(/^an?[-\s]+(.+)$/);
  if (art) {
    // "a hundred", "a thousand", "a dozen", "a half", "a quarter" only
    return /^(?:hundred|thousand|dozen|half|quarter)$/.test(art[1])
      ? { kind: 'num', value: parseNumberWords(art[1]) }
      : { kind: 'unparsed' };
  }
  const value = atomValue(q);
  return Number.isNaN(value) ? { kind: 'unparsed' } : { kind: 'num', value };
}

// The word before a match. A match that starts right after a number word, a
// digit, an article or "number and" means the regex caught only the tail of a
// longer quantity ("one and a half hours" -> "half hours"): unparsed.
function startsMidQuantity(src, start) {
  const before = src.slice(0, start);
  const m = before.match(/([a-z0-9./]+)[\s-]*$/);
  if (!m) return false;
  const w = m[1];
  if (/^\d/.test(w) || NUMBER_WORDS.has(w) || /^(?:an?|few|couple|several|handful)$/.test(w)) return true;
  if (w === 'and') {
    const p = before.match(/([a-z0-9./]+)\s+and[\s-]*$/);
    return Boolean(p && (/^\d/.test(p[1]) || NUMBER_WORDS.has(p[1])));
  }
  return false;
}

// Every number-ish claim in the text as { key, kind, unit, values[], match }.
// The key is the FULL normalized timing phrase: cadence ("every", "every
// other", "each"), the complete quantity (parsed number, range, or the exact
// vague phrase) and the unit. Case, whitespace, dashes, "to" vs "-" in ranges
// and digits vs spelled numbers are the only things normalized away.
function extractNumericTokens(text) {
  // "half an hour" is the quantity "half" and the unit "hour"
  const src = normalizeCopy(text).toLowerCase().replace(/\bhalf\s+an?\b/g, 'half');
  const tokens = [];
  const masked = src.split('');
  const mask = (start, end) => { for (let i = start; i < end; i += 1) masked[i] = ' '; };

  // 1. [cadence] [quantity [range end]] unit
  const quantRe = new RegExp(
    `(?<![\\w.])(?:(?<cad>${CADENCE_SRC})[-\\s]+)?(?:(?<q1>${QTY_SRC})(?:${RANGE_SEP_SRC}(?<q2>${QTY_SRC}))?[-\\s]*(?:(?:more|full|whole|additional|extra)[-\\s]+)?)?${UNIT_SRC}(?![a-z])`,
    'g'
  );
  let m;
  while ((m = quantRe.exec(src)) !== null) {
    const { cad, q1, q2 } = m.groups;
    const full = m[0];
    const unitRaw = m[4];
    if (!cad && !q1) { quantRe.lastIndex = m.index + 1; continue; }
    const unit = unitKey(unitRaw);
    // cadence alone needs a time unit ("every 3 feet" is not a timing claim)
    if (cad && !q1 && !TIME_UNITS.has(unit)) { quantRe.lastIndex = m.index + 1; continue; }
    const cadence = cad ? cad.replace(/\s+/g, ' ') : '';
    const a = q1 ? readQuantity(q1) : null;
    const b = q2 ? readQuantity(q2) : null;
    let token;
    if (startsMidQuantity(src, m.index) || (a && a.kind === 'unparsed') || (b && b.kind === 'unparsed')
      || (b && (a.kind !== 'num' || b.kind !== 'num'))) {
      token = { key: `unparsed:${full.trim()}`, kind: 'unparsed', unit, values: [] };
    } else if (a && a.kind === 'vague') {
      token = { key: `${cadence}|v:${a.phrase}|${unit}`, kind: 'vague', unit, values: [] };
    } else if (a) {
      const vals = b ? [round(Math.min(a.value, b.value)), round(Math.max(a.value, b.value))] : [round(a.value)];
      token = { key: `${cadence}|n:${vals.join('-')}|${unit}`, kind: cadence ? 'cadence' : 'num', unit, values: vals };
    } else {
      token = { key: `${cadence}||${unit}`, kind: 'cadence', unit, values: [] };
    }
    token.match = full.trim();
    tokens.push(token);
    mask(m.index, m.index + full.length);
  }

  // 2. overnight / next|coming|following unit / within the unit
  const relRe = new RegExp(
    `\\bovernight\\b|\\b(?:next|coming|following)\\s+(?:(?:few|couple\\s+of|several)\\s+)?${UNIT_SRC}|\\bwithin\\s+the\\s+(day|week|month|hour)\\b`,
    'g'
  );
  while ((m = relRe.exec(masked.join(''))) !== null) {
    const full = m[0];
    const unit = m[1] ? unitKey(m[1]) : (m[2] ? unitKey(m[2]) : null);
    if (/^overnight$/.test(full)) tokens.push({ key: 'overnight', kind: 'vague', unit: 'night', values: [], match: full });
    else if (/^within/.test(full)) tokens.push({ key: `within:${unit}`, kind: 'vague', unit, values: [], match: full });
    else if (TIME_UNITS.has(unit)) tokens.push({ key: `next:${unit}`, kind: 'vague', unit, values: [], match: full });
    else continue;
    mask(m.index, m.index + full.length);
  }

  // 3. bare numbers left over (scores, "up 5 points", fractions without a unit)
  const rest = masked.join('');
  const bareRe = new RegExp(`(?<![\\w.])${DIGIT_SRC}(?![\\w])`, 'g');
  while ((m = bareRe.exec(rest)) !== null) {
    const raw = m[0];
    const pieces = /^\d+\s+\d+\/\d+$/.test(raw) ? raw.split(/[\s/]+/)
      : /^\d+\/\d+$/.test(raw) ? raw.split('/')
        : [raw];
    pieces.forEach((p) => {
      const v = round(Number(p));
      tokens.push({ key: `${v}`, kind: 'num', unit: '', values: [v], match: p });
    });
  }
  return tokens;
}

function toNumberSet(list) {
  const set = new Set();
  (Array.isArray(list) ? list : []).forEach((n) => {
    const v = typeof n === 'number' ? n : Number(String(n).replace(/[^\d.\-]/g, ''));
    if (Number.isFinite(v)) set.add(round(v));
  });
  return set;
}

function checkNumericWhitelist(text, facts = {}) {
  const allowedKeys = new Set();
  (Array.isArray(facts.allowedText) ? facts.allowedText : []).forEach((row) => {
    extractNumericTokens(row).forEach((t) => { if (t.unit && t.kind !== 'unparsed') allowedKeys.add(t.key); });
  });
  const allowedNumbers = toNumberSet(facts.allowedNumbers);
  const reasons = [];
  extractNumericTokens(text).forEach((t) => {
    if (t.kind === 'unparsed') {
      reasons.push({ rule: 'numeric', match: t.match, detail: 'quantity could not be read in full' });
      return;
    }
    if (allowedKeys.has(t.key)) return;
    // Scores and other supplied numbers license bare numbers and non-time
    // measures. They never license a duration: a score of 7 is not "7 days".
    if (t.kind === 'num' && !TIME_UNITS.has(t.unit) && t.values.length && t.values.every((v) => allowedNumbers.has(v))) return;
    reasons.push({ rule: 'numeric', match: t.match, detail: 'not in the facts allowlist' });
  });
  return reasons;
}

// ---------------------------------------------------------------------------
// Water / rain / mow deny (G7, lead WATERING_WORDS)

// Mirrors lawn-report-lead WATERING_WORDS (water, irrigat, sprinkl, moist,
// dry family, drought, damp, \brain) minus "coverage", plus the G7 words.
const WATER_MOW_DENY_RE = /water|irrigat|sprinkl|moist|damp|\brain|\bzones?\b|\brun\s*times?\b|\bsoak|\bhose|\bhosing|\bwet(?:ting|ness|ter|ted)?\b|\bmow|\bcut(?:ting)?\s+(?:the\s+|your\s+)?(?:grass|lawn|turf)\b|\bcutting\s+height\b|\bheight\s+of\s+cut\b|\b(?:raise|lower)\s+(?:the\s+|your\s+)?(?:deck|blade)\b/i;
const DRY_DROUGHT_RE = /\bdr(?:y|ier|ies|ied|ying|yness)\b|drought/i;

function checkWaterMowDeny(text, facts = {}) {
  const t = normalizeCopy(text);
  const reasons = [];
  const first = t.match(WATER_MOW_DENY_RE);
  if (first) reasons.push({ rule: 'water_mow', match: first[0], detail: 'model copy never writes watering, rain or mowing' });
  if (!facts.droughtFlagged) {
    const d = t.match(DRY_DROUGHT_RE);
    if (d) reasons.push({ rule: 'water_mow', match: d[0], detail: 'dry / drought needs a technician drought flag' });
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// Weekday / date / clock deny (G9)

const WEEKDAY_FULL_RE = /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:'s|s|s')?\b/i;
// Abbreviations collide with words (sun, sat, wed, mon): only the forms that
// read as a date ("Wed 4 PM", "Tue.", "Thu, 5th") count.
const WEEKDAY_ABBR_RE = /\b(?:Mon|Tues?|Wed|Thu(?:rs?)?|Fri|Sat|Sun|MON|TUES?|WED|THU(?:RS?)?|FRI|SAT|SUN)(?:\.|(?=\s+\d)|(?=,\s*\d)|(?=\s+(?:morning|afternoon|evening|night)\b))/;
const RELATIVE_DAY_RE = /\b(?:tomorrow|tonight|noon|midnight|weekends?|this\s+(?:evening|afternoon)|later\s+today|the\s+day\s+after)\b/i;
const MONTH_SRC = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DATE_RE = new RegExp(`\\b${MONTH_SRC}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b|\\b\\d{1,2}(?:st|nd|rd|th)\\s+of\\s+${MONTH_SRC}\\b|\\b\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}\\b|\\b(?:1[0-2]|[1-9])\\/(?:1[3-9]|2\\d|3[01])\\b`, 'i');
const CLOCK_RE = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b(?:[01]?\d|2[0-3]):[0-5]\d\b|\b\d{1,2}\s*o'?clock\b/i;

function checkWeekdayClockDeny(text) {
  const t = normalizeCopy(text);
  const reasons = [];
  [WEEKDAY_FULL_RE, WEEKDAY_ABBR_RE, RELATIVE_DAY_RE, DATE_RE, CLOCK_RE].forEach((re) => {
    const m = t.match(re);
    if (m) reasons.push({ rule: 'weekday_clock', match: m[0] });
  });
  return reasons;
}

// ---------------------------------------------------------------------------
// Progress-word coupling (G5)

const UP_WORDS_RE = /\bimprov\w*|\brecover\w*|\bbetter\b|\brespond(?:s|ed|ing)?\b|\brebound\w*|\bbounc\w*\s+back|\bon\s+the\s+mend\b|\bturn(?:ed|ing)?\s+the\s+corner\b|\bgaining\s+ground\b|\bheal(?:s|ed|ing)?\b/i;
const DOWN_WORDS_RE = /\bworse\w*|\bworsen\w*|\bdeclin\w*|\bdeteriorat\w*|\bregress\w*|\bslipp\w*|\bslid\b|\bdropp\w*|\bgetting\s+worse\b|\bgone\s+downhill\b/i;
const ITEM_PHRASES = [
  { state: 'on_track', re: /\bon[- ]track\b/i },
  { state: 'ahead', re: /\bahead\s+of\s+(?:schedule|pace|expectations?|where)\b/i },
  { state: 'behind', re: /\bbehind\b(?!\s+(?:the|your|our|a|an|this|that|each|every|them|it)\b)/i },
  { state: 'too_early', re: /\btoo\s+early\b/i },
  { state: 'flat', re: /\bhold(?:s|ing)?\s+steady\b|\bheld\s+steady\b|\bunchanged\b|\bno\s+(?:real\s+)?change\b/i },
];

const stateKey = (s) => String(s || '').toLowerCase().replace(/[\s-]+/g, '_');

function checkProgressCoupling(text, facts = {}) {
  const t = normalizeCopy(text);
  const dir = stateKey(facts.progress);
  const itemStates = new Set((Array.isArray(facts.progressStates) ? facts.progressStates : []).map(stateKey));
  const reasons = [];
  const up = t.match(UP_WORDS_RE);
  if (up && dir !== 'up') reasons.push({ rule: 'progress_coupling', match: up[0], detail: `improving word with progress "${dir || 'unknown'}"` });
  const down = t.match(DOWN_WORDS_RE);
  if (down && dir !== 'down') reasons.push({ rule: 'progress_coupling', match: down[0], detail: `decline word with progress "${dir || 'unknown'}"` });
  ITEM_PHRASES.forEach(({ state, re }) => {
    const m = t.match(re);
    if (!m) return;
    const ok = state === 'flat' ? (dir === 'flat' || itemStates.has('flat')) : itemStates.has(state);
    if (!ok) reasons.push({ rule: 'progress_coupling', match: m[0], detail: `state "${state}" not supplied` });
  });
  return reasons;
}

// ---------------------------------------------------------------------------
// Banned re-entry pattern (SCOPE s3) and the keep-off regression lists

const REENTRY_TRIGGER_RE = /\bkeep(?:ing)?\b[^.!?]{0,40}\boff\b|\bstay(?:ing|s)?\s+off\b|\bwait(?:ing|s|ed)?\b|\bdr(?:y|ies|ied|ying|ier)\b/i;
// The figure is ANY hours or minutes quantity the numeric grammar reads: digits,
// every spelled number (thirteen through nineteen included, "a dozen"), ranges,
// "an hour", "half an hour", the vague forms (a few, a couple of, several), and
// any number phrase the parser cannot read in full. A bare cadence ("every
// hour") carries no figure. Nothing in `facts` can allow it.
const isReentryFigure = (t) => (t.unit === 'hour' || t.unit === 'minute')
  && !(t.kind === 'cadence' && !t.values.length);

function checkReentryPattern(text) {
  const reasons = [];
  splitSentences(text).forEach((s) => {
    const trig = s.match(REENTRY_TRIGGER_RE);
    const fig = trig && extractNumericTokens(s).find(isReentryFigure);
    if (trig && fig) reasons.push({ rule: 'reentry_figure', match: s, detail: `"${trig[0]}" with "${fig.match}"` });
  });
  return reasons;
}

// Strings from W5-plan.json tests[3] / fable-plan-review.md hand-off to W1:
// the shared list already rejects these; the natural-sounding hold copy must
// never reach a customer.
const KEEP_OFF_REJECT = [
  'Keep the sprinklers off for 24 hours.',
  'Keep the sprinklers off until Tue 7 PM (24 hours).',
  'Let the lawn dry for 2 hours.',
];
// Approved banner / hold phrasings. These are DETERMINISTIC banner copy (the
// model never writes them), so they pass the re-entry rules (reentry_figure +
// banned_copy), not the model-copy water deny.
const BANNER_COPY_ACCEPT = [
  'Pause the sprinklers for 24 hours.',
  'Pause the sprinklers until Thursday.',
  'Do not run the irrigation until Tuesday at 7 PM.',
  'Turn the sprinklers off for the next 24 hours.',
  'Skip your turf watering until Wed 4 PM.',
  "That gives today's treatment time to work.",
  "Water in today's treatment by Wed 12 PM.",
  'Run each zone about 40 minutes.',
  "That counts as one of this week's runs.",
  "No watering change from today's treatment.",
  "Follow this week's plan below.",
];

function checkBannerCopy(text) {
  return [...checkReentryPattern(text), ...checkBannedCopy(text)];
}

// ---------------------------------------------------------------------------
// Shared banned list + lawn-only overpromise list (G1, G6)

function checkBannedCopy(text) {
  return findBannedCustomerCopy(normalizeCopy(text)).map((match) => ({ rule: 'banned_copy', match }));
}

// The shared list lacks these; it is not edited (pest, rodent and T&S blast radius).
const LAWN_EXTRA_BANNED_RE = /\b(?:eliminat\w*|eradicat\w*|cure[sd]?|curing|guarantee\w*|permanent\w*|weed[- ]free|pest[- ]free|ordinance|blackout|county|counties)\b|\b100\s*%/i;

// Efficacy guarantees beyond the words above: "100 percent", "kills all weeds",
// "never come back", "forever", "for good", "once and for all", "no more
// weeds", "completely gone / controlled", "totally effective".
const EFFICACY_CLAIM_RE = new RegExp([
  '\\b100\\s*(?:percent|per\\s?cent)',
  '\\bkill(?:s|ed|ing)?\\s+(?:all|every|everything|100)\\b',
  "\\b(?:never|won'?t|will\\s+not|can'?t|cannot)\\s+(?:ever\\s+)?(?:(?:come|coming|grow|growing|appear)\\s+(?:back|again)|return|returning|reappear)\\b",
  '\\bnever\\s+(?:return|returns|returned|again)\\b',
  '\\bforever\\b',
  '\\bfor\\s+good\\b',
  '\\bonce\\s+and\\s+for\\s+all\\b',
  '\\bno\\s+more\\s+(?:weeds?|pests?|bugs?|insects?|grubs?|chinch(?:\\s+bugs?)?|disease|fungus)\\b',
  '\\b(?:completely|totally|fully|entirely)\\s+(?:gone|removed|controlled|cleared|stopped|protected|effective|cured)\\b',
  '\\b(?:fix(?:es|ed)?|solve[sd]?)\\s+(?:the|your)\\s+(?:problem|issue|lawn)\\s+(?:for\\s+good|completely|permanently)\\b',
  '\\bfool-?proof\\b',
  '\\bfail-?safe\\b',
].join('|'), 'i');

function checkOverpromise(text) {
  const t = normalizeCopy(text);
  const m = t.match(LAWN_EXTRA_BANNED_RE) || t.match(EFFICACY_CLAIM_RE);
  return m ? [{ rule: 'overpromise', match: m[0] }] : [];
}

// ---------------------------------------------------------------------------
// Pesticide safety claims (AGENTS.md compliance language). No treatment,
// product, pesticide, application or chemical is ever "safe", "safer",
// "harmless", "non-toxic", "pet-safe", "kid-friendly", "eco-friendly",
// "natural" or "organic"; and nothing is "safe for" pets, kids, people, family,
// wildlife or bees. The ONLY allowed idiom is the shared re-entry wording
// "safe once dry" / "once it dries" (activity-indicators.js comment, AGENTS.md:
// "the idiom is 'safe once dry' with the technician confirming timing"). The
// idiom carries no figure, and "dry" is still a water word for model copy (the
// banner owns re-entry), so model copy can only use it under a drought flag.
const SAFE_ONCE_DRY_RE = /\bsafe\s+once\s+(?:it\s+(?:is\s+|has\s+)?)?(?:dry|dried)\b|\bsafe\s+once\s+it\s+dries\b/gi;
const SAFETY_CLAIM_RE = new RegExp([
  '\\b(?:safe|safer|safest|safely|unsafe)\\b',
  '\\b(?:harmless|non-?\\s?toxic|toxic|poison\\w*|dangerous|hazardous|harmful|deadly)\\b',
  '\\b(?:kid|child|children|pet|family|people|human|eco|environment(?:ally)?|bee|wildlife|planet|earth)[-\\s]?friendly\\b',
  '\\bgentle\\s+(?:on|for|to)\\s+(?:pets?|kids?|children|people|family|bees|wildlife)\\b',
  '\\b(?:no|zero|without|free\\s+of)\\s+(?:risk|harm|danger|hazard)s?\\b',
  "\\b(?:(?:will|would|can|could)\\s+(?:not|never)|won'?t|wouldn'?t|does(?:n'?t|\\s+not)|do(?:n'?t|\\s+not)|can'?t|cannot)\\s+(?:ever\\s+)?(?:harm|hurt|injure|endanger|poison)\\b",
  '\\bnot\\s+(?:harmful|dangerous|hazardous|toxic|poisonous)\\b',
].join('|'), 'i');
// natural / organic as a claim about the treatment ("a natural treatment",
// "organic fertilizer"), not the agronomic sense ("organic matter in the thatch").
const NATURAL_CLAIM_RE = /\b(?:all[- ])?(?:natural(?:ly)?|organic(?!\s+(?:matter|material|debris|layer|buildup|content))|botanical|plant-based|chemical-free)\b(?:[^.!?]{0,40}\b(?:treatment|product|pesticide|application|chemical|spray|fertili[sz]er|herbicide|insecticide|fungicide|granules?|material|solution|control)s?\b)|\b(?:treatment|product|pesticide|application|chemical|spray|fertili[sz]er|herbicide|insecticide|fungicide|granules?|material|solution|control)s?\b[^.!?]{0,40}\b(?:all[- ])?(?:natural(?:ly)?|organic(?!\s+(?:matter|material|debris|layer|buildup|content))|botanical|plant-based|chemical-free)\b/i;

function checkSafetyClaim(text) {
  const t = normalizeCopy(text).replace(SAFE_ONCE_DRY_RE, ' ');
  const m = t.match(SAFETY_CLAIM_RE) || t.match(NATURAL_CLAIM_RE);
  return m ? [{ rule: 'safety_claim', match: m[0] }] : [];
}

// ---------------------------------------------------------------------------
// Entry point

function stripApprovedSentences(text, approved) {
  const keys = new Set((Array.isArray(approved) ? approved : []).map(sentenceKey).filter(Boolean));
  if (!keys.size) return normalizeCopy(text);
  return splitSentences(text).filter((s) => !keys.has(sentenceKey(s))).join(' ');
}

function checkLawnModelCopy(text, facts = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, reasons: [{ rule: 'empty', match: '' }] };
  }
  const f = facts && typeof facts === 'object' ? facts : {};
  // Sentences copied verbatim from approved rows keep their own numbers and
  // state words; every other rule still reads the full text.
  const unapproved = stripApprovedSentences(text, f.approvedSentences);
  const reasons = [
    ...checkNumericWhitelist(unapproved, f),
    ...checkWaterMowDeny(text, f),
    ...checkWeekdayClockDeny(text),
    ...checkProgressCoupling(unapproved, f),
    ...checkReentryPattern(text),
    ...checkBannedCopy(text),
    ...checkOverpromise(text),
    ...checkSafetyClaim(text),
  ];
  return { ok: reasons.length === 0, reasons };
}

module.exports = {
  checkLawnModelCopy,
  checkNumericWhitelist,
  checkWaterMowDeny,
  checkWeekdayClockDeny,
  checkProgressCoupling,
  checkReentryPattern,
  checkBannedCopy,
  checkOverpromise,
  checkSafetyClaim,
  checkBannerCopy,
  extractNumericTokens,
  normalizeCopy,
  KEEP_OFF_REJECT,
  BANNER_COPY_ACCEPT,
  WATER_MOW_DENY_RE,
  LAWN_EXTRA_BANNED_RE,
};
