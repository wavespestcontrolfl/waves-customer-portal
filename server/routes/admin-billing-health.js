const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const db = require('../models/db');
const logger = require('../services/logger');
const PaymentRouter = require('../services/payment-router');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { logAutopay } = require('../services/autopay-log');
const { etDateString } = require('../utils/datetime-et');

router.use(adminAuthenticate);
router.use(requireAdmin);

/**
 * GET /api/admin/customers/:id/autopay-state — admin read of autopay + recent events.
 */
router.get('/customers/:id/autopay-state', async (req, res, next) => {
  try {
    const customerId = req.params.id;
    const customer = await db('customers')
      .where({ id: customerId })
      .select(
        'id', 'monthly_rate', 'waveguard_tier',
        'autopay_enabled', 'autopay_paused_until', 'autopay_pause_reason',
        'autopay_payment_method_id', 'billing_day', 'next_charge_date',
      )
      .first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const pausedUntil = customer.autopay_paused_until ? new Date(customer.autopay_paused_until) : null;
    const isPaused = !!(pausedUntil && pausedUntil >= new Date(new Date().toDateString()));
    let state = 'disabled';
    if (customer.autopay_enabled && !isPaused) state = 'active';
    else if (customer.autopay_enabled && isPaused) state = 'paused';

    const recent_events = await db('autopay_log')
      .where({ customer_id: customerId })
      .orderBy('created_at', 'desc')
      .limit(20);

    res.json({
      state,
      autopay_enabled: !!customer.autopay_enabled,
      paused_until: customer.autopay_paused_until,
      pause_reason: customer.autopay_pause_reason,
      autopay_payment_method_id: customer.autopay_payment_method_id,
      billing_day: customer.billing_day || 1,
      next_charge_date: customer.next_charge_date,
      monthly_rate: customer.monthly_rate,
      recent_events,
    });
  } catch (err) { next(err); }
});

/**
 * POST /api/admin/customers/:id/charge-now
 * Body: { amount?: number, description?: string }
 * If amount omitted, charges customer.monthly_rate.
 */
router.post('/customers/:id/charge-now', async (req, res, next) => {
  try {
    const customerId = req.params.id;
    const { amount, description } = req.body || {};

    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const chargeAmount = amount != null
      ? parseFloat(amount)
      : parseFloat(customer.monthly_rate || 0);

    if (!chargeAmount || chargeAmount <= 0) {
      return res.status(400).json({ error: 'No amount to charge (monthly_rate is 0 or unset)' });
    }

    const service = await PaymentRouter.getServiceForCustomer(customerId);
    const desc = description || `Manual charge — WaveGuard ${customer.waveguard_tier || ''}`.trim();

    let payment;
    try {
      payment = await service.chargeOneTime(customerId, chargeAmount, desc);
    } catch (err) {
      await logAutopay(customerId, 'charge_failed', {
        amountCents: Math.round(chargeAmount * 100),
        details: { source: 'manual_charge', reason: err.message, admin_id: req.technicianId || null },
      });
      return res.status(502).json({ error: err.message });
    }

    await logAutopay(customerId, 'manual_charge', {
      amountCents: Math.round(chargeAmount * 100),
      paymentId: payment?.id || null,
      details: { source: 'manual_charge', description: desc, admin_id: req.technicianId || null },
    });

    // Send receipt SMS
    let receiptUrl = null;
    try {
      const raw = payment?.metadata;
      const meta = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
      receiptUrl = meta.stripe_receipt_url || null;
    } catch (_) {}

    if (customer.phone) {
      try {
        const receiptLine = receiptUrl ? ` View receipt: ${receiptUrl}` : '';
        const result = await sendCustomerMessage({
          audience: 'customer',
          channel: 'sms',
          to: customer.phone,
          customerId,
          purpose: 'billing',
          identityTrustLevel: 'admin_operator',
          body: `Hi ${customer.first_name}, your payment to Waves was successfully processed. Thank you!${receiptLine}`,
          metadata: { source: 'admin_manual_charge', paymentId: payment?.id || null },
        });
        if (!result?.sent) logger.warn(`[admin-billing] receipt SMS blocked: ${result?.code || 'unknown'}`);
      } catch (smsErr) {
        logger.error(`[admin-billing] receipt SMS failed: ${smsErr.message}`);
      }
    }

    res.json({ success: true, payment });
  } catch (err) { next(err); }
});

/**
 * GET /api/admin/billing-health
 * Returns a dashboard-ready snapshot of autopay health.
 */
