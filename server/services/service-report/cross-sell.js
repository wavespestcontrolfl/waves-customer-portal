// ============================================================
// cross-sell.js — the live service report's "add your next service" offer.
//
// Owner-approved 2026-08-11: a completed-visit report may offer the ONE next
// service family the customer doesn't have (pest ↔ lawn, then tree & shrub,
// then termite bait), priced by the estimator engine when the property data
// supports a real number, or as an unpriced "request a quote" CTA when it
// doesn't. LIVE web views only — the PDF is a permanent service record and
// carries no pricing by documented rule (ServiceReportDocument header).
//
// This module COMPOSES the two existing authorities instead of re-deciding
// anything itself:
//   - loadOwnedRecurringServiceKeys (waveguard-existing-services) answers
//     "which families does this customer already have" — catalog-authoritative
//     and fail-closed (a thrown ownership lookup suppresses the card, because
//     recommending a service the customer may already buy is the one failure
//     this feature must never produce).
//   - buildCustomerPricingResponse (customer-pricing-ai) prices the offer with
//     every money ruling already encoded: never re-price an owned service,
//     PROPERTY_DETAILS_NEEDED instead of guessing at missing measurements,
//     combined WaveGuard-tier pricing, manual-review + confidence flags.
// ============================================================

const logger = require('../logger');

// Offer ladder (owner ruling 2026-08-11): first family the customer lacks
// wins; one offer per report, never stacked. Mosquito is deliberately absent
// — the owner chose termite as the has-everything offer — and palm is
// assessment-first by catalog design (booking_enabled false), never offered.
const OFFER_LADDER = ['pest_control', 'lawn_care', 'tree_shrub', 'termite'];

// Prompts routed through customer-pricing-ai's own SERVICE_MATCHERS so the
// offer prices exactly what the portal pricing panel would price for the same
// words — one vocabulary, no parallel matcher to drift.
const OFFER_PROMPTS = {
  pest_control: 'pest control',
  lawn_care: 'lawn care',
  tree_shrub: 'tree and shrub',
  termite: 'termite',
};

// Card display names — stable copy, independent of pricing-ai's internal
// labels ('termite' would otherwise render as bare "Termite").
const OFFER_LABELS = {
  pest_control: 'Pest Control',
  lawn_care: 'Lawn Care',
  tree_shrub: 'Tree & Shrub Care',
  termite: 'Termite Protection',
};

// The single variant the card shows, matching the generic-prompt default the
// pricing panel auto-selects for each family (quarterly pest, 9x lawn,
// standard T&S; termite has exactly one variant).
const PREFERRED_OPTION_IDS = {
  pest_control: 'pest-quarterly',
  lawn_care: 'lawn-enhanced',
  tree_shrub: 'tree-standard',
  termite: 'termite-basic',
};

// Ownership vocabulary (waveguard-existing-services) spells the termite
// family 'termite_bait'; the pricing-ai offer vocabulary spells it 'termite'.
const OWNED_KEY_TO_OFFER_KEY = { termite_bait: 'termite' };

function offerVocabulary(ownedKeys = []) {
  return new Set(ownedKeys.map((key) => OWNED_KEY_TO_OFFER_KEY[key] || key));
}

function pickOfferTarget(ownedKeys) {
  const owned = offerVocabulary(ownedKeys);
  return OFFER_LADDER.find((key) => !owned.has(key)) || null;
}

function pickOption(options = [], targetKey) {
  if (!options.length) return null;
  return options.find((option) => option.id === PREFERRED_OPTION_IDS[targetKey])
    || options.find((option) => option.serviceKey === targetKey)
    || options[0];
}

// A price may only render when the engine stood behind it: no manual-review
// flag, not low-confidence, and an actual amount. Anything else demotes the
// card to an unpriced request-a-quote CTA — a fallback-derived number on a
// customer surface is the trap this check exists to close.
function optionIsPriceable(option) {
  if (!option) return false;
  if (option.manualReview) return false;
  if (String(option.confidence || '').toLowerCase() === 'low') return false;
  return !!(option.monthly || option.perVisit || option.oneTime);
}

