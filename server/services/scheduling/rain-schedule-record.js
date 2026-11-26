/**
 * Schedule rain record. Owner 2026-11-23, plan v2: "a 2 PM decision the day before; reorder the day first; move a visit
 * to another day only when the whole day is wet [replaced 2026-11-26: see day_move below]; a move is one-off and never shifts the plan series; at most 10 moves
 * a day, one per visit; 2 weeks of test mode first (no texts, no moves)."
 *
 * This module RECORDS what that rain rule would do to tomorrow's schedule. It changes nothing. It writes only its own
 * system_settings rows (schedule.rain_record.*): no scheduled_services row or other visit table, no text, no email and
 * no admin notification. It is not behind a gate for that reason: it can reach no customer, move no visit, spend no
 * money. Both weather reads are free: the NWS hourly forecast (getNwsHourlyRain, never the paid Open-Meteo backup the
 * booking pages fall back to) and the IEM airport hourly gauges (scheduling/work-hour-rain.js). Nothing here
 * geocodes, asks for a road time or calls Google or any map service: a visit's point is the one stored on the visit
 * (rain-pass loadPoints), and a day move is planned from the occupancy snapshot alone, with no drive estimate. Travel
 * time between proposed moves is not checked (record only).
 *
 * What it reuses, and does not rewrite:
 *   - auto-dispatch/rain-pass.js planRainPass: the live outdoor visits of the day, each one's hourly rain over its work
 *     span plus RAIN_AFTER_HOURS (MOVE_PCT 70), shared stops as one physical stop, and the nearest dry open hour on
 *     the same date (DRY_PCT 40, the technician's other stops respected). loadStops, candidateStarts and spanRain come
 *     from the same file.
 *   - ads/rain-mode.js: RAIN_HOURS (the wet-area rule the day grade uses), the score give-up days, and the pattern: 'last' / 'history' / 'days' settings keys, a
 *     decision frozen at the 2 PM cutoff, a later run that rechecks beside it.
 *   - rain-out.js loadOccupancy / conflictsForTarget (one snapshot, read-only) and scheduling/blackout-dates.js
 *     getBlackoutDates (strict: a failed read stops the run), for a day move.
 *
 * One run (cron 'schedule-rain-record', 6:06, 14:06 and 15:06 ET):
 *   1. picks the target day: from 2 PM ET the next work day (Monday to Saturday); before 2 PM today. The 14:06 run is
 *      the CUTOFF, and only for the calendar day before the target (Saturday's run does not cut off Monday; Sunday's
 *      does); the 15:06 run only retries a cutoff that failed. The 6:06 run on the day itself is a RECHECK.
 *      Stops are judged in order, and a target hour or day taken by an earlier proposal for the same technician is not
 *      offered again. A stop that starts soon is judged too: the 2-hour lead of rain-pass is about its notices.
 *   2. for each outdoor visit of that day, in order of start then id, proposes the first that applies:
 *        reorder   a same-day re-time to a LATER dry open hour (owner 2026-11-26: rain texts move a visit later the same
 *                  day, never earlier): rain-pass's nearest one if later, else the nearest later one.
 *        day_move  only when no LATER dry open hour exists that day, whatever the rest of the day reads (owner 2026-11-26, per
 *                  visit: later the same day, then the next work day, then the call list; this replaces the plan v2 rule
 *                  that only a wholly wet day moves): the NEXT WORK DAY only (Monday to Saturday, a closure day is
 *                  skipped) at a start where its technician is free for the visit's own length and the span reads below DRY_PCT. `plan_moves` names
 *                  what the move does to the plan: 'whole_plan' for a recurring visit (owner 2026-11-26: a rain-out move
 *                  shifts the whole plan), 'one_visit' otherwise and for a lawn round moved 7 days or less
 *                  (lawn-rounds.js datesMoveSeries). Recorded only.
 *        call_list a wet visit with no later dry slot that day and none on the next work day: it would go to the office call
 *                  list, not a text. Unread forecast hours on that day keep it unread_forecast, never call_list.
 *        none      a visit whose forecast or point could not be read, a next-work-day scan with no work day in it
 *                  (reason no_work_day_in_scan: unresolved, and the day is not frozen), or one with an hour (a later start that day or the next
 *                  work day) that has no reading and none read wet. The reason is kept. Unread is never dry.
 *      At most MAX_PROPOSALS (10) reorders and day moves per target day, one per physical stop. A visit past the cap
 *      is recorded as `cap` with what it would have been.
 *   3. freezes the cutoff proposals on the day's row. The recheck is kept beside them and never replaces them.
 *   4. scores past days against the measured rain in the visit's own hours (work-hour-rain.js: the nearest airport
 *      gauges to the visit's point, hourly): wet = measurable rain (0.01 in) in any hour from the visit's start through
 *      RAIN_AFTER_HOURS after its end. A reorder, day move or call_list on a wet visit is a hit, on a dry visit a false
 *      alarm; a none or cap on a wet visit is a miss, on a dry visit ok. An hour no gauge reported is unread, never dry:
 *      the day waits (SCORE_GIVE_UP_DAYS), then the visits read decide. Visits are stored by id, span, gauge IDs and the
 *      forecast hours the decision used (no name, address or coordinates); grading never reads a visit's point again. The score also grades the day
 *      per forecast area (`day`: wet_areas, wet_day). Days the first grader scored from a DAILY radar total are graded
 *      again, and that score stays on the row as score_daily.
 *   5. keeps the forecast numbers: each entry (cutoff, recheck) holds `chances`, per forecast area the NWS chance of each
 *      work hour, and each visit its peak (a forecast_dry visit too) and `span`, so a past day can be replayed.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { getNwsHourlyRain, getNwsHourlyRainPatient } = require('../weather-forecast');
const rainPass = require('../auto-dispatch/rain-pass');
const rainMode = require('../ads/rain-mode');
const workHours = require('./work-hour-rain');
const { withCatalogKeys, RAIN_AFTER_HOURS } = require('./rain-fit');
const { loadSeriesRows, planMovesOf } = require('./rain-plan-moves');
const { DAY_OPEN, DAY_CLOSE } = require('../auto-dispatch/candidate-slots');
const { ZONE_COORDS } = require('./forecast-zones');
const { etDateString, etParts, addETDays, parseETDateTime } = require('../../utils/datetime-et');

const LAST_KEY = 'schedule.rain_record.last';
const HISTORY_KEY = 'schedule.rain_record.history';
const DAYS_KEY = 'schedule.rain_record.days';
const HISTORY_MAX = 60; // 3 runs a day: about 20 days
const DAYS_MAX = 90;
// Owner plan v2: at most 10 moves a day.
const MAX_PROPOSALS = 10;
const CUTOFF_HOUR = 14;
// A day-move target needs its hour read below DRY_PCT through the drying hours, as rain-pass reads a same-day hour.
const { DRY_PCT } = rainPass;
const ACTIONS = new Set(['reorder', 'day_move']);
// A call_list would not be a move but is a rain call all the same: graded like one.
const RAIN_CALLS = new Set([...ACTIONS, 'call_list']);
// The next work day is looked for this many days ahead (a Friday cutoff: Saturday; a closure week can push it further).
const NEXT_WORK_SCAN = 8;

const toMin = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const toHHMM = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const plusDays = (day, n) => etDateString(addETDays(parseETDateTime(`${day}T12:00`), n));
const dayOfWeek = (day) => etParts(parseETDateTime(`${day}T12:00`)).dayOfWeek;

function parseJson(v, fallback) {
  if (v && typeof v === 'object') return v;
  if (typeof v !== 'string') return fallback;
  try { return JSON.parse(v) ?? fallback; } catch { return fallback; }
}

/**
 * The day this run is about and what the run is: { day, kind }. From 2 PM ET the next work day, else today; a Sunday
 * is no work day, so it moves to Monday. kind: 'cutoff' (from 2 PM, and only the calendar day before the target: the
 * 2 PM Saturday run is not Monday's cutoff, the Sunday one is), 'recheck' (the day itself), or 'none' (a run that
 * looks further ahead: nothing is decided yet, the run only scores).
 */
