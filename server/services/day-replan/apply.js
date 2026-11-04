/**
 * Day re-plan APPLY writer (owner ruling 2026-11-03, PR 2 of 3). Runs only in apply mode (GATE_DAY_REPLAN=true,
 * the owner's flip), for a tech-day whose plan the planner AND the app's own simulator accepted, inside the 04:40
 * job's `auto-dispatch-recurring` writer lock. Shadow and off never write a plan (a shadow run only recovers an
 * interrupted apply, below).
 *
 * The owner's rule: any visit may get a new hour, the lock is 24 hours, and NO text goes out about the move: the
 * 24-hour reminder carries the new time (the same silent reminder sync the night auto-dispatch writer runs).
 *
 * Before the first write (all of it, so a refusal leaves nothing partly moved):
 *   1. the tech-day is read again and re-planned; it is written only if the fresh plan makes exactly the same
 *      changes AND the version hash of every row of the date is unchanged ('changed_since_plan' otherwise). That
 *      fresh read is the VALIDATED SNAPSHOT: every step's CAS is pinned on it, and moves forward only by this
 *      writer's own committed steps, so a technician, location, window or other edit made since is rejected;
 *   2. every visit is checked read-only with the planner's movable rules (and again inside its own move);
 *   3. the moves are put in an order in which each visit's new hours are free at its step (./sequence.js), with a
 *      temporary hour to break a swap or a cycle; no such order = 'no_safe_sequence';
 *   4. the final route (the new hours in the accepted order) must read as a real plan to the app (no stale-order
 *      reason) and simulate to the planned figures, else 'route_order_not_coherent'.
 *
 * Each step is its own rebooker transaction (SmartRebooker.reschedule cannot join a caller's: it owns its
 * transaction and its post-commit work), so the day is made recoverable instead of atomic: the plan row's
 * `apply_started_at` and `apply_steps` journal record each step (intent before, done after) and every route_order
 * the day had. A failed step rolls the day back at once; a process that stops part way is found by the next run
 * (recoverInterrupted), which reads where each visit actually is and puts it back, then raises one notice for
 * Claude. A temporary hour is therefore never left in place.
 *
 * After the hours, the accepted route order is written under the scheduling fence (occupancy lock, tech-day lock,
 * rows locked, the set and the hours verified) and read back. The reminder of a visit is synced only when the
 * visit lands its FINAL hour (never for a temporary one), through auto-dispatch/apply.js's own syncMovedReminders.
 *
 * The writes carry the initiator 'day_replan', which is automatic (eligibility.js) and is NOT the
 * 'auto_dispatch' signature that move-limit.js counts, so the night pass's own 2-move cap is untouched.
 */
const logger = require('../logger');
const { toDateStr } = require('../auto-dispatch/dates');
const { staleOrderReasons } = require('../route-reorder-window-fit');
const { sequenceMoves, hoursMask } = require('./sequence');
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
  return Object.assign(new Error(message || code), { code });
}

/** The accepted plan's changes as one comparable string. */
function changesKey(changes) {
  return JSON.stringify([...changes].map((c) => [String(c.id), c.fromMin, c.toMin]).sort((a, b) => a[0].localeCompare(b[0])));
}

// ---- the journal ------------------------------------------------------------------------------------------------

async function writeJournal(conn, planId, journal, { start = false } = {}) {
  const patch = { apply_steps: JSON.stringify(journal), ...(start ? { apply_started_at: conn.fn.now() } : {}) };
  const count = await conn(PLAN_TABLE).where({ id: planId }).update(patch);
  // A journal nobody can read back protects nothing: refuse to write a day without one.
  if (Number(count) !== 1) throw coded('JOURNAL_UNWRITABLE', 'the plan row could not be updated');
}

function parseJournal(raw) {
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return value && Array.isArray(value.steps) ? value : { steps: [], routeBefore: {} };
}

// ---- one visit's move -------------------------------------------------------------------------------------------

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

const READ_COLUMNS = [
  'customer_id', 'scheduled_date', 'window_start', 'window_end', 'technician_id', 'status',
  'auto_dispatch_locked', 'auto_dispatch_excluded', 'visit_id', 'recurring_dispatch_due_date', 'customer_confirmed',
];

