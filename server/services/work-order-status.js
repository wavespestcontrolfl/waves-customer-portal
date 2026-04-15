/**
 * Work Order Status Service
 *
 * Centralizes scheduled_service status transitions and writes audit entries
 * to service_status_log. Use this anywhere status changes instead of
 * updating scheduled_services.status directly.
 *
 * Canonical lifecycle:
 *   scheduled → en_route → on_site → in_progress → completed → invoiced → paid
 *                                              ↘ cancelled / rescheduled
 */

const db = require('../models/db');
const logger = require('./logger');

const VALID_STATUSES = [
  'scheduled', 'en_route', 'on_site', 'in_progress',
  'completed', 'invoiced', 'paid', 'cancelled', 'rescheduled',
];

const ALLOWED_TRANSITIONS = {
  scheduled:   ['en_route', 'on_site', 'in_progress', 'cancelled', 'rescheduled'],
  en_route:    ['on_site', 'in_progress', 'cancelled'],
  on_site:     ['in_progress', 'completed', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed:   ['invoiced'],
  invoiced:    ['paid'],
  paid:        [],
  cancelled:   ['scheduled'],
  rescheduled: ['scheduled'],
};

async function transition(scheduledServiceId, nextStatus, { changedBy, reason } = {}) {
  if (!VALID_STATUSES.includes(nextStatus)) {
    throw new Error(`Invalid status: ${nextStatus}`);
  }

  const svc = await db('scheduled_services').where({ id: scheduledServiceId }).first();
  if (!svc) throw new Error(`scheduled_service ${scheduledServiceId} not found`);

  const current = svc.status || 'scheduled';
  const allowed = ALLOWED_TRANSITIONS[current] || [];

  if (current === nextStatus) return { noop: true, current };
  if (!allowed.includes(nextStatus)) {
    throw new Error(`Illegal transition: ${current} → ${nextStatus}`);
  }

  const updates = { status: nextStatus };
  const now = db.fn.now();
  if (nextStatus === 'en_route' && !svc.en_route_at) updates.en_route_at = now;
  if (nextStatus === 'on_site' && !svc.on_site_at) updates.on_site_at = now;
  if (nextStatus === 'in_progress' && !svc.actual_start_time) updates.actual_start_time = now;
  if (nextStatus === 'completed' && !svc.actual_end_time) updates.actual_end_time = now;

  await db('scheduled_services').where({ id: scheduledServiceId }).update(updates);

  try {
    await db('service_status_log').insert({
      scheduled_service_id: scheduledServiceId,
      status: nextStatus,
      changed_by: changedBy || null,
      notes: reason || null,
    });
  } catch (err) {
    // notes column may not exist on older schemas; retry without it
    try {
      await db('service_status_log').insert({
        scheduled_service_id: scheduledServiceId,
        status: nextStatus,
        changed_by: changedBy || null,
      });
    } catch (e) {
      logger.error(`[work-order-status] log failed: ${e.message}`);
    }
  }

  logger.info(`[work-order-status] ${scheduledServiceId}: ${current} → ${nextStatus}`);
  return { previous: current, current: nextStatus };
}

async function getTimeline(scheduledServiceId) {
  const rows = await db('service_status_log')
    .where({ scheduled_service_id: scheduledServiceId })
    .orderBy('created_at', 'asc');
  return rows;
}

module.exports = { transition, getTimeline, VALID_STATUSES, ALLOWED_TRANSITIONS };
