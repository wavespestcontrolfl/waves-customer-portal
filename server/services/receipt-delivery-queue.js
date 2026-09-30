const os = require('os');
const { randomUUID } = require('crypto');
const db = require('../models/db');
const logger = require('./logger');

const QUEUED_STATUSES = ['queued', 'retry_scheduled'];
const STALE_LOCK_MINUTES = 10;
const DEFAULT_MAX_ATTEMPTS = 5;
// The job's Text leg is not owed: the combined-visit summary text carries this receipt's
// link (visit-completion-summary.js). Set on the still-queued job at closeout, read by the
// worker like any other expected text skip, and kept through its retries (sms_result).
const TEXT_CARRIED_BY_SUMMARY = 'carried_by_visit_summary';

function workerId() {
  return `${os.hostname()}:${process.pid}`;
}

function normalizeJobRow(row) {
  return {
    ...row,
    attempts: Number(row.attempts || 0),
    max_attempts: Number(row.max_attempts || DEFAULT_MAX_ATTEMPTS),
  };
}

async function enqueueReceiptDelivery({
  invoiceId,
  stripePaymentIntentId = null,
  source = 'stripe_webhook',
  nextAttemptAt = new Date(),
  // Payment provenance for the receipt SMS's quiet-hours decision (owner
  // ruling 2026-08-29 + Codex P1 on PR #3598): true only when the enqueue
  // site KNOWS the payment was the customer's own action (Pay routes; the
  // succeeded webhook checks the PI's machine markers). Default false is
  // fail-closed — unstamped rows are treated as machine charges and their
  // receipt text waits for the 8AM window.
  customerInitiated = false,
  // A caller settling inside its own transaction passes it so the job row
  // commits WITH the payment (the Zelle reconciler: a settlement whose
  // receipt job was lost after commit would have no retry path).
  database = db,
} = {}) {
  if (!invoiceId) return { enqueued: false, reason: 'missing_invoice_id' };

  const row = {
    invoice_id: invoiceId,
    stripe_payment_intent_id: stripePaymentIntentId || null,
    source,
    status: 'queued',
    next_attempt_at: nextAttemptAt,
    attempts: 0,
    max_attempts: DEFAULT_MAX_ATTEMPTS,
    customer_initiated: customerInitiated === true,
    updated_at: db.fn.now(),
  };

  // The row is normally the dedupe. One exception: a live claim row an
  // operator send created (claimReceiptJobForOperatorSend, source
  // 'operator_send', still running) takes this request over, so releasing the claim after
  // an undelivered email re-queues it instead of deleting the only job.
  const inserted = await database('receipt_delivery_jobs')
    .insert(row)
    .onConflict(['invoice_id'])
    .merge({
      source: row.source,
      stripe_payment_intent_id: row.stripe_payment_intent_id,
      next_attempt_at: row.next_attempt_at,
      customer_initiated: row.customer_initiated,
      updated_at: row.updated_at,
    })
    .where('receipt_delivery_jobs.source', 'operator_send')
    .where('receipt_delivery_jobs.status', 'running')
    .returning('*');

  if (inserted?.[0]) return { enqueued: true, job: inserted[0] };
  return { enqueued: false, deduped: true };
}

