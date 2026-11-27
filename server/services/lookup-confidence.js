/**
 * Trust predicates for property-lookup-derived pricing inputs.
 *
 * The lookup returns measurements and feature reads off satellite imagery
 * plus county records, and it grades its own work: `aiConfidence` (the same
 * score property-lookup-v2's reviewer copy renders as "AI confidence NN%")
 * and `fieldVerifyFlags` naming the specific reads that need human
 * verification.
 *
 * Pricers do NOT carry that grade. priceTreeShrub, for instance, upgrades
 * any `estimatedBedAreaSf` to pricingConfidence 'medium' with no review
 * reason, and the pest feature modifiers price a pool cage the moment one is
 * reported. So a read the lookup itself doubted becomes an exact,
 * unreviewed price unless the consumer checks the grade first — which is
 * what these predicates are for.
 *
 * Shared so the rule has ONE definition: the agent draft path and the
 * customer-facing pricing assistant must not drift apart on what "confident
 * enough to price" means.
 */

const { normalizeConstruction, normalizeFoundation } = require('./pricing-engine/structural-facts');

// Below this the lookup's own copy calls the read low-confidence.
const LOOKUP_AI_CONFIDENCE_FLOOR = 60;

function confidenceScore(enriched) {
  const n = Number(enriched?.aiConfidence ?? enriched?.confidenceScore);
  return Number.isFinite(n) ? n : null;
}

// For inputs ALREADY in use, an absent score is not evidence of doubt —
// legacy payloads carried none, and treating them as untrustworthy would
// silently stop pricing inputs that have always been used.
//
// For a NEWLY consumed input the burden flips: nothing depended on it
// before, so requiring a real score costs nothing and refuses to invent
// trust the lookup never expressed. Callers introducing a consumption pass
// requireExplicitScore.
function lookupConfidenceIsAdequate(enriched, { requireExplicitScore = false } = {}) {
  const score = confidenceScore(enriched);
  if (score === null) return !requireExplicitScore;
  return score >= LOOKUP_AI_CONFIDENCE_FLOOR;
}

// Flags whose scope is the WHOLE lookup, not one field: 'address' (the
// geocoder snapped to a different premise — every read may describe the
// wrong parcel) and 'all' (no property record; every dimension is
// estimated). These disqualify every derived pricing input, so a
// field-name match is not enough on its own.
const GLOBAL_VERIFY_FIELDS = new Set(['address', 'all']);

function hasGlobalVerifyFlag(enriched) {
  const flags = Array.isArray(enriched?.fieldVerifyFlags) ? enriched.fieldVerifyFlags : [];
  return flags.some((flag) => GLOBAL_VERIFY_FIELDS.has(String(flag?.field || '').trim().toLowerCase()));
}

function hasVerifyFlagMatching(enriched, matcher) {
  if (hasGlobalVerifyFlag(enriched)) return true;
  const flags = Array.isArray(enriched?.fieldVerifyFlags) ? enriched.fieldVerifyFlags : [];
  return flags.some((flag) => matcher(String(flag?.field || '').toLowerCase()));
}

// The FLAG half of lookupBedAreaIsTrustworthy, value-agnostic: did the
// lookup flag the bed-area read (or the turf/imagery read it comes from —
// same picture)? A consumer that must tell "the lookup REFUSED this read"
// from "the lookup carried no value" needs this one, since the predicate
// below folds both into a single false and treating a missing value as a
// refusal would block evidence the caller is entitled to use.
function lookupBedAreaReadIsFlagged(enriched) {
  return hasVerifyFlagMatching(enriched, (field) => (
    field.includes('bedarea') || field.includes('bed_area') || field.includes('estimatedturf')
  ));
}

