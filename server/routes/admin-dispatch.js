const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin, requireAdmin } = require('../middleware/admin-auth');
const { resolveLocation } = require('../config/locations');
const smsTemplatesRouter = require('./admin-sms-templates');
const logger = require('../services/logger');
const { etDateString, addETDays, parseETDateTime, formatETDay, formatETDate, formatETTime } = require('../utils/datetime-et');
const { formatSmsTimeRange } = require('../utils/sms-time-format');
const trackTransitions = require('../services/track-transitions');
const { resolveTechPhotoUrl } = require('../services/tech-photo');
const CompletionRecap = require('../services/completion-recap');
const CompletionAttempts = require('../services/completion-attempts');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { publicPortalUrl } = require('../utils/portal-url');
const { countSegments } = require('../services/messaging/segment-counter');
const { recordServiceProductNutrients } = require('../services/nutrient-ledger');
const { buildPlanForService, isDateInWindow } = require('../services/waveguard-plan-engine');
const { evaluateWaveGuardManagerApprovals, managerApprovalSummary } = require('../services/waveguard-approval-engine');
const { shortenOrPassthrough, invoiceShortCodePrefix } = require('../services/short-url');
const { customerOnAutopay } = require('../services/autopay-eligibility');
const { assignDispatchJob, emitDispatchJobUpdate } = require('../services/dispatch-assignment');
const { detectServiceLine, getServiceLineConfig } = require('../services/service-report/service-line-configs');
const { runAndSwallowErrors: runPestPressureForServiceRecord } = require('../services/pest-pressure/orchestrate');
const { loadActiveConfig: loadPestPressureConfig } = require('../services/pest-pressure/store');
const { buildCompletionAdvisory } = require('../services/service-report/report-data');
const { fetchApplicationConditions } = require('../services/service-report/application-conditions');
const {
  buildServiceReportV1DeliveryContext,
  shouldSendServiceReportV1Delivery,
} = require('../services/service-report/delivery');
const { enqueueServiceReportV1EmailDelivery } = require('../services/service-report/delivery-queue');
const { enqueuePdfRenderJob } = require('../services/service-report/pdf-queue');
const { buildServiceReportDynamicContext } = require('../services/service-report/dynamic-context');
const { buildAndStoreSmsPreviewImage } = require('../services/service-report/preview-image');
const { buildNoActivityFinding } = require('../services/service-report/no-activity-finding');
const { buildServiceRecordCompletionTimingFields } = require('../services/service-report/service-record-timing');
const { uploadServicePhotoDataUrls } = require('../services/service-photos');
const {
  recordLawnProtocolCompletion,
  normalizeCompletionForStructuredNotes,
} = require('../services/lawn-protocol-completion');
const { validateTreeShrubCloseout } = require('../services/tree-shrub-closeout');
const {
  resolveCompletionProfileForScheduledService,
  resolveCompletionProfileForServiceId,
} = require('../services/service-completion-profiles');
const { buildPrepaidSeriesContext } = require('../services/prepaid-series');
const { isUserFeatureEnabled } = require('../services/feature-flags');
const {
  recordTrackTransitionFailure,
  recordTrackTransitionResultFailure,
} = require('../services/track-transition-alerts');
const {
  buildOnSiteLifecycleUpdates,
  buildCompletionLifecycleUpdates,
} = require('../utils/service-duration-capture');
const {
  INVENTORY_UNITS,
  convertInventoryQuantity,
  normalizeInventoryUnit,
} = require('../services/inventory-units');

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

async function renderTemplate(templateKey, vars, context = {}) {
  try {
    if (typeof smsTemplatesRouter.getTemplate === 'function') {
      const body = await smsTemplatesRouter.getTemplate(templateKey, vars, context);
      if (body) return body;
    }
  } catch { /* fall through */ }
  return null;
}

async function runtimeServiceReportFlag(req, flagKey, envKey, defaultValue = false) {
  const envValue = process.env[envKey];
  if (envValue !== undefined) {
    return ['1', 'true', 'yes', 'on'].includes(String(envValue).trim().toLowerCase());
  }
  return isUserFeatureEnabled(req.technicianId, flagKey, defaultValue).catch(() => !!defaultValue);
}

function oneTapCompletionSubmitEnabled() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.ONE_TAP_COMPLETION_SUBMIT_ENABLED || '').trim().toLowerCase());
}

function normalizeServiceReportApplicationMethod(value = '') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!normalized) return '';
  if ([
    'perimeter_spray',
    'broadcast_spray',
    'spot_treatment',
    'granular_broadcast',
    'bait_placement',
    'station_check',
    'fog_ulv',
    'foliar_spray',
    'trunk_injection',
    'pin_stream',
  ].includes(normalized)) return normalized;
  if (normalized.includes('trunk') || normalized.includes('inject')) return 'trunk_injection';
  if (normalized.includes('foliar')) return 'foliar_spray';
  if (normalized.includes('pin')) return 'pin_stream';
  if (normalized.includes('granular')) return 'granular_broadcast';
  if (normalized.includes('bait') || normalized.includes('gel') || normalized.includes('glue')) return 'bait_placement';
  if (normalized.includes('station')) return 'station_check';
  if (normalized.includes('fog') || normalized.includes('ulv')) return 'fog_ulv';
  if (normalized.includes('spot')) return 'spot_treatment';
  if (normalized.includes('broadcast')) return 'broadcast_spray';
  if (normalized.includes('perimeter') || normalized.includes('band')) return 'perimeter_spray';
  return normalized;
}

function inferServiceReportApplicationMethod(product = {}, productInput = {}, serviceLine = 'pest') {
  const explicit = normalizeServiceReportApplicationMethod(
    productInput.applicationMethod || productInput.method || product.application_method || product.method,
  );
  if (explicit) return explicit;
  const category = String(product.category || product.product_category || '').toLowerCase();
  if (category.includes('bait') || category.includes('gel') || category.includes('glue')) return 'bait_placement';
  if (category.includes('fert') || category.includes('granular')) return 'granular_broadcast';
  if (serviceLine === 'mosquito') return 'fog_ulv';
  if (serviceLine === 'lawn') return category.includes('herb') ? 'spot_treatment' : 'broadcast_spray';
  if (serviceLine === 'palm' || serviceLine === 'tree_shrub') return 'foliar_spray';
  if (serviceLine === 'rodent' || serviceLine === 'termite') return 'station_check';
  return 'perimeter_spray';
}

function requiresLinearFtForReportApplication(method) {
  return normalizeServiceReportApplicationMethod(method) === 'perimeter_spray';
}

function requiresSqftForReportApplication(method, serviceLine = 'pest') {
  const normalized = normalizeServiceReportApplicationMethod(method);
  return serviceLine === 'lawn' && ['broadcast_spray', 'granular_broadcast'].includes(normalized);
}

function shouldInsertNoActivityFinding({
  visitOutcome,
  observations = [],
  recommendations = [],
  concernText = '',
} = {}) {
  return visitOutcome === 'completed'
    && !observations.length
    && !recommendations.length
    && !String(concernText || '').trim();
}

async function renderRequiredTemplate(templateKey, vars, context = {}) {
  try {
    if (typeof smsTemplatesRouter.getTemplate === 'function') {
      const body = await smsTemplatesRouter.getTemplate(templateKey, vars, context);
      if (body) return body;
    }
  } catch (err) {
    throw new Error(`SMS template ${templateKey} could not be rendered: ${err.message}`);
  }
  throw new Error(`SMS template ${templateKey} is missing or inactive`);
}

function ensureSmsContainsReportLink(body, reportLink) {
  const text = String(body || '').trim();
  const link = String(reportLink || '').trim();
  if (!text || !link || text.includes(link)) return text;
  const portalRootRe = /\b(?:https?:\/\/)?portal\.wavespestcontrol\.com(?:\/report\/[a-f0-9]{32})?/i;
  if (portalRootRe.test(text)) {
    return text.replace(portalRootRe, link);
  }
  return `${text}\n${link}`;
}

const MAX_REVIEW_DELAY_MINUTES = 60 * 24 * 30;

function completionReviewTimingError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  err.isOperational = true;
  return err;
}

function clampReviewDelayMinutes(minutes) {
  const rounded = Math.max(0, Math.round(minutes));
  return Math.min(rounded, MAX_REVIEW_DELAY_MINUTES);
}

function parseCompletionReviewDelayMinutes(body = {}) {
  if (!body.requestReview) return null;
  const hasExplicitTiming =
    Object.prototype.hasOwnProperty.call(body, 'reviewTiming') ||
    Object.prototype.hasOwnProperty.call(body, 'reviewDelayMinutes') ||
    Object.prototype.hasOwnProperty.call(body, 'reviewScheduledFor');
  if (!hasExplicitTiming) return undefined;

  if (body.reviewTiming === 'now') return 0;
  if (body.reviewTiming === 'tomorrow_8') {
    const targetDay = etDateString(addETDays(new Date(), 1));
    const target = parseETDateTime(`${targetDay}T08:00`);
    return clampReviewDelayMinutes(Math.ceil((target.getTime() - Date.now()) / 60000));
  }
  if (body.reviewTiming === 'custom') {
    if (!body.reviewScheduledFor) {
      throw completionReviewTimingError('reviewScheduledFor required');
    }
    const target = parseETDateTime(body.reviewScheduledFor);
    if (Number.isNaN(target.getTime())) {
      throw completionReviewTimingError('invalid reviewScheduledFor');
    }
    if (target.getTime() <= Date.now()) {
      throw completionReviewTimingError('reviewScheduledFor must be in the future');
    }
    return clampReviewDelayMinutes(Math.ceil((target.getTime() - Date.now()) / 60000));
  }

  const raw = body.reviewDelayMinutes ?? body.reviewTiming;
  if (raw === undefined || raw === null || raw === '') return 120;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes)) return 120;
  return clampReviewDelayMinutes(minutes);
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
const TREE_SHRUB_MIN_CLOSEOUT_PHOTOS = 2;

const CUSTOMER_INTERACTION_ALIASES = {
  spoke: 'tech_home_spoke_with_them',
  not_home_full: 'not_home_full_access',
  not_home_partial: 'not_home_partial_access',
  concern: 'customer_specific_concern',
};

function normalizeCustomerInteractionValue(value) {
  if (!value) return null;
  const text = String(value).trim();
  return CUSTOMER_INTERACTION_ALIASES[text] || text || null;
}

function isWaveGuardLawnCompletion(svc) {
  return !!svc?.cust_waveguard_tier && detectServiceLine(svc?.service_type) === 'lawn';
}

