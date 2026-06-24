/**
 * One-time card-on-file holds.
 *
 * A commitment device for ONE-TIME visits that is deliberately different from
 * estimate-deposits: instead of charging money at booking, the customer saves
 * a card (Stripe SetupIntent, $0 captured) to RESERVE the appointment. The
 * saved card is then charged the FINAL service total on completion, and a flat
 * no-show / late-cancel fee applies ONLY if the customer cancels inside the
 * window or isn't home for the visit. Nothing is taken up front.
 *
 * Policy (owner decision 2026-06-24): one-time accepts REQUIRE a card hold —
 * card-on-file is how you book — EXCEPT invoice-mode estimates (admin opted
 * into bill-by-invoice) and prepay choices (one-time can't prepay anyway). The
 * no-show fee is a FLAT amount ($49, pricing_config-authoritative via
 * `estimate_card_hold`), never a percentage: its job is commitment, not
 * proportional collection.
 *
 * DARK BY DEFAULT: enforced only when ONE_TIME_CARD_HOLD=true (rollout: ship
 * dark → land the capture UI → flip). The amounts are FROZEN onto the hold row
 * at agreement time so a later constants/pricing_config change never moves a
 * fee a customer already consented to.
 *
 * Trust boundary (mirrors estimate-deposits): the accept gate never believes
 * the client. A card hold counts only when the named SetupIntent is retrieved
 * LIVE from Stripe, reports `succeeded`, carries a saved payment_method, and
 * its metadata pins it to THIS estimate.
 *
 * Status flow: pending (intent minted) → held (card captured + estimate
 * accepted) → charged_completion / charged_no_show / released / failed.
 */

const db = require('../models/db');
const logger = require('./logger');
const StripeService = require('./stripe');
const { CARD_HOLD } = require('./pricing-engine/constants');

function isCardHoldEnabled() {
  const flag = process.env.ONE_TIME_CARD_HOLD;
  return flag === '1' || flag === 'true' || flag === 'on';
}

// Flat fee + window, pricing_config-authoritative (db-bridge overlays CARD_HOLD
// from the `estimate_card_hold` row), with hard fallbacks if a row is missing.
function cardHoldNoShowFee() {
  const amount = Number(CARD_HOLD.noShowFeeAmount);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : 49;
}
function cardHoldCancelWindowHours() {
  const hours = Number(CARD_HOLD.cancelWindowHours);
  return Number.isFinite(hours) && hours > 0 ? Math.round(hours) : 24;
}

// What acceptance requires for this estimate. A card hold is required for a
// one-time accept while the feature is enabled, UNLESS the estimate is
// invoice-mode (its own billing path) or the customer chose prepay (recurring
// only). recurring accepts never use a card hold — they keep deposits / invoice
// links. Returns { enforced, required }.
function resolveCardHoldPolicy({ treatAsOneTime = false, billByInvoice = false, paymentMethodPreference = null } = {}) {
  if (!isCardHoldEnabled()) {
    return { enforced: false, required: false, exemptReason: 'feature_disabled' };
  }
  if (!treatAsOneTime) {
    return { enforced: true, required: false, exemptReason: 'recurring' };
  }
  if (billByInvoice) {
    return { enforced: true, required: false, exemptReason: 'invoice_mode' };
  }
  if (paymentMethodPreference === 'prepay_annual') {
    return { enforced: true, required: false, exemptReason: 'prepay_annual' };
  }
  return {
    enforced: true,
    required: true,
    exemptReason: null,
    noShowFeeAmount: cardHoldNoShowFee(),
    cancelWindowHours: cardHoldCancelWindowHours(),
  };
}

// Count existing hold rows for an estimate — used to salt the SetupIntent
// idempotency key so a fresh capture attempt mints a new intent instead of
// replaying a superseded one inside Stripe's idempotency window.
async function holdGeneration(estimateId) {
  const row = await db('estimate_card_holds')
    .where({ estimate_id: estimateId })
    .count({ n: '*' })
    .first();
  return Number(row?.n || 0);
}

