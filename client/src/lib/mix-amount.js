// Mix amounts a technician can actually measure on the truck (owner rule,
// 2026-09-27: "nothing should be put into ml"). Liquids under 1 fl oz read as
// measuring-spoon teaspoons; larger liquids stay in fluid ounces for the
// ounce cup; dry weights stay in oz, or grams under 1 oz for the scale.
// Stored mL / liter amounts are converted, never shown.

const FRACTIONS = ["", "⅛", "¼", "⅜", "½", "⅝", "¾", "⅞"];
const TSP_PER_FL_OZ = 6;
const G_PER_OZ = 28.3495;
const FL_OZ_PER_ML = 1 / 29.5735;
const FL_OZ_PER_L = 1000 / 29.5735;

const FL_OZ_UNITS = new Set(["fl oz", "floz", "fluid ounce", "fluid ounces"]);
const ML_UNITS = new Set(["ml", "milliliter", "milliliters", "millilitre", "millilitres", "cc"]);
const L_UNITS = new Set(["l", "liter", "liters", "litre", "litres"]);

function normalizeUnit(unit) {
  return String(unit || "").trim().toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ");
}

function displayUnit(unit) {
  return unit ? String(unit).replace(/_/g, " ") : "";
}

function plainNumber(n) {
  return n >= 100 ? Math.round(n).toString() : n.toFixed(n < 1 ? 3 : 2).replace(/\.?0+$/, "");
}

// Below ½ tsp the spoon set's ⅛ step matters; above it, quarters.
function roundTeaspoons(tsp, mode) {
  const steps = tsp < 0.5 ? 8 : 4;
  const scaled = tsp * steps;
  const whole = mode === "up" ? Math.ceil(scaled - 1e-9) : mode === "down" ? Math.floor(scaled + 1e-9) : Math.round(scaled);
  return whole / steps;
}

function teaspoonText(tsp) {
  const eighths = Math.round(tsp * 8);
  const whole = Math.floor(eighths / 8);
  return `${whole === 0 ? "" : whole}${FRACTIONS[eighths % 8]} tsp`;
}

function asFlOz(amount, normalized) {
  if (FL_OZ_UNITS.has(normalized)) return amount;
  if (ML_UNITS.has(normalized)) return amount * FL_OZ_PER_ML;
  if (L_UNITS.has(normalized)) return amount * FL_OZ_PER_L;
  return null;
}

function liquidText(flOz, mode) {
  if (flOz <= 0) return "0 fl oz";
  if (flOz >= 1) return `${plainNumber(flOz)} fl oz`;
  const tsp = roundTeaspoons(flOz * TSP_PER_FL_OZ, mode);
  if (tsp <= 0) return mode === "up" ? "⅛ tsp" : "under ⅛ tsp";
  return teaspoonText(tsp);
}

/**
 * One mix amount. `round` only matters for the teaspoon step: "nearest" for a
 * single planned amount, "up" / "down" for the ends of a label range.
 */
export function formatMeasuredAmount(amount, unit, { round = "nearest" } = {}) {
  if (amount == null || amount === "") return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  const normalized = normalizeUnit(unit);
  const flOz = asFlOz(n, normalized);
  if (flOz != null) return liquidText(flOz, round);
  if (normalized === "oz" && n > 0 && n < 1) return `${(n * G_PER_OZ).toFixed(1).replace(/\.0$/, "")} g`;
  const u = displayUnit(unit);
  return `${plainNumber(n)}${u ? ` ${u}` : ""}`;
}

/**
 * A label-rate range, low to high. Teaspoon ends round inward so the shown
 * range never leaves the label's; a range reaching 1 fl oz, or one too narrow
 * for any spoon step to fit inside it, stays in fl oz end to end; ends that
 * land on the same measure collapse to one amount.
 */
export function formatMeasuredRange(low, high, unit) {
  if (high == null) return formatMeasuredAmount(low, unit);
  const normalized = normalizeUnit(unit);
  const lowFlOz = asFlOz(Number(low), normalized);
  const highFlOz = asFlOz(Number(high), normalized);
  if (lowFlOz != null && highFlOz != null && lowFlOz > 0) {
    const flOzRange = `${plainNumber(lowFlOz)} fl oz – ${plainNumber(highFlOz)} fl oz`;
    if (highFlOz >= 1) return flOzRange;
    const upTsp = roundTeaspoons(lowFlOz * TSP_PER_FL_OZ, "up");
    const downTsp = roundTeaspoons(highFlOz * TSP_PER_FL_OZ, "down");
    if (downTsp < upTsp) return flOzRange;
    if (downTsp === upTsp) return teaspoonText(upTsp);
    return `${teaspoonText(upTsp)} – ${teaspoonText(downTsp)}`;
  }
  const lowText = formatMeasuredAmount(low, unit);
  const highText = formatMeasuredAmount(high, unit);
  if (lowText == null || highText == null) return lowText || highText;
  return lowText === highText ? lowText : `${lowText} – ${highText}`;
}
