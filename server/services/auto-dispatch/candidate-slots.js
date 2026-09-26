/**
 * Candidate-slot generation for auto-dispatch.
 *
 * Reuses the existing travel-aware slot finder (services/scheduling/find-time.js
 * findAvailableSlots) over the eligible date window, then applies the HARD
 * constraints auto-dispatch adds on top:
 *   - drop any slot inside the customer's blackout window
 *   - drop any slot NOT on the customer's EXPLICIT preferred day (portal pref)
 *   - drop any slot OUTSIDE the customer's EXPLICIT preferred time window (portal)
 *   - drop any technician whose capability row for the service category is
 *     explicitly deactivated (capability is otherwise a soft scoring factor)
 *
 * Owner directive 2026-06-21: route efficiency is the optimization driver, but a
 * customer's portal scheduling preference OVERRIDES it. So an explicit preferred
 * day/time is a HARD filter here — route can only pick the most efficient slot
 * AMONG slots that honor the preference, never move the visit off it. The
 * service-type DEFAULT time window (pest→AM, lawn→mid-AM) is NOT a customer
 * preference and is left to soft scoring (scoring.js), so route stays free to
 * optimize around it when the customer set no time.
 *
 * Also computes the CURRENT placement's marginal drive cost (detour the visit
 * adds to its present day/route) so the scorer can measure improvement.
 *
 * GATE_AUTO_DISPATCH_SHARED_MODEL (owner-approved 2026-09-26, dispatch
 * backlog item 3): when on, this module additionally (a) re-scores the
 * current placement AND every surviving candidate's drive/cluster numbers
 * with the ONE shared model (route-model.js) instead of the current
 * placement's own two-neighbor haversine calc and find-time's independent
 * simulation, and (b) drops any candidate the rebooker's writer would refuse
 * with SLOT_TAKEN — the SAME window-overlap predicate the writer's hard
 * occupancy probe applies (overlap-predicate.js), so the finder only ever
 * offers a slot the move writer will actually accept. Gate off: byte-for-byte
 * today's behavior (find-time's own numbers, no overlap pre-filter).
 */
const { findAvailableSlots } = require('../scheduling/find-time');
const { etDateString, addETDays } = require('../../utils/datetime-et');
const { resolveGeo, driveMin, HQ } = require('./geo');
const { toDateStr, shiftDateStr } = require('./dates');
const { autoDispatchSharedModelLive } = require('../../config/feature-gates');
const { candidateHasOverlap, isActiveRouteStop } = require('./overlap-predicate');
const { routeCost, clusterShare, stopPlanningMinutes } = require('./route-model');

const DAY_OPEN = 8 * 60;
const DAY_CLOSE = 17 * 60;
const DEFAULT_DURATION = 60;
// Pull the full feasible set so the HARD filters (blackout / capability) run
// BEFORE any top-N trim — otherwise a long early blackout could fill the first N
// find-time results and wrongly yield NO_VALID_SLOT. Then cap how many survivors
// we actually score to bound cost.
const FETCH_CAP = 1000;
const SCORE_CAP = 80;

function hhmmToMin(t) {
  if (!t) return null;
  const [h, m] = String(t).split(':').map(Number);
  if (Number.isNaN(h)) return null;
  return h * 60 + (m || 0);
}

// Columns a technician-day's OTHER stops need for the shared route model
// (route-model.js: geo + planning-minutes category) and the overlap
// predicate (overlap-predicate.js: status/window/reservation). Shared by
// computeCurrentPlacement's neighbor query and loadDayStops below so both
// sides of the comparison read the identical shape.
const DAY_STOP_COLUMNS = [
  'scheduled_services.id',
  'scheduled_services.window_start',
  'scheduled_services.window_end',
  'scheduled_services.estimated_duration_minutes',
  'scheduled_services.status',
  'scheduled_services.reservation_expires_at',
  'scheduled_services.service_type',
  'scheduled_services.is_recurring',
  'scheduled_services.is_callback',
  'scheduled_services.service_address_line1',
  'scheduled_services.service_address_city',
  'scheduled_services.service_address_zip',
  'customers.address_line1 as customer_address_line1',
  'customers.city as customer_city',
  'customers.zip as customer_zip',
  'scheduled_services.lat as svc_lat',
  'scheduled_services.lng as svc_lng',
  'customers.latitude as customer_latitude',
  'customers.longitude as customer_longitude',
];

