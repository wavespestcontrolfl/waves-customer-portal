/**
 * Lawn seasonality — the single place that reasons about season + dormancy.
 *
 * SW Florida St. Augustine is a WARM-SEASON grass: it doesn't go fully dormant like
 * northern turf, it slows and colors off when nights drop (roughly < 55–58°F) and
 * greens back up as it warms. So "dormancy" here is GRADED pressure, and — when we
 * actually have recent low temps — MEASURED, not guessed by the calendar.
 *
 * Three jobs:
 *   1. seasonAwareAdjustment — score normalization that compensates for seasonal
 *      slowdown. Weather-driven when a recent min temp is supplied; otherwise it
 *      EXACTLY matches the legacy month-bucket multipliers (backward compatible).
 *   2. dormancyLikely — is a low color reading seasonal rather than a problem?
 *   3. crossSeasonNote — when two compared visits span different seasons, say so, so
 *      a winter-vs-summer photo/score diff never reads as decline.
 */

const { ISSUE_ROWS } = require('../../config/lawn-expectations');

function getSeason(month) {
  if (month >= 5 && month <= 9) return 'peak';
  if ((month >= 3 && month <= 4) || (month >= 10 && month <= 11)) return 'shoulder';
  return 'dormant'; // Dec, Jan, Feb
}

function seasonOfDate(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return getSeason(d.getMonth() + 1);
}

const isCoolSeason = (s) => s === 'dormant' || s === 'shoulder';

// Graded dormancy pressure. Weather-driven when recentMinTempF is finite; else the
// calendar season is the proxy.
function dormancyPressure({ month, recentMinTempF } = {}) {
  if (Number.isFinite(recentMinTempF)) {
    if (recentMinTempF <= 50) return 'strong';
    if (recentMinTempF <= 58) return 'mild';
    return 'none'; // warm nights → no dormancy even in calendar winter
  }
  const s = getSeason(month);
  return s === 'dormant' ? 'strong' : s === 'shoulder' ? 'mild' : 'none';
}

// Density / color multipliers per pressure level. The calendar fallback reproduces the
// legacy applySeasonalAdjustment exactly (shoulder ×1.1/×1.1, dormant ×1.15/×1.25).
const PRESSURE_FACTOR = { none: [1, 1], mild: [1.1, 1.1], strong: [1.15, 1.25] };

function seasonAwareAdjustment(scores, { month, recentMinTempF } = {}) {
  if (!scores) return null;
  const [fDensity, fColor] = PRESSURE_FACTOR[dormancyPressure({ month, recentMinTempF })];
  return {
    ...scores,
    turf_density: Math.min(100, Math.round((Number(scores.turf_density) || 0) * fDensity)),
    color_health: Math.min(100, Math.round((Number(scores.color_health) || 0) * fColor)),
  };
}

// A low color score reads as SEASONAL (not stress) when there's real dormancy pressure,
// the color is genuinely down, and nothing else is flagging a stress problem.
function dormancyLikely({ colorHealth, stressDamage, month, recentMinTempF } = {}) {
  const pressure = dormancyPressure({ month, recentMinTempF });
  const color = Number(colorHealth);
  const stress = Number(stressDamage); // higher display = healthier
  const likely = pressure !== 'none'
    && Number.isFinite(color) && color < 75
    && (!Number.isFinite(stress) || stress >= 45);
  return { likely, pressure };
}

// The seasonal_dip expectation row is the only source of the "color returns as
// nights warm" claim. `approved` is the switch that keeps an unsigned row from
// a customer, so every seasonal copy site asks here, at call time: the row when
// it is approved and has its sentence, otherwise null (say it without the claim).
function approvedSeasonalDipRow() {
  const row = ISSUE_ROWS.seasonal_dip;
  return row && row.approved === true && row.visibleChange ? row : null;
}
function seasonalDipClaimApproved() {
  return approvedSeasonalDipRow() !== null;
}

// ── Measured cold (lawn report rebuild P36, GATE_LAWN_MEASURED_COLD) ──────────
// The seasonal-dip sentence is a claim about the weather, so it may only print
// when the weather was measured: at least 2 of the 7 ET calendar nights before
// the VISIT's day had a low at or below 55F. Pure, no clock: the nights come
// from the visit's day (trailingNightDates) and the readings from the caller.
const COLD_NIGHT_MAX_F = 55;
const COLD_NIGHTS_REQUIRED = 2;
const TRAILING_NIGHTS = 7;

