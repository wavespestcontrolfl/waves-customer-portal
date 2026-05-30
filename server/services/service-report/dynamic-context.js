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
const {
  getProtocolWindowContext,
  summarizeProtocolContext,
} = require('../lawn-protocol-operating-layer');

const TRACK_BY_GRASS = {
  st_augustine: 'st_augustine',
  st_augustinegrass: 'st_augustine',
  floratam: 'st_augustine',
  palmetto: 'st_augustine',
  bitterblue: 'st_augustine',
  bermuda: 'bermuda',
  bermudagrass: 'bermuda',
  zoysia: 'zoysia',
  zoysiagrass: 'zoysia',
  bahia: 'bahia',
  bahiagrass: 'bahia',
};

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

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function loadLawnProtocolCompletion(record, knex) {
  if (!record?.id) return null;
  const hasTable = await knex.schema.hasTable('lawn_protocol_service_completions').catch(() => false);
  if (!hasTable) return null;

  return knex('lawn_protocol_service_completions as lpsc')
    .leftJoin('equipment_systems as es', 'lpsc.equipment_system_id', 'es.id')
    .leftJoin('equipment_calibrations as ec', 'lpsc.calibration_id', 'ec.id')
    .where('lpsc.service_record_id', record.id)
    .select(
      'lpsc.*',
      'es.name as equipment_system_name',
      'es.system_type as equipment_system_type',
      'es.tank_capacity_gal as equipment_tank_capacity_gal',
      'ec.calibration_status',
      'ec.verified_at as calibration_verified_at',
      'ec.verified_test_area_sqft',
      'ec.verified_captured_gallons',
    )
    .first()
    .catch(() => null);
}

async function loadAssignedLawnProtocol(record, knex) {
  if (!record?.scheduled_service_id) return null;
  const cols = await knex('scheduled_services').columnInfo().catch(() => ({}));
  if (!cols.lawn_protocol_key) return null;

  return knex('scheduled_services as ss')
    .leftJoin('equipment_systems as es', 'ss.assigned_equipment_system_id', 'es.id')
    .leftJoin('equipment_calibrations as ec', 'ss.assigned_calibration_id', 'ec.id')
    .where('ss.id', record.scheduled_service_id)
    .select(
      'ss.lawn_protocol_key',
      'ss.lawn_protocol_version',
      'ss.lawn_protocol_window_key',
      'ss.lawn_protocol_window_title',
      'ss.lawn_protocol_assignment_source',
      'ss.lawn_protocol_assigned_at',
      'ss.lawn_protocol_assignment_snapshot',
      'ss.assigned_equipment_system_id',
      'ss.assigned_calibration_id',
      'es.name as equipment_system_name',
      'es.system_type as equipment_system_type',
      'es.tank_capacity_gal as equipment_tank_capacity_gal',
      'ec.carrier_gal_per_1000',
      'ec.calibration_status',
      'ec.verified_at as calibration_verified_at',
      'ec.verified_test_area_sqft',
      'ec.verified_captured_gallons',
    )
    .first()
    .catch(() => null);
}

async function resolveAssignedProtocolId({ completion, assignment, knex }) {
  if (completion?.lawn_protocol_id) return completion.lawn_protocol_id;

  const protocolKey = completion?.protocol_key || assignment?.lawn_protocol_key || null;
  if (!protocolKey) return null;

  const query = knex('lawn_protocols').where({ protocol_key: protocolKey });
  const version = completion?.protocol_version || assignment?.lawn_protocol_version || null;
  if (version) query.where({ version });

  const protocol = await query
    .orderBy('effective_from', 'desc')
    .orderBy('created_at', 'desc')
    .first()
    .catch(() => null);
  return protocol?.id || null;
}

async function loadCustomerTurfTrack(record, knex) {
  if (!record?.customer_id) return null;
  const profile = await knex('customer_turf_profiles')
    .where({ customer_id: record.customer_id, active: true })
    .first()
    .catch(() => null);
  const track = profile?.track_key || TRACK_BY_GRASS[String(profile?.grass_type || '').toLowerCase()] || null;
  return track || null;
}

function publicInventoryDeduction(row = {}) {
  return {
    productId: row.productId || null,
    productName: row.productName || null,
    amount: numberOrNull(row.amount),
    amountUnit: row.amountUnit || null,
    status: row.status || null,
    warning: row.warning || null,
    deductedAmount: numberOrNull(row.deductedAmount),
    inventoryUnit: row.inventoryUnit || null,
  };
}

