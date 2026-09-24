const migration = require('../models/migrations/20260924000012_pest_pressure_direct_rating_explanation');
const { DEFAULT_CONFIG } = require('../services/pest-pressure/config');

const { OLD_TEXT, NEW_TEXT } = migration._internal;

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

describe('20260924000012_pest_pressure_direct_rating_explanation', () => {
  test('new text is the code default and describes the direct technician score', () => {
    expect(NEW_TEXT).toBe(DEFAULT_CONFIG.customerExplanationText);
    expect(NEW_TEXT).toMatch(/When your technician rates activity during the visit, that rating is your score/);
  });

  test('up rewrites only rows still carrying the old default text', async () => {
    const { knex, calls } = fakeKnex();
    await migration.up(knex);
    expect(calls).toHaveLength(1);
    expect(calls[0].where).toEqual({ customer_explanation_text: OLD_TEXT });
    expect(calls[0].patch.customer_explanation_text).toBe(NEW_TEXT);
  });

  test('down reverses only rows carrying the new default text', async () => {
    const { knex, calls } = fakeKnex();
    await migration.down(knex);
    expect(calls[0].where).toEqual({ customer_explanation_text: NEW_TEXT });
    expect(calls[0].patch.customer_explanation_text).toBe(OLD_TEXT);
  });
});
