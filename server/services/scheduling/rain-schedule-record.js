/**
 * Schedule rain record. Owner 2026-11-23, plan v2: "a 2 PM decision the day before; reorder the day first; move a visit
 * to another day only when the whole day is wet; a move is one-off and never shifts the plan series; at most 10 moves
 * a day, one per visit; 2 weeks of test mode first (no texts, no moves)."
 *
 * This module RECORDS what that rain rule would do to tomorrow's schedule. It changes nothing. It writes only its own
 * system_settings rows (schedule.rain_record.*): no scheduled_services row or other visit table, no text, no email and
 * no admin notification. It is not behind a gate for that reason: it can reach no customer, move no visit, spend no
 * money. Both weather reads are free: the NWS hourly forecast (getNwsHourlyRain, never the paid Open-Meteo backup the
 * booking pages fall back to) and the MRMS radar relay (fetchMrmsDailyRain, the free IEM service). The day-move finder
 * (rebooker findRescheduleOptions, called with no caller) prices drives by estimate only, never Google.
 *
 * What it reuses, and does not rewrite:
 *   - auto-dispatch/rain-pass.js planRainPass: the live outdoor visits of the day, each one's hourly rain over its work
 *     span plus RAIN_AFTER_HOURS (MOVE_PCT 70), shared stops as one physical stop, and the nearest dry open hour on
 *     the same date (DRY_PCT 40, the technician's other stops respected). loadStops, loadPoints and spanRain come
 *     from the same file.
 *   - ads/rain-mode.js: the whole-day-wet rule (countWetHours: RAIN_HOURS or more work hours at 70% or more), the radar
 *     wet threshold (WET_INCHES), the score give-up days, and the pattern: 'last' / 'history' / 'days' settings keys, a
 *     decision frozen at the 2 PM cutoff, a later run that rechecks beside it.
 *   - rebooker.js findRescheduleOptions: the read-only finder of open days, for a day move.
 *
 * One run (cron 'schedule-rain-record', 6:06, 14:06 and 15:06 ET):
 *   1. picks the target day: from 2 PM ET the next work day (Monday to Saturday); before 2 PM today. The 14:06 run is
 *      the CUTOFF, and only for the calendar day before the target (Saturday's run does not cut off Monday; Sunday's
 *      does); the 15:06 run only retries a cutoff that failed. The 6:06 run on the day itself is a RECHECK.
 *      Stops are judged in order, and a target hour or day taken by an earlier proposal for the same technician is not
 *      offered again. A stop that starts soon is judged too: the 2-hour lead of rain-pass is about its notices.
 *   2. for each outdoor visit of that day, in order of start then id, proposes the first that applies:
 *        reorder   a same-day re-time to the nearest dry open hour rain-pass found (or the next one, if taken).
 *        day_move  only when no dry open hour exists AND the whole day is wet (4 or more work hours at 70% or more at
 *                  the visit's point): the first day in the finder's list with a dry hour for the visit's span in the
 *                  forecast. One visit, one date, `series: false`: a plan series is never shifted.
 *        none      a wet visit with no dry hour on a day that is not wholly wet, no dry day found, or a visit whose
 *                  forecast or point could not be read. The reason is kept. Unread is never dry.
 *      At most MAX_PROPOSALS (10) reorders and day moves per target day, one per physical stop. A visit past the cap
 *      is recorded as `cap` with what it would have been.
 *   3. freezes the cutoff proposals on the day's row. The recheck is kept beside them and never replaces them.
 *   4. scores past days against measured radar rain (MRMS daily rain at the visit's point, WET_INCHES or more = wet):
 *      a reorder or day move on a wet visit is a hit, on a dry visit a false alarm; a none or cap on a wet visit is a
 *      miss, on a dry visit ok. MRMS gives a daily total, not the hours, so "wet" means wet that day. Visits are stored
 *      by id only (no name, no address, no coordinates); their point is read again from the visit at score time.
 *      Visits the forecast read as dry are counted, not stored, so they are not scored.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { getNwsHourlyRain } = require('../weather-forecast');
const { fetchMrmsDailyRain } = require('../mrms-qpe');
const rainPass = require('../auto-dispatch/rain-pass');
const rainMode = require('../ads/rain-mode');
const { inRainHorizon } = require('./rain-fit');
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

// NWS only, asked once more when it does not answer, with the long wait of the ads rain record (nobody waits on this cron).
function nwsReader(read) {
  const once = (lat, lng) => Promise.resolve()
    .then(() => read(lat, lng, { fetchTimeoutMs: rainMode.NWS_WAIT_MS }))
    .catch(() => null);
  return async (lat, lng) => (await once(lat, lng)) || (await once(lat, lng));
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
 * The first of the finder's later days whose hours for this visit's span read dry and are not already taken by a move
 * accepted for this technician, or null. Unread is never dry. A one-off move goes to a later work day only (Monday to
 * Saturday, as the target day): never the planned date, an earlier one or a Sunday.
 */
