/**
 * Intelligence Bar — Dashboard & Analytics Tools
 * server/services/intelligence-bar/dashboard-tools.js
 *
 * Gives Claude access to real-time KPIs, period-over-period comparison,
 * pipeline/funnel analysis, and business health metrics.
 */

const db = require('../../models/db');
const { MONTHLY_LANE_SQL } = require('../billing-lane');
const { computeMrrBreakdown } = require('../mrr-breakdown');
const { pendingPrepayIds } = require('../mrr-snapshot');
const logger = require('../logger');
const { whereLiveCustomer, CUSTOMER_STAGES, CONVERSION_DATE_SQL } = require('../customer-stages');
const { etDateString, etMonthStart, etMonthEnd, etQuarterStart, etYearStart, etWeekStart, addETDays, parseETDateTime, validCalendarDate } = require('../../utils/datetime-et');

// Internal/test customers excluded from sales-funnel analytics. Names are
// matched lowercase against both estimates.customer_name (denormalized
// string) and the joined customers row, so a misspelled denormalization
// can't sneak past. Add new names here as they come up.
// Shared so the MRR breakdown + snapshot exclude the same accounts this tool does.
const { INTERNAL_TEST_CUSTOMERS } = require('../internal-test-customers');

// Returns a Knex builder with the standard exclusion applied to a
// query against the `estimates` table aliased as `e`. Use this on every
// funnel-style query so internal test estimates never inflate sales
// metrics. Caller is responsible for the leftJoin to customers as `c`.
function excludeInternalEstimates(qb) {
  if (INTERNAL_TEST_CUSTOMERS.length === 0) return qb;
  return qb
    .whereNotIn(db.raw("LOWER(COALESCE(e.customer_name, ''))"), INTERNAL_TEST_CUSTOMERS)
    .whereNotIn(
      db.raw("LOWER(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, ''))"),
      INTERNAL_TEST_CUSTOMERS,
    );
}

// Same exclusion but for queries against the `customers` table directly
// (alias `c`). Use on customer-acquisition / churn / new-customer counts.
function excludeInternalCustomers(qb) {
  if (INTERNAL_TEST_CUSTOMERS.length === 0) return qb;
  return qb.whereNotIn(
    db.raw("LOWER(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, ''))"),
    INTERNAL_TEST_CUSTOMERS,
  );
}

// Same exclusion for `payments` queries — joins to customers as `c` and
// drops payments tied to a known internal/test customer so revenue
// totals reflect real cash from real prospects.
function excludeInternalPayments(qb) {
  if (INTERNAL_TEST_CUSTOMERS.length === 0) return qb;
  return qb.whereNotIn(
    db.raw("LOWER(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, ''))"),
    INTERNAL_TEST_CUSTOMERS,
  );
}

// ─── Date helpers ───────────────────────────────────────────────

function dateRange(period) {
  const now = new Date();
  const today = etDateString(now);
  const ranges = { today };

  ranges.month_start = etMonthStart(now);
  ranges.month_end = today;

  ranges.last_month_start = etMonthStart(now, -1);
  ranges.last_month_end = etMonthEnd(now, -1);

  // This week (Mon-Sun), ET-anchored
  const mon = etWeekStart(now);
  ranges.week_start = mon;
  ranges.week_end = etDateString(addETDays(parseETDateTime(mon + 'T12:00'), 6));

  // Last week
  ranges.last_week_start = etDateString(addETDays(parseETDateTime(mon + 'T12:00'), -7));
  ranges.last_week_end = etDateString(addETDays(parseETDateTime(mon + 'T12:00'), -1));

  ranges.quarter_start = etQuarterStart(now);
  ranges.quarter_end = today;

  ranges.year_start = etYearStart(now);
  ranges.year_end = today;

  return ranges;
}

