// client/src/lib/fast-complete-products.js
//
// The product rules of the tech Fast Complete sheet (components/tech/
// FastCompleteSheet.jsx and its "+ Other product" picker): which catalog
// products the picker lists, ONE unit model for every row on the sheet, and
// when a stock at zero holds Complete.
//
// Units (owner rulings 2026-09-27/28): nothing a tech sees or types is in
// mL. A liquid is measured in tsp (the spoon set) under 1 fl oz, otherwise
// fl oz or gal; a dry product in g, oz or lb (gel baits in grams). A row
// keeps its product's measure — liquid, weight or count — and offers only
// that measure's units, starting in the unit the tech is shown the amount
// in. The server's unit list has no tsp, so a tsp amount is sent as fl oz
// (6 tsp = 1 fl oz) and read back in tsp by formatMeasuredAmount.
import { formatMeasuredAmount } from "./mix-amount";
import { TSP_PER_FL_OZ, submittedAmount } from "./measure-units";
import { isDryFormProduct, resolveRatePrefill } from "./product-rate-prefill";

// A gel bait's usual weight reads in grams, the unit it is recorded in.
const GRAMS_PER_UNIT = { g: 1, oz: 28.3495, lb: 453.592 };

// products_catalog.category values. Pest products are listed first; the
// hidden ones are never applied to a property (yard signs, cleaner, traps,
// termite monitors); everything else waits behind "Show other products".
const PEST_CATEGORIES = new Set([
  "insecticide", "termiticide", "termiticide / insecticide", "igr", "bait",
  "rodenticide", "mosquito", "termite bait", "adjuvant",
]);
const HIDDEN_CATEGORIES = new Set(["supplies", "cleaner", "rodent trap", "termite monitoring"]);

function categoryKey(product) {
  return String(product?.category || "").trim().toLowerCase()
    .replace(/_/g, " ").replace(/\s*\/\s*/g, " / ").replace(/\s+/g, " ");
}

/** 'pest' | 'other' | 'hidden' — where the picker lists a catalog product. */
export function productGroup(product) {
  const key = categoryKey(product);
  if (HIDDEN_CATEGORIES.has(key)) return "hidden";
  return PEST_CATEGORIES.has(key) ? "pest" : "other";
}

// The categories a lawn visit applies, listed first in the lawn-aware picker.
// Everything else (pest baits, termiticides, ...) waits behind "Show other
// products".
const LAWN_CATEGORIES = new Set([
  "herbicide", "pre-emergent", "post-emergent", "fungicide", "insecticide", "fertilizer",
  "liquid fertilizer", "micronutrient", "micronutrient fertilizer", "pgr", "amendment", "soil amendment", "biostimulant",
  "wetting agent", "adjuvant", "surfactant", "soil surfactant",
]);

/** 'pest' (the primary list) | 'other' | 'hidden' for the lawn-aware picker. */
export function lawnProductGroup(product) {
  const key = categoryKey(product);
  if (HIDDEN_CATEGORIES.has(key)) return "hidden";
  return LAWN_CATEGORIES.has(key) ? "pest" : "other";
}

