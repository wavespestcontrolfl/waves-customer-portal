/**
 * MOWING DAYS — keep a Lawn Care Service visit off the customer's mowing day
 * (owner 2026-11-02: no lawn application right before or right after a cut).
 * GATE_AUTO_DISPATCH_MOWING_DAYS, read at call time; ships dark.
 *
 * The customer saves the days they mow in the portal
 * (property_preferences.mowing_days, 'Mon'..'Sun'; parsed by
 * utils/mowing-schedule.js parseDays, which also reads a legacy JSON string).
 * A blocked weekday is each saved mowing day, the day before it and the day
 * after it. A weekday the customer chose as their preferred day
 * (preferred_day_indexes) is never blocked: the customer's own choice wins.
 * Day level only: mowing_time_of_day and mowing_notes are not read here.
 *
 * Scope: Lawn Care Service visits only (isLawnCareService), not the whole
 * auto-dispatch 'lawn' category (Tree & Shrub, palm, aeration). A grouped
 * unit with a Lawn Care Service member is held to the rule as a whole, since
 * the unit moves together.
 *
 * Modes:
 *   off     nothing read, nothing changed (byte-identical, no new query);
 *   shadow  live decisions unchanged; each evaluated Lawn Care Service
 *           visit's audit row gets constraints_checked.mowing_days, with the
 *           slot mode 'true' would pick (shadow_best). Pure ranking only: no
 *           road check, no proofreader, no paid call;
 *   true    HARD filter: a candidate slot on a blocked weekday is dropped
 *           (candidate-slots.js, drops.mowing_day; the gap tool too). A
 *           visit already on a blocked weekday is in conflict
 *           ('mowing_day', current-conflict.js, after closed_day and
 *           overlap), so it moves to the best legal slot without the score
 *           bar, inside every other guard. A visit whose only conflict is
 *           the mowing day raises no needs-a-person notice: with no slot
 *           that fits it stays, and its audit row says why. At apply the
 *           move transaction re-reads the rule FOR SHARE and refuses a
 *           blocked destination (assertDestinationClear).
 */
const { parseDays } = require('../../utils/mowing-schedule');
const { weekdayOf } = require('./scoring');
const { rankCandidates } = require('./move-rules');

const DAY_INDEX = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

// The call-time gate reader, tolerant of a suite that mocks feature-gates whole.
function mowingDaysMode() {
  const { autoDispatchMowingDaysMode } = require('../../config/feature-gates');
  return typeof autoDispatchMowingDaysMode === 'function' ? autoDispatchMowingDaysMode() : 'off';
}

const LAWN = /lawn/i;
const NOT_LAWN_CARE = /aerat|thatch/i;

// THE scope predicate: 'Every 6 Weeks Lawn Care Service' is in;
// 'Lawn Aeration', 'Tree & Shrub Care Service' and pest work are out.
function isLawnCareService(serviceType) {
  const name = String(serviceType || '');
  return LAWN.test(name) && !NOT_LAWN_CARE.test(name);
}

// Weekdays (0=Sun..6=Sat, ascending) the rule blocks: each mowing day and
// the day on each side, minus the customer's preferred days.
function blockedWeekdays(mowingDays, preferredDayIndexes) {
  const keep = new Set(preferredDayIndexes || []);
  const blocked = new Set();
  for (const day of parseDays(mowingDays)) {
    const i = DAY_INDEX[day];
    [i + 6, i, i + 1].forEach((d) => blocked.add(d % 7));
  }
  return [...blocked].filter((d) => !keep.has(d)).sort((a, b) => a - b);
}

// The rule for one property_preferences row (or none).
function ruleFor(row, preferredDayIndexes, mode) {
  return {
    mode,
    days: parseDays(row && row.mowing_days),
    blocked_weekdays: blockedWeekdays(row && row.mowing_days, preferredDayIndexes),
  };
}

// preferences.js: the normalized prefs with the rule as `mowing`. Off: the
// prefs object itself, unchanged.
function withMowingRule(prefs, row, mode) {
  if (mode === 'off') return prefs;
  return { ...prefs, mowing: ruleFor(row, prefs.preferred_day_indexes, mode) };
}

// The rule for a moving unit (the visit and its open group members), or null
// when no member is a Lawn Care Service visit or the gate is off.
function unitRule(prefs, rows) {
  if (!prefs || !prefs.mowing) return null;
  return rows.some((r) => r && isLawnCareService(r.service_type)) ? prefs.mowing : null;
}

