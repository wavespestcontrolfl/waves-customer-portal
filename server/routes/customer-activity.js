/**
 * Customer activity beacons (GATE_PORTAL_ACTIVITY) — authenticated, customer
 * session only, fire-and-forget from the portal SPA and the Capacitor app.
 *
 *   POST /api/customer/activity/page-view  { route, platform? }
 *   POST /api/customer/activity/push-open  { platform?, notificationId?, tag?, category? }
 *
 * While the gate is off both answer 200 { enabled: false } without writing;
 * the client reads that once and stops beaconing for the session (the gate
 * has no other client-visible flag). Both always answer 200 { ok: true }
 * when on, whether or not a row was written (bot / staff / deduped views are
 * silent), so a beacon reveals nothing about the recorder's filters. Row
 * conventions: see services/customer-activity.js. Sends nothing.
 */
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { portalActivityLive } = require('../config/feature-gates');
const activity = require('../services/customer-activity');

router.use(authenticate);
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!portalActivityLive()) return res.json({ ok: true, enabled: false });
  return next();
});

router.post('/page-view', (req, res) => {
  const body = req.body || {};
  if (!activity.sanitizeRouteName(body.route)) return res.status(400).json({ error: 'invalid route' });
  void activity.recordPortalView(req, { customerId: req.customerId, route: body.route, platform: body.platform });
  return res.json({ ok: true, enabled: true });
});

router.post('/push-open', (req, res) => {
  const body = req.body || {};
  void activity.recordPushOpen(req, {
    customerId: req.customerId,
    platform: body.platform,
    notificationId: body.notificationId,
    tag: body.tag,
    category: body.category,
  });
  return res.json({ ok: true, enabled: true });
});

module.exports = router;
