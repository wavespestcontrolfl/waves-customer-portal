/**
 * 20261006130000 — seeds ts_material_rates.fallback_bed_sqft (1200) by locked
 * read-modify-write, mirroring 20260926004100: admin-edited keys survive, an
 * existing size is never overwritten, and down() is non-destructive (an
 * admin may have saved 1,200 deliberately; codex #6012 r2).
 */
const migration = require('../models/migrations/20261006130000_ts_fallback_bed_sqft');

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

describe('20261006130000 seeds the T&S fallback bed size', () => {
  test('adds fallback_bed_sqft 1200 when absent; every other key survives; audit + changelog written once', async () => {
    const db = {
      pricing_config: [row({ fixed: 12.5, palm_per_palm_annual: 6, palm_minutes_per_visit: 1, density_heavy: 1.1 })],
      pricing_config_audit: [],
      pricing_changelog: [],
    };
    const knex = fakeKnex(db);
    await migration.up(knex);
    expect(stored(db)).toEqual({
      fixed: 12.5, palm_per_palm_annual: 6, palm_minutes_per_visit: 1, density_heavy: 1.1, fallback_bed_sqft: 1200,
    });
    expect(db.pricing_config_audit).toHaveLength(1);
    expect(db.pricing_config_audit[0]).toMatchObject({
      config_key: 'ts_material_rates', changed_by: 'migration:20261006130000', reason: migration.UP_REASON,
    });
    expect(db.pricing_changelog).toHaveLength(1);
    expect(db.pricing_changelog[0]).toMatchObject({ category: 'cost', version_to: 'v4.7' });

    // A rerun finds the key and does nothing.
    await migration.up(knex);
    expect(db.pricing_config_audit).toHaveLength(1);
    expect(db.pricing_changelog).toHaveLength(1);
  });

  test('an existing size (admin edit) is left alone and nothing is recorded', async () => {
    const db = { pricing_config: [row({ fixed: 15, fallback_bed_sqft: 1500 })], pricing_config_audit: [], pricing_changelog: [] };
    await migration.up(fakeKnex(db));
    expect(stored(db).fallback_bed_sqft).toBe(1500);
    expect(db.pricing_config_audit).toHaveLength(0);
    expect(db.pricing_changelog).toHaveLength(0);
  });

  test('down() is non-destructive: the seeded value, an admin re-save of 1200 and the changelog all stay', async () => {
    const db = { pricing_config: [row({ fixed: 15 })], pricing_config_audit: [], pricing_changelog: [] };
    const knex = fakeKnex(db);
    await migration.up(knex);
    const before = JSON.stringify(db);
    await migration.down(knex);
    expect(JSON.stringify(db)).toBe(before);
    expect(stored(db).fallback_bed_sqft).toBe(1200);
  });

  test('down() without its own audit row touches nothing', async () => {
    const db = { pricing_config: [row({ fixed: 15, fallback_bed_sqft: 1200 })], pricing_config_audit: [], pricing_changelog: [] };
    await migration.down(fakeKnex(db));
    expect(stored(db).fallback_bed_sqft).toBe(1200);
    expect(db.pricing_config_audit).toHaveLength(0);
  });
});