function targetDay(now) {
  const today = etDateString(now);
  const { hour } = etParts(now);
  let day = hour >= CUTOFF_HOUR ? plusDays(today, 1) : today;
  if (dayOfWeek(day) === 0) day = plusDays(day, 1);
  let kind = 'none';
  if (day === today) kind = 'recheck';
  else if (hour >= CUTOFF_HOUR && day === plusDays(today, 1)) kind = 'cutoff';
  return { day, kind, today };
}

// NWS only, the patient read (long wait, one retry; nobody waits on this cron). One snapshot per visit point per run: rain-pass's
// verdict (wet, peak) and this record's alternatives for the same visit read the same hours, so they cannot disagree. A read
// that failed stays failed for the run (unread), and the next run asks again.
function nwsReader(read) {
  const snapshots = new Map();
  return (lat, lng) => {
    const key = `${lat},${lng}`;
    if (!snapshots.has(key)) snapshots.set(key, Promise.resolve().then(() => getNwsHourlyRainPatient(lat, lng, { read })));
    return snapshots.get(key);
  };
}

const overlaps = (a, b) => a.start < b.end && b.start < a.end;
const techOf = (row) => (row.visit.technician_id == null ? null : String(row.visit.technician_id));

/**
 * True when a target already accepted for this day's proposals holds the technician at that time. The same test the
 * occupancy probe applies: with GATE_MULTI_TECH_CONFIRM on, only the same technician's route and unassigned stops
 * conflict; off, an overlap on any technician does.
 */
