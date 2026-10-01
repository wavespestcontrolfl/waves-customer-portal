'use strict';

/**
 * Customer merge reconciliation for customer_dunning_schedules (customer-dedupe.js executeMerge and
 * revertMerge). The table carries UNIQUE (customer_id, episode) and at most one OPEN schedule per
 * customer (customer_dunning_schedules_open_uniq), so the merge's FK sweep cannot simply repoint the
 * loser's rows onto the winner: two ordinary episode-1 histories, or two open schedules, would raise
 * 23505 and abort the whole merge.
 *
 * The merge therefore runs in two parts, and from the operator's view it is all-or-nothing (Codex local
 * review P2: releases used to commit BEFORE the merge transaction, so a merge that then refused, or whose
 * second release refused, left the first schedule released for good: a paused combined schedule became
 * separate paused invoices and the customer-level resume answered 404):
 *   1. BEFORE its transaction, prepareMergeRelease reads, for every OPEN schedule of either party, the row's
 *      version and the current step's delivery evidence (the ledger read must not run under the merge's
 *      locks, and on the global pool it costs no second connection of the merge's own), and refuses up
 *      front, for EITHER customer, what a release would refuse: a send in flight, evidence that cannot be
 *      read, a current step whose outcome is unconfirmed while members remain. It writes nothing.
 *   2. FIRST inside the merge transaction, lockInMergeTransaction takes both customers' dunning keys
 *      EXCLUSIVELY (sorted ids, before any other lock the merge takes: every engine path takes this key
 *      first in a fresh transaction, so the merge never waits on it while holding anything). Then, after
 *      the merge's own prerequisite locks, releaseInMergeTransaction locks the member invoices (id order)
 *      and closes each open schedule ON THE MERGE'S TRANSACTION (Schedule.closeUnderLock, closed_reason
 *      released_merge: every surviving member lands on its own per-invoice ladder with no step repeated,
 *      schedule.js §7) against the version step 1 read (any write since, a send included, refuses as
 *      schedule_changed: the evidence may be stale), refuses a schedule that opened after step 1, and
 *      renumbers the loser's episodes above the winner's highest so the FK sweep's repoint keeps
 *      (customer_id, episode) unique. Any later refusal of the merge (eligibility, approved versions,
 *      conflicts) rolls the releases back with everything else. Holding the keys to commit keeps any
 *      promotion, claim or release out until the customer is one row; the next run promotes the merged
 *      customer as ONE schedule.
 *   3. AFTER commit, afterMergeCommit raises the office alert for any member released past its final step
 *      (alerts are never written on the merge's transaction). Best effort: the member row itself is already
 *      paused for a person, which is the state that matters.
 *
 * Episode renumbering never changes a touch's identity: every key carries the schedule's uuid, and a
 * closed schedule's keys are never rebuilt from its row. The renumbered rows are plain repoints in the
 * merge journal, so the undo moves them back by id (the loser has no other rows to collide with).
 */

const db = require('../../models/db');
const logger = require('../logger');
const { redactContact } = require('../../utils/redact-contact');
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
 * Step 1 (before the merge transaction): for each OPEN schedule of the given customers, the row version and
 * the current step's delivery evidence the in-transaction close is held to. Every refusal a release would
 * give is checked for BOTH customers before the merge starts; nothing is written. Throws a 409
 * DUNNING_SCHEDULE_BUSY error on a refusal, or the read error itself when the schedules cannot be read.
 * Returns [{ schedule, at, delivery }].
 */
async function prepareMergeRelease(customerIds, { now = new Date(), database = db } = {}) {
  const ids = sortedIds(customerIds);
  if (!ids.length) return [];
  const open = (await readRows(database, ids, ['*'])).filter(isOpen);
  if (!open.length) return [];
  const Schedule = require('./schedule');
  const prepared = [];
  for (const schedule of open) {
    if (Schedule.claimIsFresh(schedule, now)) throw refused(schedule, 'in_flight');
    const at = await Schedule.rowSnapshot(database, schedule.id);
    if (!at) continue; // closed by another writer since the read: step 2 re-checks under the keys
    let delivery;
    try {
      delivery = await Schedule.currentStepDelivery({ ...schedule, step_index: at.step_index, episode: at.episode });
    } catch (err) {
      logger.error(`[customer-dunning] schedule ${schedule.id} delivery evidence unreadable for a customer merge: ${redactContact(err.message)}`);
      throw refused(schedule, 'evidence_unreadable');
    }
    if (delivery?.unconfirmed && (await Schedule.activeMemberRows(schedule.customer_id, { database })).length) {
      throw refused(schedule, 'outcome_unconfirmed');
    }
    prepared.push({ schedule, at, delivery });
  }
  return prepared;
}

