/**
 * WINDOW-FIT FALLBACK for the nightly route-reorder pass (follow-up to
 * ROUTE-TIERS #3388, owner-ruled 2026-08-14).
 *
 * The nightly pass asks Google for the distance-optimal stop order and then
 * refuses to write any order that contradicts promised arrival windows
 * (chronology guard) or provably cannot be driven (feasibility guard). On
 * days where timed promises pin the route, Google's unconstrained order
 * fails those guards EVERY night and the day's savings are structurally
 * unreachable (first prod night: 3 of 5 days skipped WINDOW_ORDER_CONFLICT,
 * ~22 mi/night left on the table). This module computes the best LEGAL
 * order in-process instead:
 *
 *   - Backbone: stops with a promised window, in chronological order of
 *     their effective window start (the same anchor the chronology guard
 *     enforces). Distinct starts are never permuted — any other relative
 *     order is exactly what the guard exists to reject. EQUAL starts are a
 *     tie the guard explicitly permits in any order, so the exhaustive
 *     search explores every within-group permutation too (a specific tie
 *     order can be the only feasible or the cheapest one); the greedy path
 *     keeps ties in the caller-supplied current running order, which is
 *     deterministic and operator-visible.
 *   - Untimed stops: interleaved around the backbone. Small days get an
 *     exhaustive search over every backbone-preserving interleaving with
 *     infeasible-prefix pruning; days whose sequence count exceeds the
 *     cap get greedy cheapest-feasible insertion (globally cheapest
 *     feasible (stop, position) pair each round).
 *   - Every surviving candidate is scored under the ONE shared in-house
 *     leg model (modelDistanceMeters — the same model the savings floor is
 *     measured with), and the winner is re-checked against BOTH production
 *     guards before it is returned (owner ruling: model-authored orders are
 *     acceptable BECAUSE the guards are identical).
 *
 * This module is pure computation: no db, no gates, no writes. The caller
 * (route-reorder.js) owns the gate check, the savings floor, the ledger,
 * and the fenced SERIALIZABLE write — a window-fit order rejoins the exact
 * write path the Google order would have taken (zero new writers).
 *
 * The feasibility simulation here mirrors violatesWindowFeasibility's
 * model path minute-for-minute (HQ depart 08:00, fallback leg minutes,
 * the greater of stored work span and duration estimate, default 60;
 * waiting for a window to open is
 * fine, starting past the arrival deadline is not). The mirror is only a
 * search heuristic — the caller-supplied production guard has the final
 * word on the returned order.
 */

const { ARRIVAL_WINDOW_MINUTES } = require('../utils/sms-time-format');
const { premiseStampConflicts, effectiveServiceAddress } = require('./stamped-address');
const hhmmToMin = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
};

/**
 * The [start, end] minute-of-day ARRIVAL range a stop is PROMISED to begin
 * within, or null when unconstrained. window_start rows: ALWAYS start + 120
 * — the customer's arrival promise is "time + 2h window" (the same rule the
 * SMS formatter's arrivalWindowRange enforces), NEVER the stored window_end,
 * which is a service-END estimate: a 3-hour 09:00 job has a noon window_end
 * but its promised arrival deadline is 11:00 (codex GitHub round P1). Legacy
 * bands get their real band ends (morning = 08:00–12:00, afternoon =
 * 12:00–17:00); a literal HH:MM in time_window gets the same +120 promise.
 */
function effectiveWindowRange(stop) {
  if (stop.window_start) {
    const ws = hhmmToMin(String(stop.window_start).slice(0, 5));
    return { startMin: ws, endMin: ws + ARRIVAL_WINDOW_MINUTES };
  }
  const raw = String(stop.time_window || '').trim().toLowerCase();
  if (raw === 'morning') return { startMin: 8 * 60, endMin: 12 * 60 };
  if (raw === 'afternoon') return { startMin: 12 * 60, endMin: 17 * 60 };
  // A meridiem is part of the clock: '4:00 PM' is 16:00, not 04:00 — reading
  // it as a morning promise can reject every order as infeasible, and can
  // mark a still-upcoming afternoon window as already elapsed (codex #4430 r4
  // P1). Same am/pm semantics route-reorder.js's effectiveWindowStart uses.
  const m = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (m) {
    let hour = Number(m[1]);
    if (m[3] === 'pm' && hour < 12) hour += 12;
    if (m[3] === 'am' && hour === 12) hour = 0;
    if (hour > 23) return null;
    const ws = hour * 60 + Number(m[2] || 0);
    return { startMin: ws, endMin: ws + ARRIVAL_WINDOW_MINUTES };
  }
  return null;
}

