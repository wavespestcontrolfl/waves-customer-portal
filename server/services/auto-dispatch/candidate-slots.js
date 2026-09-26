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
 * with SLOT_TAKEN — by calling the WRITER'S OWN read-only conflict probe
 * (rebooker.js probeMoveConflicts, exported unchanged) for the tapped visit
 * and, for a grouped visit, for every sibling's OWN shifted window
 * (visit-groups.js predictMemberWindows — the writer's own per-member
 * shift math, reused, not re-derived) — so the finder only ever offers a
 * slot the move writer will actually accept, on every axis the writer
 * itself checks (tech-blind occupancy, booked interviews, per-member
 * windows). Gate off: byte-for-byte today's behavior (find-time's own
 * numbers, no pre-filter).
 */
const { findAvailableSlots } = require('../scheduling/find-time');
const { etDateString, addETDays } = require('../../utils/datetime-et');
const { resolveGeo, driveMin, HQ } = require('./geo');
const { toDateStr, shiftDateStr } = require('./dates');
const { autoDispatchSharedModelLive } = require('../../config/feature-gates');
const { isActiveRouteStop } = require('./overlap-predicate');
const { routeCost, clusterShare } = require('./route-model');
const { occupiedRows, windowsOverlap } = require('../scheduling/occupancy');
const { applyAssignable } = require('../technician-eligibility');

const DAY_OPEN = 8 * 60;
const DAY_CLOSE = 17 * 60;
const DEFAULT_DURATION = 60;
// Pull the full feasible set so the HARD filters (blackout / capability) run
// BEFORE any top-N trim — otherwise a long early blackout could fill the first N
// find-time results and wrongly yield NO_VALID_SLOT. Then cap how many survivors
// we actually score to bound cost (gate on: index.js caps AFTER scoring —
// see rankSurvivorsForSharedModel).
const FETCH_CAP = 1000;
const SCORE_CAP = 80;

function hhmmToMin(t) {
  if (!t) return null;
  const [h, m] = String(t).split(':').map(Number);
  if (Number.isNaN(h)) return null;
  return h * 60 + (m || 0);
}

// Columns a technician-day's OTHER stops need for the shared route model
// (route-model.js: geo, planning-minutes category, the canonical sequence
// keys route_order/created_at, and the co-visit merge's identity inputs —
// customer, premise, time_window — Codex r4) and the overlap predicate
// (overlap-predicate.js: status/window/reservation). Shared by
// computeCurrentPlacement's neighbor query and loadDayStops below so both
// sides of the comparison read the identical shape.
const DAY_STOP_COLUMNS = [
  'scheduled_services.id',
  'scheduled_services.visit_id',
  'scheduled_services.customer_id',
  'scheduled_services.route_order',
  'scheduled_services.created_at',
  'scheduled_services.time_window',
  'scheduled_services.window_start',
  'scheduled_services.window_end',
  'scheduled_services.estimated_duration_minutes',
  'scheduled_services.status',
  'scheduled_services.reservation_expires_at',
  'scheduled_services.service_type',
  'scheduled_services.is_recurring',
  'scheduled_services.is_callback',
  'scheduled_services.service_address_line1',
  'scheduled_services.service_address_line2',
  'scheduled_services.service_address_city',
  'scheduled_services.service_address_zip',
  'customers.address_line1 as customer_address_line1',
  'customers.address_line2 as customer_address_line2',
  'customers.city as customer_city',
  'customers.state as customer_state',
  'customers.zip as customer_zip',
  'scheduled_services.lat as svc_lat',
  'scheduled_services.lng as svc_lng',
  'customers.latitude as customer_latitude',
  'customers.longitude as customer_longitude',
];

