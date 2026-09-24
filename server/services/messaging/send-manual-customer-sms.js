'use strict';

const logger = require('../logger');
const TwilioService = require('../twilio');
const { isEnabled } = require('../../config/feature-gates');
const {
  sendCustomerMessage,
  classifyDeliveryCertainty,
} = require('./send-customer-message');
const {
  reserveHumanReply,
  settleHumanReply,
} = require('../sms-suggest-mode');

const INTERLOCK_FIELD = 'manualSmsInterlock';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function reservationAdminUserId(value) {
  return UUID_RE.test(String(value || '')) ? value : null;
}

function deliveryState(outcome) {
  const certainty = classifyDeliveryCertainty(outcome);
  if (certainty === 'sent') return 'accepted';
  if (certainty === 'not_sent') return 'not_sent';
  return 'uncertain';
}

function markOutcome(value, state) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return value;
  value[INTERLOCK_FIELD] = { deliveryState: state };
  return value;
}

function manualSmsDeliveryState(value) {
  return value?.[INTERLOCK_FIELD]?.deliveryState || null;
}

function blockedResult(code, reason) {
  return markOutcome({
    sent: false,
    blocked: true,
    deliveryOutcome: 'not_sent',
    code,
    reason,
  }, 'not_sent');
}

function uncertainResult(code, reason) {
  return markOutcome({
    sent: false,
    blocked: true,
    deliveryOutcome: 'uncertain',
    code,
    reason,
    mayHaveSent: true,
    retryable: false,
  }, 'uncertain');
}

async function settle(reply, { state, reviewedBy, reason, acceptedResult = null }) {
  const ambiguous = state === 'uncertain';
  try {
    await settleHumanReply({
      ...reply,
      // An uncertain handoff keeps both the durable reservation and the
      // parked decisions linked for reconciliation. Supplying the real ids
      // here would reopen them and invite a duplicate manual/automatic reply.
      ...(ambiguous ? { parkedDecisionIds: [], ambiguous: true } : {}),
      sent: state === 'accepted',
      ...(state === 'accepted' ? { acceptedResult } : {}),
      reviewedBy,
      reason,
    });
  } catch (err) {
    // The provider verdict remains authoritative. The durable reservation is
    // deliberately fail-safe when its later bookkeeping cannot complete.
    logger.warn(`[manual-sms] reservation settlement failed (${String(err?.code || err?.name || 'error')})`);
  }
}

async function prepareReservation(input, reviewedBy) {
  try {
    const fromNumber = input.metadata?.fromNumber || await TwilioService.deriveOutboundNumber({
      customerLocationId: input.metadata?.customerLocationId,
      customerId: input.customerId || null,
    });
    const reply = await reserveHumanReply({
      to: input.to,
      customerId: input.customerId || null,
      fromNumber,
      body: input.body,
      adminUserId: reviewedBy,
      blockOnActiveManualReservation: true,
    });
    const providerHandoffReservation = reply.reservationId
      ? require('./provider-handoff-reservation').borrowProviderHandoffReservation({
        reservationId: reply.reservationId,
        to: input.to,
        fromNumber,
        body: input.body,
        messageType: input.metadata?.original_message_type || 'manual',
        adminUserId: reviewedBy,
      })
      : null;
    return { fromNumber, reply, providerHandoffReservation };
  } catch (err) {
    logger.warn(`[manual-sms] reply reservation failed (${String(err?.code || err?.name || 'error')})`);
    return null;
  }
}

