/**
 * Intelligence Bar — Tax & Finance Tools
 * server/services/intelligence-bar/tax-tools.js
 *
 * Tools for the Tax Center page. Subsumes the AI Tax Advisor tab —
 * everything it did (run analysis, review alerts, view reports)
 * is now handled conversationally.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { etDateString, etParts, etMonthStart, etMonthEnd, etQuarterStart, etYearStart, addETDays, parseETDateTime } = require('../../utils/datetime-et');

// ET date (Waves operates in FL; Railway server runs UTC).
function todayET() {
  return etDateString();
}

// Calendar-day diff (dueDate - today) using ET calendar dates; same-day = 0.
function daysUntil(due) {
  if (!due) return 0;
  const dueStr = (due instanceof Date ? etDateString(due) : String(due)).slice(0, 10);
  const todayStr = etDateString();
  return Math.floor((new Date(dueStr + 'T00:00:00Z') - new Date(todayStr + 'T00:00:00Z')) / 86400000);
}

const TAX_TOOLS = [
  {
    name: 'get_tax_dashboard',
    description: `Get tax overview: YTD tax collected, total expenses, deductible amount, equipment book value, depreciation, next filing deadlines, pending advisor alerts.
Use for: "tax overview", "how's our tax situation?", "what's the tax picture?"`,
    input_schema: {
      type: 'object',
      properties: {
        year: { type: 'string', description: 'Tax year (default current year)' },
      },
    },
  },
  {
    name: 'get_expenses',
    description: `Query expenses by category, date range, or deductibility. Shows amounts, vendors, payment methods.
Use for: "what did we spend this month?", "show me vehicle expenses YTD", "categorize this month's expenses", "total deductible expenses"`,
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Filter by expense category (e.g. vehicle, supplies, insurance, office, marketing, meals)' },
        date_from: { type: 'string' },
        date_to: { type: 'string' },
        deductible_only: { type: 'boolean', description: 'Only show tax-deductible expenses' },
        vendor: { type: 'string', description: 'Filter by vendor name' },
        sort: { type: 'string', enum: ['date', 'amount', 'category'] },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'get_equipment_depreciation',
    description: `Get equipment register with depreciation: purchase cost, current book value, accumulated depreciation, useful life remaining, depreciation method.
Use for: "which equipment is fully depreciated?", "equipment book value", "what can we write off?", "Section 179 candidates"`,
    input_schema: {
      type: 'object',
      properties: {
        fully_depreciated: { type: 'boolean', description: 'true = only show fully depreciated items' },
        sort: { type: 'string', enum: ['book_value', 'purchase_cost', 'name', 'depreciation'] },
      },
    },
  },
  {
    name: 'get_filing_deadlines',
    description: `Get upcoming tax filing deadlines and status. Shows what's due, when, estimated amounts, and filing status.
Use for: "when's the next tax deadline?", "what filings are overdue?", "filing calendar"`,
    input_schema: {
      type: 'object',
      properties: {
        include_filed: { type: 'boolean', description: 'Include already-filed items (default false)' },
        days_ahead: { type: 'number', description: 'How far ahead to look (default 90)' },
      },
    },
  },
  {
    name: 'get_quarterly_estimate',
    description: `Calculate estimated quarterly tax payment based on current revenue, expenses, and tax rates.
Use for: "what's my estimated tax this quarter?", "quarterly payment estimate for Q2", "how much should I set aside for taxes?"`,
    input_schema: {
      type: 'object',
      properties: {
        quarter: { type: 'string', enum: ['Q1', 'Q2', 'Q3', 'Q4'], description: 'Which quarter (default: current)' },
      },
    },
  },
  {
    name: 'get_pnl',
    description: `Get profit & loss statement: revenue, COGS, gross profit, operating expenses by category, net income.
Use for: "P&L this month", "compare this quarter's profit to last quarter", "net income YTD", "where's the money going?"`,
    input_schema: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['mtd', 'last_month', 'quarterly', 'ytd', 'annual', 'last_year'], description: 'Reporting period (default mtd)' },
      },
    },
  },
  {
    name: 'run_tax_advisor',
    description: `Trigger the AI Tax Advisor to run a fresh analysis. Searches for regulation changes, identifies savings opportunities, checks compliance, and generates a graded report. Takes 15-30 seconds.
Use for: "run the tax advisor", "check for tax savings", "any regulation changes I should know about?"`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_advisor_alerts',
    description: `Get pending tax advisor action items: savings opportunities, regulation changes, compliance alerts, deduction gaps. Filter by status (new, reviewed, acted_on, dismissed).
Use for: "any tax action items?", "pending advisor alerts", "what savings opportunities are open?"`,
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['new', 'reviewed', 'acted_on', 'dismissed', 'all'], description: 'Default: new' },
      },
    },
  },
  {
    name: 'get_mileage_summary',
    description: `Get mileage tracking summary: YTD total miles, business vs personal split, estimated deduction at IRS rate, monthly breakdown.
Use for: "mileage deduction so far?", "how many miles YTD?", "mileage stats"`,
    input_schema: {
      type: 'object',
      properties: {
        year: { type: 'string' },
      },
    },
  },
  {
    name: 'get_ar_aging',
    description: `Get accounts receivable aging: total outstanding, breakdown by 0-30/31-60/61-90/90+ days, top unpaid invoices.
Use for: "what's outstanding?", "accounts receivable aging", "who owes us money?", "overdue invoices"`,
    input_schema: {
      type: 'object',
      properties: {
        min_amount: { type: 'number', description: 'Minimum invoice amount to include' },
      },
    },
  },
];


// ─── EXECUTION ──────────────────────────────────────────────────

async function executeTaxTool(toolName, input) {
  try {
    switch (toolName) {
      case 'get_tax_dashboard': return await getTaxDashboard(input.year);
      case 'get_expenses': return await getExpenses(input);
      case 'get_equipment_depreciation': return await getEquipmentDepreciation(input);
      case 'get_filing_deadlines': return await getFilingDeadlines(input);
      case 'get_quarterly_estimate': return await getQuarterlyEstimate(input.quarter);
      case 'get_pnl': return await getPnl(input.period || 'mtd');
      case 'run_tax_advisor': return await runTaxAdvisor();
      case 'get_advisor_alerts': return await getAdvisorAlerts(input.status || 'new');
      case 'get_mileage_summary': return await getMileageSummary(input.year);
      case 'get_ar_aging': return await getArAging(input);
      default: return { error: `Unknown tax tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:tax] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}


// ─── IMPLEMENTATIONS ────────────────────────────────────────────

async function getTaxDashboard(yearInput) {
  const year = yearInput || todayET().slice(0, 4);
  const yearStart = `${year}-01-01`;
  const today = todayET();

  const [expenses, equipment, deadlines, alertCounts, latestReport] = await Promise.all([
    db('expenses').where('tax_year', year).select(
      db.raw('COALESCE(SUM(amount), 0) as total'),
      db.raw('COALESCE(SUM(tax_deductible_amount), 0) as deductible'),
      db.raw('COUNT(*) as count'),
    ).first().catch(() => ({ total: 0, deductible: 0, count: 0 })),

    db('equipment_register').where('active', true).select(
      db.raw('COUNT(*) as count'),
      db.raw('COALESCE(SUM(purchase_cost), 0) as total_cost'),
      db.raw('COALESCE(SUM(current_book_value), 0) as book_value'),
      db.raw('COALESCE(SUM(accumulated_depreciation), 0) as depreciation'),
      db.raw("COUNT(*) FILTER (WHERE current_book_value <= 0) as fully_depreciated"),
    ).first().catch(() => ({ count: 0, total_cost: 0, book_value: 0, depreciation: 0, fully_depreciated: 0 })),

    db('tax_filing_calendar').where('due_date', '>=', today).whereNot('status', 'filed')
      .orderBy('due_date').limit(5).catch(() => []),

    db('tax_advisor_alerts').where('status', 'new')
      .count('* as count').first().catch(() => ({ count: 0 })),

    db('tax_advisor_reports').orderBy('report_date', 'desc').first().catch(() => null),
  ]);

  // Estimated tax collected + gross revenue
  let taxCollected = 0;
  let ytdRevenue = 0;
  try {
    const rev = await db('revenue_daily')
      .where('date', '>=', yearStart)
      .select(db.raw('COALESCE(SUM(tax_collected), 0) as tax'), db.raw('COALESCE(SUM(total_revenue), 0) as revenue'))
      .first();
    taxCollected = parseFloat(rev?.tax || 0);
    ytdRevenue = parseFloat(rev?.revenue || 0);
  } catch (err) {
    logger.warn(`[intelligence-bar:tax] revenue_daily unavailable: ${err.message}`);
  }

  return {
    year,
    tax_collected_ytd: taxCollected,
    ytd_revenue: ytdRevenue,
    expenses: { total: parseFloat(expenses.total), deductible: parseFloat(expenses.deductible), count: parseInt(expenses.count) },
    equipment: {
      count: parseInt(equipment.count), total_cost: parseFloat(equipment.total_cost),
      book_value: parseFloat(equipment.book_value), depreciation: parseFloat(equipment.depreciation),
      fully_depreciated: parseInt(equipment.fully_depreciated || 0),
    },
    upcoming_deadlines: deadlines.map(d => ({
      type: d.filing_type, title: d.title, due_date: d.due_date, status: d.status,
      amount_due: d.amount_due ? parseFloat(d.amount_due) : null,
      days_until: daysUntil(d.due_date),
    })),
    pending_alerts: parseInt(alertCounts?.count || 0),
    latest_report: latestReport ? { date: latestReport.report_date, grade: latestReport.grade, summary: latestReport.executive_summary } : null,
  };
}


async function getExpenses(input) {
  const { category, date_from, date_to, deductible_only, vendor, sort = 'date', limit: rawLimit } = input;
  const limit = Math.min(rawLimit || 30, 200);
  const year = String(etParts().year);

  let query = db('expenses').leftJoin('expense_categories', 'expenses.category_id', 'expense_categories.id')
    .select('expenses.*', 'expense_categories.name as category_name', 'expense_categories.tax_category')
    .where('expenses.tax_year', year);

  if (category) query = query.whereILike('expense_categories.name', `%${category}%`);
  if (date_from) query = query.where('expenses.expense_date', '>=', date_from);
  if (date_to) query = query.where('expenses.expense_date', '<=', date_to);
  if (deductible_only) query = query.where('expenses.tax_deductible_amount', '>', 0);
  if (vendor) query = query.whereILike('expenses.vendor_name', `%${vendor}%`);

  const sortCol = { date: 'expense_date', amount: 'amount', category: 'category_name' }[sort] || 'expense_date';
  query = query.orderBy(sortCol, sort === 'amount' ? 'desc' : 'desc');

  const expenses = await query.limit(limit);

  // Category summary
  const byCat = await db('expenses').where('tax_year', year)
    .leftJoin('expense_categories', 'expenses.category_id', 'expense_categories.id')
    .select('expense_categories.name', db.raw('SUM(amount) as total'), db.raw('COUNT(*) as count'))
    .groupBy('expense_categories.name').orderByRaw('SUM(amount) DESC');

  return {
    expenses: expenses.map(e => ({
      id: e.id, description: e.description, amount: parseFloat(e.amount || 0),
      deductible: parseFloat(e.tax_deductible_amount || 0), category: e.category_name,
      vendor: e.vendor_name, date: e.expense_date, payment_method: e.payment_method,
    })),
    total: expenses.length,
    by_category: byCat.map(c => ({ category: c.name || 'Uncategorized', total: parseFloat(c.total || 0), count: parseInt(c.count) })),
  };
}


async function getEquipmentDepreciation(input) {
  const { fully_depreciated, sort = 'book_value' } = input;

  let query = db('equipment_register').where('active', true);
  if (fully_depreciated) query = query.where('current_book_value', '<=', 0);

  const sortCol = { book_value: 'current_book_value', purchase_cost: 'purchase_cost', name: 'name', depreciation: 'accumulated_depreciation' }[sort] || 'current_book_value';
  query = query.orderBy(sortCol, sort === 'name' ? 'asc' : 'desc');

  const equipment = await query;

  return {
    equipment: equipment.map(e => ({
      name: e.name, category: e.category, purchase_date: e.purchase_date,
      purchase_cost: parseFloat(e.purchase_cost || 0), book_value: parseFloat(e.current_book_value || 0),
      depreciation: parseFloat(e.accumulated_depreciation || 0),
      method: e.depreciation_method, useful_life_years: e.useful_life_years,
      fully_depreciated: parseFloat(e.current_book_value || 0) <= 0,
      section_179_eligible: e.section_179_eligible,
    })),
    total_cost: equipment.reduce((s, e) => s + parseFloat(e.purchase_cost || 0), 0),
    total_book_value: equipment.reduce((s, e) => s + parseFloat(e.current_book_value || 0), 0),
    total_depreciation: equipment.reduce((s, e) => s + parseFloat(e.accumulated_depreciation || 0), 0),
    fully_depreciated_count: equipment.filter(e => parseFloat(e.current_book_value || 0) <= 0).length,
  };
}


async function getFilingDeadlines(input) {
  const { include_filed = false, days_ahead = 90 } = input;
  const today = etDateString();
  const cutoff = etDateString(addETDays(new Date(), days_ahead));

  let query = db('tax_filing_calendar').where('due_date', '<=', cutoff).orderBy('due_date');
  if (!include_filed) query = query.whereNot('status', 'filed');

  const filings = await query;

  const toDateStr = (v) => (v instanceof Date ? etDateString(v) : String(v).slice(0, 10));
  const overdue = filings.filter(f => toDateStr(f.due_date) < today && f.status !== 'filed');

  return {
    filings: filings.map(f => ({
      id: f.id, type: f.filing_type, title: f.title, period: f.period_label,
      due_date: f.due_date, status: f.status,
      amount_due: f.amount_due ? parseFloat(f.amount_due) : null,
      days_until: daysUntil(f.due_date),
      overdue: toDateStr(f.due_date) < today && f.status !== 'filed',
    })),
    overdue_count: overdue.length,
    next_due: filings[0] ? { title: filings[0].title, date: filings[0].due_date, days: daysUntil(filings[0].due_date) } : null,
  };
}


async function getQuarterlyEstimate(quarter) {
  const now = new Date();
  const { year, month } = etParts(now);
  const q = quarter || `Q${Math.floor((month - 1) / 3) + 1}`;
  const qNum = parseInt(q.replace('Q', ''));
  const startMonthIdx = (qNum - 1) * 3; // 0, 3, 6, 9 (zero-based)
  const startDate = `${year}-${String(startMonthIdx + 1).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(year, startMonthIdx + 3, 0)).getUTCDate();
  const endDate = `${year}-${String(startMonthIdx + 3).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  const revenue = await db('payments').where('status', 'paid').whereBetween('payment_date', [startDate, endDate]).sum('amount as total').first().catch(() => ({ total: 0 }));
  const expenses = await db('expenses').where('tax_year', String(year)).whereBetween('expense_date', [startDate, endDate]).sum('amount as total').first().catch(() => ({ total: 0 }));

  const grossIncome = parseFloat(revenue?.total || 0);
  const totalExpenses = parseFloat(expenses?.total || 0);
  const taxableIncome = Math.max(0, grossIncome - totalExpenses);

  // SE tax: 15.3% on 92.35% of net SE earnings (IRS Schedule SE)
  const seBase = taxableIncome * 0.9235;
  const selfEmployment = seBase * 0.153;

  // 50% of SE tax is deductible from AGI before federal income tax
  const incomeTaxBase = Math.max(0, taxableIncome - (selfEmployment * 0.5));
  const estimatedFederal = incomeTaxBase * 0.22; // rough 22% bracket estimate
  const estimatedState = 0; // Florida has no state income tax

  return {
    quarter: q,
    gross_income: Math.round(grossIncome),
    total_expenses: Math.round(totalExpenses),
    taxable_income: Math.round(taxableIncome),
    estimated_federal: Math.round(estimatedFederal),
    estimated_state: estimatedState,
    self_employment_tax: Math.round(selfEmployment),
    total_estimated: Math.round(estimatedFederal + selfEmployment),
    note: 'Florida has no state income tax. Federal rate estimated at 22%. SE tax is 15.3% on 92.35% of net earnings; 50% of SE tax is deducted before income tax. Consult your CPA for precise calculations.',
  };
}


async function getPnl(period) {
  try {
    // Call the existing PnL endpoint logic
    const now = new Date();
    const today = etDateString(now);
    const { year } = etParts(now);
    let startDate, endDate;
    switch (period) {
      case 'mtd':
        startDate = etMonthStart(now); endDate = today; break;
      case 'last_month':
        startDate = etMonthStart(now, -1); endDate = etMonthEnd(now, -1); break;
      case 'quarterly':
        startDate = etQuarterStart(now); endDate = today; break;
      case 'ytd':
        startDate = etYearStart(now); endDate = today; break;
      case 'last_year':
        startDate = `${year - 1}-01-01`; endDate = `${year - 1}-12-31`; break;
      default:
        startDate = etMonthStart(now); endDate = today;
    }

    // Revenue
    const revenue = await db('payments').where('status', 'paid').whereBetween('payment_date', [startDate, endDate])
      .sum('amount as total').count('* as count').first().catch(() => ({ total: 0, count: 0 }));

    // COGS (product costs from service records)
    const cogs = await db('service_records').whereBetween('service_date', [startDate, endDate]).where('status', 'completed')
      .sum('product_cost as products').sum('total_job_cost as total').first().catch(() => ({ products: 0, total: 0 }));

    // Operating expenses
    const opex = await db('expenses').whereBetween('expense_date', [startDate, endDate])
      .leftJoin('expense_categories', 'expenses.category_id', 'expense_categories.id')
      .select('expense_categories.name', db.raw('SUM(amount) as total'))
      .groupBy('expense_categories.name').orderByRaw('SUM(amount) DESC').catch(() => []);

    const totalRevenue = parseFloat(revenue?.total || 0);
    const totalCogs = parseFloat(cogs?.total || 0);
    const grossProfit = totalRevenue - totalCogs;
    const totalOpex = opex.reduce((s, e) => s + parseFloat(e.total || 0), 0);
    const netIncome = grossProfit - totalOpex;

    return {
      period, date_range: { from: startDate, to: endDate },
      revenue: Math.round(totalRevenue),
      cogs: Math.round(totalCogs),
      gross_profit: Math.round(grossProfit),
      gross_margin_pct: totalRevenue > 0 ? Math.round(grossProfit / totalRevenue * 100) : 0,
      operating_expenses: Math.round(totalOpex),
      opex_breakdown: opex.map(e => ({ category: e.name || 'Other', amount: Math.round(parseFloat(e.total || 0)) })),
      net_income: Math.round(netIncome),
      net_margin_pct: totalRevenue > 0 ? Math.round(netIncome / totalRevenue * 100) : 0,
    };
  } catch (err) {
    return { error: `P&L calculation failed: ${err.message}` };
  }
}


async function runTaxAdvisor() {
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    if (!process.env.ANTHROPIC_API_KEY) return { error: 'ANTHROPIC_API_KEY not set' };

    // Trigger the existing advisor endpoint internally
    const TaxAdvisor = require('../tax-advisor');
    if (TaxAdvisor && TaxAdvisor.runAnalysis) {
      const report = await TaxAdvisor.runAnalysis();
      return {
        success: true,
        report: {
          grade: report.grade,
          summary: report.executive_summary || report.summary,
          regulation_changes: report.regulationChanges?.length || 0,
          savings_opportunities: report.savingsOpportunities?.length || 0,
          deduction_gaps: report.deductionGaps?.length || 0,
          compliance_alerts: report.complianceAlerts?.length || 0,
        },
        note: 'Fresh analysis complete. Check advisor alerts for action items.',
      };
    }

    return { note: 'Tax advisor service not available. Run from the AI Advisor tab instead.' };
  } catch (err) {
    return { error: `Advisor failed: ${err.message}` };
  }
}


async function getAdvisorAlerts(status) {
  let query = db('tax_advisor_alerts').orderBy('created_at', 'desc');
  if (status !== 'all') query = query.where('status', status);

  const alerts = await query.limit(20).catch(() => []);

  const counts = await db('tax_advisor_alerts').select('status').count('* as count').groupBy('status').catch(() => []);
  const countMap = {};
  counts.forEach(c => { countMap[c.status] = parseInt(c.count); });

  return {
    alerts: alerts.map(a => ({
      id: a.id, type: a.type, priority: a.priority, title: a.title,
      description: a.description, estimated_savings: a.estimated_savings ? parseFloat(a.estimated_savings) : null,
      status: a.status, created: a.created_at,
    })),
    counts: countMap,
    total: alerts.length,
  };
}


async function getMileageSummary(yearInput) {
  const year = yearInput || String(etParts().year);
  const IRS_RATE = parseFloat(process.env.IRS_MILEAGE_RATE) || 0.70;
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  const stats = await db('mileage_log')
    .whereBetween('trip_date', [yearStart, yearEnd])
    .select(
      db.raw('COALESCE(SUM(distance_miles), 0) as total_miles'),
      db.raw("COALESCE(SUM(CASE WHEN purpose = 'business' THEN distance_miles ELSE 0 END), 0) as business_miles"),
      db.raw("COALESCE(SUM(CASE WHEN purpose = 'personal' THEN distance_miles ELSE 0 END), 0) as personal_miles"),
      db.raw('COUNT(*) as entries'),
    ).first().catch(() => ({ total_miles: 0, business_miles: 0, personal_miles: 0, entries: 0 }));

  const businessMiles = parseFloat(stats.business_miles || 0);
  const deduction = businessMiles * IRS_RATE;

  // Monthly breakdown
  const monthly = await db('mileage_log')
    .whereBetween('trip_date', [yearStart, yearEnd])
    .select(db.raw("TO_CHAR(trip_date, 'YYYY-MM') as month"), db.raw('SUM(distance_miles) as miles'))
    .groupByRaw("TO_CHAR(trip_date, 'YYYY-MM')").orderBy('month').catch(() => []);

  return {
    year,
    total_miles: parseFloat(stats.total_miles || 0),
    business_miles: businessMiles,
    personal_miles: parseFloat(stats.personal_miles || 0),
    irs_rate: IRS_RATE,
    estimated_deduction: Math.round(deduction),
    entries: parseInt(stats.entries || 0),
    monthly: monthly.map(m => ({ month: m.month, miles: parseFloat(m.miles || 0) })),
  };
}


async function getArAging(input) {
  const { min_amount = 0 } = input;

  const invoices = await db('invoices')
    .whereIn('status', ['sent', 'viewed', 'overdue'])
    .where('total', '>', min_amount)
    .leftJoin('customers', 'invoices.customer_id', 'customers.id')
    .select('invoices.*', 'customers.first_name', 'customers.last_name', 'customers.waveguard_tier', 'customers.phone')
    .orderBy('invoices.total', 'desc');

  const todayAnchor = parseETDateTime(etDateString() + 'T12:00');
  const aging = { current: 0, days_1_30: 0, days_31_60: 0, days_61_90: 0, days_90_plus: 0 };
  let total = 0;

  invoices.forEach(i => {
    const amt = parseFloat(i.total || 0);
    total += amt;
    let age = 0;
    if (i.due_date) {
      const dueStr = i.due_date instanceof Date ? etDateString(i.due_date) : String(i.due_date).slice(0, 10);
      const dueAnchor = parseETDateTime(dueStr + 'T12:00');
      age = Math.floor((todayAnchor - dueAnchor) / 86400000);
    }
    if (age <= 0) aging.current += amt;
    else if (age < 30) aging.days_1_30 += amt;
    else if (age < 60) aging.days_31_60 += amt;
    else if (age < 90) aging.days_61_90 += amt;
    else aging.days_90_plus += amt;
  });

  return {
    total_outstanding: Math.round(total),
    invoice_count: invoices.length,
    aging: {
      current: Math.round(aging.current),
      '1_30_days': Math.round(aging.days_1_30),
      '31_60_days': Math.round(aging.days_31_60),
      '61_90_days': Math.round(aging.days_61_90),
      '90_plus_days': Math.round(aging.days_90_plus),
    },
    top_balances: invoices.slice(0, 10).map(i => ({
      customer: `${i.first_name} ${i.last_name}`, tier: i.waveguard_tier,
      amount: parseFloat(i.total || 0), status: i.status,
      due_date: i.due_date, phone: i.phone,
    })),
  };
}


module.exports = { TAX_TOOLS, executeTaxTool };
