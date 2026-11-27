/**
 * MOVE RULES — which candidate may move a visit, and what its gain is.
 * PURE (no DB/I/O). The one rule shared by the top-level decision on `best`
 * and by the SLOT_TAKEN fallback list apply.js receives (index.js).
 *
 * Owner 2026-10-09, after a week of 50 moves in which 16 cleared the score
 * bar only on the service-type default time window and some saved no drive:
 *   - A move must save real drive: the visit's modeled detour must drop by
 *     config.minDayMoveDriveSavingMinutes (6). A same-day re-time is held to
 *     it too (owner 2026-10-09: a 2 PM pest visit re-timed to 8 AM for the
 *     default-window credit alone, with no drive saved, is the same
 *     complaint).
 *   - The default time window (pest early morning, lawn late morning: a time
 *     the customer never chose) never counts toward the gain of a move, day
 *     or same-day: it is left out on both sides of the comparison.
 *
 * Two shapes skip the bar and the drive floor, because the visit cannot stay
 * where it is:
 *   - an unplaced recurring due-date visit (no arrival window yet) accepts
 *     any placement over none, on its raw score as before;
 *   - a visit in conflict (current-conflict.js, behind
 *     GATE_AUTO_DISPATCH_CONFLICT_MOVES): it overlaps another customer's
 *     stop, or sits on an owner blackout day, or (mowing-days.js) a Lawn
 *     Care Service visit sits on or next to the customer's mowing day. A free hour on the same day is
 *     taken first when the day itself stays open; then the slot that adds
 *     the least drive. A slot that adds more than
 *     config.conflictMaxAddedDriveMinutes is never taken: the visit stays
 *     and the audit row says CONFLICT_NO_NEAR_SLOT (a person decides).
 *
 * Sunday is the last resort (owner 2026-10-24, "think sundays should be a
 * last resort", with GATE_AUTO_DISPATCH_DAY_RULES opening Sundays to the
 * search): a Sunday slot ranks after every qualifying Monday-Saturday slot,
 * whatever its gain, so it is taken only when no other day qualifies. A free
 * hour on the visit's own day still comes first for an overlap.
 */
const { weekdayOf } = require('./scoring');
const { isBounceBackDate } = require('./bounce-guard');

function round2(v) { return Math.round(v * 100) / 100; }

function isSundayDate(date) {
  return weekdayOf(date) === 0;
}

function isUnplacedDueDate(service) {
  return !!(service.recurring_dispatch_due_date && !service.window_start);
}

function isDayMove(current, cand) {
  return String(cand.date) !== String(current.date);
}

// Modeled drive minutes the candidate takes off the visit's own detour.
function driveSavingMinutes(current, cand) {
  return round2((Number(current.detour_minutes) || 0) - (Number(cand.detour_minutes) || 0));
}

// A score's total with the default-time credit left out (scoring.js clamps
// it separately; a breakdown without the field falls back to subtraction).
function withoutDefaultTime(score) {
  return score.total_without_default_time ?? (score.total_score - (score.default_time_score || 0));
}

// GATE_AUTO_DISPATCH_DRY_TIME_ORDER: the dry-time credit counts in a same-day
// re-time's gain; on another date it counts for nothing (owner 2026-10-24: no
// automatic day moves for rain). Scores without the field are unchanged.
function gainBasis(score, dayMove) {
  return dayMove && score.total_without_dry_time != null ? score.total_without_dry_time : withoutDefaultTime(score);
}

// Points the candidate gains over the current placement. The default-time
// credit is left out of both totals (a dry-time credit stays in for a same-day
// re-time, see gainBasis), except for an unplaced due-date visit
// (a first placement: the raw difference, as before 2026-10-09).
function moveGain({ service, current, cand, currentScore, candScore }) {
  if (isUnplacedDueDate(service)) return round2(candScore.total_score - currentScore.total_score);
  const dayMove = !!(current && cand) && isDayMove(current, cand);
  return round2(gainBasis(candScore, dayMove) - gainBasis(currentScore, dayMove));
}

// Whether a candidate is a legal KIND of move at all, before the score bar:
// every move, a same-day re-time included, needs the drive saving.
function meetsDriveFloor({ current, cand, config }) {
  const floor = config.minDayMoveDriveSavingMinutes || 0;
  // 0 turns the floor off: the score bar alone decides, as before.
  if (floor <= 0) return true;
  // The legacy model (GATE_AUTO_DISPATCH_SHARED_MODEL off) measures a grouped
  // visit's current detour against its own co-located siblings, so it reads
  // 0 and no saving could ever be shown: the floor has no number to test
  // (Codex #6207 r1 P1). The score bar still applies.
  if (current.detour_group_blind) return true;
  return driveSavingMinutes(current, cand) >= floor;
}

