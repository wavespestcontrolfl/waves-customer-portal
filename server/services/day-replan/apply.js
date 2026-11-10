/**
 * Day re-plan APPLY writer (owner ruling 2026-11-03, PR 2 of 3). Runs only in apply mode (GATE_DAY_REPLAN=true,
 * the owner's flip), for a tech-day whose plan the planner AND the app's own simulator accepted, inside the 04:40
 * job's `auto-dispatch-recurring` writer lock. Shadow and off never write.
 *
 * The owner's rule: any visit may get a new hour, the lock is 24 hours, and NO text goes out about the move: the
 * 24-hour reminder carries the new time (the same silent reminder sync the night auto-dispatch writer runs).
 *
 * ONE TRANSACTION PER TECH-DAY. Seven audit rounds came from re-timing a day as many single-visit rebooker moves
 * (temporary hours, a journal, recovery, undo fences, the rebooker's own side effects). The day is now written the
 * way the app's occupancy writers write: under their fence, in one transaction, all or nothing.
 *
 *   1. Before the transaction: the tech-day is read again and re-planned; it is written only if the fresh plan makes
 *      exactly the same changes on the same rows ('changed_since_plan' otherwise), the final route reads as a real
 *      plan to the app (`staleOrderReasons`) and simulates to the planned figures ('route_order_not_coherent'), and
 *      the date is not a blackout day (the rebooker's strict night-writer test).
 *   2. Inside the transaction, the scheduling fence in the ORDERING CONTRACT's order (scheduling/occupancy.js): the
 *      date-wide occupancy lock (rung 1), then the tech-day locks (rung 3: this technician and the unassigned day, as
 *      the rebooker takes them), then every live row of the date FOR UPDATE, in id order.
 *   3. Under the locks the day is read again and must equal what was validated: the version hash of every live row of
 *      the date (so other technicians' and unassigned rows too), the full signature of every stop of the technician
 *      (id, date, hours, estimated duration, technician, status, staff locks, visit record, location, hold,
 *      confirmation and last update), and the technician's schedule blocks. Every moved visit must still be movable
 *      (24.25 hours, the 24-hour reminder not sent, staff locks, grouped, same customer, status), now and at its new
 *      hour. Any difference writes nothing.
 *   4. The writes, in that one transaction: every moved visit's window_start and window_end (a visit with NO booked
 *      end keeps a NULL end; it holds its estimated duration, else 60 minutes, for occupancy), track_token_expires_at
 *      and updated_at, one reschedule_log row per moved visit (the rebooker's same-day columns, reason_code and
 *      initiated_by 'day_replan'), and the technician's route_order, in the accepted order, read back.
 *   5. Still before commit, the FINAL state must pass the app's occupancy predicate (occupancy.js
 *      findConflictingVisits: window overlap with COALESCE(window_end, start + COALESCE(NULLIF(estimate, 0), 60)),
 *      live holds block, unassigned rows block, tech-blind unless GATE_MULTI_TECH_CONFIRM) for every moved visit,
 *      against every other row including the other moved visits at their new hours; a hit writes nothing.
 *
 * After the commit, for each moved visit and each best-effort (a failure is logged and repaired by the next run's
 * reconcile of recent applied plans): the silent reminder sync (auto-dispatch/apply.js syncMovedReminders), the
 * self-booking snapshot, the visit-group seam, the legacy outbound-review activation, the escalation count and one
 * schedule-quality refresh for the date. No temporary hour is ever written, so nothing is journaled, rolled back or
 * recovered. The `apply_started_at` / `apply_steps` columns (migration 20261104180000) are no longer written.
 *
 * Every move carries the initiator 'day_replan', which is automatic (eligibility.js) and is NOT the
 * 'auto_dispatch' signature that move-limit.js counts, so the night pass's own 2-move cap is untouched.
 */
const logger = require('../logger');
const crypto = require('crypto');
const { toDateStr } = require('../auto-dispatch/dates');
const { parseETDateTime } = require('../../utils/datetime-et');
const { staleOrderReasons } = require('../route-reorder-window-fit');
const { withHour, appSimCheck } = require('./app-sim');
const { DEFAULT_OPTIONS } = require('./planner');

const INITIATOR = 'day_replan';
const REASON_CODE = 'day_replan';
const PLAN_TABLE = 'day_replan_plans';
const RAW_LOCATION = { lat: 'raw_lat', lng: 'raw_lng' };

const minToHhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const norm5 = (value) => (value ? String(value).slice(0, 5) : null);
const toMinutes = (value) => {
  const [h, m] = String(value).slice(0, 5).split(':').map(Number);
  return h * 60 + m;
};

function coded(code, message) {
  return Object.assign(new Error(message), { code });
}

/** The accepted plan's changes as one comparable string. */
function changesKey(changes) {
  return JSON.stringify([...changes].map((c) => [String(c.id), c.fromMin, c.toMin]).sort((a, b) => a[0].localeCompare(b[0])));
}


// ---- what a stop reads as ---------------------------------------------------------------------------------------

const pinned = (row, field) => (RAW_LOCATION[field] && row[RAW_LOCATION[field]] !== undefined ? row[RAW_LOCATION[field]] : row[field]) ?? null;

const time8 = (value) => {
  if (value == null) return null;
  const text = String(value);
  return text.length === 5 ? `${text}:00` : text.slice(0, 8);
};


/**
 * What this writer pins on a visit, as a short hash (ids and minutes never leave the row as text): date, window,
 * estimated duration, technician, status, staff locks, visit record and the stored location.
 */
function fingerprintOf(row, deps) {
  const parts = [
    toDateStr(row.scheduled_date), time8(row.window_start), time8(row.window_end), row.technician_id == null ? null : String(row.technician_id),
    row.status, row.auto_dispatch_locked === true, row.auto_dispatch_excluded === true, row.visit_id == null ? null : String(row.visit_id),
    // The duration the route was simulated with: a staff edit of it after the plan must refuse the write.
    row.estimated_duration_minutes == null ? null : Number(row.estimated_duration_minutes),
    ...deps.locationFields.map((field) => {
      const value = pinned(row, field);
      return value == null ? null : String(value);
    }),
  ];
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
}

/** The whole signature of a stop of the technician's day: the fingerprint plus hold, confirmation and last update. */
function stopSignature(row, deps) {
  const stamp = (value) => (value == null ? null : new Date(value).getTime());
  return JSON.stringify([
    String(row.id), fingerprintOf(row, deps), row.reservation_expires_at ? 1 : 0, row.customer_confirmed === true, stamp(row.updated_at),
  ]);
}

// ---- the plan, before the transaction ---------------------------------------------------------------------------

/** Why the fresh plan no longer matches the accepted one, or null: it must accept the same changes on the same rows. */
function staleReason(plan, fresh) {
  if (!fresh || fresh.skip || !fresh.verdict.accepted || fresh.hash !== plan.hash) return 'changed_since_plan';
  return changesKey(fresh.result.changes) === changesKey(plan.result.changes) ? null : 'changed_since_plan';
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
      id: stop.id, fromStart: change.fromMin, toStart: change.toMin, widthMin: stop.slotWidthMin, openEnd: stop.openEnd === true, workMin: stop.workMin, pref: stop.pref || null,
    });
  }
  return moves;
}

/**
 * The route the plan will leave: the new hours in the accepted order, expanded to rows. Null when the app would not
 * read it as a real plan, or when the app's simulator does not give the planned figures for it.
 */
function finalRoute(fresh, env, techId) {
  const best = fresh.result.best;
  const toStart = new Map(fresh.result.changes.map((c) => [String(c.id), c.toMin]));
  const groupOf = new Map(fresh.rowGroups.map((g) => [String(g[0].id), g]));
  const finalGroups = fresh.rowGroups.map((g) => g.map((r) => (toStart.has(String(r.id)) ? withHour(r, toStart.get(String(r.id))) : r)));
  const ordered = best.order.flatMap((id) => groupOf.get(String(id)) || []);
  const numbered = ordered.map((r, i) => ({ ...r, route_order: i + 1, window_start: (toStart.has(String(r.id)) ? withHour(r, toStart.get(String(r.id))) : r).window_start }));
  if (staleOrderReasons(numbered, numbered, { futureDay: true }).length > 0) return null;
  const sim = appSimCheck({
    groups: finalGroups, baselineOrder: best.order, best: null, origin: fresh.origin, departureMin: env.departureMin, marginMin: DEFAULT_OPTIONS.marginMin,
  });
  const planned = fresh.check.planned;
  if (!sim.current || !planned || sim.current.driveMin !== planned.driveMin || sim.current.endMin !== planned.endMin) return null;
  const finalStarts = new Map(ordered.map((r) => [String(r.id), toStart.has(String(r.id)) ? toStart.get(String(r.id)) : toMinutes(r.window_start)]));
  return { order: ordered.map((r) => r.id), finalStarts, techId };
}


