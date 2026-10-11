/**
 * Intelligence Bar — send or charge an EXISTING invoice
 * server/services/intelligence-bar/invoice-action-tools.js
 *
 * Owner ruling 2026-10-07 (Q1): "Yes, limited — only an existing invoice, on a
 * card, $500 per charge and $1,500 per day; admin only." No invoice creation,
 * no amount edit, no refund, no void.
 *
 *   send_invoice   — the Invoices page "Send" (POST /admin/invoices/:id/send),
 *                    run through admin-invoices.js sendInvoiceFromBar: the same
 *                    handler, so every refusal and message is the route's own.
 *   charge_invoice — the Invoices page "Charge card on file"
 *                    (POST /admin/invoices/:id/charge-card), run through
 *                    chargeInvoiceFromBar: StripeService.chargeInvoiceWithSavedCard
 *                    with the route's own arguments. The card's amounts come from
 *                    StripeService.quoteInvoiceSavedCardCharge (computeChargeAmount,
 *                    the charge path's own math); this module computes no amount.
 *
 * Both are always a confirm card (write-gates.js two-step), admin only, never
 * owner-direct, dark behind GATE_IB_INVOICE_ACTIONS.
 *
 *   unconfirmed → a PREVIEW: nothing is sent or charged. Its `_version` pins
 *                 what the card showed (invoice state, recipients / card, total).
 *   confirmed   → re-derives the preview and refuses with preview_changed on any
 *                 drift, then calls the route's handler. A charge also passes the
 *                 route the card's exact total (expectedTotal: the charge refuses
 *                 any other total under its invoice lock) and the bar's caps, which
 *                 the charge rechecks inside its own transaction (below).
 *
 * Caps (charge_invoice): the TOTAL (base + card surcharge) is at most $500, and
 * the bar's charges today (ET) plus this one are at most $1,500. "The bar's
 * charges" are counted from durable rows:
 *   - payments rows the charge path wrote for the bar: it stamps
 *     metadata.initiated_via = 'intelligence_bar' through its existing insert
 *     (status failed/canceled excluded; refunded still counts);
 *   - charge_invoice approvals for OTHER invoices consumed today whose outcome is
 *     unknown or not yet recorded AND whose invoice has an unresolved saved-card
 *     charge claim (stripe_invoice_charge_attempts claimed / ambiguous) and no bar
 *     payment row yet (a charge that is running, or one Stripe may have taken with
 *     no payment row): each counts as the full $500, fail closed. A confirmed card
 *     still waiting for its turn has claimed nothing, so it is not counted;
 *   - unresolved stripe_orphan_charges rows created today for an invoice the bar
 *     has charged (Stripe took the money, the payment write failed): each counts at
 *     its amount.
 * The three reads are ONE statement (three CTEs), so they share one snapshot. Inside the charge
 * transaction the check runs again after a transaction-scoped advisory lock (one key for every
 * bar charge), so two charges that reach their transactions at once are serialized: the second
 * sees the first's payment row, or its in-flight approval, before Stripe is called.
 *
 * One bar charge runs at a time: the confirmed run takes a durable claim on its approval row (a
 * short transaction that ends before the charge starts; see claimChargeRun) and gives it back
 * when the charge ends. No connection is held across the charge.
 *
 * Effects: everything the send or the payment also does (lead conversion, billing reminders, the
 * visit closeout, review outreach, the receipt ...) is ONE list from invoice-action-effects.js,
 * built from the handlers' own predicates. The card shows each effect, `_version.effects` pins the
 * list's digest, and the send claim / charge lock recompute it and refuse on any difference.
 *
 * Results carry ids, states and reasons; recipients stay masked.
 */
const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const { UUID_RE } = require('./task-context');
const { etDateString } = require('../../utils/datetime-et');
const { maskEmail, maskPhone } = require('./closeout-repair-tools');
const { assertInvoiceCollectible, invoiceAmountDue, neverRanVisitStatus, approvedInvoiceVersionDigest } = require('../invoice-helpers');
const { isCardMethodType } = require('../stripe-pricing');
const { planSendEffects, planChargeEffects, annualPrepayRefusal, approvedCloseoutTarget } = require('./invoice-action-effects');

