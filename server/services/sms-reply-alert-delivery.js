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
async function renewUnknownSenderAlertLease(From, lease) {
  if (!lease.token) return false;
  const next = new Date(Date.now() + UNKNOWN_SENDER_ALERT_LEASE_MS);
  try {
    const updated = await db('sms_reply_alert_claims').where({ phone: From, expires_at: lease.token }).update({ expires_at: next });
    if (updated > 0) lease.token = next;
    return updated > 0;
  } catch (e) {
    logger.warn('[twilio-webhook] alert-window lease renew failed', { code: e.code || 'unknown' });
    return false;
  }
}
// Push fan-out is serial and unbounded, so a fixed lease can expire while
// delivery runs. Renew it on a heartbeat and wait for any in-flight renewal
// so confirm and release always address the current token.
async function withLeaseHeartbeat(From, lease, work) {
  if (!lease.token) return work();
  let inflight = Promise.resolve(false);
  const timer = setInterval(() => {
    inflight = inflight.then(() => renewUnknownSenderAlertLease(From, lease)).catch(() => false);
  }, UNKNOWN_SENDER_ALERT_LEASE_MS / 2);
  if (typeof timer.unref === 'function') timer.unref();
  try { return await work(); } finally { clearInterval(timer); await inflight; }
}
// One bell row per customer conversation (owner 2026-10-01: ten texts in twelve
// minutes rang ten rows). The row is keyed on the customer, so notifyAdmin's
// refreshOnDedupe rewrites it for each new text — latest text as the body, a
// running count in the title, unread again, bumped to the top — instead of
// inserting another. The link keeps the `?thread=<customerId>` prefix that
// markInboundSmsReadAdmin and inbound-sms-read match on.
const threadBellKey = (customerId) => `sms-thread:${customerId}`;

// Decided INSIDE notifyAdmin's keyed lock (standingRefresh), against the row as
// it stands then, so two texts processed at once cannot race: both used to read
// the row before the lock, and the older one could win the lock second and
// overwrite the newer text.
//   - How many texts the open row stands for: count + 1. It restarts at 1 once
//     the row was read or done (that thread was dealt with), and a replay of the
//     text already on the row (a webhook retry) leaves it as it was.
//   - Which message is newer: by the time the text arrived (payload.receivedAtMs,
//     ties by sid). An OLDER text only moves the count; the row keeps the newer
//     text, sid, link and place in the list (keepContent).
const isOlderMessage = (ms, sid, base) => {
  const other = Number(base.receivedAtMs);
  if (!Number.isFinite(other)) return false;
  return ms < other || (ms === other && String(sid) < String(base.twilioSid || ''));
};
const threadRefresh = (MessageSid, receivedAtMs) => (existing, base) => {
  const count = Math.max(1, Math.floor(Number(base.textCount)) || 1);
  if (base.twilioSid === MessageSid) return { payload: { textCount: count } };
  if (existing.read_at || existing.done_at) return { payload: { textCount: 1 } };
  return { payload: { textCount: count + 1 }, keepContent: isOlderMessage(receivedAtMs, MessageSid, base) };
};

// When the text reached us: the unified message row's own time, else now.
async function receivedAtMs(MessageSid) {
  try {
    const row = await db('messages').where({ channel: 'sms', twilio_sid: MessageSid }).first('created_at');
    const ms = row?.created_at ? new Date(row.created_at).getTime() : NaN;
    return Number.isFinite(ms) ? ms : Date.now();
  } catch (e) {
    return Date.now();
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
  const dedupeKey = customer ? threadBellKey(customer.id) : `sms-reply:${MessageSid}`;
  const arrivedAtMs = customer ? await receivedAtMs(MessageSid) : null;
  const existingBell = !customer && await db('notifications')
    .where({ recipient_type: 'admin' }).whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey]).first('id', 'created_at');
  const stats = existingBell ? { bellWritten: true, push: null, deduped: true } : await triggerNotification('sms_reply', {
    fromName: customer ? `${customer.first_name} ${customer.last_name}` : null,
    fromPhone: From,
    message,
    threadId: customer?.id || null,
    twilioSid: MessageSid,
    ...(customer ? { textCount: 1, receivedAtMs: arrivedAtMs } : {}),
  }, { beforePush: unifiedStillUnread, dedupeKey, ...(customer ? { refreshOnDedupe: true, bumpOnRefresh: true, refreshPayload: threadRefresh(MessageSid, arrivedAtMs) } : {}) });
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
  // Without a recorded eligibility marker a failed delivery would be invisible
  // to recovery; report unhandled before claiming so the caller keeps the message.
  if (!recovery && !(await stampInboundSmsMeta(MessageSid, { sms_reply_eligible: true }, 'eligibility'))) return false;
  const lease = await claimUnknownSenderAlertWindow(From);
  if (!lease.claimed) {
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
      || [meta.sms_reply_alerted, meta.sms_reply_covered, meta.sms_reply_read, meta.sms_reply_suppressed, meta.sms_reply_ai_answered].includes(true)
      || (meta.sms_reply_processing_until
      && new Date(meta.sms_reply_processing_until).getTime() > Date.now())) {
      await releaseUnknownSenderAlertClaim(From, lease.token);
      return false;
    }
  }
  if (await hasRecentUnknownSenderReceipt(From, MessageSid)) {
    // Coverage is a terminal outcome: recovery must not re-alert this message
    // once the covering receipt ages out. Unrecorded coverage is not handled.
    const covered = await stampInboundSmsMeta(MessageSid, { sms_reply_covered: true }, 'coverage');
    await releaseUnknownSenderAlertClaim(From, lease.token);
    return covered;
  }
  let delivered = false;
  let suppressed = false;
  let stats = {};
  let alreadyRead = false;
  try {
    stats = await withLeaseHeartbeat(From, lease, () => ringSmsReplyBell({ customer: null, From, MessageSid, message, afterRead })) || {};
    const { error, bellWritten, push } = stats;
    delivered = !error && Boolean(bellWritten || Number(push?.sent) > 0);
    suppressed = Boolean(stats.suppressed || stats.policySilenced);
  } catch (e) {
    if (e.alreadyRead) { alreadyRead = true; logger.info('[notifications] sms_reply skipped — thread read before the bell'); }
    else logger.error('[notifications] unknown-sender sms_reply trigger failed', { code: e.code || 'unknown' });
  }
  if (delivered && stats.receiptWritten !== false) {
    await confirmUnknownSenderAlertWindow(From, lease.token, stats.deliveredAt);
  } else {
    await releaseUnknownSenderAlertClaim(From, lease.token);
    // Suppression and read-before-bell are terminal only once their marker is recorded.
    if (suppressed) suppressed = await stampInboundSmsMeta(MessageSid, { sms_reply_suppressed: true }, 'suppression');
    if (alreadyRead) alreadyRead = await stampInboundSmsMeta(MessageSid, { sms_reply_read: true }, 'read');
  }
  return delivered || suppressed || alreadyRead;
}

module.exports = { ringSmsReplyBell, dispatchUnknownSenderAlert, claimUnknownSenderAlertWindow, confirmUnknownSenderAlertWindow, releaseUnknownSenderAlertClaim };
