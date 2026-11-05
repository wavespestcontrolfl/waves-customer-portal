// READ-ONLY (no write path: selects only; the writer is second-tech-handover-execute.js)
//
// second-tech-handover-weekend.js — the day-60 second handover run's date logic (second-tech plan,
// build 6; owner 2026-10-28 Tech 2 & 3 Roadmap, question 1 = C: the weekend customers stay with the
// owner at the first run and move to the hire ~60 days later "within the flex-tier ±5 days", with no
// day-change text). Used by `second-tech-handover.js --weekend-move`.
//
// WHAT IT DECIDES, per weekend customer (a customer with a series visit on one of --to's days off):
// every series of the customer that has a visit on a day off gets a NEW DATE for each of its live
// visits dated >= --start, or the whole customer stays with --from, listed with the reason.
//
// THE MOVE MUST STICK (lead ruling 2026-11-04). Recurring top-up extends a series from the latest live
// visit's date; for the month-based patterns (monthly ... annual, monthly_nth_weekday, seasonal Feb-Oct)
// it hops with addETMonthsByWeekday on the PARENT row's recurring_nth / recurring_weekday (else the
// parent's first-visit date), so a Saturday series moved to Thursday would grow its next child back on
// Saturday. So a month-based series is RE-ANCHORED: the parent gets recurrenceOrdinalOptions(<the new
// date of its first live visit>), the stamp SmartRebooker.rescheduleSeries writes (rebooker.js,
// recurring_nth + recurring_weekday). A day-gap pattern (weekly, biweekly, every_6_weeks, custom) hops a
// fixed gap from the latest visit, so it keeps the new weekday with no write. Never a date_exception
// (top-up would keep landing on the old day). Lawn never moves, so there is no round anchor.
//
// THE PROJECTION. The new anchor is tried on each --to work day inside ±FLEX_TIER_RADIUS_DAYS of the
// first live visit's date, nearest first, ties the EARLIER date. For a candidate, EVERY live visit of the
// series dated >= --start is projected from it with the functions top-up uses (the seeder's
// nextRecurringDate: addETMonthsByWeekday for months, a day gap otherwise), hopping as many cadence steps
// as separate the visits today, so a cancelled middle slot does not shift the rest. A candidate is
// accepted only when EVERY projected date:
//   - is within ±5 days of that visit's current date (this is also what catches the month boundary: a 1st
//     Saturday moved two days earlier lands in the previous month as a 5th / last Thursday, projects a
//     month away from the visit's date, and the next candidate is tried);
//   - is a --to work day, at least 4 days after today (the 73 h freeze margin), not a company blackout,
//     not a --to absence date, and survives top-up's own date rules unchanged (seasonalSafeShift: the
//     weekend shift for a series that skips weekends, the blackout nudge, the season clamp);
//   - does not reach or cross the series' adjacent occurrence (flex-tier loadSeriesNeighbors: the
//     cadence neighbors and the nearest other live occurrence's actual date);
//   - does not break the customer's portal preference (a preferred day that is not the new day, a
//     blackout range holding the new day);
//   - leaves --to free at the visit's window on the new date (pick-technician technicianFreeAt) and does
//     not overlap a window this run already gave --to (earlier customers' new dates AND the technician-only
//     moves of the same run), so two customers cannot land on one hour;
//   - for a visit whose date changes: is not a visit the app keeps still (the series' first visit, a
//     'rescheduled' request, a grouped stop, a date_exception, an unplaced hand-off, a visit held by
//     someone else or by nobody, a staff lock / exclusion / customer confirmation, a customer-chosen
//     time (isPersonPlacedVisit), a reminder already sent or inside the reminder band
//     (route-tiers loadReminderFreeze), or a booster visit).
// A series with no accepted candidate keeps its whole customer with --from.
//
// Pure apart from the injected `facts` (all reads happen in loadWeekendFacts) and `free`.
const path = require('path');

const root = path.join(__dirname, '..', '..', 'server');
const { dayOfWeekOfDate } = require(path.join(root, 'services', 'technician-eligibility'));
const { toDateStr, shiftDateStr } = require(path.join(root, 'services', 'auto-dispatch', 'dates'));
const { FLEX_TIER_RADIUS_DAYS, loadSeriesNeighbors } = require(path.join(root, 'services', 'auto-dispatch', 'flex-tier'));
const seeder = require(path.join(root, 'services', 'recurring-appointment-seeder'));
const { clearOfBlackout, isBlackedOut } = require(path.join(root, 'services', 'scheduling', 'blackout-nudge'));

