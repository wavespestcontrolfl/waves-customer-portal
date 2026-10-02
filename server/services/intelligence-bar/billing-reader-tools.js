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
 * the fence's reason and a pointer to the Invoices page. An invoice with a PaymentIntent attached is held the same way
 * (the pay paths retrieve it from Stripe; this reader never calls Stripe). Nothing here infers a Stripe state, links orphan rows to
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
const { etDateString, etCalendarDayOf } = require('../../utils/datetime-et');
const { invoiceAmountDue, assertInvoiceCollectible, invoiceWithdrawnFromCustomer } = require('../invoice-helpers');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const SUMMARY_PAGE = 100;
const SUMMARY_MAX_PAGES = 10;
// The fence runs per invoice (a few indexed reads each): bounded, in small batches.
const FENCE_SUMMARY_CAP = 100;
const PAYMENT_ROW_CAP = 50;
const PLAN_HISTORY_CAP = 5;
// metadata keys that name the invoice a payment settles (the admin-invoices applied-money fence's keys).
const INVOICE_LINK_KEYS = ['invoice_id', 'dispute_invoice_id', 'waves_invoice_id'];
const NOT_YET_SENT_STATUSES = ['draft', 'scheduled', 'sending'];

const LIST_STATUS_FILTERS = ['all', 'unpaid', 'overdue', 'paid', 'prepaid', 'processing', 'draft', 'sent', 'viewed', 'void', 'refunded'];

const BALANCE_RULE = 'Read only. A balance is stated ONLY when the invoice passes the payment paths\' own collectibility checks (collectible: true). Otherwise balance_due is null with the reason (and amount_due_after_credit and a payment plan\'s amounts are null too): say so and send staff to the Invoices page; never guess, never say it was or was not paid, and never suggest collecting or retrying a charge. recorded_payments are informational rows, not a verdict on receipt.';

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
Takes the invoice_id from get_customer_invoices; there is no invoice-number lookup.
Use for: "what is on this invoice?" (after listing the customer's invoices), "why does this invoice still show a balance?", "what payments are recorded on it?"`,
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

// Anything shaped like local@domain: an internationalized local part (any non-space, non-@ characters) and a domain
// that has a dot or is a bracketed address literal ([192.0.2.1], [IPv6:...]). A bare "@handle" or "call @ 5pm" has
// neither, so it is left alone.
const EMAIL_RE = /[^\s@]+@(?:\[[^\]\s]+\]|[^\s@]+\.[^\s@]+)/gu;
// Digit groups joined by non-alphanumeric separators of ANY length (spaces, tabs, newlines and indentation, dashes,
// dots, slashes, underscores, any mix, or none): 13 or more digits in all. Only a letter or digit ends a run.
const DIGIT_RUN_RE = /\d(?:[^A-Za-z0-9]*\d){12,}/g;
const ISO_DATE_RUN_RE = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/;
const UUID_IN_TEXT_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
function luhnValid(digits) {
  let sum = 0;
  for (let at = 0; at < digits.length; at += 1) {
    let digit = Number(digits[digits.length - 1 - at]);
    if (at % 2 === 1) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  return sum % 10 === 0;
}
// A card number never leaves: a 13+ digit run is masked when it passes the Luhn check, and (conservatively) when it
// does not either, unless it is an ISO date or timestamp.
function maskCardNumbers(text) {
  return text.replace(DIGIT_RUN_RE, (run) => {
    const digits = run.replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) return '[number]';
    if (ISO_DATE_RUN_RE.test(run)) return run;
    return '[number]';
  });
}
// Emails and card numbers are masked; record ids (UUIDs) pass through untouched, so a digit-heavy id still works in
// the follow-up read, and the text around them is masked.
// Complete emails are masked FIRST (an address may have a UUID local part), then standalone UUIDs are exempted.
const maskSensitive = (text) => String(text).replace(EMAIL_RE, '[email]').split(UUID_IN_TEXT_RE)
  .map((part, at) => (at % 2 ? part : maskCardNumbers(part)))
  .join('');
// Free text (a decline message, a manual-payment note, a ledger note) can echo
// an email or a card number: both are masked before anything leaves.
function scrub(value, max = 240) {
  if (value === null || value === undefined) return null;
  const text = maskSensitive(value).trim();
  return text ? text.slice(0, max) : null;
}

// THE egress scrubber: every string that leaves either tool (any free-text column, a reason built from row data, a
// payer or customer name) passes through it once, at the single exit (executeBillingReaderTool), so a field added
// later cannot bypass it. The per-field scrub() above also trims and truncates; this one only masks.
function scrubEgress(value) {
  if (typeof value === 'string') return maskSensitive(value);
  if (Array.isArray(value)) return value.map(scrubEgress);
  if (value && typeof value === 'object' && !(value instanceof Date)) return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, scrubEgress(inner)]));
  return value;
}

function iso(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  return String(value);
}

// DATE columns come back as local-midnight Date objects (or strings).
function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date && Number.isNaN(value.getTime())) return null;
  // The canonical reader of a DATE column (datetime-et.js): a 'YYYY-MM-DD' string or a Date a pg DATE came back as is
  // read as its calendar day, never shifted by the process time zone.
  try { return etCalendarDayOf(value); } catch { return null; }
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


// One read-only REPEATABLE READ snapshot per tool call: every query of the call (the invoice list, both summary
// buckets, the fences, recorded payments, credit, plans) runs on this connection, so status buckets, re-read rows and
// payment linkage cannot disagree. None of the functions called takes a lock or starts its own top-level
// transaction in read-only mode (the read-only charge fence releases and promotes nothing).
const inSnapshot = (work) => db.transaction(work, { isolationLevel: 'repeatable read', readOnly: true });

// A best-effort read inside the snapshot runs in its own SAVEPOINT (a nested transaction): when its SQL fails, only
// the savepoint rolls back and the shared REPEATABLE READ transaction stays usable. Catching the error alone would
// leave PostgreSQL's transaction aborted and fail every later read. The work must THROW to roll back.
const optionalRead = (database, work) => database.transaction(work);

// ─── the payment fences ─────────────────────────────────────────────

