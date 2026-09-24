const migration = require('../models/migrations/20260924000015_pest_pressure_explanation_label_neutral_everywhere');
const { _internal: { NEW_TEXT: SIX_BAND_TEXT } } = require('../models/migrations/20260924000012_pest_pressure_direct_rating_explanation');
const { _internal: { NEUTRAL_TEXT } } = require('../models/migrations/20260924000014_pest_pressure_label_neutral_explanation');
const { DEFAULT_CONFIG } = require('../services/pest-pressure/config');

function fakeKnex() {
  const calls = [];
  const knex = jest.fn(() => ({
    where: jest.fn((where) => ({
      update: jest.fn(async (patch) => { calls.push({ where, patch }); }),
    })),
  }));
  knex.schema = { hasTable: jest.fn(async () => true) };
  knex.fn = { now: () => 'now()' };
  return { knex, calls };
}

describe('20260924000015_pest_pressure_explanation_label_neutral_everywhere', () => {
  test('label-neutral copy is the code default and never names a band label', () => {
    expect(DEFAULT_CONFIG.customerExplanationText).toBe(NEUTRAL_TEXT);
    for (const label of ['Very Low', 'Moderate', 'Elevated', 'High']) {
      expect(NEUTRAL_TEXT).not.toMatch(new RegExp(`\\b${label}\\b`, 'i'));
    }
  });

  test('up moves only rows still on the six-band copy', async () => {
    const { knex, calls } = fakeKnex();
    await migration.up(knex);
    expect(calls).toEqual([{ where: { customer_explanation_text: SIX_BAND_TEXT }, patch: expect.objectContaining({ customer_explanation_text: NEUTRAL_TEXT }) }]);
  });

  test('down reverses only neutral rows', async () => {
    const { knex, calls } = fakeKnex();
    await migration.down(knex);
    expect(calls).toEqual([{ where: { customer_explanation_text: NEUTRAL_TEXT }, patch: expect.objectContaining({ customer_explanation_text: SIX_BAND_TEXT }) }]);
  });
});
