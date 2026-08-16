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

function workerId() {
  return `${os.hostname()}:${process.pid}`;
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
 * is ignored once the MessageSid claim is durable). Re-derive what the
 * live route would have done: intent regex still passes AND the sender
 * maps to a single customer → promote to queued (no match-time CAS
 * snapshot exists any more — expected_values stays null and the runner
 * falls back to its run-start read); otherwise cancel.
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
      const contactCorrection = require('./contact-correction');
      if (!job.body || !contactCorrection.detectContactCorrectionIntent(job.body)) {
        await cancelContactCorrectionJob(job.id, 'stale_no_intent', { knex });
        continue;
      }
      const { findSingleCustomerByPhone } = require('../routes/twilio-webhook');
      const customer = await findSingleCustomerByPhone(job.sender_phone || job.sender_key);
      if (!customer?.id) {
        await cancelContactCorrectionJob(job.id, 'stale_unlinked', { knex });
        continue;
      }
      const smsLog = job.message_sid
        ? await knex('sms_log')
          .where({ twilio_sid: job.message_sid, direction: 'inbound' })
          .orderBy('created_at', 'desc')
          .first('id')
        : null;
      const enqueued = await enqueueContactCorrectionJob(job.id, {
        customerId: customer.id,
        smsLogId: smsLog?.id || null,
        knex,
      });
      if (enqueued) promoted += 1;
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

async function markJobDone(job, result, knex) {
  await knex('contact_correction_jobs')
    .where({ id: job.id })
    .update({
      status: 'done',
      result: result ? JSON.stringify(result) : null,
      completed_at: knex.fn.now(),
      locked_at: null,
      locked_by: null,
      last_error: null,
      updated_at: knex.fn.now(),
    });
}

async function markJobRetry(job, errMessage, knex) {
  const attempts = Number(job.attempts || 0);
  const maxAttempts = Number(job.max_attempts || DEFAULT_MAX_ATTEMPTS);
  const terminal = attempts >= maxAttempts;
  const delayMinutes = Math.min(30, Math.pow(2, Math.max(0, attempts - 1)));
  await knex('contact_correction_jobs')
    .where({ id: job.id })
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
}

async function runContactCorrectionJob(job, knex) {
  const contactCorrection = require('./contact-correction');
  const customer = job.customer_id
    ? await knex('customers').where({ id: job.customer_id }).whereNull('deleted_at').first()
    : null;
  if (!customer) {
    await markJobDone(job, { applied: [], skipped: [], reason: 'customer_missing' }, knex);
    return { ok: true, reason: 'customer_missing' };
  }
  // The runner is fail-soft (never throws; internal errors come back as
  // reason 'error'). Retry only that internal-error shape — every other
  // outcome (gate_off, no_corrections, applied, CAS-skipped, …) is final.
  const result = await contactCorrection.runSmsContactCorrection({
    customer,
    body: job.body,
    smsLogId: job.sms_log_id || null,
    senderPhone: job.sender_phone || null,
    // pg parses jsonb to an object; anything else (older drivers, stubs)
    // falls back to the runner's run-start read.
    matchedSnapshot: (job.expected_values && typeof job.expected_values === 'object') ? job.expected_values : null,
  });
  if (result?.reason === 'error') {
    await markJobRetry(job, 'runner reported internal error', knex);
    return { ok: false, reason: 'error' };
  }
  await markJobDone(job, result, knex);
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
  let jobs = [];
  try {
    jobs = await claimDueContactCorrectionJobs({ limit, knex });
  } catch (err) {
    logger.warn(`[contact-correction-queue] claim failed: ${err.message}`);
    return summary;
  }
  summary.claimed = jobs.length;
  for (const job of jobs) {
    try {
      const res = await runContactCorrectionJob(job, knex);
      if (res.ok) summary.succeeded += 1; else summary.failed += 1;
    } catch (err) {
      summary.failed += 1;
      try {
        await markJobRetry(job, err.message, knex);
      } catch (markErr) {
        logger.warn(`[contact-correction-queue] retry mark failed for job ${job.id}: ${markErr.message}`);
      }
    }
  }
  return summary;
}

module.exports = {
  reserveContactCorrectionJob,
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
  },
};
