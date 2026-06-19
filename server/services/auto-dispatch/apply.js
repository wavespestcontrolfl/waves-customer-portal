/**
 * Apply an auto-dispatch move.
 *
 * Reuses the canonical reschedule primitive (SmartRebooker.reschedule) — which
 * is transactional, overlap-checked, writes reschedule_log, and (critically)
 * sends NO customer comms by itself. Then stamps the auto-dispatch bookkeeping
 * columns. Customer notification is a deferred hook: per spec, v1 does not text
 * customers automatically — it builds the AppointmentAutoDispatchChanged payload
 * and only logs it, leaving a single place to wire real comms later.
 *
 * Note: reschedule() forces status → 'confirmed' and resets the track token; the
 * pre/post status is returned so the caller can record it in the audit log.
 */
const db = require('../../models/db');
const SmartRebooker = require('../rebooker');
const logger = require('../logger');
const { toDateStr } = require('./dates');

/**
 * Deferred customer-notification hook. Builds the event payload; only attempts a
 * send when config.notifyCustomers is true. v1 keeps the send unwired (logs the
 * intent) so apply mode stays silent and is not coupled to template plumbing.
 */
async function emitAutoDispatchChanged(service, best, runId, config) {
  const payload = {
    event: 'AppointmentAutoDispatchChanged',
    appointment_id: service.id,
    customer_id: service.customer_id,
    old_date: toDateStr(service.scheduled_date),
    old_time_window: service.window_start ? `${service.window_start}-${service.window_end || ''}` : null,
    new_date: best.date,
    new_time_window: `${best.start_time}-${best.end_time}`,
    reason: 'auto_dispatch_optimization',
    auto_dispatch_run_id: runId,
  };
  if (config && config.notifyCustomers) {
    // Intentionally not sending in v1 — the customer-facing reschedule SMS is
    // gated and template-coupled; wire it here when notifications are enabled.
    logger.info(`[auto-dispatch] notify (deferred) ${service.id}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function applyAutoDispatchMove(service, best, runId, config = {}) {
  const newWindow = { start: best.start_time, end: best.end_time };
  const options = {};
  const techChanged = !!best.technician_id
    && String(best.technician_id) !== String(service.technician_id || '');
  if (techChanged) options.technicianId = best.technician_id;

  // Stale-recommendation guard: the row was loaded + scored earlier this run.
  // reschedule() reloads it but only guards status — if staff locked/excluded it
  // or moved its date/window/tech since, do NOT overwrite that newer state.
  const fresh = await db('scheduled_services')
    .where({ id: service.id })
    .first('scheduled_date', 'window_start', 'window_end', 'technician_id', 'status',
      'auto_dispatch_locked', 'auto_dispatch_excluded');
  if (!fresh) {
    throw Object.assign(new Error('Service no longer exists'), { code: 'STALE_PLACEMENT' });
  }
  if (fresh.auto_dispatch_locked === true || fresh.auto_dispatch_excluded === true) {
    throw Object.assign(new Error('Visit was locked/excluded from auto-dispatch after scoring'), { code: 'STALE_PLACEMENT' });
  }
  // A customer reschedule request flips status→'rescheduled' (which the rebooker
  // still treats as movable) without changing the date/window. Require it to
  // still be a live pending/confirmed visit before moving.
  if (!['pending', 'confirmed'].includes(String(fresh.status))) {
    throw Object.assign(new Error(`Visit status changed to '${fresh.status}' after scoring`), { code: 'STALE_PLACEMENT' });
  }
  const norm = (t) => (t ? String(t).slice(0, 5) : null);
  const changed = toDateStr(fresh.scheduled_date) !== toDateStr(service.scheduled_date)
    || norm(fresh.window_start) !== norm(service.window_start)
    || norm(fresh.window_end) !== norm(service.window_end)
    || String(fresh.technician_id || '') !== String(service.technician_id || '');
  if (changed) {
    throw Object.assign(new Error('Placement changed since it was scored — skipping stale move'), { code: 'STALE_PLACEMENT' });
  }

  // Re-assert the operator opt-out flags + original date INSIDE the rebooker's
  // move transaction so a lock/reschedule landing between the read above and the
  // move is caught atomically (0 rows → the rebooker throws 409). These columns
  // are NOT NULL / always-present, so no null-predicate pitfalls.
  options.expect = {
    auto_dispatch_locked: false,
    auto_dispatch_excluded: false,
    status: fresh.status, // original status too — a flip to 'rescheduled' fails the match → 409
    scheduled_date: toDateStr(fresh.scheduled_date),
    // Full original placement too, so a same-date window/tech edit by an operator
    // also fails the atomic match (knex renders null as IS NULL — verified).
    window_start: fresh.window_start,
    window_end: fresh.window_end,
    technician_id: fresh.technician_id,
  };

  // Canonical move — transactional, overlap-checked, silent.
  await SmartRebooker.reschedule(service.id, best.date, newWindow, 'auto_dispatch', 'auto_dispatch', options);

  // reschedule() forces status→'confirmed'. The recurring-lifecycle code counts
  // only PENDING recurring rows for plan-extend / plan_ending, so silently
  // confirming an optimized future visit can make a plan look depleted. Restore
  // pending — but base it on the FRESH status (which options.expect made atomic),
  // NOT the stale scored status, so we don't undo a concurrent operator confirm.
  const postStatus = fresh.status === 'pending' ? 'pending' : 'confirmed';

  // Stamp auto-dispatch bookkeeping (+ restore pending). The move already
  // committed; a stamp failure must NOT flip the result to "failed" (that loses
  // the move in run totals and skips the stability stamp). Best-effort.
  try {
    const stamp = {
      last_auto_dispatch_at: db.fn.now(),
      last_auto_dispatch_run_id: runId,
      auto_dispatch_change_count: db.raw('COALESCE(auto_dispatch_change_count, 0) + 1'),
      updated_at: db.fn.now(),
    };
    if (postStatus === 'pending') stamp.status = 'pending';
    await db('scheduled_services').where({ id: service.id }).update(stamp);
    if (postStatus === 'pending') {
      // The rebooker just logged pending→confirmed; record the compensating
      // confirmed→pending so the job_status_history timeline stays consistent.
      await db('job_status_history').insert({
        job_id: service.id, from_status: 'confirmed', to_status: 'pending', transitioned_by: null,
      });
    }
  } catch (stampErr) {
    logger.error(`[auto-dispatch] post-move bookkeeping stamp failed for ${service.id} (move already applied): ${stampErr.message}`);
  }

  // Keep appointment_reminders aligned with the new date/time — otherwise the
  // 72h/24h reminder cron can still fire for the OLD slot. Non-notifying sync
  // (same as the dispatch reschedule path); best-effort.
  try {
    const AppointmentReminders = require('../appointment-reminders');
    await AppointmentReminders.handleReschedule(
      service.id,
      `${best.date}T${best.start_time || '08:00'}`,
      { sendNotification: false },
    );
  } catch (remErr) {
    logger.warn(`[auto-dispatch] reminder sync failed for ${service.id} (move already applied): ${remErr.message}`);
  }

  let notification = null;
  try {
    notification = await emitAutoDispatchChanged(service, best, runId, config);
  } catch (err) {
    logger.error(`[auto-dispatch] notify hook failed for ${service.id}: ${err.message}`);
  }

  return { ok: true, pre_status: fresh.status, post_status: postStatus, technician_changed: techChanged, notification };
}

module.exports = { applyAutoDispatchMove, emitAutoDispatchChanged };