const RECONCILE_POINTER = 'needs reconciliation — check the Invoices page';
const VISIT_DID_NOT_HAPPEN_REASON = 'the visit for this invoice did not happen (cancelled/skipped) — check the Invoices page';
const CUSTOMER_CHANGED_REASON = 'this customer record changed during the read; ask again';
const RECORD_CHANGED_REASON = 'this record changed hands during the read; ask again';
const CARD_INCOMPLETE_REASON = 'a card payment did not complete — check the Invoices page';
const ATTACHED_INTENT_REASON = 'a payment was started on this invoice and its outcome is not confirmed here — check the Invoices page';
const CHARGE_FENCE_REASONS = {
  STRIPE_AMBIGUOUS_OUTCOME: 'a saved-card charge has an unconfirmed outcome (Stripe may have charged it)',
  STRIPE_CHARGE_IN_PROGRESS: 'a saved-card charge is in progress or awaiting reconciliation',
  STRIPE_CHARGED_DB_FAILED: 'Stripe charged this invoice and the portal has not recorded it',
};
const MEMBER_REASONS = {
  nothing_due: 'nothing is due on this invoice after applied credit',
  payer_billed: 'this invoice is billed to a third-party payer, not collectible from the customer',
  withdrawn: 'this invoice\'s Bill-To moved to a third-party payer, not collectible from the customer',
  customer_changed: 'this invoice changed owner while it was being read',
  not_collectible: 'this invoice is not collectible',
};
// A PaymentIntent id in a message is not needed to answer; keep it out.
const fenceReason = (message) => scrub(String(message || '').replace(/\bpi_[A-Za-z0-9_]+/g, '[payment]'), 200);

const held = (state, reason) => ({ collectible: false, needs_reconciliation: state === 'needs_reconciliation', state, reason, balance_due: null });
const needsReconciliation = (reason) => held('needs_reconciliation', `${reason} — ${RECONCILE_POINTER}`);

// The tender that proves a bank (ACH) debit: only `us_bank_account` (the value the canonical classifier,
// recurring-card-on-file.js classifySavedMethodChargeInvoice, reads from invoice.payment_method). A processing
// card intent, or a tender nobody recorded, is never a bank payment.
const BANK_TENDER = 'us_bank_account';
const isBankTender = (tender) => String(tender || '') === BANK_TENDER;

// Every PaymentIntent tied to the invoice (its own and each unresolved attempt's) and the processing payments rows
// that record them, with each row's and attempt's tender. `unpaired` is true when an unresolved attempt has no
// PaymentIntent (a charge that never produced one is never an ACH in flight).
async function intentEvidence(invoice, database) {
  const intents = new Set(invoice.stripe_payment_intent_id ? [String(invoice.stripe_payment_intent_id)] : []);
  const attempts = await database('stripe_invoice_charge_attempts')
    .leftJoin('payment_methods as pm', function methodOfAttempt() { this.on('pm.id', 'stripe_invoice_charge_attempts.payment_method_id').orOn('pm.stripe_payment_method_id', 'stripe_invoice_charge_attempts.stripe_payment_method_id'); })
    .where({ 'stripe_invoice_charge_attempts.invoice_id': invoice.id }).whereIn('stripe_invoice_charge_attempts.status', ['claimed', 'ambiguous']).whereNull('stripe_invoice_charge_attempts.resolved_at')
    .select('stripe_invoice_charge_attempts.stripe_payment_intent_id', 'pm.method_type as tender');
  let unpaired = false;
  for (const attempt of attempts) {
    if (attempt.stripe_payment_intent_id) intents.add(String(attempt.stripe_payment_intent_id));
    else unpaired = true;
  }
  const rows = intents.size
    ? await database('payments').leftJoin('payment_methods as pm', 'pm.id', 'payments.payment_method_id')
      .where({ 'payments.customer_id': invoice.customer_id, 'payments.status': 'processing' }).whereIn('payments.stripe_payment_intent_id', [...intents])
      .select('payments.stripe_payment_intent_id', 'payments.payment_method_type', 'payments.metadata', 'pm.method_type as live_method_type')
    : [];
  return { intents, attempts, rows, unpaired };
}

// Conflicting evidence is never bank: any source that names a NON-bank tender (a card payment row, a card attempt, a
// card invoice method) keeps the reconciliation hold, whatever another source says.
function tenderConflict(invoice, { attempts, rows }) {
  const rowTender = (row) => row.live_method_type || row.payment_method_type || (parseJson(row.metadata) || {}).payment_method;
  const nonBank = (tender) => Boolean(tender) && !isBankTender(tender);
  return nonBank(invoice.payment_method) || rows.some((row) => nonBank(rowTender(row))) || attempts.some((attempt) => nonBank(attempt.tender));
}

// Bank-tender evidence from any durable source the pay paths record: the invoice's payment_method, a processing
// payments row's method (the live payment_methods join, then its snapshot, then metadata.payment_method), or the
// unresolved attempt's own tender.
function hasBankTender(invoice, { attempts, rows }) {
  if (tenderConflict(invoice, { attempts, rows })) return false;
  if (isBankTender(invoice.payment_method)) return true;
  const rowTender = (row) => row.live_method_type || row.payment_method_type || (parseJson(row.metadata) || {}).payment_method;
  if (rows.length && rows.every((row) => isBankTender(rowTender(row)))) return true;
  return attempts.length > 0 && attempts.every((attempt) => isBankTender(attempt.tender));
}

// Durable evidence of an ordinary bank (ACH) debit in flight: an unresolved attempt is normal while the
// PaymentIntent is processing (stripe.js savedCardAttemptOutcome keeps it open), recorded beforehand as a
// `processing` payments row. Every PaymentIntent must be so recorded, the tender must be a bank account, and no
// other hold may sit behind the attempt.
async function bankPaymentProcessing(invoice, database) {
  const evidence = await intentEvidence(invoice, database);
  if (evidence.unpaired || !evidence.intents.size) return false;
  const covered = new Set(evidence.rows.map((row) => String(row.stripe_payment_intent_id)));
  if (![...evidence.intents].every((intent) => covered.has(intent))) return false;
  if (!hasBankTender(invoice, evidence)) return false;
  // The evidence accounts only for the attempt: the charge fence stops at the first hold it finds, so the two
  // holds behind it (an unresolved orphan charge, a failed row flagged ambiguous: the fence's own later queries)
  // must be absent too before the invoice reads as an ordinary bank payment.
  if (await database('stripe_orphan_charges').where({ invoice_id: invoice.id, resolved: false }).first('id')) return false;
  const ambiguousFailed = await database('payments').where({ status: 'failed' }).whereNull('stripe_payment_intent_id')
    .whereRaw("metadata->>'invoice_id' = ?", [String(invoice.id)])
    .whereRaw("COALESCE((metadata->>'ambiguous_outcome')::boolean, false) = true")
    .where(function unresolvedAmbiguousAttempt() { this.whereNull('superseded_by_payment_id').orWhereColumn('superseded_by_payment_id', 'payments.id'); })
    .first('id');
  return !ambiguousFailed;
}