// Shapes a DAY_STOP_COLUMNS row into the plain {geo, startMin, ...} object
// route-model.js and overlap-predicate.js read. `visit_id` travels through
// unchanged (Codex pre-push P1) so route-model.js's clusterShare can collapse
// a visit-group's members — the SAME physical address on several rows — to
// one physical stop rather than over-counting them.
function rowToDayStop(r) {
  const startMin = hhmmToMin(r.window_start) ?? DAY_OPEN;
  const geo = resolveGeo(r);
  return {
    id: r.id,
    visit_id: r.visit_id,
    customer_id: r.customer_id,
    route_order: r.route_order,
    created_at: r.created_at,
    time_window: r.time_window,
    // The co-visit merge (isCoVisitPair) reads the stop's coordinates and
    // premise under the canonical column names.
    lat: geo ? geo.lat : null,
    lng: geo ? geo.lng : null,
    service_address_line1: r.service_address_line1,
    service_address_line2: r.service_address_line2,
    service_address_city: r.service_address_city,
    service_address_zip: r.service_address_zip,
    customer_address_line1: r.customer_address_line1,
    customer_address_line2: r.customer_address_line2,
    customer_city: r.customer_city,
    customer_state: r.customer_state,
    customer_zip: r.customer_zip,
    geo,
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

// The moving UNIT's shape for route-model.js's routeCost: the tapped visit's
// own planning fields plus `unitMembers`, its group siblings (loadGroupContext).
// The siblings are excluded from the day's other stops because they move too,
// so routeCost must charge their planning minutes with the visit's — on the
// current placement and every candidate alike — or a grouped visit's route
// minutes would omit their work (Codex pre-push P1).
function serviceToRouteStop(service, geo, startMin, siblings = [], routeOrder = service.route_order) {
  return {
    geo,
    startMin,
    // Sequence tie keys (Codex r4): where the visit joins the day's order.
    id: service.id,
    route_order: routeOrder,
    created_at: service.created_at,
    visit_id: service.visit_id,
    service_type: service.service_type,
    is_recurring: service.is_recurring,
    is_callback: service.is_callback,
    estimated_duration_minutes: service.estimated_duration_minutes,
    window_start: service.window_start,
    window_end: service.window_end,
    unitMembers: siblings,
  };
}

// Which tech-day a batched day-stop row belongs to (loadDayStopRows serves
// every candidate tech-day from ONE query).
const DAY_STOP_KEY_COLUMNS = ['scheduled_services.scheduled_date', 'scheduled_services.technician_id'];

// The ROUTE-SCORING input (routeCost/clusterShare) for a set of tech-days, in
// ONE query (Codex r1: no per-tech-day serial reads): every OTHER stop (never
// one of `excludeIds`) on any of `dates` assigned to one of `technicianIds`
// or to no technician — Waves runs one active field tech, so an unassigned
// row is work that same tech still serves (Codex r1). Separate from the
// SLOT_TAKEN pre-filter, which asks the writer's own probe (below). Active
// stops only: cancelled/completed/skipped/rescheduled excluded in SQL, a
// no_show row or an expired estimate-slot hold dropped by isActiveRouteStop,
// and a windowless placeholder (window_start NULL — a due-date recurring
// child not yet placed) excluded outright, as the occupancy reader keeps it
// inert; otherwise it would default to a fictional 08:00 stop. No
// technician ids: the unassigned rows alone.
async function loadDayStopRows(db, { technicianIds, dates, excludeIds }) {
  const techIds = [...new Set((technicianIds || []).filter(Boolean).map(String))];
  const dateList = [...new Set((dates || []).filter(Boolean))];
  if (!dateList.length) return [];
  const ids = [...(excludeIds || [])].map(String);
  const query = db('scheduled_services')
    .whereIn('scheduled_services.scheduled_date', dateList)
    .where((q) => {
      if (techIds.length) q.whereIn('scheduled_services.technician_id', techIds).orWhereNull('scheduled_services.technician_id');
      else q.whereNull('scheduled_services.technician_id');
    })
    .whereNotIn('scheduled_services.status', ['cancelled', 'completed', 'skipped', 'rescheduled'])
    .whereNotNull('scheduled_services.window_start')
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id');
  if (ids.length) query.whereNotIn('scheduled_services.id', ids);
  const rows = await query.select(...DAY_STOP_COLUMNS, ...DAY_STOP_KEY_COLUMNS);
  return rows
    .map((r) => ({ ...rowToDayStop(r), dateStr: toDateStr(r.scheduled_date), technician_id: r.technician_id ?? null }))
    .filter(isActiveRouteStop);
}

// One tech-day's stops out of a loadDayStopRows result.
function stopsForTechDay(stops, technicianId, dateStr) {
  return stops.filter((s) => s.dateStr === dateStr
    && (s.technician_id == null || String(s.technician_id) === String(technicianId)));
}

// A single tech-day (computeCurrentPlacement's current day); a null
// technicianId reads the unassigned rows alone.
async function loadDayStops(db, { technicianId, dateStr, excludeIds }) {
  return loadDayStopRows(db, { technicianIds: technicianId ? [technicianId] : [], dates: [dateStr], excludeIds });
}

// The technician whose day an UNASSIGNED visit sits on (Codex pre-push P1):
// eligible recurring visits can carry technician_id NULL, and every
// candidate is scored on its tech's stops plus the unassigned ones, so the
// current placement must read the same single-tech day — not an empty one,
// which would score a well-clustered unassigned visit as a lone HQ round
// trip and let any candidate clear the threshold. Waves runs one active
// field technician: the only assignable one (technician-eligibility.js's
// applyAssignable). Anything else (none, several, an unreadable table)
// resolves to null — the unassigned rows alone, no guessed technician.
async function resolveCurrentDayTech(db, service) {
  if (service.technician_id) return service.technician_id;
  try {
    const techs = await applyAssignable(db('technicians')).select('technicians.id');
    return Array.isArray(techs) && techs.length === 1 ? techs[0].id : null;
  } catch {
    return null;
  }
}

// The moving unit: its ids (self + every open group member — the rebooker's
// excludeServiceIds for a unit move, so members never conflict with each
// other and never count as a stationary "other stop" for scoring), the
// sibling rows predictMemberWindows (dates, windows, durations) and
// routeCost (planning fields) need, and the visit's canonical start (the
// unit mover's anchor when the tapped row is windowless). ONE `openMembers`
// read (the accessor the unit mover itself uses) and, only when there ARE
// siblings, one read of those rows and one of the visit. An unreadable group
// FAILS CLOSED (Codex r3 P1): a visit_id row whose members cannot be read may
// well be grouped, and scoring it as standalone would probe and place only
// the tapped row — so the evaluation is abandoned (GROUP_CONTEXT_UNAVAILABLE,
// which the orchestrator records as a no-change skip).
const GROUP_CONTEXT_UNAVAILABLE = 'GROUP_CONTEXT_UNAVAILABLE';
async function loadGroupContext(db, service) {
  const selfId = String(service.id);
  const standalone = { excludeIds: new Set([selfId]), siblings: [], visitWindowStart: null };
  if (!service.visit_id) return standalone;
  try {
    const { openMembers } = require('../visit-groups');
    const members = await openMembers(db, service.visit_id);
    const excludeIds = new Set([selfId, ...(members || []).map((m) => String(m.id))]);
    const siblingIds = [...excludeIds].filter((id) => id !== selfId);
    if (!siblingIds.length) return { ...standalone, excludeIds };
    const [siblings, visit] = await Promise.all([
      db('scheduled_services')
        .whereIn('id', siblingIds)
        .select(
          'id', 'scheduled_date', 'technician_id', 'window_start', 'window_end', 'route_order', 'created_at',
          'estimated_duration_minutes', 'service_type', 'is_recurring', 'is_callback',
        ),
      db('service_visits').where({ id: service.visit_id }).first('window_start'),
    ]);
    return { excludeIds, siblings, visitWindowStart: (visit && visit.window_start) || null };
  } catch (err) {
    throw Object.assign(new Error('Visit group could not be read'), { code: GROUP_CONTEXT_UNAVAILABLE, cause: err });
  }
}

// ONE group read per evaluation (Codex pre-push P1): the current placement
// and the candidates must score the SAME unit — two separate, non-atomic
// openMembers reads could straddle a membership change and compare a
// current placement for one unit against candidates for another. Gate on,
// findValidCandidateSlots reads the group once into an evaluation-scoped
// copy of ctx (never the caller's ctx, which a later re-evaluation reuses
// and must read afresh); gate off, nothing is read and ctx passes through.
async function withGroupContext(service, ctx) {
  if (!autoDispatchSharedModelLive()) return ctx;
  return { ...ctx, groupContext: await loadGroupContext(ctx.db, service) };
}

// The evaluation's group context, or a fresh read for a direct caller.
async function groupContextFor(service, ctx) {
  return ctx.groupContext || loadGroupContext(ctx.db, service);
}

// A full-day window: auto-dispatch never passes the probe's `travel` or admin
// `arrivalWindow` options, so probeMoveConflicts takes findConflictingVisits'
// plain overlap path, where the window is only a WHERE bound — a full day
// returns every row (visits + booked interviews) that could conflict with
// ANY window that date.
const FULL_DAY_PROBE_WINDOW = { start: '00:00', end: '23:59' };
// Dates probed at once; each probe is one visit read + one interview read.
const PROBE_DATE_CONCURRENCY = 4;

// One date's occupancy through the WRITER'S OWN read-only probe
// (rebooker.js probeMoveConflicts, exported unchanged: tech-blind, same
// status/hold/windowless rules, booked interviews included), with the moving
// unit's ids excluded exactly as the unit move excludes them. Rows are
// expanded to their occupied span with occupancy.js's own occupiedRows —
// the expansion findConflictingVisits itself applies — so a candidate
// window then clears or clashes by the same half-open windowsOverlap the
// probe finishes with.
async function loadDateOccupiedSpans(db, dateStr, excludeIds) {
  // Required lazily, like openMembers above (the writer modules load on use).
  const { probeMoveConflicts } = require('../rebooker');
  const { rows } = await probeMoveConflicts({
    conn: db,
    target: {
      id: `auto-dispatch-date-probe:${dateStr}`,
      date: dateStr,
      windowStart: FULL_DAY_PROBE_WINDOW.start,
      windowEnd: FULL_DAY_PROBE_WINDOW.end,
      technicianId: null,
    },
    excludeServiceIds: [...excludeIds],
  });
  return occupiedRows(rows)
    .map((r) => ({ startMin: r.startMin, endMin: r.endMin }))
    .filter((r) => r.startMin != null && Number.isFinite(r.endMin));
}

// Every candidate date's occupancy: one probe per DISTINCT date (never per
// candidate or per member — Codex r1), PROBE_DATE_CONCURRENCY at a time.
async function loadOccupiedSpansByDate(db, dates, excludeIds) {
  const list = [...new Set(dates)];
  const byDate = new Map();
  for (let i = 0; i < list.length; i += PROBE_DATE_CONCURRENCY) {
    const chunk = list.slice(i, i + PROBE_DATE_CONCURRENCY);
    const spans = await Promise.all(chunk.map((d) => loadDateOccupiedSpans(db, d, excludeIds)));
    chunk.forEach((d, j) => byDate.set(d, spans[j]));
  }
  return byDate;
}

// Where the writer would put the moving unit for this candidate, or null
// when it would refuse the placement outright. Standalone: reschedule()'s own
// span — the requested end, else the stored end, else occupancyProbeEnd's
// duration/one-hour rule. Grouped: predictMemberWindows — moveVisitAsUnit's
// own planning (anchor, shifted windows, midnight and admin-window
// refusals) — then each member's span by the same end rule, as that
// member's reschedule() probes it; a windowless member is not probed.
// Returns `{ windows, targets }`: the probe spans, and each member's target
// `{ id, start, end }` (where route scoring sequences the unit).
function planUnitPlacement(service, group, cand) {
  const { occupancyProbeEnd } = require('../rebooker');
  let targets = [{ id: service.id, start: cand.start_time, end: cand.end_time || service.window_end, duration: service.estimated_duration_minutes }];
  if (group.members) {
    const { predictMemberWindows } = require('../visit-groups');
    const predicted = predictMemberWindows({
      members: group.members,
      primaryId: service.id,
      visitWindowStart: group.visitWindowStart,
      requestedStart: cand.start_time,
      requestedEnd: cand.end_time,
      newDateStr: cand.date,
    });
    if (!predicted.ok) return null;
    targets = predicted.targets.map((t, i) => ({ id: t.id, start: t.start, end: t.end, duration: group.members[i].estimated_duration_minutes }));
  }
  try {
    const windows = targets.filter((t) => t.start).map((t) => ({ start: t.start, end: occupancyProbeEnd(t.start, t.end, t.duration) }));
    return { windows, targets: targets.map(({ id, start, end }) => ({ id, start: start || null, end: end || null })) };
  } catch {
    return null;
  }
}

// The grouped visit's rows in the shape predictMemberWindows reads (the
// primary first), or null for a standalone visit.
function unitMembers(service, siblings) {
  if (!siblings.length) return null;
  const self = {
    id: service.id,
    scheduled_date: service.scheduled_date,
    window_start: service.window_start,
    window_end: service.window_end,
    estimated_duration_minutes: service.estimated_duration_minutes,
  };
  return [self, ...siblings];
}

// The siblings as they will stand after this candidate's move — each at its
// predicted target window, with the route_order the rebooker leaves it
// (candidateRouteOrder, per member) — so route-model's groupUnit places the
// unit exactly as dispatch will sequence it (Codex r5).
function movedSiblings(siblings, placement, cand) {
  const target = new Map(placement.targets.map((t) => [String(t.id), t]));
  return siblings.map((sib) => {
    const t = target.get(String(sib.id));
    return {
      ...sib,
      window_start: t && t.start ? t.start : sib.window_start,
      window_end: t && t.start ? t.end : sib.window_end,
      route_order: candidateRouteOrder(sib, cand),
    };
  });
}

function slotTaken(placement, occupied) {
  if (!placement) return true;
  return placement.windows.some((w) => {
    const s = hhmmToMin(w.start);
    const e = hhmmToMin(w.end);
    return occupied.some((o) => windowsOverlap(s, e, o.startMin, o.endMin));
  });
}

// The route_order the moved visit would carry: reschedule() clears it on a
// date or technician change (the destination day appends the stop) and keeps
// it on a same-day, same-tech window move.
function candidateRouteOrder(service, cand) {
  const sameDay = toDateStr(service.scheduled_date) === cand.date;
  const sameTech = String(service.technician_id || '') === String(cand.technician_id || '');
  return sameDay && sameTech ? service.route_order : null;
}

// One surviving candidate's numbers on the shared model — the SAME
// routeCost/clusterShare computeCurrentPlacement uses — over that tech-day's
// active stops.
function scoreOnSharedModel(service, geo, cand, stops, siblings, placement) {
  const moved = movedSiblings(siblings, placement, cand);
  const cost = routeCost(stops, serviceToRouteStop(service, geo, hhmmToMin(cand.start_time), moved, candidateRouteOrder(service, cand)));
  return {
    ...cand,
    detour_minutes: cost.detourMinutes,
    total_drive_minutes: cost.driveWithMinutes,
    route_minutes: cost.routeTimeWithMinutes,
    stops_that_day: stops.length + 1,
    same_area_share: clusterShare(stops, geo),
    model: 'shared_v1',
  };
}

/**
 * GATE_AUTO_DISPATCH_SHARED_MODEL applied to a HARD-filtered candidate list:
 * drops every candidate the rebooker's writer would refuse with SLOT_TAKEN
 * (planUnitPlacement against the writer's own probe, loaded once per date),
 * and re-scores each survivor on the shared model over its technician's day
 * (one batched day-stop read). Nothing here writes.
 */
async function filterAndScoreSharedModelCandidates(service, geo, candidates, ctx, drops) {
  const { excludeIds, siblings, visitWindowStart } = await groupContextFor(service, ctx);
  const group = { members: unitMembers(service, siblings), visitWindowStart };
  const dates = candidates.map((c) => c.date);
  const [occupiedByDate, dayStops] = await Promise.all([
    loadOccupiedSpansByDate(ctx.db, dates, excludeIds),
    loadDayStopRows(ctx.db, { technicianIds: candidates.map((c) => c.technician_id), dates, excludeIds }),
  ]);
  const stopsByTechDay = new Map();
  const kept = [];
  for (const cand of candidates) {
    const placement = planUnitPlacement(service, group, cand);
    if (slotTaken(placement, occupiedByDate.get(cand.date) || [])) {
      if (drops) drops.slot_taken = (drops.slot_taken || 0) + 1;
      continue;
    }
    const key = `${cand.technician_id}|${cand.date}`;
    if (!stopsByTechDay.has(key)) stopsByTechDay.set(key, stopsForTechDay(dayStops, cand.technician_id, cand.date));
    kept.push(scoreOnSharedModel(service, geo, cand, stopsByTechDay.get(key), siblings, placement));
  }
  return kept;
}

// Single entry point findValidCandidateSlots calls unconditionally, so the
// gate adds no branch there. Gate off: find-time's order trimmed to the
// SCORE_CAP survivors that get scored, exactly as before. Gate on: every
// survivor, ordered by the shared model's detour — index.js scores ALL of
// them and caps by total score instead (Codex r1: a pre-score cap on a
// detour proxy could drop the best-scoring candidate unscored).
async function rankSurvivorsForSharedModel(service, geo, candidates, ctx, drops) {
  if (!autoDispatchSharedModelLive()) return candidates.slice(0, ctx.scoreCap || SCORE_CAP);
  const survivors = await filterAndScoreSharedModelCandidates(service, geo, candidates, ctx, drops);
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
  // Gate on: sharedModelCurrentPlacement reads the day itself and replaces
  // every field these neighbors feed (they only matter when the visit has a
  // location, and then the shared model overrides them), so skip the legacy
  // read instead of querying the same tech-day twice per evaluation.
  if (techId && !autoDispatchSharedModelLive()) {
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
  if (geo) {
    detour = Math.max(0, driveMin(prev.geo, geo) + driveMin(geo, next.geo) - driveMin(prev.geo, next.geo));
  }

  return {
    is_current: true,
    detour_minutes: detour,
    total_drive_minutes: geo ? driveMin(prev.geo, geo) + driveMin(geo, next.geo) : 0,
    stops_that_day: neighbors.length + 1,
    technician_id: techId,
    date: dateStr,
    start_time: service.window_start ? String(service.window_start).slice(0, 5) : null,
    capability_level: ctx.capabilityFor(techId, category),
    ...(await sharedModelCurrentPlacement(service, geo, ctx, dateStr)),
  };
}

// GATE_AUTO_DISPATCH_SHARED_MODEL: the current placement's numbers from the
// SAME inputs and functions every candidate gets (scoreOnSharedModel) — the
// same day model (the visit's technician, or for an unassigned visit the
// single active one, plus unassigned rows; active stops only; the visit's
// own group excluded), so detour, route minutes, stop count and cluster
// share all describe one stop list (Codex r1: stops_that_day counted the
// legacy list). Overrides the legacy fields above; gate off returns {} so the
// legacy object is byte-for-byte unchanged.
async function sharedModelCurrentPlacement(service, geo, ctx, dateStr) {
  if (!autoDispatchSharedModelLive()) return {};
  const { excludeIds, siblings } = await groupContextFor(service, ctx);
  const dayTech = await resolveCurrentDayTech(ctx.db, service);
  const stops = await loadDayStops(ctx.db, { technicianId: dayTech, dateStr, excludeIds });
  // The unit as it stands: every member at its stored window and route_order
  // (route-model's groupUnit sequences it, as a candidate's is).
  const cost = geo ? routeCost(stops, serviceToRouteStop(service, geo, hhmmToMin(service.window_start) ?? DAY_OPEN, siblings)) : null;
  return {
    ...(cost ? { detour_minutes: cost.detourMinutes, total_drive_minutes: cost.driveWithMinutes, route_minutes: cost.routeTimeWithMinutes } : {}),
    stops_that_day: stops.length + 1,
    same_area_share: clusterShare(stops, geo),
    model: 'shared_v1',
  };
}

async function findValidCandidateSlots(service, prefs, baseCtx) {
  const geo = resolveGeo(service);
  if (!geo) return { current: null, candidates: [], note: 'no_geo' };
  // The visit group is read ONCE for this evaluation and shared by the
  // current placement and every candidate (see withGroupContext).
  const ctx = await withGroupContext(service, baseCtx);

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

  // Gate off: find-time's best-first order, top SCORE_CAP survivors (see
  // rankSurvivorsForSharedModel). Gate on: SLOT_TAKEN candidates dropped and
  // every survivor re-scored on the shared model.
  const scored = await rankSurvivorsForSharedModel(service, geo, candidates, ctx, drops);
  const current = await computeCurrentPlacement(service, prefs, ctx);
  return { current, candidates: scored, drops, feasible: slots.length };
}

module.exports = {
  SCORE_CAP,
  GROUP_CONTEXT_UNAVAILABLE,
  findValidCandidateSlots,
  computeCurrentPlacement,
  inBlackout,
  violatesPreferredDay,
  violatesPreferredTime,
  _internals: {
    hhmmToMin, weekdayOf, isSaturday, loadDayStops, loadDayStopRows, loadGroupContext,
    filterAndScoreSharedModelCandidates, loadDateOccupiedSpans, planUnitPlacement, movedSiblings, candidateRouteOrder,
  },
};