const { nextRecurringDate, recurrenceOrdinalOptions } = seeder._internals;
const { SEASONAL_FEB_OCT, shiftPastWeekend, clampDateToSeason, intervalDaysForPattern, schedulerPlacesPattern } = seeder;

// Days after today a new date must be (and --start must be): the 73 h reminder freeze, with margin.
const MIN_DAYS_OUT = 4;
// Same table as rebooker.js MONTH_RECURRENCE_INTERVALS (pinned to rebooker's isMonthBasedRecurrence by a test).
const MONTH_PATTERNS = new Set(['monthly', 'bimonthly', 'quarterly', 'triannual', 'semiannual', 'biannual', 'annual', 'yearly']);
const DEAD_STATUSES = new Set(['completed', 'cancelled', 'skipped', 'no_show']);
const DEFAULT_MINUTES = 60;

/** rebooker.js isMonthBasedRecurrence: the patterns whose dates come from the parent's nth weekday. */
const isMonthBased = (pattern) => pattern === 'monthly_nth_weekday' || pattern === SEASONAL_FEB_OCT || MONTH_PATTERNS.has(pattern);

const dayDiff = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
const minutes = (t) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** "Sat -> Thu": the weekday change of one move. */
const changeLabel = (from, to) => `${WEEKDAYS[dayOfWeekOfDate(from)]} -> ${WEEKDAYS[dayOfWeekOfDate(to)]}`;

/** The window of a visit as [start, end) minutes, or null for a windowless visit (it holds no hour). */
function spanOf(v) {
  const s = minutes(v.window_start);
  if (s === null) return null;
  const e = minutes(v.window_end);
  return { s, e: e !== null && e > s ? e : s + (Number(v.estimated_duration_minutes) > 0 ? Number(v.estimated_duration_minutes) : DEFAULT_MINUTES) };
}

/** Candidate first dates, nearest first, ties the earlier date: --to work days within ±5 days and past the freeze margin. */
function candidateDates(current, workDays, today) {
  const out = [];
  for (let delta = -FLEX_TIER_RADIUS_DAYS; delta <= FLEX_TIER_RADIUS_DAYS; delta += 1) {
    const date = shiftDateStr(current, delta);
    if (workDays.includes(dayOfWeekOfDate(date)) && date >= shiftDateStr(today, MIN_DAYS_OUT)) out.push({ date, delta });
  }
  return out.sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta) || a.delta - b.delta).map((c) => c.date);
}

/**
 * Project every chain member from first date `a0`: the dates the series' own top-up would have given them
 * had the series been anchored there. `chain` = members sorted by date; each hop is as many cadence steps
 * as separate the two visits today (at least one). Null when the pattern is not one the scheduler places.
 */
function projectChain(parent, chain, a0) {
  const pattern = parent.recurring_pattern;
  if (!pattern || !schedulerPlacesPattern(pattern)) return null;
  const opts = {
    ...(isMonthBased(pattern) ? recurrenceOrdinalOptions(a0, {}) : {}),
    intervalDays: parent.recurring_interval_days,
  };
  const nominal = intervalDaysForPattern(pattern, parent.recurring_interval_days);
  const dates = [a0];
  for (let i = 1; i < chain.length; i += 1) {
    const gap = dayDiff(chain[i - 1].scheduled_date, chain[i].scheduled_date);
    const hops = nominal && pattern !== SEASONAL_FEB_OCT ? Math.max(1, Math.round(gap / nominal)) : 1;
    dates.push(nextRecurringDate(dates[i - 1], pattern, hops, opts));
  }
  return { dates, anchor: isMonthBased(pattern) ? { nth: opts.nth, weekday: opts.weekday } : null };
}

/** The date top-up's own rules (seasonalSafeShift) would give `date` for this series; equal to `date` when it keeps it. */
function topUpDate(date, parent, skipWeekends, facts) {
  const dir = parent.weekend_shift === 'back' ? 'back' : 'forward';
  const shifted = clearOfBlackout(shiftPastWeekend(date, skipWeekends, dir), facts.blackout, { skipWeekends });
  if (shifted == null) return null;
  return clampDateToSeason(parent.recurring_pattern, shifted, { skipWeekends, blackoutDates: facts.blackout });
}

