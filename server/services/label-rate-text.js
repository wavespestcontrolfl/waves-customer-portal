// A catalog label rate as a tech reads it (owner ruling 2026-09-27; every
// service 2026-09-29): nothing a tech reads is in mL. The catalog keeps the
// label's own figure ("5-10" ml/gal, "1-6" ml/inch dbh); the tech assistant
// and the knowledge base read it converted to truck measures: tsp (¼ steps,
// ⅛ only when no ¼ fits) while the range stays under 1 fl oz, fl oz (¼
// steps) once it reaches 1 fl oz, the low end rounded up and the high end
// down so the amount never leaves the label range; a single amount rounds
// down. The conversion is inventory-units.js'. Any other
// unit reads exactly as the catalog states it. Container sizes ("250 ml")
// are how a product is sold, not an application amount, and are not rates.
const { baseQuantityUnit, convertInventoryQuantity, normalizeInventoryUnit } = require('./inventory-units');

const TSP_PER_FL_OZ = 6;
const EIGHTHS = ['', '⅛', '¼', '⅜', '½', '⅝', '¾', '⅞'];
// Spoons step by ¼, and by ⅛ only when no ¼ fits; the ounce cup steps by ¼.
const TSP_STEPS = [0.25, 0.125];
const FL_OZ_STEPS = [0.25];

const isMlUnit = (unit) => normalizeInventoryUnit(baseQuantityUnit(unit)) === 'ml';

// 1.25 -> "1¼", 0.125 -> "⅛", 2 -> "2".
function stepText(n) {
  const eighths = Math.round(n * 8);
  const whole = Math.floor(eighths / 8);
  const fraction = EIGHTHS[eighths % 8];
  return whole ? `${whole}${fraction}` : fraction || '0';
}

const roundUp = (n, step) => Math.ceil(n / step - 1e-9) * step;
const roundDown = (n, step) => Math.floor(n / step + 1e-9) * step;
const exact = (n) => String(Math.round(n * 100) / 100);

// An amount or range in one measure: the range rounded inward (low end up,
// high end down), a single amount rounded down, in the first step that fits;
// exact to 2 decimals when none does.
function measuredRange(low, high, steps) {
  for (const step of steps) {
    if (low === high) {
      const down = roundDown(low, step);
      if (down > 0) return stepText(down);
      continue;
    }
    const lo = roundUp(low, step);
    const hi = roundDown(high, step);
    if (lo > 0 && lo <= hi) return lo === hi ? stepText(lo) : `${stepText(lo)}–${stepText(hi)}`;
  }
  return low === high ? exact(low) : `${exact(low)}–${exact(high)}`;
}

/**
 * { rate, unit } to show a tech for a catalog label rate. A label in mL comes
 * back in tsp or fl oz ("1¼–2", "tsp/gal"); an mL label whose figure cannot be
 * read comes back empty rather than in mL; any other unit is unchanged.
 */
function techLabelRate(defaultRate, defaultUnit) {
  if (!isMlUnit(defaultUnit)) return { rate: defaultRate, unit: defaultUnit };
  const bounds = String(defaultRate ?? '').split(/\s*(?:-|–|to)\s*/).map(Number);
  if (!bounds.length || bounds.length > 2 || bounds.some((n) => !(n > 0))) return { rate: null, unit: null };
  const [low, high = low] = bounds.map((ml) => convertInventoryQuantity(ml, 'ml', 'fl_oz'));
  const basis = String(defaultUnit).includes('/') ? `/${String(defaultUnit).split('/').slice(1).join('/').trim()}` : '';
  if (high < 1) {
    return { rate: measuredRange(low * TSP_PER_FL_OZ, high * TSP_PER_FL_OZ, TSP_STEPS), unit: `tsp${basis}` };
  }
  return { rate: measuredRange(low, high, FL_OZ_STEPS), unit: `fl oz${basis}` };
}

/**
 * The knowledge base's "Default Rate" text: `${rate} ${unit}`, as it always
 * read for non-mL units; '' (no line) when there is no rate to state.
 */
function techLabelRateText(defaultRate, defaultUnit) {
  if (!defaultRate) return '';
  const { rate, unit } = techLabelRate(defaultRate, defaultUnit);
  return rate ? `${rate} ${unit || ''}` : '';
}

module.exports = { techLabelRate, techLabelRateText, isMlUnit };
