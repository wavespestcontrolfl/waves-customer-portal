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
const EmailTemplateLibrary = require('./email-template-library');
const { invoiceAmountDue } = require('./invoice-helpers');
const { currency } = require('./email-template');
const { publicPortalUrl } = require('../utils/portal-url');
const { dispatchUnderBillingEmailAuthority } = require('./billing-channel-email-authority');
const {
  billingEmailRecipient, operatorEmailRecipient, selfPayOnlyHandoff, billingEmailSendOutcome, billingEmailSendFailure,
} = require('./billing-email-sender');

const TEMPLATE_KEY = 'payment.microdeposit_verification';

function firstToken(value) {
  return String(value || '').trim().split(/\s+/)[0] || '';
}

// This email keeps no attempt log of its own; its email_messages row is the
// record.
async function noAttemptLog() {}

/**
 * @returns {{ ok: boolean, skipped?: boolean, blocked?: boolean, deduped?: boolean,
 *             retryable?: boolean, deliveryOutcome?: string, reason?: string, error?: string }}
 */
async function sendMicrodepositVerificationEmail({ invoice, customer, touchKey, enforceBillingPreference = false }) {
  if (!invoice?.id || !customer?.id) return { ok: false, skipped: true, reason: 'missing_context' };

  // Who this email may go to. The customer's billing choices, recipient and
  // invoice ownership come from the shared billing email authority (owner
  // ruling 2026-09-27), read here and again under its locks at the provider
  // handoff. An operator's explicit send skips the customer's choices, as
  // before, and rechecks ownership only.
  const authorityInput = {
    customerId: customer.id, invoiceId: invoice.id, channel: 'email',
    metadata: { billingDeliveryCategory: 'payment_issue' },
  };
  const { recipient, to, refusal } = enforceBillingPreference
    ? await billingEmailRecipient(authorityInput, 'microdeposit-email')
    : await operatorEmailRecipient(customer, 'microdeposit-email');
  if (refusal) return refusal;

  const touch = String(touchKey || 'default');
  const state = { boundaryBlock: null, handoffStarted: false, providerAccepted: false };
  try {
    const result = await EmailTemplateLibrary.sendTemplate({
      templateKey: TEMPLATE_KEY,
      to,
      payload: {
        first_name: firstToken(recipient.name) || firstToken(customer.first_name) || 'there',
        invoice_title: invoice.title || 'your service',
        amount_due: currency(invoiceAmountDue(invoice)),
        billing_url: `${publicPortalUrl()}/?tab=billing`,
      },
      recipientType: 'customer',
      recipientId: customer.id,
      triggerEventId: `microdeposit_verification_email:${invoice.id}:${touch}`,
      idempotencyKey: `microdeposit_verification_email:${invoice.id}:${touch}`,
      suppressionGroupKey: 'transactional_required',
      categories: ['bank_verification', 'payment_setup',
        ...(enforceBillingPreference ? [] : [require('./collections/collection-hold').OPERATOR_INITIATED_EMAIL_CATEGORY])],
      withProviderHandoff: enforceBillingPreference
        ? (dispatch) => dispatchUnderBillingEmailAuthority({
          input: authorityInput, recipientEmail: to, templateKey: TEMPLATE_KEY, dispatch, state,
        })
        : selfPayOnlyHandoff(invoice.id, state),
    });
    return await billingEmailSendOutcome(result, state, noAttemptLog);
  } catch (err) {
    return billingEmailSendFailure(err, state.handoffStarted, noAttemptLog, {
      logTag: 'microdeposit-email', label: `verification for invoice ${invoice.id}`,
    });
  }
}

module.exports = { sendMicrodepositVerificationEmail };
