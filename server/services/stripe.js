const Stripe = require('stripe');
const config = require('../config');
const stripeConfig = require('../config/stripe-config');
const db = require('../models/db');
const logger = require('./logger');
const PaymentLifecycleEmail = require('./payment-lifecycle-email');
const { v4: uuidv4 } = require('uuid');
const { etDateString } = require('../utils/datetime-et');

// ═══════════════════════════════════════════════════════════════
// Lazy-init Stripe client — don't crash if key is missing
// ═══════════════════════════════════════════════════════════════
let _stripe;
function getStripe() {
  if (_stripe) return _stripe;
  if (!stripeConfig.secretKey) {
    logger.warn('[stripe] STRIPE_SECRET_KEY not set — Stripe features disabled');
    return null;
  }
  // maxNetworkRetries: connection blips after Stripe has processed a
  // request are replayed by the SDK with the SAME idempotency key, so an
  // ambiguous timeout resolves to the original outcome instead of being
  // recorded as a failure (which the autopay cron would re-charge days
  // later).
  _stripe = new Stripe(stripeConfig.secretKey, { apiVersion: '2024-12-18.acacia', maxNetworkRetries: 2 });
  return _stripe;
}

// ═══════════════════════════════════════════════════════════════
// Credit card processing surcharge
// Debit/prepaid/unknown/ACH pay the quoted amount with no surcharge.
// Pure helpers live in ./stripe-pricing so they can be unit-tested
// without the Stripe SDK; one source of truth for surcharge math.
// ═══════════════════════════════════════════════════════════════
const {
  CARD_SURCHARGE_RATE,
  SURCHARGE_API_VERSION,
  SURCHARGE_POLICY_VERSION,
  CONFIGURED_COST_BPS,
  isCardMethodType,
  shouldSurcharge,
  computeChargeAmount,
  buildSurchargeAmountDetails,
  computeRefundSurcharge,
  depositFaceValueDollars,
} = require('./stripe-pricing');
const { surchargeAllowed } = require('./surcharge-jurisdiction');
const {
  assertInvoicePaymentIntentTenderMatches,
  invoicePaymentStatusForIntent,
  nextInvoiceStatusAfterFailedPayment,
} = require('./stripe-invoice-state');
const { assertInvoiceCollectible, isInvoiceCollectibleStatus, invoiceAmountDue } = require('./invoice-helpers');

// Stripe rejects a payment_method_types narrow when an incompatible
// PaymentMethod is already attached to the PaymentIntent — e.g. a customer
// who began an ACH entry (attaching a us_bank_account PM) then switches to
// Card. Detect that specific rejection so the caller can recover by minting a
// fresh PI for the selected tender rather than failing the switch.
function isIncompatibleAttachedMethodError(err) {
  const message = String(err?.message || err?.raw?.message || '').toLowerCase();
  return message.includes('incompatible with the attached paymentmethod')
    || message.includes('replace the paymentmethod first');
}

// A Stripe create/confirm call that fails without returning a PaymentIntent is
// only unsafe to retry when the failure came from the connection/API layer.
// Validation and card-decline errors are deterministic; a timeout or 5xx may
// have happened after Stripe accepted the request.
function isAmbiguousStripeChargeError(err) {
  const paymentIntentId = err?.payment_intent?.id || err?.raw?.payment_intent?.id || null;
  const type = err?.type || err?.raw?.type || null;
  return !paymentIntentId && ['StripeConnectionError', 'StripeAPIError'].includes(type);
}

const SAVED_CARD_RECONCILIATION_ERROR_CODES = new Set([
  'STRIPE_CHARGED_DB_FAILED',
  'STRIPE_AMBIGUOUS_OUTCOME',
]);
const SAVED_CARD_CLAIM_STALE_MS = 5 * 60 * 1000;

function savedCardClaimIsStale(attempt, now = Date.now()) {
  const claimedAt = new Date(attempt?.created_at || '').getTime();
  return Number.isFinite(claimedAt) && now - claimedAt >= SAVED_CARD_CLAIM_STALE_MS;
}

function savedCardClaimWasSubmitted(attempt) {
  return Boolean(attempt?.submitted_at || attempt?.stripe_payment_intent_id);
}

function savedCardChargeNeedsReconciliation(err) {
  return SAVED_CARD_RECONCILIATION_ERROR_CODES.has(err?.code);
}

function savedCardChargeSuppressesAlternateCollection(err) {
  return savedCardChargeNeedsReconciliation(err) || err?.code === 'STRIPE_CHARGE_IN_PROGRESS';
}

function shouldTreatSavedCardFailureAsAmbiguous({ chargeSubmitted, error }) {
  return chargeSubmitted === true && isAmbiguousStripeChargeError(error);
}

async function promoteStaleSavedCardClaim(attempt, database = db) {
  if (attempt?.status !== 'claimed' || !savedCardClaimIsStale(attempt)) return false;
  return database('stripe_invoice_charge_attempts')
    .where({ id: attempt.id, status: 'claimed' })
    .whereNull('resolved_at')
    .update({
      status: 'ambiguous',
      error_message: 'Saved-card charge claim exceeded the active window; outcome requires reconciliation',
      updated_at: new Date(),
    });
}

async function releaseStalePreSubmitSavedCardClaim(attempt, database = db) {
  if (
    attempt?.status !== 'claimed'
    || !savedCardClaimIsStale(attempt)
    || savedCardClaimWasSubmitted(attempt)
  ) return false;

  return database('stripe_invoice_charge_attempts')
    .where({ id: attempt.id, status: 'claimed' })
    .whereNull('resolved_at')
    .whereNull('submitted_at')
    .whereNull('stripe_payment_intent_id')
    .update({
      status: 'failed',
      error_message: 'Saved-card charge claim expired before submission to Stripe',
      resolved_at: new Date(),
      updated_at: new Date(),
    });
}

async function assertNoInvoiceChargeReconciliationPending(invoiceId, database = db) {
  let chargeAttempt = await database('stripe_invoice_charge_attempts')
    .where({ invoice_id: invoiceId })
    .whereIn('status', ['claimed', 'ambiguous'])
    .whereNull('resolved_at')
    .first('id', 'status', 'stripe_payment_intent_id', 'idempotency_key', 'submitted_at', 'created_at');
  if (chargeAttempt) {
    let ambiguous = chargeAttempt.status === 'ambiguous';
    if (!ambiguous && savedCardClaimIsStale(chargeAttempt)) {
      if (!savedCardClaimWasSubmitted(chargeAttempt)) {
        const released = await releaseStalePreSubmitSavedCardClaim(chargeAttempt, database).catch((releaseErr) => {
          logger.error(`[stripe] could not release stale pre-submit saved-card claim ${chargeAttempt.id}: ${releaseErr.message}`);
          return 0;
        });
        if (released > 0) chargeAttempt = null;
      } else {
        const promoted = await promoteStaleSavedCardClaim(chargeAttempt, database).catch((promoteErr) => {
          logger.error(`[stripe] could not promote stale saved-card claim ${chargeAttempt.id}: ${promoteErr.message}`);
          return 0;
        });
        ambiguous = promoted > 0;
        if (ambiguous) chargeAttempt.status = 'ambiguous';
      }
    }
  }
  if (chargeAttempt) {
    const ambiguous = chargeAttempt.status === 'ambiguous';
    const err = new Error(ambiguous
      ? 'Invoice has an unresolved charge attempt with an ambiguous Stripe outcome'
      : 'Invoice already has a saved-card charge in progress or awaiting reconciliation');
    err.code = ambiguous ? 'STRIPE_AMBIGUOUS_OUTCOME' : 'STRIPE_CHARGE_IN_PROGRESS';
    err.chargeAttemptId = chargeAttempt.id;
    err.stripePaymentIntentId = chargeAttempt.stripe_payment_intent_id || null;
    err.idempotencyKey = chargeAttempt.idempotency_key;
    err.reconciliationRequired = ambiguous;
    throw err;
  }

  const orphan = await database('stripe_orphan_charges')
    .where({ invoice_id: invoiceId, resolved: false })
    .first('stripe_payment_intent_id');
  if (orphan) {
    const err = new Error(`Invoice has an unresolved Stripe charge ${orphan.stripe_payment_intent_id}`);
    err.code = 'STRIPE_CHARGED_DB_FAILED';
    err.stripePaymentIntentId = orphan.stripe_payment_intent_id;
    err.reconciliationRequired = true;
    throw err;
  }

  // An API/connection failure without a returned PI may still have collected
  // money. Keep the invoice fenced across page reloads. A reconciler can clear
  // the fence by linking the attempt to a different superseding payment or by
  // correcting its ambiguous_outcome metadata after verifying Stripe.
  const ambiguousAttempt = await database('payments')
    .where({ status: 'failed' })
    .whereNull('stripe_payment_intent_id')
    .whereRaw("metadata->>'invoice_id' = ?", [String(invoiceId)])
    .whereRaw("COALESCE((metadata->>'ambiguous_outcome')::boolean, false) = true")
    .where(function unresolvedAmbiguousAttempt() {
      this.whereNull('superseded_by_payment_id')
        .orWhereColumn('superseded_by_payment_id', 'payments.id');
    })
    .first('id');
  if (ambiguousAttempt) {
    const err = new Error('Invoice has an unresolved charge attempt with an ambiguous Stripe outcome');
    err.code = 'STRIPE_AMBIGUOUS_OUTCOME';
    err.paymentRecordId = ambiguousAttempt.id;
    err.reconciliationRequired = true;
    throw err;
  }
}

async function claimInvoiceSavedCardCharge({
  invoiceId,
  paymentMethodId,
  stripePaymentMethodId,
  database = db,
  attemptId = uuidv4(),
}) {
  const idempotencyKey = `inv_card_on_file_${invoiceId}_${attemptId}`;
  try {
    return await database.transaction(async (claimTrx) => {
      // Public server-side confirm takes this same invoice lock for its final
      // fence check. Whichever path wins serializes the decision: a committed
      // claim blocks confirm, while a confirm already sent to Stripe leaves an
      // attached live PI that the saved-card owner refuses to replace.
      const lockedInvoice = await claimTrx('invoices')
        .where({ id: invoiceId })
        .forUpdate()
        .first('id');
      if (!lockedInvoice) throw new Error('Invoice not found');

      const [attempt] = await claimTrx('stripe_invoice_charge_attempts')
        .insert({
          id: attemptId,
          invoice_id: invoiceId,
          payment_method_id: paymentMethodId,
          stripe_payment_method_id: stripePaymentMethodId,
          idempotency_key: idempotencyKey,
          status: 'claimed',
        })
        .returning('*');
      return attempt;
    });
  } catch (err) {
    if (err.code !== '23505') throw err;
    const blocking = await database('stripe_invoice_charge_attempts')
      .where({ invoice_id: invoiceId })
      .whereIn('status', ['claimed', 'ambiguous'])
      .whereNull('resolved_at')
      .first('id', 'status', 'stripe_payment_intent_id', 'idempotency_key', 'submitted_at', 'created_at');
    let ambiguous = blocking?.status === 'ambiguous';
    if (!ambiguous && savedCardClaimIsStale(blocking)) {
      if (!savedCardClaimWasSubmitted(blocking)) {
        const released = await releaseStalePreSubmitSavedCardClaim(blocking, database).catch((releaseErr) => {
          logger.error(`[stripe] could not release collided stale pre-submit saved-card claim ${blocking.id}: ${releaseErr.message}`);
          return 0;
        });
        if (released > 0) {
          return claimInvoiceSavedCardCharge({
            invoiceId,
            paymentMethodId,
            stripePaymentMethodId,
            database,
            attemptId,
          });
        }
      } else {
        const promoted = await promoteStaleSavedCardClaim(blocking, database).catch((promoteErr) => {
          logger.error(`[stripe] could not promote collided stale saved-card claim ${blocking.id}: ${promoteErr.message}`);
          return 0;
        });
        ambiguous = promoted > 0;
        if (ambiguous) blocking.status = 'ambiguous';
      }
    }
    const conflict = new Error(ambiguous
      ? 'Invoice has an unresolved charge attempt with an ambiguous Stripe outcome'
      : 'Invoice already has a saved-card charge in progress or awaiting reconciliation');
    conflict.code = ambiguous ? 'STRIPE_AMBIGUOUS_OUTCOME' : 'STRIPE_CHARGE_IN_PROGRESS';
    conflict.chargeAttemptId = blocking?.id || null;
    conflict.stripePaymentIntentId = blocking?.stripe_payment_intent_id || null;
    conflict.idempotencyKey = blocking?.idempotency_key || null;
    conflict.reconciliationRequired = ambiguous;
    throw conflict;
  }
}

async function markInvoiceSavedCardChargeAttempt(attemptId, updates, database = db) {
  const updated = await database('stripe_invoice_charge_attempts')
    .where({ id: attemptId })
    .whereIn('status', ['claimed', 'ambiguous'])
    .whereNull('resolved_at')
    .update({ ...updates, updated_at: new Date() });
  if (!updated) {
    const err = new Error(`Saved-card charge attempt ${attemptId} could not be updated`);
    err.code = 'STRIPE_CHARGE_ATTEMPT_FENCE_LOST';
    throw err;
  }
}

async function commitInvoiceSavedCardChargeSubmission({
  attemptId,
  amount,
  creditAppliedDelta,
  creditAppliedTotal,
  database = db,
}) {
  // This transaction deliberately uses the root database handle, not the
  // invoice transaction that calls it. Awaiting it proves submitted_at is
  // committed before the Stripe request can leave this process; a crash after
  // the network write can therefore never make the attempt look pre-submit.
  return database.transaction(async (submissionTrx) => {
    await markInvoiceSavedCardChargeAttempt(attemptId, {
      amount,
      credit_applied_delta: creditAppliedDelta,
      credit_applied_total: creditAppliedTotal,
      submitted_at: new Date(),
    }, submissionTrx);
  });
}

async function resolveSettledInvoiceSavedCardChargeAttempt({
  attemptId,
  invoiceId,
  customerId,
  stripePaymentIntentId,
  amount,
  database = db,
}) {
  if (!attemptId || !invoiceId || !customerId || !stripePaymentIntentId) return false;

  return database.transaction(async (trx) => {
    // The invoice/payment transaction may have committed before the owning
    // request could close its durable attempt. A succeeded-webhook retry must
    // repair that last write, but only after re-proving the exact local
    // settlement while holding the attempt lock; a Stripe event by itself is
    // not enough.
    const attempt = await trx('stripe_invoice_charge_attempts')
      .where({ id: attemptId, invoice_id: invoiceId })
      .forUpdate()
      .first('id', 'status', 'resolved_at', 'stripe_payment_intent_id');
    if (!attempt || !['claimed', 'ambiguous', 'succeeded'].includes(attempt.status)) return false;
    if (attempt.stripe_payment_intent_id
      && String(attempt.stripe_payment_intent_id) !== String(stripePaymentIntentId)) return false;

    const invoice = await trx('invoices')
      .where({
        id: invoiceId,
        customer_id: customerId,
        status: 'paid',
        stripe_payment_intent_id: stripePaymentIntentId,
      })
      .first('id');
    if (!invoice) return false;

    const payment = await trx('payments')
      .where({
        customer_id: customerId,
        status: 'paid',
        stripe_payment_intent_id: stripePaymentIntentId,
      })
      .first('id', 'amount');
    if (!payment) return false;

    const settledAmount = amount != null && Number.isFinite(Number(amount))
      ? Number(amount)
      : Number(payment.amount);
    const resolvedAttempt = await trx('stripe_invoice_charge_attempts')
      .where({ id: attempt.id })
      .whereIn('status', ['claimed', 'ambiguous'])
      .whereNull('resolved_at')
      .update({
        status: 'succeeded',
        stripe_payment_intent_id: stripePaymentIntentId,
        ...(Number.isFinite(settledAmount) ? { amount: settledAmount } : {}),
        error_message: null,
        resolved_at: new Date(),
        updated_at: new Date(),
      });
    // The request may have durably closed the attempt after writing the orphan
    // ledger but before a succeeded webhook repaired the invoice/payment rows.
    // Clear that exact orphan fence only after re-proving local settlement.
    const resolvedOrphan = await trx('stripe_orphan_charges')
      .where({
        invoice_id: invoiceId,
        stripe_payment_intent_id: stripePaymentIntentId,
        resolved: false,
      })
      .update({
        resolved: true,
        resolved_at: new Date(),
        resolution_notes: 'Automatically reconciled by succeeded webhook after local invoice/payment settlement',
      });
    return resolvedAttempt > 0 || resolvedOrphan > 0;
  });
}

async function resolveNoFundsSavedCardChargeAttempt({
  attemptId,
  invoiceId,
  failureMessage,
  database = db,
}) {
  if (!attemptId || !invoiceId) return false;

  return database.transaction(async (trx) => {
    const invoice = await trx('invoices').where({ id: invoiceId }).forUpdate().first();
    if (!invoice) return false;
    const attempt = await trx('stripe_invoice_charge_attempts')
      .where({ id: attemptId, invoice_id: invoiceId })
      .whereIn('status', ['claimed', 'ambiguous'])
      .whereNull('resolved_at')
      .forUpdate()
      .first('id', 'status');
    if (!attempt) return false;

    // A second request can promote a five-minute claim and park the invoice
    // while the original is still blocked in Stripe. Once that owner proves no
    // funds can move (pre-create failure or definitive decline), restore
    // collection only while its ambiguous no-PI attempt still owns the park.
    let reopened = false;
    if (attempt.status === 'ambiguous'
      && String(invoice.status || '').toLowerCase() === 'processing'
      && !invoice.stripe_payment_intent_id) {
      await trx('invoices').where({ id: invoiceId }).update({
        status: nextInvoiceStatusAfterFailedPayment(invoice),
        stripe_payment_intent_id: null,
        paid_at: null,
        ach_processing_notified_at: null,
        updated_at: new Date(),
      });
      reopened = true;
    }

    const resolved = await trx('stripe_invoice_charge_attempts')
      .where({ id: attempt.id })
      .whereIn('status', ['claimed', 'ambiguous'])
      .whereNull('resolved_at')
      .update({
        status: 'failed',
        error_message: String(failureMessage || 'Pre-charge setup failed').slice(0, 1000),
        resolved_at: new Date(),
        updated_at: new Date(),
      });
    return resolved > 0 ? { resolved: true, reopened } : false;
  });
}

async function resolveFailedInvoiceSavedCardChargeAttempt({
  attemptId,
  invoiceId,
  customerId,
  stripePaymentIntentId,
  failureMessage,
  database = db,
}) {
  if (!attemptId || !invoiceId || !customerId || !stripePaymentIntentId) return false;

  return database.transaction(async (trx) => {
    const invoice = await trx('invoices').where({ id: invoiceId }).forUpdate().first();
    if (!invoice || String(invoice.customer_id) !== String(customerId)) return false;
    const invoiceStatus = String(invoice.status || '').toLowerCase();
    if (invoiceStatus !== 'processing' && !isInvoiceCollectibleStatus(invoiceStatus)) return false;
    if (invoiceStatus === 'processing'
      && invoice.stripe_payment_intent_id
      && String(invoice.stripe_payment_intent_id) !== String(stripePaymentIntentId)) {
      return false;
    }

    const attempt = await trx('stripe_invoice_charge_attempts')
      .where({ id: attemptId, invoice_id: invoiceId })
      .whereIn('status', ['claimed', 'ambiguous'])
      .whereNull('resolved_at')
      .forUpdate()
      .first('id', 'credit_applied_delta', 'credit_applied_total');
    if (!attempt) return false;

    // A timeout ambiguity may have committed the credit reservation even
    // though the Stripe PI ultimately failed. Return only the portion this
    // attempt reserved; any pre-existing or later credit remains applied.
    const { postCreditMovement, round2 } = require('./customer-credit');
    const delta = Math.max(0, round2(attempt.credit_applied_delta || 0));
    const target = Math.max(0, round2(attempt.credit_applied_total || 0));
    const original = Math.max(0, round2(target - delta));
    const current = Math.max(0, round2(invoice.credit_applied || 0));
    const creditToRelease = Math.min(delta, Math.max(0, round2(current - original)));
    if (creditToRelease > 0) {
      await postCreditMovement({
        customerId,
        delta: creditToRelease,
        source: 'adjustment',
        invoiceId,
        note: `Account credit released after failed saved-card attempt ${attempt.id}`,
        createdBy: 'system:saved_card_reconciliation',
      }, trx);
      invoice.credit_applied = round2(current - creditToRelease);
    }

    await trx('invoices').where({ id: invoiceId }).update({
      status: invoiceStatus === 'processing'
        ? nextInvoiceStatusAfterFailedPayment(invoice)
        : invoice.status,
      stripe_payment_intent_id: null,
      credit_applied: invoice.credit_applied,
      paid_at: null,
      ach_processing_notified_at: null,
      updated_at: new Date(),
    });
    const resolved = await trx('stripe_invoice_charge_attempts')
      .where({ id: attempt.id })
      .whereIn('status', ['claimed', 'ambiguous'])
      .whereNull('resolved_at')
      .update({
        status: 'failed',
        stripe_payment_intent_id: stripePaymentIntentId,
        error_message: String(failureMessage || 'Stripe reported payment failure').slice(0, 1000),
        resolved_at: new Date(),
        updated_at: new Date(),
      });
    await trx('stripe_orphan_charges')
      .where({
        invoice_id: invoiceId,
        stripe_payment_intent_id: stripePaymentIntentId,
        resolved: false,
      })
      .update({
        resolved: true,
        resolved_at: new Date(),
        resolution_notes: 'Stripe reported final payment failure; no funds collected',
      });
    return resolved > 0;
  });
}

function savedCardAttemptOutcome({ durableSettlementReady, paymentIntentStatus }) {
  if (durableSettlementReady && paymentIntentStatus === 'succeeded') {
    return { status: 'succeeded', resolved: true };
  }
  if (paymentIntentStatus === 'processing') {
    return { status: 'ambiguous', resolved: false };
  }
  return { status: 'claimed', resolved: false };
}

async function persistSavedCardChargeCreditDelta({
  invoiceId,
  customerId,
  attemptId = null,
  originalCreditApplied,
  creditDelta,
  targetCreditApplied,
  reference,
  database = db,
}) {
  if (!(Number(creditDelta) > 0)) return true;
  const { postCreditMovement, round2 } = require('./customer-credit');
  return database.transaction(async (trx) => {
    const locked = await trx('invoices').where({ id: invoiceId }).forUpdate().first();
    if (!locked) return false;
    if (attemptId) {
      const unresolvedAttempt = await trx('stripe_invoice_charge_attempts')
        .where({ id: attemptId, invoice_id: invoiceId })
        .whereIn('status', ['claimed', 'ambiguous'])
        .whereNull('resolved_at')
        .first('id');
      // A definitive failed webhook may have resolved the claim while the
      // request was unwinding its timeout. Never reserve credit after that.
      if (!unresolvedAttempt) return false;
    }
    const current = round2(locked.credit_applied || 0);
    const target = round2(targetCreditApplied ?? (
      (Number(originalCreditApplied) || 0) + Number(creditDelta)
    ));
    if (current >= target) return true;
    await postCreditMovement({
      customerId,
      delta: -round2(target - current),
      source: 'adjustment',
      invoiceId,
      note: `Account credit reserved for saved-card reconciliation ${reference}`,
      createdBy: 'system:saved_card_reconciliation',
    }, trx);
    await trx('invoices').where({ id: invoiceId }).update({
      credit_applied: target,
      updated_at: trx.fn.now(),
    });
    return true;
  });
}

async function parkInvoiceForSavedCardReconciliation({
  invoiceId,
  error,
  chargeAttemptId = error?.chargeAttemptId || null,
  database = db,
}) {
  return database.transaction(async (trx) => {
    const invoice = await trx('invoices').where({ id: invoiceId }).forUpdate().first();
    if (!invoice) return { reconciliationRequired: true, invoice: null };

    if (chargeAttemptId) {
      const unresolvedAttempt = await trx('stripe_invoice_charge_attempts')
        .where({ id: chargeAttemptId, invoice_id: invoiceId })
        .whereIn('status', ['claimed', 'ambiguous'])
        .whereNull('resolved_at')
        .forUpdate()
        .first('id');
      // A definitive webhook can resolve and reopen this invoice while the
      // request is unwinding an ambiguous create error. Re-prove ownership
      // under the same invoice lock before parking so the loser cannot strand
      // the invoice in processing with no live reconciliation fence.
      if (!unresolvedAttempt) {
        return { reconciliationRequired: false, attemptResolved: true, invoice };
      }
    }

    if (isInvoiceCollectibleStatus(invoice.status)) {
      await trx('invoices').where({ id: invoiceId }).update({
        status: 'processing',
        // A no-PI ambiguity belongs to the new saved-card create request, not
        // an abandoned public-pay PI that may have been attached beforehand.
        // Clear that stale binding so the matching metadata webhook can bind.
        stripe_payment_intent_id: error?.stripePaymentIntentId || null,
        updated_at: new Date(),
      });
      invoice.status = 'processing';
      invoice.stripe_payment_intent_id = error?.stripePaymentIntentId || null;
    }
    return { reconciliationRequired: true, invoice };
  });
}

// Deposit quote/finalize both operate on a client-named PaymentIntent id —
// re-derive trust from the PI's own pinned metadata (purpose + estimate_id)
// before touching it, mirroring how the webhook and accept gate trust
// deposit PIs. A tampered/foreign PI id must never be quoted, re-amounted,
// or confirmed through the deposit path.
function assertDepositIntentForEstimate(paymentIntent, estimateId) {
  if (!paymentIntent
    || paymentIntent.metadata?.purpose !== 'estimate_deposit'
    || String(paymentIntent.metadata?.estimate_id) !== String(estimateId)) {
    const err = new Error('Payment intent does not match this estimate deposit');
    err.statusCode = 400;
    throw err;
  }
}

// PI statuses from which it's safe to cancel + replace the intent. A
// processing/succeeded PI has money in flight and must never be canceled.
const REPLACEABLE_PI_STATUSES = new Set([
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'requires_capture',
]);

// Statuses safe to cancel + re-mint when a customer RETURNS to the pay page with
// a stale, never-captured PI. A strict subset of REPLACEABLE_PI_STATUSES that
// excludes `requires_capture`: an intent in requires_capture has an authorized
// card hold (money is effectively in flight — see PI_MONEY_IN_FLIGHT_STATUSES in
// invoice.js), so canceling it on a pay-page reload would void a live
// authorization. It must follow the non-replaceable 409 path instead. The
// tender-switch and offline-reconcile flows keep using REPLACEABLE_PI_STATUSES.
const SETUP_RECOVERABLE_PI_STATUSES = new Set(
  [...REPLACEABLE_PI_STATUSES].filter(status => status !== 'requires_capture')
);

