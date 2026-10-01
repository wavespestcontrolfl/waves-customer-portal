// The package-hash correction migration (Codex #5476 r1): package_hash becomes
// NOT NULL; provenance-less rows are stamped with an unknown-* sentinel first.
const migration = require('../models/migrations/20261001100000_decision_reviews_package_hash_not_null');

function buildKnex({ exists = true } = {}) {
  const state = { altered: [], updates: [], cols: [] };
  const col = { notNullable: jest.fn(() => col), nullable: jest.fn(() => col), alter: jest.fn(() => { state.cols.push('alter'); return col; }) };
  const t = { string: jest.fn((name, len) => { state.cols.push(['string', name, len]); return col; }) };
  const q = { whereNull: jest.fn(() => q), update: jest.fn(async (v) => { state.updates.push(v); return 0; }) };
  const knex = jest.fn(() => q);
  knex.schema = {
    hasTable: jest.fn(async () => exists),
    alterTable: jest.fn(async (name, cb) => { state.altered.push(name); cb(t); }),
  };
  return { knex, state, col };
}

describe('decision_reviews package_hash NOT NULL migration', () => {
  test('up stamps null hashes with the unknown sentinel, then alters the column to NOT NULL', async () => {
    const { knex, state, col } = buildKnex();
    await migration.up(knex);
    expect(state.updates).toEqual([{ package_hash: expect.stringMatching(/^unknown-0{56}$/) }]);
    expect(state.updates[0].package_hash).toHaveLength(64);
    expect(state.altered).toEqual(['decision_reviews']);
    expect(state.cols).toEqual([['string', 'package_hash', 64], 'alter']);
    expect(col.notNullable).toHaveBeenCalled();
  });
  test('up and down are no-ops when the table is missing', async () => {
    const { knex, state } = buildKnex({ exists: false });
    await migration.up(knex); await migration.down(knex);
    expect(state.altered).toEqual([]); expect(state.updates).toEqual([]);
  });
  test('down relaxes the column back to nullable', async () => {
    const { knex, col } = buildKnex();
    await migration.down(knex);
    expect(col.nullable).toHaveBeenCalled();
  });
});
