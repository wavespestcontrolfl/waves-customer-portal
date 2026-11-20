/**
 * Tech Rewards calculator (Plan D5-1): pure functions, no gate, no DB, no routes.
 *
 * Owner rulings 2026-11-20:
 *   D1 season bonus: band rate (by weighted score) x gross pay earned Mar 1 - Aug 31
 *      x a season multiplier (tenure + review rate + level), paid the last Friday
 *      of September.
 *   D2 stay bonuses: 2% of the prior 12 months' pay at the 1-year anniversary, 4%
 *      at 3 years, 8% at 5 years, each paid once, on the anniversary date.
 *
 * The score weights and the band cut lines below are settings DEFAULTS. They stay
 * defaults pending the written plan due Feb 15; later code passes the settings in.
 *
 * Conventions
 *   - Money is integer cents. Rates are integer basis points (100 = 1%). The
 *     multiplier is an integer in ten-thousandths (10000 = 1.0, max 32500 = 3.25).
 *     No floating point touches money: the cents math runs on BigInt with ONE
 *     half-up rounding to the cent, and no accepted input is rounded silently.
 *   - Dates are ET calendar dates, 'YYYY-MM-DD' strings (a Date is converted with
 *     the ET helpers). Calendar math runs on the string parts, not on clock time.
 *   - A Feb 29 anniversary falls on Mar 1 in a year with no Feb 29.
 *   - Every function validates its input (options objects first, before any
 *     destructuring) and throws TechRewardsCalcError with a stable `code`.
 *     No silent defaults, no clamping of bad input.
 */
const { etDateString, etNthWeekdayOfMonth, validCalendarDate } = require('../utils/datetime-et');

const DEFAULT_CUT_LINES = Object.freeze({ top: 90, mid: 80, low: 70 });
const BAND_BPS = Object.freeze({ top: 400, mid: 250, low: 100, none: 0 });

const DEFAULT_WEIGHTS = Object.freeze({
  onTime: 25, audit: 25, callbacks: 20, truck: 10, ownerRating: 20,
});

// Stay bonuses (D2): years of service -> basis points of the prior 12 months' pay.
const STAY_BONUS_1_YEAR_BPS = 200;
const STAY_BONUS_3_YEAR_BPS = 400;
const STAY_BONUS_5_YEAR_BPS = 800;
const STAY_BONUS_MILESTONES = Object.freeze([
  Object.freeze({ years: 1, rateBps: STAY_BONUS_1_YEAR_BPS }),
  Object.freeze({ years: 3, rateBps: STAY_BONUS_3_YEAR_BPS }),
  Object.freeze({ years: 5, rateBps: STAY_BONUS_5_YEAR_BPS }),
]);

// Season multiplier (D1), all in ten-thousandths (E4): 10000 = 1.0.
const E4 = 10000;
const TENURE_PER_YEAR_E4 = 2500;
const TENURE_MAX_E4 = 10000;
const REVIEW_RATE_FLOOR_BPS = 1000; // review rate at or below 10% adds 0
const REVIEW_RATE_FULL_BPS = 2500;  // review rate at 25% adds REVIEW_PART_MAX_E4
const REVIEW_PART_MAX_E4 = 5000;
const LEVEL_PER_STEP_E4 = 2500;
const LEVEL_PART_MAX_E4 = 7500;
const ENTRY_LEVEL = 1;
const MULTIPLIER_MIN_E4 = E4;
const MULTIPLIER_MAX_E4 = MULTIPLIER_MIN_E4 + TENURE_MAX_E4 + REVIEW_PART_MAX_E4 + LEVEL_PART_MAX_E4; // 32500

// Season window: gross pay is measured Mar 1 - Aug 31 (month numbers, 1-based).
const SEASON_START_MONTH = 3;
const SEASON_END_MONTH = 8;
const SEASON_END_DAY = 31;

