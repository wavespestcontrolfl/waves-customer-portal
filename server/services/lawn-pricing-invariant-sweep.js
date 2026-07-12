// ============================================================
// lawn-pricing-invariant-sweep.js — weekly lawn ladder health check
//
// Re-runs the pricing engine across the full track × size × tier grid against
// LIVE DB-synced config and checks the invariants that must hold for the sold
// ladder to be coherent:
//   HARD (always on):
//     - all three sold cadences (6/9/12) present and priced
//     - monthly never below the program minimum
//     - monthly never decreases with more visits
//     - monthly never decreases with lawn size (small tolerance for the
//       known ceil-to-per-app rounding artifact)
//     - material budgets not stale-low vs live inventory COGS
//   SHAPE (opt-in via LAWN_SWEEP_SHAPE_CHECKS=true):
//     - per-application price never increases with more visits
//   The shape check FAILS on today's config by design — the market bracket
//   table prices 12-app above 9-app per-app across most real lawn sizes.
//   Repricing that ladder is an owner decision (Phase 2 of the lawn pricing
//   plan); flip the env var on once the unified formula ships.
//
// Green = resolves any open alert and stays silent. Red = one admin_alerts
// row (dashboard bell) naming the failing cells. Read-only otherwise.
// ============================================================
const db = require('../models/db');
const logger = require('./logger');

const TRACKS = ['st_augustine', 'bermuda', 'zoysia', 'bahia'];
const SOLD_VISITS = [6, 9, 12];
const GRID_MIN_SQFT = 2000;
const GRID_MAX_SQFT = 22000;
const GRID_STEP_SQFT = 500;
// Ceil(annual/visits)*visits re-rounding can move monthly by cents between
// adjacent sizes; anything larger than this is real drift.
const SIZE_MONOTONE_TOLERANCE = 0.30;
// Live per-visit COGS may exceed the hardcoded budget by this ratio before we
// call the budget stale-low (margin erosion signal).
const BUDGET_DRIFT_RATIO = 1.15;

const ALERT_TYPE = 'lawn_pricing_invariant_sweep';
const ALERT_DEDUPE_KEY = 'lawn_pricing_invariant_sweep';

function cellLabel(track, sqft, visits) {
  return `${track} ${sqft.toLocaleString()}sf ${visits}x`;
}

// Grid the LIVE engine and collect invariant violations.
function scanLadderGrid() {
  const { priceLawnCare } = require('./pricing-engine/service-pricing');
  const { LAWN_PRICING_V2 } = require('./pricing-engine/constants');
  const programMinimumMonthly = Number(LAWN_PRICING_V2.programMinimumMonthly) || 0;
  const shapeChecks = process.env.LAWN_SWEEP_SHAPE_CHECKS === 'true';

  const violations = [];
  let cellsChecked = 0;

  for (const track of TRACKS) {
    const prevMonthlyBySizeTier = {};
    for (let sqft = GRID_MIN_SQFT; sqft <= GRID_MAX_SQFT; sqft += GRID_STEP_SQFT) {
      // Track rides the OPTIONS arg — priceLawnCare ignores property.grassType,
      // so passing it there silently sweeps st_augustine four times.
      const result = priceLawnCare({ lawnSqFt: sqft }, { track });
      const tiers = (result.tiers || [])
        .filter((t) => SOLD_VISITS.includes(t.visits))
        .sort((a, b) => a.visits - b.visits);

      if (tiers.length !== SOLD_VISITS.length) {
        violations.push({
          check: 'missing_tier',
          cell: cellLabel(track, sqft, 0),
          detail: `expected ${SOLD_VISITS.length} sold cadences, engine returned ${tiers.length}`,
        });
        continue;
      }

      for (let i = 0; i < tiers.length; i++) {
        const t = tiers[i];
        cellsChecked++;
        if (programMinimumMonthly > 0 && t.monthly < programMinimumMonthly - 1e-9) {
          violations.push({
            check: 'below_program_minimum',
            cell: cellLabel(track, sqft, t.visits),
            detail: `monthly $${t.monthly} < program minimum $${programMinimumMonthly}`,
          });
        }
        if (i > 0) {
          const prev = tiers[i - 1];
          if (t.monthly < prev.monthly - 1e-9) {
            violations.push({
              check: 'monthly_visits_inversion',
              cell: cellLabel(track, sqft, t.visits),
              detail: `monthly $${t.monthly} at ${t.visits}x < $${prev.monthly} at ${prev.visits}x`,
            });
          }
          if (shapeChecks && t.perApp > prev.perApp + 1e-9) {
            violations.push({
              check: 'per_app_visits_inversion',
              cell: cellLabel(track, sqft, t.visits),
              detail: `perApp $${t.perApp} at ${t.visits}x > $${prev.perApp} at ${prev.visits}x`,
            });
          }
        }
        const prevSize = prevMonthlyBySizeTier[t.visits];
        if (prevSize !== undefined && t.monthly < prevSize.monthly - SIZE_MONOTONE_TOLERANCE) {
          violations.push({
            check: 'monthly_size_inversion',
            cell: cellLabel(track, sqft, t.visits),
            detail: `monthly $${t.monthly} at ${sqft}sf < $${prevSize.monthly} at ${prevSize.sqft}sf`,
          });
        }
        prevMonthlyBySizeTier[t.visits] = { sqft, monthly: t.monthly };
      }
    }
  }

  return { violations, cellsChecked, shapeChecks };
}

