'use strict';

/**
 * MUTATES (with --execute): Product catalog COGS cleanup & repair utility
 * (owner audit 2026-11-27).
 *
 * DRY-RUN BY DEFAULT: prints every proposed row change without modifying the
 * database. Pass `--execute` explicitly to execute changes inside a transaction
 * with row locks and in-transaction revalidation.
 *
 * Scope (3 deterministic fixes):
 *   1. Stale manual `cost_per_unit` overrides on liquid/granular products ONLY
 *      (`unit_size_oz IS NOT NULL AND unit_size_oz > 0`, active, backed by an
 *      eligible approved `vendor_pricing` row with `best_price > 0`). Explicitly
 *      SKIPS all count-based items (`unit_size_oz IS NULL`, `cost_unit = 'each'`,
 *      stations, traps, boxes, etc.) so count costing is never disturbed.
 *   2. Active products missing `best_vendor_pricing_id` (e.g. LESCO Dimension)
 *      that have eligible approved `vendor_pricing` rows — previews using the
 *      canonical `admin-inventory.scoreVendorRows` package scaling and applies
 *      via the locked `admin-inventory.recalcBestPrice(productId, trx)` writer
 *      so pack prices never overwrite incompatible single-unit prices.
 *   3. Broken `service_product_usage` rows using non-convertible `"bottle"` units
 *      (e.g. Liquid Termite Perimeter / Termidor SC) on verified LIQUID products
 *      (`packageMeasure === 'volume'`, `unit_size_oz > 0`, and current
 *      `costLineFromUsage` broken) — converts BOTH `usage_amount` and
 *      `usage_per_1000sf` by `unit_size_oz` into `fl_oz`.
 *
 * Usage:
 *   node ops/agents/cleanup-catalog-cost-overrides.js              # dry run
 *   node ops/agents/cleanup-catalog-cost-overrides.js --execute    # mutate in trx
 */

const {
  numberOrNull,
  convertToOz,
  normalizeUnit,
  packageMeasure,
  parsePackCount,
  countUnitsCompatible,
  costLineFromUsage,
} = require('../../server/services/product-costing');
const { eligibleVendorPricing } = require('../../server/services/vendor-pricing-eligibility');

const COUNT_COST_UNITS = new Set([
  'each', 'ea', 'unit', 'station', 'trap', 'box', 'pack', 'bag',
  'bottle', 'can', 'tube', 'bar', 'block', 'roll',
]);
const OVERRIDE_DRIFT_RATIO = 0.05;

function loadAdminInventoryHelpers() {
  const adminInv = require('../../server/routes/admin-inventory');
  return {
    scoreVendorRows: adminInv.scoreVendorRows,
    recalcBestPrice: adminInv.recalcBestPrice,
  };
}

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

function usageRowsRemainPriceableWithoutOverride(product, usageRows) {
  for (const usage of usageRows || []) {
    const merged = {
      ...usage,
      product_name: usage.product_name || product.name,
      unit_size_oz: product.unit_size_oz,
      container_size: product.container_size,
      inventory_unit: product.inventory_unit,
      best_price: product.best_price,
      cost_per_unit: null,
      cost_unit: null,
    };
    const priced = costLineFromUsage(merged, 1000);
    if (priced.warning || !(Number(priced.cost) > 0)) return false;
  }
  return true;
}

