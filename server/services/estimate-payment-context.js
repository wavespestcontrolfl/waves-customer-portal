// ============================================================
// estimate-payment-context.js
//
// Exact, ledger-backed payment posture for an estimate-linked appointment.
// Answers "how is this customer paying, and what have they actually paid,
// down to the cent" without anyone re-opening the estimate:
//
//   - Annual prepay:  the annual_prepay_terms row (tax-inclusive amount the
//     customer was invoiced) + its prepay invoice's real paid state.
//   - Pay per application: the acceptance invoice the converter minted
//     ("WaveGuard Membership Setup [+ First Application]") with the exact
//     setup-fee / first-application line amounts and whether it was paid.
//
// Every figure comes from a persisted row (terms, invoices, line items) —
// never recomputed from pricing — so what the card shows is what was charged.
//
// Read-only and fail-soft throughout: a payment read must never block the
// scheduling surfaces, so every branch degrades to null rather than throwing.
// Consumed by the /admin/schedule/:id/estimate-source route and the customer
// estimates-for-scheduling payload (New Appointment modal).
// ============================================================

const db = require('../models/db');
const logger = require('./logger');
// Shared terminal-status set so "remaining" counts visits the same way the
// prepaid-series banner and Customer 360 rollup do.
const { TERMINAL_STATUSES } = require('./prepaid-series');

// Terms in these statuses are paid coverage (mirrors ACTIVE_STATUSES in
// annual-prepay-renewals.js). payment_pending resolves through the invoice.
const TERM_PAID_STATUSES = new Set(['active', 'renewal_pending']);
// 'prepaid' is the account-credit close-out; both leave AR (invoice.js).
const INVOICE_PAID_STATUSES = new Set(['paid', 'prepaid']);
// Never surface a dead acceptance invoice as the billing record.
const INVOICE_DEAD_STATUSES = ['void', 'cancelled', 'canceled', 'refunded'];

