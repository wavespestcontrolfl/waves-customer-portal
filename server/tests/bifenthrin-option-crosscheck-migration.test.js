/**
 * 20261119020000: the pre-slab and trenching talstar_p / bifen_it options become LESCO Crosscheck Plus (1 gal = 128 fl oz,
 * $30.90, EPA 10404-120) in the persisted pricing_config rows, and the stale $58.42 SiteOne catalog price for that product is
 * set to $30.90 first, so the pre-slab catalog link cannot raise slab quotes. Fixtures are what production held on 2026-11-18, plus the
 * admin seed's bare Talak product (routes/admin-pricing-config.js ensureTable, 2026-10-25 until this change).
 */
const migration = require('../models/migrations/20261119020000_bifenthrin_option_crosscheck');
const constants = require('../services/pricing-engine/constants');
const { calculateInventoryCost } = require('../services/inventory-cost');
const { costLineFromUsage } = require('../services/product-costing');

// The inventory route module itself: its recalculation (routes/admin-inventory recalcBestPrice, which Step P runs after it corrects
// the SiteOne row) and the per-oz price it ranks a quote by, run on the fake rows below (pre-push audit 25: a test model of the
// recalculation had no branch for a catalog price it keeps). Wrapped so a test can count the calls.
jest.mock('../routes/admin-inventory', () => {
  const actual = jest.requireActual('../routes/admin-inventory');
  return {
    recalcBestPrice: jest.fn(actual.recalcBestPrice), vendorRowPricePerOz: actual.vendorRowPricePerOz,
    approvedPerOzFields: actual.approvedPerOzFields, snapshotPricingFields: actual.snapshotPricingFields,
  };
});
const inventory = require('../routes/admin-inventory');
const { recalcBestPrice: realRecalc } = jest.requireActual('../routes/admin-inventory');

