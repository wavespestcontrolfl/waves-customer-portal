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
 *     unknown or not yet recorded (another card in flight, or a charge Stripe may
 *     have taken with no payment row): each counts as the full $500, fail closed.
 * Inside the charge transaction the check runs again after a transaction-scoped
 * advisory lock (one key for every bar charge), so two cards confirmed at once
 * are serialized: the second sees the first's payment row, or its in-flight
 * approval, before Stripe is called.
 *
 * Results carry ids, states and reasons; recipients stay masked.
 */
const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const { UUID_RE } = require('./task-context');
const { etDateString, formatETTime } = require('../../utils/datetime-et');
const { maskEmail, maskPhone } = require('./closeout-repair-tools');
const { assertInvoiceCollectible, invoiceAmountDue } = require('../invoice-helpers');

const PER_CHARGE_CAP_CENTS = 50000;
const DAILY_CAP_CENTS = 150000;
const CAP_LOCK_KEY = 'ib-invoice-charge-daily-cap';
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
Refused with the reason: invoice not found, paid, prepaid, void, refunded, canceled, a bank payment processing, billed on a payer's monthly statement, nothing due, a billing-dispute hold on the customer, no phone or email on file. Never creates, edits, voids or refunds an invoice. No review request is sent. Admin only.
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
const etStamp = (value) => {
  const at = new Date(value);
  return `${etDateString(at)} ${formatETTime(at)} ET`;
};

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

// Up to four lines, "description amount", then "+N more".
function lineSummary(raw) {
  let items = raw;
  if (typeof items === 'string') { try { items = JSON.parse(items); } catch { items = []; } }
  if (!Array.isArray(items)) items = [];
  const shown = items.slice(0, 4).map((it) => {
    const label = String(it?.description || it?.name || 'Line').replace(/\s+/g, ' ').slice(0, 80);
    const amount = it?.amount ?? (Number(it?.quantity || 1) * Number(it?.unit_price || 0));
    return `${label} ${money(toCents(amount))}`;
  });
  if (items.length > 4) shown.push(`+${items.length - 4} more`);
  return shown;
}

// The route's own refusals for a row the Invoices page cannot collect
// (invoice-helpers.assertInvoiceCollectible), as a plain refusal.
function collectibleRefusal(invoice) {
  try { assertInvoiceCollectible(invoice); return null; } catch (err) { return refusal(err.message, 'invoice_not_collectible', { invoice_id: invoice.id }); }
}

