// MUTATES
//
// second-tech-handover-execute.js — the write half of second-tech-handover.js (second-tech
// plan, build 6; owner 2026-10-28 "go": the handover run moves the new technician's visit
// series in one step, dry run first, and runs only on his word). Run it through the planner:
//
//   ... node ops/agents/second-tech-handover.js --from <owner> --to <hire> --start <day> \
//       --execute --plan <PLAN ID the dry run printed> [--out-dir <dir>]
//   ... node ops/agents/second-tech-handover.js --rollback <file this run wrote> [--out-dir <dir>]
//
// WHAT IT WRITES: the plan the dry run printed, and nothing else.
//   - SERIES: each retemplate series' parent gets recurring_technician_id = --to and
//     recurring_technician_override = true, the exact update the office "this and future"
//     technician change makes (admin-schedule assignScheduleJobs, scope following), so new
//     children seed to the hire. Dates, weekday, windows and service never change.
//   - VISITS: each open visit in the plan (dated >= --start, on a --to work day, held by
//     --from, not grouped, not bait) gets technician_id = --to and route_order = NULL, the
//     exact write of dispatch-assignment applyAssignment (the old technician's running
//     number must not ride onto the new route). Compare-and-set per row: a row that changed
//     since the plan was read aborts the whole run.
//   - AFTER COMMIT: the app's own post-change step for the affected dates
//     (refreshScheduleQualityAfterChange: route repair + quality ledger, dark unless its
//     gates are on), once for the batch, as the office bulk-assign path does; and ONE
//     summary card to the hire (sendTechNotification, type series_handover).
//
// SAFETY, in the order they run:
//   1. --to is required and is not --from. --to must be assignable by the app's rule
//      (technician-eligibility isAssignable: active + field_dispatchable) and carry an
//      explicit work-days list (normalizeWorkDays non-empty; "every day" is not a list).
//   2. No run inside the restart windows: 03:50-04:20 ET daily (04:10 auto-dispatch) and
//      06:40-07:02 ET Mondays.
//   3. The auto-dispatch writer lock: pg_try_advisory_lock(hashtext('cron:auto-dispatch-recurring')),
//      the lock runExclusive takes for the night run, its catch-up and the route reorder.
//      Held for the whole run on its own session; a held lock refuses the run.
//   4. PLAN ID: the plan is recomputed INSIDE the write transaction (once before taking the
//      tech-day locks, once after) and must equal --plan, or nothing is written.
//   5. The hire must be assignable on every date a visit moves to (the app's
//      assertAssignableTechnician: a technician_absences row for that date refuses the run).
//   6. The rollback file is written and synced BEFORE the first update. Ids and counts only.
//      A run that then fails leaves a file that restores nothing (no row holds --to).
//
// SENDERS (rule 12), checked against the save path (dispatch-assignment assignDispatchJob):
//   NOT CALLED: tech-visit-notifications notifyAssignmentChange (the per-visit visit_assigned /
//   visit_unassigned cards and pushes), emitDispatchJobUpdate (the dispatch board socket and
//   per-row quality refresh), visit-groups handleChildStopChanged and appointment-reminders
//   releaseMoveHoldIfRepaired (post-commit seams; grouped visits are never in the plan), the
//   rebooker and handleReschedule (no date or window changes). The only DB trigger on
//   scheduled_services that touches reminders (scheduled_services_sync_reminder) fires on
//   scheduled_date / window_start / status only, and sends nothing. No customer text, email
//   or call, and no per-visit staff message, can come from these writes. The one message is
//   the hire's summary card (a tech_notifications row; no push).
//
// Output carries counts, technician ids the operator typed, series ids, visit ids and the
// rollback file path. No names, addresses, phones or emails.
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..', '..', 'server');
const planner = require('./second-tech-handover');
const { isAssignable, normalizeWorkDays, assertAssignableTechnician } = require(path.join(root, 'services', 'technician-eligibility'));
const { lockTechDays } = require(path.join(root, 'services', 'scheduling', 'tech-day-lock'));
const { sendTechNotification } = require(path.join(root, 'services', 'tech-notify'));
const auditLog = require(path.join(root, 'services', 'audit-log'));
const { etParts, etDateString } = require(path.join(root, 'utils', 'datetime-et'));