function parseJsonColumn(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function positiveOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Property-dimension seed from the customer's own estimate history: the
// engineInputs blob that priced their live plan is the best evidence for the
// dimensions the profile and cached lookup don't carry (prod audit 2026-08-11:
// without it, effectively NO real report could price an offer). Two hard
// rules (codex #3367 r-prepush ×2):
//   - ACCEPTED estimates only — a draft/sent/expired estimate was never
//     agreed to as money, and an engine auto-draft's fallback dimensions
//     must not launder into a customer-facing price.
//   - When the customer has a primary street, the estimate must RESOLVE to
//     the same street — an addressless or unparsable estimate never seeds
//     (a moved or multi-property customer's legacy estimate could otherwise
//     price the wrong premises).
// Fill-only semantics are enforced downstream in resolvePropertyContext.
async function loadEstimateSeed(database, customerId, primaryStreet) {
  const rows = await database('estimates')
    .where({ customer_id: customerId })
    .orderBy('created_at', 'desc')
    .limit(12)
    .select('id', 'address', 'status', 'estimate_data');
  const linkage = require('../estimate-property-linkage');
  const candidates = [];
  for (const row of rows) {
    if (row.status !== 'accepted') continue;
    const estData = parseJsonColumn(row.estimate_data);
    const inputs = estData?.engineInputs || estData?.inputs;
    if (!inputs || typeof inputs !== 'object') continue;
    if (primaryStreet) {
      const street = linkage.normalizedEstimateStreet(row.address);
      if (!street || !linkage.sameScopeKey(street, primaryStreet)) continue;
    }
    candidates.push({ row, inputs });
  }
  // Rows arrive newest-first, so the first surviving candidate is the most
  // recently accepted same-property estimate.
  const pick = candidates[0];
  if (!pick) return null;
  const inputs = pick.inputs;
  const seed = {
    homeSqFt: positiveOrNull(inputs.homeSqFt),
    lotSqFt: positiveOrNull(inputs.lotSqFt),
    lawnSqFt: positiveOrNull(inputs.lawnSqFt) || positiveOrNull(inputs.turfSf),
    bedArea: positiveOrNull(inputs.bedArea),
    bedAreaSource: typeof inputs.bedAreaSource === 'string' ? inputs.bedAreaSource : null,
    stories: positiveOrNull(inputs.stories),
    storiesSource: typeof inputs.storiesSource === 'string' ? inputs.storiesSource : null,
  };
  const hasAnyDimension = seed.homeSqFt || seed.lotSqFt || seed.lawnSqFt || seed.bedArea || seed.stories;
  return hasAnyDimension ? seed : null;
}

// Default property lookup for the offer price: CACHE-ONLY. The live lookup
// pipeline (geocode + satellite + AI vision, 60s budget) must never run
// inside a report view; a cached row is adopted, a miss prices from the
// stored profile alone and the card degrades to the CTA when that isn't
// enough. Lazy-required — property-lookup-v2 is heavy and cyclic-prone.
async function cacheOnlyPropertyLookup(address) {
  const { performPropertyLookup } = require('../../routes/property-lookup-v2');
  return performPropertyLookup(address, { cacheOnly: true, persist: false });
}

// buildReportCrossSell(service, database) → crossSell payload | null.
// `service` is the reports-public joined row (service_records + customers
// COALESCE address). Best-effort by contract: every failure path returns
// null — the report itself must never notice this feature exists.
async function buildReportCrossSell(service, database, { propertyLookup = cacheOnlyPropertyLookup } = {}) {
  try {
    const customerId = service?.customer_id;
    if (!customerId || !database) return null;

    const customer = await database('customers').where({ id: customerId }).first();
    if (!customer || customer.active === false || customer.deleted_at) return null;

    // Commercial properties never get the card: the engine refuses real
    // prices there (quoteRequired manual review) and commercial expansion is
    // a proposal conversation, not a report card.
    const { isCommercialProperty } = require('../pricing-engine/commercial-helpers');
    if (isCommercialProperty({ propertyType: customer.property_type })) return null;

    // The pricing panel prices the customer's PRIMARY property. A report for
    // a visit stamped at a different address (rental, secondary home) must
    // not carry a price computed for the primary — suppress instead. The
    // route's COALESCE means service.address_line1 already falls back to the
    // customer mirror, so a divergence here is a genuinely stamped one.
    const linkage = require('../estimate-property-linkage');
    const primaryStreet = linkage.normalizedStampedStreet(
      customer.address_line1, customer.address_line2, customer.city, customer.zip
    );
    const reportStreet = linkage.normalizedStampedStreet(
      service.address_line1, service.address_line2, service.city, service.zip
    );
    if (primaryStreet && reportStreet && !linkage.sameScopeKey(reportStreet, primaryStreet)) {
      return null;
    }

    // FAIL CLOSED on ownership: a thrown catalog join means we cannot know
    // what the customer already buys, so no recommendation may render (same
    // doctrine as customer-pricing-ai's PRICING_UNAVAILABLE).
    const { loadOwnedRecurringServiceKeys, ownershipKeysForRow } = require('../waveguard-existing-services');
    const streetScope = primaryStreet
      ? { estimateStreet: primaryStreet, customerPrimaryStreet: primaryStreet }
      : null;
    const ownedKeys = await loadOwnedRecurringServiceKeys(database, customerId, { streetScope });

    // The report's OWN service identity counts as owned (prod audit
    // 2026-08-11): a recurring customer whose next visit isn't seeded yet
    // has zero upcoming rows, and without this a Quarterly Pest report would
    // offer the customer the pest plan they were just serviced under.
    // ownershipFamiliesFromText already refuses one-time and specialty
    // wording, so a cockroach cleanout still resolves no family and keeps
    // its offer-a-plan branch.
    const reportFamilies = ownershipKeysForRow({ service_type: service.service_type });

    const targetKey = pickOfferTarget([...ownedKeys, ...reportFamilies]);
    // Owns the whole ladder → nothing to offer; the report still shows the
    // referral card, which is client-side and needs no payload.
    if (!targetKey) return null;

    // Best-effort seed — a failed estimate read must not kill the card, it
    // just prices without the seed (and likely degrades to the CTA).
    let propertySeed = null;
    try {
      propertySeed = await loadEstimateSeed(database, customerId, primaryStreet);
    } catch (err) {
      logger.warn(`[report-cross-sell] estimate seed skipped (${err.message})`);
    }

    const { buildCustomerPricingResponse } = require('../customer-pricing-ai');
    const result = await buildCustomerPricingResponse({
      customer,
      prompt: OFFER_PROMPTS[targetKey],
      db: database,
      propertyLookup,
      propertySeed,
    });

    // Ownership failed inside the pricer, or the prompt resolved to a
    // service the account already holds (a race with the ladder read above)
    // — both mean no card.
    if (!result || result.code === 'PRICING_UNAVAILABLE') return null;
    if ((result.alreadyIncluded || []).length) return null;

    // Commercial re-check on the RESOLVED type (codex #3367 r4): the early
    // check reads the stored column, but a blank/stale column with a trusted
    // commercial cached-lookup classification would otherwise degrade to a
    // quote CTA instead of the ruled no-card-at-all.
    if (isCommercialProperty({ propertyType: result.property?.propertyType })) return null;

    const option = result.ok ? pickOption(result.options, targetKey) : null;
    const priced = optionIsPriceable(option);

    return {
      serviceKey: targetKey,
      label: OFFER_LABELS[targetKey],
      mode: priced ? 'priced' : 'quote_cta',
      currentServices: result.currentServices || [],
      option: priced ? {
        id: option.id,
        label: option.label,
        cadence: option.cadence || '',
        monthly: option.monthly || null,
        annual: option.annual || null,
        perVisit: option.perVisit || null,
        oneTime: option.oneTime || null,
        dueAtStart: option.dueAtStart || null,
        estimatedPlanMonthly: option.estimatedPlanMonthly || null,
        estimatedAdditionalMonthly: option.estimatedAdditionalMonthly || null,
        waveguardTier: option.waveguardTier || null,
        confidence: option.confidence || null,
        requestSubject: option.requestSubject || '',
        requestDescription: option.requestDescription || '',
      } : null,
    };
  } catch (err) {
    logger.warn(`[report-cross-sell] suppressed (${err.message})`);
    return null;
  }
}

module.exports = {
  buildReportCrossSell,
  // Test hooks: ladder + priceability are the card's two decisions.
  _private: { pickOfferTarget, pickOption, optionIsPriceable, OFFER_LADDER },
};