async function disputeHold(customerId) {
  return require('../collections/collection-hold').customerHasActiveCollectionHoldChecked(customerId);
}

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
  if (await disputeHold(invoice.customer_id)) {
    return refusal('This customer has a billing-dispute hold. Send this invoice from the Invoices page if you mean to override it.', 'collection_hold', at);
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

async function buildSendPlan(input) {
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
  return {
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
    send_note: invoice.sent_at ? `Already sent on ${etStamp(invoice.sent_at)}. This sends it again.` : 'Not sent before.',
    review_request: 'No review request is sent.',
    _version: {
      invoice_id: invoice.id,
      status: invoice.status,
      total_cents: totalCents,
      due_cents: dueCents,
      invoice_version: msOf(invoice.updated_at),
      sent: msOf(invoice.sent_at),
      payer_id: invoice.payer_id || null,
      recipients: digest({ phone: legs.phone ? String(legs.phone).replace(/\D/g, '') : null, email: legs.email }),
    },
    note: 'PREVIEW ONLY — nothing was sent. Confirm sends exactly this; if anything changed it refuses.',
  };
}

function channelResult(leg) {
  if (!leg) return { status: 'not_sent', detail: 'not attempted' };
  if (leg.ok) return { status: 'sent' };
  return { status: 'not_sent', detail: String(leg.error || leg.code || 'not sent').slice(0, 160) };
}

// The re-derived plan when it still matches the card's pin, or the refusal.
async function verifiedPlan(input, pinned, build, { what, changed }) {
  if (!pinned) return { refusal: refusal(`Use the confirmation card to approve this ${what}.`, 'approval_required') };
  const plan = await build(input);
  if (plan.error) return { refusal: { error: `${changed}: ${plan.error}`, code: plan.code, ...(plan.code === 'charge_limit' ? { blocked: true } : { preview_changed: true }) } };
  if (JSON.stringify(plan._version) !== JSON.stringify(pinned)) {
    return { refusal: { error: `What this ${what} would do changed after the card was shown — ${changed.toLowerCase()}. Ask again for a fresh confirmation card.`, preview_changed: true } };
  }
  return { plan };
}

// A send reply the route answered without delivering anything new (status 200).
const NOOP_SEND_KEYS = ['already_delivered', 'queued_delivery', 'in_progress', 'covered_by_credit', 'settled_zero_due'];

// The Send handler's reply, in the tool's words.
function sendOutcome(plan, status, json = {}) {
  const base = { invoice_id: plan.invoice_id, invoice_number: plan.invoice_number };
  if (status === 409) return { ...base, error: `Nothing was sent: ${json.error || 'the invoice is busy'}`, code: json.code || 'send_conflict', preview_changed: true };
  const text = channelResult(json.sms);
  const email = channelResult(json.email);
  // Both channels failed (or the route refused before sending).
  if (status !== 200) {
    return { ...base, error: `The invoice was not sent: ${json.error || 'send failed'}`, code: json.code || 'send_failed', failed: true, text, email };
  }
  if (json.voided) {
    return { ...base, partial: true, code: json.code, note: 'The invoice was not sent: its visit is closed, so the Invoices page send voided the invoice instead.' };
  }
  if (NOOP_SEND_KEYS.some((key) => json[key])) {
    const note = json.covered_by_credit ? 'Nothing was sent: account credit now covers this invoice.' : 'Nothing new was sent: the invoice was already delivered or is being delivered.';
    return { ...base, success: true, text, email, note };
  }
  const requested = [plan.text.startsWith('Text to') && text, plan.email.startsWith('Email to') && email].filter(Boolean);
  const allSent = requested.every((leg) => leg.status === 'sent');
  return { ...base, ...(allSent ? { success: true } : { partial: true }), text, email,
    note: allSent ? 'The invoice was sent.' : 'Part of the invoice send did not go out — see text and email.' };
}

async function commitSend(input, actionContext) {
  const pinned = input._verified_invoice_send_version;
  const { plan, refusal: refused } = await verifiedPlan(input, pinned, buildSendPlan, { what: 'send', changed: 'Nothing was sent' });
  if (refused) return refused;
  const { status, json } = await require('../../routes/admin-invoices').sendInvoiceFromBar({
    invoiceId: plan.invoice_id,
    // The Invoices page Send with no review decision taken for it: an ordinary
    // send (neither firstDelivery nor resend) and no review request.
    body: { requestReview: false },
    actor: { technicianId: actionContext?.technicianId || null },
    approvedSend: { expectedTotal: pinned.total_cents / 100 },
  });
  const result = sendOutcome(plan, status, json || {});
  logger.info(`[intelligence-bar:invoice-actions] send ${plan.invoice_id}: ${result.text?.status || 'n/a'} / ${result.email?.status || 'n/a'}`);
  return result;
}

// ── charge_invoice ──────────────────────────────────────────────

// Today's (ET) bar charges, in cents, from durable rows (see the header).
// excludeInvoiceId: the invoice being charged. Its own approval is consumed (result
// not yet recorded) while it runs, and a second charge of the same invoice is
// already fenced by the charge path's own claim, so its approvals never count here.
async function chargedTodayCents(database = db, { excludeInvoiceId = null, day = etDateString() } = {}) {
  const paid = await database('payments')
    .whereRaw("metadata->>'initiated_via' = 'intelligence_bar'")
    .where({ payment_date: day })
    .whereNotIn('status', ['failed', 'canceled', 'cancelled'])
    .sum({ total: 'amount' })
    .first();
  const uncertain = database('ib_pending_actions')
    .where({ tool_name: 'charge_invoice', status: 'confirmed' })
    .whereRaw("(consumed_at AT TIME ZONE 'America/New_York')::date = ?::date", [day])
    .where((b) => b.whereNull('result').orWhereRaw("result->>'outcome_unknown' = 'true'"));
  if (excludeInvoiceId) uncertain.whereRaw("COALESCE(params->>'invoice_id', '') <> ?", [String(excludeInvoiceId)]);
  const row = await uncertain.count({ n: '*' }).first();
  return toCents(paid?.total) + (Number(row?.n) || 0) * PER_CHARGE_CAP_CENTS;
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
function chargeLockGuard({ invoiceId, customerId }) {
  return async (trx, { totalCents }) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [CAP_LOCK_KEY]);
    const message = capRefusal(totalCents, await chargedTodayCents(trx, { excludeInvoiceId: invoiceId }));
    if (message) throw Object.assign(new Error(message), { code: 'IB_CHARGE_CAP' });
    // The route overrides a dispute hold (operatorOverride); the bar never does.
    await require('../collections/collection-hold').assertNoCollectionHold(customerId, trx);
  };
}

