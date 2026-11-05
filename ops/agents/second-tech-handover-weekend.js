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
// THE DRIFT BUDGET. The flex tier measures its ±5 days from a visit's durable original date (route-tiers resolveAnchor). This run
// reads that budget (a visit auto-dispatch already moved can only go ±5 of where it started) but does not charge the move to it: a
// re-date made on purpose starts a fresh budget at the new day, as route-tiers does for a person's re-date, because the new weekday
// IS the series' new rhythm (the parent anchor below). The audit row and the rollback file record the move.
//
// THE MOVE MUST STICK (lead ruling 2026-11-04). Recurring top-up extends a series from the latest live
// visit's date; for the month-based patterns (monthly ... annual, monthly_nth_weekday, seasonal Feb-Oct)
// it hops with addETMonthsByWeekday on the PARENT row's recurring_nth / recurring_weekday (else the
// parent's first-visit date), so a Saturday series moved to Thursday would grow its next child back on
// Saturday. So a month-based series is RE-ANCHORED: the parent gets recurrenceOrdinalOptions(<the new
// date of its first live visit>), the stamp SmartRebooker.rescheduleSeries writes (rebooker.js,
// recurring_nth + recurring_weekday). A day-gap pattern (weekly, biweekly, every_6_weeks, custom) hops a
// fixed gap from the latest visit, so a gap of whole weeks keeps the new weekday with no write. A gap that
// is not whole weeks (daily, a custom 9 or 30 days) walks top-up's later visits through every weekday and
// back onto a --to day off, so no move sticks: a customer with such a series (also one with no visit to
// re-date) stays whole with --from (cadence_drift). Never a date_exception
// (top-up would keep landing on the old day). Lawn never moves, so there is no round anchor.
// Every series of the customer moves to --to, so EACH is checked as the run leaves it, also one with no visit
// to re-date or none ahead: top-up's next visits must land on a --to work day after its weekend shift. A month
// walk lands on the parent's anchor weekday (the new one when re-anchored); a day gap keeps the weekday of the
// latest live row's cadence position (admin-schedule latestLiveSeriesVisit: an exception's cadence date, a
// hand-off's due date, a past visit too), with this run's new dates. Otherwise the customer stays whole (top_up_day_off).
//
// THE PROJECTION. The new anchor is tried on each --to work day on or after --start (the first solo day)
// inside ±FLEX_TIER_RADIUS_DAYS of the first live visit's date, nearest first, ties the EARLIER date. For a candidate, EVERY live visit of the
// series dated >= --start is projected from it with the functions top-up uses (the seeder's
// nextRecurringDate: addETMonthsByWeekday for months, a day gap otherwise), hopping as many cadence steps
// as separate the visits today, so a cancelled middle slot does not shift the rest. A candidate is
// accepted only when EVERY projected date:
//   - is within ±5 days of that visit's current date and of its durable original date (the flex tier's cumulative allowance:
//     route-tiers resolveAnchor; an unknown anchor fails closed) (this is also what catches the month boundary: a 1st
//     Saturday moved two days earlier lands in the previous month as a 5th / last Thursday, projects a
//     month away from the visit's date, and the next candidate is tried);
//   - is a --to work day, at least 4 days after today (the 73 h freeze margin), not a company blackout,
//     not a --to absence date, and survives top-up's own date rules unchanged (seasonalSafeShift: the
//     weekend shift for a series that skips weekends, the blackout nudge, the season clamp);
//   - does not reach or cross the series' adjacent occurrence (flex-tier loadSeriesNeighbors: the
//     cadence neighbors and the nearest other live occurrence's actual date);
//   - does not break the customer's portal preference (a preferred day that is not the new day, a
//     blackout range holding the new day);
//   - leaves top-up's next visits of the series on a --to work day (top_up_day_off above);
//   - leaves --to free at the visit's window on the new date (pick-technician technicianFreeAt) and does
//     not overlap a window this run already gave --to (earlier customers' new dates AND the technician-only
//     moves of the same run), so two customers cannot land on one hour. A weekend customer's own technician-only
//     hours count only while that customer moves and the visit keeps its date: when a customer stays whole or a
//     visit gets a new date, its old hours are given back and every customer is decided again (resolveWeekendMoves);
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
const { daysBetween } = require(path.join(root, 'services', 'auto-dispatch', 'route-tiers'));
const seeder = require(path.join(root, 'services', 'recurring-appointment-seeder'));
const { clearOfBlackout, isBlackedOut } = require(path.join(root, 'services', 'scheduling', 'blackout-nudge'));
const { recurringDispatchDuePatch } = require(path.join(root, 'services', 'scheduling', 'recurring-dispatch-due'));

