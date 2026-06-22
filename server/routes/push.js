/**
 * Customer-facing native push routes (iOS / APNs).
 *
 *   POST /api/push/native-subscribe    — register an APNs device token
 *   POST /api/push/native-unsubscribe  — deactivate a device token
 *
 * The browser/web-push subscribe path lives in admin-push.js + the
 * client lib/push-subscribe.js helper. This file is only for the native
 * Capacitor shell (client/src/native/nativePush.js posts here). It is scoped
 * to the customer session — the iOS app we ship is the customer app.
 */
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

router.post('/native-subscribe', async (req, res, next) => {
  try {
    const { platform, token, deviceInfo } = req.body || {};
    if (platform !== 'ios') return res.status(400).json({ error: 'unsupported platform' });
    if (!token || typeof token !== 'string') return res.status(400).json({ error: 'device token required' });

    // deviceInfo is optional client metadata — only trust it if it's a string,
    // else fall back to the user-agent. Guards against a non-string (e.g. a JSON
    // object) 500ing on .slice() before the token is saved.
    const safeDeviceInfo = (typeof deviceInfo === 'string' && deviceInfo) || req.headers['user-agent'] || 'iOS';

    const row = {
      customer_id: req.customerId,
      role: 'customer',
      platform: 'ios',
      device_token: token,
      // subscription_data is NOT NULL on the table; store the token as JSON so
      // the constraint holds without a schema change for the web column.
      subscription_data: JSON.stringify({ token }),
      device_info: safeDeviceInfo.slice(0, 100),
      active: true,
    };

    // Upsert by device_token so re-launch re-registration (or a device changing
    // hands) is idempotent and re-points the token at the current customer.
    const [saved] = await db('push_subscriptions')
      .insert(row)
      .onConflict('device_token')
      .merge({
        customer_id: row.customer_id,
        role: row.role,
        device_info: row.device_info,
        active: true,
      })
      .returning('id');

    res.json({ ok: true, id: saved?.id || saved });
  } catch (err) { next(err); }
});

router.post('/native-unsubscribe', async (req, res, next) => {
  try {
    const { token } = req.body || {};
    const q = db('push_subscriptions').where({ customer_id: req.customerId, platform: 'ios' });
    if (token) q.andWhere({ device_token: token });
    await q.update({ active: false });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