/** Stops ordered as the board currently runs them — the "before" baseline
 *  savings are measured against. MUST mirror the dispatch consumers' SQL
 *  exactly (dispatch.js jobs query: COALESCE(route_order, 999),
 *  COALESCE(window_start, '23:59'), created_at — no time_window, windowless
 *  stops LAST): a baseline built from any other sequence measures savings
 *  against a route nobody drives and can trigger a spurious reorder of an
 *  already-efficient day (codex GitHub round P2). `id` is a final stable
 *  tiebreak only — SQL leaves created_at ties unordered. */
function currentOrder(stops) {
  return [...stops].sort((a, b) => {
    const ra = a.route_order == null ? 999 : Number(a.route_order);
    const rb = b.route_order == null ? 999 : Number(b.route_order);
    if (ra !== rb) return ra - rb;
    const wa = a.window_start ? String(a.window_start).slice(0, 5) : '23:59';
    const wb = b.window_start ? String(b.window_start).slice(0, 5) : '23:59';
    if (wa !== wb) return wa < wb ? -1 : 1;
    const ca = a.created_at ? new Date(a.created_at).getTime() : 0;
    const cb = b.created_at ? new Date(b.created_at).getTime() : 0;
    if (ca !== cb) return ca - cb;
    return String(a.id) < String(b.id) ? -1 : 1;
  });
}

// Sequence-count ceiling for the exhaustive search. n stops with k timed in
// g equal-start groups have (n!/k!)·∏ gᵢ! backbone-preserving sequences
// (interleavings × within-tie permutations); beyond this we fall back to
// greedy insertion. 20k full-day simulations is comfortably sub-second at
// the 25-stop Google cap the caller already enforces.
const EXHAUSTIVE_SEQUENCE_CAP = 20000;

function sequenceCount(total, timed, groupSizes) {
  // (n!/k!)·∏ gᵢ! with an early cap so a 25-stop day never overflows.
  let count = 1;
  for (let i = timed + 1; i <= total; i++) {
    count *= i;
    if (count > EXHAUSTIVE_SEQUENCE_CAP) return count;
  }
  for (const g of groupSizes) {
    for (let i = 2; i <= g; i++) {
      count *= i;
      if (count > EXHAUSTIVE_SEQUENCE_CAP) return count;
    }
  }
  return count;
}

function workDuration(stop, fallback = 60) {
  const start = stop.window_start ? hhmmToMin(String(stop.window_start).slice(0, 5)) : null;
  const end = stop.window_end ? hhmmToMin(String(stop.window_end).slice(0, 5)) : null;
  const span = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
  return Math.max(span, Number(stop.estimated_duration_minutes) || 0) || fallback;
}

/**
 * PHANTOM-HOUR FIX (prod, Sat 2026-09-12): two customers each had TWO
 * scheduled_services rows (pest + lawn) promised the
 * SAME arrival window at the SAME property — one physical stop, `visit_id`
 * NULL (GATE_VISIT_GROUPS is dark in prod, so these rows never went through
 * visit-groups.js's proper grouping — see the veto note on
 * computeChronologicalRepair below). Simulated as two independent stops each
 * charged their own workDuration, the pair cost 2 hours of on-site time for
 * a 1-hour promise — enough by itself to make the day simulate infeasible
 * (computeChronologicalRepair returned null, NO_SAFE_INSERTION) and to make
 * violatesWindowFeasibility reject a legal Google order for the same
 * phantom hour.
 *
 * True when `stop` is a continuation of the SAME physical stop as
 * `prevStop`: identical customer, identical promised arrival window
 * (effectiveWindowRange), the same stamped PREMISE, and BOTH rows geocoded
 * to identical coordinates. Coordinates alone do not prove one
 * physical stop — a customer's two units in one building share the parcel
 * centroid (Codex #4435 r1 P1) — so the saved per-appointment address
 * (authoritative for an existing appointment, see day-stops.js) has to agree
 * too — and "the same premise" is the repo's existing premiseStampConflicts
 * rule (street key, then the unit from line 2 or embedded in the street
 * line, then zip, then city) over the EFFECTIVE address, not a line-1 string
 * match on the stamp: Apt 1 and Apt 2 of one building share both the parcel
 * pin AND their line 1 (Codex #4435 r2 P1), and an unstamped row inherits
 * the customer's primary premise, so comparing a bare stamp against nothing
 * finds no conflict where a real one exists (r3 P1). A row whose premise
 * cannot be resolved at all — no address column selected, or no street line
 * on either the stamp or the customer — is UNKNOWN, not known-equal, and
 * never merges.
 * A coordless side never matches: a multi-property customer (commercial
 * chain, rental owner) with one ungeocoded row in the same auto-templated
 * slot is two addresses, and merging them would under-count real work —
 * the inverse of the phantom hour. Failing closed there keeps that day
 * byte-for-byte what it was before this fix (the nightly pass rejects
 * coordless days before it gets here anyway). BOTH stops must carry
 * `customer_id` — a caller whose select list drops the column (or a stop
 * with no customer_id at all, e.g. an unlinked estimate hold) never matches,
 * so the simulation for it is unchanged too. A stop carrying a
 * `visit_id` on EITHER side never matches either: a service_visits group is
 * arrival-route.js's SUM-of-durations contract, and collapsing it to MAX
 * here would under-count genuine extra work (the veto note on
 * computeChronologicalRepair below). This guard is what enforces that veto
 * on the shared simulation paths (computeWindowFitOrder,
 * violatesWindowFeasibility) that have no ungrouped-only gate of their own.
 */
