/**
 * Lawn copy guards (lawn report rebuild P11).
 *
 * Pure checks for MODEL-written lawn report copy. P14's v6 writer runs
 * checkLawnModelCopy on every model field and falls back to the deterministic
 * string on any failure. This PR wires nothing: the live narrative overlay
 * (lawn-report-narrative.js safeText / the rain-window regexes) keeps running
 * untouched until P14 replaces it behind GATE_LAWN_REPORT_COPY_V6.
 *
 * The model owns prose only, and the timing rule is a CLOSED WORLD: model copy
 * contains no time language and no numbers of its own. Day and week windows
 * reach a customer only through approved expectation-row sentences copied
 * verbatim (facts.approvedSentences). It also never writes watering / rain /
 * mowing text (the banner and the water card own those), weekdays, dates or
 * clock times (the server prints those), progress words that contradict the
 * progress engine, pesticide safety claims, or efficacy guarantees.
 *
 * No DB: this module requires only activity-indicators (findBannedCustomerCopy,
 * a pure regex list) and nothing that loads models/db.js. The tests pin that.
 *
 * Rules (each exported as a check returning an array of reasons; a reason is
 * { rule, match, detail? }). Everything except sub_day_duration, reentry_figure
 * and the checks that read no facts runs on the text with approved sentences
 * removed (timing, numeric, progress_coupling):
 *   timing             any time-unit word (second ... year, season, night,
 *                      overnight, wk/hr/min/mo/yr, daily/weekly ...) or
 *                      relative-time word (next, coming, following, within, soon,
 *                      shortly, later, "a while", ago, yesterday, eventually),
 *                      immediacy (immediately, right away, at once, straight
 *                      away, instantly) or relative day (today, tomorrow,
 *                      tonight, this evening, this afternoon, weekend, noon,
 *                      midnight). "today's" is the one allowed form. One shared
 *                      list feeds this rule and the re-entry rule.
 *   numeric            NO digits at all: any digit, fraction, spelled number word
 *                      or ordinal. There is no score allowance; the score ring,
 *                      trend chart and other deterministic surfaces print every
 *                      number.
 *   sub_day_duration   any second / minute / hour word anywhere, approved
 *                      sentences included. Absolute.
 *   reentry_figure     keep ... off / stay off / wait / dry in a sentence with ANY
 *                      time word, relative-time word, number word or digit.
 *                      Absolute: approved sentences are not exempt.
 *   water_mow          G7: water, irrigation, sprinkler, zone, rain, moisture,
 *                      damp, mow, run time. dry / drier / drought only when
 *                      facts.droughtFlagged (a technician drought flag).
 *   weekday_clock      G9: weekdays, tomorrow / tonight / noon / weekend, dates,
 *                      clock times (4 PM, 4pm, 16:00).
 *   progress_coupling  G5: improving / worse / on track / behind ... only when
 *                      the supplied progress state says so. "up" / "down" /
 *                      "higher" / "lower" in a score or trend sense ("is down",
 *                      "up since") are progress claims too. "behind" is a
 *                      progress claim unless a spatial noun follows ("behind the
 *                      house"). A negator anywhere in the same sentence ("not
 *                      improving", "no longer behind", "is not higher")
 *                      rejects whatever states were supplied.
 *   banned_copy        G1/G6: the shared findBannedCustomerCopy list (cleared,
 *                      resolved, gone, guarantee, fixed re-entry figures ...).
 *   safety_claim       AGENTS.md: no pesticide is "safe" (pet-safe, safe for kids,
 *                      non-toxic, kid-friendly, natural, organic ...; "organic
 *                      matter" is fine only when the sentence does not mention
 *                      the product or treatment). Only a
 *                      sentence that is exactly "safe once dry" (subject: the
 *                      lawn, turf, grass, yard, area or surface, never a product
 *                      or treatment) is allowed.
 *   overpromise        G1: lawn-only list the shared list lacks (eliminate,
 *                      cure, permanent, ordinance, blackout, county ...).
 *
 * facts = {
 *   approvedSentences: string[]  sentences the writer was told to copy verbatim
 *                      from approved rows; exempt from timing, numeric and
 *                      progress rules only (every other rule still applies).
 *   allowedNumbers:    INERT. Accepted and ignored; it can license nothing.
 *   progress:          'up' | 'down' | 'flat' | 'unknown'  overall direction.
 *   progressStates:    string[]  per-item states (on_track, ahead, behind,
 *                      too_early, unclear).
 *   droughtFlagged:    boolean   a technician drought flag exists.
 * }
 *
 * allowedText is REMOVED (it fed the old whole-phrase allowlist). A window the
 * writer may quote is an approved sentence, not a licensed phrase.
 *
 * Normalization: ONE canonical form (NFKC, folded quotes/dashes, lossless vulgar
 * fractions, collapsed whitespace, digits split from attached letters) is built
 * once at the entry point and cut into one sentence list; every rule reads that
 * list case-insensitively and none reads raw text. A single newline is plain
 * whitespace; a sentence ends at . ! ? or a blank line. approvedSentences go
 * through the same normalization and match exactly on that form.
 *
 * Judgment calls (documented, tested):
 *  - Over-rejection is deliberate: "next visit", "warm-season turf", "one area",
 *    "half of the front" fall back to deterministic copy.
 *  - "coverage" is NOT denied (lead's WATERING_WORDS denies it for sprinkler
 *    coverage; "thin coverage" is ordinary turf talk). Sprinkler coverage is
 *    caught by "sprinkler".
 */

