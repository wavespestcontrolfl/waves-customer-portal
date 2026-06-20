const db = require('../models/db');
const logger = require('./logger');
const {
  addETDays,
  addETMonthsByWeekday,
  etDateString,
  etParts,
  parseETDateTime,
} = require('../utils/datetime-et');
const { TERMINAL_STATUSES } = require('./waveguard-existing-services');

const MONTH_RECURRENCE_INTERVALS = {
  monthly: 1,
  bimonthly: 2,
  quarterly: 3,
  triannual: 4,
  semiannual: 6,
  biannual: 6,
  annual: 12,
  yearly: 12,
};

const TIER_ORDER = ['Bronze', 'Silver', 'Gold', 'Platinum'];
const WAVEGUARD_SERVICE_FAMILIES = ['pest_control', 'lawn_care', 'mosquito', 'tree_shrub', 'termite_bait'];
const ONE_TIME_BOOKING_SOURCE_VALUES = ['estimate-accept', 'quote-wizard-onetime'];
const ONE_TIME_BOOKING_SOURCES = new Set(ONE_TIME_BOOKING_SOURCE_VALUES);

function isOneTimeBookingSource(source) {
  return ONE_TIME_BOOKING_SOURCES.has(String(source || '').toLowerCase());
}

const PEST_CONTROL_RECURRING_PLANS = {
  quarterly: {
    planKey: 'pest_control_quarterly',
    serviceKey: 'pest_general_quarterly',
    serviceType: 'General Pest Control',
    label: 'Quarterly Pest Control',
    tier: 'Bronze',
    monthlyRate: 55,
    recurringPattern: 'quarterly',
    visitsPerYear: 4,
    targetAppointmentCount: 4,
  },
  bimonthly: {
    planKey: 'pest_control_bimonthly',
    serviceKey: 'pest_general_bimonthly',
    serviceType: 'General Pest Control',
    label: 'Bi-Monthly Pest Control',
    tier: 'Bronze',
    monthlyRate: 55,
    recurringPattern: 'bimonthly',
    visitsPerYear: 6,
    targetAppointmentCount: 4,
  },
  monthly: {
    planKey: 'pest_control_monthly',
    serviceKey: 'pest_general_monthly',
    serviceType: 'General Pest Control',
    label: 'Monthly Pest Control',
    tier: 'Bronze',
    monthlyRate: 45,
    recurringPattern: 'monthly',
    visitsPerYear: 12,
    targetAppointmentCount: 4,
  },
  semiannual: {
    planKey: 'pest_control_semiannual',
    serviceKey: 'pest_general_semiannual',
    serviceType: 'General Pest Control',
    label: 'Semiannual Pest Control',
    tier: 'Bronze',
    monthlyRate: 75,
    recurringPattern: 'semiannual',
    visitsPerYear: 2,
    targetAppointmentCount: 4,
  },
};

const LAWN_CARE_RECURRING_PLANS = {
  monthly: {
    planKey: 'lawn_care_monthly',
    serviceKey: 'lawn_care_monthly',
    serviceType: 'Lawn Care',
    label: 'Monthly Lawn Care Program',
    tier: 'Bronze',
    monthlyRate: 65,
    recurringPattern: 'monthly',
    visitsPerYear: 12,
    targetAppointmentCount: 4,
  },
  every_6_weeks: {
    planKey: 'lawn_care_6week',
    serviceKey: 'lawn_care_6week',
    serviceType: 'Lawn Care',
    label: 'Every 6 Weeks Lawn Care Program',
    tier: 'Bronze',
    monthlyRate: 55,
    recurringPattern: 'custom',
    recurringIntervalDays: 42,
    visitsPerYear: 9,
    targetAppointmentCount: 4,
  },
  bimonthly: {
    planKey: 'lawn_care_bimonthly',
    serviceKey: 'lawn_care_recurring',
    serviceType: 'Lawn Care',
    label: 'Bi-Monthly Lawn Care Program',
    tier: 'Bronze',
    monthlyRate: 46,
    recurringPattern: 'bimonthly',
    visitsPerYear: 6,
    targetAppointmentCount: 4,
  },
  quarterly: {
    planKey: 'lawn_care_quarterly',
    serviceKey: 'lawn_care_quarterly',
    serviceType: 'Lawn Care',
    label: 'Quarterly Lawn Care Program',
    tier: 'Bronze',
    monthlyRate: 35,
    recurringPattern: 'quarterly',
    visitsPerYear: 4,
    targetAppointmentCount: 4,
  },
};

const TREE_SHRUB_RECURRING_PLANS = {
  bimonthly: {
    planKey: 'tree_shrub_bimonthly',
    serviceKey: 'tree_shrub_program',
    serviceType: 'Tree & Shrub Care',
    label: 'Bi-Monthly Tree & Shrub Program',
    tier: 'Bronze',
    monthlyRate: 50,
    recurringPattern: 'bimonthly',
    visitsPerYear: 6,
    targetAppointmentCount: 4,
  },
  every_6_weeks: {
    planKey: 'tree_shrub_6week',
    serviceKey: 'tree_shrub_6week',
    serviceType: 'Tree & Shrub Care',
    label: 'Every 6 Weeks Tree & Shrub Program',
    tier: 'Bronze',
    monthlyRate: 55,
    recurringPattern: 'custom',
    recurringIntervalDays: 42,
    visitsPerYear: 9,
    targetAppointmentCount: 4,
  },
};

