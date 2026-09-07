/**
 * Forward correction after 20260907000021: follow the active keeper names
 * established by 20260712000051_catalog_dedupe_irrigation_rotation, and
 * validate measured cost overrides for dry products as well as liquids.
 */
const assert = require('node:assert/strict');
const SOURCE = 'canonical_lawn_cost_dimensions_20260907';
const PRODUCTS = [
  [['Prodiamine 65 WDG'], '5 lb', 80, 'lb'],
  [['Armada 50 WDG'], '2 lb', 32, 'lb'],
  [['SpeedZone Southern'], '2.5 gal', 320, 'fl_oz'],
  [['LESCO Chelated Iron Plus', 'LESCO 12-0-0 Chelated Iron Plus'], '2.5 gal', 320, 'fl_oz'],
  [['LESCO K-Flow 0-0-25 17% S Turfgrass Liquid Fertilizer', 'LESCO K-Flow 0-0-25'], '2.5 gal', 320, 'fl_oz'],
  [['Primo Maxx Plant Growth Regulator for Turf', 'Primo Maxx'], '1 gal', 128, 'fl_oz'],
];

exports.up = async function up(knex) {
  const { applyInventoryUnitFix } = require('../../services/inventory-unit-review');
  const { unitDefinition } = require('../../services/inventory-units');
  const { convertToOz } = require('../../services/product-costing');
  const { recordAuditEvent } = require('../../services/audit-log');
  for (const [names, container, ounces, unit] of PRODUCTS) {
    const matches = await knex('products_catalog').whereIn('name', names)
      .whereRaw('active IS NOT FALSE').forUpdate();
    assert.equal(matches.length, 1, `Expected one active catalog product: ${names[0]}`);
    const product = matches[0];
    const dimension = unitDefinition(unit).dimension;
    assert.equal(product.container_size, container, `Package evidence changed: ${product.name}`);
    assert.ok(Number(product.best_price) > 0, `Package price missing: ${product.name}`);
    if (product.unit_size_oz != null) {
      assert.equal(Number(product.unit_size_oz), ounces, `Package size conflicts: ${product.name}`);
    }
    // Validate before the already-correct-unit exit: the earlier migration
    // may have filled a dry unit without checking a stale cost override.
    if (product.cost_per_unit != null) {
      const costDimension = unitDefinition(product.cost_unit)?.dimension;
      assert.ok([dimension, 'ambiguous'].includes(costDimension), `Cost unit conflicts: ${product.name}`);
      const costUnitOz = convertToOz(1, product.cost_unit);
      assert.ok(costUnitOz, `Cost unit unsupported: ${product.name}`);
      const expected = Number(product.best_price) / ounces * costUnitOz;
      assert.ok(Math.abs(Number(product.cost_per_unit) - expected) <= 0.00005,
        `Cost basis needs review: ${product.name}`);
    }
    const current = unitDefinition(product.inventory_unit);
    if (current?.dimension === dimension) continue;
    assert.ok(!product.inventory_unit, `Inventory unit needs review: ${product.name}`);
    assert.equal(product.inventory_on_hand, null, `Stock basis missing: ${product.name}`);
    assert.equal(product.low_stock_threshold, null, `Stock threshold basis missing: ${product.name}`);
    await applyInventoryUnitFix({ dbi: knex, productId: product.id, nextUnit: unit,
      expectedCurrentUnit: product.inventory_unit, movementSource: SOURCE });
    await recordAuditEvent({ actor_type: 'system', action: SOURCE, resource_type: 'product',
      resource_id: String(product.id), critical: true, trx: knex,
      metadata: { container, ounces, inventoryUnit: unit, priorInventoryUnit: product.inventory_unit,
        costPerUnit: product.cost_per_unit, costUnit: product.cost_unit, packagePrice: product.best_price,
        source: 'Active catalog keeper; existing package and consistent unit-price evidence' } });
    console.info(`[canonical_lawn_cost_dimensions] ${product.name}: ${unit}; prices and rates unchanged`);
  }
  console.info('[canonical_lawn_cost_dimensions] validated six active product cost bases');
};

// Never undo canonical inventory evidence or subsequent admin choices.
exports.down = async function down() {};
