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

// When two compared visits fall in different seasons, surface that the difference is
// largely seasonal so the before/after wipe + trend never imply decline from dormancy.
function crossSeasonNote(dateA, dateB) {
  const a = seasonOfDate(dateA);
  const b = seasonOfDate(dateB);
  if (!a || !b || a === b) return null;
  if (isCoolSeason(a) || isCoolSeason(b)) {
    return 'Most of the color difference here is seasonal — St. Augustine slows and colors off in the cooler months, then greens back up as it warms.';
  }
  return 'These visits fall in different parts of the growing season, so some change is expected.';
}

// Same, from already-resolved season strings (trend rows carry `season`).
function crossSeasonNoteFromSeasons(seasonA, seasonB) {
  if (!seasonA || !seasonB || seasonA === seasonB) return null;
  if (isCoolSeason(seasonA) || isCoolSeason(seasonB)) {
    return 'Most of the change across these visits is seasonal — color naturally dips in the cooler months and recovers as it warms.';
  }
  return null;
}

module.exports = {
  getSeason,
  seasonOfDate,
  dormancyPressure,
  seasonAwareAdjustment,
  dormancyLikely,
  crossSeasonNote,
  crossSeasonNoteFromSeasons,
};
