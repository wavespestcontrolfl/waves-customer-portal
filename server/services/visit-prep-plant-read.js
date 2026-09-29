/**
 * Visit prep photos — automatic lawn / tree & shrub read (GATE_VISIT_PREP_PLANT_READ,
 * dark). Sibling of visit-prep-pest-read.js: when a customer sends photos
 * for a lawn or tree & shrub visit, this runs the merged photo-id-v2 lawn/
 * plant engine (identifyPlantV2, server/services/photo-id-v2/plant-engine.js
 * — L3, owner-approved catalog, no customer route yet; this lane's daily-cap
 * claim below is its only runtime caller today) over the just-uploaded
 * photos and stores the workup on the submission's own `read_result`
 * column. The customer NEVER sees this read — internal, technician-only,
 * same as the pest read.
 *
 * Trigger rule, mirroring the pest read's: the visit's service line
 * decides, via visit-prep-plant-applicability.js's plantSubjectForStop — a
 * stop whose live members include a strict lawn-only or tree & shrub-only
 * service type (never WDO, termite, or a Waves Assessment — those carry
 * neither token) is read for that subject; a stop that is ALSO a pest stop
 * (visit-prep-pest-applicability.js isPestStop) defers entirely to the
 * pest read — "pest wins" (own design decision, documented in
 * visit-prep-plant-applicability.js) — never both engines on one
 * submission. Anything else is 'unsupported': no engine call, no cap spent.
 *
 * Called from the SAME single place the pest read is: visit-prep.js's
 * createVisitPrepSubmission, fire-and-forget, AFTER the submission's own
 * transaction has already committed — see that module's header for why.
 * Every error here is caught and logged, exactly like the pest read: an
 * attempt that reached the engine ends 'failed', never stuck on 'pending';
 * one that never claimed a cap slot ends 'none'.
 *
 * Shared daily cap: this lane spends the SAME `VISIT_PREP_READ_DAILY_CAP`
 * (default 40) and the same locked claim the pest read does, through
 * visit-prep-read-claim.js — one count, one lock, never a second cap.
 *
 * Storage: `read_result` (jsonb, nullable, migration
 * 20260929080000_visit_prep_plant_read_result.js) holds
 * `{ v2, internal, subject_type }` directly on the submission row — no
 * second table, no FK; the pest read's `read_ref` column is untouched by
 * this lane. A single UPDATE on the owning row is therefore already atomic
 * (no two-table transaction like the pest read's insert-then-update needs).
 */

const db = require('../models/db');
const logger = require('./logger');
const PhotoService = require('./photos');
const { identifyPlantV2 } = require('./photo-id-v2/plant-engine');
const { visitPrepPlantReadLive } = require('../config/feature-gates');
const { plantSubjectForStop } = require('./visit-prep-plant-applicability');

// The daily cap and the locked claim are the SAME ones the pest read uses
// (visit-prep-read-claim.js): one cap across both engines.
const {
  claimReadSlot: claimSharedReadSlot, markUnclaimed, markUnsupported, dailyCap, etDayStart,
} = require('./visit-prep-read-claim');

// 'lawn' | 'tree_shrub' | 'unsupported'.
async function resolveApplicability(svc, conn) {
  return (await plantSubjectForStop(svc, conn)) || 'unsupported';
}

// Returns { claimed: true, subject } | 'unsupported' | 'refused'.
async function claimReadSlot(conn, submissionId, svc, now = new Date()) {
  const out = await claimSharedReadSlot(conn, submissionId, svc, {
    applicable: (stop, trx) => plantSubjectForStop(stop, trx),
    // read_result carries the engine marker from the claim on, so the tech
    // display can tell a plant read from a pest one (Codex #5320 r1 P2).
    // ...with the subject it was claimed for, so a pending lawn read on a
    // stop reclassified to tree & shrub is not shown (Codex #5320 r4).
    pendingPatch: (subject) => ({ read_result: JSON.stringify({ ...PLANT_MARKER, subject_type: subject }) }),
    now,
  });
  return out && out.claimed ? { claimed: true, subject: out.value } : out;
}

const PLANT_MARKER = Object.freeze({ engine: 'plant' });

async function setReadStatus(conn, submissionId, status, readResult = JSON.stringify(PLANT_MARKER)) {
  try {
    await conn('visit_prep_submissions').where({ id: submissionId }).update({
      read_status: status,
      read_result: readResult,
    });
  } catch (err) {
    logger.error(`[visit-prep-plant-read] failed to write read_status=${status} submission=${submissionId}: ${err.message}`);
  }
}

