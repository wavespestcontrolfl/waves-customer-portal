// Supersedes the frozen 20261001140000 label-shape CHECK: no bare ? (knex bind placeholder), NULL-safe.
const migration = require('../models/migrations/20261001150000_decision_reviews_label_shape_fix');

function buildKnex({ exists = true } = {}) {
  const state = { raw: [], updates: [], wheres: [] };
  const q = { whereRaw: jest.fn((sql) => { state.wheres.push(sql); return q; }), update: jest.fn(async (v) => { state.updates.push(v); return 0; }) };
  const knex = jest.fn(() => q);
  knex.schema = { hasTable: jest.fn(async () => exists) };
  knex.raw = jest.fn(async (sql) => { state.raw.push(sql); });
  return { knex, state };
}

describe('decision_reviews label-shape fix migration', () => {
  test('the predicates contain no bare ? and guard the verdict against NULL', () => {
    expect(migration.LABEL_OK).not.toMatch(/\?/);
    expect(migration.PROVENANCE_OK).not.toMatch(/\?/);
    expect(migration.LABEL_OK).toMatch(/label->>'verdict' IS NOT NULL AND label->>'verdict' IN \('jev_right','jev_wrong','unclear'\)/);
    expect(migration.LABEL_OK).toMatch(/jsonb_exists\(label, 'correct_value'\)/);
  });
  test('up demotes non-fitting confirmed rows (NULL-safe), drops the old CHECK, adds the v2 CHECK wrapped in COALESCE', async () => {
    const { knex, state } = buildKnex();
    await migration.up(knex);
    expect(state.wheres[0]).toMatch(/AND NOT COALESCE\(/);
    expect(state.wheres[0]).not.toMatch(/\?/);
    expect(state.updates).toEqual([{ label_status: 'unreviewed', labeled_by: null, labeled_at: null }]);
    expect(state.raw[0]).toMatch(/DROP CONSTRAINT IF EXISTS decision_reviews_confirmed_label_shape_check/);
    expect(state.raw[1]).toMatch(/ADD CONSTRAINT decision_reviews_confirmed_label_shape_v2_check CHECK \(NOT \(label_status IN \('confirmed_error','confirmed_correct'\)\) OR COALESCE\(/);
    expect(state.raw[1]).not.toMatch(/\?/);
  });
  test('down drops the v2 CHECK; no-ops without the table', async () => {
    const { knex, state } = buildKnex();
    await migration.down(knex);
    expect(state.raw).toEqual([expect.stringMatching(/DROP CONSTRAINT IF EXISTS decision_reviews_confirmed_label_shape_v2_check/)]);
    const missing = buildKnex({ exists: false });
    await migration.up(missing.knex); await migration.down(missing.knex);
    expect(missing.state.raw).toEqual([]);
  });
});
