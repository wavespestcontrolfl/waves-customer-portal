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
const { invoiceAmountDue, invoiceWithdrawnFromCustomer, INVOICE_UNCOLLECTIBLE_STATUSES } = require('../invoice-helpers');

// The collection fence's own ambiguous-failed-payment rule (stripe.js); loaded on use, not at module load.
const failedPaymentOutcomeIsAmbiguous = (row) => require('../stripe').failedPaymentOutcomeIsAmbiguous(row);

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const SUMMARY_PAGE = 100;
const SUMMARY_MAX_PAGES = 10;
const TIMELINE_ROW_CAP = 50;
const PAYMENT_ROW_CAP = 500;
const PAYMENT_COLUMNS = ['id', 'customer_id', 'payment_date', 'amount', 'status', 'description', 'metadata', 'created_at', 'processor',
  'stripe_payment_intent_id', 'stripe_charge_id', 'refund_amount', 'refund_status', 'refunded_at', 'failure_reason',
  'card_brand', 'payment_method_type', 'payer_id', 'retry_count', 'next_retry_at', 'superseded_by_payment_id', 'statement_id'];
// metadata keys that name the invoice a payment settles, in precedence order.
const INVOICE_LINK_KEYS = ['invoice_id', 'dispute_invoice_id', 'waves_invoice_id'];

// Newest rows first, one past the cap, so a truncated read is detected rather
// than guessed and the most recent evidence (the unresolved attempt) is never
// the part that is dropped. Returned oldest first.
async function newestRows(query) {
  const rows = await query.orderBy('created_at', 'desc').limit(TIMELINE_ROW_CAP + 1);
  return { rows: rows.slice(0, TIMELINE_ROW_CAP).reverse(), truncated: rows.length > TIMELINE_ROW_CAP };
}
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
    description: `Read ONE invoice by invoice_id: line items, discounts, amounts, balance, and a payments timeline that keeps the kinds of evidence apart by type: recorded_payment (the payments table, including manual cash/check/Zelle payments with method, reference and date), payment_attempt (a payments row that is processing, failed, canceled or upcoming), stripe_charge_attempt (saved-card charge attempts and their state), stripe_unreconciled_charge (Stripe charged but the portal never recorded it), credit_movement (account-credit ledger rows), and payer_payment (money a third-party payer settled: never the customer's own payment). Also dispute hold, payment plan and annual-prepay linkage.
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

// Billed to a third party: a payer or statement on the invoice, or the packet withdrawal stamp the payment
// paths read through invoiceWithdrawnFromCustomer (a sent invoice whose Bill-To moved leaves both payer
// columns null and records ownership only in scheduled_send_error).
const isPayerBilled = (invoice) => invoice.payer_id != null || invoice.payer_statement_id != null || invoiceWithdrawnFromCustomer(invoice);

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
  if (!invoices.length) return { linked, truncated: false };
  const ids = invoices.map((invoice) => String(invoice.id));
  const intents = [...new Set(invoices.map((invoice) => invoice.stripe_payment_intent_id).filter(Boolean))];
  const charges = [...new Set(invoices.map((invoice) => invoice.stripe_charge_id).filter(Boolean))];
  const numbers = invoices.map((invoice) => invoice.invoice_number).filter((number) => /^[A-Za-z0-9-]+$/.test(String(number || '')));
  const patterns = numbers.map((number) => `Invoice ${number} — %`);
  const customerRows = await db('payments')
    .where({ customer_id: customerId })
    .where(function linkedToPage() {
      // The canonical linkage keys (admin-invoices applied-money fence): the dispute webhook clears the
      // invoice's Stripe ids and leaves dispute_invoice_id as the only link on a card-on-file row.
      for (const key of INVOICE_LINK_KEYS) this.orWhereRaw(`payments.metadata::jsonb ->> '${key}' = ANY(?)`, [ids]);
      if (intents.length) this.orWhereRaw('payments.stripe_payment_intent_id = ANY(?)', [intents]);
      if (charges.length) this.orWhereRaw('payments.stripe_charge_id = ANY(?)', [charges]);
      if (patterns.length) this.orWhereRaw('payments.description LIKE ANY(?)', [patterns]);
    })
    .orderBy('created_at', 'desc')
    .limit(PAYMENT_ROW_CAP + 1)
    .select(PAYMENT_COLUMNS);
  // A payer statement settles ONE payments row (customer_id NULL, statement_id) for every child invoice it
  // covers (payer-statement-settle.js): read it for invoices carrying payer_statement_id.
  const statementIds = [...new Set(invoices.map((invoice) => invoice.payer_statement_id).filter((id) => id != null).map(String))];
  const statementRows = statementIds.length
    ? await db('payments').whereRaw('payments.statement_id::text = ANY(?)', [statementIds]).orderBy('created_at', 'desc').limit(PAYMENT_ROW_CAP + 1)
      .select(PAYMENT_COLUMNS)
    : [];
  const truncated = customerRows.length > PAYMENT_ROW_CAP || statementRows.length > PAYMENT_ROW_CAP;
  const seen = new Set();
  const rows = [...customerRows.slice(0, PAYMENT_ROW_CAP), ...statementRows.slice(0, PAYMENT_ROW_CAP)].filter((row) => !seen.has(row.id) && seen.add(row.id));
  for (const row of rows.sort((a, b) => new Date(a.created_at) - new Date(b.created_at))) {
    const metadata = parseJson(row.metadata) || {};
    const explicitKey = INVOICE_LINK_KEYS.find((key) => metadata[key]);
    for (const invoice of invoices) {
      let by = null;
      if (row.statement_id != null && row.customer_id == null) {
        // Statement-level money: it belongs to the statement, never to one child invoice's share.
        if (invoice.payer_statement_id != null && String(invoice.payer_statement_id) === String(row.statement_id)) {
          linked.get(String(invoice.id)).push({ ...row, linked_by: 'payer_statement', payer_funded: true, payer_ref: row.payer_id, statement_level: true });
        }
        continue;
      }
      // An explicit metadata.invoice_id is authoritative: a combined payment
      // writes one row per invoice, each with its own invoice_id but a shared
      // PaymentIntent and charge, so the PaymentIntent link below must never
      // attach a sibling's row. The legacy linkage applies only to rows that
      // carry no invoice_id at all.
      if (explicitKey) {
        const matched = INVOICE_LINK_KEYS.find((key) => metadata[key] && String(metadata[key]) === String(invoice.id));
        if (matched) by = `metadata.${matched}`;
      } else if (invoice.stripe_payment_intent_id && row.stripe_payment_intent_id === invoice.stripe_payment_intent_id) by = 'payment_intent';
      else if (invoice.stripe_charge_id && row.stripe_charge_id === invoice.stripe_charge_id) by = 'charge';
      else if (invoice.invoice_number && String(row.description || '').startsWith(`Invoice ${invoice.invoice_number} — `)) by = 'description';
      if (by) {
        // Money a third-party payer settled is not the customer's own payment: a payer-billed invoice, a
        // payments.payer_id, or metadata.payer_id (the legacy shape) marks the row payer-funded.
        const payerRef = row.payer_id != null ? row.payer_id : (metadata.payer_id != null ? metadata.payer_id : invoice.payer_id);
        const payerFunded = row.payer_id != null || metadata.payer_id != null || isPayerBilled(invoice);
        linked.get(String(invoice.id)).push({ ...row, linked_by: by, payer_funded: payerFunded, payer_ref: payerFunded ? payerRef : null });
      }
    }
  }
  await nameFundingPayers(linked);
  return { linked, truncated };
}

// Payer names for the payer-funded rows, so the answer says WHO paid. A failed lookup leaves the name
// blank ("a third-party payer"); the row stays payer-funded either way.
async function nameFundingPayers(linked) {
  const rows = [...linked.values()].flat().filter((row) => row.payer_funded);
  const payerIds = [...new Set(rows.map((row) => Number(row.payer_ref)).filter((id) => Number.isInteger(id) && id > 0))];
  let names = new Map();
  if (payerIds.length) {
    try {
      const found = await db('payers').whereIn('id', payerIds).select('id', 'display_name');
      names = new Map(found.map((payer) => [Number(payer.id), scrub(payer.display_name, 120)]));
    } catch (err) {
      logger.warn(`[intelligence-bar:billing-reader] payer name lookup failed (${err.code || err.name || 'error'})`);
    }
  }
  for (const row of rows) row.payer_name = names.get(Number(row.payer_ref)) || null;
}

// Payment status -> received. Only a recorded successful payment counts; a
// refunded one was received and is shown with what came back; a dispute is a
// state, not a payment.
const RECEIVED_PAYMENT_STATUSES = ['paid', 'refunded'];
// payments.refund_status holds Stripe's refund state (stripe.js stamps refund.status) or, from the webhook,
// 'full' / 'partial'. A refund Stripe has not completed has not returned the money yet.
const refundIsPending = (row) => Number(row.refund_amount) > 0 && ['pending', 'requires_action'].includes(String(row.refund_status || '').toLowerCase());
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

// A third-party payer's settlement is its own kind of evidence: never `received` as the customer's payment.
function payerPaymentEntry(row) {
  return {
    type: 'payer_payment',
    id: row.id,
    at: iso(row.created_at),
    payment_date: dateOnly(row.payment_date),
    status: row.status,
    received: false,
    received_from_customer: false,
    funded_by: { kind: 'third_party_payer', name: row.payer_name || null },
    state_note: row.statement_level
      ? `Settled by a third-party payer${row.payer_name ? ` (${row.payer_name})` : ''} through payer statement S-${row.statement_id}, not by the customer. The statement amount covers every invoice on that statement: it is statement-level and is NOT this invoice's share. Recorded status: ${row.status}.`
      : `Funded by a third-party payer${row.payer_name ? ` (${row.payer_name})` : ''}, not by the customer: never call it the customer's payment. Recorded status: ${row.status}.`,
    amount: row.statement_level ? null : money(row.amount),
    ...(row.statement_level ? { statement_level: { statement_id: String(row.statement_id), statement_amount: money(row.amount), applies_to: 'all invoices on the statement, not this invoice alone' } } : {}),
    refunded_amount: money(row.refund_amount) || 0,
    stripe_payment_intent_id: row.stripe_payment_intent_id || null,
    attempt_ref: (parseJson(row.metadata) || {}).idempotency_key || null,
    payer_funded: true,
    linked_by: row.linked_by,
  };
}

