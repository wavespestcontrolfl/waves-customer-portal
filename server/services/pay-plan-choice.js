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
const COUNTERPART_SETTLED_STATUSES = new Set(['paid', 'prepaid', 'processing']);
const COUNTERPART_DEAD_STATUSES = new Set(['void', 'cancelled', 'canceled', 'refunded']);

const cents = (n) => Math.round((Number(n) || 0) * 100) / 100;

// The note on the prepay invoice this lane mints. It is customer-visible, and
// it is also the durable link from the prepay to the first invoice it
// replaces: the payment follow-through closes only the invoice it names.
const PREPAY_NOTE_PREFIX = 'Annual prepay chosen on the pay page of invoice ';
const PREPAY_NOTE_SUFFIX = '. Paying this closes that invoice.';
function prepayInvoiceNote(firstInvoiceNumber) {
  return `${PREPAY_NOTE_PREFIX}${firstInvoiceNumber}${PREPAY_NOTE_SUFFIX}`;
}

function prepayNoteNamesInvoice(prepayNotes, firstInvoiceNumber) {
  return !!firstInvoiceNumber && String(prepayNotes || '').includes(prepayInvoiceNote(firstInvoiceNumber));
}

function prepayNoteFirstInvoiceNumber(prepayNotes) {
  const text = String(prepayNotes || '');
  const start = text.indexOf(PREPAY_NOTE_PREFIX);
  if (start === -1) return null;
  const after = text.slice(start + PREPAY_NOTE_PREFIX.length);
  const end = after.indexOf(PREPAY_NOTE_SUFFIX);
  if (end <= 0) return null;
  return after.slice(0, end).trim() || null;
}

// Bidirectional exclusion for combined-balance payments: a plan-choice prepay
// P and the first-application invoice F it replaces are mutually exclusive
// alternatives and must NEVER ride the same PaymentIntent — whether P is the
// anchor, F is the anchor, or a third invoice X is the anchor while both F and
// P are open.
function filterOutPlanChoiceAlternatives(anchorInvoice, openInvoices) {
  const openNumbers = new Set(
    [anchorInvoice?.invoice_number, ...(openInvoices || []).map((inv) => inv?.invoice_number)].filter(Boolean),
  );
  return (openInvoices || []).filter((inv) => {
    if (prepayNoteNamesInvoice(anchorInvoice?.notes, inv?.invoice_number)) return false;
    const namedFirst = prepayNoteFirstInvoiceNumber(inv?.notes);
    return !(namedFirst && namedFirst !== inv?.invoice_number && openNumbers.has(namedFirst));
  });
}

// Shared lock key for a (first-application F, plan-choice prepay P) pair so
// concurrent payment attempts across two tabs serialize on the exact same
// advisory lock. Null for ordinary invoices (zero lock/query overhead).
function planChoicePairKey(invoice) {
  if (!invoice?.customer_id) return null;
  const namedFirst = prepayNoteFirstInvoiceNumber(invoice.notes);
  if (namedFirst) return `${invoice.customer_id}:${namedFirst}`;
  if (!invoice.annual_prepay_term_id && invoice.invoice_number && acceptMintEstimateId(invoice.notes)) {
    return `${invoice.customer_id}:${invoice.invoice_number}`;
  }
  return null;
}

async function lockPlanChoicePair(trx, invoice) {
  const key = planChoicePairKey(invoice);
  if (!key || typeof trx?.raw !== 'function') return null;
  await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['pay.plan_choice.pair', key]);
  return key;
}

async function loadPlanChoiceCounterparts(invoice, conn = db) {
  if (!invoice?.customer_id) return [];
  const namedFirst = prepayNoteFirstInvoiceNumber(invoice.notes);
  if (namedFirst) {
    const rows = await conn('invoices')
      .where({ customer_id: invoice.customer_id, invoice_number: namedFirst })
      .whereNot({ id: invoice.id })
      .select('id', 'invoice_number', 'status', 'paid_at', 'stripe_payment_intent_id', 'notes');
    return (rows || []).map((row) => ({ ...row, role: 'first' }));
  }
  if (!invoice.annual_prepay_term_id && invoice.invoice_number && acceptMintEstimateId(invoice.notes)) {
    const noteNeedle = prepayInvoiceNote(invoice.invoice_number);
    const rows = await conn('invoices')
      .where({ customer_id: invoice.customer_id })
      .whereNot({ id: invoice.id })
      .whereNotNull('annual_prepay_term_id')
      .where('notes', 'like', `%${noteNeedle}%`)
      .select('id', 'invoice_number', 'status', 'paid_at', 'stripe_payment_intent_id', 'notes');
    return (rows || [])
      .filter((row) => prepayNoteNamesInvoice(row.notes, invoice.invoice_number))
      .map((row) => ({ ...row, role: 'prepay' }));
  }
  return [];
}

