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
  usageAmountForArea,
};