function paymentEntry(row, invoice) {
  if (row.payer_funded) return payerPaymentEntry(row);
  const received = RECEIVED_PAYMENT_STATUSES.includes(row.status);
  // The payment paths fence a no-PaymentIntent failure flagged ambiguous_outcome: Stripe may have collected.
  const ambiguous = failedPaymentOutcomeIsAmbiguous(row);
  const manual = !row.processor;
  const entry = {
    type: received || row.status === 'disputed' ? 'recorded_payment' : 'payment_attempt',
    id: row.id,
    at: iso(row.created_at),
    payment_date: dateOnly(row.payment_date),
    status: row.status,
    received,
    state_note: ambiguous
      ? 'Marked failed, but the portal flagged the outcome as ambiguous (no PaymentIntent came back): Stripe may have collected the money. Receipt is unconfirmed: do not call it failed or not received, and do not retry the charge.'
      : PAYMENT_STATE_NOTES[row.status] || 'Unrecognized payment status: treat as not received.',
    ...(ambiguous ? { ambiguous_outcome: true } : {}),
    amount: money(row.amount),
    ...(received ? { net_received: refundIsPending(row) ? null : fromCents(cents(row.amount) - cents(row.refund_amount)) } : {}),
    refunded_amount: money(row.refund_amount) || 0,
    refund_status: row.refund_status || null,
    ...(refundIsPending(row) ? { refund_pending: true, refund_note: `A $${money(row.refund_amount).toFixed(2)} refund is PENDING (Stripe has not completed it): the money has not returned yet, so the net amount is unknown. Do not call it refunded.` } : {}),
    source: manual ? 'manual' : row.processor,
    ...(manual ? {
      method: invoice.payment_method || null,
      reference: scrub(invoice.payment_reference, 120),
      recorded_by: scrub(invoice.payment_recorded_by, 80),
      recorded_at: iso(invoice.payment_recorded_at),
    } : { card_brand: row.card_brand || null, method_type: row.payment_method_type || null }),
    stripe_payment_intent_id: row.stripe_payment_intent_id || null,
    attempt_ref: (parseJson(row.metadata) || {}).idempotency_key || null,
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
  claimed: 'A saved-card charge was started and has no recorded result: receipt unconfirmed (Stripe may already have charged the customer). Do not call it not received, and do not retry the charge.',
  ambiguous: 'The outcome is unknown: Stripe may or may not have charged. Not confirmed received.',
  failed: 'The charge failed: no money received.',
  succeeded: 'Stripe reports this charge succeeded.',
};
const CLAIMED_NOT_SUBMITTED_NOTE = 'A saved-card charge was claimed and the portal recorded no submission to Stripe and no result: receipt unconfirmed. Do not call it not received, and do not retry the charge.';

function attemptEntry(row, ledgerStates, ledgerComplete = true) {
  const inFlight = row.status === 'claimed' && Boolean(row.submitted_at);
  // A saved-card attempt also closes as succeeded when account credit alone
  // covered the invoice: it then has no PaymentIntent and no card was charged.
  // Only an attempt that carries a PaymentIntent is evidence of a Stripe charge.
  const stripeCharge = Boolean(row.stripe_payment_intent_id);
  const creditOnly = row.status === 'succeeded' && !stripeCharge;
  const ledgerState = stripeCharge ? ledgerStates.get(row.stripe_payment_intent_id) || null : null;
  // The payment's CURRENT recorded state governs: a succeeded attempt whose
  // ledger row is now disputed is not "paid", and one whose ledger row is
  // refunded or disputed is not a charge missing from the ledger.
  const succeeded = row.status === 'succeeded' && stripeCharge && ledgerState !== 'disputed';
  let stateNote = ATTEMPT_STATE_NOTES[row.status] || 'Unrecognized attempt state: treat as not received.';
  if (row.status === 'claimed' && !inFlight) stateNote = CLAIMED_NOT_SUBMITTED_NOTE;
  if (creditOnly) stateNote = 'The attempt closed as succeeded without a Stripe PaymentIntent: account credit settled the invoice and no card was charged. A credit settlement is not a payment received.';
  else if (row.status === 'succeeded' && ledgerState === 'disputed') stateNote = 'Stripe reported this charge succeeded, but a dispute is now recorded on the matching payment: do not call it paid.';
  return {
    type: 'stripe_charge_attempt',
    id: row.id,
    at: iso(row.created_at),
    state: row.status,
    state_label: inFlight ? 'processing (submitted to Stripe, no result recorded yet)' : row.status,
    state_note: stateNote,
    received: succeeded,
    ...(creditOnly ? { settled_by: 'account_credit' } : {}),
    ...(row.status === 'succeeded' && stripeCharge ? { ledger_recorded: ledgerState ? true : (ledgerComplete ? false : null), ledger_state: ledgerState } : {}),
    ...(succeeded ? { received_basis: 'Stripe attempt state succeeded' } : {}),
    amount: money(row.amount),
    credit_applied_with_attempt: money(row.credit_applied_delta) || 0,
    submitted_at: iso(row.submitted_at),
    resolved_at: iso(row.resolved_at),
    stripe_payment_intent_id: row.stripe_payment_intent_id || null,
    attempt_ref: row.idempotency_key || null,
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

const pgBase = (value) => (value ? String(value).split(':')[0] : null);
// Reversal records the webhook parks against a PaymentIntent that cannot be attributed to one invoice:
// "<pi>:partial-refund:<id>", "<pi>:partial-dispute:<id>" and "<pi>:dispute-won:<id>:<invoice>".
const REVERSAL_KEY = /:(partial-refund|partial-dispute|dispute-won):/;
const STATEMENT_ORPHAN_MARKER = /^statement S-(\d+):/;

// Unresolved stripe_orphan_charges for these invoices, by every linkage the webhook writes, shared by the list
// and the detail so both reach the same verdict:
//   direct      invoice_id (a combined PaymentIntent is quarantined against the ANCHOR invoice only)
//   shared      the orphan's PaymentIntent (before any ":<invoice id>" suffix) is the one stamped on the
//               invoice: every invoice a combined PaymentIntent allocated carries it (pay-combined.js)
//   reversal    a partial refund / partial dispute / dispute-won reinstatement parked under a suffixed key
//               (invoice_id often NULL because a combined charge cannot attribute it to one share): reversal
//               evidence, never a charge
//   statement   customer_id and invoice_id NULL (a partial statement refund before settlement), tied to an
//               invoice with payer_statement_id through the statement's PaymentIntent or its
//               "statement S-<id>:" marker
async function loadUnresolvedOrphans(invoices) {
  const byInvoice = new Map(invoices.map((invoice) => [String(invoice.id), { orphans: [], statementOrphans: [], reversalOrphans: [] }]));
  if (!invoices.length) return { byInvoice, truncated: false };
  const ids = invoices.map((invoice) => String(invoice.id));
  const intents = [...new Set(invoices.map((invoice) => invoice.stripe_payment_intent_id).filter(Boolean))];
  const statementIds = [...new Set(invoices.map((invoice) => invoice.payer_statement_id).filter((id) => id != null).map(String))];
  const statementIntents = new Map(statementIds.map((id) => [id, new Set()]));
  if (statementIds.length) {
    const [statements, settlements] = await Promise.all([
      db('payer_statements').whereRaw('id::text = ANY(?)', [statementIds]).select('id', 'stripe_payment_intent_id'),
      db('payments').whereRaw('statement_id::text = ANY(?)', [statementIds]).whereNotNull('stripe_payment_intent_id').select('statement_id', 'stripe_payment_intent_id'),
    ]);
    for (const row of statements) if (row.stripe_payment_intent_id) statementIntents.get(String(row.id)).add(pgBase(row.stripe_payment_intent_id));
    for (const row of settlements) statementIntents.get(String(row.statement_id)).add(pgBase(row.stripe_payment_intent_id));
  }
  const statementIntentList = [...new Set([...statementIntents.values()].flatMap((set) => [...set]))];
  const rows = await db('stripe_orphan_charges').where({ resolved: false }).where(function linkedToPage() {
    this.whereIn('invoice_id', ids);
    if (intents.length) this.orWhereRaw("split_part(stripe_orphan_charges.stripe_payment_intent_id, ':', 1) = ANY(?)", [intents]);
    if (statementIntentList.length) this.orWhereRaw("split_part(stripe_orphan_charges.stripe_payment_intent_id, ':', 1) = ANY(?)", [statementIntentList]);
    if (statementIds.length) this.orWhereRaw('stripe_orphan_charges.original_db_error LIKE ANY(?)', [statementIds.map((id) => `statement S-${id}:%`)]);
  }).orderBy('created_at', 'desc').limit(PAYMENT_ROW_CAP + 1)
    .select('id', 'invoice_id', 'customer_id', 'stripe_payment_intent_id', 'amount', 'source', 'original_db_error', 'created_at');
  for (const row of rows.slice(0, PAYMENT_ROW_CAP).reverse()) {
    const base = pgBase(row.stripe_payment_intent_id);
    const marked = STATEMENT_ORPHAN_MARKER.exec(String(row.original_db_error || ''));
    for (const invoice of invoices) {
      const slot = byInvoice.get(String(invoice.id));
      if (REVERSAL_KEY.test(String(row.stripe_payment_intent_id || ''))) {
        if ((row.invoice_id != null && String(row.invoice_id) === String(invoice.id)) || (base && base === invoice.stripe_payment_intent_id)) slot.reversalOrphans.push(row);
      } else if (row.invoice_id != null && String(row.invoice_id) === String(invoice.id)) slot.orphans.push({ ...row, linked_by: 'invoice_id' });
      else if (row.invoice_id != null && base && base === invoice.stripe_payment_intent_id) slot.orphans.push({ ...row, linked_by: 'shared_payment_intent' });
      else if (row.invoice_id == null && row.customer_id == null && invoice.payer_statement_id != null) {
        const statement = String(invoice.payer_statement_id);
        if ((marked && marked[1] === statement) || (base && statementIntents.get(statement).has(base))) slot.statementOrphans.push(row);
      }
    }
  }
  return { byInvoice, truncated: rows.length > PAYMENT_ROW_CAP };
}

// The customer's unresolved charge evidence (null = could not be read): orphan charges, the claimed /
// ambiguous attempts the collection fence holds (stripe.js assertNoInvoiceChargeReconciliationPending), and
// failed rows flagged ambiguous_outcome (that fence's no-PaymentIntent query, scoped to the customer).
async function countUnconfirmedCharges(customerId) {
  try {
    const count = async (query) => Number((await query.count({ n: '*' }).first() || {}).n) || 0;
    const [orphans, attempts, ambiguous] = await Promise.all([
      count(db('stripe_orphan_charges').where({ customer_id: customerId, resolved: false }).whereNotNull('invoice_id')),
      count(db('stripe_invoice_charge_attempts as a').join('invoices as i', 'i.id', 'a.invoice_id').where('i.customer_id', customerId)
        .whereIn('a.status', ['claimed', 'ambiguous']).whereNull('a.resolved_at')),
      count(db('payments').where({ customer_id: customerId, status: 'failed' }).whereNull('stripe_payment_intent_id')
        .whereRaw("COALESCE((metadata::jsonb ->> 'ambiguous_outcome')::boolean, false) = true")
        .whereRaw('(superseded_by_payment_id IS NULL OR superseded_by_payment_id = payments.id)')),
    ]);
    return { orphans, attempts: attempts + ambiguous };
  } catch (err) {
    logger.warn(`[intelligence-bar:billing-reader] unconfirmed charge count failed (${err.code || err.name || 'error'})`);
    return null;
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
  const [unpaid, overdue, processing, credit, hold, unreconciled] = await Promise.all([
    listAllInvoices(InvoiceService, { customerId, status: 'unpaid', archived: 'hide' }),
    InvoiceService.list({ customerId, status: 'overdue', archived: 'hide', limit: 1, offset: 0 }),
    listAllInvoices(InvoiceService, { customerId, status: 'processing', archived: 'hide' }),
    readCredit(customerId),
    readDisputeHold(customerId),
    countUnconfirmedCharges(customerId),
  ]);
  // A sum over a read that hit its bound is a partial figure, not the customer's number: null, with one warning.
  const sum = (rows) => (unpaid.complete ? fromCents(rows.reduce((total, invoice) => total + cents(balanceDue(invoice)), 0)) : null);
  const totalDue = sum(unpaid.rows);
  const notYetSent = unpaid.rows.filter((invoice) => NOT_YET_SENT_STATUSES.includes(invoiceStatusKey(invoice.status)));
  const payerBilled = unpaid.rows.filter(isPayerBilled);
  const presentedSelfPay = unpaid.rows.filter((invoice) => !NOT_YET_SENT_STATUSES.includes(invoiceStatusKey(invoice.status)) && !isPayerBilled(invoice));
  const summary = {
    total_due: totalDue,
    outstanding_count: unpaid.total,
    overdue_count: overdue.total,
    not_yet_sent_due: sum(notYetSent),
    payer_billed_due: sum(payerBilled),
    presented_self_pay_due: sum(presentedSelfPay),
    processing: { count: processing.total, amount: processing.complete ? fromCents(processing.rows.reduce((total, invoice) => total + cents(invoiceAmountDue(invoice)), 0)) : null, note: 'Payments in flight (for example ACH): not received yet, and not counted in total_due.' },
    ...credit,
    dispute_hold: hold,
    unreconciled_stripe_charges: unreconciled ? unreconciled.orphans : null,
    unresolved_charge_attempts: unreconciled ? unreconciled.attempts : null,
    as_of: today,
    basis: 'Admin Invoices page rules for this customer, archived invoices excluded: owes = total minus applied credit on every invoice not paid, prepaid, processing, void, refunded or canceled; overdue = still owed and (status overdue or due date before today, Eastern). total_due includes not_yet_sent_due (drafts and scheduled invoices the customer has not been sent) and payer_billed_due (billed to a third party); the two can overlap, so never subtract them from total_due: presented_self_pay_due is what the customer was actually sent and owes personally.',
    complete: unpaid.complete && processing.complete,
  };
  const unknowns = [];
  if (!unpaid.complete) unknowns.push('More unpaid invoices than the summary reads in one call: total_due, not_yet_sent_due, payer_billed_due and presented_self_pay_due are null (unknown), not zero. Page through get_customer_invoices for the invoices themselves.');
  if (!processing.complete) unknowns.push('More processing invoices than the summary reads in one call: processing.amount is null (unknown); processing.count is exact.');
  if (unreconciled === null) unknowns.push('Unresolved charge evidence could not be read: whether total_due includes money Stripe already charged is unknown.');
  if (unreconciled && unreconciled.orphans > 0) unknowns.push(`${unreconciled.orphans} Stripe charge(s) for this customer's invoices are accepted by Stripe but not recorded in the portal: total_due may include money already charged. Do not collect or retry; check those invoices with get_invoice_detail.`);
  if (unreconciled && unreconciled.attempts > 0) unknowns.push(`${unreconciled.attempts} saved-card charge attempt(s) for this customer's invoices have no confirmed result (claimed, ambiguous, or failed with an ambiguous outcome): Stripe may already have charged them, so total_due may include money already charged. Do not collect or retry; check those invoices with get_invoice_detail.`);
  if (unknowns.length) summary.unknown = unknowns.join(' ');
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

// `heldIds` is null when the per-invoice hold lookup failed (unknown, never false); `unconfirmed` is the
// invoice's unresolved charge evidence { orphans, attempts } (stripe_orphan_charges rows and the fence's
// claimed / ambiguous attempts), or null when that lookup failed.
function invoiceItem(row, today, ledger, heldIds, paymentsTruncated = false, unconfirmed = { orphans: [], attempts: [], statementOrphans: [], reversalOrphans: [] }) {
  const allPayments = ledger.get(String(row.id)) || [];
  const payerFunded = allPayments.filter((payment) => payment.payer_funded);
  const payments = allPayments.filter((payment) => !payment.payer_funded);
  const netPaid = fromCents(payments.reduce((total, payment) => total + cents(netReceived(payment)), 0));
  const recorded = payments.some((payment) => payment.status === 'paid' || payment.status === 'refunded');
  const status = invoiceStatusKey(row.status);
  const unknown = [];
  let amountPaid = netPaid;
  let basis = 'payments table rows linked to this invoice';
  if (!recorded) {
    if (status === 'paid' && payerFunded.length) {
      amountPaid = 0;
      basis = 'settled by a third-party payer: nothing paid by the customer personally';
    } else if (status === 'paid') {
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
  const pendingRefunds = payments.filter(refundIsPending);
  if (pendingRefunds.length) {
    amountPaid = null;
    basis = 'unknown: a refund on a linked payment is still pending';
    unknown.push(`${pendingRefunds.length} refund(s) on this invoice's payment are PENDING (Stripe has not completed them): the net amount paid is unknown; do not call it refunded.`);
  }
  if (paymentsTruncated) {
    amountPaid = null;
    basis = 'unknown: this customer has more payment rows than were read';
    unknown.push('Payment history exceeded the read bound: amount paid and whether a payment was recorded are unknown.');
  }
  if (payments.some((payment) => payment.linked_by === 'payment_intent')) {
    unknown.push('A payment linked only by Stripe PaymentIntent may cover more than this invoice (combined payment): amount_paid is not apportioned.');
  }
  if (payerFunded.length) {
    const names = [...new Set(payerFunded.map((payment) => payment.payer_name).filter(Boolean))];
    unknown.push(`${payerFunded.length} payment record(s) on this invoice were funded by a third-party payer${names.length ? ` (${names.join(', ')})` : ''}: they are not the customer's own payment and are not counted in amount_paid.`);
  }
  // Stripe may have charged the customer without the portal's payments table showing it: an orphan row
  // (charged, insert failed), a claimed / ambiguous saved-card attempt the collection fence still holds, or a
  // failed row flagged ambiguous_outcome. Amount paid, payment_recorded and the balance are then not reliable.
  const orphanRows = unconfirmed ? unconfirmed.orphans : [];
  const attemptRows = unconfirmed ? unconfirmed.attempts : [];
  const ambiguousRows = payments.filter((payment) => failedPaymentOutcomeIsAmbiguous(payment));
  const unresolvedAttempts = attemptRows.length + ambiguousRows.length;
  const unconfirmedUnknown = unconfirmed === null;
  const uncertain = paymentsTruncated || unconfirmedUnknown || orphanRows.length > 0 || unresolvedAttempts > 0;
  const balanceUnreliable = (orphanRows.length > 0 || unresolvedAttempts > 0) && isCollectible(row);
  if (orphanRows.length || unresolvedAttempts) {
    amountPaid = null;
    basis = 'unknown: Stripe may have charged this invoice and the payments table does not show it';
  }
  const sharedRows = orphanRows.filter((orphan) => orphan.linked_by === 'shared_payment_intent');
  const ownRows = orphanRows.filter((orphan) => orphan.linked_by !== 'shared_payment_intent');
  if (ownRows.length) {
    unknown.push(`Stripe accepted ${ownRows.length} charge(s) for this invoice ($${fromCents(ownRows.reduce((total, orphan) => total + cents(orphan.amount), 0)).toFixed(2)}) that the portal has not recorded: amount paid and balance due are not reliable. Do not collect or retry the charge; use get_invoice_detail for the evidence.`);
  }
  if (sharedRows.length) {
    unknown.push(`Stripe accepted a combined payment ($${fromCents(sharedRows.reduce((total, orphan) => total + cents(orphan.amount), 0)).toFixed(2)} across several invoices) that covers this invoice and the portal has not recorded it: this invoice's share may already have been charged, so amount paid and balance due are not reliable. Do not collect or retry the charge; use get_invoice_detail for the evidence.`);
  }
  const reversalOrphanRows = unconfirmed ? unconfirmed.reversalOrphans || [] : [];
  if (reversalOrphanRows.length) {
    amountPaid = null;
    basis = 'unknown: a refund or dispute on the covering payment is not yet allocated to an invoice';
    unknown.push(`${reversalOrphanRows.length} refund or dispute record(s) on the payment that covers this invoice are not yet allocated to an invoice: the net amount paid is unknown (reconciliation required).`);
  }
  const statementOrphanRows = unconfirmed ? unconfirmed.statementOrphans || [] : [];
  if (statementOrphanRows.length) {
    const refunds = statementOrphanRows.filter(isStatementPartialRefund).length;
    const charges = statementOrphanRows.length - refunds;
    if (refunds) unknown.push(`${refunds} unreconciled partial refund(s) recorded against this invoice's payer statement before it settled: reconciliation required, so the payer settlement amounts are unknown. Say it is unknown; use get_invoice_detail.`);
    if (charges) unknown.push(`${charges} payer-statement payment(s) for this invoice's statement were accepted by Stripe but not settled by the portal: whether the statement is paid is unconfirmed (reconciliation required). Say it is unknown; use get_invoice_detail.`);
  }
  if (unresolvedAttempts) {
    unknown.push(`${unresolvedAttempts} saved-card charge attempt(s) for this invoice have no confirmed result (claimed, ambiguous, or failed with an ambiguous outcome): Stripe may already have charged the customer, so amount paid and balance due are not reliable. Do not collect or retry the charge; use get_invoice_detail.`);
  }
  if (unconfirmedUnknown) {
    unknown.push('Unresolved charge evidence could not be read for this invoice: amount paid and balance due may not reflect a charge Stripe accepted. Say it is unknown; use get_invoice_detail.');
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
    balance_due: balanceUnreliable ? null : balanceDue(row),
    overdue: isOverdue(row, today),
    amount_paid: amountPaid,
    amount_paid_basis: basis,
    // null = cannot say (evidence truncated, or Stripe holds an unrecorded charge for it).
    payment_recorded: recorded || !uncertain ? recorded : null,
    unreconciled_stripe_charges: unconfirmedUnknown ? null : orphanRows.length,
    unresolved_charge_attempts: unconfirmedUnknown ? null : unresolvedAttempts,
    statement_reconciliation_required: unconfirmedUnknown ? null : statementOrphanRows.length,
    reversal_reconciliation_required: unconfirmedUnknown ? null : reversalOrphanRows.length,
    payer_funded_payments: payerFunded.length,
    has_active_payment_plan: Boolean(paymentPlanFromList(row)),
    payment_plan: paymentPlanFromList(row),
    dispute_hold: heldIds ? heldIds.has(String(row.id)) : null,
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
  const { linked: ledger, truncated: paymentsTruncated } = await loadLinkedPayments(customer.id, page.invoices);
  let heldIds = new Set();
  const unknowns = ['The live Stripe PaymentIntent state is not stored in the portal and is not read here.'];
  try {
    heldIds = await collectionHoldInvoiceIds(page.invoices.map((invoice) => invoice.id));
  } catch (err) {
    logger.warn(`[intelligence-bar:billing-reader] per-invoice hold lookup failed (${err.code || err.name || 'error'})`);
    heldIds = null;
    unknowns.push('The per-invoice dispute hold could not be read; say it is unknown (the account-level dispute_hold above is the customer-wide state).');
  }
  // Unresolved charge evidence for the page's invoices: orphan rows plus the claimed / ambiguous attempts the
  // collection fence holds (the same predicate stripe.js assertNoInvoiceChargeReconciliationPending reads).
  let unconfirmedMap = new Map();
  try {
    const ids = page.invoices.map((invoice) => invoice.id);
    const loadedOrphans = await loadUnresolvedOrphans(page.invoices);
    const attemptRows = ids.length
      ? await db('stripe_invoice_charge_attempts').whereIn('invoice_id', ids).whereIn('status', ['claimed', 'ambiguous']).whereNull('resolved_at').select('id', 'invoice_id', 'status')
      : [];
    const slot = (id) => { if (!unconfirmedMap.has(String(id))) unconfirmedMap.set(String(id), { orphans: [], attempts: [], statementOrphans: [], reversalOrphans: [] }); return unconfirmedMap.get(String(id)); };
    for (const [invoiceId, found] of loadedOrphans.byInvoice) Object.assign(slot(invoiceId), found);
    for (const attempt of attemptRows) slot(attempt.invoice_id).attempts.push(attempt);
    if (loadedOrphans.truncated) {
      unconfirmedMap = null;
      unknowns.push('More unresolved charge records than were read: whether a charge Stripe accepted is missing from these balances is unknown; say so and use get_invoice_detail.');
    }
  } catch (err) {
    logger.warn(`[intelligence-bar:billing-reader] unconfirmed charge lookup failed (${err.code || err.name || 'error'})`);
    unconfirmedMap = null;
    unknowns.push('Unresolved charge evidence could not be read: whether a charge Stripe accepted is missing from these balances is unknown; say so and use get_invoice_detail.');
  }

  const returned = page.invoices.length;
  const hasMore = offset + returned < page.total;
  return {
    customer: { id: customer.id, name: customerName(customer), phone_last4: phoneLast4(customer.phone) },
    account_summary: summary,
    invoices: page.invoices.map((row) => invoiceItem(row, today, ledger, heldIds, paymentsTruncated, unconfirmedMap ? unconfirmedMap.get(String(row.id)) || { orphans: [], attempts: [], statementOrphans: [], reversalOrphans: [] } : null)),
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

// A charge Stripe accepted that the portal did not record. Only a source that
// states the PaymentIntent SUCCEEDED counts as received; every other source
// (combined_pay_processing is an ACH residual written before the cash arrives;
// invoice_card_on_file is written after a DB failure and can still be a pending
// bank payment) is unconfirmed: an attempt, never received.
const SUCCEEDED_ORPHAN_SOURCES = ['combined_pay_webhook', 'invoice_payment_webhook', 'autopay_charge', 'manual_charge'];
function orphanEntry(row) {
  const confirmed = SUCCEEDED_ORPHAN_SOURCES.includes(row.source);
  return {
    type: 'stripe_unreconciled_charge',
    id: row.id,
    at: iso(row.created_at),
    state: confirmed ? 'succeeded in Stripe, not recorded in the portal ledger'
      : row.source === 'combined_pay_processing' ? 'processing (bank payment pending, funds not settled)'
        : 'accepted by Stripe, not recorded in the portal ledger, settlement unconfirmed',
    state_note: confirmed
      ? 'Stripe charged the customer but the portal failed to record it. Received per Stripe; the ledger needs reconciling. Do not retry the charge.'
      : 'Stripe accepted this payment but the portal did not record it, and the portal has no proof it settled (it can be a bank payment still pending). Not confirmed received: do not call it paid, and do not retry the charge.',
    received: confirmed,
    ...(confirmed ? { received_basis: 'Stripe state succeeded', ledger_recorded: false } : { unconfirmed: true }),
    amount: money(row.amount),
    // A combined PaymentIntent is quarantined against its anchor invoice for the whole allocation.
    ...(row.linked_by === 'shared_payment_intent' ? { shared_with_other_invoices: true, amount_note: 'This combined payment covers several invoices: the amount is the whole PaymentIntent, not this invoice\'s share.' } : {}),
    source: row.source || null,
    // Combined-payment residuals key the PaymentIntent as "<pi>:<invoice id>".
    stripe_payment_intent_id: row.stripe_payment_intent_id ? String(row.stripe_payment_intent_id).split(':')[0] : null,
  };
}

// A partial payer-statement refund recorded before the statement settled: the settlement row cannot know it.
// A refund or dispute on a payment that could not be attributed to one invoice: the payment amounts were left
// unchanged, so the net received on every invoice the payment covers is unknown until it is allocated.
function reversalReconciliationEntry(row) {
  const match = REVERSAL_KEY.exec(String(row.stripe_payment_intent_id || ''));
  const kind = match ? match[1].replace('partial-', '').replace('-', '_') : 'reversal';
  return {
    type: 'payment_reversal_reconciliation',
    id: row.id,
    at: iso(row.created_at),
    kind,
    received: false,
    reconciliation_required: true,
    reversal_amount: money(row.amount),
    state_note: `A ${kind.replace('_', ' ')} on the payment that covers this invoice has not been allocated to an invoice: the recorded payment amounts are unchanged, so the net amount received is unknown. This record is reversal evidence, not a charge.`,
    stripe_payment_intent_id: pgBase(row.stripe_payment_intent_id),
  };
}

// A statement-level orphan is one of two things (recordStatementPaymentIssue writes the second, the partial
// refund branch the first): a partial refund taken before settlement, or a statement payment Stripe accepted
// that the webhook refused to settle (stale intent, unverified funding, surcharge mismatch).
const isStatementPartialRefund = (row) => /^statement S-\d+: partial refund/.test(String(row.original_db_error || ''));
function statementReconciliationEntry(row) {
  const statement = STATEMENT_ORPHAN_MARKER.exec(String(row.original_db_error || ''));
  if (!isStatementPartialRefund(row)) {
    return {
      type: 'payer_statement_reconciliation',
      id: row.id,
      at: iso(row.created_at),
      kind: 'charge_not_settled',
      received: false,
      reconciliation_required: true,
      statement_level: { statement_id: statement ? statement[1] : null, charged_amount: money(row.amount), applies_to: 'the whole payer statement, not this invoice alone' },
      state_note: 'Stripe accepted a payment for the payer statement this invoice is on, but the portal did not settle it (a stale or mismatched payment held for manual review): whether the statement is paid is unconfirmed. Reconciliation required; say it is unknown, and do not retry or refund it from here.',
      stripe_payment_intent_id: pgBase(row.stripe_payment_intent_id),
    };
  }
  return {
    type: 'payer_statement_reconciliation',
    id: row.id,
    at: iso(row.created_at),
    received: false,
    kind: 'partial_refund',
    reconciliation_required: true,
    statement_level: { statement_id: statement ? statement[1] : null, refund_amount: money(row.amount), applies_to: 'the whole payer statement, not this invoice alone' },
    state_note: 'A partial refund was recorded against the payer statement this invoice is on before it settled, and is not yet reconciled: the payer settlement amounts may be overstated. Reconciliation required; say it is unknown.',
    stripe_payment_intent_id: pgBase(row.stripe_payment_intent_id),
  };
}

function groupByAttempt(entries) {
  const parent = new Map();
  const find = (key) => {
    if (!parent.has(key)) parent.set(key, key);
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root);
    parent.set(key, root);
    return root;
  };
  const keysOf = (entry) => [entry.attempt_ref && `ref:${entry.attempt_ref}`, entry.stripe_payment_intent_id && `pi:${entry.stripe_payment_intent_id}`].filter(Boolean);
  for (const entry of entries) {
    const [first, ...rest] = keysOf(entry);
    if (first) for (const key of rest) parent.set(find(key), find(first));
  }
  const groups = new Map();
  for (const entry of entries) {
    const [first] = keysOf(entry);
    const key = first ? find(first) : `${entry.type}:${entry.id}`;
    groups.set(key, [...(groups.get(key) || []), entry]);
  }
  return [...groups.values()];
}

function summarizePayments(entries, invoice, evidenceComplete = true) {
  const recorded = entries.filter((entry) => entry.type === 'recorded_payment' && entry.received);
  // One PaymentIntent is one charge: a succeeded attempt and a confirmed orphan row naming it count once, and
  // not at all when a recorded payment already carries it.
  const recordedIntents = new Set(recorded.map((entry) => entry.stripe_payment_intent_id).filter(Boolean));
  const countedIntents = new Set();
  const stripeConfirmed = entries.filter((entry) => ['stripe_charge_attempt', 'stripe_unreconciled_charge'].includes(entry.type) && entry.received && entry.ledger_recorded !== true)
    .filter((entry) => {
      const intent = entry.stripe_payment_intent_id;
      if (!intent) return true;
      if (recordedIntents.has(intent) || countedIntents.has(intent)) return false;
      countedIntents.add(intent);
      return true;
    });
  // An accepted-but-unrecorded charge whose PaymentIntent Stripe (or the ledger) already confirms as received
  // is that same charge, not a second unknown outcome.
  const receivedIntents = new Set(entries.filter((entry) => entry.received && ['recorded_payment', 'stripe_charge_attempt'].includes(entry.type) && entry.stripe_payment_intent_id).map((entry) => entry.stripe_payment_intent_id));
  const notReceived = entries.filter((entry) => ['payment_attempt', 'stripe_charge_attempt', 'stripe_unreconciled_charge'].includes(entry.type) && !entry.received
    && !(entry.type === 'stripe_unreconciled_charge' && receivedIntents.has(entry.stripe_payment_intent_id)));
  const disputed = entries.filter((entry) => entry.status === 'disputed');
  const statementReconciliation = entries.filter((entry) => entry.type === 'payer_statement_reconciliation');
  const reversalReconciliation = entries.filter((entry) => entry.type === 'payment_reversal_reconciliation');
  const refundPendingEntries = entries.filter((entry) => entry.refund_pending === true);
  // A net over rows that were not all read is not a net: omitted payments or refunds would change it.
  const netUnknown = reversalReconciliation.length > 0 || refundPendingEntries.length > 0 || !evidenceComplete;
  const payerFunded = entries.filter((entry) => entry.type === 'payer_payment');
  const payerNames = [...new Set(payerFunded.map((entry) => entry.funded_by.name).filter(Boolean))];
  // Pending (a bank payment in flight) is not received YET. An unknown outcome (a charge handed to Stripe
  // with no recorded result, an ambiguous one, or an accepted-but-unrecorded one) may already have charged
  // the customer: its receipt is unconfirmed, which is not the same as not received.
  // One charge attempt can leave rows in several tables (a saved-card decline writes a payments row AND an
  // attempt row sharing the idempotency key or PaymentIntent): count each attempt once, by its worst state.
  // Entries that share EITHER identifier are one attempt (a saved-bank charge writes a processing payments
  // row with a PaymentIntent and no key, and a claimed attempt row with a key): merged through their keys.
  const groups = groupByAttempt(notReceived);
  const isPending = (entry) => entry.status === 'processing' || (entry.unconfirmed === true && entry.source === 'combined_pay_processing');
  // A recorded processing payment for the same attempt resolves a claimed attempt's missing result: that one
  // payment is pending (bank transfer in flight), not an unknown outcome.
  const isUnknown = (entry, group) => entry.ambiguous_outcome === true || (entry.state === 'claimed' && !group.some((other) => other.status === 'processing'))
    || entry.state === 'ambiguous' || (entry.unconfirmed === true && entry.source !== 'combined_pay_processing');
  const groupUnknown = (group) => group.some((entry) => isUnknown(entry, group));
  const unknownOutcome = groups.filter(groupUnknown);
  const pending = groups.filter((group) => !groupUnknown(group) && group.some(isPending));
  const failed = groups.filter((group) => !groupUnknown(group) && !group.some(isPending)
    && group.some((entry) => entry.status === 'failed' || entry.status === 'canceled' || entry.state === 'failed'));
  const inFlight = [...pending, ...unknownOutcome];
  const unreconciled = entries.filter((entry) => entry.type === 'stripe_unreconciled_charge' && entry.received);
  const creditSettled = entries.filter((entry) => entry.settled_by === 'account_credit');
  const netRecorded = fromCents(recorded.reduce((total, entry) => total + cents(entry.net_received), 0));
  const receivedAny = recorded.length > 0 || stripeConfirmed.length > 0;
  // A PaymentIntent attached to a still-open invoice whose outcome no row records: the pay page stamps one
  // before any payment, but Stripe may also have succeeded while its confirmation is still being persisted.
  const intentId = invoice.stripe_payment_intent_id;
  const intentUnobserved = Boolean(intentId) && !receivedAny && !INVOICE_UNCOLLECTIBLE_STATUSES.filter((state) => state !== 'processing').includes(invoiceStatusKey(invoice.status))
    && !entries.some((entry) => entry.stripe_payment_intent_id === intentId);

  const parts = [];
  const refundedTotal = fromCents(recorded.reduce((total, entry) => total + cents(entry.refunded_amount), 0));
  if (recorded.length) parts.push(`${recorded.length} payment(s) recorded as received in the payments table, ${netUnknown ? `net amount UNKNOWN (${!evidenceComplete ? 'more records exist than were read' : refundPendingEntries.length ? 'a refund is still pending' : 'an unallocated refund or dispute exists'})` : `net $${netRecorded.toFixed(2)}`}${!netUnknown && refundedTotal > 0 ? ` after $${refundedTotal.toFixed(2)} refunded` : ''}`);
  if (reversalReconciliation.length) parts.push(`${reversalReconciliation.length} refund or dispute record(s) on the covering payment not yet allocated to an invoice (reconciliation required)`);
  if (stripeConfirmed.length) parts.push(`${stripeConfirmed.length} Stripe charge(s) that succeeded and are not confirmed in the payments table (needs reconciling)`);
  if (pending.length) parts.push(`${pending.length} payment(s) still processing (not received yet)`);
  if (unknownOutcome.length) parts.push(`${unknownOutcome.length} charge attempt(s) with an unknown outcome (Stripe may have charged the customer: receipt NOT confirmed)`);
  if (intentUnobserved) parts.push('a Stripe PaymentIntent is attached to this invoice but its outcome is not recorded and its live state is not read here (it may have succeeded)');
  if (failed.length) parts.push(`${failed.length} failed or canceled attempt(s) (NOT received)`);
  if (disputed.length) parts.push(`${disputed.length} disputed payment(s) (not counted as received)`);
  if (payerFunded.length) parts.push(`${payerFunded.length} payment record(s) funded by a third-party payer${payerNames.length ? ` (${payerNames.join(', ')})` : ''}, not the customer's own payment`);
  const statementRefunds = statementReconciliation.filter((entry) => entry.kind === 'partial_refund');
  const statementCharges = statementReconciliation.filter((entry) => entry.kind === 'charge_not_settled');
  if (statementRefunds.length) parts.push(`${statementRefunds.length} unreconciled partial refund(s) recorded against the payer statement before it settled (reconciliation required: the payer settlement may be overstated)`);
  if (statementCharges.length) parts.push(`${statementCharges.length} payer-statement payment(s) accepted by Stripe but not settled by the portal (reconciliation required: whether the statement is paid is unconfirmed)`);
  for (const entry of payerFunded.filter((item) => item.statement_level)) {
    parts.push(`payer statement S-${entry.statement_level.statement_id} (${entry.status}) covers this invoice: its $${Number(entry.statement_level.statement_amount).toFixed(2)} is the whole statement's amount, not this invoice's share`);
  }
  if (creditSettled.length) parts.push('settled by account credit with no card charge (a credit settlement is not a payment received)');
  let statement;
  if (receivedAny) statement = `Payment was received: ${parts.join('; ')}.${evidenceComplete ? '' : ' More records exist than were read.'}`;
  else if (invoiceStatusKey(invoice.status) === 'prepaid') statement = 'Settled as prepaid (account credit or an annual prepay): no payment row; nothing is owed.';
  else if (!evidenceComplete) statement = `Payment evidence is incomplete: the portal holds more records than were read${parts.length ? ` (found: ${parts.join('; ')})` : ''}. Do not say whether it was received or attempted.`;
  else if (creditSettled.length) statement = `Settled by account credit, not by a payment: ${parts.join('; ')}.`;
  else if (payerFunded.length && !unknownOutcome.length && !intentUnobserved) statement = `No payment has been received from the customer: ${parts.join('; ')}. Do not say the customer paid.`;
  else if (unknownOutcome.length || intentUnobserved) statement = `Payment receipt is not confirmed: ${parts.join('; ')}. Stripe may have charged the customer, so do not say it was not paid, and do not retry the charge.`;
  else if (invoiceStatusKey(invoice.status) === 'paid') statement = `The invoice is marked paid but no received payment is linked to it in the portal's records${parts.length ? `; ${parts.join('; ')}` : ''}. Say the payment evidence is unknown.`;
  else statement = `No payment has been received${parts.length ? `: ${parts.join('; ')}` : ' and none has been attempted that the portal recorded'}.`;

  // Any model-facing boolean is null when evidence is incomplete, unless a retained row positively proves it:
  // the rows left unread could hold the opposite answer.
  const provenOrUnknown = (value) => (value || evidenceComplete ? value : null);
  return {
    received: provenOrUnknown(receivedAny),
    recorded_payments_net: netUnknown ? null : netRecorded,
    refunds_pending: refundPendingEntries.length,
    reversal_reconciliation_required: reversalReconciliation.length,
    stripe_succeeded_not_in_ledger: stripeConfirmed.length,
    unreconciled_stripe_charges: unreconciled.length,
    attempts_in_flight_or_unknown: inFlight.length,
    payments_pending: pending.length,
    attempts_unknown_outcome: unknownOutcome.length,
    attached_intent_outcome_unknown: provenOrUnknown(intentUnobserved),
    attempts_failed_or_canceled: failed.length,
    disputed_payments: disputed.length,
    payer_funded_payments: payerFunded.length,
    statement_reconciliation_required: statementReconciliation.length,
    settled_by_account_credit: creditSettled.length,
    evidence_complete: evidenceComplete,
    ...(evidenceComplete ? {} : { counts_note: 'Every count here covers only the rows that were read; older rows were not read, so a zero is not proof of none.' }),
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
  const loadedPayments = await loadLinkedPayments(customer.id, [invoice]);
  const linked = loadedPayments.linked.get(String(invoice.id)) || [];
  const { rows: attempts, truncated: attemptsTruncated } = await newestRows(db('stripe_invoice_charge_attempts').where({ invoice_id: invoice.id })
    .select('id', 'status', 'amount', 'credit_applied_delta', 'stripe_payment_intent_id', 'idempotency_key', 'error_message', 'decline_code', 'submitted_at', 'resolved_at', 'created_at'));
  const loadedOrphans = await loadUnresolvedOrphans([invoice]);
  const { orphans, statementOrphans, reversalOrphans } = loadedOrphans.byInvoice.get(String(invoice.id));
  const orphansTruncated = loadedOrphans.truncated;
  const { rows: credits, truncated: creditsTruncated } = await newestRows(db('customer_credit_ledger').where({ invoice_id: invoice.id })
    .select('id', 'delta', 'balance_after', 'source', 'note', 'created_by', 'created_at'));
  const evidenceComplete = !(loadedPayments.truncated || attemptsTruncated || orphansTruncated || creditsTruncated);
  const plans = await db('payment_plans').where({ invoice_id: invoice.id }).orderBy('created_at', 'desc').limit(5)
    .select('id', 'status', 'payment_amount', 'payment_frequency', 'plan_start_date', 'next_payment_date', 'total_balance', 'created_at', 'completed_at', 'cancelled_at');
  const hold = await readDisputeHold(customer.id);

  let prepayTerm = null;
  const termId = invoice.annual_prepay_term_id || invoice.annual_prepay_covered_term_id;
  if (termId) {
    prepayTerm = await db('annual_prepay_terms').where({ id: termId }).first('id', 'status', 'term_start', 'term_end', 'prepay_amount');
  }

  // Every recorded ledger state for a PaymentIntent (paid, refunded, disputed), so a historical
  // succeeded attempt matches its payment whatever became of it; a dispute outranks the rest.
  const ledgerStates = new Map();
  for (const row of linked.filter((r) => !r.payer_funded && ['paid', 'refunded', 'disputed'].includes(r.status) && r.stripe_payment_intent_id)) {
    if (ledgerStates.get(row.stripe_payment_intent_id) !== 'disputed') ledgerStates.set(row.stripe_payment_intent_id, row.status);
  }
  const entries = [
    ...linked.map((row) => paymentEntry(row, invoice)),
    ...attempts.map((row) => attemptEntry(row, ledgerStates, !loadedPayments.truncated)),
    ...orphans.map(orphanEntry),
    ...statementOrphans.map(statementReconciliationEntry),
    ...reversalOrphans.map(reversalReconciliationEntry),
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
  if (!evidenceComplete) {
    unknowns.push('A timeline source has more rows than were read (the newest are shown, older ones are omitted): do not say a payment was not received or not attempted.');
  }
  if (hold.unknown) unknowns.push(hold.unknown);
  // Stripe accepted a charge the portal never recorded: the portal's balance is stale, not money owed.
  // The same uncertainty predicate the list uses: an orphan row, a claimed / ambiguous attempt the collection
  // fence still holds, or a failed row flagged ambiguous_outcome.
  const unresolvedAttempts = attempts.filter((row) => ['claimed', 'ambiguous'].includes(row.status) && !row.resolved_at).length
    + linked.filter((row) => !row.payer_funded && failedPaymentOutcomeIsAmbiguous(row)).length;
  const unreconciledOwed = (orphans.length > 0 || unresolvedAttempts > 0) && isCollectible(invoice);
  if (unreconciledOwed) {
    unknowns.push('Stripe may already have charged this invoice (an unrecorded Stripe charge, or a charge attempt with no confirmed result): portal_recorded_balance_due is the portal\'s recorded balance, not confirmed money owed. Do not collect or retry the charge; the ledger needs reconciling.');
  }

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
      balance_due: unreconciledOwed ? null : balanceDue(invoice),
      ...(unreconciledOwed ? { portal_recorded_balance_due: balanceDue(invoice) } : {}),
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
    payment_summary: summarizePayments(entries, invoice, evidenceComplete),
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
