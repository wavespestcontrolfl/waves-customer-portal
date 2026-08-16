/**
 * Durable queue for SMS contact corrections (codex #3413 r17).
 *
 * Replaces the in-memory reservation slot + per-customer promise chain:
 * both were process-local, so (a) overlapping deploy instances could run
 * two rapid corrections from the same sender out of order — each
 * snapshots the same original fields, first commit wins, and the CAS
 * rejects the customer's NEWER message — and (b) a deploy after the
 * webhook ack killed the detached LLM run while the MessageSid claim
 * stayed durable, so Twilio's retry was ignored and the correction was
 * lost with no replay path.
 *
 * Contract (mirrors receipt-delivery-queue):
 *  - reserve() at webhook ENTRY (sender phone is available synchronously,
 *    before the media/customer awaits) — the row's bigserial id records
 *    arrival order durably, across instances.
 *  - enqueue() when a branch decides the message needs a run — AWAITED
 *    before the TwiML ack, so the work item survives the process.
 *  - cancel() on route exit paths that decided no run is needed; rows a
 *    dead instance left 'reserved' are promoted (or cancelled) by the
 *    worker's stale sweep — that sweep IS the Twilio-retry-ignored
 *    recovery path.
 *  - the worker claims the oldest due 'queued' job whose sender has no
 *    EARLIER unfinished job (reserved/queued/running) — the DB-backed
 *    ordering fence. Same-customer overlap across DIFFERENT senders is
 *    not fenced here; the apply transaction's row lock + match-time CAS
 *    already serialize and fail-close that interleave.
 */

const os = require('os');
const db = require('../models/db');
const logger = require('./logger');

const STALE_LOCK_MINUTES = 10;
const STALE_RESERVATION_MINUTES = 10;
const DEFAULT_MAX_ATTEMPTS = 3;
const ACTIVE_STATUSES = ['reserved', 'queued', 'running'];

// Unique per processing PASS, not per process (codex #3413 r19): the
// interval and the post-enqueue kicks overlap inside one process, and a
// shared hostname:pid owner would let a pass whose lock went stale mark
// done/retry over the state of the sibling pass that reclaimed the job.
let passSeq = 0;
function workerId() {
  passSeq += 1;
  return `${os.hostname()}:${process.pid}:${passSeq}`;
}

