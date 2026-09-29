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
 *   dispatchVisitPrepRead once; it picks the engine for the stop as it is
 *   NOW — pest wins (visit-prep-plant-applicability.js), then lawn / tree &
 *   shrub — among the engines whose gate is live, and runs only that one.
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
const { isPestStop } = require('./visit-prep-pest-applicability');
const { plantSubjectForStop } = require('./visit-prep-plant-applicability');
const { markUnclaimed, UNCLAIMED_STATUSES } = require('./visit-prep-read-claim');

const MAX_DISPATCHES = 3;

// The read the stop wants as it is now, among live engines: 'pest',
// 'plant:lawn', 'plant:tree_shrub', or null. plantSubjectForStop is null for
// any pest stop ("pest wins"), so a pest stop with only the plant gate live
// is never read by the plant engine.
async function currentReadKey(svc, conn, { pestLive, plantLive }) {
  if (pestLive && await isPestStop(svc, conn)) return 'pest';
  const subject = plantLive ? await plantSubjectForStop(svc, conn) : null;
  return subject ? `plant:${subject}` : null;
}

// The read a finished row holds, in the same terms: a plant read carries
// its engine marker and subject in read_result; anything else is pest.
function storedReadKey(readResult) {
  let parsed = readResult;
  if (typeof readResult === 'string') {
    try { parsed = JSON.parse(readResult); } catch { parsed = null; }
  }
  return parsed?.engine === 'plant' ? `plant:${parsed.subject_type}` : 'pest';
}

// 'pest' | 'plant' | null for the stop as it is now, among live engines.
async function chooseEngine(svc, conn, live) {
  const key = await currentReadKey(svc, conn, live);
  return key ? key.split(':')[0] : null;
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
  await markUnclaimed(conn, submissionId, 'unsupported', logger, expectStatus);
  return 'unsupported';
}

module.exports = { dispatchVisitPrepRead, MAX_DISPATCHES, _internal: { chooseEngine, currentReadKey, storedReadKey } };