const clashes = (taken, tech, date, start, end) => {
  const scoped = tech != null && require('./occupancy').techScopedConfirmActive();
  return taken.some((t) => t.date === date && (!scoped || t.tech == null || t.tech === tech) && overlaps(t, { start, end }));
};

/**
 * The next work day after the planned date (owner 2026-11-26: a texted rain move lands later the same day or the next work
 * day): Monday to Saturday, not a closure day (the strict blackout reader: a failed read throws, never fails open). null
 * when none falls in NEXT_WORK_SCAN days.
 */
async function nextWorkDay(day, ctx) {
  const dates = Array.from({ length: NEXT_WORK_SCAN }, (_, i) => plusDays(day, i + 1));
  let closed;
  try {
    closed = await ctx.blackouts(dates[0], dates[dates.length - 1]);
  } catch (err) {
    // An unreadable closure list stops the move, never lets one onto a closed day: the run's problem, so nothing
    // freezes and the retry decides again.
    err.planning = true;
    throw err;
  }
  return dates.find((date) => dayOfWeek(date) !== 0 && !closed.has(date)) || null;
}

/**
 * The dry, free start on the next work day, from free read-only data only: the earliest start (on the hour, inside
 * DAY_OPEN to DAY_CLOSE) where the visit's own length is free for its technician (the occupancy snapshot, with the same
 * technician scoping as the probe) and not held by a target accepted earlier, and whose span plus the drying hours reads
 * fully below DRY_PCT at the visit's stored point. { target, unread }: `unread` is true when no start qualified and a free
 * span could not be judged for want of an hour's reading. No next work day = no target, not unread. Travel time between
 * proposed moves is not checked.
 */
async function dryDayFor(row, hourly, ctx) {
  const { day, taken, occupied } = ctx;
  const length = row.visit.reach.endMin - row.visit.reach.startMin;
  const date = await nextWorkDay(day, ctx);
  // No work day inside the scan: nothing was judged, so the caller must not read this as "no dry slot".
  if (!date) return { target: null, unread: false, exhausted: true };
  // `date` and the hours the search judged ride back with every outcome, so the proposal can store them.
  let unread = false;
  for (let start = DAY_OPEN; start + length <= DAY_CLOSE; start += 60) {
    if (occupied(row.visit, date, start, start + length) || clashes(taken, techOf(row), date, start, start + length)) continue;
    const rain = rainPass.spanRain(hourly, date, start, start + length);
    if (rain.complete && rain.peak < DRY_PCT) return { target: { date, start: toHHMM(start), end: start + length, startMin: start }, unread: false, date };
    // A reading at or above DRY_PCT settles the hour as not dry; only a missing hour leaves it undecided.
    if (!rain.complete && !(rain.peak >= DRY_PCT)) unread = true;
  }
  return { target: null, unread, date };
}

/**
 * The same-day hour this reorder takes: the nearest start LATER than the visit's own whose hours and drying hours read dry
 * on `hourly` (the visit's one forecast snapshot), that is open and not held by an earlier proposal. null when none is left;
 * the visit then goes on to the next work day or the call list.
 */
async function reorderStart(row, ctx, hourly) {
  const { day, taken } = ctx;
  // Owner 2026-11-26: a rain text moves a visit to LATER the same day only (morning rain: afternoon). rain-pass's own proposal
  // is not used: it was judged on an earlier read and may be an earlier hour; the search below walks later starts on the
  // visit's one snapshot, so the whole decision reads the same hours.
  if (!Array.isArray(hourly)) return null;
  // The nearest later start whose own hours and drying hours read fully below DRY_PCT and are free (the earliest, as every
  // candidate is later than the visit's own start).
  for (const c of laterStarts(row, ctx)) {
    const rain = rainPass.spanRain(hourly, day, c.start, c.end);
    if (rain.complete && rain.peak < DRY_PCT && !ctx.occupied(row.visit, day, c.start, c.end) && !clashes(taken, techOf(row), day, c.start, c.end)) return c.own;
  }
  return null;
}

/**
 * The same-day starts a reorder may take, from ONE list that the dry-hour search and the unread check both walk: rain-pass's
 * own candidate walk (candidateStarts: grouped offsets, duration limits, earliest start), kept to those LATER than the
 * visit's own start (owner 2026-11-26). `own` is the stop's own start; `start` and `end` its whole span.
 */
function laterStarts(row, ctx) {
  const { reach } = row.visit;
  return rainPass.candidateStarts({ reach, earliestMin: ctx.earliestMin, dayStartMin: ctx.dayHours.startMin, dayEndMin: ctx.dayHours.endMin })
    .filter((c) => c.own > reach.ownStartMin);
}

