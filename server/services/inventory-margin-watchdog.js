'use strict';

/**
 * One-way inventory cost-spike & cross-service gross margin watchdog (owner
 * approved 2026-11-27).
 *
 * Strictly READ-ONLY alerting — NEVER mutates retail prices, pricing_config,
 * or products_catalog. Cheaper generic chemical swaps are deliberately ignored
 * so Waves keeps the extra margin; only UPWARD normalized vendor cost spikes
 * (>10% vs prior normalized price for the winning vendor) and modeled service
 * gross margins dropping below 35% (or missing/broken COGS mappings, missing
 * revenue, pricing sync failures, or unavailable inventory) raise an admin
 * notification.
 *
 * Complements `lawn-pricing-invariant-sweep.js` (which owns the Lawn Care
 * bracket ladder) by covering active catalog vendor spikes and non-lawn service
 * margins across Pest Control, Mosquito, Tree & Shrub, One-Time Pest, Rodent
 * Trapping, Stinging Insect, Termite Trenching, and Bora-Care.
 *
 * Dark behind `GATE_INVENTORY_MARGIN_WATCHDOG=true` (strict `=== 'true'`, read
 * at call time via `inventoryMarginWatchdogLive()`).
 */

const db = require('../models/db');
const logger = require('./logger');
const { numberOrNull } = require('./product-costing');
const { eligibleVendorPricing } = require('./vendor-pricing-eligibility');

const WATCHDOG_ALERT_KEY = 'inventory-margin-watchdog:daily';
const COST_SPIKE_THRESHOLD = 0.10; // >10% upward normalized cost jump triggers review
const MIN_GROSS_MARGIN_FLOOR = 0.35; // <35% modeled gross margin triggers review
const SANITY_SPIKE_CAP = 5.0; // >5x is likely a pack-unit mismatch, flagged separately

const REFERENCE_PROPERTY = Object.freeze({
  homeSqFt: 2000,
  lotSqFt: 8000,
  stories: 1,
  propertyType: 'Single Family',
  bedArea: 1200,
});

// Services checked against live bottom-up inventory COGS + labor at reference scope.
// engineServiceKey matches the pricing engine's emitted lineItem.service;
// inventoryServiceKey matches estimate-pricing-audit SERVICE_MAP / service_product_usage.
const WATCHED_SERVICES = Object.freeze([
  {
    engineServiceKey: 'pest_control',
    inventoryServiceKey: 'pest_control',
    label: 'Quarterly Pest Control',
    engineServices: { pest: { frequency: 'quarterly' } },
    visitsPerYear: 4,
    laborHoursPerVisit: 0.45,
    requireMappedCogs: true,
  },
  {
    engineServiceKey: 'mosquito',
    inventoryServiceKey: 'mosquito',
    serviceTypesOverride: ['Mosquito Treatment - Essential Barrier', 'Mosquito Treatment - IGR'],
    label: 'Mosquito Control (12x)',
    engineServices: { mosquito: { tier: 'monthly12' } },
    visitsPerYear: 12,
    laborHoursPerVisit: 0.35,
    requireMappedCogs: true,
  },
  {
    engineServiceKey: 'tree_shrub',
    inventoryServiceKey: 'tree_shrub',
    label: 'Tree & Shrub Care',
    engineServices: { treeShrub: { tier: 'standard' } },
    visitsPerYear: 6,
    laborHoursPerVisit: 0.5,
    requireMappedCogs: true,
  },
  {
    engineServiceKey: 'one_time_pest',
    inventoryServiceKey: 'one_time_pest',
    label: 'One-Time Pest Control',
    engineServices: { oneTimePest: {} },
    visitsPerYear: 1,
    laborHoursPerVisit: 0.75,
    requireMappedCogs: true,
  },
  {
    engineServiceKey: 'rodent_trapping',
    inventoryServiceKey: 'rodent_trapping',
    label: 'Rodent Trapping',
    engineServices: { rodentTrapping: {} },
    visitsPerYear: 1,
    laborHoursPerVisit: 1.5,
    requireMappedCogs: true,
  },
  {
    engineServiceKey: 'stinging_insect',
    inventoryServiceKey: 'stinging',
    label: 'Bee & Wasp Removal',
    engineServices: { stinging: { species: 'PAPER_WASP', tier: 2, removal: 'NONE' } },
    visitsPerYear: 1,
    laborHoursPerVisit: 0.75,
    requireMappedCogs: true,
  },
  {
    engineServiceKey: 'trenching',
    inventoryServiceKey: 'trenching',
    label: 'Termite Trenching',
    engineServices: { trenching: { perimeterLF: 200 } },
    visitsPerYear: 1,
    laborHoursPerVisit: 4.0,
    requireMappedCogs: true,
  },
  {
    engineServiceKey: 'bora_care',
    inventoryServiceKey: 'bora_care',
    costingProperty: { ...REFERENCE_PROPERTY, homeSqFt: 1500 },
    label: 'Bora-Care Wood Treatment',
    engineServices: { boraCare: { atticSqFt: 1500 } },
    visitsPerYear: 1,
    laborHoursPerVisit: 3.0,
    requireMappedCogs: true,
  },
]);

