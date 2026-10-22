/**
 * Slide offers — let a new booking take an hour that is already booked when
 * the day routes better with one or two existing stops slid to another time
 * (owner request 2026-10-22, after a Sat 10-24 Osprey booking landed at 1 PM
 * behind two Sarasota stops when 11 AM would have halved the day's driving).
 *
 * Owner rulings 2026-10-22, encoded below:
 *   - Any appointment may be slid (customer-picked, recurring, one-off).
 *   - At most MAX_SLIDES (2) existing stops slid per booking.
 *   - Slides go earlier OR later, bounded by MAX_SLIDE_MINUTES either way.
 *   - Allowed inside 72h (no reminder freeze — the 24h reminder carries the
 *     new time; that is an owner call, not this module's).
 *   - Every slide lands on the hour (window_start is always HH:00); an
 *     off-hour legacy stop (assessment, re-service) slides onto the grid.
 *   - Offered only when the whole day's drive beats the best plain (no-slide)
 *     insertion by BOTH MIN_SAVING_MINUTES and MIN_SAVING_MILES.
 *
 * Pure and synchronous: no DB, no gate reads. The caller resolves the tech-
 * day's stops and decides what is movable (locked / en-route / completed /
 * grouped visits pass movable:false). Pair feasibility is travel-gap.js's
 * own predicate (drive + buffer from the earlier side's expected end), the
 * same rule the commit gates enforce, so a slide arrangement this module
 * accepts is one the commit side would accept stop-by-stop.
 *
 * Deliberate boundaries:
 *   - Any coordless stop on the day (or a coordless new stop) ⇒ no offers.
 *     driveMin() scores a coordless leg as 0, which would make sliding
 *     through it look free (route-reorder.js refuses such days the same way).
 *   - Pairs that already sat side by side at the same times before the slide
 *     are not re-checked: existing legs that pre-date the travel-gap rule are
 *     the calendar's problem, not a reason to refuse an improvement.
 *   - No new day capacity: if the new stop has no plain open hour at all, no
 *     slide is offered (there is no baseline to beat).
 */
const { driveMin, haversine } = require('../auto-dispatch/geo');
const { travelGapViolation } = require('./travel-gap');

const MAX_SLIDES = 2;
const MAX_SLIDE_MINUTES = 120;
const HOUR_STEP_MINUTES = 60;
const MIN_SAVING_MINUTES = 6;
const MIN_SAVING_MILES = 0.5;
// Hard ceiling on arrangements scored per tech-day. This runs synchronously
// on customer booking requests: a typical day costs a few thousand, a
// dense one with many movable stops far more. Past the
// budget the search stops and reports what it found so far (truncated).
const MAX_EVALUATIONS = 20000;
const NEW_ID = '__new__';
const ADMIT_ALL = () => true;

function hasCoords(p) {
  return !!p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng))
    && p.lat != null && p.lng != null;
}

function milesBetween(a, b) {
  return haversine(Number(a.lat), Number(a.lng), Number(b.lat), Number(b.lng));
}

// Drive minutes + straight-line miles for home → stops (by start) → home.
function routeCost(stops, home) {
  const ordered = [...stops].sort((a, b) => a.startMin - b.startMin);
  const points = [home, ...ordered, home];
  let minutes = 0;
  let miles = 0;
  for (let i = 0; i < points.length - 1; i++) {
    minutes += driveMin(points[i], points[i + 1]);
    miles += milesBetween(points[i], points[i + 1]);
  }
  return { minutes, miles };
}

const pairKey = (a, b) => `${a.id}@${a.startMin}|${b.id}@${b.startMin}`;

function originalPairs(stops) {
  const ordered = [...stops].sort((a, b) => a.startMin - b.startMin);
  const keys = new Set();
  for (let i = 0; i < ordered.length - 1; i++) keys.add(pairKey(ordered[i], ordered[i + 1]));
  return keys;
}

