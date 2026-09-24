'use strict';

const db = require('../../models/db');
const logger = require('../logger');
const { isEnabled } = require('../../config/feature-gates');

const handles = new WeakSet();
const GRATITUDE_RESERVATION_OWNER = Symbol('gratitude_reservation_owner');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function createHandle({ reservationId, to, fromNumber, body, messageType, adminUserId = null, callerOwned = false }) {
  const handle = {
    reservationId,
    context: { to: normalizeRecipient(to), fromNumber, body, messageType, adminUserId, metadata: {} },
    deliveryOutcome: 'not_sent',
    providerMessageId: null,
    finalized: false,
    acceptedPromoted: false,
    settlementPromise: null,
    callerOwned,
  };
  handles.add(handle);
  return handle;
}

function threadLast10(value) {
  return String(value || '').replace(/\D/g, '').slice(-10) || null;
}

function normalizeRecipient(value) {
  const raw = String(value || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return raw;
}

function trustedGratitudeOwnsReservation(input, { providerPreSendCheck, withSmsHandoff } = {}) {
  return input?.audience === 'customer'
    && input?.purpose === 'conversational'
    && input?.entryPoint === 'sms_auto_send_executor'
    && input?.metadata?.original_message_type === 'ai_gratitude'
    && Boolean(input?.metadata?.agentDecisionId)
    && typeof providerPreSendCheck === 'function'
    && typeof withSmsHandoff === 'function';
}

function gratitudeReservationOwner(input, callbacks = {}) {
  return trustedGratitudeOwnsReservation(input, callbacks)
    ? GRATITUDE_RESERVATION_OWNER
    : null;
}

function canonicalCoordinationApplies(input, callbacks = {}) {
  if (!isEnabled('smsGratitudeReplies')) return false;
  if (!input || input.audience !== 'customer' || !['sms', 'push'].includes(input.channel)) return false;
  return !trustedGratitudeOwnsReservation(input, callbacks);
}

function directCoordinationApplies({ messageType, reservationOwner = null } = {}) {
  if (!isEnabled('smsGratitudeReplies')) return false;
  if (messageType === 'ai_gratitude' && reservationOwner === GRATITUDE_RESERVATION_OWNER) return false;
  return !['internal_alert', 'admin_alert'].includes(String(messageType || ''));
}

async function prepareProviderHandoffReservation({
  to, customerId = null, fromNumber, body, messageType, adminUserId = null,
} = {}) {
  const normalizedTo = normalizeRecipient(to);
  const last10 = threadLast10(normalizedTo);
  if (!last10 || !fromNumber) {
    return { blocked: true, code: 'PROVIDER_HANDOFF_RESERVATION_INVALID', reason: 'Provider reservation endpoints are unavailable' };
  }
  const suggest = require('../sms-suggest-mode');
  const prepared = await db.transaction(async (trx) => {
    await suggest.lockSuggestThread(trx, last10);
    const reservationId = await suggest.createReplyHoldingReservation(trx, {
      to: normalizedTo,
      customerId,
      fromNumber,
      body,
      messageType,
      adminUserId: UUID_RE.test(String(adminUserId || '')) ? adminUserId : null,
      reservationKind: 'provider_handoff',
      uncertain: true,
    });
    if (!reservationId) throw new Error('provider handoff reservation was not created');
    return { reservationId };
  });
  const handle = createHandle({
    reservationId: prepared.reservationId,
    to: normalizedTo,
    fromNumber,
    body,
    messageType,
    adminUserId: UUID_RE.test(String(adminUserId || '')) ? adminUserId : null,
  });
  return { handle };
}

function borrowProviderHandoffReservation({
  reservationId, to, fromNumber, body, messageType, adminUserId = null,
} = {}) {
  if (!UUID_RE.test(String(reservationId || '')) || !threadLast10(to) || !fromNumber) return null;
  return createHandle({
    reservationId,
    to,
    fromNumber,
    body,
    messageType,
    adminUserId: UUID_RE.test(String(adminUserId || '')) ? adminUserId : null,
    callerOwned: true,
  });
}

function isProviderHandoffHandle(value) {
  return Boolean(value && typeof value === 'object' && handles.has(value));
}

function captureProviderContext(handle, context = {}) {
  if (!isProviderHandoffHandle(handle) || handle.finalized) return;
  handle.context = {
    ...handle.context,
    ...context,
    metadata: { ...handle.context.metadata, ...(context.metadata || {}) },
  };
}

function recordProviderOutcome(handle, outcome = {}) {
  if (!isProviderHandoffHandle(handle) || handle.finalized) return;
  if (handle.deliveryOutcome === 'accepted' && outcome.deliveryOutcome !== 'accepted') return;
  if (outcome.deliveryOutcome === 'accepted') {
    handle.deliveryOutcome = 'accepted';
    handle.providerMessageId = outcome.providerMessageId || handle.providerMessageId;
    if (outcome.channel) captureProviderContext(handle, { channel: outcome.channel });
  } else if (outcome.deliveryOutcome === 'uncertain') {
    handle.deliveryOutcome = 'uncertain';
  } else if (outcome.deliveryOutcome === 'not_sent') {
    handle.deliveryOutcome = 'not_sent';
  }
}

function attachReservationContext(handle, outcome) {
  if (!isProviderHandoffHandle(handle) || !handle.callerOwned
    || !outcome || (typeof outcome !== 'object' && typeof outcome !== 'function')) return outcome;
  Object.defineProperty(outcome, 'reservationContext', {
    value: handle.context,
    enumerable: false,
    configurable: true,
  });
  return outcome;
}

function settleProviderHandoffReservation(handle) {
  if (!isProviderHandoffHandle(handle) || handle.finalized) return Promise.resolve(true);
  if (handle.callerOwned) return Promise.resolve(true);
  if (handle.settlementPromise) return handle.settlementPromise;

  const pending = (async () => {
    try {
      const suggest = require('../sms-suggest-mode');
      let settled;
      if (handle.deliveryOutcome === 'accepted') {
        if (!handle.acceptedPromoted) {
          let promoted = false;
          for (let attempt = 1; attempt <= 2 && !promoted; attempt += 1) {
            promoted = await suggest.settleReplyHoldingReservation({
              reservationId: handle.reservationId,
              acceptedResult: {
                sent: true,
                deliveryOutcome: 'accepted',
                providerMessageId: handle.providerMessageId,
                reservationContext: handle.context,
              },
            });
            if (!promoted && attempt === 1) {
              logger.warn(`[provider-handoff] retrying accepted reservation promotion (${handle.reservationId})`);
            }
          }
          if (!promoted) {
            logger.warn(`[provider-handoff] accepted reservation promotion failed (${handle.reservationId})`);
            return false;
          }
          handle.acceptedPromoted = true;
        }
        settled = await suggest.settleReplyHoldingReservation({ reservationId: handle.reservationId });
      } else {
        settled = await suggest.settleReplyHoldingReservation({
          reservationId: handle.reservationId,
          uncertain: handle.deliveryOutcome === 'uncertain',
        });
      }
      if (settled) handle.finalized = true;
      return settled;
    } finally {
      handle.settlementPromise = null;
    }
  })();
  handle.settlementPromise = pending;
  return pending;
}

module.exports = {
  canonicalCoordinationApplies,
  directCoordinationApplies,
  trustedGratitudeOwnsReservation,
  gratitudeReservationOwner,
  prepareProviderHandoffReservation,
  borrowProviderHandoffReservation,
  isProviderHandoffHandle,
  captureProviderContext,
  recordProviderOutcome,
  attachReservationContext,
  settleProviderHandoffReservation,
  normalizeRecipient,
};
