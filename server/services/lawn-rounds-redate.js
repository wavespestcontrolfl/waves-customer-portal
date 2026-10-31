'use strict';

// Lawn 9x rounds, PR 6: the one-time move of CURRENT lawn 9x customers onto the rounds (owner 2026-10-28
// Option A; owner 2026-10-31 neighborhood days). The owner runs scripts/lawn-9x-rounds-redate.js: a dry run
// first, then --apply. Nothing here runs on its own.
//
// Per series: the next visit stays as booked; every later live visit moves to the series anchor's date in
// the round after the previous visit (the area's anchor, else the next visit's own date). A visit the
// owner's 10-08 rule keeps still (inside 73 hours, confirmed by the customer, a reminder already sent, a
// time the customer chose, locked by staff, part of a grouped stop) keeps its date and claims its own round.
// The number of future visits stays the same. Then the series is stored as lawn_rounds_9 with its anchor.
//
// Moves go through SmartRebooker.reschedule for ONE occurrence, the way ~/ops-oneshots/lib/move-visit.js does:
// staff initiator, `expect` guard, no per-move tech notice, route placement, the reminder re-timed silently.
// A timed visit takes the first open time on its new day (reviewPlan); an untimed visit moves by date only and
// auto-dispatch times it, as for any untimed visit. No customer message of any kind; no tech push.
//
// The plan is pure (planSeriesRedate) and the same in a dry run and in --apply. A dry run only reads.
const { LAWN_ROUNDS_9, lawnRoundDateFrom, roundOrdinal } = require('./lawn-rounds');
const { lawnAreaRoundAnchor } = require('./lawn-area-days');
const { isLawn9xRoundsSeries } = require('./recurring-appointment-seeder');
const { seriesCustomerSkipReason } = require('./series-customer-eligibility');
const { parseETDateTime, etDateString } = require('../utils/datetime-et');
const { DATE_EXCEPTION_CLEAR } = require('./rebooker');
const { DAY_START_HOUR, DAY_END_HOUR } = require('./scheduling/find-time');

const DEFAULT_MAX_SHIFT_DAYS = 14;
const STAY_WINDOW_HOURS = 73;
// A series gap under this is reported (never held): the area anchors keep it above 28 by construction.
const SHORT_GAP_DAYS = 28;
const MOVE_REASON = 'admin';
const NOT_LAWN_9X = 'not a lawn 9x series any more';
const DEAD = "('cancelled','skipped','completed','no_show','rescheduled')";
const CUSTOMER_INITIATORS = new Set(['customer', 'customer_self_serve', 'customer_portal', 'customer_sms', 'sms_offer_ai', 'ai_call_pipeline']);
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const dayMs = (dateStr) => Date.parse(`${dateStr}T12:00:00Z`);
const diffDays = (from, to) => Math.round((dayMs(to) - dayMs(from)) / 86400000);
const weekdayOf = (dateStr) => WEEKDAYS[new Date(dayMs(dateStr)).getUTCDay()];
const toMin = (hhmm) => { const [h, m] = String(hhmm).slice(0, 5).split(':').map(Number); return h * 60 + m; };
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

// Why the owner's 10-08 rule keeps this visit still without asking, or null. One row per rule, in order.
// A pre-closed placeholder reminder (windows_preclosed) is not a sent reminder.
const STAY_RULES = [
  ['confirmed by the customer', (v) => v.customer_confirmed === true],
  ['locked by staff', (v) => v.auto_dispatch_locked === true || v.auto_dispatch_excluded === true],
  ['reminder already sent', (v) => v.r_cancelled !== true && v.r_preclosed !== true && (v.r72 === true || v.r24 === true)],
  ['time chosen by the customer', (v) => CUSTOMER_INITIATORS.has(String(v.last_mover || '')) || CUSTOMER_INITIATORS.has(String(v.date_exception_source || ''))],
  ['part of a grouped stop', (v) => Number(v.group_mates) > 0],
  [`inside ${STAY_WINDOW_HOURS} hours`, (v, nowMs) => parseETDateTime(`${v.d}T${v.ws || '00:00'}`).getTime() < nowMs + STAY_WINDOW_HOURS * 3600000],
];

function stayReason(visit, nowMs = Date.now()) {
  const hit = STAY_RULES.find(([, test]) => test(visit, nowMs));
  return hit ? hit[0] : null;
}

