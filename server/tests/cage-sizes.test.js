// The pool cage size policy (GATE_CAGE_TWO_SIZES, owner 2026-11-19): pure functions,
// no gate reads. Synthetic values only.
const {
  fourBandCageSize, twoSizeFromArea, fourToTwo, fourSizeOf, twoSizeOf, isHeldFourSize,
} = require('../services/property-lookup/cage-sizes');

describe('areas', () => {
  test('four bands at the edges', () => {
    const edges = [[299, 'SMALL'], [300, 'MEDIUM'], [600, 'MEDIUM'], [601, 'LARGE'], [900, 'LARGE'], [901, 'OVERSIZED'], [1000, 'OVERSIZED'], [1001, 'OVERSIZED']];
    for (const [sqft, size] of edges) expect(fourBandCageSize(sqft)).toBe(size);
  });

  test('two sizes at the edges: Medium up to 1,000, Large above', () => {
    const edges = [[299, 'MEDIUM'], [300, 'MEDIUM'], [600, 'MEDIUM'], [601, 'MEDIUM'], [900, 'MEDIUM'], [901, 'MEDIUM'], [1000, 'MEDIUM'], [1001, 'LARGE']];
    for (const [sqft, size] of edges) expect(twoSizeFromArea(sqft)).toBe(size);
  });

  test('an invalid or non-positive area is null in both; a numeric string counts', () => {
    for (const bad of [0, -5, NaN, Infinity, null, undefined, '', '  ', 'abc', {}, [], true]) {
      expect(fourBandCageSize(bad)).toBeNull();
      expect(twoSizeFromArea(bad)).toBeNull();
    }
    expect(fourBandCageSize('750')).toBe('LARGE');
    expect(twoSizeFromArea('1200')).toBe('LARGE');
  });
});

describe('fourToTwo', () => {
  test('Small, Medium and Large read Medium; Oversized reads Large; anything else is null', () => {
    expect(['SMALL', 'MEDIUM', 'LARGE', 'large', ' Medium '].map(fourToTwo)).toEqual(['MEDIUM', 'MEDIUM', 'MEDIUM', 'MEDIUM', 'MEDIUM']);
    expect(fourToTwo('OVERSIZED')).toBe('LARGE');
    expect(fourToTwo('oversized')).toBe('LARGE');
    for (const bad of ['NONE', '', null, undefined, 'HUGE', 3]) expect(fourToTwo(bad)).toBeNull();
  });
});

describe('fourSizeOf: area, then the legacy answer, then a four-size profile\'s own size', () => {
  test('the area beats every size word', () => {
    expect(fourSizeOf({ poolCageSqft: 750, poolCageSize: 'SMALL', poolCageLegacySize: 'MEDIUM' })).toBe('LARGE');
    expect(fourSizeOf({ poolCageSqft: 250, poolCageSize: 'LARGE' })).toBe('SMALL');
  });

  test('with no area, a valid legacy answer wins over the size word', () => {
    expect(fourSizeOf({ poolCageSize: 'MEDIUM', poolCageLegacySize: 'OVERSIZED' })).toBe('OVERSIZED');
    expect(fourSizeOf({ poolCageSize: 'LARGE', poolCageLegacySize: 'small' })).toBe('SMALL');
  });

  test('no legacy key: a four-size profile\'s own size counts', () => {
    expect(fourSizeOf({ poolCageSize: 'LARGE' })).toBe('LARGE');
    expect(fourSizeOf({ poolCageSize: 'oversized', poolCageSqft: 0 })).toBe('OVERSIZED');
  });

  test('a legacy key present but not a size (NONE, empty) means a two-size profile: its own size is not a four-size word', () => {
    expect(fourSizeOf({ poolCageSize: 'LARGE', poolCageLegacySize: 'NONE' })).toBeNull();
    expect(fourSizeOf({ poolCageSize: 'MEDIUM', poolCageLegacySize: undefined })).toBeNull();
  });

  test('nothing usable is null', () => {
    for (const profile of [null, undefined, {}, { poolCageSize: 'NONE' }, { poolCageSqft: -1 }]) expect(fourSizeOf(profile)).toBeNull();
  });
});

describe('twoSizeOf: area, then the four-size answer read as two, then a two-size profile\'s own size', () => {
  test('the area beats every size word, with Medium up to 1,000', () => {
    expect(twoSizeOf({ poolCageSqft: 1000, poolCageSize: 'LARGE', poolCageLegacySize: 'OVERSIZED' })).toBe('MEDIUM');
    expect(twoSizeOf({ poolCageSqft: 1001, poolCageSize: 'MEDIUM', poolCageLegacySize: 'MEDIUM' })).toBe('LARGE');
  });

  test('a four-size answer reads Small, Medium and Large as Medium and Oversized as Large', () => {
    expect(twoSizeOf({ poolCageLegacySize: 'SMALL', poolCageSize: 'MEDIUM' })).toBe('MEDIUM');
    expect(twoSizeOf({ poolCageLegacySize: 'LARGE', poolCageSize: 'MEDIUM' })).toBe('MEDIUM');
    expect(twoSizeOf({ poolCageLegacySize: 'OVERSIZED', poolCageSize: 'LARGE' })).toBe('LARGE');
    // A profile from before the flip (no legacy key) is a four-size profile.
    expect(twoSizeOf({ poolCageSize: 'SMALL' })).toBe('MEDIUM');
    expect(twoSizeOf({ poolCageSize: 'LARGE' })).toBe('MEDIUM');
    expect(twoSizeOf({ poolCageSize: 'OVERSIZED' })).toBe('LARGE');
  });

  test('a two-size profile with a legacy key that is not a size keeps its own Medium or Large', () => {
    expect(twoSizeOf({ poolCageSize: 'LARGE', poolCageLegacySize: 'NONE' })).toBe('LARGE');
    expect(twoSizeOf({ poolCageSize: 'medium', poolCageLegacySize: undefined })).toBe('MEDIUM');
    expect(twoSizeOf({ poolCageSize: 'SMALL', poolCageLegacySize: 'NONE' })).toBeNull();
  });

  test('nothing usable is null', () => {
    for (const profile of [null, undefined, {}, { poolCageSize: 'NONE' }]) expect(twoSizeOf(profile)).toBeNull();
  });
});

test('isHeldFourSize holds Large and Oversized only', () => {
  expect(['SMALL', 'MEDIUM', 'LARGE', 'OVERSIZED', null].map(isHeldFourSize)).toEqual([false, false, true, true, false]);
});
