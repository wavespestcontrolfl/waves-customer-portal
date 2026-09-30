// The pieces every hand-built billing email sender shares once it sends
// through the shared billing email authority (billing-channel-email-
// authority.js; owner ruling 2026-09-27): the authority's first read of the
// recipient, the mapping of its refusals onto the outcome vocabulary those
// senders' callers already settle on, the recording of a send's result, and
// the classification of a thrown send. An operator's explicit send skips the
// customer's billing choices, as before, and rechecks ownership only.
const db = require('../models/db');
const logger = require('./logger');
const { redactContact } = require('../utils/redact-contact');
const { loadBillingEmailContext } = require('./billing-channel-email-authority');
const { getInvoiceEmailRecipients } = require('./customer-contact');
const { isDefiniteRejection } = require('./sendgrid-mail');
const { storedEmailAcceptedAt } = require('./messaging/billing-channel-routing');

// Final refusals keep the reasons the callers already settle on, and a
// suppression stays a "Suppressed: " refusal. Anything else did not deliver
// and is no final answer about this customer, so it is a retryable not-sent
// the caller holds for. That includes BILLING_PREFERENCES_CHANGED (the choice
// moved after the caller read it), and both refusals a profile merge can
// produce after the caller loaded the losing customer: CUSTOMER_NOT_FOUND
// (the loser is soft-deleted) and INVOICE_CUSTOMER_MISMATCH (the invoice
// moved to the winner). The next run re-reads them all.
const FINAL_REASONS = Object.freeze({
  NO_EMAIL_RECIPIENT: 'missing_email',
  INVOICE_PAYER_BILLED: 'invoice_payer_billed',
});
const SUPPRESSION_CODES = new Set(['EMAIL_SUPPRESSED', 'SUPPRESSED_MANUAL_DNC', 'SUPPRESSED_OTHER']);

function billingEmailRefusal(block) {
  const reason = FINAL_REASONS[block.code];
  if (reason) return { ok: false, skipped: true, reason };
  if (SUPPRESSION_CODES.has(block.code)) {
    const detail = String(block.reason || block.code);
    return { ok: false, blocked: true, reason: detail.startsWith('Suppressed: ') ? detail : `Suppressed: ${detail}` };
  }
  return { ok: false, retryable: true, deliveryOutcome: 'not_sent', reason: block.code };
}

// Who the email may go to: the authority's first read (it reads again under
// its locks at the provider handoff). An unreadable context is a retryable
// not-sent, never a blind send.
async function billingEmailRecipient(authorityInput, logTag) {
  let context;
  try {
    context = await loadBillingEmailContext(authorityInput);
  } catch (err) {
    logger.warn(`[${logTag}] billing email context unavailable for ${authorityInput.customerId}: ${redactContact(err.message)}`);
    return { refusal: { ok: false, retryable: true, deliveryOutcome: 'not_sent', reason: 'billing_email_context_unavailable' } };
  }
  if (context.error) return { refusal: billingEmailRefusal(context.error) };
  return { recipient: context.recipient, to: context.recipientEmail };
}

function isEmailLike(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim().toLowerCase());
}

// Who an operator's explicit send goes to: the billing recipient, whatever
// the customer chose.
async function operatorEmailRecipient(customer, logTag) {
  const prefs = await db('notification_prefs')
    .where({ customer_id: customer.id })
    .first()
    .catch((err) => {
      logger.warn(`[${logTag}] notification_prefs lookup failed for ${customer.id}: ${redactContact(err.message)}`);
      return null;
    });
  const [recipient] = getInvoiceEmailRecipients(customer, prefs || {})
    .filter((entry) => isEmailLike(entry.email));
  if (!recipient?.email) return { refusal: { ok: false, skipped: true, reason: 'missing_email' } };
  return { recipient, to: recipient.email };
}

// The operator send's provider handoff. Fail-closed: an unreadable invoice
// aborts before dispatch, like every other ownership guard.
function selfPayOnlyHandoff(invoiceId, state) {
  return async (dispatch) => {
    const verdict = await require('./invoice-helpers').selfPayAtDispatch(invoiceId, db)();
    if (verdict.ok !== true) return verdict;
    state.handoffStarted = true;
    await dispatch();
    return { ok: true };
  };
}

// What the send returned, recorded through the sender's own `log` and
// reported in the shared outcome vocabulary. A refusal at the provider
// handoff maps like a first-read one.
async function billingEmailSendOutcome(result, state, log) {
  if (state.boundaryBlock) {
    const refusal = billingEmailRefusal(state.boundaryBlock);
    await log({ status: refusal.blocked ? 'blocked' : 'failed', failureReason: refusal.reason });
    return refusal;
  }
  if (result.deduped) {
    const sentAt = storedEmailAcceptedAt(result.message);
    return { ok: !!result.sent, deduped: true, sentAt, blocked: !!result.blocked, reason: result.reason || null };
  }
  const message = result.message || {};
  await log({
    status: result.sent ? 'sent' : result.blocked ? 'blocked' : 'failed',
    providerMessageId: message.provider_message_id || null,
    sentAt: message.sent_at || null,
    failureReason: result.sent ? null : result.reason || message.error_message || 'email_not_sent',
  });
  if (result.sent) return { ok: true };
  return { ok: false, blocked: !!result.blocked, reason: result.reason || 'email_not_sent' };
}

// A thrown send: accepted at the provider, known not sent, or uncertain. A
// failure before the provider handoff, or a definite provider refusal, is
// known not sent and may reopen a keyed reservation; an unknown failure
// after the handoff stays uncertain so the reservation is held, not re-sent.
async function billingEmailSendFailure(err, handoffStarted, log, { logTag, label }) {
  const outcome = err.providerOutcome?.deliveryOutcome;
  if (outcome === 'accepted') {
    await log({ status: 'sent', failureReason: null });
    return { ok: true };
  }
  await log({ status: 'failed', failureReason: err.message });
  // Provider errors can echo the recipient address: the outcome below keeps the raw message, the log line does not.
  logger.error(`[${logTag}] ${label} email failed: ${redactContact(err.message)}`);
  if (['EMAIL_TEMPLATE_DISABLED', 'EMAIL_TEMPLATE_UNAVAILABLE'].includes(err.code)) {
    return { ok: false, skipped: true, reason: 'template_unavailable' };
  }
  const definitelyNotSent = err.code !== 'EMAIL_SEND_IN_PROGRESS'
    && (outcome === 'not_sent' || (outcome !== 'uncertain' && (!handoffStarted || isDefiniteRejection(err))));
  return { ok: false, error: err.message, deliveryOutcome: definitelyNotSent ? 'not_sent' : 'uncertain' };
}

module.exports = {
  billingEmailRecipient,
  billingEmailRefusal,
  operatorEmailRecipient,
  selfPayOnlyHandoff,
  billingEmailSendOutcome,
  billingEmailSendFailure,
};