const MOSQUITO_RECURRING_PLANS = {
  monthly: {
    planKey: 'mosquito_monthly',
    serviceKey: 'mosquito_monthly',
    serviceType: 'Mosquito Control',
    label: 'Monthly Mosquito Barrier Treatment',
    tier: 'Bronze',
    monthlyRate: 45,
    recurringPattern: 'monthly',
    visitsPerYear: 12,
    targetAppointmentCount: 4,
  },
  seasonal: {
    planKey: 'mosquito_seasonal',
    serviceKey: 'mosquito_seasonal',
    serviceType: 'Mosquito Control',
    label: 'Seasonal Mosquito Barrier Treatment',
    tier: 'Bronze',
    monthlyRate: 45,
    recurringPattern: 'monthly',
    visitsPerYear: 9,
    targetAppointmentCount: 4,
  },
};

const TERMITE_BAIT_QUARTERLY_PLAN = {
  planKey: 'termite_bait_quarterly',
  serviceKey: 'termite_bait',
  serviceType: 'Termite Bait Monitoring',
  label: 'Termite Bait Monitoring',
  tier: 'Bronze',
  monthlyRate: 35,
  recurringPattern: 'quarterly',
  visitsPerYear: 4,
  targetAppointmentCount: 4,
};

const TERMITE_BAIT_RECURRING_PLANS = {
  quarterly: TERMITE_BAIT_QUARTERLY_PLAN,
  monitoring: TERMITE_BAIT_QUARTERLY_PLAN,
  active_annual: {
    planKey: 'termite_bait_active_annual',
    serviceKey: 'termite_active_annual',
    serviceType: 'Termite Bait Service',
    label: 'Annual Active Bait Station Service',
    tier: 'Bronze',
    monthlyRate: 16.58,
    recurringPattern: 'annual',
    visitsPerYear: 1,
    targetAppointmentCount: 2,
  },
  active_quarterly: TERMITE_BAIT_QUARTERLY_PLAN,
};

const SELF_BOOKING_RECURRING_PLANS = {
  pest_control: PEST_CONTROL_RECURRING_PLANS.quarterly,
  pest_control_quarterly: PEST_CONTROL_RECURRING_PLANS.quarterly,
  pest_control_bimonthly: PEST_CONTROL_RECURRING_PLANS.bimonthly,
  pest_control_monthly: PEST_CONTROL_RECURRING_PLANS.monthly,
  pest_control_semiannual: PEST_CONTROL_RECURRING_PLANS.semiannual,
  lawn_care: {
    planKey: 'lawn_care',
    serviceKey: 'lawn_care_quarterly',
    serviceType: 'Lawn Care',
    label: 'Lawn Care Program',
    tier: 'Bronze',
    monthlyRate: 84,
    recurringPattern: 'quarterly',
    visitsPerYear: 4,
    targetAppointmentCount: 4,
  },
  lawn_care_monthly: LAWN_CARE_RECURRING_PLANS.monthly,
  lawn_care_6week: LAWN_CARE_RECURRING_PLANS.every_6_weeks,
  lawn_care_bimonthly: LAWN_CARE_RECURRING_PLANS.bimonthly,
  lawn_care_quarterly: LAWN_CARE_RECURRING_PLANS.quarterly,
  mosquito: MOSQUITO_RECURRING_PLANS.monthly,
  mosquito_monthly: MOSQUITO_RECURRING_PLANS.monthly,
  mosquito_seasonal: MOSQUITO_RECURRING_PLANS.seasonal,
  tree_shrub: TREE_SHRUB_RECURRING_PLANS.bimonthly,
  tree_shrub_bimonthly: TREE_SHRUB_RECURRING_PLANS.bimonthly,
  tree_shrub_6week: TREE_SHRUB_RECURRING_PLANS.every_6_weeks,
  termite_bait: TERMITE_BAIT_RECURRING_PLANS.quarterly,
  termite_bait_quarterly: TERMITE_BAIT_RECURRING_PLANS.quarterly,
  termite_bait_monitoring: TERMITE_BAIT_RECURRING_PLANS.monitoring,
  termite_bait_active_annual: TERMITE_BAIT_RECURRING_PLANS.active_annual,
  termite_bait_active_quarterly: TERMITE_BAIT_RECURRING_PLANS.active_quarterly,
};

function normalizeDateString(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.split('T')[0];
  // pg/Knex DATE columns (scheduled_date) arrive as midnight Date objects; on a UTC
  // server etDateString() would shift them to the previous ET day. Read the stored
  // calendar date directly (repo DATE-column convention) instead of converting as an instant.
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return etDateString(value);
}

function normalizeServiceText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Re-service callbacks are free re-treatments under an existing plan and are never
// recurring plan coverage for any family. detectServiceKeys() now feeds the catalog
// service_key/name into the family resolvers, so a callback key (e.g. lawn_re_service)
// must be rejected here or a lawn/mosquito/tree-shrub/termite resolver would read it
// as plan coverage and (mis)set tier/monthly_rate. The pest resolver already inlines
// this exclusion.
const NON_PLAN_RECURRING_SERVICE_RE = /\b(re[-\s]?service|callback)\b/;
function isNonPlanRecurringServiceText(value) {
  return NON_PLAN_RECURRING_SERVICE_RE.test(normalizeServiceText(value));
}

