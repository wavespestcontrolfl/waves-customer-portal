/**
 * Job Costing Service
 *
 * Calculates per-visit revenue, labor, material, drive, and expense costs
 * for a completed scheduled_service and upserts into job_costs.
 *
 * Data sources:
 *   revenue      — service_records.revenue, else customers.monthly_rate
 *   labor_cost   — time_entries.duration_minutes × company_financials.loaded_labor_rate
 *   products_cost — product_inventory_movements.cost_used, plus
 *                   property_application_history fallback costs for
 *                   products without costed inventory movements
 *   expenses     — expenses WHERE scheduled_service_id=?
 *
 * Idempotent: re-running replaces prior row for the same scheduled_service_id.
 */

const db = require('../models/db');
const logger = require('./logger');

const DEFAULT_LABOR_RATE = 35; // fallback if company_financials empty

async function getLaborRate() {
  try {
    const row = await db('company_financials').select('loaded_labor_rate').first();
    return Number(row?.loaded_labor_rate) || DEFAULT_LABOR_RATE;
  } catch {
    return DEFAULT_LABOR_RATE;
  }
}

async function calcLaborCost(scheduledServiceId, technicianId, startTime, endTime) {
  const rate = await getLaborRate();
  // Prefer time_entries overlapping the window (job_id may or may not match)
  let minutes = 0;
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
  return { laborMinutes: minutes, laborHours: hours, laborCost: +(hours * rate).toFixed(2), rate };
}

async function calcProductsCost(serviceRecordId) {
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
        const line = +(qty * unitCost).toFixed(2);
        total += line;
        breakdown.push({ product_id: r.product_id, qty, unit: r.quantity_unit, unit_cost: unitCost, line });
      }
    }
  } catch (err) {
    logger.debug(`[job-costing] products cost error: ${err.message}`);
  }
  return { productsCost: +total.toFixed(2), breakdown };
}

async function calcExpenses(scheduledServiceId) {
  try {
    const rows = await db('expenses')
      .where({ scheduled_service_id: scheduledServiceId })
      .select('amount');
    return rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  } catch { return 0; }
}

async function deriveRevenue(serviceRecord, scheduledService, customer) {
  if (serviceRecord?.revenue) return Number(serviceRecord.revenue);
  if (customer?.monthly_rate) return Number(customer.monthly_rate);
  return 0;
}

/**
 * calculateJobCost(scheduledServiceId)
 * Upserts a job_costs row. Returns the computed cost object.
 */
async function calculateJobCost(scheduledServiceId) {
  if (!scheduledServiceId) throw new Error('scheduledServiceId required');

  const svc = await db('scheduled_services').where({ id: scheduledServiceId }).first();
  if (!svc) throw new Error(`scheduled_service ${scheduledServiceId} not found`);

  const record = await db('service_records')
    .where({ customer_id: svc.customer_id, service_date: svc.scheduled_date, service_type: svc.service_type })
    .orderBy('created_at', 'desc')
    .first();

  const customer = await db('customers').where({ id: svc.customer_id }).first();

  const revenue = await deriveRevenue(record, svc, customer);
  const { laborCost, laborHours } = await calcLaborCost(
    scheduledServiceId, svc.technician_id, svc.actual_start_time, svc.actual_end_time
  );
  const { productsCost, breakdown } = record?.id ? await calcProductsCost(record.id) : { productsCost: 0, breakdown: [] };
  const expensesCost = await calcExpenses(scheduledServiceId);

  const totalCost = +(laborCost + productsCost + expensesCost).toFixed(2);
  const grossProfit = +(revenue - totalCost).toFixed(2);
  const marginPct = revenue > 0 ? +((grossProfit / revenue) * 100).toFixed(2) : null;

  const row = {
    service_record_id: record?.id || null,
    scheduled_service_id: scheduledServiceId,
    technician_id: svc.technician_id,
    customer_id: svc.customer_id,
    service_date: svc.scheduled_date,
    service_type: svc.service_type,
    products_cost: productsCost,
    labor_cost: laborCost,
    drive_cost: 0,
    equipment_cost: 0,
    total_cost: totalCost,
    revenue,
    gross_profit: grossProfit,
    margin_pct: marginPct,
    products_used: JSON.stringify(breakdown),
  };

  const existing = await db('job_costs').where({ scheduled_service_id: scheduledServiceId }).first();
  if (existing) {
    await db('job_costs').where({ id: existing.id }).update(row);
  } else {
    await db('job_costs').insert(row);
  }

  logger.info(`[job-costing] ${scheduledServiceId} — revenue $${revenue} cost $${totalCost} profit $${grossProfit} (${marginPct ?? '—'}%)`);
  return { ...row, laborHours };
}

module.exports = { calculateJobCost };
