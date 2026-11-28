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
 *     with `streetScope` built via `resolveVisitPropertyScope` / `customerHasOnlyPrimaryPremises`,
 *     proven primary premises only so Field Lead never quotes the wrong property) AND suppresses
 *     whenever `plan-rate-ledger` (`strictProbe: true`) shows a positive monthly plan rate for
 *     the target family — fail-closed on any lookup error.
 *   - Checks commercial status across `customers.property_type`, `waveguard_tier`, visit label,
 *     AND the visit's catalog row (`loadCatalogFieldsByRowId` + `isCommercialServiceRow`).
 *   - ZERO prices, margins, discount percentages, or hardcoded tier claims (owner 2026-11-04).
 *   - Pre-fills the existing Field Lead modal (`Lawn` or `Pest`) so the office quotes it and
 *     credits the technician's seller commission (owner ruling 2026-11-09).
 */

const { loadOwnedRecurringServiceKeys, loadCatalogFieldsByRowId } = require('./waveguard-existing-services');
const { isCommercialServiceRow } = require('./self-booking-plan-sync');
const { OFFER_LADDER } = require('./service-report/cross-sell');
const { isCommercialProperty } = require('./pricing-engine/commercial-helpers');
const { loadComponents } = require('./plan-rate-ledger');
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

/**
 * Pure decision over canonical owned recurring keys + positive plan-rate ledger families.
 * Returns a prompt descriptor ONLY when the customer owns one pillar in OFFER_LADDER at this
 * premises, is missing the other, and does not already pay a positive plan rate for the target.
 */
function pickTechAddonPrompt(ownedKeys, { isCommercial = false, planRateFamilies = [] } = {}) {
  if (isCommercial || !Array.isArray(ownedKeys)) return null;
  const owned = new Set(ownedKeys);
  const ownedPillars = OFFER_LADDER.filter((k) => owned.has(k));
  const missingPillars = OFFER_LADDER.filter((k) => !owned.has(k));
  if (ownedPillars.length !== 1 || missingPillars.length !== 1) return null;
  const target = missingPillars[0];
  if (new Set(planRateFamilies).has(target)) return null;
  return PILLAR_PROMPTS[target] ? { ...PILLAR_PROMPTS[target] } : null;
}

function isCommercialVisit(customer, svc) {
  return isCommercialProperty({ propertyType: customer.property_type })
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
 * Fail-closed DB loader for the Visit Brief route. Never throws; returns null on any error,
 * secondary/unprovable premises, commercial catalog row, or ambiguous ownership state.
 */
async function techAddonPromptFacts(svc, dbh, deps = {}) {
  if (!svc?.customer_id || !dbh) return null;
  try {
    const customer = await dbh('customers')
      .where({ id: svc.customer_id })
      .first('id', 'property_type', 'active', 'waveguard_tier', 'address_line1', 'address_line2', 'city', 'zip', 'has_multi_home');
    if (!customer || customer.active === false || isCommercialVisit(customer, svc)) return null;

    const loadCatalog = deps.loadCatalogFieldsByRowId || loadCatalogFieldsByRowId;
    const catalogById = await loadCatalog(dbh, svc.customer_id);
    if (!catalogById) return null;
    const enrichedVisit = { ...svc, ...(svc.id ? (catalogById.get(svc.id) || {}) : {}) };
    if (isCommercialServiceRow(enrichedVisit)) return null;

    const streetScope = await resolvePrimaryVisitStreetScope(svc, customer, dbh, deps);
    if (!streetScope) return null;

    const loadKeys = deps.loadOwnedRecurringServiceKeys || loadOwnedRecurringServiceKeys;
    const loadPlan = deps.loadPlanComponents || loadComponents;
    const [ownedKeys, planComponents] = await Promise.all([
      loadKeys(dbh, svc.customer_id, { streetScope }),
      loadPlan(dbh, svc.customer_id, { strictProbe: true }),
    ]);
    const planRateFamilies = (planComponents || [])
      .filter((row) => Number(row.monthly_rate) > 0)
      .map((row) => String(row.family_key || ''))
      .filter((key) => key && key !== 'unattributed');

    return pickTechAddonPrompt(ownedKeys, { isCommercial: false, planRateFamilies });
  } catch {
    // Fail-closed: never pitch a service when ownership, catalog, billing, or premises cannot be proved.
    return null;
  }
}

module.exports = {
  PILLAR_PROMPTS,
  pickTechAddonPrompt,
  resolvePrimaryVisitStreetScope,
  techAddonPromptFacts,
};
