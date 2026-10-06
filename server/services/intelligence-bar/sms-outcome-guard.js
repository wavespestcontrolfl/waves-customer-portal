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
// The body as the provider receives it (send-customer-message.js applies the same
// function before Twilio): reservations are written and matched on this form.
// classifyDeliveryCertainty is the repo's one reading of a provider outcome.
const { canonicalSmsBody, classifyDeliveryCertainty } = require('../messaging/send-customer-message');
// The repo's one predicate for "this reservation row is still unresolved": the
// review-ask arm across every non-delivered status, the reply arm while 'sending'
// inside its 24-hour hold. The review-ask arm is unbounded there (a general-reader
// hide); for a same-text resend it is bounded by the ask-spacing window, the same
// REVIEW_ASK_RESERVATION_HOLD_HOURS the reservation's own reuse decision uses.
const {
  isUnresolvedSendReservation, REVIEW_ASK_MARKER, REVIEW_ASK_RESERVATION_HOLD_HOURS, REPLY_RESERVATION_HOLD_HOURS,
} = require('../messaging/review-ask-reservation');
const { phoneIdentityKey } = require('../../utils/phone');
const { phoneIdentitySql } = require('../sms-response-policy');
const { PRIOR_ATTEMPT_KEY_RE } = require('../scheduled-sms-cancel');

// The same bound the wrapper's reservation reader and the recovery sweep use.
const UNRECONCILED_HOLD_HOURS = REPLY_RESERVATION_HOLD_HOURS;
const REVIEW_ASK_HOLD_MS = REVIEW_ASK_RESERVATION_HOLD_HOURS * 60 * 60 * 1000;
const WIDEST_HOLD_MS = Math.max(REVIEW_ASK_HOLD_MS, UNRECONCILED_HOLD_HOURS * 60 * 60 * 1000);

