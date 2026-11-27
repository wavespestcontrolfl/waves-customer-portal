/**
 * ROAD CHECK — the drive floor, asked again on real roads.
 *
 * Owner 2026-10-09 ("drive time yes"): auto-dispatch scores every slot on a
 * straight-line model (route-model.js). The model decides which slots are
 * worth a look; before a visit moves for a drive saving, the saving is
 * measured again on Google's traffic-aware route matrix, at the hour of each
 * placement. A move whose real-road saving is under
 * config.minDayMoveDriveSavingMinutes does not happen.
 *
 * What is priced: the three legs the model's own detour is made of
 * (route-model.js routeCost `neighbours`), for the slot the visit has now
 * and for the slot it would take: stop before -> visit, visit -> stop after,
 * and the drive the van makes anyway (before -> after). Detour = in + out -
 * base, on both days.
 *
 * Only an ordinary move is checked. A visit that cannot stay where it is (no
 * arrival time yet, or in conflict) is not: it has to move, and its drive
 * ceiling stays on the model.
 *
 * The check can only stop a move, never cause one. A placement whose legs do
 * not ALL come back from Google keeps the model's answer (`source:
 * 'estimate'`), so an outage or a spent allowance changes nothing.
 *
 * Spend is bounded per run: one travel object for the whole run (it keeps
 * every answer, so pass 2 re-asks nothing), slots measured one at a time and
 * at most ROAD_CHECK_SLOTS for a visit (six legs when the best slot passes),
 * config.roadCheckMaxElements legs in all, and a budget of its own so it
 * never draws on customer booking's.
 *
 * Behind GATE_AUTO_DISPATCH_ROAD_CHECK (config.roadCheckEnabled).
 */
const logger = require('../logger');

// The legs of one placement, carried on the placement object under a symbol
// so they never reach an audit row or a JSON body.
const ROAD_LEGS = Symbol('autoDispatchRoadLegs');
// The road answer for a slot, carried the same way to the audit builder.
const ROAD_RESULT = Symbol('autoDispatchRoadResult');

const ROAD_CHECK_SLOTS = 3;
const RUN_DEADLINE_MS = 20 * 60 * 1000;
// This run's own allowance window (route-optimizer resets it every 15 min);
// the per-run element cap below is the real bound.
const roadCheckBudget = { resetAt: 0, requests: 0, elements: 0, maxRequests: 2000, maxElements: 2000 };

function round2(v) { return Math.round(v * 100) / 100; }

// candidate-slots.js: the legs of a placement scored on the shared model.
function roadLegsOf(cost, date, startMin) {
  if (!cost || !cost.neighbours || !Number.isFinite(startMin)) return null;
  return { ...cost.neighbours, date: String(date), startMin };
}

function createRunTravel(config, { travelFactory } = {}) {
  if (travelFactory) return travelFactory();
  const RouteOptimizer = require('../route-optimizer');
  const maxElements = config.roadCheckMaxElements;
  return RouteOptimizer.createSchedulingTravel({
    maxRequests: maxElements, maxElements, budgetMs: RUN_DEADLINE_MS, sharedBudget: roadCheckBudget,
  });
}

// Owner 2026-10-28, Google cost "way too high": pass 1 would price every
// qualifying visit, but the per-run change cap then holds most of them (10-27:
// 44 moves checked, 34 held). So in apply mode only pass 2 asks Google, for a
// move about to be written. Needs the road check itself on; a dry run asks in
// pass 1.
function deferredToApply(config) {
  return config.roadCheckEnabled === true && config.mode === 'apply';
}

// The reader a pass 1 evaluation gets (null = the model alone).
function pass1Travel(config, travel) {
  return deferredToApply(config) ? null : travel;
}

function legsFor(place) {
  const g = place && place[ROAD_LEGS];
  if (!g) return null;
  // One departure for the three legs: the traffic at the hour of the visit.
  const leg = (from, to) => ({ date: g.date, from, to, departureMin: g.startMin });
  return [leg(g.prev, g.stop), leg(g.stop, g.next), leg(g.prev, g.next)];
}

// Real-road detour of one placement, or null when Google did not answer
// every leg.
async function roadDetour(place, travel) {
  const legs = legsFor(place);
  if (!legs) return null;
  await travel.preload(legs);
  const minutes = legs.map((leg) => travel.lookup(leg)).map((a) => (a && a.source === 'google_traffic' && Number.isFinite(a.minutes) ? a.minutes : null));
  if (minutes.some((m) => m == null)) return null;
  return Math.max(0, minutes[0] + minutes[1] - minutes[2]);
}

// { saving_minutes, current_detour_minutes, candidate_detour_minutes, source }
// or null when either side has no road answer.
async function roadSaving(current, cand, travel) {
  const now = await roadDetour(current, travel);
  if (now == null) return null;
  const then = await roadDetour(cand, travel);
  if (then == null) return null;
  return {
    saving_minutes: round2(now - then), current_detour_minutes: now, candidate_detour_minutes: then, source: 'google',
  };
}

