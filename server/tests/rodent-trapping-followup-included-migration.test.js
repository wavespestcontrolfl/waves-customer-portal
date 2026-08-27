/**
 * 20260826000006: rodent_trapping_followup becomes a $0 included callback.
 * Value-guarded both ways.
 */
const migration = require('../models/migrations/20260826000006_rodent_trapping_followup_included');

const { LEGACY_PRICE, NEW_PRICE, LEGACY_DESCRIPTION, NEW_DESCRIPTION, LEGACY_INTERNAL_NOTES, NEW_INTERNAL_NOTES } = migration;
const STATE_KEY = 'migration.20260826000006.state';

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
  services: [{ id: 'svc-fu', service_key: 'rodent_trapping_followup', base_price: LEGACY_PRICE, description: LEGACY_DESCRIPTION, internal_notes: LEGACY_INTERNAL_NOTES, ...overrides }],
  system_settings: [],
});
const fu = (db) => db.services[0];
const stateRow = (db) => db.system_settings.find((r) => r.key === STATE_KEY);

describe('20260826000006 rodent_trapping_followup included at $0', () => {
  test('up() zeroes the seeded price and rewrites the copy; down() restores both', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    expect(fu(db).base_price).toBe(NEW_PRICE);
    expect(fu(db).description).toBe(NEW_DESCRIPTION);
    expect(fu(db).internal_notes).toBe(NEW_INTERNAL_NOTES);
    await migration.down(fakeKnex(db));
    expect(fu(db).base_price).toBe(LEGACY_PRICE);
    expect(fu(db).description).toBe(LEGACY_DESCRIPTION);
    expect(fu(db).internal_notes).toBe(LEGACY_INTERNAL_NOTES);
    expect(stateRow(db)).toBeUndefined();
  });

  test('an admin-edited NONZERO price still goes to $0 (any billable callback is wrong); custom copy is kept; down() restores the edited price', async () => {
    const db = seedDb({ base_price: 60, description: 'Custom follow-up copy' });
    await migration.up(fakeKnex(db));
    expect(fu(db).base_price).toBe(0);
    expect(fu(db).description).toBe('Custom follow-up copy');
    expect(JSON.parse(stateRow(db).value)).toMatchObject({ priceChanged: true, priorPrice: 60, descriptionChanged: false });
    await migration.down(fakeKnex(db));
    expect(fu(db).base_price).toBe(60);
  });

  test('a row already priced NULL/variable still gets the included copy', async () => {
    const db = seedDb({ base_price: null });
    await migration.up(fakeKnex(db));
    expect(fu(db).base_price).toBeNull();
    expect(fu(db).description).toBe(NEW_DESCRIPTION);
    expect(JSON.parse(stateRow(db).value)).toMatchObject({ priceChanged: false, descriptionChanged: true });
  });

  test('missing table or row is a no-op', async () => {
    await expect(migration.up(fakeKnex({}))).resolves.toBeUndefined();
    await expect(migration.up(fakeKnex({ services: [], system_settings: [] }))).resolves.toBeUndefined();
    await expect(migration.down(fakeKnex({}))).resolves.toBeUndefined();
  });
});