function tail10(p) {
  const digits = String(p || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

async function tableReady(knex) {
  try {
    return await knex.schema.hasTable('contact_correction_jobs');
  } catch {
    return false;
  }
}

/**
 * Insert the arrival-order marker. Fail-soft: a DB error here must not
 * break inbound SMS handling — the message simply gets no correction
 * (and no durability), exactly the pre-queue failure mode.
 */
async function reserveContactCorrectionJob({ senderPhone, messageSid = null, body = null, knex = db } = {}) {
  const senderKey = tail10(senderPhone);
  if (!senderKey) return null;
  try {
    if (!(await tableReady(knex))) return null;
    const inserted = await knex('contact_correction_jobs')
      .insert({
        sender_key: senderKey,
        sender_phone: String(senderPhone || '').slice(0, 30),
        message_sid: messageSid || null,
        body,
        status: 'reserved',
      })
      .returning('id');
    return inserted?.[0]?.id ?? inserted?.[0] ?? null;
  } catch (err) {
    // 23505 on the live-sid partial unique index = a Twilio redelivery of
    // a message whose original delivery already holds a live job — the
    // desired outcome, not an error (migration 20260816000005).
    if (err && err.code === '23505') {
      logger.info('[contact-correction-queue] duplicate delivery reservation rejected (sid already live)');
      return null;
    }
    logger.warn(`[contact-correction-queue] reservation failed: ${err.message}`);
    return null;
  }
}

/**
 * Attach the payload and make the job runnable. Awaited by the webhook
 * BEFORE the TwiML ack — once this commits, the correction survives a
 * deploy. Only transitions 'reserved' rows (a cancelled/expired row is
 * never resurrected); returns whether the job is now queued. Fail-soft:
 * on error the row stays 'reserved' and the stale sweep replays it.
 */
async function enqueueContactCorrectionJob(jobId, { customerId, smsLogId = null, expectedValues = null, knex = db } = {}) {
  if (!jobId || !customerId) return false;
  try {
    const updated = await knex('contact_correction_jobs')
      .where({ id: jobId, status: 'reserved' })
      .update({
        status: 'queued',
        customer_id: customerId,
        sms_log_id: smsLogId || null,
        expected_values: expectedValues ? JSON.stringify(expectedValues) : null,
        next_attempt_at: knex.fn.now(),
        updated_at: knex.fn.now(),
      });
    return updated > 0;
  } catch (err) {
    logger.warn(`[contact-correction-queue] enqueue failed for job ${jobId}: ${err.message}`);
    return false;
  }
}

/**
 * Stamp the SOURCE-TIME context on a reservation as soon as the route
 * matches the sender to a customer (codex #3413 r19): linkage + the
 * match-time CAS baseline. Promotion of a crash-orphaned reservation
 * requires this context — without it the stale sweep would have to
 * re-derive eligibility from CURRENT state, which a phone reassignment
 * or a failed cancel on a pre-match exit path could exploit. Status is
 * untouched; the row remains 'reserved' until a branch fires (enqueue)
 * or the route releases it (cancel).
 */
async function attachContactCorrectionContext(jobId, { customerId, expectedValues = null, knex = db } = {}) {
  if (!jobId || !customerId) return false;
  try {
    const updated = await knex('contact_correction_jobs')
      .where({ id: jobId, status: 'reserved' })
      .update({
        customer_id: customerId,
        expected_values: expectedValues ? JSON.stringify(expectedValues) : null,
        updated_at: knex.fn.now(),
      });
    return updated > 0;
  } catch (err) {
    logger.warn(`[contact-correction-queue] context attach failed for job ${jobId}: ${err.message}`);
    return false;
  }
}

/** Release an un-run reservation (route exit, unlinked sender). */
async function cancelContactCorrectionJob(jobId, reason = 'cancelled', { knex = db } = {}) {
  if (!jobId) return false;
  try {
    const updated = await knex('contact_correction_jobs')
      .where({ id: jobId, status: 'reserved' })
      .update({
        status: 'cancelled',
        cancel_reason: String(reason || 'cancelled').slice(0, 60),
        completed_at: knex.fn.now(),
        updated_at: knex.fn.now(),
      });
    return updated > 0;
  } catch (err) {
    logger.warn(`[contact-correction-queue] cancel failed for job ${jobId}: ${err.message}`);
    return false;
  }
}

/** In-process nudge so the ack path doesn't wait for the next interval. */
function kickContactCorrectionQueue() {
  setImmediate(() => {
    processDueContactCorrectionJobs({ limit: 3 }).catch((err) => {
      logger.warn(`[contact-correction-queue] kick failed: ${err.message}`);
    });
  });
}

/** Workers that died mid-run: unlock after STALE_LOCK_MINUTES. */
async function recoverStaleLocks(knex) {
  return knex('contact_correction_jobs')
    .where({ status: 'running' })
    .where('locked_at', '<', knex.raw(`now() - interval '${STALE_LOCK_MINUTES} minutes'`))
    .update({
      status: 'queued',
      locked_at: null,
      locked_by: null,
      next_attempt_at: knex.fn.now(),
      updated_at: knex.fn.now(),
    });
}

/**
 * Rows a dead instance left 'reserved': the route never reached its
 * finally, so the message may have been acked-and-lost (Twilio's retry
 * is ignored once the MessageSid claim is durable). Promotion requires
 * the SOURCE-TIME context the route stamped at customer match
 * (codex #3413 r19): re-deriving eligibility from current state let a
 * phone reassignment attach an old SMS to the number's new owner, let a
 * spam-blocked or unmanaged-number delivery be promoted when its
 * fire-and-forget cancel failed, and left the CAS to baseline on a
 * run-start read. A reservation with stored linkage + baseline replays
 * exactly what the route matched; one without context died before the
 * match (or on a pre-context exit path) and is cancelled — fail closed.
 */
async function promoteStaleReservations(knex) {
  const stale = await knex('contact_correction_jobs')
    .where({ status: 'reserved' })
    .where('created_at', '<', knex.raw(`now() - interval '${STALE_RESERVATION_MINUTES} minutes'`))
    .orderBy('id', 'asc')
    .limit(20);
  let promoted = 0;
  for (const job of stale) {
    try {
      // A Twilio redelivery inserts a second reservation before the SID
      // idempotency claim; if the route died before its finally could
      // cancel it, that duplicate must never be replayed — the ORIGINAL
      // delivery's job (queued/running/done/failed under the same sid)
      // already carries the correction, and a replayed duplicate would run
      // with a later queue id and a run-start snapshot, able to overwrite
      // a newer correction with the stale value (codex #3413 r18). A
      // sibling still 'reserved' does not count: with both deliveries
      // dead-reserved, the sweep promotes the oldest and this check then
      // cancels the rest. A partial unique index (migration
      // 20260816000005) blocks new duplicates at insert; this check covers
      // the same-window races the index cannot see.
      if (job.message_sid) {
        const sibling = await knex('contact_correction_jobs')
          .where('message_sid', job.message_sid)
          .whereNot('id', job.id)
          .whereNotIn('status', ['cancelled', 'reserved'])
          .first('id');
        if (sibling) {
          await cancelContactCorrectionJob(job.id, 'duplicate_sid', { knex });
          continue;
        }
      }
      const contactCorrection = require('./contact-correction');
      if (!job.body || !contactCorrection.detectContactCorrectionIntent(job.body)) {
        await cancelContactCorrectionJob(job.id, 'stale_no_intent', { knex });
        continue;
      }
      if (!job.customer_id) {
        await cancelContactCorrectionJob(job.id, 'stale_no_context', { knex });
        continue;
      }
      const smsLog = job.message_sid
        ? await knex('sms_log')
          .where({ twilio_sid: job.message_sid, direction: 'inbound' })
          .orderBy('created_at', 'desc')
          .first('id')
        : null;
      // Flip to queued preserving the stored match-time context (linkage +
      // CAS baseline) — enqueueContactCorrectionJob would overwrite the
      // baseline, and the route already attached the authoritative one.
      const flipped = await knex('contact_correction_jobs')
        .where({ id: job.id, status: 'reserved' })
        .update({
          status: 'queued',
          sms_log_id: smsLog?.id || null,
          next_attempt_at: knex.fn.now(),
          updated_at: knex.fn.now(),
        });
      if (flipped) promoted += 1;
    } catch (err) {
      logger.warn(`[contact-correction-queue] stale promotion failed for job ${job.id}: ${err.message}`);
    }
  }
  return promoted;
}

/**
 * Claim the oldest due queued jobs whose sender fence is clear. The
 * earlier-job check reads committed status: an older job still
 * reserved/queued/running (on ANY instance) blocks the newer one, so
 * source order holds across deploys. forUpdate().skipLocked() keeps two
 * concurrent workers from double-claiming the same row.
 */
async function claimDueContactCorrectionJobs({ limit = 3, id = workerId(), knex = db } = {}) {
  return knex.transaction(async (trx) => {
    const candidates = await trx('contact_correction_jobs')
      .where({ status: 'queued' })
      .where('next_attempt_at', '<=', trx.fn.now())
      .orderBy('id', 'asc')
      .limit(Math.max(limit * 5, 15))
      .forUpdate()
      .skipLocked();

    const claimedIds = [];
    const blockedSenders = new Set();
    for (const job of candidates) {
      if (claimedIds.length >= limit) break;
      // One claim per sender per pass — a claimed job blocks its
      // sender's later jobs until it finishes.
      if (blockedSenders.has(job.sender_key)) continue;
      const earlier = await trx('contact_correction_jobs')
        .where({ sender_key: job.sender_key })
        .where('id', '<', job.id)
        .whereIn('status', ACTIVE_STATUSES)
        .first('id');
      if (earlier) { blockedSenders.add(job.sender_key); continue; }
      blockedSenders.add(job.sender_key);
      claimedIds.push(job.id);
    }
    if (!claimedIds.length) return [];

    return trx('contact_correction_jobs')
      .whereIn('id', claimedIds)
      .update({
        status: 'running',
        locked_at: trx.fn.now(),
        locked_by: id,
        attempts: trx.raw('attempts + 1'),
        updated_at: trx.fn.now(),
      })
      .returning('*');
  });
}

// Both terminal marks are OWNER-CONDITIONED (codex #3413 r18): a worker
// whose lock went stale mid-run (slow LLM call outliving the 10-minute
// threshold) must not overwrite the state of the peer that legitimately
// reclaimed the job — its update matches zero rows and is logged instead.
async function markJobDone(job, result, knex, wid) {
  const updated = await knex('contact_correction_jobs')
    .where({ id: job.id, status: 'running', locked_by: wid })
    .update({
      status: 'done',
      result: result ? JSON.stringify(result) : null,
      completed_at: knex.fn.now(),
      locked_at: null,
      locked_by: null,
      last_error: null,
      updated_at: knex.fn.now(),
    });
  if (!updated) logger.warn(`[contact-correction-queue] job ${job.id} lock lost before done mark (reclaimed by a peer)`);
  return updated > 0;
}

async function markJobRetry(job, errMessage, knex, wid) {
  const attempts = Number(job.attempts || 0);
  const maxAttempts = Number(job.max_attempts || DEFAULT_MAX_ATTEMPTS);
  const terminal = attempts >= maxAttempts;
  const delayMinutes = Math.min(30, Math.pow(2, Math.max(0, attempts - 1)));
  const updated = await knex('contact_correction_jobs')
    .where({ id: job.id, status: 'running', locked_by: wid })
    .update({
      status: terminal ? 'failed' : 'queued',
      last_error: String(errMessage || 'contact correction failed').slice(0, 500),
      next_attempt_at: terminal
        ? knex.fn.now()
        : knex.raw(`now() + interval '${delayMinutes} minutes'`),
      completed_at: terminal ? knex.fn.now() : null,
      locked_at: null,
      locked_by: null,
      updated_at: knex.fn.now(),
    });
  if (!updated) logger.warn(`[contact-correction-queue] job ${job.id} lock lost before retry mark (reclaimed by a peer)`);
  return updated > 0;
}

/**
 * Rebase a job's persisted CAS baseline over earlier QUEUE writes for the
 * same customer (codex #3413 r18): two rapid messages snapshot the same
 * original values at their webhooks, so after the older job applies, the
 * newer job's baseline would read the older job's write as a concurrent
 * change and stale out — leaving the OLDER correction as the winner.
 * Overlaying the applied values of earlier completed jobs (only those
 * finishing AFTER this job's snapshot was taken) advances the baseline
 * through the queue's own writes while an intervening admin edit — or any
 * write the queue did not make — still reads as concurrent and fails
 * closed. applied.newValue is the canonical value the apply wrote, so the
 * field-aware CAS compare matches exactly.
 */
async function rebaseSnapshot(job, snapshot, knex) {
  if (!snapshot || !job.customer_id) return snapshot;
  const earlier = await knex('contact_correction_jobs')
    .where('customer_id', job.customer_id)
    .where('id', '<', job.id)
    .where('status', 'done')
    .where('completed_at', '>', job.created_at)
    .orderBy('id', 'asc');
  const rebased = { ...snapshot };
  for (const e of earlier) {
    let result = e.result;
    if (typeof result === 'string') { try { result = JSON.parse(result); } catch { result = null; } }
    for (const a of (result?.applied || [])) {
      if (a && a.field && Object.prototype.hasOwnProperty.call(rebased, a.field)) {
        rebased[a.field] = a.newValue ?? null;
      }
    }
  }
  return rebased;
}

async function runContactCorrectionJob(job, knex, wid) {
  const contactCorrection = require('./contact-correction');
  const customer = job.customer_id
    ? await knex('customers').where({ id: job.customer_id }).whereNull('deleted_at').first()
    : null;
  if (!customer) {
    await markJobDone(job, { applied: [], skipped: [], reason: 'customer_missing' }, knex, wid);
    return { ok: true, reason: 'customer_missing' };
  }
  // pg parses jsonb to an object; anything else (older drivers, stubs)
  // falls back to the runner's run-start read.
  const rawSnapshot = (job.expected_values && typeof job.expected_values === 'object') ? job.expected_values : null;
  const snapshot = await rebaseSnapshot(job, rawSnapshot, knex);
  // The runner is fail-soft (never throws; internal errors come back as
  // reason 'error'). Retry only that internal-error shape — every other
  // outcome (gate_off, no_corrections, applied, CAS-skipped, …) is final.
  const result = await contactCorrection.runSmsContactCorrection({
    customer,
    body: job.body,
    smsLogId: job.sms_log_id || null,
    senderPhone: job.sender_phone || null,
    matchedSnapshot: snapshot,
  });
  if (result?.reason === 'error') {
    await markJobRetry(job, 'runner reported internal error', knex, wid);
    return { ok: false, reason: 'error' };
  }
  await markJobDone(job, result, knex, wid);
  return { ok: true, reason: result?.reason || 'done' };
}

async function processDueContactCorrectionJobs({ limit = 3, knex = db } = {}) {
  const summary = { recovered: 0, promoted: 0, claimed: 0, succeeded: 0, failed: 0 };
  if (!(await tableReady(knex))) return summary;
  try {
    summary.recovered = await recoverStaleLocks(knex);
  } catch (err) {
    logger.warn(`[contact-correction-queue] stale-lock recovery failed: ${err.message}`);
  }
  try {
    summary.promoted = await promoteStaleReservations(knex);
  } catch (err) {
    logger.warn(`[contact-correction-queue] stale-reservation sweep failed: ${err.message}`);
  }
  // Claim ONE job per iteration, not a batch (codex #3413 r18): batched
  // claims stamp every job's locked_at up front, and an LLM extraction can
  // run long enough that a job still WAITING behind earlier work ages past
  // the stale-lock threshold — a peer then reclaims it and runs the same
  // paid extraction twice. Claiming immediately before running keeps each
  // lock's age equal to its own work only.
  const wid = workerId();
  while (summary.claimed < limit) {
    let jobs = [];
    try {
      jobs = await claimDueContactCorrectionJobs({ limit: 1, id: wid, knex });
    } catch (err) {
      logger.warn(`[contact-correction-queue] claim failed: ${err.message}`);
      break;
    }
    if (!jobs.length) break;
    const job = jobs[0];
    summary.claimed += 1;
    try {
      const res = await runContactCorrectionJob(job, knex, wid);
      if (res.ok) summary.succeeded += 1; else summary.failed += 1;
    } catch (err) {
      summary.failed += 1;
      try {
        await markJobRetry(job, err.message, knex, wid);
      } catch (markErr) {
        logger.warn(`[contact-correction-queue] retry mark failed for job ${job.id}: ${markErr.message}`);
      }
    }
  }
  return summary;
}

module.exports = {
  reserveContactCorrectionJob,
  attachContactCorrectionContext,
  enqueueContactCorrectionJob,
  cancelContactCorrectionJob,
  kickContactCorrectionQueue,
  processDueContactCorrectionJobs,
  _internals: {
    tail10,
    claimDueContactCorrectionJobs,
    promoteStaleReservations,
    recoverStaleLocks,
    runContactCorrectionJob,
    rebaseSnapshot,
  },
};
