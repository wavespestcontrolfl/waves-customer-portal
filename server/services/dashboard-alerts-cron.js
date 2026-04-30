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
// SMS goes to OWNER_PHONE (env, fallback ADAM_PHONE) and ONLY for
// severity='critical' — warn-tier alerts get a Web Push banner but
// don't pull anyone out of dinner over a card-expiring-in-7-days.

const db = require('../models/db');
const logger = require('./logger');
const { computeDashboardAlerts } = require('./dashboard-alerts');
const { triggerNotification } = require('./notification-triggers');
const TwilioService = require('./twilio');

function ownerPhone() {
  return process.env.OWNER_PHONE || process.env.ADAM_PHONE || null;
}

// Best-effort owner SMS — single retry on failure, swallow & log on
// total failure so the cron's other side-effects (push, state update)
// still happen.
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

// Concurrency model:
//   1. `isRunning` — process-local fast-path. Stops node-cron from
//      firing a second tick on top of one already in flight inside
//      this process.
//   2. Per-alert advisory lock — `pg_try_advisory_xact_lock(namespace,
//      alert_id_hash)`. Each iteration of the for-loop opens a tiny
//      transaction that takes a lock scoped to that specific alert
//      id, reads the prior state, writes the new state, and commits.
//      The trx releases both the lock AND the connection on commit.
//
// Why per-alert and not tick-level:
//   * Tick-wrapping in a single trx (PR #532) caused a late write
//     failure to roll back state rows for alerts we'd already pushed,
//     replaying them on the next tick.
//   * Holding a lock-only trx for the whole tick (PR #535 round 2)
//     pinned a connection idle for the entire tick — under
//     DB_POOL_MAX=1 the inner queries timed out (Codex P1).
//   * Per-alert trx uses one connection at a time and releases it
//     when each alert is done. Two replicas can process DIFFERENT
//     alerts in parallel; for the SAME alert, the loser of the lock
//     skips this iteration and will see committed state on the next
//     tick (so it heartbeats instead of re-firing).
//
// Push + SMS fire AFTER trx commit. The state row is durable before
// the network call, so a failed push can't replay on the next tick —
// operator notices via the bell (which has its own persistence).
//
// Cleanup of cleared alerts uses `db` directly with an idempotent
// DELETE; race-with-resurrection is recoverable (the alert would
// just reclassify as "new" on the next tick), so no lock is needed.
//
// Lock key namespace: hashtext('waves:dashboard-alerts-cron') as the
// first int4, hashtext(alert.id) as the second. Two cron files can't
// collide because the namespace differs.
let isRunning = false;
const ALERT_LOCK_NAMESPACE_SQL = "hashtext('waves:dashboard-alerts-cron')";

// Single tick: read current alerts, fan out notifications per-alert, update state.
async function runDashboardAlertsCheck() {
  if (isRunning) {
    logger.info('[dashboard-alerts-cron] previous tick still running in this process, skipping');
    return { fired: 0, cleared: 0, skipped: 'in_process' };
  }
  isRunning = true;
  try {
    return await runDashboardAlertsCheckInner();
  } finally {
    isRunning = false;
  }
}

async function runDashboardAlertsCheckInner() {
  let current;
  try {
    const result = await computeDashboardAlerts();
    current = result.alerts || [];
  } catch (err) {
    logger.error(`[dashboard-alerts-cron] computeDashboardAlerts failed: ${err.message}`);
    return { fired: 0, cleared: 0, error: err.message };
  }

  const currentIds = new Set(current.map((a) => a.id));

  let fired = 0, cleared = 0, skippedConcurrent = 0;
  const now = new Date();

  for (const alert of current) {
    let outcome = null;
    try {
      outcome = await db.transaction(async (trx) => {
        const lockResult = await trx.raw(
          `SELECT pg_try_advisory_xact_lock(${ALERT_LOCK_NAMESPACE_SQL}, hashtext(?)) AS locked`,
          [alert.id],
        );
        if (!lockResult.rows[0].locked) {
          // Peer replica owns this alert this tick — let it handle.
          return { skipped: 'advisory_lock' };
        }

        const prev = await trx('dashboard_alert_state').where({ alert_id: alert.id }).first();
        const isNew = !prev;
        const escalated = prev && alert.count > (prev.last_pushed_count || 0);

        if (isNew || escalated) {
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
          return { fired: true };
        }
        // Heartbeat under the same lock so concurrent ticks don't
        // race a stale current_count over a fresher one.
        await trx('dashboard_alert_state')
          .where({ alert_id: alert.id })
          .update({ current_count: alert.count, last_seen_at: now });
        return { heartbeat: true };
      });
    } catch (err) {
      logger.error(`[dashboard-alerts-cron] alert ${alert.id} mini-trx failed: ${err.message}`);
      continue;
    }

    if (outcome?.skipped === 'advisory_lock') {
      skippedConcurrent += 1;
      continue;
    }

    if (outcome?.fired) {
      // State row is durable past this point. Push + SMS happen
      // outside the trx so any network-side failure can't roll back
      // the state write. alertId + alertCount land in the persisted
      // row's metadata so the bell endpoint can dedupe this row
      // against the live overlay (same alert at same count).
      try {
        await triggerNotification('dashboard_alert', {
          alertId: alert.id,
          alertCount: alert.count,
          title: alert.label + (alert.amount ? ` ($${Math.round(alert.amount).toLocaleString()})` : ''),
          body: alert.severity === 'critical' ? 'Critical — needs attention now.' : 'Worth a look soon.',
          link: alert.href,
        });
      } catch (err) {
        logger.error(`[dashboard-alerts-cron] triggerNotification failed for ${alert.id}: ${err.message}`);
      }

      if (alert.severity === 'critical') {
        await smsOwner(`Waves alert: ${alert.label}${alert.amount ? ` ($${Math.round(alert.amount).toLocaleString()})` : ''}\n${alert.href}`);
      }

      fired += 1;
    }
  }

  // Garbage-collect cleared alerts. Re-query state since per-alert
  // mini-trxs above may have inserted rows during this tick. Each
  // delete is idempotent — two replicas racing on the same delete is
  // fine, the second is a no-op. If an alert resurges between this
  // read and the delete, the next tick will reclassify it as "new"
  // and fire a notification — acceptable flap, not a correctness bug.
  const liveStateRows = await db('dashboard_alert_state').select('alert_id');
  for (const row of liveStateRows) {
    if (!currentIds.has(row.alert_id)) {
      await db('dashboard_alert_state').where({ alert_id: row.alert_id }).del();
      cleared += 1;
    }
  }

  return { fired, cleared, current: current.length, skippedConcurrent };
}

module.exports = { runDashboardAlertsCheck };
