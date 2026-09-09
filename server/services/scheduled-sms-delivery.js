const db = require('../models/db');
const { looksLikeReviewAsk } = require('./review-ask-history');
const { dispatchReviewAsk } = require('./review-ask-dispatch');
const { requiresDurableFinalize } = require('./messaging/deferred-replay-registry');

async function acceptedScheduledSms(id, err) {
  if (err?.providerOutcome?.sent === true) return err.providerOutcome;
  const row = await db('sms_log').where({ direction: 'outbound' })
    .whereIn('status', ['queued', 'sent', 'delivered'])
    .whereRaw("metadata->>'scheduled_sms_log_id' = ?", [String(id)])
    .first('id', 'twilio_sid');
  return row ? { sent: true, providerMessageId: row.twilio_sid || null } : null;
}

async function markScheduledSmsSent(msg, meta, result, reviewAsk = !!meta.bundled_review_request_id || meta.replay_purpose === 'review_request' || looksLikeReviewAsk(msg.message_body)) {
  const completedAt = new Date();
  // Preserve the queue time while ordering the conversation by delivery.
  // Finalization evidence rides the same atomic update so a crash cannot
  // lose the owed replay hooks or the accepted SID they need.
  let metadataSql = "COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('queued_at', created_at)";
  const bindings = [];
  if (requiresDurableFinalize(meta.entry_point)) {
    metadataSql += " || jsonb_build_object('finalize_pending', true, 'provider_message_id', ?::text)";
    bindings.push(result.providerMessageId || null);
  }
  if (reviewAsk) {
    metadataSql += " || jsonb_build_object('review_ask_delivered_at', ?::timestamptz)";
    bindings.push(completedAt);
  }
  await db('sms_log').where({ id: msg.id, status: 'sending' }).update({
    status: 'sent',
    created_at: completedAt,
    updated_at: completedAt,
    metadata: db.raw(metadataSql, bindings),
  });
}

async function dispatchScheduledSms(msg, meta, send, purpose) {
  const reviewAsk = purpose === 'review_request' || !!meta.bundled_review_request_id || looksLikeReviewAsk(msg.message_body);
  const dispatch = async () => {
    let result;
    try {
      result = await send();
      if (result.sent) await markScheduledSmsSent(msg, meta, result, reviewAsk);
      return result;
    } catch (err) {
      err.scheduledReviewAsk = reviewAsk;
      if (result?.sent) err.providerOutcome = result;
      const accepted = await acceptedScheduledSms(msg.id, err);
      if (accepted) {
        err.providerOutcome = accepted;
        await markScheduledSmsSent(msg, meta, accepted, reviewAsk);
      }
      throw err;
    }
  };
  if (!reviewAsk) return dispatch();
  const result = await dispatchReviewAsk(msg.customer_id, dispatch);
  if (!['REVIEW_ASK_SPACING', 'REVIEW_HISTORY_UNAVAILABLE', 'REVIEW_SEND_BUSY'].includes(result?.code)) return result;
  // These are pre-provider holds, not failed delivery attempts. Refund the
  // claim's attempt and retain the existing metadata/finalization contract.
  await db('sms_log').where({ id: msg.id, status: 'sending' }).update({
    status: 'scheduled',
    scheduled_for: new Date(result.nextAllowedAt || Date.now() + 15 * 60000),
    updated_at: new Date(),
    metadata: db.raw(`COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'review_hold_reason', ?::text,
      'scheduled_sms_attempts', GREATEST(CASE
        WHEN COALESCE(metadata->>'scheduled_sms_attempts', '') ~ '^[0-9]+$'
          THEN (metadata->>'scheduled_sms_attempts')::int - 1
        ELSE 0 END, 0))`, [result.code]),
  });
  return { ...result, scheduledHold: true };
}

module.exports = { acceptedScheduledSms, markScheduledSmsSent, dispatchScheduledSms };