// The 7 ET calendar days before `visitDay` (YYYY-MM-DD), oldest first. The
// visit day itself is excluded: its low may not have happened yet, and the
// verdict must read the same on every later view. null for a non-date.
function trailingNightDates(visitDay) {
  const s = String(visitDay || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const base = Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  if (Number.isNaN(base)) return null;
  const dates = [];
  for (let back = TRAILING_NIGHTS; back >= 1; back -= 1) {
    dates.push(new Date(base - back * 86400000).toISOString().slice(0, 10));
  }
  return dates;
}

// { cold, known, missing } over the last 7 readings (°F, oldest first). Only a
// finite NUMBER is a reading: null / undefined / '' / NaN are missing nights,
// never 0 (Number(null) is 0, which would count as a freezing night).
function coldNightsInTrailingWeek(nightlyMinsF) {
  const list = Array.isArray(nightlyMinsF) ? nightlyMinsF.slice(-TRAILING_NIGHTS) : [];
  let cold = 0;
  let known = 0;
  for (const value of list) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    known += 1;
    if (value <= COLD_NIGHT_MAX_F) cold += 1;
  }
  return { cold, known, missing: TRAILING_NIGHTS - known };
}

// true: at least 2 cold nights (a fact whatever else is missing). false: fewer
// than 2 and all 7 nights known. null: unknown, because a missing night could
// have been the second cold one. Only true prints the dip sentence.
function measuredColdMet(nightlyMinsF) {
  const { cold, missing } = coldNightsInTrailingWeek(nightlyMinsF);
  if (cold >= COLD_NIGHTS_REQUIRED) return true;
  return missing === 0 ? false : null;
}

// The rule only has a say in the cooler calendar (Mar-Apr, Oct-Feb): that is
// where the calendar condition for the dip can be true, so a peak-season
// visit (May-Sep) never fetches, freezes, or changes its PDF key.
function measuredColdApplies(visitDay) {
  const s = String(visitDay || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return getSeason(Number(s.slice(5, 7))) !== 'peak';
}

// When two compared visits fall in different seasons, surface that the difference is
// largely seasonal so the before/after wipe + trend never imply decline from dormancy.
// `dipClaim: false` (measured cold not met, GATE_LAWN_MEASURED_COLD) leaves the
// "color often returns as nights warm" clause out, the same words the sentence
// already has while the row is unapproved. Default true = unchanged.
function crossSeasonNote(dateA, dateB, { dipClaim = true } = {}) {
  const a = seasonOfDate(dateA);
  const b = seasonOfDate(dateB);
  if (!a || !b || a === b) return null;
  if (isCoolSeason(a) || isCoolSeason(b)) {
    return `Most of the color difference here is seasonal — St. Augustine slows and colors off in the cooler months${dipClaim && seasonalDipClaimApproved() ? ', and color often returns as nights warm' : ''}.`;
  }
  return 'These visits fall in different parts of the growing season, so some change is expected.';
}

// Same, from already-resolved season strings (trend rows carry `season`).
function crossSeasonNoteFromSeasons(seasonA, seasonB, { dipClaim = true } = {}) {
  if (!seasonA || !seasonB || seasonA === seasonB) return null;
  if (isCoolSeason(seasonA) || isCoolSeason(seasonB)) {
    return `Most of the change across these visits is seasonal — color naturally dips in the cooler months${dipClaim && seasonalDipClaimApproved() ? ' and often returns as nights warm' : ''}.`;
  }
  return null;
}

module.exports = {
  approvedSeasonalDipRow,
  getSeason,
  seasonOfDate,
  dormancyPressure,
  seasonAwareAdjustment,
  dormancyLikely,
  crossSeasonNote,
  crossSeasonNoteFromSeasons,
  COLD_NIGHT_MAX_F,
  COLD_NIGHTS_REQUIRED,
  TRAILING_NIGHTS,
  trailingNightDates,
  coldNightsInTrailingWeek,
  measuredColdMet,
  measuredColdApplies,
};
