/**
 * Visit prep photos — the COMBINED read for a Lawn & Pest stop (owner ruling
 * 2026-09-30). A combined visit gets BOTH photo reads: the pest
 * identification (identifyPestV2, as visit-prep-pest-read.js) and the lawn /
 * tree & shrub workup (identifyPlantV2, as visit-prep-plant-read.js). Two
 * combo shapes reach here, both dispatched by visit-prep-read-dispatch.js
 * under the key 'combo:<subject>' (visit-prep-read-key.js):
 *   (a) a live member whose service_type is one COMBINED label
 *       ("Lawn Care + Pest Control", visit-prep-combo-types.js);
 *   (b) separate live pest-only AND lawn-only / tree & shrub-only members.
 * Only while BOTH gates are live; with one dark the key degrades to that one
 * engine alone and this module is never called.
 *
 * ONE claim of the submission's single read slot, ONE settle:
 * - Photos load once, the shared locked claim (visit-prep-read-claim.js) is
 *   taken once, WEIGHT 2 — the daily cap counts paid vision calls, and this
 *   read spends two — so read_attempts and the cap stay honest.
 * - Both engines run over the same photos, in parallel. Their prompts and
 *   validators are the engines' own (identifyPestV2, identifyPlantV2); nothing
 *   is duplicated here.
 * - The settle re-proves, under the stop lock, that the stop is STILL the same
 *   combo ('combo:<subject>'); otherwise the claim is released and the stop
 *   goes back to the dispatcher, exactly like the single engines.
 *
 * Storage (no migration; the row's one slot):
 * - read_ref: the pest part's pest_identifications row, as the pest read
 *   stores it (storeIdentification), written in the same transaction as
 *   read_status.
 * - read_result: { engine: 'combo', subject_type,
 *                  pest:  { status: 'done' | 'failed' },
 *                  plant: { status: 'done' | 'failed', v2?, internal? } }.
 *
 * PARTIAL FAILURE (design decision): one side failing never throws away the
 * other. If at least one part produced a result the row settles 'done' with
 * the other part marked status 'failed' inside read_result (the brief shows
 * the part that worked and stays quiet on the other, as a single failed read
 * would). Only when BOTH fail is the row 'failed'. The existing status model
 * therefore needs no new value, and the recovery sweep treats a partial combo
 * like any settled read: never retried on the same line (a retry would spend
 * two more paid calls), only a changed line re-reads it.
 *
 * Every error is caught and logged: a read that reached the engines ends
 * 'done' or 'failed', never stuck 'pending'; one that never claimed a slot
 * ends 'none'. Never throws.
 */

const db = require('../models/db');
const logger = require('./logger');
const PhotoService = require('./photos');
const { identifyPestV2 } = require('./photo-id-v2/pest-engine');
const { identifyPlantV2 } = require('./photo-id-v2/plant-engine');
const { visitPrepPestReadLive, visitPrepPlantReadLive } = require('../config/feature-gates');
const { storeIdentification } = require('./visit-prep-pest-read');
const {
  claimReadSlot: claimSharedReadSlot, redispatch, settleClaimedRead, markUnclaimed, markUnsupported, dailyCap,
  UNCLAIMED_STATUSES,
} = require('./visit-prep-read-claim');
const { currentReadKey, engineOfKey, subjectOfKey } = require('./visit-prep-read-key');

// A combo read spends two vision calls (pest + plant).
const COMBO_WEIGHT = 2;
const COMBO_MARKER = Object.freeze({ engine: 'combo' });

// The plant subject when the router's key for the stop NOW is a combo key
// ('lawn' | 'tree_shrub'); null otherwise (not this engine's stop).
async function comboApplicable(svc, conn) {
  const key = await currentReadKey(svc, conn);
  return engineOfKey(key) === 'combo' ? subjectOfKey(key) : null;
}

async function claimReadSlot(conn, submissionId, svc, { now = new Date(), expectStatus } = {}) {
  const out = await claimSharedReadSlot(conn, submissionId, svc, {
    applicable: comboApplicable,
    // The engine marker and subject ride read_result from the claim on (like
    // the plant read), so a pending combo read is recognised as one.
    pendingPatch: (subject) => ({ read_ref: null, read_result: JSON.stringify({ ...COMBO_MARKER, subject_type: subject }) }),
    weight: COMBO_WEIGHT,
    now,
    ...(expectStatus ? { expectStatus } : {}),
  });
  return out && out.claimed ? { claimed: true, subject: out.value } : out;
}

function nextDispatch({ submissionId, svc, photos, conn, dispatches }) {
  return { submissionId, svc, photos, conn, dispatches };
}