function isCoVisitPair(effectiveWindowRange, prevStop, stop) {
  // Presence-checked like the address below, not a bare `!= null`:
  // `undefined != null` is false in JS, so a select that drops the column
  // would silently no-op the ONE veto protecting visit-groups' SUM contract
  // (round-0 fallback audit P1).
  if (!('visit_id' in prevStop) || !('visit_id' in stop)) return false;
  if (prevStop.visit_id != null || stop.visit_id != null) return false;
  if (prevStop.customer_id == null || stop.customer_id == null) return false;
  if (String(prevStop.customer_id) !== String(stop.customer_id)) return false;
  // The promise the pair SHARED, which is what makes them one physical stop.
  // A caller that relaxes an already-elapsed arrival deadline (route-reorder's
  // relaxElapsedWindows) clears the window fields, so the stored promise has
  // to travel separately or an overdue bundle goes back to counting as two
  // full visits (codex #4430 r5 P1).
  if (!sameCoVisitWindow(effectiveWindowRange, prevStop, stop)) return false;
  const prevLat = parseFloat(prevStop.lat);
  const prevLng = parseFloat(prevStop.lng);
  const lat = parseFloat(stop.lat);
  const lng = parseFloat(stop.lng);
  if (!(lat && lng && prevLat && prevLng)) return false;
  if (lat !== prevLat || lng !== prevLng) return false;
  if (!('service_address_line1' in prevStop) || !('service_address_line1' in stop)) return false;
  const prevPremise = effectivePremise(prevStop);
  const premise = effectivePremise(stop);
  if (!prevPremise.service_address_line1 || !premise.service_address_line1) return false;
  return !premiseStampConflicts(prevPremise, premise);
}

/**
 * Advance the day simulation by one stop. state = { clock (minute-of-day),
 * prev ({lat,lng}), prevStop (the full previous stop, for the co-visit
 * check above), travelMin (cumulative) }. Returns the next state, or null
 * when the stop provably misses its promised arrival deadline — making
 * prefixes prunable: the clock only moves forward, so no suffix can rescue
 * a missed window.
 */
/** True when both rows carry the same promised arrival window — the stored
 *  one where a caller has relaxed it for simulation (co_visit_window_key),
 *  else the live effectiveWindowRange. Both sides must know their promise:
 *  an unconstrained stop is not "the same window" as anything. */
function sameCoVisitWindow(effectiveWindowRange, prevStop, stop) {
  const prevKey = prevStop.co_visit_window_key;
  const key = stop.co_visit_window_key;
  if (prevKey || key) return Boolean(prevKey && key && prevKey === key);
  const prevRange = effectiveWindowRange(prevStop);
  const range = effectiveWindowRange(stop);
  if (!prevRange || !range) return false;
  return prevRange.startMin === range.startMin && prevRange.endMin === range.endMin;
}

/**
 * The stop's EFFECTIVE premise — its own stamp where it has one, the
 * customer's primary address where it does not, resolved by the repo's own
 * effectiveServiceAddress (which knows when a stamp's unit inherits and when
 * it diverges). Shaped as service_address_* so premiseStampConflicts can read
 * it. Callers alias the customer columns as customer_address_line1 etc., the
 * same names stampedAddressDiverges already expects.
 */
