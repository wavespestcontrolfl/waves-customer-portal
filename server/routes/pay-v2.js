const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../models/db');
const InvoiceService = require('../services/invoice');
const InvoiceAttachments = require('../services/invoice-attachments');
const StripeService = require('../services/stripe');
const stripeConfig = require('../config/stripe-config');
const { generateInvoicePDF } = require('../services/pdf/invoice-pdf');
const ConsentService = require('../services/payment-method-consents');
const logger = require('../services/logger');
const { assertInvoiceCollectible } = require('../services/invoice-helpers');
const ReceiptDeliveryQueue = require('../services/receipt-delivery-queue');
const BillPaymentErrorAlerts = require('../services/bill-payment-error-alerts');
const { shouldSkipClientPaymentErrorAlert } = require('./pay-v2-helpers');

/**
 * Public pay routes — no auth required.
 * Customers access these via invoice token links (e.g. /pay/abc123def456).
 */

const clientPaymentErrorLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many payment error reports. Please call (941) 297-5749.' },
});

function cleanField(value, max = 500) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function paymentRouteLabel(req) {
  if (req.route?.path) {
    return `${req.method} ${req.baseUrl || ''}${req.route.path}`;
  }
  const rawPath = req.originalUrl || req.path || '';
  const token = req.params?.token;
  const safePath = token ? rawPath.replace(String(token), ':token') : rawPath;
  return `${req.method} ${safePath}`;
}

function reportBillPaymentError(req, {
  invoice,
  phase,
  methodCategory,
  paymentIntentId,
  error,
  message,
  code,
  statusCode,
  source = 'server',
  metadata = {},
}) {
  if (!invoice?.id) return;
  BillPaymentErrorAlerts.alertBillPaymentError({
    invoice,
    phase,
    methodCategory,
    paymentIntentId,
    error,
    message,
    code,
    statusCode,
    source,
    metadata: {
      route: paymentRouteLabel(req),
      method: req.method,
      ...metadata,
    },
  }).catch((alertErr) => {
    logger.warn(`[pay-v2] Bill payment error alert failed for invoice ${invoice.id}: ${alertErr.message}`);
  });
}

function respondWithPaymentError(req, res, {
  invoice,
  phase,
  methodCategory,
  paymentIntentId,
  error,
  message,
  code,
  statusCode = 400,
  clientMessage,
  metadata,
}) {
  reportBillPaymentError(req, {
    invoice,
    phase,
    methodCategory,
    paymentIntentId,
    error,
    message,
    code,
    statusCode,
    metadata,
  });
  return res.status(statusCode).json({ error: clientMessage || message || error?.message || 'Payment error' });
}

// =========================================================================
// GET /api/pay/:token — Invoice data + processor info + Stripe key
// =========================================================================
// A recurring estimate accept REQUIRES a payment method on file (owner
// ruling 2026-07-09). Server-authoritative — never a client-editable URL
// param (Codex #2507 P1). Two legs:
//  1. billing_mode per_application/annual_prepay — stamped BEFORE the
//     acceptance invoice is paid, covers estimate-flow signups.
//  2. A CURRENT monthly member accepting a recurring add-on keeps their
//     billing_mode (converter preservesExistingMembership, round-7), but
//     their accept links are still sent saveRequired=1 like every
//     recurring accept — enforce the same requirement here or the GET
//     unlocks the box and setup/finalize honor saveCard=false (Codex
//     #2507 round-2). Detected mode-independently: the invoice's
//     scheduled service traces to an accepted estimate
//     (source_estimate_id), the customer has a recurring relationship
//     (monthly_rate > 0), AND the visit itself is a RECURRING one — the
//     same marker trio project-completion treats as canonical
//     (is_recurring / recurring_parent_id / recurring_pattern), so a
//     monthly member's ONE-TIME estimate accept stays exempt (Codex
//     #2507 round-3: one-time links are sent saveCard: !treatAsOneTime,
//     not save-required). Schedule-created visits (no source estimate)
//     stay exempt too.
// Payer-billed invoices never save on the homeowner account.
// Column-guarded: pre-migration environments require nothing.
async function invoiceRequiresSavedMethod(invoice) {
  const customerId = invoice?.customer_id || invoice?.customer?.id;
  if (!customerId || invoice?.payer_id) return false;
  try {
    const row = await db('customers').where({ id: customerId }).first('billing_mode', 'monthly_rate');
    if (['per_application', 'annual_prepay'].includes(row?.billing_mode)) return true;
    if (!(Number(row?.monthly_rate) > 0)) return false;
    const scheduledServiceId = invoice?.scheduled_service_id || invoice?.scheduledServiceId;
    if (!scheduledServiceId) return false;
    const ss = await db('scheduled_services')
      .where({ id: scheduledServiceId })
      .first('source_estimate_id', 'is_recurring', 'recurring_parent_id', 'recurring_pattern');
    if (!ss?.source_estimate_id) return false;
    return !!(ss.is_recurring || ss.recurring_parent_id || ss.recurring_pattern);
  } catch { return false; }
}

