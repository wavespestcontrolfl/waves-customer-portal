const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin, requireAdmin } = require('../middleware/admin-auth');
const { resolveLocation } = require('../config/locations');
const smsTemplatesRouter = require('./admin-sms-templates');
const logger = require('../services/logger');
const { etDateString, parseETDateTime } = require('../utils/datetime-et');
const trackTransitions = require('../services/track-transitions');
const { resolveTechPhotoUrl } = require('../services/tech-photo');
const CompletionRecap = require('../services/completion-recap');
const CompletionAttempts = require('../services/completion-attempts');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { recordServiceProductNutrients } = require('../services/nutrient-ledger');
const { buildPlanForService, isDateInWindow } = require('../services/waveguard-plan-engine');
const { evaluateWaveGuardManagerApprovals, managerApprovalSummary } = require('../services/waveguard-approval-engine');

// Haversine ETA for the dispatch board tech cards. Returns a whole
// number of minutes, or null when any input is missing or the tech is
// not en route/driving. Internal tool — directional accuracy is enough
// (±25%); avoid Distance Matrix calls on every poll/ping. Road factor
// 1.4× at 30 mph average matches the haversine fallback in
// services/bouncie.js. Floors to 1 min so a tech 100 ft away doesn't
// render "0 min" while still moving.
function computeTechEta(techRow, jobCoords) {
  if (!techRow || !jobCoords) return null;
  if (techRow.status !== 'en_route' && techRow.status !== 'driving') return null;
  const fromLat = techRow.lat == null ? null : Number(techRow.lat);
  const fromLng = techRow.lng == null ? null : Number(techRow.lng);
  const toLat = jobCoords.lat == null ? null : Number(jobCoords.lat);
  const toLng = jobCoords.lng == null ? null : Number(jobCoords.lng);
  if ([fromLat, fromLng, toLat, toLng].some((v) => v == null || Number.isNaN(v))) return null;
  const R = 3959;
  const dLat = (toLat - fromLat) * Math.PI / 180;
  const dLng = (toLng - fromLng) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(fromLat * Math.PI / 180) * Math.cos(toLat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  const distMi = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 1.4;
  return Math.max(1, Math.round((distMi / 30) * 60));
}

async function renderTemplate(templateKey, vars, fallback) {
  try {
    if (typeof smsTemplatesRouter.getTemplate === 'function') {
      const body = await smsTemplatesRouter.getTemplate(templateKey, vars);
      if (body) return body;
    }
  } catch { /* fall through */ }
  return fallback;
}

// Templates say "Your {service_type} service report is ready", but
// many service_type values already end in "Service" / "Services"
// (e.g. "One-Time Pest Control Service") which would duplicate the
// word. Strip the trailing suffix before substitution so output reads
// "Your One-Time Pest Control service report is ready."
function normalizeServiceTypeForTemplate(s) {
  if (!s) return 'your service';
  return s.replace(/\s+services?$/i, '');
}

const VALID_VISIT_OUTCOMES = new Set([
  'completed',
  'inspection_only',
  'customer_declined',
  'follow_up_needed',
  'customer_concern',
  'incomplete',
]);

function isWaveGuardLawnCompletion(svc) {
  const serviceType = String(svc?.service_type || '').toLowerCase();
  return !!svc?.cust_waveguard_tier && serviceType.includes('lawn');
}

function calibrationLockoutBlocks(plan) {
  const lockoutCodes = new Set([
    'missing_calibration',
    'equipment_selection_required',
    'expired_calibration',
  ]);
  return (plan?.equipmentCalibration?.blocks || [])
    .filter((block) => lockoutCodes.has(block.code));
}

function blackoutLockoutBlocks(plan) {
  const lockoutCodes = new Set([
    'nitrogen_blackout',
    'phosphorus_blackout',
  ]);
  return (plan?.propertyGate?.blocks || [])
    .filter((block) => lockoutCodes.has(block.code));
}

function annualNLockoutBlocks(plan) {
  return (plan?.propertyGate?.blocks || [])
    .filter((block) => block.code === 'annual_n_budget_exceeded');
}

function toETNoonServiceDate(value) {
  const dateOnly = value
    ? String(value instanceof Date ? value.toISOString() : value).slice(0, 10)
    : etDateString();
  const parsed = parseETDateTime(`${dateOnly}T12:00`);
  return Number.isNaN(parsed.getTime()) ? parseETDateTime(`${etDateString()}T12:00`) : parsed;
}

function serviceDateOnly(value) {
  return value ? String(value instanceof Date ? value.toISOString() : value).slice(0, 10) : etDateString();
}

async function actualProductBlackoutBlocks(svc, submittedProducts = []) {
  const productIds = [...new Set((submittedProducts || []).map((p) => p.productId).filter(Boolean))];
  if (!productIds.length) return [];

  const [profile, catalogProducts] = await Promise.all([
    db('customer_turf_profiles')
      .where({ customer_id: svc.customer_id, active: true })
      .first()
      .catch(() => null),
    db('products_catalog')
      .whereIn('id', productIds)
      .select('id', 'name', 'analysis_n', 'analysis_p')
      .catch(() => []),
  ]);
  if (!profile) return [];

  const county = String(profile.county || '').trim();
  const city = String(profile.municipality || svc.city || '').trim();
  if (!county && !city) return [];

  let ordinanceQuery = db('municipality_ordinances').where({ active: true });
  ordinanceQuery = ordinanceQuery.where(function () {
    if (county) this.orWhere(function () {
      this.where({ jurisdiction_type: 'county' }).whereILike('county', county);
    });
    if (city) this.orWhere(function () {
      this.where({ jurisdiction_type: 'city' }).whereILike('city', city);
    });
  });
  const ordinances = await ordinanceQuery.catch(() => []);
  if (!ordinances.length) return [];

  const productById = new Map(catalogProducts.map((product) => [String(product.id), product]));
  const hasNitrogen = productIds.some((id) => Number(productById.get(String(id))?.analysis_n || 0) > 0);
  const hasPhosphorus = productIds.some((id) => Number(productById.get(String(id))?.analysis_p || 0) > 0);
  if (!hasNitrogen && !hasPhosphorus) return [];

  const serviceDate = toETNoonServiceDate(svc.scheduled_date);
  const blocks = [];
  for (const rule of ordinances.filter((row) => isDateInWindow(serviceDate, row))) {
    if (rule.restricted_nitrogen && hasNitrogen) {
      blocks.push({
        code: 'actual_nitrogen_blackout',
        severity: 'block',
        message: `${rule.jurisdiction_name} restricts nitrogen; actual completion products include nitrogen.`,
        source: rule.source_name || null,
      });
    }
    if (rule.restricted_phosphorus && hasPhosphorus) {
      blocks.push({
        code: 'actual_phosphorus_blackout',
        severity: 'block',
        message: `${rule.jurisdiction_name} restricts phosphorus; actual completion products include phosphorus.`,
        source: rule.source_name || null,
      });
    }
  }
  return blocks;
}

function normalizeTankCleanout(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const lastProductInTank = String(input.lastProductInTank || input.last_product_in_tank || '').trim().slice(0, 160);
  const cleanoutMethod = String(input.cleanoutMethod || input.cleanout_method || '').trim().slice(0, 160);
  const note = String(input.note || '').trim().slice(0, 500);
  const categoryRaw = String(input.lastProductCategory || input.last_product_category || '').trim().toLowerCase();
  const cleanoutCompleted = input.cleanoutCompleted === true
    || input.cleanout_completed === true
    || String(input.cleanoutCompleted || input.cleanout_completed || '').toLowerCase() === 'yes';
  return {
    lastProductInTank,
    lastProductCategory: categoryRaw || null,
    cleanoutCompleted,
    cleanoutMethod,
    note: note || null,
  };
}

function tankCleanoutLockoutBlocks(cleanout) {
  const blocks = [];
  if (!cleanout?.lastProductInTank) {
    blocks.push({
      code: 'missing_tank_last_product',
      severity: 'block',
      message: 'Record the last product in the tank before completing this WaveGuard lawn visit.',
    });
  }
  if (!cleanout?.cleanoutCompleted) {
    blocks.push({
      code: 'missing_tank_cleanout_confirmation',
      severity: 'block',
      message: 'Confirm tank cleanout before completing this WaveGuard lawn visit.',
    });
  }
  if (!cleanout?.cleanoutMethod) {
    blocks.push({
      code: 'missing_tank_cleanout_method',
      severity: 'block',
      message: 'Record the tank cleanout method before completing this WaveGuard lawn visit.',
    });
  }
  return blocks;
}

function tankCleanoutWarnings(cleanout, selectedCalibration) {
  const equipmentName = String(selectedCalibration?.system_name || selectedCalibration?.name || '').toLowerCase();
  const productText = `${cleanout?.lastProductInTank || ''} ${cleanout?.lastProductCategory || ''}`.toLowerCase();
  const tankTwo = /\b(tank\s*#?\s*2|#2)\b/.test(equipmentName);
  const herbicide = /herbicide|weed|sedge|kyllinga|celsius|dismiss|speedzone|quinclorac|sulfentrazone/.test(productText);
  if (tankTwo && herbicide) {
    return [{
      code: 'tank_2_herbicide_cleanout',
      severity: 'warning',
      message: 'Tank #2 was marked with prior herbicide use; cleanout is recorded for this completion.',
    }];
  }
  return [];
}

function normalizeInventoryUnit(unit) {
  return String(unit || '').trim().toLowerCase().replace(/\s+/g, '_');
}

const INVENTORY_UNITS = {
  fl_oz: { dimension: 'volume', factor: 1 },
  floz: { dimension: 'volume', factor: 1 },
  gal: { dimension: 'volume', factor: 128 },
  gallon: { dimension: 'volume', factor: 128 },
  gallons: { dimension: 'volume', factor: 128 },
  qt: { dimension: 'volume', factor: 32 },
  quart: { dimension: 'volume', factor: 32 },
  pt: { dimension: 'volume', factor: 16 },
  pint: { dimension: 'volume', factor: 16 },
  ml: { dimension: 'volume', factor: 0.033814 },
  l: { dimension: 'volume', factor: 33.814 },
  liter: { dimension: 'volume', factor: 33.814 },
  oz: { dimension: 'ambiguous', factor: 1 },
  ounce: { dimension: 'ambiguous', factor: 1 },
  ounces: { dimension: 'ambiguous', factor: 1 },
  lb: { dimension: 'weight', factor: 16 },
  lbs: { dimension: 'weight', factor: 16 },
  pound: { dimension: 'weight', factor: 16 },
  g: { dimension: 'weight', factor: 0.035274 },
  gram: { dimension: 'weight', factor: 0.035274 },
  kg: { dimension: 'weight', factor: 35.274 },
};

function convertInventoryQuantity(amount, fromUnit, toUnit) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  const from = normalizeInventoryUnit(fromUnit);
  const to = normalizeInventoryUnit(toUnit);
  if (!from || !to || from === to) return n;
  const fromDef = INVENTORY_UNITS[from];
  const toDef = INVENTORY_UNITS[to];
  if (!fromDef || !toDef) return null;
  const fromDimension = fromDef.dimension === 'ambiguous' ? toDef.dimension : fromDef.dimension;
  const toDimension = toDef.dimension === 'ambiguous' ? fromDef.dimension : toDef.dimension;
  if (fromDimension !== toDimension) return null;
  return Number(((n * fromDef.factor) / toDef.factor).toFixed(4));
}

function calculateInventoryCost({ product, deductedAmount, inventoryUnit, amount, amountUnit }) {
  const costPerUnit = product?.cost_per_unit != null ? Number(product.cost_per_unit) : null;
  if (costPerUnit != null && Number.isFinite(costPerUnit) && costPerUnit >= 0) {
    const costUnit = product.cost_unit || inventoryUnit;
    const costQuantity = convertInventoryQuantity(deductedAmount, inventoryUnit, costUnit);
    if (costQuantity != null) {
      return {
        unitCost: costPerUnit,
        costUsed: Number((costQuantity * costPerUnit).toFixed(4)),
      };
    }
  }

  const bestPrice = product?.best_price != null ? Number(product.best_price) : null;
  const unitSizeOz = product?.unit_size_oz != null ? Number(product.unit_size_oz) : null;
  const amountUnitDef = INVENTORY_UNITS[normalizeInventoryUnit(amountUnit)];
  const canonicalOzUnit = amountUnitDef?.dimension === 'volume' ? 'fl_oz' : 'oz';
  const usedOz = convertInventoryQuantity(amount, amountUnit, canonicalOzUnit);
  if (
    bestPrice != null && Number.isFinite(bestPrice) && bestPrice >= 0
    && unitSizeOz != null && Number.isFinite(unitSizeOz) && unitSizeOz > 0
    && usedOz != null
  ) {
    return {
      unitCost: Number((bestPrice / unitSizeOz).toFixed(4)),
      costUsed: Number(((usedOz / unitSizeOz) * bestPrice).toFixed(4)),
    };
  }

  return { unitCost: null, costUsed: null };
}

async function deductProductInventory(trx, {
  product,
  productInput,
  serviceProduct,
  serviceRecord,
  scheduledService,
}) {
  const lockedProduct = await trx('products_catalog')
    .where({ id: product.id })
    .forUpdate()
    .first();
  const inventoryProduct = lockedProduct || product;
  const amount = productInput.totalAmount != null && productInput.totalAmount !== ''
    ? Number(productInput.totalAmount)
    : null;
  const amountUnit = productInput.amountUnit || productInput.rateUnit || null;
  const snapshot = {
    productId: inventoryProduct.id,
    productName: inventoryProduct.name,
    amount,
    amountUnit,
    status: 'not_deducted',
    warning: null,
  };

  if (!amount || !Number.isFinite(amount) || amount <= 0 || !amountUnit) {
    return {
      ...snapshot,
      warning: 'No confirmed product amount was provided, so inventory was not deducted.',
    };
  }

  if (inventoryProduct.inventory_on_hand == null || inventoryProduct.inventory_on_hand === '') {
    return {
      ...snapshot,
      warning: 'Product has no inventory_on_hand value, so inventory was not deducted.',
    };
  }

  const inventoryUnit = inventoryProduct.inventory_unit || amountUnit;
  const deductedAmount = convertInventoryQuantity(amount, amountUnit, inventoryUnit);
  if (deductedAmount == null) {
    return {
      ...snapshot,
      inventoryUnit,
      warning: `Cannot convert ${amountUnit} to ${inventoryUnit}; inventory was not deducted.`,
    };
  }

  const stockBefore = Number(inventoryProduct.inventory_on_hand);
  if (!Number.isFinite(stockBefore)) {
    return {
      ...snapshot,
      inventoryUnit,
      warning: 'Product inventory_on_hand is not numeric, so inventory was not deducted.',
    };
  }
  const stockAfter = Number((stockBefore - deductedAmount).toFixed(4));
  const insufficient = stockAfter < 0;
  const { unitCost, costUsed } = calculateInventoryCost({
    product: inventoryProduct,
    deductedAmount,
    inventoryUnit,
    amount,
    amountUnit,
  });

  await trx('products_catalog')
    .where({ id: inventoryProduct.id })
    .update({ inventory_on_hand: stockAfter, updated_at: new Date() });

  const [movement] = await trx('product_inventory_movements').insert({
    product_id: inventoryProduct.id,
    service_record_id: serviceRecord.id,
    service_product_id: serviceProduct.id,
    scheduled_service_id: scheduledService.id,
    customer_id: scheduledService.customer_id,
    technician_id: scheduledService.technician_id,
    movement_type: 'usage',
    quantity: deductedAmount,
    unit: inventoryUnit,
    unit_cost: unitCost,
    cost_used: costUsed,
    stock_before: stockBefore,
    stock_after: stockAfter,
    lot_number: productInput.lotNumber || productInput.lot_number || null,
    metadata: {
      enteredAmount: amount,
      enteredUnit: amountUnit,
      insufficientStock: insufficient,
    },
  }).returning('*');

  return {
    ...snapshot,
    status: insufficient ? 'deducted_insufficient_stock' : 'deducted',
    movementId: movement.id,
    deductedAmount,
    inventoryUnit,
    unitCost,
    costUsed,
    stockBefore,
    stockAfter,
    remainingStock: stockAfter,
    warning: insufficient ? 'Inventory went below zero after deduction.' : null,
  };
}

function normalizeOfficeApproval(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const reasonCode = String(input.reasonCode || input.reason_code || '').trim().slice(0, 80);
  const note = String(input.note || input.reason || '').trim().slice(0, 500);
  if (!reasonCode) return null;
  return { reasonCode, note };
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function serializeJsonb(value) {
  return JSON.stringify(value ?? null);
}

router.use(adminAuthenticate, requireTechOrAdmin);

// POST /api/admin/dispatch/recap-preview
router.post('/recap-preview', async (req, res, next) => {
  try {
    const result = await CompletionRecap.generateRecap(req.body || {});
    res.json({
      recap: result.recap,
      source: result.source,
      smsPreview: CompletionRecap.composeCompletionSmsPreview({
        recap: result.recap,
        willInvoice: !!req.body?.willInvoice,
        willReview: !!req.body?.willReview && !req.body?.willInvoice,
      }),
    });
  } catch (err) { next(err); }
});

// GET /api/admin/dispatch/today (or /:date)
router.get('/:date?', async (req, res, next) => {
  try {
    // Validate date param — reject non-date strings like "technicians", "products", etc.
    const rawDate = req.params.date;
    if (rawDate && !/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) return next();
    const date = rawDate || etDateString();

    const services = await db('scheduled_services')
      .where({ 'scheduled_services.scheduled_date': date })
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
      .select(
        'scheduled_services.*',
        'customers.first_name', 'customers.last_name', 'customers.phone as customer_phone',
        'customers.address_line1', 'customers.city', 'customers.state', 'customers.zip',
        'customers.waveguard_tier', 'customers.monthly_rate', 'customers.lawn_type',
        'technicians.name as tech_name'
      )
      .orderByRaw('COALESCE(route_order, 999), window_start');

    // Enrich with property preferences and last service
    const enriched = await Promise.all(services.map(async (s) => {
      const prefs = await db('property_preferences').where({ customer_id: s.customer_id }).first();
      const lastService = await db('service_records')
        .where({ customer_id: s.customer_id, status: 'completed' })
        .orderBy('service_date', 'desc').first();
      const statusLog = await db('service_status_log')
        .where({ scheduled_service_id: s.id }).orderBy('created_at');

      // Build property notes
      const alerts = [];
      if (prefs?.neighborhood_gate_code) alerts.push(`Gate: ${prefs.neighborhood_gate_code}`);
      if (prefs?.property_gate_code) alerts.push(`Yard gate: ${prefs.property_gate_code}`);
      if (prefs?.pet_count > 0) alerts.push(`🐾 ${prefs.pet_details || `${prefs.pet_count} pet(s)`}`);
      if (prefs?.pets_secured_plan) alerts.push(`Pet plan: ${prefs.pets_secured_plan}`);
      if (prefs?.chemical_sensitivities) alerts.push(`⚠️ Chemical sensitivity: ${prefs.chemical_sensitivity_details || 'yes'}`);
      if (prefs?.access_notes) alerts.push(prefs.access_notes);
      if (s.notes) alerts.push(s.notes);

      return {
        id: s.id,
        routeOrder: s.route_order,
        customerName: `${s.first_name} ${s.last_name}`,
        customerId: s.customer_id,
        customerPhone: s.customer_phone,
        address: `${s.address_line1}, ${s.city}, ${s.state} ${s.zip}`,
        city: s.city,
        serviceType: s.service_type,
        windowStart: s.window_start,
        windowEnd: s.window_end,
        status: s.status,
        notes: s.notes || '',
        createdAt: s.created_at,
        technicianId: s.technician_id,
        technicianName: s.tech_name,
        customerConfirmed: s.customer_confirmed,
        waveguardTier: s.waveguard_tier,
        monthlyRate: parseFloat(s.monthly_rate || 0),
        estimatedPrice: s.estimated_price != null ? Number(s.estimated_price) : null,
        prepaidAmount: s.prepaid_amount != null ? Number(s.prepaid_amount) : null,
        createInvoiceOnComplete: !!s.create_invoice_on_complete,
        lawnType: s.lawn_type,
        propertyAlerts: alerts,
        lastServiceDate: lastService?.service_date || null,
        lastServiceType: lastService?.service_type || null,
        lastServiceNotes: lastService?.technician_notes?.slice(0, 200) || null,
        actualStartTime: s.actual_start_time,
        actualEndTime: s.actual_end_time,
        serviceTimeMinutes: s.service_time_minutes,
        statusLog: statusLog.map(l => ({ status: l.status, at: l.created_at, notes: l.notes })),
      };
    }));

    // Tech summary
    const techs = {};
    enriched.forEach(s => {
      if (!s.technicianId) return;
      if (!techs[s.technicianId]) {
        techs[s.technicianId] = {
          technicianId: s.technicianId, technicianName: s.technicianName,
          initials: s.technicianName?.split(' ').map(n => n[0]).join('') || '?',
          serviceCount: 0, completedCount: 0,
        };
      }
      techs[s.technicianId].serviceCount++;
      if (s.status === 'completed') techs[s.technicianId].completedCount++;
    });

    res.json({ date, services: enriched, techSummary: Object.values(techs) });
  } catch (err) { next(err); }
});

// PATCH /api/admin/dispatch/:serviceId/note — save the staff-facing appointment note
router.patch('/:serviceId/note', async (req, res, next) => {
  try {
    const { notes } = req.body;
    const text = (notes == null ? '' : String(notes)).slice(0, 2000);
    const updated = await db('scheduled_services')
      .where({ id: req.params.serviceId })
      .update({ notes: text, updated_at: new Date() })
      .returning(['id', 'notes']);
    if (!updated.length) return res.status(404).json({ error: 'Service not found' });
    res.json({ success: true, notes: updated[0].notes });
  } catch (err) { next(err); }
});

// PUT /api/admin/dispatch/:serviceId/status
//
// First call site to migrate to services/job-status.js#transitionJobStatus
// — the canonical sole-writer for scheduled_services.status. Behavior
// changes vs. the prior direct-UPDATE flow:
//
//   1. Atomic guard: the UPDATE is filtered by `WHERE status =
//      fromStatus`, so a concurrent transition between our SELECT
//      and our UPDATE rejects with 0-rowcount → throws → 409. Legacy
//      route was last-write-wins.
//   2. job_status_history insert lands inside the same trx as the
//      status flip (was: never written by this route).
//   3. Auto-resolve of open tech_late / unassigned_overdue alerts is
//      now atomic with the status change, not best-effort outside
//      the trx. Same trx commits or rolls back together.
//   4. customer:job_update + dispatch:job_update broadcasts now fire
//      on every status change through this route (post-commit, via
//      transitionJobStatus). Was: not emitted from here at all. The
//      customer's track page now updates live, and other dispatcher
//      tabs re-render via dispatch:job_update (PR #322 listener).
//   5. actual_start_time / actual_end_time / service_time_minutes
//      land inside the same trx as the status flip (was: same UPDATE
//      statement; semantically equivalent).
//
// What stays the same:
//   - service_status_log INSERT (legacy audit table; not migrating
//     its schema in this PR).
//   - track-transitions.markEnRoute / markComplete / cancel (track_state
//     is a separate customer-visible state machine; en_route still
//     fires the tracking-link SMS via that helper).
//   - activity_log INSERT (admin-side audit, distinct table).
router.put('/:serviceId/status', async (req, res, next) => {
  try {
    const { status: toStatus, notes, lat, lng, notifyCustomer } = req.body;
    const svc = await db('scheduled_services').where('scheduled_services.id', req.params.serviceId)
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
      .select('scheduled_services.*', 'customers.first_name', 'customers.phone as cust_phone', 'customers.city', 'technicians.name as tech_name')
      .first();

    if (!svc) return res.status(404).json({ error: 'Service not found' });

    const fromStatus = svc.status;
    const { transitionJobStatus } = require('../services/job-status');
    try {
      await db.transaction(async (trx) => {
        // Legacy audit row INSIDE the trx so a race rejection (or
        // any other transitionJobStatus throw) rolls it back too.
        // Otherwise a 409 would leave a phantom service_status_log
        // row mismatching scheduled_services.status and
        // job_status_history. Codex P1 on PR #328.
        //
        // service_status_log itself isn't migrated in this PR — it's
        // still consumed by the tech portal + reporting under its
        // legacy schema (lat / lng / notes columns). Wrapping it in
        // the trx makes the audit consistent without changing the
        // table.
        await trx('service_status_log').insert({
          scheduled_service_id: svc.id, status: toStatus,
          changed_by: req.technicianId, lat, lng, notes,
        });

        // Lifecycle timestamps live on the same row as status; flip
        // them inside the same trx so a rollback also rolls back the
        // timestamp change. transitionJobStatus owns the status +
        // updated_at columns (atomic guard); we own the actual_*
        // columns (no constraint conflict).
        const lifecycleUpdates = {};
        if (toStatus === 'on_site') lifecycleUpdates.actual_start_time = trx.fn.now();
        if (toStatus === 'completed') {
          lifecycleUpdates.actual_end_time = trx.fn.now();
          if (svc.actual_start_time) {
            lifecycleUpdates.service_time_minutes = Math.round(
              (Date.now() - new Date(svc.actual_start_time)) / 60000
            );
          }
        }
        if (Object.keys(lifecycleUpdates).length > 0) {
          await trx('scheduled_services').where({ id: svc.id }).update(lifecycleUpdates);
        }

        // Status flip + atomic guard + job_status_history INSERT +
        // overdue-alert auto-resolve, all inside this trx. Broadcasts
        // (customer:job_update, dispatch:job_update, dispatch:alert_resolved)
        // chain on trx.executionPromise — fire post-commit, suppressed
        // on rollback.
        await transitionJobStatus({
          jobId: svc.id,
          fromStatus,
          toStatus,
          transitionedBy: req.technicianId,
          trx,
        });
      });
    } catch (err) {
      // transitionJobStatus throws when fromStatus mismatch — surface
      // as 409 so the client can refetch and retry. Other errors
      // bubble to the outer next(err).
      if (err && err.message && err.message.includes('not in state')) {
        return res.status(409).json({
          error: `Job is no longer in state ${fromStatus} (concurrent transition). Refresh and try again.`,
        });
      }
      throw err;
    }

    // Customer-visible track_state is owned by services/track-transitions.js.
    // The status update above is the operational source-of-truth on
    // scheduled_services; this helper owns track_state, lifecycle
    // timestamps for the customer tracker, and the en-route SMS fire.
    if (toStatus === 'en_route') {
      try {
        await trackTransitions.markEnRoute(svc.id, {
          actorType: 'admin',
          actorId: req.technicianId,
        });
      } catch (e) { logger.error(`[admin-dispatch] markEnRoute failed: ${e.message}`); }
    } else if (toStatus === 'completed') {
      try {
        await trackTransitions.markComplete(svc.id, {
          actorType: 'admin',
          actorId: req.technicianId,
        });
      } catch (e) { logger.error(`[admin-dispatch] markComplete failed: ${e.message}`); }
    } else if (toStatus === 'cancelled') {
      try {
        const AppointmentReminders = require('../services/appointment-reminders');
        await AppointmentReminders.handleCancellation(svc.id, {
          sendNotification: notifyCustomer !== false,
        });
      } catch (e) { logger.error(`[admin-dispatch] cancellation reminder handling failed: ${e.message}`); }

      try {
        await trackTransitions.cancel(svc.id, {
          reason: notes || null,
          actorId: req.technicianId,
        });
      } catch (e) { logger.error(`[admin-dispatch] cancel failed: ${e.message}`); }
    }

    await db('activity_log').insert({
      admin_user_id: req.technicianId, customer_id: svc.customer_id,
      action: toStatus === 'completed' ? 'service_completed' : 'status_changed',
      description: `${svc.tech_name} marked ${svc.service_type} as ${toStatus} for ${svc.first_name}`,
    });

    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/admin/dispatch/:serviceId/complete
router.post('/:serviceId/complete', async (req, res, next) => {
  let completionAttempt = null;
  let markedSucceeded = false;
  let durableCompletionCommitted = false;
  try {
    const {
      idempotencyKey: bodyIdempotencyKey,
      technicianNotes,
      customerConcernText,
      customerRecap,
      visitOutcome = 'completed',
      reviewSuppression = null,
      incompleteReason = null,
      products,
      equipmentSystemId,
      calibrationId,
      soilTemp,
      thatchMeasurement,
      soilPh,
      soilMoisture,
      sendCompletionSms,
      requestReview,
      areasTreated,
      areasServiced,
      customerInteraction,
      officeApproval,
      nLimitApproval,
      managerApproval,
      tankCleanout,
      formResponses,
      formStartedAt,
    } = req.body;
    if (!VALID_VISIT_OUTCOMES.has(visitOutcome)) {
      return res.status(400).json({
        error: `visitOutcome must be one of: ${Array.from(VALID_VISIT_OUTCOMES).join(', ')}`,
      });
    }
    const isIncompleteVisit = visitOutcome === 'incomplete';
    const completionAreas = Array.isArray(areasTreated) ? areasTreated : (Array.isArray(areasServiced) ? areasServiced : []);
    const concernText = typeof customerConcernText === 'string' ? customerConcernText.trim() : '';
    const normalizedOfficeApproval = normalizeOfficeApproval(officeApproval);
    const normalizedNLimitApproval = normalizeOfficeApproval(nLimitApproval);
    const normalizedManagerApproval = normalizeOfficeApproval(managerApproval);
    const normalizedTankCleanout = normalizeTankCleanout(tankCleanout);
    let waveguardBlackoutApproval = null;
    let waveguardNLimitApproval = null;
    let waveguardManagerApproval = null;
    let waveguardTankCleanout = null;
    let inventoryDeductions = [];
    let waveguardEquipmentSystemId = equipmentSystemId || null;
    let waveguardCalibrationId = calibrationId || null;
    const svc = await db('scheduled_services').where('scheduled_services.id', req.params.serviceId)
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
      .select('scheduled_services.*', 'customers.first_name', 'customers.last_name', 'customers.phone as cust_phone', 'customers.city', 'customers.property_type', 'customers.monthly_rate as cust_monthly_rate', 'customers.waveguard_tier as cust_waveguard_tier', 'technicians.name as tech_name')
      .first();

    if (!svc) return res.status(404).json({ error: 'Service not found' });

    const rawIdempotencyKey = req.get('Idempotency-Key') || bodyIdempotencyKey
      || `legacy_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
    const idempotencyKey = String(rawIdempotencyKey).trim().slice(0, 120);
    const claim = await CompletionAttempts.claimCompletionAttempt({
      serviceId: svc.id,
      idempotencyKey,
      requestHash: CompletionAttempts.hashCompletionRequest(req.body),
    });
    if (claim.action === 'replay') return res.json(claim.payload);
    if (claim.action === 'conflict') return res.status(claim.status).json(claim.payload);
    completionAttempt = claim.attempt;
    const resumingCommittedCompletion = claim.action === 'resume';

    if (claim.action === 'proceed' && !isIncompleteVisit && isWaveGuardLawnCompletion(svc)) {
      const plan = await buildPlanForService(svc.id, {
        equipmentSystemId: equipmentSystemId || null,
        calibrationId: calibrationId || null,
      });
      const calibrationBlocks = calibrationLockoutBlocks(plan);
      if (calibrationBlocks.length) {
        const validationErr = new Error('Equipment calibration lockout');
        await CompletionAttempts.markCompletionAttemptFailed(completionAttempt, validationErr);
        return res.status(400).json({
          error: 'Equipment calibration lockout',
          code: 'waveguard_calibration_lockout',
          details: calibrationBlocks.map((block) => block.message),
          blocks: calibrationBlocks,
        });
      }
      const blackoutBlocks = [
        ...blackoutLockoutBlocks(plan),
        ...await actualProductBlackoutBlocks(svc, products),
      ];
      if (blackoutBlocks.length && (!normalizedOfficeApproval || req.techRole !== 'admin')) {
        const validationErr = new Error('WaveGuard fertilizer blackout lockout');
        await CompletionAttempts.markCompletionAttemptFailed(completionAttempt, validationErr);
        return res.status(400).json({
          error: 'Office approval required for fertilizer blackout',
          code: 'waveguard_fertilizer_blackout_lockout',
          details: blackoutBlocks.map((block) => block.message),
          blocks: blackoutBlocks,
        });
      }
      if (blackoutBlocks.length) {
        waveguardBlackoutApproval = {
          ...normalizedOfficeApproval,
          approvedByTechnicianId: req.technicianId,
          approvedByRole: req.techRole || null,
          approvedAt: new Date().toISOString(),
          blocks: blackoutBlocks.map((block) => ({
            code: block.code,
            message: block.message,
            source: block.source || null,
          })),
        };
      }
      const annualNBlocks = annualNLockoutBlocks(plan);
      if (annualNBlocks.length && (!normalizedNLimitApproval || req.techRole !== 'admin')) {
        const validationErr = new Error('WaveGuard annual N budget lockout');
        await CompletionAttempts.markCompletionAttemptFailed(completionAttempt, validationErr);
        return res.status(400).json({
          error: 'Admin approval required for annual N budget limit',
          code: 'waveguard_annual_n_budget_lockout',
          details: annualNBlocks.map((block) => block.message),
          blocks: annualNBlocks,
          annualN: plan?.propertyGate?.annualN || null,
        });
      }
      if (annualNBlocks.length) {
        waveguardNLimitApproval = {
          ...normalizedNLimitApproval,
          approvedByTechnicianId: req.technicianId,
          approvedByRole: req.techRole || null,
          approvedAt: new Date().toISOString(),
          annualN: plan?.propertyGate?.annualN || null,
          blocks: annualNBlocks.map((block) => ({
            code: block.code,
            message: block.message,
          })),
        };
      }
      const managerApprovalCheck = await evaluateWaveGuardManagerApprovals(db, {
        customerId: svc.customer_id,
        service: svc,
        plan,
        products: products || [],
        serviceDate: serviceDateOnly(svc.scheduled_date),
      });
      const managerBlocks = managerApprovalCheck.blocks || [];
      if (managerBlocks.length && (!normalizedManagerApproval || req.techRole !== 'admin')) {
        const validationErr = new Error('WaveGuard manager approval lockout');
        await CompletionAttempts.markCompletionAttemptFailed(completionAttempt, validationErr);
        return res.status(400).json({
          error: 'Admin approval required for WaveGuard protocol exception',
          code: 'waveguard_manager_approval_lockout',
          details: managerBlocks.map((block) => block.message),
          blocks: managerBlocks,
        });
      }
      if (managerBlocks.length) {
        waveguardManagerApproval = managerApprovalSummary(normalizedManagerApproval, managerBlocks, {
          technicianId: req.technicianId,
          role: req.techRole || null,
        });
      }
      const selectedCalibration = plan?.equipmentCalibration?.selected;
      if (selectedCalibration) {
        waveguardEquipmentSystemId = selectedCalibration.equipment_system_id || waveguardEquipmentSystemId;
        waveguardCalibrationId = selectedCalibration.id || waveguardCalibrationId;
      }
      const cleanoutBlocks = tankCleanoutLockoutBlocks(normalizedTankCleanout);
      if (cleanoutBlocks.length) {
        const validationErr = new Error('WaveGuard tank cleanout lockout');
        await CompletionAttempts.markCompletionAttemptFailed(completionAttempt, validationErr);
        return res.status(400).json({
          error: 'Tank cleanout record required',
          code: 'waveguard_tank_cleanout_lockout',
          details: cleanoutBlocks.map((block) => block.message),
          blocks: cleanoutBlocks,
        });
      }
      waveguardTankCleanout = {
        ...normalizedTankCleanout,
        equipmentSystemId: waveguardEquipmentSystemId || null,
        calibrationId: waveguardCalibrationId || null,
        equipmentName: selectedCalibration?.system_name || selectedCalibration?.name || null,
        warnings: tankCleanoutWarnings(normalizedTankCleanout, selectedCalibration),
        recordedByTechnicianId: req.technicianId,
        recordedByRole: req.techRole || null,
        recordedAt: new Date().toISOString(),
      };
    }

    // Status flip + completion artifacts + audit row + lifecycle
    // timestamps, all in one trx. Migrated to
    // services/job-status.js#transitionJobStatus (third call site,
    // after PRs #328 / #329). Atomic guard rejects on fromStatus
    // race (409). Auto-resolve of overdue-family alerts +
    // customer:job_update + dispatch:job_update broadcasts come for
    // free post-commit.
    //
    // service_records + service_products are INSIDE this trx (Codex
    // P1 on #330): the prior version inserted them before the trx,
    // so a race rejection left orphan completion artifacts for a
    // job whose status flip didn't actually happen. Wrapping them
    // in the same trx makes the whole completion atomic — either
    // the row gets all of {service_record, service_products,
    // service_status_log, lifecycle UPDATE, status flip,
    // job_status_history} or none of them.
    //
    // The MOA-violation detector runs AFTER the trx commits — it
    // reads property_application_history (not the just-inserted
    // service_products), so its semantics don't change with the
    // timing move, but it now only fires alerts on a successful
    // completion. Race rejection → no completion → no MOA alert.
    const fromStatus = svc.status;
    const { transitionJobStatus } = require('../services/job-status');
    let record;
    if (resumingCommittedCompletion) {
      record = await db('service_records').where({ id: claim.serviceRecordId }).first();
      if (!record) {
        return res.status(409).json({
          error: 'Completion resume state is missing its service record. Refresh and contact support if this continues.',
          code: 'completion_resume_missing_record',
        });
      }
      durableCompletionCommitted = true;
    } else {
      try {
        await db.transaction(async (trx) => {
          const structuredNotes = {
            visitOutcome,
            requestReview: isIncompleteVisit ? false : requestReview !== false,
            reviewSuppression,
            incompleteReason,
            customerConcernText: concernText || null,
            customerRecap: customerRecap || null,
            areasTreated: completionAreas,
            waveguardEquipmentSystemId,
            waveguardCalibrationId,
            waveguardBlackoutApproval,
            waveguardNLimitApproval,
            waveguardManagerApproval,
            waveguardTankCleanout,
            inventoryDeductions,
          };

        // 1. service_record — the canonical "completion happened" audit.
        // scheduled_service_id is the FK back to the source row so
        // downstream code (e.g., tech-track's photo upload) can resolve
        // record-from-service unambiguously. Codex P1 on PR #340 — the
        // old (customer_id, technician_id, service_date) soft-join
        // collided on same-day same-customer-same-tech double visits.
        [record] = await trx('service_records').insert({
          scheduled_service_id: svc.id,
          customer_id: svc.customer_id, technician_id: svc.technician_id,
          service_date: svc.scheduled_date, service_type: svc.service_type, status: isIncompleteVisit ? 'incomplete' : 'completed',
          technician_notes: technicianNotes || '',
          structured_notes: serializeJsonb(structuredNotes),
          areas_serviced: serializeJsonb(completionAreas),
          customer_interaction: customerInteraction || null,
          soil_temp: soilTemp || null, thatch_measurement: thatchMeasurement || null,
          soil_ph: soilPh || null, soil_moisture: soilMoisture || null,
        }).returning('*');

        const turfProfile = await trx('customer_turf_profiles')
          .where({ customer_id: svc.customer_id, active: true })
          .first()
          .catch(() => null);

        // 2. service_products — children of the service_record.
        if (products?.length) {
          const seenProductIds = new Set();
          const validRateUnits = new Set(['oz', 'fl_oz', 'ml', 'g', 'lb', 'gal', 'oz/gal', 'oz/1000sf', 'lb/1000sf', 'g/1000sf']);
          for (const p of products) {
            if (!p.productId) continue;
            if (seenProductIds.has(p.productId)) continue;
            seenProductIds.add(p.productId);
            if (p.rateUnit && !validRateUnits.has(String(p.rateUnit).toLowerCase())) {
              const err = new Error(`Invalid product unit for ${p.name || p.productId}`);
              err.isOperational = true; err.statusCode = 400;
              throw err;
            }
            const product = await trx('products_catalog').where({ id: p.productId }).first();
            if (!product) {
              const err = new Error(`Product not found: ${p.productId}`);
              err.isOperational = true; err.statusCode = 400;
              throw err;
            }
            if (product.active === false) {
              const err = new Error(`Product is inactive: ${product.name}`);
              err.isOperational = true; err.statusCode = 400;
              throw err;
            }
            const appliedAmount = p.totalAmount != null && p.totalAmount !== ''
              ? parseFloat(p.totalAmount)
              : null;
            const appliedAmountUnit = p.amountUnit || p.rateUnit || null;
            if (appliedAmount != null && (!Number.isFinite(appliedAmount) || appliedAmount <= 0)) {
              const err = new Error(`Invalid product total amount for ${product.name}`);
              err.isOperational = true; err.statusCode = 400;
              throw err;
            }
            if (appliedAmountUnit && !validRateUnits.has(String(appliedAmountUnit).toLowerCase())) {
              const err = new Error(`Invalid product amount unit for ${product.name}`);
              err.isOperational = true; err.statusCode = 400;
              throw err;
            }
            const [serviceProduct] = await trx('service_products').insert({
              service_record_id: record.id,
              product_name: product.name,
              product_category: product.category || p.category || null,
              active_ingredient: product.active_ingredient || null,
              moa_group: product.moa_group || null,
              application_rate: p.rate ? parseFloat(p.rate) : null,
              rate_unit: p.rateUnit || null,
              total_amount: appliedAmount,
              amount_unit: appliedAmountUnit,
            }).returning('*');

            await recordServiceProductNutrients(trx, {
              customerId: svc.customer_id,
              turfProfile,
              serviceRecord: record,
              serviceProduct,
              product,
              applicationDate: svc.scheduled_date,
              blackoutStatus: p.blackoutStatus || null,
            });

            const deduction = await deductProductInventory(trx, {
              product,
              productInput: p,
              serviceProduct,
              serviceRecord: record,
              scheduledService: svc,
            });
            inventoryDeductions.push(deduction);
          }
        }

        if (inventoryDeductions.length) {
          record.structured_notes = {
            ...(record.structured_notes || {}),
            inventoryDeductions,
          };
          await trx('service_records')
            .where({ id: record.id })
            .update({ structured_notes: serializeJsonb(record.structured_notes) });
        }

        // 3. Legacy audit row INSIDE the trx — race rejection rolls it
        // back too (PR #328 / #329 pattern; phantom rows on 409
        // would otherwise mismatch scheduled_services.status and
        // job_status_history).
        await trx('service_status_log').insert({
          scheduled_service_id: svc.id, status: 'completed', changed_by: req.technicianId,
        });

        // 4. Lifecycle timestamps the route owns. transitionJobStatus
        // owns status + updated_at; we own actual_end_time +
        // service_time_minutes. No constraint conflict — separate
        // columns on the same row.
        const lifecycleUpdates = {
          actual_end_time: trx.fn.now(),
          service_time_minutes: svc.actual_start_time
            ? Math.round((Date.now() - new Date(svc.actual_start_time)) / 60000)
            : null,
        };
        await trx('scheduled_services').where({ id: svc.id }).update(lifecycleUpdates);

        // 5. Status flip via the canonical sole-writer.
        await transitionJobStatus({
          jobId: svc.id,
          fromStatus,
          toStatus: 'completed',
          transitionedBy: req.technicianId,
          trx,
        });

        const { createAlert } = require('../services/dispatch-alerts');
        const alertBase = {
          techId: svc.technician_id,
          jobId: svc.id,
          trx,
          payload: {
            status: 'open',
            serviceRecordId: record.id,
            visitOutcome,
            customerId: svc.customer_id,
            customerName: `${svc.first_name || ''} ${svc.last_name || ''}`.trim(),
            serviceType: svc.service_type,
            note: concernText || technicianNotes || null,
          },
        };
        if (visitOutcome === 'customer_concern') {
          await createAlert({ ...alertBase, type: 'customer_concern', severity: 'warn' });
        }
        if (visitOutcome === 'follow_up_needed') {
          await createAlert({ ...alertBase, type: 'follow_up_needed', severity: 'info' });
        }
        if (visitOutcome === 'incomplete') {
          await createAlert({
            ...alertBase,
            type: 'visit_incomplete',
            severity: 'warn',
            payload: { ...alertBase.payload, incompleteReason: incompleteReason || null },
          });
        }

        // The durable completion artifacts are committed, but billing /
        // SMS / review side effects still need to run after commit. Keep
        // the attempt resumable until those side effects finish so a
        // process restart can continue from the service_record instead
        // of replaying a partial success response.
        await CompletionAttempts.markCompletionAttemptSideEffectsPending(
          completionAttempt,
          {
            record,
            response: {
              success: true,
              serviceRecordId: record.id,
              invoiceId: null,
              invoiceTotal: null,
            },
          },
          trx
        );
      });
        durableCompletionCommitted = true;
      } catch (err) {
        if (err && err.message && err.message.includes('not in state')) {
          await CompletionAttempts.markCompletionAttemptFailed(completionAttempt, err);
          return res.status(409).json({
            error: `Job is no longer in state ${fromStatus} (concurrent transition). Refresh and try again.`,
          });
        }
        throw err;
      }
    }

    // The durable completion artifacts are committed. On normal first
    // execution we can now run best-effort follow-up alerts and tracking;
    // on resume we skip those already-committed/operational side paths and
    // continue the customer-visible billing/SMS/review side effects below.

    // MOA-rotation violation detector (third dispatch alert generator).
    // checkLimits looks at property_application_history for past
    // applications — its inputs aren't from the just-inserted
    // service_products, so the timing move from pre-trx to post-trx
    // doesn't change the alert decisions. What it does change: the
    // detector now only fires on a SUCCESSFUL completion. A race
    // rejection (409) returned above and the detector was skipped,
    // avoiding spurious alerts against a non-completion.
    //
    // Best-effort: a failed alert insert shouldn't fail the request.
    // Wrapped in try/catch to keep that contract.
    //
    // Dedupe within one completion: a tech could log multiple products
    // in the same MOA group; we only fire one alert per MOA group per
    // job. Without this guard a 3-product completion in the same
    // violating group would create 3 identical cards.
    if (!isIncompleteVisit && !resumingCommittedCompletion && products?.length) {
      try {
        const LimitChecker = require('../services/application-limits');
        const { createAlert } = require('../services/dispatch-alerts');
        // svc.scheduled_date can land as either a JS Date (node-pg's
        // default DATE parser) or a 'YYYY-MM-DD' string depending on
        // the upstream query path. checkLimits feeds proposedDate into
        // getYearStart() / etParts() which call Intl.DateTimeFormat —
        // a string crashes with RangeError: Invalid time value, and
        // because this whole block is best-effort the completion would
        // silently skip MOA alerts. Normalize to a Date upfront.
        // T12:00:00 keeps us well clear of tz-boundary corner cases.
        // Codex P1 on PR #324.
        const proposedDate = svc.scheduled_date instanceof Date
          ? svc.scheduled_date
          : new Date(`${svc.scheduled_date}T12:00:00`);
        const alertedMoa = new Set();
        for (const p of products) {
          if (!p.productId) continue;
          const result = await LimitChecker.checkLimits(svc.customer_id, p.productId, proposedDate);
          // checkLimits returns blocks (hard_block severity) and
          // warnings (warn/info severity). We surface BOTH for MOA
          // violations — operationally the difference is that hard
          // blocks suggest "this should not have been applied," and
          // warnings suggest "this is right at the edge." Severity
          // on the alert mirrors the source.
          const violations = [
            ...(result.blocks || []).map((v) => ({ ...v, _src: 'block' })),
            ...(result.warnings || []).map((v) => ({ ...v, _src: 'warn' })),
          ];
          for (const v of violations) {
            // Only the MOA-rotation family of limit violations
            // produces moa_violation alerts. Other limit types
            // (annual_max_apps, seasonal_blackout, etc.) are
            // operationally distinct and would belong to other
            // alert kinds.
            if (v.type !== 'moa_rotation_max' && v.type !== 'consecutive_use_max') continue;
            const productCatalog = await db('products_catalog').where({ id: p.productId }).first();
            const moaGroup = productCatalog?.moa_group;
            if (!moaGroup || alertedMoa.has(moaGroup)) continue;
            alertedMoa.add(moaGroup);
            try {
              await createAlert({
                type: 'moa_violation',
                severity: v._src === 'block' ? 'critical' : 'warn',
                techId: svc.technician_id,
                jobId: svc.id,
                payload: {
                  moa_group: moaGroup,
                  product_name: productCatalog?.name || p.name || null,
                  consecutive: v.current,
                  max: v.max,
                  message: v.message,
                },
              });
            } catch (alertErr) {
              logger.error(`[dispatch] moa_violation createAlert failed: ${alertErr.message}`);
            }
          }
        }
      } catch (err) {
        logger.error(`[dispatch] MOA violation check failed (non-blocking): ${err.message}`);
      }
    }

    // Customer-visible track_state → 'complete' so /track/:token stops
    // showing an active en-route/on-property visit after the office closes it.
    // Incomplete visits skip invoice/SMS/review below, but still need a
    // terminal public tracker state.
    if (!resumingCommittedCompletion) {
      try {
        await trackTransitions.markComplete(svc.id, {
          actorType: 'admin',
          actorId: req.technicianId,
        });
      } catch (e) { logger.error(`[admin-dispatch] markComplete failed: ${e.message}`); }
    }

    if (isIncompleteVisit) {
      const responsePayload = {
        success: true,
        serviceRecordId: record.id,
        invoiceId: null,
        invoiceTotal: null,
      };
      await CompletionAttempts.markCompletionAttemptSucceeded(completionAttempt, { record, invoice: null, response: responsePayload });
      markedSucceeded = true;
      return res.json(responsePayload);
    }

    // Invoice + completion SMS:
    //   - If the appointment was flagged `create_invoice_on_complete` (scheduler's
    //     "Create invoice" checkbox) OR the customer is WaveGuard with a monthly_rate,
    //     generate an invoice and send a single combined SMS (report + pay link).
    //   - Otherwise send the plain service-complete SMS (report link only).
    const invoiceAmount = (svc.estimated_price != null && Number(svc.estimated_price) > 0)
      ? Number(svc.estimated_price)
      : (svc.cust_monthly_rate && Number(svc.cust_monthly_rate) > 0 ? Number(svc.cust_monthly_rate) : 0);
    // Skip invoice creation if a paid invoice already exists for this service record
    // (covers the "customer paid prior to service report" case)
    let invoiceCreated = false;
    let payUrl = null;
    let invoice = null;
    let alreadyPaid = false;
    try {
      const existingPaid = await db('invoices')
        .where({ service_record_id: record.id, status: 'paid' })
        .first();
      if (existingPaid) alreadyPaid = true;
    } catch (e) { /* non-blocking */ }
    let existingCompletionInvoice = null;
    try {
      existingCompletionInvoice = await db('invoices')
        .where({ service_record_id: record.id })
        .whereNot('status', 'void')
        .orderBy('created_at', 'desc')
        .first();
      if (!existingCompletionInvoice) {
        existingCompletionInvoice = await db('invoices')
          .where({ scheduled_service_id: svc.id })
          .whereNot('status', 'void')
          .orderBy('created_at', 'desc')
          .first();
        if (existingCompletionInvoice && !existingCompletionInvoice.service_record_id) {
          await db('invoices').where({ id: existingCompletionInvoice.id }).update({
            service_record_id: record.id,
            technician_id: svc.technician_id || existingCompletionInvoice.technician_id || null,
            updated_at: new Date(),
          });
        }
      }
      if (existingCompletionInvoice) {
        invoice = existingCompletionInvoice;
        payUrl = existingCompletionInvoice.token ? `${process.env.PORTAL_URL || 'https://portal.wavespestcontrol.com'}/pay/${existingCompletionInvoice.token}` : null;
        if (existingCompletionInvoice.status === 'paid') alreadyPaid = true;
        else invoiceCreated = true;
      }
    } catch (e) { /* non-blocking */ }
    // If the admin/tech marked this visit prepaid (cash, Zelle, phone CC, etc.)
    // and the recorded amount covers the would-be invoice, skip auto-invoicing.
    const prepaidCovered = svc.prepaid_amount != null
      && Number(svc.prepaid_amount) > 0
      && Number(svc.prepaid_amount) >= invoiceAmount;
    // If the tech already minted an invoice for this visit pre-completion
    // (Charge now → Tap-to-Pay flow), reuse it instead of cutting a second one.
    let preMintedInvoice = null;
    try {
      preMintedInvoice = await db('invoices')
        .where({ scheduled_service_id: svc.id })
        .whereNot('status', 'void')
        .orderBy('created_at', 'desc')
        .first();
    } catch (e) { /* column may not exist pre-migration — non-blocking */ }
    const shouldInvoice = !alreadyPaid && !prepaidCovered && !preMintedInvoice && !existingCompletionInvoice
      && (!!svc.create_invoice_on_complete || !!svc.cust_waveguard_tier) && invoiceAmount > 0;
    // Customer-facing SMS URL must be the canonical portal domain, not
    // the raw Railway URL (CLIENT_URL is set to the Railway hostname on
    // prod for app-internal redirects). PORTAL_URL can override for dev.
    const portalUrl = process.env.PORTAL_URL || 'https://portal.wavespestcontrol.com';

    if (shouldInvoice) {
      try {
        const InvoiceService = require('../services/invoice');
        invoice = await InvoiceService.createFromService(record.id, {
          amount: invoiceAmount,
          description: svc.service_type,
          taxRate: svc.property_type === 'commercial' ? 0.07 : 0,
        });
        invoiceCreated = true;
        payUrl = `${portalUrl}/pay/${invoice.token}`;
      } catch (invErr) {
        logger.error(`[dispatch] Auto-invoice failed (non-blocking): ${invErr.message}`);
      }
    } else if (preMintedInvoice) {
      // Back-link the pre-minted invoice to the freshly created service_record
      // so receipts, /pay enrichment, and reports all resolve correctly.
      try {
        await db('invoices').where({ id: preMintedInvoice.id }).update({
          service_record_id: record.id,
          technician_id: svc.technician_id || preMintedInvoice.technician_id || null,
          updated_at: new Date(),
        });
      } catch (e) { logger.warn(`[dispatch] Could not back-link invoice to service_record: ${e.message}`); }
      invoice = preMintedInvoice;
      payUrl = `${portalUrl}/pay/${preMintedInvoice.token}`;
      // Treat already-paid pre-mint as the same SMS branch as prepaid.
      if (preMintedInvoice.status === 'paid') alreadyPaid = true;
      else invoiceCreated = true;
    }

    // When the tech completes with both "send report" and "ask for review" on,
    // mint the review row now and bundle its short URL into the one completion
    // SMS instead of firing a second message 90-180 min later. Single message
    // lands higher read-rates than two.
    const invoiceBlocksReview = !!invoice && invoice.status !== 'paid';
    const clientSuppressionBlocksReview = reviewSuppression && reviewSuppression !== 'invoice_created';
    const effectiveRequestReview = !!requestReview && !clientSuppressionBlocksReview && !invoiceBlocksReview;

    let bundledReviewUrl = null;
    if (sendCompletionSms && effectiveRequestReview && svc.cust_phone) {
      try {
        const ReviewService = require('../services/review-request');
        bundledReviewUrl = await ReviewService.createInline({
          customerId: svc.customer_id,
          serviceRecordId: record.id,
        });
      } catch (e) { logger.error(`[dispatch] Inline review mint failed: ${e.message}`); }
    }
    const reviewSuffix = bundledReviewUrl
      ? `\n\nEnjoyed the service? A quick review means the world: ${bundledReviewUrl}`
      : '';

    const recordStructuredNotes = parseJsonObject(record.structured_notes);
    const completionSmsAttemptedAt = recordStructuredNotes.completionSmsAttemptedAt
      ? new Date(recordStructuredNotes.completionSmsAttemptedAt).getTime()
      : 0;
    const completionSmsSendingFresh = recordStructuredNotes.completionSmsStatus === 'sending'
      && completionSmsAttemptedAt
      && Date.now() - completionSmsAttemptedAt < 10 * 60 * 1000;
    const completionSmsAlreadyHandled = !!recordStructuredNotes.sentSmsBody
      || recordStructuredNotes.completionSmsStatus === 'sent'
      || completionSmsSendingFresh;

    if (sendCompletionSms && svc.cust_phone && !completionSmsAlreadyHandled) {
      try {
        const displayServiceType = normalizeServiceTypeForTemplate(svc.service_type);
        const recapText = (customerRecap || '').trim();
        const withRecap = (body) => recapText ? `${recapText}\n\n${body}` : body;
        let sentSmsBody = null;
        let sentSmsType = null;
        if (invoiceCreated && payUrl) {
          const fallback = `Hello ${svc.first_name}! Your ${displayServiceType} service report is ready: ${portalUrl}\n\nInvoice for today's visit: ${payUrl}\n\nQuestions or requests? Reply to this message. Thank you for choosing Waves!`;
          const body = await renderTemplate('service_complete_with_invoice', {
            first_name: svc.first_name || '',
            service_type: displayServiceType,
            portal_url: portalUrl,
            pay_url: payUrl,
          }, fallback);
          sentSmsType = 'service_complete_with_invoice';
          sentSmsBody = withRecap(body + reviewSuffix);
        } else if (prepaidCovered || alreadyPaid) {
          const fallback = `Hello ${svc.first_name}! Thanks for your payment today. Your ${displayServiceType} service report is ready: ${portalUrl}\n\nQuestions or requests? Reply to this message. Thank you for choosing Waves!`;
          const body = await renderTemplate('service_complete_prepaid', {
            first_name: svc.first_name || '',
            service_type: displayServiceType,
            portal_url: portalUrl,
          }, fallback);
          sentSmsType = 'service_complete_prepaid';
          sentSmsBody = withRecap(body + reviewSuffix);
        } else {
          const fallback = `Hello ${svc.first_name}! Your service report is ready. View it here: ${portalUrl}\n\nQuestions or requests? Reply to this message. Thank you for choosing Waves!`;
          const body = await renderTemplate('service_complete', { first_name: svc.first_name || '' }, fallback);
          sentSmsType = 'service_complete';
          sentSmsBody = withRecap(body + reviewSuffix);
        }
        if (sentSmsBody) {
          const sendingNotes = {
            ...recordStructuredNotes,
            completionSmsStatus: 'sending',
            completionSmsType: sentSmsType,
            completionSmsBody: sentSmsBody,
            completionSmsAttemptedAt: new Date().toISOString(),
          };
          await db('service_records').where({ id: record.id }).update({
            structured_notes: serializeJsonb(sendingNotes),
          });
          const smsResult = await sendCustomerMessage({
            to: svc.cust_phone,
            body: sentSmsBody,
            channel: 'sms',
            audience: 'customer',
            purpose: 'appointment',
            customerId: svc.customer_id,
            appointmentId: svc.id,
            identityTrustLevel: 'phone_matches_customer',
            metadata: { original_message_type: sentSmsType, service_record_id: record.id },
          });
          if (!smsResult.sent) {
            const failedNotes = {
              ...sendingNotes,
              completionSmsStatus: smsResult.blocked ? 'blocked' : 'failed',
              completionSmsError: smsResult.reason || smsResult.code || 'SMS send failed',
              completionSmsFailedAt: new Date().toISOString(),
            };
            await db('service_records').where({ id: record.id }).update({
              structured_notes: serializeJsonb(failedNotes),
            });
            logger.warn(`[dispatch] Completion SMS blocked/failed for customer ${svc.customer_id}: ${smsResult.code || smsResult.reason || 'unknown'}`);
          } else {
            const sentNotes = {
              ...sendingNotes,
              completionSmsStatus: 'sent',
              sentSmsBody,
              sentSmsAt: new Date().toISOString(),
              sentSmsType,
            };
            await db('service_records').where({ id: record.id }).update({
              structured_notes: serializeJsonb(sentNotes),
            });
            record.structured_notes = sentNotes;
          }
        }
      } catch (e) { logger.error(`Completion SMS failed: ${e.message}`); }
    } else if (sendCompletionSms && svc.cust_phone && completionSmsAlreadyHandled) {
      logger.info(`[dispatch] Completion SMS already sent for service_record ${record.id}; skipping retry send`);
    }

    // Only schedule the delayed follow-up message when the review wasn't
    // already bundled into the completion SMS above.
    if (effectiveRequestReview && svc.cust_phone && !bundledReviewUrl) {
      try {
        const ReviewService = require('../services/review-request');
        await ReviewService.create({
          customerId: svc.customer_id,
          serviceRecordId: record.id,
          triggeredBy: 'auto',
          delayMinutes: 120,
        });
      } catch (e) { logger.error(`[dispatch] Review request schedule failed: ${e.message}`); }
    }

    if (!resumingCommittedCompletion) {
      try {
        await db('activity_log').insert({
          admin_user_id: req.technicianId, customer_id: svc.customer_id,
          action: 'service_completed',
          description: `${svc.tech_name} completed ${svc.service_type} for ${svc.first_name} ${svc.last_name}`,
        });
      } catch (e) {
        logger.error(`[dispatch] activity log insert failed after completion: ${e.message}`);
      }
    }

    // Job form submission (non-blocking)
    if (!resumingCommittedCompletion && formResponses) {
      try {
        const JobForm = require('../services/job-form');
        await JobForm.saveSubmission({
          scheduledServiceId: svc.id,
          serviceRecordId: record.id,
          technicianId: svc.technician_id,
          customerId: svc.customer_id,
          serviceType: svc.service_type,
          responses: formResponses,
          startedAt: formStartedAt || null,
        });
      } catch (e) { logger.error(`[dispatch] Job form save failed (non-blocking): ${e.message}`); }
    }

    // Job costing (non-blocking, fire-and-forget)
    if (!resumingCommittedCompletion) {
      try {
        const JobCosting = require('../services/job-costing');
        void JobCosting.calculateJobCost(svc.id).catch(e =>
          logger.error(`[dispatch] Job cost calc failed: ${e.message}`)
        );
      } catch (e) { logger.error(`[dispatch] Job costing require failed: ${e.message}`); }
    }

    const responsePayload = {
      success: true,
      serviceRecordId: record.id,
      invoiceId: invoice?.id || null,
      invoiceTotal: invoice?.total != null ? Number(invoice.total) : null,
    };
    // Refresh the stored response with the final invoice info — this is an
    // UPDATE of an already-succeeded row (set above immediately after the
    // trx commit), not a state transition.
    await CompletionAttempts.markCompletionAttemptSucceeded(completionAttempt, { record, invoice, response: responsePayload });
    markedSucceeded = true;
    res.json(responsePayload);
  } catch (err) {
    // Only mark failed if we haven't already marked succeeded. After the
    // durable trx commits and the attempt is succeeded, an unhandled throw
    // in a recoverable side effect must NOT flip it back — that would
    // allow a retry to re-create service_record / invoice / SMS.
    if (!markedSucceeded && !durableCompletionCommitted) {
      await CompletionAttempts.markCompletionAttemptFailed(completionAttempt, err);
    } else {
      logger.error(
        `[dispatch] Post-commit error in /complete (attempt ${completionAttempt?.id} remains resumable): ${err.message}`
      );
    }
    next(err);
  }
});

// PUT /api/admin/dispatch/:serviceId/reorder
router.put('/:serviceId/reorder', async (req, res, next) => {
  try {
    await db('scheduled_services').where({ id: req.params.serviceId }).update({ route_order: req.body.routeOrder });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// PUT /api/admin/dispatch/reorder-bulk
router.put('/reorder/bulk', async (req, res, next) => {
  try {
    const { order } = req.body;
    for (const item of order) {
      await db('scheduled_services').where({ id: item.serviceId }).update({ route_order: item.routeOrder });
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /api/admin/dispatch/products/catalog
router.get('/products/catalog', async (req, res, next) => {
  try {
    const products = await db('products_catalog').where({ active: true }).orderBy('category').orderBy('name');
    res.json({ products });
  } catch (err) { next(err); }
});

// =========================================================================
// RESCHEDULE ENDPOINTS
// =========================================================================
const SmartRebooker = require('../services/rebooker');
const ForecastAnalyzer = require('../services/forecast-analyzer');

// GET /api/admin/dispatch/:serviceId/reschedule-options
router.get('/:serviceId/reschedule-options', async (req, res, next) => {
  try {
    const options = await SmartRebooker.findRescheduleOptions(req.params.serviceId);
    res.json({ options });
  } catch (err) { next(err); }
});

// POST /api/admin/dispatch/:serviceId/reschedule
router.post('/:serviceId/reschedule', async (req, res, next) => {
  try {
    const { newDate, newWindow, reasonCode, reasonText, notifyCustomer, scope } = req.body;

    // Series scope shifts every future occurrence — skip the customer-confirm
    // SMS path (which only handles a single appt) and commit directly.
    if (scope === 'series') {
      const result = await SmartRebooker.rescheduleSeries(req.params.serviceId, newDate, newWindow, reasonCode || 'admin', 'admin');
      return res.json(result);
    }

    const rescheduleOptions = {};
    const hasTechnicianId = Object.prototype.hasOwnProperty.call(req.body || {}, 'technicianId');
    if (hasTechnicianId) {
      if (req.techRole !== 'admin') return res.status(403).json({ error: 'Admin access required' });
      const rawTechId = req.body.technicianId;
      if (rawTechId !== null && typeof rawTechId !== 'string') {
        return res.status(400).json({ error: 'technicianId must be a UUID string or null' });
      }
      const newTechId = rawTechId || null;
      const job = await db('scheduled_services').where({ id: req.params.serviceId }).first();
      if (!job) return res.status(404).json({ error: 'Service not found' });
      if (['completed', 'cancelled', 'skipped'].includes(job.status)) {
        return res.status(409).json({ error: `Cannot reassign a ${job.status} job` });
      }
      if (newTechId) {
        const tech = await db('technicians').where({ id: newTechId }).first();
        if (!tech) return res.status(400).json({ error: 'Unknown technician' });
        if (!tech.active) return res.status(400).json({ error: 'Technician is inactive' });
      }
      rescheduleOptions.technicianId = newTechId;
    }
    const result = await SmartRebooker.reschedule(req.params.serviceId, newDate, newWindow, reasonCode || 'admin', 'admin', rescheduleOptions);
    if (notifyCustomer !== false) {
      const svc = await db('scheduled_services')
        .where('scheduled_services.id', req.params.serviceId)
        .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
        .select('scheduled_services.*', 'customers.first_name', 'customers.phone', 'customers.id as customer_id')
        .first();
      let notificationSent = false;
      let notificationError = null;
      if (!svc?.phone) {
        notificationError = 'Customer phone unavailable';
      } else {
        const displayDate = new Date(String(svc.scheduled_date).split('T')[0] + 'T12:00:00')
          .toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/New_York' });
        const windowText = svc.window_start && svc.window_end ? `, ${svc.window_start}-${svc.window_end}` : '';
        try {
          const msg = await sendCustomerMessage({
            to: svc.phone,
            body: `Hi ${svc.first_name || 'there'}, your Waves appointment has been rescheduled for ${displayDate}${windowText}. We'll remind you the day before. - Waves`,
            channel: 'sms',
            audience: 'customer',
            purpose: 'appointment',
            customerId: svc.customer_id,
            identityTrustLevel: 'phone_matches_customer',
            metadata: { original_message_type: 'reschedule_confirmation', reasonText },
          });
          notificationSent = !(msg?.blocked || msg?.sent === false);
          if (!notificationSent) notificationError = msg?.code || msg?.reason || 'blocked';
        } catch (err) {
          notificationError = err.message;
          logger.warn(`[dispatch] Reschedule committed for ${req.params.serviceId}, but SMS notification failed: ${err.message}`);
        }
      }
      return res.json({ ...result, notificationSent, notificationError });
    }
    res.json(result);
  } catch (err) {
    if (err?.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

// GET /api/admin/dispatch/weather/tomorrow
router.get('/weather/tomorrow', async (req, res, next) => {
  try {
    const analysis = await ForecastAnalyzer.analyzeTomorrow();
    res.json(analysis);
  } catch (err) { next(err); }
});

// GET /api/admin/dispatch/reschedules/log
router.get('/reschedules/log', async (req, res, next) => {
  try {
    const logs = await db('reschedule_log')
      .leftJoin('customers', 'reschedule_log.customer_id', 'customers.id')
      .leftJoin('scheduled_services', 'reschedule_log.scheduled_service_id', 'scheduled_services.id')
      .select('reschedule_log.*', 'customers.first_name', 'customers.last_name',
        'scheduled_services.service_type')
      .orderBy('reschedule_log.created_at', 'desc')
      .limit(50);

    // Stats
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
    const stats = await db('reschedule_log').where('created_at', '>=', thirtyDaysAgo)
      .select('reason_code').count('* as count').groupBy('reason_code');
    const avgResponse = await db('reschedule_log').where('created_at', '>=', thirtyDaysAgo)
      .whereNotNull('response_time_minutes')
      .avg('response_time_minutes as avg').first();
    const autoConfirmed = await db('reschedule_log').where('created_at', '>=', thirtyDaysAgo)
      .whereIn('customer_response', ['option_1', 'option_2']).count('* as count').first();
    const total30 = await db('reschedule_log').where('created_at', '>=', thirtyDaysAgo).count('* as count').first();

    res.json({
      logs: logs.map(l => ({
        id: l.id, customerName: l.first_name ? `${l.first_name} ${l.last_name}` : 'Unknown',
        serviceType: l.service_type, originalDate: l.original_date, newDate: l.new_date,
        reasonCode: l.reason_code, initiatedBy: l.initiated_by,
        customerResponse: l.customer_response, responseTime: l.response_time_minutes,
        escalated: l.escalated, createdAt: l.created_at,
      })),
      stats: {
        total: parseInt(total30?.count || 0),
        byReason: Object.fromEntries(stats.map(s => [s.reason_code, parseInt(s.count)])),
        avgResponseMinutes: Math.round(parseFloat(avgResponse?.avg || 0)),
        autoConfirmedRate: total30?.count > 0 ? Math.round((parseInt(autoConfirmed?.count || 0) / parseInt(total30.count)) * 100) : 0,
      },
    });
  } catch (err) { next(err); }
});

// GET /api/admin/dispatch/board — phase 2 dispatch board v1 hydration.
// Returns techs (left-pane roster) + today's jobs (map pins). Single
// payload to avoid a flash of stale state on the map. Real-time updates
// from there ride dispatch:tech_status broadcasts (PR #284); the client
// uses the `jobs` array as a lookup table for current_job_id → address.
//
// Filter rules (per phase 2 brief):
//   - techs[]:  technicians.role IN ('admin','technician') AND active=TRUE,
//               must have a tech_status row with updated_at >= NOW()-24h
//               (rolling window, not midnight ET — avoids the "tech pinged
//               at 11:50pm last night, card disappears at midnight" gap).
//   - jobs[]:   all scheduled_services WHERE scheduled_date = today (ET),
//               regardless of assignment, so unassigned pins still show
//               on the map in a neutral color.
//
// Address is normalized into a single string at this layer — clients
// don't see the schema's composable shape (address_line1/line2/city/
// state/zip). If the address representation changes later, only this
// endpoint touches it.
//
// Admin-only — requireAdmin (not requireTechOrAdmin) per the brief.
router.get('/board', requireAdmin, async (req, res, next) => {
  try {
    const today = etDateString();

    const techRows = await db.raw(
      `
      SELECT
        t.id,
        t.name,
        t.avatar_url,
        t.photo_s3_key,
        t.role,
        ts.status,
        ts.lat,
        ts.lng,
        ts.current_job_id,
        ts.updated_at,
        COALESCE(today_agg.total, 0)     AS today_total,
        COALESCE(today_agg.completed, 0) AS today_completed
      FROM technicians t
      INNER JOIN tech_status ts ON ts.tech_id = t.id
      LEFT JOIN (
        SELECT
          technician_id,
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE status = 'completed') AS completed
        FROM scheduled_services
        WHERE scheduled_date = ?
          AND technician_id IS NOT NULL
        GROUP BY technician_id
      ) today_agg ON today_agg.technician_id = t.id
      WHERE t.role IN ('admin','technician')
        AND t.active = TRUE
        AND ts.updated_at >= NOW() - INTERVAL '24 hours'
      ORDER BY t.name
      `,
      [today]
    );

    const jobRows = await db.raw(
      `
      SELECT
        s.id,
        s.technician_id,
        s.customer_id,
        COALESCE(s.lat, c.latitude)  AS lat,
        COALESCE(s.lng, c.longitude) AS lng,
        s.status,
        s.service_type,
        s.scheduled_date,
        s.window_start,
        s.window_end,
        c.first_name,
        c.last_name,
        c.address_line1,
        c.address_line2,
        c.city,
        c.state,
        c.zip
      FROM scheduled_services s
      INNER JOIN customers c ON c.id = s.customer_id
      WHERE s.scheduled_date = ?
      ORDER BY s.window_start NULLS LAST, c.last_name
      `,
      [today]
    );

    // Avatar URL: presign the canonical photo_s3_key (set by
    // POST /api/admin/timetracking/technicians/:id/photo) at response
    // time inside this admin-only route. Falls back to the row's
    // avatar_url for techs whose avatar lives at an external host.
    // Same pattern as track-public.js — see services/tech-photo.js.
    // Admin auth is the trusted-context boundary that keeps the
    // presigned URL out of unauth hands.
    //
    // ETA: when the tech is en_route or driving toward an assigned
    // current_job, compute a haversine-based ETA in minutes (road
    // factor 1.4× at 30 mph avg). Haversine instead of Distance
    // Matrix because dispatch board hydration runs on every admin
    // refresh + every Bouncie ping — Distance Matrix would burn
    // quota for sub-percent accuracy gains. Internal tool, ±25%
    // is fine. Omitted for on_site/idle/break states.
    const jobsById = new Map();
    for (const j of (jobRows.rows || [])) {
      jobsById.set(j.id, { lat: j.lat, lng: j.lng });
    }
    const techs = await Promise.all((techRows.rows || []).map(async (r) => ({
      id: r.id,
      name: r.name,
      avatar_url: await resolveTechPhotoUrl(r.photo_s3_key, r.avatar_url),
      role: r.role,
      status: r.status,
      lat: r.lat == null ? null : Number(r.lat),
      lng: r.lng == null ? null : Number(r.lng),
      current_job_id: r.current_job_id || null,
      eta_minutes: computeTechEta(r, jobsById.get(r.current_job_id)),
      updated_at: r.updated_at,
      today_total: parseInt(r.today_total, 10) || 0,
      today_completed: parseInt(r.today_completed, 10) || 0,
    })));

    const jobs = (jobRows.rows || []).map((r) => {
      // Address normalization at the API boundary. Clients render this
      // string directly; the schema's address_line1/line2/city/state/zip
      // shape stays internal.
      const line1 = r.address_line1 || '';
      const line2 = r.address_line2 ? ` ${r.address_line2}` : '';
      const cityState = r.city ? `, ${r.city}` : '';
      const stateZip = r.state ? `, ${r.state}${r.zip ? ` ${r.zip}` : ''}` : '';
      const address = `${line1}${line2}${cityState}${stateZip}`.trim();

      // Customer name: first name + last initial, e.g. "Sarah M."
      // Admin-channel safe (this is the dispatch board, not customer-
      // facing) but truncated keeps map pin tooltips readable. Last
      // name stays in detail-view fetches.
      const lastInitial = r.last_name ? r.last_name.trim().charAt(0).toUpperCase() : '';
      const customer_name = lastInitial
        ? `${r.first_name} ${lastInitial}.`
        : (r.first_name || '');

      return {
        id: r.id,
        technician_id: r.technician_id || null,
        customer_id: r.customer_id,
        customer_name,
        address,
        lat: r.lat == null ? null : Number(r.lat),
        lng: r.lng == null ? null : Number(r.lng),
        status: r.status,
        service_type: r.service_type || null,
        scheduled_date: r.scheduled_date,
        window_start: r.window_start || null,
        window_end: r.window_end || null,
      };
    });

    res.json({ techs, jobs });
  } catch (err) {
    logger.error(`[dispatch/board] hydration failed: ${err.message}`);
    next(err);
  }
});

// GET /api/admin/dispatch/jobs/:id — drawer hydration.
//
// Richer payload than dispatch:job_update (the broadcast event):
// includes the full customer last name + phone + email so the
// dispatcher can identify "whose house" at a glance and call them
// without leaving the drawer. Same admin-only scope as /board.
//
// Distinct from the broadcast event because:
//   - Broadcasts must stay narrow (re-render the roster + map without
//     a refetch); the drawer is on-demand and can carry richer data
//     that the user explicitly opened.
//   - Customer last name was redacted from dispatch:job_update because
//     a stale broadcast on a customer:* room could leak it; the drawer
//     fetches over an admin-authenticated GET so the same constraint
//     doesn't apply.
//
// Admin-only via requireAdmin (same as /board).
router.get('/jobs/:id', requireAdmin, async (req, res, next) => {
  try {
    const row = await db('scheduled_services as s')
      .leftJoin('technicians as t', 's.technician_id', 't.id')
      .innerJoin('customers as c', 's.customer_id', 'c.id')
      .where('s.id', req.params.id)
      .first(
        's.id as job_id',
        's.customer_id',
        's.technician_id as tech_id',
        's.status',
        's.service_type',
        's.scheduled_date',
        's.window_start',
        's.window_end',
        's.notes',
        's.internal_notes',
        's.lat as svc_lat',
        's.lng as svc_lng',
        's.updated_at',
        't.name as tech_full_name',
        'c.first_name as cust_first_name',
        'c.last_name as cust_last_name',
        'c.phone as cust_phone',
        'c.email as cust_email',
        'c.address_line1',
        'c.address_line2',
        'c.city',
        'c.state',
        'c.zip',
        'c.latitude as cust_lat',
        'c.longitude as cust_lng'
      );

    if (!row) return res.status(404).json({ error: 'Job not found' });

    // Same address normalization as /board so client renders are
    // consistent across the two surfaces.
    const line1 = row.address_line1 || '';
    const line2 = row.address_line2 ? ` ${row.address_line2}` : '';
    const cityState = row.city ? `, ${row.city}` : '';
    const stateZip = row.state ? `, ${row.state}${row.zip ? ` ${row.zip}` : ''}` : '';
    const address = `${line1}${line2}${cityState}${stateZip}`.trim();

    const lat = row.svc_lat == null ? (row.cust_lat == null ? null : Number(row.cust_lat)) : Number(row.svc_lat);
    const lng = row.svc_lng == null ? (row.cust_lng == null ? null : Number(row.cust_lng)) : Number(row.svc_lng);

    return res.json({
      id: row.job_id,
      customer_id: row.customer_id,
      customer_first_name: row.cust_first_name,
      customer_last_name: row.cust_last_name,   // full last name OK on admin GET
      customer_phone: row.cust_phone || null,
      customer_email: row.cust_email || null,
      address,
      lat,
      lng,
      tech_id: row.tech_id || null,
      tech_full_name: row.tech_full_name || null,
      status: row.status,
      service_type: row.service_type || null,
      scheduled_date: row.scheduled_date,
      window_start: row.window_start || null,
      window_end: row.window_end || null,
      notes: row.notes || null,
      internal_notes: row.internal_notes || null,
      updated_at: row.updated_at,
    });
  } catch (err) {
    logger.error(`[dispatch/jobs/:id] hydration failed: ${err.message}`);
    next(err);
  }
});

// GET /api/admin/dispatch/techs/:id — tech drawer hydration.
//
// Returns tech basics + current tech_status + today's route (one row
// per scheduled_services for tech_id today, ET) + roll-up counts
// (completed / total / open tech_late).
//
// Mirrors GET /jobs/:id in shape: richer than a broadcast, on-demand,
// admin-only via requireAdmin. Surfaces the dispatcher's "is this
// tech on track today" question without having to scan the map +
// roster + action queue.
//
// Address is normalized identically to /board and /jobs/:id so the
// drawer's route list looks the same as the rest of the dispatch
// surfaces. Customer last name is included (full, not initial) since
// this is an admin-authenticated GET — same scope decision as
// /jobs/:id.
router.get('/techs/:id', requireAdmin, async (req, res, next) => {
  try {
    const tech = await db('technicians as t')
      .leftJoin('tech_status as ts', 't.id', 'ts.tech_id')
      .where('t.id', req.params.id)
      .first(
        't.id', 't.name', 't.role', 't.phone', 't.email', 't.active',
        'ts.status', 'ts.lat', 'ts.lng', 'ts.current_job_id',
        'ts.updated_at as status_updated_at'
      );
    if (!tech) return res.status(404).json({ error: 'Tech not found' });

    // Anchor the route to "today in ET" so a dispatcher in Bradenton
    // sees the same day boundary as the detector cron + /board.
    const today = (await db.raw(
      `SELECT (NOW() AT TIME ZONE 'America/New_York')::date AS d`
    )).rows[0].d;

    const routeRows = await db('scheduled_services as s')
      .leftJoin('customers as c', 's.customer_id', 'c.id')
      .where('s.technician_id', tech.id)
      .where('s.scheduled_date', today)
      .orderBy('s.window_start', 'asc')
      .select(
        's.id as job_id',
        's.status',
        's.service_type',
        's.scheduled_date',
        's.window_start',
        's.window_end',
        'c.first_name as cust_first_name',
        'c.last_name as cust_last_name',
        'c.address_line1',
        'c.address_line2',
        'c.city',
        'c.state',
        'c.zip'
      );

    const completed = routeRows.filter((r) => r.status === 'completed').length;
    const total = routeRows.length;

    // Open tech_late alerts scoped to this tech today. Used as the
    // headline "N late" stat in the drawer header. Counts any
    // unresolved tech_late where tech_id matches; the partial unique
    // index keeps this O(open-rows-for-tech).
    const lateRow = await db('dispatch_alerts')
      .where({ type: 'tech_late', tech_id: tech.id })
      .whereNull('resolved_at')
      .count({ count: '*' })
      .first();

    function normalizeAddress(r) {
      const line1 = r.address_line1 || '';
      const line2 = r.address_line2 ? ` ${r.address_line2}` : '';
      const cityState = r.city ? `, ${r.city}` : '';
      const stateZip = r.state ? `, ${r.state}${r.zip ? ` ${r.zip}` : ''}` : '';
      return `${line1}${line2}${cityState}${stateZip}`.trim();
    }

    return res.json({
      id: tech.id,
      name: tech.name,
      role: tech.role || 'technician',
      phone: tech.phone || null,
      email: tech.email || null,
      active: tech.active,
      status: tech.status || 'idle',
      current_job_id: tech.current_job_id || null,
      lat: tech.lat == null ? null : Number(tech.lat),
      lng: tech.lng == null ? null : Number(tech.lng),
      status_updated_at: tech.status_updated_at || null,
      today: {
        scheduled_date: today,
        completed,
        total,
        late_count: Number(lateRow?.count) || 0,
      },
      route: routeRows.map((r) => ({
        job_id: r.job_id,
        customer_first_name: r.cust_first_name,
        customer_last_name: r.cust_last_name,
        address: normalizeAddress(r),
        service_type: r.service_type || null,
        scheduled_date: r.scheduled_date,
        window_start: r.window_start || null,
        window_end: r.window_end || null,
        status: r.status,
      })),
    });
  } catch (err) {
    logger.error(`[dispatch/techs/:id] hydration failed: ${err.message}`);
    next(err);
  }
});

// GET /api/admin/dispatch/alerts — action queue read endpoint.
//
// Returns dispatch_alerts rows enriched with tech_name + customer
// context + address so the right-pane can render cards without
// follow-up fetches per alert. Filtered by ?unresolved=true (default
// true; pass ?unresolved=false to include resolved alerts in audit
// views).
//
// Default ORDER BY created_at DESC (newest first) — that's the
// dispatch board's primary read pattern. ?limit caps the result;
// default 50, max 200 to keep payloads bounded if the table grows.
//
// Distinct from the dispatch:alert socket broadcast (PR #293):
// broadcast carries the bare row at insert time (cheap, narrow);
// this GET returns enriched rows (tech name, customer, address) for
// the right-pane's hydration. The action queue UI degrades
// gracefully when broadcast-only rows are missing the enriched
// fields.
//
// Admin-only (matches /board and /jobs/:id).
router.get('/alerts', requireAdmin, async (req, res, next) => {
  try {
    const unresolved = req.query.unresolved !== 'false';
    const requestedLimit = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 200)
      : 50;

    const q = db('dispatch_alerts as a')
      .leftJoin('technicians as t', 'a.tech_id', 't.id')
      .leftJoin('scheduled_services as s', 'a.job_id', 's.id')
      .leftJoin('customers as c', 's.customer_id', 'c.id')
      .select(
        'a.id',
        'a.type',
        'a.severity',
        'a.tech_id',
        'a.job_id',
        'a.payload',
        'a.created_at',
        'a.resolved_at',
        'a.resolved_by',
        't.name as tech_name',
        'c.first_name as customer_first_name',
        'c.last_name as customer_last_name',
        'c.address_line1',
        'c.address_line2',
        'c.city',
        'c.state',
        'c.zip',
        's.service_type',
        's.scheduled_date',
        's.window_start',
        's.window_end'
      )
      .orderBy('a.created_at', 'desc')
      .limit(limit);

    if (unresolved) q.whereNull('a.resolved_at');

    const rows = await q;

    const alerts = rows.map((r) => {
      // Address normalization, same shape as /board and /jobs/:id.
      // Null-safe — alerts can be tech-scoped or job-scoped or neither,
      // so customer/job fields may all be null.
      let address = null;
      if (r.address_line1) {
        const line2 = r.address_line2 ? ` ${r.address_line2}` : '';
        const cityState = r.city ? `, ${r.city}` : '';
        const stateZip = r.state ? `, ${r.state}${r.zip ? ` ${r.zip}` : ''}` : '';
        address = `${r.address_line1}${line2}${cityState}${stateZip}`.trim();
      }

      return {
        id: r.id,
        type: r.type,
        severity: r.severity,
        tech_id: r.tech_id,
        tech_name: r.tech_name || null,
        job_id: r.job_id,
        customer_first_name: r.customer_first_name || null,
        customer_last_name: r.customer_last_name || null,
        address,
        service_type: r.service_type || null,
        scheduled_date: r.scheduled_date || null,
        window_start: r.window_start || null,
        window_end: r.window_end || null,
        // payload is JSONB — pg returns it as object directly.
        payload: r.payload || null,
        created_at: r.created_at,
        resolved_at: r.resolved_at,
        resolved_by: r.resolved_by,
      };
    });

    res.json({ alerts });
  } catch (err) {
    logger.error(`[dispatch/alerts] hydration failed: ${err.message}`);
    next(err);
  }
});

// PATCH /api/admin/dispatch/alerts/:id/resolve — close an action queue card.
//
// Sets resolved_at + resolved_by on the row and broadcasts
// dispatch:alert_resolved to dispatch:admins so every connected
// dispatcher's right pane drops the card without a hydration round
// trip. The local PATCH caller also drops it client-side on success
// (their broadcast arrival becomes a no-op via the same id filter).
//
// Idempotent: the underlying UPDATE matches `WHERE resolved_at IS NULL`,
// so a second concurrent resolve from another dispatcher returns null
// from resolveAlert. We follow up with a SELECT to disambiguate:
//   - row exists and is resolved → 200 with the existing row, no
//     second broadcast (cards on other clients already removed)
//   - row missing                → 404
// GET /api/admin/dispatch/technicians — active-technician list for
// the JobDrawer assignment dropdown.
//
// Distinct from /board's tech list, which filters to "active in the
// last 24h" so unassigned techs don't clutter the map. For
// assignment we want EVERY active tech, including ones who haven't
// pinged today.
router.get('/technicians', requireAdmin, async (req, res, next) => {
  try {
    const techs = await db('technicians')
      .where({ active: true })
      .select('id', 'name', 'role')
      .orderBy('name', 'asc');
    res.json({ technicians: techs });
  } catch (err) {
    logger.error(`[dispatch/technicians] list failed: ${err.message}`);
    next(err);
  }
});

// PUT /api/admin/dispatch/jobs/:id/assign — change a job's assigned
// technician. Body: { technicianId } where technicianId is either a
// technicians.id UUID or null (to unassign).
//
// Used by JobDrawer's assignment dropdown. Future drag-to-reassign
// (drag a job pin onto a tech card) will call the same endpoint.
//
// Validation:
//   - job exists
//   - job is not in a terminal state (completed/cancelled/skipped) —
//     reassigning a finished job is meaningless and would silently
//     no-op the operational signal
//   - technicianId, if non-null, references an ACTIVE technician
//
// Side effects on success:
//   - scheduled_services.technician_id updated
//   - if going from null → assigned tech, any open
//     unassigned_overdue alert for this job auto-resolves via
//     resolveAlert (broadcast suppressed if rollback). Same trx.
//   - dispatch:job_update broadcast to dispatch:admins so other
//     dispatchers' boards re-render the pin's color + roster
//     attribution. Customer-room broadcasts are NOT emitted (no
//     customer-visible state change).
router.put('/jobs/:id/assign', requireAdmin, async (req, res, next) => {
  try {
    const rawTechId = req.body ? req.body.technicianId : undefined;
    if (rawTechId !== null && typeof rawTechId !== 'string') {
      return res.status(400).json({ error: 'technicianId must be a UUID string or null' });
    }
    const newTechId = rawTechId || null;

    const job = await db('scheduled_services').where({ id: req.params.id }).first();
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (['completed', 'cancelled', 'skipped'].includes(job.status)) {
      return res.status(409).json({
        error: `Cannot reassign a ${job.status} job`,
      });
    }

    if (newTechId) {
      const tech = await db('technicians').where({ id: newTechId }).first();
      if (!tech) return res.status(400).json({ error: 'Unknown technician' });
      if (!tech.active) return res.status(400).json({ error: 'Technician is inactive' });
    }

    // No-op: avoid re-broadcasting + re-running auto-resolve when the
    // dispatcher saves without changing anything.
    if ((job.technician_id || null) === newTechId) {
      return res.json({ job: { ...job, technician_id: newTechId } });
    }

    const fromTechId = job.technician_id || null;

    // Trx scope: status-guarded update + auto-resolve (if applicable).
    // The UPDATE re-applies the terminal-status filter as a transactional
    // predicate to close the TOCTOU race that the pre-trx check leaves
    // open: a concurrent PUT /:serviceId/status transitioning the job
    // to completed/cancelled/skipped between our SELECT and our UPDATE
    // would otherwise let the reassignment land on a terminal row.
    // Codex P1 on PR #320. 0-rowcount means the status flipped (or, very
    // rarely, the row was deleted) — we throw and the catch arm below
    // converts to 409.
    //
    // The dispatch-alerts helper's emit chains on trx.executionPromise,
    // so alert_resolved broadcasts fire post-commit and are suppressed
    // on rollback.
    const TERMINAL_RACE = 'TERMINAL_STATUS_RACE';
    let updatedRow;
    try {
      await db.transaction(async (trx) => {
        const rows = await trx('scheduled_services')
          .where({ id: req.params.id })
          .whereNotIn('status', ['completed', 'cancelled', 'skipped'])
          .update({ technician_id: newTechId, updated_at: trx.fn.now() })
          .returning('*');
        if (rows.length === 0) {
          // Status flipped to terminal between the pre-trx SELECT and
          // this UPDATE. Throwing rolls back the trx and skips the
          // auto-resolve + commit; the catch arm returns 409.
          throw Object.assign(new Error('terminal status race'), { code: TERMINAL_RACE });
        }
        updatedRow = rows[0];

        // null → tech: the unassigned_overdue alert is moot. We don't
        // touch tech_late here — the late condition is on the JOB's
        // window, not the tech, so reassigning between techs leaves
        // tech_late open until the job actually lands on_site.
        if (!fromTechId && newTechId) {
          const { resolveAlert } = require('../services/dispatch-alerts');
          const openAlerts = await trx('dispatch_alerts')
            .where({ type: 'unassigned_overdue', job_id: req.params.id })
            .whereNull('resolved_at')
            .select('id');
          for (const { id } of openAlerts) {
            await resolveAlert({ id, resolvedBy: req.technicianId, trx });
          }
        }
      });
    } catch (err) {
      if (err && err.code === TERMINAL_RACE) {
        return res.status(409).json({
          error: 'Cannot reassign — job transitioned to a terminal state concurrently',
        });
      }
      throw err;
    }

    // Best-effort dispatch:job_update broadcast. Mirror's transitionJobStatus's
    // adminPayload shape so future client listeners can treat both the
    // status-transition and assign paths uniformly.
    try {
      const { getIo } = require('../sockets');
      const io = getIo();
      if (io) {
        const enriched = await db('scheduled_services as s')
          .leftJoin('technicians as t', 's.technician_id', 't.id')
          .leftJoin('customers as c', 's.customer_id', 'c.id')
          .where('s.id', req.params.id)
          .first(
            's.id as job_id', 's.customer_id', 's.technician_id as tech_id',
            's.status', 's.service_type', 's.scheduled_date',
            's.window_start', 's.window_end', 's.notes', 's.internal_notes',
            's.updated_at', 't.name as tech_full_name', 'c.first_name as cust_first_name'
          );
        if (enriched) {
          io.to('dispatch:admins').emit('dispatch:job_update', {
            job_id: enriched.job_id,
            customer_id: enriched.customer_id,
            cust_first_name: enriched.cust_first_name,
            status: enriched.status,
            from_status: enriched.status, // metadata-only change
            tech_id: enriched.tech_id,
            tech_full_name: enriched.tech_full_name,
            service_type: enriched.service_type,
            scheduled_date: enriched.scheduled_date,
            window_start: enriched.window_start,
            window_end: enriched.window_end,
            notes: enriched.notes,
            internal_notes: enriched.internal_notes,
            transitioned_by: req.technicianId,
            updated_at: enriched.updated_at,
          });
        }
      }
    } catch (e) {
      logger.error(`[dispatch/jobs/assign] broadcast failed: ${e.message}`);
    }

    res.json({ job: updatedRow });
  } catch (err) {
    logger.error(`[dispatch/jobs/assign] failed for ${req.params.id}: ${err.message}`);
    next(err);
  }
});

router.patch('/alerts/:id/resolve', requireAdmin, async (req, res, next) => {
  try {
    const { resolveAlert } = require('../services/dispatch-alerts');
    const row = await resolveAlert({
      id: req.params.id,
      resolvedBy: req.technicianId,
    });
    if (row) return res.json({ alert: row });

    const existing = await db('dispatch_alerts').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'alert not found' });
    return res.json({ alert: existing });
  } catch (err) {
    logger.error(`[dispatch/alerts/resolve] failed for ${req.params.id}: ${err.message}`);
    next(err);
  }
});

module.exports = router;
