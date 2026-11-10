/**
 * GATE_BOOKING_MAKE_ROOM = true (owner 2026-11-09 "YES"): the accept of a make-room hold moves the regular stops later the
 * same day, inside the accept transaction, all or nothing. slot-reservation.js commitReservation proves the hold's chain
 * again under the accept's locks and calls writeMakeRoomMoves; this module owns the writes and what follows the commit.
 *
 * Silent by design: no text, email or call goes to anyone. A moved customer's 72-hour and 24-hour reminders carry the new
 * hour through the same silent reminder sync the day re-plan uses; both steps after the commit read the committed rows
 * again, so a rollback (which RESOLVES knex's executionPromise when it is a bare rollback()) writes and syncs nothing.
 *
 * The writes are the day re-plan's own (services/day-replan/apply.js): the same movable re-check, the same
 * reschedule_log row (initiator 'booking_make_room', an automatic mover), the same occupancy check on the final state.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { MOVED_BY } = require('./booking-make-room')._internals;

// The apply.js codes that mean "the chain no longer holds": the accept answers the ordinary slot-taken error.
const REFUSAL_CODES = new Set(['NOT_MOVABLE', 'CHANGED_SINCE_PLAN', 'SLOT_TAKEN']);
// The repair looks back this far for moves whose after-commit steps may not have run.
const REPAIR_LOOKBACK_DAYS = 3;

const isRefusalCode = (code) => REFUSAL_CODES.has(code);

const minutesOf = (hhmm) => {
  const [h, m] = String(hhmm).slice(0, 5).split(':').map(Number);
  return h * 60 + m;
};

// The writer's collaborators, loaded when needed (day-replan requires a lot; lazy keeps the cycle out).
function loadDeps() {
  return require('../day-replan')._internals.applyDeps();
}

/**
 * The moved stops' rows, FOR UPDATE in id order, before the accept proves the chain again (Codex pre-push P1 on PR 4).
 * A writer that does not take the occupancy lock, such as a customer's confirmation (routes/schedule.js), then either
 * commits first, and the proof and recheckVisit see it, or waits for the accept to end. The day re-plan's writeDay locks
 * its rows the same way (after rung 1 and rung 3, in id order); the locks hold through the writes, to the transaction's end.
 */
async function lockMakeRoomStops(trx, payload) {
  const ids = [...new Set((payload?.moves || []).map((move) => String(move.id)))].sort();
  if (!ids.length) return [];
  return trx('scheduled_services').whereIn('id', ids).orderBy('id').forUpdate().select('id');
}

/**
 * The chain's moves, written inside the caller's transaction: every moved stop is re-checked, then written with its
 * reschedule_log row, then the final state must pass the occupancy predicate. Throws the apply.js codes untouched
 * (isRefusalCode); the caller turns them into the ordinary slot-taken answer, and its rollback undoes every write.
 * Returns the written visits for the after-commit steps.
 */
async function writeMakeRoomMoves(trx, { dateStr, techId, payload, deps = null }) {
  const apply = require('../day-replan/apply');
  const writerDeps = deps || loadDeps();
  const moves = payload.moves.map((move) => ({ id: move.id, toStart: minutesOf(move.to), widthMin: Number(move.widthMin) }));
  for (const move of moves) await apply._internals.recheckVisit(trx, writerDeps, { id: move.id, dateStr, toStart: move.toStart });
  const rows = await trx('scheduled_services').whereIn('id', moves.map((move) => move.id)).select('id', 'window_end');
  const openEnd = new Map(rows.map((row) => [String(row.id), row.window_end == null]));
  const written = await apply._internals.writeMoves(trx, writerDeps, {
    dateStr,
    moves: moves.map((move) => ({ ...move, openEnd: openEnd.get(String(move.id)) === true })),
    initiator: MOVED_BY,
    reasonCode: MOVED_BY,
  });
  await apply._internals.assertNoClash(trx, writerDeps, { dateStr, techId, written });
  return written;
}

/**
 * After the commit, silent and best-effort, never throws: the reminders carry the new hour (re-read from the committed
 * row; a reminder is synced only when its time differs), then the snapshot, visit-group and quality steps.
 */
async function makeRoomAfterCommit({ dateStr, written, conn = db, deps = null }) {
  try {
    const writerDeps = deps || loadDeps();
    const apply = require('../day-replan/apply');
    await apply._internals.reconcileReminders(conn, writerDeps, { ids: written.map((w) => w.id) });
    await require('../day-replan/after-move').afterMoveEffects(conn, { dateStr, written });
  } catch (err) {
    logger.warn(`[booking-make-room] after-commit steps failed (the accept is committed; the repair job finishes them): ${err.message}`);
  }
}

/**
 * Runs makeRoomAfterCommit once the caller's transaction has finished. Returns the pending promise (tests await it), or
 * null when the transaction has no commit hook: then the repair job (reconcileMakeRoomMoves) does the work.
 */
function scheduleMakeRoomAfterCommit(trx, { dateStr, written }) {
  try {
    const { outermostTransaction } = require('../customer-credit');
    const scope = outermostTransaction(trx);
    if (!scope || !scope.executionPromise || typeof scope.executionPromise.then !== 'function') {
      logger.warn('[booking-make-room] caller transaction has no commit hook; the repair job will sync the moved reminders');
      return null;
    }
    return scope.executionPromise.then(() => makeRoomAfterCommit({ dateStr, written }), () => null);
  } catch (err) {
    logger.warn(`[booking-make-room] after-commit scheduling failed: ${err.message}`);
    return null;
  }
}

/**
 * The repair: moved visits of the last few days whose reminder or records may not have followed the move (a process
 * that stopped after the commit). Reads the committed rows, writes only what differs, sends nothing. Never throws.
 * Returns the number of visits looked at.
 */
async function reconcileMakeRoomMoves(conn, { today, deps = null }) {
  try {
    const rows = await conn('reschedule_log')
      .where({ initiated_by: MOVED_BY })
      .where('new_date', '>=', today)
      .whereRaw(`created_at > NOW() - interval '${REPAIR_LOOKBACK_DAYS} days'`)
      .distinct('scheduled_service_id');
    const ids = [...new Set(rows.map((row) => row.scheduled_service_id))];
    if (ids.length === 0) return 0;
    const writerDeps = deps || loadDeps();
    await require('../day-replan/apply')._internals.reconcileReminders(conn, writerDeps, { ids });
    const afterMove = require('../day-replan/after-move');
    for (const id of ids) {
      try {
        await afterMove.repairMoved(conn, id);
      } catch (err) {
        logger.warn(`[booking-make-room] could not repair the records of visit ${id} (${err.message})`);
      }
    }
    return ids.length;
  } catch (err) {
    logger.warn(`[booking-make-room] could not reconcile moved visits (${err.message})`);
    return 0;
  }
}

module.exports = {
  lockMakeRoomStops, writeMakeRoomMoves, makeRoomAfterCommit, scheduleMakeRoomAfterCommit, reconcileMakeRoomMoves, isRefusalCode,
  _internals: { REFUSAL_CODES, REPAIR_LOOKBACK_DAYS, minutesOf },
};
