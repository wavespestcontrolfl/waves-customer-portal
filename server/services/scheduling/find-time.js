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
const { paddingMinutesOf, effectiveEndMinutes } = require('./travel-gap');
const { ensureCatalogLoaded, expectedMinutesSync } = require('./expected-service-minutes');

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
      for (let start = Math.ceil(floor / 60) * 60; start + SHIFT.arrivalMinutes <= SHIFT.endMinutes; start += 60) {
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
      // Route neighbours of this placement (packed-ends filter below).
      _gap: {
        prevId: index > 0 ? fit.routeOrder[index - 1] : null,
        nextId: index < fit.routeOrder.length - 1 ? fit.routeOrder[index + 1] : null,
      },
    });
  }
  const packed = opts.packEnds === true ? packCapacityEnds(slots) : slots;
  for (const slot of packed) delete slot._gap;
  packed.sort((a, b) => a.score - b.score || a.waiting_minutes - b.waiting_minutes || a.start_time.localeCompare(b.start_time));
  return { slots: packed.slice(0, topN).map((slot, i) => ({ rank: i + 1, ...slot })),
    evaluated: candidates.length, total_feasible: packed.length, travel: travel.diagnostics() };
}

// Packed-ends for capacity results (Codex r2 P1): findCapacitySlots
// enumerates EVERY feasible whole-hour start against the complete route, so
// a customer-facing caller would still see the hole-making mid-gap hours.
// Group feasible placements by (date, tech, previous stop, next stop) and
// keep only the earliest start when the gap follows a real stop and the
// latest when it precedes one; a gap bordered by no stop (empty day) keeps
// every hour, exactly as the non-capacity packEnds rule does.
function packCapacityEnds(slots) {
  const groups = new Map();
  for (const slot of slots) {
    const key = `${slot.date}|${slot.technician.id}|${slot._gap?.prevId ?? ''}|${slot._gap?.nextId ?? ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(slot);
  }
  const keep = new Set();
  for (const group of groups.values()) {
    const prevReal = group[0]._gap?.prevId != null;
    const nextReal = group[0]._gap?.nextId != null;
    if (!prevReal && !nextReal) { for (const s of group) keep.add(s); continue; }
    const byStart = group.slice().sort((a, b) => a.start_time.localeCompare(b.start_time));
    if (prevReal) keep.add(byStart[0]);
    if (nextReal) keep.add(byStart[byStart.length - 1]);
  }
  return slots.filter((s) => keep.has(s));
}

/**
 * Main entry. Returns ranked candidate slots.
 *
 * @param {Object} opts
 * @param {number} opts.lat                  Target job latitude
 * @param {number} opts.lng                  Target job longitude
 * @param {number} [opts.durationMinutes=60] How long the new job takes
 * @param {string} opts.dateFrom             YYYY-MM-DD
 * @param {string} opts.dateTo               YYYY-MM-DD
 * @param {string} [opts.technicianId]       Restrict to one tech
 * @param {number} [opts.topN=10]            How many slots to return
 * @param {number} [opts.dayStartHour=8]
 * @param {number} [opts.dayEndHour=17]
 * @param {boolean} [opts.includeWeekends=false] Include Sundays in addition to Saturdays
 * @returns {Promise<{slots: Array, evaluated: number}>}
 */
async function findAvailableSlots(opts) {
  if (capacityEnabled()) return findCapacitySlots(opts);
  const {
    lat, lng,
    durationMinutes = DEFAULT_SERVICE_MIN,
    dateFrom, dateTo,
    technicianId,
    topN = 10,
    dayStartHour = DAY_START_HOUR,
    dayEndHour = DAY_END_HOUR,
    includeWeekends = false,
    // Service ids to drop from the occupied-route set — used when relocating an
    // existing visit so its own current row isn't counted as a stop blocking the
    // slot it's being moved out of. Default [] = identical legacy behavior.
    excludeServiceIds = [],
    // Snap proposed start times up to this minute granularity (e.g. 60 = on the
    // hour). Default 1 = exact earliest-feasible minute (identical legacy behavior).
    slotStepMinutes = 1,
    // Lower bound (minutes from midnight) on a proposed start time. Used to honor
    // a HARD customer time-window preference: each route gap emits only its
    // earliest-feasible start, so without this an empty/early gap collapses to
    // e.g. 08:00 and a valid later preferred start (e.g. 13:00 for an afternoon
    // preference) is never generated. Floors earliestStart so the gap yields a
    // candidate at/after the window start instead. Default 0 = no effect
    // (identical legacy behavior for every other caller).
    earliestStartMin = 0,
    // Turnaround minutes between the new stop and a NEIGHBOURING STOP (never an
    // HQ leg) on top of the modeled drive. Customer-facing callers pass
    // travel-gap.js customerFacingBufferMinutes() (GATE_SLOT_TRAVEL_GAP);
    // default 0 = legacy geometry for staff and optimizer callers. When this
    // is > 0 the neighbour-buffer geometry below also picks up the shared
    // expected-minutes padding reduction (scheduling/travel-gap.js,
    // expected-service-minutes.js, owner ruling 2026-09-23) so offers agree
    // with the same rule the commit gates enforce — with no expected-minutes
    // signal, padding is 0 and the math is identical to before that ruling.
    bufferMinutes = 0,
    // Packed-ends mode (customer-facing lanes ONLY — estimate slots, /book,
    // reschedule, re-service; staff/optimizer callers never pass this):
    // per route gap with an existing stop on either side, emit BOTH the
    // earliest feasible start (packed after prev) and the latest feasible
    // start (packed before next), each snapped to the hour, instead of one
    // earliest-only candidate. The leading gap (day-open to the first stop)
    // emits ONLY the latest (packed against the first stop); the trailing
    // gap (last stop to day-close) emits ONLY the earliest (packed against
    // the last stop); a middle gap emits both, or one when they coincide.
    // An empty day (no stops at all) is unaffected — the single HQ-to-HQ
    // gap keeps today's one-candidate-at-the-exact-minute behavior. Default
    // false = byte-identical single-candidate-per-gap output.
    packEnds = false,
    // The NEW job's own catalog identity, for its expected-minutes padding
    // credit when it is the EARLY side of a gap (packed before an upcoming
    // stop). Optional; no match (or no serviceKey/serviceType given) falls
    // back to the window length — zero padding, legacy gap.
    serviceKey = null,
    // A caller-resolved whole-visit expected minutes (estimate picker: the
    // sum across every service in the profile) — wins over the single
    // serviceKey lookup so a combined visit's other members are never
    // credited toward travel (push-audit P1).
    expectedMinutes = null,
  } = opts;
  const stopBuffer = Math.max(0, Number(bufferMinutes) || 0);
  const wantsPackedEnds = packEnds === true;
  const excludeSet = new Set((excludeServiceIds || []).map(String));
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

  // Load techs — only assignable ones (active employment AND field-dispatchable).
  // Every slot consumer (booking, estimate availability, reschedule, re-service,
  // voice relay, auto-dispatch) inherits this filter, so a prospective
  // placeholder or an office-only account never contributes a day.
  let techQuery = applyAssignable(db('technicians'));
  if (technicianId) techQuery = techQuery.where('technicians.id', technicianId);
  const techs = await techQuery.select('id', 'name');
  if (!techs.length) return { slots: [], evaluated: 0, note: 'No assignable technicians found' };

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

  let dates = enumerateDates(dateFrom, dateTo, { includeWeekends });

  // Owner blackout days (admin Settings → Scheduling → Blackout days) are
  // removed from the offer enumeration here — /book, the reschedule page,
  // route-aware estimate slots, and the Waves AI searches all generate
  // through this function. (Surfaces that enumerate their own dates —
  // estimate ASAP capacity, rain-out SMS options — and the offer-redemption
  // commits consume the same shared helper.) Admin manual scheduling stays
  // unblocked by design — staff callers (the dispatch Find-best-times tool)
  // pass includeBlackoutDates:true to keep their recommendations complete.
  // The helper fails open.
  if (dates.length && !opts.includeBlackoutDates) {
    const { getBlackoutDates } = require('./blackout-dates');
    const blackout = await getBlackoutDates(dates[0], dates[dates.length - 1]);
    if (blackout.size) dates = dates.filter((d) => !blackout.has(d));
  }

  const candidates = [];
  let evaluated = 0;

  // Same-day floor: without it, an evening request still offers (and lets
  // the customer book) "Today 9:00 AM" — a confirmed visit whose window
  // already elapsed. 30-minute lead so a slot isn't offered seconds before
  // it starts.
  const todayEt = etDateString();
  const nowEt = etParts(new Date());
  const todayFloorMin = nowEt.hour * 60 + nowEt.minute + 30;

  // Expected-minutes padding (owner ruling 2026-09-23) only ever matters
  // when a neighbour buffer is in play — with stopBuffer 0 (staff/optimizer
  // callers, or the gate off) `Math.max(0, 0 - padding)` is 0 regardless, so
  // skip the catalog read entirely and keep those callers' statement set
  // byte-identical. The candidate's OWN padding applies when IT is the
  // early side of a gap (packed before an upcoming stop); no
  // serviceKey/serviceType match falls back to the window length (no
  // credit, legacy gap).
  let candidatePadding = 0;
  let candidateExpectedMinutes = durationMinutes;
  if (stopBuffer > 0) {
    await ensureCatalogLoaded(db);
    candidateExpectedMinutes = Number.isFinite(expectedMinutes) && expectedMinutes > 0
      ? Math.min(expectedMinutes, durationMinutes)
      : expectedMinutesSync({
        serviceKey, serviceType: opts.serviceType || null, windowMinutes: durationMinutes,
      });
    candidatePadding = Math.max(0, durationMinutes - candidateExpectedMinutes);
  }

  for (const date of dates) {
    for (const tech of techs) {
      // Pull this tech's stops for this day
      const dayStops = services
        .filter(s => {
          if (excludeSet.has(String(s.id))) return false;
          const sd = toDateStr(s.scheduled_date);
          if (sd !== date) return false;
          // Packed-ends callers (customer-facing): an UNASSIGNED committed
          // visit is a real stop someone will serve that day — it anchors
          // the packing on every tech's route rather than reading as an
          // open day that fans out every grid hour (Codex r2 P1). Legacy
          // callers keep the per-tech route byte-identical.
          return s.technician_id === tech.id || (wantsPackedEnds && s.technician_id == null);
        })
        .map(s => {
          const startMin = timeToMinutes(s.window_start);
          const endMin = timeToMinutes(s.window_end) ?? startMin + (s.estimated_duration_minutes || DEFAULT_SERVICE_MIN);
          return {
            id: s.id,
            lat: s.svc_lat || s.cust_lat,
            lng: s.svc_lng || s.cust_lng,
            startMin,
            endMin,
            customer: `${s.first_name || ''} ${s.last_name || ''}`.trim() || 'Unknown',
            city: s.city,
            service_type: s.service_type,
            // Expected-minutes padding credit (owner ruling 2026-09-23) —
            // only resolved when a neighbour buffer is actually in play
            // (see candidatePadding above); a plain endMin-startMin window
            // with no catalog match degrades effectiveEndMinutes/
            // paddingMinutesOf to the legacy endMin/zero padding.
            ...(stopBuffer > 0 ? {
              expectedMinutes: expectedMinutesSync({
                serviceKey: s.service_key_snapshot, serviceType: s.service_type,
                windowMinutes: endMin - startMin,
              }),
            } : {}),
          };
        })
        .sort((a, b) => a.startMin - b.startMin);

      // Build virtual stop list: HQ ... stops ... HQ
      // "Stops" include timing. For gaps we evaluate between consecutive anchors.
      const anchors = [
        { id: 'HQ_START', lat: HQ.lat, lng: HQ.lng, startMin: dayOpen, endMin: dayOpen, customer: 'HQ (start)' },
        ...dayStops,
        { id: 'HQ_END', lat: HQ.lat, lng: HQ.lng, startMin: dayClose, endMin: dayClose, customer: 'HQ (end)' },
      ];

      // Evaluate each gap between anchor[i] and anchor[i+1]
      for (let i = 0; i < anchors.length - 1; i++) {
        const prev = anchors[i];
        const next = anchors[i + 1];
        evaluated++;

        const baselineDrive = driveMin(prev, next);
        const driveIn = driveMin(prev, newStop);
        const driveOut = driveMin(newStop, next);
        const detourDrive = driveIn + driveOut;
        const extraDrive = Math.max(0, detourDrive - baselineDrive);

        const prevIsStop = prev.id !== 'HQ_START';
        const nextIsStop = next.id !== 'HQ_END';

        // Neighbour-buffer geometry (owner ruling 2026-09-23): the buffer
        // against a real stop is reduced by that stop's own padding (window
        // minus its expected service minutes) when IT is the early side of
        // the pair — prev.endMin/prev's own padding on the earliest edge
        // (the existing stop finishes early, candidate arrives after), the
        // CANDIDATE's own padding on the latest edge (the candidate finishes
        // early, arrives before an upcoming stop). HQ legs never get a
        // buffer or padding credit — unaffected either way. With stopBuffer
        // 0 (no neighbour buffer in play) both terms are 0, byte-identical
        // to the legacy flat `prev.endMin + driveIn` / `next.startMin -
        // driveOut` geometry.
        const prevBuffer = prevIsStop ? Math.max(0, stopBuffer - paddingMinutesOf(prev)) : 0;
        const nextBuffer = nextIsStop ? Math.max(0, stopBuffer - candidatePadding) : 0;
        const prevAnchorEnd = prevIsStop ? effectiveEndMinutes(prev) : prev.endMin;

        // Earliest the new job could start: after the previous anchor's
        // (effective) end + drive from prev → new — floored at "now + lead"
        // when the date is today.
        const earliestFloor = Math.max(
          dayOpen,
          prevAnchorEnd + driveIn + prevBuffer,
          date === todayEt ? todayFloorMin : 0,
          earliestStartMin, // honor a hard time-window lower bound (0 = no-op)
        );
        // Must allow drive from new → next before next.startMin (its real,
        // never-adjusted window start — a promise to whoever holds it).
        // Against a REAL next stop the candidate is the early side of the
        // pair, so — exactly as travel-gap.js requiredGapMinutes/
        // effectiveEndMinutes measure it at commit — the drive starts at the
        // candidate's EXPECTED end (start + its expected minutes), not its
        // full window end; measuring from the window end here rejected
        // starts the commit probe accepts whenever drive > 0 (push-audit
        // P1). The HQ leg keeps the full window (no credit, as before).
        const latestEndFloor = next.startMin - driveOut - nextBuffer;
        const latestStartFloor = nextIsStop
          ? latestEndFloor - candidateExpectedMinutes
          : latestEndFloor - durationMinutes;

        // A coordless anchor (ungeocoded stop, or a divergent stamped rental
        // whose primary-coord fallback the SELECT suppressed) degrades to
        // zero drive time via driveMin() rather than hiding the gaps on
        // either side of it — skipping here starved otherwise-valid slots
        // around every coordless stop (codex round-9 P2).

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
            // separately from what the insertion adds to the route. A
            // coordless anchor scores as zero drive above (so its gaps stay
            // offered), but that zero is a sentinel, not a trip — report the
            // leg as unknown (null) so a hint omits it rather than claiming
            // "0 min drive" (Codex #4120 r2 P2).
            drive_in_minutes: hasCoords(prev) ? driveIn : null,
            drive_out_minutes: hasCoords(next) ? driveOut : null,
            score,
            // Last start this gap can hold (its end still clears the drive to
            // the next anchor). Availability surfaces that only offer clean
            // grid-aligned times use this to fan out EVERY aligned start the
            // gap fits — offering only the earliest-feasible minute meant an
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

        if (wantsPackedEnds && dayStops.length > 0) {
          // Packed-ends mode: BOTH ends of a real gap, snapped to the
          // customer hour grid (ceil for earliest, floor for latest — the
          // existing latest_start_min bound is the source), restricted to
          // whichever end(s) border a real stop. Legacy dedupe-by-slotId
          // downstream (estimate-slot-availability's dedupeSlots) tolerates
          // duplicates across gaps; within one gap, coincident ends collapse
          // to a single candidate below.
          const fits = (startMin) => Number.isFinite(startMin)
            && startMin >= earliestFloor
            && startMin <= latestStartFloor
            && startMin + durationMinutes <= dayClose;
          const earliestHourStart = Math.ceil(earliestFloor / 60) * 60;
          const latestHourStart = Math.floor(latestStartFloor / 60) * 60;
          const wantEarliest = prevIsStop; // trailing or middle gap
          const wantLatest = nextIsStop;   // leading or middle gap
          const starts = new Set();
          if (wantEarliest && fits(earliestHourStart)) starts.add(earliestHourStart);
          if (wantLatest && fits(latestHourStart)) starts.add(latestHourStart);
          for (const startMin of starts) candidates.push(makeCandidate(startMin));
          continue;
        }

        // Legacy single-candidate path: earliest-feasible minute only,
        // snapped to slotStepMinutes (default 1 = exact minute).
        const startMin = slotStepMinutes > 1
          ? Math.ceil(earliestFloor / slotStepMinutes) * slotStepMinutes
          : earliestFloor;
        const earliestEnd = startMin + durationMinutes;
        if (startMin > latestStartFloor) continue; // doesn't fit
        if (earliestEnd > dayClose) continue;  // past end of day
        candidates.push(makeCandidate(startMin));
      }
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
  },
};
