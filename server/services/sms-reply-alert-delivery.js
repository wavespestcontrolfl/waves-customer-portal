// Shared delivery lifecycle for inbound SMS alerts and durable recovery.
const db = require('../models/db');
const logger = require('./logger');

// Reserve briefly; confirm four hours only after a durable delivery receipt.
const UNKNOWN_SENDER_ALERT_WINDOW_MS = 4 * 60 * 60 * 1000;
const UNKNOWN_SENDER_ALERT_LEASE_MS = 2 * 60 * 1000;
async function claimUnknownSenderAlertWindow(From) {
  try {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + UNKNOWN_SENDER_ALERT_LEASE_MS);
    const result = await db.raw(
      `INSERT INTO sms_reply_alert_claims (phone, expires_at)
       VALUES (?, ?)
       ON CONFLICT (phone) DO UPDATE SET expires_at = EXCLUDED.expires_at
       WHERE sms_reply_alert_claims.expires_at < ?
       RETURNING phone`,
      [From, leaseExpiresAt, now],
    );
    const claimed = (result?.rows || []).length > 0;
    return { claimed, token: claimed ? leaseExpiresAt : null };
  } catch (e) {
    logger.warn('[twilio-webhook] alert-window claim failed; proceeding unfenced', { code: e.code || 'unknown' });
    return { claimed: true, token: null };
  }
}
async function confirmUnknownSenderAlertWindow(From, token, deliveredAt = new Date()) {
  if (!token) return;
  try {
    await db('sms_reply_alert_claims').where({ phone: From, expires_at: token })
      .update({ expires_at: new Date(new Date(deliveredAt).getTime() + UNKNOWN_SENDER_ALERT_WINDOW_MS) });
  } catch (e) {
    logger.warn('[twilio-webhook] alert-window claim confirm failed', { code: e.code || 'unknown' });
  }
}
async function releaseUnknownSenderAlertClaim(From, token) {
  if (!token) return;
  try {
    await db('sms_reply_alert_claims').where({ phone: From, expires_at: token }).del();
  } catch (e) {
    logger.warn('[twilio-webhook] alert-window claim release failed', { code: e.code || 'unknown' });
  }
}
async function ringSmsReplyBell({ customer, From, MessageSid, message, afterRead }) {
  if (!customer && typeof afterRead !== 'function') throw new Error('Unknown SMS delivery requires read reconciliation');
  const { triggerNotification } = require('./notification-triggers');
  const unifiedStillUnread = () => db('messages').where({ channel: 'sms', twilio_sid: MessageSid }).first('is_read')
    .then((r) => r?.is_read !== true).catch(() => true);
  if (!(await unifiedStillUnread())) throw Object.assign(new Error('thread already read'), { alreadyRead: true });
  // A committed bell is delivery evidence even if its legacy receipt failed.
  // Keep identity outside the mutable payload: reads can retarget that payload.
  const dedupeKey = customer ? null : `sms-reply:${MessageSid}`;
  const existingBell = dedupeKey && await db('notifications')
    .where({ recipient_type: 'admin' }).whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey]).first('id', 'created_at');
  const stats = existingBell ? { bellWritten: true, push: null, deduped: true } : await triggerNotification('sms_reply', {
    fromName: customer ? `${customer.first_name} ${customer.last_name}` : null,
    fromPhone: From,
    message,
    threadId: customer?.id || null,
    twilioSid: MessageSid,
  }, { beforePush: unifiedStillUnread, ...(dedupeKey ? { dedupeKey } : {}) });
  let receiptWritten = false;
  if (!customer && stats && !stats.error && (stats.bellWritten || Number(stats.push?.sent || 0) > 0)) {
    stats.deliveredAt = existingBell?.created_at || new Date();
    const writeReceipt = () => db('sms_log').where({ direction: 'inbound', twilio_sid: MessageSid }).update({
      metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ sms_reply_alerted: true })]),
      updated_at: stats.deliveredAt,
    });
    receiptWritten = await writeReceipt()
      .then((updated) => updated > 0)
      .catch(() => writeReceipt().then((updated) => updated > 0))
      .catch((err) => {
        logger.warn('[notifications] SMS alert receipt failed', { code: err.code || 'unknown' });
        return false;
      });
  }
  if (stats && typeof stats === 'object') stats.receiptWritten = receiptWritten;
  try {
    if (!(await unifiedStillUnread())) {
      if (customer) {
        await require('./notification-service').markInboundSmsReadAdmin({ customerId: customer.id, twilioSid: MessageSid });
      } else {
        await afterRead({ From, MessageSid });
      }
    }
  } catch (e) { logger.warn('[notifications] sms_reply post-check failed', { code: e.code || 'unknown' }); }
  return stats;
}