// The bank-processing explanation for a held attempt or attached intent, or the reconciliation hold.
async function heldAttemptOutcome(invoice, database, reason, { complete = false, allowBank = true } = {}) {
  if (allowBank && await bankPaymentProcessing(invoice, database)) return held('bank_payment_processing', 'a bank payment is processing on this invoice (an ACH debit in flight), not collectible until it settles');
  return complete ? held('needs_reconciliation', reason) : needsReconciliation(reason);
}

// A `processing` invoice: ask the charge fence before accepting the terminal "bank payment processing" reason.
async function processingStatusOutcome(invoice, database, terminalError) {
  try {
    await require('../stripe').assertNoInvoiceChargeReconciliationPending(invoice.id, database, { readOnly: true });
  } catch (fenceErr) {
    if (!CHARGE_FENCE_REASONS[fenceErr.code]) throw fenceErr;
    return await heldAttemptOutcome(invoice, database, CHARGE_FENCE_REASONS[fenceErr.code], { allowBank: fenceErr.code !== 'STRIPE_CHARGED_DB_FAILED' });
  }
  // The charge fence is clear. `processing` is a bank debit only with bank-tender evidence: the canonical
  // classifier (recurring-card-on-file.js) reads a non-bank processing invoice as an unfinished CARD intent
  // (chargeInvoiceWithSavedCard maps every non-succeeded intent to processing).
  const classified = require('../recurring-card-on-file').classifySavedMethodChargeInvoice(invoice);
  const evidence = await intentEvidence(invoice, database);
  if (!tenderConflict(invoice, evidence) && (classified === 'bank_processing' || hasBankTender(invoice, evidence))) return held('bank_payment_processing', fenceReason(terminalError.message));
  return held('needs_reconciliation', CARD_INCOMPLETE_REASON);
}

/**
 * invoiceCollectibility(row, database): may this invoice be collected from its customer right now? It applies,
 * read-only (no writes, no locks), the set of checks the real collection entry points run before they charge:
 *
 *   routes/pay-v2.js (/setup, /confirm, the rail routes)   rejectIfInvoiceCollectionPending = deposit settlement
 *                                                          ready (lock:false) + the saved-card charge fence;
 *                                                          assertInvoiceCollectible; Bill-To withdrawal
 *   services/stripe.js chargeInvoiceWithSavedCard          charge fence, deposit settlement, assertInvoiceCollectible
 *   services/stripe.js createInvoicePaymentIntent          the same, plus an attached PaymentIntent retrieved
 *                                                          from Stripe and refused unless unconfirmed or canceled
 *   services/invoice-manual-payment.js, admin-invoices.js  assertInvoiceCollectible + the charge fence
 *   routes/stripe-terminal.js                              the charge fence + deposit settlement
 *   services/pay-combined.js memberCollectionPending       THE read-only form of all of the above (status, amount
 *                                                          due, payer billed incl. a live payer lookup, withdrawn,
 *                                                          deposit settlement, charge fence readOnly): called here,
 *                                                          not copied, so the reader cannot drift from it
 *
 * On top of that shared predicate: a processing invoice runs the charge fence before the terminal "bank payment
 * processing" explanation is accepted, a held attempt or attached PaymentIntent with durable ACH-in-flight evidence
 * reads as a bank payment processing (not a reconciliation defect), and any other attached PaymentIntent holds
 * the balance (the pay paths retrieve it from Stripe; this reader never calls Stripe).
 * Deliberately not folded in: the off-session-only guards (the customer-level dispute hold, a stopped-dunning
 * flag), which the list reports as dispute_hold, and visitRefusesSettlement, a lock-taking settlement-write guard.
 * Anything unexpected, or a check that cannot run, holds the balance.
 */
// The visit the invoice links to (canonical linkedScheduledServiceId, including a service-record-only link) and the
// two verdicts that hang off it: the never-ran status (invoice-helpers neverRanVisitStatus, the predicate
// visitRefusesSettlement applies under its lock, here on a plain read) and the LIVE payer lookup with that visit id.
// memberCollectionPending's own payer lookup keys only on invoices.scheduled_service_id and re-reads the invoice row,
// so a service-record-only invoice whose visit later got a payer needs this resolution.
async function linkedVisitVerdict(invoice, database) {
  const visitId = await require('../invoice').linkedScheduledServiceId(invoice, database);
  if (!visitId) return null;
  const visit = await database('scheduled_services').where({ id: visitId }).first('status');
  const neverRan = require('../invoice-helpers').neverRanVisitStatus(visit && visit.status);
  if (neverRan) return { neverRan };
  if (invoice.scheduled_service_id) return null;
  const payer = await require('../payer').resolveForInvoice({ database, customerId: String(invoice.customer_id), scheduledServiceId: String(visitId), throwOnError: true });
  return payer && payer.payerId ? { payerBilled: true } : null;
}

