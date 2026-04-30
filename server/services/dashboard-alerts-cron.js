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

// Two-layer overlap guard:
//   1. `isRunning` — process-local fast-path. Skips the trx + lock
//      acquire when we already know we're in flight on this instance.
//   2. `pg_try_advisory_xact_lock` — cross-replica authoritative lock.
//      If Railway scales the portal service to >1 replica (or two
//      different services share the cron schedule), the in-process
//      flag isn't enough; both replicas would tick simultaneously,
//      read the same `dashboard_alert_state` snapshot, both classify
//      the alert as "new", and both fan out push + SMS before either
//      commits state. The advisory lock is held for the entire tick
//      and auto-releases on commit/rollback — no leak risk.
//
// Lock key is hashtext of a stable namespace string so two cron files
// can't collide accidentally.
let isRunning = false;
const ADVISORY_LOCK_SQL = "pg_try_advisory_xact_lock(hashtext('waves:dashboard-alerts-cron'))";

// Single tick: read current alerts + state, fan out notifications, update state.
async function runDashboardAlertsCheck() {
  if (isRunning) {
    logger.info('[dashboard-alerts-cron] previous tick still running in this process, skipping');
    return { fired: 0, cleared: 0, skipped: 'in_process' };
  }
  isRunning = true;
  try {
    return await db.transaction(async (trx) => {
      const lockResult = await trx.raw(`SELECT ${ADVISORY_LOCK_SQL} AS locked`);
      if (!lockResult.rows[0].locked) {
        logger.info('[dashboard-alerts-cron] another replica holds advisory lock, skipping');
        return { fired: 0, cleared: 0, skipped: 'advisory_lock' };
      }
      return runDashboardAlertsCheckInner(trx);
    });
  } finally {
    isRunning = false;
  }
}

async function runDashboardAlertsCheckInner(trx) {
  let current;
  try {
    const result = await computeDashboardAlerts();
    current = result.alerts || [];
  } catch (err) {
    logger.error(`[dashboard-alerts-cron] computeDashboardAlerts failed: ${err.message}`);
    return { fired: 0, cleared: 0, error: err.message };
  }

  const stateRows = await trx('dashboard_alert_state').select('*');
  const stateById = new Map(stateRows.map((r) => [r.alert_id, r]));
  const currentIds = new Set(current.map((a) => a.id));

  let fired = 0, cleared = 0;
  const now = new Date();

  for (const alert of current) {
    const prev = stateById.get(alert.id);
    const isNew = !prev;
    const escalated = prev && alert.count > (prev.last_pushed_count || 0);

    if (isNew || escalated) {
      // Fire push (and SMS for critical) BEFORE updating state, so a
      // failing push doesn't get marked as "last_pushed_at = now."
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
        logger.error(`[dashboard-alerts-cron] triggerNotification failed for ${alert.id}: ${err.message}`);
      }

      if (alert.severity === 'critical') {
        await smsOwner(`Waves alert: ${alert.label}${alert.amount ? ` ($${Math.round(alert.amount).toLocaleString()})` : ''}\n${alert.href}`);
      }

      // Upsert state inside the trx so the advisory lock guards the
      // read-decide-write sequence end-to-end. ON CONFLICT remains as
      // belt-and-suspenders against any pre-existing row (e.g. from a
      // prior crash mid-tick).
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
      fired += 1;
    } else {
      // Same alert still active, count hasn't grown — just heartbeat
      // last_seen_at + current_count so the dashboard's per-admin
      // dismissal logic can compare against an up-to-date count.
      await trx('dashboard_alert_state')
        .where({ alert_id: alert.id })
        .update({ current_count: alert.count, last_seen_at: now });
    }
  }

  // Garbage-collect cleared alerts. Cascade nothing — dismissals for a
  // resolved alert are harmless to keep around (they'll never match
  // again unless the same alert id re-fires).
  for (const stateRow of stateRows) {
    if (!currentIds.has(stateRow.alert_id)) {
      await trx('dashboard_alert_state').where({ alert_id: stateRow.alert_id }).del();
      cleared += 1;
    }
  }

  return { fired, cleared, current: current.length };
}

module.exports = { runDashboardAlertsCheck };
