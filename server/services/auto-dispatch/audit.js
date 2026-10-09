/**
 * Auto-dispatch run + per-service audit writers.
 *
 * auto_dispatch_runs   = one row per job run (counts + config snapshot + status)
 * auto_dispatch_audit_logs = one row per evaluated service (skip/no_change/
 *                            recommended/changed/failed) with before/after,
 *                            scores, preference + route-metric snapshots.
 * Also emits a single run-level row into the generic audit_log via recordAuditEvent.
 *
 * jsonb values are stringified — pg accepts a JSON string into a jsonb column,
 * and this avoids relying on driver auto-serialization.
 */
const db = require('../../models/db');
const { recordAuditEvent } = require('../audit-log');
const logger = require('./../logger');
const { toDateStr } = require('./dates');

function jsonb(value) {
  try { return JSON.stringify(value == null ? {} : value); } catch (_) { return '{}'; }
}

// A run whose process died mid-sweep (Railway container swap during the
// 4:10 tick — 2026-09-03, the GATE_PAY_PAGE_FAQ redeploy) never reaches
// completeRun, so its row stays 'running' forever: the Auto-Dispatch page
// shows a blue in-flight chip for a run that ended hours ago and the job
// watch pages "stuck" every morning. The advisory lock itself is freed by
// Postgres when the connection drops, so nothing blocks the next tick —
// only the ledger lies. Settle any prior 'running' row older than the
// longest plausible sweep before starting a new one. Best-effort: a failed
// settle must never stop a real run.
const STALE_RUNNING_MINUTES = 60;

async function settleAbandonedRuns() {
  try {
    const n = await db('auto_dispatch_runs')
      .where({ status: 'running' })
      .where('started_at', '<', new Date(Date.now() - STALE_RUNNING_MINUTES * 60 * 1000))
      .update({
        status: 'failed',
        completed_at: db.fn.now(),
        updated_at: db.fn.now(),
        error_message: `process exited mid-run (no completion recorded within ${STALE_RUNNING_MINUTES} min — deploy restart?)`,
      });
    if (n) logger.warn(`[auto-dispatch] settled ${n} abandoned run(s) still marked running`);
  } catch (e) {
    logger.warn(`[auto-dispatch] abandoned-run settle failed: ${e.message}`);
  }
}

async function startRun(config, triggeredBy = 'cron') {
  await settleAbandonedRuns();
  const [row] = await db('auto_dispatch_runs')
    .insert({
      status: 'running',
      mode: config.mode,
      config_snapshot: jsonb(config),
      triggered_by: triggeredBy,
    })
    .returning(['id']);
  return (row && (row.id || row)) || null;
}

/**
 * Insert one decision row. Fire-and-forget: a lost audit row must not abort the
 * run, but absence is logged.
 */
async function logDecision(runId, opts = {}) {
  const {
    action,
    service = null,
    reason_code = null,
    reason_description = null,
    oldPlacement = null,
    newPlacement = null,
    scores = null,
    prefsSnapshot = null,
    routeMetrics = null,
    constraints = null,
    appliedBy = null,
    error = null,
  } = opts;

  const svcDate = service ? toDateStr(service.scheduled_date) : null;
  const row = {
    auto_dispatch_run_id: runId,
    scheduled_service_id: (service && service.id) || null,
    customer_id: (service && service.customer_id) || null,
    recurring_parent_id: (service && service.recurring_parent_id) || null,
    action,
    reason_code,
    reason_description,
    old_scheduled_date: (oldPlacement && oldPlacement.date) || svcDate,
    old_window_start: (oldPlacement && oldPlacement.window_start) || (service && service.window_start) || null,
    old_window_end: (oldPlacement && oldPlacement.window_end) || (service && service.window_end) || null,
    old_technician_id: (oldPlacement && oldPlacement.technician_id) || (service && service.technician_id) || null,
    old_status: (oldPlacement && oldPlacement.status) || (service && service.status) || null,
    old_zone: (service && service.zone) || null,
    new_scheduled_date: (newPlacement && newPlacement.date) || null,
    new_window_start: (newPlacement && newPlacement.window_start) || null,
    new_window_end: (newPlacement && newPlacement.window_end) || null,
    new_technician_id: (newPlacement && newPlacement.technician_id) || null,
    new_status: (newPlacement && newPlacement.status) || null,
    new_zone: (newPlacement && newPlacement.zone) || null,
    old_score: scores ? scores.old : null,
    new_score: scores ? scores.new : null,
    score_improvement: scores ? scores.improvement : null,
    portal_preferences_snapshot: jsonb(prefsSnapshot),
    route_metrics_snapshot: jsonb(routeMetrics),
    constraints_checked: jsonb(constraints),
    applied_by: appliedBy,
    error_message: error,
  };

  try {
    await db('auto_dispatch_audit_logs').insert(row);
  } catch (e) {
    logger.error(`[auto-dispatch] audit insert failed (${action}/${reason_code}): ${e.message}`);
  }
}