/** Why one projected date is not allowed for a visit, or null. Sync: reads only `facts`. */
function dateProblem(v, date, ctx) {
  const { facts, parent, workDays, today, skipWeekends } = ctx;
  if (Math.abs(dayDiff(v.scheduled_date, date)) > FLEX_TIER_RADIUS_DAYS) return 'projection';
  if (!workDays.includes(dayOfWeekOfDate(date))) return 'projection';
  if (date < shiftDateStr(today, MIN_DAYS_OUT)) return 'inside_freeze';
  if (isBlackedOut(date, facts.blackout)) return 'company_blackout';
  if (facts.absentDates.has(date)) return 'absence';
  if (topUpDate(date, parent, skipWeekends, facts) !== date) return 'projection';
  const prefs = facts.prefs.get(parent.customer_id);
  if (prefs) {
    if (prefs.preferred_day_indexes && prefs.preferred_day_indexes.length && !prefs.preferred_day_indexes.includes(dayOfWeekOfDate(date))) return 'preferred_day';
    if (prefs.blackout && date >= prefs.blackout.start && date <= prefs.blackout.end) return 'customer_blackout';
  }
  const bounds = facts.neighbors.get(v.id);
  if (!bounds) return 'neighbor';
  if ((bounds.prev && date <= bounds.prev) || (bounds.next && date >= bounds.next)) return 'neighbor';
  return null;
}

/** Why a visit that must change date cannot (the app keeps it still), or null. */
function stayStillReason(v, from, facts) {
  if (!v.recurring_parent_id) return 'first_visit';
  if (v.is_recurring !== true) return 'booster_visit';
  if (v.technician_id !== from) return v.technician_id ? 'other_technician' : 'unassigned';
  return facts.stayStill.get(v.id) || null;
}

/**
 * One series, one candidate first date. Returns { ok, dates: Map(visitId -> new date), anchor } or { ok: false, reason }.
 * `live` = the series' live members dated >= --start (sorted by date); `chain` = the is_recurring ones.
 */
async function tryCandidate(series, a0, ctx) {
  const { chain, live } = series;
  const projected = projectChain(series.parent, chain, a0);
  if (!projected) return { ok: false, reason: 'projection' };
  const dates = new Map();
  const added = [];
  const held = ctx.taken;
  for (let i = 0; i < chain.length; i += 1) {
    const v = chain[i];
    const date = projected.dates[i];
    if (date === v.scheduled_date) continue;
    const skipWeekends = series.parent.skip_weekends === true || ctx.facts.noWeekends.get(series.parent.customer_id) === true;
    const problem = dateProblem(v, date, { ...ctx, parent: series.parent, skipWeekends });
    if (problem) return { ok: false, reason: problem };
    const still = stayStillReason(v, ctx.from, ctx.facts);
    if (still) return { ok: false, reason: still };
    const span = spanOf(v);
    if (span) {
      const clash = [...(held.get(date) || []), ...added.filter((a) => a.date === date)].some((o) => o.s < span.e && span.s < o.e);
      if (clash || !(await ctx.free(v, date))) return { ok: false, reason: 'busy' };
      added.push({ date, ...span });
    }
    dates.set(v.id, date);
  }
  // A live visit outside the chain (a booster) on a day off cannot be projected: it keeps the customer whole.
  const stranded = live.find((v) => v.is_recurring !== true && !ctx.workDays.includes(dayOfWeekOfDate(v.scheduled_date)));
  if (stranded) return { ok: false, reason: 'booster_visit' };
  return { ok: true, dates, anchor: dates.size ? projected.anchor : null, spans: added };
}

/** The first accepted candidate for a series, or the reason the nearest candidate failed. */
async function resolveSeries(series, ctx) {
  const first = series.chain[0];
  if (!first) return { ok: false, reason: 'no_legal_date' };
  const candidates = candidateDates(first.scheduled_date, ctx.workDays, ctx.today);
  let reason = 'no_legal_date';
  for (let i = 0; i < candidates.length; i += 1) {
    const result = await tryCandidate(series, candidates[i], ctx);
    if (result.ok) return result;
    if (i === 0) reason = result.reason;
  }
  return { ok: false, reason };
}