// The check can measure this visit at all: gate on, a floor to hold, and a
// current placement whose drive the model can see.
function measurable({ current, config, travel }) {
  return !!(config.roadCheckEnabled && travel && (config.minDayMoveDriveSavingMinutes || 0) > 0 && !current.detour_group_blind);
}

// A visit in conflict moves whatever the roads say (its repair is exempt).
// The ordinary move it would make once the conflict is gone (`normalBest`,
// the dry run's "after the overlapping visit moves" row) is held to the
// floor on real roads like any other ordinary move: failing it, the visit
// has no such move (Codex #6264 r2).
// A nonpositive-gain minutes-rule move (admitted when synthetic score drops due
// to continuity/stability/cluster dilution) MUST have real Google road
// confirmation; never commit it on an unconfirmed straight-line estimate alone.
function needsConfirmedRoad(row) {
  return Boolean(row && row.byMinutes && !(row.gain > 0));
}

function dropNormalBest(ranked) {
  const { normalBest: _slot, normalBestScore: _score, ...rest } = ranked;
  return rest;
}

function projectionRows(ranked) {
  if (Array.isArray(ranked.normalRankedRows) && ranked.normalRankedRows.length) return ranked.normalRankedRows;
  return [{
    cand: ranked.normalBest,
    sc: ranked.normalBestScore,
    gain: ranked.normalBestNeedsRoad ? 0 : 1,
    byMinutes: Boolean(ranked.normalBestMinutesFloor || ranked.normalBestNeedsRoad),
  }];
}

function projectionFloor(row, floor, ranked, ctx) {
  if (!row.byMinutes) return floor;
  const moveRules = require('./move-rules');
  return Math.max(floor, ranked.normalBestMinutesFloor || 0, moveRules.minutesRuleFloor(ctx.service, ctx.config));
}

async function withProjectionChecked(ranked, ctx) {
  if (!ranked.normalBest) return ranked;
  const moveRules = require('./move-rules');
  const floor = ctx.config.minDayMoveDriveSavingMinutes || 0;
  const toCheck = slotsToMeasure(projectionRows(ranked), moveRules.isSundayDate);
  try {
    for (const row of toCheck) {
      const road = await roadSavingOrNull(ctx.current, row.cand, ctx.travel);
      const requireRoad = needsConfirmedRoad(row);
      const rowFloor = projectionFloor(row, floor, ranked, ctx);
      if ((!road && !requireRoad) || (road && road.saving_minutes >= rowFloor)) {
        return {
          ...ranked,
          normalBest: { ...row.cand, [ROAD_RESULT]: road || { source: 'estimate' } },
          normalBestScore: row.sc,
        };
      }
    }
    return dropNormalBest(ranked);
  } catch (err) {
    logger.warn(`[auto-dispatch] road check failed (model kept): ${err.message}`);
    return ranked.normalBestNeedsRoad ? dropNormalBest(ranked) : ranked;
  }
}

const withRoad = (row, road) => ({ ...row, cand: { ...row.cand, [ROAD_RESULT]: road || { source: 'estimate' } } });

/**
 * Confirm a ranked result (move-rules.js rankCandidates) on real roads.
 * Returns `ranked` unchanged when the check does not apply; when Google has
 * no answer for the best slot the model's result stands, marked as the
 * estimate. Otherwise the top slots are measured one
 * at a time, best first, and the first that keeps the floor becomes `best`
 * (a slot Google cannot answer for passes on the model's number). The
 * SLOT_TAKEN fallback list is then that one slot: apply.js re-evaluates the
 * visit after a refusal, which runs this check again. When every measured
 * slot fails, nothing qualifies and `roadFailed` names the reason (index.js
 * noMoveReason), with the best slot's numbers in the audit row.
 * Never throws: a failure keeps the model's answer.
 */
// Select up to ROAD_CHECK_SLOTS candidates to measure on Google roads. When all
// top slots require road confirmation (nonpositive-gain minutes-rule) and a
// later score-bar/positive-gain candidate exists, reserve the final slot for
// that candidate so it is actually road-checked (never approved unchecked on an
// estimate) while keeping total provider calls bounded at ROAD_CHECK_SLOTS.
function slotsToMeasure(rankedRows, isSundayDate) {
  const top = (rankedRows || []).slice(0, ROAD_CHECK_SLOTS);
  if (top.length < ROAD_CHECK_SLOTS || !top.every(needsConfirmedRoad)) return top;
  const tierSunday = isSundayDate(top[top.length - 1].cand && top[top.length - 1].cand.date);
  const fallback = (rankedRows || []).slice(ROAD_CHECK_SLOTS)
    .find((row) => !needsConfirmedRoad(row) && isSundayDate(row.cand && row.cand.date) === tierSunday);
  return fallback ? [...top.slice(0, ROAD_CHECK_SLOTS - 1), fallback] : top;
}