function effectivePremise(stop) {
  const eff = effectiveServiceAddress(stop, {
    address_line1: stop.customer_address_line1,
    address_line2: stop.customer_address_line2,
    city: stop.customer_city,
    state: stop.customer_state,
    zip: stop.customer_zip,
  });
  return {
    service_address_line1: eff.line1,
    service_address_line2: eff.line2,
    service_address_city: eff.city,
    service_address_zip: eff.zip,
  };
}

/**
 * On-site minutes for a co-visit chain. NOT the max of the members'
 * durations: a row's `workDuration` falls back to its promised WINDOW SPAN
 * when it has no real estimate, and two rows sharing one hour-long promise
 * are one hour on site, not two (the phantom hour) — but two rows that each
 * carry a REAL estimate are genuinely additive work, and charging only the
 * longer of them would let the guards approve a day whose later customers
 * cannot be reached (Codex #4435 r1 P1, the same SUM invariant
 * arrival-route.js's groupRouteStops holds for visit_id groups). So: the sum
 * of the chain's real estimates, floored by the longest member's
 * window-derived duration.
 */
function coVisitWork(chain, stop) {
  const floor = Math.max(chain.coFloor || 0, workDuration(stop));
  const estimates = (chain.coEstimates || 0) + rawEstimateMinutes(stop);
  return { floor, estimates, minutes: Math.max(floor, estimates) };
}

/**
 * The row's REAL service estimate, 0 when it has none. arrival-route.js's
 * evaluateArrivalPlacement pre-normalizes every ungrouped row's
 * estimated_duration_minutes to workDuration(row) before simulating, which
 * would make a span-only row look like a real 60-minute estimate and sum two
 * of them straight back into the phantom hour (Codex #4435 r2 P1) — so that
 * caller stamps the untouched value as raw_estimate_minutes, and this is
 * what the co-visit sum reads.
 */
function rawEstimateMinutes(stop) {
  const raw = 'raw_estimate_minutes' in stop ? stop.raw_estimate_minutes : stop.estimated_duration_minutes;
  return Number(raw) || 0;
}

/** The chain bookkeeping a NON-merged stop starts: one row on its own is a
 *  one-member co-visit chain. Shared by both simulations' non-merge branches
 *  so the initialization cannot drift from advanceCoVisit's own arithmetic
 *  (round-0 fallback audit P1). */
function startCoVisitChain(stop) {
  const floor = workDuration(stop);
  const estimates = rawEstimateMinutes(stop);
  return { coFloor: floor, coEstimates: estimates, coMerged: Math.max(floor, estimates) };
}

/**
 * THE co-visit advance — the one place the merge's timing lives, called by
 * both simulations (advanceSim below and violatesWindowFeasibility's own
 * inline loop in route-reorder.js, which walks Google's legs itself and so
 * cannot call advanceSim wholesale). Keeping the arithmetic in one function
 * is what stops the two from drifting into a phantom hour on one path and an
 * under-count on the other (round-0 fallback audit P1).
 *
 * `chain` = { clock, arrivalMin, coFloor, coEstimates } for the run of rows
 * already merged at this stop. Returns the same shape advanced by `stop`,
 * plus the `waiting` those minutes added. Arrival stays pinned to the
 * sibling's already-proven arrival; only the EXTRA minutes past the current
 * clock are new, and they obey blockedIntervals exactly as the normal path's
 * work does (the sibling's own span was checked when it was simulated).
 */
function advanceCoVisit(chain, stop, blockedIntervals = []) {
  const merged = coVisitWork(chain, stop);
  // The DELTA of merged work, NOT (ideal end − clock): once a block has
  // postponed an earlier extension the clock carries idle minutes, and
  // measuring against it would let that idle swallow a later member's work
  // outright (Codex #4435 r2 P1 — a third row's 20 minutes vanishing).
  const extra = Math.max(0, merged.minutes - (chain.coMerged || 0));
  let extraStart = chain.clock;
  if (extra > 0) {
    for (const block of blockedIntervals) {
      if (extraStart < block.endMin && extraStart + extra > block.startMin) extraStart = block.endMin;
    }
  }
  return {
    clock: extraStart + extra,
    arrivalMin: chain.arrivalMin,
    coFloor: merged.floor,
    coEstimates: merged.estimates,
    coMerged: merged.minutes,
    // A block that postpones the extra work holds the truck on site with
    // nothing to do — the same thing waiting for a window to open is, and
    // evaluateArrivalPlacement breaks equal-travel ties on this number
    // (Codex #4435 r1 P2).
    waiting: extraStart - chain.clock,
  };
}

