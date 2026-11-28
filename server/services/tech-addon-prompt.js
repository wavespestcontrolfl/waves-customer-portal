'use strict';

/**
 * Technician Visit Brief — zero-price Add-On Prompt (owner 2026-11-27 "ok go", Decision 3).
 *
 * Surfaces a one-line cross-sell opportunity on the technician's expanded Visit Brief when an
 * active residential recurring customer owns only ONE of the two approved cross-sell pillars
 * (`OFFER_LADDER = ['pest_control', 'lawn_care']`, owner ruling 2026-11-21: never push Tree &
 * Shrub or Termite).
 *
 * Hard constraints honored:
 *   - Uses the canonical ownership authority (`loadOwnedRecurringServiceKeys`) — fail-closed on
 *     any lookup error so a technician is NEVER told to pitch a service the customer already owns.
 *   - ZERO prices, margins, or discount numbers (owner ruling 2026-11-04: technician visibility).
 *   - Skips commercial customers and customers with neither pillar (one-time/assessment visits).
 *   - Pre-fills the existing Field Lead modal (`Lawn` or `Pest`) so the office quotes it and
 *     credits the technician's seller commission (owner ruling 2026-11-09).
 */

const { loadOwnedRecurringServiceKeys } = require('./waveguard-existing-services');
const { OFFER_LADDER } = require('./service-report/cross-sell');

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
 * Pure decision over canonical owned recurring keys.
 * Returns a prompt descriptor ONLY when the customer owns one pillar in OFFER_LADDER and is
 * missing the other. Returns null for 0 pillars (non-recurring/new), both pillars, or commercial.
 */
function pickTechAddonPrompt(ownedKeys, { isCommercial = false } = {}) {
  if (isCommercial || !Array.isArray(ownedKeys)) return null;
  const owned = new Set(ownedKeys);
  const ownedPillars = OFFER_LADDER.filter((k) => owned.has(k));
  const missingPillars = OFFER_LADDER.filter((k) => !owned.has(k));
  if (ownedPillars.length !== 1 || missingPillars.length !== 1) return null;
  const target = missingPillars[0];
  return PILLAR_PROMPTS[target] ? { ...PILLAR_PROMPTS[target] } : null;
}

/**
 * Fail-soft DB loader for `deterministicVisitFacts`. Never throws; returns null on any error
 * or ambiguous ownership state.
 */
async function techAddonPromptFacts(svc, dbh, deps = {}) {
  if (!svc?.customer_id || !dbh) return null;
  try {
    const customer = await dbh('customers')
      .where({ id: svc.customer_id })
      .first('id', 'is_commercial', 'active', 'waveguard_tier');
    if (!customer || customer.active === false) return null;
    const isCommercial = customer.is_commercial === true
      || String(customer.waveguard_tier || '').trim().toLowerCase() === 'commercial'
      || /\bcommercial\b/i.test(String(svc.service_type || ''));
    if (isCommercial) return null;

    const loadKeys = deps.loadOwnedRecurringServiceKeys || loadOwnedRecurringServiceKeys;
    const ownedKeys = await loadKeys(dbh, svc.customer_id);
    return pickTechAddonPrompt(ownedKeys, { isCommercial: false });
  } catch {
    // Fail-closed: never pitch a service when ownership cannot be proved.
    return null;
  }
}

module.exports = {
  PILLAR_PROMPTS,
  pickTechAddonPrompt,
  techAddonPromptFacts,
};
