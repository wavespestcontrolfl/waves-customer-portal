// Lawn protocol v13 (migration 20261009176000): the Pythium sentence is in the recipe of every grass track, word for word, and the
// migration fills the typed column of the label's system with the bare code. No database.
const v13 = require('../config/lawn-protocol-v13.json');
const migration = require('../models/migrations/20261009176000_lawn_v13_three_chemical_groups');
const liquid = require('../models/migrations/20261009177000_lawn_v13_dylox_liquid_irac_group');
const artavia = require('../models/migrations/20261009178000_lawn_v13_artavia_frac_group');
const { productGroups } = require('../services/waveguard-approval-engine');

const PYTHIUM = 'The app warns on the second Artavia application for Pythium; the label allows two in a row. Headway is not a rotation for it (Headway has the same Group 11 ingredient). Do not make a third Group 11 application in a row: fix the watering or drainage.';
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

  // Codex round 1 on #6238: the repeat check compares the same typed column on both products.
  test('both Dylox products carry the group in the same typed column, with the same code', () => {
    const granular = migration.GROUPS.find((g) => g.name.startsWith('Dylox 6.2 G'));
    expect([liquid.GROUP.name, liquid.GROUP.column, liquid.GROUP.value]).toEqual(['Dylox 420 SL T&O Insecticide', granular.column, granular.value]);
    const liquidRow = productGroups({ name: liquid.GROUP.name, moa_group: 'Group 1B', [liquid.GROUP.column]: liquid.GROUP.value });
    const granularRow = productGroups({ name: granular.name, [granular.column]: granular.value });
    expect(liquidRow).toEqual(expect.arrayContaining(granularRow));
  });

  // Codex round 2 on #6238: the recipe promises a warning on the second Artavia application, so the row needs its group.
  test('Artavia gets frac_group 11, the group Headway (3 + 11) shares', () => {
    expect([artavia.GROUP.name, artavia.GROUP.column, artavia.GROUP.value]).toEqual(['Artavia 2 SC (Azoxy)', 'frac_group', '11']);
    expect(productGroups({ name: artavia.GROUP.name, frac_group: artavia.GROUP.value })).toEqual([['frac', '11']]);
  });
});
