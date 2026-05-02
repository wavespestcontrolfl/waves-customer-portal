const db = require('../models/db');
const logger = require('./logger');

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

async function sendSubscription(sub, notification) {
  if (!webpush || !vapidConfigured) return { sent: false, skipped: true, reason: 'push_not_configured' };
  try {
    await webpush.sendNotification(JSON.parse(sub.subscription_data), JSON.stringify(notification));
    return { sent: true };
  } catch (err) {
    if (err.statusCode === 410 || err.statusCode === 404) {
      await db('push_subscriptions').where({ id: sub.id }).update({ active: false });
      return { sent: false, expired: true, statusCode: err.statusCode, reason: 'subscription_expired' };
    }
    logger.error(`Push failed: ${err.message}`);
    return { sent: false, failed: true, statusCode: err.statusCode || null, reason: err.message };
  }
}

class PushNotificationService {
  status() {
    return {
      available: Boolean(webpush),
      configured: vapidConfigured,
      error: vapidSetupError,
    };
  }

  async sendToCustomer(customerId, notification) {
    const subs = await db('push_subscriptions').where({ customer_id: customerId, active: true });
    const results = [];
    for (const sub of subs) {
      results.push(await sendSubscription(sub, notification));
    }
    return summarize(results, subs.length);
  }

  async sendToAdmins(notification) {
    const subs = await db('push_subscriptions').whereIn('role', ['admin', 'technician']).where({ active: true });
    const results = [];
    for (const sub of subs) {
      results.push(await sendSubscription(sub, notification));
    }
    return summarize(results, subs.length);
  }

  async sendToAdminUsers(adminUserIds, notificationForUser) {
    const ids = [...new Set((adminUserIds || []).filter(Boolean))];
    if (ids.length === 0) return summarize([], 0);
    const subs = await db('push_subscriptions')
      .whereIn('admin_user_id', ids)
      .where({ active: true });
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

module.exports = new PushNotificationService();