async function recoverStaleLocks({ invoiceId = null } = {}) {
  // invoiceId scopes every statement to one invoice's job (the operator
  // claim settles a stale row this way before claiming it).
  const scoped = (q) => (invoiceId ? q.where('receipt_delivery_jobs.invoice_id', invoiceId) : q);
  // Stale operator claims (claimReceiptJobForOperatorSend) were never handed
  // back — a failed release, or a process that died mid-send — and are
  // settled before the generic requeue below:
  const staleOperatorClaims = () => scoped(db('receipt_delivery_jobs'))
    .where({ status: 'running' })
    .where('locked_at', '<', db.raw(`now() - interval '${STALE_LOCK_MINUTES} minutes'`))
    .where('locked_by', 'like', 'operator:%');
  const ownEmailSent = "email_result->>'operator_claim' = locked_by";
  const ownSmsSent = "sms_result->>'operator_claim' = locked_by";
  // 1. Any leg the claim itself delivered (recordOperatorReceiptDelivered)
  //    stamps the invoice receipted — it may have died before its own stamp
  //    — so a job requeued below never texts the receipt again.
  await db('invoices')
    .whereNull('receipt_sent_at')
    .whereIn('id', staleOperatorClaims().whereRaw(`(${ownEmailSent} OR ${ownSmsSent})`).select('invoice_id'))
    .update({ receipt_sent_at: db.fn.now() });
  // 2. The claim's own email went out: the job is closed too — requeueing
  //    would email the receipt again. (Text only: it falls through to the
  //    rules below, since a queued job may still owe its email.)
  const closedDelivered = await staleOperatorClaims()
    .whereRaw(ownEmailSent)
    .update({
      status: 'completed',
      completed_at: db.fn.now(),
      last_error: 'operator receipt claim was not released after its email was sent',
      locked_at: null,
      locked_by: null,
      updated_at: db.fn.now(),
    });
  // 3. A row the claim itself created, which no enqueue took over: no
  //    automatic receipt was ever owed, so it goes away rather than becoming
  //    one (the operator's failed request is theirs to retry).
  await staleOperatorClaims().where({ source: 'operator_send' }).del();
  // Everything else stale — a drain worker's job, or a queued job an
  // operator held — may still owe its email and is requeued.
  const requeued = await scoped(db('receipt_delivery_jobs'))
    .where({ status: 'running' })
    .where('locked_at', '<', db.raw(`now() - interval '${STALE_LOCK_MINUTES} minutes'`))
    .update({
      status: 'retry_scheduled',
      locked_at: null,
      locked_by: null,
      next_attempt_at: db.fn.now(),
      updated_at: db.fn.now(),
    });
  return { requeued, closedDelivered };
}

async function claimDueReceiptDeliveryJobs({ limit = 10, id = workerId() } = {}) {
  return db.transaction(async (trx) => {
    const rows = await trx('receipt_delivery_jobs')
      .whereIn('status', QUEUED_STATUSES)
      .where('next_attempt_at', '<=', trx.fn.now())
      .orderBy('next_attempt_at', 'asc')
      .orderBy('created_at', 'asc')
      .limit(limit)
      .forUpdate()
      .skipLocked();

    const ids = rows.map((row) => row.id);
    if (!ids.length) return [];

    const claimed = await trx('receipt_delivery_jobs')
      .whereIn('id', ids)
      .update({
        status: 'running',
        locked_at: trx.fn.now(),
        locked_by: id,
        attempts: trx.raw('attempts + 1'),
        updated_at: trx.fn.now(),
      })
      .returning('*');

    return claimed.map(normalizeJobRow);
  });
}

function expectedEmailSkip(result) {
  // 'receipt_opted_out' is the payment_receipt=false kill switch (migration
  // 104) — the customer opted out of payment receipts entirely, so the email
  // leg is skipped on purpose, exactly like the no-recipient case. The
  // portal-wide email switch never skips a receipt email (owner ruling
  // 2026-09-26: payment emails cannot be turned off).
  return result?.error === 'No receipt recipient email'
    || result?.error === 'receipt_opted_out'
    || result?.error === 'billing_email_not_selected';
}

function actionableSmsFailure(result) {
  // 'payer_billed' is an intentional suppression (third-party Bill-To invoices
  // never text the homeowner a receipt), not a delivery failure — treat it like
  // the other expected skips so the queue doesn't retry/fail the job forever.
  // 'channel_email_only' is the customer's payment_receipt_channel='email'
  // preference: the email leg below carries the receipt.
  // 'receipt_texts_opted_out' is the payment_receipt /
  // payment_confirmation_sms opt-out — also the customer's own choice.
  // 'sms_suppressed' is a STOP-style opt-out (suppression row or
  // sms_enabled=false) — permanent until the customer texts START, so a
  // retry can never deliver it.
  return result?.sent === false && !['already-sent', 'no-phone', 'payer_billed', 'channel_email_only', 'receipt_texts_opted_out', 'sms_suppressed', TEXT_CARRIED_BY_SUMMARY].includes(result.reason);
}

function actionableEmailFailure(result) {
  return result && result.ok === false && !expectedEmailSkip(result);
}

function receiptChannelChoiceChanged(smsResult, emailResult) {
  return smsResult?.sent === false && smsResult.reason === 'channel_email_only'
    && emailResult?.ok === false && emailResult.error === 'billing_email_not_selected';
}