async function dryDayFor(row, hourly, { day, today, dayOptions, taken }) {
  const length = row.visit.reach.endMin - row.visit.reach.startMin;
  // The finder probes the stop's own length, the span the weather check reads.
  let options;
  try {
    options = await dayOptions(row.visit.id, length);
  } catch (err) {
    // The finder could not check the days (its occupancy probe failed, strict): no move can be named. That is the run's
    // problem, not this visit's: nothing is frozen and the retry decides again.
    err.planning = true;
    throw err;
  }
  for (const option of options || []) {
    const startMin = toMin(option?.suggestedWindow?.start);
    if (!option?.date || startMin == null || option.date <= day || dayOfWeek(option.date) === 0 || !inRainHorizon(option.date, today)) continue;
    const rain = rainPass.spanRain(hourly, option.date, startMin, startMin + length);
    if (!rain.complete || rain.peak >= DRY_PCT) continue;
    if (clashes(taken, techOf(row), option.date, startMin, startMin + length)) continue;
    return { date: option.date, start: toHHMM(startMin), end: startMin + length, startMin };
  }
  return null;
}

// The finder is read-only. No caller: estimates only, never a paid road time. 'admin': a move by the office is not held
// to the technician's shift, as the dispatch board's rain-out sheet.
const defaultDayOptions = (serviceId, probeSpanMinutes) => require('../rebooker').findRescheduleOptions(serviceId, 'weather_rain', {
  probeSpanMinutes, travelGap: true, caller: null, initiatedBy: 'admin', strict: true,
});

/**
 * The same-day hour this reorder takes: rain-pass's nearest dry open hour, or, when an earlier proposal for the same
 * technician already holds it, the nearest one that is dry, open and not held. null when none is left.
 */
async function reorderStart(row, ctx) {
  const { day, read, taken } = ctx;
  const { reach } = row.visit;
  const length = reach.endMin - reach.startMin;
  const before = reach.ownStartMin - reach.startMin;
  const fits = (own) => !clashes(taken, techOf(row), day, own - before, own - before + length);
  if (row.proposal && fits(toMin(row.proposal))) return toMin(row.proposal);
  if (!row.proposal) return null;
  const hourly = await read(row.visit.point.lat, row.visit.point.lng);
  if (!Array.isArray(hourly)) return null;
  const { startMin, endMin } = ctx.dayHours;
  return rainPass.dryStart({
    hourly, date: day, reach, earliestMin: ctx.earliestMin, dayStartMin: startMin, dayEndMin: endMin,
    isFree: (start, end) => !ctx.occupied(row.visit, day, start, end) && !clashes(taken, techOf(row), day, start, end),
  });
}

/**
 * One visit's proposal (a dry visit is none/forecast_dry), or null when it is not outdoor. `open` is false once the day's cap is used.
 */