function resolvePestControlRecurringPlan(serviceType) {
  const raw = String(serviceType || '').toLowerCase();
  const text = normalizeServiceText(serviceType);
  if (!text.includes('general pest') && !/\b(pest|perimeter|roach|ant|spider)\b/.test(text) && !raw.includes('pest_general')) return null;
  if (/\b(re[-\s]?service|callback|one[-\s]?time|cleanout|inspection)\b/.test(text)) return null;

  if (
    raw.includes('pest_general_semiannual')
    || /\bsemi[-\s]?annual\b/.test(text)
    || /\bevery\s*6\s*months?\b/.test(text)
    || /\b2\s*(visits?|apps?|applications?)\b/.test(text)
  ) {
    return PEST_CONTROL_RECURRING_PLANS.semiannual;
  }
  if (
    raw.includes('pest_general_bimonthly')
    || /\bbi[-\s]?monthly\b/.test(text)
    || /\bevery\s*(other|2)\s*months?\b/.test(text)
    || /\b6\s*(visits?|apps?|applications?)\b/.test(text)
  ) {
    return PEST_CONTROL_RECURRING_PLANS.bimonthly;
  }
  if (
    raw.includes('pest_general_monthly')
    || /\bmonthly\b/.test(text)
    || /\b12\s*(visits?|apps?|applications?)\b/.test(text)
  ) {
    return PEST_CONTROL_RECURRING_PLANS.monthly;
  }
  if (
    raw.includes('pest_general_quarterly')
    || /\bquarterly\b/.test(text)
    || /\bevery\s*3\s*months?\b/.test(text)
    || /\b4\s*(visits?|apps?|applications?)\b/.test(text)
  ) {
    return PEST_CONTROL_RECURRING_PLANS.quarterly;
  }

  return PEST_CONTROL_RECURRING_PLANS.quarterly;
}

function resolveLawnCareRecurringPlan(serviceType) {
  const raw = String(serviceType || '').toLowerCase();
  const text = normalizeServiceText(serviceType);
  if (!/\b(lawn|turf|fertiliz|weed|grass)\b/.test(text) && !raw.includes('lawn_care')) return null;
  if (isNonPlanRecurringServiceText(serviceType)) return null;

  if (
    raw.includes('lawn_care_6week')
    || /\b(every\s*)?6\s*weeks?\b/.test(text)
    || /\b42\s*days?\b/.test(text)
    || /\b(9\s*(apps?|applications?)|enhanced)\b/.test(text)
  ) {
    return LAWN_CARE_RECURRING_PLANS.every_6_weeks;
  }
  if (
    raw.includes('lawn_care_recurring')
    || /\bbi[-\s]?monthly\b/.test(text)
    || /\bevery\s*2\s*months?\b/.test(text)
    || /\b(6\s*(apps?|applications?)|standard)\b/.test(text)
  ) {
    return LAWN_CARE_RECURRING_PLANS.bimonthly;
  }
  if (
    raw.includes('lawn_care_quarterly')
    || /\bquarterly\b/.test(text)
    || /\bevery\s*3\s*months?\b/.test(text)
    || /\b(4\s*(apps?|applications?)|basic)\b/.test(text)
  ) {
    return LAWN_CARE_RECURRING_PLANS.quarterly;
  }
  if (
    raw.includes('lawn_care_monthly')
    || /\b(monthly|12\s*(apps?|applications?)|premium)\b/.test(text)
  ) {
    return LAWN_CARE_RECURRING_PLANS.monthly;
  }

  return SELF_BOOKING_RECURRING_PLANS.lawn_care;
}

function resolveTreeShrubRecurringPlan(serviceType) {
  const raw = String(serviceType || '').toLowerCase();
  const text = normalizeServiceText(serviceType);
  if (!/\b(tree|shrub|ornamental)\b/.test(text) && !raw.includes('tree_shrub')) return null;
  if (/\b(palm|injection|one[-\s]?time)\b/.test(text)) return null;
  if (isNonPlanRecurringServiceText(serviceType)) return null;

  if (
    raw.includes('tree_shrub_6week')
    || /\b(every\s*)?6\s*weeks?\b/.test(text)
    || /\b42\s*days?\b/.test(text)
    || /\b9\s*(visits?|apps?|applications?)\b/.test(text)
  ) {
    return TREE_SHRUB_RECURRING_PLANS.every_6_weeks;
  }
  return TREE_SHRUB_RECURRING_PLANS.bimonthly;
}

function resolveMosquitoRecurringPlan(serviceType) {
  const raw = String(serviceType || '').toLowerCase();
  const text = normalizeServiceText(serviceType);
  if (!text.includes('mosquito') && !raw.includes('mosquito_')) return null;
  if (/\b(event|one[-\s]?time|single)\b/.test(text) || raw.includes('mosquito_one_time') || raw.includes('mosquito_event')) return null;
  if (isNonPlanRecurringServiceText(serviceType)) return null;

  if (
    raw.includes('mosquito_seasonal')
    || /\bseasonal\b/.test(text)
    || /\b9\s*(visits?|apps?|applications?)\b/.test(text)
    || /\bfeb(?:ruary)?\s*(through|to|-)\s*oct(?:ober)?\b/.test(text)
  ) {
    return MOSQUITO_RECURRING_PLANS.seasonal;
  }
  return MOSQUITO_RECURRING_PLANS.monthly;
}

