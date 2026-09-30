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
 * asks the authorities the email senders themselves ask, not a mirror of them, and fails
 * closed:
 *  - recipient and billing channel: the sender's own resolvers on the raw customer row
 *    they read (invoice-email.js loadInvoiceEmailContext + invoiceRecipientFor for an
 *    invoice, resolveReceiptEmailRecipient for a receipt, plus the receipt kill switch
 *    the receipt worker reads, receiptEmailOptOutState);
 *  - template: the library's own send guards (resolveTemplateForSend: the template
 *    enabled and an active version present);
 *  - suppression: the ledger sendTemplate reads (activeSuppressionFor on that template).
 * A read failure answers no. `invoice` is the invoice row (not mutated).
 */
async function billingEmailDeliverable(kind, invoice, { database } = {}) {
  try {
    const shape = SENDER_SHAPE[kind];
    if (!shape) return false;
    const emailer = require('../invoice-email');
    let recipient;
    if (kind === 'receipt') {
      if (!invoice.payer_id) {
        const { receiptKillSwitch, prefsLookupFailed } = await require('../receipt-delivery-queue').receiptEmailOptOutState(invoice);
        if (receiptKillSwitch || prefsLookupFailed) return false;
      }
      const resolved = await emailer.resolveReceiptEmailRecipient({ ...invoice }, { billingDeliveryCategory: shape.category });
      if (!resolved.ok) return false;
      recipient = resolved.recipient;
    } else {
      const context = await emailer.loadInvoiceEmailContext(invoice, { billingDeliveryCategory: shape.category });
      if (context.refusal) return false;
      recipient = emailer.invoiceRecipientFor(context.customer, context.prefs, null).recipient;
    }
    if (!recipient?.email) return false;
    const library = require('../email-template-library');
    const { template } = await library.resolveTemplateForSend({ templateKey: kind === 'receipt' ? 'invoice.receipt' : 'invoice.sent', database });
    return !(await library.activeSuppressionFor(template, recipient.email, undefined, database));
  } catch {
    return false;
  }
}

module.exports = { billingTextVerdict, billingEmailDeliverable };
