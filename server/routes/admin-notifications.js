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
const { liveAlertNotifications, isLiveDuplicate, getUnreadCountForAdmin } = require('../services/admin-unread');
const { withAlertButtons, runAlertButton } = require('../services/admin-alert-buttons');
const { ibFullAccess } = require('../services/intelligence-bar/ib-access');
const { explainAdminAlert, explainerLive, withExplainerFields } = require('../services/admin-alert-explainer');
const {
  sendAdminAlertToClaude, unsendAdminAlertFromClaude, withSendToClaudeFields, cleanNote, sendToClaudeLive,
} = require('../services/admin-alert-send-to-claude');
const {
  copyLive, withSendCopyToClaudeFields, sendAlertCopyToClaude, cancelAlertCopy,
} = require('../services/admin-alert-copy-to-claude');

router.use(adminAuthenticate);

// An owner-only row (metadata.ownerOnly: an idea sent to Claude, Codex security review round 4) answers any login that is not
// the owner exactly as an unknown row does, so Done and Reopen reveal nothing. Only a UUID can name such a row.
async function hiddenFromLogin(req, id) {
  if (ibFullAccess(req) || !UUID_RE.test(id)) return false;
  return NotificationService.isAdminOwnerOnly(id, { role: req.techRole, technicianId: req.technicianId });
}

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

// Keyset cursor for the bell and Recently-done lists: "<timestamp>~<id>".
// The feed is ordered by plain created_at (done_at) DESC, id DESC, so the
// cursor must carry the column at FULL precision: the service selects
// created_at::text AS created_at_cursor (done_at::text AS done_at_token),
// Postgres text with microseconds and offset, which ::timestamptz round-trips
// exactly. A JS Date would round to the millisecond and skip or repeat rows
// that share one. Without that field (a row from elsewhere) the ISO string of
// the Date is the fallback.
// GATE_ALERT_BELL_ORDER: the bell's cursor is "<rank>~<timestamp>~<id>" (rank 0, 1 or 2, see BELL_RANK_SQL in
// services/notification-service.js). parseCursor reads both shapes; a two-part cursor has no `rank`.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// ISO-8601 or Postgres timestamptz text: date, 'T' or space, time, optional
// fraction (up to microseconds), and a zone (never a naive time: it would be
// read in the session zone). Anything else is not a cursor.
const TIMESTAMP_TEXT_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;
function formatCursor(row, column = 'created_at', fullColumn = `${column}_cursor`) {
  const full = row[fullColumn];
  if (typeof full === 'string' && TIMESTAMP_TEXT_RE.test(full)) return `${full}~${row.id}`;
  const at = new Date(row[column]);
  return Number.isNaN(at.getTime()) ? null : `${at.toISOString()}~${row.id}`;
}
// The ranked bell's cursor: the row's rank in front of the plain cursor. A row with no rank is rank 0 (never skips).
function formatRankedCursor(row) {
  const plain = formatCursor(row);
  if (!plain) return null;
  const rank = Number(row.bell_rank);
  return `${rank === 1 || rank === 2 ? rank : 0}~${plain}`;
}
function parseCursor(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  const parts = raw.split('~');
  if (parts.length !== 2 && parts.length !== 3) return null;
  const [rank, at, id] = parts.length === 3 ? parts : [null, ...parts];
  if (!id || !UUID_RE.test(id) || !TIMESTAMP_TEXT_RE.test(at) || Number.isNaN(new Date(at).getTime())) return null;
  if (rank === null) return { at, id };
  return /^[012]$/.test(rank) ? { at, id, rank: Number(rank) } : null;
}
// Served rows carry the cursor text (and, ranked, the rank) only to build `next`; the client never needs them.
function withoutCursorFields({ created_at_cursor, bell_rank, ...row }) {
  return row;
}