// ---- inside the transaction -------------------------------------------------------------------------------------

// GATE_NIGHT_TOLD_LOCK (owner 2026-11-05, "D1 a"): the columns the told-lock reasons read inside the move transaction,
// the same facts loadDayContext gives the planner (day-replan/index.js TOLD_LOCK_SELECT + the reason's own fields).
const TOLD_ROW_COLUMNS = [
  'customer_confirmed', 'is_recurring', 'recurring_parent_id', 'scheduled_date', 'recurring_dispatch_due_date',
  'date_exception', 'date_exception_source', 'date_exception_at',
];

/**
 * The told-lock facts for one visit, read inside its move transaction, so a time told to the customer or a person
 * placement made after the fresh plan still stops the write. The told read is the no-show detector's promise reader (a
 * 72-hour flag with no real promise does not stop the write); a read that throws stops the write (fail closed).
 * isPersonPlacedVisit fails closed too (an unreadable history = placed).
 */
async function toldLockFacts(trx, deps, { row, id, dateStr }) {
  const dayOnly = typeof deps.dayOnlyOn === 'function' && deps.dayOnlyOn() === true;
  const levels = dayOnly ? await promiseLevelFacts(trx, deps, id) : { told: new Set(await deps.loadToldIds(trx, [id], deps.now())) };
  const verdict = await deps.isPersonPlacedVisit({ ...row, scheduled_date: dateStr }, trx);
  return { toldLock: true, ...levels, personPlaced: new Set(!verdict || verdict.placed !== false ? [id] : []) };
}

/**
 * GATE_DAY_ONLY_PROMISE: the visit's promise level, re-read inside its move transaction. 'hour' = told, 'day' = dayTold.
 * A read that throws fails CLOSED: the visit counts as told an hour, so the write stops (time_told).
 */
async function promiseLevelFacts(trx, deps, id) {
  let level = 'hour';
  try {
    const levels = await deps.loadPromiseLevels(trx, [id], deps.now());
    level = levels.get(id) || levels.get(String(id)) || 'none';
  } catch (_) {
    level = 'hour';
  }
  return { told: new Set(level === 'hour' ? [id] : []), dayTold: new Set(level === 'day' ? [id] : []) };
}

/**
 * The visit, read inside its own move transaction, must still be movable under the rules the planner used.
 * `toStart` is checked as well as the current start: a visit may not be moved INTO the 24-hour reach either.
 */
async function recheckVisit(trx, deps, { id, dateStr, toStart }) {
  const toldLock = typeof deps.toldLockOn === 'function' && deps.toldLockOn() === true;
  const row = await trx('scheduled_services').where({ id }).first(
    'id', 'status', 'window_start', 'customer_id', 'property_id', 'visit_id', 'reservation_expires_at', 'auto_dispatch_locked', 'auto_dispatch_excluded',
    ...(toldLock ? TOLD_ROW_COLUMNS : []),
  );
  if (!row) throw coded('NOT_MOVABLE', 'the visit no longer exists');
  const live = (q) => q.whereNotIn('status', deps.excludedStatuses);
  const mate = row.visit_id != null
    ? await live(trx('scheduled_services').where({ visit_id: row.visit_id }).whereNot({ id })).first('id') : null;
  const sameCustomer = row.customer_id != null
    ? await live(trx('scheduled_services').where({ customer_id: row.customer_id, scheduled_date: dateStr }).whereNot({ id }))
      .whereRaw('(reservation_expires_at IS NULL OR reservation_expires_at > NOW())').first('id') : null;
  const reminder = await trx('appointment_reminders').where({ scheduled_service_id: id })
    .first('reminder_24h_sent');
  const ctx = {
    dateStr,
    now: deps.now(),
    visitCounts: new Map(row.visit_id != null ? [[row.visit_id, mate ? 2 : 1]] : []),
    customerCounts: new Map(row.customer_id != null ? [[row.customer_id, sameCustomer ? 2 : 1]] : []),
    sent24: new Set(reminder && reminder.reminder_24h_sent === true ? [id] : []),
    // Whether the 24-hour reminder will still go out (it carries the new hour), read with the transaction; fails closed.
    ...(typeof deps.loadReminder24hOffIds === 'function' ? { reminder24hOff: await deps.loadReminder24hOffIds(trx, [row]) } : {}),
    ...(toldLock ? await toldLockFacts(trx, deps, { row, id, dateStr }) : {}),
  };
  const why = deps.fixedReason(row, ctx) || deps.fixedReason({ ...row, window_start: minToHhmm(toStart) }, ctx);
  if (why) throw Object.assign(coded('NOT_MOVABLE', `the visit is no longer movable: ${why}`), { why });
}