// A conflict move may not add more than the ceiling to the visit's detour.
function withinConflictCeiling({ current, cand, config }) {
  const ceiling = config.conflictMaxAddedDriveMinutes;
  // The legacy grouped shape has no usable current detour (see the floor).
  if (!Number.isFinite(ceiling) || current.detour_group_blind) return true;
  return -driveSavingMinutes(current, cand) <= ceiling;
}

// Owner 2026-11-24 *all rec* (minutes rule): a day move that takes at least
// minutesRuleFloor off the visit's modeled detour qualifies below the score bar
// when it gives up no customer preference and no technician fit and still gains
// points. 10 minutes is only 8.9 route points, so before this a clear drive
// saving could miss the 15-point bar. A first move needs
// config.minutesRuleSavingMinutes (10); a visit already moved needs
// config.minutesRuleSecondMoveSavingMinutes (15; owner "do whatever you rec",
// row 90) in place of the 20-point re-move bar. Real roads must confirm the
// same minutes (road-check.js). 0 turns that half off.
function minutesRuleFloor(service, config) {
  return (service.auto_dispatch_change_count || 0) > 0
    ? (config.minutesRuleSecondMoveSavingMinutes || 0)
    : (config.minutesRuleSavingMinutes || 0);
}

// The customer's own preference credit: the preference score without the
// service-type default window or the dry-time credit (neither is the
// customer's choice; see moveGain).
// In whole hundredths, so equal credits compare equal (16.67 - 4.17 is not 12.5 in floating point).
function ownPreferenceScore(score) {
  const hundredths = (v) => Math.round((Number(v) || 0) * 100);
  return hundredths(score.customer_preference_score) - hundredths(score.default_time_score) - hundredths(score.dry_time_score);
}

// The rule needs the road check (GATE_AUTO_DISPATCH_ROAD_CHECK) and the
// ordinary drive floor on (> 0): without both, road-check.js measures nothing,
// and a minutes-only move must be confirmed on real roads.
function minutesRuleOk({ service, current, cand, currentScore, candScore, gain, config }) {
  const floor = minutesRuleFloor(service, config);
  if (floor <= 0 || config.roadCheckEnabled !== true || !((config.minDayMoveDriveSavingMinutes || 0) > 0)) return false;
  // A grouped visit moves with its siblings, whose own move counts this row
  // cannot see: it keeps the score bar (candidate-slots.js groupFields).
  if (!current || !cand || !isDayMove(current, cand) || current.grouped || current.detour_group_blind || !(gain > 0)) return false;
  return driveSavingMinutes(current, cand) >= floor
    && ownPreferenceScore(candScore) >= ownPreferenceScore(currentScore)
    && (Number(candScore.technician_score) || 0) >= (Number(currentScore.technician_score) || 0);
}

// A visit that must leave its slot whatever the score says.
function mustMove(service, current) {
  return isUnplacedDueDate(service) || !!(current && current.conflict);
}

function scoreCandidateRow({ cand, sc }, index, {
  service, current, currentScore, threshold, config, forced, conflict, recentLeftDates,
}) {
  const gain = moveGain({ service, current, currentScore, cand, candScore: sc });
  const normalFloorOk = meetsDriveFloor({ current, cand, config });
  const floorOk = forced || normalFloorOk;
  const ceilingOk = !conflict || withinConflictCeiling({ current, cand, config });
  const dayMove = isDayMove(current, cand);
  const bounceBlocked = dayMove && isBounceBackDate(recentLeftDates, cand.date);
  // Qualifies on minutes alone (no conflict to force it). A visit in conflict
  // still uses it for the move it would make once the conflict is gone (normalOk).
  const minutesOk = normalFloorOk && gain < threshold
    && minutesRuleOk({ service, current, cand, currentScore, candScore: sc, gain, config });
  const byMinutes = !forced && minutesOk;
  const ordinaryQualifies = normalFloorOk && (gain >= threshold || minutesOk);
  return {
    cand, sc, gain, index, floorOk, ceilingOk, bounceBlocked, ordinaryQualifies,
    // Would this slot move the visit with no conflict to force it?
    normalOk: !bounceBlocked && ordinaryQualifies,
    minutesOk,
    saving: driveSavingMinutes(current, cand),
    qualifies: forced ? ceilingOk : (!bounceBlocked && floorOk && (gain >= threshold || byMinutes)),
    byMinutes,
    sameDay: !dayMove,
    sunday: isSundayDate(cand.date),
  };
}

function pickBouncedTop(rows, forced, qualifying, byGain) {
  if (forced || qualifying.length > 0) return null;
  const bounced = rows.filter((r) => r.bounceBlocked && r.ordinaryQualifies);
  return bounced.sort((a, b) => byBarThenSaving(a, b, 'byMinutes', byGain))[0] || null;
}

function noQualifyingFlags({ qualifying, bouncedTop, top, forced, conflict, threshold }) {
  const none = qualifying.length === 0 && Boolean(top);
  return {
    bounceBlocked: Boolean(bouncedTop),
    floorFailed: none && !bouncedTop && !forced && !top.floorOk && top.gain >= threshold,
    ceilingFailed: none && Boolean(conflict) && !top.ceilingOk,
  };
}