function normalizedCostBasis(scoredEntry, mode) {
  if (!scoredEntry) return null;
  if (mode === 'oz' && Number.isFinite(scoredEntry.perOz) && scoredEntry.perOz > 0) return scoredEntry.perOz;
  if (mode === 'count' && Number.isFinite(scoredEntry.perUnit) && scoredEntry.perUnit > 0) return scoredEntry.perUnit;
  return Number.isFinite(scoredEntry.price) && scoredEntry.price > 0 ? scoredEntry.price : null;
}

function normalizedHistoryRowCost(prod, row, mode, scoreVendorRows) {
  const hPrice = numberOrNull(row?.price);
  if (!(Number.isFinite(hPrice) && hPrice > 0)) return null;
  // Require each historical entry's own package quantity (never reuse the current
  // package size on an older price, which would distort unit costs on pack changes).
  if (mode !== 'raw' && !String(row?.quantity || '').trim()) return null;
  const scored = scoreVendorRows([{ price_amount: hPrice, price: hPrice, quantity: row.quantity }], prod);
  if (scored.mode !== mode) return null;
  return normalizedCostBasis(scored.pool[0], mode);
}

function priorNormalizedCostForProduct(prod, winner, mode, historyRows, scoreVendorRows) {
  const currentCost = normalizedCostBasis(winner, mode);
  if (!(currentCost > 0)) return null;
  // Compare against the previous catalog-wide normalized price across ALL vendors
  // in price_history (newest-first), so both a winning vendor's own increase AND
  // a cheaper vendor expiring (promoting a pricier backup vendor) are detected.
  let bestPrior = null;
  for (const h of historyRows || []) {
    const hCost = normalizedHistoryRowCost(prod, h, mode, scoreVendorRows);
    if (!(hCost > 0)) continue;
    // Skip rows recording the current winning price itself.
    if (Math.abs(hCost - currentCost) / currentCost < 1e-6) continue;
    if (bestPrior == null || hCost < bestPrior) bestPrior = hCost;
  }
  return bestPrior;
}

function detectVendorCostSpikes(catalogRows, approvedVendorRows, priceHistoryRows = [], { scoreVendorRows } = {}) {
  const scorer = scoreVendorRows || require('../routes/admin-inventory').scoreVendorRows;
  const vpByProduct = new Map();
  for (const vp of approvedVendorRows || []) {
    const pid = String(vp.product_id);
    if (!vpByProduct.has(pid)) vpByProduct.set(pid, []);
    vpByProduct.get(pid).push(vp);
  }
  const histByProduct = new Map();
  for (const h of priceHistoryRows || []) {
    const pid = String(h.product_id);
    if (!histByProduct.has(pid)) histByProduct.set(pid, []);
    histByProduct.get(pid).push(h);
  }
  const spikes = [];
  for (const prod of catalogRows || []) {
    if (prod.active === false) continue;
    const candidates = vpByProduct.get(String(prod.id)) || [];
    if (!candidates.length) continue;
    const { mode, pool } = scorer(candidates, prod);
    const winner = pool[0];
    const currentNorm = normalizedCostBasis(winner, mode);
    if (!(currentNorm > 0)) continue;
    const priorNorm = priorNormalizedCostForProduct(prod, winner, mode, histByProduct.get(String(prod.id)), scorer);
    // One-way ONLY: ignore missing history and ignore cheaper generic substitutes (current <= prior).
    if (!(priorNorm > 0) || currentNorm <= priorNorm) continue;
    const pctIncrease = (currentNorm - priorNorm) / priorNorm;
    if (pctIncrease <= COST_SPIKE_THRESHOLD) continue;
    const unitMismatchLikely = currentNorm / priorNorm > SANITY_SPIKE_CAP;
    spikes.push({
      productId: prod.id,
      productName: prod.name,
      basis: mode,
      priorNormalizedCost: Number(priorNorm.toFixed(4)),
      currentNormalizedCost: Number(currentNorm.toFixed(4)),
      pctIncrease: Number((pctIncrease * 100).toFixed(1)),
      unitMismatchLikely,
    });
  }
  return spikes;
}