// PURE. One series' plan.
//   series: { parentId, customerId, areaAnchor, areaKey, anchorOverride, terms: { [termId]: { start, end } },
//             visits: [{ id, date, ws, we, dur, tech, stay, prepaid }] }  live future visits in date order
//   opts:   { maxShiftDays, allowLongShift }
// Returns { parentId, customerId, anchor, anchorSource, areaKey, flags, heldReasons, held, visits, moves, signature }.
//   `visits` rows: { id, from, to, shift, kind: 'next' | 'keep' | 'move' | 'at-target', reason, ws, we, dur, tech }
//   `flags` never hold the series: long shift, no area, area day too far, weekend day, prepaid, short gap
//   (planAndReview adds area day full).
//   `heldReasons` hold it (nothing changes): round conflict, shift over N days, outside prepaid term (a prepaid
//   visit would leave its term's window, so the term would stop covering it); the schedule review adds hour
//   taken and closed day.
// An area plan that needs a move over the limit falls back to the customer's own weekday on the rounds (flag
// `area day too far`) when that plan fits; otherwise the area plan and its hold stand.
function planSeriesRedate(series, opts = {}) {
  const plan = planFromAnchor(series, opts);
  if (plan.anchorSource !== 'area' || !plan.tooFar) return plan;
  const own = planFromAnchor({ ...series, areaAnchor: null }, opts);
  return own.tooFar ? plan : { ...own, flags: [...own.flags, 'area day too far'] };
}

function planFromAnchor(series, { maxShiftDays = DEFAULT_MAX_SHIFT_DAYS, allowLongShift = false } = {}) {
  const [next, ...later] = series.visits;
  const anchorSource = series.anchorOverride ? 'override' : (series.areaAnchor ? 'area' : 'own');
  const anchor = series.anchorOverride || series.areaAnchor || next.date;
  const rows = [{ ...pick(next), from: next.date, to: next.date, shift: 0, kind: 'next', reason: null }];
  let conflict = false;
  for (const v of later) {
    const prev = rows[rows.length - 1].to;
    const row = { ...pick(v), from: v.date, to: v.date, shift: 0, kind: 'keep', reason: v.stay };
    if (v.stay) {
      conflict = conflict || roundOrdinal(v.date) <= roundOrdinal(prev);
    } else {
      row.to = lawnRoundDateFrom(anchor, prev, 1);
      row.shift = diffDays(v.date, row.to);
      row.kind = row.shift === 0 ? 'at-target' : 'move';
    }
    rows.push(row);
  }
  const c = { series, anchor, anchorSource, rows, conflict, long: rows.some((r) => Math.abs(r.shift) > maxShiftDays) };
  const tooFar = c.long && !allowLongShift;
  const heldReasons = [
    c.conflict && 'round conflict',
    tooFar && `shift over ${maxShiftDays} days`,
    rows.some((r) => r.kind === 'move' && r.termId && !insideTerm(series.terms, r)) && 'outside prepaid term',
  ].filter(Boolean);
  return {
    parentId: series.parentId,
    customerId: series.customerId,
    anchor,
    anchorSource,
    areaKey: series.areaKey || null,
    oldWeekday: weekdayOf(next.date),
    newWeekday: weekdayOf(anchor),
    flags: FLAG_RULES.filter(([, test]) => test(c)).map(([name]) => name),
    heldReasons,
    held: heldReasons[0] || null,
    tooFar,
    visits: rows,
    moves: rows.filter((r) => r.kind === 'move'),
    signature: JSON.stringify([anchor, rows.map((r) => [r.id, r.from, r.to])]),
  };
}

// Flags report; they never hold a series.
const FLAG_RULES = [
  ['long shift', (c) => c.long],
  ['no area', (c) => !c.series.areaKey],
  ['weekend day', (c) => ['Sat', 'Sun'].includes(weekdayOf(c.anchor))],
  ['prepaid', (c) => c.series.visits.some((v) => v.prepaid)],
  ['short gap', (c) => c.rows.some((r, i) => i > 0 && diffDays(c.rows[i - 1].to, r.to) < SHORT_GAP_DAYS)],
];

const pick = (v) => ({ id: v.id, ws: v.ws, we: v.we, dur: v.dur, tech: v.tech, prepaid: !!v.prepaid, termId: v.termId || null });

// A prepaid row's target inside its term's window (annual-prepay coverageRowsForTerm covers term_start..term_end).
// An unread term is outside: fail closed.
function insideTerm(terms, row) {
  const term = terms?.[row.termId];
  return !!term && row.to >= term.start && row.to <= term.end;
}

// ---- reads (the dry run uses only these) -------------------------------------------------------------------------

