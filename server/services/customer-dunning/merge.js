'use strict';

/**
 * Customer merge reconciliation for customer_dunning_schedules (customer-dedupe.js executeMerge and
 * revertMerge). The table carries UNIQUE (customer_id, episode) and at most one OPEN schedule per
 * customer (customer_dunning_schedules_open_uniq), so the merge's FK sweep cannot simply repoint the
 * loser's rows onto the winner: two ordinary episode-1 histories, or two open schedules, would raise
 * 23505 and abort the whole merge.
 *
 * The merge therefore runs in two parts:
 *   1. BEFORE its transaction, releaseOpenSchedulesForMerge releases every OPEN schedule of either party
 *      through the engine's own release (closed_reason released_merge): every surviving member lands on
 *      its own per-invoice ladder with no step repeated (schedule.js §7), and the next run promotes the
 *      merged customer as ONE schedule. Release reads the current step's delivery evidence first, which
 *      may not run under the merge's locks. A release the engine refuses (a send in flight, an
 *      unconfirmed or unreadable current step, a schedule that kept changing) aborts the merge before
 *      anything moved: handing members back blind could send a step that already went out.
 *   2. FIRST inside the merge transaction, reconcileInMergeTransaction takes both customers' dunning keys
 *      EXCLUSIVELY (sorted ids, before any other lock the merge takes: every engine path takes this key
 *      first in a fresh transaction, so the merge never waits on it while holding anything), refuses when
 *      an open schedule appeared since step 1 (a promotion in between: retry), and renumbers the loser's
 *      closed episodes above the winner's highest so the FK sweep's repoint keeps (customer_id, episode)
 *      unique. Holding the keys to commit keeps any promotion, claim or release out until the customer
 *      is one row.
 *
 * Episode renumbering never changes a touch's identity: every key carries the schedule's uuid, and a
 * closed schedule's keys are never rebuilt from its row. The renumbered rows are plain repoints in the
 * merge journal, so the undo moves them back by id (the loser has no other rows to collide with).
 */

const db = require('../../models/db');
const logger = require('../logger');
const { OPEN_STATUSES, lockKey } = require('./constants');

const TABLE = 'customer_dunning_schedules';
const MERGE_REASON = 'released_merge';

const isOpen = (row) => OPEN_STATUSES.includes(row?.status);
const sortedIds = (ids) => [...new Set(ids.filter(Boolean).map(String))].sort();

// Why a merge could not reconcile, in words an operator reads (the reason code stays on the error).
const BLOCKED_TEXT = Object.freeze({
  in_flight: 'a combined overdue reminder is sending to one of these customers right now',
  outcome_unconfirmed: 'the delivery of the current combined overdue reminder is still unconfirmed',
  evidence_unreadable: 'whether the current combined overdue reminder already went out could not be read',
  schedule_changed: 'the combined overdue reminder schedule kept changing',
  claim_lost: 'the combined overdue reminder schedule changed',
  reopened: 'a combined overdue reminder schedule opened for one of these customers while merging',
});

function mergeBlocked(reason) {
  const err = new Error(`executeMerge: deferred — ${BLOCKED_TEXT[reason] || 'the combined overdue reminders could not be released'}; nothing was merged, retry in a few minutes`);
  err.statusCode = 409;
  err.code = 'DUNNING_SCHEDULE_BUSY';
  err.dunningReason = reason;
  return err;
}

// Every schedule row of these customers. A read that fails fails the merge (nothing has moved yet).
async function readRows(database, customerIds, columns) {
  const rows = await database(TABLE).whereIn('customer_id', customerIds).select(...columns);
  return Array.isArray(rows) ? rows : [];
}

/**
 * Step 1 (before the merge transaction): release every open schedule of the given customers. Returns
 * [{ scheduleId, customerId, landed }] for the schedules it closed; throws a 409 DUNNING_SCHEDULE_BUSY
 * error, having closed nothing more, when the engine refuses a release. A schedule another writer
 * closed in between needs nothing (step 2 re-checks under the keys).
 */
async function releaseOpenSchedulesForMerge(customerIds, { now = new Date(), database = db } = {}) {
  const ids = sortedIds(customerIds);
  if (!ids.length) return [];
  const open = (await readRows(database, ids, ['*'])).filter(isOpen);
  if (!open.length) return [];
  const Schedule = require('./schedule');
  const released = [];
  for (const schedule of open) {
    const out = await Schedule.release(schedule, MERGE_REASON, now, { database });
    if (out.closed) {
      released.push({ scheduleId: schedule.id, customerId: String(schedule.customer_id), landed: out.landed.length });
      logger.info(`[customer-dunning] schedule ${schedule.id} (customer ${schedule.customer_id}) released for a customer merge; ${out.landed.length} invoice(s) back on their own reminders`);
      continue;
    }
    if (!out.reason) continue; // already closed by another writer
    logger.warn(`[customer-dunning] customer merge refused: schedule ${schedule.id} not released (${out.reason})`);
    throw mergeBlocked(out.reason);
  }
  return released;
}

/** Both customers' dunning keys, EXCLUSIVE, in sorted order. */
async function lockCustomers(trx, customerIds) {
  for (const id of sortedIds(customerIds)) {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [lockKey(id)]);
  }
}

/**
 * Step 2 (FIRST inside the merge transaction): take both dunning keys, refuse an open schedule, and
 * renumber the loser's episodes above the winner's. Returns [{ id, from, to }] (empty when nothing
 * needed renumbering).
 */
async function reconcileInMergeTransaction(trx, { winnerId, loserId }) {
  await lockCustomers(trx, [winnerId, loserId]);
  const rows = await readRows(trx, [winnerId, loserId], ['id', 'customer_id', 'episode', 'status']);
  if (rows.some(isOpen)) throw mergeBlocked('reopened');
  const winnerMax = rows.filter((r) => String(r.customer_id) === String(winnerId))
    .reduce((max, r) => Math.max(max, Number(r.episode) || 0), 0);
  const loserRows = rows.filter((r) => String(r.customer_id) === String(loserId))
    .sort((a, b) => Number(a.episode) - Number(b.episode));
  if (!winnerMax || !loserRows.length) return [];
  // Two phases, so no intermediate value can collide under the per-row unique check: every loser
  // episode goes negative first (distinct, and never equal to a positive episode), then each takes
  // its place above the winner's highest, in its original order.
  const negated = await trx(TABLE).where({ customer_id: loserId }).update({ episode: trx.raw('-episode'), updated_at: trx.fn.now() });
  if (Number(negated) !== loserRows.length) throw mergeBlocked('schedule_changed');
  const renumbers = [];
  for (const [i, row] of loserRows.entries()) {
    const to = winnerMax + i + 1;
    await trx(TABLE).where({ id: row.id }).update({ episode: to });
    renumbers.push({ id: row.id, from: Number(row.episode), to });
  }
  return renumbers;
}

/**
 * The undo's share (revertMerge): the same keys, EXCLUSIVE, so no promotion, claim or release runs
 * while the journaled invoices and sequences move back. Nothing else is needed: the loser's journaled
 * schedule rows are closed history that moves back by id, and any combined send after the merge
 * stamped the member sequences and wrote the contact ledger, which the undo's own activity gates refuse.
 */
const lockForMergeUndo = (trx, { winnerId, loserId }) => lockCustomers(trx, [winnerId, loserId]);

module.exports = {
  MERGE_REASON,
  releaseOpenSchedulesForMerge,
  reconcileInMergeTransaction,
  lockForMergeUndo,
  _test: { mergeBlocked, BLOCKED_TEXT },
};
