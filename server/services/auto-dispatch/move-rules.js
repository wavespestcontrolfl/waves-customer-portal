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
 *     taken first when the day itself stays open; then the slot that adds
 *     the least drive. A slot that adds more than
 *     config.conflictMaxAddedDriveMinutes is never taken: the visit stays
 *     and the audit row says CONFLICT_NO_NEAR_SLOT (a person decides).
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

// A score's total with the default-time credit left out (scoring.js clamps
// it separately; a breakdown without the field falls back to subtraction).
function withoutDefaultTime(score) {
  return score.total_without_default_time ?? (score.total_score - (score.default_time_score || 0));
}

// Points the candidate gains over the current placement. A day move leaves
// the default-time credit out of both totals; everything else is the raw
// difference (the pre-2026-10-09 improvement).
function moveGain({ service, current, currentScore, cand, candScore }) {
  const raw = candScore.total_score - currentScore.total_score;
  if (isUnplacedDueDate(service) || !isDayMove(current, cand)) return round2(raw);
  return round2(withoutDefaultTime(candScore) - withoutDefaultTime(currentScore));
}

// Whether a candidate is a legal KIND of move at all, before the score bar:
// a same-day re-time always is; a day move needs the drive saving.
function meetsDriveFloor({ current, cand, config }) {
  const floor = config.minDayMoveDriveSavingMinutes || 0;
  // 0 turns the floor off: the score bar alone decides, as before.
  if (floor <= 0 || !isDayMove(current, cand)) return true;
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
  const conflict = (current && current.conflict) || null;
  const sameDayFirst = !!(conflict && conflict.kind === 'overlap');
  const rows = scored.map(({ cand, sc }, index) => {
    const gain = moveGain({ service, current, currentScore, cand, candScore: sc });
    const normalFloorOk = meetsDriveFloor({ current, cand, config });
    const floorOk = forced || normalFloorOk;
    const ceilingOk = !conflict || withinConflictCeiling({ current, cand, config });
    return {
      cand, sc, gain, index, floorOk, ceilingOk,
      // Would this slot move the visit with no conflict to force it?
      normalOk: normalFloorOk && gain >= threshold,
      saving: driveSavingMinutes(current, cand),
      qualifies: forced ? ceilingOk : (floorOk && gain >= threshold),
      sameDay: !isDayMove(current, cand),
    };
  });
  // Stable: ties keep encounter order (Array#sort is stable in V8). A
  // conflict move ranks by least added drive before score.
  const byGain = (a, b) => (sameDayFirst ? Number(b.sameDay) - Number(a.sameDay) : 0)
    || (conflict ? b.saving - a.saving : 0) || b.gain - a.gain || a.index - b.index;
  const qualifying = rows.filter((r) => r.qualifies).sort(byGain);
  // Nothing qualifies: the audit shows the nearest miss.
  const top = qualifying[0] || rows.slice().sort(byGain)[0] || null;
  return {
    best: top && top.cand,
    bestScore: top && top.sc,
    gain: top ? top.gain : 0,
    qualifies: qualifying.length > 0,
    // The nearest miss cleared the score bar and was refused by the drive floor.
    floorFailed: qualifying.length === 0 && !!top && !forced && !top.floorOk && top.gain >= threshold,
    // A visit in conflict whose every slot adds too much drive.
    ceilingFailed: qualifying.length === 0 && !!top && !!conflict && !top.ceilingOk,
    // A visit in conflict that an ordinary optimization would move anyway:
    // it still moves after its overlapping partner has left.
    movesWithoutConflict: !!conflict && rows.some((r) => r.normalOk),
    // ...and the slot it would take then: ranked by gain alone, the order of
    // a visit with no conflict (Codex #6207 r10 P2).
    ...normalBestOf(conflict, rows),
    ranked: qualifying.map((r) => r.cand),
  };
}

function normalBestOf(conflict, rows) {
  if (!conflict) return {};
  const top = rows.filter((r) => r.normalOk).sort((a, b) => b.gain - a.gain || a.index - b.index)[0];
  return top ? { normalBest: top.cand, normalBestScore: top.sc } : {};
}

module.exports = {
  isUnplacedDueDate, isDayMove, driveSavingMinutes, moveGain, meetsDriveFloor, withinConflictCeiling, mustMove, rankCandidates,
};