// GATE_ALERT_BELL_ORDER, read at call time. A test that mocks feature-gates without the reader reads it as off.
function bellOrderOn() {
  try {
    const gates = require('../config/feature-gates');
    return typeof gates.alertBellOrderLive === 'function' && gates.alertBellOrderLive() === true;
  } catch { return false; }
}
// The row's Area when metadata.area is one of the nine Areas; nothing otherwise. Lazy require: only a ranked list needs it.
function withAreaChips(rows) {
  const { AREAS } = require('../services/admin-alert-compose');
  return rows.map((row) => {
    const area = parseMetadata(row.metadata).area;
    return AREAS.includes(area) ? { ...row, areaChip: area } : row;
  });
}

// GET /api/admin/notifications — list with pagination.
// Live dashboard alerts are merged in front of the persisted feed on
// page 1 only; subsequent pages serve persisted notifications without
// the live overlay so paging math stays simple. Persisted rows that
// duplicate the current live overlay (same alertId + count) are dropped
// — escalation history (older counts) stays.
router.get('/', async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
    // before: the `next` cursor a previous page returned. Rows leave the
    // feed between requests (Done here, another admin's Done, an auto-close),
    // so an offset would skip the rows that moved up; the cursor continues
    // strictly after the last row served. page stays for callers without one.
    const ranked = bellOrderOn();
    const parsed = parseCursor(req.query.before);
    if (req.query.before && !parsed) return res.status(400).json({ error: 'Invalid cursor' });
    // Gate off: a ranked cursor (a panel open when the gate was unset) is read by its timestamp and id alone.
    const before = parsed && !ranked ? { at: parsed.at, id: parsed.id } : parsed;
    const offset = before ? 0 : (page - 1) * limit;
    // fullAccess: an owner-only row (a Claude plan or copy) is listed for the owner login alone.
    const fullAccess = ibFullAccess(req);
    const persisted = await NotificationService.getAdminNotifications(limit + 1, offset, { role: req.techRole, technicianId: req.technicianId, before, fullAccess, ...(ranked ? { ranked } : {}) });
    // Bell policy on: computed dashboard aggregates stay on the dashboard
    // banner (/admin/dashboard/alerts) but no longer merge into the bell.
    // Live overlay is ADMIN-ONLY regardless of policy: dashboard alerts
    // carry finance totals and owner-only links, matching the fail-closed
    // persisted-feed scope (codex P1).
    const liveCtx = !isBellPolicyEnabled() && req.techRole === 'admin'
      ? await liveAlertNotifications(req.technicianId)
      : { live: [], liveKeys: new Set() };
    // Page availability follows persisted rows before overlay deduplication:
    // a page containing only live-alert duplicates must still allow paging.
    const dedupedPersisted = persisted.slice(0, limit).filter((n) => !isLiveDuplicate(n, liveCtx.liveKeys));
    const lastServed = persisted.slice(0, limit).at(-1);
    const served = await withAlertButtons(dedupedPersisted.map(withoutCursorFields), { role: req.techRole });
    // An SMS review bell's source text rides as `source_text`, read now and never stored on the row. Added last:
    // the explainer reads the stored row by id, never this.
    const { withTextNoteSources } = require('../services/sms-operational-actions');
    const sendable = await withSendToClaudeFields(await withExplainerFields(served, { role: req.techRole }),
      { role: req.techRole, fullAccess });
    // `sendCopyToClaude` marks a row step 1 refuses (customer contact, words our code did not write), owner login only.
    const marked = withSendCopyToClaudeFields(sendable, { role: req.techRole, fullAccess });
    const withSources = await withTextNoteSources(marked, { role: req.techRole });
    // Ranked: one Area chip per row, from the stored label. The row's own metadata is read, never the customer's words.
    const rows = ranked ? withAreaChips(withSources) : withSources;
    res.json({
      // A row's own buttons ride as `actions`, for the admin role only (docs/admin-notifications.md section 2, part 9).
      // The customer it names and its "What to do" summary ride as `customer`, `explainable` and `explainer`, for the
      // admin role while GATE_ALERT_EXPLAINER is on. `sendToClaude` marks a row the "Send to Claude" button may move,
      // for the admin role while GATE_ALERT_SEND_TO_CLAUDE is on (no explainer needed).
      notifications: [...(page === 1 && !before ? liveCtx.live : []), ...rows],
      page, limit, hasMore: persisted.length > limit,
      next: persisted.length > limit && lastServed ? (ranked ? formatRankedCursor(lastServed) : formatCursor(lastServed)) : null,
      // The list is ranked (needs-you first, then newest first inside a rank): the bell keeps this order as served.
      ...(ranked ? { order: 'needs-you-first' } : {}),
    });
  } catch (err) { next(err); }
});

