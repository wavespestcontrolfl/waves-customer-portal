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
 * decides, via visit-prep-read-key.js — a stop whose live members include a
 * strict lawn-only or tree & shrub-only service type (never WDO, termite, or
 * a Waves Assessment — those carry neither token) is read for that subject.
 * A stop that is ALSO a pest stop (a combined Lawn & Pest label, or separate
 * pest and lawn members) gets BOTH reads under one claim from
 * visit-prep-combo-read.js while both gates are live (owner ruling
 * 2026-09-30, replacing "pest wins, never both"); this engine reads such a
 * stop alone only while the pest gate is dark. Anything else is
 * 'unsupported': no engine call, no cap spent.
 *
 * Dispatched by visit-prep-read-dispatch.js — the ONE place that picks an
 * engine for a submission (from createVisitPrepSubmission, fire-and-forget
 * after the submission's own transaction commits, and from the recovery
 * sweep). Every error here is caught and logged: an attempt that reached
 * the engine ends 'done' or 'failed', never stuck on 'pending'; one that
 * never claimed a cap slot ends 'none'.
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
const { currentReadKey, engineOfKey, subjectOfKey } = require('./visit-prep-read-key');

// The daily cap and the locked claim are the SAME ones the pest read uses
// (visit-prep-read-claim.js): one cap across both engines.
const {
  claimReadSlot: claimSharedReadSlot, redispatch, settleClaimedRead, markUnclaimed, markUnsupported, dailyCap, etDayStart,
  UNCLAIMED_STATUSES,
} = require('./visit-prep-read-claim');

// 'lawn' | 'tree_shrub' when the router's key for the stop, with the gates as
// they are NOW, is this engine's own 'plant:<subject>' (a combined lawn +
// pest stop with both gates live is the combo read's instead; a stop with a
// pest part and the pest gate dark is read here alone); null otherwise.
async function plantApplicable(svc, conn) {
  const key = await currentReadKey(svc, conn);
  return engineOfKey(key) === 'plant' ? subjectOfKey(key) : null;
}

// 'lawn' | 'tree_shrub' | 'unsupported'.
async function resolveApplicability(svc, conn) {
  return (await plantApplicable(svc, conn)) || 'unsupported';
}

