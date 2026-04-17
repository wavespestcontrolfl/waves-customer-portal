const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { etDateString, etMonthStart, etMonthEnd, etQuarterStart, etYearStart, etParts, parseETDateTime } = require('../utils/datetime-et');

router.use(adminAuthenticate, requireTechOrAdmin);

function getPeriodDates(period, dateStr) {
  const d = dateStr ? parseETDateTime(dateStr + 'T12:00') : new Date();
  let start, end;
  if (period === 'month') {
    start = etMonthStart(d);
    end = etMonthEnd(d);
  } else if (period === 'quarter') {
    start = etQuarterStart(d);
    const { year, month } = etParts(d);
    const qEndMonth = Math.floor((month - 1) / 3) * 3 + 3; // 3, 6, 9, 12
    const lastDay = new Date(Date.UTC(year, qEndMonth, 0)).getUTCDate();
    end = `${year}-${String(qEndMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  } else {
    start = etYearStart(d);
    end = `${etParts(d).year}-12-31`;
  }
  return { start, end };
}

function classifyServiceLine(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('lawn')) return 'Lawn Care';
  if (t.includes('mosquito')) return 'Mosquito';
  if (t.includes('tree') || t.includes('shrub')) return 'Tree & Shrub';
  if (t.includes('termite')) return 'Termite';
  if (t.includes('rodent')) return 'Rodent';
  if (t.includes('one-time') || t.includes('one time')) return 'One-Time';
  return 'Pest Control';
}

// GET /api/admin/revenue/overview
router.get('/overview', async (req, res, next) => {
  try {
    const { period = 'month', date } = req.query;
    const { start, end } = getPeriodDates(period, date);

    // Get previous period for comparison
    const d = parseETDateTime(start + 'T12:00');
    let prevStart, prevEnd;
    if (period === 'month') {
      prevStart = etMonthStart(d, -1);
      prevEnd = etMonthEnd(d, -1);
    } else {
      const { year, month } = etParts(d);
      prevStart = `${year - 1}-${String(month).padStart(2, '0')}-01`;
      prevEnd = start;
    }

    const services = await db('service_records')
      .where('service_date', '>=', start).where('service_date', '<=', end)
      .where('status', 'completed')
      .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
      .leftJoin('customers', 'service_records.customer_id', 'customers.id')
      .select('service_records.*', 'technicians.name as tech_name', 'customers.waveguard_tier', 'customers.monthly_rate as cust_monthly');

    const prevServices = await db('service_records')
      .where('service_date', '>=', prevStart).where('service_date', '<=', prevEnd)
      .where('status', 'completed');

    const totalRev = services.reduce((s, r) => s + parseFloat(r.revenue || 0), 0);
    const totalCost = services.reduce((s, r) => s + parseFloat(r.total_job_cost || 0), 0);
    const totalProfit = totalRev - totalCost;
    const totalHours = services.reduce((s, r) => s + parseFloat(r.labor_hours || 0), 0);
    const prevRev = prevServices.reduce((s, r) => s + parseFloat(r.revenue || 0), 0);

    const mrr = await db('customers').where({ active: true }).whereNull('deleted_at').where('monthly_rate', '>', 0).sum('monthly_rate as total').first();
    const custCount = await db('customers').where({ active: true }).whereNull('deleted_at').count('* as count').first();

    // By service line
    const byLine = {};
    services.forEach(s => {
      const line = classifyServiceLine(s.service_type);
      if (!byLine[line]) byLine[line] = { revenue: 0, cost: 0, services: 0, hours: 0 };
      byLine[line].revenue += parseFloat(s.revenue || 0);
      byLine[line].cost += parseFloat(s.total_job_cost || 0);
      byLine[line].services++;
      byLine[line].hours += parseFloat(s.labor_hours || 0);
    });

    // By tier
    const byTier = {};
    services.forEach(s => {
      const tier = s.waveguard_tier || 'None';
      if (!byTier[tier]) byTier[tier] = { customers: new Set(), revenue: 0, services: 0 };
      byTier[tier].customers.add(s.customer_id);
      byTier[tier].revenue += parseFloat(s.revenue || 0);
      byTier[tier].services++;
    });

    // By technician
    const byTech = {};
    services.forEach(s => {
      const tech = s.tech_name || 'Unknown';
      if (!byTech[tech]) byTech[tech] = { revenue: 0, cost: 0, hours: 0, services: 0 };
      byTech[tech].revenue += parseFloat(s.revenue || 0);
      byTech[tech].cost += parseFloat(s.total_job_cost || 0);
      byTech[tech].hours += parseFloat(s.labor_hours || 0);
      byTech[tech].services++;
    });

    // Daily chart
    const daily = {};
    services.forEach(s => {
      const day = typeof s.service_date === 'string' ? s.service_date.split('T')[0] : etDateString(new Date(s.service_date));
      if (!daily[day]) daily[day] = { date: day, revenue: 0, cost: 0, services: 0 };
      daily[day].revenue += parseFloat(s.revenue || 0);
      daily[day].cost += parseFloat(s.total_job_cost || 0);
      daily[day].services++;
    });

    // Alerts
    const alerts = [];
    Object.entries(byLine).forEach(([line, data]) => {
      const margin = data.revenue > 0 ? ((data.revenue - data.cost) / data.revenue * 100) : 0;
      if (margin < 55) alerts.push({ type: 'low_margin', severity: 'warning', message: `${line} averaging ${margin.toFixed(1)}% margin — below 55% target` });
    });
    Object.entries(byTech).forEach(([tech, data]) => {
      const rpmh = data.hours > 0 ? data.revenue / data.hours : 0;
      if (rpmh < 120 && rpmh > 0) alerts.push({ type: 'rpmh_below_target', severity: 'info', message: `${tech}'s RPMH $${rpmh.toFixed(0)} is below $120 target` });
    });

    res.json({
      period: { start, end, label: parseETDateTime(start + 'T12:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'America/New_York' }) },
      topline: {
        totalRevenue: Math.round(totalRev * 100) / 100,
        totalCost: Math.round(totalCost * 100) / 100,
        grossProfit: Math.round(totalProfit * 100) / 100,
        grossMarginPct: totalRev > 0 ? Math.round((totalProfit / totalRev) * 1000) / 10 : 0,
        mrr: parseFloat(mrr?.total || 0),
        arr: parseFloat(mrr?.total || 0) * 12,
        activeCustomers: parseInt(custCount?.count || 0),
        revenuePerManHour: totalHours > 0 ? Math.round((totalRev / totalHours) * 100) / 100 : 0,
        totalLaborHours: Math.round(totalHours * 10) / 10,
        totalServices: services.length,
      },
      vsLastPeriod: {
        revenueChange: prevRev > 0 ? Math.round(((totalRev - prevRev) / prevRev) * 1000) / 10 : 0,
      },
      byServiceLine: Object.entries(byLine).map(([line, d]) => ({
        serviceLine: line, revenue: Math.round(d.revenue), cost: Math.round(d.cost),
        margin: d.revenue > 0 ? Math.round((d.revenue - d.cost) / d.revenue * 1000) / 10 : 0,
        services: d.services, rpmh: d.hours > 0 ? Math.round(d.revenue / d.hours * 100) / 100 : 0,
        avgJobRevenue: d.services > 0 ? Math.round(d.revenue / d.services * 100) / 100 : 0,
      })).sort((a, b) => b.revenue - a.revenue),
      byTier: Object.entries(byTier).map(([tier, d]) => ({
        tier, customers: d.customers.size, revenue: Math.round(d.revenue), services: d.services,
        avgMonthly: d.customers.size > 0 ? Math.round(d.revenue / d.customers.size) : 0,
      })).sort((a, b) => b.revenue - a.revenue),
      byTechnician: Object.entries(byTech).map(([tech, d]) => ({
        tech, services: d.services, hours: Math.round(d.hours * 10) / 10,
        revenue: Math.round(d.revenue), cost: Math.round(d.cost),
        rpmh: d.hours > 0 ? Math.round(d.revenue / d.hours * 100) / 100 : 0,
        margin: d.revenue > 0 ? Math.round((d.revenue - d.cost) / d.revenue * 1000) / 10 : 0,
      })).sort((a, b) => b.revenue - a.revenue),
      revenueChart: { daily: Object.values(daily).sort((a, b) => a.date.localeCompare(b.date)) },
      alerts,
    });
  } catch (err) { next(err); }
});

// GET /api/admin/revenue/settings
router.get('/settings', async (req, res, next) => {
  try {
    const settings = await db('company_financials').orderBy('effective_date', 'desc').first();
    res.json({ settings });
  } catch (err) { next(err); }
});

// PUT /api/admin/revenue/settings
router.put('/settings', async (req, res, next) => {
  try {
    const { loadedLaborRate, driveCostPerStop, targetGrossMarginPct, targetRpmh } = req.body;
    await db('company_financials').insert({
      effective_date: etDateString(),
      loaded_labor_rate: loadedLaborRate || 35,
      drive_cost_per_stop: driveCostPerStop || 6,
      target_gross_margin_pct: targetGrossMarginPct || 55,
      target_rpmh: targetRpmh || 120,
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
