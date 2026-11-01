/**
 * Payer invoice text (GATE_PAYER_INVOICE_SMS, owner 2026-11-01: "payer invoices
 * also text the pay link to the payer's phone").
 *
 * When an invoice billed to a third-party Bill-To payer has been emailed to the
 * payer's AP inbox, the same pay link is also texted to the payer's `ap_phone`.
 * The homeowner never gets this link: invoice.js sendViaSMS still suppresses its
 * own text for a payer invoice (`payer_billed`), and this module sends ONLY to
 * the payer's AP phone, never to the customer's phone.
 *
 * The one hook is the tail of invoice-email.js sendInvoiceEmail (see there): the
 * point where the provider has ACCEPTED the payer-rerouted email. Every payer
 * invoice email passes it, whether an office send (invoice.js
 * sendViaSMSAndEmail), the automatic visit-completion send
 * (complete-scheduled-service.js sendPayerInvoiceToApIfEligible) or a resend.
 *
 * sendPayerInvoiceText never throws and never touches the invoice: a refused or
 * failed text is a logged result for the caller to ignore. The email's result,
 * the invoice's stamps and the send claim are exactly what they were.
 *
 * Identity: the policy purpose `payer_payment_link` proves the recipient is the
 * ACTIVE payer's ap_phone for this invoice's payer_id, read fresh from the DB at
 * the pipeline and again at the provider handoff (messaging/validators/
 * payer-recipient.js). STOP, quiet hours and the invoice SMS template kill switch
 * (message type `payer_invoice` maps to the `invoice_sent` row in admin-sms-templates.js, so
 * disabling the homeowner invoice text disables this one) apply as for every customer SMS.
 *
 * Quiet hours: an automatic send the 8 AM to 8 PM window holds is persisted on the existing scheduled-SMS rail
 * (queueHeldPayerText) and replayed at the window open through the registry entry payer_invoice_sms_deferred
 * (messaging/deferred-replay-registry.js). The replay re-runs every check above on fresh reads, requires the same payer and
 * AP phone, and sends under the same episode key, so it texts at most once per episode. An office send is exempt from the
 * window and is never queued.
 */

const db = require('../models/db');
const logger = require('./logger');
const { payerTextInvoiceProblem, last10 } = require('./messaging/validators/payer-recipient');
const { isValidNanpNumber, nanpNationalDigits } = require('../utils/phone');
const { etCalendarDayOf } = require('../utils/datetime-et');
const { publicPortalUrl } = require('../utils/portal-url');
const { shortenOrPassthrough, invoiceShortCodePrefix } = require('./short-url');

const MESSAGE_TYPE = 'payer_invoice';
const ENTRY_POINT = 'payer_invoice_sms';
// The scheduled-SMS registry entry a window-held text replays under (messaging/deferred-replay-registry.js).
const DEFERRED_ENTRY_POINT = 'payer_invoice_sms_deferred';

// Read at call time, live send and replay alike: unset is the kill switch, with no redeploy.
function gateLive() {
  const live = require('../config/feature-gates').payerInvoiceSmsLive;
  return typeof live === 'function' && live() === true;
}

const result = (sent, code, reason, extra = {}) => ({ sent, code, reason, ...extra });
const clean = (value) => String(value == null ? '' : value).trim();

// "Tuesday, November 3, 2026": the homeowner invoice_sent text's own {service_date} format
// (invoice.js invoiceSmsDateFacts), on the ET calendar day. '' when there is no usable date.
function serviceDateText(value) {
  try {
    const ymd = value ? etCalendarDayOf(value) : '';
    if (!ymd) return '';
    return new Date(`${ymd}T12:00:00`).toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York',
    });
  } catch {
    return '';
  }
}

// A company payer gets no first name ("Hello!"); a person gets the first word of display_name.
function greetingFor(payer) {
  if (clean(payer.company_name)) return 'Hello!';
  const first = clean(payer.display_name).split(/\s+/)[0].replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  return first ? `Hi ${first}!` : 'Hello!';
}

