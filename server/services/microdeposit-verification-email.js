/**
 * Sends the Waves-branded ACH micro-deposit verification email — the email arm
 * of the dunning diversion (see late-payment-checker.js / invoice-followups.js).
 * Pairs with the `bank_verification_incomplete` SMS. Branding is automatic
 * (template mode: 'service' -> wrapServiceEmail).
 *
 * `touchKey` scopes the idempotency key to the current dunning touch (the SMS's
 * tier / follow-up step) so the email re-nudges on the SAME cadence as the SMS,
 * once per touch — not once forever, and not on every cron pass.
 */
const db = require('../models/db');
const logger = require('./logger');
const EmailTemplateLibrary = require('./email-template-library');
const { getInvoiceEmailRecipients } = require('./customer-contact');
const { invoiceAmountDue } = require('./invoice-helpers');
const { currency } = require('./email-template');
const { publicPortalUrl } = require('../utils/portal-url');
const { billingChannelAllowed } = require('./billing-delivery-channels');

function firstToken(value) {
  return String(value || '').trim().split(/\s+/)[0] || '';
}

function isEmailLike(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim().toLowerCase());
}

/**
 * @returns {{ ok: boolean, skipped?: boolean, blocked?: boolean, deduped?: boolean,
 *             reason?: string, error?: string }}
 */
async function sendMicrodepositVerificationEmail({ invoice, customer, touchKey, enforceBillingPreference = false }) {
  if (!invoice?.id || !customer?.id) return { ok: false, skipped: true, reason: 'missing_context' };

  const prefs = await db('notification_prefs')
    .where({ customer_id: customer.id })
    .first()
    .catch((err) => {
      logger.warn(`[microdeposit-email] notification_prefs lookup failed for ${customer.id}: ${err.message}`);
      return null;
    });
  if (enforceBillingPreference && billingChannelAllowed(prefs || {}, 'payment_issue', 'email') === false) {
    return { ok: false, skipped: true, reason: 'billing_email_not_selected' };
  }
  const [recipient] = getInvoiceEmailRecipients(customer, prefs || {}).filter((e) => isEmailLike(e.email));
  if (!recipient?.email) return { ok: false, skipped: true, reason: 'missing_email' };

  const amountDue = invoiceAmountDue(invoice);
  const touch = String(touchKey || 'default');
  try {
    const result = await EmailTemplateLibrary.sendTemplate({
      templateKey: 'payment.microdeposit_verification',
      to: recipient.email,
      payload: {
        first_name: firstToken(recipient.name) || firstToken(customer.first_name) || 'there',
        invoice_title: invoice.title || 'your service',
        amount_due: currency(amountDue),
        billing_url: `${publicPortalUrl()}/billing`,
      },
      recipientType: 'customer',
      recipientId: customer.id,
      triggerEventId: `microdeposit_verification_email:${invoice.id}:${touch}`,
      idempotencyKey: `microdeposit_verification_email:${invoice.id}:${touch}`,
      suppressionGroupKey: 'transactional_required',
      categories: ['bank_verification', 'payment_setup'],
      ...(enforceBillingPreference ? {
        withProviderHandoff: async (dispatch) => {
          const ownership = await require('./invoice-helpers').selfPayAtDispatch(invoice.id, db)();
          if (ownership.ok !== true) return ownership;
          const freshPrefs = await db('notification_prefs').where({ customer_id: customer.id }).first();
          if (billingChannelAllowed(freshPrefs || {}, 'payment_issue', 'email') === false) return { ok: false };
          await dispatch();
          return { ok: true };
        },
      } : {}),
    });
    return {
      ok: !!result.sent,
      blocked: !!result.blocked,
      deduped: !!result.deduped,
      reason: result.reason || null,
    };
  } catch (e) {
    logger.warn(`[microdeposit-email] send failed for invoice ${invoice.id}: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

module.exports = { sendMicrodepositVerificationEmail };