class TechRewardsCalcError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TechRewardsCalcError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new TechRewardsCalcError(code, message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireObject(value, code, label) {
  if (!isPlainObject(value)) fail(code, `${label} must be an object`);
  return value;
}

function requireNumberInRange(value, min, max, code, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(code, `${label} must be a finite number`);
  if (value < min || value > max) fail(code, `${label} must be between ${min} and ${max}`);
  return value;
}

function requireCents(value, code, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code, `${label} must be a non-negative integer number of cents`);
  return value;
}

function requireYear(year) {
  if (!Number.isInteger(year) || year < 1970 || year > 9999) fail('INVALID_YEAR', 'year must be an integer from 1970 to 9999');
  return year;
}

// 'YYYY-MM-DD' string or Date -> validated 'YYYY-MM-DD' (ET calendar date).
function requireDate(value, code, label) {
  const raw = value instanceof Date && !Number.isNaN(value.getTime()) ? etDateString(value) : value;
  const ok = typeof raw === 'string' ? validCalendarDate(raw) : null;
  if (!ok) fail(code, `${label} must be a valid YYYY-MM-DD date`);
  return ok;
}

function dateParts(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return { year, month, day };
}

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatYmd(year, month, day) {
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

// The date `years` after a start date. Feb 29 in a non-leap year becomes Mar 1.
function addYears(dateStr, years) {
  const { year, month, day } = dateParts(dateStr);
  const target = year + years;
  if (month === 2 && day === 29 && !isLeapYear(target)) return formatYmd(target, 3, 1);
  return formatYmd(target, month, day);
}

// Round-half-up of num / den for non-negative BigInts. The one rounding step.
function divideRoundHalfUp(num, den) {
  return (num * 2n + den) / (den * 2n);
}

function toSafeNumber(big) {
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) fail('AMOUNT_TOO_LARGE', 'amount is too large to compute exactly');
  return Number(big);
}

// A number that is exactly a 2-decimal value -> integer hundredths (else null).
// Exact means hundredths / 100 gives back the very same double: no tolerance.
function toHundredths(value) {
  const scaled = Math.round(value * 100);
  return Number.isFinite(value) && scaled / 100 === value ? scaled : null;
}

// ---------------------------------------------------------------------------
// 1. Score band

function validateCutLines(cutLines) {
  requireObject(cutLines, 'INVALID_CUT_LINES', 'cutLines');
  const { top, mid, low } = cutLines;
  ['top', 'mid', 'low'].forEach((key) => requireNumberInRange(cutLines[key], 0, 100, 'INVALID_CUT_LINES', `cutLines.${key}`));
  if (!(top > mid && mid > low)) fail('INVALID_CUT_LINES', 'cutLines must satisfy top > mid > low');
  return { top, mid, low };
}

/** Score (0..100) -> season bonus rate in basis points. */
function scoreBand(score, cutLines = DEFAULT_CUT_LINES) {
  const { top, mid, low } = validateCutLines(cutLines);
  requireNumberInRange(score, 0, 100, 'INVALID_SCORE', 'score');
  if (score >= top) return BAND_BPS.top;
  if (score >= mid) return BAND_BPS.mid;
  if (score >= low) return BAND_BPS.low;
  return BAND_BPS.none;
}

// ---------------------------------------------------------------------------
// 2. Weighted score

// Part or weight values with at most 2 decimals, as exact integer hundredths.
function hundredthsOf(obj, code, label, max) {
  const keys = Object.keys(DEFAULT_WEIGHTS);
  const extra = Object.keys(obj).filter((k) => !keys.includes(k));
  if (extra.length) fail(code, `${label} has unknown keys: ${extra.join(', ')}`);
  const out = {};
  keys.forEach((k) => {
    requireNumberInRange(obj[k], 0, max, code, `${label}.${k}`);
    const h = toHundredths(obj[k]);
    if (h === null) fail(code, `${label}.${k} must have at most 2 decimals`);
    out[k] = BigInt(h);
  });
  return out;
}

