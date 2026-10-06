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
 * The reservation is taken BEFORE the provider handoff, atomically, with the
 * mechanism the manual-send wrapper (reserveHumanReply) uses: the shared
 * per-thread advisory transaction lock (lockSuggestThread, keyed on the last
 * ten digits of the number) held across the lookup and the insert, and the same
 * row writer (createReplyHoldingReservation). Two confirms of the same text to
 * the same number therefore serialize: the second finds the first's row and is
 * refused with no provider call. The row is then settled from the result with
 * the wrapper's own settle function: accepted or not sent releases it, an
 * unknown outcome leaves it as the held row. The row carries
 * provider_handoff_reservation from acquisition, so a crash between the handoff
 * and settlement leaves a row reconcileAutoSendClaims keeps for the 24-hour
 * hold (then releases) instead of its 30-minute orphan sweep.
 *
 * The row has status 'sending' and no scheduled_for, so the scheduler's
 * stale-claim recovery never re-sends it. Nothing here sends a text or
 * touches the provider.
 */
const db = require('../../models/db');
const logger = require('../logger');
// The wrapper's reservation module loads on first use, as the wrapper itself does.
const suggestMode = () => require('../sms-suggest-mode');
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
 * `excludeId` skips the caller's own reservation.
 */
async function findUnreconciledSend({ phone, body }, dbh = db, { excludeId = null } = {}) {
  const identity = phoneIdentityKey(phone);
  if (!identity || !body) return null;
  const cutoff = new Date(Date.now() - UNRECONCILED_HOLD_HOURS * 60 * 60 * 1000);
  const query = dbh('sms_log')
    .where({ direction: 'outbound', message_body: body })
    .whereIn('status', ['sending', 'scheduled'])
    .where('updated_at', '>=', cutoff)
    .whereRaw(`${phoneIdentitySql("BTRIM(COALESCE(to_phone, ''))")} = ?`, [identity]);
  if (excludeId) query.whereNot('id', excludeId);
  const rows = await query.select('id', 'metadata');
  return (rows || []).find((row) => carriesUnknownOutcome(row.metadata)) || null;
}

/**
 * Take the send's reservation before the provider handoff. One transaction:
 * the thread lock, the lookup for a live same-text row, and the insert, so a
 * concurrent confirm cannot slip between them. Returns { refused: true } when a
 * live same-text reservation or unknown outcome exists (send nothing), or
 * { id } for the row the caller must settle. A number with no digits has no
 * thread to lock and gets { id: null }. A database failure throws: the send
 * does not go out without its reservation.
 */
async function acquireSendReservation({ phone, customerId = null, body }) {
  const threadLast10 = String(phone || '').replace(/\D/g, '').slice(-10) || null;
  if (!threadLast10 || !body) return { id: null };
  return db.transaction(async (trx) => {
    await suggestMode().lockSuggestThread(trx, threadLast10);
    if (await findUnreconciledSend({ phone, body }, trx)) return { refused: true };
    const fromNumber = await require('../twilio').deriveOutboundNumber({ customerId: customerId || undefined });
    const id = await suggestMode().createReplyHoldingReservation(trx, {
      to: phone, customerId, fromNumber, body, reservationKind: 'manual', uncertain: true,
      // Not the wrapper's own interlock flag while in flight: with a manual-reply
      // lifecycle active the wrapper takes its own reservation next and must not
      // find this one. It is flagged only if the outcome stays unknown (settle).
      manualWrapperReservation: false,
      // The provider-handoff marker from the start: if the process dies after the
      // handoff and before settlement, reconcileAutoSendClaims keeps the row for
      // the 24-hour hold (it deletes a bare manual reservation after 30 minutes),
      // so the same text still cannot be resent. The wrapper's own interlock reads
      // manual_wrapper_reservation only, so this does not refuse its path.
      providerHandoff: true,
    });
    return { id };
  });
}

/**
 * Settle the reservation from the send's result. state:
 *   'accepted' | 'not_sent'  released (the provider path wrote the real row, or nothing went out)
 *   'uncertain'              left as the held row, flagged for the wrapper's interlock; a second
 *                            held row for the same text (the wrapper's own) makes this one redundant
 * Never throws: a bookkeeping failure leaves the row, which is the safe side.
 */
async function settleSendReservation(id, state, { phone, body } = {}) {
  if (!id) return;
  try {
    if (state !== 'uncertain') {
      await suggestMode().settleReplyHoldingReservation({ reservationId: id });
      return;
    }
    if (await findUnreconciledSend({ phone, body }, db, { excludeId: id })) {
      await suggestMode().settleReplyHoldingReservation({ reservationId: id });
      return;
    }
    await db('sms_log').where({ id, direction: 'outbound', status: 'sending' }).update({
      metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ manual_wrapper_reservation: true, provider_outcome_uncertain: true })]),
      updated_at: new Date(),
    });
  } catch (err) {
    logger.warn(`[intelligence-bar:comms] could not settle the send reservation (code=${err.code || 'unknown'})`);
  }
}

module.exports = {
  UNRECONCILED_HOLD_HOURS,
  carriesUnknownOutcome,
  unreconciledRefusal,
  findUnreconciledSend,
  acquireSendReservation,
  settleSendReservation,
};
