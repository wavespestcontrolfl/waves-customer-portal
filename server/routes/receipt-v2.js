const express = require('express');
const router = express.Router();
const InvoiceService = require('../services/invoice');
const logger = require('../services/logger');
const { noStore } = require('../middleware/no-store');

// Receipt links are PERMANENT bearer URLs — the strongest case on the
// portal for keeping responses out of shared caches and search indexes.
router.use(noStore);
const { generateReceiptPDF } = require('../services/pdf/invoice-pdf');

// Public receipt routes — no auth required. Reuses the permanent invoice.token.
// Token is 64-char crypto-random and has no TTL — receipts are records, not
// actions, so customers may retrieve them months later for bookkeeping.

const { loadPaymentForInvoice } = require('../services/receipt-payment');
const { customerVisibleInvoiceNotes } = require('../services/invoice-notes');
const rateLimit = require('express-rate-limit');
const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');

// ── Add-a-service + referral cards (GATE_DOC_CROSS_SELL, owner 2026-11-21) ──
// The service report's two cards, on a PAID receipt. Only the customer's
// own paid receipt: a payer-billed invoice's link goes to a property
// manager or AP contact, who must never see the homeowner's plan offer or
// enroll as the homeowner's promoter. The offer needs the visit the invoice
// is for (service_record_id) — it is the report's own composer and tap.
const RECEIPT_SURFACE = Object.freeze({ source: 'invoice_receipt', noun: 'receipt', title: 'invoice receipt' });

function receiptCardsEligible(invoice) {
  return isEnabled('docCrossSell')
    && !!invoice?.customer_id
    && invoice.status === 'paid'
    && !invoice.payer_id;
}

// Same posture as the report's crossSellActionLimiter: a permanent bearer
// link must not drive pricing recomputes or promoter enrollment at volume.
const receiptCardActionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `receipt-xsell:${req.params.token || 'anon'}`,
  message: { error: 'Too many requests. Please try again in a minute.' },
});

// The taps read only what eligibility needs — never getByToken, whose
// default records a view (a tap is not a view).
function loadReceiptCardInvoice(token) {
  if (typeof token !== 'string' || !token) return null;
  return db('invoices').where({ token })
    .first('id', 'customer_id', 'status', 'payer_id', 'service_record_id');
}

// Best-effort, like the report: any failure renders the receipt without
// the cards. The referral card is static copy — enrollment happens only on
// the explicit tap (POST /:token/referral-link), never on a GET.
async function receiptCards(invoice) {
  if (!receiptCardsEligible(invoice)) return {};
  const cards = {};
  if (invoice.service_record_id) {
    const { buildCrossSellForServiceRecord } = require('../services/service-report/cross-sell-tap');
    const crossSell = await buildCrossSellForServiceRecord(db, invoice.service_record_id);
    if (crossSell) cards.crossSell = crossSell;
  }
  try {
    const referral = await require('../services/referral-share').composeReferralCard();
    if (referral) cards.referral = referral;
  } catch (err) {
    logger.warn(`[receipt-v2] referral card suppressed: ${err.message}`);
  }
  return cards;
}

