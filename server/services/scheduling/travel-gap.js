/**
 * Travel gap — the ONE rule for "how much time must separate a candidate
 * window from the stops already on the calendar that day".
 *
 *   requiredGap(a, b) = driveMin(a, b) + SLOT_TRAVEL_BUFFER_MINUTES (default 15)
 *
 * Owner ruling 2026-09-23: the gap is measured from the EARLIER side's
 * EXPECTED end — window_start + its catalog expected-service minutes
 * (expected-service-minutes.js), clamped to its own window length — not
 * from the raw window end, and the buffer the drive must still clear is
 * reduced by that side's own padding (window minus expected):
 *
 *   requiredGap(early, late) = driveMin(early, late)
 *     + max(0, SLOT_TRAVEL_BUFFER_MINUTES - (early.windowMinutes - early.expectedMinutes))
 *
 * "early" is whichever of the two windows (real, unadjusted) ends first —
 * a candidate packed BEFORE a stop uses the CANDIDATE's own padding; a
 * candidate packed AFTER a stop uses the STOP's. Neither side's expected
 * minutes ever move a REAL overlap (raw window vs raw window) — only the
 * free-time-between-two-non-overlapping-windows measurement. A pair with no
 * expectedMinutes/windowMinutes data (legacy callers, or no catalog match)
 * gets zero padding — the exact legacy drive+buffer gap.
 *
 * Drive minutes come from route-optimizer's shared model via
 * auto-dispatch/geo.js driveMin (the same estimator find-time scores detours
 * with) — never a local copy. The fixed buffer is parking / setup / wrap-up
 * between two properties; it is one env value by owner ruling (2026-09-03),
 * NOT the dead service_zones.drive_buffer_minutes / services.scheduling_buffer_minutes
 * columns, which nothing reads.
 *
 * Every customer-facing offer lane that is not route-aware (estimate ASAP
 * capacity, spread windows, /book's hourly fan-out, rain-out day options)
 * filters with the same predicate the commit gates enforce
 * (occupancy.findConflictingVisits `travel` option), so an offered slot is
 * reservable and a reservable slot is offered — an offer/commit mismatch in
 * either direction is how the offer→reserve→409 dead-end loop happened.
 *
 * Deliberate boundaries:
 *   - Gate: GATE_SLOT_TRAVEL_GAP, read at CALL time. Off → violatesTravelGap
 *     always returns false and every caller is byte-for-byte legacy overlap.
 *   - Tech-blind, like occupancy.js: one active technician, so every stop on
 *     a date is on the same route regardless of technician_id.
 *   - Route NEIGHBOURS only. The gap is a rule between consecutive stops, so
 *     a candidate is measured against the latest-ending stop before it and
 *     the earliest-starting stop after it — never a farther stop with another
 *     visit in between (that pair's gap is the intermediate stop's problem,
 *     and measuring it rejected valid windows on calendars whose existing
 *     legs pre-date the rule). Overlaps count regardless of position.
 *   - Fail-open on coordinates: a coordless side (ungeocoded customer, a
 *     divergent stamped rental with no pin) contributes ZERO drive minutes,
 *     exactly find-time's convention, but the fixed buffer still applies. A
 *     missing geocode never hides a slot; it only loses the drive term.
 *   - Between STOPS only. HQ start/end legs get drive time (find-time) but
 *     never the buffer — the buffer is the turnaround between two customers.
 *   - An overlap (negative gap) is also a violation, so a caller may use this
 *     as its only predicate; the SQL overlap fast paths stay where they are.
 *   - CUSTOMER-FACING surfaces only (owner ruling 2026-09-03): the estimate
 *     picker, /book + reschedule + re-service, the voice agent, the rebooker,
 *     the AI assistant / lead-response booking lane. Staff-side and
 *     call-driven writers (admin-schedule, admin-leads, call-booking-catalog,
 *     call-recording-processor's booking flag, annual-prepay renewals,
 *     visit-group moves, window-rules) keep their overlap-only probes on
 *     purpose: those are office decisions, ADVISORY by owner ruling
 *     2026-08-25 (staff saves never block on conflicts), and the drive term
 *     there belongs to the route optimizer. `travel` is opt-in so every
 *     legacy probe stays byte-identical.
 */