// Mint (or reuse) the SetupIntent that captures the hold card for an estimate,
// tracking a `pending` row. Reuses a live, still-confirmable pending intent so
// reopening the capture step doesn't stack intents; otherwise mints a fresh one
// (generation-salted) and inserts a new pending row. Returns
// { clientSecret, setupIntentId, noShowFeeAmount, cancelWindowHours } for the
// capture UI, or null when Stripe isn't configured.
async function createCardHoldSetupIntentForEstimate(estimate) {
  const pending = await db('estimate_card_holds')
    .where({ estimate_id: estimate.id, status: 'pending' })
    .orderBy('created_at', 'desc')
    .first();

  if (pending?.stripe_setup_intent_id) {
    try {
      const existing = await StripeService.retrieveSetupIntent(pending.stripe_setup_intent_id);
      // Reusable while the card hasn't been captured yet. A succeeded/canceled
      // intent is terminal — fall through and mint a fresh one.
      if (existing && ['requires_payment_method', 'requires_confirmation', 'requires_action', 'processing'].includes(existing.status)) {
        await db('estimate_card_holds').where({ id: pending.id }).update({ updated_at: db.fn.now() });
        return {
          clientSecret: existing.client_secret,
          setupIntentId: existing.id,
          noShowFeeAmount: cardHoldNoShowFee(),
          cancelWindowHours: cardHoldCancelWindowHours(),
        };
      }
    } catch (err) {
      logger.warn('[estimate-card-holds] reuse of pending SetupIntent failed — minting fresh', { error: err.message });
    }
  }

  const generation = await holdGeneration(estimate.id);
  const setupIntent = await StripeService.createEstimateCardHoldSetupIntent({ estimateId: estimate.id, generation });
  if (!setupIntent) return null;

  await db('estimate_card_holds')
    .insert({
      estimate_id: estimate.id,
      customer_id: estimate.customer_id || null,
      stripe_setup_intent_id: setupIntent.id,
      no_show_fee_amount: cardHoldNoShowFee(),
      cancel_window_hours: cardHoldCancelWindowHours(),
      status: 'pending',
      updated_at: db.fn.now(),
    })
    .onConflict('stripe_setup_intent_id')
    .merge({ updated_at: db.fn.now() });

  return {
    clientSecret: setupIntent.client_secret,
    setupIntentId: setupIntent.id,
    noShowFeeAmount: cardHoldNoShowFee(),
    cancelWindowHours: cardHoldCancelWindowHours(),
  };
}

// A live-retrieved SetupIntent counts only when Stripe says it succeeded, it
// carries a saved payment_method, AND its metadata pins it to THIS estimate.
function cardHoldIntentMatchesEstimate(setupIntent, estimateId) {
  return !!setupIntent
    && setupIntent.status === 'succeeded'
    && setupIntent.metadata?.purpose === 'estimate_card_hold'
    && String(setupIntent.metadata?.estimate_id) === String(estimateId)
    && !!setupIntent.payment_method;
}

// Whether THIS estimate already has a captured ('held') hold — lets the accept
// gate be satisfied by a webhook-recorded capture even if the client didn't
// echo the setupIntentId back.
async function hasHeldCard(estimateId) {
  const row = await db('estimate_card_holds')
    .where({ estimate_id: estimateId, status: 'held' })
    .first('id', 'stripe_payment_method_id', 'stripe_setup_intent_id');
  return row || null;
}

// Accept GATE (pre-commit): live-verify the named SetupIntent WITHOUT writing.
// Returns { ok, paymentMethodId, setupIntentId } so the accept handler can
// reject a one-time accept that has no captured card before the transaction
// commits. Trust is re-derived from Stripe, never the client. Already-held
// cards (webhook beat the client, or a retry) satisfy the gate directly.
async function verifyCardHoldIntent({ estimate, setupIntentId }) {
  const held = await hasHeldCard(estimate.id);
  if (held?.stripe_payment_method_id) {
    return {
      ok: true,
      paymentMethodId: held.stripe_payment_method_id,
      setupIntentId: held.stripe_setup_intent_id || setupIntentId || null,
      alreadyHeld: true,
    };
  }
  if (!setupIntentId) return { ok: false, reason: 'no_setup_intent' };
  let setupIntent = null;
  try {
    setupIntent = await StripeService.retrieveSetupIntent(setupIntentId);
  } catch (err) {
    logger.warn('[estimate-card-holds] live SetupIntent verification failed', { error: err.message });
    return { ok: false, reason: 'verification_failed' };
  }
  if (!cardHoldIntentMatchesEstimate(setupIntent, estimate.id)) {
    return { ok: false, reason: 'intent_mismatch' };
  }
  return { ok: true, paymentMethodId: setupIntent.payment_method, setupIntentId: setupIntent.id };
}

