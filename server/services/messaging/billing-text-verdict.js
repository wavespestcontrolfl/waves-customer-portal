'use strict';

/**
 * Would the canonical invoice / receipt Text be sent to this customer right now?
 *
 * The combined-visit summary text may carry an invoice's pay link or receipt
 * link in place of the invoice sender's own text (visit-completion-summary.js).
 * That is only equivalent when the canonical text would have gone out, so this
 * asks the same authorities the senders ask, on the same input the senders
 * build (InvoiceService.sendViaSMS / sendReceipt), instead of re-deriving them:
 *  - the messaging pipeline's own suppression and consent validators for the
 *    payment_link / payment_receipt purpose (STOP, the per-notice toggles, the
 *    customer's billing channel choice, and the legacy email-only channel with
 *    or without a deliverable email);
 *  - the SMS template kill switch (admin-sms-templates isTemplateActive);
 *  - for a pay link, the account-credit seam (customer-credit): credit the
 *    sender would draw first means a full-price link would be wrong.
 * An App leg selected beside Text is refused: the fold covers the Text leg
 * only. `database` is the caller's connection (the handoff transaction under
 * its held rows, or the pool at plan time); nothing else is opened.
 */
const { loadContactState, checkConsentForPurpose } = require('./validators/consent');
const { loadSuppressionState, checkSuppression } = require('./validators/suppression');
const { resolvePolicy } = require('./policy');
const { explicitBillingChannels } = require('../billing-delivery-channels');

const SENDER_SHAPE = Object.freeze({
  pay_link: { purpose: 'payment_link', messageType: 'invoice', category: 'invoice' },
  receipt: { purpose: 'payment_receipt', messageType: 'receipt', category: 'payment_receipt' },
});

async function billingTextVerdict(kind, invoice, { phone, database }) {
  const shape = SENDER_SHAPE[kind];
  if (!shape) return { ok: false, reason: 'unknown_kind' };
  const input = {
    audience: 'customer', channel: 'sms', purpose: shape.purpose, customerId: invoice.customer_id,
    invoiceId: invoice.id, to: phone, hasEmailLeg: true,
    metadata: { original_message_type: shape.messageType, billingDeliveryCategory: shape.category },
  };
  const policy = resolvePolicy('customer', shape.purpose);
  let state = await loadContactState(input, database);
  state = await loadSuppressionState(input, state, database);
  for (const check of [checkSuppression, checkConsentForPurpose]) {
    const verdict = await check(input, policy, state);
    if (!verdict.ok) return { ok: false, reason: verdict.code || 'blocked' };
  }
  if ((explicitBillingChannels(state.prefs || {}, shape.category) || []).includes('push')) return { ok: false, reason: 'app_leg_selected' };
  if (!(await require('../../routes/admin-sms-templates').isTemplateActive(shape.messageType, { database, requireRow: true }))) {
    return { ok: false, reason: 'template_inactive' };
  }
  if (kind === 'pay_link' && await require('../customer-credit').autoApplyWouldApply(invoice, database)) {
    return { ok: false, reason: 'account_credit_applies' };
  }
  return { ok: true };
}

/**
 * Would the canonical invoice / receipt EMAIL be sent to this customer right now?
 * The fold leaves the Email as the customer's only guaranteed path to the link, so it
 * asks what the email senders ask (invoice-email.js, email-template-library.js) and
 * fails closed: a deliverable recipient, the customer's billing choice selecting Email,
 * the receipt kill switch, the template being live, and no active suppression for the
 * address. A read failure answers no.
 */
async function billingEmailDeliverable(kind, { customer, prefs, database }) {
  try {
    const shape = SENDER_SHAPE[kind];
    if (!shape) return false;
    const contact = require('../customer-contact');
    const recipients = kind === 'receipt'
      ? contact.getReceiptEmailRecipients(customer, prefs || {}) : contact.getInvoiceEmailRecipients(customer, prefs || {});
    if (!recipients.length) return false;
    if (kind === 'receipt' && prefs?.payment_receipt === false) return false;
    const explicit = explicitBillingChannels(prefs || {}, shape.category);
    if (explicit && !explicit.includes('email')) return false;
    const library = require('../email-template-library');
    const loaded = await library.loadTemplateByKey(kind === 'receipt' ? 'invoice.receipt' : 'invoice.sent', database);
    if (!loaded?.template) return false;
    for (const recipient of recipients) {
      if (await library.activeSuppressionFor(loaded.template, recipient.email, null, database)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

module.exports = { billingTextVerdict, billingEmailDeliverable };
