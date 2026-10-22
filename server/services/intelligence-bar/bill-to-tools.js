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
 * and a release can put an invoice back in the send queue. An unpaid self-pay invoice that would neither move nor
 * keep the customer as owner (no direct visit with its own Bill-To: a manual or project invoice, or one linked only
 * through a service record) refuses the card: the live owner answer would read it as the payer's unmoved.
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
Effects: future invoices for this customer bill to the payer (except a visit that has its own Bill-To or is pinned to the customer). Unpaid invoices tied to a visit move to the payer now: their pay links stop working for the customer, account credit applied to them returns to the customer's balance, and their reminders pause. Open pay-page sessions on the customer's invoices are cancelled. Invoices whose visit keeps its own Bill-To stay with the customer. Nothing is sent to anyone (no text, email or call).
Refused with the reason: customer not found, payer not found or inactive, an unpaid invoice with no visit of its own (manual or project invoice: collect, void or re-bill it first), the customer already has a payer (changing or removing a payer stays on the customer page), a combined bank payment or a combined-visit send in flight. To add a NEW payer, use the customer page. Admin only.
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

// Statuses an invoice can no longer change hands in: the canonical uncollectible list (processing included).
const SETTLED = require('../invoice-helpers').INVOICE_UNCOLLECTIBLE_STATUSES;

const payerLabel = (p) => [p.display_name, p.company_name && p.company_name !== p.display_name ? `(${p.company_name})` : null].filter(Boolean).join(' ');

// One payer row; under the handler's transaction (lock) it is held FOR SHARE, so an edit to a payer the card
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

async function customerName(customer) {
  return [customer.first_name, customer.last_name].filter(Boolean).join(' ') || customer.company_name || null;
}

// Who a combined-visit invoice moves to, or null when it stays: the packet path withdraws it to the FIRST billed
// visit (in billed order) that resolves to a payer (liveThirdPartyPayerForPacket), which can be a visit's own payer
// rather than the account's. Each billed visit is judged by the withdrawal module's own owner answer with the
// pending customer write laid over it. The handler re-checks the set and each invoice's payer under its locks.
async function packetOwner(packetId, pending, { database = db, lock = false } = {}) {
  const packet = await database('visit_completion_packets').where({ id: packetId }).first('visit_id', 'payload');
  if (!packet) return null;
  const payload = require('../visit-completion-packets').packetPayload(packet);
  const billed = Array.isArray(payload?.billingSnapshot?.billedServiceIds) ? payload.billingSnapshot.billedServiceIds
    : await database('visit_completion_packet_items').where({ packet_id: packetId }).pluck('scheduled_service_id');
  const owners = await require('../visit-linked-invoice-withdrawal').visitOwnerTransitions(database, billed, { pending, lock });
  const byVisit = new Map(owners.map((o) => [String(o.visitId), o.afterOwner]));
  for (const visitId of billed) {
    const owner = byVisit.get(String(visitId));
    if (owner != null) return String(owner);
  }
  return null;
}

// The unpaid invoices the handler's withdrawal moves to the payer: the visit-linked ones from the
// withdrawal module's own owner answer (mode 'pre' with the pending customer write), and the unpaid
// self-pay combined-visit invoices whose billed visits will resolve to a payer (packetMoves).
async function invoicePlan(customerId, payerId, ctx = {}) {
  const { database = db, lock = false } = ctx;
  const Linked = require('../visit-linked-invoice-withdrawal');
  const pending = { customerPatch: { customerId, payer_id: payerId } };
  const transitions = await Linked.ownerTransitions(database, { customerId }, { mode: 'pre', pending, stamped: 'unstamped', lock });
  const movingIds = transitions.filter((t) => t.moved && String(t.afterOwner) === String(payerId)).map((t) => String(t.invoiceId));
  const packetRows = await database('invoices').where({ customer_id: customerId }).whereNotIn('status', SETTLED)
    .whereNull('payer_id').whereNotNull('visit_completion_packet_id')
    .where((q) => q.whereNull('scheduled_send_error').orWhereNot('scheduled_send_error', 'like', 'payer_billed:%'))
    .orderBy('id').select('id', 'visit_completion_packet_id');
  // invoice id -> the payer it moves to.
  const ownerOf = new Map(movingIds.map((id) => [id, String(payerId)]));
  for (const row of packetRows) {
    if (ownerOf.has(String(row.id))) continue;
    const owner = await packetOwner(row.visit_completion_packet_id, pending, ctx);
    if (owner) ownerOf.set(String(row.id), owner);
  }
  const moving = ownerOf.size
    ? (await database('invoices').whereIn('id', [...ownerOf.keys()]).orderBy('invoice_number')
      .select('id', 'invoice_number', 'total', 'status', 'credit_applied', 'visit_completion_packet_id'))
      .map((inv) => ({ ...inv, to_payer_id: ownerOf.get(String(inv.id)) }))
    : [];
  // Every other unpaid self-pay invoice stays with the customer: one with no visit link (nothing resolves a payer
  // for it), or one whose visit keeps its own Bill-To (pinned to the customer).
  const movingSet = new Set(moving.map((inv) => String(inv.id)));
  const staying = (await database('invoices').where({ customer_id: customerId }).whereNotIn('status', SETTLED)
    .whereNull('payer_id').whereNull('payer_statement_id')
    .where((q) => q.whereNull('scheduled_send_error').orWhereNot('scheduled_send_error', 'like', 'payer_billed:%'))
    .orderBy('invoice_number').select('id', 'invoice_number', 'total', 'status', 'credit_applied', 'scheduled_service_id'))
    .filter((inv) => !movingSet.has(String(inv.id)));
  return { moving, staying };
}