// A knex stand-in over plain rows, for the query shapes the migration and the real recalculation use (vendor-pricing-eligibility's
// predicate, the vendors join and its select); any other shape throws, so a test never passes on a query the stand-in ignored.
const ELIGIBLE_PRICE_SQL = 'COALESCE(vendor_pricing.price_amount, vendor_pricing.price) > 0';
const bare = (column) => String(column).replace(/^\w+\./, '');
const later = (column, op, value) => {
  if (op !== '>') throw new Error(`fakeKnex: unsupported operator ${op}`);
  return (r) => r[bare(column)] != null && new Date(r[bare(column)]).getTime() > new Date(value).getTime();
};
function fakeKnex(db) {
  let idSeq = 1000;
  const knex = (table) => {
    const tests = [];
    const joins = [];
    const aliases = [];
    const match = (r) => tests.every((test) => test(r));
    const rows = () => (db[table] || []).filter(match).flatMap((r) => {
      const row = { ...r };
      for (const join of joins) {
        const partner = (db[join.table] || []).find((other) => other[join.on] === r[join.key]);
        if (!partner) return []; // an inner join
        for (const alias of aliases.filter((a) => a.table === join.table)) row[alias.as] = partner[alias.column];
      }
      return [row];
    });
    const q = {
      where(a, b, c) {
        if (typeof a === 'function') {
          const group = [];
          const sub = {
            whereNull(column) { group.push((r) => r[bare(column)] == null); return sub; },
            orWhere(column, op, value) { group.push(later(column, op, value)); return sub; },
          };
          a.call(sub);
          tests.push((r) => group.some((test) => test(r)));
        } else if (typeof a === 'object') {
          tests.push((r) => Object.entries(a).every(([k, v]) => r[bare(k)] === v));
        } else if (c === undefined) {
          tests.push((r) => r[bare(a)] === b);
        } else {
          tests.push(later(a, b, c));
        }
        return q;
      },
      whereIn(column, values) { tests.push((r) => values.includes(r[bare(column)])); return q; },
      whereRaw(sql) {
        if (sql !== ELIGIBLE_PRICE_SQL) throw new Error(`fakeKnex: unsupported whereRaw ${sql}`);
        tests.push((r) => Number(r.price_amount ?? r.price) > 0);
        return q;
      },
      join(other, left, right) { joins.push({ table: other, key: bare(left), on: bare(right) }); return q; },
      select(...columns) {
        for (const column of columns.flat()) {
          const alias = /^(\w+)\.(\w+) as (\w+)$/i.exec(column);
          if (alias) aliases.push({ table: alias[1], column: alias[2], as: alias[3] });
        }
        return q;
      },
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
  price_type: 'manual', source_type: 'manual', last_checked_at: STALE_AT, latest_snapshot_id: null, ...extra,
});
const catalogRow = (extra = {}) => ({
  id: 'p1', name: 'LESCO Crosscheck Plus', active: true, needs_pricing: false, best_price: '58.42', best_vendor: 'SiteOne',
  best_vendor_pricing_id: 'v1', best_price_amount_cached: '58.4200', best_price_updated_at: STALE_AT, best_price_status: 'current',
  unit_size_oz: '128.00', container_size: '1 gal', cost_per_unit: null, ...extra,
});

// A catalog winner at another vendor's price, backed by that vendor's approved row: Step P corrects the SiteOne row, which may now
// be the cheapest.
const OTHER_WINNER = { best_vendor_pricing_id: 'other', best_vendor: 'Other Vendor', best_price: '45.00', best_price_amount_cached: '45.0000' };
const OTHER_VENDOR = vendorRow({
  id: 'other', vendor_id: 'ven9', vendor_sku: 'OTHER45', price: '45.00', price_amount: '45.0000', landed_cost: '45.00', price_per_oz: '0.3516',
  normalized_unit_price: '0.3516', landed_unit_price: '0.3516', is_best_price: true,
});
const OTHER_WINNER_WORLD = { catalog: [catalogRow(OTHER_WINNER)], vendors: [vendorRow({ is_best_price: false }), OTHER_VENDOR] };
// A second vendor row on the Crosscheck Plus product: Step P must leave the stale price alone.
const SECOND_VENDOR = vendorRow({
  id: 'v2', vendor_id: 'ven2', vendor_sku: 'X1', price: '70.00', price_amount: '70.0000', landed_cost: '70.00', price_per_oz: '0.5469',
  normalized_unit_price: '0.5469', landed_unit_price: '0.5469', is_best_price: false,
});
// The Talak catalog row the Talak products link to, as production holds it (41.57 for 96 oz, active, priced).
const talakCatalogRow = () => ({
  id: 'pt', name: 'Atticus Talak 7.9 F', active: true, needs_pricing: false, best_price: '41.57', best_price_amount_cached: '41.5700',
  best_vendor_pricing_id: 'vt', unit_size_oz: '96.00',
});
const talakVendorRow = () => ({
  id: 'vt', product_id: 'pt', vendor_id: 'ven3', vendor_sku: 'TALAK96', price: '41.57', price_amount: '41.5700', quantity: '96 fl oz',
  unit_normalized: 'oz', is_active: true, approval_status: 'approved',
});

// The vendors table: SiteOne backs the D00001542 row (production: one vendors row named SiteOne, code 1, read 2026-11-19).
const VENDORS = [{ id: 'ven1', name: 'SiteOne', code: 1 }, { id: 'ven2', name: 'Other Supply', code: 2 }, { id: 'ven3', name: 'Amazon', code: 3 },
  { id: 'ven9', name: 'Other Vendor', code: 9 }];
const world = ({ preslab = preslabRow(), trench = trenchRow(), catalog = [catalogRow()], vendors = [vendorRow()], pest = null } = {}) => ({
  pricing_config: [
    { config_key: 'onetime_preslab', data: JSON.stringify(preslab) },
    { config_key: 'onetime_trenching', data: JSON.stringify(trench) },
    ...(pest ? [{ config_key: 'pest_service_costs', data: JSON.stringify(pest) }] : []),
  ],
  pricing_config_audit: [],
  pricing_changelog: [],
  products_catalog: catalog,
  vendor_pricing: vendors,
  vendors: VENDORS.map((vendor) => ({ ...vendor })),
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
// A quote still offering the stale $58.42 that Step P had to leave: its price stays, and it expires at up()'s run, so the shared
// eligibility predicate keeps it out of every later recalculation and auto-order (pre-push audit 24).
const STALE_WARNING = /still offered the stale \$58\.42[\s\S]*now expires at this deploy/;
const expectExpired = (quote) => {
  expect(quote.expires_at).toBeInstanceOf(Date);
  expect(quote.expires_at.getTime()).toBeLessThanOrEqual(Date.now());
  expect(quote.price).toBe('58.42');
};
// The catalog with no current quote, as recalcBestPriceLocked writes it: with no package price, job and service-usage costing
// (calculateInventoryCost, costLineFromUsage) leave it uncosted, never at the stale $58.42 (pre-push audits 13, 14).
const expectUnpriced = (row) => {
  expect(row).toMatchObject({ needs_pricing: true, best_price_status: 'no_valid_price', best_price: null, best_vendor_pricing_id: null });
  expect(calculateInventoryCost({ product: row, deductedAmount: 16, inventoryUnit: 'fl_oz', amount: 16, amountUnit: 'fl_oz' }))
    .toEqual({ unitCost: null, costUsed: null });
  expect(costLineFromUsage({ ...row, product_name: row.name, usage_amount: 16, usage_unit: 'fl_oz' })).toMatchObject({ cost: 0 });
};
const auditKeys = (db) => db.pricing_config_audit.map((r) => r.config_key).sort();
const OPTIONS = ['talstar_p', 'bifen_it'];

let warn;
beforeEach(() => {
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'info').mockImplementation(() => {});
  inventory.recalcBestPrice.mockReset();
  inventory.recalcBestPrice.mockImplementation(realRecalc);
});
// The recalculation ran for p1, on the migration's own connection (its transaction).
const expectRecalculated = (knex, times = 1) => {
  expect(inventory.recalcBestPrice).toHaveBeenCalledTimes(times);
  expect(inventory.recalcBestPrice).toHaveBeenLastCalledWith('p1', knex);
};
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
    // changed_by varchar(100); also a superseded approval's rejected_by varchar(120) and legacy reviewed_by varchar(100)
    expect(migration.TAG.length).toBeLessThanOrEqual(100);
    expect(migration.CATALOG_AUDIT_KEY.length).toBeLessThanOrEqual(100); // config_key varchar(100)
    expect(migration.STALE_AUDIT_KEY.length).toBeLessThanOrEqual(100);
    expect(migration.CHANGELOG.version_from.length).toBeLessThanOrEqual(10);
    expect(migration.CHANGELOG.version_to.length).toBeLessThanOrEqual(10);
    expect(migration.CHANGELOG.category.length).toBeLessThanOrEqual(30);
    expect(['bug', 'leak', 'rule', 'cost', 'architecture', 'documentation', 'infrastructure']).toContain(migration.CHANGELOG.category);
    expect(migration.CHANGELOG.changed_by).toBe(migration.TAG);
    expect(migration.REASON).toMatch(/swap out atticus talak for lesco crosscheck/);
    expect(migration.CATALOG_REASON).toMatch(/30\.90/);
    expect(migration.STALE_REASON).toMatch(/30\.90/);
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
      expectRecalculated(knex); // the handler's own recalculation writes the catalog best price
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
      expectRecalculated(knex);
      expect(warn).not.toHaveBeenCalled();
    });

    // The handler also records the entry as the row's price evidence: a price_snapshots row for $30.90, linked as the row's
    // latest_snapshot_id (production's row links its $58.42 snapshot of 2026-09-30). down() links the earlier snapshot again and
    // deletes the new one (pre-push audit 20).
    test('records the new price as the row\'s latest snapshot, as the handler does; down() restores the earlier link', async () => {
      const db = world({ vendors: [vendorRow({ latest_snapshot_id: 's0' })] });
      db.price_snapshots = [{ id: 's0', product_id: 'p1', vendor_id: 'ven1', vendor_pricing_id: 'v1', price: '58.42' }];
      const knex = fakeKnex(db);
      await migration.up(knex);
      expect(db.price_snapshots).toHaveLength(2);
      const added = db.price_snapshots[1];
      expect(added).toMatchObject({
        product_id: 'p1', vendor_id: 'ven1', vendor_pricing_id: 'v1', price: 30.9, price_amount: 30.9, quantity: '1 gal',
        normalized_unit_price: 0.2414, normalized_unit: 'oz', landed_unit_price: 0.2414, source_type: 'manual', price_type: 'manual',
        availability_status: 'unknown', confidence_score: 0.8, source_confidence: 0.75, price_confidence: 0.8, expires_at: null,
      });
      expect(JSON.parse(added.metadata)).toEqual({ source: 'migration:20261119020000_bifenthrin_option_crosscheck' });
      expect(db.vendor_pricing[0]).toMatchObject({ price: 30.9, latest_snapshot_id: added.id });
      await migration.down(knex);
      expect(db.vendor_pricing[0]).toMatchObject({ price: '58.42', latest_snapshot_id: 's0' });
      expect(db.price_snapshots.map((snapshot) => snapshot.id)).toEqual(['s0']);
    });

    test('an install without the snapshot table or the link column gets no snapshot, and the price still moves', async () => {
      const noTable = world();
      await migration.up(fakeKnex(noTable));
      expect(noTable.vendor_pricing[0]).toMatchObject({ price: 30.9, latest_snapshot_id: null });
      const noLink = world({ vendors: [vendorRow({ latest_snapshot_id: 's0' })] });
      noLink.price_snapshots = [{ id: 's0' }];
      noLink.__missingColumns = ['vendor_pricing.latest_snapshot_id'];
      await migration.up(fakeKnex(noLink));
      expect(noLink.vendor_pricing[0]).toMatchObject({ price: 30.9, latest_snapshot_id: 's0' });
      expect(noLink.price_snapshots.map((snapshot) => snapshot.id)).toEqual(['s0']);
    });

    test('a catalog price already at 30.90 is skipped silently and the pre-slab link goes ahead', async () => {
      const db = world({
        vendors: [vendorRow({
          price: '30.90', price_amount: '30.9000', landed_cost: '30.90', price_per_oz: '0.2414', normalized_unit_price: '0.2414', landed_unit_price: '0.2414',
        })],
        catalog: [catalogRow({ best_price: '30.90', best_price_amount_cached: '30.9000' })],
      });
      await migration.up(fakeKnex(db));
      expect(db.price_history).toEqual([]);
      expect(db.pricing_config_audit.map((r) => r.config_key).sort()).toEqual(['onetime_preslab', 'onetime_trenching']);
      expect(productOf(db, 'onetime_preslab', 'talstar_p')).toEqual(PRESLAB_REWRITTEN);
      expect(warn).not.toHaveBeenCalled();
    });

    // A price written without a recalculation (pre-push audit 12): job costing reads the catalog best_price directly, so the catalog
    // is recalculated, with no vendor write or price history, and down() leaves it.
    // The recalculation alone rewrites the catalog, so up() records it, and down() puts the catalog back as up() saw it while it still
    // holds what up() wrote (pre-push audit at the first push: a recalculation can clear a price).
    test('a SiteOne row already at 30.90 beside a catalog still on 58.42: the recalculation alone runs, and down() puts the catalog back', async () => {
      const corrected = vendorRow({
        price: '30.90', price_amount: '30.9000', landed_cost: '30.90', price_per_oz: '0.2414', normalized_unit_price: '0.2414', landed_unit_price: '0.2414',
      });
      const db = world({ vendors: [corrected] });
      const knex = fakeKnex(db);
      await migration.up(knex);
      expectRecalculated(knex);
      expect(db.vendor_pricing[0]).toEqual({ ...corrected, is_best_price: true });
      expect(db.price_history).toEqual([]);
      expect(db.products_catalog[0]).toMatchObject({ best_price: 30.9, best_vendor_pricing_id: 'v1', needs_pricing: false, best_price_status: 'current' });
      expect(auditKeys(db)).toEqual(['inventory:lesco_crosscheck_plus_stale', 'onetime_preslab', 'onetime_trenching']);
      const own = JSON.parse(db.pricing_config_audit.find((r) => r.config_key === migration.STALE_AUDIT_KEY).new_value);
      expect(own).toMatchObject({ catalog_only: true, catalog_repriced: false, is_best_price_ids: ['v1'], catalog_recalculated: { best_price: 30.9 } });
      expect(warn).not.toHaveBeenCalled();
      await migration.down(knex);
      expectRecalculated(knex); // down() puts the catalog back itself: no second recalculation
      expect(db.products_catalog[0]).toMatchObject({
        best_price: '58.42', best_price_amount_cached: '58.4200', best_vendor: 'SiteOne', best_vendor_pricing_id: 'v1', best_price_status: 'current', needs_pricing: false,
      });
      expect(db.vendor_pricing[0]).toEqual({ ...corrected, is_best_price: true });
      expect(db.pricing_config_audit).toEqual([]);
    });

    // Pending approvals and the unit cost (pre-push audit at the sixth push): an approval queued before this change that, approved,
    // would put a stale gallon price back on a SiteOne quote is rejected as superseded, and a catalog unit cost (job costing reads it
    // before the catalog price) that is a stale gallon price in its own unit is cleared. down() puts each back while it is as up()
    // left it. Production held neither on 2026-11-20 (read-only read).
    const snapshotAt = (id, price, extra = {}) => ({
      id, product_id: 'p1', vendor_id: 'ven1', vendor_pricing_id: 'v1', price, price_amount: price, quantity: '1 gal', uom: 'gal',
      normalized_unit_price: String(Math.round((Number(price) / 128) * 10000) / 10000), normalized_unit: 'oz', ...extra,
    });
    const pendingEvent = (id, snapshotId, extra = {}) => ({
      id, product_id: 'p1', vendor_id: 'ven1', vendor_pricing_id: 'v1', snapshot_id: snapshotId, approval_status: 'pending',
      approval_reason: 'Price changed', rejected_by: null, rejected_at: null, ...extra,
    });
    const pendingLegacy = (id, newPrice, extra = {}) => ({
      id, product_id: 'p1', vendor_id: 'ven1', new_price: newPrice, new_quantity: null, status: 'pending', reviewed_by: null,
      reviewed_at: null, notes: null, ...extra,
    });
    const AT_3090 = { price: '30.90', price_amount: '30.9000', landed_cost: '30.90', price_per_oz: '0.2414', normalized_unit_price: '0.2414', landed_unit_price: '0.2414' };
    const statusOf = (rows) => Object.fromEntries(rows.map((row) => [row.id, row.approval_status ?? row.status]));
    const jobCost = (db) => calculateInventoryCost({
      product: db.products_catalog[0], deductedAmount: 4, inventoryUnit: 'fl_oz', amount: 4, amountUnit: 'fl_oz',
    }).costUsed;
    // The other job-costing path, a service's product line (costLineFromUsage), at the same 4 fl oz.
    const lineCost = (db) => costLineFromUsage({ ...db.products_catalog[0], product_name: 'Crosscheck', usage_amount: 4, usage_unit: 'fl_oz' }).cost;

    test('pending approvals that would put the stale price back are rejected as superseded; others stay; down() leaves them closed', async () => {
      const events = [
        pendingEvent('e58', 's58'),
        pendingEvent('e31', 's31'), // another price: an admin's call
        pendingEvent('e58b', 's58b', { vendor_pricing_id: null }), // names its quote through its snapshot
      ];
      const legacy = [
        pendingLegacy('a58', '58.42'),
        pendingLegacy('a58big', '58.42', { new_quantity: '2.5 gal' }), // $23.37 a gallon: not the stale price
        pendingLegacy('a58other', '58.42', { vendor_id: 'ven2' }), // another vendor
      ];
      const db = world();
      db.price_snapshots = [snapshotAt('s58', '58.42'), snapshotAt('s31', '31.50'), snapshotAt('s58b', '58.42')];
      db.price_approval_events = events.map((row) => ({ ...row }));
      db.price_approvals = legacy.map((row) => ({ ...row }));
      const knex = fakeKnex(db);
      await migration.up(knex);
      expect(db.vendor_pricing[0]).toMatchObject({ price: 30.9 });
      expect(statusOf(db.price_approval_events)).toEqual({ e58: 'rejected', e31: 'pending', e58b: 'rejected' });
      expect(statusOf(db.price_approvals)).toEqual({ a58: 'rejected', a58big: 'pending', a58other: 'pending' });
      expect(db.price_approval_events[0]).toMatchObject({ rejected_by: migration.TAG, approval_reason: expect.stringMatching(/^Superseded: the owner pays \$30\.90/) });
      expect(db.price_approval_events[0].rejected_at).toBeInstanceOf(Date);
      expect(db.price_approvals[0]).toMatchObject({ reviewed_by: migration.TAG, notes: expect.stringMatching(/^Superseded/) });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/pending price approvals e58, e58b, a58 would put a stale price/));

      // down() leaves each one closed: the quote is back at the stale price they offer, so reopening them could only offer it again
      // (pre-push audit at the seventh push: a newer report may have queued since).
      const closed = snapshot({ events: db.price_approval_events, legacy: db.price_approvals });
      await migration.down(knex);
      expect(db.vendor_pricing[0]).toMatchObject({ price: '58.42' });
      expect(snapshot({ events: db.price_approval_events, legacy: db.price_approvals })).toBe(closed);
    });

    // The legacy lookup can queue a SiteOne price before the product has a quote from SiteOne, and approving it then inserts one at
    // the approval's own price and pack (applyPriceApproval): a stale one is superseded too (pre-push audit at the ninth push).
    test('a pending SiteOne approval for a product with no SiteOne quote yet is superseded; another vendor\'s stays', async () => {
      // A catalog price with no quote names none (the quote ids are foreign keys).
      const noQuote = catalogRow({
        best_price: '30.90', best_price_amount_cached: '30.9000', best_vendor_pricing_id: null, best_price_vendor_id_cached: null,
      });
      const db = world({ vendors: [], catalog: [{ ...noQuote }] });
      db.price_approvals = [
        pendingLegacy('a58', '58.42', { new_quantity: '1 gal' }),
        pendingLegacy('a31', '31.50', { new_quantity: '1 gal' }), // another price: an admin's call
        pendingLegacy('a58other', '58.42', { new_quantity: '1 gal', vendor_id: 'ven2' }), // another vendor
      ];
      const knex = fakeKnex(db);
      await migration.up(knex);
      expect(statusOf(db.price_approvals)).toEqual({ a58: 'rejected', a31: 'pending', a58other: 'pending' });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/pending price approvals a58 would put a stale price/));
      // Closing an approval changes no quote, so nothing recalculates: with no current quote, a recalculation would clear the catalog
      // price job costing reads (pre-push audit at the tenth push).
      expect(inventory.recalcBestPrice).not.toHaveBeenCalled();
      expect(db.products_catalog[0]).toEqual(noQuote);
      await migration.down(knex);
      expect(db.products_catalog[0]).toEqual(noQuote);
      expect(inventory.recalcBestPrice).not.toHaveBeenCalled();
    });

    test('a pending approval at the stale price beside a SiteOne row already at $30.90 is superseded alone; down() leaves it closed', async () => {
      const event = pendingEvent('e58', 's58');
      // A catalog the recalculation leaves at the same price: only the superseded approval makes the audit row.
      const reconciled = catalogRow({ best_price: '30.90', best_price_amount_cached: '30.9000', best_price_vendor_id_cached: 'ven1' });
      const db = world({ vendors: [vendorRow(AT_3090)], catalog: [{ ...reconciled }] });
      db.price_snapshots = [snapshotAt('s58', '58.42')];
      db.price_approval_events = [{ ...event }];
      const knex = fakeKnex(db);
      await migration.up(knex);
      expect(db.price_approval_events[0]).toMatchObject({ approval_status: 'rejected', rejected_by: migration.TAG });
      expect(db.products_catalog[0]).toEqual(reconciled); // closing an approval changes no quote, so nothing recalculates
      expect(auditKeys(db)).toEqual(['inventory:lesco_crosscheck_plus_stale', 'onetime_preslab', 'onetime_trenching']);
      await migration.down(knex);
      expect(db.price_approval_events[0]).toMatchObject({ approval_status: 'rejected', rejected_by: migration.TAG });
      const { best_price_updated_at: seenAt, ...seen } = reconciled;
      expect(db.products_catalog[0]).toMatchObject(seen); // as up() saw it (the audit row's JSON keeps its timestamp as a string)
      expect(new Date(db.products_catalog[0].best_price_updated_at)).toEqual(seenAt);
      expect(db.pricing_config_audit).toEqual([]);
    });

    test('an approval queue that lacks a column up() reads is left alone with a warning; the price still moves', async () => {
      const db = world();
      db.price_approvals = [pendingLegacy('a58', '58.42')];
      db.__missingColumns = ['price_approvals.new_quantity'];
      await migration.up(fakeKnex(db));
      expect(db.price_approvals[0].status).toBe('pending');
      expect(db.vendor_pricing[0]).toMatchObject({ price: 30.9 });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/price_approvals lacks a column up\(\) reads/));
    });

    test.each([
      ['per fl oz', '0.4564', 'fl_oz'],
      ['per oz, which costing reads as a fluid ounce', '0.4564', 'oz'],
      ['per gallon', '58.4200', 'gal'],
      ['per quart, at the imported $57.17', '14.2925', 'qt'],
      ['with no unit, per fl oz', '0.4564', null],
      // Units only costLineFromUsage knows (pre-push audit at the thirteenth push).
      ['per cc', '0.0154', 'cc'],
      ['per milliliter', '0.0154', 'milliliter'],
      ['per litre', '15.4329', 'litre'],
    ])('a catalog unit cost at a stale price %s is cleared, so job costing reads the corrected price; down() puts it back', async (_, cost, unit) => {
      const db = world({ catalog: [catalogRow({ cost_per_unit: cost, cost_unit: unit })] });
      const knex = fakeKnex(db);
      expect(jobCost(db)).toBeGreaterThan(1.7); // 4 fl oz at a stale price
      expect(lineCost(db)).toBeGreaterThan(1.7);
      await migration.up(knex);
      expect(db.products_catalog[0]).toMatchObject({ cost_per_unit: null, cost_unit: null, best_price: 30.9 });
      expect(jobCost(db)).toBe(0.9656); // 4 fl oz of the $30.90 gallon
      expect(lineCost(db)).toBeCloseTo(0.9656, 4);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/catalog unit cost \(.+\) was a stale price/));
      await migration.down(knex);
      expect(db.vendor_pricing[0]).toMatchObject({ price: '58.42' });
      expect(db.products_catalog[0]).toMatchObject({ cost_per_unit: cost, cost_unit: unit });
    });

    // A weight unit holds no gallon price: $7.3025 a pound is the stale gallon's figure per 16 oz, and stays (pre-push audit at the
    // seventh push), as does $0.0161 a gram in a unit only costLineFromUsage knows (pre-push audit at the thirteenth push).
    test.each([['0.2414', 'fl_oz'], ['0.4600', 'fl_oz'], ['0.5000', null], ['7.3025', 'lb'], ['0.0161', 'gm']])('a unit cost of an admin\'s own (%s per %s) stays', async (cost, unit) => {
      const db = world({ catalog: [catalogRow({ cost_per_unit: cost, cost_unit: unit })] });
      await migration.up(fakeKnex(db));
      expect(db.products_catalog[0]).toMatchObject({ cost_per_unit: cost, cost_unit: unit, best_price: 30.9 });
      const audit = db.pricing_config_audit.find((r) => r.config_key === migration.CATALOG_AUDIT_KEY);
      expect(JSON.parse(audit.new_value).catalog_recalculated).toMatchObject({ cost_per_unit: cost, cost_unit: unit });
      expect(warn).not.toHaveBeenCalled();
    });

    test('a stale unit cost beside a SiteOne row and catalog already at $30.90 is cleared alone; a re-run changes nothing', async () => {
      const db = world({
        vendors: [vendorRow(AT_3090)],
        catalog: [catalogRow({ best_price: '30.90', best_price_amount_cached: '30.9000', cost_per_unit: '0.4564', cost_unit: 'fl_oz' })],
      });
      const knex = fakeKnex(db);
      await migration.up(knex);
      expect(db.products_catalog[0]).toMatchObject({ cost_per_unit: null, cost_unit: null, best_price: '30.90' });
      expect(inventory.recalcBestPrice).not.toHaveBeenCalled(); // clearing a unit cost changes no quote
      expect(auditKeys(db)).toEqual(['inventory:lesco_crosscheck_plus_stale', 'onetime_preslab', 'onetime_trenching']);
      const after = snapshot(db);
      await migration.up(knex);
      expect(snapshot(db)).toBe(after);
      await migration.down(knex);
      expect(db.products_catalog[0]).toMatchObject({ cost_per_unit: '0.4564', cost_unit: 'fl_oz', best_price: '30.90' });
    });

    // The recalculation itself clears a cost whose unit contradicts the catalog's size (cogsResetFor); down() puts it back with the
    // quote, as up() found it (pre-push audit at the seventh push).
    test('a unit cost the recalculation clears (a count cost on the gallon catalog) comes back with down()', async () => {
      const db = world({ catalog: [catalogRow({ cost_per_unit: '1.5000', cost_unit: 'each' })] });
      const knex = fakeKnex(db);
      await migration.up(knex);
      expect(db.products_catalog[0]).toMatchObject({ cost_per_unit: null, cost_unit: null, best_price: 30.9 });
      expect(warn).not.toHaveBeenCalled(); // the recalculation's own reset, not a stale price
      await migration.down(knex);
      expect(db.vendor_pricing[0]).toMatchObject({ price: '58.42' });
      expect(db.products_catalog[0]).toMatchObject({ cost_per_unit: '1.5000', cost_unit: 'each' });
    });

    test('a unit cost entered after up() is kept by down()', async () => {
      const db = world({ catalog: [catalogRow({ cost_per_unit: '0.4564', cost_unit: 'fl_oz' })] });
      const knex = fakeKnex(db);
      await migration.up(knex);
      Object.assign(db.products_catalog[0], { cost_per_unit: '0.3000', cost_unit: 'fl_oz' });
      await migration.down(knex);
      expect(db.vendor_pricing[0]).toMatchObject({ price: '58.42' });
      expect(db.products_catalog[0]).toMatchObject({ cost_per_unit: '0.3000', cost_unit: 'fl_oz' });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/unit cost or price changed since this migration - leaving the unit cost alone/));
    });

    // Job costing reads a unit cost before the catalog price: down() leaves the stale one up() cleared off while a price entered since
    // keeps the catalog price, so costing reads that price (pre-push audit at the eighth push).
    test('a stale unit cost up() cleared stays off while a price entered since keeps the catalog price', async () => {
      const db = world({ catalog: [catalogRow({ cost_per_unit: '0.4564', cost_unit: 'fl_oz' })] });
      const knex = fakeKnex(db);
      await migration.up(knex);
      Object.assign(db.vendor_pricing[0], { price: '29.00', price_amount: '29.0000' }); // an admin's price, and its recalculation
      Object.assign(db.products_catalog[0], { best_price: '29.00', best_price_amount_cached: '29.0000' });
      await migration.down(knex);
      expect(db.vendor_pricing[0]).toMatchObject({ price: '29.00' });
      expect(db.products_catalog[0]).toMatchObject({ cost_per_unit: null, cost_unit: null, best_price: '29.00' });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/unit cost or price changed since this migration - leaving the unit cost alone/));
    });

    // The earlier server/data/pricing.csv row (SiteOne, 1 gal, $57.17, no item number) as the admin pricing import writes it
    // (routes/admin-import-sheets.js with admin-inventory approvedPerOzFields: per-oz figures over its own pack, landed figures and
    // shipping cleared, approved, no expiry): a row it creates has no item number; over an existing row (production's, before the
    // 2026-09-30 entry) it keeps that row's item and records the price it replaced (pre-push audit at the second push).
    const IMPORTED = {
      price: '57.17', price_amount: '57.1700', price_per_oz: '0.4466', normalized_unit_price: '0.4466', unit_normalized: 'oz', landed_cost: null,
      landed_unit_price: null, shipping_cost: null, tax_rate: null, shipping_estimate: null, expires_at: null, approval_status: 'approved', is_active: true,
    };
    const IMPORTED_CATALOG = { best_price: '57.17', best_price_amount_cached: '57.1700' };
    test.each([
      ['a row the import created, with no item number', { vendor_sku: null, previous_price: null }],
      ['the import over production\'s row, its item number kept', { vendor_sku: 'D00001542', previous_price: '58.42' }],
    ])('the earlier sheet\'s $57.17 as the admin import writes it (%s) is corrected like the $58.42 entry', async (_name, extra) => {
      const imported = vendorRow({ ...IMPORTED, ...extra });
      const db = world({ vendors: [imported], catalog: [catalogRow(IMPORTED_CATALOG)] });
      expect(await linkedQuotes(db)).toEqual([993, 993]); // before up(): the Talak config, linked to the Talak name
      const knex = fakeKnex(db);
      await migration.up(knex);
      expect(db.vendor_pricing[0]).toMatchObject({
        previous_price: 57.17, price: 30.9, price_amount: 30.9, landed_cost: 30.9, price_per_oz: 0.2414, normalized_unit_price: 0.2414,
        landed_unit_price: 0.2414, vendor_sku: extra.vendor_sku, quantity: '1 gal', is_active: true, approval_status: 'approved',
      });
      expect(db.price_history).toEqual([expect.objectContaining({ product_id: 'p1', vendor_id: 'ven1', price: 57.17, quantity: '1 gal', source: 'manual' })]);
      expect(db.products_catalog[0]).toMatchObject({
        best_price: 30.9, best_price_amount_cached: 30.9, best_vendor_pricing_id: 'v1', best_price_status: 'current', needs_pricing: false,
      });
      expectRecalculated(knex);
      expect(auditKeys(db)).toEqual(['inventory:lesco_crosscheck_plus_price', 'onetime_preslab', 'onetime_trenching']);
      expect(warn).not.toHaveBeenCalled();
      bothRowsRewritten(db);
      // The pre-slab link now reads the corrected Crosscheck Plus row: $743, never the $57.17 gallon.
      expect(await linkedQuotes(db)).toEqual([743, 743]);
      await migration.down(knex);
      expect(db.vendor_pricing[0]).toMatchObject({
        previous_price: extra.previous_price, price: '57.17', price_amount: '57.1700', landed_cost: null, landed_unit_price: null,
        price_per_oz: '0.4466', normalized_unit_price: '0.4466', vendor_sku: extra.vendor_sku,
      });
      expect(db.price_history).toEqual([]);
      expect(db.products_catalog[0]).toMatchObject({ best_price: 57.17, best_vendor_pricing_id: 'v1', best_price_status: 'current' });
      expect(db.pricing_config_audit).toEqual([]);
    });

    // An imported $57.17 row an admin changed since (shipping: its landed cost would need it) is left alone, and its quote, still a
    // stale gallon, expires like a held $58.42 one; another item number at SiteOne is an independent offer.
    test('an imported $57.17 row with shipping expires like a held $58.42 one; another SiteOne item at $57.17 stays', async () => {
      const held = vendorRow({ ...IMPORTED, vendor_sku: null, shipping_cost: '5.00' });
      const db = world({ vendors: [held], catalog: [catalogRow(IMPORTED_CATALOG)] });
      await migration.up(fakeKnex(db));
      expect(db.vendor_pricing[0]).toMatchObject({ price: '57.17', price_amount: '57.1700', shipping_cost: '5.00' });
      expect(db.vendor_pricing[0].expires_at).toBeInstanceOf(Date);
      expect(warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/still offered the stale \$57\.17 a gallon[\s\S]*now expires at this deploy/);
      expectUnpriced(db.products_catalog[0]);

      const other = vendorRow({ ...IMPORTED, vendor_sku: 'OTHER' });
      const offer = world({ vendors: [other], catalog: [catalogRow(IMPORTED_CATALOG)] });
      await migration.up(fakeKnex(offer));
      expect(offer.vendor_pricing[0]).toMatchObject({ price: '57.17', vendor_sku: 'OTHER', expires_at: null });
      expect(offer.products_catalog[0]).toMatchObject({ best_price: 57.17, best_vendor_pricing_id: 'v1', best_price_status: 'current' });
    });

    // A catalog price a cent away from the stale price at its size is another price (pre-push audit at the first push): with no stale
    // quote, Step P leaves the product alone, and no recalculation runs. $43.81 and $42.87 on a 96 oz row are the stale gallons read
    // at their stored per-oz figures, so they count only with that gallon as the cached pack price (next test); here the catalog
    // caches its own.
    test.each([['128.00', '58.41'], ['128.00', '58.43'], ['96.00', '43.81'], ['96.00', '42.87']])(
      'a catalog row of %s oz at %s, with no stale quote, is left alone',
      async (size, price) => {
        const offer = vendorRow({ vendor_id: 'ven2', vendor_sku: 'X1', is_best_price: true });
        const catalog = catalogRow({ unit_size_oz: size, best_price: price, best_price_amount_cached: price, best_vendor_pricing_id: 'v1' });
        const db = world({ vendors: [offer], catalog: [catalog] });
        const before = JSON.stringify([db.vendor_pricing, db.products_catalog]);
        await migration.up(fakeKnex(db));
        expect(JSON.stringify([db.vendor_pricing, db.products_catalog])).toBe(before);
        expect(inventory.recalcBestPrice).not.toHaveBeenCalled();
        expect(auditKeys(db)).toEqual(['onetime_preslab', 'onetime_trenching']);
        bothRowsRewritten(db);
      },
    );

    // The recalculation writes a stale gallon read at its stored per-oz figure (a pack it cannot read) as that figure times the
    // package size: $57.17 stored as $0.4466 an oz is $57.16 on a 128 oz row, and $42.87 on a 96 oz row; $58.42 stored as $0.4564 an
    // oz is $43.81 there. With that gallon as the cached pack price, it is the stale price, and with no quote offering it the
    // recalculation alone runs, audited, and down() puts the catalog back (pre-push audit at the third push).
    test.each([['128.00', '57.16', '57.1700'], ['96.00', '42.87', '57.1700'], ['96.00', '43.81', '58.4200']])(
      'a catalog row of %s oz at %s with %s cached (a stale gallon at its stored per-oz figure) gets the recalculation',
      async (size, price, cached) => {
        const offer = vendorRow({
          id: 'v2', vendor_id: 'ven2', vendor_sku: 'X1', price: '30.90', price_amount: '30.9000', landed_cost: '30.90', price_per_oz: '0.2414',
          normalized_unit_price: '0.2414', landed_unit_price: '0.2414', is_best_price: false,
        });
        const catalog = catalogRow({ unit_size_oz: size, best_price: price, best_price_amount_cached: cached, best_vendor_pricing_id: 'v1' });
        // The winner the catalog names still exists (its foreign key), as a SiteOne quote the office let expire: no quote offers it.
        const db = world({ vendors: [offer, vendorRow({ expires_at: new Date('2026-11-01T00:00:00.000Z') })], catalog: [catalog] });
        const knex = fakeKnex(db);
        await migration.up(knex);
        expectRecalculated(knex);
        expect(Number(db.products_catalog[0].best_price)).toBe(Math.round((30.9 / 128) * Number(size) * 100) / 100);
        expect(db.products_catalog[0]).toMatchObject({ best_vendor_pricing_id: 'v2', best_price_status: 'current' });
        expect(auditKeys(db)).toEqual(['inventory:lesco_crosscheck_plus_stale', 'onetime_preslab', 'onetime_trenching']);
        await migration.down(knex);
        expect(db.products_catalog[0]).toMatchObject({ best_price: price, best_price_amount_cached: cached, best_vendor_pricing_id: 'v1' });
        expect(db.vendor_pricing[0]).toMatchObject({ price: '30.90', is_best_price: false });
        expect(db.pricing_config_audit).toEqual([]);
      },
    );

    // A SiteOne quote whose pack the recalculation cannot read is read at its stored per-oz figure: $57.17 stored as $0.4466 an oz
    // reads back as $57.16, inside the links' band. It is still the stale entry (its own price is the stale price), so it expires
    // like a held quote at its pack, and down() opens it again (pre-push audit at the third push).
    test.each([['57.17', '57.1700', '0.4466', '57.16'], ['58.42', '58.4200', '0.4564', '58.42']])(
      'a SiteOne quote at %s with a pack the recalculation cannot read (%s, %s an oz) expires',
      async (price, amount, perOz, read) => {
        const quote = vendorRow({
          quantity: '1 jug', price, price_amount: amount, landed_cost: null, landed_unit_price: null, price_per_oz: perOz, normalized_unit_price: perOz,
        });
        const db = world({ vendors: [quote], catalog: [catalogRow({ best_price: read, best_price_amount_cached: amount })] });
        const knex = fakeKnex(db);
        await migration.up(knex);
        expect(db.vendor_pricing[0]).toMatchObject({ price, price_amount: amount, quantity: '1 jug' });
        expect(db.vendor_pricing[0].expires_at).toBeInstanceOf(Date);
        const warnings = warn.mock.calls.map((c) => c[0]).join('\n');
        expect(warnings).toMatch(/price left alone: the vendor row is not the 1 gal pack/);
        expect(warnings).toContain(`still offered the stale $${price} a gallon`);
        expectUnpriced(db.products_catalog[0]);
        await migration.down(knex);
        expect(db.vendor_pricing[0].expires_at ?? null).toBeNull();
        expect(db.products_catalog[0]).toMatchObject({ best_vendor_pricing_id: 'v1', best_price_status: 'current', needs_pricing: false });
        expect(Number(db.products_catalog[0].best_price)).toBe(Number(read));
        expect(db.pricing_config_audit).toEqual([]);
      },
    );

    // Another vendor's $58.42 gallon is an independent offer: once up() expired the held SiteOne quote, the catalog follows that
    // offer at $58.42, current. A second up() recalculates to the same catalog and flags, so it puts the timestamp back and writes
    // no audit row, and down() restores up()'s own changes from its one row (pre-push audit at the third push).
    test('up(), up() again and down() with another vendor winning at $58.42: one audit row, and down() reopens the quote', async () => {
      const independent = vendorRow({ id: 'v2', vendor_id: 'ven2', vendor_sku: 'X1', is_best_price: false });
      const db = world({ vendors: [vendorRow({ shipping_cost: '5.00' }), independent] });
      const knex = fakeKnex(db);
      await migration.up(knex);
      expectExpired(db.vendor_pricing[0]);
      expect(db.products_catalog[0]).toMatchObject({ best_price: 58.42, best_vendor_pricing_id: 'v2', best_price_status: 'current' });
      expect(auditKeys(db)).toEqual(['inventory:lesco_crosscheck_plus_stale', 'onetime_preslab', 'onetime_trenching']);
      const once = JSON.stringify([db.products_catalog, db.vendor_pricing, db.pricing_config_audit, db.pricing_changelog, db.pricing_config]);
      await migration.up(knex);
      expectRecalculated(knex, 2); // the second run's recalculation found nothing to change
      expect(JSON.stringify([db.products_catalog, db.vendor_pricing, db.pricing_config_audit, db.pricing_changelog, db.pricing_config])).toBe(once);
      await migration.down(knex);
      expect(db.vendor_pricing[0].expires_at ?? null).toBeNull();
      expect(db.pricing_config_audit).toEqual([]);
      expect(db.pricing_changelog).toEqual([]);
    });

    // The price as Inventory's price entry writes it: every price field at the new figure, so no field still shows the stale entry.
    test.each([['45.00', '0.3516'], ['30.50', '0.2383']])('a price an admin edited (%s) is left alone with a warning; both rows are still rewritten', async (price, perOz) => {
      const db = world({
        vendors: [vendorRow({
          price, price_amount: price, landed_cost: price, price_per_oz: perOz, normalized_unit_price: perOz, landed_unit_price: perOz,
        })],
        catalog: [catalogRow({ best_price: price, best_price_amount_cached: price })],
      });
      await migration.up(fakeKnex(db));
      expect(db.vendor_pricing[0]).toMatchObject({ price, price_amount: price });
      expect(db.vendor_pricing[0].expires_at ?? null).toBeNull(); // the later entry stays a current quote
      expect(db.price_history).toEqual([]);
      expect(warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/price left alone/);
      // The pre-slab link then follows that later catalog entry inside the bridge's band.
      bothRowsRewritten(db);
      expect(db.pricing_config_audit.map((r) => r.config_key).sort()).toEqual(['onetime_preslab', 'onetime_trenching']);
    });

    // Pre-push audit 9: job costing reads the catalog best_price directly (calculateInventoryCost), so it must not keep $58.42.
    test('two vendor rows: the stale SiteOne row is corrected, then the inventory recalculation picks the catalog best price', async () => {
      const db = world({ vendors: [vendorRow(), SECOND_VENDOR] });
      const knex = fakeKnex(db);
      const pricedAtRecalc = [];
      inventory.recalcBestPrice.mockImplementation(async (id, conn) => {
        pricedAtRecalc.push((await conn('vendor_pricing').where({ id: 'v1' }).first()).price);
        return realRecalc(id, conn);
      });
      await migration.up(knex);
      expect(db.vendor_pricing.map((v) => v.price)).toEqual([30.9, '70.00']);
      expect(db.vendor_pricing[0]).toMatchObject({ previous_price: 58.42, price_amount: 30.9, landed_cost: 30.9, price_per_oz: 0.2414 });
      expect(db.price_history).toHaveLength(1);
      expectRecalculated(knex);
      expect(pricedAtRecalc).toEqual([30.9]);
      expect(db.products_catalog[0]).toMatchObject({ best_price: 30.9, best_vendor_pricing_id: 'v1', needs_pricing: false, best_price_status: 'current' });
      expect(warn.mock.calls.map((c) => c[0]).join('\n')).not.toMatch(/needs pricing/);
      bothRowsRewritten(db);
      expect(auditKeys(db)).toEqual(['inventory:lesco_crosscheck_plus_price', 'onetime_preslab', 'onetime_trenching']);
      const price = db.pricing_config_audit.find((r) => r.config_key === migration.CATALOG_AUDIT_KEY);
      expect(JSON.parse(price.new_value).catalog_recalculated).toMatchObject({ best_price: 30.9, best_vendor_pricing_id: 'v1', needs_pricing: false });
      expect(JSON.parse(price.old_value).catalog_seen).toMatchObject({ best_price: '58.42', best_vendor_pricing_id: 'v1' });
      expect(JSON.parse(db.pricing_changelog[0].after_value).bifenthrin).not.toMatch(/is expired/);
      const after = snapshot(db);
      await migration.up(knex);
      expect(snapshot(db)).toBe(after); // a re-run is a no-op
      expect(inventory.recalcBestPrice).toHaveBeenCalledTimes(1);
    });

    // Another vendor listing the same item number is its own offer (pre-push audit 25): only the SiteOne row is corrected, and the
    // other quote stays current. The corrected $30.90 is cheaper per oz, so the recalculation picks it.
    test('the same item number at another vendor too: only the SiteOne row is corrected; the other vendor\'s quote stays', async () => {
      const elsewhere = vendorRow({ id: 'v2', vendor_id: 'ven2', is_best_price: false });
      const db = world({ vendors: [vendorRow(), elsewhere] });
      const knex = fakeKnex(db);
      await migration.up(knex);
      expect(db.vendor_pricing.map((v) => v.price)).toEqual([30.9, '58.42']);
      expect(db.vendor_pricing[1]).toEqual(elsewhere);
      expect(warn.mock.calls.map((c) => c[0]).join('\n')).not.toMatch(STALE_WARNING);
      const price = db.pricing_config_audit.find((r) => r.config_key === migration.CATALOG_AUDIT_KEY);
      expect(JSON.parse(price.old_value).stale_quotes).toEqual([]);
      expect(JSON.parse(db.pricing_changelog[0].after_value).bifenthrin).not.toMatch(/is expired/);
      expect(db.price_history).toHaveLength(1);
      expect(db.price_history[0]).toMatchObject({ vendor_id: 'ven1' });
      expect(db.products_catalog[0]).toMatchObject({ best_price: 30.9, best_vendor_pricing_id: 'v1', needs_pricing: false, best_price_status: 'current' });
      bothRowsRewritten(db);
      await migration.down(knex);
      expect(db.vendor_pricing[0]).toMatchObject({ price: '58.42', price_amount: '58.4200' });
      expect(db.vendor_pricing[1]).toMatchObject({ price: '58.42' });
      expect(db.vendor_pricing[1].expires_at).toBeUndefined();
      expect(db.price_history).toEqual([]);
      expect(db.pricing_config_audit).toEqual([]);
    });

    // Pre-push audit at the fourth push: an archived SiteOne row (inactive, unapproved or expired) steers no price, so it does not
    // count. The one current quote beside it is corrected, not expired, and the archived row stays as it was through down().
    test.each([
      ['inactive', { is_active: false }],
      ['unapproved', { approval_status: 'pending' }],
      ['expired', { expires_at: new Date('2026-11-01T00:00:00.000Z') }],
    ])('an archived (%s) SiteOne row beside the current $58.42 quote: the current quote is corrected; the archived row stays', async (_name, archived) => {
      const old = vendorRow({ id: 'v0', is_best_price: false, ...archived });
      const db = world({ vendors: [vendorRow(), old] });
      const knex = fakeKnex(db);
      await migration.up(knex);
      expect(db.vendor_pricing[0]).toMatchObject({ price: 30.9, price_amount: 30.9, previous_price: 58.42 });
      expect(db.vendor_pricing[1]).toEqual(old);
      const warnings = warn.mock.calls.map((c) => c[0]).join('\n');
      expect(warnings).not.toMatch(/price left alone/);
      expect(warnings).not.toMatch(STALE_WARNING);
      expect(db.products_catalog[0]).toMatchObject({ best_price: 30.9, best_vendor_pricing_id: 'v1', needs_pricing: false, best_price_status: 'current' });
      expect(auditKeys(db)).toEqual(['inventory:lesco_crosscheck_plus_price', 'onetime_preslab', 'onetime_trenching']);
      await migration.down(knex);
      expect(db.vendor_pricing[0]).toMatchObject({ price: '58.42', price_amount: '58.4200', is_best_price: true });
      expect(db.vendor_pricing[1]).toEqual(old);
      expect(db.products_catalog[0]).toMatchObject({ best_vendor_pricing_id: 'v1', needs_pricing: false, best_price_status: 'current' });
      expect(Number(db.products_catalog[0].best_price)).toBe(58.42);
      expect(db.price_history).toEqual([]);
      expect(db.pricing_config_audit).toEqual([]);
    });

    // Two current SiteOne quotes: Step P cannot tell which one the office buys from, so it corrects neither. Both still offer the
    // stale gallon, so both expire, and the catalog waits for the price in the app.
    test('two current SiteOne quotes at the stale price: neither is corrected, and both expire', async () => {
      const db = world({ vendors: [vendorRow(), vendorRow({ id: 'v4', vendor_sku: null, is_best_price: false })] });
      await migration.up(fakeKnex(db));
      expect(db.vendor_pricing.map((v) => v.price)).toEqual(['58.42', '58.42']);
      const warnings = warn.mock.calls.map((c) => c[0]).join('\n');
      expect(warnings).toMatch(/\(p1\) price left alone: it does not have exactly one current SiteOne quote/);
      expect(warnings).toMatch(STALE_WARNING);
      db.vendor_pricing.forEach(expectExpired);
      expectUnpriced(db.products_catalog[0]);
    });

    // Pre-push audit 25: another vendor's $58.42 for 2.5 gal is $23.37 a gallon, a real offer below the corrected $30.90. It stays
    // current, and the recalculation picks it by its own per-oz price.
    test('another vendor\'s $58.42 for 2.5 gal ($23.37 a gallon) is its own offer: it stays, and the catalog takes it', async () => {
      const bulk = vendorRow({
        id: 'v2', vendor_id: 'ven9', vendor_sku: 'BULK25', quantity: '2.5 gal', landed_cost: '58.42', price_per_oz: '0.1826',
        normalized_unit_price: '0.1826', landed_unit_price: '0.1826', is_best_price: false,
      });
      const db = world({ vendors: [vendorRow(), bulk] });
      await migration.up(fakeKnex(db));
      expect(db.vendor_pricing[0]).toMatchObject({ price: 30.9, price_amount: 30.9 });
      expect(db.vendor_pricing[1]).toEqual({ ...bulk, is_best_price: true });
      expect(warn.mock.calls.map((c) => c[0]).join('\n')).not.toMatch(STALE_WARNING);
      expect(db.products_catalog[0]).toMatchObject({ best_price: 23.37, best_vendor_pricing_id: 'v2', needs_pricing: false, best_price_status: 'current' });
    });

    // p2 has no quote of its own, so its $58.42 is no current price: the recalculation alone leaves it with none.
    test('two catalog rows named LESCO Crosscheck Plus: each is its own product; one is fixed, the other is recalculated', async () => {
      const db = world({ catalog: [catalogRow(), catalogRow({ id: 'p2', best_vendor_pricing_id: null })] });
      await migration.up(fakeKnex(db));
      expect(db.vendor_pricing[0].price).toBe(30.9);
      expect(db.products_catalog[0]).toMatchObject({ best_price: 30.9, needs_pricing: false, best_price_status: 'current' });
      const warnings = warn.mock.calls.map((c) => c[0]).join('\n');
      expect(warnings).toMatch(/\(p2\) price left alone: it does not have exactly one current SiteOne quote \(item D00001542 or none; an archived row does not count\)/);
      expect(warnings).not.toMatch(STALE_WARNING);
      expectUnpriced(db.products_catalog[1]);
      expect(auditKeys(db)).toEqual(['inventory:lesco_crosscheck_plus_price', 'inventory:lesco_crosscheck_plus_stale', 'onetime_preslab', 'onetime_trenching']);
      bothRowsRewritten(db);
    });

    // Earlier migrations add each table and column the inventory recalculation reads or writes: without one, inventory is left alone
    // and the config rows still move (pre-push audit 26: the eligibility predicate reads price_amount, so a missing one would abort
    // the whole transaction).
    test.each([
      'vendor_pricing.approval_status', 'vendor_pricing.expires_at', 'vendor_pricing.price_amount', 'vendor_pricing.is_best_price',
      'products_catalog.needs_pricing', 'products_catalog.cost_per_unit', 'vendors.name', 'vendors',
    ])('a required table or column missing (%s): inventory is left alone with a warning', async (missing) => {
      const db = world({ vendors: [vendorRow(), SECOND_VENDOR] });
      if (missing.includes('.')) db.__missingColumns = [missing];
      else delete db[missing];
      const before = JSON.stringify([db.vendor_pricing, db.products_catalog]);
      await migration.up(fakeKnex(db));
      expect(JSON.stringify([db.vendor_pricing, db.products_catalog])).toBe(before);
      expect(db.price_history).toEqual([]);
      expect(inventory.recalcBestPrice).not.toHaveBeenCalled();
      expect(warn.mock.calls.map((c) => c[0]).join('\n')).toContain(`price left alone: a required table or column is missing: ${missing}`);
      bothRowsRewritten(db);
    });

    test('held: the admin seed moves like the Talak rows; a row with no bifenthrin product anywhere is left alone with a warning', async () => {
      const db = world({ preslab: preslabRow(SEED_PRESLAB, SEED_PRESLAB), trench: { floor: 600 }, vendors: [vendorRow({ shipping_cost: '5.00' })] });
      await migration.up(fakeKnex(db));
      for (const option of OPTIONS) expect(productOf(db, 'onetime_preslab', option)).toEqual(PRESLAB_REWRITTEN);
      expect(rowOf(db, 'onetime_trenching')).toEqual({ floor: 600 });
      expect(warn.mock.calls.map((c) => c[0]).join('\n'))
        .toMatch(/onetime_trenching has no talstar_p product - the code default \(Crosscheck Plus\) applies/);
      expectExpired(db.vendor_pricing[0]);
      expectUnpriced(db.products_catalog[0]);
    });

    // db-bridge reads a product from (products || product_costs)[key], then the row's own key: each place moves on its own.
    test('a legacy product_costs map and top-level product keys move like the products map; a re-run changes nothing; down() restores them', async () => {
      const legacy = { usage_step_sqft: 100, link_container_costs_to_catalog: true, product_costs: { talstar_p: PROD_PRESLAB_PRODUCT, bifen_it: PROD_PRESLAB_PRODUCT } };
      const top = { floor: 600, talstar_p: PROD_TRENCH_PRODUCT, bifen_it: PROD_TRENCH_PRODUCT };
      const db = world({ preslab: legacy, trench: top });
      const knex = fakeKnex(db);
      await migration.up(knex);
      for (const option of OPTIONS) {
        expect(rowOf(db, 'onetime_preslab').product_costs[option]).toEqual(PRESLAB_REWRITTEN);
        expect(rowOf(db, 'onetime_trenching')[option]).toEqual(TRENCH_REWRITTEN);
      }
      expect(rowOf(db, 'onetime_preslab')).toMatchObject({ usage_step_sqft: 100, link_container_costs_to_catalog: true });
      expect(rowOf(db, 'onetime_trenching').floor).toBe(600);
      expect(auditKeys(db)).toEqual(['inventory:lesco_crosscheck_plus_price', 'onetime_preslab', 'onetime_trenching']);
      const after = snapshot(db);
      await migration.up(knex);
      expect(snapshot(db)).toBe(after);
      await migration.down(knex);
      expect(rowOf(db, 'onetime_preslab')).toEqual(legacy);
      expect(rowOf(db, 'onetime_trenching')).toEqual(top);
      expect(db.pricing_config_audit).toEqual([]);
    });

    test('a Talak copy beside the products map moves too; an edited copy is left alone with a warning naming its place', async () => {
      const edited = { ...PROD_PRESLAB_PRODUCT, container_cost: 44 };
      const db = world({ preslab: { ...preslabRow(), talstar_p: PROD_PRESLAB_PRODUCT, bifen_it: edited } });
      const knex = fakeKnex(db);
      await migration.up(knex);
      bothRowsRewritten(db);
      expect(rowOf(db, 'onetime_preslab').talstar_p).toEqual(PRESLAB_REWRITTEN);
      expect(rowOf(db, 'onetime_preslab').bifen_it).toEqual(edited);
      expect(warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/onetime_preslab\.bifen_it was edited since the Talak swap/);
      await migration.down(knex);
      expect(rowOf(db, 'onetime_preslab')).toEqual({ ...preslabRow(), talstar_p: PROD_PRESLAB_PRODUCT, bifen_it: edited });
    });

    // Step P leaves each of these prices alone (pre-push audits 24 and 25):
    // - expired: an eligible SiteOne D00001542 quote the recalculation would still read as $58.42 a gallon expires, then the
    //   recalculation runs and finds no current quote;
    // - unpriced: a quote out of the recalculation already (ineligible, or its vendor not on file) stays as it is, and the
    //   recalculation still runs for the catalog holding its $58.42;
    // - offer: another SKU, vendor or price for the pack is an independent offer; it stays current, and the catalog follows it at
    //   the price the recalculation reads (owner 2026-07-10).
    // No price, history row or snapshot is written either way.
    test.each([
      ['a different SKU', { vendors: [vendorRow({ vendor_sku: 'OTHER' })] }, 'offer', 58.42],
      ['the same item number at another vendor', { vendors: [vendorRow({ vendor_id: 'ven2' })] }, 'offer', 58.42],
      ['a vendor row whose price_amount an admin changed', { vendors: [vendorRow({ price_amount: '32.0000' })] }, 'offer', 32],
      ['a vendor pack that is not 1 gal', { vendors: [vendorRow({ quantity: '2.5 gal' })] }, 'offer', 23.37],
      ['a vendor row whose vendor is not on file', { vendors: [vendorRow({ vendor_id: 'gone' })] }, 'unpriced', null],
      ['an inactive vendor row', { vendors: [vendorRow({ is_active: false })] }, 'unpriced', null],
      ['an unapproved vendor row', { vendors: [vendorRow({ approval_status: 'pending' })] }, 'unpriced', null],
      ['an expired vendor quote', { vendors: [vendorRow({ expires_at: new Date('2026-11-01T00:00:00.000Z') })] }, 'unpriced', null],
      ['an expired vendor quote (string date)', { vendors: [vendorRow({ expires_at: '2026-11-01T00:00:00.000Z' })] }, 'unpriced', null],
      ['an auto-approved vendor row (eligible, but not the approved row Step P corrects)', { vendors: [vendorRow({ approval_status: 'auto_approved' })] }, 'expired', null],
      ['a vendor row not priced per oz', { vendors: [vendorRow({ unit_normalized: 'count' })] }, 'expired', null],
      ['a vendor row with shipping (the landed cost would need it)', { vendors: [vendorRow({ shipping_cost: '5.00' })] }, 'expired', null],
      ['a vendor row with tax (the landed cost would need it)', { vendors: [vendorRow({ tax_rate: '0.07' })] }, 'expired', null],
      ['a vendor row with a shipping estimate', { vendors: [vendorRow({ shipping_estimate: '5.00' })] }, 'expired', null],
      // The price sync can store freight in landed_unit_price with no shipping column (pre-push audit 11).
      ['a vendor row whose landed unit price holds freight', { vendors: [vendorRow({ landed_unit_price: '0.5000' })] }, 'expired', null],
      ['a vendor row whose landed cost is not its price', { vendors: [vendorRow({ landed_cost: '63.42' })] }, 'expired', null],
    ])('%s: the price is left alone with a warning (%s)', async (_name, overrides, outcome, offerPrice) => {
      const db = world(overrides);
      const prices = () => JSON.stringify([db.vendor_pricing.map(({ expires_at: _e, is_best_price: _b, ...quote }) => quote), db.price_history]);
      const before = prices();
      const knex = fakeKnex(db);
      await migration.up(knex);
      expect(prices()).toBe(before);
      const warnings = warn.mock.calls.map((c) => c[0]).join('\n');
      expect(warnings).toMatch(/price left alone/);
      expect(auditKeys(db)).not.toContain('inventory:lesco_crosscheck_plus_price');
      expectRecalculated(knex);
      if (outcome === 'offer') {
        expect(db.products_catalog[0]).toMatchObject({ best_price: offerPrice, best_vendor_pricing_id: 'v1', needs_pricing: false, best_price_status: 'current' });
      } else {
        expectUnpriced(db.products_catalog[0]);
      }
      // Every outcome is recorded: the stale quote it expired, or the catalog the recalculation alone rewrote.
      expect(auditKeys(db)).toContain('inventory:lesco_crosscheck_plus_stale');
      const own = JSON.parse(db.pricing_config_audit.find((r) => r.config_key === migration.STALE_AUDIT_KEY).new_value);
      expect(own.catalog_only).toBe(outcome !== 'expired');
      if (outcome === 'expired') {
        expect(warnings).toMatch(STALE_WARNING);
        expectExpired(db.vendor_pricing[0]);
        expect(JSON.parse(db.pricing_changelog[0].after_value).bifenthrin).toMatch(/still at a stale price \(\$58\.42 or \$57\.17 a gallon\) is expired/);
      } else {
        expect(warnings).not.toMatch(STALE_WARNING);
        expect(db.vendor_pricing[0].expires_at).toEqual(overrides.vendors[0].expires_at);
      }
      bothRowsRewritten(db);
      // down() opens an expired quote again (only while it still holds what up() wrote) and recalculates, or, with nothing to
      // reopen, puts back the catalog the recalculation rewrote and its winner flag: either way the catalog is the $58.42 it held.
      await migration.down(knex);
      expect(prices()).toBe(before);
      expect(db.vendor_pricing[0].expires_at ?? null).toEqual(overrides.vendors[0].expires_at ?? null);
      expect(db.vendor_pricing[0].is_best_price).toBe(true);
      expect(db.products_catalog[0]).toMatchObject({ best_vendor_pricing_id: 'v1', needs_pricing: false, best_price_status: 'current' });
      expect(Number(db.products_catalog[0].best_price)).toBe(58.42);
      expect(db.pricing_config_audit).toEqual([]);
    });

    // Pre-push audits 25 and 26: with no current quote the recalculation can scale to the catalog (a pack it cannot read, with no
    // per-oz figure), it keeps the catalog price marked stale (needs_pricing), and so does every later one, while job costing reads
    // best_price as it stands. So a catalog it leaves on the stale price gets the owner's $30.90 per 128 fl oz at its package size,
    // still marked: job costing reads $0.2414 an oz, and no link reads a marked row. A cleared price would not hold: the next
    // recalculation would write the case's raw $40 as current. down() puts the catalog back as up() saw it.
    const UNREAD_PACK = {
      id: 'v3', product_id: 'p1', vendor_id: 'ven9', vendor_sku: 'CASE6', price: '40.00', price_amount: '40.0000', quantity: 'case',
      unit_normalized: null, normalized_unit_price: null, price_per_oz: null, landed_unit_price: null, is_active: true, approval_status: 'approved',
      is_best_price: false,
    };
    const AT_96_OZ = { unit_size_oz: '96.00', best_price: '43.82' };
    test.each([
      ['the stale quote expires', [vendorRow({ shipping_cost: '5.00' }), UNREAD_PACK], {}, 30.9, /is expired/],
      ['no quote offers the stale price', [vendorRow({ is_active: false }), UNREAD_PACK], {}, 30.9, /is the owner's \$30\.90 per 128 fl oz, marked needs pricing/],
      // $30.90 x 96 / 128 = $23.175: scaled from whole cents and rounded once (pre-push audit 27).
      ['a 96 oz catalog row at the stale $43.82 with no quote offering it', [vendorRow({ is_active: false }), UNREAD_PACK], AT_96_OZ, 23.18, /is the owner's/],
    ])('%s, and the only current quote has a pack the inventory cannot read: the catalog holds the owner\'s price, still marked', async (_name, vendors, catalog, price, changelog) => {
      const db = world({ vendors, catalog: [catalogRow(catalog)] });
      const knex = fakeKnex(db);
      await migration.up(knex);
      expect(db.vendor_pricing[1]).toEqual(UNREAD_PACK); // its own offer: never expired
      // The cached pack price (the job card's "Order more" price) moves with it (pre-push audit 28).
      const owners = { best_price: price, best_price_amount_cached: 30.9, best_price_status: 'stale', needs_pricing: true };
      expect(db.products_catalog[0]).toMatchObject(owners);
      expect(db.vendor_pricing.map((quote) => quote.is_best_price)).toEqual([false, false]); // the recalculation cleared the winner flag
      // Job costing reads the owner's $0.2414 an oz (to a tenth of a cent: $23.18 / 96 rounds to $0.2415).
      const { unitCost } = calculateInventoryCost({ product: db.products_catalog[0], deductedAmount: 16, inventoryUnit: 'fl_oz', amount: 16, amountUnit: 'fl_oz' });
      expect(unitCost).toBeCloseTo(30.9 / 128, 3);
      expect(warn.mock.calls.map((c) => c[0]).join('\n'))
        .toContain(`marked needs pricing. The catalog price is now ${price}, the owner's $30.90 per 128 fl oz at its package size, still marked`);
      const own = db.pricing_config_audit.find((r) => r.config_key === migration.STALE_AUDIT_KEY);
      expect(JSON.parse(own.new_value)).toMatchObject({ catalog_repriced: true, catalog_recalculated: { best_price: price, needs_pricing: true } });
      expect(JSON.parse(db.pricing_changelog[0].after_value).bifenthrin).toMatch(changelog);
      // A later recalculation (an admin's price entry for another vendor runs one) keeps it, marked: never the case's $40 as current.
      const later = structuredClone(db);
      await realRecalc('p1', fakeKnex(later));
      expect(later.products_catalog[0]).toMatchObject(owners);
      expect(later.vendor_pricing.map((quote) => quote.is_best_price)).toEqual([false, false]);
      await migration.down(knex);
      expect(db.products_catalog[0]).toMatchObject({ best_vendor_pricing_id: 'v1', needs_pricing: false, best_price_status: 'current' });
      expect(Number(db.products_catalog[0].best_price)).toBe(Number(catalogRow(catalog).best_price));
      expect(Number(db.products_catalog[0].best_price_amount_cached)).toBe(58.42);
      expect(db.vendor_pricing.map((quote) => quote.is_best_price)).toEqual([true, false]); // the winner's flag is back with it
      expect(db.pricing_config_audit).toEqual([]);
    });

    // Pre-push audit 27: a SiteOne D00001542 quote whose pack the inventory cannot read, with no per-oz figure, has no known gallon
    // price, so it stays and its auto-orders keep working. The recalculation cannot scale it and keeps the catalog's stale $58.42
    // marked, so the catalog gets the owner's price, still marked; down() puts the catalog and the winner flag back.
    test('a SiteOne quote whose pack the inventory cannot read stays; the catalog holds the owner\'s price, still marked', async () => {
      const unread = vendorRow({ quantity: 'case', price_per_oz: null, normalized_unit_price: null, landed_unit_price: null });
      const db = world({ vendors: [unread] });
      const knex = fakeKnex(db);
      await migration.up(knex);
      expect(db.vendor_pricing[0]).toEqual({ ...unread, is_best_price: false });
      const warnings = warn.mock.calls.map((c) => c[0]).join('\n');
      expect(warnings).toMatch(/price left alone/);
      expect(warnings).not.toMatch(STALE_WARNING);
      expect(db.products_catalog[0])
        .toMatchObject({ best_price: 30.9, best_price_amount_cached: 30.9, best_price_status: 'stale', needs_pricing: true });
      expect(auditKeys(db)).toContain('inventory:lesco_crosscheck_plus_stale');
      await migration.down(knex);
      expect(db.vendor_pricing[0]).toEqual(unread);
      expect(db.products_catalog[0]).toMatchObject({
        best_vendor_pricing_id: 'v1', best_price: '58.42', best_price_amount_cached: '58.4200', needs_pricing: false, best_price_status: 'current',
      });
      expect(db.pricing_config_audit).toEqual([]);
    });

    // Pre-push audit 24: the recalculation scales the winner to the catalog's own package size, so on a 96 oz catalog row the stale
    // gallon reads $43.82. The held quote expires whatever the package size, and a catalog holding $43.82 with no quote is recalculated.
    test.each([
      ['a held quote', [vendorRow({ shipping_cost: '5.00' })], true],
      ['an inactive quote', [vendorRow({ is_active: false })], false],
    ])('a 96 oz catalog row at the stale $43.82, %s: the catalog keeps no stale price', async (_name, vendors, expired) => {
      const db = world({ catalog: [catalogRow({ unit_size_oz: '96.00', best_price: '43.82' })], vendors });
      await migration.up(fakeKnex(db));
      expectUnpriced(db.products_catalog[0]);
      if (expired) expectExpired(db.vendor_pricing[0]);
      else expect(db.vendor_pricing[0].expires_at).toBeUndefined();
    });

    // Pre-push audit at the fifth push: when the recalculation alone ran, down() puts back the catalog up() saw, winner included. That
    // quote (or its vendor) can be deleted since: its id would break the catalog's foreign keys and abort the rollback, so down()
    // recalculates from the quotes that remain instead.
    const OFFER_3090 = vendorRow({
      id: 'v2', vendor_id: 'ven2', vendor_sku: 'X1', price: '30.90', price_amount: '30.9000', landed_cost: '30.90', price_per_oz: '0.2414',
      normalized_unit_price: '0.2414', landed_unit_price: '0.2414', is_best_price: false,
    });
    test.each([
      ['the quote', { best_vendor_pricing_id: 'v1' }, (db) => { db.vendor_pricing = db.vendor_pricing.filter((v) => v.id !== 'v1'); }],
      ['its vendor, with its quotes', { best_vendor_pricing_id: null, best_price_vendor_id_cached: 'ven1' }, (db) => {
        db.vendors = db.vendors.filter((v) => v.id !== 'ven1');
        db.vendor_pricing = db.vendor_pricing.filter((v) => v.vendor_id !== 'ven1');
      }],
    ])('the winner up() saw is gone since (%s): down() recalculates the catalog instead of restoring it', async (_name, seen, remove) => {
      const expired = vendorRow({ expires_at: new Date('2026-11-01T00:00:00.000Z') });
      const db = world({ vendors: [OFFER_3090, expired], catalog: [catalogRow(seen)] });
      const knex = fakeKnex(db);
      await migration.up(knex);
      expect(db.products_catalog[0]).toMatchObject({ best_price: 30.9, best_vendor_pricing_id: 'v2', best_price_status: 'current' });
      expect(JSON.parse(db.pricing_config_audit.find((r) => r.config_key === migration.STALE_AUDIT_KEY).new_value).catalog_only).toBe(true);
      remove(db);
      await migration.down(knex);
      const warnings = warn.mock.calls.map((c) => c[0]).join('\n');
      expect(warnings).toMatch(/down: the quote or vendor the LESCO Crosscheck Plus catalog held before this migration is gone - recalculating it/);
      expectRecalculated(knex, 2); // up(), then down() over the quotes that remain
      expect(db.products_catalog[0]).toMatchObject({
        best_price: 30.9, best_vendor_pricing_id: 'v2', best_price_vendor_id_cached: 'ven2', best_price_status: 'current',
      });
      expect(db.pricing_config_audit).toEqual([]);
    });

    test('a quote changed since up() keeps its expiry state through down(); the products still restore', async () => {
      const db = world({ vendors: [vendorRow({ shipping_cost: '5.00' })] });
      const knex = fakeKnex(db);
      await migration.up(knex);
      expectExpired(db.vendor_pricing[0]);
      // The admin enters the price in Inventory: the handler re-approves the quote with no expiry.
      db.vendor_pricing[0] = { ...db.vendor_pricing[0], price: '30.90', price_amount: '30.9000', expires_at: null };
      await migration.down(knex);
      expect(db.vendor_pricing[0]).toMatchObject({ price: '30.90', expires_at: null });
      expect(warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/down: the LESCO Crosscheck Plus quote v1 changed since this migration - leaving it alone/);
      expectRecalculated(knex); // up() only
      expect(productOf(db, 'onetime_preslab', 'talstar_p')).toEqual(PROD_PRESLAB_PRODUCT);
    });

    // Whatever the catalog row holds, the handler's own recalculation picks the winner from current prices once the SiteOne row is
    // corrected (here the corrected row) and writes its status: a catalog row already marked stale is current again (pre-push
    // audit 10), so the links read it.
    test.each([
      ['a winner that is not the vendor row', { catalog: [catalogRow({ best_vendor_pricing_id: 'other' })] }],
      ['a winner at another vendor\'s price', OTHER_WINNER_WORLD],
      ['an inactive product', { catalog: [catalogRow({ active: false })] }],
      ['a catalog size that is not 128 oz', { catalog: [catalogRow({ unit_size_oz: '96.00' })] }],
      ['a catalog row already marked stale', { catalog: [catalogRow({ needs_pricing: true, best_price_status: 'stale' })] }],
    ])('%s: the SiteOne row is corrected and the inventory recalculation picks the catalog best price', async (_name, overrides) => {
      const db = world(overrides);
      const knex = fakeKnex(db);
      await migration.up(knex);
      expect(db.vendor_pricing[0]).toMatchObject({ previous_price: 58.42, price: 30.9, price_amount: 30.9, landed_cost: 30.9, price_per_oz: 0.2414 });
      expect(db.price_history).toHaveLength(1);
      expectRecalculated(knex);
      expect(db.products_catalog[0]).toMatchObject({ best_vendor_pricing_id: 'v1', needs_pricing: false, best_price_status: 'current' });
      expect(warn.mock.calls.map((c) => c[0]).join('\n')).not.toMatch(/needs pricing/);
      expect(auditKeys(db)).not.toContain('inventory:lesco_crosscheck_plus_stale');
      bothRowsRewritten(db);
    });

    // The new snapshot keeps the expiry the vendor row keeps, so the price evidence never outlives the quote (pre-push audit 21).
    test('a vendor quote that expires later is corrected like an open one, and its snapshot expires with it', async () => {
      const later = new Date(Date.now() + 30 * 24 * 3600 * 1000);
      const db = world({ vendors: [vendorRow({ expires_at: later })] });
      db.price_snapshots = [];
      await migration.up(fakeKnex(db));
      expect(db.vendor_pricing[0]).toMatchObject({ price: 30.9, price_amount: 30.9, expires_at: later });
      expect(db.price_snapshots).toEqual([expect.objectContaining({ price: 30.9, expires_at: later })]);
      expect(db.vendor_pricing[0].latest_snapshot_id).toBe(db.price_snapshots[0].id);
      expect(db.products_catalog[0]).toMatchObject({ best_price: 30.9, needs_pricing: false, best_price_status: 'current' });
      expect(warn).not.toHaveBeenCalled();
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

    // Pre-push audit at the fifth push: a product with no label of its own shows the code's label (db-bridge sets only a non-empty
    // one), Crosscheck Plus after this change. One that carries another bottle's figures takes the new bottle whatever else an admin
    // changed (its margin, rates and anything added stay); one with a label of its own that an admin changed is left alone.
    test('a product with no label of its own takes the new bottle whatever an admin changed; one with its own label is left alone', async () => {
      const db = world({
        preslab: preslabRow({ ...SEED_PRESLAB, margin_divisor: 0.6, requires_label_confirmation: true }, { ...SEED_PRESLAB, container_cost: 45 }),
        trench: trenchRow({ ...SEED_TRENCH, label: 'Mine' }, { ...SEED_TRENCH, product_oz_per_finished_gallon_at_high_rate: 1.5, label: ' ' }),
        catalog: [],
        vendors: [],
      });
      const original = JSON.stringify(db.pricing_config);
      const knex = fakeKnex(db);
      await migration.up(knex);
      expect(productOf(db, 'onetime_preslab', 'talstar_p')).toEqual({ ...PRESLAB_REWRITTEN, margin_divisor: 0.6, requires_label_confirmation: true });
      expect(productOf(db, 'onetime_preslab', 'bifen_it')).toEqual(PRESLAB_REWRITTEN);
      expect(productOf(db, 'onetime_trenching', 'talstar_p')).toEqual({ ...SEED_TRENCH, label: 'Mine' });
      expect(productOf(db, 'onetime_trenching', 'bifen_it')).toEqual({ ...TRENCH_REWRITTEN, product_oz_per_finished_gallon_at_high_rate: 1.5 });
      const warnings = warn.mock.calls.map((c) => c[0]).join('\n');
      expect(warnings).toMatch(/onetime_trenching\.products\.talstar_p was edited since the Talak swap/);
      expect(warnings).not.toMatch(/onetime_preslab\.products|onetime_trenching\.products\.bifen_it/);
      await migration.down(knex);
      expect(db.pricing_config.map((r) => JSON.parse(r.data))).toEqual(JSON.parse(original).map((r) => JSON.parse(r.data)));
    });

    // Such a product keeps an admin's own positioning and warnings: its Talak warning moves to the Crosscheck Plus wording in place,
    // and a re-run changes nothing and warns about nothing (pre-push audit at the eleventh push).
    test('a product with no label of its own keeps an admin\'s positioning and warnings; its Talak warning moves in place', async () => {
      const officeNote = 'Office: call the builder before the slab pour.';
      const preslab = { ...SEED_PRESLAB, positioning: 'premium_repellent', warnings: [TALAK_WARNING, officeNote] };
      const trench = { ...SEED_TRENCH, warnings: [officeNote] };
      const db = world({ preslab: preslabRow(preslab, SEED_PRESLAB), trench: trenchRow(trench, SEED_TRENCH), catalog: [], vendors: [] });
      const original = JSON.stringify(db.pricing_config);
      const knex = fakeKnex(db);
      await migration.up(knex);
      expect(productOf(db, 'onetime_preslab', 'talstar_p')).toEqual({
        ...PRESLAB_REWRITTEN, positioning: 'premium_repellent', warnings: [CROSSCHECK_PRESLAB.warnings[0], officeNote],
      });
      expect(productOf(db, 'onetime_preslab', 'bifen_it')).toEqual(PRESLAB_REWRITTEN);
      expect(productOf(db, 'onetime_trenching', 'talstar_p')).toEqual({ ...TRENCH_REWRITTEN, warnings: [officeNote] });
      expect(warn).not.toHaveBeenCalled();
      const after = snapshot(db);
      await migration.up(knex);
      expect(snapshot(db)).toBe(after);
      expect(warn).not.toHaveBeenCalled();
      await migration.down(knex);
      expect(db.pricing_config.map((r) => JSON.parse(r.data))).toEqual(JSON.parse(original).map((r) => JSON.parse(r.data)));
    });

    // An override of the warnings alone, still the Talak wording, names the Talak bottle too: db-bridge lays it over the code's
    // Crosscheck Plus product, so staff would read the Talak label's instruction under Crosscheck Plus's name (pre-push audit at the
    // twelfth push). Its Talak entries move in place and an office entry stays; one with its own label stays the admin's.
    test('an override of the Talak warnings alone moves to the new bottle; an office entry stays', async () => {
      const officeNote = 'Office: call the builder before the slab pour.';
      const preslab = { warnings: [...PROD_PRESLAB_PRODUCT.warnings, officeNote] };
      const trench = { warnings: [TALAK_WARNING], label: 'Mine' };
      const db = world({ preslab: preslabRow(preslab, PROD_PRESLAB_PRODUCT), trench: trenchRow(trench, PROD_TRENCH_PRODUCT), catalog: [], vendors: [] });
      const original = JSON.stringify(db.pricing_config);
      const knex = fakeKnex(db);
      await migration.up(knex);
      expect(productOf(db, 'onetime_preslab', 'talstar_p')).toEqual({ ...CROSSCHECK_PRESLAB, warnings: [...CROSSCHECK_PRESLAB.warnings, officeNote] });
      expect(productOf(db, 'onetime_preslab', 'bifen_it')).toEqual(PRESLAB_REWRITTEN);
      expect(productOf(db, 'onetime_trenching', 'talstar_p')).toEqual(trench);
      expect(warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/onetime_trenching\.products\.talstar_p was edited since the Talak swap/);
      const after = snapshot(db);
      await migration.up(knex);
      expect(snapshot(db)).toBe(after);
      await migration.down(knex);
      expect(db.pricing_config.map((r) => JSON.parse(r.data))).toEqual(JSON.parse(original).map((r) => JSON.parse(r.data)));
    });

    // A name is read before any figure: an override with no label of its own that names a Crosscheck bottle (its catalog name, the
    // camelCase alias first, as db-bridge reads it) is an admin's own Crosscheck product, so its price stays and only a Talak warning
    // on it moves (pre-push audit at the fourteenth push: an override naming LESCO Crosscheck Plus at $45 was repriced to $30.90).
    test('an override that names Crosscheck keeps its own price; only a Talak warning on it moves', async () => {
      const officeNote = 'Office: call the builder before the slab pour.';
      const preslab = { catalog_product_name: 'LESCO Crosscheck Plus', container_cost: 45 };
      const bifen = { catalogProductName: 'Crosscheck Plus', containerCost: 45, warnings: [TALAK_WARNING, officeNote] };
      const trench = { catalog_product_name: 'LESCO Crosscheck Plus', container_cost: 45 };
      // db-bridge reads the camelCase name first: a Talak name there is the Talak bottle, whatever the snake_case key names.
      const talakFirst = { catalogProductName: 'Atticus Talak 7.9 F', catalog_product_name: 'LESCO Crosscheck Plus', container_cost: 45 };
      const db = world({ preslab: preslabRow(preslab, bifen), trench: trenchRow(trench, talakFirst), catalog: [], vendors: [] });
      const original = JSON.stringify(db.pricing_config);
      const knex = fakeKnex(db);
      await migration.up(knex);
      expect(productOf(db, 'onetime_preslab', 'talstar_p')).toEqual(preslab);
      expect(productOf(db, 'onetime_preslab', 'bifen_it')).toEqual({ ...bifen, warnings: [CROSSCHECK_PRESLAB.warnings[0], officeNote] });
      expect(productOf(db, 'onetime_trenching', 'talstar_p')).toEqual(trench);
      expect(productOf(db, 'onetime_trenching', 'bifen_it')).toEqual({ catalog_product_name: 'LESCO Crosscheck Plus', ...CROSSCHECK_TRENCH });
      expect(warn.mock.calls.map((c) => c[0]).join('\n')).not.toMatch(/was edited since the Talak swap/);
      const after = snapshot(db);
      await migration.up(knex);
      expect(snapshot(db)).toBe(after);
      await migration.down(knex);
      expect(db.pricing_config.map((r) => JSON.parse(r.data))).toEqual(JSON.parse(original).map((r) => JSON.parse(r.data)));
    });

    // Only another bottle's figures or name move a product with no label of its own: one with none, or with Crosscheck Plus's own,
    // already quotes Crosscheck Plus, and is left as it is, with no warning about another bottle.
    test('a product with no label of its own and no other bottle\'s figures is left alone', async () => {
      const bare = { margin_divisor: 0.6 };
      const own = { container_cost: 30.9, container_oz: 128, margin_divisor: 0.6 };
      const db = world({ preslab: preslabRow(bare, own), trench: trenchRow(PROD_TRENCH_PRODUCT, PROD_TRENCH_PRODUCT), catalog: [], vendors: [] });
      await migration.up(fakeKnex(db));
      expect(productOf(db, 'onetime_preslab', 'talstar_p')).toEqual(bare);
      expect(productOf(db, 'onetime_preslab', 'bifen_it')).toEqual(own);
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
      // Pre-push audit at the fifth push: a seed with an edited margin (0.6) quoted $876, the Talak cost under Crosscheck Plus's name
      // and label check. After up() it quotes Crosscheck Plus's cost at the admin's margin, $655.
      const edited = world({ preslab: preslabRow({ ...SEED_PRESLAB, margin_divisor: 0.6 }, SEED_PRESLAB), catalog: [], vendors: [] });
      expect(await price(rowOf(edited, 'onetime_preslab'))).toEqual([876, 993]);
      await migration.up(fakeKnex(edited));
      expect(await price(rowOf(edited, 'onetime_preslab'))).toEqual([655, 743]);
    });

    // db-bridge over this world's rows with the catalog link on: the real queries' filters (active, priced catalog rows by
    // name; an eligible backing vendor row) and the [0.5x, 2x] band all run.
    const syncLinked = async (db) => {
      let bridge;
      let pricing;
      let consts;
      jest.isolateModules(() => {
        bridge = require('../services/pricing-engine/db-bridge');
        pricing = require('../services/pricing-engine/service-pricing');
        consts = require('../services/pricing-engine/constants');
      });
      const bridgeDb = (table) => {
        const picked = {};
        const q = {
          whereIn(column, values) { picked[column] = values; return q; },
          where() { return q; },
          whereRaw() { return q; },
          async select() {
            if (table === 'pricing_config') return db.pricing_config.map((r) => ({ config_key: r.config_key, data: JSON.parse(r.data) }));
            if (table === 'products_catalog') {
              return db.products_catalog.filter((r) => picked.name.includes(r.name) && r.active === true && r.needs_pricing === false);
            }
            return db.vendor_pricing.filter((v) => picked['vendor_pricing.id'].includes(v.id) && Number(v.price_amount ?? v.price) > 0
              && v.is_active === true && ['approved', 'auto_approved'].includes(v.approval_status)
              && (v.expires_at == null || new Date(v.expires_at) > new Date())).map((v) => ({ id: v.id }));
          },
        };
        return q;
      };
      bridgeDb.schema = { hasTable: async (table) => ['pricing_config', 'products_catalog', 'vendor_pricing'].includes(table) };
      jest.spyOn(console, 'log').mockImplementation(() => {});
      expect(await bridge.syncConstantsFromDB(bridgeDb)).toBe(true);
      return { pricing, consts };
    };
    const linkedQuotes = async (db) => {
      const { pricing } = await syncLinked(db);
      return OPTIONS.map((productKey) => pricing.pricePreSlabTermiticide({ slabSqFt: 6832 }, { productKey }).price);
    };

    test('through the bridge with the catalog link: Step P makes a 6,832 sq ft slab $743', async () => {
      const db = world();
      expect(await linkedQuotes(db)).toEqual([993, 993]);
      await migration.up(fakeKnex(db));
      expect(await linkedQuotes(db)).toEqual([743, 743]);
    });

    // The hold's world: Step P must leave the SiteOne row (shipping: its landed cost would need it), so its quote still offers 58.42;
    // a second vendor quotes $70.00; the Talak row as production.
    const HELD_SITEONE = vendorRow({ shipping_cost: '5.00' });
    const heldWorld = (extra = {}) => world({
      catalog: [catalogRow(), talakCatalogRow()], vendors: [HELD_SITEONE, SECOND_VENDOR, talakVendorRow()], ...extra,
    });

    test('through the bridge with the catalog link: held, the stale quote expires and stays out of slab quotes ($743, never $1,023)', async () => {
      const db = heldWorld();
      expect(await linkedQuotes(db)).toEqual([993, 993]);
      await migration.up(fakeKnex(db));
      expectExpired(db.vendor_pricing[0]);
      // The $70.00 quote is the only current one: it wins, and the links refuse it (2.27x, outside their band).
      expect(db.products_catalog[0]).toMatchObject({ best_price: 70, best_vendor_pricing_id: 'v2', needs_pricing: false });
      expect(await linkedQuotes(db)).toEqual([743, 743]);
    });

    // Pre-push audit 24: an admin's later price entry for another vendor runs the recalculation. Above the stale $58.42, that entry
    // must not hand the win back to the held quote.
    test('through the bridge with the catalog link: held, a higher competing quote entered later never brings the stale $58.42 back', async () => {
      const db = heldWorld();
      const knex = fakeKnex(db);
      await migration.up(knex);
      await knex('vendor_pricing').where({ id: 'v2' }).update({
        price: '64.00', price_amount: '64.0000', landed_cost: '64.00', price_per_oz: '0.5', normalized_unit_price: '0.5', landed_unit_price: '0.5',
      });
      await realRecalc('p1', knex);
      expectExpired(db.vendor_pricing[0]);
      expect(db.products_catalog[0]).toMatchObject({ best_price: 64, best_vendor_pricing_id: 'v2', needs_pricing: false });
      expect(await linkedQuotes(db)).toEqual([743, 743]); // $64.00 is 2.07x: the config's $30.90 prices the slab
      // The expiry is what holds it: open again, the same recalculation picks $58.42 and the slab is $1,023.
      db.vendor_pricing[0] = { ...db.vendor_pricing[0], expires_at: null };
      await realRecalc('p1', knex);
      expect(db.products_catalog[0]).toMatchObject({ best_price: 58.42, best_vendor_pricing_id: 'v1' });
      expect(await linkedQuotes(db)).toEqual([1023, 1023]);
    });

    // Pre-push audit 24: on a 96 oz catalog row the recalculation writes the stale gallon as $43.82, the same $0.4564 per oz.
    test('through the bridge with the catalog link: held on a 96 oz catalog row, the stale quote expires and stays out of slab quotes', async () => {
      const db = world({ catalog: [catalogRow({ unit_size_oz: '96.00', best_price: '43.82' }), talakCatalogRow()], vendors: [HELD_SITEONE, talakVendorRow()] });
      const knex = fakeKnex(db);
      expect(await linkedQuotes(db)).toEqual([993, 993]);
      await migration.up(knex);
      expectExpired(db.vendor_pricing[0]);
      expectUnpriced(db.products_catalog[0]);
      expect(await linkedQuotes(db)).toEqual([743, 743]);
      // Open again, the recalculation writes $43.82 on the 96 oz row and the link takes it.
      db.vendor_pricing[0] = { ...db.vendor_pricing[0], expires_at: null };
      await realRecalc('p1', knex);
      expect(db.products_catalog[0]).toMatchObject({ best_price: 43.82, needs_pricing: false });
      expect((await linkedQuotes(db))[0]).toBeGreaterThan(993);
    });

    // Every pre-slab shape db-bridge reads (`products || product_costs`, then the top-level key, over the code's Crosscheck link):
    // held, none of them can take the stale price, after any later recalculation too. Open again, each links to it and quotes $1,023.
    test.each([
      ['the admin seed (no link of its own: the code default)', (db) => { db.pricing_config[0].data = JSON.stringify(preslabRow(SEED_PRESLAB, SEED_PRESLAB)); }, [743, 743]],
      ['a legacy product_costs map (moved like the products map)', (db) => { db.pricing_config[0].data = JSON.stringify({ link_container_costs_to_catalog: true, product_costs: { talstar_p: SEED_PRESLAB, bifen_it: SEED_PRESLAB } }); }, [743, 743]],
      ['top-level product keys (moved like the products map)', (db) => { db.pricing_config[0].data = JSON.stringify({ link_container_costs_to_catalog: true, talstar_p: SEED_PRESLAB, bifen_it: SEED_PRESLAB }); }, [743, 743]],
      ['a row with no products at all', (db) => { db.pricing_config[0].data = JSON.stringify({ link_container_costs_to_catalog: true }); }, [743, 743]],
      ['no pre-slab row', (db) => { db.pricing_config.shift(); }, [743, 743]],
    ])('through the bridge with the catalog link: held, %s never quotes the stale price', async (_name, shape, quotes) => {
      const db = world({ vendors: [HELD_SITEONE] });
      shape(db);
      const knex = fakeKnex(db);
      await migration.up(knex);
      expectExpired(db.vendor_pricing[0]);
      expectUnpriced(db.products_catalog[0]);
      expect(await linkedQuotes(db)).toEqual(quotes);
      await realRecalc('p1', knex);
      expect(await linkedQuotes(db)).toEqual(quotes);
      // The expiry is what keeps it out: open again, the recalculation picks it, and every shape links to the stale price.
      db.vendor_pricing[0] = { ...db.vendor_pricing[0], expires_at: null };
      await realRecalc('p1', knex);
      expect(await linkedQuotes(db)).toEqual([1023, 1023]);
    });

    test('through the bridge with the catalog link: under another vendor\'s winner, the recalculation picks the corrected row ($743)', async () => {
      const db = world(OTHER_WINNER_WORLD);
      expect((await linkedQuotes(db))[0]).toBeGreaterThan(743); // the old winner's $45.00
      await migration.up(fakeKnex(db));
      expect(db.products_catalog[0]).toMatchObject({ best_price: 30.9, best_vendor_pricing_id: 'v1', needs_pricing: false, best_price_status: 'current' });
      expect(await linkedQuotes(db)).toEqual([743, 743]);
    });

    test('through the bridge: held, the stale price stays out of the mosquito bifenthrin cost too (code 30.90 / 128)', async () => {
      const db = heldWorld();
      expect((await syncLinked(db)).consts.MOSQUITO.productCosts.bifenthrinOz).toBeCloseTo(58.42 / 128, 4);
      await migration.up(fakeKnex(db));
      expect((await syncLinked(db)).consts.MOSQUITO.productCosts.bifenthrinOz).toBeCloseTo(30.9 / 128, 4);
      // Step P's own fix reaches the mosquito cost through the catalog: 30.90 / 128 from the row itself.
      const fixed = world();
      await migration.up(fakeKnex(fixed));
      expect((await syncLinked(fixed)).consts.MOSQUITO.productCosts.bifenthrinOz).toBeCloseTo(30.9 / 128, 4);
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

    test('a vendor column that does not exist is skipped, never an error', async () => {
      const db = world();
      db.__missingColumns = ['vendor_pricing.landed_unit_price'];
      await migration.up(fakeKnex(db));
      expect(db.vendor_pricing[0].price).toBe(30.9);
      expect(db.vendor_pricing[0].landed_unit_price).toBe('0.4564');
      expect(db.products_catalog[0].best_price).toBe(30.9);
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
      expectRecalculated(knex, 2); // the catalog follows the restored row
      expect(db.products_catalog[0]).toMatchObject({ best_price: 58.42, best_price_amount_cached: 58.42, best_vendor_pricing_id: 'v1' });
      expect(db.price_history.map((h) => h.id)).toEqual(['h0']);
      expect(db.pricing_config_audit.map((r) => r.id)).toEqual([99]);
      expect(db.pricing_changelog).toEqual([]);
    });

    test('an admin price edit after up() is kept, and nothing recalculates; the products still restore', async () => {
      const db = world({ vendors: [vendorRow(), SECOND_VENDOR] });
      const knex = fakeKnex(db);
      await migration.up(knex);
      db.vendor_pricing[0] = { ...db.vendor_pricing[0], price: 29.99, price_amount: 29.99 };
      await migration.down(knex);
      expect(db.vendor_pricing[0].price).toBe(29.99);
      expect(db.price_history).toHaveLength(1);
      expect(db.products_catalog[0].best_price).toBe(30.9);
      expectRecalculated(knex); // up() only
      expect(warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/down: the LESCO Crosscheck Plus price changed since this migration - leaving it alone/);
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
      const edited = vendorRow({
        price: '45.00', price_amount: '45.0000', landed_cost: '45.00', price_per_oz: '0.3516', normalized_unit_price: '0.3516', landed_unit_price: '0.3516',
      });
      const db = world({ vendors: [edited], catalog: [catalogRow({ best_price: '45.00', best_price_amount_cached: '45.0000' })] });
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

    // down() restores the vendor row and its history and runs the recalculation again: the catalog follows the rows.
    test('under another vendor\'s winner, down() restores the SiteOne row and recalculates: the old winner returns', async () => {
      const db = world(OTHER_WINNER_WORLD);
      const original = JSON.stringify(db.pricing_config);
      const vendorsBefore = JSON.stringify(db.vendor_pricing);
      const knex = fakeKnex(db);
      await migration.up(knex);
      expect(db.products_catalog[0]).toMatchObject({ best_price: 30.9, best_vendor_pricing_id: 'v1' });
      await migration.down(knex);
      expectRecalculated(knex, 2);
      expect(db.pricing_config.map((r) => JSON.parse(r.data))).toEqual(JSON.parse(original).map((r) => JSON.parse(r.data)));
      expect(JSON.stringify(db.vendor_pricing)).toBe(vendorsBefore);
      expect(db.products_catalog[0]).toMatchObject({ best_price: 45, best_vendor_pricing_id: 'other', needs_pricing: false, best_price_status: 'current' });
      expect(db.price_history).toEqual([]);
      expect(db.pricing_config_audit).toEqual([]);
      expect(db.pricing_changelog).toEqual([]);
    });

    // up()'s recalculation clears a mark the row held before; down() restores the vendor row and recalculates, and the mark comes
    // back only when the winner up() saw returns (pre-push audit 12).
    test('a catalog row marked stale before up() is marked again by down() when its old winner returns', async () => {
      const stale = { needs_pricing: true, best_price_status: 'stale' };
      const db = world({ catalog: [catalogRow(stale)] });
      const knex = fakeKnex(db);
      await migration.up(knex);
      expect(db.products_catalog[0]).toMatchObject({ best_price: 30.9, needs_pricing: false, best_price_status: 'current' });
      await migration.down(knex);
      expect(db.vendor_pricing[0]).toMatchObject({ price: '58.42', price_amount: '58.4200' });
      expect(db.products_catalog[0]).toMatchObject({ best_price: 58.42, best_vendor_pricing_id: 'v1', ...stale });
      // A cheaper row entered since wins the recalculation: that winner is current, and the old mark stays off.
      const moved = world({ catalog: [catalogRow(stale)] });
      const movedKnex = fakeKnex(moved);
      await migration.up(movedKnex);
      moved.vendor_pricing.push(vendorRow({ id: 'v3', vendor_id: 'ven3', vendor_sku: 'AMZ1', price: '25.00', price_amount: '25.0000', is_best_price: false }));
      await migration.down(movedKnex);
      expect(moved.products_catalog[0]).toMatchObject({ best_price: 25, best_vendor_pricing_id: 'v3', needs_pricing: false, best_price_status: 'current' });
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

  // The admin Pricing Logic panel's Pest Service Cost Breakdown. Production's shape with synthetic figures (its Talak line is the
  // seed's), and the admin seed's own shape (routes/admin-pricing-config.js ensureTable before this change).
  const PEST_COSTS = {
    labor: { drive_minutes: 20, rate_per_hour: 35, total_minutes: 53, on_site_minutes: 33, cost_per_service: 30 },
    notes: ['A note the office wrote.'],
    chemicals: {
      talak: { bottle_oz: 128, bottle_price: 41.57, oz_per_service: 4, cost_per_service: 1.3 },
      taurus_sc: { bottle_oz: 78, bottle_price: 95, oz_per_service: 4, cost_per_service: 4.87 },
    },
    total_cost_per_service: 36.17,
    chemical_cost_per_service: 6.17,
  };
  const SEED_PEST_COSTS = {
    chemicals: {
      taurus_sc: { bottle_price: 95, bottle_oz: 78, oz_per_service: 4, cost_per_service: 4.87 },
      talak: { bottle_price: 41.57, bottle_oz: 128, oz_per_service: 4, cost_per_service: 1.3 },
      surfactant: { cost: 0.5 },
    },
    labor: { spray_minutes: 10, sweep_minutes: 10, total_on_site_minutes: 20, rate_per_hour: 35, on_site_labor_cost: 11.67, drive_minutes: 20, drive_labor_cost: 11.67 },
    direct_service_cost: 17.84,
    fully_allocated_cost: 30.01,
  };

  describe('pest_service_costs (display only)', () => {
    test('the Talak line becomes Crosscheck Plus in place at 0.97, each total moves by 0.33, and down() restores the row', async () => {
      const db = world({ catalog: [], vendors: [], pest: PEST_COSTS });
      const knex = fakeKnex(db);
      await migration.up(knex);
      const moved = rowOf(db, 'pest_service_costs');
      expect(Object.keys(moved.chemicals)).toEqual(['crosscheck_plus', 'taurus_sc']);
      expect(moved.chemicals.crosscheck_plus).toEqual(migration.CROSSCHECK_PEST_LINE);
      expect(moved).toMatchObject({ chemical_cost_per_service: 5.84, total_cost_per_service: 35.84, labor: PEST_COSTS.labor, notes: PEST_COSTS.notes });
      expect(db.pricing_config_audit.map((r) => r.config_key)).toContain('pest_service_costs');
      expect(migration.TALAK_PEST_LINE).toEqual(PEST_COSTS.chemicals.talak);
      await migration.down(knex);
      expect(rowOf(db, 'pest_service_costs')).toEqual(PEST_COSTS);
    });

    test('the admin seed\'s shape moves the same way (direct and fully allocated totals)', async () => {
      const db = world({ catalog: [], vendors: [], pest: SEED_PEST_COSTS });
      await migration.up(fakeKnex(db));
      const moved = rowOf(db, 'pest_service_costs');
      expect(Object.keys(moved.chemicals)).toEqual(['taurus_sc', 'crosscheck_plus', 'surfactant']);
      expect(moved).toMatchObject({ direct_service_cost: 17.51, fully_allocated_cost: 29.68 });
    });

    test('a Talak line an admin edited, or a row already moved, is left alone', async () => {
      const edited = { ...PEST_COSTS, chemicals: { ...PEST_COSTS.chemicals, talak: { ...PEST_COSTS.chemicals.talak, bottle_price: 45 } } };
      const db = world({ catalog: [], vendors: [], pest: edited });
      await migration.up(fakeKnex(db));
      expect(rowOf(db, 'pest_service_costs')).toEqual(edited);
      expect(warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/pest_service_costs\.chemicals\.talak was edited/);
      const done = { ...PEST_COSTS, chemicals: { crosscheck_plus: migration.CROSSCHECK_PEST_LINE } };
      const db2 = world({ catalog: [], vendors: [], pest: done });
      await migration.up(fakeKnex(db2));
      expect(rowOf(db2, 'pest_service_costs')).toEqual(done);
      expect(db2.pricing_config_audit.some((r) => r.config_key === 'pest_service_costs')).toBe(false);
    });

    test('an admin edit of the breakdown after up() is kept by down()', async () => {
      const db = world({ catalog: [], vendors: [], pest: PEST_COSTS });
      const knex = fakeKnex(db);
      await migration.up(knex);
      const edited = { ...rowOf(db, 'pest_service_costs'), total_cost_per_service: 99 };
      db.pricing_config = db.pricing_config.map((r) => (r.config_key === 'pest_service_costs' ? { ...r, data: JSON.stringify(edited) } : r));
      await migration.down(knex);
      expect(rowOf(db, 'pest_service_costs')).toEqual(edited);
      expect(warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/pest_service_costs changed since this migration/);
    });

    test('the Crosscheck Plus line is 4 fl oz of the $30.90 gallon, the figure the engine\'s pest cost uses', () => {
      const line = migration.CROSSCHECK_PEST_LINE;
      expect(line.bottle_price).toBe(migration.NEW_PRICE);
      expect(Math.round((line.bottle_price / line.bottle_oz) * line.oz_per_service * 100) / 100).toBe(line.cost_per_service);
    });
  });

  test('the bundled pricing sheet lists the SiteOne Crosscheck Plus gallon at $30.90, so the admin pricing import keeps Step P\'s price', () => {
    const fs = require('fs');
    const path = require('path');
    const { parse } = require('csv-parse/sync');
    const csv = fs.readFileSync(path.join(__dirname, '..', 'data', 'pricing.csv'), 'utf8');
    const rows = parse(csv, { columns: true, skip_empty_lines: true, relax_column_count: true });
    const lines = rows.filter((r) => String(r.Product || '').trim().toLowerCase() === 'lesco crosscheck plus'
      && String(r.Vendor || '').trim().toLowerCase() === 'siteone');
    expect(lines).toHaveLength(1);
    expect(Number(String(lines[0].Price).replace(/[$,]/g, ''))).toBe(migration.NEW_PRICE);
    expect(String(lines[0].Size).trim()).toBe('1 gal');
  });
});