const sortedBlocks = (blocks) => JSON.stringify((blocks || []).map((b) => [b.startMin, b.endMin]).sort((a, b) => a[0] - b[0] || a[1] - b[1]));

/** The day under the locks must be exactly the day that was validated: every live row of the date, the technician's stops, the blocks. */
async function verifyLockedDay(trx, deps, { dateStr, techId, fresh, route }) {
  const rows = await deps.loadDayRows(trx, dateStr);
  if (deps.versionHash(rows) !== fresh.hash) throw coded('CHANGED_SINCE_PLAN', 'a row of the date changed since the plan');
  const now = new Map(rows.map((r) => [String(r.id), r]));
  const want = new Set(route.order.map(String));
  for (const before of fresh.dayContext.allRows.filter((r) => want.has(String(r.id)))) {
    const current = now.get(String(before.id));
    if (!current || stopSignature(current, deps) !== stopSignature(before, deps)) throw coded('CHANGED_SINCE_PLAN', `stop ${before.id} changed since the plan`);
  }
  if (sortedBlocks(await deps.loadBlocks(trx, dateStr, techId)) !== sortedBlocks(fresh.blocks)) throw coded('CHANGED_SINCE_PLAN', 'the schedule blocks changed since the plan');
}

const WRITE_COLUMNS = ['id', 'customer_id', 'visit_id', 'scheduled_date', 'window_start', 'window_end', 'status', 'technician_id', 'service_type', 'service_id', 'property_id'];

/**
 * Writes every moved visit and its reschedule_log row. The columns are the rebooker's for a same-day, same-technician
 * window change by a night writer; the CAS is the row as it was read under the locks.
 */
async function writeMoves(trx, deps, { dateStr, moves }) {
  const rows = await trx('scheduled_services').whereIn('id', moves.map((m) => m.id)).select(...WRITE_COLUMNS);
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const written = [];
  for (const move of moves) {
    const row = byId.get(String(move.id));
    if (!row) throw coded('CHANGED_SINCE_PLAN', `visit ${move.id} no longer exists`);
    const start = minToHhmm(move.toStart);
    const end = move.openEnd ? null : minToHhmm(move.toStart + move.widthMin);
    const count = await trx('scheduled_services')
      .where({
        id: move.id, scheduled_date: dateStr, status: row.status, technician_id: row.technician_id ?? null,
        window_start: row.window_start, window_end: row.window_end ?? null,
      })
      .update({
        window_start: start,
        window_end: end,
        track_token_expires_at: deps.trackTokenExpiry(trx, dateStr, end),
        updated_at: new Date(),
      });
    if (Number(count) !== 1) throw coded('CHANGED_SINCE_PLAN', `visit ${move.id} changed while it was being written`);
    await trx('reschedule_log').insert({
      scheduled_service_id: move.id,
      customer_id: row.customer_id ?? null,
      original_date: dateStr,
      new_date: dateStr,
      reason_code: REASON_CODE,
      initiated_by: INITIATOR,
      original_window: row.window_start ? `${row.window_start}${row.window_end ? `-${row.window_end}` : ''}` : null,
      new_window: end ? `${start}-${end}` : start,
      occurrence_service_type: row.service_type || null,
      occurrence_service_id: row.service_id || null,
      occurrence_property_id: row.property_id || null,
    });
    written.push({ id: move.id, customer_id: row.customer_id ?? null, visit_id: row.visit_id ?? null, start, end: end || minToHhmm(move.toStart + move.widthMin) });
  }
  return written;
}

/** The final state, in this transaction, must pass the app's occupancy predicate for every moved visit (the others at their new hours too). */
async function assertNoClash(trx, deps, { dateStr, techId, written }) {
  for (const w of written) {
    const clashes = await deps.findConflicts({
      db: trx, date: dateStr, windowStart: w.start, windowEnd: w.end, excludeServiceIds: [w.id], technicianId: techId, excludeStatuses: deps.occupancyExcludeStatuses,
    });
    if (clashes.length > 0) throw coded('SLOT_TAKEN', `visit ${w.id} would overlap another visit`);
  }
}

