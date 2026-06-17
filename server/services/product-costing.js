const UNIT_TO_OZ = {
  fl_oz: 1,
  'fl oz': 1,
  floz: 1,
  oz: 1,
  ounce: 1,
  gal: 128,
  gallon: 128,
  qt: 32,
  quart: 32,
  pt: 16,
  pint: 16,
  ml: 0.033814,
  l: 33.814,
  liter: 33.814,
  lb: 16,
  pound: 16,
  g: 0.035274,
  gram: 0.035274,
  kg: 35.274,
};

function normalizeUnit(unit) {
  return String(unit || '').trim().toLowerCase().replace(/\s+/g, '_').replace(/s$/, '');
}

function convertToOz(amount, unit) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  const normalized = normalizeUnit(unit);
  const factor = UNIT_TO_OZ[normalized] ?? UNIT_TO_OZ[String(unit || '').trim().toLowerCase()];
  return factor ? n * factor : null;
}

function normalizeQuantityToOz(quantity) {
  if (!quantity) return null;
  const match = String(quantity).toLowerCase().trim().match(/^([\d.]+)\s*(.*)/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const oz = convertToOz(amount, match[2]);
  return oz == null ? null : Math.round(oz * 100) / 100;
}

// Measurement families for the per-unit price breakdown. Weight and volume are
// kept dimensionally separate — we never convert grams <-> millilitres.
const WEIGHT_TO_GRAM = {
  g: 1, gram: 1, gm: 1, kg: 1000,
  oz: 28.3495, ounce: 28.3495, lb: 453.592, pound: 453.592,
};
const VOLUME_TO_ML = {
  ml: 1, milliliter: 1, millilitre: 1, cc: 1,
  l: 1000, liter: 1000, litre: 1000,
  fl_oz: 29.5735, floz: 29.5735,
  pt: 473.176, pint: 473.176, qt: 946.353, quart: 946.353,
  gal: 3785.41, gallon: 3785.41,
};
// Units to express each family in (sub-units per 1 display unit).
const WEIGHT_DISPLAY = [
  { unit: 'g', sub: 1 },
  { unit: 'oz', sub: 28.3495 },
  { unit: 'lb', sub: 453.592 },
];
const VOLUME_DISPLAY = [
  { unit: 'fl-oz', sub: 29.5735 },
  { unit: 'qt', sub: 946.353 },
  { unit: 'gal', sub: 3785.41 },
];

function isWeightOrVolumeUnit(u) {
  return u === 'oz' || u === 'ounce' || WEIGHT_TO_GRAM[u] != null || VOLUME_TO_ML[u] != null;
}

// Parse a pack-size string into { amount, unit } in one weight/volume unit,
// tolerating packaging descriptors ("18 lb pail", "21 oz can"), multi-word units
// ("32 fl oz"), and pack multipliers ("4 x 30g tubes", "4 tubes / 30 g").
// Returns null for count-based / unknown packs (bait stations, traps).
function parsePackSize(quantity) {
  const raw = String(quantity || '').toLowerCase().trim();
  if (!raw) return null;

  // First "<number> <known unit>" pair, skipping descriptors and leading counts.
  let amount = null;
  let unit = null;
  const pairRe = /([\d.]+)\s*([a-z]+(?:\s+[a-z]+)*)?/g;
  let m;
  while ((m = pairRe.exec(raw)) !== null) {
    if (!m[2]) continue;
    const words = m[2].trim().split(/\s+/);
    const oneWord = normalizeUnit(words[0]);
    const twoWord = words[1] ? normalizeUnit(`${words[0]} ${words[1]}`) : null;
    let u = null;
    if (isWeightOrVolumeUnit(oneWord)) u = oneWord;
    else if (twoWord && isWeightOrVolumeUnit(twoWord)) u = twoWord;
    if (u) { amount = Number(m[1]); unit = u; break; }
  }
  if (amount == null || !Number.isFinite(amount) || amount <= 0) return null;

  // Leading pack count: "4 x 30g" or "4 tubes / 30 g" multiplies the matched size.
  const mult = raw.match(/^\s*([\d.]+)\s*x\s*[\d.]/)
    || raw.match(/^\s*([\d.]+)\s+[a-z]+\s*\/\s*[\d.]/);
  const count = mult && Number(mult[1]) > 0 ? Number(mult[1]) : 1;

  return { amount: amount * count, unit };
}

// Given a pack price + a size string ("4 lb", "1 gal", "32 oz"), return the
// price expressed per unit across the matching measurement family. Plain "oz"
// is ambiguous — treated as weight unless the product is flagged liquid.
function unitPriceBreakdown(price, quantity, opts = {}) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return null;
  const parsed = parsePackSize(quantity);
  if (!parsed) return null;
  const { amount, unit } = parsed;

  let family;
  let totalBase; // grams or millilitres in the whole package
  let displaySet;
  if (unit === 'oz' || unit === 'ounce') {
    if (opts.isLiquid) {
      family = 'volume'; totalBase = amount * VOLUME_TO_ML.fl_oz; displaySet = VOLUME_DISPLAY;
    } else {
      family = 'weight'; totalBase = amount * WEIGHT_TO_GRAM.oz; displaySet = WEIGHT_DISPLAY;
    }
  } else if (WEIGHT_TO_GRAM[unit] != null) {
    family = 'weight'; totalBase = amount * WEIGHT_TO_GRAM[unit]; displaySet = WEIGHT_DISPLAY;
  } else if (VOLUME_TO_ML[unit] != null) {
    family = 'volume'; totalBase = amount * VOLUME_TO_ML[unit]; displaySet = VOLUME_DISPLAY;
  } else {
    return null; // count / unknown unit — no weight/volume breakdown
  }
  if (!(totalBase > 0)) return null;

  const perBase = p / totalBase; // $ per gram or per millilitre
  return {
    family,
    units: displaySet.map((d) => ({
      unit: d.unit,
      pricePerUnit: Math.round(perBase * d.sub * 1e6) / 1e6,
    })),
  };
}

