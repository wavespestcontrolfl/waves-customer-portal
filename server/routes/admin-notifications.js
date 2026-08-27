const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const NotificationService = require('../services/notification-service');
const PushService = require('../services/push-notifications');
const { computeDashboardAlerts } = require('../services/dashboard-alerts');
const { isBellPolicyEnabled } = require('../services/notification-bell-policy');
// Live-overlay math (per-admin dismissals, cron-row dedup, the combined
// unread count) lives in services/admin-unread.js — shared with the push
// app-icon badge in notification-triggers so the two counts can't drift.
const { liveAlertNotifications, isLiveDuplicate, getUnreadCountForAdmin, badgeOrderingStamp } = require('../services/admin-unread');

router.use(adminAuthenticate);

function parseMetadata(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return {}; }
  }
  return typeof value === 'object' ? value : {};
}

function notificationIssueLimit(value) {
  return Math.min(Math.max(parseInt(value, 10) || 50, 1), 200);
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
    const persisted = await NotificationService.getAdminNotifications(limit, offset, { role: req.techRole });
    // Bell policy on: computed dashboard aggregates stay on the dashboard
    // banner (/admin/dashboard/alerts) but no longer merge into the bell.
    // Live overlay is ADMIN-ONLY regardless of policy: dashboard alerts
    // carry finance totals and owner-only links, matching the fail-closed
    // persisted-feed scope (codex P1).
    const liveCtx = page === 1 && !isBellPolicyEnabled() && req.techRole === 'admin'
      ? await liveAlertNotifications(req.technicianId)
      : { live: [], liveKeys: new Set() };
    const dedupedPersisted = persisted.filter((n) => !isLiveDuplicate(n, liveCtx.liveKeys));
    res.json({ notifications: [...liveCtx.live, ...dedupedPersisted], page, limit });
  } catch (err) { next(err); }
});

// GET /api/admin/notifications/issues — recent internal/admin delivery issues.
router.get('/issues', requireAdmin, async (req, res, next) => {
  try {
    const limit = notificationIssueLimit(req.query.limit);
    if (db.schema?.hasTable && !(await db.schema.hasTable('audit_log'))) {
      return res.json({ issues: [] });
    }

    const rows = await db('audit_log')
      .where({ action: 'notification.internal_admin_alert.delivery_issue' })
      .orderBy('created_at', 'desc')
      .limit(limit)
      .select('id', 'metadata', 'created_at');

    const issues = rows.map((row) => {
      const metadata = parseMetadata(row.metadata);
      return {
        id: row.id,
        created_at: row.created_at,
        outcome: metadata.outcome || null,
        message_type: metadata.message_type || null,
        to_masked: metadata.to_masked || null,
        body_length: metadata.body_length ?? null,
        title: metadata.title || null,
        link: metadata.link || null,
        reason: metadata.reason || null,
        stats: metadata.stats || null,
      };
    });

    res.json({ issues });
  } catch (err) { next(err); }
});

// GET /api/admin/notifications/unread-count — bell badge polling.
// Sums persisted unread + live alert count (after per-admin dismissals),
// minus persisted unread rows that duplicate the live overlay so the
// badge doesn't double-count.
router.get('/unread-count', async (req, res, next) => {
  try {
    // `at` is the badge-ordering stamp: read from the DB clock inside the
    // same per-admin serialized section that computed the count
    // (admin-unread.js), so every ordering token — this, the read routes',
    // the push payload's badgeAt — shares one clock and one total order.
    const { count, at } = await getUnreadCountForAdmin({ adminUserId: req.technicianId, role: req.techRole });
    res.json({ count, at });
  } catch (err) { next(err); }
});