async function proposeFor(row, ctx) {
  const { day, read, open, taken } = ctx;
  const base = { id: String(row.visit.id), start: row.start };
  if (row.visit.memberIds?.length > 1) base.stop_ids = row.visit.memberIds;
  if (['no_point', 'no_forecast', 'error'].includes(row.reason)) {
    return { ...base, decision: 'none', reason: row.reason === 'no_forecast' ? 'unread_forecast' : row.reason };
  }
  if (!row.wet) {
    // A visit the forecast reads dry is stored too, as none/forecast_dry: a rain the forecast missed scores as a miss.
    // Only a span read in full is dry; an hour with no reading is unread.
    return { ...base, decision: 'none', reason: row.dry === true ? 'forecast_dry' : 'unread_forecast' };
  }
  base.peak = row.peak;
  const { reach } = row.visit;
  const length = reach.endMin - reach.startMin;
  // A hour already taken by an earlier proposal is never offered, over the cap or not.
  const own = await reorderStart(row, ctx);
  if (own != null) {
    if (!open) return { ...base, decision: 'cap', would: 'reorder', to_start: toHHMM(own) };
    const start = own - (reach.ownStartMin - reach.startMin);
    taken.push({ tech: techOf(row), date: day, start, end: start + length });
    return { ...base, decision: 'reorder', to_start: toHHMM(own) };
  }
  // No dry open hour left on the day. Only a wholly wet day moves to another one: the point's own hours, read again
  // (the NWS read is cached by grid cell). The move is checked against the accepted targets before the cap is named:
  // a stop over the cap is `cap` only when a valid move exists, else it keeps its true reason.
  const hourly = await read(row.visit.point.lat, row.visit.point.lng);
  if (!Array.isArray(hourly)) return { ...base, decision: 'none', reason: 'unread_forecast' };
  const { wet, missing } = rainMode.countWetHours(hourly, day);
  // A day whose unread hours could still make it wholly wet is not settled (the ads rain rule's open area): unread, not dry.
  if (wet < rainMode.RAIN_HOURS && wet + missing >= rainMode.RAIN_HOURS) return { ...base, decision: 'none', reason: 'unread_forecast' };
  if (wet < rainMode.RAIN_HOURS) return { ...base, decision: 'none', reason: 'no_dry_hour' };
  const target = await dryDayFor(row, hourly, ctx);
  if (!target) return { ...base, decision: 'none', reason: 'no_dry_day' };
  if (!open) return { ...base, decision: 'cap', would: 'day_move', to_date: target.date, to_start: target.start };
  taken.push({ tech: techOf(row), date: target.date, start: target.startMin, end: target.end });
  return { ...base, decision: 'day_move', to_date: target.date, to_start: target.start, series: false };
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
      proposal = { id: String(row.visit.id), start: row.start, decision: 'none', reason: 'error' };
    }
    if (!proposal) continue;
    if (ACTIONS.has(proposal.decision)) used += 1;
    proposals.push(proposal);
  }
  return { proposals, checked: outdoor.length, dry: outdoor.filter((row) => row.reason === 'not_wet' && row.dry === true).length };
}

/** The target day's plan: rain-pass's read-only verdicts for that date, then this record's decisions. */
async function planDay({ now, conn, day, today, read, deps }) {
  const readHourly = nwsReader(read);
  const stopsFor = deps.loadStops || ((c) => rainPass.loadStops(c, day, day));
  // The occupancy snapshot rain-pass reads is kept, so a re-picked hour is judged against the same stops.
  const RainOut = deps.rainOut || require('../rain-out');
  let snapshot = null;
  const rainOut = {
    loadOccupancy: async (args) => { snapshot = await RainOut.loadOccupancy(args); return snapshot; },
    conflictsForTarget: (...args) => RainOut.conflictsForTarget(...args),
  };
  // Every service is classed by the catalog (catalogGate null), not by name while the rain-pass gate is off.
  // No notice to lead here: a stop that starts within 2 hours (a 6 AM recheck of an 8 AM visit) still has its rain read.
  const rows = (await rainPass.planRainPass({
    now, db: conn,
    deps: { ...deps, rainOut, leadMinutes: 0, catalogGate: null, loadStops: stopsFor, hourlyRain: (lat, lng) => readHourly(lat, lng) },
  })).filter((row) => row.date === day);
  // rain-pass reads a failed occupancy snapshot as "every hour is taken": a day decided on it would freeze a move while a
  // dry hour was open. No snapshot is a planning problem, so nothing freezes and the 15:06 run tries again.
  if (!snapshot) return { proposals: [], checked: 0, dry: 0, problem: `occupancy unread for ${day}` };
  const parts = etParts(now);
  const occupied = (visit, date, start, end) => !snapshot || RainOut.conflictsForTarget(
    snapshot, visit.id, date, { start: toHHMM(start), end: toHHMM(end) },
    { excludeServiceIds: visit.memberIds, technicianId: visit.technician_id },
  ).length > 0;
  const decided = await decideDay(rows, {
    day, today, read: readHourly, dayOptions: deps.dayOptions || defaultDayOptions, occupied,
    dayHours: rainPass.serviceDay(deps),
    earliestMin: day === today ? parts.hour * 60 + parts.minute : 0,
  });
  // Every visit that could be read gave no reading: the forecast is down, not dry. A visit with no point is not one
  // that could be read.
  const eligible = decided.proposals.filter((p) => p.reason !== 'no_point').length;
  const unread = decided.proposals.filter((p) => ['unread_forecast', 'error'].includes(p.reason)).length;
  const problem = eligible > 0 && unread === eligible ? `forecast unread for all ${unread} outdoor visit(s) on ${day}` : null;
  return { ...decided, problem };
}

