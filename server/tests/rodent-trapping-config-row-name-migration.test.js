/**
 * 20260927000004: a rodent_trapping pricing_config row whose allowance was
 * repaired to 1 without a rename gets the setup + 1 check name.
 */
const migration = require('../models/migrations/20260927000004_rodent_trapping_config_row_name');

function fakeKnex(db) {
  const knex = (table) => {
    const filters = [];
    const rowsNow = () => db[table] || [];
    const match = (r) => filters.every((f) => f(r));
    const q = {
      where(cond) { filters.push((r) => Object.entries(cond).every(([k, v]) => r[k] === v)); return q; },
      forUpdate() { return q; },
      first: async () => { const hit = rowsNow().find(match); return hit ? { ...hit } : undefined; },
      update: async (patch) => { const hits = rowsNow().filter(match); hits.forEach((r) => Object.assign(r, patch)); return hits.length; },
      del: async () => { const hits = rowsNow().filter(match); db[table] = rowsNow().filter((r) => !hits.includes(r)); return hits.length; },
      insert: async (row) => { (db[table] = rowsNow()).push({ ...row }); return [1]; },
    };
    return q;
  };
  knex.schema = { hasTable: async (t) => t in db };
  knex.fn = { now: () => 'NOW' };
  return knex;
}

const seed = (name, includedFollowups) => ({
  pricing_config: [{ config_key: 'rodent_trapping', name, data: JSON.stringify({ included_followups: includedFollowups }) }],
  system_settings: [],
});

describe('20260927000004 rodent_trapping row name', () => {
  test('renames a repaired row still carrying the unlimited name; down() reverts', async () => {
    const db = seed(migration.PRIOR_ROW_NAME, 1);
    const knex = fakeKnex(db);
    await migration.up(knex);
    expect(db.pricing_config[0].name).toBe(migration.ROW_NAME);
    await migration.down(knex);
    expect(db.pricing_config[0].name).toBe(migration.PRIOR_ROW_NAME);
    expect(db.system_settings).toHaveLength(0);
  });

  test('an admin-renamed row or a non-1 allowance is left alone', async () => {
    const custom = seed('Custom trapping row', 1);
    await migration.up(fakeKnex(custom));
    expect(custom.pricing_config[0].name).toBe('Custom trapping row');
    const unlimited = seed(migration.PRIOR_ROW_NAME, 'unlimited');
    await migration.up(fakeKnex(unlimited));
    expect(unlimited.pricing_config[0].name).toBe(migration.PRIOR_ROW_NAME);
  });
});