/** Writes route_order = position for the technician's live stops, in the accepted order, and reads the numbers back. */
async function writeRouteOrder(trx, deps, { dateStr, techId, order, finalStarts }) {
  const rows = await trx('scheduled_services')
    .where({ scheduled_date: dateStr, technician_id: techId })
    .whereNotIn('status', deps.excludedStatuses)
    .whereRaw('(reservation_expires_at IS NULL OR reservation_expires_at > NOW())')
    .select('id', 'window_start');
  const want = new Set(order.map(String));
  if (rows.length !== want.size || rows.some((r) => !want.has(String(r.id)))) throw coded('ROUTE_CHANGED', 'the technician\'s stops are not the planned ones');
  for (const r of rows) {
    if (norm5(r.window_start) !== minToHhmm(finalStarts.get(String(r.id)))) throw coded('ROUTE_CHANGED', 'a stop is not on its planned hour');
  }
  for (const [i, id] of order.entries()) {
    await trx('scheduled_services').where({ id }).whereRaw('route_order IS DISTINCT FROM ?', [i + 1]).update({ route_order: i + 1 });
  }
  const back = await trx('scheduled_services').whereIn('id', order).select('id', 'route_order');
  const numberOf = new Map(back.map((r) => [String(r.id), Number(r.route_order)]));
  if (order.some((id, i) => numberOf.get(String(id)) !== i + 1)) throw coded('ROUTE_ORDER_MISMATCH', 'the route order did not read back as planned');
}

/** The whole day, all or nothing. Returns the written visits. */
async function writeDay(trx, deps, { dateStr, techId, fresh, moves, route, planId = null }) {
  // The ORDERING CONTRACT (scheduling/occupancy.js): rung 1 (the date), rung 3 (the technician's day and the unassigned day), then row locks.
  await deps.acquireOccupancyLock(trx, dateStr);
  await deps.lockTechDays(trx, [{ techId, date: dateStr }, { techId: null, date: dateStr }]);
  await deps.lockDayRows(trx, dateStr);
  await verifyLockedDay(trx, deps, { dateStr, techId, fresh, route });
  for (const move of moves) await recheckVisit(trx, deps, { id: move.id, dateStr, toStart: move.toStart });
  const written = await writeMoves(trx, deps, { dateStr, moves });
  await assertNoClash(trx, deps, { dateStr, techId, written });
  await writeRouteOrder(trx, deps, { dateStr, techId, order: route.order, finalStarts: route.finalStarts });
  // The applied marker commits WITH the hours, before any post-commit effect: a crash right after the commit still
  // leaves an applied plan that reconcileApplied repairs (self-booking snapshot, visit record, reminders).
  if (planId) {
    await trx(PLAN_TABLE).where({ id: planId }).update({ apply_status: 'applied', apply_reason: 'applied', applied_at: trx.fn.now() });
  }
  return written;
}

// ---- after the commit -------------------------------------------------------------------------------------------

/** Each effect on its own and best-effort: the day is committed, so a failed sync must not read as a failed day. */
async function afterCommit(conn, deps, { dateStr, written }) {
  for (const w of written) {
    try {
      await deps.syncMovedReminders({ id: w.id, customer_id: w.customer_id }, { date: dateStr, start_time: w.start, end_time: w.end }, {}, []);
    } catch (err) {
      logger.warn(`[day-replan] reminder sync failed for visit ${w.id} (the day is committed): ${err.message}`);
    }
  }
  try {
    await deps.afterMoveEffects(conn, { dateStr, written });
  } catch (err) {
    logger.warn(`[day-replan] after-move effects failed for ${dateStr} (the day is committed): ${err.message}`);
  }
}

const SKIP_REASONS = {
  CHANGED_SINCE_PLAN: 'changed_since_plan',
  SLOT_TAKEN: 'slot_taken',
  ROUTE_CHANGED: 'route_changed',
  ROUTE_ORDER_MISMATCH: 'route_changed',
};

/**
 * @param {{ conn, env: {techBlind: boolean, openMin: number, closeMin: number, departureMin: number}, dateStr: string,
 *           techId: string, plan: object, replan: () => Promise<object|null>, deps: object }} input
 * @returns {Promise<{ status: 'applied'|'skipped'|'failed', reason: string, moved: number }>}
 */