function staleOverrideCandidate(row, approvedSet, usageRows = []) {
  if (!row || row.active === false) return { status: 'skip' };
  const manualCost = numberOrNull(row.cost_per_unit);
  if (manualCost == null) return { status: 'skip' };
  if (isCountBasedProduct(row)) return { status: 'count_item' };
  // Preserve overrides used by automatic supply deductions (supplies-consumption.js reads cost_per_unit directly).
  if (numberOrNull(row.per_completion_usage) > 0) return { status: 'skip' };
  // Empty cost_unit applies cost_per_unit in each usage row's own unit (e.g. bottle);
  // never clear an implicit-unit override unless an explicit measured cost_unit exists.
  if (!String(row.cost_unit || '').trim()) return { status: 'skip' };
  if (!row.best_vendor_pricing_id || !approvedSet.has(String(row.best_vendor_pricing_id))) return { status: 'skip' };
  const livePerUnit = catalogLiveCostPerCostUnit(row);
  if (!(Number.isFinite(livePerUnit) && livePerUnit > 0)) return { status: 'skip' };
  const ratioDiff = Math.abs(manualCost - livePerUnit) / livePerUnit;
  if (ratioDiff <= OVERRIDE_DRIFT_RATIO) return { status: 'skip' };
  if (!usageRowsRemainPriceableWithoutOverride(row, usageRows)) return { status: 'skip' };
  return {
    status: 'stale',
    entry: {
      id: row.id,
      name: row.name,
      currentCostPerUnit: manualCost,
      currentCostUnit: row.cost_unit || null,
      liveDerivedPerUnit: livePerUnit,
      bestPrice: numberOrNull(row.best_price),
      unitSizeOz: numberOrNull(row.unit_size_oz),
      ratio: Number((manualCost / livePerUnit).toFixed(2)),
    },
  };
}

function planStaleOverrideClears(catalogRows, approvedVendorPricingIds, usageByProduct = new Map()) {
  const approvedSet = new Set([...(approvedVendorPricingIds || [])].map(String));
  const planned = [];
  const skippedCountItems = [];
  for (const row of catalogRows || []) {
    const usages = usageByProduct instanceof Map ? (usageByProduct.get(String(row.id)) || []) : [];
    const verdict = staleOverrideCandidate(row, approvedSet, usages);
    if (verdict.status === 'count_item') {
      skippedCountItems.push({ id: row.id, name: row.name, reason: 'count_item_preserved' });
    } else if (verdict.status === 'stale') {
      planned.push(verdict.entry);
    }
  }
  return { planned, skippedCountItems };
}

function explicitSingleContainerMatch(product, best) {
  const unitSizeOz = numberOrNull(product?.unit_size_oz);
  // Measured products MUST scale per oz; an unscalable case/pack quote can
  // never fill a measured container's best_price.
  if (unitSizeOz > 0) return false;
  const vendorPack = parsePackCount(best?.row?.quantity);
  if (!vendorPack || vendorPack.count !== 1) return false;
  const catalogPack = parsePackCount(product?.container_size);
  if (catalogPack) {
    return catalogPack.count === 1 && countUnitsCompatible(vendorPack.unit, catalogPack.unit);
  }
  const costUnit = normalizeUnit(product?.cost_unit);
  return Boolean(costUnit && countUnitsCompatible(vendorPack.unit, costUnit));
}

const WEIGHT_UNITS = new Set(['lb', 'lbs', 'pound', 'pounds', 'g', 'gram', 'grams', 'kg', 'kilogram', 'kilograms']);
const VOLUME_UNITS = new Set(['fl_oz', 'floz', 'gal', 'gallon', 'gallons', 'qt', 'quart', 'quarts', 'pt', 'pint', 'pints', 'ml', 'l', 'liter', 'liters']);

function unitMeasureFamily(unit) {
  const u = normalizeUnit(unit);
  if (WEIGHT_UNITS.has(u)) return 'weight';
  if (VOLUME_UNITS.has(u)) return 'volume';
  return null;
}

function measureFamilyCompatible(product, bestRow) {
  const prodMeasure = packageMeasure(product);
  if (!prodMeasure) return true;
  const normMeasure = unitMeasureFamily(bestRow?.unit_normalized);
  if (normMeasure && normMeasure !== prodMeasure) return false;
  const qtyMeasure = packageMeasure({ container_size: bestRow?.quantity });
  if (qtyMeasure && qtyMeasure !== prodMeasure) return false;
  return true;
}