// Staying invoices the live owner answer would hand to the payer anyway. invoice-payer-ownership.js judges an
// invoice with no payer stamp by its own scheduled_service_id only, so once the customer default is the payer an
// invoice with no direct visit (a manual or project invoice, or one linked through a service record) reads as
// payer-owned while nothing withdrew it and its checkout stays live. Only a direct visit with its own payer or
// pinned self-pay keeps the same owner under the new default.
async function ownerUnsafeStaying(staying, { database = db } = {}) {
  const ids = [...new Set(staying.map((inv) => inv.scheduled_service_id).filter(Boolean).map(String))];
  const cols = ['id', 'payer_id'];
  if (ids.length && await require('../payer').scheduledServicesHasSelfPay(database)) cols.push('self_pay_override');
  const visits = ids.length ? await database('scheduled_services').whereIn('id', ids).select(cols) : [];
  const keeps = new Set(visits.filter((v) => v.payer_id || v.self_pay_override === true).map((v) => String(v.id)));
  return staying.filter((inv) => !inv.scheduled_service_id || !keeps.has(String(inv.scheduled_service_id)));
}

// Upcoming visits that keep their own Bill-To (their own payer, or pinned to the customer).
async function pinnedVisits(customerId, { database = db, lock = false } = {}) {
  const hasSelfPay = await require('../payer').scheduledServicesHasSelfPay(database);
  const q = database('scheduled_services').where({ customer_id: customerId })
    // Every visit that can still bill (not finished, cancelled, skipped or no-show), today's under way included.
    .whereNotIn('status', ['completed', ...require('../invoice-helpers').VISIT_NEVER_RAN_STATUSES])
    .where('scheduled_date', '>=', require('../../utils/datetime-et').etDateString());
  q.where((w) => {
    w.whereNotNull('payer_id');
    if (hasSelfPay) w.orWhere('self_pay_override', true);
  });
  // Under the handler's transaction the visit rows are held FOR SHARE, so a schedule edit to one waits.
  const rows = await (lock ? q.orderBy('id').forShare() : q).select('id');
  return rows.length;
}

const invoiceLine = (inv) => `${inv.invoice_number} ${money(inv.total)} (${inv.status})`;

// A customer who already has a payer: the same payer is a no-op, another one stays on the customer page.
async function hasPayerRefusal(customer, payer, name, ctx) {
  const who = name || 'This customer';
  if (String(customer.payer_id) === String(payer.id)) {
    return refusal(`${who} already bills to ${payerLabel(payer)}. Nothing was changed.`, 'already_set', { customer_id: customer.id });
  }
  const current = await payerRow(customer.payer_id, ctx);
  return toPage(`${who} already bills to ${current ? payerLabel(current) : `payer ${customer.payer_id}`}. The bar sets a payer only on a customer who pays for themselves.`, 'has_payer');
}

// A combined-visit invoice can move to a visit's own payer instead of this one: each line names its payer.
async function payerNames(payer, moving, ctx) {
  const names = new Map([[String(payer.id), payerLabel(payer)]]);
  for (const inv of moving) {
    if (!names.has(inv.to_payer_id)) {
      const other = await payerRow(inv.to_payer_id, ctx);
      names.set(inv.to_payer_id, other ? payerLabel(other) : `payer ${inv.to_payer_id}`);
    }
  }
  return names;
}