const blocksDay = (dateStr, rule) => !!rule && rule.blocked_weekdays.includes(weekdayOf(dateStr));

// The HARD filter: mode 'true' only. Shadow and off never drop a slot.
function blocksLive(dateStr, rule) {
  return !!rule && rule.mode === 'true' && blocksDay(dateStr, rule);
}

// Candidates (slot-shaped, `date`) the rule leaves open.
const withoutBlockedDays = (candidates, rule) => candidates.filter((c) => !blocksDay(c.date, rule));

/**
 * At apply (apply.js makeMoveGuard and makeMemberGuard), inside the move
 * transaction: the destination against the customer's rule as saved NOW, the
 * property_preferences row held FOR SHARE, so a mowing-day or preferred-day
 * edit made after the run scored the move cannot land the unit on a blocked
 * day, whether or not a proofreader looked at it (Codex #7472 r2 P2). Mode
 * 'true' only; `serviceTypes` are the unit's rows (the moving visit, or its
 * committed group members), and a unit with no Lawn Care Service row reads
 * nothing.
 */
async function assertDestinationClear(trx, service, dateStr, refuse, serviceTypes) {
  if (mowingDaysMode() !== 'true' || !serviceTypes.some(isLawnCareService)) return;
  const row = await trx('property_preferences').where('customer_id', service.customer_id).forShare().first('preferred_day', 'mowing_days');
  const { normalizePreferences } = require('./preferences');
  const rule = ruleFor(row, normalizePreferences(row, service.service_type).preferred_day_indexes, 'true');
  if (blocksDay(dateStr, rule)) throw refuse(service.id, `would land on ${dateStr}, on or next to the customer's mowing day`);
}

const startOf = (p) => (p ? { date: p.date, start: p.start_time || null } : null);
const sameSlot = (a, b) => !!a && !!b && a.date === b.date && a.start === b.start;

// The slot mode 'true' would choose: the same candidates without the blocked
// days, and a placed visit on a blocked day read in conflict (as
// current-conflict.js reads it: conflict moves on, no other conflict first).
// `shadowCandidates` is that pool when the legacy model capped the live list
// (candidate-slots.js mowingShadowCandidates, filtered BEFORE the cap), scored
// with `scoreOf`; without it the scored live list is filtered (the shared
// model caps only after scoring). The pure move rule only: no road check, no write.
function shadowBest(rule, {
  service, current, scored, shadowCandidates, scoreOf, currentScore, threshold, config, conflictMoves,
}) {
  if (!current || !currentScore) return null;
  const inConflict = conflictMoves === true && !current.conflict && !!service.window_start && blocksDay(current.date, rule);
  const pool = shadowCandidates
    ? shadowCandidates.map((cand) => ({ cand, sc: scoreOf(cand) }))
    : (scored || []).filter(({ cand }) => !blocksDay(cand.date, rule));
  const ranked = rankCandidates({
    service,
    current: inConflict ? { ...current, conflict: { kind: 'mowing_day', date: current.date } } : current,
    currentScore,
    scored: pool,
    threshold,
    config,
  });
  return ranked.qualifies ? ranked.best : null;
}

/**
 * constraints_checked.mowing_days for one evaluation ({} when the rule does
 * not apply). `live` is tonight's qualifying choice (null = the visit stays).
 * Shadow adds shadow_best and would_move.
 */
function auditNote(rule, args) {
  if (!rule) return {};
  const { current, live } = args;
  const chosen = live || current;
  const note = {
    mode: rule.mode,
    mowing_days: rule.days,
    blocked_weekdays: rule.blocked_weekdays,
    current_blocked: !!current && blocksDay(current.date, rule),
    chosen_blocked: !!chosen && blocksDay(chosen.date, rule),
  };
  if (rule.mode !== 'shadow') return { mowing_days: note };
  const best = startOf(shadowBest(rule, args));
  return { mowing_days: { ...note, shadow_best: best, would_move: !!best && !sameSlot(best, startOf(current)) } };
}

module.exports = {
  mowingDaysMode, isLawnCareService, blockedWeekdays, ruleFor, withMowingRule, unitRule, blocksLive, withoutBlockedDays, assertDestinationClear, auditNote, DAY_INDEX,
};