function calcLandedCost(price, shipping, taxRate) {
  const p = Number(price) || 0;
  const s = Number(shipping) || 0;
  const t = Number(taxRate) || 0;
  return Math.round((p + s) * (1 + t) * 100) / 100;
}

function usageAmountForArea(row, areaSqFt = 0) {
  const baseAmount = Number(row.usage_amount || 0);
  const areaAmount = Number(row.usage_per_1000sf || 0) > 0 && Number(areaSqFt || 0) > 0
    ? (Number(row.usage_per_1000sf) * Number(areaSqFt)) / 1000
    : 0;
  const notes = String(row.notes || '');
  if (notes.includes('[usage:base_plus_per_1000]')) return baseAmount + areaAmount;
  if (notes.includes('[usage:max_base_or_per_1000]')) return Math.max(baseAmount, areaAmount);
  return areaAmount > 0 ? areaAmount : baseAmount;
}

function costLineFromUsage(row, areaSqFt = 0) {
  const usageAmount = usageAmountForArea(row, areaSqFt);
  if (!Number.isFinite(usageAmount) || usageAmount <= 0) {
    return { cost: 0, warning: `Missing usage amount for ${row.product_name}` };
  }

  const usageUnit = row.usage_unit;
  const costPerUnit = row.cost_per_unit != null ? Number(row.cost_per_unit) : null;
  if (costPerUnit != null && Number.isFinite(costPerUnit) && costPerUnit >= 0) {
    const costUnit = row.cost_unit || usageUnit;
    const usageOz = convertToOz(usageAmount, usageUnit);
    const costUnitOz = convertToOz(1, costUnit);
    const convertedUsage = usageOz != null && costUnitOz != null
      ? usageOz / costUnitOz
      : usageAmount;
    return {
      cost: convertedUsage * costPerUnit,
      source: 'cost_per_unit',
      usageAmount,
    };
  }

  const bestPrice = row.best_price != null ? Number(row.best_price) : null;
  const unitSizeOz = row.unit_size_oz != null ? Number(row.unit_size_oz) : null;
  const usageOz = convertToOz(usageAmount, usageUnit);
  if (
    bestPrice != null && Number.isFinite(bestPrice) && bestPrice >= 0
    && unitSizeOz != null && Number.isFinite(unitSizeOz) && unitSizeOz > 0
    && usageOz != null
  ) {
    return {
      cost: (usageOz / unitSizeOz) * bestPrice,
      source: 'best_price_unit_size',
      usageAmount,
    };
  }

  return {
    cost: 0,
    usageAmount,
    warning: `No normalized cost data for ${row.product_name}`,
  };
}

module.exports = {
  calcLandedCost,
  convertToOz,
  costLineFromUsage,
  normalizeQuantityToOz,
  normalizeUnit,
  unitPriceBreakdown,
  usageAmountForArea,
};