async function completeRun(runId, { status, totals, error = null }) {
  try {
    await db('auto_dispatch_runs').where({ id: runId }).update({
      status,
      completed_at: db.fn.now(),
      updated_at: db.fn.now(),
      total_evaluated: totals.evaluated,
      total_skipped: totals.skipped,
      total_recommended: totals.recommended,
      total_changed: totals.changed,
      total_failed: totals.failed,
      error_message: error,
    });
  } catch (e) {
    logger.error(`[auto-dispatch] completeRun update failed for ${runId}: ${e.message}`);
  }

  try {
    await recordAuditEvent({
      actor_type: 'system',
      action: 'auto_dispatch.daily_run',
      resource_type: 'auto_dispatch_run',
      resource_id: runId,
      metadata: { status, ...totals, error },
    });
  } catch (_) { /* non-critical */ }
}

// Close admin cards of one key family whose visit no longer matches. Retires
// even if staff already acknowledged the card: the shared deduper needs changed
// content to reopen a later recurrence. Skips resolved cards so repeated
// recovery passes do not rewrite history. `stillOpen` adds the family's own
// conditions to the correlated "visit still matches" subquery.
async function retireResolvedNotices({ keyPattern, stillOpen, resolvedTitle, resolution, body }, nowDate) {
  await db('notifications')
    .where({ recipient_type: 'admin', category: 'schedule_conflict' })
    .whereNot('title', resolvedTitle)
    .whereRaw("metadata->>'dedupeKey' LIKE ?", [keyPattern])
    .whereNotExists(function stillMatches() {
      this.select('s.id').from('scheduled_services as s')
        .join('customers as c', 'c.id', 's.customer_id')
        // Only an explicit false is inactive, as the scans and eligibility.js
        // rule; `= true` closed a NULL-active customer's notice the moment
        // it was raised (Codex #6208 r17 P2).
        .whereRaw('c.active IS NOT FALSE')
        .whereNull('c.deleted_at')
        .whereRaw("s.id::text = notifications.metadata->>'scheduledServiceId'");
      stillOpen(this);
    })
    .update({
      ...require('../notification-service')._private.doneColumns({
        by: 'auto-dispatch', resolution, at: nowDate, keepExisting: true, conn: db,
      }),
      title: resolvedTitle,
      body,
      // The alert's original instruction was stored as the full text; a
      // resolved row must not keep it behind "Show full text".
      detail: null,
    });
}

// How far ahead a recurring visit with no arrival time and no due date raises
// a notice: far enough to set a time in dispatch before the lock window.
const NO_WINDOW_HORIZON_DAYS = 45;
// New notices the auto-dispatch lanes may ring in 24 hours, ALL lanes and all
// runs together (no-window, missing pin, reminder sync): the daily budget of
// docs/admin-notifications.md, the same number as DEFAULT_RING_BUDGET in
// combined-booking-check.js. Read from the notification rows themselves
// (ringsLeft), so a second run or a second lane cannot ring ten more.
const NEW_NOTICES_PER_RUN = 10;
// The schedule-integrity watchdog (06:40, its own job) rings under its bell
// classes with a per-run counter (MAX_ALERTS_PER_RUN) and the combined-booking
// check under its ops key. Their rings of the last 24 hours count here too, so
// auto-dispatch never adds to a day those jobs already filled. The watchdog
// itself is not reduced: its pages (unpriced series, prepay cover) outrank a
// pin notice, and its counter lives in one run of another process.
const WATCHDOG_BELL_KEYS = ['unpriced-series:', 'lawn-email-gap:', 'prepay-coverage:', 'accepted-schedule:', 'churned-live-work:', 'combined-booking-check:'];
// The due-date notice ('recurring-dispatch:', flagUnplacedVisits' first loop)
// is counted and NOT capped: it is for a visit within three days of its due
// date with no time, the time-critical field work the budget rule exempts
// (docs/admin-notifications.md). The lanes below run after it and see its rings.
const DUE_DATE_KEY = 'recurring-dispatch:';
const BUDGET_LANE_KEYS = ['auto-dispatch-missing-geo:', 'recurring-no-window:', 'auto-dispatch-reminder-sync:', DUE_DATE_KEY, ...WATCHDOG_BELL_KEYS];
// Titles a retired notice is rewritten to; the budget read must skip them.
const NO_WINDOW_RESOLVED_TITLE = 'Recurring visit time alert resolved';
const MISSING_GEO_RESOLVED_TITLE = 'Address pin alert resolved';