const cardLabel = (pm) => `${pm.card_brand || 'Card'} •••• ${pm.last_four || '????'}${pm.exp_month && pm.exp_year ? ` (exp ${String(pm.exp_month).padStart(2, '0')}/${String(pm.exp_year).slice(-2)})` : ''}`;

// The saved card the call names: an id or last 4, or the only card on file.
async function resolveCard(invoice, input) {
  const methods = await db('payment_methods').where({ customer_id: invoice.customer_id })
    .orderBy('is_default', 'desc').orderBy('created_at', 'desc');
  const { isBankMethodType } = require('../autopay-eligibility');
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
    const cards = methods.filter((m) => !isBankMethodType(m.method_type));
    if (!cards.length) return refusal('This customer has no saved card.', 'no_saved_card');
    if (cards.length > 1) {
      return refusal(`This customer has ${cards.length} saved cards: ${cards.map(cardLabel).join('; ')}. Say which card to charge.`, 'card_ambiguous',
        { cards: cards.map((m) => ({ payment_method_id: m.id, card: cardLabel(m) })) });
    }
    [picked] = cards;
  }
  if (isBankMethodType(picked.method_type)) {
    return refusal('The bar charges cards only. Charge a bank account from the Invoices page.', 'bank_method');
  }
  if (!picked.stripe_payment_method_id) return refusal('Payment method has no Stripe id', 'card_unusable');
  return { card: picked };
}

async function buildChargePlan(input) {
  const target = await resolveInvoice(input);
  if (target.error) return target;
  const { invoice } = target;
  const notCollectible = collectibleRefusal(invoice);
  if (notCollectible) return notCollectible;
  if (invoice.payer_id) {
    return refusal('Invoice is billed to a third-party payer — collect from the payer, not a saved card on the service account', 'payer_billed', { invoice_id: invoice.id });
  }
  // A saved-card charge already claimed or awaiting reconciliation (the charge
  // path's own fence) — the route's 409 text.
  const inFlight = await db('stripe_invoice_charge_attempts').where({ invoice_id: invoice.id })
    .whereIn('status', ['claimed', 'ambiguous']).whereNull('resolved_at').first('id');
  if (inFlight) {
    return refusal('A saved-card charge is already in progress or awaiting reconciliation. DO NOT charge again until an admin verifies it.', 'charge_in_progress', { invoice_id: invoice.id });
  }
  if (await disputeHold(invoice.customer_id)) {
    return refusal('Collection is on hold for this customer (billing dispute). Review before charging. The bar never overrides it; use the Invoices page.', 'collection_hold', { invoice_id: invoice.id });
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
  const usedCents = await chargedTodayCents(db, { excludeInvoiceId: invoice.id });
  const capMessage = capRefusal(totalCents, usedCents);
  if (capMessage) return refusal(capMessage, 'charge_limit', { invoice_id: invoice.id });
  const baseCents = toCents(quote.base);
  const surchargeCents = toCents(quote.surcharge);
  const creditNowCents = toCents(invoice.credit_applied);
  const creditAfterCents = toCents(quote.projectedCreditApplied);
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
    ...(creditAfterCents > creditNowCents ? { account_credit: `${money(creditAfterCents - creditNowCents)} of account credit is applied first` } : {}),
    surcharge: surchargeCents > 0
      ? `${money(surchargeCents)} card surcharge (${(Number(quote.rateBps) / 100).toFixed(2)}%)`
      : 'No card surcharge',
    total_charged: money(totalCents),
    receipt: 'After the charge succeeds, the customer gets the payment receipt by email and/or text per their receipt settings; a text waits for 8 AM–8 PM ET.',
    limits: `At most ${money(PER_CHARGE_CAP_CENTS)} per charge and ${money(DAILY_CAP_CENTS)} a day from the bar; ${money(usedCents)} charged from the bar today.`,
    _version: {
      invoice_id: invoice.id,
      status: invoice.status,
      total_cents: toCents(invoice.total),
      credit_cents: creditNowCents,
      due_cents: toCents(invoiceAmountDue(invoice)),
      invoice_version: msOf(invoice.updated_at),
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
      note: json.status === 'paid' ? `Charged ${amount}. The invoice is paid; the receipt is queued.` : `Charge of ${amount} is processing.`,
    };
  }
  const message = String(json.error || 'charge failed');
  // Stripe may have the money (orphan / ambiguous) or another charge owns the invoice: never a retry.
  if (json.orphan || json.ambiguous || json.in_progress) return { ...base, outcome_unknown: true, code: json.code, error: message };
  if (message.startsWith(CAP_REFUSAL_PREFIX)) return { ...base, blocked: true, code: 'charge_limit', error: `Nothing was charged: ${message}` };
  // Every other route refusal is pre-Stripe (stripe.js releases the claim): no money moved.
  return { ...base, error: `Nothing was charged: ${message}`, code: json.code || 'charge_refused', preview_changed: /changed|Review the updated total/i.test(message) };
}

