// client/src/lib/product-rate-prefill.js
//
// Single source of truth for the catalog rate-prefill decision, shared by
// the CompletionPanel product picker (SchedulePage addProduct) and
// ServiceRecapModal (codex P1, PR #3419 r6): the same visit and product
// must prefill the same rate whichever completion path the technician
// takes. Precedence, in order:
//   1. verified per-1,000 catalog rate (default_rate_per_1000)
//   2. pest perimeter-spray house default (4 oz) — liquid general-pest
//      products with no catalog rate
//   3. per-basis display default's LOW bound in its label-native unit
//      ("0.1 g/spot", "4 fl_oz/100gal", …)

// A "/"-suffixed display unit is a label rate in the label's own basis — mix
// concentration ("fl_oz/gal", "fl_oz/100gal"), spot placement ("g/spot"),
// trunk dose ("ml/inch dbh"), per-acre broadcast ("oz/acre"), bed rate
// ("lb/100sf"), station density ("each/20ft") — everything except the
// per-1,000 area units, whose rates live in default_rate_per_1000 instead.
// Rate × sqft derivations and 1:1 amount units don't apply to these.
export function isPerBasisUnit(unit) {
  const u = String(unit || "");
  return u.includes("/") && !u.endsWith("/1000sf");
}

// A per-gallon rate ("fl_oz/gal", "oz/gal", "g/gal") is a tank concentration:
// it becomes a real applied quantity once the technician says how many gallons
// of mix went out — amount = rate x gallons, in the unit before the "/". Every
// other per-basis unit (g/spot, ml/inch dbh, oz/acre) has no carrier volume to
// multiply by and still waits for the technician's actual.
// These live here, beside isPerBasisUnit, because the closeout panel AND the
// lawn plan reconciliation both have to agree on what a tank row is: a rule
// re-implemented per call site is what let a refresh blank a dose the tech had
// already measured.
export function isPerGallonUnit(unit) {
  return /\/gal$/.test(String(unit || ""));
}
// Gallons the technician entered make this row's quantity an actual, not a
// suggestion — no plan refresh, visit-area change or withdrawal may blank it.
export function isTankCalculation(product = {}) {
  return isPerGallonUnit(product.rateUnit) && Number(product.carrierGallons) > 0;
}
export function derivedTankTotal(rate, gallons) {
  const r = Number(rate);
  const g = Number(gallons);
  if (!Number.isFinite(r) || r <= 0 || !Number.isFinite(g) || g <= 0) return "";
  // Four decimals, matching the server's per-gallon calculator and above the
  // three `service_products.total_amount` stores: a 0.03 fl oz/gal mix in half
  // a gallon is 0.015, not 0.02, and small valid doses must not round to zero
  // and render blank (Codex r1 P2).
  return Math.round(r * g * 10000) / 10000;
}

// The tank rules, in one place, as three small operations over a product row.
// The closeout's per-product updater was accumulating a branch per rule; the
// tank concern lives here instead so that updater stays a state machine about
// plan provenance, not about carrier volume.

// The row whose corrections travel: the one that FIRST set the volume, not any
// row the technician has since edited (a detached row's second keystroke must
// not start driving its old siblings again — typing "12" is two edits).
export function tankOwnerRow(rows = []) {
  // An owner with no usable volume owns nothing: once the technician clears
  // the tank, the next entry on any row establishes it again rather than
  // detaching against an empty owner (Codex r3 P2).
  return rows.find((row) => isPerGallonUnit(row.rateUnit) && row.tankOwner
    && Number(row.carrierGallons) > 0) || null;
}

// Removing the owner leaves its followers holding the same mix: promote one so
// the next product added still joins that tank instead of asking for the
// volume again (Codex r2 P2).
export function promoteTankOwner(rows = []) {
  if (tankOwnerRow(rows)) return rows;
  // Only a row still FOLLOWING the tank can inherit it. A detached row holds
  // its own mix — promoting it would make its next edit rewrite the rows that
  // were following the removed owner, and hand new products its volume
  // (pre-push audit P1). With no follower left there is no shared tank.
  const heir = rows.find((row) => isPerGallonUnit(row.rateUnit)
    && !row.carrierGallonsManual && Number(row.carrierGallons) > 0);
  return heir ? rows.map((row) => (row === heir ? { ...row, tankOwner: true } : row)) : rows;
}