async function decideCollectibility(invoice, listed, database) {
  const status = invoiceStatusKey(invoice.status);
  try {
    assertInvoiceCollectible(invoice);
  } catch (err) {
    // A saved-card ambiguity parks the invoice as `processing` (parkInvoiceForSavedCardReconciliation) and
    // leaves the attempt: ask the charge fence before accepting the terminal explanation.
    if (status === 'processing') return processingStatusOutcome(invoice, database, err);
    return held('not_collectible', fenceReason(err.message) || MEMBER_REASONS.not_collectible);
  }
  const member = await require('../pay-combined').memberCollectionPending(invoice, { database, customerId: listed.customer_id });
  if (member.reason === 'deposit_settlement') return needsReconciliation('an estimate deposit has been received and is not yet applied to this invoice');
  if (member.reason === 'charge_reconciliation') return heldAttemptOutcome(invoice, database, CHARGE_FENCE_REASONS[member.code] || CHARGE_FENCE_REASONS.STRIPE_CHARGE_IN_PROGRESS, { allowBank: member.code !== 'STRIPE_CHARGED_DB_FAILED' });
  if (member.reason === 'customer_changed') return held('unavailable', RECORD_CHANGED_REASON);
  // The live fence's payer verdict (including a payer resolved just now from the customer or the visit) is carried out
  // so payer_billed and the reason can never disagree.
  if (member.reason) return { ...held('not_collectible', MEMBER_REASONS[member.reason] || MEMBER_REASONS.not_collectible), payer_billed: ['payer_billed', 'withdrawn'].includes(member.reason) };
  // The collection fence re-read the invoice: the attached-intent hold and the amount use THAT row, never the
  // older one the caller passed (an intent attached or credit applied between the two reads).
  const fresh = member.row;
  // A visit that never ran refuses settlement (visitRefusesSettlement): the same pure status check, read-only, through
  // the canonical invoice-to-visit linkage (including a service-record-only link).
  const linked = await linkedVisitVerdict(fresh, database);
  if (linked && linked.neverRan) return { ...held('needs_reconciliation', VISIT_DID_NOT_HAPPEN_REASON), row: fresh };
  if (linked && linked.payerBilled) return { ...held('not_collectible', MEMBER_REASONS.payer_billed), payer_billed: true, row: fresh };
  if (fresh.stripe_payment_intent_id) return { ...(await heldAttemptOutcome(fresh, database, ATTACHED_INTENT_REASON, { complete: true })), row: fresh };
  return { collectible: true, needs_reconciliation: false, state: 'collectible', reason: null, balance_due: invoiceAmountDue(fresh), row: fresh };
}

// The caller's row may be older than the checks: the invoice is re-read once here, every check runs on that row,
// and EVERY verdict (held ones included) carries it back so the projected facts and the reason come from one state.
async function invoiceCollectibility(listed, database) {
  // The whole verdict runs in ONE savepoint: any SQL failure rolls back only that, leaves the shared snapshot usable,
  // and holds the balance. Nothing inside swallows a database error.
  try {
    return await optionalRead(database, async (savepoint) => {
      const current = (await savepoint('invoices').where({ id: listed.id }).first()) || listed;
      // Ownership changed during the read: the invoice is refused for this customer, never projected under their header.
      if (String(current.customer_id) !== String(listed.customer_id)) return held('unavailable', RECORD_CHANGED_REASON);
      const verdict = await decideCollectibility(current, listed, savepoint);
      return { ...verdict, row: verdict.row || current };
    });
  } catch (err) {
    logger.warn(`[intelligence-bar:billing-reader] collectibility check could not run (${err.code || err.name || 'error'})`);
    return needsReconciliation('the payment-state check could not be completed');
  }
}

// Sequential: every read shares the call's one snapshot connection.
async function fenceAll(invoices, database) {
  const out = new Map();
  for (const invoice of invoices) out.set(String(invoice.id), await invoiceCollectibility(invoice, database));
  return out;
}

// THE one place a due-style amount leaves the reader. Whatever reads as "owed" (the balance, the amount due after
// credit, a payment plan's installment and remaining balance) is stated only for a collectible invoice and is
// null otherwise; total and credit applied are document facts and stay.
// ONE snapshot per invoice: the row the collection fence re-read overrides the listed row field by field (the
// list's joined columns, such as the active payment plan, are kept), and EVERY invoice fact and the due
// projection below come from it, so the document breakdown always agrees with the balance.
function effectiveRow(listedRow, fence) {
  return fence.row ? { ...listedRow, ...fence.row } : listedRow;
}
function projectDue(row, fence, today) {
  return {
    amount_due_after_credit: fence.collectible ? invoiceAmountDue(row) : null,
    collectible: fence.collectible,
    balance_due: fence.collectible ? fence.balance_due : null,
    ...(fence.reason ? { reason: fence.reason } : {}),
    needs_reconciliation: fence.needs_reconciliation,
    bank_payment_processing: fence.state === 'bank_payment_processing',
    // The row's own payer fields, or the fence's live payer verdict: the flag and the reason never disagree.
    payer_billed: isPayerBilled(row) || fence.payer_billed === true,
    overdue: fence.collectible ? isOverdue(row, today) : null,
  };
}
function projectPlan(plan, fence) {
  if (!plan || fence.collectible) return plan;
  return { ...plan, payment_amount: null, total_balance: null, amounts_withheld: 'not stated for an invoice that is not collectible' };
}

// ─── account facts ──────────────────────────────────────────────────

async function readDisputeHold(customerId, database) {
  try {
    const { activeDisputeHolds } = require('../collections/collection-hold');
    const hold = await optionalRead(database, (savepoint) => activeDisputeHolds(savepoint('collections_flags').where({ customer_id: customerId })).first('created_at'));
    return { active: Boolean(hold), since: hold ? iso(hold.created_at) : null };
  } catch (err) {
    logger.warn(`[intelligence-bar:billing-reader] dispute hold lookup failed (${err.code || err.name || 'error'})`);
    return { active: null, since: null, unknown: 'The dispute hold could not be read; say it is unknown.' };
  }
}