const DASHBOARD_TOOLS = [
  {
    name: 'get_kpi_snapshot',
    description: `Get current business KPIs: Revenue MTD, MRR, active customers, new customers, pending estimates, services this week, avg estimate response time, Google review stats, outstanding balances. Use for "how are we doing?" or "give me the numbers."`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'compare_periods',
    description: `Compare two time periods across any metric: revenue, services completed, new customers, estimates sent/accepted, churn. 
Use for "how did we do this week vs last week?", "compare March to February revenue", "is this month better than last month?"
period can be: "this_week", "last_week", "this_month", "last_month", "this_quarter", "ytd", or custom dates.`,
    input_schema: {
      type: 'object',
      properties: {
        period_a: { type: 'string', description: 'First period: this_week, last_week, this_month, last_month, this_quarter, ytd, or YYYY-MM-DD' },
        period_b: { type: 'string', description: 'Second period to compare against (same options)' },
        metrics: {
          type: 'array',
          items: { type: 'string', enum: ['revenue', 'services', 'new_customers', 'estimates_sent', 'estimates_accepted', 'churn', 'all'] },
          description: 'Which metrics to compare. Default: all',
        },
      },
      required: ['period_a', 'period_b'],
    },
  },
  {
    name: 'get_mrr_trend',
    description: `Get Monthly Recurring Revenue trend over time. Shows MRR by month, growth rate, and breakdown by tier. Use for "what's my MRR trend?" or "how has recurring revenue changed?"`,
    input_schema: {
      type: 'object',
      properties: {
        months: { type: 'number', description: 'How many months back to look (default 6)' },
      },
    },
  },
  {
    name: 'get_revenue_breakdown',
    description: `Break down revenue by service type, tier, city/zone, or customer. Use for "where does our revenue come from?" or "what's our biggest service line?"`,
    input_schema: {
      type: 'object',
      properties: {
        group_by: { type: 'string', enum: ['service_type', 'tier', 'city', 'customer', 'month'], description: 'How to group revenue' },
        date_from: { type: 'string', description: 'YYYY-MM-DD start (default: start of current month)' },
        date_to: { type: 'string', description: 'YYYY-MM-DD end (default: today)' },
      },
      required: ['group_by'],
    },
  },
  {
    name: 'get_estimate_funnel',
    description: `Get estimate/sales funnel metrics: sent → viewed → accepted → converted to customer. Shows conversion rates at each stage. Use for "what's our close rate?" or "how's the pipeline?"`,
    input_schema: {
      type: 'object',
      properties: {
        date_from: { type: 'string' },
        date_to: { type: 'string' },
      },
    },
  },
  {
    name: 'get_churn_analysis',
    description: `Analyze customer churn: who churned, when, what tier, estimated revenue lost. Use for "how much churn this month?" or "who did we lose?"`,
    input_schema: {
      type: 'object',
      properties: {
        date_from: { type: 'string' },
        date_to: { type: 'string' },
      },
    },
  },
  {
    name: 'get_service_mix',
    description: `Analyze the service mix: what services are most common, revenue per service type, growth trends. Use for "what's our service breakdown?" or "is lawn care growing?"`,
    input_schema: {
      type: 'object',
      properties: {
        date_from: { type: 'string' },
        date_to: { type: 'string' },
      },
    },
  },
  {
    name: 'get_report_engagement',
    description: `Service-report engagement: of the completed-visit reports SENT to customers in a period (report email via the delivery queue and/or the completion SMS), how many were opened, the open rate, the median minutes from first send to first open, and what customers did inside the report (PDF download, photo opened, map interacted, re-entry timer viewed, review link clicked, referral clicked, add-on requested, follow-up requested, question asked). Split by service line (pest, lawn, tree_shrub, mosquito, termite, rodent, palm; 'unknown' for older records) plus a total row. Use for "are customers opening their reports?", "report open rate", "which service line reads its report least?", "how fast do people open the report?". Defaults to the last 30 days.`,
    input_schema: {
      type: 'object',
      properties: {
        date_from: { type: 'string', description: 'YYYY-MM-DD (ET). Default: 30 days ago' },
        date_to: { type: 'string', description: 'YYYY-MM-DD (ET). Default: today' },
      },
    },
  },
  {
    name: 'get_customer_acquisition',
    description: `Analyze customer acquisition: new customers over time, lead sources, conversion from lead to active. Use for "where are new customers coming from?" or "which lead source converts best?"`,
    input_schema: {
      type: 'object',
      properties: {
        date_from: { type: 'string' },
        date_to: { type: 'string' },
      },
    },
  },
  {
    name: 'get_outstanding_balances',
    description: `Get outstanding balance summary: total owed, overdue invoices, aging breakdown, top debtors. Use for "who owes us money?" or "what's outstanding?"`,
    input_schema: {
      type: 'object',
      properties: {
        min_amount: { type: 'number', description: 'Minimum balance to include (default $0)' },
      },
    },
  },
  {
    name: 'get_payer_ar_aging',
    description: `Get third-party PAYER accounts-receivable aging ("AR by terms"): the outstanding NET-terms statement balance bucketed by days past due (current / 1-15 / 16-30 / 31-45 / 45+), split by terms (net15 / net30), plus the top past-due payers (the collections worklist). This is the BILL-TO/payer AR layer (builders, property managers, HOAs), separate from per-customer self-pay invoices. Use for "payer AR", "AR by terms", "which payers owe us?". Returns zeros until NET-terms statements exist.`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_today_briefing',
    description: `Get a comprehensive daily briefing: today's schedule, unread messages, pending estimates, overdue customers, at-risk accounts, upcoming renewals. Use for "morning briefing" or "what do I need to know today?"`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
];


// ─── EXECUTION ──────────────────────────────────────────────────

async function executeDashboardTool(toolName, input) {
  try {
    switch (toolName) {
      case 'get_kpi_snapshot': return await getKpiSnapshot();
      case 'compare_periods': return await comparePeriods(input);
      case 'get_mrr_trend': return await getMrrTrend(input.months || 6);
      case 'get_revenue_breakdown': return await getRevenueBreakdown(input);
      case 'get_estimate_funnel': return await getEstimateFunnel(input);
      case 'get_churn_analysis': return await getChurnAnalysis(input);
      case 'get_service_mix': return await getServiceMix(input);
      case 'get_report_engagement': return await getReportEngagement(input);
      case 'get_customer_acquisition': return await getCustomerAcquisition(input);
      case 'get_outstanding_balances': return await getOutstandingBalances(input);
      case 'get_payer_ar_aging': return await getPayerArAging();
      case 'get_today_briefing': return await getTodayBriefing();
      default: return { error: `Unknown dashboard tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:dashboard] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}


// ─── IMPLEMENTATIONS ────────────────────────────────────────────

async function getKpiSnapshot() {
  const r = dateRange();

  const [revMTD, revLastMonth, activeCount, newCount, pendingEst, servicesWeek, mrr, balances, healthDist] = await Promise.all([
    db('payments').where({ status: 'paid' }).whereBetween('payment_date', [r.month_start, r.month_end]).sum('amount as total').first(),
    db('payments').where({ status: 'paid' }).whereBetween('payment_date', [r.last_month_start, r.last_month_end]).sum('amount as total').first(),
    // Real customers only — active=true defaults true for leads, so match the
    // dashboard tile's pipeline_stage filter (whereLiveCustomer) instead of
    // counting prospects. Keeps the IB answer consistent with the tile.
    db('customers').modify(whereLiveCustomer).count('* as c').first(),
    // New customers this month = conversion date (member_since, an ET DATE) in
    // the window — matches the dashboard tile.
    db('customers').modify(whereLiveCustomer)
      .whereRaw(`${CONVERSION_DATE_SQL} >= ?`, [r.month_start])
      .count('* as c').first(),
    // archived_at: the conversion-guard sweep archives converted customers'
    // estimates WITHOUT changing status, so status alone over-counts.
    db('estimates').whereIn('status', ['sent', 'viewed']).whereNull('archived_at').count('* as c').first(),
    db('scheduled_services').whereBetween('scheduled_date', [r.week_start, r.week_end]).select(
      db.raw("COUNT(*) as total"),
      db.raw("COUNT(*) FILTER (WHERE status = 'completed') as completed"),
    ).first(),
    // Headline MRR = the shared breakdown (monthly lane ∪ payment-pending
    // prepay, internal excluded) — one definition with the dashboard tile and
    // the snapshot, so the IB answer can't sit below them while an annual
    // invoice awaits payment (Codex #3669 r3).
    computeMrrBreakdown(db),
    // Source-of-truth filter for "outstanding" — paid_at IS NULL and not
    // a draft/void. Mirrors the cleaner pattern used by /core-kpis AR
    // Days; the prior status whitelist would silently drop any new
    // status (e.g. 'in_collections') that gets added later.
    // `overdue` is computed from due_date < today (ET) instead of
    // trusting the `status='overdue'` string, which only flips when a
    // cron flips it.
    db('invoices')
      .whereNull('paid_at')
      .whereNotIn('status', ['draft', 'void'])
      .select(
        db.raw('SUM(GREATEST(total - COALESCE(credit_applied, 0), 0)) as total_owed'),
        db.raw("SUM(CASE WHEN due_date < (NOW() AT TIME ZONE 'America/New_York')::date THEN GREATEST(total - COALESCE(credit_applied, 0), 0) ELSE 0 END) as overdue"),
        db.raw('COUNT(*) as count'),
      ).first(),
    // Latest per customer keys on scored_at (current rows are updated in
    // place, so created_at never moves); created_at is the tie/null fallback.
    db('customer_health_scores as h')
      .join(db.raw("(SELECT customer_id, MAX(COALESCE(scored_at, created_at)) as max_scored FROM customer_health_scores GROUP BY customer_id) latest ON h.customer_id = latest.customer_id AND COALESCE(h.scored_at, h.created_at) = latest.max_scored"))
      // Archived customers keep their score rows — scope like the MRR/active counts above.
      .whereNotExists(function () { this.select(1).from('customers as ac').whereRaw('ac.id = h.customer_id').whereNotNull('ac.deleted_at'); })
      .select('h.churn_risk', db.raw('COUNT(*) as count')).groupBy('h.churn_risk'),
  ]);

  const revMTDVal = parseFloat(revMTD?.total || 0);
  const revLMVal = parseFloat(revLastMonth?.total || 0);
  const mrrVal = parseFloat(mrr?.total || 0);

  const healthMap = {};
  healthDist.forEach(h => { healthMap[h.churn_risk] = parseInt(h.count); });

  return {
    revenue_mtd: revMTDVal,
    revenue_last_month: revLMVal,
    revenue_change_pct: revLMVal > 0 ? Math.round((revMTDVal - revLMVal) / revLMVal * 100) : null,
    mrr: mrrVal,
    arr_estimate: mrrVal * 12,
    active_customers: parseInt(activeCount?.c || 0),
    new_customers_this_month: parseInt(newCount?.c || 0),
    estimates_pending: parseInt(pendingEst?.c || 0),
    services_this_week: {
      total: parseInt(servicesWeek?.total || 0),
      completed: parseInt(servicesWeek?.completed || 0),
    },
    outstanding_balances: {
      total_owed: parseFloat(balances?.total_owed || 0),
      overdue: parseFloat(balances?.overdue || 0),
      invoice_count: parseInt(balances?.count || 0),
    },
    customer_health: healthMap,
    period: { month_start: r.month_start, today: r.today },
  };
}


async function comparePeriods(input) {
  const { period_a, period_b, metrics = ['all'] } = input;
  const r = dateRange();
  const wantAll = metrics.includes('all');

  function resolvePeriod(p) {
    switch (p) {
      case 'this_week': return { from: r.week_start, to: r.week_end, label: 'This week' };
      case 'last_week': return { from: r.last_week_start, to: r.last_week_end, label: 'Last week' };
      case 'this_month': return { from: r.month_start, to: r.month_end, label: 'This month' };
      case 'last_month': return { from: r.last_month_start, to: r.last_month_end, label: 'Last month' };
      case 'this_quarter': return { from: r.quarter_start, to: r.quarter_end, label: 'This quarter' };
      case 'ytd': return { from: r.year_start, to: r.year_end, label: 'YTD' };
      default:
        if (p && p.match(/^\d{4}-\d{2}$/)) {
          const [y, m] = p.split('-').map(Number);
          const start = `${y}-${String(m).padStart(2, '0')}-01`;
          const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
          const end = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
          return { from: start, to: end, label: parseETDateTime(`${y}-${String(m).padStart(2, '0')}-15T12:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'America/New_York' }) };
        }
        return { from: p, to: p, label: p };
    }
  }

  const a = resolvePeriod(period_a);
  const b = resolvePeriod(period_b);

  // Each metric query mirrors the funnel-fix discipline applied in
  // PR #247:
  //   - Use the *event* timestamp, not created_at (sent_at, accepted_at,
  //     payment_date, etc.). An estimate created Apr 5 and sent Apr 25
  //     belongs to the Apr-25 window, not Apr-5.
  //   - Filter out drafts / cancelled / void rows that aren't real
  //     business events.
  //   - Exclude INTERNAL_TEST_CUSTOMERS (Adam Martinez et al.) so test
  //     activity can't skew period-over-period deltas.
  async function getMetrics(from, to) {
    const fromTs = `${from}T00:00:00`;
    const toTs = `${to}T23:59:59`;
    const m = {};
    if (wantAll || metrics.includes('revenue')) {
      const rev = await excludeInternalPayments(
        db({ p: 'payments' })
          .leftJoin({ c: 'customers' }, 'p.customer_id', 'c.id')
          .where('p.status', 'paid')
          .whereBetween('p.payment_date', [from, to])
      ).sum('p.amount as total').first();
      m.revenue = parseFloat(rev?.total || 0);
    }
    if (wantAll || metrics.includes('services')) {
      const svc = await db('scheduled_services')
        .whereBetween('scheduled_date', [from, to])
        .whereNotIn('status', ['cancelled'])
        .select(
          db.raw("COUNT(*) as total"),
          db.raw("COUNT(*) FILTER (WHERE status = 'completed') as completed"),
        ).first();
      m.services_total = parseInt(svc?.total || 0);
      m.services_completed = parseInt(svc?.completed || 0);
    }
    if (wantAll || metrics.includes('new_customers')) {
      const nc = await excludeInternalCustomers(
        db({ c: 'customers' })
          .where('c.active', true)
          .whereNull('c.deleted_at')
          .whereIn('c.pipeline_stage', CUSTOMER_STAGES)
          // Conversion date, same source of truth as the KPI snapshot.
          .whereRaw(`${CONVERSION_DATE_SQL} >= ?`, [from]).whereRaw(`${CONVERSION_DATE_SQL} <= ?`, [to])
      ).count('* as count').first();
      m.new_customers = parseInt(nc?.count || 0);
    }
    if (wantAll || metrics.includes('estimates_sent')) {
      const es = await excludeInternalEstimates(
        db({ e: 'estimates' })
          .leftJoin({ c: 'customers' }, 'e.customer_id', 'c.id')
          .whereNotNull('e.sent_at')
          .whereBetween('e.sent_at', [fromTs, toTs])
          // plan_restart sent_at is a synthetic publish stamp (the
          // customer self-served the quote; nothing was delivered) — it
          // is not an estimate SENT (codex GH r19 P1 on #3671) UNLESS an
          // operator later really delivered it: the admin send path stamps
          // deliveryState.firstDeliveredAt, the same real-delivery witness
          // estimate-source-performance counts for this source (r26 P2).
          // NULL-aware (r20 P2): legacy rows carry source NULL, which a
          // bare <> would drop from the count.
          .where(function notUndeliveredPlanRestart() {
            this.whereNull('e.source').orWhereNot('e.source', 'plan_restart')
              .orWhereRaw("(e.estimate_data #>> '{deliveryState,firstDeliveredAt}') IS NOT NULL");
          })
      ).count('* as count').first();
      m.estimates_sent = parseInt(es?.count || 0);
    }
    if (wantAll || metrics.includes('estimates_accepted')) {
      const ea = await excludeInternalEstimates(
        db({ e: 'estimates' })
          .leftJoin({ c: 'customers' }, 'e.customer_id', 'c.id')
          .where('e.status', 'accepted')
          .whereBetween('e.accepted_at', [fromTs, toTs])
      ).count('* as count').first();
      m.estimates_accepted = parseInt(ea?.count || 0);
    }
    if (wantAll || metrics.includes('churn')) {
      const ch = await excludeInternalCustomers(
        db({ c: 'customers' })
          .where('c.active', false)
          .whereNull('c.deleted_at')
          .whereRaw('COALESCE(c.churned_at, c.updated_at) BETWEEN ? AND ?', [fromTs, toTs])
      ).count('* as count').first();
      m.churned = parseInt(ch?.count || 0);
    }
    return m;
  }

  const [metricsA, metricsB] = await Promise.all([getMetrics(a.from, a.to), getMetrics(b.from, b.to)]);

  // Calculate changes
  const changes = {};
  for (const key of Object.keys(metricsA)) {
    const va = metricsA[key];
    const vb = metricsB[key];
    changes[key] = {
      period_a: va,
      period_b: vb,
      delta: va - vb,
      pct_change: vb > 0 ? Math.round((va - vb) / vb * 100) : null,
    };
  }

  return {
    period_a: { ...a, metrics: metricsA },
    period_b: { ...b, metrics: metricsB },
    changes,
  };
}