/**
 * The text, customer copy: unsigned, no dollar amount, the service name exactly as stored. A missing field drops its
 * phrase instead of printing a blank.
 * "Hi Pat! The invoice for Sam's One-Time Pest Control Service at 123 Palm Ave on Tuesday, November 3, 2026 is
 * ready: portal.wavespestcontrol.com/l/..."
 */
function buildPayerInvoiceBody({ payer, customerFirstName, serviceType, addressLine, serviceDate, payUrl }) {
  const owner = clean(customerFirstName) ? `${clean(customerFirstName)}'s ` : '';
  const service = clean(serviceType);
  const what = service ? `${owner}${service}` : `${owner ? owner : 'a '}recent service`;
  const parts = [`${greetingFor(payer)} The invoice for ${what}`];
  if (clean(addressLine)) parts.push(` at ${clean(addressLine)}`);
  if (clean(serviceDate)) parts.push(` on ${clean(serviceDate)}`);
  parts.push(` is ready: ${payUrl}`);
  return parts.join('');
}

// The street line the invoice email's Property row shows, without city/state/zip. billing-email-details resolves the
// right property (the visit's saved property, a staff correction, a packet's shared address). '' when it cannot.
// A held row's preview: the text as it will read, with the pay link replaced (buildPayerInvoiceBody always ends with
// " is ready: <link>"). The registered replay never sends this body; it composes the text again at the window open.
const HELD_PAY_LINK_PLACEHOLDER = '[pay link]';
const READY_MARKER = ' is ready: ';
function heldRowBody(body) {
  const text = String(body || '');
  const at = text.lastIndexOf(READY_MARKER);
  if (at < 0) return `Payer invoice text held for the send window. The pay link is added when it sends: ${HELD_PAY_LINK_PLACEHOLDER}`;
  return `${text.slice(0, at + READY_MARKER.length)}${HELD_PAY_LINK_PLACEHOLDER}`;
}

// A held payer text previews the payer's and customer's names and the service street, and it belongs to no technician's
// route: readers that list queued sms_log rows without a customer scope show these rows to the office only (the same
// rule as the recruiting texts, utils/recruiting-thread-scope.js). The registered replay sends them; no technician acts.
function hidePayerHoldsFromNonAdmin(query, req, messageTypeColumn = 'sms_log.message_type') {
  if (req && req.techRole === 'admin') return query;
  return query.where(function payerHoldFilter() {
    this.whereNull(messageTypeColumn).orWhere(messageTypeColumn, '<>', MESSAGE_TYPE);
  });
}

async function serviceAddressLine(invoice, customer) {
  try {
    const full = await require('./billing-email-details').invoicePropertyAddress(invoice, customer);
    return clean(String(full || '').split(',')[0]);
  } catch (err) {
    logger.warn(`[payer-invoice-sms] address lookup failed for invoice ${invoice.id}: ${err.message}`);
    return '';
  }
}

async function serviceTypeOf(invoice) {
  if (clean(invoice.service_type)) return clean(invoice.service_type);
  try {
    return clean((await require('./billing-email-details').invoiceServiceDetails(invoice)).label);
  } catch {
    return '';
  }
}

// One text per send episode. The existing claim (messaging/billing-text-leg-dedupe.js withBillingTextLegLock, which covers
// purpose payer_payment_link) runs the dedupe lookup and the send under one lock keyed on this key. The episode is the
// persisted email row: a provider-deduped email replay returns the ORIGINAL row, so a send and its replay share one key and
// the text is not repeated; a deliberate resend writes a new row and texts again. Without a row (the SMTP fallback, which
// has no replay) the episode is the instant the email was accepted.
function eventKeyFor(invoiceId, { emailMessageId, emailAcceptedAt } = {}) {
  if (emailMessageId) return `invoice:${invoiceId}:payer_sms:${emailMessageId}`;
  const at = emailAcceptedAt ? new Date(emailAcceptedAt) : new Date();
  const stamp = Number.isNaN(at.getTime()) ? new Date() : at;
  return `invoice:${invoiceId}:payer_sms:${stamp.toISOString()}`;
}