// The live visits of one series: its root and the children that name it, never a booster extra.
const VISIT_SQL = `select ss.*, ss.id::text id, ss.scheduled_date::text d, to_char(ss.window_start,'HH24:MI') ws,
    to_char(ss.window_end,'HH24:MI') we, coalesce(ss.estimated_duration_minutes, 60) dur, ss.technician_id::text tech,
    ss.annual_prepay_term_id::text term_id,
    ar.reminder_72h_sent r72, ar.reminder_24h_sent r24, ar.cancelled r_cancelled, ar.windows_preclosed r_preclosed,
    (select rl.initiated_by from reschedule_log rl where rl.scheduled_service_id = ss.id and rl.new_date is not null
      order by rl.created_at desc limit 1) last_mover,
    (select count(*)::int from scheduled_services g where ss.visit_id is not null and g.visit_id = ss.visit_id and g.id <> ss.id
      and coalesce(g.status,'pending') not in ${DEAD}) group_mates
  from scheduled_services ss left join appointment_reminders ar on ar.scheduled_service_id = ss.id`;

async function readVisit(conn, id) {
  const { rows } = await conn.raw(`${VISIT_SQL} where ss.id = ?`, [id]);
  return rows[0] || null;
}

async function readFutureVisits(conn, parentId, todayET) {
  const { rows } = await conn.raw(`${VISIT_SQL}
    where (ss.id = ? or ss.recurring_parent_id = ?) and ss.is_recurring is distinct from false
      and coalesce(ss.status,'pending') in ('pending','confirmed') and ss.scheduled_date >= ?::date
    order by ss.scheduled_date, ss.created_at, ss.id`, [parentId, parentId, todayET]);
  return rows;
}

// Root rows that could be a lawn 9x series. Each: { candidate: root } or { skip: reason | null } (null = not a
// lawn 9x series at all, so it is not counted). The identity rule is the app's own (isLawn9xRoundsSeries).
// `lock` holds the root and customer rows until the caller's transaction ends (the conversion).
async function readCandidateRoots(conn, { customerId = null, parentId = null, lock = false } = {}) {
  const query = conn('scheduled_services as ss')
    .join('customers as c', 'c.id', 'ss.customer_id')
    .leftJoin('services as sv', 'sv.id', 'ss.service_id')
    .where('ss.is_recurring', true)
    .whereNull('ss.recurring_parent_id')
    .whereIn('ss.recurring_pattern', ['every_6_weeks', 'custom', LAWN_ROUNDS_9])
    .select('ss.*', 'sv.service_key as catalog_service_key', 'sv.name as catalog_service_name',
      'c.active as c_active', 'c.deleted_at as c_deleted_at', 'c.service_paused_at as c_service_paused_at',
      'c.service_pause_reason as c_service_pause_reason', 'c.pipeline_stage as c_pipeline_stage', 'c.property_type as c_property_type')
    .orderBy('ss.id');
  if (customerId) query.where('ss.customer_id', customerId);
  if (parentId) query.where('ss.id', parentId);
  if (lock) query.forUpdate('ss', 'c');
  return (await query).map(classifyRoot);
}

function classifyRoot(root) {
  if (root.recurring_pattern === LAWN_ROUNDS_9) return { skip: 'already rounds', root };
  const propertyType = String(root.c_property_type || '').trim().toLowerCase();
  const lawn9x = isLawn9xRoundsSeries({
    pattern: root.recurring_pattern,
    intervalDays: root.recurring_interval_days,
    service_type: root.service_type,
    service_key: root.catalog_service_key || root.service_key_snapshot || undefined,
    name: root.catalog_service_name || undefined,
    isCommercial: ['commercial', 'business'].includes(propertyType),
  });
  if (!lawn9x) return { skip: null, root };
  const customerSkip = seriesCustomerSkipReason({
    id: root.customer_id, active: root.c_active, deleted_at: root.c_deleted_at, service_paused_at: root.c_service_paused_at,
    service_pause_reason: root.c_service_pause_reason, pipeline_stage: root.c_pipeline_stage,
  });
  return customerSkip ? { skip: customerSkip, root } : { candidate: root };
}

