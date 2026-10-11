/**
 * Intelligence Bar — send an EXISTING invoice
 * server/services/intelligence-bar/invoice-action-tools.js
 *
 * Owner ruling 2026-10-07 (Q1): "Yes, limited — only an existing invoice; admin only." No invoice creation,
 * no amount edit, no charge, no refund, no void.
 *
 *   send_invoice — the Invoices page "Send" (POST /admin/invoices/:id/send),
 *                  run through admin-invoices.js sendInvoiceFromBar: the same
 *                  handler, so every refusal and message is the route's own.
 *
 * Always a confirm card (write-gates.js two-step), admin only, never owner-direct, dark behind
 * GATE_IB_INVOICE_ACTIONS.
 *
 *   unconfirmed -> a PREVIEW: nothing is sent. Its `_version` pins what the card showed (invoice
 *                  state, recipients, total, attachments, the invoice's own copy, every effect).
 *   confirmed   -> re-derives the preview and refuses with preview_changed on any drift, then calls
 *                  the route's handler. The send claim re-checks the pin on the claimed row (edit
 *                  time, amount due and lines, the effects list, who owes the invoice) before any
 *                  provider is called.
 *
 * Who owes it: the bar sends only an invoice that is the customer's own. The check is the live
 * payer-ownership resolver (invoice-payer-ownership.js), not the payer columns on the invoice, which
 * are a snapshot taken when it was minted. It runs when the card is built and again under the send
 * claim; an answer that cannot be verified refuses (fail closed).
 *
 * Effects: everything the send also does (lead conversion, billing reminders, the visit closeout,
 * review outreach ...) is ONE list from invoice-action-effects.js, built from the handler's own
 * predicates. The card shows each effect, `_version.effects` pins the list's digest, and the send
 * claim recomputes it and refuses on any difference. The visit the card said would close (or none)
 * is also handed to the closeout itself, and written on the invoice at claim time so the retry
 * sweep keeps to it (invoice-issued-closeout.js).
 *
 * Results carry ids, states and reasons; recipients stay masked.
 */
const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const { UUID_RE } = require('./task-context');
const { maskEmail, maskPhone } = require('./closeout-repair-tools');
const { assertInvoiceCollectible, invoiceAmountDue, neverRanVisitStatus, approvedInvoiceVersionDigest, digestOfFingerprint } = require('../invoice-helpers');
const { planSendEffects, approvedCloseoutTarget, approvedLeadTargets } = require('./invoice-action-effects');

const CARD_LINES_SHOWN = 4;

function invoiceActionsLive() {
  return require('../../config/feature-gates').ibInvoiceActionsLive() === true;
}

const TARGET_PROPS = {
  invoice_id: { type: 'string', format: 'uuid', description: 'The existing invoice (from get_customer_invoices)' },
  invoice_number: { type: 'string', description: 'The invoice number, e.g. WPC-2026-0534 (use instead of invoice_id)' },
};

const INVOICE_ACTION_TOOLS = [
  {
    name: 'send_invoice',
    description: `Send ONE existing invoice to the customer, exactly as the Invoices page "Send" button does (text with the pay link and/or the invoice email with the PDF). The first call returns a PREVIEW and sends nothing: the invoice, the customer, the amount due, the lines, the channels and who each reaches (masked), and which message goes out. The operator approves on the confirmation card; the confirmed run re-checks all of it, refuses if anything changed, and reports the text and the email separately.
Refused with the reason: invoice not found, paid, prepaid, void, refunded, canceled, a bank payment processing, billed to a third-party payer or a payer's monthly statement (or who owes it could not be checked), nothing due, a collections hold on the customer's billing messages, no phone or email on file. Never creates, edits, voids or refunds an invoice. No review request is sent. Admin only.
Takes invoice_id OR invoice_number, exactly one.
Use for: "send the invoice", "text her the invoice", "resend invoice WPC-2026-0534".`,
    input_schema: { type: 'object', properties: { ...TARGET_PROPS } },
    _sideEffects: true,
  },
];