// GET /api/admin/notifications/done — recently done alerts (last 7 days) so an
// admin can reopen an accidental Done. Admin-only, like reopen itself.
router.get('/done', requireAdmin, async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const before = parseCursor(req.query.before);
    if (req.query.before && !before) return res.status(400).json({ error: 'Invalid cursor' });
    const rows = await NotificationService.getAdminDoneNotifications({ role: req.techRole, technicianId: req.technicianId, limit: limit + 1, before, fullAccess: ibFullAccess(req) });
    const page = rows.slice(0, limit);
    res.json({
      notifications: page,
      hasMore: rows.length > limit,
      // done_at_token (done_at::text) is the cursor source AND the reopen fence.
      next: rows.length > limit ? formatCursor(page[page.length - 1], 'done_at', 'done_at_token') : null,
    });
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
  // A held/memberless snapshot (closeout outage form) must not blind the
  // membership-aware re-show (GH codex r4 P2): the newest dismissal row wins
  // in admin-unread, so recording NULL members here would replace an earlier
  // membership-aware dismissal and suppress genuinely NEW work at
  // same-or-lower count for the whole window. Carry the latest known
  // membership forward instead; with no prior membership row, the
  // documented count-only semantics apply as before.
  const memberlessIds = dismissalRows.filter((r) => r.dismissed_members === null).map((r) => r.alert_id);
  if (memberlessIds.length) {
    try {
      // Bounded to the CURRENT alert incarnation (pre-push P1): alert ids
      // recur (closeout_gaps_today reuses its id daily), so an unbounded
      // lookup could copy YESTERDAY'S membership into today's dismissal and
      // make today's recovered exact membership read as new work right after
      // the click. dashboard_alert_state.first_seen_at marks when this
      // incarnation began; a memberful dismissal from before it belongs to a
      // previous incarnation and must not be carried. No state row = no
      // active incarnation to protect → keep NULL (count-only semantics).
      const stateRows = await db('dashboard_alert_state')
        .whereIn('alert_id', memberlessIds)
        .select('alert_id', 'first_seen_at');
      // first_seen_at survives an ET midnight while the alert stays active
      // (the cron preserves it), but day-scoped memberships (closeout's
      // visit ids) go stale at the rollover — bound the incarnation to
      // whichever is later: first_seen_at or today's ET day start.
      const { parseETDateTime, etDateString } = require('../utils/datetime-et');
      const etDayStart = parseETDateTime(`${etDateString()}T00:00`).getTime();
      const firstSeenByAlert = new Map(stateRows.map((s) => [s.alert_id, Math.max(new Date(s.first_seen_at).getTime(), etDayStart)]));
      const prior = await db('dashboard_alert_dismissed')
        .where({ admin_user_id: adminUserId })
        .whereIn('alert_id', memberlessIds)
        .whereNotNull('dismissed_members')
        .orderBy('dismissed_at', 'desc')
        .select('alert_id', 'dismissed_members', 'dismissed_at');
      const latestByAlert = new Map();
      for (const p of prior) {
        const incarnationStart = firstSeenByAlert.get(p.alert_id);
        if (incarnationStart == null || new Date(p.dismissed_at).getTime() < incarnationStart) continue;
        if (!latestByAlert.has(p.alert_id)) latestByAlert.set(p.alert_id, p.dismissed_members);
      }
      for (const r of dismissalRows) {
        if (r.dismissed_members === null && latestByAlert.has(r.alert_id)) r.dismissed_members = latestByAlert.get(r.alert_id);
      }
    } catch { /* pre-migration tolerance: dismissed_members absent → keep null */ }
  }
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
    await NotificationService.markAllReadAdmin({ role: req.techRole, technicianId: req.technicianId, fullAccess: ibFullAccess(req) });
    // Live-alert dismissal is admin-only: the overlay never renders for
    // other roles, and its helper also marks persisted dashboard_alert
    // rows read — rows the fail-closed feed hides from them (codex P1).
    if (req.techRole === 'admin') await dismissLiveAlerts(req.technicianId);
    // No badge-ordering stamp here: the client re-syncs the icon via a
    // fresh /unread-count after the mutation (authoritative count AND
    // stamp from the locked section) — a stamp on this response could
    // clear the icon even when live-alert dismissal failed soft.
    res.json({ success: true });
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
router.get('/diagnose', requireAdmin, async (req, res, next) => {
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
      return res.json({ success: true, live: true, dismissed: recorded > 0 });
    }
    // Scoped to admin notifications — an admin can't clear a customer's row by id.
    const updated = await NotificationService.markReadAdmin(id, { role: req.techRole, technicianId: req.technicianId, fullAccess: ibFullAccess(req) });
    // No badge-ordering stamp — see /read-all.
    res.json({ success: true, updated });
  } catch (err) { next(err); }
});