function advanceSim(RouteOptimizer, effectiveWindowRange, state, stop, {
  legMinutes, bufferMinutes = 0, blockedIntervals = [], reportLate = false,
} = {}) {
  // Co-visit continuation: no new leg, arrival pinned to the sibling's
  // arrival (already proven inside the promise) — see isCoVisitPair above.
  if (state.prevStop && isCoVisitPair(effectiveWindowRange, state.prevStop, stop)) {
    const merged = advanceCoVisit(state, stop, blockedIntervals);
    return {
      clock: merged.clock,
      prev: state.prev,
      prevStop: stop,
      visited: true,
      travelMin: state.travelMin,
      arrivalMin: merged.arrivalMin,
      waitingMin: (state.waitingMin || 0) + merged.waiting,
      coFloor: merged.coFloor,
      coEstimates: merged.coEstimates,
      coMerged: merged.coMerged,
    };
  }
  const lat = parseFloat(stop.lat);
  const lng = parseFloat(stop.lng);
  let travel = 0;
  let prev = state.prev;
  let departMin = state.clock;
  if (lat && lng) {
    for (let attempt = 0; attempt <= blockedIntervals.length; attempt++) {
      travel = legMinutes ? legMinutes(prev, stop, departMin) : RouteOptimizer.fallbackLegMetrics(
        RouteOptimizer.haversine(prev.lat, prev.lng, lat, lng),
      ).minutes || 0;
      if (!Number.isFinite(travel) || travel < 0) return null;
      if (state.visited && (prev.lat !== lat || prev.lng !== lng)) travel += bufferMinutes;
      const blocked = blockedIntervals.find(block => departMin < block.endMin && departMin + travel > block.startMin);
      if (!blocked) break;
      departMin = blocked.endMin;
    }
    prev = { lat, lng };
  }
  let startMin = departMin + travel;
  const range = effectiveWindowRange(stop);
  if (range) startMin = Math.max(startMin, range.startMin);
  for (const block of blockedIntervals) {
    if (startMin < block.endMin && startMin + workDuration(stop) > block.startMin) startMin = block.endMin;
  }
  if (range && startMin > range.endMin && !reportLate) return null;
  return { clock: startMin + workDuration(stop), prev, prevStop: stop, visited: true, travelMin: state.travelMin + travel, arrivalMin: startMin, waitingMin: (state.waitingMin || 0) + Math.max(0, startMin - state.clock - travel), ...startCoVisitChain(stop) };
}

/** Repair the demonstrated null-position insertion defect. Keep the relative
 * order of every already-positioned stop, including ties. Only a fully timed,
 * ungrouped, unpinned route with a chronological backbone qualifies. A repair
 * must turn an infeasible baseline into a feasible route; no distance saving
 * is needed to correct that defect. The caller owns gates and fenced writes.
 *
 * `visit_id` VETO (deliberate, not extended to the co-visit rule above):
 * a `service_visits` row is visit-groups.js's OWN mechanism for "N
 * scheduled_services sharing one physical stop" (its combined duration is
 * the SUM of members' real work estimates plus a shared/offset arrival
 * range — see arrival-route.js's groupRouteStops, which pre-groups visit_id
 * members into one stop BEFORE simulating). That is a different, and
 * correct, model from this fix's co-visit rule: co-visit rows are
 * INDEPENDENT scheduled_services whose window span alone (not a real work
 * estimate) makes them look like they each cost a full promised hour, so
 * the honest fix is the MAX of the two, not the sum. Collapsing a real
 * multi-service visit_id group to MAX here would under-count genuine extra
 * work and is out of scope for a phantom-hour fix — this module has no
 * visit_id-aware pre-grouping step (sum durations, union/offset windows,
 * shared technician) to replicate arrival-route.js's contract, so the veto
 * stays: a visit_id day is left for the (dark, GATE_VISIT_GROUPS) group
 * path or a human, never silently mis-simulated here.
 */