// A per-gallon row with the technician's gallons behind it shows rate x
// gallons in the rate's own base unit — whatever cleared it earlier. Applied
// as the closing step of every row update, so a handler that blanks a derived
// total it cannot express does not have to know about tanks.
export function applyTankDose(row) {
  if (!isPerGallonUnit(row.rateUnit)) return row;
  // A SEEDED total is a house default, not a technician entry: it is marked
  // manual only so a rate or area edit cannot recompute it. Stating the
  // carrier volume is the technician saying what actually went out, so the
  // seed gives way and the row becomes derived from here on — otherwise a
  // seeded 4 oz stands while the rate and gallons say 8 (Codex r5 P1).
  if (row.totalAmountManual && !row.totalAmountSeeded) return row;
  const dose = derivedTankTotal(row.rate, row.carrierGallons);
  if (row.totalAmountSeeded && dose === "") return row;
  // Clearing the gallons clears the dose: derivedTankTotal returns "" without
  // a volume, so this one call covers both halves of the rule.
  return {
    ...row,
    amountUnit: String(row.rateUnit).split("/")[0],
    totalAmount: dose,
    totalAmountManual: false,
    totalAmountSeeded: false,
  };
}

// Gallons entered on the tank's owner (or on any row while nobody owns it)
// travel; a detached row's edits are its own.
export function tankPropagates(rows, productId, field) {
  if (field !== "carrierGallons") return false;
  const owner = tankOwnerRow(rows);
  return !owner || owner.productId === productId;
}

// One tank, one carrier volume: a row still following the tank takes the new
// volume and the dose it implies. A row holding its own gallons is left alone.
export function followTank(row, gallons) {
  if (!isPerGallonUnit(row.rateUnit) || row.carrierGallonsManual) return row;
  return applyTankDose({ ...row, carrierGallons: gallons });
}

// The technician typed this row's own gallons: it stops following the tank,
// and if no row owned the tank yet it becomes the owner.
export function markTankEntry(row, owner) {
  const hasVolume = Number(row.carrierGallons) > 0;
  // Clearing an override while a tank is still active rejoins it there and
  // then: the row has no volume of its own, and leaving it blank until the
  // owner happens to be edited again would block the closeout on a missing
  // actual (Codex r4 P2). The owner clearing its OWN gallons is the other
  // case — that clear has already travelled to the followers.
  if (!hasVolume && owner && owner.productId !== row.productId) {
    return applyTankDose({
      ...row, carrierGallons: owner.carrierGallons, carrierGallonsManual: false, tankOwner: false,
    });
  }
  return {
    ...row,
    // A row holds its own gallons only while it HAS gallons: clearing them
    // leaves nothing to protect, so the row rejoins the shared tank instead
    // of sitting blank while the rest of the mix has a volume (Codex r3 P2).
    carrierGallonsManual: hasVolume,
    // Claim the tank only with a volume to share, and give it up when that
    // volume is cleared.
    tankOwner: hasVolume && (!owner || owner.productId === row.productId),
  };
}

// The mirror of clearTankOnUnitChange: a row converted INTO a per-gallon rate
// joins the mix already in the tank, exactly as adding a per-gallon product
// does, instead of asking for a volume the visit has already recorded
// (Codex r3 P2).
export function joinTankOnUnitChange(row, previousRateUnit, owner) {
  if (isPerGallonUnit(previousRateUnit) || !isPerGallonUnit(row.rateUnit)) return row;
  return applyTankDose({ ...row, carrierGallons: owner?.carrierGallons ?? "", carrierGallonsManual: false });
}