// In-transaction DB upsert advancing the hold to 'held', pinned to the customer
// + booked appointment with FROZEN terms — runs inside the accept transaction
// so the hold row lands atomically with the booking. The card itself is
// attached to the customer separately (post-commit, retryable) via
// attachCardHoldPaymentMethod; the pm id is stored here either way so charges
// can resolve it.
async function recordCardHoldHeld({ estimateId, customerId, scheduledServiceId = null, setupIntentId, paymentMethodId, trx = db }) {
  const noShowFee = cardHoldNoShowFee();
  const windowHours = cardHoldCancelWindowHours();
  const fields = {
    customer_id: customerId,
    scheduled_service_id: scheduledServiceId || null,
    stripe_payment_method_id: paymentMethodId,
    no_show_fee_amount: noShowFee,
    cancel_window_hours: windowHours,
    agreed_at: trx.fn.now(),
    held_at: trx.fn.now(),
    status: 'held',
    updated_at: trx.fn.now(),
  };
  await trx('estimate_card_holds')
    .insert({ estimate_id: estimateId, stripe_setup_intent_id: setupIntentId, ...fields })
    .onConflict('stripe_setup_intent_id')
    .merge(fields);
  logger.info('[estimate-card-holds] card hold recorded held', { estimateId });
}

// Post-commit, best-effort: attach the captured PM to the customer + persist a
// payment_methods row so charges resolve it. NEVER default, NEVER autopay — the
// hold card is only ever charged explicitly by id. The hold row already carries
// the pm id, so a transient failure here is recoverable (re-attach later)
// without losing the booking.
async function attachCardHoldPaymentMethod({ customerId, paymentMethodId }) {
  if (!customerId || !paymentMethodId) return { attached: false };
  try {
    await StripeService.savePaymentMethod(customerId, paymentMethodId, { enableAutopay: false, makeDefault: false });
    return { attached: true };
  } catch (err) {
    logger.warn('[estimate-card-holds] attaching hold card post-commit failed (recoverable)', { error: err.message });
    return { attached: false, reason: err.message };
  }
}

// Webhook entry: a succeeded SetupIntent marked as a card hold. Records the
// saved payment_method onto the pending row so accept can be satisfied even if
// the client never echoes the setupIntentId. Does NOT attach to a customer or
// flip to 'held' — that happens at accept, when the customer + appointment are
// known. Replay-safe: only a pending row is touched.
async function handleCardHoldSetupIntentSucceeded(setupIntent) {
  const estimateId = setupIntent?.metadata?.estimate_id;
  if (!estimateId || setupIntent?.metadata?.purpose !== 'estimate_card_hold') {
    return { handled: false };
  }
  await db('estimate_card_holds')
    .where({ stripe_setup_intent_id: setupIntent.id, status: 'pending' })
    .update({
      stripe_payment_method_id: setupIntent.payment_method || null,
      updated_at: db.fn.now(),
    });
  return { handled: true };
}

// Resolve the active ('held') hold for a booked appointment — the entry point
// for the completion charge (Phase 2) and the no-show fee (Phase 3).
async function heldCardForScheduledService(scheduledServiceId) {
  if (!scheduledServiceId) return null;
  return db('estimate_card_holds')
    .where({ scheduled_service_id: scheduledServiceId, status: 'held' })
    .orderBy('held_at', 'desc')
    .first();
}

// Resolve the internal payment_methods.id (UUID) for a hold's saved card —
// chargeInvoiceWithSavedCard takes our row id, not the Stripe pm id. Attaches
// the card now if the post-accept attach was deferred/failed.
async function resolveHoldPaymentMethodRowId(hold) {
  if (!hold?.customer_id || !hold?.stripe_payment_method_id) return null;
  const lookup = () => db('payment_methods')
    .where({ customer_id: hold.customer_id, stripe_payment_method_id: hold.stripe_payment_method_id })
    .first('id');
  let pm = await lookup();
  if (!pm) {
    await attachCardHoldPaymentMethod({ customerId: hold.customer_id, paymentMethodId: hold.stripe_payment_method_id });
    pm = await lookup();
  }
  return pm?.id || null;
}