function computeChronologicalRepair(RouteOptimizer, stops) {
  if (stops.some(stop => {
    const duration = workDuration(stop, 0);
    return stop.visit_id || stop.auto_dispatch_locked || stop.auto_dispatch_excluded
      || !Number.isFinite(effectiveWindowRange(stop)?.startMin)
      || !Number.isFinite(Number(stop.lat)) || !Number.isFinite(Number(stop.lng))
      || !Number(stop.lat) || !Number(stop.lng) || !Number.isFinite(duration) || duration <= 0;
  })) return null;
  const ordered = currentOrder(stops);
  const backbone = ordered.filter(stop => stop.route_order != null);
  const additions = ordered.filter(stop => stop.route_order == null);
  if (!backbone.length || !additions.length) return null;
  if (backbone.some((stop, i) => i > 0 && effectiveWindowRange(stop).startMin < effectiveWindowRange(backbone[i - 1]).startMin)) return null;
  if (simulateArrivalRoute(RouteOptimizer, effectiveWindowRange, ordered)) return null;
  const candidate = [...backbone];
  for (const stop of additions) {
    const range = effectiveWindowRange(stop);
    // Phantom-hour fix: a same-customer, same-window addition MUST land
    // immediately next to its sibling (co-visit merge only fires for
    // CONSECUTIVE stops), never split from it by a same-window addition
    // from a different customer that happens to sort between them by
    // currentOrder's created_at/id tiebreak. When a sibling is already
    // placed (backbone or an earlier addition), insert right after it —
    // pest before lawn falls out naturally from currentOrder's processing
    // order; otherwise fall through to the general window-start insertion.
    // Same predicate the simulation merges on — a pair that would not
    // merge (different address, visit_id) gets the plain window-start slot.
    const siblingIndex = candidate.findIndex(other => isCoVisitPair(effectiveWindowRange, other, stop));
    if (siblingIndex !== -1) {
      candidate.splice(siblingIndex + 1, 0, stop);
      continue;
    }
    const index = candidate.findIndex(other => effectiveWindowRange(other).startMin > range.startMin);
    candidate.splice(index === -1 ? candidate.length : index, 0, stop);
  }
  const simulation = simulateArrivalRoute(RouteOptimizer, effectiveWindowRange, candidate);
  return simulation ? { orderedStops: candidate, simulation } : null;
}

/** Simulate the complete route under the promised ARRIVAL windows. Work may
 * finish after a window closes; the next arrival still has to fit. Shared by
 * nightly reordering and staff picker/save checks. No scheduled times change.
 * null means at least one promise (or the requested day end) cannot be kept. */
function simulateArrivalRoute(RouteOptimizer, rangeForStop, seq, {
  startMin = 8 * 60, origin = RouteOptimizer.HQ, dayEndMin = Infinity, reportLate = false,
  includeReturnInFinish = false, legMinutes, bufferMinutes = 0, blockedIntervals = [],
} = {}) {
  if (blockedIntervals.some(block => !Number.isFinite(block.startMin) || !Number.isFinite(block.endMin) || block.endMin <= block.startMin)) return null;
  blockedIntervals = [...blockedIntervals].sort((a, b) => a.startMin - b.startMin);
  let state = { clock: startMin, prev: origin, travelMin: 0, waitingMin: 0 };
  const arrivals = [];
  for (const stop of seq) {
    state = advanceSim(RouteOptimizer, rangeForStop, state, stop, { legMinutes, bufferMinutes, blockedIntervals, reportLate });
    if (!state || state.clock > dayEndMin) return null;
    arrivals.push({ id: stop.id, arrivalMin: state.arrivalMin, departureMin: state.clock,
      ...(reportLate ? { lateMinutes: Math.max(0, state.arrivalMin - (rangeForStop(stop)?.endMin ?? Infinity)) } : {}),
    });
  }
  let returnDeparture = state.clock;
  let returnMin;
  for (let attempt = 0; attempt <= blockedIntervals.length; attempt++) {
    returnMin = legMinutes ? legMinutes(state.prev, RouteOptimizer.HQ, returnDeparture) : RouteOptimizer.fallbackLegMetrics(
      RouteOptimizer.haversine(state.prev.lat, state.prev.lng, RouteOptimizer.HQ.lat, RouteOptimizer.HQ.lng),
    ).minutes || 0;
    if (!Number.isFinite(returnMin) || returnMin < 0) return null;
    const blocked = blockedIntervals.find(block => returnDeparture < block.endMin && returnDeparture + returnMin > block.startMin);
    if (!blocked) break;
    returnDeparture = blocked.endMin;
  }
  const returnFinishMin = returnDeparture + returnMin;
  if (includeReturnInFinish && returnFinishMin > dayEndMin) return null;
  return { arrivals, travelMin: state.travelMin + returnMin, waitingMin: state.waitingMin + returnDeparture - state.clock,
    finishMin: includeReturnInFinish ? returnFinishMin : state.clock,
    serviceFinishMin: state.clock, returnFinishMin, returnAtMin: returnFinishMin };
}

/** Exhaustive backbone-preserving interleaving search with prefix pruning.
 *  `groups` = the backbone as equal-start groups in chronological order:
 *  order BETWEEN groups is fixed (the chronology guard's rule); order
 *  WITHIN a group is explored (the guard permits any tie order, and a
 *  specific one can be the only feasible or the cheapest sequence —
 *  pre-push audit P1). */
