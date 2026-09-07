/**
 * Resolve six catalog quantity dimensions from existing package/cost evidence.
 * Liquid per-oz costs were derived from gallon packages by costPerUnit() in
 * 20260528000007_protocol_canonical_price_mappings. No new supplier prices,
 * treatment rates, product registrations or stock receipts are introduced.
 */
const SOURCE = 'lawn_cost_dimensions_20260907';
const PRODUCTS = [
  ['Prodiamine 65 WDG', '5 lb', 80, 'lb'],
  ['Armada 50 WDG', '2 lb', 32, 'lb'],
  ['SpeedZone Southern', '2.5 gal', 320, 'fl_oz'],
  ['LESCO 12-0-0 Chelated Iron Plus', '2.5 gal', 320, 'fl_oz'],
  ['LESCO K-Flow 0-0-25', '2.5 gal', 320, 'fl_oz'],
  ['Primo Maxx', '1 gal', 128, 'fl_oz'],
];

exports.up = async function up(knex) {
  const { applyInventoryUnitFix } = require('../../services/inventory-unit-review');
  const { unitDefinition } = require('../../services/inventory-units');
  const { recordAuditEvent } = require('../../services/audit-log');
  for (const [name, container, ounces, unit] of PRODUCTS) {
    const matches = await knex('products_catalog').where({ name }).forUpdate();
    if (matches.length !== 1) throw new Error(`Expected one catalog product: ${name}`);
    const product = matches[0];
    // Retired predecessors are excluded from operating protocols. The later
    // canonical migration validates and fills their active keeper instead.
    if (product.active === false) continue;
    const current = unitDefinition(product.inventory_unit);
    // Preserve an explicit admin choice. This migration only fills missing
    // dimensions on rows with no stock quantities to reinterpret.
    if (current && current.dimension !== 'ambiguous') continue;
    if (product.inventory_unit || product.inventory_on_hand != null || product.low_stock_threshold != null) {
      throw new Error(`Inventory quantities need review: ${name}`);
    }
    if (product.container_size !== container || !(Number(product.best_price) > 0)) {
      throw new Error(`Package evidence changed: ${name}`);
    }
    // For the four liquid rows, prove the existing cost is the four-decimal
    // gallon-derived price per fluid ounce. Never reinterpret a weight cost.
    if (unit === 'fl_oz' && (product.cost_unit !== 'oz'
      || product.cost_per_unit == null
      || Math.abs(Number(product.cost_per_unit) - Number(product.best_price) / ounces) > 0.00005)) {
      throw new Error(`Cost basis needs review: ${name}`);
    }
    await applyInventoryUnitFix({ dbi: knex, productId: product.id, nextUnit: unit,
      expectedCurrentUnit: product.inventory_unit, movementSource: SOURCE });
    await recordAuditEvent({ actor_type: 'system', action: SOURCE, resource_type: 'product',
      resource_id: String(product.id), critical: true, trx: knex,
      metadata: { container, ounces, priorInventoryUnit: product.inventory_unit, inventoryUnit: unit,
        costPerUnit: product.cost_per_unit, costUnit: product.cost_unit, packagePrice: product.best_price,
        source: 'Existing catalog package; liquid cost derivation in 20260528000007_protocol_canonical_price_mappings' } });
    console.info(`[lawn_cost_dimensions] ${name}: inventory dimension recorded as ${unit}; prices and rates unchanged`);
  }
};

// Preserve the evidence and any later inventory edits.
exports.down = async function down() {};