/**
 * Rank scored candidates for one visit. Returns
 *   { best, bestScore, gain, qualifies, floorFailed, bounceBlocked, ranked }
 * `best` is the candidate the audit describes: the top qualifying one, else
 * the top bounce-blocked qualifying candidate (if any), else the top one by
 * gain (so a no-change row still shows the nearest miss).
 * `ranked` holds every qualifying candidate, best first (the SLOT_TAKEN
 * fallback list). `floorFailed` says the nearest miss was a move that
 * saved too little drive; `bounceBlocked` says every otherwise-qualifying
 * candidate would bounce the visit back onto a recently-left date.
 */
function rankCandidates({ service, current, currentScore, scored, threshold, config, recentLeftDates = null }) {
  const forced = mustMove(service, current);
  const conflict = (current && current.conflict) || null;
  const sameDayFirst = Boolean(conflict && conflict.kind === 'overlap');
  const rowCtx = { service, current, currentScore, threshold, config, forced, conflict, recentLeftDates };
  const rows = scored.map((entry, index) => scoreCandidateRow(entry, index, rowCtx));
  // Stable: ties keep encounter order (Array#sort is stable in V8). A
  // conflict move ranks by least added drive before score. A Sunday ranks
  // after every other day (the last resort, see the header).
  const byGain = (a, b) => (sameDayFirst ? Number(b.sameDay) - Number(a.sameDay) : 0)
    || Number(a.sunday) - Number(b.sunday)
    || (conflict ? b.saving - a.saving : 0) || b.gain - a.gain || a.index - b.index;
  // A same-day free hour still comes first for an overlap; then Sunday last, then bar before minutes rule.
  const qualifying = rows.filter((r) => r.qualifies).sort((a, b) => (sameDayFirst ? Number(b.sameDay) - Number(a.sameDay) : 0)
    || byBarThenSaving(a, b, 'byMinutes', byGain));
  const bouncedTop = pickBouncedTop(rows, forced, qualifying, byGain);
  // Nothing qualifies: the audit shows the bounced winner (if any), else the nearest miss.
  const top = qualifying[0] || bouncedTop || rows.slice().sort(byGain)[0] || null;
  return {
    best: top && top.cand,
    bestScore: top && top.sc,
    gain: top ? top.gain : 0,
    qualifies: qualifying.length > 0,
    // The slot taken qualifies only by the minutes rule (audit + road floor).
    byMinutes: Boolean(qualifying[0] && qualifying[0].byMinutes),
    ...noQualifyingFlags({ qualifying, bouncedTop, top, forced, conflict, threshold }),
    // A visit in conflict that an ordinary optimization would move anyway:
    // it still moves after its overlapping partner has left.
    movesWithoutConflict: Boolean(conflict) && rows.some((r) => r.normalOk && !r.cand.past_cap),
    // ...and the slot it would take then: ranked by gain alone, the order of
    // a visit with no conflict (Codex #6207 r10 P2).
    ...normalBestOf(conflict, rows, service, config),
    ranked: qualifying.map((r) => r.cand),
    // The same list with each slot's score and gain (road-check.js).
    rankedRows: qualifying.map((r) => ({ cand: r.cand, sc: r.sc, gain: r.gain, byMinutes: r.byMinutes })),
  };
}

// Order of qualifying slots: Sunday last (owner 2026-10-24); then a slot that clears
// the score bar before a minutes-rule slot (key `flag`); minutes-rule slots by
// the bigger drive saving; then `rest`.
function byBarThenSaving(a, b, flag, rest) {
  return Number(a.sunday) - Number(b.sunday)
    || Number(a[flag]) - Number(b[flag])
    || (a[flag] && b[flag] ? b.saving - a.saving : 0)
    || rest(a, b);
}

function normalBestOf(conflict, rows, service, config) {
  if (!conflict) return {};
  // A past_cap slot is in the list only for the conflict repair (legacyCap).
  // Ranked like an ordinary move: Sunday last, bar before minutes rule.
  const top = rows.filter((r) => r.normalOk && !r.cand.past_cap)
    .sort((a, b) => byBarThenSaving(a, b, 'minutesOk', (x, y) => y.gain - x.gain || x.index - y.index))[0];
  if (!top) return {};
  // The road floor the projected move must keep (road-check.js withProjectionChecked).
  return { normalBest: top.cand, normalBestScore: top.sc, ...(top.minutesOk ? { normalBestMinutesFloor: minutesRuleFloor(service, config) } : {}) };
}

module.exports = {
  isUnplacedDueDate, isDayMove, driveSavingMinutes, moveGain, meetsDriveFloor, withinConflictCeiling, mustMove, rankCandidates,
  isSundayDate, minutesRuleOk, minutesRuleFloor,
};