/**
 * True when a later same-day start that is free for the visit has an hour with no reading and no hour read wet: the day
 * could not be called without a dry hour. (A reading at or above DRY_PCT settles that start as not dry.)
 */
function laterHourUnread(row, hourly, ctx) {
  const { day, taken } = ctx;
  return laterStarts(row, ctx).some((c) => {
    if (ctx.occupied(row.visit, day, c.start, c.end) || clashes(taken, techOf(row), day, c.start, c.end)) return false;
    const rain = rainPass.spanRain(hourly, day, c.start, c.end);
    return !rain.complete && !(rain.peak >= DRY_PCT);
  });
}

/** What every proposal of a visit carries. `span`: the visit's own minutes, so a past day can be graded on the rain in its hours;
 *  `gauges`: the airport gauges to grade it by. */
function baseOf(row) {
  const base = { id: String(row.visit.id), start: row.start, span: [row.visit.reach.startMin, row.visit.reach.endMin] };
  if (row.visit.memberIds?.length > 1) base.stop_ids = row.visit.memberIds;
  // The gauges the grade will read, nearest first, fixed at decision time: grading never looks at the visit's point again,
  // and no coordinates are stored.
  const point = row.visit.point;
  if (point && Number.isFinite(point.lat) && Number.isFinite(point.lng)) base.gauges = workHours.stationsNear(point);
  return base;
}

/**
 * One visit's proposal (a dry visit is none/forecast_dry), or null when it is not outdoor. `open` is false once the day's cap is used.
 */
async function proposeFor(row, ctx) {
  const { day, read, open, taken } = ctx;
  const base = baseOf(row);
  if (['no_point', 'no_forecast', 'error'].includes(row.reason)) {
    return { ...base, decision: 'none', reason: row.reason === 'no_forecast' ? 'unread_forecast' : row.reason };
  }
  if (!row.wet) {
    // A visit the forecast reads dry is stored too, as none/forecast_dry: a rain the forecast missed scores as a miss.
    // Only a span read in full is dry; an hour with no reading is unread. The peak is kept for the replay.
    if (row.peak != null) base.peak = row.peak;
    // The hours behind that verdict: the run's one snapshot of the visit's point (the same read rain-pass judged), as read.
    const seen = row.visit.point ? await read(row.visit.point.lat, row.visit.point.lng) : null;
    if (Array.isArray(seen)) base.span_chances = workHours.spanChances(seen, day, base.span[0], base.span[1], RAIN_AFTER_HOURS);
    return { ...base, decision: 'none', reason: row.dry === true ? 'forecast_dry' : 'unread_forecast' };
  }
  base.peak = row.peak;
  const { reach } = row.visit;
  const length = reach.endMin - reach.startMin;
  // ONE forecast snapshot for this visit's whole decision AND its verdict: the reader keeps one read per visit point for the
  // run, so rain-pass's wet verdict and these alternatives judge the same hours.
  const hourly = await read(row.visit.point.lat, row.visit.point.lng);
  // The hours this decision used, raw: the visit's span plus its drying hours (compact, from the hour its work starts).
  if (Array.isArray(hourly)) base.span_chances = workHours.spanChances(hourly, day, base.span[0], base.span[1], RAIN_AFTER_HOURS);
  // A hour already taken by an earlier proposal is never offered, over the cap or not.
  const own = await reorderStart(row, ctx, hourly);
  if (own != null) {
    if (!open) return { ...base, decision: 'cap', would: 'reorder', to_start: toHHMM(own) };
    const start = own - (reach.ownStartMin - reach.startMin);
    taken.push({ tech: techOf(row), date: day, start, end: start + length });
    return { ...base, decision: 'reorder', to_start: toHHMM(own) };
  }
  // No later dry open hour on the day. Owner ruling 2026-11-26, per visit: later the same day first, then the next work day,
  // then the office call list, whatever the rest of the day reads (the 'wholly wet day' gate of plan v2 is gone). The point's
  // own hours are the snapshot read above. The move is checked against the accepted targets before the cap is named: a stop
  // over the cap is `cap` only when a valid move exists, else it keeps its true reason.
  if (!Array.isArray(hourly)) return { ...base, decision: 'none', reason: 'unread_forecast' };
  // A later hour with no reading could still have been dry: unread, never a move or a call.
  if (laterHourUnread(row, hourly, ctx)) return { ...base, decision: 'none', reason: 'unread_forecast' };
  const { target, unread, exhausted, date } = await dryDayFor(row, hourly, ctx);
  // A scan with no work day in it is unresolved, never a call list: the day is not frozen on it (see planDay).
  if (exhausted) return { ...base, decision: 'none', reason: 'no_work_day_in_scan' };
  // The next work day's work hours the search judged, raw, beside the decision that used them.
  const nextDay = { next_day: date, next_day_chances: workHours.workHourChances(hourly, date) };
  // No dry slot today and none on the next work day: the visit goes to the office call list (no text).
  if (!target) return unread ? { ...base, decision: 'none', reason: 'unread_forecast' } : { ...base, ...nextDay, decision: 'call_list', reason: 'no_dry_slot' };
  const plans = planMovesOf(row.visit, await ctx.seriesRows(), target.date);
  if (!open) return { ...base, ...nextDay, decision: 'cap', would: 'day_move', to_date: target.date, to_start: target.start, ...plans };
  taken.push({ tech: techOf(row), date: target.date, start: target.startMin, end: target.end });
  return { ...base, ...nextDay, decision: 'day_move', to_date: target.date, to_start: target.start, ...plans };
}

