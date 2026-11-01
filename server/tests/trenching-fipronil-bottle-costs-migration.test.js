/**
 * 20261101090000: the persisted onetime_trenching row takes SiteOne's live fipronil bottle prices (Termidor SC $174.72,
 * Taurus SC $95 per 78 oz). Only products still holding their seeded cost with no camelCase alias are rewritten;
 * admin-edited products are left alone. down() restores only what up() wrote.
 */
const migration = require('../models/migrations/20261101090000_trenching_fipronil_bottle_costs');
const constants = require('../services/pricing-engine/constants');

function fakeKnex(db) {
  const knex = (table) => {
    let cond = {};
    const match = (r) => Object.entries(cond).every(([k, v]) => r[k] === v);
    const q = {
      where(c) { cond = { ...cond, ...c }; return q; },
      forUpdate() { return q; },
      first: async () => { const hit = (db[table] || []).find(match); return hit ? { ...hit } : undefined; },
      update: async (patch) => { db[table] = db[table].map((r) => (match(r) ? { ...r, ...patch } : r)); },
      insert: async (row) => { db[table].push({ id: db[table].length + 1, ...row }); },
      del: async () => { db[table] = db[table].filter((r) => !match(r)); },
    };
    return q;
  };
  knex.fn = { now: () => 'now()' };
  knex.schema = { hasTable: async (t) => Object.prototype.hasOwnProperty.call(db, t) };
  return knex;
}

const RATES = { product_oz_per_finished_gallon_at_high_rate: 1.6, product_oz_per_finished_gallon_at_standard_rate: 0.8 };
const TALAK = { label: 'Talak 7.9 F - Bifenthrin', container_oz: 96, container_cost: 41.57 };
// The production shape read 2026-11-01 (seeded by 20260520000003, Talak rows by 20261025130000/140000).
const seeded = (termidor = { container_oz: 78, container_cost: 375, ...RATES }, taurus = { container_oz: 78, container_cost: 85, ...RATES }) => ({
  pricing_config: [{
    config_key: 'onetime_trenching',
    data: JSON.stringify({ floor: 600, per_lf_dirt: 10, products: { termidor_sc: termidor, taurus_sc: taurus, bifen_it: TALAK, talstar_p: TALAK } }),
  }],
  pricing_config_audit: [],
  pricing_changelog: [],
});
const rowOf = (db) => JSON.parse(db.pricing_config[0].data);

describe('trenching fipronil bottle costs migration', () => {
  test('the migration costs equal the trenching products in constants.js', () => {
    const products = constants.SPECIALTY.trenching.products;
    expect(migration.COSTS.termidor_sc.siteOne).toBe(products.termidor_sc.containerCost);
    expect(migration.COSTS.taurus_sc.siteOne).toBe(products.taurus_sc.containerCost);
    expect(products.termidor_sc.containerOz).toBe(78);
    expect(products.taurus_sc.containerOz).toBe(78);
  });

  test('up() rewrites the seeded costs, keeps every other key, and records itself once', async () => {
    const db = seeded();
    const before = rowOf(db);
    await migration.up(fakeKnex(db));
    const after = rowOf(db);
    expect(after.products.termidor_sc).toEqual({ ...before.products.termidor_sc, container_cost: 174.72 });
    expect(after.products.taurus_sc).toEqual({ ...before.products.taurus_sc, container_cost: 95 });
    expect(after.products.bifen_it).toEqual(TALAK);
    expect(after.products.talstar_p).toEqual(TALAK);
    expect(after.floor).toBe(600);
    expect(db.pricing_config_audit).toHaveLength(1);
    expect(db.pricing_config_audit[0]).toMatchObject({ config_key: 'onetime_trenching', changed_by: migration.TAG });
    expect(JSON.parse(db.pricing_config_audit[0].old_value)).toEqual(before);
    expect(db.pricing_changelog).toHaveLength(1);
    expect(db.pricing_changelog[0]).toMatchObject(migration.CHANGELOG);

    await migration.up(fakeKnex(db));
    expect(rowOf(db)).toEqual(after);
    expect(db.pricing_config_audit).toHaveLength(1);
    expect(db.pricing_changelog).toHaveLength(1);
  });

  test('an admin-edited or alias-shadowed product is left alone; the other one still moves', async () => {
    const edited = { container_oz: 78, container_cost: 300, ...RATES };
    const db = seeded(edited);
    await migration.up(fakeKnex(db));
    expect(rowOf(db).products.termidor_sc).toEqual(edited);
    expect(rowOf(db).products.taurus_sc.container_cost).toBe(95);

    const shadowed = { container_oz: 78, container_cost: 85, containerCost: 90, ...RATES };
    const db2 = seeded(undefined, shadowed);
    await migration.up(fakeKnex(db2));
    expect(rowOf(db2).products.taurus_sc).toEqual(shadowed);
    expect(rowOf(db2).products.termidor_sc.container_cost).toBe(174.72);
  });

  test('a row already on the SiteOne costs, or with no products, gets no write and no record', async () => {
    const db = seeded({ container_oz: 78, container_cost: 174.72, ...RATES }, { container_oz: 78, container_cost: 95, ...RATES });
    const before = db.pricing_config[0].data;
    await migration.up(fakeKnex(db));
    expect(db.pricing_config[0].data).toBe(before);
    expect(db.pricing_config_audit).toHaveLength(0);
    expect(db.pricing_changelog).toHaveLength(0);

    const bare = { pricing_config: [{ config_key: 'onetime_trenching', data: JSON.stringify({ floor: 600 }) }], pricing_config_audit: [], pricing_changelog: [] };
    await migration.up(fakeKnex(bare));
    expect(JSON.parse(bare.pricing_config[0].data)).toEqual({ floor: 600 });
    expect(bare.pricing_config_audit).toHaveLength(0);
  });

  test('down() restores only what up() wrote and keeps a later admin edit', async () => {
    const db = seeded();
    const original = rowOf(db);
    await migration.up(fakeKnex(db));
    await migration.down(fakeKnex(db));
    expect(rowOf(db)).toEqual(original);
    expect(db.pricing_config_audit).toHaveLength(0);
    expect(db.pricing_changelog).toHaveLength(0);

    const db2 = seeded();
    await migration.up(fakeKnex(db2));
    const row = rowOf(db2);
    row.products.taurus_sc = { ...row.products.taurus_sc, container_cost: 99 };
    db2.pricing_config[0].data = JSON.stringify(row);
    await migration.down(fakeKnex(db2));
    expect(rowOf(db2).products.termidor_sc.container_cost).toBe(375);
    expect(rowOf(db2).products.taurus_sc.container_cost).toBe(99);
    expect(db2.pricing_config_audit).toHaveLength(0);
  });
});
