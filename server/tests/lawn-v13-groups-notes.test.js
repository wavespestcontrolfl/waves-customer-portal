// Lawn protocol v13 (migration 20261009175000): the Pythium sentence and the November active large patch nitrogen sentence are in the
// recipe of every grass track, word for word, and the migration's figures agree with them. No database.
const v13 = require('../config/lawn-protocol-v13.json');
const migration = require('../models/migrations/20261009175000_lawn_v13_groups_and_large_patch_n');

const PYTHIUM = 'The app warns on the second Artavia application for Pythium; the label allows two in a row, and nothing else in the program controls Pythium, so do not make a third: fix the watering or drainage.';
const LARGE_PATCH = 'Active large patch mapped this month: use the 0.5 lb N setting (2.1 lb of 24-0-11 per 1,000 sq ft) and keep the spreader 7 ft off the patch.';
const TRACKS = Object.keys(v13);
const spotDiseaseLines = (track) => v13[track].notes.filter((line) => line.startsWith('Other spot diseases (secondary lines): Pythium root rot with Artavia'));
const november = (track) => v13[track].visits.filter((visit) => visit.month === 'Nov');

describe('the recipe: Pythium and November large patch', () => {
  test.each(TRACKS)('%s: the spot disease line ends with the Pythium sentence, once', (track) => {
    const lines = spotDiseaseLines(track);
    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith(` ${PYTHIUM}`)).toBe(true);
    expect(lines[0].split(PYTHIUM)).toHaveLength(2);
  });

  test.each(TRACKS)('%s: the November visit notes end with the large patch sentence, after the existing 0.75 lb N text', (track) => {
    const [visit] = november(track);
    expect(november(track)).toHaveLength(1);
    expect(visit.notes.startsWith('N rate: 0.75 lb N. Spreader visit.')).toBe(true);
    expect(visit.notes.endsWith(` ${LARGE_PATCH}`)).toBe(true);
    expect(visit.primary).toContain('3.1 lb per 1,000 sq ft (0.75 lb N)');
  });

  test('no other month carries the large patch sentence, and no text sends Pythium to Velista, Headway or Gravex', () => {
    for (const track of TRACKS) {
      for (const visit of v13[track].visits.filter((v) => v.month !== 'Nov')) expect(visit.notes).not.toContain('Active large patch mapped this month');
      const text = JSON.stringify(v13[track]);
      for (const part of text.split(/;|:|\\n|\.\s/).filter((segment) => /Pythium/.test(segment))) expect(part).not.toMatch(/Velista|Headway|Gravex/);
    }
  });

  test('the figures agree: 2.1 lb of 24-0-11 is 0.504 lb N, and the staged key carries 0.5 lb N/1000 beside the unchanged 0.75', () => {
    expect(2.1 * 0.24).toBeCloseTo(0.504, 3);
    expect(migration.GATE_KEY).toBe('activeLargePatchTargetN');
    expect(migration.GATE_VALUE).toBe('0.5 lb N/1000');
    expect(migration.NOV_WINDOW).toBe('nov_v13_spreader_feeding');
  });

  test('the migration fills the typed column of the label system with the bare code', () => {
    expect(migration.GROUPS.map((g) => [g.name, g.column, g.value])).toEqual([
      ['Gravex 20 EW', 'frac_group', '3'],
      ['Dylox 6.2 G Granular Insecticide', 'irac_group', '1B'],
      ['LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45 MOP Pre-Emergent Plus Fertilizer', 'hrac_group', '3'],
    ]);
  });
});