async function getMrrTrend(months) {
  const now = new Date();
  const windows = [];
  for (let i = months - 1; i >= 0; i--) {
    // Walk back i ET calendar months from now; anchor each window at ET midnight.
    const startDay = etMonthStart(now, -i);
    const endDay = etMonthEnd(now, -i);
    const d = parseETDateTime(`${startDay}T00:00`);
    const monthEnd = parseETDateTime(`${endDay}T23:59:59`);
    windows.push({
      start: d,
      end: monthEnd,
      startDay,
      label: d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'America/New_York' }),
    });
  }

  // Real recorded MRR per month (point-in-time snapshots). A past month reads
  // its snapshot's actual MRR; the current (in-progress) month and any month
  // recorded before snapshots existed fall back to the live recompute below
  // (which dates the right customers but at today's prices AND today's
  // billing lane — the customers row is current-state, so the fallback is a
  // current-state approximation either way; snapshots are the point-in-time
  // record that replaces it going forward). The lane predicate is applied to
  // the fallback for BOTH cases deliberately: without it, per-visit / prepay
  // / per-application rows that merely carry a monthly_rate inflate the
  // recomputed months — the exact #3140 distortion — and current lane is no
  // less historical than the current rate the same query already sums.
  const currentMonthStart = etMonthStart(now);
  const { LANE_DEFINITION_BOUNDARY } = require('../mrr-bridge');
  const snapshotsByMonth = {};
  try {
    const snaps = await db('mrr_snapshots').whereIn('period_month', windows.map(w => w.startDay));
    for (const s of snaps) {
      const key = s.period_month instanceof Date
        ? s.period_month.toISOString().slice(0, 10)
        : String(s.period_month).slice(0, 10);
      snapshotsByMonth[key] = s;
    }
  } catch (err) {
    logger.warn(`[mrr-trend] snapshot read failed, using live recompute: ${err.message}`);
  }

  function parseTier(v) {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return []; } }
    return [];
  }

  // Payment-pending annual-prepay ids: those customers sit on billing_mode
  // 'per_application' until the prepay invoice is PAID, so the lane predicate
  // alone would drop them from the CURRENT-month recompute while the
  // completed-month snapshots and the live headline (computeMrrBreakdown)
  // both union them — the chart's current point would sit below both sources
  // whenever an annual invoice awaits payment (Codex #3669 r3 P1). The union
  // is TODAY's transient set, so it applies only to the current window — a
  // historical fallback month gets the plain lane predicate, or today's
  // pending customers would inflate months they weren't pending (or even
  // prepay) in (Codex r4). A FAILED lookup (null) degrades to no union on
  // this read surface — the chart heals on the next request; the snapshot
  // WRITER, unlike this, refuses to persist on a failed lookup (r14).
  const pendingIds = (await pendingPrepayIds(db)) || [];

  function customersActiveAsOf(endIso, { includePendingUnion = false } = {}) {
    const unionIds = includePendingUnion ? pendingIds : [];
    return excludeInternalCustomers(
      db({ c: 'customers' })
        .where('c.created_at', '<=', endIso)
        .where('c.monthly_rate', '>', 0)
        // Monthly LANE, not merely rate-bearing (#3140) — see fallback note
        // above. Pending-prepay union per the note on pendingIds.
        .where(function laneOrPendingPrepay() { this.whereRaw(MONTHLY_LANE_SQL); if (unionIds.length) this.orWhereIn('c.id', unionIds); })
        .where(function () {
          this.where('c.active', true).orWhereNotNull('c.churned_at');
        })
        .where(function () {
          this.whereNull('c.deleted_at').orWhere('c.deleted_at', '>', endIso);
        })
        .where(function () {
          this.whereNull('c.churned_at').orWhere('c.churned_at', '>', endIso);
        }),
    );
  }

  // Batch: one query per month, all in parallel (instead of sequential awaits)
  const settled = await Promise.all(windows.map(async w => {
    // Use the snapshot for any COMPLETED month that has one; recompute the
    // current month live (snapshots only freeze at month rollover) — UNLESS
    // the current month predates the lane-definition boundary (deploy lands
    // mid-month): its snapshot is the old wide population and the writer
    // deliberately leaves it that way (recordMrrSnapshot pre-boundary skip),
    // so recomputing it narrow here would put the population step INSIDE
    // the pre-boundary series. Prefer the wide snapshot; the boundary month
    // is then deterministically the first narrow point (Codex #3669 r14).
    const currentIsPreBoundary = currentMonthStart < LANE_DEFINITION_BOUNDARY;
    const snap = (w.startDay !== currentMonthStart || currentIsPreBoundary)
      ? snapshotsByMonth[w.startDay]
      : null;
    if (snap) {
      return {
        month: w.label,
        date: w.startDay,
        mrr: parseFloat(snap.total_mrr || 0),
        committed_mrr: parseFloat(snap.committed_mrr || 0),
        at_risk_mrr: parseFloat(snap.at_risk_mrr || 0),
        customer_count: parseInt(snap.customer_count || 0),
        by_tier: parseTier(snap.by_tier),
        source: 'snapshot',
      };
    }
    const endIso = w.end.toISOString();
    const isCurrentMonth = w.startDay === currentMonthStart;
    const [mrrRow, byTier] = await Promise.all([
      customersActiveAsOf(endIso, { includePendingUnion: isCurrentMonth })
        .select(
          db.raw('SUM(c.monthly_rate) as mrr'),
          db.raw('COUNT(*) as customer_count'),
        ).first(),
      customersActiveAsOf(endIso, { includePendingUnion: isCurrentMonth })
        .select('c.waveguard_tier', db.raw('SUM(c.monthly_rate) as mrr'), db.raw('COUNT(*) as count'))
        .groupBy('c.waveguard_tier'),
    ]);
    return {
      month: w.label,
      date: w.startDay,
      mrr: parseFloat(mrrRow?.mrr || 0),
      committed_mrr: null,
      at_risk_mrr: null,
      customer_count: parseInt(mrrRow?.customer_count || 0),
      by_tier: byTier.map(t => ({ tier: t.waveguard_tier || 'None', mrr: parseFloat(t.mrr || 0), count: parseInt(t.count) })),
      source: 'computed',
    };
  }));

  const results = settled;

  // Growth rates. Never computed across the lane-definition boundary
  // (#3669, Codex r8+r14): pre-boundary points hold the old wide
  // population — guaranteed on BOTH deploy timings, because the writer
  // skips pre-boundary snapshot writes and the recompute above prefers a
  // pre-boundary current month's wide snapshot. Exactly one pair crosses
  // (into the boundary month); it reads null and drops out of
  // avg_growth_pct, which already skips nulls. Same rule and constant as
  // the Net MRR bridge.
  for (let i = 1; i < results.length; i++) {
    const prev = results[i - 1];
    const crossesLaneBoundary = prev.date < LANE_DEFINITION_BOUNDARY && results[i].date >= LANE_DEFINITION_BOUNDARY;
    results[i].growth_pct = (!crossesLaneBoundary && prev.mrr > 0)
      ? Math.round((results[i].mrr - prev.mrr) / prev.mrr * 100)
      : null;
  }

  return {
    trend: results,
    current_mrr: results[results.length - 1]?.mrr || 0,
    current_arr: (results[results.length - 1]?.mrr || 0) * 12,
    avg_growth_pct: results.filter(r => r.growth_pct != null).length > 0
      ? Math.round(results.filter(r => r.growth_pct != null).reduce((s, r) => s + r.growth_pct, 0) / results.filter(r => r.growth_pct != null).length)
      : null,
  };
}