// A bed area is trustworthy when the lookup neither graded itself low nor
// flagged the bed-area read — or the turf/imagery read it came from, since
// that is the same picture.
// Bed area is a NEW consumption (nothing priced off it before this lane), so
// it fails closed on a missing score: an unscored area would otherwise
// become a medium-confidence T&S price with no review reason. A quote
// without it simply falls back to the lot inference, which carries its own
// review markers.
function lookupBedAreaIsTrustworthy(enriched) {
  const area = Number(enriched?.estimatedBedAreaSf);
  if (!Number.isFinite(area) || area <= 0) return false;
  // FIELD-level confidence, not the blended average: the merge gap-fills
  // estimatedBedAreaSf from a lone low-confidence provider while other
  // providers' high scores hold the average above the floor, and bed area
  // is not divergence-tracked so no flag fires. mergeAiAnalyses stamps the
  // max confidence among the providers that reported the WINNING value
  // (surfaced as bedAreaConfidence). A missing stamp — legacy cached
  // payloads merged before the stamp existed — fails closed like a missing
  // score: bed area is a NEW consumption, and the quote falls back to the
  // lot inference, which carries its own review markers.
  const fieldConfidence = Number(enriched?.bedAreaConfidence ?? enriched?._bedAreaConfidence);
  if (!Number.isFinite(fieldConfidence) || fieldConfidence < LOOKUP_AI_CONFIDENCE_FLOOR) return false;
  if (!lookupConfidenceIsAdequate(enriched, { requireExplicitScore: true })) return false;
  return !lookupBedAreaReadIsFlagged(enriched);
}

// Trust of the turf READ itself, value-agnostic: adequate confidence and no
// turf/lawn verify flag. (Existing consumption, so an absent score stays
// adequate — legacy payloads carried none.)
function lookupTurfReadIsTrustworthy(enriched) {
  if (!enriched) return false;
  if (!lookupConfidenceIsAdequate(enriched)) return false;
  return !hasVerifyFlagMatching(enriched, (field) => (
    field.includes('turf') || field.includes('lawn')
  ));
}

// The satellite turf estimate is a vision read like the bed area — same
// imagery, same self-grading. A low-confidence or turf-flagged read may not
// satisfy the lawn measurement and become an exact self-service price; the
// caller adopts nothing and the request fails closed to
// PROPERTY_DETAILS_NEEDED when no other turf source exists.
function lookupTurfEstimateIsTrustworthy(enriched) {
  const turf = Number(enriched?.estimatedTurfSf);
  if (!Number.isFinite(turf) || turf <= 0) return false;
  return lookupTurfReadIsTrustworthy(enriched);
}

// A trusted vision ZERO is a measurement too — an observed no-lawn
// property. The lookup distinguishes it explicitly: turfSource 'vision'
// covers a measured 0, while its synthetic no-basis zero ships as
// turfSource 'none' (and the stale-imagery guard deletes bogus zeros
// before they get here). Without this, a no-lawn property with a lot on
// file would fall through to the lot-based turf inference and receive a
// lawn quote for a lawn the imagery shows does not exist.
function lookupTurfZeroIsObserved(enriched) {
  if (Number(enriched?.estimatedTurfSf) !== 0) return false;
  if (String(enriched?.turfSource || '').trim().toLowerCase() !== 'vision') return false;
  return lookupTurfReadIsTrustworthy(enriched);
}

// The FLAG half of lookupFeaturesAreTrustworthy, independent of grade: did
// the lookup explicitly flag a vision feature read? A consumer must be able
// to tell that REFUSAL from a merely low-graded read — a low grade means
// "this imagery is weak, fall back to other evidence" (a ruled behavior:
// the record-backed pool still prices and the accepted-estimate seed still
// fills the rest), while a flag means "verify this before pricing".
function lookupFeatureReadIsFlagged(enriched) {
  return hasVerifyFlagMatching(enriched, (field) => (
    field.includes('estimatedturf') || field.includes('pool') || field.includes('shrub')
    || field.includes('tree') || field.includes('landscape')
  ));
}

