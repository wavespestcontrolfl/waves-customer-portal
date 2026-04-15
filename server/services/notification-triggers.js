/**
 * Notification Triggers — central dispatcher for admin-side notification events.
 *
 * Existing routes/services call `triggerNotification(triggerKey, payload)` when
 * something happens. This module:
 *   1. Loads each admin user's per-trigger preferences
 *   2. Persists a bell entry via NotificationService (if bell_enabled)
 *   3. Pushes a Web Push notification via PushNotificationService (if push_enabled)
 *
 * Adding a new trigger:
 *   1. Add to TRIGGER_REGISTRY below (key, label, category, priority, build())
 *   2. Add to the seed list in the notification_preferences migration
 *   3. Call `triggerNotification('your_key', { ... })` from the route that fires it
 */
const db = require('../models/db');
const logger = require('./logger');
const NotificationService = require('./notification-service');
const PushService = require('./push-notifications');

// priority: 'urgent' (red, double vibrate), 'high' (amber), 'normal' (teal), 'low' (gray)
const TRIGGER_REGISTRY = {
  new_lead: {
    label: 'New lead submitted',
    category: 'new_lead',
    priority: 'high',
    group: 'Leads & Sales',
    build: (p) => ({
      title: 'New lead',
      body: `${p.name || 'A prospect'}${p.source ? ' via ' + p.source : ''}${p.zip ? ' (' + p.zip + ')' : ''}`,
      link: p.leadId ? `/admin/leads/${p.leadId}` : '/admin/leads',
    }),
  },
  sms_reply: {
    label: 'SMS reply received',
    category: 'inbound_sms',
    priority: 'high',
    group: 'Communication',
    build: (p) => ({
      title: `SMS from ${p.fromName || p.fromPhone || 'unknown'}`,
      body: (p.message || '').slice(0, 140),
      link: p.threadId ? `/admin/communications?thread=${p.threadId}` : '/admin/communications',
    }),
  },
  payment_succeeded: {
    label: 'Payment received',
    category: 'payment',
    priority: 'low',
    group: 'Payments',
    build: (p) => ({
      title: 'Payment received',
      body: `$${Number(p.amount || 0).toFixed(2)} from ${p.customerName || 'customer'}`,
      link: p.invoiceId ? `/admin/invoices/${p.invoiceId}` : '/admin/revenue',
    }),
  },
  payment_failed: {
    label: 'Payment failed',
    category: 'payment',
    priority: 'urgent',
    group: 'Payments',
    build: (p) => ({
      title: 'Payment failed',
      body: `$${Number(p.amount || 0).toFixed(2)} — ${p.customerName || 'customer'}${p.reason ? ' — ' + p.reason : ''}`,
      link: p.invoiceId ? `/admin/invoices/${p.invoiceId}` : '/admin/revenue',
    }),
  },
  appointment_cancelled: {
    label: 'Appointment cancelled',
    category: 'schedule',
    priority: 'high',
    group: 'Field Operations',
    build: (p) => ({
      title: 'Appointment cancelled',
      body: `${p.customerName || 'Customer'} — ${p.scheduledDate || ''}${p.cancelledBy ? ' (by ' + p.cancelledBy + ')' : ''}`,
      link: '/admin/schedule',
    }),
  },
  review_received: {
    label: 'New review (4–5 star)',
    category: 'review',
    priority: 'normal',
    group: 'Reviews',
    build: (p) => ({
      title: `New ${p.stars || 5}-star review`,
      body: `${p.author || 'Anonymous'}: ${(p.text || '').slice(0, 120)}`,
      link: '/admin/reviews',
    }),
  },
  low_review: {
    label: 'Low review (1–3 star)',
    category: 'review',
    priority: 'urgent',
    group: 'Reviews',
    build: (p) => ({
      title: `${p.stars || 1}-star review — needs response`,
      body: `${p.author || 'Anonymous'}: ${(p.text || '').slice(0, 120)}`,
      link: '/admin/reviews',
    }),
  },
  job_complete: {
    label: 'Tech marked job complete',
    category: 'service',
    priority: 'low',
    group: 'Field Operations',
    build: (p) => ({
      title: 'Job complete',
      body: `${p.techName || 'Tech'} finished ${p.serviceName || 'service'} at ${p.customerName || 'customer'}`,
      link: p.serviceId ? `/admin/schedule?service=${p.serviceId}` : '/admin/schedule',
    }),
  },
  low_inventory: {
    label: 'Low inventory alert',
    category: 'system',
    priority: 'high',
    group: 'Inventory',
    build: (p) => ({
      title: 'Low inventory',
      body: `${p.productName || 'Product'} — ${p.remaining || 0} ${p.unit || 'left'}`,
      link: '/admin/inventory',
    }),
  },
  churn_risk: {
    label: 'Customer churn risk detected',
    category: 'churn_risk',
    priority: 'high',
    group: 'Customer Success',
    build: (p) => ({
      title: 'Churn risk detected',
      body: `${p.customerName || 'Customer'} — ${p.reason || 'risk score elevated'}`,
      link: p.customerId ? `/admin/customers/${p.customerId}` : '/admin/health',
    }),
  },
};