// Durable per-message outcome markers; recovery treats each terminal one as
// settled. Resolves true only when the row was updated, after one retry, so a
// caller never reports a terminal outcome that was not recorded.
async function stampInboundSmsMeta(MessageSid, patch, label) {
  const write = () => db('sms_log').where({ direction: 'inbound', twilio_sid: MessageSid })
    .update({ metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify(patch)]) });
  return write().then((updated) => updated > 0)
    .catch(() => write().then((updated) => updated > 0))
    .catch((err) => {
      logger.warn(`[twilio-webhook] sms_reply ${label} stamp failed`, { code: err.code || 'unknown' });
      return false;
    });
}

// A previous delivered receipt can cover this phone independent of claim state.
async function hasRecentUnknownSenderReceipt(From, excludeSid) {
  try {
    const prior = await db('sms_log')
      .where({ direction: 'inbound', from_phone: From })
      .whereRaw("metadata->>'sms_reply_alerted' = 'true'")
      .where('updated_at', '>', new Date(Date.now() - UNKNOWN_SENDER_ALERT_WINDOW_MS))
      .whereNot('twilio_sid', excludeSid)
      .first('id');
    return Boolean(prior);
  } catch (e) {
    logger.warn('[twilio-webhook] repeat-sender check failed', { code: e.code || 'unknown' });
    return false;
  }
}

// Use the same fenced lifecycle for webhooks and process-independent recovery.
async function dispatchUnknownSenderAlert({ From, MessageSid, message, recovery = false, afterRead }) {
  if (!recovery) await stampInboundSmsMeta(MessageSid, { sms_reply_eligible: true }, 'eligibility');
  const { claimed, token } = await claimUnknownSenderAlertWindow(From);
  if (!claimed) {
    // Another owner holds this sender. A confirmed receipt covers this message
    // terminally; an in-progress lease leaves it eligible for recovery.
    if (!(await hasRecentUnknownSenderReceipt(From, MessageSid))) return true;
    return stampInboundSmsMeta(MessageSid, { sms_reply_covered: true }, 'coverage');
  }
  if (recovery) {
    const row = await db('sms_log').where({ direction: 'inbound', twilio_sid: MessageSid }).first('metadata')
      .catch(() => null);
    const meta = row?.metadata || {};
    if (meta.sms_reply_eligible !== true
      || [meta.sms_reply_alerted, meta.sms_reply_covered, meta.sms_reply_suppressed, meta.sms_reply_ai_answered].includes(true)
      || (meta.sms_reply_processing_until
      && new Date(meta.sms_reply_processing_until).getTime() > Date.now())) {
      await releaseUnknownSenderAlertClaim(From, token);
      return false;
    }
  }
  if (await hasRecentUnknownSenderReceipt(From, MessageSid)) {
    // Coverage is a terminal outcome: recovery must not re-alert this message
    // once the covering receipt ages out. Unrecorded coverage is not handled.
    const covered = await stampInboundSmsMeta(MessageSid, { sms_reply_covered: true }, 'coverage');
    await releaseUnknownSenderAlertClaim(From, token);
    return covered;
  }
  let delivered = false;
  let suppressed = false;
  let stats = {};
  let alreadyRead = false;
  try {
    stats = await ringSmsReplyBell({ customer: null, From, MessageSid, message, afterRead }) || {};
    const { error, bellWritten, push } = stats;
    delivered = !error && Boolean(bellWritten || Number(push?.sent) > 0);
    suppressed = Boolean(stats.suppressed || stats.policySilenced);
  } catch (e) {
    if (e.alreadyRead) { alreadyRead = true; logger.info('[notifications] sms_reply skipped — thread read before the bell'); }
    else logger.error('[notifications] unknown-sender sms_reply trigger failed', { code: e.code || 'unknown' });
  }
  if (delivered && stats.receiptWritten !== false) {
    await confirmUnknownSenderAlertWindow(From, token, stats.deliveredAt);
  } else {
    await releaseUnknownSenderAlertClaim(From, token);
    // Suppression is terminal only once its marker is recorded.
    if (suppressed) suppressed = await stampInboundSmsMeta(MessageSid, { sms_reply_suppressed: true }, 'suppression');
  }
  return delivered || suppressed || alreadyRead;
}

module.exports = { ringSmsReplyBell, dispatchUnknownSenderAlert, claimUnknownSenderAlertWindow, confirmUnknownSenderAlertWindow, releaseUnknownSenderAlertClaim };
