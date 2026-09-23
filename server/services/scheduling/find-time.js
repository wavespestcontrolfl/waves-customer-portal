/**
 * Find-a-Time Scoring Service
 * server/services/scheduling/find-time.js
 *
 * Given a new job (lat/lng + duration) and a date range, returns a ranked list
 * of feasible slots on each tech's day, scored by detour cost (extra drive
 * time added by inserting the new stop into an existing route).
 *
 * Drive-time estimates come from route-optimizer's shared model — the same one
 * auto-dispatch scores a visit's current placement with. Both sides MUST use
 * it: auto-dispatch compares a current placement against the candidates this
 * module produces, so a local copy of the constants here would put the two
 * sides on different scales. Capacity reads use one bounded traffic budget.
 */

const { NOT_A_ROUTE_STOP_STATUSES } = require('../stops-ahead');
const db = require('../../models/db');
const logger = require('../logger');
const { HQ, driveMin } = require('../auto-dispatch/geo');
const { etParts, etDateString } = require('../../utils/datetime-et');
const { stampedDivergesSql } = require('../stamped-address');
const { applyAssignable } = require('../technician-eligibility');
const { arrivalWindowRoutingEnabled, loadArrivalRouteContext, enumerateArrivalPlacements, evaluateArrivalPlacement } = require('./arrival-route');
const { SHIFT, capacityEnabled, placementFitsShift } = require('./policy');
const { serviceFamilyPreference } = require('../auto-dispatch/service-category');
const { travelGapEnabled, violatesTravelGap } = require('./travel-gap');
const { ensureCatalogLoaded, expectedMinutesSync } = require('./expected-service-minutes');
const { occupiedRows } = require('./visit-capacity');
const { stopCreditResolver } = require('./occupancy');
const { packedBounds } = require('./packing-geometry');
const { customerWindowAdmits } = require('./customer-windows');

// customerWindowAdmits (scheduling/customer-windows.js) is the ONE grid /
// day-end / lunch admission rule for customer-facing callers — the
// documented public/token offer grid (09:00-17:00), honoring a preserved
// booking_config.day_end override and the lunch gate. Only applied when a
// caller marks itself customerFacing (see findCapacitySlots and the legacy
// per-gap loop below); staff/optimizer callers (admin-schedule-find-time.js,
// intelligence-bar/schedule-tools.js, auto-dispatch/candidate-slots.js)
// never pass that flag and stay on the raw shift bounds (SHIFT,
// placementFitsShift / dayOpen-dayClose below), in both capacity modes
// (Codex r4 P0 on #4663 — the gate-off legacy path never enforced the grid
// at all).
//
// packedBounds/loadPackingAnchors (Codex r5 structural, packing-geometry.js)
// are a DIFFERENT axis: they supply the packed-start GEOMETRY (how close a
// candidate may sit next to a real neighbouring stop, credit-adjusted) —
// customerWindowAdmits is the ADMISSION rule (is this start on the
// customer grid, before day-end, outside lunch at all). A candidate must
// clear both: customerWindowAdmits gates whether a start is offered on the
// public grid; packedBounds/evaluateGap then tells it how early/late it may
// legally sit against that day's real stops. Neither substitutes for the
// other.

const DAY_START_HOUR = 8;   // 8:00 AM
const DAY_END_HOUR = 17;    // 5:00 PM
const DEFAULT_SERVICE_MIN = 60;

// driveMin is auto-dispatch/geo's — the one coordinate-glue over
// route-optimizer's model, so this module and auto-dispatch score on the
// same scale (a local copy lived here until the travel-gap lane).

function hasCoords(stop) {
  return stop != null && stop.lat != null && stop.lng != null;
}

function timeToMinutes(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function toDateStr(d) {
  if (typeof d === 'string') return d.split('T')[0];
  return d.toISOString().split('T')[0];
}

function enumerateDates(from, to, { includeWeekends = false } = {}) {
  const dates = [];
  const start = new Date(from + 'T12:00:00');
  const end = new Date(to + 'T12:00:00');
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    if (!includeWeekends && d.getDay() === 0) continue; // legacy default: skip Sundays
    dates.push(toDateStr(d));
  }
  return dates;
}

// Staff existing-appointment pickers can use the slack in each promised
// arrival window. Evaluate every on-the-hour promise against the COMPLETE
// resulting route, not just the gap between two stored service-end blocks.
async function findArrivalWindowSlots(opts) {
  const { dateFrom, dateTo, durationMinutes = 60, technicianId, topN = 10 } = opts;
  let query = applyAssignable(db('technicians'));
  if (technicianId) query = query.where('technicians.id', technicianId);
  const techs = await query.select('id', 'name');
  const { ADMIN_DAY_END_MINUTES } = require('./window-rules');
  const now = new Date();
  const today = etDateString(now);
  const parts = etParts(now);
  const slots = [];
  let evaluated = 0;
  for (const date of enumerateDates(dateFrom, dateTo, { includeWeekends: opts.includeWeekends })) {
    if (date < today) continue;
    for (const tech of techs) {
      // `changes` is the caller's pending edit (duration, a re-picked
      // service address) — the same shape the save probe hands the
      // checker, so the ranking simulates the visit being saved, not the
      // one stored.
      const context = await loadArrivalRouteContext({
        serviceId: opts.arrivalWindow.serviceId, date, technicianId: tech.id,
        excludeServiceIds: opts.excludeServiceIds, changes: opts.arrivalWindow.changes, now,
      });
      if (!context) continue;
      const floor = Math.max(DAY_START_HOUR * 60, date === today ? parts.hour * 60 + parts.minute + 30 : 0);
      const candidates = enumerateArrivalPlacements(context, { durationMinutes, earliestStartMin: floor, latestServiceEndMin: ADMIN_DAY_END_MINUTES });
      evaluated += candidates.evaluated;
      for (const { windowStart, windowEnd, fit } of candidates.placements) {
        const daysOut = Math.max(0, (new Date(`${date}T12:00:00Z`) - new Date(`${dateFrom}T12:00:00Z`)) / 86400000);
        slots.push({
          date, technician: { id: tech.id, name: tech.name },
          start_time: windowStart, end_time: windowEnd,
          detour_minutes: fit.detourMinutes, total_drive_minutes: fit.driveMinutes,
          score: fit.detourMinutes + daysOut * 0.5,
          waiting_minutes: fit.waitingMinutes, arrival_delay_minutes: fit.arrivalDelayMinutes,
          estimated_arrival: fit.estimatedArrival, route_arrivals: fit.arrivals,
          route_mode: 'arrival_windows', stops_that_day: fit.arrivals.length - 1,
          latest_start_min: timeToMinutes(windowStart),
        });
      }
    }
  }
  slots.sort((a, b) => a.score - b.score || a.waiting_minutes - b.waiting_minutes
    || a.arrival_delay_minutes - b.arrival_delay_minutes || a.start_time.localeCompare(b.start_time));
  return { slots: slots.slice(0, topN).map((slot, i) => ({ rank: i + 1, ...slot })), evaluated, total_feasible: slots.length };
}

