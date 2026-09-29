/**
 * Visit prep photos — automatic pest read (PR 5, GATE_VISIT_PREP_PEST_READ,
 * dark). Second-order feature on top of PR 1's visit-prep foundation
 * (services/visit-prep.js): when a customer sends photos for a pest visit,
 * this runs the SAME pest v2 engine the app's
 * Photo ID route calls (identifyPestV2, server/routes/photo-id.js ~line
 * 477) over the just-uploaded photos and stores the result in
 * `pest_identifications` with `source = 'visit_prep'`, `mode = 'internal'`
 * — already an allowed mode, no migration needed on that table (verified in
 * production, scope doc §5.3). Internal mode keeps the read out of the
 * customer's own Photo ID history and the prospect funnel; the customer
 * NEVER sees this read.
 *
 * Trigger rule (owner delta on scope doc §5.3 — the topic chips were
 * removed): the visit's service line decides. A stop whose live members
 * include a pest-only service (pest-production-calibration.js
 * isPestOnlyServiceType — never a WDO inspection or assessment; members from
 * visit-prep.js techStopMemberIds) is read; anything else is
 * 'unsupported' — no engine call, no cap spent. Lawn and tree & shrub have
 * no engine yet (scope doc §5.3, "being rebuilt").
 *
 * Called from visit-prep.js's createVisitPrepSubmission — the ONE place a
 * submission is created, never from a route — so every entry point (the
 * public appointment-page POST today, the upcoming customer-auth app
 * route) inherits this for free. Always invoked AFTER that submission's
 * own transaction has already committed, fire-and-forget: the caller does
 * `void triggerVisitPrepPestRead(...)` and never awaits it, so a slow or
 * failing vision call can never add latency to, or fail, the customer's
 * upload response. Every error here is caught and logged: an attempt that
 * reached the engine ends 'failed', never stuck on 'pending'; one that never
 * claimed a cap slot ends 'none'.
 *
 * Own daily cap, `VISIT_PREP_READ_DAILY_CAP` (default 40, env, read fresh
 * per call) — separate from the app Photo ID route's own per-customer/
 * shared budgets. A capped submission never blocks: the photos still reach
 * the technician, only the read line is withheld (read_status 'none').
 */

const db = require('../models/db');
const logger = require('./logger');
const PhotoService = require('./photos');
const { identifyPestV2 } = require('./photo-id-v2/pest-engine');
const { visitPrepPestReadLive } = require('../config/feature-gates');

// The daily cap and the locked claim are shared with every visit-prep read
// engine (visit-prep-read-claim.js).
const {
  claimReadSlot: claimSharedReadSlot, handOff, markUnclaimed, markUnsupported, dailyCap, etDayStart,
} = require('./visit-prep-read-claim');
const { isPestStop, liveStopServiceTypes } = require('./visit-prep-pest-applicability');


// The read follows the VISIT's service line only. The appointment page and
// app no longer ask for a topic (owner 2026-09-28), so a topic on the row is
// not an input here, and a resubmit that edits it changes nothing
// (Codex #5305 r1 P2).
async function resolveApplicability(svc, conn) {
  return (await isPestStop(svc, conn)) ? 'pest' : 'unsupported';
}

// Returns 'claimed', 'unsupported' (no longer a pest stop) or 'refused'
// (cap reached, or not a today submission).
async function claimReadSlot(conn, submissionId, svc, now = new Date()) {
  const out = await claimSharedReadSlot(conn, submissionId, svc, {
    applicable: (stop, trx) => isPestStop(stop, trx),
    pendingPatch: { read_ref: null, read_result: null },
    now,
  });
  return out && out.claimed ? 'claimed' : out;
}

async function setReadStatus(conn, submissionId, status, readRef = null) {
  try {
    await conn('visit_prep_submissions').where({ id: submissionId }).update({
      read_status: status,
      read_ref: readRef,
    });
  } catch (err) {
    logger.error(`[visit-prep-pest-read] failed to write read_status=${status} submission=${submissionId}: ${err.message}`);
  }
}

// Loads every photo's bytes from S3 (PhotoService.getPhotoBase64 — the ONE
// reader for this bucket's pixels, same helper the tech thumbnails and
// admin resize paths use) and hands them to identifyPestV2 in the exact
// `{ data, mimeType }` shape it already consumes from the app's Photo ID
// route.

// Insert the read into pest_identifications — mode='internal' (keeps it out
// of the customer's own history + the prospect funnel), source='visit_prep'
// (no CHECK constraint on this column; both verified in production, scope
// doc §5.3). Stores the SAME v1+v2 combined JSON shape photo-id.js's
// handlePest stores for a customer's own Photo ID submission, so the fixed
// fields previsit-brief.js reads back (readFactsFromContract in
// visit-prep.js) come from one well-tested shape.
async function storeIdentification(conn, { svc, submissionId, result }) {
  const { v1, v2, internal } = result;
  const row = await conn('pest_identifications').insert({
    mode: 'internal',
    status: 'analyzed',
    source: 'visit_prep',
    customer_id: svc.customer_id,
    report_contract: JSON.stringify({ ...v1.report_contract, v2 }),
    category: v1.report_contract?.identification?.category || null,
    species_slug: v1.species_slug || null,
    service_line: v1.service_line || null,
    urgency: v1.urgency || null,
    ai_summary: (v1.report_contract?.observations || []).join(' ').slice(0, 2000) || null,
    ai_analysis: JSON.stringify({ engine: 'v2', internal, visit_prep_submission_id: submissionId }),
  }).returning('id');
  return row[0]?.id || row[0];
}

