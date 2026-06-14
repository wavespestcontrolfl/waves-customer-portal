const {
  MIN_HEIGHT_IN,
  MAX_HEIGHT_IN,
  isValidHeight,
  resolveHeightBand,
  mowTriggerInches,
  computeRangeStatus,
  buildReadingFields,
  buildMowingHeightContext,
} = require('../services/service-report/turf-height');

describe('turf-height: numeric range validation (free entry)', () => {
  test('accepts any reading within range, including off-stop values', () => {
    expect(isValidHeight(0.5)).toBe(true);
    expect(isValidHeight(3.7)).toBe(true);  // free numeric entry, not a preset stop
    expect(isValidHeight(4)).toBe(true);
    expect(isValidHeight(8.0)).toBe(true);
  });
  test('rejects out-of-range / non-numeric', () => {
    expect(isValidHeight(0.25)).toBe(false); // below min
    expect(isValidHeight(8.5)).toBe(false);  // above max
    expect(isValidHeight(0)).toBe(false);
    expect(isValidHeight('x')).toBe(false);
    expect(isValidHeight(null)).toBe(false);
  });
  test('range matches the DB CHECK bounds', () => {
    expect([MIN_HEIGHT_IN, MAX_HEIGHT_IN]).toEqual([0.5, 8.0]);
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
  test('accepts a free off-stop value (e.g. 3.7")', () => {
    expect(buildReadingFields('st_augustine', 3.7)).toEqual({
      target_min_in: 3.5, target_max_in: 4.0, range_status: 'in_range', grass_defaulted: false,
    });
  });
  test('throws invalid_height on an out-of-range value (service-layer guard)', () => {
    expect(() => buildReadingFields('st_augustine', 9)).toThrow(/between 0.5 and 8/);
    try { buildReadingFields('st_augustine', 0.2); } catch (e) { expect(e.code).toBe('invalid_height'); }
  });
});

describe('turf-height: buildMowingHeightContext (report/card payload)', () => {
  const reading = {
    manual_height_in: '5.0', target_min_in: '3.5', target_max_in: '4.0',
    range_status: 'above', grass_type: 'st_augustine', measured_at: '2026-06-12T10:00:00Z',
    verification_status: 'pending',
  };
  test('shapes the display payload from a reading row', () => {
    const ctx = buildMowingHeightContext(reading, []);
    expect(ctx).toMatchObject({
      heightIn: 5.0, unit: 'in', band: { min: 3.5, max: 4.0 }, bandLabel: '3.5–4″',
      status: 'above', mowTriggerIn: 6.0, grassType: 'st_augustine', verificationStatus: 'pending',
    });
  });
  test('maps + filters the trend rows', () => {
    const ctx = buildMowingHeightContext(reading, [
      { manual_height_in: '4.0', range_status: 'in_range', measured_at: 't1' },
      { manual_height_in: null, range_status: 'below', measured_at: 't2' }, // dropped
    ]);
    expect(ctx.trend).toEqual([{ heightIn: 4.0, status: 'in_range', measuredAt: 't1' }]);
  });
  test('null reading → null (surface hides the module)', () => {
    expect(buildMowingHeightContext(null)).toBeNull();
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