async function readCredit(customerId, database) {
  try {
    const CustomerCredit = require('../customer-credit');
    // Read inside the call's one snapshot: a grant, application or reversal commits the balance and the ledger
    // together, so both reads see the same state.
    const { balance, sum } = await optionalRead(database, async (savepoint) => ({
      balance: await CustomerCredit.getBalance(customerId, savepoint),
      sum: await savepoint('customer_credit_ledger').where({ customer_id: customerId }).sum({ total: 'delta' }).first(),
    }));
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
async function listAllInvoices(InvoiceService, params, { stopAbove = Infinity, database } = {}) {
  const rows = [];
  let total = 0;
  for (let page = 0; page < SUMMARY_MAX_PAGES; page += 1) {
    const result = await InvoiceService.list({ ...params, database, stableOrder: true, limit: SUMMARY_PAGE, offset: page * SUMMARY_PAGE });
    total = result.total;
    rows.push(...result.invoices);
    // Provably more rows than the caller can use: stop now (each page costs a joined query plus a count).
    if (total > stopAbove) return { rows, total, complete: false };
    if (rows.length >= total || result.invoices.length < SUMMARY_PAGE) return { rows, total, complete: true };
  }
  return { rows, total, complete: false };
}

function annualPrepayLinkage(row) {
  // The term links the invoice from either side: invoices.annual_prepay_term_id, or annual_prepay_terms.prepay_invoice_id
  // (the list's join, `annual_prepay_id`): some existing prepay invoices carry only the term-side link.
  const prepayTermId = row.annual_prepay_term_id || row.annual_prepay_id;
  if (prepayTermId) {
    return { role: 'prepay_invoice', term_id: prepayTermId, term_status: row.annual_prepay_status || null };
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

async function accountSummary(InvoiceService, customer, today, database) {
  const customerId = customer.id;
  // One snapshot: the unpaid and processing buckets, the fences, credit and hold all read the same state, so an
  // invoice cannot fall out of (or into) both buckets mid-read.
  const unpaid = await listAllInvoices(InvoiceService, { customerId, status: 'unpaid', archived: 'hide' }, { stopAbove: FENCE_SUMMARY_CAP, database });
  const processing = await listAllInvoices(InvoiceService, { customerId, status: 'processing', archived: 'hide' }, { stopAbove: FENCE_SUMMARY_CAP, database });
  const credit = await readCredit(customerId, database);
  const hold = await readDisputeHold(customerId, database);
  const unknowns = [];
  // total_due is the sum of the invoices whose fences passed. It needs every unpaid invoice read AND fenced:
  // a partial read, or more invoices than the fence is run for, makes it unknown rather than a partial number.
  let fenced = null;
  if (!unpaid.complete || unpaid.rows.length > FENCE_SUMMARY_CAP) unknowns.push(`More than ${FENCE_SUMMARY_CAP} unpaid invoices to check for reconciliation: total_due, overdue_count and the splits are null (unknown), not zero. Page through get_customer_invoices.`);
  else fenced = await fenceAll(unpaid.rows, database);
  // Each processing invoice is classified by the same per-invoice result as the list.
  let fencedProcessing = null;
  if (!processing.complete || processing.rows.length > FENCE_SUMMARY_CAP) unknowns.push(`More than ${FENCE_SUMMARY_CAP} processing invoices to check: the processing split and needs_reconciliation_count are null (unknown).`);
  else fencedProcessing = await fenceAll(processing.rows, database);
  const states = fenced && fencedProcessing
    ? [...unpaid.rows.map((invoice) => fenced.get(String(invoice.id)).state), ...processing.rows.map((invoice) => fencedProcessing.get(String(invoice.id)).state)]
    : null;
  const countState = (state) => (states ? states.filter((one) => one === state).length : null);
  const reconcileCount = countState('needs_reconciliation');
  const bankInFlight = countState('bank_payment_processing');
  const unavailableCount = states ? countState('unavailable') : null;
  const otherNotCollectible = fenced ? unpaid.rows.filter((invoice) => fenced.get(String(invoice.id)).state === 'not_collectible').length : null;
  const fresh = (invoice) => fenced.get(String(invoice.id)).row || invoice;
  const rowsWhere = (test) => (fenced ? unpaid.rows.filter((invoice) => fenced.get(String(invoice.id)).collectible && test(fresh(invoice))).map(fresh) : null);
  const sum = (rows) => (rows ? fromCents(rows.reduce((total, invoice) => total + cents(invoiceAmountDue(invoice)), 0)) : null);
  if (reconcileCount > 0) unknowns.push(`${reconcileCount} invoice(s) (unpaid or processing) need reconciliation and are NOT in total_due: check them on the Invoices page; do not collect or retry.`);
  if (otherNotCollectible > 0) unknowns.push(`${otherNotCollectible} unpaid invoice(s) are not collectible from this customer (for example billed to a third party, or nothing due after credit) and are not in total_due.`);
  if (unavailableCount > 0) unknowns.push(`${unavailableCount} invoice(s) changed hands during the read and are left out of every figure here: ask again.`);
  const notYetSent = (invoice) => NOT_YET_SENT_STATUSES.includes(invoiceStatusKey(invoice.status));
  const summary = {
    total_due: sum(rowsWhere(() => true)),
    outstanding_count: unpaid.total,
    needs_reconciliation_count: reconcileCount,
    // Only collectible invoices count as overdue (the list's own `overdue` is null for the rest): never a raw status count.
    overdue_count: fenced ? rowsWhere((invoice) => isOverdue(invoice, today)).length : null,
    not_yet_sent_due: sum(rowsWhere(notYetSent)),
    presented_self_pay_due: sum(rowsWhere((invoice) => !notYetSent(invoice))),
    processing: {
      count: processing.total,
      bank_payment_in_flight: bankInFlight,
      needs_reconciliation: fencedProcessing ? processing.rows.filter((invoice) => fencedProcessing.get(String(invoice.id)).needs_reconciliation).length : null,
      note: 'Processing invoices are not counted in total_due and their amounts are not stated here. bank_payment_in_flight (any invoice, processing or not) are waiting on a bank transfer; needs_reconciliation are not: a charge state is unresolved, so check the Invoices page.',
    },
    ...credit,
    dispute_hold: hold,
    as_of: today,
    basis: 'total_due adds up only the unpaid invoices that pass the payment paths\' collectibility checks (amount due = total minus applied credit; an invoice billed to a third-party payer is not collectible from the customer); invoices that need reconciliation are counted separately and excluded. overdue_count counts only collectible invoices that are overdue. total_due includes not_yet_sent_due (drafts and scheduled invoices the customer has not been sent); presented_self_pay_due is what the customer was actually sent and owes personally.',
  };
  // The credit read's own reason (all three credit fields null) is kept; the invoice warnings are appended to it.
  const warnings = [credit.unknown, ...unknowns].filter(Boolean);
  if (warnings.length) summary.unknown = warnings.join(' ');
  return summary;
}

// `fence` is the invoice's invoiceCollectibility() verdict: the balance is stated only when it is collectible.
function invoiceItem(listedRow, today, fence, heldIds) {
  const row = effectiveRow(listedRow, fence);
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
    ...projectDue(row, fence, today),
    has_active_payment_plan: Boolean(paymentPlanFromList(row)),
    payment_plan: projectPlan(paymentPlanFromList(row), fence),
    dispute_hold: heldIds ? heldIds.has(String(row.id)) : null,
    annual_prepay: annualPrepayLinkage(row),
    archived: Boolean(row.archived_at),
    archived_at: iso(row.archived_at),
  };
}

// ─── get_customer_invoices ──────────────────────────────────────────

async function getCustomerInvoices(input, actionContext) {
  const resolved = await resolveBillingCustomer(input, actionContext);
  if (resolved.error) return resolved;
  // Every read below shares ONE read-only REPEATABLE READ snapshot, and the selected customer is re-validated INSIDE it.
  return inSnapshot(async (database) => {
    const current = await database('customers').where({ id: resolved.customer.id }).first('id', 'first_name', 'last_name', 'phone', 'deleted_at');
    if (!current || current.deleted_at || String(current.id) !== String(resolved.customer.id)) return { error: CUSTOMER_CHANGED_REASON, code: 'record_unavailable' };
    return listForCustomer(current, input, database);
  });
}

// The list's own join follows invoices.annual_prepay_term_id only; some existing prepay invoices carry just the
// term-side link (annual_prepay_terms.prepay_invoice_id). Resolve those in the same snapshot.
async function attachTermSidePrepay(rows, database) {
  const open = rows.filter((row) => !row.annual_prepay_term_id && !row.annual_prepay_covered_term_id && !row.annual_prepay_id);
  if (!open.length || !(await database.schema.hasTable('annual_prepay_terms'))) return;
  const terms = await database('annual_prepay_terms').whereIn('prepay_invoice_id', open.map((row) => row.id)).select('id', 'prepay_invoice_id', 'status');
  const byInvoice = new Map(terms.map((term) => [String(term.prepay_invoice_id), term]));
  for (const row of open) {
    const term = byInvoice.get(String(row.id));
    if (term) { row.annual_prepay_id = term.id; row.annual_prepay_status = term.status; }
  }
}

async function listForCustomer(customer, input, database) {
  const InvoiceService = require('../invoice');
  const { collectionHoldInvoiceIds } = require('../collections/collection-hold');
  const today = etDateString();

  const rawLimit = Number.isFinite(Number(input.limit)) ? Math.trunc(Number(input.limit)) : DEFAULT_LIMIT;
  const limit = Math.min(Math.max(rawLimit, 1), MAX_LIMIT);
  const offset = Math.max(0, Math.trunc(Number(input.offset) || 0));
  const statusFilter = LIST_STATUS_FILTERS.includes(input.status) && input.status !== 'all' ? input.status : undefined;
  const includeArchived = input.include_archived === true;

  const page = await InvoiceService.list({
    customerId: customer.id, status: statusFilter, limit, offset, archived: includeArchived ? 'all' : 'hide', sort: 'newest', database, stableOrder: true,
  });
  await attachTermSidePrepay(page.invoices, database);
  const summary = await accountSummary(InvoiceService, customer, today, database);
  const fences = await fenceAll(page.invoices, database);
  const unknowns = [];
  let heldIds = new Set();
  try {
    heldIds = await optionalRead(database, (savepoint) => collectionHoldInvoiceIds(page.invoices.map((invoice) => invoice.id), { database: savepoint }));
  } catch (err) {
    logger.warn(`[intelligence-bar:billing-reader] per-invoice hold lookup failed (${err.code || err.name || 'error'})`);
    heldIds = null;
    unknowns.push('The per-invoice dispute hold could not be read; say it is unknown (the account-level dispute_hold above is the customer-wide state).');
  }

  // An invoice whose ownership changed during the read is unavailable: never shown, never counted.
  const unavailable = page.invoices.filter((row) => fences.get(String(row.id)).state === 'unavailable');
  if (unavailable.length) unknowns.push(`${unavailable.length} invoice(s) changed hands during the read and are left out: ask again.`);
  const shown = page.invoices.filter((row) => fences.get(String(row.id)).state !== 'unavailable');
  const returned = page.invoices.length;
  const hasMore = offset + returned < page.total;
  return {
    customer: { id: customer.id, name: customerName(customer), phone_last4: phoneLast4(customer.phone) },
    account_summary: summary,
    invoices: shown.map((row) => invoiceItem(row, today, fences.get(String(row.id)), heldIds)),
    ...(unavailable.length ? { unavailable_invoices: unavailable.map((row) => ({ id: row.id, reason: RECORD_CHANGED_REASON })) } : {}),
    returned_count: shown.length,
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
    category: scrub(item.category, 80),
    is_discount: Number(item.amount) < 0,
  }));
}

function paymentPlanDetail(allRows, fence) {
  if (!allRows.length) return null;
  const truncated = allRows.length > PLAN_HISTORY_CAP;
  const rows = allRows.slice(0, PLAN_HISTORY_CAP);
  const mapped = rows.map((plan) => projectPlan({
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
  }, fence));
  return {
    active: mapped.find((plan) => plan.status === 'active') || null,
    history: mapped.filter((plan) => plan.status !== 'active'),
    history_truncated: truncated,
    installments: 'The portal stores the plan schedule (amount, frequency, next date), not per-installment records: whether any installment was collected is unknown here.',
  };
}

// A charge Stripe accepted that the portal did not record. Only a source that
// states the PaymentIntent SUCCEEDED counts as received; every other source
// (combined_pay_processing is an ACH residual written before the cash arrives;

// The payments-table rows tied to this invoice by the portal's own linkage (receipt-payment.js
// loadPaymentForInvoice and the applied-money fence): metadata.invoice_id / dispute_invoice_id /
// waves_invoice_id, the invoice's Stripe PaymentIntent or charge id, and the manual-payment description. A row
// that names a different invoice explicitly is that invoice's (a combined payment writes one row per invoice
// on one PaymentIntent). Informational: no row is classified as received or not received here.
// The tender is read the way the snapshot migration says: the live payment_methods join first, then the payment's
// own snapshot, then metadata.payment_method (Stripe and statement writers), then the processor.
const RECORDED_PAYMENT_COLUMNS = ['payments.id', 'payments.payment_date', 'payments.amount', 'payments.status', 'payments.metadata', 'payments.created_at', 'payments.processor',
  'payments.refund_amount', 'payments.refund_status', 'payments.payer_id', 'payments.payment_method_type', 'payments.card_brand',
  'pm.method_type as live_method_type', 'pm.card_brand as live_card_brand'];

async function loadRecordedPayments(customerId, invoice, database) {
  const rows = await database('payments')
    .leftJoin('payment_methods as pm', 'pm.id', 'payments.payment_method_id')
    .where({ 'payments.customer_id': customerId })
    .where(function linkedToInvoice() {
      for (const key of INVOICE_LINK_KEYS) this.orWhereRaw(`payments.metadata::jsonb ->> '${key}' = ?`, [String(invoice.id)]);
      if (invoice.stripe_payment_intent_id) this.orWhereRaw('payments.stripe_payment_intent_id = ?', [String(invoice.stripe_payment_intent_id)]);
      if (invoice.stripe_charge_id) this.orWhereRaw('payments.stripe_charge_id = ?', [String(invoice.stripe_charge_id)]);
      if (/^[A-Za-z0-9-]+$/.test(String(invoice.invoice_number || ''))) this.orWhereRaw('payments.description LIKE ?', [`Invoice ${invoice.invoice_number} — %`]);
    })
    // A row that names ANOTHER invoice explicitly (a combined payment's sibling share) is excluded in SQL, before the
    // LIMIT, so sibling rows can never crowd this invoice's own payments out of the history.
    .whereRaw(`(${INVOICE_LINK_KEYS.map((key) => `NULLIF(payments.metadata::jsonb ->> '${key}', '') IS NULL`).join(' AND ')} OR ${INVOICE_LINK_KEYS.map((key) => `payments.metadata::jsonb ->> '${key}' = ?`).join(' OR ')})`, INVOICE_LINK_KEYS.map(() => String(invoice.id)))
    .orderBy('payments.created_at', 'desc')
    .limit(PAYMENT_ROW_CAP + 1)
    .select(RECORDED_PAYMENT_COLUMNS);
  // A payer statement settles ONE payments row (customer_id NULL, statement_id) for every invoice on it.
  const statementRows = invoice.payer_statement_id != null
    ? await database('payments').leftJoin('payment_methods as pm', 'pm.id', 'payments.payment_method_id').where({ 'payments.statement_id': invoice.payer_statement_id })
      .orderBy('payments.created_at', 'desc').limit(PAYMENT_ROW_CAP + 1)
      .select([...RECORDED_PAYMENT_COLUMNS, 'payments.statement_id'])
    : [];
  const namesOtherInvoice = (row) => {
    const metadata = parseJson(row.metadata) || {};
    const named = INVOICE_LINK_KEYS.map((key) => metadata[key]).filter(Boolean).map(String);
    return named.length > 0 && !named.includes(String(invoice.id));
  };
  const kept = [...rows.filter((row) => !namesOtherInvoice(row)).slice(0, PAYMENT_ROW_CAP), ...statementRows.slice(0, PAYMENT_ROW_CAP)];
  const payerRef = (row) => (row.payer_id != null ? row.payer_id : (parseJson(row.metadata) || {}).payer_id);
  const payerIds = [...new Set(kept.map(payerRef).filter((id) => Number.isInteger(Number(id)) && Number(id) > 0).map(Number))];
  let names = new Map();
  let namesUnavailable = false;
  if (payerIds.length) {
    try {
      names = new Map((await optionalRead(database, (savepoint) => savepoint('payers').whereIn('id', payerIds).select('id', 'display_name'))).map((payer) => [Number(payer.id), scrub(payer.display_name, 120)]));
    } catch (err) {
      namesUnavailable = true;
      logger.warn(`[intelligence-bar:billing-reader] payer name lookup failed (${err.code || err.name || 'error'})`);
    }
  }
  return {
    truncated: rows.length > PAYMENT_ROW_CAP || statementRows.length > PAYMENT_ROW_CAP,
    namesUnavailable,
    payments: kept.sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).map((row) => {
      const payer = payerRef(row);
      const metadataTender = (parseJson(row.metadata) || {}).payment_method;
      const tender = row.live_method_type || row.payment_method_type || (typeof metadataTender === 'string' ? metadataTender : null);
      return {
        id: row.id,
        date: dateOnly(row.payment_date),
        recorded_at: iso(row.created_at),
        // A statement-level row covers every invoice on the statement: its amount is never this invoice's share.
        amount: row.statement_id != null ? null : money(row.amount),
        ...(row.statement_id != null ? { statement_level: { statement_id: String(row.statement_id), statement_amount: money(row.amount), refunded_amount: money(row.refund_amount) || 0, refund_status: row.refund_status || null, applies_to: 'every invoice on the payer statement, not this invoice alone' } } : {}),
        status: row.status,
        method: [tender || row.processor || invoice.payment_method || 'manual', row.live_card_brand || row.card_brand].filter(Boolean).join(' '),
        // A statement row carries the WHOLE statement's cumulative refund: it is statement-level, never this invoice's.
        refunded_amount: row.statement_id != null ? null : money(row.refund_amount) || 0,
        refund_status: row.statement_id != null ? null : row.refund_status || null,
        ...(payer != null ? { funded_by_payer: { id: Number(payer) || null, name: names.get(Number(payer)) || null } } : {}),
      };
    }),
  };
}