const { OPEN_STATUSES, STOPPED_TRACK_STATES } = planner;
const AUTO_DISPATCH_LOCK = 'cron:auto-dispatch-recurring';
const CARD_TYPE = 'series_handover';
const ROLLBACK_VERSION = 1;

class Refusal extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'Refusal';
    this.code = code;
  }
}

/** A message naming why `now` falls in a restart window, or null. ET: 03:50-04:20 daily, 06:40-07:02 Mondays. */
function restartWindowReason(now = new Date()) {
  const { hour, minute, dayOfWeek } = etParts(now);
  const at = hour * 60 + minute;
  if (at >= 3 * 60 + 50 && at <= 4 * 60 + 20) return 'the 03:50-04:20 ET window around the 04:10 auto-dispatch run';
  if (dayOfWeek === 1 && at >= 6 * 60 + 40 && at <= 7 * 60 + 2) return 'the Monday 06:40-07:02 ET restart window';
  return null;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The hire's one summary card: counts only. */
function summaryCard({ visits, customers, series }) {
  return {
    type: CARD_TYPE,
    message: `You now have ${plural(visits, 'visit', 'visits')} across ${plural(customers, 'customer', 'customers')}. They are on your schedule.`,
    payload: { headline: 'Visits moved to your schedule', visits, customers, series },
  };
}

/** The target row must be assignable by the app's rule and have an explicit work-days list. */
function checkTarget(row) {
  if (!row) throw new Refusal('TARGET_MISSING', '--to: no technician row with that id');
  if (!isAssignable(row)) {
    throw new Refusal('TARGET_NOT_ASSIGNABLE', '--to is not assignable: the app needs employment_status active and field_dispatchable true');
  }
  if (!normalizeWorkDays(row.work_days)) {
    throw new Refusal('TARGET_NO_WORK_DAYS', '--to has no work days set (an empty list or all seven days is not a schedule): set the hire\'s work days first');
  }
}

/**
 * Take the auto-dispatch writer lock on a dedicated session. Returns { release }.
 * Refuses when anything else (the night run, catch-up, route reorder) holds it.
 */
async function takeAutoDispatchLock(db) {
  const conn = await db.client.acquireConnection();
  let locked = false;
  try {
    const res = await conn.query({ text: 'SELECT pg_try_advisory_lock(hashtext($1)) AS locked', values: [AUTO_DISPATCH_LOCK] });
    locked = !!(res && res.rows && res.rows[0] && res.rows[0].locked);
  } catch (err) {
    await db.client.releaseConnection(conn);
    throw err;
  }
  if (!locked) {
    await db.client.releaseConnection(conn);
    throw new Refusal('AUTO_DISPATCH_LOCK_HELD', 'the auto-dispatch run lock is held (a night run, catch-up or route reorder is working): try again when it ends');
  }
  return {
    async release() {
      try { await conn.query({ text: 'SELECT pg_advisory_unlock(hashtext($1))', values: [AUTO_DISPATCH_LOCK] }); } finally {
        await db.client.releaseConnection(conn);
      }
    },
  };
}

function writeRollbackFile(outDir, record) {
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(outDir, `handover-rollback-${record.plan_id.slice(0, 12)}-${stamp}.json`);
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(record, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return file;
}

// Post-commit, best-effort: the app's own refresh for the dates a batch touched. It reports
// its own failures; the batch is already committed.
async function flushDates(db, dates, refresh) {
  const list = [...new Set(dates)].filter(Boolean).sort();
  if (!list.length) return { status: 'no_dates' };
  try {
    const run = refresh || require(path.join(root, 'services', 'scheduling', 'quality-after-change')).refreshScheduleQualityAfterChange;
    const result = await run({ dates: list }, db);
    return { status: (result && result.status) || 'done', dates: list.length };
  } catch (err) {
    return { status: 'failed', dates: list.length, error: err.message };
  }
}

/**
 * Write the plan. `db` is a knex handle on a WRITABLE connection.
 * opts: { from, to, start, lines, planId, today?, now?, outDir?, refresh?, notify? }
 * Resolves to a counts-only summary; throws Refusal (nothing written) or an Error (rolled back).
 */
async function executeHandover(db, opts) {
  const { from, to, start, planId } = opts;
  const lines = opts.lines || planner.MOVABLE_LINES;
  const now = opts.now || new Date();
  const today = opts.today || etDateString(now);
  const outDir = opts.outDir || path.join(os.homedir(), 'handover-runs');
  if (!to) throw new Refusal('NO_TARGET', '--execute needs --to <the hire\'s technician uuid>');
  if (from === to) throw new Refusal('SAME_TECHNICIAN', '--from and --to are the same technician');
  if (!/^[0-9a-f]{64}$/.test(String(planId || ''))) {
    throw new Refusal('NO_PLAN_ID', '--execute needs --plan <PLAN ID>: run the dry run first and pass the id it printed');
  }
  const window = restartWindowReason(now);
  if (window) throw new Refusal('RESTART_WINDOW', `refusing to run inside ${window}`);

  const lock = await takeAutoDispatchLock(db);
  let committed = null;
  try {
    committed = await db.transaction(async (trx) => {
      const toRow = await trx('technicians').where({ id: to }).forShare().first('id', 'employment_status', 'field_dispatchable', 'work_days');
      checkTarget(toRow);
      const mismatch = (got) => new Refusal('PLAN_MISMATCH', `the plan changed since the dry run: this run's PLAN ID is ${got}, --plan is ${planId}. Nothing was written. Run the dry run again and read it.`);

      const first = await planner.planHandover(trx, { from, to, start, today, lines });
      if (first.planId !== planId) throw mismatch(first.planId);

      // The tech-day fence every assignment writer takes, for every day the moves touch.
      await lockTechDays(trx, first.ids.moves.flatMap((m) => [{ techId: from, date: m.date }, { techId: to, date: m.date }]));
      const plan = await planner.planHandover(trx, { from, to, start, today, lines });
      if (plan.planId !== planId) throw mismatch(plan.planId);

      // The app's save-time check, once per destination day (absence rows refuse the run).
      for (const date of [...new Set(plan.ids.moves.map((m) => m.date))].sort()) {
        try {
          await assertAssignableTechnician(to, { conn: trx, date });
        } catch (err) {
          throw new Refusal('TARGET_UNAVAILABLE', `--to cannot take visits on ${date}: ${err.message}. Nothing was written.`);
        }
      }

      const seriesIds = plan.ids.retemplate;
      const visitIds = plan.ids.moves.map((m) => m.visit_id);
      const oldSeries = seriesIds.length
        ? await trx('scheduled_services').whereIn('id', seriesIds).select('id', 'recurring_technician_id', 'recurring_technician_override') : [];
      const oldVisits = visitIds.length
        ? await trx('scheduled_services').whereIn('id', visitIds).select('id', 'technician_id', 'route_order', 'customer_id') : [];
      const visitById = new Map(oldVisits.map((v) => [v.id, v]));
      const customers = new Set(oldVisits.map((v) => v.customer_id));

      const record = {
        version: ROLLBACK_VERSION,
        plan_id: planId,
        created_at: new Date().toISOString(),
        from, to, start, lines,
        series: oldSeries.map((r) => ({ id: r.id, recurring_technician_id: r.recurring_technician_id || null, recurring_technician_override: r.recurring_technician_override === true })),
        visits: plan.ids.moves.map((m) => ({
          id: m.visit_id, date: m.date, technician_id: from,
          route_order: visitById.has(m.visit_id) ? visitById.get(m.visit_id).route_order : null,
        })),
      };
      // Before the first update, so a crash after commit still leaves the way back.
      const rollbackFile = writeRollbackFile(outDir, record);

      for (const id of seriesIds) {
        const n = await trx('scheduled_services')
          .where({ id })
          .where(function differs() {
            this.whereRaw('recurring_technician_id IS DISTINCT FROM ?', [to]).orWhere({ recurring_technician_override: false });
          })
          .update({ recurring_technician_id: to, recurring_technician_override: true, updated_at: new Date() });
        if (n !== 1) throw new Error(`series ${id}: template already changed since the plan was read (rolled back)`);
      }
      for (const m of plan.ids.moves) {
        const n = await trx('scheduled_services')
          .where({ id: m.visit_id, technician_id: from })
          .whereIn('status', OPEN_STATUSES)
          .where(function notStopped() { this.whereNull('track_state').orWhereNotIn('track_state', STOPPED_TRACK_STATES); })
          .whereRaw("to_char(scheduled_date, 'YYYY-MM-DD') = ?", [m.date])
          .update({ technician_id: to, route_order: null, updated_at: trx.fn.now() });
        if (n !== 1) throw new Error(`visit ${m.visit_id}: changed since the plan was read (rolled back)`);
      }

      const summary = {
        planId, from, to, start, lines,
        series: seriesIds.length, visits: visitIds.length, customers: customers.size,
        dates: [...new Set(plan.ids.moves.map((m) => m.date))],
        rollbackFile,
      };
      await auditLog.recordAuditEvent({
        actor_type: 'system',
        action: 'schedule.handover.execute',
        resource_type: 'technician_handover',
        metadata: {
          plan_id: planId, from, to, start, lines, series: summary.series, visits: summary.visits, customers: summary.customers,
          rollback_file: path.basename(rollbackFile), source: 'ops/agents/second-tech-handover-execute.js',
        },
        critical: true,
        trx,
      });
      return summary;
    });
  } finally {
    await lock.release();
  }

  // Committed. Everything below is best-effort and never undoes the run.
  const flush = await flushDates(db, committed.dates, opts.refresh);
  let card = false;
  if (opts.notify !== false && committed.visits > 0) {
    card = await sendTechNotification(to, summaryCard(committed), { knex: db });
  }
  const { dates, ...rest } = committed;
  return { ...rest, dateCount: dates.length, flush, cardSent: card };
}

const isRollbackRecord = (r) => r && r.version === ROLLBACK_VERSION && /^[0-9a-f]{64}$/.test(String(r.plan_id || ''))
  && r.from && r.to && Array.isArray(r.series) && Array.isArray(r.visits);

/**
 * Undo a run from its rollback file. Restores a row only while it still holds --to: a template
 * that still says (--to, override), an open visit that still has --to. Anything else is
 * skipped and listed. Sends nothing.
 */
async function rollbackHandover(db, opts) {
  const now = opts.now || new Date();
  let record;
  try {
    record = JSON.parse(fs.readFileSync(opts.file, 'utf8'));
  } catch (err) {
    throw new Refusal('BAD_ROLLBACK_FILE', `cannot read the rollback file: ${err.message}`);
  }
  if (!isRollbackRecord(record)) throw new Refusal('BAD_ROLLBACK_FILE', 'the file is not a version 1 handover rollback file');
  const window = restartWindowReason(now);
  if (window) throw new Refusal('RESTART_WINDOW', `refusing to run inside ${window}`);

  const { from, to } = record;
  const lock = await takeAutoDispatchLock(db);
  let result;
  try {
    result = await db.transaction(async (trx) => {
      await lockTechDays(trx, record.visits.flatMap((v) => [{ techId: from, date: v.date }, { techId: to, date: v.date }]));
      const skipped = { series: [], visits: [] };
      let seriesRestored = 0;
      let visitsRestored = 0;
      for (const s of record.series) {
        const n = await trx('scheduled_services')
          .where({ id: s.id, recurring_technician_id: to, recurring_technician_override: true })
          .update({ recurring_technician_id: s.recurring_technician_id, recurring_technician_override: s.recurring_technician_override, updated_at: new Date() });
        if (n === 1) seriesRestored += 1; else skipped.series.push(s.id);
      }
      for (const v of record.visits) {
        const n = await trx('scheduled_services')
          .where({ id: v.id, technician_id: to })
          .whereIn('status', OPEN_STATUSES)
          .where(function notStopped() { this.whereNull('track_state').orWhereNotIn('track_state', STOPPED_TRACK_STATES); })
          .update({ technician_id: v.technician_id, route_order: null, updated_at: trx.fn.now() });
        if (n === 1) visitsRestored += 1; else skipped.visits.push(v.id);
      }
      await auditLog.recordAuditEvent({
        actor_type: 'system',
        action: 'schedule.handover.rollback',
        resource_type: 'technician_handover',
        metadata: {
          plan_id: record.plan_id, from, to, series_restored: seriesRestored, visits_restored: visitsRestored,
          series_skipped: skipped.series.length, visits_skipped: skipped.visits.length,
          source: 'ops/agents/second-tech-handover-execute.js',
        },
        critical: true,
        trx,
      });
      return { planId: record.plan_id, from, to, seriesRestored, visitsRestored, skipped, dates: [...new Set(record.visits.map((v) => v.date))] };
    });
  } finally {
    await lock.release();
  }
  const flush = await flushDates(db, result.dates, opts.refresh);
  const { dates, ...rest } = result;
  return { ...rest, dateCount: dates.length, flush };
}

// ---- main -------------------------------------------------------------------

// A writable twin of the planner's readOnlyConn: same pinned TLS, field-wise connection and
// SCRAM-PLUS-only login; a pool of 3 (the lock session, the transaction, the post-commit work).
function writeConn(connectionString) {
  const ssl = planner.tlsFor(connectionString);
  if (ssl) planner.scramPlusOnly(require('pg'));
  return require('knex')({
    client: 'pg',
    connection: { ...planner.connectionFields(connectionString), ssl, ...(ssl ? { enableChannelBinding: true } : {}) },
    pool: { min: 0, max: 3 },
  });
}

function printSummary(r, { rollback }) {
  const out = [];
  if (rollback) {
    out.push('Second-technician handover ROLLBACK (done; no message was sent)');
    out.push(`  PLAN ID rolled back: ${r.planId}`);
    out.push(`  series templates restored: ${r.seriesRestored}   visits restored: ${r.visitsRestored}`);
    out.push(`  skipped (the row changed since): ${r.skipped.series.length} series, ${r.skipped.visits.length} visits`);
    for (const id of r.skipped.series) out.push(`    series ${id}`);
    for (const id of r.skipped.visits) out.push(`    visit ${id}`);
  } else {
    out.push('Second-technician handover EXECUTED');
    out.push(`  PLAN ID: ${r.planId}`);
    out.push(`  from: ${r.from}   to: ${r.to}   first solo day: ${r.start}`);
    out.push(`  series templates moved: ${r.series}   visits moved: ${r.visits}   customers: ${r.customers}   days: ${r.dateCount}`);
    out.push(`  summary card to the hire: ${r.cardSent ? 'written' : (r.visits > 0 ? 'NOT written (see the log); the moves are committed' : 'not needed (no visits moved)')}`);
    out.push(`  rollback file: ${r.rollbackFile}`);
    out.push(`  undo with: --rollback ${r.rollbackFile}`);
  }
  out.push(`  route refresh for the affected days: ${r.flush.status}${r.flush.error ? ` (${r.flush.error})` : ''}`);
  console.log(out.join('\n'));
}

async function main(args) {
  const conn = process.env.DATABASE_PUBLIC_URL;
  if (!conn) {
    console.error('DATABASE_PUBLIC_URL not set: run nested, as the dry run does (see the header of ops/agents/second-tech-handover.js)');
    process.exit(2);
  }
  let db;
  try {
    db = writeConn(conn);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  try {
    if (args.rollback) {
      printSummary(await rollbackHandover(db, { file: args.rollback }), { rollback: true });
    } else {
      const start = args.start || planner.defaultStart();
      printSummary(await executeHandover(db, {
        from: args.from, to: args.to, start, lines: args.lines, planId: args.plan, outDir: args.outDir || undefined,
      }), { rollback: false });
    }
  } catch (err) {
    if (err instanceof Refusal) {
      console.error(`REFUSED (${err.code}): ${err.message}`);
      process.exitCode = 3;
    } else {
      console.error(`FAILED, nothing was committed: ${err.message || err}`);
      process.exitCode = 1;
    }
  } finally {
    await db.destroy();
  }
}

module.exports = {
  Refusal, CARD_TYPE, AUTO_DISPATCH_LOCK,
  restartWindowReason, summaryCard, checkTarget, takeAutoDispatchLock,
  executeHandover, rollbackHandover, writeConn, main,
};
