// Dashboard alerts cron — fires Web Push + SMS when an operational
// alert NEWLY appears or escalates (count grows past what was last
// pushed).
//
// Reads current alerts via dashboard-alerts.computeDashboardAlerts(),
// diffs against the dashboard_alert_state table, and:
//   - new alert (state row absent)        → INSERT state, push + SMS (if critical)
//   - escalated alert (count > last_push) → UPDATE state, push + SMS (if critical)
//   - same alert, same/lower count        → UPDATE last_seen_at only (no notify)
//   - cleared alert (in state, not now)   → DELETE state row (alert resolved silently)
//
// Restart-safe: state lives in Postgres, so a server restart doesn't
// cause re-pushes for already-known alerts.
//
// Cross-replica safe: a Postgres advisory lock serializes ticks across
// the entire fleet so only one replica can run a tick at a time. The
// previous in-process flag was sufficient for single-replica deploys
// but two replicas firing in lockstep would each classify the same
// alert as "new" before either one upserted state, causing duplicate
// push + duplicate owner SMS.
//
// SMS goes to OWNER_PHONE (env, fallback ADAM_PHONE) and ONLY for
// severity='critical' — warn-tier alerts get a Web Push banner but
// don't pull anyone out of dinner over a card-expiring-in-7-days.
//
// Notification dispatch happens AFTER the state-write transaction
// commits — never inside it. If notifications were inside the same
// transaction, a later DB error would roll back state upserts that
// already triggered push/SMS, and the next cron tick would see the
// same alerts as new and re-fan-out duplicate notifications. Codex
// P1 on PR #532; redone in PR-against-main with the post-commit
// pattern below.

const db = require('../models/db');
const logger = require('./logger');
const { computeDashboardAlerts } = require('./dashboard-alerts');
const { triggerNotification } = require('./notification-triggers');
const TwilioService = require('./twilio');

// Stable advisory-lock key. hashtext() produces an int4 from a string
// so the value is reproducible across replicas without coordination.
// Keep this string fixed; changing it would break cross-replica
// serialization until every replica redeploys.
const ADVISORY_LOCK_KEY = 'dashboard-alerts-cron';

function ownerPhone() {
  return process.env.OWNER_PHONE || process.env.ADAM_PHONE || null;
}

// Best-effort owner SMS — single retry on failure, swallow & log on
// total failure so the cron's other side-effects (push, state already
// committed) don't get undone by an SMS provider blip.
async function smsOwner(message) {
  const phone = ownerPhone();
  if (!phone) {
    logger.warn('[dashboard-alerts-cron] OWNER_PHONE / ADAM_PHONE not set — skipping SMS');
    return false;
  }
  try {
    await TwilioService.sendSMS(phone, message, { messageType: 'internal_alert', skipLogo: true });
    return true;
  } catch (err) {
    logger.error(`[dashboard-alerts-cron] owner SMS failed: ${err.message}`);
    return false;
  }
}

// In-process mutex — fast short-circuit so we don't open a Postgres
// transaction we'd immediately roll back when a slow previous tick is
// still running. The advisory lock below is the cross-replica
// authority; this flag just avoids burning a lock acquisition on a
// known overlap.
let isRunning = false;

// Single tick: acquire advisory lock, read+write state inside a
// transaction, COMMIT, then fire notifications. Returns counts.
async function runDashboardAlertsCheck() {
  if (isRunning) {
    logger.info('[dashboard-alerts-cron] previous tick still running on this replica, skipping');
    return { fired: 0, cleared: 0, skipped: true };
  }
  isRunning = true;
  try {
    return await runDashboardAlertsCheckInner();
  } finally {
    isRunning = false;
  }
}

