// Integrity migration (Codex #5476 r5, closing r1–r5): one contract for decision_reviews.
const migration = require('../models/migrations/20261001130000_decision_reviews_integrity');

function buildKnex({ exists = true } = {}) {
  const state = { raw: [], updates: [], deletes: 0, wheres: [] };
  const q = {
    whereRaw: jest.fn((sql) => { state.wheres.push(['whereRaw', sql]); return q; }),
    whereIn: jest.fn((c, v) => { state.wheres.push(['whereIn', c, v]); return q; }),
    del: jest.fn(async () => { state.deletes += 1; return 0; }),
    update: jest.fn(async (v) => { state.updates.push(v); return 0; }),
  };
  const knex = jest.fn(() => q);
  knex.schema = { hasTable: jest.fn(async () => exists) };
  knex.raw = jest.fn(async (sql) => { state.raw.push(sql); });
  return { knex, state };
}

describe('decision_reviews integrity migration', () => {
  test('up deletes non-hash rows, demotes incomplete confirmed rows, swaps the CHECKs', async () => {
    const { knex, state } = buildKnex();
    await migration.up(knex);
    expect(state.deletes).toBe(1);
    expect(state.wheres[0]).toEqual(['whereRaw', "package_hash !~ '^[0-9a-f]{64}$'"]);
    expect(state.wheres[1]).toEqual(['whereIn', 'label_status', ['confirmed_error', 'confirmed_correct']]);
    expect(state.wheres[2][1]).toMatch(/jsonb_typeof\(label\) <> 'object'.*btrim\(labeled_by\) = ''/);
    expect(state.updates).toEqual([{ label_status: 'unreviewed', labeled_by: null, labeled_at: null }]);
    expect(state.raw.filter((s) => /DROP CONSTRAINT IF EXISTS decision_reviews_confirmed_(requires_label|provenance)_check/.test(s))).toHaveLength(2);
    expect(state.raw.find((s) => /ADD CONSTRAINT decision_reviews_package_hash_format_check/.test(s))).toMatch(/CHECK \(package_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
    expect(state.raw.find((s) => /ADD CONSTRAINT decision_reviews_confirmed_label_provenance_check/.test(s))).toMatch(/jsonb_typeof\(label\) = 'object' AND labeled_by IS NOT NULL AND btrim\(labeled_by\) <> '' AND labeled_at IS NOT NULL/);
  });
  test('down restores the r4 provenance CHECK; no-ops without the table', async () => {
    const { knex, state } = buildKnex();
    await migration.down(knex);
    expect(state.raw).toHaveLength(3);
    expect(state.raw[2]).toMatch(/ADD CONSTRAINT decision_reviews_confirmed_provenance_check/);
    const missing = buildKnex({ exists: false });
    await migration.up(missing.knex); await migration.down(missing.knex);
    expect(missing.state.raw).toEqual([]); expect(missing.state.deletes).toBe(0);
  });
});