/** The day's proposals, in order of start then id, capped. { proposals, checked, dry }. */
async function decideDay(rows, ctx) {
  const outdoor = rows.filter((row) => row.wet || ['not_wet', 'no_point', 'no_forecast', 'error'].includes(row.reason));
  const ordered = [...outdoor].sort((a, b) => (toMin(a.start) - toMin(b.start))
    || (String(a.visit.id) < String(b.visit.id) ? -1 : String(a.visit.id) > String(b.visit.id) ? 1 : 0));
  const proposals = [];
  const seen = new Set();
  // Targets accepted so far, so two stops of one technician never take the same hour.
  const taken = [];
  let used = 0;
  for (const row of ordered) {
    if (seen.has(String(row.visit.id))) continue;
    seen.add(String(row.visit.id));
    let proposal;
    try {
      proposal = await proposeFor(row, { ...ctx, taken, open: used < MAX_PROPOSALS });
    } catch (err) {
      if (err.planning) throw err;
      logger.warn(`[schedule-rain-record] visit ${row.visit.id} proposal failed: ${err.message}`);
      // The error proposal keeps the visit's own span, so the day can still grade it.
      proposal = { ...baseOf(row), decision: 'none', reason: 'error' };
    }
    if (!proposal) continue;
    if (ACTIONS.has(proposal.decision)) used += 1;
    proposals.push(proposal);
  }
  return { proposals, checked: outdoor.length, dry: outdoor.filter((row) => row.reason === 'not_wet' && row.dry === true).length };
}

/** The closure days in a range, read once per range, strictly (a failed read throws). Free: three settings/table reads. */
function closedDays(conn, deps) {
  const memo = new Map();
  return (from, to) => {
    const key = `${from}|${to}`;
    if (!memo.has(key)) {
      memo.set(key, Promise.resolve().then(() => (deps.blackoutDates
        ? deps.blackoutDates(from, to)
        : require('./blackout-dates').getBlackoutDates(from, to, conn, { strict: true }))));
    }
    return memo.get(key);
  };
}

