/**
 * Intelligence Bar — void an invoice that has collected nothing
 * server/services/intelligence-bar/void-invoice-tools.js
 *
 * Owner ruling 2026-10-12 ("yes to all recommendations", Stage 3 purpose-built cards, "void" included):
 * a card that replays a screen's own handler.
 *
 *   void_invoice — the Invoices page "Void" (POST /admin/invoices/:id/void), run through admin-invoices.js
 *                  voidInvoiceFromBar: the same handler, in process, so every refusal and rule is the route's
 *                  own (InvoiceService.voidInvoice). The card is narrower than the screen: money stays on the
 *                  Invoices page (see MONEY CASES).
 *
 * What the handler writes: the invoice becomes void; its payment-reminder sequence is stopped; an active
 * payment plan is cancelled (the card refuses those); account credit applied to it is returned to the
 * customer's balance; a payer statement that is still open drops it from its total; a membership-dues month,
 * an annual-prepay term, a bait-station setup obligation and an estimate deposit are put back (the card
 * refuses those, they stay on the Invoices page). The one Stripe call is cancelling the invoice's own
 * UNCONFIRMED PaymentIntent (no payment was attempted). It sends NO text, email or call. The visit is not
 * changed. Unvoid (Invoices page) restores a draft. The card says so.
 *
 * MONEY CASES (owner rule: refunds and charging a saved card stay closed): the card refuses, with code
 * by_owner_rule, any invoice with money received or in flight: paid, processing, refunded, a payment
 * recorded, a payments row, a Stripe charge, a PaymentIntent that is anything but unconfirmed, a saved-card
 * attempt that is unresolved, a deposit already collected, a finalized payer statement, a payment plan.
 *
 * Always a confirm card (write-gates.js two-step), admin only, never owner-direct, platform path only,
 * dark behind GATE_IB_VOID_INVOICE (which needs GATE_IB_PLATFORM).
 *
 *   unconfirmed -> a PREVIEW: nothing is written. Its `_version` pins what the card showed (invoice status,
 *                  edit time, amounts, credit, PaymentIntent and its Stripe status, statement, lines, links).
 *   confirmed   -> re-derives the preview and refuses with preview_changed on any drift, then runs the
 *                  handler with the invoice version the card showed (`expected`); voidInvoice enforces it on
 *                  the row it reads and again inside its own UPDATE, so a change after the check loses.
 */
const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const { UUID_RE } = require('./task-context');

function voidInvoiceLive() {
  return require('../../config/feature-gates').ibVoidInvoiceLive() === true;
}

const VOID_INVOICE_TOOLS = [
  {
    name: 'void_invoice',
    description: `Void ONE existing invoice that has collected nothing: the Invoices page "Void" button. Voiding cancels the invoice (it is kept, marked void); it never deletes it. The first call returns a PREVIEW and writes nothing: the invoice, the customer, the amount, its status, and exactly what voiding does. The operator approves on the confirmation card; the confirmed run re-checks all of it and refuses if anything changed.
Effects: the invoice becomes void, its payment reminders stop, any account credit applied to it goes back to the customer's balance, and a payer's still-open statement drops it from its total. An unpaid pay-page session (a PaymentIntent nobody has tried to pay) is cancelled. The linked visit is not changed. Nothing is sent to the customer or anyone (no text, email or call). The Invoices page can restore a voided invoice to a draft.
Refused with the reason: invoice not found, already void, canceled, a send in progress, and every invoice with money received or in flight (paid, partly paid, a payment recorded, a payment or charge on file, an open or processing card payment, a refund, a deposit already collected, a finalized payer statement, a payment plan). Those are by_owner_rule: refunds and card charges stay on the Invoices page. Annual-plan, membership-dues, bait-station-setup and queued-text invoices are also left to the Invoices page. Admin only.
Takes invoice_id OR invoice_number, exactly one.
Use for: "void this invoice", "void invoice WPC-2026-0534", "cancel this invoice", "cancel the invoice", "delete the invoice" (an invoice is voided, never deleted), "get rid of this invoice", "kill that invoice".`,
    input_schema: {
      type: 'object',
      properties: {
        invoice_id: { type: 'string', format: 'uuid', description: 'The existing invoice (from get_customer_invoices)' },
        invoice_number: { type: 'string', description: 'The invoice number, e.g. WPC-2026-0534 (use instead of invoice_id)' },
      },
    },
  },
];

