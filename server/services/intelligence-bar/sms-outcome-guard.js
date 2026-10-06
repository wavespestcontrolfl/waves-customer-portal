/**
 * Intelligence Bar — an unreconciled text blocks a repeat of itself.
 *
 * A text whose provider outcome is unknown (the Twilio call timed out, the
 * handoff was crossed and no result came back) may already be on the
 * customer's phone. Sending the same words again before someone reconciles
 * the row risks a double text. This module is the one place the bar both
 * RECORDS that uncertainty and READS it back, using the markers the SMS layer
 * already writes and honors — it adds none:
 *
 *   metadata.provider_outcome_uncertain      sms-suggest-mode.js reservation
 *   metadata.manual_send_reservation +       the manual-send wrapper's
 *     manual_wrapper_reservation               reservation (24 h hold)
 *   scheduled_sms_claimed_at, provider_retry*  a queued row a worker has
 *     (PRIOR_ATTEMPT_KEY_RE)                   already picked up
 *
 * The recorded row is the manual wrapper's own reservation shape (status
 * 'sending', no scheduled_for), so the scheduler's stale-claim recovery never
 * re-sends it and the wrapper's own interlock honors it too. Nothing here
 * sends a text or touches the provider.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { phoneIdentityKey } = require('../../utils/phone');
const { phoneIdentitySql } = require('../sms-response-policy');
const { PRIOR_ATTEMPT_KEY_RE } = require('../scheduled-sms-cancel');

// The same bound the wrapper's reservation reader and the recovery sweep use.
const UNRECONCILED_HOLD_HOURS = 24;

const flag = (v) => v === true || v === 'true';

function parseMeta(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

function carriesUnknownOutcome(metadata) {
  const meta = parseMeta(metadata);
  return flag(meta.provider_outcome_uncertain)
    || flag(meta.review_delivery_uncertain_exhausted)
    || flag(meta.review_ask_reservation)
    || Object.keys(meta).some((k) => PRIOR_ATTEMPT_KEY_RE.test(k));
}

const REFUSAL = {
  success: false,
  blocked: true,
  code: 'SMS_PRIOR_OUTCOME_UNRECONCILED',
  mayHaveSent: true,
  retry: false,
  retryable: false,
  error: 'An earlier text to this customer with the same message may already have gone out: its delivery was never confirmed and is still being reconciled. Nothing was sent. Check the conversation thread before sending anything similar.',
};

/** The refusal body (a fresh copy each call). */
function unreconciledRefusal(extra = {}) {
  return { ...REFUSAL, ...extra };
}

/**
 * An outbound row to this number with this exact body whose provider outcome
 * is still unknown, inside the hold window. Null when there is none.
 */
async function findUnreconciledSend({ phone, body }) {
  const identity = phoneIdentityKey(phone);
  if (!identity || !body) return null;
  const cutoff = new Date(Date.now() - UNRECONCILED_HOLD_HOURS * 60 * 60 * 1000);
  const rows = await db('sms_log')
    .where({ direction: 'outbound', message_body: body })
    .whereIn('status', ['sending', 'scheduled'])
    .where('updated_at', '>=', cutoff)
    .whereRaw(`${phoneIdentitySql("BTRIM(COALESCE(to_phone, ''))")} = ?`, [identity])
    .select('id', 'metadata');
  return (rows || []).find((row) => carriesUnknownOutcome(row.metadata)) || null;
}

/**
 * Hold the unknown outcome durably so the next attempt can see it. Reuses a
 * row that already carries the marker (the wrapper's own reservation) rather
 * than adding a second one. Best-effort: a failure here never changes what
 * the operator is told (unknown, do not retry).
 */
async function recordUnreconciledSend({ phone, customerId = null, body, adminUserId = null, messageType = 'manual' }) {
  try {
    const existing = await findUnreconciledSend({ phone, body });
    if (existing) return existing.id;
    const fromNumber = await require('../twilio').deriveOutboundNumber({ customerId: customerId || undefined });
    const [row] = await db('sms_log').insert({
      customer_id: customerId,
      direction: 'outbound',
      from_phone: fromNumber,
      to_phone: phone,
      message_body: body,
      status: 'sending',
      message_type: messageType,
      admin_user_id: adminUserId,
      metadata: JSON.stringify({
        manual_send_reservation: true,
        manual_wrapper_reservation: true,
        provider_outcome_uncertain: true,
      }),
    }).returning('id');
    return row?.id || null;
  } catch (err) {
    logger.warn(`[intelligence-bar:comms] could not hold the unknown send outcome (code=${err.code || 'unknown'})`);
    return null;
  }
}

module.exports = {
  UNRECONCILED_HOLD_HOURS,
  carriesUnknownOutcome,
  unreconciledRefusal,
  findUnreconciledSend,
  recordUnreconciledSend,
};
