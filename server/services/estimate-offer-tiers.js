/**
 * Good / Better / Best offer tiers for a sent residential pest estimate
 * (owner 2026-10-05, scope ~/gbb-estimates-scope-20261005.md).
 *
 * A tiered estimate is a show_one_time_option estimate that ALSO carries a
 * companion recurring program (lawn and/or tree & shrub). Today that toggle
 * offers two choices — a single visit, or a pest-only plan (the companions
 * are dropped at accept, docs/public-route-contracts.md "companion
 * exclusion"). The tiers name those two choices and add a third:
 *
 *   good   — one visit            serviceMode 'one_time'   (today's path)
 *   better — pest-only plan        serviceMode 'recurring'  (today's path)
 *   best   — the full quoted bundle                          (NEW)
 *
 * Nothing is priced here. The route builds the pest-only ladder for Better
 * and the full-bundle ladder for Best through the SAME shapeFromV1 /
 * buildServiceCadenceCombos calls it already makes, and the accept resolves
 * the customer's `selectedTier` against the stored tiers — the same
 * precompute-then-resolve contract the cadence combos use, so no price is
 * ever trusted from the client.
 *
 * Dark behind GATE_ESTIMATE_OFFER_TIERS (feature-gates.js
 * estimateOfferTiersLive). Gate off: no tiers are built, the payload omits
 * the field, and `selectedTier` on an accept is refused — byte-identical
 * to today.
 */

const OFFER_TIER_KEYS = ['good', 'better', 'best'];
const COMPANION_KEYS = ['lawn_care', 'tree_shrub'];
const DEFAULT_TIER_KEY = 'better';

const TIER_LABELS = {
  good: 'One-time visit',
  better: 'Pest control plan',
  best: 'Pest control + companion plan',
};

function normalizeSelectedOfferTier(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const key = String(raw).trim().toLowerCase();
  return OFFER_TIER_KEYS.includes(key) ? key : 'invalid';
}

/**
 * Pure eligibility: every input is a fact the caller already has. Reasons
 * are stable strings for tests and logs; the payload never carries them.
 */
function offerTierEligibility({
  gateOn = false,
  estimate = {},
  recurringKeys = [],
  optedOutKeys = [],
  memberEvidence = false,
  oneTimeChoicePrice = 0,
  hasPestLadder = false,
} = {}) {
  if (!gateOn) return { eligible: false, reason: 'gate_off' };
  if (!(estimate.show_one_time_option || estimate.showOneTimeOption)) return { eligible: false, reason: 'no_one_time_option' };
  if (String(estimate.category || 'RESIDENTIAL').toUpperCase() !== 'RESIDENTIAL') return { eligible: false, reason: 'not_residential' };
  if (String(estimate.source || '') === 'plan_restart') return { eligible: false, reason: 'plan_restart' };
  if (!hasPestLadder) return { eligible: false, reason: 'no_pest_ladder' };
  const keys = Array.isArray(recurringKeys) ? recurringKeys.filter(Boolean) : [];
  if (!keys.includes('pest_control')) return { eligible: false, reason: 'no_recurring_pest' };
  if (keys.some((key) => String(key).startsWith('commercial_'))) return { eligible: false, reason: 'commercial_line' };
  if (!keys.some((key) => COMPANION_KEYS.includes(key))) return { eligible: false, reason: 'no_companion' };
  if (Array.isArray(optedOutKeys) && optedOutKeys.length) return { eligible: false, reason: 'opted_out_line' };
  if (memberEvidence) return { eligible: false, reason: 'member' };
  if (!(Number(oneTimeChoicePrice) > 0)) return { eligible: false, reason: 'no_one_time_price' };
  return { eligible: true, reason: null };
}

function offerTierServiceKeys(tierKey, recurringKeys = []) {
  const keys = Array.isArray(recurringKeys) ? recurringKeys.filter(Boolean) : [];
  if (tierKey === 'good') return ['one_time_pest'];
  if (tierKey === 'better') return keys.filter((key) => key === 'pest_control');
  return keys;
}

