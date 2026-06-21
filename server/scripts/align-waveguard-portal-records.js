#!/usr/bin/env node
require('dotenv').config();

const db = require('../models/db');
const {
  TERMINAL_STATUSES,
  isMembershipCustomerRow,
} = require('../services/waveguard-existing-services');
const {
  ONE_TIME_BOOKING_SOURCE_VALUES,
  SELF_BOOKING_RECURRING_PLANS,
  buildRecurringOccurrenceDates,
  resolveLawnCareRecurringPlan,
  resolveMosquitoRecurringPlan,
  resolvePestControlRecurringPlan,
  resolveTermiteBaitRecurringPlan,
  resolveTreeShrubRecurringPlan,
  serviceRowCountsTowardWaveGuard,
} = require('../services/self-booking-plan-sync');
const { etDateString } = require('../utils/datetime-et');
const AppointmentReminders = require('../services/appointment-reminders');

const TIER_ORDER = ['Bronze', 'Silver', 'Gold', 'Platinum'];
const TIER_ORDER_LOWER = TIER_ORDER.map(tier => tier.toLowerCase());
const DEFAULT_WINDOW_START = '08:00';
const DEFAULT_WINDOW_END = '10:00';
const DEFAULT_TARGET_FUTURE_VISITS = 4;

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
const TARGET_FUTURE_VISITS = Math.max(1, Math.min(12, Number.parseInt(ARGS['future-visits'] || DEFAULT_TARGET_FUTURE_VISITS, 10) || DEFAULT_TARGET_FUTURE_VISITS));

function moneyNumber(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num : 0;
}