async function getInvoiceDetail(input, actionContext) {
  if (!input.invoice_id || !UUID_RE.test(String(input.invoice_id))) {
    return { error: 'A valid invoice_id is required', code: 'invalid_target' };
  }
  if (input.customer_id && !UUID_RE.test(String(input.customer_id))) {
    return { error: 'A valid customer_id is required', code: 'invalid_target' };
  }
  // Every read below shares ONE read-only REPEATABLE READ snapshot.
  return inSnapshot((database) => detailInSnapshot(input, actionContext, database));
}

const RECORD_UNAVAILABLE = { error: 'That invoice is unavailable for this customer', code: 'record_unavailable' };

// Authorize and load: the invoice and its customer inside the call's snapshot, or the refusal to return.
async function authorizeInvoiceRead(input, actionContext, database) {
  if (!input.invoice_id || !UUID_RE.test(String(input.invoice_id))) return { refusal: { error: 'A valid invoice_id is required', code: 'invalid_target' } };
  if (input.customer_id && !UUID_RE.test(String(input.customer_id))) return { refusal: { error: 'A valid customer_id is required', code: 'invalid_target' } };
  const invoice = await database('invoices').where({ id: String(input.invoice_id).toLowerCase() }).first();
  if (!invoice) return { refusal: RECORD_UNAVAILABLE };
  if (input.customer_id && String(input.customer_id).toLowerCase() !== String(invoice.customer_id)) return { refusal: RECORD_UNAVAILABLE };
  const scope = Array.isArray(actionContext.readCustomerIds) ? actionContext.readCustomerIds : [];
  if (scope.length && !scope.map(String).includes(String(invoice.customer_id))) {
    return { refusal: { error: 'Choose the target for this lookup; the current request has not established it', code: 'target_clarification_required' } };
  }
  const customer = await database('customers').where({ id: invoice.customer_id }).first('id', 'first_name', 'last_name', 'phone', 'deleted_at');
  if (!customer || customer.deleted_at) return { refusal: RECORD_UNAVAILABLE };
  return { invoice, customer };
}

