/**
 * Intelligence Bar — send an EXISTING invoice
 * server/services/intelligence-bar/invoice-action-tools.js
 *
 * Owner ruling 2026-10-07 (Q1): "Yes, limited — only an existing invoice; admin only." No invoice creation,
 * no amount edit, no charge, no refund, no void.
 *
 *   send_invoice — the Invoices page "Send" (POST /admin/invoices/:id/send),
 *                  run through admin-invoices.js sendInvoiceFromBar: the same
 *                  handler, so every refusal and message is the route's own. The bar sends ONE
 *                  text with the pay link and nothing else: no email, no PDF, no app push.
 *                  channel 'email' (GATE_IB_INVOICE_EMAIL, owner ruling 2026-10-31, gap #20): ONE invoice email (the
 *                  invoice.sent template, PDF attached, pay link) to the customer's invoice email address, with at most
 *                  one CC the operator names, and no text. The card shows the rendered email (pay link as a token) and
 *                  pins its digest, the template content hash and both addresses; the email leg refuses any drift.
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
const { maskPhone, maskEmail } = require('./closeout-repair-tools');
const { explicitBillingChannels } = require('../billing-delivery-channels');
const { assertInvoiceCollectible, invoiceAmountDue, neverRanVisitStatus, approvedInvoiceVersionDigest, digestOfFingerprint, invoiceSmsDigest, INVOICE_SMS_PAY_LINK_TOKEN } = require('../invoice-helpers');
const { planSendEffects, approvedCloseoutTarget, approvedLeadTargets, approvedFollowupCadence } = require('./invoice-action-effects');

const CARD_LINES_SHOWN = 4;

function invoiceActionsLive() {
  return require('../../config/feature-gates').ibInvoiceActionsLive() === true;
}

function invoiceEmailLive() {
  return require('../../config/feature-gates').ibInvoiceEmailLive() === true;
}

const TARGET_PROPS = {
  invoice_id: { type: 'string', format: 'uuid', description: 'The existing invoice (from get_customer_invoices)' },
  invoice_number: { type: 'string', description: 'The invoice number, e.g. WPC-2026-0534 (use instead of invoice_id)' },
};

const SEND_PROPS = {
  channel: { type: 'string', enum: ['text', 'email'], description: 'text (default): one text with the pay link. email: the invoice email (PDF attached, pay link) to the customer\'s invoice email address, and no text.' },
  cc_email: { type: 'string', description: 'channel email only: ONE extra address that gets a copy of the same email (CC). For this send only; never saved.' },
};

const INVOICE_ACTION_TOOLS = [
  {
    name: 'send_invoice',
    description: `Send ONE existing invoice to the customer BY TEXT: one text with the pay link, as the Invoices page "Send" does for the text leg. Or, with channel "email" (when emailing from the bar is switched on): ONE invoice email with the PDF and pay link to the customer's invoice email address, optionally copied (CC) to ONE more address in cc_email, and no text. The first call returns a PREVIEW and sends nothing: the invoice, the customer, the amount due, the lines, and the exact text or email with who it reaches (the customer's address masked). The operator approves on the confirmation card; the confirmed run re-checks all of it, refuses if anything changed, and reports whether the text or email went out.
Refused with the reason: invoice not found, paid, prepaid, void, refunded, canceled, a bank payment processing, billed to a third-party payer or a payer's monthly statement (or who owes it could not be checked), nothing due, a collections hold on the customer's billing messages, no usable phone (the bar can't send a text from here), a customer whose invoices go by app or email only, a pay-link text already scheduled. An email is also refused for: no invoice email address on file, a CC that is not one address or is the recipient's own, a customer whose invoices go by app or text only, emailing from the bar switched off. Never creates, edits, voids or refunds an invoice. No review request is sent. Admin only.
Takes invoice_id OR invoice_number, exactly one.
Use for: "text her the invoice", "send the invoice", "resend invoice WPC-2026-0534", "email the invoice and CC the property manager".`,
    input_schema: { type: 'object', properties: { ...TARGET_PROPS, ...SEND_PROPS } },
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

// The lines the customer's PDF lists (pdf/invoice-pdf.js visibleInvoiceLines + invoiceLineParts, the PDF's own filter and numbers),
// as "description [qty x rate] amount". The card shows the first few and the rest under its "Show more" (cardLines); the lines are
// hashed into the approval (version_digest covers every line), so the operator approves all of them.
function lineSummary(raw) {
  const { visibleInvoiceLines, invoiceLineParts } = require('../pdf/invoice-pdf');
  return visibleInvoiceLines(raw).map((item) => {
    const { description, qty, rate, amount } = invoiceLineParts(item);
    const label = String(description || item?.name || 'Line').replace(/\s+/g, ' ').trim();
    return `${label}${qty !== 1 ? ` (${qty} x ${money(toCents(rate))})` : ''} ${money(toCents(amount))}`;
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
  } catch (err) {
    if (err?.code === 'lead_effects_unverified') {
      return refusal(`This invoice could not be ${whatFailed} right now: the leads it would mark won could not be read. Try again in a minute.`, 'lead_effects_unverified', { invoice_id: invoice.id });
    }
    return refusal(`This invoice could not be ${whatFailed} right now: what it would also do could not be checked.`, 'effects_check_failed', { invoice_id: invoice.id });
  }
}

// The plan's effects as card lines (the card shows each one; effects with nothing to say are pinned only).
const cardEffects = (effects) => effects.filter((e) => e.line).map(({ key, line, kind }) => ({ key, text: line, kind }));

// ── send_invoice ────────────────────────────────────────────────

// The invoice's own words the customer can read at the pay link: the notes printed on the invoice (invoices.notes). The card
// quotes them in full; a longer text is refused, never cut. (The personal message, invoices.email_message, is carried by the
// email only; the bar sends no email.)
const CUSTOM_COPY_LIMIT = 600;
function customerCopy(invoice) {
  const notes = String(invoice.notes || '').trim();
  if (notes.length > CUSTOM_COPY_LIMIT) {
    return refusal(`The invoice notes are longer than the card can show (${CUSTOM_COPY_LIMIT} characters), so the bar can\'t send this invoice from here.`, 'invoice_copy_too_long', { invoice_id: invoice.id });
  }
  return { lines: [notes ? `Notes on the invoice: "${notes}"` : 'No notes on the invoice.'] };
}

// The customer's invoice delivery choice, on the handle the claim or the handoff holds: unchanged from the card (pinned digest)
// and still something a plain text honors. Returns the refusal text, or null; a read that fails refuses.
async function channelRefusalText(invoice, database, pinnedDigest, channel = 'text') {
  try {
    const { state, supported } = await billingChannelState(invoice.customer_id, database, channel);
    if (!supported) return channel === 'email' ? CHANNEL_EMAIL_UNSUPPORTED_TEXT : CHANNEL_UNSUPPORTED_TEXT;
    return digest(state) === pinnedDigest ? null : 'How this customer gets invoices changed after the card was shown, so it was not sent.';
  } catch {
    return 'The bar could not re-check how this customer gets invoices, so it was not sent.';
  }
}

// Who owes the invoice RIGHT NOW. invoices.payer_id / payer_statement_id are a snapshot from when the invoice was
// minted: a payer assigned afterwards (the scheduled service, or the customer's default payer) leaves both empty. The
// canonical resolver (invoice-payer-ownership.js) reads the stamps and the live Bill-To. Only a verified customer-owned
// invoice is sent; a payer-owned one, or an answer that cannot be verified, is refused (fail closed). Returns the refusal
// text, or null. Also run by the send claim (verifyOwner below), on the claimed row.
const PAYER_OWNED_TEXT = 'This invoice is billed to a payer, not the customer, so the bar can\'t send it from here yet.';
const OWNER_UNVERIFIED_TEXT = 'The bar could not verify who owes this invoice, so it can\'t send it from here. Nothing was sent.';
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
const ANNUAL_PLAN_TEXT = 'This is an annual-plan invoice, and the bar can\'t send those from here yet.';
const ANNUAL_PLAN_UNVERIFIED_TEXT = 'The bar could not verify whether this is an annual-plan invoice, so it can\'t send it from here. Nothing was sent.';
async function annualPlanRefusalText(invoice, database = db) {
  try {
    return (await require('../invoice-prepay').resolveInvoiceTermId(invoice, database, { strict: true })) ? ANNUAL_PLAN_TEXT : null;
  } catch {
    return ANNUAL_PLAN_UNVERIFIED_TEXT;
  }
}

// The send refusals the bar checks before reading recipients (the route's own
// text where the route has one), or null.
// The page's Schedule send stores the time on the invoice itself (status 'scheduled' + scheduled_send_at), not as a queued text.
// Claiming it would silently cancel that delivery, so the bar refuses and names the time. A parked row (no time) is not queued.
const scheduledSendMessage = (invoice) => `A send is already scheduled for ${etWhen(invoice.scheduled_send_at)}, and the bar can\'t change or cancel a scheduled send from here. Let it send.`;
function scheduledSendRefusal(invoice) {
  if (invoice.status !== 'scheduled' || !invoice.scheduled_send_at) return null;
  return refusal(scheduledSendMessage(invoice), 'invoice_send_queued', { invoice_id: invoice.id });
}
// The same answer under the send claim, as { code, message } (the claim hands the row back with that code). The claim passes the
// row's prior status and scheduled_send_at.
function scheduledSendClaimRefusal(claimed) {
  return claimed.status === 'scheduled' && claimed.scheduled_send_at
    ? { code: 'invoice_send_queued', message: scheduledSendMessage(claimed) } : null;
}

// The totals rows depend on the customer too (a tax row only for a commercial property). The digest of the rows the card shows is
// pinned, and the claim recomputes it from the live customer row.
const totalsDigest = (invoice, customer) => digest(totalsOf(invoice, customer).totals);
async function totalsRefusalText(claimed, database, pinnedDigest) {
  const customer = await database('customers').where({ id: claimed.customer_id }).first();
  return totalsDigest(claimed, customer) === pinnedDigest ? null : 'The totals the card showed changed (the customer record changed), so nothing was sent.';
}

async function sendRefusal(invoice, dueCents) {
  const notCollectible = collectibleRefusal(invoice);
  if (notCollectible) return notCollectible;
  const at = { invoice_id: invoice.id };
  const scheduled = scheduledSendRefusal(invoice);
  if (scheduled) return scheduled;
  if (invoice.payer_statement_id) return refusal('Invoice is billed on the payer’s monthly statement; not sent individually.', 'payer_statement', at);
  const ownerText = await ownerRefusalText(invoice);
  if (ownerText) return refusal(ownerText, 'payer_owned', at);
  if (dueCents <= 0) return refusal('Nothing is due on this invoice, so there is no pay link to send.', 'nothing_due', at);
  // An annual-plan invoice's send re-enters under the renewal gate, which does not
  // carry the bar's approved total or its no-credit rule: it stays on the Invoices page.
  const planText = await annualPlanRefusalText(invoice);
  // A lookup that failed is an outage, not the annual-plan gap (Codex #6371 r16).
  if (planText) return refusal(planText, planText === ANNUAL_PLAN_UNVERIFIED_TEXT ? 'invoice_lookup_failed' : 'annual_plan_invoice', at);
  // A linked visit that never ran: the route's own refusal text. (If it is cancelled
  // after this check, the send refuses under its claim and never voids for the bar.)
  const visitId = await require('../invoice').linkedScheduledServiceId(invoice, db);
  const visit = visitId ? await db('scheduled_services').where({ id: visitId }).first('status') : null;
  const terminal = neverRanVisitStatus(visit?.status);
  if (terminal) {
    return refusal(`Linked visit is ${terminal}; delivery not attempted. The bar can\'t void or keep this invoice from here yet.`, 'visit_terminal', at);
  }
  if (await messagingHold(invoice.customer_id)) {
    return refusal('This customer has a collections hold on billing messages. The bar can\'t override a collections hold from here yet.', 'collection_hold', at);
  }
  return null;
}

// The text exactly as sendViaSMS renders it (invoice.js renderInvoiceSmsBody, base template row, pay link as a token).
async function smsRender(invoice, customer) {
  return require('../invoice').renderInvoiceSmsBody(invoice, customer || {}, INVOICE_SMS_PAY_LINK_TOKEN, { noVariants: true, audit: false });
}

// The totals the PDF prints under the lines (pdf/invoice-pdf.js invoiceBreakdownRows), for the card.
function totalsOf(invoice, customer) {
  return { totals: require('../pdf/invoice-pdf').invoiceBreakdownRows(invoice, customer) };
}

// How the customer chose to get invoices (notification_prefs.invoice_channels; invoice_channel for a customer who never chose).
// The bar sends a plain text, or (channel 'email') a plain email: an App selection, or a selection without the channel the bar
// sends, is not something it can honor, so it is refused. A customer who never chose gets the invoice email whenever an address
// is on file (billing-delivery-channels legacyChannels), so only a legacy App choice refuses. Read on `database` (the claim
// passes its locked handle). Returns { state, supported }.
const CHANNEL_UNSUPPORTED_TEXT = 'This customer gets invoices in the app or by email only, not by text, so the bar can\'t send it from here (it sends texts only).';
const CHANNEL_EMAIL_UNSUPPORTED_TEXT = 'This customer gets invoices in the app or by text only, not by email, so the bar can\'t email it from here.';
async function billingChannelState(customerId, database = db, channel = 'text') {
  const prefs = await database('notification_prefs').where({ customer_id: customerId }).first('invoice_channels', 'invoice_channel');
  const explicit = explicitBillingChannels(prefs || {}, 'invoice');
  const legacy = explicit === null ? String(prefs?.invoice_channel || 'sms').toLowerCase() : null;
  const wanted = channel === 'email' ? 'email' : 'sms';
  const supported = explicit === null ? legacy !== 'push' : (explicit.includes(wanted) && !explicit.includes('push'));
  return { state: { explicit, legacy }, supported };
}

// A pay-link text already queued for the send window (or mid-send) owns this invoice's delivery: the bar never adopts or
// cancels it, so the card refuses and names the time. The send claim refuses it too (adoptsQueuedInvoiceSend: false).
function etWhen(value) {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return 'the send window';
  const { formatETDate, formatETTime } = require('../../utils/datetime-et');
  return `${formatETDate(at)} ${formatETTime(at)} ET`;
}
function queuedSendRefusal(invoiceId, queued) {
  return refusal(`A pay-link text is already scheduled${queued.scheduled_for ? ` for ${etWhen(queued.scheduled_for)}` : ''}. Let it send. The bar can\'t change or cancel it from here.`, 'invoice_send_queued', { invoice_id: invoiceId });
}

// The one text the bar can send, or the refusal: the customer's phone with a text template that renders, a delivery choice
// that includes Text and no App, and no queued pay-link text.
async function deliverableText(invoice, customer, who) {
  const at = { invoice_id: invoice.id };
  const rawPhone = who.primaryContact?.phone || null;
  const rendered = rawPhone ? await smsRender(invoice, customer) : null;
  if (!rawPhone || !rendered?.body) {
    return refusal(rawPhone
      ? 'The invoice text template is switched off, so the bar can\'t send a text from here.'
      : 'No usable phone is on file, so the bar can\'t send a text from here.', 'invoice_no_channel', at);
  }
  let channels;
  try {
    channels = await billingChannelState(invoice.customer_id);
  } catch {
    return refusal('The bar could not check how this customer gets invoices, so it can\'t offer a send from here.', 'invoice_lookup_failed', at);
  }
  if (!channels.supported) return refusal(CHANNEL_UNSUPPORTED_TEXT, 'invoice_channel_unsupported', at);
  const queued = await require('../invoice').queuedPayLinkText(invoice.id, { adoptsQueuedInvoiceSend: false });
  if (queued) return queuedSendRefusal(invoice.id, queued);
  return {
    rendered, channelsState: channels.state, phone: rawPhone,
    text: `Text to ${maskPhone(rawPhone)}: "${rendered.body}" Not sent if the customer opted out of texts.`,
  };
}

// The channel and CC the call asks for, or the refusal. A CC goes with an email only, one address, never the recipient's own.
const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function sendChannel(input) {
  const channel = input?.channel == null || input.channel === '' ? 'text' : String(input.channel).trim().toLowerCase();
  if (channel !== 'text' && channel !== 'email') return refusal('channel must be text or email', 'invalid_channel');
  const rawCc = input?.cc_email;
  const hasCc = rawCc != null && rawCc !== '';
  if (hasCc && channel !== 'email') return refusal('A CC goes with an email only: ask for the email (channel email).', 'cc_needs_email');
  if (channel === 'email' && !invoiceEmailLive()) {
    return refusal('Emailing invoices from the bar is switched off. The bar can text it, or use the Invoices page Send.', 'gate_off');
  }
  const cc = hasCc && typeof rawCc === 'string' ? rawCc.trim().toLowerCase() : null;
  if (hasCc && !(cc && EMAIL_LIKE.test(cc))) return refusal('The CC must be one email address.', 'invalid_cc');
  return { channel, cc };
}

// The email sender's own refusal of the card's build, in the bar's words.
const NO_ADDRESS_ERRORS = new Set(['No invoice recipient email', 'Invalid invoice recipient email']);
function emailBuildRefusal(built, at) {
  const text = NO_ADDRESS_ERRORS.has(built?.error)
    ? 'No usable invoice email address is on file, so the bar can\'t email it from here.'
    : `The bar can't email this invoice from here: ${built?.error || 'the email could not be built'}.`;
  return refusal(text, built?.code || 'invoice_no_channel', at);
}

// The one email the bar can send, or the refusal: an invoice email address, a delivery choice that includes Email and no App, no
// queued pay-link text, and the email itself built by the sender's own code (invoice-email.js previewOnly: same recipient, CC
// handling, payload and template; pay link as a token; nothing written).
async function deliverableEmail(invoice, cc) {
  const at = { invoice_id: invoice.id };
  let channels;
  try {
    channels = await billingChannelState(invoice.customer_id, db, 'email');
  } catch {
    return refusal('The bar could not check how this customer gets invoices, so it can\'t offer a send from here.', 'invoice_lookup_failed', at);
  }
  if (!channels.supported) return refusal(CHANNEL_EMAIL_UNSUPPORTED_TEXT, 'invoice_channel_unsupported', at);
  const queued = await require('../invoice').queuedPayLinkText(invoice.id, { adoptsQueuedInvoiceSend: false });
  if (queued) return queuedSendRefusal(invoice.id, queued);
  const built = await require('../invoice-email').sendInvoiceEmail(invoice.id, { previewOnly: true, ...(cc ? { cc } : {}) });
  if (!built?.ok || !built.email) return emailBuildRefusal(built, at);
  const to = String(built.recipient?.email || '').toLowerCase();
  if (cc && !built.cc.includes(cc)) return refusal('The CC is the same address the email goes to.', 'invalid_cc', at);
  const { subject, text: body, contentHash, digest: emailDigest } = built.email;
  return {
    channelsState: channels.state, to, cc, subject, body, contentHash, emailDigest,
    text: `Email to ${maskEmail(to)}${cc ? `, CC ${cc}` : ''}, subject "${subject}", with the invoice PDF attached and the pay link. Not sent if either address is on the email suppression list.`,
  };
}

// opts.forSend: the confirmed run also gets the exact phone (never on the card or in a model-visible result) to hand the send
// as its approved pin.
async function buildSendPlan(input, { forSend = false } = {}) {
  const asked = sendChannel(input);
  if (asked.error) return asked;
  const target = await resolveInvoice(input);
  if (target.error) return target;
  const { invoice } = target;
  const dueCents = toCents(invoiceAmountDue(invoice));
  const refused = await sendRefusal(invoice, dueCents);
  if (refused) return refused;
  const who = await require('../../routes/admin-invoices').getInvoiceDeliveryRecipients(invoice.id);
  if (!who) return refusal('Invoice not found', 'invoice_not_found');
  // The customer row is read once: the text renders for it, and the effects plan uses it.
  const customer = await db('customers').where({ id: invoice.customer_id }).first();
  const byEmail = asked.channel === 'email';
  const legs = byEmail ? await deliverableEmail(invoice, asked.cc) : await deliverableText(invoice, customer, who);
  if (legs.error) return legs;
  const { rendered } = legs;
  const copy = customerCopy(invoice);
  if (copy.error) return copy;
  const totalCents = toCents(invoice.total);
  // Everything the send also does after it delivers: one list, from the handler's own predicates.
  const planned = await planEffectsOrRefuse(() => planSendEffects(invoice, customer, { requestReview: false }), invoice, 'sent');
  if (planned.error) return planned;
  const recipients = byEmail ? { email: legs.to, cc: legs.cc } : { phone: String(legs.phone).replace(/\D/g, '') };
  return {
    ...(forSend ? { sendRecipients: recipients } : {}),
    channel: asked.channel,
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
    channels: byEmail ? 'email' : 'text',
    text: legs.text,
    // The whole email as the customer reads it (pay link as a token), under the card's "Show more".
    ...(byEmail ? { email_body: legs.body } : {}),
    ...totalsOf(invoice, customer),
    // The invoice notes the customer can read at the pay link, verbatim.
    custom_copy: copy.lines,
    effects: cardEffects(planned.effects),
    // The delivery effect's sentence, for the confirmation card's summary.
    send_note: planned.effects.find((e) => e.key === 'delivery').line,
    // The visit the closeout effect named (or 'none'). Kept out of the approval fingerprint (`_` key): the effects digest in
    // _version already pins the closeout's state, and the confirmed run hands the send this re-derived target.
    _closeout_target: approvedCloseoutTarget(planned.effects),
    _lead_targets: approvedLeadTargets(planned.effects),
    _followup_cadence: approvedFollowupCadence(planned.effects),
    _version: {
      invoice_id: invoice.id,
      status: invoice.status,
      total_cents: totalCents,
      due_cents: dueCents,
      invoice_version: msOf(invoice.updated_at),
      // Amount due, credit and lines: the claim refuses a row that no longer matches.
      version_digest: approvedInvoiceVersionDigest(invoice),
      sent: msOf(invoice.sent_at),
      // A send the page scheduled (null: none, or the card would have refused).
      scheduled_send_at: msOf(invoice.scheduled_send_at),
      // The totals rows the card shows (they depend on the customer's property type).
      totals: totalsDigest(invoice, customer),
      first_delivery: planned.effects.find((e) => e.key === 'delivery').state === 'first',
      // Every post-delivery effect (closeout, lead, reminders, review ...): a change is drift.
      effects: planned.digest,
      // The attachment list the pay page shows (the same files the attachments effect pins).
      attachments: digestOfFingerprint(planned.effects.find((e) => e.key === 'attachments').state),
      recipients: digest(recipients),
      // How the customer chose to get invoices (the bar sends a plain text only): a change after the card refuses, here and
      // under the send claim.
      billing_channels: digest(legs.channelsState),
      // The text the card shows (template that renders + body, pay link as a token). The text leg re-checks the body it is
      // about to hand the provider against this, so a template edited after the card is not sent.
      ...(byEmail ? {
        channel: 'email',
        // The email the card shows (subject, text, template content hash; pay link as a token) and the template itself: the
        // email leg re-renders and refuses a different email, and sendTemplate refuses a different template.
        email_text: legs.emailDigest,
        email_content_hash: legs.contentHash,
      } : { sms_text: invoiceSmsDigest(rendered, INVOICE_SMS_PAY_LINK_TOKEN) }),
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

// A pay-link text queued for the send window blocks the send (the claim refuses it, the bar never adopts it). The reply names
// the scheduled time when the row can still be read.
const QUEUED_SEND_CODE = 'queued_pay_link';
async function queuedSendAnswer(plan) {
  let queued = null;
  try { queued = await require('../invoice').queuedPayLinkText(plan.invoice_id, { adoptsQueuedInvoiceSend: false }); } catch { /* the time is a nicety */ }
  const refused = queued ? queuedSendRefusal(plan.invoice_id, queued)
    : refusal('A pay-link text is already scheduled for this invoice. Let it send. The bar can\'t change or cancel it from here.', 'invoice_send_queued', { invoice_id: plan.invoice_id });
  return { invoice_id: plan.invoice_id, invoice_number: plan.invoice_number, error: `Nothing was sent: ${refused.error}`, code: 'invoice_send_queued', failed: true };
}

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
// over c = { base, status, json, text, unknown, sent }.
const SEND_OUTCOME_RULES = [
  // A pay-link text is queued for the send window: the claim refused it (409), or a first delivery reported it queued (200).
  // Nothing was sent; the answer is built in sendOutcomeFor (it names the time).
  [(c) => (c.status === 409 && c.json.code === QUEUED_SEND_CODE) || c.json.queued_delivery || c.json.sms?.code === QUEUED_SEND_CODE,
    (c) => ({ ...c.base, __queued: true })],
  // The route's own pre-delivery refusals (nothing claimed, nothing sent): a fresh card is fine.
  [(c) => c.status === 409 && DEFINITIVE_SEND_CONFLICT_CODES.has(c.json.code),
    (c) => ({ ...c.base, error: `Nothing was sent: ${c.json.error || 'the invoice is busy'}`, code: c.json.code, preview_changed: true })],
  // Any other conflict means another request owns the live send claim: that delivery may still finish.
  // Uncertain and not retryable, no fresh card (a retry could send it twice).
  [(c) => c.status === 409 || c.json.in_progress,
    (c) => ({ ...c.base, outcome_unknown: true, code: (c.status === 409 && c.json.code) || 'delivery_in_progress', error: IN_PROGRESS_SEND_MESSAGE })],
  // The message went out but the app could not record the invoice as sent (the finalization rolled back): never a retry.
  [(c) => c.json.code === 'INVOICE_DELIVERY_RECORD_FAILED',
    (c) => ({ ...c.base, outcome_unknown: true, code: c.json.code, text: c.text,
      error: 'The invoice went out, but the app could not record it as sent. Check the invoice by hand and do not send it again.' })],
  // Nothing was sent and the invoice is as it was, but the visit closeout pin could not be retired: the visit will not close
  // by itself (a person closes it). Not a retry-and-forget failure.
  [(c) => c.json.code === 'INVOICE_CLOSEOUT_PIN_RETIRE_FAILED',
    (c) => ({ ...c.base, failed: true, code: c.json.code, text: c.text,
      error: 'The invoice was not sent, but the visit closeout record could not be cleared. The visit will not close by itself: close it by hand.' })],
  [(c) => c.unknown && !c.sent,
    (c) => ({ ...c.base, outcome_unknown: true, code: c.json.code || 'delivery_uncertain', text: c.text,
      error: 'Delivery of the invoice could not be confirmed — it may or may not have gone out. Check before sending again.' })],
  // A writer held the customer's comms or phone lock at the final handoff (nothing sent, the invoice as it was): try again.
  [(c) => (c.json.sms?.code || c.json.code) === 'recipient_busy',
    (c) => ({ ...c.base, failed: true, code: 'recipient_busy', text: c.text,
      error: "The customer's contact details are being changed, so the text was not sent. Try again in a minute." })],
  // Both channels failed (or the route refused before sending). The invoice changed after the card was
  // shown (nothing claimed or sent): a fresh card is right.
  [(c) => c.status !== 200,
    (c) => ({ ...c.base, error: `The invoice was not sent: ${c.json.error || 'send failed'}`, code: c.json.code || 'send_failed', failed: true,
      ...(['approved_version_changed', 'total_changed', 'recipient_changed', 'sms_text_changed', 'email_content_changed'].includes(c.json.code || c.leg?.code) ? { preview_changed: true } : {}), text: c.text })],
  [(c) => NOOP_SEND_KEYS.some((key) => c.json[key]),
    (c) => ({ ...c.base, success: true, text: c.text,
      note: c.json.covered_by_credit ? 'Nothing was sent: account credit now covers this invoice.' : 'Nothing new was sent: the invoice was already delivered or is being delivered.' })],
  [(c) => c.text.status === 'sent',
    (c) => ({ ...c.base, success: true, text: c.text,
      note: [`The invoice ${c.what} was sent.`, c.text.warning].filter(Boolean).join(' ') })],
  [() => true,
    (c) => ({ ...c.base, failed: true, text: c.text, code: c.leg?.code || c.json.code || 'send_failed',
      error: `The invoice ${c.what} did not go out.` })],
];