function resolveTermiteBaitRecurringPlan(serviceType) {
  const raw = String(serviceType || '').toLowerCase();
  const text = normalizeServiceText(serviceType);
  if (!text.includes('termite') && !raw.includes('termite_')) return null;
  if (/\b(inspection|liquid|trench|trenching|pretreat|pre[-\s]?treat|spot|foam)\b/.test(text)) return null;
  if (!/\b(bait|monitor|monitoring|station|stations|sentricon|trelona|warranty|protection|bond|active)\b/.test(text)) return null;
  if (isNonPlanRecurringServiceText(serviceType)) return null;

  if (
    raw.includes('termite_active_annual')
    || (text.includes('active') && /\bannual\b/.test(text))
  ) {
    return TERMITE_BAIT_RECURRING_PLANS.active_annual;
  }
  return TERMITE_BAIT_RECURRING_PLANS.quarterly;
}

function resolveSelfBookedRecurringPlan(serviceType) {
  const raw = String(serviceType || '').toLowerCase();
  const text = normalizeServiceText(serviceType);
  if (!text) return null;

  const termitePlan = resolveTermiteBaitRecurringPlan(serviceType);
  if (termitePlan) return termitePlan;
  const mosquitoPlan = resolveMosquitoRecurringPlan(serviceType);
  if (mosquitoPlan) return mosquitoPlan;
  const treeShrubPlan = resolveTreeShrubRecurringPlan(serviceType);
  if (treeShrubPlan) return treeShrubPlan;
  const lawnPlan = resolveLawnCareRecurringPlan(serviceType);
  if (lawnPlan) return lawnPlan;
  const pestPlan = resolvePestControlRecurringPlan(serviceType);
  if (pestPlan) return pestPlan;
  return null;
}

function recurrenceOrdinalOptions(baseDateStr, opts = {}) {
  const safe = normalizeDateString(baseDateStr) || etDateString();
  const base = parseETDateTime(`${safe}T12:00`);
  if (isNaN(base.getTime())) return opts;
  const et = etParts(base);
  return {
    ...opts,
    nth: opts.nth != null && opts.nth !== '' && !isNaN(parseInt(opts.nth, 10))
      ? parseInt(opts.nth, 10)
      : Math.ceil(et.day / 7),
    weekday: opts.weekday != null && opts.weekday !== '' && !isNaN(parseInt(opts.weekday, 10))
      ? parseInt(opts.weekday, 10)
      : et.dayOfWeek,
  };
}

function nextRecurringDate(baseDateStr, pattern, occurrenceIndex, opts = {}) {
  const safeBaseStr = normalizeDateString(baseDateStr) || etDateString();
  const base = parseETDateTime(`${safeBaseStr}T12:00`);
  if (isNaN(base.getTime())) return safeBaseStr;

  const monthInterval = MONTH_RECURRENCE_INTERVALS[pattern];
  if (monthInterval) {
    return etDateString(addETMonthsByWeekday(base, monthInterval * occurrenceIndex, opts));
  }

  const dayIntervals = { daily: 1, weekly: 7, biweekly: 14, every_6_weeks: 42 };
  const customInterval = Number.parseInt(opts.intervalDays || opts.recurringIntervalDays || opts.recurring_interval_days, 10);
  if (pattern === 'custom' && Number.isFinite(customInterval) && customInterval > 0) {
    return etDateString(addETDays(base, customInterval * occurrenceIndex));
  }
  const gapDays = dayIntervals[pattern] || 91;
  return etDateString(addETDays(base, gapDays * occurrenceIndex));
}

function buildRecurringOccurrenceDates(baseDateStr, pattern, count = 4, opts = {}) {
  const safeBaseStr = normalizeDateString(baseDateStr) || etDateString();
  const resolvedOpts = recurrenceOrdinalOptions(safeBaseStr, opts);
  return Array.from({ length: Math.max(1, count) }, (_, index) => (
    index === 0 ? safeBaseStr : nextRecurringDate(safeBaseStr, pattern, index, resolvedOpts)
  ));
}

function activeTierRank(tier) {
  return TIER_ORDER.indexOf(tier);
}

function normalizeTierName(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return null;
  return TIER_ORDER.find(tier => tier.toLowerCase() === text) || null;
}

function rawTextForServiceRow(row = {}) {
  return String([
    row.service_type,
    row.serviceType,
    row.type,
    row.service_key,
    row.serviceKey,
    row.service_name,
    row.serviceName,
    row.name,
    row.label,
  ].filter(Boolean).join(' ')).toLowerCase();
}

function detectWaveGuardPlanKeys(row = {}) {
  const rawText = rawTextForServiceRow(row);
  const keys = [];
  const add = (key) => {
    if (SELF_BOOKING_RECURRING_PLANS[key] && !keys.includes(key)) keys.push(key);
  };

  const termitePlan = resolveTermiteBaitRecurringPlan(rawText);
  if (termitePlan) add(termitePlan.planKey || 'termite_bait');
  const mosquitoPlan = resolveMosquitoRecurringPlan(rawText);
  if (mosquitoPlan) add(mosquitoPlan.planKey || 'mosquito');
  const treeShrubPlan = resolveTreeShrubRecurringPlan(rawText);
  if (treeShrubPlan) add(treeShrubPlan.planKey || 'tree_shrub');
  const lawnPlan = resolveLawnCareRecurringPlan(rawText);
  if (lawnPlan) add(lawnPlan.planKey || 'lawn_care');
  const pestPlan = resolvePestControlRecurringPlan(rawText);
  if (pestPlan) add(pestPlan.planKey || 'pest_control');

  return keys;
}

