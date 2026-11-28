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
 *     completed/in-progress/one-time/locked stops on that date).
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
const { autoDispatchSharedModelLive, schedulingPlanMinutesOnly } = require('../../config/feature-gates');
const { NOT_A_ROUTE_STOP_STATUSES } = require('../stops-ahead');
const { bookedVisitOrLiveHold } = require('../scheduling/reservation-occupancy');
const { loadArrivalRouteContext, evaluateArrivalPlacement, hasInsertionIncompatibleRow } = require('../scheduling/arrival-route');
const { loadTechShifts, shiftBounds } = require('../technician-eligibility');
const { SHIFT } = require('../scheduling/policy');
const { toDateStr } = require('./dates');
const { HQ, resolveGeo } = require('./geo');
const { scoreAppointmentPlacement, _internals: { workloadScoreFor, hhmmToMin } } = require('./scoring');
const moveRules = require('./move-rules');
const { isBounceBackDate } = require('./bounce-guard');
const {
  physicalStops, chainDriveMinutes, routeCost, routeOrderCovers,
  _internals: { insertByRouteOrder, insertByWindow },
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
  const minFloor = 2 * (Number(config.minDayMoveDriveSavingMinutes) || 0);
  const minRule = moveRules.minutesRuleFloor(serviceA, config) + moveRules.minutesRuleFloor(serviceB, config);
  return Math.max(minFloor, minRule);
}

function isEnabled(config) {
  if (!autoDispatchSharedModelLive() || !config) return false;
  return pairClearFloor({}, {}, config) > 0;
}

function isEligibleEntry(service, evalResult) {
  return Boolean(service && evalResult && evalResult.kind === 'no_change'
    && !evalResult.conflict && !service.visit_id && service.window_start && service.technician_id);
}

function techDayKey(techId, date) {
  return `${String(techId)}|${toDateStr(date)}`;
}

