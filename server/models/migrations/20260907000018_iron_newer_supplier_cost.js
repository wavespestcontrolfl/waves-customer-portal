/**
 * Reconcile a newer manual iron quote before the published 000019 migration
 * preserves it. No supplier observation, price history or stock is replaced.
 */
const assert = require('node:assert/strict');
const SOURCE = 'migration.20260907000018.iron_newer_supplier_cost';
const QUOTED_AT = new Date('2026-09-07T09:30:07.566Z');
const NAMES = ['LESCO Chelated Iron Plus', 'LESCO 12-0-0 Chelated Iron Plus'];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  const { recalcBestPrice } = require('../../routes/admin-inventory');
  const { applyInventoryUnitFix } = require('../../services/inventory-unit-review');
  const { unitDefinition } = require('../../services/inventory-units');
  const { parsePackSize, convertToOz } = require('../../services/product-costing');
  const { recordAuditEvent } = require('../../services/audit-log');
  const matches = await knex('products_catalog').whereIn('name', NAMES).whereRaw('active IS NOT FALSE');
  // The following published migration rejects an ambiguous/missing identity.
  if (matches.length !== 1) return;
  const productId = matches[0].id;
  await knex.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))', ['inventory.best_price', String(productId)]);
  const product = await knex('products_catalog').where({ id: productId }).forUpdate().first();
  assert.ok(product, 'Iron catalog identity disappeared');
  assert.ok(NAMES.includes(product.name), 'Iron catalog identity changed');
  assert.notEqual(product.active, false, 'Iron catalog identity was retired');
  if (await knex('audit_log').where({ action: SOURCE, resource_id: productId }).first()) return;
  const quotes = await knex('vendor_pricing').join('vendors', 'vendors.id', 'vendor_pricing.vendor_id')
    .where({ 'vendor_pricing.product_id': productId, 'vendors.name': 'SiteOne', 'vendor_pricing.price_type': 'manual' })
    .where('vendor_pricing.last_checked_at', '>', QUOTED_AT).select('vendor_pricing.*').forUpdate();
  if (!quotes.length) return;
  assert.equal(quotes.length, 1, 'Multiple newer SiteOne iron quotes');
  const pack = parsePackSize(product.container_size);
  assert.ok(pack, 'Iron package needs review: expected 2.5 gal');
  assert.equal(unitDefinition(pack.unit)?.dimension, 'volume', 'Iron package needs review: expected 2.5 gal');
  assert.equal(convertToOz(pack.amount, pack.unit), 320, 'Iron package needs review: expected 2.5 gal');
  assert.ok(product.unit_size_oz == null || Number(product.unit_size_oz) === 320, 'Iron package size conflicts');
  const dimension = unitDefinition(product.inventory_unit)?.dimension;
  assert.ok([undefined, 'ambiguous', 'volume'].includes(dimension), 'Iron inventory dimension conflicts');
  assert.ok(!product.inventory_unit || dimension, 'Iron inventory unit unsupported');
  assert.ok(dimension === 'volume'
    || (product.inventory_on_hand == null && product.low_stock_threshold == null), 'Iron stock basis needs review');
  const costDimension = unitDefinition(product.cost_unit)?.dimension;
  assert.ok(!product.cost_unit || ['ambiguous', 'volume'].includes(costDimension), 'Iron cost dimension conflicts');
  if (dimension !== 'volume') {
    await applyInventoryUnitFix({ dbi: knex, productId, nextUnit: 'fl_oz',
      expectedCurrentUnit: product.inventory_unit, movementSource: SOURCE });
  }
  await knex('products_catalog').where({ id: productId }).update({ container_size: '2.5 gal', unit_size_oz: 320 });
  await recalcBestPrice(productId, knex);
  const winner = await knex('products_catalog').where({ id: productId }).first();
  assert.ok(winner.best_price_status === 'current' && Number(winner.best_price) > 0, 'Iron has no current package cost');
  const unitCost = Number((Number(winner.best_price) / 320).toFixed(4));
  await knex('products_catalog').where({ id: productId }).update({
    cost_per_unit: unitCost, cost_unit: 'fl_oz', updated_at: knex.fn.now(),
  });
  await recordAuditEvent({ actor_type: 'system', action: SOURCE, resource_type: 'product',
    resource_id: productId, critical: true, trx: knex,
    metadata: { newerVendorPricingId: quotes[0].id, observedAt: quotes[0].last_checked_at,
      priorCostPerUnit: product.cost_per_unit, priorCostUnit: product.cost_unit,
      priorInventoryUnit: product.inventory_unit, selectedPackagePrice: winner.best_price,
      selectedVendorPricingId: winner.best_vendor_pricing_id, costPerUnit: unitCost, costUnit: 'fl_oz',
      basis: 'Preserved newer supplier quote; reconciled current winning 2.5-gallon cost' } });
  console.info('[iron_newer_supplier_cost] newer supplier quote preserved; active iron cost reconciled');
};

// Preserve cost evidence and any later manual edits.
exports.down = async function down() {};