const PRIORITY_VIBRATE = {
  urgent: [200, 100, 200, 100, 400],
  high:   [200, 100, 200],
  normal: [150],
  low:    [100],
};

/**
 * Fire a notification event. Non-blocking — never throws.
 *
 * @param {string} triggerKey — must match a key in TRIGGER_REGISTRY
 * @param {object} payload — trigger-specific data, see each build() for shape
 */
async function triggerNotification(triggerKey, payload = {}) {
  try {
    const trigger = TRIGGER_REGISTRY[triggerKey];
    if (!trigger) {
      logger.warn(`[notification-triggers] Unknown trigger: ${triggerKey}`);
      return;
    }

    const built = trigger.build(payload);

    // Load per-user preferences (default to enabled if no row exists)
    let prefs = [];
    try {
      prefs = await db('notification_preferences')
        .where({ trigger_key: triggerKey });
    } catch (e) {
      logger.warn(`[notification-triggers] preferences table missing or query failed: ${e.message}`);
    }

    let activeAdmins = [];
    try {
      activeAdmins = await db('technicians').where({ active: true }).select('id');
    } catch (e) {
      logger.warn(`[notification-triggers] technicians query failed: ${e.message}`);
    }

    const prefsByUser = new Map(prefs.map((p) => [p.admin_user_id, p]));
    let bellWritten = false;

    for (const user of activeAdmins) {
      const userPref = prefsByUser.get(user.id) || { bell_enabled: true, push_enabled: true, sound_enabled: true };

      if (userPref.bell_enabled && !bellWritten) {
        // Write a single bell entry for "admin" recipients (existing model is shared)
        try {
          await NotificationService.notifyAdmin(
            trigger.category,
            built.title,
            built.body,
            { link: built.link, metadata: { triggerKey, priority: trigger.priority, payload } }
          );
          bellWritten = true;
        } catch (e) {
          logger.error(`[notification-triggers] bell write failed: ${e.message}`);
        }
      }
    }

    // Push: send to all admin/technician subscriptions whose user has push enabled.
    // (Push service queries push_subscriptions itself; we filter by checking prefs.)
    try {
      const enabledUserIds = activeAdmins
        .filter((u) => {
          const pref = prefsByUser.get(u.id);
          return !pref || pref.push_enabled !== false;
        })
        .map((u) => u.id);

      if (enabledUserIds.length > 0) {
        const subs = await db('push_subscriptions')
          .whereIn('admin_user_id', enabledUserIds)
          .where({ active: true });

        const wantsSoundByUser = new Map(
          activeAdmins.map((u) => {
            const pref = prefsByUser.get(u.id);
            return [u.id, !pref || pref.sound_enabled !== false];
          })
        );

        const webpush = safeRequire('web-push');
        if (webpush && process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
          for (const sub of subs) {
            const wantsSound = wantsSoundByUser.get(sub.admin_user_id);
            const notif = {
              title: built.title,
              body: built.body,
              url: built.link || '/admin',
              tag: `waves-${triggerKey}`,
              priority: trigger.priority,
              vibrate: wantsSound ? PRIORITY_VIBRATE[trigger.priority] : [0],
              silent: !wantsSound,
            };
            try {
              await webpush.sendNotification(JSON.parse(sub.subscription_data), JSON.stringify(notif));
            } catch (err) {
              if (err.statusCode === 410 || err.statusCode === 404) {
                await db('push_subscriptions').where({ id: sub.id }).update({ active: false });
              } else {
                logger.error(`[notification-triggers] push send failed: ${err.message}`);
              }
            }
          }
        }
      }
    } catch (e) {
      logger.error(`[notification-triggers] push dispatch failed: ${e.message}`);
    }
  } catch (err) {
    logger.error(`[notification-triggers] dispatch failed for ${triggerKey}: ${err.message}`);
  }
}

function safeRequire(mod) {
  try { return require(mod); } catch { return null; }
}

function listTriggers() {
  return Object.entries(TRIGGER_REGISTRY).map(([key, t]) => ({
    key, label: t.label, group: t.group, priority: t.priority,
  }));
}

module.exports = { triggerNotification, listTriggers, TRIGGER_REGISTRY };
