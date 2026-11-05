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
//      The planner also refuses, as a Refusal and before any write: LINES_NEED_ZIPS (termite named
//      without --zips: termite / WDO series move only in a territory run, owner 2026-10-30) and
//      TARGET_CAPABILITY_OFF (--to's technician_capabilities row is Off for a line that has a series to move).
//   6. The rollback file is written and synced BEFORE the first update. Ids and counts only.
//      It carries a run id that the execute audit row records in the same transaction, so a
//      file left by a run that failed is refused by --rollback (RUN_NOT_COMMITTED).
//
// ROLLBACK needs the file's run to have committed (its execute audit row, same run id) and not to be
// rolled back already (one rollback audit row per run). It restores a series only while its template still reads (--to, override) and a visit only
// while it is still open, still held by --to, still on the day the run moved it, and the original
// technician can still take that day (assertAssignableTechnician), and only while it is in no visit
// group (a group's technician moves with its stops, through a path this run never calls). Everything
// else is listed. A
// restored visit gets back the route number the file kept (the run cleared it): an undo returns the
// old route, and the route repair that would renumber it is dark. Series go back after the visits,
// and only when the restored template gives new visits to --from again: a template that inherits from
// its parent row (no recurring technician, no override) follows whoever holds that row now.
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
// LOCK ORDER for a date move (the app's own, rebooker.js series mover): series-maintenance fences, then the date-wide occupancy
// lock of every day a visit leaves or lands on (a booking that probed availability waits), then the tech-day locks. The plan is
// recomputed after the locks, so --to's availability is read under them. The visit UPDATE is also pinned to no customer
// confirmation, no staff lock or exclusion, no date exception and the same hand-off date. ROLLBACK of a date move re-checks
// before it puts a day back: --from is free at the kept window (technicianFreeAt, under the occupancy lock), the customer has not
// confirmed the new day, no lock, exclusion, date exception or pending reschedule request was set, the old day is still outside
// the freeze margin, its current day is outside the freeze (ownScheduleFrozen) and no reminder is sent or inside the band; otherwise the visit stays
// with --to and is listed.
//
// --weekend-move (the day-60 run, planner header and second-tech-handover-weekend.js): a date move writes
// scheduled_date (the new day), technician_id = --to, route_order NULL, the tracking-link expiry that follows
// the date (track_token_expires_at, the rebooker's own helper), and the hand-off date rebase the series
// sweep uses (recurringDispatchDuePatch); window_start / window_end / status stay. Never a date_exception.
// Each month-based series' parent also gets recurring_nth / recurring_weekday (the stamp SmartRebooker.rescheduleSeries
// writes), compare-and-set on the values the plan read, in the same transaction. Tech-day locks: --from and --to
// on the day a visit leaves, --to on the day it lands. SmartRebooker.rescheduleSeries / reschedule were NOT used: they open
// their own transaction, write a reschedule_log row and run the customer-notice and reminder effects (a series move
// keeps each sibling's own technician_id), none of which this run may do; the direct write is audited here instead.
// SENDERS for a date change: the scheduled_services_sync_reminder trigger (models/migrations/20260716150000) fires on
// scheduled_date / window_start / status. It moves appointment_reminders.appointment_time to the new day, arms the
// 72 h flag when the new time is further out and re-arms the 24 h flag ("a silent reshuffle must not strand the customer
// with no day-before reminder"). It only writes reminder rows and sends nothing itself; the ordinary reminder cron, the
// only sender, then texts the standard reminder for the new day later, as it does for every flex-tier move. This run
// sends no day-change text and no other message. The rollback file is version 2 for these runs (version 1 files are
// still read): it also holds each moved visit's new day, window and old hand-off date and each parent's old and new anchor.
//
// Output carries counts, technician ids the operator typed, series ids, visit ids and the
// rollback file path. No names, addresses, phones or emails.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..', '..', 'server');
const planner = require('./second-tech-handover');
const { isAssignable, normalizeWorkDays, assertAssignableTechnician } = require(path.join(root, 'services', 'technician-eligibility'));
const { lockTechDays } = require(path.join(root, 'services', 'scheduling', 'tech-day-lock'));
const { acquireOccupancyLocks } = require(path.join(root, 'services', 'scheduling', 'occupancy'));
const { technicianFreeAt } = require(path.join(root, 'services', 'scheduling', 'pick-technician'));
const { loadReminderFreeze } = require(path.join(root, 'services', 'auto-dispatch', 'route-tiers'));
const { shiftDateStr } = require(path.join(root, 'services', 'auto-dispatch', 'dates'));
const { ownScheduleFrozen } = require(path.join(root, 'services', 'auto-dispatch', 'flex-tier'));
const { effectiveWindowEnd } = require('./second-tech-handover-weekend');
const { sendTechNotification } = require(path.join(root, 'services', 'tech-notify'));
const auditLog = require(path.join(root, 'services', 'audit-log'));
const { etParts, etDateString } = require(path.join(root, 'utils', 'datetime-et'));
const { recurringDispatchDuePatch } = require(path.join(root, 'services', 'scheduling', 'recurring-dispatch-due'));
const { scheduledServiceTrackTokenExpiry } = require(path.join(root, 'services', 'track-token-expiry'));

