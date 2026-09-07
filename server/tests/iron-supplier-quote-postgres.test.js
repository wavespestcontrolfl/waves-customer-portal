// Runs in the existing DB-gated CI phase and against a private dev QA database.
// Every fixture, migration ledger and audit event rolls back after its test.
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  db.raw = (...args) => mockPg.raw(...args);
  db.transaction = (...args) => mockPg.transaction(...args);
  Object.defineProperty(db, 'fn', { get: () => mockPg.fn });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { randomUUID } = require('node:crypto');
const path = require('node:path');
const SKIP = !process.env.DATABASE_URL;
const quoteMigration = require('../models/migrations/20260907000019_approved_iron_supplier_cost');
const linkMigration = require('../models/migrations/20260907000022_iron_supplier_quote_link');
const dimensionsMigration = require('../models/migrations/20260907000021_lawn_cost_inventory_dimensions');
const canonicalMigration = require('../models/migrations/20260907000100_canonical_lawn_cost_dimensions');
const { costLineFromUsage } = require('../services/product-costing');
const TABLES = ['products_catalog', 'vendors', 'vendor_pricing', 'price_history', 'price_snapshots', 'product_inventory_movements', 'audit_log'];
const SOURCE = 'migration.20260907000019.iron_supplier_quote';
const LEGACY = 'LESCO 12-0-0 Chelated Iron Plus';
const KEEPER = 'LESCO Chelated Iron Plus';
const LISTING_URL = 'https://www.siteone.com/en/9999903964-lesco-chelated-iron-plus-12-0-0-6fe-2mn-all-purpose-liquid-fertilizer/p/571634';
let database;
let mockPg;
let productId;
let vendorId;
let schema;
jest.setTimeout(60000);

