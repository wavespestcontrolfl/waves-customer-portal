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
// scopeKeysShareLocality moved to estimate-property-linkage (PR r7) — one
// authority for the property-equality proof, shared with filterRowsToStreet.
const { scopeKeysShareLocality } = require('../estimate-property-linkage');

// True only when NOTHING on file contradicts "this customer has a single
// premises, the primary one" (codex #3367 PR r11 P1). Used by the unlinked-
// report branch, where the report's address is the customer mirror and so
// carries no evidence of its own. Deliberately a PROOF of single-premises,
// not a search for a second one: an unreadable witness throws and the outer
// catch suppresses the card, which is the same fail-closed posture the
// linked branches take.
async function customerHasOnlyPrimaryPremises(database, customerId, customer, primaryStreet) {
  // The eligibility flag the discount engine already trusts for multi-home
  // status — admins hand-set it for customers whose second property never
  // made it into customer_properties.
  if (customer?.has_multi_home === true) return false;
  const linkage = require('../estimate-property-linkage');
  const provablyPrimary = (key) => {
    if (!key) return false;
    if (!linkage.sameScopeKey(key, primaryStreet)) return false;
    // Same street, but disjoint locality evidence (city-only vs zip-only)
    // matches across cities under sameScopeKey's per-field wildcard — the
    // r6/r7 rule. A key with NO locality at all is the legacy partial stamp,
    // and it is UNPROVEN, not benign (codex #3367 PR r12): a secondary
    // property with the same street and unit in another city produces
    // exactly that key, so accepting it would declare the wrong premises
    // primary and publish an exact price from the wrong profile — the hole
    // the linked-report and estimate-seed guards already close by rejecting
    // scopeKeyLacksLocality outright. Same rejection here.
    if (linkage.scopeKeyLacksLocality(key)) return false;
    return scopeKeysShareLocality(key, primaryStreet);
  };
  const properties = await database('customer_properties')
    .where({ customer_id: customerId, active: true })
    .select('address_line1', 'address_line2', 'city', 'zip');
  if (properties.length >= 2) return false;
  for (const row of properties) {
    if (!provablyPrimary(linkage.normalizedStampedStreet(row.address_line1, row.address_line2, row.city, row.zip))) {
      return false;
    }
  }
  // customer_properties is gated (GATE_CUSTOMER_PROPERTIES) and empty for
  // accounts that predate it, so the STAMPED visit addresses are the second
  // witness: dispatch stamps the premises it routed to, and a stamp that
  // cannot be proven to be the primary is a second premises on this account.
  const cols = await database('scheduled_services').columnInfo();
  if (!cols.service_address_line1) return true;
  const stampCols = ['service_address_line1'];
  for (const col of ['service_address_line2', 'service_address_city', 'service_address_zip']) {
    if (cols[col]) stampCols.push(col);
  }
  // property_id / source_estimate_id ride along so an UNSTAMPED row can be
  // resolved rather than waved through (codex #3367 PR r13): dispatch's own
  // order is stamp → property row → creating estimate → primary, and only
  // the property_id leg is covered by the customer_properties witness above.
  // A row that links to a secondary address through its creating ESTIMATE
  // would otherwise certify a multi-property account as single-premises.
  if (cols.property_id) stampCols.push('property_id');
  if (cols.source_estimate_id) stampCols.push('source_estimate_id');
  const rows = await database('scheduled_services')
    .where({ customer_id: customerId })
    .distinct(stampCols);
  for (const row of rows) {
    if (String(row.service_address_line1 || '').trim()) {
      if (!provablyPrimary(linkage.normalizedStampedStreet(
        row.service_address_line1, row.service_address_line2, row.service_address_city, row.service_address_zip
      ))) return false;
      continue;
    }
    // Unstamped: resolve the same way the linked-report branch does.
    if (row.property_id) {
      const prop = await database('customer_properties')
        .where({ id: row.property_id })
        .first('address_line1', 'address_line2', 'city', 'zip');
      // An unresolvable property link names no premises — the row is not
      // evidence of a second one (the linked-report branch suppresses on
      // it because THAT report is the one being priced; here the row is
      // just another visit on the account).
      if (!prop) continue;
      if (!provablyPrimary(linkage.normalizedStampedStreet(
        prop.address_line1, prop.address_line2, prop.city, prop.zip
      ))) return false;
      continue;
    }
    if (row.source_estimate_id) {
      const src = await database('estimates')
        .where({ id: row.source_estimate_id })
        .first('address');
      if (!src?.address) continue;
      if (!provablyPrimary(linkage.normalizedEstimateStreet(src.address))) return false;
      continue;
    }
    // Neither stamped nor linked → the absence of evidence, not evidence of
    // a second premises.
  }
  return true;
}

