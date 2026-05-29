require('dotenv').config();

const db = require('../models/db');
const protocols = require('../config/protocols.json');
const {
  calculateProductAmount,
  effectiveAreaFactor,
  parseProtocolLines,
  parseVisitNutrientTargets,
  resolveProtocolItems,
  summarizeMaterialCost,
} = require('../services/waveguard-plan-engine');

const DEFAULT_LAWN_SQFT = Number(process.env.AUDIT_LAWN_SQFT || 10000);
const DEFAULT_CARRIER_GAL_PER_1000 = Number(process.env.AUDIT_CARRIER_GAL_PER_1000 || 1);
const VARIANCE_WARN_DOLLARS = Number(process.env.AUDIT_VARIANCE_WARN_DOLLARS || 5);
const VARIANCE_WARN_RATIO = Number(process.env.AUDIT_VARIANCE_WARN_RATIO || 0.2);

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
}

function normalizedStaticMaterialCost(visit) {
  const value = Number(visit?.material_cost);
  return Number.isFinite(value) ? value : null;
}

function isMaterialIntentLine(item) {
  if (!item) return false;
  if (item.scope === 'INSPECTION_ONLY') return false;
  return /\$[\d.]+/.test(String(item.raw || ''));
}

async function getProtocolProducts() {
  const products = await db('products_catalog')
    .where(function activeOnly() {
      this.where({ active: true }).orWhereNull('active');
    })
    .select(
      'id', 'name', 'category', 'active_ingredient', 'moa_group',
      'frac_group', 'irac_group', 'hrac_group',
      'analysis_n', 'analysis_p', 'analysis_k',
      'default_rate_per_1000', 'rate_unit',
      'best_price', 'cost_per_unit', 'cost_unit', 'container_size', 'unit_size_oz', 'needs_pricing',
      'mixing_order_category', 'mixing_instructions',
      'label_verified_at',
    )
    .orderBy('name');

  const productIds = products.map((product) => product.id).filter(Boolean);
  const aliases = productIds.length
    ? await db('product_aliases')
      .whereIn('product_id', productIds)
      .select('product_id', 'alias_name')
      .catch(() => [])
    : [];
  const aliasesByProduct = aliases.reduce((acc, row) => {
    if (!acc[row.product_id]) acc[row.product_id] = [];
    acc[row.product_id].push(row.alias_name);
    return acc;
  }, {});

  return products.map((product) => ({
    ...product,
    aliases: aliasesByProduct[product.id] || [],
  }));
}

function analyzeVisit({ trackKey, track, visit, products, options }) {
  const lines = [
    ...parseProtocolLines(visit.primary, 'base'),
    ...parseProtocolLines(visit.secondary, 'conditional'),
  ];
  const nutrientTargets = parseVisitNutrientTargets(visit.notes);
  const items = resolveProtocolItems(lines, products, options, {
    profile: { track_key: trackKey, lawn_sqft: DEFAULT_LAWN_SQFT },
    service: { waveguard_tier: options.plan || 'Platinum' },
  }).map((item) => {
    const areaFactor = effectiveAreaFactor(item, {
      plan: options.plan || 'Platinum',
      weedPressure: options.weedPressure,
      conditionFlags: options.conditionFlags,
      propertyFlags: options.propertyFlags,
      includePremiumOnly: options.includePremiumOnly,
      isFirstYear: options.isFirstYear,
    });
    return {
      ...item,
      mix: item.product ? calculateProductAmount({
        product: item.product,
        lawnSqft: DEFAULT_LAWN_SQFT,
        carrierGalPer1000: DEFAULT_CARRIER_GAL_PER_1000,
        areaFactor,
        ...nutrientTargets,
      }) : null,
    };
  });

  const selectedItems = items.filter((item) => item.selected);
  const materialSummary = summarizeMaterialCost(selectedItems);
  const legacyMaterialCost = normalizedStaticMaterialCost(visit);
  const variance = legacyMaterialCost == null || materialSummary.pricedLineCount === 0
    ? null
    : money(materialSummary.total - legacyMaterialCost);
  const varianceRatio = legacyMaterialCost && variance != null
    ? Math.abs(variance) / legacyMaterialCost
    : 0;

  const unmatched = items.filter((item) => !item.product && isMaterialIntentLine(item));
  const selectedMissingMaterialCost = selectedItems.filter((item) => (
    item.product
    && item.mix?.amount
    && item.mix.materialCost == null
  ));
  const selectedMissingRate = selectedItems.filter((item) => (
    item.product
    && item.scope !== 'INSPECTION_ONLY'
    && item.mix?.rateSource === 'missing_rate'
  ));
  const selectedNeedsPricing = selectedItems.filter((item) => item.product?.needs_pricing === true);
  const selectedMissingInventoryPrice = selectedItems.filter((item) => (
    item.product
    && item.mix?.amount
    && Number(item.product.cost_per_unit || 0) <= 0
    && Number(item.product.best_price || 0) <= 0
  ));
  const varianceFlag = variance != null
    && (Math.abs(variance) >= VARIANCE_WARN_DOLLARS || varianceRatio >= VARIANCE_WARN_RATIO);

  return {
    trackKey,
    trackName: track.name,
    visit: visit.visit,
    month: visit.month,
    legacyMaterialCost: money(legacyMaterialCost),
    inventoryMaterialCost: materialSummary.total,
    variance,
    varianceFlag,
    pricedLineCount: materialSummary.pricedLineCount,
    selectedLineCount: materialSummary.selectedLineCount,
    missingPriceCount: materialSummary.missingPriceCount,
    unmatched,
    selectedMissingMaterialCost,
    selectedMissingRate,
    selectedNeedsPricing,
    selectedMissingInventoryPrice,
    items,
  };
}

