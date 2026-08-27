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
//
// trx (optional): run the per-admin dismissal queries on an existing
// transaction's connection (see getUnreadCountForAdmin).
// precomputedAlerts (optional): use this alert snapshot instead of
// calling the shared aggregator — badge sections compute the snapshot
// BEFORE reserving their transaction and hand it in, so the aggregator
// never runs while a pool connection is held (codex rounds 12–13).
async function liveAlertNotifications(adminUserId, trx = null, precomputedAlerts = null) {
  let alerts = precomputedAlerts;
  if (!alerts) {
    try {
      const result = await computeDashboardAlerts();
      alerts = result.alerts || [];
    } catch (err) {
      logger.error(`[admin-unread] computeDashboardAlerts failed: ${err.message}`);
      return { live: [], liveKeys: new Set() };
    }
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
  //
  // With a section transaction, each probe runs in a SAVEPOINT (knex
  // nested transaction): the pre-migration dismissed_members probe below
  // is EXPECTED to fail on an unmigrated database, and a failed statement
  // otherwise aborts the whole section transaction — turning the
  // advertised rollout tolerance into a guaranteed error on every
  // follow-up query (codex round 12). Without trx this is the plain
  // pool query it always was.
  const dismissalQuery = (sql, params) => (trx
    ? trx.transaction((sp) => sp.raw(sql, params))
    : db.raw(sql, params));
  let dismissals = [];
  try {
    dismissals = await dismissalQuery(
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
        dismissals = await dismissalQuery(
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
// trx (optional): run every query except the shared memoized
// computeDashboardAlerts on the caller's transaction connection, so an
// advisory-lock section never borrows a second pool connection while
// holding one (codex #3541 round 11 — twenty concurrent staff polls
// could otherwise hold twenty transactions all waiting for compute
// connections).
async function computeUnreadCount({ adminUserId, role } = {}, trx = null, precomputedAlerts = null) {
  const liveCtx = isBellPolicyEnabled() || role !== 'admin'
    ? { live: [], liveKeys: new Set() }
    : await liveAlertNotifications(adminUserId, trx, precomputedAlerts);
  let persistedCount = await NotificationService.getAdminUnreadCount({ role }, trx);
  if (liveCtx.liveKeys.size > 0) {
    try {
      const unreadDashboardAlerts = await (trx || db)('notifications')
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

// Badge-ordering stamps. Every badge-ordering token (push badgeAt, the
// bell routes' `at`) must come from ONE clock and be monotonic in
// snapshot order: two overlapping count computations for the same admin
// must not hand the OLDER count the NEWER stamp — the client keeps
// whichever stamp is higher (codex #3541 round 6). A per-admin Postgres
// advisory lock serializes the whole critical section across every
// replica (same pattern as dashboard-alerts-cron), and the stamp is the
// DB clock read inside the locked section AFTER the payload work, so
// stamps order exactly as the serialized sections do. Environments
// without transaction/advisory support (unit mocks) fall back to the
// previous unserialized app-clock stamp — the badge is garnish and must
// never break on infrastructure.
const BADGE_LOCK_NS = 'waves-badge:';

// In-process serialization for the TRIGGER path only, before any pool
// connection is reserved: the push fan-out (Promise.all over recipients)
// is the one caller whose concurrency is unbounded, so its badge
// transactions queue through one process-wide chain — at most one badge
// transaction from pushes per process, and the pool cannot be exhausted
// by badges (codex #3541 rounds 7–8). Bell routes (unread-count,
// read/read-all stamps) deliberately BYPASS this chain: their
// concurrency is one small user-driven request at a time, and queueing
// them behind a push burst would let a single stuck badge computation
// hang the bell (codex round 10). Cross-replica/cross-path ordering is
// the advisory lock's job either way; the chain is purely a pool bound.
let badgeSectionTail = Promise.resolve();
function serializeBadgeSection(task) {
  const run = badgeSectionTail.then(task, task);
  badgeSectionTail = run.then(() => {}, () => {});
  return run;
}

// One bounded critical section: per-admin advisory lock (wait capped by
// lock_timeout so a wedged peer errors into the caller's fallback
// instead of stacking transactions behind it), fn, then the stamp.
async function runBadgeSection(key, fn) {
  return db.transaction(async (trx) => {
    await trx.raw("SET LOCAL lock_timeout = '2500ms'");
    // Statement deadline (codex round 12): a hung count query must error
    // and roll this transaction back — releasing its pool connection —
    // rather than keep the connection parked after the queued chain's 5s
    // cap has already advanced past this section.
    await trx.raw("SET LOCAL statement_timeout = '4000ms'");
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`${BADGE_LOCK_NS}${key}`]);
    let result;
    try {
      // fn runs its queries on THIS transaction's connection (round 11):
      // a section must never borrow a second pool connection while
      // holding one, or concurrent sections for distinct admins could
      // hold the whole pool waiting on each other's compute.
      result = await fn(trx);
    } catch (err) {
      err.badgeComputeError = true; // fn's own failure — never retried below
      throw err;
    }
    // Microsecond DB-clock token: consecutive serialized sections are
    // separated by at least a DB round-trip (≫1µs), so tokens are
    // strictly increasing in section order — a pre-read push snapshot
    // and the read stamp that follows it can never draw equal tokens
    // (codex round 7). Epoch µs stays well inside Number precision.
    const { rows } = await trx.raw(
      'SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000000)::bigint AS us',
    );
    const us = Number(rows?.[0]?.us);
    return { ...result, at: Number.isFinite(us) ? us : Date.now() * 1000 };
  });
}

// Cap on a QUEUED (trigger-path) section so one stuck query cannot wedge
// the chain forever: the chain advances, the abandoned section finishes
// in the background, and lock_timeout keeps follow-on sections from
// stacking behind its advisory lock.
const BADGE_SECTION_TIMEOUT_MS = 5000;

async function withBadgeOrderingStamp(adminUserId, fn, { queued = false, abandoned } = {}) {
  const key = String(adminUserId ?? '');
  const attempt = async () => {
    try {
      if (typeof db.transaction !== 'function') throw new Error('transactions unavailable');
      return await runBadgeSection(key, fn);
    } catch (err) {
      if (err && err.badgeComputeError) throw err;
      // Same µs unit as the locked path so a fallback stamp still competes.
      logger.warn(`[admin-unread] badge ordering lock unavailable (${err.message}) — unserialized stamp`);
      return { ...(await fn(null)), at: Date.now() * 1000 };
    }
  };
  if (!queued) return attempt();
  return serializeBadgeSection(async () => {
    // The trigger's own 1.5s race may have given up while this task sat
    // in the queue — drop it before spending a transaction on a badge
    // nobody will send (codex round 10).
    if (typeof abandoned === 'function' && abandoned()) {
      const err = new Error('badge snapshot abandoned by caller');
      err.badgeComputeError = true;
      throw err;
    }
    let timer;
    try {
      return await Promise.race([
        attempt(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(Object.assign(new Error('badge section timed out'), { badgeComputeError: true }));
          }, BADGE_SECTION_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  });
}

// Returns { count, at }: the unread snapshot plus its ordering stamp,
// both produced inside the per-admin serialized section. opts.queued
// routes the section through the process-wide trigger chain (push
// fan-out only); opts.abandoned lets a queued caller that already gave
// up cancel the task before it starts.
async function getUnreadCountForAdmin({ adminUserId, role } = {}, opts = {}) {
  // Compute the shared alert aggregate BEFORE the section reserves its
  // transaction and hand the SNAPSHOT into the locked count (codex
  // rounds 12–13): a cold aggregation borrows pool connections and must
  // never run while we hold one, and merely pre-warming the 30s memo is
  // not enough — its timestamp is set when computation STARTS, so an
  // aggregation slower than the TTL expires on arrival and an in-section
  // call would recompute. With the snapshot passed in, the section never
  // touches the aggregator at all. Failure degrades to an empty overlay,
  // exactly as liveAlertNotifications does on its own.
  let alerts = null;
  if (role === 'admin' && !isBellPolicyEnabled()) {
    try {
      alerts = (await computeDashboardAlerts()).alerts || [];
    } catch (err) {
      logger.error(`[admin-unread] computeDashboardAlerts failed: ${err.message}`);
      alerts = [];
    }
  }
  return withBadgeOrderingStamp(adminUserId, async (trx) => ({
    count: await computeUnreadCount({ adminUserId, role }, trx, alerts),
  }), opts);
}

// Stamp-only critical section for read mutations (mark-read/read-all).
// The mutation committed before this is called, so any snapshot
// serialized after it both observes the mutation and stamps later; a
// snapshot still holding the lock stamps earlier and correctly loses to
// this fresher token.
async function badgeOrderingStamp(adminUserId) {
  const { at } = await withBadgeOrderingStamp(adminUserId, async () => ({}));
  return at;
}

module.exports = { liveAlertNotifications, isLiveDuplicate, getUnreadCountForAdmin, badgeOrderingStamp };
