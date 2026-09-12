const { randomUUID } = require('node:crypto');
const db = require('../models/db');
const logger = require('./logger');
const apns = require('./apns');
const fcm = require('./fcm');
const { accountPropertyIds, resolvePrimaryProfileId, appPropertyScopeEnabled } = require('./account-properties');
const { gateEnvValue } = require('../config/feature-gates');
const { qualifyNotificationLink } = require('./notification-links');

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

async function sendSubscription(sub, notification, options) {
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
    return result.ok ? { sent: true } : { sent: false, failed: true, reason: result.reason,
      ...(result.retryable ? { retryable: true, retryAfterMs: result.retryAfterMs } : {}) };
  }

  // Android (Capacitor) subscriptions deliver via FCM, same routing shape as iOS.
  if (sub.platform === 'android') {
    const result = await fcm.send(sub.device_token, notification, { shouldContinue: options?.shouldContinue });
    if (result.skipped) return { sent: false, skipped: true, reason: result.reason };
    if (result.expired) {
      await db('push_subscriptions').where({ id: sub.id }).update({ active: false }).catch(() => {});
      return { sent: false, expired: true, reason: result.reason };
    }
    return result.ok ? { sent: true } : { sent: false, failed: true, reason: result.reason,
      ...(result.retryable ? { retryable: true, retryAfterMs: result.retryAfterMs } : {}) };
  }

  if (!webpush || !vapidConfigured) return { sent: false, skipped: true, reason: 'push_not_configured' };
  try {
    // timeout aborts the underlying request — a hung push endpoint fails
    // this leg promptly and cannot deliver later (see apns.js/fcm.js: the
    // same bound exists on every transport so no leg outlives its caller).
    await webpush.sendNotification(
      JSON.parse(sub.subscription_data),
      JSON.stringify(notification),
      { timeout: 8000, urgency: URGENCY_BY_PRIORITY[notification.priority] || 'normal', ...(notification.ephemeral ? { TTL: 0 } : {}) },
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
      try {
        const previous = await db('notifications').where({ id: opts.notificationId, recipient_type: 'customer', recipient_id: customerId }).first('metadata');
        if (previous?.metadata?.pushState === 'accepted') return { ...summarize([], 0), sent: 1, deduped: true };
      } catch {
        return { ...summarize([], 0), reason: 'push_in_flight' };
      }
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
    // Qualify the in-app destination under the app-notifications gate OR the
    // property scope (uncapped codex r1w P1): with the scope on and only the
    // legacy push routing delivering, a reminder for house B must still open
    // house B, not whichever house is selected. Off both: today's bare link.
    if (pushLinkQualificationEnabled() && String(notification.url || '').startsWith('/') && !notification.url.startsWith('//')) {
      // Saved-property destination (GATE_APP_PROPERTY_SCOPE): the app opens
      // the visit's HOUSE, not just the profile — from notification.propertyId
      // (a composer that knows it) or resolved here from the visit id every
      // appointment message already carries (see resolveNotificationPropertyId).
      const notifiedPropertyId = await resolveNotificationPropertyId(customerId, notification);
      notification = { ...notification, url: qualifyNotificationLink(notification.url, customerId, notifiedPropertyId) };
    }
    // This lookup is still preparation — no provider request has gone out
    // yet — so a DB failure here must resolve as a normal no-delivery
    // result, not an uncaught throw. A caller (push-channel-routing.js)
    // marks its outcome 'uncertain' the moment it calls in here, on the
    // premise that anything this function throws crossed the provider
    // boundary; letting this query's own exception escape would report a
    // never-attempted send as ambiguous instead of not_sent (codex P2).
    let subs;
    try {
      const query = db('push_subscriptions').whereIn('customer_id', context.ids).where({ active: true, role: 'customer' });
      if (opts.minUpdatedAt) query.where('updated_at', '>=', opts.minUpdatedAt);
      if (opts.nativeOnly) query.whereIn('platform', ['ios', 'android']);
      subs = await query;
    } catch (err) {
      logger.warn(`[push] Subscription lookup failed for ${customerId}: ${err.code || err.message}`);
      return { ...summarize([], 0), reason: 'subscription_lookup_failed' };
    }
    const attemptToken = randomUUID();
    if (opts.notificationId) {
      // Reuse this bell/event claim with a bounded lease. Its native collapse
      // tag stays unchanged on crash recovery. The lease covers every bounded
      // provider stage plus headroom, rather than expiring mid-fan-out.
      const leaseUntil = new Date(Date.now() + Math.max(120000, subs.length * 20000 + 30000)).toISOString();
      try {
        const claimed = await db('notifications').where({ id: opts.notificationId, recipient_type: 'customer', recipient_id: customerId })
          .whereRaw(`COALESCE(metadata->>'pushState', '') <> 'accepted' AND (
            COALESCE(metadata->>'pushState', '') <> 'sending' OR
            COALESCE(NULLIF(metadata->>'pushLeaseUntil', '')::timestamptz,
              NULLIF(metadata->>'pushAttemptedAt', '')::timestamptz + interval '10 minutes',
              '-infinity'::timestamptz) < now())`)
          .update({ metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ pushState: 'sending', pushAttemptToken: attemptToken, pushAttemptedAt: new Date().toISOString(), pushLeaseUntil: leaseUntil })]) });
        if (!claimed) {
          const current = await db('notifications').where({ id: opts.notificationId, recipient_type: 'customer', recipient_id: customerId }).first('metadata');
          const accepted = current?.metadata?.pushState === 'accepted';
          return { ...summarize([], 0), sent: Number(accepted), deduped: true, reason: accepted ? null : 'push_in_flight' };
        }
      } catch {
        return { ...summarize([], 0), reason: 'push_in_flight' };
      }
    }
    const results = [];
    let claimLost = false;
    for (const sub of subs) {
      let earliestValidUntil = null;
      const compositeShouldContinue = (typeof opts.shouldContinue === 'function' || opts.notificationId)
        ? async () => {
          if (typeof opts.shouldContinue === 'function') {
            let verdict;
            try { verdict = await opts.shouldContinue(); } catch { return false; }
            if (verdict !== true && verdict?.ok !== true) return false;
            if (verdict && typeof verdict === 'object'
              && Object.prototype.hasOwnProperty.call(verdict, 'validUntil')) {
              if (typeof verdict.validUntil !== 'number' || !Number.isFinite(verdict.validUntil)) return false;
              earliestValidUntil = earliestValidUntil == null
                ? verdict.validUntil : Math.min(earliestValidUntil, verdict.validUntil);
            }
          }
          if (opts.notificationId) {
            // The opaque caller check can wait while a newer worker reclaims
            // the lease. Verify ownership only after it returns; never hold a
            // notification row lock across caller code.
            const owned = await db('notifications').where({ id: opts.notificationId })
              .whereRaw("metadata->>'pushAttemptToken' = ? AND (metadata->>'pushLeaseUntil')::timestamptz > now()", [attemptToken])
              .first('id', 'metadata').catch(() => null);
            const ownedLeaseUntil = Date.parse(owned?.metadata?.pushLeaseUntil);
            if (!owned || !Number.isFinite(ownedLeaseUntil) || ownedLeaseUntil <= Date.now()) {
              claimLost = true;
              return false;
            }
          }
          if (earliestValidUntil != null && Date.now() >= earliestValidUntil) return false;
          if (typeof opts.shouldContinue?.isStillValid === 'function') {
            try { if (opts.shouldContinue.isStillValid() !== true) return false; } catch { return false; }
          }
          return true;
        }
        : undefined;
      if (compositeShouldContinue && !(await compositeShouldContinue())) {
        if (claimLost) break;
        results.push({ sent: false, skipped: true, reason: 'send_window_closed' });
        continue;
      }
      const result = await sendSubscription(sub, notification, { shouldContinue: compositeShouldContinue })
        .catch(() => ({ sent: false, failed: true, reason: 'provider_failure' }));
      results.push(result);
      if (claimLost) break;
      if (result.sent && opts.notificationId) {
        // Persist the first acceptance before walking another device, so a
        // later provider crash does not erase an already accepted event.
        await db('notifications').where({ id: opts.notificationId })
          .whereRaw("metadata->>'pushAttemptToken' = ?", [attemptToken])
          .update({ metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ pushState: 'accepted', pushAcceptedAt: new Date().toISOString() })]) })
          .catch((err) => logger.error(`[push] Acceptance persistence failed: ${err.code || 'db_error'}`));
      }
    }
    const stats = summarize(results, subs.length);
    if (opts.notificationId && !claimLost) {
      const accepted = stats.sent > 0;
      // A failed outcome write never discards KNOWN provider acceptance.
      await db('notifications').where({ id: opts.notificationId }).whereRaw("metadata->>'pushAttemptToken' = ?", [attemptToken]).update({
        metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({
          pushState: accepted ? 'accepted' : 'failed',
          pushAcceptedAt: accepted ? new Date().toISOString() : null,
        })]),
      }).catch((err) => logger.error(`[push] Outcome persistence failed: ${err.code || 'db_error'}`));
    }
    return claimLost && !stats.sent ? { ...stats, reason: 'push_in_flight' } : stats;
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

  // beforeDispatch runs after the subscription lookup and immediately before
  // the first provider handoff, so a caller's durable "push started" claim
  // is never burned by a lookup that failed or found nothing to send.
  async sendToAdminUsers(adminUserIds, notificationForUser, { beforeDispatch = null } = {}) {
    const ids = [...new Set((adminUserIds || []).filter(Boolean))];
    if (ids.length === 0) return summarize([], 0);
    const subs = await db('push_subscriptions as ps')
      .join('technicians as t', 'ps.admin_user_id', 't.id')
      .whereIn('ps.admin_user_id', ids)
      .where({ 'ps.active': true, 't.active': true })
      .whereRaw('ps.staff_token_version = t.auth_token_version')
      .whereIn('t.role', ['admin', 'technician'])
      .select('ps.*');
    if (subs.length && typeof beforeDispatch === 'function' && (await beforeDispatch()) === false) {
      return { ...summarize([], subs.length), superseded: true };
    }
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
  const retryable = results.filter((result) => result.retryable);
  return {
    subscriptions,
    sent: results.filter((r) => r.sent).length,
    expired: results.filter((r) => r.expired).length,
    failed: results.filter((r) => r.failed).length,
    skipped: results.filter((r) => r.skipped).length,
    ...(retryable.length ? { retryable: retryable.length,
      retryAfterMs: Math.max(60000, ...retryable.map((result) => Number(result.retryAfterMs) || 0)) } : {}),
    results,
  };
}