const money = (cents) => `$${(Math.round(Number(cents) || 0) / 100).toFixed(2)}`;
const toCents = (value) => Math.round((Number(value) || 0) * 100);
const msOf = (value) => (value ? new Date(value).getTime() : null);
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
const refusal = (error, code, extra = {}) => ({ error, code, ...extra });

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

async function customerName(customerId) {
  const c = await db('customers').where({ id: customerId }).first('first_name', 'last_name', 'company_name');
  return [c?.first_name, c?.last_name].filter(Boolean).join(' ') || c?.company_name || null;
}

// Every line, "description amount": the card shows the first few and the rest under its
// "Show more" (cardLines); the lines are hashed into the approval, so the operator approves all of them.
function lineSummary(raw) {
  let items = raw;
  if (typeof items === 'string') { try { items = JSON.parse(items); } catch { items = []; } }
  if (!Array.isArray(items)) items = [];
  return items.map((it) => {
    const label = String(it?.description || it?.name || 'Line').replace(/\s+/g, ' ').trim();
    const amount = it?.amount ?? (Number(it?.quantity || 1) * Number(it?.unit_price || 0));
    return `${label} ${money(toCents(amount))}`;
  });
}

// The route's own refusals for a row the Invoices page cannot collect
// (invoice-helpers.assertInvoiceCollectible), as a plain refusal.
function collectibleRefusal(invoice) {
  try { assertInvoiceCollectible(invoice); return null; } catch (err) { return refusal(err.message, 'invoice_not_collectible', { invoice_id: invoice.id }); }
}

// A send reads the messaging predicate (any hold), the same one the invoice senders use.
async function messagingHold(customerId) {
  return require('../collections/collection-hold').customerHasActiveMessagingHoldChecked(customerId);
}

// The effects plan, or the refusal when its reads fail (fail closed: an unchecked effect is never shown as absent).
async function planEffectsOrRefuse(run, invoice, whatFailed) {
  try {
    return await run();
  } catch {
    return refusal(`This invoice cannot be ${whatFailed} from the bar right now: what it would also do could not be checked.`, 'effects_check_failed', { invoice_id: invoice.id });
  }
}

// The plan's effects as card lines (the card shows each one; effects with nothing to say are pinned only).
const cardEffects = (effects) => effects.filter((e) => e.line).map(({ key, line, kind }) => ({ key, text: line, kind }));

// ── send_invoice ────────────────────────────────────────────────

// The invoice's own words that reach the customer: the email's personal message (invoices.email_message) and the notes
// printed on the invoice and PDF (invoices.notes). The card quotes both in full; a longer text is refused, never cut.
const CUSTOM_COPY_LIMIT = 600;
function customerCopy(invoice) {
  const message = String(invoice.email_message || '').trim();
  const notes = String(invoice.notes || '').trim();
  if (message.length > CUSTOM_COPY_LIMIT || notes.length > CUSTOM_COPY_LIMIT) {
    return refusal(`The invoice message is longer than the card can show (${CUSTOM_COPY_LIMIT} characters); send it from the Invoices page.`, 'invoice_copy_too_long', { invoice_id: invoice.id });
  }
  const lines = [
    message && `Personal message in the email: "${message}"`,
    notes && `Notes on the invoice and PDF: "${notes}"`,
  ].filter(Boolean);
  return { lines: lines.length ? lines : ['No personal message. No notes.'] };
}

const TEXT_MESSAGE = 'the invoice text (template invoice_sent, or its pre-service or annual-prepay variant when that applies) with the pay link';

