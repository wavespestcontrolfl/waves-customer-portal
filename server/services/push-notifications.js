const db = require('../models/db');
const logger = require('./logger');
const apns = require('./apns');
const fcm = require('./fcm');
const { accountPropertyIds, resolvePrimaryProfileId } = require('./account-properties');
const { gateEnvValue } = require('../config/feature-gates');

const PUSH_HEARTBEAT_HOURS = 72;

async function customerPushContext(customerId) {
  const customer = await db('customers').where({ id: customerId }).first('id', 'account_id', 'active', 'deleted_at');
  if (!customer || customer.active !== true || customer.deleted_at) return null;
  const req = { customerId, accountId: customer.account_id || customerId };
  const primaryId = await resolvePrimaryProfileId(req, db, { onError: 'throw' });
  // SELECT * keeps an older, pre-migration database readable. Absence of
  // push_enabled retains the existing device opt-in; a stored false stays
  // effective even when the preference UI gate is turned off.
  const prefs = await db('notification_prefs').where({ customer_id: primaryId }).first();
  const ids = gateEnvValue('GATE_CUSTOMER_APP_NOTIFICATIONS')
    ? await accountPropertyIds(req)
    : [customerId];
  return { enabled: prefs?.push_enabled !== false, ids };
}

let webpush;
let vapidConfigured = false;
let vapidSetupError = null;
try {
  webpush = require('web-push');
  // Trim env values — Railway sometimes preserves trailing whitespace/quotes
  // when values are pasted. Also normalize the VAPID subject (must be a clean
  // mailto: with no angle brackets or spaces, per RFC 8292).
  const pubKey = (process.env.VAPID_PUBLIC_KEY || '').trim();
  const privKey = (process.env.VAPID_PRIVATE_KEY || '').trim();
  let subject = (process.env.VAPID_SUBJECT || 'mailto:contact@wavespestcontrol.com').trim();
  // Strip "mailto: <email>" → "mailto:email" (web-push rejects malformed subjects)
  subject = subject.replace(/^mailto:\s*<?/, 'mailto:').replace(/>$/, '').replace(/\s+/g, '');
  if (pubKey && privKey) {
    try {
      webpush.setVapidDetails(subject, pubKey, privKey);
      vapidConfigured = true;
      logger.info(`[push] VAPID configured (subject=${subject}, pubkey ${pubKey.length} chars)`);
    } catch (e) {
      vapidSetupError = e.message;
      logger.error(`[push] VAPID setup failed: ${e.message}`);
    }
  } else {
    logger.warn('[push] VAPID keys not set — push notifications disabled');
  }
} catch (err) {
  webpush = null;
  vapidSetupError = err.message;
}

// Web Push Urgency header per trigger priority. Without it every push went
// out as the default "normal", which Apple (iOS delivers web push through
// APNs) is allowed to defer — device asleep or Low Power Mode held banners
// back minutes, which is how inbound-SMS alerts arrived late. "high" asks
// for immediate delivery; low-priority pushes stay deferrable on purpose.
const URGENCY_BY_PRIORITY = { urgent: 'high', high: 'high', normal: 'normal', low: 'low' };

