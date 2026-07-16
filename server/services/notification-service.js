const db = require('../models/db');
const logger = require('./logger');
const { isInternalTestCustomerId } = require('./internal-test-customers');

const CUSTOMER_PREFERENCE_KEYS = new Set([
  'appointment_confirmation',
  'service_reminder_72h',
  'service_reminder_24h',
  'tech_en_route',
  'tech_arrived',
  'service_completed',
  'billing_reminder',
  'payment_confirmation_sms',
]);

async function customerPreferenceEnabled(customerId, preferenceKey) {
  if (!preferenceKey) return true;
  if (!CUSTOMER_PREFERENCE_KEYS.has(preferenceKey)) {
    logger.error(`[notifications] Unknown customer preference key: ${preferenceKey}`);
    return false;
  }

  try {
    const prefs = await db('notification_prefs')
      .where({ customer_id: customerId })
      .first(preferenceKey);
    return !prefs || prefs[preferenceKey] !== false;
  } catch (err) {
    // Preference lookup uncertainty must not become an unwanted native push.
    logger.warn(`[notifications] Customer preference lookup failed (${preferenceKey}): ${err.message}`);
    return false;
  }
}

async function existingCustomerNotification(customerId, dedupeKey, connection = db) {
  if (!dedupeKey) return null;
  return connection('notifications')
    .where({ recipient_type: 'customer', recipient_id: customerId })
    .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey])
    .first();
}

