/**
 * Intelligence Bar — Revenue Tools
 * server/services/intelligence-bar/revenue-tools.js
 *
 * Focused tools for the Revenue page. Supplements the base query_revenue,
 * dashboard compare_periods, and procurement analyze_margins tools with
 * service-line P&L, ad attribution, and RPMH analysis.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { etDateString, etMonthStart, etMonthEnd, etQuarterStart, etYearStart, parseETDateTime, addETDays } = require('../../utils/datetime-et');

function classifyServiceLine(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('lawn')) return 'Lawn Care';
  if (t.includes('mosquito')) return 'Mosquito';
  if (t.includes('tree') || t.includes('shrub')) return 'Tree & Shrub';
  if (t.includes('termite')) return 'Termite';
  if (t.includes('rodent')) return 'Rodent';
  return 'Pest Control';
}

function getPeriodDates(period) {
  const now = new Date();
  const today = etDateString(now);
  switch (period) {
    case 'month': return { start: etMonthStart(now), end: today, label: 'This Month' };
    case 'last_month': return { start: etMonthStart(now, -1), end: etMonthEnd(now, -1), label: 'Last Month' };
    case 'quarter': return { start: etQuarterStart(now), end: today, label: 'This Quarter' };
    case 'ytd': return { start: etYearStart(now), end: today, label: 'YTD' };
    default:
      if (period && period.match(/^\d{4}-\d{2}$/)) {
        const [y, m] = period.split('-').map(Number);
        const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
        const start = `${y}-${String(m).padStart(2, '0')}-01`;
        const end = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
        const label = parseETDateTime(`${y}-${String(m).padStart(2, '0')}-15T12:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'America/New_York' });
        return { start, end, label };
      }
      return { start: etMonthStart(now), end: today, label: 'This Month' };
  }
}

const REVENUE_TOOLS = [
  {
    name: 'get_revenue_overview',
    description: `Get the full revenue overview: gross revenue, gross margin, revenue per man-hour (RPMH), MRR, ARR, avg revenue per job, and comparison to the previous period.
Use for: "how's revenue this month?", "what's our gross margin?", "revenue per man-hour"`,
    input_schema: {
      type: 'object',
      properties: {
        period: { type: 'string', description: 'month, last_month, quarter, ytd, or YYYY-MM for a specific month' },
      },
    },
  },
  {
    name: 'get_service_line_pnl',
    description: `Get profit & loss by service line: revenue, cost, margin %, RPMH, service count, avg $/job for each service category (Pest Control, Lawn Care, Mosquito, Tree & Shrub, Termite, Rodent).
Use for: "which service line is most profitable?", "compare pest control vs lawn care margins", "RPMH by service type"`,
    input_schema: {
      type: 'object',
      properties: {
        period: { type: 'string' },
      },
    },
  },
  {
    name: 'get_ad_attribution',
    description: `Get ad attribution / marketing ROI: revenue, ad spend, ROAS, customers acquired, and CAC by lead source (Google Ads, Google LSA, Organic, Referral, Facebook, etc.).
Use for: "what's our ad ROAS?", "which marketing channel has the best ROI?", "how much are we spending on Google Ads?"`,
    input_schema: {
      type: 'object',
      properties: {
        period: { type: 'string' },
      },
    },
  },
  {
    name: 'get_tech_revenue_performance',
    description: `Revenue performance by technician: services completed, hours worked, revenue generated, RPMH (revenue per man-hour), and margin %.
Use for: "who's the most efficient tech?", "compare Adam vs Jose revenue", "tech RPMH rankings"`,
    input_schema: {
      type: 'object',
      properties: {
        period: { type: 'string' },
        tech_name: { type: 'string', description: 'Optional: filter to one tech' },
      },
    },
  },
  {
    name: 'compare_revenue_periods',
    description: `Side-by-side revenue comparison of two specific months or periods. Shows delta for every metric: revenue, margin, RPMH, services, avg job value.
Use for: "compare March vs April revenue", "how does Q1 compare to Q2?", "this month vs same month last year"`,
    input_schema: {
      type: 'object',
      properties: {
        period_a: { type: 'string', description: 'First period (month, last_month, quarter, ytd, or YYYY-MM)' },
        period_b: { type: 'string', description: 'Second period' },
      },
      required: ['period_a', 'period_b'],
    },
  },
  {
    name: 'get_top_revenue_customers',
    description: `Rank customers by revenue for a period. Shows total paid, services count, tier, avg per service.
Use for: "who are our top 10 customers by revenue?", "highest value customers this quarter"`,
    input_schema: {
      type: 'object',
      properties: {
        period: { type: 'string' },
        limit: { type: 'number', description: 'How many to return (default 10)' },
      },
    },
  },
];


// ─── EXECUTION ──────────────────────────────────────────────────

async function executeRevenueTool(toolName, input) {
  try {
    switch (toolName) {
      case 'get_revenue_overview': return await getRevenueOverview(input.period);
      case 'get_service_line_pnl': return await getServiceLinePnl(input.period);
      case 'get_ad_attribution': return await getAdAttribution(input.period);
      case 'get_tech_revenue_performance': return await getTechRevenuePerformance(input);
      case 'compare_revenue_periods': return await compareRevenuePeriods(input.period_a, input.period_b);
      case 'get_top_revenue_customers': return await getTopRevenueCustomers(input);
      default: return { error: `Unknown revenue tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:revenue] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}


// ─── IMPLEMENTATIONS ────────────────────────────────────────────

async function fetchServiceRecords(start, end) {
  return db('service_records')
    .whereBetween('service_date', [start, end])
    .where('status', 'completed')
    .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
    .leftJoin('customers', 'service_records.customer_id', 'customers.id')
    .select('service_records.*', 'technicians.name as tech_name',
      'customers.waveguard_tier', 'customers.first_name', 'customers.last_name');
}

function computeTopline(services) {
  const totalRev = services.reduce((s, r) => s + parseFloat(r.revenue || 0), 0);
  const totalCost = services.reduce((s, r) => s + parseFloat(r.total_job_cost || 0), 0);
  const totalHours = services.reduce((s, r) => s + parseFloat(r.labor_hours || 0), 0);
  return {
    total_revenue: Math.round(totalRev),
    total_cost: Math.round(totalCost),
    gross_profit: Math.round(totalRev - totalCost),
    gross_margin_pct: totalRev > 0 ? Math.round((totalRev - totalCost) / totalRev * 100) : 0,
    rpmh: totalHours > 0 ? Math.round(totalRev / totalHours) : 0,
    total_services: services.length,
    total_hours: Math.round(totalHours * 10) / 10,
    avg_job_revenue: services.length > 0 ? Math.round(totalRev / services.length) : 0,
  };
}


async function getRevenueOverview(period = 'month') {
  const p = getPeriodDates(period);
  const services = await fetchServiceRecords(p.start, p.end);
  const topline = computeTopline(services);

  // Previous period for comparison (ET calendar days).
  const startAnchor = parseETDateTime(p.start + 'T12:00');
  const endAnchor = parseETDateTime(p.end + 'T12:00');
  const pDur = Math.round((endAnchor - startAnchor) / 86400000);
  const prevEnd = etDateString(addETDays(startAnchor, -1));
  const prevStart = etDateString(addETDays(startAnchor, -1 - pDur));
  const prevServices = await fetchServiceRecords(prevStart, prevEnd);
  const prevTopline = computeTopline(prevServices);

  const mrr = await db('customers').where({ active: true }).where('monthly_rate', '>', 0).sum('monthly_rate as total').first();
  const mrrVal = parseFloat(mrr?.total || 0);

  return {
    period: { ...p, period_key: period },
    topline: { ...topline, mrr: Math.round(mrrVal), arr: Math.round(mrrVal * 12) },
    vs_previous: {
      revenue_change: prevTopline.total_revenue > 0 ? Math.round((topline.total_revenue - prevTopline.total_revenue) / prevTopline.total_revenue * 100) : null,
      margin_change: prevTopline.gross_margin_pct > 0 ? topline.gross_margin_pct - prevTopline.gross_margin_pct : null,
      services_change: prevTopline.total_services > 0 ? Math.round((topline.total_services - prevTopline.total_services) / prevTopline.total_services * 100) : null,
      previous_revenue: prevTopline.total_revenue,
      previous_period: { start: prevStart, end: prevEnd },
    },
  };
}


async function getServiceLinePnl(period = 'month') {
  const p = getPeriodDates(period);
  const services = await fetchServiceRecords(p.start, p.end);

  const byLine = {};
  services.forEach(s => {
    const line = classifyServiceLine(s.service_type);
    if (!byLine[line]) byLine[line] = { revenue: 0, cost: 0, services: 0, hours: 0 };
    byLine[line].revenue += parseFloat(s.revenue || 0);
    byLine[line].cost += parseFloat(s.total_job_cost || 0);
    byLine[line].services++;
    byLine[line].hours += parseFloat(s.labor_hours || 0);
  });

  const lines = Object.entries(byLine).map(([name, data]) => ({
    service_line: name,
    revenue: Math.round(data.revenue),
    cost: Math.round(data.cost),
    profit: Math.round(data.revenue - data.cost),
    margin_pct: data.revenue > 0 ? Math.round((data.revenue - data.cost) / data.revenue * 100) : 0,
    rpmh: data.hours > 0 ? Math.round(data.revenue / data.hours) : 0,
    services: data.services,
    hours: Math.round(data.hours * 10) / 10,
    avg_job_revenue: data.services > 0 ? Math.round(data.revenue / data.services) : 0,
    below_margin_target: data.revenue > 0 && ((data.revenue - data.cost) / data.revenue * 100) < 55,
  })).sort((a, b) => b.revenue - a.revenue);

  return { period: p, service_lines: lines, margin_target: '55%' };
}


async function getAdAttribution(period = 'month') {
  const p = getPeriodDates(period);

  // Get customers created in this period with lead source
  const customers = await db('customers')
    .whereBetween('created_at', [p.start, p.end + 'T23:59:59'])
    .select('id', 'lead_source', 'monthly_rate', 'lifetime_revenue');

  // Get revenue from these customers
  const customerIds = customers.map(c => c.id);
  let revenueBySource = {};

  if (customerIds.length > 0) {
    const payments = await db('payments')
      .whereIn('customer_id', customerIds)
      .where('status', 'paid')
      .whereBetween('payment_date', [p.start, p.end])
      .leftJoin('customers', 'payments.customer_id', 'customers.id')
      .select('customers.lead_source', db.raw('SUM(payments.amount) as revenue'), db.raw('COUNT(DISTINCT customers.id) as customers'));

    // Not grouped properly — regroup
  }

  // Simpler: group by lead source from customers table
  const bySource = {};
  customers.forEach(c => {
    const src = c.lead_source || 'Unknown';
    if (!bySource[src]) bySource[src] = { customers: 0, mrr: 0, ltv: 0 };
    bySource[src].customers++;
    bySource[src].mrr += parseFloat(c.monthly_rate || 0);
    bySource[src].ltv += parseFloat(c.lifetime_revenue || 0);
  });

  // Try to get ad spend data
  let adSpend = {};
  try {
    const spendRows = await db('ad_spend_log')
      .whereBetween('date', [p.start, p.end])
      .select('source', db.raw('SUM(spend) as total_spend'))
      .groupBy('source');
    spendRows.forEach(r => { adSpend[r.source] = parseFloat(r.total_spend || 0); });
  } catch { /* table may not exist */ }

  const sources = Object.entries(bySource).map(([source, data]) => {
    const spend = adSpend[source] || 0;
    return {
      source,
      customers_acquired: data.customers,
      mrr_added: Math.round(data.mrr),
      estimated_revenue: Math.round(data.ltv),
      ad_spend: Math.round(spend),
      roas: spend > 0 ? Math.round(data.ltv / spend * 10) / 10 : null,
      cac: data.customers > 0 && spend > 0 ? Math.round(spend / data.customers) : 0,
    };
  }).sort((a, b) => b.customers_acquired - a.customers_acquired);

  return {
    period: p,
    sources,
    total_customers_acquired: customers.length,
    total_mrr_added: Math.round(customers.reduce((s, c) => s + parseFloat(c.monthly_rate || 0), 0)),
    total_ad_spend: Math.round(Object.values(adSpend).reduce((s, v) => s + v, 0)),
  };
}