function resolveServiceRevenuePerVisit(line, visitsPerYear) {
  if (!line) return null;
  if (visitsPerYear > 1) {
    const perVisit = numberOrNull(line.perVisit ?? line.perApp);
    if (perVisit > 0) return perVisit;
    const annual = numberOrNull(line.annual ?? line.annualAfterDiscount);
    if (annual > 0) return annual / visitsPerYear;
    const monthly = numberOrNull(line.monthly ?? line.mo);
    if (monthly > 0) return (monthly * 12) / visitsPerYear;
    return null;
  }
  const oneTime = numberOrNull(line.price ?? line.total ?? line.basePrice);
  return oneTime > 0 ? oneTime : null;
}

function evaluateOneServiceMargin(spec, { inventory, generateEstimate, inventoryCostFromRows, laborRate }) {
  const est = generateEstimate({ ...REFERENCE_PROPERTY, services: spec.engineServices });
  const line = (est?.lineItems || []).find((li) => li.service === spec.engineServiceKey);
  const revPerVisit = resolveServiceRevenuePerVisit(line, spec.visitsPerYear);
  const cogs = inventoryCostFromRows(
    spec.inventoryServiceKey,
    spec.costingProperty || REFERENCE_PROPERTY,
    inventory,
    spec.serviceTypesOverride || null,
  );
  const out = { lowMargin: null, missingCogs: null, incomplete: null };
  if (!(revPerVisit > 0)) {
    out.incomplete = { check: 'missing_revenue', serviceKey: spec.engineServiceKey, label: spec.label };
  }
  if (cogs.status === 'missing_cogs' || cogs.status === 'unmapped') {
    if (spec.requireMappedCogs) {
      out.missingCogs = { serviceKey: spec.inventoryServiceKey, label: spec.label, reason: cogs.status };
    }
    return out;
  }
  if (cogs.status === 'warning') {
    out.missingCogs = {
      serviceKey: spec.inventoryServiceKey,
      label: spec.label,
      reason: 'partial_cogs',
      warnings: cogs.warnings || [],
    };
  }
  if (!(revPerVisit > 0)) return out;
  const fixedAmortized = Number(cogs.fixedCost || 0) / Math.max(1, spec.visitsPerYear);
  const materialCost = Number(cogs.totalPerVisit || 0) + fixedAmortized;
  const laborCost = spec.laborHoursPerVisit * laborRate;
  const grossMargin = (revPerVisit - (materialCost + laborCost)) / revPerVisit;
  if (grossMargin < MIN_GROSS_MARGIN_FLOOR) {
    out.lowMargin = {
      serviceKey: spec.engineServiceKey,
      label: spec.label,
      revenuePerVisit: Number(revPerVisit.toFixed(2)),
      materialCost: Number(materialCost.toFixed(2)),
      laborCost: Number(laborCost.toFixed(2)),
      grossMarginPct: Number((grossMargin * 100).toFixed(1)),
    };
  }
  return out;
}

