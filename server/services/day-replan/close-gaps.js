/**
 * Close-gaps measurement (owner 2026-11-18: "open gaps are times when a tech is on the clock ... fill these with
 * jobs, even front load jobs, so we can fill the jobs with organic leads, or leads from ads"; then "shadow, but i want
 * admin notifications"). Pure, no database. It MEASURES only: nothing here changes a visit, a time or a message.
 *
 * The night re-plan (./index.js) stores one record per tech-day in day_replan_plans.close_gaps:
 *   now / packed  The open time of the day as booked, and of the night's best plan, from the app's own simulation:
 *                 the open start before the first stop (from the day's first hour), each wait between stops, the open
 *                 tail to the day's close, the biggest open block, the sellable minutes (blocks of SELLABLE_MIN or
 *                 more) and whether a lunch-length break is left.
 *   p1            "Accept a packed day": would the re-plan take the best plan if it also accepted one that drives no
 *                 more, ends no later, keeps every promise and makes the biggest open block P1_MIN_GAIN minutes
 *                 bigger? Measured on the plan the planner already finds (least drive, then the earlier end), not a
 *                 separate packing search.
 *   p2            "Same customer, different homes": the same-customer lock counted per home (./index.js).
 *   s1            "Book into a block": each stop booked in the last 24 hours, replayed over the whole hours of its day
 *                 with the rest of the day as booked (see replayBooking).
 *   gaps          Each wait of NOTE_MIN minutes or more left in the day as booked, with the lock on the stop after it.
 */
const { planSequence, simulate, promisesKept } = require('./app-sim');

const SELLABLE_MIN = 60;
const NOTE_MIN = 15;
const P1_MIN_GAIN = 30;
const S1_DRIVE_ALLOWANCE_MIN = 5;
const LUNCH = Object.freeze({ startMin: 11 * 60, endMin: 14 * 60, needMin: 30 });
const MAX_BLOCKS = 8;
const RECENT_HOURS = 24;

const toMin = (value) => {
  const [h, m] = String(value).slice(0, 5).split(':').map(Number);
  return h * 60 + m;
};
const sum = (list, pick) => list.reduce((total, item) => total + pick(item), 0);

/**
 * Blocks with every unavailable interval cut out: the technician's schedule blocks and the hours other rows hold
 * (the planner's own blockedHours). A block split by one becomes two pieces of the same kind.
 */
function minusUnavailable(blocks, unavailable = []) {
  let out = blocks;
  for (const u of unavailable) {
    out = out.flatMap((b) => {
      const end = b.startMin + b.min;
      if (u.endMin <= b.startMin || u.startMin >= end) return [b];
      const pieces = [];
      if (u.startMin > b.startMin) pieces.push({ ...b, min: u.startMin - b.startMin });
      if (u.endMin < end) pieces.push({ ...b, startMin: u.endMin, min: end - u.endMin });
      return pieces;
    });
  }
  return out;
}

/**
 * The open blocks of one simulated day: the open start, each wait between stops, and the open tail, less the
 * unavailable intervals in bounds.unavailable.
 */
function openBlocks(sim, { departureMin, openMin, closeMin, unavailable }) {
  const blocks = [];
  let prevDeparture = departureMin;
  sim.arrivals.forEach((a, i) => {
    const reached = prevDeparture + (a.driveMin || 0);
    // The first stop: the van cannot start a job before the day's first hour, so the open start counts from there.
    const from = i === 0 ? Math.max(reached, openMin) : reached;
    const min = a.arrivalMin - from;
    if (min > 0) blocks.push({ kind: i === 0 ? 'start' : 'wait', startMin: from, min, before: a.id });
    // A co-visit continuation leaves no earlier than its sibling; the clock never runs backwards.
    prevDeparture = Math.max(prevDeparture, a.departureMin);
  });
  const tail = closeMin - sim.serviceFinishMin;
  if (tail > 0) blocks.push({ kind: 'tail', startMin: sim.serviceFinishMin, min: tail, before: null });
  return minusUnavailable(blocks, unavailable);
}

const lunchOverlap = (b) => Math.min(b.startMin + b.min, LUNCH.endMin) - Math.max(b.startMin, LUNCH.startMin);

/** Open-time figures of one simulated day, or null with no simulation. */
function openTime(sim, bounds) {
  if (!sim) return null;
  const blocks = openBlocks(sim, bounds);
  const round = (n) => Math.round(n);
  return {
    driveMin: round(sim.travelMin),
    endMin: round(sim.finishMin),
    waitMin: round(sum(blocks.filter((b) => b.kind === 'wait'), (b) => b.min)),
    biggestMin: round(blocks.reduce((max, b) => Math.max(max, b.min), 0)),
    sellableMin: round(sum(blocks.filter((b) => b.min >= SELLABLE_MIN), (b) => b.min)),
    lunch: blocks.some((b) => lunchOverlap(b) >= LUNCH.needMin),
    blocks: blocks.filter((b) => b.min >= NOTE_MIN).slice(0, MAX_BLOCKS)
      .map((b) => ({ kind: b.kind, start: round(b.startMin), min: round(b.min), before: b.before })),
  };
}

