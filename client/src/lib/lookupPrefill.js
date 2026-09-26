// Prefill gates for lookup-derived estimator inputs.
//
// The trust rules live SERVER-side in services/lookup-confidence.js (one
// home — the customer-facing pricing assistant and the agent draft path
// apply the same predicates); the lookup stamps each verdict onto the
// enriched profile and these helpers only interpret the stamp.

/**
 * Palm-count prefill (owner ruling 2026-08-10: the AI counts the palms,
 * the operator modifies if need be — the lawn treatable-area pattern).
 *
 * Suppress the prefill ONLY when the server affirmatively distrusted the
 * count (`palmCountTrusted === false`: low field-level confidence, provider
 * divergence, a palm verify flag, or a wrong-premise lookup). A legacy
 * cached payload carries no verdict and keeps the pre-existing prefill —
 * the operator is present and the field stays editable either way. A
 * distrusted count leaves the field EMPTY so the operator counts, rather
 * than anchoring them on prefilled garbage that would ride the
 * service-line override into per-palm injection pricing.
 */
export function palmPrefillAllowed(enrichedProfile) {
  if (!enrichedProfile) return false;
  const count = Number(enrichedProfile.estimatedPalmCount);
  if (!Number.isFinite(count) || count <= 0) return false;
  return enrichedProfile.palmCountTrusted !== false;
}

/**
 * Plat-median home-size prefill for an unassessed vacant parcel (new
 * construction the county roll hasn't posted yet). The server exposes
 * `subdivisionMedian` ONLY while the parcel carries no building fact, so a
 * real measurement (record or tech-verified) always wins by construction:
 * this helper is consulted only when the lookup's own homeSqFt is empty.
 * An unconfirmed address (the lookup's `address` verify flag: Google
 * snapped a mistyped entry to SOME parcel) yields nothing — a median for a
 * possibly wrong parcel must never reach pricing. Returns the median as a
 * positive integer, or null when there is nothing sourced to prefill — the
 * operator then sees the empty field and the pricing engine's flat 2,000
 * sq ft default, exactly as before.
 */
export function subdivisionMedianPrefillSqFt(enrichedProfile) {
  if (!enrichedProfile) return null;
  if ((enrichedProfile.fieldVerifyFlags || []).some((flag) => flag?.field === "address")) return null;
  const median = Number(enrichedProfile.subdivisionMedian?.medianSqft);
  if (!Number.isFinite(median) || median <= 0) return null;
  const rounded = Math.round(median);
  // A real record value wins. The one exception is the profile a SAVED
  // estimate stores and restores on reopen: its homeSqFt is the median the
  // form was prefilled with (the live lookup only ever exposes the median
  // beside an empty homeSqFt), so a homeSqFt that IS the median still
  // reads as the estimate, never as a measurement.
  const own = Number(enrichedProfile.homeSqFt);
  if (own > 0 && own !== rounded) return null;
  return rounded;
}

/**
 * Home sq ft the lookup prefills into the estimator: the record's own value
 * first, the plat-median estimate second, empty otherwise. A value typed by
 * the operator (`_homeSqFtEdited`) is handled by the caller and never
 * overwritten here.
 */
export function lookupHomeSqFtPrefill(enrichedProfile) {
  if (!enrichedProfile) return "";
  if (Number(enrichedProfile.homeSqFt) > 0) return String(enrichedProfile.homeSqFt);
  const median = subdivisionMedianPrefillSqFt(enrichedProfile);
  return median ? String(median) : "";
}

/**
 * The "Verify home living area" save must never stamp a plat-median
 * PREFILL as a tech-verified measurement (that would poison the cached
 * record with a neighbor's number under the strongest source type). The
 * guard clears the moment the operator edits the field — the same rule the
 * defaulted stories value already follows.
 */
export function homeSqFtIsUnverifiedPlatMedian(form, enrichedProfile) {
  if (!form || form._homeSqFtEdited) return false;
  const median = subdivisionMedianPrefillSqFt(enrichedProfile);
  // Only the untouched median itself is blocked: a reopened estimate loses
  // the transient edited flag, so a different typed size stays verifiable.
  return median !== null && Number(form.homeSqFt) === median;
}

// Measurements belong to the property, regardless of whether its address
// changes through typing, Places, a customer selection, or an incoming lead.
// Service selections and contact/linkage fields belong to the estimate.
export const EMPTY_PROPERTY_MEASUREMENTS = {
  homeSqFt: "", lotSqFt: "", stories: "1", unitCount: "",
  propertyType: "Single Family", isCommercial: "NO", commercialSubtype: "",
  commercialRiskType: "", commercialPestCadence: "", commercialInteriorService: "",
  commercialLawnCadence: "", treeShrubDensity: "", mosquitoPressure: "",
  hasPool: "NO", hasPoolCage: "NO", poolCageSize: "MEDIUM", nearWater: "NO",
  shrubDensity: "MODERATE", treeDensity: "MODERATE", landscapeComplexity: "MODERATE",
  bedArea: "", measuredTurfSf: "", palmCount: "", palmTreatmentCount: "", treeCount: "",
  termiteFootprintSqFt: "", termitePerimeterLF: "", boracareSqft: "",
  boracareSurfaceLinearFt: "", boracareSurfaceHeightFt: "", preslabSqft: "",
  trenchingPerimeterLF: "", trenchingConcreteLF: "", trenchingDirtLF: "", trenchingConcretePct: "",
  trenchingEstimateFromFootprint: false, topDressArea: "", plugArea: "",
  fleaExteriorAreaSqFt: "0", fleaExteriorAreaSource: "UNKNOWN", fleaExteriorZones: [],
  _termiteFootprintAuto: false, _footprintUnknownLookup: false, _unitLookup: false,
  _trenchingPerimeterAuto: false, _boracareSqftAuto: false, _preslabSqftAuto: false,
  _palmCountAuto: false, _homeSqFtEdited: false, _lotSqFtEdited: false,
  _storiesEdited: false, _poolCageSizeEdited: false, _unitCountEdited: false,
};
