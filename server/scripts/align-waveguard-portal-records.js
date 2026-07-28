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
//   --limit N            cap the number of customers processed (per candidate pass)
//   --customer-id <uuid> process a single customer
//   --enroll-no-plan     ALSO enroll "No Plan" customers who have an UPCOMING
//                        recurring qualifying service (owner directive
//                        2026-07-28: an upcoming recurring series means the
//                        customer belongs on a tier — 1 family = Bronze,
//                        2 = Silver, 3 = Gold, 4+ = Platinum). This pass sets
//                        waveguard_tier ONLY: never monthly_rate (billing-cron
//                        monthly-charges any active customer with
//                        monthly_rate > 0 — per-visit customers must stay
//                        per-visit), and never member_since / pipeline_stage /
//                        active. Direct DB writes fire ZERO customer
//                        communications — the membership.started email lives in
//                        the admin PATCH route, and the customers table has no
//                        DB triggers — which is exactly the intent here.
//                        Commercial-sentinel customers are excluded (commercial
//                        plans are flat and never carry a WaveGuard tier).
//
require('dotenv').config();

const db = require('../models/db');
const {
  TERMINAL_STATUSES,
  isMembershipCustomerRow,
} = require('../services/waveguard-existing-services');
const {
  ONE_TIME_BOOKING_SOURCE_VALUES,
  SELF_BOOKING_RECURRING_PLANS,
  resolveLawnCareRecurringPlan,
  resolveMosquitoRecurringPlan,
  resolvePestControlRecurringPlan,
  resolveTermiteBaitRecurringPlan,
  resolveTreeShrubRecurringPlan,
  isCommercialServiceRow,
  isRodentLedServiceRow,
  serviceRowCountsTowardWaveGuard,
} = require('../services/self-booking-plan-sync');
const { etDateString } = require('../utils/datetime-et');

const TIER_ORDER = ['Bronze', 'Silver', 'Gold', 'Platinum'];
const TIER_ORDER_LOWER = TIER_ORDER.map(tier => tier.toLowerCase());

const SERVICE_PLANS = { ...SELF_BOOKING_RECURRING_PLANS };

// Flags that take a value; everything else is a boolean switch. Supports both
// `--limit=20` and `--limit 20` (the usage text documents the space form), so a
// documented command never silently drops its cap / customer filter.
const VALUE_FLAGS = new Set(['limit', 'customer-id']);