/** The target day's plan: rain-pass's read-only verdicts for that date, then this record's decisions. */
async function planDay({ now, conn, day, today, read, deps }) {
  const readHourly = nwsReader(read);
  const stopsFor = deps.loadStops || ((c) => rainPass.loadStops(c, day, day));
  // The occupancy snapshot rain-pass reads is kept, so a re-picked hour is judged against the same stops.
  const RainOut = deps.rainOut || require('../rain-out');
  let snapshot = null;
  const rainOut = {
    // Widened to the next work day's reach: rain-pass reads three days from today, a Friday cutoff's next work day is Monday.
    loadOccupancy: async (args) => {
      const reach = plusDays(day, NEXT_WORK_SCAN);
      snapshot = await RainOut.loadOccupancy({ ...args, dateTo: args.dateTo > reach ? args.dateTo : reach });
      return snapshot;
    },
    conflictsForTarget: (...args) => RainOut.conflictsForTarget(...args),
  };
  // Every service is classed by the catalog (catalogGate null), not by name while the rain-pass gate is off, and a
  // catalog read that fails is the run's problem (strict), never a silent fall back to the name rules.
  let catalogFailure = null;
  const catalogKeys = async (items, dbh, opts) => {
    try {
      return await (deps.withCatalogKeys || withCatalogKeys)(items, dbh, { ...opts, strict: true });
    } catch (err) {
      catalogFailure = err;
      throw err;
    }
  };
  // No notice to lead here: a stop that starts within 2 hours (a 6 AM recheck of an 8 AM visit) still has its rain read.
  const rows = (await rainPass.planRainPass({
    now, db: conn,
    deps: { ...deps, rainOut, leadMinutes: 0, catalogGate: null, withCatalogKeys: catalogKeys, loadStops: stopsFor, hourlyRain: (lat, lng) => readHourly(lat, lng) },
  })).filter((row) => row.date === day);
  if (catalogFailure) throw catalogFailure;
  // rain-pass reads a failed occupancy snapshot as "every hour is taken": a day decided on it would freeze a move while a
  // dry hour was open. No snapshot is a planning problem, so nothing freezes and the 15:06 run tries again.
  if (!snapshot) return { proposals: [], checked: 0, dry: 0, problem: `occupancy unread for ${day}` };
  const parts = etParts(now);
  const occupied = (visit, date, start, end) => !snapshot || RainOut.conflictsForTarget(
    snapshot, visit.id, date, { start: toHHMM(start), end: toHHMM(end) },
    { excludeServiceIds: visit.memberIds, technicianId: visit.technician_id },
  ).length > 0;
  // The recurrence columns of every service at a wet stop (a grouped stop has several), for what a day move does to each plan.
  const members = [...new Set(rows.filter((row) => row.wet).flatMap((row) => row.visit.memberIds?.length ? row.visit.memberIds : [String(row.visit.id)]))];
  // Read once, and only when a day move needs it. A failed read stops the run (err.planning): a plan scope is never guessed.
  let seriesRead = null;
  const seriesRows = () => {
    if (!seriesRead) seriesRead = Promise.resolve().then(() => (deps.loadSeries || loadSeriesRows)(conn, members)).catch((err) => { err.planning = true; throw err; });
    return seriesRead;
  };
  const decided = await decideDay(rows, {
    day, today, read: readHourly, occupied, blackouts: closedDays(conn, deps), seriesRows,
    dayHours: rainPass.serviceDay(deps),
    earliestMin: day === today ? parts.hour * 60 + parts.minute : 0,
  });
  // Every visit that could be read gave no reading: the forecast is down, not dry. A visit with no point is not one
  // that could be read.
  const eligible = decided.proposals.filter((p) => p.reason !== 'no_point').length;
  const unread = decided.proposals.filter((p) => ['unread_forecast', 'error'].includes(p.reason)).length;
  const unresolved = decided.proposals.filter((p) => p.reason === 'no_work_day_in_scan').length;
  let problem = null;
  if (unresolved > 0) problem = `no work day within ${NEXT_WORK_SCAN} days of ${day} for ${unresolved} visit(s): nothing is frozen`;
  else if (eligible > 0 && unread === eligible) problem = `forecast unread for all ${unread} outdoor visit(s) on ${day}`;
  // The forecast numbers per area for the work hours (the ads record's reader, NWS only), kept so the day can be replayed.
  const forecast = await rainMode.forecastDay(day, { read }).catch(() => null);
  return { ...decided, problem, chances: forecast?.chances || null };
}

// --- scoring ---------------------------------------------------------------------------------------------------

const verdictOf = (decision, wet) => {
  // No verdict while the gauges are unread, or when that run made no proposal for the visit.
  if (wet == null || !decision) return null;
  if (RAIN_CALLS.has(decision)) return wet ? 'hit' : 'false_alarm';
  return wet ? 'miss' : 'ok';
};

const tally = (proposals, visits, field) => {
  const out = { hit: 0, false_alarm: 0, miss: 0, ok: 0, unread: 0 };
  for (const p of proposals || []) {
    const v = visits[p.id]?.[field];
    out[v || 'unread'] += 1;
  }
  return out;
};

const FIELDS = ['cutoff', 'recheck'];

/**
 * The rain in each visit's own hours (work-hour-rain.js spanWet: the visit's start through RAIN_AFTER_HOURS after its
 * end, at the gauges stored on the proposal), measured once for EACH run's span: the cutoff and the recheck can hold
 * different spans for one visit (a stop re-timed between them), and each verdict is graded against its own. A visit stored
 * before the span and gauges were kept is ungraded (null verdicts, final, never waits). A visit with gauges and an unread hour is a gap. { measured: { cutoff: { id: ... }, recheck: ... }, gaps }.
 */
function measureVisits(row, obs) {
  const all = FIELDS.flatMap((f) => (row[f]?.proposals || []).filter((p) => p.reason !== 'no_point').map((p) => ({ field: f, p })));
  const measured = { cutoff: {}, recheck: {} };
  const gaps = [];
  for (const { field, p } of all) {
    // Graded from what the decision stored: its span and its gauge IDs. A proposal with no stored span or gauges (a record
    // from 11-24 or 11-25) is ungraded: never rebuilt, never a guess, and the visit's point is never read again.
    const gauges = Array.isArray(p.gauges) ? p.gauges.filter((g) => workHours.STATIONS[g]) : [];
    if (!Array.isArray(p.span) || !gauges.length) { measured[field][p.id] = { wet: null, inches: null }; continue; }
    measured[field][p.id] = obs ? workHours.spanWetAt(obs, gauges, p.span[0], p.span[1], RAIN_AFTER_HOURS) : { wet: null, inches: null };
    if (measured[field][p.id].wet == null) gaps.push(`${field}:${p.id}`);
  }
  return { measured, gaps };
}

