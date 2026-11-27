/**
 * Stripe email sync (owner 2026-11-27 "build"): after a customer's email changes, their linked Stripe customer gets the
 * same email. The work is a durable row (stripe_email_sync_jobs) written in the change's own transaction; drainDue()
 * runs every minute (scheduler.js).
 *
 * Fencing: each job runs in one transaction that locks the customer row FOR UPDATE first (the same order as an email
 * confirm, which updates the customer row and then inserts the job), then claims the job row, and holds both through
 * the Stripe call. Customer merges and their undo lock the customers rows they move a Stripe id between
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

// Queue a job on the caller's transaction handle, unless one is already pending for this customer (it will read the
// newest email anyway). The callers hold the customer row lock (they just wrote it), so two of them cannot both insert.
async function enqueue(trx, customerId, source) {
  await trx.raw(
    `INSERT INTO ${TABLE} (customer_id, source)
     SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM ${TABLE} WHERE customer_id = ? AND status = 'pending')`,
    [customerId, source, customerId],
  );
}

const backoffMinutes = (attempts) => Math.min(60, 2 ** attempts);

async function finish(trx, job, status, result) {
  await trx(TABLE).where({ id: job.id }).update({ status, result, finished_at: trx.fn.now(), updated_at: trx.fn.now() });
}

// Shared profile: the office must sort out WHICH record owns the Stripe profile before any email edit there.
const OFFICE_COPY = {
  shared: {
    why: 'Another customer record uses the same Stripe profile, so the app left its email alone.',
    next: 'Do not change the Stripe email yet. First work out which customer record owns this Stripe profile; the other record may need its own.',
  },
  gave_up: {
    why: 'Stripe did not take the new email after several tries.',
    next: 'Compare the Stripe profile email with the customer record now, and fix Stripe by hand only if they differ.',
  },
};

// One alert per job, written in the job's own transaction (it commits with the status change).
async function alertOffice(trx, job, customer, result) {
  await require('./admin-alert-compose').raiseAdminAlert('customer', {
    area: 'Customers',
    action: 'Stripe email not updated',
    why: OFFICE_COPY[result].why,
    severity: 'needs-you',
    link: `/admin/customers?customerId=${customer.id}`,
    subject: { type: 'customer', id: String(customer.id) },
    doneWhen: 'stripe_email_checked',
    who: 'person',
  }, {
    trx,
    bell: true,
    dedupeKey: `stripe_email_sync:${job.id}`,
    detail: `Email on the customer record: ${customer.email || 'none'}\n${OFFICE_COPY[result].next}`,
    metadata: { kind: 'stripe_email_sync', customerId: customer.id, result },
  });
}

async function processJob(jobId) {
  return db.transaction(async (trx) => {
    // Customer first, then the job (the confirm's order). A peek finds the customer; the claim re-checks everything.
    const peek = await trx(TABLE).where({ id: jobId }).first('customer_id');
    if (!peek) return 'busy';
    const customer = await trx('customers').where({ id: peek.customer_id }).forUpdate().skipLocked()
      .first('id', 'email', 'stripe_customer_id', 'deleted_at', 'phone');
    // The claim: still pending, still due (an overlapping drain may have just rescheduled it), still this customer's
    // (a merge may have moved it).
    const job = await trx(TABLE).where({ id: jobId, status: 'pending', customer_id: peek.customer_id })
      .where('next_attempt_at', '<=', trx.fn.now()).forUpdate().skipLocked().first();
    if (!job) return 'busy';
    if (customer === undefined && await trx('customers').where({ id: peek.customer_id }).first('id')) return 'busy';
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
