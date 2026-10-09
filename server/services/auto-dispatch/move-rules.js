/**
 * MOVE RULES — which candidate may move a visit, and what its gain is.
 * PURE (no DB/I/O). The one rule shared by the top-level decision on `best`
 * and by the SLOT_TAKEN fallback list apply.js receives (index.js).
 *
 * Owner 2026-10-09, after a week of 50 moves in which 16 cleared the score
 * bar only on the service-type default time window and some saved no drive:
 *   - A DAY move must save real drive: the visit's modeled detour must drop
 *     by config.minDayMoveDriveSavingMinutes (6). A same-day re-time is not
 *     held to it.
 *   - The default time window (pest early morning, lawn late morning: a time
 *     the customer never chose) counts for a same-day re-time only. A day
 *     move's gain leaves it out on both sides of the comparison.
 *
 * Two shapes skip the bar and the drive floor, because the visit cannot stay
 * where it is:
 *   - an unplaced recurring due-date visit (no arrival window yet) accepts
 *     any placement over none, on its raw score as before;
 *   - a visit in conflict (current-conflict.js, behind
 *     GATE_AUTO_DISPATCH_CONFLICT_MOVES): it overlaps another customer's
 *     stop, or sits on an owner blackout day. A free hour on the same day is
 *     taken first when the day itself stays open.
 */

function round2(v) { return Math.round(v * 100) / 100; }

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

// Points the candidate gains over the current placement. A day move leaves
// the default-time credit out of both totals; everything else is the raw
// difference (the pre-2026-10-09 improvement).
function moveGain({ service, current, currentScore, cand, candScore }) {
  const raw = candScore.total_score - currentScore.total_score;
  if (isUnplacedDueDate(service) || !isDayMove(current, cand)) return round2(raw);
  return round2(raw - ((candScore.default_time_score || 0) - (currentScore.default_time_score || 0)));
}

// Whether a candidate is a legal KIND of move at all, before the score bar:
// a same-day re-time always is; a day move needs the drive saving.
function meetsDriveFloor({ current, cand, config }) {
  const floor = config.minDayMoveDriveSavingMinutes || 0;
  // 0 turns the floor off: the score bar alone decides, as before.
  if (floor <= 0 || !isDayMove(current, cand)) return true;
  return driveSavingMinutes(current, cand) >= floor;
}

// A visit that must leave its slot whatever the score says.
function mustMove(service, current) {
  return isUnplacedDueDate(service) || !!(current && current.conflict);
}

/**
 * Rank scored candidates for one visit. Returns
 *   { best, bestScore, gain, qualifies, floorFailed, ranked }
 * `best` is the candidate the audit describes: the top qualifying one, else
 * the top one by gain (so a no-change row still shows the nearest miss).
 * `ranked` holds every qualifying candidate, best first (the SLOT_TAKEN
 * fallback list). `floorFailed` says the nearest miss was a day move that
 * saved too little drive.
 */
function rankCandidates({ service, current, currentScore, scored, threshold, config }) {
  const forced = mustMove(service, current);
  const sameDayFirst = !!(current && current.conflict && current.conflict.kind === 'overlap');
  const rows = scored.map(({ cand, sc }, index) => {
    const gain = moveGain({ service, current, currentScore, cand, candScore: sc });
    const floorOk = forced || meetsDriveFloor({ current, cand, config });
    return {
      cand, sc, gain, index, floorOk,
      qualifies: forced || (floorOk && gain >= threshold),
      sameDay: !isDayMove(current, cand),
    };
  });
  // Stable: ties keep encounter order (Array#sort is stable in V8).
  const byGain = (a, b) => (sameDayFirst ? Number(b.sameDay) - Number(a.sameDay) : 0) || b.gain - a.gain || a.index - b.index;
  const qualifying = rows.filter((r) => r.qualifies).sort(byGain);
  // Nothing qualifies: the audit shows the nearest miss by gain.
  const top = qualifying[0] || rows.slice().sort(byGain)[0] || null;
  return {
    best: top && top.cand,
    bestScore: top && top.sc,
    gain: top ? top.gain : 0,
    qualifies: qualifying.length > 0,
    // The nearest miss cleared the score bar and was refused by the drive floor.
    floorFailed: qualifying.length === 0 && !!top && !top.floorOk && top.gain >= threshold,
    ranked: qualifying.map((r) => r.cand),
  };
}

module.exports = {
  isUnplacedDueDate, isDayMove, driveSavingMinutes, moveGain, meetsDriveFloor, mustMove, rankCandidates,
};
