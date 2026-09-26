/**
 * 20260926004100 — seeds ts_material_rates.palm_large_factor (proposed 2.5)
 * by locked read-modify-write, mirroring 20260809000001: admin-edited keys
 * survive, an existing factor is never overwritten, and down() removes only
 * the value its own audit row proves it wrote, while still untouched.
 */
const migration = require('../models/migrations/20260926004100_ts_large_palm_factor');

function fakeKnex(db) {
  const knex = (table) => {
    const rows = () => (db[table] = db[table] || []);
    const filters = [];
    const matches = (r) => filters.every((f) => f(r));
    const q = {
      where(cond) { filters.push((r) => Object.entries(cond).every(([k, v]) => r[k] === v)); return q; },
      forUpdate() { return q; },
      orderBy() { return q; },
      async first() { const r = rows().find(matches); return r ? { ...r } : null; },
      async update(patch) { let n = 0; for (const r of rows()) if (matches(r)) { Object.assign(r, patch); n++; } return n; },
      async insert(row) { rows().push({ id: rows().length + 1, ...row }); return [row]; },
      async del() { const keep = rows().filter((r) => !matches(r)); const n = rows().length - keep.length; db[table] = keep; return n; },
    };
    return q;
  };
  knex.schema = { hasTable: async (t) => ['pricing_config', 'pricing_config_audit', 'pricing_changelog'].includes(t) };
  knex.fn = { now: () => 'NOW' };
  return knex;
}

const row = (data) => ({ config_key: 'ts_material_rates', data: JSON.stringify(data) });
const stored = (db) => JSON.parse(db.pricing_config[0].data);

describe('20260926004100 seeds the T&S large-palm factor', () => {
  test('adds palm_large_factor 2.5 when absent; every other key survives; audit + changelog written once', async () => {
    const db = {
      pricing_config: [row({ fixed: 12.5, palm_per_palm_annual: 6, palm_minutes_per_visit: 1, density_heavy: 1.1 })],
      pricing_config_audit: [],
      pricing_changelog: [],
    };
    const knex = fakeKnex(db);
    await migration.up(knex);
    expect(stored(db)).toEqual({
      fixed: 12.5, palm_per_palm_annual: 6, palm_minutes_per_visit: 1, density_heavy: 1.1, palm_large_factor: 2.5,
    });
    expect(db.pricing_config_audit).toHaveLength(1);
    expect(db.pricing_config_audit[0]).toMatchObject({
      config_key: 'ts_material_rates', changed_by: 'migration:20260926004100', reason: migration.UP_REASON,
    });
    expect(db.pricing_changelog).toHaveLength(1);
    expect(db.pricing_changelog[0]).toMatchObject({ category: 'cost', version_to: 'v4.7' });

    // A rerun finds the key and does nothing.
    await migration.up(knex);
    expect(db.pricing_config_audit).toHaveLength(1);
    expect(db.pricing_changelog).toHaveLength(1);
  });

  test('an existing factor (admin edit) is left alone and nothing is recorded', async () => {
    const db = { pricing_config: [row({ fixed: 15, palm_large_factor: 3 })], pricing_config_audit: [], pricing_changelog: [] };
    await migration.up(fakeKnex(db));
    expect(stored(db).palm_large_factor).toBe(3);
    expect(db.pricing_config_audit).toHaveLength(0);
    expect(db.pricing_changelog).toHaveLength(0);
  });

  test('down() removes only its own untouched seed; an owner-edited factor survives rollback', async () => {
    const db = { pricing_config: [row({ fixed: 15 })], pricing_config_audit: [], pricing_changelog: [] };
    const knex = fakeKnex(db);
    await migration.up(knex);
    await migration.down(knex);
    expect(stored(db)).toEqual({ fixed: 15 });
    expect(db.pricing_changelog).toHaveLength(0);

    const edited = { pricing_config: [row({ fixed: 15 })], pricing_config_audit: [], pricing_changelog: [] };
    const editedKnex = fakeKnex(edited);
    await migration.up(editedKnex);
    edited.pricing_config[0].data = JSON.stringify({ ...stored(edited), palm_large_factor: 3 });
    await migration.down(editedKnex);
    expect(stored(edited).palm_large_factor).toBe(3);
  });

  test('down() without its own audit row touches nothing', async () => {
    const db = { pricing_config: [row({ fixed: 15, palm_large_factor: 2.5 })], pricing_config_audit: [], pricing_changelog: [] };
    await migration.down(fakeKnex(db));
    expect(stored(db).palm_large_factor).toBe(2.5);
    expect(db.pricing_config_audit).toHaveLength(0);
  });
});