// Pure source-day drive for two standalone stops on one tech-day.
function pairSourceDrive(stopA, stopB, home = HQ) {
  if (!stopA || !stopB) return null;
  if (stopA.customer_id && stopB.customer_id && String(stopA.customer_id) === String(stopB.customer_id)) return null;
  const seq = physicalStops([stopA, stopB]);
  if (seq.length !== 2) return null;
  if (!seq[0].geo || !seq[1].geo) return null;
  const driveMinutes = round2(chainDriveMinutes([seq[0].geo, seq[1].geo], home));
  return {
    driveMinutes,
    chain: seq,
    roadLegs: {
      date: toDateStr(seq[0].scheduled_date || stopA.scheduled_date),
      startMin: seq[0].startMin,
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

function sameDestRoadSpecFor(finalChain, idA, idB, { date, startMinA, startMinB, home }) {
  const located = finalChain.filter((s) => s.geo);
  const idxA = located.findIndex((s) => String(s.id) === String(idA));
  const idxB = located.findIndex((s) => String(s.id) === String(idB));
  if (idxA < 0 || idxB < 0) return null;
  const atGeo = (i) => (i >= 0 && i < located.length ? located[i].geo : home);
  const lo = Math.min(idxA, idxB);
  const hi = Math.max(idxA, idxB);
  if (hi === lo + 1) {
    const firstStart = lo === idxA ? startMinA : startMinB;
    return {
      date, startMin: firstStart,
      adjacent: { prev: atGeo(lo - 1), first: located[lo].geo, second: located[hi].geo, next: atGeo(hi + 1) },
    };
  }
  return {
    date, startMin: startMinA,
    disjoint: [
      { prev: atGeo(idxA - 1), stop: located[idxA].geo, next: atGeo(idxA + 1), startMin: startMinA },
      { prev: atGeo(idxB - 1), stop: located[idxB].geo, next: atGeo(idxB + 1), startMin: startMinB },
    ],
  };
}

function buildDestWithA(destStops, aStop, aCand) {
  const baseSeq = physicalStops(destStops);
  const placedA = { ...aStop, startMin: hhmmToMin(aCand.start_time), route_order: null };
  const merged = Array.isArray(aCand.route_order_ids) && routeOrderCovers(destStops, aCand.route_order_ids)
    ? insertByRouteOrder(baseSeq, placedA, aCand.route_order_ids)
    : insertByWindow(baseSeq, placedA);
  return merged.map((s, idx) => ({ ...s, route_order: idx + 1 }));
}

function jointDestinationMetrics({
  destStops, destHome, aStop, bStop, aCand, bCand, bRouteOrderIds, currentScoreA, currentScoreB,
}) {
  if (!Array.isArray(destStops) || destStops.length === 0) return null;
  const destWithA = buildDestWithA(destStops, aStop, aCand);
  const useRouteOrder = Array.isArray(bRouteOrderIds) && routeOrderCovers(destWithA, bRouteOrderIds);
  const bUnit = {
    ...bStop,
    startMin: hhmmToMin(bCand.start_time),
    route_order: null,
    insertByTime: true,
    ...(useRouteOrder ? { routeOrderIds: bRouteOrderIds } : {}),
  };
  const costBoth = routeCost(destWithA, bUnit, destHome);
  const combinedWorkload = workloadScoreFor({ route_minutes: costBoth.routeTimeWithMinutes }, destStops.length + 2);
  const minWorkload = Math.max(Number(currentScoreA.workload_score) || 0, Number(currentScoreB.workload_score) || 0);
  if (combinedWorkload < minWorkload) return null;
  const baseDrive = chainDriveMinutes(physicalStops(destStops).map((s) => s.geo), destHome);
  const addedDrive = Math.max(0, round2(costBoth.driveWithMinutes - baseDrive));
  const finalChain = useRouteOrder
    ? insertByRouteOrder(destWithA, bUnit, bRouteOrderIds)
    : insertByWindow(destWithA, bUnit);
  const sameDestRoadSpec = sameDestRoadSpecFor(finalChain, aStop.id, bStop.id, {
    date: aCand.date,
    startMinA: hhmmToMin(aCand.start_time),
    startMinB: hhmmToMin(bCand.start_time),
    home: destHome,
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

async function verifyExactTwoStopDay(dbc, entryA, entryB) {
  const { service: a } = entryA;
  const { service: b } = entryB;
  const techId = a.technician_id;
  const sourceDate = toDateStr(a.scheduled_date);
  if (!techId || String(techId) !== String(b.technician_id || '') || sourceDate !== toDateStr(b.scheduled_date)) return null;
  if (String(a.customer_id) === String(b.customer_id)) return null;
  if (a.visit_id || b.visit_id) return null;
  const rows = await dbc('scheduled_services')
    .where({ scheduled_date: sourceDate })
    .where((q) => q.where('technician_id', techId).orWhereNull('technician_id'))
    .whereNotIn('status', NOT_A_ROUTE_STOP_STATUSES)
    .where(bookedVisitOrLiveHold)
    .select('id', 'technician_id', 'status', 'visit_id', 'window_start');
  if (rows.length !== 2) return null;
  const ids = new Set(rows.map((r) => String(r.id)));
  if (!ids.has(String(a.id)) || !ids.has(String(b.id))) return null;
  if (rows.some((r) => !LIVE_PAIR_STATUSES.has(String(r.status)) || r.visit_id != null || !r.window_start || String(r.technician_id) !== String(techId))) {
    return null;
  }
  return { techId, sourceDate };
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

function syntheticRowFor(service, geo, cand) {
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
  };
}

async function loadSameDestContext(destCache, { destTech, destDate, serviceB, geoB, run }) {
  const key = techDayKey(destTech, destDate);
  if (destCache.has(key)) return destCache.get(key);
  const durB = serviceB.estimated_duration_minutes || 60;
  const context = await loadArrivalRouteContext({
    date: destDate,
    technicianId: destTech,
    now: run.nowDate,
    preserveCapacity: true,
    planningMinutes: schedulingPlanMinutesOnly(),
    startPoints: true,
    vanDepartureMin: run.config.departureMinutes,
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

async function checkSameDestArrival({ destCache, serviceA, geoA, serviceB, geoB, aCand, bCand, run }) {
  if (run.config.arrivalSearch !== 'true') return { ok: true, bRouteOrderIds: null };
  const { context, shiftEndMin } = await loadSameDestContext(destCache, {
    destTech: aCand.technician_id, destDate: aCand.date, serviceB, geoB, run,
  });
  if (!context) return { ok: false, bRouteOrderIds: null };
  const synA = syntheticRowFor(serviceA, geoA, aCand);
  const contextWithA = { ...context, rows: stampRouteOrderWithA(context.rows, synA, aCand.route_order_ids) };
  const canInsert = canPlaceInRoute([]) && !hasInsertionIncompatibleRow(contextWithA);
  const fit = evaluateArrivalPlacement(contextWithA, {
    windowStart: bCand.start_time,
    windowEnd: bCand.end_time,
    durationMinutes: serviceB.estimated_duration_minutes || 60,
    bufferMinutes: 0,
    allowInsertion: canInsert,
    insertionMargin: canInsert,
    preserveExistingOrder: canInsert,
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

async function evaluatePairCombinations({
  entryA, entryB, topA, topB, currentScoreA, currentScoreB, sourceInfo, ruleA, ruleB, run,
}) {
  const a = entryA.service;
  const b = entryB.service;
  const geoA = resolveGeo(a);
  const geoB = resolveGeo(b);
  const sameDates = [...new Set(topA.filter((r) => topB.some((q) => q.cand.date === r.cand.date && String(q.cand.technician_id) === String(r.cand.technician_id))).map((r) => r.cand.date))];
  const sameTechs = [...new Set(topA.map((r) => r.cand.technician_id).filter(Boolean))];
  const excludeIds = new Set([String(a.id), String(b.id)]);
  const [occupiedByDate, dayStopRows] = sameDates.length
    ? await Promise.all([
      loadOccupiedSpansByDate(db, sameDates, excludeIds),
      loadDayStopRows(db, { technicianIds: sameTechs, dates: sameDates, excludeIds }),
    ])
    : [new Map(), []];
  await loadStartPoints(entryA.ctx, sameTechs);
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
      if (!sameDest) {
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
          index: idx,
        });
        continue;
      }
      if (!occupiedOverlapCheck(a, b, aRow.cand, bRow.cand, occupiedByDate)) continue;
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
      });
      if (!joint) continue;
      const slotB = joint.bRouteOrderIds ? { ...bRow.cand, route_order_ids: joint.bRouteOrderIds } : bRow.cand;
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
  if (checkedA && await helpers.preferencesChanged(entryA)) return { ok: false };
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
    serviceToRouteStop(entryA.service, resolveGeo(entryA.service), hhmmToMin(entryA.service.window_start), [], entryA.service.route_order, false, null),
    serviceToRouteStop(entryB.service, resolveGeo(entryB.service), hhmmToMin(entryB.service.window_start), [], entryB.service.route_order, false, null),
    sourceHome,
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
  if (!confirmed) return null;
  return {
    ...confirmed, floor, ctxA, ctxB, curA: resA.current, curB: resB.current, currentScoreA, currentScoreB,
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
    pair, road, floor, ctxA, ctxB, curA, curB, currentScoreA, currentScoreB,
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

  if (!(await verifyExactTwoStopDay(db, entryA, entryB))) return false;
  const firstOk = await helpers.commitPairMove(entryA, evalA, proof.checkedA, run);
  if (!firstOk) return false;
  run.claimedPairIds.add(String(entryA.service.id));

  const secondOk = await helpers.commitPairMove(entryB, evalB, proof.checkedB, run);
  if (secondOk) run.claimedPairIds.add(String(entryB.service.id));
  return firstOk && secondOk;
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
      logger.warn(`[auto-dispatch] two-stop pair clear skipped for ${toDateStr(entryA.service.scheduled_date)}: ${err.message}`);
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
    stampRouteOrderWithA,
    groupCandidateBuckets,
  },
};
