#!/usr/bin/env node
/**
 * Clean up accepted one-time estimates that were misclassified as recurring
 * because estimate_data.result.recurring.services contained a $0/mo
 * placeholder row.
 *
 * This script is DB-only by design. It does not import app routers, Twilio,
 * SendGrid, email templates, SMS templates, or automation executors.
 *
 * Dry-run by default:
 *   node server/scripts/cleanup-one-time-placeholder-recurring.js
 *
 * Apply:
 *   node server/scripts/cleanup-one-time-placeholder-recurring.js --apply
 *
 * Production:
 *   railway run --service Postgres node server/scripts/cleanup-one-time-placeholder-recurring.js
 *   railway run --service Postgres node server/scripts/cleanup-one-time-placeholder-recurring.js --apply
 */

process.env.DISABLE_OUTBOUND_MESSAGING = 'true';
process.env.SKIP_OUTBOUND_EMAIL = 'true';
process.env.SKIP_OUTBOUND_SMS = 'true';

if (
  process.env.DATABASE_PUBLIC_URL
  && /postgres\.railway\.internal/i.test(String(process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL || ''))
) {
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
}

const db = require('../models/db');

const APPLY = process.argv.includes('--apply');

const RECURRING_AMOUNT_FIELDS = [
  'mo',
  'monthly',
  'monthlyTotal',
  'monthly_total',
  'monthlyBase',
  'monthlyAfterDiscount',
  'monthlyAfterCredits',
  'ann',
  'annual',
  'annualTotal',
  'annual_total',
  'annualAfterDiscount',
  'annualAfterCredits',
  'perTreatment',
  'perVisit',
  'perApp',
  'pa',
  'price',
];

const RECURRING_TOTAL_FIELDS = [
  'monthlyTotal',
  'grandTotal',
  'annualAfterDiscount',
  'annualTotal',
  'monthly',
  'annual',
];

function moneyPositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_err) {
    return fallback;
  }
}

function resultFromEstimateData(estData = {}) {
  return estData?.result && typeof estData.result === 'object' ? estData.result : estData;
}

function recurringObjects(result = {}) {
  const recurring = result?.recurring && typeof result.recurring === 'object' ? result.recurring : {};
  const nested = result?.results?.recurring && typeof result.results.recurring === 'object'
    ? result.results.recurring
    : {};
  return { recurring, nested };
}

function recurringServicesForResult(result = {}) {
  const { recurring, nested } = recurringObjects(result);
  return [
    ...(Array.isArray(recurring.services) ? recurring.services : []),
    ...(Array.isArray(nested.services) ? nested.services : []),
  ].filter(Boolean);
}

function rowRequiresQuote(row = {}) {
  return row.quoteRequired === true
    || row.requiresCustomQuote === true
    || row.quote_required === true
    || row.requires_custom_quote === true;
}

function rowHasRecurringAmount(row = {}) {
  return RECURRING_AMOUNT_FIELDS.some((field) => moneyPositive(row[field]));
}

function objectHasRecurringTotal(obj = {}) {
  return RECURRING_TOTAL_FIELDS.some((field) => moneyPositive(obj[field]));
}

function oneTimeRowsForResult(result = {}) {
  const oneTime = result?.oneTime && typeof result.oneTime === 'object' ? result.oneTime : {};
  const nestedOneTime = result?.results?.oneTime && typeof result.results.oneTime === 'object'
    ? result.results.oneTime
    : {};
  return [
    ...(Array.isArray(oneTime.items) ? oneTime.items : []),
    ...(Array.isArray(oneTime.specItems) ? oneTime.specItems : []),
    ...(Array.isArray(nestedOneTime.items) ? nestedOneTime.items : []),
    ...(Array.isArray(nestedOneTime.specItems) ? nestedOneTime.specItems : []),
    ...(Array.isArray(result?.specItems) ? result.specItems : []),
  ].filter((row) => row && row.onProg !== true && row.includedOnProgram !== true);
}

function oneTimeAmountForEstimate(estimate = {}, result = {}) {
  const oneTime = result?.oneTime && typeof result.oneTime === 'object' ? result.oneTime : {};
  const nestedOneTime = result?.results?.oneTime && typeof result.results.oneTime === 'object'
    ? result.results.oneTime
    : {};
  const explicit = [
    estimate.onetime_total,
    estimate.onetimeTotal,
    oneTime.total,
    nestedOneTime.total,
  ].find(moneyPositive);
  if (explicit != null) return Number(explicit);

  return oneTimeRowsForResult(result).reduce((sum, row) => {
    const amount = Number(row.price ?? row.amount ?? row.total ?? row.priceAfterDiscount ?? row.totalAfterDiscount);
    return Number.isFinite(amount) && amount > 0 ? sum + amount : sum;
  }, 0);
}

