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
const { driveMin, HQ } = require('../auto-dispatch/geo');
const { gateEnvValue } = require('../../config/feature-gates');
const { ARRIVAL_WINDOW_MINUTES } = require('../../utils/sms-time-format');
const { etDateString } = require('../../utils/datetime-et');
const { currentDayEndMinutes } = require('./customer-windows');
// The one fixed day-open anchor every scheduling engine shares (Codex round
// 4 on #5310) — find-time.js's own DAY_START_HOUR default (8*60) IS this
// same value; SHIFT is the neutral module both files can read without a
// cycle (find-time.js requires travel-gap.js, so the reverse is refused).
const { SHIFT } = require('./policy');
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
  // GATE_SLOT_TRAVEL_GAP off (Codex round 1 on #5310): the commit-side
  // probes fall back to the plain overlap SQL (findConflictingVisits'
  // travel branch never runs — see its own header), which has no concept
  // of "arrival" at all and so cannot enforce a grace bound. An offer built
  // with grace > 0 while the gate is off would promise lateness the commit
  // gate can't actually check for. One reader, so every offer and commit
  // site agrees without each having to remember this precondition itself.
  if (!travelGapEnabled()) return 0;
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
 * — seeded (Codex round 4 P1 on #5310) at the FIRST stop's own real HQ
 * arrival floor, max(startMin, SHIFT.startMinutes + driveMin(HQ, stop)) —
 * mirrors find-time.js's `hqStartArrivalFloor` exactly (same fixed
 * day-open anchor, `SHIFT.startMinutes`, the same 08:00 every scheduling
 * engine shares; same HQ coords) — NOT an assumed on-time arrival. That
 * first stop may itself have been booked with grace on its own HQ→stop
 * leg (round 2's leading-gap fix on find-time's OFFER side already accounts
 * for this per candidate; this chain is the COMMIT-side mirror of the same
 * fact for every stop already on the calendar). Seeding it optimistically
 * understated lateness for every later stop chained off it — a candidate
 * projected from an artificially-early first stop could exceed the grace
 * bound, the 120-minute promise, or the day-end bound (round 3's fix)
 * despite a real route that never actually clears them. Each returned copy
 * carries `arrivalMin`, which effectiveEndMinutes/paddingMinutesOf above
 * then read for THAT stop's own effective end and padding, so a second or
 * third graced booking is measured from where the tech will REALLY be
 * (chained lateness through the day), not from a stop's stored, never-
 * adjusted end. The HQ start/end legs are never real stops and must not be
 * passed in here (find-time.js's toPackingBoundAnchor never builds one for
 * them) — the HQ leg is folded into the FIRST real stop's own seed instead,
 * exactly as find-time's own hqStartArrivalFloor is folded into its first
 * gap rather than modeled as a stop. A coordless leg (either side) still
 * gets a buffer-only required gap / zero HQ drive (driveMin's own
 * fail-open), so it neither vanishes from nor short-circuits the chain.
 * Callers that never see a graced candidate never call this at all
 * (travelGapConflicts below gates it on `candidate.graceMinutes > 0`), so a
 * stop's `arrivalMin` is never set at grace 0 — byte-identical.
 *
 * Multi-row physical stops (Codex round 4 P2 on #5310, proactive scan): two
 * DIFFERENT mechanisms represent one physical stop as several
 * scheduled_services rows, and chaining their members as ordinary separate
 * stops applied a full requiredGapMinutes buffer BETWEEN simultaneous,
 * co-located rows — pushing a later real candidate's projected lateness
 * past what the tech's actual route would produce and hiding genuinely
 * open slots at both offer and commit:
 *   - A version-2 combined (multi-service) allocation is one row PER
 *     SERVICE, each already expanded by occupiedRows/stopCreditResolver
 *     (find-time.js's buildDayStops, occupancy.js's buildTravelGapStops)
 *     to the SAME allocation-summed {startMin, endMin, expectedMinutes} —
 *     every member is a full DUPLICATE of the combined stop, so the group
 *     just reuses one member's own (already-correct) shape verbatim.
 *   - A service-visit group (`visit_id`, docs/design/visit-group-scope.md)
 *     is "same customer, property, date, OVERLAPPING window" — members are
 *     NOT pre-expanded to a shared span or summed credit the way an
 *     allocation's are, so the group recomputes its own combined bounds
 *     (earliest member start to latest member end) and sums each member's
 *     own expected minutes (arrival-route.js's groupRouteStops documents
 *     the same "sum of members' work, one journey" contract for its
 *     separate capacity-mode simulation — this is the SQL-overlap model's
 *     mirror of that fact, not a port of its own offset/intersection math).
 * Both identities are stamped by the caller from the RAW row (allocationKey
 * needs reservation_service_mix/customer_id/technician_id/scheduled_date/
 * window_start; visit_id is the row's own column — neither survives onto
 * this transformed shape). A row can carry visit_id XOR allocationKey, never
 * both (arrival-route.js's own groupRouteStops key precedence: `row.visit_id
 * || allocationKey(row)`) — visit_id checked first here for the same
 * precedence. Consecutive same-key stops (allocation members are guaranteed
 * adjacent after sorting — one shared window_start; visit-group members
 * are adjacent whenever their overlapping windows actually overlap, the
 * only case worth coalescing) are grouped into ONE logical stop for the
 * chain — the group shares a single `arrivalMin` (they arrive together)
 * and the NEXT stop's gap is measured against the group's own combined
 * effective end once, not once per member. Neither key set (every ordinary
 * row, and every caller from before this fix) never groups — byte-identical.
 */
function combinedStopEntity(members, isVisitGroup) {
  if (!isVisitGroup) return members[0]; // v2 allocation: every member IS the combined {startMin,endMin,expectedMinutes} duplicate already.
  // visit_id group: members are raw, un-summed rows — combine their own
  // bounds/credit here (SUM of work, MIN start to MAX end — the "one
  // journey" contract groupRouteStops documents for the capacity-mode
  // simulation, applied to this module's own shape).
  const startMin = Math.min(...members.map((m) => m.startMin));
  const endMin = Math.max(...members.map((m) => m.endMin));
  const expectedMinutes = members.reduce(
    (sum, m) => sum + (Number.isFinite(m.expectedMinutes) ? m.expectedMinutes : Math.max(0, m.endMin - m.startMin)), 0,
  );
  return { startMin, endMin, expectedMinutes, lat: members[0].lat, lng: members[0].lng };
}

// Codex round 6 on #5310 (STRUCTURAL): the ONE chain-walk this whole A2/A4
// lane is built on, coalescing multi-row physical stops (allocationKey/
// visit_id) into logical groups first and HQ-seeding whichever logical
// stop is first — extracted so every grace decision walks this SAME
// timeline instead of a second, parallel, independently-incomplete copy
// (rounds 4-5 fixed this walk itself; round 6's two findings were both
// consumers that had drifted from it: projectGraceForCandidate's own
// candidate-arrival formula for the no-before-neighbour case, and its
// `annotate()` reading an individual group MEMBER's own un-combined shape
// instead of the group's). Returns:
//  - `sorted`: the input, sorted by startMin (stable — ties keep input order).
//  - `arrivalByStop`: member row -> its group's shared arrivalMin (a plain
//    number). This is annotateProjectedArrivals' own public contract below,
//    stamped onto EACH MEMBER'S OWN individual copy — find-time.js's
//    buildDayStops returns that array AS its `dayStops`, read field by
//    field for purposes far beyond grace math (id, customer, city, its own
//    packedBounds geometry), so a member must never lose its own identity.
//  - `combinedByStop`: member row -> the GROUP's own combined entity
//    (startMin/endMin/expectedMinutes spanning every member, the shared
//    arrivalMin, and `hold` true if ANY member is a live hold) — used ONLY
//    by projectGraceForCandidate's `annotate()` below, which feeds
//    effectiveEndMinutes/paddingMinutesOf/travelGapViolation: those need
//    the group's TRUE combined shape (Codex round 6 P1) — reading an
//    individual member's own un-widened window/credit understated a
//    visit_id group's real occupancy exactly the way an ungrouped chain
//    once did before rounds 4-5's own fix.
function projectDayChain(stops) {
  const sorted = [...stops].sort((a, b) => a.startMin - b.startMin);
  const groups = [];
  for (const stop of sorted) {
    const key = (stop.visit_id != null ? `visit:${stop.visit_id}` : null) || stop.allocationKey || null;
    const last = groups[groups.length - 1];
    if (key && last?.key === key) last.members.push(stop);
    else groups.push({ key, isVisitGroup: stop.visit_id != null, members: [stop] });
  }
  let prev = null;
  const arrivalByStop = new Map();
  const combinedByStop = new Map();
  for (const group of groups) {
    const lead = combinedStopEntity(group.members, group.isVisitGroup);
    const arrivalMin = prev
      ? Math.max(lead.startMin, effectiveEndMinutes(prev) + requiredGapMinutes(prev, lead))
      : Math.max(lead.startMin, SHIFT.startMinutes + driveMin(HQ, coordsOf(lead)));
    const combined = { ...lead, arrivalMin, hold: group.members.some((member) => isHoldStop(member)) };
    for (const member of group.members) {
      arrivalByStop.set(member, arrivalMin);
      combinedByStop.set(member, combined);
    }
    prev = combined;
  }
  return { sorted, arrivalByStop, combinedByStop };
}

function annotateProjectedArrivals(stops) {
  const { sorted, arrivalByStop } = projectDayChain(stops);
  return sorted.map((stop) => ({ ...stop, arrivalMin: arrivalByStop.get(stop) }));
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
// Codex round 6 P1s on #5310, both fixed by routing through projectDayChain
// (the SAME timeline annotateProjectedArrivals walks) instead of this
// function's own two parallel shortcuts:
//   1. (travel-gap.js:518, the `annotate` below) used to read an individual
//      group MEMBER's own un-combined shape — now reads combinedByStop, the
//      group's TRUE combined entity, so a graced candidate placed right
//      after a visit_id group is measured against the group's real
//      (summed-work, full-span) effective end, not one member's own.
//   2. (travel-gap.js:518's OWN sibling, the no-before-neighbour return)
//      used to hand back `candidate` completely unchanged (no arrivalMin at
//      all) whenever the candidate has no real stop before it — so the
//      STRICT after-side check (travelGapViolation's candidateEarly branch,
//      decision 5) measured the candidate's effective end from its bare,
//      possibly-graced-early advertised start instead of its own real HQ
//      arrival, silently ACCEPTING a later real stop the candidate's true
//      (late) finish would actually collide with. `candidateForAfterSide`
//      now ALWAYS carries an arrivalMin whenever grace > 0 — the SAME
//      HQ-seed formula projectDayChain's own first-entry case uses,
//      because a candidate with no real predecessor IS, for this purpose,
//      the day's first entity too.
function projectGraceForCandidate(candidate, { validStops, before, liveNeighbourHolds }) {
  if (!(candidate.graceMinutes > 0)) return { annotate: (stop) => stop, candidateForAfterSide: candidate };
  const { combinedByStop } = projectDayChain(validStops);
  const annotate = (stop) => combinedByStop.get(stop) || stop;
  const beforeSide = [...before, ...liveNeighbourHolds.filter((hold) => hold.endMin <= candidate.startMin)];
  const arrivalMin = beforeSide.length
    ? beforeSide.reduce((acc, stop) => {
      const annotated = annotate(stop);
      return Math.max(acc, effectiveEndMinutes(annotated) + requiredGapMinutes(annotated, candidate));
    }, candidate.startMin)
    : Math.max(candidate.startMin, SHIFT.startMinutes + driveMin(HQ, coordsOf(candidate)));
  return { annotate, candidateForAfterSide: { ...candidate, arrivalMin } };
}

function travelGapConflicts(candidate, stops) {
  if (!candidate || ![candidate.startMin, candidate.endMin].every(Number.isFinite)) return [];
  // Codex round 4 (Claude fallback audit on #5310): NOT `|| stops.length ===
  // 0` — an empty day still needs the day-end check below (a graced
  // candidate on a day with no other stops at all is exactly the shape
  // find-time's own HQ_END sentinel refuses at offer time; bailing out here
  // skipped it entirely at commit, breaking offer/commit parity for the
  // empty-day case). Every other classification/projection step below
  // already degrades to empty results on an empty `stops` array, so this
  // is grace-0 byte-identical (concat of two empty arrays either way).
  if (!Array.isArray(stops)) return [];
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
  // Day-end bound (Codex round 3 P1 on #5310): find-time.js's own HQ_END
  // sentinel already refuses to OFFER a graced candidate whose real arrival
  // cannot finish its own work and drive home before the customer day
  // closes — every real day's virtual route ends at HQ_END, so ANY
  // candidate that ends up the day's LAST real stop (including the day's
  // ONLY stop, on an otherwise empty day) is bound by it at offer time.
  // This module's commit-time predicate had no equivalent: it only ever
  // compared the candidate against OTHER real stops, so a candidate with no
  // real stop after it — including one with NO real stops on the date at
  // all — never hit any check here at all (Claude-fallback pre-push audit
  // P1: an empty `stops` array used to bail out of this whole function
  // before reaching here at all — fixed above). Mirrors the sentinel's
  // formula exactly, grounded only in what this module can see (real
  // stops): `arrivalFloor` is `candidateForAfterSide.arrivalMin`, always
  // finite whenever grace > 0 (round 6's own fix on projectGraceForCandidate
  // above — the SAME HQ-seed floor applies there when the candidate has no
  // real stop before it either, since it is then the day's first entity
  // too) — never a bare, optimistic `candidate.startMin`. `ownDuration` is
  // its FULL (uncredited) work — never the expected-minutes credit — and
  // `driveHome` is the same drive-to-HQ estimator find-time's own detour
  // scoring uses. Grace 0 is BYTE-IDENTICAL (never evaluated at all):
  // `candidateForAfterSide` is `candidate` unchanged then, and every
  // existing caller's own stored-window day-end check (slot-reservation.js
  // et al.) already covers that case — adding this unconditionally would be
  // a BRAND NEW rejection path this module has never had, not a mirror of one.
  const hasAfterSideNeighbour = after.length > 0
    || liveNeighbourHolds.some((hold) => hold.startMin > candidate.startMin);
  if (candidate.graceMinutes > 0 && !hasAfterSideNeighbour) {
    const arrivalFloor = candidateForAfterSide.arrivalMin;
    const ownDuration = candidate.endMin - candidate.startMin;
    const driveHome = driveMin(coordsOf(candidate), HQ);
    if (arrivalFloor + ownDuration + driveHome > currentDayEndMinutes()) {
      // No specific stop to blame — the candidate itself doesn't fit the
      // day. `stop: null` so a caller mapping conflicts back to real rows
      // (occupancy.js's findConflictingVisitsWithTravel) can tell this
      // apart from a real neighbour and synthesize its own entry instead
      // of dereferencing a row that doesn't exist.
      neighbours.push({ stop: null, reason: 'day_end' });
    }
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