const { nextRecurringDate, recurrenceOrdinalOptions } = seeder._internals;
const { SEASONAL_FEB_OCT, shiftPastWeekend, clampDateToSeason, schedulerPlacesPattern, seriesCadencePosition } = seeder;

// Days after today a new date must be (and --start must be): the 73 h reminder freeze, with margin.
const MIN_DAYS_OUT = 4;
// Same table as rebooker.js MONTH_RECURRENCE_INTERVALS (pinned to rebooker's isMonthBasedRecurrence by a test).
const MONTH_PATTERNS = new Set(['monthly', 'bimonthly', 'quarterly', 'triannual', 'semiannual', 'biannual', 'annual', 'yearly']);
const DEAD_STATUSES = new Set(['completed', 'cancelled', 'skipped', 'no_show']);
// The rows that do not hold a slot for top-up (admin-schedule latestLiveSeriesVisit): every other status does, completed too.
const NO_SLOT_STATUSES = new Set(['cancelled', 'rescheduled']);
const DEFAULT_MINUTES = 60;

/** rebooker.js isMonthBasedRecurrence: the patterns whose dates come from the parent's nth weekday. */
const isMonthBased = (pattern) => pattern === 'monthly_nth_weekday' || pattern === SEASONAL_FEB_OCT || MONTH_PATTERNS.has(pattern);

/** Does top-up keep the series on one weekday? A month walk does (re-anchored on the parent); a day gap only in whole weeks. */
function keepsWeekday(parent, today) {
  if (isMonthBased(parent.recurring_pattern)) return true;
  const gap = daysBetween(today, nextRecurringDate(today, parent.recurring_pattern, 1, { intervalDays: parent.recurring_interval_days }));
  return gap !== null && gap % 7 === 0;
}
const minutes = (t) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** "Sat -> Thu": the weekday change of one move. */
const changeLabel = (from, to) => `${WEEKDAYS[dayOfWeekOfDate(from)]} -> ${WEEKDAYS[dayOfWeekOfDate(to)]}`;