function calibrationLockoutBlocks(plan) {
  const lockoutCodes = new Set([
    'missing_calibration',
    'equipment_selection_required',
    'expired_calibration',
    'calibration_not_field_verified',
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

function inventoryPlanLockoutBlocks(plan) {
  return (plan?.inventory?.blocks || [])
    .filter((block) => [
      'inventory_product_inactive',
      'inventory_depleted',
      'inventory_insufficient_stock',
    ].includes(block.code));
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

async function loadSubmittedCatalogProducts(submittedProducts = []) {
  const productIds = [...new Set((submittedProducts || []).map((p) => p?.productId).filter(Boolean))];
  if (!productIds.length) return [];
  return db('products_catalog')
    .whereIn('id', productIds)
    .select('*')
    .catch(() => []);
}

function treeShrubPhotoUploadRequiredError(uploadResult, minimum = TREE_SHRUB_MIN_CLOSEOUT_PHOTOS) {
  const errors = Array.isArray(uploadResult?.errors) ? uploadResult.errors : [];
  const hasServerSideFailure = errors.some((err) => !err.statusCode || Number(err.statusCode) >= 500);
  const err = new Error(`At least ${minimum} Tree/Shrub closeout photos must upload before closeout.`);
  err.statusCode = hasServerSideFailure ? 503 : 400;
  err.isOperational = true;
  err.code = 'tree_shrub_closeout_photos_upload_required';
  err.details = errors.map((entry) => entry.message).filter(Boolean);
  return err;
}

function formatRescheduleTemplateVars(svc) {
  const dateOnly = serviceDateOnly(svc?.scheduled_date);
  const start = svc?.window_start || '08:00';
  const apptTime = parseETDateTime(`${dateOnly}T${start}`);
  return {
    first_name: svc?.first_name || 'there',
    service_type: svc?.service_type || 'service',
    day: formatETDay(apptTime),
    date: formatETDate(apptTime),
    time: formatETTime(apptTime),
  };
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

async function actualProductInventoryBlocks(submittedProducts = []) {
  const productIds = [...new Set((submittedProducts || []).map((p) => p.productId).filter(Boolean))];
  if (!productIds.length) return [];

  const catalogProducts = await db('products_catalog')
    .whereIn('id', productIds)
    .select('id', 'name', 'active', 'inventory_on_hand', 'inventory_unit')
    .catch(() => []);
  const productById = new Map(catalogProducts.map((product) => [String(product.id), product]));
  const blocks = [];

  for (const submitted of submittedProducts || []) {
    if (!submitted?.productId) continue;
    const product = productById.get(String(submitted.productId));
    if (!product) continue;
    if (product.active === false) {
      blocks.push({
        code: 'actual_inventory_product_inactive',
        severity: 'block',
        productId: product.id,
        productName: product.name,
        message: `${product.name} is inactive and cannot be completed.`,
      });
      continue;
    }
    if (product.inventory_on_hand == null || product.inventory_on_hand === '') continue;
    const stockOnHand = Number(product.inventory_on_hand);
    if (!Number.isFinite(stockOnHand)) continue;
    const amount = submitted.totalAmount != null && submitted.totalAmount !== ''
      ? Number(submitted.totalAmount)
      : null;
    const amountUnit = submitted.amountUnit || submitted.rateUnit || null;
    if (!amount || !Number.isFinite(amount) || amount <= 0 || !amountUnit) continue;
    const inventoryUnit = product.inventory_unit || amountUnit;
    const required = convertInventoryQuantity(amount, amountUnit, inventoryUnit);
    if (required == null) continue;
    if (required > stockOnHand) {
      blocks.push({
        code: 'actual_inventory_insufficient_stock',
        severity: 'block',
        productId: product.id,
        productName: product.name,
        requiredAmount: required,
        stockOnHand,
        unit: inventoryUnit,
        message: `${product.name} requires ${required} ${inventoryUnit}, but only ${stockOnHand} ${inventoryUnit} is on hand.`,
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
  if (insufficient) {
    const err = new Error(`${inventoryProduct.name} requires ${deductedAmount} ${inventoryUnit}, but only ${stockBefore} ${inventoryUnit} is on hand.`);
    err.statusCode = 400;
    err.code = 'waveguard_inventory_lockout';
    throw err;
  }
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

function normalizeCompletionTextArray(value, limit = 20) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const text = String(item || '').trim().replace(/\s+/g, ' ').slice(0, 240);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function taggedCompletionNoteLines(notes, tags) {
  const tagSet = new Set(tags.map((tag) => tag.toLowerCase()));
  return String(notes || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => {
      const match = line.match(/^\[([^\]]+)\]\s*(.+)$/);
      if (!match) return null;
      return { tag: match[1].toLowerCase(), text: match[2].trim() };
    })
    .filter((entry) => entry && tagSet.has(entry.tag))
    .map((entry) => entry.text);
}

function completionFindingSeverity(text) {
  const lower = String(text || '').toLowerCase();
  if (lower.includes('customer concern') || lower.includes('access issue')) return 'medium';
  if (lower.includes('rodent') || lower.includes('fungus')) return 'medium';
  if (lower.includes('standing water') || lower.includes('irrigation')) return 'low';
  return 'low';
}

async function attachLawnAssessmentOutcomePhotoRefs(outcome, assessmentId) {
  if (!outcome || !assessmentId) return;
  try {
    const bestPhoto = await db('lawn_assessment_photos')
      .where({ assessment_id: assessmentId, is_best_photo: true })
      .first();
    if (bestPhoto) {
      await db('treatment_outcomes')
        .where({ id: outcome.id })
        .update({ post_best_photo_key: bestPhoto.s3_key });
    }
    if (outcome.pre_assessment_id) {
      const preBestPhoto = await db('lawn_assessment_photos')
        .where({ assessment_id: outcome.pre_assessment_id, is_best_photo: true })
        .first();
      if (preBestPhoto) {
        await db('treatment_outcomes')
          .where({ id: outcome.id })
          .update({ pre_best_photo_key: preBestPhoto.s3_key });
      }
    }
  } catch (err) {
    logger.error(`[dispatch] Lawn assessment outcome photo refs failed: ${err.message}`);
  }
}

function serializeJsonb(value) {
  return JSON.stringify(value ?? null);
}

function composeCompletionSmsBody({ recapText, body, suffix = '', maxSegments = 2 }) {
  const tail = `${body || ''}${suffix || ''}`.trim();
  if (!recapText) return { body: tail, truncated: false };

  const full = `${recapText}\n\n${tail}`;
  if (countSegments(full).segmentCount <= maxSegments) return { body: full, truncated: false };
  if (countSegments(tail).segmentCount > maxSegments) return { body: tail, truncated: false };

  const marker = '...';
  const separator = '\n\n';
  const chars = Array.from(recapText);
  let low = 0;
  let high = chars.length;
  let best = tail;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const recap = `${chars.slice(0, mid).join('').trimEnd()}${marker}`;
    const candidate = `${recap}${separator}${tail}`;
    if (countSegments(candidate).segmentCount <= maxSegments) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return { body: best, truncated: true };
}

router.use(adminAuthenticate, requireTechOrAdmin);

// GET /api/admin/dispatch/:serviceId/tech-rating-allowed
// Tech-readable boolean reflecting whether the rating picker should be
// shown for THIS specific scheduled service. Returns `{ allowed: bool }`.
//
// Single source of truth: the server applies the same gates the
// completion handler would apply on write — (a) feature flag
// `allowTechnicianClientRatingEntry`, (b) service_line resolved via the
// SAME `detectServiceLine` classifier the completion path uses, against
// the active `enabledServiceLines` allow-list. The client previously
// gated locally with `detectServiceCategory`, but that classifier maps
// rodent labels to `pest` while the backend records them as `rodent` —
// resulting in a picker that shows up only to have its data silently
// dropped on completion. Computing the result per-service on the server
// keeps the UI and the write path in agreement.
//
// 404 on unknown service; admin-dispatch's existing requireTechOrAdmin
// gate covers auth.
router.get('/:serviceId/tech-rating-allowed', async (req, res, next) => {
  try {
    const svc = await db('scheduled_services')
      .where({ id: req.params.serviceId })
      .first('id', 'service_type');
    if (!svc) {
      return res.status(404).json({ error: 'Service not found' });
    }
    const config = await loadPestPressureConfig(db);
    const techEntryAllowed = !!(config
      && config.allowTechnicianClientRatingEntry === true);
    const enabledLines = Array.isArray(config && config.enabledServiceLines)
      ? config.enabledServiceLines
      : [];
    const serviceLine = detectServiceLine(svc.service_type);
    const serviceLineAllowed = enabledLines.length === 0
      || (serviceLine && enabledLines.includes(serviceLine));
    res.json({ allowed: techEntryAllowed && serviceLineAllowed });
  } catch (err) { next(err); }
});

// GET /api/admin/dispatch/:serviceId/completion-profile
router.get('/:serviceId/completion-profile', async (req, res, next) => {
  try {
    const profile = await resolveCompletionProfileForServiceId(req.params.serviceId);
    if (!profile) return res.status(404).json({ error: 'Service not found' });
    res.json({ profile });
  } catch (err) { next(err); }
});

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
        'customers.autopay_enabled', 'customers.autopay_paused_until',
        'customers.autopay_payment_method_id',
        'customers.ach_status',
        'technicians.name as tech_name'
      )
      .orderByRaw('COALESCE(route_order, 999), window_start');

    // Enrich with property preferences and last service
    const enriched = await Promise.all(services.map(async (s) => {
      const prefs = await db('property_preferences').where({ customer_id: s.customer_id }).first();
      const lastService = await db('service_records')
        .where({ customer_id: s.customer_id, status: 'completed' })
        .orderBy('service_date', 'desc').first();
      const statusLog = await db('job_status_history')
        .where({ job_id: s.id })
        .orderBy('transitioned_at')
        .select('to_status as status', 'transitioned_at as at', 'notes');
      let checkoutInvoice = null;
      try {
        checkoutInvoice = await db('invoices')
          .where({ scheduled_service_id: s.id })
          .whereNot('status', 'void')
          .orderBy('created_at', 'desc')
          .first('id', 'status', 'total', 'token');
      } catch { /* scheduled_service_id may be absent before migration */ }
      const autopayActive = await customerOnAutopay({
        id: s.customer_id,
        autopay_enabled: s.autopay_enabled,
        autopay_paused_until: s.autopay_paused_until,
        autopay_payment_method_id: s.autopay_payment_method_id,
        ach_status: s.ach_status,
      });
      const completionProfile = await resolveCompletionProfileForScheduledService(s).catch(() => null);
      // Only fan out the series-context lookup for visits that are actually
      // prepaid — most rows aren't, and we don't want N extra family-fetches
      // per day on the dispatch list.
      const prepaidSeriesContext = s.prepaid_amount != null && Number(s.prepaid_amount) > 0
        ? await buildPrepaidSeriesContext(db, s).catch(() => null)
        : null;
      const linkedProject = await db('projects')
        .where({ scheduled_service_id: s.id })
        .orderByRaw(`
          CASE status
            WHEN 'draft' THEN 1
            WHEN 'sent' THEN 2
            WHEN 'closed' THEN 3
            ELSE 4
          END
        `)
        .orderBy('created_at', 'desc')
        .first('id', 'status', 'project_type', 'title', 'report_token', 'service_record_id', 'portal_visible')
        .catch(() => null);

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
        scheduledDate: s.scheduled_date,
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
        autopayActive,
        autopayEnabled: s.autopay_enabled !== false,
        estimatedPrice: s.estimated_price != null ? Number(s.estimated_price) : null,
        prepaidAmount: s.prepaid_amount != null ? Number(s.prepaid_amount) : null,
        prepaidMethod: s.prepaid_method || null,
        prepaidNote: s.prepaid_note || null,
        prepaidAt: s.prepaid_at || null,
        prepaidSeriesContext,
        createInvoiceOnComplete: !!s.create_invoice_on_complete,
        checkoutInvoiceId: checkoutInvoice?.id || null,
        checkoutInvoiceStatus: checkoutInvoice?.status || null,
        checkoutInvoiceTotal: checkoutInvoice?.total != null ? Number(checkoutInvoice.total) : null,
        completionProfile,
        linkedProject: linkedProject ? {
          id: linkedProject.id,
          status: linkedProject.status,
          projectType: linkedProject.project_type,
          title: linkedProject.title,
          hasReportToken: !!linkedProject.report_token,
          serviceRecordId: linkedProject.service_record_id || null,
          portalVisible: linkedProject.portal_visible === true,
        } : null,
        isRecurring: !!s.is_recurring,
        recurringParentId: s.recurring_parent_id || null,
        recurringPattern: s.recurring_pattern || null,
        lawnType: s.lawn_type,
        propertyAlerts: alerts,
        lastServiceDate: lastService?.service_date || null,
        lastServiceType: lastService?.service_type || null,
        lastServiceNotes: lastService?.technician_notes?.slice(0, 200) || null,
        actualStartTime: s.actual_start_time,
        actualEndTime: s.actual_end_time,
        serviceTimeMinutes: s.service_time_minutes,
        checkInTime: s.check_in_time || s.actual_start_time,
        checkOutTime: s.check_out_time || s.actual_end_time,
        statusLog: statusLog.map(l => ({ status: l.status, at: l.at, notes: l.notes || null })),
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
//   - track-transitions.markEnRoute / markComplete / cancel (track_state
//     is a separate customer-visible state machine; en_route still
//     fires the tracking-link SMS via that helper).
//   - activity_log INSERT (admin-side audit, distinct table).
router.put('/:serviceId/status', async (req, res, next) => {
  try {
    const { status: toStatus, notes, lat, lng, notifyCustomer, scope = 'this_only' } = req.body;
    const svc = await db('scheduled_services').where('scheduled_services.id', req.params.serviceId)
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
      .select('scheduled_services.*', 'customers.first_name', 'customers.phone as cust_phone', 'customers.city', 'technicians.name as tech_name')
      .first();

    if (!svc) return res.status(404).json({ error: 'Service not found' });

    if (toStatus === 'cancelled' && ['following', 'series'].includes(scope)) {
      const parentId = svc.recurring_parent_id || svc.id;
      const parent = await db('scheduled_services').where({ id: parentId }).first();
      if (!parent || (!parent.is_recurring && !parent.recurring_pattern)) {
        return res.status(400).json({ error: 'Service is not part of a recurring series' });
      }

      const cancellableStatuses = ['pending', 'confirmed', 'rescheduled'];
      const terminalStatuses = ['completed', 'skipped', 'cancelled'];
      const baseQuery = db('scheduled_services')
        .where(function () {
          this.where('id', parentId).orWhere('recurring_parent_id', parentId);
        })
        .where(function () {
          this.whereIn('status', cancellableStatuses)
            .orWhere(function () {
              this.where('id', svc.id).whereNotIn('status', terminalStatuses);
            });
        });
      if (scope === 'following') {
        baseQuery.where('scheduled_date', '>=', svc.scheduled_date);
      }

      const targets = await baseQuery
        .orderBy('scheduled_date', 'asc')
        .select('id', 'status', 'customer_id', 'service_type');

      if (!targets.length) return res.status(409).json({ error: 'No cancellable appointments found in this series' });

      const { transitionJobStatus } = require('../services/job-status');
      await db.transaction(async (trx) => {
        for (const target of targets) {
          await transitionJobStatus({
            jobId: target.id,
            fromStatus: target.status,
            toStatus,
            transitionedBy: req.technicianId,
            lat,
            lng,
            notes,
            trx,
          });
        }
      });

      try {
        const AppointmentReminders = require('../services/appointment-reminders');
        const targetIds = targets.map((target) => target.id);
        await AppointmentReminders.handleSeriesCancellation(targetIds, svc.id, {
          sendNotification: notifyCustomer !== false,
          scope,
        });
      } catch (e) { logger.error(`[admin-dispatch] series cancellation reminder handling failed: ${e.message}`); }

      for (const target of targets) {
        try {
          const result = await trackTransitions.cancel(target.id, {
            reason: notes || null,
            actorId: req.technicianId,
          });
          await recordTrackTransitionResultFailure({
            jobId: target.id,
            action: 'cancel',
            actorId: req.technicianId,
            result,
          });
        } catch (e) {
          logger.error(`[admin-dispatch] series cancel track transition failed for ${target.id}: ${e.message}`);
          await recordTrackTransitionFailure({
            jobId: target.id,
            action: 'cancel',
            actorId: req.technicianId,
            error: e,
          });
        }
      }

      await db('activity_log').insert({
        admin_user_id: req.technicianId,
        customer_id: svc.customer_id,
        action: 'status_changed',
        description: `${svc.tech_name} cancelled ${targets.length} ${scope === 'series' ? 'series' : 'future'} appointments for ${svc.first_name}`,
      });

      return res.json({ success: true, cancelledCount: targets.length, scope });
    }

    const fromStatus = svc.status;
    const { transitionJobStatus } = require('../services/job-status');
    try {
      await db.transaction(async (trx) => {
        // Lifecycle timestamps live on the same row as status; flip
        // them inside the same trx so a rollback also rolls back the
        // timestamp change. transitionJobStatus owns the status +
        // updated_at columns (atomic guard); we own the service timing
        // columns (no constraint conflict).
        const lifecycleUpdates = {};
        const lifecycleAt = new Date();
        if (toStatus === 'on_site') {
          Object.assign(lifecycleUpdates, buildOnSiteLifecycleUpdates(svc, lifecycleAt));
        }
        if (toStatus === 'completed') {
          Object.assign(lifecycleUpdates, buildCompletionLifecycleUpdates(svc, lifecycleAt));
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
          lat,
          lng,
          notes,
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
        const result = await trackTransitions.markEnRoute(svc.id, {
          actorType: 'admin',
          actorId: req.technicianId,
        });
        await recordTrackTransitionResultFailure({
          jobId: svc.id,
          action: 'mark_en_route',
          actorId: req.technicianId,
          result,
        });
      } catch (e) {
        logger.error(`[admin-dispatch] markEnRoute failed: ${e.message}`);
        await recordTrackTransitionFailure({
          jobId: svc.id,
          action: 'mark_en_route',
          actorId: req.technicianId,
          error: e,
        });
      }
    } else if (toStatus === 'on_site') {
      try {
        const result = await trackTransitions.markOnProperty(svc.id);
        await recordTrackTransitionResultFailure({
          jobId: svc.id,
          action: 'mark_on_property',
          actorId: req.technicianId,
          result,
        });
      } catch (e) {
        logger.error(`[admin-dispatch] markOnProperty failed: ${e.message}`);
        await recordTrackTransitionFailure({
          jobId: svc.id,
          action: 'mark_on_property',
          actorId: req.technicianId,
          error: e,
        });
      }
    } else if (toStatus === 'completed') {
      try {
        const result = await trackTransitions.markComplete(svc.id, {
          actorType: 'admin',
          actorId: req.technicianId,
        });
        await recordTrackTransitionResultFailure({
          jobId: svc.id,
          action: 'mark_complete',
          actorId: req.technicianId,
          result,
        });
      } catch (e) {
        logger.error(`[admin-dispatch] markComplete failed: ${e.message}`);
        await recordTrackTransitionFailure({
          jobId: svc.id,
          action: 'mark_complete',
          actorId: req.technicianId,
          error: e,
        });
      }
    } else if (toStatus === 'cancelled') {
      try {
        const AppointmentReminders = require('../services/appointment-reminders');
        await AppointmentReminders.handleCancellation(svc.id, {
          sendNotification: notifyCustomer !== false,
        });
      } catch (e) { logger.error(`[admin-dispatch] cancellation reminder handling failed: ${e.message}`); }

      try {
        const result = await trackTransitions.cancel(svc.id, {
          reason: notes || null,
          actorId: req.technicianId,
        });
        await recordTrackTransitionResultFailure({
          jobId: svc.id,
          action: 'cancel',
          actorId: req.technicianId,
          result,
        });
      } catch (e) {
        logger.error(`[admin-dispatch] cancel failed: ${e.message}`);
        await recordTrackTransitionFailure({
          jobId: svc.id,
          action: 'cancel',
          actorId: req.technicianId,
          error: e,
        });
      }
    }

    await db('activity_log').insert({
      admin_user_id: req.technicianId, customer_id: svc.customer_id,
      action: toStatus === 'completed' ? 'service_completed' : 'status_changed',
      description: `${svc.tech_name} marked ${svc.service_type} as ${toStatus} for ${svc.first_name}`,
    });

    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /api/admin/dispatch/:serviceId/complete-preview
//
// Read-only preview for the one-tap "Complete - Protocol Performed"
// flow. Resolves the standard protocol defaults for the service
// without writing anything, and returns the bundle the tech would be
// attesting to plus a stable snapshot hash. It is intentionally gated
// until the submit-side handshake/resume path is present; otherwise a
// backend-only preview can advertise an action the UI cannot safely
// complete.
//
// Response shape:
//   200 { available: true, mode: 'one_tap_available',
//         snapshotHash, buttonCopy, attestationText, summary }
//   200 { available: false, reason: '<resolver reason>', ...details }
//
// Both branches return 200 — the `available` flag drives the client.
// The route returns 4xx only for service-not-found, auth, or input
// validation errors.
router.get('/:serviceId/complete-preview', async (req, res, next) => {
  try {
    const { resolveStandardCompletionDefaults, CUSTOMER_INTERACTION_CHOICES } =
      require('../services/completion-defaults-resolver');

    const customerInteractionChoice = req.query.customerInteraction || null;
    if (customerInteractionChoice
      && !CUSTOMER_INTERACTION_CHOICES.includes(customerInteractionChoice)
    ) {
      return res.status(400).json({
        error: 'Invalid customerInteraction value.',
        code: 'customer_interaction_invalid',
        validChoices: CUSTOMER_INTERACTION_CHOICES,
      });
    }

    if (!oneTapCompletionSubmitEnabled()) {
      return res.json({
        available: false,
        reason: 'one_tap_submit_not_enabled',
        mode: 'detailed_form_required',
      });
    }

    const result = await resolveStandardCompletionDefaults({
      serviceId: req.params.serviceId,
      customerInteractionChoice,
      now: new Date(),
    });

    if (!result.ok) {
      if (result.reason === 'service_not_found') {
        return res.status(404).json({ error: 'Service not found', code: 'service_not_found' });
      }
      return res.json({
        available: false,
        reason: result.reason,
        // Surface the reason-specific detail fields the resolver
        // returned without re-listing them here — the resolver owns
        // the shape per reason, the route is just a pass-through.
        ...result,
        ok: undefined,
      });
    }

    const { snapshot, snapshotHash } = result;
    return res.json({
      available: true,
      mode: 'one_tap_available',
      snapshotHash,
      buttonCopy: 'Complete — Protocol Performed',
      attestationText: snapshot.techAttestationText,
      summary: {
        protocolName: snapshot.protocolName,
        protocolKey: snapshot.protocolKey,
        protocolTemplateVersion: snapshot.protocolTemplateVersion,
        products: snapshot.products.map((p) => p.productName),
        areas: snapshot.areas.map((a) => a.label),
        actions: snapshot.actions.map((a) => ({ label: a.label, required: a.required })),
        customerInteraction: snapshot.customerInteraction,
        customerInteractionSource: snapshot.customerInteractionSource,
        sendSms: snapshot.sendSms,
        review: snapshot.review,
        recapMode: snapshot.recapMode,
      },
    });
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
      reviewTiming,
      reviewScheduledFor,
      oneTimeRecapOnly = false,
      areasTreated,
      areasServiced,
      timeOnSite,
      customerInteraction,
      officeApproval,
      nLimitApproval,
      managerApproval,
      tankCleanout,
      protocolActionsCompleted,
      protocolActionScopesCompleted,
      observations,
      recommendations,
      formResponses,
      formStartedAt,
      invoiceAlreadySent = false,
      lawnAssessmentId = null,
      lawnProtocolCompletion = null,
      treeShrubCompletion = null,
      completionPhotos = [],
      clientPestRating = null,
    } = req.body;
    if (!VALID_VISIT_OUTCOMES.has(visitOutcome)) {
      return res.status(400).json({
        error: `visitOutcome must be one of: ${Array.from(VALID_VISIT_OUTCOMES).join(', ')}`,
      });
    }
    // Tech-side Pest Pressure rating capture — companion to the customer-side
    // POST /api/reports/:token/pest-pressure/client-rating endpoint. The tech
    // observed the property and can submit a 0-5 activity rating that feeds
    // the same `service_records.client_pest_rating` column with
    // `source='technician'`. Both flows share the engine's client-rating
    // component. The Pest Pressure config flag
    // `allowTechnicianClientRatingEntry` gates whether the field is honored
    // here; UI gating is separate (CompletionPanel hides the picker when
    // the flag is off).
    //
    // Strict validation: integer 0-5 or null. No silent rounding, no
    // coercion. AGENTS.md strict-validation rule applies even though this
    // is an admin route (we still want clean data going into the column).
    if (clientPestRating != null) {
      if (!Number.isInteger(clientPestRating) || clientPestRating < 0 || clientPestRating > 5) {
        return res.status(400).json({
          error: 'clientPestRating must be an integer 0-5 (or null/omitted)',
          code: 'client_pest_rating_invalid',
        });
      }
    }
    if (completionPhotos != null && !Array.isArray(completionPhotos)) {
      return res.status(400).json({
        error: 'completionPhotos must be an array',
        code: 'completion_photos_invalid',
      });
    }
    if (Array.isArray(completionPhotos) && completionPhotos.length > 5) {
      return res.status(400).json({
        error: 'Maximum 5 completion photos allowed',
        code: 'completion_photos_too_many',
      });
    }
    const isIncompleteVisit = visitOutcome === 'incomplete';
    const recapReviewOnly = !!oneTimeRecapOnly && !isIncompleteVisit;
    let completionPhotoUploadResult = { uploaded: 0, failed: 0, errors: [] };
    let completionPhotosUploadedBeforeCommit = false;
    const completionReviewDelayMinutes = parseCompletionReviewDelayMinutes(req.body || {});
    const completionAreas = Array.isArray(areasTreated) ? areasTreated : (Array.isArray(areasServiced) ? areasServiced : []);
    const concernText = typeof customerConcernText === 'string' ? customerConcernText.trim() : '';
    const normalizedCustomerInteraction = normalizeCustomerInteractionValue(customerInteraction);
    const normalizedOfficeApproval = normalizeOfficeApproval(officeApproval);
    const normalizedNLimitApproval = normalizeOfficeApproval(nLimitApproval);
    const normalizedManagerApproval = normalizeOfficeApproval(managerApproval);
    const normalizedTankCleanout = normalizeTankCleanout(tankCleanout);
    let waveguardBlackoutApproval = null;
    let waveguardNLimitApproval = null;
    let waveguardManagerApproval = null;
    let waveguardTankCleanout = null;
    let waveguardPlan = null;
    let inventoryDeductions = [];
    let waveguardEquipmentSystemId = equipmentSystemId || null;
    let waveguardCalibrationId = calibrationId || null;
    let treeShrubCloseoutSummary = null;
    let treeShrubCloseoutWarnings = [];
    const svc = await db('scheduled_services').where('scheduled_services.id', req.params.serviceId)
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
      .select(
        'scheduled_services.*',
        'customers.first_name', 'customers.last_name', 'customers.phone as cust_phone', 'customers.email as cust_email',
        'customers.city', 'customers.property_type',
        'customers.latitude as customer_latitude', 'customers.longitude as customer_longitude',
        'customers.monthly_rate as cust_monthly_rate',
        'customers.waveguard_tier as cust_waveguard_tier',
        'customers.autopay_enabled as cust_autopay_enabled',
        'customers.autopay_paused_until as cust_autopay_paused_until',
        'customers.autopay_payment_method_id as cust_autopay_payment_method_id',
        'customers.ach_status as cust_ach_status',
        'technicians.name as tech_name'
      )
      .first();

    if (!svc) return res.status(404).json({ error: 'Service not found' });
    if (!waveguardEquipmentSystemId && svc.assigned_equipment_system_id) {
      waveguardEquipmentSystemId = svc.assigned_equipment_system_id;
    }
    if (!waveguardCalibrationId && svc.assigned_calibration_id) {
      waveguardCalibrationId = svc.assigned_calibration_id;
    }

    const completionProfile = await resolveCompletionProfileForScheduledService(svc).catch((err) => {
      logger.warn(`[dispatch] completion profile lookup failed for ${svc.id}: ${err.message}`);
      return null;
    });
    if (completionProfile?.requiresProject || completionProfile?.projectBacked) {
      return res.status(409).json({
        error: 'This service must be completed through a project.',
        code: 'project_required_completion',
        completionProfile,
      });
    }

    const reportServiceLine = detectServiceLine(svc.service_type);
    const reportConfig = getServiceLineConfig(reportServiceLine);
    const treeShrubCloseoutRequired = !isIncompleteVisit && ['tree_shrub', 'palm'].includes(reportServiceLine);
    const reportProtocolActions = normalizeCompletionTextArray([
      ...(Array.isArray(protocolActionsCompleted) ? protocolActionsCompleted : []),
      ...taggedCompletionNoteLines(technicianNotes, ['protocol', 'protocol optional', 'action']),
    ]);
    // Structured scope for each completed action — authoritative interior/
    // exterior signal for the re-entry advisory (see report-data treatmentScope).
    const reportProtocolActionScopes = (Array.isArray(protocolActionScopesCompleted) ? protocolActionScopesCompleted : [])
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const scope = String(entry.scope || '').toLowerCase();
        if (scope !== 'interior' && scope !== 'exterior') return null;
        return {
          label: String(entry.label || '').trim() || null,
          scope,
          treatmentApplied: entry.treatmentApplied === true,
        };
      })
      .filter(Boolean);
    const reportObservations = normalizeCompletionTextArray([
      ...(Array.isArray(observations) ? observations : []),
      ...taggedCompletionNoteLines(technicianNotes, ['found']),
    ]);
    const reportRecommendations = normalizeCompletionTextArray([
      ...(Array.isArray(recommendations) ? recommendations : []),
      ...taggedCompletionNoteLines(technicianNotes, ['next']),
    ]);
    const [serviceRecordCols, serviceProductCols, serviceFindingsAvailable] = await Promise.all([
      db('service_records').columnInfo().catch(() => ({})),
      db('service_products').columnInfo().catch(() => ({})),
      db.schema.hasTable('service_findings').catch(() => false),
    ]);
    const useServiceReportV1 = true;
    let conditionsAtApplication = null;

    const canLinkLawnAssessmentRecord = !isIncompleteVisit
      && await db.schema.hasColumn('lawn_assessments', 'service_record_id').catch(() => false);

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

    if (claim.action === 'proceed' && treeShrubCloseoutRequired) {
      const treeShrubProductRows = await loadSubmittedCatalogProducts(products);
      const treeShrubValidation = validateTreeShrubCloseout({
        service: svc,
        serviceLine: reportServiceLine,
        serviceDate: serviceDateOnly(svc.scheduled_date),
        completion: treeShrubCompletion,
        products: products || [],
        productRows: treeShrubProductRows,
        completionPhotos,
        customerRecap,
        technicianNotes,
      });
      if (!treeShrubValidation.ok) {
        const validationErr = new Error('Tree/Shrub closeout lockout');
        await CompletionAttempts.markCompletionAttemptFailed(completionAttempt, validationErr);
        return res.status(400).json({
          error: 'Tree/Shrub protocol closeout required',
          code: 'tree_shrub_closeout_lockout',
          details: treeShrubValidation.blocks.map((block) => block.message),
          blocks: treeShrubValidation.blocks,
          warnings: treeShrubValidation.warnings,
        });
      }
      treeShrubCloseoutSummary = treeShrubValidation.normalized;
      treeShrubCloseoutWarnings = treeShrubValidation.warnings || [];
    }

    if (claim.action === 'proceed' && !isIncompleteVisit && isWaveGuardLawnCompletion(svc)) {
      const plan = await buildPlanForService(svc.id, {
        equipmentSystemId: waveguardEquipmentSystemId || null,
        calibrationId: waveguardCalibrationId || null,
      });
      waveguardPlan = plan;
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
      const inventoryBlocks = [
        ...inventoryPlanLockoutBlocks(plan),
        ...await actualProductInventoryBlocks(products),
      ];
      if (inventoryBlocks.length) {
        const validationErr = new Error('WaveGuard inventory lockout');
        await CompletionAttempts.markCompletionAttemptFailed(completionAttempt, validationErr);
        return res.status(400).json({
          error: 'Inventory lockout',
          code: 'waveguard_inventory_lockout',
          details: inventoryBlocks.map((block) => block.message),
          blocks: inventoryBlocks,
        });
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
    // lifecycle UPDATE, status flip, job_status_history} or none of
    // them.
    //
    // The MOA-violation detector runs AFTER the trx commits — it
    // reads property_application_history (not the just-inserted
    // service_products), so its semantics don't change with the
    // timing move, but it now only fires alerts on a successful
    // completion. Race rejection → no completion → no MOA alert.
    const fromStatus = svc.status;
    const { transitionJobStatus } = require('../services/job-status');
    let record;
    let linkedLawnAssessmentId = null;
    if (resumingCommittedCompletion) {
      record = await db('service_records').where({ id: claim.serviceRecordId }).first();
      if (!record) {
        return res.status(409).json({
          error: 'Completion resume state is missing its service record. Refresh and contact support if this continues.',
          code: 'completion_resume_missing_record',
        });
      }
      linkedLawnAssessmentId = parseJsonObject(record.structured_notes).lawnAssessmentId || null;
      durableCompletionCommitted = true;
    } else {
      try {
        conditionsAtApplication = serviceRecordCols.conditions && useServiceReportV1 && !isIncompleteVisit
          ? await fetchApplicationConditions({
            latitude: svc.customer_latitude,
            longitude: svc.customer_longitude,
          }).catch(() => null)
          : null;
        await db.transaction(async (trx) => {
          const completionEndedAt = new Date();
          const completionServiceDate = etDateString(completionEndedAt);
          const lifecycleUpdates = buildCompletionLifecycleUpdates(svc, completionEndedAt, { elapsed: timeOnSite });
          const structuredNotes = {
            visitOutcome,
            requestReview: isIncompleteVisit ? false : requestReview !== false,
            oneTimeRecapOnly: recapReviewOnly,
            reviewSuppression,
            reviewTiming: reviewTiming || null,
            reviewDelayMinutes: completionReviewDelayMinutes == null ? null : completionReviewDelayMinutes,
            reviewScheduledFor: reviewScheduledFor || null,
            incompleteReason,
            customerConcernText: concernText || null,
            customerRecap: customerRecap || null,
            timeOnSite: timeOnSite || null,
            customerInteraction: normalizedCustomerInteraction,
            invoiceAlreadySent: !!invoiceAlreadySent,
            areasTreated: completionAreas,
            waveguardEquipmentSystemId,
            waveguardCalibrationId,
            waveguardBlackoutApproval,
            waveguardNLimitApproval,
            waveguardManagerApproval,
            waveguardTankCleanout,
            ...(treeShrubCloseoutSummary ? {
              treeShrubCloseout: treeShrubCloseoutSummary,
              treeShrubCloseoutWarnings,
            } : {}),
            inventoryDeductions,
            protocolActionsCompleted: reportProtocolActions,
            protocolActionScopesCompleted: reportProtocolActionScopes,
            observations: reportObservations,
            recommendations: reportRecommendations,
          };
          const serviceData = {
            protocol: {
              visitOutcome,
              actions: reportProtocolActions,
              observations: reportObservations,
              recommendations: reportRecommendations,
            },
          };
          const [priorVisitCountRow] = serviceRecordCols.visit_number
            ? await trx('service_records')
              .where({ customer_id: svc.customer_id, status: 'completed' })
              .where(function sameServiceLine() {
                this.where({ service_line: reportServiceLine })
                  .orWhere(function legacyServiceType() {
                    this.whereNull('service_line').where('service_type', svc.service_type);
                  });
              })
              .count('* as count')
            : [{ count: 0 }];
          const recordInsert = {
            scheduled_service_id: svc.id,
            customer_id: svc.customer_id,
            technician_id: svc.technician_id,
            service_date: completionServiceDate,
            service_type: svc.service_type,
            status: isIncompleteVisit ? 'incomplete' : 'completed',
            technician_notes: technicianNotes || '',
            structured_notes: serializeJsonb(structuredNotes),
            areas_serviced: serializeJsonb(completionAreas),
            customer_interaction: normalizedCustomerInteraction,
            soil_temp: soilTemp || null,
            thatch_measurement: thatchMeasurement || null,
            soil_ph: soilPh || null,
            soil_moisture: soilMoisture || null,
          };
          if (serviceRecordCols.report_template_version && useServiceReportV1) recordInsert.report_template_version = 'service_report_v1';
          if (serviceRecordCols.service_line) recordInsert.service_line = reportServiceLine;
          if (serviceRecordCols.service_tier) recordInsert.service_tier = svc.cust_waveguard_tier || null;
          if (serviceRecordCols.visit_number) recordInsert.visit_number = Number(priorVisitCountRow?.count || 0) + 1;
          Object.assign(recordInsert, buildServiceRecordCompletionTimingFields({
            scheduledService: svc,
            lifecycleUpdates,
            completedAt: completionEndedAt,
            serviceRecordCols,
          }));
          if (serviceRecordCols.conditions && conditionsAtApplication) recordInsert.conditions = serializeJsonb(conditionsAtApplication);
          if (serviceRecordCols.is_callback) recordInsert.is_callback = !!svc.is_callback;
          if (serviceRecordCols.service_data) recordInsert.service_data = serializeJsonb(serviceData);
          if (serviceRecordCols.advisory && useServiceReportV1) {
            // Pass the completed-action scopes so an interior treatment keeps
            // its re-entry window even when only exterior areas were chipped.
            // This is the gate: the advisory is persisted here and the report
            // build can only zero it further, never restore it.
            const advisoryNormalized = buildCompletionAdvisory({
              advisoryDefaults: reportConfig.advisoryDefaults,
              completionAreas,
              protocolActionScopes: reportProtocolActionScopes,
              applications: products || [],
            });
            recordInsert.advisory = serializeJsonb(advisoryNormalized);
            const interiorBefore = reportConfig.advisoryDefaults?.interior_reentry_min ?? null;
            const interiorAfter = advisoryNormalized.interior_reentry_min ?? null;
            if (interiorBefore !== interiorAfter) {
              logger.info('[completion] re-entry scope normalized', {
                serviceId: svc.id,
                areasTreated: completionAreas,
                protocolActionScopesCompleted: reportProtocolActionScopes,
                interiorReentryMinBefore: interiorBefore,
                interiorReentryMinAfter: interiorAfter,
              });
            }
          }
          if (serviceRecordCols.completion_source) recordInsert.completion_source = 'detailed_form';
          if (serviceRecordCols.protocol_defaults_used) recordInsert.protocol_defaults_used = false;

          // Tech-side Pest Pressure rating capture — write iff (a) the
          // request supplied a valid integer 0-5 (validated near top of
          // handler), (b) the active config has
          // `allowTechnicianClientRatingEntry` enabled, AND (c) this
          // record's `service_line` is in the config's
          // `enabledServiceLines` allow-list. The engine's score calc
          // skips lines outside the allow-list anyway, so writing the
          // rating for a tree-shrub or termite visit would dead-end the
          // data (column gets set but never read). Inline-load the
          // config inside the txn so we read a consistent snapshot with
          // the score calc that runs a few lines below.
          if (clientPestRating != null
            && serviceRecordCols.client_pest_rating
            && serviceRecordCols.client_pest_rating_source) {
            const pestPressureConfig = await loadPestPressureConfig(trx);
            const techEntryAllowed = !!(pestPressureConfig
              && pestPressureConfig.allowTechnicianClientRatingEntry === true);
            const enabledLines = Array.isArray(pestPressureConfig && pestPressureConfig.enabledServiceLines)
              ? pestPressureConfig.enabledServiceLines
              : [];
            const serviceLineAllowed = enabledLines.length === 0
              || (reportServiceLine && enabledLines.includes(reportServiceLine));
            if (techEntryAllowed && serviceLineAllowed) {
              recordInsert.client_pest_rating = clientPestRating;
              recordInsert.client_pest_rating_source = 'technician';
              if (serviceRecordCols.client_pest_rating_at) {
                recordInsert.client_pest_rating_at = trx.fn.now();
              }
            }
          }

        // 1. service_record — the canonical "completion happened" audit.
        // scheduled_service_id is the FK back to the source row so
        // downstream code (e.g., tech-track's photo upload) can resolve
        // record-from-service unambiguously. Codex P1 on PR #340 — the
        // old (customer_id, technician_id, service_date) soft-join
        // collided on same-day same-customer-same-tech double visits.
        [record] = await trx('service_records').insert(recordInsert).returning('*');

        if (useServiceReportV1 && serviceFindingsAvailable && reportObservations.length) {
          const findingRows = reportObservations.map((title) => ({
            service_record_id: record.id,
            category: title.toLowerCase().includes('concern') ? 'conducive_condition' : 'observation',
            severity: completionFindingSeverity(title),
            title,
            detail: null,
            recommendation: null,
          }));
          await trx('service_findings').insert(findingRows);
        }
        if (
          useServiceReportV1
          && serviceFindingsAvailable
          && shouldInsertNoActivityFinding({
            visitOutcome,
            observations: reportObservations,
            recommendations: reportRecommendations,
            concernText,
          })
        ) {
          await trx('service_findings').insert({
            service_record_id: record.id,
            ...buildNoActivityFinding(reportServiceLine),
          });
        }
        if (useServiceReportV1 && serviceFindingsAvailable && serviceRecordCols.pressure_index) {
          const pestPressure = await runPestPressureForServiceRecord(record.id, trx);
          if (pestPressure && pestPressure.result.displayedScore != null) {
            record.pressure_index = pestPressure.result.displayedScore;
          }
        }

        if (canLinkLawnAssessmentRecord) {
          const linkPayload = {
            service_id: svc.id,
            service_record_id: record.id,
            updated_at: trx.fn.now(),
          };
          if (lawnAssessmentId) {
            const [linked] = await trx('lawn_assessments')
              .where({
                id: lawnAssessmentId,
                customer_id: svc.customer_id,
                service_id: svc.id,
                confirmed_by_tech: true,
              })
              .update(linkPayload)
              .returning('id');
            linkedLawnAssessmentId = linked?.id || linked || null;
            if (!linkedLawnAssessmentId) {
              const err = new Error('lawnAssessmentId was not confirmed for this service');
              err.isOperational = true;
              err.statusCode = 400;
              throw err;
            }
          }
          if (!linkedLawnAssessmentId) {
            const existing = await trx('lawn_assessments')
              .where({
                service_id: svc.id,
                customer_id: svc.customer_id,
                confirmed_by_tech: true,
              })
              .orderByRaw('confirmed_at DESC NULLS LAST')
              .orderBy('created_at', 'desc')
              .first('id');
            if (existing?.id) {
              await trx('lawn_assessments')
                .where({ id: existing.id })
                .update(linkPayload);
              linkedLawnAssessmentId = existing.id;
            }
          }
          if (linkedLawnAssessmentId) {
            record.structured_notes = {
              ...structuredNotes,
              lawnAssessmentId: linkedLawnAssessmentId,
            };
            await trx('service_records')
              .where({ id: record.id })
              .update({ structured_notes: serializeJsonb(record.structured_notes) });
          }
        }

        const turfProfile = await trx('customer_turf_profiles')
          .where({ customer_id: svc.customer_id, active: true })
          .first()
          .catch(() => null);

        // 2. service_products — children of the service_record.
        const insertedServiceProducts = [];
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
            const applicationMethod = inferServiceReportApplicationMethod(product, p, reportServiceLine);
            const areaValue = p.areaValue != null && p.areaValue !== '' ? Number(p.areaValue) : null;
            const areaUnit = p.areaUnit || null;
            if (
              !isIncompleteVisit
              &&
              requiresLinearFtForReportApplication(applicationMethod)
              && (!Number.isFinite(areaValue) || areaValue <= 0 || areaUnit !== 'linear_ft')
            ) {
              const err = new Error(`Linear feet are required for ${product.name}`);
              err.isOperational = true; err.statusCode = 400;
              err.code = 'linear_ft_required';
              throw err;
            }
            if (
              !isIncompleteVisit
              &&
              requiresSqftForReportApplication(applicationMethod, reportServiceLine)
              && (!Number.isFinite(areaValue) || areaValue <= 0 || areaUnit !== 'sqft')
            ) {
              const err = new Error(`Square feet are required for ${product.name}`);
              err.isOperational = true; err.statusCode = 400;
              err.code = 'area_sqft_required';
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
            const serviceProductInsert = {
              service_record_id: record.id,
              product_name: product.name,
              product_category: product.category || p.category || null,
              active_ingredient: product.active_ingredient || null,
              moa_group: product.moa_group || null,
              application_rate: p.rate ? parseFloat(p.rate) : null,
              rate_unit: p.rateUnit || null,
              total_amount: appliedAmount,
              amount_unit: appliedAmountUnit,
            };
            if (serviceProductCols.product_id) serviceProductInsert.product_id = product.id;
            if (serviceProductCols.application_method) serviceProductInsert.application_method = applicationMethod;
            if (serviceProductCols.application_area) serviceProductInsert.application_area = p.applicationArea || p.area || null;
            if (serviceProductCols.epa_reg_number) serviceProductInsert.epa_reg_number = product.epa_reg_number || product.epa_registration_number || null;
            if (serviceProductCols.zone_ids) serviceProductInsert.zone_ids = Array.isArray(p.zoneIds) ? p.zoneIds : [];
            if (serviceProductCols.targets) serviceProductInsert.targets = Array.isArray(p.targets) ? p.targets : [];
            if (serviceProductCols.area_value) {
              serviceProductInsert.area_value = Number.isFinite(areaValue) ? areaValue : null;
            }
            if (serviceProductCols.area_unit) serviceProductInsert.area_unit = areaUnit;
            const [serviceProduct] = await trx('service_products').insert(serviceProductInsert).returning('*');
            insertedServiceProducts.push(serviceProduct);

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

        if (!isIncompleteVisit && isWaveGuardLawnCompletion(svc) && waveguardPlan?.protocol?.structured) {
          const protocolCompletion = await recordLawnProtocolCompletion(trx, {
            service: svc,
            serviceRecord: record,
            plan: waveguardPlan,
            serviceProducts: insertedServiceProducts,
            completionInput: {
              ...(lawnProtocolCompletion || {}),
              inventoryDeductions,
            },
            equipmentSystemId: waveguardEquipmentSystemId,
            calibrationId: waveguardCalibrationId,
            serviceDate: completionEndedAt,
          });
          if (protocolCompletion) {
            record.structured_notes = {
              ...(record.structured_notes || structuredNotes),
              lawnProtocolCompletion: normalizeCompletionForStructuredNotes(protocolCompletion),
            };
            await trx('service_records')
              .where({ id: record.id })
              .update({ structured_notes: serializeJsonb(record.structured_notes) });
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

        if (treeShrubCloseoutRequired) {
          completionPhotoUploadResult = await uploadServicePhotoDataUrls({
            serviceRecordId: record.id,
            photos: completionPhotos,
            photoType: 'after',
            knex: trx,
          });
          if (completionPhotoUploadResult.uploaded < TREE_SHRUB_MIN_CLOSEOUT_PHOTOS) {
            throw treeShrubPhotoUploadRequiredError(
              completionPhotoUploadResult,
              TREE_SHRUB_MIN_CLOSEOUT_PHOTOS,
            );
          }
          completionPhotosUploadedBeforeCommit = true;
          const photoNotes = {
            ...parseJsonObject(record.structured_notes),
            completionPhotos: {
              uploaded: completionPhotoUploadResult.uploaded,
              failed: completionPhotoUploadResult.failed,
              uploadedAt: new Date().toISOString(),
              requiredMinimum: TREE_SHRUB_MIN_CLOSEOUT_PHOTOS,
            },
          };
          record.structured_notes = photoNotes;
          await trx('service_records')
            .where({ id: record.id })
            .update({ structured_notes: serializeJsonb(photoNotes) });
        }

        // 3. Lifecycle timestamps the route owns. transitionJobStatus
        // owns status + updated_at; we own the service timing columns
        // on the same row.
        const scheduledServiceUpdate = { ...lifecycleUpdates };
        if (!isIncompleteVisit && isWaveGuardLawnCompletion(svc) && waveguardPlan?.protocol?.structured) {
          const structured = waveguardPlan.protocol.structured;
          const window = structured.window || {};
          scheduledServiceUpdate.lawn_protocol_key = structured.protocolKey || null;
          scheduledServiceUpdate.lawn_protocol_version = structured.version || null;
          scheduledServiceUpdate.lawn_protocol_window_key = window.key || null;
          scheduledServiceUpdate.lawn_protocol_window_title = window.title || null;
          scheduledServiceUpdate.assigned_equipment_system_id = waveguardEquipmentSystemId || null;
          scheduledServiceUpdate.assigned_calibration_id = waveguardCalibrationId || null;
          scheduledServiceUpdate.lawn_protocol_assignment_source = 'dispatch_closeout';
          scheduledServiceUpdate.lawn_protocol_assigned_by = req.technicianId || null;
          scheduledServiceUpdate.lawn_protocol_assigned_at = completionEndedAt;
          scheduledServiceUpdate.lawn_protocol_assignment_snapshot = serializeJsonb({
            protocol: {
              key: structured.protocolKey || null,
              version: structured.version || null,
              windowKey: window.key || null,
              windowTitle: window.title || null,
              goal: window.goal || null,
            },
            equipment: {
              systemId: waveguardEquipmentSystemId || null,
              calibrationId: waveguardCalibrationId || null,
              carrierGalPer1000: waveguardPlan.mixCalculator?.carrierGalPer1000 || null,
            },
          });
        }
        await trx('scheduled_services').where({ id: svc.id }).update(scheduledServiceUpdate);

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

    if (!completionPhotosUploadedBeforeCommit && Array.isArray(completionPhotos) && completionPhotos.length) {
      completionPhotoUploadResult = await uploadServicePhotoDataUrls({
        serviceRecordId: record.id,
        photos: completionPhotos,
        photoType: 'after',
      });
      if (completionPhotoUploadResult.failed > 0) {
        logger.warn(
          `[dispatch] ${completionPhotoUploadResult.failed} completion photo upload(s) failed for service_record ${record.id}`
        );
      }
      const latestNotes = parseJsonObject(record.structured_notes);
      const photoNotes = {
        ...latestNotes,
        completionPhotos: {
          uploaded: completionPhotoUploadResult.uploaded,
          failed: completionPhotoUploadResult.failed,
          uploadedAt: new Date().toISOString(),
        },
      };
      await db('service_records').where({ id: record.id }).update({
        structured_notes: serializeJsonb(photoNotes),
      }).catch((updateErr) => {
        logger.warn(`[dispatch] completion photo status update failed: ${updateErr.message}`);
      });
      record.structured_notes = photoNotes;
    }

    const completedLawnAssessmentId =
      linkedLawnAssessmentId || parseJsonObject(record.structured_notes).lawnAssessmentId || null;
    if (!isIncompleteVisit && completedLawnAssessmentId) {
      try {
        const completedAssessment = await db('lawn_assessments')
          .where({
            id: completedLawnAssessmentId,
            customer_id: svc.customer_id,
            service_id: svc.id,
            confirmed_by_tech: true,
          })
          .first('id');
        if (!completedAssessment) {
          throw new Error('Linked lawn assessment is not confirmed for this service');
        }
        if (canLinkLawnAssessmentRecord) {
          await db('lawn_assessments')
            .where({ id: completedAssessment.id })
            .update({
              service_id: svc.id,
              service_record_id: record.id,
              updated_at: new Date(),
            });
        }
        const wiki = require('../services/agronomic-wiki');
        const outcome = await wiki.linkTreatmentOutcome(record.id);
        await attachLawnAssessmentOutcomePhotoRefs(outcome, completedLawnAssessmentId);
      } catch (err) {
        logger.error(`[dispatch] Lawn assessment service_record link failed (non-blocking): ${err.message}`);
      }
    }

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
    try {
      const result = await trackTransitions.markComplete(svc.id, {
        actorType: 'admin',
        actorId: req.technicianId,
      });
      await recordTrackTransitionResultFailure({
        jobId: svc.id,
        action: 'mark_complete',
        actorId: req.technicianId,
        result,
      });
    } catch (e) {
      logger.error(`[admin-dispatch] markComplete failed: ${e.message}`);
      await recordTrackTransitionFailure({
        jobId: svc.id,
        action: 'mark_complete',
        actorId: req.technicianId,
        error: e,
      });
    }

    if (isIncompleteVisit) {
      const responsePayload = {
        success: true,
        serviceRecordId: record.id,
        invoiceId: null,
        invoiceTotal: null,
        completionPhotoUpload: completionPhotoUploadResult,
      };
      await CompletionAttempts.markCompletionAttemptSucceeded(completionAttempt, { record, invoice: null, response: responsePayload });
      markedSucceeded = true;
      return res.json(responsePayload);
    }

    // Invoice + completion SMS:
    //   - If the appointment was flagged `create_invoice_on_complete` (scheduler's
    //     "Create invoice" checkbox) OR the customer is WaveGuard with a monthly_rate,
    //     generate an invoice and send a single combined SMS (report + pay link),
    //     unless the visit is already covered by prepay/paid invoice/autopay.
    //   - Otherwise send the plain service-complete SMS (report link only).
    const hasVisitPrice = svc.estimated_price != null && Number(svc.estimated_price) > 0;
    const invoiceAmount = hasVisitPrice
      ? Number(svc.estimated_price)
      : (svc.cust_monthly_rate && Number(svc.cust_monthly_rate) > 0 ? Number(svc.cust_monthly_rate) : 0);
    const customerAutopayActive = await customerOnAutopay({
      id: svc.customer_id,
      autopay_enabled: svc.cust_autopay_enabled,
      autopay_paused_until: svc.cust_autopay_paused_until,
      autopay_payment_method_id: svc.cust_autopay_payment_method_id,
      ach_status: svc.cust_ach_status,
    });
    const autopayCoversVisit = customerAutopayActive
      && !hasVisitPrice
      && !!svc.cust_waveguard_tier
      && Number(svc.cust_monthly_rate || 0) > 0;
    // Skip invoice creation if a paid invoice already exists for this service record
    // (covers the "customer paid prior to service report" case)
    let invoiceCreated = false;
    let payUrl = null;
    let invoice = null;
    let alreadyPaid = false;
    try {
      if (!recapReviewOnly) {
        const existingPaid = await db('invoices')
          .where({ service_record_id: record.id, status: 'paid' })
          .first();
        if (existingPaid) alreadyPaid = true;
      }
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
        if (!recapReviewOnly) {
          payUrl = existingCompletionInvoice.token
            ? await shortenOrPassthrough(
                `${publicPortalUrl()}/pay/${existingCompletionInvoice.token}`,
                {
                  kind: 'invoice',
                  entityType: 'invoices',
                  entityId: existingCompletionInvoice.id,
                  customerId: existingCompletionInvoice.customer_id,
                  codePrefix: invoiceShortCodePrefix(existingCompletionInvoice),
                }
              )
            : null;
          if (existingCompletionInvoice.status === 'paid') alreadyPaid = true;
          else invoiceCreated = true;
        }
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
      if (!recapReviewOnly) {
        preMintedInvoice = await db('invoices')
          .where({ scheduled_service_id: svc.id })
          .whereNot('status', 'void')
          .orderBy('created_at', 'desc')
          .first();
      }
    } catch (e) { /* column may not exist pre-migration — non-blocking */ }
    const shouldInvoice = !recapReviewOnly && !alreadyPaid && !prepaidCovered && !autopayCoversVisit && !preMintedInvoice && !existingCompletionInvoice
      && (!!svc.create_invoice_on_complete || !!svc.cust_waveguard_tier) && invoiceAmount > 0;
    // Customer-facing SMS URL must be the canonical portal domain, not
    // the raw Railway URL (CLIENT_URL was set to the Railway hostname on
    // prod for app-internal redirects). publicPortalUrl() reads
    // PUBLIC_PORTAL_URL first which is the canonical public origin.
    const portalUrl = publicPortalUrl();
    let reportUrl = portalUrl;
    let reportToken = null;
    try {
      const { ensureReportToken } = require('./reports-public');
      reportToken = await ensureReportToken(record.id);
      if (reportToken) reportUrl = `${portalUrl}/report/${reportToken}`;
    } catch (err) {
      logger.error(`[dispatch] service report token mint failed: ${err.message}`);
    }
    const serviceReportV1Delivery = shouldSendServiceReportV1Delivery(record);
    if (serviceReportV1Delivery && reportToken) {
      await enqueuePdfRenderJob({
        serviceRecordId: record.id,
        payload: {
          source: 'dispatch_complete',
          token: reportToken,
        },
      }).catch((err) => {
        logger.warn(`[dispatch] service report PDF render queue failed for ${record.id}: ${err.message}`);
      });
    }
    let reportSmsUrl = reportUrl;
    if (serviceReportV1Delivery && reportUrl && reportUrl !== portalUrl) {
      reportSmsUrl = await shortenOrPassthrough(reportUrl, {
        kind: 'service_report',
        entityType: 'service_records',
        entityId: record.id,
        customerId: svc.customer_id,
        codePrefix: 'report',
      });
    }
    let serviceReportDynamicContext = null;
    let serviceReportPreviewAsset = null;
    if (serviceReportV1Delivery && useServiceReportV1) {
      serviceReportDynamicContext = await buildServiceReportDynamicContext({
        recordId: record.id,
        mode: 'static',
      }).catch((err) => {
        logger.warn(`[dispatch] service report dynamic context skipped: ${err.message}`);
        return null;
      });
      const mmsPreviewEnabled = await runtimeServiceReportFlag(
        req,
        'service_report_mms_preview_v1',
        'SERVICE_REPORT_MMS_PREVIEW_ENABLED',
        false,
      );
      if (mmsPreviewEnabled && reportToken) {
        serviceReportPreviewAsset = await buildAndStoreSmsPreviewImage({
          recordId: record.id,
          token: reportToken,
          dynamicContext: serviceReportDynamicContext,
        }).catch((err) => {
          logger.warn(`[dispatch] service report MMS preview skipped: ${err.message}`);
          return null;
        });
      }
    }
    const toCents = (value) => Math.max(0, Math.round((Number(value) || 0) * 100));
    const centsToDollars = (cents) => (cents / 100).toFixed(2);
    const applyPrepaidCreditToInvoice = async (invoiceRow) => {
      const prepaidCents = svc.prepaid_amount != null ? toCents(svc.prepaid_amount) : 0;
      if (!(prepaidCents > 0) || !invoiceRow?.id) return invoiceRow;

      return db.transaction(async (trx) => {
        const lockedInvoice = await trx('invoices')
          .where({ id: invoiceRow.id })
          .forUpdate()
          .first();
        if (!lockedInvoice) return invoiceRow;
        if (lockedInvoice.status === 'paid') return lockedInvoice;
        const invoiceTotalCents = toCents(lockedInvoice.total);
        if (!(invoiceTotalCents > 0)) return lockedInvoice;
        const existingCredit = await trx('payments')
          .where({ customer_id: svc.customer_id, status: 'paid' })
          .whereRaw("metadata::jsonb ->> 'source' = ?", ['scheduled_service_prepaid'])
          .whereRaw("metadata::jsonb ->> 'invoice_id' = ?", [lockedInvoice.id])
          .whereRaw("metadata::jsonb ->> 'scheduled_service_id' = ?", [svc.id])
          .first('id');
        if (existingCredit) return lockedInvoice;

        const creditCents = Math.min(prepaidCents, invoiceTotalCents);
        const remainingCents = Math.max(0, invoiceTotalCents - creditCents);
        const prepaidCredit = centsToDollars(creditCents);
        const remainingTotal = centsToDollars(remainingCents);
        const stamp = etDateString();
        const noteLine = `[${stamp}] Prepaid amount applied after tax: $${prepaidCredit}`;
        const nextNotes = lockedInvoice.notes ? `${lockedInvoice.notes}\n${noteLine}` : noteLine;
        const paidByPrepayment = remainingCents <= 0;
        const [updatedInvoice] = await trx('invoices')
          .where({ id: lockedInvoice.id })
          .update({
            total: remainingTotal,
            status: paidByPrepayment ? 'paid' : lockedInvoice.status,
            paid_at: paidByPrepayment ? trx.fn.now() : lockedInvoice.paid_at,
            notes: nextNotes,
            payment_method: svc.prepaid_method || lockedInvoice.payment_method || null,
            payment_reference: svc.prepaid_note || lockedInvoice.payment_reference || null,
            payment_recorded_at: svc.prepaid_at || trx.fn.now(),
            updated_at: trx.fn.now(),
          })
          .returning('*');
        const creditedInvoice = updatedInvoice || {
          ...lockedInvoice,
          total: remainingTotal,
          status: paidByPrepayment ? 'paid' : lockedInvoice.status,
          notes: nextNotes,
        };
        await trx('payments').insert({
          customer_id: svc.customer_id,
          amount: prepaidCredit,
          status: 'paid',
          description: `Prepaid credit applied to invoice ${creditedInvoice.invoice_number}`,
          payment_date: etDateString(),
          metadata: JSON.stringify({
            invoice_id: lockedInvoice.id,
            scheduled_service_id: svc.id,
            source: 'scheduled_service_prepaid',
            method: svc.prepaid_method || null,
            note: svc.prepaid_note || null,
          }),
        });
        return creditedInvoice;
      });
    };

    if (shouldInvoice) {
      try {
        const InvoiceService = require('../services/invoice');
        invoice = await InvoiceService.createFromService(record.id, {
          amount: invoiceAmount,
          description: svc.service_type,
          taxRate: svc.property_type === 'commercial' ? 0.07 : 0,
          useScheduledReplay: true,
          dueDate: serviceDateOnly(record.service_date),
        });
        invoice = await applyPrepaidCreditToInvoice(invoice);
        invoiceCreated = true;
        payUrl = await shortenOrPassthrough(`${portalUrl}/pay/${invoice.token}`, {
          kind: 'invoice', entityType: 'invoices', entityId: invoice.id, customerId: invoice.customer_id,
          codePrefix: invoiceShortCodePrefix(invoice),
        });
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
      preMintedInvoice = await applyPrepaidCreditToInvoice(preMintedInvoice);
      invoice = preMintedInvoice;
      payUrl = await shortenOrPassthrough(`${portalUrl}/pay/${invoice.token}`, {
        kind: 'invoice', entityType: 'invoices', entityId: invoice.id, customerId: invoice.customer_id,
        codePrefix: invoiceShortCodePrefix(invoice),
      });
      // Treat already-paid pre-mint as the same SMS branch as prepaid.
      if (invoice.status === 'paid') alreadyPaid = true;
      else invoiceCreated = true;
    }

    // Immediate/legacy review requests can be bundled into the completion SMS.
    // Explicit delayed timing skips the bundle and schedules a separate review
    // request below.
    const invoiceBlocksReview = !recapReviewOnly && !!invoice && invoice.status !== 'paid';
    const clientSuppressionBlocksReview = reviewSuppression && reviewSuppression !== 'invoice_created';
    const effectiveRequestReview = !!requestReview && !clientSuppressionBlocksReview && !invoiceBlocksReview;
    const shouldBundleReview =
      sendCompletionSms &&
      effectiveRequestReview &&
      svc.cust_phone &&
      !serviceReportV1Delivery &&
      (completionReviewDelayMinutes === undefined || completionReviewDelayMinutes === 0);

    let bundledReviewUrl = null;
    if (shouldBundleReview) {
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

    const suppressCompletionInvoiceLink = !!invoiceAlreadySent;
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
        const withRecap = (body, conciseBody) => {
          const suffix = countSegments(`${conciseBody}${reviewSuffix}`).segmentCount <= 2 ? reviewSuffix : '';
          const tail = countSegments(`${body}${suffix}`).segmentCount <= 2 ? body : conciseBody;
          return composeCompletionSmsBody({ recapText, body: tail, suffix });
        };
        let sentSmsBody = null;
        let completionSmsWasTruncated = false;
        let sentSmsType = null;
        const allowCompletionInvoiceLink = !suppressCompletionInvoiceLink
          && !prepaidCovered
          && !alreadyPaid
          && !autopayCoversVisit;
        const usePaidCompletionTemplate = alreadyPaid
          || prepaidCovered
          || autopayCoversVisit
          || String(invoice?.status || '').toLowerCase() === 'paid';
        const serviceReportV1SmsContext = serviceReportV1Delivery
          ? buildServiceReportV1DeliveryContext({
            record,
            service: svc,
            reportUrl,
            smsReportUrl: reportSmsUrl,
            payUrl: invoiceCreated && payUrl && allowCompletionInvoiceLink ? payUrl : null,
          })
          : null;
        if (serviceReportV1SmsContext?.enabled && !invoiceCreated && !usePaidCompletionTemplate) {
          sentSmsType = serviceReportV1SmsContext.smsType;
          const body = await renderTemplate(sentSmsType, serviceReportV1SmsContext.vars, {
            workflow: 'dispatch_service_complete',
            entity_type: 'service_record',
            entity_id: record.id,
          });
          if (!body) throw new Error(`SMS template ${sentSmsType} is missing or inactive`);
          sentSmsBody = `${body}${reviewSuffix}`.trim();
          completionSmsWasTruncated = false;
        } else if (invoiceCreated && payUrl && allowCompletionInvoiceLink) {
          const body = await renderTemplate('service_complete_with_invoice', {
            first_name: svc.first_name || '',
            service_type: displayServiceType,
            portal_url: reportSmsUrl || reportUrl,
            pay_url: payUrl,
          }, {
            workflow: 'dispatch_service_complete',
            entity_type: 'service_record',
            entity_id: record.id,
          });
          if (!body) throw new Error('SMS template service_complete_with_invoice is missing or inactive');
          sentSmsType = 'service_complete_with_invoice';
          sentSmsBody = `${body}${reviewSuffix}`.trim();
          completionSmsWasTruncated = false;
        } else {
          if (usePaidCompletionTemplate) {
            const body = await renderTemplate('service_complete_prepaid', {
              first_name: svc.first_name || '',
              service_type: displayServiceType,
              portal_url: reportSmsUrl || reportUrl,
            }, {
              workflow: 'dispatch_service_complete',
              entity_type: 'service_record',
              entity_id: record.id,
            });
            if (!body) throw new Error('SMS template service_complete_prepaid is missing or inactive');
            sentSmsType = 'service_complete_prepaid';
            sentSmsBody = `${body}${reviewSuffix}`.trim();
            completionSmsWasTruncated = false;
          } else {
            let body = await renderTemplate('service_complete', {
              first_name: svc.first_name || '',
              service_type: displayServiceType,
              portal_url: reportSmsUrl || reportUrl,
            }, {
              workflow: 'dispatch_service_complete',
              entity_type: 'service_record',
              entity_id: record.id,
            });
            if (!body) throw new Error('SMS template service_complete is missing or inactive');
            body = ensureSmsContainsReportLink(body, reportSmsUrl || reportUrl);
            sentSmsType = 'service_complete';
            if (serviceReportV1Delivery) {
              sentSmsBody = `${body}${reviewSuffix}`.trim();
              completionSmsWasTruncated = false;
            } else {
              const concise = await renderRequiredTemplate('service_complete_concise', {
                first_name: svc.first_name || '',
                portal_url: reportUrl,
              }, {
                workflow: 'dispatch_service_complete',
                entity_type: 'service_record',
                entity_id: record.id,
              });
              ({ body: sentSmsBody, truncated: completionSmsWasTruncated } = withRecap(body, concise));
            }
          }
        }
        if (sentSmsBody) {
          const sendingNotes = {
            ...recordStructuredNotes,
            completionSmsStatus: 'sending',
            completionSmsType: sentSmsType,
            completionSmsBody: sentSmsBody,
            completionSmsTruncated: completionSmsWasTruncated,
            completionSmsAttemptedAt: new Date().toISOString(),
          };
          await db('service_records').where({ id: record.id }).update({
            structured_notes: serializeJsonb(sendingNotes),
          });
          const smsMetadata = { original_message_type: sentSmsType, service_record_id: record.id };
          if (serviceReportV1Delivery || String(sentSmsType || '').startsWith('service_report_v1')) {
            smsMetadata.report_template_version = 'service_report_v1';
            smsMetadata.report_url = reportUrl;
            smsMetadata.report_sms_url = reportSmsUrl;
            if (invoice?.id) smsMetadata.invoice_id = invoice.id;
            if (
              serviceReportPreviewAsset?.public_url
              && serviceReportPreviewAsset.content_type === 'image/jpeg'
              && Number(serviceReportPreviewAsset.byte_size || 0) <= 4_500_000
            ) {
              smsMetadata.mediaUrls = [serviceReportPreviewAsset.public_url];
              smsMetadata.allowMediaUrls = true;
              smsMetadata.service_report_preview_asset_id = serviceReportPreviewAsset.id;
            }
          }
          const attemptedMms = Array.isArray(smsMetadata.mediaUrls) && smsMetadata.mediaUrls.length > 0;
          let sentSmsChannel = attemptedMms ? 'mms' : 'sms';
          let mmsFallbackToSms = false;
          const sendInput = {
            to: svc.cust_phone,
            body: sentSmsBody,
            channel: 'sms',
            audience: 'customer',
            purpose: 'appointment',
            customerId: svc.customer_id,
            appointmentId: svc.id,
            identityTrustLevel: 'phone_matches_customer',
            metadata: smsMetadata,
          };
          let smsResult = await sendCustomerMessage(sendInput);
          if (!smsResult.sent && !smsResult.blocked && attemptedMms) {
            logger.warn(`[dispatch] MMS service report send failed for ${record.id}; retrying SMS-only`);
            const fallbackMetadata = { ...smsMetadata };
            delete fallbackMetadata.mediaUrls;
            delete fallbackMetadata.allowMediaUrls;
            fallbackMetadata.mms_fallback_reason = smsResult.reason || smsResult.code || 'provider_failure';
            smsResult = await sendCustomerMessage({
              ...sendInput,
              metadata: fallbackMetadata,
            });
            sentSmsChannel = 'sms';
            mmsFallbackToSms = true;
            sendingNotes.completionSmsMmsFallbackAt = new Date().toISOString();
            sendingNotes.completionSmsMmsFallbackReason = fallbackMetadata.mms_fallback_reason;
          }
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
            record.structured_notes = failedNotes;
            logger.warn(`[dispatch] Completion SMS blocked/failed for customer ${svc.customer_id}: ${smsResult.code || smsResult.reason || 'unknown'}`);
          } else {
            const sentNotes = {
              ...sendingNotes,
              completionSmsStatus: 'sent',
              sentSmsBody,
              sentSmsAt: new Date().toISOString(),
              sentSmsType,
              sentSmsChannel,
              serviceReportPreviewAssetId: serviceReportPreviewAsset?.id || null,
            };
            await db('service_records').where({ id: record.id }).update({
              structured_notes: serializeJsonb(sentNotes),
            });
            await db('service_report_events').insert({
              service_record_id: record.id,
              customer_id: svc.customer_id,
              event_name: sentSmsChannel === 'mms' ? 'mms_sent' : 'sms_sent',
              channel: 'sms',
              metadata: serializeJsonb({
                preview_asset_id: serviceReportPreviewAsset?.id || null,
                fallback_to_sms: mmsFallbackToSms,
              }),
            }).catch((eventErr) => logger.warn(`[dispatch] service report SMS event insert failed: ${eventErr.message}`));
            if (mmsFallbackToSms) {
              await db('service_report_events').insert({
                service_record_id: record.id,
                customer_id: svc.customer_id,
                event_name: 'mms_fallback_to_sms',
                channel: 'sms',
                metadata: serializeJsonb({
                  preview_asset_id: serviceReportPreviewAsset?.id || null,
                  reason: sendingNotes.completionSmsMmsFallbackReason || null,
                }),
              }).catch((eventErr) => logger.warn(`[dispatch] service report MMS fallback event insert failed: ${eventErr.message}`));
            }
            if (invoice?.id && invoiceCreated && payUrl && allowCompletionInvoiceLink) {
              try {
                const InvoiceService = require('../services/invoice');
                invoice = await InvoiceService.markDeliverySent(invoice.id, {
                  sms: true,
                  source: sentSmsType || 'completion_sms_with_invoice',
                  payUrl,
                });
              } catch (statusErr) {
                logger.warn(`[dispatch] Invoice delivery status sync failed for ${invoice.id}: ${statusErr.message}`);
              }
            }
            record.structured_notes = sentNotes;
          }
        }
      } catch (e) {
        const failedNotes = {
          ...parseJsonObject(record.structured_notes),
          completionSmsStatus: 'failed',
          completionSmsError: e.message || 'SMS send failed',
          completionSmsFailedAt: new Date().toISOString(),
        };
        await db('service_records').where({ id: record.id }).update({
          structured_notes: serializeJsonb(failedNotes),
        }).catch((updateErr) => logger.error(`Completion SMS failure status update failed: ${updateErr.message}`));
        record.structured_notes = failedNotes;
        logger.error(`Completion SMS failed: ${e.message}`);
      }
    } else if (sendCompletionSms && svc.cust_phone && completionSmsAlreadyHandled) {
      logger.info(`[dispatch] Completion SMS already sent for service_record ${record.id}; skipping retry send`);
    }

    const serviceReportEmailEnabled = serviceReportV1Delivery
      ? await runtimeServiceReportFlag(
          req,
          'service_report_email_delivery_enabled',
          'SERVICE_REPORT_EMAIL_DELIVERY_ENABLED',
          false,
        )
      : false;
    if (serviceReportV1Delivery && sendCompletionSms && !serviceReportEmailEnabled) {
      const latestNotes = parseJsonObject(record.structured_notes);
      if (!latestNotes.serviceReportV1EmailStatus) {
        const disabledNotes = {
          ...latestNotes,
          serviceReportV1EmailStatus: 'disabled',
          serviceReportV1EmailDisabledAt: new Date().toISOString(),
        };
        await db('service_records').where({ id: record.id }).update({
          structured_notes: serializeJsonb(disabledNotes),
        }).catch((updateErr) => logger.warn(`[dispatch] v1 report email disabled status update failed: ${updateErr.message}`));
        record.structured_notes = disabledNotes;
      }
    }

    if (serviceReportV1Delivery && sendCompletionSms && serviceReportEmailEnabled) {
      const latestNotes = parseJsonObject(record.structured_notes);
      const emailAlreadyHandled = ['queued', 'sending', 'sent', 'skipped'].includes(latestNotes.serviceReportV1EmailStatus);
      if (!emailAlreadyHandled) {
        try {
          const queued = await enqueueServiceReportV1EmailDelivery({
            serviceRecordId: record.id,
            customerId: svc.customer_id,
            token: reportToken,
            reportUrl,
            pdfUrl: reportToken ? `${portalUrl}/api/reports/${reportToken}` : null,
            payload: {
              scheduled_service_id: svc.id,
              source: 'dispatch_complete',
            },
          });
          const queuedNotes = {
            ...latestNotes,
            serviceReportV1EmailStatus: queued.delivery?.status || (queued.skipped ? 'skipped' : 'queued'),
            serviceReportV1EmailDeliveryId: queued.delivery?.id || null,
            serviceReportV1EmailQueuedAt: queued.delivery?.created_at || new Date().toISOString(),
            serviceReportV1EmailError: queued.ok ? null : queued.error || null,
          };
          await db('service_records').where({ id: record.id }).update({
            structured_notes: serializeJsonb(queuedNotes),
          });
          record.structured_notes = queuedNotes;
        } catch (err) {
          const failedNotes = {
            ...latestNotes,
            serviceReportV1EmailStatus: 'failed',
            serviceReportV1EmailError: err.message || 'Email queue failed',
            serviceReportV1EmailFailedAt: new Date().toISOString(),
          };
          await db('service_records').where({ id: record.id }).update({
            structured_notes: serializeJsonb(failedNotes),
          }).catch((updateErr) => logger.error(`[dispatch] v1 report email queue status update failed: ${updateErr.message}`));
          record.structured_notes = failedNotes;
          logger.error(`[dispatch] v1 report email queue failed: ${err.message}`);
        }
      }
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
          delayMinutes: completionReviewDelayMinutes === undefined
            ? 120
            : completionReviewDelayMinutes,
        });
      } catch (e) { logger.error(`[dispatch] Review request schedule failed: ${e.message}`); }
    }

    // The first complete transition wakes any already-open customer
    // tracker. Re-emit once report/invoice/review artifacts are minted
    // so the final card can render its links without requiring a manual
    // refresh. markComplete is idempotent once track_state is complete.
    try {
      const result = await trackTransitions.markComplete(svc.id, {
        actorType: 'admin',
        actorId: req.technicianId,
      });
      await recordTrackTransitionResultFailure({
        jobId: svc.id,
        action: 'refresh_complete_tracker',
        actorId: req.technicianId,
        result,
      });
    } catch (e) {
      logger.error(`[admin-dispatch] refresh complete tracker failed: ${e.message}`);
      await recordTrackTransitionFailure({
        jobId: svc.id,
        action: 'refresh_complete_tracker',
        actorId: req.technicianId,
        error: e,
      });
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

      try {
        const { triggerNotification } = require('../services/notification-triggers');
        await triggerNotification('job_complete', {
          techName: svc.tech_name, serviceName: svc.service_type,
          customerName: `${svc.first_name} ${svc.last_name}`, serviceId: svc.id,
        });
      } catch (e) {
        logger.error(`[dispatch] triggerNotification job_complete failed: ${e.message}`);
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

    const finalRecordNotes = parseJsonObject(record.structured_notes);
    const completionSmsStatus = finalRecordNotes.completionSmsStatus
      || (sendCompletionSms ? (svc.cust_phone ? 'not_sent' : 'no_phone') : 'not_requested');
    const completionSmsType = finalRecordNotes.completionSmsType || finalRecordNotes.sentSmsType || null;
    const invoicePaymentActionRequired = !!invoice
      && invoice.status !== 'paid'
      && !prepaidCovered
      && !alreadyPaid
      && !autopayCoversVisit
      && !suppressCompletionInvoiceLink
      && completionSmsType !== 'service_complete';
    const responsePayload = {
      success: true,
      serviceRecordId: record.id,
      invoiceId: invoice?.id || null,
      invoiceTotal: invoice?.total != null ? Number(invoice.total) : null,
      invoiceToken: invoice?.token || null,
      invoiceStatus: invoice?.status || null,
      reportUrl,
      invoicePaymentActionRequired,
      completionSmsStatus,
      completionSmsError: finalRecordNotes.completionSmsError || null,
      completionSmsType,
      completionSmsTruncated: !!finalRecordNotes.completionSmsTruncated,
      completionPhotoUpload: completionPhotoUploadResult,
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
// PEST CONTROL SERVICE RECAP
// Lightweight "complete + customer recap" path for pest_control services
// (the recurring/one-time pest visits that were being forced into the
// heavy CreateProjectModal). Recap-only completion — no invoicing —
// writing service_records + service_products and optionally texting the
// customer. The router runs requireTechOrAdmin (line ~746) so the tech
// portal reaches these too. See services/pest-recap.js.
// =========================================================================
const PestRecap = require('../services/pest-recap');

function recapActor(req) {
  return {
    actorType: req.techRole === 'admin' ? 'admin' : 'tech',
    actorId: req.technicianId || null,
  };
}

// Techs may only recap their own assigned services; admins any. Returns
// true if allowed, otherwise writes the response and returns false.
async function assertRecapOwnership(req, res) {
  if (req.techRole === 'admin') return true;
  const svc = await db('scheduled_services')
    .where({ id: req.params.serviceId })
    .first('technician_id');
  if (!svc) { res.status(404).json({ error: 'Service not found' }); return false; }
  if (svc.technician_id !== req.technicianId) {
    res.status(403).json({ error: 'Not assigned to this service' });
    return false;
  }
  return true;
}

function recapStatusForReason(reason) {
  if (reason === 'not_found') return 404;
  // Conflict: pest-control gate, or a cancelled/skipped visit that can't be recapped.
  if (reason === 'not_pest_control' || reason === 'service_cancelled' || reason === 'service_skipped') return 409;
  return 400;
}

// GET /:serviceId/pest-recap/context — service info + timeline + product catalog.
router.get('/:serviceId/pest-recap/context', async (req, res, next) => {
  try {
    if (!(await assertRecapOwnership(req, res))) return;
    const ctx = await PestRecap.buildRecapContext(req.params.serviceId);
    if (!ctx.ok) return res.status(recapStatusForReason(ctx.reason)).json({ error: ctx.reason });
    res.json(ctx);
  } catch (err) { next(err); }
});

// POST /:serviceId/pest-recap/draft — AI-draft the customer recap copy.
router.post('/:serviceId/pest-recap/draft', async (req, res, next) => {
  try {
    if (!(await assertRecapOwnership(req, res))) return;
    const { technicianNotes, areasTreated } = req.body || {};
    const result = await PestRecap.draftRecapMessage({
      serviceId: req.params.serviceId,
      technicianNotes,
      areasTreated,
    });
    if (!result.ok) return res.status(recapStatusForReason(result.reason)).json({ error: result.reason });
    res.json(result);
  } catch (err) { next(err); }
});

// POST /:serviceId/pest-recap — commit the recap (complete, no bill).
router.post('/:serviceId/pest-recap', async (req, res, next) => {
  try {
    if (!(await assertRecapOwnership(req, res))) return;
    const { actorType, actorId } = recapActor(req);
    const { technicianNotes, products, customerRecap, sendSms, clientPestRating } = req.body || {};
    const result = await PestRecap.submitRecap({
      serviceId: req.params.serviceId,
      actorType,
      actorId,
      technicianNotes,
      products,
      customerRecap,
      sendSms: !!sendSms,
      clientPestRating: clientPestRating == null ? null : clientPestRating,
    });
    if (!result.ok) return res.status(recapStatusForReason(result.reason)).json({ error: result.reason });
    res.json(result);
  } catch (err) { next(err); }
});

// =========================================================================
// RESCHEDULE ENDPOINTS
// =========================================================================
const SmartRebooker = require('../services/rebooker');
const ForecastAnalyzer = require('../services/forecast-analyzer');

function parseRescheduleWindow(w) {
  if (!w) return { start: null, end: null };
  if (typeof w === 'object') return { start: w.start || null, end: w.end || null };
  const m = String(w).match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
  if (!m) return { start: null, end: null };
  return { start: m[1], end: m[2] };
}

function normalizeHHMM(value) {
  const m = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return `${String(parseInt(m[1], 10)).padStart(2, '0')}:${m[2]}`;
}

function rescheduleReminderTime(date, window) {
  const win = parseRescheduleWindow(window);
  return `${String(date).split('T')[0]}T${normalizeHHMM(win.start) || '08:00'}`;
}

async function syncRescheduleReminder(serviceId, date, window) {
  try {
    const AppointmentReminders = require('../services/appointment-reminders');
    await AppointmentReminders.handleReschedule(
      serviceId,
      rescheduleReminderTime(date, window),
      { sendNotification: false },
    );
  } catch (err) {
    logger.warn(`[dispatch] Reschedule committed for ${serviceId}, but reminder sync failed: ${err.message}`);
  }
}

async function markRescheduleReminderNotified(serviceIds) {
  try {
    const AppointmentReminders = require('../services/appointment-reminders');
    await AppointmentReminders.markRescheduleNoticeSent(serviceIds);
  } catch (err) {
    const count = Array.isArray(serviceIds) ? serviceIds.length : 1;
    logger.warn(`[dispatch] Reschedule SMS sent for ${count} appointment(s), but reminder notice sync failed: ${err.message}`);
  }
}

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
      const occurrences = Array.isArray(result.rescheduledOccurrences) ? result.rescheduledOccurrences : [];
      for (const occurrence of occurrences) {
        await syncRescheduleReminder(
          occurrence.id,
          occurrence.date,
          { start: occurrence.windowStart, end: occurrence.windowEnd },
        );
        try {
          await emitDispatchJobUpdate({ jobId: occurrence.id, actorId: req.technicianId });
        } catch (err) {
          logger.error(`[dispatch] series reschedule board broadcast failed for ${occurrence.id}: ${err.message}`);
        }
      }

      let notificationSent = false;
      let notificationError = null;
      if (notifyCustomer !== false) {
        const svc = await db('scheduled_services')
          .where('scheduled_services.id', req.params.serviceId)
          .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
          .select('scheduled_services.*', 'customers.first_name', 'customers.phone', 'customers.id as customer_id')
          .first();
        if (!svc?.phone) {
          notificationError = 'Customer phone unavailable';
        } else {
          const displayDate = new Date(String(newDate).split('T')[0] + 'T12:00:00')
            .toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/New_York' });
          const win = parseRescheduleWindow(newWindow);
          const windowText = win.start && win.end ? `, ${formatSmsTimeRange(`${win.start}-${win.end}`)}` : '';
          try {
            const body = await renderRequiredTemplate('appointment_series_rescheduled', {
              first_name: svc.first_name || 'there',
              start_date: displayDate,
              window_text: windowText,
            }, {
              workflow: 'dispatch_series_reschedule',
              entity_type: 'scheduled_service',
              entity_id: req.params.serviceId,
            });
            const msg = await sendCustomerMessage({
              to: svc.phone,
              body,
              channel: 'sms',
              audience: 'customer',
              purpose: 'appointment',
              customerId: svc.customer_id,
              identityTrustLevel: 'phone_matches_customer',
              metadata: { original_message_type: 'reschedule_series_confirmation', reasonText },
            });
            notificationSent = !(msg?.blocked || msg?.sent === false);
            if (!notificationSent) notificationError = msg?.code || msg?.reason || 'blocked';
            if (notificationSent) {
              await markRescheduleReminderNotified(occurrences.map((occurrence) => occurrence.id));
            }
          } catch (err) {
            notificationError = err.message;
            logger.warn(`[dispatch] Series reschedule committed for ${req.params.serviceId}, but SMS notification failed: ${err.message}`);
          }
        }
      }

      const { rescheduledOccurrences, ...response } = result;
      return res.json({ ...response, notificationSent, notificationError });
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
    await syncRescheduleReminder(req.params.serviceId, newDate, newWindow);
    try {
      await emitDispatchJobUpdate({ jobId: req.params.serviceId, actorId: req.technicianId });
    } catch (err) {
      logger.error(`[dispatch] reschedule board broadcast failed for ${req.params.serviceId}: ${err.message}`);
    }
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
        try {
          const vars = formatRescheduleTemplateVars(svc);
          const body = await renderRequiredTemplate('appointment_rescheduled', vars, {
            workflow: 'dispatch_reschedule',
            entity_type: 'scheduled_service',
            entity_id: req.params.serviceId,
          });
          const msg = await sendCustomerMessage({
            to: svc.phone,
            body,
            channel: 'sms',
            audience: 'customer',
            purpose: 'appointment',
            customerId: svc.customer_id,
            identityTrustLevel: 'phone_matches_customer',
            metadata: { original_message_type: 'reschedule_confirmation', reasonText },
          });
          notificationSent = !(msg?.blocked || msg?.sent === false);
          if (!notificationSent) notificationError = msg?.code || msg?.reason || 'blocked';
          if (notificationSent) {
            await markRescheduleReminderNotified(req.params.serviceId);
          }
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
//               must have a tech_status row with location_updated_at >= NOW()-24h
//               (rolling window, not midnight ET — avoids the "tech pinged
//               at 11:50pm last night, card disappears at midnight" gap).
//   - jobs[]:   visible scheduled_services WHERE scheduled_date = today (ET),
//               excluding cancelled/rescheduled phantom rows but regardless
//               of assignment, so unassigned pins still show neutral.
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
        ts.location_updated_at,
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
          AND status NOT IN ('cancelled', 'rescheduled')
        GROUP BY technician_id
      ) today_agg ON today_agg.technician_id = t.id
      WHERE t.role IN ('admin','technician')
        AND t.active = TRUE
        AND ts.location_updated_at >= NOW() - INTERVAL '24 hours'
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
        AND s.status NOT IN ('cancelled', 'rescheduled')
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
      location_updated_at: r.location_updated_at,
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
        'ts.updated_at as status_updated_at',
        'ts.location_updated_at'
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
      location_updated_at: tech.location_updated_at || null,
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

// POST /api/admin/dispatch/alerts/resolve-all — clear current Action Queue.
//
// Bulk version of PATCH /alerts/:id/resolve. It marks every unresolved
// dispatch_alerts row resolved, keeps rows for audit history, and emits
// dispatch:alert_resolved for each cleared row so connected dispatch
// boards drop the cards without a refresh.
router.post('/alerts/resolve-all', requireAdmin, async (req, res, next) => {
  try {
    const { resolveAllOpenAlerts } = require('../services/dispatch-alerts');
    const result = await resolveAllOpenAlerts({
      resolvedBy: req.technicianId,
    });
    res.json({
      resolved: result.resolved,
      counts: result.counts,
      alert_ids: result.alerts.map((alert) => alert.id),
    });
  } catch (err) {
    logger.error(`[dispatch/alerts/resolve-all] failed: ${err.message}`);
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
    const result = await assignDispatchJob({
      jobId: req.params.id,
      technicianId: req.body ? req.body.technicianId : undefined,
      actorId: req.technicianId,
    });
    res.json({ job: result.job });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
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