/** The old parent anchor and the new one, or null when nothing needs stamping. */
function anchorChange(parent, anchor) {
  if (!anchor) return null;
  const oldNth = parent.recurring_nth == null ? null : Number(parent.recurring_nth);
  const oldWeekday = parent.recurring_weekday == null ? null : Number(parent.recurring_weekday);
  if (oldNth === anchor.nth && oldWeekday === anchor.weekday) return null;
  return { series_id: parent.id, nth: anchor.nth, weekday: anchor.weekday, old_nth: oldNth, old_weekday: oldWeekday };
}

/**
 * Decide every weekend customer. `candidates` = [{ customer_id, series: [{ parent, live, chain, needsDates }] }]
 * in a stable order. `seed` = the windows the run's technician-only moves already hold on --to, Map(date -> [{ s, e }]).
 * Resolves to { kept: Map(customerId -> reason), newDates: Map(visitId -> date), anchors: [anchorChange] }.
 */
async function resolveWeekendMoves({ candidates, from, workDays, today, facts, free, seed = new Map() }) {
  const kept = new Map();
  const newDates = new Map();
  const anchors = [];
  const taken = new Map([...seed].map(([d, list]) => [d, [...list]]));
  for (const customer of candidates) {
    const ctx = { from, workDays, today, facts, free, taken };
    const solved = [];
    let failure = null;
    for (const series of customer.series) {
      const result = series.needsDates ? await resolveSeries(series, ctx) : { ok: true, dates: new Map(), anchor: null, spans: [] };
      if (!result.ok) { failure = result.reason; break; }
      solved.push({ series, result });
      // The next series of this customer must not take the hour this one just took.
      for (const s of result.spans) taken.set(s.date, [...(taken.get(s.date) || []), { s: s.s, e: s.e }]);
    }
    if (failure) {
      // Give back the hours the customer's earlier series took; the customer stays whole.
      for (const { result } of solved) {
        for (const s of result.spans) taken.set(s.date, (taken.get(s.date) || []).filter((o) => !(o.s === s.s && o.e === s.e)));
      }
      kept.set(customer.customer_id, failure);
      continue;
    }
    for (const { series, result } of solved) {
      for (const [id, date] of result.dates) newDates.set(id, date);
      const change = anchorChange(series.parent, result.anchor);
      if (change) anchors.push(change);
    }
  }
  return { kept, newDates, anchors };
}

// ---- reads (SELECT only) ----------------------------------------------------

/**
 * Everything resolveWeekendMoves reads, for the candidate customers' live visits: company blackout layers, --to's
 * absence dates, each customer's portal preferences, the series neighbors, and the "stays still" reason of each visit.
 */
async function loadWeekendFacts(db, { to, from, start, today, now = new Date(), candidates }) {
  const visits = candidates.flatMap((c) => c.series.flatMap((s) => s.live));
  const dates = visits.map((v) => v.scheduled_date).sort();
  const lo = shiftDateStr(dates[0] || start, -FLEX_TIER_RADIUS_DAYS - 31);
  const hi = shiftDateStr(dates[dates.length - 1] || start, FLEX_TIER_RADIUS_DAYS + 31);
  const absentRows = await db('technician_absences').where({ technician_id: to }).whereBetween('absence_date', [lo, hi]).select('absence_date');

  const { getCustomerSchedulingPreferences } = require(path.join(root, 'services', 'auto-dispatch', 'preferences'));
  const prefs = new Map();
  const noWeekends = new Map();
  for (const c of candidates) {
    const parent = c.series[0].parent;
    prefs.set(c.customer_id, await getCustomerSchedulingPreferences(c.customer_id, parent.service_type, db, { serviceId: parent.service_id, serviceKey: parent.service_key_snapshot }));
    noWeekends.set(c.customer_id, await seeder.customerPrefersNoWeekends(db, c.customer_id));
  }
  // null = unreadable: no entry for any visit = 'neighbor' (fail closed).
  const neighbors = (await loadSeriesNeighbors(db, visits.filter((v) => v.recurring_parent_id))) || new Map();
  return {
    blackout: await loadBlackout(db, lo, hi), absentDates: new Set(absentRows.map((r) => toDateStr(r.absence_date))), prefs, neighbors,
    stayStill: await loadStayStill(db, visits, now), noWeekends, from,
  };
}

