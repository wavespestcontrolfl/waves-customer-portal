// Label-shape migration (Codex #5476 r6): a confirmed label is { verdict, correct_value? , note? }.
const migration = require('../models/migrations/20261001140000_decision_reviews_label_shape');

function buildKnex({ exists = true } = {}) {
  const state = { raw: [], updates: [], wheres: [] };
  const q = { whereRaw: jest.fn((sql) => { state.wheres.push(sql); return q; }), update: jest.fn(async (v) => { state.updates.push(v); return 0; }) };
  const knex = jest.fn(() => q);
  knex.schema = { hasTable: jest.fn(async () => exists) };
  knex.raw = jest.fn(async (sql) => { state.raw.push(sql); });
  return { knex, state };
}

describe('decision_reviews label-shape migration', () => {
  test('up demotes confirmed rows whose label does not fit, swaps the provenance CHECK for the shape CHECK', async () => {
    const { knex, state } = buildKnex();
    await migration.up(knex);
    expect(state.wheres[0]).toMatch(/label_status IN \('confirmed_error','confirmed_correct'\) AND NOT \(/);
    expect(state.updates).toEqual([{ label_status: 'unreviewed', labeled_by: null, labeled_at: null }]);
    expect(state.raw[0]).toMatch(/DROP CONSTRAINT IF EXISTS decision_reviews_confirmed_label_provenance_check/);
    const add = state.raw[1];
    expect(add).toMatch(/ADD CONSTRAINT decision_reviews_confirmed_label_shape_check CHECK/);
    expect(add).toMatch(/label->>'verdict' IN \('jev_right','jev_wrong','unclear'\)/);
    expect(add).toMatch(/label->>'verdict' <> 'jev_wrong' OR label \? 'correct_value'/);
    expect(add).toMatch(/btrim\(labeled_by\) <> '' AND labeled_at IS NOT NULL/);
  });
  test('the shape predicate rejects {} and null and accepts the route shapes (SQL text)', () => {
    expect(migration.LABEL_OK).toMatch(/jsonb_typeof\(label\) = 'object'/);
    expect(migration.LABEL_OK).toMatch(/label->>'verdict' IN/);
  });
  test('down restores the r5 CHECK; no-ops without the table', async () => {
    const { knex, state } = buildKnex();
    await migration.down(knex);
    expect(state.raw[1]).toMatch(/ADD CONSTRAINT decision_reviews_confirmed_label_provenance_check/);
    const missing = buildKnex({ exists: false });
    await migration.up(missing.knex); await migration.down(missing.knex);
    expect(missing.state.raw).toEqual([]);
  });
});
