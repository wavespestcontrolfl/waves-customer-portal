const migration = require('../models/migrations/20260924000014_pest_pressure_label_neutral_explanation');
const { _internal: { OLD_LABELS, NEW_LABELS } } = require('../models/migrations/20260924000011_pest_pressure_six_band_labels');
const { _internal: { OLD_TEXT } } = require('../models/migrations/20260924000012_pest_pressure_direct_rating_explanation');

const { NEUTRAL_TEXT } = migration._internal;

function fakeKnex(rows) {
  const updates = [];
  const knex = jest.fn(() => ({
    where: jest.fn((where) => ({
      select: jest.fn(async () => rows.filter((r) => r.text === where.customer_explanation_text)),
      update: jest.fn(async (patch) => { updates.push({ id: where.id, text: patch.customer_explanation_text }); }),
    })),
  }));
  knex.schema = { hasTable: jest.fn(async () => true) };
  knex.fn = { now: () => 'now()' };
  return { knex, updates };
}

describe('20260924000014_pest_pressure_label_neutral_explanation', () => {
  test('neutral copy keeps the direct-rating sentence and names no band label', () => {
    expect(NEUTRAL_TEXT).toMatch(/When your technician rates activity during the visit, that rating is your score/);
    for (const label of ['Very Low', 'Moderate', 'Elevated', 'High']) {
      expect(NEUTRAL_TEXT).not.toMatch(new RegExp(`\\b${label}\\b`, 'i'));
    }
  });

  test('customized-label rows on the old copy get the neutral copy; six-band rows are left alone', async () => {
    const customized = OLD_LABELS.map((l) => (l.key === 'high' ? { ...l, name: 'Severe' } : l));
    const { knex, updates } = fakeKnex([
      { id: 'customized', labels: customized, text: OLD_TEXT },
      { id: 'six-band', labels: NEW_LABELS, text: OLD_TEXT },
      { id: 'edited', labels: customized, text: 'Our own words.' },
    ]);
    await migration.up(knex);
    expect(updates).toEqual([{ id: 'customized', text: NEUTRAL_TEXT }]);
  });

  test('down restores the old copy only on neutral rows', async () => {
    const customized = OLD_LABELS.map((l) => (l.key === 'high' ? { ...l, name: 'Severe' } : l));
    const { knex, updates } = fakeKnex([{ id: 'customized', labels: customized, text: NEUTRAL_TEXT }]);
    await migration.down(knex);
    expect(updates).toEqual([{ id: 'customized', text: OLD_TEXT }]);
  });
});