function parseMeta(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

// When the row's send was last attempted. A queued text can be created days
// before the scheduler tries it, so its hold ages from the attempt: the latest
// time-valued prior-attempt marker (scheduled_sms_claimed_at,
// scheduled_sms_recovered_at, provider_retry_at; a code or a boolean under the
// same key family is skipped), else updated_at, else created_at.
function attemptAt(row, meta) {
  const times = Object.keys(meta)
    .filter((k) => PRIOR_ATTEMPT_KEY_RE.test(k))
    .map((k) => meta[k])
    .filter((v) => typeof v === 'string' || v instanceof Date)
    .map((v) => new Date(v).getTime())
    .filter(Number.isFinite);
  if (times.length) return Math.max(...times);
  const fallback = new Date(row.updated_at || row.created_at || NaN).getTime();
  return Number.isFinite(fallback) ? fallback : NaN;
}

/**
 * Is this row a text that may already have reached the customer, with no
 * confirmed outcome, inside its hold? Two existing notions, not a third:
 *  - isUnresolvedSendReservation (review-ask-reservation.js): a review-ask
 *    reservation in any non-delivered status (here bounded to the ask-spacing
 *    window), a reply reservation still 'sending' inside its 24-hour hold, a
 *    billing text-leg claim. It is handed the attempt time as created_at so
 *    its own hold ages from the attempt.
 *  - a queued row a worker already picked up or requeued after a provider
 *    attempt: any PRIOR_ATTEMPT_KEY_RE marker (the key family the cancel
 *    writer's CAS and smsIneligibilityReason refuse on), while the row is still
 *    'scheduled' or 'sending' (the deliveryLabel reading in comms-tools),
 *    inside the 24-hour hold from the attempt.
 */
function carriesUnknownOutcome(row, now = Date.now()) {
  const meta = parseMeta(row.metadata);
  const attempted = attemptAt(row, meta);
  const within = (ms) => !Number.isFinite(attempted) || attempted >= now - ms;
  if (isUnresolvedSendReservation({ ...row, metadata: meta, created_at: Number.isFinite(attempted) ? new Date(attempted) : row.created_at }, now)) {
    return meta[REVIEW_ASK_MARKER] === true ? within(REVIEW_ASK_HOLD_MS) : true;
  }
  return ['scheduled', 'sending'].includes(String(row.status || ''))
    && Object.keys(meta).some((k) => PRIOR_ATTEMPT_KEY_RE.test(k))
    && within(UNRECONCILED_HOLD_HOURS * 60 * 60 * 1000);
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
 * An outbound row to this number whose text, in the provider-bound form, is this
 * text, and that may already have reached the customer with no confirmed outcome
 * (carriesUnknownOutcome). Null when there is none. The SQL narrows to the number
 * and a coarse time window only; the body is compared in JS on both sides through
 * canonicalSmsBody, because queued rows store the typed body (the composer saves
 * it raw; dispatch normalizes only the outgoing copy). `excludeId` skips the
 * caller's own reservation.
 */
async function findUnreconciledSend({ phone, body }, dbh = db, { excludeId = null } = {}) {
  const identity = phoneIdentityKey(phone);
  const canonical = body ? canonicalSmsBody(body) : '';
  if (!identity || !canonical) return null;
  const now = Date.now();
  const query = dbh('sms_log')
    .where({ direction: 'outbound' })
    .whereRaw('GREATEST(updated_at, created_at) >= ?', [new Date(now - WIDEST_HOLD_MS)])
    .whereRaw(`${phoneIdentitySql("BTRIM(COALESCE(to_phone, ''))")} = ?`, [identity]);
  if (excludeId) query.whereNot('id', excludeId);
  const rows = await query.select('id', 'status', 'metadata', 'message_body', 'created_at', 'updated_at');
  return (rows || []).find((row) => canonicalSmsBody(row.message_body || '') === canonical && carriesUnknownOutcome(row, now)) || null;
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
      to: phone, customerId, fromNumber, body: canonicalSmsBody(body), reservationKind: 'manual', uncertain: true,
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

// What the send's reservation becomes, read with the repo's one delivery
// classification (classifyDeliveryCertainty: the explicit deliveryOutcome wins
// over sent/blocked flags): 'sent' releases it, 'not_sent' releases it,
// 'unknown' leaves it as the held row. A thrown error carries the outcome it
// observed on err.providerOutcome; none means the handoff may have been crossed.
// The wrapper's own interlock refusing THIS attempt (its code, the only hint it
// gives) sent nothing even though it marks the thread's outcome uncertain.
const INTERLOCK_REFUSAL_CODE = 'MANUAL_REPLY_OUTCOME_UNRESOLVED';
const STATE_BY_CERTAINTY = { sent: 'accepted', not_sent: 'not_sent', unknown: 'uncertain' };
function reservationState(outcome, { thrown = false } = {}) {
  if (outcome?.code === INTERLOCK_REFUSAL_CODE) return 'not_sent';
  return STATE_BY_CERTAINTY[classifyDeliveryCertainty(thrown ? outcome?.providerOutcome : outcome)];
}

/**
 * The send lifecycle in one place: acquire the reservation, run the provider
 * handoff `send()`, settle the reservation from its result or its thrown error,
 * and return the result (or rethrow). Returns { refused: true } without calling
 * `send` when a live same-text reservation exists.
 */
async function withSendReservation({ phone, customerId = null, body }, send) {
  const reservation = await acquireSendReservation({ phone, customerId, body });
  if (reservation.refused) return { refused: true };
  const settle = (state) => settleSendReservation(reservation.id, state, { phone, body });
  let result;
  try {
    result = await send();
  } catch (err) {
    await settle(reservationState(err, { thrown: true }));
    throw err;
  }
  await settle(reservationState(result));
  return { result };
}

module.exports = {
  UNRECONCILED_HOLD_HOURS,
  carriesUnknownOutcome,
  unreconciledRefusal,
  findUnreconciledSend,
  acquireSendReservation,
  settleSendReservation,
  withSendReservation,
  reservationState,
  INTERLOCK_REFUSAL_CODE,
};
