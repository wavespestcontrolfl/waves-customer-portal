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
    const gateLive = require('../config/feature-gates').payerInvoiceSmsLive;
    if (typeof gateLive !== 'function' || !gateLive()) {
      return result(false, 'gate_off', 'GATE_PAYER_INVOICE_SMS is off');
    }
    const dbh = database || db;
    const facts = await loadSendFacts(dbh, invoiceId);
    if (facts.skip) {
      logger.info(`[payer-invoice-sms] invoice ${invoiceId} not texted: ${facts.skip.code}`);
      return facts.skip;
    }
    const { invoice, payer, customer, to } = facts;
    const key = eventKeyFor(invoice.id, { emailMessageId, emailAcceptedAt });

    const payUrl = await shortenOrPassthrough(`${publicPortalUrl()}/pay/${invoice.token}`, {
      kind: 'invoice',
      entityType: 'invoices',
      entityId: invoice.id,
      customerId: customer.id,
      codePrefix: invoiceShortCodePrefix(invoice),
      channel: 'sms',
      purpose: MESSAGE_TYPE,
    });
    const body = buildPayerInvoiceBody({
      payer,
      customerFirstName: customer.first_name,
      serviceType: await serviceTypeOf(invoice),
      addressLine: await serviceAddressLine(invoice, customer),
      serviceDate: serviceDateText(invoice.service_date),
      payUrl,
    });

    const { sendCustomerMessage } = require('./messaging/send-customer-message');
    const outcome = await sendCustomerMessage({
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
      },
    });
    return await settleOutcome(dbh, outcome, invoice, payer);
  } catch (err) {
    logger.warn(`[payer-invoice-sms] invoice ${invoiceId} text failed: ${err.message}`);
    return result(false, 'error', err.message);
  }
}

module.exports = { sendPayerInvoiceText, buildPayerInvoiceBody, eventKeyFor, MESSAGE_TYPE, ENTRY_POINT };
