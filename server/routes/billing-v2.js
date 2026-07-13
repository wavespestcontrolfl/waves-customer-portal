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
const { logAutopay } = require('../services/autopay-log');

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

    // Recurring = the monthly WaveGuard plan obligation. Metadata-first, same
    // rule as billing-cron's dedupe: every monthly-autopay row (chargeMonthly,
    // retry rungs, admin charge-now) carries a metadata.billed_month stamp.
    // The canonical "<tier> WaveGuard Monthly" description marker stays as the
    // legacy fallback for rows written before the stamp existed. Description
    // wording alone (e.g. a row that merely says "Monthly") is NOT a signal.
    const isRecurringPayment = (p) => {
      try {
        const m = typeof p.metadata === 'string' ? JSON.parse(p.metadata) : p.metadata;
        if (m && m.billed_month) return true;
      } catch { /* unparseable metadata — fall through to the marker */ }
      return (p.description || '').includes('WaveGuard Monthly');
    };

    res.json({
      payments: visiblePayments.map(p => ({
        id: p.id,
        date: p.payment_date,
        amount: parseFloat(p.amount),
        status: p.status,
        description: p.description,
        // The client's Recurring/One-Time filter and YTD split read this —
        // it was previously never serialized (always $0.00).
        type: isRecurringPayment(p) ? 'recurring' : 'one_time',
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
// GET /api/billing/cards/:id/bank-verification-link — resume micro-deposit
// verification (portal ACH lane, Codex #2706 r3): the hosted URL only
// lives in browser state at save time; this rebuilds it from the persisted
// SetupIntent id so a reload can't strand a pending bank row. Also heals
// stale rows: a succeeded SI marks the row verified, a dead SI marks it
// failed.
// =========================================================================
router.get('/cards/:id/bank-verification-link', async (req, res, next) => {
  try {
    const featureGates = require('../config/feature-gates');
    if (!featureGates.isEnabled('portalAchAutopay')) {
      return res.status(404).json({ error: 'Not available' });
    }
    const row = await db('payment_methods')
      .where({ id: req.params.id, customer_id: req.customerId })
      .first();
    if (!row || row.method_type !== 'ach' || !row.stripe_setup_intent_id) {
      return res.status(404).json({ error: 'No verification in progress for this payment method' });
    }
    const si = await StripeService.retrieveSetupIntent(row.stripe_setup_intent_id);
    if (!si) return res.status(404).json({ error: 'No verification in progress for this payment method' });
    if (si.status === 'succeeded') {
      // Stale pending row (missed webhook) — heal the visible state.
      // Enrollment keeps its consent-gated webhook/POST path; this only
      // fixes what the customer sees and what the autopay guards read.
      if (row.ach_status !== 'verified') {
        await db('payment_methods').where({ id: row.id }).update({ ach_status: 'verified' });
        await db('customers')
          .where({ id: req.customerId, ach_status: 'needs_verification' })
          .update({ ach_status: 'active' });
      }
      return res.json({ verified: true });
    }
    if (si.status === 'requires_action' && si.next_action?.type === 'verify_with_microdeposits') {
      return res.json({ url: si.next_action.verify_with_microdeposits?.hosted_verification_url || null });
    }
    // Canceled/failed SI — stop the row reading as pending forever.
    if (row.ach_status === 'pending_verification') {
      await db('payment_methods').where({ id: row.id }).update({ ach_status: 'verification_failed' });
    }
    return res.json({ failed: true });
  } catch (err) { next(err); }
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
    // Portal bank saves are gated (GATE_PORTAL_ACH_AUTOPAY): with the gate
    // off, a bank-inclusive request downgrades to card-only rather than
    // erroring — the Payment Element simply doesn't offer the bank tab.
    // Server-authoritative: this also closes the pre-existing leak where
    // the AutopayCard minted card_or_bank unconditionally while the
    // customer saw the CARD consent copy. The response echoes the
    // effective types so the client renders bank affordances (ACH consent
    // variant, no-surcharge line) only when the bank tab can actually
    // appear.
    const featureGates = require('../config/feature-gates');
    const achAllowed = featureGates.isEnabled('portalAchAutopay');
    const effectiveType = !achAllowed && paymentMethodType !== 'card' ? 'card' : paymentMethodType;
    const result = await StripeService.createSetupIntent(req.customerId, effectiveType, {
      // Routes setup_intent.succeeded completion for the micro-deposit
      // deferred save (see POST /cards + the stripe-webhook
      // portal_add_method branch). Card intents carry it too — the webhook
      // branch is idempotent alongside the synchronous save below.
      metadata: { purpose: 'portal_add_method' },
    });

    res.json({
      clientSecret: result.clientSecret,
      setupIntentId: result.setupIntentId,
      publishableKey: stripeConfig.publishableKey,
      paymentMethodTypes: result.paymentMethodTypes,
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
    const setupIntent = await StripeService.retrieveSetupIntent(setupIntentId, { expand: ['payment_method'] });
    const setupPaymentMethodId = typeof setupIntent?.payment_method === 'string'
      ? setupIntent.payment_method
      : setupIntent?.payment_method?.id;
    const resolvedPaymentMethodId = paymentMethodId || setupPaymentMethodId;
    const setupPaymentMethodType = typeof setupIntent?.payment_method === 'object'
      ? setupIntent?.payment_method?.type || null
      : null;

    // Kill-switch integrity (Codex #2706 r3): the mint route downgrades
    // NEW requests while GATE_PORTAL_ACH_AUTOPAY is off, but an in-flight
    // bank SetupIntent minted before the flip could still complete here —
    // refuse it BEFORE any mirror/consent/enrollment so the gate actually
    // closes the whole portal bank lane. (Banks saved and enrolled through
    // the live pay-page flow are untouched — this route is the portal add
    // lane.)
    const featureGates = require('../config/feature-gates');
    const achAllowed = featureGates.isEnabled('portalAchAutopay');
    if (setupPaymentMethodType === 'us_bank_account' && !achAllowed) {
      return res.status(409).json({
        error: 'Bank accounts aren’t available right now. Add a card instead.',
      });
    }

    // Micro-deposit deferred save (portal ACH lane): a bank SetupIntent
    // that fell back from Financial Connections stays requires_action for
    // 1–2 business days while Stripe sends the deposits. The method is
    // saved PENDING — never default, never enrolled — and the ACH consent
    // is recorded NOW (the customer authorized at signup; the first debit
    // only ever happens post-verification). Enrollment completes in the
    // setup_intent.succeeded webhook (portal_add_method branch). Gated:
    // with the gate off the mint above was card-only, so this state is
    // unreachable through our own client.
    const awaitingMicrodeposits = setupIntent?.status === 'requires_action'
      && setupIntent?.next_action?.type === 'verify_with_microdeposits'
      && !!resolvedPaymentMethodId
      && setupPaymentMethodId === resolvedPaymentMethodId;
    if (awaitingMicrodeposits && achAllowed) {
      let pendingRow = await db('payment_methods')
        .where({ stripe_payment_method_id: resolvedPaymentMethodId })
        .first();
      if (pendingRow && pendingRow.customer_id !== req.customerId) {
        logger.warn(`[billing-v2] add-bank pm ownership mismatch: pm ${resolvedPaymentMethodId} belongs to ${pendingRow.customer_id}, caller ${req.customerId}`);
        return res.status(409).json({ error: 'Payment method belongs to another account' });
      }
      if (!pendingRow) {
        pendingRow = await StripeService.savePaymentMethod(req.customerId, resolvedPaymentMethodId, {
          enableAutopay: false,
          makeDefault: false,
          achStatus: 'pending_verification',
        });
      }
      // Durable resume handle (Codex r3): the hosted verification URL only
      // lives in browser state — persist the SetupIntent id so
      // GET /cards/:id/bank-verification-link can rebuild the link after a
      // reload instead of stranding a permanently pending row.
      if (!pendingRow.stripe_setup_intent_id) {
        await db('payment_methods').where({ id: pendingRow.id }).update({ stripe_setup_intent_id: setupIntentId });
      }
      const ConsentService = require('../services/payment-method-consents');
      if (!(await ConsentService.hasConsentFor(req.customerId, resolvedPaymentMethodId))) {
        await ConsentService.recordConsent({
          customerId: req.customerId,
          paymentMethodId: pendingRow.id,
          stripePaymentMethodId: resolvedPaymentMethodId,
          source: 'portal_add_bank',
          methodType: pendingRow.method_type || 'ach',
          ip: req.ip,
          userAgent: req.get('user-agent') || null,
        });
      }
      return res.json({
        success: true,
        pendingVerification: true,
        card: {
          id: pendingRow.id,
          processor: 'stripe',
          methodType: pendingRow.method_type || 'ach',
          brand: null,
          lastFour: pendingRow.last_four,
          isDefault: pendingRow.is_default,
          bankName: pendingRow.bank_name || null,
          bankLastFour: pendingRow.bank_last_four || null,
          achStatus: pendingRow.ach_status || 'pending_verification',
        },
      });
    }

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

    // Idempotent save (lookup-first like /setup-complete): a retry after a
    // partial first attempt (saved, but consent/enrollment failed below)
    // must continue with the existing row — savePaymentMethod is a plain
    // insert and stripe_payment_method_id is unique. Ownership fails
    // closed.
    let card = await db('payment_methods')
      .where({ stripe_payment_method_id: resolvedPaymentMethodId })
      .first();
    if (card && card.customer_id !== req.customerId) {
      logger.warn(`[billing-v2] add-card pm ownership mismatch: pm ${resolvedPaymentMethodId} belongs to ${card.customer_id}, caller ${req.customerId}`);
      return res.status(409).json({ error: 'Payment method belongs to another account' });
    }
    if (!card) {
      card = await StripeService.savePaymentMethod(req.customerId, resolvedPaymentMethodId, {
        enableAutopay: false,
        makeDefault: !currentAutopayMethod,
      });
    }

    // Returned-from-hosted-verification (Codex #2706 r2): the SetupIntent
    // is succeeded, so a micro-deposit row still marked pending is now
    // VERIFIED — the customer beat the setup_intent.succeeded webhook back
    // to the portal. Without this mirror of the webhook's update, the
    // enrollment below runs against a row the autopay routes still refuse.
    // Same mirror for the customer-level needs_verification block (r3) —
    // enrollConsentedMethod refuses ACH targets while it's non-active, so
    // clearing only the row still 409'd this return path. 'suspended'
    // deliberately stays (see the webhook branch).
    if (card.method_type === 'ach' && card.ach_status !== 'verified') {
      await db('payment_methods').where({ id: card.id }).update({ ach_status: 'verified' });
      card.ach_status = 'verified';
      await db('customers')
        .where({ id: req.customerId, ach_status: 'needs_verification' })
        .update({ ach_status: 'active' });
    }

    // Record consent — the portal add-card modal shows SaveCardConsent
    // as locked + checked because saving is the whole point of the
    // modal. Arriving here means the customer saw the copy. Enrollment is
    // consent-gated and UNIVERSAL across save surfaces (Codex #2507): the
    // same locked copy that enrolls a pay-page save enrolls a portal save,
    // so a customer who adds a method here is on Auto Pay too — a healthy
    // method already powering autopay keeps the default role
    // (enrollConsentedMethod's incumbent semantics), matching the old
    // "don't displace the current autopay card" behavior. If the consent
    // insert fails, NO enrollment happens (the gate is the row).
    //
    // Consent/enrollment failures FAIL the request (Codex #2507 round-7
    // P2): this route has no webhook or later /consent retry behind it,
    // and the client refreshes the Auto Pay card off this response — a
    // swallowed failure would show Auto Pay off with no retry path while
    // the method sits saved-only. The save above is idempotent, so the
    // customer's retry re-enters here and completes consent + enrollment.
    const ConsentService = require('../services/payment-method-consents');
    await ConsentService.recordConsent({
      customerId: req.customerId,
      paymentMethodId: card.id,
      stripePaymentMethodId: resolvedPaymentMethodId,
      // Distinct audit source for bank saves (portal ACH lane) — the
      // snapshot itself is already method-correct via methodType.
      source: card.method_type === 'ach' ? 'portal_add_bank' : 'portal_add_card',
      methodType: card.method_type || 'card',
      ip: req.ip,
      userAgent: req.get('user-agent') || null,
    });
    const { enrollConsentedMethod } = require('../services/autopay-enrollment');
    const enrollment = await enrollConsentedMethod({
      customerId: req.customerId,
      paymentMethodId: card.id,
      source: 'portal_add_card',
    });
    // A REFUSED enrollment (ach_blocked bank save while the customer's ACH
    // state is unhealthy, or a vanished row) must not 200 (Codex #2507
    // round-8 P2): the client refreshes Auto Pay off this response, so a
    // success-looking reply turns the universal-save promise into a silent
    // saved-only method with no retry or error path. already_enrolled is
    // the benign incumbent case. The method row itself stays saved either
    // way — a retry re-enters through the lookup-first save above.
    if (!enrollment.enrolled && enrollment.reason !== 'already_enrolled') {
      logger.warn(`[billing-v2] add-card enrollment refused (${enrollment.reason}) for customer ${req.customerId} pm ${card.id}`);
      return res.status(409).json({
        error: enrollment.reason === 'ach_blocked'
          ? 'Payment method saved, but Auto Pay can’t use this bank account until its verification clears — add a card to enable Auto Pay, or try again once the bank account is verified.'
          : 'Payment method saved, but Auto Pay could not be enabled — please try again.',
        enrollReason: enrollment.reason,
      });
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
    // INVOICE-LINKED failures (metadata.invoice_id) are also excluded: the
    // obligation they were collecting lives on the invoice row itself — while
    // the invoice is open it's already counted in unpaidInvoices below, and
    // once it settles nothing is owed — so summing the attempt row would count
    // the same debt twice, forever (nothing supersedes these rows: no
    // next_retry_at for the sweep, and a fresh pay-page attempt mints a new
    // PI). EXCEPTION: a failure linked to a DRAFT invoice keeps counting —
    // unpaidInvoices only sums sent/viewed/overdue, so dropping the row too
    // would show $0 owed after a failed completion autopay whose draft
    // invoice/pay-link is still collectible (Codex P2 on this PR).
    const failedRows = await db('payments')
      .where({ customer_id: req.customerId, status: 'failed' })
      .whereNull('superseded_by_payment_id')
      .select('amount', 'metadata');
    const failedInvoiceIds = [...new Set(failedRows.map(metadataInvoiceId).filter(Boolean))];
    const balanceCarryingInvoiceIds = new Set(
      failedInvoiceIds.length
        ? (await db('invoices')
            .whereIn('id', failedInvoiceIds)
            .whereNot({ status: 'draft' })
            .select('id')
            .catch(() => [])).map((r) => String(r.id))
        : [],
    );
    const failedTotal = failedRows
      .filter((p) => !isPayerPayment(p))
      .filter((p) => {
        const invId = metadataInvoiceId(p);
        return !invId || !balanceCarryingInvoiceIds.has(invId);
      })
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
      .first('id', 'autopay_enabled');

    const card = await db('payment_methods')
      .where({ id: req.params.id, customer_id: req.customerId })
      .first();

    if (!card) return res.status(404).json({ error: 'Payment method not found' });

    // A bank account that isn't chargeable can't take the default role
    // (portal ACH lane): this route CARRIES autopay onto the new default.
    // Pending/failed verification would point collection at an account
    // that can't be debited, and a customer-level ACH block (Codex r3)
    // means customerOnAutopay/cron treat a bank default as inactive — a
    // suspended customer clicking Set default on a bank would silently
    // turn a chargeable card setup into one that never collects.
    if (card.method_type === 'ach' && ['pending_verification', 'verification_failed'].includes(card.ach_status)) {
      return res.status(400).json({
        error: card.ach_status === 'verification_failed'
          ? 'This bank account could not be verified. Remove it and add it again.'
          : 'This bank account is still being verified. You can make it your default as soon as verification clears.',
      });
    }
    if (card.method_type === 'ach') {
      const achCustomer = await db('customers').where({ id: req.customerId }).first('ach_status');
      if (achCustomer?.ach_status && achCustomer.ach_status !== 'active') {
        return res.status(400).json({ error: 'Bank payments are unavailable on your account right now — keep a card as your default until that clears.' });
      }
    }

    // Auto Pay eligibility requires the DEFAULT method to carry
    // autopay_enabled, so a bare default swap silently stopped charging
    // while the AutopayCard still showed Active. Carry the flag to the new
    // default when it's chargeable; otherwise disable autopay honestly.
    const carriesAutopay = !!currentDefault?.autopay_enabled && currentDefault.id !== card.id;
    const newCardChargeable = card.processor === 'stripe' && !!card.stripe_payment_method_id;

    await db.transaction(async (trx) => {
      await trx('payment_methods')
        .where({ customer_id: req.customerId })
        .update({ is_default: false });

      await trx('payment_methods')
        .where({ id: req.params.id })
        .update({ is_default: true, ...(carriesAutopay && newCardChargeable ? { autopay_enabled: true } : {}) });

      if (carriesAutopay) {
        await trx('payment_methods').where({ id: currentDefault.id }).update({ autopay_enabled: false });
        if (newCardChargeable) {
          await trx('customers').where({ id: req.customerId }).update({ autopay_payment_method_id: card.id });
        } else {
          await trx('customers').where({ id: req.customerId }).update({ autopay_enabled: false, autopay_payment_method_id: null });
        }
      }
    });

    if (carriesAutopay) {
      const event = newCardChargeable ? 'autopay_method_changed' : 'autopay_disabled';
      logAutopay(req.customerId, event, {
        details: {
          source: 'set_default_card',
          old_payment_method_id: currentDefault.id,
          new_payment_method_id: newCardChargeable ? card.id : null,
        },
      }).catch((logErr) => {
        logger.warn(`[billing-v2] autopay log failed for customer ${req.customerId}: ${logErr.message}`);
      });
    }

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
