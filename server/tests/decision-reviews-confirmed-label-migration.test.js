// Correction migration (Codex #5476 r3): a confirmed review row must carry a label.
const migration = require('../models/migrations/20261001110000_decision_reviews_confirmed_requires_label');

function buildKnex({ exists = true } = {}) {
  const state = { raw: [], updates: [], wheres: [] };
  const q = {
    whereIn: jest.fn((c, v) => { state.wheres.push(['whereIn', c, v]); return q; }),
    whereNull: jest.fn((c) => { state.wheres.push(['whereNull', c]); return q; }),
    update: jest.fn(async (v) => { state.updates.push(v); return 0; }),
  };
  const knex = jest.fn(() => q);
  knex.schema = { hasTable: jest.fn(async () => exists) };
  knex.raw = jest.fn(async (sql) => { state.raw.push(sql); });
  return { knex, state };
}

describe('decision_reviews confirmed-requires-label migration', () => {
  test('up demotes label-less confirmed rows, then adds the CHECK', async () => {
    const { knex, state } = buildKnex();
    await migration.up(knex);
    expect(state.wheres).toEqual([['whereIn', 'label_status', ['confirmed_error', 'confirmed_correct']], ['whereNull', 'label']]);
    expect(state.updates).toEqual([{ label_status: 'unreviewed', labeled_by: null, labeled_at: null }]);
    expect(state.raw).toHaveLength(1);
    expect(state.raw[0]).toMatch(/ADD CONSTRAINT decision_reviews_confirmed_requires_label_check CHECK \(label_status NOT IN \('confirmed_error','confirmed_correct'\) OR label IS NOT NULL\)/);
  });
  test('down drops the CHECK; both are no-ops without the table', async () => {
    const { knex, state } = buildKnex();
    await migration.down(knex);
    expect(state.raw[0]).toMatch(/DROP CONSTRAINT IF EXISTS decision_reviews_confirmed_requires_label_check/);
    const missing = buildKnex({ exists: false });
    await migration.up(missing.knex); await migration.down(missing.knex);
    expect(missing.state.raw).toEqual([]); expect(missing.state.updates).toEqual([]);
  });
});
