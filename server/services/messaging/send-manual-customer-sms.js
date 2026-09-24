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
    return { fromNumber, reply };
  } catch (err) {
    logger.warn(`[manual-sms] reply reservation failed (${String(err?.code || err?.name || 'error')})`);
    return null;
  }
}

async function dispatchReserved(input, { fromNumber, reply, reviewedBy }) {
  const sendInput = {
    ...input,
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

/**
 * Gratitude-lane prerequisite for the three operator send paths that do not
 * already own the composer/tech reply lifecycle. The gate-off branch is an
 * exact pass-through. When enabled, reserveHumanReply serializes against the
 * shared autonomous claim and persists recovery linkage before provider entry.
 */
async function sendManualCustomerSms(input) {
  if (!isEnabled('smsGratitudeReplies')) return sendCustomerMessage(input);

  const reviewedBy = input.metadata?.adminUserId || null;
  const prepared = await prepareReservation(input, reviewedBy);
  if (!prepared) return blockedResult(
    'MANUAL_REPLY_RESERVATION_FAILED',
    'Could not reserve this conversation for delivery. Try again in a moment.',
  );
  const { fromNumber, reply } = prepared;

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
  return dispatchReserved(input, { fromNumber, reply, reviewedBy });
}

module.exports = {
  sendManualCustomerSms,
  manualSmsDeliveryState,
};