// The combined-visit invoices that move: the withdrawal puts each one's visit on billing hold, and for a visit
// whose close already finished it records an office review (one open visit_closeout_review alert).
async function packetEffects(moving, { database = db } = {}) {
  const packetIds = [...new Set(moving.map((inv) => inv.visit_completion_packet_id).filter(Boolean).map(String))];
  if (!packetIds.length) return { held: 0, review: 0 };
  const closed = await database('visit_completion_packets').whereIn('id', packetIds).where({ status: 'done' }).pluck('id');
  const closedSet = new Set(closed.map(String));
  const packetMoving = moving.filter((inv) => inv.visit_completion_packet_id);
  return { held: packetMoving.length, review: packetMoving.filter((inv) => closedSet.has(String(inv.visit_completion_packet_id))).length };
}

const plural = (n, one, many) => (n === 1 ? one : many);

function planEffects({ name, payer, payerName, names, moving, staying, pinned, packets }) {
  const allToThis = moving.every((inv) => inv.to_payer_id === String(payer.id));
  const credit = moving.reduce((sum, inv) => sum + (Number(inv.credit_applied) || 0), 0);
  return [
    { kind: 'billing', text: `New invoices for ${name || 'this customer'} bill to ${payerName}${payer.payment_terms ? ` (terms: ${String(payer.payment_terms).replace(/_/g, ' ')})` : ''}.` },
    payer.tax_exempt ? { kind: 'billing', text: `${payerName} is tax-exempt: invoices billed to it carry no sales tax.` } : null,
    pinned > 0
      ? { kind: 'billing', text: `${pinned} upcoming ${plural(pinned, 'visit keeps its', 'visits keep their')} own Bill-To (a payer of ${plural(pinned, 'its', 'their')} own, or pinned to the customer).` }
      : null,
    moving.length
      ? { kind: 'billing', text: `${plural(moving.length, '1 unpaid invoice moves', `${moving.length} unpaid invoices move`)} to ${allToThis ? payerName : 'a payer (named on each line)'} now. The customer's pay link for ${plural(moving.length, 'it', 'them')} stops working and reminders pause.` }
      : { kind: 'billing', text: 'No unpaid invoice moves to the payer.' },
    // Every moving invoice is listed: Confirm moves all of them.
    ...moving.map((inv) => ({ kind: 'billing', text: `Moves to ${names.get(inv.to_payer_id)}: ${invoiceLine(inv)}` })),
    packets.held > 0
      ? { kind: 'billing', text: `${packets.held} combined-visit ${plural(packets.held, 'invoice moves', 'invoices move')}: ${plural(packets.held, 'its visit goes', 'their visits go')} on billing hold.${packets.review > 0 ? ` ${packets.held === 1 ? 'That visit' : `${packets.review} of those visits`} already closed, so the office gets a visit close-out review alert.` : ''}` }
      : null,
    credit > 0.004 ? { kind: 'billing', text: `${money(credit)} of account credit applied to those invoices goes back to the customer's balance.` } : null,
    staying.length
      ? { kind: 'billing', text: `${staying.length} unpaid ${plural(staying.length, 'invoice stays', 'invoices stay')} billed to the customer (their visit keeps its own Bill-To): ${staying.map(invoiceLine).join(', ')}.` }
      : null,
    { kind: 'billing', text: 'Open pay-page sessions for the invoices that move (combined-visit invoices included), and any combined pay-page session on the customer\'s invoices, are cancelled in Stripe. That cannot be undone. Pay links on the invoices that stay keep working. Nothing is charged or refunded.' },
    { kind: 'comms', text: 'Nothing is sent: no text, email or call goes to the customer or the payer.' },
  ].filter(Boolean);
}

// What the confirm re-checks: every fact the card showed.
function planVersion({ customer, name, payer, payerName, names, moving, staying, pinned, packets }) {
  return {
    customer_id: customer.id,
    customer_name: name,
    payer_before: null,
    payer_after: String(payer.id),
    payer_active: payer.active !== false,
    payer_name: payerName,
    payer_terms: payer.payment_terms || null,
    payer_tax_exempt: payer.tax_exempt === true,
    moving: digest(moving.map((inv) => [String(inv.id), inv.status, String(inv.total), String(inv.credit_applied), inv.to_payer_id, names.get(inv.to_payer_id)])),
    staying: digest(staying.map((inv) => [String(inv.id), inv.status, String(inv.total), String(inv.credit_applied)])),
    pinned,
    packets,
  };
}