async function findCapacitySlots(opts) {
  const { dateFrom, dateTo, durationMinutes = 30, technicianId, topN = 10 } = opts;
  let query = applyAssignable(db('technicians'));
  if (technicianId) query = query.where('technicians.id', technicianId);
  const techs = await query.select('id', 'name');
  const { getBlackoutLayers } = require('./blackout-dates');
  let requestedServices = (opts.serviceTypes || [opts.serviceType || opts.serviceKey || ''])
    .filter(Boolean).map(service_type => ({ service_type }));
  if (!requestedServices.length && opts.excludeServiceIds?.length) {
    requestedServices = await db('scheduled_services').whereIn('id', opts.excludeServiceIds).select('service_type');
  }
  const inactive = opts.arrivalWindow?.serviceId ? []
    : await require('../technician-capabilities').inactiveCapabilitiesForServices(db, techs.map(tech => tech.id), requestedServices);
  const inactiveTechs = new Set(inactive.map(row => row.technician_id));
  const blackout = opts.includeBlackoutDates ? new Set() : (await getBlackoutLayers(dateFrom, dateTo)).dates;
  const now = new Date();
  const today = etDateString(now);
  const parts = etParts(now);
  const travel = require('../route-optimizer').createSchedulingTravel();
  // Loaded before the candidate loop, not just before packCapacityEnds
  // (Codex r8 P1 follow-on): capacityGapNeighbours below now resolves each
  // neighbour's credited expected-minutes per candidate via
  // stopCreditResolver, so the catalog must already be warm the first time
  // that runs, not only by the time packCapacityEnds is reached — a cold
  // cache there would silently degrade every neighbour to window-length
  // (no credit) for the whole loop, not just the first candidate.
  if (opts.packEnds === true) await ensureCatalogLoaded(db);
  const candidates = [];
  for (const date of enumerateDates(dateFrom, dateTo, { includeWeekends: opts.includeWeekends })) {
    if (date < today || blackout.has(date)) continue;
    for (const tech of techs) {
      if (inactiveTechs.has(tech.id)) continue;
      const context = await loadArrivalRouteContext({ date, technicianId: tech.id, now, travel,
        excludeServiceIds: opts.excludeServiceIds,
        // The requesting estimate's OWN uncommitted hold must not occupy the
        // route it is asking about (codex r16 P1) — the legacy/SSR page no
        // longer adopts that hold, so a tight route could otherwise omit the
        // customer's still-valid held window and leave nothing confirmable.
        // loadArrivalRouteContext has always taken this option; capacity
        // generation simply never passed it.
        excludeEstimateId: opts.excludeEstimateId,
        ...(opts.arrivalWindow?.serviceId ? {
          serviceId: opts.arrivalWindow.serviceId, changes: opts.arrivalWindow.changes,
        } : { prospective: { lat: opts.lat, lng: opts.lng, estimated_duration_minutes: durationMinutes,
          service_type: opts.serviceType || opts.serviceKey || requestedServices.map(row => row.service_type).join(' ') } }),
      });
      if (!context) continue;
      if (opts.arrivalWindow?.serviceId && (await require('../technician-capabilities')
        .inactiveCapabilitiesForServices(db, [tech.id], [context.target])).length) continue;
      const floor = Math.max(SHIFT.startMinutes, opts.earliestStartMin || 0,
        date === today ? parts.hour * 60 + parts.minute + 30 : 0);
      // Enumerate every on-the-hour start through the shift close and let
      // placementFitsShift (scheduling/policy.js) decide admission from the
      // real (start, start+durationMinutes) window — the loop used to stop
      // 2 hours early (SHIFT.arrivalMinutes), which silently dropped 17:00
      // candidates that fit a normal 60-minute job comfortably before the
      // 18:00 close (Codex r1 P1 on #4663). SHIFT.startMinutes is 08:00 — the
      // full operating shift, not the documented public/token offer grid
      // (09:00-17:00). A customerFacing caller (the estimate picker, /book
      // and everything that shares its builder) additionally runs
      // customerWindowAdmits — the grid floor AND the resolved
      // (booking_config-aware) close AND the lunch gate in one check — so
      // capacity mode never hands a customer surface an 08:00 candidate, a
      // start past a preserved earlier close, or a lunch-overlapping start
      // the public route contract doesn't describe; staff/optimizer callers
      // that never pass customerFacing are unaffected and stay on the raw
      // shift bound below (Codex r3 P0, r4 P2 on #4663).
      for (let start = Math.ceil(floor / 60) * 60; start < SHIFT.endMinutes; start += 60) {
        if (opts.customerFacing && !customerWindowAdmits({ startMin: start, endMin: start + durationMinutes })) continue;
        if (!placementFitsShift(start, start + durationMinutes)) continue;
        candidates.push({ context, date, tech, start, options: {
          windowStart: minutesToTime(start), windowEnd: minutesToTime(start + durationMinutes),
          // Owner policy: ordinary setup/closeout is already in the on-site allowance.
          durationMinutes, bufferMinutes: 0, allowInsertion: opts.capacityPlacement === true,
        } });
      }
    }
  }
  // Pairwise matrix estimates generate candidates; repeated simulation asks
  // for affected legs at their predicted departures. All Google work shares
  // one bounded, request-local budget across the complete calendar horizon.
  for (let pass = 0; pass < 3; pass++) {
    const legs = [];
    for (const candidate of candidates) evaluateArrivalPlacement(candidate.context, { ...candidate.options, collectLegs: legs });
    await travel.preload(legs);
  }
  const slots = [];
  for (const candidate of candidates) {
    const { context, date, tech, start, options } = candidate;
    const fit = evaluateArrivalPlacement(context, options);
    if (!fit.feasible) continue;
    // Existing save probes have no traffic preload; their fallback must fit too.
    if (!opts.capacityPlacement && !evaluateArrivalPlacement({ ...context, travel: null }, options).feasible) continue;
    const index = fit.routeOrder.indexOf(context.target.id);
    const byId = new Map(context.rows.map(row => [row.id, row]));
    const familyScore = serviceFamilyPreference(context.rows.filter(row => row.technician_id === tech.id),
      context.target.service_type, { before: byId.get(fit.routeOrder[index - 1]), after: byId.get(fit.routeOrder[index + 1]) });
    const daysOut = Math.max(0, (new Date(`${date}T12:00:00Z`) - new Date(`${dateFrom}T12:00:00Z`)) / 86400000);
    slots.push({ date, technician: { id: tech.id, name: tech.name }, start_time: options.windowStart,
      end_time: options.windowEnd, detour_minutes: fit.detourMinutes, total_drive_minutes: fit.driveMinutes,
      score: fit.detourMinutes + daysOut * 0.5 - familyScore, service_family_score: familyScore,
      occupied_minutes: fit.occupiedMinutes, waiting_minutes: fit.waitingMinutes,
      estimated_arrival: fit.estimatedArrival, route_arrivals: fit.arrivals,
      route_mode: 'arrival_windows', travel_source: fit.travelSource, travel_reasons: fit.travelReasons,
      stops_that_day: fit.arrivals.length - 1, latest_start_min: start,
      // Route neighbours of this placement (packed-ends filter below) — BY
      // TIME, including unassigned fixed blockers (Codex r3 P1; see
      // capacityGapNeighbours).
      _gap: capacityGapNeighbours(context, fit, start),
    });
  }
  const packed = opts.packEnds === true ? packCapacityEnds(slots, {
    lat: opts.lat, lng: opts.lng, durationMinutes, expectedMinutes: opts.expectedMinutes,
  }) : slots;
  for (const slot of packed) delete slot._gap;
  packed.sort((a, b) => a.score - b.score || a.waiting_minutes - b.waiting_minutes || a.start_time.localeCompare(b.start_time));
  return { slots: packed.slice(0, topN).map((slot, i) => ({ rank: i + 1, ...slot })),
    evaluated: candidates.length, total_feasible: packed.length, travel: travel.diagnostics() };
}

