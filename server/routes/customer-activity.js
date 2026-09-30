/**
 * Customer activity beacons (GATE_PORTAL_ACTIVITY) — authenticated, customer
 * session only, fire-and-forget from the portal SPA and the Capacitor app.
 *
 *   POST /api/customer/activity/page-view  { route, platform? }
 *   POST /api/customer/activity/push-open  { platform?, notificationId? }
 *   POST /api/customer/activity/heartbeat  {}
 *
 * While the gate is off both answer 200 { enabled: false } without writing;
 * the client reads that once and stops beaconing for the session (the gate
 * has no other client-visible flag). Both always answer 200 { ok: true }
 * when on, whether or not a row was written (bot / staff / deduped views are
 * silent), so a beacon reveals nothing about the recorder's filters. Row
 * conventions: see services/customer-activity.js. Sends nothing.
 *
 * These foreground beacons are the ONLY writers of customers.last_seen_at
 * (throttled in SQL, staff/bot skipped): the client sends them only while the
 * page is visible, so background polling on authenticated routes (bell count,
 * visit tracker) never makes an idle hidden portal look active. The heartbeat
 * exists so a long visible session on one tab keeps last_seen_at fresh: it
 * ONLY stamps last_seen_at and writes no customer_page_views row, so it can
 * never inflate tab-view counts (the page-view dedupe window is unaffected).
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
  activity.stampLastSeen(req, req.customerId);
  void activity.recordPortalView(req, { customerId: req.customerId, route: body.route, platform: body.platform });
  return res.json({ ok: true, enabled: true });
});

router.post('/heartbeat', (req, res) => {
  activity.stampLastSeen(req, req.customerId);
  return res.json({ ok: true, enabled: true });
});

// Records ONLY when notificationId names a bell notification owned by the
// signed-in customer; the stamp and the row both happen inside that check, so
// an unconfirmable open (no id, routed-SMS push, another profile's
// notification) writes nothing. The answer is identical either way.
router.post('/push-open', (req, res) => {
  const body = req.body || {};
  void activity.recordPushOpen(req, {
    customerId: req.customerId,
    platform: body.platform,
    notificationId: body.notificationId,
  });
  return res.json({ ok: true, enabled: true });
});

module.exports = router;