async function buildPlan(input, ctx = {}) {
  const { database = db, lock = false } = ctx;
  const customerId = String(input?.customer_id || '').trim().toLowerCase();
  if (!UUID_RE.test(customerId)) return refusal('A valid customer_id is required', 'invalid_target');
  const customer = await database('customers').where({ id: customerId }).whereNull('deleted_at')
    .first('id', 'first_name', 'last_name', 'company_name', 'payer_id');
  if (!customer) return refusal('Customer not found', 'customer_not_found');
  const target = await resolvePayer(input, ctx);
  if (target.error) return target;
  const { payer } = target;
  const name = await customerName(customer);
  if (customer.payer_id) return hasPayerRefusal(customer, payer, name, ctx);
  // The handler's own in-flight fence, read-only here, so no card is offered that the confirm must refuse.
  // (Inside the handler's transaction the handler already ran it on the locked rows.)
  if (!lock && await require('../visit-completion-packets').packetInvoiceSendInFlight({ customerId: customer.id }, database,
    { pending: { customerPatch: { customerId: customer.id, payer_id: String(payer.id) } } })) {
    return refusal('A combined-visit invoice for this customer is being sent or paid right now, so nothing was offered. Ask again in a moment.', 'invoice_send_in_flight');
  }
  // Any self-pay invoice with a payment processing: the card leaves processing invoices out (SETTLED), yet the packet
  // withdrawal would still move a combined-visit one, and a manual one's live owner would turn to the payer unmoved
  // (if the debit then fails it is collectible again with no payer stamp). Refuse until it settles or fails.
  const processing = await database('invoices').where({ customer_id: customer.id, status: 'processing' })
    .whereNull('payer_id').whereNull('payer_statement_id')
    .where((q) => q.whereNull('scheduled_send_error').orWhereNot('scheduled_send_error', 'like', 'payer_billed:%'))
    .first('invoice_number');
  if (processing) {
    return refusal(`Invoice ${processing.invoice_number} has a payment processing, so nothing was offered. Ask again once it settles or fails.`, 'invoice_payment_processing');
  }
  const { moving, staying } = await invoicePlan(customer.id, String(payer.id), ctx);
  const unsafe = await ownerUnsafeStaying(staying, ctx);
  if (unsafe.length) {
    const list = unsafe.slice(0, 5).map((inv) => inv.invoice_number).join(', ');
    return refusal(`${plural(unsafe.length, '1 unpaid invoice', `${unsafe.length} unpaid invoices`)} of ${name || 'this customer'} (${list}${unsafe.length > 5 ? ', …' : ''}) ${plural(unsafe.length, 'has', 'have')} no visit of ${plural(unsafe.length, 'its', 'their')} own that keeps the customer as payer: after this change ${plural(unsafe.length, 'it', 'they')} would count as the payer's without moving, and ${plural(unsafe.length, 'its', 'their')} pay link would stay live. Nothing was offered. Collect, void or re-bill ${plural(unsafe.length, 'it', 'them')} first.`, 'unmovable_invoices', { invoices: unsafe.map((inv) => inv.invoice_number) });
  }
  const pinned = await pinnedVisits(customer.id, ctx);
  const packets = await packetEffects(moving, ctx);
  const payerName = payerLabel(payer);
  const names = await payerNames(payer, moving, ctx);
  const facts = { customer, name, payer, payerName, names, moving, staying, pinned, packets };
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
    effects: planEffects(facts),
    sends_to_customer: false,
    // Every invoice the card listed, for the handler's after-withdrawal check: the moving ones (with the payer
    // each moves to) must be exactly the ones withdrawn, each stamped for that payer.
    _invoices: [
      ...moving.map((inv) => ({ id: String(inv.id), status: inv.status, total: inv.total, credit_applied: inv.credit_applied, to_payer_id: inv.to_payer_id })),
      ...staying.map((inv) => ({ id: String(inv.id), status: inv.status, total: inv.total, credit_applied: inv.credit_applied, to_payer_id: null })),
    ],
    _version: planVersion(facts),
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

// The whole card re-derived INSIDE the handler's transaction, before it writes: the customer row is already held
// FOR UPDATE there; this pass holds the visits and payers the card reads FOR SHARE, then every unpaid invoice of
// the customer FOR UPDATE (id order), and derives the card again over those held rows. Any line that differs
// from the card the operator approved refuses as preview_changed and rolls the edit back before any Stripe cancel.
function lockedPlanCheck(input, pinned) {
  return async (trx) => {
    const ctx = { database: trx, lock: true };
    await buildPlan(input, ctx);
    await trx('invoices').where({ customer_id: input.customer_id }).whereNotIn('status', SETTLED).orderBy('id').forUpdate().select('id');
    const plan = await buildPlan(input, ctx);
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
  const n = plan.invoices_moving.length;
  return { ...base, success: true, sent_to_customer: false,
    note: `${plan.customer_name || 'The customer'} now bills to ${plan.payer_name}. ${n} unpaid ${plural(n, 'invoice', 'invoices')} moved to the payer. Nothing was sent to anyone.` };
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
      expectedInvoices: plan._invoices,
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
