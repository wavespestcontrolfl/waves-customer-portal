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
const { isAlwaysFreeServiceType } = require('./no-cost-visit-types');

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
 * recurring customer's monthly_rate, else $0. Free visits NEVER fall back to
 * monthly_rate — only an operator-set positive price gives them revenue. Two
 * kinds are free: callbacks/re-services, and INCLUDED follow-ups, which the
 * scheduler creates with estimated_price=0 + followup_included=true and which
 * the completion handler's shouldInvoice gate skips (admin-dispatch.js) — their
 * revenue was already booked on the originating visit, so attributing a full
 * monthly_rate here would double-count. A revenue already written on the record
 * short-circuits so the live recompute stays idempotent — EXCEPT under
 * ignoreExistingRevenue (the backfill mode): historical records were never
 * written by completion, so any existing positive revenue on them is a stale
 * synthetic seed (migration 20260401000027 seeded random revenue), and the
 * backfill must re-derive from the scheduled-service/customer truth rather than
 * compute cost/margin around a fake number. Pure (no I/O), unit-testable.
 */
function deriveRevenue({ serviceRecord, scheduledService, customer, ignoreExistingRevenue = false } = {}) {
  if (!ignoreExistingRevenue) {
    const recordRevenue = Number(serviceRecord?.revenue);
    if (Number.isFinite(recordRevenue) && recordRevenue > 0) return round2(recordRevenue);
  }

  // Always-free visit TYPES (re-service / follow-up / appointment / estimate) and
  // included follow-ups are $0 even with a stale/inherited positive
  // estimated_price — the shared no-cost classifier (no-cost-visit-types.js) and
  // the dispatch auto-invoice gate (admin-dispatch.js) both refuse to bill them.
  // So this MUST precede the explicit-price check.
  const serviceType = scheduledService?.service_type || serviceRecord?.service_type;
  if (scheduledService?.followup_included === true || isAlwaysFreeServiceType(serviceType)) {
    return 0;
  }

  const visitPrice = Number(scheduledService?.estimated_price);
  if (Number.isFinite(visitPrice) && visitPrice > 0) return round2(visitPrice);

  // A callback is free unless the operator set an explicit price (handled above).
  // Detect it from EITHER side: the callback backfill (20260618000002) flags
  // completed re-services on service_records.is_callback but leaves the terminal
  // scheduled_services row false, so checking only the scheduled_service would
  // book a full monthly rate for historical free re-services.
  const isCallback = !!scheduledService?.is_callback || serviceRecord?.is_callback === true;
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

async function calcLaborCost(db, scheduledServiceId, technicianId, startTime, endTime, rate) {
  let minutes = 0;
  try {
    // Prefer the JOB time entries tied directly to this visit. time_entries.job_id
    // IS the scheduled_services id (see time-tracking.js), so this attributes
    // exactly. entry_type='job' excludes the shift/break/drive/admin_time clocks
    // (a shift row spans the whole workday) and voided rows are dropped — the
    // same scoping every other time-tracking consumer uses.
    if (scheduledServiceId) {
      const jobEntries = await db('time_entries')
        .where({ job_id: scheduledServiceId, entry_type: 'job' })
        .whereNot('status', 'voided')
        .select('duration_minutes');
      minutes = jobEntries.reduce((s, e) => s + (Number(e.duration_minutes) || 0), 0);
    }
    // Else fall back to job entries overlapping the ACTUAL visit window — only
    // when both real bounds exist. Never a Date.now() window: during the one-time
    // backfill that would scoop up whatever a tech is clocked into at deploy time
    // and mis-attribute it to an old visit.
    if (!minutes && technicianId && startTime && endTime) {
      const entries = await db('time_entries')
        .where({ technician_id: technicianId, entry_type: 'job' })
        .whereNot('status', 'voided')
        .whereBetween('clock_in', [
          new Date(new Date(startTime).getTime() - 15 * 60000),
          new Date(new Date(endTime).getTime() + 15 * 60000),
        ])
        .select('duration_minutes');
      minutes = entries.reduce((s, e) => s + (Number(e.duration_minutes) || 0), 0);
    }
  } catch { /* table may be absent */ }

  // Final fallback: the actual_start/end span on the scheduled_service.
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
 * direct scheduled_service_id FK (added in 20260427000007) — an unambiguous
 * 1:1 link — over the legacy (customer_id, service_date, service_type) soft-join.
 *
 * Returns { record, viaFk, ambiguous }. The soft-join is `ambiguous` when the
 * tuple maps to more than one service_record OR more than one completed
 * scheduled_service: every such visit would collapse onto the single newest
 * record and clobber each other's financials, leaving the rest blank. The
 * write-through is skipped (logged) for ambiguous matches rather than corrupt
 * them — completion-created records carry the FK, so this only affects pre-FK
 * legacy history during the backfill.
 */
async function resolveServiceRecord(db, svc, srCols) {
  if (srCols.scheduled_service_id) {
    const byFk = await db('service_records')
      .where({ scheduled_service_id: svc.id })
      .orderBy('created_at', 'desc')
      .first();
    if (byFk) return { record: byFk, viaFk: true, ambiguous: false };
  }
  const records = await db('service_records')
    .where({ customer_id: svc.customer_id, service_date: svc.scheduled_date, service_type: svc.service_type })
    .orderBy('created_at', 'desc')
    .limit(2);
  const record = records[0] || null;
  let ambiguous = records.length > 1;
  if (record && !ambiguous) {
    const dupServices = await db('scheduled_services')
      .where({
        customer_id: svc.customer_id,
        scheduled_date: svc.scheduled_date,
        service_type: svc.service_type,
        status: 'completed',
      })
      .count({ c: '*' })
      .first();
    if (Number(dupServices?.c) > 1) ambiguous = true;
  }
  return { record, viaFk: false, ambiguous };
}

/**
 * calculateJobCost(scheduledServiceId, db?, opts?)
 * Upserts a job_costs row AND writes the financials through to service_records.
 * Returns the computed cost object. Pass `db` to run on a specific knex handle
 * (e.g. a migration's); omit it to use the app db singleton. opts.recomputeRevenue
 * (backfill-only) re-derives revenue from source instead of preserving any
 * existing — possibly stale-seeded — service_records.revenue.
 */
async function calculateJobCost(scheduledServiceId, db, { recomputeRevenue = false } = {}) {
  db = resolveDb(db);
  if (!scheduledServiceId) throw new Error('scheduledServiceId required');

  const svc = await db('scheduled_services').where({ id: scheduledServiceId }).first();
  if (!svc) throw new Error(`scheduled_service ${scheduledServiceId} not found`);

  const srCols = await db('service_records').columnInfo().catch(() => ({}));
  const { record, ambiguous } = await resolveServiceRecord(db, svc, srCols);
  const customer = await db('customers').where({ id: svc.customer_id }).first();

  // An operator can dispose a completed visit as intentionally_free in the
  // Billing Recovery workbench (visit_billing_dispositions). That decision is
  // authoritative — never let a derived estimated_price/monthly_rate put revenue
  // on a visit a human marked no-cost. (disposition='billed' keeps the derived
  // value, which approximates the invoice the operator cut.)
  let intentionallyFree = false;
  try {
    const disposition = await db('visit_billing_dispositions')
      .where({ scheduled_service_id: scheduledServiceId })
      .first();
    intentionallyFree = disposition?.disposition === 'intentionally_free';
  } catch { /* table may be absent before 20260619000001 */ }

  const { laborRate, driveCostPerStop } = await getFinancials(db);
  const revenue = intentionallyFree ? 0 : deriveRevenue({
    serviceRecord: record, scheduledService: svc, customer, ignoreExistingRevenue: recomputeRevenue,
  });
  const { laborCost, laborHours } = await calcLaborCost(
    db, scheduledServiceId, svc.technician_id, svc.actual_start_time, svc.actual_end_time, laborRate,
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
  //    Skipped for ambiguous legacy soft-join matches (multiple same-day visits
  //    collapsing onto one record) — writing would clobber it and blank the rest.
  //    Also skipped when the record itself isn't completed: office-handoff visits
  //    are stored status='incomplete' while their scheduled_service stays
  //    'completed', and the dashboard counts any non-null revenue — an incomplete
  //    visit must not surface revenue/margin.
  const recordCompleted = !srCols.status || record?.status === 'completed';
  let wroteThrough = false;
  if (record?.id && !ambiguous && recordCompleted) {
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
      wroteThrough = true;
    }
  } else if (record?.id && ambiguous) {
    logger.warn(
      `[job-costing] ${scheduledServiceId} — ambiguous legacy service_record match `
      + '(same customer/date/type duplicates); skipped service_records write-through',
    );
  }

  logger.info(
    `[job-costing] ${scheduledServiceId} — revenue $${fin.revenue} cost $${fin.total_job_cost} `
    + `profit $${fin.gross_profit} (${fin.gross_margin_pct ?? '—'}%)`,
  );

  // Bridge the customer's realized revenue/profit/LTV onto their ad-attribution
  // funnel row so /admin/ads ROI views read real numbers. Isolated: an attribution
  // failure must never break costing (the costing writes above are committed). Runs
  // here so live completion AND the financials backfill both keep attribution in
  // sync. Re-sums from service_records, so the just-written row is included.
  try {
    const { syncCustomerAdAttribution } = require('./ad-attribution-sync');
    await syncCustomerAdAttribution(svc.customer_id, db);
  } catch (err) {
    logger.warn(`[job-costing] ad-attribution sync failed for ${scheduledServiceId}: ${err.message}`);
  }

  return { ...row, laborHours: fin.labor_hours, serviceRecordId: wroteThrough ? record.id : null };
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

  // Drive from completed scheduled_services and let calculateJobCost ->
  // resolveServiceRecord attach the right service_record (the scheduled_service_id
  // FK when present, else the legacy customer+date+type soft-join). Driving from
  // service_records.scheduled_service_id alone would SKIP legacy records whose FK
  // was never backfilled — migration 20260427000007 added the column but left
  // older rows NULL — leaving their dashboard/revenue financials blank. We also
  // union in the FK referenced by any completed service_record, so a completed
  // record whose scheduled_service carries a non-completed status is still caught.
  const fromServices = await db('scheduled_services')
    .where('status', 'completed')
    .pluck('id')
    .catch(() => []);
  let fromRecords = [];
  if (srCols.scheduled_service_id) {
    fromRecords = await db('service_records')
      .whereNotNull('scheduled_service_id')
      .where('status', 'completed')
      .distinct('scheduled_service_id')
      .pluck('scheduled_service_id')
      .catch(() => []);
  }
  const ids = [...new Set([...fromServices, ...fromRecords])];

  let processed = 0;
  let updated = 0;
  let skipped = 0;
  for (const id of ids) {
    try {
      // recomputeRevenue: re-derive instead of trusting any existing (possibly
      // synthetic-seeded) service_records.revenue — see deriveRevenue.
      const res = await calculateJobCost(id, db, { recomputeRevenue: true });
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
