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
    applicationMethod === "perimeter_spray" &&
    serviceLine === "pest";
  // Per-basis products carry their verified label rate in the legacy
  // display fields (default_rate "0.2-0.8" + default_unit "fl_oz/gal").
  // When there is no per-1k rate and the pest 4-oz house default doesn't
  // apply, start the tech at the label band's LOW end in the label's own
  // unit — parseFloat reads the low bound out of an "X-Y" band.
  const perBasisUnit = isPerBasisUnit(defaultUnit);
  const labelDisplayRate = perBasisUnit
    ? parseFloat(String(product.default_rate ?? product.defaultRate ?? ""))
    : NaN;
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