const service = new PushNotificationService();
service.PUSH_HEARTBEAT_HOURS = PUSH_HEARTBEAT_HOURS;
// Exposed for unit tests (platform routing); not part of the public API.
service._sendSubscription = sendSubscription;
// The saved property a push is ABOUT (uncapped codex r1s P1 — the producer
// half of the lane's push item, pulled forward from PR 3): a composer that
// knows the house passes notification.propertyId; one that only knows the
// visit (appointmentId = scheduled_services.id, which every appointment
// message carries through sendCustomerMessage → twilio → push routing) gets
// it resolved here, ONCE, instead of at thirty composer sites. An unstamped
// visit resolves to nothing — the profile-only link, which the app reads as
// the profile's PRIMARY: exactly the house an unstamped visit belongs to.
// Best-effort: a lookup failure sends the profile-only link, never blocks
// the push. The visit must belong to the recipient profile.
async function resolveNotificationPropertyId(customerId, notification) {
  // Gate off (or rolled back): the app's list is profile-shaped and cannot
  // honor a house — a hint would only make the tap read "unavailable"
  // (uncapped codex r1t P1). Profile-only link, today's behavior.
  if (!appPropertyScopeEnabled()) return null;
  if (notification?.propertyId) return String(notification.propertyId);
  if (!notification?.appointmentId) return null;
  try {
    const row = await db('scheduled_services')
      .where({ id: notification.appointmentId, customer_id: customerId })
      .first('property_id');
    return row && row.property_id ? String(row.property_id) : null;
  } catch (err) {
    logger.warn(`[push] property lookup for appointment ${notification.appointmentId} failed: ${err.message}`);
    return null;
  }
}
function pushLinkQualificationEnabled() {
  return gateEnvValue('GATE_CUSTOMER_APP_NOTIFICATIONS') || appPropertyScopeEnabled();
}
service.resolveNotificationPropertyId = resolveNotificationPropertyId;
service.pushLinkQualificationEnabled = pushLinkQualificationEnabled;
service._resolveNotificationPropertyId = resolveNotificationPropertyId;

module.exports = service;
