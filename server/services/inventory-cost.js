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
 *      package. unit_size_oz is a bare ounce count, and the package label
 *      (container_size) says whether they are weight or fluid ounces; a label
 *      with a plain "oz" or no size leaves it to the stock unit. A volume
 *      amount never prices against a weight package, nor a weight amount
 *      against a fluid one: half a gallon logged against a 13.5 g packet once
 *      booked 133 packets for one visit. A plain "oz" amount, or a package
 *      neither its label nor its stock unit measures, still prices.
 *
 * Neither applies → { unitCost: null, costUsed: null }. A caller must treat
 * that as "uncosted", never multiply the amount by a package price.
 */

const {
  INVENTORY_UNITS,
  convertInventoryQuantity,
  normalizeInventoryUnit,
} = require('./inventory-units');
const { parsePackSize, unitFamily } = require('./product-costing');

// A catalog number column as a number; NULL stays null, so Number.isFinite rejects it (Number(null) would be 0).
const numberOrNull = (value) => (value == null ? null : Number(value));
const measuredFamily = (family) => (family === 'weight' || family === 'volume' ? family : null);

// 'weight' or 'volume': what one best_price package holds. The label says so ("13.5 g", "1 gal"); when it names no measure
// (a plain "oz", or no size) the stock unit does: a product stocked in g holds weight ounces. null when neither says.
function packageFamily(product) {
  const pack = parsePackSize(product?.container_size);
  return measuredFamily(pack && unitFamily(pack.unit))
    || measuredFamily(INVENTORY_UNITS[normalizeInventoryUnit(product?.inventory_unit)]?.dimension);
}

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
  const amountDimension = INVENTORY_UNITS[normalizeInventoryUnit(amountUnit)]?.dimension;
  const usedOz = convertInventoryQuantity(amount, amountUnit, amountDimension === 'volume' ? 'fl_oz' : 'oz');
  const usedFamily = measuredFamily(amountDimension);
  const packFamily = packageFamily(product);
  const sameMeasure = !usedFamily || !packFamily || usedFamily === packFamily;
  if (
    Number.isFinite(bestPrice) && bestPrice >= 0
    && Number.isFinite(unitSizeOz) && unitSizeOz > 0
    && usedOz != null && sameMeasure
  ) {
    return {
      unitCost: Number((bestPrice / unitSizeOz).toFixed(4)),
      costUsed: Number(((usedOz / unitSizeOz) * bestPrice).toFixed(4)),
    };
  }

  return { unitCost: null, costUsed: null };
}

module.exports = { calculateInventoryCost };