async function sendSubscription(sub, notification) {
  // iOS (Capacitor) subscriptions deliver via APNs, not web-push. Routing here
  // keeps every caller (sendToCustomer / sendToAdmins / sendToAdminUsers)
  // platform-agnostic — they just iterate active rows.
  if (sub.platform === 'ios') {
    const result = await apns.send(sub.device_token, notification);
    if (result.skipped) return { sent: false, skipped: true, reason: result.reason };
    if (result.expired) {
      // Best-effort cleanup on every platform path: a failed deactivation
      // UPDATE must never reject the fan-out — that would discard an
      // earlier device's successful delivery and make push-channel-routing
      // send a duplicate SMS after a push the customer already received.
      await db('push_subscriptions').where({ id: sub.id }).update({ active: false }).catch(() => {});
      return { sent: false, expired: true, reason: result.reason };
    }
    return result.ok ? { sent: true } : { sent: false, failed: true, reason: result.reason };
  }

  // Android (Capacitor) subscriptions deliver via FCM, same routing shape as iOS.
  if (sub.platform === 'android') {
    const result = await fcm.send(sub.device_token, notification);
    if (result.skipped) return { sent: false, skipped: true, reason: result.reason };
    if (result.expired) {
      await db('push_subscriptions').where({ id: sub.id }).update({ active: false }).catch(() => {});
      return { sent: false, expired: true, reason: result.reason };
    }
    return result.ok ? { sent: true } : { sent: false, failed: true, reason: result.reason };
  }

  if (!webpush || !vapidConfigured) return { sent: false, skipped: true, reason: 'push_not_configured' };
  try {
    // timeout aborts the underlying request — a hung push endpoint fails
    // this leg promptly and cannot deliver later (see apns.js/fcm.js: the
    // same bound exists on every transport so no leg outlives its caller).
    await webpush.sendNotification(
      JSON.parse(sub.subscription_data),
      JSON.stringify(notification),
      { timeout: 8000, urgency: URGENCY_BY_PRIORITY[notification.priority] || 'normal' },
    );
    return { sent: true };
  } catch (err) {
    if (err.statusCode === 410 || err.statusCode === 404) {
      await db('push_subscriptions').where({ id: sub.id }).update({ active: false }).catch(() => {});
      return { sent: false, expired: true, statusCode: err.statusCode, reason: 'subscription_expired' };
    }
    logger.error(`Push failed: ${err.message}`);
    return { sent: false, failed: true, statusCode: err.statusCode || null, reason: err.message };
  }
}

class PushNotificationService {
  async customerStatus(customerId) {
    const context = await customerPushContext(customerId);
    if (!context) return { enabled: false, registered: false, fresh: false };
    const rows = await db('push_subscriptions')
      .whereIn('customer_id', context.ids).where({ active: true, role: 'customer' })
      .whereIn('platform', ['ios', 'android']).select('platform', 'updated_at');
    const cutoff = Date.now() - PUSH_HEARTBEAT_HOURS * 3600000;
    const providers = { ios: apns.status().configured, android: fcm.status().configured };
    return {
      enabled: context.enabled,
      registered: rows.length > 0,
      fresh: rows.some((row) => providers[row.platform] && new Date(row.updated_at).getTime() >= cutoff),
    };
  }

  status() {
    return {
      available: Boolean(webpush),
      configured: vapidConfigured,
      error: vapidSetupError,
      apns: apns.status(),
      fcm: fcm.status(),
    };
  }