// Estimates whose untimed visit the combined-booking check ALREADY tells
// staff about: an open bell of that check for the estimate that carries its
// missing_time_tech problem. Read from the bell itself, not predicted from
// that check's candidate rules: each copied rule (gates, customer state,
// pipeline stage) left visits with no alert from either lane (Codex #6208
// r5, r12, r18, r20). A closed bell has no dedupeKey (retireStanding drops
// it), so a keyed row is an open one. No bell yet: the visit stays here; one
// extra notice beats none.
async function combinedBookingEstimateIds(estimateIds) {
  const ids = [...new Set(estimateIds.filter(Boolean).map(String))];
  if (!ids.length) return new Set();
  const rows = await db('notifications')
    .where({ recipient_type: 'admin', category: 'alert' })
    .whereRaw("metadata->>'dedupeKey' = ANY(?)", [ids.map((id) => `combined-booking-check:${id}`)])
    .whereRaw("jsonb_exists(coalesce(metadata->'problemCodes', '[]'::jsonb), 'missing_time_tech')")
    .select(db.raw("metadata->>'estimateId' as estimate_id"));
  return new Set(rows.map((row) => String(row.estimate_id)));
}

// Recurring children that have neither an arrival window nor a due date, so
// auto-dispatch cannot place them and nothing else would tell staff.
// Did this write ring? A new row rings; a deduped row rings only when its
// refresh says so (notification-service: deduped, refreshed, rung). A null
// result or a suppressed one (no id) recorded nothing.
function noticeRang(notice) {
  return !!(notice && notice.id) && (notice.deduped !== true || notice.rung === true);
}

// ROUTING_HORIZON_DAYS of combined-booking-check.js.
const SEASONAL_ROUTING_HORIZON_DAYS = 14;

// The action half of a visit notice's headline, with the customer's name when
// one can be read (docs/admin-notifications.md "Say who and what"; Codex
// #6208 r15 P2). No name: the generic wording. Never fails the notice.
async function namedVisitAction(customerId, templates, generic, conn = db) {
  const { lookupCustomerName, fitAction } = require('../admin-alert-names');
  const name = await lookupCustomerName(conn, customerId);
  return name ? fitAction('Schedule', name, templates) : generic;
}

function noWindowVisits(conn, from, to) {
  return conn('scheduled_services as s')
    .join('customers as c', 'c.id', 's.customer_id')
    .where('s.is_recurring', true)
    .whereNotNull('s.recurring_parent_id')
    .whereNull('s.window_start')
    .whereNull('s.recurring_dispatch_due_date')
    .whereIn('s.status', ['pending', 'confirmed'])
    .where('s.scheduled_date', '>=', from)
    .where('s.scheduled_date', '<=', to)
    // Only an explicit false is inactive, as eligibility.js rules: `active`
    // is nullable on legacy rows (Codex #6208 r16 P2).
    .whereRaw('c.active IS NOT FALSE')
    .whereNull('c.deleted_at');
}