const StripeService = {
  // =========================================================================
  // AVAILABILITY
  // =========================================================================

  /**
   * Returns true if Stripe is configured and available
   */
  isAvailable() {
    return !!stripeConfig.secretKey;
  },

  /**
   * True when the invoice's only blocker is an unfinished ACH micro-deposit
   * verification — its PaymentIntent is in `requires_action` with a
   * `verify_with_microdeposits` next_action (Stripe sent two small deposits and
   * is waiting for the customer to confirm them). Such an invoice is NOT a refusal
   * to pay, so the dunning sweeps divert it to a verification re-nudge instead of
   * an "overdue" notice.
   *
   * FAIL OPEN: returns false on a missing PI, no Stripe, or any retrieve error —
   * uncertainty must never SUPPRESS legitimate dunning for a genuinely-overdue
   * invoice. The caller only treats a positive result as "divert".
   */
  async isInvoiceAwaitingMicrodepositVerification(invoice) {
    const piId = invoice?.stripe_payment_intent_id;
    if (!piId) return false;
    const stripe = getStripe();
    if (!stripe) return false;
    try {
      const pi = await stripe.paymentIntents.retrieve(piId);
      return pi.status === 'requires_action'
        && pi.next_action?.type === 'verify_with_microdeposits';
    } catch (e) {
      logger.warn(`[stripe] micro-deposit-pending check failed for invoice ${invoice?.id || piId}: ${e.message}`);
      return false;
    }
  },

  // =========================================================================
  // CUSTOMER MANAGEMENT
  // =========================================================================

  /**
   * Create or retrieve a Stripe customer, store stripe_customer_id on customers table.
   * Returns the Stripe customer ID.
   */
  async ensureStripeCustomer(customerId) {
    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) throw new Error('Customer not found');

    // Already linked
    if (customer.stripe_customer_id) {
      return customer.stripe_customer_id;
    }

    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    try {
      const stripeCustomer = await stripe.customers.create({
        name: `${customer.first_name} ${customer.last_name}`,
        email: customer.email || undefined,
        phone: customer.phone || undefined,
        address: {
          line1: customer.address_line1,
          line2: customer.address_line2 || undefined,
          city: customer.city,
          state: customer.state,
          postal_code: customer.zip,
          country: 'US',
        },
        metadata: {
          waves_customer_id: customerId,
          waveguard_tier: customer.waveguard_tier || '',
        },
      }, {
        idempotencyKey: `cust-create-${customerId}`,
      });

      const stripeCustomerId = stripeCustomer.id;

      await db('customers')
        .where({ id: customerId })
        .update({ stripe_customer_id: stripeCustomerId });

      logger.info(`[stripe] Customer created: ${stripeCustomerId} for ${customerId}`);
      return stripeCustomerId;
    } catch (err) {
      logger.error(`[stripe] Customer creation failed: ${err.message}`);
      throw new Error('Failed to create Stripe customer');
    }
  },

  /**
   * Create or retrieve the PAYER's Stripe customer, persisting stripe_customer_id
   * on the payers row. Kept SEPARATE from ensureStripeCustomer (homeowner) so a
   * payer and a homeowner Stripe customer never cross — a NET-terms statement
   * charges the payer's AP card, never the resident's. Returns the Stripe
   * customer ID. (Phase-1 left payers.stripe_customer_id nullable + stored-only;
   * this is the first writer.)
   */
  async ensureStripePayerCustomer(payerId) {
    const payer = await db('payers').where({ id: payerId }).first();
    if (!payer) throw new Error('Payer not found');
    if (payer.stripe_customer_id) return payer.stripe_customer_id;

    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    try {
      const stripeCustomer = await stripe.customers.create({
        name: payer.company_name || payer.display_name,
        email: payer.ap_email || undefined,
        phone: payer.ap_phone || undefined,
        address: payer.billing_address_line1 ? {
          line1: payer.billing_address_line1,
          city: payer.billing_city || undefined,
          state: payer.billing_state || undefined,
          postal_code: payer.billing_zip || undefined,
          country: 'US',
        } : undefined,
        metadata: {
          waves_payer_id: String(payerId),
          payer_billing: 'true',
        },
      }, {
        idempotencyKey: `payer-cust-create-${payerId}`,
      });

      const stripeCustomerId = stripeCustomer.id;
      await db('payers')
        .where({ id: payerId })
        .update({ stripe_customer_id: stripeCustomerId, updated_at: db.fn.now() });

      logger.info(`[stripe] Payer Stripe customer created: ${stripeCustomerId} for payer ${payerId}`);
      return stripeCustomerId;
    } catch (err) {
      logger.error(`[stripe] Payer Stripe customer creation failed: ${err.message}`);
      throw new Error('Failed to create payer Stripe customer');
    }
  },

  // =========================================================================
  // SETUP INTENT (Card / ACH Save)
  // =========================================================================

  /**
   * Create a SetupIntent for saving a card or bank account.
   * The frontend uses this clientSecret to confirm via Stripe.js.
   * @param {string} customerId — Waves customer UUID
   * @param {string} [paymentMethodType] — 'card', 'us_bank_account', or 'card_or_bank'
   * @returns {{ clientSecret: string, setupIntentId: string }}
   */
  async createSetupIntent(customerId, paymentMethodType = 'card', opts = {}) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    const stripeCustomerId = await this.ensureStripeCustomer(customerId);

    const paymentMethodTypes = paymentMethodType === 'us_bank_account'
      ? ['us_bank_account']
      : paymentMethodType === 'card_or_bank'
        ? ['card', 'us_bank_account']
        : ['card'];

    try {
      const setupIntent = await stripe.setupIntents.create({
        customer: stripeCustomerId,
        payment_method_types: paymentMethodTypes,
        // Bank verification policy, stated explicitly (portal ACH lane):
        // Financial Connections first (instant verification inside the
        // Payment Element), micro-deposit fallback allowed — 'automatic'
        // is Stripe's default, pinned here so a Stripe default change
        // can't silently alter how bank accounts verify.
        ...(paymentMethodTypes.includes('us_bank_account') ? {
          payment_method_options: {
            us_bank_account: {
              financial_connections: { permissions: ['payment_method'] },
              verification_method: 'automatic',
            },
          },
        } : {}),
        // Callers may tag a purpose (e.g. 'covered_capture') so the
        // setup_intent.succeeded webhook can route completion; the
        // waves_customer_id key always wins over caller metadata.
        metadata: {
          ...(opts.metadata || {}),
          waves_customer_id: customerId,
        },
      });

      logger.info(`[stripe] SetupIntent created: ${setupIntent.id} for ${customerId}`);
      return {
        clientSecret: setupIntent.client_secret,
        setupIntentId: setupIntent.id,
        paymentMethodTypes,
      };
    } catch (err) {
      logger.error(`[stripe] SetupIntent creation failed: ${err.message}`);
      throw new Error('Failed to create setup intent');
    }
  },

  // =========================================================================
  // SAVE PAYMENT METHOD
  // =========================================================================

  /**
   * After the frontend confirms a SetupIntent, call this to persist
   * the payment method in our DB. Supports card + us_bank_account.
   * @param {string} customerId — Waves customer UUID
   * @param {string} paymentMethodId — Stripe pm_xxx ID
   * @param {object} [options]
   * @param {boolean} [options.enableAutopay=false] — mark this method chargeable by the monthly autopay cron
   * @param {boolean} [options.makeDefault=true] — make this the customer's default saved method
   * @returns {object} payment_methods row
   */
  async savePaymentMethod(customerId, paymentMethodId, options = {}) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    const stripeCustomerId = await this.ensureStripeCustomer(customerId);
    const enableAutopay = options.enableAutopay === true;
    const makeDefault = options.makeDefault !== false;

    try {
      // Retrieve PM first to verify it's not already attached to a DIFFERENT customer
      // (prevents an attacker from claiming someone else's saved payment method)
      const existingPm = await stripe.paymentMethods.retrieve(paymentMethodId);
      if (existingPm.customer && existingPm.customer !== stripeCustomerId) {
        logger.warn(`[stripe] Refusing to attach PM ${paymentMethodId} — owned by different Stripe customer`);
        throw new Error('Payment method does not belong to this customer');
      }

      // requireAttached (portal ACH lane, Codex #2706 r1): backstop callers
      // that would otherwise RE-ATTACH a detached method must not — a
      // customer who removed a pending bank row (removeCard detaches at
      // Stripe + deletes the row) would have it resurrected and enrolled by
      // the later setup_intent.succeeded event. A method the customer kept
      // is still attached (a succeeded SetupIntent attaches it), so this
      // cleanly distinguishes "browser died" from "customer removed it".
      if (options.requireAttached && existingPm.customer !== stripeCustomerId) {
        const detachedErr = new Error('Payment method is not attached to this customer');
        detachedErr.code = 'PM_NOT_ATTACHED';
        throw detachedErr;
      }

      // Attach PM to the Stripe customer (may already be attached via SetupIntent)
      try {
        await stripe.paymentMethods.attach(paymentMethodId, {
          customer: stripeCustomerId,
        });
      } catch (attachErr) {
        // Already attached — that's fine
        if (!attachErr.message.includes('already been attached')) {
          throw attachErr;
        }
      }

      // Retrieve full PM details (post-attach)
      const pm = await stripe.paymentMethods.retrieve(paymentMethodId);

      // Build DB record
      const record = {
        customer_id: customerId,
        processor: 'stripe',
        stripe_payment_method_id: paymentMethodId,
        stripe_customer_id: stripeCustomerId,
        is_default: makeDefault,
        autopay_enabled: enableAutopay,
      };

      if (pm.type === 'card' && pm.card) {
        record.method_type = 'card';
        record.card_brand = pm.card.brand ? pm.card.brand.toUpperCase() : null;
        record.card_funding = pm.card.funding || null;
        record.card_funding_checked_at = new Date();
        record.last_four = pm.card.last4;
        record.exp_month = String(pm.card.exp_month).padStart(2, '0');
        record.exp_year = String(pm.card.exp_year);
      } else if (pm.type === 'us_bank_account' && pm.us_bank_account) {
        record.method_type = 'ach';
        record.bank_name = pm.us_bank_account.bank_name;
        record.bank_last_four = pm.us_bank_account.last4;
        record.last_four = pm.us_bank_account.last4;
        // achStatus override (portal ACH lane): the micro-deposit deferred
        // save mirrors the row BEFORE verification, and the PM object
        // carries no reliable pending marker — without the override that
        // save would stamp an unverified account 'verified'.
        record.ach_status = options.achStatus || pm.us_bank_account.status || 'verified';
      }

      // Persisted ATOMICALLY with the row (Codex #2706 r5): a separate
      // post-insert update left a crash window where a pending bank row
      // existed without its SetupIntent id — removeCard then couldn't
      // cancel the hosted verification and the tombstone guarantee broke.
      if (options.setupIntentId) {
        record.stripe_setup_intent_id = options.setupIntentId;
      }

      let saved;
      try {
        saved = await db.transaction(async trx => {
          const [inserted] = await trx('payment_methods').insert(record).returning('*');
          if (makeDefault) {
            await trx('payment_methods')
              .where({ customer_id: customerId })
              .whereNot({ id: inserted.id })
              .update({ is_default: false });
          }
          return inserted;
        });
      } catch (insertErr) {
        // Duplicate-key race (Codex #2706 r1): the browser's POST /cards
        // and the setup_intent.succeeded webhook both do lookup-first
        // before this plain insert under the unique
        // stripe_payment_method_id index — when both lookups miss, one
        // insert loses. The row the winner created IS the desired
        // outcome: reload it (ownership-checked) instead of turning a
        // successful save into a 500/webhook retry.
        const isDuplicate = insertErr.code === '23505' || /duplicate key value/i.test(insertErr.message || '');
        if (!isDuplicate) throw insertErr;
        const existingRow = await db('payment_methods')
          .where({ stripe_payment_method_id: paymentMethodId })
          .first();
        if (!existingRow || existingRow.customer_id !== customerId) {
          throw new Error('Payment method does not belong to this customer');
        }
        logger.info(`[stripe] Payment method save raced an existing row for ${customerId}: ${paymentMethodId} — reusing it`);
        saved = existingRow;
      }

      logger.info(`[stripe] Payment method saved for ${customerId}: ${pm.type} ****${record.last_four}`);
      return saved;
    } catch (err) {
      // Typed sentinel for backstop callers — must survive the generic wrap.
      if (err.code === 'PM_NOT_ATTACHED') throw err;
      logger.error(`[stripe] Save payment method failed: ${err.message}`);
      throw new Error('Failed to save payment method');
    }
  },

  // =========================================================================
  // GET CARDS (All payment methods — both processors)
  // =========================================================================

  /**
   * Return all payment_methods for a customer (Stripe)
   */
  async getCards(customerId) {
    return db('payment_methods')
      .where({ customer_id: customerId })
      .orderBy('is_default', 'desc')
      .orderBy('created_at', 'desc');
  },

  // =========================================================================
  // RESOLVE PAYMENT METHOD TYPE (via Stripe)
  // =========================================================================

  /**
   * Retrieve a PaymentIntent with optional Stripe `expand` keys.
   * Returns null if Stripe isn't configured. Throws on Stripe errors so
   * callers can decide whether to fail closed or degrade.
   *
   * Used by routes that need server-verified PaymentIntent facts (e.g.
   * consent snapshotting on the public /pay endpoint) where trusting
   * client-supplied fields would defeat the audit trail.
   */
  async retrievePaymentIntent(paymentIntentId, options = {}) {
    if (!paymentIntentId) return null;
    const stripe = getStripe();
    if (!stripe) return null;
    return stripe.paymentIntents.retrieve(paymentIntentId, options);
  },

  async retrieveSetupIntent(setupIntentId, options = {}) {
    if (!setupIntentId) return null;
    const stripe = getStripe();
    if (!stripe) return null;
    return stripe.setupIntents.retrieve(setupIntentId, options);
  },

  async retrievePaymentMethod(paymentMethodId) {
    if (!paymentMethodId) return null;
    const stripe = getStripe();
    if (!stripe) return null;
    return stripe.paymentMethods.retrieve(paymentMethodId);
  },

  /**
   * Cancel a PaymentIntent. Returns null if Stripe isn't configured.
   * Throws on Stripe errors — including the race where the intent has
   * already moved to processing/succeeded and can no longer be cancelled —
   * so callers can fail closed (e.g. skip auto-voiding an invoice whose
   * payment may be in flight).
   */
  async cancelPaymentIntent(paymentIntentId, options = {}) {
    if (!paymentIntentId) return null;
    const stripe = getStripe();
    if (!stripe) return null;
    return stripe.paymentIntents.cancel(paymentIntentId, options);
  },

  /**
   * PaymentIntent for a required estimate-acceptance deposit. Not linked to
   * any invoice — the webhook and accept-time verification route on
   * metadata.purpose, and the deposit is later credited against the first
   * invoice as a negative line item. Idempotency keyed on estimate+amount so
   * retrying the deposit step reuses the same intent instead of stacking
   * duplicate authorizations — which is also why every create param below
   * must be deterministic from (estimateId, amountCents): a mutable field
   * (e.g. receipt_email) under the same key makes Stripe reject the retry
   * as a key reuse with different parameters. The payer's receipt comes
   * from the Payment Element's collected email, not from this intent.
   * retryGeneration (the caller's count of terminal ledger rows) joins the
   * key after a refund/dispute/failure, so a replacement deposit mints a
   * fresh PI instead of Stripe replaying the old refunded one.
   */
  async createEstimateDepositIntent({ estimateId, amountDollars, retryGeneration = 0 }) {
    const stripe = getStripe();
    if (!stripe) return null;
    // OWNER RULING 2026-07-13 (reverses the 2026-06-12 exemption): deposits
    // are surcharged like invoice payments — credit-funding-only, quoted at
    // confirm via quoteEstimateDepositSurcharge → finalizeEstimateDeposit-
    // Payment below. The PI still MINTS at face value because funding is
    // unknown until the customer enters a card (and wallets stay at face
    // value permanently — Phase-1: Express Checkout is surcharge-free).
    // The invoice credit is the FACE value (base_amount), never the
    // surcharged total — "pay a $49 deposit, $49 is credited" still holds;
    // the surcharge is a processing fee on top, recorded separately
    // (estimate_deposits.card_surcharge).
    const amountCents = Math.round(Number(amountDollars) * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      throw new Error('Invalid deposit amount');
    }
    return stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      // Instant tenders only. The accept gate requires the PI to be
      // `succeeded` BEFORE acceptance commits — a delayed method (ACH bank
      // debit) would sit in `processing`, bounce the accept with 402, and
      // then succeed days later against an unaccepted estimate.
      payment_method_types: ['card'],
      description: 'Waves service deposit — applied toward your first visit',
      metadata: {
        purpose: 'estimate_deposit',
        estimate_id: String(estimateId),
        // The invoice-credit authority: the ledger records THIS amount as
        // the deposit, whatever the PI ultimately captures. Every consumer
        // (webhook, accept-time live verification, refunds) derives the
        // face value from here, never from amount_received — a surcharged
        // capture must not inflate the credit.
        base_amount: String(amountCents / 100),
        // Deposit finalize stamps card_surcharge/funding on top of this at
        // confirm time; a PI that captures with the policy still at
        // quote_at_confirm and no card_surcharge key was a wallet or
        // never-quoted confirm at face value.
        surcharge_policy: 'quote_at_confirm',
      },
    // `_qac1` salts the key for the surcharge revert: the create params
    // changed (base_amount + quote_at_confirm metadata), and Stripe rejects
    // a reused idempotency key with different params — an in-flight customer
    // holding a pre-revert pending PI would 500 on retry instead of getting
    // a fresh intent (Codex #2705 r2 P2). The old pending PI is simply
    // abandoned (never confirmed; Stripe expires it).
    }, { idempotencyKey: `estimate_deposit_${estimateId}_${amountCents}_qac1${Number(retryGeneration) > 0 ? `_r${Number(retryGeneration)}` : ''}` });
  },

  /**
   * Surcharge quote for an EXISTING deposit PaymentIntent — the deposit half
   * of the invoice /quote → /finalize pattern (see quoteInvoiceSurcharge).
   * The base is the PI's pinned face value (metadata.base_amount), NOT a
   * policy re-derivation: deposit-intent already ran every accept-mirror
   * gate when it minted the PI, and the missing-amount math must not shift
   * between mint and confirm. Credit-funding-only via computeChargeAmount —
   * debit/prepaid/unknown quote 0 and pay face value.
   */
  async quoteEstimateDepositSurcharge({ estimateId, paymentIntentId, paymentMethodId }) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    // Preview API version on ALL deposit PI re-reads: amount_details is a
    // preview-only field (terminal precedent, stripe-terminal.js) — the
    // default version omits it, which would blind the stale-breakdown
    // detection in finalize/reset (Codex #2705 r3 P2).
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {}, { apiVersion: SURCHARGE_API_VERSION });
    assertDepositIntentForEstimate(pi, estimateId);
    if (pi.status === 'succeeded' || pi.status === 'processing') {
      const err = new Error('This deposit is already paid');
      err.statusCode = 409;
      throw err;
    }

    let pm;
    try {
      pm = await stripe.paymentMethods.retrieve(paymentMethodId);
    } catch (err) {
      throw new Error(`Could not retrieve payment method: ${err.message}`);
    }
    const funding = pm.card?.funding || null;
    const baseAmount = depositFaceValueDollars(pi);

    const { baseCents, surchargeCents, totalCents, rateBps } = computeChargeAmount(
      baseAmount,
      pm.type || 'card',
      { funding },
    );

    const crypto = require('crypto');
    const hmacSecret = process.env.JWT_SECRET;
    if (!hmacSecret) throw new Error('JWT_SECRET is required for surcharge quote signing');
    const payloadJson = JSON.stringify({
      kind: 'estimate_deposit',
      estimateId: String(estimateId),
      paymentIntentId,
      paymentMethodId,
      baseAmount,
      quotedAt: Date.now(),
    });
    const signature = crypto.createHmac('sha256', hmacSecret).update(payloadJson).digest('base64url');
    const quoteToken = `${Buffer.from(payloadJson).toString('base64url')}.${signature}`;

    return {
      quoteToken,
      base: baseCents / 100,
      surcharge: surchargeCents / 100,
      total: totalCents / 100,
      rateBps,
      funding,
      methodType: pm.type || 'card',
    };
  },

  /**
   * Finalize a deposit payment from a prior deposit quote: re-derive the
   * surcharge from the live PM (never trust the client's numbers), update
   * the PI to the surcharged total with the recorded-surcharge metadata,
   * and confirm server-side. Mirrors finalizeInvoicePayment, minus save-card
   * (the deposit PI is customerless by design — the idempotent create params
   * must stay deterministic) and minus invoice state. requires_action (3DS)
   * returns clientSecret for the client's handleNextAction.
   */
  async finalizeEstimateDepositPayment({ estimateId, quoteToken }) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    const crypto = require('crypto');
    const hmacSecret = process.env.JWT_SECRET;
    if (!hmacSecret) throw new Error('JWT_SECRET is required for surcharge quote signing');
    let quote;
    try {
      const [payloadPart, sigPart] = quoteToken.split('.');
      if (!payloadPart || !sigPart) throw new Error('malformed');
      const expectedSig = crypto.createHmac('sha256', hmacSecret).update(Buffer.from(payloadPart, 'base64url').toString()).digest('base64url');
      if (sigPart !== expectedSig) throw new Error('signature mismatch');
      quote = JSON.parse(Buffer.from(payloadPart, 'base64url').toString());
    } catch {
      throw new Error('Invalid or tampered quote token');
    }
    if (quote.kind !== 'estimate_deposit' || String(quote.estimateId) !== String(estimateId)) {
      throw new Error('Quote token does not match this deposit');
    }
    if (Date.now() - (quote.quotedAt || 0) > 10 * 60 * 1000) {
      throw new Error('Quote expired — please try again');
    }

    // Preview version — amount_details is invisible on the default version
    // (see quoteEstimateDepositSurcharge).
    const pi = await stripe.paymentIntents.retrieve(quote.paymentIntentId, {}, { apiVersion: SURCHARGE_API_VERSION });
    assertDepositIntentForEstimate(pi, estimateId);
    if (pi.status === 'succeeded') {
      // Replay tolerance, mirroring the client's retrieve-before-confirm
      // short-circuit: a double-tap or webhook race lands here.
      return { paymentIntentId: pi.id, status: 'succeeded', requiresAction: false };
    }

    const pm = await stripe.paymentMethods.retrieve(quote.paymentMethodId);
    const funding = pm.card?.funding || null;
    const baseAmount = depositFaceValueDollars(pi);
    if (quote.baseAmount != null && Math.abs(baseAmount - quote.baseAmount) > 0.01) {
      throw new Error('Deposit amount changed since quote was created. Please try again.');
    }

    const { baseCents, surchargeCents, totalCents, rateBps, policyVersion } = computeChargeAmount(
      baseAmount,
      pm.type || 'card',
      { funding },
    );
    const surchargeDetails = buildSurchargeAmountDetails(surchargeCents);
    // A failed surcharged attempt can leave a stale Stripe-side surcharge
    // breakdown on the PI; a no-fee retry (debit after a declined credit)
    // must clear it or the face-value settle carries the old fee breakdown
    // (Codex #2705 r2 P2). Empty string is Stripe's unset form.
    const staleDetails = !surchargeDetails && Number(pi.amount_details?.surcharge?.amount || 0) > 0;
    const usePreview = !!surchargeDetails || staleDetails;

    const updateParams = {
      amount: totalCents,
      payment_method: quote.paymentMethodId,
      // Stripe metadata updates MERGE keys: purpose/estimate_id/
      // base_amount from the create stay intact. A PENDING PI minted
      // BEFORE the surcharge revert replays under the unchanged
      // idempotency key with no base_amount pinned — stamp it here
      // (from the pre-update amount, which WAS its face value) or a
      // surcharged capture would credit face + fee (Codex #2705 P2).
      metadata: {
        ...(pi.metadata?.base_amount ? {} : { base_amount: String(baseAmount) }),
        card_surcharge: String(surchargeCents / 100),
        surcharge_rate_bps: String(rateBps),
        surcharge_policy_version: policyVersion,
        card_funding: funding || 'unknown',
        // In-flight marker: the public /deposit-reset refuses to strip the
        // surcharge while a finalize is between this update and its
        // confirm — a second tab calling reset in that window would confirm
        // the attached credit card WITHOUT the disclosed fee
        // (Codex #2705 r5 P2). 120s TTL so an orphaned stamp (crash
        // mid-finalize) can't brick the wallet path.
        finalize_started_at: String(Date.now()),
      },
      ...(surchargeDetails ? { amount_details: surchargeDetails } : {}),
      ...(staleDetails ? { amount_details: '' } : {}),
    };
    try {
      await stripe.paymentIntents.update(
        quote.paymentIntentId,
        updateParams,
        usePreview ? { apiVersion: SURCHARGE_API_VERSION } : undefined,
      );
    } catch (err) {
      // The amount_details unset is a preview param — if this account/
      // version rejects the empty-string form, retry without it rather
      // than blocking a valid no-fee payment on breakdown hygiene.
      if (staleDetails) {
        logger.warn(`[stripe] Deposit finalize amount_details unset rejected for ${quote.paymentIntentId} (${err.message}) — retrying without`);
        try {
          const { amount_details: _drop, ...withoutDetails } = updateParams;
          await stripe.paymentIntents.update(quote.paymentIntentId, withoutDetails);
        } catch (retryErr) {
          logger.error(`[stripe] Deposit finalize update failed for PI ${quote.paymentIntentId}: ${retryErr.message}`);
          throw new Error(`Failed to finalize deposit payment: ${retryErr.message}`);
        }
      } else {
        logger.error(`[stripe] Deposit finalize update failed for PI ${quote.paymentIntentId}: ${err.message}`);
        throw new Error(`Failed to finalize deposit payment: ${err.message}`);
      }
    }
    try {
      // Verify our update is still what the PI carries before charging —
      // a concurrent (pre-stamp) reset could have stripped the amount back
      // to face; confirming then would charge the attached credit card
      // WITHOUT the disclosed fee. TOCTOU narrows to milliseconds and the
      // in-flight stamp blocks the practical multi-tab path.
      const preConfirm = await stripe.paymentIntents.retrieve(quote.paymentIntentId, {}, { apiVersion: SURCHARGE_API_VERSION });
      if (Number(preConfirm.amount) !== totalCents) {
        throw new Error('Deposit amount changed during payment — please try again.');
      }
      const confirmed = await stripe.paymentIntents.confirm(
        quote.paymentIntentId,
        {},
        usePreview ? { apiVersion: SURCHARGE_API_VERSION } : undefined,
      );
      logger.info(`[stripe] Finalized estimate deposit ${estimateId}: funding=${funding} surcharge=${surchargeCents}c total=${totalCents}c PI=${confirmed.id} status=${confirmed.status}`);
      return {
        paymentIntentId: confirmed.id,
        clientSecret: confirmed.client_secret,
        status: confirmed.status,
        requiresAction: confirmed.status === 'requires_action',
        base: baseCents / 100,
        surcharge: surchargeCents / 100,
        total: totalCents / 100,
        rateBps,
        funding,
      };
    } catch (err) {
      // The PI now carries the surcharged amount but the charge FAILED —
      // both deposit UIs keep Express Checkout mounted, and a wallet tap
      // would confirm the poisoned total even though wallets pay face
      // value (Codex #2705 P1). Best-effort reset back to face before
      // surfacing the failure (force: our own failure-path reset must
      // clear the in-flight stamp it just wrote); the client-side wallet
      // preflight is the second layer.
      await this.resetEstimateDepositIntentToFace({
        estimateId,
        paymentIntentId: quote.paymentIntentId,
        force: true,
      }).catch((resetErr) => {
        logger.warn(`[stripe] Deposit PI reset after failed finalize also failed for ${quote.paymentIntentId}: ${resetErr.message}`);
      });
      logger.error(`[stripe] Deposit finalize failed for PI ${quote.paymentIntentId}: ${err.message}`);
      throw new Error(`Failed to finalize deposit payment: ${err.message}`);
    }
  },

  /**
   * Reset a deposit PI back to its FACE value and clear the surcharge
   * metadata a failed/abandoned manual-card finalize left behind, so a
   * wallet confirm (Express Checkout pays face value — Phase-1) can never
   * capture a stale surcharged total.
   * Returns { reset, clean, status }:
   *   clean=true  — the PI is at face value with no fee residue (either it
   *                 already was, or this call just reset it). Safe for a
   *                 wallet to confirm.
   *   clean=false — residue remains and this call could NOT clear it
   *                 (succeeded/processing/canceled, or mid-3DS
   *                 requires_action where an amount update is not reliably
   *                 supported). The wallet preflight must NOT proceed —
   *                 the 3DS challenge expiring returns the PI to
   *                 requires_payment_method, after which a retry resets it.
   */
  async resetEstimateDepositIntentToFace({ estimateId, paymentIntentId, force = false }) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');
    // Preview version — amount_details is invisible on the default version
    // (see quoteEstimateDepositSurcharge).
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {}, { apiVersion: SURCHARGE_API_VERSION });
    assertDepositIntentForEstimate(pi, estimateId);
    const faceCents = Math.round(depositFaceValueDollars(pi) * 100);
    const staleDetailsCents = Number(pi.amount_details?.surcharge?.amount || 0);
    const hasSurchargeResidue = Number(pi.amount) !== faceCents
      || pi.metadata?.card_surcharge != null
      || staleDetailsCents > 0;
    if (!['requires_payment_method', 'requires_confirmation'].includes(pi.status)) {
      return { reset: false, clean: !hasSurchargeResidue, status: pi.status };
    }
    if (!faceCents || !hasSurchargeResidue) {
      return { reset: false, clean: true, status: pi.status };
    }
    // A manual-card finalize is IN FLIGHT (between its update and confirm):
    // a public reset here would strip the disclosed fee off the attached
    // credit card before the confirm charges it (Codex #2705 r5 P2). Only
    // the finalize's own failure path (force) may reset through the stamp;
    // the 120s TTL unbricks an orphaned stamp from a crash mid-finalize —
    // the surcharge residue then clears on the next preflight.
    const finalizeStartedAt = Number(pi.metadata?.finalize_started_at || 0);
    if (!force && finalizeStartedAt > 0 && Date.now() - finalizeStartedAt < 120 * 1000) {
      return { reset: false, clean: false, status: pi.status, inFlight: true };
    }
    const resetParams = {
      amount: faceCents,
      // Empty string DELETES a metadata key on Stripe — the fee facts
      // belong only to a capture that actually collected the fee. The
      // in-flight stamp clears with them: this reset IS the finalize's
      // terminal state.
      metadata: {
        card_surcharge: '',
        surcharge_rate_bps: '',
        surcharge_policy_version: '',
        card_funding: '',
        finalize_started_at: '',
      },
    };
    // Clear the Stripe-side surcharge breakdown a failed surcharged attempt
    // configured (Codex #2705 r2 P2) — otherwise a face-value settle carries
    // a stale fee breakdown. Empty string is Stripe's documented unset form;
    // amount_details is a preview param, so if this account/version rejects
    // the unset, fall back to resetting amount + metadata alone (still
    // strictly better than leaving the poisoned total).
    if (staleDetailsCents > 0) {
      try {
        await stripe.paymentIntents.update(
          paymentIntentId,
          { ...resetParams, amount_details: '' },
          { apiVersion: SURCHARGE_API_VERSION },
        );
        logger.info(`[stripe] Deposit PI ${paymentIntentId} reset to face value (${faceCents}c, surcharge details cleared) for estimate ${estimateId}`);
        return { reset: true, clean: true, status: pi.status };
      } catch (clearErr) {
        logger.warn(`[stripe] Deposit PI ${paymentIntentId} amount_details unset rejected (${clearErr.message}) — resetting amount/metadata only`);
      }
    }
    await stripe.paymentIntents.update(paymentIntentId, resetParams);
    logger.info(`[stripe] Deposit PI ${paymentIntentId} reset to face value (${faceCents}c) for estimate ${estimateId}`);
    return { reset: true, clean: true, status: pi.status };
  },

  /**
   * SetupIntent for a one-time card-on-file HOLD (dark until ONE_TIME_CARD_HOLD).
   * Captures a card to RESERVE a one-time visit WITHOUT charging at booking.
   * Customerless on purpose: the one-time estimate may have no customer record
   * until acceptance creates one — the SetupIntent still yields a reusable
   * payment_method that accept-time attaches to the customer it links/creates.
   * usage:'off_session' so the saved card can later be charged (completion
   * total / no-show fee) with the cardholder absent. Pinned to the estimate via
   * metadata; the webhook and accept verification both re-derive trust from
   * purpose+estimate_id server-side rather than believing the client.
   * `generation` salts the idempotency key so a fresh capture attempt (after a
   * prior intent is abandoned/superseded) mints a new intent instead of
   * replaying an old one inside Stripe's idempotency window.
   */
  async createEstimateCardHoldSetupIntent({ estimateId, generation = 0 }) {
    const stripe = getStripe();
    if (!stripe) return null;
    return stripe.setupIntents.create({
      payment_method_types: ['card'],
      usage: 'off_session',
      description: 'Waves one-time visit — card on file to hold your appointment',
      metadata: {
        purpose: 'estimate_card_hold',
        estimate_id: String(estimateId),
      },
    }, { idempotencyKey: `estimate_card_hold_${estimateId}${Number(generation) > 0 ? `_g${Number(generation)}` : ''}` });
  },

  /**
   * SetupIntent for the recurring-accept Auto Pay card (dark until
   * RECURRING_CARD_ON_FILE). Mirrors the one-time card-hold SetupIntent:
   * customerless on purpose (the recurring estimate may have no customer
   * record until acceptance creates one — the intent still yields a reusable
   * payment_method that accept-time attaches + enrolls), usage:'off_session'
   * so completed applications can charge with the cardholder absent, and
   * pinned to the estimate via metadata so accept verification re-derives
   * trust from purpose+estimate_id server-side rather than believing the
   * client. Idempotency is keyed on (estimate, generation) — every create
   * param is deterministic from them — so a reopened capture step replays the
   * SAME intent (a succeeded replay short-circuits in the capture modal),
   * while the caller walks `generation` forward past a canceled replay to
   * mint a usable replacement (same reason the card-hold flow salts).
   */
  async createRecurringCardSetupIntent({ estimateId, generation = 0 }) {
    const stripe = getStripe();
    if (!stripe) return null;
    return stripe.setupIntents.create({
      payment_method_types: ['card'],
      usage: 'off_session',
      description: 'Waves recurring plan — card on file for Auto Pay',
      metadata: {
        purpose: 'estimate_recurring_card',
        estimate_id: String(estimateId),
      },
    }, { idempotencyKey: `estimate_recurring_card_${estimateId}${Number(generation) > 0 ? `_g${Number(generation)}` : ''}` });
  },

  /**
   * Off-session charge of a SPECIFIC saved payment method (not the default
   * autopay card the way charge() requires). Used by the one-time card-hold
   * flow for the flat no-show / late-cancel fee — a penalty with no invoice or
   * service rendered, so it does NOT route through the invoice charge path.
   * Charged at FACE VALUE, surcharge-exempt: the amount the customer consented
   * to at booking ("$49 if you no-show") must equal what we charge, and a card
   * surcharge on an auto-charge the cardholder didn't actively initiate invites
   * disputes. Throws on decline / authentication_required so the caller records
   * the failure; idempotency-keyed so retries replay one PaymentIntent.
   */
  async chargeSavedPaymentMethodOffSession({ customerId, paymentMethodId, amountDollars, description, metadata = {}, idempotencyKey = null }) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');
    if (!paymentMethodId) throw new Error('No payment method to charge');
    const amountCents = Math.round(Number(amountDollars) * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0) throw new Error('Invalid charge amount');
    const stripeCustomerId = await this.ensureStripeCustomer(customerId);
    const effectiveIdempotencyKey = idempotencyKey
      || `pm_charge_${paymentMethodId}_${amountCents}_${require('crypto').randomUUID()}`;
    return stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      customer: stripeCustomerId,
      payment_method: paymentMethodId,
      off_session: true,
      confirm: true,
      expand: ['latest_charge'],
      description,
      metadata: { waves_customer_id: customerId, ...metadata },
    }, { idempotencyKey: effectiveIdempotencyKey });
  },

  /**
   * Raw refund of a PaymentIntent — for money that should never have been
   * collected (a stale estimate deposit that succeeded after the estimate
   * became unacceptable) or the unapplied remainder of a deposit (partial,
   * via amountCents). The payments-table refund() flow doesn't apply:
   * deposits have no payments row. Idempotency-keyed on the PI (plus the
   * amount for partials) so webhook replays can't double-refund.
   */
  async refundPaymentIntent(paymentIntentId, { reason = 'requested_by_customer', amountCents = null } = {}) {
    if (!paymentIntentId) return null;
    const stripe = getStripe();
    if (!stripe) return null;
    const partial = Number.isFinite(Number(amountCents)) && Number(amountCents) > 0;
    return stripe.refunds.create(
      {
        payment_intent: paymentIntentId,
        reason,
        ...(partial ? { amount: Math.round(Number(amountCents)) } : {}),
      },
      { idempotencyKey: partial ? `refund_pi_${paymentIntentId}_${Math.round(Number(amountCents))}` : `refund_pi_${paymentIntentId}` },
    );
  },

  // =========================================================================
  // REMOVE CARD
  // =========================================================================

  /**
   * Detach a payment method via Stripe.
   */
  async removeCard(customerId, cardId) {
    const card = await db('payment_methods')
      .where({ id: cardId, customer_id: customerId })
      .first();

    if (!card) throw new Error('Payment method not found');

    if (card.processor === 'stripe' && card.stripe_payment_method_id) {
      const stripe = getStripe();
      if (!stripe) throw new Error('Stripe not configured');

      // Removing an UNVERIFIED bank cancels its SetupIntent first (Codex
      // #2706 r4): Stripe can complete the original hosted micro-deposit
      // verification even after a detach and RE-ATTACH the payment method,
      // so attachment state alone can't prove the customer kept it. A
      // canceled SetupIntent can never succeed → the portal webhook can
      // never resurrect the removed account. Cancel failure falls back to
      // reading the SI: already succeeded/canceled → removal proceeds
      // (the detach + requireAttached pair covers those); anything else →
      // fail closed and let the customer retry.
      if (require('./autopay-eligibility').isBankMethodType(card.method_type) && card.ach_status !== 'verified' && card.stripe_setup_intent_id) {
        try {
          await stripe.setupIntents.cancel(card.stripe_setup_intent_id);
        } catch (cancelErr) {
          let si = null;
          try { si = await stripe.setupIntents.retrieve(card.stripe_setup_intent_id); } catch { /* fail closed below */ }
          if (!si || !['canceled', 'succeeded'].includes(si.status)) {
            logger.error(`[stripe] SetupIntent cancel failed and state unverifiable — refusing removal: ${cancelErr.message}`);
            throw new Error('Could not remove the payment method — please try again.');
          }
        }
      }

      try {
        await stripe.paymentMethods.detach(card.stripe_payment_method_id);
      } catch (err) {
        // Only proceed when the PM is GENUINELY no longer attached (Codex
        // #2706 r2): swallowing a transient detach failure used to delete
        // the local row while the PM stayed attached at Stripe, and the
        // requireAttached backstop then treats "attached" as "customer
        // kept it" — resurrecting a removed pending bank on verification.
        // Verify, and fail closed when we can't.
        let stillAttached = true;
        try {
          const pmCheck = await stripe.paymentMethods.retrieve(card.stripe_payment_method_id);
          stillAttached = !!pmCheck.customer;
        } catch { /* can't verify — fail closed */ }
        if (stillAttached) {
          logger.error(`[stripe] Detach failed and PM still attached — refusing removal: ${err.message}`);
          throw new Error('Could not remove the payment method — please try again.');
        }
        logger.warn(`[stripe] Detach warning (PM already detached, proceeding with DB removal): ${err.message}`);
      }
      await db('payment_methods').where({ id: cardId }).del();
      await this._disableAutopayIfMethodRemoved(customerId, card);
      logger.info(`[stripe] Payment method removed for ${customerId}: ${cardId}`);
      return { success: true };
    }

    // Fallback — just remove from DB
    await db('payment_methods').where({ id: cardId }).del();
    await this._disableAutopayIfMethodRemoved(customerId, card);
    logger.info(`[stripe] Payment method removed (DB only) for ${customerId}: ${cardId}`);
    return { success: true };
  },

  /**
   * Removing the card that carried Auto Pay used to leave the customer's
   * autopay flags pointing at a deleted row — the cron silently stopped
   * charging while the AutopayCard still showed Active. Disable autopay
   * honestly so the UI shows Off with a set-up CTA.
   */
  async _disableAutopayIfMethodRemoved(customerId, removedCard) {
    if (!removedCard?.autopay_enabled) return;
    try {
      await db('customers')
        .where({ id: customerId })
        .update({ autopay_enabled: false, autopay_payment_method_id: null });
      const { logAutopay } = require('./autopay-log');
      await logAutopay(customerId, 'autopay_disabled', {
        details: { source: 'payment_method_removed', payment_method_id: removedCard.id },
      });
    } catch (err) {
      logger.warn(`[stripe] autopay cleanup after card removal failed for ${customerId}: ${err.message}`);
    }
  },

  // =========================================================================
  // CHARGE — Off-session PaymentIntent
  // =========================================================================

  /**
   * Charge a customer's default Stripe payment method.
   * @param {string} customerId — Waves customer UUID
   * @param {number} amountDollars — charge amount in dollars
   * @param {string} description — charge description
   * @param {object} [metadata] — extra Stripe metadata
   * @param {string} [idempotencyKey] — Stripe idempotency key scoped to the
   *   caller's durable business operation (e.g. autopay_monthly_<cid>_<date>,
   *   autopay_retry_<paymentId>_<rung>). When omitted a random per-call key
   *   is generated, which still lets the SDK's network retries replay the
   *   same request but provides no cross-process dedupe.
   * @returns {object} payments table row
   */
  async charge(customerId, amountDollars, description, metadata = {}, idempotencyKey = null) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) throw new Error('Customer not found');

    const card = await db('payment_methods')
      .where({ customer_id: customerId, processor: 'stripe', is_default: true, autopay_enabled: true })
      .first();

    if (!card || !card.stripe_payment_method_id) {
      throw new Error('No Stripe autopay payment method on file');
    }

    const stripeCustomerId = await this.ensureStripeCustomer(customerId);

    // Apply credit card surcharge when funding is confirmed as 'credit'.
    // Debit/prepaid/unknown-funding/ACH pay the quoted amount with no surcharge.
    if (card.method_type === 'card' && !card.card_funding && card.stripe_payment_method_id) {
      try {
        const pmObj = await stripe.paymentMethods.retrieve(card.stripe_payment_method_id);
        const fetchedFunding = pmObj.card?.funding || null;
        if (fetchedFunding) {
          card.card_funding = fetchedFunding;
          await db('payment_methods').where({ id: card.id }).update({
            card_funding: fetchedFunding,
            card_funding_checked_at: new Date(),
          });
          logger.info(`[stripe] Backfilled card_funding=${fetchedFunding} for card ${card.id}`);
        }
      } catch (fetchErr) {
        logger.warn(`[stripe] Could not fetch funding for card ${card.id}: ${fetchErr.message}`);
      }
    }
    const chargeInfo = computeChargeAmount(amountDollars, card.method_type, { funding: card.card_funding });
    const { baseCents, surchargeCents, totalCents, rateBps, policyVersion } = chargeInfo;
    const baseAmount = baseCents / 100;
    const surchargeAmount = surchargeCents / 100;
    const totalAmount = totalCents / 100;

    // Build Stripe surcharge amount_details (null when no surcharge)
    const surchargeDetails = buildSurchargeAmountDetails(surchargeCents);

    // Step 1: Charge via Stripe. Expand latest_charge so we can read
    // receipt_url off it directly (the prior `paymentIntent.charges.data`
    // path was removed by Stripe's 2022-11-15 API; latest_charge is the
    // supported replacement and survives future API bumps).
    // Idempotency key: callers pass a key scoped to their durable
    // business operation so overlapping cron instances (deploy window)
    // and post-ambiguity re-runs replay the SAME PaymentIntent at
    // Stripe instead of charging twice. The random fallback still
    // gives the SDK's maxNetworkRetries a stable key to replay
    // connection blips within this call. Replayed outcomes — success
    // AND failure — are collapsed to a single ledger row by the
    // advisory-locked writes below.
    const effectiveIdempotencyKey = idempotencyKey
      || `charge_${customerId}_${require('crypto').randomUUID()}`;

    let paymentIntent;
    try {
      // Saved-method charges support BOTH tender families (mirrors
      // chargeInvoiceWithSavedCard's documented lock — Codex #2706 r6 P1):
      // a PI without payment_method_types defaults to ['card'] and Stripe
      // refuses to confirm it against a us_bank_account pm, so the monthly
      // cron would fail every ACH Auto Pay account on its next run. An ACH
      // confirm lands 'processing' (not 'succeeded'); the paid/processing
      // status mapping below already handles that lifecycle, and
      // computeChargeAmount already priced ACH surcharge-free.
      const savedMethodIsBank = require('./autopay-eligibility').isBankMethodType(card.method_type);
      const piParams = {
        amount: totalCents,
        currency: 'usd',
        customer: stripeCustomerId,
        payment_method: card.stripe_payment_method_id,
        payment_method_types: [savedMethodIsBank ? 'us_bank_account' : 'card'],
        off_session: true,
        confirm: true,
        expand: ['latest_charge'],
        description: surchargeAmount > 0
          ? `${description} (includes $${surchargeAmount.toFixed(2)} credit card surcharge)`
          : description,
        metadata: {
          waves_customer_id: customerId,
          base_amount: String(baseAmount),
          card_surcharge: String(surchargeAmount),
          surcharge_rate_bps: String(rateBps),
          surcharge_policy_version: policyVersion,
          ...metadata,
        },
      };
      if (surchargeDetails) piParams.amount_details = surchargeDetails;
      paymentIntent = await stripe.paymentIntents.create(piParams, {
        idempotencyKey: effectiveIdempotencyKey,
        ...(surchargeDetails ? { apiVersion: SURCHARGE_API_VERSION } : {}),
      });
    } catch (err) {
      // Stripe charge failed — record the failure
      logger.error(`[stripe] Charge failed for ${customerId}: ${err.message}`);

      // Detect SCA / step-up authentication required. Off-session
      // PaymentIntents can land in `requires_action` when the cardholder's
      // bank demands 3DS — Stripe surfaces it as code/decline_code
      // 'authentication_required' on the thrown error and the PI exists in
      // requires_action state. The customer SMS path is already wired via
      // payment_intent.requires_action in the webhook handler; the cron
      // just needs to NOT schedule a retry against the same wall.
      const authCode = err.code || err.raw?.code || err.decline_code || err.raw?.decline_code;
      const requiresAction = authCode === 'authentication_required';
      const piIdFromErr = err.payment_intent?.id || err.raw?.payment_intent?.id || null;
      // A no-PI failure is only AMBIGUOUS (Stripe may have processed the
      // request) for connection/API errors. Deterministic pre-charge
      // failures — invalid params, detached payment method — definitely
      // moved no money and stay safe to auto-retry. The retry sweep
      // parks ambiguous rows for manual reconciliation.
      const errType = err.type || err.raw?.type || null;
      const ambiguousOutcome = isAmbiguousStripeChargeError(err);

      // Replay-aware failure record: with durable idempotency keys,
      // overlapping workers can both receive the same replayed decline
      // (same PI on the error). Serialize on the PI — or on the
      // idempotency key when Stripe failed before minting a PI — and
      // reuse the existing failed row instead of inserting a duplicate,
      // which would seed duplicate retry-queue entries.
      const failureLockScope = piIdFromErr || effectiveIdempotencyKey;
      // The classified throws below must survive even when THIS write
      // fails (DB blip): losing the AMBIGUOUS/SCA classification would
      // make callers treat the error as a safe decline and arm a
      // fresh-key retry — the exact double-charge vector being closed.
      let failedRecord = null;
      try {
        failedRecord = await db.transaction(async (trx) => {
        await trx.raw(
          'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
          ['stripe.pi.payment', String(failureLockScope)],
        );

        if (piIdFromErr) {
          // Check for a COLLECTED row first: a replayed error (e.g.
          // authentication_required) can arrive after the webhook
          // already flipped this PI to paid. Inserting a failed
          // duplicate would show collected money as outstanding.
          const collected = await trx('payments')
            .where({ stripe_payment_intent_id: piIdFromErr })
            .whereIn('status', ['paid', 'processing'])
            .first();
          if (collected) {
            logger.warn(`[stripe] Replayed failure for PI ${piIdFromErr} but payment ${collected.id} is ${collected.status} — surfacing collected row, no failed duplicate`);
            return collected;
          }
          const existing = await trx('payments')
            .where({ stripe_payment_intent_id: piIdFromErr, status: 'failed' })
            .first();
          if (existing) {
            logger.warn(`[stripe] Failed PI ${piIdFromErr} already recorded (payment ${existing.id}) — idempotency replay, reusing row`);
            return existing;
          }
        } else {
          // Stripe failed before minting a PI — dedupe on the durable
          // idempotency key persisted in metadata, otherwise two
          // overlapping workers each insert a null-PI failed row and
          // billing-cron later retries BOTH with distinct rung keys
          // (double charge for one obligation).
          const existing = await trx('payments')
            .where({ customer_id: customerId, status: 'failed' })
            .whereRaw("metadata->>'idempotency_key' = ?", [effectiveIdempotencyKey])
            .first();
          if (existing) {
            logger.warn(`[stripe] No-PI failure for key ${effectiveIdempotencyKey} already recorded (payment ${existing.id}) — reusing row`);
            return existing;
          }
        }

        const [row] = await trx('payments').insert({
          customer_id: customerId,
          payment_method_id: card.id,
          processor: 'stripe',
          stripe_payment_intent_id: piIdFromErr,
          payment_date: etDateString(),
          amount: totalAmount,
          base_amount_cents: baseCents,
          surcharge_amount_cents: surchargeCents,
          // payments.status is a Postgres enum (upcoming/processing/paid/
          // failed/refunded) — DON'T introduce a new value here, the
          // insert would raise enum_invalid and tank the whole catch path.
          // billing-cron skip-retry keys off the thrown STRIPE_REQUIRES_
          // ACTION code below; admin dashboards surface SCA via the
          // description suffix + metadata.requires_action flag.
          status: 'failed',
          description: requiresAction ? `${description} — REQUIRES AUTH` : `${description} — FAILED`,
          failure_reason: err.message,
          metadata: JSON.stringify({
            error: err.message,
            code: authCode || null,
            error_type: errType,
            ambiguous_outcome: ambiguousOutcome,
            requires_action: requiresAction,
            base_amount: baseAmount,
            card_surcharge: surchargeAmount,
            idempotency_key: effectiveIdempotencyKey,
            // Carried on FAILED rows so retry rungs keep attributing the
            // charge to the original obligation month (a rung's own row
            // gets payment_date of the rung day, not the month owed).
            ...(metadata.billed_month ? { billed_month: metadata.billed_month } : {}),
          }),
        }).returning('*');
        return row;
        });
      } catch (recordErr) {
        logger.error(`[stripe] Could not record failed-charge row for ${customerId} (key ${effectiveIdempotencyKey}): ${recordErr.message}`);
      }

      // If the PI was already collected (webhook beat the replayed
      // error), the truth is SUCCESS — return the collected row instead
      // of throwing, so callers run their success path (supersede
      // original, receipt) rather than arming retries against money
      // already taken.
      if (failedRecord && ['paid', 'processing'].includes(failedRecord.status)) {
        return failedRecord;
      }

      if (requiresAction) {
        const sca = new Error('Customer authentication required');
        sca.code = 'STRIPE_REQUIRES_ACTION';
        sca.stripePaymentIntentId = piIdFromErr;
        sca.paymentRecord = failedRecord;
        throw sca;
      }
      if (ambiguousOutcome) {
        // Distinct code so NO caller treats this as a safe decline:
        // Stripe may have processed the charge, so re-attempting with a
        // fresh idempotency key (cron rung key, admin re-click) is a
        // double-charge vector. Callers must park for manual
        // reconciliation instead.
        const amb = new Error('Charge outcome ambiguous — Stripe may have processed the payment');
        amb.code = 'STRIPE_AMBIGUOUS_OUTCOME';
        amb.paymentRecord = failedRecord;
        amb.idempotencyKey = effectiveIdempotencyKey;
        throw amb;
      }
      throw Object.assign(new Error('Payment processing failed'), { paymentRecord: failedRecord });
    }

    // Step 2: Stripe charge succeeded — record in DB
    const status = paymentIntent.status === 'succeeded' ? 'paid' : 'processing';
    try {
      // latest_charge is the expanded charge object (we passed
      // expand:['latest_charge'] above). Stripe also returns the bare
      // charge id on this field when not expanded — read defensively
      // either way so a future SDK change can't strip the receipt URL.
      const latestCharge = paymentIntent.latest_charge;
      const stripeChargeId = typeof latestCharge === 'string' ? latestCharge : (latestCharge?.id || null);
      const stripeReceiptUrl = typeof latestCharge === 'object' && latestCharge ? (latestCharge.receipt_url || null) : null;

      // Serialize on the PI (same lock namespace as confirmInvoicePayment
      // and the succeeded-webhook handler) and collapse idempotency
      // replays: when Stripe returns an already-created PaymentIntent —
      // overlapping cron instances sharing a durable key, or a re-run
      // after an ambiguous failure — exactly one paid/processing ledger
      // row may exist for it.
      const paymentRecord = await db.transaction(async (trx) => {
        await trx.raw(
          'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
          ['stripe.pi.payment', String(paymentIntent.id)],
        );

        const existing = await trx('payments')
          .where({ stripe_payment_intent_id: paymentIntent.id })
          .whereIn('status', ['paid', 'processing'])
          .first();
        if (existing) {
          logger.warn(`[stripe] PI ${paymentIntent.id} already recorded (payment ${existing.id}) — idempotency replay, returning existing row`);
          return existing;
        }

        const [row] = await trx('payments').insert({
          customer_id: customerId,
          payment_method_id: card.id,
          processor: 'stripe',
          stripe_payment_intent_id: paymentIntent.id,
          stripe_charge_id: stripeChargeId,
          payment_date: etDateString(),
          amount: totalAmount,
          base_amount_cents: baseCents,
          surcharge_amount_cents: surchargeCents,
          surcharge_rate_bps: rateBps,
          surcharge_policy_version: policyVersion,
          card_funding: card.card_funding || null,
          card_brand: card.card_brand || null,
          status,
          description: surchargeAmount > 0
            ? `${description} (includes $${surchargeAmount.toFixed(2)} credit card surcharge)`
            : description,
          metadata: JSON.stringify({
            stripe_receipt_url: stripeReceiptUrl,
            base_amount: baseAmount,
            card_surcharge: surchargeAmount,
            surcharge_rate_bps: rateBps,
            surcharge_policy_version: policyVersion,
            // Month-of-obligation stamp: billing-cron's month dedupe and
            // the retry sweep's already-collected guard match on this
            // (metadata-first, payment_date window only as legacy fallback).
            ...(metadata.billed_month ? { billed_month: metadata.billed_month } : {}),
          }),
        }).returning('*');
        return row;
      });

      logger.info(`[stripe] Charge processed: base=$${baseAmount} surcharge=$${surchargeAmount} total=$${totalAmount} for ${customerId}, PI: ${paymentIntent.id}`);
      return paymentRecord;
    } catch (dbErr) {
      // CRITICAL: Stripe charged the customer but our payments-table
      // write failed. Returning a synthetic success record (the prior
      // behavior) was unsafe — the autopay cron treated it as success
      // and on a real DB outage the next retry-sweep run would charge
      // the customer AGAIN since no payments row exists to dedupe
      // against.
      //
      // Recovery plan:
      //   1. Insert into stripe_orphan_charges so an admin queue can
      //      drive manual reconciliation. Uses minimal columns so it's
      //      far less likely to hit the same constraint that broke the
      //      `payments` insert.
      //   2. Throw with code='STRIPE_CHARGED_DB_FAILED' so the autopay
      //      cron's catch block can detect this case and skip retry
      //      scheduling (retry would double-charge).
      //   3. The PI id rides on the error so the cron can include it
      //      in the admin alert.
      logger.error(`[stripe] CRITICAL: Charge succeeded (PI: ${paymentIntent.id}) but DB insert failed: ${dbErr.message}`);
      // latest_charge is now expanded to a Charge object (we passed
      // expand:['latest_charge'] on create), but stripe_orphan_charges
      // .stripe_charge_id is a string column. Read defensively so the
      // reconciliation row carries the real charge id either way.
      const orphanLatestCharge = paymentIntent.latest_charge;
      const orphanChargeId = typeof orphanLatestCharge === 'string'
        ? orphanLatestCharge
        : (orphanLatestCharge?.id || null);
      try {
        await db('stripe_orphan_charges').insert({
          stripe_payment_intent_id: paymentIntent.id,
          stripe_charge_id: orphanChargeId,
          customer_id: customerId,
          amount: totalAmount,
          source: metadata?.type === 'monthly_autopay' ? 'autopay_charge' : 'manual_charge',
          original_db_error: String(dbErr.message).slice(0, 1000),
        });
      } catch (orphanErr) {
        // Belt-and-suspenders failure — even the orphan record write
        // failed. Log loud; the only durable trail at this point is
        // Stripe's side + this log line.
        logger.error(`[stripe] DOUBLE FAILURE: orphan-charges insert also failed for PI ${paymentIntent.id}: ${orphanErr.message}`);
      }
      const err = new Error(`Stripe charge ${paymentIntent.id} succeeded but DB insert failed`);
      err.code = 'STRIPE_CHARGED_DB_FAILED';
      err.stripePaymentIntentId = paymentIntent.id;
      err.amount = totalAmount;
      throw err;
    }
  },

  // =========================================================================
  // CHARGE MONTHLY
  // =========================================================================

  /**
   * Charge monthly_rate from the customers table (autopay)
   */
  /**
   * @param {string} [idempotencyKey] — override the default day-scoped
   *   key. The retry sweep MUST pass its rung-scoped key here: two
   *   distinct failed monthly rows retried on the same ET day would
   *   otherwise share the date key and replay one PaymentIntent while
   *   both originals get marked superseded.
   */
  async chargeMonthly(customerId, idempotencyKey = null) {
    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) throw new Error('Customer not found');
    // NULL/0 monthly_rate = unpriced (manual quote pending), not "charge
    // nothing": the cron already filters monthly_rate > 0, so this guards
    // direct callers from minting a $0/NaN PaymentIntent off an unpriced
    // customer (NULL-not-$0 rule).
    if (!(Number(customer.monthly_rate) > 0)) {
      throw new Error(`Customer ${customerId} has no positive monthly_rate — refusing autopay charge`);
    }

    // The "WaveGuard Monthly" marker is load-bearing: billing-cron identifies
    // monthly autopay rows by a `%WaveGuard Monthly%` LIKE match for its
    // month-window duplicate guard + failed-payment retry scheduling. Keep it
    // even for the flat 'Commercial' tier so those guards still see the charge.
    const description = `${customer.waveguard_tier || 'WaveGuard'} WaveGuard Monthly — ${customer.first_name} ${customer.last_name}`;
    // Default durable scope: one autopay charge per customer per ET day
    // is the business rule for the daily cron (its month-window guard
    // enforces the broader cadence). Overlapping cron instances replay
    // the same PI.
    const effectiveKey = idempotencyKey || `autopay_monthly_${customerId}_${etDateString()}`;
    return this.charge(customerId, customer.monthly_rate, description, {
      type: 'monthly_autopay',
      tier: customer.waveguard_tier || '',
      // Month-of-obligation stamp — billing-cron's duplicate guard and the
      // retry sweep match on this, not on the date the money landed, so a
      // late-recovered charge can't satisfy the wrong month.
      billed_month: etDateString().slice(0, 7),
    }, effectiveKey);
  },

  // =========================================================================
  // CHARGE ONE-TIME
  // =========================================================================

  /**
   * Process a one-time charge (add-on service, event, etc.)
   * @param {string} [idempotencyKey] — durable-operation key (see charge());
   *   omitted for ad-hoc admin charges, where the random fallback applies.
   */
  async chargeOneTime(customerId, amount, description, idempotencyKey = null) {
    return this.charge(customerId, amount, description, { type: 'one_time' }, idempotencyKey);
  },

  // =========================================================================
  // CHARGE AN INVOICE WITH A SPECIFIC SAVED CARD (admin-side)
  // =========================================================================

  /**
   * Charge a specific payment_methods row against an open invoice.
   * Used by the admin MobilePaymentSheet "Card on File" flow when the
   * tech wants to collect from a card the customer already consented
   * to save — distinct from the generic default-autopay-card path in
   * charge() above.
   *
   * @param {string} invoiceId — invoices.id
   * @param {string} paymentMethodId — payment_methods.id (our internal UUID)
   * @returns {object} payments row
   */
  // opts.deferReceiptDelivery — the dispatch completion flow sets this when
  // its combined report+receipt SMS is armed: the receipt job is enqueued a
  // few minutes out instead of immediately, giving the completion text the
  // window to deliver the receipt facts and claim receipt_sent_at AFTER
  // confirmed delivery. Crash-safe by construction: nothing is stamped up
  // front, so if the combined text never delivers (crash, block, template
  // deactivated), the deferred job sends the classic receipt when it comes
  // due. The email leg rides the same job — a few minutes late, unchanged
  // otherwise.
  async chargeInvoiceWithSavedCard(invoiceId, paymentMethodId, { deferReceiptDelivery = false } = {}) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    const invoice = await db('invoices').where({ id: invoiceId }).first();
    if (!invoice) throw new Error('Invoice not found');
    // Check the durable reconciliation fence before the invoice status. A
    // prior ambiguous/orphaned attempt deliberately parks the invoice as
    // `processing`; checking collectibility first would reduce the later
    // request to a generic status error and let callers miss the terminal
    // reconciliation semantics (and potentially expose a fallback pay rail).
    try {
      await assertNoInvoiceChargeReconciliationPending(invoiceId);
    } catch (err) {
      if (savedCardChargeNeedsReconciliation(err)) {
        const parked = await parkInvoiceForSavedCardReconciliation({ invoiceId, error: err });
        err.reconciliationRequired = parked.reconciliationRequired;
      }
      throw err;
    }
    assertInvoiceCollectible(invoice.status);
    // Third-party Bill-To: never charge a card on file for a payer-billed
    // invoice — the saved card belongs to invoice.customer_id (the homeowner),
    // but this bill is the payer's. AR routes to the payer AP inbox.
    if (invoice.payer_id) {
      throw new Error('Invoice is billed to a third-party payer — collect from the payer, not a saved card on the service account');
    }

    const card = await db('payment_methods').where({ id: paymentMethodId }).first();
    if (!card) throw new Error('Payment method not found');
    if (card.customer_id !== invoice.customer_id) {
      throw new Error('Payment method does not belong to invoice customer');
    }
    if (!card.stripe_payment_method_id) {
      throw new Error('Payment method has no Stripe id');
    }

    const stripeCustomerId = await this.ensureStripeCustomer(invoice.customer_id);
    // Commit a durable, unique claim BEFORE Stripe sees a charge request. The
    // partial unique index is what closes the cross-request/process race; an
    // invoice-row lock inside the later transaction is not enough because a
    // timeout rolls that transaction back before its catch can persist a fence.
    let chargeAttempt;
    try {
      chargeAttempt = await claimInvoiceSavedCardCharge({
        invoiceId,
        paymentMethodId,
        stripePaymentMethodId: card.stripe_payment_method_id,
      });
    } catch (err) {
      if (savedCardChargeNeedsReconciliation(err)) {
        const parked = await parkInvoiceForSavedCardReconciliation({ invoiceId, error: err });
        err.reconciliationRequired = parked.reconciliationRequired;
      }
      throw err;
    }

    // Link the PI to the invoice + write the payments-table ledger row.
    // BOTH writes happen after Stripe has already accepted the charge,
    // so a DB failure here leaves a Stripe-collected payment with no
    // local record (orphan PI). Keep the invoice row locked through the
    // Stripe call so ACH processing cannot race in and make this a second
    // collection path for the same invoice.
    let paymentIntent;
    let status;
    let paymentRecord;
    let base;
    let surcharge;
    let total;
    let coveredByCredit = false;
    let stripeChargeSubmitted = false;
    const idempotencyKey = chargeAttempt.idempotency_key;
    // Account credit this charge drew down (post-apply credit_applied − pre-apply).
    // Captured outside the transaction so the orphan path (Stripe charged, DB write
    // failed → rollback) can re-persist it: the rollback reverts the draw-down while
    // the card was charged the REDUCED amount, so without this the customer keeps
    // both the discount and the restored credit and the orphan no longer matches.
    let chargeAppliedCreditDelta = 0;
    let chargeOriginalCreditApplied = Number(invoice.credit_applied) || 0;
    let chargeCreditAppliedTotal = chargeOriginalCreditApplied;
    try {
      await db.transaction(async (trx) => {
        const lockedInvoice = await trx('invoices')
          .where({ id: invoiceId })
          .forUpdate()
          .first();
        if (!lockedInvoice) throw new Error('Invoice not found');
        assertInvoiceCollectible(lockedInvoice.status);
        // The pre-lock invoice read is only an early eligibility snapshot. Use
        // this locked baseline for reservation ownership so credit applied by a
        // concurrent request before our lock is never attributed to this attempt.
        chargeOriginalCreditApplied = Number(lockedInvoice.credit_applied) || 0;
        chargeCreditAppliedTotal = chargeOriginalCreditApplied;
        if (lockedInvoice.stripe_payment_intent_id) {
          const activePayment = await trx('payments')
            .where({ stripe_payment_intent_id: lockedInvoice.stripe_payment_intent_id })
            .first();
          const terminalStatuses = ['failed', 'canceled', 'cancelled', 'refunded'];
          if (activePayment && !terminalStatuses.includes(activePayment.status)) {
            throw new Error('Invoice has a different active payment');
          }
          if (!activePayment) {
            const activeIntent = await stripe.paymentIntents.retrieve(lockedInvoice.stripe_payment_intent_id);
            const cancellableStatuses = ['requires_payment_method', 'requires_confirmation', 'canceled'];
            if (!cancellableStatuses.includes(activeIntent.status)) {
              throw new Error('Invoice has a different active payment');
            }
            if (activeIntent.status !== 'canceled') {
              await stripe.paymentIntents.cancel(activeIntent.id);
            }
          }
        }

        // The stale collection session (if any) was just cancelled, but its id
        // is still on the row and applyAccountCreditToInvoice fail-closes on any
        // attached PI. Clear it, then apply available account credit so the card
        // is charged amount DUE, not the gross total — auto-apply otherwise only
        // runs at dispatch completion, so this charge-now path (especially an
        // invoice with an abandoned /pay PI, which would block the route-level
        // apply) could collect gross while the customer's credit sits unused.
        // Gated + idempotent; on full coverage there is nothing to charge.
        if (require('../config/feature-gates').gates.autoApplyAccountCredit) {
          if (lockedInvoice.stripe_payment_intent_id) {
            await trx('invoices').where({ id: invoiceId }).update({ stripe_payment_intent_id: null });
            lockedInvoice.stripe_payment_intent_id = null;
          }
          const { applyAccountCreditToInvoice } = require('./customer-credit');
          await applyAccountCreditToInvoice({ invoiceId }, trx).catch((e) =>
            logger.warn(`[stripe] charge-time account-credit apply skipped for invoice ${invoiceId}: ${e.message}`));
          const recredited = await trx('invoices').where({ id: invoiceId }).forUpdate().first();
          if (recredited) Object.assign(lockedInvoice, recredited);
          chargeCreditAppliedTotal = Number(lockedInvoice.credit_applied) || 0;
          chargeAppliedCreditDelta = Math.round(
            ((chargeCreditAppliedTotal - chargeOriginalCreditApplied) * 100),
          ) / 100;
          if (!(invoiceAmountDue(lockedInvoice) > 0)) {
            // Fully covered by account credit. COMMIT the credit draw-down +
            // prepaid transition (return, don't throw — a throw would roll back
            // the apply AND the PI clearing, stranding the invoice) and skip the
            // card charge. Settled below, after the transaction commits.
            coveredByCredit = true;
            return;
          }
        }

        // On-demand funding fetch for legacy cards missing card_funding
        if (card.method_type === 'card' && !card.card_funding && card.stripe_payment_method_id) {
          try {
            const pmObj = await stripe.paymentMethods.retrieve(card.stripe_payment_method_id);
            const fetchedFunding = pmObj.card?.funding || null;
            if (fetchedFunding) {
              card.card_funding = fetchedFunding;
              await trx('payment_methods').where({ id: card.id }).update({
                card_funding: fetchedFunding,
                card_funding_checked_at: new Date(),
              });
              logger.info(`[stripe] Backfilled card_funding=${fetchedFunding} for card ${card.id}`);
            }
          } catch (fetchErr) {
            logger.warn(`[stripe] Could not fetch funding for card ${card.id}: ${fetchErr.message}`);
          }
        }

        // Charge base = amount due (total − applied account credit), not raw total.
        const chargeInfo = computeChargeAmount(invoiceAmountDue(lockedInvoice), card.method_type, { funding: card.card_funding });
        const { baseCents: invBaseCents, surchargeCents: invSurchargeCents, totalCents: invTotalCents, rateBps: invRateBps, policyVersion: invPolicyVersion } = chargeInfo;
        base = invBaseCents / 100;
        surcharge = invSurchargeCents / 100;
        total = invTotalCents / 100;

        const invSurchargeDetails = buildSurchargeAmountDetails(invSurchargeCents);

        // This key belongs to the durable attempt claim, not a clock bucket.
        // Deterministic declines mark the claim failed so a deliberate retry
        // receives a new claim/key. Ambiguous outcomes retain the exact key for
        // Stripe reconciliation and keep the invoice fenced indefinitely.
        // Saved-method charges support BOTH tender families (owner ruling
        // 2026-07-09: per-application collects whatever method the customer
        // saved, card or bank). A PI without payment_method_types defaults to
        // ['card'] and Stripe refuses to confirm it with a us_bank_account pm
        // — lock the PI to the saved method's family. An ACH confirm lands
        // 'processing' (not 'succeeded'); the status mapping below + the
        // webhook's processing→paid settlement already handle that lifecycle,
        // and computeChargeAmount already priced ACH surcharge-free.
        // Both bank aliases: payment_methods rows store 'ach'
        // (savePaymentMethod) but other surfaces persist Stripe's
        // 'us_bank_account' — classifying either as card would mint a
        // card-only PI that Stripe refuses to confirm against a bank
        // method (Codex round-10).
        const savedMethodIsBank = card.method_type === 'ach' || card.method_type === 'us_bank_account';
        const invPiParams = {
          amount: invTotalCents,
          currency: 'usd',
          customer: stripeCustomerId,
          payment_method: card.stripe_payment_method_id,
          payment_method_types: [savedMethodIsBank ? 'us_bank_account' : 'card'],
          off_session: true,
          confirm: true,
          description: `Invoice ${invoice.invoice_number} — ${savedMethodIsBank ? 'bank account' : 'card'} on file`,
          metadata: {
            saved_card_attempt_id: chargeAttempt.id,
            waves_invoice_id: invoiceId,
            invoice_number: invoice.invoice_number,
            waves_customer_id: invoice.customer_id,
            base_amount: String(base),
            card_surcharge: String(surcharge),
            surcharge_rate_bps: String(invRateBps),
            surcharge_policy_version: invPolicyVersion,
            source: 'admin_card_on_file',
          },
        };
        if (invSurchargeDetails) invPiParams.amount_details = invSurchargeDetails;
        // This durable marker is the fail-closed submission boundary. It is
        // written immediately before the synchronous SDK invocation: claims
        // abandoned earlier remain releasable, while any process death from
        // this point forward is treated as possibly submitted. That conservative
        // ambiguity is required because a worker can die after the network write
        // but before any post-call marker could be committed.
        await commitInvoiceSavedCardChargeSubmission({
          attemptId: chargeAttempt.id,
          amount: total,
          creditAppliedDelta: chargeAppliedCreditDelta,
          creditAppliedTotal: chargeCreditAppliedTotal,
          // Explicitly use the root handle: this small independent transaction
          // must commit before Stripe is called, even though the invoice work
          // around it is still inside `trx`.
          database: db,
        });
        stripeChargeSubmitted = true;
        paymentIntent = await stripe.paymentIntents.create(
          invPiParams,
          invSurchargeDetails
            ? { idempotencyKey, apiVersion: SURCHARGE_API_VERSION }
            : { idempotencyKey },
        );

        status = paymentIntent.status === 'succeeded' ? 'paid' : 'processing';

        const invoiceRowsUpdated = await trx('invoices')
          .where({ id: invoiceId })
          .whereNotIn('status', ['paid', 'processing'])
          .update({
            status,
            paid_at: status === 'paid' ? new Date().toISOString() : null,
            processor: 'stripe',
            stripe_payment_intent_id: paymentIntent.id,
            stripe_charge_id: paymentIntent.latest_charge || null,
            // Same tender convention as confirmInvoicePayment: ACH lands as
            // 'us_bank_account' (never 'card' — that leaked the wrong tender
            // into receipts/reporting) and the bank last4 reuses the
            // card_last_four column, mirroring `cardLastFour || bankLastFour`.
            payment_method: savedMethodIsBank ? 'us_bank_account' : 'card',
            card_brand: card.card_brand || null,
            card_last_four: card.last_four || null,
            // `total` here is the CASH charged (amount due + surcharge); add back
            // applied account credit so the invoice keeps its real total rather
            // than collapsing to the reduced cash amount with credit_applied set.
            total: Math.round((total + (Number(lockedInvoice.credit_applied) || 0)) * 100) / 100,
          });
        if (!invoiceRowsUpdated) throw new Error('Invoice is no longer collectible');

        [paymentRecord] = await trx('payments').insert({
          customer_id: invoice.customer_id,
          payment_method_id: card.id,
          processor: 'stripe',
          stripe_payment_intent_id: paymentIntent.id,
          stripe_charge_id: paymentIntent.latest_charge || null,
          payment_date: etDateString(),
          amount: total,
          base_amount_cents: invBaseCents,
          surcharge_amount_cents: invSurchargeCents,
          surcharge_rate_bps: invRateBps,
          surcharge_policy_version: invPolicyVersion,
          card_funding: card.card_funding || null,
          card_brand: card.card_brand || null,
          status,
          description: surcharge > 0
            ? `Invoice ${invoice.invoice_number} — card on file (includes $${surcharge.toFixed(2)} credit card surcharge)`
            : `Invoice ${invoice.invoice_number} — ${savedMethodIsBank ? 'bank account' : 'card'} on file`,
          metadata: JSON.stringify({
            // Link to the invoice so /api/receipt/:token + the receipt email find
            // this row (and its actual cash amount) instead of falling back to the
            // pre-credit invoice.total when account credit was applied.
            invoice_id: invoice.id,
            base_amount: base,
            card_surcharge: surcharge,
            surcharge_rate_bps: invRateBps,
            surcharge_policy_version: invPolicyVersion,
            source: 'admin_card_on_file',
          }),
        }).returning('*');
      });
    } catch (err) {
      if (!paymentIntent) {
        if ([
          'Invoice not found',
          'Invoice already paid',
          'Bank payment is already processing',
          'Invoice is void and cannot be paid',
          'Invoice has been refunded and cannot be paid',
          'Invoice is canceled and cannot be paid',
          'Invoice has a different active payment',
        ].includes(err.message)) {
          await resolveNoFundsSavedCardChargeAttempt({
            attemptId: chargeAttempt.id,
            invoiceId,
            failureMessage: err.message,
          }).catch((attemptErr) => {
            // The original committed claim remains active when this update
            // fails, so collection stays fail-closed.
            logger.error(`[stripe] charge-attempt release failed for deterministic error ${chargeAttempt.id}; claim remains blocking: ${attemptErr.message}`);
          });
          throw err;
        }
        if (!stripeChargeSubmitted) {
          // A stale-PI retrieve/cancel or other setup lookup failed before the
          // new PaymentIntent create request was sent. No new saved-card charge
          // can exist, so release the claim and preserve normal collection.
          await resolveNoFundsSavedCardChargeAttempt({
            attemptId: chargeAttempt.id,
            invoiceId,
            failureMessage: err.message || 'Pre-charge setup failed',
          }).catch((attemptErr) => {
            logger.error(`[stripe] pre-charge attempt release failed for ${chargeAttempt.id}; claim remains blocking: ${attemptErr.message}`);
          });
          throw err;
        }
        logger.error(`[stripe] chargeInvoiceWithSavedCard failed for invoice ${invoice.invoice_number}: ${err.message}`);
        const ambiguousOutcome = shouldTreatSavedCardFailureAsAmbiguous({
          chargeSubmitted: stripeChargeSubmitted,
          error: err,
        });
        if (ambiguousOutcome) {
          let creditReservationReady = true;
          await persistSavedCardChargeCreditDelta({
            invoiceId,
            customerId: invoice.customer_id,
            attemptId: chargeAttempt.id,
            originalCreditApplied: chargeOriginalCreditApplied,
            creditDelta: chargeAppliedCreditDelta,
            targetCreditApplied: chargeCreditAppliedTotal,
            reference: `attempt ${chargeAttempt.id}`,
          }).then((persisted) => {
            creditReservationReady = persisted !== false;
          }).catch((creditErr) => {
            creditReservationReady = false;
            logger.error(`[stripe] CRITICAL: ambiguous credit reservation failed for invoice ${invoiceId} (attempt ${chargeAttempt.id}); claim remains active so webhooks retry: ${creditErr.message}`);
          });
          // This is the primary durable ambiguity record. It was inserted as a
          // committed `claimed` row before Stripe; if this update itself fails,
          // that original status still blocks every later charge.
          if (creditReservationReady) {
            await markInvoiceSavedCardChargeAttempt(chargeAttempt.id, {
              status: 'ambiguous',
              error_message: String(err.message).slice(0, 1000),
              resolved_at: null,
            }).catch((attemptErr) => {
              logger.error(`[stripe] CRITICAL: could not label charge attempt ${chargeAttempt.id} ambiguous; durable claimed fence remains active: ${attemptErr.message}`);
            });
          }
          // Do not also create a payments.failed row: this attempt table is the
          // single reconciliation source for new saved-card ambiguity. A second
          // independently-resolved fence would keep the invoice blocked after
          // an operator clears the durable attempt.
          const ambiguousErr = new Error('Charge outcome ambiguous — Stripe may have processed the payment');
          ambiguousErr.code = 'STRIPE_AMBIGUOUS_OUTCOME';
          ambiguousErr.idempotencyKey = idempotencyKey;
          ambiguousErr.chargeAttemptId = chargeAttempt.id;
          ambiguousErr.reconciliationRequired = true;
          let parked = null;
          try {
            parked = await parkInvoiceForSavedCardReconciliation({
              invoiceId,
              error: ambiguousErr,
              chargeAttemptId: chargeAttempt.id,
            });
          } catch (parkErr) {
            logger.error(`[stripe] CRITICAL: could not park ambiguous invoice ${invoiceId}; durable attempt ${chargeAttempt.id} still blocks saved-card collection: ${parkErr.message}`);
          }
          if (parked?.attemptResolved) {
            // A definitive webhook won the race and reopened the invoice. Do
            // not leak the now-stale ambiguity code to callers: they suppress
            // pay links/retries whenever that code is present.
            const resolvedFailure = new Error('Saved-card payment did not complete. Please try again.');
            resolvedFailure.code = 'STRIPE_CHARGE_FAILED';
            throw resolvedFailure;
          }
          throw ambiguousErr;
        }
        try {
          // Stamp the invoice link: the obligation this attempt was collecting
          // lives on the invoice row, which stays 'sent' — an unlinked failed
          // row would be double-counted by billing-v2 /balance (invoice +
          // failed attempt for the same debt) with nothing ever superseding
          // it, since this path sets no next_retry_at for the retry sweep.
          // Deliberately NO stripe_payment_intent_id on this row: a declined
          // off-session PI (e.g. authentication_required) can still succeed
          // later, and the webhook's succeeded-handler would then flip THIS
          // row to paid by PI match and return before linking the invoice
          // (which this failure path never stamped a PI onto) — a paid row
          // beside a still-collectible invoice, with dunning continuing after
          // the money arrived (Codex P1 on this PR).
          await db('payments').insert({
            customer_id: invoice.customer_id,
            payment_method_id: card.id,
            processor: 'stripe',
            payment_date: etDateString(),
            amount: total,
            status: 'failed',
            description: `Invoice ${invoice.invoice_number} — card on file (FAILED)`,
            failure_reason: err.message,
            metadata: JSON.stringify({
              invoice_id: invoice.id,
              source: 'card_on_file_failed_attempt',
              ambiguous_outcome: false,
              idempotency_key: idempotencyKey || null,
            }),
          });
        } catch (recordErr) {
          // No money moved for a deterministic decline. Preserve the log for
          // diagnostics, then release the durable claim below so a deliberate
          // retry remains possible.
          logger.error(`[stripe] could not record saved-card failure for invoice ${invoiceId}: ${recordErr.message}`);
        }
        await resolveNoFundsSavedCardChargeAttempt({
          attemptId: chargeAttempt.id,
          invoiceId,
          failureMessage: err.message || 'Card charge failed',
        }).catch((attemptErr) => {
          logger.error(`[stripe] charge-attempt release failed after deterministic decline ${chargeAttempt.id}; claim remains blocking: ${attemptErr.message}`);
        });
        const chargeFailed = new Error(err.message || 'Card charge failed');
        // Structured decline facts for customer-facing notices. ONLY a real
        // processor decline on the confirm carries them (StripeCardError /
        // decline_code) — the guard errors above re-throw plain and config/DB
        // failures land here without the marker, so callers can key "tell
        // the customer their payment failed" strictly off this and never text
        // a false decline for an internal error. attemptedAmount is the
        // surcharge-inclusive total computeChargeAmount priced (what the
        // customer actually saw attempted), never the pre-surcharge base.
        if (err.type === 'StripeCardError' || err.code === 'card_declined' || err.decline_code) {
          chargeFailed.wavesCardDecline = {
            attemptedAmount: Number.isFinite(total) ? total : null,
            cardBrand: card.card_brand || null,
            cardLast4: card.last_four || null,
            declineCode: err.decline_code || err.code || null,
          };
        }
        throw chargeFailed;
      }

      logger.error(`[stripe] CRITICAL: Stripe accepted PI ${paymentIntent.id} but the saved-card DB write failed: ${err.message}`);
      let orphanPersisted = false;
      try {
        await db('stripe_orphan_charges').insert({
          stripe_payment_intent_id: paymentIntent.id,
          stripe_charge_id: paymentIntent.latest_charge || null,
          customer_id: invoice.customer_id,
          invoice_id: invoiceId,
          amount: total,
          source: 'invoice_card_on_file',
          original_db_error: String(err.message).slice(0, 1000),
        });
        orphanPersisted = true;
      } catch (orphanErr) {
        logger.error(`[stripe] DOUBLE FAILURE: orphan-charges insert also failed for PI ${paymentIntent.id}: ${orphanErr.message}`);
      }
      // The rollback reverted the account-credit draw-down, but the card was charged
      // the REDUCED (credit-applied) amount. Re-persist that exact draw-down in a
      // fresh committed transaction so the balance + invoice reflect the consumed
      // credit and the orphan charge reconciles against the reduced amount due — else
      // the customer keeps both the discount and the restored credit. Done directly
      // (not via applyAccountCreditToInvoice, which fail-closes on the still-attached
      // stale PI the rollback restored). Idempotent: only tops up to the charged level.
      let orphanCreditReady = true;
      try {
        await persistSavedCardChargeCreditDelta({
          invoiceId,
          customerId: invoice.customer_id,
          attemptId: chargeAttempt.id,
          originalCreditApplied: chargeOriginalCreditApplied,
          creditDelta: chargeAppliedCreditDelta,
          targetCreditApplied: chargeCreditAppliedTotal,
          reference: `orphan PI ${paymentIntent.id}`,
        });
      } catch (reErr) {
        orphanCreditReady = false;
        logger.error(`[stripe] CRITICAL: orphan credit re-persist failed for invoice ${invoiceId} (PI ${paymentIntent.id}): ${reErr.message}`);
      }
      const chargedErr = new Error(`Stripe payment ${paymentIntent.id} was accepted but DB write failed for invoice ${invoice.invoice_number}`);
      chargedErr.code = 'STRIPE_CHARGED_DB_FAILED';
      chargedErr.stripePaymentIntentId = paymentIntent.id;
      chargedErr.amount = total;
      chargedErr.reconciliationRequired = true;
      let orphanParkReady = false;
      await parkInvoiceForSavedCardReconciliation({ invoiceId, error: chargedErr })
        .then((parked) => {
          orphanParkReady = String(parked?.invoice?.status || '').toLowerCase() === 'processing'
            && String(parked?.invoice?.stripe_payment_intent_id || '') === String(paymentIntent.id);
        })
        .catch((parkErr) => {
          logger.error(`[stripe] CRITICAL: could not park orphaned invoice ${invoiceId}; durable attempt/orphan fences remain: ${parkErr.message}`);
        });
      const orphanFenceReady = orphanPersisted && orphanCreditReady && orphanParkReady;
      const orphanAttemptOutcome = savedCardAttemptOutcome({
        durableSettlementReady: orphanFenceReady,
        paymentIntentStatus: paymentIntent.status,
      });
      await markInvoiceSavedCardChargeAttempt(chargeAttempt.id, {
        // Close only after both the orphan ledger and any rolled-back credit
        // reservation are durable. Otherwise keep `claimed` unresolved while
        // attaching the exact PI so webhook reconciliation can finish safely.
        // ACH `processing` is not a final success. Keep its exact attempt open
        // so a later payment_failed webhook can reopen the invoice and clear
        // the orphan fence. Only a final succeeded PI may close as succeeded.
        status: orphanAttemptOutcome.status,
        stripe_payment_intent_id: paymentIntent.id,
        amount: total,
        credit_applied_delta: chargeAppliedCreditDelta,
        credit_applied_total: chargeCreditAppliedTotal,
        error_message: String(err.message).slice(0, 1000),
        resolved_at: orphanAttemptOutcome.resolved ? new Date() : null,
      }).catch((attemptErr) => {
        logger.error(`[stripe] CRITICAL: charge-attempt orphan update failed for ${chargeAttempt.id}; original durable claimed fence remains active: ${attemptErr.message}`);
      });
      throw chargedErr;
    }

    // The invoice/payment transaction committed (or account credit fully
    // covered the balance). Release the blocking claim. If this bookkeeping
    // update fails, the original committed `claimed` row remains fail-closed;
    // the invoice status also prevents another collection after a cash charge.
    const committedAttemptOutcome = savedCardAttemptOutcome({
      durableSettlementReady: true,
      paymentIntentStatus: paymentIntent?.status || 'succeeded',
    });
    await markInvoiceSavedCardChargeAttempt(chargeAttempt.id, {
      // A committed `processing` ACH payment is locally recorded but not final.
      // Keep its attempt unresolved so either final webhook can settle/reopen it.
      status: committedAttemptOutcome.status,
      stripe_payment_intent_id: paymentIntent?.id || null,
      amount: total ?? 0,
      error_message: null,
      resolved_at: committedAttemptOutcome.resolved ? new Date() : null,
    }).catch((attemptErr) => {
      logger.error(`[stripe] charge-attempt success update failed for ${chargeAttempt.id}; durable claim remains blocking: ${attemptErr.message}`);
    });

    if (coveredByCredit) {
      // Account credit fully covered the invoice inside the committed transaction
      // above (now prepaid) — no card was charged. Run the same post-payment side
      // effects a real payment would (stop dunning, sync any annual-prepay term).
      logger.info(`[stripe] Card-on-file: account credit fully covered invoice ${invoice.invoice_number} — no card charge`);
      try {
        await require('./invoice-followups').stopOnPayment(invoiceId);
      } catch (e) {
        logger.warn(`[stripe] stopOnPayment after credit coverage failed for ${invoiceId}: ${e.message}`);
      }
      try {
        const fresh = await db('invoices').where({ id: invoiceId }).first();
        if (fresh) await require('./annual-prepay-renewals').syncTermForInvoicePayment(fresh);
      } catch (e) {
        logger.warn(`[stripe] term sync after credit coverage failed for ${invoiceId}: ${e.message}`);
      }
      // Fire-and-forget: a credit-covered (prepaid) invoice may be gating a
      // payment-held WDO report — nudge the release sweep.
      require('./project-report-hold').scheduleHoldReleaseSweep({ delayMs: 1500 });
      return { covered_by_credit: true, status: 'prepaid', paymentId: null, paymentIntentId: null };
    }

    logger.info(`[stripe] Card-on-file charge succeeded: $${total} for invoice ${invoice.invoice_number}, PI ${paymentIntent.id}`);
    if (status === 'paid') {
      try {
        await require('./invoice-followups').stopOnPayment(invoiceId);
      } catch (err) {
        logger.error(`[invoice-followups] stopOnPayment failed for card-on-file invoice ${invoiceId}: ${err.message}`);
      }
      try {
        await require('./annual-prepay-renewals').syncTermForInvoicePayment({
          id: invoiceId,
          status: 'paid',
          paid_at: new Date().toISOString(),
        });
      } catch (err) {
        logger.error(`[annual-prepay] activation failed for card-on-file invoice ${invoiceId}: ${err.message}`);
      }

      try {
        const ReceiptDeliveryQueue = require('./receipt-delivery-queue');
        // See the deferReceiptDelivery doc on this method. 3 minutes covers
        // the completion request's report/SMS work with slack; the extra
        // delayed drain makes the deferred job self-serve even on a quiet
        // instance (any later payment event also drains due jobs).
        const RECEIPT_DEFER_MS = 3 * 60_000;
        const deferredUntil = new Date(Date.now() + RECEIPT_DEFER_MS);
        const enqueueResult = await ReceiptDeliveryQueue.enqueueReceiptDelivery({
          invoiceId,
          stripePaymentIntentId: paymentIntent.id,
          source: 'card_on_file',
          ...(deferReceiptDelivery ? { nextAttemptAt: deferredUntil } : {}),
        });
        if (deferReceiptDelivery && !enqueueResult.enqueued) {
          // The payment_intent.succeeded webhook enqueues the same invoice
          // immediately and the queue dedupes on invoice_id — if the webhook
          // won the insert, its NOW-due job would text the classic receipt
          // before the combined completion SMS delivers. Push the existing
          // job out to the deferral (only while still queued and earlier; a
          // job already running is past helping — the acknowledged race
          // sliver, worst case a duplicate receipt mention).
          await db('receipt_delivery_jobs')
            .where({ invoice_id: invoiceId, status: 'queued' })
            .where('next_attempt_at', '<', deferredUntil)
            .update({ next_attempt_at: deferredUntil, updated_at: db.fn.now() })
            .catch((deferErr) => logger.warn(`[stripe] receipt-job deferral update failed for invoice ${invoiceId}: ${deferErr.message}`));
        }
        ReceiptDeliveryQueue.scheduleReceiptDeliveryDrain(
          deferReceiptDelivery
            ? { delayMs: RECEIPT_DEFER_MS + 5_000, limit: 5 }
            : { delayMs: 1000, limit: 5 },
        );
      } catch (err) {
        logger.error(`[stripe] Card-on-file receipt queue failed for invoice ${invoice.invoice_number}: ${err.message}`);
      }
      // Fire-and-forget: a card-on-file settle may release a payment-held
      // WDO report (60s sweep interval is the fallback).
      require('./project-report-hold').scheduleHoldReleaseSweep({ delayMs: 1500 });
    }

    return {
      paymentId: paymentRecord.id,
      paymentIntentId: paymentIntent.id,
      status,
      amount: total,
      base,
      surcharge,
      last4: card.last_four,
      brand: card.card_brand,
    };
  },

  // =========================================================================
  // PAYMENT HISTORY
  // =========================================================================

  /**
   * Get payment history with payment method details (both processors)
   */
  async getPaymentHistory(customerId, limit = 20, offset = 0) {
    let q = db('payments')
      .where({ 'payments.customer_id': customerId })
      .leftJoin('payment_methods', 'payments.payment_method_id', 'payment_methods.id')
      .select(
        'payments.*',
        'payment_methods.card_brand',
        'payment_methods.last_four',
        'payment_methods.processor as pm_processor',
        'payment_methods.method_type',
        'payment_methods.bank_name'
      )
      .orderBy('payments.payment_date', 'desc')
      .limit(limit);
    if (offset > 0) q = q.offset(offset);
    return q;
  },

  // =========================================================================
  // REFUND
  // =========================================================================

  /**
   * Full or partial refund via Stripe.
   * @param {string} paymentId — Waves payment UUID
   * @param {{ amount?: number, reason?: string }} options
   * @returns {object} updated payment row
   */
  async refund(paymentId, { amount, reason } = {}) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    const payment = await db('payments').where({ id: paymentId }).first();
    if (!payment) throw new Error('Payment not found');

    if (payment.processor !== 'stripe' || !payment.stripe_payment_intent_id) {
      throw new Error('Payment is not a Stripe payment — cannot refund via Stripe');
    }

    const paidCents = Math.round(parseFloat(payment.amount) * 100);
    const priorCents = Math.round(parseFloat(payment.refund_amount || 0) * 100);
    const remainingCents = paidCents - priorCents;
    const requestCents = amount ? Math.round(amount * 100) : null;
    // Tag of what the OPERATOR entered (base dollars) — replay detection keys
    // on this, so a retry of the same entered amount replays the original
    // attempt even though the amount actually sent to Stripe is grossed up.
    const enteredTag = requestCents === null ? 'rest' : String(requestCents);

    // Persist the attempt key BEFORE calling Stripe. The retry contract
    // ("re-running the same refund is safe") must hold even when the
    // charge.refunded webhook repairs refund_amount before the operator
    // retries — a key derived from live local state would shift in that
    // window and mint a brand-new refund. The pending marker survives any
    // unresolved outcome (network error, DB write failure) and is cleared
    // on completion or on a definitive Stripe rejection, so a retry always
    // replays the ORIGINAL attempt's key.
    let meta = {};
    try {
      meta = payment.metadata ? (typeof payment.metadata === 'string' ? JSON.parse(payment.metadata) : payment.metadata) : {};
    } catch { meta = {}; }

    // Card-brand rule: a partial refund must return the prorated share of the
    // recorded card surcharge, not just the entered base dollars — the
    // surcharge was collected on the refunded portion too. All math comes
    // from the one authority (computeRefundSurcharge in stripe-pricing);
    // payments.surcharge_amount_cents is the recorded surcharge (the
    // compliance-migration column every Stripe insert path populates) and
    // payments.refunded_surcharge_cents tracks the cumulative returned share
    // so successive partials prorate without drift. Full ("rest") refunds
    // already return everything and skip this.
    const surchargeCents = Math.max(0, Number(payment.surcharge_amount_cents) || 0);
    const alreadyRefundedSurchargeCents = Math.min(surchargeCents, Math.max(0, Number(payment.refunded_surcharge_cents) || 0));
    const surchargeShareCents = requestCents !== null && surchargeCents > 0
      ? computeRefundSurcharge({
          refundBaseCents: requestCents,
          originalBaseCents: Math.max(0, paidCents - surchargeCents),
          originalSurchargeCents: surchargeCents,
          totalRefundedBaseCents: Math.max(0, priorCents - alreadyRefundedSurchargeCents),
          alreadyRefundedSurchargeCents,
        })
      : 0;
    // Never push the grossed amount past the remaining balance — near the end
    // of a heavily-refunded payment the cap eats into the share, not the base.
    let grossCents = requestCents === null
      ? null
      : Math.min(requestCents + surchargeShareCents, Math.max(requestCents, remainingCents));

    // Replay detection keys on the ENTERED amount (pending_refund_base);
    // legacy markers predate the gross-up and stored the entered amount in
    // pending_refund_request, so fall back to it.
    const isReplay = !!(meta.pending_refund_key
      && (meta.pending_refund_base ?? meta.pending_refund_request) === enteredTag);
    // The freshly-computed gross for the CURRENT balance — a stale replay
    // whose original attempt provably never landed restarts from this, not
    // from the dead attempt's frozen/legacy amount.
    const freshGrossCents = grossCents;
    if (isReplay && grossCents !== null) {
      // Resend the ORIGINAL amount verbatim — Stripe rejects a reused key
      // whose parameters differ, and a definitive rejection would clear the
      // marker and open the door to a double refund. New-style markers froze
      // the grossed amount; LEGACY (pre-gross-up) markers sent exactly the
      // entered amount, so replay that — never a freshly computed gross.
      grossCents = Number.isFinite(Number(meta.pending_refund_gross))
        ? Number(meta.pending_refund_gross)
        : requestCents;
    }
    let requestTag = isReplay
      ? meta.pending_refund_request
      : (grossCents === null ? 'rest' : String(grossCents));
    if (meta.pending_refund_key && !isReplay) {
      throw new Error(`An unresolved refund attempt (${meta.pending_refund_request === 'rest' ? 'full remaining balance' : `$${(Number(meta.pending_refund_request) / 100).toFixed(2)}`}) exists for this payment — re-run that refund or reconcile in Stripe before starting a different one`);
    }

    // NEW-attempt validation: partials must ACCUMULATE (two 50% refunds =
    // fully refunded), and a request beyond the remaining balance is
    // rejected with a clear message instead of an opaque Stripe error.
    // Replays skip this — the webhook may already have recorded the very
    // refund being replayed (a $60 refund on $100 repaired to remaining
    // $40 would otherwise wedge here).
    const assertNewAttemptRefundable = () => {
      if (remainingCents <= 0) throw new Error('Payment is already fully refunded');
      if (requestCents !== null && (requestCents <= 0 || requestCents > remainingCents)) {
        throw new Error(`Refund amount must be between $0.01 and the remaining $${(remainingCents / 100).toFixed(2)}`);
      }
    };
    let idempotencyKey;
    const attemptReason = reason || 'requested_by_customer';
    // Bounced attempts leave the amounts untouched (nothing was returned),
    // so a retry after a bounce sees the SAME tag and priorCents — without
    // the bounce-count suffix it would reuse the dead attempt's key and
    // Stripe's idempotency layer would hand back the bounced refund object
    // instead of creating a new refund.
    const bouncedIds = Array.isArray(meta.failed_refund_ids) ? meta.failed_refund_ids : [];
    const persistPendingAttempt = async () => {
      idempotencyKey = `refund_pay_${paymentId}_${requestTag}_${priorCents}${bouncedIds.length ? `_b${bouncedIds.length}` : ''}`;
      await db('payments').where({ id: paymentId }).update({
        metadata: JSON.stringify({
          ...meta,
          pending_refund_key: idempotencyKey,
          pending_refund_request: requestTag,
          // Entered base + frozen grossed amount: replays match on the base
          // and resend the gross verbatim (see gross-up block above).
          pending_refund_base: enteredTag,
          ...(grossCents !== null ? { pending_refund_gross: grossCents } : {}),
          pending_refund_reason: attemptReason,
          pending_refund_at: new Date().toISOString(),
        }),
      });
    };

    // Stripe guarantees idempotency keys for at least 24h and may prune
    // them after — a blind replay of an older key would execute as a
    // brand-new request and refund twice. Inside a conservative 20h
    // window the key replays directly; past it (or with no timestamp)
    // the attempt is reconciled against Stripe's actual refund list.
    const REPLAY_SAFE_WINDOW_MS = 20 * 60 * 60 * 1000;
    let adoptedRefund = null;
    // A key replay must resend the ORIGINAL request verbatim — Stripe
    // rejects a reused key whose parameters differ, so a retry that only
    // changes the reason would wedge on an idempotency error. Legacy
    // markers without a persisted reason fall through to the incoming one.
    let replayReason = null;
    if (isReplay) {
      const pendingAtMs = Date.parse(meta.pending_refund_at || '') || 0;
      if (pendingAtMs && (Date.now() - pendingAtMs) <= REPLAY_SAFE_WINDOW_MS) {
        idempotencyKey = meta.pending_refund_key;
        replayReason = meta.pending_refund_reason || null;
      } else {
        let listed;
        try {
          listed = await stripe.refunds.list({ payment_intent: payment.stripe_payment_intent_id, limit: 100 });
        } catch (listErr) {
          // Fail CLOSED: without seeing Stripe's refunds we can't tell
          // whether the day-old attempt landed, and guessing risks a
          // second refund.
          logger.error(`[stripe] stale refund-attempt reconcile failed for payment ${paymentId}: ${listErr.message}`);
          throw new Error('Could not verify the earlier refund attempt against Stripe — check the payment in the Stripe dashboard before retrying');
        }
        // Adopt the original refund if it landed (right amount, created
        // at/after the attempt) — record it below without re-sending. A
        // 'rest' attempt has no explicit requestCents, but its attempt-time
        // amount is recoverable as paid minus the key's prior-cents suffix;
        // the match is REQUIRED, else any later refund (e.g. a dashboard
        // partial) would be adopted as the full refund and the true
        // remainder never sent. An unparseable key can't be reconciled —
        // no adoption; the fresh 'rest' attempt below is still safe because
        // Stripe computes the remainder from its own ledger.
        // Prefer the frozen grossed amount — that is what the original
        // attempt actually sent to Stripe (legacy markers have no gross and
        // fall back to the entered amount, which WAS what they sent).
        let expectedCents = Number.isFinite(Number(meta.pending_refund_gross))
          ? Number(meta.pending_refund_gross)
          : requestCents;
        if (expectedCents === null) {
          const keyPriorCents = Number((meta.pending_refund_key || '').split('_').pop());
          expectedCents = (Number.isInteger(keyPriorCents) && keyPriorCents >= 0 && keyPriorCents < paidCents)
            ? paidCents - keyPriorCents
            : NaN;
        }
        adoptedRefund = (Number.isFinite(expectedCents) && (listed?.data || []).find((r) =>
          ['succeeded', 'pending'].includes(r.status)
          && r.amount === expectedCents
          && (!pendingAtMs || r.created * 1000 >= pendingAtMs - 5 * 60 * 1000))) || null;
        if (!adoptedRefund) {
          // The original attempt never landed at Stripe — start over as a
          // validated fresh attempt against the CURRENT balance. The gross
          // and tag were forced to the dead attempt's values above (a legacy
          // marker would resend the UNGROSSED base, shorting the customer
          // the prorated surcharge); recompute both — a fresh tag also
          // derives a fresh idempotency key, so the new amount can't wedge
          // on the stale key's parameter check.
          grossCents = freshGrossCents;
          requestTag = grossCents === null ? 'rest' : String(grossCents);
          assertNewAttemptRefundable();
          await persistPendingAttempt();
        }
      }
    } else {
      assertNewAttemptRefundable();
      await persistPendingAttempt();
    }
    const clearedMeta = { ...meta };
    delete clearedMeta.pending_refund_key;
    delete clearedMeta.pending_refund_request;
    delete clearedMeta.pending_refund_base;
    delete clearedMeta.pending_refund_gross;
    delete clearedMeta.pending_refund_reason;
    delete clearedMeta.pending_refund_at;

    let refund = adoptedRefund;
    try {
      if (!refund) {
        const refundParams = {
          payment_intent: payment.stripe_payment_intent_id,
          reason: replayReason || attemptReason,
        };
        if (grossCents !== null) {
          // Entered base + prorated surcharge share (capped at the remaining
          // balance) — see the gross-up block above.
          refundParams.amount = grossCents;
        }
        refund = await stripe.refunds.create(refundParams, { idempotencyKey });
      }
    } catch (err) {
      // Definitive rejections clear the pending attempt so a corrected
      // retry isn't wedged replaying Stripe's stored error. Ambiguous
      // outcomes (connection/API errors) KEEP it — replaying the same key
      // is safe whether or not the original request landed.
      const definitiveRejection = ['StripeInvalidRequestError', 'StripeCardError'].includes(err?.type);
      if (definitiveRejection) {
        await db('payments').where({ id: paymentId }).update({ metadata: JSON.stringify(clearedMeta) }).catch(() => {});
      }
      logger.error(`[stripe] Refund failed for payment ${paymentId}: ${err.message}`);
      throw new Error('Refund processing failed');
    }

    // From here the money HAS moved. The cumulative refunded total comes
    // from Stripe's charge (amount_refunded — the same ground truth the
    // charge.refunded webhook writes): local math alone DOUBLE-COUNTS when
    // the webhook repaired refund_amount before an idempotent replay of
    // this same attempt ($40 refund, webhook wrote 40, replay would record
    // prior 40 + 40 = 80), and misses dashboard-side partials this table
    // never saw.
    const refundAmountDollars = refund.amount / 100;
    let totalRefundedCents;
    if (requestCents === null) {
      // Omitted amount empties the remaining balance — fully refunded by
      // definition.
      totalRefundedCents = paidCents;
    } else if (payment.stripe_refund_id === refund.id) {
      // Idempotent replay of a refund the webhook already recorded —
      // prior INCLUDES this refund; adding it again would double-count.
      totalRefundedCents = priorCents;
    } else {
      totalRefundedCents = priorCents + refund.amount;
    }
    try {
      if (refund.charge) {
        const charge = await stripe.charges.retrieve(refund.charge);
        if (Number.isFinite(Number(charge?.amount_refunded))) {
          totalRefundedCents = Number(charge.amount_refunded);
        }
      }
    } catch (chargeErr) {
      logger.warn(`[stripe] refund cumulative lookup failed for payment ${paymentId} (falling back to local accumulation): ${chargeErr.message}`);
    }
    const isFullRefund = totalRefundedCents >= paidCents;

    // LIVE metadata read — the charge.refunded / refund.failed webhooks may
    // have written stamps or bounce fences while this attempt was in flight,
    // and clearedMeta is a pre-call snapshot that would otherwise erase them.
    let liveMeta = null;
    try {
      const liveRow = await db('payments').where({ id: paymentId }).first('metadata');
      try {
        liveMeta = liveRow?.metadata ? (typeof liveRow.metadata === 'string' ? JSON.parse(liveRow.metadata) : liveRow.metadata) : {};
      } catch { liveMeta = {}; }
    } catch (liveErr) {
      logger.warn(`[stripe] live metadata read failed for payment ${paymentId}: ${liveErr.message}`);
      liveMeta = null; // unknown — fall back to the loaded snapshot below
    }

    // A refund whose FAILURE was already recorded must never be stamped as
    // returned money: when the original attempt's ledger write failed, the
    // pending marker survives its own refund's bounce, and the retry's
    // idempotent key replay hands back the ORIGINAL bounced refund object
    // as if newly created. Stamping it would record money Stripe kept — and
    // handleRefundFailed would never rewind it (the bounce is already
    // fenced, so the event replay is a no-op). Abort: clear the pending
    // marker (the next attempt derives a fresh bounce-suffixed key) and
    // tell the operator the truth.
    const bounceFence = new Set([
      ...bouncedIds,
      ...(liveMeta && Array.isArray(liveMeta.failed_refund_ids) ? liveMeta.failed_refund_ids : []),
    ]);
    if (refund?.id && bounceFence.has(refund.id)) {
      const abortMeta = { ...(liveMeta || clearedMeta) };
      for (const k of ['pending_refund_key', 'pending_refund_request', 'pending_refund_base', 'pending_refund_gross', 'pending_refund_reason', 'pending_refund_at']) {
        delete abortMeta[k];
      }
      await db('payments').where({ id: paymentId }).update({ metadata: JSON.stringify(abortMeta) }).catch(() => {});
      logger.error(`[stripe] refund ${refund.id} for payment ${paymentId} already bounced at the bank — attempt aborted, nothing stamped`);
      throw new Error('This refund attempt already bounced at the bank — no money was returned. Re-run the refund to start a fresh attempt.');
    }
    // Preserve concurrently-recorded bounce fences of OTHER refunds — the
    // wholesale metadata write below must not erase them.
    if (bounceFence.size) clearedMeta.failed_refund_ids = [...bounceFence];

    // Record this refund as STAMPED (metadata.stamped_refund_ids) so a later
    // bounce stays attributable after newer stamps overwrite stripe_refund_id.
    const mergedStamps = new Set([
      ...(liveMeta && Array.isArray(liveMeta.stamped_refund_ids) ? liveMeta.stamped_refund_ids : []),
      ...(Array.isArray(clearedMeta.stamped_refund_ids) ? clearedMeta.stamped_refund_ids : []),
      ...(refund?.id ? [refund.id] : []),
    ]);
    if (mergedStamps.size) clearedMeta.stamped_refund_ids = [...mergedStamps];

    try {
      await db('payments')
        .where({ id: paymentId })
        .update({
          status: isFullRefund ? 'refunded' : 'paid',
          refund_amount: totalRefundedCents / 100,
          refund_status: refund.status,
          stripe_refund_id: refund.id,
          // Cumulative surcharge-returned tracker — the NEXT partial prorates
          // from this. The share actually sent this attempt = Stripe's refund
          // amount minus the entered base (0 on legacy/no-surcharge attempts);
          // a full refund returns the whole surcharge by definition.
          ...(surchargeCents > 0
            ? {
                refunded_surcharge_cents: isFullRefund
                  ? surchargeCents
                  : Math.min(
                      surchargeCents,
                      alreadyRefundedSurchargeCents + Math.max(0, (Number(refund.amount) || 0) - (requestCents || 0)),
                    ),
              }
            : {}),
          metadata: JSON.stringify(clearedMeta),
        });
    } catch (dbErr) {
      // Refund issued, ledger write failed. The pending attempt marker is
      // still set, so a retry replays the SAME idempotency key regardless
      // of what the webhook writes to refund_amount in the meantime —
      // Stripe returns the original refund and this write gets another
      // chance.
      logger.error(`[stripe] CRITICAL: refund ${refund.id} ($${refundAmountDollars}) issued for payment ${paymentId} but the payments-row update failed: ${dbErr.message}`);
      throw new Error(`Refund ${refund.id} WAS issued at Stripe but recording it failed. Re-running the same refund is safe — it will not refund twice, only sync the records.`);
    }

    // Side effects past this point never mask the successful refund as
    // "Refund processing failed" — each degrades on its own.
    if (isFullRefund) {
      try {
        await require('./annual-prepay-renewals').syncTermForRefundedPayment(payment);
      } catch (syncErr) {
        logger.error(`[annual-prepay] refund sync failed for payment ${paymentId}: ${syncErr.message}`);
      }
      // Return any applied account credit to the customer's balance — a full
      // refund gives back the cash, so the credit they used must return too
      // (else it stays consumed). Idempotent vs the charge.refunded webhook.
      try {
        const inv = await db('invoices').where({ stripe_payment_intent_id: payment.stripe_payment_intent_id }).first('id');
        if (inv) {
          const { returnAppliedCreditOnRefund } = require('./customer-credit');
          await db.transaction((trx) => returnAppliedCreditOnRefund({ invoiceId: inv.id, createdBy: 'system:refund' }, trx));
        }
      } catch (creditErr) {
        logger.error(`[stripe] refund credit-restore failed for payment ${paymentId}: ${creditErr.message}`);
      }
    }

    let updated = null;
    try {
      updated = await db('payments').where({ id: paymentId }).first();
    } catch (readErr) {
      logger.warn(`[stripe] refund post-update read failed for payment ${paymentId}: ${readErr.message}`);
    }
    PaymentLifecycleEmail.sendRefundIssued({
      customerId: updated?.customer_id || payment.customer_id,
      paymentId,
      refundId: refund.id,
      refundAmount: refundAmountDollars,
      refundDate: refund.created ? new Date(refund.created * 1000) : new Date(),
      refundReason: reason || 'Account adjustment',
    }).catch((emailErr) => {
      logger.warn(`[stripe] Refund issued email failed for payment ${paymentId}: ${emailErr.message}`);
    });
    logger.info(`[stripe] Refund processed: $${refundAmountDollars} for payment ${paymentId}, refund ${refund.id}`);
    return updated || { ...payment, status: isFullRefund ? 'refunded' : 'paid', refund_amount: totalRefundedCents / 100, stripe_refund_id: refund.id };
  },

  // =========================================================================
  // INVOICE PAYMENT — PaymentIntent for /pay/:token page
  // =========================================================================

  /**
   * Create a PaymentIntent for an invoice amount (public pay page).
   *
   * When `saveCard` is true we attach the Stripe customer and set
   * `setup_future_usage: 'off_session'` so the payment method is retained
   * after the charge succeeds. Customer attachment is required for
   * Stripe to persist the pm — we only do it when the customer has
   * explicitly opted in on the pay page.
   *
   * @param {string} invoiceId
   * @param {{ saveCard?: boolean }} [opts]
   */
  async createInvoicePaymentIntent(invoiceId, opts = {}) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    const invoice = await db('invoices').where({ id: invoiceId }).first();
    if (!invoice) throw new Error('Invoice not found');
    assertInvoiceCollectible(invoice.status);
    // Phase 2: an accrued invoice is payable ONLY through its consolidated
    // statement — never mint an individual PaymentIntent for it (it would
    // double-collect once the statement settles).
    if (invoice.payer_statement_id) {
      throw new Error('Invoice is billed on the payer’s monthly statement — pay the statement, not the individual invoice');
    }

    // Never save the payer's payment method onto the homeowner's account.
    // For a third-party-billed invoice the person paying is the builder/AP
    // contact, not invoice.customer_id — opting them into "save card" would
    // attach their card to the homeowner for future off-session charges.
    const saveCard = !!opts.saveCard && !invoice.payer_id;
    const stripeCustomerId = saveCard && invoice.customer_id
      ? await this.ensureStripeCustomer(invoice.customer_id)
      : null;

    let paymentIntent;
    let baseAmount;
    let cardSurcharge;
    let cardTotal;
    let coveredByCredit = false;
    let captureHeld = false;
    try {
      const methodMode = 'cardonly';
      await db.transaction(async (trx) => {
        const lockedInvoice = await trx('invoices')
          .where({ id: invoiceId })
          .forUpdate()
          .first();
        if (!lockedInvoice) throw new Error('Invoice not found');
        assertInvoiceCollectible(lockedInvoice.status);
        try {
          // Route preflight is intentionally duplicated under the invoice lock:
          // a saved-card owner can claim after the public request's unlocked
          // check but before this transaction mints/reuses a client secret.
          await assertNoInvoiceChargeReconciliationPending(invoiceId, trx);
        } catch (fenceErr) {
          fenceErr.statusCode = 409;
          fenceErr.inProgress = false;
          fenceErr.savedCardPending = true;
          throw fenceErr;
        }

        // Auto-apply only does anything when the customer actually has account
        // credit. Resolve the available balance once up front and gate BOTH the
        // stale-PI triage and the apply on it, so an invoice for a customer with
        // no credit runs the original PI lifecycle untouched (reuse an open PI,
        // 409 on an in-flight one, replace a canceled one via the idempotency
        // key). The triage must NEVER cancel/clear a PI when there's nothing to
        // draw down. A missing customer row reads as zero.
        let availableCredit = 0;
        if (require('../config/feature-gates').gates.autoApplyAccountCredit && lockedInvoice.customer_id) {
          const creditRow = await trx('customers')
            .where({ id: lockedInvoice.customer_id })
            .first('account_credits');
          availableCredit = Number(creditRow?.account_credits) || 0;
        }

        // Stale-PI triage BEFORE auto-apply: applyAccountCreditToInvoice
        // fail-closes on any attached PI, and the recovery path below would
        // otherwise re-price a dead PI at the gross amount. If the existing PI is
        // non-live (no active payment row + a cancelable Stripe status), cancel it
        // and clear the column so credit applies and a fresh PI is minted for
        // amount due. Money actually in flight is left untouched (handled by the
        // reuse block / its 409). The invoice is forUpdate-locked for the whole
        // transaction, so this can't race a new PI.
        //
        // FAIL CLOSED: a transient retrieve/cancel/clear failure must NOT fall
        // through. Now that the recovery path below can cancel-and-re-mint a stale
        // card intent, continuing here with the dead PI still attached would skip
        // the credit apply and price the replacement at the GROSS total. So on any
        // triage error refuse with a retryable 409 rather than risk an overcharge.
        if (require('../config/feature-gates').gates.autoApplyAccountCredit
          && availableCredit > 0
          && lockedInvoice.stripe_payment_intent_id) {
          let triagedPi = null;
          try {
            const existingPayment = await trx('payments')
              .where({ stripe_payment_intent_id: lockedInvoice.stripe_payment_intent_id })
              .first();
            const terminalPayStatuses = ['failed', 'canceled', 'cancelled', 'refunded'];
            const hasLivePayment = existingPayment && !terminalPayStatuses.includes(existingPayment.status);
            if (!hasLivePayment) {
              triagedPi = await stripe.paymentIntents.retrieve(lockedInvoice.stripe_payment_intent_id);
            }
          } catch (e) {
            logger.warn(`[stripe] pay-page stale-PI triage could not read PI for invoice ${invoiceId}: ${e.message}`);
            const err = new Error('Could not prepare your payment — please try again in a moment');
            err.statusCode = 409;
            throw err;
          }
          if (triagedPi) {
            // Ownership guard — never cancel a PI that belongs to a DIFFERENT
            // invoice (mirrors the main setup path's check below). A permanent
            // mismatch, not a transient blip: surface it as-is, do not fail-closed
            // retry it.
            const triagedInvoiceId = triagedPi.metadata?.waves_invoice_id || null;
            if (triagedInvoiceId && String(triagedInvoiceId) !== String(invoiceId)) {
              throw new Error('PaymentIntent does not belong to this invoice');
            }
            // `requires_action` is NOT uniformly live. An ACH micro-deposit
            // verification (next_action `verify_with_microdeposits`) is genuine
            // in-flight bank money and must stay attached — never cancel it. But a
            // CARD intent merely stuck in requires_action after an abandoned 3DS
            // moved no money: clear it so credit applies and the fresh PI is priced
            // at amount due rather than the gross total.
            const isAchMicrodeposit = triagedPi.status === 'requires_action'
              && triagedPi.next_action?.type === 'verify_with_microdeposits';
            const liveStatuses = ['processing', 'succeeded', 'requires_capture'];
            const isLive = liveStatuses.includes(triagedPi.status) || isAchMicrodeposit;
            if (!isLive) {
              try {
                if (triagedPi.status !== 'canceled') await stripe.paymentIntents.cancel(triagedPi.id);
                await trx('invoices').where({ id: invoiceId }).update({ stripe_payment_intent_id: null });
                lockedInvoice.stripe_payment_intent_id = null;
              } catch (e) {
                logger.warn(`[stripe] pay-page stale-PI triage could not clear dead PI for invoice ${invoiceId}: ${e.message}`);
                const err = new Error('Could not prepare your payment — please try again in a moment');
                err.statusCode = 409;
                throw err;
              }
            }
          }
        }

        // Apply available account credit before pricing so the customer pays
        // amount due, not the gross total. This controlled setup POST — not the
        // public-by-token GET — is the safe seam for it when the pay page is the
        // first touch after credit was issued / a link is reused. Gated +
        // idempotent; fail-closes on an attached PI. Full coverage COMMITS the
        // prepaid transition (return, NOT throw → no rollback) and skips minting
        // a PaymentIntent; settled after the transaction below.
        if (require('../config/feature-gates').gates.autoApplyAccountCredit && availableCredit > 0) {
          // Required-save signup with nothing chargeable on file: full
          // coverage is only PROBED, never applied (Codex #2507 round-7
          // P1). Applying here transitions the invoice to prepaid before
          // any SetupIntent exists, so an abandoned capture form would
          // leave the recurring signup complete with no saved method. The
          // hold keeps the invoice collectible; settleHeldCoverage applies
          // the credit from /setup-complete (or the covered_capture
          // webhook) AFTER save→consent→enroll succeeds. Partial coverage
          // falls through to the normal apply + PI mint — the PI itself
          // captures the method via setup_future_usage. An attached PI
          // means money may be in flight: never hold, let the existing
          // reuse/409 lifecycle decide.
          if (opts.holdCoverageForCapture
            && !lockedInvoice.stripe_payment_intent_id
            && availableCredit >= invoiceAmountDue(lockedInvoice)) {
            coveredByCredit = true;
            captureHeld = true;
            return;
          }
          const { applyAccountCreditToInvoice } = require('./customer-credit');
          await applyAccountCreditToInvoice({ invoiceId }, trx).catch((e) =>
            logger.warn(`[stripe] pay-page account-credit apply skipped for invoice ${invoiceId}: ${e.message}`));
          const recredited = await trx('invoices').where({ id: invoiceId }).forUpdate().first();
          if (recredited) Object.assign(lockedInvoice, recredited);
          if (!(invoiceAmountDue(lockedInvoice) > 0)) {
            coveredByCredit = true;
            return;
          }
        }

        // Charge base = amount due (total − applied account credit), not raw total.
        baseAmount = invoiceAmountDue(lockedInvoice);
        // PI starts at BASE amount only — no surcharge at setup time.
        // Card payments: surcharge is applied via the /quote → /finalize two-step flow.
        // Express Checkout (wallets): intentionally base-only in phase 1 (no surcharge).
        // ACH: no surcharge by design.
        // The legacy setup→confirmPayment→/confirm path charges whatever the PI
        // amount is at confirm time — if a card payment bypasses /quote+/finalize,
        // it would charge base-only (under-collect). The PayPageV2 UI prevents
        // this by routing all card submissions through the two-step flow.
        cardSurcharge = 0;
        cardTotal = baseAmount;
        const baseCents = Math.round(baseAmount * 100);

        const piParams = {
          amount: baseCents,
          currency: 'usd',
          description: `Invoice ${lockedInvoice.invoice_number} — ${lockedInvoice.title || 'Waves Pest Control'}`,
          metadata: {
            waves_invoice_id: invoiceId,
            invoice_number: lockedInvoice.invoice_number,
            waves_customer_id: lockedInvoice.customer_id,
            base_amount: String(baseAmount),
            card_surcharge: '0',
            save_card_opt_in: saveCard ? 'true' : 'false',
            selected_method_category: 'card',
            // CLEAR any surcharge-finalization metadata (Stripe metadata updates
            // MERGE) so a reused PI that was previously finalized can't carry a
            // stale surcharge_policy_version — which the webhook guard reads as
            // "finalized" and would settle a later base-only card confirm without
            // surcharge. Empty string deletes the key on update. Mirrors
            // createStatementPaymentIntent, which fixed exactly this failure mode.
            surcharge_policy_version: '',
            surcharge_rate_bps: '',
            card_funding: '',
          },
          payment_method_types: ['card'],
        };

        if (stripeCustomerId) {
          piParams.customer = stripeCustomerId;
          piParams.setup_future_usage = 'off_session';
        }

        if (lockedInvoice.stripe_payment_intent_id) {
          const activePayment = await trx('payments')
            .where({ stripe_payment_intent_id: lockedInvoice.stripe_payment_intent_id })
            .first();
          const terminalStatuses = ['failed', 'canceled', 'cancelled', 'refunded'];
          if (activePayment && !terminalStatuses.includes(activePayment.status)) {
            // A live (non-terminal) payment row means money is genuinely in
            // flight — an ACH debit in `processing`/`pending` that clears over
            // several business days. inProgress=true tells the pay page to send
            // the customer to the receipt's "bank payment processing" state.
            const err = new Error('Invoice payment is already in progress');
            err.statusCode = 409;
            err.inProgress = true;
            throw err;
          }

          const activeIntent = await stripe.paymentIntents.retrieve(lockedInvoice.stripe_payment_intent_id);
          const activeIntentInvoiceId = activeIntent.metadata?.waves_invoice_id || null;
          if (activeIntentInvoiceId && String(activeIntentInvoiceId) !== String(invoiceId)) {
            throw new Error('PaymentIntent does not belong to this invoice');
          }

          if (activeIntent.status === 'requires_payment_method') {
            const updateParams = { ...piParams };
            delete updateParams.currency;
            if (!stripeCustomerId) {
              updateParams.setup_future_usage = '';
            }
            paymentIntent = await stripe.paymentIntents.update(activeIntent.id, updateParams);
            const invoiceUpdated = await trx('invoices')
              .where({ id: invoiceId })
              .whereNotIn('status', ['paid', 'processing', 'void', 'refunded', 'canceled', 'cancelled'])
              .update({
                processor: 'stripe',
                stripe_payment_intent_id: paymentIntent.id,
              });
            if (!invoiceUpdated) throw new Error('Invoice is no longer collectible');
            return;
          }

          if (activeIntent.status !== 'canceled') {
            // ACH micro-deposit verification also lives in `requires_action`, but
            // it is the OPPOSITE of an abandoned card intent: the customer chose
            // bank debit, Stripe has already sent two small deposits to their
            // account, and it is waiting (1–2 business days) for them to confirm
            // the amounts. Canceling it would throw away the verification and
            // force the customer to restart ACH from scratch — and a returning
            // customer reloads this exact pay page to do the verifying. Detect it
            // by the next_action Stripe sets and treat it like an in-flight ACH
            // debit: never cancel, no admin alert (inProgress=true → the pay page
            // shows the benign bank state, not a red error). This is the
            // real-world WPC-2026-0164 / -0190 / -0191 case.
            if (activeIntent.next_action?.type === 'verify_with_microdeposits') {
              const err = new Error('Invoice payment is already in progress');
              err.statusCode = 409;
              err.inProgress = true;
              // Distinct from a `processing` ACH debit: the customer still has to
              // verify the two micro-deposits before this can settle, so the pay
              // page must NOT tell them "nothing more to do". Surface a specific
              // flag so it can show verification guidance instead.
              err.microdepositPending = true;
              throw err;
            }

            if (SETUP_RECOVERABLE_PI_STATUSES.has(activeIntent.status)) {
              // The customer is back on the pay page with a stale, never-captured
              // card PI — most often stuck in `requires_action` after an abandoned
              // 3DS handoff, or left in requires_confirmation. (ACH micro-deposit
              // verification is handled above; `requires_capture` is excluded from
              // the recoverable set so an authorized hold is never voided here —
              // both take the non-replaceable 409 path below.) No money has moved,
              // so recover in place instead of hard-blocking the customer and
              // re-raising an admin alert on every reload: cancel the dead intent
              // and fall through to mint a fresh one they can pay.
              //
              // FAIL CLOSED: if the cancel fails, the old PI may have just raced
              // into processing/succeeded — minting a replacement while its
              // client secret can still collect would double-charge. Refuse
              // instead of repointing the invoice at a new PI. Mirrors the
              // statement-payment path's replace-or-refuse handling below.
              try {
                await stripe.paymentIntents.cancel(activeIntent.id);
              } catch (e) {
                logger.warn(`[stripe] could not cancel replaceable invoice PI ${activeIntent.id} for ${lockedInvoice.invoice_number}: ${e.message}`);
                const err = new Error('Could not replace the existing payment — please try again in a moment');
                err.statusCode = 409;
                throw err;
              }
            } else {
              // Money is genuinely in flight or already captured — never cancel.
              // `processing` is a benign ACH bank debit clearing over several
              // business days, with the receipt to follow when the webhook settles
              // it (inProgress=true → the pay page shows the "bank payment
              // processing" state, no alert). `succeeded` means money was captured
              // but our local invoice/payment reconciliation never happened (a
              // lost/failed webhook): inProgress stays false so the route still
              // raises an admin reconciliation alert instead of hiding an
              // unpaid-with-no-receipt invoice behind the processing copy.
              const err = new Error('Invoice payment is already in progress');
              err.statusCode = 409;
              err.inProgress = activeIntent.status === 'processing';
              throw err;
            }
          }
        }

        // Include the currently stored PI id in the key so a replacement
        // setup cannot replay an older canceled intent for this invoice.
        const sourceIntent = lockedInvoice.stripe_payment_intent_id || 'new';
        const idempotencyKey = `invoice_pi_${invoiceId}_${baseCents}_${saveCard ? 'save' : 'nosave'}_${methodMode}_${sourceIntent}`;
        paymentIntent = await stripe.paymentIntents.create(piParams, { idempotencyKey });

        if (paymentIntent.status === 'canceled') {
          logger.warn(`[stripe] Stripe replayed canceled PI ${paymentIntent.id} for invoice ${lockedInvoice.invoice_number}; minting replacement`);
          paymentIntent = await stripe.paymentIntents.create(piParams, {
            idempotencyKey: `${idempotencyKey}_replacement_${uuidv4()}`,
          });
        }
        if (paymentIntent.status === 'canceled') {
          throw new Error(`Stripe returned canceled PaymentIntent ${paymentIntent.id}`);
        }

        const invoiceUpdated = await trx('invoices')
          .where({ id: invoiceId })
          .whereNotIn('status', ['paid', 'processing', 'void', 'refunded', 'canceled', 'cancelled'])
          .update({
          processor: 'stripe',
          stripe_payment_intent_id: paymentIntent.id,
        });
        if (!invoiceUpdated) throw new Error('Invoice is no longer collectible');
      });

      if (coveredByCredit) {
        if (captureHeld) {
          // Coverage was only probed — the invoice is untouched (still
          // collectible, credit balance intact). The route surfaces
          // captureNeeded and the credit applies via settleHeldCoverage
          // once the capture completes.
          logger.info(`[stripe] Pay-page: account credit fully covers invoice ${invoice.invoice_number} — coverage HELD pending required-save capture`);
          return { covered_by_credit: true, capture_held: true, status: invoice.status, clientSecret: null, paymentIntentId: null, amount: 0 };
        }
        // Account credit fully covered the invoice in the committed transaction
        // above — no PaymentIntent to mint. Run the same post-payment side effects
        // a real payment would, and return a covered state (no clientSecret) so
        // the pay page settles instead of charging.
        try {
          await require('./invoice-followups').stopOnPayment(invoiceId);
        } catch (e) {
          logger.warn(`[stripe] stopOnPayment after credit coverage failed for ${invoiceId}: ${e.message}`);
        }
        try {
          const fresh = await db('invoices').where({ id: invoiceId }).first();
          if (fresh) await require('./annual-prepay-renewals').syncTermForInvoicePayment(fresh);
        } catch (e) {
          logger.warn(`[stripe] term sync after credit coverage failed for ${invoiceId}: ${e.message}`);
        }
        logger.info(`[stripe] Pay-page: account credit fully covered invoice ${invoice.invoice_number} — no PaymentIntent`);
        return { covered_by_credit: true, status: 'prepaid', clientSecret: null, paymentIntentId: null, amount: 0 };
      }

      logger.info(`[stripe] Invoice PaymentIntent created: ${paymentIntent.id} for invoice ${invoice.invoice_number} (base=$${baseAmount})`);
      return {
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        amount: baseAmount,
        baseAmount,
        cardSurchargeRate: CONFIGURED_COST_BPS / 10_000,
        surchargeRateBps: CONFIGURED_COST_BPS,
      };
    } catch (err) {
      if (err.statusCode) {
        if (savedCardChargeNeedsReconciliation(err)) {
          // The locked check aborts its invoice transaction before this catch.
          // Park in a fresh committed transaction so the status change survives
          // the 409 and status-only billing surfaces stop offering collection.
          const parked = await parkInvoiceForSavedCardReconciliation({
            invoiceId,
            error: err,
            chargeAttemptId: err.chargeAttemptId,
          });
          err.reconciliationRequired = parked.reconciliationRequired;
        }
        logger.warn(`[stripe] Invoice PaymentIntent setup blocked for invoice ${invoiceId}: ${err.message}`);
        throw err;
      }
      if (paymentIntent?.id) {
        try {
          const currentInvoice = await db('invoices').where({ id: invoiceId }).first();
          if (String(currentInvoice?.stripe_payment_intent_id || '') !== String(paymentIntent.id)) {
            await stripe.paymentIntents.cancel(paymentIntent.id);
          }
        } catch (cancelErr) {
          logger.warn(`[stripe] Could not cancel unlinked invoice PI ${paymentIntent.id}: ${cancelErr.message}`);
        }
      }
      logger.error(`[stripe] Invoice PaymentIntent failed for invoice ${invoiceId}: ${err.type || 'Error'} — ${err.message}${err.code ? ` [code=${err.code}]` : ''}${err.param ? ` [param=${err.param}]` : ''}`);
      throw new Error(`Failed to create payment intent for invoice: ${err.message}`);
    }
  },

  /**
   * Settle a required-save invoice whose full credit coverage was HELD until
   * method capture completed (Codex #2507 round-7 P1):
   * createInvoicePaymentIntent with holdCoverageForCapture only PROBES
   * coverage, so the invoice stays collectible until save→consent→enroll
   * succeeds. Called from POST /pay/:token/setup-complete and the
   * covered_capture webhook — idempotent both directions:
   * applyAccountCreditToInvoice skips uncollectible / PI-attached /
   * payer-billed invoices, and fullCoverageOnly refuses to partially drain
   * credit that shrank in the meantime (the invoice then simply stays
   * payable through the normal pay flow — reminders never stopped because
   * it was never settled).
   *
   * Returns { settled, alreadySettled, reason } — alreadySettled marks the
   * benign "someone else settled it first" skip so callers don't treat a
   * completed race as a coverage failure.
   */
  async settleHeldCoverage(invoiceId) {
    const { applyAccountCreditToInvoice } = require('./customer-credit');
    const result = await applyAccountCreditToInvoice({ invoiceId, fullCoverageOnly: true });
    if (!result?.fullyCovered) {
      return {
        settled: false,
        alreadySettled: result?.skipped === 'uncollectible',
        reason: result?.skipped || 'not_fully_covered',
      };
    }
    // Same post-payment side effects the immediate covered path runs.
    try {
      await require('./invoice-followups').stopOnPayment(invoiceId);
    } catch (e) {
      logger.warn(`[stripe] stopOnPayment after held-coverage settle failed for ${invoiceId}: ${e.message}`);
    }
    try {
      const fresh = await db('invoices').where({ id: invoiceId }).first();
      if (fresh) await require('./annual-prepay-renewals').syncTermForInvoicePayment(fresh);
    } catch (e) {
      logger.warn(`[stripe] term sync after held-coverage settle failed for ${invoiceId}: ${e.message}`);
    }
    logger.info(`[stripe] Held credit coverage settled for invoice ${invoiceId} after required-save capture`);
    return { settled: true, alreadySettled: false, reason: null };
  },

  /**
   * Update an open invoice PaymentIntent's method category.
   *
   * Both card and ACH keep the PI at base amount — no surcharge at this stage.
   * Surcharge is calculated at /quote and applied at /finalize after PM funding
   * is confirmed.
   *
   * @param {string} invoiceId
   * @param {string} paymentIntentId
   * @param {string} methodCategory — Stripe Payment Element "change" event type
   *   (e.g. 'card', 'us_bank_account', 'apple_pay', 'google_pay', 'link')
   */
  async updateInvoicePaymentIntentMethod(invoiceId, paymentIntentId, methodCategory, opts = {}) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    const invoice = await db('invoices').where({ id: invoiceId }).first();
    if (!invoice) throw new Error('Invoice not found');
    assertInvoiceCollectible(invoice.status);
    if (!invoice.stripe_payment_intent_id) {
      throw new Error('PaymentIntent does not belong to this invoice');
    }
    // Never save a third-party payer's card onto the homeowner account (see
    // createInvoicePaymentIntent) — the AP user can toggle this after the
    // Element loads, so guard the update path too.
    const saveCard = !!opts.saveCard && !invoice.payer_id;

    // A stale id can be a legitimate lost-response recovery: a prior
    // /update-amount took the replacement path (fresh PI minted, invoice
    // repointed) but the response never reached the client, so its network
    // retry still carries the dead PI's id. Recover ONLY for that exact
    // replay, all three required:
    //  - lineage: the stale id is the PI the current one replaced (stamped
    //    by replaceInvoicePaymentIntentForTender, one generation);
    //  - tender: the request matches the current PI's lock, so a replay can
    //    re-apply payment_method_types but never flip it under a pending
    //    confirm/finalize;
    //  - save-card: the request matches the current PI's save_card_opt_in,
    //    so a late replay can never clear a newer opt-in's
    //    setup_future_usage (consent silently lost).
    // Any other mismatch — e.g. an out-of-order older sync from a dead
    // Elements mount — rejects as before. The caller-supplied PI is never
    // updated on a mismatch.
    const retargeted = String(invoice.stripe_payment_intent_id) !== String(paymentIntentId);
    const effectivePaymentIntentId = String(invoice.stripe_payment_intent_id);
    if (retargeted) {
      const requestedType = isCardMethodType(methodCategory || 'card') ? 'card' : 'us_bank_account';
      let currentIntent = null;
      try {
        currentIntent = await stripe.paymentIntents.retrieve(effectivePaymentIntentId);
      } catch (retrieveErr) {
        logger.warn(
          `[stripe] Could not retrieve current PI ${effectivePaymentIntentId} while vetting a stale `
          + `update-amount id for invoice ${invoiceId}: ${retrieveErr.message}`,
        );
      }
      const lineageMatch = currentIntent?.metadata?.replaced_from === String(paymentIntentId);
      const tenderMatch = Array.isArray(currentIntent?.payment_method_types)
        && currentIntent.payment_method_types.length === 1
        && currentIntent.payment_method_types[0] === requestedType;
      const saveCardMatch = (currentIntent?.metadata?.save_card_opt_in === 'true') === saveCard;
      if (!lineageMatch || !tenderMatch || !saveCardMatch) {
        throw new Error('PaymentIntent does not belong to this invoice');
      }
      logger.warn(
        `[stripe] update-amount replaying a lost replacement response: stale PI ${paymentIntentId} `
        + `→ current PI ${effectivePaymentIntentId} (invoice ${invoiceId})`,
      );
    }
    const selectedMethodCategory = methodCategory || 'card';
    // Charge base = amount due (total − applied account credit), not raw total.
    const base = invoiceAmountDue(invoice);
    const baseCents = Math.round(base * 100);

    // Lock the PI to the selected tender family before Stripe can confirm.
    // The pay page exposes Card/ACH with its own selector; Stripe Elements
    // then refreshes to the one tender family that matches this amount.
    const paymentMethodTypes = isCardMethodType(selectedMethodCategory)
      ? ['card']
      : ['us_bank_account'];

    const updateParams = {
      amount: baseCents,
      payment_method_types: paymentMethodTypes,
      metadata: {
        waves_invoice_id: invoiceId,
        invoice_number: invoice.invoice_number,
        base_amount: String(base),
        card_surcharge: '0',
        selected_method_category: String(selectedMethodCategory),
        save_card_opt_in: saveCard ? 'true' : 'false',
        // CLEAR any surcharge-finalization metadata (Stripe metadata updates
        // MERGE) — a declined /finalize leaves surcharge_policy_version on the
        // PI, and the webhook's surcharge-bypass quarantine reads that stale key
        // as "finalized", settling a later base-only card confirm without the
        // surcharge. Empty string deletes the key on update. Mirrors
        // createStatementPaymentIntent.
        surcharge_policy_version: '',
        surcharge_rate_bps: '',
        card_funding: '',
      },
    };

    // saveCard requires a Stripe customer on the PI. Attach on first opt-in,
    // set SFU accordingly. Unticking after opting in clears SFU (''), but we
    // leave the customer attached — unsetting it isn't supported and it's
    // harmless once the PI is consumed.
    if (saveCard && invoice.customer_id) {
      updateParams.customer = await this.ensureStripeCustomer(invoice.customer_id);
      updateParams.setup_future_usage = 'off_session';
    } else {
      updateParams.setup_future_usage = '';
    }

    try {
      const paymentIntent = await stripe.paymentIntents.update(effectivePaymentIntentId, updateParams);
      logger.info(`[stripe] PI ${effectivePaymentIntentId} updated → base=$${base} surcharge=0 total=$${base} (method=${selectedMethodCategory})`);
      if (retargeted) {
        // A newer tender switch can repoint the invoice between the lineage
        // vetting above and this update settling. Re-read before handing the
        // client a secret: returning an orphaned PI would let a charge
        // succeed that /confirm then rejects (invoice bound elsewhere).
        const freshInvoice = await db('invoices').where({ id: invoiceId }).first();
        if (!freshInvoice
          || String(freshInvoice.stripe_payment_intent_id || '') !== effectivePaymentIntentId) {
          const raceErr = new Error('Payment session changed. Please refresh the invoice and try again.');
          raceErr.statusCode = 409;
          raceErr.sessionChanged = true;
          throw raceErr;
        }
      }
      return {
        paymentIntentId: paymentIntent.id,
        base,
        surcharge: 0,
        total: base,
        cardSurchargeRate: CONFIGURED_COST_BPS / 10_000,
        surchargeRateBps: CONFIGURED_COST_BPS,
        ...(retargeted ? { replaced: true, clientSecret: paymentIntent.client_secret } : {}),
      };
    } catch (err) {
      // The retarget recheck's session-changed 409 must reach the route
      // as-is, not wrapped as a generic update failure.
      if (err && err.sessionChanged) throw err;
      // A prior confirm attempt (e.g. an abandoned ACH entry) can leave an
      // incompatible PaymentMethod attached to the PI, so narrowing
      // payment_method_types to the newly selected tender is rejected. Recover
      // by minting a fresh PI for the selected tender — a new PI has no
      // attached PM, so the lock applies cleanly and the surcharge-bypass
      // defense is preserved.
      if (isIncompatibleAttachedMethodError(err)) {
        logger.warn(
          `[stripe] PI ${effectivePaymentIntentId} tender switch blocked by attached PM; `
          + `recreating for method=${selectedMethodCategory}`,
        );
        return this.replaceInvoicePaymentIntentForTender(invoiceId, effectivePaymentIntentId, {
          paymentMethodTypes,
          metadata: updateParams.metadata,
          customer: updateParams.customer || null,
          setupFutureUsage: updateParams.setup_future_usage,
          base,
          baseCents,
          methodCategory: selectedMethodCategory,
        });
      }
      logger.error(`[stripe] PI update failed for ${effectivePaymentIntentId}: ${err.message}`);
      throw new Error(`Failed to update payment amount: ${err.message}`);
    }
  },

  /**
   * Cancel a stale invoice PaymentIntent and mint a fresh one locked to the
   * selected tender. Used when a tender switch can't be applied in place
   * because an incompatible PaymentMethod is still attached to the old PI.
   *
   * Returns the same shape as updateInvoicePaymentIntentMethod plus the new
   * `clientSecret` and `replaced: true` so the pay page can re-mount Stripe
   * Elements against the fresh PI.
   */
  async replaceInvoicePaymentIntentForTender(invoiceId, oldPaymentIntentId, ctx) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    const { paymentMethodTypes, metadata, customer, setupFutureUsage, base, baseCents, methodCategory } = ctx;

    // Inspect the stale PI before touching it. Fail CLOSED: only replace when
    // we positively know the old PI is in a cancelable (or already-canceled)
    // state. If its status can't be read, or it's processing/succeeded (money
    // in flight), do NOT detach it — repointing the invoice off an in-flight
    // ACH PI would let the customer pay the replacement while the original
    // bank debit is still pending.
    let oldIntent = null;
    try {
      oldIntent = await stripe.paymentIntents.retrieve(oldPaymentIntentId);
    } catch (retrieveErr) {
      logger.warn(`[stripe] Could not retrieve stale PI ${oldPaymentIntentId} during tender switch: ${retrieveErr.message}`);
    }
    if (!oldIntent) {
      // Status unknown — surface as a hard error (visible to ops) and never
      // replace blind.
      throw new Error(`Could not verify the existing payment status for PI ${oldPaymentIntentId}`);
    }
    if (oldIntent.status !== 'canceled' && !REPLACEABLE_PI_STATUSES.has(oldIntent.status)) {
      const err = new Error('Payment is already in progress. Please refresh the invoice and try again.');
      err.statusCode = 409;
      throw err;
    }

    const invoice = await db('invoices').where({ id: invoiceId }).first();
    if (!invoice) throw new Error('Invoice not found');

    const piParams = {
      amount: baseCents,
      currency: 'usd',
      description: `Invoice ${invoice.invoice_number} — ${invoice.title || 'Waves Pest Control'}`,
      // replaced_from stamps one generation of lineage so update-amount can
      // recognize a lost-response replay of THIS replacement (client retries
      // still carrying the canceled PI's id) without opening a blanket
      // stale-id retarget.
      metadata: { ...metadata, replaced_from: String(oldPaymentIntentId) },
      payment_method_types: paymentMethodTypes,
    };
    if (customer) {
      piParams.customer = customer;
      if (setupFutureUsage) piParams.setup_future_usage = setupFutureUsage;
    }

    let newIntent;
    await db.transaction(async (trx) => {
      const lockedInvoice = await trx('invoices')
        .where({ id: invoiceId })
        .forUpdate()
        .first();
      if (!lockedInvoice) throw new Error('Invoice not found');
      assertInvoiceCollectible(lockedInvoice.status);
      // Guard against a racing setup/replace having already repointed the PI.
      if (String(lockedInvoice.stripe_payment_intent_id || '') !== String(oldPaymentIntentId)) {
        const err = new Error('Payment session changed. Please refresh the invoice and try again.');
        err.statusCode = 409;
        throw err;
      }

      // Cancel before repointing the invoice. If the old PI races into
      // processing after the status read above, Stripe will reject this cancel;
      // failing here keeps the invoice bound to the in-flight payment instead
      // of orphaning a bank debit behind a fresh card PI.
      if (oldIntent.status !== 'canceled') {
        try {
          await stripe.paymentIntents.cancel(oldPaymentIntentId);
        } catch (cancelErr) {
          logger.warn(`[stripe] Could not cancel stale PI ${oldPaymentIntentId} during tender switch: ${cancelErr.message}`);
          const err = new Error('Payment is already in progress. Please refresh the invoice and try again.');
          err.statusCode = 409;
          throw err;
        }
      }

      const saveFlag = metadata?.save_card_opt_in === 'true' ? 'save' : 'nosave';
      newIntent = await stripe.paymentIntents.create(piParams, {
        idempotencyKey: `invoice_pi_replace_${invoiceId}_${oldPaymentIntentId}_${paymentMethodTypes.join('-')}_${saveFlag}`,
      });

      const invoiceUpdated = await trx('invoices')
        .where({ id: invoiceId })
        .whereNotIn('status', ['paid', 'processing', 'void', 'refunded', 'canceled', 'cancelled'])
        .update({ processor: 'stripe', stripe_payment_intent_id: newIntent.id });
      if (!invoiceUpdated) throw new Error('Invoice is no longer collectible');
    });

    logger.info(
      `[stripe] Replaced PI ${oldPaymentIntentId} → ${newIntent.id} for invoice ${invoice.invoice_number} `
      + `(method=${methodCategory}, base=$${base})`,
    );
    return {
      paymentIntentId: newIntent.id,
      clientSecret: newIntent.client_secret,
      replaced: true,
      base,
      surcharge: 0,
      total: base,
      cardSurchargeRate: CONFIGURED_COST_BPS / 10_000,
      surchargeRateBps: CONFIGURED_COST_BPS,
    };
  },

  /**
   * Quote the surcharge for a specific payment method on an invoice.
   * Returns the breakdown and a quoteToken for /finalize.
   */
  async quoteInvoiceSurcharge(invoiceId, paymentMethodId) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    const invoice = await db('invoices').where({ id: invoiceId }).first();
    if (!invoice) throw new Error('Invoice not found');
    assertInvoiceCollectible(invoice.status);

    // Retrieve the PM from Stripe to get real-time funding type
    let pm;
    try {
      pm = await stripe.paymentMethods.retrieve(paymentMethodId);
    } catch (err) {
      throw new Error(`Could not retrieve payment method: ${err.message}`);
    }

    const methodType = pm.type || 'card';
    const funding = pm.card?.funding || null;
    // Charge base = amount due (total − applied account credit), not raw total.
    // The quote stores this as invoiceTotal below, so /finalize matches.
    const baseAmount = invoiceAmountDue(invoice);

    const chargeInfo = computeChargeAmount(baseAmount, methodType, { funding });
    const { baseCents, surchargeCents, totalCents, rateBps, policyVersion } = chargeInfo;

    // Create an HMAC-signed quote token for /finalize
    const crypto = require('crypto');
    const hmacSecret = process.env.JWT_SECRET;
    if (!hmacSecret) throw new Error('JWT_SECRET is required for surcharge quote signing');
    const payloadJson = JSON.stringify({
      invoiceId,
      paymentMethodId,
      invoiceTotal: baseAmount,
      quotedAt: Date.now(),
    });
    const signature = crypto.createHmac('sha256', hmacSecret).update(payloadJson).digest('base64url');
    const quoteToken = `${Buffer.from(payloadJson).toString('base64url')}.${signature}`;

    return {
      quoteToken,
      base: baseCents / 100,
      surcharge: surchargeCents / 100,
      total: totalCents / 100,
      rateBps,
      funding,
      methodType,
    };
  },

  /**
   * Finalize an invoice payment with the surcharge from a prior /quote.
   * Updates the PI amount to include surcharge, then confirms.
   */
  async finalizeInvoicePayment(invoiceId, quoteToken, opts = {}) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    // Decode and verify the HMAC-signed quote token
    const crypto = require('crypto');
    const hmacSecret = process.env.JWT_SECRET;
    if (!hmacSecret) throw new Error('JWT_SECRET is required for surcharge quote signing');
    let quote;
    try {
      const [payloadPart, sigPart] = quoteToken.split('.');
      if (!payloadPart || !sigPart) throw new Error('malformed');
      const expectedSig = crypto.createHmac('sha256', hmacSecret).update(Buffer.from(payloadPart, 'base64url').toString()).digest('base64url');
      if (sigPart !== expectedSig) throw new Error('signature mismatch');
      quote = JSON.parse(Buffer.from(payloadPart, 'base64url').toString());
    } catch {
      throw new Error('Invalid or tampered quote token');
    }

    if (String(quote.invoiceId) !== String(invoiceId)) {
      throw new Error('Quote token does not match this invoice');
    }

    // Quote tokens expire after 10 minutes
    if (Date.now() - (quote.quotedAt || 0) > 10 * 60 * 1000) {
      throw new Error('Quote expired — please try again');
    }

    const invoice = await db('invoices').where({ id: invoiceId }).first();
    if (!invoice) throw new Error('Invoice not found');
    assertInvoiceCollectible(invoice.status);

    if (!invoice.stripe_payment_intent_id) {
      throw new Error('Invoice has no active PaymentIntent');
    }

    // Re-derive charge from PM + invoice — never trust client-provided amounts
    const pm = await stripe.paymentMethods.retrieve(quote.paymentMethodId);
    const funding = pm.card?.funding || null;
    // Charge base = amount due (total − applied account credit), not raw total —
    // must match the same calc the quote captured as invoiceTotal.
    const baseAmount = invoiceAmountDue(invoice);

    if (quote.invoiceTotal != null && Math.abs(baseAmount - quote.invoiceTotal) > 0.01) {
      throw new Error('Invoice total changed since quote was created. Please request a new quote.');
    }

    const chargeInfo = computeChargeAmount(baseAmount, pm.type || 'card', { funding });
    const { baseCents, surchargeCents, totalCents, rateBps, policyVersion } = chargeInfo;

    const surchargeDetails = buildSurchargeAmountDetails(surchargeCents);
    const usePreview = !!surchargeDetails;
    // Payer invoices never save the payer's card to the homeowner account.
    const saveCard = !!opts.saveCard && !invoice.payer_id;

    // Update PI with final amount, attach PM, then confirm server-side
    const updateParams = {
      amount: totalCents,
      payment_method: quote.paymentMethodId,
      metadata: {
        waves_invoice_id: invoiceId,
        invoice_number: invoice.invoice_number,
        waves_customer_id: invoice.customer_id,
        base_amount: String(baseCents / 100),
        card_surcharge: String(surchargeCents / 100),
        surcharge_rate_bps: String(rateBps),
        surcharge_policy_version: policyVersion,
        card_funding: funding || 'unknown',
        save_card_opt_in: saveCard ? 'true' : 'false',
      },
    };

    if (surchargeDetails) updateParams.amount_details = surchargeDetails;

    if (saveCard && invoice.customer_id) {
      updateParams.customer = await this.ensureStripeCustomer(invoice.customer_id);
      updateParams.setup_future_usage = 'off_session';
    } else {
      updateParams.setup_future_usage = '';
    }

    try {
      const confirmed = await db.transaction(async (finalizeTrx) => {
        const lockedInvoice = await finalizeTrx('invoices')
          .where({ id: invoiceId })
          .forUpdate()
          .first();
        if (!lockedInvoice) throw new Error('Invoice not found');
        assertInvoiceCollectible(lockedInvoice.status);
        if (String(lockedInvoice.stripe_payment_intent_id || '')
          !== String(invoice.stripe_payment_intent_id)) {
          throw new Error('Invoice has a different active payment');
        }
        const lockedBaseAmount = invoiceAmountDue(lockedInvoice);
        if (Math.abs(lockedBaseAmount - baseAmount) > 0.01) {
          throw new Error('Invoice total changed since quote was created. Please request a new quote.');
        }

        // Final serialized fence: saved-card claims take this same invoice lock
        // before inserting their durable attempt. Hold it through Stripe confirm
        // so a claim cannot appear after the assertion but before money moves.
        await assertNoInvoiceChargeReconciliationPending(invoiceId, finalizeTrx);

        await stripe.paymentIntents.update(
          lockedInvoice.stripe_payment_intent_id,
          updateParams,
          usePreview ? { apiVersion: SURCHARGE_API_VERSION } : undefined,
        );

        // Confirm the PI server-side (attaches PM + charges the card).
        return stripe.paymentIntents.confirm(
          lockedInvoice.stripe_payment_intent_id,
          {},
          usePreview ? { apiVersion: SURCHARGE_API_VERSION } : undefined,
        );
      });

      logger.info(`[stripe] Finalized invoice ${invoice.invoice_number}: funding=${funding} surcharge=${surchargeCents}c total=${totalCents}c PI=${confirmed.id} status=${confirmed.status}`);

      return {
        paymentIntentId: confirmed.id,
        paymentMethodId: quote.paymentMethodId,
        clientSecret: confirmed.client_secret,
        status: confirmed.status,
        requiresAction: confirmed.status === 'requires_action',
        base: baseCents / 100,
        surcharge: surchargeCents / 100,
        total: totalCents / 100,
        rateBps,
        funding,
      };
    } catch (err) {
      if (savedCardChargeSuppressesAlternateCollection(err)) {
        if (savedCardChargeNeedsReconciliation(err)) {
          const parked = await parkInvoiceForSavedCardReconciliation({
            invoiceId,
            error: err,
            chargeAttemptId: err.chargeAttemptId,
          });
          err.reconciliationRequired = parked.reconciliationRequired;
        }
        err.statusCode = 409;
        err.savedCardPending = true;
        throw err;
      }
      logger.error(`[stripe] Finalize failed for PI ${invoice.stripe_payment_intent_id}: ${err.message}`);
      throw new Error(`Failed to finalize payment: ${err.message}`);
    }
  },

  // =========================================================================
  // PAYER STATEMENT PAYMENT (P3) — charges payer.stripe_customer_id, NOT the
  // homeowner. Mirrors the invoice setup → quote → finalize surcharge flow, but
  // keyed on a payer_statements token + status state machine. Statement settles
  // to `paid` (cascade) only via the webhook; a freshly-created PI never moves
  // the statement to `processing` (it stays replaceable until confirmed).
  // =========================================================================

  /**
   * Create (or reuse a replaceable) PaymentIntent for a FROZEN, not-in-flight
   * statement, on the payer's Stripe customer. PI starts at the BASE total (no
   * surcharge) — surcharge is applied via /quote → /finalize once PM funding is
   * known. Does NOT move the statement to `processing` (the webhook does, on the
   * confirmed money-in-flight event), so an abandoned pay page can't lock it.
   */
  async createStatementPaymentIntent(statementId, opts = {}) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');
    const { isPayableStatementStatus, PAYABLE_STATEMENT_STATUSES } = require('./payer-statement-settle');
    const payableList = [...PAYABLE_STATEMENT_STATUSES];

    const assertPayable = (status) => {
      if (isPayableStatementStatus(status)) return;
      const inFlightOrDone = status === 'processing' || status === 'paid';
      const err = new Error(status === 'processing'
        ? 'A payment is already in progress for this statement'
        : status === 'paid'
          ? 'This statement is already paid'
          : 'This statement is not payable');
      err.statusCode = inFlightOrDone ? 409 : 400;
      // A `processing` statement is a benign ACH debit clearing — carry inProgress
      // so the pay page shows the calm bank-processing notice, not a red error.
      if (status === 'processing') err.inProgress = true;
      throw err;
    };

    const statement = await db('payer_statements').where({ id: statementId }).first();
    if (!statement) throw new Error('Statement not found');
    assertPayable(statement.status);

    const stripeCustomerId = await this.ensureStripePayerCustomer(statement.payer_id);
    const saveCard = !!opts.saveCard; // card-save is OPTIONAL (owner) — off by default

    let paymentIntent;
    let baseAmount;
    try {
      await db.transaction(async (trx) => {
        const locked = await trx('payer_statements').where({ id: statementId }).forUpdate().first();
        if (!locked) throw new Error('Statement not found');
        assertPayable(locked.status);

        baseAmount = parseFloat(locked.total);
        const baseCents = Math.round(baseAmount * 100);

        const piParams = {
          amount: baseCents,
          currency: 'usd',
          customer: stripeCustomerId,
          description: `Waves statement S-${statementId}`,
          metadata: {
            waves_statement_id: String(statementId),
            waves_payer_id: String(locked.payer_id),
            base_amount: String(baseAmount),
            card_surcharge: '0',
            save_card_opt_in: saveCard ? 'true' : 'false',
            selected_method_category: 'card',
            // CLEAR any surcharge-finalization metadata (Stripe metadata updates
            // MERGE) so a reused PI that was previously finalized can't carry a
            // stale surcharge_policy_version — which the webhook guard reads as
            // "finalized" and would settle a later base-only card confirm without
            // surcharge. Empty string deletes the key on update.
            surcharge_policy_version: '',
            surcharge_rate_bps: '',
            card_funding: '',
          },
          payment_method_types: ['card', 'us_bank_account'],
        };
        if (saveCard) piParams.setup_future_usage = 'off_session';

        // Reuse a replaceable unconfirmed PI; cancel-and-replace other
        // unconfirmed states; refuse if money is genuinely in flight.
        if (locked.stripe_payment_intent_id) {
          const activeIntent = await stripe.paymentIntents.retrieve(locked.stripe_payment_intent_id);
          const activeStatementId = activeIntent.metadata?.waves_statement_id || null;
          if (activeStatementId && String(activeStatementId) !== String(statementId)) {
            throw new Error('PaymentIntent does not belong to this statement');
          }
          if (activeIntent.status === 'requires_payment_method') {
            const updateParams = { ...piParams };
            delete updateParams.currency;
            if (!saveCard) updateParams.setup_future_usage = '';
            paymentIntent = await stripe.paymentIntents.update(activeIntent.id, updateParams);
            const reused = await trx('payer_statements').where({ id: statementId }).whereIn('status', payableList)
              .update({ stripe_payment_intent_id: paymentIntent.id, updated_at: trx.fn.now() });
            if (!reused) throw new Error('Statement is no longer payable');
            return;
          }
          if (activeIntent.status !== 'canceled') {
            // ACH micro-deposit verification lives in `requires_action` too, but
            // it is NOT a stale card intent: the customer chose bank debit, Stripe
            // sent two micro-deposits, and it is waiting (1–2 business days) for
            // them to confirm the amounts — and a returning customer reloads this
            // statement pay page to do the verifying. Canceling would throw away
            // the verification and force them to restart ACH. Treat it as benign
            // in-flight money: never cancel, no operator alert. (Mirrors the
            // single-invoice path in createInvoicePaymentIntent.)
            if (activeIntent.next_action?.type === 'verify_with_microdeposits') {
              const err = new Error('A payment is already in progress for this statement');
              err.statusCode = 409;
              err.inProgress = true;
              err.microdepositPending = true;
              throw err;
            }

            if (SETUP_RECOVERABLE_PI_STATUSES.has(activeIntent.status)) {
              // FAIL CLOSED: if the cancel fails, the old PI may have raced into
              // processing/succeeded — minting a replacement while its client
              // secret can still collect would double-charge. Refuse instead of
              // repointing the statement at a new PI. (ACH micro-deposit
              // verification is handled above; `requires_capture` is excluded from
              // the recoverable set so an authorized hold is never voided here.)
              try {
                await stripe.paymentIntents.cancel(activeIntent.id);
              } catch (e) {
                logger.warn(`[stripe] could not cancel replaceable statement PI ${activeIntent.id}: ${e.message}`);
                const err = new Error('Could not replace the existing payment — please try again in a moment');
                err.statusCode = 409;
                throw err;
              }
            } else {
              // Money genuinely in flight or captured — never cancel. A
              // `processing` ACH debit is benign (inProgress=true → calm bank
              // notice); `succeeded` is an unreconciled-but-captured anomaly that
              // should not be dressed up as benign (inProgress stays false).
              const err = new Error('A payment is already in progress for this statement');
              err.statusCode = 409;
              err.inProgress = activeIntent.status === 'processing';
              throw err;
            }
          }
        }

        const sourceIntent = locked.stripe_payment_intent_id || 'new';
        const idempotencyKey = `statement_pi_${statementId}_${baseCents}_${saveCard ? 'save' : 'nosave'}_${sourceIntent}`;
        paymentIntent = await stripe.paymentIntents.create(piParams, { idempotencyKey });
        if (paymentIntent.status === 'canceled') {
          paymentIntent = await stripe.paymentIntents.create(piParams, { idempotencyKey: `${idempotencyKey}_replacement_${uuidv4()}` });
        }
        if (paymentIntent.status === 'canceled') throw new Error(`Stripe returned canceled PaymentIntent ${paymentIntent.id}`);

        const updated = await trx('payer_statements').where({ id: statementId }).whereIn('status', payableList)
          .update({ stripe_payment_intent_id: paymentIntent.id, updated_at: trx.fn.now() });
        if (!updated) throw new Error('Statement is no longer payable');
      });

      logger.info(`[stripe] Statement PaymentIntent created: ${paymentIntent.id} for statement S-${statementId} (base=$${baseAmount})`);
      return {
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        amount: baseAmount,
        baseAmount,
        cardSurchargeRate: CONFIGURED_COST_BPS / 10_000,
        surchargeRateBps: CONFIGURED_COST_BPS,
      };
    } catch (err) {
      if (err.statusCode) {
        logger.warn(`[stripe] Statement PaymentIntent setup blocked for S-${statementId}: ${err.message}`);
        throw err;
      }
      if (paymentIntent?.id) {
        try {
          const cur = await db('payer_statements').where({ id: statementId }).first();
          if (String(cur?.stripe_payment_intent_id || '') !== String(paymentIntent.id)) {
            await stripe.paymentIntents.cancel(paymentIntent.id);
          }
        } catch (cancelErr) {
          logger.warn(`[stripe] could not cancel unlinked statement PI ${paymentIntent.id}: ${cancelErr.message}`);
        }
      }
      logger.error(`[stripe] Statement PaymentIntent failed for S-${statementId}: ${err.message}`);
      throw new Error(`Failed to create payment intent for statement: ${err.message}`);
    }
  },

  /**
   * Cancel a statement's PaymentIntent if it is still UNCONFIRMED (requires_*),
   * so an admin offline reconcile can't be undercut by the AP confirming the
   * online PI afterward. Throws 409 if the PI is processing/succeeded (real money
   * in flight ⇒ do NOT reconcile offline). No-op when there's no PI / already
   * canceled / Stripe unconfigured.
   */
  async cancelStatementPaymentIntentIfUnconfirmed(statementId) {
    // Load the statement FIRST — only no-op when there is genuinely no PI to
    // verify. If a PI exists but Stripe is unconfigured we CANNOT confirm it's
    // dead, so fail closed (the AP could still confirm the live client secret).
    const statement = await db('payer_statements').where({ id: statementId }).first();
    if (!statement?.stripe_payment_intent_id) return { canceled: false, reason: 'no_pi' };
    const stripe = getStripe();
    if (!stripe) {
      const err = new Error('Cannot verify the existing online payment intent (Stripe unavailable) — try the reconcile again shortly');
      err.statusCode = 409;
      throw err;
    }

    let intent;
    try {
      intent = await stripe.paymentIntents.retrieve(statement.stripe_payment_intent_id);
    } catch (e) {
      // FAIL CLOSED: if we can't verify/cancel the existing PI, the AP's client
      // secret may still be confirmable — recording an offline payment now risks
      // double collection once Stripe recovers. Refuse the reconcile.
      logger.warn(`[stripe] could not retrieve statement PI ${statement.stripe_payment_intent_id}: ${e.message}`);
      const err = new Error('Could not verify the existing online payment intent — try the reconcile again shortly');
      err.statusCode = 409;
      throw err;
    }
    if (intent.status === 'canceled') return { canceled: false, reason: 'already_canceled' };
    if (!REPLACEABLE_PI_STATUSES.has(intent.status)) {
      const err = new Error('An online payment is already in progress for this statement — cannot reconcile offline until it resolves');
      err.statusCode = 409;
      throw err;
    }
    await stripe.paymentIntents.cancel(intent.id);
    logger.info(`[stripe] Canceled unconfirmed statement PI ${intent.id} for S-${statementId} ahead of offline reconcile`);
    return { canceled: true, paymentIntentId: intent.id };
  },

  /** Surcharge quote for a statement payment method (HMAC-signed token → /finalize). */
  async quoteStatementSurcharge(statementId, paymentMethodId) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');
    const { isPayableStatementStatus } = require('./payer-statement-settle');

    const statement = await db('payer_statements').where({ id: statementId }).first();
    if (!statement) throw new Error('Statement not found');
    if (!isPayableStatementStatus(statement.status)) throw new Error('This statement is not payable');

    let pm;
    try { pm = await stripe.paymentMethods.retrieve(paymentMethodId); }
    catch (err) { throw new Error(`Could not retrieve payment method: ${err.message}`); }

    const methodType = pm.type || 'card';
    const funding = pm.card?.funding || null;
    const baseAmount = parseFloat(statement.total);
    const { baseCents, surchargeCents, totalCents, rateBps } = computeChargeAmount(baseAmount, methodType, { funding });

    const crypto = require('crypto');
    const hmacSecret = process.env.JWT_SECRET;
    if (!hmacSecret) throw new Error('JWT_SECRET is required for surcharge quote signing');
    const payloadJson = JSON.stringify({ statementId, paymentMethodId, statementTotal: baseAmount, quotedAt: Date.now() });
    const signature = crypto.createHmac('sha256', hmacSecret).update(payloadJson).digest('base64url');
    const quoteToken = `${Buffer.from(payloadJson).toString('base64url')}.${signature}`;

    return { quoteToken, base: baseCents / 100, surcharge: surchargeCents / 100, total: totalCents / 100, rateBps, funding, methodType };
  },

  /** Finalize a statement payment: apply surcharge from the quote to the PI, confirm. */
  async finalizeStatementPayment(statementId, quoteToken, opts = {}) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');
    const { isPayableStatementStatus } = require('./payer-statement-settle');

    const crypto = require('crypto');
    const hmacSecret = process.env.JWT_SECRET;
    if (!hmacSecret) throw new Error('JWT_SECRET is required for surcharge quote signing');
    let quote;
    try {
      const [payloadPart, sigPart] = quoteToken.split('.');
      if (!payloadPart || !sigPart) throw new Error('malformed');
      const expectedSig = crypto.createHmac('sha256', hmacSecret).update(Buffer.from(payloadPart, 'base64url').toString()).digest('base64url');
      if (sigPart !== expectedSig) throw new Error('signature mismatch');
      quote = JSON.parse(Buffer.from(payloadPart, 'base64url').toString());
    } catch { throw new Error('Invalid or tampered quote token'); }

    if (String(quote.statementId) !== String(statementId)) throw new Error('Quote token does not match this statement');
    if (Date.now() - (quote.quotedAt || 0) > 10 * 60 * 1000) throw new Error('Quote expired — please try again');

    const statement = await db('payer_statements').where({ id: statementId }).first();
    if (!statement) throw new Error('Statement not found');
    if (!isPayableStatementStatus(statement.status)) throw new Error('This statement is not payable');
    if (!statement.stripe_payment_intent_id) throw new Error('Statement has no active PaymentIntent');

    const pm = await stripe.paymentMethods.retrieve(quote.paymentMethodId);
    const funding = pm.card?.funding || null;
    const baseAmount = parseFloat(statement.total);
    if (quote.statementTotal != null && Math.abs(baseAmount - quote.statementTotal) > 0.01) {
      throw new Error('Statement total changed since quote was created. Please request a new quote.');
    }

    const { baseCents, surchargeCents, totalCents, rateBps, policyVersion } = computeChargeAmount(baseAmount, pm.type || 'card', { funding });
    const surchargeDetails = buildSurchargeAmountDetails(surchargeCents);
    const usePreview = !!surchargeDetails;
    const saveCard = !!opts.saveCard;

    const updateParams = {
      amount: totalCents,
      payment_method: quote.paymentMethodId,
      metadata: {
        waves_statement_id: String(statementId),
        waves_payer_id: String(statement.payer_id),
        base_amount: String(baseCents / 100),
        card_surcharge: String(surchargeCents / 100),
        surcharge_rate_bps: String(rateBps),
        surcharge_policy_version: policyVersion,
        card_funding: funding || 'unknown',
        save_card_opt_in: saveCard ? 'true' : 'false',
      },
      setup_future_usage: saveCard ? 'off_session' : '',
    };
    if (surchargeDetails) updateParams.amount_details = surchargeDetails;

    try {
      await stripe.paymentIntents.update(statement.stripe_payment_intent_id, updateParams, usePreview ? { apiVersion: SURCHARGE_API_VERSION } : undefined);
      const confirmed = await stripe.paymentIntents.confirm(statement.stripe_payment_intent_id, {}, usePreview ? { apiVersion: SURCHARGE_API_VERSION } : undefined);
      logger.info(`[stripe] Finalized statement S-${statementId}: funding=${funding} surcharge=${surchargeCents}c total=${totalCents}c PI=${confirmed.id} status=${confirmed.status}`);
      return {
        paymentIntentId: confirmed.id,
        paymentMethodId: quote.paymentMethodId,
        clientSecret: confirmed.client_secret,
        status: confirmed.status,
        requiresAction: confirmed.status === 'requires_action',
        base: baseCents / 100,
        surcharge: surchargeCents / 100,
        total: totalCents / 100,
        rateBps,
        funding,
      };
    } catch (err) {
      logger.error(`[stripe] Finalize failed for statement PI ${statement.stripe_payment_intent_id}: ${err.message}`);
      throw new Error(`Failed to finalize statement payment: ${err.message}`);
    }
  },

  // =========================================================================
  // CONFIRM INVOICE PAYMENT
  // =========================================================================

  /**
   * After the frontend confirms a PaymentIntent on the pay page,
   * call this to mark the invoice as paid and record the payment.
   * @param {string} invoiceId — Waves invoice UUID
   * @param {string} paymentIntentId — Stripe pi_xxx ID
   * @returns {object} payment record
   */
  async confirmInvoicePayment(invoiceId, paymentIntentId) {
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe not configured');

    const invoice = await db('invoices').where({ id: invoiceId }).first();
    if (!invoice) throw new Error('Invoice not found');
    // Phase 2: an accrued invoice is collected ONLY via its consolidated
    // statement — never confirm an individual payment for it.
    if (invoice.payer_statement_id) {
      throw new Error('Invoice is billed on the payer’s monthly statement — pay the statement, not the individual invoice');
    }
    if (['void', 'refunded', 'canceled', 'cancelled'].includes(String(invoice.status || '').toLowerCase())) {
      assertInvoiceCollectible(invoice.status);
    }
    if (invoice.status === 'paid') {
      const existingPayment = await db('payments')
        .where({ stripe_payment_intent_id: paymentIntentId })
        .orderBy('created_at', 'desc')
        .first();
      if (existingPayment) return existingPayment;
      throw new Error('Invoice already paid');
    }
    if (invoice.status === 'prepaid') {
      throw new Error('Invoice is already prepaid');
    }
    if (invoice.status === 'processing'
      && String(invoice.stripe_payment_intent_id || '') !== String(paymentIntentId)) {
      throw new Error('Bank payment is already processing');
    }
    if (invoice.stripe_payment_intent_id
      && String(invoice.stripe_payment_intent_id) !== String(paymentIntentId)) {
      throw new Error('Invoice has a different active payment');
    }

    try {
      // Retrieve the PI to verify it succeeded
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId);

      // Bind PI ↔ invoice via the metadata that createInvoicePaymentIntent
      // wrote at mint time. Without this check, a caller who knows another
      // invoice's token can submit a successful PI from a DIFFERENT
      // invoice and mark THIS invoice paid — Invoice A would settle
      // against Invoice B's actual charge, with both rows pointing at the
      // same PI. createInvoicePaymentIntent always sets waves_invoice_id;
      // a missing-metadata PI cannot belong to this flow.
      const piInvoiceId = pi.metadata?.waves_invoice_id;
      if (!piInvoiceId || String(piInvoiceId) !== String(invoiceId)) {
        logger.warn(
          `[stripe] confirmInvoicePayment refused — PI ${paymentIntentId} ` +
          `metadata.waves_invoice_id=${piInvoiceId || 'null'} does not match invoice ${invoiceId}`,
        );
        throw new Error('PaymentIntent does not belong to this invoice');
      }

      const charge = pi.latest_charge;
      let receiptUrl = null;
      let cardBrand = null;
      let cardLastFour = null;
      // Derive payment_method from the actual charge details rather than
      // hardcoding 'card' — an ACH (us_bank_account) confirm used to land
      // on the invoice as payment_method='card', which leaked the wrong
      // tender into receipts and downstream reporting.
      let resolvedPaymentMethod = pi.payment_method_types?.[0] || 'card';
      let bankLastFour = null;
      let pmdType = null;

      // Get receipt and card info from the charge
      if (charge) {
        try {
          const chargeObj = typeof charge === 'string'
            ? await stripe.charges.retrieve(charge)
            : charge;
          receiptUrl = chargeObj.receipt_url || null;
          const pmd = chargeObj.payment_method_details;
          pmdType = pmd?.type || null;
          if (pmd?.card) {
            resolvedPaymentMethod = 'card';
            cardBrand = pmd.card.brand?.toUpperCase();
            cardLastFour = pmd.card.last4;
          } else if (pmd?.us_bank_account) {
            resolvedPaymentMethod = 'us_bank_account';
            bankLastFour = pmd.us_bank_account.last4 || null;
          } else if (pmd?.type) {
            resolvedPaymentMethod = pmd.type;
          }
        } catch {
          // Non-critical — continue without receipt details
        }
      }

      // ACH PaymentIntents commonly move to `processing` after the customer
      // completes bank-account confirmation. There is no charge receipt yet,
      // but the PaymentMethod can still give us tender type + last four.
      if (!pmdType && pi.payment_method) {
        try {
          const pm = typeof pi.payment_method === 'string'
            ? await stripe.paymentMethods.retrieve(pi.payment_method)
            : pi.payment_method;
          pmdType = pm?.type || null;
          if (pm?.card) {
            resolvedPaymentMethod = 'card';
            cardBrand = pm.card.brand?.toUpperCase();
            cardLastFour = pm.card.last4;
          } else if (pm?.us_bank_account) {
            resolvedPaymentMethod = 'us_bank_account';
            bankLastFour = pm.us_bank_account.last4 || null;
          } else if (pm?.type) {
            resolvedPaymentMethod = pm.type;
          }
        } catch {
          // Non-critical — status classification can still use PI metadata.
        }
      }

      // Check for card payments that bypassed the /quote+/finalize surcharge flow.
      // Express Checkout (wallets) are allowed at base-only (phase 1).
      // The surcharge_policy_version metadata is set by /finalize. Older
      // already-surcharged PIs may lack that key, so allow a positive recorded
      // surcharge before treating the payment as a bypass.
      const isCardFamily = pmdType && pmdType !== 'us_bank_account' && pmdType !== 'ach';
      const wasFinalized = pi.metadata?.surcharge_policy_version;
      const recordedSurchargeCents = Math.max(
        Math.round(Number(pi.metadata?.card_surcharge || 0) * 100),
        Number(pi.amount_details?.surcharge?.amount || 0),
      );
      const surchargeAlreadyApplied = recordedSurchargeCents > 0;
      if (isCardFamily && !wasFinalized && !surchargeAlreadyApplied) {
        // Card payment without surcharge_policy_version = bypassed /finalize.
        // Don't block (payment already succeeded at Stripe), but check if it's
        // a credit card that should have been surcharged.
        let pmFunding = null;
        let isWalletPM = false;
        let pmLookupFailed = false;
        try {
          const pmId = typeof pi.payment_method === 'string' ? pi.payment_method : pi.payment_method?.id;
          if (pmId) {
            const pmObj = await stripe.paymentMethods.retrieve(pmId);
            pmFunding = pmObj.card?.funding || null;
            isWalletPM = !!pmObj.card?.wallet;
          }
        } catch (pmErr) {
          pmLookupFailed = true;
          logger.error(`[stripe] PM lookup failed for bypass check on PI ${paymentIntentId}: ${pmErr.message}`);
        }

        if (pmFunding === 'credit' && !isWalletPM) {
          logger.error(
            `[stripe] Card payment on PI ${paymentIntentId} bypassed /finalize. ` +
            `Invoice ${invoice.invoice_number}. Blocking confirm — customer must use /quote+/finalize.`,
          );
          try {
            await db('customer_health_alerts').insert({
              customer_id: invoice.customer_id,
              alert_type: 'surcharge_bypass_blocked',
              severity: 'medium',
              title: `Surcharge bypass blocked — invoice ${invoice.invoice_number}`,
              description: `Credit card confirm attempt without surcharge finalization. PI: ${paymentIntentId}. Customer redirected to retry.`,
              // customer_health_alerts has trigger_data, not metadata — the old
              // column name made these alerts silently fail to insert.
              trigger_data: JSON.stringify({
                stripe_payment_intent_id: paymentIntentId,
                card_funding: pmFunding,
              }),
            });
          } catch (alertErr) {
            logger.error(`[stripe] Bypass-blocked alert insert failed: ${alertErr.message}`);
          }
          const err = new Error('Payment requires surcharge finalization. Please refresh and try again.');
          err.code = 'SURCHARGE_NOT_FINALIZED';
          throw err;
        } else if (pmFunding === 'credit' && isWalletPM) {
          logger.info(
            `[stripe] Wallet credit card on PI ${paymentIntentId} confirmed at base-only ` +
            `(Express Checkout, phase 1). Invoice ${invoice.invoice_number}.`,
          );
        } else if (pmLookupFailed) {
          logger.error(
            `[stripe] FAIL-CLOSED: Could not determine funding for unfinalized card PI ${paymentIntentId}. ` +
            `Invoice ${invoice.invoice_number}. Blocking confirm — customer must retry through /quote+/finalize.`,
          );
          try {
            await db('customer_health_alerts').insert({
              customer_id: invoice.customer_id,
              // alert_type is varchar(30) — 'surcharge_bypass_unknown_funding'
              // (32 chars) overflowed and made the insert silently fail.
              alert_type: 'surcharge_unknown_funding',
              severity: 'high',
              title: `Unknown funding on unfinalized card — invoice ${invoice.invoice_number}`,
              description: `Card payment confirmed without /finalize and PM funding lookup failed. PI: ${paymentIntentId}. May be under-collected.`,
              trigger_data: JSON.stringify({
                stripe_payment_intent_id: paymentIntentId,
              }),
            });
          } catch (alertErr) {
            logger.error(`[stripe] Unknown-funding alert insert failed: ${alertErr.message}`);
          }
          const err = new Error('Payment requires surcharge verification. Please refresh and try again.');
          err.code = 'SURCHARGE_FUNDING_UNKNOWN';
          throw err;
        } else {
          logger.info(
            `[stripe] Non-credit card (${pmFunding || 'unknown'}) on PI ${paymentIntentId} ` +
            `confirmed without /finalize — no surcharge expected. Invoice ${invoice.invoice_number}.`,
          );
        }
      }

      const actualMethodType = pmdType || resolvedPaymentMethod;
      // Tender match prices from amount due (total − applied credit), not raw total.
      const invoiceBaseAmount = invoiceAmountDue(invoice);
      assertInvoicePaymentIntentTenderMatches(pi, actualMethodType, invoiceBaseAmount);

      const paymentStatus = invoicePaymentStatusForIntent(pi, actualMethodType);
      const invoiceStatus = paymentStatus === 'paid' ? 'paid' : 'processing';

      // Defense-in-depth surcharge-bypass detection. The
      // payment_method_types lock at /update-amount time is the primary
      // defense — Stripe rejects a confirm with the wrong method family.
      // If somehow a charge succeeds for less than the expected amount
      // for its actual method (Stripe API drift, a race with the lock,
      // a flow we haven't anticipated), the charge is already settled
      // and we can't unwind it cheaply. Log critical + create a health
      // alert so an operator can decide whether to follow up.
      if (paymentStatus === 'paid' && pmdType) {
        // Compare against the surcharge policy stored on the PI at charge time,
        // not a fresh recompute — the pay page may have intentionally charged
        // differently (no surcharge for debit, base-only for express checkout).
        const metaBase = Math.round(Number(pi.metadata?.base_amount || invoice.total) * 100);
        const metaSurcharge = Math.round(Number(pi.metadata?.card_surcharge || 0) * 100);
        // If metadata shows 0 surcharge but PM is credit card, re-derive expected
        // surcharge — the PI may have bypassed /finalize.
        let expectedSurcharge = metaSurcharge;
        if (metaSurcharge === 0 && pmdType && pmdType !== 'us_bank_account' && pmdType !== 'ach') {
          let pmFunding = pi.metadata?.card_funding || null;
          let isWalletBypass = false;
          if (!pmFunding) {
            try {
              const pmId = typeof pi.payment_method === 'string' ? pi.payment_method : pi.payment_method?.id;
              if (pmId) {
                const pmObj = await stripe.paymentMethods.retrieve(pmId);
                pmFunding = pmObj.card?.funding || null;
                isWalletBypass = !!pmObj.card?.wallet;
              }
            } catch { /* non-fatal */ }
          }
          if (pmFunding === 'credit' && !isWalletBypass) {
            const { computeSurchargeCents } = require('./stripe-pricing');
            expectedSurcharge = computeSurchargeCents(metaBase);
          }
        }
        const expectedCents = metaBase + expectedSurcharge;
        const actualCents = Number(pi.amount) || 0;
        if (actualCents + 1 < expectedCents) {  // 1-cent tolerance for rounding
          logger.error(
            `[stripe] CRITICAL: Surcharge-bypass detected on PI ${paymentIntentId}. ` +
            `Method=${pmdType}, expected=$${(expectedCents / 100).toFixed(2)} (${expectedCents}c), ` +
            `actual=$${(actualCents / 100).toFixed(2)} (${actualCents}c). Invoice ${invoice.invoice_number}.`,
          );
          try {
            await db('customer_health_alerts').insert({
              customer_id: invoice.customer_id,
              alert_type: 'stripe_surcharge_bypass',
              severity: 'high',
              title: `Surcharge bypass detected — invoice ${invoice.invoice_number}`,
              description: `Customer paid $${(actualCents / 100).toFixed(2)} via ${pmdType}, expected $${(expectedCents / 100).toFixed(2)} (surcharge shortfall). PI: ${paymentIntentId}.`,
              trigger_data: JSON.stringify({
                stripe_payment_intent_id: paymentIntentId,
                method: pmdType,
                expected_total: expectedCents / 100,
                actual_total: actualCents / 100,
                shortfall: (expectedCents - actualCents) / 100,
              }),
            });
          } catch (alertErr) {
            logger.error(`[stripe] Surcharge-bypass alert insert failed: ${alertErr.message}`);
          }
        }
      }

      const chargedCents = Number(pi.amount_received || pi.amount || 0);
      const chargedTotal = chargedCents > 0
        ? Math.round((chargedCents / 100) * 100) / 100
        : parseFloat(invoice.total);
      const metadataBaseAmount = Number(pi.metadata?.base_amount ?? invoice.total);
      const metadataCardSurcharge = Number(pi.metadata?.card_surcharge ?? 0);

      // Update invoice + record payment atomically
      const paymentRecord = await db.transaction(async trx => {
        await trx.raw(
          'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
          ['stripe.pi.payment', String(paymentIntentId)],
        );

        const lockedInvoice = await trx('invoices')
          .where({ id: invoiceId })
          .forUpdate()
          .first();
        if (!lockedInvoice) throw new Error('Invoice not found');
        if (['void', 'refunded', 'canceled', 'cancelled'].includes(String(lockedInvoice.status || '').toLowerCase())) {
          assertInvoiceCollectible(lockedInvoice.status);
        }
        if (lockedInvoice.status === 'paid') {
          const existingPayment = await trx('payments')
            .where({ stripe_payment_intent_id: paymentIntentId })
            .orderBy('created_at', 'desc')
            .first();
          if (existingPayment) return existingPayment;
          throw new Error('Invoice already paid');
        }
        if (lockedInvoice.status === 'prepaid') {
          throw new Error('Invoice is already prepaid');
        }
        if (lockedInvoice.status === 'processing'
          && String(lockedInvoice.stripe_payment_intent_id || '') !== String(paymentIntentId)) {
          throw new Error('Bank payment is already processing');
        }
        if (lockedInvoice.stripe_payment_intent_id
          && String(lockedInvoice.stripe_payment_intent_id) !== String(paymentIntentId)) {
          throw new Error('Invoice has a different active payment');
        }
        // Dispute guard (mirrors the webhook succeeded-handler): after a
        // chargeback the payments row is 'disputed', the invoice is reopened
        // 'overdue', and its PI is cleared — so a replayed /confirm with the old
        // PI id passes every guard above (the PI still retrieves 'succeeded' at
        // Stripe). Without this check it would flip the charged-back invoice
        // back to paid, kill dunning, and overwrite the disputed row — erasing
        // dispute_id/dispute_final, which also neutralizes the webhook's own
        // late-replay guards. The money already went back via the chargeback:
        // 'disputed' is terminal for this PI, refuse to settle on it.
        const disputedRow = await trx('payments')
          .where({ stripe_payment_intent_id: paymentIntentId, status: 'disputed' })
          .first('id');
        if (disputedRow) {
          throw new Error('This payment was disputed after it succeeded — the invoice cannot be re-marked paid from the old payment session');
        }
        if (paymentStatus === 'processing') {
          // Expected ACH amount prices from amount due (total − applied credit).
          const expected = computeChargeAmount(invoiceAmountDue(lockedInvoice), resolvedPaymentMethod);
          const expectedCents = Math.round(expected.total * 100);
          const actualCents = Number(pi.amount_received || pi.amount || 0);
          if (actualCents !== expectedCents) {
            logger.error(
              `[stripe] ACH processing amount mismatch on PI ${paymentIntentId}. ` +
              `Expected ${expectedCents}c from invoice ${lockedInvoice.id}; got ${actualCents}c.`,
            );
            try {
              await stripe.paymentIntents.cancel(paymentIntentId);
            } catch (cancelErr) {
              logger.warn(`[stripe] Could not cancel mismatched processing PI ${paymentIntentId}: ${cancelErr.message}`);
            }
            throw new Error('Payment amount no longer matches this invoice. Please refresh and try again.');
          }
        }

        const invoiceUpdates = {
          status: invoiceStatus,
          processor: 'stripe',
          stripe_payment_intent_id: paymentIntentId,
          stripe_charge_id: typeof charge === 'string' ? charge : null,
          payment_method: resolvedPaymentMethod,
          card_brand: cardBrand,
          // For card payments this is the card last4; for ACH we store
          // the bank-account last4 in the same column so the receipt
          // template can render "Bank •1234" via {card_line}.
          card_last_four: cardLastFour || bankLastFour,
          receipt_url: receiptUrl,
          // chargedTotal is the CASH taken (amount due + surcharge). Add back any
          // applied account credit so the invoice keeps its real total (credit +
          // cash) — without this, total would collapse to the reduced cash amount
          // and the credit_applied math (amount due) would double-count.
          total: Math.round((chargedTotal + (Number(lockedInvoice.credit_applied) || 0)) * 100) / 100,
        };
        if (paymentStatus === 'paid') {
          invoiceUpdates.paid_at = new Date().toISOString();
        }

        const invoiceRowsUpdated = await trx('invoices')
          .where({ id: invoiceId })
          .whereNotIn('status', ['paid', 'void', 'refunded', 'canceled', 'cancelled'])
          .where(function activePaymentIntentGuard() {
            this.whereNull('stripe_payment_intent_id')
              .orWhere({ stripe_payment_intent_id: paymentIntentId });
          })
          .update(invoiceUpdates);
        if (!invoiceRowsUpdated) {
          throw new Error('Invoice has a different active payment');
        }

        const paymentPayload = {
          customer_id: invoice.customer_id,
          processor: 'stripe',
          stripe_payment_intent_id: paymentIntentId,
          stripe_charge_id: typeof charge === 'string' ? charge : null,
          payment_date: etDateString(),
          amount: chargedTotal,
          base_amount_cents: Math.round(Number(pi.metadata?.base_amount || invoice.total) * 100),
          surcharge_amount_cents: Math.round(Number(pi.metadata?.card_surcharge || 0) * 100),
          surcharge_rate_bps: Number(pi.metadata?.surcharge_rate_bps || 0),
          surcharge_policy_version: pi.metadata?.surcharge_policy_version || null,
          card_funding: pi.metadata?.card_funding || null,
          card_brand: cardBrand || null,
          status: paymentStatus,
          description: paymentStatus === 'processing'
            ? `Invoice ${invoice.invoice_number} (bank payment pending)`
            : metadataCardSurcharge > 0
            ? `Invoice ${invoice.invoice_number} (includes $${metadataCardSurcharge.toFixed(2)} credit card surcharge)`
            : `Invoice ${invoice.invoice_number}`,
          metadata: JSON.stringify({
            invoice_id: invoiceId,
            stripe_receipt_url: receiptUrl,
            base_amount: metadataBaseAmount,
            card_surcharge: metadataCardSurcharge,
            charged_amount: chargedTotal,
            payment_method: resolvedPaymentMethod,
            payment_state: paymentStatus,
          }),
        };

        if (receiptUrl) paymentPayload.receipt_url = receiptUrl;
        if (cardLastFour || bankLastFour) paymentPayload.card_last_four = cardLastFour || bankLastFour;

        const existingPayment = await trx('payments')
          .where({ stripe_payment_intent_id: paymentIntentId })
          .orderBy('created_at', 'desc')
          .first();
        if (existingPayment) {
          // Never clobber a money-LEFT row: refunded/disputed rows record cash
          // that went back to the customer. A miss here means the row flipped
          // to one of those between the dispute pre-check above and this write
          // (a dispute/refund webhook landing mid-flight) — THROW so the whole
          // transaction rolls back, including the invoice update above;
          // returning would let /confirm settle the invoice as paid beside a
          // row recording that the money just left. A 'paid' row is the
          // OPPOSITE case and passes through deliberately: the webhook writes
          // the payments row before it settles the invoice, so /confirm racing
          // (or repairing after) a half-applied webhook must still be able to
          // mark the open invoice paid — money genuinely arrived (Codex P2).
          const [record] = await trx('payments')
            .where({ id: existingPayment.id })
            .whereNotIn('status', ['refunded', 'disputed'])
            .update(paymentPayload)
            .returning('*');
          if (!record) {
            throw new Error('Payment record changed while confirming — refresh the invoice and try again');
          }
          return record;
        }

        const [record] = await trx('payments').insert(paymentPayload).returning('*');

        return record;
      });

      logger.info(`[stripe] Invoice ${invoice.invoice_number} ${paymentStatus} via Stripe PI: ${paymentIntentId}`);

      // Stop the automated follow-up sequence + send thank-you if we nagged.
      if (paymentStatus === 'paid') {
        try {
          await require('./invoice-followups').stopOnPayment(invoiceId);
        } catch (e) {
          logger.error(`[invoice-followups] stopOnPayment (stripe confirm) failed: ${e.message}`);
        }
        try {
          await require('./annual-prepay-renewals').syncTermForInvoicePayment({
            id: invoiceId,
            status: 'paid',
            paid_at: new Date().toISOString(),
          });
        } catch (e) {
          logger.error(`[annual-prepay] activation failed for invoice ${invoiceId}: ${e.message}`);
        }
      }

      return paymentRecord;
    } catch (err) {
      logger.error(`[stripe] Confirm invoice payment failed: ${err.message}`, { stack: err.stack });
      // Map Stripe decline_codes to friendly customer-facing messages.
      const friendly = friendlyStripeError(err);
      throw new Error(friendly);
    }
  },
};

