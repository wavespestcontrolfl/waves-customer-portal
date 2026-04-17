// server/services/dispatch/insight-engine.js
const { etDateString, addETDays } = require('../../utils/datetime-et');

let db;
function getDb() {
  if (!db) db = require('../../models/db');
  return db;
}

async function getDashboardMetrics(days = 30) {
  const since = etDateString(addETDays(new Date(), -days));

  const techs = await getDb()('dispatch_technicians').where('active', true);

  const techMetrics = techs.map((t) => ({
    id: t.id,
    name: t.name,
    color: t.color,
    revenuePerHour: t.revenue_per_hour,
    completionRate: Math.round(t.completion_rate * 100),
    upsellRate: Math.round(t.upsell_rate * 100),
    callbackRate: Math.round(t.callback_rate * 100),
    serviceLines: t.service_lines || [],
  }));

  // Route session aggregates
  const sessions = await getDb()('dispatch_route_sessions').where('date', '>=', since);
  const avgDrivePct = sessions.length ? Math.round(sessions.reduce((s, r) => s + r.drive_time_pct, 0) / sessions.length) : 22;
  const avgRevPerHr = sessions.length ? Math.round(sessions.reduce((s, r) => s + r.revenue_per_hour, 0) / sessions.length) : 118;

  // Job stats
  const jobs = await getDb()('dispatch_jobs').where('scheduled_date', '>=', since);
  const completed = jobs.filter((j) => j.status === 'complete').length;
  const completionRate = jobs.length ? Math.round((completed / jobs.length) * 100) : 94;
  const callbacks = jobs.filter((j) => j.job_category === 'callback').length;
  const callbackRate = jobs.length ? Math.round((callbacks / jobs.length) * 100) : 4;

  // Actual revenue from completed service_records (the portal's source of truth)
  let actualRevenue = 0;
  try {
    const actuals = await getDb()('service_records')
      .where('service_date', '>=', since)
      .where('status', 'completed')
      .sum('revenue as total')
      .first();
    actualRevenue = Math.round(parseFloat(actuals?.total || 0));
  } catch { /* service_records may not have revenue column populated */ }

  const expectedRevenue = sessions.length
    ? Math.round(sessions.reduce((s, r) => s + parseFloat(r.expected_revenue || 0), 0))
    : jobs.reduce((s, j) => s + parseFloat(j.estimated_revenue || 0), 0);
  const revenueVariance = actualRevenue - expectedRevenue;

  // Seasonal forecast — SWFL pest/lawn seasonality
  const forecast = [
    { service: 'Mosquito', demandPct: 95, note: 'Peak season — push now' },
    { service: 'Lawn fert + weed', demandPct: 88, note: 'Spring growth surge' },
    { service: 'Perimeter pest', demandPct: 80, note: 'Ant + roach pressure high' },
    { service: 'Tree & shrub', demandPct: 72, note: 'Pre-summer spray window' },
    { service: 'Termite', demandPct: 65, note: 'Swarm season approaching' },
    { service: 'Aeration / seeding', demandPct: 55, note: 'Push with lawn customers' },
    { service: 'Rodent stations', demandPct: 40, note: 'Stable — routine outreach' },
  ];

  return {
    summary: { avgDrivePct, avgRevPerHr, completionRate, callbackRate, expectedRevenue, actualRevenue, revenueVariance },
    techMetrics,
    forecast,
    period: `${days} days`,
  };
}

module.exports = { getDashboardMetrics };
