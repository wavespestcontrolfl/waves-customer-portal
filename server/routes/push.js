/**
 * Customer-facing native push routes (iOS / APNs + Android / FCM).
 *
 *   POST /api/push/native-subscribe    — register an APNs (iOS) or FCM (Android) device token
 *   POST /api/push/native-unsubscribe  — deactivate a device token
 *
 * The browser/web-push subscribe path lives in admin-push.js + the
 * client lib/push-subscribe.js helper. This file is only for the native
 * Capacitor shell (client/src/native/nativePush.js posts here). It is scoped
 * to the customer session — the native apps we ship are the customer app.
 */
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

router.post('/native-subscribe', async (req, res, next) => {
  try {
    const { platform, token, deviceInfo } = req.body || {};
    if (platform !== 'ios' && platform !== 'android') return res.status(400).json({ error: 'unsupported platform' });
    if (!token || typeof token !== 'string') return res.status(400).json({ error: 'device token required' });

    // deviceInfo is optional client metadata — only trust it if it's a string,
    // else fall back to the user-agent. Guards against a non-string (e.g. a JSON
    // object) 500ing on .slice() before the token is saved.
    const safeDeviceInfo = (typeof deviceInfo === 'string' && deviceInfo) || req.headers['user-agent'] || (platform === 'android' ? 'Android' : 'iOS');

    const row = {
      customer_id: req.customerId,
      role: 'customer',
      platform,
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
        // Re-point platform + payload too, so a token previously stored under the
        // wrong platform (e.g. an old build that posted 'ios' on Android) self-heals
        // to the correct APNs/FCM routing on its next registration.
        platform: row.platform,
        subscription_data: row.subscription_data,
        device_info: row.device_info,
        active: true,
        // Heartbeat: registration re-fires on every app launch, so bumping
        // updated_at here makes it a "customer recently opened the app"
        // signal — push-channel-routing requires a FRESH heartbeat before a
        // push may replace an SMS (provider acceptance alone cannot prove
        // the OS will display the alert).
        updated_at: db.fn.now(),
      })
      .returning('id');

    res.json({ ok: true, id: saved?.id || saved });
  } catch (err) { next(err); }
});

router.post('/native-unsubscribe', async (req, res, next) => {
  try {
    const { token } = req.body || {};
    // Token-bearing releases are ACCOUNT-scoped: this device is presenting
    // its own token, and after a failed property re-point the row can sit
    // under a SIBLING profile of the same account — a release scoped to the
    // current profile would zero-row forever while the orphan row keeps
    // accepting invisible pushes. Never cross accounts. Token-less releases
    // (deactivate all of MY devices) stay scoped to the current profile —
    // account-wide would kill the household's other devices.
    let customerScope = [req.customerId];
    if (token) {
      const accountId = req.accountId || req.customer?.account_id || null;
      if (accountId) {
        const siblings = await db('customers')
          .where({ account_id: accountId })
          .select('id')
          .catch(() => []);
        if (siblings.length) customerScope = siblings.map((r) => r.id);
      }
    }
    const q = db('push_subscriptions').whereIn('customer_id', customerScope).whereIn('platform', ['ios', 'android']);
    if (token) q.andWhere({ device_token: token });
    // deactivated count matters to the client: zero rows means this token
    // is not held by any profile the session may release — keep local
    // memory so a later re-point can supersede the row.
    const deactivated = await q.update({ active: false });
    res.json({ ok: true, deactivated: Number(deactivated) || 0 });
  } catch (err) { next(err); }
});

module.exports = router;