// Claim a 'held' row for a charge so a concurrent completion/no-show charge or
// a retry can't double-charge. Returns true iff THIS call won the transition.
async function claimHoldForCharge(holdId) {
  const claimed = await db('estimate_card_holds')
    .where({ id: holdId, status: 'held' })
    .update({ status: 'charging', updated_at: db.fn.now() });
  return claimed > 0;
}

// ── Phase 2: charge the held card on completion ──────────────────────────
// Charge the saved hold card the final total of the completed-visit invoice,
// reusing chargeInvoiceWithSavedCard (surcharge/tax/ledger/receipt). Pre-checks
// collectibility so an invoice already settled by prepay / account credit
// simply releases the hold. Never throws into the completion flow — a real
// charge failure reverts to 'held' for retry and alerts.
async function chargeCardHoldOnCompletion({ scheduledServiceId, invoiceId }) {
  if (!isCardHoldEnabled()) return { charged: false, reason: 'feature_disabled' };
  if (!invoiceId) return { charged: false, reason: 'no_invoice' };
  const hold = await heldCardForScheduledService(scheduledServiceId);
  if (!hold) return { charged: false, reason: 'no_hold' };

  const invoice = await db('invoices').where({ id: invoiceId }).first();
  if (!invoice) return { charged: false, reason: 'invoice_missing' };
  const collectibleStatuses = ['pending', 'sent', 'overdue', 'partial'];
  if (invoice.payer_id || !collectibleStatuses.includes(invoice.status) || Number(invoice.total || 0) <= 0) {
    await db('estimate_card_holds').where({ id: hold.id, status: 'held' })
      .update({ status: 'released', updated_at: db.fn.now() });
    return { charged: false, reason: 'invoice_not_collectible' };
  }

  if (!(await claimHoldForCharge(hold.id))) return { charged: false, reason: 'not_held' };
  try {
    const pmRowId = await resolveHoldPaymentMethodRowId(hold);
    if (!pmRowId) throw new Error('hold card not attached to customer');
    const payment = await StripeService.chargeInvoiceWithSavedCard(invoiceId, pmRowId);
    await db('estimate_card_holds').where({ id: hold.id }).update({
      status: 'charged_completion',
      completion_payment_intent_id: payment?.stripe_payment_intent_id || null,
      charged_amount: payment?.amount != null ? payment.amount : Number(invoice.total),
      charged_at: db.fn.now(),
      updated_at: db.fn.now(),
    });
    logger.info('[estimate-card-holds] completion charge succeeded', { scheduledServiceId, invoiceId });
    return { charged: true };
  } catch (err) {
    await db('estimate_card_holds').where({ id: hold.id, status: 'charging' })
      .update({ status: 'held', updated_at: db.fn.now() }).catch(() => {});
    logger.error('[estimate-card-holds] completion charge FAILED — hold left for retry', { scheduledServiceId, error: err.message });
    return { charged: false, reason: 'charge_failed', error: err.message };
  }
}

