const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');
const {
  addETDays,
  addETMonthsByWeekday,
  etDateString,
  etParts,
  parseETDateTime,
} = require('../utils/datetime-et');
const { TERMINAL_STATUSES, isMembershipCustomerRow } = require('./waveguard-existing-services');

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
// admin-manual-booking-resend: the admin "resend booking link" for a ONE-TIME
// accepted estimate (admin-estimates.js — it sends the estimate_accepted_onetime
// SMS template). It must carry one-time semantics like estimate-accept, or a
// pest resend seeds a quarterly follow-up series the customer never bought
// (Codex round-6 P2 on #2944). Keep in sync with the client's
// ONE_TIME_BOOKING_SOURCES (PublicBookingPage.jsx).
const ONE_TIME_BOOKING_SOURCE_VALUES = ['estimate-accept', 'quote-wizard-onetime', 'admin-manual-booking-resend'];
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
  // Light (4x) downsell tier (v4.5 mandate; catalog row seeded 20260718300000).
  // Without this plan a "Quarterly Tree & Shrub" row resolved to the
  // bimonthly plan and WaveGuard alignment assumed 6 visits (audit 2026-07-18).
  quarterly: {
    planKey: 'tree_shrub_quarterly',
    serviceKey: 'tree_shrub_quarterly',
    serviceType: 'Tree & Shrub Care',
    label: 'Quarterly Tree & Shrub Program (Light)',
    tier: 'Bronze',
    monthlyRate: 22, // v4.6 ts_monthly_floors.light
    recurringPattern: 'quarterly',
    visitsPerYear: 4,
    targetAppointmentCount: 3,
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
    // Seasonal = monthly cadence but only the Feb–Oct mosquito season (9 visits).
    // Generators must clamp planned occurrences to these months so an Oct anchor does
    // not produce Nov–Jan plan-covered visits (the pattern alone is unbounded monthly).
    seasonMonths: [2, 3, 4, 5, 6, 7, 8, 9, 10],
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
  tree_shrub_quarterly: TREE_SHRUB_RECURRING_PLANS.quarterly,
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

// Whether a text carries an explicit cadence signal. Catalog fields (service_key/name)
// are only authoritative for cadence when cadence-specific (e.g. lawn_care_monthly,
// tree_shrub_6week); a generic catalog FK (e.g. lawn_fertilization) has no cadence, so
// detection must fall through to service_type instead of short-circuiting on it.
const CADENCE_SIGNAL_RE = /weekly|monthly|quarterly|annual|yearly|seasonal|\d+\s*weeks?|\d+\s*months?|\d+week/;
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
  if (
    raw.includes('tree_shrub_quarterly')
    || /\bquarterly\b/.test(text)
    || /\bevery\s*3\s*months?\b/.test(text)
    || /\b4\s*(visits?|apps?|applications?)\b/.test(text)
    || /\blight\b/.test(text)
  ) {
    return TREE_SHRUB_RECURRING_PLANS.quarterly;
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

// Catalog-only text (service_key / service_name) — the authoritative cadence source.
// service_type labels can be stale (a lawn_care_monthly row still labeled "Quarterly
// Lawn Care"), so detection resolves from this first and only falls back to the full
// text when the catalog fields do not resolve.
function catalogTextForServiceRow(row = {}) {
  return String([
    row.service_key,
    row.serviceKey,
    row.service_name,
    row.serviceName,
    row.name,
  ].filter(Boolean).join(' ')).toLowerCase();
}

function detectWaveGuardPlanKeys(row = {}) {
  const fullText = rawTextForServiceRow(row);
  const catalogText = catalogTextForServiceRow(row);
  const catalogHasCadence = CADENCE_SIGNAL_RE.test(catalogText);
  const keys = [];
  const add = (key) => {
    if (SELF_BOOKING_RECURRING_PLANS[key] && !keys.includes(key)) keys.push(key);
  };
  // Trust the catalog cadence only when the catalog text is cadence-specific; otherwise
  // fall through to the full text so a real cadence in service_type still wins.
  const resolvePlan = (resolver) => (catalogHasCadence && resolver(catalogText)) || resolver(fullText);

  const termitePlan = resolvePlan(resolveTermiteBaitRecurringPlan);
  if (termitePlan) add(termitePlan.planKey || 'termite_bait');
  const mosquitoPlan = resolvePlan(resolveMosquitoRecurringPlan);
  if (mosquitoPlan) add(mosquitoPlan.planKey || 'mosquito');
  const treeShrubPlan = resolvePlan(resolveTreeShrubRecurringPlan);
  if (treeShrubPlan) add(treeShrubPlan.planKey || 'tree_shrub');
  const lawnPlan = resolvePlan(resolveLawnCareRecurringPlan);
  if (lawnPlan) add(lawnPlan.planKey || 'lawn_care');
  const pestPlan = resolvePlan(resolvePestControlRecurringPlan);
  if (pestPlan) add(pestPlan.planKey || 'pest_control');

  // Catalog FAMILY authority (Codex #3011 r12): when the catalog identity
  // resolves to at least one family, stale service_type text must not
  // contribute another — a 'Pest Control' service_type linked to
  // lawn_care_monthly is one lawn service, never pest + lawn. Cadence still
  // resolves through the logic above; this only prunes families the catalog
  // does not corroborate. Rows with no catalog identity are untouched.
  if (catalogText) {
    const catalogFamilies = uniqueServiceFamilies([
      resolveTermiteBaitRecurringPlan,
      resolveMosquitoRecurringPlan,
      resolveTreeShrubRecurringPlan,
      resolveLawnCareRecurringPlan,
      resolvePestControlRecurringPlan,
    ].map((resolver) => resolver(catalogText)?.planKey).filter(Boolean));
    if (catalogFamilies.length) {
      return keys.filter((key) => catalogFamilies.includes(serviceFamilyKey(key)));
    }
  }

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

// Mirrors membershipTierKey in waveguard-existing-services.js (not exported
// there) — used to recognize the commercial sentinel, which must never be
// converted into a WaveGuard tier (commercial plans are flat, outside tiers).
function tierSentinelKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Tier-only enrollment updates for a customer who is NOT yet a WaveGuard
// member (owner directive 2026-07-28: upcoming recurring qualifying services
// mean the customer belongs on a tier — 1 family = Bronze, 2 = Silver,
// 3 = Gold, 4+ = Platinum). Deliberately writes waveguard_tier ONLY: never
// monthly_rate (billing-cron monthly-charges any active customer with
// monthly_rate > 0 — a per-visit customer must stay per-visit), never
// member_since / pipeline_stage / active. Fail-closed on existing members
// (the alignment path owns them) and on the commercial sentinel.
function buildNoPlanTierEnrollmentUpdates(customer, detectedPlanKeys, customerColumns = {}) {
  const updates = {};
  const detectedFamilyKeys = uniqueServiceFamilies(detectedPlanKeys);
  const inferredTier = inferTierFromServiceCount(detectedFamilyKeys.length);
  if (isMembershipCustomerRow(customer || {})) return { updates, detectedFamilyKeys, inferredTier: null };
  if (tierSentinelKey(customer?.waveguard_tier) === 'commercial') return { updates, detectedFamilyKeys, inferredTier: null };
  if (!inferredTier || !customerColumns.waveguard_tier) return { updates, detectedFamilyKeys, inferredTier };
  // Enrollment REQUIRES persistable provenance (Codex #3011 r11 P1): a tier
  // stamped without waveguard_tier_source would surface as a NULL-provenance
  // "member" once the migration lands — permanently waiving deposits,
  // receiving member comms, and exempt from realignment. Until the column
  // exists, no enrollment happens (the nightly reconcile picks the customer
  // up after the migration runs).
  if (!customerColumns.waveguard_tier_source) return { updates, detectedFamilyKeys, inferredTier };
  updates.waveguard_tier = inferredTier;
  updates.waveguard_tier_source = 'auto';
  return { updates, detectedFamilyKeys, inferredTier };
}

// Billing lanes whose tier may be auto-realigned from schedule evidence.
// ALLOWLIST, not blocklist (Codex #3011 P1): every explicit paying lane —
// monthly_membership, annual_prepay (coverage paid up front; the prepaid-term
// lifecycle owns that state), per_application, and any future lane — is
// excluded by default. NULL stays realignable: legacy paying members always
// carry a positive monthly_rate, which the rate guard already excludes.
const LABEL_ONLY_REALIGN_LANES = ['per_visit', 'one_time'];

function isLabelOnlyLane(billingMode) {
  return billingMode == null || LABEL_ONLY_REALIGN_LANES.includes(billingMode);
}

// Tier re-alignment for LABEL-ONLY customers (owner follow-up 2026-07-28:
// the tier tracks upcoming recurring coverage in BOTH directions). Applies
// ONLY to customers whose tier is derived state — no positive monthly_rate
// and no explicit paying billing lane (see LABEL_ONLY_REALIGN_LANES). A
// PAYING member's tier is billing state owned by the cancellation/
// offboarding flow (customer-offboarding.js already clears waveguard_tier +
// monthly_rate on cancel); a transient schedule gap must never silently
// strip a paying member's membership. Moves the tier to exactly what the
// upcoming families support — up (a family added by import/direct edit that
// bypassed the booking-time sync), down (a family cancelled), or cleared to
// NULL (No Plan) when none remain.
function buildLabelOnlyTierRealignmentUpdates(customer, detectedPlanKeys, customerColumns = {}) {
  const updates = {};
  const detectedFamilyKeys = uniqueServiceFamilies(detectedPlanKeys);
  const inferredTier = inferTierFromServiceCount(detectedFamilyKeys.length);
  const currentTier = normalizeTierName(customer?.waveguard_tier);
  if (!currentTier) return { updates, detectedFamilyKeys, inferredTier };
  // Provenance gate (Codex #3011 r7 P1): only a tier this machinery stamped
  // ('auto') is derived state we may move. NULL provenance is a pre-existing
  // / unclassified tier — possibly a legitimate legacy member whose billing
  // lane is also intentionally NULL — and must never be auto-realigned.
  // Missing column (pre-migration environment) fail-closes the same way.
  if (!customerColumns.waveguard_tier_source) return { updates, detectedFamilyKeys, inferredTier };
  if (customer?.waveguard_tier_source !== 'auto') return { updates, detectedFamilyKeys, inferredTier };
  if (Number(customer?.monthly_rate || 0) > 0) return { updates, detectedFamilyKeys, inferredTier };
  if (!isLabelOnlyLane(customer?.billing_mode)) return { updates, detectedFamilyKeys, inferredTier };
  if (!customerColumns.waveguard_tier) return { updates, detectedFamilyKeys, inferredTier };
  const currentRank = activeTierRank(currentTier);
  const inferredRank = inferredTier ? activeTierRank(inferredTier) : -1;
  if (inferredRank === currentRank) return { updates, detectedFamilyKeys, inferredTier };
  updates.waveguard_tier = inferredTier;
  // A cleared label loses its provenance too, so re-enrollment starts clean.
  if (!inferredTier) updates.waveguard_tier_source = null;
  return { updates, detectedFamilyKeys, inferredTier };
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
  // Backfill a zero/missing monthly_rate for the explicit monthly_membership
  // lane, and for the legacy NULL lane ONLY when the tier is not an
  // auto-derived label (Codex #3011 r10: the NULL-lane repair predates this
  // PR and must keep working — a recognized legacy member with a zeroed rate
  // is outside billing-cron's positive-rate selection until repaired — while
  // an 'auto' label must never have a rate invented, since that would put a
  // per-visit customer into the monthly-charge pool). Explicit non-monthly
  // lanes (per_visit / per_application / annual_prepay / one_time) never
  // backfill.
  const rateBackfillLane = customer?.billing_mode === 'monthly_membership'
    || (customer?.billing_mode == null && customer?.waveguard_tier_source !== 'auto');
  let planRateComponents = null;
  if (
    customerColumns.monthly_rate
    && rateBackfillLane
    && (!Number.isFinite(existingRate) || existingRate <= 0)
    && monthlyRateEstimate > 0
  ) {
    updates.monthly_rate = Math.round(monthlyRateEstimate * 100) / 100;
    // Per-plan slices for the plan-rate ledger (codex #3245 r7): this
    // writer KNOWS each detected plan's rate — a rate minted without
    // components would hand the customer's first re-quote the
    // empty-ledger whole-scalar replace after the ledger gate flips.
    planRateComponents = {};
    for (const key of representativePlanKeys(detectedPlanKeys)) {
      const rate = Number(SELF_BOOKING_RECURRING_PLANS[key]?.monthlyRate || 0);
      if (rate > 0) planRateComponents[key] = (planRateComponents[key] || 0) + rate;
    }
  }

  return {
    updates,
    detectedFamilyKeys,
    inferredTier,
    monthlyRateEstimate: Math.round(monthlyRateEstimate * 100) / 100,
    planRateComponents,
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
    // The fallible catalog join runs in a nested transaction of its own:
    // inside a caller transaction a failed query marks the (savepoint)
    // transaction aborted, and the plain-select fallback below must not run
    // on an aborted handle or it dies with "current transaction is aborted"
    // (Codex #3011 r2). On a plain pool connection this is just a short
    // read-only transaction.
    return await database.transaction(async (inner) => inner('scheduled_services as s')
      .leftJoin('services as svc', 's.service_id', 'svc.id')
      .where({ 's.customer_id': customerId })
      .whereNotIn('s.status', TERMINAL_STATUSES)
      .orderBy('s.scheduled_date', 'asc')
      .select(
        's.*',
        'svc.service_key',
        'svc.name as service_name',
      ));
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
  // Inside a transaction (seeder hook savepoint, reconcile per-candidate
  // trx), take the customer row lock so concurrent syncs on the same
  // customer serialize: whichever runs second re-reads AFTER the first
  // commits and derives its decision from the settled tier + schedule
  // (Codex #3011 r2 — evidence-vs-write races). On a plain pool connection
  // forUpdate is a single-statement no-op, so this changes nothing there.
  let customerQuery = database('customers').where({ id: customerId }).first();
  if (database.isTransaction) customerQuery = customerQuery.forUpdate();
  const customer = await customerQuery;
  if (!customer) return { synced: false, reason: 'customer_not_found' };

  // Non-members: owner policy through 2026-07-27 was members-only re-alignment
  // (auto-enrolling would wrongly make per-visit customers monthly/autopay
  // billable). Owner directive 2026-07-28 supersedes the LABEL half: a
  // customer with upcoming recurring qualifying services is stamped a tier
  // automatically — but tier ONLY (buildNoPlanTierEnrollmentUpdates), so the
  // billing concern that motivated the old policy still holds. Gated behind
  // GATE_AUTO_WAVEGUARD_TIER; while off, the old members-only behavior is
  // byte-identical. The membership predicate rejects explicit non-member
  // sentinels (none/onetime/na/...) before the legacy monthly_rate fallback.
  if (!isMembershipCustomerRow(customer)) {
    if (!isEnabled('autoWaveguardTierEnroll')) {
      return { synced: false, reason: 'not_waveguard_enrolled' };
    }
    return enrollNoPlanCustomerTier({ database, log, customer, customerId, customerColumns, today });
  }

  // A LABEL-ONLY customer (auto-stamped tier, no positive rate, label-only
  // billing lane) never enters the member alignment below — it would set
  // active / pipeline_stage / member_since on the second sync, exactly the
  // non-tier mutations this feature promises never to make (Codex #3011
  // r4). Recognition is provenance-based and gate-INDEPENDENT (Codex r10):
  // stored 'auto' labels persist after the kill switch flips off, and while
  // dark they are left entirely UNTOUCHED rather than promoted to members —
  // gate off means no auto behavior, in either direction. Real paying
  // members (positive rate, paying lane, converted labels, legacy rate
  // members) still get the full alignment.
  if (isAutoDerivedTierLabelRow(customer)) {
    if (!isEnabled('autoWaveguardTierEnroll')) {
      return { synced: false, reason: 'auto_label_gate_off' };
    }
    const realignment = await realignLabelOnlyTierCustomer({ database, log, customerId, customerColumns, today });
    return { synced: true, labelOnly: true, ...realignment };
  }

  const rows = await scheduledServiceRowsForCustomer(database, customerId);
  const recurringRows = rows.filter(serviceRowCountsTowardWaveGuard);
  // With the auto-tier gate on, the member branch uses the SAME upcoming-only
  // evidence as enrollment and the nightly realignment — otherwise a stale
  // past pending row from one family plus a newly seeded family upgrades a
  // label beyond what upcoming coverage supports, and the bounded nightly
  // sampling can leave that mispricing in place for days (Codex #3011 r2).
  // Gate off keeps the legacy all-nonterminal evidence byte-identical.
  const upcomingOnly = isEnabled('autoWaveguardTierEnroll');
  const detectedPlanKeys = [];
  let earliestServiceDate = null;

  for (const row of recurringRows) {
    const rowDate = normalizeDateString(row.scheduled_date);
    if (rowDate && (!earliestServiceDate || rowDate < earliestServiceDate)) earliestServiceDate = rowDate;
    if (upcomingOnly && (!rowDate || rowDate < today)) continue;
    if (upcomingOnly && (isCommercialServiceRow(row) || isRodentLedServiceRow(row))) continue;
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
    if (alignment.updates.monthly_rate !== undefined && alignment.planRateComponents) {
      // Seed the detected per-plan components with the minted rate (codex
      // #3245 r7); gate-aware error policy lives in the helper.
      await require('./plan-rate-ledger')
        .seedLedgerComponents(database, customerId, alignment.planRateComponents, { source: 'plan_sync' });
    }
  }

  if (alignment.inferredTier && Object.keys(alignment.updates).length) {
    // Best-effort audit row written on the real pool connection (NOT `database`, which
    // may be a caller's transaction). A fire-and-forget insert on a passed-in trx could
    // run after that transaction commits ("transaction already complete") or poison it,
    // so it must use an independent connection.
    void db('activity_log').insert({
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

// Enrollment executor for the auto-tier directive. Evidence is UPCOMING
// coverage only (scheduled_date >= today) so a lapsed series never enrolls
// anyone — mirrors the --enroll-no-plan pass of
// scripts/align-waveguard-portal-records.js. The direct customers UPDATE
// fires zero customer communications: the membership.started email lives only
// in the admin PATCH route and the customers table has no DB triggers.
// Commercial service rows are NEVER auto-tier evidence, independently of the
// customer's sentinel (Codex #3011 r4 P1): an imported commercial customer
// whose tier is still NULL must not be stamped a residential WaveGuard tier
// off a "Commercial Pest Control" row — commercial plans are flat and outside
// tiers (mirrors the commercial exclusion in waveguard-existing-services'
// toQualifyingKeys).
function isCommercialServiceRow(row = {}) {
  return rawTextForServiceRow(row).includes('commercial');
}

// Rodent-led names ("Rodent Pest Control") are rodent service rows, not pest
// coverage — the authoritative qualifier (waveguard-existing-services
// toQualifyingKeys) returns no keys for them, but the per-family plan
// resolvers see the word "pest" and would map them to the quarterly pest
// plan (Codex #3011 r6 P1). Classified PER FIELD, not on concatenated text
// (Codex r7): a generic service_type ("Pest Control") in front of a rodent
// catalog name ("Rodent Pest Control") would otherwise read as pest-primary
// purely from token order across fields. Underscored catalog keys
// (rodent_general_one_time) are normalized so word boundaries match. Only a
// pest-primary combined name WITHIN one field ("Pest & Rodent Control")
// counts as pest coverage.
function textIsRodentLed(value) {
  const s = String(value || '').toLowerCase().replace(/[_-]+/g, ' ');
  if (!s) return false;
  return /\b(rodent|rats?|mouse|mice)\b/.test(s) && !/\bpest\b.*\brodent\b/.test(s);
}

function isRodentLedServiceRow(row = {}) {
  return [
    row.service_type,
    row.serviceType,
    row.type,
    row.service_key,
    row.serviceKey,
    row.service_name,
    row.serviceName,
    row.name,
    row.label,
  ].some(textIsRodentLed);
}

// Shared tier evidence: plan keys from UPCOMING (scheduled_date >= today)
// recurring qualifying rows — the basis for both enrollment and demotion, so
// the two directions can never disagree about what counts as coverage.
async function detectUpcomingRecurringPlanKeys(database, customerId, today) {
  const rows = await scheduledServiceRowsForCustomer(database, customerId);
  const detectedPlanKeys = [];
  for (const row of rows) {
    if (!serviceRowCountsTowardWaveGuard(row)) continue;
    if (isCommercialServiceRow(row) || isRodentLedServiceRow(row)) continue;
    const rowDate = normalizeDateString(row.scheduled_date);
    if (!rowDate || rowDate < today) continue;
    for (const key of detectWaveGuardPlanKeys(row)) {
      if (!detectedPlanKeys.includes(key)) detectedPlanKeys.push(key);
    }
  }
  return detectedPlanKeys;
}

async function enrollNoPlanCustomerTier({ database, log, customer, customerId, customerColumns, today }) {
  if (tierSentinelKey(customer?.waveguard_tier) === 'commercial') {
    return { synced: false, reason: 'commercial_customer' };
  }

  const detectedPlanKeys = await detectUpcomingRecurringPlanKeys(database, customerId, today);
  const enrollment = buildNoPlanTierEnrollmentUpdates(customer, detectedPlanKeys, customerColumns);
  if (!enrollment.inferredTier || !Object.keys(enrollment.updates).length) {
    return { synced: false, reason: 'no_upcoming_recurring_evidence', detectedPlanKeys };
  }

  // Compare-and-swap on the non-member snapshot (Codex #3011 P1 class): if a
  // concurrent flow made this customer a member (estimate accept stamping a
  // paid tier) between the read and this write, match zero rows rather than
  // overwrite the paid tier with an inferred label.
  let enrollWrite = database('customers').where({ id: customerId });
  if (customer?.waveguard_tier == null) {
    enrollWrite = enrollWrite.whereNull('waveguard_tier');
  } else {
    enrollWrite = enrollWrite.where('waveguard_tier', customer.waveguard_tier);
  }
  enrollWrite = enrollWrite.where(function notPayingRate() {
    this.whereNull('monthly_rate').orWhere('monthly_rate', '<=', 0);
  });
  const enrolledCount = await enrollWrite.update(enrollment.updates);
  if (!enrolledCount) {
    log.info(`[self-booking-plan-sync] tier enrollment skipped for ${customerId} — customer changed since read`);
    return { synced: false, reason: 'concurrent_change', detectedPlanKeys };
  }

  // Audit row on the SAME handle as the tier write, inside its own savepoint:
  // atomic with the caller's transaction (an accept that rolls back cannot
  // leave a durable audit row for an enrollment that never happened — Codex
  // #3011 r2), while an audit failure rolls back only the savepoint and never
  // poisons the tier write or the caller.
  await writeTierAuditRow(database, log, {
    customer_id: customerId,
    action: 'waveguard_tier_auto_enrolled',
    description: `Auto-enrolled WaveGuard ${enrollment.inferredTier} from upcoming recurring services`,
    metadata: {
      detected_plan_keys: detectedPlanKeys,
      detected_family_keys: enrollment.detectedFamilyKeys,
      updates: enrollment.updates,
    },
  });

  return {
    synced: true,
    enrolled: true,
    customerUpdated: true,
    detectedPlanKeys,
    detectedFamilyKeys: enrollment.detectedFamilyKeys,
    inferredTier: enrollment.inferredTier,
    updates: enrollment.updates,
  };
}

// True when a customer's tier is an auto-derived LABEL (gate on, recognized
// tier, no positive monthly_rate, label-only billing lane). Member-only
// MESSAGING gates must treat these customers as non-members (Codex #3011 r6
// P1): the 2026-07-28 directive promises the stamp itself never causes
// customer communications, so a per-visit customer who gained a label must
// not start receiving the new-recurring welcome or the WaveGuard app-intro
// email off the tier field alone. Fail-closed to false (legacy member
// behavior) on lookup errors and whenever the gate is off.
// Row-shape variant for callers that already hold the customer row (admin
// membership lifecycle emails). Provenance is factual, so this deliberately
// does NOT check the gate: once an 'auto' label exists, member-only
// messaging and paid-member exemptions must keep treating it as a label even
// if the gate is later switched off (no 'auto' rows exist before the gate
// ever flips, so pre-flip behavior is unchanged). A row without the
// provenance property (pre-migration) fails closed to member behavior.
function isAutoDerivedTierLabelRow(customer = {}) {
  return customer.waveguard_tier_source === 'auto'
    && !!normalizeTierName(customer.waveguard_tier)
    && Number(customer.monthly_rate || 0) <= 0
    && isLabelOnlyLane(customer.billing_mode);
}

// Tri-state provenance resolution — the ONE lookup every label-sensitive
// consumer shares (Codex #3011 r10 P1: a boolean forced "unknown" to
// impersonate one of the definite answers, and the money gates were
// inheriting the wrong one):
//   'label'     — the customer's tier is verifiably an auto-derived label.
//   'not_label' — verifiably NOT a label (no tier, real member shape, or
//                 manual/NULL provenance).
//   'unknown'   — provenance CANNOT be verified: lookup error, or a
//                 pre-migration schema where the column-guarded enrollment
//                 stamps tiers with no source column to record them.
//                 'unknown' only arises as a distinct state while the gate
//                 is on — before the gate ever flips, no labels exist, so
//                 unverifiable resolves to 'not_label' and every consumer
//                 behaves exactly as today.
// Fail directions live at the call sites: the money gates (deposit /
// card-on-file) treat anything except 'not_label' as label — the commitment
// gate stays required; the messaging gates do the same — the courtesy send
// is skipped. Both err away from granting member benefits on uncertainty.
async function tierLabelStatus(customerId, database = db) {
  if (!customerId) return 'not_label';
  try {
    // Direct columnInfo — NOT the local swallowing helper (Codex #3011 r12
    // P1): that helper catches lookup errors and returns {}, which would be
    // indistinguishable from a genuinely missing column and resolve
    // 'not_label' with the gate off. A schema-lookup failure must reach the
    // catch below and stay 'unknown'.
    const customerColumns = await database('customers').columnInfo();
    if (!customerColumns.waveguard_tier_source) {
      // Missing COLUMN is decidable by the gate: labels can only have been
      // stamped by gate-on code, which ships with (and deploys after) the
      // migration — so a schema without the column plus a dark gate means no
      // label can exist ('not_label', legacy behavior byte-identical), while
      // gate-on against the pre-migration schema may stamp unrecorded labels
      // ('unknown'). Enrollment additionally refuses to stamp without the
      // column (see buildNoPlanTierEnrollmentUpdates), making this window
      // belt-and-braces.
      return isEnabled('autoWaveguardTierEnroll') ? 'unknown' : 'not_label';
    }
    const customer = await database('customers').where({ id: customerId }).first();
    if (!customer) return 'not_label';
    return isAutoDerivedTierLabelRow(customer) ? 'label' : 'not_label';
  } catch {
    // Lookup ERROR is never decidable: previously stamped labels survive the
    // kill switch, so uncertainty stays 'unknown' regardless of the gate
    // (Codex #3011 r11) — the money gates keep their deposit/SetupIntent
    // required and the messaging gates stay silent until a clean read.
    return 'unknown';
  }
}

// Tier audit rows ride the same handle as the tier write they describe, in a
// nested savepoint: they commit and roll back WITH the caller's transaction
// (no durable audit for an enrollment a failed accept rolled back), and an
// insert failure rolls back only the savepoint — never the tier write.
async function writeTierAuditRow(database, log, row) {
  try {
    await database.transaction(async (inner) => {
      await inner('activity_log').insert(row);
    });
  } catch (err) {
    log.warn(`[self-booking-plan-sync] ${row.action} activity_log insert failed: ${err.message}`);
  }
}

// Compare-and-swap WHERE clauses for label-only tier writes (Codex #3011
// P1): re-assert the exact snapshot fields the decision was computed from, so
// a concurrent conversion to a paying membership (estimate accept setting
// tier/rate/lane) or an admin tier edit between the candidate read and this
// write matches zero rows instead of being clobbered.
function applyLabelOnlySnapshotGuards(query, customer, customerColumns) {
  let guarded = query;
  if (customer?.waveguard_tier == null) {
    guarded = guarded.whereNull('waveguard_tier');
  } else {
    guarded = guarded.where('waveguard_tier', customer.waveguard_tier);
  }
  guarded = guarded.where(function notPayingRate() {
    this.whereNull('monthly_rate').orWhere('monthly_rate', '<=', 0);
  });
  if (customerColumns.billing_mode) {
    guarded = guarded.where(function labelOnlyLane() {
      this.whereNull('billing_mode').orWhereIn('billing_mode', LABEL_ONLY_REALIGN_LANES);
    });
  }
  if (customerColumns.waveguard_tier_source) {
    guarded = guarded.where('waveguard_tier_source', 'auto');
  }
  return guarded;
}

// Realignment executor: move a label-only customer's tier to exactly what
// their upcoming coverage supports (up, down, or cleared). Runs in its own
// transaction holding the customer row lock (FOR UPDATE) across a FRESH
// customer read AND a fresh schedule-evidence read (Codex #3011 r2): a
// concurrent booking's sync takes the same lock, so whichever runs second
// re-derives from the settled state instead of clearing a tier whose new
// coverage it never saw. The CAS guards on the UPDATE stay as a second belt.
// Same no-comms guarantee as enrollment — a direct customers UPDATE; the
// membership started/canceled emails live only in the admin PATCH route and
// the offboarding flow.
async function realignLabelOnlyTierCustomer({ database, log, customerId, customerColumns, today }) {
  return database.transaction(async (trx) => {
    const customer = await trx('customers').where({ id: customerId }).forUpdate().first();
    if (!customer) return { realigned: false, reason: 'customer_missing' };

    const detectedPlanKeys = await detectUpcomingRecurringPlanKeys(trx, customerId, today);
    const realignment = buildLabelOnlyTierRealignmentUpdates(customer, detectedPlanKeys, customerColumns);
    if (!Object.keys(realignment.updates).length) {
      return { realigned: false, detectedPlanKeys };
    }

    const updatedCount = await applyLabelOnlySnapshotGuards(
      trx('customers').where({ id: customerId }),
      customer,
      customerColumns,
    ).update(realignment.updates);
    if (!updatedCount) {
      log.info(`[self-booking-plan-sync] tier realignment skipped for ${customerId} — customer changed since read`);
      return { realigned: false, reason: 'concurrent_change', detectedPlanKeys };
    }

    const currentRank = activeTierRank(normalizeTierName(customer.waveguard_tier));
    const inferredRank = realignment.inferredTier ? activeTierRank(realignment.inferredTier) : -1;
    const raised = inferredRank > currentRank;
    await writeTierAuditRow(trx, log, {
      customer_id: customerId,
      action: raised ? 'waveguard_tier_auto_aligned' : 'waveguard_tier_auto_lapsed',
      description: raised
        ? `Raised WaveGuard tier to ${realignment.inferredTier} — upcoming recurring coverage grew`
        : (realignment.inferredTier
          ? `Lowered WaveGuard tier to ${realignment.inferredTier} — upcoming recurring coverage shrank`
          : 'Cleared WaveGuard tier — no upcoming recurring services remain'),
      metadata: {
        previous_tier: customer.waveguard_tier || null,
        detected_plan_keys: detectedPlanKeys,
        detected_family_keys: realignment.detectedFamilyKeys,
        updates: realignment.updates,
      },
    });

    return {
      realigned: true,
      raised,
      detectedPlanKeys,
      detectedFamilyKeys: realignment.detectedFamilyKeys,
      inferredTier: realignment.inferredTier,
      updates: realignment.updates,
    };
  });
}

// Nightly reconcile for the auto-tier directive, BOTH directions:
//   1. Enrollment — No-Plan customers holding upcoming recurring rows that
//      arrived by a path outside the seeding hook (direct row edits, imports,
//      legacy flows) get their tier stamped.
//   2. Realignment — label-only tiered customers move to exactly what their
//      upcoming coverage supports: raised (a family added outside the
//      booking-time hook), lowered, or cleared to No Plan when nothing
//      upcoming remains (cancelled/lapsed series). Paying members are
//      excluded in SQL, re-checked in buildLabelOnlyTierRealignmentUpdates,
//      and re-asserted on the UPDATE itself (compare-and-swap).
// No-op while GATE_AUTO_WAVEGUARD_TIER is off. Bounded per pass; each
// enrollment candidate goes through the same gated sync as the booking-time
// hook, so the write rules (tier only, no comms) live in exactly one place.
async function reconcileRecurringTiers(options = {}) {
  const {
    database = db,
    log = logger,
    limit = 500,
    today = etDateString(),
  } = options;

  if (!isEnabled('autoWaveguardTierEnroll')) return { ok: true, skipped: 'gate_off' };

  const tiersLower = TIER_ORDER.map((tier) => tier.toLowerCase());
  const customerColumns = await columnInfo(database, 'customers');
  const scheduledColumns = await columnInfo(database, 'scheduled_services');
  const hasIsRecurring = !!scheduledColumns.is_recurring;

  const applyCommonFilters = (query) => {
    let filtered = query;
    if (customerColumns.active) filtered = filtered.where('c.active', true);
    if (customerColumns.deleted_at) filtered = filtered.whereNull('c.deleted_at');
    return filtered;
  };

  // Pass 1 — enrollment: not enrolled + at least one upcoming recurring row.
  // The EXISTS pre-screen mirrors the authoritative per-row predicate as far
  // as SQL can (recurring, non-terminal, upcoming, not a callback, not a
  // one-time booking source) so persistent false positives don't occupy the
  // page; the residual class — rows with no detectable WaveGuard family —
  // can't be expressed in SQL, so candidates are ALSO sampled in random
  // order rather than a fixed created_at page that those rows would pin
  // forever (Codex #3011 r2).
  let enrollQuery = database('customers as c')
    .where(function notEnrolled() {
      this.where(function noRecognizedTier() {
        this.whereNull('c.waveguard_tier').orWhereRaw(
          `LOWER(c.waveguard_tier) NOT IN (${tiersLower.map(() => '?').join(', ')})`,
          tiersLower,
        );
      }).andWhere(function noLegacyRate() {
        this.whereNull('c.monthly_rate').orWhere('c.monthly_rate', '<=', 0);
      });
    })
    .whereExists(function upcomingRecurring() {
      this.select(database.raw('1'))
        .from('scheduled_services as s')
        .whereRaw('s.customer_id = c.id')
        .whereNotIn('s.status', TERMINAL_STATUSES)
        .where('s.scheduled_date', '>=', today);
      if (hasIsRecurring) this.where('s.is_recurring', true);
      if (scheduledColumns.is_callback) {
        this.where(function notCallback() {
          this.whereNull('s.is_callback').orWhere('s.is_callback', false);
        });
      }
      if (scheduledColumns.source) {
        this.where(function notOneTimeSource() {
          this.whereNull('s.source').orWhereNotIn('s.source', ONE_TIME_BOOKING_SOURCE_VALUES);
        });
      }
    })
    .orderByRaw('random()')
    .limit(Math.max(1, limit))
    .select('c.id');
  enrollQuery = applyCommonFilters(enrollQuery);

  const enrollCandidates = await enrollQuery;
  let enrolled = 0;
  let failed = 0;
  for (const candidate of enrollCandidates) {
    try {
      // Per-candidate transaction so the sync's customer read takes the row
      // lock (forUpdate engages only inside a transaction) and serializes
      // with any concurrent booking-time sync on the same customer.
      const result = await database.transaction(async (trx) => syncCustomerWaveGuardPlanFromScheduledServices({
        database: trx,
        log,
        customerId: candidate.id,
        today,
      }));
      if (result?.enrolled) enrolled += 1;
    } catch (err) {
      failed += 1;
      log.warn(`[self-booking-plan-sync] nightly tier enroll failed for ${candidate.id}: ${err.message}`);
    }
  }

  // Pass 2 — label-only realignment (both directions): tiered customers with
  // no positive rate and a label-only billing lane. Tier moves (Silver ->
  // Bronze on a cancel, Bronze -> Silver on an imported second family) need
  // per-customer family analysis, so SQL only narrows to the label-only
  // tiered set and the recompute happens per candidate. Candidates are
  // sampled in RANDOM order (Codex #3011 P2): correctly aligned customers
  // stay in this set forever, so a fixed created_at page would revisit the
  // same oldest rows nightly and starve everyone past the limit — random
  // sampling reaches every row across a handful of runs, and the primary
  // alignment path remains the booking-time hook anyway.
  // Provenance-scoped: only 'auto'-stamped tiers are realignment candidates;
  // without the provenance column (pre-migration) the pass is skipped
  // entirely — a NULL-provenance tier is untouchable (Codex #3011 r7 P1).
  if (!customerColumns.waveguard_tier_source) {
    return {
      ok: true,
      enrollChecked: enrollCandidates.length,
      enrolled,
      realignChecked: 0,
      raised: 0,
      lowered: 0,
      failed,
      limit,
      realignSkipped: 'no_tier_source_column',
    };
  }
  let realignQuery = database('customers as c')
    .where('c.waveguard_tier_source', 'auto')
    .whereRaw(
      `LOWER(c.waveguard_tier) IN (${tiersLower.map(() => '?').join(', ')})`,
      tiersLower,
    )
    .where(function noRate() {
      this.whereNull('c.monthly_rate').orWhere('c.monthly_rate', '<=', 0);
    })
    .orderByRaw('random()')
    .limit(Math.max(1, limit))
    // Only ids: the executor re-reads the customer fresh under its row lock,
    // so a snapshot here would only invite staleness.
    .select('c.id');
  if (customerColumns.billing_mode) {
    realignQuery = realignQuery.where(function labelOnlyLane() {
      this.whereNull('c.billing_mode').orWhereIn('c.billing_mode', LABEL_ONLY_REALIGN_LANES);
    });
  }
  realignQuery = applyCommonFilters(realignQuery);

  const realignCandidates = await realignQuery;
  let raised = 0;
  let lowered = 0;
  for (const candidate of realignCandidates) {
    try {
      const result = await realignLabelOnlyTierCustomer({
        database,
        log,
        customerId: candidate.id,
        customerColumns,
        today,
      });
      if (result?.realigned) {
        if (result.raised) raised += 1;
        else lowered += 1;
      }
    } catch (err) {
      failed += 1;
      log.warn(`[self-booking-plan-sync] nightly tier realignment failed for ${candidate.id}: ${err.message}`);
    }
  }

  return {
    ok: true,
    enrollChecked: enrollCandidates.length,
    enrolled,
    realignChecked: realignCandidates.length,
    raised,
    lowered,
    failed,
    limit,
  };
}

module.exports = {
  LAWN_CARE_RECURRING_PLANS,
  MOSQUITO_RECURRING_PLANS,
  ONE_TIME_BOOKING_SOURCE_VALUES,
  PEST_CONTROL_RECURRING_PLANS,
  SELF_BOOKING_RECURRING_PLANS,
  TERMITE_BAIT_RECURRING_PLANS,
  TREE_SHRUB_RECURRING_PLANS,
  buildCustomerWaveGuardAlignmentUpdates,
  buildLabelOnlyTierRealignmentUpdates,
  buildNoPlanTierEnrollmentUpdates,
  buildRecurringOccurrenceDates,
  detectWaveGuardPlanKeys,
  inferTierFromServiceCount,
  isAutoDerivedTierLabelRow,
  isCommercialServiceRow,
  isOneTimeBookingSource,
  isRodentLedServiceRow,
  normalizeTierName,
  reconcileRecurringTiers,
  representativePlanKeys,
  resolveLawnCareRecurringPlan,
  resolveMosquitoRecurringPlan,
  resolvePestControlRecurringPlan,
  resolveSelfBookedRecurringPlan,
  resolveTermiteBaitRecurringPlan,
  resolveTreeShrubRecurringPlan,
  serviceFamilyKey,
  serviceRowCountsTowardWaveGuard,
  tierLabelStatus,
  syncCustomerWaveGuardPlanFromScheduledServices,
  uniqueServiceFamilies,
};
