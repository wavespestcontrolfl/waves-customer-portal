const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate } = require('../middleware/admin-auth');
const NotificationService = require('../services/notification-service');
const { computeDashboardAlerts, toNotifications } = require('../services/dashboard-alerts');

router.use(adminAuthenticate);

// Window before a per-admin dismissal expires and the alert can re-show
// in the bell. 24h matches the "I see it, snooze for the day" intuition;
// the alert ALSO re-surfaces immediately if its count grows past what was
// dismissed (escalation overrides snooze).
const DISMISS_WINDOW_HOURS = 24;

// Compute live dashboard alerts and shape them as notification rows so
// the bell can render them alongside the persisted feed. Per-admin
// dismissals are subtracted out — alerts the operator already
// acknowledged stay hidden until either:
//   - the alert's count grows past dismissed_at_count (escalation), or
//   - DISMISS_WINDOW_HOURS elapse since dismissal (auto-expire).
//
// Returns { live, liveKeys } so callers can also dedupe persisted
// dashboard_alert rows that mirror the live overlay (cron writes a
// persisted bell row each time a new/escalated alert fires; the live
// overlay is the source of truth for the current count, so the matching
// persisted row at the same count is redundant).
//
// Logs and falls back to empty on any failure — flaky alert query must
// never break the bell.
async function liveAlertNotifications(adminUserId) {
  let alerts = [];
  try {
    const result = await computeDashboardAlerts();
    alerts = result.alerts || [];
  } catch (err) {
    logger.error(`[admin-notifications] computeDashboardAlerts failed: ${err.message}`);
    return { live: [], liveKeys: new Set() };
  }

  // liveKeys covers all currently-active alerts at their current count,
  // including dismissed ones — the cron's persisted row at the same
  // (alertId, count) is the same notification, regardless of whether the
  // overlay is currently visible to this admin.
  const liveKeys = new Set(alerts.map((a) => `${a.id}:${a.count}`));

  if (!adminUserId || alerts.length === 0) {
    return { live: toNotifications(alerts), liveKeys };
  }

  // Pull the most-recent dismissal per alert for this admin within the
  // active window. DISTINCT ON keeps one row per alert_id (the freshest).
  let dismissals = [];
  try {
    dismissals = await db.raw(
      `SELECT DISTINCT ON (alert_id) alert_id, dismissed_at_count, dismissed_at
       FROM dashboard_alert_dismissed
       WHERE admin_user_id = ?
         AND dismissed_at > NOW() - (INTERVAL '1 hour' * ?)
       ORDER BY alert_id, dismissed_at DESC`,
      [adminUserId, DISMISS_WINDOW_HOURS],
    ).then((r) => r.rows || []);
  } catch (err) {
    // Table may not exist yet on a freshly-deployed instance before
    // migration runs. Don't break the bell.
    logger.warn(`[admin-notifications] dismissals query failed: ${err.message}`);
  }

  const dismissedByAlert = new Map(
    dismissals.map((d) => [d.alert_id, parseInt(d.dismissed_at_count || 0, 10)]),
  );

  const visible = alerts.filter((a) => {
    const dismissedAtCount = dismissedByAlert.get(a.id);
    if (dismissedAtCount == null) return true; // never dismissed
    return a.count > dismissedAtCount; // escalation re-shows
  });

  return { live: toNotifications(visible), liveKeys };
}

// True if a persisted notification was written by the dashboard-alerts
// cron for the same (alertId, count) currently surfaced by the live
// overlay. Older counts (escalation history) return false and stay
// visible in the bell.
function isLiveDuplicate(persisted, liveKeys) {
  if (liveKeys.size === 0) return false;
  let meta = persisted.metadata;
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch { return false; }
  }
  if (!meta || meta.triggerKey !== 'dashboard_alert') return false;
  const payload = meta.payload || {};
  if (!payload.alertId || payload.alertCount == null) return false;
  return liveKeys.has(`${payload.alertId}:${payload.alertCount}`);
}