function issueLines(results, key, label) {
  const rows = [];
  for (const result of results) {
    for (const item of result[key]) {
      rows.push({
        track: result.trackKey,
        visit: `${result.month} V${result.visit}`,
        product: item.product?.name || item.raw,
        raw: item.raw,
        scope: item.scope,
        selected: item.selected,
        reason: item.selectionReason,
        rateSource: item.mix?.rateSource || '',
      });
    }
  }
  if (!rows.length) return;
  console.log(`\n${label}: ${rows.length}`);
  for (const row of rows) {
    console.log([
      row.track,
      row.visit,
      row.scope,
      row.selected ? 'selected' : 'not_selected',
      row.rateSource,
      row.product,
      row.raw,
    ].join('\t'));
  }
}

function printResults(results) {
  const totals = results.reduce((acc, result) => {
    acc.legacy += Number(result.legacyMaterialCost || 0);
    acc.inventory += Number(result.inventoryMaterialCost || 0);
    acc.unmatched += result.unmatched.length;
    acc.missingMaterial += result.selectedMissingMaterialCost.length;
    acc.missingRate += result.selectedMissingRate.length;
    acc.needsPricing += result.selectedNeedsPricing.length;
    acc.missingInventory += result.selectedMissingInventoryPrice.length;
    acc.varianceFlags += result.varianceFlag ? 1 : 0;
    return acc;
  }, {
    legacy: 0,
    inventory: 0,
    unmatched: 0,
    missingMaterial: 0,
    missingRate: 0,
    needsPricing: 0,
    missingInventory: 0,
    varianceFlags: 0,
  });

  console.log('WaveGuard protocol material cost audit');
  console.log(`Assumptions: ${DEFAULT_LAWN_SQFT.toLocaleString()} sqft, ${DEFAULT_CARRIER_GAL_PER_1000} gal carrier/1K, Platinum/default branch context`);
  console.log(`Visits audited: ${results.length}`);
  console.log(`Legacy material total: $${money(totals.legacy)}`);
  console.log(`Inventory-backed selected material total: $${money(totals.inventory)}`);
  console.log(`Unmatched protocol lines: ${totals.unmatched}`);
  console.log(`Selected lines with amount but no materialCost: ${totals.missingMaterial}`);
  console.log(`Selected lines missing rate: ${totals.missingRate}`);
  console.log(`Selected needs-pricing products: ${totals.needsPricing}`);
  console.log(`Selected products missing inventory price: ${totals.missingInventory}`);
  console.log(`Visits with legacy-vs-inventory variance flags: ${totals.varianceFlags}`);

  const varianceRows = results.filter((result) => result.varianceFlag);
  if (varianceRows.length) {
    console.log('\nLegacy vs inventory variance flags');
    for (const result of varianceRows) {
      console.log([
        result.trackKey,
        `${result.month} V${result.visit}`,
        `legacy=$${result.legacyMaterialCost}`,
        `inventory=$${result.inventoryMaterialCost}`,
        `variance=$${result.variance}`,
        `priced=${result.pricedLineCount}/${result.selectedLineCount}`,
      ].join('\t'));
    }
  }

  issueLines(results, 'unmatched', 'Unmatched protocol lines');
  issueLines(results, 'selectedMissingRate', 'Selected lines missing rate');
  issueLines(results, 'selectedMissingMaterialCost', 'Selected lines with amount but no materialCost');
  issueLines(results, 'selectedNeedsPricing', 'Selected needs-pricing products');
  issueLines(results, 'selectedMissingInventoryPrice', 'Selected products missing inventory price');
}

async function main() {
  const products = await getProtocolProducts();
  const options = {
    plan: 'Platinum',
    includePremiumOnly: true,
    isFirstYear: true,
    weedPressure: 'normal',
  };
  const tracks = Object.entries(protocols.lawn || {});
  const results = [];

  for (const [trackKey, track] of tracks) {
    for (const visit of track.visits || []) {
      results.push(analyzeVisit({ trackKey, track, visit, products, options }));
    }
  }

  printResults(results);
}

main()
  .catch((err) => {
    if (/Unable to acquire a connection/i.test(err.message || '')) {
      console.error('Unable to acquire a database connection. Set DATABASE_URL/DATABASE_PUBLIC_URL or run via the deployed environment variables.');
    }
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
