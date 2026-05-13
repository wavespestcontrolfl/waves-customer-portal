const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { authenticate } = require('../middleware/auth');
const db = require('../models/db');
const logger = require('../services/logger');
const { logAutopay, getRecent } = require('../services/autopay-log');
const { isChargeableAutopayMethod } = require('../services/autopay-eligibility');
const { computeChargeAmount } = require('../services/stripe-pricing');

router.use(authenticate);

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
      )
      .first();

    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const paymentMethods = await db('payment_methods')
      .where({ customer_id: req.customerId })
      .select(
        'id',
        db.raw('card_brand as brand'),
        db.raw('last_four as last4'),
        'exp_month', 'exp_year', 'is_default', 'autopay_enabled',
      )
      .orderBy('is_default', 'desc')
      .orderBy('created_at', 'desc');

    const pausedUntil = customer.autopay_paused_until ? new Date(customer.autopay_paused_until) : null;
    const isPaused = !!(pausedUntil && pausedUntil >= new Date(new Date().toDateString()));

    const chargeableAutopayMethod = await db('payment_methods')
      .where({
        customer_id: req.customerId,
        processor: 'stripe',
        is_default: true,
        autopay_enabled: true,
      })
      .first('id', 'processor', 'method_type', 'stripe_payment_method_id', 'is_default', 'autopay_enabled');
    const hasAutopayMethod = isChargeableAutopayMethod(chargeableAutopayMethod);
    const customerAutopayEnabled = !!customer.autopay_enabled && hasAutopayMethod;
    const nextCharge = customerAutopayEnabled
      ? computeChargeAmount(customer.monthly_rate || 0, chargeableAutopayMethod.method_type)
      : null;

    let state = 'disabled';
    if (customerAutopayEnabled && !isPaused) state = 'active';
    else if (customerAutopayEnabled && isPaused) state = 'paused';

    const recentEvents = await getRecent(req.customerId, 10);

    res.json({
      state,
      autopay_enabled: customerAutopayEnabled,
      paused_until: customer.autopay_paused_until,
      pause_reason: customer.autopay_pause_reason,
      autopay_payment_method_id: hasAutopayMethod ? chargeableAutopayMethod.id : null,
      billing_day: customer.billing_day || 1,
      next_charge_date: customer.next_charge_date,
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
      .select('autopay_enabled', 'autopay_payment_method_id', 'billing_day')
      .first();

    if (!current) return res.status(404).json({ error: 'Customer not found' });

    const willBeEnabled = typeof autopay_enabled === 'boolean' ? autopay_enabled : current.autopay_enabled;

    let selectedPaymentMethod = null;
    if (autopay_payment_method_id) {
      selectedPaymentMethod = await db('payment_methods')
        .where({ id: autopay_payment_method_id, customer_id: req.customerId })
        .first('id', 'processor', 'stripe_payment_method_id');
      if (!selectedPaymentMethod) return res.status(400).json({ error: 'Payment method not found' });
    } else if (autopay_payment_method_id === null || autopay_payment_method_id === '') {
      selectedPaymentMethod = null;
    } else if (current.autopay_payment_method_id) {
      selectedPaymentMethod = await db('payment_methods')
        .where({ id: current.autopay_payment_method_id, customer_id: req.customerId })
        .first('id', 'processor', 'stripe_payment_method_id');
    } else if (willBeEnabled) {
      selectedPaymentMethod = await db('payment_methods')
        .where({ customer_id: req.customerId, is_default: true, processor: 'stripe' })
        .whereNotNull('stripe_payment_method_id')
        .orderBy('created_at', 'desc')
        .first('id', 'processor', 'stripe_payment_method_id');
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
        .first('id', 'processor', 'stripe_payment_method_id');
    }

    const methodCanChargeAutopay = selectedPaymentMethod?.processor === 'stripe'
      && !!selectedPaymentMethod?.stripe_payment_method_id;

    if (willBeEnabled && !methodCanChargeAutopay) {
      return res.status(400).json({ error: 'Add a payment method before enabling Auto Pay.' });
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

    const untilDate = new Date(until);
    if (isNaN(untilDate.getTime())) return res.status(400).json({ error: 'invalid date' });
    if (untilDate <= new Date()) return res.status(400).json({ error: 'date must be in the future' });

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