/**
 * Each visit's verdicts, every one graded against its own run's reading. `wet` and `inches` are the first run's reading; a
 * run over a different span (or one that read differently) adds `<run>_wet`, `<run>_inches` and `<run>_missing`.
 */
function gradeVisits(row, measured) {
  const visits = {};
  for (const field of FIELDS) {
    for (const p of row[field]?.proposals || []) {
      if (p.reason === 'no_point') continue;
      const { wet } = measured[field][p.id];
      const inches = Number.isFinite(measured[field][p.id].inches) ? measured[field][p.id].inches : null;
      // `missing`: hours of the span no gauge reported; with it above 0 `inches` is a partial total.
      const missing = Number.isFinite(measured[field][p.id].missing) ? measured[field][p.id].missing : null;
      const v = visits[p.id] || (visits[p.id] = { inches, wet, missing, cutoff: null, recheck: null });
      v[field] = verdictOf(p.decision, wet);
      if (v.wet !== wet || v.inches !== inches || v.missing !== missing) Object.assign(v, { [`${field}_wet`]: wet, [`${field}_inches`]: inches, [`${field}_missing`]: missing });
    }
  }
  return visits;
}

/**
 * The day's score, or null while it could still change: a visit with an unread hour, or the day by area not yet settled, or
 * a read that failed (an IEM outage never freezes a score, and never counts as a give-up). After SCORE_GIVE_UP_DAYS, on a
 * successful read, what was read decides (wetDayFrom final), marked partial.
 */
async function scoreDay(row, now, { fetchObs = workHours.fetchHourlyObs, ...opts }) {
  const obs = await Promise.resolve().then(() => fetchObs(row.day)).catch(() => null);
  // A read that failed (IEM refused, timed out) is "not read this run": never a score, never a give-up.
  if (!obs) return null;
  const { measured, gaps } = measureVisits(row, obs);
  // The day by forecast area, by the one rule the ads record uses (wetDayFrom), to read beside the visits.
  const zones = Object.keys(ZONE_COORDS);
  const areas = workHours.measureAreas(obs, zones, rainMode.RAIN_HOURS);
  const aged = etDateString(now) >= plusDays(row.day, rainMode.SCORE_GIVE_UP_DAYS);
  const dayVerdict = workHours.wetDayFrom(areas, { final: aged });
  const partial = gaps.length > 0 || dayVerdict.partial;
  if (partial && !aged) return null;
  const visits = gradeVisits(row, measured);
  return {
    basis: 'work_hours',
    partial,
    scored_at: new Date().toISOString(),
    visits,
    day: { ...dayVerdict, wet_hours: Object.fromEntries(zones.map((z) => [z, areas[z].wet_hours])) },
    cutoff: row.cutoff ? tally(row.cutoff.proposals, visits, 'cutoff') : null,
    recheck: row.recheck ? tally(row.recheck.proposals, visits, 'recheck') : null,
  };
}

/**
 * Scores up to SCORE_MAX past days (in place) with no work-hour score, least recently tried first. A day the first, daily
 * radar grader scored is graded again here; that score stays on the row as score_daily. Returns the days scored.
 */
async function scorePastDays(days, now, opts) {
  const today = etDateString(now);
  const tried = (d) => days[d].score_tried_at || '';
  const due = Object.keys(days)
    .filter((d) => d < today && days[d].score?.basis !== 'work_hours' && (days[d].cutoff || days[d].recheck))
    .sort((a, b) => tried(a).localeCompare(tried(b)) || a.localeCompare(b))
    .slice(0, rainMode.SCORE_MAX);
  const scored = [];
  for (const day of due) {
    const score = await scoreDay(days[day], now, opts);
    if (score) {
      const { measured_so_far: _kept, score: old, ...row } = days[day];
      days[day] = { ...row, score, ...(old && !old.basis ? { score_daily: old } : {}) };
      scored.push(day);
    } else {
      days[day] = { ...days[day], score_tried_at: now.toISOString() };
    }
  }
  return scored;
}

// --- storage ---------------------------------------------------------------------------------------------------

async function loadDays(conn) {
  const row = await conn('system_settings').where({ key: DAYS_KEY }).first();
  const days = parseJson(row?.value, {});
  return days && typeof days === 'object' && !Array.isArray(days) ? days : {};
}

