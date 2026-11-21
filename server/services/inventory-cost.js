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
 *      package. unit_size_oz is a bare ounce count, so a volume amount never
 *      prices against a weight package, nor a weight amount against a fluid
 *      one (packageMeasureClash, product-costing.js: the package label, else
 *      the stock unit). Half a gallon logged against a 13.5 g packet once
 *      booked 133 packets for one visit.
 *
 * Neither applies → { unitCost: null, costUsed: null }. A caller must treat
 * that as "uncosted", never multiply the amount by a package price.
 */

const {
  INVENTORY_UNITS,
  convertInventoryQuantity,
  normalizeInventoryUnit,
} = require('./inventory-units');
const { numberOrNull, packageMeasureClash } = require('./product-costing');

function calculateInventoryCost({ product, deductedAmount, inventoryUnit, amount, amountUnit }) {
  const costPerUnit = numberOrNull(product?.cost_per_unit);
  if (Number.isFinite(costPerUnit) && costPerUnit >= 0) {
    const costUnit = product.cost_unit || inventoryUnit;
    const costQuantity = convertInventoryQuantity(deductedAmount, inventoryUnit, costUnit);
    if (costQuantity != null) {
      return {
        unitCost: costPerUnit,
        costUsed: Number((costQuantity * costPerUnit).toFixed(4)),
      };
    }
  }

  const bestPrice = numberOrNull(product?.best_price);
  const unitSizeOz = numberOrNull(product?.unit_size_oz);
  const amountUnitDef = INVENTORY_UNITS[normalizeInventoryUnit(amountUnit)];
  const canonicalOzUnit = amountUnitDef?.dimension === 'volume' ? 'fl_oz' : 'oz';
  const usedOz = convertInventoryQuantity(amount, amountUnit, canonicalOzUnit);
  if (
    Number.isFinite(bestPrice) && bestPrice >= 0
    && Number.isFinite(unitSizeOz) && unitSizeOz > 0
    && usedOz != null && !packageMeasureClash(product, amountUnit)
  ) {
    return {
      unitCost: Number((bestPrice / unitSizeOz).toFixed(4)),
      costUsed: Number(((usedOz / unitSizeOz) * bestPrice).toFixed(4)),
    };
  }

  return { unitCost: null, costUsed: null };
}

module.exports = { calculateInventoryCost };
