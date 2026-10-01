/**
 * Visit prep photos — read RECOVERY SWEEP (GATE_VISIT_PREP_READ_SWEEP,
 * dark). Second-order lane on top of the visit prep reads (pest:
 * services/visit-prep-pest-read.js; lawn / tree & shrub:
 * services/visit-prep-plant-read.js; both at once for a combined Lawn & Pest
 * stop: services/visit-prep-combo-read.js): the in-process fire-and-forget
 * dispatch is never retried by itself, so two classes of
 * `visit_prep_submissions` rows can be stuck with a read that never
 * happened:
 *
 *   (b) read_status 'none' after a photo-load (S3) failure, a claim error,
 *       a VISIT_STOP_MOVED refusal, or a stop that kept changing line
 *       while it was read (the dispatcher's MAX_DISPATCHES bound);
 *   (c) read_status 'unsupported' where a live read engine now reads the
 *       stop (office reclassified it after the photos arrived);
 *   (d) read_status 'done' or 'failed' whose engine / subject no longer
 *       matches the read the stop wants now (pest -> lawn, lawn -> tree &
 *       shrub, pest -> combo when the stop gains a lawn part, combo -> pest
 *       when it loses it, after the read settled, on the same day or a later
 *       one; a combo read made while both gates were live is NOT stale just
 *       because one gate later went dark). The
 *       tech display already hides such a read; the sweep releases it to
 *       'none' and re-reads the stop once per settled attempt (Codex #5320
 *       r10, r12, r13). Its first attempt stays counted in read_attempts,
 *       and the re-read is charged to the day it runs.
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
 * directly. A 'failed' row is NEVER retried on the line it failed on — an
 * engine error already cost a paid vision call, and retrying it is how a
 * retry storm starts; only a changed line (case d) re-reads it.
 *
 * Candidates: submissions from the last RECOVERY_WINDOW_DAYS (ET days) whose
 * visit is still upcoming (scheduled_date >= today ET) and not
 * join-ineligible (visit-context/statuses.js JOIN_INELIGIBLE_STATUSES —
 * terminal statuses plus 'rescheduled'). Cases (c) and (d) additionally
 * require the stop's read RIGHT NOW (the dispatcher's own currentReadKey)
 * to differ from what the row holds — the engine re-checks this itself under the stop lock, so
 * this is only a pre-filter for which rows are worth attempting at all.
 *
 * At most ONE sweep retry per row per case (per settled attempt for case d):
 * a `visit_prep_read_sweep_attempt` activity_log row is written
 * (metadata.submissionId + metadata.case + metadata.attempts)
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
const { dispatchVisitPrepRead } = require('./visit-prep-read-dispatch');
const { currentReadKey, storedReadKey, keyForShape } = require('./visit-prep-read-key');
const { stopReadShape } = require('./visit-prep-plant-applicability');
const { etDayStart, withLockedStop } = require('./visit-prep-read-claim');
const { visitPrepReadSweepLive, visitPrepPestReadLive, visitPrepPlantReadLive } = require('../config/feature-gates');
const { JOIN_INELIGIBLE_STATUSES } = require('./visit-context/statuses');
const { etDateString, addETDays } = require('../utils/datetime-et');

const SWEEP_ACTION = 'visit_prep_read_sweep_attempt';
// How far back a submission is still worth reading: its visit must also be
// upcoming (candidateRows), and the daily cap counts a read on the ET day
// it runs (visit-prep-read-claim.js readsToday), so a re-read of an older
// submission is charged to today (Codex #5320 r12).
const RECOVERY_WINDOW_DAYS = 14;
// The buffer applied to case (b) 'none' rows so the sweep never races the
// original submission's own in-flight, fire-and-forget trigger.
const NONE_MIN_AGE_MS = 15 * 60 * 1000;
const SWEEP_BATCH_LIMIT = 10;

const SWEEP_CASE = {
  NONE_RETRY: 'none_retry',
  RECLASSIFIED: 'reclassified',
  // A done or failed read made by the wrong engine / subject for the stop
  // as it is now (Codex #5320 r10, r13).
  STALE_READ: 'stale_read',
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
    .whereIn('vps.read_status', ['none', 'unsupported', 'done', 'failed'])
    // ET calendar days (addETDays lands on the target ET date), never a
    // fixed 24-hour multiple that a DST change would shift (Codex #5348 r1).
    .where('vps.created_at', '>=', etDayStart(addETDays(now, -RECOVERY_WINDOW_DAYS)))
    .where('ss.scheduled_date', '>=', etDateString(now))
    .whereNotIn('ss.status', JOIN_INELIGIBLE_STATUSES)
    .select(
      'vps.id as submission_id', 'vps.read_status', 'vps.created_at', 'vps.read_result', 'vps.read_attempts',
      'ss.id as scheduled_service_id', 'ss.customer_id', 'ss.service_type', 'ss.visit_id', 'ss.status',
    );
}

// Drops any row this sweep has already retried once for this exact case
// (see file header — the one-retry-per-row-per-case bound). A stale-read
// retry is keyed to the read attempt it replaced as well, so a stop
// reclassified AGAIN after a successful recovery gets its own retry
// (Codex #5320 r13).
async function dropAlreadyAttempted(conn, rows, caseLabel) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => String(r.submission_id));
  // Selected under an alias and mapped: Knex's pluck() needs a plain column
  // name, never a Raw (Codex #5319 r1 P1).
  const attempted = await conn('activity_log')
    .where({ action: SWEEP_ACTION })
    .whereRaw("metadata->>'case' = ?", [caseLabel])
    .whereIn(conn.raw("metadata->>'submissionId'"), ids)
    .select(conn.raw("metadata->>'submissionId' as submission_id"), conn.raw("metadata->>'attempts' as attempts"));
  const perAttempt = caseLabel === SWEEP_CASE.STALE_READ;
  const seen = new Set(attempted.map((r) => (perAttempt ? `${r.submission_id}@${r.attempts}` : String(r.submission_id))));
  return rows.filter((r) => !seen.has(perAttempt ? `${r.submission_id}@${Number(r.read_attempts) || 0}` : String(r.submission_id)));
}

const CHECK_ACTION = 'visit_prep_read_sweep_check';
const CHECK_COOLDOWN_MS = 60 * 60 * 1000;

// Drops rows checked within CHECK_COOLDOWN_MS, then orders the rest by
// when they were last checked (never-checked first, then oldest check,
// then oldest submission), so each tick advances through the whole
// recovery window instead of re-checking the same oldest rows once their
// cooldown lapses (Codex #5319 r2, #5348 r1).
async function orderByLastCheck(conn, rows, now) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => String(r.submission_id));
  const checked = await conn('activity_log')
    .where({ action: CHECK_ACTION })
    .whereIn(conn.raw("metadata->>'submissionId'"), ids)
    .groupByRaw("metadata->>'submissionId'")
    .select(conn.raw("metadata->>'submissionId' as submission_id"), conn.raw('MAX(created_at) as last_checked'));
  const lastChecked = new Map(checked.map((r) => [String(r.submission_id), new Date(r.last_checked).getTime()]));
  const cutoff = now.getTime() - CHECK_COOLDOWN_MS;
  const at = (r) => lastChecked.get(String(r.submission_id)) ?? -Infinity;
  return rows
    .filter((r) => at(r) < cutoff)
    .sort((a, b) => (at(a) - at(b)) || (new Date(a.created_at) - new Date(b.created_at)));
}

async function recordCheck(conn, row) {
  await conn('activity_log').insert({
    action: CHECK_ACTION,
    description: 'visit-prep read sweep: the stop needs no new read',
    metadata: { submissionId: String(row.submission_id) },
  });
}

const SETTLED = ['done', 'failed'];

// Does this row need a read the stop's current engine would make? (c): an
// unsupported row a live engine reads now; (d): a done or failed read made
// by the wrong engine / subject for the stop as it is now. A failed read on
// an unchanged line is never retried.
async function needsReadNow(conn, row, live) {
  const stop = { id: row.scheduled_service_id, visit_id: row.visit_id };
  const want = await currentReadKey(stop, conn, live);
  if (!want) return false;
  if (!SETTLED.includes(row.read_status)) return true;
  const stored = storedReadKey(row.read_result);
  if (stored === want) return false;
  // A combo read holds BOTH parts. When one gate later goes dark the stop's
  // key degrades to the one live engine, but nothing about the stop changed:
  // the stored combo is not stale (re-reading would spend paid calls for a
  // result the tech already has). It is stale only once the stop is no
  // longer that combo (lost its pest or plant part, or changed subject).
  if (stored.startsWith('combo:') && (want === 'pest' || want.startsWith('plant:'))) {
    const full = keyForShape(await stopReadShape(stop, conn), { pestLive: true, plantLive: true });
    if (full === stored) return false;
  }
  return true;
}

async function selectCandidates(conn, now) {
  const rows = await candidateRows(conn, now);
  const live = { pestLive: visitPrepPestReadLive(), plantLive: visitPrepPlantReadLive() };

  const none = rows.filter((r) => r.read_status === 'none'
    && now.getTime() - new Date(r.created_at).getTime() > NONE_MIN_AGE_MS);
  const unsupported = rows.filter((r) => r.read_status === 'unsupported');
  const settled = rows.filter((r) => SETTLED.includes(r.read_status));

  const [noneOk, unsupportedOk, settledOk] = await Promise.all([
    dropAlreadyAttempted(conn, none, SWEEP_CASE.NONE_RETRY),
    dropAlreadyAttempted(conn, unsupported, SWEEP_CASE.RECLASSIFIED),
    dropAlreadyAttempted(conn, settled, SWEEP_CASE.STALE_READ),
  ]);

  // Cases (c) and (d) only when the stop's read RIGHT NOW differs from what
  // the row holds — never re-derived from the submission's stale snapshot;
  // the engine re-checks it under the stop lock. The per-row check runs only
  // for the batch's remaining room (Codex #5319 r1 P2), least recently
  // checked first (orderByLastCheck), so each tick advances through the
  // whole window (Codex #5319 r2, #5348 r1).
  const room = Math.max(0, SWEEP_BATCH_LIMIT - noneOk.length);
  const toCheck = await orderByLastCheck(conn, [...unsupportedOk, ...settledOk], now);
  const changed = [];
  for (const row of toCheck.slice(0, room * 2)) {
    if (changed.length >= room) break;
    if (await needsReadNow(conn, row, live)) {
      changed.push(row);
    } else {
      await recordCheck(conn, row);
    }
  }

  const combined = [
    ...noneOk.map((r) => ({ ...r, caseLabel: SWEEP_CASE.NONE_RETRY })),
    ...changed.map((r) => ({ ...r, caseLabel: SETTLED.includes(r.read_status) ? SWEEP_CASE.STALE_READ : SWEEP_CASE.RECLASSIFIED })),
  ];
  // Oldest first, then bound the whole run (e.g. 10 rows) so a backlog can
  // never burn the day's cap in one tick.
  combined.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return combined.slice(0, SWEEP_BATCH_LIMIT);
}

// Releases a stale done or failed read to 'none' so it can be re-read — only after
// proving, under the stop lock, that the stop still wants a DIFFERENT read
// than the one stored (a stop that changed back keeps its valid result;
// Codex #5320 r11 P2), and only while it is still the exact read this sweep
// judged (every claim bumps read_attempts). Its attempt stays counted.
async function releaseStaleRead(conn, row, svc) {
  const live = { pestLive: visitPrepPestReadLive(), plantLive: visitPrepPlantReadLive() };
  return withLockedStop(conn, svc, {
    onGone: () => false,
    onMoved: () => false,
    body: async (trx) => {
      if (!(await needsReadNow(trx, row, live))) return false;
      const released = await trx('visit_prep_submissions')
        .where({ id: row.submission_id, read_status: row.read_status, read_attempts: row.read_attempts })
        // A read settled before read_attempts existed holds 0 and counted
        // only through its status; released, it keeps one attempt counted.
        .update({
          read_status: 'none', read_ref: null, read_result: null, read_attempts: Math.max(Number(row.read_attempts) || 0, 1),
        });
      return released > 0;
    },
  });
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
      // The attempt this retry replaces (stale-read retries are one per attempt).
      attempts: Number(row.read_attempts) || 0,
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
  let expectStatus = [row.read_status];
  if (SETTLED.includes(row.read_status)) {
    if (!(await releaseStaleRead(conn, row, svc))) return;
    expectStatus = ['none'];
  }
  // dispatchVisitPrepRead never throws (see its own docstring) — every
  // failure inside it already resolves to a terminal read_status. Awaited
  // here (unlike the original fire-and-forget call site) because this sweep
  // IS the background job; there is no request to keep fast.
  // The trigger claims only while the row is still in the case this sweep
  // selected (re-checked under a row lock): an original read that finished
  // meanwhile is left alone, never re-run (Codex #5319 r1 P1).
  const outcome = await dispatchVisitPrepRead({
    submissionId: row.submission_id, svc, photos, conn, expectStatus,
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
    SWEEP_ACTION, SWEEP_CASE, selectCandidates, candidateRows, NONE_MIN_AGE_MS, retryOne,
  },
};
