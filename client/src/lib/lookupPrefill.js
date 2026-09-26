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
 * The lookup's condo unit-lot flag (a lotSize verify flag scoped
 * 'unit_parcel'): a condo record carrying the DEVELOPMENT's parcel. The lot
 * measures the wrong thing, and so does every area estimate read off that
 * parcel — the website quote refuses the same set (public-quote.js
 * condoScopeLotFlag).
 */
export function lookupLotIsUnitParcel(profile) {
  return Array.isArray(profile?.fieldVerifyFlags)
    && profile.fieldVerifyFlags.some((f) => f && f.field === "lotSize" && f.scope === "unit_parcel");
}

// The parcel-scope area reads public-quote withholds under that flag (turf
// and its provenance markers, hardscape %, bed area) plus the lot-derived
// stale-imagery turf preview.
const UNIT_PARCEL_AREA_READS = [
  "estimatedTurfSf", "turfSource", "turfCappedToParcel", "turfFallbackPreviewSf",
  "imperviousSurfacePercent", "imperviosSurfacePercent",
  "estimatedBedAreaSf", "estimatedBedAreaPercent", "bedAreaSource",
];

// A priced profile still carrying the development parcel's turf, bed, or
// hardscape read — the percentages size the lot-fallback turf too (codex r2
// P1). The request builder writes a TYPED bed area into estimatedBedAreaSf,
// marked bedAreaSource 'manual' — that one is the operator's (pre-push P1).
function pricedFromParcelAreaReads(profile) {
  return ["estimatedTurfSf", "turfFallbackPreviewSf", "imperviousSurfacePercent",
    "imperviosSurfacePercent", "estimatedBedAreaPercent"].some((key) => Number(profile[key]) > 0)
    || (Number(profile.estimatedBedAreaSf) > 0 && profile.bedAreaSource !== "manual");
}

/**
 * The profile the estimator works from, scoped once where it enters the
 * tool (fresh lookup AND a reopened estimate's priced profile), so every
 * reader — pricing, prefill, the turf panel, the flea exterior area — sees
 * the same thing. The lot itself stays on the profile as display context
 * (the flag names it); it is simply never prefilled, and pricing reads the
 * Lot box.
 */
export function scopeUnitParcelProfile(profile) {
  if (!lookupLotIsUnitParcel(profile)) return profile;
  const scoped = { ...profile };
  for (const key of UNIT_PARCEL_AREA_READS) delete scoped[key];
  return scoped;
}

// Measurement boxes the tool fills itself (flag = "auto-derived, not typed").
const AUTO_DERIVED_TERMITE_MEASUREMENTS = [
  ["termiteFootprintSqFt", "_termiteFootprintAuto"],
  ["trenchingPerimeterLF", "_trenchingPerimeterAuto"],
  ["boracareSqft", "_boracareSqftAuto"],
  ["preslabSqft", "_preslabSqftAuto"],
];

/**
 * Reopening a saved estimate restores its form from the stored inputs. One
 * saved before today's lookup guards can carry values those guards now
 * refuse. The priced profile it was saved with is the authority; only
 * values the tool filled itself are cleared — anything the operator typed
 * (_manualFields / the edited flags) stays.
 * - A unit-address lookup: no `_unitLookup` flag (saved before unit scope)
 *   and, while the form still types it a condo (the same test as the
 *   tool's unit scope), termite boxes auto-derived from one unit's interior
 *   area and a trenching perimeter "estimated from footprint".
 * - A condo record carrying the development's parcel (unit_parcel): the
 *   development's lot, the lookup's bed area, and a flea exterior area
 *   copied from the development's turf — and, even with a typed lot, a
 *   priced profile that still carries the parcel's turf / bed reads (the
 *   stored price was computed from them; scopeUnitParcelProfile only
 *   removes them from the next calculation).
 * Returns the form plus the labels of what was cleared, so the caller can
 * refuse the stored price that was computed from them.
 */
export function scrubReopenedEstimateForm(form, engineProfile) {
  const next = { ...form };
  const cleared = [];
  const typed = (key) => (form._manualFields || []).includes(key);
  if (engineProfile?.residentialUnitLookup) {
    next._unitLookup = true;
  }
  if (engineProfile?.residentialUnitLookup && /^condo/i.test(String(form.propertyType || ""))) {
    if (form.svcTrenching && form.trenchingEstimateFromFootprint) {
      next.trenchingEstimateFromFootprint = false;
      cleared.push("trenching perimeter estimated from footprint");
    }
    for (const [key, autoFlag] of AUTO_DERIVED_TERMITE_MEASUREMENTS) {
      if (next[autoFlag] && String(next[key] || "").trim() !== "") {
        next[key] = "";
        next[autoFlag] = false;
        cleared.push("termite measurements");
      }
    }
  }
  if (lookupLotIsUnitParcel(engineProfile)) {
    if (!form._lotSqFtEdited && !typed("lotSqFt") && Number(form.lotSqFt) > 0) {
      next.lotSqFt = "";
      cleared.push("lot size");
    }
    if (!typed("bedArea") && Number(form.bedArea) > 0) {
      next.bedArea = "";
      cleared.push("bed area");
    }
    if (form.fleaExteriorAreaSource === "AI_ESTIMATE" && Number(form.fleaExteriorAreaSqFt) > 0) {
      next.fleaExteriorAreaSqFt = "0";
      next.fleaExteriorAreaSource = "UNKNOWN";
      cleared.push("flea exterior area");
    }
    if (pricedFromParcelAreaReads(engineProfile)) {
      cleared.push("lawn and bed areas from the development's parcel");
    }
  }
  return { form: next, cleared: [...new Set(cleared)] };
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
