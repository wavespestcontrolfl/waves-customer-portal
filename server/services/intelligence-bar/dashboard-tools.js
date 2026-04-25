/**
 * Intelligence Bar — Dashboard & Analytics Tools
 * server/services/intelligence-bar/dashboard-tools.js
 *
 * Gives Claude access to real-time KPIs, period-over-period comparison,
 * pipeline/funnel analysis, and business health metrics.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { etDateString, etMonthStart, etMonthEnd, etQuarterStart, etYearStart, etWeekStart, addETDays, parseETDateTime } = require('../../utils/datetime-et');

// Internal/test customers excluded from sales-funnel analytics. Names are
// matched lowercase against both estimates.customer_name (denormalized
// string) and the joined customers row, so a misspelled denormalization
// can't sneak past. Add new names here as they come up.
const INTERNAL_TEST_CUSTOMERS = ['adam martinez'];

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
      case 'get_customer_acquisition': return await getCustomerAcquisition(input);
      case 'get_outstanding_balances': return await getOutstandingBalances(input);
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
    db('customers').where({ active: true }).count('* as c').first(),
    db('customers').where({ active: true }).where('created_at', '>=', r.month_start).count('* as c').first(),
    db('estimates').whereIn('status', ['sent', 'viewed']).count('* as c').first(),
    db('scheduled_services').whereBetween('scheduled_date', [r.week_start, r.week_end]).select(
      db.raw("COUNT(*) as total"),
      db.raw("COUNT(*) FILTER (WHERE status = 'completed') as completed"),
    ).first(),
    db('customers').where({ active: true }).where('monthly_rate', '>', 0).sum('monthly_rate as total').first(),
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
        db.raw('SUM(total) as total_owed'),
        db.raw("SUM(CASE WHEN due_date < (NOW() AT TIME ZONE 'America/New_York')::date THEN total ELSE 0 END) as overdue"),
        db.raw('COUNT(*) as count'),
      ).first(),
    db('customer_health_scores as h')
      .join(db.raw("(SELECT customer_id, MAX(created_at) as max_created FROM customer_health_scores GROUP BY customer_id) latest ON h.customer_id = latest.customer_id AND h.created_at = latest.max_created"))
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
          .whereBetween('c.created_at', [fromTs, toTs])
      ).count('* as count').first();
      m.new_customers = parseInt(nc?.count || 0);
    }
    if (wantAll || metrics.includes('estimates_sent')) {
      const es = await excludeInternalEstimates(
        db({ e: 'estimates' })
          .leftJoin({ c: 'customers' }, 'e.customer_id', 'c.id')
          .whereNotNull('e.sent_at')
          .whereBetween('e.sent_at', [fromTs, toTs])
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

  // Batch: one query per month, all in parallel (instead of sequential awaits)
  const settled = await Promise.all(windows.map(async w => {
    const [mrrRow, byTier] = await Promise.all([
      db('customers')
        .where({ active: true })
        .where('created_at', '<=', w.end.toISOString())
        .where('monthly_rate', '>', 0)
        .select(
          db.raw('SUM(monthly_rate) as mrr'),
          db.raw('COUNT(*) as customer_count'),
        ).first(),
      db('customers')
        .where({ active: true })
        .where('created_at', '<=', w.end.toISOString())
        .where('monthly_rate', '>', 0)
        .select('waveguard_tier', db.raw('SUM(monthly_rate) as mrr'), db.raw('COUNT(*) as count'))
        .groupBy('waveguard_tier'),
    ]);
    return {
      month: w.label,
      date: w.startDay,
      mrr: parseFloat(mrrRow?.mrr || 0),
      customer_count: parseInt(mrrRow?.customer_count || 0),
      by_tier: byTier.map(t => ({ tier: t.waveguard_tier || 'None', mrr: parseFloat(t.mrr || 0), count: parseInt(t.count) })),
    };
  }));

  const results = settled;

  // Growth rates
  for (let i = 1; i < results.length; i++) {
    const prev = results[i - 1].mrr;
    results[i].growth_pct = prev > 0 ? Math.round((results[i].mrr - prev) / prev * 100) : null;
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
      .select('service_type', db.raw('COUNT(*) as count'), db.raw('SUM(COALESCE(price, 0)) as revenue'))
      .groupBy('service_type').orderByRaw('SUM(COALESCE(price, 0)) DESC');
    return { group_by, period: { from, to }, rows: rows.map(r => ({ service_type: r.service_type, count: parseInt(r.count), revenue: parseFloat(r.revenue || 0) })) };
  }

  if (group_by === 'tier') {
    const rows = await db('customers').where({ active: true })
      .select('waveguard_tier', db.raw('COUNT(*) as count'), db.raw('SUM(monthly_rate) as mrr'))
      .groupBy('waveguard_tier').orderByRaw('SUM(monthly_rate) DESC');
    return { group_by, rows: rows.map(r => ({ tier: r.waveguard_tier || 'None', count: parseInt(r.count), mrr: parseFloat(r.mrr || 0), arr: parseFloat(r.mrr || 0) * 12 })) };
  }

  if (group_by === 'city') {
    const rows = await db('customers').where({ active: true }).whereNotNull('city').where('city', '!=', '')
      .select('city', db.raw('COUNT(*) as count'), db.raw('SUM(monthly_rate) as mrr'))
      .groupBy('city').orderByRaw('SUM(monthly_rate) DESC');
    return { group_by, rows: rows.map(r => ({ city: r.city, count: parseInt(r.count), mrr: parseFloat(r.mrr || 0) })) };
  }

  if (group_by === 'customer') {
    const rows = await db('payments').where({ status: 'paid' }).whereBetween('payment_date', [from, to])
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

  return {
    period: { from, to },
    funnel: {
      sent: totalSent,
      viewed: totalViewed,
      accepted: totalAccepted,
      declined: totalDeclined,
      pending: totalSent - totalAccepted - totalDeclined,
    },
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
      db.raw("CASE WHEN service_type ILIKE '%pest%' THEN 'Pest Control' WHEN service_type ILIKE '%lawn%' THEN 'Lawn Care' WHEN service_type ILIKE '%mosquito%' THEN 'Mosquito' WHEN service_type ILIKE '%termite%' THEN 'Termite' WHEN service_type ILIKE '%tree%' OR service_type ILIKE '%shrub%' THEN 'Tree & Shrub' WHEN service_type ILIKE '%rodent%' THEN 'Rodent' ELSE 'Other' END as category"),
      db.raw('COUNT(*) as service_count'),
      db.raw('SUM(COALESCE(price, 0)) as revenue'),
      db.raw('COUNT(DISTINCT customer_id) as unique_customers'),
    )
    .groupByRaw("CASE WHEN service_type ILIKE '%pest%' THEN 'Pest Control' WHEN service_type ILIKE '%lawn%' THEN 'Lawn Care' WHEN service_type ILIKE '%mosquito%' THEN 'Mosquito' WHEN service_type ILIKE '%termite%' THEN 'Termite' WHEN service_type ILIKE '%tree%' OR service_type ILIKE '%shrub%' THEN 'Tree & Shrub' WHEN service_type ILIKE '%rodent%' THEN 'Rodent' ELSE 'Other' END")
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


async function getCustomerAcquisition(input) {
  const r = dateRange();
  const from = input.date_from || r.year_start;
  const to = input.date_to || r.today;

  const bySource = await db('customers')
    .where({ active: true })
    .whereBetween('created_at', [from, to + 'T23:59:59'])
    .select('lead_source', db.raw('COUNT(*) as count'), db.raw('SUM(monthly_rate) as total_mrr'))
    .groupBy('lead_source').orderByRaw('COUNT(*) DESC');

  const byMonth = await db('customers')
    .where({ active: true })
    .whereBetween('created_at', [from, to + 'T23:59:59'])
    .select(db.raw("TO_CHAR(created_at, 'YYYY-MM') as month"), db.raw('COUNT(*) as count'))
    .groupByRaw("TO_CHAR(created_at, 'YYYY-MM')").orderByRaw("TO_CHAR(created_at, 'YYYY-MM')");

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
  const invoices = await excludeInternalCustomers(
    db({ i: 'invoices' })
      .leftJoin({ c: 'customers' }, 'i.customer_id', 'c.id')
      .whereNull('i.paid_at')
      .whereNotIn('i.status', ['draft', 'void'])
      .where('i.total', '>', minAmount)
  )
    .select(
      'i.id', 'i.total', 'i.status', 'i.created_at', 'i.due_date',
      'c.id as customer_id', 'c.first_name', 'c.last_name',
      'c.waveguard_tier', 'c.phone',
    )
    .orderBy('i.total', 'desc');

  // ET-anchored "today" so the days-past-due math doesn't drift at the
  // UTC midnight boundary. due_date is a date-only column — parse it as
  // ET noon to keep the day count stable regardless of the server's TZ.
  const todayET = parseETDateTime(`${etDateString()}T12:00`);
  let total = 0, overdue = 0;
  const aging = { current: 0, days_30: 0, days_60: 0, days_90_plus: 0 };

  invoices.forEach((row) => {
    const amt = parseFloat(row.total || 0);
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
    else aging.days_90_plus += amt;
  });

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
      amount: parseFloat(row.total || 0),
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
    db('estimates').whereIn('status', ['sent', 'viewed']).count('* as c').first(),

    // Overdue customers (no service in 90+ days for active pest customers)
    db('customers').where({ active: true })
      .whereExists(function () {
        this.select('*').from('service_records').whereRaw('service_records.customer_id = customers.id').whereILike('service_type', '%pest%');
      })
      .whereRaw("(SELECT MAX(service_date) FROM service_records WHERE service_records.customer_id = customers.id) < CURRENT_DATE - INTERVAL '90 days'")
      .count('* as c').first(),

    // At-risk customers
    db('customer_health_scores')
      .whereIn('churn_risk', ['at_risk', 'critical'])
      .whereRaw('created_at >= CURRENT_DATE - INTERVAL \'7 days\'')
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


module.exports = { DASHBOARD_TOOLS, executeDashboardTool };