// ── Phase 3: no-show / late-cancel fee ───────────────────────────────────
// Charge the flat fee against the held card (face value, off-session). The fee
// is read from the FROZEN hold row, not live constants. Idempotent on the hold
// row; never throws into the host flow.
async function chargeNoShowFee({ scheduledServiceId, reason = 'no_show' }) {
  if (!isCardHoldEnabled()) return { charged: false, reason: 'feature_disabled' };
  const hold = await heldCardForScheduledService(scheduledServiceId);
  if (!hold) return { charged: false, reason: 'no_hold' };
  const feeAmount = Number(hold.no_show_fee_amount) > 0 ? Number(hold.no_show_fee_amount) : cardHoldNoShowFee();

  if (!(await claimHoldForCharge(hold.id))) return { charged: false, reason: 'not_held' };
  try {
    const paymentIntent = await StripeService.chargeSavedPaymentMethodOffSession({
      customerId: hold.customer_id,
      paymentMethodId: hold.stripe_payment_method_id,
      amountDollars: feeAmount,
      description: 'Waves one-time visit — no-show / late-cancellation fee',
      metadata: {
        purpose: 'card_hold_no_show_fee',
        estimate_id: String(hold.estimate_id),
        scheduled_service_id: String(scheduledServiceId),
        reason,
      },
      idempotencyKey: `card_hold_no_show_${hold.id}`,
    });
    await db('estimate_card_holds').where({ id: hold.id }).update({
      status: 'charged_no_show',
      no_show_payment_intent_id: paymentIntent?.id || null,
      charged_amount: feeAmount,
      charged_at: db.fn.now(),
      updated_at: db.fn.now(),
    });
    logger.info('[estimate-card-holds] no-show fee charged', { scheduledServiceId, feeAmount, reason });
    return { charged: true, amount: feeAmount };
  } catch (err) {
    await db('estimate_card_holds').where({ id: hold.id, status: 'charging' })
      .update({ status: 'held', updated_at: db.fn.now() }).catch(() => {});
    logger.error('[estimate-card-holds] no-show fee charge FAILED', { scheduledServiceId, error: err.message });
    return { charged: false, reason: 'charge_failed', error: err.message };
  }
}

// Release a hold with NO charge (cancel outside the window, reschedule, admin
// waive). Idempotent; only a 'held' row releases.
async function releaseCardHold({ scheduledServiceId, reason = 'released' }) {
  if (!scheduledServiceId) return { released: false };
  const updated = await db('estimate_card_holds')
    .where({ scheduled_service_id: scheduledServiceId, status: 'held' })
    .update({ status: 'released', updated_at: db.fn.now() });
  if (updated) logger.info('[estimate-card-holds] card hold released', { scheduledServiceId, reason });
  return { released: updated > 0 };
}

// Whether a cancellation lands INSIDE the fee window (fee applies) vs outside
// (free release). serviceStart is the appointment's scheduled start instant.
function isWithinCancelWindow({ hold, serviceStart, now = new Date() }) {
  const windowHours = Number(hold?.cancel_window_hours) > 0 ? Number(hold.cancel_window_hours) : cardHoldCancelWindowHours();
  const start = serviceStart instanceof Date ? serviceStart : new Date(serviceStart);
  if (Number.isNaN(start.getTime())) return false;
  return (start.getTime() - now.getTime()) <= windowHours * 3600000;
}

// Single entry for the cancel path: charge the late-cancel fee if the
// cancellation lands inside the window, otherwise release the hold free. The
// appointment's ET start instant is resolved from the trusted shared helper
// when not supplied; if it can't be resolved we fail toward RELEASE (never
// charge a fee we can't justify against a real cutoff).
async function handleCardHoldCancellation({ scheduledServiceId, serviceStart = null, now = new Date() }) {
  const hold = await heldCardForScheduledService(scheduledServiceId);
  if (!hold) return { handled: false, reason: 'no_hold' };
  let start = serviceStart;
  if (!start) {
    try {
      const { scheduledServiceApptTime } = require('./appointment-reminders');
      start = await scheduledServiceApptTime(scheduledServiceId);
    } catch (err) {
      logger.warn('[estimate-card-holds] appt-time resolution for cancel failed — releasing free', { error: err.message });
    }
  }
  if (start && isWithinCancelWindow({ hold, serviceStart: start, now })) {
    return chargeNoShowFee({ scheduledServiceId, reason: 'late_cancel' });
  }
  return releaseCardHold({ scheduledServiceId, reason: 'cancel_outside_window' });
}

module.exports = {
  isCardHoldEnabled,
  cardHoldNoShowFee,
  cardHoldCancelWindowHours,
  resolveCardHoldPolicy,
  createCardHoldSetupIntentForEstimate,
  verifyCardHoldIntent,
  recordCardHoldHeld,
  attachCardHoldPaymentMethod,
  handleCardHoldSetupIntentSucceeded,
  heldCardForScheduledService,
  hasHeldCard,
  chargeCardHoldOnCompletion,
  chargeNoShowFee,
  releaseCardHold,
  handleCardHoldCancellation,
  isWithinCancelWindow,
  _private: {
    cardHoldIntentMatchesEstimate,
    holdGeneration,
    resolveHoldPaymentMethodRowId,
  },
};