const SETUP_FEE_RE = /setup fee/i;
const FIRST_APPLICATION_RE = /first (service )?application/i;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function lineItemsArray(invoice) {
  const raw = invoice?.line_items;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function lineAmount(li) {
  const unit = num(li?.unit_price ?? li?.unitPrice ?? li?.price ?? li?.amount) || 0;
  const qty = num(li?.quantity) || 1;
  return Math.round(unit * qty * 100) / 100;
}

// Exact dollars a matching line item actually billed. Null (not 0) when no
// line matches, so the card can distinguish "no setup fee on this plan" from
// "setup fee of $0".
function sumMatchingLines(invoice, re) {
  let found = false;
  let total = 0;
  for (const li of lineItemsArray(invoice)) {
    if (!re.test(String(li?.description || ''))) continue;
    found = true;
    total += lineAmount(li);
  }
  return found ? Math.round(total * 100) / 100 : null;
}

function invoiceIsPaid(invoice) {
  if (!invoice) return false;
  return INVOICE_PAID_STATUSES.has(String(invoice.status || '').toLowerCase()) || !!invoice.paid_at;
}

// The visit's own term link wins (a renewal customer can hold more than one
// term over time); fall back to the term minted at accept for this estimate
// (annual_prepay_terms.source_estimate_id is unique per estimate).
async function resolveAnnualPrepayTerm(estimate, scheduledServiceId) {
  if (scheduledServiceId) {
    try {
      const ss = await db('scheduled_services')
        .where({ id: scheduledServiceId })
        .first('annual_prepay_term_id');
      if (ss?.annual_prepay_term_id) {
        const term = await db('annual_prepay_terms').where({ id: ss.annual_prepay_term_id }).first();
        if (term) return term;
      }
    } catch (err) {
      logger.warn('[estimate-payment-context] visit term read failed', { error: err.message });
    }
  }
  if (!estimate?.id) return null;
  try {
    return await db('annual_prepay_terms')
      .where({ source_estimate_id: estimate.id })
      .orderBy('created_at', 'desc')
      .first() || null;
  } catch (err) {
    logger.warn('[estimate-payment-context] estimate term read failed', { error: err.message });
    return null;
  }
}

// "Visit X of Y · N remaining" usage for a prepay term, from the visits the
// coverage machinery linked to it (scheduled_services.annual_prepay_term_id).
// totalVisits prefers the SOLD count (coverage_visit_count) so a partially
// seeded series still reads "of 4"; used = completed covered visits;
// remaining = sold minus used (never negative). visitNumber is this
// appointment's 1-based position among the live covered visits by date —
// null when the visit isn't linked to the term (e.g. a coverage gap), so the
// card falls back to the used/total phrasing instead of inventing a slot.
async function summarizeTermVisitUsage(term, scheduledServiceId) {
  if (!term?.id) return null;
  try {
    const rows = await db('scheduled_services')
      .where({ annual_prepay_term_id: term.id })
      .orderBy('scheduled_date', 'asc')
      .select('id', 'status', 'scheduled_date');
    if (!Array.isArray(rows) || !rows.length) return null;
    const live = rows.filter((r) => {
      const status = String(r.status || '').toLowerCase();
      return status === 'completed' || !TERMINAL_STATUSES.has(status);
    });
    if (!live.length) return null;
    const soldCount = term.coverage_visit_count != null ? Number(term.coverage_visit_count) : null;
    const totalVisits = Number.isInteger(soldCount) && soldCount > 0 ? soldCount : live.length;
    const visitsUsed = live.filter((r) => String(r.status || '').toLowerCase() === 'completed').length;
    const idx = scheduledServiceId
      ? live.findIndex((r) => String(r.id) === String(scheduledServiceId))
      : -1;
    return {
      totalVisits,
      visitsUsed,
      visitsRemaining: Math.max(0, totalVisits - visitsUsed),
      visitNumber: idx >= 0 ? idx + 1 : null,
    };
  } catch (err) {
    logger.warn('[estimate-payment-context] term visit usage read failed', { error: err.message });
    return null;
  }
}

// The invoice the converter minted at accept. Its id is not persisted on the
// estimate row, but the converter always writes "accepted estimate #<uuid>"
// into the invoice notes, and a uuid in that marker is unambiguous — so the
// notes match IS the link. Earliest live invoice wins (the acceptance invoice
// predates any later manual billing that might echo the phrase).
async function findAcceptanceInvoice(estimate) {
  if (!estimate?.id || !estimate?.customer_id) return null;
  try {
    return await db('invoices')
      .where({ customer_id: estimate.customer_id })
      .whereNotIn('status', INVOICE_DEAD_STATUSES)
      .where('notes', 'like', `%accepted estimate #${estimate.id}%`)
      .orderBy('created_at', 'asc')
      .first() || null;
  } catch (err) {
    logger.warn('[estimate-payment-context] acceptance invoice read failed', { error: err.message });
    return null;
  }
}

// The accept-time payment choice persisted on the committed scheduled service
// ('card_on_file' | 'deposit_now' | 'pay_at_visit' | 'prepay_annual').
async function readPaymentPreference(scheduledServiceId) {
  if (!scheduledServiceId) return null;
  try {
    const ss = await db('scheduled_services')
      .where({ id: scheduledServiceId })
      .first('payment_method_preference');
    return ss?.payment_method_preference || null;
  } catch (err) {
    logger.warn('[estimate-payment-context] payment preference read failed', { error: err.message });
    return null;
  }
}

/**
 * Build the payment context for an estimate (optionally scoped to the
 * scheduled service the caller is answering for). Never throws.
 *
 * @returns {Promise<{
 *   billingTerm: 'prepay_annual'|'standard'|null,
 *   paymentPreference: string|null,
 *   annualPrepay: object|null,
 *   acceptanceInvoice: object|null,
 * }|null>} null only when the estimate is missing.
 */
async function buildEstimatePaymentContext(estimate, { scheduledServiceId = null } = {}) {
  if (!estimate?.id) return null;

  const paymentPreference = await readPaymentPreference(scheduledServiceId);
  const term = await resolveAnnualPrepayTerm(estimate, scheduledServiceId);

  let annualPrepay = null;
  if (term) {
    let invoice = null;
    if (term.prepay_invoice_id) {
      try {
        invoice = await db('invoices')
          .where({ id: term.prepay_invoice_id })
          .first('id', 'status', 'paid_at', 'total') || null;
      } catch (err) {
        logger.warn('[estimate-payment-context] prepay invoice read failed', { error: err.message });
      }
    }
    const status = String(term.status || '').toLowerCase();
    const usage = await summarizeTermVisitUsage(term, scheduledServiceId);
    annualPrepay = {
      termId: term.id,
      status: term.status,
      // Paid = the term reached a covered status OR its invoice is actually
      // settled (the webhook flips payment_pending → active on payment, but
      // read the invoice too so a lagging flip can't show "pending" money
      // that has cleared).
      paid: TERM_PAID_STATUSES.has(status) || invoiceIsPaid(invoice),
      planLabel: term.plan_label || null,
      prepayAmount: num(term.prepay_amount),
      termStart: term.term_start || null,
      termEnd: term.term_end || null,
      coverageServiceType: term.coverage_service_type || null,
      coverageVisitCount: term.coverage_visit_count != null ? Number(term.coverage_visit_count) : null,
      // "Visit X of Y · N remaining" context (null when no visits are linked).
      totalVisits: usage?.totalVisits ?? null,
      visitsUsed: usage?.visitsUsed ?? null,
      visitsRemaining: usage?.visitsRemaining ?? null,
      visitNumber: usage?.visitNumber ?? null,
      invoiceId: invoice?.id || term.prepay_invoice_id || null,
      invoiceStatus: invoice?.status || null,
      invoicePaidAt: invoice?.paid_at || null,
      invoiceTotal: invoice ? num(invoice.total) : null,
    };
  }

  let acceptanceInvoice = null;
  if (!term) {
    const inv = await findAcceptanceInvoice(estimate);
    if (inv) {
      acceptanceInvoice = {
        id: inv.id,
        title: inv.title || null,
        status: inv.status || null,
        paid: invoiceIsPaid(inv),
        paidAt: inv.paid_at || null,
        total: num(inv.total),
        setupFeeAmount: sumMatchingLines(inv, SETUP_FEE_RE),
        firstApplicationAmount: sumMatchingLines(inv, FIRST_APPLICATION_RE),
      };
    }
  }

  // Billing term: a prepay term is authoritative; otherwise the persisted
  // preference; otherwise an accepted estimate with an acceptance invoice is
  // the converter's standard (pay-per-application) path. Null when nothing is
  // known — the card renders nothing rather than guessing.
  let billingTerm = null;
  if (term) billingTerm = 'prepay_annual';
  else if (paymentPreference === 'prepay_annual') billingTerm = 'prepay_annual';
  else if (paymentPreference || acceptanceInvoice) billingTerm = 'standard';

  return { billingTerm, paymentPreference, annualPrepay, acceptanceInvoice };
}

module.exports = {
  buildEstimatePaymentContext,
  _private: {
    sumMatchingLines,
    invoiceIsPaid,
    findAcceptanceInvoice,
    resolveAnnualPrepayTerm,
    summarizeTermVisitUsage,
    SETUP_FEE_RE,
    FIRST_APPLICATION_RE,
  },
};