async function applyAcceptedDay({ conn, env, dateStr, techId, plan, planId = null, replan, deps }) {
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
  const route = finalRoute(fresh, env, techId);
  if (!route) return skipped('route_order_not_coherent');
  // The rebooker's strict night-writer test for a day the company is closed.
  if (await deps.isBlackoutDate(dateStr)) return skipped('blackout_date');

  let written;
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        written = await conn.transaction((trx) => writeDay(trx, deps, { dateStr, techId, fresh, moves, route, planId }));
        break;
      } catch (err) {
        // A deadlock victim committed nothing: try again (as the rebooker does), twice at most.
        if (err && err.code === '40P01' && attempt < 2) continue;
        throw err;
      }
    }
  } catch (err) {
    if (err.code === 'NOT_MOVABLE') return skipped(err.why ? `visit_not_movable:${err.why}` : 'visit_not_movable');
    if (SKIP_REASONS[err.code]) return skipped(SKIP_REASONS[err.code]);
    logger.error(`[day-replan] ${dateStr} tech ${techId}: the write failed and nothing changed (${err.code || err.message})`);
    return { status: 'failed', reason: `write_failed:${String(err.code || 'error').slice(0, 40)}`, moved: 0 };
  }
  await afterCommit(conn, deps, { dateStr, written });
  return { status: 'applied', reason: 'applied', moved: written.length };
}

// ---- repair of a committed day ----------------------------------------------------------------------------------

/**
 * Re-syncs the reminder of every visit whose hour is not the one its reminder names (an undo that committed and then
 * stopped before its sync). Final hours only: a visit left on a temporary hour (stuck) is never synced to it. Goes
 * through the night writer's own syncMovedReminders; best effort, like that sync.
 */
async function reconcileReminders(conn, deps, { ids, skip = new Set() }) {
  for (const id of new Set(ids)) {
    if (skip.has(id)) continue;
    try {
      const row = await conn('scheduled_services').where({ id }).first('customer_id', 'scheduled_date', 'window_start', 'window_end');
      const reminder = row ? await conn('appointment_reminders').where({ scheduled_service_id: id }).first('appointment_time', 'cancelled') : null;
      if (!row || !reminder || reminder.cancelled === true || !row.window_start) continue;
      const date = toDateStr(row.scheduled_date);
      const start = norm5(row.window_start);
      if (new Date(reminder.appointment_time).getTime() === parseETDateTime(`${date}T${start}`).getTime()) continue;
      await deps.syncMovedReminders(
        { id, customer_id: row.customer_id }, { date, start_time: start, end_time: norm5(row.window_end) || start }, {}, [],
      );
    } catch (err) {
      logger.warn(`[day-replan] could not reconcile the reminder of visit ${id} (${err.message})`);
    }
  }
}

/**
 * Applied plans of today or later: their moved visits' reminders, snapshots and visit records are made to match the
 * visits again (a sync that failed after the commit, or that the process never reached). Idempotent; never throws.
 */
async function reconcileApplied(conn, depsOrGetter, { today }) {
  try {
    const plans = await conn(PLAN_TABLE).where({ apply_status: 'applied' }).whereNotNull('applied_at').select('id', 'service_date', 'changes');
    const ids = [];
    for (const plan of plans.filter((p) => toDateStr(p.service_date) >= today)) {
      const changes = typeof plan.changes === 'string' ? JSON.parse(plan.changes) : (plan.changes || []);
      ids.push(...changes.map((c) => c.id));
    }
    if (ids.length === 0) return 0;
    const deps = typeof depsOrGetter === 'function' ? depsOrGetter() : depsOrGetter;
    await reconcileReminders(conn, deps, { ids });
    for (const id of new Set(ids)) {
      try {
        await deps.repairMoved(conn, id);
      } catch (err) {
        logger.warn(`[day-replan] could not repair the records of visit ${id} (${err.message})`);
      }
    }
    return ids.length;
  } catch (err) {
    logger.warn(`[day-replan] could not reconcile applied plans (${err.message})`);
    return 0;
  }
}

module.exports = {
  applyAcceptedDay, reconcileApplied, INITIATOR, REASON_CODE,
  _internals: { changesKey, recheckVisit, movesFrom, finalRoute, fingerprintOf, stopSignature, reconcileReminders, writeMoves, writeRouteOrder, assertNoClash },
};