// Annual prepay resolution: the invoice's own term id, or the term-side link (annual_prepay_terms.prepay_invoice_id)
// the Invoices detail reader also resolves through.
async function resolvePrepayTerm(facts, database) {
  const termColumns = ['id', 'status', 'term_start', 'term_end', 'prepay_amount'];
  const ownTermId = facts.annual_prepay_term_id || facts.annual_prepay_covered_term_id;
  if (ownTermId) {
    return { termId: ownTermId, role: facts.annual_prepay_term_id ? 'prepay_invoice' : 'covered_by_prepay_term', term: await database('annual_prepay_terms').where({ id: ownTermId }).first(termColumns) };
  }
  if (!(await database.schema.hasTable('annual_prepay_terms'))) return { termId: null, role: null, term: null };
  const term = await database('annual_prepay_terms').where({ prepay_invoice_id: facts.id }).first(termColumns);
  return term ? { termId: term.id, role: 'prepay_invoice', term } : { termId: null, role: null, term: null };
}

function annualPrepayProjection({ termId, role, term }) {
  if (!termId) return null;
  return {
    role,
    term_id: termId,
    term_status: term ? term.status : null,
    term_start: term ? dateOnly(term.term_start) : null,
    term_end: term ? dateOnly(term.term_end) : null,
    prepay_amount: term ? money(term.prepay_amount) : null,
  };
}