// PUT /api/admin/notifications/:id/done — mark one done (docs/admin-notifications.md
// section 4.3). Read is not done: a done row leaves the bell, its unread
// count and mark-all-read. Same role scope as /:id/read (a technician can
// only touch a tech-visible row). `resolution` is optional, one plain line.
// Live overlay rows have no persisted id, so they cannot be marked done.
// `version` (required): the content version the bell list served for the row.
// A quiet refresh can rewrite a standing row's text in place, so Done only
// lands on the text the admin actually saw; a changed row answers 409 and the
// bell reloads it.
const NOTIFICATION_VERSION_RE = /^[0-9a-f]{32}$/i;
router.put('/:id/done', async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (id.startsWith('live:')) return res.status(400).json({ error: 'Live alerts clear when their count does' });
    const version = req.body?.version;
    if (typeof version !== 'string' || !NOTIFICATION_VERSION_RE.test(version)) {
      return res.status(400).json({ error: 'version is required' });
    }
    if (await hiddenFromLogin(req, id)) return res.status(404).json({ error: 'not_found' });
    const resolution = typeof req.body?.resolution === 'string' ? req.body.resolution : null;
    const updated = await NotificationService.markAdminDone([id], { by: String(req.technicianId), resolution, role: req.techRole, technicianId: req.technicianId, expectedVersion: version.toLowerCase() });
    if (!updated) {
      const state = await NotificationService.getAdminNotificationState(id, { role: req.techRole, technicianId: req.technicianId });
      if (state && !state.done && state.version !== version.toLowerCase()) return res.status(409).json({ error: 'changed' });
    }
    // GATE_SMS_FOLLOWUP_WITNESS_FIX: Done on a text follow-up bell also settles
    // the follow-up it speaks for, so the sweep does not ring it again.
    if (updated > 0) {
      try { await require('../services/sms-operational-actions').settleCommitmentsForDoneAlert(db, id, { reviewedBy: req.technicianId }); }
      catch (err) { logger.warn(`[admin-notifications] follow-up not settled for done alert ${id}: ${err.message}`); }
    }
    res.json({ success: true, updated: updated > 0 });
  } catch (err) { next(err); }
});

