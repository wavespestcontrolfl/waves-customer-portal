/**
 * Abandoned-booking recovery
 *
 * A public /book visitor who entered contact info + picked a slot but never
 * tapped "Confirm" is captured as a booking_intents row (routes/booking.js
 * POST /capture-intent). This service chases the un-converted ones:
 *   - Touch 1 — recovery SMS ~1h after abandon (warm; the slot may still be open)
 *   - Touch 2 — recovery email ~24h after abandon, if still not booked
 *
 * Ships LIVE behind bookingAbandonRecovery (kill switch
 * GATE_BOOKING_ABANDON_RECOVERY=false → shadow-logs counts, never sends).
 *
 * Mirrors the estimate deposit-abandonment stage (services/estimate-follow-up.js):
 * per-stage atomic claim flags, quiet hours, reply-pause, transactional consent,
 * release-on-failure so a blocked send retries next tick. Runs from scheduler.js.
 */

const db = require('../models/db');
const logger = require('./logger');
const EmailTemplateLibrary = require('./email-template-library');
const smsTemplatesRouter = require('../routes/admin-sms-templates');
const { shortenOrPassthrough } = require('./short-url');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { isEnabled } = require('../config/feature-gates');

// Touch windows (hours from captured_at). The cron runs every 30 min, so the
// SMS fires ~1–1.5h after abandon. Max-age caps how stale a lead we'll chase.
const SMS_MIN_AGE_H = 1;
const SMS_MAX_AGE_H = 48;
const EMAIL_MIN_AGE_H = 24;
const EMAIL_MAX_AGE_H = 168; // 7 days

const BOOKING_URL = 'https://portal.wavespestcontrol.com/book?source=booking_recovery';

// 8a–8p America/New_York — never text outside business hours (matches the
// messaging quiet-hours validator window for enforced purposes). The pre-check
// avoids claim churn; the validator is the backstop.
function isQuietHours(now = new Date()) {
  const hour = parseInt(new Intl.DateTimeFormat('en-US', {
    hour: '2-digit', hour12: false, timeZone: 'America/New_York',
  }).format(now), 10);
  if (Number.isNaN(hour)) return false; // fail open
  return hour < 8 || hour >= 20;
}

function last10(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : d;
}