async function confirmOnRoads(ranked, ctx) {
  const moveRules = require('./move-rules');
  if (!measurable(ctx)) return ranked;
  if (moveRules.mustMove(ctx.service, ctx.current)) return withProjectionChecked(ranked, ctx);
  if (!ranked.qualifies) return ranked;
  const floor = ctx.config.minDayMoveDriveSavingMinutes;
  const failed = [];
  const toCheck = slotsToMeasure(ranked.rankedRows, moveRules.isSundayDate);
  try {
    for (const row of toCheck) {
      const road = await roadSavingOrNull(ctx.current, row.cand, ctx.travel);
      const requireRoad = needsConfirmedRoad(row);
      // No road answer for the best slot: for a score-bar or positive-gain slot
      // the model's result stands (marked as estimate) and unchecked
      // minutes-rule slots leave the fallback list. A nonpositive-gain
      // minutes-rule slot requires real road confirmation and continues searching.
      if (!road && !failed.length && !requireRoad) {
        return withoutUncheckedMinutes({ ...ranked, best: { ...ranked.best, [ROAD_RESULT]: { source: 'estimate' } } });
      }
      const checked = { ...withRoad(row, road), floor: floorOfRow(row, floor, ctx), unavailable: !road };
      if ((!road && !requireRoad) || (road && road.saving_minutes >= checked.floor)) return settled(ranked, checked, true);
      failed.push(checked);
    }
    return settled(ranked, failed[0], false);
  } catch (err) {
    logger.warn(`[auto-dispatch] road check failed (model kept): ${err.message}`);
    // A slot roads already refused stays refused: the error only stops the search.
    // With nothing measured yet, a nonpositive-gain minutes-rule best slot fails
    // closed with roadUnavailable; any other best slot stands on the estimate
    // with unchecked minutes-rule slots removed from the fallback list.
    if (failed.length) return settled(ranked, failed[0], false);
    const first = toCheck[0];
    if (needsConfirmedRoad(first)) {
      return settled(ranked, { ...withRoad(first, null), floor: floorOfRow(first, floor, ctx), unavailable: true }, false);
    }
    return withoutUncheckedMinutes({ ...ranked, best: { ...ranked.best, [ROAD_RESULT]: { source: 'estimate' } } });
  }
}

// A lookup that throws is no answer for THAT slot only (the model's number
// stands for it, as when Google has none); slots already refused stay refused.
async function roadSavingOrNull(current, cand, travel) {
  try {
    return await roadSaving(current, cand, travel);
  } catch (err) {
    logger.warn(`[auto-dispatch] road check failed for one slot (model kept): ${err.message}`);
    return null;
  }
}

// The fallback list after an unanswered best slot: the best slot, then only
// score-bar slots (a minutes-rule slot needs its own road answer).
function withoutUncheckedMinutes(ranked) {
  const rows = (ranked.rankedRows || []).filter((row, i) => i === 0 || !row.byMinutes);
  return { ...ranked, rankedRows: rows, ranked: rows.map((row) => row.cand) };
}

// The road floor of one slot: the ordinary drive floor, or for a minutes-rule
// slot (move-rules.js minutesRuleOk) its own minutes, whichever is higher.
function floorOfRow(row, floor, ctx) {
  const moveRules = require('./move-rules');
  return row.byMinutes ? Math.max(floor, moveRules.minutesRuleFloor(ctx.service, ctx.config)) : floor;
}

function settled(ranked, row, passed) {
  return {
    ...ranked,
    best: row.cand,
    bestScore: row.sc,
    gain: row.gain,
    qualifies: passed,
    byMinutes: passed && !!row.byMinutes,
    roadFailed: !passed,
    roadUnavailable: !passed && Boolean(row.unavailable),
    // The floor the road check held this slot to (index.js noMoveReason).
    roadFloor: row.floor,
    ranked: passed ? [row.cand] : [],
    rankedRows: passed ? [{ cand: row.cand, sc: row.sc, gain: row.gain, byMinutes: row.byMinutes }] : [],
  };
}

// For the run's log line: how many route-matrix legs the run bought.
function spendOf(travel) {
  return travel && typeof travel.diagnostics === 'function' ? travel.diagnostics().elements : 0;
}

// The road answer of a slot for its audit row; undefined when not checked.
function roadResultOf(cand) {
  return (cand && cand[ROAD_RESULT]) || undefined;
}

module.exports = {
  ROAD_LEGS, ROAD_CHECK_SLOTS, roadLegsOf, createRunTravel, deferredToApply, pass1Travel, confirmOnRoads, roadResultOf, spendOf,
  _internals: { ROAD_RESULT, roadDetour, roadSaving, legsFor, roadCheckBudget },
};
