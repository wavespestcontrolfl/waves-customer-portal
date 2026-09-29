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
 *
 * Arrival grace (self-serve arrival-window lane, owner ruling 2026-09-28,
 * dark until SELF_SERVE_ARRIVAL_GRACE_MINUTES is set): every customer
 * surface still PROMISES the same 2-hour arrival window (ARRIVAL_WINDOW_
 * MINUTES) it always has — a caller may now also accept a candidate the
 * tech would arrive AT up to `candidate.graceMinutes` minutes late, instead
 * of demanding it be free at the exact stored minute. Grace reaches this
 * module ONLY as `candidate.graceMinutes` (selfServeArrivalGraceMinutes()
 * below, read by the caller and stamped onto the candidate it builds) —
 * this module never reads the env itself. `candidate.graceMinutes` falsy or
 * 0 is BYTE-IDENTICAL to every check this file ran before this lane:
 * effectiveEndMinutes/paddingMinutesOf only change when a stop carries an
 * `arrivalMin` the caller set, and nothing sets one at grace 0
 * (annotateProjectedArrivals is never even called by travelGapConflicts
 * below). Rules, most restrictive first:
 *   - A real overlap (raw window vs raw window) is NEVER graced (G3) — grace
 *     only widens how much LATE ARRIVAL a non-overlapping neighbour tolerates,
 *     never how much two promised windows may overlap.
 *   - The EARLIER side of a pair (a candidate packed before a real stop, or a
 *     stop before a graced candidate) stays STRICT — a self-serve booking
 *     never makes another stop's arrival later than that stop's own promise
 *     (owner decision 5; travelGapViolation's `candidateEarly` branch never
 *     reads `graceMinutes`). Only the LATER side of a pair — the graced
 *     candidate's own arrival, or a later candidate arriving after an
 *     existing stop — may run up to `graceMinutes` late.
 *   - A LIVE HOLD gets no grace on its own next-side check (A6/isHoldStop):
 *     whichever customer reserved a window first always keeps it, because
 *     the hold's own strict check against whoever comes after it is exactly
 *     what the later, graced candidate must also clear — order decides who
 *     gets an open slot, never who loses one they already hold.
 *   - annotateProjectedArrivals projects that day's REAL stops (committed
 *     rows + live holds) forward along the chain of required gaps — so a
 *     second or third graced booking is measured from where the tech will
 *     REALLY be (chained lateness), not from the first stop's stored,
 *     never-adjusted end. travelGapConflicts only runs the projection when
 *     `candidate.graceMinutes > 0`; its own before/after neighbour SELECTION
 *     is unchanged (still latest-ending-before / earliest-starting-after /
 *     tie / hold-shadow rules) — only how far along its route that
 *     neighbour has actually gotten changes.
 */
const { driveMin } = require('../auto-dispatch/geo');
const { gateEnvValue } = require('../../config/feature-gates');
const { ARRIVAL_WINDOW_MINUTES } = require('../../utils/sms-time-format');
const { etDateString } = require('../../utils/datetime-et');
const logger = require('../logger');

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

