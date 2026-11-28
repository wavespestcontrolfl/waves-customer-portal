/**
 * TWO-STOP DAY CLEARING PASS (owner 2026-11-27, Decision B):
 *
 * Single-visit optimization evaluates each stop's marginal detour while the
 * other stop stays behind. When a technician-day holds exactly two nearby
 * stops (A and B), each stop's individual detour is tiny because the other
 * stop absorbs the shared home/office round-trip stem — trapping both stops
 * on a light 2-stop day even when emptying the day together saves 20+ real
 * drive minutes.
 *
 * Runs AFTER pass 2 (so it catches both days that started with 2 stops and
 * days that became 2-stop days after pass 2 moved other visits off them).
 *
 * Safety invariants (zero shortcuts):
 *   - Only standalone, non-conflict, Pass-1-eligible visits that are the ONLY
 *     2 live rows on `(technician_id, date)` (no unassigned stops, holds,
 *     completed/in-progress/locked stops on that date).
 *   - Distinct customers only (never splits a legacy co-visit or same-customer
 *     pair across days).
 *   - Enforces every HARD filter via findValidCandidateSlots (flex window,
 *     preferences, away/blackout, mowing, south-day-kept, capability, shift
 *     hours, bounce guard, arrivalInsert), plus NO Sunday destinations and
 *     explicit non-regression on customer preference, tech skill, and
 *     combined destination workload (<= 480 min full-credit bar).
 *   - Same-destination pairs verify non-overlap, far-south compatibility,
 *     joint arrival-route feasibility (with A placed first, then B), exact
 *     combined drive, and exact post-A `route_order_ids` for B's commit.
 *   - Combined drive saving must clear `pairClearFloor(A, B, config)` (20 min
 *     for two unmoved visits, 25/30 min if previously moved) on both the
 *     shared model AND real Google roads (fails closed when unavailable).
 *   - Move proofreader checks BOTH A and B BEFORE committing either visit; if
 *     either is held/unsure/changed, neither visit moves.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { autoDispatchSharedModelLive, multiTechConfirmLive, schedulingPlanMinutesOnly } = require('../../config/feature-gates');
const { currentOrder } = require('../route-reorder-window-fit');
const { NOT_A_ROUTE_STOP_STATUSES } = require('../stops-ahead');
const { bookedVisitOrLiveHold } = require('../scheduling/reservation-occupancy');
const { loadArrivalRouteContext, evaluateArrivalPlacement, hasInsertionIncompatibleRow } = require('../scheduling/arrival-route');
const { loadTechShifts, shiftBounds } = require('../technician-eligibility');
const { SHIFT, capacityEnabled } = require('../scheduling/policy');
const { toDateStr } = require('./dates');
const { HQ, resolveGeo, driveMin } = require('./geo');
const { scoreAppointmentPlacement, _internals: { workloadScoreFor, hhmmToMin } } = require('./scoring');
const moveRules = require('./move-rules');
const { isBounceBackDate } = require('./bounce-guard');
const {
  physicalStops, chainDriveMinutes, routeCost, stopPlanningMinutes, routeOrderCovers,
  _internals: { insertByRouteOrder },
} = require('./route-model');
const candidateSlots = require('./candidate-slots');
const {
  _internals: {
    loadDayStopRows, stopsForTechDay, loadOccupiedSpansByDate, slotTaken, canPlaceInRoute,
    serviceToRouteStop, planUnitPlacement, loadStartPoints, homeFor,
  },
} = candidateSlots;
const roadCheck = require('./road-check');
const southDayKept = require('./south-day-kept');

const PAIR_TOP_SLOTS = 12;
const MAX_PAIR_DAYS_PER_RUN = 12;
const LIVE_PAIR_STATUSES = new Set(['pending', 'confirmed']);

function round2(v) { return Math.round(v * 100) / 100; }

function pairClearFloor(serviceA, serviceB, config) {
  if (!config) return 0;
  const ordFloor = Number(config.minDayMoveDriveSavingMinutes) || 0;
  const minA = moveRules.minutesRuleFloor(serviceA, config);
  const minB = moveRules.minutesRuleFloor(serviceB, config);
  if (ordFloor <= 0 || minA <= 0 || minB <= 0) return 0;
  return Math.max(2 * ordFloor, minA + minB);
}

function isEnabled(config) {
  if (!autoDispatchSharedModelLive() || !config || config.roadCheckEnabled !== true) return false;
  return (Number(config.minDayMoveDriveSavingMinutes) || 0) > 0
    && ((Number(config.minutesRuleSavingMinutes) || 0) > 0 || (Number(config.minutesRuleSecondMoveSavingMinutes) || 0) > 0);
}

function isEligibleEntry(service, evalResult) {
  return Boolean(service && evalResult && evalResult.kind === 'no_change'
    && !evalResult.conflict && !service.visit_id && service.window_start && service.technician_id);
}

function techDayKey(techId, date) {
  return `${String(techId)}|${toDateStr(date)}`;
}

// Pure source-day drive for two standalone stops on one tech-day.
// Outbound departure leaves home at or after the technician's shift departure
// time (in time for stop 1), and road-check propagates actual leg travel,
// waiting, and service durations across home -> stop 1 -> stop 2 -> home.
function pairSourceDrive(stopA, stopB, home = HQ, sourceDate = null, vanDepartureMin = SHIFT.startMinutes) {
  if (!stopA || !stopB) return null;
  if (stopA.customer_id && stopB.customer_id && String(stopA.customer_id) === String(stopB.customer_id)) return null;
  const date = sourceDate ? toDateStr(sourceDate) : toDateStr(stopA.scheduled_date || stopB.scheduled_date);
  if (!date) return null;
  const seq = physicalStops([stopA, stopB]);
  if (seq.length !== 2) return null;
  if (!seq[0].geo || !seq[1].geo) return null;
  const driveMinutes = round2(chainDriveMinutes([seq[0].geo, seq[1].geo], home));
  const firstDepMin = homeDepartureMin(home, seq[0].geo, seq[0].startMin, vanDepartureMin);
  const firstDurationMin = seq[0].minutes || stopPlanningMinutes(seq[0]);
  const secondDurationMin = seq[1].minutes || stopPlanningMinutes(seq[1]);
  return {
    driveMinutes,
    chain: seq,
    roadLegs: {
      date,
      firstDepMin,
      firstStartMin: seq[0].startMin,
      firstDurationMin,
      secondStartMin: seq[1].startMin,
      secondDurationMin,
      home,
      first: seq[0].geo,
      second: seq[1].geo,
    },
  };
}

function pairCandidateAdmissible({ service, current, currentScore, cand, sc, sourceDate, ctx, config }) {
  if (!cand || cand.past_cap || !moveRules.isDayMove(current, cand)) return false;
  if (toDateStr(cand.date) === sourceDate || moveRules.isSundayDate(cand.date)) return false;
  if (isBounceBackDate(ctx.recentLeftDates, cand.date)) return false;
  if (config.roadCheckEnabled === true && !cand[roadCheck.ROAD_LEGS]) return false;
  return moveRules.ownPreferenceScore(sc) >= moveRules.ownPreferenceScore(currentScore)
    && (Number(sc.technician_score) || 0) >= (Number(currentScore.technician_score) || 0)
    && (Number(sc.workload_score) || 0) >= (Number(currentScore.workload_score) || 0);
}

function filterPairCandidates({ service, current, currentScore, candidates, prefs, ctx, sourceDate, config }) {
  const scoreCtx = { currentTechnicianId: service.technician_id, changeCount: service.auto_dispatch_change_count || 0 };
  const rows = [];
  for (let i = 0; i < (candidates || []).length; i += 1) {
    const cand = candidates[i];
    const sc = scoreAppointmentPlacement(cand, prefs, scoreCtx);
    if (!pairCandidateAdmissible({ service, current, currentScore, cand, sc, sourceDate, ctx, config })) continue;
    const gain = moveRules.moveGain({ service, current, cand, currentScore, candScore: sc });
    rows.push({ cand, sc, gain, index: i, detour: Number(cand.detour_minutes) || 0 });
  }
  rows.sort((a, b) => a.detour - b.detour || b.gain - a.gain || a.index - b.index);
  return rows.slice(0, PAIR_TOP_SLOTS);
}

function homeDepartureMin(home, stopGeo, startMin, vanDepartureMin = SHIFT.startMinutes) {
  const shiftStart = Number.isFinite(vanDepartureMin) ? vanDepartureMin : SHIFT.startMinutes;
  const estOut = Math.round(driveMin(home, stopGeo));
  return startMin >= shiftStart ? Math.max(shiftStart, startMin - estOut) : Math.max(0, startMin - estOut);
}

function disjointRoadEntryFor(located, idx, startMin, home, vanDepartureMin) {
  const durOf = (stop) => stop.minutes || stopPlanningMinutes(stop);
  const atGeo = (i) => (i >= 0 && i < located.length ? located[i].geo : home);
  const prevStop = idx > 0 ? located[idx - 1] : null;
  const nextStop = idx + 1 < located.length ? located[idx + 1] : null;
  const prevDepMin = prevStop && Number.isFinite(prevStop.startMin)
    ? Math.round(prevStop.startMin + durOf(prevStop))
    : homeDepartureMin(home, located[idx].geo, startMin, vanDepartureMin);
  const baseDepMin = prevStop
    ? prevDepMin
    : (nextStop && Number.isFinite(nextStop.startMin)
      ? homeDepartureMin(home, nextStop.geo, nextStop.startMin, vanDepartureMin)
      : prevDepMin);
  return {
    prev: atGeo(idx - 1),
    stop: located[idx].geo,
    next: atGeo(idx + 1),
    startMin,
    prevDepMin,
    baseDepMin,
    durationMin: durOf(located[idx]),
  };
}

function sameDestRoadSpecFor(finalChain, idA, idB, { date, startMinA, startMinB, home, vanDepartureMin = SHIFT.startMinutes }) {
  const located = finalChain.filter((s) => s.geo);
  const idxA = located.findIndex((s) => String(s.id) === String(idA));
  const idxB = located.findIndex((s) => String(s.id) === String(idB));
  if (idxA < 0 || idxB < 0) return null;
  const atGeo = (i) => (i >= 0 && i < located.length ? located[i].geo : home);
  const durOf = (stop) => stop.minutes || stopPlanningMinutes(stop);
  const lo = Math.min(idxA, idxB);
  const hi = Math.max(idxA, idxB);
  if (hi === lo + 1) {
    const firstStartMin = lo === idxA ? startMinA : startMinB;
    const secondStartMin = lo === idxA ? startMinB : startMinA;
    const prevStop = lo > 0 ? located[lo - 1] : null;
    const nextStop = hi + 1 < located.length ? located[hi + 1] : null;
    const prevDepMin = prevStop && Number.isFinite(prevStop.startMin)
      ? Math.round(prevStop.startMin + durOf(prevStop))
      : homeDepartureMin(home, located[lo].geo, firstStartMin, vanDepartureMin);
    const baseDepMin = prevStop
      ? prevDepMin
      : (nextStop && Number.isFinite(nextStop.startMin)
        ? homeDepartureMin(home, nextStop.geo, nextStop.startMin, vanDepartureMin)
        : prevDepMin);
    return {
      date, startMin: firstStartMin,
      adjacent: {
        prev: atGeo(lo - 1), first: located[lo].geo, second: located[hi].geo, next: atGeo(hi + 1),
        prevDepMin,
        baseDepMin,
        firstStartMin,
        firstDurationMin: durOf(located[lo]),
        secondStartMin,
        secondDurationMin: durOf(located[hi]),
      },
    };
  }
  return {
    date, startMin: startMinA,
    disjoint: [
      disjointRoadEntryFor(located, idxA, startMinA, home, vanDepartureMin),
      disjointRoadEntryFor(located, idxB, startMinB, home, vanDepartureMin),
    ],
  };
}

// Build the destination day's raw stop rows AFTER A lands (preserving every
// grouped member row so physicalStops/routeCost/routeOrderCovers keep full
// sibling durations and member IDs without double-collapsing). If A carries
// a certified insertion order that no longer covers destStops, reject (null).
function buildRawDestWithA(destStops, aStop, aCand) {
  const placedA = {
    ...aStop,
    startMin: hhmmToMin(aCand.start_time),
    window_start: aCand.start_time,
    window_end: aCand.end_time || null,
    route_order: null,
  };
  if (Array.isArray(aCand.route_order_ids)) {
    if (!routeOrderCovers(destStops, aCand.route_order_ids)) return null;
    const rank = new Map();
    aCand.route_order_ids.forEach((raw, idx) => {
      const id = raw === '__candidate__' ? String(placedA.id) : String(raw);
      rank.set(id, idx + 1);
    });
    return [...destStops, placedA].map((s) => (
      s && rank.has(String(s.id)) ? { ...s, route_order: rank.get(String(s.id)) } : s
    ));
  }
  return [...destStops, placedA];
}

function jointDestinationMetrics({
  destStops, destHome, aStop, bStop, aCand, bCand, bRouteOrderIds, currentScoreA, currentScoreB, vanDepartureMin,
}) {
  if (!Array.isArray(destStops) || destStops.length === 0) return null;
  const rawDestWithA = buildRawDestWithA(destStops, aStop, aCand);
  if (!rawDestWithA) return null;
  const useRouteOrder = Array.isArray(bRouteOrderIds);
  if (useRouteOrder && !routeOrderCovers(rawDestWithA, bRouteOrderIds)) return null;
  const bUnit = {
    ...bStop,
    startMin: hhmmToMin(bCand.start_time),
    window_start: bCand.start_time,
    window_end: bCand.end_time || null,
    route_order: null,
    insertByTime: useRouteOrder,
    ...(useRouteOrder ? { routeOrderIds: bRouteOrderIds } : {}),
  };
  const costBoth = routeCost(rawDestWithA, bUnit, destHome);
  if (costBoth.routeTimeWithMinutes > 480) return null;
  const combinedWorkload = workloadScoreFor({ route_minutes: costBoth.routeTimeWithMinutes }, destStops.length + 2);
  const minWorkload = Math.max(Number(currentScoreA.workload_score) || 0, Number(currentScoreB.workload_score) || 0);
  if (combinedWorkload < minWorkload) return null;
  const baseDrive = chainDriveMinutes(physicalStops(destStops).map((s) => s.geo), destHome);
  const addedDrive = Math.max(0, round2(costBoth.driveWithMinutes - baseDrive));
  const physWithA = physicalStops(rawDestWithA);
  const finalChain = useRouteOrder
    ? insertByRouteOrder(physWithA, bUnit, bRouteOrderIds)
    : currentOrder([...physWithA, bUnit]);
  const sameDestRoadSpec = sameDestRoadSpecFor(finalChain, aStop.id, bStop.id, {
    date: aCand.date,
    startMinA: hhmmToMin(aCand.start_time),
    startMinB: hhmmToMin(bCand.start_time),
    home: destHome,
    vanDepartureMin,
  });
  return {
    addedDrive,
    combinedRouteMinutes: costBoth.routeTimeWithMinutes,
    sameDestRoadSpec,
    bRouteOrderIds: useRouteOrder ? bRouteOrderIds : null,
  };
}

function rankPairs(pairs, floor) {
  return (pairs || [])
    .filter((p) => p && p.saving >= floor)
    .sort((a, b) => b.saving - a.saving
      || Number(b.sameDest) - Number(a.sameDest)
      || (b.gainA + b.gainB) - (a.gainA + a.gainB)
      || a.index - b.index);
}

function sameDateSouthCompatible(ruleA, ruleB, candA, candB) {
  if (Boolean(ruleA) === Boolean(ruleB)) return true;
  if (candA.date !== candB.date) return true;
  const activeRule = ruleA || ruleB;
  if (!activeRule.techDays) return false;
  return String(candA.technician_id || '') !== String(candB.technician_id || '');
}

function livePairRowsValid(rows, a, b, techId, expectedOrder) {
  if (rows.length !== 2) return null;
  const rowA = rows.find((r) => String(r.id) === String(a.id));
  const rowB = rows.find((r) => String(r.id) === String(b.id));
  if (!rowA || !rowB) return null;
  if ([rowA, rowB].some((r) => !LIVE_PAIR_STATUSES.has(String(r.status)) || r.visit_id != null
    || !r.window_start || String(r.technician_id) !== String(techId))) return null;
  if (!rowA.customer_id || !rowB.customer_id || String(rowA.customer_id) === String(rowB.customer_id)) return null;
  if (String(rowA.customer_id) !== String(a.customer_id) || String(rowB.customer_id) !== String(b.customer_id)) return null;
  const routeOrderA = rowA.route_order ?? null;
  const routeOrderB = rowB.route_order ?? null;
  if (expectedOrder && (routeOrderA !== expectedOrder.routeOrderA || routeOrderB !== expectedOrder.routeOrderB)) return null;
  return { routeOrderA, routeOrderB };
}

function coordKey(geo) {
  return geo && Number.isFinite(geo.lat) && Number.isFinite(geo.lng)
    ? `${geo.lat.toFixed(5)},${geo.lng.toFixed(5)}`
    : '';
}

function routeSignatureOf(rows) {
  return (rows || [])
    .map((r) => [
      String(r.id),
      r.route_order ?? '',
      String(r.window_start || '').slice(0, 5),
      String(r.window_end || '').slice(0, 5),
      r.estimated_duration_minutes ?? '',
      coordKey(r.geo || resolveGeo(r)),
    ].join(':'))
    .sort()
    .join('|');
}

async function loadLiveDaySignature(dbc, techId, date, excludeIds) {
  const rows = await loadDayStopRows(dbc, {
    technicianIds: techId ? [techId] : [],
    dates: [date],
    excludeIds,
  });
  return { count: rows.length, signature: routeSignatureOf(rows) };
}

async function verifyDestinationSignatures(dbc, destExpected, excludeIds) {
  for (const dest of destExpected || []) {
    const live = await loadLiveDaySignature(dbc, dest.techId, dest.date, excludeIds);
    if (live.signature !== dest.signature) return false;
  }
  return true;
}

async function verifyExactTwoStopDay(dbc, entryA, entryB, { expectedOrder = null } = {}) {
  const { service: a } = entryA;
  const { service: b } = entryB;
  const techId = a.technician_id;
  const sourceDate = toDateStr(a.scheduled_date);
  if (!techId || String(techId) !== String(b.technician_id || '') || sourceDate !== toDateStr(b.scheduled_date)) return null;
  if (!a.customer_id || !b.customer_id || String(a.customer_id) === String(b.customer_id)) return null;
  if (a.visit_id || b.visit_id) return null;
  const rows = await dbc('scheduled_services')
    .where({ scheduled_date: sourceDate })
    .where((q) => q.where('technician_id', techId).orWhereNull('technician_id'))
    .whereNotIn('status', NOT_A_ROUTE_STOP_STATUSES)
    .where(bookedVisitOrLiveHold)
    .select('id', 'technician_id', 'customer_id', 'route_order', 'status', 'visit_id', 'window_start');
  const checked = livePairRowsValid(rows, a, b, techId, expectedOrder);
  if (!checked) return null;
  return { techId, sourceDate, ...checked };
}

function stampRouteOrderWithA(rows, syntheticA, aRouteOrderIds) {
  const withA = [...rows, syntheticA];
  if (!Array.isArray(aRouteOrderIds) || !aRouteOrderIds.length) return withA;
  const completedCount = rows.filter((r) => r && r.status === 'completed').length;
  const rank = new Map();
  aRouteOrderIds.forEach((raw, idx) => {
    const id = raw === '__candidate__' ? String(syntheticA.id) : String(raw);
    rank.set(id, completedCount + idx + 1);
  });
  return withA.map((r) => (r && rank.has(String(r.id)) ? { ...r, route_order: rank.get(String(r.id)) } : r));
}

function activeRouteOrderIds(routeOrder, rows, targetId) {
  if (!Array.isArray(routeOrder)) return null;
  const completed = new Set((rows || []).filter((r) => r && r.status === 'completed').map((r) => String(r.id)));
  const active = routeOrder.filter((id) => id === targetId || !completed.has(String(id)));
  return active.map((id) => (id === targetId ? '__candidate__' : String(id)));
}

function syntheticRowFor(service, geo, cand, { planningExempt = false } = {}) {
  return {
    id: service.id,
    customer_id: service.customer_id,
    property_id: service.property_id,
    technician_id: cand.technician_id,
    status: service.status,
    scheduled_date: cand.date,
    window_start: cand.start_time,
    window_end: cand.end_time,
    estimated_duration_minutes: service.estimated_duration_minutes || 60,
    service_type: service.service_type,
    service_id: service.service_id,
    service_key_snapshot: service.service_key_snapshot,
    is_recurring: service.is_recurring,
    is_callback: service.is_callback,
    visit_id: null,
    lat: geo.lat,
    lng: geo.lng,
    route_order: null,
    ...(planningExempt ? { planning_exempt: true } : {}),
  };
}

async function loadSameDestContext(destCache, { destTech, destDate, serviceB, geoB, run, arrivalMode }) {
  const key = techDayKey(destTech, destDate);
  if (destCache.has(key)) return destCache.get(key);
  const durB = serviceB.estimated_duration_minutes || 60;
  const context = await loadArrivalRouteContext({
    date: destDate,
    technicianId: destTech,
    now: run.nowDate,
    preserveCapacity: arrivalMode,
    planningMinutes: !arrivalMode || schedulingPlanMinutesOnly(),
    startPoints: arrivalMode,
    vanDepartureMin: arrivalMode ? run.config.departureMinutes : undefined,
    prospective: {
      lat: geoB.lat,
      lng: geoB.lng,
      estimated_duration_minutes: durB,
      service_type: serviceB.service_type,
      ...(serviceB.is_recurring === true ? { is_recurring: true } : {}),
      ...(serviceB.is_callback === true ? { is_callback: true } : {}),
    },
  });
  const shiftOf = await loadTechShifts(db, { technicianIds: [destTech], now: run.nowDate });
  const shift = shiftOf(destTech, destDate);
  const shiftEndMin = shift && shift.endMin != null ? shiftBounds(shift, SHIFT.startMinutes, SHIFT.endMinutes).closeMin : undefined;
  const entry = { context, shiftEndMin };
  destCache.set(key, entry);
  return entry;
}

function usesArrivalRouting(config) {
  return Boolean(capacityEnabled() || (config && config.arrivalSearch === 'true'));
}

async function checkSameDestArrival({ destCache, serviceA, geoA, serviceB, geoB, aCand, bCand, run }) {
  if (!usesArrivalRouting(run.config)) return { ok: true, bRouteOrderIds: null };
  const arrivalMode = run.config.arrivalSearch === 'true';
  const { context, shiftEndMin } = await loadSameDestContext(destCache, {
    destTech: aCand.technician_id, destDate: aCand.date, serviceB, geoB, run, arrivalMode,
  });
  if (!context) return { ok: false, bRouteOrderIds: null };
  const synA = syntheticRowFor(serviceA, geoA, aCand, { planningExempt: arrivalMode && !schedulingPlanMinutesOnly() });
  const contextWithA = { ...context, rows: stampRouteOrderWithA(context.rows, synA, aCand.route_order_ids) };
  const canInsert = arrivalMode && canPlaceInRoute([]) && !hasInsertionIncompatibleRow(contextWithA);
  const fit = evaluateArrivalPlacement(contextWithA, {
    windowStart: bCand.start_time,
    windowEnd: bCand.end_time,
    durationMinutes: serviceB.estimated_duration_minutes || 60,
    bufferMinutes: 0,
    allowInsertion: canInsert,
    insertionMargin: canInsert,
    preserveExistingOrder: true,
    ...(shiftEndMin != null ? { shiftEndMin } : {}),
  });
  if (!fit || !fit.feasible) return { ok: false, bRouteOrderIds: null };
  const bRouteOrderIds = canInsert ? activeRouteOrderIds(fit.routeOrder, contextWithA.rows, contextWithA.target.id) : null;
  return { ok: true, bRouteOrderIds };
}

function occupiedOverlapCheck(serviceA, serviceB, aCand, bCand, occupiedByDate) {
  const planA = planUnitPlacement(serviceA, { members: [serviceA], visitWindowStart: null }, aCand);
  const planB = planUnitPlacement(serviceB, { members: [serviceB], visitWindowStart: null }, bCand);
  const extra = (planA ? planA.windows : []).map((w) => ({
    startMin: hhmmToMin(w.start), endMin: hhmmToMin(w.end),
  }));
  const occupied = [...(occupiedByDate.get(aCand.date) || []), ...extra];
  return !slotTaken(planB, occupied);
}

function sharedDatesOf(topA, topB) {
  const bDates = new Set(topB.map((q) => q.cand.date));
  return [...new Set(topA.map((r) => r.cand.date).filter((d) => bDates.has(d)))];
}

function pairNeedsOverlapCheck(aCand, bCand, sameDest) {
  return aCand.date === bCand.date && (sameDest || !multiTechConfirmLive());
}

async function evaluatePairCombinations({
  entryA, entryB, topA, topB, currentScoreA, currentScoreB, sourceInfo, ruleA, ruleB, run,
}) {
  const a = entryA.service;
  const b = entryB.service;
  const geoA = resolveGeo(a);
  const geoB = resolveGeo(b);
  const sameDates = sharedDatesOf(topA, topB);
  const allDestDates = [...new Set([...topA, ...topB].map((r) => r.cand.date).filter(Boolean))];
  const allDestTechs = [...new Set([...topA, ...topB].map((r) => r.cand.technician_id).filter(Boolean))];
  const excludeIds = new Set([String(a.id), String(b.id)]);
  const [occupiedByDate, dayStopRows] = await Promise.all([
    sameDates.length ? loadOccupiedSpansByDate(db, sameDates, excludeIds) : Promise.resolve(new Map()),
    allDestDates.length ? loadDayStopRows(db, { technicianIds: allDestTechs, dates: allDestDates, excludeIds }) : Promise.resolve([]),
  ]);
  await loadStartPoints(entryA.ctx, allDestTechs);
  const destCache = new Map();
  const aStop = serviceToRouteStop(a, geoA, hhmmToMin(a.window_start), [], null, false, null);
  const bStop = serviceToRouteStop(b, geoB, hhmmToMin(b.window_start), [], null, false, null);
  const pairs = [];
  let idx = 0;

  for (const aRow of topA) {
    for (const bRow of topB) {
      idx += 1;
      if (!sameDateSouthCompatible(ruleA, ruleB, aRow.cand, bRow.cand)) continue;
      const sameDest = aRow.cand.date === bRow.cand.date
        && String(aRow.cand.technician_id || '') === String(bRow.cand.technician_id || '');
      if (pairNeedsOverlapCheck(aRow.cand, bRow.cand, sameDest)
        && !occupiedOverlapCheck(a, b, aRow.cand, bRow.cand, occupiedByDate)) continue;
      if (!sameDest) {
        const destStopsA = stopsForTechDay(dayStopRows, aRow.cand.technician_id, aRow.cand.date);
        const destStopsB = stopsForTechDay(dayStopRows, bRow.cand.technician_id, bRow.cand.date);
        if (!destStopsA.length || !destStopsB.length) continue;
        const addedDrive = round2(aRow.detour + bRow.detour);
        pairs.push({
          sameDest: false,
          slotA: aRow.cand,
          slotB: bRow.cand,
          scoreA: aRow.sc,
          scoreB: bRow.sc,
          gainA: aRow.gain,
          gainB: bRow.gain,
          sourceDrive: sourceInfo.driveMinutes,
          addedDrive,
          saving: round2(sourceInfo.driveMinutes - addedDrive),
          sameDestRoadSpec: null,
          destExpected: [
            { techId: aRow.cand.technician_id, date: aRow.cand.date, signature: routeSignatureOf(destStopsA) },
            { techId: bRow.cand.technician_id, date: bRow.cand.date, signature: routeSignatureOf(destStopsB) },
          ],
          index: idx,
        });
        continue;
      }
      const destStops = stopsForTechDay(dayStopRows, aRow.cand.technician_id, aRow.cand.date);
      if (!destStops.length) continue;
      const arrival = await checkSameDestArrival({
        destCache, serviceA: a, geoA, serviceB: b, geoB, aCand: aRow.cand, bCand: bRow.cand, run,
      });
      if (!arrival.ok) continue;
      const destHome = homeFor(entryA.ctx, aRow.cand.technician_id);
      const joint = jointDestinationMetrics({
        destStops, destHome, aStop, bStop, aCand: aRow.cand, bCand: bRow.cand,
        bRouteOrderIds: arrival.bRouteOrderIds, currentScoreA, currentScoreB,
        vanDepartureMin: run.config.departureMinutes,
      });
      if (!joint) continue;
      const { route_order_ids: _preAOrder, ...bCandBase } = bRow.cand;
      const slotB = joint.bRouteOrderIds ? { ...bCandBase, route_order_ids: joint.bRouteOrderIds } : bCandBase;
      pairs.push({
        sameDest: true,
        slotA: aRow.cand,
        slotB,
        scoreA: aRow.sc,
        scoreB: bRow.sc,
        gainA: aRow.gain,
        gainB: bRow.gain,
        sourceDrive: sourceInfo.driveMinutes,
        addedDrive: joint.addedDrive,
        saving: round2(sourceInfo.driveMinutes - joint.addedDrive),
        sameDestRoadSpec: joint.sameDestRoadSpec,
        destExpected: [{ techId: aRow.cand.technician_id, date: aRow.cand.date, signature: routeSignatureOf(destStops) }],
        index: idx,
      });
    }
  }
  return pairs;
}

function pairConstraintNote(partner, sourceDate, pair, floor, road) {
  return {
    two_stop_pair_clear: {
      partner_service_id: String(partner.id),
      source_date: sourceDate,
      source_drive_minutes: road ? road.source_drive_minutes : pair.sourceDrive,
      added_drive_minutes: road ? road.added_drive_minutes : pair.addedDrive,
      pair_drive_saving_minutes: road ? road.saving_minutes : pair.saving,
      floor_minutes: floor,
      same_destination_day: pair.sameDest,
      road_source: road ? 'google' : 'estimate',
    },
  };
}

async function proofreadBoth(entryA, entryB, slotA, slotB, meta, run, helpers) {
  const checkedA = await helpers.checkProofreader(entryA, slotA, meta.auditA, run);
  if (checkedA && !checkedA.ok) return { ok: false };
  const checkedB = await helpers.checkProofreader(entryB, slotB, meta.auditB, run);
  if (checkedB && !checkedB.ok) return { ok: false };
  const [changedA, changedB] = await Promise.all([
    helpers.preferencesChanged(entryA),
    helpers.preferencesChanged(entryB),
  ]);
  if (changedA || changedB) {
    if (typeof helpers.logPairSuperseded === 'function') {
      if (changedA) await helpers.logPairSuperseded(entryA, meta.auditA, checkedA ? checkedA.checked : null, run);
      if (changedB) await helpers.logPairSuperseded(entryB, meta.auditB, checkedB ? checkedB.checked : null, run);
    }
    return { ok: false };
  }
  return { ok: true, checkedA: checkedA ? checkedA.checked : null, checkedB: checkedB ? checkedB.checked : null };
}

function buildPairEval({ service, current, currentScore, best, bestScore, threshold, prefs, ctx, lockBoundary, helpers, pairNote }) {
  const built = helpers.buildPlacementAudit({
    current, currentScore, candidate: best, candidateScore: bestScore, service, prefs, lockBoundary, ctx, threshold,
  });
  return {
    kind: 'move',
    improvement: built.improvement,
    best,
    rankedCandidates: [best],
    current,
    currentScore,
    threshold,
    audit: {
      newPlacement: built.newPlacement,
      scores: built.scores,
      prefsSnapshot: prefs.raw_snapshot,
      routeMetrics: built.routeMetrics,
      constraints: { ...built.constraints, ...pairNote },
    },
  };
}

function thresholdFor(service, config) {
  return (service.auto_dispatch_change_count || 0) > 0
    ? Math.max(config.minScoreImprovement, config.removeStabilityFloor)
    : config.minScoreImprovement;
}

async function findConfirmedPair(entryA, entryB, verified, run) {
  const { config } = run;
  const floor = pairClearFloor(entryA.service, entryB.service, config);
  if (floor <= 0) return null;
  const ctxA = { ...entryA.ctx, roadTravel: null };
  const ctxB = { ...entryB.ctx, roadTravel: null };
  const [resA, resB, ruleA, ruleB] = await Promise.all([
    candidateSlots.findValidCandidateSlots(entryA.service, entryA.prefs, ctxA),
    candidateSlots.findValidCandidateSlots(entryB.service, entryB.prefs, ctxB),
    southDayKept.ruleFor(entryA.service, ctxA),
    southDayKept.ruleFor(entryB.service, ctxB),
  ]);
  if (!resA.current || !resB.current || resA.current.conflict || resB.current.conflict) return null;
  if (resA.current.detour_group_blind || resB.current.detour_group_blind) return null;
  if (!resA.candidates.length || !resB.candidates.length) return null;

  await loadStartPoints(ctxA, [verified.techId]);
  const sourceHome = homeFor(ctxA, verified.techId);
  const sourceInfo = pairSourceDrive(
    serviceToRouteStop(entryA.service, resolveGeo(entryA.service), hhmmToMin(entryA.service.window_start), [], verified.routeOrderA, false, null),
    serviceToRouteStop(entryB.service, resolveGeo(entryB.service), hhmmToMin(entryB.service.window_start), [], verified.routeOrderB, false, null),
    sourceHome,
    verified.sourceDate,
    config.departureMinutes,
  );
  if (!sourceInfo) return null;

  const currentScoreA = scoreAppointmentPlacement(resA.current, entryA.prefs, {
    currentTechnicianId: entryA.service.technician_id, changeCount: entryA.service.auto_dispatch_change_count || 0,
  });
  const currentScoreB = scoreAppointmentPlacement(resB.current, entryB.prefs, {
    currentTechnicianId: entryB.service.technician_id, changeCount: entryB.service.auto_dispatch_change_count || 0,
  });
  const topA = filterPairCandidates({
    service: entryA.service, current: resA.current, currentScore: currentScoreA,
    candidates: resA.candidates, prefs: entryA.prefs, ctx: ctxA, sourceDate: verified.sourceDate, config,
  });
  const topB = filterPairCandidates({
    service: entryB.service, current: resB.current, currentScore: currentScoreB,
    candidates: resB.candidates, prefs: entryB.prefs, ctx: ctxB, sourceDate: verified.sourceDate, config,
  });
  if (!topA.length || !topB.length) return null;

  const allPairs = await evaluatePairCombinations({
    entryA: { ...entryA, ctx: ctxA }, entryB: { ...entryB, ctx: ctxB },
    topA, topB, currentScoreA, currentScoreB, sourceInfo, ruleA, ruleB, run,
  });
  const qualifying = rankPairs(allPairs, floor);
  if (!qualifying.length) return null;

  const confirmed = await roadCheck.confirmPairOnRoads(qualifying, {
    sourceLegs: sourceInfo.roadLegs, floor, config, travel: run.roadTravel,
  });
  if (!confirmed || !confirmed.pair.destExpected) return null;
  return {
    ...confirmed, floor, ctxA, ctxB, curA: resA.current, curB: resB.current, currentScoreA, currentScoreB, destExpected: confirmed.pair.destExpected,
  };
}

async function tryClearOneTwoStopDay(entryA, entryB, run, helpers) {
  const { config } = run;
  const verified = await verifyExactTwoStopDay(db, entryA, entryB);
  if (!verified) return false;
  if (!(await helpers.recheckPairEntry(entryA, run)) || !(await helpers.recheckPairEntry(entryB, run))) return false;
  const found = await findConfirmedPair(entryA, entryB, verified, run);
  if (!found) return false;
  const {
    pair, road, floor, ctxA, ctxB, curA, curB, currentScoreA, currentScoreB, destExpected,
  } = found;

  const evalA = buildPairEval({
    service: entryA.service, current: curA, currentScore: currentScoreA,
    best: pair.slotA, bestScore: pair.scoreA, threshold: thresholdFor(entryA.service, config),
    prefs: entryA.prefs, ctx: ctxA, lockBoundary: run.lockBoundary, helpers,
    pairNote: pairConstraintNote(entryB.service, verified.sourceDate, pair, floor, road),
  });
  const evalB = buildPairEval({
    service: entryB.service, current: curB, currentScore: currentScoreB,
    best: pair.slotB, bestScore: pair.scoreB, threshold: thresholdFor(entryB.service, config),
    prefs: entryB.prefs, ctx: ctxB, lockBoundary: run.lockBoundary, helpers,
    pairNote: pairConstraintNote(entryA.service, verified.sourceDate, pair, floor, road),
  });

  if (config.mode === 'dry_run') {
    run.claimedPairIds.add(String(entryA.service.id));
    run.claimedPairIds.add(String(entryB.service.id));
    await helpers.logDryRunPair(entryA.service, evalA, pair, road, run);
    await helpers.logDryRunPair(entryB.service, evalB, pair, road, run);
    return true;
  }

  const proof = await proofreadBoth(entryA, entryB, pair.slotA, pair.slotB, { auditA: evalA.audit, auditB: evalB.audit }, run, helpers);
  if (!proof.ok) return false;

  const expectedOrder = { routeOrderA: verified.routeOrderA, routeOrderB: verified.routeOrderB };
  const excludeIds = new Set([String(entryA.service.id), String(entryB.service.id)]);
  return helpers.commitAtomicPair({
    entryA,
    evalA,
    checkedA: proof.checkedA,
    entryB,
    evalB,
    checkedB: proof.checkedB,
    sourceTechId: verified.techId,
    sourceDate: verified.sourceDate,
    verifySourceInTrx: async (trx) => Boolean(
      await verifyExactTwoStopDay(trx, entryA, entryB, { expectedOrder })
      && await verifyDestinationSignatures(trx, destExpected, excludeIds),
    ),
    run,
  });
}

function groupCandidateBuckets(pairEligible, quarantinedIds) {
  const buckets = new Map();
  for (const entry of pairEligible.values()) {
    if (quarantinedIds.has(String(entry.service.id))) continue;
    const key = techDayKey(entry.service.technician_id, entry.service.scheduled_date);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(entry);
  }
  return [...buckets.entries()]
    .filter(([, list]) => list.length === 2)
    .sort(([k1], [k2]) => k1.localeCompare(k2))
    .slice(0, MAX_PAIR_DAYS_PER_RUN);
}

async function runTwoStopClearPass(run, helpers) {
  if (!isEnabled(run.config) || !run.pairEligible || run.pairEligible.size < 2) return 0;
  const buckets = groupCandidateBuckets(run.pairEligible, run.quarantinedIds);
  let cleared = 0;
  for (const [, [entryA, entryB]] of buckets) {
    if (run.config.mode === 'apply' && run.totals.changed + 2 > run.config.maxChangesPerRun) break;
    try {
      if (await tryClearOneTwoStopDay(entryA, entryB, run, helpers)) cleared += 1;
    } catch (err) {
      run.guardReadDegraded = true;
      logger.error(`[auto-dispatch] two-stop pair clear failed for ${toDateStr(entryA.service.scheduled_date)}: ${err.message}`);
      if (typeof helpers.recordPairError === 'function') {
        await helpers.recordPairError(entryA, entryB, err, run);
      }
    }
  }
  return cleared;
}

module.exports = {
  isEnabled,
  isEligibleEntry,
  pairClearFloor,
  runTwoStopClearPass,
  _internals: {
    PAIR_TOP_SLOTS,
    pairSourceDrive,
    filterPairCandidates,
    jointDestinationMetrics,
    sameDestRoadSpecFor,
    rankPairs,
    sameDateSouthCompatible,
    pairNeedsOverlapCheck,
    usesArrivalRouting,
    livePairRowsValid,
    stampRouteOrderWithA,
    groupCandidateBuckets,
  },
};
