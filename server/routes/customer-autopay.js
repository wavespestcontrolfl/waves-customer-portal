const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const Stripe = require('stripe');
const { authenticate } = require('../middleware/auth');
const db = require('../models/db');
const logger = require('../services/logger');
const stripeConfig = require('../config/stripe-config');
const { logAutopay, getRecent } = require('../services/autopay-log');
const {
  isChargeableAutopayMethod,
  isBankMethodType,
  isExpiredCardMethod,
  isPaused,
} = require('../services/autopay-eligibility');
const { etDateString } = require('../utils/datetime-et');
const { computeChargeAmount, isCardMethodType } = require('../services/stripe-pricing');
const PaymentLifecycleEmail = require('../services/payment-lifecycle-email');

router.use(authenticate);

let _stripe;
function getStripe() {
  if (_stripe) return _stripe;
  if (!stripeConfig.secretKey) return null;
  _stripe = new Stripe(stripeConfig.secretKey, { apiVersion: '2024-12-18.acacia' });
  return _stripe;
}

async function resolveAutopayCardFunding(paymentMethod) {
  if (!paymentMethod
    || paymentMethod.card_funding
    || !paymentMethod.stripe_payment_method_id
    || !isCardMethodType(paymentMethod.method_type)) {
    return paymentMethod?.card_funding || null;
  }

  const stripe = getStripe();
  if (!stripe) return null;

  try {
    const stripePaymentMethod = await stripe.paymentMethods.retrieve(paymentMethod.stripe_payment_method_id);
    const funding = stripePaymentMethod?.card?.funding || null;
    if (funding) {
      paymentMethod.card_funding = funding;
      await db('payment_methods')
        .where({ id: paymentMethod.id })
        .update({
          card_funding: funding,
          card_funding_checked_at: new Date().toISOString(),
        });
    }
    return funding;
  } catch (err) {
    logger.warn(`[autopay] Funding lookup failed for payment method ${paymentMethod.id}: ${err.message}`);
    return null;
  }
}

// Throttle autopay mutations per authenticated customer to prevent rapid toggling
// or accidental DoS of the billing pipeline.
const autopayWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.customerId || req.ip,
  message: { error: 'Too many autopay updates. Please wait a moment and try again.' },
});

/**
 * GET /api/billing/autopay — current autopay state for the authenticated customer.
 */
