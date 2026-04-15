const db = require('../models/db');
const logger = require('./logger');

let webpush;
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
      logger.info(`[push] VAPID configured (subject=${subject}, pubkey ${pubKey.length} chars)`);
    } catch (e) {
      logger.error(`[push] VAPID setup failed: ${e.message}`);
    }
  } else {
    logger.warn('[push] VAPID keys not set — push notifications disabled');
  }
} catch { webpush = null; }

class PushNotificationService {
  async sendToCustomer(customerId, notification) {
    if (!webpush) return;
    const subs = await db('push_subscriptions').where({ customer_id: customerId, active: true });
    for (const sub of subs) {
      try {
        await webpush.sendNotification(JSON.parse(sub.subscription_data), JSON.stringify(notification));
      } catch (err) {
        if (err.statusCode === 410) await db('push_subscriptions').where({ id: sub.id }).update({ active: false });
        else logger.error(`Push failed: ${err.message}`);
      }
    }
  }

  async sendToAdmins(notification) {
    if (!webpush) return;
    const subs = await db('push_subscriptions').whereIn('role', ['admin', 'technician']).where({ active: true });
    for (const sub of subs) {
      try { await webpush.sendNotification(JSON.parse(sub.subscription_data), JSON.stringify(notification)); }
      catch (err) { if (err.statusCode === 410) await db('push_subscriptions').where({ id: sub.id }).update({ active: false }); }
    }
  }
}

module.exports = new PushNotificationService();
