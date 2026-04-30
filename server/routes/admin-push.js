/**
 * Admin push notification routes.
 *
 *   GET    /api/admin/push/vapid-key             — public key for browser subscribe
 *   POST   /api/admin/push/subscribe              — register a browser subscription
 *   POST   /api/admin/push/unsubscribe            — remove a subscription
 *   GET    /api/admin/push/notifications          — bell list (paginated)
 *   GET    /api/admin/push/notifications/unread   — unread count for badge
 *   POST   /api/admin/push/notifications/:id/read — mark one read
 *   POST   /api/admin/push/notifications/read-all — mark all read
 *   GET    /api/admin/push/preferences            — load this user's prefs
 *   PUT    /api/admin/push/preferences            — bulk update prefs
 *   POST   /api/admin/push/test                    — fire a test notification to current user
 */
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { triggerNotification, listTriggers } = require('../services/notification-triggers');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');

// VAPID public key is public by design (browsers need it to subscribe).
// Keep this endpoint UNAUTHENTICATED so an expired admin token can't
// silently break "Enable push" with a 401 that looks like a missing key.
router.get('/vapid-key', (req, res) => {
  const key = (process.env.VAPID_PUBLIC_KEY || '').trim();
  res.json({
    publicKey: key || null,
    configured: !!key && !!(process.env.VAPID_PRIVATE_KEY || '').trim(),
  });
});

// Admin-only diagnostic — reveals whether the server sees the env vars,
// without leaking the private key. Hit this from the browser console
// when push fails to confirm what's actually loaded.
router.get('/diagnostics', adminAuthenticate, requireAdmin, (req, res) => {
  res.json({
    vapid_public_key_set: !!(process.env.VAPID_PUBLIC_KEY || '').trim(),
    vapid_public_key_length: (process.env.VAPID_PUBLIC_KEY || '').trim().length,
    vapid_private_key_set: !!(process.env.VAPID_PRIVATE_KEY || '').trim(),
    vapid_private_key_length: (process.env.VAPID_PRIVATE_KEY || '').trim().length,
    vapid_subject: (process.env.VAPID_SUBJECT || '').trim() || 'mailto:contact@wavespestcontrol.com (default)',
    web_push_loaded: (() => { try { require('web-push'); return true; } catch { return false; } })(),
    node_env: process.env.NODE_ENV || 'unset',
  });
});

// All write operations + preferences still require admin
router.use(adminAuthenticate, requireAdmin);

router.post('/subscribe', async (req, res, next) => {
  try {
    const { subscription, deviceInfo } = req.body;
    if (!subscription?.endpoint) return res.status(400).json({ error: 'subscription required' });

    const adminUserId = req.technicianId;
    const subData = JSON.stringify(subscription);

    const existing = await db('push_subscriptions')
      .where({ admin_user_id: adminUserId })
      .whereRaw("subscription_data::text = ?", [subData])
      .first()
      .catch(() => null);

    if (existing) {
      await db('push_subscriptions').where({ id: existing.id }).update({ active: true, device_info: deviceInfo || existing.device_info });
      return res.json({ ok: true, id: existing.id, reactivated: true });
    }

    const [row] = await db('push_subscriptions').insert({
      admin_user_id: adminUserId,
      role: 'admin',
      subscription_data: subData,
      device_info: deviceInfo || req.headers['user-agent']?.slice(0, 100) || null,
      active: true,
    }).returning('*');

    res.json({ ok: true, id: row.id });
  } catch (err) { next(err); }
});

router.post('/unsubscribe', async (req, res, next) => {
  try {
    const { endpoint } = req.body;
    const adminUserId = req.technicianId;
    if (!endpoint) {
      await db('push_subscriptions').where({ admin_user_id: adminUserId }).update({ active: false });
    } else {
      await db('push_subscriptions')
        .where({ admin_user_id: adminUserId })
        .whereRaw("subscription_data::text LIKE ?", [`%${endpoint}%`])
        .update({ active: false });
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Bell list/read endpoints live at /api/admin/notifications (admin-notifications.js).
// This file owns push subscriptions + per-trigger preferences + test fire only.

router.get('/preferences', async (req, res, next) => {
  try {
    const adminUserId = req.technicianId;
    const triggers = listTriggers();

    let rows = [];
    try {
      rows = await db('notification_preferences').where({ admin_user_id: adminUserId });
    } catch (e) { logger.warn(`[admin-push] prefs query failed: ${e.message}`); }

    const byKey = new Map(rows.map((r) => [r.trigger_key, r]));
    const merged = triggers.map((t) => {
      const r = byKey.get(t.key);
      return {
        ...t,
        push_enabled: r ? r.push_enabled !== false : true,
        bell_enabled: r ? r.bell_enabled !== false : true,
        sound_enabled: r ? r.sound_enabled !== false : true,
      };
    });
    res.json({ preferences: merged });
  } catch (err) { next(err); }
});

router.put('/preferences', async (req, res, next) => {
  try {
    const adminUserId = req.technicianId;
    const updates = Array.isArray(req.body.preferences) ? req.body.preferences : [];

    // INSERT ... ON CONFLICT replaces the previous select-then-insert
    // shape — two tabs saving the same trigger key simultaneously can't
    // race past each other now (the unique constraint on
    // (admin_user_id, trigger_key) is enforced atomically by Postgres).
    for (const u of updates) {
      if (!u.key) continue;
      await db('notification_preferences')
        .insert({
          admin_user_id: adminUserId,
          trigger_key: u.key,
          push_enabled: !!u.push_enabled,
          bell_enabled: !!u.bell_enabled,
          sound_enabled: !!u.sound_enabled,
        })
        .onConflict(['admin_user_id', 'trigger_key'])
        .merge({
          push_enabled: !!u.push_enabled,
          bell_enabled: !!u.bell_enabled,
          sound_enabled: !!u.sound_enabled,
          updated_at: new Date(),
        });
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/test', async (req, res, next) => {
  try {
    await triggerNotification('new_lead', {
      name: 'Test Lead',
      source: 'manual test',
      zip: '34292',
      leadId: null,
    });
    res.json({ ok: true, message: 'Test notification dispatched' });
  } catch (err) { next(err); }
});

module.exports = router;
