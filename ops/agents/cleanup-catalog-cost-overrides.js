'use strict';

/**
 * Product catalog COGS cleanup & repair utility (owner audit 2026-11-27).
 *
 * DRY-RUN BY DEFAULT: prints every proposed row change without modifying the
 * database. Pass `--apply` explicitly to execute changes inside a transaction.
 *
 * Scope (3 deterministic fixes):
 *   1. Stale manual `cost_per_unit` overrides on liquid/granular products ONLY
 *      (`unit_size_oz IS NOT NULL AND unit_size_oz > 0`, active, backed by an
 *      eligible approved `vendor_pricing` row with `best_price > 0`). Explicitly
 *      SKIPS all count-based items (`unit_size_oz IS NULL`, `cost_unit = 'each'`,
 *      stations, traps, boxes, etc.) so count costing is never disturbed.
 *   2. Active products missing `best_vendor_pricing_id` (e.g. LESCO Dimension)
 *      that have eligible approved `vendor_pricing` rows — links the winning
 *      row deterministically using the same eligibility rules as admin-inventory.
 *   3. Broken `service_product_usage` rows using non-convertible `"bottle"` units
 *      (e.g. Liquid Termite Perimeter / Termidor SC) on liquid products with a
 *      known `unit_size_oz` — converts `usage_amount * unit_size_oz` to `fl_oz`.
 *
 * Usage:
 *   node ops/agents/cleanup-catalog-cost-overrides.js            # dry run
 *   node ops/agents/cleanup-catalog-cost-overrides.js --apply    # apply in trx
 */

const { numberOrNull, convertToOz, normalizeUnit } = require('../../server/services/product-costing');
const { eligibleVendorPricing } = require('../../server/services/vendor-pricing-eligibility');

const COUNT_COST_UNITS = new Set(['each', 'ea', 'unit', 'station', 'trap', 'box', 'pack', 'bag', 'bottle', 'can', 'tube', 'bar', 'block', 'roll']);
const OVERRIDE_DRIFT_RATIO = 0.05;

function isCountBasedProduct(product) {
  const unitSizeOz = numberOrNull(product?.unit_size_oz);
  if (!(Number.isFinite(unitSizeOz) && unitSizeOz > 0)) return true;
  const costUnit = normalizeUnit(product?.cost_unit);
  if (costUnit && COUNT_COST_UNITS.has(costUnit)) return true;
  return false;
}

function catalogLiveCostPerCostUnit(product) {
  const bestPrice = numberOrNull(product?.best_price);
  const unitSizeOz = numberOrNull(product?.unit_size_oz);
  if (!(Number.isFinite(bestPrice) && bestPrice > 0 && Number.isFinite(unitSizeOz) && unitSizeOz > 0)) {
    return null;
  }
  const perOz = bestPrice / unitSizeOz;
  const costUnit = product?.cost_unit || product?.inventory_unit || 'oz';
  const ozPerCostUnit = convertToOz(1, costUnit);
  if (!(Number.isFinite(ozPerCostUnit) && ozPerCostUnit > 0)) return null;
  return Number((perOz * ozPerCostUnit).toFixed(4));
}

function planStaleOverrideClears(catalogRows, approvedVendorPricingIds) {
  const approvedSet = new Set([...(approvedVendorPricingIds || [])].map(String));
  const planned = [];
  const skippedCountItems = [];
  for (const row of catalogRows || []) {
    if (row.active === false) continue;
    const manualCost = numberOrNull(row.cost_per_unit);
    if (manualCost == null) continue;
    if (isCountBasedProduct(row)) {
      skippedCountItems.push({ id: row.id, name: row.name, reason: 'count_item_preserved' });
      continue;
    }
    if (!row.best_vendor_pricing_id || !approvedSet.has(String(row.best_vendor_pricing_id))) continue;
    const livePerUnit = catalogLiveCostPerCostUnit(row);
    if (!(Number.isFinite(livePerUnit) && livePerUnit > 0)) continue;
    const ratioDiff = Math.abs(manualCost - livePerUnit) / livePerUnit;
    if (ratioDiff <= OVERRIDE_DRIFT_RATIO) continue;
    planned.push({
      id: row.id,
      name: row.name,
      currentCostPerUnit: manualCost,
      currentCostUnit: row.cost_unit || null,
      liveDerivedPerUnit: livePerUnit,
      bestPrice: numberOrNull(row.best_price),
      unitSizeOz: numberOrNull(row.unit_size_oz),
      ratio: Number((manualCost / livePerUnit).toFixed(2)),
    });
  }
  return { planned, skippedCountItems };
}

