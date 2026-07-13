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
});
