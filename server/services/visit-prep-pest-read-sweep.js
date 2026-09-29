/**
 * Visit prep photos — pest read RECOVERY SWEEP (GATE_VISIT_PREP_READ_SWEEP,
 * dark). Second-order lane on top of PR 5 (services/visit-prep-pest-read.js):
 * the in-process fire-and-forget trigger there is never retried today, so
 * three classes of `visit_prep_submissions` rows can be stuck with a read
 * that never happened, never finished, or is now stale:
 *
 *   (a) read_status 'pending' left stuck by a crash/redeploy mid-read —
 *       stale past the SAME 15-minute threshold the tech display already
 *       treats as failed (visit-prep.js effectiveReadStatus /
 *       READ_PENDING_STALE_MS — reused here, not reimplemented);
 *   (b) read_status 'none' after a photo-load (S3) failure, a claim error,
 *       or a VISIT_STOP_MOVED refusal — the read was never even attempted;
 *   (c) read_status 'unsupported' where the stop has since become a pest
 *       stop (office reclassified Lawn -> Pest after the photos arrived).
 *
 * A 15-minute cron tick (scheduler.js) reruns triggerVisitPrepPestRead for
 * up to SWEEP_BATCH_LIMIT candidate rows per tick — the SAME trigger the
 * original submission calls (services/visit-prep-pest-read.js), so every
 * claim/cap/engine rule stays in exactly one place; this module never
 * touches pest_identifications, the stop lock, or the daily-cap count
 * directly. 'failed' rows are NEVER retried — an engine error already cost
 * a paid vision call, and retrying it is how a retry storm starts.
 *
 * Candidates: submissions created in the last CANDIDATE_WINDOW_MS whose
 * visit is still upcoming (scheduled_date >= today ET) and not
 * join-ineligible (visit-context/statuses.js JOIN_INELIGIBLE_STATUSES —
 * terminal statuses plus 'rescheduled'). Case (c) additionally requires the
 * stop to be a pest stop RIGHT NOW (visit-prep-pest-applicability.js
 * isPestStop) — the trigger re-checks this itself under the stop lock, so
 * this is only a pre-filter for which rows are worth attempting at all.
 *
 * At most ONE sweep retry per row per case: a `visit_prep_read_sweep_attempt`
 * activity_log row is written (metadata.submissionId + metadata.case)
 * BEFORE the retry runs, the same idempotency-marker pattern
 * call-reschedule-apply.js uses on the same table — so a row whose retry
 * lands right back in the SAME case (the cap still refuses it, the stop is
 * still not pest, …) is never picked up again by a later tick. Deliberately
 * no migration: activity_log already exists for exactly this "did we
 * already try this?" bookkeeping, and its jsonb metadata is queried the
 * same way elsewhere in this repo (call-commitments-watchdog.js,
 * dispatch-alerts.js).
 */

const db = require('../models/db');
const logger = require('./logger');
const { triggerVisitPrepPestRead } = require('./visit-prep-pest-read');
const { isPestStop } = require('./visit-prep-pest-applicability');
const { visitPrepReadSweepLive } = require('../config/feature-gates');
const { JOIN_INELIGIBLE_STATUSES } = require('./visit-context/statuses');
const { etDateString } = require('../utils/datetime-et');
// The tech display's own "is a pending read stale?" rule — reused so
// "stale" means exactly the same thing here as it does on the Visit Brief.
const { effectiveReadStatus } = require('./visit-prep')._internal;

const SWEEP_ACTION = 'visit_prep_read_sweep_attempt';
const CANDIDATE_WINDOW_MS = 72 * 60 * 60 * 1000;
// Same value as visit-prep.js's READ_PENDING_STALE_MS (not exported as a
// bare constant, so effectiveReadStatus is reused directly for case (a);
// this is the buffer applied to case (b) 'none' rows so the sweep never
// races the original submission's own in-flight, fire-and-forget trigger).
const NONE_MIN_AGE_MS = 15 * 60 * 1000;
const SWEEP_BATCH_LIMIT = 10;

const SWEEP_CASE = {
  STALE_PENDING: 'stale_pending',
  NONE_RETRY: 'none_retry',
  RECLASSIFIED_PEST: 'reclassified_pest',
};

async function loadPhotos(conn, submissionId) {
  const rows = await conn('visit_prep_photos').where({ submission_id: submissionId }).select('s3_key', 'mime_type');
  return rows.map((r) => ({ s3Key: r.s3_key, mimeType: r.mime_type }));
}

// The shared base filter for all three cases: created recently, the visit
// still upcoming, and not join-ineligible. Reads the submission's OWN
// anchor row only — case (c)'s "is this stop pest NOW" question is answered
// separately below (it can depend on sibling rows a grouped stop shares).
async function candidateRows(conn, now) {
  return conn('visit_prep_submissions as vps')
    .join('scheduled_services as ss', 'ss.id', 'vps.scheduled_service_id')
    .whereIn('vps.read_status', ['pending', 'none', 'unsupported'])
    .where('vps.created_at', '>=', new Date(now.getTime() - CANDIDATE_WINDOW_MS))
    .where('ss.scheduled_date', '>=', etDateString(now))
    .whereNotIn('ss.status', JOIN_INELIGIBLE_STATUSES)
    .select(
      'vps.id as submission_id', 'vps.read_status', 'vps.created_at',
      'ss.id as scheduled_service_id', 'ss.customer_id', 'ss.service_type', 'ss.visit_id', 'ss.status',
    );
}

