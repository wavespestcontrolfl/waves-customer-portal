/**
 * Intelligence Bar — set a customer's Bill-To payer
 * server/services/intelligence-bar/bill-to-tools.js
 *
 * Owner ruling 2026-10-21 ("BUILD", IB gap #9: "set bill-to / payer party on a customer account and
 * invoice"): a card that replays the customer page's own Bill-To select.
 *
 *   set_customer_bill_to — the customer page "Bill-To" select (PUT /admin/customers/:id with only
 *                          { payerId }), run through admin-customers.js setCustomerBillToFromBar: the same
 *                          handler, in process, so every Bill-To step and refusal is the route's own.
 *
 * What the handler does for a self-pay -> payer change: writes customers.payer_id; cancels any unconfirmed
 * combined pay-page session on the customer's invoices; withdraws every unpaid self-pay invoice that now
 * resolves to the payer (combined-visit invoices and invoices linked to a visit or its service record): any
 * account credit applied to it returns to the customer's balance, it leaves the send queue, it is stamped
 * payer-billed (so its pay link stops working for the homeowner) and its armed reminders pause. Future
 * invoices bill to the payer unless the visit has its own Bill-To or is pinned to the customer. It sends NO
 * text, email or call (visit-linked-invoice-withdrawal.js: comms-free). It refuses while a combined bank
 * payment or a combined-visit send is in flight.
 *
 * Narrower than the screen, on purpose: only a customer with NO payer today. Changing one payer to another or
 * removing a payer stays on the customer page: removing one releases withdrawn invoices back to the customer,
 * and a release can put an invoice back in the send queue. Invoices with no visit link (a manual or project
 * invoice) do not move; the card lists how many stay with the customer.
 *
 * Always a confirm card (write-gates.js two-step), admin only, never owner-direct, platform path only,
 * dark behind GATE_IB_SET_BILL_TO (which needs GATE_IB_PLATFORM).
 *
 *   unconfirmed -> a PREVIEW: nothing is written. Its `_version` pins what the card showed (the customer's
 *                  current Bill-To, the payer and its active flag, the invoices that move and stay).
 *   confirmed   -> re-derives the preview and refuses with preview_changed on any drift, then runs the
 *                  handler with the Bill-To the card showed as current; the handler re-checks it on the
 *                  LOCKED customer row, so an edit after the re-check still loses.
 */
const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const { UUID_RE } = require('./task-context');

function setBillToLive() {
  return require('../../config/feature-gates').ibSetBillToLive() === true;
}

