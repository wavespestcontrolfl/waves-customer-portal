// Real migrated PostgreSQL: the production catalog shape (2026-09-07 export) in a
// throwaway schema, rolled back after every test. Proves 20260907000018 finishes
// the two LESCO clusters and that 20260907000021 + 20260907000100 then run clean.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.mock('../models/db', () => jest.fn(() => { throw new Error('Migrations must use the supplied transaction'); }));
const knex = require('knex');
const { randomUUID } = require('node:crypto');
const migration = require('../models/migrations/20260907000018_finish_lesco_cluster_dedupe');
const dimensions = require('../models/migrations/20260907000021_lawn_cost_inventory_dimensions');
const canonical = require('../models/migrations/20260907000100_canonical_lawn_cost_dimensions');

const SOURCE = 'finish_lesco_cluster_dedupe_20260907';
const TABLES = ['products_catalog', 'product_aliases', 'distributor_product_map', 'audit_log', 'product_inventory_movements'];
const SITEONE = randomUUID();
const KEEPER_IRON = 'LESCO Chelated Iron Plus';
const DUP_IRON = 'LESCO 12-0-0 Chelated Iron Plus';
const KEEPER_KFLOW = 'LESCO K-Flow 0-0-25 17% S Turfgrass Liquid Fertilizer';
const DUP_KFLOW = 'LESCO K-Flow 0-0-25';
// [name, active, container_size, unit_size_oz, best_price, cost_unit, cost_per_unit, inventory_unit, inventory_on_hand]
const PROD_ROWS = [
  ['Armada 50 WDG', true, '2 lb', 32, 134.95, null, null, null, null],
  [DUP_IRON, true, '2.5 gal', 320, 35.27, 'oz', 0.1087, null, null],
  [KEEPER_IRON, true, null, 320, 34.80, null, null, null, null],
  ['LESCO Chelated Iron Plus 12-0-0 2% Mn 6% Fe 4% S All Purpose Liquid Fertilizer', false, '2.5 gal', 320, 34.60, null, null, null, null],
  ['LESCO Chelated Iron Plus 12-0-0 6%Fe 2%Mn', false, '2.5 gal', 320, 35.45, null, null, null, null],
  ['LESCO Chelated Iron Plus 12-0-0 6% Fe 2% Mn All Purpose Liquid Fertilizer', false, '2.5 gal', 320, 35.41, null, null, 'fl_oz', 320],
  [DUP_KFLOW, true, '2.5 gal', 320, 38.95, 'oz', 0.1188, 'fl_oz', 320],
  [KEEPER_KFLOW, true, '2.5 gal', 320, 38.05, null, null, null, null],
  ['Primo Maxx', false, '1 gal', 128, 330, 'oz', 2.5, null, null],
  ['Primo Maxx Plant Growth Regulator for Turf', true, '1 gal', 128, 320, null, null, null, null],
  ['Prodiamine 65 WDG', true, '5 lb', 80, 68.43, null, null, 'lb', 5],
  ['SpeedZone Southern', true, '2.5 gal', 320, 192.50, 'oz', 0.6016, 'fl_oz', 320],
  ['SpeedZone Southern EW', false, '2.5 gal', 320, 192.50, null, null, null, null],
];
// A repository-seeded catalog: no imported keepers, May prices still consistent.
const FRESH_ROWS = [
  ['Prodiamine 65 WDG', true, '5 lb', 80, 68.43, null, null, 'lb', 5],
  ['Armada 50 WDG', true, '2 lb', 32, 134.95, null, null, null, null],
  ['SpeedZone Southern', true, '2.5 gal', 320, 192.50, 'oz', 0.6016, null, null],
  [DUP_IRON, true, '2.5 gal', 320, 34.80, 'oz', 0.1087, null, null],
  [DUP_KFLOW, true, '2.5 gal', 320, 38.02, 'oz', 0.1188, null, null],
  ['Primo Maxx', true, '1 gal', 128, 320, 'oz', 2.5, null, null],
];

let db;
jest.setTimeout(60000);

