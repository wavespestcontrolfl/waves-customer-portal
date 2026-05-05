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

/**
 * Set the semantic job focus for a tech without clobbering the latest
 * GPS coordinates. Used by service lifecycle transitions; Bouncie owns
 * lat/lng freshness, the lifecycle owns current_job_id.
 */
async function setTechJobStatus({ tech_id, status, current_job_id }) {
  if (!tech_id || !status) {
    throw new Error('setTechJobStatus: tech_id and status are required');
  }

  const [row] = await db.raw(
    `
    INSERT INTO tech_status (tech_id, status, current_job_id, updated_at)
    VALUES (?, ?, ?, NOW())
    ON CONFLICT (tech_id) DO UPDATE SET
      status = EXCLUDED.status,
      current_job_id = EXCLUDED.current_job_id,
      updated_at = NOW()
    RETURNING id, tech_id, status, lat, lng, current_job_id, updated_at
    `,
    [tech_id, status, current_job_id ?? null]
  ).then((r) => r.rows);

  const io = getIo();
  if (io) {
    io.to(ROOM).emit(EVENT, row);
  } else {
    logger.warn('[tech-status] io not initialized; skipping job-status broadcast');
  }

  return row;
}

/**
 * Clear a tech's current job only if it still points at the service
 * being closed. This avoids wiping a newer en-route assignment when an
 * old tab completes/cancels a stale job.
 */
async function clearTechCurrentJob({ tech_id, current_job_id, status = 'idle' }) {
  if (!tech_id || !current_job_id) return null;

  const [row] = await db('tech_status')
    .where({ tech_id, current_job_id })
    .update({
      status,
      current_job_id: null,
      updated_at: db.fn.now(),
    })
    .returning(['id', 'tech_id', 'status', 'lat', 'lng', 'current_job_id', 'updated_at']);

  if (!row) return null;

  const io = getIo();
  if (io) {
    io.to(ROOM).emit(EVENT, row);
  } else {
    logger.warn('[tech-status] io not initialized; skipping clear-current-job broadcast');
  }

  return row;
}

/**
 * GPS-source ping. Called from the Bouncie webhook on every trip-data
 * sample (and trip-start / trip-end / connect / disconnect events).
 *
 * Two reasons this is a separate function from upsertTechStatus:
 *
 *   1. Status priority. tech_status.status has 6 values, but only
 *      three of them are GPS-derivable: `driving`, `idle`, `break`
 *      (we treat ignition-off-for-a-while as `break` later if needed;
 *      for v1 it's just `driving` vs `idle`). The other three —
 *      `en_route`, `on_site`, `wrapping_up` — are SEMANTIC states
 *      owned by track-transitions (admin clicks "en route") or by a
 *      future tech-mobile heartbeat. Bouncie pings every ~minute, so
 *      if it overwrote status unconditionally, an admin's en_route
 *      flip would get clobbered on the next ping.
 *
 *      ON CONFLICT, we preserve the existing status when it's one of
 *      the semantic three; otherwise we accept the GPS-derived status.
 *
 *   2. Bouncie doesn't know about jobs. current_job_id is set by
 *      track-transitions or future tech-mobile heartbeats — the
 *      Bouncie path never touches it. The CASE here updates lat / lng
 *      / updated_at unconditionally, leaves current_job_id alone.
 *
 * After commit we still emit dispatch:tech_status with the full row
 * (including the preserved current_job_id) so the dispatch board's
 * client-side address-lookup logic still works.
 *
 * @param {object} args
 * @param {string} args.tech_id          required
 * @param {number} args.lat              required
 * @param {number} args.lng              required
 * @param {boolean|null} [args.ignition] optional, used for status derivation
 * @param {number|null}  [args.speed_mph] optional, used for status derivation
 */
async function pingTechLocation({ tech_id, lat, lng, ignition, speed_mph }) {
  if (!tech_id || lat == null || lng == null) {
    throw new Error('pingTechLocation: tech_id, lat, lng are required');
  }

  const moving = ignition === true && Number(speed_mph || 0) > 5;
  const derivedStatus = moving ? 'driving' : 'idle';

  let row;
  await db.transaction(async (trx) => {
    // Single-statement upsert. Status uses CASE WHEN to preserve
    // semantic states when the row already exists with one set —
    // see header comment for why.
    const [committed] = await trx.raw(
      `
      INSERT INTO tech_status (tech_id, status, lat, lng, updated_at)
      VALUES (?, ?, ?, ?, NOW())
      ON CONFLICT (tech_id) DO UPDATE SET
        lat = EXCLUDED.lat,
        lng = EXCLUDED.lng,
        updated_at = NOW(),
        status = CASE
          WHEN tech_status.status IN ('en_route','on_site','wrapping_up')
            THEN tech_status.status
          ELSE EXCLUDED.status
        END
      RETURNING id, tech_id, status, lat, lng, current_job_id, updated_at
      `,
      [tech_id, derivedStatus, lat, lng]
    ).then((r) => r.rows);
    row = committed;
  });
  // trx committed by here.

  // ETA enrichment: when the tech is en_route/driving toward an
  // assigned current_job, look up the job's lat/lng (or the customer's
  // geocoded address as fallback) and compute a haversine ETA.
  // Matches the formula in admin-dispatch.js computeTechEta — keep
  // them in sync if you change one. Failure paths return eta_minutes
  // null; never block the ping broadcast on this enrichment.
  let eta_minutes = null;
  if (row && row.current_job_id && (row.status === 'en_route' || row.status === 'driving')) {
    try {
      const job = await db('scheduled_services as s')
        .leftJoin('customers as c', 's.customer_id', 'c.id')
        .where('s.id', row.current_job_id)
        .first(
          db.raw('COALESCE(s.lat, c.latitude) AS lat'),
          db.raw('COALESCE(s.lng, c.longitude) AS lng')
        );
      if (job && job.lat != null && job.lng != null) {
        eta_minutes = haversineEtaMinutes(
          Number(row.lat), Number(row.lng),
          Number(job.lat), Number(job.lng)
        );
      }
    } catch (err) {
      logger.warn(`[tech-status] ETA enrichment failed: ${err.message}`);
    }
  }

  const enrichedRow = { ...row, eta_minutes };

  const io = getIo();
  if (io) {
    io.to(ROOM).emit(EVENT, enrichedRow);
  } else {
    logger.warn('[tech-status] io not initialized; skipping ping broadcast');
  }

  return enrichedRow;
}

// Haversine ETA in whole minutes — must match admin-dispatch.js
// computeTechEta exactly. Road factor 1.4× at 30 mph; floored at 1.
function haversineEtaMinutes(fromLat, fromLng, toLat, toLng) {
  if ([fromLat, fromLng, toLat, toLng].some((v) => v == null || Number.isNaN(v))) return null;
  const R = 3959;
  const dLat = (toLat - fromLat) * Math.PI / 180;
  const dLng = (toLng - fromLng) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(fromLat * Math.PI / 180) * Math.cos(toLat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  const distMi = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 1.4;
  return Math.max(1, Math.round((distMi / 30) * 60));
}

module.exports = {
  upsertTechStatus,
  pingTechLocation,
  setTechJobStatus,
  clearTechCurrentJob,
  ROOM,
  EVENT,
};
