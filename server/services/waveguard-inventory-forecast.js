const db = require('../models/db');
const logger = require('./logger');
const { buildPlanForService, customerBillingModeColumnExists } = require('./waveguard-plan-engine');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { describeInventoryConversion } = require('./inventory-units');
const { lawnPlanProgramApplies } = require('./lawn-completion-defaults');

// Planner blocks under which waveguard-plan-engine plans NO products for the
// appointment (see propertyGate in buildPlanForService).
const WITHHELD_PLAN_BLOCK_CODES = ['lawn_archived_recipe_unavailable', 'lawn_protocol_unresolved', 'lawn_property_unresolved'];

const ADVISORY_LOCK_KEY = 'waveguard-inventory-forecast-cron';
// How far ahead the daily check and the forecast pages look by default
// (owner 2026-10-26: one week, was 14 days).
const DEFAULT_FORECAST_DAYS = 7;
let isRunning = false;

function numberOrNull(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Demand sums keep full precision and round to 4 decimals once, on the way
// out: rounding each appointment first turned 100 doses of 1 ml into 0.03 gal,
// not 0.0264. exact() drops float noise after each sum, so three 0.1 gal
// doses are 0.3 gal (not 0.30000000000000004) and stock of 0.3 is enough.
const exact = (n) => Number(n.toPrecision(12));
const round4 = (n) => Number(n.toFixed(4));

// The forecast window (days) or row limit a caller asked for: absent means the
// default, a number is held to [1, max], and anything else (a word, "7days")
// is a 400 rather than a NaN date range or LIMIT.
function forecastBound(value, { name, fallback, max }) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw Object.assign(new Error(`${name} must be a number from 1 to ${max}`), { statusCode: 400, isOperational: true });
  }
  return Math.max(1, Math.min(max, Math.floor(n)));
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

async function buildWaveGuardInventoryForecast({ days = DEFAULT_FORECAST_DAYS, limit = 150, knex = db } = {}) {
  const safeDays = forecastBound(days, { name: 'days', fallback: DEFAULT_FORECAST_DAYS, max: 90 });
  const safeLimit = forecastBound(limit, { name: 'limit', fallback: 150, max: 300 });
  const startDate = etDateString();
  const endDate = etDateString(addETDays(new Date(), safeDays));
  // One schema probe for the whole batch — the planner would otherwise
  // probe information_schema once per forecasted service (Codex #4365 r4 P2).
  const billingModeColumnExists = await customerBillingModeColumnExists(knex);
  const servicesQuery = knex('scheduled_services as ss')
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
    });
  // Non-program lanes are excluded BEFORE the limit (Codex #4365 r8 P2): a
  // run of reclassified legacy customers must not consume the window's
  // slots and push real program visits past the cutoff. Same rule as
  // lawnPlanProgramApplies — an explicit one_time lane is not a
  // program (per_visit with a tier is, owner 2026-10-26) unless the appointment
  // carries a COMPLETE assignment; the in-loop predicate below remains the authoritative check on the plan.
  if (billingModeColumnExists) {
    servicesQuery.where(function programLane() {
      this.whereNull('c.billing_mode')
        .orWhereNotIn('c.billing_mode', ['one_time'])
        .orWhere(function completeAssignment() {
          this.whereNotNull('ss.lawn_protocol_key')
            .whereNotNull('ss.lawn_protocol_version')
            .whereNotNull('ss.lawn_protocol_window_key');
        });
    });
  }
  const services = await servicesQuery
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
  const skippedNonProgram = [];

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
      const plan = await buildPlanForService(service.id, { db: knex, billingModeColumnExists });
      const customerName = `${service.first_name || ''} ${service.last_name || ''}`.trim() || 'Customer';
      // Under the lawn completion gates the planner withholds EVERY product
      // when the assigned protocol version/window cannot be resolved
      // (lawn_protocol_unresolved), an archived assignment's recipe no
      // longer reproduces (lawn_archived_recipe_unavailable), or the saved
      // turf profile does not prove the service property
      // (lawn_property_unresolved, sqft 0 → every amount null) — it never
      // borrows a later recipe or another property. Counting any of these as
      // zero demand would read as "nothing needed" and under-order — report
      // it the way a failed plan is.
      const withheldBlock = (plan?.propertyGate?.blocks || [])
        .find((block) => WITHHELD_PLAN_BLOCK_CODES.includes(block.code));
      if (withheldBlock) {
        errors.push({ serviceId: service.id, scheduledDate: service.scheduled_date, customerName, message: withheldBlock.message });
        continue;
      }
      // The visit was admitted by its customer's tier, but an explicit
      // one_time lane with no complete appointment assignment means the calendar protocol is not that customer's program — its
      // products are not committed demand (Codex #4365 r7 P2; same predicate
      // as closeout attribution and the lawn_protocol_* stamp). The lane
      // itself is office-only and stays out of the response (r8 P2).
      if (!lawnPlanProgramApplies(plan)) {
        skippedNonProgram.push({ serviceId: service.id, scheduledDate: service.scheduled_date, customerName });
        continue;
      }
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
          row.committedDemand = exact(row.committedDemand + conversion.amount);
          if (conversion.confidence !== 'exact_unit') row.conversionConfidence = conversion.confidence;
          row.appointments.push(appointment);
        } else {
          row.unconvertedDemand = exact(row.unconvertedDemand + amount);
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
    const demand = row.committedDemand;
    row.projectedRemaining = row.onHand != null ? exact(row.onHand - demand) : null;
    let runningDemand = 0;
    for (const appointment of row.appointments.slice().sort((a, b) => String(a.scheduledDate).localeCompare(String(b.scheduledDate)))) {
      runningDemand = exact(runningDemand + Number(appointment.inventoryAmount || appointment.amount || 0));
      if (row.onHand != null && runningDemand > row.onHand) {
        row.firstShortDate = appointment.scheduledDate;
        break;
      }
    }
    // Status reads the exact sums; the rounded figures are for display.
    row.status = summarizeForecastStatus(row);
    row.committedDemand = round4(demand);
    row.unconvertedDemand = round4(row.unconvertedDemand);
    if (row.projectedRemaining != null) row.projectedRemaining = round4(row.projectedRemaining);
    row.shortfall = row.onHand != null ? Math.max(0, round4(demand - row.onHand)) : null;
    const targetStock = demand + (row.lowStockThreshold != null ? row.lowStockThreshold : demand * 0.25);
    row.targetStock = round4(targetStock);
    row.recommendedOrderQuantity = row.onHand != null
      ? Math.max(0, round4(targetStock - row.onHand))
      : round4(demand || targetStock || 0);
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
    skippedNonProgram,
    generatedAt: new Date().toISOString(),
  };
}