async function runDashboardAlertsCheckInner() {
  // Compute current alerts OUTSIDE the transaction — read-only and
  // potentially slow (other-DB queries, external lookups). Inside-
  // transaction time should be the minimum needed to hold the lock.
  let current;
  try {
    const result = await computeDashboardAlerts();
    current = result.alerts || [];
  } catch (err) {
    logger.error(`[dashboard-alerts-cron] computeDashboardAlerts failed: ${err.message}`);
    return { fired: 0, cleared: 0, error: err.message };
  }

  // Phase 1 — atomic state diff + write inside an advisory-locked
  // transaction. Build the list of notifications to fire after commit.
  // Phase 2 below — fire those notifications strictly after commit.
  let fired = 0;
  let cleared = 0;
  const pendingNotifications = [];
  const now = new Date();

  try {
    await db.transaction(async (trx) => {
      // pg_advisory_xact_lock blocks until the lock is acquired and
      // releases automatically on commit/rollback — no leak risk.
      // Cross-replica: only one tick can hold this lock at a time.
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [ADVISORY_LOCK_KEY]);

      const stateRows = await trx('dashboard_alert_state').select('*');
      const stateById = new Map(stateRows.map((r) => [r.alert_id, r]));
      const currentIds = new Set(current.map((a) => a.id));

      for (const alert of current) {
        const prev = stateById.get(alert.id);
        const isNew = !prev;
        const escalated = prev && alert.count > (prev.last_pushed_count || 0);

        if (isNew || escalated) {
          // Upsert state FIRST. ON CONFLICT ensures a concurrent
          // tick across replicas (which the advisory lock above
          // already prevents — but cheap insurance) doesn't
          // duplicate the row. State is committed before any
          // notification fires so a notification failure cannot
          // roll back the state row and cause a re-fire next tick.
          await trx('dashboard_alert_state')
            .insert({
              alert_id: alert.id,
              severity: alert.severity,
              current_count: alert.count,
              last_pushed_count: alert.count,
              first_seen_at: prev ? prev.first_seen_at : now,
              last_seen_at: now,
              last_pushed_at: now,
              last_label: alert.label,
            })
            .onConflict('alert_id')
            .merge({
              severity: alert.severity,
              current_count: alert.count,
              last_pushed_count: alert.count,
              last_seen_at: now,
              last_pushed_at: now,
              last_label: alert.label,
            });

          // Queue the notification for after-commit dispatch.
          pendingNotifications.push({ alert });
          fired += 1;
        } else {
          // Same alert still active, count hasn't grown — just
          // heartbeat last_seen_at + current_count so the
          // dashboard's per-admin dismissal logic can compare
          // against an up-to-date count.
          await trx('dashboard_alert_state')
            .where({ alert_id: alert.id })
            .update({ current_count: alert.count, last_seen_at: now });
        }
      }

      // Garbage-collect cleared alerts. Dismissals for a resolved
      // alert are harmless to keep around (they'll never match
      // again unless the same alert id re-fires).
      for (const stateRow of stateRows) {
        if (!currentIds.has(stateRow.alert_id)) {
          await trx('dashboard_alert_state').where({ alert_id: stateRow.alert_id }).del();
          cleared += 1;
        }
      }
    });
  } catch (err) {
    // Transaction (lock + state writes) failed and rolled back. No
    // notifications fired because pendingNotifications dispatch is
    // post-commit. Return the error so the caller can decide whether
    // to retry.
    logger.error(`[dashboard-alerts-cron] state-write transaction failed (no notifications fired): ${err.message}`);
    return { fired: 0, cleared: 0, error: err.message };
  }

  // Phase 2 — POST-COMMIT notifications. State is durable; sending
  // these fire-and-forget. Failures are logged but do not roll back
  // state (which is exactly the bug codex P1 flagged on the original
  // #532). On a transient push failure, the alert's `last_pushed_*`
  // is already updated so the next tick won't re-fire it; the missed
  // notification is logged but not retried (same end-state as the
  // pre-#532 code's swallowed-error pattern).
  for (const { alert } of pendingNotifications) {
    try {
      // alertId + alertCount land in the persisted row's metadata so
      // the bell endpoint can dedupe this row against the live overlay
      // (same alert at same count). Earlier counts stay as escalation
      // history.
      await triggerNotification('dashboard_alert', {
        alertId: alert.id,
        alertCount: alert.count,
        title: alert.label + (alert.amount ? ` ($${Math.round(alert.amount).toLocaleString()})` : ''),
        body: alert.severity === 'critical' ? 'Critical — needs attention now.' : 'Worth a look soon.',
        link: alert.href,
      });
    } catch (err) {
      logger.error(`[dashboard-alerts-cron] post-commit triggerNotification failed for ${alert.id}: ${err.message}`);
    }

    if (alert.severity === 'critical') {
      await smsOwner(`Waves alert: ${alert.label}${alert.amount ? ` ($${Math.round(alert.amount).toLocaleString()})` : ''}\n${alert.href}`);
    }
  }

  return { fired, cleared, current: current.length };
}

module.exports = { runDashboardAlertsCheck };