// Map Stripe error codes/decline_codes to friendly customer-facing messages.
// Raw Stripe error messages are logged server-side, never returned to the customer.
// Accepts either a thrown Stripe error (`err.code` / `err.raw.code`) or a
// PaymentIntent `last_payment_error` object (`code` / `decline_code` at top
// level) — same shape for our purposes.
function friendlyStripeError(err) {
  const declineCode = err?.decline_code || err?.raw?.decline_code;
  const code = err?.code || err?.raw?.code;
  const map = {
    card_declined: 'Your card was declined. Please try another payment method.',
    insufficient_funds: 'Insufficient funds. Please use a different card.',
    expired_card: 'This card has expired. Please use a different card.',
    incorrect_cvc: 'The security code (CVC) is incorrect.',
    processing_error: 'A processing error occurred. Please try again.',
    incorrect_number: 'The card number is incorrect.',
    authentication_required: 'Your bank requires additional authentication. Please retry.',
    payment_intent_authentication_failure: 'Card authentication failed. Please retry or use a different card.',
  };
  return map[declineCode] || map[code] || 'We could not process your payment. Please try again or use a different payment method.';
}

module.exports = StripeService;
module.exports.friendlyStripeError = friendlyStripeError;
module.exports.isAmbiguousStripeChargeError = isAmbiguousStripeChargeError;
module.exports.assertNoInvoiceChargeReconciliationPending = assertNoInvoiceChargeReconciliationPending;
module.exports.claimInvoiceSavedCardCharge = claimInvoiceSavedCardCharge;
module.exports.markInvoiceSavedCardChargeAttempt = markInvoiceSavedCardChargeAttempt;
module.exports.commitInvoiceSavedCardChargeSubmission = commitInvoiceSavedCardChargeSubmission;
module.exports.parkInvoiceForSavedCardReconciliation = parkInvoiceForSavedCardReconciliation;
module.exports.savedCardChargeNeedsReconciliation = savedCardChargeNeedsReconciliation;
module.exports.savedCardChargeSuppressesAlternateCollection = savedCardChargeSuppressesAlternateCollection;
module.exports.savedCardClaimIsStale = savedCardClaimIsStale;
module.exports.promoteStaleSavedCardClaim = promoteStaleSavedCardClaim;
module.exports.shouldTreatSavedCardFailureAsAmbiguous = shouldTreatSavedCardFailureAsAmbiguous;
module.exports.persistSavedCardChargeCreditDelta = persistSavedCardChargeCreditDelta;
module.exports.resolveSettledInvoiceSavedCardChargeAttempt = resolveSettledInvoiceSavedCardChargeAttempt;
module.exports.resolveFailedInvoiceSavedCardChargeAttempt = resolveFailedInvoiceSavedCardChargeAttempt;
module.exports.resolveNoFundsSavedCardChargeAttempt = resolveNoFundsSavedCardChargeAttempt;
module.exports.savedCardAttemptOutcome = savedCardAttemptOutcome;
