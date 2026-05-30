function normalizeInventoryUnit(unit) {
  return String(unit || '').trim().toLowerCase().replace(/\s+/g, '_').replace(/s$/, '');
}

const INVENTORY_UNITS = {
  fl_oz: { dimension: 'volume', factor: 1 },
  floz: { dimension: 'volume', factor: 1 },
  gal: { dimension: 'volume', factor: 128 },
  gallon: { dimension: 'volume', factor: 128 },
  qt: { dimension: 'volume', factor: 32 },
  quart: { dimension: 'volume', factor: 32 },
  pt: { dimension: 'volume', factor: 16 },
  pint: { dimension: 'volume', factor: 16 },
  ml: { dimension: 'volume', factor: 0.033814 },
  l: { dimension: 'volume', factor: 33.814 },
  liter: { dimension: 'volume', factor: 33.814 },
  oz: { dimension: 'ambiguous', factor: 1 },
  ounce: { dimension: 'ambiguous', factor: 1 },
  lb: { dimension: 'weight', factor: 16 },
  pound: { dimension: 'weight', factor: 16 },
  g: { dimension: 'weight', factor: 0.035274 },
  gram: { dimension: 'weight', factor: 0.035274 },
  kg: { dimension: 'weight', factor: 35.274 },
};

function unitDefinition(unit) {
  return INVENTORY_UNITS[normalizeInventoryUnit(unit)] || null;
}

function conversionBasis(fromDef, toDef) {
  if (!fromDef || !toDef) return null;
  const fromDimension = fromDef.dimension === 'ambiguous' ? toDef.dimension : fromDef.dimension;
  const toDimension = toDef.dimension === 'ambiguous' ? fromDef.dimension : toDef.dimension;
  if (!fromDimension || !toDimension || fromDimension !== toDimension) return null;
  if (fromDef.dimension === 'ambiguous' || toDef.dimension === 'ambiguous') return 'ambiguous_oz_dimension';
  return 'dimension';
}

function convertInventoryQuantity(amount, fromUnit, toUnit) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  const from = normalizeInventoryUnit(fromUnit);
  const to = normalizeInventoryUnit(toUnit);
  if (!from || !to) return null;
  if (from === to) return n;
  const fromDef = unitDefinition(from);
  const toDef = unitDefinition(to);
  if (!conversionBasis(fromDef, toDef)) return null;
  return Number(((n * fromDef.factor) / toDef.factor).toFixed(4));
}

function describeInventoryConversion(amount, fromUnit, toUnit) {
  const from = normalizeInventoryUnit(fromUnit);
  const to = normalizeInventoryUnit(toUnit);
  if (!from || !to) {
    return { convertible: false, confidence: 'needs_review', reason: 'missing_unit', amount: null, unit: toUnit || null };
  }
  if (from === to) {
    const n = Number(amount);
    return {
      convertible: Number.isFinite(n) && n > 0,
      confidence: 'exact_unit',
      reason: null,
      amount: Number.isFinite(n) && n > 0 ? n : null,
      unit: toUnit,
    };
  }
  const fromDef = unitDefinition(from);
  const toDef = unitDefinition(to);
  const basis = conversionBasis(fromDef, toDef);
  const converted = basis ? convertInventoryQuantity(amount, fromUnit, toUnit) : null;
  return {
    convertible: converted != null,
    confidence: converted == null ? 'needs_review' : basis === 'ambiguous_oz_dimension' ? 'converted_ambiguous_oz' : 'converted',
    reason: converted == null ? 'unsupported_unit_conversion' : null,
    amount: converted,
    unit: toUnit,
    fromUnit,
    toUnit,
  };
}

module.exports = {
  INVENTORY_UNITS,
  convertInventoryQuantity,
  describeInventoryConversion,
  normalizeInventoryUnit,
  unitDefinition,
};
