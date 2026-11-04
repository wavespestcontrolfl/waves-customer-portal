/**
 * Day re-plan APPLY writer (owner ruling 2026-11-03, PR 2 of 3). Runs only in apply mode (GATE_DAY_REPLAN=true,
 * the owner's flip), for a tech-day whose plan the planner AND the app's own simulator accepted, inside the 04:40
 * job's `auto-dispatch-recurring` writer lock. Shadow and off never reach this file.
 *
 * The owner's rule: any visit may get a new hour, the lock is 24 hours, and NO text goes out about the move: the
 * 24-hour reminder carries the new time (the same silent reminder sync the night auto-dispatch writer runs).
 *
 * Before the first write (all of it, so a refusal leaves nothing partly moved):
 *   1. the tech-day is read again and re-planned; it is written only if the fresh plan makes exactly the same
 *      changes AND the version hash of every stop of the date is unchanged ('changed_since_plan' otherwise);
 *   2. the moves are put in an order in which each visit's new hours are free at its step (./sequence.js), with a
 *      temporary hour to break a swap or a cycle; no such order = 'no_safe_sequence'.
 * Each step then goes through the same writer path as auto-dispatch/apply.js: SmartRebooker.reschedule for a
 * single occurrence with an `expect` CAS pinned on the fresh read, no tech notice, no customer notice, the route
 * numbered in place; then apply.js's own syncMovedReminders (AppointmentReminders.handleReschedule with
 * sendNotification false). Inside the move's own transaction (beforeMove) the visit must still be movable under
 * the same rules the planner used (fixedReason): status, 24.25 hours, reminder, staff lock, grouping, co-visit.
 * A step that fails rolls the day back through the same path, in reverse ('rolled_back'); a rollback step that
 * fails leaves the day as it is ('failed') and raises one admin notice for Claude's queue.
 *
 * The writes carry the initiator 'day_replan', which is automatic (eligibility.js) and is NOT the
 * 'auto_dispatch' signature that move-limit.js counts, so the night pass's own 2-move cap is untouched.
 */
const logger = require('../logger');
const { toDateStr } = require('../auto-dispatch/dates');
const { sequenceMoves, hoursMask } = require('./sequence');

const INITIATOR = 'day_replan';
const REASON_CODE = 'day_replan';

const minToHhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const norm5 = (value) => (value ? String(value).slice(0, 5) : null);

function coded(code, message) {
  return Object.assign(new Error(message || code), { code });
}

/** The accepted plan's changes as one comparable string. */
function changesKey(changes) {
  return JSON.stringify([...changes].map((c) => [String(c.id), c.fromMin, c.toMin]).sort((a, b) => a[0].localeCompare(b[0])));
}

/**
 * The visit, read inside its own move transaction, must still be movable under the rules the planner used.
 * `toStart` is checked as well as the current start: a visit may not be moved INTO the 24-hour reach either.
 */
async function recheckVisit(trx, deps, { id, dateStr, toStart }) {
  const row = await trx('scheduled_services').where({ id }).first(
    'id', 'status', 'window_start', 'customer_id', 'visit_id', 'reservation_expires_at', 'auto_dispatch_locked', 'auto_dispatch_excluded',
  );
  if (!row) throw coded('NOT_MOVABLE', 'the visit no longer exists');
  const live = (q) => q.whereNotIn('status', deps.excludedStatuses);
  const mate = row.visit_id != null
    ? await live(trx('scheduled_services').where({ visit_id: row.visit_id }).whereNot({ id })).first('id') : null;
  const sameCustomer = row.customer_id != null
    ? await live(trx('scheduled_services').where({ customer_id: row.customer_id, scheduled_date: dateStr }).whereNot({ id }))
      .whereRaw('(reservation_expires_at IS NULL OR reservation_expires_at > NOW())').first('id') : null;
  const reminder = await trx('appointment_reminders').where({ scheduled_service_id: id }).first('reminder_24h_sent');
  const ctx = {
    dateStr,
    now: deps.now(),
    visitCounts: new Map(row.visit_id != null ? [[row.visit_id, mate ? 2 : 1]] : []),
    customerCounts: new Map(row.customer_id != null ? [[row.customer_id, sameCustomer ? 2 : 1]] : []),
    sent24: new Set(reminder && reminder.reminder_24h_sent === true ? [id] : []),
  };
  const why = deps.fixedReason(row, ctx) || deps.fixedReason({ ...row, window_start: minToHhmm(toStart) }, ctx);
  if (why) throw Object.assign(coded('NOT_MOVABLE', `the visit is no longer movable: ${why}`), { why });
}

/**
 * One write: the same path auto-dispatch/apply.js takes for a single occurrence. `recheck` is false for a
 * rollback step, which must be able to put a visit back even after the 24-hour reach has moved in.
 */
