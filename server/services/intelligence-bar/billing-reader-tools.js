/**
 * Intelligence Bar — Customer Billing Readers (W9)
 * server/services/intelligence-bar/billing-reader-tools.js
 *
 * Two READ-ONLY tools that answer "what does this customer owe, and was their
 * payment received?" from portal records:
 *
 *   get_customer_invoices  one customer's invoices + an account summary
 *   get_invoice_detail     one invoice: lines, discounts and a payments timeline
 *
 * No writes, no sends, no money movement, no migration.
 *
 * THE RULE this module exists to keep: a payment ATTEMPT is not a payment
 * RECEIVED. A timeline entry is `received: true` only when
 *   - the payments table records a successful payment (status paid, or paid
 *     and later refunded), or
 *   - Stripe's own state for it is succeeded (a saved-card charge attempt whose
 *     status is `succeeded`, or an unreconciled Stripe charge that the portal
 *     failed to write to its ledger).
 * Every other state (claimed, processing, ambiguous, failed, canceled,
 * upcoming, disputed) is reported as an attempt with its state and
 * `received: false`. The four kinds stay distinct by `type`:
 *   recorded_payment / payment_attempt   the payments table
 *   stripe_charge_attempt                stripe_invoice_charge_attempts
 *   stripe_unreconciled_charge           stripe_orphan_charges (charged, unrecorded)
 *   credit_movement                      customer_credit_ledger
 *
 * Money arithmetic is NOT re-derived here. The amount a customer owes on an
 * invoice is invoice-helpers `invoiceAmountDue` (total minus applied credit,
 * integer cents), collectibility is `INVOICE_UNCOLLECTIBLE_STATUSES`, and the
 * invoice rows, the unpaid / overdue sets and their counts come from
 * InvoiceService.list — the admin Invoices page's own reader — so the totals
 * here are the page's totals for this customer. Account credit comes from
 * customer-credit getBalance.
 *
 * Scope: admin-only (technicians get no billing reads — technician allow-list
 * ruling). The route and action registry enforce the role; the executor also
 * refuses a non-admin actor and a customer outside the task's read scope.
 * Targets resolve through the same task-context selector handling and
 * comms-tools resolveCustomer the other customer readers use.
 *
 * Never returned: card numbers (brand only), full emails (masked), invoice
 * pay-link tokens, Stripe client secrets, operator-only notes.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { UUID_RE } = require('./task-context');
const { etDateString } = require('../../utils/datetime-et');
const { invoiceAmountDue, INVOICE_UNCOLLECTIBLE_STATUSES } = require('../invoice-helpers');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const SUMMARY_PAGE = 100;
const SUMMARY_MAX_PAGES = 10;
const TIMELINE_ROW_CAP = 50;
const NOT_YET_SENT_STATUSES = ['draft', 'scheduled', 'sending'];

const LIST_STATUS_FILTERS = ['all', 'unpaid', 'overdue', 'paid', 'prepaid', 'processing', 'draft', 'sent', 'viewed', 'void', 'refunded'];

const ATTEMPT_VS_RECEIVED = 'Read only. An invoice payment is RECEIVED only when the payments table records a successful payment or Stripe\'s state is succeeded. A charge attempt, a processing payment, a claimed or ambiguous charge, a failed or canceled payment, or a PaymentIntent that is not succeeded is an ATTEMPT: report it with its state and never call it paid.';

const BILLING_READER_TOOLS = [
  {
    name: 'get_customer_invoices',
    description: `List ONE customer's invoices with an account summary: total due, overdue count, account credit balance, dispute hold. Each invoice has status, title, issued and due dates, amount, applied credit, amount paid, balance due, payment plan, dispute hold, annual-prepay linkage and archived flag. Newest first; follow next_offset when has_more is true. The balance arithmetic is the admin Invoices page's (amount due = total minus applied credit; paid, prepaid, processing, void, refunded and canceled invoices owe nothing).
${ATTEMPT_VS_RECEIVED} A field the portal cannot establish comes back null with the reason in "unknown": say it is unknown, do not guess. Use get_invoice_detail for one invoice's lines and payment timeline. Admin-only; never changes anything and never charges, refunds, credits or sends.
Use for: "what does this customer owe?", "list their invoices", "do they have anything overdue?", "how much credit do they have?"
Select the customer with customer_id, or customer_name, or phone.`,
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', format: 'uuid', description: 'The customer to read' },
        customer_name: { type: 'string', description: 'Customer name (resolved to one customer; ambiguous names are returned as candidates)' },
        phone: { type: 'string', description: 'Customer phone number' },
        status: { type: 'string', enum: LIST_STATUS_FILTERS, description: 'Optional filter: all (default), unpaid (everything still collectible), overdue, or one status. The account summary always covers the whole account.' },
        include_archived: { type: 'boolean', description: 'Also list archived invoices (default false, as the Invoices page)' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `Invoices per page (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` },
        offset: { type: 'integer', minimum: 0, description: 'Continue from next_offset' },
      },
    },
  },
  {
    name: 'get_invoice_detail',
    description: `Read ONE invoice by invoice_id: line items, discounts, amounts, balance, and a payments timeline that keeps four kinds of evidence apart by type: recorded_payment (the payments table, including manual cash/check/Zelle payments with method, reference and date), payment_attempt (a payments row that is processing, failed, canceled or upcoming), stripe_charge_attempt (saved-card charge attempts and their state), stripe_unreconciled_charge (Stripe charged but the portal never recorded it), and credit_movement (account-credit ledger rows). Also dispute hold, payment plan and annual-prepay linkage.
${ATTEMPT_VS_RECEIVED} Each timeline entry carries "received" (true or false) and its raw state: quote the state, and say "received" only for received: true. The payment_summary.statement is the safe one-line answer. The live Stripe PaymentIntent state is not stored in the portal and is not read here: say it is unknown. Admin-only; never changes anything and never charges, refunds, credits or sends.
Use for: "was their payment received?", "did the card go through?", "what is on invoice INV-…?", "why does this invoice still show a balance?"`,
    input_schema: {
      type: 'object',
      properties: {
        invoice_id: { type: 'string', format: 'uuid', description: 'The invoice to read (from get_customer_invoices)' },
        customer_id: { type: 'string', format: 'uuid', description: 'Optional: the customer the invoice must belong to' },
      },
      required: ['invoice_id'],
    },
  },
];

// ─── small helpers ──────────────────────────────────────────────────

const invoiceStatusKey = (status) => String(status || '').trim().toLowerCase();
const money = (value) => (value === null || value === undefined || value === '' ? null : Math.round(Number(value) * 100) / 100);
const cents = (value) => Math.round((Number(value) || 0) * 100);
const fromCents = (value) => Math.round(value) / 100;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const LONG_DIGITS_RE = /\b(?:\d[ -]?){13,19}\b/g;
// Free text (a decline message, a manual-payment note, a ledger note) can echo
// an email or a card number: both are masked before anything leaves.
function scrub(value, max = 240) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(EMAIL_RE, '[email]').replace(LONG_DIGITS_RE, '[number]').trim();
  return text ? text.slice(0, max) : null;
}

function iso(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  return String(value);
}

// DATE columns come back as local-midnight Date objects (or strings).
function dateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
    return match ? match[1] : null;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-');
  }
  return null;
}

const phoneLast4 = (phone) => String(phone || '').replace(/\D/g, '').slice(-4) || null;
const digits10 = (phone) => String(phone || '').replace(/\D/g, '').slice(-10);
const customerName = (row) => `${row.first_name || ''} ${row.last_name || ''}`.trim() || 'Unnamed customer';

function parseJson(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string' && value.trim()) {
    try { return JSON.parse(value); } catch { return null; }
  }
  return null;
}

function parseLineItems(raw) {
  const parsed = Array.isArray(raw) ? raw : parseJson(raw);
  return Array.isArray(parsed) ? parsed : [];
}

// The admin Invoices page's collectibility + balance rule, via the shared
// helpers: a settled, voided or in-flight invoice owes nothing.
function isCollectible(invoice) {
  return !INVOICE_UNCOLLECTIBLE_STATUSES.includes(invoiceStatusKey(invoice.status));
}
function balanceDue(invoice) {
  return isCollectible(invoice) ? invoiceAmountDue(invoice) : 0;
}
// The Invoices page's overdue predicate (InvoiceService.list status=overdue).
function isOverdue(invoice, today) {
  if (!isCollectible(invoice)) return false;
  return invoiceStatusKey(invoice.status) === 'overdue' || Boolean(dateOnly(invoice.due_date) && dateOnly(invoice.due_date) < today);
}

const isPayerBilled = (invoice) => invoice.payer_id != null || invoice.payer_statement_id != null;

// ─── customer selection ─────────────────────────────────────────────

// Same resolution the other customer readers use. In a platform task the
// route's prepareReadInput has already turned a name/phone into the task
// customer's id (task-context resolveCustomerSelector, which also refuses a
// substitute); this keeps a direct or legacy call equivalent: id first, then
// name, then phone, an ambiguous name returned as candidates, and a name or
// phone that disagrees with the id refused as selector_conflict.
async function resolveBillingCustomer(input, actionContext) {
  if (!input.customer_id && !input.customer_name && !input.phone) {
    return { error: 'Give customer_id, customer_name or phone to say whose invoices to read', code: 'selector_required' };
  }
  if (input.customer_id && !UUID_RE.test(String(input.customer_id))) {
    return { error: 'A valid customer_id is required', code: 'invalid_target' };
  }
  const { resolveCustomer } = require('./comms-tools');
  const customer = await resolveCustomer({
    customer_id: input.customer_id ? String(input.customer_id).toLowerCase() : undefined,
    customer_name: input.customer_name,
    phone: input.phone,
  });
  if (customer && customer.error) return customer;
  if (!customer) return { error: 'No customer matched that selector', code: 'record_unavailable' };
  if (customer.deleted_at) return { error: 'That customer record is archived', code: 'record_unavailable' };
  if (input.customer_id) {
    const full = `${customer.first_name || ''} ${customer.last_name || ''}`.toLowerCase();
    const nameDisagrees = input.customer_name && !full.includes(String(input.customer_name).trim().toLowerCase());
    const phoneDisagrees = input.phone && digits10(input.phone) !== digits10(customer.phone);
    if (nameDisagrees || phoneDisagrees) {
      return { error: 'The customer_id, name and phone given do not describe the same customer. Give one selector, or fix the one that is wrong.', code: 'selector_conflict' };
    }
  }
  const scope = Array.isArray(actionContext.readCustomerIds) ? actionContext.readCustomerIds : [];
  if (scope.length && !scope.map(String).includes(String(customer.id))) {
    return { error: 'Use the resolved task customer for this record lookup', code: 'target_clarification_required' };
  }
  return { customer };
}

// ─── shared evidence readers ────────────────────────────────────────

// Payments linked to the page's invoices, by the portal's own linkage rules
// (receipt-payment.js loadPaymentForInvoice): metadata.invoice_id, the
// invoice's Stripe PaymentIntent / charge id, then the manual-payment
// description `Invoice <number> — <method>`. Every status is returned; the
// caller decides what is received.
async function loadLinkedPayments(customerId, invoices) {
  const linked = new Map(invoices.map((invoice) => [String(invoice.id), []]));
  if (!invoices.length) return linked;
  const ids = invoices.map((invoice) => String(invoice.id));
  const intents = [...new Set(invoices.map((invoice) => invoice.stripe_payment_intent_id).filter(Boolean))];
  const charges = [...new Set(invoices.map((invoice) => invoice.stripe_charge_id).filter(Boolean))];
  const numbers = invoices.map((invoice) => invoice.invoice_number).filter((number) => /^[A-Za-z0-9-]+$/.test(String(number || '')));
  const patterns = numbers.map((number) => `Invoice ${number} — %`);
  const rows = await db('payments')
    .where({ customer_id: customerId })
    .where(function linkedToPage() {
      this.whereRaw("payments.metadata::jsonb ->> 'invoice_id' = ANY(?)", [ids]);
      if (intents.length) this.orWhereRaw('payments.stripe_payment_intent_id = ANY(?)', [intents]);
      if (charges.length) this.orWhereRaw('payments.stripe_charge_id = ANY(?)', [charges]);
      if (patterns.length) this.orWhereRaw('payments.description LIKE ANY(?)', [patterns]);
    })
    .orderBy('created_at', 'asc')
    .limit(500)
    .select('id', 'customer_id', 'payment_date', 'amount', 'status', 'description', 'metadata', 'created_at', 'processor',
      'stripe_payment_intent_id', 'stripe_charge_id', 'refund_amount', 'refund_status', 'refunded_at', 'failure_reason',
      'card_brand', 'payment_method_type', 'payer_id', 'retry_count', 'next_retry_at');
  for (const row of rows) {
    const metadata = parseJson(row.metadata) || {};
    for (const invoice of invoices) {
      let by = null;
      // An explicit metadata.invoice_id is authoritative: a combined payment
      // writes one row per invoice, each with its own invoice_id but a shared
      // PaymentIntent and charge, so the PaymentIntent link below must never
      // attach a sibling's row. The legacy linkage applies only to rows that
      // carry no invoice_id at all.
      if (metadata.invoice_id) {
        if (String(metadata.invoice_id) === String(invoice.id)) by = 'metadata.invoice_id';
      } else if (invoice.stripe_payment_intent_id && row.stripe_payment_intent_id === invoice.stripe_payment_intent_id) by = 'payment_intent';
      else if (invoice.stripe_charge_id && row.stripe_charge_id === invoice.stripe_charge_id) by = 'charge';
      else if (invoice.invoice_number && String(row.description || '').startsWith(`Invoice ${invoice.invoice_number} — `)) by = 'description';
      if (by) linked.get(String(invoice.id)).push({ ...row, linked_by: by });
    }
  }
  return linked;
}

// Payment status -> received. Only a recorded successful payment counts; a
// refunded one was received and is shown with what came back; a dispute is a
// state, not a payment.
const RECEIVED_PAYMENT_STATUSES = ['paid', 'refunded'];
function netReceived(row) {
  if (!RECEIVED_PAYMENT_STATUSES.includes(row.status)) return 0;
  return Math.max(0, fromCents(cents(row.amount) - cents(row.refund_amount)));
}

const PAYMENT_STATE_NOTES = {
  paid: 'Recorded as a successful payment.',
  refunded: 'Was received, then refunded (see refunded_amount).',
  disputed: 'A dispute is recorded on this payment: do not call it paid.',
  processing: 'In flight (for example an ACH transfer): not received yet.',
  failed: 'The attempt failed: no money received.',
  canceled: 'Canceled: no money received.',
  upcoming: 'Scheduled, not attempted yet: no money received.',
};

function paymentEntry(row, invoice) {
  const received = RECEIVED_PAYMENT_STATUSES.includes(row.status);
  const manual = !row.processor;
  const entry = {
    type: received || row.status === 'disputed' ? 'recorded_payment' : 'payment_attempt',
    id: row.id,
    at: iso(row.created_at),
    payment_date: dateOnly(row.payment_date),
    status: row.status,
    received,
    state_note: PAYMENT_STATE_NOTES[row.status] || 'Unrecognized payment status: treat as not received.',
    amount: money(row.amount),
    ...(received ? { net_received: fromCents(cents(row.amount) - cents(row.refund_amount)) } : {}),
    refunded_amount: money(row.refund_amount) || 0,
    source: manual ? 'manual' : row.processor,
    ...(manual ? {
      method: invoice.payment_method || null,
      reference: scrub(invoice.payment_reference, 120),
      recorded_by: scrub(invoice.payment_recorded_by, 80),
      recorded_at: iso(invoice.payment_recorded_at),
    } : { card_brand: row.card_brand || null, method_type: row.payment_method_type || null }),
    stripe_payment_intent_id: row.stripe_payment_intent_id || null,
    payer_funded: row.payer_id != null,
    linked_by: row.linked_by,
  };
  if (row.failure_reason) entry.failure_reason = scrub(row.failure_reason);
  if (row.status === 'processing' || row.status === 'failed') {
    entry.retry_count = row.retry_count || 0;
    entry.next_retry_at = iso(row.next_retry_at);
  }
  return entry;
}

const ATTEMPT_STATE_NOTES = {
  claimed: 'A saved-card charge was started and has no recorded result. Not received.',
  ambiguous: 'The outcome is unknown: Stripe may or may not have charged. Not confirmed received.',
  failed: 'The charge failed: no money received.',
  succeeded: 'Stripe reports this charge succeeded.',
};

function attemptEntry(row, ledgerIntents) {
  const succeeded = row.status === 'succeeded';
  const inFlight = row.status === 'claimed' && Boolean(row.submitted_at);
  return {
    type: 'stripe_charge_attempt',
    id: row.id,
    at: iso(row.created_at),
    state: row.status,
    state_label: inFlight ? 'processing (submitted to Stripe, no result recorded yet)' : row.status,
    state_note: ATTEMPT_STATE_NOTES[row.status] || 'Unrecognized attempt state: treat as not received.',
    received: succeeded,
    ...(succeeded ? { received_basis: 'Stripe attempt state succeeded', ledger_recorded: Boolean(row.stripe_payment_intent_id && ledgerIntents.has(row.stripe_payment_intent_id)) } : {}),
    amount: money(row.amount),
    credit_applied_with_attempt: money(row.credit_applied_delta) || 0,
    submitted_at: iso(row.submitted_at),
    resolved_at: iso(row.resolved_at),
    stripe_payment_intent_id: row.stripe_payment_intent_id || null,
    decline_code: row.decline_code || null,
    error: scrub(row.error_message),
  };
}

// ─── account facts ──────────────────────────────────────────────────

async function readDisputeHold(customerId) {
  try {
    const { activeDisputeHolds } = require('../collections/collection-hold');
    const hold = await activeDisputeHolds(db('collections_flags').where({ customer_id: customerId })).first('created_at');
    return { active: Boolean(hold), since: hold ? iso(hold.created_at) : null };
  } catch (err) {
    logger.warn(`[intelligence-bar:billing-reader] dispute hold lookup failed (${err.code || err.name || 'error'})`);
    return { active: null, since: null, unknown: 'The dispute hold could not be read; say it is unknown.' };
  }
}

async function readCredit(customerId) {
  try {
    const CustomerCredit = require('../customer-credit');
    const balance = await CustomerCredit.getBalance(customerId);
    const sum = await db('customer_credit_ledger').where({ customer_id: customerId }).sum({ total: 'delta' }).first();
    const ledgerSum = money(sum && sum.total) || 0;
    return {
      credit_balance: balance,
      credit_ledger_sum: ledgerSum,
      credit_matches_ledger: balance !== null && cents(balance) === cents(ledgerSum),
    };
  } catch (err) {
    logger.warn(`[intelligence-bar:billing-reader] credit lookup failed (${err.code || err.name || 'error'})`);
    return { credit_balance: null, credit_ledger_sum: null, credit_matches_ledger: null, unknown: 'The account credit balance could not be read; say it is unknown.' };
  }
}

// Every page of one InvoiceService.list query (the Invoices page's own
// reader), bounded. `complete: false` is returned when the bound was hit.
async function listAllInvoices(InvoiceService, params) {
  const rows = [];
  let total = 0;
  for (let page = 0; page < SUMMARY_MAX_PAGES; page += 1) {
    const result = await InvoiceService.list({ ...params, limit: SUMMARY_PAGE, offset: page * SUMMARY_PAGE });
    total = result.total;
    rows.push(...result.invoices);
    if (rows.length >= total || result.invoices.length < SUMMARY_PAGE) return { rows, total, complete: true };
  }
  return { rows, total, complete: false };
}

async function accountSummary(InvoiceService, customer, today) {
  const customerId = customer.id;
  const [unpaid, overdue, processing, credit, hold] = await Promise.all([
    listAllInvoices(InvoiceService, { customerId, status: 'unpaid', archived: 'hide' }),
    InvoiceService.list({ customerId, status: 'overdue', archived: 'hide', limit: 1, offset: 0 }),
    listAllInvoices(InvoiceService, { customerId, status: 'processing', archived: 'hide' }),
    readCredit(customerId),
    readDisputeHold(customerId),
  ]);
  const sum = (rows) => fromCents(rows.reduce((total, invoice) => total + cents(balanceDue(invoice)), 0));
  const totalDue = sum(unpaid.rows);
  const notYetSent = unpaid.rows.filter((invoice) => NOT_YET_SENT_STATUSES.includes(invoiceStatusKey(invoice.status)));
  const payerBilled = unpaid.rows.filter(isPayerBilled);
  const summary = {
    total_due: totalDue,
    outstanding_count: unpaid.total,
    overdue_count: overdue.total,
    not_yet_sent_due: sum(notYetSent),
    payer_billed_due: sum(payerBilled),
    processing: { count: processing.total, amount: fromCents(processing.rows.reduce((total, invoice) => total + cents(invoiceAmountDue(invoice)), 0)), note: 'Payments in flight (for example ACH): not received yet, and not counted in total_due.' },
    ...credit,
    dispute_hold: hold,
    as_of: today,
    basis: 'Admin Invoices page rules for this customer, archived invoices excluded: owes = total minus applied credit on every invoice not paid, prepaid, processing, void, refunded or canceled; overdue = still owed and (status overdue or due date before today, Eastern). total_due includes not_yet_sent_due (drafts and scheduled invoices the customer has not been sent) and payer_billed_due (billed to a third party); subtract them for what the customer was presented and owes personally.',
    complete: unpaid.complete && processing.complete,
  };
  if (!summary.complete) summary.unknown = 'More invoices than the summary reads in one call: total_due may be understated.';
  return summary;
}

function annualPrepayLinkage(row) {
  if (row.annual_prepay_term_id) {
    return { role: 'prepay_invoice', term_id: row.annual_prepay_term_id, term_status: row.annual_prepay_status || null };
  }
  if (row.annual_prepay_covered_term_id) return { role: 'covered_by_prepay_term', term_id: row.annual_prepay_covered_term_id, term_status: null };
  return null;
}

function paymentPlanFromList(row) {
  const plan = parseJson(row.active_payment_plan);
  if (!plan || !plan.id) return null;
  return {
    id: plan.id,
    status: plan.status,
    payment_amount: money(plan.payment_amount),
    payment_frequency: plan.payment_frequency,
    next_payment_date: dateOnly(plan.next_payment_date),
    total_balance: money(plan.total_balance),
  };
}

function invoiceItem(row, today, ledger, heldIds) {
  const payments = ledger.get(String(row.id)) || [];
  const netPaid = fromCents(payments.reduce((total, payment) => total + cents(netReceived(payment)), 0));
  const recorded = payments.some((payment) => payment.status === 'paid' || payment.status === 'refunded');
  const status = invoiceStatusKey(row.status);
  const unknown = [];
  let amountPaid = netPaid;
  let basis = 'payments table rows linked to this invoice';
  if (!recorded) {
    if (status === 'paid') {
      amountPaid = null;
      basis = 'unknown';
      unknown.push('Marked paid, but no recorded payment is linked to it in the payments table: say the amount paid is unknown.');
    } else if (status === 'prepaid') {
      amountPaid = 0;
      basis = 'prepaid: settled by account credit or an annual prepay, not by a payment row';
    } else {
      amountPaid = 0;
      basis = 'no recorded payment';
    }
  }
  if (payments.some((payment) => payment.linked_by === 'payment_intent')) {
    unknown.push('A payment linked only by Stripe PaymentIntent may cover more than this invoice (combined payment): amount_paid is not apportioned.');
  }
  const item = {
    id: row.id,
    invoice_number: row.invoice_number,
    title: scrub(row.title, 160),
    status: row.status,
    created_at: iso(row.created_at),
    sent_at: iso(row.sent_at),
    service_date: dateOnly(row.service_date),
    due_date: dateOnly(row.due_date),
    paid_at: iso(row.paid_at),
    total: money(row.total),
    credit_applied: money(row.credit_applied) || 0,
    amount_due_after_credit: invoiceAmountDue(row),
    balance_due: balanceDue(row),
    overdue: isOverdue(row, today),
    amount_paid: amountPaid,
    amount_paid_basis: basis,
    payment_recorded: recorded,
    has_active_payment_plan: Boolean(paymentPlanFromList(row)),
    payment_plan: paymentPlanFromList(row),
    dispute_hold: heldIds.has(String(row.id)),
    annual_prepay: annualPrepayLinkage(row),
    payer_billed: isPayerBilled(row),
    archived: Boolean(row.archived_at),
    archived_at: iso(row.archived_at),
  };
  if (unknown.length) item.unknown = unknown;
  return item;
}

// ─── get_customer_invoices ──────────────────────────────────────────

async function getCustomerInvoices(input, actionContext) {
  const resolved = await resolveBillingCustomer(input, actionContext);
  if (resolved.error) return resolved;
  const { customer } = resolved;
  const InvoiceService = require('../invoice');
  const { collectionHoldInvoiceIds } = require('../collections/collection-hold');
  const today = etDateString();

  const rawLimit = Number.isFinite(Number(input.limit)) ? Math.trunc(Number(input.limit)) : DEFAULT_LIMIT;
  const limit = Math.min(Math.max(rawLimit, 1), MAX_LIMIT);
  const offset = Math.max(0, Math.trunc(Number(input.offset) || 0));
  const statusFilter = LIST_STATUS_FILTERS.includes(input.status) && input.status !== 'all' ? input.status : undefined;
  const includeArchived = input.include_archived === true;

  const page = await InvoiceService.list({
    customerId: customer.id, status: statusFilter, limit, offset, archived: includeArchived ? 'all' : 'hide', sort: 'newest',
  });
  const summary = await accountSummary(InvoiceService, customer, today);
  const ledger = await loadLinkedPayments(customer.id, page.invoices);
  let heldIds = new Set();
  const unknowns = ['The live Stripe PaymentIntent state is not stored in the portal and is not read here.'];
  try {
    heldIds = await collectionHoldInvoiceIds(page.invoices.map((invoice) => invoice.id));
  } catch (err) {
    logger.warn(`[intelligence-bar:billing-reader] per-invoice hold lookup failed (${err.code || err.name || 'error'})`);
    unknowns.push('The per-invoice dispute hold could not be read; say it is unknown (the account-level dispute_hold above is the customer-wide state).');
  }

  const returned = page.invoices.length;
  const hasMore = offset + returned < page.total;
  return {
    customer: { id: customer.id, name: customerName(customer), phone_last4: phoneLast4(customer.phone) },
    account_summary: summary,
    invoices: page.invoices.map((row) => invoiceItem(row, today, ledger, heldIds)),
    returned_count: returned,
    total_matching: page.total,
    has_more: hasMore,
    next_offset: hasMore ? offset + returned : null,
    filters: { status: statusFilter || 'all', include_archived: includeArchived },
    unknowns,
    note: ATTEMPT_VS_RECEIVED,
  };
}

// ─── get_invoice_detail ─────────────────────────────────────────────

function lineItems(raw) {
  return parseLineItems(raw).map((item) => ({
    description: scrub(item.description || item.name, 200),
    quantity: item.quantity === undefined || item.quantity === null ? null : Number(item.quantity),
    unit_price: money(item.unit_price),
    amount: money(item.amount),
    category: item.category || null,
    is_discount: Number(item.amount) < 0,
  }));
}

function paymentPlanDetail(rows) {
  if (!rows.length) return null;
  const mapped = rows.map((plan) => ({
    id: plan.id,
    status: plan.status,
    payment_amount: money(plan.payment_amount),
    payment_frequency: plan.payment_frequency,
    plan_start_date: dateOnly(plan.plan_start_date),
    next_payment_date: dateOnly(plan.next_payment_date),
    total_balance: money(plan.total_balance),
    created_at: iso(plan.created_at),
    completed_at: iso(plan.completed_at),
    cancelled_at: iso(plan.cancelled_at),
  }));
  return {
    active: mapped.find((plan) => plan.status === 'active') || null,
    history: mapped.filter((plan) => plan.status !== 'active'),
    installments: 'The portal stores the plan schedule (amount, frequency, next date), not per-installment records: whether any installment was collected is unknown here.',
  };
}

// A residual the combined pay page could not settle onto its invoice. Source
// combined_pay_processing is PROVISIONAL: it is written at the processing
// stage of an ACH payment, before the bank cash has arrived, so it is an
// attempt in flight and never received. Every other source is a charge Stripe
// accepted that the portal failed to record.
const PROVISIONAL_ORPHAN_SOURCES = ['combined_pay_processing'];
function orphanEntry(row) {
  const provisional = PROVISIONAL_ORPHAN_SOURCES.includes(row.source);
  return {
    type: 'stripe_unreconciled_charge',
    id: row.id,
    at: iso(row.created_at),
    state: provisional ? 'processing (bank payment pending, funds not settled)' : 'succeeded in Stripe, not recorded in the portal ledger',
    state_note: provisional
      ? 'A bank (ACH) payment is still pending: the cash has not arrived. Not received.'
      : 'Stripe charged the customer but the portal failed to record it. Received per Stripe; the ledger needs reconciling. Do not retry the charge.',
    received: !provisional,
    ...(provisional ? { provisional: true } : { received_basis: 'Stripe state succeeded', ledger_recorded: false }),
    amount: money(row.amount),
    source: row.source || null,
    // Combined-payment residuals key the PaymentIntent as "<pi>:<invoice id>".
    stripe_payment_intent_id: row.stripe_payment_intent_id ? String(row.stripe_payment_intent_id).split(':')[0] : null,
  };
}

function summarizePayments(entries, invoice) {
  const recorded = entries.filter((entry) => entry.type === 'recorded_payment' && entry.received);
  const stripeConfirmed = entries.filter((entry) => ['stripe_charge_attempt', 'stripe_unreconciled_charge'].includes(entry.type) && entry.received && entry.ledger_recorded !== true);
  const notReceived = entries.filter((entry) => ['payment_attempt', 'stripe_charge_attempt', 'stripe_unreconciled_charge'].includes(entry.type) && !entry.received);
  const disputed = entries.filter((entry) => entry.status === 'disputed');
  const inFlight = notReceived.filter((entry) => entry.status === 'processing' || entry.state === 'claimed' || entry.state === 'ambiguous' || entry.provisional === true);
  const failed = notReceived.filter((entry) => entry.status === 'failed' || entry.status === 'canceled' || entry.state === 'failed');
  const unreconciled = entries.filter((entry) => entry.type === 'stripe_unreconciled_charge' && entry.received);
  const netRecorded = fromCents(recorded.reduce((total, entry) => total + cents(entry.net_received), 0));
  const receivedAny = recorded.length > 0 || stripeConfirmed.length > 0;

  const parts = [];
  if (recorded.length) parts.push(`${recorded.length} payment(s) recorded as received in the payments table, net $${netRecorded.toFixed(2)}`);
  if (stripeConfirmed.length) parts.push(`${stripeConfirmed.length} Stripe charge(s) that succeeded but are not in the payments table (needs reconciling)`);
  if (inFlight.length) parts.push(`${inFlight.length} attempt(s) still in flight or with an unknown outcome (NOT received)`);
  if (failed.length) parts.push(`${failed.length} failed or canceled attempt(s) (NOT received)`);
  if (disputed.length) parts.push(`${disputed.length} disputed payment(s) (not counted as received)`);
  let statement;
  if (receivedAny) statement = `Payment was received: ${parts.join('; ')}.`;
  else if (invoiceStatusKey(invoice.status) === 'prepaid') statement = 'Settled as prepaid (account credit or an annual prepay): no payment row; nothing is owed.';
  else if (invoiceStatusKey(invoice.status) === 'paid') statement = `The invoice is marked paid but no received payment is linked to it in the portal's records${parts.length ? `; ${parts.join('; ')}` : ''}. Say the payment evidence is unknown.`;
  else statement = `No payment has been received${parts.length ? `: ${parts.join('; ')}` : ' and none has been attempted that the portal recorded'}.`;

  return {
    received: receivedAny,
    recorded_payments_net: netRecorded,
    stripe_succeeded_not_in_ledger: stripeConfirmed.length,
    unreconciled_stripe_charges: unreconciled.length,
    attempts_in_flight_or_unknown: inFlight.length,
    attempts_failed_or_canceled: failed.length,
    disputed_payments: disputed.length,
    statement,
  };
}

async function getInvoiceDetail(input, actionContext) {
  if (!input.invoice_id || !UUID_RE.test(String(input.invoice_id))) {
    return { error: 'A valid invoice_id is required', code: 'invalid_target' };
  }
  const invoiceId = String(input.invoice_id).toLowerCase();
  if (input.customer_id && !UUID_RE.test(String(input.customer_id))) {
    return { error: 'A valid customer_id is required', code: 'invalid_target' };
  }
  const invoice = await db('invoices').where({ id: invoiceId }).first();
  const unavailable = { error: 'That invoice is unavailable for this customer', code: 'record_unavailable' };
  if (!invoice) return unavailable;
  if (input.customer_id && String(input.customer_id).toLowerCase() !== String(invoice.customer_id)) return unavailable;
  const scope = Array.isArray(actionContext.readCustomerIds) ? actionContext.readCustomerIds : [];
  if (scope.length && !scope.map(String).includes(String(invoice.customer_id))) {
    return { error: 'Choose the target for this lookup; the current request has not established it', code: 'target_clarification_required' };
  }
  const customer = await db('customers').where({ id: invoice.customer_id }).first('id', 'first_name', 'last_name', 'phone', 'deleted_at');
  if (!customer || customer.deleted_at) return unavailable;

  const today = etDateString();
  const linked = (await loadLinkedPayments(customer.id, [invoice])).get(String(invoice.id)) || [];
  const attempts = await db('stripe_invoice_charge_attempts').where({ invoice_id: invoice.id })
    .orderBy('created_at', 'asc').limit(TIMELINE_ROW_CAP)
    .select('id', 'status', 'amount', 'credit_applied_delta', 'stripe_payment_intent_id', 'error_message', 'decline_code', 'submitted_at', 'resolved_at', 'created_at');
  const orphans = await db('stripe_orphan_charges').where({ invoice_id: invoice.id, resolved: false })
    .orderBy('created_at', 'asc').limit(TIMELINE_ROW_CAP)
    .select('id', 'stripe_payment_intent_id', 'amount', 'source', 'created_at');
  const credits = await db('customer_credit_ledger').where({ invoice_id: invoice.id })
    .orderBy('created_at', 'asc').limit(TIMELINE_ROW_CAP)
    .select('id', 'delta', 'balance_after', 'source', 'note', 'created_by', 'created_at');
  const plans = await db('payment_plans').where({ invoice_id: invoice.id }).orderBy('created_at', 'desc').limit(5)
    .select('id', 'status', 'payment_amount', 'payment_frequency', 'plan_start_date', 'next_payment_date', 'total_balance', 'created_at', 'completed_at', 'cancelled_at');
  const hold = await readDisputeHold(customer.id);

  let prepayTerm = null;
  const termId = invoice.annual_prepay_term_id || invoice.annual_prepay_covered_term_id;
  if (termId) {
    prepayTerm = await db('annual_prepay_terms').where({ id: termId }).first('id', 'status', 'term_start', 'term_end', 'prepay_amount');
  }

  const ledgerIntents = new Set(linked.filter((row) => row.status === 'paid' && row.stripe_payment_intent_id).map((row) => row.stripe_payment_intent_id));
  const entries = [
    ...linked.map((row) => paymentEntry(row, invoice)),
    ...attempts.map((row) => attemptEntry(row, ledgerIntents)),
    ...orphans.map(orphanEntry),
    ...credits.map((row) => ({
      type: 'credit_movement',
      id: row.id,
      at: iso(row.created_at),
      received: false,
      note_on_received: 'Account credit moving is not a payment received.',
      delta: money(row.delta),
      direction: Number(row.delta) < 0 ? 'applied_to_invoice' : 'added_to_account',
      balance_after: money(row.balance_after),
      source: row.source,
      note: scrub(row.note, 160),
      created_by: scrub(row.created_by, 80),
    })),
  ].sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));

  const status = invoiceStatusKey(invoice.status);
  const lines = lineItems(invoice.line_items);
  const payerBilled = isPayerBilled(invoice);
  const unknowns = [
    'The live Stripe PaymentIntent state (requires_action, canceled, and so on) is not stored in the portal and is not read here: only the portal\'s own attempt, payment and ledger rows are shown.',
  ];
  if (invoice.stripe_payment_intent_id && status !== 'paid') {
    unknowns.push('A Stripe PaymentIntent is attached to this invoice but its live state is unknown here; do not call it paid.');
  }
  if (linked.length >= 500 || attempts.length >= TIMELINE_ROW_CAP || credits.length >= TIMELINE_ROW_CAP) {
    unknowns.push('A timeline source hit its row cap: older rows may be missing.');
  }
  if (hold.unknown) unknowns.push(hold.unknown);

  return {
    invoice: {
      id: invoice.id,
      invoice_number: invoice.invoice_number,
      title: scrub(invoice.title, 160),
      status: invoice.status,
      service_type: invoice.service_type || null,
      service_date: dateOnly(invoice.service_date),
      created_at: iso(invoice.created_at),
      sent_at: iso(invoice.sent_at),
      viewed_at: iso(invoice.viewed_at),
      due_date: dateOnly(invoice.due_date),
      paid_at: iso(invoice.paid_at),
      subtotal: money(invoice.subtotal),
      discount_amount: money(invoice.discount_amount) || 0,
      discount_label: scrub(invoice.discount_label, 120),
      tax_rate: invoice.tax_rate === null || invoice.tax_rate === undefined ? null : Number(invoice.tax_rate),
      tax_amount: money(invoice.tax_amount) || 0,
      total: money(invoice.total),
      credit_applied: money(invoice.credit_applied) || 0,
      amount_due_after_credit: invoiceAmountDue(invoice),
      balance_due: balanceDue(invoice),
      overdue: isOverdue(invoice, today),
      payer_billed: payerBilled,
      archived: Boolean(invoice.archived_at),
    },
    customer: { id: customer.id, name: customerName(customer), phone_last4: phoneLast4(customer.phone) },
    line_items: lines,
    discounts: {
      document_discount: { amount: money(invoice.discount_amount) || 0, label: scrub(invoice.discount_label, 120) },
      discount_lines: lines.filter((line) => line.is_discount),
      account_credit_applied: money(invoice.credit_applied) || 0,
    },
    payment_summary: summarizePayments(entries, invoice),
    payments_timeline: entries,
    payment_plan: paymentPlanDetail(plans),
    dispute_hold: hold,
    annual_prepay: termId ? {
      role: invoice.annual_prepay_term_id ? 'prepay_invoice' : 'covered_by_prepay_term',
      term_id: termId,
      term_status: prepayTerm ? prepayTerm.status : null,
      term_start: prepayTerm ? dateOnly(prepayTerm.term_start) : null,
      term_end: prepayTerm ? dateOnly(prepayTerm.term_end) : null,
      prepay_amount: prepayTerm ? money(prepayTerm.prepay_amount) : null,
    } : null,
    stripe: {
      payment_intent_id: invoice.stripe_payment_intent_id || null,
      processor: invoice.processor || null,
      live_state: 'not read (the portal does not store PaymentIntent state)',
    },
    unknowns,
    note: ATTEMPT_VS_RECEIVED,
  };
}

// ─── EXECUTION ──────────────────────────────────────────────────────

async function executeBillingReaderTool(toolName, input = {}, actionContext = {}) {
  // Billing is admin-only. The route and registry already refuse a
  // technician; an explicit non-admin actor is refused here too.
  if (actionContext && actionContext.isAdmin === false) {
    return { error: 'Billing readers are limited to admin accounts', code: 'permission_denied' };
  }
  const context = actionContext || {};
  try {
    switch (toolName) {
      case 'get_customer_invoices': return await getCustomerInvoices(input || {}, context);
      case 'get_invoice_detail': return await getInvoiceDetail(input || {}, context);
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    // Telemetry keeps the failure class only: the message can carry customer data.
    logger.error(`[intelligence-bar:billing-reader] ${toolName} failed (${err.code || err.name || 'error'})`);
    return { error: 'Could not read the billing records' };
  }
}

module.exports = { BILLING_READER_TOOLS, executeBillingReaderTool };