// Claims the slot and returns { subject }, or settles every non-claimed
// outcome and returns { outcome } ('taken', 'unsupported' — back to the
// dispatcher —, 'capped', 'error').
async function claimOrSettle(args) {
  const { submissionId, svc, conn, expectStatus } = args;
  let claim;
  try {
    claim = await claimReadSlot(conn, submissionId, svc, { expectStatus });
  } catch (err) {
    logger.error(`[visit-prep-combo-read] daily-cap claim failed submission=${submissionId}: ${err.message}`);
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
  logger.warn(`[visit-prep-combo-read] daily cap (${dailyCap()}) cannot fit a two-call read — submission=${submissionId} not read, photos still delivered`);
  await markUnclaimed(conn, submissionId, 'none', logger, expectStatus);
  return { outcome: 'capped' };
}

// Runs one engine, never throwing: an engine error is a miss for that part.
async function runPart(name, submissionId, run) {
  try {
    const result = await run();
    if (!result?.ok && result?.reason) logger.warn(`[visit-prep-combo-read] ${name} engine miss (${result.reason}) submission=${submissionId}`);
    return result?.ok ? result : { ok: false };
  } catch (err) {
    logger.error(`[visit-prep-combo-read] ${name} engine threw for submission=${submissionId}: ${err.message}`);
    return { ok: false };
  }
}

/**
 * Called by visit-prep-read-dispatch.js, which already chose this engine for
 * the stop; the claim re-proves it under the stop lock.
 * @returns {Promise<'done'|'failed'|'error'|'capped'|'unsupported'|'taken'|'changed'|'skipped'>}
 */
async function triggerVisitPrepComboRead({
  submissionId, svc, photos, conn = db, expectStatus = UNCLAIMED_STATUSES, dispatches = 1,
} = {}) {
  if (!submissionId || !svc?.id) return 'skipped';
  // Both gates, or not at all: the dispatcher degrades a one-gate combo to
  // the single live engine.
  if (!visitPrepPestReadLive() || !visitPrepPlantReadLive()) return 'skipped';
  if (!Array.isArray(photos) || photos.length === 0) return 'skipped';
  const args = { submissionId, svc, photos, conn, expectStatus, dispatches };

  // Photos BEFORE the claim (a storage failure never holds a slot), loaded
  // once for both engines.
  let loaded;
  try {
    loaded = await Promise.all(photos.map((p) => PhotoService.getPhotoBase64(p.s3Key)));
  } catch (err) {
    logger.error(`[visit-prep-combo-read] photo load failed for submission=${submissionId}: ${err.message}`);
    await markUnclaimed(conn, submissionId, 'none', logger, expectStatus);
    return 'error';
  }

  const claim = await claimOrSettle(args);
  if (!claim.subject) return claim.outcome;
  const { subject } = claim;

  const [pest, plant] = await Promise.all([
    runPart('pest', submissionId, () => identifyPestV2(loaded)),
    runPart('plant', submissionId, () => identifyPlantV2({ photos: loaded, subject })),
  ]);
  return settle(args, subject, { pest, plant });
}

function resultJson(subject, { pest, plant }) {
  return JSON.stringify({
    ...COMBO_MARKER,
    subject_type: subject,
    pest: { status: pest.ok ? 'done' : 'failed' },
    plant: plant.ok
      ? { status: 'done', v2: plant.v2, internal: plant.internal }
      : { status: 'failed' },
  });
}

// Done (at least one part) or failed (both), stored only if the stop is still
// THIS combo now that the engines are back; otherwise the claim is released
// and the stop goes back to the dispatcher. A done row's pest identification
// and the row's read_status/read_ref/read_result commit together, so a paid
// pest read is never orphaned with the row left pending.
async function settle(args, subject, parts) {
  const { submissionId, svc, conn } = args;
  const { pest, plant } = parts;
  const anyOk = pest.ok || plant.ok;
  const failedResult = JSON.stringify({
    ...COMBO_MARKER, subject_type: subject, pest: { status: 'failed' }, plant: { status: 'failed' },
  });
  try {
    const settled = await settleClaimedRead(conn, submissionId, svc, {
      applicable: comboApplicable,
      matches: (now) => now === subject,
      store: async (trx) => {
        if (!anyOk) {
          await trx('visit_prep_submissions').where({ id: submissionId })
            .update({ read_status: 'failed', read_ref: null, read_result: failedResult });
          return;
        }
        const readRef = pest.ok ? await storeIdentification(trx, { svc, submissionId, result: pest }) : null;
        await trx('visit_prep_submissions').where({ id: submissionId })
          .update({ read_status: 'done', read_ref: readRef, read_result: resultJson(subject, parts) });
      },
    });
    if (settled === 'changed') {
      logger.warn(`[visit-prep-combo-read] stop changed during the read — re-dispatching submission=${submissionId}`);
      redispatch(nextDispatch(args), logger);
      return 'changed';
    }
    return anyOk ? 'done' : 'failed';
  } catch (err) {
    logger.error(`[visit-prep-combo-read] storing the read failed submission=${submissionId}: ${err.message}`);
    try {
      await conn('visit_prep_submissions').where({ id: submissionId, read_status: 'pending' })
        .update({ read_status: 'failed', read_ref: null, read_result: failedResult });
    } catch (writeErr) {
      logger.error(`[visit-prep-combo-read] failed to write read_status=failed submission=${submissionId}: ${writeErr.message}`);
    }
    return 'failed';
  }
}

module.exports = {
  triggerVisitPrepComboRead,
  COMBO_WEIGHT,
  dailyCap,
  _internal: { comboApplicable, resultJson },
};