function previewBestVendorLink(product, rows, scoreVendorRows) {
  if (!rows.length) return null;
  const { mode, pool, catalogCount, unitSizeOz } = scoreVendorRows(rows, product);
  const best = pool[0];
  if (!best) return null;
  const countScalable = mode === 'count';
  const scalable = (best.perOz != null && unitSizeOz > 0) || countScalable;
  // Verify weight vs volume measure compatibility on both unit_normalized and
  // quantity so a pound quote (even labeled '1 case') can never price a gallon liquid.
  if (mode === 'oz' && !measureFamilyCompatible(product, best.row)) return null;
  // Require a package that scales to the catalog container (oz or count) OR
  // explicitly matches one unmeasured container, so an unscalable multi-unit
  // case price can never populate a single container's best_price (even when
  // best_price is currently null).
  if (!scalable && !explicitSingleContainerMatch(product, best)) return null;
  if (!scalable && numberOrNull(product?.best_price) != null) return null;
  const bestPrice = countScalable
    ? Math.round(best.perUnit * catalogCount * 100) / 100
    : scalable
      ? Math.round(best.perOz * unitSizeOz * 100) / 100
      : best.price;
  if (!(Number.isFinite(bestPrice) && bestPrice > 0)) return null;
  return {
    productId: product.id,
    productName: product.name,
    bestVendorPricingId: best.row.id,
    vendorId: best.row.vendor_id,
    vendorName: best.row.vendor_name || null,
    mode,
    bestPrice,
  };
}

function planMissingVendorLinks(unlinkedProducts, eligibleVendorRows, { scoreVendorRows = loadAdminInventoryHelpers().scoreVendorRows } = {}) {
  const byProduct = new Map();
  for (const vp of eligibleVendorRows || []) {
    const key = String(vp.product_id);
    if (!byProduct.has(key)) byProduct.set(key, []);
    byProduct.get(key).push(vp);
  }
  const planned = [];
  for (const product of unlinkedProducts || []) {
    if (product.active === false || product.best_vendor_pricing_id) continue;
    const preview = previewBestVendorLink(product, byProduct.get(String(product.id)) || [], scoreVendorRows);
    if (preview) planned.push(preview);
  }
  return planned;
}

const MULTIPACK_CONTAINER_RE = /\b(?:case|pack|box|kit|carton|flat|tray)\b|\b(?:[2-9]|\d{2,})\s*x\b|\b(?:[2-9]|\d{2,})\s+(?:bottles?|jugs?|gallons?|gal|quarts?|qt|pints?|pt|containers?|cans?)\b/i;

function isMultipackContainer(containerSize) {
  const raw = String(containerSize || '').trim();
  if (!raw) return false;
  if (MULTIPACK_CONTAINER_RE.test(raw)) return true;
  const pack = parsePackCount(raw);
  return Boolean(pack && pack.count > 1);
}

function brokenLiquidBottleCandidate(row) {
  if (!row || normalizeUnit(row.usage_unit) !== 'bottle') return null;
  const unitSizeOz = numberOrNull(row.unit_size_oz);
  if (!(Number.isFinite(unitSizeOz) && unitSizeOz > 0)) return null;
  // Only convert verified single-bottle liquid packages (volume family, NOT
  // multipacks/cases like "4 x 1 gal" where unit_size_oz is the whole case).
  if (packageMeasure(row) !== 'volume' || isMultipackContainer(row.container_size)) return null;
  const amount = numberOrNull(row.usage_amount);
  const per1000 = numberOrNull(row.usage_per_1000sf);
  const hasAmount = Number.isFinite(amount) && amount > 0;
  const hasPer1000 = Number.isFinite(per1000) && per1000 > 0;
  if (!hasAmount && !hasPer1000) return null;
  // Convert ONLY broken mappings: if a manual cost_per_unit per bottle already
  // prices this usage cleanly with no warning, leave it alone.
  const currentCosting = costLineFromUsage(row, 1000);
  if (!currentCosting.warning && Number(currentCosting.cost) > 0) return null;
  const toAmount = hasAmount ? Number((amount * unitSizeOz).toFixed(4)) : null;
  const toPer1000 = hasPer1000 ? Number((per1000 * unitSizeOz).toFixed(4)) : null;
  // Reject any conversion that rounds a positive rate down to 0 at DB 4-decimal precision.
  if ((hasAmount && !(toAmount > 0)) || (hasPer1000 && !(toPer1000 > 0))) return null;
  return {
    usageId: row.id,
    serviceType: row.service_type,
    productId: row.product_id,
    productName: row.product_name,
    // Preserve exact original numeric values (including 0) for in-transaction revalidation.
    fromAmount: amount,
    fromPer1000: per1000,
    fromUnit: row.usage_unit,
    toAmount,
    toPer1000,
    toUnit: 'fl_oz',
    unitSizeOz,
  };
}

