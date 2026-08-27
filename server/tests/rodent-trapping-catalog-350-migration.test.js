/**
 * 20260826000005: services.rodent_trapping price fields collapse to the
 * Standard-only $350 (price_range_max 450 → 350). Value-guarded both ways.
 */
const migration = require('../models/migrations/20260826000005_rodent_trapping_catalog_350');

const { LEGACY, TARGET } = migration;
const STATE_KEY = 'migration.20260826000005.state';

function fakeKnex(db) {
  const knex = (table) => {
    const filters = [];
    const rowsNow = () => db[table] || [];
    const match = (r) => filters.every((cond) => Object.entries(cond).every(([k, v]) => r[k] === v));
    const q = {
      where(cond) { filters.push(cond); return q; },
      first: async () => { const hit = rowsNow().find(match); return hit ? { ...hit } : undefined; },
      update: async (patch) => { const hits = rowsNow().filter(match); hits.forEach((r) => Object.assign(r, patch)); return hits.length; },
      del: async () => { const hits = rowsNow().filter(match); db[table] = rowsNow().filter((r) => !hits.includes(r)); return hits.length; },
      insert: async (row) => { (db[table] = rowsNow()).push({ id: `${table}-${rowsNow().length + 1}`, ...row }); return [1]; },
    };
    return q;
  };
  knex.schema = { hasTable: async (t) => t in db };
  knex.fn = { now: () => 'NOW' };
  return knex;
}

const seedDb = (overrides = {}) => ({
  services: [{ id: 'svc-trap', service_key: 'rodent_trapping', ...LEGACY, ...overrides }],
  system_settings: [],
});
const trap = (db) => db.services.find((r) => r.service_key === 'rodent_trapping');
const stateRow = (db) => db.system_settings.find((r) => r.key === STATE_KEY);

describe('20260826000005 rodent_trapping catalog $350', () => {
  test('up() collapses the seeded $350–$450 range to $350; down() restores the range', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    expect(trap(db)).toMatchObject(TARGET);
    expect(JSON.parse(stateRow(db).value).changed).toEqual(['price_range_max']);
    await migration.down(fakeKnex(db));
    expect(trap(db)).toMatchObject(LEGACY);
    expect(stateRow(db)).toBeUndefined();
  });

  test('admin-edited price fields are all pinned to $350; down() restores each edited value', async () => {
    const db = seedDb({ base_price: 375, price_range_min: 300, price_range_max: 500 });
    await migration.up(fakeKnex(db));
    expect(trap(db)).toMatchObject(TARGET);
    expect(JSON.parse(stateRow(db).value)).toMatchObject({ prior: { base_price: 375, price_range_min: 300, price_range_max: 500 } });
    await migration.down(fakeKnex(db));
    expect(trap(db)).toMatchObject({ base_price: 375, price_range_min: 300, price_range_max: 500 });
  });

  test('NULL price fields are left alone', async () => {
    const db = seedDb({ base_price: null, price_range_min: null, price_range_max: null });
    await migration.up(fakeKnex(db));
    expect(trap(db).base_price).toBeNull();
    expect(stateRow(db)).toBeUndefined();
  });

  test('down() ignores a value that drifted after up()', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    trap(db).price_range_max = 375;
    await migration.down(fakeKnex(db));
    expect(trap(db).price_range_max).toBe(375);
  });

  test('missing table or row is a no-op', async () => {
    await expect(migration.up(fakeKnex({}))).resolves.toBeUndefined();
    await expect(migration.up(fakeKnex({ services: [], system_settings: [] }))).resolves.toBeUndefined();
    await expect(migration.down(fakeKnex({}))).resolves.toBeUndefined();
  });
});