async function moveVisit(conn, deps, { id, dateStr, fromStart, toStart, widthMin, recheck }) {
  const row = await conn('scheduled_services').where({ id }).first(
    'customer_id', 'scheduled_date', 'window_start', 'window_end', 'technician_id', 'status',
    'auto_dispatch_locked', 'auto_dispatch_excluded', 'visit_id', 'recurring_dispatch_due_date', 'customer_confirmed', ...deps.locationFields,
  );
  if (!row) throw coded('CHANGED_SINCE_PLAN', 'the visit no longer exists');
  if (toDateStr(row.scheduled_date) !== dateStr || norm5(row.window_start) !== minToHhmm(fromStart)) {
    throw coded('CHANGED_SINCE_PLAN', 'the visit is not where the step expects it');
  }
  const best = { date: dateStr, start_time: minToHhmm(toStart), end_time: minToHhmm(toStart + widthMin) };
  const options = {
    seriesPolicy: 'single',
    visitPolicy: 'single',
    // The visit keeps its own status inside the move (pending stays pending), as in apply.js.
    keepStatus: true,
    suppressTechNotice: true,
    placeInRoute: true,
    notifyRequested: false,
    // The rebooker re-asserts all of this inside the move transaction (a plain 409 when anything changed).
    expect: {
      auto_dispatch_locked: false,
      auto_dispatch_excluded: false,
      status: row.status,
      scheduled_date: toDateStr(row.scheduled_date),
      window_start: row.window_start,
      window_end: row.window_end,
      technician_id: row.technician_id,
      // The fresh value: null for an ungrouped visit (a visit that gets grouped meanwhile misses the CAS), or the
      // visit record of a visit that is alone in it (a grouped one never gets here: the recheck refuses it).
      visit_id: row.visit_id ?? null,
      ...Object.fromEntries(['recurring_dispatch_due_date', 'customer_confirmed', ...deps.locationFields].map((field) => [field, row[field] ?? null])),
    },
    ...(recheck ? { beforeMove: (trx) => recheckVisit(trx, deps, { id, dateStr, toStart }) } : {}),
  };
  const result = (await deps.rebooker.reschedule(id, dateStr, { start: best.start_time, end: best.end_time }, REASON_CODE, INITIATOR, options)) || {};
  // From here the move is committed: a failure below must still be rolled back with the steps before it.
  try {
    // A customer text here would break the owner's rule, so stop and put the day back.
    if (result.smsSent === true) throw coded('CUSTOMER_TEXT_SENT', `visit ${id}: the rebooker reported a customer text`);
    // The 24-hour reminder carries the new time: the same silent sync apply.js runs (best-effort, with its own notice).
    await deps.syncMovedReminders({ id, customer_id: row.customer_id }, best, result, []);
  } catch (err) {
    throw Object.assign(err, { committed: true });
  }
}

/** The moves of the accepted plan, from the fresh read: every changed stop must be a lone visit. */
function movesFrom(fresh) {
  const stopById = new Map(fresh.stops.map((s) => [String(s.id), s]));
  const groupOf = new Map(fresh.rowGroups.map((g) => [String(g[0].id), g]));
  const moves = [];
  for (const change of fresh.result.changes) {
    const stop = stopById.get(String(change.id));
    const group = groupOf.get(String(change.id));
    if (!stop || !group || group.length !== 1) return null;
    moves.push({
      id: stop.id, fromStart: change.fromMin, toStart: change.toMin, widthMin: stop.slotWidthMin, workMin: stop.workMin, pref: stop.pref || null,
    });
  }
  return moves;
}

/** Hours held by everything that does not move: the day's other rows that block (as the planner's blockedHours does). */
function heldMaskFor(fresh, moves, techId, techBlind, deps) {
  const moving = new Set(moves.map((m) => String(m.id)));
  let mask = 0;
  for (const row of fresh.dayContext.allRows) {
    if (moving.has(String(row.id)) || !row.window_start) continue;
    const own = row.technician_id != null && String(row.technician_id) === String(techId);
    if (!own && row.technician_id != null && !techBlind) continue;
    for (const hour of deps.rowHours(row)) mask |= 1 << hour;
  }
  return mask;
}

async function rollBack(conn, deps, done, dateStr) {
  for (const step of [...done].reverse()) {
    await moveVisit(conn, deps, { id: step.id, dateStr, fromStart: step.toStart, toStart: step.fromStart, widthMin: step.widthMin, recheck: false });
  }
}