/** Company blackout layers for the span; null (fail open, as the app's series writers do) when unreadable. */
async function loadBlackout(db, lo, hi) {
  try {
    return await require(path.join(root, 'services', 'scheduling', 'blackout-dates')).getBlackoutLayers(lo, hi, db);
  } catch {
    return null;
  }
}

const STOPPED_TRACKS = ['en_route', 'on_property', 'complete', 'cancelled'];

/** Map(visit id -> the reason the app keeps this visit still, or null), by the night run's and the office tools' own predicates. */
async function loadStayStill(db, visits, now) {
  const { heldOutOfAutoDispatch, isPersonPlacedVisit } = require(path.join(root, 'services', 'auto-dispatch', 'eligibility'));
  const { loadReminderFreeze } = require(path.join(root, 'services', 'auto-dispatch', 'route-tiers'));
  const freeze = await loadReminderFreeze(db, visits.map((v) => v.id), now);
  const rules = [
    ['not_open', (v) => (v.status !== 'pending' && v.status !== 'confirmed') || STOPPED_TRACKS.includes(v.track_state)],
    ['grouped', (v) => !!v.visit_id && v.group_status !== 'dissolved'],
    ['date_exception', (v) => v.date_exception === true],
    ['dispatch_handoff', (v) => !!v.recurring_dispatch_due_date && !v.window_start],
    ['held', (v) => !!heldOutOfAutoDispatch(v)],
    ['reminder_sent', (v) => freeze.failed || freeze.frozen.has(v.id)],
  ];
  const out = new Map();
  for (const v of visits) {
    const rule = rules.find(([, test]) => test(v));
    out.set(v.id, rule ? rule[0] : ((await isPersonPlacedVisit(v, db)).placed ? 'person_placed' : null));
  }
  return out;
}

/**
 * The day-60 decisions for a first read of the plan (`plan.weekend_candidates`): reads the facts, resolves every weekend
 * customer. Resolves to { kept, newDates, anchors } for buildPlan's second pass. Reads only.
 */
async function decideWeekend(db, { plan, parents, visits, from, to, workDays, start, today, now }) {
  const parentById = new Map(parents.map((p) => [p.id, p]));
  const visitById = new Map(visits.map((v) => [v.id, v]));
  const live = (id) => visits.filter((v) => v.series_id === id && v.scheduled_date >= start && !DEAD_STATUSES.has(v.status))
    .sort((a, b) => (a.scheduled_date < b.scheduled_date ? -1 : (a.scheduled_date > b.scheduled_date ? 1 : 0)));
  const candidates = plan.weekend_candidates.map((c) => ({
    customer_id: c.customer_id,
    series: c.series_ids.map((id) => {
      const members = live(id);
      return {
        parent: parentById.get(id), live: members, chain: members.filter((v) => v.is_recurring === true),
        needsDates: members.some((v) => !workDays.includes(dayOfWeekOfDate(v.scheduled_date))),
      };
    }),
  }));
  if (!candidates.length) return { kept: new Map(), newDates: new Map(), anchors: [] };
  const facts = await loadWeekendFacts(db, { to, from, start, today, now, candidates });
  // The hours the run's technician-only moves already give --to.
  const seed = new Map();
  for (const m of plan.ids.moves.filter((x) => !('to_date' in x))) {
    const span = spanOf(visitById.get(m.visit_id));
    if (span) seed.set(m.date, [...(seed.get(m.date) || []), span]);
  }
  const { technicianFreeAt } = require(path.join(root, 'services', 'scheduling', 'pick-technician'));
  const free = (v, date) => technicianFreeAt({
    conn: db, technicianId: to, date, windowStart: v.window_start, windowEnd: v.window_end,
    durationMinutes: Number(v.estimated_duration_minutes) > 0 ? Number(v.estimated_duration_minutes) : undefined, excludeServiceIds: [v.id],
  });
  return resolveWeekendMoves({ candidates, from, workDays, today, facts, free, seed });
}

module.exports = {
  decideWeekend, MIN_DAYS_OUT, isMonthBased, candidateDates, projectChain, changeLabel, spanOf, resolveWeekendMoves, loadWeekendFacts, anchorChange, dayDiff,
};
