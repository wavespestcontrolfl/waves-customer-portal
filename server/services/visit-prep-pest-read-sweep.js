/**
 * Visit prep photos — read RECOVERY SWEEP (GATE_VISIT_PREP_READ_SWEEP,
 * dark). Second-order lane on top of the visit prep reads (pest:
 * services/visit-prep-pest-read.js; lawn / tree & shrub:
 * services/visit-prep-plant-read.js): the in-process fire-and-forget
 * dispatch is never retried by itself, so two classes of
 * `visit_prep_submissions` rows can be stuck with a read that never
 * happened:
 *
 *   (b) read_status 'none' after a photo-load (S3) failure, a claim error,
 *       a VISIT_STOP_MOVED refusal, or a stop that kept changing line
 *       while it was read (the dispatcher's MAX_DISPATCHES bound);
 *   (c) read_status 'unsupported' where a live read engine now reads the
 *       stop (office reclassified it after the photos arrived).
 *
 * A 'pending' row is NEVER retried (Codex #5319 r2): a pending row may belong
 * to a read that is still running, and there is no claim timestamp to tell
 * it from a crashed one, so a retry could run the engine twice and spend
 * the cap uncounted. A read left pending by a crash shows as failed on the
 * tech display after 15 minutes. Both retried cases start from an
 * UNCLAIMED row, so the trigger's conditional claim lets exactly one read
 * win and counts it against the cap like any first read.
 *
 * A 15-minute cron tick (scheduler.js) reruns dispatchVisitPrepRead for
 * up to SWEEP_BATCH_LIMIT candidate rows per tick — the SAME dispatcher the
 * original submission calls (services/visit-prep-read-dispatch.js), so every
 * engine-choice/claim/cap rule stays in exactly one place; this module never
 * touches pest_identifications, the stop lock, or the daily-cap count
 * directly. 'failed' rows are NEVER retried — an engine error already cost
 * a paid vision call, and retrying it is how a retry storm starts.
 *
 * Candidates: submissions created TODAY (America/New_York) whose
 * visit is still upcoming (scheduled_date >= today ET) and not
 * join-ineligible (visit-context/statuses.js JOIN_INELIGIBLE_STATUSES —
 * terminal statuses plus 'rescheduled'). Case (c) additionally requires a
 * live engine to read the stop RIGHT NOW (the dispatcher's own
 * chooseEngine) — the engine re-checks this itself under the stop lock, so
 * this is only a pre-filter for which rows are worth attempting at all.
 *
 * At most ONE sweep retry per row per case: a `visit_prep_read_sweep_attempt`
 * activity_log row is written (metadata.submissionId + metadata.case)
 * BEFORE the retry runs, the same idempotency-marker pattern
 * call-reschedule-apply.js uses on the same table — so a row whose retry
 * lands right back in the SAME case (the cap still refuses it, the stop is
 * still not readable, …) is never picked up again by a later tick. Deliberately
 * no migration: activity_log already exists for exactly this "did we
 * already try this?" bookkeeping, and its jsonb metadata is queried the
 * same way elsewhere in this repo (call-commitments-watchdog.js,
 * dispatch-alerts.js).
 */

const db = require('../models/db');
const logger = require('./logger');
const { dispatchVisitPrepRead, _internal: { chooseEngine } } = require('./visit-prep-read-dispatch');
const { etDayStart } = require('./visit-prep-read-claim');
const { visitPrepReadSweepLive, visitPrepPestReadLive, visitPrepPlantReadLive } = require('../config/feature-gates');
const { JOIN_INELIGIBLE_STATUSES } = require('./visit-context/statuses');
const { etDateString } = require('../utils/datetime-et');

const SWEEP_ACTION = 'visit_prep_read_sweep_attempt';
// Only today's (ET) submissions: the trigger's claim refuses any submission
// from an earlier ET day (its cap is counted by submission day), so an older
// retry could only end 'none' without a read.
// The buffer applied to case (b) 'none' rows so the sweep never races the
// original submission's own in-flight, fire-and-forget trigger.
const NONE_MIN_AGE_MS = 15 * 60 * 1000;
const SWEEP_BATCH_LIMIT = 10;

const SWEEP_CASE = {
  NONE_RETRY: 'none_retry',
  RECLASSIFIED: 'reclassified',
};

async function loadPhotos(conn, submissionId) {
  const rows = await conn('visit_prep_photos').where({ submission_id: submissionId }).select('s3_key', 'mime_type');
  return rows.map((r) => ({ s3Key: r.s3_key, mimeType: r.mime_type }));
}

// The shared base filter for all three cases: created recently, the visit
// still upcoming, and not join-ineligible. Reads the submission's OWN
// anchor row only — case (c)'s "does a live engine read this stop NOW" question is answered
// separately below (it can depend on sibling rows a grouped stop shares).
async function candidateRows(conn, now) {
  return conn('visit_prep_submissions as vps')
    .join('scheduled_services as ss', 'ss.id', 'vps.scheduled_service_id')
    .whereIn('vps.read_status', ['none', 'unsupported'])
    .where('vps.created_at', '>=', etDayStart(now))
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
  // Selected under an alias and mapped: Knex's pluck() needs a plain column
  // name, never a Raw (Codex #5319 r1 P1).
  const attempted = await conn('activity_log')
    .where({ action: SWEEP_ACTION })
    .whereRaw("metadata->>'case' = ?", [caseLabel])
    .whereIn(conn.raw("metadata->>'submissionId'"), ids)
    .select(conn.raw("metadata->>'submissionId' as submission_id"));
  const seen = new Set(attempted.map((r) => String(r.submission_id)));
  return rows.filter((r) => !seen.has(String(r.submission_id)));
}

