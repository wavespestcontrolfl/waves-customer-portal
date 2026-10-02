/**
 * Intelligence Bar — Customer Billing Readers (W9)
 * server/services/intelligence-bar/billing-reader-tools.js
 *
 * Two READ-ONLY tools that answer "what does this customer owe?" from portal records:
 *
 *   get_customer_invoices  one customer's invoices + an account summary
 *   get_invoice_detail     one invoice: lines, discounts and its recorded payments
 *
 * No writes, no sends, no money movement, no migration.
 *
 * THE RULE this module exists to keep: it does not decide what money is owed or received. The payment paths
 * already do, through two fences, and an invoice's balance is reported ONLY when both pass:
 *
 *   assertInvoiceCollectible(row)                                   invoice-helpers.js: terminal status
 *                                                                   (paid, prepaid, processing, void, refunded,
 *                                                                   canceled) and a Bill-To withdrawn from the customer
 *   assertNoInvoiceChargeReconciliationPending(id, db, {readOnly})  stripe.js: an unresolved saved-card attempt,
 *                                                                   an unresolved Stripe charge the portal did not
 *                                                                   record, or a failed charge flagged ambiguous
 *
 * The read-only form of the second fence performs no writes and takes no locks (it never releases or promotes a
 * stale claim). Any other outcome, or a check that cannot run, is `collectible: false`, `balance_due: null`, with
 * the fence's reason and a pointer to the Invoices page. Nothing here infers a Stripe state, links orphan rows to
 * sibling invoices, or classifies refunds and disputes: the payments-table rows are listed as informational
 * "recorded payments" with no received / not-received verdict.
 *
 * Invoice rows, the unpaid / overdue counts and the account summary's source rows come from InvoiceService.list,
 * the admin Invoices page's own reader; the amount is invoice-helpers `invoiceAmountDue` in integer cents.
 *
 * Scope: admin-only (technicians get no billing reads — technician allow-list ruling). The route and action
 * registry enforce the role; the executor also refuses a non-admin actor and a customer outside the task's read
 * scope. Targets resolve through the same task-context selector handling and comms-tools resolveCustomer the
 * other customer readers use. There is no phone selector: the current-request grammar (task-context
 * explicitReadPhones) cannot bind an unscoped phone to a billing read, so the tools take customer_id or
 * customer_name.
 *
 * Never returned: card numbers (brand only), full emails (masked), invoice pay-link tokens, Stripe client
 * secrets, operator-only notes.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { UUID_RE } = require('./task-context');
const { etDateString } = require('../../utils/datetime-et');
const { invoiceAmountDue, assertInvoiceCollectible, invoiceWithdrawnFromCustomer } = require('../invoice-helpers');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const SUMMARY_PAGE = 100;
const SUMMARY_MAX_PAGES = 10;
// The fence runs per invoice (a few indexed reads each): bounded, in small batches.
const FENCE_SUMMARY_CAP = 100;
const FENCE_BATCH = 5;
const PAYMENT_ROW_CAP = 50;
// metadata keys that name the invoice a payment settles (the admin-invoices applied-money fence's keys).
const INVOICE_LINK_KEYS = ['invoice_id', 'dispute_invoice_id', 'waves_invoice_id'];
const NOT_YET_SENT_STATUSES = ['draft', 'scheduled', 'sending'];

const LIST_STATUS_FILTERS = ['all', 'unpaid', 'overdue', 'paid', 'prepaid', 'processing', 'draft', 'sent', 'viewed', 'void', 'refunded'];

const BALANCE_RULE = 'Read only. A balance is stated ONLY when the invoice passes the payment paths\' own collectibility checks (collectible: true). Otherwise balance_due is null with the reason: say so and send staff to the Invoices page; never guess, never say it was or was not paid, and never suggest collecting or retrying a charge. recorded_payments are informational rows, not a verdict on receipt.';

const BILLING_READER_TOOLS = [
  {
    name: 'get_customer_invoices',
    description: `List ONE customer's invoices with an account summary. Each invoice has status, title, issued and due dates, total, applied credit, collectible (true or false), balance_due, the reason when it is not collectible, whether it needs reconciliation, payment plan, dispute hold, annual-prepay linkage, payer-billed and archived flags. Newest first; follow next_offset when has_more is true.
${BALANCE_RULE} account_summary.total_due adds up ONLY the invoices that are collectible and counts the invoices that need reconciliation separately. A field the portal cannot establish comes back null with the reason in "unknown": say it is unknown. Use get_invoice_detail for one invoice's lines and recorded payments. Admin-only; never changes anything and never charges, refunds, credits or sends.
Use for: "what does this customer owe?", "list their invoices", "do they have anything overdue?", "how much credit do they have?"
Select the customer with customer_id or customer_name.`,
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', format: 'uuid', description: 'The customer to read' },
        customer_name: { type: 'string', description: 'Customer name (resolved to one customer; ambiguous names are returned as candidates)' },
        status: { type: 'string', enum: LIST_STATUS_FILTERS, description: 'Optional filter: all (default), unpaid (everything still collectible), overdue, or one status. The account summary always covers the whole account.' },
        include_archived: { type: 'boolean', description: 'Also list archived invoices (default false, as the Invoices page)' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `Invoices per page (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` },
        offset: { type: 'integer', minimum: 0, description: 'Continue from next_offset' },
      },
    },
  },
  {
    name: 'get_invoice_detail',
    description: `Read ONE invoice by invoice_id: line items, discounts, amounts, and whether it is collectible (collectible true: balance_due is stated; false: balance_due is null with the reason, and "needs reconciliation — check the Invoices page" when a charge state is unresolved). Also recorded_payments (the payments-table rows tied to the invoice: amount, status, date, method, refund amounts, and the payer when a third party funded it), dispute hold, payment plan and annual-prepay linkage.
${BALANCE_RULE} Admin-only; never changes anything and never charges, refunds, credits or sends.
Use for: "what is on invoice INV-…?", "why does this invoice still show a balance?", "what payments are recorded on it?"`,
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

// The Invoices page's overdue predicate (InvoiceService.list status=overdue), for an invoice that is collectible.
function isOverdue(invoice, today) {
  return invoiceStatusKey(invoice.status) === 'overdue' || Boolean(dateOnly(invoice.due_date) && dateOnly(invoice.due_date) < today);
}

// Billed to a third party: a payer or statement on the invoice, or the packet withdrawal stamp the payment
// paths read through invoiceWithdrawnFromCustomer.
const isPayerBilled = (invoice) => invoice.payer_id != null || invoice.payer_statement_id != null || invoiceWithdrawnFromCustomer(invoice);

// ─── customer selection ─────────────────────────────────────────────

// Same resolution the other customer readers use. In a platform task the
// route's prepareReadInput has already turned a name into the task
// customer's id (task-context resolveCustomerSelector, which also refuses a
// substitute); this keeps a direct or legacy call equivalent: id first, then
// name, an ambiguous name returned as candidates, and a name that disagrees
// with the id refused as selector_conflict.
async function resolveBillingCustomer(input, actionContext) {
  if (!input.customer_id && !input.customer_name) {
    return { error: 'Give customer_id or customer_name to say whose invoices to read', code: 'selector_required' };
  }
  if (input.customer_id && !UUID_RE.test(String(input.customer_id))) {
    return { error: 'A valid customer_id is required', code: 'invalid_target' };
  }
  const { resolveCustomer } = require('./comms-tools');
  const customer = await resolveCustomer({
    customer_id: input.customer_id ? String(input.customer_id).toLowerCase() : undefined,
    customer_name: input.customer_name,
  });
  if (customer && customer.error) return customer;
  if (!customer) return { error: 'No customer matched that selector', code: 'record_unavailable' };
  if (customer.deleted_at) return { error: 'That customer record is archived', code: 'record_unavailable' };
  if (input.customer_id) {
    const full = `${customer.first_name || ''} ${customer.last_name || ''}`.toLowerCase();
    const nameDisagrees = input.customer_name && !full.includes(String(input.customer_name).trim().toLowerCase());
    if (nameDisagrees) {
      return { error: 'The customer_id and name given do not describe the same customer. Give one selector, or fix the one that is wrong.', code: 'selector_conflict' };
    }
  }
  const scope = Array.isArray(actionContext.readCustomerIds) ? actionContext.readCustomerIds : [];
  if (scope.length && !scope.map(String).includes(String(customer.id))) {
    return { error: 'Use the resolved task customer for this record lookup', code: 'target_clarification_required' };
  }
  return { customer };
}


// ─── the payment fences ─────────────────────────────────────────────

const FENCE_CODES = ['STRIPE_AMBIGUOUS_OUTCOME', 'STRIPE_CHARGE_IN_PROGRESS', 'STRIPE_CHARGED_DB_FAILED'];
const RECONCILE_POINTER = 'needs reconciliation — check the Invoices page';
// A PaymentIntent id in a fence message is not needed to answer; keep it out.
const fenceReason = (message) => scrub(String(message || '').replace(/\bpi_[A-Za-z0-9_]+/g, '[payment]'), 200);

// Is this invoice collectible? BOTH fences must pass: the pay paths' own collectibility gate and the saved-card
// reconciliation fence (read-only form: no writes, no locks). Anything else is not collectible, with a reason.
async function invoiceFence(invoice) {
  try {
    assertInvoiceCollectible(invoice);
  } catch (err) {
    return { collectible: false, needs_reconciliation: false, reason: fenceReason(err.message) || 'This invoice is not collectible', balance_due: null };
  }
  try {
    await require('../stripe').assertNoInvoiceChargeReconciliationPending(invoice.id, db, { readOnly: true });
  } catch (err) {
    const known = FENCE_CODES.includes(err.code);
    if (!known) logger.warn(`[intelligence-bar:billing-reader] charge fence could not run (${err.code || err.name || 'error'})`);
    return {
      collectible: false,
      needs_reconciliation: true,
      reason: `${known ? fenceReason(err.message) : 'The payment-state check could not be completed'} — ${RECONCILE_POINTER}`,
      balance_due: null,
    };
  }
  return { collectible: true, needs_reconciliation: false, reason: null, balance_due: invoiceAmountDue(invoice) };
}

async function fenceAll(invoices) {
  const out = new Map();
  for (let at = 0; at < invoices.length; at += FENCE_BATCH) {
    const batch = invoices.slice(at, at + FENCE_BATCH);
    const results = await Promise.all(batch.map((invoice) => invoiceFence(invoice)));
    batch.forEach((invoice, index) => out.set(String(invoice.id), results[index]));
  }
  return out;
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

async function accountSummary(InvoiceService, customer, today) {
  const customerId = customer.id;
  const [unpaid, overdue, processing, credit, hold] = await Promise.all([
    listAllInvoices(InvoiceService, { customerId, status: 'unpaid', archived: 'hide' }),
    InvoiceService.list({ customerId, status: 'overdue', archived: 'hide', limit: 1, offset: 0 }),
    InvoiceService.list({ customerId, status: 'processing', archived: 'hide', limit: 1, offset: 0 }),
    readCredit(customerId),
    readDisputeHold(customerId),
  ]);
  const unknowns = [];
  // total_due is the sum of the invoices whose fences passed. It needs every unpaid invoice read AND fenced:
  // a partial read, or more invoices than the fence is run for, makes it unknown rather than a partial number.
  let fenced = null;
  if (!unpaid.complete) unknowns.push('More unpaid invoices than the summary reads in one call: total_due and its splits are null (unknown), not zero.');
  else if (unpaid.rows.length > FENCE_SUMMARY_CAP) unknowns.push(`More than ${FENCE_SUMMARY_CAP} unpaid invoices to check for reconciliation: total_due and its splits are null (unknown), not zero. Page through get_customer_invoices.`);
  else fenced = await fenceAll(unpaid.rows);
  const rowsWhere = (test) => (fenced ? unpaid.rows.filter((invoice) => fenced.get(String(invoice.id)).collectible && test(invoice)) : null);
  const sum = (rows) => (rows ? fromCents(rows.reduce((total, invoice) => total + cents(invoiceAmountDue(invoice)), 0)) : null);
  const needsReconciliation = fenced ? unpaid.rows.filter((invoice) => fenced.get(String(invoice.id)).needs_reconciliation).length : null;
  const otherNotCollectible = fenced ? unpaid.rows.filter((invoice) => !fenced.get(String(invoice.id)).collectible && !fenced.get(String(invoice.id)).needs_reconciliation).length : null;
  if (needsReconciliation > 0) unknowns.push(`${needsReconciliation} invoice(s) need reconciliation and are NOT in total_due: check them on the Invoices page; do not collect or retry.`);
  if (otherNotCollectible > 0) unknowns.push(`${otherNotCollectible} unpaid invoice(s) are not collectible from this customer (for example billed to a third party) and are not in total_due.`);
  const notYetSent = (invoice) => NOT_YET_SENT_STATUSES.includes(invoiceStatusKey(invoice.status));
  const summary = {
    total_due: sum(rowsWhere(() => true)),
    outstanding_count: unpaid.total,
    needs_reconciliation_count: needsReconciliation,
    overdue_count: overdue.total,
    not_yet_sent_due: sum(rowsWhere(notYetSent)),
    payer_billed_due: sum(rowsWhere(isPayerBilled)),
    presented_self_pay_due: sum(rowsWhere((invoice) => !notYetSent(invoice) && !isPayerBilled(invoice))),
    processing: { count: processing.total, note: 'Bank payments in flight: not counted in total_due; their amounts are not stated here.' },
    ...credit,
    dispute_hold: hold,
    as_of: today,
    basis: 'total_due adds up only the unpaid invoices that pass the payment paths\' collectibility checks (amount due = total minus applied credit); invoices that need reconciliation are counted separately and excluded. total_due includes not_yet_sent_due (drafts and scheduled invoices not yet sent) and payer_billed_due (billed to a third party); the two can overlap, so never subtract them from total_due: presented_self_pay_due is what the customer was actually sent and owes personally.',
  };
  if (unknowns.length) summary.unknown = unknowns.join(' ');
  return summary;
}

// `fence` is the invoice's invoiceFence() verdict: the balance is stated only when it is collectible.
function invoiceItem(row, today, fence, heldIds) {
  return {
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
    collectible: fence.collectible,
    balance_due: fence.balance_due,
    ...(fence.reason ? { reason: fence.reason } : {}),
    needs_reconciliation: fence.needs_reconciliation,
    overdue: fence.collectible ? isOverdue(row, today) : null,
    has_active_payment_plan: Boolean(paymentPlanFromList(row)),
    payment_plan: paymentPlanFromList(row),
    dispute_hold: heldIds ? heldIds.has(String(row.id)) : null,
    annual_prepay: annualPrepayLinkage(row),
    payer_billed: isPayerBilled(row),
    archived: Boolean(row.archived_at),
    archived_at: iso(row.archived_at),
  };
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
  const fences = await fenceAll(page.invoices);
  const unknowns = [];
  let heldIds = new Set();
  try {
    heldIds = await collectionHoldInvoiceIds(page.invoices.map((invoice) => invoice.id));
  } catch (err) {
    logger.warn(`[intelligence-bar:billing-reader] per-invoice hold lookup failed (${err.code || err.name || 'error'})`);
    heldIds = null;
    unknowns.push('The per-invoice dispute hold could not be read; say it is unknown (the account-level dispute_hold above is the customer-wide state).');
  }

  const returned = page.invoices.length;
  const hasMore = offset + returned < page.total;
  return {
    customer: { id: customer.id, name: customerName(customer), phone_last4: phoneLast4(customer.phone) },
    account_summary: summary,
    invoices: page.invoices.map((row) => invoiceItem(row, today, fences.get(String(row.id)), heldIds)),
    returned_count: returned,
    total_matching: page.total,
    has_more: hasMore,
    next_offset: hasMore ? offset + returned : null,
    filters: { status: statusFilter || 'all', include_archived: includeArchived },
    unknowns,
    note: BALANCE_RULE,
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

// A charge Stripe accepted that the portal did not record. Only a source that
// states the PaymentIntent SUCCEEDED counts as received; every other source
// (combined_pay_processing is an ACH residual written before the cash arrives;

// The payments-table rows tied to this invoice by the portal's own linkage keys (metadata.invoice_id,
// dispute_invoice_id, waves_invoice_id) and the manual-payment description (receipt-payment.js
// loadPaymentForInvoice). Informational: no row is classified as received or not received here.
async function loadRecordedPayments(customerId, invoice) {
  const rows = await db('payments')
    .where({ customer_id: customerId })
    .where(function linkedToInvoice() {
      for (const key of INVOICE_LINK_KEYS) this.orWhereRaw(`payments.metadata::jsonb ->> '${key}' = ?`, [String(invoice.id)]);
      if (/^[A-Za-z0-9-]+$/.test(String(invoice.invoice_number || ''))) this.orWhereRaw('payments.description LIKE ?', [`Invoice ${invoice.invoice_number} — %`]);
    })
    .orderBy('created_at', 'desc')
    .limit(PAYMENT_ROW_CAP + 1)
    .select('id', 'payment_date', 'amount', 'status', 'metadata', 'created_at', 'processor', 'card_brand', 'payment_method_type', 'refund_amount', 'refund_status', 'payer_id');
  const kept = rows.slice(0, PAYMENT_ROW_CAP);
  const payerRef = (row) => (row.payer_id != null ? row.payer_id : (parseJson(row.metadata) || {}).payer_id);
  const payerIds = [...new Set(kept.map(payerRef).filter((id) => Number.isInteger(Number(id)) && Number(id) > 0).map(Number))];
  let names = new Map();
  if (payerIds.length) {
    try {
      names = new Map((await db('payers').whereIn('id', payerIds).select('id', 'display_name')).map((payer) => [Number(payer.id), scrub(payer.display_name, 120)]));
    } catch (err) {
      logger.warn(`[intelligence-bar:billing-reader] payer name lookup failed (${err.code || err.name || 'error'})`);
    }
  }
  return {
    truncated: rows.length > PAYMENT_ROW_CAP,
    payments: kept.reverse().map((row) => {
      const payer = payerRef(row);
      return {
        id: row.id,
        date: dateOnly(row.payment_date),
        recorded_at: iso(row.created_at),
        amount: money(row.amount),
        status: row.status,
        method: row.processor ? [row.processor, row.card_brand, row.payment_method_type].filter(Boolean).join(' ') : (invoice.payment_method || 'manual'),
        refunded_amount: money(row.refund_amount) || 0,
        refund_status: row.refund_status || null,
        ...(payer != null ? { funded_by_payer: { id: Number(payer) || null, name: names.get(Number(payer)) || null } } : {}),
      };
    }),
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
  const fence = await invoiceFence(invoice);
  const recorded = await loadRecordedPayments(customer.id, invoice);
  const plans = await db('payment_plans').where({ invoice_id: invoice.id }).orderBy('created_at', 'desc').limit(5)
    .select('id', 'status', 'payment_amount', 'payment_frequency', 'plan_start_date', 'next_payment_date', 'total_balance', 'created_at', 'completed_at', 'cancelled_at');
  const hold = await readDisputeHold(customer.id);

  let prepayTerm = null;
  const termId = invoice.annual_prepay_term_id || invoice.annual_prepay_covered_term_id;
  if (termId) {
    prepayTerm = await db('annual_prepay_terms').where({ id: termId }).first('id', 'status', 'term_start', 'term_end', 'prepay_amount');
  }

  const lines = lineItems(invoice.line_items);
  const unknowns = [];
  if (hold.unknown) unknowns.push(hold.unknown);
  if (recorded.truncated) unknowns.push('More payment rows are tied to this invoice than were read: the newest are shown.');

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
      collectible: fence.collectible,
      balance_due: fence.balance_due,
      ...(fence.reason ? { reason: fence.reason } : {}),
      needs_reconciliation: fence.needs_reconciliation,
      overdue: fence.collectible ? isOverdue(invoice, today) : null,
      payer_billed: isPayerBilled(invoice),
      payment_method: invoice.payment_method || null,
      payment_reference: scrub(invoice.payment_reference, 120),
      payment_recorded_by: scrub(invoice.payment_recorded_by, 80),
      payment_recorded_at: iso(invoice.payment_recorded_at),
      archived: Boolean(invoice.archived_at),
    },
    customer: { id: customer.id, name: customerName(customer), phone_last4: phoneLast4(customer.phone) },
    line_items: lines,
    discounts: {
      document_discount: { amount: money(invoice.discount_amount) || 0, label: scrub(invoice.discount_label, 120) },
      discount_lines: lines.filter((line) => line.is_discount),
      account_credit_applied: money(invoice.credit_applied) || 0,
    },
    recorded_payments: recorded.payments,
    recorded_payments_note: 'Informational: the payments-table rows tied to this invoice, with no verdict on whether it was paid or what is owed. collectible and balance_due decide that.',
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
    unknowns,
    note: BALANCE_RULE,
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
