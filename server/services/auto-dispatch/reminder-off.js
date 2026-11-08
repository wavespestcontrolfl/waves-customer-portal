/**
 * REMINDERS-OFF LOCK (owner 2026-11-07, "lock"). The night run (04:10, and its 05:00 catch-up) moves visits silently:
 * apply.js sends the customer nothing, so the 24-hour reminder is the customer's only notice of a new day or hour. A
 * visit whose 24-hour reminder will not go out therefore never moves, neither its day nor its hour. "Will not go out"
 * is the senders' own rule (appointment-reminders loadVisitReminder24hAnswers over reminder24hWillSend): the reminder
 * is off, or a text-only choice meets texts off, or an enforced saved property keeps the visit quiet. So the lock and
 * the reminder cannot disagree. The 04:40 day re-plan keeps the same visits (day-replan reason reminder_24h_off).
 *
 * Where it acts: pass 1 skips the visit (one bulk read per run: loadRunOffIds, skipFor), pass 2 reads it again right
 * before the move (recheckFor), and the move transaction reads it once more for every row it writes (apply.js:
 * makeMoveGuard for the moving row, makeMemberGuard for grouped siblings; assertRemindersOn). An answer that cannot be
 * read moves nothing (fail closed).
 *
 * Not a move: the unplaced due-date shape (a due date with no time yet, move-rules isUnplacedDueDate) is the visit's
 * first placement, not a change to anything the customer was told, so it is placed as before.
 *
 * No gate: the lock only keeps visits where they are.
 */
const logger = require('../logger');
const { isUnplacedDueDate } = require('./move-rules');

const CODE = 'REMINDER_24H_OFF';
const UNKNOWN_CODE = 'REMINDER_24H_UNKNOWN';
const OFF_TEXT = 'The 24-hour reminder is off for this visit, so the customer would not hear of a move; the night run keeps it where it is';

// A placed visit: the rows the lock covers.
const covered = (row) => !!row && row.id != null && !isUnplacedDueDate(row);

/**
 * The ids (as strings) of these scheduled_services rows ({ id, customer_id, property_id, recurring_dispatch_due_date,
 * window_start }) whose 24-hour reminder will not go out. A row with no customer has no answer and counts as off.
 * Unplaced due-date rows are never in the set. Throws on a failed read.
 */
async function loadReminderOffIds(conn, rows) {
  const list = (rows || []).filter(covered);
  if (!list.length) return new Set();
  const answers = await require('../appointment-reminders').loadVisitReminder24hAnswers(
    conn, list.map((r) => ({ id: r.id, customer_id: r.customer_id, property_id: r.property_id })),
  );
  return new Set(list.filter((r) => answers.get(r.id) !== true).map((r) => String(r.id)));
}

/** Pass 1's one read for the run: the Set of locked ids, or null when the read failed (every placed visit stays). */
async function loadRunOffIds(conn, services) {
  try {
    return await loadReminderOffIds(conn, services);
  } catch (err) {
    logger.error(`[auto-dispatch] 24-hour reminder answers unreadable (${err.message}) - no placed visit moves this run`);
    return null;
  }
}

/** Pass 1, one visit: the skip row ({ reason_code, reason_description }), or null when the lock lets it move. */
function skipFor(offIds, service) {
  if (!covered(service)) return null;
  if (!offIds) {
    return { reason_code: UNKNOWN_CODE, reason_description: 'The 24-hour reminder answer could not be read - no move (fail closed)' };
  }
  return offIds.has(String(service.id)) ? { reason_code: CODE, reason_description: OFF_TEXT } : null;
}

/**
 * Pass 2, one planned move, right before it: null when it may move, else { code, description } (degraded: true when
 * the read failed). The customer may have turned the reminder off while the run scored the move.
 */
async function recheckFor(conn, service) {
  if (!covered(service)) return null;
  let offIds;
  try {
    offIds = await loadReminderOffIds(conn, [service]);
  } catch (err) {
    logger.warn(`[auto-dispatch] 24-hour reminder answer unreadable for ${service.id} at apply time (${err.message}) - no move`);
    return { code: UNKNOWN_CODE, description: 'The 24-hour reminder answer could not be read at apply time - no move (fail closed)', degraded: true };
  }
  return offIds.has(String(service.id)) ? { code: CODE, description: OFF_TEXT } : null;
}

/**
 * apply.js, on the move transaction: refuse (via `refuse`) when any of `rows` (the moving row, or grouped siblings) has
 * its 24-hour reminder off. Each row's customer, property and placement are read again on `trx`, so the answer is as
 * late as the write. A row gone from the table refuses too. A failed read throws, so nothing moves.
 */
async function assertRemindersOn(trx, rows, refuse) {
  const ids = (rows || []).filter((r) => r && r.id != null).map((r) => r.id);
  if (!ids.length) return;
  const fresh = await trx('scheduled_services').whereIn('id', ids)
    .select('id', 'customer_id', 'property_id', 'recurring_dispatch_due_date', 'window_start');
  const found = new Set((fresh || []).map((r) => String(r.id)));
  const gone = ids.find((id) => !found.has(String(id)));
  if (gone != null) throw refuse(gone, 'is gone (no move)');
  const offIds = await loadReminderOffIds(trx, fresh);
  const hit = ids.find((id) => offIds.has(String(id)));
  if (hit != null) throw refuse(hit, 'has its 24-hour reminder off, so the customer would not hear of the move (no move)');
}

module.exports = {
  CODE, UNKNOWN_CODE, loadReminderOffIds, loadRunOffIds, skipFor, recheckFor, assertRemindersOn,
};