function evaluateServiceMargins({ inventory, generateEstimate, inventoryCostFromRows, laborRate }) {
  const lowMargins = [];
  const missingCogs = [];
  const incompleteChecks = [];
  for (const spec of WATCHED_SERVICES) {
    const res = evaluateOneServiceMargin(spec, { inventory, generateEstimate, inventoryCostFromRows, laborRate });
    if (res.lowMargin) lowMargins.push(res.lowMargin);
    if (res.missingCogs) missingCogs.push(res.missingCogs);
    if (res.incomplete) incompleteChecks.push(res.incomplete);
  }
  return { lowMargins, missingCogs, incompleteChecks };
}

function buildWatchdogDetail({ spikes, lowMargins, missingCogs, incompleteChecks = [] }) {
  const parts = [];
  if (spikes.length) {
    const top = spikes.slice(0, 3).map((s) => `${s.productName} (+${s.pctIncrease}%)`).join(', ');
    parts.push(`Vendor cost spikes over 10%: ${top}${spikes.length > 3 ? ` (+${spikes.length - 3} more)` : ''}.`);
  }
  if (lowMargins.length) {
    const top = lowMargins.slice(0, 3).map((m) => `${m.label} (${m.grossMarginPct}% GM)`).join(', ');
    parts.push(`Modeled gross margin below 35%: ${top}.`);
  }
  if (missingCogs.length) {
    const top = missingCogs.slice(0, 4).map((m) => m.label).join(', ');
    parts.push(`Missing or incomplete material COGS mappings: ${top}.`);
  }
  if (incompleteChecks.length) {
    const top = incompleteChecks.slice(0, 3).map((c) => c.label || c.check).join(', ');
    parts.push(`Incomplete margin checks (alert kept open): ${top}.`);
  }
  parts.push('Read-only alert: retail prices were not changed automatically.');
  return parts.join(' ');
}

function defaultWatchdogDeps(overrides = {}) {
  return {
    isLive: () => require('../config/feature-gates').inventoryMarginWatchdogLive?.() === true,
    db,
    syncConstantsFromDB: (...a) => require('./pricing-engine').syncConstantsFromDB(...a),
    scoreVendorRows: (...a) => require('../routes/admin-inventory').scoreVendorRows(...a),
    loadInventoryCostRows: (...a) => require('./estimate-pricing-audit').loadInventoryCostRows(...a),
    inventoryCostFromRows: (...a) => require('./estimate-pricing-audit').inventoryCostFromRows(...a),
    generateEstimate: (...a) => require('./pricing-engine/estimate-engine').generateEstimate(...a),
    getLaborRate: () => require('./pricing-engine/constants').GLOBAL?.LABOR_RATE || 35,
    raiseAdminAlert: (...a) => require('./admin-alert-compose').raiseAdminAlert(...a),
    closeAdminAlertKeys: (...a) => require('./admin-alert-episodes').closeAdminAlertKeys(...a),
    ...overrides,
  };
}

function buildWatchdogWhy({ spikes, lowMargins, missingCogs, incompleteChecks = [] }) {
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (lowMargins.length) return `${plural(lowMargins.length, 'service')} dropped below 35% modeled gross margin.`;
  if (spikes.length) return `${plural(spikes.length, 'active product')} saw an approved vendor cost jump over 10%.`;
  if (missingCogs.length) return `${plural(missingCogs.length, 'service')} have missing or incomplete material cost mappings.`;
  return `${plural(incompleteChecks.length, 'margin check')} could not be verified.`;
}

async function loadWatchdogInputs(deps) {
  const hasPriceHistory = typeof deps.db?.schema?.hasTable === 'function'
    ? await deps.db.schema.hasTable('price_history')
    : true;
  const [catalogRows, approvedVendorRows, priceHistoryRows, inventory] = await Promise.all([
    deps.db('products_catalog')
      .where('active', true)
      .whereNotNull('best_price')
      .select('id', 'name', 'active', 'best_price', 'unit_size_oz', 'container_size', 'cost_unit'),
    eligibleVendorPricing(deps.db('vendor_pricing'))
      .select('vendor_pricing.*'),
    hasPriceHistory
      ? deps.db('price_history')
        .orderBy('recorded_at', 'desc')
        .select('product_id', 'vendor_id', 'price', 'quantity', 'recorded_at')
      : Promise.resolve([]),
    deps.loadInventoryCostRows(),
  ]);
  return { catalogRows, approvedVendorRows, priceHistoryRows, inventory };
}

