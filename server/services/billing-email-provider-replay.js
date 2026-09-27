const EmailTemplateLibrary = require('./email-template-library');
const { dispatchUnderBillingEmailAuthority } = require('./billing-channel-email-authority');
const { billingEmailReplayEligible } = require('./messaging/billing-email-replay-eligibility');

const BILLING_REPLAY_TEMPLATES = new Set(['billing.notice', 'billing.receipt_notice']);
const PREVISIT_SUPERSEDED_REASONS = new Set([
  'previsit-quote-changed', 'balance-reminder-copy-stale', 'balance-reminder-visit-changed',
]);
const PREVISIT_SUPERSEDED_AUTHORITY = new Set(['BILLING_PREFERENCES_CHANGED', 'EMAIL_RECIPIENT_CHANGED']);

function previsitAuthoritySuperseded(context, contracted, state) {
  return contracted && context.source_entry_point === 'previsit_balance_reminder'
    && PREVISIT_SUPERSEDED_AUTHORITY.has(state.boundaryBlock?.code)
    && !state.providerPreparationStarted && !state.handoffStarted;
}

function clean(value) {
  return String(value || '').trim();
}

// Every billing.notice / billing.receipt_notice row comes from the billing
// Email adapter (billing-channel-email.js). A provider retry or bounce
// resend of one re-authorizes through the Email authority whether or not
// its producer stored a replay contract.
function isBillingEmailTemplateRetry(message) {
  return BILLING_REPLAY_TEMPLATES.has(clean(message?.template_key));
}

function isBillingEmailProviderReplay(message) {
  if (!BILLING_REPLAY_TEMPLATES.has(clean(message?.template_key))) return false;
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

const NOTICE_CATEGORIES = ['invoice', 'payment_issue', 'payment_receipt'];

function storedCategories(message) {
  let categories = message?.categories;
  if (typeof categories === 'string') {
    try { categories = JSON.parse(categories); } catch { return []; }
  }
  return Array.isArray(categories) ? categories.map((value) => clean(value)) : [];
}

// A row whose producer stored no replay contract (for example the monthly
// payment receipt) still carries the identity the billing Email adapter
// wrote: the customer recipient, the notice key (trigger_event_id, echoed in
// the adapter's idempotency key) and the billing category (categories, with
// the template matching it). The retry re-authorizes that identity: the
// customer's current Email choice for the category, the recipient and
// suppression. The row names no invoice, so invoice ownership is not
// re-checked, and there is no producer eligibility to re-run. A row that
// does not carry this identity is refused.
function unregisteredRetryContext(message) {
  if (clean(message?.recipient_type).toLowerCase() !== 'customer') return null;
  const customerId = clean(message.recipient_id);
  const notificationEventKey = clean(message.trigger_event_id);
  if (!customerId || !notificationEventKey
    || clean(message.idempotency_key) !== `billing_channel_email:${notificationEventKey}:email`) return null;
  const categories = storedCategories(message);
  const named = [...new Set(NOTICE_CATEGORIES.filter((category) => categories.includes(category)))];
  if (named.length > 1 || (!named.length && !categories.includes('billing'))) return null;
  const category = named[0] || 'billing';
  // billing.receipt_notice carries payment receipts only. billing.notice
  // carries every category, including payment receipts sent before the
  // receipt template existed (migration 20260926000100).
  const templateKey = clean(message.template_key);
  if (templateKey === 'billing.receipt_notice' ? category !== 'payment_receipt' : templateKey !== 'billing.notice') {
    return null;
  }
  return { customer_id: customerId, invoice_id: null, category, notificationEventKey };
}

// Producers that send under the autopay purpose (autopay-notifications.js,
// workflows/payment-expiry.js). That purpose honors the payment_receipt
// switch at the first send, like a receipt (messaging/policy.js).
const AUTOPAY_PURPOSE_SOURCES = new Set([
  'autopay_pre_charge_reminder', 'autopay_card_expiry_warning', 'payment_expiry_workflow',
]);

// The portal-wide email switch never stops a billing email (owner ruling
// 2026-09-26), but a payment receipt and an autopay notice still honor their
// kill switch, notification_prefs.payment_receipt, as the consent pipeline
// (and receipt-delivery-queue.js for receipts) does at the first send. Read
// on the authority's held transaction; a failed read fails closed and
// retries.
async function receiptOptOut(context, database) {
  if (context.category !== 'payment_receipt' && !AUTOPAY_PURPOSE_SOURCES.has(context.source_entry_point)) return null;
  try {
    const prefs = await database('notification_prefs').where({ customer_id: context.customer_id }).first('payment_receipt');
    return prefs?.payment_receipt === false ? { eligible: false, reason: 'receipt_opted_out', retryable: false } : null;
  } catch {
    return { eligible: false, reason: 'receipt-prefs-unavailable', retryable: true };
  }
}

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

async function runBillingEmailProviderReplayHandoff(message, dispatch, {
  recipientEmail = clean(message?.recipient_email_snapshot).toLowerCase(),
  authorityRecipientEmail = clean(message?.recipient_email_snapshot).toLowerCase(),
  providerBoundaryCheck = null,
} = {}) {
  if (!isBillingEmailTemplateRetry(message)) return { handled: false };
  const contracted = isBillingEmailProviderReplay(message);
  const context = contracted ? readStoredBillingReplayContext(message) : unregisteredRetryContext(message);
  if (!context) {
    return refusal(contracted ? {
      code: 'BILLING_REPLAY_CONTEXT_INVALID',
      reason: 'Stored billing replay context does not match the email message',
    } : {
      code: 'BILLING_RETRY_IDENTITY_INVALID',
      reason: 'Billing email row does not identify its customer notice',
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
    recipientEmail: clean(recipientEmail).toLowerCase(),
    authorityRecipientEmail: clean(authorityRecipientEmail).toLowerCase(),
    templateKey: clean(message.template_key),
    preSendCheck: async ({ database, providerBoundary }) => {
      const verdict = await receiptOptOut(context, database)
        || (contracted ? await billingEmailReplayEligible(context, database) : { eligible: true });
      if (verdict?.eligible !== true) {
        const requote = context.source_entry_point === 'previsit_balance_reminder'
          && PREVISIT_SUPERSEDED_REASONS.has(verdict?.reason);
        return {
          ok: false,
          code: requote ? 'BILLING_REPLAY_REQUOTE_REQUIRED'
            : verdict?.resendable === true ? BILLING_REPLAY_RESENDABLE : 'BILLING_REPLAY_INELIGIBLE',
          reason: verdict?.reason || 'Billing replay is no longer eligible',
          retryable: !requote && verdict?.retryable === true,
        };
      }
      return providerBoundary && typeof providerBoundaryCheck === 'function'
        ? providerBoundaryCheck({ database }) : { ok: true };
    },
    dispatch: (database, providerBoundaryCheck) => dispatch(database, providerBoundaryCheck),
    state,
  });

  if (state.providerAccepted === true) return { handled: true, allowed: true };
  if (previsitAuthoritySuperseded(context, contracted, state)) {
    return refusal({ ...state.boundaryBlock, code: 'BILLING_REPLAY_REQUOTE_REQUIRED', retryable: false });
  }
  return refusal(state.boundaryBlock || {
    retryable: true,
    code: 'BILLING_REPLAY_RECHECK_FAILED',
    reason: 'Billing replay authority returned without a provider outcome',
  });
}

module.exports = {
  isBillingEmailTemplateRetry,
  isBillingEmailProviderReplay,
  runBillingEmailProviderReplayHandoff,
  BILLING_REPLAY_RESENDABLE,
};
