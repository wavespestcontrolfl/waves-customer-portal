const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin, requireAdmin } = require('../middleware/admin-auth');
const { resolveLocation } = require('../config/locations');
const smsTemplatesRouter = require('./admin-sms-templates');
const logger = require('../services/logger');
const { etDateString, addETDays, parseETDateTime, formatETDay, formatETDate, formatETTime } = require('../utils/datetime-et');
const { arrivalWindowRange, formatSmsTimeRange } = require('../utils/sms-time-format');
const trackTransitions = require('../services/track-transitions');
const { resolveTechPhotoUrl } = require('../services/tech-photo');
const CompletionRecap = require('../services/completion-recap');
const CompletionAttempts = require('../services/completion-attempts');
const PropertyZones = require('../services/property-zones');
const { resolveZoneRowsImageDrift } = require('../services/service-report/zone-drift');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { publicPortalUrl } = require('../utils/portal-url');
const { countSegments } = require('../services/messaging/segment-counter');
const { recordServiceProductNutrients } = require('../services/nutrient-ledger');
const { buildPlanForService, isDateInWindow } = require('../services/waveguard-plan-engine');
const { evaluateWaveGuardManagerApprovals, managerApprovalSummary } = require('../services/waveguard-approval-engine');
const { shortenOrPassthrough, invoiceShortCodePrefix } = require('../services/short-url');
const { customerOnAutopay } = require('../services/autopay-eligibility');
const { assignDispatchJob, emitDispatchJobUpdate } = require('../services/dispatch-assignment');
const { detectServiceLine, getServiceLineConfig, SERVICE_LINE_IDS } = require('../services/service-report/service-line-configs');
const { runAndSwallowErrors: runPestPressureForServiceRecord } = require('../services/pest-pressure/orchestrate');
const { loadActiveConfig: loadPestPressureConfig } = require('../services/pest-pressure/store');
const { buildCompletionAdvisory } = require('../services/service-report/report-data');
const { isValidHeight } = require('../services/service-report/turf-height');
const { createTurfHeightReading } = require('../services/turf-height-service');
const TurfHeightOcr = require('../services/turf-height-ocr');
const { fetchApplicationConditions } = require('../services/service-report/application-conditions');
const {
  buildServiceReportV1DeliveryContext,
  foldLawnScoreIntoCompletionSms,
  shouldSendServiceReportV1Delivery,
} = require('../services/service-report/delivery');
const { enqueueServiceReportV1EmailDelivery } = require('../services/service-report/delivery-queue');
const { enqueuePdfRenderJob } = require('../services/service-report/pdf-queue');
const { buildServiceReportDynamicContext } = require('../services/service-report/dynamic-context');
const { buildAndStoreSmsPreviewImage } = require('../services/service-report/preview-image');
const { buildNoActivityFinding } = require('../services/service-report/no-activity-finding');
const { buildServiceRecordCompletionTimingFields } = require('../services/service-report/service-record-timing');
const {
  cleanupUploadedServicePhotoObjects,
  uploadServicePhotoDataUrls,
} = require('../services/service-photos');
const {
  recordLawnProtocolCompletion,
  normalizeCompletionForStructuredNotes,
} = require('../services/lawn-protocol-completion');
const { validateTreeShrubCloseout, validateTreeShrubTypedCompliance } = require('../services/tree-shrub-closeout');
const { scoreAndStoreTreeShrubAssessment, storeTreeShrubAssessmentFromReview, previewTreeShrubAssessment, treeShrubReviewSignature, treeShrubPhotosHash } = require('../services/tree-shrub-assessment');
const {
  resolveCompletionProfileForScheduledService,
  resolveCompletionProfileForServiceId,
  resolveCompletionDeliveryPosture,
} = require('../services/service-completion-profiles');
const ActivityIndicators = require('../services/service-report/activity-indicators');
const CompanionCompletions = require('../services/service-report/companion-completions');
const {
  resolveProjectCompletionBilling,
  projectFollowupSuggestion,
} = require('../services/project-completion');
// German knockdown follow-up window → suggestion interval (owner spec §8B).
// 'As needed' intentionally absent: it keeps the profile's default interval
// (the report copy for it is interval-free, so no date can contradict it).
const KNOCKDOWN_FOLLOWUP_WINDOW_DAYS = { '10–14 days': 14, '2–3 weeks': 21 };
const { buildPrepaidSeriesContext } = require('../services/prepaid-series');
const {
  findFirstApplicationInvoiceForEstimateService,
} = require('../services/estimate-first-application-invoice');
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

// Whether a completion should produce a service-report EMAIL, decoupled from
// the completion-SMS toggle: an email-only customer (or a completion where SMS
// was skipped) should still get the report. Gates on the report being a real,
// non-suppressed customer report — internal_only / disabled typed reports
// (suppressTypedCustomerComms) are still silenced. The email feature flag is
// applied by the caller. Pure for testability (see _test).
function serviceReportEmailEligible({ serviceReportV1Delivery, suppressTypedCustomerComms } = {}) {
  return Boolean(serviceReportV1Delivery && !suppressTypedCustomerComms);
}

function lawnAssessmentCompletionBlockPayload({
  reportServiceLine,
  isIncompleteVisit,
  lawnAssessmentId,
  submittedAssessment,
  latestAssessment,
} = {}) {
  if (isIncompleteVisit || reportServiceLine !== 'lawn') return null;

  if (lawnAssessmentId && !submittedAssessment) {
    return {
      status: 400,
      payload: {
        error: 'Lawn assessment was not found for this service. Refresh and confirm the assessment before completing.',
        code: 'lawn_assessment_not_found',
        lawnAssessmentId,
      },
    };
  }

  if (submittedAssessment && submittedAssessment.confirmed_by_tech !== true) {
    return {
      status: 400,
      payload: {
        error: 'Confirm the lawn assessment before completing this service so it appears in the customer report.',
        code: 'lawn_assessment_unconfirmed',
        lawnAssessmentId: submittedAssessment.id,
      },
    };
  }

  if (
    lawnAssessmentId
    && submittedAssessment
    && latestAssessment
    && latestAssessment.id !== submittedAssessment.id
  ) {
    if (latestAssessment.confirmed_by_tech === true) {
      return {
        status: 409,
        payload: {
          error: 'A newer lawn assessment is available. Refresh and complete with the latest confirmed assessment.',
          code: 'lawn_assessment_stale',
          lawnAssessmentId: latestAssessment.id,
        },
      };
    }

    return {
      status: 400,
      payload: {
        error: 'A newer lawn assessment was analyzed but not confirmed. Confirm the latest assessment before completing this service.',
        code: 'lawn_assessment_unconfirmed',
        lawnAssessmentId: latestAssessment.id,
      },
    };
  }

  if (!lawnAssessmentId && latestAssessment && latestAssessment.confirmed_by_tech !== true) {
    return {
      status: 400,
      payload: {
        error: 'A lawn assessment was analyzed but not confirmed. Confirm assessment before completing this service.',
        code: 'lawn_assessment_unconfirmed',
        lawnAssessmentId: latestAssessment.id,
      },
    };
  }

  return null;
}