const NotificationService = {
  // Create a notification
  async create({ recipientType, recipientId, category, title, body, icon, link, metadata, connection = db }) {
    try {
      // Demo/internal test accounts (App Store review account) must not ring
      // the admin bell — their bounce alerts and junk service requests are
      // noise. Central gate: emitters carry the customer id in metadata,
      // either top-level or nested under a trigger payload (sms_reply uses
      // threadId = customer id). Push dispatch for triggers is separately
      // gated in notification-triggers.js.
      const metaCid = metadata?.customerId || metadata?.customer_id
        || metadata?.payload?.customerId || metadata?.payload?.customer_id
        || metadata?.payload?.threadId;
      if (recipientType === 'admin' && isInternalTestCustomerId(metaCid)) {
        logger.info(`[notifications] Suppressed admin notification for internal test customer (${category})`);
        // TRUTHY sentinel, not null: callers treat null as "insert failed"
        // (requests.js logs an ops error; the estimate-extension route
        // releases its claim and 500s). Intentional suppression must read
        // as success-without-a-row.
        return { id: null, suppressed: true };
      }
      const [notif] = await connection('notifications').insert({
        recipient_type: recipientType,
        recipient_id: recipientId || null,
        category,
        title,
        body: body || null,
        icon: icon || getCategoryIcon(category),
        link: link || null,
        metadata: metadata ? JSON.stringify(metadata) : null,
      }).returning('*');
      return notif;
    } catch (err) {
      logger.error(`[notifications] Create failed: ${err.message}`);
      return null;
    }
  },

  // Create admin notification (no recipient_id needed)
  async notifyAdmin(category, title, body, opts = {}) {
    return this.create({ recipientType: 'admin', category, title, body, ...opts });
  },

  // Create customer notification
  async notifyCustomer(customerId, category, title, body, opts = {}) {
    const { preferenceKey, dedupeKey, ...createOpts } = opts;

    if (!(await customerPreferenceEnabled(customerId, preferenceKey))) {
      return { id: null, suppressed: true, reason: 'preference_disabled' };
    }

    const metadata = {
      ...(createOpts.metadata || {}),
      ...(dedupeKey ? { dedupeKey } : {}),
    };
    const createArgs = {
      recipientType: 'customer',
      recipientId: customerId,
      category,
      title,
      body,
      ...createOpts,
      metadata,
    };

    let notification;
    if (dedupeKey) {
      try {
        const persisted = await db.transaction(async (trx) => {
          // Serialize this customer's event key across pods. The lock lives
          // only for the transaction; the provider call happens after commit.
          await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`${customerId}:${dedupeKey}`]);
          const existing = await existingCustomerNotification(customerId, dedupeKey, trx);
          if (existing) return { notification: existing, deduped: true };
          return {
            notification: await this.create({ ...createArgs, connection: trx }),
            deduped: false,
          };
        });
        if (persisted.deduped) return { ...persisted.notification, deduped: true, push: null };
        notification = persisted.notification;
      } catch (err) {
        // A failed lock/read cannot safely prove this event is new. Fail closed
        // instead of risking a duplicate bell + native push.
        logger.warn(`[notifications] Customer notification dedupe failed: ${err.message}`);
        return null;
      }
    } else {
      notification = await this.create(createArgs);
    }
    if (!notification || notification.suppressed) return notification;

    try {
      const PushService = require('./push-notifications');
      const push = await PushService.sendToCustomer(customerId, {
        title,
        body: body || '',
        url: createOpts.link || '/',
        category,
        notificationId: String(notification.id),
        tag: dedupeKey || `customer-notification:${notification.id}`,
      });
      return { ...notification, push };
    } catch (err) {
      // The bell row is already durable. Push is best-effort and must never
      // turn a successful customer notification into an application failure.
      logger.warn(`[notifications] Customer push dispatch failed: ${err.message}`);
      return { ...notification, push: { failed: 1, error: 'dispatch_failed' } };
    }
  },

  // Get notifications for admin
  async getAdminNotifications(limit = 50, offset = 0) {
    return db('notifications')
      .where({ recipient_type: 'admin' })
      .orderBy('created_at', 'desc')
      .limit(limit).offset(offset);
  },

  // Get unread count for admin
  async getAdminUnreadCount() {
    const [{ count }] = await db('notifications')
      .where({ recipient_type: 'admin' })
      .whereNull('read_at')
      .count('* as count');
    return parseInt(count);
  },

  // Get notifications for a customer
  async getCustomerNotifications(customerId, limit = 50, offset = 0) {
    return db('notifications')
      .where({ recipient_type: 'customer', recipient_id: customerId })
      .orderBy('created_at', 'desc')
      .limit(limit).offset(offset);
  },

  // Get unread count for customer
  async getCustomerUnreadCount(customerId) {
    const [{ count }] = await db('notifications')
      .where({ recipient_type: 'customer', recipient_id: customerId })
      .whereNull('read_at')
      .count('* as count');
    return parseInt(count);
  },

  // Mark as read
  async markRead(notificationId, customerId = null) {
    let q = db('notifications').where({ id: notificationId });
    if (customerId) q = q.where({ recipient_type: 'customer', recipient_id: customerId });
    const updated = await q.update({ read_at: new Date() });
    return updated > 0;
  },

  // Mark all read for admin
  async markAllReadAdmin() {
    await db('notifications').where({ recipient_type: 'admin' }).whereNull('read_at').update({ read_at: new Date() });
  },

  // Mark all read for customer
  async markAllReadCustomer(customerId) {
    await db('notifications').where({ recipient_type: 'customer', recipient_id: customerId }).whereNull('read_at').update({ read_at: new Date() });
  },
};

function getCategoryIcon(category) {
  const icons = {
    inbound_sms: '\u{1F4AC}', approval: '\u2705', new_lead: '\u{1F514}', estimate: '\u{1F4CB}',
    payment: '\u{1F4B0}', review: '\u2B50', schedule: '\u{1F4C5}', churn_risk: '\u26A0\uFE0F',
    token_alert: '\u{1F511}', system: '\u{1F527}',
    knowledge: '\u{1F4DA}',
    service: '\u{1F3E0}', appointment: '\u{1F4C5}', billing: '\u{1F4B3}', document: '\u{1F4C4}',
    lawn_health: '\u{1F331}', referral: '\u{1F381}', account: '\u{1F464}',
  };
  return icons[category] || '\u{1F514}';
}

module.exports = NotificationService;
module.exports._private = {
  CUSTOMER_PREFERENCE_KEYS,
  customerPreferenceEnabled,
  existingCustomerNotification,
};