async function getTechRevenuePerformance(input) {
  const { period = 'month', tech_name } = input;
  const p = getPeriodDates(period);
  const services = await fetchServiceRecords(p.start, p.end);

  const byTech = {};
  services.forEach(s => {
    const tech = s.tech_name || 'Unassigned';
    if (tech_name && !tech.toLowerCase().includes(tech_name.toLowerCase())) return;
    if (!byTech[tech]) byTech[tech] = { revenue: 0, cost: 0, hours: 0, services: 0 };
    byTech[tech].revenue += parseFloat(s.revenue || 0);
    byTech[tech].cost += parseFloat(s.total_job_cost || 0);
    byTech[tech].hours += parseFloat(s.labor_hours || 0);
    byTech[tech].services++;
  });

  const techs = Object.entries(byTech).map(([name, data]) => ({
    tech: name,
    revenue: Math.round(data.revenue),
    cost: Math.round(data.cost),
    profit: Math.round(data.revenue - data.cost),
    margin_pct: data.revenue > 0 ? Math.round((data.revenue - data.cost) / data.revenue * 100) : 0,
    hours: Math.round(data.hours * 10) / 10,
    rpmh: data.hours > 0 ? Math.round(data.revenue / data.hours) : 0,
    services: data.services,
    avg_job: data.services > 0 ? Math.round(data.revenue / data.services) : 0,
  })).sort((a, b) => b.rpmh - a.rpmh);

  return { period: p, technicians: techs };
}


