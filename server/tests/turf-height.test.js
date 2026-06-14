const {
  ALLOWED_HEIGHTS_IN,
  isAllowedHeight,
  resolveHeightBand,
  mowTriggerInches,
  computeRangeStatus,
  buildReadingFields,
} = require('../services/service-report/turf-height');

describe('turf-height: allowed gauge increments', () => {
  test('accepts only the Turfchek II stops', () => {
    expect(isAllowedHeight(0.5)).toBe(true);
    expect(isAllowedHeight(2.25)).toBe(true);  // 1/4" zone
    expect(isAllowedHeight(3.5)).toBe(true);   // 1/2" zone
    expect(isAllowedHeight(5.5)).toBe(true);
  });
  test('rejects off-grid values + the gaps above 2.5"', () => {
    expect(isAllowedHeight(2.75)).toBe(false); // 1/4" steps stop at 2.5"
    expect(isAllowedHeight(3.25)).toBe(false);
    expect(isAllowedHeight(4.2)).toBe(false);
    expect(isAllowedHeight(0)).toBe(false);
    expect(isAllowedHeight('x')).toBe(false);
    expect(isAllowedHeight(null)).toBe(false);
  });
  test('the set is exactly the gauge spec', () => {
    expect(ALLOWED_HEIGHTS_IN).toEqual([0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5]);
  });
});

describe('turf-height: band resolution (canonical keys only)', () => {
  test('resolves each canonical grass type', () => {
    expect(resolveHeightBand('st_augustine')).toEqual({ min: 3.5, max: 4.0, defaulted: false });
    expect(resolveHeightBand('bahia')).toEqual({ min: 3.0, max: 4.0, defaulted: false });
    expect(resolveHeightBand('bermuda')).toEqual({ min: 1.0, max: 2.0, defaulted: false });
    expect(resolveHeightBand('zoysia')).toEqual({ min: 1.5, max: 2.0, defaulted: false });
  });
  test('normalizes spacing/case/cultivar text to the canonical key', () => {
    expect(resolveHeightBand('St. Augustine')).toMatchObject({ min: 3.5, max: 4.0, defaulted: false });
  });
  test('mixed / unknown / missing → St. Augustine band, flagged defaulted', () => {
    for (const g of ['mixed', 'unknown', null, '', 'centipede']) {
      expect(resolveHeightBand(g)).toEqual({ min: 3.5, max: 4.0, defaulted: true });
    }
  });
});

describe('turf-height: range status (below is the only red state)', () => {
  const stAug = { min: 3.5, max: 4.0 };
  test('classifies below / in_range / above against the maintained band', () => {
    expect(computeRangeStatus(3.0, stAug)).toBe('below');   // scalped
    expect(computeRangeStatus(3.5, stAug)).toBe('in_range'); // lower edge
    expect(computeRangeStatus(4.0, stAug)).toBe('in_range'); // upper edge
    expect(computeRangeStatus(5.0, stAug)).toBe('above');    // overgrown
  });
  test('null-safe', () => {
    expect(computeRangeStatus(null, stAug)).toBeNull();
    expect(computeRangeStatus(4, null)).toBeNull();
  });
});

describe('turf-height: buildReadingFields (snapshot assembly)', () => {
  test('snapshots the band + computes status for a valid reading', () => {
    expect(buildReadingFields('st_augustine', 3.0)).toEqual({
      target_min_in: 3.5, target_max_in: 4.0, range_status: 'below', grass_defaulted: false,
    });
    expect(buildReadingFields('zoysia', 2.0)).toEqual({
      target_min_in: 1.5, target_max_in: 2.0, range_status: 'in_range', grass_defaulted: false,
    });
  });
  test('mixed/unknown grass → defaulted band, flagged', () => {
    expect(buildReadingFields('mixed', 4.5)).toEqual({
      target_min_in: 3.5, target_max_in: 4.0, range_status: 'above', grass_defaulted: true,
    });
  });
  test('throws invalid_increment on an off-gauge value (service-layer guard)', () => {
    expect(() => buildReadingFields('st_augustine', 3.75)).toThrow(/must be one of/);
    try { buildReadingFields('st_augustine', 3.75); } catch (e) { expect(e.code).toBe('invalid_increment'); }
  });
});

describe('turf-height: 1/3-rule mow trigger (derived, not the status basis)', () => {
  test('trigger = band.max × 1.5, rounded to 1/4"', () => {
    expect(mowTriggerInches({ min: 3.5, max: 4.0 })).toBe(6.0);  // St. Augustine
    expect(mowTriggerInches({ min: 3.0, max: 4.0 })).toBe(6.0);  // Bahia
    expect(mowTriggerInches({ min: 1.0, max: 2.0 })).toBe(3.0);  // Bermuda
    expect(mowTriggerInches({ min: 1.5, max: 2.0 })).toBe(3.0);  // Zoysia
  });
  test('null-safe', () => {
    expect(mowTriggerInches(null)).toBeNull();
    expect(mowTriggerInches({})).toBeNull();
  });
});