function attachProtocolOperationalContext(protocol, { completion, assignment } = {}) {
  if (!protocol) return null;
  const source = completion ? 'completion_ledger' : (assignment ? 'appointment_assignment' : 'seasonal_default');
  const snapshot = parseJson(assignment?.lawn_protocol_assignment_snapshot, {});
  const equipment = completion || assignment
    ? {
      systemId: completion?.equipment_system_id || assignment?.assigned_equipment_system_id || snapshot?.equipment?.systemId || null,
      calibrationId: completion?.calibration_id || assignment?.assigned_calibration_id || snapshot?.equipment?.calibrationId || null,
      systemName: completion?.equipment_system_name || assignment?.equipment_system_name || snapshot?.equipment?.systemName || null,
      systemType: completion?.equipment_system_type || assignment?.equipment_system_type || null,
      tankCapacityGal: numberOrNull(completion?.equipment_tank_capacity_gal || assignment?.equipment_tank_capacity_gal),
    }
    : null;
  const calibration = completion || assignment
    ? {
      status: completion?.calibration_status || assignment?.calibration_status || snapshot?.equipment?.calibrationStatus || null,
      carrierGalPer1000: numberOrNull(completion?.carrier_gal_per_1000 || assignment?.carrier_gal_per_1000 || snapshot?.equipment?.carrierGalPer1000),
      verifiedAt: completion?.calibration_verified_at || assignment?.calibration_verified_at || null,
      verifiedTestAreaSqft: numberOrNull(completion?.verified_test_area_sqft || assignment?.verified_test_area_sqft),
      verifiedCapturedGallons: numberOrNull(completion?.verified_captured_gallons || assignment?.verified_captured_gallons),
    }
    : null;
  const completionMetadata = parseJson(completion?.metadata, {});
  const inventoryDeductions = Array.isArray(completionMetadata.inventoryDeductions)
    ? completionMetadata.inventoryDeductions
    : [];
  const publicInventoryDeductions = inventoryDeductions.map(publicInventoryDeduction);
  const substitutions = Array.isArray(completionMetadata.substitutions)
    ? completionMetadata.substitutions
    : [];
  const application = completion
    ? {
      treatedSqft: numberOrNull(completion.treated_sqft),
      carrierGalPer1000: numberOrNull(completion.carrier_gal_per_1000),
      totalCarrierGal: numberOrNull(completion.total_carrier_gal),
      checklist: parseJson(completion.checklist, []),
      missingRequiredTasks: parseJson(completion.missing_required_tasks, []),
      expectedResponse: parseJson(completion.expected_response, {}),
      watchItems: parseJson(completion.watch_items, []),
      recheckDueDate: completion.recheck_due_date || null,
      inventory: {
        deductions: publicInventoryDeductions,
        deductedCount: inventoryDeductions.filter((row) => String(row?.status || '').startsWith('deducted')).length,
        warningCount: inventoryDeductions.filter((row) => row?.warning).length,
      },
      substitutions,
    }
    : null;

  return {
    ...protocol,
    source,
    assignment: assignment ? {
      protocolKey: assignment.lawn_protocol_key || snapshot?.protocol?.key || null,
      protocolVersion: assignment.lawn_protocol_version || snapshot?.protocol?.version || null,
      windowKey: assignment.lawn_protocol_window_key || snapshot?.protocol?.windowKey || null,
      windowTitle: assignment.lawn_protocol_window_title || snapshot?.protocol?.windowTitle || null,
      source: assignment.lawn_protocol_assignment_source || null,
      assignedAt: assignment.lawn_protocol_assigned_at || null,
    } : null,
    equipment,
    calibration,
    application,
  };
}

async function buildLawnProtocolReportContext(record, knex, now) {
  const completion = await loadLawnProtocolCompletion(record, knex);
  const assignment = completion ? null : await loadAssignedLawnProtocol(record, knex);
  const serviceDate = record.service_date
    ? new Date(`${String(record.service_date).slice(0, 10)}T12:00:00`)
    : now;
  const windowKey = completion?.window_key || assignment?.lawn_protocol_window_key || null;
  const protocolId = await resolveAssignedProtocolId({ completion, assignment, knex });
  const grassTrack = protocolId ? null : (await loadCustomerTurfTrack(record, knex)) || 'st_augustine';

  let context = null;
  if (windowKey) {
    context = await getProtocolWindowContext(knex, {
      serviceDate,
      protocolId,
      grassTrack,
      region: 'swfl',
      windowKey,
    });
  } else {
    context = await getProtocolWindowContext(knex, {
      serviceDate,
      protocolId,
      grassTrack,
      region: 'swfl',
    });
  }

  return attachProtocolOperationalContext(summarizeProtocolContext(context), { completion, assignment });
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
  pestPressureConfig,
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
      const configPromise = pestPressureConfig === undefined
        ? loadActiveConfig(knex).catch(() => null)
        : Promise.resolve(pestPressureConfig);
      const [config, scoreRow] = await Promise.all([
        configPromise,
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

  const lawnProtocolPromise = isLawnService(record)
    ? safeBuild('lawn_protocol', async () => {
      return buildLawnProtocolReportContext(record, knex, now);
    })
    : Promise.resolve(undefined);

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

  const [pressureTrend, reentry, sinceLastVisit, neighborhoodPressure, lawnProtocol] = await Promise.all([
    pressurePromise,
    safeBuild('reentry', () => buildReentryContext({
      record,
      now,
      knex,
    })),
    sinceLastVisitPromise,
    neighborhoodPromise,
    lawnProtocolPromise,
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
    lawnProtocol,
    premiumExperience,
    forecast30Day: undefined,
    visitAssistant: undefined,
    actionItems: undefined,
    yearSummary: undefined,
  };
}

function isLawnService(record = {}) {
  const text = String(record.service_type || record.service_line || record.service_name || '').toLowerCase();
  return text.includes('lawn')
    || text.includes('fertiliz')
    || text.includes('turf')
    || text.includes('grass');
}

module.exports = {
  buildServiceReportDynamicContext,
  loadServiceRecordForDynamicContext,
  safeBuild,
  isLawnService,
};