async function getRevenueBreakdown(input) {
  const { group_by, date_from, date_to } = input;
  const r = dateRange();
  const from = date_from || r.month_start;
  const to = date_to || r.today;

  if (group_by === 'service_type') {
    const rows = await db('service_records')
      .whereBetween('service_date', [from, to])
      .where('status', 'completed')
      .select('service_type', db.raw('COUNT(*) as count'), db.raw('SUM(COALESCE(revenue, 0)) as revenue'))
      .groupBy('service_type').orderByRaw('SUM(COALESCE(revenue, 0)) DESC');
    return { group_by, period: { from, to }, rows: rows.map(r => ({ service_type: r.service_type, count: parseInt(r.count), revenue: parseFloat(r.revenue || 0) })) };
  }

  if (group_by === 'tier') {
    // Archived (soft-deleted) customers keep active=true — scope on deleted_at like whereLiveCustomer (services/customer-stages.js).
    const rows = await db('customers').where({ active: true }).whereNull('deleted_at')
      .select('waveguard_tier', db.raw('COUNT(*) as count'), db.raw('SUM(monthly_rate) as mrr'))
      .groupBy('waveguard_tier').orderByRaw('SUM(monthly_rate) DESC');
    return { group_by, rows: rows.map(r => ({ tier: r.waveguard_tier || 'None', count: parseInt(r.count), mrr: parseFloat(r.mrr || 0), arr: parseFloat(r.mrr || 0) * 12 })) };
  }

  if (group_by === 'city') {
    const rows = await db('customers').where({ active: true }).whereNull('deleted_at').whereNotNull('city').where('city', '!=', '')
      .select('city', db.raw('COUNT(*) as count'), db.raw('SUM(monthly_rate) as mrr'))
      .groupBy('city').orderByRaw('SUM(monthly_rate) DESC');
    return { group_by, rows: rows.map(r => ({ city: r.city, count: parseInt(r.count), mrr: parseFloat(r.mrr || 0) })) };
  }

  if (group_by === 'customer') {
    const rows = await db('payments').where({ status: 'paid' }).whereNull('payments.payer_id').whereBetween('payment_date', [from, to])
      .leftJoin('customers', 'payments.customer_id', 'customers.id')
      .select('customers.id', 'customers.first_name', 'customers.last_name', 'customers.waveguard_tier',
        db.raw('SUM(payments.amount) as total'), db.raw('COUNT(*) as payments'))
      .groupBy('customers.id', 'customers.first_name', 'customers.last_name', 'customers.waveguard_tier')
      .orderByRaw('SUM(payments.amount) DESC').limit(20);
    return { group_by, period: { from, to }, rows: rows.map(r => ({ id: r.id, name: `${r.first_name} ${r.last_name}`, tier: r.waveguard_tier, total: parseFloat(r.total || 0), payments: parseInt(r.payments) })) };
  }

  if (group_by === 'month') {
    const rows = await db('payments').where({ status: 'paid' }).whereBetween('payment_date', [from, to])
      .select(db.raw("TO_CHAR(payment_date, 'YYYY-MM') as month"), db.raw('SUM(amount) as total'), db.raw('COUNT(*) as payments'))
      .groupByRaw("TO_CHAR(payment_date, 'YYYY-MM')").orderByRaw("TO_CHAR(payment_date, 'YYYY-MM')");
    return { group_by, rows: rows.map(r => ({ month: r.month, total: parseFloat(r.total || 0), payments: parseInt(r.payments) })) };
  }

  return { error: 'Invalid group_by' };
}


