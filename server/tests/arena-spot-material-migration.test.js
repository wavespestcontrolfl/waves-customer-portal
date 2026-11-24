/**
 * 20261120201500 — Lawn Insect Spot Treatment prices Arena 50 WDG at the 2026-11-20 SiteOne price (owner "fix these").
 * Locked read-modify-write like 20261104210000: the material cost moves only from the seeded 1.45, every other key and
 * add-on stays, and down() restores only what its own audit row proves it wrote, while still untouched.
 */
const migration = require('../models/migrations/20261120201500_arena_spot_material_per_1000');
const seed = require('../models/migrations/20261010110000_area_addon_pricing_config');
const { areaAddOnPricingDefaults } = require('../services/pricing-engine/constants');

function fakeKnex(db) {
  const knex = (table) => {
    const rows = () => (db[table] = db[table] || []);
    const filters = [];
    let order = null;
    const matches = (r) => filters.every((f) => f(r));
    const q = {
      where(cond) { filters.push((r) => Object.entries(cond).every(([k, v]) => r[k] === v)); return q; },
      forUpdate() { return q; },
      orderBy(col, dir) { order = { col, dir }; return q; },
      async select() {
        let found = rows().filter(matches);
        if (order) found = [...found].sort((a, b) => (order.dir === 'desc' ? b[order.col] - a[order.col] : a[order.col] - b[order.col]));
        return found.map((r) => ({ ...r }));
      },
      async first() {
        const found = await q.select();
        return found[0] || null;
      },
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

const copy = (value) => JSON.parse(JSON.stringify(value));
const withSpot = (data, materialPer1000) => ({ ...data, items: { ...data.items, lawn_insect_spot: { ...data.items.lawn_insect_spot, materialPer1000 } } });
const freshDb = (data = seed.SEED) => ({
  pricing_config: [{ config_key: 'area_addon_pricing', data: JSON.stringify(data) }],
  pricing_config_audit: [],
  pricing_changelog: [],
});
const stored = (db) => JSON.parse(db.pricing_config[0].data);

describe('20261120201500 Arena spot material 1.45 -> 1.09', () => {
  test('the new value is the code default: 0.147 oz per 1,000 sq ft at $296.88 for 40 oz', () => {
    expect(migration.NEW_MATERIAL).toBe(areaAddOnPricingDefaults().items.lawn_insect_spot.materialPer1000);
    expect(migration.NEW_MATERIAL).toBeCloseTo((296.88 / 40) * 0.147, 2);
    expect(migration.OLD_MATERIAL).toBe(seed.SEED.items.lawn_insect_spot.materialPer1000);
  });

  test('moves only the seeded spot material; audit + changelog once', async () => {
    const db = freshDb();
    const knex = fakeKnex(db);
    await migration.up(knex);

    expect(stored(db)).toEqual(withSpot(copy(seed.SEED), 1.09));
    expect(db.pricing_config_audit.map((a) => [a.config_key, a.changed_by])).toEqual([['area_addon_pricing', 'migration:20261120201500']]);
    expect(JSON.parse(db.pricing_config_audit[0].old_value)).toEqual(copy(seed.SEED));
    expect(db.pricing_changelog).toHaveLength(1);
    expect(db.pricing_changelog[0]).toMatchObject({ category: 'cost', version_to: 'v4.9' });

    // A rerun finds nothing left at the old value and records nothing.
    await migration.up(knex);
    expect(db.pricing_config_audit).toHaveLength(1);
    expect(db.pricing_changelog).toHaveLength(1);
  });

  test('an admin-set value, or a row without the add-on, is left alone', async () => {
    const edited = freshDb(withSpot(copy(seed.SEED), 1.3));
    await migration.up(fakeKnex(edited));
    expect(stored(edited).items.lawn_insect_spot.materialPer1000).toBe(1.3);
    expect(edited.pricing_config_audit).toHaveLength(0);

    const { lawn_insect_spot: _gone, ...otherItems } = copy(seed.SEED).items;
    const missing = freshDb({ ...copy(seed.SEED), items: otherItems });
    await migration.up(fakeKnex(missing));
    expect(stored(missing).items).toEqual(otherItems);
    expect(missing.pricing_config_audit).toHaveLength(0);
    expect(missing.pricing_changelog).toHaveLength(0);
  });

  test('down() restores the untouched value and removes the changelog', async () => {
    const db = freshDb();
    const knex = fakeKnex(db);
    await migration.up(knex);
    await migration.down(knex);
    expect(stored(db)).toEqual(copy(seed.SEED));
    expect(db.pricing_changelog).toHaveLength(0);
    expect(db.pricing_config_audit.map((a) => a.changed_by)).toEqual(['migration:20261120201500', 'migration:20261120201500:down']);
  });

  // Codex pre-push P1: an admin who moves the material away and back to 1.09 owns that value; an edit of another field does not.
  test('down() keeps an admin value that equals 1.09 again, but still restores past an edit of another field', async () => {
    const adminEdit = (db, next) => {
      const prev = stored(db);
      db.pricing_config[0].data = JSON.stringify(next);
      db.pricing_config_audit.push({ id: db.pricing_config_audit.length + 1, config_key: 'area_addon_pricing', old_value: JSON.stringify(prev), new_value: JSON.stringify(next), changed_by: 'admin' });
    };
    const roundTrip = freshDb();
    await migration.up(fakeKnex(roundTrip));
    adminEdit(roundTrip, withSpot(stored(roundTrip), 1.2));
    adminEdit(roundTrip, withSpot(stored(roundTrip), 1.09));
    await migration.down(fakeKnex(roundTrip));
    expect(stored(roundTrip).items.lawn_insect_spot.materialPer1000).toBe(1.09);
    expect(roundTrip.pricing_config_audit.map((a) => a.changed_by)).toEqual(['migration:20261120201500', 'admin', 'admin']);

    const other = freshDb();
    await migration.up(fakeKnex(other));
    adminEdit(other, { ...stored(other), targetMargin: 0.55 });
    await migration.down(fakeKnex(other));
    expect(stored(other)).toEqual({ ...copy(seed.SEED), targetMargin: 0.55 });
  });

  test('down() keeps a later admin edit, and touches nothing without its own audit row', async () => {
    const db = freshDb();
    const knex = fakeKnex(db);
    await migration.up(knex);
    db.pricing_config[0].data = JSON.stringify(withSpot(stored(db), 1.2));
    await migration.down(knex);
    expect(stored(db).items.lawn_insect_spot.materialPer1000).toBe(1.2);
    expect(db.pricing_config_audit).toHaveLength(1);

    const untouched = freshDb(withSpot(copy(seed.SEED), 1.09));
    await migration.down(fakeKnex(untouched));
    expect(stored(untouched).items.lawn_insect_spot.materialPer1000).toBe(1.09);
    expect(untouched.pricing_config_audit).toHaveLength(0);
  });
});