async function runMarginVerification(deps, inventory) {
  let syncOk = false;
  try {
    syncOk = Boolean(await deps.syncConstantsFromDB(deps.db));
  } catch (err) {
    logger.warn(`[inventory-margin-watchdog] pricing sync failed: ${err?.code || err?.name || 'error'}`);
  }
  if (!syncOk) {
    return {
      lowMargins: [],
      missingCogs: [],
      incompleteChecks: [{ check: 'config_sync_failed', label: 'pricing_config sync' }],
    };
  }
  if (!inventory?.available) {
    return {
      lowMargins: [],
      missingCogs: [],
      incompleteChecks: [{ check: 'inventory_unavailable', label: 'inventory COGS table' }],
    };
  }
  const laborRate = typeof deps.laborRate === 'number' ? deps.laborRate : deps.getLaborRate();
  return evaluateServiceMargins({
    inventory,
    generateEstimate: deps.generateEstimate,
    inventoryCostFromRows: deps.inventoryCostFromRows,
    laborRate,
  });
}

async function runInventoryMarginWatchdog({ deps: overrides = {}, now = new Date() } = {}) {
  const deps = defaultWatchdogDeps(overrides);
  if (!deps.isLive()) return { skipped: true, reason: 'gate_off' };

  const { catalogRows, approvedVendorRows, priceHistoryRows, inventory } = await loadWatchdogInputs(deps);
  const spikes = detectVendorCostSpikes(catalogRows, approvedVendorRows, priceHistoryRows, {
    scoreVendorRows: deps.scoreVendorRows,
  });
  const { lowMargins, missingCogs, incompleteChecks } = await runMarginVerification(deps, inventory);

  const totalFindings = spikes.length + lowMargins.length + missingCogs.length + incompleteChecks.length;
  if (totalFindings === 0) {
    await deps.closeAdminAlertKeys(deps.db, [WATCHDOG_ALERT_KEY], 'margin_watchdog_clean', {
      now,
      resolution: 'Inventory cost spikes and modeled service margins are within target bounds',
    });
    return { skipped: false, alerted: false, spikes, lowMargins, missingCogs, incompleteChecks };
  }

  const receipt = await deps.raiseAdminAlert('system', {
    area: 'Inventory',
    action: 'review vendor cost spikes and service margins',
    why: buildWatchdogWhy({ spikes, lowMargins, missingCogs, incompleteChecks }),
    severity: 'needs-you',
    link: '/admin/inventory',
    subject: { type: 'check', id: WATCHDOG_ALERT_KEY },
    doneWhen: 'margin_watchdog_clean',
    who: 'person',
  }, {
    detail: buildWatchdogDetail({ spikes, lowMargins, missingCogs, incompleteChecks }),
    dedupeKey: WATCHDOG_ALERT_KEY,
    dedupeOpenOnly: true,
    refreshOnDedupe: true,
    ringOnRefresh: () => false,
    metadata: {
      source: 'inventory-margin-watchdog',
      spikeCount: spikes.length,
      lowMarginCount: lowMargins.length,
      missingCogsCount: missingCogs.length,
      incompleteCheckCount: incompleteChecks.length,
    },
  });
  if (!receipt) {
    throw Object.assign(new Error('inventory margin watchdog alert did not persist'), { code: 'WATCHDOG_ALERT_FAILED' });
  }

  logger.info(`[inventory-margin-watchdog] spikes=${spikes.length} lowMargins=${lowMargins.length} missingCogs=${missingCogs.length} incomplete=${incompleteChecks.length}`);
  return { skipped: false, alerted: true, spikes, lowMargins, missingCogs, incompleteChecks };
}

module.exports = {
  WATCHDOG_ALERT_KEY,
  COST_SPIKE_THRESHOLD,
  MIN_GROSS_MARGIN_FLOOR,
  WATCHED_SERVICES,
  detectVendorCostSpikes,
  evaluateServiceMargins,
  buildWatchdogDetail,
  runInventoryMarginWatchdog,
};