async function getEstimateFunnel(input) {
  const r = dateRange();
  const from = input.date_from || r.month_start;
  const to = input.date_to || r.today;
  const fromTs = `${from}T00:00:00`;
  const toTs = `${to}T23:59:59`;

  // Each stage counts estimates whose stage *transition* timestamp
  // (sent_at / viewed_at / accepted_at / declined_at) falls in the
  // window — NOT created_at. The previous version counted draft rows
  // (status defaults to 'draft' on insert), which inflated the "Sent"
  // bucket with estimates the operator only started but never delivered.
  //
  // INTERNAL_TEST_CUSTOMERS are excluded at every stage via the
  // excludeInternalEstimates helper so funnel/close-rate metrics
  // reflect real prospect activity only.
  function stageQuery(stageColumn, status) {
    let qb = db({ e: 'estimates' })
      .leftJoin({ c: 'customers' }, 'e.customer_id', 'c.id')
      .whereNotNull(`e.${stageColumn}`)
      .whereBetween(`e.${stageColumn}`, [fromTs, toTs]);
    if (status) qb = qb.where('e.status', status);
    return excludeInternalEstimates(qb);
  }

  const [sent, viewed, accepted, declined] = await Promise.all([
    stageQuery('sent_at').count('* as c').first(),
    stageQuery('viewed_at').count('* as c').first(),
    stageQuery('accepted_at', 'accepted').count('* as c').first(),
    stageQuery('declined_at', 'declined').count('* as c').first(),
  ]);

  const totalSent = parseInt(sent?.c || 0);
  const totalViewed = parseInt(viewed?.c || 0);
  const totalAccepted = parseInt(accepted?.c || 0);
  const totalDeclined = parseInt(declined?.c || 0);

  const avgResponse = await excludeInternalEstimates(
    db({ e: 'estimates' })
      .leftJoin({ c: 'customers' }, 'e.customer_id', 'c.id')
      .where('e.status', 'accepted')
      .whereBetween('e.accepted_at', [fromTs, toTs])
      .whereNotNull('e.sent_at')
  ).select(db.raw("AVG(EXTRACT(EPOCH FROM (e.accepted_at - e.sent_at)) / 3600) as avg_hrs")).first();

  const totalValue = await excludeInternalEstimates(
    db({ e: 'estimates' })
      .leftJoin({ c: 'customers' }, 'e.customer_id', 'c.id')
      .where('e.status', 'accepted')
      .whereBetween('e.accepted_at', [fromTs, toTs])
  ).select(db.raw('COALESCE(SUM(COALESCE(e.monthly_total,0) + COALESCE(e.onetime_total,0)), 0) as total')).first();

  // What leads asked for: the window's SENT cohort grouped by the free-text
  // service_interest captured at estimate creation, each row carrying the
  // cohort's current outcome (won / lost / still open). Cohort semantics on
  // purpose — the question is "of the estimates we sent, what services were
  // they for and how are they closing", not stage-transition volume like the
  // funnel above (an estimate sent last week and accepted today counts in ITS
  // sent-week cohort, not today's).
  //
  // lost = declined OR expired — expired is a terminal loss everywhere else
  // (sales-capture's won/lost semantics above; EstimatePage stats), so a dead
  // estimate must not read as still-open follow-up work here. Archived rows
  // are excluded entirely: the conversion-guard sweep archives WITHOUT
  // changing status, so without the filter they'd re-inflate service demand
  // (same reason the pending-estimates KPI filters archived_at).
  const SERVICE_KEY_SQL = "COALESCE(NULLIF(TRIM(e.service_interest), ''), 'Unspecified')";
  const byService = await excludeInternalEstimates(
    db({ e: 'estimates' })
      .leftJoin({ c: 'customers' }, 'e.customer_id', 'c.id')
      .whereNotNull('e.sent_at')
      .whereNull('e.archived_at')
      .whereBetween('e.sent_at', [fromTs, toTs])
  )
    .select(
      db.raw(`${SERVICE_KEY_SQL} as service`),
      db.raw('COUNT(*) as sent'),
      db.raw("COUNT(*) FILTER (WHERE e.status = 'accepted') as won"),
      db.raw("COUNT(*) FILTER (WHERE e.status IN ('declined', 'expired')) as lost"),
      db.raw("COALESCE(SUM(COALESCE(e.monthly_total,0) + COALESCE(e.onetime_total,0)) FILTER (WHERE e.status = 'accepted'), 0) as won_value"),
    )
    .groupBy(db.raw(SERVICE_KEY_SQL))
    .orderByRaw('COUNT(*) DESC')
    .limit(8);

  // Open follow-up work: the window's sent cohort still undecided RIGHT NOW
  // (status sent/viewed, not archived). A direct count — the old
  // sent−accepted−declined arithmetic mixed stage-transition windows, so a
  // period with carry-over wins/losses could go negative or understate the
  // live pipeline.
  const openNow = await excludeInternalEstimates(
    db({ e: 'estimates' })
      .leftJoin({ c: 'customers' }, 'e.customer_id', 'c.id')
      .whereNotNull('e.sent_at')
      .whereNull('e.archived_at')
      .whereBetween('e.sent_at', [fromTs, toTs])
      .whereIn('e.status', ['sent', 'viewed'])
  ).count('* as c').first();

  return {
    period: { from, to },
    funnel: {
      sent: totalSent,
      viewed: totalViewed,
      accepted: totalAccepted,
      declined: totalDeclined,
      // Current open follow-ups from this window's sent cohort — NOT
      // sent−accepted−declined (those are per-stage transition counts whose
      // windows don't share a cohort; the subtraction could go negative).
      pending: parseInt(openNow?.c || 0, 10),
    },
    by_service: byService.map((r) => ({
      service: r.service,
      sent: parseInt(r.sent, 10),
      won: parseInt(r.won, 10),
      lost: parseInt(r.lost, 10),
      open: parseInt(r.sent, 10) - parseInt(r.won, 10) - parseInt(r.lost, 10),
      wonValue: parseFloat(r.won_value) || 0,
    })),
    rates: {
      view_rate: totalSent > 0 ? Math.round(totalViewed / totalSent * 100) : 0,
      close_rate: totalSent > 0 ? Math.round(totalAccepted / totalSent * 100) : 0,
      decline_rate: totalSent > 0 ? Math.round(totalDeclined / totalSent * 100) : 0,
    },
    avg_response_hours: parseFloat(avgResponse?.avg_hrs || 0).toFixed(1),
    total_accepted_value: parseFloat(totalValue?.total || 0),
    excluded_internal_customers: INTERNAL_TEST_CUSTOMERS,
  };
}