// The accepted sms_log row carries the payer and the invoice, so the text can be traced from either. Best effort: the
// text is already out.
async function stampLogRow(dbh, outcome, { payerId, invoiceId }) {
  const sid = outcome && outcome.providerMessageId;
  if (!sid || !/^(SM|MM)[a-f0-9]{32}$/i.test(sid)) return;
  try {
    await dbh('sms_log').where({ twilio_sid: sid }).update({
      metadata: dbh.raw('COALESCE(metadata, \'{}\'::jsonb) || ?::jsonb', [JSON.stringify({ payer_id: payerId, invoice_id: invoiceId })]),
    });
  } catch (err) {
    logger.warn(`[payer-invoice-sms] sms_log stamp failed for invoice ${invoiceId}: ${err.message}`);
  }
}

// Everything that decides whether a text may go, before anything is minted or sent. Returns { skip } or { invoice, payer,
// customer, to }.
async function loadSendFacts(dbh, invoiceId) {
  const invoice = await dbh('invoices').where({ id: invoiceId }).first();
  const problem = payerTextInvoiceProblem(invoice);
  if (problem) return { skip: result(false, problem.code.toLowerCase(), problem.reason) };
  const payer = await dbh('payers').where({ id: invoice.payer_id }).first();
  if (!payer || payer.active === false) return { skip: result(false, 'payer_inactive', 'The invoice payer is missing or inactive') };
  if (!clean(payer.ap_phone)) return { skip: result(false, 'payer_phone_missing', 'The payer has no AP phone') };
  if (!isValidNanpNumber(payer.ap_phone)) return { skip: result(false, 'payer_phone_invalid', 'The payer AP phone is not a valid US number') };
  if (!invoice.token) return { skip: result(false, 'no_pay_link', 'The invoice has no pay link') };
  const customer = await dbh('customers').where({ id: invoice.customer_id }).first();
  if (!customer) return { skip: result(false, 'customer_missing', 'The invoice customer was not found') };
  // The homeowner must never get a payer's pay link, even when the numbers were entered the same.
  if (last10(customer.phone) && last10(customer.phone) === last10(payer.ap_phone)) {
    return { skip: result(false, 'payer_phone_is_customer_phone', 'The payer AP phone is the customer\'s own phone') };
  }
  return { invoice, payer, customer, to: `+1${nanpNationalDigits(payer.ap_phone)}` };
}

// What the canonical send answered, as this module's result. Only an ACCEPTED provider handoff is a sent text.
async function settleOutcome(dbh, outcome, invoice, payer) {
  const o = outcome || {};
  // The claim in withBillingTextLegLock answers a concurrent or replayed call for this key with the first text's acceptance.
  if (o.sent === true && o.deduped === true) return result(false, 'already_texted', 'The payer was already texted for this send');
  // The provider reports a switched-off template as sent:true with deliveryOutcome 'not_sent' (twilio.js "template-disabled").
  if (o.sent === true && o.deliveryOutcome !== 'accepted') {
    const off = o.raw && o.raw.templateDisabled === true;
    return result(false, off ? 'template_disabled' : 'not_sent', off ? 'The invoice text template is switched off' : 'The text was not accepted');
  }
  if (o.sent === true) {
    await stampLogRow(dbh, o, { payerId: payer.id, invoiceId: invoice.id });
    return result(true, 'sent', 'Payer texted');
  }
  const code = o.code || 'not_sent';
  const reason = o.reason || o.error || 'The text was not sent';
  logger.warn(`[payer-invoice-sms] invoice ${invoice.id} text not sent: ${code} (${reason})`);
  return result(false, code, reason, o.deferred ? { deferred: true, nextAllowedAt: o.nextAllowedAt } : {});
}