function serviceFamilyKey(planKey) {
  const key = String(planKey || '');
  for (const family of WAVEGUARD_SERVICE_FAMILIES) {
    if (key === family || key.startsWith(`${family}_`)) return family;
  }
  return key || null;
}

function uniqueServiceFamilies(planKeys = []) {
  return Array.from(new Set(planKeys.map(serviceFamilyKey).filter(Boolean)));
}

function representativePlanKeys(planKeys = []) {
  const byFamily = new Map();
  for (const key of planKeys) {
    const family = serviceFamilyKey(key);
    if (family && !byFamily.has(family)) byFamily.set(family, key);
  }
  return Array.from(byFamily.values());
}

function inferTierFromServiceCount(serviceCount) {
  if (serviceCount >= 4) return 'Platinum';
  if (serviceCount >= 3) return 'Gold';
  if (serviceCount >= 2) return 'Silver';
  if (serviceCount >= 1) return 'Bronze';
  return null;
}

function isSelfBookedRow(row = {}) {
  return String(row.source || '').toLowerCase() === 'self_booked'
    || row.self_booking_id != null;
}

function serviceRowCountsTowardWaveGuard(row = {}) {
  if (isOneTimeBookingSource(row.source)) return false;
  if (TERMINAL_STATUSES.includes(String(row.status || '').toLowerCase())) return false;
  // Re-service callbacks are free re-treatments under an existing plan, never plan
  // coverage themselves — exclude them even when the row is flagged is_recurring.
  if (row.is_callback === true || row.is_callback === 1 || row.is_callback === '1' || row.is_callback === 'true') return false;
  return row.is_recurring === true || row.is_recurring === 1 || row.is_recurring === '1' || row.is_recurring === 'true';
}

function buildCustomerWaveGuardAlignmentUpdates(customer, detectedPlanKeys, customerColumns, today) {
  const updates = {};
  const detectedFamilyKeys = uniqueServiceFamilies(detectedPlanKeys);
  const inferredTier = inferTierFromServiceCount(detectedFamilyKeys.length);
  const normalizedExistingTier = normalizeTierName(customer?.waveguard_tier);
  const currentTierRank = normalizedExistingTier ? activeTierRank(normalizedExistingTier) : -1;
  const inferredTierRank = inferredTier ? activeTierRank(inferredTier) : -1;
  const existingRate = Number(customer?.monthly_rate || 0);

  if (!inferredTier) {
    return {
      updates,
      detectedFamilyKeys,
      inferredTier,
      monthlyRateEstimate: 0,
    };
  }

  if (customerColumns.active && customer?.active !== true) updates.active = true;
  if (customerColumns.pipeline_stage && customer?.pipeline_stage !== 'active_customer') {
    updates.pipeline_stage = 'active_customer';
    assignIfColumn(updates, customerColumns, 'pipeline_stage_changed_at', new Date());
  }

  if (customerColumns.waveguard_tier) {
    if (normalizedExistingTier && customer?.waveguard_tier !== normalizedExistingTier) {
      updates.waveguard_tier = normalizedExistingTier;
    }
    if (inferredTierRank > currentTierRank) {
      updates.waveguard_tier = inferredTier;
    }
  }

  if (customerColumns.member_since && !customer?.member_since) {
    updates.member_since = customer?.earliest_service_date || today;
  }

  const monthlyRateEstimate = representativePlanKeys(detectedPlanKeys)
    .reduce((sum, key) => sum + Number(SELF_BOOKING_RECURRING_PLANS[key]?.monthlyRate || 0), 0);
  if (customerColumns.monthly_rate && (!Number.isFinite(existingRate) || existingRate <= 0) && monthlyRateEstimate > 0) {
    updates.monthly_rate = Math.round(monthlyRateEstimate * 100) / 100;
  }

  return {
    updates,
    detectedFamilyKeys,
    inferredTier,
    monthlyRateEstimate: Math.round(monthlyRateEstimate * 100) / 100,
  };
}

async function columnInfo(database, tableName) {
  try {
    return await database(tableName).columnInfo();
  } catch (err) {
    logger.warn(`[self-booking-plan-sync] columnInfo failed for ${tableName}: ${err.message}`);
    return {};
  }
}

function assignIfColumn(payload, columns, column, value) {
  if (columns[column]) payload[column] = value;
}

async function resolveServiceId(database, serviceKey) {
  if (!serviceKey) return null;
  try {
    const service = await database('services').where({ service_key: serviceKey }).first('id');
    return service?.id || null;
  } catch (err) {
    logger.warn(`[self-booking-plan-sync] service lookup skipped for ${serviceKey}: ${err.message}`);
    return null;
  }
}

async function scheduledServiceRowsForCustomer(database, customerId) {
  try {
    return await database('scheduled_services as s')
      .leftJoin('services as svc', 's.service_id', 'svc.id')
      .where({ 's.customer_id': customerId })
      .whereNotIn('s.status', TERMINAL_STATUSES)
      .orderBy('s.scheduled_date', 'asc')
      .select(
        's.*',
        'svc.service_key',
        'svc.name as service_name',
      );
  } catch (err) {
    logger.warn(`[self-booking-plan-sync] joined service row lookup failed for ${customerId}: ${err.message}`);
    return database('scheduled_services')
      .where({ customer_id: customerId })
      .whereNotIn('status', TERMINAL_STATUSES)
      .orderBy('scheduled_date', 'asc')
      .select('*');
  }
}