// Drops any row this sweep has already retried once for this exact case
// (see file header — the one-retry-per-row-per-case bound).
async function dropAlreadyAttempted(conn, rows, caseLabel) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => String(r.submission_id));
  const attempted = await conn('activity_log')
    .where({ action: SWEEP_ACTION })
    .whereRaw("metadata->>'case' = ?", [caseLabel])
    .whereIn(conn.raw("metadata->>'submissionId'"), ids)
    .pluck(conn.raw("metadata->>'submissionId'"));
  const seen = new Set(attempted);
  return rows.filter((r) => !seen.has(String(r.submission_id)));
}

async function selectCandidates(conn, now) {
  const rows = await candidateRows(conn, now);

  const stalePending = rows.filter((r) => r.read_status === 'pending'
    && effectiveReadStatus('pending', r.created_at, now.getTime()) === 'failed');
  const none = rows.filter((r) => r.read_status === 'none'
    && now.getTime() - new Date(r.created_at).getTime() > NONE_MIN_AGE_MS);
  const unsupported = rows.filter((r) => r.read_status === 'unsupported');

  const [pendingOk, noneOk, unsupportedOk] = await Promise.all([
    dropAlreadyAttempted(conn, stalePending, SWEEP_CASE.STALE_PENDING),
    dropAlreadyAttempted(conn, none, SWEEP_CASE.NONE_RETRY),
    dropAlreadyAttempted(conn, unsupported, SWEEP_CASE.RECLASSIFIED_PEST),
  ]);

  // Case (c) only when the stop is a pest stop RIGHT NOW — never re-derived
  // from the submission's stale snapshot. The trigger re-checks this again
  // itself under the stop lock (visit-prep-pest-read.js resolveApplicability
  // / claimReadSlot), so a race between this pre-filter and the retry just
  // resolves to 'unsupported' again, harmlessly.
  const reclassified = [];
  for (const row of unsupportedOk) {
    if (await isPestStop({ id: row.scheduled_service_id, visit_id: row.visit_id }, conn)) reclassified.push(row);
  }

  const combined = [
    ...pendingOk.map((r) => ({ ...r, caseLabel: SWEEP_CASE.STALE_PENDING })),
    ...noneOk.map((r) => ({ ...r, caseLabel: SWEEP_CASE.NONE_RETRY })),
    ...reclassified.map((r) => ({ ...r, caseLabel: SWEEP_CASE.RECLASSIFIED_PEST })),
  ];
  // Oldest first, then bound the whole run (e.g. 10 rows) so a backlog can
  // never burn the day's cap in one tick.
  combined.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return combined.slice(0, SWEEP_BATCH_LIMIT);
}

async function retryOne(conn, row) {
  // Recorded BEFORE the retry runs (see file header): even a retry that
  // crashes, or lands right back in the same case, must never be retried
  // again by a later tick.
  await conn('activity_log').insert({
    action: SWEEP_ACTION,
    description: `visit-prep pest read sweep retry (${row.caseLabel})`,
    metadata: {
      submissionId: String(row.submission_id),
      case: row.caseLabel,
      scheduledServiceId: String(row.scheduled_service_id),
    },
  });
  const photos = await loadPhotos(conn, row.submission_id);
  if (!photos.length) return; // nothing left to read
  const svc = {
    id: row.scheduled_service_id,
    customer_id: row.customer_id,
    service_type: row.service_type,
    visit_id: row.visit_id,
    status: row.status,
  };
  // triggerVisitPrepPestRead never throws (see its own docstring) — every
  // failure inside it already resolves to a terminal read_status. Awaited
  // here (unlike the original fire-and-forget call site) because this sweep
  // IS the background job; there is no request to keep fast.
  await triggerVisitPrepPestRead({
    submissionId: row.submission_id, svc, photos, conn,
  });
}

/**
 * Retries up to SWEEP_BATCH_LIMIT stuck visit-prep pest reads. Gate off ->
 * no query, no write, nothing retried.
 * @param {object} [conn] defaults to the global pool.
 * @param {Date} [now]
 * @returns {Promise<{enabled:boolean, candidates:number, retried:number}>}
 */
async function sweepVisitPrepPestReads(conn = db, now = new Date()) {
  if (!visitPrepReadSweepLive()) return { enabled: false, candidates: 0, retried: 0 };

  const candidates = await selectCandidates(conn, now);
  let retried = 0;
  for (const row of candidates) {
    try {
      await retryOne(conn, row);
      retried += 1;
    } catch (err) {
      logger.error(`[visit-prep-read-sweep] retry failed submission=${row.submission_id} case=${row.caseLabel}: ${err.message}`);
    }
  }
  return { enabled: true, candidates: candidates.length, retried };
}

module.exports = {
  sweepVisitPrepPestReads,
  SWEEP_BATCH_LIMIT,
  _internal: {
    SWEEP_ACTION, SWEEP_CASE, selectCandidates, candidateRows, NONE_MIN_AGE_MS, CANDIDATE_WINDOW_MS,
  },
};
