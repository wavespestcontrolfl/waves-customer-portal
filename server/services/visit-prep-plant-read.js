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
 * (default 40) the pest read does — `readsToday` below counts every
 * `visit_prep_submissions` row in pending/done/failed regardless of which
 * engine produced it, and the claim below takes the EXACT SAME advisory
 * lock key (`CAP_LOCK_KEY`) the pest read's claimReadSlot does, so a pest
 * and a plant submission claiming at the same instant still serialize
 * against each other's count — a second cap was deliberately not added.
 * The claim/count logic itself is a small, deliberate duplication of
 * visit-prep-pest-read.js's own (rather than extracting a shared module)
 * to avoid touching that already-hardened lane (18+ Codex rounds) for a
 * ~30-line function; both modules must keep CAP_LOCK_KEY and the env var
 * name identical if either changes.
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
const { etDateString, parseETDateTime } = require('../utils/datetime-et');
const { plantSubjectForStop } = require('./visit-prep-plant-applicability');

const DEFAULT_DAILY_CAP = 40;

function dailyCap() {
  const value = Number(process.env.VISIT_PREP_READ_DAILY_CAP);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_DAILY_CAP;
}

// 'lawn' | 'tree_shrub' | 'unsupported'.
async function resolveApplicability(svc, conn) {
  return (await plantSubjectForStop(svc, conn)) || 'unsupported';
}

// Same America/New_York calendar day as the pest read's own etDayStart —
// kept as its own local copy rather than a shared import (see the module
// header's duplication note).
function etDayStart(now = new Date()) {
  return parseETDateTime(`${etDateString(now)}T00:00`);
}

async function readsToday(conn, now = new Date()) {
  const row = await conn('visit_prep_submissions')
    .whereIn('read_status', ['pending', 'done', 'failed'])
    .where('created_at', '>=', etDayStart(now))
    .count('id as count')
    .first();
  return Number(row?.count || 0);
}

// SAME lock key string as visit-prep-pest-read.js's own CAP_LOCK_KEY —
// deliberate: this is what makes the two engines share one cap under
// concurrent claims (see the module header). Not imported from that module
// (a shared constant would be the one part of this duplication worth
// extracting, but a stray edit to one copy without the other silently
// breaks the sharing either way, so both files carry a comment pointing at
// each other instead).
const CAP_LOCK_KEY = 'visit-prep-pest-read-cap';

// Returns { claimed: true, subject } | 'unsupported' (no longer a plant
// stop) | 'refused' (cap reached, or not a today submission).
async function claimReadSlot(conn, submissionId, svc, now = new Date()) {
  const { lockStopForRow } = require('./visit-groups');
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await conn.transaction(async (trx) => {
        if ((await lockStopForRow(trx, svc.id)) === null) return 'unsupported';
        const { techStopMemberIds } = require('./visit-prep');
        const members = await techStopMemberIds(svc, trx);
        await trx('scheduled_services').whereIn('id', [...new Set([svc.id, ...members])]).forShare().select('id');
        const subject = await plantSubjectForStop(svc, trx);
        if (!subject) return 'unsupported';
        // The cap lock last, held only for the count and the claim — the
        // SAME key the pest read's claim takes (see CAP_LOCK_KEY above).
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [CAP_LOCK_KEY]);
        const own = await trx('visit_prep_submissions').where({ id: submissionId }).first('created_at');
        if (!own || new Date(own.created_at) < etDayStart(now)) return 'refused';
        if (await readsToday(trx, now) >= dailyCap()) return 'refused';
        await trx('visit_prep_submissions').where({ id: submissionId }).update({ read_status: 'pending', read_result: null });
        return { claimed: true, subject };
      });
    } catch (err) {
      if (err && err.code === 'VISIT_STOP_MOVED' && attempt < 2) continue;
      if (err && err.code === 'VISIT_STOP_MOVED') return 'refused';
      throw err;
    }
  }
}

async function setReadStatus(conn, submissionId, status, readResult = null) {
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
    await setReadStatus(conn, submissionId, 'none');
    return;
  }

  if (applicability === 'unsupported') {
    await setReadStatus(conn, submissionId, 'unsupported');
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
    await setReadStatus(conn, submissionId, 'none');
    return;
  }

  let claim;
  try {
    claim = await claimReadSlot(conn, submissionId, svc);
  } catch (err) {
    logger.error(`[visit-prep-plant-read] daily-cap claim failed submission=${submissionId}: ${err.message}`);
    await setReadStatus(conn, submissionId, 'none');
    return;
  }
  if (claim === 'unsupported') {
    await setReadStatus(conn, submissionId, 'unsupported');
    return;
  }
  if (!claim || claim === 'refused' || !claim.claimed) {
    logger.warn(`[visit-prep-plant-read] daily cap (${dailyCap()}) reached — submission=${submissionId} not read, photos still delivered`);
    // 'none', not 'failed': a cap rejection never claimed a slot (see the
    // pest read's own comment on this).
    await setReadStatus(conn, submissionId, 'none');
    return;
  }

  let result;
  try {
    result = await identifyPlantV2({ photos: loaded, subject: claim.subject });
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
      read_result: JSON.stringify({ v2: result.v2, internal: result.internal, subject_type: claim.subject }),
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