/** Simulations of the day as booked and of the planner's best plan (null where it has none). */
/** Schedule blocks the simulator can take (it refuses the whole day on one malformed interval). */
const serviceBlocks = (blocks) => (blocks || [])
  .filter((b) => Number.isFinite(b.startMin) && Number.isFinite(b.endMin) && b.endMin > b.startMin)
  .map((b) => ({ startMin: b.startMin, endMin: b.endMin }));

/**
 * The day as booked and as planned, simulated with the schedule blocks (no drive or service inside one).
 * plannedKept: every promise of the planned day still holds once the blocks push stops later; null with no plan.
 */
function planSims({ groups, currentOrder, best, origin, departureMin, blocks = [], marginMin = 0 }) {
  const blockedIntervals = serviceBlocks(blocks);
  const current = simulate(planSequence(groups, currentOrder), { origin, departureMin, blockedIntervals });
  if (!best) return { current, planned: null, plannedKept: null };
  const seq = planSequence(groups, best.order, best.slots);
  const planned = simulate(seq, { origin, departureMin, blockedIntervals });
  return { current, planned, plannedKept: !!planned && promisesKept(planned, seq, marginMin) };
}

/**
 * P1. `driveRuleAccepts`: the live drive rule already takes this plan, so P1 adds nothing for the day.
 * @returns {{ wouldAccept: boolean, reason: string, gainMin: number|null }}
 */
function packVerdict({ now, packed, kept, driveRuleAccepts }) {
  const gainMin = now && packed ? packed.biggestMin - now.biggestMin : null;
  const no = (reason) => ({ wouldAccept: false, reason, gainMin });
  if (driveRuleAccepts) return no('drive_rule_accepts');
  if (!now || !packed) return no('no_plan');
  if (!kept) return no('promise_missed');
  if (packed.driveMin > now.driveMin) return no('more_drive');
  if (packed.endMin > now.endMin) return no('ends_later');
  if (gainMin < P1_MIN_GAIN) return no('small_gain');
  return { wouldAccept: true, reason: 'bigger_block', gainMin };
}