function classifyMisclassifiedOneTimeEstimate(estimate = {}) {
  const reasons = [];
  if (String(estimate.status || '') !== 'accepted') reasons.push('not_accepted');
  if (estimate.show_one_time_option === true || estimate.showOneTimeOption === true) reasons.push('shows_one_time_choice');
  if (moneyPositive(estimate.monthly_total) || moneyPositive(estimate.monthlyTotal)) reasons.push('positive_monthly_total');
  if (moneyPositive(estimate.annual_total) || moneyPositive(estimate.annualTotal)) reasons.push('positive_annual_total');

  const estData = parseJson(estimate.estimate_data, {});
  const result = resultFromEstimateData(estData);
  const services = recurringServicesForResult(result);
  if (services.length === 0) reasons.push('no_recurring_service_rows');
  if (services.some(rowRequiresQuote)) reasons.push('quote_required_recurring_row');
  if (services.some(rowHasRecurringAmount)) reasons.push('recurring_row_has_amount');

  const { recurring, nested } = recurringObjects(result);
  if (objectHasRecurringTotal(recurring) || objectHasRecurringTotal(nested)) reasons.push('recurring_object_has_total');

  if (oneTimeAmountForEstimate(estimate, result) <= 0) reasons.push('no_one_time_amount');

  return { match: reasons.length === 0, reasons };
}

function isMisclassifiedOneTimeEstimate(estimate = {}) {
  return classifyMisclassifiedOneTimeEstimate(estimate).match;
}

function isZeroMonthlyAcceptedOneTimeEstimate(estimate = {}) {
  if (String(estimate.status || '') !== 'accepted') return false;
  if (estimate.show_one_time_option === true || estimate.showOneTimeOption === true) return false;
  if (moneyPositive(estimate.monthly_total) || moneyPositive(estimate.monthlyTotal)) return false;
  if (moneyPositive(estimate.annual_total) || moneyPositive(estimate.annualTotal)) return false;

  const estData = parseJson(estimate.estimate_data, {});
  const result = resultFromEstimateData(estData);
  const services = recurringServicesForResult(result);
  if (services.some(rowRequiresQuote)) return false;
  if (services.some(rowHasRecurringAmount)) return false;

  const { recurring, nested } = recurringObjects(result);
  if (objectHasRecurringTotal(recurring) || objectHasRecurringTotal(nested)) return false;

  return oneTimeAmountForEstimate(estimate, result) > 0;
}

async function tableExists(conn, table) {
  return conn.schema.hasTable(table).catch(() => false);
}

async function columnInfo(conn, table) {
  return conn(table).columnInfo().catch(() => ({}));
}

function hasColumn(columns, name) {
  return !!columns && Object.prototype.hasOwnProperty.call(columns, name);
}

function dateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

async function loadMatchedEstimates(conn) {
  const candidates = await conn('estimates')
    .where({ status: 'accepted' })
    .where((q) => q.whereNull('show_one_time_option').orWhere('show_one_time_option', false))
    .whereRaw('COALESCE(monthly_total, 0) = 0')
    .whereRaw('COALESCE(annual_total, 0) = 0')
    .select(
      'id',
      'customer_id',
      'status',
      'accepted_at',
      'customer_name',
      'service_interest',
      'monthly_total',
      'annual_total',
      'onetime_total',
      'show_one_time_option',
      'estimate_data',
      'onboarding_session_id',
    )
    .orderBy('accepted_at', 'asc');

  return candidates.filter(isMisclassifiedOneTimeEstimate);
}

async function loadZeroMonthlyOneTimeEstimates(conn) {
  const candidates = await conn('estimates')
    .where({ status: 'accepted' })
    .where((q) => q.whereNull('show_one_time_option').orWhere('show_one_time_option', false))
    .whereRaw('COALESCE(monthly_total, 0) = 0')
    .whereRaw('COALESCE(annual_total, 0) = 0')
    .select(
      'id',
      'customer_id',
      'status',
      'accepted_at',
      'customer_name',
      'service_interest',
      'monthly_total',
      'annual_total',
      'onetime_total',
      'show_one_time_option',
      'estimate_data',
      'onboarding_session_id',
    )
    .orderBy('accepted_at', 'asc');

  return candidates.filter(isZeroMonthlyAcceptedOneTimeEstimate);
}

