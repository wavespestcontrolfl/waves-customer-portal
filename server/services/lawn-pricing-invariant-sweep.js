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
  const shapeChecks = process.env.LAWN_SWEEP_SHAPE_CHECKS === 'true';

  const violations = [];
  let cellsChecked = 0;

  // The DB bridge deep-merges lawn config without validating this field, so a
  // malformed live value must be a violation — `Number(...) || 0` would
  // silently DISABLE the below-minimum check (and priceLawnCare stops
  // enforcing the owner-mandated floor) while the sweep reports clean.
  const rawProgramMinimum = LAWN_PRICING_V2.programMinimumMonthly;
  const programMinimumMonthly = Number(rawProgramMinimum);
  if (!Number.isFinite(programMinimumMonthly) || programMinimumMonthly <= 0) {
    violations.push({
      check: 'malformed_program_minimum',
      cell: 'lawn_pricing_v2.programMinimumMonthly',
      detail: `live config program minimum is ${JSON.stringify(rawProgramMinimum)} — the monthly floor is not being enforced`,
    });
  }

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
        // NaN/Infinity from a malformed synced bracket makes every comparison
        // below evaluate false — the cell would pass as clean while the live
        // price is unusable. Reject it explicitly and skip the comparisons
        // (they are meaningless against a non-finite value).
        if (![t.monthly, t.annual, t.perApp].every((n) => Number.isFinite(n) && n > 0)) {
          violations.push({
            check: 'non_finite_price',
            cell: cellLabel(track, sqft, t.visits),
            detail: `monthly=${t.monthly} annual=${t.annual} perApp=${t.perApp} — live ladder cell is not a usable price`,
          });
          continue;
        }
        // The cost-floor output must also be a real dollar amount: a malformed
        // live margin floor (e.g. bad targetCollectedMarginFloor) yields NaN
        // costFloorAnnual while market pricing still returns a finite monthly
        // — floor enforcement silently OFF while the grid reads clean.
        if (!Number.isFinite(t.costFloorAnnual) || t.costFloorAnnual <= 0) {
          violations.push({
            check: 'malformed_cost_floor',
            cell: cellLabel(track, sqft, t.visits),
            detail: `costFloorAnnual is ${t.costFloorAnnual} — cost-floor enforcement is not verifiable for this cell`,
          });
          continue;
        }
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
        // Compare against the running MAX per cadence, not the adjacent size:
        // a gradual slope (each step down within tolerance) must accumulate
        // against the peak, or a 22k lawn can end up dollars below a 10k one
        // with every adjacent pair "in tolerance".
        const maxSize = prevMonthlyBySizeTier[t.visits];
        if (maxSize !== undefined && t.monthly < maxSize.monthly - SIZE_MONOTONE_TOLERANCE) {
          violations.push({
            check: 'monthly_size_inversion',
            cell: cellLabel(track, sqft, t.visits),
            detail: `monthly $${t.monthly} at ${sqft}sf < $${maxSize.monthly} at ${maxSize.sqft}sf (running max)`,
          });
        }
        if (maxSize === undefined || t.monthly > maxSize.monthly) {
          prevMonthlyBySizeTier[t.visits] = { sqft, monthly: t.monthly };
        }
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
  // Tables exist but no Lawn Care usage rows: prod normally carries the
  // mapped rotation, so a missing mapping means rows were deleted/renamed —
  // an anomaly that must not vouch for the budget (the infra-absent case is
  // the `!inventory.available` skip above).
  if (cogs.status === 'missing_cogs') {
    return {
      status: 'unverified',
      reason: 'no live COGS rows mapped for Lawn Care',
      violations: [{
        check: 'material_budget_unverified',
        cell: 'inventory_cogs',
        detail: 'no Lawn Care rows mapped in inventory COGS (deleted/renamed?) — budget drift cannot be verified',
      }],
    };
  }
  // status 'warning' = some (or ALL — total can be $0) mapped rows priced at
  // $0 for missing normalized cost data, which UNDERSTATES the annual lower
  // bound — a partially costed rotation must not vouch for the budget (or
  // resolve an open alert). Checked BEFORE the zero-total skip so an
  // all-zero warning rotation lands here, not in the designed skip. It is a
  // data-quality exception, not a designed skip.
  if (cogs.status !== 'ok') {
    const warningText = (cogs.warnings || []).join('; ') || 'unknown COGS warning';
    return {
      status: 'unverified',
      reason: `partial COGS: ${warningText}`,
      violations: [{
        check: 'material_budget_unverified',
        cell: 'inventory_cogs',
        detail: `mapped Lawn Care rotation is only partially costed (${warningText}) — budget drift cannot be verified until every mapped product carries cost data`,
      }],
    };
  }
  // status 'ok' with a zero total: costLineFromUsage accepts zero-valued
  // cost_per_unit/best_price as a priced line, so an all-$0 rotation is
  // zero-PRICED catalog data, not a genuinely free rotation — it cannot
  // verify the budget (or resolve an open alert) any more than missing data
  // can.
  if (!Number(cogs.totalPerVisit)) {
    return {
      status: 'unverified',
      reason: 'mapped Lawn Care rotation prices at $0 live',
      violations: [{
        check: 'material_budget_unverified',
        cell: 'inventory_cogs',
        detail: 'every mapped Lawn Care row carries a $0 catalog price — budget drift cannot be verified until the rows have real positive cost data',
      }],
    };
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
    // material_budget_unverified stays 'high' — a partially costed inventory
    // rotation is a data-quality exception to fix, not a margin emergency.
    severity: violations.some((v) => ['below_program_minimum', 'material_budget_stale_low', 'config_sync_failed', 'ladder_scan_failed', 'budget_check_failed', 'non_finite_price', 'malformed_program_minimum', 'malformed_cost_floor'].includes(v.check))
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
    .merge({
      ...payload,
      // A violation persisting across weekly runs keeps its FIRST detection
      // time (age is the signal); only a re-fire after a resolution starts a
      // new episode with a fresh detected_at.
      detected_at: db.raw("CASE WHEN admin_alerts.status = 'open' THEN admin_alerts.detected_at ELSE excluded.detected_at END"),
      resolved_at: null,
      updated_at: now,
    })
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

  // A scan crash (e.g. malformed synced brackets making priceLawnCare throw)
  // must become a red alert like a sync failure — an unguarded reject here
  // dies in the cron's log and the dashboard never hears about the broken
  // ladder.
  let ladder;
  try {
    ladder = scanLadderGrid();
  } catch (err) {
    logger.error(`[lawn-pricing-sweep] ladder grid scan crashed: ${err.message}`);
    ladder = {
      cellsChecked: 0,
      shapeChecks: process.env.LAWN_SWEEP_SHAPE_CHECKS === 'true',
      violations: [{
        check: 'ladder_scan_failed',
        cell: 'ladder_grid',
        detail: `live ladder scan crashed before completing: ${err.message}`,
      }],
    };
  }
  let budget;
  try {
    budget = await checkBudgetDrift();
  } catch (err) {
    // A failed check is NOT a clean check — without a violation here, a clean
    // ladder scan would hand upsertSweepAlert an empty list and RESOLVE an
    // open material-budget alert that was never actually re-verified.
    logger.error(`[lawn-pricing-sweep] budget drift check failed: ${err.message}`);
    budget = {
      status: 'error',
      reason: err.message,
      violations: [{
        check: 'budget_check_failed',
        cell: 'inventory_cogs',
        detail: `live COGS budget check failed before verifying material budgets: ${err.message}`,
      }],
    };
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