router.get('/', async (req, res, next) => {
  try {
    const customer = await db('customers')
      .where({ id: req.customerId })
      .select(
        'id', 'monthly_rate', 'waveguard_tier',
        'autopay_enabled', 'autopay_paused_until', 'autopay_pause_reason',
        'autopay_payment_method_id', 'billing_day', 'next_charge_date',
        'ach_status',
      )
      .first();

    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const paymentMethods = await db('payment_methods')
      .where({ customer_id: req.customerId })
      .select(
        'id',
        db.raw('card_brand as brand'),
        db.raw('last_four as last4'),
        'exp_month', 'exp_year', 'is_default', 'autopay_enabled', 'method_type',
        'bank_name', 'ach_status',
      )
      .orderBy('is_default', 'desc')
      .orderBy('created_at', 'desc');

    const autopayPaused = isPaused(customer);

    const chargeableAutopayMethod = await db('payment_methods')
      .where({
        customer_id: req.customerId,
        processor: 'stripe',
        is_default: true,
        autopay_enabled: true,
      })
      .first(
        'id', 'processor', 'method_type', 'stripe_payment_method_id',
        'is_default', 'autopay_enabled', 'card_funding', 'card_brand',
        'exp_month', 'exp_year'
      );
    // Mirror customerOnAutopay's ACH-health rule (Codex round-12): when
    // customers.ach_status is non-empty and not 'active'
    // (needs_verification / suspended), collection refuses everything but a
    // card — reporting 'active' for an unhealthy bank default would promise
    // auto-charges that will actually fall back to manual payment.
    const achHealthBlocked = !!customer.ach_status && customer.ach_status !== 'active'
      && chargeableAutopayMethod?.method_type !== 'card';
    const hasAutopayMethod = isChargeableAutopayMethod(chargeableAutopayMethod) && !achHealthBlocked;
    // Per-application customers pay per completed visit — their autopay card
    // is HOW each visit charge collects, not a monthly subscription, and the
    // monthly cron skips them (GUARD 3b). Never project a monthly next-charge
    // from monthly_rate for them (Codex round-2): it advertises a charge that
    // will never run. Column-guarded read — pre-migration keeps legacy shape.
    let billingMode = null;
    try {
      const modeRow = await db('customers').where({ id: req.customerId }).first('billing_mode');
      billingMode = modeRow?.billing_mode || null;
    } catch { /* billing_mode column absent pre-migration */ }
    const perApplicationBilling = billingMode === 'per_application';
    // Both non-monthly modes must suppress the monthly projection: the
    // monthly cron never charges per_application, and annual_prepay is
    // term-covered (renewal collects via its own flow) — projecting
    // monthly_rate for either advertises a charge that will not run
    // (Codex round-2 + round-5).
    const nonMonthlyBilling = perApplicationBilling || billingMode === 'annual_prepay';
    // Per-application collection takes ANY saved tender (owner ruling
    // 2026-07-09): chargeInvoiceWithSavedCard locks the PI to the saved
    // method's family (card settles inline, ACH rides processing→paid), so
    // an ACH default is a genuinely active Auto Pay state here too.
    const customerAutopayEnabled = !!customer.autopay_enabled && hasAutopayMethod;
    const autopayFunding = customerAutopayEnabled
      ? await resolveAutopayCardFunding(chargeableAutopayMethod)
      : null;
    // NULL monthly_rate = unpriced (manual quote pending), never $0: the
    // monthly cron filters monthly_rate > 0 and will not charge, so
    // projecting "Next charge: $0.00 on <date>" is false. Serialize null and
    // let the portal render an unpriced state (NULL-not-$0 rule).
    const hasMonthlyRate = Number(customer.monthly_rate) > 0;
    const nextCharge = customerAutopayEnabled && !nonMonthlyBilling && hasMonthlyRate
      ? computeChargeAmount(customer.monthly_rate, chargeableAutopayMethod.method_type, { funding: autopayFunding })
      : null;

    let state = 'disabled';
    if (customerAutopayEnabled && !autopayPaused) state = 'active';
    else if (customerAutopayEnabled && autopayPaused) state = 'paused';

    const recentEvents = await getRecent(req.customerId, 10);

    res.json({
      state,
      autopay_enabled: customerAutopayEnabled,
      paused_until: customer.autopay_paused_until,
      pause_reason: customer.autopay_pause_reason,
      autopay_payment_method_id: hasAutopayMethod ? chargeableAutopayMethod.id : null,
      billing_day: customer.billing_day || 1,
      billing_mode: billingMode,
      next_charge_date: nonMonthlyBilling || !hasMonthlyRate ? null : customer.next_charge_date,
      next_charge_amount: nextCharge?.total ?? null,
      next_charge_base_amount: nextCharge?.base ?? null,
      next_charge_surcharge_amount: nextCharge?.surcharge ?? null,
      monthly_rate: customer.monthly_rate,
      waveguard_tier: customer.waveguard_tier,
      payment_methods: paymentMethods,
      recent_events: recentEvents,
    });
  } catch (err) { next(err); }
});

/**
 * PUT /api/billing/autopay — update autopay settings.
 * Body: { autopay_enabled?, autopay_payment_method_id?, billing_day? }
 */