// Stable digest of every field the card RENDERS. Key order is fixed by
// construction, so the same visible offer always hashes identically.
function offerFingerprint(payload = {}) {
  const o = payload.option || {};
  const canonical = [
    payload.serviceKey || '', payload.label || '', payload.mode || '',
    payload.relationship || '',
    o.id || '', o.label || '', o.cadence || '',
    o.perVisit == null ? '' : Number(o.perVisit).toFixed(2),
    o.waveguardTier || '', o.confidence || '',
  ].join('|');
  return require('crypto').createHash('sha256').update(canonical).digest('hex').slice(0, 32);
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

// Did the estimate this seed came from carry its own review markers (codex
// #3367 PR r13)? engineInputs is not the whole evidence: an estimate whose
// estimator flagged fields for on-site verification (fieldVerify — weak or
// conflicting property sources, turf flags), or that priced at low
// confidence, was sent as a number a human agreed to CHECK. Replaying its
// dimensions into a DIFFERENT service's price would launder that into an
// unqualified exact per-application figure, since the new price is graded
// on its own inputs and knows nothing about the original's caveat.
// Shape-tolerant on purpose: the stored blob has carried v1 and v2 result
// shapes, and a missed marker would read as "clean" — anything that looks
// like a verification flag demotes the offer to the quote CTA.
function estimateRequiresFieldVerification(estData) {
  if (!estData || typeof estData !== 'object') return false;
  const containers = [estData, estData.result, estData.estimate, estData.engineResult, estData.estimatorEngine];
  return containers.some((c) => {
    if (!c || typeof c !== 'object') return false;
    if (Array.isArray(c.fieldVerify) && c.fieldVerify.length) return true;
    if (Array.isArray(c.fieldVerifyFlags) && c.fieldVerifyFlags.length) return true;
    if (c.requiresManualReview === true || c.customQuoteFlag === true) return true;
    return String(c.pricingConfidence || '').toLowerCase() === 'low';
  });
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
    candidates.push({ row, inputs, estData });
  }
  // Rows arrive newest-first, so the first surviving candidate is the most
  // recently accepted same-property estimate.
  const pick = candidates[0];
  if (!pick) return null;
  const inputs = pick.inputs;
  const cleanString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
  const cleanedFeatures = inputs.features && typeof inputs.features === 'object' && !Array.isArray(inputs.features)
    ? { ...inputs.features }
    : null;
  let zeroTreeCountAmbiguous = false;
  if (cleanedFeatures
    && Object.prototype.hasOwnProperty.call(cleanedFeatures, 'treeCount')
    && !(Number(cleanedFeatures.treeCount) > 0)) {
    delete cleanedFeatures.treeCount;
    zeroTreeCountAmbiguous = true;
  }
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
    features: cleanedFeatures,
    // A stored zero tree count has NO provenance (codex #3367 PR r9+r10):
    // the v1 adapter serializes both an operator-confirmed zero and its
    // own synthetic unobserved zero into the same field. Neither replaying
    // it (prices zero trees when synthetic) nor dropping it (prices
    // phantom trees when authoritative) is safe, so the seed carries the
    // ambiguity and a tree & shrub offer demotes to the quote CTA.
    zeroTreeCountAmbiguous,
    // The source estimate's own review posture rides along (codex #3367 PR
    // r13): a dimension that its estimator flagged for on-site verification
    // must not be replayed into an exact price for a different service,
    // which would be graded high-confidence on inputs that were never
    // qualified. Demotes to the quote CTA; the offer itself still renders.
    requiresFieldVerification: estimateRequiresFieldVerification(pick.estData),
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
          'service_address_zip', 'source', 'is_recurring', 'source_estimate_id', 'property_id');
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
      } else if (linkedVisit && (linkedVisit.property_id || linkedVisit.source_estimate_id)) {
        // Unstamped but LINKED (codex #3367 PR r7): dispatch's own rule
        // resolves an unstamped row through its property row / creating
        // estimate before falling back to primary — assuming primary here
        // would publish a primary-profile price for a secondary-property
        // visit. Same proofs as a raw stamp; unresolvable = no card.
        let resolvedKey = null;
        if (linkedVisit.property_id) {
          const prop = await database('customer_properties')
            .where({ id: linkedVisit.property_id })
            .first('address_line1', 'address_line2', 'city', 'zip');
          resolvedKey = prop
            ? linkage.normalizedStampedStreet(prop.address_line1, prop.address_line2, prop.city, prop.zip)
            : null;
        } else {
          const src = await database('estimates')
            .where({ id: linkedVisit.source_estimate_id })
            .first('address');
          resolvedKey = linkage.normalizedEstimateStreet(src?.address);
        }
        if (!resolvedKey || linkage.scopeKeyLacksLocality(resolvedKey)) return null;
        if (!linkage.sameScopeKey(resolvedKey, primaryStreet)) return null;
        if (!scopeKeysShareLocality(resolvedKey, primaryStreet)) return null;
      }
      // No raw stamp and no linkage → the visit ran at the primary property.
    } else {
      const reportStreet = linkage.normalizedStampedStreet(
        service.address_line1, service.address_line2, service.city, service.zip
      );
      if (reportStreet && !linkage.sameScopeKey(reportStreet, primaryStreet)) {
        return null;
      }
      // An UNLINKED report cannot be resolved to a property at all (codex
      // #3367 PR r11 P1). service_records.scheduled_service_id is explicitly
      // nullable for historical rows whose visit could not be matched
      // unambiguously (20260427000007_service_records_scheduled_service_id),
      // and the route COALESCEs address_* from the CUSTOMER mirror whenever
      // no scheduled row joins — so the divergence check above reads the
      // primary address against itself and can only ever prove EQUAL. For a
      // single-premises account that is harmless: there is one property to
      // price. For a multi-property account it silently prices an old
      // SECONDARY-property report from the primary profile and persists that
      // price on the click, so the card must prove single-premises or
      // suppress. Unprovable = no card, the same posture the linked branches
      // above take (a throw here rides the outer catch to the same place).
      if (!(await customerHasOnlyPrimaryPremises(database, customerId, customer, primaryStreet))) {
        return null;
      }
    }

    // FAIL CLOSED on ownership: a thrown catalog join means we cannot know
    // what the customer already buys, so no recommendation may render (same
    // doctrine as customer-pricing-ai's PRICING_UNAVAILABLE).
    const { loadOwnedRecurringServiceKeys, ownershipKeysForRow, loadCatalogFieldsByRowId } = require('../waveguard-existing-services');
    // requireSharedLocality (codex #3367 PR r7): a same-street recurring
    // row whose locality cannot be proven shared may be another property's
    // obligation — filterRowsToStreet THROWS for opted-in consumers, and
    // the outer try turns that into no card. The pricer's internal reload
    // stays default-scoped: if a row is unprovable this frame died here
    // first, so the reload never prices an unearned combined tier for a
    // card that renders.
    const streetScope = primaryStreet
      ? { estimateStreet: primaryStreet, customerPrimaryStreet: primaryStreet, requireSharedLocality: true }
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
    // service.is_callback covers reports with NO linked row (older
    // service_records — codex #3367 PR r7): a "Pest Control Re-Service"
    // callback is not a live plan any more than a one-time visit is.
    const reportRowIsOneTime = !!service.is_callback
      || (!!linkedVisit
        && (isOneTimeBookingSource(linkedVisit.source) || linkedVisit.is_recurring === false));
    // Ledger components load BEFORE the report-identity gate (PR r9 uses
    // them as corroboration) — their suppress/demote roles below are
    // unchanged.
    const { loadComponents } = require('../plan-rate-ledger');
    const planRateFamilies = (await loadComponents(database, customerId))
      .filter((row) => Number(row.monthly_rate) > 0)
      .map((row) => String(row.family_key || ''))
      .filter((key) => key && key !== 'unattributed');

    let reportFamilies = reportRowIsOneTime ? [] : ownershipKeysForRow(reportIdentity);
    // A report identity is not ownership by itself (codex #3367 PR r9+r10).
    // Corroboration ladder:
    //   - family in the street-scoped upcoming rows → redundant, fine;
    //   - family in the plan-rate ledger while GATE_PLAN_RATE_LEDGER is ON
    //     → authoritative billing evidence, counts (advisory rows may
    //     never advance the ladder — their suppress/demote roles below
    //     are unchanged);
    //   - otherwise, a RECENT report (within 90 days, one recurrence
    //     window) is ambiguous — the unseeded-next-visit gap and a
    //     just-cancelled plan are indistinguishable, and offering the
    //     family vs advancing past it are each wrong in one of those
    //     worlds → NO CARD (same both-answers-wrong doctrine as the
    //     locality proofs);
    //   - an OLD report is a historical record, not ownership → the
    //     family drops and the ladder may offer it again (relationship
    //     'start' unless other evidence exists).
    if (reportFamilies.length) {
      const { planRateLedgerEnabled } = require('../plan-rate-ledger');
      const ownedVocab = offerVocabulary(ownedKeys);
      const billedVocab = planRateLedgerEnabled() ? offerVocabulary(planRateFamilies) : new Set();
      // EVERY report-identity family needs corroboration (codex #3367 PR
      // r13). A non-ladder identity (mosquito, rodent monitoring) selects
      // no rung, so it was previously exempted — but it still lands in
      // reportFamilies, and ladderEvidence being non-empty is what decides
      // 'add' vs 'start'. An old mosquito report on a customer with nothing
      // active therefore made the card, the stored request subject, and the
      // staff bell all say "Add … to your plan" to a former customer who
      // has no plan. Corroboration is required either way; only the
      // CONSEQUENCE differs, below.
      const familyUncorroborated = (fam, keys) => !keys.some(
        (key) => ownedVocab.has(key) || billedVocab.has(key)
      );
      const ladderKeysFor = (fam) => [...offerVocabulary([fam])].filter((key) => OFFER_LADDER.includes(key));
      const uncorroborated = reportFamilies.filter((fam) => {
        const ladderVocab = ladderKeysFor(fam);
        return familyUncorroborated(fam, ladderVocab.length ? ladderVocab : [...offerVocabulary([fam])]);
      });
      // Only a LADDER family carries the both-answers-wrong ambiguity that
      // suppresses the whole card on a recent report: it would either be
      // offered to someone who owns it or advanced past for someone who
      // doesn't. A non-ladder family moves no rung, so it simply drops.
      const uncorroboratedLadder = uncorroborated.filter((fam) => ladderKeysFor(fam).length > 0);
      if (uncorroboratedLadder.length) {
        // ET calendar discipline (pre-push P1): service_date is a DATE —
        // compare ET calendar days, never UTC-midnight milliseconds, or
        // the suppress/offer boundary moves hours early around DST.
        // service_date is a DATE (hydrates as 'YYYY-MM-DD' or UTC-midnight
        // Date) → etCalendarDayOf reads it literally; created_at is a real
        // timestamp → etDateString converts through the ET wall clock.
        // Using the wrong one shifts the boundary a full day (pre-push P1).
        const { etDateString, etCalendarDayOf } = require('../../utils/datetime-et');
        const dayKey = service.service_date
          ? etCalendarDayOf(service.service_date)
          : (service.created_at ? etDateString(new Date(service.created_at)) : '');
        const toUtcNoonMs = (key) => {
          const [y, m, d] = key.split('-').map(Number);
          return Date.UTC(y, m - 1, d, 12);
        };
        const reportRecent = /^\d{4}-\d{2}-\d{2}$/.test(dayKey)
          && (toUtcNoonMs(etDateString()) - toUtcNoonMs(dayKey)) <= 90 * 24 * 3600 * 1000;
        if (reportRecent) return null;
      }
      // Drop EVERY uncorroborated family, ladder or not: an old identity is
      // a historical record, never current ownership, and leaving one in
      // reportFamilies is what put "add to your plan" copy on a card for a
      // customer with no plan.
      if (uncorroborated.length) {
        reportFamilies = reportFamilies.filter((fam) => !uncorroborated.includes(fam));
      }
    }
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

    // On a cache MISS the price falls back to the accepted-estimate seed —
    // but a technician's verified correction (square footage, hasPool)
    // supersedes that estimate too, since the seed is older still. Pricing
    // through it would publish an exact per-application price on a fact
    // staff already fixed, so any correction on file demotes the offer to
    // the unpriced CTA (codex #3367 PR r12, tightened by the pre-push P0 on
    // its first form). Self-healing: a live lookup folds the correction in
    // and re-saves, cache hits resume, and there is no miss left to demote.
    // Probed only on a miss, and FAIL CLOSED — an unreadable probe is not
    // evidence that no corrections exist.
    let correctionsUnapplied = false;
    const trackedPropertyLookup = async (address) => {
      const found = await propertyLookup(address);
      if (!found) {
        try {
          const { hasVerifiedOverrides } = require('../property-lookup/lookup-cache');
          if (await hasVerifiedOverrides(address)) correctionsUnapplied = true;
        } catch (err) {
          correctionsUnapplied = true;
          logger.warn(`[report-cross-sell] verified-override probe failed, demoting to CTA (${err.message})`);
        }
      }
      return found;
    };

    const { buildCustomerPricingResponse } = require('../customer-pricing-ai');
    const result = await buildCustomerPricingResponse({
      customer,
      prompt: OFFER_PROMPTS[targetKey],
      db: database,
      propertyLookup: trackedPropertyLookup,
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
    // A tree & shrub offer built on a seed whose zero tree count was
    // provenance-ambiguous never prices (codex #3367 PR r10) — the count
    // may have been an operator-confirmed zero the fallback would
    // contradict, or a synthetic zero the replay would price at nothing.
    const ambiguousTreeEvidence = targetKey === 'tree_shrub' && !!propertySeed?.zeroTreeCountAmbiguous;
    // A seed whose own estimate required field verification never prices
    // (codex #3367 PR r13). Conservative by design: the flag demotes even
    // when the seed only partly filled the profile, because the estimate's
    // caveat attached to the property evidence as a whole and the fill is
    // per-field — proving the flagged dimension did not reach this price
    // would need provenance the stored blob does not carry.
    const seedRequiresVerification = !!propertySeed?.requiresFieldVerification;
    const priced = optionIsPriceable(option) && !baselineIncomplete && !ambiguousTreeEvidence
      && !correctionsUnapplied && !seedRequiresVerification;

    const payload = {
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
    // Server-issued fingerprint over EVERY customer-visible field (pre-push
    // P1): the click path compares this one value instead of enumerating
    // fields, so a change to relationship, label, cadence, or tier under a
    // stable option id + price can no longer persist a snapshot the
    // customer never saw. Recomputed identically on the click path; any
    // drift 409s and the card prompts a refresh.
    return { ...payload, fingerprint: offerFingerprint(payload) };
  } catch (err) {
    logger.warn(`[report-cross-sell] suppressed (${err.message})`);
    return null;
  }
}

module.exports = {
  buildReportCrossSell,
  // Test hooks: ladder + priceability are the card's two decisions.
  _private: { pickOfferTarget, pickOption, optionIsPriceable, offerFingerprint, OFFER_LADDER },
};