async function loadLooseAudit(conn) {
  const candidates = await conn('estimates')
    .where({ status: 'accepted' })
    .where((q) => q.whereNull('show_one_time_option').orWhere('show_one_time_option', false))
    .whereRaw('COALESCE(monthly_total, 0) = 0')
    .whereRaw('COALESCE(annual_total, 0) = 0')
    .select(
      'id',
      'customer_id',
      'status',
      'accepted_at',
      'service_interest',
      'monthly_total',
      'annual_total',
      'onetime_total',
      'show_one_time_option',
      'estimate_data',
      'onboarding_session_id',
    )
    .orderBy('accepted_at', 'desc')
    .limit(250);

  const rejectedReasonCounts = {};
  const nearMisses = [];
  for (const estimate of candidates) {
    const verdict = classifyMisclassifiedOneTimeEstimate(estimate);
    if (verdict.match) continue;
    for (const reason of verdict.reasons) {
      rejectedReasonCounts[reason] = (rejectedReasonCounts[reason] || 0) + 1;
    }
    nearMisses.push({
      id: estimate.id,
      acceptedAt: estimate.accepted_at,
      serviceInterest: estimate.service_interest,
      monthlyTotal: Number(estimate.monthly_total || 0),
      annualTotal: Number(estimate.annual_total || 0),
      onetimeTotal: Number(estimate.onetime_total || 0),
      reasons: verdict.reasons,
    });
  }

  return {
    looseCandidateCount: candidates.length,
    rejectedReasonCounts,
    nearMisses: nearMisses.slice(0, 20),
  };
}

async function loadOtherRecurringEvidence(conn, customerIds, estimateIds) {
  if (!customerIds.length) return new Set();
  const evidence = new Set();

  const otherEstimates = await conn('estimates')
    .whereIn('customer_id', customerIds)
    .whereNotIn('id', estimateIds)
    .where({ status: 'accepted' })
    .where((q) => {
      q.whereRaw('COALESCE(monthly_total, 0) > 0')
        .orWhereRaw('COALESCE(annual_total, 0) > 0');
    })
    .select('customer_id');
  for (const row of otherEstimates) evidence.add(String(row.customer_id));

  const ssColumns = await columnInfo(conn, 'scheduled_services');
  if (hasColumn(ssColumns, 'is_recurring')) {
    const otherServices = await conn('scheduled_services')
      .whereIn('customer_id', customerIds)
      .whereNotIn('status', ['cancelled'])
      .where((q) => {
        q.where('is_recurring', true).orWhereNotNull('recurring_pattern');
      })
      .where((q) => {
        q.whereNull('source_estimate_id').orWhereNotIn('source_estimate_id', estimateIds);
      })
      .select('customer_id');
    for (const row of otherServices) evidence.add(String(row.customer_id));
  }

  return evidence;
}