// The windowless visits staff can act on now: plan not lapsed (a lapsed plan's
// visit is not placed, so asking for a time is noise). One plan read per plan.
async function actionableNoWindowRows(today, to) {
  const { isRecurringPlanActive } = require('./eligibility');
  const rows = await noWindowVisits(db, today, to)
    .select('s.id', 's.customer_id', 's.scheduled_date', 's.recurring_parent_id', 's.source_estimate_id',
      db.raw('(select p.source_estimate_id from scheduled_services as p where p.id = s.recurring_parent_id) as parent_estimate_id'),
      // The catalog key lives on `services`; scheduled_services stores only the
      // snapshot (Codex #6208 r18 P1: the bare column does not exist).
      db.raw('(select coalesce(cat.service_key, p.service_key_snapshot) from scheduled_services as p left join services as cat on cat.id = p.service_id where p.id = s.recurring_parent_id) as root_service_key'),
      // The series root's date and its booking's first day: a seasonal series
      // is exempt only when its root rolled past that first day (r20 P2).
      db.raw('(select p.scheduled_date from scheduled_services as p where p.id = s.recurring_parent_id) as root_date'),
      db.raw('(select min(r.scheduled_date) from scheduled_services as p join scheduled_services as r on r.source_estimate_id = p.source_estimate_id and r.customer_id = p.customer_id where p.id = s.recurring_parent_id) as booking_first_day'));
  // A seasonal mosquito series is booked with no time on purpose until the
  // office routes that season; it must have a time once inside the routing
  // horizon (combined-booking-check.js checkTimeAndTech, the same exemption;
  // Codex #6208 r15 P2).
  const routingHorizon = require('../../utils/datetime-et').etDateString(
    require('../../utils/datetime-et').addETDays(new Date(`${today}T12:00:00Z`), SEASONAL_ROUTING_HORIZON_DAYS));
  // Rolled: the root sits after the booking's first day, so the converter
  // booked it with no time on purpose. A root on the first day, or a booking
  // that cannot be read, is not exempt.
  const rolled = (row) => !!row.root_date && !!row.booking_first_day && toDateStr(row.root_date) > toDateStr(row.booking_first_day);
  const notRoutableYet = (row) => row.root_service_key === 'mosquito_seasonal' && rolled(row) && toDateStr(row.scheduled_date) > routingHorizon;
  const estimateOf = (row) => row.source_estimate_id || row.parent_estimate_id || null;
  const covered = await combinedBookingEstimateIds(rows.map(estimateOf));
  const plans = new Map();
  const actionable = [];
  for (const row of rows) {
    if (covered.has(String(estimateOf(row))) || notRoutableYet(row)) continue;
    const planKey = `${row.customer_id}:${row.recurring_parent_id}`;
    if (!plans.has(planKey)) plans.set(planKey, (await isRecurringPlanActive(row, db)).active);
    if (plans.get(planKey)) actionable.push({ ...row, date: toDateStr(row.scheduled_date) });
  }
  return actionable;
}

async function retireNoWindowNotices(nowDate, today, actionableIds) {
  await retireResolvedNotices({
    keyPattern: 'recurring-no-window:%',
    stillOpen: (sub) => sub
      .whereRaw("s.scheduled_date::text = notifications.metadata->>'scheduledDate'")
      .whereIn('s.id', actionableIds)
      .where('s.is_recurring', true)
      .whereNotNull('s.recurring_parent_id')
      .whereNull('s.window_start')
      .whereNull('s.recurring_dispatch_due_date')
      .where('s.scheduled_date', '>=', today)
      .whereIn('s.status', ['pending', 'confirmed']),
    resolvedTitle: NO_WINDOW_RESOLVED_TITLE,
    resolution: 'The visit now has an arrival time, is no longer waiting on one for that date, or its plan has lapsed',
    body: 'This visit no longer needs an arrival time set.',
  }, nowDate);
}

function noWindowKey(row) {
  return `recurring-no-window:${row.id}:${row.date}`;
}

function missingGeoKey(row) {
  return `auto-dispatch-missing-geo:${row.id}:${row.date}`;
}