  // opts.shouldContinue: optional async gate re-checked before EVERY
  // provider leg (push-channel-routing passes its send-window boundary
  // check) — a sequential fan-out that straddles a cutoff stops instead of
  // delivering the remaining legs past it. Callers without the option
  // (bell notifications, admin alerts) are unaffected.
  async sendToCustomer(customerId, notification, opts = {}) {
    if (opts.notificationId) {
      const previous = await db('notifications').where({ id: opts.notificationId, recipient_type: 'customer', recipient_id: customerId }).first('metadata');
      if (previous?.metadata?.pushState === 'accepted') return { ...summarize([], 0), sent: 1, deduped: true };
    }
    // opts.minUpdatedAt: only fan out to subscriptions with a heartbeat at or
    // after this instant (push_first freshness) — otherwise a stale
    // accepting-but-silent token could count as the delivery that suppresses
    // the SMS while the fresh device failed.
    let context;
    try { context = await customerPushContext(customerId); }
    catch (err) {
      logger.warn(`[push] Customer preference unavailable for ${customerId}: ${err.code || 'lookup_failed'}`);
      return { ...summarize([], 0), reason: 'preferences_unavailable' };
    }
    if (!context?.enabled) return { ...summarize([], 0), reason: 'push_disabled' };
    if (gateEnvValue('GATE_CUSTOMER_APP_NOTIFICATIONS') && String(notification.url || '').startsWith('/') && !notification.url.startsWith('//')) {
      const target = new URL(notification.url, 'https://portal.wavespestcontrol.com');
      target.searchParams.set('notificationProperty', String(customerId));
      notification = { ...notification, url: `${target.pathname}${target.search}${target.hash}` };
    }
    const query = db('push_subscriptions').whereIn('customer_id', context.ids).where({ active: true, role: 'customer' });
    if (opts.minUpdatedAt) query.where('updated_at', '>=', opts.minUpdatedAt);
    if (opts.nativeOnly) query.whereIn('platform', ['ios', 'android']);
    const subs = await query;
    if (opts.notificationId) {
      // The existing bell row is the event ledger. Claim BEFORE provider
      // handoff; an interrupted attempt remains uncertain, never accepted.
      const claimed = await db('notifications').where({ id: opts.notificationId, recipient_type: 'customer', recipient_id: customerId })
        .whereRaw("COALESCE(metadata->>'pushState', '') NOT IN ('sending', 'accepted')")
        .update({ metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ pushState: 'sending', pushAttemptedAt: new Date().toISOString() })]) });
      if (!claimed) {
        const current = await db('notifications').where({ id: opts.notificationId, recipient_type: 'customer', recipient_id: customerId }).first('metadata');
        const accepted = current?.metadata?.pushState === 'accepted';
        return { ...summarize([], 0), sent: Number(accepted), deduped: true, reason: accepted ? null : 'push_in_flight' };
      }
    }
    const results = [];
    for (const sub of subs) {
      if (typeof opts.shouldContinue === 'function') {
        let go = false;
        try { go = await opts.shouldContinue(); } catch { go = false; }
        if (!go) {
          results.push({ sent: false, skipped: true, reason: 'send_window_closed' });
          continue;
        }
      }
      results.push(await sendSubscription(sub, notification).catch(() => ({ sent: false, failed: true, reason: 'provider_failure' })));
    }
    const stats = summarize(results, subs.length);
    if (opts.notificationId) {
      const accepted = stats.sent > 0;
      // A failed outcome write never discards KNOWN provider acceptance.
      await db('notifications').where({ id: opts.notificationId }).update({
        metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({
          pushState: accepted ? 'accepted' : 'failed',
          pushAcceptedAt: accepted ? new Date().toISOString() : null,
        })]),
      }).catch((err) => logger.error(`[push] Outcome persistence failed: ${err.code || 'db_error'}`));
    }
    return stats;
  }

  async sendToAdmins(notification) {
    const subs = await db('push_subscriptions as ps')
      .join('technicians as t', 'ps.admin_user_id', 't.id')
      .where({ 'ps.active': true, 't.active': true })
      .whereRaw('ps.staff_token_version = t.auth_token_version')
      .whereIn('t.role', ['admin', 'technician'])
      .select('ps.*');
    const results = [];
    for (const sub of subs) {
      results.push(await sendSubscription(sub, notification));
    }
    return summarize(results, subs.length);
  }

  async sendToAdminUsers(adminUserIds, notificationForUser) {
    const ids = [...new Set((adminUserIds || []).filter(Boolean))];
    if (ids.length === 0) return summarize([], 0);
    const subs = await db('push_subscriptions as ps')
      .join('technicians as t', 'ps.admin_user_id', 't.id')
      .whereIn('ps.admin_user_id', ids)
      .where({ 'ps.active': true, 't.active': true })
      .whereRaw('ps.staff_token_version = t.auth_token_version')
      .whereIn('t.role', ['admin', 'technician'])
      .select('ps.*');
    const results = [];
    for (const sub of subs) {
      const notification = typeof notificationForUser === 'function'
        ? notificationForUser(sub.admin_user_id, sub)
        : notificationForUser;
      results.push(await sendSubscription(sub, notification));
    }
    return summarize(results, subs.length);
  }

  async sendToAdminUser(adminUserId, notification) {
    return this.sendToAdminUsers([adminUserId], notification);
  }

  async deactivateStaffUser(adminUserId, connection = db) {
    if (!adminUserId) return 0;
    return connection('push_subscriptions')
      .where({ admin_user_id: adminUserId, active: true })
      .update({ active: false });
  }
}

function summarize(results, subscriptions) {
  return {
    subscriptions,
    sent: results.filter((r) => r.sent).length,
    expired: results.filter((r) => r.expired).length,
    failed: results.filter((r) => r.failed).length,
    skipped: results.filter((r) => r.skipped).length,
    results,
  };
}

const service = new PushNotificationService();
service.PUSH_HEARTBEAT_HOURS = PUSH_HEARTBEAT_HOURS;
// Exposed for unit tests (platform routing); not part of the public API.
service._sendSubscription = sendSubscription;
module.exports = service;