// Nothing chargeable is on file for this required-save customer — the
// canonical customerOnAutopay (flag, pause, default chargeable row, ACH
// health). Used by /setup, GET (invoice.captureNeeded) and /capture-setup
// so the covered-by-credit capture state is derivable on EVERY load, not
// only from the one /setup response (Codex #2507 P1 round-3).
async function invoiceCaptureNeeded(invoice) {
  try {
    const { customerOnAutopay } = require('../services/autopay-eligibility');
    const customerRow = await db('customers').where({ id: invoice.customer_id }).first();
    return !!customerRow && !(await customerOnAutopay(customerRow));
  } catch { return false; }
}

router.get('/:token', async (req, res, next) => {
  try {
    const data = await InvoiceService.getByToken(req.params.token);
    if (!data) return res.status(404).json({ error: 'Invoice not found' });
    // Phase 2: an accrued invoice is not individually viewable/payable — it
    // renders on the consolidated statement. Fail closed on the pay surface
    // (receipts stay permanent; the block is here, not in getByToken).
    if (data.payer_statement_id) return res.status(404).json({ error: 'This charge is billed on the monthly statement.' });
    // NOTE: this is an UNAUTHENTICATED public-by-token GET (link previews /
    // scanners hit it). It must stay read-only for money state — account credit
    // is auto-applied from the controlled POST /:token/setup path, never here.

    // Third-party Bill-To: an AP contact opening the emailed pay link must see
    // the payer as "Billed to" (not the homeowner) and must not be offered
    // "save card" (server already refuses to save it onto the homeowner).
    await require('../services/payer').attachToInvoice(data);

    const customer = data.customer || {};
    const lineItems = data.line_items || [];
    const productsApplied = data.products_applied || [];
    const photos = data.service_photos || [];
    const annualPrepayTerm = data.annual_prepay_term || null;
    const annualPrepay = data.annual_prepay
      ? {
          ...data.annual_prepay,
          renewalDecision: annualPrepayTerm?.renewalDecision || null,
        }
      : null;
    const attachments = await InvoiceAttachments.list(data.id).catch((err) => {
      logger.warn(`[pay-v2] attachment list failed for invoice ${data.id}: ${err.message}`);
      return [];
    });

    // Server-authoritative "payment method on file is required" flag —
    // the client locks the consent box from THIS, not the URL. For a
    // credit-covered (prepaid) required-save invoice, captureNeeded makes
    // the method-capture step RESUMABLE: any reload / redirect return
    // re-derives it from live state instead of trusting the one /setup
    // response (Codex #2507 P1 round-3).
    const getSaveRequired = await invoiceRequiresSavedMethod(data);
    const getCaptureNeeded = getSaveRequired && data.status === 'prepaid'
      && (await invoiceCaptureNeeded(data));

    res.json({
      invoice: {
        id: data.id,
        invoiceNumber: data.invoice_number,
        title: data.title,
        status: data.status,
        saveRequired: getSaveRequired,
        captureNeeded: getCaptureNeeded,
        lineItems,
        subtotal: parseFloat(data.subtotal),
        discountAmount: parseFloat(data.discount_amount),
        discountLabel: data.discount_label,
        taxRate: parseFloat(data.tax_rate),
        taxAmount: parseFloat(data.tax_amount),
        total: parseFloat(data.total),
        // Amount the customer actually pays = total − applied account credit, so
        // the displayed amount matches what Stripe/Terminal charge to the cent.
        // creditApplied drives the "Account credit applied" line.
        amountDue: parseFloat(data.amount_due != null ? data.amount_due : data.total),
        creditApplied: parseFloat(data.credit_applied || 0),
        dueDate: data.due_date,
        paidAt: data.paid_at,
        cardBrand: data.card_brand,
        cardLastFour: data.card_last_four,
        receiptUrl: data.receipt_url,
        notes: data.notes,
        annualPrepay,
        attachments: attachments.map((a) => ({
          id: a.id,
          fileName: a.file_name,
          mimeType: a.mime_type,
          fileSizeBytes: a.file_size_bytes,
          createdAt: a.created_at,
        })),
      },
      service: {
        type: data.service_type,
        date: data.service_date,
        techName: data.tech_name,
        techNotes: data.tech_notes,
        productsApplied,
        photos,
      },
      customer: {
        firstName: customer.first_name,
        lastName: customer.last_name,
        email: customer.email,
        tier: customer.waveguard_tier,
        address: customer.address_line1,
        city: customer.city,
        state: customer.state,
        zip: customer.zip,
        isCommercial: customer.property_type === 'commercial' || customer.property_type === 'business',
      },
      payer: data.payer
        ? {
            name: data.payer.company_name || data.payer.display_name || null,
            email: data.payer.ap_email || null,
            address: data.payer.billing_address_line1 || null,
            city: data.payer.billing_city || null,
            state: data.payer.billing_state || null,
            zip: data.payer.billing_zip || null,
            poNumber: data.po_number || null,
          }
        // Fail closed: this invoice IS payer-billed (payer_id set) but the payer
        // couldn't be attached (legacy invoice with no snapshot + an inactive/
        // deleted payer row). Serialize a third-party-billed placeholder rather
        // than null, so the pay page does NOT render as self-pay with the
        // homeowner as bill-to (keeps save-card suppressed / billing email blank).
        : data.payer_id
          ? {
              name: 'Third-party payer',
              email: null,
              address: null,
              city: null,
              state: null,
              zip: null,
              poNumber: data.po_number || null,
            }
          : null,
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
// GET /api/pay/:token/attachments/:attachmentId — token-gated attachment view
// =========================================================================
router.get('/:token/attachments/:attachmentId', async (req, res, next) => {
  try {
    const invoice = await db('invoices').where({ token: req.params.token }).first('id', 'payer_statement_id');
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    // Phase 2: an accrued invoice's attachments are not individually viewable —
    // it belongs to the consolidated statement. Fail closed.
    if (invoice.payer_statement_id) return res.status(404).json({ error: 'Invoice not found' });
    const attachment = await InvoiceAttachments.getForInvoice(invoice.id, req.params.attachmentId);
    if (!attachment) return res.status(404).json({ error: 'Attachment not found' });
    const url = await InvoiceAttachments.signedViewUrl(attachment);
    res.redirect(url);
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /api/pay/:token/setup — Create Stripe PaymentIntent for invoice
// =========================================================================
router.post('/:token/setup', async (req, res, next) => {
  let invoice = null;
  try {
    const { saveCard, cardOnly } = req.body || {};
    invoice = await db('invoices').where({ token: req.params.token }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    // Phase 2: an accrued invoice is payable only via its consolidated statement.
    if (invoice.payer_statement_id) {
      return res.status(400).json({ error: 'This charge is billed on the monthly statement; pay the statement, not the individual invoice.' });
    }
    try {
      assertInvoiceCollectible(invoice.status);
    } catch (err) {
      // The invoice already flipped to `processing` — an ACH debit in flight.
      // This is the same benign in-progress state as the createInvoicePaymentIntent
      // 409 below, and it can be hit by a fresh-return race (the webhook flips
      // the status between the page's initial GET and this POST). Carry
      // `inProgress: true` so the pay page shows the "bank payment processing"
      // state instead of a red error.
      if (invoice.status === 'processing') {
        return res.status(409).json({ error: err.message, inProgress: true });
      }
      return res.status(400).json({ error: err.message });
    }

    // Required-save invoices force the flag server-side — stripping the URL
    // param or editing the POST body must not produce a recurring signup
    // with no method on file (Codex #2507 P1).
    const requireSave = await invoiceRequiresSavedMethod(invoice);
    const result = await StripeService.createInvoicePaymentIntent(invoice.id, { saveCard: !!saveCard || requireSave, cardOnly: !!cardOnly });

    // Account credit fully covering a REQUIRED-SAVE invoice must not skip
    // method capture (Codex #2507 P1 round-2): covered_by_credit returns
    // before any PI is minted, so a signup with enough credit would
    // complete with nothing chargeable on file and later per-visit /
    // renewal collection has nothing to charge. Only the FLAG is computed
    // here — the SetupIntent is minted by POST /:token/capture-setup so a
    // transient mint failure is retryable and the state is re-derivable on
    // every page load (GET's invoice.captureNeeded), never permanently
    // bypassed by a swallowed error (Codex #2507 P1 round-3).
    const captureNeeded = !!result.covered_by_credit && requireSave
      && (await invoiceCaptureNeeded(invoice));

    res.json({
      clientSecret: result.clientSecret,
      paymentIntentId: result.paymentIntentId,
      amount: result.amount,
      baseAmount: result.baseAmount,
      cardSurchargeRate: result.cardSurchargeRate,
      publishableKey: stripeConfig.publishableKey,
      // Account credit may have fully covered the invoice at setup (no PI minted) —
      // surface it so the pay page can show "covered" instead of a card form.
      coveredByCredit: !!result.covered_by_credit,
      status: result.status,
      // Required-save + covered + nothing chargeable on file → the client
      // runs the capture step (POST /capture-setup) before the covered state.
      captureNeeded,
    });
  } catch (err) {
    // A 409 means the invoice already has a live PaymentIntent that setup could
    // neither reuse nor replace. Two cases, distinguished by `inProgress` (set by
    // createInvoicePaymentIntent only when money is genuinely in flight — a live
    // payment row or a `processing` PI):
    //   • inProgress  → an ACH bank debit still `processing`, an ACH micro-deposit
    //     verification still in `requires_action` (the customer is mid bank-verify,
    //     not stuck), or a reload / bank-redirect return. NOT a failure: no admin
    //     alert, and the pay page shows the customer the benign bank state.
    //   • !inProgress → an alert-worthy mismatch an operator must see: a PI
    //     reporting `succeeded` while the invoice is still unpaid (a lost/failed
    //     reconciliation webhook), or a stale unconfirmed PI that could not be
    //     canceled for replacement because it just raced into a live state. A
    //     card PI merely stuck in requires_action is no longer a 409 — setup now
    //     cancels and re-mints it so the customer can pay (no operator needed).
    if (err.statusCode === 409) {
      if (!err.inProgress) {
        // Never log the raw pay-link token — it is the bearer credential for
        // this invoice and errors.log is broadly readable. When the invoice id
        // is unavailable, fall back to a masked suffix that still aids
        // correlation without disclosing the token.
        const tokenHint = req.params.token ? `tok…${String(req.params.token).slice(-4)}` : 'unknown';
        logger.warn(`[pay-v2] Setup 409 (recoverable conflict) for invoice ${invoice?.id || tokenHint}: ${err.message}`);
        reportBillPaymentError(req, {
          invoice,
          phase: 'setup',
          methodCategory: 'card',
          error: err,
          statusCode: 409,
          metadata: { save_card: !!req.body?.saveCard, recoverable_conflict: true },
        });
      }
      return res.status(409).json({
        error: err.message,
        inProgress: !!err.inProgress,
        microdepositPending: !!err.microdepositPending,
      });
    }
    logger.error(`[pay-v2] Setup error: ${err.message}`);
    reportBillPaymentError(req, {
      invoice,
      phase: 'setup',
      methodCategory: 'card',
      error: err,
      statusCode: err.statusCode || 500,
      metadata: { save_card: !!req.body?.saveCard },
    });
    next(err);
  }
});

// =========================================================================
// POST /api/pay/:token/update-amount — Adjust PI for selected payment method
// No surcharge at this stage — both card and ACH stay at base amount.
// Surcharge is added at /quote + /finalize after PM funding is known.
// =========================================================================
router.post('/:token/update-amount', async (req, res, next) => {
  let invoice = null;
  try {
    const { paymentIntentId, methodCategory, saveCard } = req.body || {};
    if (!paymentIntentId) return res.status(400).json({ error: 'paymentIntentId required' });

    invoice = await db('invoices').where({ token: req.params.token }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    // Phase 2: an accrued invoice is payable only via its consolidated statement.
    if (invoice.payer_statement_id) {
      return res.status(400).json({ error: 'This charge is billed on the monthly statement; pay the statement, not the individual invoice.' });
    }
    try {
      assertInvoiceCollectible(invoice.status);
    } catch (err) {
      return res.status(invoice.status === 'processing' ? 409 : 400).json({ error: err.message });
    }

    const result = await StripeService.updateInvoicePaymentIntentMethod(
      invoice.id,
      paymentIntentId,
      methodCategory,
      // Required-save invoices force the flag server-side (see /setup).
      { saveCard: !!saveCard || (await invoiceRequiresSavedMethod(invoice)) },
    );

    res.json(result);
  } catch (err) {
    // 409 = expected race/in-flight state (e.g. trying to switch tender while
    // a payment is already processing). Surface it to the customer without
    // raising an admin bill-payment-error alert.
    if (err.statusCode === 409) {
      return res.status(409).json({ error: err.message });
    }
    logger.error(
      `[pay-v2] Update-amount error `
      + `(PI ${req.body?.paymentIntentId || 'missing'}): ${err.type || 'Error'} — ${err.message}`
      + `${err.code ? ` [code=${err.code}]` : ''}`
      + `${err.param ? ` [param=${err.param}]` : ''}`,
    );
    reportBillPaymentError(req, {
      invoice,
      phase: 'update_amount',
      methodCategory: req.body?.methodCategory,
      paymentIntentId: req.body?.paymentIntentId,
      error: err,
      statusCode: 400,
      metadata: { save_card: !!req.body?.saveCard },
    });
    res.status(400).json({ error: 'Could not update payment total. Please refresh and try again, or call (941) 297-5749.' });
  }
});

// =========================================================================
// POST /api/pay/:token/quote — Get surcharge quote for a specific PM
// =========================================================================
router.post('/:token/quote', async (req, res, next) => {
  let invoice = null;
  try {
    const { paymentMethodId } = req.body || {};
    if (!paymentMethodId) return res.status(400).json({ error: 'paymentMethodId required' });

    invoice = await db('invoices').where({ token: req.params.token }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    // Phase 2: an accrued invoice is payable only via its consolidated statement.
    if (invoice.payer_statement_id) {
      return res.status(400).json({ error: 'This charge is billed on the monthly statement; pay the statement, not the individual invoice.' });
    }
    try {
      assertInvoiceCollectible(invoice.status);
    } catch (err) {
      return res.status(invoice.status === 'processing' ? 409 : 400).json({ error: err.message });
    }

    const result = await StripeService.quoteInvoiceSurcharge(invoice.id, paymentMethodId);
    res.json(result);
  } catch (err) {
    logger.error(`[pay-v2] Quote error: ${err.message}`);
    reportBillPaymentError(req, {
      invoice,
      phase: 'quote',
      methodCategory: 'card',
      paymentIntentId: invoice?.stripe_payment_intent_id,
      error: err,
      statusCode: 400,
    });
    res.status(400).json({ error: err.message });
  }
});

// =========================================================================
// POST /api/pay/:token/finalize — Confirm payment with surcharge applied
// =========================================================================
router.post('/:token/finalize', async (req, res, next) => {
  let invoice = null;
  try {
    const { quoteToken, saveCard } = req.body || {};
    if (!quoteToken) return res.status(400).json({ error: 'quoteToken required' });

    invoice = await db('invoices').where({ token: req.params.token }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    // Phase 2: an accrued invoice is payable only via its consolidated statement.
    if (invoice.payer_statement_id) {
      return res.status(400).json({ error: 'This charge is billed on the monthly statement; pay the statement, not the individual invoice.' });
    }
    try {
      assertInvoiceCollectible(invoice.status);
    } catch (err) {
      return res.status(invoice.status === 'processing' ? 409 : 400).json({ error: err.message });
    }

    // Required-save invoices force the flag server-side (see /setup).
    const result = await StripeService.finalizeInvoicePayment(invoice.id, quoteToken, { saveCard: !!saveCard || (await invoiceRequiresSavedMethod(invoice)) });
    res.json(result);
  } catch (err) {
    logger.error(`[pay-v2] Finalize error: ${err.message}`);
    reportBillPaymentError(req, {
      invoice,
      phase: 'finalize',
      methodCategory: 'card',
      paymentIntentId: invoice?.stripe_payment_intent_id,
      error: err,
      statusCode: 400,
      metadata: { save_card: !!req.body?.saveCard },
    });
    res.status(400).json({ error: err.message });
  }
});

// =========================================================================
// POST /api/pay/:token/confirm — Confirm Stripe payment for invoice
// (Legacy — kept for ACH confirmation and Express Checkout which skip /finalize)
// =========================================================================
router.post('/:token/confirm', async (req, res, next) => {
  let invoice = null;
  try {
    const { paymentIntentId } = req.body;
    if (!paymentIntentId) return res.status(400).json({ error: 'paymentIntentId required' });

    invoice = await db('invoices').where({ token: req.params.token }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    // Phase 2: an accrued invoice is collected only via its consolidated statement.
    if (invoice.payer_statement_id) {
      return res.status(400).json({ error: 'This charge is billed on the monthly statement; pay the statement, not the individual invoice.' });
    }
    if (['void', 'refunded', 'canceled', 'cancelled'].includes(String(invoice.status || '').toLowerCase())) {
      try {
        assertInvoiceCollectible(invoice.status);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
    }
    if (invoice.status === 'paid') return res.status(400).json({ error: 'Invoice already paid' });
    if (invoice.status === 'prepaid') return res.status(400).json({ error: 'Invoice is already prepaid' });
    if (invoice.stripe_payment_intent_id
      && String(invoice.stripe_payment_intent_id) !== String(paymentIntentId)) {
      return res.status(409).json({ error: 'Invoice has a different active payment' });
    }

    const paymentRecord = await StripeService.confirmInvoicePayment(invoice.id, paymentIntentId);

    // Card payments are paid immediately. ACH bank payments sit in
    // `processing` until Stripe emits payment_intent.succeeded, so the
    // webhook sends the receipt after funds clear.
    if (paymentRecord.status === 'paid') {
      await ReceiptDeliveryQueue.enqueueReceiptDelivery({
        invoiceId: invoice.id,
        stripePaymentIntentId: paymentIntentId,
        source: 'pay_confirm',
      });
      ReceiptDeliveryQueue.scheduleReceiptDeliveryDrain({ delayMs: 1000, limit: 5 });
    }

    res.json({
      success: true,
      payment: {
        id: paymentRecord.id,
        amount: parseFloat(paymentRecord.amount),
        status: paymentRecord.status,
      },
    });
  } catch (err) {
    logger.error(`[pay-v2] Confirm error: ${err.message}`);
    reportBillPaymentError(req, {
      invoice,
      phase: 'confirm',
      methodCategory: req.body?.methodCategory || invoice?.payment_method,
      paymentIntentId: req.body?.paymentIntentId,
      error: err,
      statusCode: 400,
    });
    res.status(400).json({ error: err.message });
  }
});

// =========================================================================
// POST /api/pay/:token/consent — Record save-payment-method authorization
//
// Called by the client right after a successful confirmPayment when the
// customer ticked the save-payment-method box. The Stripe webhook will
// create the payment_methods row asynchronously; this endpoint only
// records the consent (verbatim copy + version + IP/UA) and leaves the
// FK to payment_methods null for the webhook to back-fill.
//
// Method type (card vs ACH) is derived server-side from the invoice's
// own Stripe PaymentIntent, not from the request body. We also verify
// that the client-submitted stripePaymentMethodId is the same PM the
// PaymentIntent actually charged — that defends against a tampered
// client submitting an unrelated PM id. The endpoint fails closed if
// any of those checks can't be confirmed, since recording the wrong
// authorization variant defeats the entire snapshot audit trail.
// =========================================================================
router.post('/:token/consent', async (req, res, next) => {
  let invoice = null;
  try {
    // stripePaymentMethodId is OPTIONAL (Codex #2507 P1 round-3): every
    // verification below keys off the invoice's OWN PaymentIntent, so the
    // body value is only a tamper cross-check when supplied. Redirect-return
    // payments (ACH bank auth, 3DS) post an empty body — the page that held
    // the pm id unloaded at redirect, but the PI is the authority anyway.
    const { stripePaymentMethodId, methodCategory } = req.body || {};

    invoice = await db('invoices').where({ token: req.params.token }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (!invoice.customer_id) {
      return respondWithPaymentError(req, res, {
        invoice,
        phase: 'consent',
        methodCategory,
        paymentIntentId: invoice.stripe_payment_intent_id,
        message: 'Invoice has no customer',
        statusCode: 400,
      });
    }
    if (!invoice.stripe_payment_intent_id) {
      return respondWithPaymentError(req, res, {
        invoice,
        phase: 'consent',
        methodCategory,
        message: 'Invoice has no PaymentIntent - cannot verify payment method',
        statusCode: 409,
      });
    }

    let pi;
    try {
      pi = await StripeService.retrievePaymentIntent(invoice.stripe_payment_intent_id, {
        expand: ['latest_charge'],
      });
    } catch (err) {
      logger.error(`[pay-v2] PI retrieve failed for consent on invoice ${invoice.id}: ${err.message}`);
      return respondWithPaymentError(req, res, {
        invoice,
        phase: 'consent',
        methodCategory,
        paymentIntentId: invoice.stripe_payment_intent_id,
        error: err,
        statusCode: 502,
        clientMessage: 'Could not verify payment with Stripe',
      });
    }
    if (!pi) {
      return respondWithPaymentError(req, res, {
        invoice,
        phase: 'consent',
        methodCategory,
        paymentIntentId: invoice.stripe_payment_intent_id,
        message: 'Payment processing temporarily unavailable',
        statusCode: 503,
      });
    }

    if (!pi.payment_method) {
      return respondWithPaymentError(req, res, {
        invoice,
        phase: 'consent',
        methodCategory,
        paymentIntentId: invoice.stripe_payment_intent_id,
        message: 'PaymentIntent has no payment method to record consent for',
        statusCode: 409,
      });
    }
    if (stripePaymentMethodId && pi.payment_method !== stripePaymentMethodId) {
      logger.warn(`[pay-v2] Consent PM mismatch: client=${stripePaymentMethodId} pi.payment_method=${pi.payment_method} invoice=${invoice.id}`);
      return respondWithPaymentError(req, res, {
        invoice,
        phase: 'consent',
        methodCategory,
        paymentIntentId: invoice.stripe_payment_intent_id,
        message: 'PaymentMethod does not match the invoice charge',
        statusCode: 409,
        metadata: { stripe_payment_method_id: stripePaymentMethodId },
      });
    }
    // The verified pm is the PI's own — the body value (when present) was
    // only a cross-check.
    const verifiedStripePmId = pi.payment_method;

    // PI status acceptable for consent: succeeded (cards / wallets) or
    // processing (ACH, which clears asynchronously). Anything else means
    // the customer hasn't actually authorized a charge against this PM
    // on this invoice yet.
    if (pi.status !== 'succeeded' && pi.status !== 'processing') {
      return respondWithPaymentError(req, res, {
        invoice,
        phase: 'consent',
        methodCategory,
        paymentIntentId: invoice.stripe_payment_intent_id,
        message: `PaymentIntent not in a consent-eligible state (status=${pi.status})`,
        statusCode: 409,
      });
    }

    // The customer must have opted to save the payment method when the
    // PI was set up. Both signals are written together by stripe.js
    // when saveCard is true on /setup or /update-amount:
    // setup_future_usage becomes 'off_session' and metadata.save_card_opt_in
    // becomes 'true'. Without those, a tampered client could otherwise
    // call /consent after any one-time payment and fabricate an
    // authorization row that the customer never actually agreed to.
    const optedIn = pi.setup_future_usage === 'off_session'
      && pi?.metadata?.save_card_opt_in === 'true';
    if (!optedIn) {
      logger.warn(`[pay-v2] Consent rejected — PI ${pi.id} not configured for save-on-file (setup_future_usage=${pi.setup_future_usage}, save_card_opt_in=${pi?.metadata?.save_card_opt_in})`);
      return respondWithPaymentError(req, res, {
        invoice,
        phase: 'consent',
        methodCategory,
        paymentIntentId: invoice.stripe_payment_intent_id,
        message: 'Save-on-file was not requested on this payment',
        statusCode: 409,
      });
    }

    // Prefer the verified charge.payment_method_details.type — that's
    // the method that actually ran. Fall back to pi.payment_method_types
    // only when there's no charge yet (rare for processing ACH).
    const pmdType = pi.latest_charge?.payment_method_details?.type || null;
    const fallbackType = Array.isArray(pi.payment_method_types) && pi.payment_method_types.length === 1
      ? pi.payment_method_types[0]
      : null;
    const verifiedMethodType = pmdType || fallbackType;
    if (!verifiedMethodType) {
      logger.warn(`[pay-v2] Could not determine method type for consent on invoice ${invoice.id}`);
      return respondWithPaymentError(req, res, {
        invoice,
        phase: 'consent',
        methodCategory,
        paymentIntentId: invoice.stripe_payment_intent_id,
        message: 'Could not determine payment method type',
        statusCode: 409,
      });
    }

    const row = await ConsentService.recordConsent({
      customerId: invoice.customer_id,
      stripePaymentMethodId: verifiedStripePmId,
      source: 'pay_page',
      methodType: verifiedMethodType,
      ip: req.ip,
      userAgent: req.get('user-agent') || null,
    });

    // Complete consent-gated autopay enrollment (Codex #2507 P1): the
    // webhook only enrolls when the consent row already exists, so when
    // Stripe's payment_intent.succeeded beat this POST the method sits
    // saved-but-unenrolled — finish the job now that the authorization
    // artifact is on file. If the webhook hasn't mirrored the pm yet,
    // method_not_found is fine: the webhook runs after this row exists
    // and enrolls there. Best-effort — consent recording never fails on
    // an enrollment hiccup.
    try {
      const { enrollConsentedMethod } = require('../services/autopay-enrollment');
      await enrollConsentedMethod({
        customerId: invoice.customer_id,
        stripePaymentMethodId: verifiedStripePmId,
        source: 'save_card_consent',
      });
    } catch (enrollErr) {
      logger.error(`[pay-v2] consent-side autopay enrollment failed for invoice ${invoice.id}: ${enrollErr.message}`);
    }

    res.json({ success: true, consentId: row.id, version: row.consent_text_version });
  } catch (err) {
    logger.error(`[pay-v2] Consent record failed: ${err.message}`);
    reportBillPaymentError(req, {
      invoice,
      phase: 'consent',
      methodCategory: req.body?.methodCategory,
      paymentIntentId: invoice?.stripe_payment_intent_id,
      error: err,
      statusCode: 400,
    });
    res.status(400).json({ error: err.message });
  }
});

// =========================================================================
// POST /api/pay/:token/capture-setup — Mint the covered-by-credit capture
// SetupIntent (Codex #2507 P1 round-3: minted on demand + retryable, never
// inline-swallowed in /setup; the need is re-derived server-side on every
// call so a stale client can't force capture that's no longer needed).
// =========================================================================
router.post('/:token/capture-setup', async (req, res) => {
  let invoice = null;
  try {
    invoice = await db('invoices').where({ token: req.params.token }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (!invoice.customer_id) return res.status(400).json({ error: 'Invoice has no customer' });
    // Fail closed: capture exists solely for the required-save +
    // credit-covered state — any other invoice/token must not be usable to
    // start attaching methods to the account.
    if (!(await invoiceRequiresSavedMethod(invoice))) {
      return res.status(409).json({ error: 'This invoice does not require a saved payment method' });
    }
    if (invoice.status !== 'prepaid') {
      return res.status(409).json({ error: 'Capture applies only to credit-covered invoices' });
    }
    if (!(await invoiceCaptureNeeded(invoice))) {
      return res.json({ alreadyChargeable: true });
    }
    // An unhealthy customer-level ACH state (needs_verification/suspended)
    // blocks bank collection regardless of a fresh bank method — offering
    // us_bank_account here would capture a method customerOnAutopay keeps
    // refusing (Codex #2507 P1 round-3). Card-only until the bank state
    // clears.
    let methodTypes = 'card_or_bank';
    try {
      const achRow = await db('customers').where({ id: invoice.customer_id }).first('ach_status');
      if (achRow?.ach_status && achRow.ach_status !== 'active') methodTypes = 'card';
    } catch { /* fail toward card_or_bank */ }
    const setup = await StripeService.createSetupIntent(invoice.customer_id, methodTypes, {
      metadata: { purpose: 'covered_capture', invoice_id: String(invoice.id) },
    });
    res.json({
      clientSecret: setup.clientSecret,
      setupIntentId: setup.setupIntentId,
      publishableKey: stripeConfig.publishableKey,
    });
  } catch (err) {
    logger.error(`[pay-v2] capture-setup failed for invoice ${invoice?.id || 'unknown'}: ${err.message}`);
    res.status(502).json({ error: 'Could not start the payment method setup — please try again' });
  }
});

// =========================================================================
// POST /api/pay/:token/setup-complete — Persist a method captured via the
// covered-by-credit SetupIntent flow (Codex #2507 P1 round-2).
//
// Only meaningful for required-save invoices: /capture-setup minted the
// SetupIntent because account credit fully covered the invoice (no PI, so
// the normal webhook save-card mirror never fires) and nothing chargeable
// was on file. Verification is server-side and fails closed: the
// SetupIntent must have succeeded, must belong to this invoice's customer
// (waves_customer_id metadata stamped at mint), and must carry a payment
// method. Mirrors the portal add-card route: save → consent snapshot →
// consent-gated enrollment. IDEMPOTENT (Codex #2507 P2 round-3): a retry
// after a partial first attempt reuses the already-mirrored
// payment_methods row instead of re-inserting into a unique column. The
// setup_intent.succeeded webhook runs the same completion for redirects /
// async bank verification the browser never finishes.
// =========================================================================
router.post('/:token/setup-complete', async (req, res) => {
  let invoice = null;
  try {
    const { setupIntentId } = req.body || {};
    if (!setupIntentId) return res.status(400).json({ error: 'setupIntentId required' });
    invoice = await db('invoices').where({ token: req.params.token }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (!invoice.customer_id) return res.status(400).json({ error: 'Invoice has no customer' });
    // Fail closed: this endpoint exists solely to satisfy the required-save
    // rule — a non-required invoice token must not be usable to attach
    // methods to the account.
    if (!(await invoiceRequiresSavedMethod(invoice))) {
      return res.status(409).json({ error: 'This invoice does not require a saved payment method' });
    }

    const setupIntent = await StripeService.retrieveSetupIntent(setupIntentId, {
      expand: ['payment_method'],
    });
    const pmObject = setupIntent?.payment_method || null;
    const stripePmId = typeof pmObject === 'string' ? pmObject : pmObject?.id;
    if (!setupIntent || setupIntent.status !== 'succeeded' || !stripePmId) {
      return res.status(409).json({
        error: 'Payment method setup is not complete.',
        setupIntentStatus: setupIntent?.status || 'unknown',
        microdepositPending: setupIntent?.next_action?.type === 'verify_with_microdeposits',
      });
    }
    if (setupIntent.metadata?.waves_customer_id !== String(invoice.customer_id)) {
      logger.warn(`[pay-v2] setup-complete customer mismatch: SI ${setupIntentId} meta=${setupIntent.metadata?.waves_customer_id} invoice customer=${invoice.customer_id}`);
      return res.status(409).json({ error: 'Setup does not belong to this invoice' });
    }

    // Idempotent save: stripe_payment_method_id is unique — a retry after a
    // partial first attempt (saved but consent/enrollment failed) must
    // continue with the existing row, never re-insert.
    let saved = await db('payment_methods').where({ stripe_payment_method_id: stripePmId }).first();
    if (saved && saved.customer_id !== invoice.customer_id) {
      logger.warn(`[pay-v2] setup-complete pm ownership mismatch: pm ${stripePmId} belongs to ${saved.customer_id}, invoice customer ${invoice.customer_id}`);
      return res.status(409).json({ error: 'Payment method belongs to another account' });
    }
    if (!saved) {
      saved = await StripeService.savePaymentMethod(invoice.customer_id, stripePmId, {
        enableAutopay: false,
        // enrollConsentedMethod owns the default decision (claims it only
        // when no healthy method is already in charge).
        makeDefault: false,
      });
    }
    const methodType = (typeof pmObject === 'object' && pmObject?.type) || saved.method_type || 'card';
    if (!(await ConsentService.hasConsentFor(invoice.customer_id, stripePmId))) {
      await ConsentService.recordConsent({
        customerId: invoice.customer_id,
        paymentMethodId: saved.id,
        stripePaymentMethodId: stripePmId,
        source: 'pay_page',
        methodType,
        ip: req.ip,
        userAgent: req.get('user-agent') || null,
      });
    }
    const { enrollConsentedMethod } = require('../services/autopay-enrollment');
    await enrollConsentedMethod({
      customerId: invoice.customer_id,
      paymentMethodId: saved.id,
      source: 'save_card_consent',
      details: { via: 'covered_by_credit_setup', invoice_id: invoice.id },
    });

    res.json({ success: true });
  } catch (err) {
    logger.error(`[pay-v2] setup-complete failed for invoice ${invoice?.id || 'unknown'}: ${err.message}`);
    res.status(500).json({ error: 'Could not save the payment method' });
  }
});

// =========================================================================
// POST /api/pay/:token/error — Browser-side payment form error report
//
// Used for Stripe.js/network failures that never become a Stripe webhook
// event and may never reach one of the server-side catch blocks above.
// =========================================================================
router.post('/:token/error', clientPaymentErrorLimiter, async (req, res) => {
  try {
    const invoice = await db('invoices').where({ token: req.params.token }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (shouldSkipClientPaymentErrorAlert(invoice)) {
      return res.json({ success: true, skipped: true, reason: 'non_collectible' });
    }

    const body = req.body || {};
    const message = cleanField(body.message || body.error || 'Payment form error');
    if (!message) return res.json({ success: true, skipped: true });

    const stripeType = cleanField(body.stripeType || '', 100);
    const code = cleanField(body.code || '', 100);

    await BillPaymentErrorAlerts.alertBillPaymentError({
      invoice,
      phase: cleanField(body.phase || 'client', 60),
      methodCategory: cleanField(body.methodCategory || invoice.payment_method || 'unknown', 60),
      paymentIntentId: cleanField(body.paymentIntentId || invoice.stripe_payment_intent_id || '', 128),
      message,
      code,
      statusCode: Number(body.statusCode || 0) || null,
      source: 'client',
      metadata: {
        route: paymentRouteLabel(req),
        stripe_type: stripeType || null,
        client_phase: cleanField(body.clientPhase || '', 100) || null,
      },
    });

    res.json({ success: true });
  } catch (err) {
    logger.error(`[pay-v2] Client payment error report failed: ${err.message}`);
    res.status(500).json({ error: 'Could not record payment error report' });
  }
});

// =========================================================================
// GET /api/pay/:token/invoice.pdf — Branded invoice PDF for download/print
// =========================================================================
router.get('/:token/invoice.pdf', async (req, res, next) => {
  try {
    const data = await InvoiceService.getByToken(req.params.token);
    if (!data) return res.status(404).json({ error: 'Invoice not found' });
    // Phase 2: an accrued invoice's individual PDF is not served — it renders on
    // the consolidated statement (the receipt PDF stays permanent, unaffected).
    if (data.payer_statement_id) return res.status(404).json({ error: 'This charge is billed on the monthly statement.' });
    // Downloaded/printed PDF must show the same Bill-To = payer block as the
    // emailed copy (getByToken doesn't attach the payer on its own).
    await require('../services/payer').attachToInvoice(data);
    // Fail closed: a payer-billed invoice whose payer can't attach (legacy, no
    // snapshot, inactive/deleted) must NOT render the homeowner as Bill-To on
    // the printable PDF. Synthesize a third-party placeholder so the bill-to
    // block stays non-self-pay (mirrors the JSON pay-page fail-closed state).
    if (!data.payer && data.payer_id) {
      data.payer = { company_name: 'Third-party payer', ap_email: null };
    }
    generateInvoicePDF(data, res);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