// Rows to raise or refresh this run: every row that already has a standing
// notice (refresh only, no bell spent) plus at most `budget` new ones, soonest
// first. `budget` is what is left of the shared 24-hour allowance (ringsLeft).
// Rows past it wait for a later run. `keyOf` names the lane.
function withinRingBudget(rows, existingKeys, budget, keyOf = noWindowKey) {
  const picked = [];
  let fresh = 0;
  // notifyAdmin writes no row for an internal test customer, so such a visit
  // must not take a slot from a real one (Codex #6208 r8 P2).
  const { isInternalTestCustomerId } = require('../internal-test-customers');
  const soonestFirst = rows.filter((r) => !isInternalTestCustomerId(r.customer_id)).sort((a, b) => (a.date < b.date ? -1 : (a.date > b.date ? 1 : 0)));
  for (const row of soonestFirst) {
    if (existingKeys.has(keyOf(row))) picked.push(row);
    else if (fresh < budget) { fresh += 1; picked.push(row); }
  }
  return picked;
}

// Dedupe keys of a lane's STANDING notices. A resolved one is not standing:
// refreshOnDedupe reopens and rings it, so a reopening spends budget.
async function standingNoticeKeys(keyPattern, resolvedTitle) {
  const rows = await db('notifications')
    .where({ recipient_type: 'admin', category: 'schedule_conflict' })
    .whereNot('title', resolvedTitle)
    .whereRaw("metadata->>'dedupeKey' LIKE ?", [keyPattern])
    .select(db.raw("metadata->>'dedupeKey' as dedupe_key"));
  return new Set(rows.map((r) => r.dedupe_key));
}

// Dedupe keys of the budgeted lanes' notices that RANG in the last 24 hours.
// A reopened notice keeps its created_at; notification-service stamps
// metadata.rungAt on each ring, so that is the time counted. An Activity-only
// row never rings and is not counted.
async function recentBudgetKeys() {
  // No category filter: the watchdog and the combined-booking check ring
  // under 'alert', these lanes under 'schedule_conflict' (Codex #6208 r8 P1).
  const rows = await db('notifications')
    .where({ recipient_type: 'admin' })
    .whereRaw(
      `COALESCE((metadata->>'rungAt')::timestamptz, created_at) >= now() - interval '24 hours' AND COALESCE(metadata->>'feed', '') <> 'activity' AND (${BUDGET_LANE_KEYS.map(() => "metadata->>'dedupeKey' LIKE ?").join(' OR ')})`,
      BUDGET_LANE_KEYS.map((k) => `${k}%`),
    )
    .select(db.raw("metadata->>'dedupeKey' as dedupe_key"));
  return new Set(rows.map((r) => r.dedupe_key));
}

// New notices the lanes may still ring now. A lane reads it just before it
// raises, so it sees what an earlier lane or run rang.
async function ringsLeft() {
  return Math.max(0, NEW_NOTICES_PER_RUN - (await recentBudgetKeys()).size);
}

function standingMissingGeoKeys() {
  return standingNoticeKeys('auto-dispatch-missing-geo:%', MISSING_GEO_RESOLVED_TITLE);
}

// Retire standing notices that no longer apply, then return the visits to
// raise: computed first so a lapsed plan's notice closes in the same pass.
async function prepareNoWindowNotices(nowDate, today, to) {
  const rows = await actionableNoWindowRows(today, to);
  await retireNoWindowNotices(nowDate, today, rows.map((r) => r.id));
  return rows;
}

