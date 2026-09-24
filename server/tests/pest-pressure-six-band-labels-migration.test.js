const migration = require('../models/migrations/20260924000011_pest_pressure_six_band_labels');
const { DEFAULT_CONFIG } = require('../services/pest-pressure/config');

const { OLD_LABELS, NEW_LABELS } = migration._internal;

function fakeKnex(rows) {
  const updates = [];
  const knex = jest.fn(() => ({
    select: jest.fn(async () => rows),
    where: jest.fn(({ id }) => ({
      update: jest.fn(async (patch) => { updates.push({ id, labels: JSON.parse(patch.labels) }); }),
    })),
  }));
  knex.schema = { hasTable: jest.fn(async () => true) };
  knex.fn = { now: () => 'now()' };
  return { knex, updates };
}

describe('20260924000011_pest_pressure_six_band_labels', () => {
  test('new labels are exactly the code default', () => {
    expect(NEW_LABELS).toEqual(DEFAULT_CONFIG.labels.map((l) => ({ ...l })));
  });

  test('up rewrites only rows still on the five-band default', async () => {
    const customized = OLD_LABELS.map((l) => (l.key === 'high' ? { ...l, name: 'Severe' } : l));
    const { knex, updates } = fakeKnex([
      { id: 'default-json', labels: OLD_LABELS },
      { id: 'default-string', labels: JSON.stringify(OLD_LABELS) },
      { id: 'customized', labels: customized },
    ]);
    await migration.up(knex);
    expect(updates.map((u) => u.id)).toEqual(['default-json', 'default-string']);
    expect(updates[0].labels).toEqual(NEW_LABELS);
  });

  test('down restores the five-band default only on six-band rows', async () => {
    const { knex, updates } = fakeKnex([
      { id: 'six', labels: NEW_LABELS },
      { id: 'five', labels: OLD_LABELS },
    ]);
    await migration.down(knex);
    expect(updates).toEqual([{ id: 'six', labels: OLD_LABELS }]);
  });

  test('no-op when the table is missing', async () => {
    const { knex, updates } = fakeKnex([{ id: 'x', labels: OLD_LABELS }]);
    knex.schema.hasTable = jest.fn(async () => false);
    await migration.up(knex);
    expect(updates).toEqual([]);
  });
});