// --- scoring ---------------------------------------------------------------------------------------------------

const verdictOf = (decision, wet) => {
  // No verdict while the radar is unread, or when that run made no proposal for the visit.
  if (wet == null || !decision) return null;
  if (ACTIONS.has(decision)) return wet ? 'hit' : 'false_alarm';
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

/**
 * The day's measured rain by visit id: readings kept from earlier tries stand. Visits with no point (moved away, row
 * gone) are never read and never wait; a visit with a point and no radar reading yet is a gap.
 */
async function measureDay(row, ids, { fetchRain, loadPoints, conn }) {
  const measured = { ...(parseJson(row.measured_so_far, {}) || {}) };
  const need = ids.filter((id) => !Number.isFinite(measured[id]));
  const gaps = [];
  if (need.length) {
    const points = await loadPoints(conn, need);
    await Promise.all(need.map(async (id) => {
      const point = points.get(String(id));
      if (!point) { measured[id] = null; return; }
      const out = await Promise.resolve()
        .then(() => fetchRain({ latitude: point.lat, longitude: point.lng, start: row.day, end: row.day }))
        .catch(() => null);
      const inches = out?.days?.[0]?.inches;
      measured[id] = Number.isFinite(inches) ? inches : null;
      if (measured[id] == null) gaps.push(id);
    }));
  }
  return { measured, gaps };
}

/** The day's score, or null while radar gaps could still change it (after SCORE_GIVE_UP_DAYS the visits read decide). */
async function scoreDay(row, now, opts) {
  const proposals = [...(row.cutoff?.proposals || []), ...(row.recheck?.proposals || [])];
  // A visit that never had a point cannot be read at all.
  const ids = [...new Set(proposals.filter((p) => p.reason !== 'no_point').map((p) => p.id))];
  const { measured, gaps } = await measureDay(row, ids, opts);
  const partial = gaps.length > 0;
  if (partial && etDateString(now) < plusDays(row.day, rainMode.SCORE_GIVE_UP_DAYS)) return { wait: measured };
  const visits = {};
  for (const id of ids) {
    const inches = measured[id];
    const wet = Number.isFinite(inches) ? inches >= rainMode.WET_INCHES : null;
    const decision = (field) => (row[field]?.proposals || []).find((p) => p.id === id)?.decision;
    visits[id] = {
      inches: Number.isFinite(inches) ? inches : null,
      wet,
      cutoff: verdictOf(decision('cutoff'), wet),
      recheck: verdictOf(decision('recheck'), wet),
    };
  }
  return {
    score: {
      partial,
      scored_at: new Date().toISOString(),
      visits,
      cutoff: row.cutoff ? tally(row.cutoff.proposals, visits, 'cutoff') : null,
      recheck: row.recheck ? tally(row.recheck.proposals, visits, 'recheck') : null,
    },
  };
}

/** Scores up to SCORE_MAX past, unscored days (in place), least recently tried first. Returns the days scored. */
async function scorePastDays(days, now, opts) {
  const today = etDateString(now);
  const tried = (d) => days[d].score_tried_at || '';
  const due = Object.keys(days)
    .filter((d) => d < today && !days[d].score && (days[d].cutoff || days[d].recheck))
    .sort((a, b) => tried(a).localeCompare(tried(b)) || a.localeCompare(b))
    .slice(0, rainMode.SCORE_MAX);
  const scored = [];
  for (const day of due) {
    const out = await scoreDay(days[day], now, opts);
    if (out.score) {
      const { measured_so_far: _kept, ...row } = days[day];
      days[day] = { ...row, score: out.score };
      scored.push(day);
    } else {
      days[day] = { ...days[day], score_tried_at: now.toISOString(), measured_so_far: out.wait };
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
  const entry = { at, checked: plan.checked, dry: plan.dry, proposals: plan.proposals };
  if (kind === 'cutoff' && !next.cutoff) next.cutoff = entry;
  if (kind === 'recheck') next.recheck = entry;
  return next;
}

/**
 * One run. Never throws: a failure is logged and kept on the 'last' record. Returns
 * { day, kind, proposals, scored, problems }.
 */
async function recordScheduleRain({ now = new Date(), conn = db, read = getNwsHourlyRain, fetchRain = fetchMrmsDailyRain, deps = {} } = {}) {
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
      run.scored = await scorePastDays(days, now, { fetchRain, loadPoints: deps.loadPoints || rainPass.loadPoints, conn });
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
};
