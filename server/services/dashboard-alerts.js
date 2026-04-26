// Shared module for the operational alerts that surface on the
// dashboard banner AND in the admin notification bell.
//
// These are *state-of-the-world* alarms (not events): observations of
// the current database, recomputed on every read. We don't persist them
// to the `notifications` table because they auto-clear when their
// underlying condition clears (an overdue invoice gets paid → the alert
// disappears on the next render). Persisting them would create
// "phantom" notifications that linger after the condition resolves.
//
// Each alert returns a stable `id` like `live:ar_overdue_60` so the
// caller can detect them and skip the persistence-backed
// mark-as-read flow.

const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');

// Severity → bell-priority mapping. The existing notification_service
// metadata already carries `priority: urgent|high|normal|low` and the
// NotificationBell renders a colored dot based on it.
const SEVERITY_TO_PRIORITY = {
  critical: 'urgent',
  warn: 'high',
  info: 'normal',
};

// Compute the current set of operational alerts. Each entry returns
// only when its count is > 0 — clean day = empty array.
//
// Shape (banner-friendly):
//   { id, severity: 'critical'|'warn', count, label, href, amount? }
//
// The notification bell adapter (toNotifications below) reshapes these
// into notification-table-shaped objects with `id: 'live:<id>'`,
// `read_at: null`, `created_at: now`.
async function computeDashboardAlerts() {
  const today = etDateString();
  const alerts = [];

  // 1. Invoices 60+ days overdue. paid_at IS NULL is the source of truth
  //    (matches /core-kpis AR Days + getOutstandingBalances). Excludes
  //    drafts and voids. Date math anchored to ET so the boundary doesn't
  //    drift at midnight UTC.
  try {
    const overdue60 = await db('invoices')
      .whereNull('paid_at')
      .whereNotIn('status', ['draft', 'void'])
      .whereRaw("due_date < ((NOW() AT TIME ZONE 'America/New_York')::date - INTERVAL '60 days')")
      .select(
        db.raw('COUNT(*) as count'),
        db.raw('SUM(total) as amount'),
      ).first();
    const count = parseInt(overdue60?.count || 0);
    if (count > 0) {
      alerts.push({
        id: 'ar_overdue_60',
        severity: 'critical',
        count,
        amount: parseFloat(overdue60.amount || 0),
        label: `${count} invoice${count === 1 ? '' : 's'} 60+ days overdue`,
        href: '/admin/invoices',
      });
    }
  } catch (err) { logger.error(`[dashboard-alerts] ar_overdue_60: ${err.message}`); }

  // 2. Failed payments today. Operator should see these every login.
  try {
    const failed = await db('payments')
      .where({ status: 'failed' })
      .where('payment_date', today)
      .count('* as count').first();
    const count = parseInt(failed?.count || 0);
    if (count > 0) {
      alerts.push({
        id: 'payments_failed_today',
        severity: 'critical',
        count,
        label: `${count} failed payment${count === 1 ? '' : 's'} today`,
        href: '/admin/invoices',
      });
    }
  } catch (err) { logger.error(`[dashboard-alerts] payments_failed_today: ${err.message}`); }

  // 3. Inbound calls today on numbers we haven't catalogued in
  //    lead_sources. A non-zero count means real customers are dialing
  //    a Twilio number that won't show up attributed in any panel —
  //    fix by adding a row to lead_sources.
  try {
    const unmapped = await db('call_log as c')
      .leftJoin('lead_sources as s', 'c.to_phone', 's.twilio_phone_number')
      .where('c.direction', 'inbound')
      .whereRaw("c.created_at >= ((NOW() AT TIME ZONE 'America/New_York')::date)")
      .whereNull('s.id')
      .countDistinct('c.to_phone as count').first();
    const count = parseInt(unmapped?.count || 0);
    if (count > 0) {
      alerts.push({
        id: 'calls_unmapped_today',
        severity: 'critical',
        count,
        label: `${count} unmapped phone number${count === 1 ? '' : 's'} rang today`,
        href: '/admin/communications',
      });
    }
  } catch (err) { logger.error(`[dashboard-alerts] calls_unmapped_today: ${err.message}`); }

  // 4. Cards expiring in next 7 days. Tighter than billing-health's
  //    60-day window — this is "act this week or autopay breaks."
  //
  //    Cards expire at the END of the printed month (e.g. exp 04/2026
  //    is valid through 2026-04-30). The previous query compared
  //    make_date(year, month, 1) which is the START of the month, so a
  //    card expiring May 31 was incorrectly flagged on April 24 as
  //    "expiring in 7 days." Now we compute the last-day-of-expiry-month
  //    and bound it to a forward window so already-expired cards
  //    (which belong in a different alert) don't pile in either.
  try {
    const expiring = await db('payment_methods')
      .join('customers', 'customers.id', 'payment_methods.customer_id')
      .where('customers.active', true)
      .whereNull('customers.deleted_at')
      .where('customers.autopay_enabled', true)
      .where('payment_methods.autopay_enabled', true)
      .whereRaw(
        "(make_date(payment_methods.exp_year::int, payment_methods.exp_month::int, 1) + INTERVAL '1 month - 1 day')::date "
          + "BETWEEN (NOW() AT TIME ZONE 'America/New_York')::date "
          + "AND ((NOW() AT TIME ZONE 'America/New_York')::date + INTERVAL '7 days')",
      )
      .count('* as count').first()
      .catch(() => ({ count: 0 }));
    const count = parseInt(expiring?.count || 0);
    if (count > 0) {
      alerts.push({
        id: 'cards_expiring_7d',
        severity: 'warn',
        count,
        label: `${count} card${count === 1 ? '' : 's'} expiring in 7 days`,
        href: '/admin/customers',
      });
    }
  } catch (err) { logger.error(`[dashboard-alerts] cards_expiring_7d: ${err.message}`); }

  // 5. Customers at churn risk per the latest health-score snapshot.
  //    Pulls only the most-recent score per customer so a stale
  //    'critical' score from months ago doesn't keep firing forever.
  try {
    const atRisk = await db.raw(
      `SELECT COUNT(*) AS c
       FROM (
         SELECT DISTINCT ON (customer_id) customer_id, churn_risk
         FROM customer_health_scores
         ORDER BY customer_id, created_at DESC
       ) latest
       WHERE latest.churn_risk IN ('at_risk', 'critical')`,
    );
    const count = parseInt(atRisk?.rows?.[0]?.c || 0);
    if (count > 0) {
      alerts.push({
        id: 'churn_at_risk',
        severity: 'warn',
        count,
        label: `${count} customer${count === 1 ? '' : 's'} at churn risk`,
        href: '/admin/customers?view=health',
      });
    }
  } catch (err) { logger.error(`[dashboard-alerts] churn_at_risk: ${err.message}`); }

  return { asOf: today, alerts };
}

// Reshape the alerts array into objects shaped like rows from the
// `notifications` table so the bell endpoint can prepend them onto the
// persisted feed without the renderer needing to know the difference.
//
// `id` is prefixed with `live:` — the renderer must skip the
// mark-as-read API call for these, since they aren't in the DB.
function toNotifications(alerts) {
  const now = new Date();
  return alerts.map((a) => ({
    id: `live:${a.id}`,
    recipient_type: 'admin',
    recipient_id: null,
    category: 'dashboard_alert',
    title: a.label + (a.amount ? ` ($${Math.round(a.amount).toLocaleString()})` : ''),
    body: null,
    icon: null,
    link: a.href,
    metadata: { priority: SEVERITY_TO_PRIORITY[a.severity] || 'normal', live: true, alertId: a.id, count: a.count, amount: a.amount },
    read_at: null,
    created_at: now,
  }));
}

module.exports = { computeDashboardAlerts, toNotifications };