/** The category as the tech reads it: "Insecticide", "IGR", "Termite bait". */
export function categoryLabel(product) {
  const text = String(product?.category || "").trim().replace(/_/g, " ");
  if (!text) return "";
  if (text.toLowerCase() === "igr") return "IGR";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// A stored unit's base, the way the server normalizes inventory units:
// "fl_oz/gal" → "fl_oz", "Fl Oz" → "fl_oz", "lbs" → "lb".
function baseUnit(unit) {
  return String(unit || "").split("/")[0].trim().toLowerCase()
    .replace(/\s+/g, "_").replace(/s$/, "");
}

const LIQUID_UNITS = new Set(["fl_oz", "floz", "gal", "gallon", "qt", "quart", "pt", "pint", "ml", "l", "liter", "litre"]);
const WEIGHT_UNITS = new Set(["lb", "pound", "g", "gram", "kg"]);

// Bare "oz" says nothing: it is recorded for liquids and dry weights alike.
function unitDimension(unit) {
  const base = baseUnit(unit);
  if (LIQUID_UNITS.has(base)) return "liquid";
  if (WEIGHT_UNITS.has(base)) return "weight";
  return base === "each" ? "count" : null;
}

// The catalog's formulation names a gel its name doesn't (Vendetta Plus).
const isGelProduct = (product) => /\bgels?\b/i.test(
  `${product?.name || ""} ${product?.category || ""} ${product?.formulation || ""}`,
);

// The catalog formulation names the form outright ("granular", "dust",
// "bait block", "DF", "SC", "flowable", "liquid concentrate"). A dry form is
// weighed even when it is sprayed (a DF or soluble granule); "dry flowable"
// is dry, a bare "flowable" is not.
const DRY_FORMULATION = /\b(granul\w*|dust|bait|briquet|block|cartridge|pellets?|df|sg|wdg|wsg|wg|wp|dry)\b/i;
const LIQUID_FORMULATION = /\b(sc|ec|ew|cs|me|mec|sl|se|aq|flowable|liquid|concentrate|suspension|emulsion|microemulsion|emulsifiable)\b/i;
function formulationDimension(product) {
  const text = String(product?.formulation || "");
  if (DRY_FORMULATION.test(text)) return "weight";
  return LIQUID_FORMULATION.test(text) ? "liquid" : null;
}

/**
 * 'liquid' | 'weight' | 'count'. The first source that settles it wins: a
 * gel bait is weighed; then the unit its stock is kept in; then the unit it
 * is usually recorded in on these visits; then its catalog rate unit; then
 * its catalog formulation; then its name and category (a dust, granule or
 * bait is weighed, anything else is a liquid).
 */
export function productDimension(product, common) {
  if (isGelProduct(product)) return "weight";
  const resolved = resolveRatePrefill(product, { serviceLine: "pest" });
  return unitDimension(product?.inventory_unit)
    || unitDimension(common?.usualUnit)
    || unitDimension(resolved.amountUnit)
    || unitDimension(resolved.rateUnit)
    || formulationDimension(product)
    || (isDryFormProduct(product) ? "weight" : "liquid");
}

/** The units a row offers, by its measure. Never mL. */
export const UNIT_CHOICES = {
  liquid: [{ value: "tsp", label: "tsp" }, { value: "fl_oz", label: "fl oz" }, { value: "gal", label: "gal" }],
  weight: [{ value: "g", label: "g" }, { value: "oz", label: "oz" }, { value: "lb", label: "lb" }],
  count: [{ value: "each", label: "each" }],
};
const FALLBACK_UNIT = { liquid: "fl_oz", weight: "oz", count: "each" };

// A recorded unit as one of the measure's own units, or null. Bare "oz" is
// a fluid ounce for a liquid and a weight ounce for a dry product.
const UNIT_ALIASES = {
  liquid: { tsp: "tsp", oz: "fl_oz", ounce: "fl_oz", fl_oz: "fl_oz", floz: "fl_oz", gal: "gal", gallon: "gal" },
  weight: { g: "g", gram: "g", oz: "oz", ounce: "oz", lb: "lb", pound: "lb" },
  count: { each: "each" },
};
export function measureUnit(unit, dimension) {
  return UNIT_ALIASES[dimension]?.[baseUnit(unit)] || null;
}

// The row unit a reading is written in: "1½ tsp" → tsp, "4 fl oz" → fl_oz.
function readingUnit(text, dimension) {
  const label = String(text || "").replace(/^-?[\d.]*[⅛¼⅜½⅝¾⅞]?\s+/, "");
  return UNIT_CHOICES[dimension].find((choice) => choice.label === label)?.value || null;
}

// The usual amount on these visits as the picker writes it, and the row unit
// that is written in: formatMeasuredAmount reads a spoon-measured liquid dose
// in tsp and a dry weight under 1 oz in grams, and a gel bait reads in grams.
function usualReading(product, common, dimension) {
  const amount = Number(common?.usualAmount);
  if (!common?.usualUnit || !(amount > 0)) return null;
  const unit = measureUnit(common.usualUnit, dimension);
  const grams = isGelProduct(product) && GRAMS_PER_UNIT[unit];
  const text = grams ? amountText(amount * grams, "g")
    : unit ? amountText(amount, unit) : formatMeasuredAmount(amount, common.usualUnit);
  return { text, unit: readingUnit(text, dimension) };
}

/**
 * A new row's measure and preselected unit. Only the unit is preselected:
 * the amount is the tech's to enter. Gel baits start in grams (owner ruling
 * 2026-09-28); otherwise the unit the picker wrote the usual amount in, so
 * typing the number the tech was shown records that amount ("usually 1½ tsp"
 * starts in tsp, never fl oz); else the catalog's amount unit at the row's
 * method.
 */
export function productUnits(product, { common = null, method = "" } = {}) {
  const dimension = productDimension(product, common);
  const resolved = resolveRatePrefill(product, { applicationMethod: method, serviceLine: "pest" });
  const unit = (isGelProduct(product) && "g")
    || usualReading(product, common, dimension)?.unit
    || measureUnit(common?.usualUnit, dimension)
    || measureUnit(resolved.amountUnit, dimension)
    || FALLBACK_UNIT[dimension];
  return { dimension, unit };
}

/**
 * A house total in the unit its tile reads: 0.25 fl oz of surfactant is
 * 1½ tsp, so Edit amounts holds 1.5 tsp — what the tile says — and the
 * record still gets 0.25 fl oz.
 */
export function seededAmount(amount, unit) {
  return unit === "fl_oz" && amountText(amount, unit)?.endsWith(" tsp")
    ? { amount: Number(amount) * TSP_PER_FL_OZ, unit: "tsp" }
    : { amount, unit };
}

/** The amount /complete would receive is above zero (a tsp amount goes as fl oz). */
export const hasAmount = (row) => submittedAmount(row.totalAmount, row.amountUnit).totalAmount > 0;

/** An amount the way the truck measures it: "1½ tsp", "4 fl oz", "5 g". */
export function amountText(amount, unit) {
  // A liquid reads as fl oz so a small dose shows in spoons; bare "oz" would
  // read as a dry weight.
  if (unit === "tsp") return formatMeasuredAmount(Number(amount) / TSP_PER_FL_OZ, "fl_oz");
  return formatMeasuredAmount(amount, unit);
}

/**
 * The usual amount on these visits as a number and a row unit ({ amount, unit }),
 * or null when the sheet knows none: the same figure usualAmountText words, for
 * "same as last time" said of a product the sheet has a usual amount for. A gel
 * bait reads in grams, as the picker writes it.
 */
export function usualAmountFor(product, common) {
  const amount = Number(common?.usualAmount);
  if (!common?.usualUnit || !(amount > 0)) return null;
  const unit = measureUnit(common.usualUnit, productDimension(product, common));
  if (!unit) return null;
  return isGelProduct(product) && GRAMS_PER_UNIT[unit] ? { amount: amount * GRAMS_PER_UNIT[unit], unit: "g" } : { amount, unit };
}

/** "5 g", "1½ tsp": the usual amount on these visits, in the product's measure. */
export function usualAmountText(product, common) {
  return usualReading(product, common, productDimension(product, common))?.text ?? null;
}

/** A tracked stock at or below zero (inventory_on_hand null = not tracked). */
export function isOutOfStock(product) {
  const raw = product?.inventory_on_hand;
  if (raw == null || raw === "") return false;
  const onHand = Number(raw);
  return Number.isFinite(onHand) && onHand <= 0;
}

// A unit's measure as the server's stock conversion reads it
// (inventory-units.js): a bare oz may stand in for a liquid or a weight.
function stockMeasure(unit) {
  const base = baseUnit(unit);
  return base === "oz" || base === "ounce" ? "oz" : unitDimension(unit);
}

/**
 * Whether /complete would refuse this product for stock: a tracked stock at
 * or below zero that the submitted amount unit converts to. The server
 * deducts only an amount it can convert (the same measure, or a bare oz for
 * a liquid or a weight, never a count) and skips any other, so a gel weighed
 * in grams against tubes counted "each" is never held here. A stock with no
 * unit is counted in the amount's own unit.
 */
export function stockHolds(product, amountUnit) {
  if (!isOutOfStock(product)) return false;
  if (!baseUnit(product.inventory_unit)) return true;
  const stock = stockMeasure(product.inventory_unit);
  const amount = stockMeasure(amountUnit);
  if (!stock || !amount) return false;
  if (stock === "oz" || amount === "oz") return stock !== "count" && amount !== "count";
  return stock === amount;
}

const lower = (value) => String(value || "").toLowerCase();
export const byName = (a, b) => String(a.name || "").localeCompare(String(b.name || ""));

// Name prefix, then name, short name, active ingredient, category.
function matchScore(product, q) {
  const name = lower(product.name);
  if (name.startsWith(q)) return 5;
  if (name.includes(q)) return 4;
  if (lower(product.display_name).includes(q)) return 3;
  if (lower(product.active_ingredient).includes(q)) return 2;
  return lower(product.category).includes(q) ? 1 : 0;
}

/** Search results, best match first; ties alphabetical. `q` is lower-case. */
export function rankProducts(products, q) {
  return products
    .map((product) => ({ product, score: matchScore(product, q) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || byName(a.product, b.product))
    .map((entry) => entry.product);
}
