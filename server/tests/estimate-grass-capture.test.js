const { findGrassTypeDeep } = require('../services/estimate-converter');
const { normalizeGrassType } = require('../services/lawn-grass-context');

// Grass type is captured during the estimate (confirmed at estimate_data.inputs
// .grassType) but was never persisted — so lawn reports defaulted to St.
// Augustine. The converter now extracts + normalizes it into the turf profile.
describe('findGrassTypeDeep', () => {
  test('finds grassType at the confirmed inputs path', () => {
    expect(findGrassTypeDeep({ inputs: { grassType: 'st_augustine' } })).toBe('st_augustine');
  });
  test('finds it nested anywhere (shape varies)', () => {
    expect(findGrassTypeDeep({ result: { turfProfile: { grassType: 'zoysia' } } })).toBe('zoysia');
    expect(findGrassTypeDeep({ a: { b: { c: { grass_type: 'bahia' } } } })).toBe('bahia');
  });
  test('searches through arrays', () => {
    expect(findGrassTypeDeep({ services: [{ key: 'pest' }, { grassType: 'bermuda' }] })).toBe('bermuda');
  });
  test('returns null when absent / non-object / too deep', () => {
    expect(findGrassTypeDeep({ inputs: { foo: 1 } })).toBeNull();
    expect(findGrassTypeDeep(null)).toBeNull();
    expect(findGrassTypeDeep('x')).toBeNull();
  });
  test('end-to-end normalizes cultivar names to canonical keys', () => {
    expect(normalizeGrassType(findGrassTypeDeep({ inputs: { grassType: 'Floratam' } }))).toBe('st_augustine');
  });
});
