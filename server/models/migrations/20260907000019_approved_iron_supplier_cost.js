/**
 * Owner-supplied SiteOne quote: SKU 9999903964, $36.15 per 2.5 gal.
 * Runs before the pending 000021 dimension check; does not edit that file.
 * Reconciles the current iron cost through the existing vendor-price writer.
 */
const assert = require('node:assert/strict');
const SOURCE = 'migration.20260907000019.iron_supplier_quote';
const QUOTED_AT = new Date('2026-09-07T09:30:07.566Z');
const PRICE = 36.15;
const OUNCES = 320;
const NAMES = ['LESCO Chelated Iron Plus', 'LESCO 12-0-0 Chelated Iron Plus'];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  const { recalcBestPrice } = require('../../routes/admin-inventory');
  const { applyInventoryUnitFix } = require('../../services/inventory-unit-review');
  const { unitDefinition } = require('../../services/inventory-units');
  const { parsePackSize, convertToOz } = require('../../services/product-costing');
  const { recordAuditEvent } = require('../../services/audit-log');
  const matches = await knex('products_catalog').whereIn('name', NAMES).whereRaw('active IS NOT FALSE');
  assert.equal(matches.length, 1, 'Expected one active Chelated Iron Plus catalog identity');
  const productId = matches[0].id;
  await knex.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))', ['inventory.best_price', String(productId)]);
  const product = await knex('products_catalog').where({ id: productId }).forUpdate().first();
  assert.ok(product, 'Iron catalog identity disappeared');
  assert.ok(NAMES.includes(product.name), 'Iron catalog identity changed');
  assert.notEqual(product.active, false, 'Iron catalog identity was retired');
  if (await knex('audit_log').where({ action: SOURCE, resource_id: String(productId) }).first()) return;
  const vendors = await knex('vendors').where({ name: 'SiteOne' });
  assert.equal(vendors.length, 1, 'Expected one SiteOne vendor');
  const vendorId = vendors[0].id;
  const existingRows = await knex('vendor_pricing').where({ product_id: productId, vendor_id: vendorId }).forUpdate();
  assert.ok(existingRows.length <= 1, 'Multiple SiteOne quotes for Chelated Iron Plus');
  const existing = existingRows[0];
  if (existing?.price_type === 'manual' && existing.last_checked_at > QUOTED_AT) return;

  const pack = parsePackSize(product.container_size);
  assert.ok(pack, 'Iron package needs review: expected 2.5 gal');
  assert.equal(unitDefinition(pack.unit)?.dimension, 'volume', 'Iron package needs review: expected 2.5 gal');
  assert.equal(convertToOz(pack.amount, pack.unit), OUNCES, 'Iron package needs review: expected 2.5 gal');
  assert.ok(product.unit_size_oz == null || Number(product.unit_size_oz) === OUNCES, 'Iron package size conflicts');
  const dimension = unitDefinition(product.inventory_unit)?.dimension;
  assert.ok(!dimension || ['ambiguous', 'volume'].includes(dimension), 'Iron inventory dimension conflicts');
  assert.ok(!product.inventory_unit || dimension, 'Iron inventory unit unsupported');
  assert.ok(dimension === 'volume'
    || (product.inventory_on_hand == null && product.low_stock_threshold == null), 'Iron stock basis needs review');
  const costDimension = unitDefinition(product.cost_unit)?.dimension;
  assert.ok(!product.cost_unit || ['ambiguous', 'volume'].includes(costDimension), 'Iron cost dimension conflicts');
  // Preserve explicit volume units and all stock quantities. Only an empty
  // or ambiguous unit with no stock is filled from the quoted liquid package.
  if (dimension !== 'volume') {
    await applyInventoryUnitFix({ dbi: knex, productId, nextUnit: 'fl_oz',
      expectedCurrentUnit: product.inventory_unit, movementSource: SOURCE });
  }
  await knex('products_catalog').where({ id: productId }).update({ container_size: '2.5 gal', unit_size_oz: OUNCES });
  const fields = {
    price: PRICE, price_amount: PRICE, quantity: '2.5 gal',
    vendor_sku: '9999903964', vendor_product_url: null,
    price_type: 'manual', source_type: 'manual', approval_status: 'approved',
    is_active: true, currency: 'USD', last_checked_at: QUOTED_AT,
    price_per_oz: PRICE / OUNCES, normalized_unit_price: PRICE / OUNCES, unit_normalized: 'fl_oz',
    shipping_cost: null, shipping_estimate: null, tax_rate: null,
    landed_cost: null, landed_unit_price: null, expires_at: null,
    availability: 'In stock at SiteOne Lakewood Ranch #238; owner-supplied listing',
    availability_status: 'in_stock',
  };
  const savedRows = existing
    ? await knex('vendor_pricing').where({ id: existing.id }).update({ ...fields, previous_price: existing.price }).returning('id')
    : await knex('vendor_pricing').insert({ ...fields, product_id: productId, vendor_id: vendorId }).returning('id');
  await knex('price_history').insert({ product_id: productId, vendor_id: vendorId,
    price: PRICE, quantity: '2.5 gal', source: 'manual' });
  const [snapshot] = await knex('price_snapshots').insert({
    product_id: productId, vendor_id: vendorId, vendor_pricing_id: savedRows[0].id,
    price: PRICE, price_amount: PRICE, quantity: '2.5 gal',
    normalized_unit_price: PRICE / OUNCES, normalized_unit: 'fl_oz',
    fetched_at: QUOTED_AT, captured_at: QUOTED_AT,
    source_type: 'manual', price_type: 'manual', availability_status: 'in_stock',
    metadata: { source: SOURCE, sku: '9999903964', stickerPriceOnly: true, ownerSupplied: true },
  }).returning('id');
  await knex('vendor_pricing').where({ id: savedRows[0].id }).update({ latest_snapshot_id: snapshot.id });
  await recalcBestPrice(productId, knex);
  const winner = await knex('products_catalog').where({ id: productId }).first();
  assert.ok(winner.best_price_status === 'current' && Number(winner.best_price) > 0, 'Iron has no current package cost');
  // Measured products can retain a stale cost_per_unit override after the
  // vendor writer updates best_price. Reconcile this owner's quoted product
  // against the actual winning package price, including another vendor.
  const unitCost = Number((Number(winner.best_price) / OUNCES).toFixed(4));
  await knex('products_catalog').where({ id: productId }).update({
    cost_per_unit: unitCost, cost_unit: 'fl_oz', updated_at: knex.fn.now(),
  });
  await recordAuditEvent({ actor_type: 'system', action: SOURCE, resource_type: 'product',
    resource_id: String(productId), critical: true, trx: knex,
    metadata: { quotedAt: QUOTED_AT.toISOString(), sku: '9999903964', packagePrice: PRICE,
      package: '2.5 gal', ounces: OUNCES, priorPackagePrice: product.best_price,
      priorCostPerUnit: product.cost_per_unit, priorCostUnit: product.cost_unit,
      priorInventoryUnit: product.inventory_unit, priorVendorPrice: existing?.price ?? null,
      selectedPackagePrice: winner.best_price, selectedVendorPricingId: winner.best_vendor_pricing_id,
      costPerUnit: unitCost, costUnit: 'fl_oz',
      basis: 'Owner-supplied SiteOne sticker price; no purchase, stock receipt, tax, freight or treatment-rate change' } });
  console.info('[approved_iron_supplier_cost] SiteOne quote recorded; active iron package and unit cost reconciled');
};

// Supplier observations, audit events and subsequent admin edits are retained.
exports.down = async function down() {};
