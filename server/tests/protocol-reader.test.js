const {
  availablePrograms,
  getProtocol,
  normalizeLawnTrack,
  normalizeProtocolKey,
} = require('../services/protocol-reader');

describe('shared protocol reader', () => {
  test('exposes every estimator program family', () => {
    expect(availablePrograms().sort()).toEqual([
      'bed_bug',
      'cockroach',
      'lawn',
      'mosquito',
      'palm_injection',
      'pest',
      'rodent',
      'termite',
      'tree_shrub',
    ]);
  });

  test.each([
    ['pest_control', 'pest'],
    ['tree', 'tree_shrub'],
    ['termite_bait', 'termite'],
    ['rodent_bait', 'rodent'],
    ['german_roach', 'cockroach'],
    ['bedbug', 'bed_bug'],
    ['palm', 'palm_injection'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeProtocolKey(input)).toBe(expected);
    const result = getProtocol({ service_type: input });
    expect(result.type).toBe(expected);
    expect(result.protocol).toBeTruthy();
  });

  test.each([
    ['A', 'st_augustine'],
    ['B', 'st_augustine'],
    ['C1', 'bermuda'],
    ['C2', 'zoysia'],
    ['D', 'bahia'],
  ])('keeps the legacy lawn alias %s', (input, expected) => {
    expect(normalizeLawnTrack(input)).toBe(expected);
    const result = getProtocol({ service_type: 'lawn', lawn_track: input });
    expect(result.track).toBe(expected);
    expect(result.protocol).toBeTruthy();
  });

  test('unknown program fails closed with the available list', () => {
    const result = getProtocol({ service_type: 'invented_service' });
    expect(result.protocol).toBeUndefined();
    expect(result.available_programs).toEqual(expect.arrayContaining(['pest', 'lawn']));
  });
});
