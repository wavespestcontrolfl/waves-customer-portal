/**
 * Stripe email sync (owner 2026-11-27 "build"): after a customer confirms a new email in the app, their linked Stripe
 * customer gets the same email. The work is a durable row (stripe_email_sync_jobs) written in the confirm's own
 * transaction; drainDue() runs every minute (scheduler.js).
 *
 * Conservative by design: the app only writes a Stripe profile it can prove belongs to this one record.
 *  - Locks: the customer row FOR UPDATE first (the confirm's order: it updates the customer, then inserts the job), then
 *    the job, both held through one short Stripe call (10 s, no SDK retries). A merge or its undo must lock this
 *    customer row to move its Stripe id, so nothing moves between the checks and the write.
 *  - Skipped with an office alert: a Stripe id another record also holds or another record's saved card uses, and any
 *    record that was ever part of a merge (either side). Merges move Stripe profiles between records; the office sorts
 *    those out by hand instead of the app guessing.
 *  - No Stripe profile yet: re-checked twice a few minutes apart (a profile being created at the moment of the change
 *    links within seconds and was made with the old email), then finished.
 *  - Stripe errors retry with backoff; after MAX_ATTEMPTS the office gets an alert.
 */
const db = require('../models/db');
const logger = require('./logger');

const TABLE = 'stripe_email_sync_jobs';
const MAX_ATTEMPTS = 6;
const STRIPE_TIMEOUT_MS = 10000;
const MERGE_RETIRED_PHONE_PREFIX = 'merged-';

// Queue a job on the caller's transaction handle. A pending job for this customer is re-armed instead (a fresh change
// gets a fresh retry budget, and the job reads the newest email anyway). The caller holds the customer row lock (it
// just wrote the row), so two callers cannot both insert.
async function enqueue(trx, customerId, source) {
  const rearmed = await trx(TABLE).where({ customer_id: customerId, status: 'pending' })
    .update({ attempts: 0, last_error: null, source, next_attempt_at: trx.fn.now(), updated_at: trx.fn.now() });
  if (!rearmed) await trx(TABLE).insert({ customer_id: customerId, source });
}

const NOT_LINKED_RECHECKS = 2;
const NOT_LINKED_RECHECK_MINUTES = 3;

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
  merged: {
    why: 'This record was part of a customer merge, so the app left its Stripe email alone.',
    next: 'Check which customer record owns this Stripe profile, then fix the Stripe email by hand only if it is wrong.',
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
    if (!customer.stripe_customer_id) {
      if (job.attempts < NOT_LINKED_RECHECKS) {
        await trx(TABLE).where({ id: job.id }).update({
          attempts: job.attempts + 1, last_error: 'not_linked', updated_at: trx.fn.now(),
          next_attempt_at: trx.raw(`now() + (? * interval '1 minute')`, [NOT_LINKED_RECHECK_MINUTES]),
        });
        return 'recheck';
      }
      await finish(trx, job, 'done', 'not_linked');
      return 'not_linked';
    }
    const email = String(customer.email || '').trim();
    if (!email) { await finish(trx, job, 'done', 'no_email'); return 'no_email'; }
    const merged = await trx('customer_merge_journal')
      .where((q) => q.where({ winner_customer_id: customer.id }).orWhere({ loser_customer_id: customer.id })).first('id');
    if (merged) {
      await finish(trx, job, 'skipped', 'merged');
      await alertOffice(trx, job, customer, 'merged');
      return 'merged';
    }
    // Shared ownership, checked without locking other rows (locking them after our own row could invert a merge's
    // sorted lock order): another customer row on the same Stripe id, or another customer's saved card on it (the
    // merge code treats a card as ownership evidence). Either way the job is skipped and the office decides.
    const otherRow = await trx('customers').where({ stripe_customer_id: customer.stripe_customer_id })
      .whereNot({ id: customer.id }).first('id');
    const otherCard = otherRow ? null : await trx('payment_methods').where({ stripe_customer_id: customer.stripe_customer_id })
      .whereNot({ customer_id: customer.id }).first('id');
    if (otherRow || otherCard) {
      await finish(trx, job, 'skipped', 'shared');
      await alertOffice(trx, job, customer, 'shared');
      return 'shared';
    }
    const StripeService = require('./stripe');
    let outcome;
    try {
      outcome = await StripeService.updateCustomerEmail(customer.stripe_customer_id, email, { timeout: STRIPE_TIMEOUT_MS, maxNetworkRetries: 0 });
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
    if (outcome === 'not_configured') return 'not_configured'; // untouched: a process with a key takes it (drainDue)
    await finish(trx, job, 'done', 'updated');
    return 'updated';
  });
}

async function drainDue({ limit = 20 } = {}) {
  // A process with no Stripe key claims nothing, so it can never delay a job a configured process would send.
  if (!require('../config/stripe-config').secretKey) return {};
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
