/**
 * The app's own simulator, applied to the day re-plan (owner ruling 2026-11-03, shadow PR 1).
 *
 * The pure planner (planner.js) is a fast search model. The app already has a simulator for "can this day
 * keep every promise": route-reorder-window-fit.js simulateArrivalRoute, which the 04:20 pass and the picker
 * use, with the co-visit rules (one stay for two rows of one visit, the phantom-hour fix) in isCoVisitPair /
 * startCoVisitChain / advanceCoVisit. This file reuses those, and never re-derives them:
 *   - coVisitGroups / coVisitMinutes: merge a same-property, same-window co-visit group into ONE planner stop
 *     charged the helpers' on-site minutes, so the search can never separate the rows.
 *   - appSimCheck: after the planner picks its best plan, re-simulate BOTH the chosen baseline and the best
 *     plan with simulateArrivalRoute (hours applied to the rows in memory, same origin and departure) and
 *     return the app's numbers and whether every promise is kept.
 * Schedule blocks are not passed to the app simulation: the planner already refuses any service interval that
 * overlaps one, and the simulation would only slide service past it a second time.
 */
const RouteOptimizer = require('../route-optimizer');
const {
  effectiveWindowRange, isCoVisitPair, startCoVisitChain, advanceCoVisit, simulateArrivalRoute,
} = require('../route-reorder-window-fit');

const rangeFor = (row) => row.arrivalRange || effectiveWindowRange(row);

/**
 * Splits rows (already in an order that keeps co-visit siblings adjacent, e.g. promisedWindowOrder) into groups of
 * consecutive rows that are one physical stop by isCoVisitPair. A lone row is a group of one.
 */
function coVisitGroups(rows) {
  const groups = [];
  for (const row of rows) {
    const group = groups.at(-1);
    if (group && isCoVisitPair(rangeFor, group.at(-1), row)) group.push(row);
    else groups.push([row]);
  }
  return groups;
}

/** On-site minutes for one group: the helpers' chain (sum of real estimates, floored by the longest window-derived stay). */
function coVisitMinutes(group) {
  let chain = { clock: 0, arrivalMin: 0, ...startCoVisitChain(group[0]) };
  for (const row of group.slice(1)) chain = advanceCoVisit(chain, row);
  return chain.coMerged;
}

const hhmmss = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}:00`;
const toMin = (value) => {
  const [h, m] = String(value).slice(0, 5).split(':').map(Number);
  return h * 60 + m;
};

/** The row with its booked hour moved to slotMin, keeping its window width. */
function withHour(row, slotMin) {
  const start = toMin(row.window_start);
  const width = row.window_end ? Math.max(0, toMin(row.window_end) - start) : 60;
  return { ...row, window_start: hhmmss(slotMin), window_end: hhmmss(slotMin + width) };
}

function simulate(seq, { origin, departureMin }) {
  return simulateArrivalRoute(RouteOptimizer, rangeFor, seq, {
    startMin: departureMin, origin, end: origin, reportLate: true,
  });
}

/** True when every stop arrives by its window start + promise - margin (the planner's own bound). */
function promisesKept(sim, seq, marginMin) {
  return sim.arrivals.every((a, i) => {
    const range = rangeFor(seq[i]);
    return !range || a.arrivalMin <= range.endMin - marginMin;
  });
}

const figures = (sim) => ({ driveMin: sim.travelMin, endMin: sim.finishMin });

/**
 * @param {{ groups: object[][], baselineOrder: string[], best: {order: string[], slots: object}|null,
 *           origin: {lat: number, lng: number}, departureMin: number, marginMin: number }} input
 *   groups: the co-visit groups (arrays of rows); orders and slots are keyed by each group's first row id.
 * @returns {{ current: {driveMin, endMin}|null, planned: {driveMin, endMin, kept: boolean}|null }}
 */
function appSimCheck({ groups, baselineOrder, best, origin, departureMin, marginMin }) {
  const byLeader = new Map(groups.map((g) => [String(g[0].id), g]));
  const expand = (order) => order.flatMap((id) => (byLeader.get(String(id)) || []).map((row) => ({ row, id })));
  const baselineSeq = expand(baselineOrder).map((e) => e.row);
  const currentSim = simulate(baselineSeq, { origin, departureMin });
  let planned = null;
  if (best) {
    const seq = expand(best.order).map(({ row, id }) => {
      const slot = best.slots[id];
      return slot == null || slot === toMin(row.window_start) ? row : withHour(row, slot);
    });
    const sim = simulate(seq, { origin, departureMin });
    planned = sim ? { ...figures(sim), kept: promisesKept(sim, seq, marginMin) } : null;
  }
  return { current: currentSim ? figures(currentSim) : null, planned };
}

/**
 * The final answer once the app's simulation has weighed in. The planner's verdict stands only if the app's
 * simulation also keeps every promise, finishes no later, and saves at least the floor; otherwise
 * 'app_sim_rejects' (never accepted).
 */
function finalVerdict(result, check, minSavingMin) {
  const { current, planned } = check;
  if (!current) return { accepted: false, reason: result.reason === 'accepted' ? 'app_sim_rejects' : result.reason, savedMin: 0 };
  const savedMin = planned ? current.driveMin - planned.driveMin : 0;
  if (!result.accepted) return { accepted: false, reason: result.reason, savedMin };
  const ok = !!planned && planned.kept && planned.endMin <= current.endMin && savedMin >= minSavingMin;
  return { accepted: ok, reason: ok ? 'accepted' : 'app_sim_rejects', savedMin };
}

module.exports = { coVisitGroups, coVisitMinutes, appSimCheck, finalVerdict, withHour };