const CHECK_ACTION = 'visit_prep_read_sweep_check';
const CHECK_COOLDOWN_MS = 60 * 60 * 1000;

async function dropRecentlyChecked(conn, rows, now) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => String(r.submission_id));
  const checked = await conn('activity_log')
    .where({ action: CHECK_ACTION })
    .where('created_at', '>=', new Date(now.getTime() - CHECK_COOLDOWN_MS))
    .whereIn(conn.raw("metadata->>'submissionId'"), ids)
    .select(conn.raw("metadata->>'submissionId' as submission_id"));
  const seen = new Set(checked.map((r) => String(r.submission_id)));
  return rows.filter((r) => !seen.has(String(r.submission_id)));
}

async function recordCheck(conn, row) {
  await conn('activity_log').insert({
    action: CHECK_ACTION,
    description: 'visit-prep read sweep: no live engine reads the stop yet',
    metadata: { submissionId: String(row.submission_id) },
  });
}

async function selectCandidates(conn, now) {
  const rows = await candidateRows(conn, now);
  const live = { pestLive: visitPrepPestReadLive(), plantLive: visitPrepPlantReadLive() };

  const none = rows.filter((r) => r.read_status === 'none'
    && now.getTime() - new Date(r.created_at).getTime() > NONE_MIN_AGE_MS);
  const unsupported = rows.filter((r) => r.read_status === 'unsupported');

  const [noneOk, unsupportedOk] = await Promise.all([
    dropAlreadyAttempted(conn, none, SWEEP_CASE.NONE_RETRY),
    dropAlreadyAttempted(conn, unsupported, SWEEP_CASE.RECLASSIFIED),
  ]);

  // Case (c) only when a live engine reads the stop RIGHT NOW — never
  // re-derived from the submission's stale snapshot; the engine re-checks
  // it under the stop lock. The per-row check runs only for the batch's remaining room
  // (Codex #5319 r1 P2), and a row checked and found still unreadable is
  // skipped for CHECK_COOLDOWN_MS, so each tick advances through the cohort
  // instead of re-checking the same oldest rows (Codex #5319 r2 P2).
  const room = Math.max(0, SWEEP_BATCH_LIMIT - noneOk.length);
  const unchecked = await dropRecentlyChecked(conn, unsupportedOk, now);
  const reclassified = [];
  const oldestUnsupported = [...unchecked].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  for (const row of oldestUnsupported.slice(0, room * 2)) {
    if (reclassified.length >= room) break;
    if (await chooseEngine({ id: row.scheduled_service_id, visit_id: row.visit_id }, conn, live)) {
      reclassified.push(row);
    } else {
      await recordCheck(conn, row);
    }
  }

  const combined = [
    ...noneOk.map((r) => ({ ...r, caseLabel: SWEEP_CASE.NONE_RETRY })),
    ...reclassified.map((r) => ({ ...r, caseLabel: SWEEP_CASE.RECLASSIFIED })),
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
    description: `visit-prep read sweep retry (${row.caseLabel})`,
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
  // dispatchVisitPrepRead never throws (see its own docstring) — every
  // failure inside it already resolves to a terminal read_status. Awaited
  // here (unlike the original fire-and-forget call site) because this sweep
  // IS the background job; there is no request to keep fast.
  // The trigger claims only while the row is still in the case this sweep
  // selected (re-checked under a row lock): an original read that finished
  // meanwhile is left alone, never re-run (Codex #5319 r1 P1).
  const outcome = await dispatchVisitPrepRead({
    submissionId: row.submission_id, svc, photos, conn, expectStatus: [row.read_status],
  });
  // The dispatch never throws (it must never break a customer's upload), so
  // its outcome is how a failed recovery reaches job health (Codex #5319 r4).
  if (outcome === 'failed' || outcome === 'error') {
    throw new Error(`read retry ended ${outcome}`);
  }
}

/**
 * Retries up to SWEEP_BATCH_LIMIT stuck visit-prep reads (any live engine). Gate off ->
 * no query, no write, nothing retried.
 * @param {object} [conn] defaults to the global pool.
 * @param {Date} [now]
 * @returns {Promise<{enabled:boolean, candidates:number, retried:number}>}
 */
async function sweepVisitPrepPestReads(conn = db, now = new Date()) {
  if (!visitPrepReadSweepLive()) return { enabled: false, candidates: 0, retried: 0 };

  const candidates = await selectCandidates(conn, now);
  let retried = 0;
  const failures = [];
  for (const row of candidates) {
    try {
      await retryOne(conn, row);
      retried += 1;
    } catch (err) {
      logger.error(`[visit-prep-read-sweep] retry failed submission=${row.submission_id} case=${row.caseLabel}: ${err.message}`);
      failures.push(row.submission_id);
    }
  }
  // Every row still gets its chance above; a batch with failures then fails
  // the run so job_health shows it (Codex #5319 r3 P2).
  if (failures.length) {
    const err = new Error(`visit-prep read sweep: ${failures.length} of ${candidates.length} retries failed`);
    err.result = { enabled: true, candidates: candidates.length, retried, failed: failures.length };
    throw err;
  }
  return { enabled: true, candidates: candidates.length, retried };
}

module.exports = {
  sweepVisitPrepPestReads,
  SWEEP_BATCH_LIMIT,
  _internal: {
    SWEEP_ACTION, SWEEP_CASE, selectCandidates, candidateRows, NONE_MIN_AGE_MS,
  },
};