// A whole arrangement is feasible when every consecutive pair that is NEW to
// this arrangement clears travel-gap.js's rule, every changed stop fits the
// day and its start floors, and a changed stop that becomes the day's first
// (last) stop can be reached from (can return to) home — the same HQ legs
// find-time's leading/trailing gaps reserve.
function changedStopFits(s, { dayOpen, dayClose, admits, startFloorMin, newStartFloorMin }) {
  const isNew = s.id === NEW_ID;
  if (s.startMin < dayOpen || s.endMin > dayClose) return false;
  if (s.startMin < startFloorMin || (isNew && s.startMin < newStartFloorMin)) return false;
  // offHour is the stop's ORIGINAL classification: an off-hour assessment
  // shifted onto the hour keeps its off-hour admission rule.
  return admits({ startMin: s.startMin, endMin: s.endMin, isNew, offHour: s.offHour === true });
}

// A changed stop against other technicians' committed stops, the way the
// callers' tech-blind collision check (travel-gap.js travelGapConflicts)
// measures it: any raw overlap with a blocker clashes, and the travel gap
// applies only where a blocker is the changed stop's IMMEDIATE neighbour in
// the combined day (own stops + blockers) — never a farther blocker with a
// stop in between.
const overlaps = (a, b) => a.startMin < b.endMin && b.startMin < a.endMin;
function clashesWithBlocker(s, ordered, { blockers, pairViolates }) {
  if (!blockers.length) return false;
  if (blockers.some((b) => overlaps(s, b))) return true;
  const combined = [...ordered, ...blockers.map((b) => ({ ...b, blocker: true }))]
    .sort((a, b) => a.startMin - b.startMin);
  const at = combined.findIndex((x) => x.id === s.id && !x.blocker);
  const prev = combined[at - 1];
  const next = combined[at + 1];
  return Boolean((prev?.blocker && pairViolates(prev, s)) || (next?.blocker && pairViolates(s, next)));
}

function arrangementFeasible(stops, day) {
  const { home, dayOpen, dayClose, grandfathered, changedIds, pairViolates } = day;
  const ordered = [...stops].sort((a, b) => a.startMin - b.startMin);
  if (ordered.some((s) => changedIds.has(s.id) && !changedStopFits(s, day))) return false;
  if (ordered.some((s) => changedIds.has(s.id) && clashesWithBlocker(s, ordered, day))) return false;
  const first = ordered[0];
  if (first && changedIds.has(first.id) && first.startMin < dayOpen + driveMin(home, first)) return false;
  const last = ordered[ordered.length - 1];
  if (last && changedIds.has(last.id) && last.endMin + driveMin(last, home) > dayClose) return false;
  for (let i = 0; i < ordered.length - 1; i++) {
    const a = ordered[i];
    const b = ordered[i + 1];
    if (grandfathered.has(pairKey(a, b))) continue;
    if (pairViolates(a, b)) return false;
  }
  // Non-adjacent overlaps can't happen once adjacent pairs are clean and
  // windows are sorted by start, except when one window swallows another —
  // check that explicitly.
  // Unchanged pairs are grandfathered here too: the co-timed members of an
  // existing grouped stop overlap each other by design.
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 2; j < ordered.length; j++) {
      if (!changedIds.has(ordered[i].id) && !changedIds.has(ordered[j].id)) continue;
      if (ordered[i].endMin > ordered[j].startMin) return false;
    }
  }
  return true;
}

// Every slide destination starts on the hour (AGENTS.md: window_start is
// always HH:00 — the canonical writers reject :15/:30 starts), within
// MAX_SLIDE_MINUTES of the stop's current start. An off-hour legacy row
// (assessment / re-service) may slide, but only onto the hour grid.
function shiftOptions(stop) {
  const out = [];
  const lo = Math.ceil((stop.startMin - MAX_SLIDE_MINUTES) / HOUR_STEP_MINUTES) * HOUR_STEP_MINUTES;
  for (let to = lo; to <= stop.startMin + MAX_SLIDE_MINUTES; to += HOUR_STEP_MINUTES) {
    if (to !== stop.startMin) out.push(to - stop.startMin);
  }
  return out;
}

function combinations(items, k) {
  if (k === 1) return items.map((x) => [x]);
  const out = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) out.push([items[i], items[j]]);
  }
  return out;
}

// Every way to shift the given stops (cartesian product of their options).
function shiftAssignments(group) {
  let acc = [[]];
  for (const stop of group) {
    const next = [];
    for (const partial of acc) {
      for (const d of shiftOptions(stop)) next.push([...partial, { stop, delta: d }]);
    }
    acc = next;
  }
  return acc;
}

