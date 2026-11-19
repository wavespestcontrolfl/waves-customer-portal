/**
 * 20261119020000: the pre-slab and trenching talstar_p / bifen_it options become LESCO Crosscheck Plus (1 gal = 128 fl oz,
 * $30.90, EPA 10404-120) in the persisted pricing_config rows, and the stale $58.42 SiteOne catalog price for that product is
 * set to $30.90 first, so the pre-slab catalog link cannot raise slab quotes. Fixtures are what production held on 2026-11-18, plus the
 * admin seed's bare Talak product (routes/admin-pricing-config.js ensureTable, 2026-10-25 until this change).
 */
const migration = require('../models/migrations/20261119020000_bifenthrin_option_crosscheck');
const constants = require('../services/pricing-engine/constants');

function fakeKnex(db) {
  let idSeq = 1000;
  const knex = (table) => {
    let cond = {};
    const match = (r) => Object.entries(cond).every(([k, v]) => r[k] === v);
    const rows = () => (db[table] || []).filter(match).map((r) => ({ ...r }));
    const q = {
      where(c) { cond = { ...cond, ...c }; return q; },
      forUpdate() { return q; },
      first: async () => rows()[0],
      update: async (patch) => { db[table] = db[table].map((r) => (match(r) ? { ...r, ...patch } : r)); },
      insert(row) {
        const id = row.id || `id${idSeq++}`;
        db[table].push({ id, ...row });
        const done = Promise.resolve();
        done.returning = async () => [{ id }];
        return done;
      },
      del: async () => { db[table] = db[table].filter((r) => !match(r)); },
      then(resolve, reject) { return Promise.resolve(rows()).then(resolve, reject); },
    };
    return q;
  };
  knex.fn = { now: () => 'now()' };
  knex.raw = async () => {};
  knex.schema = {
    hasTable: async (t) => Object.prototype.hasOwnProperty.call(db, t),
    hasColumn: async (t, c) => !(db.__missingColumns || []).includes(`${t}.${c}`),
  };
  return knex;
}

// What production held on 2026-11-18 (read-only read).
const TALAK_WARNING = 'Bifenthrin repellent barrier (Atticus Talak 7.9 F, EPA 91234-145).';
const PROD_PRESLAB_PRODUCT = {
  label: 'Talak 7.9 F - Bifenthrin',
  warnings: [TALAK_WARNING, 'Use only when the Talak 7.9 F label supports pre-construction subterranean termite treatment.'],
  positioning: 'standard_repellent',
  container_oz: 96,
  package_label: '96 fl oz',
  container_cost: 41.57,
  margin_divisor: 0.5294,
  catalog_product_name: 'Atticus Talak 7.9 F',
  product_oz_per_10_sqft: 1,
};
const PROD_TRENCH_PRODUCT = {
  label: 'Talak 7.9 F - Bifenthrin',
  warnings: [TALAK_WARNING, 'Do not attach long repair-and-retreat warranty without admin approval.'],
  positioning: 'standard_repellent',
  container_oz: 96,
  container_cost: 41.57,
  product_oz_per_finished_gallon_at_high_rate: 2,
  product_oz_per_finished_gallon_at_standard_rate: 1,
};
const preslabRow = (talstar = PROD_PRESLAB_PRODUCT, bifen = PROD_PRESLAB_PRODUCT) => ({
  usage_step_sqft: 100,
  link_container_costs_to_catalog: true,
  products: { termidor_sc: { container_cost: 174.72, container_oz: 78, catalog_product_name: 'Termidor SC' }, talstar_p: talstar, bifen_it: bifen },
});
const trenchRow = (talstar = PROD_TRENCH_PRODUCT, bifen = PROD_TRENCH_PRODUCT) => ({
  floor: 600,
  products: { taurus_sc: { container_cost: 85, container_oz: 78 }, talstar_p: talstar, bifen_it: bifen },
});