// The warnings the detail carries for every bounded or failed optional read.
function detailWarnings({ hold, plans, recorded }) {
  const unknowns = [];
  if (hold.unknown) unknowns.push(hold.unknown);
  if (plans.length > PLAN_HISTORY_CAP) unknowns.push(`This invoice has more than ${PLAN_HISTORY_CAP} payment plans: only the newest ${PLAN_HISTORY_CAP} are shown, older plans are not (history_truncated).`);
  if (recorded.namesUnavailable) unknowns.push('The payer name could not be read: a third-party payer is shown without its name.');
  if (recorded.truncated) unknowns.push('More payment rows are tied to this invoice than were read: the newest are shown.');
  return unknowns;
}

// The invoice document: facts from the one snapshot row, the due projection from the fence.
function invoiceDocument(facts, fence, today) {
  return {
    id: facts.id,
    invoice_number: facts.invoice_number,
    title: scrub(facts.title, 160),
    status: facts.status,
    service_type: facts.service_type || null,
    service_date: dateOnly(facts.service_date),
    created_at: iso(facts.created_at),
    sent_at: iso(facts.sent_at),
    viewed_at: iso(facts.viewed_at),
    due_date: dateOnly(facts.due_date),
    paid_at: iso(facts.paid_at),
    subtotal: money(facts.subtotal),
    discount_amount: money(facts.discount_amount) || 0,
    discount_label: scrub(facts.discount_label, 120),
    tax_rate: facts.tax_rate === null || facts.tax_rate === undefined ? null : Number(facts.tax_rate),
    tax_amount: money(facts.tax_amount) || 0,
    total: money(facts.total),
    credit_applied: money(facts.credit_applied) || 0,
    ...projectDue(facts, fence, today),
    payment_method: facts.payment_method || null,
    payment_reference: scrub(facts.payment_reference, 120),
    payment_recorded_by: scrub(facts.payment_recorded_by, 80),
    payment_recorded_at: iso(facts.payment_recorded_at),
    archived: Boolean(facts.archived_at),
  };
}

function discountsProjection(facts, lines) {
  return {
    document_discount: { amount: money(facts.discount_amount) || 0, label: scrub(facts.discount_label, 120) },
    discount_lines: lines.filter((line) => line.is_discount),
    account_credit_applied: money(facts.credit_applied) || 0,
  };
}

async function detailInSnapshot(input, actionContext, database) {
  const loaded = await authorizeInvoiceRead(input, actionContext, database);
  if (loaded.refusal) return loaded.refusal;
  const { invoice, customer } = loaded;
  const fence = await invoiceCollectibility(invoice, database);
  if (fence.state === 'unavailable') return { error: `That invoice is unavailable: ${RECORD_CHANGED_REASON}`, code: 'record_unavailable' };
  const facts = effectiveRow(invoice, fence);
  const recorded = await loadRecordedPayments(customer.id, facts, database);
  const plans = await database('payment_plans').where({ invoice_id: invoice.id }).orderBy('created_at', 'desc').limit(PLAN_HISTORY_CAP + 1)
    .select('id', 'status', 'payment_amount', 'payment_frequency', 'plan_start_date', 'next_payment_date', 'total_balance', 'created_at', 'completed_at', 'cancelled_at');
  const hold = await readDisputeHold(customer.id, database);
  const prepay = await resolvePrepayTerm(facts, database);
  const lines = lineItems(facts.line_items);
  return {
    invoice: invoiceDocument(facts, fence, etDateString()),
    customer: { id: customer.id, name: customerName(customer), phone_last4: phoneLast4(customer.phone) },
    line_items: lines,
    discounts: discountsProjection(facts, lines),
    recorded_payments: recorded.payments,
    recorded_payments_note: 'Informational: the payments-table rows tied to this invoice, with no verdict on whether it was paid or what is owed. collectible and balance_due decide that.',
    payment_plan: paymentPlanDetail(plans, fence),
    dispute_hold: hold,
    annual_prepay: annualPrepayProjection(prepay),
    unknowns: detailWarnings({ hold, plans, recorded }),
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
      case 'get_customer_invoices': return scrubEgress(await getCustomerInvoices(input || {}, context));
      case 'get_invoice_detail': return scrubEgress(await getInvoiceDetail(input || {}, context));
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    // Telemetry keeps the failure class only: the message can carry customer data.
    logger.error(`[intelligence-bar:billing-reader] ${toolName} failed (${err.code || err.name || 'error'})`);
    return { error: 'Could not read the billing records' };
  }
}

module.exports = { BILLING_READER_TOOLS, executeBillingReaderTool };
