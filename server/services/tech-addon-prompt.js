'use strict';

/**
 * Technician Visit Brief — zero-price Add-On Prompt (owner 2026-11-27 "ok go", Decision 3).
 *
 * Surfaces a one-line cross-sell opportunity on the technician's expanded Visit Brief when an
 * active residential recurring customer owns only ONE of the two approved cross-sell pillars
 * at THIS visit's primary premises (`OFFER_LADDER = ['pest_control', 'lawn_care']`, owner
 * ruling 2026-11-21: never push Tree & Shrub or Termite).
 *
 * Hard constraints honored:
 *   - Uses the canonical premises-scoped ownership authority (`loadOwnedRecurringServiceKeys`
 *     + off-calendar legacy/null-status recurring rows per `plan-start-eligibility.js`, scoped
 *     via `filterRowsToStreet` to proven primary premises only so Field Lead never quotes the
 *     wrong property) AND suppresses whenever `plan-rate-ledger` (`strictProbe: true`) shows a
 *     positive monthly rate OR `plan_holds` has an active hold for the target family.
 *   - Excludes soft-deleted customers (`deleted_at IS NULL`) and commercial accounts across
 *     `customers.property_type`, `customers.building_use`, `waveguard_tier`, visit label, and
 *     the visit's catalog row (`loadCatalogFieldsByRowId` + `isCommercialServiceRow`).
 *   - ZERO prices, margins, discount percentages, or hardcoded tier claims (owner 2026-11-04).
 *   - Pre-fills the existing Field Lead modal (`Lawn` or `Pest`) so the office quotes it and
 *     credits the technician's seller commission (owner ruling 2026-11-09).
 */

const {
  loadOwnedRecurringServiceKeys,
  loadCatalogFieldsByRowId,
  isLiveObligationRow,
  filterRowsToStreet,
  ownershipKeysForRow,
} = require('./waveguard-existing-services');
const { isPlanSeriesRow } = require('./recurring-series-cancel-reseed');
const { isCommercialServiceRow } = require('./self-booking-plan-sync');
const { OFFER_LADDER } = require('./service-report/cross-sell');
const { isCommercialProperty } = require('./pricing-engine/commercial-helpers');
const { loadComponents } = require('./plan-rate-ledger');
const { etDateString } = require('../utils/datetime-et');
const linkage = require('./estimate-property-linkage');
const {
  resolveVisitPropertyScope,
  sameResolvedProperty,
  customerHasOnlyPrimaryPremises,
} = require('./service-report/visit-property-scope');

const PILLAR_PROMPTS = Object.freeze({
  lawn_care: Object.freeze({
    targetFamily: 'lawn_care',
    targetLabel: 'Lawn Care',
    fieldLeadServiceType: 'Lawn',
    headline: 'No Lawn Care plan on file',
    detail: 'Ask if they want a Lawn Care quote (WaveGuard bundle savings apply). Tap below to flag for the office.',
  }),
  pest_control: Object.freeze({
    targetFamily: 'pest_control',
    targetLabel: 'Pest Control',
    fieldLeadServiceType: 'Pest',
    headline: 'No Pest Control plan on file',
    detail: 'Ask if they want a Pest Control quote (WaveGuard bundle savings apply). Tap below to flag for the office.',
  }),
});

const OFF_CALENDAR_COLS = Object.freeze([
  'id', 'customer_id', 'service_type', 'scheduled_date', 'status', 'source',
  'is_recurring', 'recurring_parent_id', 'is_callback', 'followup_included',
  'service_address_line1', 'service_address_line2', 'service_address_city', 'service_address_zip',
  'property_id', 'source_estimate_id',
]);

/**
 * Pure decision over canonical owned recurring keys + suppressed families (billed plan rates
 * and active plan holds). Returns a prompt descriptor ONLY when the customer owns one pillar
 * in OFFER_LADDER at this premises and neither owns nor is billed/paused on the other.
 */
function pickTechAddonPrompt(ownedKeys, { isCommercial = false, planRateFamilies = [], heldFamilies = [] } = {}) {
  if (isCommercial || !Array.isArray(ownedKeys)) return null;
  const owned = new Set(ownedKeys);
  const ownedPillars = OFFER_LADDER.filter((k) => owned.has(k));
  const missingPillars = OFFER_LADDER.filter((k) => !owned.has(k));
  if (ownedPillars.length !== 1 || missingPillars.length !== 1) return null;
  const target = missingPillars[0];
  const suppressed = new Set([...planRateFamilies, ...heldFamilies]);
  if (suppressed.has(target)) return null;
  return PILLAR_PROMPTS[target] ? { ...PILLAR_PROMPTS[target] } : null;
}

function isCommercialVisit(customer, svc) {
  return isCommercialProperty({ propertyType: customer.property_type })
    || String(customer.building_use || '').trim().toLowerCase() === 'nonresidential'
    || String(customer.waveguard_tier || '').trim().toLowerCase() === 'commercial'
    || isCommercialServiceRow(svc);
}

/**
 * Resolves a primary-premises streetScope for this visit, or null.
 * Secondary-property visits are suppressed because Field Lead saves leads at the customer's
 * primary address (never risk quoting the wrong property).
 */