// Who owes the invoice RIGHT NOW. invoices.payer_id / payer_statement_id are a snapshot from when the invoice was
// minted: a payer assigned afterwards (the scheduled service, or the customer's default payer) leaves both empty. The
// canonical resolver (invoice-payer-ownership.js) reads the stamps and the live Bill-To. Only a verified customer-owned
// invoice is sent; a payer-owned one, or an answer that cannot be verified, is refused (fail closed). Returns the refusal
// text, or null. Also run by the send claim (verifyOwner below), on the claimed row.
const PAYER_OWNED_TEXT = 'This invoice is billed to a payer, not the customer. Send it from the Invoices page.';
const OWNER_UNVERIFIED_TEXT = 'The bar could not verify who owes this invoice, so it was not sent. Send it from the Invoices page.';
async function ownerRefusalText(invoice, database = db) {
  let verdict;
  try {
    verdict = await require('../invoice-payer-ownership').invoicePayerOwnership(invoice, database);
  } catch {
    verdict = 'payer_unverifiable';
  }
  if (verdict === null) return null;
  return verdict === 'payer_owned' ? PAYER_OWNED_TEXT : OWNER_UNVERIFIED_TEXT;
}

// An annual-plan invoice's send re-enters under the renewal gate, which the bar does not carry. The plan is found the way the
// pay page finds it (invoice-prepay.js resolveInvoiceTermId: the invoice's own tag, else its visit's term when this invoice is
// the term's anchor), so an anchor with no tag is still refused. A lookup that fails refuses too. Also run by the send claim.
const ANNUAL_PLAN_TEXT = 'This is an annual-plan invoice. Send it from the Invoices page.';
const ANNUAL_PLAN_UNVERIFIED_TEXT = 'The bar could not verify whether this is an annual-plan invoice, so it was not sent. Send it from the Invoices page.';
async function annualPlanRefusalText(invoice, database = db) {
  try {
    return (await require('../invoice-prepay').resolveInvoiceTermId(invoice, database, { strict: true })) ? ANNUAL_PLAN_TEXT : null;
  } catch {
    return ANNUAL_PLAN_UNVERIFIED_TEXT;
  }
}

// The send refusals the bar checks before reading recipients (the route's own
// text where the route has one), or null.
async function sendRefusal(invoice, dueCents) {
  const notCollectible = collectibleRefusal(invoice);
  if (notCollectible) return notCollectible;
  const at = { invoice_id: invoice.id };
  if (invoice.payer_statement_id) return refusal('Invoice is billed on the payer’s monthly statement; not sent individually.', 'payer_statement', at);
  const ownerText = await ownerRefusalText(invoice);
  if (ownerText) return refusal(ownerText, 'payer_owned', at);
  if (dueCents <= 0) return refusal('Nothing is due on this invoice, so there is no pay link to send.', 'nothing_due', at);
  // An annual-plan invoice's send re-enters under the renewal gate, which does not
  // carry the bar's approved total or its no-credit rule: it stays on the Invoices page.
  const planText = await annualPlanRefusalText(invoice);
  if (planText) return refusal(planText, 'annual_plan_invoice', at);
  // A linked visit that never ran: the route's own refusal text. (If it is cancelled
  // after this check, the send refuses under its claim and never voids for the bar.)
  const visitId = await require('../invoice').linkedScheduledServiceId(invoice, db);
  const visit = visitId ? await db('scheduled_services').where({ id: visitId }).first('status') : null;
  const terminal = neverRanVisitStatus(visit?.status);
  if (terminal) {
    return refusal(`Linked visit is ${terminal}; delivery not attempted. Void or keep this invoice from the Invoices page.`, 'visit_terminal', at);
  }
  if (await messagingHold(invoice.customer_id)) {
    return refusal('This customer has a collections hold on billing messages. Send this invoice from the Invoices page if you mean to override it.', 'collection_hold', at);
  }
  return null;
}

// The same recipients the Invoices page shows before Send (GET /:id/recipients):
// the text goes to the customer's phone, the email to the billing recipient.
function sendLegs(who, invoice, dueCents) {
  const phone = who.primaryContact?.phone || null;
  const email = who.emailRecipient?.email ? String(who.emailRecipient.email).trim().toLowerCase() : null;
  const text = phone
    ? `Text to ${maskPhone(phone)}: ${TEXT_MESSAGE}. Not sent if the customer opted out of texts.`
    : 'No text: no phone on file.';
  const subject = `Invoice ${invoice.invoice_number} — ${money(dueCents)}`;
  const emailLine = email
    ? `Email to ${maskEmail(email)}: the invoice email (template invoice.sent), subject "${subject}", with the invoice PDF and the pay link. The email carries the invoice only (no other-balance or account details).`
    : 'No email: no billing email on file.';
  return { phone, email, text, emailLine };
}

