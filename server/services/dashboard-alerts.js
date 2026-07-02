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
const { SPEED_TO_LEAD_FRESH_START } = require('../utils/speed-to-lead-fresh-start');
const { NON_ENGAGED_LEAD_STATUSES } = require('./lead-statuses');
const { INTERNAL_TEST_CUSTOMERS } = require('./internal-test-customers');
const { computeMrrBreakdown } = require('./mrr-breakdown');
const { whereLiveCustomer } = require('./customer-stages');
const { autopayActivePredicate } = require('./autopay-eligibility');

// A lead is "waiting" once it has gone this long with no first response.
// Mirrors the Response Speed tile's alert threshold order-of-magnitude but
// fires earlier — 30 minutes is where a same-day booking realistically slips.
const LEAD_RESPONSE_SLA_MINUTES = 30;

// Below this share of live customers on chargeable autopay, the coverage gap
// itself is an action item (manual collection labor + churn risk).
const AUTOPAY_COVERAGE_TARGET_PCT = 50;

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
//   { id, kind: 'action'|'alert', severity: 'critical'|'warn', count, label, href, amount? }
//
// The notification bell adapter (toNotifications below) reshapes these
// into notification-table-shaped objects with `id: 'live:<id>'`,
// `read_at: null`, `created_at: now`.
async function computeDashboardAlertsUncached() {
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
        db.raw('SUM(GREATEST(total - COALESCE(credit_applied, 0), 0)) as amount'),
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
      .whereNull('superseded_by_payment_id')
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

  // 5. Inventory unit cleanup. Bad/missing/ambiguous units undermine
  // forecast, readiness, closeout deduction, restock receiving, and costing.
  try {
    const unitReview = await db('products_catalog')
      .where(function unitIssue() {
        this.where(function missingUnit() {
          this.whereNull('inventory_unit')
            .where(function hasInventoryValue() {
              this.whereNotNull('inventory_on_hand').orWhereNotNull('low_stock_threshold');
            });
        })
          .orWhereRaw("lower(coalesce(inventory_unit, '')) = 'oz'")
          .orWhereRaw(`
            nullif(trim(coalesce(inventory_unit, '')), '') is not null
            AND regexp_replace(lower(replace(trim(inventory_unit), ' ', '_')), 's$', '') NOT IN ('fl_oz','floz','gal','gallon','qt','quart','pt','pint','ml','l','liter','oz','ounce','lb','pound','g','gram','kg')
          `);
      })
      .count('* as count')
      .first();
    const count = parseInt(unitReview?.count || 0);
    if (count > 0) {
      alerts.push({
        id: 'inventory_unit_review',
        severity: 'warn',
        count,
        label: `${count} inventory product${count === 1 ? '' : 's'} need unit review`,
        href: '/admin/inventory?tab=unit-review',
      });
    }
  } catch (err) { logger.error(`[dashboard-alerts] inventory_unit_review: ${err.message}`); }

  // 6. Customers at churn risk per the latest health-score snapshot.
  //    Pulls only the most-recent score per customer so a stale
  //    'critical' score from months ago doesn't keep firing forever.
  try {
    // scored_at is the freshness marker (current rows are updated in place,
    // created_at never moves); 'high' covers the v3 scorer's vocabulary on
    // the same row.
    const atRisk = await db.raw(
      `SELECT COUNT(*) AS c
       FROM (
         SELECT DISTINCT ON (customer_id) customer_id, churn_risk
         FROM customer_health_scores
         ORDER BY customer_id, scored_at DESC NULLS LAST, created_at DESC
       ) latest
       WHERE latest.churn_risk IN ('at_risk', 'critical', 'high')`,
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

  // 7. Persisted admin command-center alerts. These are event-backed
  // operating alerts created by domain workflows such as WaveGuard lawn
  // readiness snapshots.
  try {
    if (await db.schema.hasTable('admin_alerts')) {
      const readiness = await db('admin_alerts')
        .where({ status: 'open', type: 'lawn_protocol_readiness' })
        .orderBy('last_seen_at', 'desc')
        .first('severity', 'title', 'href', 'metadata');
      if (readiness) {
        const metadata = readiness.metadata || {};
        const blocked = Number(metadata?.statusCounts?.blocked || 1);
        alerts.push({
          id: 'admin_lawn_protocol_readiness',
          severity: readiness.severity === 'critical' ? 'critical' : 'warn',
          count: blocked,
          label: readiness.title || `${blocked} WaveGuard lawn appointment${blocked === 1 ? '' : 's'} blocked`,
          href: readiness.href || '/admin/lawn-protocol?tab=readiness',
        });
      }

      const forecast = await db('admin_alerts')
        .where({ status: 'open', type: 'waveguard_inventory_forecast' })
        .orderBy('last_seen_at', 'desc')
        .first('severity', 'title', 'href', 'metadata');
      if (forecast) {
        const metadata = forecast.metadata || {};
        const counts = metadata?.statusCounts || {};
        const count = Number(counts.short || 0)
          + Number(counts.warning || 0)
          + Number(counts.unit_mismatch || 0)
          + Number(counts.not_tracked || 0);
        alerts.push({
          id: 'admin_waveguard_inventory_forecast',
          severity: forecast.severity === 'high' || forecast.severity === 'critical' ? 'critical' : 'warn',
          count: count || 1,
          label: forecast.title || `${count || 1} WaveGuard inventory forecast warning${count === 1 ? '' : 's'}`,
          href: forecast.href || '/admin/inventory?tab=forecast',
        });
      }
    }
  } catch (err) { logger.error(`[dashboard-alerts] admin_lawn_protocol_readiness: ${err.message}`); }

  // ——— Action Inbox generators (kind: 'action') — "do this now" items, as
  // opposed to the watch-state alarms above. Same fail-soft contract: each
  // generator is independently try/caught so one bad query can't blank the rest.

  // 8. Leads still waiting for a first response past the SLA. Mirrors the
  //    Speed-to-Lead backlog definition (routes/admin-leads.js): status='new'
  //    is the sole pre-first-response state, response_time_minutes is stamped
  //    at first response, and first_contact_at is the lead's own inbound
  //    moment. The shared fresh-start floor keeps the pre-reset backlog of
  //    never-answered leads from nagging forever.
  try {
    const waitingQuery = db('leads')
      .where('status', 'new')
      .whereNull('response_time_minutes')
      .whereNotNull('first_contact_at')
      .whereRaw(`first_contact_at <= NOW() - INTERVAL '${LEAD_RESPONSE_SLA_MINUTES} minutes'`);
    if (SPEED_TO_LEAD_FRESH_START) {
      waitingQuery.where('first_contact_at', '>=', SPEED_TO_LEAD_FRESH_START);
    }
    const waiting = await waitingQuery.count('* as count').first();
    const count = parseInt(waiting?.count || 0);
    if (count > 0) {
      alerts.push({
        id: 'leads_awaiting_contact',
        kind: 'action',
        severity: 'critical',
        count,
        label: `${count} lead${count === 1 ? '' : 's'} waiting over ${LEAD_RESPONSE_SLA_MINUTES}m for first contact`,
        href: '/admin/leads',
      });
    }
  } catch (err) { logger.error(`[dashboard-alerts] leads_awaiting_contact: ${err.message}`); }

  // 9. Sent estimates expiring within 3 days — call before the quote dies.
  //    Same exclusions as /sales-capture (archived + internal-test rows out);
  //    value uses the same annualized monthly + one-time formula so the
  //    at-stake dollars match the Sales Capture card's math.
  try {
    const expiringQuery = db('estimates as e')
      .leftJoin('customers as c', 'e.customer_id', 'c.id')
      .whereNull('e.archived_at')
      .whereIn('e.status', ['sent', 'viewed'])
      .whereRaw("e.expires_at >= NOW() AND e.expires_at <= NOW() + INTERVAL '3 days'");
    if (INTERNAL_TEST_CUSTOMERS.length) {
      expiringQuery
        .whereNotIn(db.raw("LOWER(COALESCE(e.customer_name, ''))"), INTERNAL_TEST_CUSTOMERS)
        .whereNotIn(
          db.raw("LOWER(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, ''))"),
          INTERNAL_TEST_CUSTOMERS,
        );
    }
    const expiring = await expiringQuery
      .select(
        db.raw('COUNT(*) as count'),
        db.raw('COALESCE(SUM(COALESCE(e.monthly_total, 0) * 12 + COALESCE(e.onetime_total, 0)), 0) as amount'),
      )
      .first();
    const count = parseInt(expiring?.count || 0);
    if (count > 0) {
      alerts.push({
        id: 'estimates_expiring',
        kind: 'action',
        severity: 'warn',
        count,
        amount: parseFloat(expiring.amount || 0),
        label: `${count} open estimate${count === 1 ? '' : 's'} expiring within 3 days`,
        href: '/admin/estimates',
      });
    }
  } catch (err) { logger.error(`[dashboard-alerts] estimates_expiring: ${err.message}`); }

  // 10. MRR the next billing run can't count on (service-paused, autopay-paused,
  //     overdue, or prepay payment-pending). Reuses the SAME shared breakdown
  //     the MRR hero tile splits on (services/mrr-breakdown.js), so this item
  //     and the tile can never disagree about what "at risk" means.
  try {
    const { atRisk, atRiskCount } = await computeMrrBreakdown();
    if (atRisk > 0) {
      alerts.push({
        id: 'at_risk_mrr',
        kind: 'action',
        severity: 'warn',
        count: atRiskCount,
        amount: atRisk,
        label: `${atRiskCount} recurring account${atRiskCount === 1 ? '' : 's'} with MRR at risk`,
        href: '/admin/billing-recovery',
      });
    }
  } catch (err) { logger.error(`[dashboard-alerts] at_risk_mrr: ${err.message}`); }

  // 11. Autopay coverage below target — every manual-pay account is monthly
  //     collection labor + churn risk. Shares autopayActivePredicate
  //     (billing recovery / core-kpis) and whereLiveCustomer so the coverage
  //     math matches the Autopay Coverage tile exactly.
  try {
    const baseRow = await whereLiveCustomer(db('customers')).count({ c: '*' }).first();
    const base = parseInt(baseRow?.c || 0);
    if (base > 0) {
      const { sql: autopaySql, binding: autopayBinding } = autopayActivePredicate();
      const coveredRow = await whereLiveCustomer(db('customers as c'))
        .whereRaw(autopaySql, [autopayBinding])
        .count({ c: '*' })
        .first();
      const covered = parseInt(coveredRow?.c || 0);
      const pct = Math.round((covered / base) * 100);
      if (pct < AUTOPAY_COVERAGE_TARGET_PCT) {
        const manual = base - covered;
        alerts.push({
          id: 'autopay_coverage_low',
          kind: 'action',
          severity: 'warn',
          count: manual,
          label: `Autopay covers ${pct}% of customers — ${manual} billed manually`,
          href: '/admin/customers',
        });
      }
    }
  } catch (err) { logger.error(`[dashboard-alerts] autopay_coverage_low: ${err.message}`); }

  // 12. Data quality: this week's leads with no lead_source — they render as
  //     'Unknown' in every attribution panel and silently corrupt LTV:CAC.
  //     Complements calls_unmapped_today (which catches un-catalogued NUMBERS;
  //     this catches sourceless LEADS). Same ET-date coercion idiom as #3.
  try {
    const unattributed = await db('leads')
      .whereNull('lead_source_id')
      .whereNotIn('status', NON_ENGAGED_LEAD_STATUSES)
      .whereRaw("created_at >= ((NOW() AT TIME ZONE 'America/New_York')::date - INTERVAL '6 days')")
      .count('* as count')
      .first();
    const count = parseInt(unattributed?.count || 0);
    if (count > 0) {
      alerts.push({
        id: 'leads_unattributed_7d',
        kind: 'action',
        severity: 'warn',
        count,
        label: `${count} lead${count === 1 ? '' : 's'} this week missing a source`,
        href: '/admin/leads',
      });
    }
  } catch (err) { logger.error(`[dashboard-alerts] leads_unattributed_7d: ${err.message}`); }

  // Everything not explicitly tagged above is a passive watch-state alarm; the
  // client separates do-this-now actions from alerts on this field.
  for (const a of alerts) {
    if (!a.kind) a.kind = 'alert';
  }

  return { asOf: today, alerts };
}

// computeDashboardAlerts sits on two hot paths — the dashboard banner (60s
// route-cached) and the bell's /unread-count poll (every 30s per admin,
// UNcached). The generator battery now includes real aggregate work
// (mrr-breakdown's per-customer scan), so memoize the whole result briefly at
// module level; concurrent callers share one in-flight computation. Callers
// about to WRITE against current alert state (dismissals) pass { fresh: true }
// so a stale count is never persisted.
const ALERTS_MEMO_TTL_MS = 30 * 1000;
let alertsMemo = { at: 0, promise: null };
async function computeDashboardAlerts({ fresh = false } = {}) {
  if (!fresh && alertsMemo.promise && Date.now() - alertsMemo.at < ALERTS_MEMO_TTL_MS) {
    return alertsMemo.promise;
  }
  const promise = computeDashboardAlertsUncached();
  alertsMemo = { at: Date.now(), promise };
  try {
    return await promise;
  } catch (err) {
    // Defensive — the uncached fn fail-softs per generator and shouldn't
    // reject, but never cache a rejection if it somehow does.
    alertsMemo = { at: 0, promise: null };
    throw err;
  }
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

module.exports = { computeDashboardAlerts, computeDashboardAlertsUncached, toNotifications };
