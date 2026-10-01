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

const VULGAR_FRACTIONS = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875 };

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
  t = t.replace(/(\d)\s*([½¼¾⅓⅔⅛⅜⅝⅞])/g, (_, whole, f) => ` ${Number(whole) + VULGAR_FRACTIONS[f]}`);
  t = t.replace(/[½¼¾⅓⅔⅛⅜⅝⅞]/g, (f) => ` ${VULGAR_FRACTIONS[f]}`);
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

const ONES = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19,
};
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

const SPELLED_SRC = '(?:(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[-\\s]?(?:one|two|three|four|five|six|seven|eight|nine))?'
  + '|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen'
  + '|hundred|dozen|half(?:\\s+an?)?|a\\s+half|a\\s+quarter|quarter|three[-\\s]quarters?|one[-\\s]quarter|one[-\\s]half)';
const DIGIT_SRC = '(?:\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d+(?:\\.\\d+)?)';
const ATOM_SRC = `(?:${DIGIT_SRC}|${SPELLED_SRC})`;
const RANGE_SEP_SRC = '(?:\\s*-\\s*|\\s+to\\s+|\\s+or\\s+|\\s+through\\s+|\\s+thru\\s+)';
const VAGUE_SRC = '(?:a\\s+few|a\\s+couple(?:\\s+of)?|couple(?:\\s+of)?|several|a\\s+handful(?:\\s+of)?|a\\s+number\\s+of|few)';
const UNIT_SRC = '(days?|weeks?|hours?|hrs?|minutes?|mins?|months?|years?|inch(?:es)?|in\\.|"|%|percent|per\\s?cent|degrees?|°|feet|foot|ft)';

function unitKey(raw) {
  const u = raw.toLowerCase().replace(/\s+/g, '');
  if (/^days?$/.test(u)) return 'day';
  if (/^weeks?$/.test(u)) return 'week';
  if (/^(?:hours?|hrs?)$/.test(u)) return 'hour';
  if (/^(?:minutes?|mins?)$/.test(u)) return 'minute';
  if (/^months?$/.test(u)) return 'month';
  if (/^years?$/.test(u)) return 'year';
  if (/^(?:inch(?:es)?|in\.|")$/.test(u)) return 'inch';
  if (/^(?:%|percent)$/.test(u)) return 'percent';
  if (/^(?:degrees?|°)$/.test(u)) return 'degree';
  if (/^(?:feet|foot|ft)$/.test(u)) return 'foot';
  return u;
}
const TIME_UNITS = new Set(['day', 'week', 'hour', 'minute', 'month', 'year']);

function spelledValue(raw) {
  const w = raw.toLowerCase().trim().replace(/\s+/g, ' ');
  if (/^(?:half(?: an?)?|a half|one[- ]half)$/.test(w)) return 0.5;
  if (/^(?:a quarter|quarter|one[- ]quarter)$/.test(w)) return 0.25;
  if (/^three[- ]quarters?$/.test(w)) return 0.75;
  if (w === 'hundred') return 100;
  if (w === 'dozen') return 12;
  if (w in ONES) return ONES[w];
  const m = w.match(/^(\w+?)(?:[- ](\w+))?$/);
  if (m && m[1] in TENS) return TENS[m[1]] + (m[2] && m[2] in ONES ? ONES[m[2]] : 0);
  return NaN;
}

function atomValue(raw) {
  const a = raw.trim();
  let m = a.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  m = a.match(/^(\d+)\/(\d+)$/);
  if (m) return Number(m[1]) / Number(m[2]);
  if (/^\d/.test(a)) return Number(a);
  return spelledValue(a);
}

const round = (n) => Math.round(n * 1000) / 1000;

// Every number-ish claim in the text as { key, kind, unit, values[], match }.
function extractNumericTokens(text) {
  const src = normalizeCopy(text).toLowerCase();
  const tokens = [];
  const masked = src.split('');
  const mask = (start, end) => { for (let i = start; i < end; i += 1) masked[i] = ' '; };

  // 1. quantity (+ optional range) + unit, vague + unit, article/cadence + unit
  const quantRe = new RegExp(
    `(?<![\\w.])(?:(${VAGUE_SRC})|(${ATOM_SRC})(?:${RANGE_SEP_SRC}(${ATOM_SRC}))?|(an?|every\\s+other|every|each|per))[-\\s]*${UNIT_SRC}(?![a-z])`,
    'g'
  );
  let m;
  while ((m = quantRe.exec(src)) !== null) {
    const [full, vague, a1, a2, art, unitRaw] = m;
    const unit = unitKey(unitRaw);
    let token = null;
    if (vague) {
      token = { key: `vague:${unit}`, kind: 'vague', unit, values: [] };
    } else if (art) {
      if (/^an?$/.test(art)) token = { key: `1${unit}`, kind: 'num', unit, values: [1] };
      else token = { key: `every:${unit}`, kind: 'cadence', unit, values: [] };
    } else {
      const lo = atomValue(a1);
      const hi = a2 ? atomValue(a2) : null;
      if (Number.isNaN(lo) || (a2 && Number.isNaN(hi))) { quantRe.lastIndex = m.index + 1; continue; }
      const vals = a2 ? [round(Math.min(lo, hi)), round(Math.max(lo, hi))] : [round(lo)];
      token = { key: `${vals.join('-')}${unit}`, kind: 'num', unit, values: vals };
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
    extractNumericTokens(row).forEach((t) => { if (t.unit) allowedKeys.add(t.key); });
  });
  const allowedNumbers = toNumberSet(facts.allowedNumbers);
  const reasons = [];
  extractNumericTokens(text).forEach((t) => {
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
const REENTRY_FIGURE_SRC = '(?:\\d+(?:\\.\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty[-\\s]?five|forty|fifty|sixty|ninety|half\\s+an?|a\\s+half|a\\s+couple(?:\\s+of)?|a\\s+few|several|an?)';
const REENTRY_FIGURE_RE = new RegExp(`\\b${REENTRY_FIGURE_SRC}[-\\s]*(?:more\\s+)?(?:minutes?|mins?|hours?|hrs?|half[-\\s]?hours?)\\b`, 'i');

function checkReentryPattern(text) {
  const reasons = [];
  splitSentences(text).forEach((s) => {
    const trig = s.match(REENTRY_TRIGGER_RE);
    const fig = s.match(REENTRY_FIGURE_RE);
    if (trig && fig) reasons.push({ rule: 'reentry_figure', match: s, detail: `"${trig[0]}" with "${fig[0]}"` });
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

function checkOverpromise(text) {
  const m = normalizeCopy(text).match(LAWN_EXTRA_BANNED_RE);
  return m ? [{ rule: 'overpromise', match: m[0] }] : [];
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
  checkBannerCopy,
  extractNumericTokens,
  normalizeCopy,
  KEEP_OFF_REJECT,
  BANNER_COPY_ACCEPT,
  WATER_MOW_DENY_RE,
  LAWN_EXTRA_BANNED_RE,
};