function emailContentGates() {
  const gates = require('../../config/feature-gates');
  return `${gates.isEnabled('balanceVisibility') ? 1 : 0}${gates.billingEmailDetailsLive() ? 1 : 0}`;
}

// opts.forSend: the confirmed run also gets the exact recipients (never on the
// card or in a model-visible result) to hand the send as its approved pins.
async function buildSendPlan(input, { forSend = false } = {}) {
  const target = await resolveInvoice(input);
  if (target.error) return target;
  const { invoice } = target;
  const dueCents = toCents(invoiceAmountDue(invoice));
  const refused = await sendRefusal(invoice, dueCents);
  if (refused) return refused;
  const who = await require('../../routes/admin-invoices').getInvoiceDeliveryRecipients(invoice.id);
  if (!who) return refusal('Invoice not found', 'invoice_not_found');
  const legs = sendLegs(who, invoice, dueCents);
  if (!legs.phone && !legs.email) return refusal('No phone or email is on file for this invoice, so it cannot be sent.', 'no_recipient', { invoice_id: invoice.id });
  const copy = customerCopy(invoice);
  if (copy.error) return copy;
  const totalCents = toCents(invoice.total);
  // Everything the send also does after it delivers: one list, from the handler's own predicates.
  const customer = await db('customers').where({ id: invoice.customer_id }).first();
  const planned = await planEffectsOrRefuse(() => planSendEffects(invoice, customer, { requestReview: false }), invoice, 'sent');
  if (planned.error) return planned;
  const recipients = { phone: legs.phone ? String(legs.phone).replace(/\D/g, '') : null, email: legs.email };
  return {
    ...(forSend ? { sendRecipients: recipients } : {}),
    preview: true,
    tool: 'send_invoice',
    invoice_id: invoice.id,
    invoice_number: invoice.invoice_number,
    customer_id: invoice.customer_id,
    customer_name: who.customerName || await customerName(invoice.customer_id),
    status: invoice.status,
    amount_due: money(dueCents),
    total: money(totalCents),
    lines: lineSummary(invoice.line_items),
    channels: [legs.phone && 'text', legs.email && 'email'].filter(Boolean).join(' and '),
    text: legs.text,
    email: legs.emailLine,
    // The operator's own words that reach the customer, verbatim (the email and the PDF render them).
    custom_copy: copy.lines,
    effects: cardEffects(planned.effects),
    // The delivery effect's sentence, for the confirmation card's summary.
    send_note: planned.effects.find((e) => e.key === 'delivery').line,
    // The visit the closeout effect named (or 'none'). Kept out of the approval fingerprint (`_` key): the effects digest in
    // _version already pins the closeout's state, and the confirmed run hands the send this re-derived target.
    _closeout_target: approvedCloseoutTarget(planned.effects),
    _lead_targets: approvedLeadTargets(planned.effects),
    _version: {
      invoice_id: invoice.id,
      status: invoice.status,
      total_cents: totalCents,
      due_cents: dueCents,
      invoice_version: msOf(invoice.updated_at),
      // Amount due, credit and lines: the claim refuses a row that no longer matches.
      version_digest: approvedInvoiceVersionDigest(invoice),
      sent: msOf(invoice.sent_at),
      first_delivery: planned.effects.find((e) => e.key === 'delivery').state === 'first',
      // Every post-delivery effect (closeout, lead, reminders, review ...): a change is drift.
      effects: planned.digest,
      // The attachment list as the email handoff re-checks it (the same files the attachments effect pins).
      attachments: digestOfFingerprint(planned.effects.find((e) => e.key === 'attachments').state),
      recipients: digest(recipients),
      // The two gates that add live content to the page's email (other-balance note; service, address and payment-method
      // details). The bar's email omits both, so a flip changes nothing it sends; it is pinned so the card never goes stale on it.
      email_content_gates: emailContentGates(),
    },
    note: 'PREVIEW ONLY — nothing was sent. Confirm sends exactly this; if anything changed it refuses.',
  };
}

