/**
 * Auto-dispatch eligibility.
 *
 * `isEligibleForAutoDispatch` is a PURE, synchronous gate over a joined
 * scheduled_services row — recurring-only, valid status, outside the lock
 * window, active customer, not locked/excluded, has usable geo. The one check
 * that needs the DB (is the recurring plan paused/lapsed?) is a separate async
 * helper so the cheap sync gate can reject most rows without a query.
 *
 * Maps to existing Waves concepts:
 *   recurring   = scheduled_services.is_recurring OR recurring_parent_id set
 *   valid status= pending | confirmed | rescheduled (== rebooker RESCHEDULABLE)
 *   customer    = customers.active
 */
const { resolveGeo } = require('./geo');

const VALID_STATUSES = new Set(['pending', 'confirmed', 'rescheduled']);
// Terminal/live statuses → a specific skip reason for the audit trail.
const STATUS_REASON = {
  completed: 'COMPLETED',
  cancelled: 'CANCELLED',
  skipped: 'SKIPPED',
  en_route: 'INVALID_STATUS',
  on_site: 'INVALID_STATUS',
};

function deny(reason_code, reason_description) {
  return { eligible: false, reason_code, reason_description };
}

function isEligibleForAutoDispatch(service, ctx = {}) {
  if (!service) return deny('NOT_FOUND', 'Service row missing');

  const isRecurring = service.is_recurring === true || service.recurring_parent_id != null;
  if (!isRecurring) return deny('NON_RECURRING', 'Not a recurring visit');

  const status = String(service.status || '');
  if (!VALID_STATUSES.has(status)) {
    return deny(STATUS_REASON[status] || 'INVALID_STATUS', `Status '${status}' is not auto-dispatchable`);
  }

  if (service.auto_dispatch_locked === true) return deny('MANUALLY_LOCKED', 'Locked from auto-dispatch by staff');
  if (service.auto_dispatch_excluded === true) return deny('AUTO_DISPATCH_EXCLUDED', 'Excluded from auto-dispatch');

  const dateStr = String(service.scheduled_date || '').split('T')[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return deny('INVALID_DATE', 'Missing/invalid scheduled_date');
  // Lock window is inclusive: anything on or before today+N days is locked.
  if (ctx.lockBoundary && dateStr <= ctx.lockBoundary) {
    return deny('INSIDE_LOCK_WINDOW', `Within ${ctx.lockWindowDays ?? 14}-day lock window (on/before ${ctx.lockBoundary})`);
  }

  // customer_active comes from the LEFT JOIN; null (no customer row) is not a
  // positive churn signal, so only an explicit false skips.
  if (service.customer_active === false) return deny('CUSTOMER_INACTIVE', 'Customer is inactive');

  if (!resolveGeo(service)) return deny('MISSING_GEO', 'No usable latitude/longitude for service or customer');

  return { eligible: true, reason_code: null, reason_description: null };
}

/**
 * Is the recurring plan behind this service still active?
 * Primary signal: an unresolved plan_lapsed/plan_ending alert on this series
 * (joinable directly on recurring_parent_id). Secondary: every one of the
 * customer's subscriptions is paused/cancelled. Both tables are best-effort —
 * a missing table or query error is treated as "active" (fail open: don't block
 * optimization on a bookkeeping gap), never as inactive.
 */
async function isRecurringPlanActive(service, db) {
  const parentId = service.recurring_parent_id || service.id;

  try {
    const alert = await db('recurring_plan_alerts')
      .where('recurring_parent_id', parentId)
      .whereIn('alert_type', ['plan_lapsed', 'plan_ending'])
      .whereNull('resolved_at')
      .first('id', 'alert_type');
    if (alert) {
      return { active: false, reason_code: 'RECURRING_PLAN_INACTIVE', reason_description: `Unresolved ${alert.alert_type} alert on series` };
    }
  } catch (_) { /* table optional — fail open */ }

  try {
    const subs = await db('customer_subscriptions')
      .where('customer_id', service.customer_id)
      .select('status');
    if (subs.length && subs.every((s) => ['paused', 'cancelled'].includes(String(s.status)))) {
      return { active: false, reason_code: 'RECURRING_PLAN_INACTIVE', reason_description: 'All customer subscriptions paused/cancelled' };
    }
  } catch (_) { /* table optional — fail open */ }

  return { active: true, reason_code: null, reason_description: null };
}

module.exports = { isEligibleForAutoDispatch, isRecurringPlanActive, VALID_STATUSES };
