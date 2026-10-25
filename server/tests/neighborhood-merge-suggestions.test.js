// The suggested-merges name rules (services/neighborhood-merge.js, owner ruling
// 2026-10-25). Pure: no database. All community names are synthetic.
jest.mock('../models/db', () => ({}));
const { familyKey, groupSuggestions } = require('../services/neighborhood-merge');

const entry = (id, name, homes = 1, extra = {}) => ({ id, name, county: 'Manatee', homes, liveEntries: 0, ...extra });
const pairs = (list, dismissed) => groupSuggestions(list, dismissed).map((s) => `${s.source.name} -> ${s.target.name}`);

describe('familyKey', () => {
  test.each([
    ['Heron Point Subphase C', 'heron point'],
    ['Heron Point at Lakewood Ranch', 'heron point'],
    ['Heron Point Lwr Iii', 'heron point'],
    ['Bay Pines 2', 'bay pines'],
    ['Bay Pines Sub', 'bay pines'],
    ['Oak Run Phase II', 'oak run'],
    ['Plaza Subphase D-1ba & D-2c', 'plaza'],
    ['Sample National Golf Club', 'sample national'],
    ['The Willows', 'willows'],
    ['Willow Bend Townhomes', 'willow bend'],
  ])('%s reads as %s', (name, key) => {
    expect(familyKey(name)).toBe(key);
  });
});

describe('groupSuggestions', () => {
  test('a phase, a spelling and "X at Y" join the entry with the most homes', () => {
    expect(pairs([
      entry('a', 'Heron Point', 6),
      entry('b', 'Heron Point Subphase C', 2),
      entry('c', 'Cross Gate', 1),
      entry('d', 'Crossgate', 4),
      entry('e', 'Sample National Golf Club', 5),
      entry('f', 'Terrace Iii at Sample National', 1),
    ])).toEqual([
      'Heron Point Subphase C -> Heron Point',
      'Terrace Iii at Sample National -> Sample National Golf Club',
      'Cross Gate -> Crossgate',
    ]);
  });

  test('never across counties, never a bare word prefix, never a very short name', () => {
    expect(pairs([
      entry('a', 'Heron Point', 3),
      entry('b', 'Heron Point 2', 1, { county: 'Sarasota' }),
      entry('c', 'Gull Bay', 2),
      entry('d', 'Gull Bay Gardens', 1),
      entry('e', 'Oak Ph 1', 1),
      entry('f', 'Oak Ph 2', 1),
    ])).toEqual([]);
  });

  test('a pair marked not the same is left out; ties keep the entry with gate entries, then the shorter name', () => {
    const list = [
      entry('a', 'Heron Point Lwr', 1, { liveEntries: 1 }),
      entry('b', 'Heron Point at Lakewood Ranch', 1),
      entry('c', 'Heron Point Sub', 1),
    ];
    expect(pairs(list)).toEqual(['Heron Point Sub -> Heron Point Lwr', 'Heron Point at Lakewood Ranch -> Heron Point Lwr']);
    expect(pairs(list, new Set(['c|a']))).toEqual(['Heron Point at Lakewood Ranch -> Heron Point Lwr']);
  });
});
