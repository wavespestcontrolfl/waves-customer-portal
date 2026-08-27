// Shared per-admin unread-count computation for the bell badge AND the
// push app-icon badge (notification-triggers). Extracted from
// routes/admin-notifications.js (codex #3541 P1): the two surfaces must
// never drift — a push that carries a count differing from what the bell
// shows on next open reads as a broken badge.
const db = require('../models/db');
const logger = require('./logger');
const NotificationService = require('./notification-service');
const { computeDashboardAlerts, toNotifications } = require('./dashboard-alerts');
const { COUNT_ESCALATION_COOLDOWN_MS } = require('./dashboard-alerts-cron');
const { isBellPolicyEnabled } = require('./notification-bell-policy');

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
    logger.error(`[admin-unread] computeDashboardAlerts failed: ${err.message}`);
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
      `SELECT DISTINCT ON (alert_id) alert_id, dismissed_at_count, dismissed_members, dismissed_at
       FROM dashboard_alert_dismissed
       WHERE admin_user_id = ?
         AND dismissed_at > NOW() - (INTERVAL '1 hour' * ?)
       ORDER BY alert_id, dismissed_at DESC`,
      [adminUserId, DISMISS_WINDOW_HOURS],
    ).then((r) => r.rows || []);
  } catch (err) {
    if (/dismissed_members/i.test(String(err.message))) {
      // Pre-migration tolerance, matching the insert retry in
      // dismissLiveAlerts: before 20260702000001 adds dismissed_members,
      // retry the legacy projection so count-based dismissals still hide
      // alerts — a write-side fallback alone would record rows this read
      // then fails to load, and the bell badge would bounce back anyway.
      try {
        dismissals = await db.raw(
          `SELECT DISTINCT ON (alert_id) alert_id, dismissed_at_count, dismissed_at
           FROM dashboard_alert_dismissed
           WHERE admin_user_id = ?
             AND dismissed_at > NOW() - (INTERVAL '1 hour' * ?)
           ORDER BY alert_id, dismissed_at DESC`,
          [adminUserId, DISMISS_WINDOW_HOURS],
        ).then((r) => r.rows || []);
      } catch (retryErr) {
        logger.warn(`[admin-unread] dismissals query failed (legacy retry): ${retryErr.message}`);
      }
    } else {
      // Table may not exist yet on a freshly-deployed instance before
      // migration runs. Don't break the bell.
      logger.warn(`[admin-unread] dismissals query failed: ${err.message}`);
    }
  }

  const dismissedByAlert = new Map(
    dismissals.map((d) => [d.alert_id, {
      count: parseInt(d.dismissed_at_count || 0, 10),
      at: d.dismissed_at ? new Date(d.dismissed_at).getTime() : 0,
      members: d.dismissed_members
        ? new Set(String(d.dismissed_members).split(',').filter(Boolean))
        : null,
    }]),
  );

  const visible = alerts.filter((a) => {
    const dismissed = dismissedByAlert.get(a.id);
    if (dismissed == null) return true; // never dismissed
    // Slow-creep advisory alerts share the cron's count-escalation cooldown:
    // after a dismissal, a bare +1 must not re-show them until the cooldown
    // elapses — otherwise the bell badge bounces back on every new
    // manual-billing customer / churn-score tick despite the cron holding
    // quiet. Membership-aware re-show below still applies (new WORK is not
    // slow creep).
    const cooldownMs = COUNT_ESCALATION_COOLDOWN_MS[a.id] || 0;
    const cooledDown = !dismissed.at || (Date.now() - dismissed.at) >= cooldownMs;
    if (a.count > dismissed.count && cooledDown) return true; // escalation re-shows
    // Membership-aware re-show for queue alerts: a member the dismissal did
    // NOT cover (a different lead crossing the SLA, a new expiring estimate)
    // is new work even at an unchanged or lower count — but a queue that
    // merely shrank to a subset of what was dismissed stays hidden. Needs
    // members on BOTH sides; aggregate alerts and pre-migration dismissal
    // rows keep the count-only behavior.
    if (Array.isArray(a.members) && a.members.length && dismissed.members) {
      return a.members.some((id) => !dismissed.members.has(String(id)));
    }
    return false;
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

// The one number "how many unread does this admin see": persisted
// role-scoped unread + live dashboard alerts (after this admin's
// dismissals) − persisted rows duplicating the live overlay. Bell policy
// on, or a non-admin role, excludes the live overlay entirely (owner-only
// finance alerts are hidden from scoped feeds, so their persisted rows
// must not be re-subtracted either).
async function getUnreadCountForAdmin({ adminUserId, role } = {}) {
  const liveCtx = isBellPolicyEnabled() || role !== 'admin'
    ? { live: [], liveKeys: new Set() }
    : await liveAlertNotifications(adminUserId);
  let persistedCount = await NotificationService.getAdminUnreadCount({ role });
  if (liveCtx.liveKeys.size > 0) {
    try {
      const unreadDashboardAlerts = await db('notifications')
        .where({ recipient_type: 'admin', category: 'alert' })
        .whereNull('read_at');
      const dupes = unreadDashboardAlerts.filter((n) => isLiveDuplicate(n, liveCtx.liveKeys)).length;
      persistedCount = Math.max(0, persistedCount - dupes);
    } catch (err) {
      logger.warn(`[admin-unread] unread dedup query failed: ${err.message}`);
    }
  }
  return persistedCount + liveCtx.live.length;
}

module.exports = { liveAlertNotifications, isLiveDuplicate, getUnreadCountForAdmin };
