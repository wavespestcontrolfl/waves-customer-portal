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

function applies({ service, current, config, travel, ranked }, moveRules) {
  return !!(config.roadCheckEnabled && travel && ranked.qualifies
    && (config.minDayMoveDriveSavingMinutes || 0) > 0
    && !current.detour_group_blind && !moveRules.mustMove(service, current));
}

const withRoad = (row, road) => ({ ...row, cand: { ...row.cand, [ROAD_RESULT]: road || { source: 'estimate' } } });

/**
 * Confirm a ranked result (move-rules.js rankCandidates) on real roads.
 * Returns `ranked` unchanged when the check does not apply, or when Google
 * has no answer for the best slot. Otherwise the top slots are measured one
 * at a time, best first, and the first that keeps the floor becomes `best`
 * (a slot Google cannot answer for passes on the model's number). The
 * SLOT_TAKEN fallback list is then that one slot: apply.js re-evaluates the
 * visit after a refusal, which runs this check again. When every measured
 * slot fails, nothing qualifies and `roadFailed` names the reason (index.js
 * noMoveReason), with the best slot's numbers in the audit row.
 * Never throws: a failure keeps the model's answer.
 */
async function confirmOnRoads(ranked, ctx) {
  const moveRules = require('./move-rules');
  if (!applies({ ...ctx, ranked }, moveRules)) return ranked;
  const floor = ctx.config.minDayMoveDriveSavingMinutes;
  try {
    const failed = [];
    for (const row of ranked.rankedRows.slice(0, ROAD_CHECK_SLOTS)) {
      const road = await roadSaving(ctx.current, row.cand, ctx.travel);
      if (!road && !failed.length) return ranked;
      const checked = withRoad(row, road);
      if (!road || road.saving_minutes >= floor) return settled(ranked, checked, true);
      failed.push(checked);
    }
    return settled(ranked, failed[0], false);
  } catch (err) {
    logger.warn(`[auto-dispatch] road check failed (model kept): ${err.message}`);
    return ranked;
  }
}

function settled(ranked, row, passed) {
  return {
    ...ranked,
    best: row.cand,
    bestScore: row.sc,
    gain: row.gain,
    qualifies: passed,
    roadFailed: !passed,
    ranked: passed ? [row.cand] : [],
    rankedRows: passed ? [{ cand: row.cand, sc: row.sc, gain: row.gain }] : [],
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
  ROAD_LEGS, ROAD_CHECK_SLOTS, roadLegsOf, createRunTravel, confirmOnRoads, roadResultOf, spendOf,
  _internals: { ROAD_RESULT, roadDetour, roadSaving, legsFor, roadCheckBudget },
};
