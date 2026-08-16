const {
  baseQuantityUnit,
  convertInventoryQuantity,
} = require('../services/inventory-units');

describe('baseQuantityUnit', () => {
  test('strips the /gal dilution suffix to the base quantity unit', () => {
    expect(baseQuantityUnit('fl_oz/gal')).toBe('fl_oz');
    expect(baseQuantityUnit('g/gal')).toBe('g');
    expect(baseQuantityUnit('oz/gal')).toBe('oz');
  });

  test('leaves real quantity units untouched', () => {
    expect(baseQuantityUnit('fl_oz')).toBe('fl_oz');
    expect(baseQuantityUnit('g')).toBe('g');
    expect(baseQuantityUnit('lb')).toBe('lb');
    expect(baseQuantityUnit('gal')).toBe('gal');
    expect(baseQuantityUnit('oz/1000sf')).toBe('oz/1000sf');
  });

  // The label-native per-basis units the rate-render backfill added are
  // rates too — an amount falling back to one of them (caller omitted
  // amountUnit) must normalize to its base unit or inventory is silently
  // never deducted and the compliance quantity carries a rate unit.
  test('strips the label-native per-basis suffixes to the base quantity unit', () => {
    expect(baseQuantityUnit('g/spot')).toBe('g');
    expect(baseQuantityUnit('fl_oz/100gal')).toBe('fl_oz');
    expect(baseQuantityUnit('oz/100gal')).toBe('oz');
    expect(baseQuantityUnit('ml/inch dbh')).toBe('ml');
    expect(baseQuantityUnit('ml/palm')).toBe('ml');
    expect(baseQuantityUnit('lb/acre')).toBe('lb');
    expect(baseQuantityUnit('lb/100sf')).toBe('lb');
    expect(baseQuantityUnit('each/station')).toBe('each');
    expect(baseQuantityUnit('each/placement')).toBe('each');
    expect(baseQuantityUnit('fl_oz/50ft')).toBe('fl_oz');
  });

  test('a per-basis fallback unit converts to the catalog inventory unit', () => {
    expect(convertInventoryQuantity(2, 'g/spot', 'g')).toBe(null);
    expect(convertInventoryQuantity(2, baseQuantityUnit('g/spot'), 'g')).toBe(2);
    expect(convertInventoryQuantity(5, baseQuantityUnit('fl_oz/100gal'), 'gal')).toBeCloseTo(0.0391, 3);
    expect(convertInventoryQuantity(10, baseQuantityUnit('each/placement'), 'each')).toBe(10);
  });

  test('passes through null/empty like the call sites expect', () => {
    expect(baseQuantityUnit(null)).toBe(null);
    expect(baseQuantityUnit('')).toBe('');
  });

  // The bug this guards against: a "/gal" concentration reaching
  // convertInventoryQuantity returns null, which silently skips stock
  // preflight and deduction. The base unit must convert.
  test('a /gal unit cannot convert, its base unit can', () => {
    expect(convertInventoryQuantity(4, 'fl_oz/gal', 'gal')).toBe(null);
    expect(convertInventoryQuantity(4, baseQuantityUnit('fl_oz/gal'), 'gal')).toBeCloseTo(0.0313, 3);
    expect(convertInventoryQuantity(10, baseQuantityUnit('g/gal'), 'g')).toBe(10);
  });

  // 'each' is a registered count unit (codex P1, PR #3419 r9): count-based
  // stock (stations, briquets, blox) can be configured through the
  // inventory API and deducts via the identity conversion. Count never
  // crosses into a measured dimension — item weight/volume varies per
  // product and a fabricated factor would corrupt deductions — and the
  // ambiguous 'oz' can only stand in for volume/weight, never a count.
  test('each is a count inventory unit; count never converts cross-dimension', () => {
    const { unitDefinition } = require('../services/inventory-units');
    expect(unitDefinition('each')).toEqual({ dimension: 'count', factor: 1 });
    expect(convertInventoryQuantity(3, 'each', 'each')).toBe(3);
    expect(convertInventoryQuantity(3, 'each', 'lb')).toBe(null);
    expect(convertInventoryQuantity(3, 'lb', 'each')).toBe(null);
    expect(convertInventoryQuantity(3, 'oz', 'each')).toBe(null);
    expect(convertInventoryQuantity(3, 'each', 'oz')).toBe(null);
  });
});