function planBrokenUsageUnitFixes(usageRows) {
  const planned = [];
  for (const row of usageRows || []) {
    const fix = brokenLiquidBottleCandidate(row);
    if (fix) planned.push(fix);
  }
  return planned;
}

async function buildCleanupPlan(dbc, helpers = {}) {
  const [catalogRows, approvedVpRows, unlinkedProducts, allUsageRows] = await Promise.all([
    dbc('products_catalog')
      .where('active', true)
      .whereNotNull('cost_per_unit')
      .select('id', 'name', 'active', 'cost_per_unit', 'cost_unit', 'best_price', 'unit_size_oz', 'container_size', 'inventory_unit', 'best_vendor_pricing_id', 'per_completion_usage'),
    eligibleVendorPricing(dbc('vendor_pricing'))
      .leftJoin('vendors', 'vendor_pricing.vendor_id', 'vendors.id')
      .select('vendor_pricing.*', 'vendors.name as vendor_name'),
    dbc('products_catalog')
      .where('active', true)
      .whereNull('best_vendor_pricing_id')
      .select('id', 'name', 'active', 'best_price', 'unit_size_oz', 'container_size', 'cost_unit', 'best_vendor_pricing_id'),
    dbc('service_product_usage')
      .join('products_catalog', 'service_product_usage.product_id', 'products_catalog.id')
      .select(
        'service_product_usage.id',
        'service_product_usage.service_type',
        'service_product_usage.product_id',
        'service_product_usage.usage_amount',
        'service_product_usage.usage_per_1000sf',
        'service_product_usage.usage_unit',
        'service_product_usage.notes',
        'products_catalog.name as product_name',
        'products_catalog.unit_size_oz',
        'products_catalog.container_size',
        'products_catalog.inventory_unit',
        'products_catalog.cost_per_unit',
        'products_catalog.cost_unit',
        'products_catalog.best_price',
      ),
  ]);

  const usageByProduct = new Map();
  for (const u of allUsageRows || []) {
    const pid = String(u.product_id);
    if (!usageByProduct.has(pid)) usageByProduct.set(pid, []);
    usageByProduct.get(pid).push(u);
  }
  const bottleUsageRows = (allUsageRows || []).filter((u) => normalizeUnit(u.usage_unit) === 'bottle');
  const approvedIds = new Set(approvedVpRows.map((r) => String(r.id)));
  const { planned: staleOverrides, skippedCountItems } = planStaleOverrideClears(catalogRows, approvedIds, usageByProduct);
  const missingVendorLinks = planMissingVendorLinks(unlinkedProducts, approvedVpRows, helpers);
  const brokenUsageUnits = planBrokenUsageUnitFixes(bottleUsageRows);
  return { staleOverrides, skippedCountItems, missingVendorLinks, brokenUsageUnits };
}

async function applyStaleOverrideClear(trx, item) {
  const fresh = await trx('products_catalog')
    .where({ id: item.id })
    .forUpdate()
    .first('id', 'name', 'active', 'cost_per_unit', 'cost_unit', 'best_price', 'unit_size_oz', 'container_size', 'inventory_unit', 'best_vendor_pricing_id', 'per_completion_usage');
  if (!fresh || numberOrNull(fresh.cost_per_unit) !== item.currentCostPerUnit) return 0;
  if (!fresh.best_vendor_pricing_id) return 0;
  const [approved, productUsages] = await Promise.all([
    eligibleVendorPricing(trx('vendor_pricing').where({ id: fresh.best_vendor_pricing_id })).first('id'),
    trx('service_product_usage').where({ product_id: fresh.id }).select('id', 'usage_amount', 'usage_per_1000sf', 'usage_unit', 'notes'),
  ]);
  if (!approved) return 0;
  if (staleOverrideCandidate(fresh, new Set([String(approved.id)]), productUsages).status !== 'stale') return 0;
  const updated = await trx('products_catalog')
    .where({ id: item.id })
    .whereNotNull('unit_size_oz')
    .where('unit_size_oz', '>', 0)
    .update({ cost_per_unit: null, cost_unit: null, updated_at: new Date() });
  return Number(updated) || 0;
}