const STALE_AT = new Date('2026-09-30T15:00:00.000Z');
const vendorRow = (extra = {}) => ({
  id: 'v1', product_id: 'p1', vendor_id: 'ven1', vendor_sku: 'D00001542', price: '58.42', previous_price: '57.17',
  quantity: '1 gal', price_amount: '58.4200', landed_cost: '58.42', price_per_oz: '0.4564', normalized_unit_price: '0.4564',
  landed_unit_price: '0.4564', unit_normalized: 'oz', is_active: true, approval_status: 'approved', is_best_price: true,
  price_type: 'manual', source_type: 'manual', last_checked_at: STALE_AT, ...extra,
});
const catalogRow = (extra = {}) => ({
  id: 'p1', name: 'LESCO Crosscheck Plus', active: true, needs_pricing: false, best_price: '58.42', best_vendor: 'SiteOne',
  best_vendor_pricing_id: 'v1', best_price_amount_cached: '58.4200', best_price_updated_at: STALE_AT, best_price_status: 'current',
  unit_size_oz: '128.00', container_size: '1 gal', cost_per_unit: null, ...extra,
});

const world = ({ preslab = preslabRow(), trench = trenchRow(), catalog = [catalogRow()], vendors = [vendorRow()] } = {}) => ({
  pricing_config: [
    { config_key: 'onetime_preslab', data: JSON.stringify(preslab) },
    { config_key: 'onetime_trenching', data: JSON.stringify(trench) },
  ],
  pricing_config_audit: [],
  pricing_changelog: [],
  products_catalog: catalog,
  vendor_pricing: vendors,
  price_history: [],
});
const rowOf = (db, key) => JSON.parse(db.pricing_config.find((r) => r.config_key === key).data);
const productOf = (db, key, option) => rowOf(db, key).products[option];

const CROSSCHECK_PRESLAB = migration.CROSSCHECK_PRESLAB;
const CROSSCHECK_TRENCH = migration.CROSSCHECK_TRENCH;
const PRESLAB_REWRITTEN = { margin_divisor: 0.5294, product_oz_per_10_sqft: 1, ...CROSSCHECK_PRESLAB };
const TRENCH_REWRITTEN = {
  product_oz_per_finished_gallon_at_high_rate: 2, product_oz_per_finished_gallon_at_standard_rate: 1, ...CROSSCHECK_TRENCH,
};