// POST /api/admin/notifications/:id/actions/:actionId — press one of the row's own buttons
// (docs/admin-notifications.md section 2, part 9). Admin only. `version` (required): the content version the
// bell list served for the row, as for Done, so a button runs only on the row the admin saw. The server runs
// only a button the row carries, through its kind's handler, which reads the record again; on success the row
// is done. A changed row, a second tap or a refused step answers 409 with a short message.
router.post('/:id/actions/:actionId', requireAdmin, async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid notification id' });
    // An owner-only row answers any other login as an unknown row does.
    if (await hiddenFromLogin(req, id)) return res.status(404).json({ error: 'not_found' });
    const version = req.body?.version;
    if (typeof version !== 'string' || !NOTIFICATION_VERSION_RE.test(version)) {
      return res.status(400).json({ error: 'version is required' });
    }
    const { status, body } = await runAlertButton({
      notificationId: id, actionId: String(req.params.actionId), version: version.toLowerCase(),
      technicianId: req.technicianId, role: req.techRole,
    });
    res.status(status).json(body);
  } catch (err) { next(err); }
});

// POST /api/admin/notifications/:id/explain — the bell's "What to do" for one row (GATE_ALERT_EXPLAINER, admin only):
// { explainer: { happened, steps, fixer, fallback? }, customer: { id, name } | null, version } (`version`: the content
// version the summary was written for; the bell keeps it only on a row it holds at that version). The first open asks an AI and
// saves the summary on the row (services/admin-alert-explainer.js); later opens read it back. Sends nothing to anyone.
// Gate off: 404, the same as an unknown route.
router.post('/:id/explain', requireAdmin, async (req, res, next) => {
  try {
    if (!explainerLive()) return res.status(404).json({ error: 'Not found' });
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid notification id' });
    const { status, body } = await explainAdminAlert(id, { role: req.techRole, technicianId: req.technicianId });
    res.status(status).json(body);
  } catch (err) { next(err); }
});

// POST /api/admin/notifications/:id/send-to-claude — the bell's "Send to Claude" button (GATE_ALERT_SEND_TO_CLAUDE, owner
// login only; no explainer gate, owner 2026-11-03). `version` (required): the content version the bell served for the row.
// `note` (optional text, 500 characters): the admin's own words for the Claude tab. Moves the row out of the bell into
// Claude's queue, where the Mac launcher opens a Claude tab for it (services/admin-alert-send-to-claude.js). The answer
// carries `at`, the send's time, for the undo. 422 for customer contact, a row our code did not write, a done row or a
// row already off the bell; 409 when the row changed since the bell read it. Sends nothing to anyone. Gate off: 404,
// the same as an unknown route.
router.post('/:id/send-to-claude', requireAdmin, async (req, res, next) => {
  try {
    if (!sendToClaudeLive()) return res.status(404).json({ error: 'Not found' });
    // Owner login only (Codex security review on #7548): a send and its note go into a Claude terminal tab.
    if (!ibFullAccess(req)) return res.status(403).json({ error: 'This action is limited to the owner account.' });
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid notification id' });
    const version = req.body?.version;
    if (typeof version !== 'string' || !NOTIFICATION_VERSION_RE.test(version)) {
      return res.status(400).json({ error: 'version is required' });
    }
    const { note, error } = cleanNote(req.body?.note);
    if (error) return res.status(400).json({ error });
    const { status, body } = await sendAdminAlertToClaude(id, {
      version: version.toLowerCase(), by: req.technicianId, role: req.techRole, technicianId: req.technicianId, note,
    });
    res.status(status).json(body);
  } catch (err) { next(err); }
});

// POST /api/admin/notifications/:id/unsend-from-claude — the 10-second Undo after a send (GATE_ALERT_SEND_TO_CLAUDE,
// owner login only). `at` (required): the time the send answered with. Puts the row back in the bell while it is open, still
// carries that send and no Mac tab has started on it; 409 `started`, `changed` or `done` otherwise. Sends nothing to
// anyone. Gate off: 404, the same as an unknown route.
router.post('/:id/unsend-from-claude', requireAdmin, async (req, res, next) => {
  try {
    if (!sendToClaudeLive()) return res.status(404).json({ error: 'Not found' });
    // Owner login only (Codex security review on #7548): a send and its note go into a Claude terminal tab.
    if (!ibFullAccess(req)) return res.status(403).json({ error: 'This action is limited to the owner account.' });
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid notification id' });
    const at = req.body?.at;
    if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(at)) return res.status(400).json({ error: 'at is required' });
    const { status, body } = await unsendAdminAlertFromClaude(id, {
      at, by: req.technicianId, role: req.techRole, technicianId: req.technicianId,
    });
    res.status(status).json(body);
  } catch (err) { next(err); }
});