/**
 * @param {object} opts
 * @param {string} opts.submissionId        the just-committed visit_prep_submissions row id
 * @param {object} opts.svc                 the RECHECKED visit row (createVisitPrepSubmission's
 *                                           own `result.current`) — id, customer_id, service_type,
 *                                           visit_id, status
 * @param {Array<{s3Key:string, mimeType:string}>} opts.photos  the NEW photos this submission stored
 * @param {object} [opts.conn]               defaults to the global pool — this ALWAYS runs after
 *                                            the write transaction has already committed, so it
 *                                            must never be handed that transaction (a caller
 *                                            passing one is a bug: it would hold the connection
 *                                            open across a network vision call).
 * @returns {Promise<void>} never throws — every failure is caught, logged, and written as
 *          read_status='failed' so the row never sticks on 'pending'.
 */
async function triggerVisitPrepPestRead({
  submissionId, svc, photos, conn = db, handedOff = false,
} = {}) {
  if (!submissionId || !svc?.id) return;
  if (!visitPrepPestReadLive()) return; // gate off — leave read_status at its 'none' default
  if (!Array.isArray(photos) || photos.length === 0) return;
  // Not this engine's stop: settle 'unsupported' and hand the photos to the
  // other engine once — a service-line change can make both see "not mine"
  // (Codex #5320 r7 P2). The target re-checks its own gate and applicability.
  const settleUnsupported = async () => {
    await markUnsupported(conn, submissionId, logger);
    if (!handedOff) handOff('./visit-prep-plant-read', 'triggerVisitPrepPlantRead', { submissionId, svc, photos, conn }, logger);
  };

  let applicability;
  try {
    applicability = await resolveApplicability(svc, conn);
  } catch (err) {
    logger.error(`[visit-prep-pest-read] applicability check failed submission=${submissionId}: ${err.message}`);
    // Never reached the engine: 'none', so it never counts against the cap.
    await markUnclaimed(conn, submissionId, 'none', logger);
    return;
  }

  if (applicability === 'unsupported') {
    await settleUnsupported();
    return;
  }

  // Photos BEFORE the daily-slot claim: a storage failure never reaches the
  // engine and never holds a slot, so it can't make an overlapping
  // submission be refused at the cap for a read that never happens
  // (Codex #5305 r8, r17 P2).
  let loaded;
  try {
    loaded = await Promise.all(photos.map((p) => PhotoService.getPhotoBase64(p.s3Key)));
  } catch (err) {
    logger.error(`[visit-prep-pest-read] photo load failed for submission=${submissionId}: ${err.message}`);
    await markUnclaimed(conn, submissionId, 'none', logger);
    return;
  }

  let claimed;
  try {
    claimed = await claimReadSlot(conn, submissionId, svc);
  } catch (err) {
    logger.error(`[visit-prep-pest-read] daily-cap claim failed submission=${submissionId}: ${err.message}`);
    await markUnclaimed(conn, submissionId, 'none', logger);
    return;
  }
  if (claimed === 'taken') return; // another read holds the row
  if (claimed === 'unsupported') {
    await settleUnsupported();
    return;
  }
  if (claimed !== 'claimed') {
    logger.warn(`[visit-prep-pest-read] daily cap (${dailyCap()}) reached — submission=${submissionId} not read, photos still delivered`);
    // 'none', not 'failed': a cap rejection never claimed a slot, so it
    // must not hold the count up if the cap is raised the same day
    // (Codex #5305 r1 P2). The tech sees no read line either way.
    await markUnclaimed(conn, submissionId, 'none', logger);
    return;
  }

  let result;
  try {
    result = await identifyPestV2(loaded);
  } catch (err) {
    logger.error(`[visit-prep-pest-read] engine threw for submission=${submissionId}: ${err.message}`);
    await setReadStatus(conn, submissionId, 'failed');
    return;
  }

  if (!result.ok) {
    logger.warn(`[visit-prep-pest-read] engine miss (${result.reason}) submission=${submissionId}`);
    await setReadStatus(conn, submissionId, 'failed');
    return;
  }

  // The identification and the submission's done/read_ref commit together
  // (Codex #5305 r5): never an orphaned paid read with the row left pending.
  try {
    await conn.transaction(async (trx) => {
      const readRef = await storeIdentification(trx, { svc, submissionId, result });
      await trx('visit_prep_submissions').where({ id: submissionId }).update({ read_status: 'done', read_ref: readRef });
    });
  } catch (err) {
    logger.error(`[visit-prep-pest-read] storing the read failed submission=${submissionId}: ${err.message}`);
    await setReadStatus(conn, submissionId, 'failed');
  }
}

module.exports = {
  triggerVisitPrepPestRead,
  dailyCap,
  _internal: { isPestStop, resolveApplicability, liveStopServiceTypes, etDayStart },
};
