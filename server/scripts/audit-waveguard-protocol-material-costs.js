// READ-ONLY: reconciles protocol allowances with catalog-calculated quantities.
// --cadences compares the sold 6/9/12 schedules; --json emits review evidence.
// Costs remain assumptions until supplier units, rates and calendars are verified.
require('../config/load-env')();

const { parseArgs } = require('node:util');
const db = require('../models/db');
const { lawnProtocols, visitForCadence } = require('../services/lawn-program');
const { LAWN_MATERIAL_BUDGETS, MATERIAL_REFERENCE_SQFT } = require('@waves/lawn-cost-floor');
const { unitDefinition } = require('../services/inventory-units');
const { convertToOz, unitPriceBreakdown } = require('../services/product-costing');
const {
  calculateProductAmount,
  effectiveAreaFactor,
  parseProtocolLines,
  parseVisitNutrientTargets,
  resolveProtocolItems,
  summarizeMaterialCost,
  loadV13RowsForMonth,
  v13RateOptions,
  v13RowCalculates,
} = require('../services/waveguard-plan-engine');

const DEFAULT_LAWN_SQFT = Number(process.env.AUDIT_LAWN_SQFT || 10000);
const DEFAULT_CARRIER_GAL_PER_1000 = Number(process.env.AUDIT_CARRIER_GAL_PER_1000 || 1);
const VARIANCE_WARN_DOLLARS = Number(process.env.AUDIT_VARIANCE_WARN_DOLLARS || 5);
const VARIANCE_WARN_RATIO = Number(process.env.AUDIT_VARIANCE_WARN_RATIO || 0.2);

function money(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
}

function normalizedStaticMaterialCost(visit, lawnSqft) {
  const value = money(visit?.material_cost);
  return value == null ? null : value * lawnSqft / 10000;
}

function isMaterialIntentLine(item) {
  if (!item) return false;
  if (item.scope === 'INSPECTION_ONLY') return false;
  const raw = String(item.raw || '');
  if (/conditional ceiling|reprice flag/i.test(raw)) return false;
  if (/soil sample/i.test(raw)) return false;
  // A missing dollar annotation must not make an unmatched treatment invisible.
  return item.selected === true;
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
      'best_price', 'cost_per_unit', 'cost_unit', 'inventory_unit', 'container_size', 'unit_size_oz', 'needs_pricing',
      'mixing_order_category', 'mixing_instructions',
      'label_verified_at',
    )
    .orderBy('name');

  const productIds = products.map((product) => product.id).filter(Boolean);
  const aliases = productIds.length
    ? await db('product_aliases')
      .whereIn('product_id', productIds)
      .select('product_id', 'alias_name')
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

// GATE_LAWN_V13: the staged v13 protocol's rows for every track and month, keyed
// 'track|Mon' to a Map by catalog id; empty with the gate off. The audit prices
// each line with the same stated rate or nutrient-target derivation the plan
// uses, never the catalog default. Throws if the gate is on and a track has no
// staged v13 protocol: a cost report for a different treatment plan is worse
// than none.
async function loadV13Rows(lawn = lawnProtocols()) {
  const rows = new Map();
  for (const [trackKey, track] of Object.entries(lawn || {})) {
    for (const visit of track.visits || []) {
      rows.set(`${trackKey}|${visit.month}`, await loadV13RowsForMonth(db, trackKey, visit.month));
    }
  }
  return rows;
}