async function getChurnAnalysis(input) {
  const r = dateRange();
  const from = input.date_from || r.month_start;
  const to = input.date_to || r.today;

  const churned = await db('customers')
    .where({ active: false })
    .whereRaw('COALESCE(churned_at, updated_at) BETWEEN ? AND ?', [from, to + 'T23:59:59'])
    .select('id', 'first_name', 'last_name', 'waveguard_tier', 'monthly_rate', 'city', 'member_since', 'updated_at', 'churned_at', 'lead_source')
    .orderBy('monthly_rate', 'desc');

  const totalLostMRR = churned.reduce((s, c) => s + parseFloat(c.monthly_rate || 0), 0);
  const byTier = {};
  churned.forEach(c => {
    const tier = c.waveguard_tier || 'None';
    if (!byTier[tier]) byTier[tier] = { count: 0, mrr_lost: 0 };
    byTier[tier].count++;
    byTier[tier].mrr_lost += parseFloat(c.monthly_rate || 0);
  });

  return {
    period: { from, to },
    total_churned: churned.length,
    total_mrr_lost: totalLostMRR,
    total_arr_lost: totalLostMRR * 12,
    by_tier: byTier,
    customers: churned.map(c => ({
      id: c.id,
      name: `${c.first_name} ${c.last_name}`,
      tier: c.waveguard_tier,
      monthly_rate: parseFloat(c.monthly_rate || 0),
      city: c.city,
      member_since: c.member_since,
      churned_at: c.updated_at,
    })),
  };
}


async function getServiceMix(input) {
  const r = dateRange();
  const from = input.date_from || r.month_start;
  const to = input.date_to || r.today;

  const mix = await db('service_records')
    .whereBetween('service_date', [from, to])
    .where('status', 'completed')
    .select(
      db.raw("CASE WHEN service_type ILIKE '%pest%' THEN 'Pest Control' WHEN service_type ILIKE '%lawn%' OR service_type ILIKE '%turf%' THEN 'Lawn Care' WHEN service_type ILIKE '%mosquito%' THEN 'Mosquito' WHEN service_type ILIKE '%termite%' THEN 'Termite' WHEN service_type ILIKE '%tree%' OR service_type ILIKE '%shrub%' THEN 'Tree & Shrub' WHEN service_type ILIKE '%rodent%' THEN 'Rodent' ELSE 'Other' END as category"),
      db.raw('COUNT(*) as service_count'),
      db.raw('SUM(COALESCE(revenue, 0)) as revenue'),
      db.raw('COUNT(DISTINCT customer_id) as unique_customers'),
    )
    .groupByRaw("CASE WHEN service_type ILIKE '%pest%' THEN 'Pest Control' WHEN service_type ILIKE '%lawn%' OR service_type ILIKE '%turf%' THEN 'Lawn Care' WHEN service_type ILIKE '%mosquito%' THEN 'Mosquito' WHEN service_type ILIKE '%termite%' THEN 'Termite' WHEN service_type ILIKE '%tree%' OR service_type ILIKE '%shrub%' THEN 'Tree & Shrub' WHEN service_type ILIKE '%rodent%' THEN 'Rodent' ELSE 'Other' END")
    .orderByRaw('COUNT(*) DESC');

  const total = mix.reduce((s, m) => s + parseInt(m.service_count), 0);

  return {
    period: { from, to },
    total_services: total,
    mix: mix.map(m => ({
      category: m.category,
      service_count: parseInt(m.service_count),
      pct_of_total: total > 0 ? Math.round(parseInt(m.service_count) / total * 100) : 0,
      revenue: parseFloat(m.revenue || 0),
      unique_customers: parseInt(m.unique_customers),
    })),
  };
}


// Report engagement — the read path for the service-report telemetry that
// completion + the public report page already write (service_report_events,
// service_report_deliveries.sent_at, service_records.report_viewed_at).
// Cohort = service_report_v1 records whose report was FIRST sent inside the
// window. Every send source is server-owned: the per-recipient email ledger
// (email_messages, keyed service_report_ready:<record>:<role> — the earliest
// recipient success, so a partial multi-recipient send still counts from its
// first delivery), the delivery queue's terminal sent_at, and the
// completion-SMS stamp the dispatch route / deferred sender write into
// service_records.structured_notes. The sms_sent/mms_sent EVENT rows are
// deliberately not used — the public token endpoint accepts those names, so
// a token holder could forge a send. Non-v1 completions text a generic
// portal link and stamp the same SMS status, so the cohort is filtered to
// report_template_version = service_report_v1. Opens are the first-view
// stamp; in-report actions are distinct records with the (customer-written)
// event.
const REPORT_ACTION_EVENTS = [
  'pdf_downloaded',
  'photo_opened',
  'map_interacted',
  'reentry_timer_viewed',
  'review_request_clicked',
  'referral_cta_clicked',
  'cross_sell_requested',
  'followup_requested',
  'report_question_asked',
];