async function syncCustomerWaveGuardPlanFromScheduledServices(options = {}) {
  const {
    database = db,
    log = logger,
    customerId,
    today = etDateString(),
  } = options;

  if (!customerId) return { synced: false, reason: 'missing_customer_id' };

  const customerColumns = await columnInfo(database, 'customers');
  const customer = await database('customers').where({ id: customerId }).first();
  if (!customer) return { synced: false, reason: 'customer_not_found' };

  // Public self-booking creates recurring rows WITHOUT activating a plan
  // (activateCustomerPlan:false → no tier/monthly_rate). Those rows are "pending
  // plan activation" and must not bootstrap membership on their own — otherwise a
  // single self-booked visit would promote the customer to active_customer and set a
  // tier/monthly_rate they never agreed to. Once the customer actually has a plan
  // (admin/estimate/payment activation set a tier or positive monthly_rate), their
  // self-booked rows count normally.
  const hasExistingPlan = !!normalizeTierName(customer.waveguard_tier) || Number(customer.monthly_rate || 0) > 0;

  const rows = await scheduledServiceRowsForCustomer(database, customerId);
  const recurringRows = rows
    .filter(serviceRowCountsTowardWaveGuard)
    .filter((row) => hasExistingPlan || !isSelfBookedRow(row));
  const detectedPlanKeys = [];
  let earliestServiceDate = null;

  for (const row of recurringRows) {
    const rowDate = normalizeDateString(row.scheduled_date);
    if (rowDate && (!earliestServiceDate || rowDate < earliestServiceDate)) earliestServiceDate = rowDate;
    for (const key of detectWaveGuardPlanKeys(row)) {
      if (!detectedPlanKeys.includes(key)) detectedPlanKeys.push(key);
    }
  }

  const alignment = buildCustomerWaveGuardAlignmentUpdates(
    { ...customer, earliest_service_date: earliestServiceDate },
    detectedPlanKeys,
    customerColumns,
    today,
  );

  if (Object.keys(alignment.updates).length) {
    await database('customers').where({ id: customerId }).update(alignment.updates);
  }

  if (alignment.inferredTier && Object.keys(alignment.updates).length) {
    database('activity_log').insert({
      customer_id: customerId,
      action: 'waveguard_plan_aligned',
      description: `Aligned WaveGuard ${alignment.inferredTier} from recurring service families`,
      metadata: {
        detected_plan_keys: detectedPlanKeys,
        detected_family_keys: alignment.detectedFamilyKeys,
        updates: alignment.updates,
      },
    }).catch((err) => log.warn(`[self-booking-plan-sync] waveguard alignment activity_log insert failed: ${err.message}`));
  }

  return {
    synced: true,
    customerUpdated: Object.keys(alignment.updates).length > 0,
    detectedPlanKeys,
    detectedFamilyKeys: alignment.detectedFamilyKeys,
    inferredTier: alignment.inferredTier,
    monthlyRateEstimate: alignment.monthlyRateEstimate,
    updates: alignment.updates,
  };
}

function buildCustomerActivationUpdates(customer, plan, customerColumns, memberSince) {
  const updates = {};
  const currentMonthlyRate = Number(customer?.monthly_rate || 0);
  const normalizedCurrentTier = normalizeTierName(customer?.waveguard_tier);
  const currentTierRank = normalizedCurrentTier ? activeTierRank(normalizedCurrentTier) : -1;

  assignIfColumn(updates, customerColumns, 'active', true);
  assignIfColumn(updates, customerColumns, 'pipeline_stage', 'active_customer');
  assignIfColumn(updates, customerColumns, 'pipeline_stage_changed_at', new Date());

  if (customerColumns.waveguard_tier) {
    if (normalizedCurrentTier && customer?.waveguard_tier !== normalizedCurrentTier) {
      updates.waveguard_tier = normalizedCurrentTier;
    } else if (currentTierRank < 0) {
      updates.waveguard_tier = plan.tier;
    }
  }
  if (customerColumns.monthly_rate && (!Number.isFinite(currentMonthlyRate) || currentMonthlyRate <= 0)) {
    updates.monthly_rate = plan.monthlyRate;
  }
  if (customerColumns.member_since && !customer?.member_since) {
    updates.member_since = memberSince;
  }

  return updates;
}

function buildScheduledServiceUpdates(plan, serviceColumns, serviceId, planCovered = true) {
  const updates = {};
  assignIfColumn(updates, serviceColumns, 'service_type', plan.serviceType);
  assignIfColumn(updates, serviceColumns, 'is_recurring', true);
  assignIfColumn(updates, serviceColumns, 'recurring_pattern', plan.recurringPattern);
  if (plan.recurringIntervalDays) {
    assignIfColumn(updates, serviceColumns, 'recurring_interval_days', plan.recurringIntervalDays);
  }
  assignIfColumn(updates, serviceColumns, 'recurring_ongoing', true);
  assignIfColumn(updates, serviceColumns, 'service_id', serviceId || null);
  // Only plan-covered (activated, monthly_rate set) visits bill via the plan and skip
  // the per-visit invoice. Do NOT set this flag for pending/non-activated self-booking
  // rows: they carry no explicit per-visit price, so forcing it true would invoice the
  // wrong amount (the customer's monthly_rate, or $0) and forcing it false would suppress
  // billing. Leaving it unset keeps the column default and the established operator-driven
  // completion billing (estimated_price → monthly_rate → $0) until a plan is activated.
  if (planCovered) {
    assignIfColumn(updates, serviceColumns, 'create_invoice_on_complete', false);
  }
  return updates;
}