// The planner's input for one root, from fresh reads. `skip` when the series has no live future visit.
async function readSeriesContext(conn, root, { todayET, nowMs = Date.now(), anchorOverride = null, areas = [] }) {
  const rows = await readFutureVisits(conn, root.id, todayET);
  if (!rows.length) return { skip: 'no live future visit' };
  const areaAnchor = await lawnAreaRoundAnchor(conn, root);
  const termIds = [...new Set(rows.map((v) => v.term_id).filter(Boolean))];
  const { rows: terms } = termIds.length
    ? await conn.raw('select id::text id, term_start::text "start", term_end::text "end" from annual_prepay_terms where id = any(?::uuid[])', [termIds])
    : { rows: [] };
  return {
    series: {
      parentId: String(root.id),
      customerId: String(root.customer_id),
      areaAnchor,
      areaKey: areas.find((a) => a.anchor === areaAnchor)?.key || null,
      terms: Object.fromEntries(terms.map((t) => [t.id, { start: t.start, end: t.end }])),
      anchorOverride,
      visits: rows.map((v) => ({
        id: v.id, date: v.d, ws: v.ws, we: v.we, dur: Number(v.dur), tech: v.tech, termId: v.term_id,
        prepaid: !!v.term_id, stay: stayReason(v, nowMs),
      })),
    },
  };
}

const windowEnd = (row) => row.we || hhmm(toMin(row.ws) + Number(row.dur));

// The first open start for a timed move on its new date, for its own length. Starts are on the hour (AGENTS.md:
// window_start is HH:00; the end follows the length): its own hour, then each later hour that ends by the end of
// the working day (scheduling/find-time hours), then each earlier hour. Open = the rebooker's own commit check
// (previewMoveConflicts: its technician scope and statuses, unassigned visits included) finds nothing, and no
// hour in `claimed` (earlier planned series in this run, by date, whatever the technician) overlaps.
// Returns [start, end] (HH:MM) or null.
async function openStart(conn, rebooker, move, claimed) {
  const length = toMin(windowEnd(move)) - toMin(move.ws);
  const own = Math.floor(toMin(move.ws) / 60);
  const last = Math.floor((DAY_END_HOUR * 60 - length) / 60);
  const top = Math.min(own, last + 1);
  const later = Array.from({ length: Math.max(0, last - own + 1) }, (_, i) => own + i);
  const earlier = Array.from({ length: Math.max(0, top - DAY_START_HOUR) }, (_, i) => top - 1 - i);
  for (const hour of [...later, ...earlier]) {
    const span = [hhmm(hour * 60), hhmm(hour * 60 + length)];
    if (claimed.some(([s, e]) => toMin(s) < hour * 60 + length && hour * 60 < toMin(e))) continue;
    if (!(await rebooker.previewMoveConflicts(move.id, move.to, { start: span[0], end: span[1] }, { conn })).length) return span;
  }
  return null;
}

// The schedule half of the plan. Each timed move gets its open start (openStart) as toWs/toWe, beside its source
// time (ws/we); a move with none, or a move onto a closed day, holds the series. An untimed move gets no time:
// auto-dispatch times it after the move. `reserved` (Map date -> [[start, end]]) carries the hours earlier series in
// this run claim; this call adds this plan's moves to it when the plan is not held. The reviewed signature adds each
// visit's source time and technician and its reviewed time, so --apply skips a series whose plan would differ.
async function reviewPlan(conn, plan, { closedDates = new Set(), reserved = new Map(), rebooker = require('./rebooker') } = {}) {
  const reasons = [...plan.heldReasons];
  const placed = new Map();
  for (const move of plan.moves) {
    if (closedDates.has(move.to)) reasons.push('closed day');
    const span = move.ws ? await openStart(conn, rebooker, move, reserved.get(move.to) || []) : [null, null];
    if (!span) reasons.push('hour taken');
    else placed.set(move.id, { ...move, toWs: span[0], toWe: span[1] });
  }
  const held = [...new Set(reasons)];
  if (!held.length) {
    for (const move of placed.values()) if (move.toWs) reserved.set(move.to, [...(reserved.get(move.to) || []), [move.toWs, move.toWe]]);
  }
  const visits = plan.visits.map((v) => placed.get(v.id) || v);
  return {
    ...plan,
    visits,
    moves: visits.filter((v) => v.kind === 'move'),
    heldReasons: held,
    held: held[0] || null,
    signature: JSON.stringify([plan.anchor, visits.map((v) => [v.id, v.from, v.ws, v.we, v.dur, v.tech, v.to, v.toWs || null, v.toWe || null])]),
  };
}