// Shapes a DAY_STOP_COLUMNS row into the plain {geo, startMin, ...} object
// both route-model.js and overlap-predicate.js read.
function rowToDayStop(r) {
  const startMin = hhmmToMin(r.window_start) ?? DAY_OPEN;
  return {
    id: r.id,
    geo: resolveGeo(r),
    startMin,
    endMin: r.window_end != null ? hhmmToMin(r.window_end) : startMin + (Number(r.estimated_duration_minutes) || DEFAULT_DURATION),
    window_start: r.window_start,
    window_end: r.window_end,
    status: r.status,
    reservation_expires_at: r.reservation_expires_at,
    service_type: r.service_type,
    is_recurring: r.is_recurring,
    is_callback: r.is_callback,
    estimated_duration_minutes: r.estimated_duration_minutes,
  };
}

// One technician-day's OTHER stops (never one of `excludeIds`), shaped for
// the shared model and filtered to ACTIVE stops only (overlap-predicate.js's
// isActiveRouteStop — the SAME status/expiry rule the writer's occupancy
// probe applies): cancelled/completed/skipped/rescheduled are excluded at
// the query level, and a no_show row or an expired estimate-slot hold
// (fetched here, since the query alone can't see reservation_expires_at
// expiring) is filtered out in memory. Without this, a day whose only
// "stops" are expired holds or no-shows was invisible to the overlap check
// but still counted as real stops for route-cost/cluster scoring — near-zero
// detour and full cluster credit for a day that is actually empty (Codex
// pre-push P1).
//
// technician_id = `technicianId` OR NULL (Codex pre-push P1): the writer's
// own move-conflict probe (rebooker.js probeMoveConflicts -> scheduling/
// occupancy.js findConflictingVisits) is occupancy-blind to which row an
// unassigned committed visit carries — "Waves runs exactly ONE active field
// technician, so any time overlap ... is a real-world clash whether the
// rows carry a technician_id, carry different ones, or carry none"
// (occupancy.js header; AGENTS.md's "tech-scoped conflict WHEREs are blind
// to technician-NULL rows" mirror rule). A tech-scoped-only query here
// missed a real double-booking the writer would refuse.
async function loadDayStops(db, { technicianId, dateStr, excludeIds }) {
  if (!technicianId) return [];
  const ids = [...(excludeIds || [])].map(String);
  const query = db('scheduled_services')
    .where('scheduled_services.scheduled_date', dateStr)
    .where((q) => {
      q.where('scheduled_services.technician_id', technicianId).orWhereNull('scheduled_services.technician_id');
    })
    .whereNotIn('scheduled_services.status', ['cancelled', 'completed', 'skipped', 'rescheduled'])
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id');
  if (ids.length) query.whereNotIn('scheduled_services.id', ids);
  const rows = await query.select(...DAY_STOP_COLUMNS);
  return rows.map(rowToDayStop).filter(isActiveRouteStop);
}

// Visit-group context for the moving visit (Codex pre-push P1): the ids
// moving together (self + every open group member — mirrors the rebooker's
// excludeServiceIds for a unit move, so they are never a conflict for each
// other, and never counted as a stationary "other stop" for route-cost/
// cluster scoring either — a group alone on its own day must not earn
// cluster credit from itself) and the sibling rows' fields needed to charge
// the group's OWN combined footprint (unitPlanningMinutes below). ONE
// `openMembers` read for the id list (the SAME accessor the rebooker's own
// unit-move machinery uses for group membership — reused, not re-derived);
// a second, only when there ARE siblings, for their planning-minutes
// inputs. Best-effort: an unreadable group read degrades to a standalone
// visit (no siblings), same as a plain (non-grouped) visit.
async function loadGroupContext(db, service) {
  const selfId = String(service.id);
  if (!service.visit_id) return { excludeIds: new Set([selfId]), siblings: [] };
  try {
    // Required lazily (not at module load) to avoid a require cycle: visit-groups
    // requires scheduling modules that touch this file's siblings.
    const { openMembers } = require('../visit-groups');
    const members = await openMembers(db, service.visit_id);
    const siblingIds = members.map((m) => String(m.id)).filter((id) => id !== selfId);
    const excludeIds = new Set([selfId, ...siblingIds]);
    if (!siblingIds.length) return { excludeIds, siblings: [] };
    const siblings = await db('scheduled_services')
      .whereIn('id', siblingIds)
      .select('id', 'service_type', 'is_recurring', 'is_callback', 'estimated_duration_minutes');
    return { excludeIds, siblings };
  } catch (_) {
    return { excludeIds: new Set([selfId]), siblings: [] };
  }
}