// Helper: snapshot the current live alerts and insert dismissal rows
// for every one of them (used by mark-all-read and mark-one-read on
// live: ids). dismissed_at_count is the alert's CURRENT count so an
// escalation re-surfaces it.
//
// Also marks the persisted `dashboard_alert` notification rows for those
// alert ids as read. The persisted row was written by the cron when the
// alert first fired; it lives in `notifications` keyed on metadata, not
// on a per-admin column. Without this update the live overlay clears
// (alert is no longer present in `liveKeys`) but the orphan persisted
// row stays unread, leaving the bell badge stuck at 1+.
async function dismissLiveAlerts(adminUserId, alertIdFilter = null) {
  if (!adminUserId) return 0;
  let alerts;
  try {
    // fresh: dismissals persist dismissed_at_count, so they must record the
    // CURRENT count — the read-path memo could be up to 30s stale.
    const result = await computeDashboardAlerts({ fresh: true });
    alerts = result.alerts || [];
  } catch {
    return 0;
  }
  const targets = alertIdFilter ? alerts.filter((a) => a.id === alertIdFilter) : alerts;
  if (targets.length === 0) return 0;
  const dismissalRows = targets.map((a) => ({
    admin_user_id: adminUserId,
    alert_id: a.id,
    dismissed_at_count: a.count,
    // Queue alerts carry their member ids — record them so the bell can
    // re-show when a NEW member enters, not just on count growth.
    dismissed_members: Array.isArray(a.members) && a.members.length
      ? a.members.join(',')
      : null,
  }));
  try {
    await db('dashboard_alert_dismissed').insert(dismissalRows);
  } catch (err) {
    // Pre-migration tolerance (mirrors the read path above): before
    // 20260702000001 adds dismissed_members, Postgres rejects the column —
    // retry the legacy shape so dismissals keep working (count-only
    // semantics, the documented fallback) instead of the bell badge
    // bouncing straight back until the migration lands.
    if (/dismissed_members/i.test(String(err.message))) {
      try {
        await db('dashboard_alert_dismissed').insert(
          dismissalRows.map(({ dismissed_members, ...legacy }) => legacy),
        );
      } catch (retryErr) {
        logger.warn(`[admin-notifications] dismiss insert failed (legacy retry): ${retryErr.message}`);
        return 0;
      }
    } else {
      logger.warn(`[admin-notifications] dismiss insert failed: ${err.message}`);
      return 0;
    }
  }
  // Best-effort: mark the corresponding persisted bell rows read so the
  // unread-count doesn't double-count after the live alert clears. Read
  // state on `notifications` is admin-shared today (see markRead in
  // notification-service), so this matches the existing semantics.
  // Loop instead of ANY() because targets is typically 1-3 alerts and
  // the query reads cleaner without driver-specific array casting.
  for (const a of targets) {
    try {
      await db('notifications')
        .where({ recipient_type: 'admin', category: 'alert' })
        .whereNull('read_at')
        .whereRaw("metadata->>'triggerKey' = ?", ['dashboard_alert'])
        .whereRaw("metadata->'payload'->>'alertId' = ?", [a.id])
        .update({ read_at: new Date() });
    } catch (err) {
      logger.warn(`[admin-notifications] persisted alert read update failed for ${a.id}: ${err.message}`);
    }
  }
  return targets.length;
}

// PUT /api/admin/notifications/read-all — mark all as read.
// Marks persisted notifications read AND records per-admin dismissals
// for every currently-live alert so the bell badge actually drops to
// zero (was lingering because live alerts have no persisted read_at).
router.put('/read-all', async (req, res, next) => {
  try {
    await NotificationService.markAllReadAdmin({ role: req.techRole });
    // Live-alert dismissal is admin-only: the overlay never renders for
    // other roles, and its helper also marks persisted dashboard_alert
    // rows read — rows the fail-closed feed hides from them (codex P1).
    if (req.techRole === 'admin') await dismissLiveAlerts(req.technicianId);
    // Serialized DB-clock badge-ordering stamp — see /unread-count.
    res.json({ success: true, at: await badgeOrderingStamp(req.technicianId) });
  } catch (err) { next(err); }
});