async function saveRun(conn, run, days, now) {
  await conn.transaction(async (trx) => {
    const prior = await trx('system_settings').where({ key: HISTORY_KEY }).first();
    const history = parseJson(prior?.value, []);
    // One entry per cron tick (ET date and hour): a retry or a second deploy instance replaces it, never adds one.
    const counts = (run.proposals || []).reduce((acc, p) => ({ ...acc, [p.decision]: (acc[p.decision] || 0) + 1 }), {});
    const entry = { at: run.at, tick: run.tick, day: run.day, kind: run.kind, counts, scored: run.scored, error: run.error || null };
    const others = (Array.isArray(history) ? history : []).filter((e) => !e || e.tick !== run.tick);
    const kept = [...others, entry].slice(-HISTORY_MAX);
    const keptDays = Object.fromEntries(Object.entries(days).sort(([a], [b]) => a.localeCompare(b)).slice(-DAYS_MAX));
    const upsert = (key, value, description) => trx('system_settings')
      .insert({ key, value, category: 'schedule', description })
      .onConflict('key')
      .merge({ value, updated_at: now });
    await upsert(LAST_KEY, JSON.stringify(run), 'Latest schedule rain record run (test mode: nothing is moved or sent)');
    await upsert(HISTORY_KEY, JSON.stringify(kept), `Recent schedule rain record runs (last ${HISTORY_MAX})`);
    await upsert(DAYS_KEY, JSON.stringify(keptDays), 'Schedule rain record: cutoff proposals, recheck and measured score, one row per day');
  });
}

/**
 * The day's row after a run. The cutoff is taken once (the first run from 2 PM the day before) and never replaced; a
 * recheck is kept beside it. A row already scored is never rewritten.
 */
function nextDayRow(prior, { day, kind, plan, at }) {
  const next = { ...(prior || {}), day };
  const entry = { at, checked: plan.checked, dry: plan.dry, proposals: plan.proposals, chances: plan.chances || null };
  if (kind === 'cutoff' && !next.cutoff) next.cutoff = entry;
  if (kind === 'recheck') next.recheck = entry;
  return next;
}

/**
 * One run. Never throws: a failure is logged and kept on the 'last' record. Returns
 * { day, kind, proposals, scored, problems }.
 */
async function recordScheduleRain({ now = new Date(), conn = db, read = getNwsHourlyRain, fetchObs, deps = {} } = {}) {
  const problems = [];
  const { day, kind, today } = targetDay(now);
  const tick = `${today}T${String(etParts(now).hour).padStart(2, '0')}`;
  const run = { at: now.toISOString(), tick, mode: 'test', day, kind, proposals: [], scored: [] };
  try {
    const days = await loadDays(conn);
    const planned = kind === 'none' || (kind === 'cutoff' && days[day]?.cutoff) || days[day]?.score
      ? null
      : await planDay({ now, conn, day, today, read, deps });
    if (planned) {
      run.proposals = planned.proposals;
      // A forecast that could not be read is no decision: nothing is frozen, so the 15:06 retry can still take the cutoff.
      if (planned.problem) problems.push(planned.problem);
      else days[day] = nextDayRow(days[day], { day, kind, plan: planned, at: run.at });
    }
    // Scoring is its own try: a failure there never drops the day's decision made above.
    try {
      run.scored = await scorePastDays(days, now, { fetchObs });
    } catch (err) {
      problems.push(`scoring failed: ${err.message}`);
      run.error = `scoring failed: ${err.message}`;
      logger.error(`[schedule-rain-record] scoring failed: ${err.message}`);
    }
    await saveRun(conn, run, days, now);
    logger.info(`[schedule-rain-record] ${day} ${kind}: ${run.proposals.length} proposal(s), scored ${run.scored.length}`);
  } catch (err) {
    problems.push(`the run failed: ${err.message}`);
    logger.error(`[schedule-rain-record] ${day} ${kind}: ${err.message}`);
    try {
      await saveRun(conn, { ...run, error: err.message }, await loadDays(conn), now);
    } catch (saveErr) {
      logger.error(`[schedule-rain-record] the error was not saved: ${saveErr.message}`);
    }
  }
  return { day, kind, proposals: run.proposals, scored: run.scored, problems };
}

/** The cron's step: throws when the run had a problem, so job_health shows the failed tick with its cause. */
async function runScheduleRainRecord(opts) {
  const out = await recordScheduleRain(opts);
  if (out.problems.length) throw new Error(`schedule rain record: ${out.problems[0]}`);
  return out;
}

module.exports = {
  LAST_KEY,
  HISTORY_KEY,
  DAYS_KEY,
  MAX_PROPOSALS,
  targetDay,
  decideDay,
  scoreDay,
  nextDayRow,
  recordScheduleRain,
  runScheduleRainRecord,
  _test: { laterStarts },
};
