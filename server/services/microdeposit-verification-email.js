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
const { isDefiniteRejection } = require('./sendgrid-mail');
const { getInvoiceEmailRecipients } = require('./customer-contact');
const { invoiceAmountDue } = require('./invoice-helpers');
const { currency } = require('./email-template');
const { publicPortalUrl } = require('../utils/portal-url');
const { withCustomerCommsLock } = require('../utils/customer-comms-lock');
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
  if (enforceBillingPreference && prefs?.email_enabled === false) {
    return { ok: false, skipped: true, reason: 'email_disabled' };
  }
  if (enforceBillingPreference && billingChannelAllowed(prefs || {}, 'payment_issue', 'email') === false) {
    return { ok: false, skipped: true, reason: 'billing_email_not_selected' };
  }
  const [recipient] = getInvoiceEmailRecipients(customer, prefs || {}).filter((e) => isEmailLike(e.email));
  if (!recipient?.email) return { ok: false, skipped: true, reason: 'missing_email' };

  const amountDue = invoiceAmountDue(invoice);
  const touch = String(touchKey || 'default');
  let providerHandoffStarted = false;
  let emailDisabledAtHandoff = false;
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
        withProviderHandoff: async (dispatch) => withCustomerCommsLock(db, customer.id, async (trx) => {
          const ownership = await require('./invoice-helpers').selfPayAtDispatch(invoice.id, trx)();
          if (ownership.ok !== true) return ownership;
          const freshPrefs = await trx('notification_prefs').where({ customer_id: customer.id }).first();
          if (freshPrefs?.email_enabled === false) {
            emailDisabledAtHandoff = true;
            return { ok: false };
          }
          if (billingChannelAllowed(freshPrefs || {}, 'payment_issue', 'email') === false) return { ok: false };
          providerHandoffStarted = true;
          await dispatch(trx);
          return { ok: true };
        }),
      } : {}),
    });
    if (emailDisabledAtHandoff && !result.sent) {
      return { ok: false, skipped: true, reason: 'email_disabled' };
    }

    return {
      ok: !!result.sent,
      blocked: !!result.blocked,
      deduped: !!result.deduped,
      reason: result.reason || null,
      ...(result.deliveryOutcome ? { deliveryOutcome: result.deliveryOutcome } : {}),
      ...(result.retryable ? { retryable: true } : {}),
      ...(result.deferred ? { deferred: true } : {}),
    };
  } catch (e) {
    logger.warn(`[microdeposit-email] send failed for invoice ${invoice.id}: ${e.message}`);
    if (e.providerOutcome?.deliveryOutcome === 'accepted') return { ok: true, providerAccepted: true };
    if (['EMAIL_TEMPLATE_DISABLED', 'EMAIL_TEMPLATE_UNAVAILABLE'].includes(e.code)) {
      return { ok: false, skipped: true, reason: 'template_unavailable' };
    }
    const definitelyNotSent = e.code !== 'EMAIL_SEND_IN_PROGRESS'
      && (e.providerOutcome?.deliveryOutcome === 'not_sent'
        || (e.providerOutcome?.deliveryOutcome !== 'uncertain'
          && ((enforceBillingPreference && !providerHandoffStarted) || isDefiniteRejection(e))));
    return { ok: false, error: e.message, deliveryOutcome: definitelyNotSent ? 'not_sent' : 'uncertain' };
  }
}

module.exports = { sendMicrodepositVerificationEmail };
