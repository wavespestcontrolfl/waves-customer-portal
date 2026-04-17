const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');

/**
 * Revenue Forecasting Service
 * Calculates MRR, ARR, customer counts, and 30/60/90-day forecasts.
 */

async function getForecast() {
  const now = new Date();
  const todayStr = etDateString(now);

  // --- MRR / ARR ---
  const mrrResult = await db('customers')
    .where({ active: true })
    .where('monthly_rate', '>', 0)
    .sum('monthly_rate as total')
    .first();
  const mrr = parseFloat(mrrResult.total || 0);
  const arr = mrr * 12;

  // --- Customer counts ---
  const activeCount = await db('customers')
    .where({ active: true })
    .count('* as count')
    .first();

  const churnedCount = await db('customers')
    .where('pipeline_stage', 'churned')
    .count('* as count')
    .first();

  const atRiskCount = await db('customers')
    .where('pipeline_stage', 'at_risk')
    .count('* as count')
    .first();

  const customers = {
    active: parseInt(activeCount.count) || 0,
    churned: parseInt(churnedCount.count) || 0,
    atRisk: parseInt(atRiskCount.count) || 0,
  };

  // --- Forecast windows ---
  const next30 = await buildWindowForecast(todayStr, 30, mrr);
  const next60 = await buildWindowForecast(todayStr, 60, mrr);
  const next90 = await buildWindowForecast(todayStr, 90, mrr);

  // --- Growth metrics (last 30 days) ---
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split('T')[0];

  const newCustomers30d = await db('customers')
    .where('created_at', '>=', thirtyDaysAgoStr)
    .count('* as count')
    .first();

  const churnedCustomers30d = await db('customers')
    .where('pipeline_stage', 'churned')
    .where('pipeline_stage_changed_at', '>=', thirtyDaysAgoStr)
    .count('* as count')
    .first();

  const newCount = parseInt(newCustomers30d.count) || 0;
  const churnCount = parseInt(churnedCustomers30d.count) || 0;
  const netGrowth = newCount - churnCount;
  const growthPct = customers.active > 0
    ? Math.round((netGrowth / customers.active) * 10000) / 100
    : 0;

  const growth = {
    newCustomers30d: newCount,
    churnedCustomers30d: churnCount,
    netGrowth,
    growthPct,
  };

  return { mrr, arr, customers, next30, next60, next90, growth };
}

async function buildWindowForecast(todayStr, days, mrr) {
  const endDate = new Date(todayStr);
  endDate.setDate(endDate.getDate() + days);
  const endStr = endDate.toISOString().split('T')[0];

  // Recurring revenue for the window (pro-rate MRR by months)
  const months = days / 30;
  const recurring = Math.round(mrr * months * 100) / 100;

  // One-time scheduled services in the window
  // Use monthly_rate from the customer as a proxy for per-service value
  const scheduledResult = await db('scheduled_services')
    .where('scheduled_date', '>=', todayStr)
    .where('scheduled_date', '<=', endStr)
    .whereNotIn('status', ['cancelled', 'completed'])
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .sum('customers.monthly_rate as total')
    .first();
  const oneTimeScheduled = Math.round(parseFloat(scheduledResult.total || 0) * 100) / 100;

  // Pipeline: estimates sent/viewed * 25% conversion rate
  const pipelineResult = await db('estimates')
    .whereIn('status', ['sent', 'viewed'])
    .where('created_at', '>=', new Date(Date.now() - 90 * 86400000).toISOString())
    .sum('monthly_total as total')
    .first();
  // Annualize pipeline estimates over the window, with 25% conversion
  const pipelineMonthly = parseFloat(pipelineResult.total || 0);
  const pipelineEstimated = Math.round(pipelineMonthly * months * 0.25 * 100) / 100;

  const total = Math.round((recurring + oneTimeScheduled + pipelineEstimated) * 100) / 100;

  return { recurring, oneTimeScheduled, pipelineEstimated, total };
}

module.exports = { getForecast };