// Compare the hardcoded annual material budgets against live bottom-up
// inventory COGS (service_product_usage × products_catalog) at the reference
// sqft. Only the stale-LOW direction alerts — a budget below real material
// cost silently erodes the cost floor's margin guarantee.
//
// The mapped Lawn Care rows include annual/conditional products (Prodiamine
// runs fall/winter, Celsius maxes 3x/yr), so summing them and multiplying by
// visits would count seasonal products at every visit and massively overstate
// live annual COGS. usage rows carry no per-product application frequency, so
// the honest comparable is the LOWER BOUND: the full mapped rotation applied
// once per year. If even that exceeds the budget by the drift ratio, the
// budget is stale-low regardless of real application frequencies.
async function checkBudgetDrift() {
  const { loadInventoryCostRows, inventoryCostFromRows } = require('./estimate-pricing-audit');
  const { lawnMaterialBudget, MATERIAL_REFERENCE_SQFT } = require('@waves/lawn-cost-floor');

  const inventory = await loadInventoryCostRows();
  if (!inventory.available) {
    return { status: 'skipped', reason: 'inventory COGS tables unavailable', violations: [] };
  }
  const cogs = inventoryCostFromRows('lawn_care', { lawnSqFt: MATERIAL_REFERENCE_SQFT }, inventory);
  if (cogs.status === 'missing_cogs' || !Number(cogs.totalPerVisit)) {
    return { status: 'skipped', reason: 'no live COGS rows mapped for Lawn Care', violations: [] };
  }
  const annualLowerBound = Math.round(Number(cogs.totalPerVisit) * 100) / 100;

  const violations = [];
  for (const visits of SOLD_VISITS) {
    for (const track of TRACKS) {
      const budget = lawnMaterialBudget(track, visits);
      if (annualLowerBound > budget * BUDGET_DRIFT_RATIO) {
        violations.push({
          check: 'material_budget_stale_low',
          cell: `${track} ${visits}x @ ${MATERIAL_REFERENCE_SQFT.toLocaleString()}sf`,
          detail: `one full product rotation costs $${annualLowerBound} live (annual lower bound) vs hardcoded budget $${budget}/yr — over by >${Math.round((BUDGET_DRIFT_RATIO - 1) * 100)}%`,
        });
      }
    }
  }
  return {
    status: 'ok',
    liveAnnualLowerBound: annualLowerBound,
    cogsWarnings: cogs.warnings || [],
    violations,
  };
}

