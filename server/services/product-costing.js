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
function isWeightOrVolumeUnit(u) {
  return u === 'oz' || u === 'ounce' || WEIGHT_TO_GRAM[u] != null || VOLUME_TO_ML[u] != null;
}

// Resolve a unit from one or two leading words ("oz", "fl oz"), tolerating a
// trailing packaging descriptor ("lb pail" -> "lb"). Returns a normalized key
// or null.
function resolveUnitToken(text) {
  const words = String(text || '').trim().split(/\s+/);
  if (!words[0]) return null;
  const oneWord = normalizeUnit(words[0]);
  if (isWeightOrVolumeUnit(oneWord)) return oneWord;
  const twoWord = words[1] ? normalizeUnit(`${words[0]} ${words[1]}`) : null;
  if (twoWord && isWeightOrVolumeUnit(twoWord)) return twoWord;
  return null;
}

// Parse a pack-size string into { amount, unit } in one weight/volume unit,
// tolerating packaging descriptors ("18 lb pail", "21 oz can"), multi-word units
// ("32 fl oz"), simple fractions ("1/2 gal"), and pack multipliers
// ("4 x 30g tubes", "4 tubes / 30 g"). Returns null for count-based / unknown
// packs (bait stations, traps) and for fractions we can't read.
function parsePackSize(quantity) {
  const raw = String(quantity || '').toLowerCase().trim();
  if (!raw) return null;

  // Simple fraction: "1/2 gal", "3/4 lb". Resolve before pair-scanning, which
  // would otherwise mistake the denominator for the amount.
  const frac = raw.match(/^([\d.]+)\s*\/\s*([\d.]+)\s*([a-z].*)$/);
  if (frac) {
    const num = Number(frac[1]);
    const den = Number(frac[2]);
    const unit = resolveUnitToken(frac[3]);
    if (unit && num > 0 && den > 0) return { amount: num / den, unit };
    return null;
  }

  // First "<number> <known unit>" pair, skipping descriptors and leading counts.
  let amount = null;
  let unit = null;
  const pairRe = /([\d.]+)\s*([a-z]+(?:\s+[a-z]+)*)?/g;
  let m;
  while ((m = pairRe.exec(raw)) !== null) {
    if (!m[2]) continue;
    const u = resolveUnitToken(m[2]);
    if (u) { amount = Number(m[1]); unit = u; break; }
  }
  if (amount == null || !Number.isFinite(amount) || amount <= 0) return null;

  // Leading pack count: "4 x 30g" or "4 tubes / 30 g" multiplies the matched size.
  const mult = raw.match(/^\s*([\d.]+)\s*x\s*[\d.]/)
    || raw.match(/^\s*([\d.]+)\s+[a-z]+\s*\/\s*[\d.]/);
  const count = mult && Number(mult[1]) > 0 ? Number(mult[1]) : 1;

  return { amount: amount * count, unit };
}

// Measurement family of a unit. Plain "oz"/"ounce" is dimensionally ambiguous
// (dry weight vs fluid ounce); only call it volume on a positive liquid signal,
// never assume weight — return 'ambiguous' so callers show a single $/oz.
function unitFamily(unit, opts = {}) {
  if (!unit) return null;
  if (unit === 'oz' || unit === 'ounce') return opts.isLiquid ? 'volume' : 'ambiguous';
  if (WEIGHT_TO_GRAM[unit] != null) return 'weight';
  if (VOLUME_TO_ML[unit] != null) return 'volume';
  return null;
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

// Expand an authoritative $/oz-equivalent price across its family's display
// units. 'ambiguous' (plain oz) stays a single $/oz — no dry/fluid claim.
function expandUnitPrice(perOz, family) {
  if (!Number.isFinite(perOz) || perOz <= 0) return null;
  if (family === 'weight') {
    return [
      { unit: 'g', pricePerUnit: round6(perOz / 28.3495) },
      { unit: 'oz', pricePerUnit: round6(perOz) },
      { unit: 'lb', pricePerUnit: round6(perOz * 16) },
    ];
  }
  if (family === 'volume') {
    return [
      { unit: 'fl-oz', pricePerUnit: round6(perOz) },
      { unit: 'qt', pricePerUnit: round6(perOz * 32) },
      { unit: 'gal', pricePerUnit: round6(perOz * 128) },
    ];
  }
  if (family === 'ambiguous') return [{ unit: 'oz', pricePerUnit: round6(perOz) }];
  return null;
}

// Given a pack price + a size string ("4 lb", "1 gal", "32 oz"), return the
// price expressed per unit across the matching measurement family.
// opts.referencePerOz: an authoritative pipeline $/oz price — if the pack-size-
// derived value disagrees with it (e.g. an approved price update left a stale
// quantity in place), return null so callers fall back to the trusted value.
function unitPriceBreakdown(price, quantity, opts = {}) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return null;
  const parsed = parsePackSize(quantity);
  if (!parsed) return null;
  const family = unitFamily(parsed.unit, opts);
  if (!family) return null;
  const totalOz = convertToOz(parsed.amount, parsed.unit);
  if (!(totalOz > 0)) return null;
  const perOz = p / totalOz; // $ per oz-equivalent, matching the pipeline's basis

  const ref = Number(opts.referencePerOz);
  if (Number.isFinite(ref) && ref > 0 && Math.abs(perOz - ref) / ref > 0.1) return null;

  const units = expandUnitPrice(perOz, family);
  return units ? { family, units } : null;
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