async function inRollback(work) {
  const rollback = new Error('intentional test rollback');
  try {
    await db.transaction(async (trx) => {
      const schema = `lesco_${randomUUID().replaceAll('-', '')}`;
      await trx.raw('CREATE SCHEMA ??', [schema]);
      for (const table of TABLES) await trx.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
      await trx.raw('SET LOCAL search_path TO ??, public', [schema]);
      await work(trx);
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

async function seed(trx, rows, { aliases = true, maps = true } = {}) {
  const ids = {};
  for (const [name, active, container_size, unit_size_oz, best_price, cost_unit, cost_per_unit, inventory_unit, inventory_on_hand] of rows) {
    ids[name] = randomUUID();
    await trx('products_catalog').insert({ id: ids[name], name, active, container_size, unit_size_oz, best_price,
      cost_unit, cost_per_unit, inventory_unit, inventory_on_hand, low_stock_threshold: null });
  }
  if (aliases && ids[KEEPER_IRON]) {
    for (const [product, alias_name] of [[KEEPER_IRON, 'Chelated Iron Plus'], [KEEPER_IRON, 'LESCO Iron Plus'], [KEEPER_KFLOW, 'K-Flow'], [DUP_IRON, 'Iron Plus 12-0-0']]) {
      await trx('product_aliases').insert({ product_id: ids[product], alias_name });
    }
  }
  if (maps && ids[DUP_IRON]) {
    await trx('distributor_product_map').insert({ product_id: ids[DUP_IRON], vendor_id: SITEONE, distributor_sku: '084043' });
    await trx('distributor_product_map').insert({ product_id: ids[DUP_KFLOW], vendor_id: SITEONE, distributor_sku: '9999901234' });
  }
  return ids;
}
const row = (trx, name) => trx('products_catalog').where({ name }).first();
const num = (value) => (value == null ? null : Number(value));
const audits = (trx) => trx('audit_log').where({ action: SOURCE });

postgres('finish LESCO cluster dedupe against migrated PostgreSQL', () => {
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || !/^\/(waves_test|waves_qa_[a-f0-9]+)$/.test(url.pathname)) {
      throw new Error('Use disposable CI or a synthetic Waves QA database');
    }
    db = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 1 } });
  });
  afterAll(async () => { if (db) await db.destroy(); });

  test('production shape: retires both duplicates, fills the keeper package, moves aliases and SKU maps, then both cost migrations run clean', async () => inRollback(async (trx) => {
    const ids = await seed(trx, PROD_ROWS);
    const before = Object.fromEntries((await trx('products_catalog')).map((r) => [r.name, r]));
    await migration.up(trx);

    const dupIron = await row(trx, DUP_IRON);
    const dupKflow = await row(trx, DUP_KFLOW);
    const keeperIron = await row(trx, KEEPER_IRON);
    const keeperKflow = await row(trx, KEEPER_KFLOW);
    expect(dupIron.active).toBe(false);
    expect(dupKflow.active).toBe(false);
    expect(keeperIron).toMatchObject({ active: true, container_size: '2.5 gal', cost_per_unit: null });
    expect(keeperKflow).toMatchObject({ active: true, container_size: '2.5 gal', cost_per_unit: null });
    // Nothing else moved: every price, cost, unit and stock figure is byte-identical.
    for (const r of await trx('products_catalog')) {
      const prior = before[r.name];
      for (const field of ['best_price', 'cost_unit', 'cost_per_unit', 'unit_size_oz', 'inventory_unit', 'inventory_on_hand', 'low_stock_threshold']) {
        expect(r[field]).toEqual(prior[field]);
      }
      if (![DUP_IRON, DUP_KFLOW].includes(r.name)) expect(r.active).toBe(prior.active);
      if (r.name !== KEEPER_IRON) expect(r.container_size).toBe(prior.container_size);
    }
    expect((await trx('product_aliases').where({ product_id: ids[KEEPER_IRON] }).pluck('alias_name')).sort())
      .toEqual(['Chelated Iron Plus', 'Iron Plus 12-0-0', DUP_IRON, 'LESCO Iron Plus'].sort());
    expect((await trx('product_aliases').where({ product_id: ids[KEEPER_KFLOW] }).pluck('alias_name')).sort())
      .toEqual(['K-Flow', DUP_KFLOW].sort());
    expect(await trx('product_aliases').whereIn('product_id', [ids[DUP_IRON], ids[DUP_KFLOW]])).toHaveLength(0);
    expect(await trx('distributor_product_map').where({ product_id: ids[KEEPER_IRON] })).toMatchObject([{ vendor_id: SITEONE, distributor_sku: '084043' }]);
    expect(await trx('distributor_product_map').where({ product_id: ids[KEEPER_KFLOW] })).toHaveLength(1);
    expect(await trx('distributor_product_map').whereIn('product_id', [ids[DUP_IRON], ids[DUP_KFLOW]])).toHaveLength(0);
    const auditRows = await audits(trx);
    expect(auditRows).toHaveLength(4);
    expect(auditRows.map((a) => a.resource_id).sort()).toEqual([ids[KEEPER_IRON], ids[DUP_IRON], ids[KEEPER_KFLOW], ids[DUP_KFLOW]].sort());
    expect(auditRows.find((a) => a.resource_id === ids[KEEPER_IRON]).metadata).toMatchObject({
      role: 'keeper', keeperUpdates: { container_size: '2.5 gal' }, duplicateRetired: true, aliasesMoved: 1, aliasAdded: true, distributorMapsMoved: 1 });
    expect(auditRows.find((a) => a.resource_id === ids[DUP_KFLOW]).metadata).toMatchObject({ role: 'retired_duplicate', costPerUnit: '0.1188', inventoryOnHand: '320.0000' });

    // The two migrations that stopped every production deploy now run through.
    await dimensions.up(trx);
    await canonical.up(trx);
    expect((await row(trx, 'Armada 50 WDG')).inventory_unit).toBe('lb');
    expect((await row(trx, KEEPER_IRON)).inventory_unit).toBe('fl_oz');
    expect((await row(trx, KEEPER_KFLOW)).inventory_unit).toBe('fl_oz');
    expect((await row(trx, 'Primo Maxx Plant Growth Regulator for Turf')).inventory_unit).toBe('fl_oz');
    expect(await row(trx, DUP_IRON)).toMatchObject({ active: false, inventory_unit: null, cost_per_unit: '0.1087' });
    expect(await row(trx, DUP_KFLOW)).toMatchObject({ active: false, inventory_unit: 'fl_oz', cost_per_unit: '0.1188' });
    expect(num((await row(trx, KEEPER_IRON)).best_price)).toBe(34.80);
    expect(num((await row(trx, KEEPER_KFLOW)).best_price)).toBe(38.05);

    // Re-running adds nothing.
    await migration.up(trx);
    expect(await audits(trx)).toHaveLength(4);
  }));

  test('repository-seeded catalog without imported keepers is left alone and both cost migrations still pass', async () => inRollback(async (trx) => {
    await seed(trx, FRESH_ROWS, { aliases: false, maps: false });
    await migration.up(trx);
    expect(await audits(trx)).toHaveLength(0);
    expect((await row(trx, DUP_IRON)).active).toBe(true);
    await dimensions.up(trx);
    await canonical.up(trx);
    expect((await row(trx, DUP_IRON)).inventory_unit).toBe('fl_oz');
    expect((await row(trx, DUP_KFLOW)).inventory_unit).toBe('fl_oz');
  }));

  test('fills only a missing keeper package and audits the keeper alone when the duplicate is already retired', async () => inRollback(async (trx) => {
    const rows = PROD_ROWS.map((r) => (r[0] === DUP_IRON || r[0] === DUP_KFLOW ? [r[0], false, ...r.slice(2)] : r));
    const ids = await seed(trx, rows, { aliases: false, maps: false });
    await migration.up(trx);
    expect((await row(trx, KEEPER_IRON)).container_size).toBe('2.5 gal');
    const auditRows = await audits(trx);
    expect(auditRows.map((a) => a.resource_id)).toEqual([ids[KEEPER_IRON]]);
    expect(auditRows[0].metadata).toMatchObject({ duplicateRetired: false, keeperUpdates: { container_size: '2.5 gal' } });
    await migration.up(trx);
    expect(await audits(trx)).toHaveLength(1);
  }));

  test('refuses conflicting package evidence on the keeper', async () => inRollback(async (trx) => {
    await seed(trx, PROD_ROWS.map((r) => (r[0] === KEEPER_IRON ? [r[0], true, '1 gal', ...r.slice(3)] : r)));
    await expect(migration.up(trx)).rejects.toThrow('Package evidence conflicts: LESCO Chelated Iron Plus');
    expect(await audits(trx)).toHaveLength(0);
  }));

  test('refuses a keeper whose unit size does not prove the package', async () => inRollback(async (trx) => {
    await seed(trx, PROD_ROWS.map((r) => (r[0] === KEEPER_IRON ? [r[0], true, null, 128, ...r.slice(4)] : r)));
    await expect(migration.up(trx)).rejects.toThrow('Package size needs review: LESCO Chelated Iron Plus');
  }));

  test('refuses a retired keeper and a distributor map conflict', async () => inRollback(async (trx) => {
    const ids = await seed(trx, PROD_ROWS.map((r) => (r[0] === KEEPER_KFLOW ? [r[0], false, ...r.slice(2)] : r)));
    await expect(migration.up(trx)).rejects.toThrow('Keeper is retired: LESCO K-Flow 0-0-25 17% S Turfgrass Liquid Fertilizer');
    // The iron cluster ahead of it was retired before the K-Flow assertion; a real
    // migration run rolls the whole batch back, which the schema rollback mirrors.
    expect((await row(trx, DUP_IRON)).active).toBe(false);
    await trx('products_catalog').where({ id: ids[KEEPER_KFLOW] }).update({ active: true });
    await trx('distributor_product_map').insert({ product_id: ids[KEEPER_KFLOW], vendor_id: SITEONE, distributor_sku: 'other' });
    await expect(migration.up(trx)).rejects.toThrow('Distributor map conflicts: LESCO K-Flow 0-0-25 17% S Turfgrass Liquid Fertilizer');
    expect((await row(trx, DUP_KFLOW)).active).toBe(true);
  }));
});