// GATE_PEST_PRICE_PHOTO_FACTS (owner 2026-11-21, reply "1, 2"): is the lawn
// AREA the only thing a flagged feature read doubts? Then the photo itself is
// not in question, and a pest price may keep the three photo facts it reads
// (shrubs, complexity, near water) instead of the neutral defaults. An audit
// of 106 estimates found the lawn-area flag on about half of homes, and the
// owner's final value agreed with the photo on 87% of those three facts with
// or without the flag.
//
// A NEW consumption, so it fails closed, and it reads machine fields only,
// never a flag's prose. Refused:
//   - no grade or a low grade (unscored or weak photo);
//   - turfObservation 'unobservable': the photo conflicts with county records
//     (an old photo of bare land), so every read off it is of the wrong scene;
//   - turfSource other than 'vision': the photo gave no lawn number of its
//     own (a county prior, or no basis), so nothing shows it read the yard;
//   - ANY flag outside the allow-list below. The list is closed on purpose:
//     a flag this rule has never sorted refuses. That covers a wrong premise
//     ('address', 'all'), a lot shared by a whole development ('lotSize',
//     scope 'unit_parcel': the photo shows the development's landscaping, not
//     this home's), a doubted home size or property type, and a flag on any
//     vision read (pool, shrubs, trees, palms, bed area, the analysis itself).
// Every flag the lookup raises on estimatedTurfSf is one of the cases above or
// a doubt about the lawn number alone; a new kind of estimatedTurfSf flag must
// be sorted here (pest-price-photo-facts.test.js counts them).
// One fact can still be in doubt by itself: see lookupDisputedPhotoFields.
//
// The allow-list, by exact field name:
//   estimatedTurfSf       the lawn-area doubt itself;
//   constructionMaterial  unknown or wood-frame structure: a termite note
//                         from the records;
//   foundationType        unknown, raised or flood-zone foundation: a termite
//                         note from the records;
//   vegetation            plants touch the structure: a note for the
//                         technician. The photo saw it; it doubts nothing.
// The three notes say nothing against the photo or the premises it shows, and
// a lookup with no lawn-area flag prices on the photo facts with them today.
const LAWN_AREA_DOUBT_ALLOWED_FLAG_FIELDS = new Set([
  'estimatedturfsf', 'constructionmaterial', 'foundationtype', 'vegetation',
]);
function lookupLawnAreaIsTheOnlyFeatureDoubt(enriched) {
  if (!enriched) return false;
  if (!lookupConfidenceIsAdequate(enriched, { requireExplicitScore: true })) return false;
  if (String(enriched.turfObservation || '').trim().toLowerCase() === 'unobservable') return false;
  if (String(enriched.turfSource || '').trim().toLowerCase() !== 'vision') return false;
  const fields = (Array.isArray(enriched.fieldVerifyFlags) ? enriched.fieldVerifyFlags : [])
    .map((flag) => String(flag?.field || '').trim().toLowerCase());
  if (!fields.every((field) => LAWN_AREA_DOUBT_ALLOWED_FLAG_FIELDS.has(field))) return false;
  return fields.includes('estimatedturfsf');
}

// The fields the vision providers DISAGREED on. mergeAiAnalyses
// (routes/property-lookup-v2.js) records each as an aiDivergences entry on the
// lookup's aiAnalysis, beside the enriched profile; they raise no verify flag,
// so no predicate above sees them. A disputed value is one provider's word
// against another's on the same photo.
function lookupDisputedPhotoFields(aiAnalysis) {
  const list = Array.isArray(aiAnalysis?.aiDivergences) ? aiAnalysis.aiDivergences : [];
  return new Set(list.map((entry) => String(entry?.field || '')).filter(Boolean));
}

// Vision-derived FEATURE modifiers (pool, cage, shrub/tree density,
// landscape complexity, tree count, water adjacency) all come off the same
// imagery read. When the lookup grades that read low, none of them should
// move a price — the caller keeps its own defaults instead.
function lookupFeaturesAreTrustworthy(enriched) {
  if (!enriched) return false;
  if (!lookupConfidenceIsAdequate(enriched)) return false;
  return !lookupFeatureReadIsFlagged(enriched);
}

// Weak or conflicting core dimensions ship with their own fieldVerifyFlags
// entries — the flag builder marks squareFootage / lotSize / stories as
// HIGH-priority "verify before pricing". The customer-facing pricing path
// has no review lane, so a flagged dimension may not price a quote: the
// caller leaves it unset and a missing required measurement fails closed to
// PROPERTY_DETAILS_NEEDED rather than pricing on a number the lookup itself
// said to verify first.
const DIMENSION_FLAG_MATCHERS = {
  homeSqFt: ['squarefootage', 'square_footage', 'homesqft', 'home_sqft'],
  lotSqFt: ['lotsize', 'lot_size', 'lotsqft', 'lot_sqft'],
  stories: ['stories'],
};

function lookupDimensionIsTrustworthy(enriched, dimension) {
  const names = DIMENSION_FLAG_MATCHERS[dimension] || [String(dimension || '').toLowerCase()];
  return !hasVerifyFlagMatching(enriched, (field) => names.some((name) => field.includes(name)));
}