function analyzeVisit({ trackKey, track, visit, products, options, lawnSqft = DEFAULT_LAWN_SQFT, v13Rows = new Map() }) {
  const protocolRows = v13Rows.get(`${trackKey}|${visit.month}`);
  const exactName = track?.exact_catalog_names === true;
  const lines = [
    ...parseProtocolLines(visit.primary, 'base', { exactName }),
    ...parseProtocolLines(visit.secondary, 'conditional', { exactName }),
  ];
  const nutrientTargets = parseVisitNutrientTargets(visit.notes);
  const items = resolveProtocolItems(lines, products, options, {
    profile: { track_key: trackKey, lawn_sqft: lawnSqft },
    service: { waveguard_tier: options.plan || 'Platinum' },
  }).map((item) => {
    const row = item.product ? protocolRows?.get(String(item.product.id)) : null;
    const areaFactor = effectiveAreaFactor(row?.gates?.sunnyTurfOnly ? { ...item, sunnyTurfOnly: true } : item, {
      plan: options.plan || 'Platinum',
      weedPressure: options.weedPressure,
      conditionFlags: options.conditionFlags,
      propertyFlags: options.propertyFlags,
      includePremiumOnly: options.includePremiumOnly,
      isFirstYear: options.isFirstYear,
    });
    return {
      ...item,
      // A spot or label-rate v13 row has no area or rate to price: no amount, as in the plan.
      mix: item.product && (!row || v13RowCalculates(row)) ? calculateProductAmount({
        product: item.product,
        lawnSqft,
        carrierGalPer1000: DEFAULT_CARRIER_GAL_PER_1000,
        areaFactor,
        ...nutrientTargets,
        ...v13RateOptions(row),
      }) : null,
    };
  });

  const selectedItems = items.filter((item) => item.selected);
  const materialSummary = summarizeMaterialCost(selectedItems);
  const legacyMaterialCost = normalizedStaticMaterialCost(visit, lawnSqft);
  const variance = legacyMaterialCost == null || materialSummary.pricedLineCount === 0
    ? null
    : money(materialSummary.total - legacyMaterialCost);
  const varianceRatio = legacyMaterialCost && variance != null
    ? Math.abs(variance) / legacyMaterialCost
    : 0;

  const unmatched = items.filter((item) => !item.product && isMaterialIntentLine(item));
  // The reference matcher returns one catalog product per line. A '+' outside
  // annotations can name another material; do not certify that partial match.
  const selectedCombinedProducts = selectedItems.filter((item) => {
    if (!isMaterialIntentLine(item)) return false;
    const text = String(item.raw || '').replace(/\([^)]*\)/g, '').toLowerCase();
    const canonicalName = String(item.product?.name || '').toLowerCase();
    const productNames = [item.product?.name, ...(item.product?.aliases || [])]
      .filter((name) => name?.includes('+') && canonicalName.includes(name.toLowerCase()))
      .sort((a, b) => b.length - a.length);
    const remaining = productNames.reduce((rest, name) => rest.replace(name.toLowerCase(), ''), text);
    return /\+/.test(remaining);
  });
  const selectedMissingMaterialCost = selectedItems.filter((item) => (
    item.product
    && item.mix?.amount
    && (item.mix.materialCost == null || !Number.isFinite(Number(item.mix.materialCost))
      || Number(item.mix.materialCost) <= 0)
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
  const selectedUnverifiedUnits = selectedItems.filter((item) => {
    if (!item.mix?.amount) return false;
    // The package parser tolerates descriptors ("lb bag") that the cost
    // engine's unit converter cannot use and would price without conversion.
    if (convertToOz(1, item.mix.amountUnit) == null) return true;
    if (item.mix.materialCostSource === 'inventory_cost_per_unit'
      && convertToOz(1, item.product.cost_unit) == null) return true;
    const amountUnit = String(item.mix.amountUnit || '').replaceAll('_', ' ');
    // Only an explicit inventory dimension resolves legacy plain-ounce rates.
    const dimension = unitDefinition(item.product.inventory_unit)?.dimension;
    const unitEvidence = { isWeight: dimension === 'weight', isLiquid: dimension === 'volume' };
    const amountFamily = unitPriceBreakdown(1, `1 ${amountUnit}`, unitEvidence)?.family;
    const costQuantity = item.mix.materialCostSource === 'inventory_cost_per_unit'
      ? `1 ${item.product.cost_unit || ''}` : item.product.container_size;
    const costFamily = unitPriceBreakdown(1, String(costQuantity || '').replaceAll('_', ' '), unitEvidence)?.family;
    return !amountFamily || !costFamily || amountFamily === 'ambiguous'
      || costFamily === 'ambiguous' || amountFamily !== costFamily
      || (dimension && dimension !== 'ambiguous' && dimension !== amountFamily);
  });
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
    selectedCombinedProducts,
    selectedMissingMaterialCost,
    selectedMissingRate,
    selectedNeedsPricing,
    selectedMissingInventoryPrice,
    selectedUnverifiedUnits,
    items,
  };
}

