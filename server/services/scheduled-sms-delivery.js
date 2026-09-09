const db = require('../models/db');
const { looksLikeReviewAsk } = require('./review-ask-history');
const { dispatchReviewAsk } = require('./review-ask-dispatch');
const { requiresDurableFinalize } = require('./messaging/deferred-replay-registry');

async function acceptedScheduledSms(id, err) {
  if (require('./sms-auto-send').isRealProviderSend(err?.providerOutcome)) return err.providerOutcome;
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
  let metadataSql = "(COALESCE(metadata, '{}'::jsonb) - 'review_ask_reservation') || jsonb_build_object('queued_at', COALESCE(metadata->'queued_at', to_jsonb(created_at)))";
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
  let reviewAsk = purpose === 'review_request' || !!meta.bundled_review_request_id || looksLikeReviewAsk(msg.message_body);
  const clearUnsentReservation = async () => {
    if (!reviewAsk) return;
    await db('sms_log').where({ id: msg.id, status: 'sending' }).update({
      metadata: db.raw("COALESCE(metadata, '{}'::jsonb) - 'review_ask_reservation'"),
    });
    delete meta.review_ask_reservation;
  };
  const dispatch = async () => {
    let result;
    try {
      if (reviewAsk) {
        // Persist conservative evidence BEFORE the provider boundary. If
        // provider logging and every settlement write fail, other dispatchers
        // still see this attempt while outer recovery finishes the row.
        const reserved = await db('sms_log').where({ id: msg.id, status: 'sending' }).update({
          metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('review_ask_reservation', true, 'queued_at', COALESCE(metadata->'queued_at', to_jsonb(created_at)))"),
          created_at: new Date(), updated_at: new Date(),
        });
        if (!reserved) throw new Error('Scheduled review claim lost before provider dispatch');
      }
      result = await send();
      if (reviewAsk && result.sent && !require('./sms-auto-send').isRealProviderSend(result)) {
        // The scheduler owns the sending -> blocked transition and stamps
        // its durable terminal-hook obligation in that same update.
        await clearUnsentReservation();
        return { ...result, sent: false, blocked: true, code: 'REVIEW_SEND_SUPPRESSED' };
      }
      if (result.sent === false) await clearUnsentReservation();
      if (result.sent) await markScheduledSmsSent(msg, meta, result, reviewAsk);
      return result;
    } catch (err) {
      err.scheduledReviewAsk = reviewAsk;
      if (result) err.providerOutcome = result;
      if (err.providerOutcome?.sent === false) await clearUnsentReservation();
      const accepted = await acceptedScheduledSms(msg.id, err);
      if (accepted) {
        err.providerOutcome = accepted;
        try {
          await markScheduledSmsSent(msg, meta, accepted, reviewAsk);
        } catch (stampErr) {
          stampErr.providerOutcome = accepted;
          stampErr.scheduledReviewAsk = reviewAsk;
          throw stampErr;
        }
      }
      throw err;
    }
  };
  if (!reviewAsk) return dispatch();
  const result = await dispatchReviewAsk(msg.customer_id, dispatch);
  if (!['REVIEW_ASK_SPACING', 'REVIEW_HISTORY_UNAVAILABLE', 'REVIEW_SEND_BUSY'].includes(result?.code)) return result;
  // Completion delivery must not wait behind its optional review invitation.
  // Remove only the exact suffix we generated, preserving every receipt,
  // invoice and report link. Persist body and linkage together before send.
  if (meta.entry_point === 'dispatch_completion_deferred' && meta.bundled_review_request_id) {
    const body = msg.message_body.replace(/\n\nEnjoyed the service\? A quick review means the world: (?:https?:\/\/)?[^\s]+(?=\s*(?:Reply STOP to (?:unsubscribe|opt out)\.?)?\s*$)/i, '').trim();
    if (body && body !== msg.message_body && !looksLikeReviewAsk(body)) {
      const changed = await db('sms_log').where({ id: msg.id, status: 'sending' }).update({
        message_body: body,
        metadata: db.raw("COALESCE(metadata, '{}'::jsonb) - 'bundled_review_request_id' - 'review_ask_reservation'"),
        updated_at: new Date(),
      });
      if (!changed) throw new Error('Scheduled completion claim lost before removing review invitation');
      msg.message_body = body;
      delete meta.bundled_review_request_id;
      delete meta.review_ask_reservation;
      reviewAsk = false;
      return dispatch();
    }
  }
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
