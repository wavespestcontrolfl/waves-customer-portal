/**
 * Placement scoring for auto-dispatch — PURE (no DB/I/O), unit-testable.
 *
 * 0–100, higher = better. Weights (sum 100):
 *   route efficiency 40 · customer preference 25 · technician 15
 *   route density 10 · workload balance 5 · same-tech continuity 5
 * Minus a stability penalty on candidates that move an already-moved visit.
 *
 * The same function scores the CURRENT placement and each candidate; the
 * orchestrator compares totals and only moves when the gain clears the
 * configured minimum (AUTO_DISPATCH_MIN_SCORE_IMPROVEMENT, points on this scale).
 */

const WEIGHTS = { route: 40, preference: 25, technician: 15, density: 10, workload: 5, continuity: 5 };
const DETOUR_CAP_MIN = 45;   // detour ≥ cap → 0 route-efficiency credit
const DENSITY_CAP = 6;       // stops/day at/above this → full density credit
const TIME_PROXIMITY_MIN = 90; // soft credit fades to 0 this many minutes outside the window
const CAPABILITY_FACTOR = { qualified: 1, review_required: 0.65, missing: 0.5, deactivated: 0 };

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function round2(v) { return Math.round(v * 100) / 100; }

function hhmmToMin(t) {
  if (!t) return null;
  const [h, m] = String(t).split(':').map(Number);
  if (Number.isNaN(h)) return null;
  return h * 60 + (m || 0);
}

// Weekday (0=Sun..6=Sat) of a YYYY-MM-DD calendar date, tz-independent (noon UTC).
function weekdayOf(dateStr) {
  if (!dateStr) return null;
  const d = new Date(`${String(dateStr).split('T')[0]}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d.getUTCDay();
}

/**
 * @param p  placement metrics { is_current, detour_minutes, stops_that_day,
 *           technician_id, date 'YYYY-MM-DD', start_time 'HH:MM', capability_level }
 * @param prefs normalized preferences (preferences.js)
 * @param ctx  { currentTechnicianId, changeCount }
 */
function scoreAppointmentPlacement(p, prefs, ctx = {}) {
  const reasons = [];

  // --- route efficiency (less detour = better) ---
  const detour = Math.max(0, p.detour_minutes || 0);
  const routeScore = WEIGHTS.route * clamp(1 - detour / DETOUR_CAP_MIN, 0, 1);

  // --- customer preference (day + time, split 50/50) ---
  const dayW = WEIGHTS.preference * 0.5;
  const timeW = WEIGHTS.preference * 0.5;
  let prefScore = 0;

  const dayIdx = prefs.preferred_day_indexes || [];
  if (dayIdx.length === 0) {
    prefScore += dayW; // no explicit day pref → neutral full credit
  } else {
    const dow = weekdayOf(p.date);
    if (dow != null && dayIdx.includes(dow)) {
      prefScore += dayW;
      reasons.push('MATCHES_PREFERRED_DAY');
    }
  }

  const win = prefs.effective_time_window;
  const startMin = hhmmToMin(p.start_time);
  if (win && startMin != null) {
    if (startMin >= win.startMin && startMin < win.endMin) {
      prefScore += timeW;
      reasons.push(prefs.preferred_time_window ? 'MATCHES_PREFERRED_TIME' : 'MATCHES_SERVICE_TIME_DEFAULT');
    } else {
      const dist = Math.min(Math.abs(startMin - win.startMin), Math.abs(startMin - win.endMin));
      prefScore += timeW * clamp(1 - dist / TIME_PROXIMITY_MIN, 0, 1);
    }
  } else {
    prefScore += timeW; // no usable window → neutral
  }

  // --- technician skill ---
  const techScore = WEIGHTS.technician * (CAPABILITY_FACTOR[p.capability_level] ?? 0.5);

  // --- route density (more nearby stops that day = better) ---
  const stops = p.stops_that_day || 0;
  const densityScore = WEIGHTS.density * clamp(stops / DENSITY_CAP, 0, 1);

  // --- workload balance (penalize overloaded days) ---
  const workloadScore = WEIGHTS.workload * (stops <= 6 ? 1 : clamp(1 - (stops - 6) / 4, 0, 1));

  // --- same-technician continuity ---
  let continuityScore = 0;
  if (p.is_current) {
    continuityScore = WEIGHTS.continuity; // staying put keeps its tech
  } else if (ctx.currentTechnicianId && p.technician_id
    && String(ctx.currentTechnicianId) === String(p.technician_id)) {
    continuityScore = WEIGHTS.continuity;
  }

  // --- stability penalty (candidates only): discourage re-moving a moved visit ---
  let stabilityPenalty = 0;
  if (!p.is_current && (ctx.changeCount || 0) > 0) {
    stabilityPenalty = Math.min(15, 5 * ctx.changeCount);
  }

  const total = clamp(
    routeScore + prefScore + techScore + densityScore + workloadScore + continuityScore - stabilityPenalty,
    0, 100,
  );

  return {
    total_score: round2(total),
    route_efficiency_score: round2(routeScore),
    customer_preference_score: round2(prefScore),
    technician_score: round2(techScore),
    density_score: round2(densityScore),
    workload_score: round2(workloadScore),
    continuity_score: round2(continuityScore),
    stability_penalty: round2(stabilityPenalty),
    reason_codes: reasons,
  };
}

module.exports = { scoreAppointmentPlacement, WEIGHTS, weekdayOf, _internals: { hhmmToMin } };