// The moving UNIT's true occupied minutes — route-model.js's owner
// planning-minutes table charged to the tapped visit AND every group
// sibling, summed (Codex pre-push P1: "charge the group as the moving unit
// consistently"). A grouped visit's real combined on-site time can run
// longer than the tapped row's own reported window; callers widen the
// occupancy check to at least this span (never shrinking it) so a
// multi-member group can't clear the overlap probe on a slot too short for
// the whole group.
function unitPlanningMinutes(service, siblings) {
  return stopPlanningMinutes(service) + (siblings || []).reduce((sum, m) => sum + stopPlanningMinutes(m), 0);
}

/**
 * GATE_AUTO_DISPATCH_SHARED_MODEL applied to a HARD-filtered candidate list:
 * drops any candidate the rebooker's writer would refuse with SLOT_TAKEN,
 * and re-scores every survivor's drive/cluster numbers with route-model.js —
 * the SAME function computeCurrentPlacement uses below, so the current
 * placement and every candidate are finally comparable on one scale (root
 * cause b of the 2026-09-26 incident). One DB round trip per distinct
 * (technician, date) pair among the candidates (cached).
 */
async function filterAndScoreSharedModelCandidates(service, geo, candidates, ctx, drops) {
  const { excludeIds, siblings } = await loadGroupContext(ctx.db, service);
  const minUnitMinutes = unitPlanningMinutes(service, siblings);
  const cache = new Map();
  const dayStopsFor = async (technicianId, dateStr) => {
    const key = `${technicianId}|${dateStr}`;
    if (!cache.has(key)) {
      cache.set(key, await loadDayStops(ctx.db, { technicianId, dateStr, excludeIds }));
    }
    return cache.get(key);
  };
  const kept = [];
  for (const cand of candidates) {
    const stops = await dayStopsFor(cand.technician_id, cand.date);
    const startMin = hhmmToMin(cand.start_time);
    // Never SHRINK the candidate's own reported window — only widen it to
    // at least the moving unit's true combined footprint (Codex pre-push
    // P1), so a standalone visit (minUnitMinutes <= its own duration in the
    // common case) is unaffected.
    const endMin = Math.max(hhmmToMin(cand.end_time), startMin + minUnitMinutes);
    if (candidateHasOverlap(stops, { startMin, endMin, excludeIds })) {
      if (drops) drops.slot_taken = (drops.slot_taken || 0) + 1;
      continue;
    }
    const { detourMinutes, driveWithMinutes } = routeCost(stops, { geo, startMin });
    kept.push({
      ...cand,
      detour_minutes: detourMinutes,
      total_drive_minutes: driveWithMinutes,
      same_area_share: clusterShare(stops, geo),
      model: 'shared_v1',
    });
  }
  return kept;
}

// Single entry point findValidCandidateSlots calls unconditionally — the
// gate check and the shared-model re-rank both live HERE (not at the call
// site) so adding this feature contributes exactly one statement, not one
// more branch, to findValidCandidateSlots' own complexity count. Gate off:
// returns `candidates` untouched, same array reference.
async function rankSurvivorsForSharedModel(service, geo, candidates, ctx, drops) {
  if (!autoDispatchSharedModelLive()) return candidates;
  const survivors = await filterAndScoreSharedModelCandidates(service, geo, candidates, ctx, drops);
  // Re-rank on the shared model's own detour so the SCORE_CAP trim below
  // keeps the survivors THIS model favors, not find-time's independent
  // ordering.
  return survivors.slice().sort((a, b) => (a.detour_minutes || 0) - (b.detour_minutes || 0));
}

