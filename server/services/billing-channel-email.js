const EmailTemplateLibrary = require('./email-template-library');
const { publicPortalUrl } = require('../utils/portal-url');
const {
  loadBillingEmailContext,
  dispatchUnderBillingEmailAuthority,
  billingEmailTemplateKey,
  blocked,
} = require('./billing-channel-email-authority');
const { buildBillingReplayContext, isBillingReplaySource } = require('./billing-email-replay-context');
const { storedEmailAcceptedAt } = require('./messaging/billing-channel-routing');
const BillingEmailDetails = require('./billing-email-details');

function clean(value) {
  return String(value || '').trim();
}

function emailNotificationBody(value) {
  return clean(value).replace(/\s*Reply STOP to opt out\.?\s*$/i, '').trim();
}

// GATE_BILLING_EMAIL_DETAILS (dark): the routed billing.notice / billing.receipt_notice
// emails only ever carried the SMS body. When the notice is about ONE invoice
// the template's detail rows can now name the property, the service, the
// service date and (receipts only) the tender behind the payment. Every value
// is '' when the data does not exist, which the renderer drops; with the gate
// off nothing is added.
async function invoiceDetailPayload(context) {
  if (!BillingEmailDetails.billingEmailDetailsLive() || !context.invoice) return {};
  const { invoice, customer } = context;
  const service = await BillingEmailDetails.invoiceServiceDetails(invoice);
  const payload = {
    service_label: service.label,
    service_date: service.date,
    property_full_address: await BillingEmailDetails.invoicePropertyAddress(invoice, customer),
  };
  if (context.category === 'payment_receipt') {
    payload.payment_method = BillingEmailDetails.receiptTenderLabel({
      payment: await BillingEmailDetails.paidPaymentForInvoice(invoice),
      invoice,
    });
  }
  return payload;
}

function acceptedResult(result) {
  const storedTime = storedEmailAcceptedAt(result.message);
  return {
    sent: true,
    provider: 'email',
    providerMessageId: result.message?.provider_message_id || null,
    deliveryOutcome: 'accepted',
    blocked: false,
    ...(result.deduped ? {
      deduped: true,
      // The invoice finalizer may be repairing a lost acknowledgement. Keep
      // its stamp tied to the stored Email, never to this retry's clock.
      sentAt: storedTime,
    } : {}),
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
    // Marks the synchronous rejection for the preparation hold below: only a
    // SendGrid webhook schedules the provider retry rail, and none follows a
    // request SendGrid refused outright.
    ...(definitelyNotSent ? { providerRejected: true } : {}),
  };
}

// A retryable refusal before the provider handoff sent nothing and left no
// provider attempt for the email retry rail to recover. Producers of one-shot
// notices persist only schedulable holds, so return it as one: the replay
// re-fans-out under the same notificationEventKey (Codex pre-push P1 on #4843).
// A definite SendGrid rejection after the handoff is the same case: nothing
// was accepted, and the email retry rail never schedules a synchronous
// rejection, so an Email-only notice would otherwise be lost (#4843 gate
// checklist). Its email_messages row is settled as a definitely-unsent
// failure, so the replay's send reclaims that row instead of being held.
const PREPARATION_RETRY_MS = 5 * 60 * 1000;

function preparationHold(result) {
  // A held outcome belongs to the attempt or retry rail that owns its key.
  if (result.held || !result.retryable || result.deliveryOutcome !== 'not_sent') return result;
  if (!result.blocked && result.providerRejected !== true) return result;
  // Blocked, like every hold: sendCustomerMessage keeps a blocked outcome's
  // code, but reports any other unsent outcome as PROVIDER_FAILURE, which no
  // producer replays.
  return {
    ...result, blocked: true, code: 'BILLING_EMAIL_PREPARATION_HOLD', originalCode: result.code, deferred: true,
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
  let detailPayload = {};
  try {
    detailPayload = await invoiceDetailPayload(context);
  } catch (err) {
    // Details are additive: a lookup that fails sends the notice without them.
    detailPayload = {};
  }
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
        ...detailPayload,
      },
      recipientType: 'customer',
      recipientId: context.customer.id,
      triggerEventId: notificationEventKey,
      idempotencyKey: `billing_channel_email:${notificationEventKey}:email`,
      categories: ['billing', context.category],
      suppressionGroupKey: 'transactional_required',
      suppressProviderErrorLog: true,
      ...(replayContext ? { billingReplayContext: replayContext } : {}),
      billingReplayDeclared: Boolean(replayContext) || isBillingReplaySource(input),
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
