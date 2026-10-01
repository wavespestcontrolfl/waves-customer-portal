// Status ↔ verdict pairing migration (Codex #5476 r9).
const migration = require('../models/migrations/20261001160000_decision_reviews_status_verdict_pairing');

function buildKnex({ exists = true } = {}) {
  const state = { raw: [], updates: [], wheres: [] };
  const q = { whereRaw: jest.fn((sql) => { state.wheres.push(sql); return q; }), update: jest.fn(async (v) => { state.updates.push(v); return 0; }) };
  const knex = jest.fn(() => q);
  knex.schema = { hasTable: jest.fn(async () => exists) };
  knex.raw = jest.fn(async (sql) => { state.raw.push(sql); });
  return { knex, state };
}

describe('decision_reviews status/verdict pairing migration', () => {
  test('pairs confirmed_correct with jev_right and confirmed_error with jev_wrong; no bare ?', () => {
    expect(migration.PAIRING_OK).toMatch(/label_status = 'confirmed_correct' AND label->>'verdict' = 'jev_right'/);
    expect(migration.PAIRING_OK).toMatch(/label_status = 'confirmed_error' AND label->>'verdict' = 'jev_wrong'/);
    expect(migration.PAIRING_OK).not.toMatch(/\?/);
  });
  test('up demotes contradictory confirmed rows, swaps v2 for v3 (NULL-safe)', async () => {
    const { knex, state } = buildKnex();
    await migration.up(knex);
    expect(state.wheres[0]).toMatch(/AND NOT COALESCE\(.*confirmed_correct' AND label->>'verdict' = 'jev_right'/);
    expect(state.updates).toEqual([{ label_status: 'unreviewed', labeled_by: null, labeled_at: null }]);
    expect(state.raw[0]).toMatch(/DROP CONSTRAINT IF EXISTS decision_reviews_confirmed_label_shape_v2_check/);
    expect(state.raw[1]).toMatch(/ADD CONSTRAINT decision_reviews_confirmed_label_shape_v3_check CHECK \(NOT \(label_status IN/);
    expect(state.raw[1]).toMatch(/COALESCE\(/);
    expect(state.raw[1]).not.toMatch(/\?/);
  });
  test('down restores v2; no-ops without the table', async () => {
    const { knex, state } = buildKnex();
    await migration.down(knex);
    expect(state.raw[1]).toMatch(/ADD CONSTRAINT decision_reviews_confirmed_label_shape_v2_check/);
    const missing = buildKnex({ exists: false });
    await migration.up(missing.knex); await migration.down(missing.knex);
    expect(missing.state.raw).toEqual([]);
  });
});