// Returns { claimed: true, subject } | 'unsupported' | 'refused'.
async function claimReadSlot(conn, submissionId, svc, { now = new Date(), expectStatus } = {}) {
  const out = await claimSharedReadSlot(conn, submissionId, svc, {
    applicable: plantApplicable,
    // read_result carries the engine marker from the claim on, so the tech
    // display can tell a plant read from a pest one (Codex #5320 r1 P2).
    // ...with the subject it was claimed for, so a pending lawn read on a
    // stop reclassified to tree & shrub is not shown (Codex #5320 r4).
    pendingPatch: (subject) => ({ read_result: JSON.stringify({ ...PLANT_MARKER, subject_type: subject }) }),
    now,
    ...(expectStatus ? { expectStatus } : {}),
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

// Claims the daily slot and returns the plant subject, or settles every
// non-claimed outcome and returns its outcome string: 'taken' (another read
// holds the row), 'unsupported' (not a plant stop under the lock — back to
// the dispatcher), 'capped', or 'error'.
async function claimOrSettle(args) {
  const { submissionId, svc, conn, expectStatus } = args;
  let claim;
  try {
    claim = await claimReadSlot(conn, submissionId, svc, { expectStatus });
  } catch (err) {
    logger.error(`[visit-prep-plant-read] daily-cap claim failed submission=${submissionId}: ${err.message}`);
    await markUnclaimed(conn, submissionId, 'none', logger, expectStatus);
    return { outcome: 'error' };
  }
  if (claim && claim.claimed) return { subject: claim.subject };
  if (claim === 'taken') return { outcome: 'taken' };
  if (claim === 'unsupported') {
    await markUnsupported(conn, submissionId, logger, expectStatus);
    redispatch(nextDispatch(args), logger);
    return { outcome: 'unsupported' };
  }
  logger.warn(`[visit-prep-plant-read] daily cap (${dailyCap()}) reached — submission=${submissionId} not read, photos still delivered`);
  // 'none', not 'failed': a cap rejection never claimed a slot (see the
  // pest read's own comment on this).
  await markUnclaimed(conn, submissionId, 'none', logger, expectStatus);
  return { outcome: 'capped' };
}

// A re-dispatch starts from whatever unclaimed status the row is in now.
function nextDispatch({ submissionId, svc, photos, conn, dispatches }) {
  return { submissionId, svc, photos, conn, dispatches };
}

/**
 * Called by visit-prep-read-dispatch.js, which already chose this engine
 * for the stop; the claim re-proves it under the stop lock.
 *
 * @param {object} opts
 * @param {string} opts.submissionId        the just-committed visit_prep_submissions row id
 * @param {object} opts.svc                 the visit row — id, customer_id, service_type,
 *                                           visit_id, status
 * @param {Array<{s3Key:string, mimeType:string}>} opts.photos  the NEW photos this submission stored
 * @param {object} [opts.conn]               defaults to the global pool — same "never the write
 *                                            transaction" rule as the pest read.
 * @param {string[]} [opts.expectStatus]     statuses the claim may start from
 * @param {number} [opts.dispatches]         carried back to the dispatcher on a re-dispatch
 * @returns {Promise<'done'|'failed'|'error'|'capped'|'unsupported'|'taken'|'changed'|'skipped'>}
 *          never throws — every failure is caught, logged, and settled.
 */
async function triggerVisitPrepPlantRead({
  submissionId, svc, photos, conn = db, expectStatus = UNCLAIMED_STATUSES, dispatches = 1,
} = {}) {
  if (!submissionId || !svc?.id) return 'skipped';
  if (!visitPrepPlantReadLive()) return 'skipped'; // gate off — leave read_status alone
  if (!Array.isArray(photos) || photos.length === 0) return 'skipped';
  const args = { submissionId, svc, photos, conn, expectStatus, dispatches };

  // Photos BEFORE the daily-slot claim, same ordering rationale as the pest
  // read: a storage failure never reaches the engine and never holds a
  // slot, so it can't make an overlapping submission be refused at the cap
  // for a read that never happens.
  let loaded;
  try {
    loaded = await Promise.all(photos.map((p) => PhotoService.getPhotoBase64(p.s3Key)));
  } catch (err) {
    logger.error(`[visit-prep-plant-read] photo load failed for submission=${submissionId}: ${err.message}`);
    await markUnclaimed(conn, submissionId, 'none', logger, expectStatus);
    return 'error';
  }

  const claim = await claimOrSettle(args);
  if (!claim.subject) return claim.outcome;
  const { subject } = claim;

  let result;
  try {
    result = await identifyPlantV2({ photos: loaded, subject });
  } catch (err) {
    logger.error(`[visit-prep-plant-read] engine threw for submission=${submissionId}: ${err.message}`);
    result = { ok: false };
  }
  if (!result.ok && result.reason) logger.warn(`[visit-prep-plant-read] engine miss (${result.reason}) submission=${submissionId}`);
  return settle(args, subject, result);
}

// Done or failed, stored only if the stop is still a `subject` stop now
// that the engine is back; otherwise the claim is released and the stop
// goes back to the dispatcher (Codex #5320 r8, r9).
async function settle(args, subject, result) {
  const { submissionId, svc, conn } = args;
  const patch = result.ok
    ? { read_status: 'done', read_result: JSON.stringify({ ...PLANT_MARKER, v2: result.v2, internal: result.internal, subject_type: subject }) }
    : { read_status: 'failed', read_result: JSON.stringify({ ...PLANT_MARKER, subject_type: subject }) };
  try {
    const settled = await settleClaimedRead(conn, submissionId, svc, {
      applicable: plantApplicable,
      matches: (now) => now === subject,
      store: (trx) => trx('visit_prep_submissions').where({ id: submissionId }).update(patch),
    });
    if (settled === 'changed') {
      logger.warn(`[visit-prep-plant-read] stop changed during the read — re-dispatching submission=${submissionId}`);
      redispatch(nextDispatch(args), logger);
      return 'changed';
    }
    return result.ok ? 'done' : 'failed';
  } catch (err) {
    logger.error(`[visit-prep-plant-read] storing the read failed submission=${submissionId}: ${err.message}`);
    await setReadStatus(conn, submissionId, 'failed', JSON.stringify({ ...PLANT_MARKER, subject_type: subject }));
    return 'failed';
  }
}

module.exports = {
  triggerVisitPrepPlantRead,
  dailyCap,
  _internal: { resolveApplicability, etDayStart },
};