/**
 * @param {object} opts
 * @param {string} opts.submissionId        the just-committed visit_prep_submissions row id
 * @param {object} opts.svc                 the RECHECKED visit row (createVisitPrepSubmission's
 *                                           own `result.current`) — id, customer_id, service_type,
 *                                           visit_id, status
 * @param {Array<{s3Key:string, mimeType:string}>} opts.photos  the NEW photos this submission stored
 * @param {object} [opts.conn]               defaults to the global pool — same "never the write
 *                                            transaction" rule as the pest read.
 * @returns {Promise<void>} never throws — every failure is caught, logged, and written as
 *          read_status='failed' so the row never sticks on 'pending'.
 */
// Claims the daily slot and returns the plant subject, or settles every
// non-claimed outcome (another read holds the row, no longer a plant stop,
// cap refused, claim error) and returns null.
async function claimOrSettle(conn, submissionId, svc) {
  let claim;
  try {
    claim = await claimReadSlot(conn, submissionId, svc);
  } catch (err) {
    logger.error(`[visit-prep-plant-read] daily-cap claim failed submission=${submissionId}: ${err.message}`);
    await markUnclaimed(conn, submissionId, 'none', logger);
    return null;
  }
  if (claim && claim.claimed) return claim.subject;
  if (claim === 'taken') return null; // another read holds the row
  if (claim === 'unsupported') {
    await markUnsupported(conn, submissionId, logger);
    return null;
  }
  logger.warn(`[visit-prep-plant-read] daily cap (${dailyCap()}) reached — submission=${submissionId} not read, photos still delivered`);
  // 'none', not 'failed': a cap rejection never claimed a slot (see the
  // pest read's own comment on this).
  await markUnclaimed(conn, submissionId, 'none', logger);
  return null;
}

async function triggerVisitPrepPlantRead({
  submissionId, svc, photos, conn = db,
} = {}) {
  if (!submissionId || !svc?.id) return;
  if (!visitPrepPlantReadLive()) return; // gate off — leave read_status at its 'none' default
  if (!Array.isArray(photos) || photos.length === 0) return;

  let applicability;
  try {
    applicability = await resolveApplicability(svc, conn);
  } catch (err) {
    logger.error(`[visit-prep-plant-read] applicability check failed submission=${submissionId}: ${err.message}`);
    await markUnclaimed(conn, submissionId, 'none', logger);
    return;
  }

  if (applicability === 'unsupported') {
    await markUnsupported(conn, submissionId, logger);
    return;
  }

  // Photos BEFORE the daily-slot claim, same ordering rationale as the pest
  // read: a storage failure never reaches the engine and never holds a
  // slot, so it can't make an overlapping submission be refused at the cap
  // for a read that never happens.
  let loaded;
  try {
    loaded = await Promise.all(photos.map((p) => PhotoService.getPhotoBase64(p.s3Key)));
  } catch (err) {
    logger.error(`[visit-prep-plant-read] photo load failed for submission=${submissionId}: ${err.message}`);
    await markUnclaimed(conn, submissionId, 'none', logger);
    return;
  }

  const subject = await claimOrSettle(conn, submissionId, svc);
  if (!subject) return;

  let result;
  try {
    result = await identifyPlantV2({ photos: loaded, subject });
  } catch (err) {
    logger.error(`[visit-prep-plant-read] engine threw for submission=${submissionId}: ${err.message}`);
    await setReadStatus(conn, submissionId, 'failed');
    return;
  }

  if (!result.ok) {
    logger.warn(`[visit-prep-plant-read] engine miss (${result.reason}) submission=${submissionId}`);
    await setReadStatus(conn, submissionId, 'failed');
    return;
  }

  // A single UPDATE on the submission's own row is already atomic — unlike
  // the pest read, there is no second table to keep in step (see the
  // module header).
  try {
    await conn('visit_prep_submissions').where({ id: submissionId }).update({
      read_status: 'done',
      read_result: JSON.stringify({ ...PLANT_MARKER, v2: result.v2, internal: result.internal, subject_type: subject }),
    });
  } catch (err) {
    logger.error(`[visit-prep-plant-read] storing the read failed submission=${submissionId}: ${err.message}`);
    await setReadStatus(conn, submissionId, 'failed');
  }
}

module.exports = {
  triggerVisitPrepPlantRead,
  dailyCap,
  _internal: { resolveApplicability, etDayStart },
};
