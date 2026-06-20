/**
 * Job Costing Service
 *
 * Calculates per-visit revenue, labor, material, drive, and expense costs
 * for a completed scheduled_service. Writes the result to TWO places:
 *   1. job_costs            — the costing ledger (admin-job-costs / equipment).
 *   2. service_records.*     — the financial columns the Dashboard
 *                              (admin-dashboard core-kpis: Gross Margin,
 *                              Stops/Hour, Tech Utilization, Revenue/Man-Hour)
 *                              and /admin/revenue read. These were never
 *                              populated on completion, so every tile that
 *                              filters `whereNotNull('revenue')` rendered "—".
 *
 * Data sources:
 *   revenue       — see deriveRevenue(): mirrors the completion handler's
 *                   invoiceAmount (estimated_price → monthly_rate, callbacks $0)
 *   labor_cost    — time_entries.duration_minutes (else actual_start/end span)
 *                   × company_financials.loaded_labor_rate
 *   material_cost — product_inventory_movements.cost_used, plus
 *                   property_application_history fallback costs
 *   drive_cost    — company_financials.drive_cost_per_stop (one stop per visit)
 *   expenses      — expenses WHERE scheduled_service_id=?
 *
 * Idempotent: re-running replaces the prior job_costs row and re-writes the
 * service_records financials for the same scheduled_service_id.
 *
 * A db handle can be passed to every entry point so a migration can run the
 * backfill on its own knex instance (the module never opens the app db
 * singleton unless a call omits the handle).
 */

const logger = require('./logger');

const DEFAULT_LABOR_RATE = 35; // fallback if company_financials empty
const DEFAULT_DRIVE_COST_PER_STOP = 6;

