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
  _termiteFootprintAuto: false, _footprintUnknownLookup: false,
  _trenchingPerimeterAuto: false, _boracareSqftAuto: false, _preslabSqftAuto: false,
  _palmCountAuto: false, _homeSqFtEdited: false, _lotSqFtEdited: false,
  _storiesEdited: false, _poolCageSizeEdited: false, _unitCountEdited: false,
};