function parseArgs(argv = []) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (VALUE_FLAGS.has(key) && next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const ARGS = parseArgs(process.argv.slice(2));

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
const ENROLL_NO_PLAN = parseBooleanFlag(ARGS['enroll-no-plan']);

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

// Mirrors membershipTierKey in waveguard-existing-services.js (not exported
// there) — only used to recognize the commercial sentinel, which must never be
// converted into a WaveGuard tier (commercial plans are flat, outside tiers).
function tierSentinelKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function columnPresent(columns, column) {
  return !!columns[column];
}

function setIfColumn(target, columns, column, value) {
  if (columnPresent(columns, column)) target[column] = value;
}

function buildCustomerUpdates(customer, detectedKeys, columns, today) {
  const updates = {};
  // This pass re-aligns already-enrolled WaveGuard members only; enrolling a
  // "No Plan" customer with upcoming recurring coverage is the separate opt-in
  // --enroll-no-plan pass (buildNoPlanEnrollmentUpdates — owner directive
  // 2026-07-28, tier-only). Use the shared membership predicate, which rejects
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

  // Backfill a zero/missing monthly_rate ONLY for an explicit
  // monthly_membership billing lane. Since the 2026-07-28 auto-tier directive,
  // holding a tier no longer implies monthly billing — inventing a rate for a
  // NULL/per-visit lane customer would put them into billing-cron's
  // monthly-charge pool. Mirrors buildCustomerWaveGuardAlignmentUpdates.
  if (
    columnPresent(columns, 'monthly_rate')
    && customer.billing_mode === 'monthly_membership'
    && existingRate <= 0
    && detectedKeys.length
  ) {
    updates.monthly_rate = representativePlanKeys(detectedKeys)
      .reduce((sum, key) => sum + moneyNumber(SERVICE_PLANS[key]?.monthlyRate), 0);
  }

  return updates;
}

// --enroll-no-plan updates: waveguard_tier ONLY, and only for a customer who
// is NOT already a member (fail-closed via the shared membership predicate —
// members are re-aligned by buildCustomerUpdates, never double-handled here).
// Deliberately never sets monthly_rate (billing-cron auto-charges active
// customers with monthly_rate > 0 — enrolling a per-visit customer into
// autopay billing is the exact failure the old owner policy guarded against),
// and never touches member_since / pipeline_stage / active. The 2026-07-28
// directive is narrowly "list them under a tier", nothing more.
function buildNoPlanEnrollmentUpdates(customer, detectedKeys, columns) {
  const updates = {};
  if (isMembershipCustomerRow(customer)) return updates;
  if (tierSentinelKey(customer?.waveguard_tier) === 'commercial') return updates;
  if (!columnPresent(columns, 'waveguard_tier')) return updates;
  const inferredTier = inferTierFromServiceCount(uniqueServiceFamilies(detectedKeys).length);
  if (!inferredTier) return updates;
  updates.waveguard_tier = inferredTier;
  // Provenance: mark the stamp as auto-derived so only these tiers are ever
  // auto-realigned or excluded from member messaging (mirrors the runtime
  // enrollment path; Codex #3011 r7 P1). Column-guarded for older envs.
  if (columnPresent(columns, 'waveguard_tier_source')) updates.waveguard_tier_source = 'auto';
  return updates;
}

function applyCustomerFilters(query, customerColumns) {
  if (!INCLUDE_INACTIVE && columnPresent(customerColumns, 'active')) query = query.where('c.active', true);
  if (columnPresent(customerColumns, 'deleted_at')) query = query.whereNull('c.deleted_at');
  return query;
}

function customerSelect(query, customerColumns = {}) {
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
    // billing_mode ships in migration 20260709000010 — select it only where
    // it exists so the script still runs on older environments (its absence
    // simply keeps the monthly_rate backfill guard closed).
    ...(columnPresent(customerColumns, 'billing_mode') ? ['c.billing_mode'] : []),
    ...(columnPresent(customerColumns, 'waveguard_tier_source') ? ['c.waveguard_tier_source'] : []),
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
  query = customerSelect(applyCustomerFilters(query, customerColumns), customerColumns);
  if (LIMIT) query = query.limit(LIMIT);

  return (await query).map((customer) => ({
    ...customer,
    candidate_reason: normalizeTierName(customer.waveguard_tier) ? 'enrolled_tier' : 'enrolled_legacy_rate',
  }));
}

// Candidate set for --enroll-no-plan: customers who are NOT enrolled (no
// recognized tier AND no positive monthly_rate — the complement of
// candidateCustomers, so the two passes can never overlap) but have at least
// one UPCOMING non-terminal scheduled service. The is_recurring EXISTS filter
// is a cheap pre-screen; the authoritative per-row gate stays
// serviceRowCountsTowardWaveGuard + the upcoming-date check in
// analyzeCustomer, mirroring how the alignment pass treats its rows.
async function noPlanCandidateCustomers(customerColumns, today) {
  let scheduledColumns = {};
  try {
    scheduledColumns = await db('scheduled_services').columnInfo();
  } catch (_err) {
    scheduledColumns = {};
  }
  const hasIsRecurring = columnPresent(scheduledColumns, 'is_recurring');

  let query = db('customers as c')
    .where(function notEnrolled() {
      this.where(function noRecognizedTier() {
        this.whereNull('c.waveguard_tier').orWhereRaw(
          `LOWER(c.waveguard_tier) NOT IN (${TIER_ORDER_LOWER.map(() => '?').join(', ')})`,
          TIER_ORDER_LOWER,
        );
      }).andWhere(function noLegacyRate() {
        this.whereNull('c.monthly_rate').orWhere('c.monthly_rate', '<=', 0);
      });
    })
    .whereExists(function upcomingService() {
      this.select(db.raw('1'))
        .from('scheduled_services as s')
        .whereRaw('s.customer_id = c.id')
        .whereNotIn('s.status', TERMINAL_STATUSES)
        .where('s.scheduled_date', '>=', today);
      if (hasIsRecurring) this.where('s.is_recurring', true);
      // Mirror the runtime reconcile's pre-screen (Codex #3011 r3): rows the
      // authoritative predicate rejects anyway (callbacks, one-time booking
      // sources) must not admit a candidate — with --limit N and created_at
      // ordering, such false positives would occupy every batch forever and
      // starve valid later customers.
      if (columnPresent(scheduledColumns, 'is_callback')) {
        this.where(function notCallback() {
          this.whereNull('s.is_callback').orWhere('s.is_callback', false);
        });
      }
      if (columnPresent(scheduledColumns, 'source')) {
        this.where(function notOneTimeSource() {
          this.whereNull('s.source').orWhereNotIn('s.source', ONE_TIME_BOOKING_SOURCE_VALUES);
        });
      }
    })
    // Random sampling, like the runtime reconcile (Codex #3011 r4): rows the
    // SQL pre-screen cannot reject (recurring palm/rodent work that maps to
    // no WaveGuard family) would otherwise pin a created_at-ordered --limit
    // batch forever and starve valid later customers.
    .orderByRaw('random()');

  if (CUSTOMER_ID) query = query.where('c.id', CUSTOMER_ID);
  query = customerSelect(applyCustomerFilters(query, customerColumns), customerColumns);
  if (LIMIT) query = query.limit(LIMIT);

  return (await query).map((customer) => ({
    ...customer,
    candidate_reason: 'no_plan_upcoming_recurring',
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
  const enrollNoPlan = customer.candidate_reason === 'no_plan_upcoming_recurring';
  let recurringRows = rows.filter(serviceRowCountsTowardWaveGuard);
  if (enrollNoPlan) {
    // The enrollment directive is keyed on UPCOMING coverage: only rows dated
    // today or later count toward the tier, so a lapsed series (all visits in
    // the past) never enrolls anyone.
    recurringRows = recurringRows.filter((row) => {
      // Commercial and rodent-led rows are never enrollment evidence,
      // independent of the customer's sentinel — an un-sentineled commercial
      // customer must not be stamped a residential tier, and a "Rodent Pest
      // Control" row is a rodent service, not pest coverage (Codex #3011
      // r4/r6 P1, mirrors the runtime detectUpcomingRecurringPlanKeys).
      if (isCommercialServiceRow(row) || isRodentLedServiceRow(row)) return false;
      const rowDate = dateKey(row.scheduled_date);
      return rowDate && rowDate >= today;
    });
  }
  const detectedKeys = [];
  for (const row of recurringRows) {
    for (const key of detectServiceKeys(row)) {
      if (!detectedKeys.includes(key)) detectedKeys.push(key);
    }
  }

  const earliestServiceDate = recurringRows.map((row) => dateKey(row.scheduled_date)).filter(Boolean).sort()[0] || null;
  const customerWithDates = { ...customer, earliest_service_date: earliestServiceDate };
  const customerUpdates = enrollNoPlan
    ? buildNoPlanEnrollmentUpdates(customerWithDates, detectedKeys, customerColumns)
    : buildCustomerUpdates(customerWithDates, detectedKeys, customerColumns, today);
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
  if (!Object.keys(repair.customerUpdates).length) return;

  const isEnrollment = repair.customer.candidate_reason === 'no_plan_upcoming_recurring';
  let updateQuery = db('customers').where({ id: repair.customer.id });
  if (isEnrollment) {
    // Compare-and-swap on the read snapshot, mirroring the runtime enrollment
    // path (Codex #3011 r2 P1): candidates were read earlier in main(), so a
    // customer converted to a paid membership mid-run must match zero rows
    // here — never have the conversion's tier overwritten by a stale label.
    if (repair.customer.waveguard_tier == null) {
      updateQuery = updateQuery.whereNull('waveguard_tier');
    } else {
      updateQuery = updateQuery.where('waveguard_tier', repair.customer.waveguard_tier);
    }
    updateQuery = updateQuery.where(function notPayingRate() {
      this.whereNull('monthly_rate').orWhere('monthly_rate', '<=', 0);
    });
    if ('billing_mode' in repair.customer) {
      if (repair.customer.billing_mode == null) {
        updateQuery = updateQuery.whereNull('billing_mode');
      } else {
        updateQuery = updateQuery.where('billing_mode', repair.customer.billing_mode);
      }
    }
  }
  const updatedCount = await updateQuery.update(repair.customerUpdates);
  if (isEnrollment && !updatedCount) {
    console.error(`enrollment skipped for customer ${repair.customer.id} — customer changed since candidate read`);
    return;
  }

  // Mirror the runtime enrollment path's audit trail (Codex #3011 P2): a bulk
  // --enroll-no-plan --apply can change hundreds of membership labels, and
  // each one must leave the same waveguard_tier_auto_enrolled activity row
  // the booking-time sync writes. Best-effort — a missing table or failed
  // insert never aborts the backfill.
  if (!isEnrollment) return;
  try {
    if (!(await db.schema.hasTable('activity_log'))) return;
    await db('activity_log').insert({
      customer_id: repair.customer.id,
      action: 'waveguard_tier_auto_enrolled',
      description: `Auto-enrolled WaveGuard ${repair.customerUpdates.waveguard_tier} from upcoming recurring services (align-waveguard-portal-records --enroll-no-plan)`,
      metadata: {
        detected_plan_keys: repair.detectedKeys,
        detected_family_keys: repair.detectedFamilyKeys,
        updates: repair.customerUpdates,
        source: 'align-waveguard-portal-records',
      },
    });
  } catch (err) {
    console.error(`activity_log insert failed for customer ${repair.customer.id}: ${err.message}`);
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
  if (ENROLL_NO_PLAN) customers.push(...await noPlanCandidateCustomers(customerColumns, today));
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
    noPlanEnrollments: repairs.filter((repair) => repair.customer.candidate_reason === 'no_plan_upcoming_recurring').length,
    noServiceEvidenceCount: noServiceEvidence.length,
    tierMismatchCount: tierMismatches.length,
    limit: LIMIT,
    customerId: CUSTOMER_ID,
    includeInactive: INCLUDE_INACTIVE,
    enrollNoPlan: ENROLL_NO_PLAN,
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
  buildNoPlanEnrollmentUpdates,
  dateKey,
  detectServiceKeys,
  inferTierFromServiceCount,
  normalizeTierName,
  parseArgs,
  parseBooleanFlag,
  representativePlanKeys,
  serviceFamilyKey,
  uniqueServiceFamilies,
};