// This is the existing exposure audit's allowance normalization, not a new
// scheduler: enhanced flags 12 windows while the sold cadence is 9 applications.
// Keep the catalog-selected subtotal separate from unselected conditional work.
function buildCadenceReport(products, lawn = lawnProtocols(), v13Rows = new Map()) {
  const rows = [];
  for (const trackKey of new Set([...Object.keys(lawn), ...Object.keys(LAWN_MATERIAL_BUDGETS)])) {
    const track = lawn[trackKey] || {};
    for (const [tier, protocolTier, applications] of [
      ['standard', 'bronze', 6], ['enhanced', 'enhanced', 9], ['premium', 'premium', 12],
    ]) {
      const visits = (track.visits || []).filter((visit) => visit.tiers?.[protocolTier]);
      // A plan of this many applications runs its own step where the recipe has one
      // (v13 April on 9x: Dimension 18-0-10, not the 24-0-11); the static allowance
      // below still reads the calendar visit.
      const results = visits.map((visit) => analyzeVisit({
        trackKey, track, visit: visitForCadence(visit, applications).visit, products, lawnSqft: MATERIAL_REFERENCE_SQFT, v13Rows,
        options: { plan: tier, includePremiumOnly: tier === 'premium', isFirstYear: true, weedPressure: 'normal' },
      }));
      const issues = results.flatMap((result) => [
        ...result.items.filter((item) => isMaterialIntentLine(item) && /\bOR\b/i.test(item.raw))
          .map((item) => ({ visit: result.visit, reason: 'unresolved_alternatives', line: item.raw })),
        ...result.unmatched.map((item) => ({ visit: result.visit, reason: 'unmatched_product', line: item.raw })),
        ...result.selectedCombinedProducts.map((item) => ({ visit: result.visit, reason: 'combined_products_unresolved', line: item.raw })),
        ...result.selectedMissingRate.map((item) => ({ visit: result.visit, reason: 'missing_rate', line: item.raw })),
        ...result.selectedMissingMaterialCost.map((item) => ({ visit: result.visit, reason: 'missing_cost', line: item.raw })),
        ...result.selectedNeedsPricing.map((item) => ({ visit: result.visit, reason: 'needs_pricing', line: item.raw })),
        ...result.selectedMissingInventoryPrice.map((item) => ({ visit: result.visit, reason: 'missing_inventory_price', line: item.raw })),
        ...result.selectedUnverifiedUnits.map((item) => ({ visit: result.visit, reason: 'unverified_cost_units', line: item.raw })),
      ]);
      if (!visits.length) issues.push({ reason: 'missing_calendar' });
      const staticComplete = visits.length > 0 && visits.every((visit) => (
        money(visit.material_cost) != null && money(visit.conditional_cost) != null
      ));
      if (!staticComplete) issues.push({ reason: 'missing_static_allowance' });
      const factor = visits.length ? applications / visits.length : 0;
      const selectedSubtotal = money(results.reduce((sum, result) => sum + result.inventoryMaterialCost, 0) * factor);
      const staticAllowance = staticComplete ? money(visits.reduce((sum, visit) => sum
        + Number(visit.material_cost) * MATERIAL_REFERENCE_SQFT / 10000
        + Number(visit.conditional_cost), 0) * factor) : null;
      const currentBudget = LAWN_MATERIAL_BUDGETS[trackKey]?.[applications] ?? null;
      if (currentBudget == null) issues.push({ reason: 'missing_budget' });
      rows.push({
        track: trackKey, tier, protocolTier, applications, flaggedCalendarSlots: visits.length,
        currentAnnualBudget: currentBudget,
        reconstructedStaticAnnualAllowance: staticAllowance,
        budgetMinusStaticAllowance: currentBudget != null && staticAllowance != null ? money(currentBudget - staticAllowance) : null,
        catalogSelectedSubtotal: selectedSubtotal,
        catalogSelectedAnnual: issues.length ? null : selectedSubtotal,
        catalogCalculationComplete: issues.length === 0,
        issues,
        visits: results,
      });
    }
  }
  return {
    referenceSqft: MATERIAL_REFERENCE_SQFT,
    budgetSource: '@waves/lawn-cost-floor repository allowances; deployed pricing overrides are not verified.',
    basis: 'Average flagged windows multiplied by sold applications; not a scheduled calendar.',
    catalogScope: 'JSON reference matched to catalog defaults, first year at normal weed pressure; unselected conditional products excluded. Does not reconcile lawn_protocol_windows/products or establish field-execution costs. Unit conversions and supplier costs still need verification.',
    operatingLayerVerified: false,
    supplierCostsVerified: false,
    rows,
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
  issueLines(results, 'selectedCombinedProducts', 'Combined product lines needing individual resolution');
  issueLines(results, 'selectedMissingRate', 'Selected lines missing rate');
  issueLines(results, 'selectedMissingMaterialCost', 'Selected lines with amount but no positive materialCost');
  issueLines(results, 'selectedNeedsPricing', 'Selected needs-pricing products');
  issueLines(results, 'selectedMissingInventoryPrice', 'Selected products missing inventory price');
  issueLines(results, 'selectedUnverifiedUnits', 'Selected products needing cost-unit verification');
}

async function main() {
  const { values } = parseArgs({ options: { cadences: { type: 'boolean' }, json: { type: 'boolean' } } });
  const products = await getProtocolProducts();
  const v13Rows = await loadV13Rows();
  if (values.cadences) {
    const report = buildCadenceReport(products, lawnProtocols(), v13Rows);
    if (values.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(report.basis);
      console.log(report.catalogScope);
      console.table(report.rows.map(({ track, applications, currentAnnualBudget, reconstructedStaticAnnualAllowance,
        catalogSelectedAnnual, issues }) => ({ track, applications, currentAnnualBudget,
        reconstructedStaticAnnualAllowance, catalogSelectedAnnual, issues: issues.length })));
    }
    if (report.rows.some((row) => !row.catalogCalculationComplete)) process.exitCode = 2;
    return;
  }
  const options = {
    plan: 'Platinum',
    includePremiumOnly: true,
    isFirstYear: true,
    weedPressure: 'normal',
  };
  const tracks = Object.entries(lawnProtocols() || {});
  const results = [];

  for (const [trackKey, track] of tracks) {
    for (const visit of track.visits || []) {
      results.push(analyzeVisit({ trackKey, track, visit, products, options, v13Rows }));
    }
  }

  if (values.json) console.log(JSON.stringify(results, null, 2));
  else printResults(results);
}

if (require.main === module) main()
  .catch((err) => {
    if (/Unable to acquire a connection/i.test(err.message || '')) {
      console.error('Unable to acquire a database connection. Set DATABASE_URL/DATABASE_PUBLIC_URL or run via the deployed environment variables.');
    }
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());

module.exports = { analyzeVisit, buildCadenceReport, loadV13Rows };