const money = (value) => `$${(Math.round((Number(value) || 0) * 100) / 100).toFixed(2)}`;
const cents = (value) => Math.round((Number(value) || 0) * 100);
const msOf = (value) => (value ? new Date(value).getTime() : null);
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
const refusal = (error, code, extra = {}) => ({ error, code, ...extra });
const ownerRule = (error, reason, invoiceId) => refusal(`${error} Refunds and card charges stay on the Invoices page.`, 'by_owner_rule', { reason, invoice_id: invoiceId });
const toPage = (error, reason, invoiceId) => refusal(`${error} Void it from the Invoices page.`, 'needs_invoices_page', { reason, invoice_id: invoiceId });

// Statuses that read as collected or moving money (the screen shows no Void button for them either).
const MONEY_STATUSES = new Set(['paid', 'processing', 'refunded', 'partially_refunded', 'partial', 'disputed']);
// The Stripe states of an invoice's own PaymentIntent that mean no payment was attempted: the handler cancels it.
const UNCONFIRMED_PI = new Set(['requires_payment_method', 'requires_confirmation']);
// A payments row in one of these states moved no money (anything else, refunds included, did or may have).
const NO_MONEY_PAYMENT = new Set(['failed', 'canceled', 'cancelled']);
const INVOICE_LINK_KEYS = ['invoice_id', 'dispute_invoice_id', 'waves_invoice_id'];

