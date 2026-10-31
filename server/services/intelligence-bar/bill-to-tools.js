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
 * IB gap #19 (2026-10-31, "set bill-to payer on customer account for invoices": the payer did not exist yet): the
 * card can also ADD the payer first, as the customer page's "New payer" form does (Create & select: POST
 * /admin/payers with the name, company, AP email and phone, deduped by AP email, then the same Bill-To save). An AP
 * email that an active payer already holds uses that payer instead of adding a duplicate; a deactivated one refuses.
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
 * A new payer is written on Confirm only, after the card's re-check and before the Bill-To save, outside that save's
 * transaction (the page does the same two calls). If the save then refuses, the payer stays in Finance -> Payers and
 * the result says so; asking again finds it by name or AP email instead of adding another.
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
Refused with the reason: customer not found, payer not found or inactive, the customer already has a payer, or the customer has unpaid invoices or an open checkout (use the customer page Bill-To select: it moves those invoices to the payer). Admin only.
Give exactly one of: payer_id; payer_name (matched against active payers; it must match exactly one); or new_payer_name when the payer is not set up yet. With new_payer_name, also pass new_payer_company, new_payer_email (where its invoices are emailed) and new_payer_phone when known; ask for the invoice email if the operator did not give one, because without it the payer's invoices cannot be delivered. The confirmed card adds the payer (terms: due on receipt), as the customer page's "New payer" form does, then sets it. An invoice email that an active payer already has uses that payer instead; a same-named payer is refused so you can pass its payer_id. Find a customer with query_customers first.
Use for: "bill this customer to <payer>", "set the Bill-To to <payer>", "invoices for this account go to <property manager>", "make <payer> the payer on this account and future appointments", "bill <person> instead, they are not a payer yet", "add <property manager> as the payer".`,
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', format: 'uuid', description: 'The customer (from query_customers or get_customer_detail)' },
        payer_id: { type: 'string', description: 'The payer id (use instead of payer_name)' },
        payer_name: { type: 'string', description: 'The payer name or company, e.g. "Sunrise Property Management" (use instead of payer_id)' },
        new_payer_name: { type: 'string', description: 'A payer that does not exist yet: its name, e.g. a property manager or a boss (use instead of payer_id and payer_name)' },
        new_payer_company: { type: 'string', description: 'With new_payer_name: the company, if any' },
        new_payer_email: { type: 'string', description: 'With new_payer_name: the email its invoices go to (AP email)' },
        new_payer_phone: { type: 'string', description: 'With new_payer_name: a phone number, if known' },
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

// The terms a payer added from the card gets: the payers table default, passed explicitly so the card's line is true.
const NEW_PAYER_TERMS = 'due_on_receipt';
const NEW_PAYER_FIELDS = ['new_payer_company', 'new_payer_email', 'new_payer_phone'];

// A payer the card would add (the page's "New payer" form fields), normalized as the create will store them. An AP
// email an active payer already holds resolves to that payer (the form's dedupeByEmail); a deactivated one, or an
// active payer with the same name or company, refuses rather than adding a second row for the same party.
async function resolveNewPayer(input) {
  const Payers = require('../payer');
  const { dbUpdates, error } = Payers.buildPayerWrite({
    display_name: input.new_payer_name,
    company_name: input.new_payer_company,
    ap_email: input.new_payer_email,
    ap_phone: input.new_payer_phone,
  });
  if (error) return refusal(error === 'Invalid AP email' ? `"${String(input.new_payer_email).trim()}" is not a valid invoice email.` : error, 'invalid_payer');
  const fields = { display_name: dbUpdates.display_name, company_name: dbUpdates.company_name, ap_email: dbUpdates.ap_email, ap_phone: dbUpdates.ap_phone };
  const { emailHolders, sameName } = await existingPayers(fields);
  const active = emailHolders.find((p) => p.active !== false);
  if (active) return { payer: active, matchedEmail: fields.ap_email };
  if (emailHolders.length) return refusal(`A deactivated payer already uses ${fields.ap_email}, so nothing was offered. Reactivate or edit it in Finance → Payers.`, 'payer_inactive');
  if (sameName.length) {
    return refusal(`An active payer named ${payerLabel(sameName[0])} already exists. Ask whether to use it (or which one, if candidates lists more), then pass its payer_id.`, 'payer_exists', {
      candidates: sameName.slice(0, 5).map((p) => ({ payer_id: String(p.id), name: payerLabel(p) })),
    });
  }
  return { payer: { ...fields, active: true, payment_terms: NEW_PAYER_TERMS, tax_exempt: false }, isNew: true };
}

const payerNameKeys = (fields) => [...new Set([fields.display_name, fields.company_name].filter(Boolean).map((n) => n.toLowerCase()))];

// The payers a new one would duplicate: every row holding its AP email (the form's dedupe), and every ACTIVE payer
// whose trimmed, case-blind name or company equals its name or company (read directly, so no search limit hides one).
async function existingPayers(fields, database = db) {
  const emailHolders = fields.ap_email
    ? await database('payers').whereRaw('LOWER(ap_email) = ?', [fields.ap_email]).orderBy('id', 'asc')
    : [];
  const names = payerNameKeys(fields);
  const marks = names.map(() => '?').join(', ');
  const sameName = await database('payers').where('active', true)
    .where((w) => w.whereRaw(`LOWER(TRIM(display_name)) IN (${marks})`, names).orWhereRaw(`LOWER(TRIM(COALESCE(company_name, ''))) IN (${marks})`, names))
    .orderBy('id', 'asc').limit(6);
  return { emailHolders, sameName };
}

async function resolvePayer(input, ctx = {}) {
  const rawId = String(input?.payer_id || '').trim();
  const rawName = String(input?.payer_name || '').trim();
  const rawNew = String(input?.new_payer_name || '').trim();
  if ([rawId, rawName, rawNew].filter(Boolean).length !== 1) return refusal('Give exactly one of payer_id, payer_name or new_payer_name', 'invalid_target');
  if (!rawNew && NEW_PAYER_FIELDS.some((k) => String(input?.[k] || '').trim())) {
    return refusal('new_payer_company, new_payer_email and new_payer_phone go only with new_payer_name', 'invalid_target');
  }
  if (rawNew) return resolveNewPayer(input);
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
  if (!pick.length) return refusal(`No active payer matches "${rawName}". To add it as a new payer, call again with new_payer_name (and new_payer_email for its invoices).`, 'payer_not_found');
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
// candidate set).
async function openInvoices(customerId, { database = db, lock = false } = {}) {
  // Under the lock EVERY open invoice row is held (a payer-owned one too), so no checkout can be stamped on one
  // between this check and the handler's Bill-To steps.
  const rows = await (lock ? database('invoices').where({ customer_id: customerId }).whereNotIn('status', CLOSED).orderBy('id').forUpdate()
    : database('invoices').where({ customer_id: customerId }).whereNotIn('status', CLOSED).orderBy('id'))
    .select('id', 'invoice_number', 'total', 'status', 'payer_id', 'stripe_payment_intent_id');
  return rows.filter((r) => r.payer_id == null || r.stripe_payment_intent_id != null);
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

function planEffects({ name, payer, payerName, pinned, isNew, matchedEmail }) {
  return [
    isNew ? { kind: 'billing', text: `Adds a new payer: ${payerName}. Invoice email: ${payer.ap_email || 'none'}${payer.ap_phone ? `. Phone: ${payer.ap_phone}` : ''}.` } : null,
    isNew && !payer.ap_email
      ? { kind: 'billing', text: `${payerName} has no invoice email, so its invoices cannot be delivered until one is added in Finance → Payers.` }
      : null,
    matchedEmail ? { kind: 'billing', text: `No new payer is added: ${matchedEmail} already belongs to the payer ${payerName}, so this card uses it.` } : null,
    { kind: 'billing', text: `New invoices for ${name || 'this customer'} bill to ${payerName}${payer.payment_terms ? ` (terms: ${String(payer.payment_terms).replace(/_/g, ' ')})` : ''}.` },
    payer.tax_exempt ? { kind: 'billing', text: `${payerName} is tax-exempt: invoices billed to it carry no sales tax.` } : null,
    pinned > 0
      ? { kind: 'billing', text: `${pinned} upcoming ${plural(pinned, 'visit keeps its', 'visits keep their')} own Bill-To (a payer of ${plural(pinned, 'its', 'their')} own, or pinned to the customer).` }
      : null,
    { kind: 'billing', text: 'No existing invoice changes hands: the customer has no unpaid invoice billed to them and no open checkout. Nothing is charged, refunded or cancelled.' },
    { kind: 'billing', text: `To undo, set Bill-To back to the customer on the customer page.${isNew ? ' The new payer stays in Finance → Payers.' : ''}` },
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
  const { payer, isNew = false, matchedEmail = null } = target;
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
    payer_id: isNew ? null : String(payer.id),
    payer_name: payerName,
    payer_new: isNew,
    effects: planEffects({ name, payer, payerName, pinned, isNew, matchedEmail }),
    sends_to_customer: false,
    // What the confirm re-checks: every fact the card showed (for a new payer, every field it adds).
    _version: {
      ...billToVersion({ customer, name, payer, payerAfter: isNew ? 'new' : String(payer.id), pinned }),
      ...(isNew ? { new_payer: { display_name: payer.display_name, company_name: payer.company_name, ap_email: payer.ap_email, ap_phone: payer.ap_phone } } : {}),
    },
    note: isNew
      ? 'PREVIEW ONLY — nothing was changed. Confirm adds exactly this payer and sets it as the Bill-To; if anything changed it refuses.'
      : 'PREVIEW ONLY — nothing was changed. Confirm sets exactly this Bill-To; if anything changed it refuses.',
  };
}

// The facts a card pins. One builder for both the card and the payer a confirmed card added, so a re-check of the
// added payer compares like with like.
function billToVersion({ customer, name, payer, payerAfter, pinned }) {
  return {
    customer_id: customer.id,
    customer_name: name,
    payer_before: null,
    payer_after: payerAfter,
    payer_active: payer.active !== false,
    payer_name: payerLabel(payer),
    payer_terms: payer.payment_terms || null,
    payer_tax_exempt: payer.tax_exempt === true,
    payer_ap_email: payer.ap_email || null,
    payer_ap_phone: payer.ap_phone || null,
    pinned,
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
  // previewChanged: the checkout-session release found a session after the card promised none (pay-combined.js).
  if (err?.code === 'preview_changed' || err?.previewChanged === true) {
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

// Adds the payer a confirmed card showed, as the page's "New payer" form does, in one transaction: transaction
// advisory locks on the AP email (the same key payer.js findOrCreatePayerByEmail takes, so the page's quick-add and
// the call pipeline wait for it) and on each name, taken in sorted order; then the duplicate checks again, then the
// insert. A payer that took the email or the name since the card refuses, and nothing is written.
async function addCardPayer(fields) {
  const { dbUpdates, error } = require('../payer').buildPayerWrite({ ...fields, payment_terms: NEW_PAYER_TERMS });
  if (error) return { refusal: { error: `The new payer was not added, so nothing was changed: ${error}`, code: 'payer_not_added' } };
  return db.transaction(async (trx) => {
    const keys = [...(fields.ap_email ? [fields.ap_email] : []), ...payerNameKeys(fields).map((n) => `ib-bill-to-payer-name:${n}`)].sort();
    for (const key of keys) await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [key]);
    const { emailHolders, sameName } = await existingPayers(fields, trx);
    if (emailHolders.length || sameName.length) {
      return { refusal: { error: 'A payer with this invoice email or name was added after the card was shown, so nothing was changed. Ask again for a fresh confirmation card.', code: 'preview_changed', preview_changed: true } };
    }
    const [payer] = await trx('payers').insert(dbUpdates).returning('*');
    return { payer };
  });
}

// The card's pin restated for the payer it just added; null when the stored row is not the payer the card showed.
function addedPayerVersion(version, payer) {
  const { new_payer: _shown, ...card } = version;
  const added = billToVersion({ customer: { id: card.customer_id }, name: card.customer_name, payer, payerAfter: String(payer.id), pinned: card.pinned });
  return ['payer_active', 'payer_name', 'payer_terms', 'payer_tax_exempt', 'payer_ap_email', 'payer_ap_phone'].every((k) => added[k] === card[k]) ? added : null;
}

// A result after the card added a payer: say so, since setting Bill-To back does not remove it.
function withAddedPayer(result, plan) {
  if (result.success) {
    return { ...result, payer_created: true, note: result.warning ? `Added the payer ${plan.payer_name}. ${result.note}`
      : `Added the payer ${plan.payer_name}, and ${plan.customer_name || 'the customer'} now bills to it. No existing invoice moved. Nothing was sent to anyone.` };
  }
  return { ...result, payer_created: true, error: `${result.error} The payer ${plan.payer_name} was added (payer_id ${plan.payer_id}) and stays in Finance → Payers; ask again with that payer_id to set it.` };
}

async function commitBillTo(input, actionContext) {
  const { plan: shown, refusal: refused } = await verifiedPlan(input, input._verified_bill_to_version);
  if (refused) return refused;
  let plan = shown;
  let pinned = shown._version;
  if (shown.payer_new) {
    const { payer, refusal: notAdded } = await addCardPayer(shown._version.new_payer);
    if (notAdded) return notAdded;
    logger.info(`[intelligence-bar:bill-to] added payer ${payer.id} for customer ${shown.customer_id}`);
    plan = { ...shown, payer_id: String(payer.id) };
    pinned = addedPayerVersion(shown._version, payer);
    if (!pinned) {
      return withAddedPayer({ customer_id: plan.customer_id, payer_id: plan.payer_id, failed: true, code: 'preview_changed', preview_changed: true,
        error: 'The added payer does not read as the card showed, so the Bill-To was not changed. Check Finance → Payers.' }, plan);
    }
  }
  const base = { customer_id: plan.customer_id, payer_id: plan.payer_id };
  let result;
  try {
    result = await require('../../routes/admin-customers').setCustomerBillToFromBar({
      customerId: plan.customer_id,
      payerId: plan.payer_id,
      expectedPayerId: null,
      verifyPlan: lockedPlanCheck({ customer_id: plan.customer_id, payer_id: plan.payer_id }, pinned),
      actor: { technicianId: actionContext?.technicianId || null },
    });
  } catch (err) {
    const failed = await handlerErrorResult(err, plan, base);
    return shown.payer_new ? withAddedPayer(failed, plan) : failed;
  }
  const done = await handlerReplyResult(result, plan, base);
  return shown.payer_new ? withAddedPayer(done, plan) : done;
}

// ── card lines (authorization-contract.js) ──────────────────────

function cardLines(toolName, preview) {
  if (toolName !== 'set_customer_bill_to' || !preview || preview.preview !== true) return [];
  return [
    { kind: 'billing', text: `Bill-To for ${preview.customer_name || preview.customer_id}: ${preview.bill_to_now} → ${preview.payer_name}${preview.payer_new ? ' (new payer)' : ''}` },
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