// A technician's forecast (technician visibility audit A2 / C1, owner
// 2026-11-04: "product totals only, names only on the technician's own
// visits"). The product totals are computed over every visit and stay as
// they are. Per-visit rows keep customerName / customerId / city /
// waveguardTier only for visits assigned to the caller (the same
// current-assignment rule every technician visit read uses); every other
// visit loses those fields. A skipped-non-program visit does not enter any
// total, so a foreign one drops out of the list. A foreign plan error stays,
// without the name, so the tab can still say the forecast is incomplete.
const FORECAST_CUSTOMER_FIELDS = ['customerName', 'customerId', 'city', 'waveguardTier'];

function withoutCustomerFields(row) {
  const out = { ...row };
  for (const field of FORECAST_CUSTOMER_FIELDS) delete out[field];
  return out;
}

async function ownForecastServiceIds(forecast, actor, knex) {
  const ids = new Set();
  for (const row of forecast.products || []) {
    for (const appointment of [...(row.appointments || []), ...(row.mismatchAppointments || [])]) ids.add(appointment.serviceId);
  }
  for (const entry of [...(forecast.errors || []), ...(forecast.skippedNonProgram || [])]) ids.add(entry.serviceId);
  ids.delete(undefined);
  ids.delete(null);
  if (!ids.size) return new Set();
  const { technicianCurrentVisitFilter } = require('./technician-visit-scope');
  const rows = await technicianCurrentVisitFilter(
    { techRole: 'technician', technicianId: actor.technicianId },
    knex('scheduled_services').whereIn('scheduled_services.id', [...ids]),
  ).select('scheduled_services.id');
  return new Set(rows.map((row) => String(row.id)));
}

async function forecastForTechnician(forecast, actor, knex = db) {
  const own = await ownForecastServiceIds(forecast, actor, knex);
  const project = (entry) => (own.has(String(entry.serviceId)) ? entry : withoutCustomerFields(entry));
  return {
    ...forecast,
    products: (forecast.products || []).map((row) => ({
      ...row,
      appointments: (row.appointments || []).map(project),
      mismatchAppointments: (row.mismatchAppointments || []).map(project),
    })),
    errors: (forecast.errors || []).map(project),
    skippedNonProgram: (forecast.skippedNonProgram || []).filter((entry) => own.has(String(entry.serviceId))),
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
        days: options.days || DEFAULT_FORECAST_DAYS,
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
  DEFAULT_FORECAST_DAYS,
  buildWaveGuardInventoryForecast,
  forecastForTechnician,
  runWaveGuardInventoryForecastCheck,
  syncForecastAlert,
};