// GET /api/admin/notifications/diagnose — one-shot delivery health check.
// Returns each checkpoint in the trigger pipeline so we can pinpoint why
// a given user is missing notifications without digging through six
// separate queries by hand.
//
// Defaults to the calling admin. Pass `?userId=<n>` to diagnose a
// teammate (admin role required) — necessary because the technicians.active
// checkpoint is otherwise tautological: adminAuthenticate rejects inactive
// callers before this handler runs.
router.get('/diagnose', async (req, res, next) => {
  try {
    const requestedUserId = req.query.userId ? parseInt(req.query.userId, 10) : null;
    const targetingOther = requestedUserId && requestedUserId !== req.technicianId;
    if (targetingOther && req.techRole !== 'admin') {
      return res.status(403).json({ error: 'Admin role required to diagnose another user' });
    }
    const userId = requestedUserId || req.technicianId;
    const report = { targetUserId: userId, callerUserId: req.technicianId, checks: {} };

    // 1. VAPID env present (push silently no-ops without these)
    const pushStatus = PushService.status();
    report.checks.vapid = {
      ok: pushStatus.available && pushStatus.configured,
      publicKeyPresent: Boolean(process.env.VAPID_PUBLIC_KEY),
      privateKeyPresent: Boolean(process.env.VAPID_PRIVATE_KEY),
      webPushAvailable: pushStatus.available,
      configured: pushStatus.configured,
      error: pushStatus.error,
    };

    // 2. web-push module loadable
    let webpushLoaded = false;
    try { require('web-push'); webpushLoaded = true; } catch { /* optional */ }
    report.checks.webPushModule = { ok: webpushLoaded };

    // 3. technicians.active — the trigger loop skips inactive users entirely
    try {
      const tech = await db('technicians').where({ id: userId }).first();
      report.checks.technicianActive = {
        ok: Boolean(tech && tech.active),
        active: tech ? tech.active : null,
        name: tech ? tech.name : null,
      };
    } catch (err) {
      report.checks.technicianActive = { ok: false, error: err.message };
    }

    // 4. push_subscriptions — auto-deactivated rows (410/404) are a common cause
    try {
      const subs = await db('push_subscriptions').where({ admin_user_id: userId });
      const active = subs.filter((s) => s.active).length;
      report.checks.pushSubscriptions = {
        ok: active > 0,
        total: subs.length,
        active,
        inactive: subs.length - active,
      };
    } catch (err) {
      report.checks.pushSubscriptions = { ok: false, error: err.message };
    }

    // 5. notification_preferences — rows with bell/push disabled silently suppress
    try {
      const prefs = await db('notification_preferences').where({ admin_user_id: userId });
      const disabled = prefs.filter((p) => !p.bell_enabled || !p.push_enabled);
      report.checks.preferences = {
        ok: disabled.length === 0,
        totalRows: prefs.length,
        disabledTriggers: disabled.map((p) => ({
          trigger_key: p.trigger_key,
          bell_enabled: p.bell_enabled,
          push_enabled: p.push_enabled,
          sound_enabled: p.sound_enabled,
        })),
      };
    } catch (err) {
      report.checks.preferences = { ok: false, error: err.message };
    }

    // 6. Recent bell writes (sanity: is anything landing at all?)
    try {
      const recent = await db('notifications')
        .where({ recipient_type: 'admin' })
        .where('created_at', '>', db.raw("NOW() - INTERVAL '24 hours'"))
        .count('* as c')
        .first();
      report.checks.recentBellWrites = {
        ok: parseInt(recent.c, 10) > 0,
        last24h: parseInt(recent.c, 10),
      };
    } catch (err) {
      report.checks.recentBellWrites = { ok: false, error: err.message };
    }

    report.summary = Object.entries(report.checks)
      .filter(([, v]) => v.ok === false)
      .map(([k]) => k);

    res.json(report);
  } catch (err) { next(err); }
});

// PUT /api/admin/notifications/:id/read — mark one as read.
// Live alert IDs (prefixed `live:<alertId>`) record a per-admin
// dismissal at the alert's current count. The dismissal expires after
// DISMISS_WINDOW_HOURS (admin-unread.js) or sooner if the count grows past
// dismissed_at_count (escalation re-shows the chip).
router.put('/:id/read', async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (id.startsWith('live:')) {
      // Same admin-only rule as read-all: non-admins never see live alerts
      // and must not be able to clear their persisted twins (codex P1).
      if (req.techRole !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
      }
      const alertId = id.slice('live:'.length);
      const recorded = await dismissLiveAlerts(req.technicianId, alertId);
      return res.json({ success: true, live: true, dismissed: recorded > 0, at: await badgeOrderingStamp(req.technicianId) });
    }
    // Scoped to admin notifications — an admin can't clear a customer's row by id.
    const updated = await NotificationService.markReadAdmin(id, { role: req.techRole });
    // Serialized DB-clock badge-ordering stamp — see /unread-count.
    res.json({ success: true, updated, at: await badgeOrderingStamp(req.technicianId) });
  } catch (err) { next(err); }
});

module.exports = router;