async function buildPlan(conn) {
  const estimates = await loadMatchedEstimates(conn);
  const zeroMonthlyOneTimeEstimates = await loadZeroMonthlyOneTimeEstimates(conn);
  const cleanupEstimateMap = new Map();
  for (const row of estimates) cleanupEstimateMap.set(row.id, row);
  for (const row of zeroMonthlyOneTimeEstimates) cleanupEstimateMap.set(row.id, row);
  const cleanupEstimates = [...cleanupEstimateMap.values()];
  const estimateIds = estimates.map((row) => row.id);
  const cleanupEstimateIds = cleanupEstimates.map((row) => row.id);
  const customerIds = [...new Set(cleanupEstimates.map((row) => row.customer_id).filter(Boolean))];
  const onboardingIds = [...new Set(cleanupEstimates.map((row) => row.onboarding_session_id).filter(Boolean))];

  const ssColumns = await columnInfo(conn, 'scheduled_services');
  const reminderColumns = await columnInfo(conn, 'appointment_reminders');
  const onboardingColumns = await columnInfo(conn, 'onboarding_sessions');

  const childRows = cleanupEstimateIds.length
    ? await conn('scheduled_services')
      .whereIn('source_estimate_id', cleanupEstimateIds)
      .whereNotNull('recurring_parent_id')
      .whereNotIn('status', ['completed', 'cancelled'])
      .select('id', 'source_estimate_id', 'customer_id', 'scheduled_date', 'service_type', 'status', 'recurring_parent_id')
      .orderBy('scheduled_date', 'asc')
    : [];

  const parentRows = cleanupEstimateIds.length
    ? await conn('scheduled_services')
      .whereIn('source_estimate_id', cleanupEstimateIds)
      .whereNull('recurring_parent_id')
      .where((q) => {
        q.where('service_type', 'ilike', '%Quarterly Pest Control%');
        if (hasColumn(ssColumns, 'is_recurring')) q.orWhere('is_recurring', true);
        if (hasColumn(ssColumns, 'recurring_pattern')) q.orWhereNotNull('recurring_pattern');
      })
      .select('id', 'source_estimate_id', 'customer_id', 'scheduled_date', 'service_type', 'status')
      .orderBy('scheduled_date', 'asc')
    : [];

  const childIds = childRows.map((row) => row.id);
  const parentIds = parentRows.map((row) => row.id);

  const childReminderRows = childIds.length && await tableExists(conn, 'appointment_reminders')
    ? await conn('appointment_reminders')
      .whereIn('scheduled_service_id', childIds)
      .select('id', 'scheduled_service_id', 'service_type', 'appointment_time', 'reminder_72h_sent', 'reminder_24h_sent')
    : [];

  const parentReminderRows = parentIds.length && await tableExists(conn, 'appointment_reminders')
    ? await conn('appointment_reminders')
      .whereIn('scheduled_service_id', parentIds)
      .where('service_type', 'ilike', '%Quarterly Pest Control%')
      .select('id', 'scheduled_service_id', 'service_type', 'appointment_time', 'reminder_72h_sent', 'reminder_24h_sent')
    : [];

  const customers = customerIds.length
    ? await conn('customers')
      .whereIn('id', customerIds)
      .select('id', 'waveguard_tier', 'monthly_rate', 'pipeline_stage')
    : [];
  const otherRecurringEvidence = await loadOtherRecurringEvidence(conn, customerIds, cleanupEstimateIds);
  const customerUpdates = customers.filter((customer) => (
    (String(customer.waveguard_tier || '') === 'Bronze' || customer.waveguard_tier == null)
    && !moneyPositive(customer.monthly_rate)
    && !otherRecurringEvidence.has(String(customer.id))
  ));
  const customerSkippedForRecurringEvidence = customers.filter((customer) => (
    otherRecurringEvidence.has(String(customer.id))
  ));

  const onboardingRows = onboardingIds.length && await tableExists(conn, 'onboarding_sessions')
    ? await conn('onboarding_sessions')
      .whereIn('id', onboardingIds)
      .select('id', 'customer_id', 'status', 'waveguard_tier', 'monthly_rate', 'started_at', 'expires_at')
    : [];

  return {
    looseAudit: await loadLooseAudit(conn),
    columns: { ssColumns, reminderColumns, onboardingColumns },
    estimates,
    zeroMonthlyOneTimeEstimates,
    cleanupEstimates,
    estimateIds,
    cleanupEstimateIds,
    customerIds,
    onboardingIds,
    childRows,
    parentRows,
    childReminderRows,
    parentReminderRows,
    customerUpdates,
    customerSkippedForRecurringEvidence,
    onboardingRows,
  };
}

function printPlan(plan) {
  console.log(JSON.stringify({
    dryRun: !APPLY,
    matchedEstimates: plan.estimates.length,
    matchedEstimateIds: plan.estimateIds,
    zeroMonthlyAcceptedOneTimeEstimates: plan.zeroMonthlyOneTimeEstimates.length,
    cleanupEstimateIds: plan.cleanupEstimateIds,
    affectedCustomers: plan.customerIds.length,
    customerRowsToMarkOneTime: plan.customerUpdates.length,
    customerRowsSkippedForOtherRecurringEvidence: plan.customerSkippedForRecurringEvidence.length,
    phantomScheduledChildrenToDelete: plan.childRows.length,
    childAppointmentRemindersToDelete: plan.childReminderRows.length,
    parentScheduledRowsToRelabel: plan.parentRows.length,
    parentAppointmentRemindersToRelabel: plan.parentReminderRows.length,
    onboardingSessionsToSuppressFollowups: plan.onboardingRows.length,
    sampleScheduledChildren: plan.childRows.slice(0, 10).map((row) => ({
      id: row.id,
      estimateId: row.source_estimate_id,
      date: dateOnly(row.scheduled_date),
      serviceType: row.service_type,
      status: row.status,
    })),
    looseAudit: plan.looseAudit,
  }, null, 2));

  if (!APPLY) {
    console.log('\nDry-run only. Re-run with --apply to mutate DB rows. No outbound modules are loaded.\n');
  }
}