// Reply-pause: if this phone has SMS'd Waves recently, let Virginia handle it
// live instead of a cron nudge. Soft-fails so a missing table never breaks the
// loop.
async function hasRepliedRecently(phone, days = 14) {
  const ten = last10(phone);
  if (!ten) return false;
  const cutoff = new Date(Date.now() - days * 86400000);
  try {
    const row = await db('messages')
      .join('conversations', 'messages.conversation_id', 'conversations.id')
      .where('messages.direction', 'inbound')
      .where('messages.channel', 'sms')
      .where('messages.created_at', '>=', cutoff)
      .whereRaw("RIGHT(regexp_replace(COALESCE(conversations.contact_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [ten])
      .first('messages.id');
    return !!row;
  } catch (e) {
    logger.warn(`[booking-recovery] reply-pause check skipped: ${e.message}`);
    return false; // fail open
  }
}

async function renderSms(vars) {
  try {
    if (typeof smsTemplatesRouter.getTemplate === 'function') {
      const body = await smsTemplatesRouter.getTemplate('booking_abandonment_recovery', vars, {
        workflow: 'booking_abandon_recovery', entity_type: 'booking_intent',
      });
      if (body) return body;
    }
  } catch (err) {
    logger.warn(`[booking-recovery] SMS template lookup failed: ${err.message}`);
  }
  logger.warn('[booking-recovery] booking_abandonment_recovery SMS template missing/disabled');
  return null;
}

// Atomic stage claim — flips false/NULL → true, returns true only if THIS caller
// won. (The cron is single-instance via runExclusive, but the claim also guards
// an accidental overlap and pairs with release-on-failure.)
async function claimStage(intentId, flag) {
  const affected = await db('booking_intents')
    .where({ id: intentId })
    .where((q) => q.where(flag, false).orWhereNull(flag))
    .update({ [flag]: true, updated_at: db.fn.now() });
  return affected === 1;
}

async function releaseStage(intentId, flag) {
  await db('booking_intents').where({ id: intentId }).update({ [flag]: false, updated_at: db.fn.now() });
}

// After a successful send to a phone, mark any OTHER open intents for the same
// phone as sent too, so a person who started /book twice gets ONE recovery touch.
async function markSiblingsSent(phone, flag, excludeId) {
  const ten = last10(phone);
  if (!ten) return;
  try {
    await db('booking_intents')
      .whereNot('id', excludeId)
      .whereNull('converted_at')
      .where((q) => q.where(flag, false).orWhereNull(flag))
      .whereRaw("RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [ten])
      .update({ [flag]: true, updated_at: db.fn.now() });
  } catch (e) {
    logger.warn(`[booking-recovery] sibling mark failed (non-blocking): ${e.message}`);
  }
}

function firstNameOf(intent) {
  return (intent.first_name || '').trim().split(' ')[0] || 'there';
}
function serviceLabelOf(intent) {
  return (intent.service_type || '').trim() || 'your service';
}

async function bookingUrlFor(intent) {
  return shortenOrPassthrough(BOOKING_URL, {
    kind: 'booking', entityType: 'booking_intents', entityId: intent.id, customerId: intent.customer_id || null,
  }).catch(() => BOOKING_URL);
}

// ── SMS stage (touch 1) ────────────────────────────────────────────────────
async function runSmsStage(now, sentPhones) {
  const nowMs = now.getTime();
  const candidates = await db('booking_intents')
    .whereNull('converted_at')
    .where('suppressed', false)
    .where((q) => q.where('followup_sms_sent', false).orWhereNull('followup_sms_sent'))
    // Window on last_activity_at (last funnel touch), not captured_at, so we
    // never text someone who is still actively filling out the booking form.
    .where('last_activity_at', '<', new Date(nowMs - SMS_MIN_AGE_H * 3600000))
    .where('last_activity_at', '>', new Date(nowMs - SMS_MAX_AGE_H * 3600000))
    .whereNotNull('phone')
    .orderBy('last_activity_at', 'desc')
    .select('*');

  if (!candidates.length) return 0;
  if (!isEnabled('bookingAbandonRecovery')) {
    logger.info(`[booking-recovery] SMS shadow: ${candidates.length} candidate(s), gate off — no sends`);
    return 0;
  }

  let sent = 0;
  for (const intent of candidates) {
    const ten = last10(intent.phone);
    if (ten && sentPhones.has(ten)) continue; // one touch per phone per run
    let claimed = false;
    try {
      if (isQuietHours(now)) continue;
      if (await hasRepliedRecently(intent.phone)) {
        logger.info(`[booking-recovery] SMS skip ${intent.id}: customer-replied-recently`);
        continue;
      }
      const body = await renderSms({
        first_name: firstNameOf(intent),
        service_type: serviceLabelOf(intent),
        booking_url: await bookingUrlFor(intent),
      });
      if (!body) continue; // missing template — don't claim, retry next tick

      if (!(await claimStage(intent.id, 'followup_sms_sent'))) continue;
      claimed = true;

      const result = await sendCustomerMessage({
        to: intent.phone,
        body,
        channel: 'sms',
        audience: intent.customer_id ? 'customer' : 'lead',
        purpose: 'booking_abandonment_followup',
        customerId: intent.customer_id || undefined,
        identityTrustLevel: intent.customer_id ? 'phone_matches_customer' : 'phone_provided_unverified',
        consentBasis: intent.customer_id ? undefined : {
          status: 'transactional_allowed',
          source: 'booking_abandon_recovery',
          capturedAt: intent.captured_at || new Date().toISOString(),
        },
        entryPoint: 'booking_abandon_recovery_cron',
        metadata: { original_message_type: 'booking_abandon_recovery', booking_intent_id: intent.id },
      });

      if (result && result.sent !== false && !result.blocked) {
        sent++;
        claimed = false;
        if (ten) sentPhones.add(ten);
        await markSiblingsSent(intent.phone, 'followup_sms_sent', intent.id);
      } else {
        logger.warn(`[booking-recovery] SMS blocked for intent ${intent.id}: ${result?.code || 'unknown'} ${result?.reason || ''}`);
        // Terminal block (opted out / landline) — keep the claim so we never
        // re-attempt a suppressed number. A retryable hold (quiet hours) leaves
        // the claim set → released in `finally` → retried next tick.
        if (result && result.retryable === false) claimed = false;
      }
    } catch (e) {
      logger.error(`[booking-recovery] SMS send failed for intent ${intent.id}: ${e.message}`);
    } finally {
      if (claimed) await releaseStage(intent.id, 'followup_sms_sent').catch(() => {});
    }
  }
  return sent;
}

// ── Email stage (touch 2) ──────────────────────────────────────────────────
async function runEmailStage(now, sentPhones) {
  const nowMs = now.getTime();
  const candidates = await db('booking_intents')
    .whereNull('converted_at')
    .where('suppressed', false)
    .where((q) => q.where('followup_email_sent', false).orWhereNull('followup_email_sent'))
    .where('last_activity_at', '<', new Date(nowMs - EMAIL_MIN_AGE_H * 3600000))
    .where('last_activity_at', '>', new Date(nowMs - EMAIL_MAX_AGE_H * 3600000))
    .whereNotNull('email')
    .orderBy('last_activity_at', 'desc')
    .select('*');

  if (!candidates.length) return 0;
  if (!isEnabled('bookingAbandonRecovery')) {
    logger.info(`[booking-recovery] email shadow: ${candidates.length} candidate(s), gate off — no sends`);
    return 0;
  }

  let sent = 0;
  for (const intent of candidates) {
    const emailKey = String(intent.email || '').trim().toLowerCase();
    if (emailKey && sentPhones.has(`email:${emailKey}`)) continue;
    let claimed = false;
    try {
      if (!(await claimStage(intent.id, 'followup_email_sent'))) continue;
      claimed = true;
      const result = await EmailTemplateLibrary.sendTemplate({
        templateKey: 'booking.abandonment_recovery',
        to: intent.email,
        payload: {
          first_name: firstNameOf(intent),
          service_type: serviceLabelOf(intent),
          booking_url: await bookingUrlFor(intent),
        },
        recipientType: intent.customer_id ? 'customer' : 'lead',
        recipientId: intent.customer_id || null,
        triggerEventId: `booking_recovery:${intent.id}`,
        idempotencyKey: `booking_recovery_email:${intent.id}`,
        categories: ['booking_recovery'],
      });
      if (result && result.blocked) {
        logger.warn(`[booking-recovery] email suppressed for intent ${intent.id}: ${result.reason || 'blocked'}`);
        // suppressed is terminal for this address — keep the claim (no retry).
        claimed = false;
      } else {
        sent++;
        claimed = false;
        if (emailKey) sentPhones.add(`email:${emailKey}`);
        await markSiblingsSent(intent.phone, 'followup_email_sent', intent.id);
      }
    } catch (e) {
      logger.error(`[booking-recovery] email send failed for intent ${intent.id}: ${e.message}`);
    } finally {
      if (claimed) await releaseStage(intent.id, 'followup_email_sent').catch(() => {});
    }
  }
  return sent;
}

async function checkAbandoned(now = new Date()) {
  const sentPhones = new Set();
  const sms = await runSmsStage(now, sentPhones);
  const email = await runEmailStage(now, sentPhones);
  return { sms, email, sent: sms + email };
}

module.exports = {
  checkAbandoned,
  _internals: { isQuietHours, hasRepliedRecently, claimStage, runSmsStage, runEmailStage, last10 },
};
