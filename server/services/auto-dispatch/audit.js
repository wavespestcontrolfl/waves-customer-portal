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
        .where('c.active', true)
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
// New no-window notices rung per run. Same number as DEFAULT_RING_BUDGET in
// combined-booking-check.js (the daily budget the watchdog keeps), so one bad
// day cannot ring more bells than the sibling check would.
const NO_WINDOW_RING_BUDGET = 10;

// A row linked to an accepted estimate, directly or through its plan parent,
// belongs to the combined-booking check (its missing_time_tech bell covers
// the untimed visit). Same link rule as linkedToEstimate in
// combined-booking-check.js, so the two never ring for the same visit.
function excludeEstimateLinked(query) {
  return query.whereNull('s.source_estimate_id').whereNotExists(function parentLinked() {
    this.select('p.id').from('scheduled_services as p')
      .whereRaw('p.id = s.recurring_parent_id')
      .whereNotNull('p.source_estimate_id');
  });
}

// Recurring children that have neither an arrival window nor a due date, so
// auto-dispatch cannot place them and nothing else would tell staff.
function noWindowVisits(conn, from, to) {
  return excludeEstimateLinked(conn('scheduled_services as s')
    .join('customers as c', 'c.id', 's.customer_id')
    .where('s.is_recurring', true)
    .whereNotNull('s.recurring_parent_id')
    .whereNull('s.window_start')
    .whereNull('s.recurring_dispatch_due_date')
    .whereIn('s.status', ['pending', 'confirmed'])
    .where('s.scheduled_date', '>=', from)
    .where('s.scheduled_date', '<=', to)
    .where('c.active', true)
    .whereNull('c.deleted_at'));
}

// The windowless visits staff can act on now: plan not lapsed (a lapsed plan's
// visit is not placed, so asking for a time is noise). One plan read per plan.
async function actionableNoWindowRows(today, to) {
  const { isRecurringPlanActive } = require('./eligibility');
  const rows = await noWindowVisits(db, today, to)
    .select('s.id', 's.customer_id', 's.scheduled_date', 's.recurring_parent_id');
  const plans = new Map();
  const actionable = [];
  for (const row of rows) {
    const planKey = `${row.customer_id}:${row.recurring_parent_id}`;
    if (!plans.has(planKey)) plans.set(planKey, (await isRecurringPlanActive(row, db)).active);
    if (plans.get(planKey)) actionable.push({ ...row, date: toDateStr(row.scheduled_date) });
  }
  return actionable;
}

async function retireNoWindowNotices(nowDate, today, actionableIds) {
  await retireResolvedNotices({
    keyPattern: 'recurring-no-window:%',
    stillOpen: (sub) => excludeEstimateLinked(sub
      .whereRaw("s.scheduled_date::text = notifications.metadata->>'scheduledDate'")
      .whereIn('s.id', actionableIds)
      .where('s.is_recurring', true)
      .whereNotNull('s.recurring_parent_id')
      .whereNull('s.window_start')
      .whereNull('s.recurring_dispatch_due_date')
      .where('s.scheduled_date', '>=', today)
      .whereIn('s.status', ['pending', 'confirmed'])),
    resolvedTitle: 'Recurring visit time alert resolved',
    resolution: 'The visit now has an arrival time, is no longer waiting on one for that date, or its plan has lapsed',
    body: 'This visit no longer needs an arrival time set.',
  }, nowDate);
}

function noWindowKey(row) {
  return `recurring-no-window:${row.id}:${row.date}`;
}

// Rows to raise or refresh this run: every row that already has a notice
// (refresh only, no bell spent) plus at most `budget` new ones, soonest first.
// Rows past the budget wait for the next run.
function withinRingBudget(rows, existingKeys, budget) {
  const picked = [];
  let fresh = 0;
  const soonestFirst = [...rows].sort((a, b) => (a.date < b.date ? -1 : (a.date > b.date ? 1 : 0)));
  for (const row of soonestFirst) {
    if (existingKeys.has(noWindowKey(row))) picked.push(row);
    else if (fresh < budget) { fresh += 1; picked.push(row); }
  }
  return picked;
}

async function existingNoWindowKeys() {
  const rows = await db('notifications')
    .where({ recipient_type: 'admin', category: 'schedule_conflict' })
    .whereRaw("metadata->>'dedupeKey' LIKE ?", ['recurring-no-window:%'])
    .select(db.raw("metadata->>'dedupeKey' as dedupe_key"));
  return new Set(rows.map((r) => r.dedupe_key));
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
  const rows = candidates.length
    ? withinRingBudget(candidates, await existingNoWindowKeys(), NO_WINDOW_RING_BUDGET)
    : [];
  let flagged = 0;
  for (const row of rows) {
    const date = row.date;
    const notice = await db.transaction(async (trx) => {
      const current = await noWindowVisits(trx, today, to)
        .where({ 's.id': row.id, 's.customer_id': row.customer_id, 's.scheduled_date': date })
        .forNoKeyUpdate('s')
        .first('s.id');
      if (!current) return null;
      const inserted = await require('../admin-alert-compose').raiseAdminAlert('schedule_conflict', {
        area: 'Schedule',
        action: 'set an arrival time for a recurring visit',
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
  }
  return flagged;
}

// Close missing-pin notices the run no longer raised: the emitter owns the
// close, because a visit that left the skip list is not otherwise visible here.
// `flaggedIds` are the visits this run skipped for a missing pin on an active
// plan; call only after a pass 1 that finished.
async function retireMissingGeoNotices(flaggedIds, nowDate = new Date()) {
  await retireResolvedNotices({
    keyPattern: 'auto-dispatch-missing-geo:%',
    stillOpen: (sub) => sub
      .whereRaw("s.scheduled_date::text = notifications.metadata->>'scheduledDate'")
      .whereIn('s.id', [...flaggedIds]),
    resolvedTitle: 'Address pin alert resolved',
    resolution: 'Auto-dispatch no longer skips the visit for a missing address pin on that date',
    body: 'This visit no longer needs its address pin fixed.',
  }, nowDate);
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
  const noWindowRows = await prepareNoWindowNotices(nowDate, today, noWindowEnd);
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
  return flagged + await flagNoWindowVisits(noWindowRows, today, noWindowEnd);
}

module.exports = { startRun, logDecision, completeRun, settleAbandonedRuns, STALE_RUNNING_MINUTES, flagUnplacedVisits, retireMissingGeoNotices };