let warn;
beforeEach(() => {
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const snapshot = (db) => JSON.stringify(db);
const bothRowsRewritten = (db) => {
  for (const option of ['talstar_p', 'bifen_it']) {
    expect(productOf(db, 'onetime_preslab', option)).toEqual(PRESLAB_REWRITTEN);
    expect(productOf(db, 'onetime_trenching', option)).toEqual(TRENCH_REWRITTEN);
  }
};
// The admin seed's Talak products (ensureTable until this change): no label, no catalog link.
const SEED_PRESLAB = { container_cost: 41.57, container_oz: 96, product_oz_per_10_sqft: 1, margin_divisor: 0.5294 };
const SEED_TRENCH = { container_cost: 41.57, container_oz: 96, product_oz_per_finished_gallon_at_standard_rate: 1, product_oz_per_finished_gallon_at_high_rate: 2 };

describe('bifenthrin option is Crosscheck Plus migration', () => {
  test('the inlined Crosscheck values match both option products in constants.js', () => {
    const preslab = constants.SPECIALTY.preSlabTermiticide.products;
    const trench = constants.SPECIALTY.trenching.products;
    for (const key of ['talstar_p', 'bifen_it']) {
      expect(migration.CROSSCHECK_PRESLAB).toEqual({
        label: preslab[key].label,
        catalog_product_name: preslab[key].catalogProductName,
        package_label: preslab[key].packageLabel,
        positioning: preslab[key].positioning,
        container_cost: preslab[key].containerCost,
        container_oz: preslab[key].containerOz,
        warnings: preslab[key].warnings,
      });
      expect(migration.CROSSCHECK_TRENCH).toEqual({
        label: trench[key].label,
        positioning: trench[key].positioning,
        container_cost: trench[key].containerCost,
        container_oz: trench[key].containerOz,
        warnings: trench[key].warnings,
      });
    }
    expect(constants.MOSQUITO.productCosts.bifenthrinOz).toBeCloseTo(30.9 / 128, 10);
    expect(constants.MOSQUITO.productCostCatalog.bifenthrinOz.catalogProductName).toBe('LESCO Crosscheck Plus');
  });

  test('the Talak values it rewrites from are exactly what production held on 2026-11-18', () => {
    const { margin_divisor: _m, product_oz_per_10_sqft: _o, ...preslab } = PROD_PRESLAB_PRODUCT;
    const { product_oz_per_finished_gallon_at_high_rate: _h, product_oz_per_finished_gallon_at_standard_rate: _s, ...trench } = PROD_TRENCH_PRODUCT;
    expect(migration.TALAK_PRESLAB).toEqual(preslab);
    expect(migration.TALAK_TRENCH).toEqual(trench);
  });

  test('every audit and changelog string fits its column', () => {
    expect(migration.TAG.length).toBeLessThanOrEqual(100); // changed_by varchar(100)
    expect(migration.CATALOG_AUDIT_KEY.length).toBeLessThanOrEqual(100); // config_key varchar(100)
    expect(migration.CHANGELOG.version_from.length).toBeLessThanOrEqual(10);
    expect(migration.CHANGELOG.version_to.length).toBeLessThanOrEqual(10);
    expect(migration.CHANGELOG.category.length).toBeLessThanOrEqual(30);
    expect(['bug', 'leak', 'rule', 'cost', 'architecture', 'documentation', 'infrastructure']).toContain(migration.CHANGELOG.category);
    expect(migration.CHANGELOG.changed_by).toBe(migration.TAG);
    expect(migration.REASON).toMatch(/swap out atticus talak for lesco crosscheck/);
    expect(migration.CATALOG_REASON).toMatch(/30\.90/);
  });

  describe('up()', () => {
    test('sets the catalog price like the inventory handler, then rewrites all four products and records each once', async () => {
      const db = world();
      const knex = fakeKnex(db);
      await migration.up(knex);

      expect(db.vendor_pricing[0]).toMatchObject({
        previous_price: 58.42, price: 30.9, price_amount: 30.9, landed_cost: 30.9,
        price_per_oz: 0.2414, normalized_unit_price: 0.2414, landed_unit_price: 0.2414,
      });
      expect(db.vendor_pricing[0].last_checked_at).toBeInstanceOf(Date);
      expect(db.vendor_pricing[0].last_checked_at.getTime()).toBeGreaterThan(STALE_AT.getTime());
      // untouched: identity, package, approval and winner flags
      expect(db.vendor_pricing[0]).toMatchObject({
        vendor_sku: 'D00001542', quantity: '1 gal', is_active: true, approval_status: 'approved', is_best_price: true,
        price_type: 'manual', source_type: 'manual', unit_normalized: 'oz',
      });
      expect(db.products_catalog[0]).toMatchObject({
        best_price: 30.9, best_price_amount_cached: 30.9, best_vendor: 'SiteOne', best_vendor_pricing_id: 'v1',
        best_price_status: 'current', needs_pricing: false, cost_per_unit: null, unit_size_oz: '128.00', container_size: '1 gal',
      });
      expect(db.products_catalog[0].best_price_updated_at.getTime()).toBeGreaterThan(STALE_AT.getTime());
      expect(db.price_history).toHaveLength(1);
      expect(db.price_history[0]).toMatchObject({ product_id: 'p1', vendor_id: 'ven1', price: 58.42, quantity: '1 gal', source: 'manual' });

      for (const option of ['talstar_p', 'bifen_it']) {
        expect(productOf(db, 'onetime_preslab', option)).toEqual(PRESLAB_REWRITTEN);
        expect(productOf(db, 'onetime_trenching', option)).toEqual(TRENCH_REWRITTEN);
      }
      expect(rowOf(db, 'onetime_preslab').link_container_costs_to_catalog).toBe(true);
      expect(rowOf(db, 'onetime_preslab').products.termidor_sc).toEqual({ container_cost: 174.72, container_oz: 78, catalog_product_name: 'Termidor SC' });
      expect(rowOf(db, 'onetime_trenching').floor).toBe(600);

      expect(db.pricing_config_audit.map((r) => r.config_key).sort()).toEqual(['inventory:lesco_crosscheck_plus_price', 'onetime_preslab', 'onetime_trenching']);
      for (const audit of db.pricing_config_audit) expect(audit.changed_by).toBe(migration.TAG);
      expect(db.pricing_changelog).toHaveLength(1);
      expect(db.pricing_changelog[0]).toMatchObject(migration.CHANGELOG);

      const after = snapshot(db);
      await migration.up(knex);
      expect(snapshot(db)).toBe(after); // a re-run is a no-op
      expect(warn).not.toHaveBeenCalled();
    });

    test('a catalog price already at 30.90 is skipped silently and the pre-slab link goes ahead', async () => {
      const db = world({
        vendors: [vendorRow({ price: '30.90', price_amount: '30.9000', price_per_oz: '0.2414' })],
        catalog: [catalogRow({ best_price: '30.90', best_price_amount_cached: '30.9000' })],
      });
      await migration.up(fakeKnex(db));
      expect(db.price_history).toEqual([]);
      expect(db.pricing_config_audit.map((r) => r.config_key).sort()).toEqual(['onetime_preslab', 'onetime_trenching']);
      expect(productOf(db, 'onetime_preslab', 'talstar_p')).toEqual(PRESLAB_REWRITTEN);
      expect(warn).not.toHaveBeenCalled();
    });

    test.each([['45.00'], ['30.50']])('a price an admin edited (%s) is left alone with a warning; both rows are still rewritten', async (price) => {
      const db = world({
        vendors: [vendorRow({ price })],
        catalog: [catalogRow({ best_price: price })],
      });
      await migration.up(fakeKnex(db));
      expect(db.vendor_pricing[0].price).toBe(price);
      expect(db.price_history).toEqual([]);
      expect(warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/price left alone/);
      // The pre-slab link then follows that later catalog entry inside the bridge's band.
      bothRowsRewritten(db);
      expect(db.pricing_config_audit.map((r) => r.config_key).sort()).toEqual(['onetime_preslab', 'onetime_trenching']);
    });

    test('two vendor rows: the price is left alone with a warning; both rows are still rewritten', async () => {
      const db = world({ vendors: [vendorRow(), vendorRow({ id: 'v2', vendor_id: 'ven2', vendor_sku: 'X1', price: '40.00' })] });
      await migration.up(fakeKnex(db));
      expect(db.vendor_pricing.map((v) => v.price)).toEqual(['58.42', '40.00']);
      expect(warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/exactly one vendor row/);
      bothRowsRewritten(db);
    });

    test.each([
      ['a different SKU', { vendors: [vendorRow({ vendor_sku: 'OTHER' })] }],
      ['an inactive vendor row', { vendors: [vendorRow({ is_active: false })] }],
      ['an unapproved vendor row', { vendors: [vendorRow({ approval_status: 'pending' })] }],
      ['a winner that is not the vendor row', { catalog: [catalogRow({ best_vendor_pricing_id: 'other' })] }],
      ['a catalog size that is not 128 oz', { catalog: [catalogRow({ unit_size_oz: '96.00' })] }],
      ['an inactive product', { catalog: [catalogRow({ active: false })] }],
      ['a vendor row with shipping (the landed cost would need it)', { vendors: [vendorRow({ shipping_cost: '5.00' })] }],
      ['a vendor row with tax (the landed cost would need it)', { vendors: [vendorRow({ tax_rate: '0.07' })] }],
    ])('%s: the price is left alone with a warning', async (_name, overrides) => {
      const db = world(overrides);
      const before = JSON.stringify([db.vendor_pricing, db.price_history]);
      await migration.up(fakeKnex(db));
      expect(JSON.stringify([db.vendor_pricing, db.price_history])).toBe(before);
      expect(warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/price left alone/);
      expect(db.pricing_config_audit.some((r) => r.config_key === 'inventory:lesco_crosscheck_plus_price')).toBe(false);
    });

    test('the product missing from the catalog: no catalog write, pre-slab rewrite proceeds on its config cost', async () => {
      const db = world({ catalog: [], vendors: [] });
      await migration.up(fakeKnex(db));
      expect(productOf(db, 'onetime_preslab', 'talstar_p')).toEqual(PRESLAB_REWRITTEN);
      expect(productOf(db, 'onetime_preslab', 'bifen_it')).toEqual(PRESLAB_REWRITTEN);
      expect(db.price_history).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    });

    test('the admin seed\'s bare Talak products are rewritten like the Talak rows, and down() puts the seed back', async () => {
      const db = world({ preslab: preslabRow(SEED_PRESLAB, SEED_PRESLAB), trench: trenchRow(SEED_TRENCH, SEED_TRENCH), catalog: [], vendors: [] });
      const original = JSON.stringify(db.pricing_config);
      const knex = fakeKnex(db);
      await migration.up(knex);
      bothRowsRewritten(db);
      expect(warn).not.toHaveBeenCalled();
      const after = snapshot(db);
      await migration.up(knex);
      expect(snapshot(db)).toBe(after); // a re-run is a no-op
      await migration.down(knex);
      expect(db.pricing_config.map((r) => JSON.parse(r.data))).toEqual(JSON.parse(original).map((r) => JSON.parse(r.data)));
    });

    test('a seed-shaped product with anything added or changed is an admin edit and is left alone', async () => {
      const db = world({
        preslab: preslabRow({ ...SEED_PRESLAB, container_cost: 40 }, { ...SEED_PRESLAB, positioning: 'premium' }),
        trench: trenchRow({ ...SEED_TRENCH, label: 'Mine' }, SEED_TRENCH),
        catalog: [],
        vendors: [],
      });
      await migration.up(fakeKnex(db));
      expect(productOf(db, 'onetime_preslab', 'talstar_p')).toEqual({ ...SEED_PRESLAB, container_cost: 40 });
      expect(productOf(db, 'onetime_preslab', 'bifen_it')).toEqual({ ...SEED_PRESLAB, positioning: 'premium' });
      expect(productOf(db, 'onetime_trenching', 'talstar_p')).toEqual({ ...SEED_TRENCH, label: 'Mine' });
      expect(productOf(db, 'onetime_trenching', 'bifen_it')).toEqual(TRENCH_REWRITTEN);
    });

    test('through the bridge: the seed row prices a 6,832 sq ft slab at $993 before up() and $743 after (no catalog row)', async () => {
      const price = async (data) => {
        let bridge;
        let pricing;
        jest.isolateModules(() => {
          bridge = require('../services/pricing-engine/db-bridge');
          pricing = require('../services/pricing-engine/service-pricing');
        });
        const bridgeDb = (table) => ({ select: async () => (table === 'pricing_config' ? [{ config_key: 'onetime_preslab', data }] : []) });
        bridgeDb.schema = { hasTable: async (table) => table === 'pricing_config' };
        jest.spyOn(console, 'log').mockImplementation(() => {});
        expect(await bridge.syncConstantsFromDB(bridgeDb)).toBe(true);
        return ['talstar_p', 'bifen_it'].map((productKey) => pricing.pricePreSlabTermiticide({ slabSqFt: 6832 }, { productKey }).price);
      };
      const db = world({ preslab: preslabRow(SEED_PRESLAB, SEED_PRESLAB), catalog: [], vendors: [] });
      expect(await price(rowOf(db, 'onetime_preslab'))).toEqual([993, 993]);
      await migration.up(fakeKnex(db));
      expect(await price(rowOf(db, 'onetime_preslab'))).toEqual([743, 743]);
    });

    test('rows already on Crosscheck are left alone and get no record', async () => {
      const db = world({
        preslab: preslabRow({ ...PROD_PRESLAB_PRODUCT, ...CROSSCHECK_PRESLAB }, { ...PROD_PRESLAB_PRODUCT, ...CROSSCHECK_PRESLAB }),
        trench: trenchRow({ ...PROD_TRENCH_PRODUCT, ...CROSSCHECK_TRENCH }, { ...PROD_TRENCH_PRODUCT, ...CROSSCHECK_TRENCH }),
        catalog: [],
        vendors: [],
      });
      const before = JSON.stringify(db.pricing_config);
      await migration.up(fakeKnex(db));
      expect(JSON.stringify(db.pricing_config)).toBe(before);
      expect(db.pricing_config_audit).toEqual([]);
      expect(db.pricing_changelog).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    });

    test('rows an admin edited another way are left alone with a warning; the other key is still rewritten', async () => {
      const db = world({
        preslab: preslabRow(PROD_PRESLAB_PRODUCT, { ...PROD_PRESLAB_PRODUCT, container_cost: 40 }),
        trench: trenchRow({ ...PROD_TRENCH_PRODUCT, label: 'My own label' }, PROD_TRENCH_PRODUCT),
        catalog: [],
        vendors: [],
      });
      await migration.up(fakeKnex(db));
      expect(productOf(db, 'onetime_preslab', 'talstar_p')).toEqual(PRESLAB_REWRITTEN);
      expect(productOf(db, 'onetime_preslab', 'bifen_it').container_cost).toBe(40);
      expect(productOf(db, 'onetime_trenching', 'talstar_p').label).toBe('My own label');
      expect(productOf(db, 'onetime_trenching', 'bifen_it')).toEqual(TRENCH_REWRITTEN);
      expect(warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/edited since the Talak swap/);
    });

    test('a product carrying a shadowing alias is treated as an admin edit and left alone', async () => {
      const aliased = { ...PROD_PRESLAB_PRODUCT, catalogProductName: 'Atticus Talak 7.9 F', containerCost: 41.57 };
      const db = world({ preslab: preslabRow(aliased, PROD_PRESLAB_PRODUCT), catalog: [], vendors: [] });
      await migration.up(fakeKnex(db));
      expect(productOf(db, 'onetime_preslab', 'talstar_p')).toEqual(aliased);
      expect(productOf(db, 'onetime_preslab', 'bifen_it')).not.toHaveProperty('catalogProductName');
    });

    test('a column that does not exist is skipped, never an error', async () => {
      const db = world();
      db.__missingColumns = ['vendor_pricing.landed_unit_price', 'products_catalog.best_price_amount_cached'];
      await migration.up(fakeKnex(db));
      expect(db.vendor_pricing[0].price).toBe(30.9);
      expect(db.vendor_pricing[0].landed_unit_price).toBe('0.4564');
      expect(db.products_catalog[0].best_price).toBe(30.9);
      expect(db.products_catalog[0].best_price_amount_cached).toBe('58.4200');
    });

    test('missing tables, rows and keys never throw', async () => {
      await expect(migration.up(fakeKnex({}))).resolves.toBeUndefined();
      await expect(migration.up(fakeKnex({ pricing_config: [] }))).resolves.toBeUndefined();
      await expect(migration.up(fakeKnex({ pricing_config: [{ config_key: 'onetime_preslab', data: '{}' }] }))).resolves.toBeUndefined();
      await expect(migration.up(fakeKnex({ pricing_config: [{ config_key: 'onetime_preslab', data: JSON.stringify({ products: { taurus_sc: {} } }) }] }))).resolves.toBeUndefined();
    });

    test('with no pricing_config_audit table up() writes nothing: down() could not find its writes', async () => {
      const db = world();
      delete db.pricing_config_audit;
      const before = snapshot(db);
      await migration.up(fakeKnex(db));
      expect(snapshot(db)).toBe(before);
      expect(warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/no pricing_config_audit table/);
    });
  });

  describe('down()', () => {
    test('restores the catalog price and every product it wrote, then removes only its own records', async () => {
      const db = world();
      db.pricing_config_audit.push({ id: 99, config_key: 'onetime_preslab', changed_by: 'admin', reason: 'edit' });
      db.price_history.push({ id: 'h0', product_id: 'p1', vendor_id: 'ven1', price: 57.17, quantity: '1 gal', source: 'manual' });
      const originalConfig = JSON.stringify(db.pricing_config);
      const knex = fakeKnex(db);
      await migration.up(knex);
      await migration.down(knex);

      expect(db.pricing_config.map((r) => JSON.parse(r.data))).toEqual(JSON.parse(originalConfig).map((r) => JSON.parse(r.data)));
      expect(db.vendor_pricing[0]).toMatchObject({
        price: '58.42', previous_price: '57.17', price_amount: '58.4200', landed_cost: '58.42', price_per_oz: '0.4564',
        normalized_unit_price: '0.4564', landed_unit_price: '0.4564',
      });
      expect(new Date(db.vendor_pricing[0].last_checked_at).toISOString()).toBe(STALE_AT.toISOString());
      expect(db.products_catalog[0]).toMatchObject({ best_price: '58.42', best_price_amount_cached: '58.4200' });
      expect(new Date(db.products_catalog[0].best_price_updated_at).toISOString()).toBe(STALE_AT.toISOString());
      expect(db.price_history.map((h) => h.id)).toEqual(['h0']);
      expect(db.pricing_config_audit.map((r) => r.id)).toEqual([99]);
      expect(db.pricing_changelog).toEqual([]);
    });

    test('an admin price edit after up() is kept; the products still restore', async () => {
      const db = world();
      const knex = fakeKnex(db);
      await migration.up(knex);
      db.vendor_pricing = db.vendor_pricing.map((v) => ({ ...v, price: 29.99 }));
      await migration.down(knex);
      expect(db.vendor_pricing[0].price).toBe(29.99);
      expect(db.products_catalog[0].best_price).toBe(30.9);
      expect(warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/price changed since this migration/);
      expect(productOf(db, 'onetime_preslab', 'talstar_p')).toEqual(PROD_PRESLAB_PRODUCT);
    });

    test('an admin edit of one product after up() is kept; the others restore', async () => {
      const db = world();
      const knex = fakeKnex(db);
      await migration.up(knex);
      const trench = rowOf(db, 'onetime_trenching');
      trench.products.bifen_it = { ...trench.products.bifen_it, container_cost: 44 };
      db.pricing_config = db.pricing_config.map((r) => (r.config_key === 'onetime_trenching' ? { ...r, data: JSON.stringify(trench) } : r));
      await migration.down(knex);
      expect(productOf(db, 'onetime_trenching', 'bifen_it').container_cost).toBe(44);
      expect(productOf(db, 'onetime_trenching', 'talstar_p')).toEqual(PROD_TRENCH_PRODUCT);
      expect(productOf(db, 'onetime_preslab', 'bifen_it')).toEqual(PROD_PRESLAB_PRODUCT);
    });

    test('down() leaves a row alone, updated_at included, when every product in it was edited since up()', async () => {
      const db = world();
      const knex = fakeKnex(db);
      await migration.up(knex);
      const trench = rowOf(db, 'onetime_trenching');
      for (const key of ['talstar_p', 'bifen_it']) trench.products[key] = { ...trench.products[key], container_cost: 44 };
      db.pricing_config = db.pricing_config.map((r) => (r.config_key === 'onetime_trenching' ? { ...r, data: JSON.stringify(trench), updated_at: 'office-edit' } : r));
      await migration.down(knex);
      expect(db.pricing_config.find((r) => r.config_key === 'onetime_trenching').updated_at).toBe('office-edit');
      expect(productOf(db, 'onetime_trenching', 'talstar_p').container_cost).toBe(44);
      expect(productOf(db, 'onetime_preslab', 'bifen_it')).toEqual(PROD_PRESLAB_PRODUCT);
    });

    test('after an up() that left an edited price alone, down() restores both rows and leaves the price alone', async () => {
      const db = world({ vendors: [vendorRow({ price: '45.00' })], catalog: [catalogRow({ best_price: '45.00' })] });
      const knex = fakeKnex(db);
      await migration.up(knex);
      await migration.down(knex);
      for (const option of ['talstar_p', 'bifen_it']) {
        expect(productOf(db, 'onetime_preslab', option)).toEqual(PROD_PRESLAB_PRODUCT);
        expect(productOf(db, 'onetime_trenching', option)).toEqual(PROD_TRENCH_PRODUCT);
      }
      expect(db.vendor_pricing[0].price).toBe('45.00');
      expect(db.pricing_config_audit).toEqual([]);
    });

    test('with one key rewritten and the other an admin edit, down() restores only the rewritten key', async () => {
      const db = world({ trench: trenchRow(PROD_TRENCH_PRODUCT, { ...PROD_TRENCH_PRODUCT, label: 'Mine' }), catalog: [], vendors: [] });
      const knex = fakeKnex(db);
      await migration.up(knex);
      await migration.down(knex);
      expect(productOf(db, 'onetime_trenching', 'talstar_p')).toEqual(PROD_TRENCH_PRODUCT);
      expect(productOf(db, 'onetime_trenching', 'bifen_it').label).toBe('Mine');
    });

    test('down() on rows this migration never touched changes nothing; missing tables skip', async () => {
      const db = world({ catalog: [], vendors: [] });
      const before = snapshot(db);
      await migration.down(fakeKnex(db));
      expect(snapshot(db)).toBe(before);
      await expect(migration.down(fakeKnex({}))).resolves.toBeUndefined();
      await expect(migration.down(fakeKnex({ pricing_config_audit: [] }))).resolves.toBeUndefined();
    });
  });
});
