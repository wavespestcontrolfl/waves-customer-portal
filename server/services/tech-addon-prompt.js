'use strict';

/**
 * Technician Visit Brief — zero-price Add-On Prompt (owner 2026-11-27 "ok go", Decision 3).
 *
 * Surfaces a one-line cross-sell opportunity on the technician's expanded Visit Brief when an
 * active residential recurring customer owns only ONE of the two approved cross-sell pillars
 * at THIS visit's primary premises (`OFFER_LADDER = ['pest_control', 'lawn_care']`, owner
 * ruling 2026-11-21: never push Tree & Shrub or Termite).
 *
 * Hard constraints honored (aligned with `plan-start-eligibility.js`):
 *   - Uses canonical premises-scoped live recurring rows (`loadLiveRecurringObligationRows` +
 *     `filterRowsToStreet`), off-calendar legacy/null-status recurring rows, AND ongoing series
 *     roots between visits (`eligibleSeriesParentIds`) scoped to proven primary premises only,
 *     checking `isCommercialServiceRow` BEFORE reducing to family keys so commercial plans at
 *     the same address always suppress residential cross-sell.
 *   - Suppresses whenever `plan-rate-ledger` (`strictProbe: true`) has a positive monthly rate
 *     for the target family OR an unattributed positive rate, OR `plan_holds` has an active hold.
 *   - Excludes soft-deleted customers (`deleted_at IS NULL`) and commercial accounts across
 *     `customers.property_type`, any populated `customers.building_use` (only won commercial
 *     proposals stamp `building_use`, including `'residential'` for HOA communities),
 *     `waveguard_tier`, visit label, and catalog row (`loadCatalogFieldsByRowId`).
 *   - ZERO prices, margins, discount percentages, or hardcoded tier claims (owner 2026-11-04).
 *   - Pre-fills the existing Field Lead modal (`Lawn` or `Pest`) so the office quotes it and
 *     credits the technician's seller commission (owner ruling 2026-11-09).
 */

const {
  loadLiveRecurringObligationRows,
  loadCatalogFieldsByRowId,
  isLiveObligationRow,
  filterRowsToStreet,
  ownershipKeysForRow,
} = require('./waveguard-existing-services');
const { isPlanSeriesRow } = require('./recurring-series-cancel-reseed');
const { eligibleSeriesParentIds } = require('./recurring-series-topup');
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

/**
 * Matches `plan-start-eligibility.js`: ANY populated `building_use` ('residential' for a won
 * HOA commercial proposal or 'nonresidential' for a business building) marks a commercial account.
 */
function isCommercialVisit(customer, svc) {
  return isCommercialProperty({ propertyType: customer.property_type })
    || Boolean(String(customer.building_use || '').trim())
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

function collectResidentialKeysOrNull(rows, catalogById = null) {
  const keys = new Set();
  for (const row of rows) {
    const enriched = catalogById ? { ...row, ...(catalogById.get(row.id) || {}) } : row;
    if (isCommercialServiceRow(enriched)) return null;
    for (const key of ownershipKeysForRow(enriched)) keys.add(key);
  }
  return [...keys];
}

/**
 * Loads live recurring obligation rows scoped to this premises and verifies none are commercial
 * BEFORE reducing to ownership family keys (returns null on commercial uncertainty).
 */
async function loadScopedLiveOwnedKeys(dbh, customerId, { streetScope }) {
  const joined = await loadLiveRecurringObligationRows(dbh, customerId);
  const scoped = await filterRowsToStreet(dbh, joined, streetScope);
  return collectResidentialKeysOrNull(scoped);
}

/**
 * Loads off-calendar live recurring visits that `loadLiveRecurringObligationRows` omits
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
  return collectResidentialKeysOrNull(scoped, catalogById);
}

/**
 * Loads ongoing series roots between scheduled visits (`plan-start-eligibility.js` rule)
 * so an active plan awaiting its next nightly top-up is never pitched as missing.
 */
async function loadOngoingSeriesOwnedKeys(dbh, customerId, { streetScope, catalogById }) {
  const parentIds = await eligibleSeriesParentIds(dbh, { customerId });
  if (!parentIds?.length) return [];
  const roots = await dbh('scheduled_services')
    .where({ customer_id: customerId })
    .whereIn('id', parentIds)
    .select(...OFF_CALENDAR_COLS);
  const scoped = await filterRowsToStreet(dbh, roots, streetScope);
  return collectResidentialKeysOrNull(scoped, catalogById);
}

async function loadActivePlanHoldFamilies(dbh, customerId) {
  const rows = await dbh('plan_holds')
    .where({ customer_id: customerId, status: 'active' })
    .select('family_key');
  return (rows || []).map((r) => String(r.family_key || '')).filter(Boolean);
}

const DEFAULT_FACT_DEPS = Object.freeze({
  loadCatalogFieldsByRowId,
  loadScopedLiveOwnedKeys,
  loadOffCalendarOwnedKeys,
  loadOngoingSeriesOwnedKeys,
  loadPlanComponents: loadComponents,
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

    const [liveKeys, offCalKeys, ongoingKeys, planComponents, heldFamilies] = await Promise.all([
      d.loadScopedLiveOwnedKeys(dbh, svc.customer_id, { streetScope }),
      d.loadOffCalendarOwnedKeys(dbh, svc.customer_id, { streetScope, catalogById }),
      d.loadOngoingSeriesOwnedKeys(dbh, svc.customer_id, { streetScope, catalogById }),
      d.loadPlanComponents(dbh, svc.customer_id, { strictProbe: true }),
      d.loadActivePlanHoldFamilies(dbh, svc.customer_id),
    ]);
    if (!liveKeys || !offCalKeys || !ongoingKeys) return null;

    const activeRates = (planComponents || []).filter((row) => Number(row.monthly_rate) > 0);
    if (activeRates.some((row) => !row.family_key || row.family_key === 'unattributed')) return null;

    return pickTechAddonPrompt([...new Set([...liveKeys, ...offCalKeys, ...ongoingKeys])], {
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
  collectResidentialKeysOrNull,
  loadScopedLiveOwnedKeys,
  loadOffCalendarOwnedKeys,
  loadOngoingSeriesOwnedKeys,
  loadActivePlanHoldFamilies,
  techAddonPromptFacts,
};