// =========================================================================
// GET /api/receipt/:token — Receipt view data (paid invoice record)
// =========================================================================
router.get('/:token', async (req, res, next) => {
  try {
    const data = await InvoiceService.getByToken(req.params.token);
    if (!data) return res.status(404).json({ error: 'Receipt not found' });

    // Third-party Bill-To: the AP contact opening the receipt link must see the
    // payer as "Billed to" (the emailed receipt PDF already does).
    await require('../services/payer').attachToInvoice(data);

    // Inspection-credit deadline memo (Codex #3178 r28 P2): the SMS receipt
    // leg only sends this link, so a customer with no email would otherwise
    // never see the written deadline the emailed receipt carries. Same
    // helper as the email leg — offer-authoritative, payer-suppressed,
    // silent when there is nothing to say. Never throws.
    const creditMemo = await require('../services/invoice-email').inspectionCreditMemoForInvoice(data);

    const customer = data.customer || {};
    const lineItems = data.line_items || [];
    const payment = await loadPaymentForInvoice(data.id, data.customer_id, {
      stripePaymentIntentId: data.stripe_payment_intent_id,
      stripeChargeId: data.stripe_charge_id,
      invoiceNumber: data.invoice_number,
    }).catch((err) => {
      // Preserve the permanent viewer's existing invoice-only fallback.
      logger.warn(`[receipt-v2] payment lookup failed: ${err.message}`);
      return null;
    });

    const cards = await receiptCards(data);

    const refundAmount = payment ? Number(payment.refund_amount || 0) : 0;
    const totalPaid = payment ? Number(payment.amount || 0) : Number(data.total || 0);
    const remainingPaid = Math.max(0, totalPaid - refundAmount);
    const refundState = refundAmount > 0
      ? (refundAmount >= totalPaid ? 'fully_refunded' : 'partially_refunded')
      : null;

    res.json({
      invoice: {
        id: data.id,
        invoiceNumber: data.invoice_number,
        title: data.title,
        status: data.status,
        lineItems,
        subtotal: parseFloat(data.subtotal),
        discountAmount: parseFloat(data.discount_amount),
        discountLabel: data.discount_label,
        taxRate: parseFloat(data.tax_rate),
        taxAmount: parseFloat(data.tax_amount),
        total: parseFloat(data.total),
        // Applied account credit reduces the cash charged — surface it so the
        // receipt page can show the deduction and visually reconcile to the total.
        creditApplied: parseFloat(data.credit_applied || 0),
        dueDate: data.due_date,
        paidAt: data.paid_at,
        paymentMethod: data.payment_method,
        cardBrand: data.card_brand,
        cardLastFour: data.card_last_four,
        notes: customerVisibleInvoiceNotes(data.notes),
        creditMemo: creditMemo || null,
      },
      service: {
        type: data.service_type,
        date: data.service_date,
        techName: data.tech_name,
      },
      customer: {
        firstName: customer.first_name,
        lastName: customer.last_name,
        tier: customer.waveguard_tier,
        address: customer.address_line1,
        city: customer.city,
        state: customer.state,
        zip: customer.zip,
        email: customer.email,
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
        // Fail closed: this receipt IS payer-billed (payer_id set) but the payer
        // couldn't be attached (legacy, no snapshot, inactive/deleted payer).
        // Serialize a third-party placeholder rather than null so the receipt
        // page does NOT render the homeowner as "Billed to" alongside the
        // payer's payment-method details.
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
      payment: payment
        ? {
          amount: totalPaid,
          baseAmountCents: payment.base_amount_cents ?? null,
          surchargeAmountCents: payment.surcharge_amount_cents ?? 0,
          surchargeRateBps: payment.surcharge_rate_bps ?? 0,
          cardFunding: payment.card_funding ?? null,
          paymentDate: payment.payment_date,
          cardBrand: payment.card_brand || data.card_brand,
          cardLastFour: payment.card_last_four || data.card_last_four,
          refundAmount,
          refundStatus: payment.refund_status || refundState,
          refundedAt: payment.refunded_at,
          remainingPaid,
          state: data.status === 'paid'
            ? (refundState || 'paid')
            : data.status,
        }
        : null,
      ...cards,
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /api/receipt/:token/pdf — Bookkeeping-grade receipt PDF (paid only)
// =========================================================================
router.get('/:token/pdf', async (req, res, next) => {
  try {
    const data = await InvoiceService.getByToken(req.params.token);
    if (!data) return res.status(404).json({ error: 'Receipt not found' });
    // Receipt permanence: a paid invoice that is later (fully) refunded moves to
    // status 'refunded' but keeps a valid bookkeeping receipt for the payment that
    // occurred — the view route + payment lookup already serve refunded receipts,
    // so the PDF must too (otherwise a credit-applied full refund silently breaks
    // the existing receipt link).
    if (!['paid', 'refunded'].includes(data.status)) {
      return res.status(409).json({ error: 'Receipt not available — invoice unpaid' });
    }

    const payment = await loadPaymentForInvoice(data.id, data.customer_id, {
      stripePaymentIntentId: data.stripe_payment_intent_id,
      stripeChargeId: data.stripe_charge_id,
      invoiceNumber: data.invoice_number,
    }).catch((err) => {
      // Paid PDFs retain their fallback; refunded PDFs still refuse below.
      logger.warn(`[receipt-v2] payment lookup failed: ${err.message}`);
      return null;
    });
    // A refunded receipt MUST show the refund — if the payment/refund row can't be
    // resolved (e.g. a legacy row with neither metadata.invoice_id nor a matching
    // PI/charge), refuse rather than render a PDF that omits the refund and reads as
    // a plain 'paid' receipt for a refunded invoice.
    if (data.status === 'refunded' && !payment) {
      return res.status(409).json({ error: 'Receipt not available — refund record could not be resolved' });
    }
    // Keep the receipt's Bill-To consistent with the invoice (payer, not the
    // homeowner, when the job was third-party-billed).
    await require('../services/payer').attachToInvoice(data);
    // Fail closed: don't render the homeowner as Bill-To on a payer-billed
    // receipt PDF when the payer can't attach (legacy/inactive/deleted).
    if (!data.payer && data.payer_id) {
      data.payer = { company_name: 'Third-party payer', ap_email: null };
    }
    generateReceiptPDF(data, payment, res);
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /api/receipt/:token/cross-sell — the add-a-service card's tap
// =========================================================================
// The report card's tap, unchanged (services/service-report/cross-sell-tap.js):
// recompute, match what was shown, one shared office request, and — with
// GATE_REPORT_CLICK_TO_ESTIMATE on and a priced offer — an estimate URL to
// open. 404 covers a dark gate, an ineligible receipt and an unknown token
// alike, so the gate is not probeable.
router.post('/:token/cross-sell', receiptCardActionLimiter, async (req, res, next) => {
  try {
    const data = await loadReceiptCardInvoice(req.params.token);
    if (!receiptCardsEligible(data) || !data.service_record_id) {
      return res.status(404).json({ error: 'Receipt not found' });
    }
    const { handleCrossSellTap } = require('../services/service-report/cross-sell-tap');
    const metadata = req.body && typeof req.body.metadata === 'object' && req.body.metadata ? req.body.metadata : {};
    const { status, body } = await handleCrossSellTap({
      db,
      serviceRecordId: data.service_record_id,
      metadata,
      surface: RECEIPT_SURFACE,
    });
    return res.status(status).json(body);
  } catch (err) {
    return next(err);
  }
});

// =========================================================================
// POST /api/receipt/:token/referral-link — the referral card's tap
// =========================================================================
// Same composer as the report and estimate screens (enrolls on this tap).
router.post('/:token/referral-link', receiptCardActionLimiter, async (req, res) => {
  try {
    const data = await loadReceiptCardInvoice(req.params.token);
    if (!receiptCardsEligible(data)) return res.status(404).json({ error: 'Receipt not found' });
    const share = await require('../services/referral-share').buildReferralShareForCustomer(data.customer_id);
    if (!share) return res.status(404).json({ error: 'Receipt not found' });
    if (share.unavailable) return res.status(503).json({ error: 'Referral link unavailable — please try again' });
    return res.json(share);
  } catch (err) {
    // err.code only (AGENTS.md PII-in-logs: enrollment constraint errors
    // quote the customer's phone).
    logger.warn(`[receipt-v2] referral-link failed (code=${err?.code || 'none'})`);
    return res.status(503).json({ error: 'Referral link unavailable — please try again' });
  }
});

module.exports = router;