function exhaustiveSearch(RouteOptimizer, guards, groups, untimed, startMin = 8 * 60, origin = RouteOptimizer.HQ) {
  let best = null;
  let bestMeters = Infinity;
  const total = groups.reduce((n, g) => n + g.length, 0) + untimed.length;
  const used = new Array(untimed.length).fill(false);
  const groupUsed = groups.map((g) => new Array(g.length).fill(false));
  const seq = [];
  const recurse = (groupIdx, groupRemaining, state) => {
    if (seq.length === total) {
      const meters = guards.modelDistanceMeters(RouteOptimizer, seq, origin);
      if (meters < bestMeters) {
        bestMeters = meters;
        best = [...seq];
      }
      return;
    }
    // Next stop is either any unused member of the CURRENT tie group (the
    // group must fully precede the next one) or any unused untimed stop.
    if (groupIdx < groups.length) {
      const group = groups[groupIdx];
      for (let i = 0; i < group.length; i++) {
        if (groupUsed[groupIdx][i]) continue;
        const next = advanceSim(RouteOptimizer, guards.effectiveWindowRange, state, group[i]);
        if (!next) continue;
        groupUsed[groupIdx][i] = true;
        seq.push(group[i]);
        if (groupRemaining === 1) recurse(groupIdx + 1, (groups[groupIdx + 1] || []).length, next);
        else recurse(groupIdx, groupRemaining - 1, next);
        seq.pop();
        groupUsed[groupIdx][i] = false;
      }
    }
    for (let i = 0; i < untimed.length; i++) {
      if (used[i]) continue;
      const next = advanceSim(RouteOptimizer, guards.effectiveWindowRange, state, untimed[i]);
      if (!next) continue;
      used[i] = true;
      seq.push(untimed[i]);
      recurse(groupIdx, groupRemaining, next);
      seq.pop();
      used[i] = false;
    }
  };
  recurse(0, (groups[0] || []).length, { clock: startMin, prev: origin, travelMin: 0 });
  return best;
}

/** Greedy cheapest-feasible insertion for days above the exhaustive cap:
 *  start from the backbone (which must itself be feasible), then each round
 *  insert the globally cheapest feasible (untimed stop, position) pair. */
function greedyInsertion(RouteOptimizer, guards, backbone, untimed, startMin = 8 * 60, origin = RouteOptimizer.HQ) {
  let seq = [...backbone];
  if (simulateArrivalRoute(RouteOptimizer, guards.effectiveWindowRange, seq, { startMin, origin }) == null) return null;
  const remaining = [...untimed];
  while (remaining.length > 0) {
    let bestPick = null;
    for (let r = 0; r < remaining.length; r++) {
      for (let pos = 0; pos <= seq.length; pos++) {
        const candidate = [...seq.slice(0, pos), remaining[r], ...seq.slice(pos)];
        if (simulateArrivalRoute(RouteOptimizer, guards.effectiveWindowRange, candidate, { startMin, origin }) == null) continue;
        const meters = guards.modelDistanceMeters(RouteOptimizer, candidate, origin);
        if (!bestPick || meters < bestPick.meters) bestPick = { r, candidate, meters };
      }
    }
    if (!bestPick) return null; // some stop has no feasible position
    seq = bestPick.candidate;
    remaining.splice(bestPick.r, 1);
  }
  return seq;
}

/**
 * Compute the shortest LEGAL order for a tech-day whose Google order failed
 * the window guards. `stops` is the tech-day (the caller has already
 * ensured every stop is geocoded); `guards` supplies the production guard
 * functions and the shared distance model so this module can never drift
 * from what route-reorder.js actually enforces:
 *   { effectiveWindowStart, effectiveWindowRange, violatesWindowChronology,
 *     violatesWindowFeasibility, modelDistanceMeters }
 * Returns { orderedStops, afterMeters, afterSeconds } or null when no
 * feasible order exists (or the winner fails a production guard — belt and
 * suspenders; by construction it should not).
 *
 * `startMin` (default 8am, the nightly day-open) is the simulation's
 * departure clock — the admin optimize endpoints pass the caller's actual ET
 * minute-of-day here for a day already in progress (codex GitHub round P1):
 * simulating from 8am on a day that's really 15:30 already can accept a
 * repair that is no longer drivable in the time remaining.
 */