function dateKey(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.split('T')[0];
  // pg/Knex DATE columns (scheduled_date, member_since) arrive as midnight Date objects;
  // on a UTC server etDateString() would shift them to the previous ET day, corrupting
  // anchors, future-date dedupe, inserted child dates, and member_since. Read the stored
  // calendar date directly (repo DATE-column convention).
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

function textForService(row = {}) {
  return rawTextForService(row).replace(/[_-]+/g, ' ');
}

function detectServiceKeys(row = {}) {
  const text = textForService(row);
  const rawText = rawTextForService(row);
  const keys = [];
  const add = (key) => {
    if (SERVICE_PLANS[key] && !keys.includes(key)) keys.push(key);
  };

  const pestPlan = resolvePestControlRecurringPlan(rawText);
  if (pestPlan) add(pestPlan.planKey || 'pest_control');
  const lawnPlan = resolveLawnCareRecurringPlan(rawText);
  if (lawnPlan) add(lawnPlan.planKey || 'lawn_care');
  const mosquitoPlan = resolveMosquitoRecurringPlan(rawText);
  if (mosquitoPlan) add(mosquitoPlan.planKey || 'mosquito');
  const treeShrubPlan = resolveTreeShrubRecurringPlan(rawText);
  if (treeShrubPlan) add(treeShrubPlan.planKey || 'tree_shrub');
  const termitePlan = resolveTermiteBaitRecurringPlan(rawText);
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
  // per-visit recurring customer (incl. pending public self-bookings). Use the shared
  // membership predicate, which rejects explicit non-member tier sentinels.
  if (!isMembershipCustomerRow(customer)) return updates;
  const existingRate = moneyNumber(customer.monthly_rate);
  const inferredTier = inferTierFromServiceCount(uniqueServiceFamilies(detectedKeys).length);
  const normalizedExistingTier = normalizeTierName(customer.waveguard_tier);
  const currentTierRank = normalizedExistingTier ? TIER_ORDER.indexOf(normalizedExistingTier) : -1;
  const inferredTierRank = inferredTier ? TIER_ORDER.indexOf(inferredTier) : -1;

  // Mirror the runtime sync helper (buildCustomerWaveGuardAlignmentUpdates): with no
  // recurring-service evidence we cannot infer a tier, so we make NO customer-state
  // mutations. Without this gate a default-Bronze lead/non-member with no qualifying
  // scheduled services would be promoted to active_customer (and reactivated under
  // --include-inactive) just by running the alignment script.
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

function buildParentUpdates(service, plan, serviceId, columns) {
  const updates = {};

  if (columnPresent(columns, 'is_recurring') && service.is_recurring !== true) updates.is_recurring = true;
  if (columnPresent(columns, 'recurring_pattern') && !service.recurring_pattern) updates.recurring_pattern = plan.recurringPattern;
  if (
    columnPresent(columns, 'recurring_interval_days')
    && plan.recurringIntervalDays
    && Number(service.recurring_interval_days || 0) !== Number(plan.recurringIntervalDays)
  ) {
    updates.recurring_interval_days = plan.recurringIntervalDays;
  }
  if (columnPresent(columns, 'recurring_ongoing') && service.recurring_ongoing !== true) updates.recurring_ongoing = true;
  if (columnPresent(columns, 'service_id') && !service.service_id && serviceId) updates.service_id = serviceId;
  if (columnPresent(columns, 'create_invoice_on_complete') && service.create_invoice_on_complete !== false) {
    updates.create_invoice_on_complete = false;
  }

  return updates;
}

function buildChildRow({ customerId, parent, plan, serviceId, columns, scheduledDate }) {
  const row = {
    customer_id: customerId,
    scheduled_date: scheduledDate,
    service_type: parent.service_type || plan.serviceType,
    status: 'pending',
    notes: `Auto-scheduled by WaveGuard portal alignment from ${plan.label}.`,
  };

  setIfColumn(row, columns, 'technician_id', parent.technician_id || null);
  setIfColumn(row, columns, 'window_start', parent.window_start || DEFAULT_WINDOW_START);
  setIfColumn(row, columns, 'window_end', parent.window_end || DEFAULT_WINDOW_END);
  setIfColumn(row, columns, 'zone', parent.zone || null);
  setIfColumn(row, columns, 'estimated_duration_minutes', parent.estimated_duration_minutes || null);
  setIfColumn(row, columns, 'source', 'waveguard_portal_alignment');
  setIfColumn(row, columns, 'is_recurring', true);
  setIfColumn(row, columns, 'recurring_pattern', parent.recurring_pattern || plan.recurringPattern);
  if (plan.recurringIntervalDays) {
    setIfColumn(row, columns, 'recurring_interval_days', parent.recurring_interval_days || plan.recurringIntervalDays);
  }
  setIfColumn(row, columns, 'recurring_parent_id', parent.recurring_parent_id || parent.id);
  setIfColumn(row, columns, 'recurring_ongoing', true);
  setIfColumn(row, columns, 'service_id', serviceId || parent.service_id || null);
  setIfColumn(row, columns, 'create_invoice_on_complete', false);

  return row;
}

function chooseAnchor(rows, serviceKey, today) {
  const matching = rows
    .filter(serviceRowCountsTowardWaveGuard)
    .filter((row) => detectServiceKeys(row).includes(serviceKey))
    .sort((a, b) => String(dateKey(a.scheduled_date)).localeCompare(String(dateKey(b.scheduled_date))));
  if (!matching.length) return null;

  const futureParent = matching.find((row) => dateKey(row.scheduled_date) >= today && !row.recurring_parent_id);
  if (futureParent) return futureParent;

  const recurringParent = matching.find((row) => (row.is_recurring || row.recurring_pattern) && !row.recurring_parent_id);
  if (recurringParent) return recurringParent;

  const latest = [...matching].reverse().find(Boolean);
  return latest || matching[0];
}

function futureDatesForService(rows, serviceKey, today) {
  return new Set(rows
    .filter(serviceRowCountsTowardWaveGuard)
    .filter((row) => detectServiceKeys(row).includes(serviceKey))
    .filter((row) => dateKey(row.scheduled_date) >= today)
    .map((row) => dateKey(row.scheduled_date))
    .filter(Boolean));
}

function dateInSeason(dateStr, seasonMonths) {
  if (!Array.isArray(seasonMonths) || !seasonMonths.length) return true;
  const month = Number(String(dateStr).slice(5, 7));
  return seasonMonths.includes(month);
}

function plannedFutureDates(anchor, plan, today, targetCount) {
  const base = dateKey(anchor.scheduled_date) || today;
  const pattern = anchor.recurring_pattern || plan.recurringPattern;
  const intervalDays = anchor.recurring_interval_days || plan.recurringIntervalDays || null;
  // Seasonal plans (e.g. seasonal mosquito) keep a monthly cadence but only generate
  // in-season visits, so an Oct anchor does not seed Nov–Jan plan-covered rows.
  const seasonMonths = plan.seasonMonths || null;
  const inWindow = (date) => date >= today && dateInSeason(date, seasonMonths);
  const generated = buildRecurringOccurrenceDates(base, pattern, 36, { intervalDays });
  const future = generated.filter(inWindow);
  if (future.length >= targetCount) return future.slice(0, targetCount);

  const extendedBase = future[future.length - 1] || base;
  const extended = buildRecurringOccurrenceDates(extendedBase, pattern, targetCount + 12, { intervalDays })
    .filter(inWindow);
  return Array.from(new Set([...future, ...extended])).slice(0, targetCount);
}

async function serviceIdMap() {
  const map = {};
  try {
    const rows = await db('services')
      .whereIn('service_key', Object.values(SERVICE_PLANS).map((plan) => plan.serviceKey))
      .select('id', 'service_key');
    for (const row of rows) map[row.service_key] = row.id;
  } catch (_err) {
    // Service library is optional in older environments; service_type remains enough for the portal.
  }
  return map;
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

async function candidateCustomers(customerColumns) {
  const byId = new Map();
  let query = db('customers as c')
    .whereRaw(
      `LOWER(c.waveguard_tier) IN (${TIER_ORDER_LOWER.map(() => '?').join(', ')})`,
      TIER_ORDER_LOWER,
    )
    .orderBy('c.created_at', 'asc');

  if (CUSTOMER_ID) query = query.where('c.id', CUSTOMER_ID);
  query = customerSelect(applyCustomerFilters(query, customerColumns));
  if (LIMIT) query = query.limit(LIMIT);
  for (const customer of await query) {
    byId.set(customer.id, { ...customer, candidate_reason: 'bronze_plus' });
  }

  if (!CUSTOMER_ID || !byId.has(CUSTOMER_ID)) {
    let selfBooked = db('customers as c')
      .join('scheduled_services as s', 's.customer_id', 'c.id')
      .where(function selfBookedSource() {
        this.where('s.source', 'self_booked').orWhereNotNull('s.self_booking_id');
      })
      .where(function nonOneTimeSource() {
        this.whereNull('s.source').orWhereNotIn('s.source', ONE_TIME_BOOKING_SOURCE_VALUES);
      })
      .whereNotIn('s.status', TERMINAL_STATUSES)
      .where(function missingPortalFields() {
        this.whereNull('c.waveguard_tier')
          .orWhereNull('c.monthly_rate')
          .orWhere('c.monthly_rate', '<=', 0)
          .orWhereNull('c.member_since');
      })
      .distinct();

    if (CUSTOMER_ID) selfBooked = selfBooked.where('c.id', CUSTOMER_ID);
    selfBooked = customerSelect(applyCustomerFilters(selfBooked, customerColumns));
    for (const customer of await selfBooked) {
      const existing = byId.get(customer.id);
      byId.set(customer.id, {
        ...customer,
        candidate_reason: existing ? `${existing.candidate_reason},self_booked_missing_portal_fields` : 'self_booked_missing_portal_fields',
      });
    }
  }

  return Array.from(byId.values()).slice(0, LIMIT || undefined);
}

async function scheduledRowsForCustomer(customerId) {
  // Mirror syncCustomerWaveGuardPlanFromScheduledServices(): join the services
  // catalog so detectServiceKeys() sees svc.service_key / svc.name for rows whose
  // cadence lives in service_id while service_type is generic (e.g. a
  // lawn_care_monthly service recorded as "Lawn Care"). Falls back to the plain
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

async function analyzeCustomer(customer, serviceColumns, customerColumns, serviceIds, today) {
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

  // Re-align enrolled members only: never seed plan-covered recurring rows (which set
  // create_invoice_on_complete=false) for a per-visit customer who is not WaveGuard-enrolled.
  const serviceRepairs = [];
  const scheduledAnchorIds = new Set();
  for (const key of (isMembershipCustomerRow(customer) ? detectedKeys : [])) {
    const plan = SERVICE_PLANS[key];
    const anchor = chooseAnchor(rows, key, today);
    if (!anchor) continue;
    // A combined/bundle row (e.g. "Pest + Lawn + Mosquito") detects multiple plan keys
    // that all resolve to the SAME anchor row; schedule only one future series per anchor
    // occurrence so --apply does not insert duplicate scheduled_services/reminders.
    if (scheduledAnchorIds.has(anchor.id)) continue;
    scheduledAnchorIds.add(anchor.id);

    const serviceId = serviceIds[plan.serviceKey] || null;
    const parentUpdates = buildParentUpdates(anchor, plan, serviceId, serviceColumns);
    const existingFutureDates = futureDatesForService(rows, key, today);
    const targetDates = plannedFutureDates(anchor, plan, today, TARGET_FUTURE_VISITS);
    const missingDates = targetDates.filter((date) => !existingFutureDates.has(date));
    const childRows = missingDates.map((scheduledDate) => buildChildRow({
      customerId: customer.id,
      parent: anchor,
      plan,
      serviceId,
      columns: serviceColumns,
      scheduledDate,
    }));

    if (Object.keys(parentUpdates).length || childRows.length) {
      serviceRepairs.push({
        serviceKey: key,
        serviceType: anchor.service_type || plan.serviceType,
        anchorId: anchor.id,
        parentUpdates,
        childRows,
      });
    }
  }

  return {
    customer,
    detectedKeys,
    detectedFamilyKeys,
    tierMismatch,
    customerUpdates,
    serviceRepairs,
  };
}

async function applyCustomerRepair(repair) {
  const insertedVisits = [];
  await db.transaction(async (trx) => {
    if (Object.keys(repair.customerUpdates).length) {
      await trx('customers').where({ id: repair.customer.id }).update(repair.customerUpdates);
    }

    for (const serviceRepair of repair.serviceRepairs) {
      if (Object.keys(serviceRepair.parentUpdates).length) {
        await trx('scheduled_services').where({ id: serviceRepair.anchorId }).update(serviceRepair.parentUpdates);
      }
      for (const row of serviceRepair.childRows) {
        const [inserted] = await trx('scheduled_services').insert(row).returning('*');
        if (inserted?.id) insertedVisits.push(inserted);
      }
    }
  });

  // Register 72h/24h reminders for the inserted visits — the reminder cron only scans
  // appointment_reminders, so without this, backfilled plan visits would get none.
  // After the repair commits, each in its own sub-transaction (idempotent per
  // scheduled_service_id) so a reminder failure never rolls back the inserted visit.
  for (const visit of insertedVisits) {
    const startHHMM = visit.window_start ? String(visit.window_start).slice(0, 5) : '08:00';
    try {
      await db.transaction((sp) =>
        AppointmentReminders.registerVisitReminderInTx(sp, {
          scheduledServiceId: visit.id,
          customerId: repair.customer.id,
          appointmentTime: `${dateKey(visit.scheduled_date)}T${startHHMM}`,
          serviceType: visit.service_type,
          source: 'waveguard_portal_alignment',
        }),
      );
    } catch (err) {
      console.error(`[align] reminder registration skipped for service ${visit.id}: ${err.message}`);
    }
  }
}

function summarizeRepair(repair) {
  const childInsertCount = repair.serviceRepairs.reduce((sum, item) => sum + item.childRows.length, 0);
  const parentUpdateCount = repair.serviceRepairs.filter((item) => Object.keys(item.parentUpdates).length > 0).length;
  return {
    customerId: repair.customer.id,
    tier: repair.customer.waveguard_tier,
    candidateReason: repair.customer.candidate_reason,
    detectedServices: repair.detectedKeys,
    detectedServiceFamilies: repair.detectedFamilyKeys,
    customerUpdates: repair.customerUpdates,
    parentUpdateCount,
    childInsertCount,
    tierMismatch: repair.tierMismatch,
    services: repair.serviceRepairs.map((item) => ({
      serviceKey: item.serviceKey,
      serviceType: item.serviceType,
      anchorId: item.anchorId,
      parentUpdates: item.parentUpdates,
      childDates: item.childRows.map((row) => row.scheduled_date),
    })),
  };
}

async function main() {
  const today = etDateString();
  const customerColumns = await db('customers').columnInfo();
  const serviceColumns = await db('scheduled_services').columnInfo();
  const serviceIds = await serviceIdMap();
  const customers = await candidateCustomers(customerColumns);
  const repairs = [];
  const noServiceEvidence = [];
  const tierMismatches = [];

  for (const customer of customers) {
    const repair = await analyzeCustomer(customer, serviceColumns, customerColumns, serviceIds, today);
    if (!repair.detectedKeys.length) noServiceEvidence.push(customer.id);
    if (repair.tierMismatch) tierMismatches.push(repair.tierMismatch);

    const hasCustomerUpdates = Object.keys(repair.customerUpdates).length > 0;
    const hasServiceUpdates = repair.serviceRepairs.some((item) => (
      Object.keys(item.parentUpdates).length > 0 || item.childRows.length > 0
    ));
    if (!hasCustomerUpdates && !hasServiceUpdates) continue;

    repairs.push(repair);
    if (APPLY) await applyCustomerRepair(repair);
  }

  const summary = {
    ok: true,
    mode: APPLY ? 'apply' : 'dry-run',
    checkedCustomers: customers.length,
    customersNeedingRepair: repairs.length,
    customerFieldUpdates: repairs.filter((repair) => Object.keys(repair.customerUpdates).length > 0).length,
    parentServiceUpdates: repairs.reduce((sum, repair) => sum + repair.serviceRepairs.filter((item) => Object.keys(item.parentUpdates).length > 0).length, 0),
    childServicesInserted: APPLY
      ? repairs.reduce((sum, repair) => sum + repair.serviceRepairs.reduce((inner, item) => inner + item.childRows.length, 0), 0)
      : 0,
    childServicesWouldInsert: repairs.reduce((sum, repair) => sum + repair.serviceRepairs.reduce((inner, item) => inner + item.childRows.length, 0), 0),
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
  buildChildRow,
  buildCustomerUpdates,
  dateKey,
  detectServiceKeys,
  inferTierFromServiceCount,
  normalizeTierName,
  parseBooleanFlag,
  plannedFutureDates,
  representativePlanKeys,
  serviceFamilyKey,
  uniqueServiceFamilies,
};
