/**
 * 20260826000004: services.rodent_inspection catalog row $125 → $75 to match
 * the DB-authoritative pricing_config fee (20260826000002). Value-guarded
 * both ways: an admin-repriced row is untouched by up(), and down() restores
 * only what up() recorded changing.
 */
const migration = require('../models/migrations/20260826000004_rodent_inspection_catalog_75');

const { LEGACY_PRICE, NEW_PRICE, LEGACY_DESCRIPTION, NEW_DESCRIPTION } = migration;
const STATE_KEY = 'migration.20260826000004.state';

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
  services: [{ id: 'svc-insp', service_key: 'rodent_inspection', base_price: LEGACY_PRICE, description: LEGACY_DESCRIPTION, ...overrides }],
  system_settings: [],
});
const insp = (db) => db.services.find((r) => r.service_key === 'rodent_inspection');
const stateRow = (db) => db.system_settings.find((r) => r.key === STATE_KEY);

describe('20260826000004 rodent_inspection catalog $75', () => {
  test('up() reprices the seeded row and rewrites the $125 copy; down() restores both', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    expect(insp(db).base_price).toBe(NEW_PRICE);
    expect(insp(db).description).toBe(NEW_DESCRIPTION);
    expect(JSON.parse(stateRow(db).value)).toMatchObject({ priceChanged: true, descriptionChanged: true, id: 'svc-insp' });
    await migration.down(fakeKnex(db));
    expect(insp(db).base_price).toBe(LEGACY_PRICE);
    expect(insp(db).description).toBe(LEGACY_DESCRIPTION);
    expect(stateRow(db)).toBeUndefined();
  });

  test('an admin-repriced row is pinned to $75 too (custom copy kept); down() restores the edited price', async () => {
    const db = seedDb({ base_price: 99, description: 'Custom copy' });
    await migration.up(fakeKnex(db));
    expect(insp(db).base_price).toBe(NEW_PRICE);
    expect(insp(db).description).toBe('Custom copy');
    expect(JSON.parse(stateRow(db).value)).toMatchObject({ priceChanged: true, priorPrice: 99, descriptionChanged: false });
    await migration.down(fakeKnex(db));
    expect(insp(db).base_price).toBe(99);
  });

  test('a NULL (variable-priced) row is pinned to $75; down() restores the NULL', async () => {
    const db = seedDb({ base_price: null });
    await migration.up(fakeKnex(db));
    expect(insp(db).base_price).toBe(NEW_PRICE);
    expect(JSON.parse(stateRow(db).value)).toMatchObject({ priceChanged: true, priorPrice: null });
    await migration.down(fakeKnex(db));
    expect(insp(db).base_price).toBeNull();
  });

  test('down() ignores values that drifted after up()', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    insp(db).base_price = 80;
    await migration.down(fakeKnex(db));
    expect(insp(db).base_price).toBe(80);
    expect(insp(db).description).toBe(LEGACY_DESCRIPTION);
  });

  test('missing table or row is a no-op', async () => {
    await expect(migration.up(fakeKnex({}))).resolves.toBeUndefined();
    await expect(migration.up(fakeKnex({ services: [], system_settings: [] }))).resolves.toBeUndefined();
    await expect(migration.down(fakeKnex({}))).resolves.toBeUndefined();
  });
});