function shouldRetryReceiptDelivery({ smsResult = null, emailResult = null } = {}) {
  return receiptChannelChoiceChanged(smsResult, emailResult)
    || actionableSmsFailure(smsResult) || actionableEmailFailure(emailResult);
}

function receiptDeliveryFailureError({ smsResult = null, emailResult = null } = {}) {
  if (receiptChannelChoiceChanged(smsResult, emailResult)) {
    return new Error('Receipt delivery preferences changed between channel checks');
  }
  const smsReason = actionableSmsFailure(smsResult) ? (smsResult.reason || 'unknown') : 'ok';
  const emailReason = actionableEmailFailure(emailResult) ? (emailResult.error || 'unknown') : 'ok';
  return new Error(`receipt channel failed: sms=${smsReason} email=${emailReason}`);
}

async function markJobCompleted(job, { smsResult, emailResult }) {
  await db('receipt_delivery_jobs')
    .where({ id: job.id })
    .update({
      status: 'completed',
      sms_result: smsResult || null,
      email_result: emailResult || null,
      completed_at: db.fn.now(),
      locked_at: null,
      locked_by: null,
      last_error: null,
      updated_at: db.fn.now(),
    });
}

// The customer's receipt link rides the visit summary text, and the receipt email that
// backs it up did not go (or the job gave up): the office is told, one alert per invoice.
async function alertCarriedReceiptEmail(job, reason) {
  try {
    await require('./notification-service').notifyAdmin(
      'alert',
      'Receipt email did not go out',
      `Invoice ${job.invoice_id}: its receipt link was sent only in the visit summary text, and the receipt email did not go (${reason}). Check that the customer has the receipt, or resend it.`,
      { link: '/admin/invoices', metadata: { dedupeKey: `summary-carried-receipt-email:${job.invoice_id}`, invoice_id: job.invoice_id } },
    );
  } catch (err) {
    logger.warn(`[receipt-delivery-queue] carried-receipt email alert failed for invoice ${job.invoice_id}: ${err.message}`);
  }
}

async function markJobRetry(job, err, { smsResult = null, emailResult = null } = {}) {
  // Send-window hold: not a delivery failure. Schedule the retry exactly at
  // the window open and REFUND the claimed attempt — an after-8PM payment's
  // receipt must go out at 8:00 AM, not burn the whole backoff ladder
  // overnight and land permanently 'failed' before the window ever opens.
  const holdAt = smsResult?.code === 'QUIET_HOURS_HOLD' && smsResult?.nextAllowedAt
    ? new Date(smsResult.nextAllowedAt)
    : null;
  if (holdAt && !Number.isNaN(holdAt.getTime()) && holdAt.getTime() > Date.now()) {
    await db('receipt_delivery_jobs')
      .where({ id: job.id })
      .update({
        status: 'retry_scheduled',
        sms_result: smsResult,
        email_result: emailResult,
        last_error: err?.message || 'receipt SMS held for send window',
        attempts: db.raw('GREATEST(attempts - 1, 0)'),
        next_attempt_at: holdAt,
        locked_at: null,
        locked_by: null,
        updated_at: db.fn.now(),
      });
    return;
  }
  const attempts = Number(job.attempts || 0);
  const maxAttempts = Number(job.max_attempts || DEFAULT_MAX_ATTEMPTS);
  const terminal = attempts >= maxAttempts;
  if (terminal && (smsResult?.reason === TEXT_CARRIED_BY_SUMMARY || job.sms_result?.reason === TEXT_CARRIED_BY_SUMMARY)) {
    await alertCarriedReceiptEmail(job, err?.message || 'gave up after its retries');
  }
  const delayMinutes = Math.min(60, Math.pow(2, Math.max(0, attempts - 1)) * 5);
  await db('receipt_delivery_jobs')
    .where({ id: job.id })
    .update({
      status: terminal ? 'failed' : 'retry_scheduled',
      sms_result: smsResult,
      email_result: emailResult,
      last_error: err?.message || String(err || 'receipt delivery failed'),
      next_attempt_at: terminal
        ? db.fn.now()
        : db.raw(`now() + interval '${delayMinutes} minutes'`),
      locked_at: null,
      locked_by: null,
      updated_at: db.fn.now(),
    });
}