// Plan and review one series (the dry run and --apply both call this). An area plan held only because some area
// day has no open hour (the day is full) falls back to the customer's own weekday on the rounds (flag
// `area day full`) when that plan passes the review; otherwise the area plan and its hold stand.
async function planAndReview(conn, series, opts, review) {
  const plan = await reviewPlan(conn, planSeriesRedate(series, opts), review);
  if (plan.anchorSource !== 'area' || plan.heldReasons.join() !== 'hour taken') return plan;
  const own = await reviewPlan(conn, planSeriesRedate({ ...series, areaAnchor: null }, opts), review);
  return own.held ? plan : { ...own, flags: [...own.flags, 'area day full'] };
}

// ---- writes (--apply only) ---------------------------------------------------------------------------------------

// Move ONE visit, the way move-visit.js does. Throws with a reason when it refuses; nothing is written then.
// The stay rules are judged on a plain read, then again inside the move transaction (beforeMove: after the
// rebooker's date and technician-day locks, before its row write), where a reminder sent meanwhile shows. The
// `expect` pin covers what the rules read on the row itself (confirmation, staff lock, grouping, date, time,
// length, technician, status): a change that commits after the recheck makes the row write miss, and nothing moves.
async function moveVisitToRound(conn, deps, row) {
  // The visit must still be the planned snapshot (date, time, end, length, technician): a staff edit that lands while
  // earlier visits of the series move is never written over. `expect` then pins that snapshot on the row write.
  const unchanged = async (dbh) => {
    const v = await readVisit(dbh, row.id);
    if (!v || [v.d, v.ws, v.we, Number(v.dur), v.tech].join('|') !== [row.from, row.ws, row.we, row.dur, row.tech].join('|')
      || stayReason(v, deps.nowMs)) throw new Error(`visit ${row.id} changed since the plan`);
    return v;
  };
  const v = await unchanged(conn);
  // The planned open time (reviewPlan); an untimed visit moves by date only. A time taken since the plan is
  // refused by the rebooker's own commit check (SLOT_TAKEN), under its date lock; nothing is written.
  const window = row.toWs ? { start: row.toWs, end: row.toWe } : null;
  const result = await deps.rebooker.reschedule(row.id, row.to, window, MOVE_REASON, 'admin', {
    seriesPolicy: 'single',
    visitPolicy: 'single',
    suppressTechNotice: true,
    placeInRoute: true,
    beforeMove: unchanged,
    expect: {
      scheduled_date: v.d, window_start: v.window_start, window_end: v.window_end, technician_id: v.technician_id, status: v.status,
      estimated_duration_minutes: v.estimated_duration_minutes ?? null,
      customer_confirmed: v.customer_confirmed ?? null,
      auto_dispatch_locked: v.auto_dispatch_locked ?? null,
      auto_dispatch_excluded: v.auto_dispatch_excluded ?? null,
      visit_id: v.visit_id ?? null,
    },
  });
  if (result && result.smsSent === true) throw new Error(`visit ${row.id}: the rebooker reported a customer text; stopping`);
  // The reminder reads the committed row (an untimed visit uses its 08:00 convention), and only while the visit
  // still sits where this move put it: a newer reschedule keeps its own reminder (expectSchedule).
  await deps.reminders.handleReschedule(row.id, `${row.to}T${row.toWs || '08:00'}`, {
    sendNotification: false, keepPendingConfirmation: true, expectSchedule: { date: row.to, windowStart: row.toWs || null },
  });
  return v.tech;
}

const LIVE_FUTURE_SQL = `select ss.id::text id, ss.scheduled_date::text d, ss.annual_prepay_term_id::text term_id,
    ss.date_exception, ss.date_exception_source
  from scheduled_services ss
  where (ss.id = ? or ss.recurring_parent_id = ?) and ss.is_recurring is distinct from false
    and coalesce(ss.status,'pending') in ('pending','confirmed') and ss.scheduled_date >= ?::date
  for update`;

