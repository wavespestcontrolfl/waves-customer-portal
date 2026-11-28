/**
 * Stripe email sync (owner 2026-11-27 "build"): after a customer confirms a new email in the app, their linked Stripe
 * customer gets the same email. The work is a durable row (stripe_email_sync_jobs) written in the confirm's own
 * transaction; drainDue() runs every minute (scheduler.js).
 *
 * Conservative by design: the app only writes a Stripe profile it can prove belongs to this one record.
 *  - Locks: two short transactions with NO DB lock held across Stripe HTTP. Transaction 1 locks the customer row FOR
 *    UPDATE first (the confirm's order: customer, then job), runs local ownership/supersession checks, leases the job
 *    for 2 minutes, and commits so concurrent edits/payments never stall on Stripe latency. After the bounded Stripe
 *    calls (10 s, no SDK retries), Transaction 2 re-locks customer then job, re-checks whether a newer email write or
 *    merge superseded the job while Stripe was in flight, and commits the outcome.
 *  - Skipped with an office alert: a Stripe id another record also holds, another record's saved card uses, or a
 *    third-party payer holds; a record whose own saved cards point at another Stripe profile; a Stripe profile whose
 *    own record (metadata) does not name this customer; and any
 *    LINKED record that was ever part of a merge (either side). Merges move Stripe profiles between records; the office
 *    sorts those out by hand instead of the app guessing. A record with no Stripe profile has nothing in Stripe to fix,
 *    so a merged one gets no alert: its job finishes as not_linked (a profile made later is created with the email on
 *    file then).
 *  - No Stripe profile yet: re-checked over about an hour (2, 4, 8, 16, 32 minutes), then finished. A profile being
 *    created at the moment of the change was made with the old email and links when its create call returns; that
 *    call is bounded by the Stripe client's timeout and retries (minutes at most), so the last re-check sees the link.
 *  - Stripe errors retry with backoff; after MAX_ATTEMPTS the office gets an alert.
 */
const db = require('../models/db');
const logger = require('./logger');

const TABLE = 'stripe_email_sync_jobs';
const MAX_ATTEMPTS = 6; // Stripe errors after the profile is linked (not-linked re-checks count apart)
const STRIPE_TIMEOUT_MS = 10000;
const { isMergeRetiredRow } = require('./merge-retired');

// Queue a job on the caller's transaction handle for the address the customer just confirmed. Every confirm gets its
// own job (a merge or its undo can move jobs between records by id): an older job whose address the record no longer
// holds finishes as superseded, so only the newest confirmed address ever reaches Stripe.
async function enqueue(trx, customerId, email, source) {
  await trx(TABLE).insert({ customer_id: customerId, email: String(email || '').trim(), source });
}