// payment_receipt=false is the full receipt kill switch (migration 104):
// the customer opted out of payment receipts on EVERY channel, not just
// texts. Payer-billed invoices are exempt: their receipt goes to the
// third-party payer's AP inbox, which the homeowner's prefs don't govern. A
// transient lookup failure must NOT read as "no opt-out" (that would email a
// kill-switch customer on a DB blip) — it comes back as prefsLookupFailed.
// Shared by the worker below and the Intelligence Bar closeout repair's card.
async function receiptEmailOptOutState(invoice) {
  if (invoice.payer_id) return { receiptKillSwitch: false, prefsLookupFailed: false };
  let prefsLookupFailed = false;
  const prefs = await db('notification_prefs')
    .where({ customer_id: invoice.customer_id })
    .first()
    .catch(() => {
      prefsLookupFailed = true;
      return null;
    });
  return { receiptKillSwitch: prefs?.payment_receipt === false, prefsLookupFailed };
}

async function processReceiptDeliveryJob(job) {
  // A Text leg the visit summary carries is decided before any fallible read,
  // so a retry after an early failure (invoice lookup) keeps that decision.
  let smsResult = job.sms_result?.reason === TEXT_CARRIED_BY_SUMMARY
    ? { sent: false, reason: TEXT_CARRIED_BY_SUMMARY }
    : null;
  let emailResult = null;
  try {
    const invoice = await db('invoices').where({ id: job.invoice_id }).first();
    if (!invoice) {
      await markJobRetry(job, new Error(`invoice ${job.invoice_id} not found`), { smsResult, emailResult });
      return { ok: false, terminal: true, reason: 'invoice_not_found' };
    }

    const InvoiceService = require('./invoice');
    const { sendReceiptEmail } = require('./invoice-email');

    smsResult = smsResult?.reason === TEXT_CARRIED_BY_SUMMARY
      ? smsResult
      : await InvoiceService.sendReceipt(invoice.id, {
      hasEmailLeg: true,
      // Persisted payment provenance (see enqueueReceiptDelivery): a
      // customer-initiated payment's receipt sends at any hour; a machine
      // charge's receipt holds for the window and reschedules below.
      customerInitiated: job.customer_initiated === true,
    })
      .catch((err) => ({
        sent: false,
        reason: err.message,
        // Send-window hold metadata (code + window-open time) rides through
        // so markJobRetry schedules the retry at 8:00 AM instead of the
        // generic backoff ladder.
        ...(err.code ? { code: err.code } : {}),
        ...(err.nextAllowedAt ? { nextAllowedAt: err.nextAllowedAt } : {}),
      }));
    if (actionableSmsFailure(smsResult)) {
      logger.warn(`[receipt-delivery-queue] Receipt SMS not sent for invoice ${invoice.invoice_number}: ${smsResult.reason}`);
    }

    // payment_receipt=false is the full receipt kill switch (migration 104):
    // the customer opted out of payment receipts on EVERY channel, not just
    // texts — the estimate-deposit / no-show-fee email legs already honor it
    // explicitly. Without this gate a kill-switch customer's SMS leg returns
    // the expected 'receipt_texts_opted_out' skip while the email leg still
    // delivers. Payer-billed invoices are exempt: their receipt goes to the
    // third-party payer's AP inbox, which the homeowner's prefs don't govern.
    // No receipt_sent_at stamp on this path (the stamp below requires a
    // delivered email) — nothing was sent. The receipt channel choice is read
    // by the shared billing email authority inside sendReceiptEmail (owner
    // ruling 2026-09-27), which reports an unselected Email as the expected
    // 'billing_email_not_selected' skip.
    const { receiptKillSwitch, prefsLookupFailed } = await receiptEmailOptOutState(invoice);
    // The email leg is deliberately NOT gated on payment_receipt_channel:
    // migration 104 seeded 'sms' as the column DEFAULT on every existing row,
    // so "channel === 'sms'" cannot distinguish a customer who chose Text in
    // the new dropdown from one who never touched it — gating here would
    // silently stop the receipt/PDF email for every default customer's paid
    // invoice. The dropdown governs the SMS leg (via the consent gate); the
    // emailed PDF receipt is the durable payment record and always sends
    // unless the payment_receipt kill switch is off.
    emailResult = prefsLookupFailed
      ? { ok: false, error: 'receipt prefs lookup failed' }
      : receiptKillSwitch
        ? { ok: false, error: 'receipt_opted_out' }
        : await sendReceiptEmail(invoice.id, {
          idempotencyKey: `receipt_email_auto:${invoice.id}`,
          billingDeliveryCategory: 'payment_receipt',
        }).catch((err) => ({ ok: false, error: err.message }));
    if (actionableEmailFailure(emailResult)) {
      logger.warn(`[receipt-delivery-queue] Receipt email not sent for invoice ${invoice.invoice_number}: ${emailResult.error || 'unknown'}`);
    }

    if (shouldRetryReceiptDelivery({ smsResult, emailResult })) {
      throw receiptDeliveryFailureError({ smsResult, emailResult });
    }

    // Third-party Bill-To: a payer-billed receipt skips the homeowner SMS path
    // (InvoiceService.sendReceipt returns `payer_billed` before it stamps
    // receipt_sent_at), so stamp it here when the payer AP email delivered.
    // Otherwise the invoice stays in the `needs_receipt` filter forever and a
    // batch/manual resend texts/emails the AP a duplicate receipt. Same for a
    // customer whose payment_receipt_channel is email-only, who opted out
    // of receipt texts, or whose SMS is STOP-suppressed — the delivered
    // email receipt IS the receipt.
    if (['payer_billed', 'channel_email_only', 'receipt_texts_opted_out', 'sms_suppressed', TEXT_CARRIED_BY_SUMMARY].includes(smsResult?.reason) && emailResult?.ok && !invoice.receipt_sent_at) {
      await db('invoices')
        .where({ id: invoice.id })
        .whereNull('receipt_sent_at')
        .update({ receipt_sent_at: db.fn.now() })
        .catch((e) => logger.warn(`[receipt-delivery-queue] receipt_sent_at stamp failed for ${invoice.invoice_number}: ${e.message}`));
    }

    // A job that completes without its email (an expected skip: no recipient, opted out, the
    // choice no longer selecting Email) while its Text leg is carried by the summary.
    if (smsResult?.reason === TEXT_CARRIED_BY_SUMMARY && !emailResult?.ok) {
      await alertCarriedReceiptEmail(job, emailResult?.error || 'skipped');
    }
    await markJobCompleted(job, { smsResult, emailResult });
    return { ok: true, sms: smsResult, email: emailResult };
  } catch (err) {
    await markJobRetry(job, err, { smsResult, emailResult });
    return { ok: false, error: err.message };
  }
}

