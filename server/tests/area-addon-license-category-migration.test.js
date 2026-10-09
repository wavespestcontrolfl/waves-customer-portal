/**
 * 20261008210000: the five chemical area add-on catalog rows require a
 * licensed applicator (L&O), so closeout-status checks the technician's
 * license; the labor-only web sweep does not. Only rows still in the state
 * 20261008200000 wrote are changed, and down() restores only what up() changed.
 */
const migration = require('../models/migrations/20261008210000_area_addon_license_category');
const catalog = require('../models/migrations/20261008200000_area_addon_catalog_rows');

function fakeKnex(db) {
  const knex = (table) => {
    let cond = {};
    const match = (r) => Object.entries(cond).every(([k, v]) => r[k] === v);
    const q = {
      where(c) { cond = { ...cond, ...c }; return q; },
      first: async () => { const hit = (db[table] || []).find(match); return hit ? { ...hit } : undefined; },
      update: async (patch) => { (db[table] || []).filter(match).forEach((r) => Object.assign(r, patch)); },
      insert: async (row) => { (db[table] = db[table] || []).push({ ...row }); },
      del: async () => { db[table] = (db[table] || []).filter((r) => !match(r)); },
    };
    return q;
  };
  knex.schema = { hasTable: async (t) => Object.prototype.hasOwnProperty.call(db, t) };
  return knex;
}

const seeded = () => ({
  services: catalog.SERVICES.map((s, i) => ({
    id: `svc-${i}`, service_key: s.service_key, requires_license: false, license_category: null,
  })),
  system_settings: [],
});
const byKey = (db, key) => db.services.find((r) => r.service_key === key);

describe('area add-on license category migration', () => {
  beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());

  test('the five chemical add-ons require an L&O license; the web sweep does not', async () => {
    const db = seeded();
    await migration.up(fakeKnex(db));
    for (const key of migration.CHEMICAL_SERVICE_KEYS) {
      expect(byKey(db, key)).toMatchObject({ requires_license: true, license_category: 'L&O' });
    }
    expect(byKey(db, 'area_addon_web_sweep')).toMatchObject({ requires_license: false, license_category: null });
    // Every catalog row is either chemical or the web sweep: a seventh add-on must be classified here.
    expect([...migration.CHEMICAL_SERVICE_KEYS, 'area_addon_web_sweep'].sort())
      .toEqual(catalog.SERVICES.map((s) => s.service_key).sort());
  });

  test('a row an operator already edited is left alone, and down restores only what up changed', async () => {
    const db = seeded();
    Object.assign(byKey(db, 'area_addon_fire_ant_yard'), { requires_license: true, license_category: 'GHP' });
    const knex = fakeKnex(db);
    await migration.up(knex);
    await migration.up(knex); // idempotent
    expect(byKey(db, 'area_addon_fire_ant_yard').license_category).toBe('GHP');
    Object.assign(byKey(db, 'area_addon_hardscape_weed'), { license_category: 'GHP' }); // edited after up
    await migration.down(knex);
    expect(byKey(db, 'area_addon_bed_pre_emergent')).toMatchObject({ requires_license: false, license_category: null });
    expect(byKey(db, 'area_addon_fire_ant_yard')).toMatchObject({ requires_license: true, license_category: 'GHP' });
    expect(byKey(db, 'area_addon_hardscape_weed')).toMatchObject({ requires_license: true, license_category: 'GHP' });
    expect(db.system_settings).toEqual([]);
  });

  test('missing tables or rows are skipped without error', async () => {
    await expect(migration.up(fakeKnex({}))).resolves.toBeUndefined();
    const db = { services: [], system_settings: [] };
    await migration.up(fakeKnex(db));
    expect(db.system_settings).toEqual([{ key: migration.STATE_KEY, value: JSON.stringify({ services: [] }) }]);
  });
});
