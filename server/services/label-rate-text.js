// A catalog label rate as a tech reads it (owner ruling 2026-09-27; every
// service 2026-09-29): nothing a tech reads is in mL. The catalog keeps the
// label's own figure ("5-10" ml/gal, "1-6" ml/inch dbh); the tech assistant
// and the knowledge base read it converted to truck measures: tsp (¼ steps,
// ⅛ only when no ¼ fits) while the figure stays under 1 fl oz, fl oz (¼
// steps) once it reaches 1 fl oz. A range rounds inward (low end up, high
// end down) so the amount never leaves the label range. A single amount
// rounds down, and reads as a step only when that step is at most 5% under
// it, the job card's spoon rule (client/src/lib/mix-amount.js), so a step
// never states a smaller dose as the label's. A figure no step fits has no
// rate here, and the assistant sends the tech to the label. Any other unit
// reads exactly as the catalog states it. Container sizes ("250 ml") are how
// a product is sold, not an application amount, and are not rates.
const { baseQuantityUnit, normalizeInventoryUnit } = require('./inventory-units');

// The job card's factors (client/src/lib/mix-amount.js), exact: a rounded
// conversion can merge two close range ends into one amount.
const ML_PER_FL_OZ = 29.5735;
const TSP_PER_FL_OZ = 6;
const SINGLE_TOLERANCE = 0.05;
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

// A single amount in the first step that measures it: rounded down, at most
// 5% under. null when no step does.
function measuredAmount(amount, steps) {
  for (const step of steps) {
    const down = roundDown(amount, step);
    if (down > 0 && amount - down <= amount * SINGLE_TOLERANCE) return stepText(down);
  }
  return null;
}

// A range in the first step that fits inside it, rounded inward. null when
// no step does.
function measuredRange(low, high, steps) {
  for (const step of steps) {
    const lo = roundUp(low, step);
    const hi = roundDown(high, step);
    if (lo > 0 && lo <= hi) return lo === hi ? stepText(lo) : `${stepText(lo)}–${stepText(hi)}`;
  }
  return null;
}

/**
 * { rate, unit } to show a tech for a catalog label rate. A label in mL comes
 * back in tsp or fl oz ("1¼–2", "tsp/gal"); an mL label whose figure cannot
 * be read, or that no spoon or cup step measures, comes back empty rather
 * than in mL; any other unit is unchanged.
 */
function techLabelRate(defaultRate, defaultUnit) {
  if (!isMlUnit(defaultUnit)) return { rate: defaultRate, unit: defaultUnit };
  const bounds = String(defaultRate ?? '').split(/\s*(?:-|–|to)\s*/).map(Number);
  if (bounds.length > 2 || bounds.some((n) => !(n > 0))) return { rate: null, unit: null };
  const [low, high = low] = bounds.sort((a, b) => a - b).map((ml) => ml / ML_PER_FL_OZ);
  const inSpoons = high < 1;
  const scale = inSpoons ? TSP_PER_FL_OZ : 1;
  const steps = inSpoons ? TSP_STEPS : FL_OZ_STEPS;
  const rate = low === high
    ? measuredAmount(low * scale, steps)
    : measuredRange(low * scale, high * scale, steps);
  if (!rate) return { rate: null, unit: null };
  const basis = String(defaultUnit).includes('/') ? `/${String(defaultUnit).split('/').slice(1).join('/').trim()}` : '';
  return { rate, unit: `${inSpoons ? 'tsp' : 'fl oz'}${basis}` };
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
