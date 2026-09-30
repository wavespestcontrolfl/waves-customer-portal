/**
 * Visit prep reads — the ONE place that decides which read engine a
 * submission goes to (Codex #5320 r9).
 *
 * The pest read (visit-prep-pest-read.js) and the lawn / tree & shrub read
 * (visit-prep-plant-read.js) used to be scheduled side by side, each
 * deciding for itself whether the stop was its own. That made every upload
 * download the photos twice once both gates were on, and a stop that
 * changed line mid-read needed engine-to-engine hand-offs that kept growing
 * new gaps. Now:
 *
 * - createVisitPrepSubmission (and the recovery sweep) call
 *   dispatchVisitPrepRead once; it picks the read for the stop as it is NOW
 *   (visit-prep-read-key.js) among the engines whose gate is live, and runs
 *   only that one:
 *     'pest' | 'plant:<subject>' | 'combo:<subject>'.
 *   A combined Lawn & Pest stop (one combined service_type, or separate pest
 *   and lawn / tree & shrub members) gets BOTH reads under one claim
 *   ('combo:<subject>', visit-prep-combo-read.js) while both gates are live
 *   (owner ruling 2026-09-30, replacing "pest wins, never both"); with one
 *   gate dark it degrades to the one live engine.
 * - Each engine still re-proves applicability under the stop lock at the
 *   claim and again before settling (visit-prep-read-claim.js), and any
 *   "not this read's stop any more" outcome comes back HERE through
 *   redispatch(), never to the sibling engine.
 * - MAX_DISPATCHES bounds how often one submission can bounce while its stop
 *   keeps changing; past it the row stays unclaimed ('none'/'unsupported')
 *   for the recovery sweep.
 *
 * A stop no live engine reads is marked 'unsupported' (unclaimed, no cap
 * spent). Never throws: an upload must never fail because of a read.
 */

const db = require('../models/db');
const logger = require('./logger');
const { visitPrepPestReadLive, visitPrepPlantReadLive } = require('../config/feature-gates');
const {
  currentReadKey, storedReadKey, engineOfKey,
} = require('./visit-prep-read-key');
const { markUnclaimed, UNCLAIMED_STATUSES } = require('./visit-prep-read-claim');

const MAX_DISPATCHES = 3;

// 'pest' | 'plant' | 'combo' | null for the stop as it is now, among live
// engines.
async function chooseEngine(svc, conn, live) {
  return engineOfKey(await currentReadKey(svc, conn, live));
}

/**
 * @param {object} opts
 * @param {string} opts.submissionId
 * @param {object} opts.svc      the visit row ({ id, visit_id, service_type, ... })
 * @param {Array<{s3Key:string, mimeType:string}>} opts.photos
 * @param {object} [opts.conn]   never the upload's own transaction (the engines
 *                                hold no transaction across a vision call)
 * @param {string[]} [opts.expectStatus]  statuses the read may start from
 *                                (the recovery sweep passes the one it found)
 * @param {number} [opts.dispatches]  how many times this submission was dispatched
 * @returns {Promise<'done'|'failed'|'error'|'capped'|'unsupported'|'taken'|'changed'|'skipped'|'exhausted'>}
 */
async function dispatchVisitPrepRead({
  submissionId, svc, photos, conn = db, expectStatus = UNCLAIMED_STATUSES, dispatches = 0,
} = {}) {
  if (!submissionId || !svc?.id || !Array.isArray(photos) || photos.length === 0) return 'skipped';
  const pestLive = visitPrepPestReadLive();
  const plantLive = visitPrepPlantReadLive();
  if (!pestLive && !plantLive) return 'skipped'; // both gates off — leave read_status alone
  if (dispatches >= MAX_DISPATCHES) {
    logger.warn(`[visit-prep-read] stop kept changing — submission=${submissionId} left for the recovery sweep`);
    return 'exhausted';
  }

  let engine;
  try {
    engine = await chooseEngine(svc, conn, { pestLive, plantLive });
  } catch (err) {
    logger.error(`[visit-prep-read] applicability check failed submission=${submissionId}: ${err.message}`);
    await markUnclaimed(conn, submissionId, 'none', logger, expectStatus);
    return 'error';
  }

  const args = { submissionId, svc, photos, conn, expectStatus, dispatches: dispatches + 1 };
  if (engine === 'pest') return require('./visit-prep-pest-read').triggerVisitPrepPestRead(args);
  if (engine === 'plant') return require('./visit-prep-plant-read').triggerVisitPrepPlantRead(args);
  if (engine === 'combo') return require('./visit-prep-combo-read').triggerVisitPrepComboRead(args);
  await markUnclaimed(conn, submissionId, 'unsupported', logger, expectStatus);
  return 'unsupported';
}

module.exports = { dispatchVisitPrepRead, MAX_DISPATCHES, _internal: { chooseEngine, currentReadKey, storedReadKey } };