const { findBannedCustomerCopy } = require('./activity-indicators');

// ---------------------------------------------------------------------------
// Normalization

// ONE canonical normalization feeds every rule. normalizeCopy runs once at the
// entry point and splitSentences cuts the result into one sentence list; every
// check reads that list, case-insensitively, and none reads raw text:
//  - vulgar fractions become their exact lossless form ("1½" -> "1 1/2", "1¼" ->
//    "1 1/4"), never a shared lossy key
//  - NFKC (fullwidth and compatibility forms), Arabic-Indic digits to ASCII
//  - curly quotes and apostrophes, every dash and the unicode minus folded;
//    zero-width characters dropped
//  - every whitespace run, single newlines included, becomes one space; a blank
//    line is a paragraph break
//  - digits are separated from attached letters ("5hours" -> "5 hours", "5th" ->
//    "5 th", "5ft" -> "5 ft"), so an attached suffix is always a multi-part
//    expression the score allowance rejects
//  - 1,000 -> 1000; a.m. / p.m. -> am / pm
const VULGAR_FRACTIONS = {
  '½': '1/2', '¼': '1/4', '¾': '3/4', '⅓': '1/3', '⅔': '2/3', '⅕': '1/5', '⅖': '2/5', '⅗': '3/5', '⅘': '4/5',
  '⅙': '1/6', '⅚': '5/6', '⅐': '1/7', '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8', '⅑': '1/9', '⅒': '1/10',
};
const VULGAR_RE = new RegExp(`[${Object.keys(VULGAR_FRACTIONS).join('')}]`, 'g');
const FOLDS = [
  [/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)],
  [/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)],
  [/[‘’ʼ′]/g, () => "'"],
  [/[“”″]/g, () => '"'],
  [/[‐-―−﹘－]/g, () => '-'],
  [/⁄/g, () => '/'],
  [/[​-‍⁠﻿]/g, () => ''],
];