const { driveMin } = require('../auto-dispatch/geo');
const { gateEnvValue } = require('../../config/feature-gates');

const DEFAULT_TRAVEL_BUFFER_MINUTES = 15;

function travelGapEnabled() {
  return gateEnvValue('GATE_SLOT_TRAVEL_GAP');
}

function travelBufferMinutes() {
  const raw = process.env.SLOT_TRAVEL_BUFFER_MINUTES;
  if (raw == null || String(raw).trim() === '') return DEFAULT_TRAVEL_BUFFER_MINUTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_TRAVEL_BUFFER_MINUTES;
  return Math.round(n);
}

/**
 * find-time's `bufferMinutes` for CUSTOMER-FACING callers only (estimate
 * picker, /book, the debug view): the fixed buffer when the gate is on, else
 * 0. Staff and optimizer callers (admin find-time, IB schedule tool,
 * auto-dispatch candidate slots) never pass it and keep legacy geometry.
 */
function customerFacingBufferMinutes() {
  return travelGapEnabled() ? travelBufferMinutes() : 0;
}

function coordsOf(point) {
  if (!point) return null;
  const lat = point.lat != null ? Number(point.lat) : NaN;
  const lng = point.lng != null ? Number(point.lng) : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

// windowMinutes of an entity: explicit windowMinutes wins, else endMin-startMin,
// else null (no window known — padding then falls back to zero below).
function windowMinutesOf(entity) {
  if (Number.isFinite(entity?.windowMinutes)) return entity.windowMinutes;
  if (Number.isFinite(entity?.startMin) && Number.isFinite(entity?.endMin)) return entity.endMin - entity.startMin;
  return null;
}

// Minutes of slack inside an entity's own window that its expected service
// time doesn't use — this is what "absorbs" the travel buffer (owner ruling
// 2026-09-23). No window/expected data -> 0 (no credit, legacy gap).
function paddingMinutesOf(entity) {
  const windowMinutes = windowMinutesOf(entity);
  if (!Number.isFinite(windowMinutes)) return 0;
  const expected = Number.isFinite(entity?.expectedMinutes)
    ? Math.min(entity.expectedMinutes, windowMinutes)
    : windowMinutes;
  return Math.max(0, windowMinutes - expected);
}

// The entity whose window starts first — its own padding is what reduces
// the required buffer for this pair (see the header). Ties (or missing
// startMin on either side) keep `a` as the reference, matching every
// existing legacy call site that passes plain {lat,lng} with no timing.
function earlierOf(a, b) {
  if (Number.isFinite(a?.startMin) && Number.isFinite(b?.startMin) && b.startMin < a.startMin) return b;
  return a;
}

/** Minutes that must separate two stops: modeled drive (0 when a side has no
 * pin) + the buffer, reduced by the earlier side's own padding (see header). */
function requiredGapMinutes(a, b) {
  const padding = paddingMinutesOf(earlierOf(a, b));
  return driveMin(coordsOf(a), coordsOf(b)) + Math.max(0, travelBufferMinutes() - padding);
}

// A stop's effective end for the free-time measurement: window_start + its
// (clamped) expected minutes. Real-overlap detection never uses this —
// only the non-overlapping free-time gap.
function effectiveEndMinutes(entity) {
  const windowMinutes = windowMinutesOf(entity);
  const expected = Number.isFinite(entity?.expectedMinutes) && Number.isFinite(windowMinutes)
    ? Math.min(entity.expectedMinutes, windowMinutes)
    : (windowMinutes ?? 0);
  return entity.startMin + expected;
}

/**
 * candidate / stop: { startMin, endMin, lat?, lng?, windowMinutes?,
 * expectedMinutes? } (minutes from midnight). Returns null when the pair is
 * fine, else { gapMin, requiredMin } — gapMin is the free time between the
 * two windows (negative on overlap). Gate-agnostic: callers decide via
 * travelGapEnabled()/violatesTravelGap.
 */
function travelGapViolation(candidate, stop) {
  if (!candidate || !stop) return null;
  if (![candidate.startMin, candidate.endMin, stop.startMin, stop.endMin].every(Number.isFinite)) return null;
  const requiredMin = requiredGapMinutes(candidate, stop);
  // Real overlap (raw windows, never adjusted by expected minutes) — the
  // exact legacy ternary, unconditionally a violation.
  const realOverlap = candidate.startMin < stop.endMin && stop.startMin < candidate.endMin;
  if (realOverlap) {
    const gapMin = stop.startMin >= candidate.endMin
      ? stop.startMin - candidate.endMin
      : candidate.startMin - stop.endMin;
    return { gapMin, requiredMin };
  }
  // No overlap: measure from the EARLIER side's effective (expected-minutes)
  // end to the LATER side's real start — its window_start is a promise to
  // whoever holds it and is never adjusted.
  const candidateEarly = candidate.endMin <= stop.startMin;
  const early = candidateEarly ? candidate : stop;
  const late = candidateEarly ? stop : candidate;
  const gapMin = late.startMin - effectiveEndMinutes(early);
  return gapMin < requiredMin ? { gapMin, requiredMin } : null;
}

function windowsOverlap(a, b) {
  return a.startMin < b.endMin && b.startMin < a.endMin;
}

/**
 * A live estimate hold (customer_id NULL + reservation_expires_at) occupies
 * route time but may expire without graduating, so it is measured against
 * the candidate like any stop yet never SHADOWS a committed neighbour — the
 * committed stop behind it becomes the real neighbour the moment the hold
 * lapses (GH codex #3803 r3 P1). Callers may set `hold` explicitly; rows
 * carrying the occupancy columns are recognised as they are.
 */
function isHoldStop(stop) {
  if (stop.hold != null) return stop.hold === true;
  return stop.reservation_expires_at != null && stop.customer_id == null;
}

/**
 * The stops a candidate fails against, in the order given: every overlapping
 * stop (reason 'overlap'), plus — of the non-overlapping stops — ONLY the
 * immediate COMMITTED route neighbours (latest-ending before, earliest-
 * starting after) and any live hold that could become one, when they sit
 * closer than the required gap (reason 'travel_gap'). See isHoldStop.
 * Gate-agnostic like travelGapViolation; malformed stops are skipped.
 * Returns [{ stop, reason }].
 */
function travelGapConflicts(candidate, stops) {
  if (!candidate || ![candidate.startMin, candidate.endMin].every(Number.isFinite)) return [];
  if (!Array.isArray(stops) || stops.length === 0) return [];
  const overlaps = [];
  const holds = [];
  // Every stop tied at the boundary is a neighbour (two legacy rows ending
  // at the same minute: the farther one still sets the gap).
  let before = [];
  let after = [];
  for (const stop of stops) {
    if (!stop || ![stop.startMin, stop.endMin].every(Number.isFinite)) continue;
    if (windowsOverlap(candidate, stop)) {
      overlaps.push({ stop, reason: 'overlap' });
    } else if (isHoldStop(stop)) {
      holds.push(stop);
    } else if (stop.endMin <= candidate.startMin) {
      if (!before.length || stop.endMin > before[0].endMin) before = [stop];
      else if (stop.endMin === before[0].endMin) before.push(stop);
    } else if (!after.length || stop.startMin < after[0].startMin) {
      after = [stop];
    } else if (stop.startMin === after[0].startMin) {
      after.push(stop);
    }
  }
  // A hold counts only where it COULD become the immediate neighbour: on a
  // side with no committed stop, or sitting between the committed neighbour
  // and the candidate. A hold behind a committed stop is never adjacent,
  // expired or graduated (GH codex #3803 r4 P2).
  const liveNeighbourHolds = holds.filter((hold) => (hold.endMin <= candidate.startMin
    ? !before.length || hold.endMin > before[0].endMin
    : !after.length || hold.startMin < after[0].startMin));
  const neighbours = [];
  for (const stop of [...before, ...after, ...liveNeighbourHolds]) {
    if (travelGapViolation(candidate, stop)) neighbours.push({ stop, reason: 'travel_gap' });
  }
  return overlaps.concat(neighbours);
}

/** True when the gate is on and a stop overlaps or a route neighbour sits closer than the required gap. */
function violatesTravelGap(candidate, stops) {
  if (!travelGapEnabled()) return false;
  return travelGapConflicts(candidate, stops).length > 0;
}

/**
 * One divergence-guarded read of a scheduled_services row's own pin for
 * commit gates that only hold the raw row (rebooker): the stamped
 * scheduled_services.lat/lng, else the non-divergent customer coords —
 * PLUS (Codex r6 P1 on #4664) that same row's own expected-minutes credit,
 * resolved from its catalog identity (service_key_snapshot/service_type)
 * exactly like every other reader of a scheduled row (expected-service-
 * minutes.js's byKey/byName lookup), windowed to its own current duration.
 * Every rebooker probe that threads this function's return as `travel` into
 * findConflictingVisits used to measure a co-located candidate from its
 * FULL window end (zero padding) — a packed offer availability.js/find-
 * time.js had already credited and promised then came back SLOT_TAKEN at
 * commit. findConflictingVisitsWithTravel re-clamps this to the actual
 * candidate (destination) window itself, so a stale/rougher value here can
 * never manufacture negative padding.
 * Returns { lat, lng, expectedMinutes } with nulls/window-length fallbacks
 * when unknown — never throws (fail-open). Gate off → undefined WITHOUT a
 * query, so a legacy move issues exactly the statements it issued before
 * (findConflictingVisits treats an undefined `travel` as "overlap only").
 */
async function resolveStopCoords(db, scheduledServiceId) {
  if (!travelGapEnabled()) return undefined;
  const none = { lat: null, lng: null };
  if (!db || !scheduledServiceId) return none;
  try {
    const { guardedCoordSelects } = require('./day-stops');
    const row = await db('scheduled_services')
      .where('scheduled_services.id', scheduledServiceId)
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .select(
        ...guardedCoordSelects(db),
        'scheduled_services.estimated_duration_minutes',
        'scheduled_services.service_key_snapshot',
        'scheduled_services.service_type',
      )
      .first();
    const coords = coordsOf(row) || none;
    if (!row) return coords;
    const { expectedServiceMinutes } = require('./expected-service-minutes');
    const windowMinutes = Number(row.estimated_duration_minutes) > 0 ? Number(row.estimated_duration_minutes) : 60;
    const expectedMinutes = await expectedServiceMinutes(db, {
      serviceKey: row.service_key_snapshot, serviceType: row.service_type, windowMinutes,
    });
    return { ...coords, expectedMinutes };
  } catch {
    return none;
  }
}

module.exports = {
  DEFAULT_TRAVEL_BUFFER_MINUTES,
  travelGapEnabled,
  travelBufferMinutes,
  customerFacingBufferMinutes,
  requiredGapMinutes,
  travelGapViolation,
  travelGapConflicts,
  isHoldStop,
  violatesTravelGap,
  resolveStopCoords,
  // Exported for find-time.js's earliest/latest gap geometry, so its
  // packed-ends math shares this exact padding/effective-end formula
  // instead of a local copy (owner ruling 2026-09-23).
  paddingMinutesOf,
  effectiveEndMinutes,
};
