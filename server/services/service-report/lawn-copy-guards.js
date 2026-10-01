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
 *                      shortly, later, "a while", ago, yesterday, eventually).
 *   numeric            any spelled number word, and any digit or fraction except
 *                      the score allowance: a bare signed integer or "<n>
 *                      points" whose value, sign included, is in
 *                      facts.allowedNumbers ("-5", "minus 5", "down 5 points"
 *                      are -5; "+5", "plus 5", "up 5 points" are 5). The whole
 *                      expression is read first: "1 / 2", "72 / 100", "72 of
 *                      100", "3 - 4", "72 points%" reject whole.
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
 *                      the supplied progress state says so. "behind" is a
 *                      progress claim unless a spatial noun follows ("behind the
 *                      house"). A negator within three words before one ("not
 *                      improving", "no longer behind", "hasn't improved")
 *                      rejects whatever states were supplied.
 *   banned_copy        G1/G6: the shared findBannedCustomerCopy list (cleared,
 *                      resolved, gone, guarantee, fixed re-entry figures ...).
 *   safety_claim       AGENTS.md: no pesticide is "safe" (pet-safe, safe for kids,
 *                      non-toxic, kid-friendly, natural, organic ...). Only a
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
 *   allowedNumbers:    number[]  score values, signed.
 *   progress:          'up' | 'down' | 'flat' | 'unknown'  overall direction.
 *   progressStates:    string[]  per-item states (on_track, ahead, behind,
 *                      too_early, unclear).
 *   droughtFlagged:    boolean   a technician drought flag exists.
 * }
 *
 * allowedText is REMOVED (it fed the old whole-phrase allowlist). A window the
 * writer may quote is an approved sentence, not a licensed phrase.
 *
 * Sentences: a single newline is plain whitespace (line wraps never hide a
 * pattern); a sentence ends at . ! ? or at a blank line.
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

// Vulgar fractions become " 1/2 " (any digits keep the digit detector honest).
const VULGAR_CLASS = '½¼¾⅓⅔⅕⅖⅗⅘⅙⅚⅐⅛⅜⅝⅞⅑⅒';

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
  // fullwidth and Arabic-Indic digits read as ASCII digits
  t = t.replace(/[\uff10-\uff19]/g, (d) => String(d.charCodeAt(0) - 0xff10))
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  t = t.replace(new RegExp(`[${VULGAR_CLASS}]`, 'g'), ' 1/2 ');
  // 1,000 -> 1000
  t = t.replace(/(\d),(?=\d{3}\b)/g, '$1');
  // a.m. / p.m. -> am / pm so the period does not split a sentence
  t = t.replace(/\b([ap])\.\s?m\b\.?/gi, '$1m');
  return t;
}

// Line wraps are plain whitespace. A sentence ends at real sentence-ending
// punctuation or at a blank line (paragraph break), never at a single newline.
function splitSentences(text) {
  return normalizeCopy(text)
    .split(/\n\s*\n/)
    .flatMap((paragraph) => paragraph.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/))
    .filter(Boolean);
}