function recurringFlagUpdates(columns) {
  const updates = { service_type: 'Pest Control', updated_at: new Date() };
  if (hasColumn(columns, 'is_recurring')) updates.is_recurring = false;
  if (hasColumn(columns, 'recurring_pattern')) updates.recurring_pattern = null;
  if (hasColumn(columns, 'recurring_ongoing')) updates.recurring_ongoing = false;
  if (hasColumn(columns, 'recurring_nth')) updates.recurring_nth = null;
  if (hasColumn(columns, 'recurring_weekday')) updates.recurring_weekday = null;
  if (hasColumn(columns, 'recurring_interval_days')) updates.recurring_interval_days = null;
  return updates;
}

function onboardingUpdates(columns) {
  const updates = { updated_at: new Date() };
  if (hasColumn(columns, 'followup_24h_sent')) updates.followup_24h_sent = true;
  if (hasColumn(columns, 'followup_72h_sent')) updates.followup_72h_sent = true;
  if (hasColumn(columns, 'followup_expiring_sent')) updates.followup_expiring_sent = true;
  if (hasColumn(columns, 'expires_at')) updates.expires_at = new Date();
  if (hasColumn(columns, 'waveguard_tier')) updates.waveguard_tier = 'One-Time';
  if (hasColumn(columns, 'monthly_rate')) updates.monthly_rate = null;
  return updates;
}

async function applyPlan() {
  return db.transaction(async (trx) => {
    const plan = await buildPlan(trx);

    const childIds = plan.childRows.map((row) => row.id);
    const parentIds = plan.parentRows.map((row) => row.id);
    const customerIdsToUpdate = plan.customerUpdates.map((row) => row.id);
    const onboardingIdsToUpdate = plan.onboardingRows.map((row) => row.id);

    let deletedChildReminders = 0;
    if (childIds.length) {
      deletedChildReminders = await trx('appointment_reminders')
        .whereIn('scheduled_service_id', childIds)
        .delete();
    }

    let deletedChildServices = 0;
    if (childIds.length) {
      deletedChildServices = await trx('scheduled_services')
        .whereIn('id', childIds)
        .delete();
    }

    let updatedParents = 0;
    if (parentIds.length) {
      updatedParents = await trx('scheduled_services')
        .whereIn('id', parentIds)
        .update(recurringFlagUpdates(plan.columns.ssColumns));
    }

    let updatedParentReminders = 0;
    if (parentIds.length) {
      updatedParentReminders = await trx('appointment_reminders')
        .whereIn('scheduled_service_id', parentIds)
        .where('service_type', 'ilike', '%Quarterly Pest Control%')
        .update({ service_type: 'Pest Control', updated_at: new Date() });
    }

    let updatedCustomers = 0;
    if (customerIdsToUpdate.length) {
      updatedCustomers = await trx('customers')
        .whereIn('id', customerIdsToUpdate)
        .where((q) => q.where('waveguard_tier', 'Bronze').orWhereNull('waveguard_tier'))
        .whereRaw('COALESCE(monthly_rate, 0) = 0')
        .update({ waveguard_tier: 'One-Time', monthly_rate: null, updated_at: new Date() });
    }

    let updatedOnboarding = 0;
    if (onboardingIdsToUpdate.length) {
      updatedOnboarding = await trx('onboarding_sessions')
        .whereIn('id', onboardingIdsToUpdate)
        .whereNot('status', 'complete')
        .update(onboardingUpdates(plan.columns.onboardingColumns));
    }

    return {
      plan,
      applied: {
        deletedChildReminders,
        deletedChildServices,
        updatedParents,
        updatedParentReminders,
        updatedCustomers,
        updatedOnboarding,
      },
    };
  });
}

(async function main() {
  try {
    if (!APPLY) {
      const plan = await buildPlan(db);
      printPlan(plan);
      await db.destroy();
      return;
    }

    const result = await applyPlan();
    printPlan(result.plan);
    console.log('\nApplied cleanup:');
    console.log(JSON.stringify(result.applied, null, 2));
    console.log('\nNo outbound modules were loaded or invoked.\n');
    await db.destroy();
  } catch (err) {
    console.error(`Cleanup failed: ${err.stack || err.message}`);
    await db.destroy().catch(() => {});
    process.exit(1);
  }
})();