function candidateStarts(durationMinutes, dayOpen, dayClose) {
  const starts = [];
  const first = Math.ceil(dayOpen / HOUR_STEP_MINUTES) * HOUR_STEP_MINUTES;
  for (let s = first; s + durationMinutes <= dayClose; s += HOUR_STEP_MINUTES) starts.push(s);
  return starts;
}

/**
 * @param {Object} p
 * @param {Array<{id, lat, lng, startMin, endMin, expectedMinutes?, movable?}>} p.stops
 *   The tech-day's committed stops (minutes from midnight). movable defaults false.
 * @param {{lat, lng, expectedMinutes?}} p.newStop
 * @param {number} p.durationMinutes  New stop's window length.
 * @param {{lat, lng}} p.home         Route start/end point.
 * @param {number} p.dayOpen          Minutes from midnight (e.g. 480).
 * @param {number} p.dayClose
 * @param {Function} [p.admits]       ({startMin, endMin, isNew}) → boolean: the
 *   caller's booking-window rule (hour grid, lunch block, last start) for the
 *   new stop and for each slid stop's NEW window. Default admits everything.
 * @param {number} [p.startFloorMin=0]    No changed stop (new or slid) may start
 *   before this — "now + lead" on today. A stop already starting before it is
 *   never slid.
 * @param {number} [p.newStartFloorMin=0] The new stop's own lower bound (the
 *   caller's earliest-start preference); slid stops ignore it.
 * @param {{remaining: number, deadline?: number}} [p.budget] Shared budget
 *   across a caller's tech-days: `remaining` arrangements (decremented in
 *   place) and an optional Date.now() `deadline`. Each day also stops at
 *   MAX_EVALUATIONS.
 * @param {Array<{id, startMin, endMin, lat?, lng?, expectedMinutes?}>} [p.blockers] Other
 *   technicians' committed stops that day. Never moved and never part of
 *   this route's cost, but no changed stop may clash with one.
 * @param {Function} [p.pairViolates] (early, late) → truthy when the pair
 *   can't sit side by side. Default travel-gap.js travelGapViolation; a
 *   caller with GATE_SLOT_TRAVEL_GAP off passes plain overlap.
 * @returns {{ reason: string|null, baseline: Object|null, offers: Array, truncated?: true }}
 *   offers: one per new-stop start (best saving for that start), sorted by
 *   saving desc: { startMin, endMin, slides: [{id, fromStartMin, toStartMin}],
 *   driveMinutes, miles, savedMinutes, savedMiles }.
 */
function findSlideOffers({
  stops, newStop, durationMinutes, home, dayOpen, dayClose, admits = ADMIT_ALL,
  startFloorMin = 0, newStartFloorMin = 0, budget = { remaining: MAX_EVALUATIONS },
  pairViolates = travelGapViolation, blockers = [],
}) {
  const none = (reason, baseline = null) => ({ reason, baseline, offers: [] });
  if (!hasCoords(newStop) || !hasCoords(home)) return none('NEW_STOP_COORDLESS');
  if (!Array.isArray(stops) || stops.length === 0) return none('EMPTY_DAY');
  if (stops.some((s) => !hasCoords(s))) return none('COORDLESS_STOPS');

  const base = stops.map((s) => ({
    ...s,
    movable: s.movable === true && s.startMin >= startFloorMin,
    offHour: s.startMin % HOUR_STEP_MINUTES !== 0,
  }));
  const day = {
    base,
    home,
    dayOpen,
    dayClose,
    admits,
    startFloorMin,
    newStartFloorMin,
    pairViolates,
    blockers,
    grandfathered: originalPairs(base),
    starts: candidateStarts(durationMinutes, dayOpen, dayClose),
    makeNew: (startMin) => ({
      id: NEW_ID,
      lat: newStop.lat,
      lng: newStop.lng,
      startMin,
      endMin: startMin + durationMinutes,
      ...(Number.isFinite(newStop.expectedMinutes) ? { expectedMinutes: newStop.expectedMinutes } : {}),
    }),
  };

  const { baseline, plainStarts } = bestPlainInsertion(day);
  if (!baseline) return none('NO_PLAIN_SLOT');
  const movable = base.filter((s) => s.movable);
  if (movable.length === 0) return none('NOTHING_MOVABLE', baseline);

  const { bestByStart, truncated } = bestSlidesByStart(day, baseline, movable, { plainStarts, budget });
  const offers = [...bestByStart.values()]
    .sort((a, b) => b.savedMinutes - a.savedMinutes || a.startMin - b.startMin);
  return {
    reason: offers.length ? null : 'NO_SAVING', baseline, offers, ...(truncated ? { truncated: true } : {}),
  };
}

