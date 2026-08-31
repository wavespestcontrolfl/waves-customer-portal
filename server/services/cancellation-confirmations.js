'use strict';

/**
 * Cancellation confirmation sends — ONE copy of the truth gate the portal
 * cancel path (routes/requests.js) and the admin Cancel plan path (C3,
 * services/admin-cancellation.js) both use. The processor runs
 * synchronously before this, so the customer's text and email say what
 * actually happened:
 *   - fully processed whole-account → service_cancellation_confirmation
 *   - fully processed scoped         → service_cancellation_scoped_confirmation
 *   - partial (in-progress visit, processor error) → service_cancellation_received
 *     ("closing out by hand") so nobody is told their plan is gone while an
 *     office follow-up is still owed.
 * The email (AccountMembershipEmail.sendCancellationReceived) is the durable
 * artifact and gets the same processed/scope facts. Both are awaited so the
 * caller can report which channels actually accepted.
 *
 * Never throws: a send failure is logged and reported as not-sent.
 */

const logger = require('./logger');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { gsmSafeName } = require('./messaging/gsm-normalize');
const { renderRequiredSmsTemplate } = require('./sms-template-renderer');
const AccountMembershipEmail = require('./account-membership-email');

function etDisplayDate(value) {
  const at = value ? new Date(value) : new Date();
  const safe = Number.isNaN(at.getTime()) ? new Date() : at;
  return safe.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric' });
}

function familyLabelOf(key) {
  const { familyLabel } = require('./cancellation-resolution/templates');
  return (typeof familyLabel === 'function' && familyLabel(key)) || String(key || '').replace(/_/g, ' ');
}

/**
 * @param {object} args
 * @param {object} args.customer   { id, first_name, phone }
 * @param {object} args.request    service_requests row ({ id, created_at })
 * @param {object} args.result     processor result (scope / remaining / tierAfter)
 * @param {boolean} args.processed truthful "done" verdict (route-computed)
 * @param {string}  [args.effectiveAt] date the confirmation names (defaults to
 *                  request.created_at — a quiet-hours hold delivers the text
 *                  the next morning, so the body never says "today")
 * @param {string}  [args.entryPoint] send-window entry point; the portal's
 *                  customer-action entry point bypasses quiet hours, an
 *                  admin-initiated send declares its own.
 * @param {boolean} [args.keptThrough] end-of-coverage cancel: paid visits
 *                  stay on the calendar through effectiveAt, so the copy must
 *                  not claim upcoming visits are off the calendar.
 * @param {string}  [args.identityTrustLevel]
 * @param {string}  [args.urgency]
 * @returns {Promise<{ smsSent: boolean, emailSent: boolean, smsTemplateKey: string, channels: string[] }>}
 */
async function sendCancellationConfirmations({
  customer, request, result, processed,
  effectiveAt = null,
  keptThrough = false,
  entryPoint = 'customer_service_request',
  identityTrustLevel = 'authenticated_portal',
  urgency = 'routine',
} = {}) {
  const scopedProcessed = !!processed && Array.isArray(result?.scope) && result.scope.length > 0;
  const smsTemplateKey = processed
    ? (scopedProcessed
      ? 'service_cancellation_scoped_confirmation'
      : (keptThrough ? 'service_cancellation_end_of_term_confirmation' : 'service_cancellation_confirmation'))
    : 'service_cancellation_received';
  let smsSent = false;
  let emailSent = false;

  try {
    const smsVars = {
      first_name: gsmSafeName(customer.first_name),
      effective_date: etDisplayDate(effectiveAt || request.created_at),
      ...(scopedProcessed ? {
        service: result.scope.map(familyLabelOf).join(' and '),
        remaining: (result.remaining || []).map(familyLabelOf).join(' and ') || 'your other services',
      } : {}),
    };
    const body = await renderRequiredSmsTemplate(smsTemplateKey, smsVars, {
      workflow: smsTemplateKey,
      entity_type: 'service_request',
      entity_id: request.id,
    });
    const smsResult = await sendCustomerMessage({
      to: customer.phone,
      body,
      channel: 'sms',
      audience: 'customer',
      purpose: 'support_resolution',
      customerId: customer.id,
      identityTrustLevel,
      entryPoint,
      metadata: {
        original_message_type: smsTemplateKey,
        service_request_id: request.id,
        urgency,
      },
    });
    smsSent = !!smsResult.sent;
    if (!smsResult.sent) {
      logger.warn(`Cancellation confirmation SMS blocked/failed for customer ${customer.id}: ${smsResult.code || smsResult.reason || 'unknown'}`);
    }
  } catch (smsErr) {
    logger.error(`Failed to send cancellation confirmation SMS for request ${request.id}: ${smsErr.message}`);
  }

  try {
    const emailResult = await AccountMembershipEmail.sendCancellationReceived({
      customerId: customer.id,
      request,
      processed: !!processed,
      effectiveAt,
      keptThrough: !!keptThrough,
      // Verified waiver outcome from the processor — the email must not
      // warn about an in-window scheduled-visit fee the office waived.
      feeWaived: result?.lateFeeWaived === true,
      ...(Array.isArray(result?.scope) && result.scope.length ? {
        scope: {
          cancelled: result.scope.map(familyLabelOf),
          remaining: (result.remaining || []).map(familyLabelOf),
          tierAfter: result.tierAfter || null,
        },
      } : {}),
    });
    emailSent = !!(emailResult && emailResult.ok);
  } catch (emailErr) {
    logger.warn(`Failed to send cancellation confirmation email for request ${request.id}: ${emailErr.message}`);
  }

  return {
    smsSent,
    emailSent,
    smsTemplateKey,
    channels: [smsSent ? 'sms' : null, emailSent ? 'email' : null].filter(Boolean),
  };
}

module.exports = { sendCancellationConfirmations, familyLabelOf, etDisplayDate };