/** The row the CAS is pinned on: the validated snapshot when there is one, else a fresh read (a rollback or recovery). */
async function pinRow(conn, deps, { id, snapshot }) {
  if (snapshot) return snapshot;
  const row = await conn('scheduled_services').where({ id }).first(...READ_COLUMNS, ...deps.locationFields);
  if (!row) throw coded('CHANGED_SINCE_PLAN', 'the visit no longer exists');
  return row;
}

const pinned = (row, field) => (RAW_LOCATION[field] && row[RAW_LOCATION[field]] !== undefined ? row[RAW_LOCATION[field]] : row[field]) ?? null;

/**
 * One write: the same path auto-dispatch/apply.js takes for a single occurrence, pinned on `snapshot`.
 * `recheck` is false for a rollback step, which must be able to put a visit back even after the 24-hour reach has
 * moved in. `syncReminder` is false for a temporary hour. A committed step advances the snapshot (and only that).
 */
async function moveVisit(conn, deps, { id, dateStr, fromStart, toStart, widthMin, recheck, syncReminder = true, snapshot = null }) {
  const row = await pinRow(conn, deps, { id, snapshot });
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
      // Null for an ungrouped visit (one grouped meanwhile misses the CAS), or the visit record of a visit that is alone
      // in it (a grouped one never gets here: the recheck refuses it).
      visit_id: row.visit_id ?? null,
      ...Object.fromEntries(['recurring_dispatch_due_date', 'customer_confirmed', ...deps.locationFields].map((field) => [field, pinned(row, field)])),
    },
    ...(recheck ? { beforeMove: (trx) => recheckVisit(trx, deps, { id, dateStr, toStart }) } : {}),
  };
  const result = (await deps.rebooker.reschedule(id, dateStr, { start: best.start_time, end: best.end_time }, REASON_CODE, INITIATOR, options)) || {};
  // From here the move is committed: the snapshot follows it, and a failure below is still rolled back with the rest.
  if (snapshot) Object.assign(snapshot, { window_start: `${best.start_time}:00`, window_end: `${best.end_time}:00` });
  try {
    // A customer text here would break the owner's rule, so stop and put the day back.
    if (result.smsSent === true) throw coded('CUSTOMER_TEXT_SENT', `visit ${id}: the rebooker reported a customer text`);
    // The 24-hour reminder carries the new time: the same silent sync apply.js runs (best-effort, with its own notice).
    if (syncReminder) await deps.syncMovedReminders({ id, customer_id: row.customer_id }, best, result, []);
  } catch (err) {
    throw Object.assign(err, { committed: true });
  }
}

// ---- the accepted route order -----------------------------------------------------------------------------------

/**
 * Writes route_order = position for the tech-day's live stops, in the accepted order, under the scheduling fence
 * (date occupancy lock, then the tech-day lock; the rows locked), after checking that the stops and their hours are
 * what the plan expects; then reads the numbers back. Throws when any of that does not hold.
 */
async function persistRouteOrder(conn, deps, { dateStr, techId, order, finalStarts }) {
  await conn.transaction(async (trx) => {
    await deps.acquireOccupancyLock(trx, dateStr);
    await deps.lockTechDays(trx, [{ techId, date: dateStr }]);
    const rows = await trx('scheduled_services')
      .where({ scheduled_date: dateStr, technician_id: techId })
      .whereNotIn('status', deps.excludedStatuses)
      .whereRaw('(reservation_expires_at IS NULL OR reservation_expires_at > NOW())')
      .forUpdate()
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
  });
}

/** Puts the day's route_order values back as the journal recorded them (rows that still exist, under the same fence). */
async function restoreRouteOrder(conn, deps, { dateStr, techId, routeBefore }) {
  const ids = Object.keys(routeBefore || {});
  if (ids.length === 0) return;
  await conn.transaction(async (trx) => {
    await deps.acquireOccupancyLock(trx, dateStr);
    await deps.lockTechDays(trx, [{ techId, date: dateStr }]);
    for (const id of ids) {
      await trx('scheduled_services').where({ id }).whereRaw('route_order IS DISTINCT FROM ?', [routeBefore[id]]).update({ route_order: routeBefore[id] });
    }
  });
}

// ---- rolling back -----------------------------------------------------------------------------------------------

