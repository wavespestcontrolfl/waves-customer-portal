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
// flag, not low-confidence, and a real PER-APPLICATION amount (the only
// unit the card is allowed to show — AGENTS.md per-application rule).
// Anything else demotes the card to an unpriced request-a-quote CTA — a
// fallback-derived number on a customer surface is the trap this check
// exists to close.
// At least one locality field (city or zip) present on BOTH keys and equal.
// sameScopeKey compares each locality field only when both sides carry it,
// so disjoint evidence — a city-only primary against a zip-only stamp —
// matches across cities (codex #3367 PR r6). Property equality here needs
// one SHARED locality proof, not merely the absence of contradiction.
function scopeKeysShareLocality(a, b) {
  const [, ac, az] = String(a || '').split('|');
  const [, bc, bz] = String(b || '').split('|');
  return (!!ac && !!bc && ac === bc) || (!!az && !!bz && az === bz);
}

function optionIsPriceable(option) {
  if (!option) return false;
  if (option.manualReview) return false;
  if (String(option.confidence || '').toLowerCase() === 'low') return false;
  // A positive one-time/setup component may not price on the card (codex
  // #3367 PR r5): per-application is the ONLY price field this payload may
  // carry (r7 ruling), so a termite-basic dueAtStart would price-lock an
  // undisclosed charge — demote to the quote CTA instead.
  if (Number(option.dueAtStart) > 0 || Number(option.oneTime) > 0) return false;
  return Number(option.perVisit) > 0;
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
//   - The estimate must RESOLVE to the property being reported on
//     (scopeStreet = the customer's primary street, or the report's stamped
//     street when the mirror is blank). No scope street, or an addressless/
//     unparsable estimate → NO seed (codex #3367 r5: a moved or
//     multi-property customer's legacy estimate could otherwise price the
//     wrong premises).
// Fill-only semantics are enforced downstream in resolvePropertyContext.
async function loadEstimateSeed(database, customerId, scopeStreet) {
  if (!scopeStreet) return null;
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
    const street = linkage.normalizedEstimateStreet(row.address);
    if (!street || !linkage.sameScopeKey(street, scopeStreet)) continue;
    // A street-only key (no city, no zip) wildcard-matches EVERY
    // same-street property under sameScopeKey's lenient locality rule
    // (codex #3367 PR r3): a multi-property customer with the same street
    // name in two cities could seed the wrong premises. The scope
    // machinery marks these ambiguous legacy keys explicitly — no
    // disambiguation, no seed (an older fully-qualified estimate may still
    // seed instead).
    if (linkage.scopeKeyLacksLocality(street)) continue;
    // Same shared-locality proof as the visit stamp (PR r6): disjoint
    // locality fields (city-only vs zip-only) must not match across cities.
    if (!scopeKeysShareLocality(street, scopeStreet)) continue;
    candidates.push({ row, inputs });
  }
  // Rows arrive newest-first, so the first surviving candidate is the most
  // recently accepted same-property estimate.
  const pick = candidates[0];
  if (!pick) return null;
  const inputs = pick.inputs;
  const cleanString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
  const seed = {
    homeSqFt: positiveOrNull(inputs.homeSqFt),
    lotSqFt: positiveOrNull(inputs.lotSqFt),
    lawnSqFt: positiveOrNull(inputs.lawnSqFt) || positiveOrNull(inputs.turfSf),
    bedArea: positiveOrNull(inputs.bedArea),
    bedAreaSource: cleanString(inputs.bedAreaSource),
    stories: positiveOrNull(inputs.stories),
    storiesSource: cleanString(inputs.storiesSource),
    // Non-dimensional pricing evidence rides with the dimensions (codex
    // #3367 PR r1): a pool-cage home whose accepted estimate carried the
    // modifiers must not price as a bare property on a lookup cache miss.
    features: inputs.features && typeof inputs.features === 'object' && !Array.isArray(inputs.features)
      ? inputs.features
      : null,
    propertyType: cleanString(inputs.propertyType),
    yearBuilt: positiveOrNull(inputs.yearBuilt),
    constructionMaterial: cleanString(inputs.constructionMaterial),
    foundationType: cleanString(inputs.foundationType),
    roofType: cleanString(inputs.roofType),
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
    // a proposal conversation, not a report card. Checked on the stored
    // column here, on the report's OWN service identity (codex #3367 r8: an
    // explicitly commercial report with a blank property_type column must
    // not fall through to the single_family default), and again on the
    // lookup-resolved type after pricing.
    const { isCommercialProperty } = require('../pricing-engine/commercial-helpers');
    if (isCommercialProperty({ propertyType: customer.property_type })) return null;
    if (/\bcommercial\b/i.test(String(service.service_type || ''))) return null;

    // The pricing panel prices the customer's PRIMARY property. A report for
    // a visit stamped at a different address (rental, secondary home) must
    // not carry a price computed for the primary — suppress instead. The
    // route's COALESCE means service.address_line1 already falls back to the
    // customer mirror, so a divergence here is a genuinely stamped one.
    const linkage = require('../estimate-property-linkage');
    const primaryStreet = linkage.normalizedStampedStreet(
      customer.address_line1, customer.address_line2, customer.city, customer.zip
    );
    // FAIL CLOSED without a primary street (codex #3367 r6 P0): every
    // downstream frame — ownership scoping, the pricing panel's profile
    // fields, the estimate seed — is anchored to the customer's primary
    // property. With no primary street those frames can't be proven to
    // describe ONE property (a multi-property customer could earn an
    // unearned combined tier or another property's price), so no card.
    if (!primaryStreet) return null;
    // A primary key without locality wildcard-matches every same-street
    // property under sameScopeKey (codex #3367 PR r5) — the same rejection
    // already applied to raw stamps and estimate seeds applies to the
    // anchor itself: unprovable premises, no card.
    if (linkage.scopeKeyLacksLocality(primaryStreet)) return null;
    // The joined row COALESCEs stamped city/zip to the customer mirror, so
    // a stamp carrying ONLY line1 masquerades as the primary locality
    // (codex #3367 PR r4): a multi-property customer with the same street
    // and unit in two cities would price the wrong premises. When the
    // linked scheduled row is available, the RAW stamp is the truth: a
    // stamped line1 with no stamped city or zip is unprovable — no card;
    // a raw-localized stamp compares strictly. Rows without a linked visit
    // keep the joined-row comparison (a divergent line1 there is still a
    // genuinely stamped divergence).
    let linkedVisit = null;
    if (service.scheduled_service_id) {
      linkedVisit = await database('scheduled_services')
        .where({ id: service.scheduled_service_id })
        .first('service_address_line1', 'service_address_line2', 'service_address_city',
          'service_address_zip', 'source', 'is_recurring');
      if (linkedVisit && linkedVisit.service_address_line1) {
        const rawKey = linkage.normalizedStampedStreet(
          linkedVisit.service_address_line1, linkedVisit.service_address_line2,
          linkedVisit.service_address_city, linkedVisit.service_address_zip
        );
        if (!rawKey || linkage.scopeKeyLacksLocality(rawKey)) return null;
        if (!linkage.sameScopeKey(rawKey, primaryStreet)) return null;
        // Both keys carry locality, but possibly in DISJOINT fields
        // (city-only vs zip-only) — sameScopeKey's per-field wildcard
        // accepts that across cities; require one shared proof (PR r6).
        if (!scopeKeysShareLocality(rawKey, primaryStreet)) return null;
      }
      // No raw stamped line1 → the visit ran at the primary property.
    } else {
      const reportStreet = linkage.normalizedStampedStreet(
        service.address_line1, service.address_line2, service.city, service.zip
      );
      if (reportStreet && !linkage.sameScopeKey(reportStreet, primaryStreet)) {
        return null;
      }
    }

    // FAIL CLOSED on ownership: a thrown catalog join means we cannot know
    // what the customer already buys, so no recommendation may render (same
    // doctrine as customer-pricing-ai's PRICING_UNAVAILABLE).
    const { loadOwnedRecurringServiceKeys, ownershipKeysForRow, loadCatalogFieldsByRowId } = require('../waveguard-existing-services');
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
    // Catalog identity is the truth for the report's OWN row too (codex
    // #3367 PR r3): completion copies the scheduled row's TEXT label into
    // service_records.service_type, so a rodent-monitoring visit completed
    // under a stale generic 'Pest Control' label would otherwise classify
    // as owned pest and advance the ladder. Same catalog authority + FAIL
    // CLOSED posture as the ownership loader: an unreadable catalog map
    // suppresses the card rather than classifying on text alone.
    let reportIdentity = { service_type: service.service_type };
    if (service.scheduled_service_id) {
      const catalogById = await loadCatalogFieldsByRowId(database, customerId);
      if (!catalogById) throw new Error('report catalog identity join failed');
      reportIdentity = { ...reportIdentity, ...(catalogById.get(service.scheduled_service_id) || {}) };
    }
    // One-time visits own nothing (codex #3367 PR r6): an estimate-accept
    // or self-booked one-time under a normal recurring catalog identity is
    // not a live plan — the same one-time/lifecycle predicate the ownership
    // loader applies. Without it a lawn customer's one-time pest visit
    // would advance the ladder past pest and offer tree & shrub instead of
    // the missing recurring pest plan.
    const { isOneTimeBookingSource } = require('../self-booking-plan-sync');
    const reportRowIsOneTime = !!linkedVisit
      && (isOneTimeBookingSource(linkedVisit.source) || linkedVisit.is_recurring === false);
    const reportFamilies = reportRowIsOneTime ? [] : ownershipKeysForRow(reportIdentity);
    // The catalog-enriched identity feeds the commercial gate too (codex
    // #3367 PR r5): a 'Commercial Pest Control' catalog row under stale
    // generic text with a blank property_type passed both earlier
    // commercial checks and could price a residential offer on a
    // commercial report. Same predicate the plan-sync exclusions use.
    const { isCommercialServiceRow } = require('../self-booking-plan-sync');
    if (isCommercialServiceRow(reportIdentity)) return null;

    // Plan-rate ledger evidence (codex #3367 PR r1, reworked PR r2): a
    // family carrying a live monthly rate blocks offering that family even
    // when its next visit row isn't seeded (a pest+lawn customer with only
    // the pest row seeded must not be offered lawn). But ledger rows are
    // ADVISORY while GATE_PLAN_RATE_LEDGER is off (sync failures are
    // tolerated) and are never property-scoped, so this evidence may only
    // SUPPRESS or DEMOTE — never ADVANCE the ladder. The ladder walks on
    // property-scoped ownership + report identity alone; if the picked rung
    // itself carries ledger evidence we cannot tell "owned here" from
    // "stale row / billed at another property", and either answer makes the
    // card wrong: no card. Reads via the ledger's own loadComponents (the
    // one authority; absent table = no ledger anywhere = nothing to
    // suppress). A component-read failure hits the outer try — no card;
    // the module's advisory-mode table-probe swallow (its ruled #3245
    // policy) is bounded here because the ownership reads on this same
    // connection succeeded milliseconds earlier.
    const ladderEvidence = [...ownedKeys, ...reportFamilies];
    const targetKey = pickOfferTarget(ladderEvidence);
    // Owns the whole ladder → nothing to offer; the report still shows the
    // referral card, which is client-side and needs no payload.
    if (!targetKey) return null;

    const { loadComponents } = require('../plan-rate-ledger');
    const planRateFamilies = (await loadComponents(database, customerId))
      .filter((row) => Number(row.monthly_rate) > 0)
      .map((row) => String(row.family_key || ''))
      .filter((key) => key && key !== 'unattributed');
    if (offerVocabulary(planRateFamilies).has(targetKey)) return null;

    const evidencedOwnedKeys = [...ladderEvidence, ...planRateFamilies];

    // Best-effort seed — a failed estimate read must not kill the card, it
    // just prices without the seed (and likely degrades to the CTA). The
    // scope street is ALWAYS the primary street: the no-primary case failed
    // closed above, so every frame (ownership, profile, seed) shares one
    // property anchor.
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

    // A price may only render when the PRICED BASELINE modeled every
    // evidenced owned qualifying family (codex #3367 r8 P0 + PR r1): the
    // panel reloads ownership itself (upcoming rows, membership-gated), so
    // a family evidenced only by the report identity or the plan-rate
    // ledger — or dropped by the membership gate in the documented
    // recurring-but-tierless transition — is missing from the modeled
    // baseline, and the engine would price the offer STANDALONE instead of
    // at the combined WaveGuard tier. The ladder still advances past those
    // families; the offer just demotes to the unpriced CTA.
    const QUALIFYING_BASELINE = new Set(['pest_control', 'lawn_care', 'mosquito', 'tree_shrub', 'termite']);
    const modeledBaseline = new Set(result.currentServiceKeys || []);
    const baselineIncomplete = [...offerVocabulary(evidencedOwnedKeys)]
      .filter((key) => QUALIFYING_BASELINE.has(key))
      .some((key) => !modeledBaseline.has(key));

    const option = result.ok ? pickOption(result.options, targetKey) : null;
    const priced = optionIsPriceable(option) && !baselineIncomplete;

    return {
      serviceKey: targetKey,
      label: OFFER_LABELS[targetKey],
      mode: priced ? 'priced' : 'quote_cta',
      // Server-trusted copy stance (codex #3367 PR r2): a customer with no
      // recurring ownership at all (one-time treatment, nothing seeded)
      // has no plan to "add" to — the card, CTA, and stored request
      // subject all say "Start" instead. Derived from PROPERTY-SCOPED
      // evidence only (pre-push r11 P1): a stale or other-property ledger
      // row must not flip the copy any more than the ladder. NOTE: the
      // modeled current-service inventory (result.currentServices)
      // deliberately never rides this payload — it's a public bearer-token
      // surface and the card has no use for it.
      relationship: ladderEvidence.length ? 'add' : 'start',
      // Card-only serialization (codex #3367 r7): this rides a PUBLIC
      // customer payload governed by the per-application rule, so monthly/
      // annual/plan-total figures and the panel's "$X/mo" request prose
      // never leave the server — per-application is the only price field.
      option: priced ? {
        id: option.id,
        label: option.label,
        cadence: option.cadence || '',
        perVisit: option.perVisit || null,
        waveguardTier: option.waveguardTier || null,
        confidence: option.confidence || null,
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