const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** The hours a plan changes, per co-visit group (ids are each group's first row id). */
function hourChanges(groups, best) {
  if (!best) return [];
  return groups.map((g) => ({ id: g[0].id, from: toMin(g[0].window_start), to: best.slots[g[0].id] }))
    .filter((c) => c.to != null && c.to !== c.from)
    .map((c) => ({ id: c.id, from: hhmm(c.from), to: hhmm(c.to) }));
}

/** Each wait left in the day as booked, with the lock on the stop after it (null: that stop could move). */
function lockedGaps(now, whyById) {
  if (!now) return [];
  return now.blocks.filter((b) => b.kind === 'wait')
    .map((b) => ({ before: b.before, start: b.start, min: b.min, why: whyById.get(String(b.before)) || null }));
}

/**
 * The minutes the stop's booking holds: its window, or with no booked end its estimated duration (else 60), as the
 * occupancy rule (rowHours) and the planner (plannerStop) read it.
 */
const widthOf = (row) => Math.max(1, row.window_end
  ? toMin(row.window_end) - toMin(row.window_start)
  : (Number(row.estimated_duration_minutes) || 60));

/** Last whole start hour whose window (the stop's booked width) still ends by the day's close. */
function lastHour(row, closeMin) {
  return Math.floor((closeMin - widthOf(row)) / 60);
}

/**
 * Whether the replayed stop may take `hour`, by the planner's own occupancy rule: every hour its window covers is free
 * of the hours the day's other stops hold (rowHours, their whole windows) and of the hours other rows hold
 * (blockedHours), and the window does not run into a schedule block.
 */
function hourFree(input, hour) {
  const { group, groups, rowHours, blockedHours = [], blocks = [] } = input;
  const held = new Set(blockedHours);
  for (const g of groups) if (g !== group) for (const r of g) for (const h of rowHours(r)) held.add(h);
  const width = widthOf(group[0]);
  for (let h = hour; h < hour + Math.ceil(width / 60); h += 1) if (held.has(h)) return false;
  return !blocks.some((b) => hour * 60 < b.endMin && hour * 60 + width > b.startMin);
}

/** The replayed stop at startMin with the rest of the day as booked, in time order; null when a promise breaks. */
function tryStart(input, startMin) {
  const { groups, leaderId, origin, marginMin, bounds } = input;
  const startOf = (g) => (String(g[0].id) === String(leaderId) ? startMin : toMin(g[0].window_start));
  const order = groups.map((g, i) => ({ id: g[0].id, start: startOf(g), i }))
    .sort((a, b) => a.start - b.start || a.i - b.i).map((x) => x.id);
  const seq = planSequence(groups, order, { [leaderId]: startMin });
  // With the schedule blocks a late arrival that would run into one is pushed past it, and promisesKept then
  // refuses the hour when that breaks a promise (Codex #7935 r1).
  const sim = simulate(seq, { origin, departureMin: bounds.departureMin, blockedIntervals: serviceBlocks(input.blocks) });
  if (!sim || !promisesKept(sim, seq, marginMin)) return null;
  const fig = openTime(sim, bounds);
  return { start: hhmm(startMin), startMin, driveMin: fig.driveMin, waitMin: fig.waitMin, sellableMin: fig.sellableMin, biggestMin: fig.biggestMin };
}

const prefOk = (pref, startMin) => !pref || (startMin >= pref.startMin && startMin < pref.endMin);
const strip = (fit) => (fit ? {
  start: fit.start, driveMin: fit.driveMin, waitMin: fit.waitMin, sellableMin: fit.sellableMin, biggestMin: fit.biggestMin,
} : null);

/**
 * S1 for one stop booked in the last 24 hours, with the rest of the day as booked: the time it was booked at, the
 * whole hour with the least drive (today's picker ranks by added drive; only hours the planner's occupancy rule
 * leaves free, see hourFree), and the hour a block-aware picker would
 * offer, which is, within S1_DRIVE_ALLOWANCE_MIN of that least drive, the hour that front-loads the day ("even front
 * load jobs"): the least waiting between stops, then the biggest open block, then less drive, then earlier. Waiting
 * comes first because the biggest block alone would push a job to the end of the day and leave the wait at midday;
 * the sellable total alone cannot tell a 6-hour afternoon from one split 4 + 2. Hours outside the stop's customer
 * window are not tried.
 */
function replayBooking(input) {
  const { group, pref, bounds } = input;
  const lead = group[0];
  const run = (startMin) => tryStart({ ...input, leaderId: lead.id }, startMin);
  const bookedMin = toMin(lead.window_start);
  const tried = [];
  for (let hour = Math.ceil(bounds.openMin / 60); hour <= lastHour(lead, bounds.closeMin); hour += 1) {
    const fit = prefOk(pref, hour * 60) && hourFree(input, hour) ? run(hour * 60) : null;
    if (fit) tried.push(fit);
  }
  const asBooked = tried.find((t) => t.startMin === bookedMin) || run(bookedMin);
  const base = { id: lead.id, source: lead.source_action || null, booked: strip(asBooked) };
  if (!tried.length) return { ...base, leastDrive: null, s1: null, differs: false };
  const leastDrive = [...tried].sort((a, b) => a.driveMin - b.driveMin || a.startMin - b.startMin)[0];
  const s1 = tried.filter((t) => t.driveMin <= leastDrive.driveMin + S1_DRIVE_ALLOWANCE_MIN)
    .sort((a, b) => a.waitMin - b.waitMin || b.biggestMin - a.biggestMin || a.driveMin - b.driveMin || a.startMin - b.startMin)[0];
  return { ...base, leastDrive: strip(leastDrive), s1: strip(s1), differs: s1.startMin !== bookedMin };
}

/** A stop booked in the last RECENT_HOURS: not a series visit made from a plan, and not a co-visit sibling. */
function recentlyBooked(group, now) {
  const lead = group[0];
  const created = lead.created_at ? new Date(lead.created_at) : null;
  if (!created || Number.isNaN(created.getTime())) return false;
  if (now - created > RECENT_HOURS * 3600 * 1000) return false;
  return !(lead.is_recurring === true && lead.recurring_parent_id != null);
}

/** The co-visit groups of the day booked in the last 24 hours. */
const recentGroups = (groups, now) => groups.filter((g) => recentlyBooked(g, now));

/**
 * S1 for every stop of the day booked in the last 24 hours (empty when none). prefById: each leader's customer window
 * (null = none); `false` = the window could not be read, and that booking is not replayed.
 */
function replayRecentBookings({ groups, prefById, now, ...rest }) {
  return recentGroups(groups, now).filter((g) => prefById.get(String(g[0].id)) !== false)
    .map((group) => replayBooking({ ...rest, groups, group, pref: prefById.get(String(group[0].id)) || null }));
}

module.exports = {
  openTime, planSims, packVerdict, hourChanges, lockedGaps, replayRecentBookings, recentGroups,
  SELLABLE_MIN, P1_MIN_GAIN, S1_DRIVE_ALLOWANCE_MIN,
  _internals: { openBlocks, minusUnavailable, replayBooking, recentlyBooked, lastHour, tryStart, hourFree },
};
