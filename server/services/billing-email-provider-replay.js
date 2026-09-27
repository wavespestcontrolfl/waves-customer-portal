const EmailTemplateLibrary = require('./email-template-library');
const { dispatchUnderBillingEmailAuthority } = require('./billing-channel-email-authority');
const {
  billingEmailReplayEligible, billingEmailReplayProducerRefusal,
} = require('./messaging/billing-email-replay-eligibility');
const { senderReplayTemplate } = require('./billing-email-replay-context');

const BILLING_REPLAY_TEMPLATES = new Set(['billing.notice', 'billing.receipt_notice']);

function clean(value) {
  return String(value || '').trim();
}

function isBillingEmailProviderReplay(message) {
  const templateKey = clean(message?.template_key);
  if (!BILLING_REPLAY_TEMPLATES.has(templateKey) && !senderReplayTemplate(templateKey)) return false;
  let payload = message.payload_snapshot;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { return true; }
  }
  // The templates are also used by legacy rows and producers that do not
  // own this replay contract (for example monthly payment receipts).
  // A present but invalid contract stays fail-closed in the handoff check.
  return !!payload && typeof payload === 'object'
    && Object.prototype.hasOwnProperty.call(payload, '__billing_replay_context');
}

const { readStoredBillingReplayContext } = EmailTemplateLibrary;

// A terminal refusal that must not block the notice for good: the retry owner
// settles the row as a definitely-unsent failure instead of 'blocked', so a
// later send of the same notice re-delivers rather than deduping against it.
const BILLING_REPLAY_RESENDABLE = 'BILLING_REPLAY_RESENDABLE';

function refusal(block) {
  const retryable = block?.retryable === true;
  return {
    handled: true,
    allowed: false,
    retryable,
    terminal: !retryable,
    code: block?.code || 'BILLING_REPLAY_RECHECK_FAILED',
    reason: block?.reason || 'Billing replay could not be re-authorized',
  };
}

function producerBlock(producer) {
  return {
    code: producer.resendable === true ? BILLING_REPLAY_RESENDABLE : 'BILLING_REPLAY_INELIGIBLE',
    reason: producer.reason,
    retryable: producer.retryable === true,
  };
}

async function runBillingEmailProviderReplayHandoff(message, dispatch, {
  recipientEmail = clean(message?.recipient_email_snapshot).toLowerCase(),
  authorityRecipientEmail = clean(message?.recipient_email_snapshot).toLowerCase(),
  providerBoundaryCheck = null,
} = {}) {
  if (!isBillingEmailProviderReplay(message)) return { handled: false };
  const context = readStoredBillingReplayContext(message);
  if (!context) {
    return refusal({
      code: 'BILLING_REPLAY_CONTEXT_INVALID',
      reason: 'Stored billing replay context does not match the email message',
    });
  }
  if (typeof dispatch !== 'function') throw new TypeError('Billing replay dispatch callback is required');
  const producer = await billingEmailReplayProducerRefusal(context);
  if (producer) return refusal(producerBlock(producer));

  const state = { boundaryBlock: null, handoffStarted: false, providerAccepted: false };
  await dispatchUnderBillingEmailAuthority({
    input: {
      customerId: context.customer_id,
      invoiceId: context.invoice_id || null,
      channel: 'email',
      metadata: {
        billingDeliveryCategory: context.category,
        notificationEventKey: context.notificationEventKey,
      },
    },
    recipientEmail: clean(recipientEmail).toLowerCase(),
    authorityRecipientEmail: clean(authorityRecipientEmail).toLowerCase(),
    templateKey: clean(message.template_key),
    preSendCheck: async ({ database, providerBoundary }) => {
      const verdict = await billingEmailReplayEligible(context, database);
      if (verdict?.eligible !== true) {
        return {
          ok: false,
          // Preserve main's definitely-unsent, resendable refusal contract.
          code: verdict?.resendable === true ? BILLING_REPLAY_RESENDABLE : 'BILLING_REPLAY_INELIGIBLE',
          reason: verdict?.reason || 'Billing replay is no longer eligible',
          retryable: verdict?.retryable === true,
        };
      }
      // The sender's own rules again, on the held connection, so a stop, a
      // later step or a changed balance since the unlocked pass still refuses.
      const lockedProducer = await billingEmailReplayProducerRefusal(context, { database });
      if (lockedProducer) return { ok: false, ...producerBlock(lockedProducer) };
      return providerBoundary && typeof providerBoundaryCheck === 'function'
        ? providerBoundaryCheck({ database }) : { ok: true };
    },
    dispatch: (database, providerBoundaryCheck) => dispatch(database, providerBoundaryCheck),
    state,
  });

  if (state.providerAccepted === true) return { handled: true, allowed: true };
  return refusal(state.boundaryBlock || {
    retryable: true,
    code: 'BILLING_REPLAY_RECHECK_FAILED',
    reason: 'Billing replay authority returned without a provider outcome',
  });
}

module.exports = {
  isBillingEmailProviderReplay,
  runBillingEmailProviderReplayHandoff,
  BILLING_REPLAY_RESENDABLE,
};