async function preflightLawnAssessmentCompletion({
  knex = db,
  serviceId,
  customerId,
  reportServiceLine,
  isIncompleteVisit,
  lawnAssessmentId,
} = {}) {
  if (isIncompleteVisit || reportServiceLine !== 'lawn' || !serviceId || !customerId) return null;

  if (lawnAssessmentId) {
    const [submittedAssessment, latestAssessment] = await Promise.all([
      knex('lawn_assessments')
        .where({
          id: lawnAssessmentId,
          service_id: serviceId,
          customer_id: customerId,
        })
        .first('id', 'confirmed_by_tech'),
      knex('lawn_assessments')
        .where({
          service_id: serviceId,
          customer_id: customerId,
        })
        .orderBy('created_at', 'desc')
        .orderBy('updated_at', 'desc')
        .first('id', 'confirmed_by_tech'),
    ]);

    return lawnAssessmentCompletionBlockPayload({
      reportServiceLine,
      isIncompleteVisit,
      lawnAssessmentId,
      submittedAssessment,
      latestAssessment,
    });
  }

  const latestAssessment = await knex('lawn_assessments')
    .where({
      service_id: serviceId,
      customer_id: customerId,
    })
    .orderBy('created_at', 'desc')
    .orderBy('updated_at', 'desc')
    .first('id', 'confirmed_by_tech');

  return lawnAssessmentCompletionBlockPayload({
    reportServiceLine,
    isIncompleteVisit,
    lawnAssessmentId,
    latestAssessment,
  });
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
  // Real WaveGuard member tiers only — a flat-commercial lawn job ('Commercial'
  // tier) is excluded from WaveGuard protocol-readiness prep, so it must not
  // enter the WaveGuard fertilizer/N/inventory/manager completion lockouts here.
  return ['Bronze', 'Silver', 'Gold', 'Platinum'].includes(svc?.cust_waveguard_tier)
    && detectServiceLine(svc?.service_type) === 'lawn';
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

// Manufacturer re-entry interval (REI) for the products applied this visit, in
// minutes — the most restrictive (max) across products. Returns null when no
// applied product carries an REI so the caller keeps the service-line default.
// Used to make the "Exterior ready in …" countdown reflect the product label
// instead of a flat default.
async function maxProductReentryMinutes(knex, submittedProducts = []) {
  const productIds = [...new Set((submittedProducts || []).map((p) => p.productId).filter(Boolean))];
  if (!productIds.length) return null;
  const rows = await knex('products_catalog')
    .whereIn('id', productIds)
    .select('rei_hours')
    .catch(() => []);
  let maxMinutes = null;
  for (const row of rows) {
    const hours = Number(row.rei_hours);
    if (Number.isFinite(hours) && hours >= 0) {
      const minutes = Math.round(hours * 60);
      if (maxMinutes == null || minutes > maxMinutes) maxMinutes = minutes;
    }
  }
  return maxMinutes;
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
  // The stored recap is now full-length (so the service report reads completely);
  // tighten it to SMS-sized, complete-sentence copy before composing the message.
  const recap = CompletionRecap.smsRecap(recapText);
  const tail = `${body || ''}${suffix || ''}`.trim();
  if (!recap) return { body: tail, truncated: false };

  const full = `${recap}\n\n${tail}`;
  if (countSegments(full).segmentCount <= maxSegments) return { body: full, truncated: false };
  if (countSegments(tail).segmentCount > maxSegments) return { body: tail, truncated: false };

  const marker = '...';
  const separator = '\n\n';
  const chars = Array.from(recap);
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

function completionAllowsTechnicianPestRating({ typedFindingsType = null, isInternalOnlyCompletion = false } = {}) {
  return !typedFindingsType && !isInternalOnlyCompletion;
}

function pestPressureConfigAllowsTechnicianRating({ pestPressureConfig = null, serviceLine = null } = {}) {
  const techEntryAllowed = !!(pestPressureConfig
    && pestPressureConfig.allowTechnicianClientRatingEntry === true);
  const enabledLines = Array.isArray(pestPressureConfig && pestPressureConfig.enabledServiceLines)
    ? pestPressureConfig.enabledServiceLines
    : [];
  const serviceLineAllowed = enabledLines.length === 0
    || (serviceLine && enabledLines.includes(serviceLine));
  return techEntryAllowed && serviceLineAllowed;
}

function technicianPestRatingAllowedForService({ completionProfile = null, pestPressureConfig = null, serviceLine = null } = {}) {
  const deliveryPosture = resolveCompletionDeliveryPosture({
    typedFindingsType: completionProfile?.findingsType || null,
    completionMode: completionProfile?.completionMode || null,
    profileDeliveryMode: completionProfile?.deliveryMode || null,
  });
  return completionAllowsTechnicianPestRating({
    typedFindingsType: completionProfile?.findingsType || null,
    isInternalOnlyCompletion: deliveryPosture.isInternalOnly,
  }) && pestPressureConfigAllowsTechnicianRating({ pestPressureConfig, serviceLine });
}

function photoCaptionBannedCopyPayload(captionBannedViolations = new Set()) {
  const violations = [...captionBannedViolations];
  return {
    error: `Photo captions contain wording we can't put on a customer report (${violations.join(', ')}).`,
    code: 'photo_caption_banned_copy',
    violations,
  };
}

function shouldRejectPhotoCaptionBannedCopy({
  captionBannedViolations = new Set(),
  isInternalOnlyCompletion = false,
  resumingCommittedCompletion = false,
  typedDeliveryMode = null,
} = {}) {
  if (!captionBannedViolations.size) return false;
  if (resumingCommittedCompletion) return typedDeliveryMode === 'auto_send';
  return !isInternalOnlyCompletion;
}

function internalOnlyProductsBlockPayload({ isInternalOnlyCompletion = false, products = [] } = {}) {
  if (!isInternalOnlyCompletion || !Array.isArray(products)) return null;
  const hasAppliedProduct = products.some((product) => product && product.productId);
  if (!hasAppliedProduct) return null;
  return {
    error: 'Waves Assessment is an internal-only consultation; no treatment products can be recorded for this visit.',
    code: 'internal_only_products_not_allowed',
  };
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
      .first('id', 'service_id', 'service_type');
    if (!svc) {
      return res.status(404).json({ error: 'Service not found' });
    }
    const [config, completionProfile] = await Promise.all([
      loadPestPressureConfig(db),
      resolveCompletionProfileForScheduledService(svc),
    ]);
    const serviceLine = detectServiceLine(svc.service_type);
    res.json({
      allowed: technicianPestRatingAllowedForService({
        completionProfile,
        pestPressureConfig: config,
        serviceLine,
      }),
    });
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

// Satellite basemap + the customer's existing zones for the zone-marking
// surfaces (completion-flow capture step and the office desk-backfill flow).
// The image params (center / zoom / 640x340) are built through the SAME
// provider call the customer report uses, so what gets drawn on is
// pixel-identical to what the report renders. The Google image URL is
// returned for LIVE display only — never proxied or stored (provider ToS).
async function buildPropertyMapPayload(customerId, lat, lng) {
  const { getBasemapProvider, isSatelliteTreatmentMapEnabled } = require('../services/maps/basemap-provider');
  if (!isSatelliteTreatmentMapEnabled()) {
    return { available: false, reason: 'disabled' };
  }
  const provider = getBasemapProvider();
  if (!provider?.capabilities?.canDisplayLive) {
    return { available: false, reason: 'provider_unavailable' };
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { available: false, reason: 'missing_coordinates' };
  }

  const geometryRow = await db('property_geometries')
    .where({ customer_id: customerId })
    .orderBy('version', 'desc')
    .first()
    .catch(() => null);
  const zoom = Number(geometryRow?.zoom) || 20;
  const center = { lat, lng };
  const liveConfig = await provider.getLiveMapConfig({
    center,
    zoom,
    width: 640,
    height: 340,
    mapType: 'satellite',
  });
  if (!liveConfig?.imageUrl) {
    return { available: false, reason: 'provider_config_unavailable' };
  }

  const zones = await db('property_zones')
    .where({ customer_id: customerId, is_active: true })
    .orderBy('letter')
    .catch(() => []);
  // Re-anchor stored marks against the image being served: a re-geocoded
  // customer shifts the image center under the shapes, and preloading them
  // unshifted would have the tech "confirm" marks on the wrong ground.
  // Untrusted marks come back with geometryImage null so the tech redraws.
  const resolvedZones = resolveZoneRowsImageDrift(zones, {
    center: liveConfig.center || center,
    zoom,
    width: liveConfig.width || 640,
    height: liveConfig.height || 340,
  });

  return {
    available: true,
    image: {
      url: liveConfig.imageUrl,
      width: liveConfig.width || 640,
      height: liveConfig.height || 340,
      center: liveConfig.center || center,
      zoom,
      attributionText: liveConfig.attributionText || '',
    },
    zones: resolvedZones.map((zone, i) => ({
      id: zone.id,
      letter: zone.letter,
      label: zone.label,
      category: zone.category,
      serviceLines: Array.isArray(zone.service_lines) ? zone.service_lines : [],
      geometryImage: zone.geometry_image || null,
      // a stored mark exists but drift resolution dropped it: the desk UI
      // must know — the PUT's completeness check rereads the RAW column, so
      // a "clear everything" save would 400 unless this zone gets an
      // explicit entry (redraw or clear tombstone)
      staleMark: Boolean(zones[i]?.geometry_image) && !zone.geometry_image,
    })),
  };
}

// GET /api/admin/dispatch/:serviceId/property-map — the completion flow's
// zone-marking step (service-scoped: the tech is standing on a job).
router.get('/:serviceId/property-map', async (req, res, next) => {
  try {
    const svc = await db('scheduled_services as ss')
      .leftJoin('customers as c', 'ss.customer_id', 'c.id')
      .where('ss.id', req.params.serviceId)
      .select('ss.id', 'ss.customer_id', 'c.latitude', 'c.longitude')
      .first();
    if (!svc || !svc.customer_id) return res.status(404).json({ error: 'Service not found' });
    return res.json(await buildPropertyMapPayload(svc.customer_id, Number(svc.latitude), Number(svc.longitude)));
  } catch (err) { next(err); }
});

// GET /api/admin/dispatch/customers/:customerId/property-map — same payload,
// customer-scoped, for the office desk-backfill flow (Customer 360 / job
// sheet), where there is no in-flight completion to hang a serviceId on.
router.get('/customers/:customerId/property-map', requireAdmin, async (req, res, next) => {
  try {
    const customer = await db('customers')
      .where({ id: req.params.customerId })
      .select('id', 'latitude', 'longitude')
      .first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    return res.json(await buildPropertyMapPayload(customer.id, Number(customer.latitude), Number(customer.longitude)));
  } catch (err) { next(err); }
});

// PUT /api/admin/dispatch/customers/:customerId/property-zones — office desk
// backfill: apply satellite marks outside a completion (re-mark a drifted
// property, or backfill shapes onto zones created before the capture UI
// existed). Reuses the completion upsert so there is exactly one write path
// for zone shapes; unlike the completion's post-commit fail-soft sync, this
// IS the primary action, so it runs in its own transaction and fails loudly.
router.put('/customers/:customerId/property-zones', requireAdmin, async (req, res, next) => {
  try {
    const customer = await db('customers').where({ id: req.params.customerId }).select('id').first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const zoneShapes = req.body?.zoneShapes;
    if (!Array.isArray(zoneShapes) || !zoneShapes.length) {
      return res.status(400).json({ error: 'zoneShapes must be a non-empty array', code: 'zone_shapes_invalid' });
    }
    const zoneShapesError = PropertyZones.validateZoneShapesBody(zoneShapes);
    if (zoneShapesError) {
      return res.status(400).json({ error: zoneShapesError, code: 'zone_shapes_invalid' });
    }
    const serviceLine = typeof req.body?.serviceLine === 'string'
      ? req.body.serviceLine.trim().toLowerCase() || null
      : null;
    if (serviceLine && !SERVICE_LINE_IDS.includes(serviceLine)) {
      return res.status(400).json({
        error: `serviceLine must be one of: ${SERVICE_LINE_IDS.join(', ')}`,
        code: 'service_line_invalid',
      });
    }

    // One entry per label: a clear + redraw pair for the same label would
    // end UNMARKED in the write path (upsert applies all shapes, THEN all
    // clears) — reject the ambiguity instead of guessing what was meant.
    const seenLabels = new Set();
    for (const entry of zoneShapes) {
      const key = PropertyZones.normalizeZoneLabel(entry?.areaLabel);
      if (!key) continue;
      if (seenLabels.has(key)) {
        return res.status(400).json({
          error: `zoneShapes has more than one entry for "${String(entry.areaLabel).trim()}" — send one final state per zone`,
          code: 'zone_shapes_duplicate',
        });
      }
      seenLabels.add(key);
    }

    const existingZones = await db('property_zones')
      .where({ customer_id: customer.id, is_active: true })
      .select('label', 'geometry_image', 'service_lines');

    // A shape for a label with no existing row CREATES that row — without a
    // scoped service line it lands with service_lines: [], which matches
    // EVERY report line (a pest-only mark would leak onto lawn/tree reports).
    const knownKeys = new Set(existingZones.map((zone) => PropertyZones.normalizeZoneLabel(zone.label)));
    const createsRows = zoneShapes.some((entry) => entry?.clear !== true
      && !knownKeys.has(PropertyZones.normalizeZoneLabel(entry?.areaLabel)));
    if (createsRows && !serviceLine) {
      return res.status(400).json({
        error: 'serviceLine is required when the payload introduces a new zone label',
        code: 'service_line_required',
      });
    }

    // Partial saves are rejected: the report's satellite overlay goes
    // image-only once ANY zone carries a mark and drops the rest, so a save
    // that leaves some zones unmarked while others end marked would silently
    // omit treated zones from the customer's coverage map. All-marked or
    // all-cleared are both acceptable end states. Scoped to the selected
    // service line the way reports scope zones — an unmarked lawn-only row
    // never co-renders on a pest overlay, so it must not block a pest save.
    const gaps = PropertyZones.zoneShapeCoverageGaps(existingZones, zoneShapes, { serviceLine });
    if (gaps) {
      return res.status(400).json({
        error: `every zone needs a mark (or an explicit clear) before saving — missing: ${gaps.join(', ')}`,
        code: 'zone_shapes_incomplete',
        missing: gaps,
      });
    }

    const summary = await db.transaction((trx) => PropertyZones.upsertZonesForCompletion(trx, {
      customerId: customer.id,
      serviceLine,
      areaLabels: [],
      zoneShapes,
    }));
    return res.json({ ok: true, summary });
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
      if (prefs?.garage_code) alerts.push(`Garage: ${prefs.garage_code}`);
      if (prefs?.lockbox_code) alerts.push(`Lockbox: ${prefs.lockbox_code}`);
      if (prefs?.pet_count > 0 || prefs?.pet_details) alerts.push(`🐾 ${prefs.pet_details || `${prefs.pet_count} pet(s)`}`);
      if (prefs?.pets_secured_plan) alerts.push(`Pet plan: ${prefs.pets_secured_plan}`);
      if (prefs?.chemical_sensitivities) alerts.push(`⚠️ Chemical sensitivity: ${prefs.chemical_sensitivity_details || 'yes'}`);
      if (prefs?.access_notes) alerts.push(prefs.access_notes);
      if (prefs?.side_gate_access) alerts.push(`Side gate: ${prefs.side_gate_access}`);
      if (prefs?.parking_notes) alerts.push(`Parking: ${prefs.parking_notes}`);
      if (prefs?.special_instructions) alerts.push(prefs.special_instructions);
      if (s.notes) alerts.push(s.notes);

      return {
        id: s.id,
        routeOrder: s.route_order,
        customerName: `${s.first_name} ${s.last_name}`,
        customerId: s.customer_id,
        customerPhone: s.customer_phone,
        address: [s.address_line1, s.city, [s.state, s.zip].filter(Boolean).join(" ")].filter(Boolean).join(", "),
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
        isCallback: !!s.is_callback,
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
        // Typed-findings schema embedded per appointment so mobile completion
        // never blocks on a registry fetch (bad-network field conditions).
        // Null for everything except cut-over specialty types.
        findingsSchema: completionProfile?.findingsType
          // serviceKey scopes combo-module sections (owner spec §3) — a pure
          // trap check never sees the exclusion/sanitation modules.
          ? ActivityIndicators.findingsSchemaForType(completionProfile.findingsType, { serviceKey: completionProfile.serviceKey })
          : null,
        // Companion section schemas (combined-service-completions.md),
        // embedded beside findingsSchema for the same reason: mobile
        // completion must never block on a registry fetch.
        companionSchemas: completionProfile
          ? (completionProfile.companions || [])
            .map((c) => ActivityIndicators.findingsSchemaForType(c.type, { serviceKey: completionProfile.serviceKey }))
            .filter(Boolean)
          : null,
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

// Read-only card-hold cancel preview: whether this visit carries a held card
// and whether cancelling RIGHT NOW would charge the late-cancel fee. The
// cancel UIs call this before the status flip so they only ask the
// business-initiated-waive question when a fee would actually fire.
router.get('/:serviceId/card-hold', async (req, res, next) => {
  try {
    const CardHolds = require('../services/estimate-card-holds');
    res.json(await CardHolds.cardHoldCancelPreview(req.params.serviceId));
  } catch (err) { next(err); }
});

router.put('/:serviceId/status', async (req, res, next) => {
  try {
    const { status: toStatus, notes, lat, lng, notifyCustomer, scope = 'this_only' } = req.body;
    const svc = await db('scheduled_services').where('scheduled_services.id', req.params.serviceId)
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
      .select('scheduled_services.*', 'customers.first_name', 'customers.phone as cust_phone', 'customers.city', 'technicians.name as tech_name')
      .first();

    if (!svc) return res.status(404).json({ error: 'Service not found' });

    // Day-of lifecycle guard: en_route / on_site / completed are field
    // actions that only happen on (or after) the scheduled day. A
    // future-dated job here means a stale dispatch tab racing a live
    // reschedule (rebooker allowLive) or a flip on the wrong day's
    // board — and proceeding would commit the operational status while
    // the track-side helper below refuses (future_scheduled_date),
    // leaving status and track_state divergent with the tech never
    // freed. Reject before the transition; cancelling or confirming a
    // future job stays allowed. To genuinely run a job early,
    // reschedule it to today first.
    const DAY_OF_LIFECYCLE_STATUSES = new Set(['en_route', 'on_site', 'completed', 'no_show']);
    if (DAY_OF_LIFECYCLE_STATUSES.has(toStatus)
      && trackTransitions.isFutureScheduledDate(svc.scheduled_date)) {
      return res.status(409).json({
        error: `This job is scheduled for ${serviceDateOnly(svc.scheduled_date)} — it may have been rescheduled while this board was open. Refresh, or move it to today to run it early.`,
        code: 'future_scheduled_date',
      });
    }

    // A no-show is terminal. Once a row is no_show this route must not flip
    // it anywhere: re-sending no_show is idempotent success; any other
    // target (cancelled/completed/...) would erase the missed-visit state
    // and fire a contradictory notice, because fromStatus is read fresh as
    // no_show and transitionJobStatus's atomic guard would accept it.
    if (svc.status === 'no_show') {
      if (toStatus === 'no_show') {
        return res.json({ success: true, alreadyNoShow: true });
      }
      return res.status(409).json({
        error: 'This visit was already marked as a no-show. Refresh and try again.',
        code: 'already_no_show',
      });
    }

    // No-show is only valid FROM an active visit state, and only once the
    // visit window has actually started. The mobile detail sheet exposes
    // "Mark as no-show" on every same-day row, so without these guards an
    // accidental tap on a later-today visit would terminalize it and text
    // the customer "we missed you at {time}" before the appointment time
    // had even arrived. (The day-of guard above rejects future dates; this
    // covers same-day-before-window and non-active sources.)
    if (toStatus === 'no_show') {
      const NO_SHOW_SOURCE_STATES = new Set(['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site']);
      if (!NO_SHOW_SOURCE_STATES.has(svc.status)) {
        return res.status(409).json({
          error: `Can't mark this visit as a no-show — it's already ${svc.status}. Refresh and try again.`,
          code: 'not_active_visit',
        });
      }
      const nsDatePart = svc.scheduled_date instanceof Date
        ? svc.scheduled_date.toISOString().slice(0, 10)
        : String(svc.scheduled_date || '').slice(0, 10);
      const nsTimePart = svc.window_start ? String(svc.window_start).slice(0, 8) : null;
      // No date/window recorded → don't block (legacy rows). Otherwise the
      // window-start instant (ET wall-clock → absolute) must be in the past.
      const nsWindowReached = !/^\d{4}-\d{2}-\d{2}$/.test(nsDatePart) || !nsTimePart
        || parseETDateTime(`${nsDatePart}T${nsTimePart}`).getTime() <= Date.now();
      if (!nsWindowReached) {
        return res.status(409).json({
          error: "This visit's window hasn't started yet — you can mark it a no-show once the appointment time has passed.",
          code: 'window_not_reached',
        });
      }
    }

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

      // Void any still-open invoices pre-minted for the cancelled visits so
      // dunning doesn't chase cancelled jobs. The helper enforces the
      // money-state rules (skips applied payments / live PaymentIntents) and
      // is best-effort — it never throws.
      try {
        const InvoiceService = require('../services/invoice');
        for (const target of targets) {
          await InvoiceService.voidOpenInvoicesForCancelledService(target.id);
        }
      } catch (e) { logger.error(`[admin-dispatch] series cancellation invoice void sweep failed: ${e.message}`); }

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
      // Referral reward: marking a recurring first visit completed via this status
      // action completes the service too, so it must credit like /complete + the
      // recap path. The helper self-gates (recurring + first-time + once-per-
      // referee + idempotent); best-effort, never blocks the status change.
      try {
        const referralEngine = require('../services/referral-engine');
        await referralEngine.creditReferralOnFirstService({ customerId: svc.customer_id, serviceId: svc.id });
      } catch (referralErr) {
        logger.warn(`[referral] status-complete credit failed for customer=${svc?.customer_id}: ${referralErr.message}`);
      }
      // A completed service means the deal closed — convert the originating
      // lead to won if it's still open. Best-effort + idempotent; the contact
      // fallback only matches never-converted leads, so a recurring customer's
      // routine completion never sweeps unrelated leads.
      try {
        const { convertLeadFromEvent } = require('../services/lead-estimate-link');
        await convertLeadFromEvent({ source: 'service_completed', customerId: svc.customer_id });
      } catch (leadErr) {
        logger.warn(`[lead-trigger] status-complete conversion failed for customer=${svc?.customer_id}: ${leadErr.message}`);
      }
    } else if (toStatus === 'cancelled') {
      try {
        const AppointmentReminders = require('../services/appointment-reminders');
        await AppointmentReminders.handleCancellation(svc.id, {
          sendNotification: notifyCustomer !== false,
        });
      } catch (e) { logger.error(`[admin-dispatch] cancellation reminder handling failed: ${e.message}`); }

      // Void any still-open invoice pre-minted for this visit so dunning
      // doesn't chase a cancelled job. Money-state rules live in the shared
      // helper (skips applied payments / live PaymentIntents); best-effort.
      try {
        const InvoiceService = require('../services/invoice');
        await InvoiceService.voidOpenInvoicesForCancelledService(svc.id);
      } catch (e) { logger.error(`[admin-dispatch] cancellation invoice void sweep failed: ${e.message}`); }

      // One-time card-on-file hold: a cancellation inside the window charges the
      // flat late-cancel fee against the saved card; outside it the hold is
      // released free. waiveCardHoldFee (body) is the business-initiated escape
      // hatch — WE cancelled, so the hold releases with no fee. Admin-only:
      // this route is technician-reachable (requireTechOrAdmin) and a fee
      // waiver is a billing decision, so non-admin JWTs can't release an
      // in-window hold free. Dark until ONE_TIME_CARD_HOLD; no-op when no
      // hold exists. Best-effort — never block the committed status change.
      try {
        const CardHolds = require('../services/estimate-card-holds');
        await CardHolds.handleCardHoldCancellation({
          scheduledServiceId: svc.id,
          waiveFee: req.techRole === 'admin' && req.body?.waiveCardHoldFee === true,
        });
      } catch (e) { logger.error(`[admin-dispatch] cancel card-hold handling failed: ${e.message}`); }

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
    } else if (toStatus === 'no_show') {
      // Free the tech on the dispatch roster. A no-show marked after the
      // job already went en_route/on_site leaves tech_status.current_job_id
      // pointing at it — completed/cancelled clear it via track-transitions
      // (markComplete/cancel), but this path runs none of those. No-op if
      // the tech has already moved on (clearTechCurrentJob matches on the
      // current_job_id). Best-effort.
      if (svc.technician_id) {
        try {
          const { clearTechCurrentJob } = require('../services/tech-status');
          await clearTechCurrentJob({
            tech_id: svc.technician_id,
            current_job_id: svc.id,
            status: 'idle',
          });
        } catch (e) { logger.error(`[admin-dispatch] no-show tech_status clear failed: ${e.message}`); }
      }

      // Void any still-open invoice pre-minted for this visit (the
      // pre-completion / Charge-now path links via invoices.scheduled_service_id)
      // so billing doesn't chase a service the customer was just told was
      // missed. Same money-state-safe helper the cancellation branch uses
      // (skips applied payments / live PaymentIntents); best-effort.
      try {
        const InvoiceService = require('../services/invoice');
        await InvoiceService.voidOpenInvoicesForCancelledService(svc.id);
      } catch (e) { logger.error(`[admin-dispatch] no-show invoice void sweep failed: ${e.message}`); }

      // One-time card-on-file hold: a no-show triggers the flat fee against the
      // saved card (dark until ONE_TIME_CARD_HOLD; no-op when no hold exists).
      // Best-effort — never fail the committed status flip. The outcome feeds
      // the customer notice below so its charge line is truthful.
      // 'none' | 'charged' | 'review' — charge_review means Stripe MAY have
      // accepted the fee (ambiguous API error, parked for reconciliation), so
      // the customer notice must not claim "no charge".
      let noShowFeeOutcome = 'none';
      try {
        const CardHolds = require('../services/estimate-card-holds');
        const feeResult = await CardHolds.chargeNoShowFee({ scheduledServiceId: svc.id, reason: 'no_show' });
        if (feeResult?.charged === true) noShowFeeOutcome = 'charged';
        else if (feeResult?.reason === 'charge_review') noShowFeeOutcome = 'review';
      } catch (e) { logger.error(`[admin-dispatch] no-show card-hold fee charge failed: ${e.message}`); }

      // Notify the customer we missed them and invite a reschedule.
      // Best-effort — a Twilio/template failure must not fail the
      // status flip that already committed above.
      try {
        const AppointmentReminders = require('../services/appointment-reminders');
        await AppointmentReminders.handleNoShow(svc.id, {
          sendNotification: notifyCustomer !== false,
          feeOutcome: noShowFeeOutcome,
        });
      } catch (e) { logger.error(`[admin-dispatch] no-show notice handling failed: ${e.message}`); }

      // Record the miss so manual no-shows accrue toward the
      // two-no-shows-in-90-days "we've missed you" outreach task, same as
      // the nightly auto-detection. The nightly sweep only scans
      // pending/confirmed rows (scheduler.js missed-appointment check), so
      // once this branch flips the row to no_show it would otherwise never
      // count. Dedup on scheduled_service_id mirrors the sweep's
      // alreadyFlagged guard so a visit the nightly job already logged
      // (while it was still pending) isn't double-counted. Best-effort.
      try {
        const alreadyFlagged = await db('reschedule_log')
          .where({ scheduled_service_id: svc.id, reason_code: 'customer_noshow' })
          .first('id');
        if (!alreadyFlagged) {
          const missedAppointment = require('../services/workflows/missed-appointment');
          await missedAppointment.onSkip(svc.id, 'manual_no_show');
        }
      } catch (e) { logger.error(`[admin-dispatch] no-show reschedule_log record failed: ${e.message}`); }
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
      includePayLink = true,
      lawnAssessmentId = null,
      lawnProtocolCompletion = null,
      treeShrubCompletion = null,
      completionPhotos = [],
      manualHeightIn = null,        // turf height-of-cut gauge reading (lawn) — OPTIONAL
      gaugePhoto = null,            // on-site lawn-length photo (data URL) — OPTIONAL
      clientPestRating = null,
      structuredFindings = null,
      companionFindings = null,
      activityScore = null,
      activityScoreSource = null,
      nextStepChips = null,
      completionTelemetry = null,
      typedPhotoSummary = null,
      zoneShapes = null,            // satellite zone marks [{ areaLabel, shape }] — OPTIONAL
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
    const zoneShapesError = PropertyZones.validateZoneShapesBody(zoneShapes);
    if (zoneShapesError) {
      return res.status(400).json({ error: zoneShapesError, code: 'zone_shapes_invalid' });
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
    // Photo captions land on the customer report for EVERY completion
    // (caption || stateBadge under each photo), typed or not — sanitize to
    // the column budget HERE. The banned-copy REJECTION is deferred until the
    // completion's delivery posture is known: internal-only consultations mint
    // no customer report, so customer-copy bans must not block an internal
    // assessment photo (the check is re-applied below for any other path).
    const captionBannedViolations = new Set();
    if (Array.isArray(completionPhotos)) {
      for (const photo of completionPhotos) {
        if (photo && photo.caption != null) {
          photo.caption = String(photo.caption).trim().slice(0, 200) || null;
          if (photo.caption) {
            for (const v of ActivityIndicators.findBannedCustomerCopy(photo.caption)) {
              captionBannedViolations.add(v);
            }
          }
        }
      }
    }
    // The summary renders inside the Field Photos section — without photos
    // it would persist invisibly in the immutable snapshot, so drop it.
    const photoSummaryText = typeof typedPhotoSummary === 'string'
      && Array.isArray(completionPhotos) && completionPhotos.length
      ? typedPhotoSummary.trim().slice(0, 600)
      : '';
    const isIncompleteVisit = visitOutcome === 'incomplete';
    const recapReviewOnly = !!oneTimeRecapOnly && !isIncompleteVisit;
    let completionPhotoUploadResult = { uploaded: 0, failed: 0, errors: [] };
    let completionPhotosUploadedBeforeCommit = false;
    let preCommitCompletionPhotoRows = [];
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
    let waveguardCalibrationAdvisory = null;
    let waveguardCalibrationCleared = false;
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
        'customers.billing_mode as cust_billing_mode',
        'customers.per_application_fee as cust_per_application_fee',
        'customers.autopay_enabled as cust_autopay_enabled',
        'customers.autopay_paused_until as cust_autopay_paused_until',
        'customers.autopay_payment_method_id as cust_autopay_payment_method_id',
        'customers.ach_status as cust_ach_status',
        'technicians.name as tech_name'
      )
      .first();

    if (!svc) return res.status(404).json({ error: 'Service not found' });

    // Stale-recap guard: a live job force-rescheduled to a future day
    // (rebooker allowLive) is rewound to a fresh confirmed appointment —
    // a recap submit from a CompletionPanel opened before the reschedule
    // must not complete the future visit. Lifecycle actions only ever
    // run day-of or late (overdue completion), so a future ET date
    // marks the attempt stale. The durable-completion resume path is
    // unaffected: a committed completion can't be rescheduled, so its
    // date is never future. See track-transitions.isFutureScheduledDate.
    if (trackTransitions.isFutureScheduledDate(svc.scheduled_date)) {
      return res.status(409).json({
        error: `This job is now scheduled for ${serviceDateOnly(svc.scheduled_date)} — it was rescheduled while this page was open. Refresh and try again.`,
        code: 'future_scheduled_date',
      });
    }

    // No-show is terminal and non-completable. A completion/recap sheet
    // opened before another dispatcher marked the visit no_show would
    // otherwise mint completion artifacts (and text the customer) for a
    // visit the status machine says was missed — fromStatus is read fresh
    // here, so the transitionJobStatus atomic guard wouldn't catch it.
    // The typed recap path enforces the same via pest-recap's
    // NON_COMPLETABLE_STATUSES.
    if (svc.status === 'no_show') {
      return res.status(409).json({
        error: 'This visit was marked as a no-show and can no longer be completed. Refresh and try again.',
        code: 'service_no_show',
      });
    }

    if (!waveguardEquipmentSystemId && svc.assigned_equipment_system_id) {
      waveguardEquipmentSystemId = svc.assigned_equipment_system_id;
    }
    if (!waveguardCalibrationId && svc.assigned_calibration_id) {
      waveguardCalibrationId = svc.assigned_calibration_id;
    }

    // The profile row is the typed-completion feature flag AND the project
    // routing gate — failing open on a lookup error would let a cut-over
    // typed job (or a project-required job) complete through the plain path
    // with no validation, delivery suppression, or billing gate. Fail closed
    // (pre-push Codex P1): the resolver already degrades gracefully to the
    // default profile when the table simply doesn't exist; a throw here is a
    // real DB error.
    let completionProfile;
    try {
      completionProfile = await resolveCompletionProfileForScheduledService(svc);
    } catch (err) {
      logger.error(`[dispatch] completion profile lookup failed for ${svc.id}: ${err.message}`);
      return res.status(503).json({
        error: 'Could not verify the completion type for this service. Try again in a moment.',
        code: 'completion_profile_lookup_failed',
      });
    }
    if (completionProfile?.requiresProject || completionProfile?.projectBacked) {
      return res.status(409).json({
        error: 'This service must be completed through a project.',
        code: 'project_required_completion',
        completionProfile,
      });
    }

    // Typed specialty completion (dark until a type's profile is cut over to
    // completion_mode='service_report' with a project_type pointer).
    // findingsType only exists POST-cutover, so typed findings are REQUIRED
    // here for a completed visit: accepting a findings-less completion would
    // let a stale or crafted client skip validation, the customer-copy
    // snapshot, and the activity score entirely (pre-push Codex P0). A stale
    // pre-deploy tab gets a clear 422 telling it to refresh — cutover
    // migrations only run after the typed UI has shipped.
    const typedFindingsType = completionProfile?.findingsType || null;
    const typedIndicator = typedFindingsType
      ? ActivityIndicators.getActivityIndicator(typedFindingsType)
      : null;
    let typedFindings = null;
    let typedChips = [];
    let typedActivityScore = null;
    let typedScoreSource = null;
    // Typed validation runs AFTER the idempotency claim (Codex P2): a retry
    // of a completion committed before the type's cutover must replay the
    // stored response, not 422 on rules that didn't exist when it ran.
    // Returns {status, body} on rejection, null when valid; mutates the
    // typed* locals on success.
    const runTypedValidation = () => {
      // Recap-only mode (the lightweight pest recap) has no findings, no
      // billing gate, and no snapshot — it must not be a side door around
      // the typed flow. Typed services complete through the full form only.
      if (typedFindingsType && oneTimeRecapOnly && !isIncompleteVisit) {
        return {
          status: 409,
          body: {
            error: 'This service completes through its service-specific findings form, not the quick recap. Refresh and complete the visit from the completion form.',
            code: 'typed_recap_not_allowed',
            findingsType: typedFindingsType,
          },
        };
      }
      if (typedFindingsType && !isIncompleteVisit && structuredFindings == null) {
        return {
          status: 422,
          body: {
            error: 'This service now completes with its service-specific findings form. Refresh the page and complete the visit again.',
            code: 'typed_findings_required',
            findingsType: typedFindingsType,
          },
        };
      }
      if (typedFindingsType && structuredFindings != null && !isIncompleteVisit) {
        const findingsValidation = ActivityIndicators.validateTypedFindings({
          type: structuredFindings?.type,
          values: structuredFindings?.values,
          expectedType: typedFindingsType,
          enforceRequired: true,
        });
        if (!findingsValidation.ok) {
          return {
            status: findingsValidation.missing.length && !findingsValidation.errors.length ? 422 : 400,
            body: {
              error: 'Structured findings failed validation',
              code: 'typed_findings_invalid',
              details: findingsValidation.errors,
              missing: findingsValidation.missing,
            },
          };
        }
        const chipsValidation = ActivityIndicators.validateNextStepChips(
          nextStepChips, typedFindingsType, structuredFindings.values || {},
        );
        if (!chipsValidation.ok) {
          return { status: 400, body: { error: chipsValidation.error, code: 'next_step_chips_invalid' } };
        }
        // Owner spec: trapping reports always end with a clear next action.
        if (ActivityIndicators.nextStepRequiredForType(typedFindingsType) && !chipsValidation.chips.length) {
          return {
            status: 422,
            body: { error: 'Select at least one next step.', code: 'next_step_required' },
          };
        }
        typedChips = chipsValidation.chips;
        typedFindings = { type: typedFindingsType, values: structuredFindings.values || {} };

        // Every customer-facing free-text surface on a typed report gets the
        // same banned-copy policy the AI draft endpoint enforces: manual
        // recommendations, [Next]-tagged technician note lines (both feed
        // protocol.recommendations verbatim), and the structured findings
        // values themselves (rendered on the "What we found & did" card).
        // Same { status, body } shape as the other validation failures —
        // this closure's caller writes the response.
        const customerCopySources = [
          ...(Array.isArray(recommendations) ? recommendations : []),
          ...(Array.isArray(observations) ? observations : []),
          ...(customerRecap ? [customerRecap] : []),
          ...taggedCompletionNoteLines(technicianNotes, ['next']),
          ...taggedCompletionNoteLines(technicianNotes, ['found']),
          ...Object.values(structuredFindings?.values || {}).filter((v) => typeof v === 'string'),
          // Photo copy is customer-facing too: the summary persists in the
          // snapshot, captions render under each photo on the report.
          ...(photoSummaryText ? [photoSummaryText] : []),
          ...(Array.isArray(completionPhotos)
            ? completionPhotos.map((p) => p?.caption).filter(Boolean)
            : []),
        ];
        const copyViolations = [...new Set(
          customerCopySources.flatMap((entry) => ActivityIndicators.findBannedCustomerCopy(entry)),
        )];
        if (copyViolations.length) {
          return {
            status: 422,
            body: {
              error: `This completion contains wording we can't put on a customer report (${copyViolations.join(', ')}). Describe what was observed and done today instead of absolute claims.`,
              code: 'typed_recommendations_banned_copy',
              violations: copyViolations,
            },
          };
        }

        // Activity score: strict integer 0-5 or null (same contract as
        // clientPestRating). Gauge types require a score on a completed
        // visit — derived prefill fills it when the tech didn't touch the
        // picker.
        if (activityScore != null
          && (!Number.isInteger(activityScore) || activityScore < 0 || activityScore > 5)) {
          return {
            status: 400,
            body: { error: 'activityScore must be an integer 0-5 (or null/omitted)', code: 'activity_score_invalid' },
          };
        }
        if (typedIndicator) {
          const derived = ActivityIndicators.deriveActivityScore(typedFindingsType, typedFindings.values);
          if (activityScore != null) {
            typedActivityScore = activityScore;
            typedScoreSource = activityScoreSource === 'derived' && derived?.score === activityScore
              ? 'derived'
              : 'technician';
          } else if (derived) {
            typedActivityScore = derived.score;
            typedScoreSource = 'derived';
          } else {
            return {
              status: 422,
              body: {
                error: `${typedIndicator.label} requires an activity score (0-5) on a completed visit`,
                code: 'activity_score_required',
              },
            };
          }
          // The FINAL score (pinned or derived) must agree with the
          // findings at the cleared boundary — the headline follows the
          // score while areas/chip checks key off the select, so a
          // crossing override would publish a self-contradicting report
          // (Codex P2).
          const scoreConsistency = ActivityIndicators.validateActivityScoreConsistency(
            typedFindingsType, typedFindings.values, typedActivityScore,
          );
          if (!scoreConsistency.ok) {
            return {
              status: 422,
              body: { error: scoreConsistency.error, code: 'activity_score_inconsistent' },
            };
          }
        }
      }
      return null;
    };
    // Companion typed sections (combined-service-completions.md): the
    // profile's declared companions ride this completion — typed primary OR
    // recurring. Same placement contract as runTypedValidation: fresh
    // executions only (replays return the stored payload above; resumes
    // re-enter after an already-committed trx). Incomplete visits skip
    // companions entirely. Mutates validatedCompanions on success.
    let validatedCompanions = [];
    const runCompanionValidation = () => {
      if (isIncompleteVisit) return null;
      const declaredCompanions = Array.isArray(completionProfile?.companions)
        ? completionProfile.companions
        : [];
      if (!declaredCompanions.length) {
        // The profile is authoritative — a payload carrying companion
        // sections the profile doesn't declare is a refresh-needed conflict,
        // never data to accept.
        if (Array.isArray(companionFindings) && companionFindings.length) {
          return {
            status: 409,
            body: {
              error: "This service's completion profile has no companion sections. Refresh and complete the visit again.",
              code: 'companion_type_mismatch',
            },
          };
        }
        return null;
      }
      const result = CompanionCompletions.validateCompanionSubmission({
        profile: completionProfile,
        companionFindings,
        primaryFindingsType: typedFindingsType,
      });
      if (!result.ok) return { status: result.status, body: result.body };
      validatedCompanions = result.companions;
      return null;
    };
    // Companion delivery postures, frozen per section at completion time.
    // The global typed-report kill env suppresses companion customer copy
    // the same way it suppresses typed primaries — coerce to internal_only
    // so a frozen posture can never auto-send while the kill switch is on.
    const companionDeliveryByType = new Map(
      (completionProfile?.companions || []).map((c) => [
        c.type,
        process.env.SPECIALTY_REPORT_DELIVERY_DISABLED === 'true' ? 'internal_only' : c.delivery,
      ]),
    );
    // Delivery control. For typed completions: profile delivery_mode
    // (auto_send | internal_only | disabled) + a global kill env;
    // internal_only renders + stores the report (token/PDF) without customer
    // SMS/email — the Phase-1b shadow mode. For non-typed completions the
    // routine Service Report auto-sends, EXCEPT internal-only consultations
    // (completion_mode 'internal_only', e.g. Waves Assessment): an advisory
    // walkthrough with no customer-facing report — delivery is forced
    // 'disabled' (no public token minted) and customer comms are suppressed,
    // while the service_records audit row is still written.
    // let, not const: re-derived from the record's FROZEN delivery posture
    // once the record is final, so a crash-resumed completion can't pick up
    // a later profile graduation (see the re-derivation before token mint).
    const deliveryPosture = resolveCompletionDeliveryPosture({
      typedFindingsType,
      completionMode: completionProfile?.completionMode,
      profileDeliveryMode: completionProfile?.deliveryMode,
      specialtyDeliveryDisabled: process.env.SPECIALTY_REPORT_DELIVERY_DISABLED === 'true',
    });
    let typedDeliveryMode = deliveryPosture.typedDeliveryMode;
    let suppressTypedCustomerComms = deliveryPosture.suppressCustomerComms;
    let effectiveSendCompletionSms = sendCompletionSms && !suppressTypedCustomerComms;
    // Internal-only consultation (e.g. Waves Assessment): advisory walkthrough,
    // not a treatment. Beyond suppressing delivery, it must NOT feed the
    // customer-report findings / Pest Pressure pipeline, and its suppression
    // posture is frozen on the record so resumed side effects and downstream
    // customer-facing gates (documents, paid-invoice review) honor it.
    const isInternalOnlyCompletion = deliveryPosture.isInternalOnly;

    const reportServiceLine = detectServiceLine(svc.service_type);
    const reportConfig = getServiceLineConfig(reportServiceLine);

    // Gauge-reading capture (flag-gated; UAT → rollout). On a LAWN visit the tech
    // may log an OPTIONAL maintained-height reading and/or an OPTIONAL on-site
    // lawn-length photo — neither blocks closing the visit. detectServiceLine
    // keeps this strictly off pest / rodent / mosquito. The flag reads the SAME
    // DB-backed source the tech UI checks (useFeatureFlag). A provided height is
    // still range-validated (below), but its absence is fine.
    const turfHeightFlagOn = await isUserFeatureEnabled(req.technicianId, 'turf-height-capture', false).catch(() => false);
    // Exempt typed-findings lawn jobs (e.g. one_time_lawn_treatment): the client
    // hides TurfHeightCapture when isTypedFindings, so the server must not capture
    // a field the UI never renders (matches client isLawn = !isTypedFindings && lawn).
    const turfHeightApplicable = turfHeightFlagOn && reportServiceLine === 'lawn'
      && !isIncompleteVisit && !typedFindingsType;

    // Typed completions (e.g. palm_injection detects to the 'palm' line)
    // capture their structured findings instead of the Tree/Shrub closeout —
    // the client hides that UI in typed mode, so requiring the payload here
    // would make those jobs impossible to complete (Codex P1).
    const treeShrubCloseoutRequired = !isIncompleteVisit
      && !typedFindingsType
      && ['tree_shrub', 'palm'].includes(reportServiceLine);
    // Typed T&S completions skip the legacy closeout but keep its
    // pre-commit photo upload gate (Codex P2): without it, an S3 failure
    // after commit would let a report send with fewer than the required
    // photos — the count check on the submitted array alone can't see
    // upload failures. A declared tree_shrub COMPANION is T&S work all the
    // same — the gate applies to combined completions too (pre-push P1).
    const hasTreeShrubCompanion = (completionProfile?.companions || [])
      .some((companion) => companion.type === 'tree_shrub');
    const treeShrubPhotoGateRequired = treeShrubCloseoutRequired
      || ((typedFindingsType === 'tree_shrub' || hasTreeShrubCompanion) && !isIncompleteVisit);
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
    const [serviceRecordCols, serviceProductCols, serviceFindingsAvailable, activityScoresAvailable] = await Promise.all([
      db('service_records').columnInfo().catch(() => ({})),
      db('service_products').columnInfo().catch(() => ({})),
      db.schema.hasTable('service_findings').catch(() => false),
      db.schema.hasTable('service_activity_scores').catch(() => false),
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

    // Deferred photo-caption banned-copy gate (captions were sanitized above).
    // Run only after replay/conflict handling so idempotent retries of an
    // already-final response do not start failing due to a later profile/copy
    // policy change. Fresh internal-only consultations skip this because they
    // produce no customer-facing report.
    if (claim.action === 'proceed' && shouldRejectPhotoCaptionBannedCopy({
      captionBannedViolations,
      isInternalOnlyCompletion,
      resumingCommittedCompletion,
      typedDeliveryMode,
    })) {
      await CompletionAttempts.markCompletionAttemptFailed(
        completionAttempt,
        new Error('photo_caption_banned_copy'),
      );
      return res.status(422).json(photoCaptionBannedCopyPayload(captionBannedViolations));
    }
    if (claim.action === 'proceed') {
      const internalOnlyProductsBlock = internalOnlyProductsBlockPayload({
        isInternalOnlyCompletion,
        products,
      });
      if (internalOnlyProductsBlock) {
        await CompletionAttempts.markCompletionAttemptFailed(
          completionAttempt,
          new Error(internalOnlyProductsBlock.code),
        );
        return res.status(422).json(internalOnlyProductsBlock);
      }
    }

    // Fresh executions validate typed rules; replays returned above with the
    // stored payload, and resumes re-enter after an already-committed trx.
    if (claim.action === 'proceed') {
      if (canLinkLawnAssessmentRecord) {
        const lawnAssessmentCompletionBlock = await preflightLawnAssessmentCompletion({
          serviceId: svc.id,
          customerId: svc.customer_id,
          reportServiceLine,
          isIncompleteVisit,
          lawnAssessmentId,
        });
        if (lawnAssessmentCompletionBlock) {
          await CompletionAttempts.markCompletionAttemptFailed(
            completionAttempt,
            new Error(lawnAssessmentCompletionBlock.payload.code || 'lawn_assessment_completion_blocked'),
          );
          return res
            .status(lawnAssessmentCompletionBlock.status)
            .json(lawnAssessmentCompletionBlock.payload);
        }
      }

      const typedValidationError = runTypedValidation();
      if (typedValidationError) {
        await CompletionAttempts.markCompletionAttemptFailed(
          completionAttempt,
          new Error(typedValidationError.body.code),
        );
        return res.status(typedValidationError.status).json(typedValidationError.body);
      }
      const companionValidationError = runCompanionValidation();
      if (companionValidationError) {
        await CompletionAttempts.markCompletionAttemptFailed(
          completionAttempt,
          new Error(companionValidationError.body.code),
        );
        return res.status(companionValidationError.status).json(companionValidationError.body);
      }
      // Gauge reading: OPTIONAL on a flagged lawn visit. The tech may close with
      // no height and/or no photo. Only a PROVIDED out-of-range value is rejected
      // (the reading drives the report's mowing status). Validated here — after
      // replay/conflict handling — so a retry of an already-completed visit
      // replays instead of 422-ing.
      if (turfHeightApplicable && manualHeightIn != null && !isValidHeight(manualHeightIn)) {
        await CompletionAttempts.markCompletionAttemptFailed(completionAttempt, new Error('turf_height_invalid'));
        return res.status(422).json({
          error: 'Turf height must be between 0.5 and 8 inches.',
          code: 'turf_height_invalid',
        });
      }
    }

    // Billing pre-gate for typed one-time completions — ports the project
    // flow's enforcement (resolveProjectCompletionBilling) so a one-time
    // specialty job can't complete unbilled, and fires BEFORE any customer
    // artifact. Gates on the PROFILE alone, not on whether the client
    // submitted structuredFindings — a stale/offline client completing a
    // cut-over type must still hit the billing policy (Codex P1).
    // Bypasses: $0 visits resolve as not_billable inside the resolver, and
    // included follow-up appointments (followup_included, set by the
    // schedule-followup endpoint) skip the gate entirely.
    if (
      claim.action === 'proceed'
      && typedFindingsType
      && !isIncompleteVisit
      && !recapReviewOnly
      && String(completionProfile?.billingType || '').toLowerCase() === 'one_time'
      && svc.followup_included !== true
    ) {
      // Money-correctness guard — FAIL CLOSED on lookup errors (pre-push
      // Codex P0). A transient DB failure must not let a one-time service
      // complete and mint customer artifacts without an invoice check.
      let typedBilling;
      try {
        typedBilling = await resolveProjectCompletionBilling({
          scheduledService: svc,
          customer: { monthly_rate: svc.cust_monthly_rate },
        });
      } catch (err) {
        logger.error(`[dispatch] typed completion billing check failed for ${svc.id}: ${err.message}`);
        await CompletionAttempts.markCompletionAttemptFailed(completionAttempt, err);
        return res.status(503).json({
          error: 'Could not verify billing for this one-time service. Try again in a moment.',
          code: 'completion_billing_check_failed',
        });
      }
      if (typedBilling.required && !typedBilling.resolved) {
        // The resolver only sees invoices linked to this scheduled service /
        // service record. The completion path further down can also satisfy
        // billing with an accepted-estimate first-application invoice —
        // honor that here too or we'd 409 a legitimately-invoiced job
        // (pre-push Codex P1).
        const estimateInvoice = await findFirstApplicationInvoiceForEstimateService(svc, db)
          .catch(() => null);
        if (!estimateInvoice) {
          const billingErr = new Error('Completion billing required');
          await CompletionAttempts.markCompletionAttemptFailed(completionAttempt, billingErr);
          return res.status(409).json({
            error: 'An invoice or payment is required before completing this one-time service.',
            code: 'completion_billing_required',
            details: { amount: typedBilling.amount },
          });
        }
      }
    }

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

    // Typed Tree & Shrub completions replace the legacy closeout UX but keep
    // its regulatory teeth (owner spec §6 "same enforcement"): N/P fertilizer
    // summer blackout, bee-active pollinator block, IRAC/FRAC confirmation,
    // product actuals, photo minimum, and the palm-injection redirect all
    // still gate completion — driven by the typed values + recorded products.
    // The values can come from the typed PRIMARY or from a tree_shrub
    // COMPANION section (lawn + T&S combined visits) — the regulatory gates
    // apply identically; a companion must not be a side door around them
    // (pre-push P1). The two sources are mutually exclusive: companion
    // parsing drops entries duplicating the profile's own findingsType.
    const treeShrubComplianceValues = (typedFindingsType === 'tree_shrub' && typedFindings && !isIncompleteVisit)
      ? typedFindings.values
      : (!isIncompleteVisit && validatedCompanions.find((c) => c.type === 'tree_shrub')?.values) || null;
    if (claim.action === 'proceed' && treeShrubComplianceValues) {
      // The compliance classifiers need the CATALOG rows (name/category/
      // IRAC/FRAC/analysis) — degrading to submitted-input-only refs on a
      // transient DB error would silently skip the blackout/pollinator/
      // IRAC gates (Codex P1 round 2). Fail closed on lookup failure and
      // on product ids that don't resolve to catalog rows.
      const submittedProductIds = [...new Set((products || []).map((p) => p?.productId).filter(Boolean))];
      let typedProductRows = [];
      if (submittedProductIds.length) {
        try {
          typedProductRows = await db('products_catalog').whereIn('id', submittedProductIds).select('*');
        } catch (catalogErr) {
          logger.error(`[dispatch] typed T&S catalog lookup failed for ${svc.id}: ${catalogErr.message}`);
          await CompletionAttempts.markCompletionAttemptFailed(completionAttempt, new Error('tree_shrub_catalog_lookup_failed'));
          return res.status(503).json({
            error: 'Could not verify the recorded products against the catalog. Try again in a moment.',
            code: 'tree_shrub_catalog_lookup_failed',
          });
        }
        if (typedProductRows.length < submittedProductIds.length) {
          const found = new Set(typedProductRows.map((row) => String(row.id)));
          await CompletionAttempts.markCompletionAttemptFailed(completionAttempt, new Error('tree_shrub_unknown_products'));
          return res.status(400).json({
            error: 'Some recorded products were not found in the catalog — refresh the product list and try again.',
            code: 'tree_shrub_unknown_products',
            details: submittedProductIds.filter((id) => !found.has(String(id))),
          });
        }
      }
      const typedCompliance = validateTreeShrubTypedCompliance({
        service: svc,
        serviceDate: serviceDateOnly(svc.scheduled_date),
        values: treeShrubComplianceValues,
        products: products || [],
        productRows: typedProductRows,
        completionPhotos,
      });
      if (!typedCompliance.ok) {
        const complianceErr = new Error('tree_shrub_typed_compliance');
        await CompletionAttempts.markCompletionAttemptFailed(completionAttempt, complianceErr);
        return res.status(400).json({
          error: 'Tree & Shrub compliance checks must pass before completion',
          code: 'tree_shrub_typed_compliance',
          details: typedCompliance.blocks.map((block) => block.message),
          blocks: typedCompliance.blocks,
          warnings: typedCompliance.warnings,
        });
      }
      treeShrubCloseoutWarnings = typedCompliance.warnings || [];
    }

    if (claim.action === 'proceed' && !isIncompleteVisit && isWaveGuardLawnCompletion(svc)) {
      const plan = await buildPlanForService(svc.id, {
        equipmentSystemId: waveguardEquipmentSystemId || null,
        calibrationId: waveguardCalibrationId || null,
      });
      waveguardPlan = plan;
      const calibrationBlocks = calibrationLockoutBlocks(plan);
      // Calibration is advisory at completion, not a hard gate (mirrors
      // CompletionPanel's calibrationAdvisory): the tech acknowledges the warning
      // client-side and may complete a WaveGuard lawn visit without field-verified
      // equipment. Record the bypass for audit instead of returning a 400 lockout
      // that would trap the tech on the screen.
      const calibrationBypass = calibrationBlocks.length > 0;
      if (calibrationBypass) {
        waveguardCalibrationAdvisory = {
          acknowledged: true,
          acknowledgedByTechnicianId: req.technicianId,
          acknowledgedByRole: req.techRole || null,
          acknowledgedAt: new Date().toISOString(),
          blocks: calibrationBlocks.map((block) => ({
            code: block.code,
            message: block.message,
            source: block.source || null,
          })),
        };
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
      // Only adopt the plan's calibration when it's valid (no bypass). On a
      // calibration bypass we keep whatever the tech explicitly passed (usually
      // none) rather than recording an auto-picked, non-verified system as used.
      if (selectedCalibration && !calibrationBypass) {
        waveguardEquipmentSystemId = selectedCalibration.equipment_system_id || waveguardEquipmentSystemId;
        waveguardCalibrationId = selectedCalibration.id || waveguardCalibrationId;
      }
      // On a calibration bypass, record "none" rather than persisting equipment
      // the tech could not have chosen. We clear the IDs when EITHER:
      //   - no equipment was submitted (so any value present is only a stale
      //     assigned_equipment_system_id/assigned_calibration_id backfill), OR
      //   - the selected calibration is not field verified — those rows are
      //     filtered out of the dropdown (SchedulePage.jsx:5670), so a non-empty
      //     ID for one can only come from a stale draft / direct API, never a real
      //     tech selection.
      // A field-verified-but-expired calibration DOES appear in the dropdown and
      // can be deliberately selected, so we keep it (the advisory still warns).
      const selectedIsFieldVerified =
        selectedCalibration?.calibration_status === 'field_verified';
      if (calibrationBypass && (!equipmentSystemId || !selectedIsFieldVerified)) {
        waveguardEquipmentSystemId = null;
        waveguardCalibrationId = null;
        waveguardCalibrationCleared = true;
      }
      // Tank cleanout attestation is required whenever we will actually persist an
      // equipment system as used — i.e. waveguardEquipmentSystemId survived to here
      // and the calibration was not cleared to "none". Keying off the ID we persist
      // (rather than the raw request field) closes the gap where a backfilled, valid
      // field-verified assignment is recorded as used by an older client / direct API
      // with no cleanout. The earlier empty-dropdown / stale-assignment trap does not
      // recur: those calibrations are non-field-verified, so the clear above already
      // nulled the ID and this block is skipped.
      if (waveguardEquipmentSystemId && !waveguardCalibrationCleared) {
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
    let turfOcrReadingId = null; // set when a gauge photo was captured → async OCR post-commit
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
        conditionsAtApplication = shouldCaptureApplicationConditions({
          hasConditionsColumn: !!serviceRecordCols.conditions,
          useServiceReportV1,
          isIncompleteVisit,
          productCount: Array.isArray(products) ? products.length : 0,
        })
          ? await fetchApplicationConditions({
            latitude: svc.customer_latitude,
            longitude: svc.customer_longitude,
          }).catch(() => null)
          : null;

        // Auto-generate the customer-facing report summary from the tech's notes
        // when the closeout didn't supply one (the manual "Customer recap" box was
        // removed from the UI). Runs outside the txn. A HARD timeout caps the LLM
        // call so a stalled provider can't keep the already-claimed completion
        // attempt 'pending' (retries would then 409 until the stale window expires)
        // — on timeout (or error) we fall back to the deterministic recap.
        let effectiveCustomerRecap = customerRecap;
        if (!String(effectiveCustomerRecap || '').trim() && !isIncompleteVisit) {
          const recapInput = {
            notes: technicianNotes,
            visitOutcome,
            serviceType: svc.service_type,
            areasTreated: Array.isArray(areasTreated) ? areasTreated : (areasServiced || []),
          };
          const deterministicFallback = () => {
            try { return CompletionRecap.sanitizeRecap(CompletionRecap.deterministicRecap(recapInput)) || null; }
            catch { return null; }
          };
          try {
            const generatedRecap = await Promise.race([
              CompletionRecap.generateRecap(recapInput),
              new Promise((resolve) => setTimeout(
                () => resolve({ recap: deterministicFallback(), source: 'timeout' }),
                6000,
              )),
            ]);
            effectiveCustomerRecap = generatedRecap?.recap || deterministicFallback();
          } catch (recapErr) {
            logger.warn(`[completion] auto report-summary generation failed: ${recapErr.message}`);
            effectiveCustomerRecap = deterministicFallback();
          }
          // The generated recap is LLM output and skips runTypedValidation's
          // banned-customer-copy guard (that ran earlier on the now-omitted request
          // field). Re-check it here; fall back to the deterministic recap on any
          // violation (an LLM prompt is not a validator), and null it if even that trips.
          if (effectiveCustomerRecap
            && ActivityIndicators.findBannedCustomerCopy(effectiveCustomerRecap).length) {
            effectiveCustomerRecap = deterministicFallback();
            if (effectiveCustomerRecap
              && ActivityIndicators.findBannedCustomerCopy(effectiveCustomerRecap).length) {
              effectiveCustomerRecap = null;
            }
          }
        }

        await db.transaction(async (trx) => {
          const completionEndedAt = new Date();
          const completionServiceDate = etDateString(completionEndedAt);
          const lifecycleUpdates = buildCompletionLifecycleUpdates(svc, completionEndedAt, { elapsed: timeOnSite });
          const structuredNotes = {
            visitOutcome,
            // Internal-only consultations never request a customer review —
            // freeze the opt-out so the Stripe paid-invoice webhook
            // (stripe-webhook.js) also suppresses it for a billed assessment.
            requestReview: (isIncompleteVisit || isInternalOnlyCompletion) ? false : requestReview !== false,
            oneTimeRecapOnly: recapReviewOnly,
            reviewSuppression,
            reviewTiming: reviewTiming || null,
            reviewDelayMinutes: completionReviewDelayMinutes == null ? null : completionReviewDelayMinutes,
            reviewScheduledFor: reviewScheduledFor || null,
            incompleteReason,
            customerConcernText: concernText || null,
            customerRecap: effectiveCustomerRecap || null,
            timeOnSite: timeOnSite || null,
            customerInteraction: normalizedCustomerInteraction,
            invoiceAlreadySent: !!invoiceAlreadySent,
            areasTreated: completionAreas,
            waveguardEquipmentSystemId,
            waveguardCalibrationId,
            waveguardBlackoutApproval,
            waveguardNLimitApproval,
            waveguardManagerApproval,
            waveguardCalibrationAdvisory,
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
            // Tech-speed telemetry from the typed CompletionPanel (contract
            // §10) — opaque client timings, persisted for budget analysis.
            ...(completionTelemetry && typeof completionTelemetry === 'object' && !Array.isArray(completionTelemetry)
              ? { completionTelemetry }
              : {}),
            // Delivery posture at completion time, frozen on the record:
            // /api/services + documents.js suppress report links/downloads for
            // non-auto_send rows — a later graduation to auto_send must not
            // retroactively expose reports that were never sent. Frozen for
            // typed completions AND internal-only consultations (typedDeliveryMode
            // 'disabled') so the no-customer-artifact posture survives resume.
            ...((typedFindingsType || isInternalOnlyCompletion) ? { typedReportDelivery: typedDeliveryMode } : {}),
            // Companion delivery postures frozen alongside (same rule):
            // graduation flips on the profile never retro-publish stored
            // companion sections.
            ...(validatedCompanions.length
              ? { companionReportDelivery: Object.fromEntries(companionDeliveryByType) }
              : {}),
          };
          const serviceData = {
            protocol: {
              visitOutcome,
              actions: reportProtocolActions,
              observations: reportObservations,
              recommendations: reportRecommendations,
            },
          };
          // Typed specialty completion: resolve trend vs the customer's prior
          // visit for the same indicator, then persist the immutable
          // customer-copy snapshot (typedReportSnapshot). The report renders
          // from this snapshot forever — labels/copy are resolved HERE.
          let typedActivity = null;
          let typedVisitSequence = 1;
          if (typedFindings) {
            if (typedIndicator && typedActivityScore != null && activityScoresAvailable) {
              // Latest prior score for the trend (one row) + an UNBOUNDED
              // count for the visit sequence — a limited fetch would cap
              // long trapping programs at visit 9 in the immutable snapshot
              // (Codex P2).
              const priorScoreRow = await trx('service_activity_scores')
                .where({
                  customer_id: svc.customer_id,
                  indicator_key: typedIndicator.indicatorKey,
                })
                .where('service_date', '<=', completionServiceDate)
                .orderBy('service_date', 'desc')
                .orderBy('created_at', 'desc')
                .first('score');
              const [priorCountRow] = await trx('service_activity_scores')
                .where({
                  customer_id: svc.customer_id,
                  indicator_key: typedIndicator.indicatorKey,
                })
                .where('service_date', '<=', completionServiceDate)
                .count('* as count');
              const priorScore = priorScoreRow ? Number(priorScoreRow.score) : null;
              typedVisitSequence = Number(priorCountRow?.count || 0) + 1;
              const derived = ActivityIndicators.deriveActivityScore(typedFindingsType, typedFindings.values);
              typedActivity = {
                indicatorKey: typedIndicator.indicatorKey,
                label: typedIndicator.label,
                score: typedActivityScore,
                source: typedScoreSource,
                derivedFrom: derived
                  ? { field: derived.field, value: derived.value, initialDerivedScore: derived.score }
                  : null,
                trend: ActivityIndicators.trendDirection(typedActivityScore, priorScore),
                trendWord: ActivityIndicators.trendWordForScores(typedActivityScore, priorScore),
              };
            }
            serviceData.typedReportSnapshot = ActivityIndicators.buildTypedReportSnapshot({
              projectType: typedFindingsType,
              values: typedFindings.values,
              nextStepChips: typedChips,
              serviceKey: completionProfile?.serviceKey || null,
              serviceLabel: completionProfile?.serviceName || svc.service_type || null,
              visitSequence: typedVisitSequence,
              activity: typedActivity,
              photoSummary: photoSummaryText || null,
            });
          }
          // Companion typed sections: one immutable snapshot per validated
          // companion, each carrying its frozen delivery posture. Trend
          // resolution mirrors the primary's (same queries, same trx);
          // photos / photo AI / pest pressure stay primary-only in v1.
          // Activity scores insert REGARDLESS of delivery — deliberately
          // identical to the standalone shadow semantic (Phase 1b): the
          // shadow gates customer COPY, not observations of the customer's
          // own property, so a graduated section trends against its
          // shadow-era baseline instead of resetting to "first marker".
          const companionActivityInserts = [];
          if (validatedCompanions.length) {
            const companionSnapshots = [];
            for (const companion of validatedCompanions) {
              const companionIndicator = ActivityIndicators.getActivityIndicator(companion.type);
              let companionActivity = null;
              let companionVisitSequence = 1;
              if (companionIndicator && companion.activityScore != null && activityScoresAvailable) {
                const resolved = await CompanionCompletions.resolveCompanionActivity(trx, {
                  customerId: svc.customer_id,
                  indicatorKey: companionIndicator.indicatorKey,
                  completionServiceDate,
                  score: companion.activityScore,
                  scoreSource: companion.activityScoreSource,
                  type: companion.type,
                  values: companion.values,
                });
                companionActivity = resolved.activity;
                companionVisitSequence = resolved.visitSequence;
              }
              const companionSnapshot = ActivityIndicators.buildTypedReportSnapshot({
                projectType: companion.type,
                values: companion.values,
                nextStepChips: companion.chips,
                serviceKey: completionProfile?.serviceKey || null,
                // The companion section speaks for ITS work, not the whole
                // combined service — null falls back to the type's own label
                // so "Lawn + Tree & Shrub" copy never claims the lawn visit
                // (Codex P2).
                serviceLabel: null,
                visitSequence: companionVisitSequence,
                activity: companionActivity,
                photoSummary: null,
              });
              if (companionSnapshot) {
                // The frozen per-section delivery rides the snapshot itself
                // so report-data filters without re-reading the live profile.
                companionSnapshot.delivery = companionDeliveryByType.get(companion.type) || 'internal_only';
                companionSnapshots.push(companionSnapshot);
              }
              if (companionActivity) companionActivityInserts.push(companionActivity);
            }
            if (companionSnapshots.length) serviceData.companionReportSnapshots = companionSnapshots;
          }
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
            // Exterior re-entry ("Ready in …") reflects the manufacturer REI of
            // the products actually applied — the most restrictive wins — falling
            // back to the service-line default when no product carries an REI. Kept
            // no lower than the default so a 0-hr / "until dry" product still shows
            // a sensible dry-down window.
            const productReentryMin = await maxProductReentryMinutes(trx, products || []);
            const advisoryDefaultsForVisit = productReentryMin != null
              ? {
                ...reportConfig.advisoryDefaults,
                exterior_reentry_min: Math.max(
                  Number(reportConfig.advisoryDefaults?.exterior_reentry_min) || 0,
                  productReentryMin,
                ),
              }
              : reportConfig.advisoryDefaults;
            const advisoryNormalized = buildCompletionAdvisory({
              advisoryDefaults: advisoryDefaultsForVisit,
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
          // handler), (b) the completion is neither typed nor internal-only,
          // (c) the active config has
          // `allowTechnicianClientRatingEntry` enabled, AND (d) this
          // record's `service_line` is in the config's
          // `enabledServiceLines` allow-list. The engine's score calc
          // skips lines outside the allow-list anyway, so writing the
          // rating for a tree-shrub or termite visit would dead-end the
          // data (column gets set but never read). Inline-load the
          // config inside the txn so we read a consistent snapshot with
          // the score calc that runs a few lines below.
          if (clientPestRating != null
            && completionAllowsTechnicianPestRating({ typedFindingsType, isInternalOnlyCompletion })
            && serviceRecordCols.client_pest_rating
            && serviceRecordCols.client_pest_rating_source) {
            const pestPressureConfig = await loadPestPressureConfig(trx);
            if (pestPressureConfigAllowsTechnicianRating({
              pestPressureConfig,
              serviceLine: reportServiceLine,
            })) {
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

        // Gauge reading. Both the height and the on-site lawn-length photo are
        // OPTIONAL — persist a row whenever EITHER is present (a photo-only visit
        // carries a null height). It goes in the outer completion txn (atomic):
        // a persistence failure aborts completion (the existing catch cleans up +
        // the tech retries). The photo upload runs in its own SAVEPOINT so a
        // photo/S3 failure can't block the reading row; its uploaded row is
        // registered for cleanup if the outer txn later aborts.
        if (turfHeightApplicable && (manualHeightIn != null || gaugePhoto)) {
          const turfRow = await trx('customer_turf_profiles')
            .where({ customer_id: svc.customer_id, active: true }).first();
          let gaugePhotoId = null;
          if (gaugePhoto) {
            try {
              await trx.transaction(async (sp) => {
                const gaugeUpload = await uploadServicePhotoDataUrls({
                  serviceRecordId: record.id,
                  photos: [gaugePhoto],
                  photoType: 'progress',
                  knex: sp,
                });
                gaugePhotoId = gaugeUpload?.photos?.[0]?.id || null;
                if (gaugeUpload?.photos?.length) {
                  preCommitCompletionPhotoRows = preCommitCompletionPhotoRows.concat(gaugeUpload.photos);
                }
              });
            } catch (photoErr) {
              gaugePhotoId = null; // optional — never block the reading row
              logger.warn(`[turf-height] optional lawn-length photo skipped for service=${req.params.serviceId}: ${photoErr.message}`);
            }
          }
          // Only persist a row when there's actually something to store — a numeric
          // reading or a photo that uploaded. A photo-only visit whose upload failed
          // (gaugePhotoId stayed null) would otherwise insert an empty row (null
          // height + null photo) and consume the one-row-per-service slot (Codex P1).
          if (manualHeightIn != null || gaugePhotoId) {
            const turfReading = await createTurfHeightReading(trx, {
              serviceRecordId: record.id,
              customerId: svc.customer_id,
              grassType: turfRow?.grass_type || 'unknown',
              manualHeightIn,
              gaugePhotoId,
              createdBy: req.technicianId,
            });
            // Cross-check only when BOTH a gauge photo and a numeric reading exist
            // (OCR compares the photo against the entered height); runs after commit.
            if (gaugePhotoId && manualHeightIn != null && turfReading?.id) turfOcrReadingId = turfReading.id;
          }
        }

        // Typed activity score — in the same trx as the record so retries
        // and durable-completion resumes can never double-insert (composite
        // unique on (service_record_id, indicator_key) backstops).
        if (typedActivity && activityScoresAvailable) {
          await trx('service_activity_scores')
            .insert({
              customer_id: svc.customer_id,
              service_record_id: record.id,
              indicator_key: typedActivity.indicatorKey,
              service_date: completionServiceDate,
              score: typedActivity.score,
              source: typedActivity.source,
              derived_from: typedActivity.derivedFrom ? serializeJsonb(typedActivity.derivedFrom) : null,
            })
            .onConflict(['service_record_id', 'indicator_key'])
            .ignore();
        }

        // Companion activity scores — one row per companion with a resolved
        // indicator score, same trx + onConflict ignore as the primary
        // (indicator uniqueness vs primary/siblings was validated up front,
        // so the composite unique never silently drops a row).
        for (const companionActivity of companionActivityInserts) {
          await trx('service_activity_scores')
            .insert({
              customer_id: svc.customer_id,
              service_record_id: record.id,
              indicator_key: companionActivity.indicatorKey,
              service_date: completionServiceDate,
              score: companionActivity.score,
              source: companionActivity.source,
              derived_from: companionActivity.derivedFrom ? serializeJsonb(companionActivity.derivedFrom) : null,
            })
            .onConflict(['service_record_id', 'indicator_key'])
            .ignore();
        }

        // Internal-only consultations skip service_findings entirely: the
        // observations are still retained in structured_notes, but a findings
        // row would make the consult readable as prior pest history (Pest
        // Pressure recurring-issue component matches completed records'
        // service_findings by service_line) and surface on customer-facing
        // findings reads — neither is wanted for an advisory walkthrough.
        if (useServiceReportV1 && serviceFindingsAvailable && reportObservations.length && !isInternalOnlyCompletion) {
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
        // Typed completions carry their real findings in the snapshot —
        // the legacy no-activity fallback would stamp "No activity observed"
        // onto e.g. an active cockroach visit (pre-push Codex P1).
        if (
          useServiceReportV1
          && serviceFindingsAvailable
          && !typedFindingsType
          && !isInternalOnlyCompletion
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
        // Typed specialty completions never feed Pest Pressure — their
        // service_type can detect to the 'pest' line and slip past the
        // one-time-label gate, which would pollute recurring pressure
        // history. The activity score above is their indicator instead.
        // Internal-only consultations are excluded for the same reason: an
        // advisory walkthrough must not write Pest Pressure history.
        if (useServiceReportV1 && serviceFindingsAvailable && serviceRecordCols.pressure_index && !typedFindingsType && !isInternalOnlyCompletion) {
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

        // 2b. FDACS compliance ledger (property_application_history) — the
        // application-record rows the DACS inspector export
        // (admin-compliance-v2) and application-limits annual caps read.
        // Same trx as the service_record + service_products inserts so the
        // ledger can never half-commit: the completion lands with its
        // regulatory rows or not at all. Idempotent inside the writer
        // (unique service_product_id + ON CONFLICT DO NOTHING), so
        // durable-completion resumes and retries never duplicate rows.
        // Incomplete visits are included on purpose — any product logged
        // was physically applied regardless of the visit outcome.
        if (insertedServiceProducts.length) {
          const ComplianceService = require('../services/compliance');
          await ComplianceService.createComplianceRecords(record.id, { trx });
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
            // When the tech bypassed calibration without submitting equipment, the
            // IDs were intentionally cleared to null — don't let the protocol
            // completion re-derive the stale assigned system from the plan.
            calibrationCleared: waveguardCalibrationCleared,
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

        if (treeShrubPhotoGateRequired) {
          completionPhotoUploadResult = await uploadServicePhotoDataUrls({
            serviceRecordId: record.id,
            photos: completionPhotos,
            photoType: 'after',
            knex: trx,
          });
          // Cumulative (concat, not assign) so an earlier-registered turf-height
          // gauge photo row isn't dropped from the rollback-cleanup list on a
          // lawn + Tree/Shrub completion (else the gauge image orphans in S3).
          preCommitCompletionPhotoRows = preCommitCompletionPhotoRows.concat(completionPhotoUploadResult.photos || []);
          const uniqueCompletionPhotosUploaded = completionPhotoUploadResult.uniqueUploaded
            ?? completionPhotoUploadResult.uploaded;
          if (uniqueCompletionPhotosUploaded < TREE_SHRUB_MIN_CLOSEOUT_PHOTOS) {
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
              uniqueUploaded: uniqueCompletionPhotosUploaded,
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
        if (preCommitCompletionPhotoRows.length) {
          await cleanupUploadedServicePhotoObjects(preCommitCompletionPhotoRows);
          preCommitCompletionPhotoRows = [];
        }
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

    // Gauge-photo OCR cross-check — fire-and-forget now that the reading is
    // durably committed. Runs on BOTH first-run and durable-resume paths. On
    // resume the reading was written in a prior pass (so turfOcrReadingId is
    // null here); recover any reading that never got cross-checked — i.e. the
    // process exited before this point — instead of leaving it stuck 'pending'
    // and invisible to the review queue. QA only; never blocks completion.
    if (!turfOcrReadingId && resumingCommittedCompletion && record?.id) {
      try {
        const pendingTurf = await db('turf_height_readings')
          .where({ service_record_id: record.id, verification_status: 'pending' })
          .whereNotNull('gauge_photo_id')
          .whereNotNull('manual_height_in') // photo-only rows have no reading to cross-check
          .first('id');
        turfOcrReadingId = pendingTurf?.id || null;
      } catch (turfErr) {
        logger.warn(`[turf-height] resume OCR re-arm lookup failed for service_record=${record.id}: ${turfErr.message}`);
      }
    }
    if (turfOcrReadingId) {
      const ocrReadingId = turfOcrReadingId;
      setImmediate(() => {
        void TurfHeightOcr.processReadingOcr(ocrReadingId)
          .catch((err) => logger.error(`[turf-height] OCR cross-check failed for reading=${ocrReadingId}: ${err.message}`));
      });
    }

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
        // The photo summary was frozen into the snapshot before these
        // best-effort uploads ran — if any photo is missing, the summary
        // can describe photos the report doesn't show. Strip it rather
        // than ship copy about absent images.
        const sd = parseJsonObject(record.service_data);
        if (sd?.typedReportSnapshot?.photoSummary) {
          sd.typedReportSnapshot.photoSummary = null;
          await db('service_records').where({ id: record.id }).update({
            service_data: serializeJsonb(sd),
          }).then(() => {
            record.service_data = sd;
          }).catch((stripErr) => {
            logger.warn(`[dispatch] photo summary strip failed for ${record.id}: ${stripErr.message}`);
          });
        }
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

    // Property-zone sync (satellite coverage lane): persist any tech-marked
    // satellite shapes and keep the customer's zone rows label-synced with the
    // chipped areas. Post-commit + fail-soft on purpose: zones are report
    // presentation data — a pg error here must neither abort the completion
    // txn nor poison later statements in it. The service itself no-ops for
    // customers with no zone rows and no incoming shapes, so prod reports
    // stay on the schematic defaults until a map is actually marked.
    try {
      const zoneSync = await PropertyZones.upsertZonesForCompletion(db, {
        customerId: svc.customer_id,
        serviceLine: reportServiceLine,
        areaLabels: completionAreas,
        zoneShapes: Array.isArray(zoneShapes) ? zoneShapes : [],
      });
      if (zoneSync.created || zoneSync.updated || zoneSync.shapesApplied || zoneSync.skipped.length) {
        logger.info('[completion] property zones synced', { serviceId: svc.id, ...zoneSync });
      }
    } catch (zoneErr) {
      logger.warn(`[completion] property-zone sync failed (non-blocking): ${zoneErr.message}`);
    }

    // Auto-score the Tree & Shrub visit's photos (dual-vision) and persist a
    // tree_shrub_assessments row that feeds the customer Tree & Shrub Report V2.
    // Post-commit + fire-and-forget: it never blocks completion latency or success
    // (the report self-heals on view). Flag-gated, tree_shrub-only, fully guarded —
    // a scoring hiccup can't affect any completion. Replays return earlier, so this
    // runs once on the genuine first completion (no duplicate assessments).
    if (
      process.env.TREE_SHRUB_REPORT_V2 === 'true'
      && reportServiceLine === 'tree_shrub'
      && !isIncompleteVisit
      && Array.isArray(completionPhotos) && completionPhotos.length
    ) {
      let uploadedRows = Array.isArray(preCommitCompletionPhotoRows) ? preCommitCompletionPhotoRows : [];
      // Resume recovery: on a post-commit retry the in-memory upload result is empty
      // even though the photos were already persisted to service_photos. Without this,
      // scorable would be empty on resume and the V2 report would stay blank. Load the
      // committed 'after' photo rows for this record so scoring can still proceed.
      if (!uploadedRows.length && record.id) {
        uploadedRows = await db('service_photos')
          .where({ service_record_id: record.id, photo_type: 'after' })
          .select('s3_key', 'sort_order', 'caption')
          .orderBy('sort_order', 'asc')
          .catch(() => []);
      }
      // Align uploaded S3 rows to submitted photos by sort_order, NOT by position:
      // uploadServicePhotoDataUrls drops failed uploads (compacting the array), so a
      // positional [i] join would pair a photo's vision score / caption with a
      // DIFFERENT photo's S3 key whenever an upload fails. sort_order is the photo's
      // original submission index, so the join stays correct with gaps.
      const rowBySort = new Map(uploadedRows.map((r) => [r.sort_order, r]));
      const rowFor = (p, i) => rowBySort.get(p && p.sortOrder != null ? p.sortOrder : i) || null;
      const assessService = {
        id: record.id,
        customer_id: svc.customer_id,
        scheduled_service_id: svc.id,
        technician_id: svc.technician_id || req.technicianId || null,
        service_date: svc.scheduled_date || record.service_date || null,
      };
      // Only operate on photos that ACTUALLY uploaded — the assessment must never
      // reference an image the report can't show, and scores must reflect the photos
      // it displays. submitted = photos with data; scorable = those with an S3 row.
      const submitted = completionPhotos.filter((p) => p && p.data);
      const scorable = submitted
        .map((p, i) => ({ p, row: rowFor(p, i) }))
        .filter((x) => x.row);
      const allUploaded = scorable.length > 0 && scorable.length === submitted.length;
      // Tech-reviewed path: the closeout preview already scored the photos and the
      // tech confirmed/hid/edited. Trust that aggregate ONLY when every submitted
      // photo uploaded AND the preview actually scored every one of them (a vision
      // call may have failed during preview) — otherwise the report could show a photo
      // that never contributed to the score, so re-score the uploaded set instead.
      const review = req.body && req.body.treeShrubReview;
      const previewCoveredAll = review && Number(review.scoredCount) === submitted.length;
      // Prove the scores + observation + the EXACT photo set came from this server's
      // /assess-preview — a tampered/stale client (or one that swapped photos at the
      // same count, or edited the observation copy) can't forge the HMAC, so it falls
      // back to re-scoring rather than persisting arbitrary client-supplied content.
      const reviewPhotosHash = treeShrubPhotosHash(submitted.map((p) => p.data));
      const reviewSigned = review && review.signature
        && review.signature === treeShrubReviewSignature(review.scores, review.scoredCount, svc.id, reviewPhotosHash, review.observations);
      let scoringPromise = null;
      if (review && review.scores && typeof review.scores === 'object' && allUploaded && previewCoveredAll && reviewSigned) {
        const reviewPhotos = scorable.map(({ p, row }) => ({ s3_key: row.s3_key || null, url: row.url || null, caption: p.caption || null, zone: p.zone || p.zoneId || null }));
        scoringPromise = storeTreeShrubAssessmentFromReview({
          service: assessService,
          scores: review.scores,
          decisions: Array.isArray(review.decisions) ? review.decisions : (Array.isArray(review.findings) ? review.findings : []),
          photos: reviewPhotos,
          observations: typeof review.observations === 'string' ? review.observations : '',
        });
      } else {
        const scorePhotos = scorable.map(({ p, row }) => ({
          data: p.data,
          caption: p.caption || null,
          zone: p.zone || p.zoneId || null,
          s3Key: row.s3_key || null,
          url: row.url || null,
          qualityScore: 60,
        }));
        if (scorePhotos.length) {
          scoringPromise = scoreAndStoreTreeShrubAssessment({
            service: assessService,
            photos: scorePhotos,
            loadImage: (ph) => {
              const m = String(ph.data || '').match(/^data:([^;,]+)?(?:;base64)?,(.*)$/);
              return m && m[2] ? { base64: m[2], mimeType: m[1] || 'image/jpeg' } : null;
            },
          });
        }
      }
      if (scoringPromise) {
        const logged = scoringPromise.catch((err) => logger.error(`[tree-shrub] assessment persist failed for service_record ${record.id}: ${err.message}`));
        // Give the persist a bounded window to land BEFORE the customer artifacts
        // (report token / PDF / email) are queued below, so they include the V2
        // section. The reviewed path is a fast insert; the auto-score path runs vision
        // — cap the wait so a slow/hung model call can't block completion. On timeout
        // it finishes in the background and the live report self-heals on next view.
        await Promise.race([logged, new Promise((resolve) => setTimeout(resolve, 12000))]);
      }
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
    // Estimate-flow customers bill PER VISIT (owner ruling 2026-07-09):
    // completion collects the exact per-application fee stamped at acceptance
    // — auto-charged to the saved autopay card further below, invoiced
    // otherwise. The monthly-membership model (autopayCoversVisit suppression
    // + the 8AM cron) never applies to them.
    const perApplicationBilling = svc.cust_billing_mode === 'per_application';
    // Callbacks (re-services) are free by definition for recurring/WaveGuard
    // customers — they must NOT fall back to the customer's monthly_rate, or a
    // no-charge re-service would bill a full month's dues. Honour an explicit
    // positive price if the operator set one; otherwise the visit is $0.
    // Per-application precedence: explicit visit price → acceptance fee →
    // nothing (never monthly_rate — see completionInvoiceAmount).
    const invoiceAmount = completionInvoiceAmount({
      estimatedPrice: svc.estimated_price,
      isCallback: svc.is_callback,
      perApplicationBilling,
      perApplicationFee: svc.cust_per_application_fee,
      monthlyRate: svc.cust_monthly_rate,
    });
    // A billable per-application visit with no amount on file (multi-service
    // accept: fee + row prices intentionally NULL) completes UNINVOICED — flag
    // it loudly so the visit gets billed manually instead of leaking.
    if (perApplicationBilling && !(invoiceAmount > 0)
      && !svc.is_callback && !isAlwaysFreeServiceType(svc.service_type)) {
      logger.warn(`[dispatch] per-application visit ${svc.id} (customer ${svc.customer_id}) completed with no billable amount on file (no visit price, no per_application_fee — multi-service plan?) — invoice manually`);
    }
    // Third-party Bill-To: a payer-billed visit is owed by the payer's AP inbox,
    // so the service customer's autopay/prepay must neither suppress the AP
    // invoice (autopayCoversVisit / prepaidCovered) nor be credited against it
    // (applyPrepaidCreditToInvoice). Resolve the effective payer up front —
    // BEFORE autopay coverage is computed — so every coverage gate can exclude
    // payer visits. resolveForInvoice never throws (it falls back to self-pay),
    // and we keep the existing self-pay flow on any lookup error.
    let visitIsPayerBilled = false;
    try {
      const PayerService = require('../services/payer');
      const resolvedPayer = await PayerService.resolveForInvoice({
        customerId: svc.customer_id,
        scheduledServiceId: svc.id,
      });
      visitIsPayerBilled = !!resolvedPayer?.payerId;
    } catch (e) {
      logger.warn(`[dispatch] payer resolve failed on completion for service ${svc.id}: ${e.message}`);
    }
    const customerAutopayActive = await customerOnAutopay({
      id: svc.customer_id,
      autopay_enabled: svc.cust_autopay_enabled,
      autopay_paused_until: svc.cust_autopay_paused_until,
      autopay_payment_method_id: svc.cust_autopay_payment_method_id,
      ach_status: svc.cust_ach_status,
    });
    // Never let the homeowner's autopay cover a payer-billed WaveGuard visit —
    // the AP invoice must still be cut and sent to the payer.
    // autopayCoversVisit is the MONTHLY-MEMBERSHIP suppression ("the 8AM cron
    // collects the dues, the visit itself is free") — it must never suppress a
    // per-application customer's visit bill: their autopay card is HOW the
    // per-visit charge collects, not a reason to skip it.
    const autopayCoversVisit = !visitIsPayerBilled
      && !perApplicationBilling
      && customerAutopayActive
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
          .where({ service_record_id: record.id })
          .whereIn('status', ['paid', 'prepaid'])
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
      if (!existingCompletionInvoice) {
        existingCompletionInvoice = await findFirstApplicationInvoiceForEstimateService(svc, db);
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
          if (['paid', 'prepaid'].includes(existingCompletionInvoice.status)) alreadyPaid = true;
          else invoiceCreated = true;
        }
      }
    } catch (e) { /* non-blocking */ }
    // If the admin/tech marked this visit prepaid (cash, Zelle, phone CC, etc.)
    // and the recorded amount covers the would-be invoice, skip auto-invoicing.
    // Never for a payer-billed visit (visitIsPayerBilled resolved above) — the
    // homeowner's prepay can't cover the payer's bill, so the AP invoice must
    // still be cut.
    // Annual-prepay coverage is validated by the term link, NOT the per-visit
    // amount: a discounted plan stamps each visit LESS than its undiscounted
    // estimated_price, so an amount-only gate would re-bill an already-prepaid
    // visit. annualPrepayCoversVisit is fail-closed (explicit annual_prepay_invoice
    // stamp AND a still-live, non-refunded term). The numeric fallback covers ONLY
    // out-of-band methods (cash/Zelle) — an annual_prepay_invoice stamp is governed
    // EXCLUSIVELY by that gate, so a STALE annual-prepay stamp (left by a
    // best-effort void/refund clear) must NOT suppress here via its amount.
    const AnnualPrepayRenewals = require('../services/annual-prepay-renewals');
    const annualPrepayCovered = !visitIsPayerBilled
      && await AnnualPrepayRenewals.annualPrepayCoversVisit(svc, db);
    const prepaidCovered = annualPrepayCovered
      || (!visitIsPayerBilled
        && svc.prepaid_method !== AnnualPrepayRenewals.ANNUAL_PREPAY_PREPAID_METHOD
        && svc.prepaid_amount != null
        && Number(svc.prepaid_amount) > 0
        && Number(svc.prepaid_amount) >= invoiceAmount);
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
    // Auto-invoice eligibility. With GATE_AUTOINVOICE_PRICED_VISITS on, an
    // explicitly-priced visit also qualifies even without the scheduler's
    // create_invoice_on_complete flag or a WaveGuard tier — closing the leak
    // where priced, self-pay, non-WaveGuard visits completed uninvoiced.
    // Default OFF = behaviour identical to before.
    const shouldInvoice = shouldAutoInvoiceCompletion({
      recapReviewOnly,
      alreadyPaid,
      prepaidCovered,
      autopayCoversVisit,
      preMintedInvoice,
      existingCompletionInvoice,
      createInvoiceOnComplete: svc.create_invoice_on_complete,
      waveguardTier: svc.cust_waveguard_tier,
      perApplicationBilling,
      hasVisitPrice,
      invoiceAmount,
      autoInvoicePricedVisits: process.env.GATE_AUTOINVOICE_PRICED_VISITS === 'true',
      serviceType: svc.service_type,
      isCallback: svc.is_callback,
    });
    // Customer-facing SMS URL must be the canonical portal domain, not
    // the raw Railway URL (CLIENT_URL was set to the Railway hostname on
    // prod for app-internal redirects). publicPortalUrl() reads
    // PUBLIC_PORTAL_URL first which is the canonical public origin.
    // Resume safety: a crash-resumed completion re-enters here with the
    // record already committed — and the profile may have graduated since
    // (e.g. Phase-1b internal_only → auto_send, or a Waves Assessment flipped
    // off internal-only). The record's FROZEN typedReportDelivery is the truth
    // for this completion's delivery gates; the live profile only decides for
    // brand-new records (the freeze itself is written from the profile at
    // insert time). Applies to typed completions AND internal-only
    // consultations — both freeze typedReportDelivery; routine completions
    // never persist it, so frozenDelivery is undefined and nothing changes.
    if (record?.structured_notes) {
      const frozenDelivery = parseJsonObject(record.structured_notes)?.typedReportDelivery;
      if (frozenDelivery && frozenDelivery !== typedDeliveryMode) {
        typedDeliveryMode = frozenDelivery;
        suppressTypedCustomerComms = typedDeliveryMode !== 'auto_send';
        effectiveSendCompletionSms = sendCompletionSms && !suppressTypedCustomerComms;
      }
    }
    if (resumingCommittedCompletion && shouldRejectPhotoCaptionBannedCopy({
      captionBannedViolations,
      isInternalOnlyCompletion,
      resumingCommittedCompletion,
      typedDeliveryMode,
    })) {
      return res.status(422).json(photoCaptionBannedCopyPayload(captionBannedViolations));
    }
    const portalUrl = publicPortalUrl();
    let reportUrl = portalUrl;
    let reportToken = null;
    // delivery_mode 'disabled' (typed kill switch) suppresses the customer
    // report entirely — don't mint a public token at all (Codex P2). The
    // record still exists; flipping the mode back later can mint on demand.
    if (typedDeliveryMode !== 'disabled') {
      try {
        const { ensureReportToken } = require('./reports-public');
        reportToken = await ensureReportToken(record.id);
        if (reportToken) reportUrl = `${portalUrl}/report/${reportToken}`;
      } catch (err) {
        logger.error(`[dispatch] service report token mint failed: ${err.message}`);
      }
    }
    const serviceReportV1Delivery = shouldSendServiceReportV1Delivery(record);
    // Only auto_send completions queue a PDF render. 'disabled' is the typed
    // kill switch; 'internal_only' (Phase-1b shadow) can't render either —
    // the headless renderer opens /report/:token?mode=pdf without a staff
    // JWT, and the public report routes 404 suppressed reports for
    // non-staff. Staff review the shadow via the HTML report; the PDF only
    // feeds customer sends, which are suppressed anyway.
    if (serviceReportV1Delivery && reportToken && typedDeliveryMode === 'auto_send') {
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
    // Best-effort: queue the "Your Visit, in Motion" recap render for pest visits
    // (flag-gated via PEST_RECAP). The pipeline self-skips non-eligible visits and a
    // failure here never blocks completion; the tech approves before it ever sends.
    if (process.env.PEST_RECAP === 'true' && typedDeliveryMode === 'auto_send' && String(record.service_line || '').toLowerCase() === 'pest' && record.scheduled_service_id) {
      try {
        const { enqueueRecap } = require('../services/service-report/recap-pipeline');
        // Keyed on the scheduled-service id so pre-completion captures match the render.
        // force=true re-renders even if a pre-completion Generate already failed (no
        // service_records row existed yet) — now it does.
        await enqueueRecap(record.scheduled_service_id, { force: true });
      } catch (err) {
        logger.warn(`[dispatch] recap render queue failed for ${record.id}: ${err.message}`);
      }
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
    if (serviceReportV1Delivery && useServiceReportV1 && !suppressTypedCustomerComms) {
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
      // Applying annual-prepay coverage to a PRE-EXISTING invoice is deferred to a
      // dedicated follow-up — it needs non-cash accounting (the money was already
      // collected on the annual prepay invoice, so no payments row / revenue), an
      // idempotency marker, and add-on split-billing. This path only applies
      // out-of-band prepayments (cash/Zelle): skip annual_prepay_invoice stamps so
      // we never credit a discounted slice, book a non-cash payment as revenue, or
      // credit a stale/refunded stamp. The completion suppression gate already
      // stops the double-bill for covered visits (no new invoice is cut).
      const prepaidCents = (svc.prepaid_method !== AnnualPrepayRenewals.ANNUAL_PREPAY_PREPAID_METHOD
        && svc.prepaid_amount != null) ? toCents(svc.prepaid_amount) : 0;
      if (!(prepaidCents > 0) || !invoiceRow?.id) return invoiceRow;
      // Third-party Bill-To: never credit the homeowner's prepaid amount against
      // a payer-billed invoice — that money isn't owed by the payer. The invoice
      // row is the source of truth (createFromService auto-resolves a default
      // payer, and any pre-minted invoice carries its own payer_id), so guard on
      // it directly.
      if (invoiceRow.payer_id) return invoiceRow;

      // PI safety: a pre-minted / sent invoice can carry a live PaymentIntent.
      // Crediting the prepayment (marking it paid) without neutralizing the PI
      // lets a stale client secret still charge the card. Cancel a cancelable PI;
      // if money is in flight or the PI can't be verified, skip applying (leave it
      // to settle) and alert for manual reconciliation. Shared guard with the
      // mark-prepaid receipt path (services/prepaid-pi-guard).
      let prepaidPiId = invoiceRow.stripe_payment_intent_id || null;
      if (prepaidPiId) {
        const { guardOpenPaymentIntentForPrepaid } = require('../services/prepaid-pi-guard');
        const guard = await guardOpenPaymentIntentForPrepaid(invoiceRow);
        if (!guard.ok) {
          logger.error(`[dispatch] Prepaid credit NOT applied to invoice ${invoiceRow.invoice_number} for service ${svc.id}: open PaymentIntent (${guard.reason}) — a card/ACH payment may still settle; manual reconciliation needed`);
          return invoiceRow;
        }
        prepaidPiId = guard.piId;
      }

      return db.transaction(async (trx) => {
        const lockedInvoice = await trx('invoices')
          .where({ id: invoiceRow.id })
          .forUpdate()
          .first();
        if (!lockedInvoice) return invoiceRow;
        if (['paid', 'prepaid'].includes(lockedInvoice.status)) return lockedInvoice;
        // PI re-check under lock: a new /pay session could have minted a different
        // PI since the triage above; refuse and leave the prepayment for a later
        // pass rather than mark paid alongside a live session.
        if ((lockedInvoice.stripe_payment_intent_id || null) !== (prepaidPiId || null)) {
          logger.error(`[dispatch] Prepaid credit NOT applied to invoice ${lockedInvoice.invoice_number}: PaymentIntent changed under lock — manual reconciliation needed`);
          return lockedInvoice;
        }
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
      // Treat already-paid / prepaid pre-mint as the same SMS branch.
      if (invoice.status === 'paid' || invoice.status === 'prepaid') alreadyPaid = true;
      else invoiceCreated = true;
    }

    // A live annual-prepay-COVERED visit must never carry a collectible invoice for
    // the covered work: it's already paid on the annual prepay invoice. The
    // suppression gate stops NEW invoices; a pre-existing / pre-minted invoice with NO
    // add-ons is SETTLED here as non-cash annual-prepay coverage → 'prepaid'
    // (non-collectible, no pay link, books no payments row → no revenue double-count).
    // An invoice WITH add-ons (or applied account credit) is VOIDED for now — same as
    // before this PR, money-safe (no double-bill), but it drops the add-on AR until
    // the base-covered / add-ons-collectible SPLIT ships as the fast-follow. Fails
    // closed: a cash-paid / in-flight invoice is left for normal handling.
    if (annualPrepayCovered && invoice?.id
      && !['paid', 'prepaid', 'void'].includes(String(invoice.status || '').toLowerCase())) {
      try {
        const InvoiceService = require('../services/invoice');
        // Named settleRes, NOT res — `res` here would shadow the Express response
        // for the rest of this block (the isOutboundCall TDZ-shadow failure class).
        const settleRes = await InvoiceService.settleInvoiceAsAnnualPrepayCovered(
          invoice.id, svc.annual_prepay_term_id, { recordedBy: 'system:annual_prepay_completion' },
        );
        if (settleRes.settled) {
          // Fully covered → settled non-cash 'prepaid' (invoice + service record kept,
          // no revenue double-count) — non-collectible, no pay link.
          invoice = settleRes.invoice;
          invoiceCreated = false;
          payUrl = null;
          alreadyPaid = true;
        } else if (['has_add_ons', 'has_applied_credit', 'has_deposit_credit'].includes(settleRes.reason)) {
          // Covered visit whose invoice can't be plain-settled here (positive extras, or
          // applied account/deposit credit that voidInvoice must restore): fall back to
          // the pre-split void (money-safe — voidInvoice restores any credit + cancels
          // the PI; the extras-collectible split is the fast-follow). No double-bill.
          await InvoiceService.voidInvoice(invoice.id);
          invoice = null;
          invoiceCreated = false;
          payUrl = null;
          alreadyPaid = true;
        }
        // else (payer_billed / already_settled / processing): leave for normal handling.
      } catch (settleErr) {
        logger.warn(`[dispatch] annual-prepay covered visit ${svc.id}: could not settle pre-existing invoice ${invoice.id}: ${settleErr.message}`);
      }
    }

    // Auto-apply available account credit (e.g. the referral reward) to the
    // residual collectible bill — runs for BOTH the freshly-created (shouldInvoice)
    // and pre-minted completion-invoice paths, AFTER annual-prepay allocation, and
    // only when the customer still owes a collectible invoice (not paid/prepaid,
    // not payer-billed). Applies PARTIAL credit (the charge/verify paths now price
    // amount due), reducing what the customer pays; fully-covered → prepaid. The
    // helper also fail-closes on a live PaymentIntent. Gated + best-effort.
    if (invoice?.id && !alreadyPaid && !invoice.payer_id
      && !['paid', 'prepaid'].includes(String(invoice.status || '').toLowerCase())
      && require('../config/feature-gates').gates.autoApplyAccountCredit) {
      try {
        const { applyAccountCreditToInvoice } = require('../services/customer-credit');
        const creditResult = await applyAccountCreditToInvoice({ invoiceId: invoice.id });
        if (creditResult?.applied > 0) {
          const fresh = await db('invoices').where({ id: invoice.id })
            .first('status', 'credit_applied', 'prepaid_at', 'prepaid_by', 'prepaid_prev_status', 'paid_at');
          if (fresh) invoice = { ...invoice, ...fresh };
          if (invoice.status === 'prepaid') { alreadyPaid = true; invoiceCreated = false; }
        }
      } catch (creditErr) {
        logger.warn(`[referral] account-credit auto-apply failed for invoice=${invoice?.id}: ${creditErr.message}`);
      }
    }

    // Per-application autopay collection (owner ruling 2026-07-09): a
    // billing_mode='per_application' customer's visit bill auto-charges their
    // saved default autopay CARD via chargeInvoiceWithSavedCard — the same
    // surcharge/tax/ledger/receipt rail the card-on-file flows use (single
    // surcharge authority, invoice-locked against double collection). Runs
    // AFTER account credit (charges the reduced residual), only on a
    // collectible self-pay invoice, and only for a card method — an ACH
    // default keeps the pay-link flow (chargeInvoiceWithSavedCard is
    // card-only). Failure is non-blocking by design: the invoice stays open
    // and the completion SMS carries the pay link exactly as before, so the
    // customer experience degrades to manual pay — never a blocked completion
    // and never a double charge (the helper fail-closes on a live
    // PaymentIntent). On success the SMS branch flips to receipt (no pay
    // link), mirroring the card-hold convention below.
    if (perApplicationBilling && invoice?.id && !alreadyPaid && !invoice.payer_id
      && !['paid', 'prepaid', 'void', 'processing'].includes(String(invoice.status || '').toLowerCase())
      && customerAutopayActive) {
      try {
        const { getChargeableAutopayMethod, isChargeableAutopayMethod } = require('../services/autopay-eligibility');
        const autopayPm = await getChargeableAutopayMethod({ id: svc.customer_id }, db);
        if (isChargeableAutopayMethod(autopayPm) && autopayPm.method_type === 'card') {
          const StripeService = require('../services/stripe');
          await StripeService.chargeInvoiceWithSavedCard(invoice.id, autopayPm.id);
          const fresh = await db('invoices').where({ id: invoice.id }).first();
          if (fresh) invoice = fresh;
          if (['paid', 'prepaid'].includes(String(invoice.status || '').toLowerCase())) {
            alreadyPaid = true;
            invoiceCreated = false;
            payUrl = null;
            try {
              await require('../services/autopay-log').logAutopay(svc.customer_id, 'charge_success', {
                details: { source: 'per_application_completion', invoice_id: invoice.id, scheduled_service_id: svc.id },
              });
            } catch (e) { /* log-only */ }
          }
        }
      } catch (chargeErr) {
        if (chargeErr.code === 'STRIPE_CHARGED_DB_FAILED') {
          // Stripe COLLECTED the money but the DB write failed — already
          // recorded in stripe_orphan_charges for manual reconciliation.
          // The invoice still reads open locally, so the normal fallback
          // (pay-link SMS) would invite the customer to pay the SAME visit
          // again. Mirror the card-hold convention: suppress the pay link /
          // charge actions and leave the reconciliation to the orphan
          // ledger — never re-collectible from this completion (Codex P1).
          invoiceCreated = false;
          payUrl = null;
          // Suppressing THIS pay link isn't enough: the invoice would stay
          // open, so /api/billing/balance and any later pay surface still
          // offer it for payment (Codex round-3). Park it as 'processing' —
          // the established money-in-flight status: excluded from balance
          // sums (INVOICE_UNCOLLECTIBLE_STATUSES), pay routes 409 it,
          // assertInvoiceCollectible refuses manual/auto collection. The
          // PI's payment_intent.succeeded webhook still resolves the invoice
          // via metadata waves_invoice_id (findInvoiceForPaymentIntent) and
          // settles processing→paid — the designed ACH-style self-heal; if
          // that write fails too, the stripe_orphan_charges row is the
          // operator's reconcile queue. Best-effort: if parking fails, the
          // loud error below still flags the invoice id.
          try {
            await db('invoices').where({ id: invoice.id }).update({ status: 'processing', updated_at: new Date() });
            invoice = { ...invoice, status: 'processing' };
          } catch (parkErr) {
            logger.error(`[dispatch] failed to park orphaned invoice ${invoice?.id} as processing: ${parkErr.message}`);
          }
          logger.error(`[dispatch] per-application autopay charge ORPHANED for invoice ${invoice?.id} (PI ${chargeErr.stripePaymentIntentId || 'unknown'}) — pay link suppressed, invoice parked 'processing', see stripe_orphan_charges`);
        } else {
          logger.warn(`[dispatch] per-application autopay charge failed for invoice ${invoice?.id} (falls back to pay link): ${chargeErr.message}`);
        }
        try {
          await require('../services/autopay-log').logAutopay(svc.customer_id, 'charge_failed', {
            details: { source: 'per_application_completion', invoice_id: invoice?.id, scheduled_service_id: svc.id, orphaned: chargeErr.code === 'STRIPE_CHARGED_DB_FAILED', error: String(chargeErr.message || '').slice(0, 300) },
          });
        } catch (e) { /* log-only */ }
      }
    }

    // One-time card-on-file hold: resolve the hold on completion (dark until
    // ONE_TIME_CARD_HOLD; no-op when no hold exists). chargeCardHoldOnCompletion
    // CHARGES the residual when the invoice is collectible, or RELEASES the hold
    // when it's already settled (prepaid / account credit) or payer-billed — so
    // it's called whenever an invoice exists, even if alreadyPaid/payer, to
    // avoid leaving a completed job's hold stuck in 'held'. On a real charge it
    // marks the invoice already-paid so the completion SMS sends a receipt, not
    // a pay link. Best-effort — never blocks completion.
    if (invoice?.id) {
      try {
        const CardHolds = require('../services/estimate-card-holds');
        const holdCharge = await CardHolds.chargeCardHoldOnCompletion({ scheduledServiceId: svc.id, invoiceId: invoice.id });
        // covered_by_credit means the charge call found the invoice already
        // settled by account credit (marked prepaid, hold released) — treat it
        // the same as a paid completion so we don't send a pay-link SMS.
        if (holdCharge?.charged || holdCharge?.reason === 'covered_by_credit') {
          alreadyPaid = true;
          invoiceCreated = false;
          const fresh = await db('invoices').where({ id: invoice.id }).first('status', 'paid_at');
          if (fresh) invoice = { ...invoice, ...fresh };
        }
      } catch (e) { logger.error(`[admin-dispatch] completion card-hold charge failed: ${e.message}`); }
    }

    // Immediate/legacy review requests can be bundled into the completion SMS.
    // Explicit delayed timing skips the bundle and schedules a separate review
    // request below.
    const invoiceBlocksReview = !recapReviewOnly && !!invoice && invoice.status !== 'paid' && invoice.status !== 'prepaid';
    const clientSuppressionBlocksReview = reviewSuppression && reviewSuppression !== 'invoice_created';
    const effectiveRequestReview = !!requestReview && !clientSuppressionBlocksReview && !invoiceBlocksReview
      && !suppressTypedCustomerComms;
    // NOTE: includePayLink (the "report only, no pay link" operator choice) is
    // deliberately NOT folded in here. suppressCompletionInvoiceLink also drives
    // invoicePaymentActionRequired (the mobile in-person payment sheet), so
    // suppressing it would strand a newly created unpaid invoice with no
    // collection path when no SMS actually goes out (no phone / already handled).
    // includePayLink is an SMS-only concern and is applied to
    // allowCompletionInvoiceLink below instead.
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
    // The pest-recap path (services/pest-recap.js) writes its own
    // service_records row and claims recap_sms_sent_at when it texts the
    // customer. That recap text and this completion SMS are two wordings of
    // the same "service done" message — if a recap already texted this
    // visit, sending the templated completion SMS double-texts the customer.
    // The recap row is a SIBLING of `record` (each path inserts its own row
    // keyed by scheduled_service_id), so the structured_notes check above
    // can't see it.
    let recapSmsAlreadySentForVisit = false;
    if (!completionSmsAlreadyHandled && serviceRecordCols.recap_sms_sent_at) {
      try {
        const readRecapClaim = () => db('service_records')
          .where({ scheduled_service_id: svc.id })
          .whereNotNull('recap_sms_sent_at')
          .first('id', 'recap_sms_sent_at');
        let recapTexted = await readRecapClaim();
        // pest-recap claims recap_sms_sent_at BEFORE its send and releases
        // the claim if the send fails, so a seconds-old claim may still be
        // in flight. Suppressing on an in-flight claim whose send then
        // fails would leave the customer with no text from either path —
        // so for a fresh claim, wait briefly and re-read. A released claim
        // means the recap failed and this completion SMS should proceed; a
        // claim that survives the recheck is a delivered recap (success
        // never releases it). Claims older than the window are durable.
        //
        // ACCEPTED RESIDUAL (decided on PR #1627): a recap send that takes
        // longer than this ~6s recheck AND then fails will release its
        // claim after we've already skipped — the customer gets no
        // completion text from either path. This requires /complete to
        // race the recap by seconds AND a slow provider failure; when it
        // happens the recap submitter sees the smsError in the recap
        // modal and re-sending from there works (the claim was released).
        // We deliberately prefer this rare, operator-visible miss over
        // double-texting (the original customer complaint) and over
        // stalling the Complete button to wait out the provider timeout.
        const recapClaimAgeMs = recapTexted
          ? Date.now() - new Date(recapTexted.recap_sms_sent_at).getTime()
          : Infinity;
        if (recapTexted && recapClaimAgeMs < 60 * 1000) {
          for (let attempt = 0; attempt < 2 && recapTexted; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 3000));
            recapTexted = await readRecapClaim();
          }
        }
        recapSmsAlreadySentForVisit = !!recapTexted;
      } catch (e) {
        logger.warn(`[dispatch] recap SMS claim lookup failed for service ${svc.id}: ${e.message}`);
      }
    }

    const shouldBundleReview =
      effectiveSendCompletionSms &&
      !completionSmsAlreadyHandled &&
      !recapSmsAlreadySentForVisit &&
      effectiveRequestReview &&
      svc.cust_phone &&
      !serviceReportV1Delivery &&
      (completionReviewDelayMinutes === undefined || completionReviewDelayMinutes === 0);

    let bundledReviewUrl = null;
    let bundledReviewRequestId = null;
    if (shouldBundleReview) {
      try {
        const ReviewService = require('../services/review-request');
        const inlineReview = await ReviewService.createInline({
          customerId: svc.customer_id,
          serviceRecordId: record.id,
        });
        if (typeof inlineReview === 'string') {
          bundledReviewUrl = inlineReview;
        } else if (inlineReview) {
          bundledReviewUrl = inlineReview.url || null;
          bundledReviewRequestId = inlineReview.requestId || null;
        }
      } catch (e) { logger.error(`[dispatch] Inline review mint failed: ${e.message}`); }
    }
    const markBundledReviewDelivered = async () => {
      if (!bundledReviewRequestId) return;
      try {
        const ReviewService = require('../services/review-request');
        await ReviewService.markInlineDelivered(bundledReviewRequestId);
      } catch (e) {
        logger.warn(`[dispatch] Inline review delivery mark failed for ${bundledReviewRequestId}: ${e.message}`);
      }
    };
    const bundledReviewRetryAt = (sendResult = {}) => {
      const explicit = sendResult.nextAllowedAt ? new Date(sendResult.nextAllowedAt) : null;
      if (explicit && !Number.isNaN(explicit.getTime())) return explicit;
      const delayMinutes = completionReviewDelayMinutes === undefined
        ? 120
        : Math.max(5, Number(completionReviewDelayMinutes) || 5);
      return new Date(Date.now() + delayMinutes * 60000);
    };
    const markBundledReviewFailed = async (sendResult = {}) => {
      if (!bundledReviewRequestId) return;
      try {
        const ReviewService = require('../services/review-request');
        const terminalPolicyBlock = sendResult.blocked &&
          sendResult.code !== 'CONSENT_LOOKUP_FAILED' &&
          !sendResult.retryable &&
          !sendResult.deferred;
        const terminalProviderFailure = sendResult.terminal === true ||
          (!sendResult.blocked &&
            sendResult.sent === false &&
            sendResult.code === 'PROVIDER_FAILURE' &&
            sendResult.retryable === false);
        if (
          terminalPolicyBlock ||
          terminalProviderFailure
        ) {
          await ReviewService.markInlineDeliveryFailed(bundledReviewRequestId);
        } else {
          await ReviewService.markInlineRetryable(bundledReviewRequestId, bundledReviewRetryAt(sendResult));
        }
      } catch (e) {
        logger.warn(`[dispatch] Inline review failure mark failed for ${bundledReviewRequestId}: ${e.message}`);
      }
    };
    const reviewSuffix = bundledReviewUrl
      ? `\n\nEnjoyed the service? A quick review means the world: ${bundledReviewUrl}`
      : '';

    if (effectiveSendCompletionSms && svc.cust_phone && !completionSmsAlreadyHandled && !recapSmsAlreadySentForVisit) {
      try {
        const displayServiceType = normalizeServiceTypeForTemplate(svc.service_type);
        // Use the recap STORED on the record (the server-generated effectiveCustomerRecap,
        // or a resumed completion's persisted value) — the client no longer sends
        // customerRecap, so reading the request field would drop the recap here.
        const recapText = (recordStructuredNotes.customerRecap || customerRecap || '').trim();
        let sentSmsBody = null;
        let completionSmsWasTruncated = false;
        let sentSmsType = null;
        // includePayLink === false omits the pay link from the completion SMS
        // (e.g. customer paid in person) — report-only. This is scoped to the
        // SMS body only; the mobile in-person payment sheet
        // (invoicePaymentActionRequired) is intentionally left untouched so an
        // unpaid invoice always keeps a collection path.
        const allowCompletionInvoiceLink = !suppressCompletionInvoiceLink
          && includePayLink !== false
          && !prepaidCovered
          && !alreadyPaid
          && !autopayCoversVisit
          // Third-party Bill-To: never text the homeowner the pay link for a
          // payer-billed invoice — AR routes to the payer's AP inbox. The
          // homeowner still gets the report-only completion SMS (no pay_url).
          && !invoice?.payer_id;
        const usePaidCompletionTemplate = alreadyPaid
          || prepaidCovered
          || autopayCoversVisit
          || ['paid', 'prepaid'].includes(String(invoice?.status || '').toLowerCase());
        // Lawn Report V2 write-gate: freeze the synthesis onto the record (single
        // source of truth) and run the consistency check, so the SMS below leads with
        // the same line as the report. Best-effort; never blocks completion.
        let lawnReportSmsSummary = null;
        if (serviceReportV1Delivery && typedDeliveryMode === 'auto_send' && process.env.LAWN_REPORT_V2 === 'true') {
          try {
            const { finalizeLawnReportSynthesis } = require('../services/service-report/lawn-report-write-gate');
            const gate = await finalizeLawnReportSynthesis({ service: record, knex: db });
            lawnReportSmsSummary = gate.smsSummary || null;
            // recordStructuredNotes was parsed BEFORE the gate wrote structured_notes.lawnReportV2;
            // fold the frozen synthesis back in so the later sending/sent writes (which
            // spread recordStructuredNotes) don't clobber it.
            if (gate.frozen) recordStructuredNotes.lawnReportV2 = gate.frozen;
          } catch { /* best-effort — render-time reconciliation still applies */ }
        }
        const serviceReportV1SmsContext = serviceReportV1Delivery
          ? buildServiceReportV1DeliveryContext({
            record,
            service: svc,
            reportUrl,
            smsReportUrl: reportSmsUrl,
            payUrl: invoiceCreated && payUrl && allowCompletionInvoiceLink ? payUrl : null,
            summaryLine: lawnReportSmsSummary,
          })
          : null;
        if (serviceReportV1SmsContext?.enabled && !invoiceCreated && !usePaidCompletionTemplate) {
          sentSmsType = serviceReportV1SmsContext.smsType;
          // The DB service_report_v1 template carries no {summary_line}; when the
          // write-gate froze a V2 lead, send the prebuilt body (which leads with that
          // synthesis) so the customer sees it instead of the generic "report is
          // ready" line. Otherwise keep the editable DB template.
          let body;
          if (lawnReportSmsSummary && serviceReportV1SmsContext.body) {
            body = serviceReportV1SmsContext.body;
          } else {
            body = await renderTemplate(sentSmsType, serviceReportV1SmsContext.vars, {
              workflow: 'dispatch_service_complete',
              entity_type: 'service_record',
              entity_id: record.id,
            });
          }
          // A toggled-off or removed variant must not cost the customer
          // their completion text — fall back to the base report template
          // before giving up (owner report 2026-07-06: the since-removed
          // progress variant was inactive and progress visits would have
          // texted nothing).
          if (!body && sentSmsType !== 'service_report_v1') {
            sentSmsType = 'service_report_v1';
            body = await renderTemplate(sentSmsType, serviceReportV1SmsContext.vars, {
              workflow: 'dispatch_service_complete',
              entity_type: 'service_record',
              entity_id: record.id,
            });
          }
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
              // The service_complete_concise overflow swap was removed
              // 2026-07-06 (owner call) — a long completion text now sends at
              // full length; composeCompletionSmsBody still trims only the
              // recap line to keep the report link intact.
              ({ body: sentSmsBody, truncated: completionSmsWasTruncated } = composeCompletionSmsBody({
                recapText,
                body,
                suffix: reviewSuffix,
              }));
            }
          }
        }
        // Lawn health score consolidation: fold the confirmed assessment's
        // score (and tip) into the SAME completion report text instead of
        // sending a separate "lawn health report ready" SMS at confirm time.
        // Branch-agnostic — applies to whichever completion template was
        // chosen above. Best-effort; a failure here must never block the send.
        if (sentSmsBody && !isIncompleteVisit && completedLawnAssessmentId) {
          try {
            const LawnIntel = require('../services/lawn-intelligence');
            const scoreParts = await LawnIntel.buildCompletionScoreBlock(completedLawnAssessmentId);
            if (scoreParts?.scoreLine) {
              const folded = foldLawnScoreIntoCompletionSms(sentSmsBody, scoreParts, { maxSegments: 2 });
              if (folded.folded) {
                sentSmsBody = folded.body;
                if (folded.truncated) completionSmsWasTruncated = true;
              } else {
                logger.info(`[dispatch] lawn score fold-in skipped for ${record.id} (segment budget)`);
              }
            }
          } catch (scoreErr) {
            logger.warn(`[dispatch] lawn score fold-in failed for ${record.id}: ${scoreErr.message}`);
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
            ...(bundledReviewRequestId ? {
              completionSmsBundledReviewRequestId: bundledReviewRequestId,
              completionSmsBundledReviewUrl: bundledReviewUrl,
            } : {}),
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
            await markBundledReviewFailed(smsResult);
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
            if (!bundledReviewUrl || sentSmsBody.includes(bundledReviewUrl)) {
              await markBundledReviewDelivered();
            } else {
              await markBundledReviewFailed();
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
        await markBundledReviewFailed();
        logger.error(`Completion SMS failed: ${e.message}`);
      }
    } else if (effectiveSendCompletionSms && svc.cust_phone && recapSmsAlreadySentForVisit) {
      // Record the skip in structured_notes so the audit trail (and the
      // completionSmsStatus surfaced in the response) shows WHY no
      // completion SMS went out for a visit that asked for one.
      const skippedNotes = {
        ...recordStructuredNotes,
        completionSmsStatus: 'skipped_recap_sms_already_sent',
        completionSmsSkippedAt: new Date().toISOString(),
      };
      await db('service_records').where({ id: record.id }).update({
        structured_notes: serializeJsonb(skippedNotes),
      }).catch((updateErr) => logger.warn(`[dispatch] completion SMS skip status update failed: ${updateErr.message}`));
      record.structured_notes = skippedNotes;
      logger.info(`[dispatch] Recap SMS already texted for service ${svc.id}; skipping completion SMS to avoid double-texting`);
    } else if (effectiveSendCompletionSms && svc.cust_phone && completionSmsAlreadyHandled) {
      const bundledReviewId = recordStructuredNotes.completionSmsBundledReviewRequestId || null;
      const bundledReviewUrlFromNotes = recordStructuredNotes.completionSmsBundledReviewUrl || null;
      const sentBody = String(recordStructuredNotes.sentSmsBody || '');
      if (
        recordStructuredNotes.completionSmsStatus === 'sent' &&
        bundledReviewId &&
        bundledReviewUrlFromNotes &&
        sentBody.includes(bundledReviewUrlFromNotes)
      ) {
        try {
          const ReviewService = require('../services/review-request');
          await ReviewService.markInlineDelivered(bundledReviewId);
        } catch (e) {
          logger.warn(`[dispatch] Inline review delivery repair failed for ${bundledReviewId}: ${e.message}`);
        }
      }
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
    // Email delivery is gated independently of the completion-SMS toggle (see
    // serviceReportEmailEligible) so email-only customers still get the report.
    if (serviceReportEmailEligible({ serviceReportV1Delivery, suppressTypedCustomerComms }) && !serviceReportEmailEnabled) {
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

    if (serviceReportEmailEligible({ serviceReportV1Delivery, suppressTypedCustomerComms }) && serviceReportEmailEnabled) {
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

    // Follow-up suggestion for typed completions (profiles followup_policy /
    // default_followup_days). Cockroach only suggests for German — matched on
    // the canonical registry option value, never display-label text.
    let followupSuggestion = null;
    if (typedFindingsType && typedFindings && !isIncompleteVisit) {
      followupSuggestion = projectFollowupSuggestion({
        scheduledService: svc,
        project: {},
        profile: completionProfile,
      });
      if (followupSuggestion?.required && typedFindingsType === 'cockroach'
        && String(typedFindings.values?.species || '') !== 'German') {
        followupSuggestion = { ...followupSuggestion, required: false, reason: 'species_not_german' };
      }
      // German knockdown: the tech's explicit follow-up selection wins over
      // the profile's standing ALERT policy — a "No" must not leave the
      // success overlay demanding a follow-up the customer report says is
      // not needed, and the selected window drives the suggested date so
      // the CTA can never book a date the report copy contradicts (Codex
      // P2 rounds 3–4).
      if (followupSuggestion?.required && typedFindingsType === 'german_roach_knockdown') {
        if (String(typedFindings.values?.followup_required || '') === 'No') {
          followupSuggestion = { ...followupSuggestion, required: false, reason: 'tech_marked_not_required' };
        } else {
          const windowDays = KNOCKDOWN_FOLLOWUP_WINDOW_DAYS[String(typedFindings.values?.followup_window || '')];
          if (windowDays && windowDays !== followupSuggestion.days) {
            followupSuggestion = projectFollowupSuggestion({
              scheduledService: svc,
              project: {},
              profile: { ...completionProfile, followupPolicy: 'alert', defaultFollowupDays: windowDays },
            });
          }
        }
      }
      // Palmetto knockdown: the profile policy is 'none', but when the
      // checklist says a follow-up IS needed the overlay must offer the
      // scheduling CTA — same 14-day default interval as German.
      if (typedFindingsType === 'palmetto_roach_knockdown'
        && String(typedFindings.values?.followup_needed || '') === 'Yes'
        && !followupSuggestion?.required) {
        followupSuggestion = {
          ...projectFollowupSuggestion({
            scheduledService: svc,
            project: {},
            profile: { ...completionProfile, followupPolicy: 'alert', defaultFollowupDays: completionProfile?.defaultFollowupDays ?? 14 },
          }),
          reason: 'tech_marked_needed',
        };
      }
    }

    // Third-party Bill-To: a payer-billed auto-invoice is intentionally NOT
    // carried by the homeowner completion SMS (pay link suppressed) and is never
    // collected in person, so the homeowner channel can't finalize it. Route it
    // to the payer's AP inbox here and finalize on success — otherwise the
    // third-party AR is silently stranded as an unsent draft. A payer with no
    // usable AP email leaves the invoice unfinalized for operator correction
    // (sendInvoiceEmail returns ok:false rather than mailing the homeowner).
    // Only deliver to the payer when this invoice hasn't already been sent —
    // `invoiceCreated` is also true when a completion REUSES an existing unpaid
    // invoice (a pre-minted invoice already `sent`/`viewed`, or a request where
    // invoiceAlreadySent suppressed the homeowner link). Re-sending would
    // duplicate the AP billing email. Fresh completion invoices are `draft`.
    const payerInvoiceAlreadyDelivered = !!invoiceAlreadySent
      || ['sent', 'viewed', 'overdue', 'paid', 'prepaid', 'processing', 'void', 'refunded', 'canceled', 'cancelled']
        .includes(String(invoice?.status || '').toLowerCase());
    if (invoice?.id && invoiceCreated && invoice.payer_id && !payerInvoiceAlreadyDelivered) {
      try {
        const InvoiceEmail = require('../services/invoice-email');
        const payerSend = await InvoiceEmail.sendInvoiceEmail(invoice.id);
        if (payerSend?.ok) {
          const InvoiceService = require('../services/invoice');
          invoice = await InvoiceService.markDeliverySent(invoice.id, {
            email: true,
            source: 'dispatch_completion_payer',
          });
        } else {
          logger.warn(`[dispatch] Payer invoice ${invoice.id} not delivered to AP (${payerSend?.error || 'unknown'}) — left unfinalized for operator correction`);
        }
      } catch (payerSendErr) {
        logger.error(`[dispatch] Payer invoice AP send failed for ${invoice.id}: ${payerSendErr.message}`);
      }
    }

    const finalRecordNotes = parseJsonObject(record.structured_notes);
    const completionSmsStatus = finalRecordNotes.completionSmsStatus
      || (suppressTypedCustomerComms && sendCompletionSms
        ? 'suppressed_delivery_mode'
        : (sendCompletionSms ? (svc.cust_phone ? 'not_sent' : 'no_phone') : 'not_requested'));
    const completionSmsType = finalRecordNotes.completionSmsType || finalRecordNotes.sentSmsType || null;
    // A freshly created, unpaid completion invoice needs an in-person collection
    // path (the mobile payment sheet) whenever it isn't covered by
    // prepay/autopay/already-paid and the link wasn't already sent. This must NOT
    // be gated on the SMS template: with includePayLink=false the report-only
    // 'service_complete' template is sent ALONGSIDE an unpaid invoice, so the
    // old `completionSmsType !== 'service_complete'` exclusion (a pre-PR proxy
    // for "no-bill completion", redundant with the !!invoice/suppress checks)
    // would strand that invoice with neither a pay link nor an in-person prompt.
    const invoicePaymentActionRequired = !!invoice
      && invoice.status !== 'paid'
      && !prepaidCovered
      && !alreadyPaid
      && !autopayCoversVisit
      && !suppressCompletionInvoiceLink
      // Third-party Bill-To: never open the in-person payment sheet for a
      // payer-billed invoice — the tech must not collect the AP's invoice from
      // the service recipient. AR routes to the payer AP inbox.
      && !invoice.payer_id;
    // Referral reward: if this customer was referred and just completed their
    // FIRST recurring service, credit both the referrer and the referee $25 to
    // their account. Only a genuinely PERFORMED visit qualifies — an
    // inspection-only, customer-declined, or incomplete outcome must not earn
    // the reward or burn the single-use guard. The helper re-confirms THIS
    // visit is recurring + handles idempotency itself; never blocks completion.
    const referralVisitPerformed = visitOutcome !== 'inspection_only'
      && visitOutcome !== 'customer_declined'
      && !isIncompleteVisit;
    if (referralVisitPerformed) {
      try {
        const referralEngine = require('../services/referral-engine');
        await referralEngine.creditReferralOnFirstService({ customerId: svc.customer_id, serviceId: svc.id });
      } catch (referralErr) {
        logger.warn(`[referral] first-service credit failed for customer=${svc?.customer_id}: ${referralErr.message}`);
      }
      // Same closed-deal signal as the referral credit above, and gated by the
      // same performed-visit guard: convert the originating lead to won if it's
      // still open. Best-effort + idempotent; only matches never-converted leads.
      try {
        const { convertLeadFromEvent } = require('../services/lead-estimate-link');
        await convertLeadFromEvent({ source: 'service_completed', customerId: svc.customer_id });
      } catch (leadErr) {
        logger.warn(`[lead-trigger] first-service conversion failed for customer=${svc?.customer_id}: ${leadErr.message}`);
      }
    }

    const responsePayload = {
      success: true,
      serviceRecordId: record.id,
      invoiceId: invoice?.id || null,
      // Amount DUE (total − applied account credit) so the mobile payment sheet
      // collects/validates what Stripe/Terminal actually charge, not the pre-credit total.
      invoiceTotal: invoice?.total != null ? require('../services/invoice-helpers').invoiceAmountDue(invoice) : null,
      // Third-party Bill-To: never hand back the payer invoice's pay token — it
      // is the AP's bearer pay link (/api/pay/:token); a cached/mobile client or
      // the tech holding this response could open it and collect the AP's bill
      // from the service recipient. Keep id/status/total for display only.
      // (mirrors the track-public.js token suppression)
      invoiceToken: invoice && !invoice.payer_id ? (invoice.token || null) : null,
      invoiceStatus: invoice?.status || null,
      reportUrl,
      invoicePaymentActionRequired,
      completionSmsStatus,
      completionSmsError: finalRecordNotes.completionSmsError || null,
      completionSmsType,
      completionSmsTruncated: !!finalRecordNotes.completionSmsTruncated,
      completionPhotoUpload: completionPhotoUploadResult,
      ...(typedFindingsType ? {
        typedFindingsType,
        typedDeliveryMode,
        followupSuggestion,
      } : {}),
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
  // Conflict: pest-control gate, a cancelled/skipped visit that can't be
  // recapped, or a stale recap against a job rescheduled to a future day.
  if (reason === 'not_pest_control' || reason === 'service_cancelled' || reason === 'service_skipped'
    || reason === 'future_scheduled_date') return 409;
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
// TYPED FINDINGS — AI RECOMMENDATIONS DRAFT
// =========================================================================
// POST /:serviceId/findings-recap/draft — AI-draft the OPTIONAL
// customer-facing recommendations paragraph for a typed specialty
// completion from the structured findings + next-step chips (and, when
// asked, recent customer comms). Same auth surface + per-tech ownership
// guard as the pest-recap draft above. This endpoint is polish only —
// completion never waits on it, and any failure here is a non-blocking
// 4xx/5xx the client surfaces inline and ignores.
const MODELS = require('../config/models');

// Compact recent-comms context (last few calls/texts/emails), modeled on
// admin-projects' ai-write communication loader. Each source is
// best-effort — a missing table never fails the draft.
async function loadFindingsRecapCommsContext(customerId) {
  if (!customerId) return '';
  const compact = (value, max = 280) => {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return text.length > max ? `${text.slice(0, max - 3).trim()}...` : text;
  };
  const dateOf = (value) => {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  };
  const tsOf = (value) => {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? 0 : d.getTime();
  };
  const [calls, sms, emails] = await Promise.all([
    db('call_log')
      .where({ customer_id: customerId })
      .select('created_at', 'direction', 'call_outcome', 'lead_synopsis', 'transcription', 'notes')
      .orderBy('created_at', 'desc')
      .limit(3)
      .catch(() => []),
    db('sms_log')
      .where({ customer_id: customerId })
      .select('created_at', 'direction', 'message_body')
      .orderBy('created_at', 'desc')
      .limit(4)
      .catch(() => []),
    db('emails')
      .where({ customer_id: customerId })
      .select('received_at', 'subject', 'snippet', 'body_text')
      .orderBy('received_at', 'desc')
      .limit(3)
      .catch(() => []),
  ]);
  const entries = [];
  for (const call of calls) {
    const summary = compact(call.lead_synopsis || call.notes || call.transcription);
    if (summary) entries.push({ ts: tsOf(call.created_at), line: `Call ${dateOf(call.created_at)} (${call.direction || 'unknown'}${call.call_outcome ? `, ${call.call_outcome}` : ''}): ${summary}` });
  }
  for (const msg of sms) {
    const summary = compact(msg.message_body);
    if (summary) entries.push({ ts: tsOf(msg.created_at), line: `Text ${dateOf(msg.created_at)} (${msg.direction || 'unknown'}): ${summary}` });
  }
  for (const email of emails) {
    const summary = compact(email.snippet || email.body_text);
    const subject = compact(email.subject, 120);
    if (summary || subject) entries.push({ ts: tsOf(email.received_at), line: `Email ${dateOf(email.received_at)}${subject ? ` "${subject}"` : ''}: ${summary || '[no body preview]'}` });
  }
  return entries
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 6)
    .map((entry) => entry.line)
    .join('\n');
}

function buildFindingsRecapPrompt({ schema, values, chips, serviceType, commsContext }) {
  const fieldLines = (schema.fields || [])
    .map((field) => {
      const value = values?.[field.key];
      if (value == null || String(value).trim() === '') return null;
      return `${field.label}: ${String(value).trim()}`;
    })
    .filter(Boolean);
  return `Write a short customer-facing "recommendations" paragraph (2-4 sentences) for a Waves Pest Control & Lawn Care service report.

Rules:
- Plain, friendly, professional language. Plain text only — no markdown, headings, greeting, or sign-off.
- Wording must be observation-scoped: describe only what was observed and done today (e.g. "No active signs observed today"). Never claim the problem is permanently fixed.
- NEVER use any of these words/phrases: "clear", "cleared", "gone", "eliminated", "no infestation", "guaranteed", "resolved".
- Never mention chemical product names, application rates, prices, or EPA details.
- Base the recommendations on the findings and selected next steps below. Do not invent findings.

Service type: ${serviceType || schema.label}
Findings type: ${schema.label}
Findings:
${fieldLines.length ? fieldLines.join('\n') : '[none recorded]'}
Next steps selected: ${Array.isArray(chips) && chips.length ? chips.join(', ') : '[none]'}
Recent customer communications:
${commsContext || '[not provided]'}

Return only the paragraph text.`;
}

// POST /:serviceId/schedule-followup — book the suggested follow-up visit
// for a typed specialty completion as a PENDING appointment (the normal
// pending → confirmed dispatch flow is the admin confirmation step, so the
// full scheduling validation stack isn't duplicated here). Idempotent per
// source visit via followup_source_service_id — a retried CTA tap returns
// the existing booking. The appointment is $0 + followup_included, which the
// typed completion billing pre-gate bypasses (included program visit).
router.post('/:serviceId/schedule-followup', async (req, res, next) => {
  try {
    if (!(await assertRecapOwnership(req, res))) return;
    const { date, windowStart = null, windowEnd = null, technicianId = null } = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
      return res.status(400).json({ error: 'date (YYYY-MM-DD) is required', code: 'followup_date_invalid' });
    }
    if (String(date) < etDateString()) {
      return res.status(400).json({ error: 'Follow-up date must be today or later', code: 'followup_date_past' });
    }

    const svc = await db('scheduled_services').where({ id: req.params.serviceId }).first();
    if (!svc) return res.status(404).json({ error: 'Service not found' });

    const profile = await resolveCompletionProfileForScheduledService(svc).catch(() => null);
    if (!profile?.findingsType) {
      return res.status(409).json({
        error: 'Follow-up booking from completion is only available for typed specialty services.',
        code: 'followup_not_typed',
      });
    }

    // This is the server-side gate for the completion CTA, not a generic
    // booking API — the source visit must be completed and its persisted
    // completion must actually call for a follow-up (mirrors the /complete
    // followupSuggestion logic, incl. the cockroach German-only rule on the
    // stored snapshot). A stale or crafted POST can't mint included $0
    // appointments for visits that never owed one (Codex P2).
    if (svc.status !== 'completed') {
      return res.status(409).json({
        error: 'Follow-ups can only be booked from a completed visit.',
        code: 'followup_source_not_completed',
      });
    }
    // The completion must have actually run the typed flow: after cutover a
    // service's older completions have no typed snapshot — they never earned
    // the CTA, so they can't mint an included $0 follow-up (Codex P2). The
    // snapshot type must match the profile that owes the follow-up.
    const sourceRecord = await db('service_records')
      .where({ scheduled_service_id: svc.id })
      .orderBy('created_at', 'desc')
      .first()
      .catch(() => null);
    const snapshot = parseJsonObject(sourceRecord?.service_data)?.typedReportSnapshot;
    if (!snapshot || String(snapshot.type || '') !== String(profile.findingsType)) {
      return res.status(409).json({
        error: 'This visit was not completed through the typed report flow.',
        code: 'followup_no_typed_completion',
      });
    }
    let suggestion = projectFollowupSuggestion({ scheduledService: svc, project: {}, profile });
    let followupRequired = !!suggestion?.required;
    if (followupRequired && profile.findingsType === 'cockroach') {
      if (String(snapshot?.values?.species || '') !== 'German') followupRequired = false;
    }
    // Knockdown typed-value overrides mirror /complete (Codex P2 rounds
    // 3–4): the stored snapshot's explicit German "No" wins over the
    // profile's ALERT policy, the selected window drives the bookable date,
    // and a palmetto "Yes" earns the CTA the none-policy profile would
    // withhold (same 14-day default interval as German).
    if (followupRequired && profile.findingsType === 'german_roach_knockdown') {
      if (String(snapshot?.values?.followup_required || '') === 'No') {
        followupRequired = false;
      } else {
        const windowDays = KNOCKDOWN_FOLLOWUP_WINDOW_DAYS[String(snapshot?.values?.followup_window || '')];
        if (windowDays && windowDays !== suggestion?.days) {
          suggestion = projectFollowupSuggestion({
            scheduledService: svc,
            project: {},
            profile: { ...profile, followupPolicy: 'alert', defaultFollowupDays: windowDays },
          });
          followupRequired = !!suggestion?.required;
        }
      }
    }
    if (!followupRequired && profile.findingsType === 'palmetto_roach_knockdown'
      && String(snapshot?.values?.followup_needed || '') === 'Yes') {
      suggestion = projectFollowupSuggestion({
        scheduledService: svc,
        project: {},
        profile: { ...profile, followupPolicy: 'alert', defaultFollowupDays: profile.defaultFollowupDays ?? 14 },
      });
      followupRequired = !!suggestion?.required;
    }
    if (!followupRequired) {
      return res.status(409).json({
        error: 'This completed visit does not call for a follow-up appointment.',
        code: 'followup_not_required',
      });
    }
    // The CTA books exactly the program-interval date the completion computed;
    // any other date is normal scheduling, not an included $0 follow-up
    // (Codex P2 — this is not a generic booking API).
    if (!suggestion.suggestedDate || String(date) !== String(suggestion.suggestedDate)) {
      return res.status(409).json({
        error: `Follow-up must be booked for the program-interval date${suggestion.suggestedDate ? ` (${suggestion.suggestedDate})` : ''}.`,
        code: 'followup_date_mismatch',
        suggestedDate: suggestion.suggestedDate || null,
      });
    }

    const cols = await db('scheduled_services').columnInfo().catch(() => ({}));
    if (!cols.followup_source_service_id || !cols.followup_included) {
      return res.status(503).json({ error: 'Follow-up booking is not available yet (pending migration).', code: 'followup_columns_missing' });
    }

    const existing = await db('scheduled_services')
      .where({ followup_source_service_id: svc.id })
      .whereNotIn('status', ['cancelled', 'skipped'])
      .orderBy('created_at', 'desc')
      .first();
    if (existing) {
      return res.json({ success: true, alreadyScheduled: true, appointment: { id: existing.id, scheduledDate: serviceDateOnly(existing.scheduled_date), status: existing.status } });
    }

    // technicianId override is admin-only — a tech-authenticated caller
    // could otherwise book the follow-up onto another technician's lane
    // (Codex P2). Techs always inherit the source visit's technician.
    const technicianOverride = req.techRole === 'admin' ? technicianId : null;
    const insertData = {
      customer_id: svc.customer_id,
      technician_id: technicianOverride || svc.technician_id || null,
      scheduled_date: date,
      window_start: windowStart || svc.window_start || null,
      window_end: windowEnd || svc.window_end || null,
      service_type: svc.service_type,
      status: 'pending',
      notes: `Follow-up to ${serviceDateOnly(svc.scheduled_date)} visit (booked at completion)`,
      is_recurring: false,
      followup_included: true,
      followup_source_service_id: svc.id,
    };
    if (cols.service_id && svc.service_id) insertData.service_id = svc.service_id;
    if (cols.zone && svc.zone) insertData.zone = svc.zone;
    if (cols.estimated_duration_minutes && svc.estimated_duration_minutes) insertData.estimated_duration_minutes = svc.estimated_duration_minutes;
    if (cols.estimated_price) insertData.estimated_price = 0;
    if (cols.create_invoice_on_complete) insertData.create_invoice_on_complete = false;
    if (cols.time_window && svc.time_window) insertData.time_window = svc.time_window;

    let appointment;
    try {
      [appointment] = await db('scheduled_services').insert(insertData).returning('*');
    } catch (err) {
      // Partial unique index on followup_source_service_id — a concurrent
      // CTA tap lost the race; return the winner's booking idempotently.
      if (err && err.code === '23505') {
        const winner = await db('scheduled_services')
          .where({ followup_source_service_id: svc.id })
          .whereNotIn('status', ['cancelled', 'skipped'])
          .orderBy('created_at', 'desc')
          .first();
        if (winner) {
          return res.json({
            success: true,
            alreadyScheduled: true,
            appointment: { id: winner.id, scheduledDate: serviceDateOnly(winner.scheduled_date), status: winner.status },
          });
        }
      }
      throw err;
    }
    logger.info(`[dispatch] follow-up ${appointment.id} booked from ${svc.id} (${profile.findingsType}) for ${date}`);
    // Without this the visit never enters appointment_reminders, so the
    // 72h/24h reminder cron can't see it (the cron reads only that table).
    // sendConfirmation:false — no immediate SMS; the customer was told about
    // the follow-up in person at completion. Best-effort: never fails the booking.
    try {
      const AppointmentReminders = require('../services/appointment-reminders');
      await AppointmentReminders.registerAppointment(
        appointment.id,
        svc.customer_id,
        `${date}T${String(insertData.window_start || '08:00').slice(0, 5)}`,
        svc.service_type,
        'booking_followup',
        { sendConfirmation: false },
      );
    } catch (e) {
      logger.error(`[dispatch] Reminder registration failed for follow-up ${appointment.id}: ${e.message}`);
    }
    res.json({
      success: true,
      alreadyScheduled: false,
      appointment: {
        id: appointment.id,
        scheduledDate: serviceDateOnly(appointment.scheduled_date),
        status: appointment.status,
      },
    });
  } catch (err) { next(err); }
});

router.post('/:serviceId/findings-recap/draft', async (req, res) => {
  try {
    if (!(await assertRecapOwnership(req, res))) return;
    if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'AI not configured' });
    const { structuredFindings, nextStepChips, includeCustomerComms } = req.body || {};
    const findingsType = structuredFindings?.type;
    if (!findingsType || !ActivityIndicators.isTypedFindingsType(findingsType)) {
      return res.status(400).json({ error: `Unknown findings type: ${findingsType}` });
    }
    const schema = ActivityIndicators.findingsSchemaForType(findingsType);
    const svc = await db('scheduled_services')
      .where({ id: req.params.serviceId })
      .first('id', 'customer_id', 'service_type', 'service_id');
    if (!svc) return res.status(404).json({ error: 'Service not found' });
    // The appointment's PROFILE is authoritative for which findings type
    // (if any) this service uses — never the client payload. Without this,
    // any assigned tech could pull customer comms into an AI call for an
    // arbitrary type on a non-typed job (pre-push Codex P1).
    const draftProfile = await resolveCompletionProfileForScheduledService(svc).catch(() => null);
    if (draftProfile?.findingsType !== findingsType) {
      return res.status(409).json({
        error: 'This service does not use that findings form.',
        code: 'findings_type_mismatch',
      });
    }
    // Chips are advisory inputs here — drop invalid ones instead of failing
    // the draft (the complete endpoint enforces them strictly). Validate
    // against THIS type's allowed chips, not the global list, so an off-type
    // chip can't steer the customer-facing draft (Codex P2).
    const chipsValidation = ActivityIndicators.validateNextStepChips(
      nextStepChips, draftProfile.findingsType, structuredFindings?.values || {},
    );
    const chips = chipsValidation.ok ? chipsValidation.chips : [];
    const commsContext = includeCustomerComms === true
      ? await loadFindingsRecapCommsContext(svc.customer_id).catch(() => '')
      : '';
    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const basePrompt = buildFindingsRecapPrompt({
      schema,
      values: structuredFindings?.values || {},
      chips,
      serviceType: svc.service_type,
      commsContext,
    });
    // Prompt instructions are not enforcement: the draft lands on a
    // customer-facing report, so validate it against the banned-claims list
    // and retry once with the violations called out. Still dirty after the
    // retry -> 502 and the tech writes the note manually (AI is never in
    // the critical path).
    let draft = '';
    let violations = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const msg = await anthropic.messages.create({
        model: MODELS.FLAGSHIP,
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: attempt === 0
            ? basePrompt
            : `${basePrompt}\n\nYour previous draft used prohibited wording (${violations.join(', ')}). Rewrite it without any absolute or promissory claims — describe only what was observed and done today.`,
        }],
      });
      draft = String(msg.content?.[0]?.text || '').trim();
      if (!draft) break;
      violations = ActivityIndicators.findBannedCustomerCopy(draft);
      if (!violations.length) break;
    }
    if (!draft) return res.status(502).json({ error: 'Draft generation returned no text' });
    if (violations.length) {
      logger.warn(`[dispatch] findings-recap draft failed banned-copy check for ${req.params.serviceId}: ${violations.join(', ')}`);
      return res.status(502).json({ error: 'Draft failed the customer-copy quality check — please write the note manually.' });
    }
    res.json({ draft });
  } catch (err) {
    logger.warn(`[dispatch] findings-recap draft failed for ${req.params.serviceId}: ${err.message}`);
    res.status(502).json({ error: 'Draft generation failed' });
  }
});

// POST /:serviceId/photo-analysis/draft — AI-describe the attached
// completion photos for the customer report (owner spec 2026-06-12).
// Photos arrive as data-URLs straight from the panel (they only reach S3
// at submit), so the analysis needs no storage round-trip. Same trust
// shape as findings-recap/draft: assigned tech only, typed profile
// authoritative, output banned-copy validated with one retry, never in
// the critical path — a 502 just means the tech writes (or skips) the
// photo copy manually.
router.post('/:serviceId/photo-analysis/draft', async (req, res) => {
  try {
    if (!(await assertRecapOwnership(req, res))) return;
    if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'AI not configured' });
    const { photos, structuredFindings } = req.body || {};
    if (!Array.isArray(photos) || !photos.length) {
      return res.status(400).json({ error: 'photos array is required', code: 'photos_required' });
    }
    if (photos.length > 5) {
      return res.status(400).json({ error: 'At most 5 photos can be analyzed', code: 'too_many_photos' });
    }
    const findingsType = structuredFindings?.type;
    if (!findingsType || !ActivityIndicators.isTypedFindingsType(findingsType)) {
      return res.status(400).json({ error: `Unknown findings type: ${findingsType}` });
    }
    const schema = ActivityIndicators.findingsSchemaForType(findingsType);
    const svc = await db('scheduled_services')
      .where({ id: req.params.serviceId })
      .first('id', 'customer_id', 'service_type', 'service_id');
    if (!svc) return res.status(404).json({ error: 'Service not found' });
    const photoProfile = await resolveCompletionProfileForScheduledService(svc).catch(() => null);
    if (photoProfile?.findingsType !== findingsType) {
      return res.status(409).json({
        error: 'This service does not use that findings form.',
        code: 'findings_type_mismatch',
      });
    }
    // Decode with the same size cap the completion upload enforces — a
    // photo too big to persist is too big to analyze (the helper default
    // is the looser 15MB buffer cap, not the 2MB completion data-URL cap).
    const { decodeDataUrlPhoto, MAX_COMPLETION_PHOTO_DATA_URL_BYTES } = require('../services/service-photos');
    const imageBlocks = [];
    for (const photo of photos) {
      const decoded = decodeDataUrlPhoto(photo?.data, { maxBytes: MAX_COMPLETION_PHOTO_DATA_URL_BYTES });
      imageBlocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: decoded.mimeType,
          data: decoded.buffer.toString('base64'),
        },
      });
    }
    const PhotoAnalysis = require('../services/service-report/photo-analysis');
    const basePrompt = PhotoAnalysis.buildPhotoAnalysisPrompt({
      schema,
      values: structuredFindings?.values || {},
      photoCount: photos.length,
      serviceType: svc.service_type,
    });
    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    let result = { ok: false };
    for (let attempt = 0; attempt < 2 && !result.ok; attempt += 1) {
      const msg = await anthropic.messages.create({
        model: MODELS.VISION,
        max_tokens: 700,
        temperature: 0.2,
        messages: [{
          role: 'user',
          content: [
            ...imageBlocks,
            {
              type: 'text',
              text: attempt === 0 || !result.violations?.length
                ? basePrompt
                : `${basePrompt}\n\nYour previous response used prohibited wording (${result.violations.join(', ')}). Rewrite without any absolute or promissory claims — describe only what is visible.`,
            },
          ],
        }],
      });
      result = PhotoAnalysis.parsePhotoAnalysisResponse(
        msg.content?.[0]?.text,
        { photoCount: photos.length },
      );
    }
    if (!result.ok) {
      logger.warn(`[dispatch] photo analysis failed for ${req.params.serviceId}: ${result.error}${result.violations?.length ? ` (${result.violations.join(', ')})` : ''}`);
      return res.status(502).json({ error: 'Photo analysis failed the customer-copy quality check — caption the photos manually or skip.' });
    }
    res.json({ photoSummary: result.photoSummary, captions: result.captions });
  } catch (err) {
    logger.warn(`[dispatch] photo analysis failed for ${req.params.serviceId}: ${err.message}`);
    res.status(502).json({ error: 'Photo analysis failed' });
  }
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

async function syncRescheduleReminder(serviceId, date, window, { willNotify = false } = {}) {
  try {
    const AppointmentReminders = require('../services/appointment-reminders');
    await AppointmentReminders.handleReschedule(
      serviceId,
      rescheduleReminderTime(date, window),
      // This route sends its own reschedule SMS (below) rather than letting
      // handleReschedule send one, so always sendNotification:false. When we
      // ARE about to notify, coverDueWindows keeps the day-before flag covered
      // until our SMS settles + markRescheduleNoticeSent runs, so the 15-min
      // cron can't fire a duplicate reminder in the gap. A non-notifying move
      // leaves the 24h reminder pending so the cron still reminds the customer.
      { sendNotification: false, coverDueWindows: willNotify },
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

// GET /api/admin/dispatch/:serviceId/rain-out-options
//
// Dispatch-side weather-reschedule option set — later-today (+2h/+4h)
// windows plus route-scored day options badged with NWS rain chance.
// Mirrors the tech route GET /api/tech/services/:id/rain-out-options
// but WITHOUT the tech-assignment check: any dispatcher may rain-out a
// stop on a tech's behalf. Shared engine: services/rain-out.js.
router.get('/:serviceId/rain-out-options', async (req, res, next) => {
  try {
    const svc = await db('scheduled_services')
      .where({ id: req.params.serviceId })
      .first('id', 'scheduled_date');
    if (!svc) return res.status(404).json({ error: 'Service not found' });

    // Same stale-tap guard as the tech route: the moved-first rain-out
    // is a same-day "weather is hitting the route now" action. A job
    // already pushed to a future date can't be rained out onto today.
    if (trackTransitions.isFutureScheduledDate(svc.scheduled_date)) {
      return res.status(409).json({
        error: "This job is scheduled for a future date — rain-out applies to today's route.",
        code: 'future_scheduled_date',
      });
    }

    const RainOut = require('../services/rain-out');
    const options = await RainOut.getOptions(req.params.serviceId);
    if (!options.ok) {
      return res.status(options.reason === 'not_found' ? 404 : 409).json({ error: options.reason });
    }
    return res.json(options);
  } catch (err) { next(err); }
});

// POST /api/admin/dispatch/:serviceId/tree-shrub/assess-preview
// body: { photos: [{ data: <dataURL> }] }
// Scores the closeout photos with dual-vision (NO persistence) and returns the
// tech-facing findings the Tree & Shrub closeout summary renders. The tech then
// confirms/hides/edits and the decisions are submitted with completion.
router.post('/:serviceId/tree-shrub/assess-preview', async (req, res) => {
  try {
    // Server kill-switch + cost guard: the dual-vision scoring is paid, so refuse
    // (before any model call) unless the feature is rolled out — mirrors the gate on
    // the completion auto-score hook, so the UI flag alone can't trigger paid calls.
    if (process.env.TREE_SHRUB_REPORT_V2 !== 'true') {
      return res.status(404).json({ error: 'Not found' });
    }
    // Per-service ownership (same guard as photo-analysis/draft): a tech may only
    // score photos for a service they're assigned to; admins are unrestricted.
    if (!(await assertRecapOwnership(req, res))) return;
    const svc = await db('scheduled_services')
      .where({ id: req.params.serviceId })
      .first('id', 'service_type');
    if (!svc) return res.status(404).json({ error: 'Service not found' });
    if (detectServiceLine(svc.service_type) !== 'tree_shrub') {
      return res.status(409).json({ error: 'Not a tree & shrub service', code: 'not_tree_shrub' });
    }
    const { photos } = req.body || {};
    if (!Array.isArray(photos) || !photos.length) {
      return res.status(400).json({ error: 'photos array is required', code: 'photos_required' });
    }
    if (photos.length > 5) {
      return res.status(400).json({ error: 'At most 5 photos can be analyzed', code: 'too_many_photos' });
    }
    const { decodeDataUrlPhoto, MAX_COMPLETION_PHOTO_DATA_URL_BYTES } = require('../services/service-photos');
    const result = await previewTreeShrubAssessment({
      photos,
      loadImage: (photo) => {
        try {
          const decoded = decodeDataUrlPhoto(photo?.data, { maxBytes: MAX_COMPLETION_PHOTO_DATA_URL_BYTES });
          return { base64: decoded.buffer.toString('base64'), mimeType: decoded.mimeType };
        } catch { return null; }
      },
    });
    if (!result) {
      return res.status(200).json({ scores: null, findings: [], aiSummary: 'AI photo review could not score these photos.', suggestedCustomerAction: 'No action needed', status: 'failed' });
    }
    // Sign the scores + observation + the EXACT photo set so the completion handler
    // can verify the review came from this preview for these images.
    const photosHash = treeShrubPhotosHash(photos.map((p) => p && p.data));
    result.signature = treeShrubReviewSignature(result.scores, result.scoredCount, req.params.serviceId, photosHash, result.observations);
    return res.json({ ...result, status: 'complete' });
  } catch (err) {
    return res.status(500).json({ error: 'Tree & shrub assessment preview failed', detail: err.message });
  }
});

// POST /api/admin/dispatch/:serviceId/rain-out
// body: { reasonCode, scope: 'job'|'route', target: { date, window },
//         alt?: { date, window }, notifyCustomer? }
//
// Dispatch-side moved-first rain-out. Route scope uses the job's OWN
// assigned technician (not the acting dispatcher) so "rest of route"
// means that tech's remaining stops. Shared engine: services/rain-out.js.
router.post('/:serviceId/rain-out', async (req, res, next) => {
  try {
    const svc = await db('scheduled_services')
      .where({ id: req.params.serviceId })
      .first('id', 'technician_id', 'scheduled_date');
    if (!svc) return res.status(404).json({ error: 'Service not found' });

    if (trackTransitions.isFutureScheduledDate(svc.scheduled_date)) {
      return res.status(409).json({
        error: "This job is scheduled for a future date — rain-out applies to today's route.",
        code: 'future_scheduled_date',
      });
    }

    const { reasonCode, scope, target, alt, notifyCustomer } = req.body || {};
    if (target?.date && !/^\d{4}-\d{2}-\d{2}$/.test(String(target.date))) {
      return res.status(400).json({ error: 'target.date must be YYYY-MM-DD' });
    }

    const RainOut = require('../services/rain-out');
    const result = await RainOut.commit({
      serviceId: req.params.serviceId,
      technicianId: svc.technician_id,
      reasonCode,
      scope: scope === 'route' ? 'route' : 'job',
      target,
      alt,
      notifyCustomer: notifyCustomer !== false,
      initiatedBy: 'admin',
    });

    if (!result.ok) {
      const code = result.reason === 'not_found' ? 404
        : (result.reason === 'bad_reason' || result.reason === 'bad_target') ? 400
          : 409;
      return res.status(code).json({ error: result.reason, results: result.results || [] });
    }

    // Each moved stop: re-arm its appointment reminder onto the new slot and
    // re-render any open dispatcher boards. Mirrors the /reschedule path — the
    // rain-out sends its own "we moved you" SMS inside commit(), so cover the
    // due windows (and mark the notice sent) only when that SMS actually went
    // out; otherwise leave the 24h/72h reminder pending so the cron still
    // reminds the customer on the new slot.
    for (const moved of result.results || []) {
      if (!moved.ok) continue;
      await syncRescheduleReminder(moved.id, moved.newDate, moved.newWindow, { willNotify: moved.smsSent === true });
      if (moved.smsSent === true) {
        await markRescheduleReminderNotified(moved.id);
      }
      try {
        await emitDispatchJobUpdate({ jobId: moved.id, actorId: req.technicianId });
      } catch (err) {
        logger.error(`[dispatch] rain-out board broadcast failed for ${moved.id}: ${err.message}`);
      }
    }

    logger.info(
      `[admin-dispatch] rain-out service=${req.params.serviceId} actor=${req.technicianId} ` +
      `scope=${scope === 'route' ? 'route' : 'job'} moved=${result.movedCount} failed=${result.failedCount}`
    );
    return res.json(result);
  } catch (err) { next(err); }
});

// POST /api/admin/dispatch/:serviceId/reschedule
router.post('/:serviceId/reschedule', async (req, res, next) => {
  try {
    const { newDate, newWindow, reasonCode, reasonText, notifyCustomer, scope } = req.body;

    // Series scope shifts every future occurrence — skip the customer-confirm
    // SMS path (which only handles a single appt) and commit directly.
    // allowLive: the anchor may be en_route / on_site (rain mid-visit,
    // customer pushes the whole cadence) — the rebooker rewinds its
    // tracker lifecycle and frees the tech, same as the single path.
    if (scope === 'series') {
      const result = await SmartRebooker.rescheduleSeries(req.params.serviceId, newDate, newWindow, reasonCode || 'admin', 'admin', { allowLive: true });
      const occurrences = Array.isArray(result.rescheduledOccurrences) ? result.rescheduledOccurrences : [];
      for (const occurrence of occurrences) {
        await syncRescheduleReminder(
          occurrence.id,
          occurrence.date,
          { start: occurrence.windowStart, end: occurrence.windowEnd },
          { willNotify: notifyCustomer !== false },
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
          // window_text quotes the 2-hour arrival promise from the new start.
          // win.end is the job-duration block the dispatcher sized the visits
          // with — never the customer-facing window (see sms-time-format).
          const arrivalRange = arrivalWindowRange(win.start);
          const windowText = arrivalRange ? `, ${formatSmsTimeRange(arrivalRange)}` : '';
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

    // Staff-initiated reschedules may override live lifecycle states
    // (en_route / on_site) — rain starts mid-route, or the customer calls
    // to push the visit while the tech is already there. The rebooker
    // rewinds the tracker lifecycle and frees the tech. Terminal states
    // (completed / cancelled / skipped) still 409. The customer-SMS
    // self-serve path (reschedule-sms.js) does NOT get this override.
    const rescheduleOptions = { allowLive: true };
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
    await syncRescheduleReminder(req.params.serviceId, newDate, newWindow, { willNotify: notifyCustomer !== false });
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

// Whether to capture application conditions (weather snapshot) for the
// service_record at completion time (extracted for unit testing).
// Two independent reasons to capture:
//   1. V1 service reports render conditions on the customer report — the
//      historical trigger (complete visits only).
//   2. Any visit that logs products gets FDACS compliance-ledger rows
//      (property_application_history), and application records are meant to
//      carry conditions — INCLUDING incomplete closeouts, whose products
//      were still physically applied (Codex P2 round 2: the old
//      !isIncompleteVisit gate exported those ledger rows with null
//      weather/wind).
function shouldCaptureApplicationConditions({
  hasConditionsColumn,
  useServiceReportV1,
  isIncompleteVisit,
  productCount,
}) {
  if (!hasConditionsColumn) return false;
  if (useServiceReportV1 && !isIncompleteVisit) return true;
  return Number(productCount) > 0;
}

// Auto-invoice eligibility for a completed visit (extracted for unit testing).
// Historically required the scheduler's create_invoice_on_complete flag OR a
// WaveGuard tier, which silently dropped priced, self-pay, non-WaveGuard visits
// (the recovery leak). With autoInvoicePricedVisits on
// (GATE_AUTOINVOICE_PRICED_VISITS), any explicitly-priced visit also qualifies.
// All coverage guards still apply, and autopayCoversVisit already requires
// !hasVisitPrice, so a price-free autopay-covered visit is never billed here.
const { isAlwaysFreeServiceType } = require('../services/no-cost-visit-types');

// Completion invoice amount precedence (extracted for unit testing).
// Per-application customers bill the explicit visit price, else the
// acceptance-stamped per_application_fee — NEVER the customer-level
// monthly_rate: a multi-service accept intentionally leaves both the fee and
// each row's estimated_price NULL (whole-plan fee on every row = overbill),
// and monthly_rate IS that same whole-plan number, so falling back to it
// re-opens the identical overbilling on every row (Codex round-2 P1). A
// per-application row with no amount returns 0, the auto-invoice gate
// declines it, and the visit is billed manually. Legacy (non-per-app) rows
// keep the monthly_rate fallback the WaveGuard-membership flows depend on.
function completionInvoiceAmount({
  estimatedPrice,
  isCallback,
  perApplicationBilling,
  perApplicationFee,
  monthlyRate,
}) {
  if (estimatedPrice != null && Number(estimatedPrice) > 0) return Number(estimatedPrice);
  if (isCallback) return 0;
  if (perApplicationBilling) {
    return Number(perApplicationFee) > 0 ? Number(perApplicationFee) : 0;
  }
  return monthlyRate && Number(monthlyRate) > 0 ? Number(monthlyRate) : 0;
}

function shouldAutoInvoiceCompletion({
  recapReviewOnly,
  alreadyPaid,
  prepaidCovered,
  autopayCoversVisit,
  preMintedInvoice,
  existingCompletionInvoice,
  createInvoiceOnComplete,
  waveguardTier,
  perApplicationBilling,
  hasVisitPrice,
  invoiceAmount,
  autoInvoicePricedVisits,
  serviceType,
  isCallback,
}) {
  if (recapReviewOnly || alreadyPaid || prepaidCovered || autopayCoversVisit
    || preMintedInvoice || existingCompletionInvoice) {
    return false;
  }
  if (!(Number(invoiceAmount) > 0)) return false;
  // Explicit scheduler flag stays the strongest signal (operator intent).
  if (createInvoiceOnComplete) return true;
  // Per-application customers bill every completed APPLICATION — never a
  // callback/re-treat or an always-free type (re-service, follow-up,
  // estimate). Decided BEFORE the WaveGuard-tier shortcut: converted
  // per-application customers carry a tier, and letting the tier branch
  // answer first would bill their free visit types the moment a fee/rate
  // gives them a positive invoiceAmount (Codex P1). Tier-less/commercial
  // per-application rows are covered here too.
  if (perApplicationBilling) return !isCallback && !isAlwaysFreeServiceType(serviceType);
  if (waveguardTier) return true;
  // GATED new path: a priced visit qualifies — but NEVER an always-free type
  // (appointment / estimate / re-service / follow-up) or a callback/re-treat,
  // even if a stale or inherited price is present. Keeps this gate in lockstep
  // with the Billing Recovery workbench's no-cost allowlist (shared module).
  return !!autoInvoicePricedVisits && !!hasVisitPrice
    && !isCallback && !isAlwaysFreeServiceType(serviceType);
}

// ── "Your Visit, in Motion" recap video (Pest Report V2 lane) ──────────────────
// Gated behind PEST_RECAP (server) + pest-recap-v1 (client). Tech/admin auth is
// already applied by router.use(adminAuthenticate, requireTechOrAdmin) above. Named
// `recap-video` to avoid colliding with the existing SMS `recap-preview` route.
const recapPipeline = require('../services/service-report/recap-pipeline');
const recapStorage = require('../services/service-report/recap-storage');
const recapMedia = require('../services/service-report/recap-media');

// :serviceId is the SCHEDULED service id (uuid) — the key the whole recap lane uses.
// Techs may only touch recaps for their OWN assigned visit; admins, any. Writes the
// 403 itself and returns false so the caller bails.
async function recapOwnerOk(req, res) {
  if (req.techRole === 'admin') return true;
  const svc = await db('scheduled_services').where({ id: req.params.serviceId }).first('technician_id');
  if (svc && svc.technician_id === req.technicianId) return true;
  res.status(403).json({ error: 'Not your visit' });
  return false;
}
const recapVideoActor = (req) => req.technician?.name || req.technicianId || null;

router.get('/:serviceId/recap-video', async (req, res, next) => {
  try {
    if (!(await recapOwnerOk(req, res))) return undefined;
    const recap = await recapPipeline.getRecap(req.params.serviceId);
    if (!recap) return res.json({ exists: false, status: 'none' });
    return res.json({
      exists: true,
      status: recap.status,
      ready: recap.status === 'ready' || recap.status === 'approved',
      approved: recap.status === 'approved',
      sent: Boolean(recap.sent_at),
      durationMs: recap.duration_ms || null,
      error: recap.last_error || null,
    });
  } catch (err) { return next(err); }
});

router.post('/:serviceId/recap-video/generate', async (req, res, next) => {
  try {
    if (process.env.PEST_RECAP !== 'true') return res.status(409).json({ error: 'recap rendering is disabled' });
    if (!(await recapOwnerOk(req, res))) return undefined;
    const result = await recapPipeline.enqueueRecap(req.params.serviceId, { force: Boolean(req.body?.force) });
    if (!result.ok) return res.status(503).json({ error: 'recap queue unavailable' });
    return res.json({ ok: true, status: result.recap?.status || 'pending' });
  } catch (err) { return next(err); }
});

router.post('/:serviceId/recap-video/approve', async (req, res, next) => {
  try {
    if (process.env.PEST_RECAP !== 'true') return res.status(409).json({ error: 'recap is disabled' });
    if (!(await recapOwnerOk(req, res))) return undefined;
    const result = await recapPipeline.approveRecap(req.params.serviceId, { approvedBy: recapVideoActor(req) });
    if (!result.ok) return res.status(409).json({ error: result.error });
    // Approval sends the customer the watch-recap link (best-effort, idempotent).
    // sendRecap is idempotent + retryable, so a failed send leaves the recap
    // approved-but-unsent and the client surfaces a retry (sent:false).
    let sent = false;
    let sendError = null;
    try {
      const { sendRecap } = require('../services/service-report/recap-delivery');
      const send = await sendRecap(req.params.serviceId);
      sent = Boolean(send?.ok);
      if (!sent) sendError = send?.reason || 'send_failed';
    } catch (err) {
      sendError = err.message;
      logger.warn(`[dispatch] recap send failed for ${req.params.serviceId}: ${err.message}`);
    }
    return res.json({ ok: true, status: 'approved', sent, sendError });
  } catch (err) { return next(err); }
});

// Streams the rendered MP4 through this authed route (never a public S3 URL).
router.get('/:serviceId/recap-video/file', async (req, res, next) => {
  try {
    if (!(await recapOwnerOk(req, res))) return undefined;
    const recap = await recapPipeline.getRecap(req.params.serviceId);
    if (!recap?.s3_key) return res.status(404).end();
    const range = req.headers.range || null;
    const obj = await recapStorage.getRecapStream(recap.s3_key, range);
    if (!obj) return res.status(404).end();
    if (obj.rangeNotSatisfiable) return res.status(416).set('Accept-Ranges', 'bytes').end();
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', obj.contentType || 'video/mp4');
    res.setHeader('Cache-Control', 'no-store');
    if (range && obj.contentRange) {
      res.status(206).setHeader('Content-Range', obj.contentRange);
    }
    if (obj.size) res.setHeader('Content-Length', obj.size);
    obj.body.on('error', (streamErr) => {
      logger.warn(`[recap] video stream error: ${streamErr.message}`);
      if (!res.headersSent) res.status(502).end(); else res.destroy(streamErr);
    });
    return obj.body.pipe(res);
  } catch (err) { return next(err); }
});

// Tech-captured recap media — direct browser→S3 (presigned PUT). Same auth + gate.
router.post('/:serviceId/recap-media/presign', async (req, res, next) => {
  try {
    if (process.env.PEST_RECAP !== 'true') return res.status(409).json({ error: 'recap capture is disabled' });
    if (!(await recapOwnerOk(req, res))) return undefined;
    const { role, mediaType, contentType } = req.body || {};
    const result = await recapMedia.presignUpload({ scheduledServiceId: req.params.serviceId, role, mediaType, contentType, capturedBy: recapVideoActor(req) });
    return res.json(result);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    return next(err);
  }
});

router.post('/:serviceId/recap-media/:mediaId/confirm', async (req, res, next) => {
  try {
    if (!(await recapOwnerOk(req, res))) return undefined;
    // Size/duration verified server-side (authoritative S3 size) in confirmUpload;
    // oversized/missing objects are dropped + rejected so they never hit the renderer.
    const result = await recapMedia.confirmUpload(req.params.mediaId, { scheduledServiceId: req.params.serviceId, durationMs: req.body?.durationMs });
    if (!result.ok) {
      if (result.reason === 'too_large') return res.status(413).json({ error: 'Clip too large — keep it under ~20 seconds.' });
      if (result.reason === 'bad_duration') return res.status(422).json({ error: 'Couldn’t read the clip length — re-record a short clip and try again.' });
      if (result.reason === 'not_uploaded') return res.status(409).json({ error: 'Upload not found — try again.' });
      return res.status(404).json({ error: 'media not found' });
    }
    return res.json({ ok: true, id: result.row.id, status: result.row.status });
  } catch (err) { return next(err); }
});

router.get('/:serviceId/recap-media', async (req, res, next) => {
  try {
    if (!(await recapOwnerOk(req, res))) return undefined;
    const items = await recapMedia.listMedia(req.params.serviceId);
    return res.json({ items });
  } catch (err) { return next(err); }
});

router.delete('/:serviceId/recap-media/:mediaId', async (req, res, next) => {
  try {
    if (!(await recapOwnerOk(req, res))) return undefined;
    const ok = await recapMedia.deleteMedia(req.params.mediaId, { scheduledServiceId: req.params.serviceId });
    return res.json({ ok });
  } catch (err) { return next(err); }
});

module.exports = router;
module.exports._test = {
  lawnAssessmentCompletionBlockPayload,
  preflightLawnAssessmentCompletion,
  completionAllowsTechnicianPestRating,
  pestPressureConfigAllowsTechnicianRating,
  technicianPestRatingAllowedForService,
  shouldRejectPhotoCaptionBannedCopy,
  internalOnlyProductsBlockPayload,
  serviceReportEmailEligible,
  shouldAutoInvoiceCompletion,
  completionInvoiceAmount,
  shouldCaptureApplicationConditions,
};
