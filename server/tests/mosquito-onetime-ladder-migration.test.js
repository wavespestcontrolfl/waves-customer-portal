/**
 * 20261025235000 — one-time mosquito $199 minimum + tapering ladder (owner
 * 2026-10-25). Locked read-modify-write like 20260926004100: the ladder moves
 * all-or-nothing from the 2026-08-08 values, `floor` is added only when
 * absent, the catalog row follows the same rule, and down() restores only
 * what its own audit rows prove it wrote, while still untouched.
 */
const migration = require('../models/migrations/20261025235000_mosquito_onetime_ladder_199');

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
  knex.schema = { hasTable: async (t) => ['pricing_config', 'pricing_config_audit', 'pricing_changelog', 'services'].includes(t) };
  knex.fn = { now: () => 'NOW' };
  return knex;
}

const LIVE_ROW = {
  SMALL: 156, STANDARD: 177, LARGE: 198, XL: 219, ESTATE: 251, ACRE_CLASS: 282, OVER_ACRE: 282,
  overAcreIncrementSqFt: 10000, overAcreIncrementPrice: 42, stationAddOn: 75, dunkAddOn: 15,
};

function freshDb({ config = LIVE_ROW, catalog = { base_price: '156.00', price_range_min: '156.00', price_range_max: '282.00' } } = {}) {
  return {
    pricing_config: [{ config_key: 'onetime_mosquito', data: JSON.stringify(config) }],
    services: [{ service_key: 'mosquito_one_time', name: 'One-Time Mosquito Control Service', ...catalog }],
    pricing_config_audit: [],
    pricing_changelog: [],
  };
}
const stored = (db) => JSON.parse(db.pricing_config[0].data);

describe('20261025235000 one-time mosquito $199 minimum + tapering ladder', () => {
  test('moves the live ladder and catalog row, adds the floor, keeps every other key; audit + changelog once', async () => {
    const db = freshDb();
    const knex = fakeKnex(db);
    await migration.up(knex);

    expect(stored(db)).toEqual({
      SMALL: 199, STANDARD: 212, LARGE: 230, XL: 255, ESTATE: 278, ACRE_CLASS: 309, OVER_ACRE: 309,
      overAcreIncrementSqFt: 10000, overAcreIncrementPrice: 26, floor: 199, stationAddOn: 75, dunkAddOn: 15,
    });
    expect(db.services[0]).toMatchObject({ base_price: 199, price_range_min: 199, price_range_max: 309, name: 'One-Time Mosquito Control Service' });
    expect(db.pricing_config_audit.map((a) => [a.config_key, a.changed_by])).toEqual([
      ['onetime_mosquito', 'migration:20261025235000'],
      ['services_mosquito_one_time', 'migration:20261025235000'],
    ]);
    expect(db.pricing_changelog).toHaveLength(1);
    expect(db.pricing_changelog[0]).toMatchObject({ category: 'rule', version_to: 'v4.9' });

    // A rerun finds nothing left at the old values and records nothing.
    await migration.up(knex);
    expect(db.pricing_config_audit).toHaveLength(2);
    expect(db.pricing_changelog).toHaveLength(1);
  });

  test('an admin-edited ladder is left whole; the floor is still added', async () => {
    const db = freshDb({ config: { ...LIVE_ROW, STANDARD: 180 } });
    await migration.up(fakeKnex(db));
    expect(stored(db)).toEqual({ ...LIVE_ROW, STANDARD: 180, floor: 199 });
    expect(db.pricing_config_audit[0].reason).toContain('ladder left alone');
  });

  test('an existing floor (admin value) is kept while the ladder moves', async () => {
    const db = freshDb({ config: { ...LIVE_ROW, floor: 179 } });
    await migration.up(fakeKnex(db));
    expect(stored(db)).toMatchObject({ SMALL: 199, ACRE_CLASS: 309, floor: 179 });
  });

  test('an admin-edited catalog row is left alone', async () => {
    const db = freshDb({ catalog: { base_price: '165.00', price_range_min: '156.00', price_range_max: '282.00' } });
    await migration.up(fakeKnex(db));
    expect(db.services[0]).toMatchObject({ base_price: '165.00', price_range_min: '156.00', price_range_max: '282.00' });
    expect(db.pricing_config_audit.map((a) => a.config_key)).toEqual(['onetime_mosquito']);
  });

  test('down() restores the untouched ladder, floor and catalog, and removes the changelog', async () => {
    const db = freshDb();
    const knex = fakeKnex(db);
    await migration.up(knex);
    await migration.down(knex);
    expect(stored(db)).toEqual(LIVE_ROW);
    expect(db.services[0]).toMatchObject({ base_price: 156, price_range_min: 156, price_range_max: 282 });
    expect(db.pricing_changelog).toHaveLength(0);
    expect(db.pricing_config_audit.map((a) => a.changed_by)).toEqual([
      'migration:20261025235000', 'migration:20261025235000',
      'migration:20261025235000:down', 'migration:20261025235000:down',
    ]);
  });

  test('down() keeps later admin edits: an edited ladder cell blocks the ladder rollback, an edited floor stays', async () => {
    const db = freshDb();
    const knex = fakeKnex(db);
    await migration.up(knex);
    db.pricing_config[0].data = JSON.stringify({ ...stored(db), XL: 260, floor: 209 });
    db.services[0].base_price = '205.00';
    await migration.down(knex);
    expect(stored(db)).toMatchObject({ SMALL: 199, XL: 260, ACRE_CLASS: 309, floor: 209 });
    expect(db.services[0].base_price).toBe('205.00');
  });

  test('down() without its own audit rows touches nothing', async () => {
    const db = freshDb({ config: { ...LIVE_ROW, ...migration.NEW_LADDER, floor: 199 } });
    await migration.down(fakeKnex(db));
    expect(stored(db)).toMatchObject({ SMALL: 199, floor: 199 });
    expect(db.pricing_config_audit).toHaveLength(0);
  });
});
