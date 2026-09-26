const EmailTemplateLibrary = require('./email-template-library');
const { publicPortalUrl } = require('../utils/portal-url');
const {
  loadBillingEmailContext,
  dispatchUnderBillingEmailAuthority,
  billingEmailTemplateKey,
  blocked,
} = require('./billing-channel-email-authority');
const { buildBillingReplayContext } = require('./billing-email-replay-context');

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

// Every sendTemplate result that returns without sending is pre-provider
// (providerAttempted is never true here), so each is `not_sent`; only the
// retry decision differs. A suppression or a withheld annual offer refuses
// this content permanently. A lost lease / refused handoff (`aborted`) and a
// broken annual-offer guard lookup (`guardError`) are transient
// infrastructure failures the library already records as retryable.
function templateNotSent(result) {
  const reason = result.reason || result.message?.error_message || 'Billing email was not sent';
  if (result.guardError) return blocked('ANNUAL_OFFER_GUARD_FAILED', reason, { retryable: true });
  if (result.aborted) return blocked('EMAIL_ABORTED_BEFORE_DISPATCH', reason, { retryable: true });
  if (result.blocked && result.reason === 'annual_offer_withheld') return blocked('ANNUAL_OFFER_WITHHELD', reason);
  if (result.blocked) return blocked('EMAIL_SUPPRESSED', reason);
  return blocked('EMAIL_NOT_SENT', reason, { retryable: result.retryable === true });
}

// Preserve canonical provider evidence carried on a throw, but rebuild it
// from an allowlist so an email_messages row (or other private context) can
// never escape through the billing channel result.
function structuredProviderOutcome(err) {
  const outcome = err?.providerOutcome;
  if (!outcome || typeof outcome !== 'object') return null;
  const deliveryOutcome = clean(outcome.deliveryOutcome);
  const consistent = (deliveryOutcome === 'accepted' && outcome.sent === true)
    || (['not_sent', 'uncertain'].includes(deliveryOutcome) && outcome.sent === false);
  if (!consistent) return null;
  const accepted = deliveryOutcome === 'accepted';
  const code = clean(outcome.code) || clean(err.code);
  const providerMessageId = accepted ? clean(outcome.providerMessageId) || null : null;
  return {
    sent: accepted,
    provider: 'email',
    providerMessageId,
    deliveryOutcome,
    blocked: accepted ? false : outcome.blocked === true,
    ...(code ? { code } : {}),
    reason: EmailTemplateLibrary.redactEmailAddresses(clean(outcome.reason) || clean(err.message)),
    retryable: !accepted && outcome.retryable === true,
    ...(outcome.held === true ? { held: true } : {}),
    ...(typeof outcome.providerAttempted === 'boolean' ? { providerAttempted: outcome.providerAttempted } : {}),
    ...(accepted && outcome.deduped === true ? { deduped: true } : {}),
  };
}

// After the handoff begins, a definite SendGrid rejection (the canonical
// sendgrid-mail.isDefiniteRejection statuses) accepted nothing, so the
// outcome is `not_sent` and retryable; a 408, other 4xx, 5xx or network
// error may have gone out before the response and stays `uncertain`.
// SENDGRID_NOT_CONFIGURED is thrown from sendgrid-mail's authHeaders()
// before fetch is ever called, so even though the authority already
// flipped handoffStarted, no provider request occurred. EMAIL_SEND_IN_PROGRESS
// is different: another attempt owns the key and may already be accepted.
function providerFailure(err, handoffStarted) {
  const structured = structuredProviderOutcome(err);
  if (structured) return structured;
  if (err.code === 'EMAIL_SEND_IN_PROGRESS') {
    return {
      sent: false,
      provider: 'email',
      providerMessageId: null,
      deliveryOutcome: 'uncertain',
      blocked: false,
      code: err.code,
      reason: EmailTemplateLibrary.redactEmailAddresses(err.message),
      retryable: true,
      held: true,
      providerAttempted: false,
    };
  }
  // Any other throw before the handoff (template lookup, delivery-row
  // insert) never reached the provider: report it as a pre-handoff refusal
  // so the preparation hold below schedules its replay.
  if (!handoffStarted) {
    return blocked(err.code || 'EMAIL_PREPARATION_ERROR', EmailTemplateLibrary.redactEmailAddresses(err.message), { retryable: true });
  }
  const definitelyNotSent = err.code === 'SENDGRID_NOT_CONFIGURED'
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

// A retryable refusal before the provider handoff sent nothing and left no
// provider attempt for the email retry rail to recover. Producers of one-shot
// notices persist only schedulable holds, so return it as one: the replay
// re-fans-out under the same notificationEventKey (Codex pre-push P1 on #4843).
const PREPARATION_RETRY_MS = 5 * 60 * 1000;

function preparationHold(result) {
  // A held outcome belongs to the attempt or retry rail that owns its key.
  if (!(result.blocked && result.retryable && result.deliveryOutcome === 'not_sent') || result.held) return result;
  return {
    ...result, code: 'BILLING_EMAIL_PREPARATION_HOLD', originalCode: result.code, deferred: true,
    nextAllowedAt: new Date(Date.now() + PREPARATION_RETRY_MS).toISOString(),
  };
}

async function sendBillingChannelEmail(input, hooks) {
  return preparationHold(await sendBillingChannelEmailOnce(input, hooks));
}

async function sendBillingChannelEmailOnce(input, { preSendCheck } = {}) {
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
  const replayContext = buildBillingReplayContext(input, context, notificationEventKey);
  const state = { boundaryBlock: null, handoffStarted: false, providerAccepted: false };
  try {
    const result = await EmailTemplateLibrary.sendTemplate({
      templateKey: billingEmailTemplateKey(context.category),
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
      ...(replayContext ? { billingReplayContext: replayContext } : {}),
      withProviderHandoff: (dispatch) => dispatchUnderBillingEmailAuthority({
        input, recipientEmail, preSendCheck, dispatch, state,
      }),
    });

    if (state.boundaryBlock) return state.boundaryBlock;
    if (result.sent) return acceptedResult(result);
    return templateNotSent(result);
  } catch (err) { return providerFailure(err, state.handoffStarted); }
}

module.exports = { sendBillingChannelEmail };
