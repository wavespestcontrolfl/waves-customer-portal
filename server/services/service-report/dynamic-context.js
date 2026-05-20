const db = require('../../models/db');
const logger = require('../logger');
const { buildWavesAiSummaryContext } = require('./ai-summary');
const { buildNeighborhoodPressureContext } = require('./neighborhood-pressure');
const { buildPremiumExperienceContext } = require('./premium-experience');
const { buildPressureTrendContext } = require('./pressure-trend');
const { buildReentryContext } = require('./reentry');
const { buildSinceLastVisitContext } = require('./since-last-visit');
const { loadActiveConfig, loadScoreForServiceRecord } = require('../pest-pressure/store');
const { buildPestPressureCustomerView } = require('../pest-pressure/customer-view');

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
  // Caller may force-omit. When undefined (the common case), we compute
  // the visibility decision internally so PDF and email render paths —
  // which don't know about the pest-pressure module — still respect
  // showOnCustomerReport + the service-line/recurrence scope without
  // having to thread the flag through manually.
  omitPestPressureContext,
  knex = db,
} = {}) {
  const record = await loadServiceRecordForDynamicContext(recordId, knex);
  if (!record) return {};

  let omitDecision = omitPestPressureContext;
  if (omitDecision === undefined) {
    // Internal visibility check — mirrors the gate in buildReportV1Data so
    // every caller of dynamic-context (PDF, email, public JSON) gets the
    // same answer without having to compute it themselves.
    try {
      const [config, scoreRow] = await Promise.all([
        loadActiveConfig(knex).catch(() => null),
        loadScoreForServiceRecord(knex, record.id).catch(() => null),
      ]);
      const view = buildPestPressureCustomerView({ config, scoreRow, serviceRecord: record });
      omitDecision = (view === null);
    } catch (err) {
      logger.warn('[service-report-dynamic] pest-pressure visibility check failed', { message: err.message });
      omitDecision = false;
    }
  }

  // Mask the column for downstream builders. Non-destructive — we don't
  // touch the DB row, only the in-memory copy we hand to the builders.
  if (omitDecision) {
    record.pressure_index = null;
  }

  const pressurePromise = omitDecision
    ? Promise.resolve(undefined)
    : safeBuild('pressure_trend', () => buildPressureTrendContext({
      record,
      currentPressureIndexOverride,
      knex,
    }));
  const sinceLastVisitPromise = omitDecision
    ? Promise.resolve(undefined)
    : safeBuild('since_last_visit', () => buildSinceLastVisitContext({
      record,
      currentPressureIndexOverride,
      knex,
    }));
  const neighborhoodPromise = omitDecision
    ? Promise.resolve(undefined)
    : safeBuild('neighborhood_pressure', () => buildNeighborhoodPressureContext({
      record,
      knex,
    }));

  const [pressureTrend, reentry, sinceLastVisit, neighborhoodPressure] = await Promise.all([
    pressurePromise,
    safeBuild('reentry', () => buildReentryContext({
      record,
      now,
      knex,
    })),
    sinceLastVisitPromise,
    neighborhoodPromise,
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