// A HIGH-priority verify flag on a core dimension (home size, lot size,
// stories) or on the whole lookup ('address', 'all'): the lookup's own
// "verify before pricing" grade. The priority is part of the test here, where
// lookupDimensionIsTrustworthy above takes a flag of any priority: this one
// reads a profile that was stored with a quote the office then priced, and
// the MEDIUM form of 'all' marks a record for the right address.
function hasHighPriorityDimensionFlag(enriched) {
  const flags = Array.isArray(enriched?.fieldVerifyFlags) ? enriched.fieldVerifyFlags : [];
  const names = Object.values(DIMENSION_FLAG_MATCHERS).flat();
  return flags.some((flag) => {
    if (String(flag?.priority || '').trim().toUpperCase() !== 'HIGH') return false;
    const field = String(flag?.field || '').trim().toLowerCase();
    return GLOBAL_VERIFY_FIELDS.has(field) || names.some((name) => field.includes(name));
  });
}

// applyVisionPropertyTypeEvidence MUTATES the property record itself
// (rc.propertyType = <satellite type>, rc._propertyTypeSource = 'satellite',
// fieldVerify kept on rc._fieldEvidence.propertyType) — it only ever fires
// on a weak-typed record. So when the enriched type is rejected for its
// verify flag, a bare record fallback would hand the SAME rejected
// classification straight back.
//
// But a fieldVerify bit alone does NOT make the winner weak:
// mergePropertyRecords sets it on mere source DISAGREEMENT even when
// authoritative county/cadastral/listing/verified data won the field (the
// route's own recordPropertyTypeIsWeak contract). Rejecting every flagged
// record type dropped the authoritative townhome/condo winner and repriced
// it as single_family. Distrust only a satellite-sourced type or a weak
// WINNING source; a no-evidence record (legacy cache) keeps its plain
// record semantics — the caller's 'UNKNOWN' guard still applies.
function recordPropertyTypeIsTrustworthy(record) {
  if (!record || !record.propertyType) return false;
  if (String(record._propertyTypeSource || '').trim().toLowerCase() === 'satellite') return false;
  const ev = record._fieldEvidence?.propertyType;
  if (!ev) return true;
  const sourceType = String(ev.sourceType || '').trim().toLowerCase();
  if (sourceType === 'satellite') return false;
  return !(sourceType === '' || sourceType === 'unknown' || sourceType === 'generic');
}

// Palm counts drive REAL money twice over — the v4.7 T&S palm reserve when
// armed, and palm_injection per-palm pricing when the operator submits the
// estimator's palm field — and the vision read has the same gap-fill
// exposure as the tree count. The estimator pages PREFILL their palm-count
// field from this estimate (owner ruling 2026-08-10: AI counts the palms,
// the operator modifies if need be — the lawn treatable-area pattern), so
// the verdict is stamped server-side onto the enriched profile
// (palmCountTrusted) and a distrusted count leaves the field EMPTY for the
// operator to count instead of prefill garbage.
function lookupPalmCountIsTrustworthy(enriched) {
  const count = Number(enriched?.estimatedPalmCount);
  if (!Number.isFinite(count) || count <= 0) return false;
  const fieldConfidence = Number(enriched?.palmCountConfidence ?? enriched?._palmCountConfidence);
  if (!Number.isFinite(fieldConfidence) || fieldConfidence < LOOKUP_AI_CONFIDENCE_FLOOR) return false;
  // Wrong-premise vetoes (imagery of the NEIGHBOR'S palms), but the
  // no-record 'all' flag deliberately does not: palm counts are pure vision
  // — county records don't count palms, so record absence says nothing
  // about the read, and this verdict only gates an operator-editable
  // prefill (autonomous paths never price an AI palm count at all).
  if (hasWrongPremiseFlag(enriched)) return false;
  const flags = Array.isArray(enriched?.fieldVerifyFlags) ? enriched.fieldVerifyFlags : [];
  return !flags.some((flag) => String(flag?.field || '').toLowerCase().includes('palm'));
}