async function processDueReceiptDeliveryJobs({ limit = 10, id = workerId() } = {}) {
  const { requeued: recovered } = await recoverStaleLocks();
  const jobs = await claimDueReceiptDeliveryJobs({ limit, id });
  let succeeded = 0;
  let failed = 0;
  for (const job of jobs) {
    const result = await processReceiptDeliveryJob(job);
    if (result.ok) succeeded += 1;
    else failed += 1;
  }
  return { recovered, claimed: jobs.length, succeeded, failed };
}

// An operator's send-now of a paid invoice's receipt (the single resend, the
// batch send, record-payment's inline receipt) runs outside this queue. A job
// queued for the same invoice (the payment webhook's, the Intelligence Bar
// closeout repair's) would deliver a second receipt around it. The invoice's
// one job row (unique on invoice_id) is the shared claim: the operator send
// takes it as `running` first — the drain never claims a running row, and
// an enqueue either dedupes on it or, on a row the claim created, takes that
// row over for release to re-queue — and hands it back afterwards
// (releaseOperatorReceiptClaim). A job the drain is delivering right now
// refuses the operator send ({ inFlight: true, byOperator }) rather than racing it, and
// one whose stale claim this call finds already delivered refuses it too
// ({ alreadySent: true }).
// A short transaction only: never held across the sends. A process that dies
// holding the claim is settled by recoverStaleLocks after
// STALE_LOCK_MINUTES: closed when its own email was recorded as sent
// (recordOperatorReceiptDelivered), removed when the claim created the row, and
// otherwise handed back to the drain.
// sawUnsent: the caller read the invoice with receipt_sent_at still null.
// If it is stamped by the time the claim runs, another path (the drain, or
// the drain's recovery of a crashed operator send) delivered the receipt in
// between, and this send is refused ({ alreadySent: true }). A caller that
// saw it already stamped is a deliberate resend and is never refused here.
async function claimReceiptJobForOperatorSend(invoiceId, { sawUnsent = false } = {}) {
  // A stale row is settled first by the same rules as the drain's recovery
  // (closed on its own recorded email, removed when a claim created it,
  // otherwise requeued), so what is left running is genuinely in flight. A
  // settled claim whose email already went out means this receipt was sent:
  // the caller must not send it again ({ alreadySent: true }).
  const settled = await recoverStaleLocks({ invoiceId });
  if (settled.closedDelivered > 0) return { alreadySent: true };
  const token = `operator:${workerId()}:${randomUUID()}`;
  const ALREADY_SENT = Symbol('already sent');
  try {
    return await db.transaction(async (trx) => {
      // Read only once this transaction holds the job slot (inserted, or
      // locked below): whatever delivered it had already stamped the invoice.
      const stampedSinceRead = async () => sawUnsent
        && Boolean((await trx('invoices').where({ id: invoiceId }).first('receipt_sent_at'))?.receipt_sent_at);
      const inserted = await trx('receipt_delivery_jobs')
        .insert({
          invoice_id: invoiceId,
          source: 'operator_send',
          status: 'running',
          next_attempt_at: trx.fn.now(),
          locked_at: trx.fn.now(),
          locked_by: token,
          attempts: 0,
          max_attempts: DEFAULT_MAX_ATTEMPTS,
          updated_at: trx.fn.now(),
        })
        .onConflict(['invoice_id'])
        .ignore()
        .returning(['id']);
      if (inserted?.[0]) {
        if (await stampedSinceRead()) throw ALREADY_SENT; // rolls the claim row back
        return { id: inserted[0].id, invoiceId, token, prior: null };
      }

      const job = await trx('receipt_delivery_jobs')
        .where({ invoice_id: invoiceId })
        .forUpdate()
        .first('id', 'status', 'next_attempt_at', 'locked_by');
      if (!job) throw new Error(`receipt job for invoice ${invoiceId} vanished during the operator claim`);
      // byOperator: another operator send holds it (not the drain) — it
      // delivers only the legs that operator chose, so it is no promise that
      // this caller's receipt goes out.
      if (job.status === 'running') return { inFlight: true, byOperator: String(job.locked_by || '').startsWith('operator:') };
      if (await stampedSinceRead()) return { alreadySent: true };
      // A completed or failed job sends nothing more: no claim to hold.
      if (!QUEUED_STATUSES.includes(job.status)) return { id: null };

      await trx('receipt_delivery_jobs')
        .where({ id: job.id })
        .update({ status: 'running', locked_at: trx.fn.now(), locked_by: token, updated_at: trx.fn.now() });
      return { id: job.id, invoiceId, token, prior: { status: job.status, next_attempt_at: job.next_attempt_at } };
    });
  } catch (err) {
    if (err === ALREADY_SENT) return { alreadySent: true };
    throw err;
  }
}