async function applyMissingVendorLink(trx, link, { recalcBestPrice, scoreVendorRows }) {
  await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))', ['inventory.best_price', String(link.productId)]);
  const fresh = await trx('products_catalog')
    .where({ id: link.productId })
    .forUpdate()
    .first('id', 'name', 'active', 'best_price', 'unit_size_oz', 'container_size', 'cost_unit', 'best_vendor_pricing_id');
  if (!fresh || fresh.active === false || fresh.best_vendor_pricing_id) return 0;
  // Revalidate eligible vendor rows & package compatibility under the lock BEFORE calling recalcBestPrice,
  // so an expired last quote can never trigger recalcBestPrice to clear an existing best_price.
  const freshVpRows = await eligibleVendorPricing(trx('vendor_pricing').where({ product_id: link.productId }))
    .leftJoin('vendors', 'vendor_pricing.vendor_id', 'vendors.id')
    .select('vendor_pricing.*', 'vendors.name as vendor_name');
  if (!previewBestVendorLink(fresh, freshVpRows, scoreVendorRows)) return 0;
  await recalcBestPrice(link.productId, trx);
  const after = await trx('products_catalog').where({ id: link.productId }).first('best_vendor_pricing_id');
  return after?.best_vendor_pricing_id ? 1 : 0;
}

async function applyBrokenUsageUnitFix(trx, fix) {
  const freshUsage = await trx('service_product_usage')
    .where({ id: fix.usageId })
    .forUpdate()
    .first('id', 'service_type', 'product_id', 'usage_amount', 'usage_per_1000sf', 'usage_unit', 'notes');
  if (!freshUsage) return 0;
  if (numberOrNull(freshUsage.usage_amount) !== fix.fromAmount) return 0;
  if (numberOrNull(freshUsage.usage_per_1000sf) !== fix.fromPer1000) return 0;
  const product = await trx('products_catalog')
    .where({ id: freshUsage.product_id })
    .first('name as product_name', 'unit_size_oz', 'container_size', 'inventory_unit', 'cost_per_unit', 'cost_unit', 'best_price');
  const rechecked = brokenLiquidBottleCandidate({ ...freshUsage, ...(product || {}) });
  if (!rechecked) return 0;
  const patch = { usage_unit: rechecked.toUnit };
  if (rechecked.toAmount != null) patch.usage_amount = rechecked.toAmount;
  if (rechecked.toPer1000 != null) patch.usage_per_1000sf = rechecked.toPer1000;
  const updated = await trx('service_product_usage').where({ id: fix.usageId }).update(patch);
  return Number(updated) || 0;
}

async function runCleanup(dbc, { execute = false, helpers = {} } = {}) {
  const resolvedHelpers = { ...loadAdminInventoryHelpers(), ...helpers };
  const plan = await buildCleanupPlan(dbc, resolvedHelpers);
  const summary = {
    mode: execute ? 'execute' : 'dry_run',
    staleOverridesPlanned: plan.staleOverrides.length,
    skippedCountItems: plan.skippedCountItems.length,
    missingVendorLinksPlanned: plan.missingVendorLinks.length,
    brokenUsageUnitsPlanned: plan.brokenUsageUnits.length,
    applied: { overridesCleared: 0, vendorLinksUpdated: 0, usageUnitsConverted: 0 },
    plan,
  };
  if (!execute) return summary;

  await dbc.transaction(async (trx) => {
    for (const item of plan.staleOverrides) {
      summary.applied.overridesCleared += await applyStaleOverrideClear(trx, item);
    }
    for (const link of plan.missingVendorLinks) {
      summary.applied.vendorLinksUpdated += await applyMissingVendorLink(trx, link, resolvedHelpers);
    }
    for (const fix of plan.brokenUsageUnits) {
      summary.applied.usageUnitsConverted += await applyBrokenUsageUnitFix(trx, fix);
    }
  });
  return summary;
}

if (require.main === module) {
  const execute = process.argv.includes('--execute');
  const db = require('../../server/models/db');
  runCleanup(db, { execute })
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
