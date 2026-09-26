/**
 * 20260927000005: the fixed-price $95 row books from base_price — the
 * seeded 95/95 range is cleared so a later price edit can't be shadowed.
 */
const migration = require('../models/migrations/20260927000005_rodent_trap_check_additional_price_range');

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
  knex.schema = { hasTable: async (t) => t in db, hasColumn: async () => true };
  knex.fn = { now: () => 'NOW' };
  return knex;
}

const seed = (min, max) => ({
  services: [{ id: 's1', service_key: 'rodent_trap_check_additional', base_price: 95, price_range_min: min, price_range_max: max }],
  system_settings: [],
});

describe('20260927000005 rodent trap check price range', () => {
  test('clears the seeded 95/95 range; down() restores it', async () => {
    const db = seed('95.00', '95.00');
    const knex = fakeKnex(db);
    await migration.up(knex);
    expect(db.services[0]).toMatchObject({ price_range_min: null, price_range_max: null, base_price: 95 });
    await migration.down(knex);
    expect(db.services[0]).toMatchObject({ price_range_min: 95, price_range_max: 95 });
    expect(db.system_settings).toHaveLength(0);
  });

  test('an admin-set range is left alone', async () => {
    const db = seed(90, 120);
    await migration.up(fakeKnex(db));
    expect(db.services[0]).toMatchObject({ price_range_min: 90, price_range_max: 120 });
  });
});