const PER_CHARGE_CAP_CENTS = 50000;
const CARD_LINES_SHOWN = 4;
const DAILY_CAP_CENTS = 150000;
const CAP_LOCK_KEY = 'ib-invoice-charge-daily-cap';
// One bar charge runs at a time, from before its cap preflight until its charge returns. The turn is a DURABLE
// CLAIM on the approval row (its `result` holds { claim: 'charge_running', since }), taken in a short transaction
// that ends before the charge starts: a connection held across the charge could starve the charge's own writes
// (the pool is two connections). A second confirmed card is turned away at the claim BEFORE it claims anything,
// so the first charge never counts it as a reservation and a later card sees the first's committed payment.
// A claim older than RUN_CLAIM_STALE_MINUTES is a charge that died: it no longer blocks (and still counts as an
// uncertain $500 until its invoice's attempt claim is resolved).
const CONFIRM_LOCK_KEY = 'ib-invoice-charge-confirm';
const RUN_CLAIM = 'charge_running';
const RUN_CLAIM_STALE_MINUTES = 10;
// Refusals the charge guard throws inside the charge transaction start with this,
// so the commit can tell them from the route's own 400s (the route returns only the message).
const CAP_REFUSAL_PREFIX = 'Bar charge limit:';

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
Refused with the reason: invoice not found, paid, prepaid, void, refunded, canceled, a bank payment processing, billed on a payer's monthly statement, nothing due, a collections hold on the customer's billing messages, no phone or email on file. Never creates, edits, voids or refunds an invoice. No review request is sent. Admin only.
Takes invoice_id OR invoice_number, exactly one.
Use for: "send the invoice", "text her the invoice", "resend invoice WPC-2026-0534".`,
    input_schema: { type: 'object', properties: { ...TARGET_PROPS } },
    _sideEffects: true,
  },
  {
    name: 'charge_invoice',
    description: `Charge the open balance of ONE existing invoice to a card the customer already saved, exactly as the Invoices page "Charge card on file" does. The first call returns a PREVIEW and charges nothing: the invoice, the customer, the card (brand and last 4), the balance, the card surcharge, the TOTAL charged, and the receipt that follows. The operator approves on the confirmation card; the confirmed run re-checks all of it, refuses if anything changed, and charges exactly the total the card showed.