async function getReportEngagement(input = {}) {
  const now = new Date();
  // Inclusive lower bound: 29 days back + today = exactly 30 ET calendar days.
  const from = input.date_from || etDateString(addETDays(now, -29));
  const to = input.date_to || etDateString(now);
  if (!validCalendarDate(from) || !validCalendarDate(to)) {
    return { error: 'date_from and date_to must be real YYYY-MM-DD dates' };
  }
  // ET wall-clock day bounds as real Dates — the send timestamps are
  // timestamptz, so a naive string here would shift the window 4-5 hours.
  const fromTs = parseETDateTime(`${from}T00:00`);
  const toTs = parseETDateTime(`${etDateString(addETDays(parseETDateTime(`${to}T12:00`), 1))}T00:00`);
  if (!(fromTs < toTs)) return { error: 'date_from must be on or before date_to' };

  const actionFlags = REPORT_ACTION_EVENTS
    .map((name) => `BOOL_OR(sre.event_name = '${name}') AS ${name}`)
    .join(',\n           ');
  const actionCounts = REPORT_ACTION_EVENTS
    .map((name) => `(COUNT(*) FILTER (WHERE act.${name}))::int AS ${name}`)
    .join(',\n           ');
  const actionList = REPORT_ACTION_EVENTS.map((name) => `'${name}'`).join(', ');

  const { rows } = await db.raw(`
    WITH sends AS (
      SELECT service_record_id, MIN(sent_at) AS first_sent_at
      FROM (
        SELECT service_record_id, sent_at
        FROM service_report_deliveries
        WHERE status = 'sent' AND sent_at IS NOT NULL
        UNION ALL
        SELECT split_part(idempotency_key, ':', 2)::uuid AS service_record_id, sent_at
        FROM email_messages
        WHERE idempotency_key LIKE 'service_report_ready:%'
          AND split_part(idempotency_key, ':', 2) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          AND status IN ('sent', 'delivered', 'opened', 'clicked')
          AND sent_at IS NOT NULL
        UNION ALL
        SELECT id AS service_record_id,
               COALESCE(structured_notes->>'completionSmsDeferredDeliveredAt',
                        structured_notes->>'sentSmsAt')::timestamptz AS sent_at
        FROM service_records
        WHERE structured_notes->>'completionSmsStatus' = 'sent'
          AND COALESCE(structured_notes->>'completionSmsDeferredDeliveredAt',
                       structured_notes->>'sentSmsAt') ~ '^\\d{4}-\\d{2}-\\d{2}T'
      ) snd
      GROUP BY service_record_id
    ),
    cohort AS (
      SELECT srec.id,
             COALESCE(NULLIF(srec.service_line, ''), 'unknown') AS service_line,
             snd.first_sent_at,
             srec.report_viewed_at
      FROM sends snd
      JOIN service_records srec ON srec.id = snd.service_record_id
      WHERE srec.report_template_version = 'service_report_v1'
        AND snd.first_sent_at >= ? AND snd.first_sent_at < ?
    ),
    acts AS (
      SELECT sre.service_record_id,
           ${actionFlags}
      FROM service_report_events sre
      JOIN cohort rpt ON rpt.id = sre.service_record_id
      WHERE sre.event_name IN (${actionList})
        AND sre.occurred_at >= rpt.first_sent_at
      GROUP BY sre.service_record_id
    )
    SELECT rpt.service_line,
           GROUPING(rpt.service_line) AS is_total,
           COUNT(*)::int AS sent,
           (COUNT(*) FILTER (WHERE rpt.report_viewed_at >= rpt.first_sent_at))::int AS opened,
           percentile_cont(0.5) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM (rpt.report_viewed_at - rpt.first_sent_at)) / 60.0
           ) FILTER (WHERE rpt.report_viewed_at >= rpt.first_sent_at) AS median_minutes_to_open,
           ${actionCounts}
    FROM cohort rpt
    LEFT JOIN acts act ON act.service_record_id = rpt.id
    GROUP BY ROLLUP (rpt.service_line)
    ORDER BY is_total DESC, sent DESC
  `, [fromTs, toTs]);

  const shape = (row) => {
    const sent = parseInt(row.sent, 10) || 0;
    const opened = parseInt(row.opened, 10) || 0;
    const out = {
      sent,
      opened,
      open_rate_pct: sent > 0 ? Math.round(opened / sent * 100) : 0,
      median_minutes_to_open: row.median_minutes_to_open == null ? null : Math.round(parseFloat(row.median_minutes_to_open)),
    };
    for (const name of REPORT_ACTION_EVENTS) out[name] = parseInt(row[name], 10) || 0;
    return out;
  };
  const totalRow = rows.find((r) => Number(r.is_total) === 1);
  const byLine = rows.filter((r) => Number(r.is_total) !== 1);

  return {
    period: { from, to },
    cohort: 'service_report_v1 records first sent to the customer (report email per the email ledger / delivery queue, or the completion SMS/MMS per the server-stamped send status) in the period',
    total: totalRow ? shape(totalRow) : shape({ sent: 0, opened: 0 }),
    by_service_line: byLine.map((r) => ({ service_line: r.service_line, ...shape(r) })),
    notes: [
      'opened = the report link was first viewed at or after the first send. Staff previews with a staff JWT and portal static views never stamp, but a staff download through the plain customer PDF link does (that link cannot carry the staff JWT), so a small share of opens can be internal QA. A view that predates every send is not counted.',
      'median_minutes_to_open is over those post-send first opens',
      'action counts are distinct reports with at least one such event at or after the first send (pdf_downloaded shares the staff-download caveat above)',
      "service_line 'unknown' = records completed before the line was stamped on the record",
    ],
  };
}


async function getCustomerAcquisition(input) {
  const r = dateRange();
  const from = input.date_from || r.year_start;
  const to = input.date_to || r.today;

  // Real customers only (not leads), acquired by CONVERSION date (member_since,
  // an ET DATE) — consistent with the dashboard new-customer source of truth.
  const bySource = await db('customers')
    .modify(whereLiveCustomer)
    .whereRaw(`${CONVERSION_DATE_SQL} >= ?`, [from]).whereRaw(`${CONVERSION_DATE_SQL} <= ?`, [to])
    .select('lead_source', db.raw('COUNT(*) as count'), db.raw('SUM(monthly_rate) as total_mrr'))
    .groupBy('lead_source').orderByRaw('COUNT(*) DESC');

  const byMonth = await db('customers')
    .modify(whereLiveCustomer)
    .whereRaw(`${CONVERSION_DATE_SQL} >= ?`, [from]).whereRaw(`${CONVERSION_DATE_SQL} <= ?`, [to])
    .select(db.raw(`TO_CHAR(${CONVERSION_DATE_SQL}, 'YYYY-MM') as month`), db.raw('COUNT(*) as count'))
    .groupByRaw(`TO_CHAR(${CONVERSION_DATE_SQL}, 'YYYY-MM')`).orderByRaw(`TO_CHAR(${CONVERSION_DATE_SQL}, 'YYYY-MM')`);

  return {
    period: { from, to },
    total_acquired: bySource.reduce((s, r) => s + parseInt(r.count), 0),
    by_source: bySource.map(r => ({
      source: r.lead_source || 'Unknown',
      count: parseInt(r.count),
      mrr_added: parseFloat(r.total_mrr || 0),
    })),
    by_month: byMonth.map(r => ({ month: r.month, count: parseInt(r.count) })),
  };
}


