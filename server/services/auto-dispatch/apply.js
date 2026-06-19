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
    old_date: String(service.scheduled_date).split('T')[0],
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
  const preStatus = service.status;
  const newWindow = { start: best.start_time, end: best.end_time };
  const options = {};
  const techChanged = !!best.technician_id
    && String(best.technician_id) !== String(service.technician_id || '');
  if (techChanged) options.technicianId = best.technician_id;

  // Stale-recommendation guard: the row was loaded + scored earlier this run.
  // reschedule() reloads it but only guards status — if staff or another run
  // moved its date/window/tech since, do NOT overwrite that newer placement.
  const fresh = await db('scheduled_services')
    .where({ id: service.id })
    .first('scheduled_date', 'window_start', 'technician_id');
  if (!fresh) {
    throw Object.assign(new Error('Service no longer exists'), { code: 'STALE_PLACEMENT' });
  }
  const norm = (t) => (t ? String(t).slice(0, 5) : null);
  const changed = String(fresh.scheduled_date).split('T')[0] !== String(service.scheduled_date).split('T')[0]
    || norm(fresh.window_start) !== norm(service.window_start)
    || String(fresh.technician_id || '') !== String(service.technician_id || '');
  if (changed) {
    throw Object.assign(new Error('Placement changed since it was scored — skipping stale move'), { code: 'STALE_PLACEMENT' });
  }

  // Canonical move — transactional, overlap-checked, silent.
  await SmartRebooker.reschedule(service.id, best.date, newWindow, 'auto_dispatch', 'auto_dispatch', options);

  // Stamp auto-dispatch bookkeeping. Atomic increment avoids a lost update if
  // two runs (manual + cron) touch the same row before either re-reads it.
  await db('scheduled_services').where({ id: service.id }).update({
    last_auto_dispatch_at: db.fn.now(),
    last_auto_dispatch_run_id: runId,
    auto_dispatch_change_count: db.raw('COALESCE(auto_dispatch_change_count, 0) + 1'),
    updated_at: db.fn.now(),
  });

  let notification = null;
  try {
    notification = await emitAutoDispatchChanged(service, best, runId, config);
  } catch (err) {
    logger.error(`[auto-dispatch] notify hook failed for ${service.id}: ${err.message}`);
  }

  return { ok: true, pre_status: preStatus, post_status: 'confirmed', technician_changed: techChanged, notification };
}

module.exports = { applyAutoDispatchMove, emitAutoDispatchChanged };