function channelResult(leg) {
  if (!leg) return { status: 'not_sent', detail: 'not attempted' };
  if (leg.ok) return { status: 'sent', ...(leg.warning ? { warning: String(leg.warning).slice(0, 200) } : {}) };
  // The provider may have taken it: never reported as not sent (a resend could duplicate it).
  if (leg.deliveryOutcome === 'uncertain') {
    return { status: 'unknown', detail: 'the provider did not confirm — it may or may not have gone out; check before sending again' };
  }
  return { status: 'not_sent', detail: String(leg.error || leg.code || 'not sent').slice(0, 160) };
}

// Route codes that mean a leg may have been delivered.
const UNCERTAIN_SEND_CODES = new Set(['INVOICE_DELIVERY_OUTCOME_UNCERTAIN', 'INVOICE_VISIT_TERMINAL_OUTCOME_UNCERTAIN']);

// The re-derived plan when it still matches the card's pin, or the refusal.
async function verifiedPlan(input, pinned, build, { what, changed }) {
  if (!pinned) return { refusal: refusal(`Use the confirmation card to approve this ${what}.`, 'approval_required') };
  const plan = await build(input, { forSend: true });
  if (plan.error) return { refusal: { error: `${changed}: ${plan.error}`, code: plan.code, ...(plan.code === 'charge_limit' ? { blocked: true } : { preview_changed: true }) } };
  if (JSON.stringify(plan._version) !== JSON.stringify(pinned)) {
    return { refusal: { error: `What this ${what} would do changed after the card was shown — ${changed.toLowerCase()}. Ask again for a fresh confirmation card.`, preview_changed: true } };
  }
  return { plan };
}

// 409s from the Send handler that happen before any claim (nothing in flight anywhere).
const DEFINITIVE_SEND_CONFLICT_CODES = new Set(['deposit_settlement_pending', 'balance_changed_retry', 'INVOICE_VISIT_TERMINAL_UNVOIDED']);
const IN_PROGRESS_SEND_MESSAGE = 'Another send of this invoice is in progress, so this one sent nothing. It may or may not have gone out yet: check the invoice page before sending again.';

// A send reply the route answered without delivering anything new (status 200).
const NOOP_SEND_KEYS = ['already_delivered', 'queued_delivery', 'covered_by_credit', 'settled_zero_due'];