// Same field-level rule as the bed area below: estimatedTreeCount is
// gap-filled outside divergence tracking, so the blended average can
// launder a lone low-confidence count straight into per-tree labor minutes
// AND the per-tree material term. mergeAiAnalyses stamps the winning
// count's provider confidence (zeroed on material divergence), surfaced as
// treeCountConfidence. Missing stamp = legacy payload = fail closed — the
// pricer's density fallback runs and carries its own review warning.
function lookupTreeCountIsTrustworthy(enriched) {
  const count = Number(enriched?.estimatedTreeCount);
  if (!Number.isFinite(count) || count <= 0) return false;
  const fieldConfidence = Number(enriched?.treeCountConfidence ?? enriched?._treeCountConfidence);
  if (!Number.isFinite(fieldConfidence) || fieldConfidence < LOOKUP_AI_CONFIDENCE_FLOOR) return false;
  return !hasVerifyFlagMatching(enriched, (field) => (
    field.includes('treecount') || field.includes('tree_count')
  ));
}

// Structural facts (constructionMaterial / foundationType / roofType /
// yearBuilt) are merged into the RECORD from listings and AI when county
// data is absent — `_fieldEvidence.<field>.fieldVerify` marks those
// weak/conflicting merges, and that evidence bit is the ONLY reliable
// distrust signal for them. The fieldVerifyFlags STREAM must not be used
// here: the flag builder also emits same-named OPERATIONAL RISK notices for
// authoritative values (wood frame = "higher termite risk", crawlspace =
// "treatment approach differs") — treating those as distrust would drop
// county-confirmed facts and underquote exactly the risky homes their
// pricing modifiers exist for. A record without evidence metadata (legacy
// cache) keeps its pre-existing trusted-record semantics.
function structuralFactIsTrustworthy({ record, field }) {
  return !record?._fieldEvidence?.[field]?.fieldVerify;
}

// The verdict the WDO price reads (owner 2026-11-26: unknown or untrusted construction prices as block plus a staff note): is this
// structural fact on the merged profile backed by the property RECORD with no weak/conflicting-merge evidence? A value that came
// only from the satellite photo, or one the record's own evidence marks fieldVerify, is not trusted. The lookup stamps this verdict
// on the enriched profile (constructionTrusted / foundationTrusted).
function structuralFactIsRecordBacked({ record, field }) {
  const value = record?.[field];
  const known = value != null && String(value).trim() !== '' && String(value).trim().toUpperCase() !== 'UNKNOWN';
  if (!known || !structuralFactIsTrustworthy({ record, field })) return false;
  // Field evidence from an accepted source is required. A value with none (an older cached record, a listing record) does not
  // back the price premium, and neither does an AI-reported "county" claim (model_inference), a listing or a generic web page.
  // The evidence must also name this value (evidenceNamesValue).
  const evidence = firstStructuralEvidence(record?._fieldEvidence?.[field]);
  return evidenceSourceIsAccepted(evidence) && evidenceNamesValue(field, evidence, value);
}

