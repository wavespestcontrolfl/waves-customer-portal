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

// A range end moves inward ("up" for the low end, "down" for the high end):
// below ½ tsp the spoon set's ⅛ step matters; above it, quarters.
function roundTeaspoons(tsp, mode, steps = tsp < 0.5 ? 8 : 4) {
  const scaled = tsp * steps;
  return (mode === "up" ? Math.ceil(scaled - 1e-9) : Math.floor(scaled + 1e-9)) / steps;
}

function measureText(amount, unit) {
  const eighths = Math.round(amount * 8);
  const whole = Math.floor(eighths / 8);
  return `${whole === 0 ? "" : whole}${FRACTIONS[eighths % 8]} ${unit}`;
}

function asFlOz(amount, normalized) {
  if (FL_OZ_UNITS.has(normalized)) return amount;
  if (ML_UNITS.has(normalized)) return amount * FL_OZ_PER_ML;
  if (L_UNITS.has(normalized)) return amount * FL_OZ_PER_L;
  return null;
}

// A single prescribed dose reads as spoons only when an eighth-teaspoon step
// measures it: at or below the dose, never more than 5% under. Otherwise the
// exact fl oz stands, so the spoon never over- or under-states the dose.
const SPOON_TOLERANCE = 0.05;
function liquidText(flOz) {
  const precise = `${plainNumber(flOz)} fl oz`;
  // A shortage (on hand below zero) keeps its signed deficit.
  if (flOz <= 0 || flOz >= 1) return precise;
  const exact = flOz * TSP_PER_FL_OZ;
  const tsp = Math.floor(exact * 8 + 1e-9) / 8;
  return tsp > 0 && (exact - tsp) / exact <= SPOON_TOLERANCE ? measureText(tsp, 'tsp') : precise;
}

/** One mix amount: a prescribed dose, an on-hand quantity, or a per-area rate. */
export function formatMeasuredAmount(amount, unit, { truckMeasures = false } = {}) {
  if (amount == null || amount === "") return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  const normalized = normalizeUnit(unit);
  const flOz = asFlOz(n, normalized);
  if (truckMeasures && flOz >= 1) {
    const rounded = Math.floor(flOz * 4 + 1e-9) / 4;
    return `${rounded < flOz - 1e-9 ? '≈ ' : ''}${measureText(rounded, 'fl oz')}`;
  }
  if (flOz != null) return liquidText(flOz);
  if (normalized === "oz" && n > 0 && n < 1) return `${(n * G_PER_OZ).toFixed(1).replace(/\.0$/, "")} g`;
  const u = displayUnit(unit);
  return `${plainNumber(n)}${u ? ` ${u}` : ""}`;
}

/**
 * A label's own rate as a reference line: numbers stay exact (it is not a
 * measure), and a rate stored in mL or liters reads in fl oz instead.
 */
export function formatLabelRate(low, high, unit) {
  const normalized = normalizeUnit(unit);
  const converted = ML_UNITS.has(normalized) || L_UNITS.has(normalized);
  const show = (value) => (converted ? plainNumber(asFlOz(Number(value), normalized)) : String(value));
  const span = high != null && Number(high) > Number(low) ? `${show(low)}–${show(high)}` : show(low);
  const u = converted ? "fl oz" : displayUnit(unit);
  return `${span}${u ? ` ${u}` : ""}`;
}

/**
 * A label-rate range, low to high. Teaspoon ends round inward so the shown
 * range never leaves the label's; a range reaching 1 fl oz, or one too narrow
 * for any spoon step to fit inside it, stays in fl oz end to end; ends that
 * land on the same measure collapse to one amount.
 */
export function formatMeasuredRange(low, high, unit, { truckMeasures = false } = {}) {
  if (high == null) return formatMeasuredAmount(low, unit, { truckMeasures });
  const normalized = normalizeUnit(unit);
  const lowFlOz = asFlOz(Number(low), normalized);
  const highFlOz = asFlOz(Number(high), normalized);
  if (lowFlOz > 0 && highFlOz != null) {
    const flOzRange = `${plainNumber(lowFlOz)} fl oz – ${plainNumber(highFlOz)} fl oz`;
    if (truckMeasures) {
      const [measureUnit, multiplier] = highFlOz < 1 ? ['tsp', TSP_PER_FL_OZ] : ['fl oz', 1];
      const min = lowFlOz * multiplier, max = highFlOz * multiplier;
      // Quarter measures first; an eighth teaspoon only when no quarter fits.
      const steps = measureUnit === 'tsp' && roundTeaspoons(min, 'up', 4) > roundTeaspoons(max, 'down', 4) ? 8 : 4;
      const from = roundTeaspoons(min, 'up', steps), to = roundTeaspoons(max, 'down', steps);
      if (from > 0 && from <= to) return from === to ? measureText(from, measureUnit) : `${measureText(from, measureUnit)} – ${measureText(to, measureUnit)}`;
      // No available measure fits: retain the exact bounds, never a midpoint.
      return flOzRange;
    }
    if (highFlOz >= 1) return flOzRange;
    const upTsp = roundTeaspoons(lowFlOz * TSP_PER_FL_OZ, "up");
    const downTsp = roundTeaspoons(highFlOz * TSP_PER_FL_OZ, "down");
    if (downTsp < upTsp) return flOzRange;
    if (downTsp === upTsp) return measureText(upTsp, 'tsp');
    return `${measureText(upTsp, 'tsp')} – ${measureText(downTsp, 'tsp')}`;
  }
  const lowText = formatMeasuredAmount(low, unit);
  const highText = formatMeasuredAmount(high, unit);
  if (lowText == null || highText == null) return lowText || highText;
  return lowText === highText ? lowText : `${lowText} – ${highText}`;
}