// Right after an operator leg delivers ('email' | 'sms'): claim-specific
// evidence on the row, so a claim that is never released (a failed release,
// or a process that dies before it) is settled by recoverStaleLocks without
// repeating that leg — the invoice stamped, and on a delivered email the job
// closed. Best effort — without it the stale claim is settled as undelivered
// (a possible repeat, never a lost receipt).
async function recordOperatorReceiptDelivered(claim, leg) {
  if (!claim?.id) return;
  const evidence = leg === 'email'
    ? { email_result: { ok: true, operator_claim: claim.token } }
    : { sms_result: { sent: true, operator_claim: claim.token } };
  await db('receipt_delivery_jobs')
    .where({ id: claim.id, status: 'running', locked_by: claim.token })
    .update({ ...evidence, updated_at: db.fn.now() })
    .catch((err) => logger.warn(`[receipt-delivery-queue] operator receipt ${leg} evidence failed for job ${claim.id}: ${err.message}`));
}

// After the operator send: a delivered receipt EMAIL completes the job (the
// queued job would only repeat it; its text leg already skips once
// receipt_sent_at is stamped). Otherwise the queued job goes back exactly as
// it was — it still owes the email — and a row the claim itself created is
// removed, or queued if an enqueue took it over. Scoped to this claim's
// token; a failure logs and leaves the row to recoverStaleLocks.
async function releaseOperatorReceiptClaim(claim, { emailDelivered = false, smsDelivered = false, smsResult = null, emailResult = null } = {}) {
  if (!claim?.id) return;
  const mine = () => db('receipt_delivery_jobs').where({ id: claim.id, status: 'running', locked_by: claim.token });
  try {
    // Anything delivered stamps the invoice first (the caller's own stamp may
    // have failed) — before a job is handed back, so its text leg skips. If
    // this write fails too, the claim stays running for recoverStaleLocks.
    if (emailDelivered || smsDelivered) {
      await db('invoices').where({ id: claim.invoiceId }).whereNull('receipt_sent_at').update({ receipt_sent_at: db.fn.now() });
    }
    if (emailDelivered) {
      await mine().update({
        status: 'completed',
        sms_result: smsResult,
        email_result: emailResult,
        completed_at: db.fn.now(),
        locked_at: null,
        locked_by: null,
        last_error: null,
        updated_at: db.fn.now(),
      });
    } else if (!claim.prior) {
      // A row the claim created goes away — unless an enqueue took it over
      // meanwhile (source no longer 'operator_send'): that job is now due.
      const removed = await mine().where({ source: 'operator_send' }).del();
      if (!removed) {
        await mine().update({ status: 'queued', locked_at: null, locked_by: null, updated_at: db.fn.now() });
      }
    } else {
      await mine().update({
        status: claim.prior.status,
        next_attempt_at: claim.prior.next_attempt_at,
        locked_at: null,
        locked_by: null,
        updated_at: db.fn.now(),
      });
    }
  } catch (err) {
    logger.warn(`[receipt-delivery-queue] operator receipt claim release failed for job ${claim.id}: ${err.message}`);
  }
}