// POST /api/admin/notifications/:id/send-copy-to-claude — the bell's "Send a copy to Claude (read-only)" button for a row
// "Send to Claude" refuses (GATE_ALERT_SEND_TO_CLAUDE_COPY, owner login only, step 3). `version` (required): the content
// version the bell served for the row. `note` (optional text, 500 characters). Writes ONE new owner-only row into Claude's
// queue that names the alert by id and holds no customer words; the alert itself stays in the bell
// (services/admin-alert-copy-to-claude.js). The answer carries the copy's `id` and `at`, for the undo. 409 when the row
// changed since the bell read it or cannot be copied. Sends nothing to anyone. Gate off: 404, the same as an unknown route.
router.post('/:id/send-copy-to-claude', requireAdmin, async (req, res, next) => {
  try {
    if (!copyLive()) return res.status(404).json({ error: 'Not found' });
    if (!ibFullAccess(req)) return res.status(403).json({ error: 'This action is limited to the owner account.' });
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Not found' });
    const version = req.body?.version;
    if (typeof version !== 'string' || !NOTIFICATION_VERSION_RE.test(version)) {
      return res.status(400).json({ error: 'version is required' });
    }
    const { status, body } = await sendAlertCopyToClaude(id, {
      version: version.toLowerCase(), note: req.body?.note, by: req.technicianId, role: req.techRole, technicianId: req.technicianId,
    });
    res.status(status).json(body);
  } catch (err) { next(err); }
});

// POST /api/admin/notifications/:id/cancel-copy — the 10-second Undo after a copy, on the COPY's id (GATE_ALERT_SEND_TO_CLAUDE_COPY,
// owner login only). `at` (required): the time the send answered with. Closes the copy while it is open, still that send and
// no Mac tab has started on it; 409 `started`, `changed` or `done` otherwise. Gate off: 404.
router.post('/:id/cancel-copy', requireAdmin, async (req, res, next) => {
  try {
    if (!copyLive()) return res.status(404).json({ error: 'Not found' });
    if (!ibFullAccess(req)) return res.status(403).json({ error: 'This action is limited to the owner account.' });
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Not found' });
    const at = req.body?.at;
    if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(at)) return res.status(400).json({ error: 'at is required' });
    const { status, body } = await cancelAlertCopy(id, { at, by: req.technicianId, role: req.techRole, technicianId: req.technicianId });
    res.status(status).json(body);
  } catch (err) { next(err); }
});

// PUT /api/admin/notifications/:id/reopen — put a done row back in the bell.
// `doneAt` (required): the done_at_token the Recently-done list served for the
// row. A stale list cannot clear a NEWER completion: a row that is still done
// but no longer by that close answers 409 changed, and a row a system
// component closed (not a person) answers 409 not_reopenable.
router.put('/:id/reopen', requireAdmin, async (req, res, next) => {
  try {
    const doneAt = req.body?.doneAt;
    if (typeof doneAt !== 'string' || !TIMESTAMP_TEXT_RE.test(doneAt) || Number.isNaN(new Date(doneAt).getTime())) {
      return res.status(400).json({ error: 'doneAt is required' });
    }
    if (await hiddenFromLogin(req, String(req.params.id))) return res.status(404).json({ error: 'not_found' });
    const result = await NotificationService.reopenAdminDone(String(req.params.id), { expectedDoneAt: doneAt });
    if (result === 'changed') return res.status(409).json({ error: 'changed' });
    if (result === 'not_reopenable') return res.status(409).json({ error: 'not_reopenable' });
    res.json({ success: true, updated: result === 'reopened' });
  } catch (err) { next(err); }
});

module.exports = router;
// Test hooks (cursor shapes); not part of the router API.
module.exports._cursor = { parseCursor, formatCursor, formatRankedCursor };
