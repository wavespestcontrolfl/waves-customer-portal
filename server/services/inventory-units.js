function normalizeInventoryUnit(unit) {
  return String(unit || '').trim().toLowerCase().replace(/\s+/g, '_').replace(/s$/, '');
}

// A per-basis unit is a rate, not a quantity: "/gal" mix concentrations
// (oz/gal), and the label-native bases the rate-render backfill added
// (g/spot, fl_oz/100gal, ml/inch dbh, each/station, …). An amount recorded
// against one is the amount of PRODUCT in the base unit, so strip the basis
// suffix so inventory deduction and the compliance quantity run on a
// convertible base unit. "/1000sf" units are the one exception: bare
// per-1,000 handling is a catalog-wide preexisting convention and they pass
// through unchanged, as before.
function baseQuantityUnit(unit) {
  const raw = String(unit || '').trim();
  const slash = raw.indexOf('/');
  if (slash <= 0 || raw.toLowerCase().endsWith('/1000sf')) return unit;
  return raw.slice(0, slash);
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
  // Count-based stock (bait stations, briquets, dunks, blox, cartridges —
  // the each/* label bases): a discrete item count, its own dimension.
  // Deliberately NO cross-dimension conversion: item weight/volume varies
  // per product and inventing a per-item factor here would fabricate
  // deduction quantities — count stock must be kept in 'each'.
  each: { dimension: 'count', factor: 1 },
};

function unitDefinition(unit) {
  return INVENTORY_UNITS[normalizeInventoryUnit(unit)] || null;
}

// Rate-unit vocabulary accepted on application records — the single
// allowlist shared by the /complete route and the pest recap (codex P1
// r11): both closeout paths must reject unknown units before they reach
// service_products and the FDACS ledger.
const VALID_RATE_UNITS = new Set([
  'oz', 'fl_oz', 'ml', 'g', 'lb', 'gal', 'each',
  'oz/gal', 'fl_oz/gal', 'g/gal', 'ml/gal', 'lb/gal', 'gal/gal',
  'oz/1000sf', 'lb/1000sf', 'g/1000sf',
  // Label-native per-basis units carried in products_catalog default_unit
  // (rate-render backfill): gel spot placements, 100-gal dilutions,
  // trunk-injection doses, per-acre broadcast, ornamental-bed rates, and
  // station/placement densities.
  'g/spot', 'fl_oz/100gal', 'oz/100gal',
  'ml/inch dbh', 'g/inch dbh', 'ml/palm',
  'oz/acre', 'fl_oz/acre', 'lb/acre', 'gal/acre',
  'lb/100sf', 'each/100sf', 'each/acre', 'fl_oz/50ft',
  'each/20ft', 'each/station', 'each/placement',
]);

function isValidRateUnit(unit) {
  return VALID_RATE_UNITS.has(String(unit || '').trim().toLowerCase());
}

function conversionBasis(fromDef, toDef) {
  if (!fromDef || !toDef) return null;
  // Ambiguous 'oz' can only stand in for a measured dimension — never for
  // a count ('oz' of bait stations is not a number of stations).
  const measurable = (dim) => dim === 'volume' || dim === 'weight';
  if (fromDef.dimension === 'ambiguous' && !measurable(toDef.dimension)) return null;
  if (toDef.dimension === 'ambiguous' && !measurable(fromDef.dimension)) return null;
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
  VALID_RATE_UNITS,
  isValidRateUnit,
  baseQuantityUnit,
  convertInventoryQuantity,
  describeInventoryConversion,
  normalizeInventoryUnit,
  unitDefinition,
};
