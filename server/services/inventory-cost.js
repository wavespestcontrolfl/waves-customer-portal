/**
 * Product cost of a recorded amount — the one pricing rule shared by the
 * completion inventory deduction (complete-scheduled-service.js
 * deductProductInventory) and job costing's application-history fallback
 * (job-costing.js calcProductsCost), so a visit's material cost never depends
 * on which of the two paths priced it.
 *
 *   1. products_catalog.cost_per_unit is a price per cost_unit (else per the
 *      inventory unit): the deducted amount is converted into that unit.
 *   2. Else products_catalog.best_price is the price of ONE package holding
 *      unit_size_oz ounces: the amount used is priced as its share of that
 *      package.
 *
 * Neither applies → { unitCost: null, costUsed: null }. A caller must treat
 * that as "uncosted", never multiply the amount by a package price.
 */

const {
  INVENTORY_UNITS,
  convertInventoryQuantity,
  normalizeInventoryUnit,
} = require('./inventory-units');

function calculateInventoryCost({ product, deductedAmount, inventoryUnit, amount, amountUnit }) {
  const costPerUnit = product?.cost_per_unit != null ? Number(product.cost_per_unit) : null;
  if (costPerUnit != null && Number.isFinite(costPerUnit) && costPerUnit >= 0) {
    const costUnit = product.cost_unit || inventoryUnit;
    const costQuantity = convertInventoryQuantity(deductedAmount, inventoryUnit, costUnit);
    if (costQuantity != null) {
      return {
        unitCost: costPerUnit,
        costUsed: Number((costQuantity * costPerUnit).toFixed(4)),
      };
    }
  }

  const bestPrice = product?.best_price != null ? Number(product.best_price) : null;
  const unitSizeOz = product?.unit_size_oz != null ? Number(product.unit_size_oz) : null;
  const amountUnitDef = INVENTORY_UNITS[normalizeInventoryUnit(amountUnit)];
  const canonicalOzUnit = amountUnitDef?.dimension === 'volume' ? 'fl_oz' : 'oz';
  const usedOz = convertInventoryQuantity(amount, amountUnit, canonicalOzUnit);
  if (
    bestPrice != null && Number.isFinite(bestPrice) && bestPrice >= 0
    && unitSizeOz != null && Number.isFinite(unitSizeOz) && unitSizeOz > 0
    && usedOz != null
  ) {
    return {
      unitCost: Number((bestPrice / unitSizeOz).toFixed(4)),
      costUsed: Number(((usedOz / unitSizeOz) * bestPrice).toFixed(4)),
    };
  }

  return { unitCost: null, costUsed: null };
}

module.exports = { calculateInventoryCost };