// The conversion, in one transaction under the series locks. The series must still pass the plan's identity and
// customer rules on locked rows (a cadence edit, a pause or a cancellation during the moves stops it), every
// planned visit must be at its target and no other live future visit may have appeared. Parent + live future
// children get recurring_pattern lawn_rounds_9 and no interval; the parent stores the anchor. Each move stamped
// its visit a one-off exception to the 6-week schedule; on the rounds those dates are the regular ones, so the
// stamps are cleared (a date the customer chose keeps its exception). A covering annual-prepay term on the
// every-6-weeks cadence is moved to lawn_rounds_9, or its renewal and gap-fill would write 42-day rows again.
async function convertSeries(conn, deps, plan) {
  return conn.transaction(async (trx) => {
    await deps.lockSeries(trx, plan.parentId);
    await deps.lockComms(trx, plan.customerId);
    const [entry] = await readCandidateRoots(trx, { parentId: plan.parentId, lock: true });
    if (!entry?.candidate) return { converted: false, why: entry?.skip || NOT_LAWN_9X };
    const { rows: live } = await trx.raw(LIVE_FUTURE_SQL, [plan.parentId, plan.parentId, deps.todayET || etDateString()]);
    const target = new Map(plan.visits.map((r) => [r.id, r.to]));
    if (live.length !== target.size || live.some((r) => target.get(r.id) !== r.d)) {
      return { converted: false, why: 'a visit is not at its target' };
    }
    const cols = await trx('scheduled_services').columnInfo();
    const now = new Date();
    const rounds = { recurring_pattern: LAWN_ROUNDS_9, recurring_interval_days: null, ...(cols.updated_at ? { updated_at: now } : {}) };
    await trx('scheduled_services').whereIn('id', live.map((r) => r.id)).update(rounds);
    const staleStamps = live.filter((r) => r.date_exception === true && !CUSTOMER_INITIATORS.has(String(r.date_exception_source || '')));
    await trx('scheduled_services').whereIn('id', staleStamps.map((r) => r.id)).update(DATE_EXCEPTION_CLEAR);
    await trx('scheduled_services').where({ id: plan.parentId }).update({
      ...rounds,
      ...(cols.recurring_round_anchor_date ? { recurring_round_anchor_date: plan.anchor } : {}),
    });
    const terms = await convertPrepayTerms(trx, deps, [...new Set(live.map((r) => r.term_id).filter(Boolean))], now);
    return { converted: true, termsMoved: terms };
  });
}

async function convertPrepayTerms(trx, deps, termIds, now) {
  if (!termIds.length) return 0;
  const { normalizeCoverageCadence, inferCoverageCadence } = deps.prepay;
  const terms = await trx('annual_prepay_terms').whereIn('id', termIds).forUpdate().select('*');
  const sixWeek = terms.filter((t) => (normalizeCoverageCadence(t.coverage_cadence) || inferCoverageCadence(t)) === 'every_6_weeks').map((t) => t.id);
  if (!sixWeek.length) return 0;
  // No spread in this write object: the annual-prepay term-states guard reads every term write (the table has updated_at).
  await trx('annual_prepay_terms').whereIn('id', sixWeek).update({ coverage_cadence: LAWN_ROUNDS_9, updated_at: now });
  return sixWeek.length;
}

// Apply ONE series. A series the run's own plan held stays held (the fresh checks below only add holds; the
// run's review reserved hours across series, which a single re-plan cannot see). The root is read again: a
// series that no longer passes the identity and customer rules (a cadence edit, a pause, a cancellation since
// the plan) is skipped. `replan(root)` re-plans it from fresh reads; the series is skipped when that differs
// from `plan` (a visit changed since the dry run). Returns { status, ... }: converted | held | skipped | error.
// An error after some moves leaves the series unconverted; a re-run plans zero moves for the visits already at
// target and finishes.
async function applySeries(conn, deps, plan, replan) {
  if (plan.held) return { status: 'held', why: plan.held };
  const [entry] = await readCandidateRoots(conn, { parentId: plan.parentId });
  const fresh = entry?.candidate ? await replan(entry.candidate) : { skip: entry?.skip || NOT_LAWN_9X };
  if (!fresh || fresh.skip) return { status: 'skipped', why: fresh?.skip || 'series not found' };
  if (fresh.signature !== plan.signature) return { status: 'skipped', why: 'series changed since the plan' };
  if (fresh.held) return { status: 'held', why: fresh.held };
  const moved = [];
  try {
    for (const row of fresh.moves) moved.push({ row, tech: await moveVisitToRound(conn, deps, row) });
    const conversion = await convertSeries(conn, deps, fresh);
    return conversion.converted
      ? { status: 'converted', moved, termsMoved: conversion.termsMoved }
      : { status: 'skipped', why: conversion.why, moved };
  } catch (err) {
    return { status: 'error', why: err.message, moved };
  }
}

module.exports = {
  DEFAULT_MAX_SHIFT_DAYS,
  STAY_WINDOW_HOURS,
  MOVE_REASON,
  stayReason,
  planSeriesRedate,
  readCandidateRoots,
  readSeriesContext,
  reviewPlan,
  planAndReview,
  moveVisitToRound,
  convertSeries,
  applySeries,
};
