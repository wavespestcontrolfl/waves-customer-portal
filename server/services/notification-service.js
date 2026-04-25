const db = require('../models/db');
const logger = require('./logger');

const NotificationService = {
  // Create a notification
  async create({ recipientType, recipientId, category, title, body, icon, link, metadata }) {
    try {
      const [notif] = await db('notifications').insert({
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
    return this.create({ recipientType: 'customer', recipientId: customerId, category, title, body, ...opts });
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
  async markRead(notificationId) {
    await db('notifications').where({ id: notificationId }).update({ read_at: new Date() });
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
    service: '\u{1F3E0}', appointment: '\u{1F4C5}', billing: '\u{1F4B3}', document: '\u{1F4C4}',
    lawn_health: '\u{1F331}', referral: '\u{1F381}', account: '\u{1F464}',
  };
  return icons[category] || '\u{1F514}';
}

module.exports = NotificationService;
