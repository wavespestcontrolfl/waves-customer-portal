// Correction migration (Codex #5476 r4): a confirmed review row carries label + labeled_by + labeled_at.
const migration = require('../models/migrations/20261001120000_decision_reviews_confirmed_provenance');

function buildKnex({ exists = true } = {}) {
  const state = { raw: [], updates: [], wheres: [] };
  const q = {
    whereIn: jest.fn((c, v) => { state.wheres.push(['whereIn', c, v]); return q; }),
    where: jest.fn((fn) => { const inner = { whereNull: jest.fn((c) => { state.wheres.push(['whereNull', c]); return inner; }), orWhereNull: jest.fn((c) => { state.wheres.push(['orWhereNull', c]); return inner; }) }; fn(inner); return q; }),
    update: jest.fn(async (v) => { state.updates.push(v); return 0; }),
  };
  const knex = jest.fn(() => q);
  knex.schema = { hasTable: jest.fn(async () => exists) };
  knex.raw = jest.fn(async (sql) => { state.raw.push(sql); });
  return { knex, state };
}

describe('decision_reviews confirmed-provenance migration', () => {
  test('up demotes incomplete confirmed rows, drops the label-only CHECK, adds the full one', async () => {
    const { knex, state } = buildKnex();
    await migration.up(knex);
    expect(state.wheres).toEqual([
      ['whereIn', 'label_status', ['confirmed_error', 'confirmed_correct']],
      ['whereNull', 'label'], ['orWhereNull', 'labeled_by'], ['orWhereNull', 'labeled_at'],
    ]);
    expect(state.updates).toEqual([{ label_status: 'unreviewed', labeled_by: null, labeled_at: null }]);
    expect(state.raw).toHaveLength(2);
    expect(state.raw[0]).toMatch(/DROP CONSTRAINT IF EXISTS decision_reviews_confirmed_requires_label_check/);
    expect(state.raw[1]).toMatch(/ADD CONSTRAINT decision_reviews_confirmed_provenance_check CHECK \(label_status NOT IN \('confirmed_error','confirmed_correct'\) OR \(label IS NOT NULL AND labeled_by IS NOT NULL AND labeled_at IS NOT NULL\)\)/);
  });
  test('down restores the label-only CHECK; no-ops without the table', async () => {
    const { knex, state } = buildKnex();
    await migration.down(knex);
    expect(state.raw[0]).toMatch(/DROP CONSTRAINT IF EXISTS decision_reviews_confirmed_provenance_check/);
    expect(state.raw[1]).toMatch(/ADD CONSTRAINT decision_reviews_confirmed_requires_label_check/);
    const missing = buildKnex({ exists: false });
    await migration.up(missing.knex); await migration.down(missing.knex);
    expect(missing.state.raw).toEqual([]);
  });
});
