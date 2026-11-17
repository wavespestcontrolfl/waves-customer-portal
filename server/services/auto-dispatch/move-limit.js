/**
 * MOVE LIMIT — how many automatic moves one visit may have.
 *
 * Owner 2026-10-09: "at most two automatic day moves for one visit, both
 * inside the +/-5-day window". The count comes from the durable move log,
 * never from the best-effort `auto_dispatch_change_count` stamp on the visit
 * (apply.js skips that stamp when the row changed after the move). A move is
 * a reschedule_log row the rebooker wrote inside the move transaction with the
 * auto-dispatch writer signature (the one route-tiers.js loadAnchorMap reads)
 * whose date or window changed (eligibility.js SLOT_CHANGED_SQL). Day moves,
 * same-day re-times and forced moves (an unplaced due date, a conflict) all
 * count. config.maxAutoMovesPerVisit sets the limit; 0 turns it off.
 *
 * ONE EXCEPTION (owner 2026-11-17, "pick limit"): a pick fallback row. Quick
 * Move's "let the customer pick a day" text promises that if the customer does
 * not pick, the night run books the visit, so that run may place a visit at
 * the limit. The row is one handed to the customer (customer_pick_by set and
 * passed) that is still unplaced (no window). The limit does not apply to it.
 * customer_pick_by stays set after the placement on purpose (rebooker.js,
 * appointment-reminders.js), so the exemption needs the window to be null: a
 * placed row counts again like any other. The fallback placement's log row has
 * no original_window, so countAutoMoves never counts it as a move.
 *
 * Read in three places: pass 1 (one bulk read for the loaded visits), the
 * pass-2 recheck (index.js), and inside the write transaction (apply.js move
 * guard and grouped-member guard, counted on `trx`). A grouped visit moves
 * only if every member is under the limit.
 */
const logger = require('../logger');
const { SLOT_CHANGED_SQL } = require('./eligibility');

function limitOf(config) {
  const n = Number(config && config.maxAutoMovesPerVisit);
  return n > 0 ? n : 0;
}

// Map<serviceId, number of automatic slot-changing moves>. Throws on a read
// failure; a service with no such row is absent from the map.
async function countAutoMoves(conn, serviceIds) {
  const counts = new Map();
  if (!serviceIds || serviceIds.length === 0) return counts;
  const rows = await conn('reschedule_log')
    .whereIn('scheduled_service_id', serviceIds)
    .where('reason_code', 'auto_dispatch')
    .where('initiated_by', 'auto_dispatch')
    // The first placement of a visit that had no arrival window is not a
    // move: the customer was never told an earlier time.
    .whereRaw(`${SLOT_CHANGED_SQL} AND original_window IS NOT NULL`)
    .groupBy('scheduled_service_id')
    .count('* as moves')
    .select('scheduled_service_id');
  for (const r of rows) counts.set(String(r.scheduled_service_id), Number(r.moves));
  return counts;
}

// The read orchestration uses: an empty map when the limit is off, null when
// the read failed (callers treat every visit as unknown and skip; fail closed).
async function loadMoveCounts(conn, serviceIds, config) {
  if (!limitOf(config)) return new Map();
  try {
    return await countAutoMoves(conn, serviceIds);
  } catch (err) {
    logger.error(`[auto-dispatch] move-count read failed — no visit moves this run: ${err.message}`);
    return null;
  }
}

// A pick fallback row (header): handed to the customer, the pick-by instant
// has passed, and still unplaced. The limit does not apply to it.
function pickFallbackDue(row, now = new Date()) {
  if (!row || !row.customer_pick_by || row.window_start != null) return false;
  const by = new Date(row.customer_pick_by).getTime();
  return Number.isFinite(by) && by <= now.getTime();
}

function atLimit(counts, id, config) {
  const limit = limitOf(config);
  return limit > 0 && (counts.get(String(id)) || 0) >= limit;
}

// The skip row for a visit that may not move, or null when it may. `unknown`
// marks the fail-closed row (no counts), which is not a "needs a person" case.
function limitSkip(service, counts, config) {
  const limit = limitOf(config);
  if (!limit || pickFallbackDue(service)) return null;
  if (!counts) {
    return { reason_code: 'MOVE_COUNT_UNKNOWN', reason_description: 'Automatic move history unreadable — no move (fail closed)', unknown: true };
  }
  if (!atLimit(counts, service.id, config)) return null;
  return {
    reason_code: 'MOVE_LIMIT_REACHED',
    reason_description: `Already moved ${counts.get(String(service.id))} times by auto-dispatch (limit ${limit}) — a person must move it`,
  };
}

// The ids among `rows` that are still pick fallback rows as saved on `trx`.
async function fallbackIdsOnTrx(trx, rows) {
  if (!rows.length) return new Set();
  const fresh = await trx('scheduled_services')
    .whereIn('id', rows.map((r) => r.id))
    .select('id', 'customer_pick_by', 'window_start');
  return new Set(fresh.filter((r) => pickFallbackDue(r)).map((r) => String(r.id)));
}

// The write-transaction check (move guard and member guard): refuses, like
// the other guards, when any of `rows` is at the limit on `trx`. A row that
// looks like a pick fallback row is read again on `trx` (the caller's row may
// be older than the transaction); it is exempt only if it still qualifies.
async function assertUnderLimit(trx, rows, config, refuse) {
  if (!limitOf(config)) return;
  const exempt = await fallbackIdsOnTrx(trx, rows.filter((r) => pickFallbackDue(r)));
  const counted = rows.filter((r) => !exempt.has(String(r.id)));
  if (!counted.length) return;
  const counts = await countAutoMoves(trx, counted.map((r) => r.id));
  const over = counted.find((r) => atLimit(counts, r.id, config));
  if (over) {
    throw refuse(over.id, `has already been moved automatically ${counts.get(String(over.id))} times (limit ${limitOf(config)}) — no move`);
  }
}

module.exports = {
  limitOf, countAutoMoves, loadMoveCounts, atLimit, pickFallbackDue, limitSkip, assertUnderLimit,
};
