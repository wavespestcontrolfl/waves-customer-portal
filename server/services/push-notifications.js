const db = require('../models/db');
const logger = require('./logger');

let webpush;
try {
  webpush = require('web-push');
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails('mailto:contact@wavespestcontrol.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
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
