const db = require('../../models/db');
const logger = require('../logger');
const { buildWavesAiSummaryContext } = require('./ai-summary');
const { buildNeighborhoodPressureContext } = require('./neighborhood-pressure');
const { buildPremiumExperienceContext } = require('./premium-experience');
const { buildPressureTrendContext } = require('./pressure-trend');
const { buildReentryContext } = require('./reentry');
const { buildSinceLastVisitContext } = require('./since-last-visit');

async function safeBuild(label, fn) {
  try {
    return await fn();
  } catch (err) {
    logger.warn('[service-report-dynamic] context module failed', {
      label,
      message: err.message,
    });
    return undefined;
  }
}

async function loadServiceRecordForDynamicContext(recordId, knex = db) {
  const customerCols = await knex('customers').columnInfo().catch(() => ({}));
  const customerSelect = [
    'customers.zip',
    customerCols.county ? 'customers.county' : null,
    customerCols.timezone ? 'customers.timezone' : null,
  ].filter(Boolean);
  return knex('service_records')
    .where({ 'service_records.id': recordId })
    .leftJoin('customers', 'service_records.customer_id', 'customers.id')
    .select(
      'service_records.*',
      ...customerSelect,
    )
    .first();
}

async function buildServiceReportDynamicContext({
  recordId,
  mode = 'live',
  now = new Date(),
  currentPressureIndexOverride,
  knex = db,
} = {}) {
  const record = await loadServiceRecordForDynamicContext(recordId, knex);
  if (!record) return {};

  const [pressureTrend, reentry, sinceLastVisit, neighborhoodPressure] = await Promise.all([
    safeBuild('pressure_trend', () => buildPressureTrendContext({
      record,
      currentPressureIndexOverride,
      knex,
    })),
    safeBuild('reentry', () => buildReentryContext({
      record,
      now,
      knex,
    })),
    safeBuild('since_last_visit', () => buildSinceLastVisitContext({
      record,
      currentPressureIndexOverride,
      knex,
    })),
    safeBuild('neighborhood_pressure', () => buildNeighborhoodPressureContext({
      record,
      knex,
    })),
  ]);

  const aiSummary = await safeBuild('ai_summary', () => buildWavesAiSummaryContext({
    record,
    pressureTrend,
    reentry,
    sinceLastVisit,
    now,
    knex,
  }));

  const premiumExperience = await safeBuild('premium_experience', () => buildPremiumExperienceContext({
    record,
    dynamicContext: {
      aiSummary,
      pressureTrend,
      reentry,
      sinceLastVisit,
    },
    now,
    knex,
  }));

  return {
    mode,
    aiSummary,
    pressureTrend,
    reentry,
    sinceLastVisit,
    neighborhoodPressure,
    premiumExperience,
    forecast30Day: undefined,
    visitAssistant: undefined,
    actionItems: undefined,
    yearSummary: undefined,
  };
}

module.exports = {
  buildServiceReportDynamicContext,
  loadServiceRecordForDynamicContext,
  safeBuild,
};