// Route neighbours of a capacity placement, BY TIME rather than
// fit.routeOrder alone (Codex r3 P1): routeOrder only ever lists the
// SELECTED technician's own stops (completed + pending + the candidate) —
// an unassigned committed visit is a fixed blocker on every technician's
// route (see fixedRows in arrival-route.js) but never appears in
// routeOrder, so a day whose only stop was unassigned collapsed to an
// empty-day gap identity (prevId/nextId both null) and packCapacityEnds
// below kept every hour around the blocker instead of packing against it.
// Merges routeOrder's own stops with the day's unassigned rows (both from
// context.rows), sorted by (allocation-expanded) start, and picks this
// candidate's real time neighbours from that merged list.
//
// Version-2 combined allocations, expanded through visit-capacity.js's
// occupiedRows to their real summed span, with each row's credited
// expected-minutes attached via occupancy.js's stopCreditResolver (summed
// per allocation, not each member's own raw-window credit) — the SAME
// expansion + resolver buildDayStops was wired to in Codex r7 P1, so
// capacity and legacy paths share one neighbour representation (Codex r8
// P1). Before this, a v2 member here was anchored and reshaped from its OWN
// raw window: two credited 09:00-10:00 members occupying (expanded)
// 09:00-11:00 anchored at 10:00, so packCapacityEnds kept a 10:00 packed
// end and dropped the real 11:00 one, then buildBookingAvailability's own
// (already-expanded) commit-side mirror rejected the kept 10:00 as still
// occupied — no offer at all, though 11:00 was genuinely valid.
function capacityGapNeighbours(context, fit, startMin) {
  const creditResolver = stopCreditResolver(context.rows);
  const expanded = occupiedRows(context.rows).map((row) => ({
    ...row, expectedMinutes: creditResolver(row, row.endMin - row.startMin),
  }));
  const expandedById = new Map(expanded.map((row) => [row.id, row]));
  const anchors = [
    ...fit.routeOrder
      .filter((id) => id !== context.target.id)
      .map((id) => ({ id, startMin: expandedById.get(id)?.startMin })),
    ...expanded
      .filter((row) => row.technician_id == null && row.status !== 'completed')
      .map((row) => ({ id: row.id, startMin: row.startMin })),
  ].filter((a) => Number.isFinite(a.startMin)).sort((a, b) => a.startMin - b.startMin);
  let prevId = null;
  let nextId = null;
  for (const anchor of anchors) {
    if (anchor.startMin <= startMin) prevId = anchor.id;
    else { nextId = anchor.id; break; }
  }
  // Row references too (Codex r7 P1) — packCapacityEnds needs each
  // neighbour's own coords/window/service identity to run the customer-
  // facing travel-gap predicate before picking a group's packed endpoint.
  // Resolved from the SAME expanded map as the anchors above (Codex r8 P1)
  // — never the raw context.rows member.
  return {
    prevId, nextId,
    prevRow: prevId != null ? expandedById.get(prevId) : null,
    nextRow: nextId != null ? expandedById.get(nextId) : null,
  };
}

// A capacityGapNeighbours neighbour (occupiedRows' allocation-expanded
// startMin/endMin, plus stopCreditResolver's summed expectedMinutes — Codex
// r8 P1) reshaped into the {startMin, endMin, lat, lng, windowMinutes,
// expectedMinutes} entity travel-gap.js's violatesTravelGap reads. Mirrors
// buildDayStops' Codex r7 P1 fix so capacity and legacy paths share one
// neighbour representation; expectedMinutes falls back to the full window
// (no credit) only for a malformed row missing the resolver's attached
// value, which production never produces.
function capacityNeighbourEntity(row) {
  if (!row || !Number.isFinite(row.startMin) || !Number.isFinite(row.endMin)) return null;
  const windowMinutes = Math.max(0, row.endMin - row.startMin);
  return {
    startMin: row.startMin, endMin: row.endMin,
    lat: row.lat ?? null, lng: row.lng ?? null, windowMinutes,
    expectedMinutes: Number.isFinite(row.expectedMinutes) ? row.expectedMinutes : windowMinutes,
  };
}

