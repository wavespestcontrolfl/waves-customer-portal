/**
 * Sole writer for tech_status. Wraps the upsert in a Knex transaction
 * and emits dispatch:tech_status to the dispatch:admins room *after*
 * the transaction commits — never before, never inside.
 *
 * Why this matters:
 *   If the emit fired inside the transaction (or before commit) and
 *   the transaction then rolled back, dispatch:admins would have
 *   already received a payload describing a row that doesn't exist
 *   in the DB. Admins would see a phantom status; the dispatch
 *   board's left-pane roster would drift from the source of truth.
 *
 * Pattern:
 *   1. await db.transaction(async (trx) => { upsert via trx, return row })
 *   2. trx auto-commits when the callback resolves
 *   3. THEN emit the freshly-committed row
 *   If the upsert throws inside the trx callback, Knex rolls back and
 *   re-throws. The emit line never runs. Caller gets the error.
 *
 * Single emit point — no other code path writes to tech_status.
 * Bouncie webhook integration in a follow-up PR will call this
 * function; do not modify the Bouncie webhook in this PR.
 *
 * Future siblings (job_status_history insert, GPS history append,
 * etc.) belong inside this same trx callback so commit ordering
 * stays atomic for the whole "tech moved" event.
 */
const db = require('../models/db');
const { getIo } = require('../sockets');
const logger = require('./logger');

const ROOM = 'dispatch:admins';
const EVENT = 'dispatch:tech_status';

/**
 * Upsert a tech_status row and broadcast to the admin room.
 *
 * @param {object} payload
 * @param {string} payload.tech_id           required, FK technicians.id
 * @param {string} payload.status            required, one of the CHECK values
 *                                           (en_route|on_site|wrapping_up|driving|break|idle)
 * @param {number} [payload.lat]             optional
 * @param {number} [payload.lng]             optional
 * @param {string} [payload.current_job_id]  optional, FK scheduled_services.id
 * @returns {Promise<object>} the committed row (full shape)
 */
async function upsertTechStatus(payload) {
  if (!payload || !payload.tech_id || !payload.status) {
    throw new Error('upsertTechStatus: tech_id and status are required');
  }

  const upsertCols = {
    tech_id: payload.tech_id,
    status: payload.status,
    lat: payload.lat ?? null,
    lng: payload.lng ?? null,
    current_job_id: payload.current_job_id ?? null,
    updated_at: db.fn.now(),
  };

  // Transaction-bounded — the upsert (and any future siblings added
  // here, like a tech_status history append) commit atomically. The
  // emit lives OUTSIDE the trx callback so it only fires post-commit.
  let row;
  await db.transaction(async (trx) => {
    const [committed] = await trx('tech_status')
      .insert(upsertCols)
      .onConflict('tech_id')
      .merge({
        status: upsertCols.status,
        lat: upsertCols.lat,
        lng: upsertCols.lng,
        current_job_id: upsertCols.current_job_id,
        updated_at: upsertCols.updated_at,
      })
      .returning(['id', 'tech_id', 'status', 'lat', 'lng', 'current_job_id', 'updated_at']);
    row = committed;
  });
  // trx is committed by here. Anything below is "after commit."

  const io = getIo();
  if (io) {
    io.to(ROOM).emit(EVENT, row);
  } else {
    // attachSockets() didn't run — typically only happens in unit
    // tests that import this module without booting the full server.
    // Don't throw; the DB write already succeeded and is the source
    // of truth. Just note it.
    logger.warn('[tech-status] io not initialized; skipping broadcast');
  }

  return row;
}

module.exports = { upsertTechStatus, ROOM, EVENT };
