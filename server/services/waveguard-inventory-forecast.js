const db = require('../models/db');
const logger = require('./logger');
const { buildPlanForService } = require('./waveguard-plan-engine');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { describeInventoryConversion } = require('./inventory-units');

const ADVISORY_LOCK_KEY = 'waveguard-inventory-forecast-cron';
let isRunning = false;

function numberOrNull(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function summarizeForecastStatus(row) {
  if (row.unitMismatchCount > 0) return 'unit_mismatch';
  if (row.onHand == null) return 'not_tracked';
  if (row.committedDemand <= 0) return 'ok';
  if (row.onHand < row.committedDemand) return 'short';
  if (row.lowStockThreshold != null && row.projectedRemaining <= row.lowStockThreshold) return 'warning';
  return 'ok';
}

function forecastPriority(status, firstShortDate) {
  if (status === 'short') return firstShortDate ? 'urgent' : 'high';
  if (status === 'warning') return 'high';
  if (status === 'unit_mismatch' || status === 'not_tracked') return 'normal';
  return 'low';
}

async function buildWaveGuardInventoryForecast({ days = 14, limit = 150, knex = db } = {}) {
  const safeDays = Math.max(1, Math.min(90, Number(days || 14)));
  const safeLimit = Math.max(1, Math.min(300, Number(limit || 150)));
  const startDate = etDateString();
  const endDate = etDateString(addETDays(new Date(), safeDays));
  const services = await knex('scheduled_services as ss')
    .leftJoin('customers as c', 'ss.customer_id', 'c.id')
    .leftJoin('technicians as t', 'ss.technician_id', 't.id')
    .whereBetween('ss.scheduled_date', [startDate, endDate])
    .whereNotIn('ss.status', ['completed', 'cancelled', 'canceled', 'void'])
    // Real WaveGuard members only — exclude the flat non-member 'Commercial' tier.
    .whereIn('c.waveguard_tier', ['Bronze', 'Silver', 'Gold', 'Platinum'])
    .where(function lawnService() {
      this.whereILike('ss.service_type', '%lawn%')
        .orWhereILike('ss.service_type', '%fertiliz%')
        .orWhereILike('ss.service_type', '%turf%');
    })
    .select(
      'ss.id',
      'ss.customer_id',
      'ss.service_type',
      'ss.scheduled_date',
      'ss.window_start',
      'c.first_name',
      'c.last_name',
      'c.address_line1',
      'c.city',
      'c.waveguard_tier',
      't.name as technician_name',
    )
    .orderBy('ss.scheduled_date', 'asc')
    .orderBy('ss.window_start', 'asc')
    .limit(safeLimit);

  const productMap = new Map();
  const errors = [];

  function ensureRow(product, inventory, demandUnit) {
    const key = String(product.id);
    if (!productMap.has(key)) {
      productMap.set(key, {
        productId: product.id,
        productName: product.name,
        category: product.category || null,
        inventoryUnit: inventory?.unit || null,
        demandUnit: demandUnit || inventory?.unit || null,
        onHand: inventory?.onHand != null ? Number(inventory.onHand) : null,
        lowStockThreshold: inventory?.lowStockThreshold != null ? Number(inventory.lowStockThreshold) : null,
        committedDemand: 0,
        unconvertedDemand: 0,
        unitMismatchCount: 0,
        conversionConfidence: 'exact_unit',
        appointments: [],
        mismatchAppointments: [],
        firstShortDate: null,
      });
    }
    return productMap.get(key);
  }

  for (const service of services) {
    try {
      const plan = await buildPlanForService(service.id, { db: knex });
      const customerName = `${service.first_name || ''} ${service.last_name || ''}`.trim() || 'Customer';
      for (const item of plan?.mixCalculator?.items || []) {
        if (!item?.product?.id) continue;
        const amount = numberOrNull(item.mix?.amount);
        if (!amount || amount <= 0) continue;
        const inventory = item.product.inventory || {};
        const amountUnit = item.mix?.amountUnit || item.mix?.rateUnit || inventory.unit || null;
        const row = ensureRow(item.product, inventory, amountUnit);
        const appointment = {
          serviceId: service.id,
          customerId: service.customer_id,
          customerName,
          serviceType: service.service_type,
          scheduledDate: service.scheduled_date,
          city: service.city,
          waveguardTier: service.waveguard_tier,
          protocolWindowTitle: plan?.protocol?.structured?.window?.title || plan?.closeout?.protocolWindowTitle || null,
          amount,
          unit: amountUnit,
          inventoryUnit: row.inventoryUnit || amountUnit,
          substitution: item.substitution || null,
        };
        const conversion = describeInventoryConversion(amount, amountUnit, row.inventoryUnit || amountUnit);
        appointment.inventoryAmount = conversion.amount;
        appointment.conversionConfidence = conversion.confidence;
        if (conversion.convertible && conversion.amount != null) {
          row.committedDemand = Number((row.committedDemand + conversion.amount).toFixed(4));
          if (conversion.confidence !== 'exact_unit') row.conversionConfidence = conversion.confidence;
          row.appointments.push(appointment);
        } else {
          row.unconvertedDemand = Number((row.unconvertedDemand + amount).toFixed(4));
          row.unitMismatchCount += 1;
          row.conversionConfidence = 'needs_review';
          row.mismatchAppointments.push(appointment);
        }
      }
    } catch (err) {
      errors.push({
        serviceId: service.id,
        scheduledDate: service.scheduled_date,
        customerName: `${service.first_name || ''} ${service.last_name || ''}`.trim() || 'Customer',
        message: err.message || 'Forecast plan failed',
      });
    }
  }

  const products = Array.from(productMap.values()).map((row) => {
    row.projectedRemaining = row.onHand != null ? Number((row.onHand - row.committedDemand).toFixed(4)) : null;
    let runningDemand = 0;
    for (const appointment of row.appointments.slice().sort((a, b) => String(a.scheduledDate).localeCompare(String(b.scheduledDate)))) {
      runningDemand = Number((runningDemand + Number(appointment.inventoryAmount || appointment.amount || 0)).toFixed(4));
      if (row.onHand != null && runningDemand > row.onHand) {
        row.firstShortDate = appointment.scheduledDate;
        break;
      }
    }
    row.status = summarizeForecastStatus(row);
    row.shortfall = row.onHand != null ? Math.max(0, Number((row.committedDemand - row.onHand).toFixed(4))) : null;
    const targetBuffer = row.lowStockThreshold != null ? row.lowStockThreshold : Number((row.committedDemand * 0.25).toFixed(4));
    row.targetStock = Number((row.committedDemand + targetBuffer).toFixed(4));
    row.recommendedOrderQuantity = row.onHand != null
      ? Math.max(0, Number((row.targetStock - row.onHand).toFixed(4)))
      : Number((row.committedDemand || row.targetStock || 0).toFixed(4));
    row.priority = forecastPriority(row.status, row.firstShortDate);
    return row;
  }).sort((a, b) => {
    const rank = { short: 0, warning: 1, unit_mismatch: 2, not_tracked: 3, ok: 4 };
    return (rank[a.status] ?? 9) - (rank[b.status] ?? 9)
      || String(a.firstShortDate || a.appointments[0]?.scheduledDate || '').localeCompare(String(b.firstShortDate || b.appointments[0]?.scheduledDate || ''))
      || a.productName.localeCompare(b.productName);
  });

  const statusCounts = products.reduce((acc, product) => {
    acc[product.status] = (acc[product.status] || 0) + 1;
    return acc;
  }, { ok: 0, warning: 0, short: 0, unit_mismatch: 0, not_tracked: 0 });

  return {
    startDate,
    endDate,
    days: safeDays,
    serviceCount: services.length,
    productCount: products.length,
    statusCounts,
    products,
    errors,
    generatedAt: new Date().toISOString(),
  };
}

async function syncForecastAlert(knex, forecast) {
  if (!(await knex.schema.hasTable('admin_alerts'))) return null;
  const short = Number(forecast.statusCounts?.short || 0);
  const warning = Number(forecast.statusCounts?.warning || 0);
  const unitMismatch = Number(forecast.statusCounts?.unit_mismatch || 0);
  const notTracked = Number(forecast.statusCounts?.not_tracked || 0);
  const actionable = short + warning + unitMismatch + notTracked;
  const now = new Date();

  if (actionable === 0) {
    const resolvedAlerts = await knex('admin_alerts')
      .where({ type: 'waveguard_inventory_forecast', status: 'open' })
      .update({
        status: 'resolved',
        resolved_at: now,
        last_seen_at: now,
        description: 'Resolved after WaveGuard inventory forecast recheck.',
        metadata: JSON.stringify({ source: 'waveguard_inventory_forecast', statusCounts: forecast.statusCounts, recheckedAt: now.toISOString() }),
        updated_at: now,
      });
    return { alertStatus: 'resolved', resolvedAlerts, actionable, short, warning, unitMismatch, notTracked };
  }

  const topProducts = forecast.products
    .filter((product) => ['short', 'warning', 'unit_mismatch', 'not_tracked'].includes(product.status))
    .slice(0, 8)
    .map((product) => ({
      productId: product.productId,
      productName: product.productName,
      status: product.status,
      committedDemand: product.committedDemand,
      inventoryUnit: product.inventoryUnit,
      projectedRemaining: product.projectedRemaining,
      firstShortDate: product.firstShortDate,
      recommendedOrderQuantity: product.recommendedOrderQuantity,
    }));

  const severity = short > 0 ? 'high' : 'medium';
  const title = short > 0
    ? `WaveGuard forecast: ${short} product${short === 1 ? '' : 's'} short`
    : `WaveGuard forecast: ${actionable} inventory warning${actionable === 1 ? '' : 's'}`;
  const [alert] = await knex('admin_alerts')
    .insert({
      dedupe_key: 'waveguard_inventory_forecast',
      type: 'waveguard_inventory_forecast',
      status: 'open',
      severity,
      source_record_type: 'waveguard_inventory_forecast',
      source_record_id: forecast.generatedAt,
      title,
      description: `${short} short, ${warning} low-after-forecast, ${unitMismatch} unit review, ${notTracked} not tracked for ${forecast.startDate} through ${forecast.endDate}.`,
      href: '/admin/inventory?tab=forecast',
      detected_at: now,
      last_seen_at: now,
      created_by_rule: 'waveguard_inventory_forecast_scheduled_check',
      metadata: JSON.stringify({
        scanStartDate: forecast.startDate,
        scanEndDate: forecast.endDate,
        days: forecast.days,
        statusCounts: forecast.statusCounts,
        serviceCount: forecast.serviceCount,
        productCount: forecast.productCount,
        topProducts,
      }),
      updated_at: now,
    })
    .onConflict('dedupe_key')
    .merge({
      status: 'open',
      severity,
      source_record_id: forecast.generatedAt,
      title,
      description: `${short} short, ${warning} low-after-forecast, ${unitMismatch} unit review, ${notTracked} not tracked for ${forecast.startDate} through ${forecast.endDate}.`,
      href: '/admin/inventory?tab=forecast',
      last_seen_at: now,
      metadata: JSON.stringify({
        scanStartDate: forecast.startDate,
        scanEndDate: forecast.endDate,
        days: forecast.days,
        statusCounts: forecast.statusCounts,
        serviceCount: forecast.serviceCount,
        productCount: forecast.productCount,
        topProducts,
      }),
      updated_at: now,
    })
    .returning(['id', 'dedupe_key', 'severity', 'title', 'href']);

  return { alertStatus: 'open', alertId: alert?.id || null, actionable, short, warning, unitMismatch, notTracked };
}

async function runWaveGuardInventoryForecastCheck(options = {}) {
  if (isRunning) return { skipped: true, reason: 'already_running' };
  isRunning = true;
  try {
    return await db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [ADVISORY_LOCK_KEY]);
      const forecast = await buildWaveGuardInventoryForecast({
        days: options.days || 14,
        limit: options.limit || 150,
        knex: trx,
      });
      const alert = await syncForecastAlert(trx, forecast);
      return {
        skipped: false,
        alert,
        productCount: forecast.productCount,
        serviceCount: forecast.serviceCount,
        ...forecast.statusCounts,
      };
    });
  } catch (err) {
    logger.error(`[waveguard-inventory-forecast] failed: ${err.message}`);
    return { skipped: false, error: err.message };
  } finally {
    isRunning = false;
  }
}

module.exports = {
  buildWaveGuardInventoryForecast,
  runWaveGuardInventoryForecastCheck,
  syncForecastAlert,
};
