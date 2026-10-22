/**
 * Intelligence Bar — set a customer's Bill-To payer
 * server/services/intelligence-bar/bill-to-tools.js
 *
 * Owner ruling 2026-10-21 ("BUILD", IB gap #9: "set bill-to / payer party on a customer account and
 * invoice"; gap #10: "assign third-party payer bill-to to customer account and all future appointments"):
 * a card that replays the customer page's own Bill-To select.
 *
 *   set_customer_bill_to — the customer page "Bill-To" select (PUT /admin/customers/:id with only
 *                          { payerId }), run through admin-customers.js setCustomerBillToFromBar: the same
 *                          handler, in process, so every Bill-To step and refusal is the route's own.
 *
 * Scope, on purpose: the account default for FUTURE billing only. The card is offered only to a customer who
 * pays for themselves today AND has nothing for the change to act on now: no open invoice without a payer on it
 * and no open invoice with a checkout. Then the handler's own steps for a payer change (the withdrawal of unpaid
 * self-pay invoices, the release of open checkout sessions) find nothing: no invoice moves, no pay link stops, no
 * Stripe session is cancelled, and the change is undone by setting Bill-To back on the customer page. A customer
 * with open invoices goes to the customer page. (Six Codex rounds on #6420 showed that the per-invoice outcomes of
 * that handler cannot be shown on a card without restating every ownership rule; the narrow scope makes every
 * card line true by construction.) Changing or removing a payer stays on the customer page.
 *
 * Always a confirm card (write-gates.js two-step), admin only, never owner-direct, platform path only,
 * dark behind GATE_IB_SET_BILL_TO (which needs GATE_IB_PLATFORM). It sends NO text, email or call.
 *
 *   unconfirmed -> a PREVIEW: nothing is written. Its `_version` pins what the card showed (the customer and
 *                  name, the payer's name, terms, tax status, and the upcoming visits that keep their own Bill-To).
 *   confirmed   -> re-derives the preview and refuses with preview_changed on any drift, then runs the handler,
 *                  which re-checks the card inside its transaction over held rows (lockedPlanCheck) before it
 *                  writes, and refuses if its withdrawal would move any invoice.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { UUID_RE } = require('./task-context');

function setBillToLive() {
  return require('../../config/feature-gates').ibSetBillToLive() === true;
}

const BILL_TO_TOOLS = [
  {
    name: 'set_customer_bill_to',
    description: `Set the Bill-To payer on ONE customer account who pays for themselves today: the customer page "Bill-To" select, for future billing. A payer is a third party (property manager, HOA, landlord, company AP) that receives the customer's invoices. The first call returns a PREVIEW and writes nothing. The operator approves on the confirmation card; the confirmed run re-checks it and refuses if anything changed.
Effects: future invoices for this customer bill to the payer (except a visit that has its own Bill-To or is pinned to the customer). Offered only when the customer has no unpaid invoice billed to them and no open checkout, so no existing invoice moves and nothing is cancelled. Nothing is sent to anyone (no text, email or call).
Refused with the reason: customer not found, payer not found or inactive, the customer already has a payer, or the customer has unpaid invoices or an open checkout (use the customer page Bill-To select: it moves those invoices to the payer). To add a NEW payer, use the customer page. Admin only.
Give payer_id, or payer_name (matched against active payers; it must match exactly one). Find a customer with query_customers first.
Use for: "bill this customer to <payer>", "set the Bill-To to <payer>", "invoices for this account go to <property manager>", "make <payer> the payer on this account and future appointments".`,
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', format: 'uuid', description: 'The customer (from query_customers or get_customer_detail)' },
        payer_id: { type: 'string', description: 'The payer id (use instead of payer_name)' },
        payer_name: { type: 'string', description: 'The payer name or company, e.g. "Sunrise Property Management" (use instead of payer_id)' },
      },
      required: ['customer_id'],
    },
    _sideEffects: true,
  },
];

const money = (value) => `$${(Math.round((Number(value) || 0) * 100) / 100).toFixed(2)}`;
const refusal = (error, code, extra = {}) => ({ error, code, ...extra });
const toPage = (error, reason, extra = {}) => refusal(`${error} Do it from the customer page Bill-To select.`, 'needs_customer_page', { reason, ...extra });
const plural = (n, one, many) => (n === 1 ? one : many);

// The statuses the checkout-session release treats as closed (pay-combined.js stampedCombinedSessionRows): every
// other invoice, 'processing' and drafts included, is still open to the payer-change steps.
const CLOSED = ['paid', 'prepaid', 'void', 'refunded', 'canceled', 'cancelled'];

const payerLabel = (p) => [p.display_name, p.company_name && p.company_name !== p.display_name ? `(${p.company_name})` : null].filter(Boolean).join(' ');

// One payer row; under the handler's transaction (lock) it is held FOR SHARE, so an edit to the payer the card
// names waits for the Bill-To write.
function payerRow(id, { database = db, lock = false } = {}) {
  const pid = Number(id);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const q = database('payers').where({ id: pid });
  return (lock ? q.forShare() : q).first();
}

async function resolvePayer(input, ctx = {}) {
  const rawId = String(input?.payer_id || '').trim();
  const rawName = String(input?.payer_name || '').trim();
  if (Boolean(rawId) === Boolean(rawName)) return refusal('Give exactly one of payer_id or payer_name', 'invalid_target');
  if (rawId) {
    const payer = await payerRow(rawId, ctx);
    if (!payer) return refusal('Payer not found', 'payer_not_found');
    if (payer.active === false) return refusal(`Payer ${payerLabel(payer)} is inactive, so nothing was offered. Reactivate it on the Payers page first.`, 'payer_inactive');
    return { payer };
  }
  const matches = await require('../payer').listPayers({ search: rawName, limit: 10 });
  const exact = matches.filter((p) => [p.display_name, p.company_name].some((v) => String(v || '').trim().toLowerCase() === rawName.toLowerCase()));
  const pick = exact.length === 1 ? exact : matches;
  if (pick.length === 1) return { payer: pick[0] };
  if (!pick.length) return refusal(`No active payer matches "${rawName}". A new payer is added on the customer page.`, 'payer_not_found');
  return refusal(`"${rawName}" matches ${pick.length} payers. Ask which one, then pass its payer_id.`, 'ambiguous_payer', {
    candidates: pick.slice(0, 5).map((p) => ({ payer_id: String(p.id), name: payerLabel(p) })),
  });
}

const customerName = (customer) => [customer.first_name, customer.last_name].filter(Boolean).join(' ') || customer.company_name || null;

// A customer who already has a payer: the same payer is a no-op, another one stays on the customer page.
async function hasPayerRefusal(customer, payer, name, ctx) {
  const who = name || 'This customer';
  if (String(customer.payer_id) === String(payer.id)) {
    return refusal(`${who} already bills to ${payerLabel(payer)}. Nothing was changed.`, 'already_set', { customer_id: customer.id });
  }
  const current = await payerRow(customer.payer_id, ctx);
  return toPage(`${who} already bills to ${current ? payerLabel(current) : `payer ${customer.payer_id}`}. The bar sets a payer only on a customer who pays for themselves.`, 'has_payer');
}

// What a payer change would act on NOW: an open invoice with no payer on it (the withdrawal's whole candidate set,
// statement-held and processing ones included), or an open invoice with a checkout (the session release's whole
// candidate set). Under the handler's transaction the rows are held FOR UPDATE.
function openInvoices(customerId, { database = db, lock = false } = {}) {
  const q = database('invoices').where({ customer_id: customerId }).whereNotIn('status', CLOSED)
    .where((w) => w.whereNull('payer_id').orWhereNotNull('stripe_payment_intent_id'))
    .orderBy('id');
  return (lock ? q.forUpdate() : q).select('id', 'invoice_number', 'total', 'status');
}

// Visits that can still bill and keep their own Bill-To (their own payer, or pinned to the customer), overdue ones
// included: every visit not completed and not a never-ran status.
async function pinnedVisits(customerId, { database = db, lock = false } = {}) {
  const hasSelfPay = await require('../payer').scheduledServicesHasSelfPay(database);
  const q = database('scheduled_services').where({ customer_id: customerId })
    .whereNotIn('status', ['completed', ...require('../invoice-helpers').VISIT_NEVER_RAN_STATUSES])
    .where((w) => {
      w.whereNotNull('payer_id');
      if (hasSelfPay) w.orWhere('self_pay_override', true);
    });
  // Under the handler's transaction the visit rows are held FOR SHARE, so a schedule edit to one waits.
  const rows = await (lock ? q.orderBy('id').forShare() : q).select('id');
  return rows.length;
}

function planEffects({ name, payer, payerName, pinned }) {
  return [
    { kind: 'billing', text: `New invoices for ${name || 'this customer'} bill to ${payerName}${payer.payment_terms ? ` (terms: ${String(payer.payment_terms).replace(/_/g, ' ')})` : ''}.` },
    payer.tax_exempt ? { kind: 'billing', text: `${payerName} is tax-exempt: invoices billed to it carry no sales tax.` } : null,
    pinned > 0
      ? { kind: 'billing', text: `${pinned} upcoming ${plural(pinned, 'visit keeps its', 'visits keep their')} own Bill-To (a payer of ${plural(pinned, 'its', 'their')} own, or pinned to the customer).` }
      : null,
    { kind: 'billing', text: 'No existing invoice changes hands: the customer has no unpaid invoice billed to them and no open checkout. Nothing is charged, refunded or cancelled.' },
    { kind: 'billing', text: 'To undo, set Bill-To back to the customer on the customer page.' },
    { kind: 'comms', text: 'Nothing is sent: no text, email or call goes to the customer or the payer.' },
  ].filter(Boolean);
}

async function buildPlan(input, ctx = {}) {
  const { database = db } = ctx;
  const customerId = String(input?.customer_id || '').trim().toLowerCase();
  if (!UUID_RE.test(customerId)) return refusal('A valid customer_id is required', 'invalid_target');
  const customer = await database('customers').where({ id: customerId }).whereNull('deleted_at')
    .first('id', 'first_name', 'last_name', 'company_name', 'payer_id');
  if (!customer) return refusal('Customer not found', 'customer_not_found');
  const target = await resolvePayer(input, ctx);
  if (target.error) return target;
  const { payer } = target;
  const name = customerName(customer);
  if (customer.payer_id) return hasPayerRefusal(customer, payer, name, ctx);
  const open = await openInvoices(customer.id, ctx);
  if (open.length) {
    const list = open.slice(0, 5).map((inv) => `${inv.invoice_number} ${money(inv.total)} (${inv.status})`).join(', ');
    return toPage(`${name || 'This customer'} has ${plural(open.length, '1 unpaid invoice', `${open.length} unpaid invoices`)} billed to them or with an open checkout (${list}${open.length > 5 ? ', …' : ''}). The bar sets a payer only when no existing invoice would move; the customer page moves them to the payer.`, 'open_invoices', { invoices: open.map((inv) => inv.invoice_number) });
  }
  const pinned = await pinnedVisits(customer.id, ctx);
  const payerName = payerLabel(payer);
  return {
    preview: true,
    tool: 'set_customer_bill_to',
    customer_id: customer.id,
    customer_name: name,
    bill_to_now: 'The customer (self-pay)',
    payer_id: String(payer.id),
    payer_name: payerName,
    effects: planEffects({ name, payer, payerName, pinned }),
    sends_to_customer: false,
    // What the confirm re-checks: every fact the card showed.
    _version: {
      customer_id: customer.id,
      customer_name: name,
      payer_before: null,
      payer_after: String(payer.id),
      payer_active: payer.active !== false,
      payer_name: payerName,
      payer_terms: payer.payment_terms || null,
      payer_tax_exempt: payer.tax_exempt === true,
      pinned,
    },
    note: 'PREVIEW ONLY — nothing was changed. Confirm sets exactly this Bill-To; if anything changed it refuses.',
  };
}

async function verifiedPlan(input, pinned) {
  if (!pinned) return { refusal: refusal('Use the confirmation card to approve this Bill-To change.', 'approval_required') };
  const plan = await buildPlan(input);
  if (plan.error) return { refusal: { error: `Nothing was changed: ${plan.error}`, code: plan.code, preview_changed: true } };
  if (JSON.stringify(plan._version) !== JSON.stringify(pinned)) {
    return { refusal: { error: 'The customer or the payer changed after the card was shown, so nothing was changed. Ask again for a fresh confirmation card.', code: 'preview_changed', preview_changed: true } };
  }
  return { plan };
}

// The card re-derived INSIDE the handler's transaction, before it writes: the customer row is already held FOR
// UPDATE there; this pass holds the payer and the visits it reads FOR SHARE and any open invoice FOR UPDATE. Any
// difference from the approved card (an invoice or checkout that appeared, a payer edit) refuses as
// preview_changed and rolls the edit back before any Stripe step (they run last).
function lockedPlanCheck(input, pinned) {
  return async (trx) => {
    const plan = await buildPlan(input, { database: trx, lock: true });
    if (plan.error || JSON.stringify(plan._version) !== JSON.stringify(pinned)) {
      throw Object.assign(new Error('The customer, the payer or their invoices changed after the card was shown.'), {
        statusCode: 409, isOperational: true, code: 'preview_changed',
      });
    }
  };
}

async function readBack(customerId) {
  return db('customers').where({ id: customerId }).first('payer_id').catch(() => null);
}

// The handler threw: its own refusals rolled everything back; anything else is judged by reading the Bill-To back.
async function handlerErrorResult(err, plan, base) {
  if (err?.code === 'preview_changed') {
    return { ...base, failed: true, code: 'preview_changed', preview_changed: true, error: 'The customer, the payer or their invoices changed after the card was shown, so nothing was changed. Ask again for a fresh confirmation card.' };
  }
  // The handler's own refusals (a send or a bank payment in flight, a credit that cannot be returned)
  // roll the whole transaction back: nothing was written.
  if (err?.code === 'invoice_send_in_flight' || /in flight|retry the payer change|credit reversal incomplete/i.test(String(err?.message || ''))) {
    return { ...base, failed: true, code: 'bill_to_refused', error: `The Bill-To was not changed: ${err.message}` };
  }
  const now = await readBack(plan.customer_id);
  logger.error(`[intelligence-bar:bill-to] handler failed (${err?.code || err?.name || 'error'})`);
  if (now && String(now.payer_id ?? '') === plan.payer_id) {
    return { ...base, success: true, warning: true, sent_to_customer: false,
      note: `${plan.customer_name || 'The customer'} now bills to ${plan.payer_name}, but a later step reported a problem. Check the customer page.` };
  }
  return { ...base, outcome_unknown: true, code: 'execution_interrupted',
    error: 'The Bill-To change was interrupted — it may or may not have happened. Check the customer page before trying again.' };
}

// The handler answered: a non-200 is its refusal; a 200 counts only when the Bill-To reads back as the payer.
async function handlerReplyResult({ status, json }, plan, base) {
  if (status !== 200) {
    return { ...base, failed: true, code: status === 404 ? 'not_found' : 'bill_to_refused',
      error: `The Bill-To was not changed: ${String(json?.error || json?.message || 'the customer page refused it')}` };
  }
  const now = await readBack(plan.customer_id);
  if (!now || String(now.payer_id ?? '') !== plan.payer_id) {
    return { ...base, outcome_unknown: true, code: 'bill_to_unverified',
      error: 'The customer page answered, but the Bill-To does not read as the new payer. Check the customer page before trying again.' };
  }
  logger.info(`[intelligence-bar:bill-to] customer ${plan.customer_id} -> payer ${plan.payer_id}`);
  return { ...base, success: true, sent_to_customer: false,
    note: `${plan.customer_name || 'The customer'} now bills to ${plan.payer_name}. No existing invoice moved. Nothing was sent to anyone.` };
}

async function commitBillTo(input, actionContext) {
  const { plan, refusal: refused } = await verifiedPlan(input, input._verified_bill_to_version);
  if (refused) return refused;
  const base = { customer_id: plan.customer_id, payer_id: plan.payer_id };
  let result;
  try {
    result = await require('../../routes/admin-customers').setCustomerBillToFromBar({
      customerId: plan.customer_id,
      payerId: plan.payer_id,
      expectedPayerId: null,
      verifyPlan: lockedPlanCheck({ customer_id: plan.customer_id, payer_id: plan.payer_id }, plan._version),
      actor: { technicianId: actionContext?.technicianId || null },
    });
  } catch (err) {
    return handlerErrorResult(err, plan, base);
  }
  return handlerReplyResult(result, plan, base);
}

// ── card lines (authorization-contract.js) ──────────────────────

function cardLines(toolName, preview) {
  if (toolName !== 'set_customer_bill_to' || !preview || preview.preview !== true) return [];
  return [
    { kind: 'billing', text: `Bill-To for ${preview.customer_name || preview.customer_id}: ${preview.bill_to_now} → ${preview.payer_name}` },
    ...(preview.effects || []).map(({ kind, text }) => ({ kind, text })),
  ];
}

async function executeBillToTool(toolName, input = {}, actionContext = {}) {
  if (!BILL_TO_TOOLS.some((t) => t.name === toolName)) return { error: `Unknown tool: ${toolName}` };
  // Admin only, like the customer page's Bill-To (requireAdmin); the confirmed run needs a positive admin flag.
  if (actionContext?.isAdmin === false || (input.confirmed === true && actionContext?.isAdmin !== true)) {
    return refusal('Changing Bill-To is limited to admin accounts', 'permission_denied');
  }
  if (!setBillToLive()) return refusal('Setting Bill-To from the bar is switched off.', 'gate_off');
  try {
    // Only /confirm-action sets confirmed (route-derived, never a model param).
    return input.confirmed === true ? await commitBillTo(input, actionContext) : await buildPlan(input);
  } catch (err) {
    logger.error(`[intelligence-bar:bill-to] ${toolName} failed (${err?.code || err?.name || 'error'})`);
    return input.confirmed === true
      ? { outcome_unknown: true, code: 'execution_interrupted', error: 'The Bill-To change was interrupted — it may or may not have happened. Check the customer page before trying again.' }
      : { error: 'Could not prepare the Bill-To change' };
  }
}

module.exports = {
  BILL_TO_TOOLS,
  executeBillToTool,
  setBillToLive,
  cardLines,
  lockedPlanCheck,
};
