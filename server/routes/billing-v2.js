const express = require('express');
const router = express.Router();
const Joi = require('joi');
const db = require('../models/db');
const PaymentRouter = require('../services/payment-router');
const StripeService = require('../services/stripe');
const stripeConfig = require('../config/stripe-config');
const { authenticate } = require('../middleware/auth');
const logger = require('../services/logger');
const PaymentLifecycleEmail = require('../services/payment-lifecycle-email');

router.use(authenticate);

// =========================================================================
// GET /api/billing — Payment history (routed to correct processor)
// =========================================================================
router.get('/', async (req, res, next) => {
  try {
    const requestedLimit = parseInt(req.query.limit) || 20;
    const service = await PaymentRouter.getServiceForCustomer(req.customerId);

    // Third-party Bill-To: a payment against a payer-billed invoice belongs to
    // the payer (AP contact), not the homeowner — drop those rows so the
    // logged-in customer never sees the payer's card brand / last4 / Stripe
    // PaymentIntent id in their own history. Over-fetch first so excluding those
    // rows still returns up to `requestedLimit` customer-visible payments (the
    // exclusion can't be a SQL filter without casting arbitrary payment metadata
    // to jsonb table-wide). Payer payments are a small minority, so a padded
    // buffer fills the page in realistic cases.
    const payerInvRows = await db('invoices')
      .where({ customer_id: req.customerId })
      .whereNotNull('payer_id')
      .select('id')
      .catch(() => []);
    const payerInvoiceIds = new Set(payerInvRows.map((r) => String(r.id)));
    const invoiceIdOf = (p) => {
      try {
        const m = typeof p.metadata === 'string' ? JSON.parse(p.metadata) : p.metadata;
        return m && m.invoice_id != null ? String(m.invoice_id) : null;
      } catch {
        return null;
      }
    };
    const isPayerLinked = (p) => {
      const invId = invoiceIdOf(p);
      return !!(invId && payerInvoiceIds.has(invId));
    };
    let visiblePayments;
    if (payerInvoiceIds.size === 0) {
      visiblePayments = await service.getPaymentHistory(req.customerId, requestedLimit);
    } else {
      // Page through history (excluding payer-linked rows) until we have the
      // requested number of customer-visible payments or the table is exhausted.
      // Avoids both under-filling (a hard cap that drops payer rows) and a
      // metadata::jsonb cast over the whole payments table.
      visiblePayments = [];
      const pageSize = Math.max(requestedLimit, 20);
      let offset = 0;
      // Bound the loop so a customer with a huge history of payer payments can't
      // scan unboundedly; ~10 pages is far beyond any realistic visible page.
      for (let page = 0; page < 10 && visiblePayments.length < requestedLimit; page += 1) {
        const batch = await service.getPaymentHistory(req.customerId, pageSize, offset);
        if (!batch.length) break;
        for (const p of batch) {
          if (!isPayerLinked(p)) visiblePayments.push(p);
          if (visiblePayments.length >= requestedLimit) break;
        }
        if (batch.length < pageSize) break; // exhausted
        offset += pageSize;
      }
      visiblePayments = visiblePayments.slice(0, requestedLimit);
    }

    res.json({
      payments: visiblePayments.map(p => ({
        id: p.id,
        date: p.payment_date,
        amount: parseFloat(p.amount),
        status: p.status,
        description: p.description,
        cardBrand: p.card_brand,
        lastFour: p.last_four,
        processor: 'stripe',
        methodType: p.method_type || 'card',
        bankName: p.bank_name || null,
        stripePaymentIntentId: p.stripe_payment_intent_id || null,
        refundAmount: p.refund_amount ? parseFloat(p.refund_amount) : null,
        refundStatus: p.refund_status || null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /api/billing/cards — All payment methods (both processors)
// =========================================================================
router.get('/cards', async (req, res, next) => {
  try {
    const cards = await db('payment_methods')
      .where({ customer_id: req.customerId })
      .orderBy('is_default', 'desc')
      .orderBy('created_at', 'desc');

    res.json({
      cards: cards.map(c => ({
        id: c.id,
        processor: 'stripe',
        methodType: c.method_type || 'card',
        brand: c.card_brand,
        lastFour: c.last_four,
        expMonth: c.exp_month,
        expYear: c.exp_year,
        isDefault: c.is_default,
        autopayEnabled: c.autopay_enabled,
        bankName: c.bank_name || null,
        bankLastFour: c.bank_last_four || null,
        achStatus: c.ach_status || null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /api/billing/processor — Stripe publishable key + availability
// =========================================================================
router.get('/processor', async (req, res, next) => {
  try {
    res.json({
      processor: 'stripe',
      stripe: {
        available: StripeService.isAvailable(),
        publishableKey: stripeConfig.publishableKey || null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /api/billing/cards/setup-intent — Create Stripe SetupIntent
// =========================================================================
router.post('/cards/setup-intent', async (req, res, next) => {
  try {
    const schema = Joi.object({
      paymentMethodType: Joi.string().valid('card', 'us_bank_account', 'card_or_bank').default('card'),
    });

    const { paymentMethodType } = await schema.validateAsync(req.body);
    const result = await StripeService.createSetupIntent(req.customerId, paymentMethodType);

    res.json({
      clientSecret: result.clientSecret,
      setupIntentId: result.setupIntentId,
      publishableKey: stripeConfig.publishableKey,
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /api/billing/cards — Save a payment method (Stripe)
// =========================================================================
router.post('/cards', async (req, res, next) => {
  try {
    const schema = Joi.object({
      // Stripe: paymentMethodId from confirmed SetupIntent
      paymentMethodId: Joi.string().allow(null, '').optional(),
      setupIntentId: Joi.string().required(),
    });

    const { paymentMethodId, setupIntentId } = await schema.validateAsync(req.body);
    const setupIntent = await StripeService.retrieveSetupIntent(setupIntentId);
    const setupPaymentMethodId = typeof setupIntent?.payment_method === 'string'
      ? setupIntent.payment_method
      : setupIntent?.payment_method?.id;
    const resolvedPaymentMethodId = paymentMethodId || setupPaymentMethodId;
    if (!setupIntent || setupIntent.status !== 'succeeded' || !resolvedPaymentMethodId || setupPaymentMethodId !== resolvedPaymentMethodId) {
      return res.status(409).json({
        error: 'Payment method setup is not complete. Finish verification before enabling Auto Pay.',
        setupIntentStatus: setupIntent?.status || 'unknown',
      });
    }

    const currentAutopayMethod = await db('payment_methods')
      .where({
        customer_id: req.customerId,
        processor: 'stripe',
        is_default: true,
        autopay_enabled: true,
      })
      .whereNotNull('stripe_payment_method_id')
      .first('id');

    // Adding a saved card is not the same as enrolling in Auto Pay. The
    // customer-facing Auto Pay card explicitly selects and enables the
    // payment method through /api/billing/autopay after save. If another
    // method already powers autopay, keep it as the default until then.
    const card = await StripeService.savePaymentMethod(req.customerId, resolvedPaymentMethodId, {
      enableAutopay: false,
      makeDefault: !currentAutopayMethod,
    });

    // Record consent — the portal add-card modal shows SaveCardConsent
    // as locked + checked because saving is the whole point of the
    // modal. Arriving here means the customer saw the copy.
    try {
      const ConsentService = require('../services/payment-method-consents');
      await ConsentService.recordConsent({
        customerId: req.customerId,
        paymentMethodId: card.id,
        stripePaymentMethodId: resolvedPaymentMethodId,
        source: 'portal_add_card',
        methodType: card.method_type || 'card',
        ip: req.ip,
        userAgent: req.get('user-agent') || null,
      });
    } catch (consentErr) {
      logger.error(`[billing-v2] Consent record failed: ${consentErr.message}`);
    }

    res.json({
      success: true,
      card: {
        id: card.id,
        processor: 'stripe',
        methodType: card.method_type || 'card',
        brand: card.card_brand,
        lastFour: card.last_four,
        expMonth: card.exp_month,
        expYear: card.exp_year,
        isDefault: card.is_default,
        bankName: card.bank_name || null,
        bankLastFour: card.bank_last_four || null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// DELETE /api/billing/cards/:id — Remove a payment method (auto-detect)
// =========================================================================
router.delete('/cards/:id', async (req, res, next) => {
  try {
    const card = await db('payment_methods')
      .where({ id: req.params.id, customer_id: req.customerId })
      .first();

    if (!card) return res.status(404).json({ error: 'Payment method not found' });

    await StripeService.removeCard(req.customerId, req.params.id);

    res.json({ success: true, message: 'Payment method removed' });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /api/billing/balance — Outstanding balance
// =========================================================================
router.get('/balance', async (req, res, next) => {
  try {
    const customer = req.customer;

    // Third-party Bill-To: a payment against a payer-billed invoice is the
    // payer's, even though the row sits under the homeowner's customer_id. Pull
    // this customer's payer-billed invoice ids once so the failed-balance sum and
    // the "last payment failed" banner can exclude those rows (otherwise an AP
    // payment failure would show as the homeowner's own balance / failure).
    const payerInvRows = await db('invoices')
      .where({ customer_id: req.customerId })
      .whereNotNull('payer_id')
      .select('id')
      .catch(() => []);
    const payerInvoiceIds = new Set(payerInvRows.map((r) => String(r.id)));
    const metadataInvoiceId = (p) => {
      try {
        const m = typeof p.metadata === 'string' ? JSON.parse(p.metadata) : p.metadata;
        return m && m.invoice_id != null ? String(m.invoice_id) : null;
      } catch {
        return null;
      }
    };
    const isPayerPayment = (p) => {
      const invId = metadataInvoiceId(p);
      return !!(invId && payerInvoiceIds.has(invId));
    };

    // Failed attempts whose retry later collected are superseded — the
    // money arrived on the retry's own paid row, so they must not count
    // as balance still owed (the customer would be shown — and could
    // pay — an amount already taken). Payer-linked failures are excluded too.
    const failedRows = await db('payments')
      .where({ customer_id: req.customerId, status: 'failed' })
      .whereNull('superseded_by_payment_id')
      .select('amount', 'metadata');
    const failedTotal = failedRows
      .filter((p) => !isPayerPayment(p))
      .reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);

    // Upcoming (scheduled autopay) rows: exclude payer-linked ones too, so the
    // homeowner's upcomingCharges / nextCharge never show the payer's amount/date.
    const upcomingRows = await db('payments')
      .where({ customer_id: req.customerId, status: 'upcoming' })
      .orderBy('payment_date', 'asc')
      .select('amount', 'payment_date', 'description', 'metadata');
    const visibleUpcoming = upcomingRows.filter((p) => !isPayerPayment(p));
    const upcomingTotal = visibleUpcoming.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
    const nextPayment = visibleUpcoming[0] || null;

    // Check for unpaid invoices. Third-party Bill-To: a payer-billed invoice is
    // owed by the payer, not the homeowner — exclude it so the logged-in
    // customer never sees the payer's unpaid amount as their own balance.
    const unpaidInvoices = await db('invoices')
      .where({ customer_id: req.customerId })
      .whereIn('status', ['sent', 'viewed', 'overdue'])
      .whereNull('payer_id')
      // Outstanding balance = amount DUE (total − applied account credit), not the
      // raw total, so the portal balance matches what Stripe/Terminal actually charge.
      .select(db.raw('COALESCE(SUM(GREATEST(total - COALESCE(credit_applied, 0), 0)), 0) AS total'))
      .first();

    // The portal's billing banner flips to "failed" when the most recent
    // completed attempt failed — not when there's any failed row in history.
    // Skip payer-linked attempts so an AP failure doesn't flip the homeowner's
    // banner.
    // Bounded scan: with no payer rows to skip, the most-recent attempt is just
    // the first row (the pre-payer-filter behavior). Only when payer rows exist
    // do we look past them — page in small batches (capped) so this billing-page
    // load never scales with the customer's full ledger.
    const recentAttemptsQuery = () => db('payments')
      .where({ customer_id: req.customerId })
      .whereIn('status', ['paid', 'failed', 'refunded'])
      .whereNull('superseded_by_payment_id')
      .orderBy('payment_date', 'desc')
      .select('status', 'metadata');
    let mostRecentAttempt = null;
    if (payerInvoiceIds.size === 0) {
      mostRecentAttempt = await recentAttemptsQuery().first();
    } else {
      const PAGE = 50;
      for (let offset = 0; offset < 500; offset += PAGE) {
        const batch = await recentAttemptsQuery().limit(PAGE).offset(offset);
        if (!batch.length) break;
        mostRecentAttempt = batch.find((p) => !isPayerPayment(p)) || null;
        if (mostRecentAttempt || batch.length < PAGE) break;
      }
    }

    res.json({
      currentBalance: failedTotal + parseFloat(unpaidInvoices?.total || 0),
      upcomingCharges: upcomingTotal,
      monthlyRate: parseFloat(customer.monthly_rate || 0),
      tier: customer.waveguard_tier,
      processor: 'stripe',
      nextCharge: nextPayment ? {
        amount: parseFloat(nextPayment.amount),
        date: nextPayment.payment_date,
        description: nextPayment.description,
      } : null,
      lastPaymentFailed: mostRecentAttempt?.status === 'failed',
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// PUT /api/billing/cards/:id/default — Set a card as default
// =========================================================================
router.put('/cards/:id/default', async (req, res, next) => {
  try {
    const currentDefault = await db('payment_methods')
      .where({ customer_id: req.customerId, is_default: true })
      .first('id');

    const card = await db('payment_methods')
      .where({ id: req.params.id, customer_id: req.customerId })
      .first();

    if (!card) return res.status(404).json({ error: 'Payment method not found' });

    await db('payment_methods')
      .where({ customer_id: req.customerId })
      .update({ is_default: false });

    await db('payment_methods')
      .where({ id: req.params.id })
      .update({ is_default: true });

    if (currentDefault?.id !== card.id) {
      PaymentLifecycleEmail.sendPaymentMethodUpdated({
        customerId: req.customerId,
        oldPaymentMethodId: currentDefault?.id || null,
        newPaymentMethodId: card.id,
        updatedAt: new Date(),
      }).catch((emailErr) => {
        logger.warn(`[billing-v2] default payment method email failed for customer ${req.customerId}: ${emailErr.message}`);
      });
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