// Set the still-queued job's Text leg as carried by the summary text. Only a
// provably unsent Text leg folds: no recorded SMS outcome yet (or already
// carried). A retry_scheduled job may already have texted (its email failed)
// or hold an uncertain outcome; a job already running or finished has had its
// text decided. Those set nothing (returns 0) and the stop is not folded.
async function markTextCarriedBySummary(invoiceId, { database = db } = {}) {
  return database('receipt_delivery_jobs').where({ invoice_id: invoiceId }).whereIn('status', QUEUED_STATUSES)
    .where((q) => q.whereNull('sms_result').orWhereRaw("sms_result->>'reason' = ?", [TEXT_CARRIED_BY_SUMMARY]))
    .update({ sms_result: JSON.stringify({ sent: false, reason: TEXT_CARRIED_BY_SUMMARY }), updated_at: database.fn.now() });
}

// The combined-stop charge defers its receipt job (deferReceiptDelivery) until the closeout
// coordinator knows whether the summary text will carry the receipt link. When it will not,
// the job is due again now, but only while it is still queued with no outcome, and the
// queue is drained at once.
async function resumeDeferredReceiptDelivery(invoiceId) {
  const resumed = await db('receipt_delivery_jobs').where({ invoice_id: invoiceId, status: 'queued', attempts: 0 })
    .where('next_attempt_at', '>', db.fn.now())
    .update({ next_attempt_at: db.fn.now(), updated_at: db.fn.now() });
  if (resumed) scheduleReceiptDeliveryDrain({ delayMs: 0, limit: 5 });
  return resumed;
}

function scheduleReceiptDeliveryDrain({ delayMs = 0, limit = 10 } = {}) {
  const run = () => {
    processDueReceiptDeliveryJobs({ limit }).catch((err) => {
      logger.error(`[receipt-delivery-queue] processor failed: ${err.message}`);
    });
  };
  if (delayMs > 0) setTimeout(run, delayMs).unref();
  else setImmediate(run);
}

module.exports = {
  receiptEmailOptOutState,
  // Also the IB closeout repair card's rule for "no email, on purpose".
  expectedEmailSkip,
  enqueueReceiptDelivery,
  claimDueReceiptDeliveryJobs,
  processDueReceiptDeliveryJobs,
  processReceiptDeliveryJob,
  scheduleReceiptDeliveryDrain,
  claimReceiptJobForOperatorSend,
  recordOperatorReceiptDelivered,
  releaseOperatorReceiptClaim,
  markTextCarriedBySummary,
  resumeDeferredReceiptDelivery,
  TEXT_CARRIED_BY_SUMMARY,
  _internals: {
    recoverStaleLocks,
    actionableSmsFailure,
    actionableEmailFailure,
    shouldRetryReceiptDelivery,
    receiptDeliveryFailureError,
  },
};