(SKIP ? describe.skip : describe)('owner-supplied iron price and migration ordering (PostgreSQL)', () => {
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    if (!/^\/(waves_qa_[a-f0-9]{32}|waves_test)$/.test(url.pathname)) throw new Error('Use a dedicated Waves QA database');
    database = require('knex')({ client: 'pg', connection: url.href, pool: { min: 0, max: 1 } });
  });
  beforeEach(async () => {
    mockPg = await database.transaction();
    schema = `iron_quote_${randomUUID().replaceAll('-', '')}`;
    await mockPg.raw('CREATE SCHEMA ??', [schema]);
    await mockPg.raw('SET LOCAL search_path TO ??, public', [schema]);
    for (const table of TABLES) {
      await mockPg.raw('CREATE TABLE ?? (LIKE ?? INCLUDING ALL)', [`${schema}.${table}`, `public.${table}`]);
    }
    [vendorId] = (await mockPg('vendors').insert({ name: 'SiteOne' }).returning('id')).map(row => row.id);
    [productId] = (await mockPg('products_catalog').insert({ name: LEGACY, active: true,
      category: 'fertilizer', container_size: '2.5 gal', unit_size_oz: 320,
      best_price: 32, cost_per_unit: 0.25, cost_unit: 'oz', default_rate_per_1000: 3,
      rate_unit: 'fl_oz', inventory_unit: null, inventory_on_hand: null, low_stock_threshold: null,
    }).returning('id')).map(row => row.id);
  });
  afterEach(async () => { await mockPg?.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  const product = () => mockPg('products_catalog').where({ id: productId }).first();
  const apply = () => mockPg.transaction(async (trx) => {
    await quoteMigration.up(trx);
    await linkMigration.up(trx);
  });
  const counts = async () => {
    const result = {};
    for (const table of TABLES) result[table] = Number((await mockPg(table).count('* as count').first()).count);
    return result;
  };
  async function existingQuote(fields = {}) {
    const [row] = await mockPg('vendor_pricing').insert({ product_id: productId, vendor_id: vendorId,
      price: 32, price_amount: 32, quantity: '2.5 gal', price_type: 'manual_seed',
      source_type: 'manual_seed', approval_status: 'approved', is_active: true,
      last_checked_at: '2026-09-01T12:00:00Z', ...fields }).returning('*');
    return row;
  }
  async function otherProducts() {
    await mockPg('products_catalog').insert([
      ['Prodiamine 65 WDG', '5 lb', 80, 80],
      ['Armada 50 WDG', '2 lb', 32, 64],
      ['SpeedZone Southern', '2.5 gal', 320, 160],
      ['LESCO K-Flow 0-0-25', '2.5 gal', 320, 64],
      ['Primo Maxx', '1 gal', 128, 128],
    ].map(([name, container_size, unit_size_oz, best_price]) => ({
      name, container_size, unit_size_oz, best_price, active: true,
      cost_per_unit: best_price / unit_size_oz, cost_unit: 'oz',
      inventory_unit: null, inventory_on_hand: null, low_stock_threshold: null,
    })));
  }
  const migrationNames = [
    '20260907000019_approved_iron_supplier_cost.js',
    '20260907000021_lawn_cost_inventory_dimensions.js',
    '20260907000022_iron_supplier_quote_link.js',
    '20260907000100_canonical_lawn_cost_dimensions.js',
  ];
  const migrationSource = names => ({
    getMigrations: async () => names,
    getMigrationName: name => name,
    getMigration: name => require(path.join('../models/migrations', name)),
  });
  const migrate = names => mockPg.migrate.latest({ migrationSource: migrationSource(names),
    tableName: 'iron_test_migrations', schemaName: schema });

  test.each([true, null])('repairs stale cost for active=%s and records the quoted price once', async (active) => {
    await mockPg('products_catalog').where({ id: productId }).update({ active });
    const before = await product();
    await existingQuote({ normalized_unit_price: 9, price_per_oz: 9, landed_unit_price: 99, unit_normalized: 'oz',
      vendor_product_url: LISTING_URL });
    await apply();
    const after = await product();
    expect(after).toMatchObject({ best_price: '36.15', cost_per_unit: '0.1130', cost_unit: 'fl_oz',
      inventory_unit: 'fl_oz', unit_size_oz: '320.00', needs_pricing: false, best_price_status: 'current',
      default_rate_per_1000: before.default_rate_per_1000, rate_unit: before.rate_unit,
      inventory_on_hand: before.inventory_on_hand, low_stock_threshold: before.low_stock_threshold });
    const vendor = await mockPg('vendor_pricing').where({ product_id: productId }).first();
    expect(vendor).toMatchObject({ price: '36.15', quantity: '2.5 gal', vendor_sku: '084043', vendor_product_url: LISTING_URL,
      previous_price: '32.00', unit_normalized: 'fl_oz', is_best_price: true, landed_unit_price: null });
    expect(after.best_vendor_pricing_id).toBe(vendor.id);
    expect(await mockPg('price_snapshots').where({ id: vendor.latest_snapshot_id }).first()).toMatchObject({
      source_url: LISTING_URL, metadata: { familyCode: '9999903964', sku: '084043' },
    });
    expect((await mockPg('audit_log').where({ action: SOURCE }).first()).metadata).toMatchObject({
      packagePrice: 36.15, priorCostPerUnit: '0.2500', priorCostUnit: 'oz', costPerUnit: 0.113,
    });
    expect(costLineFromUsage({ ...after, usage_amount: 3, usage_unit: 'fl_oz' }).cost).toBeCloseTo(0.339);
    const firstCounts = await counts();
    await apply();
    await quoteMigration.down(mockPg);
    await linkMigration.down(mockPg);
    expect(await counts()).toEqual(firstCounts);
    expect(await product()).toEqual(after);
  });

  test.each([null, 'fl_oz', 'gal'])('reconciles missing or volume-denominated cost: %s', async (unit) => {
    await mockPg('products_catalog').where({ id: productId }).update({ cost_unit: unit, cost_per_unit: unit ? 9 : null });
    await apply();
    expect(await product()).toMatchObject({ cost_unit: 'fl_oz', cost_per_unit: '0.1130', best_price: '36.15' });
  });

  test('preserves an explicit gallon stock basis and application settings', async () => {
    await mockPg('products_catalog').where({ id: productId }).update({ inventory_unit: 'gal', inventory_on_hand: 2, low_stock_threshold: 0.5 });
    await apply();
    expect(await product()).toMatchObject({ inventory_unit: 'gal', inventory_on_hand: '2.0000', low_stock_threshold: '0.5000',
      default_rate_per_1000: '3.0000', rate_unit: 'fl_oz', cost_per_unit: '0.1130' });
    expect(await mockPg('product_inventory_movements')).toHaveLength(0);
  });

  test('updates the active keeper while preserving a retired predecessor verbatim', async () => {
    await mockPg('products_catalog').where({ id: productId }).update({ active: false, inventory_on_hand: 17 });
    const retired = await product();
    const [keeper] = await mockPg('products_catalog').insert({ name: KEEPER, active: true,
      container_size: '2.5 gal', unit_size_oz: 320, cost_per_unit: null }).returning('*');
    await apply();
    expect(await product()).toEqual(retired);
    expect(await mockPg('products_catalog').where({ id: keeper.id }).first()).toMatchObject({ best_price: '36.15', cost_per_unit: '0.1130' });
  });

  test('preserves a newer manual supplier observation and catalog edits', async () => {
    await existingQuote({ price_type: 'manual', price: 39, last_checked_at: '2026-09-07T10:00:00Z' });
    const before = await product();
    const quotes = await mockPg('vendor_pricing');
    await apply();
    expect(await product()).toEqual(before);
    expect(await mockPg('vendor_pricing')).toEqual(quotes);
    expect(await mockPg('audit_log')).toHaveLength(0);
  });

  test('honors a cheaper eligible vendor and reconciles cost to the actual winner', async () => {
    const [vendor] = await mockPg('vendors').insert({ name: 'QA Supplier' }).returning('id');
    const [quote] = await mockPg('vendor_pricing').insert({ product_id: productId, vendor_id: vendor.id,
      price: 32, price_amount: 32, quantity: '2.5 gal', approval_status: 'approved', is_active: true,
      price_per_oz: 0.1, unit_normalized: 'fl_oz' }).returning('id');
    await apply();
    expect(await product()).toMatchObject({ best_price: '32.00', cost_per_unit: '0.1000', best_vendor_pricing_id: quote.id });
    expect(await mockPg('vendor_pricing').where({ vendor_id: vendorId }).first()).toMatchObject({ price: '36.15', is_best_price: false });
  });

  test.each([
    [{ container_size: '55 gal', unit_size_oz: 7040 }, 'Iron package needs review'],
    [{ unit_size_oz: 128 }, 'Iron package size conflicts'],
    [{ inventory_unit: 'lb' }, 'Iron inventory dimension conflicts'],
    [{ inventory_unit: 'bottles' }, 'Iron inventory unit unsupported'],
    [{ inventory_on_hand: 10 }, 'Iron stock basis needs review'],
    [{ inventory_unit: 'oz', low_stock_threshold: 1 }, 'Iron stock basis needs review'],
    [{ cost_unit: 'lb' }, 'Iron cost dimension conflicts'],
  ])('refuses contradictory evidence without partial writes: %j', async (fields, message) => {
    await mockPg('products_catalog').where({ id: productId }).update(fields);
    const before = await product();
    const beforeCounts = await counts();
    await expect(apply()).rejects.toThrow(message);
    expect(await product()).toEqual(before);
    expect(await counts()).toEqual(beforeCounts);
  });

  test('refuses ambiguous active identities before updating either product', async () => {
    await mockPg('products_catalog').insert({ name: KEEPER, active: true, container_size: '2.5 gal' });
    const before = await product();
    await expect(apply()).rejects.toThrow('Expected one active Chelated Iron Plus');
    expect(await product()).toEqual(before);
    expect(await mockPg('vendor_pricing')).toHaveLength(0);
  });

  test('an audit insert failure rolls back price, cost and history together', async () => {
    await mockPg.raw("CREATE FUNCTION iron_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture audit failure'; END; $$");
    await mockPg.raw('CREATE TRIGGER iron_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION iron_audit_failure()');
    const before = await product();
    const beforeCounts = await counts();
    await expect(apply()).rejects.toThrow('fixture audit failure');
    expect(await product()).toEqual(before);
    expect(await counts()).toEqual(beforeCounts);
  });

  test('reproduces the original stop, then completes both dimension migrations', async () => {
    await otherProducts();
    await expect(mockPg.transaction(trx => dimensionsMigration.up(trx))).rejects.toThrow(`Cost basis needs review: ${LEGACY}`);
    await apply();
    await dimensionsMigration.up(mockPg);
    await canonicalMigration.up(mockPg);
    expect((await mockPg('products_catalog')).every(row => row.inventory_unit)).toBe(true);
  });

  test('the link correction preserves a subsequent manual quote and its URL', async () => {
    await quoteMigration.up(mockPg);
    await mockPg('vendor_pricing').where({ product_id: productId }).update({
      last_checked_at: '2026-09-07T10:00:00Z', vendor_product_url: 'https://www.siteone.com/owner-reviewed-link',
    });
    const before = await mockPg('vendor_pricing');
    const beforeCounts = await counts();
    await linkMigration.up(mockPg);
    expect(await mockPg('vendor_pricing')).toEqual(before);
    expect(await counts()).toEqual(beforeCounts);
  });

  test('a source-correction audit failure preserves the original quote and snapshot', async () => {
    await quoteMigration.up(mockPg);
    const before = await mockPg('vendor_pricing');
    const snapshots = await mockPg('price_snapshots');
    await mockPg.raw("CREATE FUNCTION iron_link_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture link audit failure'; END; $$");
    await mockPg.raw('CREATE TRIGGER iron_link_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION iron_link_audit_failure()');
    await expect(mockPg.transaction(trx => linkMigration.up(trx))).rejects.toThrow('fixture link audit failure');
    expect(await mockPg('vendor_pricing')).toEqual(before);
    expect(await mockPg('price_snapshots')).toEqual(snapshots);
  });

  test.each(['none', 'dimensions', 'first_quote'])('Knex runs remaining repairs with recorded history=%s', async (history) => {
    await otherProducts();
    const recorded = history === 'none' ? [] : migrationNames.filter(name => !name.includes('000022')
      && (history === 'first_quote' || !name.includes('000019')));
    if (recorded.length) {
      await mockPg('products_catalog').where({ id: productId }).update({ cost_per_unit: 0.1 });
      await migrate(recorded);
      if (history === 'dimensions') await mockPg('products_catalog').where({ id: productId }).update({ cost_per_unit: 0.25 });
    }
    const [, ran] = await migrate(migrationNames);
    expect(ran).toEqual(migrationNames.filter(name => !recorded.includes(name)));
    expect(await product()).toMatchObject({ best_price: '36.15', cost_per_unit: '0.1130', inventory_unit: 'fl_oz' });
    expect(await mockPg('vendor_pricing').where({ product_id: productId }).first()).toMatchObject({ vendor_sku: '084043', vendor_product_url: LISTING_URL });
    expect((await mockPg('products_catalog')).every(row => row.inventory_unit)).toBe(true);
    const [, repeated] = await migrate(migrationNames);
    expect(repeated).toEqual([]);
  });
});