router.put('/', autopayWriteLimiter, async (req, res, next) => {
  try {
    const { autopay_enabled, autopay_payment_method_id, billing_day } = req.body || {};
    const updates = {};
    const events = [];

    const current = await db('customers')
      .where({ id: req.customerId })
      .select('autopay_enabled', 'autopay_payment_method_id', 'billing_day', 'ach_status')
      .first();

    if (!current) return res.status(404).json({ error: 'Customer not found' });

    const willBeEnabled = typeof autopay_enabled === 'boolean' ? autopay_enabled : current.autopay_enabled;

    let selectedPaymentMethod = null;
    if (autopay_payment_method_id) {
      selectedPaymentMethod = await db('payment_methods')
        .where({ id: autopay_payment_method_id, customer_id: req.customerId })
        .first('id', 'processor', 'stripe_payment_method_id', 'method_type', 'ach_status', 'exp_month', 'exp_year');
      if (!selectedPaymentMethod) return res.status(400).json({ error: 'Payment method not found' });
    } else if (autopay_payment_method_id === null || autopay_payment_method_id === '') {
      selectedPaymentMethod = null;
    } else if (current.autopay_payment_method_id) {
      selectedPaymentMethod = await db('payment_methods')
        .where({ id: current.autopay_payment_method_id, customer_id: req.customerId })
        .first('id', 'processor', 'stripe_payment_method_id', 'method_type', 'ach_status', 'exp_month', 'exp_year');
    } else if (willBeEnabled) {
      selectedPaymentMethod = await db('payment_methods')
        .where({ customer_id: req.customerId, is_default: true, processor: 'stripe' })
        .whereNotNull('stripe_payment_method_id')
        .orderBy('created_at', 'desc')
        .first('id', 'processor', 'stripe_payment_method_id', 'method_type', 'ach_status', 'exp_month', 'exp_year');
    }

    if (
      willBeEnabled
      && autopay_payment_method_id === undefined
      && (!selectedPaymentMethod?.stripe_payment_method_id || selectedPaymentMethod?.processor !== 'stripe')
    ) {
      selectedPaymentMethod = await db('payment_methods')
        .where({ customer_id: req.customerId, is_default: true, processor: 'stripe' })
        .whereNotNull('stripe_payment_method_id')
        .orderBy('created_at', 'desc')
        .first('id', 'processor', 'stripe_payment_method_id', 'method_type', 'ach_status', 'exp_month', 'exp_year');
    }

    const methodCanChargeAutopay = selectedPaymentMethod?.processor === 'stripe'
      && !!selectedPaymentMethod?.stripe_payment_method_id;

    if (willBeEnabled && !methodCanChargeAutopay) {
      return res.status(400).json({ error: 'Add a payment method before enabling Auto Pay.' });
    }

    if (willBeEnabled && isExpiredCardMethod(selectedPaymentMethod)) {
      return res.status(400).json({
        error: 'This card is expired. Add a current payment method before enabling Auto Pay.',
      });
    }

    // A micro-deposit bank account that hasn't verified (or failed
    // verification) must not be put in charge of Auto Pay (portal ACH
    // lane): collection would debit an account that can't be debited and
    // Stripe's rejection would escalate through handleAchFailure. The
    // setup_intent.succeeded webhook flips the row to 'verified' and
    // enrolls it; until then the portal shows it as pending.
    if (willBeEnabled
      && isBankMethodType(selectedPaymentMethod?.method_type)
      && ['pending_verification', 'verification_failed'].includes(selectedPaymentMethod?.ach_status)) {
      return res.status(400).json({
        error: selectedPaymentMethod.ach_status === 'verification_failed'
          ? 'This bank account could not be verified. Remove it and add it again.'
          : 'This bank account is still being verified. You can use it for Auto Pay as soon as verification clears.',
      });
    }

    // Customer-level ACH block (Codex #2706 r3): while customers.ach_status
    // is non-active, customerOnAutopay/cron refuse every non-card method —
    // persisting Auto Pay flags onto a bank here would silently stop
    // collection while the UI shows Active. Reject honestly instead;
    // 'suspended' clears through a successful ACH payment (or
    // needs_verification through a bank verification).
    if (willBeEnabled
      && isBankMethodType(selectedPaymentMethod?.method_type)
      && current.ach_status && current.ach_status !== 'active') {
      return res.status(400).json({ error: 'Bank payments are unavailable on your account right now — Auto Pay needs a card until that clears.' });
    }

    if (typeof autopay_enabled === 'boolean' && autopay_enabled !== current.autopay_enabled) {
      updates.autopay_enabled = autopay_enabled;
      events.push({ type: autopay_enabled ? 'autopay_enabled' : 'autopay_disabled', details: {} });
      // Clear pause when disabling/enabling
      if (!autopay_enabled) {
        updates.autopay_paused_until = null;
        updates.autopay_pause_reason = null;
      }
    }

    if (autopay_payment_method_id !== undefined && autopay_payment_method_id !== current.autopay_payment_method_id) {
      updates.autopay_payment_method_id = autopay_payment_method_id;
      events.push({
        type: 'payment_method_changed',
        paymentMethodId: autopay_payment_method_id,
        details: { previous_payment_method_id: current.autopay_payment_method_id },
      });
    }

    if (
      willBeEnabled
      && selectedPaymentMethod
      && autopay_payment_method_id === undefined
      && !current.autopay_payment_method_id
    ) {
      updates.autopay_payment_method_id = selectedPaymentMethod.id;
      events.push({
        type: 'payment_method_changed',
        paymentMethodId: selectedPaymentMethod.id,
        details: { previous_payment_method_id: current.autopay_payment_method_id },
      });
    }

    if (typeof billing_day === 'number' && billing_day >= 1 && billing_day <= 28 && billing_day !== current.billing_day) {
      updates.billing_day = billing_day;
      events.push({
        type: 'billing_day_changed',
        details: { previous: current.billing_day, next: billing_day },
      });
    }

    const shouldMirrorAutopayMethod = willBeEnabled
      && selectedPaymentMethod
      && (autopay_enabled === true || !!autopay_payment_method_id || !!updates.autopay_payment_method_id);

    if (Object.keys(updates).length === 0 && !shouldMirrorAutopayMethod) {
      return res.json({ success: true, updated: false });
    }

    await db.transaction(async (trx) => {
      if (Object.keys(updates).length > 0) {
        await trx('customers').where({ id: req.customerId }).update(updates);
      }

      if (updates.autopay_enabled === false) {
        await trx('payment_methods').where({ customer_id: req.customerId }).update({ autopay_enabled: false });
        return;
      }

      if (shouldMirrorAutopayMethod) {
        await trx('payment_methods')
          .where({ customer_id: req.customerId })
          .update({ autopay_enabled: false, is_default: false });
        await trx('payment_methods')
          .where({ id: selectedPaymentMethod.id, customer_id: req.customerId })
          .update({ autopay_enabled: true, is_default: true });
      }
    });

    for (const evt of events) {
      await logAutopay(req.customerId, evt.type, {
        paymentMethodId: evt.paymentMethodId || null,
        details: evt.details || {},
      });
    }

    const enabledEvent = events.find((evt) => evt.type === 'autopay_enabled');
    const methodChangedEvent = events.find((evt) => evt.type === 'payment_method_changed');
    const activePaymentMethodId = updates.autopay_payment_method_id !== undefined
      ? updates.autopay_payment_method_id
      : (selectedPaymentMethod?.id || current.autopay_payment_method_id || null);

    if (enabledEvent && activePaymentMethodId) {
      PaymentLifecycleEmail.sendAutopayEnabled({
        customerId: req.customerId,
        paymentMethodId: activePaymentMethodId,
        enabledDate: new Date(),
      }).catch((emailErr) => {
        logger.warn(`[customer-autopay] autopay enabled email failed for customer ${req.customerId}: ${emailErr.message}`);
      });
    } else if (methodChangedEvent?.paymentMethodId && willBeEnabled) {
      PaymentLifecycleEmail.sendPaymentMethodUpdated({
        customerId: req.customerId,
        oldPaymentMethodId: methodChangedEvent.details?.previous_payment_method_id || null,
        newPaymentMethodId: methodChangedEvent.paymentMethodId,
        updatedAt: new Date(),
      }).catch((emailErr) => {
        logger.warn(`[customer-autopay] payment method update email failed for customer ${req.customerId}: ${emailErr.message}`);
      });
    }

    // Authorization-copy backstop (Codex #2698 r3): a card ENTERING the
    // in-charge role via the portal — the re-enable toggle or use-this-card
    // — may never have received its enrollment copy (it was enrolled behind
    // a healthy incumbent under the in-charge-only rule, or before the gate
    // flipped). Consent-version-keyed idempotency makes this at-most-once
    // per agreement; the sender itself skips non-card methods and customers
    // with no enrollment-scoped consent row. Fire-and-forget; gate off =
    // total no-op.
    if (willBeEnabled && activePaymentMethodId && (enabledEvent || methodChangedEvent)) {
      try {
        const { sendAutopayEnrollmentConfirmation } = require('../services/card-enrollment-email');
        void sendAutopayEnrollmentConfirmation({
          customerId: req.customerId,
          paymentMethodRowId: activePaymentMethodId,
        });
      } catch { /* best-effort */ }
    }

    res.json({ success: true, updated: true, changes: Object.keys(updates) });
  } catch (err) { next(err); }
});