const { OPEN_STATUSES, STOPPED_TRACK_STATES } = planner;
const AUTO_DISPATCH_LOCK = 'cron:auto-dispatch-recurring';
// admin-schedule acquireRecurringSeriesMaintenanceLock's key, byte for byte: the per-series fence
// recurring maintenance (runRecurringSeriesMaintenance / topUpRecurringSeries, nightly 01:50 ET)
// takes before it extends a series. Held here through commit, an overlapping extension either
// lands before the final plan check (and changes the plan id) or reads the new template after.
const SERIES_MAINTENANCE_LOCK = 'recurring-series-maintenance';

/** Take the series-maintenance fence for each parent, sorted (series locks before tech-day locks, as the app does). */
async function lockSeriesMaintenance(trx, parentIds) {
  for (const id of [...new Set(parentIds.map(String))].sort()) {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', [SERIES_MAINTENANCE_LOCK, id]);
  }
}
const CARD_TYPE = 'series_handover';
const ROLLBACK_VERSION = 1;
// --weekend-move runs write version 2 (new dates, the old hand-off dates, the parents' old anchors); version 1 files are read as before.
const ROLLBACK_VERSION_WEEKEND = 2;

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
function summaryCard({ visits, customers, series, dayChanges = 0 }) {
  const days = dayChanges > 0 ? ` ${plural(dayChanges, 'visit', 'visits')} changed day.` : '';
  return {
    type: CARD_TYPE,
    message: `You now have ${plural(visits, 'visit', 'visits')} across ${plural(customers, 'customer', 'customers')}. They are on your schedule.${days}`,
    payload: { headline: 'Visits moved to your schedule', visits, customers, series, ...(dayChanges > 0 ? { dayChanges } : {}) },
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

/** The planner's own refusals (termite without --zips, --to Off for a line) read as the writer's Refusal, before any write. */
async function planOrRefuse(db, args) {
  try {
    return await planner.planHandover(db, args);
  } catch (err) {
    if (err instanceof planner.PlanError) throw new Refusal(err.code, err.message);
    throw err;
  }
}

/** The rollback file's contents: ids, dates and counts only (version 2 for --weekend-move). */
function buildRollbackRecord({ planId, from, to, start, lines, zips, weekendMove, plan, oldSeries, visitById }) {
  return {
    version: weekendMove ? ROLLBACK_VERSION_WEEKEND : ROLLBACK_VERSION,
    // Ties the file to this run: rollback needs this run's execute audit row (written in the same transaction).
    run_id: crypto.randomUUID(),
    plan_id: planId,
    created_at: new Date().toISOString(),
    from, to, start, lines,
    // --zips (territory build 6): each listed ZIP's territory technician before this run.
    zips,
    territory: plan.territory.map((t) => ({ zip: t.zip, technician_id: t.technician_id || null })),
    series: oldSeries.map((r) => ({ id: r.id, recurring_technician_id: r.recurring_technician_id || null, recurring_technician_override: r.recurring_technician_override === true })),
    visits: plan.ids.moves.map((m) => ({
      id: m.visit_id, date: m.date, technician_id: from,
      route_order: visitById.has(m.visit_id) ? visitById.get(m.visit_id).route_order : null,
      // --weekend-move: a date move also records the day it went to, its series, the window it kept and its old hand-off date.
      ...(m.to_date ? dateMoveRecord(m, visitById.get(m.visit_id)) : {}),
    })),
    // --weekend-move: each parent's anchor before and after (null = the column was empty).
    ...(weekendMove ? { weekend_move: true, anchors: plan.ids.anchors } : {}),
  };
}

/**
 * The day fences, in the app's order (rebooker's series mover): the date-wide occupancy lock of every day a DATE move leaves
 * or lands on first (a booking that probed availability waits for this run, and the re-planned availability below reads under
 * it), then the tech-day locks.
 */
async function lockDays(trx, moves, from, to) {
  await acquireOccupancyLocks(trx, moves.filter((m) => m.to_date).flatMap((m) => [m.date, m.to_date]));
  await lockTechDays(trx, moves.flatMap(dayLocksOf(from, to)));
}

/** Tech-day locks a move takes: --from and --to on the day it leaves, --to on the day it lands. */
const dayLocksOf = (from, to) => (m) => [
  { techId: from, date: m.date }, { techId: to, date: m.date }, ...(m.to_date ? [{ techId: to, date: m.to_date }] : []),
];

/** What the rollback file keeps of a date move. */
const dateMoveRecord = (m, old) => ({
  to_date: m.to_date, series_id: m.series_id, window_start: old ? old.ws : null, window_end: old ? old.we : null, due: old ? old.due : null,
});

/**
 * One planned visit: technician_id = --to and route_order NULL, compare-and-set on the row the plan read. A DATE move also
 * writes scheduled_date, the tracking-link expiry that follows the date, and the hand-off date rebase the series sweep uses
 * (recurringDispatchDuePatch); never a date_exception (top-up would keep landing on the old day).
 */
async function moveVisit(trx, m, { from, to, old }) {
  let query = trx('scheduled_services')
    .where({ id: m.visit_id, technician_id: from })
    .whereIn('status', OPEN_STATUSES)
    .where(function notStopped() { this.whereNull('track_state').orWhereNotIn('track_state', STOPPED_TRACK_STATES); })
    .whereRaw("to_char(scheduled_date, 'YYYY-MM-DD') = ?", [m.date]);
  let patch = { technician_id: to, route_order: null, updated_at: trx.fn.now() };
  if (m.to_date) {
    // Pinned to the row as the plan read it, and to the protections the plan checked: a customer confirmation, a staff lock or
    // exclusion, a date exception or a hand-off that landed since keeps the visit where it is (the run aborts, nothing is written).
    query = query.where({ status: old.status })
      .whereRaw('window_start IS NOT DISTINCT FROM ?::time', [old.ws]).whereRaw('window_end IS NOT DISTINCT FROM ?::time', [old.we])
      .whereRaw('customer_confirmed IS NOT TRUE').whereRaw('auto_dispatch_locked IS NOT TRUE').whereRaw('auto_dispatch_excluded IS NOT TRUE')
      .whereRaw('date_exception IS NOT TRUE').whereRaw('recurring_dispatch_due_date::text IS NOT DISTINCT FROM ?', [old.due]);
    patch = {
      ...patch,
      scheduled_date: m.to_date,
      track_token_expires_at: scheduledServiceTrackTokenExpiry(trx, m.to_date, old.window_end),
      ...recurringDispatchDuePatch({ recurring_dispatch_due_date: old.due, scheduled_date: m.date, window_start: old.ws }, { scheduled_date: m.to_date }),
    };
  }
  const n = await query.update(patch);
  if (n !== 1) throw new Error(`visit ${m.visit_id}: changed since the plan was read (rolled back)`);
}

/** Month-based series: stamp the parent's new nth / weekday, only while it still holds what the plan read. */
async function stampAnchors(trx, anchors) {
  for (const a of anchors) {
    const n = await trx('scheduled_services').where({ id: a.series_id })
      .whereRaw('recurring_nth IS NOT DISTINCT FROM ?', [a.old_nth]).whereRaw('recurring_weekday IS NOT DISTINCT FROM ?', [a.old_weekday])
      .update({ recurring_nth: a.nth, recurring_weekday: a.weekday, updated_at: trx.fn.now() });
    if (n !== 1) throw new Error(`series ${a.series_id}: its anchor changed since the plan was read (rolled back)`);
  }
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
  const zips = opts.zips || null;
  const weekendMove = opts.weekendMove === true;
  // A territory run also hands over termite / WDO (owner 2026-10-30); the planner's CLI passes the same default.
  const lines = opts.lines || (zips ? planner.TERRITORY_MOVABLE_LINES : planner.MOVABLE_LINES);
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

      const first = await planOrRefuse(trx, { from, to, start, today, lines, zips, weekendMove, now });
      if (first.planId !== planId) throw mismatch(first.planId);

      // Fence recurring maintenance for every planned series, then the tech-day fence every
      // assignment writer takes, for every day the moves touch. Both hold through commit.
      await lockSeriesMaintenance(trx, first.ids.retemplate);
      await lockDays(trx, first.ids.moves, from, to);
      // The authoritative read, under the locks: the series' neighbor occurrences are row-locked (FOR SHARE NOWAIT) so a concurrent
      // single-visit edit cannot slip between a visit's old and new day; a neighbor being edited refuses the plan (PLAN_MISMATCH).
      const plan = await planOrRefuse(trx, { from, to, start, today, lines, zips, weekendMove, now, lockNeighbors: true });
      if (plan.planId !== planId) throw mismatch(plan.planId);

      // The app's save-time check, once per destination day (absence rows refuse the run).
      for (const date of [...new Set(plan.ids.moves.map((m) => m.to_date || m.date))].sort()) {
        try {
          await assertAssignableTechnician(to, { conn: trx, date });
        } catch (err) {
          throw new Refusal('TARGET_UNAVAILABLE', `--to cannot take visits on ${date}: ${err.message}. Nothing was written.`);
        }
      }

      const seriesIds = plan.ids.retemplate;
      const visitIds = plan.ids.moves.map((m) => m.visit_id);
      // Lock the parents and confirm each template still gives new children to --from (the plan's ON FROM rule):
      // an office change to any other technician since the plan was read must not be overwritten.
      const oldSeries = seriesIds.length
        ? await trx('scheduled_services').whereIn('id', seriesIds).forUpdate()
          .select('id', 'technician_id', 'recurring_technician_id', 'recurring_technician_override') : [];
      for (const r of oldSeries) {
        if (planner.seriesTechnicianId(r) !== from) {
          throw new Error(`series ${r.id}: its template no longer gives new visits to --from (changed since the plan was read; rolled back)`);
        }
      }
      const oldVisits = visitIds.length
        ? await trx('scheduled_services').whereIn('id', visitIds)
          .select('id', 'technician_id', 'route_order', 'customer_id', 'status', 'window_end',
            trx.raw('recurring_dispatch_due_date::text as due'), trx.raw('window_start::text as ws'), trx.raw('window_end::text as we')) : [];
      const visitById = new Map(oldVisits.map((v) => [v.id, v]));
      const customers = new Set(oldVisits.map((v) => v.customer_id));

      const record = buildRollbackRecord({ planId, from, to, start, lines, zips, weekendMove, plan, oldSeries, visitById });
      // Before the first update, so a crash after commit still leaves the way back.
      const rollbackFile = writeRollbackFile(outDir, record);

      for (const old of oldSeries) {
        const n = await trx('scheduled_services')
          .where({ id: old.id })
          .whereRaw('recurring_technician_id IS NOT DISTINCT FROM ?', [old.recurring_technician_id || null])
          .whereRaw('recurring_technician_override IS NOT DISTINCT FROM ?', [old.recurring_technician_override])
          .whereRaw('technician_id IS NOT DISTINCT FROM ?', [old.technician_id || null])
          .update({ recurring_technician_id: to, recurring_technician_override: true, updated_at: new Date() });
        if (n !== 1) throw new Error(`series ${old.id}: template changed since the plan was read (rolled back)`);
      }
      if (oldSeries.length !== seriesIds.length) throw new Error('a planned series row is missing (rolled back)');
      for (const m of plan.ids.moves) await moveVisit(trx, m, { from, to, old: visitById.get(m.visit_id) });
      await stampAnchors(trx, plan.ids.anchors);
      // --zips: --to becomes the territory technician of every listed ZIP, only while each row still holds
      // what the plan read (the PLAN ID covers it).
      for (const t of plan.territory) {
        const n = await trx('territory_zips').where({ zip: t.zip })
          .whereRaw('technician_id IS NOT DISTINCT FROM ?', [t.technician_id || null])
          .update({ technician_id: to, updated_at: trx.fn.now() });
        if (n !== 1) throw new Error(`territory ZIP ${t.zip}: changed since the plan was read (rolled back)`);
      }

      const summary = {
        planId, from, to, start, lines, zips, territory: plan.territory.length,
        series: seriesIds.length, visits: visitIds.length, customers: customers.size,
        dates: [...new Set(plan.ids.moves.flatMap((m) => [m.date, m.to_date]).filter(Boolean))],
        dayChanges: plan.date_changes.visits, anchors: plan.ids.anchors.length,
        rollbackFile,
      };
      await auditLog.recordAuditEvent({
        actor_type: 'system',
        action: 'schedule.handover.execute',
        resource_type: 'technician_handover',
        metadata: {
          plan_id: planId, from, to, start, lines, zips, territory_zips: summary.territory, series: summary.series, visits: summary.visits, customers: summary.customers,
          ...(weekendMove ? { weekend_move: true, day_changes: summary.dayChanges, anchors: summary.anchors } : {}),
          run_id: record.run_id, rollback_file: path.basename(rollbackFile), source: 'ops/agents/second-tech-handover-execute.js',
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
    card = await sendTechNotification(to, summaryCard({ ...committed, dayChanges: committed.dayChanges }), { knex: db });
  }
  const { dates, ...rest } = committed;
  return { ...rest, dateCount: dates.length, flush, cardSent: card };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isRollbackRecord = (r) => r && [ROLLBACK_VERSION, ROLLBACK_VERSION_WEEKEND].includes(r.version) && /^[0-9a-f]{64}$/.test(String(r.plan_id || ''))
  && UUID_RE.test(String(r.run_id || '')) && r.from && r.to && Array.isArray(r.series) && Array.isArray(r.visits);

// The run this file belongs to must have committed (its execute audit row exists) and must not be undone already.
// A file left by a run that failed after writing it restores nothing it should: refuse it.
async function assertRunCommitted(trx, runId) {
  const rows = await trx('audit_log').whereIn('action', ['schedule.handover.execute', 'schedule.handover.rollback'])
    .whereRaw("metadata->>'run_id' = ?", [runId]).select('action');
  const actions = new Set(rows.map((r) => r.action));
  if (!actions.has('schedule.handover.execute')) {
    throw new Refusal('RUN_NOT_COMMITTED', 'this rollback file belongs to a run that did not commit (no execute audit row): it has nothing to undo. Nothing was written.');
  }
  if (actions.has('schedule.handover.rollback')) {
    throw new Refusal('ALREADY_ROLLED_BACK', 'this run was already rolled back. Nothing was written.');
  }
}

/** The visit rows a rollback may restore: still open, still held by --to, still on the day the run left it (the moved day for a date move). */
function restoreQuery(trx, v, to) {
  let query = trx('scheduled_services')
    .where({ id: v.id, technician_id: to })
    .whereIn('status', OPEN_STATUSES)
    .where(function notStopped() { this.whereNull('track_state').orWhereNotIn('track_state', STOPPED_TRACK_STATES); })
    .whereRaw("to_char(scheduled_date, 'YYYY-MM-DD') = ?", [v.to_date || v.date]);
  // A date move is restored only while it still has the window the run kept.
  if (v.to_date) query = query.whereRaw('window_start IS NOT DISTINCT FROM ?::time', [v.window_start ?? null]).whereRaw('window_end IS NOT DISTINCT FROM ?::time', [v.window_end ?? null]);
  return query;
}

/**
 * A date move goes back only to a day that is still free and still safe to move to: --from is free at the kept window (the
 * occupancy probe, with the day's occupancy lock held), the customer has not confirmed the new day, no staff lock or exclusion
 * was set, and no reminder for it is sent or inside the reminder band. A technician-only restore is not a date change.
 */
async function restoreDateBlocked(trx, v, now) {
  if (!v.to_date) return false;
  // The day it would go back to must clear the freeze margin (the 73 h reminder freeze) from now: a visit moved Saturday -> Thursday
  // cannot be put back on a Saturday that is now inside it, though its current day is not.
  if (v.date < shiftDateStr(etDateString(now), 4)) return true;
  const row = await trx('scheduled_services').where({ id: v.id }).forUpdate().first();
  // Only a pending or confirmed visit: a customer's reschedule request ('rescheduled') or a date exception recorded since is theirs to keep.
  if (!row || !['pending', 'confirmed'].includes(row.status) || row.date_exception === true) return true;
  if (row.customer_confirmed === true || row.auto_dispatch_locked === true || row.auto_dispatch_excluded === true) return true;
  // The visit's CURRENT day inside the freeze (73 h) keeps it too, whether or not it has a reminder row yet.
  if (await ownScheduleFrozen(trx, { ...row, scheduled_date: v.to_date }, now)) return true;
  const freeze = await loadReminderFreeze(trx, [v.id], now);
  if (freeze.failed || freeze.frozen.has(v.id)) return true;
  return !(await technicianFreeAt({
    conn: trx, technicianId: v.technician_id, date: v.date, windowStart: v.window_start, windowEnd: effectiveWindowEnd({ ...row, window_start: v.window_start, window_end: v.window_end }), excludeServiceIds: [v.id],
  }));
}

/** What a restored visit gets back: technician and route number, and for a date move its old day and hand-off date. */
function restorePatch(trx, v) {
  const patch = { technician_id: v.technician_id, route_order: v.route_order ?? null, updated_at: trx.fn.now() };
  if (!v.to_date) return patch;
  return {
    ...patch, scheduled_date: v.date, recurring_dispatch_due_date: v.due ?? null,
    track_token_expires_at: scheduledServiceTrackTokenExpiry(trx, v.date, v.window_end ?? null),
  };
}

/** A child the series' top-up created after the run (it sits on the new weekday and still depends on the new anchor). */
async function hasNewerChildren(trx, seriesId, record) {
  const recorded = record.visits.map((v) => v.id);
  const row = await trx('scheduled_services').where({ recurring_parent_id: seriesId }).whereNotIn('id', recorded)
    .whereNotIn('status', ['cancelled', 'skipped', 'no_show']).where('created_at', '>', record.created_at).first('id');
  return !!row;
}

/** Put the parents' nth / weekday back; returns the series ids whose anchor stayed. */
async function restoreAnchors(trx, record, restoredIds) {
  const kept = [];
  for (const a of record.anchors || []) {
    const moved = record.visits.filter((v) => v.to_date && v.series_id === a.series_id);
    if (!moved.every((v) => restoredIds.has(v.id)) || await hasNewerChildren(trx, a.series_id, record)) { kept.push(a.series_id); continue; }
    const n = await trx('scheduled_services').where({ id: a.series_id })
      .whereRaw('recurring_nth IS NOT DISTINCT FROM ?', [a.nth]).whereRaw('recurring_weekday IS NOT DISTINCT FROM ?', [a.weekday])
      .update({ recurring_nth: a.old_nth, recurring_weekday: a.old_weekday, updated_at: trx.fn.now() });
    if (n !== 1) kept.push(a.series_id);
  }
  return kept;
}

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
  if (!isRollbackRecord(record)) throw new Refusal('BAD_ROLLBACK_FILE', 'the file is not a version 1 or 2 handover rollback file');
  const window = restartWindowReason(now);
  if (window) throw new Refusal('RESTART_WINDOW', `refusing to run inside ${window}`);

  const { from, to } = record;
  const lock = await takeAutoDispatchLock(db);
  let result;
  try {
    result = await db.transaction(async (trx) => {
      await lockSeriesMaintenance(trx, record.series.map((s) => s.id));
      await lockDays(trx, record.visits, from, to);
      await assertRunCommitted(trx, record.run_id);
      const skipped = { series: [], visits: [], territory: [], anchors: [] };
      let seriesRestored = 0;
      let visitsRestored = 0;
      const restoredIds = new Set();
      // The original technician must still be able to take each day (the app's save-time check);
      // a day it cannot take keeps its visits with --to and lists them.
      const fromCanTake = new Map();
      for (const date of [...new Set(record.visits.map((v) => v.date))]) {
        try {
          await assertAssignableTechnician(from, { conn: trx, date });
          fromCanTake.set(date, true);
        } catch (err) {
          fromCanTake.set(date, false);
        }
      }
      for (const v of record.visits) {
        if (!fromCanTake.get(v.date) || await restoreDateBlocked(trx, v, now)) { skipped.visits.push(v.id); continue; }
        // Only a visit still on the day the run moved it (the day this rollback locked), and still in no group (the
        // planner's GROUPED rule: a service_visits row that is not dissolved), goes back.
        const n = await restoreQuery(trx, v, to)
          .where(function notGrouped() {
            this.whereNull('visit_id').orWhereExists(function dissolved() {
              this.select(1).from('service_visits as sv').whereRaw('sv.id = scheduled_services.visit_id').where('sv.status', 'dissolved');
            });
          })
          .update(restorePatch(trx, v));
        if (n === 1) { visitsRestored += 1; restoredIds.add(v.id); } else skipped.visits.push(v.id);
      }
      // Series AFTER the visits: a template with no recurring technician and no override gives new visits to
      // whoever holds the parent row, and the parent row can be one of the visits above. A series goes back only
      // while its template still reads (--to, override) AND the restored template gives new visits to --from
      // again (the plan's ON FROM rule); a parent row its own undo skipped, or that the office has moved to
      // someone else, keeps the series with --to, listed.
      for (const s of record.series) {
        const parent = await trx('scheduled_services').where({ id: s.id }).forUpdate()
          .first('id', 'technician_id', 'recurring_technician_id', 'recurring_technician_override');
        const stillTo = parent && parent.recurring_technician_id === to && parent.recurring_technician_override === true;
        const restored = parent && { ...parent, recurring_technician_id: s.recurring_technician_id, recurring_technician_override: s.recurring_technician_override };
        if (!stillTo || planner.seriesTechnicianId(restored) !== from) { skipped.series.push(s.id); continue; }
        await trx('scheduled_services').where({ id: s.id })
          .update({ recurring_technician_id: s.recurring_technician_id, recurring_technician_override: s.recurring_technician_override, updated_at: new Date() });
        seriesRestored += 1;
      }
      // --weekend-move: a parent's anchor goes back only while it still holds the run's stamp AND every date-moved visit
      // of its series was restored (a visit left on its new day needs the new anchor to stay on cadence) AND the series' top-up has
      // created no child since the run (it sits on the new weekday and needs the anchor too).
      const anchorsSkipped = await restoreAnchors(trx, record, restoredIds);
      skipped.anchors = anchorsSkipped;
      // --zips: a ZIP goes back to its earlier territory technician only while it still names --to.
      let territoryRestored = 0;
      for (const t of record.territory || []) {
        const n = await trx('territory_zips').where({ zip: t.zip, technician_id: to })
          .update({ technician_id: t.technician_id || null, updated_at: trx.fn.now() });
        if (n === 1) territoryRestored += 1; else skipped.territory.push(t.zip);
      }
      await auditLog.recordAuditEvent({
        actor_type: 'system',
        action: 'schedule.handover.rollback',
        resource_type: 'technician_handover',
        metadata: {
          plan_id: record.plan_id, run_id: record.run_id, from, to, series_restored: seriesRestored, visits_restored: visitsRestored,
          territory_restored: territoryRestored,
          series_skipped: skipped.series.length, visits_skipped: skipped.visits.length, territory_skipped: skipped.territory.length,
          anchors_skipped: skipped.anchors.length,
          source: 'ops/agents/second-tech-handover-execute.js',
        },
        critical: true,
        trx,
      });
      return { planId: record.plan_id, from, to, seriesRestored, visitsRestored, territoryRestored, skipped, dates: [...new Set(record.visits.flatMap((v) => [v.date, v.to_date]).filter(Boolean))] };
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
    out.push(`  territory ZIPs restored: ${r.territoryRestored}`);
    for (const id of r.skipped.anchors || []) out.push(`    anchor kept on series ${id}`);
    out.push(`  skipped (the row changed since): ${r.skipped.series.length} series, ${r.skipped.visits.length} visits, ${r.skipped.territory.length} territory ZIPs`);
    for (const zip of r.skipped.territory) out.push(`    territory ZIP ${zip}`);
    for (const id of r.skipped.series) out.push(`    series ${id}`);
    for (const id of r.skipped.visits) out.push(`    visit ${id}`);
  } else {
    out.push('Second-technician handover EXECUTED');
    out.push(`  PLAN ID: ${r.planId}`);
    out.push(`  from: ${r.from}   to: ${r.to}   first solo day: ${r.start}`);
    out.push(`  series templates moved: ${r.series}   visits moved: ${r.visits}   customers: ${r.customers}   days: ${r.dateCount}`);
    if (r.dayChanges) out.push(`  visits that changed day: ${r.dayChanges}   parent anchors re-stamped: ${r.anchors}`);
    if (r.zips) out.push(`  territory: ${r.territory} ZIPs now belong to the target (${r.zips.join(', ')})`);
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
        from: args.from, to: args.to, start, lines: args.lines, zips: args.zips, weekendMove: args.weekendMove, planId: args.plan, outDir: args.outDir || undefined,
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
  Refusal, CARD_TYPE, AUTO_DISPATCH_LOCK, SERIES_MAINTENANCE_LOCK,
  restartWindowReason, summaryCard, checkTarget, takeAutoDispatchLock,
  executeHandover, rollbackHandover, writeConn, main,
};