// Leaving a per-gallon rate retires the tank with it: the volume is cleared so
// a round-trip back cannot re-drive a quantity from a stale figure, and the
// owner slot frees for the next entry.
export function clearTankOnUnitChange(row, previousRateUnit) {
  if (!isPerGallonUnit(previousRateUnit) || isPerGallonUnit(row.rateUnit)) return row;
  return { ...row, carrierGallons: "", carrierGallonsManual: false, tankOwner: false };
}

// Generic "insecticide" categories cover dry/bait/packet forms too (e.g.
// Advion WDG Granular, Delta Dust, Alpine WSG), whose inferred method
// still falls through to perimeter_spray — a 4 oz liquid default would be
// a wrong compliance record for those, so screen the name/category for
// dry-form and dry-formulation markers (WSG/WDG/WG/WP/DF).
export function isDryFormProduct(product = {}) {
  return /\b(granul\w*|dust|bait|gel|station|trap|briquet|tablet|blox|dunk|packet|wsg|wdg|wg|wp|df)\b/i.test(
    `${product.name || ""} ${product.category || product.product_category || ""}`,
  );
}

// Adjuvants (surfactants) ride the tank as mix partners, not pest products —
// the 4-oz pest perimeter house default is an insecticide rate and must not
// prefill for them; with no catalog rate of their own they start blank.
export function isAdjuvantProduct(product = {}) {
  return /adjuvant|surfactant/i.test(
    `${product.name || ""} ${product.category || product.product_category || ""}`,
  );
}

export function normalizeApplicationMethod(value = "") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!normalized) return "";
  if (
    [
      "perimeter_spray",
      "broadcast_spray",
      "spot_treatment",
      "granular_broadcast",
      "soil_drench",
      "bait_placement",
      "station_check",
      "fog_ulv",
      "foliar_spray",
      "trunk_injection",
      "pin_stream",
    ].includes(normalized)
  ) return normalized;
  if (normalized.includes("trunk") || normalized.includes("inject")) return "trunk_injection";
  if (normalized.includes("foliar")) return "foliar_spray";
  if (normalized.includes("pin")) return "pin_stream";
  if (normalized.includes("granular")) return "granular_broadcast";
  if (normalized.includes("bait") || normalized.includes("gel") || normalized.includes("glue")) return "bait_placement";
  if (normalized.includes("station")) return "station_check";
  if (normalized.includes("fog") || normalized.includes("ulv")) return "fog_ulv";
  if (normalized.includes("spot")) return "spot_treatment";
  if (normalized.includes("broadcast")) return "broadcast_spray";
  if (normalized.includes("perimeter") || normalized.includes("band")) return "perimeter_spray";
  return normalized;
}

// Application-method inference with the service LINE already resolved —
// SchedulePage wraps this with its serviceLineFromType(serviceType);
// ServiceRecapModal calls it with "pest" directly (the recap path is
// server-gated to the pest-control category).
export function defaultApplicationMethodForLine(
  product = {},
  serviceLine = "",
  { serviceType = "", interiorLane = false } = {},
) {
  const category = String(product.category || product.product_category || "").toLowerCase();
  const explicit = product.application_method || product.method;
  if (explicit) return normalizeApplicationMethod(explicit);
  if (category.includes("bait") || category.includes("gel") || category.includes("glue")) return "bait_placement";
  // Liquid fertilizers (K-Flow, Green Flo, chelated micros — catalog rate
  // unit fl_oz/gal or "Liquid" in the name) go down as a spray, not granular.
  const rateUnit = String(
    product.rate_unit || product.rateUnit || product.default_unit || product.defaultUnit || "",
  ).toLowerCase();
  const liquidProduct =
    rateUnit.includes("fl") || rateUnit.includes("gal") ||
    /\b(liquid|flow?)\b/i.test(String(product.name || ""));
  if (category.includes("fert") && liquidProduct) return "broadcast_spray";
  if (category.includes("fert") || category.includes("granular")) return "granular_broadcast";
  if (serviceLine === "mosquito") return "fog_ulv";
  if (serviceLine === "lawn") return category.includes("herb") ? "spot_treatment" : "broadcast_spray";
  if (serviceLine === "palm" || serviceLine === "tree_shrub") return "foliar_spray";
  if (serviceLine === "termite" || serviceLine === "rodent") return "station_check";
  // Bed bug is an interior treatment: the pest perimeter_spray fallback
  // recorded interior work as exterior AND demanded perimeter footage the
  // (hidden) zone tracer would have prefilled, blocking a routine closeout
  // — default methodless products to an interior spot application instead
  // (codex P1 on the bed-bug untype). interiorLane comes from the STABLE
  // profile key; the name regex is the fallback for callers without it.
  if (interiorLane || /\bbed\s*bugs?\b/i.test(String(serviceType || ""))) return "spot_treatment";
  return "perimeter_spray";
}