const BILL_TO_TOOLS = [
  {
    name: 'set_customer_bill_to',
    description: `Set the Bill-To payer on ONE customer account who pays for themselves today: the customer page "Bill-To" select. A payer is a third party (property manager, HOA, landlord, company AP) that receives the customer's invoices. The first call returns a PREVIEW and writes nothing: the customer, the payer, and every unpaid invoice that moves to the payer. The operator approves on the confirmation card; the confirmed run re-checks all of it and refuses if anything changed.
Effects: future invoices for this customer bill to the payer (except a visit that has its own Bill-To or is pinned to the customer). Unpaid invoices tied to a visit move to the payer now: their pay links stop working for the customer, account credit applied to them returns to the customer's balance, and their reminders pause. Open pay-page sessions on the customer's invoices are cancelled. Invoices with no visit (manual or project invoices) stay with the customer. Nothing is sent to anyone (no text, email or call).
Refused with the reason: customer not found, payer not found or inactive, the customer already has a payer (changing or removing a payer stays on the customer page), a combined bank payment or a combined-visit send in flight. To add a NEW payer, use the customer page. Admin only.
Give payer_id, or payer_name (matched against active payers; it must match exactly one). Find a customer with query_customers first.
Use for: "bill this customer to <payer>", "set the Bill-To to <payer>", "invoices for this account go to <property manager>", "make <payer> the payer on this account".`,
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
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
const refusal = (error, code, extra = {}) => ({ error, code, ...extra });
const toPage = (error, reason) => refusal(`${error} Do it from the customer page Bill-To select.`, 'needs_customer_page', { reason });

// Statuses an invoice can no longer change hands in (the withdrawal's own terminal list, plus processing).
const SETTLED = ['void', 'refunded', 'canceled', 'cancelled', 'paid', 'prepaid', 'processing'];

const payerLabel = (p) => [p.display_name, p.company_name && p.company_name !== p.display_name ? `(${p.company_name})` : null].filter(Boolean).join(' ');

async function resolvePayer(input) {
  const rawId = String(input?.payer_id || '').trim();
  const rawName = String(input?.payer_name || '').trim();
  if (Boolean(rawId) === Boolean(rawName)) return refusal('Give exactly one of payer_id or payer_name', 'invalid_target');
  if (rawId) {
    const payer = await require('../payer').getPayer(rawId);
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

async function customerName(customer) {
  return [customer.first_name, customer.last_name].filter(Boolean).join(' ') || customer.company_name || null;
}

// Whether a combined-visit invoice moves: the packet path withdraws it when any visit it bills resolves to a
// payer (liveThirdPartyPayerForPacket). Each billed visit is judged by the withdrawal module's own owner answer
// with the pending customer write laid over it, so a visit with its own Bill-To or pinned to the customer counts
// as it will. The handler re-checks the final set under its locks.
async function packetMoves(packetId, pending) {
  const packet = await db('visit_completion_packets').where({ id: packetId }).first('visit_id', 'payload');
  if (!packet) return false;
  const payload = require('../visit-completion-packets').packetPayload(packet);
  const billed = Array.isArray(payload?.billingSnapshot?.billedServiceIds) ? payload.billingSnapshot.billedServiceIds
    : await db('visit_completion_packet_items').where({ packet_id: packetId }).pluck('scheduled_service_id');
  const owners = await require('../visit-linked-invoice-withdrawal').visitOwnerTransitions(db, billed, { pending });
  return owners.some((o) => o.afterOwner != null);
}

// The unpaid invoices the handler's withdrawal moves to the payer: the visit-linked ones from the
// withdrawal module's own owner answer (mode 'pre' with the pending customer write), and the unpaid
// self-pay combined-visit invoices whose billed visits will resolve to a payer (packetMoves).
async function invoicePlan(customerId, payerId) {
  const Linked = require('../visit-linked-invoice-withdrawal');
  const pending = { customerPatch: { customerId, payer_id: payerId } };
  const transitions = await Linked.ownerTransitions(db, { customerId }, { mode: 'pre', pending, stamped: 'unstamped' });
  const movingIds = transitions.filter((t) => t.moved && String(t.afterOwner) === String(payerId)).map((t) => String(t.invoiceId));
  const packetRows = await db('invoices').where({ customer_id: customerId }).whereNotIn('status', SETTLED)
    .whereNull('payer_id').whereNotNull('visit_completion_packet_id')
    .where((q) => q.whereNull('scheduled_send_error').orWhereNot('scheduled_send_error', 'like', 'payer_billed:%'))
    .orderBy('id').select('id', 'visit_completion_packet_id');
  const packetIds = [];
  for (const row of packetRows) {
    if (!movingIds.includes(String(row.id)) && await packetMoves(row.visit_completion_packet_id, pending)) packetIds.push(String(row.id));
  }
  const moving = [...movingIds, ...packetIds].length
    ? await db('invoices').whereIn('id', [...movingIds, ...packetIds]).orderBy('invoice_number')
      .select('id', 'invoice_number', 'total', 'status', 'credit_applied', 'visit_completion_packet_id')
    : [];
  // Unpaid self-pay invoices with no visit link at all: nothing resolves a payer for them, so they stay.
  const staying = await db('invoices').where({ customer_id: customerId }).whereNotIn('status', SETTLED)
    .whereNull('payer_id').whereNull('payer_statement_id').whereNull('visit_completion_packet_id')
    .whereNull('scheduled_service_id').whereNull('service_record_id')
    .orderBy('invoice_number').select('id', 'invoice_number', 'total', 'status');
  return { moving, staying };
}

// Upcoming visits that keep their own Bill-To (their own payer, or pinned to the customer).
async function pinnedVisits(customerId) {
  const hasSelfPay = await require('../payer').scheduledServicesHasSelfPay(db);
  const q = db('scheduled_services').where({ customer_id: customerId })
    .whereIn('status', ['pending', 'confirmed', 'rescheduled'])
    .where('scheduled_date', '>=', require('../../utils/datetime-et').etDateString());
  q.where((w) => {
    w.whereNotNull('payer_id');
    if (hasSelfPay) w.orWhere('self_pay_override', true);
  });
  const row = await q.count('* as n').first();
  return Number(row?.n) || 0;
}

const invoiceLine = (inv) => `${inv.invoice_number} ${money(inv.total)} (${inv.status})`;

async function buildPlan(input) {
  const customerId = String(input?.customer_id || '').trim().toLowerCase();
  if (!UUID_RE.test(customerId)) return refusal('A valid customer_id is required', 'invalid_target');
  const customer = await db('customers').where({ id: customerId }).whereNull('deleted_at')
    .first('id', 'first_name', 'last_name', 'company_name', 'payer_id');
  if (!customer) return refusal('Customer not found', 'customer_not_found');
  const target = await resolvePayer(input);
  if (target.error) return target;
  const { payer } = target;
  const name = await customerName(customer);
  if (customer.payer_id) {
    const current = await require('../payer').getPayer(customer.payer_id);
    if (String(customer.payer_id) === String(payer.id)) {
      return refusal(`${name || 'This customer'} already bills to ${payerLabel(payer)}. Nothing was changed.`, 'already_set', { customer_id: customer.id });
    }
    return toPage(`${name || 'This customer'} already bills to ${current ? payerLabel(current) : `payer ${customer.payer_id}`}. The bar sets a payer only on a customer who pays for themselves.`, 'has_payer');
  }
  const { moving, staying } = await invoicePlan(customer.id, String(payer.id));
  const pinned = await pinnedVisits(customer.id);
  const credit = moving.reduce((sum, inv) => sum + (Number(inv.credit_applied) || 0), 0);
  const payerName = payerLabel(payer);
  const effects = [
    { kind: 'billing', text: `New invoices for ${name || 'this customer'} bill to ${payerName}${payer.payment_terms ? ` (terms: ${String(payer.payment_terms).replace(/_/g, ' ')})` : ''}.` },
    pinned > 0
      ? { kind: 'billing', text: `${pinned} upcoming visit${pinned === 1 ? ' keeps its' : 's keep their'} own Bill-To (a payer of ${pinned === 1 ? 'its' : 'their'} own, or pinned to the customer).` }
      : null,
    moving.length
      ? { kind: 'billing', text: `${moving.length === 1 ? '1 unpaid invoice moves' : `${moving.length} unpaid invoices move`} to ${payerName} now. The customer's pay link for ${moving.length === 1 ? 'it' : 'them'} stops working and reminders pause.` }
      : { kind: 'billing', text: 'No unpaid invoice moves: none is tied to a visit.' },
    // Every moving invoice is listed: Confirm moves all of them.
    ...moving.map((inv) => ({ kind: 'billing', text: `Moves: ${invoiceLine(inv)}` })),
    credit > 0.004 ? { kind: 'billing', text: `${money(credit)} of account credit applied to those invoices goes back to the customer's balance.` } : null,
    staying.length
      ? { kind: 'billing', text: `${staying.length} unpaid invoice${staying.length === 1 ? '' : 's'} with no visit stay${staying.length === 1 ? 's' : ''} billed to the customer: ${staying.map(invoiceLine).join(', ')}.` }
      : null,
    { kind: 'billing', text: 'Any open pay-page session on the customer\'s invoices is cancelled. Nothing is charged or refunded.' },
    { kind: 'comms', text: 'Nothing is sent: no text, email or call goes to the customer or the payer.' },
  ].filter(Boolean);
  return {
    preview: true,
    tool: 'set_customer_bill_to',
    customer_id: customer.id,
    customer_name: name,
    bill_to_now: 'The customer (self-pay)',
    payer_id: String(payer.id),
    payer_name: payerName,
    invoices_moving: moving.map((inv) => inv.invoice_number),
    invoices_staying: staying.map((inv) => inv.invoice_number),
    effects,
    sends_to_customer: false,
    // The invoices the handler must find moving, re-checked inside its transaction (never model-visible output).
    _moving: moving.map((inv) => ({ id: String(inv.id), status: inv.status, total: inv.total, credit_applied: inv.credit_applied })),
    _version: {
      customer_id: customer.id,
      payer_before: null,
      payer_after: String(payer.id),
      payer_active: payer.active !== false,
      payer_name: payerName,
      payer_terms: payer.payment_terms || null,
      moving: digest(moving.map((inv) => [String(inv.id), inv.status, String(inv.total), String(inv.credit_applied)])),
      staying: digest(staying.map((inv) => [String(inv.id), inv.status, String(inv.total)])),
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
    return { refusal: { error: 'The customer or their invoices changed after the card was shown, so nothing was changed. Ask again for a fresh confirmation card.', code: 'preview_changed', preview_changed: true } };
  }
  return { plan };
}

async function readBack(customerId) {
  return db('customers').where({ id: customerId }).first('payer_id').catch(() => null);
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
      expectedInvoices: plan._moving,
      actor: { technicianId: actionContext?.technicianId || null },
    });
  } catch (err) {
    if (err?.code === 'preview_changed') {
      return { ...base, failed: true, code: 'preview_changed', preview_changed: true, error: 'The Bill-To changed after the card was shown, so nothing was changed. Ask again for a fresh confirmation card.' };
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
  const { status, json } = result;
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
    note: `${plan.customer_name || 'The customer'} now bills to ${plan.payer_name}. ${plan.invoices_moving.length} unpaid invoice${plan.invoices_moving.length === 1 ? '' : 's'} moved to the payer. Nothing was sent to anyone.` };
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
};