function sentenceKey(s) {
  return normalizeCopy(s).toLowerCase().replace(/[\s.!?;:,"']+$/g, '').replace(/\s+/g, ' ').trim();
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

const TIME_WORD_RE = /\b(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|wks?|months?|mos?|years?|yrs?|seasons?|nights?|overnight|decades?|fortnights?|hourly|nightly|daily|weekly|biweekly|monthly|yearly|annual(?:ly)?)\b/i;
const RELATIVE_TIME_RE = /\b(?:next|coming|following|within|soon|shortly|later|ago|yesterday|eventually)\b|\ba\s+while\b/i;
const NUMBER_WORD_RE = /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|dozen|half|halves|quarters?|thirds?)\b/i;
// any time word, relative phrase, number word or digit
const ANY_TIMING_RE = new RegExp([TIME_WORD_RE, RELATIVE_TIME_RE, NUMBER_WORD_RE].map((re) => re.source).concat('\\d').join('|'), 'i');

// The score allowance: a bare signed integer, optionally followed by "points".
// The sign is "-", "minus", "+", "plus", or "up"/"down" ("up 5 points" is +5,
// "down 5" is -5). The WHOLE numeric expression is tokenized before anything is
// allowed: digits joined by spaces or operators ("1 / 2", "72 / 100", "72 of
// 100", "3 - 4", "72 out of 100", "1.5") and a unit tail ("72 points%", "72%",
// "72 degrees") make the expression something other than a single integer, so
// it rejects whole instead of leaving a stripped fragment behind.
const NUM_TERM_SRC = '(?:\\d+(?:\\.\\d+)?|\\.\\d+)';
const NUM_JOIN_SRC = '(?:\\s*(?:[/\\-+x\u00d7*:,%\u00b0]|\\bof\\b|\\bout\\s+of\\b|\\bto\\b|\\bor\\b|\\band\\b)\\s*|\\s+)';
const NUMERIC_EXPR_RE = new RegExp(
  `(?<![\\w.])(?<sign>[+-]\\s*|minus\\s+|plus\\s+|(?:up|down)\\s+(?:by\\s+)?)?(?<expr>${NUM_TERM_SRC}(?:${NUM_JOIN_SRC}${NUM_TERM_SRC})*)(?<tail>(?:\\s+(?:points?|pts))?(?:\\s*(?:%|\u00b0|percent\\b|degrees?\\b))?)`,
  'gi'
);

function toNumberSet(list) {
  const set = new Set();
  (Array.isArray(list) ? list : []).forEach((n) => {
    const v = typeof n === 'number' ? n : Number(String(n).replace(/\u2212/g, '-').replace(/[^\d.-]/g, ''));
    if (Number.isFinite(v)) set.add(v);
  });
  return set;
}

const isNegativeSign = (sign) => /^(?:-|minus|down)/i.test(sign || '');
const isSingleScore = ({ expr, tail }) => /^\d+$/.test(expr) && /^(?:\s+(?:points?|pts))?$/i.test(tail);

function checkNumericWhitelist(text, facts = {}) {
  const allowed = toNumberSet(facts.allowedNumbers);
  const reasons = [];
  const rest = normalizeCopy(text).replace(NUMERIC_EXPR_RE, (full, ...args) => {
    const groups = args[args.length - 1];
    const value = (isNegativeSign(groups.sign) ? -1 : 1) * Number(groups.expr);
    const ok = isSingleScore(groups) && allowed.has(value);
    if (!ok) reasons.push({ rule: 'numeric', match: full.trim(), detail: 'not a single supplied score value' });
    return ' ';
  });
  (rest.match(/\S*\d\S*/g) || []).forEach((m) => reasons.push({ rule: 'numeric', match: m, detail: 'digits outside the score allowance' }));
  (rest.match(new RegExp(NUMBER_WORD_RE.source, 'gi')) || []).forEach((m) => reasons.push({ rule: 'numeric', match: m, detail: 'spelled number' }));
  return reasons;
}

function checkTimingLanguage(text) {
  const t = normalizeCopy(text);
  return [TIME_WORD_RE, RELATIVE_TIME_RE].flatMap((re) => (t.match(new RegExp(re.source, 'gi')) || [])
    .map((m) => ({ rule: 'timing', match: m, detail: 'no time language outside approved sentences' })));
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
// "behind" is a progress claim ("behind schedule", "behind the expected pace")
// unless a spatial noun follows ("behind the house", "behind the back fence").
const SPATIAL_NOUNS = '(?:house|home|fence|shed|pool|garage|driveway|patio|deck|hedge|tree|building|wall|gate|mailbox|lanai)s?';
const BEHIND_PROGRESS_RE = new RegExp(`\\bbehind\\b(?!\\s+(?:(?:the|your|our|a|an|this|that|each|every)\\s+)?(?:[\\w'-]+\\s+){0,2}?${SPATIAL_NOUNS}\\b)`, 'i');
const ITEM_PHRASES = [
  { state: 'on_track', re: /\bon[- ]track\b/i },
  { state: 'ahead', re: /\bahead\s+of\s+(?:schedule|pace|expectations?|where)\b/i },
  { state: 'behind', re: BEHIND_PROGRESS_RE },
  { state: 'too_early', re: /\btoo\s+early\b/i },
  { state: 'flat', re: /\bhold(?:s|ing)?\s+steady\b|\bheld\s+steady\b|\bunchanged\b|\bno\s+(?:real\s+)?change\b/i },
];

const stateKey = (s) => String(s || '').toLowerCase().replace(/[\s-]+/g, '_');

// A negator within three words before a progress or state word flips its
// meaning ("not improving", "no longer behind", "hasn't improved"), so it
// rejects whatever states were supplied.
const NEGATOR_RE = /\b(?:not|no|never|nor|without|hardly|barely|cannot|none)\b|\b\w+n't\b/i;
function isNegated(t, index) {
  const sentence = t.slice(0, index).split(/[.!?;:]/).pop();
  return NEGATOR_RE.test(sentence.trim().split(/\s+/).slice(-3).join(' '));
}

const matchesOf = (re, t) => [...t.matchAll(new RegExp(re.source, 'gi'))];

function judgeProgressMatch(m, t, ok, reasonDetail) {
  if (isNegated(t, m.index)) return { rule: 'progress_coupling', match: m[0], detail: 'negated progress word' };
  return ok ? null : { rule: 'progress_coupling', match: m[0], detail: reasonDetail };
}

function checkProgressCoupling(text, facts = {}) {
  const t = normalizeCopy(text);
  const dir = stateKey(facts.progress);
  const itemStates = new Set((Array.isArray(facts.progressStates) ? facts.progressStates : []).map(stateKey));
  const checks = [
    { re: UP_WORDS_RE, ok: dir === 'up', detail: `improving word with progress "${dir || 'unknown'}"` },
    { re: DOWN_WORDS_RE, ok: dir === 'down', detail: `decline word with progress "${dir || 'unknown'}"` },
    ...ITEM_PHRASES.map(({ state, re }) => ({
      re,
      ok: state === 'flat' ? (dir === 'flat' || itemStates.has('flat')) : itemStates.has(state),
      detail: `state "${state}" not supplied`,
    })),
  ];
  return checks.flatMap(({ re, ok, detail }) => matchesOf(re, t).map((m) => judgeProgressMatch(m, t, ok, detail)).filter(Boolean));
}

// ---------------------------------------------------------------------------
// Banned re-entry pattern (SCOPE s3) and the keep-off regression lists

const REENTRY_TRIGGER_RE = /\bkeep(?:ing)?\b[^.!?]{0,40}\boff\b|\bstay(?:ing|s)?\s+off\b|\bwait(?:ing|s|ed)?\b|\bdr(?:y|ies|ied|ying|ier)\b/i;
// Any time word, relative-time phrase, spelled number or digit in the same
// sentence as the trigger is a violation, whatever the facts say. Absolute:
// takes no facts, and approved sentences are NOT exempt.
function checkReentryPattern(text) {
  const reasons = [];
  splitSentences(text).forEach((s) => {
    const trig = s.match(REENTRY_TRIGGER_RE);
    const fig = trig && s.match(ANY_TIMING_RE);
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

function checkSafetyClaim(text) {
  return splitSentences(text)
    .filter((sentence) => !SAFE_IDIOM_SENTENCE_RE.test(sentence))
    .map((sentence) => sentence.match(SAFETY_CLAIM_RE) || sentence.match(NATURAL_CLAIM_RE))
    .filter(Boolean)
    .map((m) => ({ rule: 'safety_claim', match: m[0] }));
}

// ---------------------------------------------------------------------------
// Entry point

function stripApprovedSentences(text, approved) {
  const keys = new Set((Array.isArray(approved) ? approved : []).map(sentenceKey).filter(Boolean));
  if (!keys.size) return normalizeCopy(text);
  return splitSentences(text).filter((s) => !keys.has(sentenceKey(s))).join(' ');
}

// Sub-day durations (hours, minutes, seconds) in MODEL copy. Every lawn
// expectation window is in days or weeks, and anything shorter is re-entry or
// watering timing, which the banner owns. So no hour/minute/second word is
// allowed anywhere, approved sentences included. Absolute: takes no facts.
const SUB_DAY_RE = /\b(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|hourly)\b|\bhalf[- ]hours?\b/gi;
function checkSubDayDuration(text) {
  return (normalizeCopy(text).match(SUB_DAY_RE) || []).map((match) => ({ rule: 'sub_day_duration', match }));
}

function checkLawnModelCopy(text, facts = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, reasons: [{ rule: 'empty', match: '' }] };
  }
  const f = facts && typeof facts === 'object' ? facts : {};
  // Sentences copied verbatim from approved rows keep their own windows,
  // numbers and state words; every other rule still reads the full text.
  const unapproved = stripApprovedSentences(text, f.approvedSentences);
  const reasons = [
    ...checkTimingLanguage(unapproved),
    ...checkNumericWhitelist(unapproved, f),
    ...checkWaterMowDeny(text, f),
    ...checkWeekdayClockDeny(text),
    ...checkProgressCoupling(unapproved, f),
    ...checkReentryPattern(text),
    ...checkSubDayDuration(text),
    ...checkBannedCopy(text),
    ...checkOverpromise(text),
    ...checkSafetyClaim(text),
  ];
  return { ok: reasons.length === 0, reasons };
}

module.exports = {
  checkLawnModelCopy,
  checkTimingLanguage,
  checkNumericWhitelist,
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