const NOT_LINKED_RECHECKS = 5;

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
  card_conflict: {
    why: "This record's saved cards use a different Stripe profile, so the app left Stripe alone.",
    next: 'Check which Stripe profile is right for this customer, then fix its email by hand only if it is wrong.',
  },
  stripe_owner: {
    why: 'The Stripe profile linked to this record does not name it as the owner, so the app left it alone.',
    next: 'Check which customer the Stripe profile belongs to and fix the link first. Change its email by hand only after that.',
  },
  merged: {
    why: 'This record was part of a customer merge, so the app left its Stripe email alone.',
    next: 'Check which customer record owns this Stripe profile, then fix the Stripe email by hand only if it is wrong.',
  },
  gave_up: {
    why: 'The app could not confirm the new email in Stripe after several tries.',
    next: 'First confirm in Stripe that the profile belongs to this customer. Only then compare its email with the record, and fix it if they differ.',
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

async function giveUp(trx, job, customer) {
  try {
    await trx.transaction((sp) => alertOffice(sp, job, customer, 'gave_up'));
  } catch (err) {
    logger.warn(`[stripe-email-sync] give-up alert for job ${job.id} not written; retrying the alert only: ${err.code || err.name || 'error'}`);
    await trx(TABLE).where({ id: job.id }).update({ next_attempt_at: trx.raw("now() + interval '15 minutes'"), updated_at: trx.fn.now() });
    return 'alert_retry';
  }
  await finish(trx, job, 'failed', 'gave_up');
  return 'gave_up';
}

// The ownership checks that stop a write and hand the case to the office, in order. Each answers true when this record
// cannot be shown to be the one owner of its Stripe profile. Checked without locking other rows (locking them after
// our own row could invert a merge's sorted lock order).
const OWNERSHIP_CHECKS = {
  // The record's own saved cards must agree with its link: a card on another Stripe profile (or cards on a profile
  // the record does not link) means ownership is unclear.
  card_conflict: async (trx, c) => (await trx('payment_methods').where({ customer_id: c.id }).whereNotNull('stripe_customer_id')
    .select('stripe_customer_id')).some((r) => r.stripe_customer_id !== c.stripe_customer_id),
  // Merges move Stripe profiles between records: a record ever on either side is the office's.
  merged: async (trx, c) => Boolean(await trx('customer_merge_journal')
    .where((q) => q.where({ winner_customer_id: c.id }).orWhere({ loser_customer_id: c.id })).first('id')),
  // Another customer row, another customer's saved card (the merge code treats a card as ownership evidence), or a
  // third-party payer (its statements bill through the profile) on the same Stripe id.
  shared: async (trx, c) => Boolean(
    await trx('customers').where({ stripe_customer_id: c.stripe_customer_id }).whereNot({ id: c.id }).first('id')
    || await trx('payment_methods').where({ stripe_customer_id: c.stripe_customer_id }).whereNot({ customer_id: c.id }).first('id')
    || await trx('payers').where({ stripe_customer_id: c.stripe_customer_id }).first('id')),
};

async function firstOwnershipProblem(trx, customer, names) {
  for (const name of names) {
    if (await OWNERSHIP_CHECKS[name](trx, customer)) return name;
  }
  return null;
}

// Customer first, then the job (the confirm's order). A peek finds the customer; the claim re-checks everything: still
// pending, still due (an overlapping drain may have just rescheduled it), still this customer's (a merge may have moved
// it). Null = busy, including a customer row another transaction holds (it reads as undefined under SKIP LOCKED).
// customer is null when the record no longer exists.
async function claim(trx, jobId) {
  const peek = await trx(TABLE).where({ id: jobId }).first('customer_id');
  if (!peek) return null;
  const customer = await trx('customers').where({ id: peek.customer_id }).forUpdate().skipLocked()
    .first('id', 'email', 'stripe_customer_id', 'deleted_at', 'phone');
  const job = await trx(TABLE).where({ id: jobId, status: 'pending', customer_id: peek.customer_id })
    .where('next_attempt_at', '<=', trx.fn.now()).forUpdate().skipLocked().first();
  if (!job) return null;
  if (customer) return { job, customer };
  return (await trx('customers').where({ id: peek.customer_id }).first('id')) ? null : { job, customer: null };
}

const normEmail = (v) => String(v || '').trim().toLowerCase();
// The Stripe profile's own record names this customer, and nobody else (no payer, not deleted).
const ownsProfile = (owner, customer) => !owner.deleted && !owner.payerId && String(owner.customerId) === String(customer.id);

// The Stripe side of one job: the profile's own record must name this customer (not a payer, not another customer,
// not deleted, not blank), so a stale local link that no other local row shares still cannot redirect someone else's
// profile. Stripe already holding the address (an earlier try that applied but lost its response) needs no second
// write; otherwise the write uses this attempt's own idempotency key. Answers 'updated', 'stripe_owner' or
// 'not_configured' (no Stripe key on this process); a Stripe error throws.
async function pushToStripe(job, customer, email) {
  const StripeService = require('./stripe');
  const opts = { timeout: STRIPE_TIMEOUT_MS, maxNetworkRetries: 0 };
  const owner = await StripeService.readCustomerOwner(customer.stripe_customer_id, opts);
  if (!owner) return 'not_configured';
  if (!ownsProfile(owner, customer)) return 'stripe_owner';
  if (normEmail(owner.email) === normEmail(email)) return 'updated';
  return StripeService.updateCustomerEmail(customer.stripe_customer_id, email,
    { ...opts, idempotencyKey: `stripe-email-sync:${job.id}:${customer.stripe_customer_id}:${job.attempts}` });
}

const STRIPE_LEASE_MINUTES = 2;
const STRIPE_EMAIL_SYNC_LOCK_NS = 'stripe.email.sync';

// Called by email writers (customer-email-write.js) and merges (customer-dedupe.js)
// AFTER acquiring customers FOR UPDATE: blocks until any in-flight Stripe email
// write for these customer(s) completes so older jobs cannot overwrite a newer
// confirmed email or write to a profile being transferred by a merge.
async function lockStripeEmailSync(trx, customerIds) {
  const ids = [...new Set((Array.isArray(customerIds) ? customerIds : [customerIds]).filter(Boolean).map(String))].sort();
  for (const id of ids) {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', [STRIPE_EMAIL_SYNC_LOCK_NS, id]);
  }
}

async function lockStripeEmailSyncOnEmailChange(trx, customerId, previousEmail, nextEmail) {
  if (nextEmail === undefined) return;
  if (normEmail(nextEmail) === normEmail(previousEmail)) return;
  await lockStripeEmailSync(trx, customerId);
}

async function scheduleJobLater(trx, jobId, minutes, patch = {}) {
  const updated = await trx(TABLE).where({ id: jobId }).update({
    ...patch,
    updated_at: trx.fn.now(),
    next_attempt_at: trx.raw("now() + (? * interval '1 minute')", [minutes]),
  }).returning([trx.raw('updated_at::text AS version')]);
  return updated?.[0]?.version || null;
}

async function finishJobOutcome(trx, job, customer, status, result, alert = false) {
  await finish(trx, job, status, result);
  if (alert) await alertOffice(trx, job, customer, result);
  return result;
}

async function claimForStripePhase(jobId) {
  return db.transaction(async (trx) => {
    const claimed = await claim(trx, jobId);
    if (!claimed) return { done: true, result: 'busy' };
    const { job, customer } = claimed;

    if (!customer || isMergeRetiredRow(customer)) {
      return { done: true, result: await finishJobOutcome(trx, job, customer, 'skipped', 'gone') };
    }
    // Only the address the customer confirmed goes to Stripe: a record that holds anything else now (an office edit
    // since) is left alone, before any other check, so a stale job never raises an alert.
    const email = String(job.email || '').trim();
    if (!email || normEmail(customer.email) !== normEmail(email)) {
      return { done: true, result: await finishJobOutcome(trx, job, customer, 'done', 'superseded') };
    }
    // Unlinked: the card check still runs (cards on a profile the record does not link), then re-checks for a link.
    const linked = Boolean(customer.stripe_customer_id);
    const problem = await firstOwnershipProblem(trx, customer, linked ? ['card_conflict', 'merged', 'shared'] : ['card_conflict']);
    if (problem) {
      return { done: true, result: await finishJobOutcome(trx, job, customer, 'skipped', problem, true) };
    }
    // A job whose Stripe tries ran out earlier but whose office alert could not be written: retry only the alert
    // (after the ownership checks above, so the alert never tells the office to edit a profile that became unsafe).
    if (job.attempts >= MAX_ATTEMPTS) {
      return { done: true, result: await giveUp(trx, job, customer) };
    }
    if (!linked) {
      const rechecks = job.not_linked_checks; // NOT NULL DEFAULT 0
      if (rechecks >= NOT_LINKED_RECHECKS) {
        return { done: true, result: await finishJobOutcome(trx, job, customer, 'done', 'not_linked') };
      }
      await scheduleJobLater(trx, job.id, 2 ** (rechecks + 1), { not_linked_checks: rechecks + 1 });
      return { done: true, result: 'recheck' };
    }

    // Lease the job briefly and release the DB transaction + customers FOR UPDATE
    // lock BEFORE calling Stripe HTTP so slow Stripe calls cannot block writes
    // on the customer row (payments/webhooks). The outer stripe.email.sync
    // advisory lock stays held to serialize against concurrent email edits & merges.
    const priorNextAttemptAt = job.next_attempt_at;
    const leasedVersion = await scheduleJobLater(trx, job.id, STRIPE_LEASE_MINUTES);
    return { done: false, job, customer, email, priorNextAttemptAt, leasedVersion };
  });
}

async function finalizeStripePhase({ job, customer, email, priorNextAttemptAt, outcome, stripeError }) {
  return db.transaction(async (trx) => {
    // Do NOT take customers FOR UPDATE here: the outer stripe.email.sync advisory
    // lock is still held while a waiting email writer or merge may hold customers
    // FOR UPDATE waiting for that advisory lock (taking FOR UPDATE here would ABBA).
    // No email edit or merge can commit until the advisory lock releases, so a
    // plain read of customers sees the exact serialized state.
    const liveCustomer = await trx('customers').where({ id: customer.id })
      .first('id', 'email', 'stripe_customer_id', 'deleted_at', 'phone');
    const liveJob = await trx(TABLE).where({ id: job.id, status: 'pending' }).forUpdate().first();
    if (!liveJob) return 'busy';
    if (!liveCustomer || isMergeRetiredRow(liveCustomer)) {
      return finishJobOutcome(trx, liveJob, liveCustomer, 'skipped', 'gone');
    }
    // A newer email write landed while the Stripe call was in flight: finish
    // quietly as superseded so a stale failure/owner mismatch never alerts or
    // overwrites newer work.
    if (normEmail(liveCustomer.email) !== normEmail(email)) {
      return finishJobOutcome(trx, liveJob, liveCustomer, 'done', 'superseded');
    }
    if (stripeError) {
      const attempts = liveJob.attempts + 1;
      const code = String(stripeError.code || stripeError.type || stripeError.name || 'stripe_error').slice(0, 80);
      await scheduleJobLater(trx, liveJob.id, backoffMinutes(attempts), { attempts, last_error: code });
      return attempts >= MAX_ATTEMPTS ? giveUp(trx, liveJob, liveCustomer) : 'retry';
    }
    if (outcome === 'not_configured') {
      // No Stripe key on this process: restore the prior schedule untouched.
      await trx(TABLE).where({ id: liveJob.id }).update({ next_attempt_at: priorNextAttemptAt });
      return 'not_configured';
    }
    if (outcome === 'stripe_owner') {
      return finishJobOutcome(trx, liveJob, liveCustomer, 'skipped', 'stripe_owner', true);
    }
    return finishJobOutcome(trx, liveJob, liveCustomer, 'done', 'updated');
  });
}

async function processJob(jobId) {
  const peek = await db(TABLE).where({ id: jobId }).first('customer_id');
  if (!peek) return 'busy';
  // Hold ONLY the non-blocking stripe.email.sync advisory lock across Stripe HTTP
  // (never customers FOR UPDATE): payments/webhooks never stall on Stripe latency,
  // while email edits and customer merges wait for any in-flight Stripe email write
  // to finish before mutating email or transferring Stripe profile ownership.
  return db.transaction(async (advisoryTrx) => {
    const lockRes = await advisoryTrx.raw(
      'SELECT pg_try_advisory_xact_lock(hashtext(?), hashtext(?::text)) AS locked',
      [STRIPE_EMAIL_SYNC_LOCK_NS, String(peek.customer_id)],
    );
    if (lockRes?.rows?.[0]?.locked === false) return 'busy';

    const step1 = await claimForStripePhase(jobId);
    if (step1.done) return step1.result;

    let outcome = null;
    let stripeError = null;
    try {
      outcome = await pushToStripe(step1.job, step1.customer, step1.email);
    } catch (err) {
      stripeError = err;
    }

    try {
      return await finalizeStripePhase({
        job: step1.job,
        customer: step1.customer,
        email: step1.email,
        priorNextAttemptAt: step1.priorNextAttemptAt,
        outcome,
        stripeError,
      });
    } catch (finErr) {
      if (step1.leasedVersion && finErr && typeof finErr === 'object') {
        finErr.leasedVersion = step1.leasedVersion;
      }
      throw finErr;
    }
  });
}

// Up to `limit` jobs a tick, oldest due first. A job whose customer row another transaction holds answers 'busy' and
// does not count: the drain moves past it (up to MAX_SCAN jobs a tick), so a few locked customers never starve the rest.
const MAX_SCAN = 200;
// A job that threw outside the Stripe call (its transaction rolled back): 15 minutes later, and a spent try. Past
// MAX_ATTEMPTS + WORKER_ERROR_GRACE such tries it stops as failed with a verify alert, whatever keeps failing.
const WORKER_ERROR_GRACE = 3;
async function pushBack(id, seen, err) {
  const [row] = await db(TABLE).where({ id, status: 'pending' }).whereRaw('updated_at::text = ?', [seen])
    .update({ attempts: db.raw('attempts + 1'), last_error: String(err.code || err.name || 'error').slice(0, 80), next_attempt_at: db.raw("now() + interval '15 minutes'"), updated_at: db.fn.now() })
    .returning(['id', 'customer_id', 'attempts']);
  if (!row || row.attempts < MAX_ATTEMPTS + WORKER_ERROR_GRACE) return;
  await db.transaction(async (trx) => {
    // Lock customer first, then job (matches claim / confirm order) and check
    // whether a newer email edit superseded or retired the customer before
    // raising a gave-up office alert.
    const customer = await trx('customers').where({ id: row.customer_id }).forUpdate()
      .first('id', 'email', 'deleted_at', 'phone');
    const job = await trx(TABLE).where({ id, status: 'pending' }).forUpdate().first();
    if (!job) return;
    if (!customer || isMergeRetiredRow(customer)) {
      await finish(trx, job, 'skipped', 'gone');
      return;
    }
    const email = String(job.email || '').trim();
    if (!email || normEmail(customer.email) !== normEmail(email)) {
      await finish(trx, job, 'done', 'superseded');
      return;
    }
    await alertOffice(trx, job, customer, 'gave_up');
    await finish(trx, job, 'failed', 'worker_error');
  });
}

// One drain at a time in this process: a slow batch (two short Stripe calls per job) must not stack minute ticks, each
// holding more database connections. Row locks still keep processes apart.
let draining = false;
async function drainDue(options) {
  if (draining) return { skipped_overlap: 1 };
  draining = true;
  try {
    return await drainOnce(options);
  } finally {
    draining = false;
  }
}

async function drainOnce({ limit = 20 } = {}) {
  // A process with no Stripe key claims nothing, so it can never delay a job a configured process would send.
  if (!require('../config/stripe-config').secretKey) return {};
  const counts = {};
  let processed = 0;
  // Every job tried this tick is excluded from the next page (a finished or rescheduled job leaves the due set anyway;
  // a busy one, or one whose push-back missed, must not be picked again).
  const tried = [];
  while (processed < limit && tried.length < MAX_SCAN) {
    let q = db(TABLE).where({ status: 'pending' }).where('next_attempt_at', '<=', db.fn.now());
    if (tried.length) q = q.whereNotIn('id', tried);
    const page = await q.orderBy('next_attempt_at').orderBy('id').limit(limit).select('id', db.raw('updated_at::text AS version'));
    if (!page.length) break;
    for (const { id, version: seen } of page) {
      tried.push(id);
      if (processed >= limit) break;
      try {
        const r = await processJob(id);
        counts[r] = (counts[r] || 0) + 1;
        if (r !== 'busy') processed += 1;
      } catch (err) {
        // Something outside the Stripe call failed (the transaction rolled back): push the job back so a row that keeps
        // failing never holds a place in every tick's batch. Best effort; a failure here is only logged.
        processed += 1;
        counts.error = (counts.error || 0) + 1;
        logger.warn(`[stripe-email-sync] job ${id} failed: ${err.code || err.name || 'error'}`);
        // Only the version this drain saw (or the committed lease version if
        // finalization threw after leasing): a job changed or rescheduled since
        // keeps its own schedule.
        await pushBack(id, err?.leasedVersion || seen, err).catch((e) => logger.warn(`[stripe-email-sync] could not push back job ${id}: ${e.code || e.name || 'error'}`));
      }
    }
    if (page.length < limit) break;
  }
  if (tried.length) logger.info(`[stripe-email-sync] tried ${tried.length}: ${JSON.stringify(counts)}`);
  return counts;
}

module.exports = { enqueue, processJob, drainDue, lockStripeEmailSync, lockStripeEmailSyncOnEmailChange, MAX_ATTEMPTS, TABLE };
