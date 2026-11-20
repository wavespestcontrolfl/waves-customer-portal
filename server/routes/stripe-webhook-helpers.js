/**
 * Pure helpers for the Stripe webhook route — no DB, no Stripe SDK.
 * Exists so the audit unit tests can pin the duplicate-event decision
 * matrix without faking Knex.
 */

// How long we'll wait for an in-flight worker to finish before treating
// its claim as stale. A worker that crashes between claim and either
// processed=true / error=set leaves the row stuck at processed=false +
// error=null; without a stale-claim window, every Stripe retry would
// land on the in-flight 503 path forever and the event would never be
// re-applied. 5 minutes is comfortably above the longest realistic
// handler runtime (a few seconds) but short enough that a crashed
// worker's row is recoverable on Stripe's first or second retry.
const STALE_CLAIM_WINDOW_MS = 5 * 60 * 1000;

/**
 * Decide what to do when our atomic INSERT … ON CONFLICT DO NOTHING
 * claim loses (i.e. a row with this event.id already exists). Returns
 * one of:
 *   'duplicate' — already processed; reply 200 and skip.
 *   'reclaim'   — previous handler attempt failed (error recorded) OR
 *                 the row's received_at is older than the stale window
 *                 (worker likely crashed before writing error); try to
 *                 re-claim the row, run the handler again.
 *   'inflight'  — another worker is currently running the handler
 *                 within the stale window; reply 503 so Stripe retries.
 *
 * If the existing row is null (very rare — would mean ON CONFLICT lost
 * but the row vanished by the time we read it), we fall through to
 * 'inflight' so Stripe retries cleanly instead of double-running.
 */
function classifyExistingWebhookEvent(existing, { now = Date.now(), staleWindowMs = STALE_CLAIM_WINDOW_MS } = {}) {
  if (!existing) return 'inflight';
  if (existing.processed) return 'duplicate';
  if (existing.error) return 'reclaim';
  // No error recorded yet — could be a live worker mid-handler, or a
  // worker that crashed before its catch block fired. Use received_at
  // as the lease timestamp: anything older than the stale window is
  // assumed crashed and eligible for re-claim.
  const receivedAtMs = existing.received_at ? new Date(existing.received_at).getTime() : null;
  if (receivedAtMs && Number.isFinite(receivedAtMs) && (now - receivedAtMs) > staleWindowMs) {
    return 'reclaim';
  }
  return 'inflight';
}

function optionalId(value) {
  return String(value || '');
}

function savedCardMethodMatches(storedMethodId, paymentIntent, verifiedCancellation) {
  if (!storedMethodId) return false;
  const method = paymentIntent.payment_method || paymentIntent.last_payment_error?.payment_method;
  const methodId = typeof method === 'string' ? method : method?.id;
  return String(storedMethodId) === optionalId(methodId) || Boolean(!methodId && verifiedCancellation);
}

function savedCardPaymentEvidenceMatches(attempt, paymentIntent, metadataAttemptId, options) {
  const paymentIntentId = optionalId(paymentIntent.id);
  const namedAttemptId = optionalId(metadataAttemptId);
  const attachedId = optionalId(attempt.stripe_payment_intent_id);
  const workerId = attempt.worker_payment_intent_id || '';
  const workerMatches = workerId === paymentIntentId;
  if (workerId && !workerMatches) return false;
  if (attachedId && attachedId !== paymentIntentId) return false;
  // Without an attempt ID in metadata, only an exact recorded attachment binds
  // a legacy event. One invoice and card may be used for multiple attempts.
  if (namedAttemptId ? namedAttemptId !== String(attempt.id) : !attachedId) return false;
  if (options.requireWorkerPaymentIntent && (!namedAttemptId || !workerMatches)) return false;

  // The recorded IDs above are now either absent or agree with this event.
  // After the worker responds, both its ID and the attachment must be present.
  const verifiedCancellation = options.allowVerifiedCancellationWithoutMethod
    && Boolean(namedAttemptId && paymentIntentId) && paymentIntent.status === 'canceled'
    && attempt.authentication_canceled_intent_id === paymentIntentId
    && (workerId ? Boolean(attachedId) : options.allowCancellationAwaitingWorker);
  return savedCardMethodMatches(attempt.stripe_payment_method_id, paymentIntent, verifiedCancellation);
}