async function commitCharge(input, actionContext) {
  const pinned = input._verified_invoice_charge_version;
  const { plan, refusal: refused } = await verifiedPlan(input, pinned, buildChargePlan, { what: 'charge', changed: 'Nothing was charged' });
  if (refused) return refused;
  const { status, json } = await require('../../routes/admin-invoices').chargeInvoiceFromBar({
    invoiceId: plan.invoice_id,
    // The Invoices page's own body: the saved card and the quoted total the
    // operator saw (the charge refuses any other total under its invoice lock).
    body: { paymentMethodId: pinned.payment_method_id, expectedTotal: pinned.charge_cents / 100 },
    actor: { technicianId: actionContext?.technicianId || null },
    chargeGuard: chargeLockGuard({ invoiceId: plan.invoice_id, customerId: plan.customer_id }),
  });
  const result = chargeOutcome(plan, status, json || {});
  logger.info(`[intelligence-bar:invoice-actions] charge ${plan.invoice_id}: ${result.payment_status || result.code || 'done'}`);
  return result;
}

// ── card lines (authorization-contract.js) ──────────────────────

function cardLines(toolName, preview) {
  if (!preview || preview.preview !== true) return [];
  const head = { kind: 'customer', text: `Invoice ${preview.invoice_number} — ${preview.customer_name || preview.customer_id}` };
  if (toolName === 'send_invoice') {
    return [
      head,
      { kind: 'billing', text: `Amount due: ${preview.amount_due} (invoice total ${preview.total})` },
      ...preview.lines.map((line) => ({ kind: 'billing', text: `Line: ${line}` })),
      { kind: 'comms', text: preview.text },
      { kind: 'comms', text: preview.email },
      { kind: 'operational', text: preview.send_note },
      { kind: 'operational', text: preview.review_request },
    ];
  }
  if (toolName === 'charge_invoice') {
    return [
      head,
      { kind: 'billing', text: `Card: ${preview.card}` },
      { kind: 'billing', text: `Invoice balance: ${preview.balance}` },
      ...(preview.account_credit ? [{ kind: 'billing', text: preview.account_credit }] : []),
      { kind: 'billing', text: `Surcharge: ${preview.surcharge}` },
      { kind: 'billing', text: `TOTAL CHARGED: ${preview.total_charged}` },
      { kind: 'billing', text: preview.limits },
      { kind: 'comms', text: preview.receipt },
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
  chargedTodayCents,
  chargeLockGuard,
  capRefusal,
  PER_CHARGE_CAP_CENTS,
  DAILY_CAP_CENTS,
};