function parseLines(raw) {
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

async function customerName(customerId) {
  const c = await db('customers').where({ id: customerId }).first('first_name', 'last_name', 'company_name');
  return [c?.first_name, c?.last_name].filter(Boolean).join(' ') || c?.company_name || null;
}

// The invoice the call names: exactly one of id / number.
async function resolveInvoice(input) {
  const rawId = String(input?.invoice_id || '').trim();
  const rawNumber = String(input?.invoice_number || '').trim();
  if (Boolean(rawId) === Boolean(rawNumber)) return refusal('Give exactly one of invoice_id or invoice_number', 'invalid_target');
  if (rawId && !UUID_RE.test(rawId)) return refusal('A valid invoice_id is required', 'invalid_target');
  const invoice = rawId
    ? await db('invoices').where({ id: rawId.toLowerCase() }).first()
    : await db('invoices').where({ invoice_number: rawNumber.toUpperCase() }).first();
  return invoice ? { invoice } : refusal('Invoice not found', 'invoice_not_found');
}

// Payments tied to this invoice by the portal's own linkage (metadata invoice keys, the invoice's PaymentIntent or
// charge id, the manual-payment description). A row naming a different invoice is that invoice's.
async function linkedPayments(invoice) {
  const rows = await db('payments')
    .where(function linkedToInvoice() {
      for (const key of INVOICE_LINK_KEYS) this.orWhereRaw(`payments.metadata::jsonb ->> '${key}' = ?`, [String(invoice.id)]);
      if (invoice.stripe_payment_intent_id) this.orWhereRaw('payments.stripe_payment_intent_id = ?', [String(invoice.stripe_payment_intent_id)]);
      if (invoice.stripe_charge_id) this.orWhereRaw('payments.stripe_charge_id = ?', [String(invoice.stripe_charge_id)]);
      if (/^[A-Za-z0-9-]+$/.test(String(invoice.invoice_number || ''))) this.orWhereRaw('payments.description LIKE ?', [`Invoice ${invoice.invoice_number} — %`]);
    })
    .limit(25)
    .select('id', 'status', 'metadata', 'stripe_payment_intent_id');
  return (rows || []).filter((row) => {
    const meta = typeof row.metadata === 'string' ? (() => { try { return JSON.parse(row.metadata); } catch { return {}; } })() : (row.metadata || {});
    const named = INVOICE_LINK_KEYS.map((key) => meta?.[key]).filter(Boolean).map(String);
    return !(named.length && !named.includes(String(invoice.id)));
  });
}

// Money received or in flight, from the invoice row and its database links: the by_owner_rule refusals.
async function moneyRefusal(invoice) {
  const at = invoice.id;
  const status = String(invoice.status || '').toLowerCase();
  if (MONEY_STATUSES.has(status)) {
    return ownerRule(`Invoice ${invoice.invoice_number} is ${status}, so money has been received or is moving. A void would hide it.`, `status_${status}`, at);
  }
  if (status === 'prepaid') {
    return ownerRule(`Invoice ${invoice.invoice_number} is prepaid (covered by credit or a payment). The Invoices page hides Void for it, so reverse the prepayment there.`, 'status_prepaid', at);
  }
  if (invoice.payment_recorded_at) return ownerRule(`A payment is already recorded on invoice ${invoice.invoice_number}.`, 'payment_recorded', at);
  if (invoice.stripe_charge_id) return ownerRule(`Invoice ${invoice.invoice_number} has a card charge on file.`, 'charge_on_file', at);
  if (invoice.paid_at && status !== 'prepaid') return ownerRule(`Invoice ${invoice.invoice_number} carries a paid date.`, 'paid_date', at);
  const payments = await linkedPayments(invoice);
  const moved = payments.find((p) => !NO_MONEY_PAYMENT.has(String(p.status || '').toLowerCase()) || (!p.stripe_payment_intent_id && String(p.status).toLowerCase() === 'failed'));
  if (moved) return ownerRule(`A payment (${moved.status}) is on file for invoice ${invoice.invoice_number}.`, 'payment_on_file', at);
  const depositLine = parseLines(invoice.line_items).find((li) => li?.category === 'deposit_credit');
  if (depositLine) return ownerRule(`Invoice ${invoice.invoice_number} applies a deposit the customer already paid.`, 'deposit_collected', at);
  if (invoice.payer_statement_id) {
    const stmt = await db('payer_statements').where({ id: invoice.payer_statement_id }).first('status');
    if (stmt && stmt.status !== 'open') return ownerRule(`Invoice ${invoice.invoice_number} is on a finalized payer statement.`, 'finalized_statement', at);
  }
  const plan = await db('payment_plans').where({ invoice_id: invoice.id }).whereNot('status', 'cancelled').first('id', 'status');
  if (plan) return ownerRule(`Invoice ${invoice.invoice_number} has a payment plan (${plan.status}).`, 'payment_plan', at);
  try {
    await require('../stripe').assertNoInvoiceChargeReconciliationPending(invoice.id, db, { readOnly: true });
  } catch (err) {
    if (err?.reconciliationRequired || /^STRIPE_/.test(String(err?.code || ''))) {
      return ownerRule(`Invoice ${invoice.invoice_number} has a saved-card charge in progress or unresolved.`, 'charge_in_progress', at);
    }
    return refusal('The bar could not check for a card charge in progress, so nothing was offered. Void it from the Invoices page.', 'unverified', { invoice_id: at });
  }
  return null;
}

// Invoices whose void also unwinds a plan, a month of dues, a setup obligation or a queued text: the Invoices page.
async function pageOnlyRefusal(invoice) {
  const at = invoice.id;
  try {
    if (parseLines(invoice.line_items).some((li) => li && li.membership_dues_month)) {
      return toPage(`Invoice ${invoice.invoice_number} is a membership-dues invoice: voiding it releases a month of coverage.`, 'membership_dues', at);
    }
    if (parseLines(invoice.line_items).some((li) => /^Bait Station Setup — one-time setup fee$/.test(String(li?.description || '').trim()))) {
      return toPage(`Invoice ${invoice.invoice_number} bills a bait-station setup fee: voiding it puts that obligation back on the service.`, 'setup_fee', at);
    }
    if (await db('setup_fee_claims').where({ invoice_id: invoice.id }).first('id')) {
      return toPage(`Invoice ${invoice.invoice_number} has a setup-fee claim.`, 'setup_fee', at);
    }
    if (invoice.annual_prepay_covered_term_id) {
      return toPage(`Invoice ${invoice.invoice_number} is covered by an annual plan.`, 'annual_plan_covered', at);
    }
    if (await db('annual_prepay_terms').where({ prepay_invoice_id: invoice.id }).first('id')
      || await require('../invoice-prepay').resolveInvoiceTermId(invoice, db, { strict: true })) {
      return toPage(`Invoice ${invoice.invoice_number} belongs to an annual plan.`, 'annual_plan', at);
    }
    if (invoice.stripe_payment_intent_id) {
      const shared = await db('invoices').where({ stripe_payment_intent_id: invoice.stripe_payment_intent_id }).whereNot('id', invoice.id).first('id');
      if (shared) return toPage(`Invoice ${invoice.invoice_number} shares a combined payment session with other invoices.`, 'combined_payment', at);
    }
    if (await require('../invoice').queuedPayLinkText(invoice.id, { adoptsQueuedInvoiceSend: false })) {
      return toPage(`A pay-link text is queued for invoice ${invoice.invoice_number}.`, 'queued_text', at);
    }
  } catch (err) {
    logger.warn(`[intelligence-bar:void-invoice] link check failed (${err.code || err.name || 'error'})`);
    return refusal('The bar could not check what else this invoice is tied to, so nothing was offered. Void it from the Invoices page.', 'unverified', { invoice_id: at });
  }
  return null;
}

// The invoice's own PaymentIntent, read from Stripe: null (none), or { id, status } / a refusal. Unconfirmed or
// canceled is fine (the handler cancels the unconfirmed one); anything else is money in flight or possible.
async function paymentIntentState(invoice) {
  const piId = invoice.stripe_payment_intent_id || null;
  if (!piId) return { pi: null };
  let pi;
  try {
    pi = await require('../stripe').retrievePaymentIntent(piId);
  } catch {
    pi = null;
  }
  if (!pi?.status) return refusal('The bar could not read this invoice’s open card-payment session from Stripe, so nothing was offered. Void it from the Invoices page.', 'unverified', { invoice_id: invoice.id });
  if (pi.status === 'canceled') return { pi: { id: piId, status: 'canceled' } };
  if (!UNCONFIRMED_PI.has(pi.status)) {
    return ownerRule(`Invoice ${invoice.invoice_number} has a card payment session in state ${pi.status}: a payment may be in progress or made.`, `payment_intent_${pi.status}`, invoice.id);
  }
  return { pi: { id: piId, status: pi.status } };
}

async function linkedVisit(invoice) {
  const visitId = await require('../invoice').linkedScheduledServiceId(invoice, db);
  if (!visitId) return null;
  const visit = await db('scheduled_services').where({ id: visitId }).first('id', 'status', 'scheduled_date');
  return visit ? { id: visit.id, status: visit.status || null, date: visit.scheduled_date ? String(visit.scheduled_date).slice(0, 10) : null } : null;
}

function planEffects({ invoice, credit, pi, visit, statementOpen }) {
  const effects = [
    { kind: 'billing', text: `Invoice ${invoice.invoice_number} (${money(invoice.total)}) becomes void and is kept on record. Nothing has been collected on it.` },
    credit > 0
      ? { kind: 'billing', text: `${money(credit)} of account credit applied to it goes back to the customer’s balance.` }
      : { kind: 'billing', text: 'No account credit is applied to it, so none is returned.' },
    { kind: 'operational', text: 'Its automatic payment reminders stop.' },
    ...(pi && pi.status !== 'canceled' ? [{ kind: 'billing', text: 'Its open card-payment session (nobody has tried to pay) is cancelled with Stripe, so the pay link stops working.' }] : []),
    ...(statementOpen ? [{ kind: 'billing', text: 'It drops out of the payer’s open monthly statement total.' }] : []),
    { kind: 'operational', text: visit
      ? `Its linked visit (${visit.date || 'no date'}, ${visit.status || 'no status'}) is not changed.`
      : 'It is not linked to a visit.' },
    { kind: 'comms', text: 'Nothing is sent: no text, email or call goes to the customer or anyone else.' },
    { kind: 'billing', text: 'No refund, no card charge, no new invoice. The Invoices page can restore it to a draft.' },
  ];
  return effects;
}

// Everything the card approves: a change in any of it is drift.
function versionOf({ invoice, pi, visit, lines }) {
  return {
    invoice_id: invoice.id,
    status: invoice.status,
    updated_at: msOf(invoice.updated_at),
    total: cents(invoice.total),
    credit_applied: cents(invoice.credit_applied),
    customer_id: invoice.customer_id || null,
    payer_id: invoice.payer_id || null,
    payer_statement_id: invoice.payer_statement_id || null,
    payment_intent: pi ? `${pi.id}:${pi.status}` : null,
    visit: visit ? `${visit.id}:${visit.status}` : null,
    lines: digest(lines),
  };
}

async function buildPlan(input) {
  const target = await resolveInvoice(input);
  if (target.error) return target;
  const { invoice } = target;
  const at = invoice.id;
  const status = String(invoice.status || '').toLowerCase();
  if (status === 'void') return refusal(`Invoice ${invoice.invoice_number} is already void. Nothing was changed.`, 'already_void', { invoice_id: at });
  if (status === 'canceled' || status === 'cancelled') return refusal(`Invoice ${invoice.invoice_number} is ${status}, so it cannot be voided.`, 'not_voidable', { invoice_id: at });
  if (status === 'sending') return refusal('A send is in progress for this invoice. Wait a moment, then ask again.', 'send_in_progress', { invoice_id: at });
  const money_ = await moneyRefusal(invoice);
  if (money_) return money_;
  const pageOnly = await pageOnlyRefusal(invoice);
  if (pageOnly) return pageOnly;
  const piState = await paymentIntentState(invoice);
  if (piState.error) return piState;
  const visit = await linkedVisit(invoice);
  const statement = invoice.payer_statement_id
    ? await db('payer_statements').where({ id: invoice.payer_statement_id }).first('status')
    : null;
  const lines = parseLines(invoice.line_items).map((li) => [li?.description || li?.name || 'Line', Number(li?.amount ?? li?.unit_price) || 0]);
  const name = await customerName(invoice.customer_id);
  const credit = Math.round((Number(invoice.credit_applied) || 0) * 100) / 100;
  return {
    preview: true,
    tool: 'void_invoice',
    invoice_id: invoice.id,
    invoice_number: invoice.invoice_number,
    customer_id: invoice.customer_id,
    customer_name: name,
    status: invoice.status,
    amount: money(invoice.total),
    credit_applied: money(credit),
    amount_due: money(Math.max(0, cents(invoice.total) - cents(invoice.credit_applied)) / 100),
    lines: lines.slice(0, 6).map(([description, amount]) => `${String(description).replace(/\s+/g, ' ').trim()} ${money(amount)}`),
    effects: planEffects({ invoice, credit, pi: piState.pi, visit, statementOpen: Boolean(statement && statement.status === 'open') }),
    sends_to_customer: false,
    _version: versionOf({ invoice, pi: piState.pi, visit, lines }),
    _expected: {
      status: invoice.status,
      updatedAt: msOf(invoice.updated_at),
      total: Number(invoice.total) || 0,
      creditApplied: Number(invoice.credit_applied) || 0,
      paymentIntentId: invoice.stripe_payment_intent_id || null,
    },
    note: 'PREVIEW ONLY — nothing was changed. Confirm voids exactly this invoice; if anything changed it refuses.',
  };
}

// The re-derived plan when it still matches the card's pin, or the refusal.
async function verifiedPlan(input, pinned) {
  if (!pinned) return { refusal: refusal('Use the confirmation card to approve this void.', 'approval_required') };
  const plan = await buildPlan(input);
  if (plan.error) return { refusal: { error: `Nothing was changed: ${plan.error}`, code: plan.code, preview_changed: true, ...(plan.code === 'by_owner_rule' ? { reason: plan.reason } : {}) } };
  if (JSON.stringify(plan._version) !== JSON.stringify(pinned)) {
    return { refusal: { error: 'The invoice changed after the card was shown, so nothing was voided. Ask again for a fresh confirmation card.', code: 'preview_changed', preview_changed: true } };
  }
  return { plan };
}

const DRIFT_RE = /changed while voiding|new payment session/i;
const MONEY_RE = /payment|refund|in flight|charge/i;

async function commitVoid(input) {
  const { plan, refusal: refused } = await verifiedPlan(input, input._verified_invoice_void_version);
  if (refused) return refused;
  const base = { invoice_id: plan.invoice_id, invoice_number: plan.invoice_number, customer_id: plan.customer_id };
  let result;
  try {
    result = await require('../../routes/admin-invoices').voidInvoiceFromBar({ invoiceId: plan.invoice_id, expected: plan._expected });
  } catch (err) {
    // The handler threw after the card was approved (for example the annual-prepay restore after the void
    // committed). Read the invoice back: never invite a retry on an unknown outcome.
    const now = await db('invoices').where({ id: plan.invoice_id }).first('status').catch(() => null);
    if (now?.status === 'void') {
      return { ...base, success: true, status: 'void', sent_to_customer: false, warning: true,
        note: `Invoice ${plan.invoice_number} is void, but a follow-up step reported a problem. Check the invoice on the Invoices page.` };
    }
    logger.error(`[intelligence-bar:void-invoice] handler failed (${err.code || err.name || 'error'})`);
    return { ...base, outcome_unknown: true, code: 'execution_interrupted',
      error: 'The void was interrupted — it may or may not have happened. Check the invoice before trying again.' };
  }
  const { status, json } = result;
  if (status !== 200) {
    const message = String(json?.error || 'the Invoices page refused it');
    const drift = status === 409 && DRIFT_RE.test(message);
    const code = status === 404 ? 'not_found' : drift ? 'preview_changed' : status === 409 && MONEY_RE.test(message) ? 'by_owner_rule' : 'void_refused';
    return { ...base, failed: true, code, error: `The invoice was not voided: ${message}`, ...(drift || status === 404 ? { preview_changed: true } : {}) };
  }
  if (json?.status !== 'void') {
    return { ...base, outcome_unknown: true, code: 'void_unverified',
      error: 'The Invoices page answered, but the invoice does not read as void. Check the invoice before trying again.' };
  }
  logger.info(`[intelligence-bar:void-invoice] voided invoice ${plan.invoice_id}`);
  return { ...base, success: true, status: 'void', sent_to_customer: false,
    note: `Invoice ${plan.invoice_number} is void. Nothing was sent to anyone. The Invoices page can restore it to a draft.` };
}

// ── card lines (authorization-contract.js) ──────────────────────

function cardLines(toolName, preview) {
  if (toolName !== 'void_invoice' || !preview || preview.preview !== true) return [];
  return [
    { kind: 'billing', text: `Void invoice ${preview.invoice_number} for ${preview.customer_name || preview.customer_id}: ${preview.amount} (${preview.status}, ${preview.amount_due} due)` },
    ...(preview.lines || []).map((text) => ({ kind: 'billing', text: `Line: ${text}` })),
    ...(preview.effects || []).map(({ kind, text }) => ({ kind, text })),
  ];
}

async function executeVoidInvoiceTool(toolName, input = {}, actionContext = {}) {
  if (!VOID_INVOICE_TOOLS.some((t) => t.name === toolName)) return { error: `Unknown tool: ${toolName}` };
  // Admin only, like the requireAdmin void route; the registry refuses a technician too. The confirmed
  // run needs a positive admin flag (fail closed).
  if (actionContext?.isAdmin === false || (input.confirmed === true && actionContext?.isAdmin !== true)) {
    return refusal('Voiding invoices is limited to admin accounts', 'permission_denied');
  }
  if (!voidInvoiceLive()) return refusal('Voiding an invoice from the bar is switched off.', 'gate_off');
  try {
    // Only /confirm-action sets confirmed (route-derived, never a model param).
    return input.confirmed === true ? await commitVoid(input) : await buildPlan(input);
  } catch (err) {
    logger.error(`[intelligence-bar:void-invoice] ${toolName} failed (${err.code || err.name || 'error'})`);
    return input.confirmed === true
      ? { outcome_unknown: true, code: 'execution_interrupted', error: 'The void was interrupted — it may or may not have happened. Check the invoice before trying again.' }
      : { error: 'Could not prepare the void' };
  }
}

module.exports = {
  VOID_INVOICE_TOOLS,
  executeVoidInvoiceTool,
  voidInvoiceLive,
  cardLines,
};