// The Send handler's reply, in the tool's words: the first matching rule answers. Each rule is [applies, answer]
// over c = { base, status, json, text, email, unknown, sent }.
const SEND_OUTCOME_RULES = [
  // The route's own pre-delivery refusals (nothing claimed, nothing sent): a fresh card is fine.
  [(c) => c.status === 409 && DEFINITIVE_SEND_CONFLICT_CODES.has(c.json.code),
    (c) => ({ ...c.base, error: `Nothing was sent: ${c.json.error || 'the invoice is busy'}`, code: c.json.code, preview_changed: true })],
  // Any other conflict means another request owns the live send claim: that delivery may still finish.
  // Uncertain and not retryable, no fresh card (a retry could send it twice).
  [(c) => c.status === 409 || c.json.in_progress,
    (c) => ({ ...c.base, outcome_unknown: true, code: (c.status === 409 && c.json.code) || 'delivery_in_progress', error: IN_PROGRESS_SEND_MESSAGE })],
  // The message went out but the app could not record the invoice as sent (the finalization rolled back): never a retry.
  [(c) => c.json.code === 'INVOICE_DELIVERY_RECORD_FAILED',
    (c) => ({ ...c.base, outcome_unknown: true, code: c.json.code, text: c.text, email: c.email,
      error: 'The invoice went out, but the app could not record it as sent. Check the invoice by hand and do not send it again.' })],
  [(c) => c.unknown && !c.sent,
    (c) => ({ ...c.base, outcome_unknown: true, code: c.json.code || 'delivery_uncertain', text: c.text, email: c.email,
      error: 'Delivery of the invoice could not be confirmed — it may or may not have gone out. Check before sending again.' })],
  // Both channels failed (or the route refused before sending). The invoice changed after the card was
  // shown (nothing claimed or sent): a fresh card is right.
  [(c) => c.status !== 200,
    (c) => ({ ...c.base, error: `The invoice was not sent: ${c.json.error || 'send failed'}`, code: c.json.code || 'send_failed', failed: true,
      ...(['approved_version_changed', 'total_changed'].includes(c.json.code) ? { preview_changed: true } : {}), text: c.text, email: c.email })],
  [(c) => NOOP_SEND_KEYS.some((key) => c.json[key]),
    (c) => ({ ...c.base, success: true, text: c.text, email: c.email,
      note: c.json.covered_by_credit ? 'Nothing was sent: account credit now covers this invoice.' : 'Nothing new was sent: the invoice was already delivered or is being delivered.' })],
  [(c) => c.requested.every((leg) => leg.status === 'sent'),
    (c) => ({ ...c.base, success: true, text: c.text, email: c.email,
      note: ['The invoice was sent.', ...[c.text, c.email].map((leg) => leg.warning).filter(Boolean)].join(' ') })],
  [() => true,
    (c) => ({ ...c.base, partial: true, text: c.text, email: c.email,
      note: c.unknown ? 'Part of the invoice was sent; delivery of the rest could not be confirmed — check before sending again.' : 'Part of the invoice send did not go out — see text and email.' })],
];

function sendOutcome(plan, status, json = {}) {
  const text = channelResult(json.sms);
  const email = channelResult(json.email);
  const c = {
    base: { invoice_id: plan.invoice_id, invoice_number: plan.invoice_number },
    status, json, text, email,
    unknown: UNCERTAIN_SEND_CODES.has(json.code) || [text, email].some((leg) => leg.status === 'unknown'),
    sent: [text, email].some((leg) => leg.status === 'sent'),
    requested: [plan.text.startsWith('Text to') && text, plan.email.startsWith('Email to') && email].filter(Boolean),
  };
  return SEND_OUTCOME_RULES.find(([applies]) => applies(c))[1](c);
}

async function commitSend(input, actionContext) {
  const pinned = input._verified_invoice_send_version;
  const { plan, refusal: refused } = await verifiedPlan(input, pinned, buildSendPlan, { what: 'send', changed: 'Nothing was sent' });
  if (refused) return refused;
  const { status, json } = await require('../../routes/admin-invoices').sendInvoiceFromBar({
    invoiceId: plan.invoice_id,
    // The Invoices page Send with no review decision taken for it: an ordinary
    // send (neither firstDelivery nor resend) and no review request.
    // A never-delivered invoice is also flagged a first delivery, exactly as the Invoices
    // page does: if another delivery wins the claim first, the route reports a no-op, not a resend.
    body: { requestReview: false, ...(pinned.first_delivery ? { firstDelivery: true } : {}) },
    actor: { technicianId: actionContext?.technicianId || null },
    // The total and the recipients the card showed: the send refuses a different
    // total on its claimed row, and each leg refuses a different recipient. The version
    // (edit time + amount due / lines digest) is enforced by the send claim itself.
    approvedSend: {
      expectedTotal: pinned.total_cents / 100,
      recipients: plan.sendRecipients,
      version: {
        updatedAtMs: pinned.invoice_version,
        digest: pinned.version_digest,
        // The approved attachment list: the email leg checks it once more right before the provider call.
        attachments: pinned.attachments,
        // The visit the card said would close (or none): handed to the send's closeout, and written on the invoice
        // by the claim so the retry sweep keeps to it.
        closeoutTarget: plan._closeout_target,
        // The leads the card said this send marks won (or none): the conversion after delivery touches those and no others.
        leadTargets: plan._lead_targets,
        // Run by the send claim on the claimed row, and again at each provider handoff (text and email): who owes the
        // invoice must still be the customer, and it must still not be an annual-plan invoice (resolved as the pay page does;
        // a failed lookup refuses).
        verifyOwner: async (claimed, database) => (await ownerRefusalText(claimed, database)) || annualPlanRefusalText(claimed, database),
        // Run by the send claim on the claimed row: the post-delivery effects the card listed must be unchanged.
        verifyEffects: async (claimed, database) => (await planSendEffects(claimed, await database('customers').where({ id: claimed.customer_id }).first(), { database, requestReview: false })).digest === pinned.effects,
      },
    },
  });
  const result = sendOutcome(plan, status, json || {});
  logger.info(`[intelligence-bar:invoice-actions] send ${plan.invoice_id}: ${result.text?.status || 'n/a'} / ${result.email?.status || 'n/a'}`);
  return result;
}