function refused(schedule, reason) {
  logger.warn(`[customer-dunning] customer merge refused: schedule ${schedule.id} not releasable (${reason})`);
  return mergeBlocked(reason);
}

/** Both customers' dunning keys, EXCLUSIVE, in sorted order. */
async function lockCustomers(trx, customerIds) {
  for (const id of sortedIds(customerIds)) {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [lockKey(id)]);
  }
}

/**
 * Step 2a (FIRST inside the merge transaction): take both dunning keys and refuse a schedule that opened
 * since step 1 (one step 1 did not prepare). Writes nothing. Returns the plan step 2b carries out.
 */
async function lockInMergeTransaction(trx, { winnerId, loserId, prepared = [] }) {
  await lockCustomers(trx, [winnerId, loserId]);
  const rows = await readRows(trx, [winnerId, loserId], ['id', 'customer_id', 'episode', 'status']);
  const toRelease = rows.filter(isOpen).map((row) => {
    const prep = prepared.find((p) => String(p.schedule.id) === String(row.id));
    if (!prep) throw mergeBlocked('reopened');
    return prep;
  });
  return { winnerId, loserId, rows, toRelease };
}

/**
 * Step 2b, inside the merge transaction AFTER the merge's own prerequisite locks (case, preference,
 * closeout and combined-session keys, the customer and saved-card rows) and before its first repoint: lock
 * the member INVOICE rows of both customers in one id-ordered statement, then close every planned schedule
 * on `trx` against what step 1 read (Schedule.closeUnderLock: schedule row -> invoices -> sequences, the
 * engine's order), then renumber the loser's episodes above the winner's. An invoice edit locks its invoice
 * before writing its sequence; taking every member invoice before any member sequence keeps the merge out
 * of a cycle with it. Returns { renumbers: [{ id, from, to }], released: [{ schedule, landed }] }. Throws a
 * 409 DUNNING_SCHEDULE_BUSY error (the merge rolls back, releases included) when a schedule changed since
 * its evidence was read or a release refuses.
 */
async function releaseInMergeTransaction(trx, plan, { now = new Date() } = {}) {
  const { winnerId, loserId, rows, toRelease } = plan;
  const released = [];
  if (toRelease.length) {
    const Schedule = require('./schedule');
    await lockMemberInvoicesOf(trx, Schedule, [winnerId, loserId]);
    for (const prep of toRelease) {
      const out = await Schedule.closeUnderLock(trx, prep.schedule, MERGE_REASON, now, prep.at, prep.delivery);
      if (!out.closed) throw refused(prep.schedule, out.changed || !out.reason ? 'schedule_changed' : out.reason);
      released.push({ schedule: prep.schedule, landed: out.landed });
    }
  }
  return { renumbers: await renumberLoserEpisodes(trx, rows, { winnerId, loserId }), released };
}

// Every active member invoice of these customers, locked in ONE id-ordered statement (two per-customer
// batches would each be ordered but interleave out of order across the pair).
async function lockMemberInvoicesOf(trx, Schedule, customerIds) {
  const ids = new Set();
  for (const id of sortedIds(customerIds)) {
    for (const row of await Schedule.activeMemberRows(id, { database: trx })) ids.add(String(row.invoice_id));
  }
  const sorted = [...ids].sort();
  if (sorted.length) await trx('invoices').whereIn('id', sorted).orderBy('id').forUpdate().select('id');
}

async function renumberLoserEpisodes(trx, rows, { winnerId, loserId }) {
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
 * Step 3 (after the merge committed): log each release and alert the office for any member released past its
 * final step, on the surviving customer (`winnerId`). Never throws: the merge already happened.
 */
async function afterMergeCommit(released = [], { winnerId = null } = {}) {
  if (!released.length) return;
  const Schedule = require('./schedule');
  for (const { schedule, landed } of released) {
    logger.info(`[customer-dunning] schedule ${schedule.id} (customer ${schedule.customer_id}) released for a customer merge; ${landed.length} invoice(s) back on their own reminders`);
    try {
      // The invoices now belong to the WINNER: an alert keyed to the loser would link the office to the
      // archived customer (Codex #5503 r3). The schedule id still names the released schedule.
      await Schedule.alertPastFinal(winnerId ? { ...schedule, customer_id: winnerId } : schedule, landed);
    } catch (err) {
      logger.error(`[customer-dunning] past-final alert after a customer merge failed for schedule ${schedule.id}: ${redactContact(err.message)}`);
    }
  }
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
  prepareMergeRelease,
  lockInMergeTransaction,
  releaseInMergeTransaction,
  afterMergeCommit,
  lockForMergeUndo,
  _test: { mergeBlocked, BLOCKED_TEXT },
};