async function counterpartHasLivePaymentRow(counterpartId, conn) {
  try {
    const payment = await conn('payments')
      .whereIn('status', ['paid', 'processing'])
      .whereRaw("metadata::jsonb ->> 'invoice_id' = ?", [String(counterpartId)])
      .first('status');
    return payment?.status ? String(payment.status).toLowerCase() : null;
  } catch {
    return null;
  }
}

async function counterpartLiveStripeState(counterpart, inspectStripe) {
  if (!inspectStripe || !counterpart?.stripe_payment_intent_id) return null;
  try {
    const pi = await require('./stripe').retrievePaymentIntent(counterpart.stripe_payment_intent_id);
    if (!pi) return null;
    if (pi.status === 'succeeded' || pi.status === 'requires_capture') return 'paid';
    const achMicro = pi.status === 'requires_action' && pi.next_action?.type === 'verify_with_microdeposits';
    if (pi.status === 'processing' || achMicro) return 'processing';
    return null;
  } catch (err) {
    logger.warn(`[pay-plan-choice] counterpart PI check failed for invoice ${counterpart.id}: ${err.message} — failing closed`);
    return 'unverifiable';
  }
}

// Returns conflict details if the alternative invoice in a pay-plan-choice
// pair (F ↔ P) is already paid, prepaid, or processing (DB status, live
// payments row, or — when inspectStripe=true — live Stripe PI). Null when clear.
async function planChoiceCounterpartConflict(invoice, { conn = db, inspectStripe = false } = {}) {
  if (!planChoicePairKey(invoice)) return null;
  const counterparts = await loadPlanChoiceCounterparts(invoice, conn);
  for (const cp of counterparts) {
    const status = String(cp.status || '').toLowerCase();
    if (COUNTERPART_DEAD_STATUSES.has(status)) continue;
    if (cp.paid_at || COUNTERPART_SETTLED_STATUSES.has(status)) {
      const effectiveStatus = COUNTERPART_SETTLED_STATUSES.has(status) ? status : 'paid';
      return { role: cp.role, invoiceId: cp.id, invoiceNumber: cp.invoice_number, status: effectiveStatus, inProgress: effectiveStatus === 'processing' };
    }
    const paymentStatus = await counterpartHasLivePaymentRow(cp.id, conn);
    if (paymentStatus) {
      return { role: cp.role, invoiceId: cp.id, invoiceNumber: cp.invoice_number, status: paymentStatus, inProgress: paymentStatus === 'processing' };
    }
    const piState = await counterpartLiveStripeState(cp, inspectStripe);
    if (piState) {
      return { role: cp.role, invoiceId: cp.id, invoiceNumber: cp.invoice_number, status: piState, inProgress: piState === 'processing' };
    }
  }
  return null;
}

function planChoiceConflictError(conflict) {
  const message = conflict.status === 'processing'
    ? 'A payment for your other billing option is currently processing. Please wait for it to finish rather than paying twice.'
    : conflict.status === 'unverifiable'
      ? 'Could not confirm whether your other billing option is already being paid — please refresh and try again.'
      : 'This plan is already covered by a payment on your other billing option — no additional payment is needed.';
  const err = new Error(message);
  err.statusCode = 409;
  err.code = 'PLAN_CHOICE_CONFLICT';
  err.planChoiceConflict = true;
  err.inProgress = conflict.status === 'processing';
  return err;
}

async function assertPlanChoiceCounterpartPayable(conn, invoice, { inspectStripe = false } = {}) {
  const conflict = await planChoiceCounterpartConflict(invoice, { conn, inspectStripe });
  if (conflict) throw planChoiceConflictError(conflict);
}