async function resolvePrimaryVisitStreetScope(svc, customer, dbh, deps = {}) {
  const primaryStreet = linkage.normalizedStampedStreet(
    customer.address_line1, customer.address_line2, customer.city, customer.zip,
  );
  if (!primaryStreet || linkage.scopeKeyLacksLocality(primaryStreet)) return null;

  const resolveScope = deps.resolveVisitPropertyScope || resolveVisitPropertyScope;
  const scope = await resolveScope(svc, dbh);
  if (scope.hasEvidence) {
    if (!scope.key || !sameResolvedProperty(scope.key, primaryStreet)) return null;
  } else {
    const proveSingle = deps.customerHasOnlyPrimaryPremises || customerHasOnlyPrimaryPremises;
    const onlyPrimary = await proveSingle(dbh, svc.customer_id, customer, primaryStreet, { unresolvedFails: true });
    if (!onlyPrimary) return null;
  }

  return {
    estimateStreet: primaryStreet,
    customerPrimaryStreet: primaryStreet,
    requireSharedLocality: true,
  };
}

/**
 * Loads off-calendar live recurring visits that `loadOwnedRecurringServiceKeys` omits
 * (legacy `is_recurring IS NULL` with `recurring_parent_id`, or `is_recurring = true` with
 * `status IS NULL`), scoped to the exact same visit premises (`filterRowsToStreet`).
 */
async function loadOffCalendarOwnedKeys(dbh, customerId, { streetScope, catalogById }) {
  const [legacy, noStatus] = await Promise.all([
    dbh('scheduled_services')
      .where({ customer_id: customerId })
      .whereNull('is_recurring')
      .whereNotNull('recurring_parent_id')
      .select(...OFF_CALENDAR_COLS),
    dbh('scheduled_services')
      .where({ customer_id: customerId, is_recurring: true })
      .whereNull('status')
      .select(...OFF_CALENDAR_COLS),
  ]);
  const today = etDateString();
  const live = [...legacy, ...noStatus].filter((row) => isPlanSeriesRow(row) && isLiveObligationRow(row, today));
  if (!live.length) return [];
  const scoped = await filterRowsToStreet(dbh, live, streetScope);
  const keys = new Set();
  for (const row of scoped) {
    const enriched = { ...row, ...(catalogById.get(row.id) || {}) };
    if (isCommercialServiceRow(enriched)) return null;
    for (const key of ownershipKeysForRow(enriched)) keys.add(key);
  }
  return [...keys];
}

async function loadActivePlanHoldFamilies(dbh, customerId) {
  const rows = await dbh('plan_holds')
    .where({ customer_id: customerId, status: 'active' })
    .select('family_key');
  return (rows || []).map((r) => String(r.family_key || '')).filter(Boolean);
}

const DEFAULT_FACT_DEPS = Object.freeze({
  loadCatalogFieldsByRowId,
  loadOwnedRecurringServiceKeys,
  loadPlanComponents: loadComponents,
  loadOffCalendarOwnedKeys,
  loadActivePlanHoldFamilies,
});

/**
 * Fail-closed DB loader for the Visit Brief route. Never throws; returns null on any error,
 * deleted/commercial account, secondary/unprovable premises, unattributed billed coverage,
 * or ambiguous ownership state.
 */
async function techAddonPromptFacts(svc, dbh, deps = {}) {
  if (!svc?.customer_id || !dbh) return null;
  const d = { ...DEFAULT_FACT_DEPS, ...deps };
  try {
    const customer = await dbh('customers')
      .where({ id: svc.customer_id })
      .whereNull('deleted_at')
      .first(
        'id', 'property_type', 'building_use', 'active', 'waveguard_tier',
        'address_line1', 'address_line2', 'city', 'zip', 'has_multi_home',
      );
    if (!customer || customer.active === false || isCommercialVisit(customer, svc)) return null;

    const catalogById = await d.loadCatalogFieldsByRowId(dbh, svc.customer_id);
    if (!catalogById) return null;
    if (isCommercialServiceRow({ ...svc, ...(catalogById.get(svc.id) || {}) })) return null;

    const streetScope = await resolvePrimaryVisitStreetScope(svc, customer, dbh, deps);
    if (!streetScope) return null;

    const [ownedKeys, offCalKeys, planComponents, heldFamilies] = await Promise.all([
      d.loadOwnedRecurringServiceKeys(dbh, svc.customer_id, { streetScope }),
      d.loadOffCalendarOwnedKeys(dbh, svc.customer_id, { streetScope, catalogById }),
      d.loadPlanComponents(dbh, svc.customer_id, { strictProbe: true }),
      d.loadActivePlanHoldFamilies(dbh, svc.customer_id),
    ]);
    if (!offCalKeys) return null;

    const activeRates = (planComponents || []).filter((row) => Number(row.monthly_rate) > 0);
    if (activeRates.some((row) => !row.family_key || row.family_key === 'unattributed')) return null;

    return pickTechAddonPrompt([...new Set([...(ownedKeys || []), ...offCalKeys])], {
      isCommercial: false,
      planRateFamilies: activeRates.map((row) => String(row.family_key)),
      heldFamilies,
    });
  } catch {
    // Fail-closed: never pitch a service when ownership, holds, catalog, billing, or premises cannot be proved.
    return null;
  }
}

module.exports = {
  PILLAR_PROMPTS,
  pickTechAddonPrompt,
  resolvePrimaryVisitStreetScope,
  loadOffCalendarOwnedKeys,
  loadActivePlanHoldFamilies,
  techAddonPromptFacts,
};