async function raiseFailedDayAlert(deps, { dateStr, techId, planId }) {
  try {
    const { shortDateET } = require('../admin-alert-names');
    await deps.raiseAlert('schedule_conflict', {
      area: 'Schedule',
      action: 'check a re-planned day that did not restore',
      why: `The ${shortDateET(`${dateStr}T12:00:00Z`)} day stopped part way and could not be put back to its old times.`,
      severity: 'needs-you',
      link: `/admin/dispatch?tab=schedule&date=${dateStr}`,
      subject: { type: 'check', id: `day-replan-${dateStr}-${techId}` },
      doneWhen: 'day_times_checked',
      who: 'claude',
    }, {
      // bell: true only so the row is written; feed 'activity' keeps it off the owner's bell list (apply.js does the same).
      bell: true,
      dedupeKey: `day-replan-failed:${dateStr}:${techId}`,
      metadata: { day: dateStr, technicianId: techId, planId, feed: 'activity' },
    });
  } catch (err) {
    logger.error(`[day-replan] could not raise the failed-day notice for ${dateStr}: ${err.message}`);
  }
}

/** Why the fresh plan no longer matches the accepted one, or null: it must accept the same changes on the same rows. */
function staleReason(plan, fresh) {
  if (!fresh || fresh.skip || !fresh.verdict.accepted || fresh.hash !== plan.hash) return 'changed_since_plan';
  return changesKey(fresh.result.changes) === changesKey(plan.result.changes) ? null : 'changed_since_plan';
}

/** Read-only first pass over EVERY visit, so a refusal leaves nothing partly moved; each is checked again inside its own write. */
async function preflight(conn, deps, moves, dateStr) {
  for (const move of moves) {
    try {
      await recheckVisit(conn, deps, { id: move.id, dateStr, toStart: move.toStart });
    } catch (err) {
      return err.why ? `visit_not_movable:${err.why}` : 'changed_since_plan';
    }
  }
  return null;
}

/** Writes the steps in order; throws the failing step's error with `done` holding every step that landed. */
async function runSteps(conn, deps, { steps, moves, dateStr, done }) {
  const widthOf = new Map(moves.map((m) => [m.id, m.widthMin]));
  const where = new Map(moves.map((m) => [m.id, m.fromStart]));
  for (const step of steps) {
    const fromStart = where.get(step.id);
    const record = { id: step.id, fromStart, toStart: step.toStart, widthMin: widthOf.get(step.id) };
    try {
      await moveVisit(conn, deps, { dateStr, recheck: true, ...record });
    } catch (err) {
      // A step that committed and then failed (a customer text reported) is undone with the ones before it.
      if (err.committed) done.push(record);
      throw err;
    }
    done.push(record);
    where.set(step.id, step.toStart);
  }
}

/**
 * @param {{ conn, env: {techBlind: boolean, openMin: number, closeMin: number}, dateStr: string, techId: string,
 *           plan: object, replan: () => Promise<object|null>, planId: string, deps: object }} input
 * @returns {Promise<{ status: 'applied'|'skipped'|'rolled_back'|'failed', reason: string, moved: number }>}
 */
async function applyAcceptedDay({ conn, env, dateStr, techId, plan, replan, planId, deps }) {
  const skipped = (reason) => ({ status: 'skipped', reason, moved: 0 });
  let fresh;
  try {
    fresh = await replan();
  } catch (err) {
    logger.warn(`[day-replan] ${dateStr} tech ${techId}: could not re-read the day (${err.message})`);
    return skipped('changed_since_plan');
  }
  const stale = staleReason(plan, fresh);
  if (stale) return skipped(stale);

  const moves = movesFrom(fresh);
  if (!moves) return skipped('changed_since_plan');
  if (moves.length === 0) return skipped('no_hour_changes');
  const steps = sequenceMoves({
    moves,
    heldMask: heldMaskFor(fresh, moves, techId, env.techBlind, deps),
    options: { openMin: env.openMin, closeMin: env.closeMin, blocks: fresh.blocks },
  });
  if (!steps) return skipped('no_safe_sequence');
  const refused = await preflight(conn, deps, moves, dateStr);
  if (refused) return skipped(refused);

  const done = [];
  try {
    await runSteps(conn, deps, { steps, moves, dateStr, done });
  } catch (err) {
    logger.warn(`[day-replan] ${dateStr} tech ${techId}: step failed (${err.code || err.message}); rolling the day back`);
    try {
      await rollBack(conn, deps, done, dateStr);
      return { status: 'rolled_back', reason: `step_failed:${String(err.code || 'error').slice(0, 40)}`, moved: 0 };
    } catch (rollbackErr) {
      logger.error(`[day-replan] ${dateStr} tech ${techId}: rollback failed (${rollbackErr.message})`);
      await raiseFailedDayAlert(deps, { dateStr, techId, planId });
      return { status: 'failed', reason: `rollback_failed:${String(rollbackErr.code || 'error').slice(0, 40)}`, moved: done.length };
    }
  }
  return { status: 'applied', reason: 'applied', moved: moves.length };
}

module.exports = { applyAcceptedDay, INITIATOR, REASON_CODE, _internals: { changesKey, recheckVisit, moveVisit, movesFrom, heldMaskFor, hoursMask } };
