/**
 * 20261010170000: the seeded area add-on pricing row gets its audit and changelog
 * records (the frozen seed migration wrote none). Written only while the row still
 * holds the seed, once; down removes only this migration's records.
 */
const migration = require('../models/migrations/20261010170000_area_addon_pricing_audit_trail');
const seed = require('../models/migrations/20261010110000_area_addon_pricing_config');

function fakeKnex(db) {
  const knex = (table) => {
    let cond = {};
    const match = (r) => Object.entries(cond).every(([k, v]) => r[k] === v);
    const q = {
      where(c) { cond = { ...cond, ...c }; return q; },
      first: async () => { const hit = (db[table] || []).find(match); return hit ? { ...hit } : undefined; },
      insert: async (row) => { db[table].push({ id: db[table].length + 1, ...row }); },
      del: async () => { db[table] = db[table].filter((r) => !match(r)); },
    };
    return q;
  };
  knex.schema = { hasTable: async (t) => Object.prototype.hasOwnProperty.call(db, t) };
  return knex;
}
const world = (data = seed.SEED) => ({
  pricing_config: [{ config_key: 'area_addon_pricing', data: JSON.stringify(data) }],
  pricing_config_audit: [],
  pricing_changelog: [],
});

describe('area add-on pricing audit trail migration', () => {
  test('writes one audit row and one changelog entry for the seeded row, once', async () => {
    const db = world();
    const knex = fakeKnex(db);
    await migration.up(knex);
    await migration.up(knex);
    expect(db.pricing_config_audit).toHaveLength(1);
    expect(db.pricing_config_audit[0]).toMatchObject({ config_key: 'area_addon_pricing', old_value: null, changed_by: migration.TAG });
    expect(JSON.parse(db.pricing_config_audit[0].new_value)).toEqual(seed.SEED);
    expect(db.pricing_config_audit[0].reason).toMatch(/owner rulings 2026-10-08/);
    expect(db.pricing_changelog).toHaveLength(1);
    expect(db.pricing_changelog[0]).toMatchObject(migration.CHANGELOG);
    expect(JSON.parse(db.pricing_changelog[0].after_value)).toEqual({ area_addon_pricing: seed.SEED });
    expect(db.pricing_changelog[0].rationale).toBeTruthy();
  });

  test('a row an operator already edited, or no row, gets no record', async () => {
    const edited = world({ ...seed.SEED, targetMargin: 0.65 });
    await migration.up(fakeKnex(edited));
    expect(edited.pricing_config_audit).toEqual([]);
    expect(edited.pricing_changelog).toEqual([]);
    const none = { pricing_config: [], pricing_config_audit: [], pricing_changelog: [] };
    await migration.up(fakeKnex(none));
    expect(none.pricing_config_audit).toEqual([]);
  });

  test('down removes only this migration\'s records; missing tables skip', async () => {
    const db = world();
    db.pricing_config_audit.push({ id: 99, config_key: 'area_addon_pricing', changed_by: 'admin', reason: 'edit' });
    db.pricing_changelog.push({ id: 98, version_from: 'v4.6', version_to: 'v4.6', changed_by: 'someone', category: 'rule', summary: 'other' });
    const knex = fakeKnex(db);
    await migration.up(knex);
    await migration.down(knex);
    expect(db.pricing_config_audit.map((r) => r.id)).toEqual([99]);
    expect(db.pricing_changelog.map((r) => r.id)).toEqual([98]);
    await expect(migration.up(fakeKnex({}))).resolves.toBeUndefined();
    await expect(migration.down(fakeKnex({}))).resolves.toBeUndefined();
  });
});