async function dispatchReserved(input, {
  fromNumber, reply, reviewedBy, providerHandoffReservation,
}) {
  const sendInput = {
    ...input,
    providerHandoffReservation,
    metadata: {
      ...(input.metadata || {}),
      fromNumber,
      parkedDecisionIds: reply.parkedDecisionIds?.length ? reply.parkedDecisionIds : undefined,
    },
  };
  try {
    const result = await sendCustomerMessage(sendInput);
    const state = deliveryState(result);
    await settle(reply, { state, reviewedBy, reason: result?.reason, acceptedResult: result });
    return markOutcome(result, state);
  } catch (err) {
    const providerOutcome = err?.providerOutcome;
    // Some canonical audit failures predate deliveryOutcome tagging but
    // still carry a real provider receipt on err.providerOutcome. Keep that
    // narrow legacy fallback; an explicit uncertainty remains authoritative.
    const classifiedState = deliveryState(providerOutcome);
    const legacyAccepted = !providerOutcome?.deliveryOutcome
      && require('../sms-auto-send').isRealProviderSend(providerOutcome);
    const state = classifiedState === 'uncertain' && legacyAccepted
      ? 'accepted'
      : classifiedState;
    await settle(reply, { state, reviewedBy, reason: err?.message, acceptedResult: providerOutcome });
    if (state !== 'accepted') throw markOutcome(err, state);
    logger.error(`[manual-sms] provider accepted but canonical send bookkeeping failed (${String(err?.code || err?.name || 'error')})`);
    return markOutcome({
      ...providerOutcome,
      sent: true,
      blocked: false,
      deliveryOutcome: 'accepted',
      acceptedAfterError: true,
    }, state);
  }
}

// Gate-off fence: no new gratitude claim can start, so a lockless read is
// enough to honor one that is still outstanding (a provider-uncertain attempt
// retained after the kill switch was flipped).
async function hasOutstandingAutoSendClaim(input) {
  const threadLast10 = String(input.to || '').replace(/\D/g, '').slice(-10) || null;
  const autoSend = require('../sms-auto-send');
  return autoSend.hasActiveAutoSendClaim(require('../../models/db'), {
    threadLast10,
    customerId: input.customerId || null,
  });
}

/**
 * Gratitude-lane prerequisite for the three operator send paths that do not
 * already own the composer/tech reply lifecycle. Never activated and gate-off,
 * this is an exact pass-through; gate-off after activation, it adds only the
 * outstanding-claim fence. When enabled, reserveHumanReply serializes against
 * the shared autonomous claim and persists recovery linkage before provider
 * entry.
 */
async function sendManualCustomerSms(input) {
  if (!isEnabled('smsGratitudeReplies')) {
    if (!require('../sms-gratitude-context').gratitudeClaimsPossible()) return sendCustomerMessage(input);
    let outstanding;
    try {
      outstanding = await hasOutstandingAutoSendClaim(input);
    } catch (err) {
      logger.warn(`[manual-sms] outstanding-claim check failed (${String(err?.code || err?.name || 'error')})`);
      return blockedResult(
        'MANUAL_REPLY_RESERVATION_FAILED',
        'Could not reserve this conversation for delivery. Try again in a moment.',
      );
    }
    if (outstanding) {
      return blockedResult(
        'AUTO_REPLY_IN_FLIGHT',
        'An automatic reply to this customer is being sent right now. Try again in a moment.',
      );
    }
    return sendCustomerMessage(input);
  }

  const reviewedBy = input.metadata?.adminUserId || null;
  // Canonical send metadata historically also carries symbolic provenance
  // (for example, `intelligence_bar`). Keep that contract unchanged, but do
  // not put a symbolic label into sms_log.admin_user_id: the reservation row
  // uses the real UUID when available and NULL otherwise.
  const prepared = await prepareReservation(input, reservationAdminUserId(reviewedBy));
  if (!prepared) return blockedResult(
    'MANUAL_REPLY_RESERVATION_FAILED',
    'Could not reserve this conversation for delivery. Try again in a moment.',
  );
  const { fromNumber, reply, providerHandoffReservation } = prepared;

  if (reply.autoSendInFlight) {
    return blockedResult(
      'AUTO_REPLY_IN_FLIGHT',
      'An automatic reply to this customer is being sent right now. Try again in a moment.',
    );
  }
  if (reply.manualReplyInFlight) {
    return uncertainResult(
      'MANUAL_REPLY_OUTCOME_UNRESOLVED',
      'A recent text to this customer may still go out. Check the thread and do not retry until it is reconciled.',
    );
  }
  if (!reply.reservationId) {
    await settle(reply, {
      state: 'not_sent',
      reviewedBy,
      reason: 'The manual reply reservation was not created.',
    });
    return blockedResult(
      'MANUAL_REPLY_RESERVATION_FAILED',
      'Could not reserve this conversation for delivery. Try again in a moment.',
    );
  }
  return dispatchReserved(input, {
    fromNumber, reply, reviewedBy, providerHandoffReservation,
  });
}

module.exports = {
  sendManualCustomerSms,
  manualSmsDeliveryState,
};
