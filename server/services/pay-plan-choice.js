'use strict';

/**
 * Plan choice on the invoice pay page (owner 2026-11-19, GATE_PAY_PLAN_CHOICE).
 *
 * A customer who accepted an estimate as pay-per-application reads the first
 * invoice of the new plan (setup fee + first application) on its /pay/:token
 * page. This offers the other plan there: prepay the year instead.
 *
 *   planChoiceForInvoice — read-only. The two options with their totals, or
 *     null when the choice is not offered. The year's price and every refusal
 *     come from the Schedule switch's own computation
 *     (computeAnnualPrepayPreview in routes/admin-schedule.js); nothing is
 *     priced here.
 *   selectAnnualPrepay — the customer picked the year. Mints the unpaid annual
 *     prepay invoice and its payment_pending term through the switch's own
 *     transaction (runPrepaySwitch) and answers with that invoice's pay link.
 *     One per first invoice: a repeat answers with the same link.
 *
 * Owner rulings 2026-11-19: only the first invoice of a new recurring plan
 * carries the choice; the visit it bills counts as visit 1 of the prepaid year
 * even when it is already completed; and the first invoice STAYS PAYABLE after
 * the choice. Nothing is voided here. Paying the prepay closes the first
 * invoice (closeAcceptInvoiceReplacedByPaidTerm in annual-prepay-renewals.js);
 * paying the first invoice instead leaves the customer on per application.
 *
 * No message is sent from here, and nothing is charged: payment happens on
 * the invoices' own pay pages.
 */

const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');
const { acceptMintEstimateId } = require('./invoice-notes');
const { portalUrl } = require('../utils/portal-url');

// A bill the customer can still pay (invoice.js isInvoiceCollectibleStatus
// minus 'processing': money in flight is never offered a different plan).
const OPEN_INVOICE_STATUSES = ['draft', 'sent', 'viewed', 'overdue'];

const cents = (n) => Math.round((Number(n) || 0) * 100) / 100;

// The note on the prepay invoice this lane mints. It is customer-visible, and
// it is also the durable link from the prepay to the first invoice it
// replaces: the payment follow-through closes only the invoice it names.
function prepayInvoiceNote(firstInvoiceNumber) {
  return `Annual prepay chosen on the pay page of invoice ${firstInvoiceNumber}. Paying this closes that invoice.`;
}

function prepayNoteNamesInvoice(prepayNotes, firstInvoiceNumber) {
  return !!firstInvoiceNumber && String(prepayNotes || '').includes(prepayInvoiceNote(firstInvoiceNumber));
}

// The accepted estimate a first invoice came from, when this invoice can carry
// the choice at all; null otherwise. Cheap row checks only: the switch's
// computation decides everything else.
function acceptEstimateForChoice(invoice) {
  if (!isEnabled('payPlanChoice')) return null;
  if (!invoice?.id || !invoice.customer_id || !invoice.scheduled_service_id || !invoice.invoice_number) return null;
  if (invoice.annual_prepay_term_id || invoice.payer_id || invoice.payer_statement_id) return null;
  // Money already recorded on it (an out-of-band part payment leaves the
  // invoice open): which plan that money belongs to is the office's call.
  if (invoice.payment_recorded_at) return null;
  if (!OPEN_INVOICE_STATUSES.includes(String(invoice.status || '').toLowerCase())) return null;
  return acceptMintEstimateId(invoice.notes);
}

// The unpaid prepay invoice an earlier choice on this first invoice minted.
async function pendingPrepayFor(invoice, estimateId) {
  const terms = await db('annual_prepay_terms')
    .where({ customer_id: invoice.customer_id, source_estimate_id: estimateId, status: 'payment_pending' })
    .whereNull('renewal_decision')
    .whereNotNull('prepay_invoice_id')
    .select('prepay_invoice_id');
  for (const term of terms) {
    const prepay = await db('invoices')
      .where({ id: term.prepay_invoice_id, customer_id: invoice.customer_id })
      .first('id', 'token', 'status', 'total', 'notes');
    if (prepay && OPEN_INVOICE_STATUSES.includes(String(prepay.status || '').toLowerCase())
      && prepayNoteNamesInvoice(prepay.notes, invoice.invoice_number)) return prepay;
  }
  return null;
}

async function planChoiceForInvoice(invoice) {
  try {
    const estimateId = acceptEstimateForChoice(invoice);
    if (!estimateId) return null;
    const pending = await pendingPrepayFor(invoice, estimateId);
    // The pay link itself is answered by the POST, never this GET payload
    // (pay-v2: another invoice's token never rides the page data).
    if (pending) return { selected: true, prepay: { total: cents(pending.total) } };
    const preview = await require('../routes/admin-schedule').computeAnnualPrepayPreview(
      { scheduledServiceId: invoice.scheduled_service_id }, db, { switchLane: true, payPageInvoiceId: invoice.id },
    );
    if (preview.httpStatus || !preview.eligible) return null;
    // Only a fee the switch itself reports as waived with prepay is shown as
    // waived (a carried, unwaived setup already withholds the choice).
    const setupFee = preview.setupFee?.waivedWithPrepay ? cents(preview.setupFee.amount) : 0;
    const perApplicationYear = cents(preview.annualBase + setupFee);
    return {
      selected: false,
      serviceType: preview.coverageServiceType,
      visitsPerYear: preview.visitsPerYear,
      perApplication: { perVisit: cents(preview.perVisit), setupFee, yearTotal: perApplicationYear },
      prepay: {
        total: cents(preview.prepayTotal),
        setupFeeWaived: setupFee,
        discount: cents(preview.discountAmount),
        discountLabel: preview.discountLabel || '',
        savings: cents(perApplicationYear - preview.prepayTotal),
      },
    };
  } catch (err) {
    logger.warn(`[pay-plan-choice] choice read failed for invoice ${invoice?.id}: ${err.message} — page renders without it`);
    return null;
  }
}

// Returns { payUrl } for the prepay invoice, or { refused: true } when the
// choice is not (or no longer) offered on this invoice. Throws on a failure
// the customer can retry.
async function selectAnnualPrepay(invoice) {
  const estimateId = acceptEstimateForChoice(invoice);
  if (!estimateId) return { refused: true };
  const answer = (prepay) => ({ payUrl: portalUrl(`/pay/${prepay.token}`) });
  const pending = await pendingPrepayFor(invoice, estimateId);
  if (pending) return answer(pending);
  const out = await require('../routes/admin-schedule').runPrepaySwitch({
    visitId: invoice.scheduled_service_id,
    acknowledgeNoticedAmount: false,
    actor: { id: null, name: null, source: 'pay_page_plan_choice' },
    switchLane: true,
    auditSource: 'invoice pay page',
    payPageInvoiceId: invoice.id,
  });
  if (out.httpStatus) {
    // A double submit: the second request lands on the first one's term
    // (the switch's overlap assert) and answers with that same link.
    const raced = await pendingPrepayFor(invoice, estimateId);
    return raced ? answer(raced) : { refused: true };
  }
  const minted = await db('invoices').where({ id: out.invoice.id }).first('id', 'token');
  return answer(minted);
}

module.exports = {
  OPEN_INVOICE_STATUSES,
  prepayInvoiceNote,
  prepayNoteNamesInvoice,
  planChoiceForInvoice,
  selectAnnualPrepay,
};