function savedCardAttemptMatchesPaymentIntent({
  attempt, invoice, paymentIntent, allowResolvedSucceeded = false, provenInvoiceOwner, ...options
}) {
  if (!attempt || !invoice || !paymentIntent) return false;
  const metadata = paymentIntent.metadata || {};
  const invoiceId = String(invoice.id);
  const activeAttempt = ['claimed', 'ambiguous'].includes(attempt.status) && !attempt.resolved_at;
  const settledAttempt = allowResolvedSucceeded && attempt.status === 'succeeded' && attempt.resolved_at;
  return (activeAttempt || settledAttempt)
    && String(attempt.invoice_id) === invoiceId
    && metadata.source === 'admin_card_on_file'
    && optionalId(metadata.waves_invoice_id) === invoiceId
    && (provenInvoiceOwner || optionalId(metadata.waves_customer_id) === String(invoice.customer_id))
    && savedCardPaymentEvidenceMatches(attempt, paymentIntent, metadata.saved_card_attempt_id, options);
}

function savedCardCreditAdjustment({ attempt, invoice }) {
  const target = Math.round((Number(attempt?.credit_applied_total) || 0) * 100) / 100;
  const current = Math.round((Number(invoice?.credit_applied) || 0) * 100) / 100;
  if (!(target > current)) return null;
  return {
    target,
    delta: Math.round((target - current) * 100) / 100,
  };
}

// Older paid receipts can omit either representation of a component. Every
// recorded value must agree with the signed amount before replay can use credit.
function receiptAmountMatches(expectedCents, recordedCents, recordedDollars) {
  if (recordedCents != null && Number(recordedCents) !== expectedCents) return false;
  if (recordedDollars == null) return true;
  return /^\d+(?:\.\d{1,2})?$/.test(String(recordedDollars))
    && Math.round(Number(recordedDollars) * 100) === expectedCents;
}

// The replacement charge was submitted with a fixed base and surcharge.
// Compare both in cents before the webhook changes the invoice's total.
function authenticatedSavedCardAmountMatches(paymentIntent, attempt, amountDue, paidReceipt = null) {
  const metadata = paymentIntent.metadata || {};
  if (metadata.base_amount == null || metadata.base_amount === '') return false;
  const submittedBase = Math.round(Number(metadata.base_amount) * 100);
  const submittedSurcharge = Math.round(Number(metadata.card_surcharge ?? 0) * 100);
  const captured = paymentIntent.amount_received;
  const receipt = paidReceipt || {};
  const receiptMetadata = receipt.metadata || {};
  return Number.isSafeInteger(captured) && captured > 0 && paymentIntent.amount === captured
    && Number.isSafeInteger(submittedSurcharge) && submittedSurcharge >= 0
    && submittedBase === Math.round(amountDue * 100)
    && submittedBase + submittedSurcharge === captured
    && (attempt.amount == null || Math.round(Number(attempt.amount) * 100) === captured)
    && receiptAmountMatches(submittedBase, receipt.base_amount_cents, receiptMetadata.base_amount)
    && receiptAmountMatches(submittedSurcharge, receipt.surcharge_amount_cents, receiptMetadata.card_surcharge);
}

function invoicePaymentIntentBlocksFallback({
  invoiceStatus,
  activePaymentIntentId,
  incomingPaymentIntentId,
  terminalStatuses = [],
  hasMatchingSavedCardAttempt = false,
}) {
  const status = String(invoiceStatus || '').toLowerCase();
  const active = activePaymentIntentId ? String(activePaymentIntentId) : '';
  const incoming = String(incomingPaymentIntentId || '');
  return terminalStatuses.includes(status)
    || (status === 'processing' && active !== incoming && !hasMatchingSavedCardAttempt)
    || (active && active !== incoming && !hasMatchingSavedCardAttempt);
}

function lateSavedCardPaymentNeedsOrphan({
  invoiceStatus,
  activePaymentIntentId,
  incomingPaymentIntentId,
  terminalStatuses = [],
  hasMatchingSavedCardAttempt = false,
}) {
  const status = String(invoiceStatus || '').toLowerCase();
  const active = activePaymentIntentId ? String(activePaymentIntentId) : '';
  const incoming = String(incomingPaymentIntentId || '');
  return hasMatchingSavedCardAttempt
    && terminalStatuses.includes(status)
    && active !== incoming;
}

module.exports = {
  classifyExistingWebhookEvent,
  invoicePaymentIntentBlocksFallback,
  lateSavedCardPaymentNeedsOrphan,
  savedCardAttemptMatchesPaymentIntent,
  savedCardCreditAdjustment,
  authenticatedSavedCardAmountMatches,
  STALE_CLAIM_WINDOW_MS,
};
