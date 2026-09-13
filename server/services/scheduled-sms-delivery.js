const db = require('../models/db');
const { ASK_SPACING_MS, looksLikeReviewAsk } = require('./review-ask-history');
const { dispatchReviewAsk } = require('./review-ask-dispatch');
const { requiresDurableFinalize } = require('./messaging/deferred-replay-registry');

async function acceptedScheduledSms(id, err) {
  if (err?.providerOutcome?.deliveryOutcome === 'accepted') return err.providerOutcome;
  const row = await db('sms_log').where({ direction: 'outbound' })
    .whereIn('status', ['queued', 'sent', 'delivered'])
    .whereRaw("metadata->>'scheduled_sms_log_id' = ?", [String(id)])
    .first('id', 'twilio_sid');
  return row ? { sent: true, deliveryOutcome: 'accepted', providerMessageId: row.twilio_sid || null } : null;
}

async function markScheduledSmsSent(msg, meta, result, reviewAsk = !!meta.bundled_review_request_id || meta.replay_purpose === 'review_request' || looksLikeReviewAsk(msg.message_body)) {
  const completedAt = new Date();
  // Preserve the queue time while ordering the conversation by delivery.
  // Finalization evidence rides the same atomic update so a crash cannot
  // lose the owed replay hooks or the accepted SID they need.
  let metadataSql = "(COALESCE(metadata, '{}'::jsonb) - 'review_ask_reservation' - 'review_delivery_uncertain_exhausted' - 'review_delivery_safety_until') || jsonb_build_object('queued_at', COALESCE(metadata->'queued_at', to_jsonb(created_at)))";
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

async function dispatchScheduledSms(msg, meta, send, purpose, maxAttempts = 3) {
  let reviewAsk = purpose === 'review_request' || !!meta.bundled_review_request_id
    || meta.review_delivery_uncertain_exhausted === true || looksLikeReviewAsk(msg.message_body);
  const attemptsExhausted = (Number(meta.scheduled_sms_attempts) || 1) >= maxAttempts;
  let finalAttemptSafetyUntil = null;
  // A final ambiguous provider handoff stays quiet for the full ask-spacing
  // window. Once that hold expires, return to the scheduler's existing
  // terminal rail without making a fourth provider call; that rail owns the
  // durable terminal hook and any parked-decision reopening.
  if (reviewAsk && meta.review_delivery_uncertain_exhausted === true) {
    return {
      sent: false,
      deliveryOutcome: 'uncertain',
      retryable: false,
      uncertaintyExhausted: true,
      code: 'REVIEW_DELIVERY_UNCERTAIN_EXHAUSTED',
    };
  }
  const clearUnsentReservation = async () => {
    if (!reviewAsk) return;
    await db('sms_log').where({ id: msg.id, status: 'sending' }).update({
      metadata: db.raw("COALESCE(metadata, '{}'::jsonb) - 'review_ask_reservation' - 'review_delivery_uncertain_exhausted' - 'review_delivery_safety_until'"),
    });
    delete meta.review_ask_reservation;
    delete meta.review_delivery_uncertain_exhausted;
    delete meta.review_delivery_safety_until;
  };
  const holdUncertainReservation = async outcome => {
    const nextAllowedAt = finalAttemptSafetyUntil || new Date(Date.now() + ASK_SPACING_MS);
    const heldAt = new Date();
    const holdError = err => Object.assign(err, {
      providerOutcome: outcome,
      scheduledReviewAsk: true,
      reviewUncertaintyHoldFailed: true,
    });
    let held;
    try {
      held = await db('sms_log').where({ id: msg.id, status: 'sending' }).update({
        status: 'scheduled',
        scheduled_for: nextAllowedAt,
        updated_at: heldAt,
      });
    } catch (err) {
      throw holdError(err);
    }
    if (!held) throw holdError(new Error('Scheduled review claim lost while holding uncertain delivery'));
    return { ...outcome, sent: false, scheduledHold: true, attemptsExhausted, nextAllowedAt };
  };
  const dispatch = async () => {
    let result;
    try {
      if (reviewAsk) {
        // Persist conservative evidence BEFORE the provider boundary. If
        // provider logging and every settlement write fail, other dispatchers
        // still see this attempt while outer recovery finishes the row.
        const reservedAt = new Date();
        finalAttemptSafetyUntil = attemptsExhausted
          ? new Date(reservedAt.getTime() + ASK_SPACING_MS)
          : null;
        const reservationSql = "COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('review_ask_reservation', true, 'queued_at', COALESCE(metadata->'queued_at', to_jsonb(created_at)))"
          + (finalAttemptSafetyUntil
            ? " || jsonb_build_object('review_delivery_uncertain_exhausted', true, 'review_delivery_safety_until', ?::timestamptz)"
            : '');
        const reserved = await db('sms_log').where({ id: msg.id, status: 'sending' }).update({
          metadata: db.raw(reservationSql, finalAttemptSafetyUntil ? [finalAttemptSafetyUntil] : []),
          created_at: reservedAt, updated_at: reservedAt,
        });
        if (!reserved) throw new Error('Scheduled review claim lost before provider dispatch');
      }
      result = await send();
      // sendCustomerMessage always names its outcome (#4338); a legacy
      // sender shape that reports sent:true with no outcome is still an
      // accepted handoff — the scheduler's own follow-up (finalization,
      // terminal hooks) already treats it as sent, so the row must flip to
      // 'sent' here too or it strands in 'sending' until stale recovery.
      const deliveryOutcome = result?.deliveryOutcome || (result?.sent === true ? 'accepted' : undefined);
      if (deliveryOutcome === 'not_sent' && result.sent) {
        // The scheduler owns the sending -> blocked transition and stamps
        // its durable terminal-hook obligation in that same update.
        await clearUnsentReservation();
        return { ...result, sent: false, blocked: true, code: reviewAsk ? 'REVIEW_SEND_SUPPRESSED' : 'DELIVERY_SUPPRESSED' };
      }
      if (deliveryOutcome === 'not_sent') await clearUnsentReservation();
      if (deliveryOutcome === 'accepted') await markScheduledSmsSent(msg, meta, result, reviewAsk);
      if (reviewAsk && deliveryOutcome !== 'accepted' && deliveryOutcome !== 'not_sent') {
        return holdUncertainReservation({ ...result, deliveryOutcome: 'uncertain' });
      }
      return result;
    } catch (err) {
      if (err.reviewUncertaintyHoldFailed) throw err;
      err.scheduledReviewAsk = reviewAsk;
      if (result) err.providerOutcome = result;
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
      const deliveryOutcome = err.providerOutcome?.deliveryOutcome;
      if (deliveryOutcome === 'not_sent') await clearUnsentReservation();
      if (reviewAsk && deliveryOutcome !== 'accepted' && deliveryOutcome !== 'not_sent') {
        return holdUncertainReservation({ ...err.providerOutcome, deliveryOutcome: 'uncertain' });
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
      const explicitRetryAt = result.nextAllowedAt ? new Date(result.nextAllowedAt) : null;
      const reviewRetryAt = explicitRetryAt && !Number.isNaN(explicitRetryAt.getTime())
        ? explicitRetryAt
        : new Date(Date.now() + 15 * 60 * 1000);
      const bundledReviewRequestId = meta.bundled_review_request_id;
      // The completion/receipt must continue without the optional ask, but
      // dropping its only replay linkage used to strand an unscheduled inline
      // request: delivery finalization could no longer mark it delivered and
      // terminal recovery could no longer arm its standalone fallback. Arm
      // the still-pending request in the SAME transaction as the body rewrite
      // so every committed stripped completion leaves one durable send owner.
      // A zero-row update means the request is already delivered, suppressed,
      // missing, or actively claimed and therefore owns its own settlement.
      await db.transaction(async trx => {
        await trx('review_requests')
          .where({ id: bundledReviewRequestId, status: 'pending' })
          .whereNull('sms_sent_at')
          .update({ scheduled_for: reviewRetryAt });
        const changed = await trx('sms_log').where({ id: msg.id, status: 'sending' }).update({
          message_body: body,
          metadata: trx.raw("COALESCE(metadata, '{}'::jsonb) - 'bundled_review_request_id' - 'review_ask_reservation'"),
          updated_at: new Date(),
        });
        if (!changed) throw new Error('Scheduled completion claim lost before removing review invitation');
      });
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