// c.text is the sent leg's outcome: the text, or (channel 'email') the email, reported under `email`.
function sendOutcome(plan, status, json = {}) {
  const byEmail = plan.channel === 'email';
  const leg = byEmail ? json.email : json.sms;
  const text = channelResult(leg);
  const c = {
    base: { invoice_id: plan.invoice_id, invoice_number: plan.invoice_number },
    status, json, text, leg, what: byEmail ? 'email' : 'text',
    unknown: UNCERTAIN_SEND_CODES.has(json.code) || text.status === 'unknown',
    sent: text.status === 'sent',
  };
  const result = SEND_OUTCOME_RULES.find(([applies]) => applies(c))[1](c);
  if (!byEmail || !('text' in result)) return result;
  const { text: emailResult, ...rest } = result;
  return { ...rest, email: emailResult };
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
      // 'email': the email leg only, copied to the card's one CC (or none).
      channel: plan.channel,
      cc: plan.channel === 'email' ? plan.sendRecipients.cc : null,
      version: {
        updatedAtMs: pinned.invoice_version,
        digest: pinned.version_digest,
        // The approved attachment list (checked by the send claim).
        attachments: pinned.attachments,
        // The text the card showed; the text leg refuses a different body at its provider handoff. Or the email the card
        // showed and its template: the email leg refuses a different email or template before the provider call.
        ...(plan.channel === 'email'
          ? { emailDigest: pinned.email_text, emailContentHash: pinned.email_content_hash }
          : { smsDigest: pinned.sms_text }),
        // The visit the card said would close (or none): handed to the send's closeout, and written on the invoice
        // by the claim so the retry sweep keeps to it.
        closeoutTarget: plan._closeout_target,
        // The leads the card said this send marks won (or none): the conversion after delivery touches those and no others.
        leadTargets: plan._lead_targets,
        // The reminder cadence the card listed: the reminders are armed from it even if the ladder gate flips after the claim.
        followupCadence: plan._followup_cadence,
        // Run by the send claim on the claimed row, and again at the text's provider handoff: who owes the invoice must still
        // be the customer, it must still not be an annual-plan invoice (resolved as the pay page does; a failed lookup
        // refuses), and the customer's invoice delivery choice must still be the one the card showed (text or email, never app).
        verifyOwner: async (claimed, database) => (await ownerRefusalText(claimed, database))
          || (await annualPlanRefusalText(claimed, database))
          || (await channelRefusalText(claimed, database, pinned.billing_channels, plan.channel))
          || (await totalsRefusalText(claimed, database, pinned.totals))
          || scheduledSendClaimRefusal(claimed),
        // Run by the send claim on the claimed row: the post-delivery effects the card listed must be unchanged.
        verifyEffects: async (claimed, database) => (await planSendEffects(claimed, await database('customers').where({ id: claimed.customer_id }).first(), { database, requestReview: false })).digest === pinned.effects,
      },
    },
  });
  let result = sendOutcome(plan, status, json || {});
  if (result.__queued) result = await queuedSendAnswer(plan);
  logger.info(`[intelligence-bar:invoice-actions] send ${plan.invoice_id} (${plan.channel}): ${(result.text || result.email)?.status || result.code || 'n/a'}`);
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
      // What the PDF's totals block prints under the lines (the lines above are the PDF's rows).
      ...(preview.totals || []).map((text) => ({ kind: 'billing', text })),
      { kind: 'comms', text: preview.text },
      // The whole email under "Show more" (the email card only).
      ...(preview.email_body ? [{ kind: 'comms', text: `Email text: ${String(preview.email_body).replace(/\s+/g, ' ').trim()}`, more: true }] : []),
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