/**
 * Five 0..100 parts and weights summing to 100 -> a 0..100 score. Parts and weights
 * take at most 2 decimals; the sum runs on integers, so the result is exact (it is
 * the double nearest the decimal value, the same double as the literal).
 */
function weightedScore(parts, weights = DEFAULT_WEIGHTS) {
  requireObject(parts, 'INVALID_PARTS', 'parts');
  requireObject(weights, 'INVALID_WEIGHTS', 'weights');
  const p = hundredthsOf(parts, 'INVALID_PARTS', 'parts', 100);
  const w = hundredthsOf(weights, 'INVALID_WEIGHTS', 'weights', 100);
  const keys = Object.keys(DEFAULT_WEIGHTS);
  const weightSum = keys.reduce((acc, k) => acc + w[k], 0n);
  if (weightSum !== 10000n) fail('INVALID_WEIGHTS', `weights must sum to 100 (got ${Number(weightSum) / 100})`);
  const total = keys.reduce((acc, k) => acc + p[k] * w[k], 0n); // scale 1e4 x 100 = 1e6
  return Number(total) / 1e6;
}

// ---------------------------------------------------------------------------
// 3. Season multiplier

// Full years of service as of Mar 1 of `seasonYear` (a hire on Mar 1 counts that day).
function fullYearsAsOfMarchFirst(hireDate, seasonYear) {
  const march1 = formatYmd(seasonYear, SEASON_START_MONTH, 1);
  let years = seasonYear - dateParts(hireDate).year;
  while (years > 0 && addYears(hireDate, years) > march1) years -= 1;
  return Math.max(0, years);
}

// Review part in ten-thousandths: exact rational (rateBps - 1000) * 5000 / 1500,
// clamped to 0..5000, rounded half-up ONCE to ten-thousandths.
function reviewRatePartE4(reviewRateBps) {
  if (reviewRateBps <= REVIEW_RATE_FLOOR_BPS) return 0;
  if (reviewRateBps >= REVIEW_RATE_FULL_BPS) return REVIEW_PART_MAX_E4;
  const num = BigInt((reviewRateBps - REVIEW_RATE_FLOOR_BPS) * REVIEW_PART_MAX_E4);
  return Number(divideRoundHalfUp(num, BigInt(REVIEW_RATE_FULL_BPS - REVIEW_RATE_FLOOR_BPS)));
}

/**
 * Season multiplier for the season year of `asOf`.
 * reviewRateBps is an integer in basis points (2500 = 25%); level is an integer,
 * entry level = 1. Returns integers in ten-thousandths:
 * { multiplierE4, parts: { baseE4, tenureE4, reviewRateE4, levelE4 }, tenureYears, seasonYear }.
 */
function seasonMultiplier(opts) {
  requireObject(opts, 'INVALID_OPTIONS', 'seasonMultiplier options');
  const { hireDate, asOf, reviewRateBps, level } = opts;
  const hire = requireDate(hireDate, 'INVALID_HIRE_DATE', 'hireDate');
  const asOfDate = requireDate(asOf, 'INVALID_AS_OF', 'asOf');
  if (hire > asOfDate) fail('INVALID_HIRE_DATE', 'hireDate must not be after asOf');
  if (!Number.isInteger(reviewRateBps) || reviewRateBps < 0 || reviewRateBps > 10000) {
    fail('INVALID_REVIEW_RATE', 'reviewRateBps must be an integer from 0 to 10000');
  }
  if (!Number.isInteger(level) || level < ENTRY_LEVEL) fail('INVALID_LEVEL', `level must be an integer of ${ENTRY_LEVEL} or more`);

  const seasonYear = dateParts(asOfDate).year;
  const tenureYears = fullYearsAsOfMarchFirst(hire, seasonYear);
  const parts = {
    baseE4: MULTIPLIER_MIN_E4,
    tenureE4: Math.min(TENURE_MAX_E4, tenureYears * TENURE_PER_YEAR_E4),
    reviewRateE4: reviewRatePartE4(reviewRateBps),
    levelE4: Math.min(LEVEL_PART_MAX_E4, (level - ENTRY_LEVEL) * LEVEL_PER_STEP_E4),
  };
  const multiplierE4 = parts.baseE4 + parts.tenureE4 + parts.reviewRateE4 + parts.levelE4;
  return { multiplierE4, parts, tenureYears, seasonYear };
}

