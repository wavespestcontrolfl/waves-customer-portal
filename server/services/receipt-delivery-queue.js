const os = require('os');
const db = require('../models/db');
const logger = require('./logger');

const QUEUED_STATUSES = ['queued', 'retry_scheduled'];
const STALE_LOCK_MINUTES = 10;
const DEFAULT_MAX_ATTEMPTS = 5;

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
    updated_at: db.fn.now(),
  };

  const inserted = await db('receipt_delivery_jobs')
    .insert(row)
    .onConflict(['invoice_id'])
    .ignore()
    .returning('*');

  if (inserted?.[0]) return { enqueued: true, job: inserted[0] };
  return { enqueued: false, deduped: true };
}

async function recoverStaleLocks() {
  return db('receipt_delivery_jobs')
    .where({ status: 'running' })
    .where('locked_at', '<', db.raw(`now() - interval '${STALE_LOCK_MINUTES} minutes'`))
    .update({
      status: 'retry_scheduled',
      locked_at: null,
      locked_by: null,
      next_attempt_at: db.fn.now(),
      updated_at: db.fn.now(),
    });
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
  // leg is skipped on purpose, exactly like the no-recipient case.
  // 'email_opted_out' is the portal-wide email_enabled=false opt-out — the
  // transactional_required stream bypasses suppression-group filtering, so
  // senders must honor it themselves (the deposit / no-show email legs
  // already do; the SMS leg carries the receipt for these customers).
  return result?.error === 'No receipt recipient email'
    || result?.error === 'receipt_opted_out'
    || result?.error === 'email_opted_out';
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
  return result?.sent === false && !['already-sent', 'no-phone', 'payer_billed', 'channel_email_only', 'receipt_texts_opted_out', 'sms_suppressed'].includes(result.reason);
}

function actionableEmailFailure(result) {
  return result && result.ok === false && !expectedEmailSkip(result);
}

function shouldRetryReceiptDelivery({ smsResult = null, emailResult = null } = {}) {
  return actionableSmsFailure(smsResult) || actionableEmailFailure(emailResult);
}

function receiptDeliveryFailureError({ smsResult = null, emailResult = null } = {}) {
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

async function markJobRetry(job, err, { smsResult = null, emailResult = null } = {}) {
  const attempts = Number(job.attempts || 0);
  const maxAttempts = Number(job.max_attempts || DEFAULT_MAX_ATTEMPTS);
  const terminal = attempts >= maxAttempts;
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

async function processReceiptDeliveryJob(job) {
  let smsResult = null;
  let emailResult = null;
  try {
    const invoice = await db('invoices').where({ id: job.invoice_id }).first();
    if (!invoice) {
      await markJobRetry(job, new Error(`invoice ${job.invoice_id} not found`), { smsResult, emailResult });
      return { ok: false, terminal: true, reason: 'invoice_not_found' };
    }

    const InvoiceService = require('./invoice');
    const { sendReceiptEmail } = require('./invoice-email');

    smsResult = await InvoiceService.sendReceipt(invoice.id, { hasEmailLeg: true })
      .catch((err) => ({ sent: false, reason: err.message }));
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
    // delivered email) — nothing was sent.
    let receiptKillSwitch = false;
    let emailOptedOut = false;
    let prefsLookupFailed = false;
    if (!invoice.payer_id) {
      const prefs = await db('notification_prefs')
        .where({ customer_id: invoice.customer_id })
        .first()
        .catch(() => {
          // A transient lookup failure must NOT read as "no opt-out" — that
          // would email a kill-switch customer on a DB blip. Fail the email
          // leg actionably so the retry ladder re-runs the lookup (the email
          // idempotency key makes the eventual send safe to repeat).
          prefsLookupFailed = true;
          return null;
        });
      receiptKillSwitch = prefs?.payment_receipt === false;
      emailOptedOut = prefs?.email_enabled === false;
    }
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
        : emailOptedOut
          ? { ok: false, error: 'email_opted_out' }
          : await sendReceiptEmail(invoice.id, {
            idempotencyKey: `receipt_email_auto:${invoice.id}`,
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
    if (['payer_billed', 'channel_email_only', 'receipt_texts_opted_out', 'sms_suppressed'].includes(smsResult?.reason) && emailResult?.ok && !invoice.receipt_sent_at) {
      await db('invoices')
        .where({ id: invoice.id })
        .whereNull('receipt_sent_at')
        .update({ receipt_sent_at: db.fn.now() })
        .catch((e) => logger.warn(`[receipt-delivery-queue] receipt_sent_at stamp failed for ${invoice.invoice_number}: ${e.message}`));
    }

    await markJobCompleted(job, { smsResult, emailResult });
    return { ok: true, sms: smsResult, email: emailResult };
  } catch (err) {
    await markJobRetry(job, err, { smsResult, emailResult });
    return { ok: false, error: err.message };
  }
}

async function processDueReceiptDeliveryJobs({ limit = 10, id = workerId() } = {}) {
  const recovered = await recoverStaleLocks();
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
  enqueueReceiptDelivery,
  claimDueReceiptDeliveryJobs,
  processDueReceiptDeliveryJobs,
  processReceiptDeliveryJob,
  scheduleReceiptDeliveryDrain,
  _internals: {
    actionableSmsFailure,
    actionableEmailFailure,
    shouldRetryReceiptDelivery,
    receiptDeliveryFailureError,
  },
};