// SELF_SERVE_ARRIVAL_GRACE_MINUTES (A1, owner ruling 2026-09-28) — how many
// minutes past a candidate's stored start a self-serve surface may accept
// the tech actually arriving. Read AT CALL TIME by every caller, never
// cached: blank/unset/garbage/negative -> 0 (dark — this lane's own kill
// switch, no GATE_* needed); a value above ARRIVAL_WINDOW_MINUTES (120, the
// promised arrival window every surface quotes) is clamped down to it with
// one warning, since grace can never exceed the promise it rides inside.
// `date` (an ET 'YYYY-MM-DD') forces 0 when it is TODAY (owner decision 2:
// legacy mode has no live-route-state signal for same-day, so it never adds
// slack on top of it) — one obvious switch point if that is ever revisited.
// Callers with no single date (a multi-date find-time sweep) omit `date` and
// zero out today's OWN candidates themselves (see find-time.js), so this
// reader still returns the raw configured value for them.
// Clamp-warning de-dup (Claude fallback pre-push review, 2026-09-28): this
// reader runs per candidate slot (booking.js addCandidate), per
// filterCollidingSlots pass, per reserve/commit/extend, and per debug call
// — every one of them on every self-serve request. Without this latch, one
// mis-set env value (e.g. 200) would log the clamp warning on every such
// call instead of the "one warning" the header promises. Warns again only
// when the raw value actually CHANGES (a fresh misconfiguration), not on
// every read of the same one.
let lastWarnedRawGrace;
function selfServeArrivalGraceMinutes({ date } = {}) {
  const raw = process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES;
  if (raw == null || String(raw).trim() === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  let minutes = Math.round(n);
  if (minutes > ARRIVAL_WINDOW_MINUTES) {
    if (lastWarnedRawGrace !== raw) {
      logger.warn(`[travel-gap] SELF_SERVE_ARRIVAL_GRACE_MINUTES=${raw} exceeds the ${ARRIVAL_WINDOW_MINUTES}-minute arrival promise — clamped`);
      lastWarnedRawGrace = raw;
    }
    minutes = ARRIVAL_WINDOW_MINUTES;
  }
  if (date && String(date).slice(0, 10) === etDateString()) return 0;
  return minutes;
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
// Arrival grace (A2): an entity carrying `arrivalMin` later than its own
// `startMin` (a projected or graced late arrival) has already spent that
// lateness out of its own window slack before any buffer credit — a stop
// running late eats its OWN padding first, never manufactures extra buffer
// credit for its neighbour. `arrivalMin` is only ever set by
// annotateProjectedArrivals or a grace-aware caller; unset (every call site
// at grace 0) makes this byte-identical to the formula above.
function paddingMinutesOf(entity) {
  const windowMinutes = windowMinutesOf(entity);
  if (!Number.isFinite(windowMinutes)) return 0;
  const expected = Number.isFinite(entity?.expectedMinutes)
    ? Math.min(entity.expectedMinutes, windowMinutes)
    : windowMinutes;
  const lateness = Number.isFinite(entity?.arrivalMin) && Number.isFinite(entity?.startMin)
    ? Math.max(0, entity.arrivalMin - entity.startMin)
    : 0;
  return Math.max(0, windowMinutes - expected - lateness);
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

// A stop's effective end for the free-time measurement: its (arrival-aware)
// start + its (clamped) expected minutes. Real-overlap detection never uses
// this — only the non-overlapping free-time gap. Arrival grace (A2): when
// the entity carries `arrivalMin` (a projected or graced actual arrival,
// never earlier than `startMin`) the effective end is measured from THERE,
// not from the stored `startMin` — a late-running stop's promised expected
// minutes still apply, just starting from when the tech really got there.
// `arrivalMin` unset (every call site at grace 0) is byte-identical to the
// formula this file has always used.
function effectiveEndMinutes(entity) {
  const windowMinutes = windowMinutesOf(entity);
  const expected = Number.isFinite(entity?.expectedMinutes) && Number.isFinite(windowMinutes)
    ? Math.min(entity.expectedMinutes, windowMinutes)
    : (windowMinutes ?? 0);
  const base = Number.isFinite(entity?.arrivalMin) ? entity.arrivalMin : entity.startMin;
  return base + expected;
}

/**
 * candidate / stop: { startMin, endMin, lat?, lng?, windowMinutes?,
 * expectedMinutes?, graceMinutes?, arrivalMin? } (minutes from midnight).
 * Returns null when the pair is fine, else { gapMin, requiredMin, lateMin? }
 * — gapMin is the free time between the two windows (negative on overlap).
 * Gate-agnostic: callers decide via travelGapEnabled()/violatesTravelGap.
 *
 * Arrival grace (A3, owner ruling 2026-09-28): `candidate.graceMinutes` (set
 * by the caller from selfServeArrivalGraceMinutes(), never read here) only
 * ever widens the LATER side of a non-overlapping pair — a candidate packed
 * AFTER `stop` may accept arriving up to `graceMinutes` minutes past its own
 * stored start, EXCEPT against a live hold (isHoldStop), which always gets
 * the strict (0) allowance (A6 — the hold's own next-side check is already
 * what the later candidate must clear, so ordering alone decides who keeps
 * an open slot). The EARLIER side (decision 5: a self-serve booking never
 * makes an existing stop's arrival later) and every real overlap (G3) never
 * read `graceMinutes` at all. `graceMinutes` falsy/0 makes the "candidate
 * later" branch byte-identical to the legacy gapMin < requiredMin check.
 */
function travelGapViolation(candidate, stop) {
  if (!candidate || !stop) return null;
  if (![candidate.startMin, candidate.endMin, stop.startMin, stop.endMin].every(Number.isFinite)) return null;
  const requiredMin = requiredGapMinutes(candidate, stop);
  // Real overlap (raw windows, never adjusted by expected minutes or grace)
  // — the exact legacy ternary, unconditionally a violation (G3).
  const realOverlap = candidate.startMin < stop.endMin && stop.startMin < candidate.endMin;
  if (realOverlap) {
    const gapMin = stop.startMin >= candidate.endMin
      ? stop.startMin - candidate.endMin
      : candidate.startMin - stop.endMin;
    return { gapMin, requiredMin };
  }
  const candidateEarly = candidate.endMin <= stop.startMin;
  if (candidateEarly) {
    // Candidate packed BEFORE stop: stop's window_start is a promise to
    // whoever holds it and is never adjusted by the candidate's grace
    // (decision 5) — strict, measured from the candidate's own projected/
    // graced arrival (effectiveEndMinutes reads candidate.arrivalMin when
    // travelGapConflicts' pass 2 has set one; unset = candidate.startMin,
    // byte-identical to before).
    const gapMin = stop.startMin - effectiveEndMinutes(candidate);
    return gapMin < requiredMin ? { gapMin, requiredMin } : null;
  }
  // Candidate packed AFTER stop: how late the candidate would really arrive
  // (A) is measured from the stop's own effective — or, once annotated,
  // PROJECTED — end, floored at the candidate's own stored start (never
  // earlier than promised). `lateMin` is how much of that the candidate
  // must absorb; a violation only when it exceeds what this pair allows.
  const A = Math.max(candidate.startMin, effectiveEndMinutes(stop) + requiredMin);
  const lateMin = A - candidate.startMin;
  const gapMin = candidate.startMin - effectiveEndMinutes(stop);
  const allowed = isHoldStop(stop) ? 0 : (candidate.graceMinutes || 0);
  return lateMin > allowed ? { gapMin, requiredMin, lateMin } : null;
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
 * A2 — the cascade fix. Sorts `stops` (that day's real rows: committed
 * visits AND live holds, whatever set the caller already has — never the
 * candidate itself) by `startMin` and walks the chain forward:
 *   arrivalMin_i = max(startMin_i, effectiveEndMinutes(stop_{i-1}) +
 *     requiredGapMinutes(stop_{i-1}, stop_i))
 * — the first stop is on time (no prior neighbour). Each returned copy
 * carries `arrivalMin`, which effectiveEndMinutes/paddingMinutesOf above
 * then read for THAT stop's own effective end and padding, so a second or
 * third graced booking is measured from where the tech will REALLY be
 * (chained lateness through the day), not from a stop's stored, never-
 * adjusted end. The HQ start/end legs are never real stops and must not be
 * passed in here (find-time.js's toPackingBoundAnchor never builds one for
 * them). A coordless leg still gets a buffer-only required gap (driveMin's
 * own fail-open), so it neither vanishes from nor short-circuits the chain.
 * Callers that never see a graced candidate never call this at all
 * (travelGapConflicts below gates it on `candidate.graceMinutes > 0`), so a
 * stop's `arrivalMin` is never set at grace 0 — byte-identical.
 */
function annotateProjectedArrivals(stops) {
  const sorted = [...stops].sort((a, b) => a.startMin - b.startMin);
  let prev = null;
  return sorted.map((stop) => {
    const arrivalMin = prev
      ? Math.max(stop.startMin, effectiveEndMinutes(prev) + requiredGapMinutes(prev, stop))
      : stop.startMin;
    const annotated = { ...stop, arrivalMin };
    prev = annotated;
    return annotated;
  });
}

/**
 * The stops a candidate fails against, in the order given: every overlapping
 * stop (reason 'overlap'), plus — of the non-overlapping stops — ONLY the
 * immediate COMMITTED route neighbours (latest-ending before, earliest-
 * starting after) and any live hold that could become one, when they sit
 * closer than the required gap (reason 'travel_gap'). See isHoldStop.
 * Gate-agnostic like travelGapViolation; malformed stops are skipped.
 * Returns [{ stop, reason }].
 *
 * Arrival grace (A4): neighbour SELECTION above is unchanged — only how far
 * along its route a "before" neighbour has actually gotten, and therefore
 * how late the candidate's own real arrival lands, changes. When
 * `candidate.graceMinutes > 0`: pass 1 projects the whole day (A2) and
 * folds every before-side neighbour (committed + live hold) into the
 * candidate's own projected arrival `A` — the worst (latest) one wins, since
 * that is genuinely when the tech gets there; pass 2 checks every after-side
 * neighbour against `{...candidate, arrivalMin: A}`, so a graced candidate
 * can never itself push a later stop's arrival past ITS OWN strict promise
 * (decision 5 — travelGapViolation's candidateEarly branch never reads
 * grace). At `graceMinutes` 0 (or unset) neither pass runs: every neighbour
 * is checked against the plain `candidate`, in the exact original
 * before/after/hold order — byte-identical to the pre-grace code path.
 */
// Classifies `stops` against `candidate` into the shapes travelGapConflicts
// needs: every real overlap, every valid (finite-window) stop for the A2
// projection, and the immediate committed neighbours (latest-ending before /
// earliest-starting after, ties included) plus any live hold that could
// become one (GH codex #3803 r4 P2 — a hold behind a committed stop is
// never adjacent). Pulled out of travelGapConflicts to keep its own
// branching to the grace-projection decision alone.
function classifyStopsAroundCandidate(candidate, stops) {
  const overlaps = [];
  const holds = [];
  const validStops = [];
  let before = [];
  let after = [];
  for (const stop of stops) {
    if (!stop || ![stop.startMin, stop.endMin].every(Number.isFinite)) continue;
    validStops.push(stop);
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
  const liveNeighbourHolds = holds.filter((hold) => (hold.endMin <= candidate.startMin
    ? !before.length || hold.endMin > before[0].endMin
    : !after.length || hold.startMin < after[0].startMin));
  return {
    overlaps, validStops, before, after, liveNeighbourHolds,
  };
}

// A2/A4 — the grace projection, isolated from travelGapConflicts' own
// neighbour-selection branching. Returns `annotate` (a stop -> its
// projected-arrival copy, identity when grace is 0) and
// `candidateForAfterSide` (the candidate with its own real arrival folded
// in from every before-side neighbour, unchanged when grace is 0 or there
// is no before-side neighbour at all) — see travelGapConflicts' own header
// for the full rule.
function projectGraceForCandidate(candidate, { validStops, before, liveNeighbourHolds }) {
  if (!(candidate.graceMinutes > 0)) return { annotate: (stop) => stop, candidateForAfterSide: candidate };
  const projected = annotateProjectedArrivals(validStops);
  // annotateProjectedArrivals sorts its own copy of validStops (same array,
  // same comparator -> Array#sort's stability guarantees the same order
  // both times), so index i of that sort is exactly stop i here.
  const sortedOriginals = [...validStops].sort((a, b) => a.startMin - b.startMin);
  const byOriginal = new Map(sortedOriginals.map((stop, i) => [stop, projected[i]]));
  const annotate = (stop) => byOriginal.get(stop) || stop;
  const beforeSide = [...before, ...liveNeighbourHolds.filter((hold) => hold.endMin <= candidate.startMin)];
  if (!beforeSide.length) return { annotate, candidateForAfterSide: candidate };
  const arrival = beforeSide.reduce((acc, stop) => {
    const annotated = annotate(stop);
    return Math.max(acc, effectiveEndMinutes(annotated) + requiredGapMinutes(annotated, candidate));
  }, candidate.startMin);
  return { annotate, candidateForAfterSide: { ...candidate, arrivalMin: arrival } };
}

function travelGapConflicts(candidate, stops) {
  if (!candidate || ![candidate.startMin, candidate.endMin].every(Number.isFinite)) return [];
  if (!Array.isArray(stops) || stops.length === 0) return [];
  const {
    overlaps, validStops, before, after, liveNeighbourHolds,
  } = classifyStopsAroundCandidate(candidate, stops);
  // A2/A4 — projected only for a candidate that can actually accept
  // lateness; `annotate`/`candidateForAfterSide` stay identity/unchanged
  // otherwise, so the loop below is the legacy single-pass check at grace 0.
  const { annotate, candidateForAfterSide } = projectGraceForCandidate(
    candidate, { validStops, before, liveNeighbourHolds },
  );
  const neighbours = [];
  for (const stop of [...before, ...after, ...liveNeighbourHolds]) {
    const isBeforeSide = stop.endMin <= candidate.startMin;
    const evalCandidate = isBeforeSide ? candidate : candidateForAfterSide;
    if (travelGapViolation(evalCandidate, annotate(stop))) neighbours.push({ stop, reason: 'travel_gap' });
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
  selfServeArrivalGraceMinutes,
  requiredGapMinutes,
  travelGapViolation,
  travelGapConflicts,
  annotateProjectedArrivals,
  isHoldStop,
  violatesTravelGap,
  resolveStopCoords,
  // Exported for find-time.js's earliest/latest gap geometry, so its
  // packed-ends math shares this exact padding/effective-end formula
  // instead of a local copy (owner ruling 2026-09-23).
  paddingMinutesOf,
  effectiveEndMinutes,
};