// Lazy so importing this module (e.g. from a migration) never opens the app's
// db pool — the singleton is only resolved when a caller omits the handle.
function resolveDb(db) {
  return db || require('../models/db');
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

async function getFinancials(db) {
  try {
    const row = await db('company_financials').orderBy('effective_date', 'desc').first();
    return {
      laborRate: Number(row?.loaded_labor_rate) || DEFAULT_LABOR_RATE,
      driveCostPerStop: row?.drive_cost_per_stop != null
        ? Number(row.drive_cost_per_stop)
        : DEFAULT_DRIVE_COST_PER_STOP,
    };
  } catch {
    return { laborRate: DEFAULT_LABOR_RATE, driveCostPerStop: DEFAULT_DRIVE_COST_PER_STOP };
  }
}

/**
 * deriveRevenue — the per-visit revenue, mirroring the completion handler's
 * `invoiceAmount` (admin-dispatch.js): an explicit visit price wins, else a
 * recurring customer's monthly_rate, else $0. Callbacks/re-services are free by
 * definition for recurring customers, so they NEVER fall back to monthly_rate —
 * only an operator-set positive price gives a callback revenue. A revenue
 * already written on the record short-circuits so recompute stays idempotent.
 * Pure (no I/O) so it is unit-testable.
 */
function deriveRevenue({ serviceRecord, scheduledService, customer } = {}) {
  const recordRevenue = Number(serviceRecord?.revenue);
  if (Number.isFinite(recordRevenue) && recordRevenue > 0) return round2(recordRevenue);

  const visitPrice = Number(scheduledService?.estimated_price);
  if (Number.isFinite(visitPrice) && visitPrice > 0) return round2(visitPrice);

  const isCallback = !!scheduledService?.is_callback;
  const monthly = Number(customer?.monthly_rate);
  if (!isCallback && Number.isFinite(monthly) && monthly > 0) return round2(monthly);

  return 0;
}

/**
 * computeServiceRecordFinancials — pure roll-up of a visit's costs into the
 * derived fields the dashboard reads. margin and rpmh are null (not 0) when
 * revenue or labor is absent, so "no data" stays distinct from "zero". Pure so
 * it is unit-testable.
 */
function computeServiceRecordFinancials({
  revenue = 0,
  laborHours = 0,
  laborCost = 0,
  productsCost = 0,
  driveCost = 0,
  expensesCost = 0,
} = {}) {
  const rev = round2(revenue);
  const matCost = round2(productsCost);
  const labHours = round2(laborHours);
  const labCost = round2(laborCost);
  const drvCost = round2(driveCost);
  const totalCost = round2(labCost + matCost + drvCost + (Number(expensesCost) || 0));
  const grossProfit = round2(rev - totalCost);
  const marginPct = rev > 0 ? round2((grossProfit / rev) * 100) : null;
  const rpmh = labHours > 0 ? round2(rev / labHours) : null;
  return {
    revenue: rev,
    material_cost: matCost,
    labor_hours: labHours,
    labor_cost: labCost,
    drive_cost: drvCost,
    total_job_cost: totalCost,
    gross_profit: grossProfit,
    gross_margin_pct: marginPct,
    revenue_per_man_hour: rpmh,
  };
}

async function calcLaborCost(db, technicianId, startTime, endTime, rate) {
  let minutes = 0;
  // Prefer time_entries overlapping the window (job_id may or may not match)
  try {
    const entries = await db('time_entries')
      .where({ technician_id: technicianId })
      .whereBetween('clock_in', [
        new Date(new Date(startTime || Date.now()).getTime() - 15 * 60000),
        new Date(new Date(endTime || Date.now()).getTime() + 15 * 60000),
      ])
      .select('duration_minutes');
    minutes = entries.reduce((s, e) => s + (Number(e.duration_minutes) || 0), 0);
  } catch { /* table may be absent */ }

  // Fallback: actual_start/end on scheduled_services
  if (!minutes && startTime && endTime) {
    minutes = Math.max(0, Math.round((new Date(endTime) - new Date(startTime)) / 60000));
  }

  const hours = minutes / 60;
  return { laborMinutes: minutes, laborHours: hours, laborCost: round2(hours * rate) };
}

async function calcProductsCost(db, serviceRecordId) {
  let total = 0;
  const breakdown = [];
  const costedInventoryProductIds = new Set();
  try {
    const movementRows = await db('product_inventory_movements as pim')
      .leftJoin('products_catalog as pc', 'pim.product_id', 'pc.id')
      .where({ service_record_id: serviceRecordId, movement_type: 'usage' })
      .select(
        'pim.product_id',
        'pim.quantity',
        'pim.unit',
        'pim.unit_cost',
        'pim.cost_used',
        'pim.stock_after',
        'pc.name as product_name',
      );
    for (const r of movementRows) {
      const line = Number(r.cost_used);
      if (!Number.isFinite(line)) continue;
      total += line;
      if (r.product_id) costedInventoryProductIds.add(r.product_id);
      breakdown.push({
        product_id: r.product_id,
        product_name: r.product_name,
        qty: Number(r.quantity) || 0,
        unit: r.unit,
        unit_cost: r.unit_cost != null ? Number(r.unit_cost) : null,
        line,
        stock_after: r.stock_after != null ? Number(r.stock_after) : null,
        source: 'inventory_movement',
      });
    }
  } catch (err) {
    logger.debug(`[job-costing] inventory movement cost error: ${err.message}`);
  }

  try {
    const rows = await db('property_application_history')
      .where({ service_record_id: serviceRecordId })
      .select('product_id', 'quantity_applied', 'quantity_unit');

    for (const r of rows) {
      const qty = Number(r.quantity_applied) || 0;
      if (!qty || !r.product_id) continue;
      if (costedInventoryProductIds.has(r.product_id)) continue;

      let unitCost = null;
      const prod = await db('products_catalog').where({ id: r.product_id }).first();
      if (prod?.cost_per_unit) unitCost = Number(prod.cost_per_unit);

      if (unitCost == null) {
        const best = await db('vendor_pricing')
          .where({ product_id: r.product_id })
          .orderBy('price', 'asc')
          .first();
        if (best?.price) unitCost = Number(best.price);
      }

      if (unitCost != null) {
        const line = round2(qty * unitCost);
        total += line;
        breakdown.push({ product_id: r.product_id, qty, unit: r.quantity_unit, unit_cost: unitCost, line });
      }
    }
  } catch (err) {
    logger.debug(`[job-costing] products cost error: ${err.message}`);
  }
  return { productsCost: round2(total), breakdown };
}

async function calcExpenses(db, scheduledServiceId) {
  try {
    const rows = await db('expenses')
      .where({ scheduled_service_id: scheduledServiceId })
      .select('amount');
    return rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  } catch { return 0; }
}

/**
 * Resolve the canonical service_record for a scheduled_service. Prefers the
 * direct scheduled_service_id FK (added in 20260427000007) over the legacy
 * (customer_id, service_date, service_type) soft-join, which collided on
 * same-day same-customer double visits.
 */
async function resolveServiceRecord(db, svc, srCols) {
  if (srCols.scheduled_service_id) {
    const byFk = await db('service_records')
      .where({ scheduled_service_id: svc.id })
      .orderBy('created_at', 'desc')
      .first();
    if (byFk) return byFk;
  }
  return db('service_records')
    .where({ customer_id: svc.customer_id, service_date: svc.scheduled_date, service_type: svc.service_type })
    .orderBy('created_at', 'desc')
    .first();
}

/**
 * calculateJobCost(scheduledServiceId, db?)
 * Upserts a job_costs row AND writes the financials through to service_records.
 * Returns the computed cost object. Pass `db` to run on a specific knex handle
 * (e.g. a migration's); omit it to use the app db singleton.
 */
async function calculateJobCost(scheduledServiceId, db) {
  db = resolveDb(db);
  if (!scheduledServiceId) throw new Error('scheduledServiceId required');

  const svc = await db('scheduled_services').where({ id: scheduledServiceId }).first();
  if (!svc) throw new Error(`scheduled_service ${scheduledServiceId} not found`);

  const srCols = await db('service_records').columnInfo().catch(() => ({}));
  const record = await resolveServiceRecord(db, svc, srCols);
  const customer = await db('customers').where({ id: svc.customer_id }).first();

  const { laborRate, driveCostPerStop } = await getFinancials(db);
  const revenue = deriveRevenue({ serviceRecord: record, scheduledService: svc, customer });
  const { laborCost, laborHours } = await calcLaborCost(
    db, svc.technician_id, svc.actual_start_time, svc.actual_end_time, laborRate,
  );
  const { productsCost, breakdown } = record?.id
    ? await calcProductsCost(db, record.id)
    : { productsCost: 0, breakdown: [] };
  const expensesCost = await calcExpenses(db, scheduledServiceId);
  // A completed visit is one route stop, so it carries one stop's drive cost.
  const driveCost = driveCostPerStop;

  const fin = computeServiceRecordFinancials({
    revenue, laborHours, laborCost, productsCost, driveCost, expensesCost,
  });

  // 1. job_costs ledger (existing consumers: admin-job-costs, equipment).
  const row = {
    service_record_id: record?.id || null,
    scheduled_service_id: scheduledServiceId,
    technician_id: svc.technician_id,
    customer_id: svc.customer_id,
    service_date: svc.scheduled_date,
    service_type: svc.service_type,
    products_cost: fin.material_cost,
    labor_cost: fin.labor_cost,
    drive_cost: fin.drive_cost,
    equipment_cost: 0,
    total_cost: fin.total_job_cost,
    revenue: fin.revenue,
    gross_profit: fin.gross_profit,
    margin_pct: fin.gross_margin_pct,
    products_used: JSON.stringify(breakdown),
  };

  const existing = await db('job_costs').where({ scheduled_service_id: scheduledServiceId }).first();
  if (existing) {
    await db('job_costs').where({ id: existing.id }).update(row);
  } else {
    await db('job_costs').insert(row);
  }

  // 2. Write-through to service_records — the table the Dashboard + /admin/revenue
  //    actually read. Each column is guarded by columnInfo so an environment
  //    missing the 20260401000027 financial columns is a no-op, not a crash.
  if (record?.id) {
    const upd = {};
    const set = (col, val) => { if (srCols[col]) upd[col] = val; };
    set('revenue', fin.revenue);
    set('material_cost', fin.material_cost);
    set('labor_hours', fin.labor_hours);
    set('labor_cost', fin.labor_cost);
    set('drive_cost', fin.drive_cost);
    set('total_job_cost', fin.total_job_cost);
    set('gross_profit', fin.gross_profit);
    set('gross_margin_pct', fin.gross_margin_pct);
    set('revenue_per_man_hour', fin.revenue_per_man_hour);
    if (Object.keys(upd).length) {
      await db('service_records').where({ id: record.id }).update(upd);
    }
  }

  logger.info(
    `[job-costing] ${scheduledServiceId} — revenue $${fin.revenue} cost $${fin.total_job_cost} `
    + `profit $${fin.gross_profit} (${fin.gross_margin_pct ?? '—'}%)`,
  );
  return { ...row, laborHours: fin.labor_hours, serviceRecordId: record?.id || null };
}

/**
 * backfillServiceRecordFinancials(db?)
 * Recompute costs for every completed scheduled_service that has a
 * service_record and write the financials through. Idempotent. Used by the
 * one-time backfill migration (which passes its own knex) and runnable ad hoc.
 */
async function backfillServiceRecordFinancials(db, { onError } = {}) {
  db = resolveDb(db);
  const srCols = await db('service_records').columnInfo().catch(() => ({}));
  // Nothing to populate if the financial columns were never added.
  if (!srCols.revenue) return { processed: 0, updated: 0, skipped: 0 };

  let ids = [];
  if (srCols.scheduled_service_id) {
    ids = await db('service_records')
      .whereNotNull('scheduled_service_id')
      .where('status', 'completed')
      .distinct('scheduled_service_id')
      .pluck('scheduled_service_id');
  } else {
    ids = await db('scheduled_services').where('status', 'completed').pluck('id');
  }

  let processed = 0;
  let updated = 0;
  let skipped = 0;
  for (const id of ids) {
    try {
      const res = await calculateJobCost(id, db);
      processed += 1;
      if (res.serviceRecordId) updated += 1;
    } catch (err) {
      skipped += 1;
      if (typeof onError === 'function') onError(id, err);
      logger.warn(`[job-costing] backfill skipped ${id}: ${err.message}`);
    }
  }
  logger.info(`[job-costing] backfill complete — processed ${processed}, updated ${updated}, skipped ${skipped}`);
  return { processed, updated, skipped };
}

module.exports = {
  calculateJobCost,
  backfillServiceRecordFinancials,
  deriveRevenue,
  computeServiceRecordFinancials,
};
