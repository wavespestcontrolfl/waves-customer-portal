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
    const { loadOwnedRecurringServiceKeys } = require('../waveguard-existing-services');
    const streetScope = primaryStreet
      ? { estimateStreet: primaryStreet, customerPrimaryStreet: primaryStreet }
      : null;
    const ownedKeys = await loadOwnedRecurringServiceKeys(database, customerId, { streetScope });

    const targetKey = pickOfferTarget(ownedKeys);
    // Owns the whole ladder → nothing to offer; the report still shows the
    // referral card, which is client-side and needs no payload.
    if (!targetKey) return null;

    const { buildCustomerPricingResponse } = require('../customer-pricing-ai');
    const result = await buildCustomerPricingResponse({
      customer,
      prompt: OFFER_PROMPTS[targetKey],
      db: database,
      propertyLookup,
    });

    // Ownership failed inside the pricer, or the prompt resolved to a
    // service the account already holds (a race with the ladder read above)
    // — both mean no card.
    if (!result || result.code === 'PRICING_UNAVAILABLE') return null;
    if ((result.alreadyIncluded || []).length) return null;

    const option = result.ok ? pickOption(result.options, targetKey) : null;
    const priced = optionIsPriceable(option);

    return {
      serviceKey: targetKey,
      label: option?.serviceName || OFFER_PROMPTS[targetKey].replace(/\b\w/g, (c) => c.toUpperCase()),
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
