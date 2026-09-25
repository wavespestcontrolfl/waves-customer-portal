const EmailTemplateLibrary = require('./email-template-library');
const { publicPortalUrl } = require('../utils/portal-url');
const {
  loadBillingEmailContext,
  dispatchUnderBillingEmailAuthority,
  blocked,
} = require('./billing-channel-email-authority');

function clean(value) {
  return String(value || '').trim();
}

function emailNotificationBody(value) {
  return clean(value).replace(/\s*Reply STOP to opt out\.?\s*$/i, '').trim();
}

function acceptedResult(result) {
  return {
    sent: true,
    provider: 'email',
    providerMessageId: result.message?.provider_message_id || null,
    deliveryOutcome: 'accepted',
    blocked: false,
    ...(result.deduped ? { deduped: true } : {}),
  };
}

// After the handoff begins, a definite SendGrid rejection (the canonical
// sendgrid-mail.isDefiniteRejection statuses) accepted nothing, so the
// outcome is `not_sent` and retryable; a 408, other 4xx, 5xx or network
// error may have gone out before the response and stays `uncertain`.
function providerFailure(err, handoffStarted) {
  const definitelyNotSent = !handoffStarted
    || err.code === 'EMAIL_SEND_IN_PROGRESS'
    || require('./sendgrid-mail').isDefiniteRejection(err);
  return {
    sent: false,
    provider: 'email',
    providerMessageId: null,
    deliveryOutcome: definitelyNotSent ? 'not_sent' : 'uncertain',
    blocked: false,
    code: err.code || 'EMAIL_PROVIDER_ERROR',
    reason: EmailTemplateLibrary.redactEmailAddresses(err.message),
    retryable: definitelyNotSent || err.retryable === true,
  };
}

async function sendBillingChannelEmail(input, { preSendCheck } = {}) {
  const notificationEventKey = clean(input?.metadata?.notificationEventKey);
  if (!notificationEventKey) {
    return blocked('NOTIFICATION_EVENT_KEY_REQUIRED', 'Billing email requires a stable notification event key');
  }
  const body = emailNotificationBody(input?.body);
  if (!body) return blocked('EMAIL_BODY_REQUIRED', 'Billing email requires message content');

  let context;
  try {
    context = await loadBillingEmailContext(input);
  } catch (err) {
    return blocked('BILLING_EMAIL_PREPARATION_FAILED', err.message, { retryable: true });
  }
  if (context.error) return context.error;

  const { recipientEmail } = context;
  const state = { boundaryBlock: null, handoffStarted: false, providerAccepted: false };
  try {
    const result = await EmailTemplateLibrary.sendTemplate({
      templateKey: 'billing.notice',
      to: recipientEmail,
      payload: {
        first_name: clean(context.recipient.name) || clean(context.customer.first_name) || 'there',
        category_label: context.categoryLabel,
        notification_body: body,
        billing_url: `${publicPortalUrl()}/?tab=billing`,
      },
      recipientType: 'customer',
      recipientId: context.customer.id,
      triggerEventId: notificationEventKey,
      idempotencyKey: `billing_channel_email:${notificationEventKey}:email`,
      categories: ['billing', context.category],
      suppressionGroupKey: 'transactional_required',
      suppressProviderErrorLog: true,
      withProviderHandoff: (dispatch) => dispatchUnderBillingEmailAuthority({
        input, recipientEmail, preSendCheck, dispatch, state,
      }),
    });

    if (state.boundaryBlock) return state.boundaryBlock;
    if (result.sent) return acceptedResult(result);
    return blocked(
      result.blocked ? 'EMAIL_SUPPRESSED' : 'EMAIL_NOT_SENT',
      result.reason || result.message?.error_message || 'Billing email was not sent',
      { retryable: result.retryable === true },
    );
  } catch (err) { return providerFailure(err, state.handoffStarted); }
}

module.exports = { sendBillingChannelEmail };