function planMissingVendorLinks(unlinkedProducts, eligibleVendorRows) {
  const byProduct = new Map();
  for (const vp of eligibleVendorRows || []) {
    const key = String(vp.product_id);
    if (!byProduct.has(key)) byProduct.set(key, []);
    byProduct.get(key).push(vp);
  }
  const planned = [];
  for (const product of unlinkedProducts || []) {
    if (product.active === false || product.best_vendor_pricing_id) continue;
    const candidates = (byProduct.get(String(product.id)) || [])
      .map((vp) => ({
        vp,
        price: numberOrNull(vp.price_amount ?? vp.price),
      }))
      .filter((entry) => Number.isFinite(entry.price) && entry.price > 0)
      .sort((a, b) => a.price - b.price || String(a.vp.id).localeCompare(String(b.vp.id)));
    if (!candidates.length) continue;
    const winner = candidates[0];
    planned.push({
      productId: product.id,
      productName: product.name,
      bestVendorPricingId: winner.vp.id,
      vendorId: winner.vp.vendor_id,
      vendorName: winner.vp.vendor_name || null,
      bestPrice: Number(winner.price.toFixed(2)),
    });
  }
  return planned;
}

function planBrokenUsageUnitFixes(usageRows) {
  const planned = [];
  for (const row of usageRows || []) {
    if (normalizeUnit(row.usage_unit) !== 'bottle') continue;
    const amount = numberOrNull(row.usage_amount);
    const unitSizeOz = numberOrNull(row.unit_size_oz);
    if (!(Number.isFinite(amount) && amount > 0 && Number.isFinite(unitSizeOz) && unitSizeOz > 0)) continue;
    const nextAmount = Number((amount * unitSizeOz).toFixed(2));
    planned.push({
      usageId: row.id,
      serviceType: row.service_type,
      productId: row.product_id,
      productName: row.product_name,
      fromAmount: amount,
      fromUnit: row.usage_unit,
      toAmount: nextAmount,
      toUnit: 'fl_oz',
      unitSizeOz,
    });
  }
  return planned;
}

async function buildCleanupPlan(dbc) {
  const [catalogRows, approvedVpRows, unlinkedProducts, usageRows] = await Promise.all([
    dbc('products_catalog')
      .where('active', true)
      .whereNotNull('cost_per_unit')
      .select('id', 'name', 'active', 'cost_per_unit', 'cost_unit', 'best_price', 'unit_size_oz', 'inventory_unit', 'best_vendor_pricing_id'),
    eligibleVendorPricing(dbc('vendor_pricing'))
      .leftJoin('vendors', 'vendor_pricing.vendor_id', 'vendors.id')
      .select('vendor_pricing.id', 'vendor_pricing.product_id', 'vendor_pricing.vendor_id', 'vendor_pricing.price_amount', 'vendor_pricing.price', 'vendors.name as vendor_name'),
    dbc('products_catalog')
      .where('active', true)
      .whereNull('best_vendor_pricing_id')
      .select('id', 'name', 'active', 'best_price', 'unit_size_oz', 'best_vendor_pricing_id'),
    dbc('service_product_usage')
      .join('products_catalog', 'service_product_usage.product_id', 'products_catalog.id')
      .whereRaw("LOWER(BTRIM(COALESCE(service_product_usage.usage_unit, ''))) IN ('bottle', 'bottles')")
      .select(
        'service_product_usage.id',
        'service_product_usage.service_type',
        'service_product_usage.product_id',
        'service_product_usage.usage_amount',
        'service_product_usage.usage_unit',
        'products_catalog.name as product_name',
        'products_catalog.unit_size_oz',
      ),
  ]);

  const approvedIds = new Set(approvedVpRows.map((r) => String(r.id)));
  const { planned: staleOverrides, skippedCountItems } = planStaleOverrideClears(catalogRows, approvedIds);
  const missingVendorLinks = planMissingVendorLinks(unlinkedProducts, approvedVpRows);
  const brokenUsageUnits = planBrokenUsageUnitFixes(usageRows);
  return { staleOverrides, skippedCountItems, missingVendorLinks, brokenUsageUnits };
}