function computeWindowFitOrder(RouteOptimizer, stops, guards, { startMin = 8 * 60, origin = RouteOptimizer.HQ } = {}) {
  if (!Array.isArray(stops) || stops.length < 2) return null;
  const timed = [];
  const untimed = [];
  for (const s of stops) {
    if (guards.effectiveWindowStart(s) != null) timed.push(s);
    else untimed.push(s);
  }
  // Backbone in promised-start order, as equal-start GROUPS. The sort is
  // stable, so within a group stops keep the caller-supplied order — the
  // caller passes the CURRENT RUNNING order (currentOrder), making the
  // greedy path's tie order deterministic and operator-visible; the
  // exhaustive path explores tie permutations regardless.
  const backbone = [...timed].sort((a, b) => {
    const wa = guards.effectiveWindowStart(a);
    const wb = guards.effectiveWindowStart(b);
    if (wa !== wb) return wa < wb ? -1 : 1;
    return 0;
  });
  const groups = [];
  for (const s of backbone) {
    const start = guards.effectiveWindowStart(s);
    const last = groups[groups.length - 1];
    if (last && last.start === start) last.stops.push(s);
    else groups.push({ start, stops: [s] });
  }
  const groupStops = groups.map((g) => g.stops);

  const groupSizes = groupStops.map((g) => g.length);
  let winner;
  if (sequenceCount(stops.length, backbone.length, groupSizes) <= EXHAUSTIVE_SEQUENCE_CAP) {
    winner = exhaustiveSearch(RouteOptimizer, guards, groupStops, untimed, startMin, origin);
  } else {
    // Greedy path: the stable tie order can be the ONE infeasible
    // permutation of an equal-start group (uncapped audit P1 — the exact
    // case the exhaustive path handles), so first search tie permutations
    // of the BACKBONE ALONE (∏ gᵢ! sequences — tiny next to the full-day
    // count that forced greedy) for the cheapest feasible backbone; a
    // backbone infeasible in EVERY tie order proves the day infeasible
    // (inserting stops only delays). Greedy insertion then works from
    // that backbone; only if even the tie space exceeds the cap do we
    // keep the stable operator-visible order.
    let greedyBackbone = backbone;
    if (backbone.length > 0 && sequenceCount(backbone.length, backbone.length, groupSizes) <= EXHAUSTIVE_SEQUENCE_CAP) {
      const feasibleBackbone = exhaustiveSearch(RouteOptimizer, guards, groupStops, [], startMin, origin);
      if (!feasibleBackbone) return null;
      greedyBackbone = feasibleBackbone;
    }
    winner = greedyInsertion(RouteOptimizer, guards, greedyBackbone, untimed, startMin, origin);
  }
  if (!winner) return null;

  // Owner ruling (2026-08-14): model-authored orders are acceptable BECAUSE
  // every candidate passes the SAME guards a Google order must pass —
  // re-check with the production functions before handing the order back.
  // legs = null is DELIBERATE, not a downgrade (pre-push audit P1 rebutted):
  // Google's legs describe ITS order's sequence — they do not exist for a
  // different permutation, and fetching routed legs per candidate is the
  // fleet-API spend this lane scoped out. The model path is the calibrated
  // two-term drive-time fit under GATE_DRIVE_TIME_CALIBRATION (live in
  // prod, MAE 3.89 min — the underestimation note on the guard describes
  // the LEGACY 30 mph constant), and the promises being protected are
  // 2-hour arrival windows, so the model's error is an order of magnitude
  // inside the slack. Any residual miss is also self-limiting: route_order
  // is a board ordering, the day re-evaluates every night, and dispatch
  // remains human-driven.
  if (guards.violatesWindowChronology(winner, stops)) return null;
  if (guards.violatesWindowFeasibility(RouteOptimizer, winner, stops, null, startMin, origin)) return null;

  const simulation = simulateArrivalRoute(RouteOptimizer, guards.effectiveWindowRange, winner, { startMin, origin });
  if (!simulation) return null;
  return {
    orderedStops: winner,
    afterMeters: guards.modelDistanceMeters(RouteOptimizer, winner, origin),
    afterSeconds: Math.round(simulation.travelMin * 60),
  };
}

module.exports = {
  computeWindowFitOrder,
  effectiveWindowRange,
  currentOrder,
  simulateArrivalRoute,
  computeChronologicalRepair,
  workDuration,
  isCoVisitPair,
  advanceCoVisit,
  startCoVisitChain,
  _internals: { sequenceCount, exhaustiveSearch, greedyInsertion, EXHAUSTIVE_SEQUENCE_CAP },
};
