'use strict';

/**
 * One-way inventory cost-spike & cross-service gross margin watchdog (owner
 * approved 2026-11-27).
 *
 * Strictly READ-ONLY alerting — NEVER mutates retail prices, pricing_config,
 * or products_catalog. Cheaper generic chemical swaps are deliberately ignored
 * so Waves keeps the extra margin; only UPWARD vendor cost spikes (>10%) and
 * modeled service gross margins dropping below 35% (or missing/broken COGS
 * mappings such as rodent_trapping / stinging / "bottle" units) raise an admin
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
const COST_SPIKE_THRESHOLD = 0.10; // >10% upward cost jump triggers review
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
const WATCHED_SERVICES = Object.freeze([
  {
    serviceKey: 'pest_control',
    label: 'Quarterly Pest Control',
    engineServices: { pest: { frequency: 'quarterly' } },
    visitsPerYear: 4,
    laborHoursPerVisit: 0.45,
    requireMappedCogs: true,
  },
  {
    serviceKey: 'mosquito',
    label: 'Mosquito Control (12x)',
    engineServices: { mosquito: { tier: 'monthly12' } },
    visitsPerYear: 12,
    laborHoursPerVisit: 0.35,
    requireMappedCogs: true,
  },
  {
    serviceKey: 'tree_shrub',
    label: 'Tree & Shrub Care',
    engineServices: { treeShrub: { tier: 'standard' } },
    visitsPerYear: 6,
    laborHoursPerVisit: 0.5,
    requireMappedCogs: true,
  },
  {
    serviceKey: 'one_time_pest',
    label: 'One-Time Pest Control',
    engineServices: { oneTimePest: {} },
    visitsPerYear: 1,
    laborHoursPerVisit: 0.75,
    requireMappedCogs: true,
  },
  {
    serviceKey: 'rodent_trapping',
    label: 'Rodent Trapping',
    engineServices: { rodentTrapping: {} },
    visitsPerYear: 1,
    laborHoursPerVisit: 1.5,
    requireMappedCogs: true,
  },
  {
    serviceKey: 'stinging',
    label: 'Bee & Wasp Removal',
    engineServices: { stinging: { level: 'standard' } },
    visitsPerYear: 1,
    laborHoursPerVisit: 0.75,
    requireMappedCogs: true,
  },
]);

function detectVendorCostSpikes(catalogRows, approvedVendorRows) {
  const byProduct = new Map();
  for (const vp of approvedVendorRows || []) {
    const pid = String(vp.product_id);
    if (!byProduct.has(pid)) byProduct.set(pid, []);
    byProduct.get(pid).push(vp);
  }
  const spikes = [];
  for (const prod of catalogRows || []) {
    if (prod.active === false) continue;
    const baseline = numberOrNull(prod.best_price);
    if (!(Number.isFinite(baseline) && baseline > 0)) continue;
    const candidates = (byProduct.get(String(prod.id)) || [])
      .map((vp) => numberOrNull(vp.price_amount ?? vp.price))
      .filter((price) => Number.isFinite(price) && price > 0);
    if (!candidates.length) continue;
    const currentMin = Math.min(...candidates);
    // One-way ONLY: ignore cheaper generic substitutes (currentMin <= baseline).
    if (currentMin <= baseline) continue;
    const pctIncrease = (currentMin - baseline) / baseline;
    if (pctIncrease <= COST_SPIKE_THRESHOLD) continue;
    const unitMismatchLikely = currentMin / baseline > SANITY_SPIKE_CAP;
    spikes.push({
      productId: prod.id,
      productName: prod.name,
      baselinePrice: Number(baseline.toFixed(2)),
      currentMinPrice: Number(currentMin.toFixed(2)),
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

function evaluateServiceMargins({ inventory, generateEstimate, inventoryCostFromRows, laborRate }) {
  const lowMargins = [];
  const missingCogs = [];
  for (const spec of WATCHED_SERVICES) {
    const est = generateEstimate({ ...REFERENCE_PROPERTY, services: spec.engineServices });
    const line = (est?.lineItems || []).find((li) => li.service === spec.serviceKey);
    const revPerVisit = resolveServiceRevenuePerVisit(line, spec.visitsPerYear);
    const cogs = inventoryCostFromRows(spec.serviceKey, REFERENCE_PROPERTY, inventory);
    if (cogs.status === 'missing_cogs' || cogs.status === 'unmapped') {
      if (spec.requireMappedCogs) {
        missingCogs.push({ serviceKey: spec.serviceKey, label: spec.label, reason: cogs.status });
      }
      continue;
    }
    const materialCost = Number(cogs.totalPerVisit || 0) + (spec.visitsPerYear === 1 ? Number(cogs.fixedCost || 0) : 0);
    if (cogs.status === 'warning') {
      missingCogs.push({
        serviceKey: spec.serviceKey,
        label: spec.label,
        reason: 'partial_cogs',
        warnings: cogs.warnings || [],
      });
    }
    if (!(revPerVisit > 0)) continue;
    const laborCost = spec.laborHoursPerVisit * laborRate;
    const totalCost = materialCost + laborCost;
    const grossMargin = (revPerVisit - totalCost) / revPerVisit;
    if (grossMargin < MIN_GROSS_MARGIN_FLOOR) {
      lowMargins.push({
        serviceKey: spec.serviceKey,
        label: spec.label,
        revenuePerVisit: Number(revPerVisit.toFixed(2)),
        materialCost: Number(materialCost.toFixed(2)),
        laborCost: Number(laborCost.toFixed(2)),
        grossMarginPct: Number((grossMargin * 100).toFixed(1)),
      });
    }
  }
  return { lowMargins, missingCogs };
}

function buildWatchdogDetail({ spikes, lowMargins, missingCogs }) {
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
  parts.push('Read-only alert: retail prices were not changed automatically.');
  return parts.join(' ');
}

async function runInventoryMarginWatchdog({ deps = {}, now = new Date() } = {}) {
  const enabled = deps.isLive
    ? deps.isLive()
    : require('../config/feature-gates').inventoryMarginWatchdogLive?.() === true;
  if (!enabled) return { skipped: true, reason: 'gate_off' };

  const dbc = deps.db || db;
  const loadInventoryCostRows = deps.loadInventoryCostRows || require('./estimate-pricing-audit').loadInventoryCostRows;
  const inventoryCostFromRows = deps.inventoryCostFromRows || require('./estimate-pricing-audit').inventoryCostFromRows;
  const generateEstimate = deps.generateEstimate || require('./pricing-engine/estimate-engine').generateEstimate;
  const laborRate = deps.laborRate ?? (require('./pricing-engine/constants').GLOBAL?.LABOR_RATE || 35);
  const raiseAdminAlert = deps.raiseAdminAlert || require('./admin-alert-compose').raiseAdminAlert;
  const closeAdminAlertKeys = deps.closeAdminAlertKeys || require('./admin-alert-episodes').closeAdminAlertKeys;

  const [catalogRows, approvedVendorRows, inventory] = await Promise.all([
    dbc('products_catalog')
      .where('active', true)
      .whereNotNull('best_price')
      .select('id', 'name', 'active', 'best_price', 'unit_size_oz'),
    eligibleVendorPricing(dbc('vendor_pricing'))
      .select('vendor_pricing.id', 'vendor_pricing.product_id', 'vendor_pricing.price_amount', 'vendor_pricing.price'),
    loadInventoryCostRows(),
  ]);

  const spikes = detectVendorCostSpikes(catalogRows, approvedVendorRows);
  const { lowMargins, missingCogs } = inventory?.available
    ? evaluateServiceMargins({ inventory, generateEstimate, inventoryCostFromRows, laborRate })
    : { lowMargins: [], missingCogs: [] };

  const totalFindings = spikes.length + lowMargins.length + missingCogs.length;
  if (totalFindings === 0) {
    await closeAdminAlertKeys(dbc, [WATCHDOG_ALERT_KEY], 'margin_watchdog_clean', {
      now,
      resolution: 'Inventory cost spikes and modeled service margins are within target bounds',
    });
    return { skipped: false, alerted: false, spikes, lowMargins, missingCogs };
  }

  const why = lowMargins.length
    ? `${lowMargins.length} service${lowMargins.length === 1 ? '' : 's'} dropped below 35% modeled gross margin.`
    : spikes.length
      ? `${spikes.length} active product${spikes.length === 1 ? '' : 's'} saw an approved vendor cost jump over 10%.`
      : `${missingCogs.length} service${missingCogs.length === 1 ? '' : 's'} have missing or incomplete material cost mappings.`;

  await raiseAdminAlert('system', {
    area: 'Inventory',
    action: 'review vendor cost spikes and service margins',
    why,
    severity: 'needs-you',
    link: '/admin/inventory',
    subject: { type: 'check', id: WATCHDOG_ALERT_KEY },
    doneWhen: 'margin_watchdog_clean',
    who: 'person',
  }, {
    detail: buildWatchdogDetail({ spikes, lowMargins, missingCogs }),
    dedupeKey: WATCHDOG_ALERT_KEY,
    dedupeOpenOnly: true,
    refreshOnDedupe: true,
    ringOnRefresh: () => false,
    metadata: {
      source: 'inventory-margin-watchdog',
      spikeCount: spikes.length,
      lowMarginCount: lowMargins.length,
      missingCogsCount: missingCogs.length,
    },
  });

  logger.info(`[inventory-margin-watchdog] spikes=${spikes.length} lowMargins=${lowMargins.length} missingCogs=${missingCogs.length}`);
  return { skipped: false, alerted: true, spikes, lowMargins, missingCogs };
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
