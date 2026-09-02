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
  // Definitive POLICY refusals (opt-out, landline, suppression, hard
  // bounce, contract violation) — the channel is UNAVAILABLE, not failed:
  // callers must not park the run and retry a permanently blocked channel
  // forever. Transient provider failures stay non-blocked (retryable).
  let smsBlocked = false;
  let emailBlocked = false;

  // Send-once per request + template (mirrors the email leg's class-keyed
  // idempotency): a retry that reuses the acceptance because the OTHER
  // channel failed must not text the same copy twice. The durable proof is
  // the messaging audit log's provider-accepted send for this request and
  // template; a template-class change (received → completed) still sends.
  // An unreadable log sends — at-most-twice beats never telling the
  // customer.
  let smsAlreadySent = false;
  try {
    const db = require('../models/db');
    const prior = await db('messaging_audit_log')
      .where({ customer_id: customer.id, channel: 'sms' })
      .whereNotNull('sent_at')
      .whereRaw("metadata::jsonb ->> 'service_request_id' = ?", [String(request.id)])
      .whereRaw("metadata::jsonb ->> 'original_message_type' = ?", [smsTemplateKey])
      .first('id');
    smsAlreadySent = !!prior;
  } catch (probeErr) {
    logger.warn(`Cancellation confirmation send-once probe failed for request ${request.id}: ${probeErr.message}`);
  }
  if (smsAlreadySent) {
    smsSent = true;
  } else try {
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
    // BLOCKED means a DEFINITIVE policy verdict (opt-out, suppression,
    // non-mobile line): the run closes clean on the other channel instead
    // of retrying an unfixable contact forever. A TRANSIENT block —
    // CONSENT_LOOKUP_FAILED (a DB blip inside the consent validator, the
    // code review-request already re-queues on), or anything the policy
    // chain marks retryable/deferred — is NOT definitive: it stays a
    // not-sent failure so the repair retry re-sends (codex GH r33 P2).
    if (!smsResult.sent && smsResult.blocked === true
      && smsResult.code !== 'CONSENT_LOOKUP_FAILED'
      && smsResult.retryable !== true && !smsResult.deferred) {
      smsBlocked = true;
    }
    if (!smsResult.sent) {
      logger.warn(`Cancellation confirmation SMS blocked/failed for customer ${customer.id}: ${smsResult.code || smsResult.reason || 'unknown'}`);
    }
  } catch (smsErr) {
    logger.error(`Failed to send cancellation confirmation SMS for request ${request.id}: ${smsErr.message}`);
  }

  // The portal-wide email opt-out (notification_prefs.email_enabled=false)
  // is a DEFINITIVE recipient state the shared sender does not read: gate
  // the send on it here, the same signal confirmationChannelAvailability
  // shows the operator (codex GH r29 P1). Unreadable prefs fail open — the
  // send's own skip/blocked handling stays the authority.
  let emailOptedOut = false;
  if (customer.email) {
    try {
      const db = require('../models/db');
      const prefs = await db('notification_prefs').where({ customer_id: customer.id }).first('email_enabled');
      emailOptedOut = !!(prefs && prefs.email_enabled === false);
    } catch (prefsErr) {
      logger.warn(`Cancellation confirmation: notification prefs read failed for ${customer.id}: ${prefsErr.message}`);
    }
  }
  if (emailOptedOut) {
    emailBlocked = true;
    logger.info(`Cancellation confirmation email skipped for customer ${customer.id}: email disabled in notification prefs`);
  } else try {
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
    // Skips are DEFINITIVE recipient states, not transient failures:
    // prefs off, no/malformed stored address, or no customer row — none
    // repair by retrying the send. Only provider-side misses stay failed.
    if (!emailSent && emailResult
      && (emailResult.blocked === true || emailResult.skipped === true)) {
      emailBlocked = true;
    }
  } catch (emailErr) {
    logger.warn(`Failed to send cancellation confirmation email for request ${request.id}: ${emailErr.message}`);
  }

  return {
    smsSent,
    emailSent,
    smsBlocked,
    emailBlocked,
    smsTemplateKey,
    channels: [smsSent ? 'sms' : null, emailSent ? 'email' : null].filter(Boolean),
  };
}

// Channel availability for the operator-facing preview: presence alone lies
// when the server already KNOWS a channel cannot send — landline (cached or
// latest compliance lookup), an active STOP suppression, email prefs off,
// or a malformed address. These are the same definitive signals the send
// legs enforce; unknown/unreadable states stay AVAILABLE (fail-open for
// display — the send-time blocked-flag handling is the authority).
async function confirmationChannelAvailability(customer) {
  const channels = { sms: !!(customer && customer.phone), email: !!(customer && customer.email) };
  const db = require('../models/db');
  if (channels.sms) {
    try {
      const row = await db('customers').where({ id: customer.id }).first('line_type');
      if (row && String(row.line_type || '') === 'landline') channels.sms = false;
    } catch (err) { logger.warn(`channel availability: line_type cache read failed for ${customer.id}: ${err.message}`); }
  }
  if (channels.sms) {
    try {
      const { latestContactCheck, isSmsMobileLineType } = require('./messaging/compliance-contact-checks');
      const latest = await latestContactCheck(customer.phone);
      if (latest && latest.line_type != null && !isSmsMobileLineType(latest.line_type)) channels.sms = false;
    } catch (err) { logger.warn(`channel availability: contact check read failed for ${customer.id}: ${err.message}`); }
  }
  if (channels.sms) {
    try {
      const suppressed = await db('messaging_suppression')
        .where({ phone: customer.phone, active: true }).first('id');
      if (suppressed) channels.sms = false;
    } catch (err) { logger.warn(`channel availability: suppression read failed for ${customer.id}: ${err.message}`); }
  }
  if (channels.email) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(customer.email).trim())) {
      channels.email = false;
    } else {
      try {
        const prefs = await db('notification_prefs').where({ customer_id: customer.id }).first('email_enabled');
        if (prefs && prefs.email_enabled === false) channels.email = false;
      } catch (err) { logger.warn(`channel availability: notification prefs read failed for ${customer.id}: ${err.message}`); }
    }
  }
  if (channels.email) {
    // The SAME suppression authority the send consults (email-template-
    // library blocks a bounced / spam-complaint / do-not-email address
    // before SendGrid): the card must not promise an email the commit
    // deterministically blocks (codex GH r28 P2). Resolved against the
    // cancellation template so group-scoped suppressions match the send;
    // an unseeded template still catches the global types.
    try {
      const EmailTemplateLibrary = require('./email-template-library');
      const template = await EmailTemplateLibrary.loadTemplateByKey('account.cancellation_received');
      const suppression = await EmailTemplateLibrary.activeSuppressionFor(template || {}, customer.email, null);
      if (suppression) channels.email = false;
    } catch (err) { logger.warn(`channel availability: email suppression read failed for ${customer.id}: ${err.message}`); }
  }
  return channels;
}

module.exports = {
  confirmationChannelAvailability, sendCancellationConfirmations, familyLabelOf, etDisplayDate };
