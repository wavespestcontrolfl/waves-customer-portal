#!/usr/bin/env node
//
// WaveGuard portal customer-field backfill.
//
// Re-aligns CUSTOMER-TABLE fields (waveguard_tier, monthly_rate, member_since,
// active, pipeline_stage) for already-enrolled WaveGuard members, inferring the
// plan from their active recurring scheduled_services. It is READ-ONLY against
// scheduled_services — it never inserts or updates visits. (An earlier version
// also seeded future visits; that over-scheduled members who already had a
// recurring schedule on a different anchor, so visit-seeding was removed. If
// future-visit seeding is ever re-added it must reconcile generated dates with a
// customer's EXISTING visits first.)
//
// Dry-run by default. `--apply` (or `--apply=true`) enables the customer writes.
//   --include-inactive   also align inactive customers
//   --limit N            cap the number of customers processed
//   --customer-id <uuid> process a single customer
//
require('dotenv').config();

const db = require('../models/db');
const {
  TERMINAL_STATUSES,
  isMembershipCustomerRow,
} = require('../services/waveguard-existing-services');
const {
  SELF_BOOKING_RECURRING_PLANS,
  resolveLawnCareRecurringPlan,
  resolveMosquitoRecurringPlan,
  resolvePestControlRecurringPlan,
  resolveTermiteBaitRecurringPlan,
  resolveTreeShrubRecurringPlan,
  serviceRowCountsTowardWaveGuard,
} = require('../services/self-booking-plan-sync');
const { etDateString } = require('../utils/datetime-et');

const TIER_ORDER = ['Bronze', 'Silver', 'Gold', 'Platinum'];
const TIER_ORDER_LOWER = TIER_ORDER.map(tier => tier.toLowerCase());

const SERVICE_PLANS = { ...SELF_BOOKING_RECURRING_PLANS };

const ARGS = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    if (!arg.startsWith('--')) return [arg, true];
    const [key, value] = arg.slice(2).split('=');
    return [key, value === undefined ? true : value];
  })
);