router.get('/billing-health', async (req, res, next) => {
  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    const thirtyDaysAgo = new Date(); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const sixtyDaysOut = new Date(); sixtyDaysOut.setDate(sixtyDaysOut.getDate() + 60);

    // Active billable customers — `active=true` alone isn't enough,
    // soft-deleted customers can have active=true left over from before
    // the delete. whereNull('deleted_at') everywhere matches the rest
    // of the dashboard.
    const billable = await db('customers')
      .where({ active: true })
      .whereNull('deleted_at')
      .where('monthly_rate', '>', 0)
      .count('* as n').first();
    const totalBillable = parseInt(billable.n) || 0;

    // Autopay enabled / paused / disabled
    const enabled = await db('customers')
      .where({ active: true, autopay_enabled: true })
      .whereNull('deleted_at')
      .where('monthly_rate', '>', 0)
      .count('* as n').first();
    const disabled = await db('customers')
      .where({ active: true, autopay_enabled: false })
      .whereNull('deleted_at')
      .where('monthly_rate', '>', 0)
      .count('* as n').first();
    const paused = await db('customers')
      .where({ active: true, autopay_enabled: true })
      .whereNull('deleted_at')
      .where('monthly_rate', '>', 0)
      .whereNotNull('autopay_paused_until')
      .where('autopay_paused_until', '>=', etDateString(now))
      .count('* as n').first();

    // Customers with no autopay payment method
    const noMethod = await db('customers')
      .where({ active: true, autopay_enabled: true })
      .whereNull('deleted_at')
      .where('monthly_rate', '>', 0)
      .whereNull('autopay_payment_method_id')
      .count('* as n').first();

    // Failed payments in the last 30 days
    const failedRecent = await db('payments')
      .where({ status: 'failed' })
      .where('payment_date', '>=', thirtyDaysAgo.toISOString().split('T')[0])
      .count('* as n').first();

    // Payments in retry queue (pending retry)
    const inRetry = await db('payments')
      .where({ status: 'failed' })
      .where('retry_count', '<', 3)
      .whereNotNull('next_retry_at')
      .count('* as n').first();

    // Escalated (3 retries exhausted)
    const escalated = await db('payments')
      .where({ status: 'failed' })
      .where('retry_count', '>=', 3)
      .where('payment_date', '>=', thirtyDaysAgo.toISOString().split('T')[0])
      .count('* as n').first();

    // Charged this month (success)
    const chargedMonth = await db('payments')
      .whereIn('status', ['paid', 'processing'])
      .where('payment_date', '>=', monthStart)
      .where('description', 'like', '%WaveGuard Monthly%')
      .count('* as n').first();

    // Cards expiring in next 60 days (for active autopay customers)
    const expiringCards = await db('payment_methods')
      .join('customers', 'customers.id', 'payment_methods.customer_id')
      .where('customers.active', true)
      .whereNull('customers.deleted_at')
      .where('customers.autopay_enabled', true)
      .where('payment_methods.autopay_enabled', true)
      .whereRaw(
        "make_date(payment_methods.exp_year::int, payment_methods.exp_month::int, 1) <= ?",
        [sixtyDaysOut.toISOString().split('T')[0]]
      )
      .count('* as n').first()
      .catch(() => ({ n: 0 }));

    res.json({
      summary: {
        total_billable: totalBillable,
        autopay_active: Math.max(0, (parseInt(enabled.n) || 0) - (parseInt(paused.n) || 0)),
        autopay_paused: parseInt(paused.n) || 0,
        autopay_disabled: parseInt(disabled.n) || 0,
        no_payment_method: parseInt(noMethod.n) || 0,
        charged_this_month: parseInt(chargedMonth.n) || 0,
        failed_last_30_days: parseInt(failedRecent.n) || 0,
        in_retry_queue: parseInt(inRetry.n) || 0,
        escalated_last_30_days: parseInt(escalated.n) || 0,
        expiring_cards_60_days: parseInt(expiringCards.n) || 0,
      },
    });
  } catch (err) { next(err); }
});

/**
 * GET /api/admin/billing-health/at-risk
 * Customers needing attention — failed charges, no method, expiring cards.
 */
router.get('/billing-health/at-risk', async (req, res, next) => {
  try {
    const now = new Date();
    const sixtyDaysOut = new Date(); sixtyDaysOut.setDate(sixtyDaysOut.getDate() + 60);

    // No payment method
    const noMethod = await db('customers')
      .where({ active: true, autopay_enabled: true })
      .whereNull('deleted_at')
      .where('monthly_rate', '>', 0)
      .whereNull('autopay_payment_method_id')
      .select('id', 'first_name', 'last_name', 'phone', 'monthly_rate', 'waveguard_tier');

    // In retry queue
    const inRetry = await db('payments')
      .join('customers', 'customers.id', 'payments.customer_id')
      .where('payments.status', 'failed')
      .where('payments.retry_count', '<', 3)
      .whereNotNull('payments.next_retry_at')
      .select(
        'customers.id', 'customers.first_name', 'customers.last_name',
        'payments.id as payment_id', 'payments.amount', 'payments.retry_count',
        'payments.next_retry_at', 'payments.failure_reason',
      );

    // Escalated
    const escalated = await db('payments')
      .join('customers', 'customers.id', 'payments.customer_id')
      .where('payments.status', 'failed')
      .where('payments.retry_count', '>=', 3)
      .select(
        'customers.id', 'customers.first_name', 'customers.last_name',
        'payments.id as payment_id', 'payments.amount', 'payments.failure_reason',
        'payments.payment_date',
      );

    res.json({
      no_payment_method: noMethod,
      in_retry: inRetry,
      escalated,
    });
  } catch (err) { next(err); }
});

module.exports = router;
