// client/src/lib/lawn-targets.js
//
// The targets a lawn product can be applied against: the one list the full
// completion form's Targets picker (SchedulePage) and the lawn re-service Fast
// Complete sheet both use, so a target recorded from either is the same name in
// service_products.targets and the compliance ledger.
// What a lawn product treats: weeds, turf-damaging insects, and turf diseases —
// what a lawn tech actually enters as a product's target, not structural pests.
export const LAWN_TARGET_SUGGESTIONS = [
  "Broadleaf weeds",
  "Crabgrass",
  "Nutsedge / sedge",
  "Green kyllinga",
  "Dollarweed",
  "Doveweed",
  "Chamberbitter",
  "Spurge",
  "Clover",
  "Goosegrass",
  "Torpedograss",
  "Annual bluegrass (Poa annua)",
  "Southern chinch bugs",
  "Fall armyworms",
  "Tropical sod webworms",
  "White grubs",
  "Tawny mole crickets",
  "Fire ants",
  "Nematodes",
  "Large patch",
  "Dollar spot",
  "Gray leaf spot",
  "Take-all root rot",
  "Fairy ring",
  "Pythium root rot",
];

// Fertilizer-family targets are the nutrition goal of the application — what
// the feeding is meant to correct or stimulate, in customer-report language.
export const NUTRITION_TARGET_SUGGESTIONS = [
  "Nitrogen green-up",
  "Deep green color",
  "Color & density",
  "Iron chlorosis (yellowing turf)",
  "Potassium deficiency",
  "Root strength & stress tolerance",
  "Balanced feeding",
  "Micronutrient deficiency",
  "Slow-release feeding",
  "Winter hardiness",
  "Magnesium deficiency (palms)",
  "Manganese deficiency (palms)",
  "Potassium deficiency (palms)",
];

// Fertilizer-family products (incl. micros/biostimulants) target nutrition
// goals rather than pests — their picker swaps to the nutrition suggestions.
export function productTargetsNutrition(product) {
  const category = String(
    product?.category || product?.product_category || "",
  ).toLowerCase();
  return /(fert|micronutrient|biostimulant)/.test(category);
}

// Whether a product's application records what it was applied against (the
// full completion form's own rule): everything except adjuvants, surfactants,
// soil/moisture products and growth regulators. A product with no category
// counts. Fertilizer-family products record nutrition goals instead
// (productTargetsNutrition).
export function productControlsTargets(product) {
  const category = String(
    product?.category || product?.product_category || "",
  ).toLowerCase();
  if (!category) return true;
  return !/(adjuvant|surfactant|soil|moisture|growth regulator|pgr)/.test(
    category,
  );
}