// The trust verdict the WDO price reads for one structural field of a PROFILE (the enriched lookup profile the estimator posts back,
// or a saved older one). Conservative (owner 2026-11-26): a reading is trusted ONLY with an explicit stamp true, or with field-specific
// evidence from a source that is not a photo / AI / generic guess (a county record, a tech-verified value), or a value a person typed
// in (_manualFields). A wrong-premise flag makes machine readings untrusted. The profile's own false
// stamp and any fieldVerify evidence always win. Everything else (an old profile, a record-only profile, missing sources) is untrusted:
// the WDO price falls back to block / slab and adds the staff note. This can only lower a quote versus the frame and crawl cells.
// Allowlist (not a denylist): only these evidence sources back a frame or crawl premium. Anything else (satellite, AI or
// model_inference, listing, aggregator, generic, unknown, missing) is untrusted.
const ACCEPTED_STRUCTURAL_EVIDENCE_SOURCES = new Set(['county', 'cadastral', 'permit', 'builder', 'verified']);
function evidenceSourceIsAccepted(evidence) {
  return ACCEPTED_STRUCTURAL_EVIDENCE_SOURCES.has(String(evidence?.sourceType || '').trim().toLowerCase());
}
function firstStructuralEvidence(stored) {
  if (Array.isArray(stored)) return stored.find((e) => e && typeof e === 'object') || null;
  return stored && typeof stored === 'object' ? stored : null;
}
// Evidence vouches only for the value it carries. Evidence with no value (an older shape) names nothing to compare and passes; one
// that names another value (the technician confirmed SLAB, the profile says RAISED) backs nothing, whatever its source or a stamp
// says. Two texts name the same value when they match, or when the field's reader reads them the same ("Crawl space" = CRAWLSPACE).
const FIELD_READERS = {
  constructionMaterial: normalizeConstruction,
  foundationType: normalizeFoundation,
  squareFootage: (size) => (Number(size) > 0 ? Number(size) : undefined),
};
function evidenceNamesValue(field, evidence, value) {
  if (evidence?.value == null) return true;
  if (String(evidence.value).trim().toUpperCase() === String(value ?? '').trim().toUpperCase()) return true;
  const reading = FIELD_READERS[field](evidence.value);
  return reading !== undefined && reading === FIELD_READERS[field](value);
}
// A technician's saved confirmation of a value: the lookup cache's verified override writes the value and this evidence, and the
// override is keyed by the requested address, so it describes the customer's home even when the record describes a neighbour's.
// It vouches only for the value it carries.
function technicianConfirmed(field, stored, value) {
  const evidence = firstStructuralEvidence(stored);
  return evidence?.sourceType === 'verified' && evidence.fieldVerify !== true && evidence.value != null
    && evidenceNamesValue(field, evidence, value);
}
const fieldEvidenceOf = (profile, field) => profile?.fieldEvidence?.[field] ?? profile?._fieldEvidence?.[field];
function profileStructuralFactIsTrusted(profile, { field, flag }) {
  // A value a staff member or tech typed in (the estimator's manual-field list) is a person confirming it: trusted, even over a
  // stale machine stamp from the lookup that was there before the edit. So is a technician's saved confirmation of the value.
  if (Array.isArray(profile?._manualFields) && profile._manualFields.includes(field)) return true;
  const stored = fieldEvidenceOf(profile, field);
  if (technicianConfirmed(field, stored, profile?.[field])) return true;
  // A wrong-premise lookup (the geocoder snapped to a neighbouring parcel) makes every machine reading untrusted, stamp or not.
  if (hasWrongPremiseFlag(profile)) return false;
  if (profile?.[flag] === false) return false;
  const evidence = firstStructuralEvidence(stored);
  if (Array.isArray(stored) ? stored.some((e) => e?.fieldVerify) : evidence?.fieldVerify) return false;
  // Evidence from a source outside the allowlist, or evidence naming another value, overrides a machine stamp true.
  if (evidence && !(evidenceSourceIsAccepted(evidence) && evidenceNamesValue(field, evidence, profile?.[field]))) return false;
  if (profile?.[flag] === true) return true;
  return !!evidence;
}
const WDO_STRUCTURAL_FIELDS = Object.freeze({
  construction: { field: 'constructionMaterial', flag: 'constructionTrusted' },
  foundation: { field: 'foundationType', flag: 'foundationTrusted' },
});
// The home size the WDO price reads. A wrong-premise lookup describes a neighbouring parcel, so its living area, and the footprint
// taken from it, are no size until a person confirms the size: typed into the estimator (_homeSqFtManuallyEdited), or a
// technician's saved confirmation of the living area the profile carries.
function profileHomeSizeIsTrusted(profile) {
  if (!hasWrongPremiseFlag(profile) || profile?._homeSqFtManuallyEdited === true) return true;
  return technicianConfirmed('squareFootage', fieldEvidenceOf(profile, 'squareFootage'), profile?.homeSqFt || profile?.squareFootage);
}
// { constructionTrusted, foundationTrusted, homeSizeTrusted }: always all three, true or false. The pricer reads a construction or
// foundation verdict only when it is true, and the size verdict only when it is false.
function structuralTrustVerdicts(profile) {
  return {
    constructionTrusted: profileStructuralFactIsTrusted(profile, WDO_STRUCTURAL_FIELDS.construction),
    foundationTrusted: profileStructuralFactIsTrusted(profile, WDO_STRUCTURAL_FIELDS.foundation),
    homeSizeTrusted: profileHomeSizeIsTrusted(profile),
  };
}