// The text for these facts: a fresh pay link and the body. Run for the live send and again for a held text's replay, so
// the morning text carries the link and the names as they are then.
async function composePayerText(facts) {
  const { invoice, payer, customer } = facts;
  const payUrl = await shortenOrPassthrough(`${publicPortalUrl()}/pay/${invoice.token}`, {
    kind: 'invoice',
    entityType: 'invoices',
    entityId: invoice.id,
    customerId: customer.id,
    codePrefix: invoiceShortCodePrefix(invoice),
    channel: 'sms',
    purpose: MESSAGE_TYPE,
  });
  return buildPayerInvoiceBody({
    payer,
    customerFirstName: customer.first_name,
    serviceType: await serviceTypeOf(invoice),
    addressLine: await serviceAddressLine(invoice, customer),
    serviceDate: serviceDateText(invoice.service_date),
    payUrl,
  });
}

// The one canonical send, live and replayed: the same purpose, recipient, ids and episode key, so the pipeline's payer
// identity rule, verified STOP read, send window, template switch and the text claim run on both.
function sendPayerText(facts, body, key, { operatorInitiated = false, scheduledSmsLogId = null } = {}) {
  const { invoice, payer, customer, to } = facts;
  const { sendCustomerMessage } = require('./messaging/send-customer-message');
  return sendCustomerMessage({
    to,
    body,
    channel: 'sms',
    audience: 'customer',
    purpose: 'payer_payment_link',
    customerId: customer.id,
    invoiceId: invoice.id,
    entryPoint: ENTRY_POINT,
    ...(operatorInitiated ? { operatorInitiated: true } : {}),
    metadata: {
      original_message_type: MESSAGE_TYPE,
      notificationEventKey: key,
      payer_id: payer.id,
      invoice_id: invoice.id,
      // The executor finds a replay's provider row by this id (scheduled-sms-delivery.js acceptedScheduledSms).
      ...(scheduledSmsLogId ? { scheduled_sms_log_id: scheduledSmsLogId } : {}),
    },
  });
}

// An automatic send the 8 AM to 8 PM window held, with the time the window opens.
const isWindowHold = (o) => Boolean(o && o.sent !== true && o.code === 'QUIET_HOURS_HOLD' && o.deferred && o.nextAllowedAt);

/**
 * Persist a window-held payer text on the existing scheduled-SMS rail (Codex #7357 P2: the completion send does not come
 * back once the email is stamped, so a dropped hold meant no text at all). One sms_log row, status 'scheduled', for the
 * window open; the executor replays it through the registry entry payer_invoice_sms_deferred
 * (messaging/deferred-replay-registry.js), whose recheck and dispatch run checkHeldPayerText and then the same canonical
 * send under the same episode key. One row per episode: a second hold for the key (an email replay at night) finds the
 * first row under the key's transaction lock. Returns 'queued' or 'existing'; throws on a failed write.
 */