function buildChildScheduledServiceRow({
  plan,
  serviceColumns,
  serviceId,
  parentService,
  scheduledDate,
  slotStart,
  slotEnd,
  durationMinutes,
  technicianId,
  zone,
  source,
  selfBookingId,
  planCovered = true,
}) {
  const row = {
    customer_id: parentService.customer_id,
    scheduled_date: scheduledDate,
    service_type: plan.serviceType,
    status: 'pending',
    customer_confirmed: false,
    notes: `Auto-scheduled from ${plan.label} self-booking.`,
  };

  assignIfColumn(row, serviceColumns, 'technician_id', technicianId || parentService.technician_id || null);
  assignIfColumn(row, serviceColumns, 'window_start', slotStart || parentService.window_start || null);
  assignIfColumn(row, serviceColumns, 'window_end', slotEnd || parentService.window_end || null);
  assignIfColumn(row, serviceColumns, 'source', source || parentService.source || 'self_booked');
  assignIfColumn(row, serviceColumns, 'self_booking_id', selfBookingId || parentService.self_booking_id || null);
  assignIfColumn(row, serviceColumns, 'estimated_duration_minutes', durationMinutes || parentService.estimated_duration_minutes || null);
  assignIfColumn(row, serviceColumns, 'zone', zone || parentService.zone || null);
  assignIfColumn(row, serviceColumns, 'is_recurring', true);
  assignIfColumn(row, serviceColumns, 'recurring_pattern', plan.recurringPattern);
  if (plan.recurringIntervalDays) {
    assignIfColumn(row, serviceColumns, 'recurring_interval_days', plan.recurringIntervalDays);
  }
  assignIfColumn(row, serviceColumns, 'recurring_parent_id', parentService.id);
  assignIfColumn(row, serviceColumns, 'recurring_ongoing', true);
  assignIfColumn(row, serviceColumns, 'service_id', serviceId || null);
  // See buildScheduledServiceUpdates: only plan-covered (activated) visits skip the
  // per-visit invoice. Pending self-booking children carry no per-visit price, so the
  // flag is left at the column default (operator-driven billing) until plan activation.
  if (planCovered) {
    assignIfColumn(row, serviceColumns, 'create_invoice_on_complete', false);
  }

  return row;
}

async function registerAppointmentReminders(appointments, customerId, plan, log = logger) {
  try {
    const AppointmentReminders = require('./appointment-reminders');
    for (const appointment of appointments) {
      try {
        await AppointmentReminders.registerAppointment(
          appointment.id,
          customerId,
          `${appointment.date}T${appointment.windowStart || '08:00'}`,
          plan.serviceType,
          'booking_new',
          { sendConfirmation: false }
        );
      } catch (err) {
        log.error(`[self-booking-plan-sync] appointment reminder registration failed for ${appointment.id}: ${err.message}`);
      }
    }
  } catch (err) {
    log.error(`[self-booking-plan-sync] appointment reminder service unavailable: ${err.message}`);
  }
}