// The accepted estimate a first invoice came from, when this invoice can carry
// the choice at all; null otherwise. Cheap row checks only: the switch's
// computation decides everything else.
function acceptEstimateForChoice(invoice) {
  if (!isEnabled('payPlanChoice')) return null;
  if (!invoice?.id || !invoice.customer_id || !invoice.scheduled_service_id || !invoice.invoice_number) return null;
  if (invoice.annual_prepay_term_id || invoice.payer_id || invoice.payer_statement_id) return null;
  // Money or credit already recorded on it: which plan that money belongs to is the office's call.
  if (invoice.payment_recorded_at || invoice.paid_at) return null;
  if (Number(invoice.amount_paid || 0) > 0 || Number(invoice.credit_applied || 0) > 0) return null;
  if (!OPEN_INVOICE_STATUSES.includes(String(invoice.status || '').toLowerCase())) return null;
  return acceptMintEstimateId(invoice.notes);
}

async function hasPendingCreditOrPromoForChoice(invoice, conn = db, { projectedCredit } = {}) {
  if (projectedCredit != null && Number(projectedCredit) > 0) return true;
  try {
    if (conn?.schema?.hasTable && await conn.schema.hasTable('invoice_promo_codes')) {
      const promo = await conn('invoice_promo_codes')
        .where({ invoice_id: invoice.id })
        .whereIn('status', ['entered', 'redeemed'])
        .first('id');
      if (promo) return true;
    }
  } catch { /* keep checking auto-credit */ }
  if (projectedCredit !== undefined) return false;
  if (!require('../config/feature-gates').gates.autoApplyAccountCredit) return false;
  const cust = await conn('customers')
    .where({ id: invoice.customer_id })
    .first('account_credits', 'auto_apply_account_credit');
  return cust?.auto_apply_account_credit === true && Number(cust?.account_credits || 0) > 0;
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

async function planChoiceForInvoice(invoice, { projectedCredit } = {}) {
  try {
    const estimateId = acceptEstimateForChoice(invoice);
    if (!estimateId) return null;
    if (await planChoiceCounterpartConflict(invoice)) return null;
    const pending = await pendingPrepayFor(invoice, estimateId);
    // The pay link itself is answered by the POST, never this GET payload
    // (pay-v2: another invoice's token never rides the page data).
    if (pending) return { selected: true, prepay: { total: cents(pending.total) } };
    if (await hasPendingCreditOrPromoForChoice(invoice, db, { projectedCredit })) return null;
    const preview = await require('../routes/admin-schedule').computeAnnualPrepayPreview(
      { scheduledServiceId: invoice.scheduled_service_id }, db, { switchLane: true, payPageInvoiceId: invoice.id },
    );
    if (preview.httpStatus || !preview.eligible) return null;
    // Only a fee the switch itself reports as waived with prepay is shown as
    // waived (a carried, unwaived setup already withholds the choice).
    const setupFee = preview.setupFee?.waivedWithPrepay ? cents(preview.setupFee.amount) : 0;
    const perApplicationYear = cents(preview.annualBase + setupFee);
    const savings = cents(perApplicationYear - preview.prepayTotal);
    if (!(savings > 0)) return null;
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
        savings,
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
  if (await planChoiceCounterpartConflict(invoice, { inspectStripe: true })) return { refused: true };
  const answer = (prepay) => ({ payUrl: portalUrl(`/pay/${prepay.token}`) });
  const pending = await pendingPrepayFor(invoice, estimateId);
  if (pending) return answer(pending);
  if (await hasPendingCreditOrPromoForChoice(invoice, db)) return { refused: true };
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
  PREPAY_NOTE_PREFIX,
  prepayInvoiceNote,
  prepayNoteNamesInvoice,
  prepayNoteFirstInvoiceNumber,
  filterOutPlanChoiceAlternatives,
  planChoicePairKey,
  lockPlanChoicePair,
  planChoiceCounterpartConflict,
  planChoiceConflictError,
  assertPlanChoiceCounterpartPayable,
  planChoiceForInvoice,
  selectAnnualPrepay,
};
