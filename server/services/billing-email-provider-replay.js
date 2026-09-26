const EmailTemplateLibrary = require('./email-template-library');
const { dispatchUnderBillingEmailAuthority } = require('./billing-channel-email-authority');
const { billingEmailReplayEligible } = require('./messaging/billing-email-replay-eligibility');

const BILLING_REPLAY_TEMPLATES = new Set(['billing.notice', 'billing.receipt_notice']);

function clean(value) {
  return String(value || '').trim();
}

function isBillingEmailProviderReplay(message) {
  return BILLING_REPLAY_TEMPLATES.has(clean(message?.template_key));
}

const { readStoredBillingReplayContext } = EmailTemplateLibrary;

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

async function runBillingEmailProviderReplayHandoff(message, dispatch) {
  if (!isBillingEmailProviderReplay(message)) return { handled: false };
  const context = readStoredBillingReplayContext(message);
  if (!context) {
    return refusal({
      code: 'BILLING_REPLAY_CONTEXT_INVALID',
      reason: 'Stored billing replay context does not match the email message',
    });
  }
  if (typeof dispatch !== 'function') throw new TypeError('Billing replay dispatch callback is required');

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
    recipientEmail: clean(message.recipient_email_snapshot).toLowerCase(),
    preSendCheck: async ({ database }) => {
      const verdict = await billingEmailReplayEligible(context, database);
      return verdict?.eligible === true ? { ok: true } : {
        ok: false,
        code: 'BILLING_REPLAY_INELIGIBLE',
        reason: verdict?.reason || 'Billing replay is no longer eligible',
        retryable: verdict?.retryable === true,
      };
    },
    dispatch: (database) => dispatch(database),
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
  readStoredBillingReplayContext,
  runBillingEmailProviderReplayHandoff,
};