async function queueHeldPayerText(dbh, facts, { key, body, nextAllowedAt, emailMessageId }) {
  const runAt = new Date(nextAllowedAt);
  if (Number.isNaN(runAt.getTime())) throw new Error('hold has no usable window-open time');
  const { invoice, payer, customer, to } = facts;
  return dbh.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`${DEFERRED_ENTRY_POINT}:${key}`]);
    const existing = await trx('sms_log')
      .where({ customer_id: customer.id, message_type: MESSAGE_TYPE })
      .whereIn('status', ['scheduled', 'sending'])
      .whereRaw("metadata->>'entry_point' = ?", [DEFERRED_ENTRY_POINT])
      .whereRaw("metadata->>'notificationEventKey' = ?", [key])
      .first('id');
    if (existing) return 'existing';
    await trx('sms_log').insert({
      customer_id: customer.id,
      direction: 'outbound',
      from_phone: require('../config/twilio-numbers').getOutboundNumber(),
      // The payer's AP phone, frozen: the replay drops the text when the payer's phone has changed since.
      to_phone: to,
      // Never the bearer pay link: the scheduled queue is readable by every technician, and the replay composes a fresh
      // body (with a fresh link) at the window open, so the row only needs a readable preview.
      message_body: heldRowBody(body),
      status: 'scheduled',
      scheduled_for: runAt,
      message_type: MESSAGE_TYPE,
      metadata: JSON.stringify({
        entry_point: DEFERRED_ENTRY_POINT,
        // A worker that does not know this entry refuses the row instead of sending the frozen body unchecked.
        requires_registered_dispatch: true,
        replay_purpose: 'payer_payment_link',
        notificationEventKey: key,
        invoice_id: invoice.id,
        payer_id: payer.id,
        payer_ap_phone: last10(to),
        customer_id: customer.id,
        ...(emailMessageId ? { email_message_id: emailMessageId } : {}),
        original_block_code: 'QUIET_HOURS_HOLD',
        original_message_type: MESSAGE_TYPE,
      }),
    });
    return 'queued';
  });
}

// What the live send answers for a window hold: the text is persisted for the window open, or the write failed and it is
// lost (logged as an error: nothing else will send it).
async function holdForWindow(dbh, facts, { key, body, outcome, emailMessageId }) {
  try {
    const queued = await queueHeldPayerText(dbh, facts, { key, body, nextAllowedAt: outcome.nextAllowedAt, emailMessageId });
    logger.info(`[payer-invoice-sms] invoice ${facts.invoice.id} text held for the send window (${queued}) until ${outcome.nextAllowedAt}`);
    return result(false, 'held_for_window', 'Queued for the 8 AM send window', { deferred: true, nextAllowedAt: outcome.nextAllowedAt });
  } catch (err) {
    logger.error(`[payer-invoice-sms] invoice ${facts.invoice.id} held text could not be queued (${err.code || err.name || 'error'}); payer text not sent`);
    return result(false, 'hold_queue_failed', 'The held text could not be queued');
  }
}

/**
 * @param {Object} args
 * @param {string} args.invoiceId
 * @param {Object} [args.database]            a knex handle; the root pool by default
 * @param {boolean} [args.operatorInitiated]  an office send: the text may go outside the 8 AM to 8 PM window, like the invoice text
 * @param {string} [args.emailMessageId]     the persisted email_messages row of the accepted email (the dedupe episode)
 * @param {Date|string} [args.emailAcceptedAt] when the email was accepted: the episode only when there is no row
 * @returns {Promise<{ sent: boolean, code: string, reason: string }>} never throws
 */
async function sendPayerInvoiceText({ invoiceId, database, operatorInitiated, emailMessageId, emailAcceptedAt } = {}) {
  try {
    if (!gateLive()) return result(false, 'gate_off', 'GATE_PAYER_INVOICE_SMS is off');
    const dbh = database || db;
    const facts = await loadSendFacts(dbh, invoiceId);
    if (facts.skip) {
      logger.info(`[payer-invoice-sms] invoice ${invoiceId} not texted: ${facts.skip.code}`);
      return facts.skip;
    }
    const key = eventKeyFor(facts.invoice.id, { emailMessageId, emailAcceptedAt });
    const body = await composePayerText(facts);
    const outcome = await sendPayerText(facts, body, key, { operatorInitiated: operatorInitiated === true });
    if (operatorInitiated !== true && isWindowHold(outcome)) {
      return await holdForWindow(dbh, facts, { key, body, outcome, emailMessageId });
    }
    return await settleOutcome(dbh, outcome, facts.invoice, facts.payer);
  } catch (err) {
    logger.warn(`[payer-invoice-sms] invoice ${invoiceId} text failed: ${err.message}`);
    return result(false, 'error', err.message);
  }
}

