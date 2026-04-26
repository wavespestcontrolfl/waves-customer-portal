const express = require('express');
const router = express.Router();
const { adminAuthenticate } = require('../middleware/admin-auth');
const NotificationService = require('../services/notification-service');
const { computeDashboardAlerts, toNotifications } = require('../services/dashboard-alerts');

router.use(adminAuthenticate);

// Compute live dashboard alerts and shape them as notification rows so
// the bell can render them alongside the persisted feed. Logs and falls
// back to an empty list — a flaky alert query must never break the bell.
async function liveAlertNotifications() {
  try {
    const { alerts } = await computeDashboardAlerts();
    return toNotifications(alerts);
  } catch (err) {
    // computeDashboardAlerts has its own per-alert try/catch; this only
    // catches truly unexpected failures (e.g. the module failing to
    // require). Don't surface to the bell — better to show stale
    // notifications than to render nothing.
    return [];
  }
}

// GET /api/admin/notifications — list with pagination.
// Live dashboard alerts are merged in front of the persisted feed on
// page 1 only; subsequent pages serve persisted notifications without
// the live overlay so paging math stays simple.
router.get('/', async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = (page - 1) * limit;
    const persisted = await NotificationService.getAdminNotifications(limit, offset);
    const live = page === 1 ? await liveAlertNotifications() : [];
    res.json({ notifications: [...live, ...persisted], page, limit });
  } catch (err) { next(err); }
});

// GET /api/admin/notifications/unread-count — bell badge polling.
// Sums persisted unread + live alert count. Live alerts have no
// read_at so they always count as unread until their condition clears.
router.get('/unread-count', async (req, res, next) => {
  try {
    const persistedCount = await NotificationService.getAdminUnreadCount();
    const live = await liveAlertNotifications();
    res.json({ count: persistedCount + live.length });
  } catch (err) { next(err); }
});

// PUT /api/admin/notifications/read-all — mark all as read.
// Only affects persisted notifications. Live alerts can't be "read";
// they disappear when their underlying condition clears.
router.put('/read-all', async (req, res, next) => {
  try {
    await NotificationService.markAllReadAdmin();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// PUT /api/admin/notifications/:id/read — mark one as read.
// Live alert IDs (prefixed `live:`) are no-ops — return 200 anyway so
// the renderer's optimistic-mark-read flow doesn't error on click.
router.put('/:id/read', async (req, res, next) => {
  try {
    if (String(req.params.id).startsWith('live:')) {
      return res.json({ success: true, live: true });
    }
    await NotificationService.markRead(req.params.id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