/**
 * Reverses the journal's steps, newest first, by where each visit actually is: at the step's new hour it moves back
 * to the old one; at the old hour the step never landed; anywhere else a person changed it and the rollback stops
 * (the caller records 'failed'). The same function serves a step that failed now and a plan found after a restart.
 */
async function rollBack(conn, deps, { dateStr, journal }) {
  for (const step of [...journal.steps].reverse()) {
    const row = await conn('scheduled_services').where({ id: step.id }).first('scheduled_date', 'window_start');
    const at = row && toDateStr(row.scheduled_date) === dateStr ? norm5(row.window_start) : null;
    if (at === minToHhmm(step.fromStart)) continue;
    if (at !== minToHhmm(step.toStart)) throw coded('DIVERGED', `visit ${step.id} is not where the journal expects it`);
    // Going back to a temporary hour is not a landing: its reminder is left alone, as it was on the way out.
    const backToTemp = journal.steps.some((s) => s.temp && s.id === step.id && s.toStart === step.fromStart);
    await moveVisit(conn, deps, {
      id: step.id, dateStr, fromStart: step.toStart, toStart: step.fromStart, widthMin: step.widthMin, recheck: false, syncReminder: !backToTemp,
    });
  }
}

async function raiseDayAlert(deps, { dateStr, techId, planId, restored }) {
  try {
    const { shortDateET } = require('../admin-alert-names');
    const day = shortDateET(`${dateStr}T12:00:00Z`);
    await deps.raiseAlert('schedule_conflict', {
      area: 'Schedule',
      action: restored ? 'check a re-planned day that was interrupted' : 'check a re-planned day that did not restore',
      why: restored
        ? `The ${day} day stopped part way, and its visits were put back to their old times.`
        : `The ${day} day stopped part way and could not be put back to its old times.`,
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
    logger.error(`[day-replan] could not raise the day notice for ${dateStr}: ${err.message}`);
  }
}

/** Rolls the day back; { status, reason } for the plan row. Raises the one notice when it could not. */
async function undoDay(conn, deps, { dateStr, techId, planId, journal, reasonPrefix }) {
  try {
    await rollBack(conn, deps, { dateStr, journal });
    await restoreRouteOrder(conn, deps, { dateStr, techId, routeBefore: journal.routeBefore });
    return { status: 'rolled_back', reason: reasonPrefix };
  } catch (err) {
    logger.error(`[day-replan] ${dateStr} tech ${techId}: rollback failed (${err.message})`);
    await raiseDayAlert(deps, { dateStr, techId, planId, restored: false });
    return { status: 'failed', reason: `rollback_failed:${String(err.code || 'error').slice(0, 40)}` };
  }
}

// ---- the plan, before the first write ---------------------------------------------------------------------------

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

/** Writes the steps in order, journaling each (intent before, done after); throws the failing step's error. */
async function runSteps(conn, deps, { steps, moves, dateStr, planId, journal, snapshots }) {
  const widthOf = new Map(moves.map((m) => [m.id, m.widthMin]));
  const where = new Map(moves.map((m) => [m.id, m.fromStart]));
  for (const step of steps) {
    const record = { id: step.id, fromStart: where.get(step.id), toStart: step.toStart, widthMin: widthOf.get(step.id), temp: step.temp, state: 'intent' };
    journal.steps.push(record);
    await writeJournal(conn, planId, journal);
    await moveVisit(conn, deps, {
      id: record.id, dateStr, fromStart: record.fromStart, toStart: record.toStart, widthMin: record.widthMin,
      recheck: true, syncReminder: !step.temp, snapshot: snapshots.get(String(step.id)),
    });
    record.state = 'done';
    await writeJournal(conn, planId, journal);
    where.set(step.id, step.toStart);
  }
}

/**
 * @param {{ conn, env: {techBlind: boolean, openMin: number, closeMin: number, departureMin: number}, dateStr: string,
 *           techId: string, plan: object, replan: () => Promise<object|null>, planId: string, deps: object }} input
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
  const route = finalRoute(fresh, env, techId);
  if (!route) return skipped('route_order_not_coherent');

  // The validated snapshot: the rows the fresh plan was made from, one object per visit, advanced only by our own steps.
  const snapshots = new Map(fresh.dayContext.allRows.filter((r) => moves.some((m) => String(m.id) === String(r.id))).map((r) => [String(r.id), { ...r }]));
  const journal = {
    version: 1,
    routeBefore: Object.fromEntries(fresh.dayContext.allRows.filter((r) => String(r.technician_id) === String(techId)).map((r) => [String(r.id), r.route_order ?? null])),
    steps: [],
    routePersisted: false,
    complete: false,
  };
  try {
    await writeJournal(conn, planId, journal, { start: true });
  } catch (err) {
    logger.error(`[day-replan] ${dateStr} tech ${techId}: could not open the journal (${err.message})`);
    return skipped('journal_unwritable');
  }

  try {
    await runSteps(conn, deps, { steps, moves, dateStr, planId, journal, snapshots });
    await persistRouteOrder(conn, deps, { dateStr, techId, order: route.order, finalStarts: route.finalStarts });
    journal.routePersisted = true;
    journal.complete = true;
    await writeJournal(conn, planId, journal);
  } catch (err) {
    logger.warn(`[day-replan] ${dateStr} tech ${techId}: step failed (${err.code || err.message}); rolling the day back`);
    // A step that committed and then failed (a customer text reported) is still in the journal as 'intent': the
    // rollback reads where each visit really is.
    const undone = await undoDay(conn, deps, { dateStr, techId, planId, journal, reasonPrefix: `step_failed:${String(err.code || 'error').slice(0, 40)}` });
    return { ...undone, moved: undone.status === 'failed' ? journal.steps.filter((s) => s.state === 'done').length : 0 };
  }
  return { status: 'applied', reason: 'applied', moved: moves.length };
}

// ---- recovery ---------------------------------------------------------------------------------------------------

/** Plans a previous run left mid-apply: started, no outcome. Fails closed to an empty list on a failed read. */
async function findInterrupted(conn) {
  try {
    return await conn(PLAN_TABLE).whereNotNull('apply_started_at').whereNull('apply_status')
      .select('id', 'service_date', 'technician_id', 'apply_steps');
  } catch (err) {
    logger.warn(`[day-replan] could not look for interrupted plans (${err.message})`);
    return [];
  }
}

/**
 * Puts every interrupted plan's day back (or finishes recording a day that had in fact finished), before anything
 * new is planned. One notice for Claude per restored or unrestorable day. Never throws.
 * @returns {Promise<{ id: string, status: string, reason: string }[]>}
 */
async function recoverInterrupted({ conn, deps, plans }) {
  const out = [];
  for (const plan of plans) {
    const dateStr = toDateStr(plan.service_date);
    const techId = plan.technician_id;
    let outcome;
    try {
      const journal = parseJournal(plan.apply_steps);
      if (journal.complete) {
        outcome = { status: 'applied', reason: 'applied_recovered' };
      } else {
        outcome = await undoDay(conn, deps, { dateStr, techId, planId: plan.id, journal, reasonPrefix: 'recovered_after_interruption' });
        if (outcome.status === 'rolled_back') await raiseDayAlert(deps, { dateStr, techId, planId: plan.id, restored: true });
      }
    } catch (err) {
      logger.error(`[day-replan] ${dateStr} tech ${techId}: recovery failed (${err.message})`);
      await raiseDayAlert(deps, { dateStr, techId, planId: plan.id, restored: false });
      outcome = { status: 'failed', reason: `recovery_failed:${String(err.code || 'error').slice(0, 40)}` };
    }
    try {
      await conn(PLAN_TABLE).where({ id: plan.id }).update({
        apply_status: outcome.status, apply_reason: outcome.reason, ...(outcome.status === 'applied' ? { applied_at: conn.fn.now() } : {}),
      });
    } catch (err) {
      logger.error(`[day-replan] could not record the recovery of plan ${plan.id} (${err.message})`);
    }
    out.push({ id: plan.id, date: dateStr, technician_id: techId, ...outcome });
  }
  return out;
}

module.exports = {
  applyAcceptedDay, findInterrupted, recoverInterrupted, INITIATOR, REASON_CODE,
  _internals: { changesKey, recheckVisit, moveVisit, movesFrom, heldMaskFor, hoursMask, finalRoute, persistRouteOrder, rollBack, parseJournal },
};