/**
 * Why a held payer text must not go now, or null with the fresh facts. The live send's own skips (gate, invoice still
 * open with a balance, not void, not withdrawn, not on a statement, payer active with a valid AP phone that is not the
 * customer's), plus: the payer, the AP phone and the customer are the ones the row was queued for. A changed AP phone
 * drops the text; it never goes to the new number unasked, and never to the customer's phone. A failed read throws.
 */
async function checkHeldPayerText(meta = {}, { conn = db } = {}) {
  if (!gateLive()) return { problem: 'gate-off' };
  if (!meta.invoice_id || !meta.notificationEventKey || !meta.payer_ap_phone || !meta.customer_id) {
    return { problem: 'replay-meta-missing' };
  }
  const facts = await loadSendFacts(conn, meta.invoice_id);
  if (facts.skip) return { problem: facts.skip.code.replace(/_/g, '-') };
  if (String(facts.payer.id) !== String(meta.payer_id)) return { problem: 'payer-changed' };
  if (last10(facts.payer.ap_phone) !== String(meta.payer_ap_phone)) return { problem: 'payer-phone-changed' };
  if (String(facts.customer.id) !== String(meta.customer_id)) return { problem: 'customer-changed' };
  return { facts };
}

// Registry recheck (payer_invoice_sms_deferred): { eligible:false, reason } drops the row as stale_replay:<reason>.
async function recheckHeldPayerText(meta = {}, { conn = db } = {}) {
  const { problem } = await checkHeldPayerText(meta, { conn });
  return problem ? { eligible: false, reason: `payer-text-${problem}` } : { eligible: true };
}

const notSent = (code, reason, retryable) => ({ sent: false, blocked: true, deliveryOutcome: 'not_sent', code, reason, retryable });

/**
 * Registry dispatch (payer_invoice_sms_deferred): the replay of a held text. It never sends the frozen body: it re-runs
 * checkHeldPayerText on fresh reads, composes the text again and makes the same canonical send under the row's own
 * episode key, so the claim (withBillingTextLegLock) answers a second replay, or a replay after the same episode was
 * texted, with the first acceptance instead of a second text. Returns the canonical send outcome for the executor; a stale
 * row is a terminal not_sent, a failed read a retryable one.
 */
async function replayHeldPayerText(meta = {}) {
  let check;
  try {
    check = await checkHeldPayerText(meta);
  } catch (err) {
    logger.warn(`[payer-invoice-sms] held text for invoice ${meta.invoice_id || 'unknown'} recheck failed (${err.code || err.name || 'error'}); held for retry`);
    return notSent('PAYER_TEXT_CHECK_FAILED', 'Could not re-read the invoice payer', true);
  }
  if (check.problem) {
    logger.info(`[payer-invoice-sms] held text for invoice ${meta.invoice_id || 'unknown'} dropped: ${check.problem}`);
    return notSent('PAYER_TEXT_STALE', check.problem, false);
  }
  const { facts } = check;
  const body = await composePayerText(facts);
  const outcome = await sendPayerText(facts, body, meta.notificationEventKey, { scheduledSmsLogId: meta.scheduled_sms_log_id || null });
  if (outcome && outcome.sent === true && outcome.deduped !== true && outcome.deliveryOutcome === 'accepted') {
    await stampLogRow(db, outcome, { payerId: facts.payer.id, invoiceId: facts.invoice.id });
  }
  return outcome;
}

module.exports = {
  sendPayerInvoiceText,
  recheckHeldPayerText,
  replayHeldPayerText,
  buildPayerInvoiceBody,
  heldRowBody,
  hidePayerHoldsFromNonAdmin,
  eventKeyFor,
  MESSAGE_TYPE,
  ENTRY_POINT,
  DEFERRED_ENTRY_POINT,
};
