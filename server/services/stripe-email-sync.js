/**
 * Stripe email sync (owner 2026-11-27 "build"): after a customer's email changes, their linked Stripe customer gets the
 * same email. The work is a durable row (stripe_email_sync_jobs) written in the change's own transaction; drainDue()
 * runs every minute (scheduler.js).
 *
 * Fencing: each job runs in one transaction that locks the job row and the customer row FOR UPDATE and holds them
 * through the Stripe call. Customer merges and their undo lock the customers rows they move a Stripe id between
 * (customer-dedupe.js, sorted ids), so no transfer can land between the ownership check and the Stripe write. The email
 * is read under that lock, so the write always carries the address on file now; a later change re-queues the row.
 * A Stripe id that another customer row also holds (dedupe can leave two rows on one id) is never changed here: the job
 * is skipped and the office gets an alert. Errors retry with backoff; after MAX_ATTEMPTS the office gets an alert.
 * The Stripe call has a short timeout, so the row lock is held for seconds at most.
 */
const db = require('../models/db');
const logger = require('./logger');

const TABLE = 'stripe_email_sync_jobs';
const MAX_ATTEMPTS = 6;
const STRIPE_TIMEOUT_MS = 10000;
const MERGE_RETIRED_PHONE_PREFIX = 'merged-';

// Queue (or re-arm) the customer's one pending job, on the caller's transaction handle.
async function enqueue(trx, customerId, source) {
  await trx.raw(
    `INSERT INTO ${TABLE} (customer_id, source) VALUES (?, ?)
     ON CONFLICT (customer_id) WHERE status = 'pending'
     DO UPDATE SET next_attempt_at = now(), attempts = 0, last_error = NULL, updated_at = now()`,
    [customerId, source],
  );
}

const backoffMinutes = (attempts) => Math.min(60, 2 ** attempts);

async function finish(trx, job, status, result) {
  await trx(TABLE).where({ id: job.id }).update({ status, result, finished_at: trx.fn.now(), updated_at: trx.fn.now() });
}

const OFFICE_WHY = {
  shared: 'Another customer record uses the same Stripe profile, so the app left its email alone.',
  gave_up: 'Stripe did not take the new email after several tries.',
};

// One alert per job, written in the job's own transaction (it commits with the status change).
async function alertOffice(trx, job, customer, result) {
  await require('./admin-alert-compose').raiseAdminAlert('customer', {
    area: 'Customers',
    action: 'Stripe email not updated',
    why: OFFICE_WHY[result],
    severity: 'needs-you',
    link: `/admin/customers?customerId=${customer.id}`,
    subject: { type: 'customer', id: String(customer.id) },
    doneWhen: 'stripe_email_checked',
    who: 'person',
  }, {
    trx,
    bell: true,
    dedupeKey: `stripe_email_sync:${job.id}`,
    detail: `Email on the customer record: ${customer.email || 'none'}\nCompare the Stripe profile email with the customer record now, and fix Stripe by hand only if they differ.`,
    metadata: { kind: 'stripe_email_sync', customerId: customer.id, result },
  });
}

async function processJob(jobId) {
  return db.transaction(async (trx) => {
    const job = await trx(TABLE).where({ id: jobId, status: 'pending' }).forUpdate().skipLocked().first();
    if (!job) return 'busy';
    const customer = await trx('customers').where({ id: job.customer_id }).forUpdate()
      .first('id', 'email', 'stripe_customer_id', 'deleted_at', 'phone');
    if (!customer || (customer.deleted_at && String(customer.phone || '').startsWith(MERGE_RETIRED_PHONE_PREFIX))) {
      await finish(trx, job, 'skipped', 'gone');
      return 'gone';
    }
    if (!customer.stripe_customer_id) { await finish(trx, job, 'done', 'not_linked'); return 'not_linked'; }
    const email = String(customer.email || '').trim();
    if (!email) { await finish(trx, job, 'done', 'no_email'); return 'no_email'; }
    // Lock every other row on the same Stripe id too: none may move it while we decide.
    const others = await trx('customers').where({ stripe_customer_id: customer.stripe_customer_id })
      .whereNot({ id: customer.id }).orderBy('id').forUpdate().select('id');
    if (others.length) {
      await finish(trx, job, 'skipped', 'shared');
      await alertOffice(trx, job, customer, 'shared');
      return 'shared';
    }
    const StripeService = require('./stripe');
    let outcome;
    try {
      outcome = await StripeService.updateCustomerEmail(customer.stripe_customer_id, email, { timeout: STRIPE_TIMEOUT_MS });
    } catch (err) {
      const attempts = job.attempts + 1;
      const code = String(err.code || err.type || err.name || 'stripe_error').slice(0, 80);
      if (attempts >= MAX_ATTEMPTS) {
        await trx(TABLE).where({ id: job.id }).update({ attempts, last_error: code, status: 'failed', result: 'gave_up', finished_at: trx.fn.now(), updated_at: trx.fn.now() });
        await alertOffice(trx, job, customer, 'gave_up');
        return 'gave_up';
      }
      await trx(TABLE).where({ id: job.id }).update({
        attempts, last_error: code, updated_at: trx.fn.now(),
        next_attempt_at: trx.raw(`now() + (? * interval '1 minute')`, [backoffMinutes(attempts)]),
      });
      return 'retry';
    }
    if (outcome === 'not_configured') {
      // No Stripe key on this process: leave the job for a process that has one, without spending an attempt.
      await trx(TABLE).where({ id: job.id }).update({ next_attempt_at: trx.raw(`now() + interval '10 minutes'`), updated_at: trx.fn.now() });
      return 'not_configured';
    }
    await finish(trx, job, 'done', 'updated');
    return 'updated';
  });
}

async function drainDue({ limit = 20 } = {}) {
  const due = await db(TABLE).where({ status: 'pending' }).where('next_attempt_at', '<=', db.fn.now())
    .orderBy('next_attempt_at').limit(limit).pluck('id');
  const counts = {};
  for (const id of due) {
    try {
      const r = await processJob(id);
      counts[r] = (counts[r] || 0) + 1;
    } catch (err) {
      counts.error = (counts.error || 0) + 1;
      logger.warn(`[stripe-email-sync] job ${id} failed: ${err.code || err.name || 'error'}`);
    }
  }
  if (due.length) logger.info(`[stripe-email-sync] drained ${due.length}: ${JSON.stringify(counts)}`);
  return counts;
}

module.exports = { enqueue, processJob, drainDue, MAX_ATTEMPTS, TABLE };