function inBlackout(dateStr, blackout) {
  return !!(blackout && dateStr >= blackout.start && dateStr <= blackout.end);
}

// Weekday 0=Sun..6=Sat of a YYYY-MM-DD calendar date, tz-independent (noon UTC).
// Mirrors scoring.js weekdayOf so the HARD day filter and the soft day score
// agree on which weekday a candidate falls on.
function weekdayOf(dateStr) {
  const d = new Date(`${String(dateStr).split('T')[0]}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d.getUTCDay();
}

// find-time suppresses Sundays by default but NOT Saturdays; honor skip_weekends.
function isSaturday(dateStr) {
  return weekdayOf(dateStr) === 6;
}

// HARD: the customer set an explicit preferred day in the portal and this slot
// is not on it. preferred_day_indexes is empty when the customer has no day
// preference (→ no filter; route is free to pick any day).
function violatesPreferredDay(dateStr, prefs) {
  const dayIdx = prefs.preferred_day_indexes;
  if (!dayIdx || dayIdx.length === 0) return false;
  const dow = weekdayOf(dateStr);
  return dow == null || !dayIdx.includes(dow);
}

// HARD: the customer set an explicit preferred time in the portal and this
// slot's start falls outside it. Uses preferred_time_window (the EXPLICIT pref),
// NOT effective/default — the service-type default window is soft scoring only.
// Boundary semantics mirror scoring.js: [startMin, endMin).
function violatesPreferredTime(startTime, prefs) {
  const win = prefs.preferred_time_window;
  if (!win) return false;
  const startMin = hhmmToMin(startTime);
  if (startMin == null) return false; // unparseable start → don't hard-drop
  return startMin < win.startMin || startMin >= win.endMin;
}

/**
 * Marginal drive minutes the visit adds to its CURRENT day's route, plus how
 * many stops share that day. HQ book-ends the day. Mirrors find-time's gap math.
 */
async function computeCurrentPlacement(service, prefs, ctx) {
  const geo = resolveGeo(service);
  const dateStr = toDateStr(service.scheduled_date);
  const techId = service.technician_id || null;
  const category = prefs.service_category;

  let neighbors = [];
  if (techId) {
    const rows = await ctx.db('scheduled_services')
      .where('scheduled_services.scheduled_date', dateStr)
      .where('scheduled_services.technician_id', techId)
      .whereNot('scheduled_services.id', service.id)
      // 'rescheduled' phantom rows keep a stale date until staff action them —
      // not a real stop the tech will work, so exclude from detour/density too.
      .whereNotIn('scheduled_services.status', ['cancelled', 'completed', 'skipped', 'rescheduled'])
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .select(...DAY_STOP_COLUMNS);
    neighbors = rows
      .map(rowToDayStop)
      .filter((n) => n.geo)
      .sort((a, b) => a.startMin - b.startMin);
  }

  const myStart = hhmmToMin(service.window_start) ?? DAY_OPEN;
  const anchors = [
    { geo: HQ, startMin: DAY_OPEN, endMin: DAY_OPEN },
    ...neighbors,
    { geo: HQ, startMin: DAY_CLOSE, endMin: DAY_CLOSE },
  ];
  let prev = anchors[0];
  let next = anchors[anchors.length - 1];
  for (let i = 0; i < anchors.length; i++) {
    if (anchors[i].startMin <= myStart) prev = anchors[i];
  }
  for (let i = anchors.length - 1; i >= 0; i--) {
    if (anchors[i].startMin >= myStart) next = anchors[i];
  }

  let detour = 0;
  let totalDrive = 0;
  if (geo) {
    detour = Math.max(0, driveMin(prev.geo, geo) + driveMin(geo, next.geo) - driveMin(prev.geo, next.geo));
    totalDrive = driveMin(prev.geo, geo) + driveMin(geo, next.geo);
  }

  // GATE_AUTO_DISPATCH_SHARED_MODEL: re-derive detour/drive through the SAME
  // route-model.js function every candidate is scored with below, and add
  // the "same area already on that day" cluster share. Mathematically this
  // agrees with the two-neighbor formula above (both sum the identical set
  // of chain edges), but floating-point addition is not strictly
  // associative — routing through the shared function ONLY when the gate is
  // on keeps gate-off byte-for-byte the legacy computation.
  const sharedModelOn = autoDispatchSharedModelLive();
  // Shared-model neighbors (Codex pre-push P1): reuse loadDayStops — the
  // SAME fetch+filter the candidate side uses (tech-or-unassigned
  // occupancy, active stops only, the visit's OWN group siblings excluded)
  // — rather than deriving a second, slightly different list from the
  // legacy `neighbors` above. `neighbors` itself is untouched (still
  // tech-scoped, still carries a no_show/expired hold, still includes group
  // siblings) so the legacy formula above, and gate-off, stay byte-for-byte.
  let activeNeighbors = [];
  if (sharedModelOn) {
    const { excludeIds } = await loadGroupContext(ctx.db, service);
    activeNeighbors = await loadDayStops(ctx.db, { technicianId: techId, dateStr, excludeIds });
  }
  if (sharedModelOn && geo) {
    const shared = routeCost(activeNeighbors, { geo, startMin: myStart });
    detour = shared.detourMinutes;
    totalDrive = shared.driveWithMinutes;
  }

  return {
    is_current: true,
    detour_minutes: detour,
    total_drive_minutes: totalDrive,
    stops_that_day: neighbors.length + 1,
    technician_id: techId,
    date: dateStr,
    start_time: service.window_start ? String(service.window_start).slice(0, 5) : null,
    capability_level: ctx.capabilityFor(techId, category),
    ...(sharedModelOn ? { same_area_share: clusterShare(activeNeighbors, geo), model: 'shared_v1' } : {}),
  };
}

async function findValidCandidateSlots(service, prefs, ctx) {
  const geo = resolveGeo(service);
  if (!geo) return { current: null, candidates: [], note: 'no_geo' };

  // Search within ± tolerance days of the visit's CURRENT date (clamped to the
  // lock floor and lookahead horizon) so optimization tightens the route without
  // collapsing the recurring cadence by pulling the visit far from its date.
  const horizonCap = etDateString(addETDays(ctx.nowDate, ctx.lookaheadDays));
  const origDate = toDateStr(service.scheduled_date);
  let dateFrom;
  let dateTo;
  if (ctx.tierWindow) {
    // ROUTE-TIERS (GATE_ROUTE_TIERS on): the orchestrator already intersected
    // tier radius + drift budget + the >=5-days-out destination floor into one
    // window (route-tiers.tierMoveWindow); only the lookahead horizon still
    // caps it here. Absent tierWindow (gate off) the legacy math below runs
    // untouched — byte-for-byte the old candidate window.
    dateFrom = ctx.tierWindow.dateFrom;
    dateTo = ctx.tierWindow.dateTo;
    if (!dateTo || dateTo > horizonCap) dateTo = horizonCap;
  } else {
    const lockFloor = etDateString(addETDays(ctx.nowDate, ctx.lockWindowDays + 1));
    const tol = ctx.dateToleranceDays || 7;
    dateFrom = shiftDateStr(origDate, -tol);
    if (!dateFrom || dateFrom < lockFloor) dateFrom = lockFloor;
    dateTo = shiftDateStr(origDate, tol);
    if (!dateTo || dateTo > horizonCap) dateTo = horizonCap;
  }
  // Customer re-anchors carry a permanent due date. Repeated route nudges
  // must stay within the SAME ±3 days, including when route tiers are off.
  if (service.recurring_dispatch_due_date) {
    const due = toDateStr(service.recurring_dispatch_due_date);
    const dueFrom = shiftDateStr(due, -3);
    const dueTo = shiftDateStr(due, 3);
    if (!service.window_start) {
      // No promised time to freeze: first placement can use tomorrow onward.
      dateFrom = etDateString(addETDays(ctx.nowDate, 1));
      dateTo = horizonCap;
    }
    if (dateFrom < dueFrom) dateFrom = dueFrom;
    if (dateTo > dueTo) dateTo = dueTo;
  }
  if (dateFrom > dateTo) {
    // Window collapsed (visit sits at the very edge of the horizon) — nothing to do.
    const current = await computeCurrentPlacement(service, prefs, ctx);
    return { current, candidates: [], drops: null, feasible: 0 };
  }
  const duration = service.estimated_duration_minutes || DEFAULT_DURATION;
  const category = prefs.service_category;

  // Dates already occupied by another occurrence of THIS recurring series. The
  // rebooker only checks tech-time overlap, so without this two visits from the
  // same series could land on the same day (different time/tech). HARD filter.
  // ALL non-cancelled rows of the series — including booster-month rows. The
  // scheduler dedupes base recurring dates against boosters to avoid a
  // base+booster same-day double-booking, and the rebooker only checks
  // technician-time overlap, so boosters must block candidate dates too.
  const parentId = service.recurring_parent_id || service.id;
  const siblingRows = await ctx.db('scheduled_services')
    .where(function () { this.where('id', parentId).orWhere('recurring_parent_id', parentId); })
    .whereNot('id', service.id)
    // Due placement must honor reschedule holds preserved by the customer
    // re-anchor. Legacy optimization retains the seeder's request exclusion.
    .whereNotIn('status', service.recurring_dispatch_due_date ? ['cancelled'] : ['cancelled', 'rescheduled'])
    .whereBetween('scheduled_date', [dateFrom, dateTo])
    .select('scheduled_date');
  const siblingDates = new Set(siblingRows.map((r) => toDateStr(r.scheduled_date)));

  const findTimeArgs = {
    lat: geo.lat,
    lng: geo.lng,
    durationMinutes: duration,
    dateFrom,
    dateTo,
    excludeServiceIds: [service.id],
    slotStepMinutes: 60, // stops are always on the hour — never 10:15 / 1:30 starts
    // HARD time preference must enter slot GENERATION, not just post-filtering:
    // find-time emits only each gap's earliest-feasible start, so an empty day
    // with an afternoon preference would yield a single 08:00 candidate that the
    // post-filter drops — never generating the valid 13:00 start. Floor the gap's
    // earliest start at the window start so a preferred-time candidate is emitted.
    // The window UPPER bound + the preferred-DAY constraint stay post-filters
    // (each date is enumerated separately, so day filtering can't collapse a gap).
    ...(prefs.preferred_time_window
      ? { earliestStartMin: prefs.preferred_time_window.startMin }
      : {}),
    // NOTE: occupancy keeps find-time's default ['cancelled'] so it stays
    // consistent with SmartRebooker's overlap check (which treats 'rescheduled'
    // as a conflict). Excluding it here would propose slots apply then rejects.
  };
  // find-time route-RANKS (lowest detour first) then truncates to topN. Our HARD
  // filters (blackout, sibling, weekend, explicit preferred day/time, deactivated
  // tech) run AFTER, so if the route-best topN are all filtered out while a valid
  // slot sits just past the cap, we'd wrongly report no candidate — i.e. route
  // ranking would silently gate what the hard preference filter can see. Bound the
  // first pass at FETCH_CAP, but if it truncated (total_feasible > returned),
  // re-fetch the FULL feasible set so the hard filters see every slot. The window
  // is only ±tolerance days, so the full set is small; the re-fetch is rare (never
  // at current crew size) and only pays off in a dense window.
  let res = await findAvailableSlots({ ...findTimeArgs, topN: ctx.fetchCap || FETCH_CAP });
  let slots = (res && res.slots) || [];
  if (res && typeof res.total_feasible === 'number' && res.total_feasible > slots.length) {
    res = await findAvailableSlots({ ...findTimeArgs, topN: res.total_feasible });
    slots = (res && res.slots) || [];
  }

  // Drop tally — why feasible slots were rejected. Surfaced to the audit so an
  // empty candidate set reads as "honored the customer's preference, nothing
  // better available" rather than an opaque NO_VALID_SLOT.
  // slot_taken only increments with GATE_AUTO_DISPATCH_SHARED_MODEL on — the
  // writer-agreement overlap pre-filter (rankSurvivorsForSharedModel below).
  const drops = { blackout: 0, sibling: 0, weekend: 0, preferred_day: 0, preferred_time: 0, deactivated: 0, after_hours: 0, slot_taken: 0 };
  const candidates = [];
  for (const slot of slots) {
    // HARD: find-time (findAvailableSlots) shares ONE admission bound across
    // every caller once GATE_SCHEDULING_CAPACITY is on — scheduling/policy.js
    // SHIFT.endMinutes is the CUSTOMER day close (18:00 since picker-windows
    // PR 2, 2026-09-23), not an auto-dispatch one. Auto-dispatch re-optimizes
    // an EXISTING technician's route, not a customer-facing offer, and this
    // module's own DAY_CLOSE (used for the current-placement HQ anchor,
    // above) has always been 17:00 — without this filter, capacity mode
    // would let auto-dispatch move a visit into the new 17:00-18:00 hour the
    // owner's ruling only extended for customer booking (Codex r1 P1 on
    // #4663). Post-filtered here rather than threaded through find-time's
    // shared admission check, which every customer-facing caller (booking,
    // reschedule, re-service, the estimate picker, slot-reservation) also
    // relies on for offer/commit parity at the real 18:00 close.
    if (hhmmToMin(slot.end_time) > DAY_CLOSE) { drops.after_hours++; continue; }
    if (inBlackout(slot.date, prefs.blackout)) { drops.blackout++; continue; }       // HARD: blackout
    if (siblingDates.has(slot.date)) { drops.sibling++; continue; }                  // HARD: same-series occurrence that day
    if (service.skip_weekends === true && isSaturday(slot.date)) { drops.weekend++; continue; } // HARD: skip_weekends series
    // HARD: explicit portal preferences override route efficiency. Route may
    // only optimize among slots on the customer's preferred day + time window.
    if (violatesPreferredDay(slot.date, prefs)) { drops.preferred_day++; continue; }
    if (violatesPreferredTime(slot.start_time, prefs)) { drops.preferred_time++; continue; }
    const techId = slot.technician && slot.technician.id;
    const cap = ctx.capabilityFor(techId, category);
    if (cap === 'deactivated') { drops.deactivated++; continue; }                    // HARD: tech turned off for this category
    candidates.push({
      is_current: false,
      date: slot.date,
      start_time: slot.start_time,
      end_time: slot.end_time,
      detour_minutes: slot.detour_minutes,
      total_drive_minutes: slot.total_drive_minutes,
      // find-time reports stops BEFORE insertion; +1 for the moved visit so it
      // matches the current placement's count (which includes the visit itself).
      stops_that_day: (slot.stops_that_day || 0) + 1,
      technician_id: techId || null,
      technician_name: (slot.technician && slot.technician.name) || null,
      capability_level: cap,
      find_time_score: slot.score,
    });
  }

  // GATE_AUTO_DISPATCH_SHARED_MODEL: drop any candidate the rebooker's writer
  // would refuse (SLOT_TAKEN) and re-score survivors on the shared model,
  // BEFORE the SCORE_CAP trim below — otherwise a genuinely-better candidate
  // that find-time's own (different) ranking placed past the cap could be
  // sliced away before the shared model ever saw it. Gate off: `candidates`
  // passes through untouched (see rankSurvivorsForSharedModel).
  const survivors = await rankSurvivorsForSharedModel(service, geo, candidates, ctx, drops);

  // find-time (or the shared-model re-rank above) returns candidates
  // best-first; after the HARD filters, score only the top survivors to
  // bound cost.
  const scored = survivors.slice(0, ctx.scoreCap || SCORE_CAP);
  const current = await computeCurrentPlacement(service, prefs, ctx);
  return { current, candidates: scored, drops, feasible: slots.length };
}

module.exports = {
  findValidCandidateSlots,
  computeCurrentPlacement,
  inBlackout,
  violatesPreferredDay,
  violatesPreferredTime,
  _internals: {
    hhmmToMin, weekdayOf, isSaturday, loadDayStops, loadGroupContext, unitPlanningMinutes, filterAndScoreSharedModelCandidates,
  },
};