async function upsertSweepAlert(violations, metadata) {
  if (!(await db.schema.hasTable('admin_alerts'))) return null;
  const now = new Date();

  if (!violations.length) {
    const resolved = await db('admin_alerts')
      .where({ type: ALERT_TYPE, status: 'open' })
      .update({
        status: 'resolved',
        resolved_at: now,
        last_seen_at: now,
        description: 'Resolved: weekly sweep found no lawn pricing invariant violations.',
        metadata: JSON.stringify(metadata),
        updated_at: now,
      });
    return resolved ? { resolved: true, count: resolved } : null;
  }

  const first = violations[0];
  const byCheck = violations.reduce((acc, v) => {
    acc[v.check] = (acc[v.check] || 0) + 1;
    return acc;
  }, {});
  const payload = {
    dedupe_key: ALERT_DEDUPE_KEY,
    type: ALERT_TYPE,
    status: 'open',
    severity: violations.some((v) => ['below_program_minimum', 'material_budget_stale_low', 'config_sync_failed'].includes(v.check))
      ? 'critical'
      : 'high',
    source_record_type: 'lawn_pricing_invariant_sweep',
    // NOT NULL column; the sweep is a singleton so the dedupe key doubles as
    // the record id.
    source_record_id: ALERT_DEDUPE_KEY,
    title: `Lawn pricing sweep: ${violations.length} invariant violation${violations.length === 1 ? '' : 's'}`,
    description: `First failing cell: ${first.cell} — ${first.detail}. Counts by check: ${Object.entries(byCheck).map(([k, n]) => `${k}=${n}`).join(', ')}.`,
    href: '/admin/pricing-logic',
    detected_at: now,
    last_seen_at: now,
    created_by_rule: 'lawn_pricing_invariant_sweep_weekly',
    metadata: JSON.stringify(metadata),
    updated_at: now,
  };
  const [alert] = await db('admin_alerts')
    .insert(payload)
    .onConflict('dedupe_key')
    .merge({ ...payload, updated_at: now })
    .returning('id');
  return { alertId: alert?.id ?? alert, violations: violations.length };
}

async function runLawnPricingInvariantSweep() {
  // Sweep the LIVE ladder — DB config over code defaults. If the sync fails
  // (throws OR returns false on parse/validation failure), the sweep must not
  // scan code defaults and vouch for a ladder it never saw: a clean default
  // grid would RESOLVE an open alert while live config is malformed. Config
  // failure is itself a red result.
  let syncError = null;
  try {
    const engine = require('./pricing-engine');
    const synced = await engine.syncConstantsFromDB();
    if (!synced) syncError = 'syncConstantsFromDB returned false (missing/empty/invalid pricing_config)';
  } catch (err) {
    syncError = err.message;
  }
  if (syncError) {
    logger.error(`[lawn-pricing-sweep] constants sync failed, sweep cannot vouch for the live ladder: ${syncError}`);
    const violations = [{
      check: 'config_sync_failed',
      cell: 'pricing_config',
      detail: `live pricing config failed to load: ${syncError}`,
    }];
    const metadata = {
      cellsChecked: 0,
      budgetCheck: 'skipped',
      budgetCheckReason: 'config sync failed',
      violationCount: violations.length,
      violationSample: violations,
      ranAt: new Date().toISOString(),
    };
    let alertResult = null;
    try {
      alertResult = await upsertSweepAlert(violations, metadata);
    } catch (err) {
      logger.error(`[lawn-pricing-sweep] alert upsert failed: ${err.message}`);
    }
    return { cellsChecked: 0, violations: violations.length, budgetCheck: 'skipped', alert: alertResult, violationDetails: violations };
  }

  const ladder = scanLadderGrid();
  let budget;
  try {
    budget = await checkBudgetDrift();
  } catch (err) {
    logger.warn(`[lawn-pricing-sweep] budget drift check failed: ${err.message}`);
    budget = { status: 'error', reason: err.message, violations: [] };
  }
  const violations = [...ladder.violations, ...budget.violations];

  const metadata = {
    cellsChecked: ladder.cellsChecked,
    shapeChecks: ladder.shapeChecks,
    budgetCheck: budget.status,
    budgetCheckReason: budget.reason || null,
    liveMaterialAnnualLowerBound: budget.liveAnnualLowerBound ?? null,
    violationCount: violations.length,
    violationSample: violations.slice(0, 20),
    ranAt: new Date().toISOString(),
  };

  let alertResult = null;
  try {
    alertResult = await upsertSweepAlert(violations, metadata);
  } catch (err) {
    logger.error(`[lawn-pricing-sweep] alert upsert failed: ${err.message}`);
  }
  const summary = {
    cellsChecked: ladder.cellsChecked,
    violations: violations.length,
    budgetCheck: budget.status,
    alert: alertResult,
  };
  if (violations.length) {
    logger.warn(`[lawn-pricing-sweep] ${violations.length} violation(s); first: ${violations[0].cell} — ${violations[0].detail}`);
  } else {
    logger.info(`[lawn-pricing-sweep] clean: ${ladder.cellsChecked} cells checked, budget check ${budget.status}`);
  }
  return { ...summary, violationDetails: violations };
}

module.exports = {
  runLawnPricingInvariantSweep,
  // Exported for tests.
  scanLadderGrid,
  checkBudgetDrift,
  SIZE_MONOTONE_TOLERANCE,
};