Limits: card only (never a bank account); at most $500 per charge including the surcharge; at most $1,500 a day (ET) across all charges from the bar. Larger or bank charges are done on the Invoices page.
Refused with the reason: invoice not found, already paid or prepaid, void, refunded, canceled, a payment already processing or in progress, billed to a third-party payer, nothing due (or account credit covers it), a billing-dispute hold, the card not on this customer, no saved card, more than one card and none named, over a limit. Never creates, edits, voids or refunds an invoice. Admin only.
Takes invoice_id OR invoice_number, exactly one. payment_method_id or card_last4 names the card; optional when the customer has exactly one saved card.
Use for: "charge the saved card for invoice X", "run her card on file for the open invoice".`,
    input_schema: {
      type: 'object',
      properties: {
        ...TARGET_PROPS,
        payment_method_id: { type: 'string', format: 'uuid', description: 'The saved card (payment_methods.id) to charge' },
        card_last4: { type: 'string', description: 'The last 4 digits of the saved card to charge (use instead of payment_method_id)' },
      },
    },
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

// A charge reads the charging predicate (dispute holds); a send reads the
// messaging predicate (any hold), the same split the invoice senders use.
async function disputeHold(customerId) {
  return require('../collections/collection-hold').customerHasActiveCollectionHoldChecked(customerId);
}
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

const TEXT_MESSAGE = 'the invoice text (template invoice_sent, or its pre-service or annual-prepay variant when that applies) with the pay link';

// The send refusals the bar checks before reading recipients (the route's own
// text where the route has one), or null.
async function sendRefusal(invoice, dueCents) {
  const notCollectible = collectibleRefusal(invoice);
  if (notCollectible) return notCollectible;
  const at = { invoice_id: invoice.id };
  if (invoice.payer_statement_id) return refusal('Invoice is billed on the payer’s monthly statement; not sent individually.', 'payer_statement', at);
  if (dueCents <= 0) return refusal('Nothing is due on this invoice, so there is no pay link to send.', 'nothing_due', at);
  // An annual-plan invoice's send re-enters under the renewal gate, which does not
  // carry the bar's approved total or its no-credit rule: it stays on the Invoices page.
  if (invoice.annual_prepay_term_id) return refusal('This is an annual-plan invoice. Send it from the Invoices page.', 'annual_plan_invoice', at);
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
// the text goes to the customer's phone, the email to the billing recipient; a
// payer-billed invoice goes to the payer's billing inbox and is never texted.
function sendLegs(who, invoice, dueCents) {
  const phone = who.payerBilled ? null : (who.primaryContact?.phone || null);
  const email = who.emailRecipient?.email ? String(who.emailRecipient.email).trim().toLowerCase() : null;
  let text = 'No text: no phone on file.';
  if (phone) text = `Text to ${maskPhone(phone)}: ${TEXT_MESSAGE}. Not sent if the customer opted out of texts.`;
  else if (who.payerBilled) text = 'No text: a payer-billed invoice is never texted.';
  const subject = `Invoice ${invoice.invoice_number} — ${money(dueCents)}`;
  const inbox = who.payerBilled ? " (the payer's billing inbox)" : '';
  const emailLine = email
    ? `Email to ${maskEmail(email)}${inbox}: the invoice email (template invoice.sent), subject "${subject}", with the invoice PDF and the pay link.`
    : 'No email: no billing email on file.';
  return { phone, email, text, emailLine };
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
    effects: cardEffects(planned.effects),
    // The delivery effect's sentence, for the confirmation card's summary.
    send_note: planned.effects.find((e) => e.key === 'delivery').line,
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
      payer_id: invoice.payer_id || null,
      recipients: digest(recipients),
    },
    note: 'PREVIEW ONLY — nothing was sent. Confirm sends exactly this; if anything changed it refuses.',
  };
}

function channelResult(leg) {
  if (!leg) return { status: 'not_sent', detail: 'not attempted' };
  if (leg.ok) return { status: 'sent' };
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
    (c) => ({ ...c.base, success: true, text: c.text, email: c.email, note: 'The invoice was sent.' })],
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
        // Run by the send claim on the claimed row: the post-delivery effects the card listed must be unchanged.
        verifyEffects: async (claimed, database) => (await planSendEffects(claimed, await database('customers').where({ id: claimed.customer_id }).first(), { database, requestReview: false })).digest === pinned.effects,
      },
    },
  });
  const result = sendOutcome(plan, status, json || {});
  logger.info(`[intelligence-bar:invoice-actions] send ${plan.invoice_id}: ${result.text?.status || 'n/a'} / ${result.email?.status || 'n/a'}`);
  return result;
}

// ── charge_invoice ──────────────────────────────────────────────
// CHARGE-ONLY: everything from here to the card lines section (CHARGE_PRECHECKS, the daily cap, the run claim,
// buildChargePlan, runCharge) belongs to charge_invoice; dropping the charge tool removes this section, the
// charge branch of cardLines, and the charge half of invoice-action-effects.js, and leaves send_invoice whole.

// Today's (ET) bar charges, in cents, from durable rows (see the header).
// excludeInvoiceId: the invoice being charged. Its own approval is consumed (result
// not yet recorded) while it runs, and a second charge of the same invoice is
// already fenced by the charge path's own claim, so its approvals never count here.
// The three reads behind the daily total, as query builders so a test can compile their SQL.
// payments has no invoice_id column: its invoice link is metadata->>'invoice_id' (the indexed
// expression the other payments lookups use, migration 20261006130000).
const PAYMENT_INVOICE_EXPR = "metadata->>'invoice_id'";
const NOT_FAILED = ['failed', 'canceled', 'cancelled'];
const approvalInvoiceExpr = "ib_pending_actions.params->>'invoice_id'";

function paidTodayQuery(database, day) {
  return database('payments')
    .whereRaw("metadata->>'initiated_via' = 'intelligence_bar'")
    .where({ payment_date: day })
    .whereNotIn('status', NOT_FAILED)
    .sum({ total: 'amount' });
}

function uncertainApprovalsQuery(database, { excludeInvoiceId = null, day }) {
  const uncertain = database('ib_pending_actions')
    .where({ tool_name: 'charge_invoice', status: 'confirmed' })
    .whereRaw("(consumed_at AT TIME ZONE 'America/New_York')::date = ?::date", [day])
    // No result yet, an unknown one, or the run claim of a charge that never recorded (running, or died).
    .where((b) => b.whereNull('result').orWhereRaw("result->>'outcome_unknown' = 'true'").orWhereRaw(`result->>'claim' = '${RUN_CLAIM}'`))
    // The charge path's own durable claim: money may be moving or may have moved.
    .whereExists(function claimed() {
      this.select(database.raw('1')).from('stripe_invoice_charge_attempts as a')
        .whereRaw(`a.invoice_id::text = ${approvalInvoiceExpr}`)
        .whereIn('a.status', ['claimed', 'ambiguous']).whereNull('a.resolved_at');
    })
    // Once the payment row exists the paid sum already counts it.
    .whereNotExists(function counted() {
      this.select(database.raw('1')).from('payments as p')
        .whereRaw(`p.${PAYMENT_INVOICE_EXPR} = ${approvalInvoiceExpr}`)
        .whereRaw("p.metadata->>'initiated_via' = 'intelligence_bar'")
        .where('p.payment_date', day)
        .whereNotIn('p.status', NOT_FAILED);
    });
  if (excludeInvoiceId) uncertain.whereRaw("COALESCE(params->>'invoice_id', '') <> ?", [String(excludeInvoiceId)]);
  return uncertain.count({ n: '*' });
}

// Charges Stripe accepted whose invoice / payment write then failed (stripe_orphan_charges, the
// table the charge path files them in and the reconciliation queue reads: resolved = false). They
// have no payments row, so the paid sum cannot see them; only the bar's own invoices count here.
function orphanChargesTodayQuery(database, day) {
  return database('stripe_orphan_charges as o')
    .where('o.resolved', false)
    .whereRaw("(o.created_at AT TIME ZONE 'America/New_York')::date = ?::date", [day])
    .whereExists(function barApproval() {
      this.select(database.raw('1')).from('ib_pending_actions as pa')
        .where({ 'pa.tool_name': 'charge_invoice', 'pa.status': 'confirmed' })
        .whereRaw("pa.params->>'invoice_id' = o.invoice_id::text");
    })
    .sum({ total: 'o.amount' });
}

// The three reads as ONE statement (three CTEs, one result row): they run in a single snapshot, so a charge
// that commits while the total is read cannot be missed by one read and counted by another (or both).
function dailyTotalsQuery(database, { excludeInvoiceId = null, day }) {
  return database
    .with('paid', paidTodayQuery(database, day))
    .with('uncertain', uncertainApprovalsQuery(database, { excludeInvoiceId, day }))
    .with('orphans', orphanChargesTodayQuery(database, day))
    .select(
      database.raw('(SELECT total FROM paid) AS paid'),
      database.raw('(SELECT n FROM uncertain) AS uncertain'),
      database.raw('(SELECT total FROM orphans) AS orphans'),
    );
}

async function chargedTodayCents(database = db, { excludeInvoiceId = null, day = etDateString() } = {}) {
  const [row] = await dailyTotalsQuery(database, { excludeInvoiceId, day });
  return toCents(row?.paid) + toCents(row?.orphans) + (Number(row?.uncertain) || 0) * PER_CHARGE_CAP_CENTS;
}

// The cap refusal for a charge of totalCents with usedCents already charged today, or null.
function capRefusal(totalCents, usedCents) {
  if (totalCents > PER_CHARGE_CAP_CENTS) {
    return `${CAP_REFUSAL_PREFIX} this charge is ${money(totalCents)} with the card surcharge, and the bar charges at most ${money(PER_CHARGE_CAP_CENTS)} at a time. Charge it from the Invoices page.`;
  }
  if (usedCents + totalCents > DAILY_CAP_CENTS) {
    return `${CAP_REFUSAL_PREFIX} the bar has charged ${money(usedCents)} today, and this ${money(totalCents)} charge would pass the ${money(DAILY_CAP_CENTS)} daily limit. Charge it from the Invoices page.`;
  }
  return null;
}

// The bar's caps and the dispute hold, run by the charge path inside its
// transaction (stripe.js assertUnderChargeLock) with the final total. The
// advisory lock is transaction-scoped: it is held until that transaction
// (and its payments insert) commits or rolls back.
function chargeLockGuard({ invoiceId, customerId, effects = null }) {
  return async (trx, { totalCents, invoice }) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [CAP_LOCK_KEY]);
    const message = capRefusal(totalCents, await chargedTodayCents(trx, { excludeInvoiceId: invoiceId }));
    if (message) throw Object.assign(new Error(message), { code: 'IB_CHARGE_CAP' });
    // The route runs this charge with operatorOverride off (the bar never overrides a
    // dispute hold), so a held customer is already refused before this; the check stays as a backstop.
    await require('../collections/collection-hold').assertNoCollectionHold(customerId, trx);
    // What the payment also does (closeout, review, reminders, receipt ...), recomputed on the locked row:
    // any difference from the card refuses before Stripe is called. The credit is the card's own number
    // (the version digest and the exact-total check already guard it).
    if (effects) {
      const customer = await trx('customers').where({ id: customerId }).first();
      const again = await planChargeEffects(invoice, customer, { database: trx, creditCents: effects.creditCents });
      if (again.digest !== effects.digest) {
        throw Object.assign(new Error('What this payment would also do changed after the card was shown. Nothing was charged.'), { code: 'approved_version_changed' });
      }
    }
  };
}

const cardLabel = (pm) => `${pm.card_brand || 'Card'} •••• ${pm.last_four || '????'}${pm.exp_month && pm.exp_year ? ` (exp ${String(pm.exp_month).padStart(2, '0')}/${String(pm.exp_year).slice(-2)})` : ''}`;

// The saved card the call names: an id or last 4, or the only card on file.
async function resolveCard(invoice, input) {
  const methods = await db('payment_methods').where({ customer_id: invoice.customer_id })
    .orderBy('is_default', 'desc').orderBy('created_at', 'desc');
  const requestedId = String(input?.payment_method_id || '').trim();
  const last4 = String(input?.card_last4 || '').replace(/\D/g, '');
  if (requestedId && last4) return refusal('Give payment_method_id or card_last4, not both', 'invalid_target');
  let picked;
  if (requestedId) {
    if (!UUID_RE.test(requestedId)) return refusal('A valid payment_method_id is required', 'invalid_target');
    picked = methods.find((m) => String(m.id) === requestedId.toLowerCase());
    if (!picked) {
      const exists = await db('payment_methods').where({ id: requestedId.toLowerCase() }).first('id');
      return exists ? refusal('Payment method does not belong to invoice customer', 'card_not_customer')
        : refusal('Payment method not found', 'card_not_found');
    }
  } else if (last4) {
    const matches = methods.filter((m) => String(m.last_four || '') === last4);
    if (matches.length !== 1) {
      return refusal(matches.length ? `More than one saved method ends in ${last4}. Name it by payment_method_id.` : `No saved card ending in ${last4} is on file for this customer.`, 'card_not_found');
    }
    [picked] = matches;
  } else {
    const cards = methods.filter((m) => isCardMethodType(m.method_type));
    if (!cards.length) return refusal('This customer has no saved card.', 'no_saved_card');
    if (cards.length > 1) {
      return refusal(`This customer has ${cards.length} saved cards: ${cards.map(cardLabel).join('; ')}. Say which card to charge.`, 'card_ambiguous',
        { cards: cards.map((m) => ({ payment_method_id: m.id, card: cardLabel(m) })) });
    }
    [picked] = cards;
  }
  // A positive card match, from the surcharge path's own classifier (stripe-pricing
  // isCardMethodType): a bank, cash, check, other or empty type is not a card.
  if (!isCardMethodType(picked.method_type)) {
    return refusal('The bar charges saved cards only. Charge a bank account or another payment method from the Invoices page.', 'not_card_method');
  }
  if (!picked.stripe_payment_method_id) return refusal('Payment method has no Stripe id', 'card_unusable');
  return { card: picked };
}

// The charge refusals checked in order before a card is read, each the Invoices page's own text (or null).
const CHARGE_PRECHECKS = [
  async (invoice) => collectibleRefusal(invoice),
  async (invoice) => (invoice.payer_id
    ? refusal('Invoice is billed to a third-party payer — collect from the payer, not a saved card on the service account', 'payer_billed', { invoice_id: invoice.id })
    : null),
  // A saved-card charge already claimed or awaiting reconciliation (the charge path's own fence).
  async (invoice) => ((await db('stripe_invoice_charge_attempts').where({ invoice_id: invoice.id })
    .whereIn('status', ['claimed', 'ambiguous']).whereNull('resolved_at').first('id'))
    ? refusal('A saved-card charge is already in progress or awaiting reconciliation. DO NOT charge again until an admin verifies it.', 'charge_in_progress', { invoice_id: invoice.id })
    : null),
  // syncTermForInvoicePayment activates the annual plan; that is the Invoices page's job, not the bar's.
  async (invoice) => (annualPrepayRefusal(invoice)
    ? refusal(annualPrepayRefusal(invoice), 'annual_prepay_invoice', { invoice_id: invoice.id })
    : null),
  async (invoice) => ((await disputeHold(invoice.customer_id))
    ? refusal('Collection is on hold for this customer (billing dispute). Review before charging. The bar never overrides it; use the Invoices page.', 'collection_hold', { invoice_id: invoice.id })
    : null),
];

async function buildChargePlan(input) {
  const target = await resolveInvoice(input);
  if (target.error) return target;
  const { invoice } = target;
  for (const check of CHARGE_PRECHECKS) {
    const refused = await check(invoice);
    if (refused) return refused;
  }
  const picked = await resolveCard(invoice, input);
  if (picked.error) return { ...picked, invoice_id: invoice.id };
  const { card } = picked;
  let quote;
  try {
    // The Invoices page's own pre-charge quote (POST /:id/charge-card-quote):
    // computeChargeAmount on the amount due after any account credit the charge applies.
    quote = await require('../stripe').quoteInvoiceSavedCardCharge(invoice.id, card.id);
  } catch (err) {
    return refusal(err.message, err.code || 'quote_failed', { invoice_id: invoice.id });
  }
  const totalCents = toCents(quote.total);
  if (quote.coveredByCredit || totalCents <= 0) {
    return refusal('Account credit covers this invoice, so nothing would be charged to the card. Apply the credit from the Invoices page.', 'covered_by_credit', { invoice_id: invoice.id });
  }
  const baseCents = toCents(quote.base);
  const surchargeCents = toCents(quote.surcharge);
  const creditNowCents = toCents(invoice.credit_applied);
  const creditAfterCents = toCents(quote.projectedCreditApplied);
  // Everything a paid invoice also does (the payment_intent.succeeded handler's list), from its own predicates.
  const customer = await db('customers').where({ id: invoice.customer_id }).first();
  const planned = await planEffectsOrRefuse(
    () => planChargeEffects(invoice, customer, { creditCents: Math.max(0, creditAfterCents - creditNowCents) }), invoice, 'charged');
  if (planned.error) return planned;
  const usedCents = await chargedTodayCents(db, { excludeInvoiceId: invoice.id });
  const capMessage = capRefusal(totalCents, usedCents);
  if (capMessage) return refusal(capMessage, 'charge_limit', { invoice_id: invoice.id });
  return {
    preview: true,
    tool: 'charge_invoice',
    invoice_id: invoice.id,
    invoice_number: invoice.invoice_number,
    customer_id: invoice.customer_id,
    customer_name: await customerName(invoice.customer_id),
    status: invoice.status,
    payment_method_id: card.id,
    card: cardLabel(card),
    balance: money(baseCents),
    surcharge: surchargeCents > 0
      ? `${money(surchargeCents)} card surcharge (${(Number(quote.rateBps) / 100).toFixed(2)}%)`
      : 'No card surcharge',
    total_charged: money(totalCents),
    limits: `At most ${money(PER_CHARGE_CAP_CENTS)} per charge and ${money(DAILY_CAP_CENTS)} a day from the bar.`,
    effects: cardEffects(planned.effects),
    // The credit the effects plan used (not pinned itself: the version digest and the exact total guard it).
    _credit_cents: Math.max(0, creditAfterCents - creditNowCents),
    // The visit the closeout effect named (or 'none'): the PaymentIntent carries it to the webhook, which enforces it.
    _closeout_target: approvedCloseoutTarget(planned.effects),
    // Shown on the card, kept out of the approval fingerprint (`_` key): another
    // bar charge landing before Confirm changes it without changing this charge.
    _charged_today: `${money(usedCents)} charged from the bar today`,
    _version: {
      invoice_id: invoice.id,
      status: invoice.status,
      total_cents: toCents(invoice.total),
      credit_cents: creditNowCents,
      due_cents: toCents(invoiceAmountDue(invoice)),
      invoice_version: msOf(invoice.updated_at),
      // Amount due, credit and lines: the charge compares this with the locked row before Stripe.
      version_digest: approvedInvoiceVersionDigest(invoice),
      // Every effect of the payment (closeout, review, reminders, receipt ...): the charge recomputes it under its lock.
      effects: planned.digest,
      payment_method_id: card.id,
      card: digest({
        pm: card.stripe_payment_method_id, brand: card.card_brand || null, last4: card.last_four || null,
        exp: `${card.exp_month || ''}/${card.exp_year || ''}`, type: card.method_type || null, funding: quote.funding || null,
      }),
      base_cents: baseCents,
      surcharge_cents: surchargeCents,
      charge_cents: totalCents,
    },
    note: 'PREVIEW ONLY — nothing was charged. Confirm charges exactly this total; if anything changed it refuses.',
  };
}

function chargeNote(json, amount) {
  if (json.status !== 'paid') return `Charge of ${amount} is processing.`;
  if (json.receiptQueued === true) return `Charged ${amount}. The invoice is paid; the receipt is queued.`;
  if (json.receiptQueued === false) return `Charged ${amount}. The invoice is paid, but the receipt was NOT queued. Send it from the invoice page.`;
  return `Charged ${amount}. The invoice is paid.`;
}

// The charge-card handler's reply, in the tool's words.
function chargeOutcome(plan, status, json = {}) {
  const base = { invoice_id: plan.invoice_id, invoice_number: plan.invoice_number };
  if (status === 200 && json.success && json.covered_by_credit) {
    return { ...base, success: true, charged: false, note: 'Nothing was charged to the card: account credit covered the invoice at charge time, and the invoice is now prepaid.' };
  }
  if (status === 200 && json.success) {
    const amount = money(toCents(json.amount));
    return {
      ...base, success: true, charged: true, payment_id: json.paymentId, payment_status: json.status,
      amount, card: `${json.brand || 'Card'} •••• ${json.last4 || '????'}`,
      // Only what the charge reported: receiptQueued is true when a receipt job exists, false when queuing failed.
      ...(json.status === 'paid' && json.receiptQueued === false ? { receipt_queued: false } : {}),
      note: chargeNote(json, amount),
    };
  }
  const message = String(json.error || 'charge failed');
  // Stripe may have the money (orphan / ambiguous) or another charge owns the invoice: never a retry.
  if (json.orphan || json.ambiguous || json.in_progress) return { ...base, outcome_unknown: true, code: json.code, error: message };
  if (message.startsWith(CAP_REFUSAL_PREFIX)) return { ...base, blocked: true, code: 'charge_limit', error: `Nothing was charged: ${message}` };
  // Every other route refusal is pre-Stripe (stripe.js releases the claim): no money moved.
  return { ...base, error: `Nothing was charged: ${message}`, code: json.code || 'charge_refused', preview_changed: json.code === 'approved_version_changed' || /changed|Review the updated total/i.test(message) };
}

// Takes the run claim on this approval: false when another bar charge holds a live claim (or this approval has
// no row to claim). The transaction serializes claimants for the length of two statements and holds no
// connection afterwards.
async function claimChargeRun(approvalId) {
  return db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [CONFIRM_LOCK_KEY]);
    const live = await trx('ib_pending_actions').where({ tool_name: 'charge_invoice' })
      .whereRaw('id <> ?', [approvalId])
      .whereRaw(`result->>'claim' = '${RUN_CLAIM}'`)
      .whereRaw(`(result->>'since')::timestamptz > now() - interval '${RUN_CLAIM_STALE_MINUTES} minutes'`)
      .first('id');
    if (live) return false;
    const claimed = await trx('ib_pending_actions').where({ id: approvalId, status: 'confirmed' }).whereNull('result')
      .update({ result: JSON.stringify({ claim: RUN_CLAIM, since: new Date().toISOString() }), updated_at: trx.fn.now() });
    return claimed === 1;
  });
}

// Gives the claim back once the run ended (the confirm route records the result right after; a claim that is
// never given back goes stale on its own).
async function releaseChargeRun(approvalId) {
  try {
    await db('ib_pending_actions').where({ id: approvalId }).whereRaw(`result->>'claim' = '${RUN_CLAIM}'`).update({ result: null, updated_at: db.fn.now() });
  } catch (err) {
    logger.warn(`[intelligence-bar:invoice-actions] charge claim release failed for ${approvalId} (${err.code || 'error'})`);
  }
}

async function commitCharge(input, actionContext) {
  const pinned = input._verified_invoice_charge_version;
  if (!pinned) return { error: 'Use the confirmation card to approve this charge.', code: 'approval_required' };
  const approvalId = actionContext?.operationId;
  if (!approvalId || !(await claimChargeRun(approvalId))) {
    return refusal('Another bar charge is running, so nothing was charged. Ask again in a moment.', 'charge_busy');
  }
  // No transaction wraps the charge: the claim above is already committed.
  try {
    return await runCharge(input, pinned, actionContext);
  } finally {
    await releaseChargeRun(approvalId);
  }
}

async function runCharge(input, pinned, actionContext) {
  const { plan, refusal: refused } = await verifiedPlan(input, pinned, buildChargePlan, { what: 'charge', changed: 'Nothing was charged' });
  if (refused) return refused;
  const { status, json } = await require('../../routes/admin-invoices').chargeInvoiceFromBar({
    invoiceId: plan.invoice_id,
    // The Invoices page's own body: the saved card and the quoted total the
    // operator saw (the charge refuses any other total under its invoice lock).
    body: { paymentMethodId: pinned.payment_method_id, expectedTotal: pinned.charge_cents / 100 },
    actor: { technicianId: actionContext?.technicianId || null },
    chargeGuard: chargeLockGuard({ invoiceId: plan.invoice_id, customerId: plan.customer_id, effects: { digest: pinned.effects, creditCents: plan._credit_cents } }),
    // The invoice row the card showed (edit time + amount due / lines digest): checked under the
    // charge's own invoice lock, before any Stripe call.
    version: { updatedAtMs: pinned.invoice_version, digest: pinned.version_digest },
    closeoutTarget: plan._closeout_target,
  });
  const result = chargeOutcome(plan, status, json || {});
  logger.info(`[intelligence-bar:invoice-actions] charge ${plan.invoice_id}: ${result.payment_status || result.code || 'done'}`);
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
      ...effects,
    ];
  }
  if (toolName === 'charge_invoice') {
    return [
      head,
      { kind: 'billing', text: `Card: ${preview.card}` },
      { kind: 'billing', text: `Invoice balance: ${preview.balance}` },
      { kind: 'billing', text: `Surcharge: ${preview.surcharge}` },
      { kind: 'billing', text: `TOTAL CHARGED: ${preview.total_charged}` },
      { kind: 'billing', text: preview.limits },
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
    return refusal('Sending and charging invoices are limited to admin accounts', 'permission_denied');
  }
  if (!invoiceActionsLive()) return refusal('Sending and charging invoices from the bar is switched off.', 'gate_off');
  try {
    // Only /confirm-action sets confirmed (route-derived, never a model param).
    if (toolName === 'send_invoice') return input.confirmed === true ? await commitSend(input, actionContext) : await buildSendPlan(input);
    return input.confirmed === true ? await commitCharge(input, actionContext) : await buildChargePlan(input);
  } catch (err) {
    logger.error(`[intelligence-bar:invoice-actions] ${toolName} failed (${err.code || err.name || 'error'})`);
    // A throw after an approval may follow a sent message or a charge: never invite a retry.
    return input.confirmed === true
      ? { outcome_unknown: true, code: 'execution_interrupted', error: `The ${toolName === 'send_invoice' ? 'send' : 'charge'} was interrupted — it may or may not have happened. Check the invoice before trying again.` }
      : { error: `Could not prepare the ${toolName === 'send_invoice' ? 'invoice send' : 'charge'}` };
  }
}

module.exports = {
  INVOICE_ACTION_TOOLS,
  executeInvoiceActionTool,
  invoiceActionsLive,
  cardLines,
  // Test surface.
  paidTodayQuery,
  uncertainApprovalsQuery,
  orphanChargesTodayQuery,
  dailyTotalsQuery,
  chargedTodayCents,
  chargeLockGuard,
  capRefusal,
  PER_CHARGE_CAP_CENTS,
  DAILY_CAP_CENTS,
};