// "p.m." / "a.m." fold to "pm" / "am". When the period ends the sentence ("7
// p.m. Stay off") it is kept; mid-sentence ("7 a.m. to 9", "7 a.m. Monday") it is
// not. A sentence ends there only when the next word starts with a capital that
// is not a weekday or month name.
const MERIDIEM_CONTINUATION_RE = /^\s+(?:mon|tues?|wed|thu(?:rs?)?|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/i;
function foldMeridiem(match, letter, offset, whole) {
  const rest = whole.slice(offset + match.length);
  const ended = match.endsWith('.') && (rest === '' || (/^\s+["'(]?[A-Z]/.test(rest) && !MERIDIEM_CONTINUATION_RE.test(rest)));
  return `${letter.toLowerCase()}m${ended ? '.' : ''}`;
}

function canonicalParagraph(paragraph) {
  return paragraph
    .replace(/\s+/g, ' ')
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/(\d)(?=[a-z])/gi, '$1 ')
    .replace(/\b([ap])\.\s?m\b\.?/gi, foldMeridiem)
    .trim();
}

function normalizeOnce(text) {
  const t = FOLDS.reduce(
    (acc, [re, fn]) => acc.replace(re, fn),
    String(text == null ? '' : text).replace(VULGAR_RE, (f) => ` ${VULGAR_FRACTIONS[f]} `).normalize('NFKC')
  );
  return t.replace(/\r\n?/g, '\n').split(/\n\s*\n/).map(canonicalParagraph).filter(Boolean).join('\n\n');
}

// The canonical form is a fixpoint: normalizeCopy(normalizeCopy(x)) ===
// normalizeCopy(x). The transformations are ordered so one pass is enough (digits
// are separated from letters before "p.m." folds); the loop, capped at 3, is the
// belt to that brace, so approval matching and every guard see the same text.
function normalizeCopy(text) {
  let current = normalizeOnce(text);
  for (let i = 0; i < 3; i += 1) {
    const next = normalizeOnce(current);
    if (next === current) break;
    current = next;
  }
  return current;
}

// A sentence ends at . ! ? or a blank line, never at a single newline, and never
// at the period of a common abbreviation ("approx. thirty minutes" stays one
// sentence). Joining is conservative: a wider sentence can only reject more.
const ABBREVIATIONS = new Set([
  'approx', 'apprx', 'est', 'e.g', 'i.e', 'etc', 'vs', 'no', 'min', 'hr', 'hrs', 'mins', 'sec', 'secs', 'ft', 'in',
  'oz', 'lb', 'lbs', 'gal', 'qt', 'pt', 'mr', 'mrs', 'ms', 'dr', 'st',
]);
const endsWithAbbreviation = (chunk) => {
  const last = (chunk.match(/([A-Za-z][A-Za-z.]*)\.$/) || [])[1];
  return Boolean(last) && ABBREVIATIONS.has(last.toLowerCase());
};

function splitParagraph(paragraph) {
  return paragraph.split(/(?<=[.!?])\s+/).reduce((out, chunk) => {
    if (out.length && endsWithAbbreviation(out[out.length - 1])) out[out.length - 1] += ` ${chunk}`;
    else out.push(chunk);
    return out;
  }, []);
}

function splitSentences(text) {
  return normalizeCopy(text).split('\n\n').flatMap(splitParagraph).filter(Boolean);
}

// Every check takes raw text or an already-split sentence list.
const sentencesOf = (input) => (Array.isArray(input) ? input : splitSentences(input));
const globalOf = (re) => new RegExp(re.source, 'gi');

function sentenceKey(s) {
  return splitSentences(s).map((x) => x.toLowerCase().replace(/[\s.!?;:,"']+$/g, '').trim()).join(' ');
}

// ---------------------------------------------------------------------------
// Closed-world timing and number rule (G3)
//
// Model copy carries NO timing language and NO numbers of its own. Day and week
// windows reach a customer only through approved expectation-row sentences
// copied verbatim (facts.approvedSentences), which this rule never reads. In
// everything else the model writes it rejects, with no quantity parsing:
//   - any time-unit word (second ... year, season, night, overnight, wk/hr/min/
//     mo/yr, and the daily/weekly/monthly forms),
//   - any relative-time phrase (next, coming, following, within, soon, shortly,
//     later, "a while", ago, yesterday, eventually),
//   - any spelled number word (one ... ninety, hundred, dozen, half, quarter),
//   - any digit or fraction, except the score allowance below.
// Over-rejection ("the next visit", "warm-season turf", "one area") is
// deliberate: the writer falls back to the deterministic copy.

const TIME_WORDS_SRC = 'seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|wks?|months?|mos?|years?|yrs?|seasons?|nights?|overnight|decades?|fortnights?|hourly|nightly|daily|weekly|biweekly|monthly|yearly|annual(?:ly)?';
const TIME_WORD_RE = new RegExp(`\\b(?:${TIME_WORDS_SRC})\\b`, 'i');
const RELATIVE_TIME_RE = /\b(?:next|coming|following|within|soon|shortly|later|ago|yesterday|eventually)\b|\ba\s+while\b/i;
const IMMEDIATE_RE = /\b(?:immediate(?:ly)?|instant(?:ly)?)\b|\bright\s+away\b|\bat\s+once\b|\bstraight\s+away\b/i;
// "today" is timing, but not the possessive: "not seen in today's photos" is the
// one approved absence phrasing (G6) and the banner says "today's treatment".
const TIMING_RELATIVE_DAY_RE = /\btoday\b(?!'s)|\b(?:tomorrow|tonight|weekends?|noon|midnight)\b|\bthis\s+(?:evening|afternoon)\b/i;
// "until" / "after" plus any time word is covered because every time word, relative
// day and number is in the one shared list below.
const TIMING_RES = [TIME_WORD_RE, RELATIVE_TIME_RE, IMMEDIATE_RE, TIMING_RELATIVE_DAY_RE];

// Number vocabulary is built from parts, not enumerated: cardinals zero..ninety-
// nine by their word parts plus the scales, and ordinals first..ninety-ninth and
// the scale ordinals by theirs. "twenty-one" and "ninety-ninth" reject through
// their parts.
const UNIT_WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const TEEN_WORDS = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS_WORDS = ['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALE_WORDS = ['hundred', 'thousand', 'million', 'billion', 'trillion'];
const IRREGULAR_ORDINALS = {
  one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth',
};
const ordinalOf = (word) => IRREGULAR_ORDINALS[word] || (word.endsWith('y') ? `${word.slice(0, -1)}ieth` : `${word}th`);
const CARDINAL_WORDS = ['zero', ...UNIT_WORDS, ...TEEN_WORDS, ...TENS_WORDS];
const ORDINAL_WORDS = [...UNIT_WORDS, ...TEEN_WORDS, ...TENS_WORDS, ...SCALE_WORDS].map(ordinalOf);
const FRACTION_WORDS = ['half', 'halves', 'quarter', 'quarters', 'third', 'thirds'];
const wordsRe = (words) => new RegExp(`\\b(?:${words.join('|')})\\b`, 'i');
const NUMBER_WORD_RE = new RegExp(`${wordsRe([...CARDINAL_WORDS, ...FRACTION_WORDS]).source}|\\b(?:${[...SCALE_WORDS, 'dozen'].join('|')})s?\\b|\\ba\\s+(?:score|couple)\\s+of\\b`, 'i');
const ORDINAL_WORD_RE = wordsRe(ORDINAL_WORDS);
// any time word, relative phrase, number word, ordinal or digit
const ANY_TIMING_RE = new RegExp([...TIMING_RES, NUMBER_WORD_RE, ORDINAL_WORD_RE].map((re) => re.source).concat('\\d').join('|'), 'i');

// No digits, number words, fractions or ordinals at all outside approved
// sentences. The score ring, trend chart and other deterministic surfaces print
// every number, so the model never needs to; there is no score allowance.
// facts.allowedNumbers is accepted and ignored. Fractions are digits after
// normalization ("1/2"), so they reject too.
const NUMBER_FORMS = [
  { re: /\S*\d\S*/g, detail: 'digit' },
  { re: new RegExp(NUMBER_WORD_RE.source, 'gi'), detail: 'spelled number' },
  { re: new RegExp(ORDINAL_WORD_RE.source, 'gi'), detail: 'ordinal' },
];

function checkNumbers(input) {
  return sentencesOf(input).flatMap((sentence) => NUMBER_FORMS.flatMap(({ re, detail }) => (sentence.match(re) || [])
    .map((match) => ({ rule: 'numeric', match, detail: `${detail} in model copy` }))));
}

function checkTimingLanguage(input) {
  return sentencesOf(input).flatMap((sentence) => TIMING_RES.flatMap((re) => (sentence.match(globalOf(re)) || [])
    .map((m) => ({ rule: 'timing', match: m, detail: 'no time language outside approved sentences' }))));
}

// ---------------------------------------------------------------------------
// Water / rain / mow deny (G7, lead WATERING_WORDS)

// Mirrors lawn-report-lead WATERING_WORDS (water, irrigat, sprinkl, moist,
// dry family, drought, damp, \brain) minus "coverage", plus the G7 words.
const WATER_MOW_DENY_RE = /water|irrigat|sprinkl|moist|damp|\brain|\bzones?\b|\brun\s*times?\b|\bsoak|\bhose|\bhosing|\bwet(?:ting|ness|ter|ted)?\b|\bmow|\bcut(?:ting)?\s+(?:the\s+|your\s+)?(?:grass|lawn|turf)\b|\bcutting\s+height\b|\bheight\s+of\s+cut\b|\b(?:raise|lower)\s+(?:the\s+|your\s+)?(?:deck|blade)\b/i;
const DRY_DROUGHT_RE = /\bdr(?:y|ier|ies|ied|ying|yness)\b|drought/i;

function checkWaterMowDeny(input, facts = {}) {
  return sentencesOf(input).flatMap((sentence) => {
    const reasons = [];
    const first = sentence.match(WATER_MOW_DENY_RE);
    if (first) reasons.push({ rule: 'water_mow', match: first[0], detail: 'model copy never writes watering, rain or mowing' });
    const dry = !facts.droughtFlagged && sentence.match(DRY_DROUGHT_RE);
    if (dry) reasons.push({ rule: 'water_mow', match: dry[0], detail: 'dry / drought needs a technician drought flag' });
    return reasons;
  });
}

// ---------------------------------------------------------------------------
// Weekday / date / clock deny (G9)

const WEEKDAY_FULL_RE = /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:'s|s|s')?\b/i;
// Abbreviations collide with words (sun, sat, wed, mon), so they count only in
// date context, in any case: followed by a digit or a time-of-day word ("FRI
// MORNING", "fri morning", "Wed 4 PM"), or by a period ("Tue.", "fri."). The one
// plain word kept out of the period rule is lowercase "sun" ("needs full sun.");
// "Sun." and "SUN." still count.
const WEEKDAY_ABBR_CONTEXT_RE = /\b(?:mon|tues?|wed|thu(?:rs?)?|fri|sat|sun)\b(?=\s*[,.]?\s*\d|\s+(?:morning|afternoon|evening|night)\b)/i;
const WEEKDAY_ABBR_DOT_RE = /\b(?:mon|tues?|wed|thu(?:rs?)?|fri|sat)\./i;
const WEEKDAY_SUN_DOT_RE = /\b(?:Sun|SUN)\./;
const RELATIVE_DAY_RE = /\b(?:tomorrow|tonight|noon|midnight|weekends?|this\s+(?:evening|afternoon)|later\s+today|the\s+day\s+after)\b/i;
const MONTH_SRC = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DATE_RE = new RegExp(`\\b${MONTH_SRC}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b|\\b\\d{1,2}\\s*(?:st|nd|rd|th)\\s+of\\s+${MONTH_SRC}\\b|\\b\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}\\b|\\b(?:1[0-2]|[1-9])\\/(?:1[3-9]|2\\d|3[01])\\b`, 'i');
const CLOCK_RE = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b(?:[01]?\d|2[0-3]):[0-5]\d\b|\b\d{1,2}\s*o'?clock\b/i;

const WEEKDAY_CLOCK_RES = [WEEKDAY_FULL_RE, WEEKDAY_ABBR_CONTEXT_RE, WEEKDAY_ABBR_DOT_RE, WEEKDAY_SUN_DOT_RE, RELATIVE_DAY_RE, DATE_RE, CLOCK_RE];

function checkWeekdayClockDeny(input) {
  return sentencesOf(input).flatMap((sentence) => WEEKDAY_CLOCK_RES
    .map((re) => sentence.match(re))
    .filter(Boolean)
    .map((m) => ({ rule: 'weekday_clock', match: m[0] })));
}

// ---------------------------------------------------------------------------
// Progress-word coupling (G5)

const UP_WORDS_RE = /\bimprov\w*|\brecover\w*|\bbetter\b|\brespond(?:s|ed|ing)?\b|\brebound\w*|\bbounc\w*\s+back|\bon\s+the\s+mend\b|\bturn(?:ed|ing)?\s+the\s+corner\b|\bgaining\s+ground\b|\bheal(?:s|ed|ing)?\b|\bincreas\w*|\brose\b|\brising\b|\brisen\b|\bclimb\w*/i;
const DOWN_WORDS_RE = /\bworse\w*|\bworsen\w*|\bdeclin\w*|\bdeteriorat\w*|\bregress\w*|\bslipp\w*|\bslid\b|\bdropp\w*|\bgetting\s+worse\b|\bgone\s+downhill\b|\bfell\b|\bfalling\b|\bfallen\b|\bdecreas\w*|\bdip(?:s|ped|ping)?\b|\bsank\b/i;
// "behind" is a progress claim ("behind schedule", "behind the expected pace")
// unless a spatial noun follows ("behind the house", "behind the back fence").
const SPATIAL_NOUNS = '(?:house|home|fence|shed|pool|garage|driveway|patio|deck|hedge|tree|building|wall|gate|mailbox|lanai)s?';
const BEHIND_PROGRESS_RE = new RegExp(`\\bbehind\\b(?!\\s+(?:(?:the|your|our|a|an|this|that|each|every)\\s+)?(?:[\\w'-]+\\s+){0,2}?${SPATIAL_NOUNS}\\b)`, 'i');
// "up" / "down" count as a progress claim only in a score or trend sense: after
// a copula or movement word ("is down", "went up", "is not down") or before a
// comparison ("up from", "down since", "up a bit"). Phrasal uses ("pick up
// debris") are not claims. Comparatives count only after a copula or before "than".
const DIRECTION_RE = /\b(?:up|down)\b/gi;
const DIRECTION_BEFORE_RE = /\b(?:is|are|was|were|be|been|being|am|went|go|goes|going|gone|moved|moves|moving|trending|trended|stayed|stays|staying|got|gets|getting|come|came|comes|coming|ticked|swung|not|never|no|only|just|still|now|currently)\b|\b\w+n't\b/i;
const DIRECTION_AFTER_RE = /^\s+(?:from|since|over|compared|versus|vs|again|overall|slightly|somewhat|by|this|today|a\s+(?:bit|little|touch))\b/i;
const HIGHER_RE = /(?<=\b(?:is|are|was|were)\s+(?:\w+\s+){0,3})higher\b|\bhigher(?=\s+than\b)/i;
const LOWER_RE = /(?<=\b(?:is|are|was|were)\s+(?:\w+\s+){0,3})lower\b|\blower(?=\s+than\b)/i;

function directionMatches(sentence, word) {
  return [...sentence.matchAll(DIRECTION_RE)].filter((m) => m[0].toLowerCase() === word).filter((m) => {
    const before = sentence.slice(0, m.index).split(/[.!?;:]/).pop().trim().split(/\s+/).slice(-3).join(' ');
    return DIRECTION_BEFORE_RE.test(before) || DIRECTION_AFTER_RE.test(sentence.slice(m.index + m[0].length));
  });
}

const ITEM_PHRASES = [
  { state: 'on_track', re: /\bon[- ]track\b/i },
  { state: 'ahead', re: /\bahead\s+of\s+(?:schedule|pace|expectations?|where)\b/i },
  { state: 'behind', re: BEHIND_PROGRESS_RE },
  { state: 'too_early', re: /\btoo\s+early\b/i },
  { state: 'flat', re: /\bhold(?:s|ing)?\s+steady\b|\bheld\s+steady\b|\bunchanged\b|\bno\s+(?:real\s+)?change\b/i },
];

const stateKey = (s) => String(s || '').toLowerCase().replace(/[\s-]+/g, '_');

// A negator ANYWHERE in a sentence that carries a progress, state, direction or
// comparative claim ("not improving", "no longer behind", "hasn't improved",
// "is not higher") flips its meaning, so it rejects whatever states were
// supplied. The matched claim words themselves are not searched ("no change").
const NEGATOR_RE = /\b(?:not|no|never|nor|without|hardly|barely|cannot|none)\b|\b\w+n't\b/i;
const isNegated = (sentence, m) => NEGATOR_RE.test(`${sentence.slice(0, m.index)} ${sentence.slice(m.index + m[0].length)}`);

const matchesOf = (re, t) => [...t.matchAll(new RegExp(re.source, 'gi'))];

function judgeProgressMatch(m, t, ok, reasonDetail) {
  if (isNegated(t, m)) return { rule: 'progress_coupling', match: m[0], detail: 'negated progress word' };
  return ok ? null : { rule: 'progress_coupling', match: m[0], detail: reasonDetail };
}

function checkProgressSentence(sentence, checks) {
  return checks.flatMap(({ find, ok, detail }) => find(sentence).map((m) => judgeProgressMatch(m, sentence, ok, detail)).filter(Boolean));
}

const byRegex = (re) => (sentence) => matchesOf(re, sentence);

function checkProgressCoupling(input, facts = {}) {
  const dir = stateKey(facts.progress);
  const itemStates = new Set((Array.isArray(facts.progressStates) ? facts.progressStates : []).map(stateKey));
  const upDetail = `improving word with progress "${dir || 'unknown'}"`;
  const downDetail = `decline word with progress "${dir || 'unknown'}"`;
  const checks = [
    { find: byRegex(UP_WORDS_RE), ok: dir === 'up', detail: upDetail },
    { find: byRegex(HIGHER_RE), ok: dir === 'up', detail: upDetail },
    { find: (t) => directionMatches(t, 'up'), ok: dir === 'up', detail: upDetail },
    { find: byRegex(DOWN_WORDS_RE), ok: dir === 'down', detail: downDetail },
    { find: byRegex(LOWER_RE), ok: dir === 'down', detail: downDetail },
    { find: (t) => directionMatches(t, 'down'), ok: dir === 'down', detail: downDetail },
    ...ITEM_PHRASES.map(({ state, re }) => ({
      find: byRegex(re),
      ok: state === 'flat' ? (dir === 'flat' || itemStates.has('flat')) : itemStates.has(state),
      detail: `state "${state}" not supplied`,
    })),
  ];
  return sentencesOf(input).flatMap((sentence) => checkProgressSentence(sentence, checks));
}

// ---------------------------------------------------------------------------
// Banned re-entry pattern (SCOPE s3) and the keep-off regression lists

const REENTRY_TRIGGER_RE = /\bkeep(?:ing)?\b.*\boff\b|\bstay(?:ing|s)?\s+off\b|\bwait(?:ing|s|ed)?\b|\bdr(?:y|ies|ied|ying|ier)\b/i;
// Any time word, relative-time phrase, spelled number or digit in the same
// sentence as the trigger is a violation, whatever the facts say. Absolute:
// takes no facts, and approved sentences are NOT exempt.
function checkReentryPattern(input) {
  return sentencesOf(input).flatMap((sentence) => {
    const trig = sentence.match(REENTRY_TRIGGER_RE);
    const fig = trig && sentence.match(ANY_TIMING_RE);
    return trig && fig ? [{ rule: 'reentry_figure', match: sentence, detail: `"${trig[0]}" with "${fig[0]}"` }] : [];
  });
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

function checkBannerCopy(input) {
  const sentences = sentencesOf(input);
  return [...checkReentryPattern(sentences), ...checkBannedCopy(sentences)];
}

// ---------------------------------------------------------------------------
// Shared banned list + lawn-only overpromise list (G1, G6)

function checkBannedCopy(input) {
  return sentencesOf(input).flatMap((sentence) => findBannedCustomerCopy(sentence).map((match) => ({ rule: 'banned_copy', match })));
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

function checkOverpromise(input) {
  return sentencesOf(input)
    .map((sentence) => sentence.match(LAWN_EXTRA_BANNED_RE) || sentence.match(EFFICACY_CLAIM_RE))
    .filter(Boolean)
    .map((m) => ({ rule: 'overpromise', match: m[0] }));
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
// The idiom is a WHOLE sentence: optionally the lawn, turf, grass, yard, area or
// surface as the subject (never a product, treatment, pesticide, application or
// chemical, never a for-whom phrase), then a standalone "safe once dry", then
// optionally the technician confirming timing. "pet-safe once dry", "safe for
// pets once dry" and "this product is safe once dry" are all claims. The safety
// scan runs first; only a sentence that is exactly the idiom is exempted.
const SAFE_IDIOM_SENTENCE_RE = /^(?:(?:(?:the|your|these|those|this)\s+)?(?:treated\s+)?(?:lawn|turf|grass|yard|areas?|surfaces?)\s+(?:is|are|will\s+be|should\s+be|becomes?)\s+)?safe\s+once\s+(?:it\s+(?:is\s+|has\s+)?dr(?:y|ied)|it\s+dries|dr(?:y|ied))(?:,?\s+(?:and\s+)?your\s+technician\s+(?:will\s+)?confirms?\s+(?:the\s+)?timing)?[.!]?$/i;
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

// Once a sentence also mentions the applied product or treatment, ANY natural /
// organic / botanical word is a claim about it, including "organic matter".
const PRODUCT_CONTEXT_RE = /\b(?:products?|treatments?|applications?|applied|pesticides?|herbicides?|fungicides?|insecticides?|fertili[sz]ers?|sprays?|sprayed|granules?)\b|\btoday's\b/i;
const NATURAL_ANY_RE = /\b(?:all[- ])?(?:natural(?:ly)?|organic|botanical|plant-based|chemical-free)\b/i;

function naturalClaim(sentence) {
  return PRODUCT_CONTEXT_RE.test(sentence) ? sentence.match(NATURAL_ANY_RE) : sentence.match(NATURAL_CLAIM_RE);
}

function checkSafetyClaim(input) {
  return sentencesOf(input)
    .filter((sentence) => !SAFE_IDIOM_SENTENCE_RE.test(sentence))
    .map((sentence) => sentence.match(SAFETY_CLAIM_RE) || naturalClaim(sentence))
    .filter(Boolean)
    .map((m) => ({ rule: 'safety_claim', match: m[0] }));
}

// ---------------------------------------------------------------------------
// Entry point

// Approved sentences are normalized exactly like model text and matched exactly
// on that form (case aside), so "1½" and "1¼" are different sentences.
function withoutApproved(sentences, approved) {
  const keys = new Set((Array.isArray(approved) ? approved : []).filter((a) => typeof a === 'string').map(sentenceKey).filter(Boolean));
  return keys.size ? sentences.filter((sentence) => !keys.has(sentenceKey(sentence))) : sentences;
}

// Sub-day durations (hours, minutes, seconds) in MODEL copy. Every lawn
// expectation window is in days or weeks, and anything shorter is re-entry or
// watering timing, which the banner owns. So no hour/minute/second word is
// allowed anywhere, approved sentences included. Absolute: takes no facts.
const SUB_DAY_RE = /\b(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|hourly)\b|\bhalf[- ]hours?\b/gi;
function checkSubDayDuration(input) {
  return sentencesOf(input).flatMap((sentence) => (sentence.match(SUB_DAY_RE) || []).map((match) => ({ rule: 'sub_day_duration', match })));
}

function checkLawnModelCopy(text, facts = {}) {
  const sentences = typeof text === 'string' ? splitSentences(text) : [];
  if (!sentences.length) return { ok: false, reasons: [{ rule: 'empty', match: '' }] };
  const f = facts && typeof facts === 'object' ? facts : {};
  // Sentences copied verbatim from approved rows keep their own windows,
  // numbers and state words; every other rule still reads every sentence.
  const unapproved = withoutApproved(sentences, f.approvedSentences);
  const reasons = [
    ...checkTimingLanguage(unapproved),
    ...checkNumbers(unapproved),
    ...checkWaterMowDeny(sentences, f),
    ...checkWeekdayClockDeny(sentences),
    ...checkProgressCoupling(unapproved, f),
    ...checkReentryPattern(sentences),
    ...checkSubDayDuration(sentences),
    ...checkBannedCopy(sentences),
    ...checkOverpromise(sentences),
    ...checkSafetyClaim(sentences),
  ];
  return { ok: reasons.length === 0, reasons };
}

module.exports = {
  checkLawnModelCopy,
  checkTimingLanguage,
  checkNumbers,
  checkWaterMowDeny,
  checkWeekdayClockDeny,
  checkProgressCoupling,
  checkReentryPattern,
  checkSubDayDuration,
  checkBannedCopy,
  checkOverpromise,
  checkSafetyClaim,
  checkBannerCopy,
  normalizeCopy,
  KEEP_OFF_REJECT,
  BANNER_COPY_ACCEPT,
  WATER_MOW_DENY_RE,
  LAWN_EXTRA_BANNED_RE,
};