// Packed-ends for capacity results (Codex r2 P1): findCapacitySlots
// enumerates EVERY feasible whole-hour start against the complete route, so
// a customer-facing caller would still see the hole-making mid-gap hours.
// Group feasible placements by (date, tech, previous stop, next stop) and
// keep only the earliest start when the gap follows a real stop and the
// latest when it precedes one; a gap bordered by no stop (empty day) keeps
// every hour, exactly as the non-capacity packEnds rule does.
//
// `caller` ({ lat, lng, durationMinutes, expectedMinutes }, Codex r7 P1):
// the customer-facing travel-gap predicate (violatesTravelGap, the SAME one
// booking.js's own commit-gate mirror applies) is now run against each
// group's candidates BEFORE picking the packed endpoint, not after. Arrival-
// window route feasibility (evaluateArrivalPlacement) models real drive but
// not this buffer/credit rule, so it could accept a start (say 10:00, right
// after a 09:00-10:00 stop) the customer-facing gate would reject — picking
// that as "the" packed end first, with no fallback, made the whole gap look
// unavailable even when a later start (11:00+) the OLD grid-scan would have
// tried was genuinely fine. Filtering first means the packed pick is always
// one the commit gate would also accept; a group with no survivors on a
// side offers nothing from that side, same as every other packed-ends rule
// in this codebase — never a synthesized fallback.
function packCapacityEnds(slots, caller = {}) {
  const groups = new Map();
  for (const slot of slots) {
    const key = `${slot.date}|${slot.technician.id}|${slot._gap?.prevId ?? ''}|${slot._gap?.nextId ?? ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(slot);
  }
  const clearsTravelGap = (slot, row) => {
    if (!travelGapEnabled()) return true;
    const neighbour = capacityNeighbourEntity(row);
    if (!neighbour) return true;
    const startMin = timeToMinutes(slot.start_time);
    const endMin = timeToMinutes(slot.end_time);
    if (!Number.isFinite(startMin) || !Number.isFinite(endMin)) return true;
    const ownWindow = Number.isFinite(caller.durationMinutes) ? caller.durationMinutes : (endMin - startMin);
    const candidate = {
      startMin, endMin, lat: caller.lat ?? null, lng: caller.lng ?? null, windowMinutes: ownWindow,
      expectedMinutes: Number.isFinite(caller.expectedMinutes) ? Math.min(caller.expectedMinutes, ownWindow) : ownWindow,
    };
    return !violatesTravelGap(candidate, [neighbour]);
  };
  const keep = new Set();
  for (const group of groups.values()) {
    const prevReal = group[0]._gap?.prevId != null;
    const nextReal = group[0]._gap?.nextId != null;
    if (!prevReal && !nextReal) { for (const s of group) keep.add(s); continue; }
    const byStart = group.slice().sort((a, b) => a.start_time.localeCompare(b.start_time));
    if (prevReal) {
      const survivors = byStart.filter((s) => clearsTravelGap(s, group[0]._gap.prevRow));
      if (survivors.length) keep.add(survivors[0]);
    }
    if (nextReal) {
      const survivors = byStart.filter((s) => clearsTravelGap(s, group[0]._gap.nextRow));
      if (survivors.length) keep.add(survivors[survivors.length - 1]);
    }
  }
  return slots.filter((s) => keep.has(s));
}

// The candidate's own expected-minutes credit (owner ruling 2026-09-23),
// resolved ONCE per findAvailableSlots call — extracted from the main
// function to keep its own branching down (Codex r4 P2 complexity finding).
// wantsExpectedMinutesCredit false (staff/optimizer callers, or the gate
// off for everyone else) skips the catalog read entirely and returns the
// legacy zero-padding shape.
async function resolveCandidateExpectedMinutes({
  wantsExpectedMinutesCredit, durationMinutes, expectedMinutes, serviceKey, serviceType,
}) {
  if (!wantsExpectedMinutesCredit) return { candidateExpectedMinutes: durationMinutes, candidatePadding: 0 };
  await ensureCatalogLoaded(db);
  const candidateExpectedMinutes = Number.isFinite(expectedMinutes) && expectedMinutes > 0
    ? Math.min(expectedMinutes, durationMinutes)
    : expectedMinutesSync({ serviceKey, serviceType, windowMinutes: durationMinutes });
  return { candidateExpectedMinutes, candidatePadding: Math.max(0, durationMinutes - candidateExpectedMinutes) };
}

// One tech's route stops for one day: filtered to this tech (packed-ends
// callers also anchor on unassigned committed visits — Codex r2 P1), run
// through visit-capacity.js's occupiedRows (the SAME version-2 combined-
// allocation expansion occupancy.js's shared anchor loader uses — a raw
// member row's own window_end understates its real, promised span, so
// without this a two-member allocation stamped 09:00-10:00 each looked
// done at 10:00 while occupancy/commit expand it through the summed 11:00,
// offering an 11:00 packed slot the commit gate then rejected as occupied
// — Codex r5 P1), mapped to the {startMin, endMin, expectedMinutes?} shape
// the gap geometry below reads, sorted by start. Extracted so
// findAvailableSlots' own branching stays in the loop that drives it, not
// the row-shaping itself.
function buildDayStops(services, {
  tech, date, excludeSet, wantsPackedEnds, wantsExpectedMinutesCredit,
}) {
  const filtered = services.filter((s) => {
    if (excludeSet.has(String(s.id))) return false;
    if (toDateStr(s.scheduled_date) !== date) return false;
    // Packed-ends callers (customer-facing): an UNASSIGNED committed
    // visit is a real stop someone will serve that day — it anchors the
    // packing on every tech's route rather than reading as an open day
    // that fans out every grid hour (Codex r2 P1). Legacy callers keep
    // the per-tech route byte-identical.
    return s.technician_id === tech.id || (wantsPackedEnds && s.technician_id == null);
  });
  // One resolver per this tech/date's row set (occupancy.js's
  // stopCreditResolver, shared with the commit-side travel probe and
  // listOccupiedWindows) — NOT a plain per-row expectedMinutesSync call
  // (Codex r7 P1): a version-2 combined allocation's members each carry
  // only their OWN catalog credit, but occupiedRows below expands every
  // member to the allocation's SUMMED span, so crediting one member's own
  // minutes against that summed window understated it (two 60-min members
  // 09:00-11:00 read as done at 09:45 instead of the aggregate 10:30) —
  // exactly the offer/commit mismatch stopCreditResolver's own header
  // describes for the identical bug on the commit side. Built from
  // `filtered` (raw, pre-expansion rows) so its internal allocation sums
  // are computed from each member's own raw span, same as the resolver's
  // own commit-side callers.
  const creditResolver = wantsExpectedMinutesCredit ? stopCreditResolver(filtered) : null;
  return occupiedRows(filtered)
    .map((s) => {
      // s.startMin/s.endMin are occupiedRows' own (allocation-expanded for
      // a version-2 combined member, else identical to the plain
      // window_start/window_end-or-duration fallback this file always used).
      const { startMin, endMin } = s;
      return {
        id: s.id,
        lat: s.svc_lat || s.cust_lat,
        lng: s.svc_lng || s.cust_lng,
        startMin,
        endMin,
        customer: `${s.first_name || ''} ${s.last_name || ''}`.trim() || 'Unknown',
        city: s.city,
        service_type: s.service_type,
        // Expected-minutes padding credit (owner ruling 2026-09-23) — only
        // resolved for a customer-facing caller; a plain endMin-startMin
        // window with no catalog match degrades to the legacy endMin/zero
        // padding (see packedBounds).
        ...(creditResolver ? {
          expectedMinutes: creditResolver(s, endMin - startMin),
        } : {}),
      };
    })
    .sort((a, b) => a.startMin - b.startMin);
}

// Adapts a dayStops row ({startMin, endMin, expectedMinutes?}) to the
// {rawStartMin, rawEndMin, expectedEndMin} shape scheduling/packing-
// geometry.js's packedBounds reads — the same credited-effective-end math
// travel-gap.js's effectiveEndMinutes/paddingMinutesOf compute internally.
// HQ anchors are never passed through this (see evaluateGap): a zero-width
// "stop" would otherwise read as having zero window padding and wrongly
// pick up a full buffer credit HQ legs must never carry.
function toPackingBoundAnchor(stop) {
  const windowMinutes = stop.endMin - stop.startMin;
  const expected = Number.isFinite(stop.expectedMinutes) ? Math.min(stop.expectedMinutes, windowMinutes) : windowMinutes;
  return { rawStartMin: stop.startMin, rawEndMin: stop.endMin, expectedEndMin: stop.startMin + expected };
}

// The geometry of ONE route gap (between consecutive anchors prev/next):
// how much drive the detour adds, how early/late a candidate can start in
// it, and a maker for the candidate object at a given start. Pulled out of
// findAvailableSlots' loop (Codex r4 P2 complexity finding) — this is the
// single most decision-heavy piece of the scoring, and it has no reason to
// share a function scope with the day/tech enumeration around it.
// `geo` carries the invariants resolved once per findAvailableSlots call:
// { newStop, dateFrom, stopBuffer, candidateExpectedMinutes, durationMinutes,
//   dayOpen, earliestStartMin, todayEt, todayFloorMin }.
function evaluateGap(prev, next, { date, tech, dayStops, geo }) {
  const {
    newStop, dateFrom, stopBuffer, candidateExpectedMinutes,
    durationMinutes, dayOpen, earliestStartMin, todayEt, todayFloorMin,
  } = geo;
  const baselineDrive = driveMin(prev, next);
  const driveIn = driveMin(prev, newStop);
  const driveOut = driveMin(newStop, next);
  const detourDrive = driveIn + driveOut;
  const extraDrive = Math.max(0, detourDrive - baselineDrive);

  const prevIsStop = prev.id !== 'HQ_START';
  const nextIsStop = next.id !== 'HQ_END';

  // Neighbour-buffer geometry (owner ruling 2026-09-23), via the shared
  // packing-geometry.js formula every customer-facing picker now shares
  // (Codex r5 structural fix — this file, availability.js and booking.js
  // each carried a slightly different, independently-buggy copy). HQ legs
  // never get a buffer, padding credit, or the raw-overlap clamp — they are
  // not real stops, so packedBounds sees `null` on that side and this file
  // falls back to the plain drive-only shape, exactly as before.
  const { earliestStart: earliestFromPrevStop, latestStart: latestFromNextStop } = packedBounds({
    prev: prevIsStop ? toPackingBoundAnchor(prev) : null,
    next: nextIsStop ? toPackingBoundAnchor(next) : null,
    durationMinutes, expectedMinutes: candidateExpectedMinutes,
    driveIn, driveOut, buffer: stopBuffer,
  });

  // Earliest the new job could start: after the previous anchor's
  // (effective) end + drive from prev → new — floored at "now + lead" when
  // the date is today. Against a REAL prev stop, packedBounds' earliestStart
  // already floors at prev's own RAW end (Codex r5 P1: credit can move the
  // effective end earlier, but the candidate can never start before prev's
  // PROMISED window truly closes, however much credit prev carries).
  const earliestFloor = Math.max(
    dayOpen,
    prevIsStop ? earliestFromPrevStop : (prev.endMin + driveIn),
    date === todayEt ? todayFloorMin : 0,
    earliestStartMin, // honor a hard time-window lower bound (0 = no-op)
  );
  // Must allow drive from new → next before next.startMin (its real,
  // never-adjusted window start — a promise to whoever holds it). Against a
  // REAL next stop the candidate is the early side of the pair, so —
  // exactly as travel-gap.js requiredGapMinutes/effectiveEndMinutes measure
  // it at commit — the drive starts at the candidate's EXPECTED end (start
  // + its expected minutes), not its full window end; measuring from the
  // window end here rejected starts the commit probe accepts whenever
  // drive > 0 (push-audit P1). The HQ leg keeps the full window (no
  // credit, as before). packedBounds' latestStart is ALSO capped at
  // next.startMin - durationMinutes (Codex r4 P1): the candidate's REAL
  // (full-duration) window must never overlap next's real window, credited
  // or not — travel-gap.js's own real-overlap check is unconditional
  // regardless of credit, so an uncapped bound was rejected downstream with
  // no fallback and the whole gap's "before next" side silently vanished.
  const latestStartFloor = nextIsStop
    ? latestFromNextStop
    : next.startMin - driveOut - durationMinutes;

  // A coordless anchor (ungeocoded stop, or a divergent stamped rental
  // whose primary-coord fallback the SELECT suppressed) degrades to zero
  // drive time via driveMin() rather than hiding the gaps on either side of
  // it — skipping here starved otherwise-valid slots around every
  // coordless stop (codex round-9 P2).

  // Day delay penalty — prefer sooner days (0.5 min/day)
  const daysOut = Math.max(0, (new Date(date + 'T12:00:00') - new Date(dateFrom + 'T12:00:00')) / (1000 * 60 * 60 * 24));
  const score = extraDrive + daysOut * 0.5;

  const makeCandidate = (candidateStartMin) => {
    const candidateEndMin = candidateStartMin + durationMinutes;
    return {
      date,
      technician: { id: tech.id, name: tech.name },
      start_time: minutesToTime(candidateStartMin),
      end_time: minutesToTime(candidateEndMin),
      detour_minutes: extraDrive,
      baseline_drive_minutes: baselineDrive,
      total_drive_minutes: detourDrive,
      // The two legs the detour is made of, so a picker can say what the
      // van actually drives INTO this stop (from the previous anchor)
      // separately from what the insertion adds to the route. A coordless
      // anchor scores as zero drive above (so its gaps stay offered), but
      // that zero is a sentinel, not a trip — report the leg as unknown
      // (null) so a hint omits it rather than claiming "0 min drive"
      // (Codex #4120 r2 P2).
      drive_in_minutes: hasCoords(prev) ? driveIn : null,
      drive_out_minutes: hasCoords(next) ? driveOut : null,
      score,
      // Last start this gap can hold (its end still clears the drive to
      // the next anchor). Availability surfaces that only offer clean
      // grid-aligned times use this to fan out EVERY aligned start the gap
      // fits — offering only the earliest-feasible minute meant an
      // hour-snap into the lunch block or an occupied hour hid the gap's
      // genuinely free later hours, and whole days with real capacity
      // disappeared from the self-serve booking surfaces (2026-08-05
      // field report).
      latest_start_min: latestStartFloor,
      insertion: {
        after: prev.id === 'HQ_START' ? 'HQ (start of day)' : `${prev.customer} (${minutesToTime(prev.endMin)})`,
        before: next.id === 'HQ_END' ? 'HQ (end of day)' : `${next.customer} (${minutesToTime(next.startMin)})`,
        // Bare name for labels ("from <previous stop>"); null = the home base.
        after_name: prev.id === 'HQ_START' ? null : prev.customer,
        after_stop_id: prev.id === 'HQ_START' || prev.id === 'HQ_END' ? null : prev.id,
        before_stop_id: next.id === 'HQ_START' || next.id === 'HQ_END' ? null : next.id,
      },
      stops_that_day: dayStops.length,
    };
  };

  return {
    prevIsStop, nextIsStop, earliestFloor, latestStartFloor, makeCandidate,
  };
}

// Packed-ends candidate starts for ONE gap (owner bug report 2026-09-23):
// both ends of a real gap, snapped to the customer hour grid (ceil for
// earliest, floor for latest), restricted to whichever end(s) border a
// real stop. Legacy dedupe-by-slotId downstream (estimate-slot-
// availability's dedupeSlots) tolerates duplicates across gaps; within one
// gap, coincident ends collapse to a single start via the Set.
function packedEndsStarts({ prevIsStop, nextIsStop, earliestFloor, latestStartFloor }, durationMinutes, dayClose) {
  const fits = (startMin) => Number.isFinite(startMin)
    && startMin >= earliestFloor
    && startMin <= latestStartFloor
    && startMin + durationMinutes <= dayClose;
  const earliestHourStart = Math.ceil(earliestFloor / 60) * 60;
  const latestHourStart = Math.floor(latestStartFloor / 60) * 60;
  const starts = new Set();
  if (prevIsStop && fits(earliestHourStart)) starts.add(earliestHourStart); // packed after prev
  if (nextIsStop && fits(latestHourStart)) starts.add(latestHourStart);     // packed before next
  return starts;
}

// Every candidate for ONE (date, tech) pair: builds that day's virtual
// route (HQ ... stops ... HQ), evaluates each gap's geometry, and collects
// its packed-ends or single-candidate output. Extracted from
// findAvailableSlots' own control flow (Codex r4 P2 complexity finding) —
// this is the deepest, most decision-heavy layer of the per-day/per-tech
// double loop, and has no reason to share a function scope with the
// date/tech enumeration around it.
// `params`: { services, geo, excludeSet, wantsPackedEnds,
//   wantsExpectedMinutesCredit, slotStepMinutes, durationMinutes, dayOpen, dayClose }.
function candidatesForDay(date, tech, params) {
  const {
    services, geo, excludeSet, wantsPackedEnds, wantsExpectedMinutesCredit,
    slotStepMinutes, durationMinutes, dayOpen, dayClose,
  } = params;
  const dayStops = buildDayStops(services, {
    tech, date, excludeSet, wantsPackedEnds, wantsExpectedMinutesCredit,
  });
  // Build virtual stop list: HQ ... stops ... HQ
  // "Stops" include timing. For gaps we evaluate between consecutive anchors.
  const anchors = [
    { id: 'HQ_START', lat: HQ.lat, lng: HQ.lng, startMin: dayOpen, endMin: dayOpen, customer: 'HQ (start)' },
    ...dayStops,
    { id: 'HQ_END', lat: HQ.lat, lng: HQ.lng, startMin: dayClose, endMin: dayClose, customer: 'HQ (end)' },
  ];
  const found = [];
  let evaluatedGaps = 0;
  // Evaluate each gap between anchor[i] and anchor[i+1]
  for (let i = 0; i < anchors.length - 1; i++) {
    evaluatedGaps++;
    const gap = evaluateGap(anchors[i], anchors[i + 1], { date, tech, dayStops, geo });

    if (wantsPackedEnds && dayStops.length > 0) {
      for (const startMin of packedEndsStarts(gap, durationMinutes, dayClose)) {
        found.push(gap.makeCandidate(startMin));
      }
      continue;
    }

    // Legacy single-candidate path: earliest-feasible minute only, snapped
    // to slotStepMinutes (default 1 = exact minute).
    const startMin = slotStepMinutes > 1
      ? Math.ceil(gap.earliestFloor / slotStepMinutes) * slotStepMinutes
      : gap.earliestFloor;
    if (startMin > gap.latestStartFloor) continue; // doesn't fit
    if (startMin + durationMinutes > dayClose) continue; // past end of day
    found.push(gap.makeCandidate(startMin));
  }
  return { candidates: found, evaluatedGaps };
}

// Normalizes findAvailableSlots' raw opts: applies every default, and
// derives the flags/sets the rest of the function reads (stopBuffer,
// wantsPackedEnds, wantsExpectedMinutesCredit, excludeSet). Pure and
// synchronous — no DB access — and kept separate from findAvailableSlots'
// own control flow (Codex r4 P2 complexity finding): this destructuring
// alone, with its dozen defaults, was close to a third of that function's
// reported complexity.
//
// @param {Object} opts
// @param {number} opts.lat                  Target job latitude
// @param {number} opts.lng                  Target job longitude
// @param {number} [opts.durationMinutes=60] How long the new job takes
// @param {string} opts.dateFrom             YYYY-MM-DD
// @param {string} opts.dateTo               YYYY-MM-DD
// @param {string} [opts.technicianId]       Restrict to one tech
// @param {number} [opts.topN=10]            How many slots to return
// @param {number} [opts.dayStartHour=8]
// @param {number} [opts.dayEndHour=17]
// @param {boolean} [opts.includeWeekends=false] Include Sundays in addition to Saturdays
// @param {string[]} [opts.excludeServiceIds] Service ids to drop from the occupied-route
//   set — used when relocating an existing visit so its own current row isn't counted as
//   a stop blocking the slot it's being moved out of. Default [] = identical legacy behavior.
// @param {number} [opts.slotStepMinutes=1] Snap proposed start times up to this minute
//   granularity (e.g. 60 = on the hour). Default 1 = exact earliest-feasible minute.
// @param {number} [opts.earliestStartMin=0] Lower bound (minutes from midnight) on a
//   proposed start time. Used to honor a HARD customer time-window preference: each route
//   gap emits only its earliest-feasible start, so without this an empty/early gap
//   collapses to e.g. 08:00 and a valid later preferred start (e.g. 13:00 for an afternoon
//   preference) is never generated. Floors earliestStart so the gap yields a candidate
//   at/after the window start instead. Default 0 = no effect (identical legacy behavior).
// @param {number} [opts.bufferMinutes=0] Turnaround minutes between the new stop and a
//   NEIGHBOURING STOP (never an HQ leg) on top of the modeled drive. Customer-facing
//   callers pass travel-gap.js customerFacingBufferMinutes() (GATE_SLOT_TRAVEL_GAP);
//   default 0 = legacy geometry for staff and optimizer callers. When this is > 0 the
//   neighbour-buffer geometry also picks up the shared expected-minutes padding reduction
//   (scheduling/travel-gap.js, expected-service-minutes.js, owner ruling 2026-09-23) so
//   offers agree with the same rule the commit gates enforce — with no expected-minutes
//   signal, padding is 0 and the math is identical to before that ruling.
// @param {boolean} [opts.packEnds=false] Packed-ends mode (customer-facing lanes ONLY —
//   estimate slots, /book, reschedule, re-service; staff/optimizer callers never pass
//   this): per route gap with an existing stop on either side, emit BOTH the earliest
//   feasible start (packed after prev) and the latest feasible start (packed before
//   next), each snapped to the hour, instead of one earliest-only candidate. The leading
//   gap (day-open to the first stop) emits ONLY the latest (packed against the first
//   stop); the trailing gap (last stop to day-close) emits ONLY the earliest (packed
//   against the last stop); a middle gap emits both, or one when they coincide. An empty
//   day (no stops at all) is unaffected — the single HQ-to-HQ gap keeps today's
//   one-candidate-at-the-exact-minute behavior. Default false = byte-identical
//   single-candidate-per-gap output.
// @param {string} [opts.serviceKey] The NEW job's own catalog identity, for its
//   expected-minutes padding credit when it is the EARLY side of a gap (packed before an
//   upcoming stop). Optional; no match (or no serviceKey/serviceType given) falls back to
//   the window length — zero padding, legacy gap.
// @param {number} [opts.expectedMinutes] A caller-resolved whole-visit expected minutes
//   (estimate picker: the sum across every service in the profile) — wins over the
//   single serviceKey lookup so a combined visit's other members are never credited
//   toward travel (push-audit P1).
function normalizeFindTimeOptions(opts) {
  const {
    lat, lng,
    durationMinutes = DEFAULT_SERVICE_MIN,
    dateFrom, dateTo,
    technicianId,
    topN = 10,
    dayStartHour = DAY_START_HOUR,
    dayEndHour = DAY_END_HOUR,
    includeWeekends = false,
    excludeServiceIds = [],
    slotStepMinutes = 1,
    earliestStartMin = 0,
    bufferMinutes = 0,
    packEnds = false,
    serviceKey = null,
    expectedMinutes = null,
  } = opts;
  const stopBuffer = Math.max(0, Number(bufferMinutes) || 0);
  const wantsPackedEnds = packEnds === true;
  // Expected-minutes credit is keyed to stopBuffer > 0 below for the common
  // case, but SLOT_TRAVEL_BUFFER_MINUTES=0 is a supported, deliberate owner
  // override (travel-gap.js travelBufferMinutes()) — a customer-facing
  // caller (packEnds, per this module's own contract, is customer-facing
  // lanes ONLY) with the gate on but a configured zero buffer would
  // otherwise behave exactly like gate-off here, while the commit probes
  // (travel-gap.js effectiveEndMinutes/paddingMinutesOf) still measure from
  // the expected end regardless of the buffer value — an offer/commit
  // mismatch (Codex r4 P2). ADDITIVE, never subtractive: every existing
  // stopBuffer > 0 caller is unaffected; this only adds the zero-buffer
  // customer-facing case. Staff/optimizer callers (never packEnds, never a
  // customer-facing buffer) stay byte-identical either way.
  const wantsExpectedMinutesCredit = stopBuffer > 0 || (wantsPackedEnds && travelGapEnabled());
  const excludeSet = new Set((excludeServiceIds || []).map(String));
  return {
    lat, lng, durationMinutes, dateFrom, dateTo, technicianId, topN,
    dayStartHour, dayEndHour, includeWeekends, slotStepMinutes,
    earliestStartMin, packEnds, serviceKey, expectedMinutes,
    stopBuffer, wantsPackedEnds, wantsExpectedMinutesCredit, excludeSet,
  };
}

// Loads this request's technician/service/date context: assignable
// technicians (optionally narrowed to one), every route-relevant
// scheduled_services row in range, and the requested date range with
// blackout days removed. Extracted from findAvailableSlots' own control
// flow (Codex r4 P2 complexity finding) — a cohesive "resolve who/what/
// when" step, independent of the per-gap scoring that consumes it. An
// empty techs array short-circuits (no services/dates query) — the caller
// still owns the "no assignable technicians" early return, since that
// shape is a findAvailableSlots response contract, not a loading concern.
async function loadFindTimeContext({ dateFrom, dateTo, technicianId, includeWeekends, includeBlackoutDates }) {
  // Only assignable techs (active employment AND field-dispatchable). Every
  // slot consumer (booking, estimate availability, reschedule, re-service,
  // voice relay, auto-dispatch) inherits this filter, so a prospective
  // placeholder or an office-only account never contributes a day.
  let techQuery = applyAssignable(db('technicians'));
  if (technicianId) techQuery = techQuery.where('technicians.id', technicianId);
  const techs = await techQuery.select('id', 'name');
  if (!techs.length) return { techs, services: [], dates: [] };

  // Load all scheduled services in date range, per tech, with coords
  const services = await db('scheduled_services')
    .whereBetween('scheduled_date', [dateFrom, dateTo])
    .whereNotIn('scheduled_services.status', NOT_A_ROUTE_STOP_STATUSES)
    .whereNotNull('scheduled_services.window_start')
    .where((q) => {
      q.whereNull('scheduled_services.reservation_expires_at')
        .orWhereRaw('scheduled_services.reservation_expires_at > NOW()');
    })
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .select(
      'scheduled_services.id',
      'scheduled_services.scheduled_date',
      'scheduled_services.technician_id',
      'scheduled_services.window_start',
      'scheduled_services.window_end',
      'scheduled_services.service_type',
      'scheduled_services.service_key_snapshot',
      'scheduled_services.estimated_duration_minutes',
      // Version-2 combined allocations (visit-capacity.js's occupiedRows,
      // the same expansion occupancy.js's shared anchor loader runs) need
      // this to know a row is one member of a summed allocation — without
      // it, buildDayStops treated raw members as independent stops and
      // never expanded through their real combined span (Codex r5 P1).
      'scheduled_services.reservation_service_mix',
      'scheduled_services.lat as svc_lat',
      'scheduled_services.lng as svc_lng',
      'customers.first_name',
      'customers.last_name',
      'customers.city',
      // Canonical columns on customers are latitude/longitude (added
      // by 20260414000029_geofence_timers.js). customers.lat / customers.lng
      // don't exist on prod — reading them throws and kills the whole
      // /available-slots query. Aliased back to cust_lat/cust_lng for
      // the downstream code that consumes those names. Primary coords only
      // stand in when the visit's stamped address doesn't DIVERGE from the
      // primary — modeling a stamped rental stop at the primary home offers
      // slots that don't fit the real route (codex round-8 P1); a divergent
      // coordless stop degrades to no-drive-time instead.
      db.raw(`CASE WHEN NOT ${stampedDivergesSql('scheduled_services', 'customers')} THEN customers.latitude END as cust_lat`),
      db.raw(`CASE WHEN NOT ${stampedDivergesSql('scheduled_services', 'customers')} THEN customers.longitude END as cust_lng`),
    );

  // Owner blackout days (admin Settings → Scheduling → Blackout days) are
  // removed from the offer enumeration here — /book, the reschedule page,
  // route-aware estimate slots, and the Waves AI searches all generate
  // through this function. (Surfaces that enumerate their own dates —
  // estimate ASAP capacity, rain-out SMS options — and the offer-redemption
  // commits consume the same shared helper.) Admin manual scheduling stays
  // unblocked by design — staff callers (the dispatch Find-best-times tool)
  // pass includeBlackoutDates:true to keep their recommendations complete.
  // The helper fails open.
  let dates = enumerateDates(dateFrom, dateTo, { includeWeekends });
  if (dates.length && !includeBlackoutDates) {
    const { getBlackoutDates } = require('./blackout-dates');
    const blackout = await getBlackoutDates(dates[0], dates[dates.length - 1]);
    if (blackout.size) dates = dates.filter((d) => !blackout.has(d));
  }
  return { techs, services, dates };
}

/**
 * Main entry. Returns ranked candidate slots — see normalizeFindTimeOptions
 * for the full option contract.
 * @returns {Promise<{slots: Array, evaluated: number}>}
 */
async function findAvailableSlots(opts) {
  if (capacityEnabled()) return findCapacitySlots(opts);
  const {
    lat, lng, durationMinutes, dateFrom, dateTo, technicianId, topN,
    dayStartHour, dayEndHour, includeWeekends, slotStepMinutes,
    earliestStartMin, serviceKey, expectedMinutes,
    stopBuffer, wantsPackedEnds, wantsExpectedMinutesCredit, excludeSet,
  } = normalizeFindTimeOptions(opts);
  // The requesting estimate's OWN uncommitted holds are not route stops for
  // itself (codex r17 P1). The collision filter downstream already excludes
  // them, but ROUTE GENERATION treated them as occupied anchors — so a held
  // 08:00 or 12:00 window (neither is a PREFERRED_WINDOWS slot) dropped out
  // of both the classified and ASAP pools, and the V1 page, which no longer
  // adopts that hold, could be left with no way to confirm the time the
  // customer already holds. Resolved to ids here so every downstream
  // exclusion — dayStops included — honours it through one set.
  if (opts.excludeEstimateId) {
    const ownHolds = await db('scheduled_services')
      .where({ source_estimate_id: opts.excludeEstimateId })
      .whereNull('customer_id')
      .whereNotNull('reservation_expires_at')
      .select('id');
    for (const row of ownHolds) excludeSet.add(String(row.id));
  }

  if (lat == null || lng == null) {
    return { error: 'lat/lng required', slots: [] };
  }
  if (!dateFrom || !dateTo) {
    return { error: 'dateFrom and dateTo required', slots: [] };
  }

  if (opts.arrivalWindow?.serviceId && arrivalWindowRoutingEnabled()) {
    return findArrivalWindowSlots(opts);
  }

  const newStop = { lat: parseFloat(lat), lng: parseFloat(lng) };
  const dayOpen = dayStartHour * 60;
  const dayClose = dayEndHour * 60;

  const { techs, services, dates } = await loadFindTimeContext({
    dateFrom, dateTo, technicianId, includeWeekends, includeBlackoutDates: opts.includeBlackoutDates,
  });
  if (!techs.length) return { slots: [], evaluated: 0, note: 'No assignable technicians found' };

  const candidates = [];
  let evaluated = 0;

  // Same-day floor: without it, an evening request still offers (and lets
  // the customer book) "Today 9:00 AM" — a confirmed visit whose window
  // already elapsed. 30-minute lead so a slot isn't offered seconds before
  // it starts.
  const todayEt = etDateString();
  const nowEt = etParts(new Date());
  const todayFloorMin = nowEt.hour * 60 + nowEt.minute + 30;

  // Expected-minutes padding (owner ruling 2026-09-23) — resolved ONCE for
  // the whole call; only ever matters for a customer-facing caller
  // (wantsExpectedMinutesCredit above). See resolveCandidateExpectedMinutes.
  const { candidateExpectedMinutes } = await resolveCandidateExpectedMinutes({
    wantsExpectedMinutesCredit, durationMinutes, expectedMinutes,
    serviceKey, serviceType: opts.serviceType || null,
  });
  // Invariants every gap's geometry (evaluateGap) needs, bundled once so the
  // per-gap call site stays a single readable line.
  const geo = {
    newStop, dateFrom, stopBuffer, candidateExpectedMinutes,
    durationMinutes, dayOpen, earliestStartMin, todayEt, todayFloorMin,
  };

  const dayParams = {
    services, geo, excludeSet, wantsPackedEnds, wantsExpectedMinutesCredit,
    slotStepMinutes, durationMinutes, dayOpen, dayClose,
  };
  for (const date of dates) {
    for (const tech of techs) {
      const { candidates: dayCandidates, evaluatedGaps } = candidatesForDay(date, tech, dayParams);
      evaluated += evaluatedGaps;
      candidates.push(...dayCandidates);
    }
  }

  // Sort by score ascending (lower = better)
  candidates.sort((a, b) => a.score - b.score);

  return {
    slots: candidates.slice(0, topN).map((c, i) => ({ rank: i + 1, ...c })),
    evaluated,
    total_feasible: candidates.length,
  };
}

module.exports = {
  findAvailableSlots,
  // Service-day bounds (ET hours) — the one place they are defined; other
  // offer surfaces (rain-out same-day presets) clamp to these.
  DAY_START_HOUR,
  DAY_END_HOUR,
  _internals: {
    enumerateDates,
    packCapacityEnds,
    capacityGapNeighbours,
    buildDayStops,
  },
};
