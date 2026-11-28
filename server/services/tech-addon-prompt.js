'use strict';

/**
 * Technician Visit Brief — zero-price Add-On Prompt (owner 2026-11-27 "ok go", Decision 3).
 *
 * Surfaces a one-line cross-sell opportunity on the technician's expanded Visit Brief when an
 * active residential recurring customer owns only ONE of the two approved cross-sell pillars
 * at THIS visit's premises (`OFFER_LADDER = ['pest_control', 'lawn_care']`, owner ruling
 * 2026-11-21: never push Tree & Shrub or Termite).
 *
 * Hard constraints honored:
 *   - Uses the canonical premises-scoped ownership authority (`loadOwnedRecurringServiceKeys`
 *     with `streetScope` built via `resolveVisitPropertyScope` / `customerHasOnlyPrimaryPremises`)
 *     AND suppresses whenever `plan-rate-ledger` shows a positive monthly plan rate for the
 *     target family — fail-closed on any lookup error so a technician is NEVER told to pitch
 *     a service the customer already owns or pays for.
 *   - ZERO prices, margins, or discount numbers (owner ruling 2026-11-04: technician visibility).
 *   - Skips commercial customers (`customers.property_type` via `isCommercialProperty`, tier, or
 *     commercial service label) and customers with neither pillar (one-time/assessment visits).
 *   - Pre-fills the existing Field Lead modal (`Lawn` or `Pest`) so the office quotes it and
 *     credits the technician's seller commission (owner ruling 2026-11-09).
 */

const { loadOwnedRecurringServiceKeys } = require('./waveguard-existing-services');
const { OFFER_LADDER } = require('./service-report/cross-sell');
const { isCommercialProperty } = require('./pricing-engine/commercial-helpers');
const { loadComponents } = require('./plan-rate-ledger');
const linkage = require('./estimate-property-linkage');
const {
  resolveVisitPropertyScope,
  customerHasOnlyPrimaryPremises,
} = require('./service-report/visit-property-scope');

const PILLAR_PROMPTS = Object.freeze({
  lawn_care: Object.freeze({
    targetFamily: 'lawn_care',
    targetLabel: 'Lawn Care',
    fieldLeadServiceType: 'Lawn',
    headline: 'No Lawn Care plan on file',
    detail: 'Ask if they want a Lawn Care quote (Silver bundle eligible). Tap below to flag for the office.',
  }),
  pest_control: Object.freeze({
    targetFamily: 'pest_control',
    targetLabel: 'Pest Control',
    fieldLeadServiceType: 'Pest',
    headline: 'No Pest Control plan on file',
    detail: 'Ask if they want a Pest Control quote (Silver bundle eligible). Tap below to flag for the office.',
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
    || /\bcommercial\b/i.test(String(svc.service_type || ''));
}

async function resolveVisitStreetScope(svc, customer, dbh, deps = {}) {
  const primaryStreet = linkage.normalizedStampedStreet(
    customer.address_line1, customer.address_line2, customer.city, customer.zip,
  );
  if (!primaryStreet || linkage.scopeKeyLacksLocality(primaryStreet)) return null;

  const resolveScope = deps.resolveVisitPropertyScope || resolveVisitPropertyScope;
  const scope = await resolveScope(svc, dbh);
  let visitStreet = null;
  if (scope.hasEvidence) {
    if (!scope.key) return null;
    visitStreet = scope.key;
  } else {
    const proveSingle = deps.customerHasOnlyPrimaryPremises || customerHasOnlyPrimaryPremises;
    const onlyPrimary = await proveSingle(dbh, svc.customer_id, customer, primaryStreet, { unresolvedFails: true });
    if (!onlyPrimary) return null;
    visitStreet = primaryStreet;
  }

  return {
    estimateStreet: visitStreet,
    customerPrimaryStreet: primaryStreet,
    requireSharedLocality: true,
  };
}

/**
 * Fail-closed DB loader for the Visit Brief route. Never throws; returns null on any error,
 * unprovable premises, or ambiguous ownership state.
 */
async function techAddonPromptFacts(svc, dbh, deps = {}) {
  if (!svc?.customer_id || !dbh) return null;
  try {
    const customer = await dbh('customers')
      .where({ id: svc.customer_id })
      .first('id', 'property_type', 'active', 'waveguard_tier', 'address_line1', 'address_line2', 'city', 'zip', 'has_multi_home');
    if (!customer || customer.active === false || isCommercialVisit(customer, svc)) return null;

    const streetScope = await resolveVisitStreetScope(svc, customer, dbh, deps);
    if (!streetScope) return null;

    const loadKeys = deps.loadOwnedRecurringServiceKeys || loadOwnedRecurringServiceKeys;
    const loadPlan = deps.loadPlanComponents || loadComponents;
    const [ownedKeys, planComponents] = await Promise.all([
      loadKeys(dbh, svc.customer_id, { streetScope }),
      loadPlan(dbh, svc.customer_id),
    ]);
    const planRateFamilies = (planComponents || [])
      .filter((row) => Number(row.monthly_rate) > 0)
      .map((row) => String(row.family_key || ''))
      .filter((key) => key && key !== 'unattributed');

    return pickTechAddonPrompt(ownedKeys, { isCommercial: false, planRateFamilies });
  } catch {
    // Fail-closed: never pitch a service when ownership, billing, or premises cannot be proved.
    return null;
  }
}

module.exports = {
  PILLAR_PROMPTS,
  pickTechAddonPrompt,
  resolveVisitStreetScope,
  techAddonPromptFacts,
};