// GET /api/admin/notifications — list with pagination.
// Live dashboard alerts are merged in front of the persisted feed on
// page 1 only; subsequent pages serve persisted notifications without
// the live overlay so paging math stays simple. Persisted rows that
// duplicate the current live overlay (same alertId + count) are dropped
// — escalation history (older counts) stays.
router.get('/', async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = (page - 1) * limit;
    const persisted = await NotificationService.getAdminNotifications(limit, offset);
    const liveCtx = page === 1
      ? await liveAlertNotifications(req.technicianId)
      : { live: [], liveKeys: new Set() };
    const dedupedPersisted = persisted.filter((n) => !isLiveDuplicate(n, liveCtx.liveKeys));
    res.json({ notifications: [...liveCtx.live, ...dedupedPersisted], page, limit });
  } catch (err) { next(err); }
});

// GET /api/admin/notifications/unread-count — bell badge polling.
// Sums persisted unread + live alert count (after per-admin dismissals),
// minus persisted unread rows that duplicate the live overlay so the
// badge doesn't double-count.
router.get('/unread-count', async (req, res, next) => {
  try {
    const liveCtx = await liveAlertNotifications(req.technicianId);
    let persistedCount = await NotificationService.getAdminUnreadCount();
    if (liveCtx.liveKeys.size > 0) {
      try {
        const unreadDashboardAlerts = await db('notifications')
          .where({ recipient_type: 'admin', category: 'alert' })
          .whereNull('read_at');
        const dupes = unreadDashboardAlerts.filter((n) => isLiveDuplicate(n, liveCtx.liveKeys)).length;
        persistedCount = Math.max(0, persistedCount - dupes);
      } catch (err) {
        logger.warn(`[admin-notifications] unread dedup query failed: ${err.message}`);
      }
    }
    res.json({ count: persistedCount + liveCtx.live.length });
  } catch (err) { next(err); }
});

// Helper: snapshot the current live alerts and insert dismissal rows
// for every one of them (used by mark-all-read and mark-one-read on
// live: ids). dismissed_at_count is the alert's CURRENT count so an
// escalation re-surfaces it.
async function dismissLiveAlerts(adminUserId, alertIdFilter = null) {
  if (!adminUserId) return 0;
  let alerts;
  try {
    const result = await computeDashboardAlerts();
    alerts = result.alerts || [];
  } catch {
    return 0;
  }
  const targets = alertIdFilter ? alerts.filter((a) => a.id === alertIdFilter) : alerts;
  if (targets.length === 0) return 0;
  try {
    await db('dashboard_alert_dismissed').insert(
      targets.map((a) => ({
        admin_user_id: adminUserId,
        alert_id: a.id,
        dismissed_at_count: a.count,
      })),
    );
    return targets.length;
  } catch (err) {
    logger.warn(`[admin-notifications] dismiss insert failed: ${err.message}`);
    return 0;
  }
}

// PUT /api/admin/notifications/read-all — mark all as read.
// Marks persisted notifications read AND records per-admin dismissals
// for every currently-live alert so the bell badge actually drops to
// zero (was lingering because live alerts have no persisted read_at).
router.put('/read-all', async (req, res, next) => {
  try {
    await NotificationService.markAllReadAdmin();
    await dismissLiveAlerts(req.technicianId);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// PUT /api/admin/notifications/:id/read — mark one as read.
// Live alert IDs (prefixed `live:<alertId>`) record a per-admin
// dismissal at the alert's current count. The dismissal expires after
// DISMISS_WINDOW_HOURS or sooner if the count grows past
// dismissed_at_count (escalation re-shows the chip).
router.put('/:id/read', async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (id.startsWith('live:')) {
      const alertId = id.slice('live:'.length);
      const recorded = await dismissLiveAlerts(req.technicianId, alertId);
      return res.json({ success: true, live: true, dismissed: recorded > 0 });
    }
    await NotificationService.markRead(id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