// ── card lines (authorization-contract.js) ──────────────────────

function cardLines(toolName, preview) {
  if (!preview || preview.preview !== true) return [];
  const head = { kind: 'customer', text: `Invoice ${preview.invoice_number} — ${preview.customer_name || preview.customer_id}` };
  // Every planned effect is a card line (invoice-action-effects.js), after the headline lines.
  const effects = (preview.effects || []).map(({ kind, text }) => ({ kind, text }));
  if (toolName === 'send_invoice') {
    return [
      head,
      { kind: 'billing', text: `Amount due: ${preview.amount_due} (invoice total ${preview.total})` },
      // The first lines on the card itself; every other line rides in full under "Show more".
      ...preview.lines.map((line, index) => ({ kind: 'billing', text: `Line ${index + 1} of ${preview.lines.length}: ${line}`, ...(index >= CARD_LINES_SHOWN ? { more: true } : {}) })),
      ...(preview.lines.length > CARD_LINES_SHOWN ? [{ kind: 'billing', text: `All ${preview.lines.length} invoice lines are listed; lines ${CARD_LINES_SHOWN + 1} on are under "Show more"` }] : []),
      { kind: 'comms', text: preview.text },
      { kind: 'comms', text: preview.email },
      ...(preview.custom_copy || []).map((text) => ({ kind: 'comms', text })),
      ...effects,
    ];
  }
  return [];
}

async function executeInvoiceActionTool(toolName, input = {}, actionContext = {}) {
  if (!INVOICE_ACTION_TOOLS.some((t) => t.name === toolName)) return { error: `Unknown tool: ${toolName}` };
  // Admin only, like the requireAdmin routes it runs; the route and registry refuse a
  // technician too. The confirmed run needs a positive admin flag (fail closed).
  if (actionContext?.isAdmin === false || (input.confirmed === true && actionContext?.isAdmin !== true)) {
    return refusal('Sending invoices is limited to admin accounts', 'permission_denied');
  }
  if (!invoiceActionsLive()) return refusal('Sending invoices from the bar is switched off.', 'gate_off');
  try {
    // Only /confirm-action sets confirmed (route-derived, never a model param).
    return input.confirmed === true ? await commitSend(input, actionContext) : await buildSendPlan(input);
  } catch (err) {
    logger.error(`[intelligence-bar:invoice-actions] ${toolName} failed (${err.code || err.name || 'error'})`);
    // A throw after an approval may follow a sent message: never invite a retry.
    return input.confirmed === true
      ? { outcome_unknown: true, code: 'execution_interrupted', error: 'The send was interrupted — it may or may not have happened. Check the invoice before trying again.' }
      : { error: 'Could not prepare the invoice send' };
  }
}

module.exports = {
  INVOICE_ACTION_TOOLS,
  executeInvoiceActionTool,
  invoiceActionsLive,
  cardLines,
};
