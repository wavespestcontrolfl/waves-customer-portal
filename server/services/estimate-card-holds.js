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
const { isInvoiceCollectibleStatus } = require('./invoice-helpers');
const { etDateString } = require('../utils/datetime-et');

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
        // Return the terms FROZEN on this pending row (what the customer was
        // first shown), not live config — recordCardHoldHeld enforces these, so
        // the displayed consent must match.
        return {
          clientSecret: existing.client_secret,
          setupIntentId: existing.id,
          noShowFeeAmount: pending.no_show_fee_amount != null ? Number(pending.no_show_fee_amount) : cardHoldNoShowFee(),
          cancelWindowHours: pending.cancel_window_hours != null ? Number(pending.cancel_window_hours) : cardHoldCancelWindowHours(),
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
  let effectiveSetupIntentId = setupIntentId;
  if (!effectiveSetupIntentId) {
    // A redirect/reload after confirmSetup can land the webhook (which records
    // the captured pm on the pending row) BEFORE the client echoes the id back.
    // Fall back to that webhook-captured pending row and re-verify it live.
    const pendingCaptured = await db('estimate_card_holds')
      .where({ estimate_id: estimate.id, status: 'pending' })
      .whereNotNull('stripe_payment_method_id')
      .orderBy('updated_at', 'desc')
      .first('stripe_setup_intent_id');
    if (pendingCaptured?.stripe_setup_intent_id) effectiveSetupIntentId = pendingCaptured.stripe_setup_intent_id;
  }
  if (!effectiveSetupIntentId) return { ok: false, reason: 'no_setup_intent' };
  let setupIntent = null;
  try {
    setupIntent = await StripeService.retrieveSetupIntent(effectiveSetupIntentId);
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
  // Preserve the terms the customer was SHOWN — frozen on the pending row when
  // /card-hold-intent minted it. Only fall back to live config if that row is
  // somehow absent, so a pricing_config change between modal-open and accept
  // never moves the fee the customer consented to.
  const existing = await trx('estimate_card_holds')
    .where({ stripe_setup_intent_id: setupIntentId })
    .first('no_show_fee_amount', 'cancel_window_hours');
  const noShowFee = existing?.no_show_fee_amount != null ? Number(existing.no_show_fee_amount) : cardHoldNoShowFee();
  const windowHours = existing?.cancel_window_hours != null ? Number(existing.cancel_window_hours) : cardHoldCancelWindowHours();
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
  // Idempotent: this runs post-accept AND again as a self-heal before the
  // no-show / completion charge. savePaymentMethod inserts unconditionally, so
  // re-saving an already-saved card would stack duplicate payment_methods +
  // consent rows. Skip when the card is already on file.
  const existing = await db('payment_methods')
    .where({ customer_id: customerId, stripe_payment_method_id: paymentMethodId })
    .first('id');
  if (existing) return { attached: true, paymentMethodRowId: existing.id, alreadySaved: true };
  try {
    const saved = await StripeService.savePaymentMethod(customerId, paymentMethodId, { enableAutopay: false, makeDefault: false });
    // Record the immutable save-card consent (admin consent history reads this
    // ledger). Non-fatal: a consent-write hiccup must not drop the held card.
    try {
      const ConsentService = require('./payment-method-consents');
      await ConsentService.recordConsent({
        customerId,
        paymentMethodId: saved?.id || null,
        stripePaymentMethodId: paymentMethodId,
        source: 'estimate_card_hold',
        methodType: 'card',
      });
    } catch (consentErr) {
      logger.warn('[estimate-card-holds] card-hold consent record failed (non-fatal)', { error: consentErr.message });
    }
    return { attached: true, paymentMethodRowId: saved?.id || null };
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
  // Completion invoices are created as 'draft' (InvoiceService.createFromService)
  // — draft/sent/pending/overdue/partial are all collectible. Use the canonical
  // helper, not a hand-rolled allow-list that would wrongly release a fresh
  // draft uncharged and silently fall back to an unpaid invoice.
  if (invoice.payer_id || !isInvoiceCollectibleStatus(invoice.status) || Number(invoice.total || 0) <= 0) {
    await db('estimate_card_holds').where({ id: hold.id, status: 'held' })
      .update({ status: 'released', updated_at: db.fn.now() });
    return { charged: false, reason: 'invoice_not_collectible' };
  }

  if (!(await claimHoldForCharge(hold.id))) return { charged: false, reason: 'not_held' };
  try {
    const pmRowId = await resolveHoldPaymentMethodRowId(hold);
    if (!pmRowId) throw new Error('hold card not attached to customer');
    const payment = await StripeService.chargeInvoiceWithSavedCard(invoiceId, pmRowId);
    // Account credit fully covered the invoice inside the charge call — no card
    // was charged; release the hold cleanly rather than claim a phantom charge.
    if (payment?.covered_by_credit) {
      await db('estimate_card_holds').where({ id: hold.id })
        .update({ status: 'released', charged_amount: 0, charged_at: db.fn.now(), updated_at: db.fn.now() });
      return { charged: false, reason: 'covered_by_credit' };
    }
    await db('estimate_card_holds').where({ id: hold.id }).update({
      status: 'charged_completion',
      // chargeInvoiceWithSavedCard returns the Stripe id as `paymentIntentId`.
      completion_payment_intent_id: payment?.paymentIntentId || null,
      charged_amount: payment?.amount != null ? payment.amount : Number(invoice.total),
      charged_at: db.fn.now(),
      updated_at: db.fn.now(),
    });
    logger.info('[estimate-card-holds] completion charge succeeded', { scheduledServiceId, invoiceId });
    return { charged: true };
  } catch (err) {
    // STRIPE_CHARGED_DB_FAILED: Stripe COLLECTED the money but our DB write
    // failed (already recorded as a stripe_orphan_charge). Reopening to 'held'
    // would let a retry charge the SAME invoice again — and chargeInvoiceWith-
    // SavedCard's idempotency key is minute-bucketed, so a later retry mints a
    // SECOND PaymentIntent. Park it terminal for manual reconciliation instead.
    if (err.code === 'STRIPE_CHARGED_DB_FAILED') {
      await db('estimate_card_holds').where({ id: hold.id, status: 'charging' })
        .update({
          status: 'charge_review',
          completion_payment_intent_id: err.stripePaymentIntentId || null,
          charged_amount: err.amount != null ? err.amount : null,
          charged_at: db.fn.now(),
          updated_at: db.fn.now(),
        }).catch(() => {});
      logger.error('[estimate-card-holds] completion charge hit STRIPE_CHARGED_DB_FAILED — parked charge_review, NOT retryable', { scheduledServiceId, paymentIntentId: err.stripePaymentIntentId });
      return { charged: false, reason: 'charge_review', error: err.message };
    }
    // Genuine pre-charge failure (no money moved) — safe to retry later.
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

  // Charge FIRST (separately from the row write) so a post-charge DB failure is
  // never confused with a pre-charge failure.
  let paymentIntent;
  try {
    // Self-heal: if the post-accept attach missed, the saved card isn't on the
    // Stripe customer yet and an off-session charge would fail forever — attach
    // it first (idempotent). The completion path gets this via
    // resolveHoldPaymentMethodRowId; the fee path charges the pm id directly.
    await attachCardHoldPaymentMethod({ customerId: hold.customer_id, paymentMethodId: hold.stripe_payment_method_id });
    paymentIntent = await StripeService.chargeSavedPaymentMethodOffSession({
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
  } catch (err) {
    // Distinguish a DEFINITE pre-charge decline (a PI exists but didn't succeed,
    // or a deterministic error — no money moved, safe to retry) from an
    // AMBIGUOUS connection/API error where Stripe may have accepted + confirmed
    // the PI. Reopening an ambiguous outcome to 'held' would let a >24h retry
    // mint a SECOND fee once Stripe's idempotency cache expires — park those.
    const errType = err.type || err.raw?.type || null;
    const piIdFromErr = err.payment_intent?.id || err.raw?.payment_intent?.id || null;
    const ambiguous = !piIdFromErr && ['StripeConnectionError', 'StripeAPIError'].includes(errType);
    if (ambiguous) {
      await db('estimate_card_holds').where({ id: hold.id, status: 'charging' })
        .update({ status: 'charge_review', updated_at: db.fn.now() }).catch(() => {});
      logger.error('[estimate-card-holds] no-show fee charge AMBIGUOUS (possible charge) — parked charge_review', { scheduledServiceId, error: err.message });
      return { charged: false, reason: 'charge_review', error: err.message };
    }
    await db('estimate_card_holds').where({ id: hold.id, status: 'charging' })
      .update({ status: 'held', updated_at: db.fn.now() }).catch(() => {});
    logger.error('[estimate-card-holds] no-show fee charge FAILED (no charge)', { scheduledServiceId, error: err.message });
    return { charged: false, reason: 'charge_failed', error: err.message };
  }

  // PI succeeded. A DB-write failure here must NOT reopen to 'held': Stripe's
  // idempotency cache expires (~24h), so a later retry would charge a SECOND
  // fee. Park terminal in charge_review like the completion path, keeping the
  // PI pointer.
  try {
    await db('estimate_card_holds').where({ id: hold.id }).update({
      status: 'charged_no_show',
      no_show_payment_intent_id: paymentIntent?.id || null,
      charged_amount: feeAmount,
      charged_at: db.fn.now(),
      updated_at: db.fn.now(),
    });
  } catch (writeErr) {
    await db('estimate_card_holds').where({ id: hold.id, status: 'charging' })
      .update({
        status: 'charge_review',
        no_show_payment_intent_id: paymentIntent?.id || null,
        charged_amount: feeAmount,
        charged_at: db.fn.now(),
        updated_at: db.fn.now(),
      }).catch(() => {});
    logger.error('[estimate-card-holds] no-show fee CHARGED but DB write failed — parked charge_review (NOT retryable)', { scheduledServiceId, paymentIntentId: paymentIntent?.id });
    return { charged: true, amount: feeAmount, reason: 'charge_review_write_failed' };
  }
  logger.info('[estimate-card-holds] no-show fee charged', { scheduledServiceId, feeAmount, reason });
  return { charged: true, amount: feeAmount };
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

// ── No-show fee settlement: refundable invoice + customer receipt ─────────
// The no-show / late-cancel fee is charged face-value via a raw off-session PI
// (chargeNoShowFee). This turns that bare charge into a first-class billing
// object: a PAID fee invoice (so it gets the customer receipt page + invoice-
// based revenue reporting) with the payments-ledger row linked to it, then
// sends the customer a receipt and gives the office a heads-up. Refundability
// comes free via the payments row + the existing /refund flow. Driven from the
// card_hold_no_show_fee webhook (the settlement signal); idempotent on the PI.
async function settleNoShowFee(paymentIntent) {
  const piId = paymentIntent?.id;
  const customerId = paymentIntent?.metadata?.waves_customer_id || null;
  if (!piId || !customerId) return { settled: false, reason: 'missing_pi_or_customer' };

  // Pre-settlement refund guard: an immediate dashboard refund can deliver
  // charge.refunded BEFORE this succeeded event — and since no invoice/payment
  // exists yet, that handler finds nothing to mark. Re-check the LIVE charge:
  // a FULL refund skips settlement entirely; a PARTIAL refund still settles (so
  // the net-kept money lands in revenue) but records the refunded slice on the
  // payment row. FAIL CLOSED on a retrieve error — throw so the webhook returns
  // non-200 and Stripe retries until we can observe the real refund state;
  // settling gross here would book already-refunded money as revenue.
  let preRefundedCents = 0;
  try {
    const live = await StripeService.retrievePaymentIntent(piId, { expand: ['latest_charge'] });
    const ch = live?.latest_charge;
    if (ch && typeof ch === 'object') {
      const chargedCents = Math.round(Number(ch.amount || 0));
      preRefundedCents = Math.max(0, Math.round(Number(ch.amount_refunded || 0)));
      if (ch.refunded === true || (chargedCents > 0 && preRefundedCents >= chargedCents)) {
        logger.warn('[estimate-card-holds] no-show fee fully refunded before settlement — skipping', { piId });
        return { settled: false, reason: 'refunded_pre_settlement' };
      }
    }
  } catch (err) {
    logger.error('[estimate-card-holds] pre-settlement refund check failed — deferring to Stripe retry', { piId, error: err.message });
    throw err;
  }

  const amount = Math.round(Number(paymentIntent.amount_received || paymentIntent.amount || 0)) / 100;
  const reason = paymentIntent.metadata?.reason || 'no_show';
  const estimateId = paymentIntent.metadata?.estimate_id || null;
  const scheduledServiceId = paymentIntent.metadata?.scheduled_service_id || null;
  const feeLabel = reason === 'late_cancel' ? 'Late-cancellation fee' : 'No-show fee';

  // Invoice + paid-mark + ledger row land atomically. A transaction-scoped
  // advisory lock keyed on the PI serializes concurrent settlements for the same
  // charge — payments.stripe_payment_intent_id has no unique constraint, so two
  // webhook deliveries (or workers) could otherwise both pass a pre-txn replay
  // check and each create an invoice. The replay check runs INSIDE the lock.
  const InvoiceService = require('./invoice');
  const description = `One-time visit — ${feeLabel.toLowerCase()}`;
  const result = await db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`card_hold_no_show_fee:${piId}`]);
    const existing = await trx('payments').where({ stripe_payment_intent_id: piId }).first('id');
    if (existing) return { replay: true };

    // Face value, NO tax: the fee must equal the amount disclosed + charged.
    const inv = await InvoiceService.create({
      database: trx,
      customerId,
      title: description,
      lineItems: [{ description: `${feeLabel} — one-time visit`, quantity: 1, unit_price: amount, amount }],
      taxRate: 0,
      dueDate: etDateString(),
      skipAccrual: true,
    });
    // SELF-PAY: this fee was charged to the HOMEOWNER's saved card, so it must
    // never route to a third-party payer (create() resolves the customer's
    // default payer + stamps payer_id/payer_snapshot, and the receipt email then
    // routes to the payer's AP inbox). Clear the payer so the receipt + AR stay
    // with the customer who was actually charged (skipAccrual already prevents
    // statement accrual).
    await trx('invoices').where({ id: inv.id }).update({
      status: 'paid',
      paid_at: trx.fn.now(),
      stripe_payment_intent_id: piId,
      stripe_charge_id: paymentIntent.latest_charge || null,
      payer_id: null,
      payer_snapshot: null,
      updated_at: trx.fn.now(),
    });
    // payments has no invoice_id column — link via metadata.invoice_id +
    // invoices.stripe_payment_intent_id (same as the completion path). This is
    // the row the existing /refund flow acts on.
    await trx('payments').insert({
      customer_id: customerId,
      processor: 'stripe',
      stripe_payment_intent_id: piId,
      stripe_charge_id: paymentIntent.latest_charge || null,
      payment_date: etDateString(),
      amount,
      // A partial pre-settlement refund is recorded here so net revenue + the
      // refund ledger are correct (status stays 'paid' — only a full refund is
      // terminal, and that path skipped settlement above). Any refund recorded
      // here is partial; admin payment history keys "refunded" off refund_status,
      // so leaving it null would surface a partial refund as a plain paid charge.
      refund_amount: preRefundedCents > 0 ? preRefundedCents / 100 : 0,
      refund_status: preRefundedCents > 0 ? 'partial' : null,
      status: 'paid',
      description,
      metadata: JSON.stringify({
        purpose: 'card_hold_no_show_fee',
        invoice_id: inv.id,
        estimate_id: estimateId,
        scheduled_service_id: scheduledServiceId,
        reason,
      }),
    });
    return { invoice: inv };
  });
  if (result.replay) {
    // A crash after the settle txn committed but before the receipt sent (or
    // before Stripe marked the event processed) lands here on retry. Re-attempt
    // the receipt — idempotent via invoices.receipt_sent_at — so a settled fee
    // never ends up with no customer receipt.
    try {
      const inv = await db('invoices').where({ stripe_payment_intent_id: piId })
        .whereNot('status', 'void').orderBy('created_at', 'desc').first('id', 'token', 'receipt_sent_at');
      if (inv?.id && !inv.receipt_sent_at) {
        await sendNoShowFeeReceipt({ invoice: inv, customerId, amount, feeLabel, reason });
      }
    } catch (err) {
      logger.warn('[estimate-card-holds] replay receipt recovery failed (non-fatal)', { error: err.message });
    }
    return { settled: false, replay: true };
  }
  const invoice = result.invoice;
  logger.info('[estimate-card-holds] no-show fee settled as paid invoice', { invoiceId: invoice.id, customerId, reason });

  // Receipt to the customer + heads-up to the office. Best-effort: the money +
  // invoice are durable, so a comms hiccup must NOT throw (that would make
  // Stripe retry and double-create the invoice).
  try {
    await sendNoShowFeeReceipt({ invoice, customerId, amount, feeLabel, reason });
  } catch (err) {
    logger.warn('[estimate-card-holds] no-show fee receipt/notify failed (non-fatal)', { error: err.message });
  }
  return { settled: true, invoiceId: invoice.id };
}

// Customer receipt via the CANONICAL receipt path (dispatched by the customer's
// payment_receipt channel preference) + a low-key office notification. Using
// InvoiceService.sendReceipt / sendReceiptEmail rather than a hand-rolled
// message means the receipt kill switch, the payment_receipt opt-out, the
// per-location Twilio number, and the invoices.receipt_sent_at stamp (so the
// admin "needs receipt" filter + batch resend don't double-send) all apply. The
// fee invoice's title already names the charge, so no custom copy is needed.
async function sendNoShowFeeReceipt({ invoice, customerId, amount, feeLabel, reason }) {
  const prefs = await db('notification_prefs').where({ customer_id: customerId }).first().catch(() => null);
  const receiptOptOut = prefs?.payment_receipt === false;
  const channel = prefs?.payment_receipt_channel || 'sms';

  // SMS receipt — sendReceipt stamps receipt_sent_at + routes through the
  // payment_receipt template/policy (kill switch, per-location number, opt-out).
  if (!receiptOptOut && (channel === 'sms' || channel === 'both')) {
    try {
      await require('./invoice').sendReceipt(invoice.id);
    } catch (e) { logger.warn('[estimate-card-holds] no-show fee receipt SMS failed', { error: e.message }); }
  }
  // Emailed PDF receipt.
  if (!receiptOptOut && (channel === 'email' || channel === 'both') && prefs?.email_enabled !== false) {
    try {
      const emailResult = await require('./invoice-email').sendReceiptEmail(invoice.id, { idempotencyKey: `no_show_fee_receipt:${invoice.id}` });
      // sendReceiptEmail does NOT stamp receipt_sent_at (only the SMS sendReceipt
      // does) — so on an email-only channel, stamp it here. ONLY on a delivered
      // or deduped result (both ok:true): a no-recipient / provider failure
      // returns ok:false WITHOUT throwing, and stamping then would wrongly drop
      // the paid fee invoice from the admin "needs receipt" retry path.
      if (emailResult?.ok) {
        await db('invoices').where({ id: invoice.id }).whereNull('receipt_sent_at')
          .update({ receipt_sent_at: db.fn.now() }).catch(() => {});
      }
    } catch (e) { logger.warn('[estimate-card-holds] no-show fee receipt email failed', { error: e.message }); }
  }

  // Office heads-up so a "what's this charge?" call isn't a surprise.
  const first = (await db('customers').where({ id: customerId }).first('first_name').catch(() => null))?.first_name || 'A customer';
  const feeText = amount % 1 ? `$${amount.toFixed(2)}` : `$${amount}`;
  try {
    await require('./notification-service').notifyAdmin(
      'billing',
      `${feeLabel} charged`,
      `${first} — ${feeText} ${feeLabel.toLowerCase()} on a one-time visit.`,
      { link: `/admin/customers/${customerId}`, metadata: { invoiceId: invoice.id, reason } },
    );
  } catch (e) { logger.warn('[estimate-card-holds] no-show fee admin notify failed', { error: e.message }); }
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
  settleNoShowFee,
  _private: {
    cardHoldIntentMatchesEstimate,
    holdGeneration,
    resolveHoldPaymentMethodRowId,
    sendNoShowFeeReceipt,
  },
};
