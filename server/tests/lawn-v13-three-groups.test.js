// Lawn protocol v13 (migration 20261009176000): the Pythium sentence is in the recipe of every grass track, word for word, and the
// migration fills the typed column of the label's system with the bare code. No database.
const v13 = require('../config/lawn-protocol-v13.json');
const migration = require('../models/migrations/20261009176000_lawn_v13_three_chemical_groups');
const { productGroups } = require('../services/waveguard-approval-engine');

const PYTHIUM = 'The app warns on the second Artavia application for Pythium; the label allows two in a row, and nothing else in the program controls Pythium, so do not make a third: fix the watering or drainage.';
const TRACKS = Object.keys(v13);
const spotDiseaseLines = (track) => v13[track].notes.filter((line) => line.startsWith('Other spot diseases (secondary lines): Pythium root rot with Artavia'));

describe('the recipe: the Pythium warning', () => {
  test.each(TRACKS)('%s: the spot disease line ends with the Pythium sentence, once', (track) => {
    const lines = spotDiseaseLines(track);
    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith(` ${PYTHIUM}`)).toBe(true);
    expect(lines[0].split(PYTHIUM)).toHaveLength(2);
  });

  test('no text sends Pythium to Velista, Headway or Gravex', () => {
    for (const track of TRACKS) {
      const text = JSON.stringify(v13[track]);
      for (const part of text.split(/;|:|\\n|\.\s/).filter((segment) => /Pythium/.test(segment))) expect(part).not.toMatch(/Velista|Headway|Gravex/);
    }
  });
});

describe('the three chemical groups', () => {
  test('the migration fills the typed column of the label system with the bare code', () => {
    expect(migration.GROUPS.map((g) => [g.name, g.column, g.value])).toEqual([
      ['Gravex 20 EW', 'frac_group', '3'],
      ['Dylox 6.2 G Granular Insecticide', 'irac_group', '1B'],
      ['LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45 MOP Pre-Emergent Plus Fertilizer', 'hrac_group', '3'],
    ]);
  });

  test('rows shaped as the migration writes them read as pairs (empty before)', () => {
    for (const group of migration.GROUPS) {
      expect(productGroups({ name: group.name, [group.column]: group.value })).toEqual([[group.column.replace('_group', ''), group.value]]);
      expect(productGroups({ name: group.name, [group.column]: null })).toEqual([]);
    }
  });
});
