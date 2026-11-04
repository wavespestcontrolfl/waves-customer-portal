/**
 * 20261104210000 — one-time lawn uses the one-time pest multiple (owner
 * 2026-11-04). Locked read-modify-write like 20261025235000: the multiplier
 * moves only from the seeded 1.5, production's 2.2 (the owner-requested edit)
 * records nothing, and down() restores only what its own audit row proves it
 * wrote, while still untouched.
 */
const migration = require('../models/migrations/20261104210000_onetime_lawn_multiplier_2_2');

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
      async first() {
        let found = rows().filter(matches);
        if (order) found = [...found].sort((a, b) => (order.dir === 'desc' ? b[order.col] - a[order.col] : a[order.col] - b[order.col]));
        return found[0] ? { ...found[0] } : null;
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

// The row 20260515000002 seeds, which fresh and preview databases still hold.
const SEEDED_ROW = {
  floor: 115,
  fungicide_floor: 115,
  recurringPerAppMultiplier: 1.5,
  treatment_multipliers: { fert: 1, fertilization: 1, weed: 1.12, pest: 1.3, fungicide: 1.38 },
};

function freshDb(config = SEEDED_ROW) {
  return {
    pricing_config: [{ config_key: 'onetime_lawn', data: JSON.stringify(config) }],
    pricing_config_audit: [],
    pricing_changelog: [],
  };
}
const stored = (db) => JSON.parse(db.pricing_config[0].data);

describe('20261104210000 one-time lawn multiplier 1.5 -> 2.2', () => {
  test('moves the seeded multiplier, keeps every other key; audit + changelog once', async () => {
    const db = freshDb();
    const knex = fakeKnex(db);
    await migration.up(knex);

    expect(stored(db)).toEqual({ ...SEEDED_ROW, recurringPerAppMultiplier: 2.2 });
    expect(db.pricing_config_audit.map((a) => [a.config_key, a.changed_by])).toEqual([
      ['onetime_lawn', 'migration:20261104210000'],
    ]);
    expect(db.pricing_changelog).toHaveLength(1);
    expect(db.pricing_changelog[0]).toMatchObject({ category: 'rule', version_to: 'v4.9' });

    // A rerun finds nothing left at the old value and records nothing.
    await migration.up(knex);
    expect(db.pricing_config_audit).toHaveLength(1);
    expect(db.pricing_changelog).toHaveLength(1);
  });

  test('a row already at 2.2 (production after the owner-requested edit) records nothing', async () => {
    const db = freshDb({ ...SEEDED_ROW, recurringPerAppMultiplier: 2.2 });
    await migration.up(fakeKnex(db));
    expect(stored(db)).toEqual({ ...SEEDED_ROW, recurringPerAppMultiplier: 2.2 });
    expect(db.pricing_config_audit).toHaveLength(0);
    expect(db.pricing_changelog).toHaveLength(0);
  });

  test('an admin-set multiplier is left alone', async () => {
    const db = freshDb({ ...SEEDED_ROW, recurringPerAppMultiplier: 1.8 });
    await migration.up(fakeKnex(db));
    expect(stored(db).recurringPerAppMultiplier).toBe(1.8);
    expect(db.pricing_config_audit).toHaveLength(0);
  });

  test('a legacy markup_multiplier row moves the way db-bridge reads it; down() removes the added key', async () => {
    const { recurringPerAppMultiplier: _seeded, ...legacy } = SEEDED_ROW;
    const db = freshDb({ ...legacy, markup_multiplier: 1.5 });
    const knex = fakeKnex(db);
    await migration.up(knex);
    expect(stored(db)).toEqual({ ...legacy, markup_multiplier: 1.5, recurringPerAppMultiplier: 2.2 });
    await migration.down(knex);
    expect(stored(db)).toEqual({ ...legacy, markup_multiplier: 1.5 });
  });

  test('down() restores the untouched multiplier and removes the changelog', async () => {
    const db = freshDb();
    const knex = fakeKnex(db);
    await migration.up(knex);
    await migration.down(knex);
    expect(stored(db)).toEqual(SEEDED_ROW);
    expect(db.pricing_changelog).toHaveLength(0);
    expect(db.pricing_config_audit.map((a) => a.changed_by)).toEqual([
      'migration:20261104210000', 'migration:20261104210000:down',
    ]);
  });

  test('down() keeps a later admin edit', async () => {
    const db = freshDb();
    const knex = fakeKnex(db);
    await migration.up(knex);
    db.pricing_config[0].data = JSON.stringify({ ...stored(db), recurringPerAppMultiplier: 2.5 });
    await migration.down(knex);
    expect(stored(db).recurringPerAppMultiplier).toBe(2.5);
    expect(db.pricing_config_audit).toHaveLength(1);
  });

  test('down() without its own audit row touches nothing', async () => {
    const db = freshDb({ ...SEEDED_ROW, recurringPerAppMultiplier: 2.2 });
    await migration.down(fakeKnex(db));
    expect(stored(db).recurringPerAppMultiplier).toBe(2.2);
    expect(db.pricing_config_audit).toHaveLength(0);
  });
});