// 'address' alone marks a WRONG-PREMISE lookup: the geocoder snapped to a
// different parcel, so the record's dimensions describe the neighbor. 'all'
// is deliberately excluded here — its MEDIUM form marks an AI-web-search
// record for the RIGHT address (the county roll gave nothing), whose
// dimensions source-arbitration grades as low-confidence LOOKUP_ESTIMATE
// facts that route to a reviewable draft; its HIGH form fires only when
// there is no record to strip at all. Callers with NO review lane (the
// customer-facing path) keep the stricter hasGlobalVerifyFlag instead.
function hasWrongPremiseFlag(enriched) {
  const flags = Array.isArray(enriched?.fieldVerifyFlags) ? enriched.fieldVerifyFlags : [];
  return flags.some((flag) => String(flag?.field || '').trim().toLowerCase() === 'address');
}

// A satellite attachment reclassification deliberately ships with a
// fieldVerifyFlags entry for propertyType whose own copy says to confirm
// townhome vs single-family BEFORE pricing
// (property-lookup-v2#applyVisionPropertyTypeEvidence keeps fieldVerify on
// the evidence, and the flag builder emits field='propertyType'). Property
// type carries its own pricing adjustment, so a flagged type must not move
// a price — the caller keeps its stored classification instead.
// 'Unknown' is a NON-classification, not a classification of "unknown", and
// it is TRUTHY: property records normalize a missing type to the literal
// 'UNKNOWN', and the unit-scope guard now surfaces 'Unknown' rather than a
// plausible-but-wrong 'Single Family' (property-lookup-v2 residentialDisplay
// Type). Trusting either lets a lookup that resolved NOTHING overwrite a
// customer's SAVED Condo/Townhome, after which the pest normalizer prices
// the unit as single-family with no verify flag to catch it (codex r47 P1).
// Absent beats a placeholder — the record leg, then the stored type, stand.
function lookupPropertyTypeIsUnresolved(value) {
  return String(value || '').trim().toUpperCase() === 'UNKNOWN';
}

function lookupPropertyTypeIsTrustworthy(enriched) {
  if (!enriched?.propertyType) return false;
  if (lookupPropertyTypeIsUnresolved(enriched.propertyType)) return false;
  return !hasVerifyFlagMatching(enriched, (field) => (
    field.includes('propertytype') || field.includes('property_type')
  ));
}

// County/assessor-backed pool + cage survive a low AI grade: the enriched
// payload stamps poolSource ('verified' | 'county' | 'vision'), and cage
// presence comes from the assessed extra-features roll (poolCageSqft) — that
// is record data, not an imagery guess, so an obstructed photo is no reason
// to quote a pool-less property. Vision-sourced pool/cage stay gated.
function poolFeaturesAreRecordBacked(enriched) {
  const src = String(enriched?.poolSource || '').trim().toLowerCase();
  return src === 'county' || src === 'verified';
}

function poolCageIsRecordBacked(enriched) {
  const sqft = Number(enriched?.poolCageSqft);
  return Number.isFinite(sqft) && sqft > 0;
}

module.exports = {
  poolFeaturesAreRecordBacked,
  poolCageIsRecordBacked,
  LOOKUP_AI_CONFIDENCE_FLOOR,
  hasGlobalVerifyFlag,
  lookupConfidenceIsAdequate,
  lookupBedAreaIsTrustworthy,
  lookupBedAreaReadIsFlagged,
  lookupFeatureReadIsFlagged,
  lookupLawnAreaIsTheOnlyFeatureDoubt,
  lookupDisputedPhotoFields,
  lookupFeaturesAreTrustworthy,
  lookupPropertyTypeIsTrustworthy,
  lookupDimensionIsTrustworthy,
  hasHighPriorityDimensionFlag,
  recordPropertyTypeIsTrustworthy,
  lookupTurfEstimateIsTrustworthy,
  // Value-agnostic turf trust: a consumer distinguishing "the lookup
  // REFUSED this read" from "the lookup carried no value" needs this one,
  // since the estimate predicate folds both into a single false.
  lookupTurfReadIsTrustworthy,
  lookupTurfZeroIsObserved,
  lookupTreeCountIsTrustworthy,
  lookupPalmCountIsTrustworthy,
  structuralFactIsTrustworthy,
  structuralFactIsRecordBacked,
  structuralTrustVerdicts,
  hasWrongPremiseFlag,
};
