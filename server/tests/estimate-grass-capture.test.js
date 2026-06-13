const { findGrassTypeDeep, grassTypeToPersist } = require('../services/estimate-converter');
const { normalizeGrassType } = require('../services/lawn-grass-context');

// The admin estimate form always saves grassType (defaulting to st_augustine
// even for pest-only accepts), so the persist must be gated on a lawn service —
// otherwise non-lawn customers get a fake default turf profile.
describe('grassTypeToPersist gates on a lawn service', () => {
  const lawnSvc = { name: 'Lawn Care' };
  const pestSvc = { name: 'General Pest Control' };
  const data = { inputs: { grassType: 'st_augustine' } };

  test('lawn estimate → persists the grass', () => {
    expect(grassTypeToPersist([lawnSvc], data)).toBe('st_augustine');
    expect(grassTypeToPersist([pestSvc, lawnSvc], data)).toBe('st_augustine');
  });
  test('pest-only estimate → null (no fake default profile)', () => {
    expect(grassTypeToPersist([pestSvc], data)).toBeNull();
    expect(grassTypeToPersist([], data)).toBeNull();
  });
  test('lawn estimate but no grass in data → null', () => {
    expect(grassTypeToPersist([lawnSvc], { inputs: {} })).toBeNull();
  });
});

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