async function runCleanup(dbc, { apply = false } = {}) {
  const plan = await buildCleanupPlan(dbc);
  const summary = {
    mode: apply ? 'apply' : 'dry_run',
    staleOverridesPlanned: plan.staleOverrides.length,
    skippedCountItems: plan.skippedCountItems.length,
    missingVendorLinksPlanned: plan.missingVendorLinks.length,
    brokenUsageUnitsPlanned: plan.brokenUsageUnits.length,
    applied: { overridesCleared: 0, vendorLinksUpdated: 0, usageUnitsConverted: 0 },
    plan,
  };
  if (!apply) return summary;

  await dbc.transaction(async (trx) => {
    for (const item of plan.staleOverrides) {
      const updated = await trx('products_catalog')
        .where({ id: item.id })
        .whereNotNull('unit_size_oz')
        .where('unit_size_oz', '>', 0)
        .update({ cost_per_unit: null, cost_unit: null, updated_at: new Date() });
      summary.applied.overridesCleared += Number(updated) || 0;
    }
    for (const link of plan.missingVendorLinks) {
      const updated = await trx('products_catalog')
        .where({ id: link.productId })
        .whereNull('best_vendor_pricing_id')
        .update({
          best_vendor_pricing_id: link.bestVendorPricingId,
          best_price: link.bestPrice,
          best_vendor: link.vendorName,
          best_price_amount_cached: link.bestPrice,
          best_price_vendor_id_cached: link.vendorId,
          best_price_status: 'current',
          needs_pricing: false,
          best_price_updated_at: new Date(),
          updated_at: new Date(),
        });
      if (Number(updated) > 0) {
        await trx('vendor_pricing').where({ product_id: link.productId }).update({ is_best_price: false });
        await trx('vendor_pricing').where({ id: link.bestVendorPricingId }).update({ is_best_price: true });
        summary.applied.vendorLinksUpdated += 1;
      }
    }
    for (const fix of plan.brokenUsageUnits) {
      const updated = await trx('service_product_usage')
        .where({ id: fix.usageId })
        .update({ usage_amount: fix.toAmount, usage_unit: fix.toUnit });
      summary.applied.usageUnitsConverted += Number(updated) || 0;
    }
  });
  return summary;
}

if (require.main === module) {
  const apply = process.argv.includes('--apply');
  const db = require('../../server/models/db');
  runCleanup(db, { apply })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      return db.destroy();
    })
    .catch(async (err) => {
      console.error('[cleanup-catalog-cost-overrides] failed:', err.code || err.name || 'ERROR');
      await db.destroy().catch(() => {});
      process.exit(1);
    });
}

module.exports = {
  isCountBasedProduct,
  catalogLiveCostPerCostUnit,
  planStaleOverrideClears,
  planMissingVendorLinks,
  planBrokenUsageUnitFixes,
  buildCleanupPlan,
  runCleanup,
};