// The rate-prefill decision. Returns everything the caller needs to build
// its selected-product state: the prefill rate, the rate unit, the amount
// unit (per-basis rates record the amount in the base unit before the "/"
// — inventory deduction can't convert a concentration), and the flags the
// downstream derivations key on.
export function resolveRatePrefill(product = {}, { applicationMethod = "", serviceLine = "" } = {}) {
  const defaultUnit =
    product.defaultUnit ||
    product.default_unit ||
    product.rateUnit ||
    product.rate_unit ||
    "oz";
  const catalogRate =
    product.defaultRatePer1000 ?? product.default_rate_per_1000 ?? product.ratePer1000 ?? "";
  // General-pest perimeter sprays: when the catalog carries no rate, start
  // at the house default of 4 oz (rate/total units move together with it so
  // a catalog unit like "oz/1000sf" can't pair with the fallback value).
  // Editable as before; catalog rates still win when present.
  const usePestSprayDefault =
    catalogRate === "" &&
    !isDryFormProduct(product) &&
    !isAdjuvantProduct(product) &&
    applicationMethod === "perimeter_spray" &&
    serviceLine === "pest";
  // Per-basis products carry their verified label rate in the legacy
  // display fields (default_rate "0.2-0.8" + default_unit "fl_oz/gal").
  // When there is no per-1k rate and the pest 4-oz house default doesn't
  // apply, start the tech at the label band's LOW end in the label's own
  // unit — parseFloat reads the low bound out of an "X-Y" band.
  const perBasisUnit = isPerBasisUnit(defaultUnit);
  const labelBandText = String(product.default_rate ?? product.defaultRate ?? "");
  const labelDisplayRate = perBasisUnit ? parseFloat(labelBandText) : NaN;
  // The band's UPPER bound ("X-Y" -> Y; single value -> itself) in the
  // label's own unit — the high-rate review ceiling for per-basis rates
  // (codex P1 r18): maxLabelRatePer1000 only covers per-1,000 products,
  // so without this a band like "0.25-1.5 fl_oz/gal" or "1-16
  // each/placement" had no reviewable maximum at all.
  const labelBandParts = perBasisUnit
    ? labelBandText.split("-").map((part) => parseFloat(part)).filter((n) => Number.isFinite(n) && n > 0)
    : [];
  const labelMaxRate = labelBandParts.length
    ? labelBandParts[labelBandParts.length - 1]
    : null;
  // DB numerics arrive as strings with trailing zeros ("0.5000") — show the
  // tech a clean number.
  const rate = usePestSprayDefault
    ? 4
    : catalogRate !== "" && Number.isFinite(Number(catalogRate))
      ? Number(catalogRate)
      : Number.isFinite(labelDisplayRate)
        ? labelDisplayRate
        : catalogRate;
  return {
    rate,
    labelMaxRate,
    rateUnit: usePestSprayDefault ? "oz" : defaultUnit,
    amountUnit: usePestSprayDefault
      ? "oz"
      : perBasisUnit
        ? defaultUnit.split("/")[0]
        : defaultUnit,
    usePestSprayDefault,
    perBasisUnit,
    defaultUnit,
  };
}