async function syncSelfBookedRecurringPlan(options = {}) {
  const {
    database = db,
    log = logger,
    customerId,
    serviceRow,
    serviceType,
    slotDate,
    slotStart,
    slotEnd,
    technicianId,
    zone,
    durationMinutes,
    source,
    selfBookingId,
    activateCustomerPlan = true,
    registerReminders = true,
  } = options;

  const plan = resolveSelfBookedRecurringPlan(serviceType || serviceRow?.service_type);
  if (!plan) return { activated: false, reason: 'not_recurring_waveguard_service' };
  if (!customerId || !serviceRow?.id) return { activated: false, reason: 'missing_customer_or_service' };

  const baseDate = normalizeDateString(slotDate || serviceRow.scheduled_date) || etDateString();
  const customerColumns = await columnInfo(database, 'customers');
  const serviceColumns = await columnInfo(database, 'scheduled_services');
  const serviceId = await resolveServiceId(database, plan.serviceKey);
  const parentAppointments = [];
  const createdAppointments = [];

  const result = await database.transaction(async (trx) => {
    const customer = await trx('customers').where({ id: customerId }).first();
    if (!customer) throw new Error(`Customer not found for self-booking plan sync: ${customerId}`);

    const customerUpdates = activateCustomerPlan
      ? buildCustomerActivationUpdates(customer, plan, customerColumns, baseDate)
      : {};
    if (Object.keys(customerUpdates).length) {
      await trx('customers').where({ id: customerId }).update(customerUpdates);
    }

    const parentUpdates = buildScheduledServiceUpdates(plan, serviceColumns, serviceId, activateCustomerPlan);
    if (Object.keys(parentUpdates).length) {
      await trx('scheduled_services').where({ id: serviceRow.id }).update(parentUpdates);
    }

    const parentService = {
      ...serviceRow,
      ...parentUpdates,
      customer_id: customerId,
      scheduled_date: baseDate,
      window_start: slotStart || serviceRow.window_start,
      window_end: slotEnd || serviceRow.window_end,
      source: source || serviceRow.source || 'self_booked',
      self_booking_id: selfBookingId || serviceRow.self_booking_id,
      estimated_duration_minutes: durationMinutes || serviceRow.estimated_duration_minutes,
      zone: zone || serviceRow.zone,
    };

    parentAppointments.push({
      id: serviceRow.id,
      date: baseDate,
      windowStart: parentService.window_start || slotStart || '08:00',
    });

    const matchingRows = await trx('scheduled_services')
      .where({ customer_id: customerId })
      .whereNotIn('status', TERMINAL_STATUSES)
      .where('scheduled_date', '>=', baseDate)
      .andWhere(function () {
        this.where('recurring_parent_id', serviceRow.id)
          .orWhere(function () {
            this.where('id', serviceRow.id);
          });
      })
      .select('id', 'scheduled_date');

    const knownDates = new Set(matchingRows.map(row => normalizeDateString(row.scheduled_date)).filter(Boolean));
    let knownCount = matchingRows.length;
    const occurrenceDates = buildRecurringOccurrenceDates(baseDate, plan.recurringPattern, plan.targetAppointmentCount, {
      intervalDays: plan.recurringIntervalDays,
    });

    for (const scheduledDate of occurrenceDates.slice(1)) {
      if (knownCount >= plan.targetAppointmentCount) break;
      if (knownDates.has(scheduledDate)) continue;

      const childRow = buildChildScheduledServiceRow({
        plan,
        serviceColumns,
        serviceId,
        parentService,
        scheduledDate,
        slotStart,
        slotEnd,
        durationMinutes,
        technicianId,
        zone,
        source,
        selfBookingId,
        planCovered: activateCustomerPlan,
      });
      const [created] = await trx('scheduled_services').insert(childRow).returning('*');
      if (created?.id) {
        createdAppointments.push({
          id: created.id,
          date: normalizeDateString(created.scheduled_date) || scheduledDate,
          scheduled_date: normalizeDateString(created.scheduled_date) || scheduledDate,
          window_start: created.window_start || childRow.window_start || '08:00',
          service_type: created.service_type || childRow.service_type || plan.serviceType,
          windowStart: created.window_start || childRow.window_start || '08:00',
        });
      }
      knownDates.add(scheduledDate);
      knownCount += 1;
    }

    return {
      activated: true,
      plan: {
        serviceKey: plan.serviceKey,
        serviceType: plan.serviceType,
        tier: plan.tier,
        monthlyRate: plan.monthlyRate,
        recurringPattern: plan.recurringPattern,
        recurringIntervalDays: plan.recurringIntervalDays || null,
        visitsPerYear: plan.visitsPerYear || null,
      },
      customerUpdated: Object.keys(customerUpdates).length > 0,
      customerPlanActivationSkipped: !activateCustomerPlan,
      scheduledServiceUpdated: Object.keys(parentUpdates).length > 0,
      createdChildIds: createdAppointments.map(appt => appt.id),
      createdAppointments,
      existingAppointmentCount: matchingRows.length,
    };
  });

  if (activateCustomerPlan) {
    try {
      result.customerPlanSync = await syncCustomerWaveGuardPlanFromScheduledServices({
        database,
        log,
        customerId,
        today: baseDate,
      });
    } catch (err) {
      log.error(`[self-booking-plan-sync] customer WaveGuard tier alignment failed for ${customerId}: ${err.message}`);
    }
  }

  if (registerReminders) {
    await registerAppointmentReminders([...parentAppointments, ...createdAppointments], customerId, plan, log);
  }

  database('activity_log').insert({
    customer_id: customerId,
    action: activateCustomerPlan ? 'self_booking_plan_activated' : 'self_booking_recurring_plan_scheduled',
    description: activateCustomerPlan
      ? `Activated WaveGuard ${plan.tier} from ${plan.label} self-booking`
      : `Scheduled ${plan.label} self-booking pending WaveGuard plan activation`,
    metadata: {
      service_id: serviceRow.id,
      self_booking_id: selfBookingId || serviceRow.self_booking_id || null,
      plan: result.plan,
      created_child_ids: result.createdChildIds,
      customer_plan_activation_skipped: !activateCustomerPlan,
    },
  }).catch((err) => log.warn(`[self-booking-plan-sync] activity_log insert failed: ${err.message}`));

  return result;
}

module.exports = {
  LAWN_CARE_RECURRING_PLANS,
  MOSQUITO_RECURRING_PLANS,
  ONE_TIME_BOOKING_SOURCE_VALUES,
  PEST_CONTROL_RECURRING_PLANS,
  SELF_BOOKING_RECURRING_PLANS,
  TERMITE_BAIT_RECURRING_PLANS,
  TREE_SHRUB_RECURRING_PLANS,
  buildChildScheduledServiceRow,
  buildCustomerActivationUpdates,
  buildCustomerWaveGuardAlignmentUpdates,
  buildRecurringOccurrenceDates,
  buildScheduledServiceUpdates,
  detectWaveGuardPlanKeys,
  inferTierFromServiceCount,
  isOneTimeBookingSource,
  isSelfBookedRow,
  normalizeTierName,
  representativePlanKeys,
  resolveLawnCareRecurringPlan,
  resolveMosquitoRecurringPlan,
  resolvePestControlRecurringPlan,
  resolveSelfBookedRecurringPlan,
  resolveTermiteBaitRecurringPlan,
  resolveTreeShrubRecurringPlan,
  serviceFamilyKey,
  serviceRowCountsTowardWaveGuard,
  syncCustomerWaveGuardPlanFromScheduledServices,
  syncSelfBookedRecurringPlan,
  uniqueServiceFamilies,
};