// One notice per windowless recurring visit. Same row lock + shared dedupe as
// the due-date notice, so a staff placement that wins the lock makes this a no-op.
async function flagNoWindowVisits(candidates, today, to) {
  const { shortDateET } = require('../admin-alert-names');
  if (!candidates.length) return 0;
  const standing = await standingNoticeKeys('recurring-no-window:%', NO_WINDOW_RESOLVED_TITLE);
  // A slot is spent only when a NEW notice is raised: a candidate the locked
  // recheck below drops (window set, cancelled, plan lapsed) leaves its slot
  // for the next visit in date order (Codex #6208 r10 P2).
  let left = await ringsLeft();
  let flagged = 0;
  for (const row of withinRingBudget(candidates, standing, Infinity)) {
    // Allowance spent: nothing more is raised, a standing notice included (a
    // refresh whose text changed would ring; Codex #6208 r16 P2).
    if (left <= 0) break;
    const date = row.date;
    const notice = await db.transaction(async (trx) => {
      const current = await noWindowVisits(trx, today, to)
        .where({ 's.id': row.id, 's.customer_id': row.customer_id, 's.scheduled_date': date })
        .forNoKeyUpdate('s')
        .first('s.id');
      if (!current) return null;
      // The plan may have lapsed since actionableNoWindowRows read it; the
      // visit's row lock does not hold recurring_plan_alerts (Codex #6208 r9 P2).
      if (!(await require('./eligibility').isRecurringPlanActive(row, trx)).active) return null;
      const inserted = await require('../admin-alert-compose').raiseAdminAlert('schedule_conflict', {
        area: 'Schedule',
        action: await namedVisitAction(row.customer_id,
          [(who) => `set an arrival time for ${who}'s visit`, (who) => `set a time for ${who}'s visit`],
          'set an arrival time for a recurring visit', trx),
        why: `The ${shortDateET(`${date}T12:00:00Z`)} visit has no arrival time; set one in dispatch so it can be placed.`,
        severity: 'needs-you',
        link: `/admin/dispatch?tab=schedule&date=${date}&appointment=${encodeURIComponent(row.id)}`,
        subject: { type: 'visit', id: String(row.id) },
        doneWhen: 'visit_has_arrival_time',
        who: 'person',
      }, {
        bell: true,
        dedupeKey: noWindowKey(row),
        refreshOnDedupe: true,
        metadata: { scheduledServiceId: row.id, customerId: row.customer_id, scheduledDate: date },
        trx,
      });
      if (!inserted) throw new Error(`Recurring no-window notice could not be recorded for ${row.id}`);
      return inserted;
    });
    if (notice) flagged += 1;
    if (noticeRang(notice)) left -= 1;
  }
  return flagged;
}

// Close a missing-pin notice when its visit no longer needs it: the visit is
// gone from that date or no longer live, or THIS run found a usable pin for it
// (`pinOkIds`: the visits that passed eligibility, so their pin resolved). A
// visit the run did not look at (inside the date boundary, locked, excluded,
// skipped earlier for another reason) keeps its notice: absence from a run
// proves nothing about its pin (Codex #6208 pre-push P1).
async function retireMissingGeoNotices(pinOkIds, nowDate = new Date()) {
  const { etDateString } = require('../../utils/datetime-et');
  await retireResolvedNotices({
    keyPattern: 'auto-dispatch-missing-geo:%',
    stillOpen: (sub) => sub
      .whereRaw("s.scheduled_date::text = notifications.metadata->>'scheduledDate'")
      .where('s.scheduled_date', '>=', etDateString(nowDate))
      .whereIn('s.status', ['pending', 'confirmed'])
      .whereNotIn('s.id', [...pinOkIds]),
    resolvedTitle: MISSING_GEO_RESOLVED_TITLE,
    resolution: 'The visit has a usable address pin, or is no longer waiting on that date',
    body: 'This visit no longer needs its address pin fixed.',
  }, nowDate);
}

// Missing-pin notice upkeep for a night the placement run does not happen
// (cronJobs or autoDispatch off): nothing evaluates pins then, so read the
// standing notices' own visits and close each one whose pin now resolves,
// or whose visit is gone (Codex #6208 r17 P2). The run does this itself
// (index.js closeMissingGeoNotices) when it is on.
async function maintainMissingGeoNotices(nowDate = new Date()) {
  const { resolveGeo } = require('./geo');
  const ids = [...await standingMissingGeoKeys()].map((key) => key.split(':')[1]).filter(Boolean);
  if (!ids.length) return;
  const rows = await db('scheduled_services')
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .whereIn('scheduled_services.id', ids)
    .select('scheduled_services.*', 'customers.latitude as customer_latitude', 'customers.longitude as customer_longitude',
      'customers.address_line1 as customer_address_line1', 'customers.city as customer_city', 'customers.zip as customer_zip');
  const { isRecurringPlanActive } = require('./eligibility');
  const close = new Set();
  for (const row of rows) {
    // A pin that resolves, or a plan that lapsed: nobody needs to fix this
    // pin (the run applies the same two tests; r18 P2). An unreadable plan
    // keeps the notice.
    const lapsed = async () => { try { return !(await isRecurringPlanActive(row, db)).active; } catch (_) { return false; } };
    if (resolveGeo(row) || await lapsed()) close.add(String(row.id));
  }
  await retireMissingGeoNotices(close, nowDate);
}