/**
 * The payload block. Better's ladder IS the bundle's own `frequencies`
 * (pest-only, exactly what a show_one_time_option estimate serves today),
 * so it is referenced, not copied. Best carries its own full-bundle ladder
 * and combos; the accept swaps them in for `selectedTier: 'best'`.
 */
function buildOfferTiers({
  oneTimeChoicePrice,
  recurringKeys = [],
  bestFrequencies = [],
  bestServiceCadenceCombos = null,
} = {}) {
  const keys = Array.isArray(recurringKeys) ? recurringKeys.filter(Boolean) : [];
  const best = {
    key: 'best',
    label: TIER_LABELS.best,
    serviceMode: 'recurring',
    services: offerTierServiceKeys('best', keys),
    frequencies: Array.isArray(bestFrequencies) ? bestFrequencies : [],
    ...(Array.isArray(bestServiceCadenceCombos) && bestServiceCadenceCombos.length
      ? { serviceCadenceCombos: bestServiceCadenceCombos }
      : {}),
  };
  return {
    offerTiers: [
      {
        key: 'good',
        label: TIER_LABELS.good,
        serviceMode: 'one_time',
        services: offerTierServiceKeys('good', keys),
        oneTimeTotal: Math.round(Number(oneTimeChoicePrice) * 100) / 100,
      },
      {
        key: 'better',
        label: TIER_LABELS.better,
        serviceMode: 'recurring',
        services: offerTierServiceKeys('better', keys),
        usesBundleFrequencies: true,
      },
      best,
    ],
    offerTierDefaultKey: DEFAULT_TIER_KEY,
  };
}

function offerTiersOf(pricingBundle) {
  return Array.isArray(pricingBundle?.offerTiers) ? pricingBundle.offerTiers : [];
}

/**
 * Accept-side resolution. `raw` is the request's selectedTier. Returns
 * { tier, error } — `tier` null when the client sent none (today's
 * behavior continues), `error` a plain-English 400 message otherwise.
 */
function resolveSelectedOfferTier(pricingBundle, raw, { serviceMode = 'recurring', gateOn = false } = {}) {
  const key = normalizeSelectedOfferTier(raw);
  if (key === null) return { tier: null, error: null };
  if (key === 'invalid') return { tier: null, error: 'selected tier is not one of good, better, best' };
  if (!gateOn) return { tier: null, error: 'offer tiers are not available for this estimate' };
  const tier = offerTiersOf(pricingBundle).find((entry) => entry && entry.key === key) || null;
  if (!tier) return { tier: null, error: 'offer tiers are not available for this estimate' };
  const wantsOneTime = serviceMode === 'one_time';
  if ((tier.serviceMode === 'one_time') !== wantsOneTime) {
    return { tier: null, error: `selected tier ${key} does not match the requested service mode` };
  }
  return { tier, error: null };
}

/** The bundle view today's accept code understands for the chosen tier. */
function pricingBundleForOfferTier(pricingBundle, tier) {
  if (!tier || tier.key !== 'best' || !pricingBundle) return pricingBundle;
  const { serviceCadenceCombos: _dropped, ...rest } = pricingBundle;
  return {
    ...rest,
    frequencies: Array.isArray(tier.frequencies) ? tier.frequencies : pricingBundle.frequencies,
    ...(Array.isArray(tier.serviceCadenceCombos) && tier.serviceCadenceCombos.length
      ? { serviceCadenceCombos: tier.serviceCadenceCombos }
      : {}),
    offerTierApplied: 'best',
  };
}

/**
 * The show_one_time_option "companion exclusion" (pest-only recurring
 * choice) stands for every accept EXCEPT a resolved Best tier.
 */
function offerTierKeepsCompanions(tier) {
  return !!tier && tier.key === 'best';
}

module.exports = {
  OFFER_TIER_KEYS,
  COMPANION_KEYS,
  DEFAULT_TIER_KEY,
  TIER_LABELS,
  normalizeSelectedOfferTier,
  offerTierEligibility,
  offerTierServiceKeys,
  buildOfferTiers,
  offerTiersOf,
  resolveSelectedOfferTier,
  pricingBundleForOfferTier,
  offerTierKeepsCompanions,
};