// Cost of `stops` plus the new stop at startMin, or null when infeasible.
function costWithNewStop(day, stops, startMin, changedIds) {
  const arrangement = [...stops, day.makeNew(startMin)];
  if (!arrangementFeasible(arrangement, { ...day, changedIds })) return null;
  return routeCost(arrangement, day.home);
}

// Best plain insertion — the cheapest slot the customer can already book —
// plus every start that is bookable without a slide (never a slide offer:
// that hour needs no one moved).
function bestPlainInsertion(day) {
  const changedIds = new Set([NEW_ID]);
  const plainStarts = new Set();
  let baseline = null;
  for (const startMin of day.starts) {
    const cost = costWithNewStop(day, day.base, startMin, changedIds);
    if (!cost) continue;
    plainStarts.add(startMin);
    // driveMin rounds each leg to whole minutes, so equal-minute plain
    // routes are common — break the tie on miles so both saving floors are
    // measured against the real best plain alternative.
    if (!baseline || cost.minutes < baseline.driveMinutes
      || (cost.minutes === baseline.driveMinutes && cost.miles < baseline.miles)) {
      baseline = { startMin, driveMinutes: cost.minutes, miles: cost.miles };
    }
  }
  return { baseline, plainStarts };
}

// Bigger saving wins; on a tie, fewer slides.
function beats(offer, prior) {
  if (!prior) return true;
  if (offer.savedMinutes !== prior.savedMinutes) return offer.savedMinutes > prior.savedMinutes;
  return offer.slides.length < prior.slides.length;
}

// For each new-stop start that is NOT already plainly bookable, the best
// slide arrangement that clears the saving floor against the plain baseline.
function bestSlidesByStart(day, baseline, movable, { plainStarts, budget }) {
  const slideStarts = day.starts.filter((startMin) => !plainStarts.has(startMin));
  const limit = Math.min(MAX_EVALUATIONS, Math.max(0, budget.remaining));
  const groups = [];
  for (let k = 1; k <= Math.min(MAX_SLIDES, movable.length); k++) groups.push(...combinations(movable, k));

  const bestByStart = new Map();
  let evaluations = 0;
  for (const group of groups) {
    for (const assignment of shiftAssignments(group)) {
      if (evaluations >= limit || (budget.deadline && Date.now() >= budget.deadline)) {
        budget.remaining -= evaluations;
        return { bestByStart, truncated: true };
      }
      evaluations += slideStarts.length;
      const movedById = new Map(assignment.map(({ stop, delta }) => [stop.id, {
        ...stop, startMin: stop.startMin + delta, endMin: stop.endMin + delta,
      }]));
      const slid = day.base.map((s) => movedById.get(s.id) || s);
      const changedIds = new Set([NEW_ID, ...movedById.keys()]);
      for (const startMin of slideStarts) {
        const cost = costWithNewStop(day, slid, startMin, changedIds);
        if (!cost) continue;
        const offer = {
          startMin,
          endMin: day.makeNew(startMin).endMin,
          slides: assignment.map(({ stop, delta }) => ({
            id: stop.id, fromStartMin: stop.startMin, toStartMin: stop.startMin + delta,
          })),
          driveMinutes: cost.minutes,
          miles: cost.miles,
          savedMinutes: baseline.driveMinutes - cost.minutes,
          savedMiles: baseline.miles - cost.miles,
        };
        if (offer.savedMinutes < MIN_SAVING_MINUTES || offer.savedMiles < MIN_SAVING_MILES) continue;
        if (beats(offer, bestByStart.get(startMin))) bestByStart.set(startMin, offer);
      }
    }
  }
  budget.remaining -= evaluations;
  return { bestByStart, truncated: false };
}

module.exports = {
  findSlideOffers,
  MAX_SLIDES,
  MAX_SLIDE_MINUTES,
  MIN_SAVING_MINUTES,
  MIN_SAVING_MILES,
  MAX_EVALUATIONS,
};
