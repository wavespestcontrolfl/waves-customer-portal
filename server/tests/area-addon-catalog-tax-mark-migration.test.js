/**
 * 20261008240000: the six area add-on catalog rows read "not taxable" in the
 * Service Library, per the owner's rule (lawn care and every residential
 * service is non-taxable; the column is display only). Rows already false are
 * left alone, and down() restores only what up() changed.
 */
const migration = require('../models/migrations/20261008240000_area_addon_catalog_tax_mark');
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
  services: catalog.SERVICES.map((s, i) => ({ id: `svc-${i}`, service_key: s.service_key, is_taxable: true })),
  system_settings: [],
});

describe('area add-on catalog tax mark migration', () => {
  test('covers every add-on catalog row', () => {
    expect([...migration.SERVICE_KEYS].sort()).toEqual(catalog.SERVICES.map((s) => s.service_key).sort());
  });

  test('all six rows read not taxable; a replay changes nothing more', async () => {
    const db = seeded();
    const knex = fakeKnex(db);
    await migration.up(knex);
    await migration.up(knex);
    expect(db.services.every((r) => r.is_taxable === false)).toBe(true);
    expect(JSON.parse(db.system_settings[0].value).services).toHaveLength(6);
  });

  test('a row already false is not recorded, and down restores only what up changed', async () => {
    const db = seeded();
    db.services[0].is_taxable = false;
    const knex = fakeKnex(db);
    await migration.up(knex);
    db.services[1].is_taxable = true; // an operator set it back after up
    await migration.down(knex);
    expect(db.services[0].is_taxable).toBe(false);
    expect(db.services.slice(1).every((r) => r.is_taxable === true)).toBe(true);
    expect(db.system_settings).toEqual([]);
  });

  test('missing tables skip without error', async () => {
    await expect(migration.up(fakeKnex({}))).resolves.toBeUndefined();
    await expect(migration.down(fakeKnex({}))).resolves.toBeUndefined();
  });
});