function parseBooleanFlag(value) {
  if (value === true) return true;
  if (value === undefined || value === false || value === null) return false;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

// Default is dry-run: only a bare `--apply` or an explicit truthy value enables
// writes, so `--apply=false`/`--apply=0` stays read-only.
const APPLY = parseBooleanFlag(ARGS.apply);
const LIMIT = ARGS.limit ? Math.max(1, Number.parseInt(ARGS.limit, 10) || 0) : null;
const CUSTOMER_ID = ARGS['customer-id'] || null;
const INCLUDE_INACTIVE = parseBooleanFlag(ARGS['include-inactive']);

function moneyNumber(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num : 0;
}

function dateKey(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.split('T')[0];
  // pg/Knex DATE columns (scheduled_date, member_since) arrive as midnight Date objects;
  // on a UTC server etDateString() would shift them to the previous ET day. Read the
  // stored calendar date directly (repo DATE-column convention).
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return etDateString(value);
}

function rawTextForService(row = {}) {
  return String([
    row.service_type,
    row.serviceType,
    row.service_key,
    row.serviceKey,
    row.service_name,
    row.name,
  ].filter(Boolean).join(' ')).toLowerCase();
}

// Catalog-only text (service_key / service_name) — the authoritative cadence source.
// service_type labels can be stale (a lawn_care_monthly row still labeled "Quarterly
// Lawn Care"), so resolve from this first and fall back to the full text only when the
// catalog fields do not resolve.
function catalogTextForService(row = {}) {
  return String([
    row.service_key,
    row.serviceKey,
    row.service_name,
    row.name,
  ].filter(Boolean).join(' ')).toLowerCase();
}

// Catalog fields are authoritative for cadence only when cadence-specific (e.g.
// lawn_care_monthly); a generic catalog FK (lawn_fertilization) has no cadence, so
// detection must fall through to service_type rather than short-circuit on it.
const CADENCE_SIGNAL_RE = /weekly|monthly|quarterly|annual|yearly|seasonal|\d+\s*weeks?|\d+\s*months?|\d+week/;

function detectServiceKeys(row = {}) {
  const fullText = rawTextForService(row);
  const catalogText = catalogTextForService(row);
  const catalogHasCadence = CADENCE_SIGNAL_RE.test(catalogText);
  const keys = [];
  const add = (key) => {
    if (SERVICE_PLANS[key] && !keys.includes(key)) keys.push(key);
  };
  // Trust the catalog cadence only when the catalog text is cadence-specific; otherwise
  // fall through to the full text so a real cadence in service_type still wins.
  const resolvePlan = (resolver) => (catalogHasCadence && resolver(catalogText)) || resolver(fullText);

  const pestPlan = resolvePlan(resolvePestControlRecurringPlan);
  if (pestPlan) add(pestPlan.planKey || 'pest_control');
  const lawnPlan = resolvePlan(resolveLawnCareRecurringPlan);
  if (lawnPlan) add(lawnPlan.planKey || 'lawn_care');
  const mosquitoPlan = resolvePlan(resolveMosquitoRecurringPlan);
  if (mosquitoPlan) add(mosquitoPlan.planKey || 'mosquito');
  const treeShrubPlan = resolvePlan(resolveTreeShrubRecurringPlan);
  if (treeShrubPlan) add(treeShrubPlan.planKey || 'tree_shrub');
  const termitePlan = resolvePlan(resolveTermiteBaitRecurringPlan);
  if (termitePlan) add(termitePlan.planKey || 'termite_bait');

  return keys;
}

function serviceFamilyKey(serviceKey) {
  const key = String(serviceKey || '');
  for (const family of ['pest_control', 'lawn_care', 'mosquito', 'tree_shrub', 'termite_bait']) {
    if (key === family || key.startsWith(`${family}_`)) return family;
  }
  return serviceKey;
}

function uniqueServiceFamilies(serviceKeys = []) {
  return Array.from(new Set(serviceKeys.map(serviceFamilyKey).filter(Boolean)));
}

function representativePlanKeys(serviceKeys = []) {
  const byFamily = new Map();
  for (const key of serviceKeys) {
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

function normalizeTierName(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return null;
  return TIER_ORDER.find(tier => tier.toLowerCase() === text) || null;
}

function columnPresent(columns, column) {
  return !!columns[column];
}

function setIfColumn(target, columns, column, value) {
  if (columnPresent(columns, column)) target[column] = value;
}

function buildCustomerUpdates(customer, detectedKeys, columns, today) {
  const updates = {};
  // Owner policy: re-align already-enrolled WaveGuard members only; never enroll a
  // per-visit recurring customer. Use the shared membership predicate, which rejects
  // explicit non-member tier sentinels (none/onetime/na/...).
  if (!isMembershipCustomerRow(customer)) return updates;
  const existingRate = moneyNumber(customer.monthly_rate);
  const inferredTier = inferTierFromServiceCount(uniqueServiceFamilies(detectedKeys).length);
  const normalizedExistingTier = normalizeTierName(customer.waveguard_tier);
  const currentTierRank = normalizedExistingTier ? TIER_ORDER.indexOf(normalizedExistingTier) : -1;
  const inferredTierRank = inferredTier ? TIER_ORDER.indexOf(inferredTier) : -1;

  // Mirror the runtime sync helper (buildCustomerWaveGuardAlignmentUpdates): with no
  // recurring-service evidence we cannot infer a tier, so we make NO customer-state
  // mutations — a member with no detectable recurring service is left untouched.
  if (!inferredTier) return updates;

  if (columnPresent(columns, 'active') && customer.active !== true) updates.active = true;
  if (columnPresent(columns, 'pipeline_stage') && customer.pipeline_stage !== 'active_customer') {
    updates.pipeline_stage = 'active_customer';
    setIfColumn(updates, columns, 'pipeline_stage_changed_at', new Date());
  }
  if (columnPresent(columns, 'waveguard_tier')) {
    if (normalizedExistingTier && customer.waveguard_tier !== normalizedExistingTier) {
      updates.waveguard_tier = normalizedExistingTier;
    }
    if (inferredTier && inferredTierRank > currentTierRank) {
      updates.waveguard_tier = inferredTier;
    }
  }

  if (columnPresent(columns, 'member_since') && !customer.member_since) {
    updates.member_since = customer.earliest_service_date || dateKey(customer.created_at) || today;
  }

  if (columnPresent(columns, 'monthly_rate') && existingRate <= 0 && detectedKeys.length) {
    updates.monthly_rate = representativePlanKeys(detectedKeys)
      .reduce((sum, key) => sum + moneyNumber(SERVICE_PLANS[key]?.monthlyRate), 0);
  }

  return updates;
}

function applyCustomerFilters(query, customerColumns) {
  if (!INCLUDE_INACTIVE && columnPresent(customerColumns, 'active')) query = query.where('c.active', true);
  if (columnPresent(customerColumns, 'deleted_at')) query = query.whereNull('c.deleted_at');
  return query;
}

function customerSelect(query) {
  return query.select(
    'c.id',
    'c.first_name',
    'c.last_name',
    'c.waveguard_tier',
    'c.monthly_rate',
    'c.member_since',
    'c.pipeline_stage',
    'c.active',
    'c.created_at',
  );
}

// Candidate set = enrolled WaveGuard members: a recognized Bronze/Silver/Gold/Platinum
// tier, OR a positive monthly_rate (legacy members whose tier column was never
// populated). This matches isMembershipCustomerRow so legacy-rate members still get
// their missing tier/member_since fields backfilled. buildCustomerUpdates additionally
// fail-closes via that same predicate, so a sentinel-tier row is never mutated.
async function candidateCustomers(customerColumns) {
  let query = db('customers as c')
    .where(function enrolled() {
      this.whereRaw(
        `LOWER(c.waveguard_tier) IN (${TIER_ORDER_LOWER.map(() => '?').join(', ')})`,
        TIER_ORDER_LOWER,
      ).orWhere('c.monthly_rate', '>', 0);
    })
    .orderBy('c.created_at', 'asc');

  if (CUSTOMER_ID) query = query.where('c.id', CUSTOMER_ID);
  query = customerSelect(applyCustomerFilters(query, customerColumns));
  if (LIMIT) query = query.limit(LIMIT);

  return (await query).map((customer) => ({
    ...customer,
    candidate_reason: normalizeTierName(customer.waveguard_tier) ? 'enrolled_tier' : 'enrolled_legacy_rate',
  }));
}

async function scheduledRowsForCustomer(customerId) {
  // READ-ONLY. Join the services catalog so detectServiceKeys() sees svc.service_key /
  // svc.name for rows whose cadence lives in service_id while service_type is generic
  // (e.g. a lawn_care_monthly service recorded as "Lawn Care"). Falls back to the plain
  // select where the catalog is absent (older environments).
  try {
    return await db('scheduled_services as s')
      .leftJoin('services as svc', 's.service_id', 'svc.id')
      .where({ 's.customer_id': customerId })
      .whereNotIn('s.status', TERMINAL_STATUSES)
      .orderBy('s.scheduled_date', 'asc')
      .select('s.*', 'svc.service_key', 'svc.name as service_name');
  } catch (_err) {
    return db('scheduled_services')
      .where({ customer_id: customerId })
      .whereNotIn('status', TERMINAL_STATUSES)
      .orderBy('scheduled_date', 'asc')
      .select('*');
  }
}

async function analyzeCustomer(customer, customerColumns, today) {
  const rows = await scheduledRowsForCustomer(customer.id);
  const recurringRows = rows.filter(serviceRowCountsTowardWaveGuard);
  const detectedKeys = [];
  for (const row of recurringRows) {
    for (const key of detectServiceKeys(row)) {
      if (!detectedKeys.includes(key)) detectedKeys.push(key);
    }
  }

  const earliestServiceDate = recurringRows.map((row) => dateKey(row.scheduled_date)).filter(Boolean).sort()[0] || null;
  const customerWithDates = { ...customer, earliest_service_date: earliestServiceDate };
  const customerUpdates = buildCustomerUpdates(customerWithDates, detectedKeys, customerColumns, today);
  const detectedFamilyKeys = uniqueServiceFamilies(detectedKeys);
  const inferredTier = inferTierFromServiceCount(detectedFamilyKeys.length);
  const currentTier = normalizeTierName(customer.waveguard_tier);
  const tierMismatch = inferredTier && currentTier && TIER_ORDER.indexOf(inferredTier) > TIER_ORDER.indexOf(currentTier)
    ? { current: currentTier, inferred: inferredTier, serviceCount: detectedFamilyKeys.length }
    : null;

  return {
    customer,
    detectedKeys,
    detectedFamilyKeys,
    tierMismatch,
    customerUpdates,
  };
}

async function applyCustomerRepair(repair) {
  if (Object.keys(repair.customerUpdates).length) {
    await db('customers').where({ id: repair.customer.id }).update(repair.customerUpdates);
  }
}

function summarizeRepair(repair) {
  return {
    customerId: repair.customer.id,
    tier: repair.customer.waveguard_tier,
    candidateReason: repair.customer.candidate_reason,
    detectedServices: repair.detectedKeys,
    detectedServiceFamilies: repair.detectedFamilyKeys,
    customerUpdates: repair.customerUpdates,
    tierMismatch: repair.tierMismatch,
  };
}

async function main() {
  const today = etDateString();
  const customerColumns = await db('customers').columnInfo();
  const customers = await candidateCustomers(customerColumns);
  const repairs = [];
  const noServiceEvidence = [];
  const tierMismatches = [];

  for (const customer of customers) {
    const repair = await analyzeCustomer(customer, customerColumns, today);
    if (!repair.detectedKeys.length) noServiceEvidence.push(customer.id);
    if (repair.tierMismatch) tierMismatches.push(repair.tierMismatch);
    if (!Object.keys(repair.customerUpdates).length) continue;

    repairs.push(repair);
    if (APPLY) await applyCustomerRepair(repair);
  }

  const summary = {
    ok: true,
    mode: APPLY ? 'apply' : 'dry-run',
    checkedCustomers: customers.length,
    customersNeedingRepair: repairs.length,
    customerFieldUpdates: repairs.length,
    noServiceEvidenceCount: noServiceEvidence.length,
    tierMismatchCount: tierMismatches.length,
    limit: LIMIT,
    customerId: CUSTOMER_ID,
    includeInactive: INCLUDE_INACTIVE,
    sample: repairs.slice(0, 20).map(summarizeRepair),
  };

  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error(`WaveGuard portal alignment failed: ${err.message}`);
      process.exitCode = 1;
    })
    .finally(() => db.destroy());
}

module.exports = {
  buildCustomerUpdates,
  dateKey,
  detectServiceKeys,
  inferTierFromServiceCount,
  normalizeTierName,
  parseBooleanFlag,
  representativePlanKeys,
  serviceFamilyKey,
  uniqueServiceFamilies,
};