const hhmm = (minute) => `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

/** The end of a visit's window for the occupancy probe: its own end, else its start plus its duration (the probe returns nothing without an end). */
function effectiveWindowEnd(v) {
  const span = spanOf(v);
  return span ? hhmm(span.e) : null;
}

/** The window of a visit as [start, end) minutes, or null for a windowless visit (it holds no hour). */
function spanOf(v) {
  const s = minutes(v.window_start);
  if (s === null) return null;
  const e = minutes(v.window_end);
  return { s, e: e !== null && e > s ? e : s + (Number(v.estimated_duration_minutes) > 0 ? Number(v.estimated_duration_minutes) : DEFAULT_MINUTES) };
}

/** Candidate first dates, nearest first, ties the earlier date: --to work days within ±5 days, on or after --start and past the freeze margin. */
function candidateDates(current, workDays, today, start) {
  const out = [];
  for (let delta = -FLEX_TIER_RADIUS_DAYS; delta <= FLEX_TIER_RADIUS_DAYS; delta += 1) {
    const date = shiftDateStr(current, delta);
    if (workDays.includes(dayOfWeekOfDate(date)) && date >= start && date >= shiftDateStr(today, MIN_DAYS_OUT)) out.push({ date, delta });
  }
  return out.sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta) || a.delta - b.delta).map((c) => c.date);
}

/**
 * How many cadence steps separate two surviving visits today: the smallest count (1..12) whose hop from the earlier one lands
 * within the flex radius of the later one, so a cancelled or skipped middle occurrence (also in the seasonal Feb-Oct walk,
 * which skips the winter) does not shift every later date. 1 when none does (the projection then fails the radius check).
 */
function hopsBetween(parent, earlier, later) {
  const opts = { ...recurrenceOrdinalOptions(earlier, {}), intervalDays: parent.recurring_interval_days };
  for (let hops = 1; hops <= 12; hops += 1) {
    if (Math.abs(daysBetween(nextRecurringDate(earlier, parent.recurring_pattern, hops, opts), later)) <= FLEX_TIER_RADIUS_DAYS) return hops;
  }
  return 1;
}

/**
 * Project every chain member from first date `a0`: the dates the series' own top-up would have given them
 * had the series been anchored there. `chain` = members sorted by date; each hop is as many cadence steps
 * as separate the two visits today (hopsBetween). Null when the pattern is not one the scheduler places.
 */
function projectChain(parent, chain, a0) {
  const pattern = parent.recurring_pattern;
  if (!pattern || !schedulerPlacesPattern(pattern)) return null;
  const opts = {
    ...(isMonthBased(pattern) ? recurrenceOrdinalOptions(a0, {}) : {}),
    intervalDays: parent.recurring_interval_days,
  };
  const dates = [a0];
  for (let i = 1; i < chain.length; i += 1) {
    dates.push(nextRecurringDate(dates[i - 1], pattern, hopsBetween(parent, chain[i - 1].scheduled_date, chain[i].scheduled_date), opts));
  }
  return { dates, anchor: isMonthBased(pattern) ? { nth: opts.nth, weekday: opts.weekday } : null };
}

/** Top-up skips weekends for this series: the parent's flag, or the customer's no-weekend preference. */
const skipsWeekends = (parent, facts) => parent.skip_weekends === true || facts.noWeekends.get(parent.customer_id) === true;

/** A row as the run leaves it after a new date (second-tech-handover-execute: the hand-off due date follows; never a date_exception). */
const redatedRow = (row, date) => ({ ...row, scheduled_date: date, ...recurringDispatchDuePatch(row, { scheduled_date: date }) });
/** latestLiveSeriesVisit's order (admin-schedule): COALESCE(date_exception_cadence_date, recurring_dispatch_due_date, scheduled_date). */
const slotKey = (row) => toDateStr(row.date_exception_cadence_date || row.recurring_dispatch_due_date || row.scheduled_date) || '';

/**
 * The date top-up grows a day-gap series from after the run (admin-schedule latestLiveSeriesVisit, then seriesExtendAnchor):
 * the cadence position of its latest live row, with this run's new dates. `rows` = the plan's live rows of the series (dated
 * today or later); `stored` = the base row the database holds now, which can be a past visit. Null = no live row (no growth).
 */
function baseAfterRun(rows, stored, dates) {
  const all = stored && !rows.some((r) => r.id === stored.id) ? [...rows, stored] : rows;
  let latest = null;
  for (const row of all) {
    const r = dates.has(row.id) ? redatedRow(row, dates.get(row.id)) : row;
    if (!latest || slotKey(r) > slotKey(latest)) latest = r;
  }
  return latest ? seriesCadencePosition(latest) || null : null;
}

/** The weekday the parent's stored anchor walks to (admin-schedule seriesRecurrenceOptions): recurring_weekday, else its own date's. */
function storedAnchorWeekday(parent) {
  if ((parent.recurring_weekday == null || parent.recurring_weekday === '') && !parent.scheduled_date) return null;
  return recurrenceOrdinalOptions(parent.scheduled_date, { nth: parent.recurring_nth, weekday: parent.recurring_weekday }).weekday;
}

/**
 * Why top-up would grow this series' next visits on a --to day off after the run, or null (header, THE MOVE MUST STICK).
 * `dates` / `anchor` = the run's new dates and new parent anchor for the series. An unknown weekday fails closed.
 */
function topUpDayProblem(series, dates, anchor, ctx) {
  const { parent } = series;
  let weekday;
  if (isMonthBased(parent.recurring_pattern)) {
    weekday = anchor ? anchor.weekday : storedAnchorWeekday(parent);
  } else {
    const base = baseAfterRun(series.rows, ctx.facts.bases.get(parent.id), dates);
    if (!base) return null;
    weekday = dayOfWeekOfDate(base);
  }
  if (weekday == null) return 'top_up_day_off';
  // A date on that weekday through top-up's weekend shift (shiftPastWeekend: Sat / Sun -> Mon, or -> Fri when it shifts back).
  const sample = shiftDateStr(ctx.today, (Number(weekday) - dayOfWeekOfDate(ctx.today) + 7) % 7);
  const shifted = shiftPastWeekend(sample, skipsWeekends(parent, ctx.facts), parent.weekend_shift === 'back' ? 'back' : 'forward');
  return ctx.workDays.includes(dayOfWeekOfDate(shifted)) ? null : 'top_up_day_off';
}

/** The date top-up's own rules (seasonalSafeShift) would give `date` for this series; equal to `date` when it keeps it. */
function topUpDate(date, parent, skipWeekends, facts) {
  const dir = parent.weekend_shift === 'back' ? 'back' : 'forward';
  const shifted = clearOfBlackout(shiftPastWeekend(date, skipWeekends, dir), facts.blackout, { skipWeekends });
  if (shifted == null) return null;
  return clampDateToSeason(parent.recurring_pattern, shifted, { skipWeekends, blackoutDates: facts.blackout });
}

/** The customer's portal preference (a preferred weekday, a blackout range) against a date, or null. */
function preferenceProblem(prefs, date) {
  if (!prefs) return null;
  const days = prefs.preferred_day_indexes;
  if (days && days.length && !days.includes(dayOfWeekOfDate(date))) return 'preferred_day';
  return prefs.blackout && date >= prefs.blackout.start && date <= prefs.blackout.end ? 'customer_blackout' : null;
}

/** Why one projected date is not allowed for a visit, or null. Sync: reads only `facts`. */
function dateProblem(v, date, ctx) {
  const { facts, parent, workDays, today, skipWeekends } = ctx;
  if (Math.abs(daysBetween(v.scheduled_date, date)) > FLEX_TIER_RADIUS_DAYS) return 'projection';
  // The flex tier's cumulative allowance: ±5 days of the visit's durable original date too (route-tiers resolveAnchor), unknown fails closed.
  const anchor = facts.anchors.get(v.id);
  if (!anchor) return 'anchor_unknown';
  if (Math.abs(daysBetween(anchor, date)) > FLEX_TIER_RADIUS_DAYS) return 'anchor_budget';
  if (!workDays.includes(dayOfWeekOfDate(date))) return 'projection';
  if (date < shiftDateStr(today, MIN_DAYS_OUT)) return 'inside_freeze';
  if (isBlackedOut(date, facts.blackout)) return 'company_blackout';
  if (facts.absentDates.has(date)) return 'absence';
  if (topUpDate(date, parent, skipWeekends, facts) !== date) return 'projection';
  const preference = preferenceProblem(facts.prefs.get(parent.customer_id), date);
  if (preference) return preference;
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
    // A visit the projection leaves where it is must already sit on a --to work day: no recurring visit may stay on a day off.
    if (date === v.scheduled_date && ctx.workDays.includes(dayOfWeekOfDate(date))) continue;
    const problem = dateProblem(v, date, { ...ctx, parent: series.parent, skipWeekends: skipsWeekends(series.parent, ctx.facts) });
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
  const anchor = dates.size ? projected.anchor : null;
  const dayOff = topUpDayProblem(series, dates, anchor, ctx);
  if (dayOff) return { ok: false, reason: dayOff };
  return { ok: true, dates, anchor, spans: added };
}

/** A series with no visit on a day off keeps its dates; it still moves only when top-up keeps growing it on a --to work day. */
function keepDates(series, ctx) {
  const reason = topUpDayProblem(series, new Map(), null, ctx);
  return reason ? { ok: false, reason } : { ok: true, dates: new Map(), anchor: null, spans: [] };
}

/** The first accepted candidate for a series, or the reason the nearest candidate failed. */
async function resolveSeries(series, ctx) {
  const first = series.chain[0];
  if (!first) return { ok: false, reason: 'no_legal_date' };
  const candidates = candidateDates(first.scheduled_date, ctx.workDays, ctx.today, ctx.start);
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

const overlaps = (a, b) => a.s < b.e && b.s < a.e;
/** Reserve or give back one window on --to, by identity (two visits can share a start and an end). */
const hold = (taken, w) => taken.set(w.date, [...(taken.get(w.date) || []), w]);
const unhold = (taken, w) => taken.set(w.date, (taken.get(w.date) || []).filter((o) => o !== w));

/**
 * One customer's turn in a pass. `mine` = its own technician-only windows, Map(visitId -> window); `late` = the ids among
 * them the pass did not reserve up front. Resolves to { failure } or { solved }, and leaves `taken` holding exactly the
 * hours the customer gives --to.
 */
async function customerTurn(customer, mine, late, ctx) {
  const { taken } = ctx;
  const holds = [];
  const keep = (w) => { hold(taken, w); holds.push(w); };
  // A late window is held now, so the customer's own new dates avoid it as they avoid a window reserved up front.
  for (const id of late) keep(mine.get(id));
  const solved = [];
  let failure = null;
  for (const series of customer.series) {
    // Every series of the customer moves to --to, so each must keep its weekday under top-up (header, THE MOVE MUST STICK).
    if (!keepsWeekday(series.parent, ctx.today)) { failure = 'cadence_drift'; break; }
    const result = series.needsDates ? await resolveSeries(series, ctx) : keepDates(series, ctx);
    if (!result.ok) { failure = result.reason; break; }
    solved.push({ series, result });
    // The next series of this customer must not take the hour this one just took.
    for (const s of result.spans) keep({ ...s, dated: true });
  }
  const redated = new Set(solved.flatMap(({ result }) => [...result.dates.keys()]));
  // A late window whose visit keeps its date keeps its hour on --to: an earlier customer's new date may not sit on it.
  const clash = (w) => (taken.get(w.date) || []).some((o) => o.dated && overlaps(o, w));
  if (!failure && late.some((id) => !redated.has(id) && clash(mine.get(id)))) failure = 'busy';
  if (failure) {
    // Give back every hour the customer holds, the up-front reservations too: the customer stays whole.
    for (const w of [...holds, ...mine.values()]) unhold(taken, w);
    return { failure };
  }
  // A visit with a new date gives back its old hour.
  for (const id of redated) if (mine.has(id)) unhold(taken, mine.get(id));
  return { solved };
}

/** One pass over the customers in order. An own window in `released` is reserved only at its customer's turn. */
async function decidePass({ candidates, own, released, seed, ...rest }) {
  const taken = new Map([...seed].map(([d, list]) => [d, [...list]]));
  for (const [id, w] of own) if (!released.has(id)) hold(taken, w);
  const ctx = { ...rest, taken };
  const kept = new Map();
  const newDates = new Map();
  const anchors = [];
  for (const customer of candidates) {
    const mine = new Map([...own].filter(([, w]) => w.customer_id === customer.customer_id));
    const turn = await customerTurn(customer, mine, [...mine.keys()].filter((id) => released.has(id)), ctx);
    if (turn.failure) { kept.set(customer.customer_id, turn.failure); continue; }
    for (const { series, result } of turn.solved) {
      for (const [id, date] of result.dates) newDates.set(id, date);
      const change = anchorChange(series.parent, result.anchor);
      if (change) anchors.push(change);
    }
  }
  return { kept, newDates, anchors };
}

/**
 * Decide every weekend customer. `candidates` = [{ customer_id, series: [{ parent, live, chain, rows, needsDates }] }]
 * in a stable order. `start` = --start: no new date before it. `seed` = the windows the run's technician-only moves of
 * other customers hold on --to, Map(date -> [{ s, e }]). `own` = the weekend customers' own technician-only windows,
 * Map(visitId -> { customer_id, date, s, e }): reserved up front, so an earlier customer cannot take a later one's hour.
 * Resolves to { kept: Map(customerId -> reason), newDates: Map(visitId -> date), anchors: [anchorChange] }.
 */
async function resolveWeekendMoves({ candidates, from, workDays, start, today, facts, free, seed = new Map(), own = new Map() }) {
  const released = new Set();
  for (;;) {
    const out = await decidePass({ candidates, own, released, seed, from, workDays, start, today, facts, free });
    // An up-front reservation whose visit does not keep its hour on --to (its customer stays with --from, or it gets a new
    // date) misled the customers decided before it: give it back and decide every customer again. `released` only grows.
    const stale = [...own].filter(([id, w]) => !released.has(id) && (out.kept.has(w.customer_id) || out.newDates.has(id)));
    if (!stale.length) return out;
    for (const [id] of stale) released.add(id);
  }
}

// ---- reads (SELECT only) ----------------------------------------------------

/**
 * Everything resolveWeekendMoves reads, for the candidate customers' live visits: company blackout layers, --to's
 * absence dates, each customer's portal preferences, the series neighbors, and the "stays still" reason of each visit.
 */
async function loadWeekendFacts(db, { to, from, start, today, now = new Date(), candidates, lockNeighbors = false }) {
  const visits = candidates.flatMap((c) => c.series.flatMap((s) => s.live));
  const dates = visits.map((v) => v.scheduled_date).sort();
  const lo = shiftDateStr(dates[0] || start, -FLEX_TIER_RADIUS_DAYS - 31);
  const hi = shiftDateStr(dates[dates.length - 1] || start, FLEX_TIER_RADIUS_DAYS + 31);
  // A cleared absence keeps its row with cleared_at stamped (tech-out clearTechOut): the hire works that day.
  const absentRows = await db('technician_absences').where({ technician_id: to }).whereBetween('absence_date', [lo, hi]).whereNull('cleared_at')
    .select('absence_date');

  const { getCustomerSchedulingPreferences } = require(path.join(root, 'services', 'auto-dispatch', 'preferences'));
  const prefs = new Map();
  const noWeekends = new Map();
  for (const c of candidates) {
    const parent = c.series[0].parent;
    prefs.set(c.customer_id, await getCustomerSchedulingPreferences(c.customer_id, parent.service_type, db, { serviceId: parent.service_id, serviceKey: parent.service_key_snapshot }));
    noWeekends.set(c.customer_id, await seeder.customerPrefersNoWeekends(db, c.customer_id));
  }
  // null = unreadable: no entry for any visit = 'neighbor' (fail closed).
  const neighbors = (await loadSeriesNeighbors(db, visits.filter((v) => v.recurring_parent_id), { lock: lockNeighbors })) || new Map();
  const routeTiers = require(path.join(root, 'services', 'auto-dispatch', 'route-tiers'));
  const anchorMap = await routeTiers.loadAnchorMap(db, visits.map((v) => v.id));
  // Only a day gap grows from its base row's weekday; a month walk reads the parent's anchor (topUpDayProblem).
  const daySeries = candidates.flatMap((c) => c.series.filter((s) => !isMonthBased(s.parent.recurring_pattern)).map((s) => s.parent.id));
  return {
    anchors: new Map(visits.map((v) => [v.id, routeTiers.resolveAnchor(v, anchorMap)])),
    blackout: await loadBlackout(db, lo, hi), absentDates: new Set(absentRows.map((r) => toDateStr(r.absence_date))), prefs, neighbors,
    stayStill: await loadStayStill(db, visits, now), noWeekends, from, bases: await loadTopUpBases(db, daySeries),
  };
}

/**
 * Top-up's base row of each series now: admin-schedule latestLiveSeriesVisit's filter and order (a parity test pins them). It can
 * be a past visit the plan does not load, so a series with no live visit ahead is checked too.
 */
async function loadTopUpBases(db, seriesIds) {
  const bases = new Map();
  for (const id of seriesIds) {
    const row = await db('scheduled_services')
      .where(function inSeries() { this.where('recurring_parent_id', id).orWhere('id', id); })
      .where('is_recurring', true)
      .whereNotIn('status', ['cancelled', 'rescheduled'])
      .orderBy(db.raw('COALESCE(date_exception_cadence_date, recurring_dispatch_due_date, scheduled_date)'), 'desc')
      .first('id', db.raw('scheduled_date::text as scheduled_date'), db.raw('recurring_dispatch_due_date::text as recurring_dispatch_due_date'),
        'date_exception', db.raw('date_exception_cadence_date::text as date_exception_cadence_date'));
    if (row) bases.set(id, row);
  }
  return bases;
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
async function decideWeekend(db, { plan, parents, visits, from, to, workDays, start, today, now, lockNeighbors }) {
  const parentById = new Map(parents.map((p) => [p.id, p]));
  const visitById = new Map(visits.map((v) => [v.id, v]));
  const live = (id) => visits.filter((v) => v.series_id === id && v.scheduled_date >= start && !DEAD_STATUSES.has(v.status))
    .sort((a, b) => (a.scheduled_date < b.scheduled_date ? -1 : (a.scheduled_date > b.scheduled_date ? 1 : 0)));
  // The loaded rows that hold a top-up slot (any date from today, completed too): the run's view of top-up's base (baseAfterRun).
  const slotRows = (id) => visits.filter((v) => v.series_id === id && v.is_recurring === true && !NO_SLOT_STATUSES.has(v.status));
  const candidates = plan.weekend_candidates.map((c) => ({
    customer_id: c.customer_id,
    series: c.series_ids.map((id) => {
      const members = live(id);
      return {
        parent: parentById.get(id), live: members, chain: members.filter((v) => v.is_recurring === true), rows: slotRows(id),
        needsDates: members.some((v) => !workDays.includes(dayOfWeekOfDate(v.scheduled_date))),
      };
    }),
  }));
  if (!candidates.length) return { kept: new Map(), newDates: new Map(), anchors: [] };
  const facts = await loadWeekendFacts(db, { to, from, start, today, now, candidates, lockNeighbors });
  // The hours the run's technician-only moves give --to: other customers' always; a weekend customer's own only while that
  // customer moves and the visit keeps its date (resolveWeekendMoves gives the rest back).
  const weekendIds = new Set(candidates.map((c) => c.customer_id));
  const seed = new Map();
  const own = new Map();
  for (const m of plan.ids.moves.filter((x) => !('to_date' in x))) {
    const span = spanOf(visitById.get(m.visit_id));
    const parent = parentById.get(m.series_id);
    if (!span) continue;
    if (parent && weekendIds.has(parent.customer_id)) own.set(m.visit_id, { customer_id: parent.customer_id, date: m.date, ...span });
    else seed.set(m.date, [...(seed.get(m.date) || []), span]);
  }
  const { technicianFreeAt } = require(path.join(root, 'services', 'scheduling', 'pick-technician'));
  const free = (v, date) => technicianFreeAt({
    conn: db, technicianId: to, date, windowStart: v.window_start, windowEnd: effectiveWindowEnd(v),
    durationMinutes: Number(v.estimated_duration_minutes) > 0 ? Number(v.estimated_duration_minutes) : undefined, excludeServiceIds: [v.id],
  });
  return resolveWeekendMoves({ candidates, from, workDays, start, today, facts, free, seed, own });
}

module.exports = {
  decideWeekend, MIN_DAYS_OUT, effectiveWindowEnd, isMonthBased, candidateDates, projectChain, changeLabel, spanOf, resolveWeekendMoves, loadWeekendFacts, anchorChange,
};