/**
 * POST /api/billing/autopay/pause — pause autopay until a date.
 * Body: { until: 'YYYY-MM-DD', reason?: string }
 */
router.post('/pause', autopayWriteLimiter, async (req, res, next) => {
  try {
    const { until, reason } = req.body || {};
    if (!until) return res.status(400).json({ error: 'until date required (YYYY-MM-DD)' });

    // Validate against the ET calendar, not Date-object comparison: for a
    // 'YYYY-MM-DD' body, new Date() is UTC midnight, which is already past
    // between 8 PM and midnight ET — rejecting the exact minimum date the
    // pause UI offers. The eligibility cron compares etDateString the same way.
    const untilStr = String(until);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(untilStr) || isNaN(new Date(`${untilStr}T12:00:00Z`).getTime())) {
      return res.status(400).json({ error: 'invalid date' });
    }
    if (untilStr <= etDateString(new Date())) return res.status(400).json({ error: 'date must be in the future' });

    await db('customers').where({ id: req.customerId }).update({
      autopay_paused_until: until,
      autopay_pause_reason: reason || null,
    });

    await logAutopay(req.customerId, 'autopay_paused', {
      details: { paused_until: until, reason: reason || null },
    });

    res.json({ success: true, paused_until: until });
  } catch (err) { next(err); }
});

/**
 * POST /api/billing/autopay/resume — clear pause immediately.
 */
router.post('/resume', autopayWriteLimiter, async (req, res, next) => {
  try {
    await db('customers').where({ id: req.customerId }).update({
      autopay_paused_until: null,
      autopay_pause_reason: null,
    });

    await logAutopay(req.customerId, 'autopay_resumed', { details: {} });

    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
