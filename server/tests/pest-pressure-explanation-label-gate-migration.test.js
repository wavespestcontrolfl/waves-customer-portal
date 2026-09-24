const migration = require('../models/migrations/20260924000013_pest_pressure_explanation_label_gate');
const { _internal: { OLD_LABELS, NEW_LABELS } } = require('../models/migrations/20260924000011_pest_pressure_six_band_labels');
const { _internal: { OLD_TEXT, NEW_TEXT } } = require('../models/migrations/20260924000012_pest_pressure_direct_rating_explanation');

function fakeKnex(rows) {
  const updates = [];
  const knex = jest.fn(() => ({
    where: jest.fn((where) => ({
      select: jest.fn(async () => rows.filter((r) => !where.customer_explanation_text || r.text === where.customer_explanation_text)),
      update: jest.fn(async (patch) => { updates.push({ id: where.id, text: patch.customer_explanation_text }); }),
    })),
  }));
  knex.schema = { hasTable: jest.fn(async () => true) };
  knex.fn = { now: () => 'now()' };
  return { knex, updates };
}

describe('20260924000013_pest_pressure_explanation_label_gate', () => {
  test('restores the old copy only where the labels are not the six-band set', async () => {
    const customized = OLD_LABELS.map((l) => (l.key === 'high' ? { ...l, name: 'Severe' } : l));
    const { knex, updates } = fakeKnex([
      { id: 'six-band', labels: NEW_LABELS, text: NEW_TEXT },
      { id: 'customized', labels: customized, text: NEW_TEXT },
      { id: 'customized-json', labels: JSON.stringify(customized), text: NEW_TEXT },
    ]);
    await migration.up(knex);
    expect(updates).toEqual([
      { id: 'customized', text: OLD_TEXT },
      { id: 'customized-json', text: OLD_TEXT },
    ]);
  });

  test('never touches edited copy', async () => {
    const { knex, updates } = fakeKnex([{ id: 'edited', labels: OLD_LABELS, text: 'Our own words.' }]);
    await migration.up(knex);
    expect(updates).toEqual([]);
  });
});