// ---------------------------------------------------------------------------
// 4. Season bonus

/** Mar 1 - Aug 31 of the season year, as ET dates. */
function seasonWindow(year) {
  requireYear(year);
  return {
    start: formatYmd(year, SEASON_START_MONTH, 1),
    end: formatYmd(year, SEASON_END_MONTH, SEASON_END_DAY),
  };
}

/** Pay date: the last Friday of September (ET date). */
function seasonBonusPayDate(year) {
  requireYear(year);
  return etDateString(etNthWeekdayOfMonth(year, 9, 5, 5));
}

/**
 * Band rate x gross pay (Mar 1 - Aug 31) x multiplier, in cents:
 * bandBps * gross * multiplierE4 / 10^8 in BigInt, rounded half-up once to the cent.
 */
function seasonBonusCents(opts) {
  requireObject(opts, 'INVALID_OPTIONS', 'seasonBonusCents options');
  const { score, grossCentsMarToAug, multiplierE4, cutLines = DEFAULT_CUT_LINES } = opts;
  const rateBps = scoreBand(score, cutLines);
  requireCents(grossCentsMarToAug, 'INVALID_GROSS', 'grossCentsMarToAug');
  if (!Number.isInteger(multiplierE4) || multiplierE4 < MULTIPLIER_MIN_E4 || multiplierE4 > MULTIPLIER_MAX_E4) {
    fail('INVALID_MULTIPLIER', `multiplierE4 must be an integer from ${MULTIPLIER_MIN_E4} to ${MULTIPLIER_MAX_E4}`);
  }
  const num = BigInt(rateBps) * BigInt(grossCentsMarToAug) * BigInt(multiplierE4);
  return toSafeNumber(divideRoundHalfUp(num, 10n ** 8n));
}

// ---------------------------------------------------------------------------
// 5. Stay bonus

/**
 * The next stay bonus that pays on or after `asOf`: { dueDate, rateBps, cents },
 * or null once the 5-year bonus is behind asOf. priorTwelveMonthsPayCents is the
 * gross pay of the 12 months before that anniversary.
 */
function stayBonus(opts) {
  requireObject(opts, 'INVALID_OPTIONS', 'stayBonus options');
  const { hireDate, asOf, priorTwelveMonthsPayCents } = opts;
  const hire = requireDate(hireDate, 'INVALID_HIRE_DATE', 'hireDate');
  const asOfDate = requireDate(asOf, 'INVALID_AS_OF', 'asOf');
  if (hire > asOfDate) fail('INVALID_HIRE_DATE', 'hireDate must not be after asOf');
  requireCents(priorTwelveMonthsPayCents, 'INVALID_PAY', 'priorTwelveMonthsPayCents');
  for (const { years, rateBps } of STAY_BONUS_MILESTONES) {
    const dueDate = addYears(hire, years);
    if (dueDate >= asOfDate) {
      const cents = toSafeNumber(divideRoundHalfUp(BigInt(priorTwelveMonthsPayCents) * BigInt(rateBps), 10000n));
      return { dueDate, rateBps, cents };
    }
  }
  return null;
}

module.exports = {
  TechRewardsCalcError,
  DEFAULT_CUT_LINES,
  DEFAULT_WEIGHTS,
  STAY_BONUS_1_YEAR_BPS,
  STAY_BONUS_3_YEAR_BPS,
  STAY_BONUS_5_YEAR_BPS,
  MULTIPLIER_MIN_E4,
  MULTIPLIER_MAX_E4,
  scoreBand,
  weightedScore,
  seasonMultiplier,
  seasonBonusCents,
  seasonBonusPayDate,
  seasonWindow,
  stayBonus,
};