// Include skipped/locked rows: unplaced due dates must not disappear behind
// eligibility filters or the run cap. The existing bell dedupes repeated runs.
async function flagUnplacedVisits(config, nowDate = new Date()) {
  const { etDateString, addETDays } = require('../../utils/datetime-et');
  const { toDateStr } = require('./dates');
  await retireResolvedNotices({
    keyPattern: 'recurring-dispatch:%',
    stillOpen: (sub) => sub
      .whereRaw("s.recurring_dispatch_due_date::text = notifications.metadata->>'dueDate'")
      .whereNull('s.window_start')
      .whereIn('s.status', ['pending', 'confirmed']),
    resolvedTitle: 'Recurring placement alert resolved',
    resolution: 'The visit is no longer awaiting placement',
    body: 'This visit is no longer awaiting placement for the recorded due date.',
  }, nowDate);
  const today = etDateString(nowDate);
  const noWindowEnd = etDateString(addETDays(nowDate, NO_WINDOW_HORIZON_DAYS));
  // The no-window lane must not take the due-date lane down with it: a
  // failure here is held until the time-critical due-date notices below are
  // out, then thrown so the run still reports it (Codex #6208 r13 P2).
  let noWindowRows = [];
  let noWindowError = null;
  try {
    noWindowRows = await prepareNoWindowNotices(nowDate, today, noWindowEnd);
  } catch (err) {
    noWindowError = err;
  }
  const cutoff = etDateString(addETDays(nowDate, Math.max(14, config.lockWindowDays + 4)));
  const rows = await db('scheduled_services as s')
    .join('customers as c', 'c.id', 's.customer_id')
    .whereNotNull('s.recurring_dispatch_due_date')
    .whereNull('s.window_start')
    .whereIn('s.status', ['pending', 'confirmed'])
    .where('s.recurring_dispatch_due_date', '<=', cutoff)
    .where('c.active', true)
    .whereNull('c.deleted_at')
    .select('s.id', 's.customer_id', 's.recurring_dispatch_due_date');
  const notifications = require('../notification-service');
  let flagged = 0;
  for (const row of rows) {
    const due = toDateStr(row.recurring_dispatch_due_date);
    const notice = await db.transaction(async (trx) => {
      // Pin placement through the shared notification dedupe/write. A staff
      // placement that won the row lock makes this a no-op; one that follows
      // us waits until the still-valid alert has committed.
      const current = await trx('scheduled_services as s')
        .join('customers as c', 'c.id', 's.customer_id')
        .where({ 's.id': row.id, 's.customer_id': row.customer_id, 's.recurring_dispatch_due_date': due, 'c.active': true })
        .whereNull('c.deleted_at')
        .whereNull('s.window_start')
        .whereIn('s.status', ['pending', 'confirmed'])
        .forNoKeyUpdate('s')
        .first('s.id');
      if (!current) return null;
      const inserted = await notifications.notifyAdmin(
        'schedule_conflict',
        'Recurring visit still needs a time',
        `A recurring visit due ${due} is still awaiting placement within three days of its due date. Review availability and customer preferences in dispatch.`,
        {
          bell: true,
          link: `/admin/dispatch?tab=schedule&date=${due}`,
          dedupeKey: `recurring-dispatch:${row.id}:${due}`,
          // Reopen a previously resolved card if this due date becomes unplaced
          // again; the shared deduper leaves acknowledged, unchanged cards alone.
          refreshOnDedupe: true,
          metadata: { scheduledServiceId: row.id, customerId: row.customer_id, dueDate: due },
          trx,
        },
      );
      if (!inserted) throw new Error(`Recurring placement exception could not be recorded for ${row.id}`);
      return inserted;
    });
    if (notice) flagged += 1;
  }
  if (noWindowError) throw noWindowError;
  return flagged + await flagNoWindowVisits(noWindowRows, today, noWindowEnd);
}

module.exports = { startRun, logDecision, completeRun, settleAbandonedRuns, STALE_RUNNING_MINUTES, flagUnplacedVisits, retireMissingGeoNotices, maintainMissingGeoNotices, standingMissingGeoKeys, withinRingBudget, recentBudgetKeys, ringsLeft, missingGeoKey, namedVisitAction, noticeRang, NEW_NOTICES_PER_RUN };