async function compareRevenuePeriods(periodA, periodB) {
  const a = getPeriodDates(periodA);
  const b = getPeriodDates(periodB);

  const [servicesA, servicesB] = await Promise.all([
    fetchServiceRecords(a.start, a.end),
    fetchServiceRecords(b.start, b.end),
  ]);

  const topA = computeTopline(servicesA);
  const topB = computeTopline(servicesB);

  const delta = {};
  for (const key of Object.keys(topA)) {
    if (typeof topA[key] === 'number' && typeof topB[key] === 'number') {
      delta[key] = {
        period_a: topA[key],
        period_b: topB[key],
        change: topA[key] - topB[key],
        pct: topB[key] > 0 ? Math.round((topA[key] - topB[key]) / topB[key] * 100) : null,
      };
    }
  }

  return {
    period_a: { ...a, metrics: topA },
    period_b: { ...b, metrics: topB },
    comparison: delta,
  };
}


async function getTopRevenueCustomers(input) {
  const { period = 'month', limit: rawLimit } = input;
  const lim = Math.min(rawLimit || 10, 50);
  const p = getPeriodDates(period);

  const rows = await db('service_records')
    .whereBetween('service_date', [p.start, p.end])
    .where('status', 'completed')
    .leftJoin('customers', 'service_records.customer_id', 'customers.id')
    .select(
      'customers.id', 'customers.first_name', 'customers.last_name',
      'customers.waveguard_tier', 'customers.monthly_rate', 'customers.lifetime_revenue',
      db.raw('SUM(service_records.revenue) as period_revenue'),
      db.raw('COUNT(*) as services'),
    )
    .groupBy('customers.id', 'customers.first_name', 'customers.last_name',
      'customers.waveguard_tier', 'customers.monthly_rate', 'customers.lifetime_revenue')
    .orderByRaw('SUM(service_records.revenue) DESC')
    .limit(lim);

  return {
    period: p,
    customers: rows.map(r => ({
      id: r.id,
      name: `${r.first_name} ${r.last_name}`,
      tier: r.waveguard_tier,
      period_revenue: Math.round(parseFloat(r.period_revenue || 0)),
      lifetime_revenue: Math.round(parseFloat(r.lifetime_revenue || 0)),
      monthly_rate: Math.round(parseFloat(r.monthly_rate || 0)),
      services: parseInt(r.services),
      avg_per_service: parseInt(r.services) > 0 ? Math.round(parseFloat(r.period_revenue || 0) / parseInt(r.services)) : 0,
    })),
  };
}


module.exports = { REVENUE_TOOLS, executeRevenueTool };