async function getOutstandingBalances(input) {
  const minAmount = input.min_amount || 0;

  // Source-of-truth filter: an invoice is unpaid if `paid_at IS NULL` and
  // it isn't a draft or void. The previous status whitelist
  // (['sent','viewed','overdue']) was fragile — if a partial-payment or
  // 'in_collections' state ever gets added, those invoices would silently
  // disappear from AR. matches the cleaner pattern already used by the
  // /admin/dashboard/core-kpis AR Days query.
  // Report amount DUE (total − applied account credit), not gross total: a
  // partially credit-applied invoice owes the reduced amount, so it must filter,
  // age, sort, and surface on the cash the customer actually still owes.
  const invoices = await excludeInternalCustomers(
    db({ i: 'invoices' })
      .leftJoin({ c: 'customers' }, 'i.customer_id', 'c.id')
      .whereNull('i.paid_at')
      .whereNotIn('i.status', ['draft', 'void'])
      .whereRaw('GREATEST(i.total - COALESCE(i.credit_applied, 0), 0) > ?', [minAmount])
  )
    .select(
      'i.id', 'i.total', 'i.status', 'i.created_at', 'i.due_date',
      db.raw('GREATEST(i.total - COALESCE(i.credit_applied, 0), 0) as amount_due'),
      'c.id as customer_id', 'c.first_name', 'c.last_name',
      'c.waveguard_tier', 'c.phone',
    )
    .orderByRaw('GREATEST(i.total - COALESCE(i.credit_applied, 0), 0) desc');

  // ET-anchored "today" so the days-past-due math doesn't drift at the
  // UTC midnight boundary. due_date is a date-only column — parse it as
  // ET noon to keep the day count stable regardless of the server's TZ.
  const todayET = parseETDateTime(`${etDateString()}T12:00`);
  let total = 0, overdue = 0;
  // Six ST-style buckets so the oldest, least-collectible debt (91-120, 121+) is
  // visible/chasable on its own instead of lumped into one "90+". days_90_plus is
  // kept below as a back-compat alias (BillingRecoveryPage still reads it).
  const aging = { current: 0, days_30: 0, days_60: 0, days_90: 0, days_120: 0, days_120_plus: 0 };

  invoices.forEach((row) => {
    const amt = parseFloat(row.amount_due || 0);
    total += amt;

    let age = 0;
    if (row.due_date) {
      // due_date may arrive as 'YYYY-MM-DD' (string) or a Date object
      // depending on the driver. Normalize via ET noon either way.
      const dueStr = typeof row.due_date === 'string'
        ? row.due_date.slice(0, 10)
        : etDateString(new Date(row.due_date));
      const dueET = parseETDateTime(`${dueStr}T12:00`);
      age = Math.floor((todayET - dueET) / 86400000);
    }

    // Overdue is derived from days-past-due, NOT the `status='overdue'`
    // string — that string only flips when a cron flips it, so freshly
    // past-due invoices still in 'sent' or 'viewed' wouldn't otherwise
    // count.
    if (age > 0) overdue += amt;

    if (age <= 0) aging.current += amt;
    else if (age <= 30) aging.days_30 += amt;
    else if (age <= 60) aging.days_60 += amt;
    else if (age <= 90) aging.days_90 += amt;
    else if (age <= 120) aging.days_120 += amt;
    else aging.days_120_plus += amt;
  });
  // Back-compat alias = the old "90+" (now 61+ split into three).
  aging.days_90_plus = aging.days_90 + aging.days_120 + aging.days_120_plus;

  return {
    total_outstanding: total,
    total_overdue: overdue,
    invoice_count: invoices.length,
    aging,
    top_balances: invoices.slice(0, 15).map((row) => ({
      invoice_id: row.id,
      customer_id: row.customer_id,
      customer: `${row.first_name} ${row.last_name}`,
      tier: row.waveguard_tier,
      phone: row.phone,
      amount: parseFloat(row.amount_due || 0),
      status: row.status,
      created: row.created_at,
      due_date: row.due_date,
    })),
    excluded_internal_customers: INTERNAL_TEST_CUSTOMERS,
  };
}


async function getTodayBriefing() {
  const today = etDateString();
  const r = dateRange();

  const [schedule, unread, pendingEst, overdueCustomers, atRisk, recentActivity] = await Promise.all([
    // Today's schedule
    db('scheduled_services').where({ scheduled_date: today }).whereNotIn('status', ['cancelled'])
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
      .select('scheduled_services.id', 'scheduled_services.service_type', 'scheduled_services.status',
        'customers.first_name', 'customers.last_name', 'customers.city',
        'technicians.name as tech_name')
      .orderByRaw('COALESCE(route_order, 999)'),

    // Unread SMS
    db('sms_log').where({ direction: 'inbound' }).where(function () {
      this.where({ is_read: false }).orWhereNull('is_read');
    }).count('* as c').first(),

    // Pending estimates
    // archived_at: the conversion-guard sweep archives converted customers'
    // estimates WITHOUT changing status, so status alone over-counts.
    db('estimates').whereIn('status', ['sent', 'viewed']).whereNull('archived_at').count('* as c').first(),

    // Overdue customers (no service in 90+ days for active pest customers).
    // Uses ET-anchored "today" so the 90-day boundary doesn't drift at
    // midnight UTC.
    db('customers').where({ active: true }).whereNull('deleted_at')
      .whereExists(function () {
        this.select('*').from('service_records').whereRaw('service_records.customer_id = customers.id').whereILike('service_type', '%pest%');
      })
      .whereRaw("(SELECT MAX(service_date) FROM service_records WHERE service_records.customer_id = customers.id) < ((NOW() AT TIME ZONE 'America/New_York')::date - INTERVAL '90 days')")
      .count('* as c').first(),

    // At-risk customers — same ET anchoring on the 7-day threshold.
    // Freshness comes from scored_at: current rows are updated in place by
    // the nightly scorers, so created_at stays at first-insert time and
    // would wrongly age rows out of this window. 'high' is included because
    // the v3 scorer writes low/moderate/high/critical onto the same row the
    // CI scorer stamps at_risk/critical.
    db('customer_health_scores')
      .whereIn('churn_risk', ['at_risk', 'critical', 'high'])
      .whereRaw("COALESCE(scored_at, created_at) >= ((NOW() AT TIME ZONE 'America/New_York')::date - INTERVAL '7 days')")
      .count('* as c').first(),

    // Last 5 activity items
    db('activity_log').orderBy('created_at', 'desc').limit(5),
  ]);

  const byTech = {};
  const unassigned = [];
  schedule.forEach(s => {
    if (!s.tech_name) { unassigned.push(s); return; }
    if (!byTech[s.tech_name]) byTech[s.tech_name] = { total: 0, completed: 0, cities: new Set() };
    byTech[s.tech_name].total++;
    if (s.status === 'completed') byTech[s.tech_name].completed++;
    if (s.city) byTech[s.tech_name].cities.add(s.city);
  });

  return {
    date: today,
    schedule: {
      total: schedule.length,
      completed: schedule.filter(s => s.status === 'completed').length,
      unassigned: unassigned.length,
      by_tech: Object.entries(byTech).map(([name, data]) => ({
        name, total: data.total, completed: data.completed, cities: [...data.cities],
      })),
    },
    unread_messages: parseInt(unread?.c || 0),
    pending_estimates: parseInt(pendingEst?.c || 0),
    overdue_pest_customers: parseInt(overdueCustomers?.c || 0),
    at_risk_customers: parseInt(atRisk?.c || 0),
    recent_activity: recentActivity.map(a => ({ action: a.action, description: a.description, time: a.created_at })),
  };
}

// Third-party PAYER AR aging — the Bill-To/statement receivable layer (separate
// from per-customer self-pay invoices). Delegates to the shared payer-ar service
// so the IB tile and the admin /ar-aging endpoint report identical numbers.
async function getPayerArAging() {
  const { computePayerArAging } = require('../payer-ar');
  const ar = await computePayerArAging();
  return {
    as_of: ar.as_of,
    outstanding_total: ar.outstanding_total,
    past_due_total: ar.past_due_total,
    statement_count: ar.statement_count,
    oldest_days_past_due: ar.oldest_days_past_due,
    aging_buckets: ar.buckets,
    by_terms: ar.by_terms,
    top_past_due_payers: ar.payers.slice(0, 10),
  };
}


module.exports = { DASHBOARD_TOOLS, executeDashboardTool, INTERNAL_TEST_CUSTOMERS };
