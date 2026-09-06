const crypto = require('crypto');
const db = require('../models/db');
const smsTemplatesRouter = require('../routes/admin-sms-templates');
const logger = require('../services/logger');
const StripeService = require('../services/stripe');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');
const trackTransitions = require('../services/track-transitions');
const { stampedDivergesSql } = require('../services/stamped-address');
const CompletionRecap = require('../services/completion-recap');
const { buildRecapVisitContext } = require('../services/recap-visit-context');
const CompletionAttempts = require('../services/completion-attempts');
const PropertyZones = require('../services/property-zones');
const TermiteStations = require('../services/termite-stations');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { publicPortalUrl } = require('../utils/portal-url');
const { countSegments } = require('../services/messaging/segment-counter');
const { recordServiceProductNutrients, amountToPounds } = require('../services/nutrient-ledger');
const { buildPlanForService, isDateInWindow } = require('../services/waveguard-plan-engine');
const { evaluateWaveGuardManagerApprovals, managerApprovalSummary } = require('../services/waveguard-approval-engine');
const { shortenOrPassthrough, invoiceShortCodePrefix } = require('../services/short-url');
const { customerOnAutopay } = require('../services/autopay-eligibility');
const { membershipDuesCoverVisit, completionInvoiceAmount, isMembershipTier, monthlyDuesCollected, resolveBillingLane } = require('../services/billing-lane');
const { resolveAppointmentCardLane, resolveExtendedLane, resolveCompletionChargeCap } = require('../services/completion-charge-verdict');
const { detectServiceLine, getServiceLineConfig, getAdvisoryDefaults, isSprayApplicationMethod, isNonBaitPesticideProduct, isTermiteNoReentryServiceType } = require('../services/service-report/service-line-configs');
const { runAndSwallowErrors: runPestPressureForServiceRecord } = require('../services/pest-pressure/orchestrate');
const { loadActiveConfig: loadPestPressureConfig } = require('../services/pest-pressure/store');
const { buildCompletionAdvisory, approvedReportProductFacts } = require('../services/service-report/report-data');
const { buildReportIdentitySnapshot, canonicalProductId } = require('../services/service-report/report-identity-snapshot');
const { freezeTechTips } = require('../services/service-report/tip-library');
const { gateEnvValue } = require('../config/feature-gates');
const { reportReconciliationIssues } = require('../services/service-report/report-reconciliation');
const { isValidHeight } = require('../services/service-report/turf-height');
const { createTurfHeightReading } = require('../services/turf-height-service');
const TurfHeightOcr = require('../services/turf-height-ocr');
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
const {
  cleanupUploadedServicePhotoObjects,
  promoteStagedServicePhotos,
  uploadServicePhotoDataUrls,
} = require('../services/service-photos');
const {
  recordLawnProtocolCompletion,
  normalizeCompletionForStructuredNotes,
} = require('../services/lawn-protocol-completion');
const { validateTreeShrubCloseout, validateTreeShrubTypedCompliance, deriveTreeShrubTreatments } = require('../services/tree-shrub-closeout');
const { scoreAndStoreTreeShrubAssessment, storeTreeShrubAssessmentFromReview, treeShrubReviewSignature, treeShrubPhotosHash } = require('../services/tree-shrub-assessment');
const { resolveCompletionProfileForScheduledService, resolveCompletionDeliveryPosture } = require('../services/service-completion-profiles');
const ActivityIndicators = require('../services/service-report/activity-indicators');
const { technicianReportCustomerCopy } = require('../services/service-report/technician-report-copy');
const CompanionCompletions = require('../services/service-report/companion-completions');

// The follow-up override chain (German knockdown windows, two-treatment
// package rules, species gating) lives in ONE place — the obligation module
// — shared by /complete, /schedule-followup, and the shared status writer's
// cancellation re-park hook. Route-local copies drifted (Codex r1–r2 on
// PR #3091 found four leak shapes between them).
const { typedFollowupVerdict, typedFollowupObligationForCompletedSource, parkFollowupAlert, TWO_TREATMENT_PACKAGE_KEYS } = require('../services/typed-followup-obligation');
const { resolveCloseoutRequirementsSnapshotForCompletion } = require('../services/service-closeout-requirements');

// Report/track egress (AGENTS.md): entry-code shapes that must never persist
// into customer-visible completion text. Three shapes: a code word near a
// location word ("gate ... code"), a code word followed by digits
// ("pin 9921"), and the bare shorthand of a code-carrying location word
// followed directly by a code-shaped number ("Gate 1234", "lockbox is
// 2468" — codex r3). Ordinary copy ("entry points treated", "gate was
// open") never trips; a street address near the word "gate" may — that
// false positive fails closed and the tech rephrases.
const COMPLETION_ACCESS_CODE_RE = /(?:\b(?:gate|garage|door|lock\s?box|keypad|alarm|entry|access)\b[^\n.!?]{0,40}\b(?:code|pin|combo|combination)\b|\b(?:code|pin|combo|combination)\b[^\n.!?]{0,15}[a-z]?\d{2,4}(?:[-\s]\d{2,4}){0,2}|\b(?:gate|garage|door|lock\s?box|keypad|alarm|entry|access)\b[^\n.!?]{0,12}\b(?:[a-z]?\d{3,8}|[a-z]?\d{2,4}(?:[-\s]\d{2,4}){1,2})\b)/i;

const {
  findFirstApplicationInvoiceForEstimateService,
} = require('../services/estimate-first-application-invoice');
const { isUserFeatureEnabled } = require('../services/feature-flags');
const {
  recordTrackTransitionFailure,
  recordTrackTransitionResultFailure,
} = require('../services/track-transition-alerts');
const { finiteDate, positiveMinutesBetween, buildCompletionLifecycleUpdates } = require('../utils/service-duration-capture');
const { minutesFromElapsed } = require('../utils/duration-minutes');
const {
  INVENTORY_UNITS,
  baseQuantityUnit,
  convertInventoryQuantity,
  normalizeInventoryUnit,
} = require('../services/inventory-units');

async function renderTemplate(templateKey, vars, context = {}) {
  try {
    if (typeof smsTemplatesRouter.getTemplate === 'function') {
      const body = await smsTemplatesRouter.getTemplate(templateKey, vars, context);
      if (body) return body;
    }
  } catch { /* fall through */ }
  return null;
}

// Feature probe for OPT-IN completion templates. Deliberately the OPPOSITE
// posture of smsTemplatesRouter.isTemplateActive (there, a MISSING row means
// active — a kill-switch stance for long-standing sends): these templates ARM
// new sending behavior, so they must exist AND be active to engage, and any
// doubt (missing table, lookup error) means OFF. No audit-log noise either —
// getTemplate would file a missing/inactive audit row per completion.
async function isOptInSmsTemplateEnabled(templateKey) {
  try {
    if (!(await db.schema.hasTable('sms_templates'))) return false;
    const row = await db('sms_templates').where({ template_key: templateKey }).first('is_active');
    return !!row && row.is_active !== false;
  } catch { return false; }
}

// Preflight of the payment_receipt SEND policy for the combined
// report+receipt completion text: the combined SMS carries receipt facts, so
// it must honor the same opt-outs the separate receipt SMS enforces —
// payment_receipt (the migration-104 kill switch), payment_confirmation_sms
// (the portal Billing toggle), and the email-only receipt channel (the
// separate receipt's hasEmailLeg gate; the queue's email leg is the receipt
// for these customers). Column semantics mirror PURPOSE_POLICY.payment_receipt
// in services/messaging/policy.js — if that policy changes, change this too.
// Any doubt (no prefs row = defaults-on is the one exception, lookup failure
// is not) resolves to the classic two-text behavior.
async function customerWantsReceiptTexts(customerId) {
  try {
    const prefs = await db('notification_prefs')
      .where({ customer_id: customerId })
      .first('payment_receipt', 'payment_confirmation_sms', 'payment_receipt_channel');
    if (!prefs) return true;
    if (prefs.payment_receipt === false) return false;
    if (prefs.payment_confirmation_sms === false) return false;
    if (String(prefs.payment_receipt_channel || '').toLowerCase() === 'email') return false;
    return true;
  } catch { return false; }
}

async function runtimeServiceReportFlag(req, flagKey, envKey, defaultValue = false) {
  const envValue = process.env[envKey];
  if (envValue !== undefined) {
    return ['1', 'true', 'yes', 'on'].includes(String(envValue).trim().toLowerCase());
  }
  return isUserFeatureEnabled(req.technicianId, flagKey, defaultValue).catch(() => !!defaultValue);
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
  activityScore = null,
} = {}) {
  return visitOutcome === 'completed'
    && !observations.length
    && !recommendations.length
    && !String(concernText || '').trim()
    // A non-zero activity rating means SOMETHING was seen — stamping "All
    // inspected zones were clear of pest activity" beside a 2/5 rating made
    // the report contradict itself (John Kelleher audit 2026-07-29).
    && !(Number.isFinite(Number(activityScore)) && Number(activityScore) > 0);
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

function ensureSmsContainsReportLink(body, reportLink) {
  const text = String(body || '').trim();
  const link = String(reportLink || '').trim();
  if (!text || !link) return text;
  // Portal links are delivered scheme-stripped (SMS allowlist rule), so a
  // rendered body can hold the identical link without https:// — that
  // counts as containing it. Without this, the domain-replace below fired
  // on a body that already had the link and, because the regex consumed
  // only the legacy /report/<32-hex> path, swapping the bare domain left
  // the short-link path dangling: ".../l/report-x/l/report-x" (sent to a
  // customer 2026-08-03). Presence is matched case-insensitively with the
  // scheme optional, and the trailing lookahead stops a LONGER stale slug
  // from satisfying a prefix of it (…/l/report-old12x must not count as
  // containing …/l/report-old12 — it needs replacing, not skipping). The
  // replacement regex consumes /l/<slug> paths too, so a genuine
  // replacement swallows the whole stale link.
  const schemeless = link.replace(/^https?:\/\//i, '');
  const escaped = schemeless.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const presentRe = new RegExp(`(?:https?:\\/\\/)?${escaped}(?![A-Za-z0-9-])`, 'i');
  if (presentRe.test(text)) return text;
  const portalRootRe = /\b(?:https?:\/\/)?portal\.wavespestcontrol\.com(?:\/report\/[a-f0-9]{32}|\/l\/[A-Za-z0-9-]+)?/i;
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

// Plan/approval-engine block messages predate the advisory policy and can
// still phrase conditions as approval mandates ("manager review is required
// before applying it", "requires manager approval"). Advisory records must
// not persist copy that contradicts the non-blocking closeout, so soften the
// wording before it lands in structured_notes / Customer 360.
function advisorySafeMessage(text) {
  return String(text || '')
    .replace(/;\s*manager (?:review|approval) is required before applying it\.?/gi, ' — double-check before applying.')
    .replace(/\brequires manager approval\b/gi, 'flagged for review')
    .trim();
}

// Advisory messages recorded on a completion, flattened for the closeout
// success view — the operator must see a recorded overrun/exception at
// completion time, not only later in Customer 360.
function completionAdvisoryMessages({ blackout, nLimit, manager, calibration, inventory }) {
  return [blackout, nLimit, manager, calibration, inventory]
    .filter((record) => record && record.advisory)
    .flatMap((record) => (Array.isArray(record.blocks) ? record.blocks : []))
    .map((block) => block && block.message)
    .filter(Boolean);
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

// Backdated quiet completion (stale-visit backlog closeout). `backfill: true`
// on POST /:serviceId/complete stamps the completion's date fields from the
// row's own scheduled_date instead of today, and forces every customer-facing
// send off (completion SMS, report email, review ask, payer AP email) — the
// work happened days ago; a "we just finished" text today would be a lie.
// Only valid for a genuinely past-dated row (ET calendar-date compare):
// today's visits complete through the normal path so the 6PM checker's and
// same-day semantics stay untouched.
// ADMIN-ONLY: backfill is a financial/comms override (suppresses charges and
// every customer send), so the office authorizes it — the route itself is
// requireTechOrAdmin, and a technician token must not be able to quietly
// close out a visit. `role` is req.techRole; anything but 'admin' fail-closes
// to 403 (Codex P1 on the fix round). Errors carry `status` so the call site
// returns 403 for the authz failure vs 400 for the date validation.
function backfillCompletionPlan({ backfill, scheduledDate, today = etDateString(), role } = {}) {
  if (backfill !== true) return { active: false };
  if (role !== 'admin') {
    return {
      active: false,
      status: 403,
      error: {
        error: 'Backdated closeout is an office override — admin login required',
        code: 'backfill_admin_only',
      },
    };
  }
  const serviceDate = scheduledDate ? serviceDateOnly(scheduledDate) : null;
  if (!serviceDate || serviceDate >= today) {
    return {
      active: false,
      error: {
        error: 'backfill is only valid for a visit whose scheduled date is in the past',
        code: 'backfill_not_past',
      },
    };
  }
  return { active: true, serviceDate };
}

// Backfill duration policy (Codex P1, fix round): a stale row's lifecycle
// timestamps are artifacts of the forgotten closeout — a check-in from
// days/weeks ago against an office checkout stamped today — so the shared
// helper's elapsed-math fallback would book that whole span as
// service_time_minutes/actual_duration_minutes and pollute every time
// metric downstream. Under backfill the ONLY trusted duration is the
// operator's explicit timeOnSite from the completion body; absent that, the
// duration keys are stripped so the columns stay unknown (NULL) instead of
// carrying a fabricated interval. Mutates and returns the updates object
// built by buildCompletionLifecycleUpdates. Pure for testability (_test).
//
// "Explicit" is itself validated (Codex P1, PR #2897): the pre-fix panel
// auto-submitted its running elapsed — the stale span again, relabeled as
// operator input — so a provided value only counts within a workday cap.
// Out of range degrades to absent (columns stay NULL), never a 400: the
// backlog closeout must still land.
const BACKFILL_MAX_TIME_ON_SITE_MINUTES = 720;

// 12h — no single visit exceeds a workday

// Sanitized operator minutes for a backfill completion: a positive duration
// within the workday cap, else null ("absent"). The SINGLE source for both
// the persisted service duration (applyBackfillDurationPolicy) and the
// job-costing explicitLaborMinutes forward — the two must never disagree.
function backfillTimeOnSiteMinutes(timeOnSite) {
  const minutes = minutesFromElapsed(timeOnSite);
  return minutes > 0 && minutes <= BACKFILL_MAX_TIME_ON_SITE_MINUTES ? minutes : null;
}

// The start fields buildCompletionLifecycleUpdates back-derives from a typed
// duration when the row carries no start of its own (inferredStart =
// completion instant − duration; service-duration-capture.js). Enumerated so
// the backfill policy strips exactly what the helper fabricates — no more.
const BACKFILL_INFERRED_START_FIELDS = ['actual_start_time', 'check_in_time', 'arrived_at'];

// The end fields the completion path stamps with the closeout instant: on the
// scheduled_services row via buildCompletionLifecycleUpdates, and on the
// service_records report row via buildServiceRecordCompletionTimingFields
// (which additionally stamps ended_at/completed_at). Enumerated per surface
// so the policies below strip exactly the closeout-instant stamps — no more.
const BACKFILL_LIFECYCLE_END_FIELDS = ['actual_end_time', 'check_out_time'];

const BACKFILL_RECORD_END_FIELDS = ['ended_at', 'completed_at', 'actual_end_time', 'check_out_time'];

// True when the scheduled_services row itself carries a real start timestamp
// — a stale check-in is history; anything else on those fields is an
// artifact the policies strip.
function backfillRowHasRealStart(service = {}) {
  return BACKFILL_INFERRED_START_FIELDS.some((field) => finiteDate(service?.[field]));
}

// `service` is the pre-update scheduled_services row — the policy needs it to
// tell a row-backed start timestamp from one the helper inferred.
function applyBackfillDurationPolicy(lifecycleUpdates, timeOnSite, service = {}) {
  const explicitMinutes = backfillTimeOnSiteMinutes(timeOnSite);
  if (explicitMinutes) {
    lifecycleUpdates.service_time_minutes = explicitMinutes;
    lifecycleUpdates.actual_duration_minutes = explicitMinutes;
  } else {
    delete lifecycleUpdates.service_time_minutes;
    delete lifecycleUpdates.actual_duration_minutes;
    // Keep backfilled on-site durations unknown (Codex P1, PR #2897 fix
    // round): stripping the duration KEYS above is not enough when the row
    // carries a real stale check-in — the helper still stamps today's
    // closeout instant into actual_end_time/check_out_time, and every
    // start→end reader (service-report metrics-band computeOnSiteMin,
    // pricing-reality-check resolveActualMinutes) re-derives the weeks-long
    // span AT READ TIME from the kept start against today's end whenever
    // structured_notes.timeOnSite is null. With no typed duration the
    // visit's end is genuinely unknown, so drop the end stamps too: the
    // stale check-in stays untouched (historical truth), the start→end pair
    // on these columns never completes, and the duration reads as unknown.
    // (The tracker's completed_at DOES carry a day-scale service-day
    // instant since fix round 9 — billing recovery needs it — so the pair
    // readers that can see completed_at guard on the durable
    // structured_notes.backfill marker; see backfillCompletionEndInstant.)
    // The closeout instant itself is still on the audit trail
    // (service_record/attempt-row created_at, job_status_history). A row
    // with no start of its own keeps the end stamps — no start anywhere
    // means no pair to poison, and the stamp records when the closeout
    // happened.
    if (backfillRowHasRealStart(service)) {
      for (const field of BACKFILL_LIFECYCLE_END_FIELDS) delete lifecycleUpdates[field];
    }
  }
  // No fabricated arrivals (Codex P1, PR #2897): with a typed duration and a
  // never-started stale row (pending/confirmed — no start timestamps), the
  // shared helper infers actual_start_time/check_in_time/arrived_at =
  // closeout instant − duration, i.e. the backdated visit would record
  // arriving TODAY — on the scheduled_services row and, through
  // buildServiceRecordCompletionTimingFields, on the service_records report
  // row. Keep a start field only when the ROW itself carries a real
  // timestamp for it (checked per field, so the strip stays correct even if
  // the helper ever starts echoing row values through): stale-but-real
  // timestamps are historical truth and stay untouched; inferred ones are
  // dropped and the arrival stays unknown. The typed duration still lands
  // above — the duration is the operator's statement, the arrival instant
  // is not.
  for (const field of BACKFILL_INFERRED_START_FIELDS) {
    if (!finiteDate(service?.[field])) delete lifecycleUpdates[field];
  }
  return lifecycleUpdates;
}

// service_records leg of the duration policy (Codex P1, PR #2897 fix round):
// buildServiceRecordCompletionTimingFields copies the row's real stale
// check-in into started_at/arrived_at/... AND stamps every end field with the
// closeout instant — re-creating on the report row the exact start→end pair
// the lifecycle leg above refuses to complete. metrics-band's
// computeOnSiteMin (service report "time on site") and pricing-reality-check
// both fall back to that pair when structured_notes.timeOnSite is null, so a
// blank typed duration would read as days-or-weeks on site. Same predicate as
// the lifecycle leg: a typed duration keeps everything (readers prefer it);
// no row-backed start keeps the end stamps (no pair to poison). Mutates and
// returns the fields object. Pure for testability (_test).
function applyBackfillRecordTimingPolicy(timingFields, timeOnSite, service = {}) {
  if (backfillTimeOnSiteMinutes(timeOnSite)) return timingFields;
  if (!backfillRowHasRealStart(service)) return timingFields;
  for (const field of BACKFILL_RECORD_END_FIELDS) delete timingFields[field];
  return timingFields;
}

// Single backfill end-instant rule (Codex P2 ×3, PR #2897 fix round 4): every
// end/completion stamp a backfill closeout KEEPS — scheduled_services
// actual_end_time/check_out_time, the service_records end fields, and the
// tracker's completed_at — carries the visit's backdated service day, never
// the closeout wall-clock. Day-scale readers key "when did the visit end" off
// these columns: the termite-bond sync (lifecycle-email-sweeps prefers
// actual_end_time/check_out_time/completed_at over scheduled_date, so a
// today-stamped end started bond terms + renewal notices on the closeout
// date), pricing-reality-check (its lookback COALESCE and month bucketing
// pulled weeks-old backfills into the CURRENT window/month), and billing
// recovery's completed_at aging. The record layer already dates service_date
// to the visit day; this extends the same posture to the instants. The
// closeout wall-clock stays on the audit trail (record/attempt created_at,
// job_status_history).
//
// The instant, per row shape:
//  - real row-backed start + typed duration → start + duration (the pair then
//    equals the operator's statement exactly — the one honest end).
//  - everything else → ET noon of the service day (same backdated-instant
//    convention the lawn-protocol completion already uses via
//    toETNoonServiceDate): one honest low-resolution "the visit ended on its
//    day" instant. Round 7 returned NULL for the real-start+blank-duration
//    shape so no instant could complete a fabricated pair against the kept
//    stale start — but a NULL completed_at also made a priced backfill
//    INVISIBLE to Billing Recovery's leak window (ss.completed_at >= now()-
//    window, admin-billing-recovery.js), i.e. an uninvoiced backfill
//    vanished from the exact workbench meant to catch it (Codex P1, fix
//    round 9). The resolution: day-scale readers (billing recovery aging,
//    termite-bond sync, month bucketing, comms context) get the honest
//    service-day instant; the SUB-DAY pair readers that round 7 was
//    protecting (pricing-reality-check resolveActualMinutes, estimate-
//    actuals, the report visit-timeline duration) now guard on the durable
//    structured_notes.backfill marker instead — the same read-side policy
//    job-costing already applies — so a backfilled row's kept stale start
//    can never pair against this instant into a fabricated duration. The
//    lifecycle/record END-FIELD strips for this shape stay exactly as they
//    were (applyBackfillDurationPolicy / applyBackfillRecordTimingPolicy):
//    only the tracker's completed_at carries the day-scale instant.
function backfillCompletionEndInstant(serviceDate, timeOnSite, service = {}) {
  const explicitMinutes = backfillTimeOnSiteMinutes(timeOnSite);
  const realStart = BACKFILL_INFERRED_START_FIELDS
    .map((field) => finiteDate(service?.[field]))
    .find(Boolean) || null;
  if (realStart && explicitMinutes) {
    return new Date(realStart.getTime() + explicitMinutes * 60000);
  }
  return toETNoonServiceDate(serviceDate);
}

// Live time-on-site override (forgotten-closeout fix, same-day leg): the
// completion panel's timer keeps running when a visit isn't closed out
// promptly, and a live completion ships that inflated elapsed verbatim into
// the duration columns. An admin may instead type corrected minutes — the
// wire contract is TYPE-based on the existing timeOnSite field: a string is
// the panel's auto-elapsed timer (unchanged behavior), a NUMBER is an
// operator-typed override (only backfill bodies carry numbers today).
// ADMIN-ONLY, fail-closed like backfillCompletionPlan: the tech portal never
// sends numbers, so a numeric value on a technician token is tampering or a
// client bug — 403, never silently degraded. Out-of-range from an admin is a
// 400 (unlike backfill's degrade-to-unknown: the admin is live at the panel
// and can correct the typo; the backlog-closeout must-land argument doesn't
// apply). Backfill bodies pass through untouched — the backfill sanitizer
// owns that branch. Pure for testability (_test).
// Timer-vs-operator classification is the SHARED rule in
// completion-attempts (isOperatorTimeOnSite) — the intake gate here and the
// idempotency MODE hash must never disagree about what counts as an
// operator-entered duration (codex P2 #3152 round 14). Non-timer shapes —
// bare "45", "45 min", numbery arrays — are operator input wearing a string
// costume and take the admin gate (codex P1 round 13).
//
// Timer-SHAPED strings are additionally validated against the server's own
// span (codex P1 round 14): the format alone cannot distinguish the panel's
// real timer from a forged "45:00", but the server owns the start stamp.
// Within this tolerance the client's second-level precision is kept
// (network latency + modest clock drift); outside it the server-derived
// span is recorded instead.
const LIVE_TIMER_TOLERANCE_MINUTES = 5;

// Server-derived minutes rendered in the panel timer's own "H:MM:SS" shape,
// so a substituted value flows through every downstream type-based contract
// (structured_notes freeze, the numeric-means-adjusted signals) exactly
// like a genuine timer submission.
function minutesAsElapsedString(minutes) {
  const whole = Math.max(0, Math.round(minutes));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}:00`;
}

// Linked job timer sync — shared by the after-the-fact PATCH and the live
// completion override (codex P1, pre-push audit round 20): job costing
// overrides the inflated entry via the durable stamp, but timesheet detail,
// utilization, and actual-duration analytics read time_entries directly.
// Revision-fenced under the scheduled_services row lock, which is HELD
// through the audited edit so concurrent corrections' syncs serialize in
// commit order; a request that finds a NEWER revision than the one it
// committed skips — the newest correction's own pass lands the truth. The
// safe shape is exactly one non-voided, CLOSED job entry diverging from the
// corrected minutes in either direction; everything else is surfaced as a
// blocked reason (entry_open / multiple_job_entries / entry_shape /
// approved_week / edit_failed) rather than forced.
async function syncLinkedJobTimer({ serviceId, minutes, committedSeq, editedBy, entriesSnapshot = null }) {
  let corrected = null; // null = no divergent linked entry to correct
  let blocked = null;
  try {
    await db.transaction(async (timerTrx) => {
      const rowNow = await timerTrx('scheduled_services').where({ id: serviceId }).forUpdate().first();
      const rowSeqNow = rowNow?.time_on_site_correction_seq == null
        ? null
        : Number(rowNow.time_on_site_correction_seq);
      if (rowSeqNow != null && committedSeq != null && rowSeqNow > committedSeq) return;
      // The version boundary is the CORRECTION, not this post-commit sync
      // (codex P2 #3152 round 23): callers capture the entry snapshot
      // inside the correction transaction, so a payroll edit landing
      // between the correction's commit and this sync carries a newer
      // updated_at than the snapshot and the audited edit 409s instead of
      // silently replacing it. The LIVE set is still read for the
      // membership recheck below; on the crash-resume path (no transaction
      // ran in this process, no snapshot to hand over) it is also the
      // divergence input — but never an edit basis, see the resume guard.
      const liveEntries = await timerTrx('time_entries')
        .where({ job_id: serviceId, entry_type: 'job' })
        .whereNot('status', 'voided')
        .select('id', 'clock_in', 'clock_out', 'duration_minutes', 'status', 'updated_at');
      let jobEntries = liveEntries;
      if (entriesSnapshot !== null) {
        // Membership recheck (codex P2 #3152 round 24): a job timer
        // started for this visit after the snapshot means the snapshot's
        // aggregate no longer describes payroll reality — editing the
        // snapshotted row could report success while the true total stays
        // wrong. Versions and values still come from the SNAPSHOT (the
        // correction's ordering boundary); only the id-set is compared.
        const snapIds = entriesSnapshot.map((e) => String(e.id)).sort().join(',');
        const liveIds = liveEntries.map((e) => String(e.id)).sort().join(',');
        if (snapIds !== liveIds) {
          corrected = false;
          blocked = 'entry_conflict';
          return;
        }
        jobEntries = entriesSnapshot;
      }
      if (jobEntries.length === 0) return;
      // A still-running linked timer cannot be silently "fine" — the span
      // keeps growing past the corrected minutes and the audited edit
      // workflow is for completed intervals. Surface it (codex P1, audit
      // round 20c) so the admin closes/fixes it in Timesheets.
      const open = jobEntries.filter((e) => e.clock_out == null);
      if (open.length > 0) {
        corrected = false;
        blocked = 'entry_open';
        return;
      }
      // Divergence is judged on the AGGREGATE (codex P1, audit round 21):
      // timesheets, utilization, and job costing all SUM the linked
      // entries, and a legitimate split visit (20 + 25 against a 45-minute
      // correction) is in sync while two duplicate 45s against 45 are not
      // — a per-entry comparison called that duplicate shape "fine".
      // ANY aggregate divergence syncs — an increased re-correction
      // (45 → 60) must move the entry too, not only an inflated-timer
      // decrease — compared at the stored hundredth-minute precision
      // (codex P2 round 21): a one-minute tolerance left a 45.01–46.00
      // entry silently unsynced. Half a hundredth absorbs float noise
      // only; an entry this sync wrote lands exactly on the corrected
      // minutes, so re-runs still no-op.
      //
      // The no-op decision reads the LIVE set (codex P2 round 26): a
      // payroll edit after the snapshot that changes a duration without
      // changing the id-set would otherwise slip through — the snapshot
      // total still agrees and the version fence on the edit path is never
      // reached. A live-divergent timer falls through instead: the edit
      // path's expected_updated_at (from the SNAPSHOT) then 409s and the
      // conflict is surfaced; a payroll edit that already landed the
      // corrected minutes stays silent, as it should.
      const totalMinutes = liveEntries.reduce((s, e) => s + (Number(e.duration_minutes) || 0), 0);
      if (Math.abs(totalMinutes - minutes) <= 0.005) return;
      if (jobEntries.length === 1 && jobEntries[0].clock_in) {
        // Crash-resume guard (codex P2 #3152 round 24): with no
        // transaction-time snapshot there is no version that predates the
        // correction — a fresh updated_at would bless a NEWER payroll edit
        // for overwrite. A divergent timer on the resume path is surfaced,
        // never edited. (An already-agreeing timer returned at the
        // aggregate check above, so resumes stay quiet when the first run
        // finished its sync.)
        if (entriesSnapshot === null) {
          corrected = false;
          blocked = 'entry_conflict';
          return;
        }
        const entry = jobEntries[0];
        // Duration-based edit (codex P1, audit round 21b): adminEditEntry
        // derives the clock_out from ITS locked row's start, so a
        // concurrent clock_in edit between this snapshot and the save can
        // never produce a duration different from the corrected minutes.
        await require('../services/time-tracking').adminEditEntry(entry.id, {
          target_duration_minutes: minutes,
          // Optimistic version (codex P2 round 22): a payroll admin's edit
          // landing between this snapshot and the audited edit's locked
          // read rejects the sync instead of being silently replaced — the
          // 409 surfaces below as entry_conflict.
          expected_updated_at: entry.updated_at ?? null,
          edit_reason: `Time-on-site correction: ${minutes} min (visit ${serviceId})`,
          edited_by: editedBy,
        });
        corrected = true;
      } else {
        corrected = false;
        blocked = jobEntries.length > 1 ? 'multiple_job_entries' : 'entry_shape';
      }
    });
  } catch (err) {
    corrected = false;
    blocked = /approved/i.test(String(err.message))
      ? 'approved_week'
      : (/changed since it was read/i.test(String(err.message))
        ? 'entry_conflict'
        : (/into the future/i.test(String(err.message)) ? 'exceeds_elapsed' : 'edit_failed'));
    logger.warn(`[time-on-site] linked job timer sync blocked for service ${serviceId}: ${err.message}`);
  }
  return { corrected, blocked };
}

function liveTimeOnSitePlan({ timeOnSite, role, backfill = false, service = {}, now = new Date() } = {}) {
  const isEmpty = timeOnSite == null || timeOnSite === '';
  if (backfill === true || isEmpty) {
    return { adjusted: false, effectiveTimeOnSite: timeOnSite };
  }
  if (!CompletionAttempts.isOperatorTimeOnSite(timeOnSite)) {
    // Panel-timer shape — validate the claim against the server's span.
    const claimedMinutes = minutesFromElapsed(timeOnSite);
    const realStart = BACKFILL_INFERRED_START_FIELDS
      .map((field) => finiteDate(service?.[field]))
      .find(Boolean) || null;
    if (!realStart) {
      // No row-backed start = no reference to validate against. An admin
      // keeps their value (they hold the typed override anyway); any other
      // role records unknown rather than trusting an unverifiable claim —
      // the genuine no-start panel submits "0:00", which carries no
      // duration either way.
      return role === 'admin'
        ? { adjusted: false, effectiveTimeOnSite: timeOnSite }
        : { adjusted: false, effectiveTimeOnSite: null };
    }
    // With a row-backed start and a valid `now`, a null from
    // positiveMinutesBetween means the elapsed span rounded to zero (or the
    // start sits ahead of the clock) — NOT "unknown". Trusting the claim on
    // that null let a check-in-and-immediately-submit freeze any
    // timer-shaped value ("720:00") into the report (codex P1 #3152 round
    // 17). Zero IS the server's reference span: the claim survives only
    // within tolerance of it, otherwise the server-derived timer is
    // recorded, exactly like every other divergent claim.
    const serverMinutes = positiveMinutesBetween(realStart, finiteDate(now) || new Date()) ?? 0;
    if (claimedMinutes != null && Math.abs(claimedMinutes - serverMinutes) <= LIVE_TIMER_TOLERANCE_MINUTES) {
      return { adjusted: false, effectiveTimeOnSite: timeOnSite };
    }
    return { adjusted: false, effectiveTimeOnSite: minutesAsElapsedString(serverMinutes) };
  }
  if (role !== 'admin') {
    return {
      adjusted: false,
      status: 403,
      error: {
        error: 'Adjusting time on site is an office override — admin login required',
        code: 'time_on_site_admin_only',
      },
    };
  }
  const minutes = backfillTimeOnSiteMinutes(timeOnSite);
  if (!minutes) {
    return {
      adjusted: false,
      status: 400,
      error: {
        error: `Adjusted time on site must be between 1 and ${BACKFILL_MAX_TIME_ON_SITE_MINUTES} minutes`,
        code: 'time_on_site_invalid',
      },
    };
  }
  return { adjusted: true, effectiveTimeOnSite: minutes };
}

// End instant for an operator-typed duration against a live row: with a real
// row-backed start, the honest end is start + minutes — stamping it keeps
// every timestamp-pair reader (report visit-timeline, publicTimingFields,
// the PDF's Time In/Out, job-costing's span fallback) in agreement with the
// typed duration, with no read-side changes. Returns null when there is no
// row-backed start (buildCompletionLifecycleUpdates then back-derives the
// start from the wall-clock end) or when start + minutes lands in the future
// (typed minutes exceed the actual elapsed — e.g. a late check-in; a future
// end stamp would be a lie, so the wall-clock end stays and the explicit
// duration columns win in every priority-ordered reader). Pure (_test).
function adjustedCompletionEndInstant(service = {}, minutes, now = new Date()) {
  const explicitMinutes = backfillTimeOnSiteMinutes(minutes);
  const realStart = BACKFILL_INFERRED_START_FIELDS
    .map((field) => finiteDate(service?.[field]))
    .find(Boolean) || null;
  const nowInstant = finiteDate(now) || new Date();
  if (!realStart || !explicitMinutes) return null;
  const end = new Date(realStart.getTime() + explicitMinutes * 60000);
  return end.getTime() <= nowInstant.getTime() ? end : null;
}

// Validation/shape plan for the after-the-fact re-entry edit (PATCH
// /:serviceId/reentry): admin correction of a completed visit's advisory
// re-entry windows (interior/exterior treatment dry-down). Values are whole
// minutes; 0 is legal and removes that window from the customer report
// ("no wait"); an omitted side is left untouched. Only completed rows
// qualify — the advisory is persisted by the completion write, so there is
// nothing to edit before close-out. Pure for testability (_test).
const REENTRY_EDIT_MAX_MINUTES = 1440;

// Tech re-entry steppers at completion (owner rule 2026-08-11): optional
// reentryExteriorMinutes / reentryInteriorMinutes posted by CompletionPanel
// when the tech moved a stepper off its seeded default. Same 0–1440 bounds
// as the after-the-fact admin edit above; an omitted/blank side returns
// undefined so the computed-default advisory path stays byte-identical.
// The 5/15-minute increments are a UI affordance only — the wire accepts
// any whole minute so a legit stored value never bounces on replay. Pure
// for testability (_test).
function completionReentryPlan({ exteriorMinutes, interiorMinutes } = {}) {
  const parseSide = (value) => {
    if (value === undefined || value === null || value === '') return undefined;
    const rounded = Math.round(Number(value));
    return Number.isFinite(rounded) && rounded >= 0 && rounded <= REENTRY_EDIT_MAX_MINUTES
      ? rounded
      : NaN;
  };
  const exterior = parseSide(exteriorMinutes);
  const interior = parseSide(interiorMinutes);
  if (Number.isNaN(exterior) || Number.isNaN(interior)) {
    return {
      status: 400,
      error: {
        error: `Re-entry minutes must be between 0 and ${REENTRY_EDIT_MAX_MINUTES}`,
        code: 'reentry_invalid',
      },
    };
  }
  return { exterior, interior };
}

// Crash-resume freeze (Codex P2 ×2, PR #2897 fix round 5): once the
// completion transaction commits, the record's structured_notes freeze IS the
// completion — and the request hash carries `backfill`/`timeOnSite` in a
// separate MODE segment that ONLY the committed-record resume claim ignores
// (completion-attempts claimSideEffectsRun, fix round 10 — pre-commit
// retries match on the full composite), so a resumed retry's body may
// legally disagree with what was committed (a flagless retry of a backfill,
// a still-checked checkbox against a normal completion, the panel's
// auto-elapsed timer instead of the typed duration). On the side-effect
// resume path the body therefore has NO vote:
//  - MODE re-derives from the frozen flag in BOTH directions. A flagless
//    retry of a committed backfill stays QUIET (the original hazard), and a
//    flagged retry of a committed NORMAL completion stays LOUD — the
//    transaction committed a normal completion, so going quiet on resume
//    would silently skip the remaining sends/charges of a visit that was
//    never backfilled.
//  - DURATION is the frozen structured_notes.timeOnSite (`?? null` keeps the
//    unknown-duration shape) — never recomputed from the retry body, which
//    typically carries the panel's running elapsed, i.e. the stale span the
//    workday cap exists to reject. The frozen value was sanitized at commit
//    for a backfill; downstream consumers (backfillCompletionEndInstant,
//    job-costing's explicitLaborMinutes) re-run the cap regardless.
//  - REQUIRED-MINT POSTURE (Codex P0, fix round 8; broadened to every mint
//    branch round 9) is the frozen structured_notes.backfillMintRequired —
//    never recomputed from the LIVE billing state (typed profile, scheduler
//    create_invoice_on_complete flag, billing_mode/tier/rate), all mutable
//    DB state the request hash cannot pin (state edited between a released
//    required-mint failure and the retry → a live recomputation would flip
//    the posture false and finalize the closeout succeeded with no invoice:
//    lost AR). Strict boolean true only. Since the pre-gate removal
//    (2026-07-27) the stamp is written for LIVE typed one-time REQUIRED
//    mints too, so the restore is no longer gated on the backfill mode —
//    only the route's own commit derivation ever writes it.
//  - REQUIRED-MINT MONEY (Codex P0, fix round 10): the frozen
//    backfillMintAmountCents / backfillMintTaxRate stamped beside the
//    posture. Only the posture was frozen in round 8, and the amount
//    recomputed live — so clearing the visit's price after a released
//    required-mint failure flipped the amount guard false and the retry
//    finalized WITHOUT the required invoice, while editing it minted the
//    WRONG amount. Restored only with the posture TRUE (the freeze never
//    stamps them otherwise), and validated hard: cents must be a positive integer (dollars = cents/100), the tax
//    rate a finite fraction below 1 — anything else restores null, and the
//    route's mint block fail-closes a required resume whose frozen amount
//    is missing rather than minting a recomputed number.
// bodyDisagreed reports a mismatch for the route to log. Pure for
// testability (_test).
function frozenResumeCompletionState(frozenStructuredNotes, { requestBackfill = false } = {}) {
  const frozen = frozenStructuredNotes || {};
  const isBackfillCompletion = frozen.backfill === true;
  // Strict boolean true only. No longer gated on the frozen backfill mode:
  // since the pre-gate removal (2026-07-27) the route stamps a REQUIRED
  // posture for LIVE typed one-time completions too, and only the route's
  // own commit derivation ever writes the stamp.
  const backfillMintRequired = frozen.backfillMintRequired === true;
  const frozenCents = frozen.backfillMintAmountCents;
  const backfillMintAmount = backfillMintRequired
    && Number.isInteger(frozenCents) && frozenCents > 0
    ? frozenCents / 100
    : null;
  const frozenTaxRate = frozen.backfillMintTaxRate;
  const backfillMintTaxRate = backfillMintRequired
    && Number.isFinite(frozenTaxRate) && frozenTaxRate >= 0 && frozenTaxRate < 1
    ? frozenTaxRate
    : null;
  // The frozen Bill-To identity (r4 P0). undefined = pre-stamp record (no
  // identity enforcement on legacy resumes); null = frozen self-pay; a
  // non-empty string = the frozen payer id. Anything else restores
  // undefined rather than inventing an authority.
  const frozenPayer = frozen.backfillMintPayerId;
  // payers.id is NUMERIC (r7 P0): the stamp stringifies, but a pre-fix or
  // hand-written record can hold the raw number after the JSONB round-trip
  // — accept both and normalize to the string the identity comparison
  // uses. Rejecting a numeric id here restored undefined, which skipped
  // enforcement and let a post-commit payer change mint the frozen rate
  // for the wrong party.
  const backfillMintPayerId = backfillMintRequired
    && ('backfillMintPayerId' in frozen)
    && (frozenPayer === null
      || (typeof frozenPayer === 'string' && frozenPayer)
      || (typeof frozenPayer === 'number' && Number.isFinite(frozenPayer)))
    ? (frozenPayer === null ? null : String(frozenPayer))
    : undefined;
  return {
    isBackfillCompletion,
    effectiveTimeOnSite: frozen.timeOnSite ?? null,
    backfillMintRequired,
    backfillMintAmount,
    backfillMintTaxRate,
    backfillMintPayerId,
    bodyDisagreed: Boolean(requestBackfill) !== isBackfillCompletion,
  };
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

// formatRescheduleTemplateVars was removed with the inline single-reschedule
// send — that path now routes through admin-schedule's
// sendRescheduleNoticeForVisit (recipient routing + arrival-window copy).

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

  // Stamped visit address OUTRANKS the turf-profile municipality (matches
  // the plan engine): the 1:1 profile describes the primary home, so a visit
  // stamped at a rental in another city must use the treated property's
  // ordinances, not the profile's — and when the stamped city diverges, the
  // profile county is dropped too (the rental's county is unknown; keeping
  // the primary home's county would OR its blackout onto the rental).
  const stampedCity = String(svc.service_address_city || '').trim();
  const profileCity = String(profile.municipality || '').trim();
  const customerCity = String(svc.city || '').trim();
  // The county belongs to the PROFILE, so divergence is measured against the
  // profile's own city context (its municipality, else the customer city as
  // its implied context): a stamped visit in a different city drops the
  // profile county even when the CUSTOMER's city happens to match the stamp
  // (stale-profile case: Charlotte profile, Bradenton customer+visit). No
  // known reference city -> keep the county (can't prove divergence).
  const countyReferenceCity = profileCity || customerCity;
  const stampedDiverges = !!stampedCity && !!countyReferenceCity &&
    countyReferenceCity.toLowerCase() !== stampedCity.toLowerCase();
  const county = stampedDiverges ? '' : String(profile.county || '').trim();
  const city = stampedCity || profileCity || customerCity;
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

// Manufacturer re-entry interval (REI) for the products applied this visit —
// the most restrictive (max) across products, as { minutes, verified }.
// `minutes` is null when no resolved product carries an REI so the caller
// keeps the service-line default; `verified` is true only when the catalog
// lookup succeeded AND resolved every submitted product id — a failed query
// or a missing row (deploy skew, deleted product) means the label floor
// could not be confirmed. Used to make the "Exterior ready in …" countdown
// reflect the product label instead of a flat default.
// Fail-open for the DEFAULTS leg only: there an unverified floor still
// can't lower anything (the service-line defaults are written anyway), and
// failing the whole closeout on a catalog blip would block the visit. The
// tech stepper override leg must treat verified:false as "floor unknown"
// and refuse to go below the computed default (codex P1 #3360). The lookup
// runs in a SAVEPOINT so a failure degrades to unverified instead of
// aborting the caller's completion transaction (waves-db §5b). The
// re-entry correction PATCH deliberately does NOT use this helper — it
// resolves the applied products inline and fails closed (codex P1 PR #3180
// r2/r3).
async function productReentryFloor(knex, submittedProducts = []) {
  const productIds = [...new Set((submittedProducts || []).map((p) => p.productId).filter(Boolean))];
  if (!productIds.length) return { minutes: null, verified: true };
  let rows = null;
  try {
    rows = await knex.transaction(async (sp) => sp('products_catalog')
      .whereIn('id', productIds)
      .select('id', 'rei_hours'));
  } catch {
    rows = null;
  }
  if (!Array.isArray(rows)) return { minutes: null, verified: false };
  const resolvedIds = new Set(rows.map((row) => String(row.id)));
  const verified = productIds.every((id) => resolvedIds.has(String(id)));
  let maxMinutes = null;
  for (const row of rows) {
    const hours = Number(row.rei_hours);
    if (Number.isFinite(hours) && hours >= 0) {
      const minutes = Math.round(hours * 60);
      if (maxMinutes == null || minutes > maxMinutes) maxMinutes = minutes;
    }
  }
  return { minutes: maxMinutes, verified };
}

// Product-identity evidence for the re-entry rules (codex inline r9 on
// #3516): TRUE when any submitted product resolves to a non-bait pesticide
// (see isNonBaitPesticideProduct) — the client defaults methodless termite
// products to station_check and catalog rows such as Termidor Foam carry no
// REI, so method and REI alone would miss a real liquid/foam application.
// Fail closed to FALSE on a lookup error (the identity is then unknown).
async function productIdentityEvidence(knex, submittedProducts = []) {
  const productIds = [...new Set((submittedProducts || []).map((p) => p.productId).filter(Boolean))];
  if (!productIds.length) return false;
  let rows = null;
  try {
    // Nested transaction = SAVEPOINT on the outer completion trx: a failed
    // catalog read rolls back to the savepoint instead of leaving the whole
    // transaction aborted (mirrors productReentryFloor; uncapped codex P1).
    rows = await knex.transaction(async (sp) => sp('products_catalog')
      .whereIn('id', productIds)
      .select('id', 'name', 'category', 'product_type', 'epa_reg_number'));
  } catch {
    rows = null;
  }
  if (!Array.isArray(rows)) return false;
  return rows.some((row) => isNonBaitPesticideProduct({
    name: row.name,
    category: row.category,
    productType: row.product_type,
    epaReg: row.epa_reg_number,
  }));
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
    const amountUnit = baseQuantityUnit(submitted.amountUnit || submitted.rateUnit || null);
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
  allowNegative = false,
}) {
  const lockedProduct = await trx('products_catalog')
    .where({ id: product.id })
    .forUpdate()
    .first();
  const inventoryProduct = lockedProduct || product;
  const amount = productInput.totalAmount != null && productInput.totalAmount !== ''
    ? Number(productInput.totalAmount)
    : null;
  const amountUnit = baseQuantityUnit(productInput.amountUnit || productInput.rateUnit || null);
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
  // allowNegative is passed ONLY for WaveGuard lawn completions, whose
  // closeout treats inventory as advisory (owner directive 2026-08-03): the
  // deduction proceeds, inventory_on_hand goes negative, and the
  // movement/snapshot below record the insufficient-stock state for audit.
  // Every other completion keeps the hard failure — this shared helper runs
  // for pest/tree-shrub/nonmember visits too, which have no advisory lane to
  // record the shortfall (codex P1 r1 on #3179).
  if (insufficient && !allowNegative) {
    const err = new Error(`${inventoryProduct.name} requires ${deductedAmount} ${inventoryUnit}, but only ${stockBefore} ${inventoryUnit} is on hand.`);
    err.statusCode = 400;
    err.isOperational = true;
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
    // setOutcomeBestPhotoKey: a re-elected best photo on an already-scored
    // outcome atomically clears the vision-delta fields so the stored verdict
    // can never describe a photo pair the row no longer points at.
    const VisionDelta = require('../services/vision-delta');
    const bestPhoto = await db('lawn_assessment_photos')
      .where({ assessment_id: assessmentId, is_best_photo: true })
      .first();
    if (bestPhoto) {
      await VisionDelta.setOutcomeBestPhotoKey(outcome.id, 'post_best_photo_key', bestPhoto.s3_key);
    }
    if (outcome.pre_assessment_id) {
      const preBestPhoto = await db('lawn_assessment_photos')
        .where({ assessment_id: outcome.pre_assessment_id, is_best_photo: true })
        .first();
      if (preBestPhoto) {
        await VisionDelta.setOutcomeBestPhotoKey(outcome.id, 'pre_best_photo_key', preBestPhoto.s3_key);
      }
    }
  } catch (err) {
    logger.error(`[dispatch] Lawn assessment outcome photo refs failed: ${err.message}`);
  }
}

function serializeJsonb(value) {
  return JSON.stringify(value ?? null);
}

// ATOMIC post-commit structured_notes key merge (codex P1 #3152 — the same
// clobber class pdf-queue's clearLawnPdfCorrectionMarker fixed): once the
// completion transaction has committed, service_records.structured_notes has
// CONCURRENT writers — the completion side-effect status stamps below and
// the admin time-on-site correction (PATCH /:serviceId/time-on-site) — and a
// whole-column snapshot write from either side erases the other's keys.
// Every post-commit writer therefore merges ONLY the keys it owns; the
// in-memory record.structured_notes snapshots stay as they were (they feed
// the response payload and later deltas), but what lands in the column is
// the delta applied to its CURRENT committed value. Whole-column
// serializeJsonb writes on structured_notes remain legal only INSIDE the
// completion transaction, where nothing can race them.
function mergeRecordNotesKeys(recordId, patch) {
  return db('service_records').where({ id: recordId }).update({
    structured_notes: db.raw(
      "COALESCE(structured_notes::jsonb, '{}'::jsonb) || ?::jsonb",
      [JSON.stringify(patch)],
    ),
  });
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

function completionOwnershipError({ role, actorTechnicianId, assignedTechnicianId }) {
  if (role === 'admin') return null;
  if (
    role === 'technician'
    && actorTechnicianId
    && assignedTechnicianId
    && String(actorTechnicianId) === String(assignedTechnicianId)
  ) return null;
  return {
    status: 403,
    payload: {
      error: 'Not assigned to this service',
      code: 'service_not_assigned',
    },
  };
}

// GATE_TECH_TIPS at call time. Suites that mock feature-gates with a partial
// shape read this as off — today's behaviour — instead of throwing.
function techTipsGateOn() {
  return typeof gateEnvValue === 'function' && gateEnvValue('GATE_TECH_TIPS') === true;
}

// POST /api/admin/dispatch/:serviceId/complete
// Pre-submit report reconciliation block (409) — pure for testability
// (_test), like the other completion block-payload helpers. Returns
// { status, payload } or null. Fail-OPEN on checker errors: this prompt
// must never be the reason a visit cannot complete — the render-time
// guards remain the backstop for anything it skips.
function reportReconcileBlockPayload({
  isIncompleteVisit,
  reportReconcileConfirmed,
  technicianNotes,
  structuredFindings,
  primaryFindingsType = null,
  primaryActivityScore = null,
  companionFindings,
}) {
  if (process.env.GATE_REPORT_RECONCILE_PROMPT !== 'true') return null;
  if (isIncompleteVisit || reportReconcileConfirmed) return null;
  let issues = [];
  try {
    issues = reportReconciliationIssues({
      technicianNotes, structuredFindings, primaryFindingsType, primaryActivityScore, companionFindings,
    });
  } catch {
    return null;
  }
  if (!issues.length) return null;
  return {
    status: 409,
    payload: {
      // adminFetch surfaces only error + code to the client, so the
      // human-readable contradictions ride in the error string; the
      // structured list stays for API consumers and tests.
      error: issues.map((issue) => issue.message).join('\n'),
      code: 'report_reconcile',
      contradictions: issues,
      confirmable: true,
    },
  };
}

// Completion invoice-candidate lookups + reconciliation live in
// services/completion-invoice-candidate.js (shared with the card-expiry
// exemption so both read the same rows through the same rules).
const {
  completionSuppressorInvoiceLookup,
  completionTerminalInvoiceLookup,
  completionNewestLiveInvoiceLookup,
  reconcileLiveVsRefunded,
  splitTerminalCompletionInvoice,
  COMPLETION_TERMINAL_INVOICE_STATUSES,
} = require('../services/completion-invoice-candidate');
const {
  observationsForSpecialtyService,
  specialtyProtocolActionScopes,
  specialtyServiceKey,
  validateSpecialtyAreas,
  validateSpecialtyClosureCombination,
} = require('../../shared/specialty-service-closeouts');
const { LAWN_STRUCTURED_OBSERVATIONS } = require('../../shared/lawn-condition-findings');
const { completionTierSnapshotFields } = require('../services/completion-tier-snapshot');

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
  isBackfillCompletion = false,
}) {
  if (!hasConditionsColumn) return false;
  // Backdated closeout: NEVER capture (Codex P1, PR #2897 fix round). The
  // fetch is CURRENT FAWN/Open-Meteo weather at office-closeout time, but a
  // backfilled record is dated to the scheduled day — and service_records.
  // conditions is copied verbatim into the FDACS application ledger
  // (compliance.js → property_application_history.weather_conditions/
  // wind_speed_mph), so a week-old treatment would carry today's wind and
  // sky as its application-day conditions on a state-auditable record.
  // Absent conditions are an honest unknown for a past day; no historical
  // re-fetch — the capture exists to record what was observed at
  // application time, not a reconstruction.
  if (isBackfillCompletion) return false;
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

function completionSavedCardFallbackPolicy({
  suppressAlternateCollection,
}) {
  return {
    suppressFallback: Boolean(suppressAlternateCollection),
    retainRetryableFallback: false,
  };
}

// Does the completion SMS take the REPORT lane (service_report_v1*) or fall
// through to the generic service_complete* family? Extracted for unit testing
// because the route-level wiring is exactly where this decision was wrong: the
// lane computed a pay link, handed it to buildServiceReportV1DeliveryContext,
// and then refused to enter the branch whenever an invoice existed — so
// service_report_v1_with_invoice was unreachable in production from the day it
// was written, and every billed report-v1 visit silently got the generic
// service_complete_with_invoice instead. The pure-function tests all passed:
// they exercised serviceReportV1SmsType directly, which was never the bug.
//
// reportV1InvoiceArmed is the caller's short-circuit — gate ON *and* the
// with-invoice template present and active. It is only ever true for a billed
// visit; an un-billed one has nothing to arm.
// Is a rendered report-lane invoice body actually usable — i.e. does it carry
// the pay link? Arming this lane only proves the sms_templates row exists and
// is active; it does NOT prove the body still contains {pay_url}. The body is
// operator-editable in /admin, and an active `sms_template_variants` row
// outranks the base row entirely, so an armed, successfully-rendered text can
// reach a customer with an open invoice and no way to pay it. Checking the
// rendered output (not the stored template) is what makes that unreachable.
// The comparison MUST be scheme-normalised: getTemplate strips https:// from
// owned portal hosts before returning the body (admin-sms-templates.js
// stripPortalUrlScheme), so a raw `body.includes(payUrl)` never matches a
// portal pay link and would send EVERY billed visit to the fallback — leaving
// the gated lane permanently unreachable. Both sides go through the renderer's
// own function so this cannot drift as SCHEMELESS_SMS_HOSTS changes.
function reportV1InvoiceBodyCarriesPayLink(body, payUrl, normalize) {
  const strip = typeof normalize === 'function'
    ? normalize
    : (typeof smsTemplatesRouter.stripPortalUrlScheme === 'function'
      ? smsTemplatesRouter.stripPortalUrlScheme
      : (s) => s);
  const text = String(body || '');
  const url = String(payUrl || '').trim();
  if (!text) return false;
  // No pay URL to carry means this was never the billed lane — the caller
  // only reaches this check with one, so treat a missing URL as unusable
  // rather than vacuously true.
  if (!url) return false;
  return String(strip(text)).includes(String(strip(url)));
}

function completionUsesReportLane({
  reportLaneEnabled,
  invoiceCreated,
  usePaidCompletionTemplate,
  reportV1InvoiceArmed,
}) {
  // A paid/prepaid completion has its own template family (receipt, prepaid,
  // annual-prepay) and never routes through the report lane.
  if (!reportLaneEnabled || usePaidCompletionTemplate) return false;
  // No bill: the report lane owns the text, exactly as it always has.
  if (!invoiceCreated) return true;
  // Billed: only with the with-invoice template armed, so the pay link the
  // customer needs is guaranteed to be in the body.
  return Boolean(reportV1InvoiceArmed);
}

// A report-v1 completion text is a gateway to the report: without a public
// token there is no report link to send, and the rendered body would say
// "your report is ready" around the portal HOME. The route withholds the text
// on this path (stamped 'failed' so a later re-completion retries it once the
// mint recovers). Legacy (non-report-v1) visits keep their portal-home link —
// that is where their visit detail lives. delivery_mode 'disabled' never
// mints and never texts, so it is not a withhold. Pure for testability (_test).
function completionSmsWithheldForMissingReportToken({
  serviceReportV1Delivery,
  typedDeliveryMode,
  reportToken,
}) {
  if (!serviceReportV1Delivery) return false;
  if (typedDeliveryMode === 'disabled') return false;
  return !reportToken;
}

// completionInvoiceAmount and membershipDuesCoverVisit moved to
// services/billing-lane.js (imported at top) — the schedule payloads'
// completion-billing prediction must share the exact same authority.

// (The narrow backfillTypedOneTimeMintRequired predicate — round 7's
// backfill-only bypass of the since-removed billing pre-gate — is gone:
// the typed one-time branch in shouldAutoInvoiceCompletion now runs live
// as well as under backfill, and the fail-closed enforcement delegates to
// backfillExpectedMintAtCommit below, which covers every branch.)

// Commit-time REQUIRED-mint posture. For a LIVE completion, only the typed
// one-time population freezes REQUIRED (the leg below — it inherited the
// removed pre-gate's fail-closed promise, owner ruling 2026-07-27); every
// other live lane freezes NOT-required and keeps its non-blocking mint.
// For a backfill closeout (Codex P1, PR
// #2897 fix round 9) — the value the route freezes into structured_notes
// and the invoice catch fail-closes on. Round 8's predicate covered only
// the typed one-time population, but the mint decision also bills backfills
// through its OTHER branches — the scheduler's create_invoice_on_complete
// flag, the monthly-rate/tier and explicit-membership branches, the
// explicit per-visit/per-application lanes, the priced-visits gate — and
// resolveProjectCompletionBilling treats those amounts (row price OR the
// cioc-gated monthly-rate fallback) as REQUIRED just the same. A transient
// mint failure on any of them fell through the NON-BLOCKING catch and
// finalized an unbilled closeout: the exact P0 shape the fail-closed leg
// exists to stop. So the posture IS the will-mint decision at commit:
// shouldAutoInvoiceCompletion itself, evaluated on the same commit-time
// branch inputs the real decision reads.
//
// Suppressor taxonomy (Codex P2, fix round 12) — two kinds, two treatments:
//  - SETTLE-STATE suppressors stay NEUTRALIZED: already-paid, pre-minted,
//    existing invoice, the out-of-band prepaid amount, and annual-prepay
//    coverage. These describe whether a settlement artifact EXISTS — their
//    absence at enforcement time means the mint FAILED, never that it was
//    unowed; at mint time an existing settlement IS the promise kept (the
//    decision's own suppressor gate still wins ahead of the frozen posture
//    on every run, and the catch only fires on an attempted-and-failed
//    mint). Annual-prepay coverage additionally REVALIDATES by design — a
//    refunded term must bill again on resume, so freezing it would wrongly
//    pin a since-refunded settlement.
//  - COMMIT-TIME BUSINESS suppressors PARTICIPATE with their real values:
//    recapReviewOnly (no invoice ever mints on that path) and
//    autopayCoversVisit (membership dues cover the visit). Dues coverage is
//    a business rule about the visit itself, fully knowable at the freeze
//    point (the route hoists the payer + autopay derivations above the
//    transaction) — a covered visit owes NO mint, so it must freeze
//    required=false. Forcing it false froze required=true for covered
//    membership work; live suppression hid the divergence on run one, but a
//    crash before succeed plus a dues/autopay change before the retry made
//    the resume honor frozen TRUE and surprise-bill a visit that was
//    covered when it completed.
// Delegating to the real decision function keeps frozen-required ≡
// will-mint-at-commit (settle-state-free) for every input combination BY
// CONSTRUCTION — the lattice test pins the equivalence so the two can
// never drift.
function backfillExpectedMintAtCommit({
  isBackfillCompletion = false,
  recapReviewOnly = false,
  autopayCoversVisit = false,
  createInvoiceOnComplete = false,
  waveguardTier = null,
  explicitMembership = false,
  explicitPerVisitLane = false,
  perApplicationBilling = false,
  annualPrepayBilling = false,
  hasVisitPrice = false,
  invoiceAmount = 0,
  autoInvoicePricedVisits = false,
  serviceType,
  isCallback = false,
  visitPerformed = true,
  typedOneTimeBilling = false,
}) {
  if (isBackfillCompletion !== true) {
    // LIVE completions: only the typed one-time population is REQUIRED —
    // the pre-gate that used to fail-close it BEFORE commit is removed
    // (owner ruling 2026-07-27), so its money-correctness promise moves to
    // the mint: a transient createFromService failure must release the
    // attempt for resume, never finalize the visit succeeded and unbilled.
    // Commit-time business suppressors participate (recap-only mints
    // nothing; dues-covered work owes nothing); settle-state suppressors
    // are neutralized by absence, exactly like the backfill leg. Every
    // OTHER live lane keeps its historical non-blocking mint.
    return Boolean(
      !recapReviewOnly && !autopayCoversVisit
      && typedOneTimeBilling && hasVisitPrice
      && Number(invoiceAmount) > 0
      && visitPerformed && !isCallback && !isAlwaysFreeServiceType(serviceType),
    );
  }
  return shouldAutoInvoiceCompletion({
    // Commit-time business suppressors participate (see taxonomy above);
    // settle-state suppressors are neutralized.
    recapReviewOnly,
    autopayCoversVisit,
    alreadyPaid: false,
    prepaidCovered: false,
    preMintedInvoice: null,
    existingCompletionInvoice: null,
    annualPrepayCovered: false,
    createInvoiceOnComplete,
    waveguardTier,
    explicitMembership,
    explicitPerVisitLane,
    perApplicationBilling,
    annualPrepayBilling,
    hasVisitPrice,
    invoiceAmount,
    autoInvoicePricedVisits,
    serviceType,
    isCallback,
    visitPerformed,
    typedOneTimeBilling,
    backfillMintRequired: null,
    isBackfillCompletion: true,
  });
}

function shouldAutoInvoiceCompletion({
  recapReviewOnly,
  alreadyPaid,
  prepaidCovered,
  autopayCoversVisit,
  preMintedInvoice,
  existingCompletionInvoice,
  // A REFUNDED invoice on the visit (codex #3456): suppresses like an
  // existing invoice — no replacement is ever minted while the refund can
  // still bounce — but the route parks a manual-billing alert instead of
  // reusing it. Canceled invoices do not block (nothing can restore them).
  terminalInvoiceOnVisit = false,
  // Setup fee owed but never invoiced (Mark Won standard accept skipped
  // the acceptance invoice): suppresses the bare per-application mint —
  // the route parks a manual-billing alert instructing the office to bill
  // setup + first application together.
  unmintedSetupFeeHold = false,
  createInvoiceOnComplete,
  waveguardTier,
  explicitMembership = false,
  explicitPerVisitLane = false,
  perApplicationBilling,
  annualPrepayBilling,
  hasVisitPrice,
  invoiceAmount,
  autoInvoicePricedVisits,
  serviceType,
  isCallback,
  visitPerformed = true,
  typedOneTimeBilling = false,
  // Committed required-mint posture (Codex P0, fix round 8): null = decide
  // live (legacy callers / first run recomputes below — identical result);
  // boolean = the posture GOVERNS the typed backfill branch in both
  // directions (route passes the commit-time derivation on first run and
  // the frozen structured_notes posture on resume).
  backfillMintRequired = null,
  isBackfillCompletion = false,
  annualPrepayCovered = false,
}) {
  // Backfill review-invoice override (Codex P1, stale-sweep lane): a
  // backdated quiet closeout PROMISES the operator an open invoice to
  // reconcile against. An out-of-band prepaid_amount (cash/Zelle recorded on
  // the visit) that fully covers the bill normally suppresses invoicing via
  // prepaidCovered — correct live, where applyPrepaidCreditToInvoice would
  // immediately credit the fresh invoice back down. Under backfill that
  // crediting rail is gated OFF, so suppressing here would mint NOTHING: the
  // recorded prepayment would have no invoice to reconcile against and the
  // completion would be absent from invoice/payment accounting entirely.
  // Mint the invoice anyway; the gated prepaid rail leaves it open with the
  // amount unapplied (its skip-log points review at the recorded amount).
  // ONLY the out-of-band leg is overridden: annual-prepay coverage
  // (annualPrepayCovered — the other input into the composite prepaidCovered
  // flag) still suppresses under backfill, because that money is genuinely
  // settled on the annual prepay invoice — its own paper trail, settled
  // non-cash via settleInvoiceAsAnnualPrepayCovered — and a fresh collectible
  // invoice would double-bill covered plan work. Autopay dues coverage rides
  // its own flag (autopayCoversVisit) and, like every other suppressor
  // (alreadyPaid / pre-minted / existing invoice), is untouched.
  const effectivePrepaidCovered = isBackfillCompletion ? annualPrepayCovered : prepaidCovered;
  if (recapReviewOnly || alreadyPaid || effectivePrepaidCovered || autopayCoversVisit
    || preMintedInvoice || existingCompletionInvoice) {
    return false;
  }
  // Refunded invoice on the visit (codex #3456): a suppressor like
  // the ones above — sits ABOVE the governed posture too, because even a
  // frozen REQUIRED mint must not cut a replacement beside an invoice whose
  // refund can still bounce; the route parks the manual-billing alert.
  if (terminalInvoiceOnVisit) return false;
  // Unminted setup fee: same altitude as the refunded suppressor — even a
  // governed REQUIRED mint must not cut the bare per-application invoice
  // when the one-time setup fee would ride along un-billed; the route
  // parks the manual-billing alert instead.
  if (unmintedSetupFeeHold) return false;
  // Committed REQUIRED-mint posture (Codex P0 fix round 8; broadened to
  // every branch, Codex P1 fix round 9): under backfill a supplied boolean
  // posture GOVERNS the whole decision, in both directions, ahead of every
  // live branch below. TRUE mints even when the live inputs no longer agree
  // — the billing profile, scheduler flag, tier and lane are all mutable DB
  // state, and an edit between the commit (or a released required-mint
  // failure) and the resume must not drop the owed review invoice. FALSE
  // declines even when a live branch would now bill — the completion
  // committed as not-required, and state flipped since commit (a cioc flag
  // set, a profile made one_time, a price added) must not surprise-bill the
  // resumed quiet closeout. Sitting BELOW the suppressors keeps the round-8
  // convergence — an invoice/payment already in place IS the promise kept —
  // but ABOVE the amount guard (Codex P0, fix round 10): invoiceAmount is
  // live-derived from mutable billing fields, and a price cleared after a
  // released required-mint failure flipped the guard false and finalized
  // the closeout WITHOUT its required invoice. A $0 mint still can't
  // happen: the route feeds a REQUIRED decision the FROZEN commit-time
  // amount (positive by construction — the posture only freezes true when
  // this same amount guard passed at commit), and a required resume whose
  // frozen amount is missing fail-closes at the mint instead of minting a
  // recomputed number. First runs pass the commit-time derivation
  // (backfillExpectedMintAtCommit) here, so governed-vs-live can't disagree
  // on run one either; null = legacy callers decide live below.
  // A TRUE posture governs everywhere: under backfill it is the frozen (or
  // commit-time) will-mint decision; live it only ever freezes true for the
  // typed one-time population (backfillExpectedMintAtCommit's live leg), so
  // on a live first run it agrees with the typed branch below by
  // construction and on a live resume it survives a since-mutated billing
  // profile (the removed pre-gate's fail-closed promise). A FALSE posture
  // governs BACKFILL only — a live completion that committed not-required
  // keeps deciding live, exactly like every other live lane.
  if (backfillMintRequired === true) return true;
  if (isBackfillCompletion && backfillMintRequired != null) return false;
  if (!(Number(invoiceAmount) > 0)) return false;
  // Explicit scheduler flag stays the strongest signal (operator intent).
  if (createInvoiceOnComplete) return true;
  // Annual-prepay customers are never auto-billed at completion for their
  // UNPRICED plan visits: covered ones settle through the prepaid stamps /
  // coverage guards above, and an uncovered unpriced visit (naturally
  // expired term awaiting renewal) must not fall into the tier/monthly_rate
  // branch and invent an amount — the renewal flow (notice + annual
  // invoice; roll-to-per-app is the follow-up build) owns collection (Codex
  // round-5 P1). An EXPLICITLY PRICED visit the term does not cover
  // (separately scheduled add-on / one-time — real coverage was already
  // separated into prepaidCovered above) keeps the normal priced-visit
  // billing paths below, exactly as it billed pre-billing_mode (Codex
  // round-11). The caller logs uncovered completions that still end up
  // uninvoiced so nothing leaks silently.
  if (annualPrepayBilling && !hasVisitPrice) return false;
  // Per-application customers bill every completed APPLICATION — never a
  // callback/re-treat or an always-free type (re-service, follow-up,
  // estimate). Decided BEFORE the WaveGuard-tier shortcut: converted
  // per-application customers carry a tier, and letting the tier branch
  // answer first would bill their free visit types the moment a fee/rate
  // gives them a positive invoiceAmount (Codex P1). Tier-less/commercial
  // per-application rows are covered here too.
  // A per-application customer is billed per performed APPLICATION — an
  // inspection_only or customer_declined outcome performed none, so nothing
  // is owed (Codex round-8 P1: the fee would otherwise invoice and even
  // auto-charge the saved method). Same performed-visit rule the referral
  // credit uses; 'incomplete' never reaches this gate (early return).
  if (perApplicationBilling) return visitPerformed && !isCallback && !isAlwaysFreeServiceType(serviceType);
  // An EXPLICIT per_visit/one_time lane means "invoiced for each visit" —
  // exactly what the schedule card predicts. A priced, performed visit in
  // these lanes bills without needing the scheduler flag, a lingering
  // WaveGuard tier, or GATE_AUTOINVOICE_PRICED_VISITS (Codex r5: an admin
  // reclassifying a customer left their existing future visits completing
  // uninvoiced). Same performed/callback/always-free exclusions as the
  // per-application branch; the invoiceAmount > 0 early guard already
  // limits this to explicitly priced visits (completionInvoiceAmount
  // returns 0 for unpriced explicit-lane visits — no dues-rate fallback).
  // A RETURN either way: falling through to the tier branch would let a
  // lingering tier bill a callback/always-free visit these lanes exempt.
  if (explicitPerVisitLane) {
    return visitPerformed && !isCallback && !isAlwaysFreeServiceType(serviceType);
  }
  // Typed one-time completions (typedOneTimeBillingProfile at the route)
  // mint their completion invoice HERE — live and under backfill alike.
  // This branch was backfill-only while the billing pre-gate 409'd live
  // typed completions into the checkout detour; the gate was removed by
  // owner ruling 2026-07-27, so the live path now reaches this decision
  // with no invoice on file and must bill the visit itself. Amount basis is
  // the row's own estimated_price (hasVisitPrice — completionInvoiceAmount
  // puts it first), NEVER the legacy monthly-rate fallback, which only
  // bills behind the scheduler flag (createInvoiceOnComplete already
  // returned true above). Unpriced visits fall through exactly as before.
  // Performed, non-callback, non-always-free work only — the same
  // exclusions every explicit lane applies (a return either way, so a
  // lingering tier can't bill an exempt visit) — and the suppressors above
  // (existing/pre-minted invoice incl. the estimate first-application
  // invoice, already-paid, annual-prepay coverage, autopay dues) still win,
  // so already-billed work never double-mints.
  // (Frozen-posture authority now sits ABOVE, right after the suppressors —
  // fix round 9 broadened it to govern every branch, so it must run before
  // the scheduler-flag/tier/lane branches, not just this typed one.)
  if (typedOneTimeBilling && hasVisitPrice) {
    return visitPerformed && !isCallback && !isAlwaysFreeServiceType(serviceType);
  }
  // An explicit monthly_membership lane stands in for the tier here just as
  // it does in the coverage predicate: a tier-less explicit member whose
  // autopay is dead must fall through to a normal completion invoice, not
  // complete unbilled (Codex r1). The tier check uses the same sentinel
  // classifier as the resolver (Codex r8): a Commercial/One-Time sentinel
  // must not bill an unpriced visit at the monthly_rate fallback when the
  // cron already classifies the customer per_visit — that would be the
  // two-lanes bug from the completion side. Sentinel-tier PRICED visits on
  // NEW bookings still bill via their create_invoice_on_complete stamp
  // (booking no longer strips it for per-visit-resolved customers), and
  // prod carries zero legacy sentinel-tier rows with a rate.
  if (isMembershipTier(waveguardTier) || explicitMembership) return true;
  // GATED new path: a priced visit qualifies — but NEVER an always-free type
  // (appointment / estimate / re-service / follow-up) or a callback/re-treat,
  // even if a stale or inherited price is present. Keeps this gate in lockstep
  // with the Billing Recovery workbench's no-cost allowlist (shared module).
  return !!autoInvoicePricedVisits && !!hasVisitPrice
    && !isCallback && !isAlwaysFreeServiceType(serviceType);
}

/** Complete one scheduled service using the canonical validation, claim and recovery flow.
 * Returns an HTTP-independent { status, body } result; unexpected failures throw.
 * actor comes from authenticated staff middleware, never from the submitted body.
 */
async function completeScheduledService(completionInput, packetRecord = null) {
  // Internal packet context is supplied separately from the HTTP body. All
  // member writes share its OUTER transaction; no member starts post-commit
  // work until the packet's billing/delivery coordinator owns that phase.
  const db = packetRecord ? packetRecord.trx : require('../models/db');
  if (packetRecord && (!db?.isTransaction || !packetRecord.itemId
      || !Array.isArray(packetRecord.uploadedPhotoRows))) {
    throw new TypeError('Packet record completion requires its transaction and item');
  }
  let completionAttempt = null;
  let legacyVisitToDissolve = null;
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
      structuredObservations,
      recommendations,
      // technician-internal next steps (parked [Next] lines) — merged below,
      // never into the form-provenance list
      internalRecommendations,
      formResponses,
      formStartedAt,
      invoiceAlreadySent = false,
      includePayLink = true,
      backfill = false,             // backdated quiet completion of a stale past-dated visit — see backfillCompletionPlan

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
      termiteStations = null,       // bait station pins/status [{ id?, shape?, status?, retire? }] — OPTIONAL
      // Inspection credit — DEFAULT ON (owner ruling): an inspection closes
      // out carrying the credit promise unless the tech explicitly clears
      // the box. Absent/undefined therefore means ON, and only an explicit
      // `false` opts out; the rail itself still checks the gate and that
      // the visit is actually an inspection.
      offerInspectionCredit = true,
      reportReconcileConfirmed = false, // tech confirmed the report/typed-value contradiction prompt
      reentryExteriorMinutes,       // tech-adjusted exterior dry-down minutes — OPTIONAL, see completionReentryPlan
      reentryInteriorMinutes,       // tech-adjusted interior re-entry minutes — OPTIONAL
    } = completionInput.body;
    if (offerInspectionCredit !== true && offerInspectionCredit !== false) {
      return ({ status: 400, body: { error: 'offerInspectionCredit must be a boolean' } });
    }
    if (!VALID_VISIT_OUTCOMES.has(visitOutcome)) {
      return ({ status: 400, body: {
        error: `visitOutcome must be one of: ${Array.from(VALID_VISIT_OUTCOMES).join(', ')}`,
      } });
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
        return ({ status: 400, body: {
          error: 'clientPestRating must be an integer 0-5 (or null/omitted)',
          code: 'client_pest_rating_invalid',
        } });
      }
    }
    // Tech-adjusted re-entry countdown (owner rule 2026-08-11): validated
    // up-front like clientPestRating. An omitted side stays undefined and
    // the advisory keeps its computed default for that side.
    const reentryOverridePlan = completionReentryPlan({
      exteriorMinutes: reentryExteriorMinutes,
      interiorMinutes: reentryInteriorMinutes,
    });
    if (reentryOverridePlan.error) {
      return ({ status: reentryOverridePlan.status, body: reentryOverridePlan.error });
    }
    const zoneShapesError = PropertyZones.validateZoneShapesBody(zoneShapes);
    if (zoneShapesError) {
      return ({ status: 400, body: { error: zoneShapesError, code: 'zone_shapes_invalid' } });
    }
    // Bait station pins/statuses (station-map-v1) — reject malformed entries
    // here, not in the post-commit sync: the sync is fail-soft, so a silent
    // skip there would lose the tech's pins behind a successful completion.
    const stationEntriesError = TermiteStations.validateStationEntriesBody(termiteStations);
    if (stationEntriesError) {
      return ({ status: 400, body: { error: stationEntriesError, code: 'termite_stations_invalid' } });
    }
    if (completionPhotos != null && !Array.isArray(completionPhotos)) {
      return ({ status: 400, body: {
        error: 'completionPhotos must be an array',
        code: 'completion_photos_invalid',
      } });
    }
    if (Array.isArray(completionPhotos) && completionPhotos.length > 5) {
      return ({ status: 400, body: {
        error: 'Maximum 5 completion photos allowed',
        code: 'completion_photos_too_many',
      } });
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
    let completionReviewDelayMinutes;
    try {
      completionReviewDelayMinutes = parseCompletionReviewDelayMinutes(completionInput.body || {});
    } catch (timingErr) {
      // A committed chain replays an immutable body, and by the time a
      // retry lands its custom reviewScheduledFor can legitimately be in
      // the past — the freshness gate must not 400 a committed retry
      // before it can reach the replay/resume claim (codex P2 #3187 r7).
      // The original submit passed the strict gate, so the only reachable
      // failure here is must-be-in-the-future; 0 = "due now" preserves the
      // intent (the chosen time has arrived). Fresh completions keep the
      // strict gate.
      const committed = await CompletionAttempts
        .hasCommittedCompletionAttempt(completionInput.serviceId, db)
        .catch(() => false);
      if (!committed) throw timingErr;
      completionReviewDelayMinutes = 0;
    }
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
    let waveguardInventoryAdvisory = null;
    let waveguardCalibrationCleared = false;
    let waveguardTankCleanout = null;
    let waveguardPlan = null;
    let inventoryDeductions = [];
    let waveguardEquipmentSystemId = equipmentSystemId || null;
    let waveguardCalibrationId = calibrationId || null;
    let treeShrubCloseoutSummary = null;
    let treeShrubCloseoutWarnings = [];
    // billing_mode/per_application_fee ship in migration 20260709000010 —
    // selecting them unconditionally would 500 EVERY completion on a
    // pre-migration database (Codex round-9). Guarded once here; absent
    // columns leave svc.cust_billing_mode undefined = legacy behavior.
    let billingModeColumnsExist = false;
    let customerTierSourceColumnExists = false;
    // Probe FAILURE is not column ABSENCE: absent means a pre-provenance
    // schema (every tier genuinely 'manual'); a failed probe means we don't
    // know, and the tier snapshot must freeze NOTHING rather than 'manual'
    // — or an auto-derived label could be frozen as a paid membership and
    // print "$0.00 billed" forever (codex r13 P1).
    let customerColumnsProbeFailed = false;
    try {
      billingModeColumnsExist = await db.schema.hasColumn('customers', 'billing_mode');
      customerTierSourceColumnExists = await db.schema.hasColumn('customers', 'waveguard_tier_source');
    } catch { customerColumnsProbeFailed = true; /* legacy select shape */ }
    const svc = await db('scheduled_services').where('scheduled_services.id', completionInput.serviceId)
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
      .select(
        'scheduled_services.*',
        'customers.first_name', 'customers.last_name', 'customers.phone as cust_phone', 'customers.email as cust_email',
        'customers.city', 'customers.property_type',
        // Report application-conditions (weather) capture at the TREATED
        // parcel: stamped visit coords first, the primary home only for
        // non-divergent stamps (codex round-10 P2).
        db.raw(`COALESCE(scheduled_services.lat, CASE WHEN NOT ${stampedDivergesSql('scheduled_services', 'customers')} THEN customers.latitude END) as customer_latitude`),
        db.raw(`COALESCE(scheduled_services.lng, CASE WHEN NOT ${stampedDivergesSql('scheduled_services', 'customers')} THEN customers.longitude END) as customer_longitude`),
        'customers.monthly_rate as cust_monthly_rate',
        'customers.waveguard_tier as cust_waveguard_tier',
        ...(customerTierSourceColumnExists ? ['customers.waveguard_tier_source as cust_waveguard_tier_source'] : []),
        ...(billingModeColumnsExist
          ? ['customers.billing_mode as cust_billing_mode', 'customers.per_application_fee as cust_per_application_fee']
          : []),
        'customers.autopay_enabled as cust_autopay_enabled',
        'customers.autopay_paused_until as cust_autopay_paused_until',
        'customers.autopay_payment_method_id as cust_autopay_payment_method_id',
        'customers.ach_status as cust_ach_status',
        'technicians.name as tech_name'
      )
      .first();

    if (!svc) return ({ status: 404, body: { error: 'Service not found' } });

    // Visit-group guard (visit-group-scope.md §5 Gates, rev 5c): a row
    // attached to a non-dissolved visit must complete through the visit
    // sheet — legacy per-row completion alongside the packet worker would
    // double records and side effects. Inert until GATE_VISIT_GROUPS
    // stamping ships (no row carries a visit_id today). The check reads
    // the CURRENT visit status, so an admin "Separate these services"
    // (dissolve) restores per-row completion immediately.
    // This endpoint can mint reports, invoices, inventory deductions, and
    // customer messages. Technicians may only perform that write for their
    // own assigned visit; admins retain office-wide dispatch authority.
    const ownershipError = completionOwnershipError({
      role: completionInput.actor.techRole,
      actorTechnicianId: completionInput.actor.technicianId,
      assignedTechnicianId: svc.technician_id,
    });
    if (ownershipError) {
      return ({ status: ownershipError.status, body: ownershipError.payload });
    }

    // Stale-recap guard: a live job force-rescheduled to a future day
    // (rebooker allowLive) is rewound to a fresh confirmed appointment —
    // a recap submit from a CompletionPanel opened before the reschedule
    // must not complete the future visit. Lifecycle actions only ever
    // run day-of or late (overdue completion), so a future ET date
    // marks the attempt stale. The durable-completion resume path is
    // unaffected: a committed completion can't be rescheduled, so its
    // date is never future. See track-transitions.isFutureScheduledDate.
    if (trackTransitions.isFutureScheduledDate(svc.scheduled_date)) {
      return ({ status: 409, body: {
        error: `This job is now scheduled for ${serviceDateOnly(svc.scheduled_date)} — it was rescheduled while this page was open. Refresh and try again.`,
        code: 'future_scheduled_date',
      } });
    }

    // Backdated quiet completion — validated against the row's own
    // scheduled_date (past days only). `let`: on a crash-resumed retry the
    // body flag has no vote — the frozen structured_notes decide the mode in
    // BOTH directions below (frozenResumeCompletionState), before any
    // send/invoice decision reads it. A disagreeing retry only reaches the
    // resume claim because claimSideEffectsRun matches on the hash's CORE
    // segment — `backfill` lives in the mode segment that only the
    // COMMITTED-record resume ignores (Codex P2 fix round, narrowed round
    // 10: pre-commit same-key retries match the full composite, so the flag
    // can't flip loud↔quiet before a record exists) — hashed everywhere,
    // the mismatch 409'd completion_resume_payload_mismatch and stranded
    // the committed completion before the re-derivation could run.
    const backfillPlan = backfillCompletionPlan({ backfill, scheduledDate: svc.scheduled_date, role: completionInput.actor.techRole });
    if (backfillPlan.error) {
      return ({ status: backfillPlan.status || 400, body: backfillPlan.error });
    }
    let isBackfillCompletion = backfillPlan.active;
    // Backfill trusts a supplied timeOnSite only as sanitized minutes
    // (positive, ≤ the workday cap) — a pre-fix panel auto-submits its
    // running elapsed, i.e. the stale span itself. Sanitized ONCE here so
    // every consumer — the duration policy, the structured_notes stamp
    // (which feeds the report's on-site metric), and the job-costing labor
    // forward — reads the same value or the same absence. Out-of-range
    // degrades to unknown with a log line, never a 400. `let`: on a
    // crash-resumed retry the body value has no vote either — the frozen
    // structured_notes stamp wins (frozenResumeCompletionState below; the
    // hash excludes timeOnSite, so a retry can legally carry the panel's
    // auto-elapsed instead of the committed typed duration).
    // Live override leg (forgotten-closeout fix): a NUMERIC timeOnSite on a
    // non-backfill completion is an admin-typed correction of the running
    // timer — validated fail-closed (403 non-admin, 400 out-of-range) before
    // anything commits. Strings (the panel's auto-elapsed) pass through
    // untouched. Runs AFTER backfillPlan so a technician's backfill body
    // still fails as backfill_admin_only, not time_on_site_admin_only.
    const livePlan = liveTimeOnSitePlan({ timeOnSite, role: completionInput.actor.techRole, backfill: isBackfillCompletion, service: svc });
    if (livePlan.error) {
      return ({ status: livePlan.status, body: livePlan.error });
    }
    const liveAdjustedTimeOnSite = livePlan.adjusted;
    let effectiveTimeOnSite = isBackfillCompletion
      ? backfillTimeOnSiteMinutes(timeOnSite)
      : livePlan.effectiveTimeOnSite;
    if (isBackfillCompletion && effectiveTimeOnSite == null && timeOnSite != null && timeOnSite !== '') {
      logger.warn(`[completion] backfill timeOnSite ${JSON.stringify(timeOnSite)} rejected for service ${svc.id} (not a positive duration ≤ ${BACKFILL_MAX_TIME_ON_SITE_MINUTES}min) — recorded as unknown`);
    }

    // No-show is terminal and non-completable. A completion/recap sheet
    // opened before another dispatcher marked the visit no_show would
    // otherwise mint completion artifacts (and text the customer) for a
    // visit the status machine says was missed — fromStatus is read fresh
    // here, so the transitionJobStatus atomic guard wouldn't catch it.
    // The typed recap path enforces the same via pest-recap's
    // NON_COMPLETABLE_STATUSES.
    if (svc.status === 'no_show') {
      return ({ status: 409, body: {
        error: 'This visit was marked as a no-show and can no longer be completed. Refresh and try again.',
        code: 'service_no_show',
      } });
    }

    // cancelled/skipped are one-way too, and this submit path bypasses the
    // PUT /status terminal guard — a CompletionPanel opened before another
    // dispatcher cancelled or skipped the visit could otherwise flip it
    // back to completed and run the full completion machinery (invoice,
    // customer recap text) for a visit the status machine says never
    // happened. Same non-completable set as pest-recap and
    // project-completion. completed→completed deliberately passes through
    // (evaluateTerminalTransition returns null on same-status) so durable
    // completion resumes and retries keep reaching the stored-response
    // path below.
    {
      const { evaluateTerminalTransition } = require('../services/job-status');
      const terminal = evaluateTerminalTransition(svc.status, 'completed');
      if (terminal?.conflict) {
        return ({ status: 409, body: {
          error: `This visit was already ${terminal.status} and can no longer be completed. Refresh and try again.`,
          code: 'already_terminal',
          status: terminal.status,
        } });
      }
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
    // The profile the completion TRANSACTION actually judged (r32 P2):
    // starts as the pre-lock resolution; the trx re-resolves on a detected
    // update-details repoint (null = repoint detected but re-resolve
    // failed — unknown identity, credit legs fail closed). The post-commit
    // offer leg must use THIS, never the pre-lock snapshot.
    let effectiveCompletionProfile;
    try {
      completionProfile = await resolveCompletionProfileForScheduledService(svc, db);
      effectiveCompletionProfile = completionProfile;
    } catch (err) {
      logger.error(`[dispatch] completion profile lookup failed for ${svc.id}: ${err.message}`);
      return ({ status: 503, body: {
        error: 'Could not verify the completion type for this service. Try again in a moment.',
        code: 'completion_profile_lookup_failed',
      } });
    }
    // Station cap must reject BEFORE the completion commits: the typed
    // counts were auto-filled from every pin the tech can see, so a pin
    // silently dropped later by the fail-soft sync's cap guard would freeze
    // findings the registry and customer map contradict. Sits after profile
    // resolution because the profile picks the PROGRAM (termite vs rodent)
    // whose registry slice the cap applies to; still ahead of every commit.
    // The helper nets the payload exactly the way the sync will (validated
    // retires only, replay-aware creates), so idempotent resumes of an
    // already-committed completion pass straight through to the
    // stored-response path.
    const stationProgram = TermiteStations.stationProgramForProfile(completionProfile);
    if (Array.isArray(termiteStations) && termiteStations.length && stationProgram && svc.customer_id
      && await TermiteStations.stationCapWouldOverflow(db, svc.customer_id, termiteStations, stationProgram)) {
      return ({ status: 400, body: {
        error: `this property is at the ${TermiteStations.MAX_ACTIVE_STATIONS}-station cap — remove extra pins (or retire stations) before completing`,
        code: 'termite_stations_cap',
      } });
    }
    // A declared trap SETUP cannot carry serviced pins: the map relabels
    // `ok` to "Set this visit" but leaves `serviced` saying "Serviced this
    // visit", so the frozen report would contradict its own declared stage.
    //
    // Scoped to the TRAPPING program, and therefore placed here rather than
    // with the shape validation above — a combined profile can resolve to
    // the termite/rodent bait program while a trapping companion declares a
    // setup, and rejecting on the declaration alone blocked a legitimate
    // serviced BAIT-STATION entry (codex P1 — a regression from the first
    // version of this check). `trap_visit_type` only exists on the
    // rodent_trapping schema, so its presence in any submitted section
    // identifies the declaration.
    if (stationProgram === 'trapping' && Array.isArray(termiteStations) && termiteStations.length) {
      const declaresTrapSetup = [
        structuredFindings?.values,
        ...(Array.isArray(companionFindings) ? companionFindings.map((entry) => entry?.values) : []),
      ].some((values) => String(values?.trap_visit_type || '').trim() === 'Initial setup');
      const servicedError = TermiteStations.validateStationEntriesBody(termiteStations, {
        rejectServiced: declaresTrapSetup,
      });
      if (servicedError) {
        return ({ status: 400, body: { error: servicedError, code: 'termite_stations_invalid' } });
      }
    }
    // Rodent consumption consistency (codex r2): station checks recording
    // bait consumption must not ship beside an explicit "None" consumption
    // select — the customer report would contradict itself. Pre-commit like
    // the cap check (the sync is fail-soft and can't reject); incomplete
    // visits skip the station sync entirely, so they skip this too. The
    // rodent findings live on the primary when rodent_bait_station IS the
    // findings type, else on its companion section.
    if (Array.isArray(termiteStations) && termiteStations.length
      && stationProgram === 'rodent' && !isIncompleteVisit) {
      const rodentValues = completionProfile?.findingsType === 'rodent_bait_station'
        ? (structuredFindings?.values || null)
        : ((Array.isArray(companionFindings)
          ? companionFindings.find((entry) => entry?.type === 'rodent_bait_station')
          : null)?.values || null);
      const conflict = TermiteStations.rodentConsumptionConflict({
        program: stationProgram,
        entries: termiteStations,
        findings: rodentValues,
      });
      if (conflict) {
        return ({ status: 400, body: { error: conflict, code: 'rodent_consumption_conflict' } });
      }
    }
    // Trapping analog: a capture-marked trap pin beside an explicit
    // Captures count of 0 contradicts itself on the customer report.
    if (Array.isArray(termiteStations) && termiteStations.length
      && stationProgram === 'trapping' && !isIncompleteVisit) {
      const trappingValues = completionProfile?.findingsType === 'rodent_trapping'
        ? (structuredFindings?.values || null)
        : ((Array.isArray(companionFindings)
          ? companionFindings.find((entry) => entry?.type === 'rodent_trapping')
          : null)?.values || null);
      const conflict = TermiteStations.trapCaptureConflict({
        program: stationProgram,
        entries: termiteStations,
        findings: trappingValues,
      });
      if (conflict) {
        return ({ status: 400, body: { error: conflict, code: 'trap_capture_conflict' } });
      }
    }
    // Pre-submit report reconciliation (GATE_REPORT_RECONCILE_PROMPT,
    // dark): the AI body is generated from the typed fields, the tech can
    // keep editing them afterwards, and nothing re-runs — the render-time
    // guards then silently degrade the copy or a missed pattern publishes
    // a stale number. Surfacing the contradiction HERE lets the tech
    // regenerate or confirm before anything freezes; a confirmed resubmit
    // (same idempotency key — 409s don't reset it client-side) passes
    // through, and the render-time guards remain the backstop.
    {
      const reconcileBlock = reportReconcileBlockPayload({
        isIncompleteVisit,
        reportReconcileConfirmed,
        technicianNotes,
        structuredFindings,
        primaryFindingsType: completionProfile?.findingsType || null,
        primaryActivityScore: activityScore,
        companionFindings,
      });
      // A same-key retry of an ALREADY-COMMITTED completion (lost
      // response, post-commit side-effect failure) must reach the
      // replay/resume claim untouched: the frozen snapshot exists and a
      // confirm cannot change it, so prompting would accept an override
      // the report can never honor (codex P1). Checked only when a block
      // exists — the clean path costs nothing — and a lookup error skips
      // the prompt too (fail open).
      if (reconcileBlock
        && !(await CompletionAttempts.hasCommittedCompletionAttempt(svc.id, db).catch(() => true))) {
        return ({ status: reconcileBlock.status, body: reconcileBlock.payload });
      }
    }
    if (completionProfile?.requiresProject || completionProfile?.projectBacked) {
      return ({ status: 409, body: {
        error: 'This service must be completed through a project.',
        code: 'project_required_completion',
        completionProfile,
      } });
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
      // Untyped completions render the same tech-entered copy on customer
      // reports (observations feed the pest-pressure main-driver line,
      // recommendations feed the recap, captions sit under photos) — the
      // free-text fields must pass the same banned-copy policy as typed
      // forms, or the untyped path becomes a compliance side door (codex
      // pre-push P1 2026-07-30). Internal-only consultations are exempt
      // (codex r7): they mint no customer report, so blocking a staff-only
      // assessment on customer-copy rules would strand valid internal
      // notes — same reasoning as the caption gate's fresh-consultation
      // skip below.
      if (!typedFindingsType && !isIncompleteVisit && !isInternalOnlyCompletion) {
        const untypedCopySources = [
          ...(Array.isArray(observations) ? observations : []),
          ...(Array.isArray(recommendations) ? recommendations : []),
          ...(customerRecap ? [customerRecap] : []),
          ...taggedCompletionNoteLines(technicianNotes, ['next']),
          ...taggedCompletionNoteLines(technicianNotes, ['found']),
          ...(Array.isArray(completionPhotos)
            ? completionPhotos.map((p) => p?.caption).filter(Boolean)
            : []),
          // Per-application targets render verbatim in the report's
          // product purpose copy (ReportViewPage applicationPurposeCopy) —
          // free-form chips are customer copy too (codex P1 #3187 r16).
          ...(Array.isArray(products)
            ? products
                .flatMap((prod) => (Array.isArray(prod?.targets) ? prod.targets : []))
                .filter((t) => typeof t === 'string')
            : []),
        ];
        const untypedViolations = [...new Set(
          untypedCopySources.flatMap((entry) => ActivityIndicators.findBannedCustomerCopy(entry)),
        )];
        if (untypedViolations.length) {
          return {
            status: 422,
            body: {
              error: `This completion contains wording we can't put on a customer report (${untypedViolations.join(', ')}). Describe what was observed and done today instead of absolute claims.`,
              code: 'completion_banned_copy',
              violations: untypedViolations,
            },
          };
        }
        // Report/track egress (AGENTS.md): access/gate/lockbox codes never
        // reach customer-facing reports. These free-text fields render
        // verbatim (pressure driver line, photo captions), so a line that
        // reads like an entry code fails closed instead of persisting.
        if (untypedCopySources.some((entry) => COMPLETION_ACCESS_CODE_RE.test(String(entry || '')))) {
          return {
            status: 422,
            body: {
              error: 'This completion looks like it contains an access, gate, or lockbox code. Keep entry codes out of customer-visible fields — use the internal property notes instead.',
              code: 'completion_access_code',
            },
          };
        }
        // A pre-untype client (panel opened before the deploy, or a restored
        // typed draft) still submits structuredFindings for a now-untyped
        // profile. Accepting it would silently DISCARD the typed data the
        // tech entered (target pest, activity level, treatment...) — make
        // the transition loud instead (codex P2).
        if (structuredFindings != null) {
          return {
            status: 409,
            body: {
              error: 'This service now completes with the standard form. Refresh the page and complete the visit again.',
              code: 'untyped_refresh_required',
            },
          };
        }
      }
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
      // Untyped ALERT-policy lanes (bed_bug post-20260731400000) keep their
      // typed-era billing parity: a performed infestation treatment must
      // mint its invoice, so the no-invoice recap bypass stays closed —
      // keyed on the profile's follow-up semantics, not findings type
      // (codex P1 r7). The untyped pest one-time family (followup 'none')
      // keeps its recap-only option unchanged.
      if (!typedFindingsType && oneTimeRecapOnly && !isIncompleteVisit
        && completionProfile?.followupPolicy === 'alert') {
        return {
          status: 409,
          body: {
            error: 'This service bills per treatment — the no-invoice recap is not available for it.',
            code: 'recap_only_not_allowed',
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
        // Primary T&S: treatments_completed is autoFilled/hidden and derived
        // from products later in this request — a submitted value is a stale
        // pre-cutover draft the tech has no input to change, and validating
        // it here could 400 on contradictions the tech can't fix (codex P2
        // r3). Strip it before validation; derivation re-fills it.
        if (typedFindingsType === 'tree_shrub' && structuredFindings?.values
          && typeof structuredFindings.values === 'object') {
          delete structuredFindings.values.treatments_completed;
        }
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
          // Visit 1 of a two-treatment package owes the included follow-up
          // regardless of findings — "No action needed" would land in the
          // immutable report beside a completion response demanding the
          // second visit (Codex r3). Visit 2 (followup_included) may say it.
          {
            packageFollowupPending: TWO_TREATMENT_PACKAGE_KEYS.has(completionProfile?.serviceKey)
              && svc.followup_included !== true,
          },
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
          // Per-application targets render verbatim in the report's
          // product purpose copy (ReportViewPage applicationPurposeCopy) —
          // free-form chips are customer copy too (codex P1 #3187 r16).
          ...(Array.isArray(products)
            ? products
                .flatMap((prod) => (Array.isArray(prod?.targets) ? prod.targets : []))
                .filter((t) => typeof t === 'string')
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
        // Same access-code egress gate the untyped branch enforces (codex
        // r4): typed completions carry the identical customer-visible
        // free-text surfaces, and an entry code in any of them would
        // persist into the report the same way.
        if (customerCopySources.some((entry) => COMPLETION_ACCESS_CODE_RE.test(String(entry || '')))) {
          return {
            status: 422,
            body: {
              error: 'This completion looks like it contains an access, gate, or lockbox code. Keep entry codes out of customer-visible fields — use the internal property notes instead.',
              code: 'completion_access_code',
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
      profileCategory: completionProfile?.category,
    });
    let typedDeliveryMode = deliveryPosture.typedDeliveryMode;
    let suppressTypedCustomerComms = deliveryPosture.suppressCustomerComms;
    let effectiveSendCompletionSms = sendCompletionSms && !suppressTypedCustomerComms;
    // Backfill = quiet by contract: no completion SMS / report email / review
    // ask regardless of the operator toggles or the delivery posture.
    // (Re-forced after the frozen-posture re-derivation below, which could
    // otherwise un-suppress an auto_send profile on resume.)
    if (isBackfillCompletion) {
      suppressTypedCustomerComms = true;
      effectiveSendCompletionSms = false;
    }
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
    const turfHeightFlagOn = await isUserFeatureEnabled(completionInput.actor.technicianId, 'turf-height-capture', false).catch(() => false);
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
    // Specialty preset lanes replace this list with server-derived metadata
    // once the lane resolves below — the client-supplied scope/treatmentApplied
    // is never persisted for them.
    let reportProtocolActionScopes = (Array.isArray(protocolActionScopesCompleted) ? protocolActionScopesCompleted : [])
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
    const submittedObservations = normalizeCompletionTextArray(
      Array.isArray(observations) ? observations : [],
    );
    const reportObservations = normalizeCompletionTextArray([
      ...submittedObservations,
      ...taggedCompletionNoteLines(technicianNotes, ['found']),
    ]);
    const reportRecommendations = normalizeCompletionTextArray([
      ...(Array.isArray(recommendations) ? recommendations : []),
      ...taggedCompletionNoteLines(technicianNotes, ['next']),
      // parked [Next] lines from the completion screen: internal, same
      // standing as tagged note lines; never in formRecommendations
      ...(Array.isArray(internalRecommendations) ? internalRecommendations.filter((v) => typeof v === 'string') : []),
    ]);
    // Provenance-kept copy of ONLY the form's recommendation field — the
    // merged list above folds in [Next] technician-note lines, and the
    // customer report's "What we recommend" section may never render raw
    // note text (AGENTS.md egress; codex P1 on #3516). Persisted beside
    // the merged list as structured_notes.formRecommendations.
    const formRecommendations = normalizeCompletionTextArray(
      Array.isArray(recommendations) ? recommendations : [],
    );
    // Tips from your tech: the client sends ids (+ an optional line in the
    // tech's own words); the registry copy is resolved and frozen here so
    // the report shows what the customer was told on the day, and a custom
    // line goes through the customer-copy screen like every other verbatim
    // customer string. Ids on the wire, never copy.
    // Gated at the freeze too: with the kill switch unset a stale or crafted
    // client cannot keep the feature alive through the completion body.
    const techTipsFreeze = techTipsGateOn()
      ? freezeTechTips(completionInput.body?.techTips)
      : { tips: [], dropped: [] };
    // Typed lanes (mosquito_event, one-time pest, …) record their work in the
    // typed findings schema, never through the specialty presets, even when
    // their profile key aliases onto a specialty lane (mosquito_one_time →
    // mosquito). The preset checks below apply only to preset closeouts
    // (local audit P1 on #3701).
    const resolvedSpecialtyServiceKey = typedFindingsType ? null : specialtyServiceKey({
      serviceKey: completionProfile?.serviceKey,
      serviceType: svc.service_type,
    });
    // Preset-only protocol actions are enforced when the profile names the
    // lane; a keyless legacy row resolved by display name may still complete
    // with the dynamic actions its older client offered.
    const explicitSpecialtyLane = Boolean(specialtyServiceKey({ serviceKey: completionProfile?.serviceKey }));
    const allowedStructuredObservations = new Set(
      reportServiceLine === 'lawn' && !typedFindingsType
        ? LAWN_STRUCTURED_OBSERVATIONS
        : observationsForSpecialtyService(resolvedSpecialtyServiceKey),
    );
    // New clients separate controlled dropdown values from free text. For an
    // older specialty client that lacks that field, recover only exact values
    // from this service lane's server-owned allowlist; arbitrary form text and
    // [Found] technician-note markers remain internal.
    const structuredObservationsProvided = Object.prototype.hasOwnProperty.call(
      completionInput.body || {},
      'structuredObservations',
    );
    const formObservations = structuredObservationsProvided
      ? normalizeCompletionTextArray(
        Array.isArray(structuredObservations) ? structuredObservations : [],
      )
      : submittedObservations.filter((value) => allowedStructuredObservations.has(value));
    const invalidStructuredObservation = formObservations.find(
      (value) => !allowedStructuredObservations.has(value),
    );
    if (invalidStructuredObservation) {
      return ({ status: 422, body: {
        error: 'A structured observation is not valid for customer report publication.',
        code: 'invalid_structured_observation',
      } });
    }
    // Findings are also checked against the completed protocol actions (a
    // no-work finding beside performed work, or vice versa) and an exclusive
    // inspection/deferred action is rejected beside other preset actions or
    // applied products — none of it may reach the immutable customer report
    // from a stale or direct API client (codex P2 r8 #3701 + local audit).
    const structuredObservationConflict = validateSpecialtyClosureCombination(
      resolvedSpecialtyServiceKey,
      {
        observations: formObservations,
        actions: reportProtocolActions,
        productCount: Array.isArray(products)
          ? products.filter((prod) => prod && typeof prod === 'object').length
          : 0,
        enforcePresetActions: explicitSpecialtyLane,
        // inspection_only / customer_declined bill as not performed (see
        // visitPerformed below) — the report must not publish performed
        // work or applied products beside them (codex r16 P1 on #3701).
        visitOutcome,
      },
    );
    if (structuredObservationConflict) {
      return ({ status: 422, body: {
        error: structuredObservationConflict,
        code: 'conflicting_structured_observations',
      } });
    }
    // The treated areas drive the derived action scope below, so they are
    // validated against the lane first (codex P1 r13 #3701).
    // Product application areas are scope signals too (report-data
    // scopeTextValues) — a restored product can carry a stale area the visit
    // no longer lists, so they face the same lane check (codex P1 r14).
    const productApplicationAreas = (Array.isArray(products) ? products : [])
      .flatMap((prod) => String(prod?.applicationArea || prod?.area || '').split(','))
      .map((area) => area.trim())
      .filter(Boolean);
    const invalidSpecialtyArea = validateSpecialtyAreas(resolvedSpecialtyServiceKey, [...completionAreas, ...productApplicationAreas], {
      enforcePresetAreas: explicitSpecialtyLane,
    });
    if (invalidSpecialtyArea) {
      return ({ status: 422, body: { error: invalidSpecialtyArea, code: 'invalid_specialty_area' } });
    }
    // report-data treats treatmentApplied as authoritative for applicationMade,
    // re-entry and aftercare, so for specialty lanes the persisted metadata is
    // derived from the shared preset (treatmentApplied) and the treated areas
    // (scope) — never from the request body (local audit P1 on #3701).
    const derivedSpecialtyScopes = specialtyProtocolActionScopes(resolvedSpecialtyServiceKey, {
      actions: reportProtocolActions,
      areas: completionAreas,
    });
    if (derivedSpecialtyScopes) {
      // Legacy dynamic actions a keyless row still carries keep their
      // client-supplied scope entry; every preset label is server-derived.
      const derivedLabels = new Set(derivedSpecialtyScopes.map((entry) => entry.label));
      reportProtocolActionScopes = [
        ...derivedSpecialtyScopes,
        ...reportProtocolActionScopes.filter((entry) => entry.label
          && !derivedLabels.has(entry.label)
          && reportProtocolActions.includes(entry.label)),
      ];
    }
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

    const rawIdempotencyKey = completionInput.idempotencyKey || bodyIdempotencyKey
      || `legacy_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
    const idempotencyKey = String(rawIdempotencyKey).trim().slice(0, 120);
    // The claim commits while THIS request holds the row's stop advisory
    // lock (codex #3590 r12 P1): stamping (visit-groups.createOrJoinVisit)
    // checks for live claims and stamps under the same lock, so the claim
    // can no longer land between stamping's READ COMMITTED snapshot and its
    // commit. The claim runs ON the lock transaction's connection (r13: a
    // nested root-pool checkout under a burst could exhaust the pool) —
    // its INSERT is savepoint-wrapped inside claimCompletionAttempt so the
    // unique-violation recovery path survives. lockStopForRow revalidates
    // the stop key under the lock and throws VISIT_STOP_MOVED on a
    // concurrent reschedule (r13) — retried like the recheck below.
    let claim = null;
    let ownedPacketVisitId = null;
    for (let lockAttempt = 0; lockAttempt < 3; lockAttempt += 1) {
      try {
        claim = await db.transaction(async (lockTrx) => {
          await require('../services/visit-groups').lockStopForRow(lockTrx, svc.id);
          // The guard must precede replay/resume too: a saved packet member
          // has a resumable single-service attempt, whose legacy side effects
          // would otherwise invoice and message the customer independently.
          const member = await lockTrx('scheduled_services').where({ id: svc.id }).first('visit_id');
          const packet = member?.visit_id
            ? await lockTrx('visit_completion_packets').where({ visit_id: member.visit_id }).first('id', 'status')
            : null;
          const ownedItem = packetRecord && packet?.status === 'processing'
            ? await lockTrx('visit_completion_packet_items').where({
              id: packetRecord.itemId, packet_id: packet.id,
              scheduled_service_id: svc.id, status: 'processing',
              derived_idempotency_key: idempotencyKey,
            }).first('id')
            : null;
          if ((packet || packetRecord) && !ownedItem) {
            return { action: 'conflict', status: 409, payload: {
              error: 'This service is owned by a visit closeout. Resume the visit closeout.',
              code: 'visit_grouped', visitId: member?.visit_id || null,
            } };
          }
          ownedPacketVisitId = ownedItem ? member.visit_id : null;
          return CompletionAttempts.claimCompletionAttempt({
            serviceId: svc.id,
            idempotencyKey,
            requestHash: CompletionAttempts.hashCompletionRequest(completionInput.body),
          }, lockTrx);
        });
        break;
      } catch (lockErr) {
        if (lockErr && lockErr.code === 'VISIT_STOP_MOVED' && lockAttempt < 2) continue;
        throw lockErr;
      }
    }
    if (claim.action === 'conflict') return ({ status: claim.status, body: claim.payload });
    if (packetRecord && claim.action !== 'proceed') {
      return { status: 409, body: { code: 'visit_member_already_recorded', error: 'Resume the saved visit closeout.' } };
    }
    if (claim.action === 'replay') {
      // A prior success whose fire-and-forget dissolve failed transiently
      // would otherwise never be repaired (codex r10): re-run the fresh-
      // read dissolve on every replay — no-op unless the row still sits
      // on an open packet-less visit.
      void db('scheduled_services').where({ id: svc.id }).first('visit_id')
        .then((nowRow) => (nowRow && nowRow.visit_id
          ? require('../services/visit-groups').dissolveForLegacyCompletion(nowRow.visit_id, { expectChildId: svc.id })
          : null))
        .catch(() => {});
      return ({ status: 200, body: claim.payload });
    }
    completionAttempt = claim.attempt;
    const resumingCommittedCompletion = claim.action === 'resume';
    // The prior run released the attempt itself (the SMS / token-mint /
    // mint-failure 503s) rather than dying mid-flight: none of its lanes is
    // still running, so a 'sending' marker it failed to clear is stale.
    const resumingReleasedCompletion = resumingCommittedCompletion && claim.releasedForResume === true;

    // Visit-group membership re-check, now that the durable claim is
    // committed (codex r2 P0). Stamping (visit-groups.js) locks the row
    // FOR UPDATE and then refuses rows with a live claim, so taking the
    // same row lock here and re-reading membership closes every
    // interleaving: either stamping saw our claim and refused, or we see
    // its committed stamp here and stop before any side effect.
    if (claim.action === 'proceed') {
      const visitRecheck = async (trx) => {
        // Lock ORDER matches stamping (codex #3590 r2 P1): stop advisory
        // lock FIRST, then the row lock — with the peek → lock → verify →
        // retry pattern from createOrJoinVisit (r3 P1: the svc snapshot is
        // thousands of lines stale; a concurrent reschedule can have moved
        // the row under another stop key).
        const { stopBaseKey } = require('../services/visit-groups');
        const peek = await trx('scheduled_services').where({ id: svc.id })
          .first('property_id', 'customer_id', 'scheduled_date');
        if (!peek) return null;
        const baseKey = stopBaseKey({
          propertyId: peek.property_id,
          customerId: peek.customer_id,
          scheduledDate: peek.scheduled_date,
        });
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['visit.stop', baseKey]);
        const lockedRow = await trx('scheduled_services')
          .where({ id: svc.id }).forUpdate()
          .first('visit_id', 'property_id', 'customer_id', 'scheduled_date');
        if (!lockedRow) return null;
        const lockedKey = stopBaseKey({
          propertyId: lockedRow.property_id,
          customerId: lockedRow.customer_id,
          scheduledDate: lockedRow.scheduled_date,
        });
        if (lockedKey !== baseKey) {
          const moved = new Error('visit stop moved concurrently');
          moved.code = 'VISIT_STOP_MOVED';
          throw moved;
        }
        if (!lockedRow.visit_id) return null;
        const parent = await trx('service_visits')
          .where({ id: lockedRow.visit_id }).first();
        if (!parent) return { blockedBy: lockedRow.visit_id }; // orphan: fail closed
        if (ownedPacketVisitId === parent.id) return parent.status === 'closing' ? null : { blockedBy: parent.id };
        if (String(parent.status) === 'dissolved') return null;
        // READ-ONLY (codex #3590 r4: later validators can still 422, and a
        // rejected completion must not have dissolved anything): an open
        // packet-less visit is allowed through and remembered — the
        // dissolve runs only after the completion durably commits
        // (dissolveForLegacyCompletion at the durable-commit sites). The
        // committed claim keeps stamping/packets away in the meantime.
        if (String(parent.status) === 'open') {
          const packet = await trx('visit_completion_packets')
            .where({ visit_id: parent.id }).first('id');
          if (!packet) return { legacyVisitId: parent.id };
        }
        return { blockedBy: parent.id };
      };
      let recheckOutcome = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          recheckOutcome = await db.transaction(visitRecheck);
          break;
        } catch (recheckErr) {
          if (recheckErr && recheckErr.code === 'VISIT_STOP_MOVED' && attempt < 2) continue;
          throw recheckErr;
        }
      }
      if (recheckOutcome && recheckOutcome.blockedBy) {
        await CompletionAttempts.markCompletionAttemptFailed(
          completionAttempt,
          new Error('visit_grouped'),
          db,
        ).catch(() => {});
        return ({ status: 409, body: {
          error: 'This service is part of a grouped visit — complete it from the visit sheet, or use "Separate these services" first.',
          code: 'visit_grouped',
          visitId: recheckOutcome.blockedBy,
        } });
      }
      if (recheckOutcome && recheckOutcome.legacyVisitId) {
        legacyVisitToDissolve = recheckOutcome.legacyVisitId;
      }
    }

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
        db,
      );
      return ({ status: 422, body: photoCaptionBannedCopyPayload(captionBannedViolations) });
    }
    // Tips from your tech — deferred like the caption gate above: a
    // rejected pick (retired id, over cap, or a custom line the copy screen
    // refuses) is an actionable 400 for a FRESH attempt, before any write;
    // a same-key replay/resume keeps returning the stored completion even
    // if the library changed since. Nothing the tech was told would print
    // may vanish silently.
    if (claim.action === 'proceed' && techTipsFreeze.dropped.length) {
      const drop = techTipsFreeze.dropped[0];
      logger.warn(`[tech-tips] pick rejected on ${completionInput.serviceId}: ${drop.violations.join(', ')}`);
      await CompletionAttempts.markCompletionAttemptFailed(
        completionAttempt,
        new Error('tech_tip_rejected'),
        db,
      ).catch(() => {});
      const overCap = drop.violations.includes('over_cap');
      const unknownTip = drop.violations.includes('unknown_tip');
      const tooLong = drop.violations.includes('too_long') || drop.violations.includes('multi_sentence');
      return ({ status: 400, body: {
        error: unknownTip
          ? 'One of the picked tips is no longer in the library. Remove it, pick again, then complete.'
          : overCap
            ? 'Only three tips fit on the report. Remove one, then complete.'
            : tooLong
              ? 'Your own tip needs to be one sentence (up to 240 characters) — it prints as one tip. Shorten it, then complete.'
              : `Your own tip needs different wording before the report can print it (flagged: ${drop.violations.join(', ')}). Reword it, then complete.`,
        code: unknownTip ? 'TECH_TIP_UNKNOWN' : overCap ? 'TECH_TIP_OVER_CAP' : tooLong ? 'TECH_TIP_TOO_LONG' : 'TECH_TIP_COPY_REJECTED',
        techTip: { ...(drop.id ? { id: drop.id } : {}), ...(drop.copy ? { copy: drop.copy } : {}), violations: drop.violations },
      } });
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
          db,
        );
        return ({ status: 422, body: internalOnlyProductsBlock });
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
            db,
          );
          return ({ status: lawnAssessmentCompletionBlock.status, body: lawnAssessmentCompletionBlock.payload });
        }
      }

      const typedValidationError = runTypedValidation();
      if (typedValidationError) {
        await CompletionAttempts.markCompletionAttemptFailed(
          completionAttempt,
          new Error(typedValidationError.body.code),
          db,
        );
        return ({ status: typedValidationError.status, body: typedValidationError.body });
      }
      const companionValidationError = runCompanionValidation();
      if (companionValidationError) {
        await CompletionAttempts.markCompletionAttemptFailed(
          completionAttempt,
          new Error(companionValidationError.body.code),
          db,
        );
        return ({ status: companionValidationError.status, body: companionValidationError.body });
      }
      // Gauge reading: OPTIONAL on a flagged lawn visit. The tech may close with
      // no height and/or no photo. Only a PROVIDED out-of-range value is rejected
      // (the reading drives the report's mowing status). Validated here — after
      // replay/conflict handling — so a retry of an already-completed visit
      // replays instead of 422-ing.
      if (turfHeightApplicable && manualHeightIn != null && !isValidHeight(manualHeightIn)) {
        await CompletionAttempts.markCompletionAttemptFailed(completionAttempt, new Error('turf_height_invalid'), db);
        return ({ status: 422, body: {
          error: 'Turf height must be between 0.5 and 8 inches.',
          code: 'turf_height_invalid',
        } });
      }
    }

    // One-time billing profile — the population whose completion mints the
    // visit invoice through the in-transaction invoice decision
    // (shouldAutoInvoiceCompletion's typedOneTimeBilling input). Keyed to
    // the PROFILE's billing_type, not to whether the completion form is
    // typed: untyping a one-time service's form (the 2026-07-30 pest
    // untype migration) must not silently turn off its billing (codex P1).
    const typedOneTimeBillingProfile = !isIncompleteVisit
      && !recapReviewOnly
      && String(completionProfile?.billingType || '').toLowerCase() === 'one_time'
      && svc.followup_included !== true;
    // Hoisted here (from the invoice block below) so the commit-time
    // REQUIRED-mint posture can read the same authorities the invoice
    // decision reads — one derivation each, no drift.
    const hasVisitPrice = svc.estimated_price != null && Number(svc.estimated_price) > 0;
    // inspection_only / customer_declined = no application performed —
    // nothing bills for the visit (mirrors referralVisitPerformed;
    // 'incomplete' returns early below). Shared by the auto-invoice gate AND
    // the auto-charge block: an existing open invoice (pre-minted /
    // recovery) must not be auto-charged either when nothing was performed
    // (Codex round-9 P1).
    const visitPerformed = visitOutcome !== 'inspection_only' && visitOutcome !== 'customer_declined';
    // Billing-lane classification + the completion invoice amount — hoisted
    // from the invoice block below for the same one-derivation reason (fix
    // round 9): the commit-time posture must read the EXACT inputs the mint
    // decision's branches read, or the two drift. Estimate-flow customers
    // bill PER VISIT (owner ruling 2026-07-09); annual-prepay customers
    // settle covered visits via prepaid stamps (Codex round-5 P1); callbacks
    // never fall back to the monthly rate, and per-application precedence is
    // explicit visit price → acceptance fee → nothing (see
    // completionInvoiceAmount in billing-lane.js).
    const perApplicationBilling = svc.cust_billing_mode === 'per_application';
    const annualPrepayBilling = svc.cust_billing_mode === 'annual_prepay';
    const explicitMembershipLane = svc.cust_billing_mode === 'monthly_membership';
    const explicitPerVisitLane = ['per_visit', 'one_time'].includes(svc.cust_billing_mode);
    const invoiceAmount = completionInvoiceAmount({
      estimatedPrice: svc.estimated_price,
      isCallback: svc.is_callback,
      perApplicationBilling,
      perApplicationFee: svc.cust_per_application_fee,
      monthlyRate: svc.cust_monthly_rate,
      billingMode: svc.cust_billing_mode,
    });
    // The inspection-credit amount is resolved from the LOCKED row inside
    // the completion transaction (below), never from this pre-lock read: a
    // price edit committing between here and the lock would otherwise
    // freeze stale terms (uncapped audit P0 on #3521). The serviceData
    // literal carries the configured fee as a placeholder that the locked
    // pass always overwrites for an eligible inspection.
    // Third-party Bill-To resolution — moved ABOVE the tax freeze (codex
    // pre-push P0): the frozen completion rate must be derived for the
    // entity that OWES it. Resolving the payer after freezing let a service
    // customer's verified exemption zero the rate, and that explicit 0 then
    // underbilled a non-exempt payer's AP invoice (payer invoices skip the
    // customer-exemption check by design). resolveForInvoice never throws
    // (falls back to self-pay), and any lookup error keeps the existing
    // self-pay flow.
    // Fail CLOSED here (pre-push P0 r2): a silent self-pay fallback would
    // freeze the customer-exempt 0, and if create() later resolves the real
    // non-exempt payer that explicit 0 is honored — underbilling the AP
    // invoice. throwOnError surfaces the lookup failure BEFORE any money is
    // frozen; the completion errors loud and is simply retried.
    // Resume tolerance (codex r5 P1): a committed RESUME's money authority
    // is the FROZEN contract — a live lookup failure must not block it
    // indefinitely. On resume the error is captured instead of thrown; the
    // mint block fail-closes at the point of need if the frozen contract
    // turns out incomplete. First runs (the freeze) stay strictly
    // fail-closed.
    let completionResolvedPayer = null;
    let completionTaxAuthorityError = null;
    try {
      completionResolvedPayer = await require('../services/payer').resolveForInvoice({
        customerId: svc.customer_id,
        scheduledServiceId: svc.id,
        throwOnError: true,
      });
    } catch (payerErr) {
      // First runs fail CLOSED (codex r10 P0): the payer identity feeds the
      // coverage suppressors and the money posture about to be FROZEN — a
      // fail-soft self-pay fallback could let membership dues "cover" a
      // payer-billed visit, freeze required=false, and finalize the
      // closeout without the payer invoice (lost AR). A committed RESUME
      // reads the frozen contract instead: the error is captured and the
      // suppressors below treat the authority as UNKNOWN (never suppress).
      // Completions that categorically CANNOT bill — recap-only, or no
      // application performed (inspection_only / customer_declined) — are
      // exempt (codex GH r2 P1): every billing gate suppresses their mint
      // regardless of the payer, so a transient lookup blip must not block
      // closing a never-billing visit.
      // …and completions with NO billable amount (GH r3 P1): the amount
      // guard in the invoice decision categorically rejects
      // invoiceAmount <= 0, so no invoice or tax authority can ever be
      // needed for an unpriced/free visit either.
      const completionCannotBill = recapReviewOnly || !visitPerformed || !(Number(invoiceAmount) > 0);
      if (!resumingCommittedCompletion && !completionCannotBill) throw payerErr;
      logger.warn(`[dispatch] payer resolve failed on completion for service ${svc.id} (${resumingCommittedCompletion ? 'resume — frozen contract governs' : 'non-billing completion'}) — coverage suppressors disabled: ${payerErr.message}`);
      completionTaxAuthorityError = payerErr;
    }
    // UNKNOWN payer authority on a resume counts as payer-billed for every
    // coverage suppressor (r10 P0): payer visits are excluded from customer
    // autopay/prepaid coverage, so "unknown" must fail toward BILLING —
    // never toward a suppressor swallowing a possible payer invoice. The
    // mint itself still resolves fail-closed under the frozen contract.
    const visitIsPayerBilled = completionTaxAuthorityError
      ? true
      : !!completionResolvedPayer?.payerId;
    const completionPayerTaxExempt = visitIsPayerBilled && completionResolvedPayer?.taxExempt === true;
    // The mint's TAX basis — LAZY since codex r6 P1: recap-only,
    // dues-covered, prepaid, and inspection-only completions never need a
    // rate, so a tax-table blip must not block them. Derived (memoized) the
    // first time an invoice-bearing path asks: the commit-time freeze for a
    // REQUIRED posture, or the live mint fallback. CALCULATOR-derived
    // (was a flat per-property_type hard-code): TaxCalculator owns verified
    // exemptions, service_taxability, and county tax_rates, and treats
    // `business` property_type as commercial. Fail CLOSED on any failure
    // (r3 P0): no flat-rate guess is ever frozen or minted — a payer or
    // tax lookup failure surfaces to the asking path (required lanes
    // release for resume; non-required lanes keep their non-blocking
    // failure posture).
    let completionTaxDerivation = null;
    const deriveCompletionTaxRate = () => {
      if (!completionTaxDerivation) {
        completionTaxDerivation = (async () => {
          if (completionTaxAuthorityError) throw completionTaxAuthorityError;
          // Payer-billed: the payer's own tax_exempt flag governs. Exempt
          // payer → 0; non-exempt payer → county/service rate with the
          // service customer's certificate EXCLUDED (skipCustomerExemption).
          if (completionPayerTaxExempt) return 0;
          // Residential-zero policy (r11 P0): InvoiceService.create forces
          // tax to zero for non-commercial customers regardless of
          // taxability rows — the frozen rate must encode the same rule,
          // or a required residential completion would freeze a county
          // rate that create's frozen authority then honors.
          if (!['commercial', 'business'].includes(svc.property_type)) return 0;
          const TaxCalculator = require('../services/tax-calculator');
          const taxResult = await TaxCalculator.calculateTax(
            svc.customer_id,
            svc.service_type,
            Number(invoiceAmount) || 0,
            visitIsPayerBilled ? { skipCustomerExemption: true } : {},
          );
          const r = Number(taxResult?.rate);
          if (Number.isFinite(r) && r >= 0 && r < 1) return r;
          throw new Error(`completion tax derivation returned unusable rate ${taxResult?.rate} for service ${svc.id} — refusing to freeze a guessed rate`);
        })();
      }
      return completionTaxDerivation;
    };
    // Third-party Bill-To + membership dues coverage — hoisted from the
    // invoice block below (fix round 12): dues coverage is a COMMIT-TIME
    // business suppressor, and the frozen posture must read the REAL value
    // (a covered visit owes no mint — freezing required=true would let a
    // crash-resume after a dues/autopay change surprise-bill covered
    // membership work). Every input here is knowable at the freeze point:
    // svc-loaded aliases plus two plain reads (payer resolution — now
    // performed ABOVE the tax freeze, see visitIsPayerBilled;
    // payment_methods for the chargeable autopay method) on rows the
    // completion transaction never writes. A payer-billed visit is owed by
    // the payer's AP inbox, so the customer's autopay/prepay must neither
    // suppress the AP invoice nor be credited against it — payer resolves
    // FIRST so every coverage gate can exclude payer visits.
    const customerAutopayActive = await customerOnAutopay({
      id: svc.customer_id,
      autopay_enabled: svc.cust_autopay_enabled,
      autopay_paused_until: svc.cust_autopay_paused_until,
      autopay_payment_method_id: svc.cust_autopay_payment_method_id,
      ach_status: svc.cust_ach_status,
    });
    // Dues already collected for the VISIT's month (ET, keyed on the row's
    // scheduled_date; noon-Z anchor keeps the ET month stable) cover a
    // membership visit even when autopay has since lapsed — the cron charged
    // the dues on the 1st, so a mid-month card expiry / autopay pause must
    // not mint a full monthly_rate invoice on every remaining plan visit.
    // Only looked up where membership coverage is still reachable; a lookup
    // error falls back to the autopay-only decision (never widens coverage).
    let duesCollectedThisMonth = false;
    if (!customerAutopayActive && !visitIsPayerBilled && !perApplicationBilling && !annualPrepayBilling
      && (explicitMembershipLane || (!svc.cust_billing_mode && isMembershipTier(svc.cust_waveguard_tier)))) {
      try {
        duesCollectedThisMonth = await monthlyDuesCollected(
          db, svc.customer_id, new Date(`${serviceDateOnly(svc.scheduled_date)}T12:00:00Z`),
        );
      } catch (e) {
        logger.warn(`[dispatch] dues-collected lookup failed on completion for service ${svc.id}: ${e.message}`);
      }
    }
    const autopayCoversVisit = membershipDuesCoverVisit({
      visitIsPayerBilled,
      perApplicationBilling,
      annualPrepayBilling,
      customerAutopayActive,
      duesCollectedThisMonth,
      hasVisitPrice,
      isRecurring: svc.is_recurring,
      waveguardTier: svc.cust_waveguard_tier,
      monthlyRate: svc.cust_monthly_rate,
      billingMode: svc.cust_billing_mode,
    });
    // Commit-time REQUIRED-mint posture (Codex P0, fix round 8; broadened
    // fix round 9). The posture reads MUTABLE billing state — the typed
    // profile (completionProfile.billingType via typedOneTimeBillingProfile),
    // the scheduler's create_invoice_on_complete flag, the customer's
    // billing_mode/tier/rate — none of which the request hash can pin. This
    // value, derived while that state is what the operator saw, is FROZEN
    // into structured_notes inside the completion transaction (next to
    // backfill/timeOnSite); a resumed retry reads the frozen posture back
    // instead of recomputing, so an edit between a released required-mint
    // failure and the retry can neither drop the owed mint nor invent a new
    // one. Broadened (Codex P1, fix round 9): the posture is now the FULL
    // will-mint decision at commit — every backfill shape the mint decision
    // would bill (typed one-time, scheduler-flag, monthly-rate/tier,
    // explicit lanes, gated priced visits) freezes REQUIRED, so a transient
    // mint failure on ANY expected mint fail-closes instead of finalizing
    // an unbilled closeout through the non-blocking catch. Dues coverage
    // participates as a real input (fix round 12): a covered visit freezes
    // NOT-required — no mint was ever owed for it.
    const backfillMintRequiredAtCommit = backfillExpectedMintAtCommit({
      isBackfillCompletion,
      recapReviewOnly,
      autopayCoversVisit,
      createInvoiceOnComplete: svc.create_invoice_on_complete,
      waveguardTier: svc.cust_waveguard_tier,
      explicitMembership: explicitMembershipLane,
      explicitPerVisitLane,
      perApplicationBilling,
      annualPrepayBilling,
      hasVisitPrice,
      invoiceAmount,
      autoInvoicePricedVisits: process.env.GATE_AUTOINVOICE_PRICED_VISITS === 'true',
      serviceType: svc.service_type,
      isCallback: svc.is_callback,
      visitPerformed,
      typedOneTimeBilling: typedOneTimeBillingProfile,
    });
    // The freeze's tax basis (r6 P1: derived ONLY when a REQUIRED posture
    // will actually stamp frozen money — recap-only/covered/non-invoiced
    // completions never run the calculator). First-run only: a resume never
    // stamps (no transaction runs) and reads the frozen contract instead.
    // Fail-closed by derivation: a payer/tax lookup failure blocks the
    // commit BEFORE any money is frozen.
    const completionInvoiceTaxRate = backfillMintRequiredAtCommit && !resumingCommittedCompletion
      ? await deriveCompletionTaxRate()
      : null;
    // The EFFECTIVE posture the invoice decision and the fail-closed catch
    // read: first run = the live commit-time derivation above; the resume
    // block overwrites it with the FROZEN structured_notes posture before
    // any consumer runs.
    let backfillReviewMintRequired = backfillMintRequiredAtCommit;
    // The required mint's FROZEN money (Codex P0, fix round 10): null on
    // first run — the live derivations above ARE the commit values the
    // freeze stamps — and populated from the frozen structured_notes on
    // resume. The mint block prefers these whenever the effective posture is
    // REQUIRED, so a price cleared/edited (or property_type flipped) between
    // a released mint failure and the retry can neither skip the owed
    // invoice via the amount guard nor mint a different amount.
    let backfillFrozenMintAmount = null;
    let backfillFrozenMintTaxRate = null;
    // r4 P0: the frozen Bill-To identity beside the money. undefined until a
    // frozen resume restores it (or on first run, where the live
    // completionResolvedPayer is the same derivation the freeze stamps).
    let backfillFrozenMintPayerId;
    // The typed one-time billing pre-gate (409 completion_billing_required →
    // checkout detour) was REMOVED by owner ruling 2026-07-27: it blocked
    // techs from completing one-time jobs the completion itself was about to
    // bill. The typed population now bills through the same in-transaction
    // invoice decision as every other lane — shouldAutoInvoiceCompletion's
    // typed one-time branch runs LIVE as well as under backfill, minting the
    // completion invoice (pay link rides the completion SMS). Suppressors
    // (already-paid, pre-minted, existing invoice incl. the estimate
    // first-application invoice, prepaid/autopay coverage) still win, so
    // already-billed work never double-mints. The gate's fail-closed
    // money-correctness promise moved to the mint: for this population the
    // posture freezes REQUIRED (backfillExpectedMintAtCommit's live leg)
    // and a mint failure releases the attempt for resume instead of
    // finalizing the visit unbilled.

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
        await CompletionAttempts.markCompletionAttemptFailed(completionAttempt, validationErr, db);
        return ({ status: 400, body: {
          error: 'Tree/Shrub protocol closeout required',
          code: 'tree_shrub_closeout_lockout',
          details: treeShrubValidation.blocks.map((block) => block.message),
          blocks: treeShrubValidation.blocks,
          warnings: treeShrubValidation.warnings,
        } });
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
          await CompletionAttempts.markCompletionAttemptFailed(completionAttempt, new Error('tree_shrub_catalog_lookup_failed'), db);
          return ({ status: 503, body: {
            error: 'Could not verify the recorded products against the catalog. Try again in a moment.',
            code: 'tree_shrub_catalog_lookup_failed',
          } });
        }
        if (typedProductRows.length < submittedProductIds.length) {
          const found = new Set(typedProductRows.map((row) => String(row.id)));
          await CompletionAttempts.markCompletionAttemptFailed(completionAttempt, new Error('tree_shrub_unknown_products'), db);
          return ({ status: 400, body: {
            error: 'Some recorded products were not found in the catalog — refresh the product list and try again.',
            code: 'tree_shrub_unknown_products',
            details: submittedProductIds.filter((id) => !found.has(String(id))),
          } });
        }
      }
      // The simplified closeout hides the treatments field on PRIMARY T&S
      // completions — derive the chips from the recorded products (with
      // catalog rows, loaded and fail-closed above) so the compliance rules,
      // snapshot, and narrative keep their exact chip vocabulary. ALWAYS
      // derive on the primary path: the field is autoFilled/hidden there, so
      // any submitted value is a stale restored draft from before the
      // cutover (codex P2 r1). COMBINED visits (tree_shrub as a COMPANION
      // section) are excluded: the completion payload has ONE shared
      // products list with no per-line attribution, so deriving would pull
      // lawn-only products into the T&S snapshot (codex P2 r2) — the
      // companion form renders the treatments dropdown instead and the
      // tech's selection stands. Mutating the values object in place feeds
      // the typed report snapshot built later from the same reference.
      if (typedFindingsType === 'tree_shrub') {
        treeShrubComplianceValues.treatments_completed = deriveTreeShrubTreatments({
          products: products || [],
          productRows: typedProductRows,
        });
        // (The pre_emergent_applied contradiction check retired with the bed
        // module fields — owner directive 2026-07-23. Detail application
        // fields no longer exist on the T&S form, so derivation is the only
        // source of treatment claims on the primary path.)
      }
      // The cross-field contradiction rules ran on the pre-derivation values —
      // re-run them so a derived 'Inspection only' can't sit beside an
      // applied-treatment detail field (e.g. pre-emergent marked Yes with
      // zero products recorded). Companion context must ride along: when the
      // values came from a tree_shrub COMPANION section they legally carry
      // the companionOnly detail fields, which primary-context validation
      // rejects as unknown — that would 400-block every combo completion
      // that recorded condition detail (codex P2 r2 on #2950).
      {
        const derivedValidation = ActivityIndicators.validateTypedFindings({
          type: 'tree_shrub',
          values: treeShrubComplianceValues,
          expectedType: 'tree_shrub',
          enforceRequired: false,
          companion: typedFindingsType !== 'tree_shrub',
        });
        if (!derivedValidation.ok) {
          await CompletionAttempts.markCompletionAttemptFailed(completionAttempt, new Error('tree_shrub_derived_contradiction'), db);
          return ({ status: 400, body: {
            error: 'The recorded products contradict the visit detail fields',
            code: 'typed_findings_invalid',
            details: derivedValidation.errors,
            missing: [],
          } });
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
        await CompletionAttempts.markCompletionAttemptFailed(completionAttempt, complianceErr, db);
        return ({ status: 400, body: {
          error: 'Tree & Shrub compliance checks must pass before completion',
          code: 'tree_shrub_typed_compliance',
          details: typedCompliance.blocks.map((block) => block.message),
          blocks: typedCompliance.blocks,
          warnings: typedCompliance.warnings,
        } });
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
        // Advisory record only — no acknowledgment claim. The closeout no
        // longer displays a calibration confirm step, so stamping
        // "acknowledged" here would assert the tech consciously accepted a
        // warning that was never shown (Codex P2, PR #3022 round 1).
        waveguardCalibrationAdvisory = {
          advisory: true,
          recordedByTechnicianId: completionInput.actor.technicianId,
          recordedByRole: completionInput.actor.techRole || null,
          recordedAt: new Date().toISOString(),
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
      // Advisory, not a lockout (owner directive 2026-07-29: approval
      // ceremonies removed from the closeout). Approval semantics require
      // BOTH an explicit approval payload (legacy client) AND an admin
      // actor — a tech-submitted or stale payload records as advisory, so
      // the audit history can't present an unapproved closeout as approved.
      if (blackoutBlocks.length) {
        const mappedBlackoutBlocks = blackoutBlocks.map((block) => ({
          code: block.code,
          message: block.message,
          source: block.source || null,
        }));
        waveguardBlackoutApproval = (normalizedOfficeApproval && completionInput.actor.techRole === 'admin')
          ? {
            ...normalizedOfficeApproval,
            approvedByTechnicianId: completionInput.actor.technicianId,
            approvedByRole: completionInput.actor.techRole || null,
            approvedAt: new Date().toISOString(),
            blocks: mappedBlackoutBlocks,
          }
          : {
            advisory: true,
            recordedByTechnicianId: completionInput.actor.technicianId,
            recordedByRole: completionInput.actor.techRole || null,
            recordedAt: new Date().toISOString(),
            blocks: mappedBlackoutBlocks,
          };
      }
      const annualNBlocks = annualNLockoutBlocks(plan);
      // The plan's annualN only reflects PLANNED items. With the hard gate
      // gone, the tech can add or upsize nitrogen products, so recompute the
      // projection from the SUBMITTED actuals — otherwise a ledger-crossing
      // application would complete with no advisory and no audit record.
      const actualAnnualNBlocks = [];
      try {
        const annualN = plan?.propertyGate?.annualN || null;
        const lawnSqft = Number(plan?.propertyGate?.lawnSqft || 0);
        const limit = Number(annualN?.limit);
        // The catalog scan runs whenever products were submitted — the
        // unquantified-unit detection must NOT hide behind the area/limit
        // gate (an incomplete turf profile is exactly when quantification
        // is unavailable and the gap most needs surfacing).
        if (Array.isArray(products) && products.length) {
          const ids = [...new Set(products.map((p) => p.productId).filter(Boolean))];
          const catalogRows = ids.length
            ? await db('products_catalog').whereIn('id', ids).select('id', 'name', 'analysis_n')
            : [];
          const catalogById = new Map(catalogRows.map((row) => [String(row.id), row]));
          let actualVisitN = 0;
          const unquantifiedNProducts = [];
          for (const p of products) {
            const catalog = catalogById.get(String(p.productId));
            if (!catalog || Number(catalog.analysis_n || 0) <= 0) continue;
            // Same normalization the persistence path uses: a "/gal" unit is
            // a mix concentration whose total is concentrate amount.
            const pounds = amountToPounds(p.totalAmount, baseQuantityUnit(p.amountUnit || p.rateUnit || null));
            if (pounds == null) {
              // Fluid-volume amounts can't convert to lb N without a per-
              // product density — the entire annual-N system (nutrient
              // ledger and plan projection share amountToPounds) excludes
              // them. Never SILENTLY: surface the gap as its own advisory
              // instead of inventing a density here.
              unquantifiedNProducts.push(catalog.name || 'nitrogen product');
            } else if (lawnSqft > 0) {
              actualVisitN += (pounds * (Number(catalog.analysis_n) / 100)) / (lawnSqft / 1000);
            }
          }
          const used = Number(annualN?.used || 0);
          if (Number.isFinite(limit) && limit > 0 && actualVisitN > 0 && used + actualVisitN > limit) {
            actualAnnualNBlocks.push({
              code: 'actual_annual_n_budget_exceeded',
              message: `Applied products add ${actualVisitN.toFixed(2)} lb N/1k (${(used + actualVisitN).toFixed(2)} of ${limit} lb N/1k for the year) — actuals exceed the annual N budget.`,
            });
          }
          if (unquantifiedNProducts.length) {
            actualAnnualNBlocks.push({
              code: 'unquantified_liquid_nitrogen',
              message: `${[...new Set(unquantifiedNProducts)].join(', ')} was applied in an amount the nutrient ledger can't convert to lb N/1k — the annual-N projection excludes it; track it manually if the property is near its budget.`,
            });
          }
        }
      } catch (nCalcErr) {
        logger.warn(`[complete] actual annual-N projection failed for ${svc.id}: ${nCalcErr.message}`);
      }
      const combinedAnnualNBlocks = [...annualNBlocks, ...actualAnnualNBlocks];
      // Advisory, not a lockout (same rules as the blackout gate above).
      if (combinedAnnualNBlocks.length) {
        const mappedNBlocks = combinedAnnualNBlocks.map((block) => ({
          code: block.code,
          message: block.message,
        }));
        waveguardNLimitApproval = (normalizedNLimitApproval && completionInput.actor.techRole === 'admin')
          ? {
            ...normalizedNLimitApproval,
            approvedByTechnicianId: completionInput.actor.technicianId,
            approvedByRole: completionInput.actor.techRole || null,
            approvedAt: new Date().toISOString(),
            annualN: plan?.propertyGate?.annualN || null,
            blocks: mappedNBlocks,
          }
          : {
            advisory: true,
            recordedByTechnicianId: completionInput.actor.technicianId,
            recordedByRole: completionInput.actor.techRole || null,
            recordedAt: new Date().toISOString(),
            annualN: plan?.propertyGate?.annualN || null,
            blocks: mappedNBlocks,
          };
      }
      // Actuals only — the plan's inventory blocks describe PLANNED products,
      // so a depleted planned product the tech removed, substituted, or
      // under-applied would persist a shortfall advisory for a product that
      // was never overdrawn (codex P2 r2 on #3179). What was actually
      // submitted (here) plus what was actually deducted (the FOR UPDATE
      // reconcile after the deduction loop) covers every applied product.
      const inventoryBlocks = await actualProductInventoryBlocks(products);
      // Advisory, not a lockout (owner directive 2026-08-03: the inventory
      // gate came off the lawn closeout with the other approval ceremonies —
      // a stale stock count must not trap the tech on the screen). The
      // shortfall is recorded for audit and the deduction path lets
      // inventory_on_hand go negative so the count self-reports the drift.
      if (inventoryBlocks.length) {
        waveguardInventoryAdvisory = {
          advisory: true,
          recordedByTechnicianId: completionInput.actor.technicianId,
          recordedByRole: completionInput.actor.techRole || null,
          recordedAt: new Date().toISOString(),
          blocks: inventoryBlocks.map((block) => ({
            code: block.code,
            message: block.message,
            productId: block.productId || null,
            productName: block.productName || null,
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
      // Advisory, not a lockout (same rules as the blackout gate above):
      // managerApprovalSummary stamps approval semantics, so it only runs
      // when an explicit approval payload arrived; otherwise the exception
      // is recorded as an advisory the audit UI must not present as approved.
      if (managerBlocks.length) {
        waveguardManagerApproval = (normalizedManagerApproval && completionInput.actor.techRole === 'admin')
          ? managerApprovalSummary(normalizedManagerApproval, managerBlocks, {
            technicianId: completionInput.actor.technicianId,
            role: completionInput.actor.techRole || null,
          })
          : {
            advisory: true,
            reasonCode: null,
            note: null,
            recordedByTechnicianId: completionInput.actor.technicianId,
            recordedByRole: completionInput.actor.techRole || null,
            recordedAt: new Date().toISOString(),
            blocks: managerBlocks.map((block) => ({
              code: block.code,
              message: advisorySafeMessage(block.message),
              productId: block.productId || null,
              productName: block.productName || null,
            })),
          };
      }
      const selectedCalibration = plan?.equipmentCalibration?.selected;
      // Only adopt the plan's calibration when it's valid (no bypass) AND it
      // corresponds to something real for THIS visit: the visit's stored
      // assignment or an explicitly submitted rig. With the equipment picker
      // gone, the plan's global auto-pick (e.g. the sole active calibration
      // in the DB) is a suggestion the tech never saw — recording it as used
      // would fabricate equipment usage and overwrite the visit's assignment.
      if (selectedCalibration && !calibrationBypass) {
        const selectedMatchesVisit =
          (svc.assigned_calibration_id && String(selectedCalibration.id) === String(svc.assigned_calibration_id))
          || (svc.assigned_equipment_system_id && String(selectedCalibration.equipment_system_id) === String(svc.assigned_equipment_system_id))
          || (calibrationId && String(selectedCalibration.id) === String(calibrationId))
          || (equipmentSystemId && String(selectedCalibration.equipment_system_id) === String(equipmentSystemId));
        if (selectedMatchesVisit) {
          waveguardEquipmentSystemId = selectedCalibration.equipment_system_id || waveguardEquipmentSystemId;
          waveguardCalibrationId = selectedCalibration.id || waveguardCalibrationId;
        }
      }
      // On a calibration bypass, record "none" only when the RESOLVED
      // calibration (request field from a legacy client, the service's
      // assignment, or the plan's selection) is not field verified — an
      // unverified row was never a legitimate choice, so persisting it would
      // fabricate equipment usage. A field-verified-but-EXPIRED assignment is
      // kept: it is a real assignment and the advisory records the expiry.
      // (The closeout no longer submits equipmentSystemId at all, so keying
      // this off the raw request field would clear every resolved assignment
      // and null out scheduled_services' assignment downstream — Codex P1.)
      const selectedIsFieldVerified =
        selectedCalibration?.calibration_status === 'field_verified';
      if (calibrationBypass && !selectedIsFieldVerified) {
        waveguardEquipmentSystemId = null;
        waveguardCalibrationId = null;
        waveguardCalibrationCleared = true;
      }
      // Tank cleanout is recorded whenever an equipment system is persisted as
      // used — i.e. waveguardEquipmentSystemId survived to here and the
      // calibration was not cleared to "none". Keyed off the ID we persist
      // (rather than the raw request field) so a backfilled field-verified
      // assignment still gets a cleanout record attached.
      if (waveguardEquipmentSystemId && !waveguardCalibrationCleared) {
        // Advisory, not a lockout (owner directive 2026-07-29: the
        // equipment/cleanout step is gone from the closeout UI). A missing
        // cleanout record is noted on the completion instead of blocking it.
        const cleanoutBlocks = tankCleanoutLockoutBlocks(normalizedTankCleanout);
        waveguardTankCleanout = {
          ...(cleanoutBlocks.length
            ? {
              advisory: true,
              // No attestation collected (the closeout has no equipment
              // step) is distinct from "tech answered no" — the audit view
              // renders this as "Not recorded", never "Not completed".
              notRecorded: !normalizedTankCleanout,
              missing: cleanoutBlocks.map((block) => block.message),
            }
            : {}),
          ...normalizedTankCleanout,
          equipmentSystemId: waveguardEquipmentSystemId || null,
          calibrationId: waveguardCalibrationId || null,
          equipmentName: selectedCalibration?.system_name || selectedCalibration?.name || null,
          warnings: tankCleanoutWarnings(normalizedTankCleanout, selectedCalibration),
          recordedByTechnicianId: completionInput.actor.technicianId,
          recordedByRole: completionInput.actor.techRole || null,
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
    // Final follow-up verdict for typed completions (profiles
    // followup_policy / default_followup_days, adjusted by the shared
    // override chain). Computed BEFORE the durable transaction so the
    // follow_up_needed alert parks ATOMICALLY with the completion below —
    // a post-commit best-effort write that failed was unrecoverable once
    // the attempt finalized (Codex r2), and the pre-cutover project flow
    // parked inside its transaction too (createProjectFollowupAlert). The
    // resume path re-derives from the committed snapshot instead (its
    // original transaction already parked or skipped the alert).
    let followupSuggestion = null;
    if (typedFindingsType && typedFindings && !isIncompleteVisit && claim.action === 'proceed') {
      followupSuggestion = typedFollowupVerdict({
        scheduledService: svc,
        profile: completionProfile,
        findingsType: typedFindingsType,
        values: typedFindings.values || {},
      });
    } else if (
      // UNTYPED completions on an alert-policy profile (bed_bug_treatment
      // after the 20260731400000 untype) owe the same profile-declared
      // follow-up — deriving only for typed forms silently dropped the
      // obligation, the exact bug the typed lane fixed. The verdict chain
      // reduces to the pure profile suggestion (no typed values to apply
      // overrides against), and the alert keeps source 'typed_completion'
      // so the (type, job_id) dedupe index still covers it.
      !typedFindingsType
      && completionProfile?.followupPolicy === 'alert'
      && !isIncompleteVisit
      // No treatment happened on declined/inspection-only visits — the
      // profile promise anchors to a PERFORMED first treatment, so a false
      // obligation must not park or mint the included $0 CTA (codex P2 r3;
      // same performed-visit definition the billing path uses).
      && visitPerformed
      && claim.action === 'proceed'
    ) {
      followupSuggestion = typedFollowupVerdict({
        scheduledService: svc,
        profile: completionProfile,
        findingsType: null,
        values: {},
      });
    }

    let record;
    let turfOcrReadingId = null; // set when a gauge photo was captured → async OCR post-commit
    let linkedLawnAssessmentId = null;
    // The completion transaction's wall clock, hoisted to handler scope so
    // the post-commit tracker instant reuses the SAME clamp decision the
    // lifecycle stamps were computed against (codex P2 #3152 round 14).
    // Stays null on a crash-resumed retry (no transaction runs) — the
    // tracker recompute falls back to the current clock there.
    let completionWallClockAt = null;
    // Linked-timer snapshot captured inside the completion transaction —
    // the post-commit sync's version boundary (codex P2 #3152 round 23).
    // Stays null on the crash-resume path (no transaction runs here), and
    // the sync then falls back to a fresh read.
    let completionTimerEntriesSnapshot = null;
    if (resumingCommittedCompletion) {
      record = await db('service_records').where({ id: claim.serviceRecordId }).first();
      if (!record) {
        return ({ status: 409, body: {
          error: 'Completion resume state is missing its service record. Refresh and contact support if this continues.',
          code: 'completion_resume_missing_record',
        } });
      }
      const resumedStructuredNotes = parseJsonObject(record.structured_notes);
      linkedLawnAssessmentId = resumedStructuredNotes.lawnAssessmentId || null;
      // The WaveGuard advisory records were committed with the record, but
      // the resume path skips the preflight and the deduction transaction —
      // without this rehydrate, completionAdvisoryMessages would read the
      // null initializers and the success UI would omit a recorded shortfall
      // on a resumed retry (codex P2 r2 on #3179).
      waveguardBlackoutApproval = resumedStructuredNotes.waveguardBlackoutApproval || null;
      waveguardNLimitApproval = resumedStructuredNotes.waveguardNLimitApproval || null;
      waveguardManagerApproval = resumedStructuredNotes.waveguardManagerApproval || null;
      waveguardCalibrationAdvisory = resumedStructuredNotes.waveguardCalibrationAdvisory || null;
      waveguardInventoryAdvisory = resumedStructuredNotes.waveguardInventoryAdvisory || null;
      durableCompletionCommitted = true;
      // Phase-1 legacy fallback, deferred to durable commit (codex #3590
      // r4; r6 resume path): the open packet-less visit this completion
      // was allowed through dissolves only now that the completion
      // actually exists. On a RESUMED completion (first process died after
      // its commit but before this cleanup) the recheck never ran, so
      // reconstruct the visit id from the row itself — the dissolve
      // helper no-ops on anything but an open packet-less visit.
      {
        let dissolveVisitId = legacyVisitToDissolve;
        legacyVisitToDissolve = null;
        if (!dissolveVisitId) {
          const nowRow = await db('scheduled_services').where({ id: svc.id }).first('visit_id').catch(() => null);
          dissolveVisitId = nowRow && nowRow.visit_id;
        }
        if (dissolveVisitId) {
          void require('../services/visit-groups').dissolveForLegacyCompletion(dissolveVisitId, { expectChildId: svc.id });
        }
      }
    } else {
      try {
        conditionsAtApplication = shouldCaptureApplicationConditions({
          hasConditionsColumn: !!serviceRecordCols.conditions,
          useServiceReportV1,
          isIncompleteVisit,
          productCount: Array.isArray(products) ? products.length : 0,
          // Backfill: today's weather is not the scheduled day's weather —
          // the record (and the FDACS ledger rows that copy its conditions)
          // stays honestly unknown. See the helper's comment.
          isBackfillCompletion,
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
          // Season/weather/expectations context — the PRODUCTION recap path
          // gets the same prompt inputs the preview path does (codex P2
          // r14): tech-selected products + visit context. Best-effort only.
          let completionVisitContext = '';
          try {
            completionVisitContext = await buildRecapVisitContext({
              serviceType: svc.service_type,
              customerId: svc.customer_id,
            });
          } catch { /* context is polish — never block completion */ }
          // The completion payload's products carry productId but no name —
          // hydrate catalog names or safeProducts drops every entry and the
          // prompt never sees the applied solutions (codex P2 r15).
          let recapProducts = Array.isArray(products) ? products : [];
          try {
            const missingNameIds = recapProducts
              .filter((p) => p && !p.name && !p.product_name && p.productId)
              .map((p) => p.productId);
            if (missingNameIds.length) {
              const nameRows = await db('products_catalog')
                .whereIn('id', missingNameIds)
                .select('id', 'name');
              const nameById = new Map(nameRows.map((r) => [String(r.id), r.name]));
              recapProducts = recapProducts.map((p) => (
                p && !p.name && !p.product_name && p.productId
                  ? { ...p, name: nameById.get(String(p.productId)) || null }
                  : p
              ));
            }
          } catch { /* prompt context is polish — never block completion */ }
          const recapInput = {
            notes: technicianNotes,
            visitOutcome,
            serviceType: svc.service_type,
            areasTreated: Array.isArray(areasTreated) ? areasTreated : (areasServiced || []),
            products: recapProducts,
            // Merged observations/recommendations (chip labels + free text +
            // tagged note lines) and the tech's activity rating ground the
            // production recap the same way the preview path does (owner
            // 2026-07-30).
            observations: reportObservations,
            recommendations: reportRecommendations,
            pestActivityRating: Number.isInteger(clientPestRating) ? clientPestRating : null,
            visitContext: completionVisitContext,
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

        // Tech-reviewed AI report copy: when the submitted notes are the
        // "Generate AI report" output (the WHAT WE DID / WHAT WE FOUND shape
        // the tech reviewed in the notes box), that prose was drafted as
        // customer-facing copy and becomes the typed snapshot's Today's
        // Result body. Banned wording introduced by hand edits drops the
        // copy with a log line — the deterministic template remains the
        // guaranteed body and the completion is never blocked on it.
        let technicianReportBody = null;
        // Request-context rejections (trade names from THIS visit's
        // products, companion contradictions) must survive to the RENDER
        // path: untyped completions have no governing snapshot, so
        // report-data would otherwise reparse the persisted notes and
        // promote the exact body rejected here (codex r58). Stamped into
        // service_data below.
        let technicianReportBodyRejection = null;
        if (!isIncompleteVisit) {
          const technicianReport = technicianReportCustomerCopy(technicianNotes);
          if (technicianReport?.violations?.length) {
            logger.warn(`[completion] technician AI report copy dropped (banned: ${technicianReport.violations.join(', ')})`);
          }
          technicianReportBody = technicianReport?.body || null;
          // The generate endpoint screens trade names per-request, but a
          // post-generation inline edit reaches completion with only the
          // static banned-word checks — rerun the visit-specific product
          // guard before the body is stamped (codex r48 #3420). Fail
          // closed: on a hit or a guard error the deterministic template
          // remains and the completion is never blocked.
          if (technicianReportBody) {
            try {
              // Typed product-record fields (e.g. termite_treatment
              // products_used) can carry a trade name with no matching
              // selected product — generation screens them via extraNames,
              // so completion must too (codex r49). Same classification
              // helper, all companions included: a recorded trade name is
              // banned from customer copy regardless of the companion's
              // delivery mode. Errors here propagate to the catch below
              // and drop the body.
              const { typedFindingsPromptSections } = require('../routes/admin-schedule');
              const typedGuardNames = [];
              if (typedFindings?.type) {
                typedGuardNames.push(...typedFindingsPromptSections(
                  typedFindings.type, typedFindings.values || {},
                ).productValues);
              }
              for (const entry of Array.isArray(companionFindings) ? companionFindings : []) {
                const entryValues = entry?.values && typeof entry.values === 'object' && !Array.isArray(entry.values)
                  ? entry.values : null;
                if (entry?.type && entryValues) {
                  typedGuardNames.push(...typedFindingsPromptSections(
                    entry.type, entryValues, { companion: true },
                  ).productValues);
                }
              }
              const screenTradeNames = await CompletionRecap.buildReportTradeNameScreen({
                products: Array.isArray(products) ? products : [],
                extraNames: typedGuardNames,
                db,
              });
              if (screenTradeNames(technicianReportBody)) {
                logger.warn('[completion] technician AI report copy dropped (trade_name)');
                technicianReportBody = null;
                technicianReportBodyRejection = 'trade_name';
              }
            } catch (err) {
              logger.warn(`[completion] technician AI report trade-name guard failed — dropping copy: ${err.message}`);
              technicianReportBody = null;
              technicianReportBodyRejection = 'trade_name_guard_error';
            }
          }
        }

        completionTimerEntriesSnapshot = null;
        const persistRecord = async (trx) => {
          // The finalization takes the scheduled_services row lock FIRST
          // (codex P2 #3152 round 14): the time-on-site PATCH serializes on
          // this lock, and without it the finalizer's service_records
          // INSERT lands before its scheduled_services UPDATE would block —
          // a correction slipping between the two missed the fresh record
          // and was then overwritten. Locking up front makes finalization
          // and correction strictly ordered whichever starts first.
          //
          // Customer FOR SHARE is taken BEFORE the visit lock — the same
          // customer → visit order customer-dedupe's executeMerge uses
          // (customers locked first, then the loser's scheduled visits
          // updated), so a merge racing a completion cannot form a lock
          // cycle (codex P1 #3742 r4). Feeds the report identity snapshot.
          const snapshotCustomerRow = await trx('customers')
            .where({ id: svc.customer_id })
            .forShare()
            .first('first_name', 'last_name', 'address_line1', 'address_line2', 'city', 'state', 'zip', 'latitude', 'longitude');
          const lockedSvcRow = await trx('scheduled_services').where({ id: svc.id }).forUpdate().first();
          // Linked-timer snapshot under the same lock (codex P2 #3152
          // round 23): the post-commit sync's version boundary is THIS
          // transaction — a payroll edit landing after the commit outdates
          // the snapshot's updated_at and the audited edit rejects it.
          if (!isBackfillCompletion) {
            completionTimerEntriesSnapshot = await trx('time_entries')
              .where({ job_id: svc.id, entry_type: 'job' })
              .whereNot('status', 'voided')
              .select('id', 'clock_in', 'clock_out', 'duration_minutes', 'status', 'updated_at');
          }
          // Reconcile with anything that committed between the handler's svc
          // load and this lock (codex P2 #3152 round 15): a time-on-site
          // correction in that window already moved the duration columns,
          // end stamps, and the durable stamp — building the finalization
          // from the stale snapshot would silently overwrite it. Lifecycle
          // state adopts the locked row (start fields are write-once and
          // cannot have moved), and a correction stamped mid-flight outranks
          // a plain stale-timer elapsed in THIS request — the timer being
          // wrong is the exact failure the correction fixed. An explicit
          // adjusted or backfill value in this request is the newer operator
          // statement and keeps its authority ONLY while the durable stamp
          // still reads what it read when this request loaded the row (codex
          // P2 #3152 round 16): the request's values were typed before a
          // stamp that moved in that window committed, so the moved stamp is
          // the newer statement regardless of the request's mode — the
          // request's live/backfill override joins the preserved lane below
          // and its end-instant forcing is suppressed.
          let correctionPreservedMidFlight = false;
          if (lockedSvcRow) {
            // Ownership re-resolve under the lock (r23 — customer-dedupe):
            // a merge-undo that committed between the handler's svc load
            // and this lock reverse-repointed the visit to the restored
            // customer. Completion mints CHILDREN from svc.customer_id
            // (invoices, service records, comms), so finishing with the
            // stale owner splits the visit from its money. Abort with the
            // retryable shape rather than silently adopting an owner the
            // operator wasn't looking at.
            if (lockedSvcRow.customer_id !== svc.customer_id) {
              const err = new Error('This appointment\'s customer changed while completing (a merge was undone) — reload the job and complete it again.');
              err.statusCode = 409;
              err.isOperational = true;
              err.code = 'VISIT_OWNER_CHANGED';
              throw err;
            }
            const normStampVal = (v) => (v == null || v === '' ? null : Number(v));
            const preLockSeq = normStampVal(svc.time_on_site_correction_seq);
            const preLockStamp = normStampVal(svc.time_on_site_adjusted_minutes);
            for (const field of [
              'actual_end_time', 'check_out_time', 'completed_at',
              'service_time_minutes', 'actual_duration_minutes',
              'time_on_site_adjusted_minutes', 'time_on_site_correction_seq',
            ]) {
              if (field in lockedSvcRow) svc[field] = lockedSvcRow[field];
            }
            const stampedMinutes = Number(lockedSvcRow.time_on_site_adjusted_minutes);
            // Moved = the monotonic correction seq changed, NOT the minutes
            // value (codex P2 #3152 round 17): a correction that re-saves
            // the same minutes to repair previously clamped end fields bumps
            // the seq while the value comparison stays blind. Rows without
            // the seq column (pre-migration environments) fall back to the
            // round-16 value comparison so the fence never weakens.
            const stampMovedMidFlight = Object.prototype.hasOwnProperty.call(lockedSvcRow, 'time_on_site_correction_seq')
              ? normStampVal(lockedSvcRow.time_on_site_correction_seq) !== preLockSeq
              : (Object.prototype.hasOwnProperty.call(lockedSvcRow, 'time_on_site_adjusted_minutes')
                && normStampVal(lockedSvcRow.time_on_site_adjusted_minutes) !== preLockStamp);
            if (Number.isFinite(stampedMinutes) && stampedMinutes > 0
              && (stampMovedMidFlight
                || (!isBackfillCompletion && !liveAdjustedTimeOnSite
                  && typeof effectiveTimeOnSite !== 'number'))) {
              effectiveTimeOnSite = stampedMinutes;
              correctionPreservedMidFlight = true;
            }
          }
          const completionEndedAt = new Date();
          completionWallClockAt = completionEndedAt;
          // Backfill: the service happened on its scheduled day — stamp the
          // record (and everything keyed off it: activity-score dates, the
          // completion invoice's service linkage) with that date, not today.
          const completionServiceDate = isBackfillCompletion
            ? backfillPlan.serviceDate
            : etDateString(completionEndedAt);
          // …and the end INSTANTS the closeout keeps carry that day too
          // (Codex P2, PR #2897 fix round 4): a wall-clock end stamp made
          // termite bonds start their term on the closeout date and let
          // weeks-old backfills into pricing-reality-check's current
          // window/month. completionEndedAt stays the wall-clock instant for
          // the audit surfaces (attempt rows, job_status_history); the
          // lifecycle/record stamps get the backdated instant — or, for a
          // real stale check-in with no typed duration, keep the wall clock
          // only as the policies' input, which then strips those rows' end
          // stamps entirely (the end is genuinely unknown; see
          // backfillCompletionEndInstant / applyBackfillDurationPolicy /
          // applyBackfillRecordTimingPolicy).
          const backfillEndedAt = isBackfillCompletion
            ? backfillCompletionEndInstant(completionServiceDate, effectiveTimeOnSite, svc)
            : null;
          // Live admin override: with a real row-backed start, the honest end
          // is start + typed minutes — stamping it keeps every timestamp-pair
          // reader in agreement with the typed duration. Null (no start, or
          // typed minutes exceed the actual elapsed) falls through to the
          // wall clock and the explicit duration columns win at read time.
          // Suppressed when a mid-flight correction outranked this request
          // (round 16): the request's typed minutes lost authority, so its
          // derived end must not be stamped either — the preserved lane's
          // posture (row-backed end or wall clock + correction's duration
          // columns) applies instead.
          const adjustedEndedAt = !isBackfillCompletion && liveAdjustedTimeOnSite
            && !correctionPreservedMidFlight
            ? adjustedCompletionEndInstant(svc, effectiveTimeOnSite, completionEndedAt)
            : null;
          const completionLifecycleAt = backfillEndedAt || adjustedEndedAt || completionEndedAt;
          const lifecycleUpdates = buildCompletionLifecycleUpdates(svc, completionLifecycleAt, { elapsed: effectiveTimeOnSite });
          // Backfill: never derive a duration from the stale on-row
          // timestamps (a weeks-old check-in against today's checkout), and
          // never let a typed duration back-derive a today-dated arrival for
          // a row that has no start of its own — sanitized timeOnSite or
          // unknown; row-backed start timestamps or none. See
          // applyBackfillDurationPolicy.
          if (isBackfillCompletion) applyBackfillDurationPolicy(lifecycleUpdates, effectiveTimeOnSite, svc);
          // Live admin override (codex P2 #3152 round 3): the shared helper
          // prefers a ROW-BACKED end stamp over its `at` argument, so a row
          // that already carries one (a legacy operational completion being
          // finalized later) would keep the stale end while the duration
          // columns took the typed minutes — and every start→end pair reader
          // would still derive the inflated span. Force the kept end fields
          // onto the adjusted instant; the pair must equal the operator's
          // statement exactly (same posture as backfillCompletionEndInstant's
          // real-start branch).
          if (!isBackfillCompletion && liveAdjustedTimeOnSite && !correctionPreservedMidFlight) {
            if (adjustedEndedAt) {
              lifecycleUpdates.actual_end_time = adjustedEndedAt;
              lifecycleUpdates.check_out_time = adjustedEndedAt;
            }
            // Durable row stamp for live overrides too (codex P2 #3152
            // round 11): the costing fence and the no-opts labor override
            // both read scheduled_services.time_on_site_adjusted_minutes —
            // without it a straddling recalculation sees null → null and
            // can overwrite the corrected financials. Same stamp the
            // after-the-fact endpoint writes; stamped even when the end
            // instant was clamped (the MINUTES are the operator statement).
            lifecycleUpdates.time_on_site_adjusted_minutes = effectiveTimeOnSite;
            // …and the monotonic revision advances with it (codex P2 #3152
            // round 19): a live override IS a correction — without a bump,
            // an ordinary status-route markComplete that loaded before this
            // commit still matches the old revision under the default-on
            // fence and overwrites the override's duration/end fields. A
            // plain value is safe here: this transaction holds the row lock,
            // so the locked row's seq cannot move underneath it. The
            // in-memory svc adopts it so the post-commit markComplete
            // callers fence on the revision this finalization created.
            if (Object.prototype.hasOwnProperty.call(lockedSvcRow || svc, 'time_on_site_correction_seq')) {
              const bumpedSeq = (Number((lockedSvcRow || svc).time_on_site_correction_seq) || 0) + 1;
              lifecycleUpdates.time_on_site_correction_seq = bumpedSeq;
              svc.time_on_site_correction_seq = bumpedSeq;
            }
          }
          // Freeze the closeout requirements in force at completion — the
          // LOCKED row's catalog identity, not the handler-entry svc (same
          // staleness rule as the tier snapshot below). Null = lookup failed:
          // freeze nothing, readers keep the live-catalog fallback. An
          // INCOMPLETE visit freezes nothing either (pre-push codex P1) —
          // its eventual completion writes the real completion-time freeze,
          // and first-freeze-wins would otherwise keep this stale one
          // (mirrors the backfill migration's status='completed' scope).
          const closeoutRequirementsSnapshot = isIncompleteVisit ? null
            : await resolveCloseoutRequirementsSnapshotForCompletion({
              trx,
              serviceId: svc.id,
              catalogServiceId: (lockedSvcRow || svc).service_id || null,
              serviceType: (lockedSvcRow || svc).service_type || null,
            });
          const structuredNotes = {
            visitOutcome,
            // Internal-only consultations never request a customer review —
            // freeze the opt-out so the Stripe paid-invoice webhook
            // (stripe-webhook.js) also suppresses it for a billed assessment.
            // Backfill completions freeze it off for the same reason: a
            // review ask days after the visit (or from the later payment)
            // must never fire from a quiet backlog closeout.
            requestReview: (isIncompleteVisit || isInternalOnlyCompletion || isBackfillCompletion) ? false : requestReview !== false,
            oneTimeRecapOnly: recapReviewOnly,
            reviewSuppression,
            reviewTiming: reviewTiming || null,
            reviewDelayMinutes: completionReviewDelayMinutes == null ? null : completionReviewDelayMinutes,
            reviewScheduledFor: reviewScheduledFor || null,
            incompleteReason,
            customerConcernText: concernText || null,
            customerRecap: effectiveCustomerRecap || null,
            timeOnSite: effectiveTimeOnSite || null,
            customerInteraction: normalizedCustomerInteraction,
            invoiceAlreadySent: !!invoiceAlreadySent,
            // Backfill frozen on the record: a crash-resumed retry may lack
            // the body flag, and the quiet/backdate posture must survive it.
            ...(isBackfillCompletion ? { backfill: true } : {}),
            // Durable audit marker: this duration is an admin-typed override
            // of the running timer, not the timer itself (or a mid-flight
            // correction this finalization preserved — codex round 15). No
            // reader keys off it — the corrected end stamps/duration columns
            // already agree.
            ...(liveAdjustedTimeOnSite || correctionPreservedMidFlight ? { timeOnSiteAdjusted: true } : {}),
            // REQUIRED-mint posture frozen at commit (Codex P0, fix round
            // 8): derived from the LIVE billing profile above — the profile
            // the operator saw — and stamped in the SAME transaction as the
            // record, so no committed completion can exist unfrozen. A
            // resumed retry enforces THIS posture; it never recomputes from
            // the by-then-mutable profile (edited/removed → a live
            // recomputation would silently finalize the closeout with the
            // owed invoice unminted). Since the pre-gate removal
            // (2026-07-27) the posture can freeze REQUIRED for LIVE typed
            // one-time completions too — their mint inherited the removed
            // gate's fail-closed promise.
            ...(backfillMintRequiredAtCommit ? {
              backfillMintRequired: true,
              // The required mint's MONEY is frozen beside the posture
              // (Codex P0, fix round 10): amount and tax basis recompute
              // from MUTABLE visit/customer billing fields, so a post-commit
              // edit would otherwise make a released-failure retry mint the
              // WRONG amount — or, with the price cleared, skip the required
              // mint at the amount guard and finalize the closeout unbilled.
              // Integer cents so jsonb round-trips exactly; stamped ONLY on
              // the required-mint shape to keep the notes lean.
              backfillMintAmountCents: Math.round(Number(invoiceAmount) * 100),
              backfillMintTaxRate: completionInvoiceTaxRate,
              // The Bill-To identity the frozen rate was derived FOR (r4
              // P0): null = frozen self-pay. The mint requires the resolved
              // payer to match (invoice.js frozenPayerId) so a post-commit
              // payer change can never receive a rate derived for someone
              // else.
              backfillMintPayerId: completionResolvedPayer?.payerId != null
                ? String(completionResolvedPayer.payerId)
                : null,
            } : {}),
            areasTreated: completionAreas,
            waveguardEquipmentSystemId,
            waveguardCalibrationId,
            waveguardBlackoutApproval,
            waveguardNLimitApproval,
            waveguardManagerApproval,
            waveguardCalibrationAdvisory,
            waveguardInventoryAdvisory,
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
            formObservations,
            formRecommendations,
            ...(techTipsFreeze.tips.length ? { techTips: techTipsFreeze.tips } : {}),
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
            // Every non-auto_send posture FREEZES, regardless of findings
            // type — an untyped specialty profile under a delivery kill
            // switch (bed_bug post-untype) must persist its suppression or
            // downstream gates (report metadata, resolution sync, pressure
            // history, crash-resume re-derivation) read the absent field as
            // auto_send and can mint/send anyway (codex P1 r4).
            ...((typedFindingsType || isInternalOnlyCompletion || typedDeliveryMode !== 'auto_send') ? { typedReportDelivery: typedDeliveryMode } : {}),
            // Companion delivery postures frozen alongside (same rule):
            // graduation flips on the profile never retro-publish stored
            // companion sections.
            ...(validatedCompanions.length
              ? { companionReportDelivery: Object.fromEntries(companionDeliveryByType) }
              : {}),
            // The completion-time follow-up verdict is FROZEN here (both
            // directions — required and withdrawn) so later re-parks (child
            // cancellation, deploy-boundary resume) replay the promise that
            // was actually made, never a re-derivation from the live profile
            // — a repointed/deactivated profile or changed interval must not
            // silently drop (or invent) an owed included treatment
            // (Codex r4).
            ...(followupSuggestion ? { typedFollowupVerdict: followupSuggestion } : {}),
            // Closeout requirements frozen at completion: a later catalog
            // edit or rename must not flip this visit's apparent status or
            // mint attention alerts against closed history
            // (service-closeout-requirements.js frozenCloseoutRequirements).
            ...(closeoutRequirementsSnapshot ? { closeoutRequirements: closeoutRequirementsSnapshot } : {}),
          };
          // Report identity snapshot (report-identity-snapshot.js): the
          // customer name, visit address, technician name, linked service
          // title, and each applied product's approved report facts are
          // frozen INSIDE the transaction so later customer / schedule /
          // technician / catalog edits cannot rewrite this visit's report.
          // Customer and technician are re-read HERE against the locked row
          // (not the handler's pre-transaction join): a rename, move, or
          // reassignment that committed between the preflight read and this
          // lock must freeze as it stands at commit, not as it stood when the
          // tech opened the panel (pre-push codex P1). Product facts come
          // from the catalog rows the product loop below re-validates; a
          // failed read leaves productFacts undefined so the renderer keeps
          // its live fallback for this record only.
          // These reads run INSIDE the transaction and propagate like every
          // other in-trx read here: a failed statement aborts the Postgres
          // transaction, so a swallowed rejection could not make the leg
          // "fail-soft" — it would only rename the rollback (pre-push codex
          // P1). A missing row (deleted customer, no technician) still just
          // omits that leg via buildReportIdentitySnapshot.
          // The visit row (stamped address, service_type) is the LOCKED row;
          // the customer and technician are looked up by the SAME ids
          // recordInsert persists below (svc.customer_id / svc.technician_id),
          // so the frozen name can never disagree with the FK the report
          // routes join for the photo (pre-push codex P1).
          const snapshotVisitRow = lockedSvcRow || svc;
          // Lock order is customer (FOR SHARE, taken above before the visit
          // FOR UPDATE) → visit → technician → catalog, so a concurrent
          // rename / reassignment / catalog edit cannot commit between these
          // reads and the completion commit — the frozen values are the
          // rows as they stand at commit (pre-push codex P1).
          const snapshotTechnicianRow = svc.technician_id
            ? await trx('technicians').where({ id: svc.technician_id }).forShare().first('name')
            : null;
          // ONE catalog read set inside the trx serves both the frozen report
          // facts and the product loop's validation below, so the facts the
          // report freezes are the rows the completion actually validated
          // against (pre-push codex P1). Keys are canonical lower-case uuids:
          // Postgres returns ids lower-case however the request spelled them.
          const snapshotProductIds = [...new Set((products || []).map((p) => canonicalProductId(p?.productId)).filter(Boolean))];
          const completionCatalogRowsById = new Map(
            (snapshotProductIds.length
              // FOR UPDATE, not FOR SHARE: deductProductInventory below
              // upgrades to FOR UPDATE on these same rows, and two
              // completions holding compatible share locks would deadlock
              // on the upgrade (codex P1).
              ? await trx('products_catalog').whereIn('id', snapshotProductIds).forUpdate().select('*')
              : []
            ).map((row) => [canonicalProductId(row.id), row]),
          );
          const reportProductFactsSnapshot = {};
          for (const productId of snapshotProductIds) {
            reportProductFactsSnapshot[productId] = approvedReportProductFacts(
              completionCatalogRowsById.get(productId) || null,
            );
          }
          const reportIdentitySnapshot = buildReportIdentitySnapshot({
            visit: snapshotVisitRow,
            customer: snapshotCustomerRow || null,
            technicianName: snapshotTechnicianRow ? snapshotTechnicianRow.name : null,
            productFacts: reportProductFactsSnapshot,
          });
          const serviceData = {
            reportIdentitySnapshot,
            protocol: {
              visitOutcome,
              actions: reportProtocolActions,
              observations: reportObservations,
              recommendations: reportRecommendations,
            },
            // Durable CONSENT marker for the inspection credit, written
            // inside the completion transaction (Codex #3175 r5 P0).
            // Recovery must never infer a promise from "an inspection was
            // completed" — that can't tell a transient offer-write failure
            // from the tech clearing the box, and on first gate enablement
            // it would sweep up every historical inspection. Only an
            // explicit opt-in recorded HERE is recoverable evidence.
            // Gate-checked (Codex #3178 P1): with the lane dark the client
            // still posts the default-true field, and persisting consent
            // then would let a later gate flip recover promises for
            // inspections closed out before the feature existed.
            // visitOutcome must be a real completion — an 'incomplete'
            // visit performed no inspection to credit.
            // Shared predicate, not the bare category (Codex #3178 r24
            // P0): rodent_inspection's typed profile is category 'rodent',
            // and the category-only gate silently excluded it.
            // EXCEPT rodent (Codex #3178 r31 P0): its $125-creditable
            // promise lives on already-sent tokenized estimates,
            // independent of this lane's gate — the marker and frozen
            // terms persist while dark so the flip can't strand a promise
            // the estimator already made. Money still moves only when the
            // gate is on.
            // NEVER on a quiet backfill (Codex #3178 r35 P2): the backdated
            // closeout contract forces every customer send off, and a
            // weeks-old inspection's credit promise — never announced,
            // window anchored on the stale service date — would only feed
            // the delivery audit false undelivered alerts.
            ...(offerInspectionCredit
              && !isBackfillCompletion
              && visitOutcome === 'completed'
              && require('../services/inspection-credit').isCreditableInspectionProfile(completionProfile)
              && (require('../config/feature-gates').isEnabled('inspectionCredit')
                || require('../services/inspection-credit').carriesStandingCreditPromise(completionProfile?.serviceKey))
              ? {
                inspectionCreditOptIn: true,
                // The TERMS the promise was made under, frozen WITH the
                // consent marker (Codex #3178 r21 P2): if the offer insert
                // fails and pricing config changes before the hourly
                // recovery runs, the customer must still receive the
                // closeout's amount and window — never the newly
                // configured ones. Recovery passes these through.
                inspectionCreditTerms: (() => {
                  const InspectionCredit = require('../services/inspection-credit');
                  return {
                    // Placeholder (configured fee): the locked pass below
                    // re-freezes the amount from the locked row's SOLD
                    // inspection line for every eligible inspection —
                    // an inspection accepted at $125 before the fee
                    // dropped still freezes $125 (codex #3521 r1 P0).
                    amount: InspectionCredit.closeoutCreditAmountForServiceKey(completionProfile?.serviceKey || null, null),
                    windowDays: InspectionCredit.creditWindowDaysForServiceKey(completionProfile?.serviceKey || null),
                    // The RESOLVED key rides the frozen terms (r35 P0) so
                    // recovery classifies standing-promise offers even for
                    // rows whose service_id FK is null.
                    serviceKey: completionProfile?.serviceKey || null,
                  };
                })(),
              }
              : {}),
          };
          // Freeze the appointment's add-on line identities with the
          // completion (codex P2 on #3189): schedule add-on rows are
          // MUTABLE after completion (the update-details route replaces
          // them), and the trace-eligibility render verdict must reflect
          // the lines completed on the visit, not later edits — an add-on
          // added afterwards must not republish a suppressed trace, and
          // one removed must not hide a legitimately completed map.
          // Fail-soft: a lookup error omits the field and render falls
          // back to the live rows (legacy-record behavior).
          try {
            // The EMPTY array freezes too (codex P2 r15): an absent field
            // means "legacy record, fall back to live rows" — a
            // zero-add-on completion must not stay mutable. Each line also
            // freezes its key + findings pointer (codex P2 r21) via the
            // shared freezer, so profile repoints can't rewrite history.
            const { frozenAddonLinesForCompletion } = require('../services/service-report/trace-eligibility');
            serviceData.completedAddonLines = await frozenAddonLinesForCompletion(svc.id, trx);
          } catch { /* render falls back to live rows */ }
          // The PRIMARY identity freezes for the same reason (codex P2
          // r15): update-details can repoint service_id/service_type after
          // completion, and a generic report has no typed snapshot to
          // counter it — the permanent report's trace verdict must reflect
          // the service that was actually completed. Resolved from the
          // LOCKED row (codex P2 r21, twin of the recap fix): an
          // update-details repoint can commit between the handler's
          // pre-transaction svc load and the row lock, and the freeze must
          // record the service actually completing. Fail-soft on the
          // re-resolve — the pre-lock profile (today's behavior) stands.
          let frozenCompletionProfile = completionProfile;
          let primaryFreezeTrusted = true;
          if (lockedSvcRow && (lockedSvcRow.service_id !== svc.service_id
            || lockedSvcRow.service_type !== svc.service_type)) {
            try {
              frozenCompletionProfile = await resolveCompletionProfileForScheduledService(lockedSvcRow, trx);
            } catch {
              // Repoint DETECTED but the locked re-resolve failed: the
              // pre-lock profile is known-stale, so freezing it would pin
              // the WRONG identity permanently (codex P2 r27). Omit the
              // freeze — the render's live fallback resolves the current
              // row, the legacy-record behavior.
              primaryFreezeTrusted = false;
            }
          }
          // The freeze must be SAFE for the key's classification family
          // (codex P2 r28/r29, mirroring the add-on freezer): a typed key
          // (flea_tick, lawn_aeration…) or a pointer-required key frozen
          // WITHOUT its pointer would pin the permanent report to the
          // wrong verdict forever — render treats the frozen key as
          // authoritative and never re-queries the restored profile.
          const { primaryIdentityFreezable } = require('../services/service-report/trace-eligibility');
          if (primaryFreezeTrusted && primaryIdentityFreezable(frozenCompletionProfile || {})) {
            serviceData.completedServiceKey = frozenCompletionProfile?.serviceKey || null;
            serviceData.completedServiceName = (lockedSvcRow ? lockedSvcRow.service_type : svc.service_type) || null;
          }
          // The inspection-credit marker keys to the LOCKED identity too
          // (Codex #3178 r32 P2): the serviceData literal tested the
          // pre-lock profile, and an update-details repoint committing in
          // between can persist a promise on a visit that is no longer an
          // inspection — or strip one from a visit that now is. Re-judge
          // with the same re-resolved profile the report freeze trusts; a
          // detected repoint whose re-resolve failed is UNKNOWN identity,
          // which fails closed (no marker — money never moves on a guess).
          {
            const IC = require('../services/inspection-credit');
            effectiveCompletionProfile = primaryFreezeTrusted ? frozenCompletionProfile : null;
            const lockedEligible = offerInspectionCredit
              && !isBackfillCompletion
              && visitOutcome === 'completed'
              && IC.isCreditableInspectionProfile(effectiveCompletionProfile)
              && (require('../config/feature-gates').isEnabled('inspectionCredit')
                || IC.carriesStandingCreditPromise(effectiveCompletionProfile?.serviceKey));
            const hasMarker = serviceData.inspectionCreditOptIn === true;
            if (hasMarker && !lockedEligible) {
              delete serviceData.inspectionCreditOptIn;
              delete serviceData.inspectionCreditTerms;
            } else if (lockedEligible) {
              // EVERY eligible inspection (re)freezes its terms here, from
              // the LOCKED row inside the transaction — not just a missing
              // marker or a repoint. The pre-lock literal is a placeholder;
              // a price edit committing before the lock, or a repoint into
              // an inspection, must both land the sold face, never stale or
              // live-config terms (uncapped audit P0 on #3521).
              serviceData.inspectionCreditOptIn = true;
              serviceData.inspectionCreditTerms = {
                amount: IC.closeoutCreditAmountForServiceKey(
                  effectiveCompletionProfile?.serviceKey || null,
                  await IC.soldInspectionAmountForVisit(trx, lockedSvcRow || svc),
                ),
                windowDays: IC.creditWindowDaysForServiceKey(effectiveCompletionProfile?.serviceKey || null),
                serviceKey: effectiveCompletionProfile?.serviceKey || null,
              };
            }
          }
          // Typed specialty completion: resolve trend vs the customer's prior
          // visit for the same indicator, then persist the immutable
          // customer-copy snapshot (typedReportSnapshot). The report renders
          // from this snapshot forever — labels/copy are resolved HERE.
          // The reviewed body describes the WHOLE visit, so it must not
          // contradict a CUSTOMER-FACING companion's recorded findings just
          // because the primary snapshot carries it (codex r52 #3420): a
          // termite primary could otherwise publish "8 stations were
          // checked" beside a bait companion recording 6. Same value-driven
          // guards the companion applies when it carries the body itself;
          // the confirmed reconciliation prompt overrides as usual. Applies
          // to BOTH carrier paths below.
          const companionBodyConflict = Boolean(technicianReportBody)
            && reportReconcileConfirmed !== true
            && validatedCompanions.some((companion) => (
              (companionDeliveryByType.get(companion.type) || 'internal_only') === 'auto_send'
              && ActivityIndicators.typedBodyContradictions(
                companion.type,
                companion.values,
                companion.activityScore,
                technicianReportBody,
              ).length > 0
            ));
          const sectionScreenedReportBody = companionBodyConflict ? null : technicianReportBody;
          if (companionBodyConflict) {
            logger.warn('[completion] technician AI report copy dropped (companion_contradiction)');
            technicianReportBodyRejection = technicianReportBodyRejection || 'companion_contradiction';
          }
          if (technicianReportBodyRejection) {
            // Render-path consumers must not resurrect a body the
            // completion's request-context screens rejected (codex r58).
            serviceData.technicianReportBodyRejected = technicianReportBodyRejection;
          }
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
              // Primary section only — the AI report describes this visit's
              // primary work; companion sections keep their own typed copy.
              technicianReportBody: sectionScreenedReportBody,
              // The tech confirmed the reconciliation prompt: the frozen
              // snapshot carries the decision so neither the snapshot's own
              // screens nor the render-time summary screen silently discard
              // the body a person reviewed and overrode.
              reconcileConfirmed: reportReconcileConfirmed === true,
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
            // Companion-only profiles (no typed primary) have no primary
            // snapshot to carry the reviewed AI report — the first
            // customer-facing companion whose story ACCEPTS the body (stamps
            // bodySource) becomes the carrier; a fixed zero-state companion
            // that refuses it passes the body along to the next auto_send
            // companion (codex r30/r35 #3420). Exactly one carrier: embedding
            // the same body in every companion section would duplicate it
            // per card.
            let companionBodyCarried = false;
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
                technicianReportBody: !serviceData.typedReportSnapshot
                  && !companionBodyCarried
                  && (companionDeliveryByType.get(companion.type) || 'internal_only') === 'auto_send'
                  ? sectionScreenedReportBody
                  : null,
                // A standard primary with a trapping COMPANION has no typed
                // primary snapshot to carry the confirmed override — freeze
                // it on the trapping companion so the render-time summary
                // screen can honor it (codex P1).
                reconcileConfirmed: reportReconcileConfirmed === true
                  && companion.type === 'rodent_trapping',
              });
              if (companionSnapshot) {
                // The frozen per-section delivery rides the snapshot itself
                // so report-data filters without re-reading the live profile.
                companionSnapshot.delivery = companionDeliveryByType.get(companion.type) || 'internal_only';
                if (companionSnapshot.todaysResult?.bodySource === 'technician_report') {
                  companionBodyCarried = true;
                }
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
          // Tier + provenance + callback identity frozen via the SHARED
          // completion snapshot (completion-tier-snapshot.js) — the same
          // builder the pest-recap path uses, so no completion path can
          // create a record without them (codex #3617 r3/r4). The customer
          // fields are RE-READ inside this transaction: the handler-entry
          // read is minutes stale by insert time, and a concurrent
          // membership edit would freeze the wrong provenance on a
          // permanent report (codex r9 P1). Fallback = the entry read.
          let snapshotCustomer = null;
          try {
            snapshotCustomer = await trx('customers').where({ id: svc.customer_id }).first(
              'waveguard_tier',
              'monthly_rate',
              ...(customerTierSourceColumnExists ? ['waveguard_tier_source'] : []),
              ...(billingModeColumnsExist ? ['billing_mode'] : []),
            );
          } catch { snapshotCustomer = null; }
          Object.assign(recordInsert, completionTierSnapshotFields({
            serviceRecordCols,
            waveguardTier: snapshotCustomer ? snapshotCustomer.waveguard_tier : svc.cust_waveguard_tier,
            waveguardTierSource: snapshotCustomer ? snapshotCustomer.waveguard_tier_source : svc.cust_waveguard_tier_source,
            monthlyRate: snapshotCustomer ? snapshotCustomer.monthly_rate : svc.cust_monthly_rate,
            billingMode: snapshotCustomer ? snapshotCustomer.billing_mode : svc.cust_billing_mode,
            provenanceUnknown: customerColumnsProbeFailed,
            // The LOCKED completion row's flag — svc was read before the
            // FOR UPDATE and a concurrent update-details reclassify would
            // freeze a stale callback identity forever (codex GH-r3 P2;
            // same rule as the recap path).
            isCallback: lockedSvcRow ? lockedSvcRow.is_callback === true : !!svc.is_callback,
          }));
          if (serviceRecordCols.visit_number) recordInsert.visit_number = Number(priorVisitCountRow?.count || 0) + 1;
          const recordTimingFields = buildServiceRecordCompletionTimingFields({
            scheduledService: svc,
            lifecycleUpdates,
            // Backfill: the report row's end stamps carry the backdated
            // service-day instant (same rule as the lifecycle leg above);
            // the strip policy below then removes them entirely for the
            // unknown-end shape.
            completedAt: completionLifecycleAt,
            serviceRecordCols,
          });
          // Backfill: the report row must not pair the kept real check-in
          // with today's closeout stamp when no duration was typed — the
          // start→end fallback readers would book the stale span. See
          // applyBackfillRecordTimingPolicy.
          if (isBackfillCompletion) applyBackfillRecordTimingPolicy(recordTimingFields, effectiveTimeOnSite, svc);
          Object.assign(recordInsert, recordTimingFields);
          if (serviceRecordCols.conditions && conditionsAtApplication) recordInsert.conditions = serializeJsonb(conditionsAtApplication);
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
            const productReentry = await productReentryFloor(trx, products || []);
            const productReentryMin = productReentry.minutes;
            // Type-aware base: cockroach-family visits default to a 120-min
            // INTERIOR window (owner rule 2026-08-11) instead of the pest
            // line's 30 — see getAdvisoryDefaults. Recorded applications are
            // passed as evidence so a no-spray termite identity never zeroes
            // a visit that actually applied product.
            // Evidence = a label re-entry interval on any applied product, or
            // an explicitly spray-class application method — bait cartridges
            // and station checks are not evidence (uncapped codex P1).
            // A treatment-applied protocol action is evidence too: products are
            // optional on inspection/bait lanes, so an interior/exterior action
            // marked treatmentApplied must keep the guidance (codex inline r4).
            // A label REI counts only when genuinely PRESENT: productReentryFloor
            // maps a null rei_hours to 0, so `!= null` alone would read a bait
            // cartridge row as treatment evidence (codex inline r13). A real
            // 0-hr spray is still caught by its spray-class method or product
            // identity below.
            const reentryApplicationsRecorded = (productReentryMin != null && productReentryMin > 0)
              || (Array.isArray(products) && products.some((p) => isSprayApplicationMethod(
                p?.applicationMethod || p?.method || p?.application_method,
              )))
              || reportProtocolActionScopes.some((s) => s.treatmentApplied && s.dryDown !== false)
              // Typed work fields record applications too (codex P1 r12 #3701).
              || ActivityIndicators.typedTreatmentEvidence(typedFindingsType, typedFindings?.values).applied
              // Catalog identity: a non-bait pesticide product is evidence even
              // under the client's defaulted station_check (codex inline r9).
              || await productIdentityEvidence(trx, products || []);
            const lineAdvisoryDefaults = getAdvisoryDefaults(svc.service_type, {
              applicationsRecorded: reentryApplicationsRecorded,
            });
            // Server-authoritative no-re-entry visit: a no-spray termite
            // identity with no treatment evidence persists 0/0 and IGNORES
            // client stepper overrides — a stale adjustment submitted before
            // the panel's async re-seed cleared it must not become a
            // reentry_adjusted countdown (uncapped codex P1 r8).
            const noReentryTermiteVisit = !reentryApplicationsRecorded
              && getServiceLineConfig(svc.service_type).id === 'termite'
              && isTermiteNoReentryServiceType(svc.service_type);
            let advisoryDefaultsForVisit = productReentryMin != null
              ? {
                ...lineAdvisoryDefaults,
                exterior_reentry_min: Math.max(
                  Number(lineAdvisoryDefaults?.exterior_reentry_min) || 0,
                  productReentryMin,
                ),
              }
              : lineAdvisoryDefaults;
            // Tech re-entry steppers (owner rule 2026-08-11): an adjusted
            // side overrides its computed default and carries the same
            // per-side reentry_adjusted marker the admin correction writes,
            // so an explicit choice survives scope normalization (below and
            // at read time) exactly like an after-the-fact edit. Label REI
            // stays the exterior floor — a tech-lowered dry-down window
            // never undercuts the most restrictive product label applied.
            {
              let techExterior = noReentryTermiteVisit ? undefined : reentryOverridePlan.exterior;
              const techInterior = noReentryTermiteVisit ? undefined : reentryOverridePlan.interior;
              // Fail closed when the label floor is UNVERIFIABLE (codex P1
              // #3360): a lowering exterior override is dropped entirely —
              // the computed default (line default raised by any known REI)
              // stands unmarked, so scope normalization treats it like an
              // untouched side. Raising is always safe and still applies.
              const computedExteriorMin = Number(advisoryDefaultsForVisit?.exterior_reentry_min) || 0;
              if (techExterior !== undefined && !productReentry.verified
                && techExterior < computedExteriorMin) {
                logger.warn('[completion] re-entry exterior override dropped — product REI floor unverifiable', {
                  serviceId: svc.id,
                  requestedExteriorMin: techExterior,
                  keptExteriorMin: computedExteriorMin,
                });
                techExterior = undefined;
              }
              if (techExterior !== undefined || techInterior !== undefined) {
                advisoryDefaultsForVisit = {
                  ...advisoryDefaultsForVisit,
                  ...(techExterior !== undefined
                    ? { exterior_reentry_min: Math.max(techExterior, productReentryMin || 0) }
                    : {}),
                  ...(techInterior !== undefined
                    ? { interior_reentry_min: techInterior }
                    : {}),
                  reentry_adjusted: {
                    exterior: techExterior !== undefined,
                    interior: techInterior !== undefined,
                  },
                };
              }
            }
            // Treatment Zone Mapper trace = explicit exterior scope (the
            // trace is drawn on the satellite exterior) — keeps the
            // dry-down timer on typed closeouts that hide area chips.
            // Savepoint-isolated (codex P2 #3007 r6): if the optional
            // treatment_zone_maps table is absent, a raw failed query would
            // ABORT the whole completion transaction — a nested knex
            // transaction rolls back only the savepoint and the completion
            // proceeds with chip/action scope.
            let tracedExteriorZone = false;
            // Interior-only treatments (bed bug, post-20260731400000): a
            // trace saved before the tracer was hidden for this lane is
            // stale EXTERIOR evidence — it must not resurrect the exterior
            // dry-down timer on an interior visit (codex P2 r6). The stable
            // profile key is authoritative; the label regex is the fallback
            // for unresolved profiles (codex P2 r8).
            const interiorOnlyVisit = completionProfile?.serviceKey === 'bed_bug_treatment'
              || /\bbed\s*bugs?\b/i.test(String(svc.service_type || ''));
            try {
              tracedExteriorZone = interiorOnlyVisit ? false : await trx.transaction(async (sp) => !!(await sp('treatment_zone_maps')
                .where({ scheduled_service_id: svc.id })
                .first()));
            } catch (traceErr) {
              // Only the EXPECTED missing-table case means "no trace". Any
              // other failure (timeout, permissions) fails CLOSED by
              // preserving the exterior timer: the persisted advisory is
              // unrecoverable once zeroed, and showing dry-down guidance
              // unnecessarily is safer than silently dropping it
              // (codex P1 #3007 r8).
              const missingTable = traceErr?.code === '42P01'
                || /no such table|does not exist/i.test(String(traceErr?.message || ''));
              if (!missingTable) {
                tracedExteriorZone = true;
                logger.warn('[completion] treatment-zone trace lookup failed; preserving exterior re-entry', {
                  serviceId: svc.id,
                  error: String(traceErr?.message || traceErr),
                });
              }
            }
            const advisoryNormalized = buildCompletionAdvisory({
              advisoryDefaults: advisoryDefaultsForVisit,
              completionAreas,
              protocolActionScopes: reportProtocolActionScopes,
              applications: products || [],
              tracedExteriorZone,
            });
            recordInsert.advisory = serializeJsonb(advisoryNormalized);
            // Diff against the visit's PRE-normalization advisory (tech
            // override included) so a stepper adjustment alone doesn't log
            // as a scope normalization.
            const interiorBefore = advisoryDefaultsForVisit?.interior_reentry_min ?? null;
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

        // Park the owed follow-up's dispatch alert ATOMICALLY with the
        // completion (same trx — a completion that commits can never lack
        // its durable follow-up trace, and an alert-write failure rolls the
        // whole completion back into a retryable state; Codex r2). The
        // helper skips when a live linked child already covers the
        // obligation (the call pipeline pre-books visit 2 — alerting on a
        // booked follow-up parks a false exception; Codex r2) or an
        // unresolved alert already exists. The visit-outcome
        // follow_up_needed writer runs LATER in this trx and defers to
        // this park when the verdict is required (Codex r3). Emit
        // defers to commit via createAlertOnce's trx handling.
        if (followupSuggestion?.required) {
          await parkFollowupAlert({
            scheduledService: svc,
            suggestion: followupSuggestion,
            serviceRecordId: record.id,
            serviceName: completionProfile?.serviceName || null,
            customerName: [svc.first_name, svc.last_name].filter(Boolean).join(' ').trim() || null,
            source: 'typed_completion',
            trx,
          });
        }

        // Before/progress photos captured from Tech Home predate the immutable
        // service_record. Attach them inside this transaction so a failed
        // completion leaves the staged rows intact for the technician's retry.
        await promoteStagedServicePhotos({
          scheduledServiceId: svc.id,
          serviceRecordId: record.id,
          knex: trx,
        });

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
              logger.warn(`[turf-height] optional lawn-length photo skipped for service=${completionInput.serviceId}: ${photoErr.message}`);
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
              createdBy: completionInput.actor.technicianId,
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
        // Specialty dropdown findings are rendered from the provenance-kept
        // structured snapshot below. Do not duplicate them as bare findings:
        // the PDF's raw-note guard intentionally removes bare-title rows.
        const customerFindingObservations = resolvedSpecialtyServiceKey
          ? []
          : submittedObservations;
        if (useServiceReportV1 && serviceFindingsAvailable && customerFindingObservations.length && !isInternalOnlyCompletion) {
          const findingRows = customerFindingObservations.map((title) => ({
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
          // Infestation-class untyped closeouts (alert-policy profiles —
          // bed_bug post-20260731400000) never INFER "no activity" from
          // blank optional fields: the visit exists because activity was
          // found, and a contradictory zero would print on the customer
          // report. Only an explicit 0 rating states it (codex P2 r1).
          && !(completionProfile?.followupPolicy === 'alert'
            && (activityScore ?? clientPestRating) == null)
          && shouldInsertNoActivityFinding({
            visitOutcome,
            observations: reportObservations,
            recommendations: reportRecommendations,
            concernText,
            // Recurring pest closeouts carry the rating as clientPestRating;
            // activityScore only arrives on typed completions (which are
            // already excluded above) — without the client rating the guard
            // never fired on ordinary visits (codex P1 #3043).
            activityScore: activityScore ?? clientPestRating,
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
        // One-time treatments are excluded FORM-INDEPENDENTLY (codex r5):
        // the untyped pest family (tick control, fire ant, nest removals…)
        // slips both the typed guard and review-window's one-time-label
        // heuristic, and an isolated treatment must not seed recurring
        // pressure history. Re-service/callback visits are the deliberate
        // exception — extra visits on an active plan still score (see
        // review-window.js isOneTimeServiceLabel).
        const oneTimePressureExcluded = String(completionProfile?.billingType || '').toLowerCase() === 'one_time'
          && completionProfile?.serviceKey !== 'pest_re_service'
          && !svc.is_callback;
        if (useServiceReportV1 && serviceFindingsAvailable && serviceRecordCols.pressure_index && !typedFindingsType && !isInternalOnlyCompletion && !oneTimePressureExcluded) {
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
          // Shared closeout allowlist (inventory-units.js) — the pest
          // recap validates against the same vocabulary (codex P1 r11).
          const { isValidRateUnit } = require('../services/inventory-units');
          for (const p of products) {
            if (!p.productId) continue;
            if (seenProductIds.has(p.productId)) continue;
            seenProductIds.add(p.productId);
            if (p.rateUnit && !isValidRateUnit(p.rateUnit)) {
              const err = new Error(`Invalid product unit for ${p.name || p.productId}`);
              err.isOperational = true; err.statusCode = 400;
              throw err;
            }
            // Same read set the report identity snapshot froze from.
            const product = completionCatalogRowsById.get(canonicalProductId(p.productId));
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
            // A "/gal" unit is a mix concentration: a total recorded against
            // it is the amount of concentrate, so store the base quantity
            // unit — inventory deduction and the FDACS ledger can't use a
            // dilution as a quantity unit.
            const appliedAmountUnit = baseQuantityUnit(p.amountUnit || p.rateUnit || null);
            if (appliedAmount != null && (!Number.isFinite(appliedAmount) || appliedAmount <= 0)) {
              const err = new Error(`Invalid product total amount for ${product.name}`);
              err.isOperational = true; err.statusCode = 400;
              throw err;
            }
            if (appliedAmountUnit && !isValidRateUnit(appliedAmountUnit)) {
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
              // Advisory inventory posture is scoped to WaveGuard lawn — the
              // only closeout that records the shortfall as an advisory.
              allowNegative: isWaveGuardLawnCompletion(svc),
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
            // Backfilled closeouts recheck from the recorded application day,
            // not the office-entry day (recheck_due_date derives from this).
            serviceDate: isBackfillCompletion
              ? toETNoonServiceDate(completionServiceDate)
              : completionEndedAt,
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
          // Reconcile the advisory with what the FOR UPDATE deduction actually
          // saw: two concurrent visits can both pass the unlocked preflight
          // read with the stock intact, so the later one can go negative
          // without the preflight having recorded an advisory (codex P2 r1 on
          // #3179). The locked deduction result is authoritative.
          if (isWaveGuardLawnCompletion(svc)) {
            const deductionStatusByProductId = new Map(
              inventoryDeductions
                .filter((deduction) => deduction.productId != null)
                .map((deduction) => [String(deduction.productId), deduction.status]),
            );
            // Any preflight stock block whose product reached the locked
            // deduction is superseded by that deduction's outcome: sufficient
            // stock refutes it, and a locked shortfall replaces it with the
            // authoritative counts — stock can move between the unlocked read
            // and the lock in either direction, so preflight numbers must
            // never survive a locked result (codex P2 r3+r4 on #3179).
            // Non-stock blocks (inactive product) and preflight blocks for
            // products the deduction never quantified are kept.
            const keptBlocks = (waveguardInventoryAdvisory?.blocks || []).filter(
              (block) => !(
                block.code === 'actual_inventory_insufficient_stock'
                && block.productId != null
                && ['deducted', 'deducted_insufficient_stock'].includes(
                  deductionStatusByProductId.get(String(block.productId)),
                )
              ),
            );
            const keptShortfallProductIds = new Set(
              keptBlocks
                .filter((block) => block.code === 'actual_inventory_insufficient_stock')
                .map((block) => (block.productId != null ? String(block.productId) : null))
                .filter(Boolean),
            );
            const shortfallBlocks = inventoryDeductions
              .filter((deduction) => deduction.status === 'deducted_insufficient_stock'
                && !keptShortfallProductIds.has(String(deduction.productId)))
              .map((deduction) => ({
                code: 'actual_inventory_insufficient_stock',
                message: `${deduction.productName} went to ${deduction.stockAfter} ${deduction.inventoryUnit} on hand after deducting ${deduction.deductedAmount} ${deduction.inventoryUnit}.`,
                productId: deduction.productId || null,
                productName: deduction.productName || null,
              }));
            const reconciledBlocks = [...keptBlocks, ...shortfallBlocks];
            waveguardInventoryAdvisory = reconciledBlocks.length
              ? {
                advisory: true,
                recordedByTechnicianId: completionInput.actor.technicianId,
                recordedByRole: completionInput.actor.techRole || null,
                recordedAt: new Date().toISOString(),
                ...(waveguardInventoryAdvisory || {}),
                blocks: reconciledBlocks,
              }
              : null;
          }
          record.structured_notes = {
            ...(record.structured_notes || {}),
            inventoryDeductions,
            // Explicit even when null: the initial insert may have committed
            // a preflight advisory this reconcile just refuted — a
            // conditional spread would leave the stale record in the notes.
            ...(isWaveGuardLawnCompletion(svc) ? { waveguardInventoryAdvisory } : {}),
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
          scheduledServiceUpdate.lawn_protocol_assigned_by = completionInput.actor.technicianId || null;
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
        // Empty-update guard (Codex P2, PR #2897 fix round 4): for a
        // backfilled real-stale-check-in row with a blank typed duration the
        // duration policy strips EVERY key the lifecycle helper produced —
        // exactly the shape the closeout UI allows — and knex throws on
        // .update({}), failing the whole closeout. Nothing downstream needs
        // this row-touch when there is nothing to write: transitionJobStatus
        // below owns the status flip and bumps updated_at on the same row.
        if (Object.keys(scheduledServiceUpdate).length) {
          await trx('scheduled_services').where({ id: svc.id }).update(scheduledServiceUpdate);
        }

        // 5. Status flip via the canonical sole-writer.
        await transitionJobStatus({
          jobId: svc.id,
          fromStatus,
          toStatus: 'completed',
          transitionedBy: completionInput.actor.technicianId,
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
        if (visitOutcome === 'follow_up_needed' && !followupSuggestion?.required) {
          // When the typed verdict owns the obligation, parkFollowupAlert
          // already inserted the follow_up_needed card earlier in THIS
          // transaction — an unconditional second insert here deterministically
          // double-carded one visit (Codex r3). Untyped completions and typed
          // ones whose verdict withdrew (e.g. German "No") keep the
          // outcome-driven alert exactly as before.
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
            deferred: Boolean(packetRecord),
            response: {
              success: true,
              serviceRecordId: record.id,
              invoiceId: null,
              invoiceTotal: null,
            },
          },
          trx
        );
        };
        // A savepoint's executionPromise resolves before the packet commits.
        // Pass the outer handle to the status/alert writers so their broadcasts
        // cannot escape if a later member rejects the closeout.
        if (packetRecord) await persistRecord(db);
        else await db.transaction(persistRecord);
        if (packetRecord) {
          packetRecord.uploadedPhotoRows.push(...preCommitCompletionPhotoRows);
          return { status: 202, body: { serviceRecordId: record.id } };
        }
        durableCompletionCommitted = true;
      // Phase-1 legacy fallback, deferred to durable commit (codex #3590
      // r4; r6 resume path): the open packet-less visit this completion
      // was allowed through dissolves only now that the completion
      // actually exists. On a RESUMED completion (first process died after
      // its commit but before this cleanup) the recheck never ran, so
      // reconstruct the visit id from the row itself — the dissolve
      // helper no-ops on anything but an open packet-less visit.
      {
        let dissolveVisitId = legacyVisitToDissolve;
        legacyVisitToDissolve = null;
        if (!dissolveVisitId) {
          const nowRow = await db('scheduled_services').where({ id: svc.id }).first('visit_id').catch(() => null);
          dissolveVisitId = nowRow && nowRow.visit_id;
        }
        if (dissolveVisitId) {
          void require('../services/visit-groups').dissolveForLegacyCompletion(dissolveVisitId, { expectChildId: svc.id });
        }
      }
      } catch (err) {
        if (preCommitCompletionPhotoRows.length) {
          await cleanupUploadedServicePhotoObjects(preCommitCompletionPhotoRows);
          preCommitCompletionPhotoRows = [];
        }
        if (err && err.message && err.message.includes('not in state')) {
          await CompletionAttempts.markCompletionAttemptFailed(completionAttempt, err, db);
          return ({ status: 409, body: {
            error: `Job is no longer in state ${fromStatus} (concurrent transition). Refresh and try again.`,
          } });
        }
        throw err;
      }
    }

    // The durable completion artifacts are committed. On normal first
    // execution we can now run best-effort follow-up alerts and tracking;
    // on resume we skip those already-committed/operational side paths and
    // continue the customer-visible billing/SMS/review side effects below.

    // Backfill survives resume via its own structured_notes freeze — and the
    // freeze decides in BOTH directions (Codex P2 ×2, PR #2897 fix round 5):
    // on the side-effect resume path the committed record alone sets the
    // completion MODE (a flagless retry of a committed backfill stays quiet;
    // a flagged retry of a committed NORMAL completion stays loud) and the
    // typed DURATION (the retry body typically carries the panel's
    // auto-elapsed timer, never the committed typed value). Re-derived HERE —
    // the first post-commit step — so the tracker end-instant + markComplete
    // below (whose markComplete must honor the duration policy via
    // untrustedLifecycleSpan, Codex P1, PR #2897 fix round 3), the backfill
    // review-invoice override in shouldAutoInvoiceCompletion, and every later
    // backfill money/comms gate read the same committed truth on a resumed
    // retry; the customer-comms re-force stays below, after the
    // frozen-delivery re-derivation it must override. A disagreeing retry
    // reaches this line only because the committed-record resume claim
    // (claimSideEffectsRun) matches the hash's CORE segment — `backfill` and
    // `timeOnSite` hash into the mode segment it alone ignores (Codex P2,
    // PR #2897 fix round; narrowed round 10 so pre-commit retries still
    // match the full composite) — hashed there too, the retry 409'd
    // (completion_resume_payload_mismatch) before this line. First-run keeps
    // the request-derived values — the freeze is written FROM them inside the
    // transaction above.
    if (resumingCommittedCompletion) {
      const frozenResume = frozenResumeCompletionState(
        parseJsonObject(record.structured_notes),
        { requestBackfill: isBackfillCompletion },
      );
      if (frozenResume.bodyDisagreed) {
        logger.warn(`[completion] resume of service ${svc.id}: retry body says backfill=${isBackfillCompletion} but the committed record froze backfill=${frozenResume.isBackfillCompletion} — the frozen mode wins`);
        if (!frozenResume.isBackfillCompletion) {
          // The stray body flag quieted the comms posture at intake; the
          // committed completion is NORMAL, so restore the posture it ran
          // under. The frozen-delivery re-derivation below still applies on
          // top (typed completions), and the backfill re-force after it no
          // longer fires — every read of these flags sits below both.
          suppressTypedCustomerComms = deliveryPosture.suppressCustomerComms;
          effectiveSendCompletionSms = sendCompletionSms && !suppressTypedCustomerComms;
        }
      }
      // The FROZEN required-mint posture replaces the commit-time live
      // derivation for every consumer below (invoice decision + fail-closed
      // catch) — the billing profile may have changed since commit, and the
      // committed posture is the money truth (Codex P0, fix round 8).
      backfillReviewMintRequired = frozenResume.backfillMintRequired;
      // …and so does the frozen mint MONEY (Codex P0, fix round 10): the
      // amount/tax the operator's commit derived, validated by the helper —
      // null when absent/invalid, which the mint block fail-closes on for a
      // required resume instead of recomputing from mutated billing state.
      backfillFrozenMintAmount = frozenResume.backfillMintAmount;
      backfillFrozenMintTaxRate = frozenResume.backfillMintTaxRate;
      backfillFrozenMintPayerId = frozenResume.backfillMintPayerId;
      isBackfillCompletion = frozenResume.isBackfillCompletion;
      effectiveTimeOnSite = frozenResume.effectiveTimeOnSite;
    }

    // Backfill tracker stamp (Codex P2, PR #2897 fix round 4): the SAME
    // end-instant rule the transaction applied to the kept lifecycle stamps,
    // for markComplete's completed_at below — a wall-clock completed_at
    // re-fed the closeout date to every scheduled_services reader the
    // stripped end stamps were protecting (pricing-reality-check's lookback
    // COALESCE + minutesBetween(arrived_at, completed_at) fallback, the
    // termite-bond sync's third preference, billing recovery's aging).
    // Deterministic across crash-resume: svc's row-backed starts and
    // scheduled_date are stable, and on resume effectiveTimeOnSite IS the
    // frozen typed duration (block above) — never the retry's elapsed timer
    // (Codex P2, fix round 5). The unknown-end shape (real stale check-in,
    // blank duration) now stamps ET noon of the service day too (fix round
    // 9): round 7's NULL kept the fabricated pair impossible but also hid a
    // priced-but-uninvoiced backfill from Billing Recovery's completed_at
    // window; the sub-day pair readers guard on the durable
    // structured_notes.backfill marker instead (see
    // backfillCompletionEndInstant's comment).
    const backfillTrackerCompletedAt = isBackfillCompletion
      ? backfillCompletionEndInstant(
        serviceDateOnly(svc.scheduled_date),
        effectiveTimeOnSite,
        svc,
      )
      // Live admin override (codex P2 #3152 round 10): the tracker's
      // completed_at must carry the corrected end too — date-window readers
      // (pricing-reality-check's lookback COALESCE, billing recovery aging)
      // prefer completed_at over the corrected end columns, so a correction
      // crossing an ET day boundary would otherwise stay attributed to the
      // late-closeout day. A NUMERIC effectiveTimeOnSite is the durable mode
      // signal (validated at intake on first run, restored from the frozen
      // structured_notes on a crash-resumed retry); the same pure helper
      // yields the same start + minutes instant the lifecycle columns carry,
      // and null (no real start / clamped) falls through to the tracker's
      // wall clock exactly like a plain live completion.
      // Anchored to the transaction's own wall clock so the clamp decision
      // here matches the committed lifecycle stamps exactly (codex P2
      // round 14). On a crash-resumed retry no transaction ran in THIS
      // process and the clamp anchor exists only in memory — recomputing
      // against the current clock flips a committed clamp once
      // start + minutes has passed (codex P2 round 20), splitting the
      // tracker's completed_at from the committed end fields. The committed
      // lifecycle end IS the clamp outcome, so the resume path carries the
      // persisted stamp instead of recomputing.
      : (typeof effectiveTimeOnSite === 'number'
        ? (completionWallClockAt
          ? adjustedCompletionEndInstant(svc, effectiveTimeOnSite, completionWallClockAt)
          : (finiteDate(svc.actual_end_time) || finiteDate(svc.check_out_time) || null))
        : null);

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

    // Recorded inspection-credit promise (null unless this closeout made
    // one). Declared HERE, before its only assignment — a `let` referenced
    // above its declaration is a temporal-dead-zone throw, which would have
    // turned every eligible closeout into a logged false failure.
    let inspectionCreditOffer = null;

    // Inspection credit promise (dark behind GATE_INSPECTION_CREDIT).
    // Keyed ONLY to a successful inspection closeout plus the explicit
    // opt-out — deliberately NOT inside the invoice-mint branch (Codex
    // #3175 P0): paid, prepaid, pre-minted, existing-invoice and
    // no-invoice inspections are all still inspections the customer was
    // promised a credit for. Records the PROMISE only; no money moves
    // until they book. Never throws — a credit hiccup must not fail a
    // completion the tech already performed.
    // On a RESUME the committed record is the only truth (Codex #3178 r22
    // P1): the request field defaults to true and the gate is re-read live,
    // so a completion that committed while the lane was dark — deliberately
    // carrying no marker — would retroactively mint a promise if the gate
    // flipped on before the retry. Same posture as the backfill freeze
    // above: first run derives from the request (which is what wrote the
    // marker inside the transaction), resumes read the marker.
    const inspectionCreditConsented = resumingCommittedCompletion
      ? parseJsonObject(record.service_data)?.inspectionCreditOptIn === true
      : offerInspectionCredit;
    if (inspectionCreditConsented
      // Quiet backfills record no promise and queue no comms (r35 P2) —
      // the marker was never written, and this guard keeps the first-run
      // request field from re-opening the leg.
      && !isBackfillCompletion
      && visitOutcome === 'completed'
      // Shared predicate, not the bare category (Codex #3178 r24 P0):
      // rodent_inspection's typed profile is category 'rodent'.
      // The EFFECTIVE profile — the identity the completion transaction
      // actually judged after its row lock (r32 P2): a pre-lock snapshot
      // can be stale across an update-details repoint; null (repoint
      // detected, re-resolve failed) fails closed. On a RESUME the
      // committed marker is the consent authority; this predicate is the
      // identity gate, re-derived from the same pre-trx resolution.
      && require('../services/inspection-credit').isCreditableInspectionProfile(effectiveCompletionProfile)) {
      try {
        const InspectionCredit = require('../services/inspection-credit');
        // The window starts when the INSPECTION happened, not when it was
        // closed out (Codex #3178 P1): a backdated closeout would otherwise
        // hand a weeks-old inspection a fresh 30 days. ET wall-clock noon
        // so a date-only value can't slip a day.
        const inspectionMoment = InspectionCredit.etDateOnlyToDate(record.service_date);
        // The TERMS the closeout froze with the consent marker (Codex
        // #3178 r23 P2): a crash-resume can run after a pricing-config
        // change, and reading the live amount/window here would mint a
        // different monetary promise than the closeout made. Same source
        // the recovery sweep uses; on a first run the stored terms ARE the
        // live config, written moments ago in the same request.
        const frozenCreditTerms = parseJsonObject(record.service_data)?.inspectionCreditTerms || null;
        inspectionCreditOffer = await InspectionCredit.recordInspectionCreditOffer({
          customerId: svc.customer_id,
          scheduledServiceId: svc.id,
          serviceRecordId: record.id,
          // The FROZEN key wins (Codex #3178 r36 P2): on a resume after an
          // update-details repoint, the live re-resolution can differ from
          // the identity the closeout promised under — and the offer's
          // source_service_key drives dark-mode standing redemption, so a
          // rodent promise re-keyed to another inspection would never
          // redeem before the flip.
          serviceKey: frozenCreditTerms?.serviceKey || effectiveCompletionProfile?.serviceKey || null,
          ...(Number(frozenCreditTerms?.amount) > 0 ? { amount: Number(frozenCreditTerms.amount) } : {}),
          ...(Number(frozenCreditTerms?.windowDays) > 0 ? { windowDays: Number(frozenCreditTerms.windowDays) } : {}),
          createdBy: `tech:${completionInput.actor.technician?.name || completionInput.actor.technicianId || 'unknown'}`,
          // The promise moment is when the completion COMMITTED —
          // record.created_at — not when this code runs (pre-push P0): on a
          // crash-resume the retry can be much later, and stamping the
          // retry time would fail the ordering guard for any booking made
          // in between, permanently denying the promised credit. The sweep
          // then adopts such a booking from its in-window booking event.
          // The window stays anchored to the inspection's service date
          // (backdated closeouts must not get a fresh 30 days, but must
          // also not back-date the ordering guard).
          ...(record?.created_at ? { now: new Date(record.created_at) } : {}),
          ...(inspectionMoment ? { windowAnchor: inspectionMoment } : {}),
          // A durable marker means the promise was made while the lane was
          // LIVE — a resume after the gate went dark must still honor it
          // (Codex #3178 r24 P2). First runs without a marker keep the
          // live-gate check inside recordInspectionCreditOffer.
          honorCommittedMarker: parseJsonObject(record.service_data)?.inspectionCreditOptIn === true,
        });
      } catch (creditErr) {
        logger.error(`[dispatch] inspection credit offer failed for ${svc.id}: ${creditErr.message}`);
      }
      // Prepaid/pre-minted inspections settle BEFORE the offer exists, so
      // their receipt went out without the written deadline (Codex #3178
      // P2). Resend it now that the memo lookup can see the offer — only
      // on the FIRST record, only for an already-paid, non-payer-billed
      // invoice (an unpaid one gets the memo on its normal receipt).
      // Shared helper: the sweep's recovery path (which can be the first
      // successful creation of the same promise) sends the same resend.
      // Keyed on offerId, NOT `recorded` (Codex #3178 r23 P2): a crash
      // after the offer insert but before this queue leaves the retry
      // returning `already_offered` — same promise, memo still unsent, and
      // the recovery sweep skips the visit because its offer exists. The
      // resend is idempotent per offer, so re-queueing a delivered one is
      // a no-op.
      if (inspectionCreditOffer?.offerId) {
        require('../services/inspection-credit').queueCreditReceiptResend({
          scheduledServiceId: svc.id,
          offerId: inspectionCreditOffer.offerId,
        });
      }
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
      const completionPhotosDelta = {
        completionPhotos: {
          uploaded: completionPhotoUploadResult.uploaded,
          failed: completionPhotoUploadResult.failed,
          uploadedAt: new Date().toISOString(),
        },
      };
      const photoNotes = { ...latestNotes, ...completionPhotosDelta };
      await mergeRecordNotesKeys(record.id, completionPhotosDelta).catch((updateErr) => {
        logger.warn(`[dispatch] completion photo status update failed: ${updateErr.message}`);
      });
      record.structured_notes = photoNotes;
    }

    // Grounded-recommendation regen state — the artifact/SMS blocks below
    // key on these. `Grounded` is true ONLY on a settled run with a truthy
    // result: a quick provider/parse failure must not be mistaken for a
    // grounded success (codex P1 r12).
    let lawnRecRegenPromise = null;
    let lawnRecRegenAttempted = false;
    let lawnRecRegenGrounded = false;
    let lawnRecRegenTimedOut = false;
    // Resolves true once customer-safe copy is durable: grounded write OR
    // deterministic sanitize after failure. Gates unrecallable artifacts
    // (report email) queued later in this handler.
    let lawnRecFinalCopyPromise = null;
    // True once the durable lawn-PDF correction marker is persisted; when a
    // correction is needed but the marker cannot be written, the PDF render
    // queue is suppressed (codex P1 r31).
    let lawnPdfCorrectionNeeded = false;
    let lawnPdfCorrectionMarked = false;
    // DURABLE correction marker (codex P1 r30/r31/r34): the in-process
    // recovery callback dies with the process, and customers without report
    // email have no worker path that forces a fresh render, so
    // structured_notes.lawnPdfCorrectionPending makes EVERY render path
    // render fresh until a post-settlement render clears it. It must be
    // durable before any artifact is produced — retry, and if it still
    // fails the PDF enqueue is suppressed. Atomic jsonb_set so a concurrent
    // structured_notes write is never clobbered. Called from the regen path
    // AND from the setup-failure catch (r34).
    const markLawnPdfCorrectionNeeded = async () => {
      lawnPdfCorrectionNeeded = true;
      for (let attempt = 0; attempt < 3 && !lawnPdfCorrectionMarked; attempt += 1) {
        try {
          await db('service_records').where({ id: record.id }).update({
            structured_notes: db.raw(
              "jsonb_set(COALESCE(structured_notes::jsonb, '{}'::jsonb), '{lawnPdfCorrectionPending}', 'true'::jsonb, true)",
            ),
          });
          lawnPdfCorrectionMarked = true;
          record.structured_notes = { ...parseJsonObject(record.structured_notes), lawnPdfCorrectionPending: true };
        } catch (markErr) {
          logger.warn(`[dispatch] lawn PDF correction marker write failed for ${record.id} (attempt ${attempt + 1}): ${markErr.message}`);
          await new Promise((resolve) => { setTimeout(resolve, 2000 * (attempt + 1)).unref?.(); });
        }
      }
      if (!lawnPdfCorrectionMarked) {
        logger.error(`[dispatch] lawn PDF correction marker UNWRITABLE for ${record.id} — suppressing the PDF render queue so no stale artifact is stored`);
      }
    };
    const completedLawnAssessmentId =
      linkedLawnAssessmentId || parseJsonObject(record.structured_notes).lawnAssessmentId || null;
    if (!isIncompleteVisit && completedLawnAssessmentId) {
      // FAIL CLOSED (codex P1 r21): the safety gate arms BEFORE any fallible
      // setup — a transient failure in the assessment lookup/relink below
      // must leave the MMS/SMS-tip/email gates CLOSED (not-grounded), not
      // silently open because `attempted` was never set. The catch installs
      // a sanitize-based finalCopy chain so held artifacts still settle.
      const KnowledgeBridgeGate = require('../services/knowledge-bridge');
      const lawnRecSanitizeWithRetry = async (tries = 4) => {
        for (let attempt = 0; attempt < tries; attempt += 1) {
          // A setup failure BEFORE the backlink write leaves the assessment
          // unlinked and sanitation rejects it forever (codex P1 r40) —
          // restore the known link first (idempotent, only-if-null).
          await db('lawn_assessments')
            .where({ id: completedLawnAssessmentId })
            .whereNull('service_record_id')
            .update({ service_record_id: record.id })
            .catch((linkErr) => logger.warn(`[dispatch] assessment backlink recovery failed for ${completedLawnAssessmentId}: ${linkErr.message}`));
          const res = await KnowledgeBridgeGate.sanitizeStoredRecommendations(completedLawnAssessmentId)
            .catch((e) => ({ changed: false, error: e.message }));
          if (!res.error) return res;
          await new Promise((resolve) => { setTimeout(resolve, 15000 * (attempt + 1)).unref?.(); });
        }
        return { changed: false, error: 'sanitize retries exhausted' };
      };
      lawnRecRegenAttempted = true;
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
        // Recommendations were generated at confirm time, BEFORE the
        // service_records/service_products rows existed, so the applied-today
        // grounding in generateAssessmentRecommendations never fired (codex
        // P1 #3093). Now that the visit's applications are persisted and the
        // assessment is back-linked, regenerate and wait — the PDF job and
        // MMS preview later in this handler read ai_summary/recommendations
        // and must not bake the stale confirm-time output (r3/r5). The wait
        // is BOUNDED so a stalled provider can't hang the tech's completion
        // response (r6), and the run always completes + writes: on a timeout
        // the grounded correction still becomes durable and the PDF-queue
        // block re-renders the artifact when it lands (r8) — no permanent
        // stale copy on either path.
        const KnowledgeBridge = KnowledgeBridgeGate;
        // RESUME SAFETY (codex P1 r32): a crashed-then-resumed completion can
        // find grounded copy already stored — and its PDF/email may already
        // have reached the customer. A second LLM run would produce
        // different recommendations and overwrite the permanent report while
        // the sent delivery is deduped, so treat existing grounded copy as
        // final and skip regeneration entirely.
        let alreadyGrounded = false;
        try {
          const priorRow = await db('lawn_assessments').where({ id: completedAssessment.id }).first('recommendations');
          const prior = typeof priorRow?.recommendations === 'string'
            ? JSON.parse(priorRow.recommendations) : (priorRow?.recommendations || null);
          // Sanitation-final copy counts as final too (codex P1 r35): the
          // deterministic pass ran against an authoritative application
          // read, and its result may already be in a customer's hands.
          // But a LIVE generation lease in _generationRuns means another
          // run (e.g. admin regeneration) can still overwrite the stored
          // copy — the shortcut must not release the artifact gates while
          // that is possible (codex P1 r38).
          const priorRuns = (prior && typeof prior === 'object' && !Array.isArray(prior)
            && prior._generationRuns && typeof prior._generationRuns === 'object') ? prior._generationRuns : {};
          const liveLease = Object.values(priorRuns).some((exp) => {
            const t = Date.parse(exp);
            return Number.isFinite(t) && t > Date.now();
          });
          alreadyGrounded = !!(prior && typeof prior === 'object' && !Array.isArray(prior)
            && (prior._groundedInApplications || prior._sanitizationFinal)
            && !liveLease);
        } catch { alreadyGrounded = false; }
        if (alreadyGrounded) {
          lawnRecRegenGrounded = true;
          lawnRecFinalCopyPromise = Promise.resolve({ verified: true, changed: false });
          logger.info(`[dispatch] grounded recommendations already stored for assessment ${completedAssessment.id} — skipping regeneration (resume-safe)`);
          throw { __skipLawnRegen: true };
        }
        lawnRecRegenPromise = KnowledgeBridge.generateAssessmentRecommendations(completedAssessment.id)
          .catch((recErr) => { logger.warn(`[dispatch] post-completion recommendation regen failed (non-blocking): ${recErr.message}`); return null; });
        // LIVE grounded flag (codex P2 r15): the promise updates it whenever
        // it settles — a run that lands grounded just after the race must
        // not stay suppressed at the later MMS/SMS checks. Attached before
        // the race so a fast settle updates the flag before the await
        // returns.
        void lawnRecRegenPromise.then((result) => { lawnRecRegenGrounded = !!result; })
          .catch((flagErr) => logger.error(`[dispatch] regen grounded-flag updater failed: ${flagErr.message}`));
        // Final-copy settlement with VERIFIED semantics (codex P1 r18): the
        // sanitizer reports transient DB errors as { error } without
        // rejecting, so the chain retries with backoff and resolves
        // { verified, changed } — consumers must not treat an errored
        // sanitize as a clean no-op.
        lawnRecFinalCopyPromise = lawnRecRegenPromise.then(async (result) => {
          if (result) return { verified: true, changed: true };
          const sanitized = await lawnRecSanitizeWithRetry();
          if (sanitized.error) {
            logger.error(`[dispatch] stored-copy sanitize UNVERIFIED for assessment ${completedAssessment.id}: ${sanitized.error} — held email stays gated by the worker`);
          }
          return { verified: !sanitized.error, changed: !!sanitized.changed };
        });
        const regenOutcome = await Promise.race([
          lawnRecRegenPromise.then(() => ({ settled: true })),
          new Promise((resolve) => { setTimeout(() => resolve({ settled: false }), 60000).unref?.(); }),
        ]);
        lawnRecRegenTimedOut = !regenOutcome.settled;
        if (lawnRecRegenTimedOut || !lawnRecRegenGrounded) {
          await markLawnPdfCorrectionNeeded();
        }
        if (lawnRecRegenTimedOut) {
          logger.warn('[dispatch] lawn recommendation regen still running after 60s — completion continues; PDF re-queues when the grounded write lands');
        } else if (!lawnRecRegenGrounded) {
          // A fast failure leaves the confirm-time copy stored and customer-
          // visible — the finalCopy chain above is already running the
          // retrying deterministic sanitize (codex P1 r13+r18); recommendation-
          // derived customer output stays suppressed meanwhile.
          logger.warn('[dispatch] lawn recommendation regen failed — retrying sanitize runs in the finalCopy chain; recommendation-derived customer output suppressed');
        }
      } catch (err) {
        if (err && err.__skipLawnRegen) {
          // Not an error: grounded copy already stored (resume-safe skip).
        } else {
        logger.error(`[dispatch] Lawn assessment service_record link failed (non-blocking): ${err.message}`);
        // Setup failed before (or during) regen creation: keep the gates
        // closed and install a sanitize-based settlement chain so the held
        // email / recovery render still converge on safe copy (codex P1 r21).
        if (!lawnRecFinalCopyPromise) {
          lawnRecFinalCopyPromise = lawnRecSanitizeWithRetry().then((res) => ({ verified: !res.error, changed: !!res.changed }));
          void lawnRecFinalCopyPromise.catch((chainErr) => logger.error(`[dispatch] fallback sanitize chain failed: ${chainErr.message}`));
        }
        // Setup failure leaves confirm-time copy live while sanitation
        // retries — the same durable-marker-or-suppress path must run here
        // before the PDF block, or a restart strands a stale PDF for
        // customers with no email fallback (codex P1 r34).
        await markLawnPdfCorrectionNeeded();
        }
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
        actorId: completionInput.actor.technicianId,
        // Backfill: markComplete's own UPDATE rebuilds lifecycle fields from
        // the row — today's end stamps plus a stale-start→now duration —
        // which would re-pollute, AFTER the transaction, exactly the columns
        // applyBackfillDurationPolicy stripped (or set from the typed
        // duration), and job-costing's durable guard would then read the
        // rebuilt service_time_minutes as explicit labor. The flag keeps the
        // tracker to its own bookkeeping (track_state/updated_at), and
        // completed_at comes from the backdated end-instant rule (or stays
        // NULL for the unknown-end shape); the policy's persisted values
        // survive.
        untrustedLifecycleSpan: isBackfillCompletion,
        completedAt: backfillTrackerCompletedAt,
        // Fences the tracker writes (codex P2 #3152 rounds 13/17): this
        // instant belongs to the correction revision this request observed
        // on the (lock-reconciled) row — null when it has never been
        // corrected. If a newer time-on-site PATCH landed since, the row's
        // monotonic seq differs (even for a same-minutes re-save) and the
        // tracker must not restore ours.
        expectedCorrectionSeq: svc.time_on_site_correction_seq ?? null,
      });
      await recordTrackTransitionResultFailure({
        jobId: svc.id,
        action: 'mark_complete',
        actorId: completionInput.actor.technicianId,
        result,
      });
    } catch (e) {
      logger.error(`[admin-dispatch] markComplete failed: ${e.message}`);
      await recordTrackTransitionFailure({
        jobId: svc.id,
        action: 'mark_complete',
        actorId: completionInput.actor.technicianId,
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

    // Termite bait station sync (station-map-v1): registry writes (new pins /
    // moves / retires) + this visit's per-station check rows. Post-commit +
    // fail-soft for the same reason as zones — station pins are report
    // presentation data and must never abort a committed completion.
    // AUTHORIZATION: the server-resolved profile must carry the
    // termite_bait_station flow (primary or companion) — a stale/crafted
    // non-termite body must not mutate the registry. Incomplete visits skip
    // the sync entirely (same rule as companion findings): recording the
    // zero-tap default "ok" checks for a visit that didn't happen would
    // corrupt the station history future reports and trends read.
    if (Array.isArray(termiteStations) && termiteStations.length) {
      if (isIncompleteVisit || !stationProgram) {
        logger.warn('[completion] station payload skipped', {
          serviceId: svc.id,
          incomplete: isIncompleteVisit,
          findingsType: completionProfile?.findingsType || null,
        });
      } else {
        try {
          const stationSync = await TermiteStations.syncStationsForCompletion(db, {
            customerId: svc.customer_id,
            serviceRecordId: record.id,
            entries: termiteStations,
            program: stationProgram,
          });
          if (stationSync.skipped.length) {
            // post-commit skips (cap race / foreign id) can't 400 a
            // committed completion — surface them loudly for the operator
            logger.warn('[completion] termite station entries skipped', { serviceId: svc.id, ...stationSync });
          } else if (stationSync.created || stationSync.moved || stationSync.retired
            || stationSync.checksApplied || stationSync.deduped) {
            logger.info('[completion] termite stations synced', { serviceId: svc.id, ...stationSync });
          }
        } catch (stationErr) {
          logger.warn(`[completion] termite station sync failed (non-blocking): ${stationErr.message}`);
        }
      }
    }

    // Auto-score the Tree & Shrub visit's photos (dual-vision) and persist a
    // tree_shrub_assessments row that feeds the customer Tree & Shrub Report V2.
    // Post-commit + fire-and-forget: it never blocks completion latency or success
    // (the report self-heals on view). Unconditional (the TREE_SHRUB_REPORT_V2
    // env flag is retired — owner ungated 2026-07-09), tree_shrub-only, fully
    // guarded — a scoring hiccup can't affect any completion. Replays return
    // earlier, so this runs once on the genuine first completion (no duplicate
    // assessments).
    if (
      reportServiceLine === 'tree_shrub'
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
        technician_id: svc.technician_id || completionInput.actor.technicianId || null,
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
      const review = completionInput.body && completionInput.body.treeShrubReview;
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
          const runScore = () => scoreAndStoreTreeShrubAssessment({
            service: assessService,
            photos: scorePhotos,
            loadImage: (ph) => {
              const m = String(ph.data || '').match(/^data:([^;,]+)?(?:;base64)?,(.*)$/);
              return m && m[2] ? { base64: m[2], mimeType: m[1] || 'image/jpeg' } : null;
            },
          });
          // One bounded background retry when the first attempt stores
          // nothing (both vision providers erroring resolves null; a thrown
          // error is caught the same). The 12s-timeout case already
          // self-heals — a HARD failure had no second chance and left the
          // visit permanently on the generic report (audit 2026-07-18 P2).
          // The persist path dedupes on service_record_id before any paid
          // vision call, so a retry racing a late first attempt can't
          // double-insert. The retry rides OUTSIDE scoringPromise: the
          // pre-artifact race below must wait only on attempt 1 — a fast
          // double-provider failure completes promptly and the retried
          // assessment reaches the report on its next view (codex P2 r5).
          const firstAttempt = runScore().catch((err) => {
            logger.warn(`[tree-shrub] assessment scoring attempt 1 failed for service_record ${record.id}: ${err.message}`);
            return null;
          });
          firstAttempt.then((stored) => {
            if (stored) return;
            new Promise((resolve) => setTimeout(resolve, 60000))
              .then(runScore)
              .then((retried) => {
                if (!retried) logger.error(`[tree-shrub] assessment scoring yielded no row after retry for service_record ${record.id} — report stays on the generic layout`);
              })
              .catch((err) => logger.error(`[tree-shrub] assessment scoring retry failed for service_record ${record.id}: ${err.message}`));
          });
          scoringPromise = firstAttempt;
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

    // Warm the cross-sell card's property-evidence cache (owner lane
    // 2026-08-13). Post-commit with a BOUNDED wait, the same posture as the
    // T&S auto-score's 12s race above (pre-push r1 P1: the completion SMS
    // goes out from this very handler moments later, so a pure background
    // warm loses the race for customers who open the link immediately).
    // On timeout the warm finishes in the background and the next view
    // self-heals to a priced card; a cold first view is exactly today's
    // CTA behavior, never wrong data. The module is double-gated (dark by
    // default) and never rejects, so a slow or failing lookup can't affect
    // any completion. Backfills are excluded: their customers already
    // received (or never had) the report moment this exists to serve.
    // Replays are cache-first no-ops.

    // Live-override completions correct the linked technician timer too
    // (codex P1, pre-push audit round 20c): the correction is authoritative
    // for costing via the durable stamp, but without this sync timesheets
    // and utilization kept the inflated span — and the corrected value
    // becomes the edit modal's seed, so no later save would re-invoke the
    // after-the-fact PATCH. Same revision-fenced audited sync the PATCH
    // uses; committedSeq is the revision this finalization created (or
    // adopted). Runs on crash-resumed retries too — idempotent, the
    // divergence check no-ops once the entry agrees. Backfills are
    // excluded: their entries are historic and the quiet-closeout posture
    // owns them.
    let completionTimerSync = { corrected: null, blocked: null };
    if (!isBackfillCompletion && typeof effectiveTimeOnSite === 'number') {
      completionTimerSync = await syncLinkedJobTimer({
        serviceId: svc.id,
        minutes: effectiveTimeOnSite,
        committedSeq: svc.time_on_site_correction_seq ?? null,
        editedBy: completionInput.actor.technicianId,
        entriesSnapshot: completionTimerEntriesSnapshot,
      });
    }

    if (isIncompleteVisit) {
      // Recurring plan refill / end-of-plan flag — an incomplete-outcome
      // completion still flips the scheduled_services row to 'completed'
      // (only the service_record carries 'incomplete'), so the visit consumed
      // its series slot and the refill check is due here too. This early
      // return sits ABOVE the main maintenance hook below, so without this the
      // series would never top up on incomplete completions. Same failure-
      // isolated contract: never fails the committed completion.
      try {
        const { runPostCompletionSeriesMaintenance } = require('../services/recurring-series-extend');
        await runPostCompletionSeriesMaintenance({ db, svc, source: 'dispatch_complete_incomplete' });
      } catch (seriesErr) {
        logger.error(`[dispatch] recurring series maintenance failed (non-blocking): ${seriesErr.message}`);
      }
      // Completion comms guard on the incomplete path too (same reason the
      // series hook is duplicated here): this early return ALSO leaves the
      // scheduled_services row 'completed', and an incomplete outcome is if
      // anything the likelier home for the exception — "nobody home" on the
      // day the customer texted to say they'd be away is exactly the case
      // this guard exists to surface. The runner is gated, fail-soft and
      // deduped per visit, so the two call sites can never double-bell.
      // Backfills excluded (route-wide quiet-closeout posture): a backdated
      // cleanup of a months-old row must not ring a live bell correlating it
      // with an unrelated text from the last week.
      if (!isBackfillCompletion) {
        try {
          const { runCompletionCommsGuard } = require('../services/completion-comms-guard');
          await runCompletionCommsGuard({ serviceId: svc.id, customerId: svc.customer_id });
        } catch (commsGuardErr) {
          logger.warn(`[dispatch] completion comms guard failed (non-blocking): ${commsGuardErr.message}`);
        }
      }
      const responsePayload = {
        success: true,
        serviceRecordId: record.id,
        invoiceId: null,
        invoiceTotal: null,
        completionPhotoUpload: completionPhotoUploadResult,
        completionAdvisories: completionAdvisoryMessages({
          blackout: waveguardBlackoutApproval,
          nLimit: waveguardNLimitApproval,
          manager: waveguardManagerApproval,
          calibration: waveguardCalibrationAdvisory,
          inventory: waveguardInventoryAdvisory,
        }),
        ...(completionTimerSync.corrected != null ? { timeEntryCorrected: completionTimerSync.corrected } : {}),
        ...(completionTimerSync.blocked ? { timeEntryCorrectionBlocked: completionTimerSync.blocked } : {}),
      };
      await CompletionAttempts.markCompletionAttemptSucceeded(completionAttempt, { record, invoice: null, response: responsePayload });
      markedSucceeded = true;
      return ({ status: 200, body: responsePayload });
    }

    // Invoice + completion SMS:
    //   - If the appointment was flagged `create_invoice_on_complete` (scheduler's
    //     "Create invoice" checkbox) OR the customer is WaveGuard with a monthly_rate,
    //     generate an invoice and send a single combined SMS (report + pay link),
    //     unless the visit is already covered by prepay/paid invoice/autopay.
    //   - Otherwise send the plain service-complete SMS (report link only).
    // (hasVisitPrice + visitPerformed + the billing-lane classification +
    // invoiceAmount are hoisted above the completion transaction — the
    // commit-time required-mint posture freezes off the exact derivations
    // this block reads; deriving them twice is the drift the fix-round-9
    // broadening exists to prevent.)
    // A billable per-application visit with no amount on file (multi-service
    // accept: fee + row prices intentionally NULL) completes UNINVOICED — flag
    // it loudly so the visit gets billed manually instead of leaking.
    if (perApplicationBilling && !(invoiceAmount > 0)
      && !svc.is_callback && !isAlwaysFreeServiceType(svc.service_type)) {
      logger.warn(`[dispatch] per-application visit ${svc.id} (customer ${svc.customer_id}) completed with no billable amount on file (no visit price, no per_application_fee — multi-service plan?) — invoice manually`);
    }
    // Same loud-flag convention for the explicit per-visit/one-time lanes:
    // their monthly-rate fallback is suppressed (the dues number is not a
    // per-visit price — Codex r4), so an unpriced billable visit completes
    // uninvoiced and must be billed manually.
    if (['per_visit', 'one_time'].includes(svc.cust_billing_mode || '') && !perApplicationBilling
      && !(invoiceAmount > 0) && !svc.is_callback && !isAlwaysFreeServiceType(svc.service_type)) {
      logger.warn(`[dispatch] ${svc.cust_billing_mode} visit ${svc.id} (customer ${svc.customer_id}) completed with no billable amount on file (monthly-rate fallback suppressed for explicit non-monthly lanes) — invoice manually`);
    }
    // (visitIsPayerBilled + customerAutopayActive + autopayCoversVisit are
    // hoisted above the completion transaction — fix round 12: dues coverage
    // is a commit-time business suppressor the frozen posture must read, so
    // the freeze and this block share one derivation, exactly like the
    // billing-lane classification and the invoice amount.)
    // A priced recurring visit suppressed by membership coverage is logged +
    // parked for office review AFTER the invoice checks below — see the
    // shouldInvoice block (an already-paid / pre-minted / existing invoice
    // must not produce a "no invoice was cut" alert — Codex r2).
    // Skip invoice creation if a paid invoice already exists for this service record
    // (covers the "customer paid prior to service report" case)
    let invoiceCreated = false;
    let payUrl = null;
    let invoice = null;
    let alreadyPaid = false;
    let paymentCollectionSuppressed = false;
    let paymentReconciliationRequired = false;
    // Suppressor-lookup health (pre-push Codex P0, gate-removal round 2):
    // these lookups are best-effort for every historical lane, but the
    // LIVE typed one-time mint they now guard inherited the removed
    // pre-gate's fail-closed verification — a mint on top of a FAILED
    // lookup could duplicate an invoice it failed to see. The mint block
    // refuses when this flag is set (release/503 → the retry re-runs the
    // lookups); every other lane keeps the non-blocking behavior.
    let invoiceLookupFailed = false;
    try {
      if (!recapReviewOnly) {
        const existingPaid = await db('invoices')
          .where({ service_record_id: record.id })
          .whereIn('status', ['paid', 'prepaid'])
          .first();
        if (existingPaid) alreadyPaid = true;
      }
    } catch (e) { invoiceLookupFailed = true; /* non-blocking */ }
    let existingCompletionInvoice = null;
    // A REFUNDED invoice on THIS visit (codex #3456): the suppressor
    // above skips it (it collects nothing), but a fresh mint beside it is
    // unsafe while its refund can still bounce — so it blocks the mint via
    // shouldAutoInvoiceCompletion and parks a manual-billing alert below.
    // Never assigned to `invoice` / `payUrl` (no pay link to a dead invoice).
    let terminalCompletionInvoice = null;
    let completionLiveBesideInvoice = null;
    let completionTerminalIncludedSetupFee = false;
    try {
      existingCompletionInvoice = await completionSuppressorInvoiceLookup(db, { service_record_id: record.id });
      if (!existingCompletionInvoice) {
        existingCompletionInvoice = await completionSuppressorInvoiceLookup(db, { scheduled_service_id: svc.id });
        if (existingCompletionInvoice && !existingCompletionInvoice.service_record_id) {
          await db('invoices').where({ id: existingCompletionInvoice.id }).update({
            service_record_id: record.id,
            technician_id: svc.technician_id || existingCompletionInvoice.technician_id || null,
            updated_at: new Date(),
          });
        }
      }
    } catch (e) { invoiceLookupFailed = true; /* non-blocking */ }
    // Own-visit refunded check right after the direct suppressors and
    // BEFORE the sibling first-application fallback (pre-push P0): that
    // fallback matches the current visit too (same customer/estimate/
    // date) and filters only 'void', so it would hand back this visit's
    // own refunded invoice as a dead pay link and skip the alert. Runs
    // UNCONDITIONALLY (not only when the suppressors found nothing) and
    // reconciles by recency: a refunded invoice NEWER than the live row
    // the suppressor found wins (manual path, older live row not reused);
    // an older refunded one is history. Siblings are consulted only when
    // neither a live nor a refunded own-visit invoice stands.
    // OUTSIDE the non-blocking try above and FAIL CLOSED (pre-push P0):
    // invoiceLookupFailed only blocks the typed-required lane, so a
    // swallowed failure here would let every other billable lane mint
    // beside an unseen refunded invoice that refund.failed may restore to
    // paid. The service_record is already committed, so a failure releases
    // the attempt for resume and 503s — the same exit as a required mint
    // failure; the retry re-runs this check.
    if (!recapReviewOnly) {
      let refundedOnVisit = null;
      let newestLiveOnVisit = null;
      try {
        refundedOnVisit = await completionTerminalInvoiceLookup(db, {
          serviceRecordId: record.id,
          scheduledServiceId: svc.id,
        });
        if (refundedOnVisit && existingCompletionInvoice) {
          newestLiveOnVisit = await completionNewestLiveInvoiceLookup(db, {
            serviceRecordId: record.id,
            scheduledServiceId: svc.id,
          });
        }
      } catch (lookupErr) {
        logger.error(`[dispatch] refunded-invoice check FAILED for ${svc.id} — closeout NOT finalized: ${lookupErr.message}`);
        const released = await CompletionAttempts.releaseCompletionAttemptForResume(completionAttempt, lookupErr);
        if (!released) {
          logger.error(`[dispatch] release-for-resume did NOT release attempt ${completionAttempt?.id} for ${svc.id} — retry blocked until the ${Math.ceil(CompletionAttempts.STALE_SIDE_EFFECTS_MS / 60000)}-minute stale window reclaims it`);
        }
        return ({ status: 503, body: {
          error: released
            ? 'The refunded-invoice check for this visit failed — the closeout is saved but NOT finalized. Retry the closeout.'
            : `The refunded-invoice check for this visit failed — the closeout is saved but NOT finalized. It will become retryable within about ${Math.ceil(CompletionAttempts.STALE_SIDE_EFFECTS_MS / 60000)} minutes — retry the closeout then.`,
          code: 'terminal_invoice_lookup_failed',
          ...(released ? {} : { retryAfterMs: CompletionAttempts.STALE_SIDE_EFFECTS_MS }),
          serviceRecordId: record.id,
        } });
      }
      const reconciled = reconcileLiveVsRefunded(existingCompletionInvoice, refundedOnVisit, newestLiveOnVisit);
      existingCompletionInvoice = reconciled.existing;
      terminalCompletionInvoice = reconciled.terminal;
      // Live invoice coexisting with the refunded one — the manual-billing
      // alert names it so the office collects IT instead of cutting a
      // duplicate (see reconcileLiveVsRefunded).
      completionLiveBesideInvoice = reconciled.liveBeside;
    }
    try {
      if (!existingCompletionInvoice && !terminalCompletionInvoice) {
        const siblingFirstApplication = await findFirstApplicationInvoiceForEstimateService(svc, db);
        existingCompletionInvoice = siblingFirstApplication.invoice;
        if (!recapReviewOnly) {
          const split = splitTerminalCompletionInvoice(existingCompletionInvoice);
          existingCompletionInvoice = split.existing;
          if (split.terminal) {
            terminalCompletionInvoice = split.terminal;
            // A live first-application sibling beside the refunded one —
            // the manual-billing alert names it (codex #3456 r7), same as
            // the own-visit reconciliation's liveBeside.
            completionLiveBesideInvoice = siblingFirstApplication.liveBeside || null;
          } else if (!existingCompletionInvoice && siblingFirstApplication.canceledSetupFee) {
            // Canceled ACCEPTANCE invoice with no live replacement (codex
            // #3456 late-round P1): it carried the one-time setup fee
            // beside the visit charge, so an ordinary completion mint would
            // recreate only the visit charge and silently drop the fee.
            // Park the manual path instead — the alert tells the office to
            // bill BOTH charges by hand.
            const c = siblingFirstApplication.canceledSetupFee;
            terminalCompletionInvoice = { id: c.id, invoice_number: c.invoice_number, status: c.status };
            completionTerminalIncludedSetupFee = true;
          }
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
          if (['paid', 'prepaid'].includes(existingCompletionInvoice.status)) alreadyPaid = true;
          else invoiceCreated = true;
        }
      }
    } catch (e) { invoiceLookupFailed ||= true; /* non-blocking — same flag as the direct-suppressor catch above */ }
    // Never-minted setup fee (owner ruling 2026-08-24, gate
    // GATE_UNMINTED_SETUP_FEE_PARK): the standard verbal Mark Won accept
    // skips the acceptance invoice by design (estimate-manual-acceptance),
    // so a solo-plan first visit reaches completion with NO setup-fee
    // invoice anywhere — an ordinary completion mint would bill only the
    // per-application price and the one-time setup fee silently
    // evaporates. Detect it and PARK the mint for manual billing (alert
    // block below), the same shape as the canceled-setup-fee parking
    // (#3474). FAIL CLOSED like the refunded-invoice check above: this
    // hold is the only thing standing between the completion and the
    // fee-dropping mint, so a swallowed read failure would re-open the
    // leak for exactly the visits the gate exists to protect.
    // Runs even when a pre-completion Charge Now invoice already exists on
    // the visit (Codex PR r2 P1): that invoice carries only the application
    // charge, so the setup fee is STILL unbilled — the completion reuses
    // the invoice unheld (see unmintedSetupFeeHold below) and the alert
    // block parks a bill-the-fee-beside-it instruction instead of a mint
    // hold. Terminal (refunded) invoices keep their own alert lane.
    // Terminal invoices no longer skip the detector (Codex P0, pre-push
    // round 11): a refunded Charge Now application invoice reaches only
    // the terminal alert, whose default instruction says to bill the
    // visit — with a Mark Won accept the setup fee is STILL unbilled, so
    // the detector runs and the terminal alert appends the missing-fee
    // instruction (terminalSetupFeeNote below) instead of a second park.
    // The detector's own fee-carrying-refund suppression is retained: a
    // refunded invoice that BILLED the fee reads not-owed.
    let unmintedSetupFeeObligation = null;
    let terminalSetupFeeNote = '';
    let setupFeeReconcileAfterCommit = false;
    if (!recapReviewOnly
      && svc.source_estimate_id && process.env.GATE_UNMINTED_SETUP_FEE_PARK === 'true') {
      try {
        const { findUnmintedSetupFeeObligation } = require('../services/setup-fee-obligation');
        const obligation = await findUnmintedSetupFeeObligation({
          sourceEstimateId: svc.source_estimate_id,
          customerId: svc.customer_id,
          excludeScheduledServiceId: svc.id,
          // A one-time add-on sourced from the same estimate never owns the
          // obligation — holding ITS mint would drop the add-on's own
          // charge. Plan membership is judged on durable recurrence
          // identity, never service-type text.
          visitPlanRow: {
            is_recurring: svc.is_recurring,
            recurring_parent_id: svc.recurring_parent_id || null,
          },
        }, db);
        const setupFeeDedupeKey = `unminted_setup_fee_manual_billing:${svc.source_estimate_id}`;
        // Stale-alert reconciliation (Codex P0, pre-push rounds 8–10):
        // runs on EVERY completion that does not itself park, whatever
        // the detector said — the manual invoice the alert requests is
        // normally attached to the parked visit WITHOUT the estimate
        // stamp, so the detector can stay "owed" (or flip
        // firstVisitAlreadyCompleted) while the alert's charges are in
        // fact covered. Resolution requires per-charge proof from live
        // invoices: one billing the fee AND one billing the parked
        // visit's application — never the detector's estimate-level
        // verdict alone.
        const reconcileParkedSetupFeeAlert = () => require('../services/setup-fee-alert-reconcile')
          .reconcileSetupFeeAlert({
            customerId: svc.customer_id,
            sourceEstimateId: svc.source_estimate_id,
            actorLabel: ` visit ${svc.id}:`,
          });
        if (obligation.owed && !obligation.firstVisitAlreadyCompleted && terminalCompletionInvoice) {
          // The terminal (refunded-invoice) alert lane owns this visit —
          // append the missing-fee instruction to ITS alert rather than
          // parking a second one (Codex P0, pre-push round 11).
          terminalSetupFeeNote = ` ALSO: the one-time WaveGuard setup fee ($${Number(obligation.setupFee || 0).toFixed(2)}) for accepted estimate ${obligation.estimateSlug || obligation.estimateId} was never invoiced — bill it beside the visit charge above; verify it is not already on a live invoice before billing.`;
        } else if (obligation.owed && !obligation.firstVisitAlreadyCompleted) {
          // One parked visit per estimate (Codex P0, pre-push round 8):
          // the fee obligation stays owed while a parked visit sits
          // unbilled, so a LATER plan visit would also qualify — but
          // parking it too would collapse two unbilled applications into
          // one singular estimate-wide instruction. The FIRST parked
          // visit's alert owns the setup fee + its own application; every
          // later visit mints its application charge normally.
          // Resolved alerts do not own the parking (Codex P0, pre-push
          // round 9): if coverage was later voided and the obligation
          // reopened, a resolved alert must not swallow the new park —
          // the in-transaction rewrite below reactivates it
          // (resolvedCovered flips back to false).
          const priorParkedAlert = await db('notifications')
            .where({ recipient_type: 'admin' })
            .whereRaw("metadata->>'dedupeKey' = ?", [setupFeeDedupeKey])
            .whereRaw("COALESCE(metadata->>'resolvedCovered', '') <> 'true'")
            .first('id', 'metadata');
          const parkedVisitId = priorParkedAlert && (typeof priorParkedAlert.metadata === 'string'
            ? (() => { try { return JSON.parse(priorParkedAlert.metadata)?.scheduledServiceId; } catch { return null; } })()
            : priorParkedAlert.metadata?.scheduledServiceId);
          if (priorParkedAlert && String(parkedVisitId || '') !== String(svc.id)) {
            logger.warn(`[dispatch] visit ${svc.id}: estimate ${obligation.estimateSlug || obligation.estimateId} already has a parked setup-fee alert on visit ${parkedVisitId || '?'} — this application mints normally, the parked alert keeps the fee`);
            await reconcileParkedSetupFeeAlert();
          } else {
            unmintedSetupFeeObligation = obligation;
          }
        } else {
          if (obligation.owed && obligation.firstVisitAlreadyCompleted) {
            // Historic leak (an earlier plan visit completed AND billed
            // bare): never park THIS routine visit — its own application
            // invoices normally — but the fee still needs a DURABLE
            // follow-up (Codex PR r8 P1): a log line alone left it
            // permanently uncollected. Park a FEE-ONLY alert under the
            // same dedupe key (skipped when any alert already stands);
            // best-effort — the next series completion retries.
            logger.warn(`[dispatch] visit ${svc.id}: estimate ${obligation.estimateSlug || obligation.estimateId} owes an un-invoiced setup fee but an earlier plan visit already completed and billed — parking a fee-only alert, this visit invoices normally`);
            try {
              await db.transaction(async (trx) => {
                await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [setupFeeDedupeKey]);
                const existing = await trx('notifications')
                  .where({ recipient_type: 'admin' })
                  .whereRaw("metadata->>'dedupeKey' = ?", [setupFeeDedupeKey])
                  .first('id');
                if (existing) return; // reconcile owns the standing alert
                const histRef = obligation.estimateSlug || obligation.estimateId;
                const histFee = `$${Number(obligation.setupFee || 0).toFixed(2)}`;
                const created = await require('../services/notification-service').notifyAdmin(
                  'billing',
                  'Setup fee never invoiced — historic first visit billed without it',
                  `The first application for accepted estimate ${histRef} was completed and billed WITHOUT its one-time WaveGuard setup fee (${histFee}). Bill ONLY the fee — use the EXACT line description "WaveGuard Membership — one-time setup fee" and include "accepted estimate #${obligation.estimateId}" in the invoice notes so the system recognizes it as billed. Do NOT re-bill any application.`,
                  {
                    link: `/admin/customers/${svc.customer_id}`,
                    bell: true,
                    metadata: {
                      dedupeKey: setupFeeDedupeKey,
                      customerId: svc.customer_id,
                      sourceEstimateId: obligation.estimateId,
                      feeOnly: true,
                      expectedSetupFeeCents: Math.round(Number(obligation.setupFee || 0) * 100),
                      // The EXACT billed visits that justified this alert
                      // (Codex P0): reconciliation revalidates only these.
                      historicVisitIds: obligation.billedPriorPlanVisitIds || [],
                    },
                    connection: trx,
                  },
                );
                if (!created) throw new Error('historic fee-only notification insert failed');
              });
            } catch (histErr) {
              // FAIL CLOSED (Codex PR r15 P1): this alert is the fee's
              // only durable follow-up — a customer's LAST completion (or
              // a cancellation before another) would otherwise carry the
              // leak forward with nothing standing. Same
              // release-for-resume + 503 shape as the parking alert.
              logger.error(`[dispatch] historic setup-fee alert FAILED for ${svc.id} — closeout NOT finalized: ${histErr.message}`);
              const released = await CompletionAttempts.releaseCompletionAttemptForResume(completionAttempt, histErr);
              if (!released) {
                logger.error(`[dispatch] release-for-resume did NOT release attempt ${completionAttempt?.id} for ${svc.id} — retry blocked until the ${Math.ceil(CompletionAttempts.STALE_SIDE_EFFECTS_MS / 60000)}-minute stale window reclaims it`);
              }
              return ({ status: 503, body: {
                error: released
                  ? 'A historic setup-fee alert for this estimate could not be recorded — the closeout is saved but NOT finalized. Retry the closeout.'
                  : `A historic setup-fee alert for this estimate could not be recorded — the closeout is saved but NOT finalized. It will become retryable within about ${Math.ceil(CompletionAttempts.STALE_SIDE_EFFECTS_MS / 60000)} minutes — retry the closeout then.`,
                code: 'historic_setup_fee_alert_failed',
                ...(released ? {} : { retryAfterMs: CompletionAttempts.STALE_SIDE_EFFECTS_MS }),
                serviceRecordId: record.id,
              } });
            }
          }
          await reconcileParkedSetupFeeAlert();
        }
      } catch (lookupErr) {
        logger.error(`[dispatch] unminted-setup-fee check FAILED for ${svc.id} — closeout NOT finalized: ${lookupErr.message}`);
        const released = await CompletionAttempts.releaseCompletionAttemptForResume(completionAttempt, lookupErr);
        if (!released) {
          logger.error(`[dispatch] release-for-resume did NOT release attempt ${completionAttempt?.id} for ${svc.id} — retry blocked until the ${Math.ceil(CompletionAttempts.STALE_SIDE_EFFECTS_MS / 60000)}-minute stale window reclaims it`);
        }
        return ({ status: 503, body: {
          error: released
            ? 'The setup-fee check for this visit failed — the closeout is saved but NOT finalized. Retry the closeout.'
            : `The setup-fee check for this visit failed — the closeout is saved but NOT finalized. It will become retryable within about ${Math.ceil(CompletionAttempts.STALE_SIDE_EFFECTS_MS / 60000)} minutes — retry the closeout then.`,
          code: 'unminted_setup_fee_lookup_failed',
          ...(released ? {} : { retryAfterMs: CompletionAttempts.STALE_SIDE_EFFECTS_MS }),
          serviceRecordId: record.id,
        } });
      }
    }
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
        preMintedInvoice = await completionSuppressorInvoiceLookup(db, { scheduled_service_id: svc.id });
        // Refunded-invoice reconciliation wins here too (pre-push P0): when
        // a newer refunded invoice beat an older live row above, this lookup
        // would fetch that same older row again and its pay link would be
        // reused via the preMintedInvoice branch. The visit is on the
        // manual-billing path — nothing is reused.
        if (terminalCompletionInvoice) preMintedInvoice = null;
      }
    } catch (e) { invoiceLookupFailed = true; /* column may not exist pre-migration — non-blocking */ }
    // Required-mint money authority (Codex P0, fix round 10): on a resume
    // whose frozen posture is REQUIRED, the FROZEN amount/tax are the money
    // truth — the live derivations read by-now-mutable billing fields, and
    // a price cleared after a released mint failure would flip the amount
    // guard false and finalize the closeout without its required invoice
    // (lost AR), while an edited price/property_type would mint the wrong
    // money. First runs keep the live values (identical to what the freeze
    // just stamped in this same request). A required resume MISSING its
    // frozen amount (pre-round-10 record, corrupt notes) deliberately keeps
    // the live value HERE so the decision still reaches the mint block —
    // which then refuses to mint the unverifiable amount and fail-closes
    // through the existing release/503 catch.
    const mintInvoiceAmount = backfillReviewMintRequired && backfillFrozenMintAmount != null
      ? backfillFrozenMintAmount
      : invoiceAmount;
    // LAZY mint tax basis (r6 P1): resolved inside the mint try, only when
    // an invoice is actually being minted. Frozen contract first (required
    // resumes), the memoized live derivation otherwise — whose failure
    // fail-closes the required lane through the release/503 catch and stays
    // non-blocking (invoice-less, loud) on the non-required lanes, exactly
    // like every other mint failure.
    const resolveMintInvoiceTaxRate = async () => (
      backfillReviewMintRequired && backfillFrozenMintTaxRate != null
        ? backfillFrozenMintTaxRate
        : deriveCompletionTaxRate()
    );
    // The Bill-To identity the mint's frozen rate belongs to (r4 P0): the
    // restored frozen id on a stamped resume, the live resolution otherwise.
    // undefined (legacy resume with no stamp, or a parked live lookup)
    // skips create()'s enforcement — create's own fail-closed resolution
    // (throwOnError under frozenTaxAuthority) still governs the mint.
    const mintInvoicePayerId = backfillReviewMintRequired && backfillFrozenMintPayerId !== undefined
      ? backfillFrozenMintPayerId
      // A RESUMED record lacking the identity stamp stays undefined (post-
      // merge audit P0): supplying the live payer would make create() treat
      // a LEGACY frozen rate as a complete contract and bypass residential
      // zeroing / exemption handling for a rate that never encoded them.
      // Only a first-run live-derived contract pins the live identity.
      : (resumingCommittedCompletion || completionTaxAuthorityError
        ? undefined
        : (completionResolvedPayer?.payerId || null));
    // Auto-invoice eligibility. With GATE_AUTOINVOICE_PRICED_VISITS on, an
    // explicitly-priced visit also qualifies even without the scheduler's
    // create_invoice_on_complete flag or a WaveGuard tier — closing the leak
    // where priced, self-pay, non-WaveGuard visits completed uninvoiced.
    // Default OFF = behaviour identical to before.
    // Hoisted so the terminal-invoice alert below can re-ask the SAME gate
    // with only the terminal flag cleared (deciding-reason check).
    const completionInvoiceGateInput = {
      recapReviewOnly,
      alreadyPaid,
      prepaidCovered,
      autopayCoversVisit,
      preMintedInvoice,
      existingCompletionInvoice,
      // Refunded invoice on this visit → never mint a replacement (codex
      // #3456); the manual-billing alert below owns the follow-up.
      terminalInvoiceOnVisit: !!terminalCompletionInvoice,
      // Setup fee owed but never invoiced (Mark Won accept) → never mint
      // the bare per-application invoice; the parking alert below owns
      // the follow-up (bill setup + first application by hand). NOT held
      // when a Charge Now invoice already exists on the visit — the
      // completion must keep reusing that invoice exactly as before; the
      // alert then requests only the still-unbilled fee (Codex PR r2 P1).
      // Both lookups are consulted (Codex P0, pre-push round 7): an
      // invoice minted between the two reads appears only in
      // preMintedInvoice, and the hold and beside-branch must agree.
      unmintedSetupFeeHold: !!unmintedSetupFeeObligation && !existingCompletionInvoice && !preMintedInvoice,
      createInvoiceOnComplete: svc.create_invoice_on_complete,
      waveguardTier: svc.cust_waveguard_tier,
      explicitMembership: explicitMembershipLane,
      explicitPerVisitLane,
      perApplicationBilling,
      annualPrepayBilling,
      hasVisitPrice,
      // The frozen amount on a required resume, the live derivation
      // otherwise — guard and mint read the SAME number (fix round 10).
      invoiceAmount: mintInvoiceAmount,
      autoInvoicePricedVisits: process.env.GATE_AUTOINVOICE_PRICED_VISITS === 'true',
      serviceType: svc.service_type,
      isCallback: svc.is_callback,
      // inspection_only / customer_declined = no application performed
      // (mirrors referralVisitPerformed; 'incomplete' returned earlier).
      visitPerformed,
      // REQUIRED-mint posture: the live commit-time derivation on first run
      // (identical to what the typed backfill branch would recompute), the
      // FROZEN structured_notes posture on resume — the branch honors it in
      // both directions so a mutated billing profile can neither drop the
      // owed mint nor invent one (Codex P0, fix round 8).
      backfillMintRequired: backfillReviewMintRequired,
      // Typed one-time completions bypass the billing pre-gate under
      // backfill — this mint is what stands in for the checkout detour, so
      // the helper needs to know the visit belongs to that gated population.
      typedOneTimeBilling: typedOneTimeBillingProfile,
      // Backfill review-invoice override: an out-of-band prepaid_amount must
      // not suppress the promised open invoice; the annual-prepay leg keeps
      // suppressing (see the helper's comment). isBackfillCompletion is
      // resume-safe here — re-derived from the structured_notes freeze above.
      isBackfillCompletion,
      annualPrepayCovered,
    };
    const shouldInvoice = shouldAutoInvoiceCompletion(completionInvoiceGateInput);
    // An annual-prepay visit completing WITHOUT coverage (no prepaid stamp,
    // not already paid) that the gate ALSO declined to bill (an explicitly
    // priced add-on invoices normally — Codex round-11) means the term
    // expired and renewal hasn't happened — flag it loudly for the renewal
    // flow / manual invoicing instead of leaking a free visit.
    if (annualPrepayBilling && !shouldInvoice && !recapReviewOnly && !prepaidCovered && !alreadyPaid
      && !svc.is_callback && !isAlwaysFreeServiceType(svc.service_type)) {
      logger.warn(`[dispatch] annual-prepay visit ${svc.id} (customer ${svc.customer_id}) completed WITHOUT prepay coverage — term expired/refunded? Renewal or manual invoice needed`);
    }
    // Refunded invoice blocked the mint (codex #3456): the visit ran and is
    // owed money, but its prior invoice was refunded and NO
    // replacement is minted (a bounced refund could restore the original
    // beside it). Park it on the admin billing bell — same notification
    // mechanism and dedupe pattern as the dues-covered alert below — so a
    // human bills it once the refund is final. Skipped when something else
    // already covers the money (paid / prepaid / dues / pre-minted), and —
    // deciding-reason check, same convention as the dues alert below — when
    // the gate would decline to invoice even WITHOUT the refunded row
    // (callback, always-free type, visit not performed, unpriced, no billing
    // trigger): such a visit owes nothing, so it must neither ring the
    // manual-billing bell nor expose the closeout to the alert-failure 503.
    if (terminalCompletionInvoice && !shouldInvoice && !recapReviewOnly
      && !alreadyPaid && !prepaidCovered && !autopayCoversVisit && !preMintedInvoice && !existingCompletionInvoice
      && shouldAutoInvoiceCompletion({ ...completionInvoiceGateInput, terminalInvoiceOnVisit: false })) {
      logger.warn(`[dispatch] visit ${svc.id}: prior invoice ${terminalCompletionInvoice.invoice_number || terminalCompletionInvoice.id} is ${terminalCompletionInvoice.status} — NO replacement invoice minted; manual billing alert parked`);
      // This alert is the ONLY durable follow-up for the owed money, so it
      // fails CLOSED (pre-push P0): notifyAdmin returns null on an insert
      // failure and a transaction error must not be swallowed either. On
      // failure exit through the same release-for-resume + 503 the
      // typed-required mint failure uses — the service_record is already
      // committed above, the attempt goes back to side_effects_pending, and
      // the tech's retry re-enters here (the dedupe lock makes a second
      // attempt idempotent).
      let manualBillingAlerted = false;
      let manualBillingAlertError = null;
      try {
        const dedupeKey = `terminal_invoice_manual_billing:${svc.id}`;
        // The flag flips only from the transaction's RESOLVED value — an
        // assignment inside the callback survives a failed COMMIT (the
        // insert rolls back but the flag stays true) and would let the
        // closeout finalize without its only durable follow-up.
        manualBillingAlerted = true === await db.transaction(async (trx) => {
          // Shared mint serialization FIRST (codex r12 P1): every
          // scheduled-service invoice writer keys on the schedule.invoice.mint
          // advisory lock — holding it here means no Charge Now / scheduled
          // mint can insert a live invoice between the fresh lookup below
          // and this transaction's commit. Taken BEFORE the dedupe lock so
          // the lock order is deterministic across retries.
          const { acquireScheduledInvoiceMintLock } = require('../services/scheduled-invoice-mint');
          // Estimate/date SIBLING visits can carry the first-application
          // invoice, and a sibling mint contends on the SIBLING's lock key —
          // so the lock set is this visit PLUS its siblings, acquired in
          // sorted order (codex r13: two sibling completions locking
          // own-then-other would ABBA-deadlock; a global sort cannot).
          let alertSiblingServiceIds = [];
          if (svc.source_estimate_id) {
            const { dateOnly } = require('../services/estimate-first-application-invoice');
            alertSiblingServiceIds = await trx('scheduled_services')
              .where({ source_estimate_id: svc.source_estimate_id, customer_id: svc.customer_id })
              .where('scheduled_date', dateOnly(svc.scheduled_date))
              .pluck('id');
          }
          const alertMintLockIds = Array.from(new Set([String(svc.id), ...alertSiblingServiceIds.map(String)])).sort();
          for (const lockId of alertMintLockIds) {
            await acquireScheduledInvoiceMintLock(trx, lockId);
          }
          // Canonical order: mint locks → setup-fee dedupe lock →
          // terminal dedupe lock (Codex P0): when this alert registers a
          // fee clause, a stamped manual invoice serialized on the
          // setup-fee key must not commit between the fee scan and this
          // insert.
          if (unmintedSetupFeeObligation && svc.source_estimate_id) {
            await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`unminted_setup_fee_manual_billing:${svc.source_estimate_id}`]);
          }
          await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [dedupeKey]);
          const already = await trx('notifications')
            .where({ recipient_type: 'admin' })
            .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey])
            .first('id');
          // ATOMIC revalidation (codex #3456 r8–r11), even when a dedupe
          // notification already exists — a retry must not preserve stale
          // advice. All reads happen on THIS transaction:
          // 1. The refunded row FOR UPDATE (serialized with the webhook's
          //    row update): restored to paid/prepaid → covered; restored to
          //    a collectible/in-flight status (refund.failed can reopen a
          //    failed-ACH invoice via nextInvoiceStatusAfterFailedPayment)
          //    → still owed, and the reinstated invoice is the row to act
          //    on. Still refunded → park as designed.
          const terminalNow = await trx('invoices')
            .where({ id: terminalCompletionInvoice.id })
            .forUpdate()
            .first('id', 'invoice_number', 'status');
          // "Restored" means LEFT the refunded state for a non-resolved one —
          // a concurrently canceled/cancelled/void row is dead, not restored
          // (codex r12 P1): naming it "collect THAT invoice" would point
          // staff at a non-collectible row. Resolved-away rows fall through
          // to the fresh-live/sibling/generic note, whose "bill manually"
          // instruction is then exactly right (no invoice stands).
          const terminalResolvedAway = require('../services/invoice').CANCELLED_SERVICE_RESOLVED_STATUSES;
          const terminalRestored = terminalNow
            && !COMPLETION_TERMINAL_INVOICE_STATUSES.includes(terminalNow.status)
            && !terminalResolvedAway.includes(terminalNow.status)
            ? terminalNow : null;
          // 2. EVERY on-visit invoice row, locked FIRST with NO status
          //    filter, then classified from the locked statuses (codex P0
          //    round: a status-filtered select can MISS a row that a
          //    concurrent transaction is restoring to collectible — its
          //    transition commits after our snapshot; FOR UPDATE returns
          //    the latest committed versions and holds them to commit).
          //    Also covers a collectible invoice minted after the unlocked
          //    lookups — the advisory mint locks make new mints wait, and
          //    existing rows are all locked here.
          const onVisitLockedRows = await trx('invoices')
            .where((qb) => {
              qb.orWhere({ service_record_id: record.id });
              qb.orWhere({ scheduled_service_id: svc.id });
            })
            .forUpdate()
            .orderBy('created_at', 'desc')
            .orderBy('id', 'desc')
            .select('id', 'invoice_number', 'status', 'line_items', 'notes');
          // Fee coverage is classified INDEPENDENTLY from the visit
          // charge (Codex PR r3 P1) and CENTS-EXACT against the accepted
          // amount (Codex PR r13 P1): a $9.90 partial fee line must not
          // erase the note — the remainder is instructed instead.
          const {
            sumPositiveSetupFeeCents: terminalFeeCents,
            sumBaseApplicationCents: terminalAppCents,
            invoiceBillsBaseApplication: terminalBillsApp,
          } = require('../services/estimate-first-application-invoice');
          // The replacement pick PREFERS a row that actually bills the
          // application (Codex PR r24 P1): with a newer fee-only invoice
          // beside an older paid application invoice, newest-first chose
          // the wrong row and the alert directed staff at it.
          const freshLiveRows = onVisitLockedRows.filter((r) => String(r.id) !== String(terminalCompletionInvoice.id)
            && !terminalResolvedAway.includes(r.status));
          const freshLiveOnVisit = freshLiveRows.find((r) => terminalBillsApp(r)) || freshLiveRows[0] || null;
          const termExpectedFeeCents = Math.round(Number(unmintedSetupFeeObligation?.setupFee || 0) * 100);
          // Stamped fee invoices are RE-SCANNED inside this transaction
          // (Codex PR r18 P1): a stamped unattached fee invoice that
          // committed after the obligation lookup — the exact write the
          // setup-fee lock serializes — must count, or the alert
          // instructs an already-covered fee.
          const stampedFeeRowsNow = unmintedSetupFeeObligation && svc.source_estimate_id
            ? await trx('invoices')
              .where({ customer_id: svc.customer_id })
              .where('notes', 'like', `%accepted estimate #${svc.source_estimate_id}%`)
              .forUpdate()
              .select('id', 'status', 'line_items', 'notes')
            : [];
          const termFeeRows = [...new Map(
            [...onVisitLockedRows, ...stampedFeeRowsNow].map((r) => [String(r.id), r]),
          ).values()];
          const liveFeeCentsOnVisit = termFeeRows
            .filter((r) => !terminalResolvedAway.includes(r.status) && r.status !== 'void')
            .reduce((sum, r) => sum + terminalFeeCents(r), 0);
          const refundedFeeCentsTerm = termFeeRows
            .filter((r) => String(r.status || '').toLowerCase() === 'refunded')
            .reduce((sum, r) => sum + terminalFeeCents(r), 0);
          const terminalFeeCovered = termExpectedFeeCents > 0
            && (liveFeeCentsOnVisit + refundedFeeCentsTerm) >= termExpectedFeeCents;
          const termFeeEstimateRef = unmintedSetupFeeObligation
            ? (unmintedSetupFeeObligation.estimateSlug || unmintedSetupFeeObligation.estimateId)
            : null;
          // The remainder subtracts BOTH live and refunded coverage
          // (Codex PR r20 P1) — refunded cents are never re-billed.
          const termFeeRemainder = Math.max(0, termExpectedFeeCents - liveFeeCentsOnVisit - refundedFeeCentsTerm);
          const effectiveSetupFeeNote = (!terminalSetupFeeNote || terminalFeeCovered)
            ? ''
            : ` ALSO: the one-time WaveGuard setup fee ($${(termFeeRemainder / 100).toFixed(2)}${(liveFeeCentsOnVisit + refundedFeeCentsTerm) > 0 ? ' remaining' : ''}) for accepted estimate ${termFeeEstimateRef} was never fully invoiced — bill the remainder using the EXACT line description "WaveGuard Membership — one-time setup fee" and include "accepted estimate #${unmintedSetupFeeObligation.estimateId}" in the invoice notes; do NOT re-bill covered amounts.`;
          // 3. The COMPLETE estimate/date sibling set, re-queried on this
          //    transaction under the sibling mint locks taken above (codex
          //    r13) and with its rows locked (lockRows → FOR UPDATE OF i),
          //    so the classification reads locked statuses, never a
          //    snapshot a concurrent refund/cancel/restore invalidates.
          let siblingLiveNow = null;
          if (!terminalRestored && !freshLiveOnVisit && svc.source_estimate_id) {
            const siblingNow = await findFirstApplicationInvoiceForEstimateService(svc, trx, { lockRows: true });
            const siblingCandidate = siblingNow.invoice && siblingNow.invoice.status === 'refunded'
              ? (siblingNow.liveBeside || null)
              : (siblingNow.invoice || null);
            siblingLiveNow = siblingCandidate && !terminalResolvedAway.includes(siblingCandidate.status)
              ? { id: siblingCandidate.id, invoice_number: siblingCandidate.invoice_number, status: siblingCandidate.status }
              : null;
          }
          const liveBesideNow = terminalRestored || freshLiveOnVisit || siblingLiveNow || null;
          const liveBesideLabel = liveBesideNow ? (liveBesideNow.invoice_number || liveBesideNow.id) : null;
          // Settled coverage requires the invoice to actually BILL the
          // application (Codex PR r13 P1): a fee-only paid invoice on the
          // visit must not resolve the refunded application's follow-up.
          let liveBesideFull = liveBesideNow;
          if (liveBesideNow && liveBesideNow.line_items === undefined) {
            liveBesideFull = await trx('invoices')
              .where({ id: liveBesideNow.id })
              .first('id', 'invoice_number', 'status', 'line_items', 'notes') || liveBesideNow;
          }
          const termExpectedAppCents = Math.round(Number(svc.estimated_price || 0) * 100);
          // Application coverage sums across EVERY live on-visit row plus
          // the chosen beside row (deduped) — one qualifying older paid
          // invoice settles the application even with unrelated newer
          // rows present (Codex PR r24 P1).
          const appCoverageRows = [...new Map(
            [...freshLiveRows, ...(liveBesideFull ? [liveBesideFull] : [])].map((r) => [String(r.id), r]),
          ).values()];
          const besideAppCents = appCoverageRows.reduce((sum, r) => sum + terminalAppCents(r), 0);
          const besideCoversApplication = termExpectedAppCents > 0
            ? besideAppCents >= termExpectedAppCents
            : appCoverageRows.some(terminalBillsApp);
          const covered = liveBesideNow && ['paid', 'prepaid'].includes(liveBesideNow.status)
            && besideCoversApplication;
          // Settled visit coverage does NOT settle a still-owed setup fee
          // (Codex P0, pre-push round 15): when the detector reported the
          // fee unminted, the alert stays ACTIVE carrying the fee-only
          // instruction — fall through to the body build below instead of
          // resolving away the fee's only follow-up.
          if (covered && !effectiveSetupFeeNote) {
            // Settled coverage: no NEW alert — and an already-parked one is
            // rewritten so its "bill/collect" instruction cannot cause a
            // duplicate collection (codex r11).
            logger.warn(`[dispatch] visit ${svc.id}: refunded invoice ${terminalCompletionInvoice.invoice_number || terminalCompletionInvoice.id} is covered by SETTLED invoice ${liveBesideLabel} (${liveBesideNow.status}) — manual-billing alert ${already ? 'rewritten as resolved' : 'skipped'}`);
            if (already) {
              await trx('notifications').where({ id: already.id }).update({
                body: `RESOLVED — no action needed: invoice ${liveBesideLabel} on this visit is ${liveBesideNow.status}. The earlier manual-billing instruction for refunded invoice ${terminalCompletionInvoice.invoice_number || terminalCompletionInvoice.id} no longer applies; do NOT bill or collect again.`,
                metadata: trx.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ liveBesideInvoiceId: liveBesideNow.id, resolvedCovered: true })]),
              });
            }
            return true;
          }
          const liveBesideNote = covered
            // Only reachable with effectiveSetupFeeNote set: the visit
            // charge is settled — never instruct another collection.
            ? ` Invoice ${liveBesideLabel} on this visit is ${liveBesideNow.status} — the visit charge is SETTLED; do NOT bill or collect it again.`
            : liveBesideNow
            ? (liveBesideNow.status === 'processing'
              ? ` A payment for invoice ${liveBesideLabel} on this visit is already PROCESSING — verify it settles; do NOT collect again or create another invoice.`
              : (terminalRestored
                ? ` Its refund did not stand — the invoice was reinstated to '${liveBesideNow.status}'; collect THAT invoice; do NOT create another.`
                : ` A live invoice (${liveBesideLabel}, status ${liveBesideNow.status}) already exists on this visit — once the refund is final, collect THAT invoice; do NOT create another.`))
            : (completionTerminalIncludedSetupFee
              ? ' That canceled invoice covered the ONE-TIME SETUP FEE as well as the visit — bill BOTH charges manually; an auto-mint here would have recreated only the visit charge.'
              : ' Once that refund is final, bill this visit manually (or reinstate the invoice if the refund bounced).');
          const alertBody = `A visit was completed but its invoice ${terminalCompletionInvoice.invoice_number || terminalCompletionInvoice.id} is ${terminalCompletionInvoice.status}, so NO new invoice was cut and the customer's completion text carried no pay link.${liveBesideNote}${effectiveSetupFeeNote}`;
          // A terminal alert carrying the fee note REGISTERS with the
          // setup-fee reconciler (Codex PR r13 P1): billing the requested
          // fee later must retire the fee clause even though this alert
          // is keyed per-visit, not per-estimate.
          const terminalSetupFeeMeta = effectiveSetupFeeNote
            ? {
              setupFeeDedupeKey: `unminted_setup_fee_manual_billing:${svc.source_estimate_id}`,
              sourceEstimateId: svc.source_estimate_id,
              expectedSetupFeeCents: termExpectedFeeCents,
            }
            : {};
          if (already) {
            // Keep the parked alert's advice CURRENT on every retry — the
            // situation may have changed since it was written (codex r11).
            await trx('notifications').where({ id: already.id }).update({
              body: alertBody,
              metadata: trx.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ ...terminalSetupFeeMeta, ...(liveBesideNow ? { liveBesideInvoiceId: liveBesideNow.id } : {}) })]),
            });
            return true;
          }
          const created = await require('../services/notification-service').notifyAdmin(
            'billing',
            `Completed visit needs manual billing — prior invoice was ${terminalCompletionInvoice.status}`,
            alertBody,
            { link: `/admin/customers/${svc.customer_id}`, bell: true, metadata: { scheduledServiceId: svc.id, serviceRecordId: record.id, terminalInvoiceId: terminalCompletionInvoice.id, ...terminalSetupFeeMeta, ...(liveBesideNow ? { liveBesideInvoiceId: liveBesideNow.id } : {}), customerId: svc.customer_id, dedupeKey }, connection: trx },
          );
          if (!created) throw new Error('manual-billing notification insert failed');
          return true;
        });
      } catch (e) {
        manualBillingAlertError = e;
      }
      if (!manualBillingAlerted) {
        const alertErr = manualBillingAlertError || new Error('manual-billing notification was not recorded');
        logger.error(`[dispatch] terminal-invoice manual-billing alert FAILED for ${svc.id} — closeout NOT finalized: ${alertErr.message}`);
        const released = await CompletionAttempts.releaseCompletionAttemptForResume(completionAttempt, alertErr);
        if (!released) {
          logger.error(`[dispatch] release-for-resume did NOT release attempt ${completionAttempt?.id} for ${svc.id} — retry blocked until the ${Math.ceil(CompletionAttempts.STALE_SIDE_EFFECTS_MS / 60000)}-minute stale window reclaims it`);
        }
        return ({ status: 503, body: {
          error: released
            ? 'This visit needs manual billing (its prior invoice was refunded) and the office alert could not be recorded — the closeout is saved but NOT finalized. Retry the closeout.'
            : `This visit needs manual billing (its prior invoice was refunded) and the office alert could not be recorded — the closeout is saved but NOT finalized. It will become retryable within about ${Math.ceil(CompletionAttempts.STALE_SIDE_EFFECTS_MS / 60000)} minutes — retry the closeout then.`,
          code: 'terminal_invoice_manual_billing_alert_failed',
          ...(released ? {} : { retryAfterMs: CompletionAttempts.STALE_SIDE_EFFECTS_MS }),
          serviceRecordId: record.id,
        } });
      }
    }
    // Unminted setup fee blocked the mint (owner ruling 2026-08-24): the
    // first visit ran and is owed money, but no acceptance invoice was
    // ever created (Mark Won accepts skip it by design) — minting the bare
    // per-application invoice here would silently drop the one-time setup
    // fee, so nothing was minted and this alert is the ONLY durable
    // follow-up for BOTH charges. Same fail-closed release/503 shape as
    // the terminal-invoice alert above; deciding-reason check ensures the
    // hold is the ONE reason invoicing was skipped (a visit the gate would
    // decline anyway owes no alert).
    // Two ways in (Codex PR r2 P1): the mint-hold path (nothing minted —
    // deciding-reason check keeps a visit the gate would decline anyway
    // from alerting), and the Charge Now path (a pre-completion invoice
    // already exists on the visit carrying only the application charge —
    // the completion reused it unheld above, and the alert's liveOnVisit
    // branch directs staff to collect it and bill the fee BESIDE it).
    // The Charge Now invoice appears as existingCompletionInvoice AND/OR
    // preMintedInvoice (same row, two lookups — Codex P0 rounds 4 and 7:
    // an invoice minted between the two reads shows only in the second),
    // so the beside-branch keys on EITHER; excluding preMintedInvoice
    // would suppress this branch for exactly the case it exists for.
    const setupFeeChargeNowBeside = !!(unmintedSetupFeeObligation
      && (existingCompletionInvoice || preMintedInvoice)
      && !terminalCompletionInvoice && !recapReviewOnly);
    // Out-of-band prepayment (cash/Zelle marked prepaid) covers the
    // APPLICATION amount only — the fee still needs its durable follow-up
    // (Codex PR r4 P1): without this branch, prepaidCovered suppressed
    // both the mint AND the alert and the $99 simply vanished.
    // Only the OUT-OF-BAND leg counts (Codex PR r10 P1): an annual
    // prepay that settled between the obligation read and here WAIVES the
    // fee — it must extinguish the alert, never become "application
    // covered, bill the fee".
    const setupFeePrepaidBeside = !!(unmintedSetupFeeObligation && prepaidCovered
      && !annualPrepayCovered
      && !terminalCompletionInvoice && !recapReviewOnly);
    if (setupFeeChargeNowBeside || setupFeePrepaidBeside
      || (unmintedSetupFeeObligation && !terminalCompletionInvoice && !shouldInvoice && !recapReviewOnly
        && !alreadyPaid && !prepaidCovered && !autopayCoversVisit && !preMintedInvoice && !existingCompletionInvoice
        && shouldAutoInvoiceCompletion({ ...completionInvoiceGateInput, unmintedSetupFeeHold: false }))) {
      const feeEstimateRef = unmintedSetupFeeObligation.estimateSlug || unmintedSetupFeeObligation.estimateId;
      logger.warn(`[dispatch] visit ${svc.id}: setup fee for estimate ${feeEstimateRef} was never invoiced — ${setupFeeChargeNowBeside ? 'a pre-completion invoice covers only the application charge' : 'NO invoice minted'}; manual billing alert parked`);
      let setupFeeAlerted = false;
      let setupFeeAlertError = null;
      try {
        const dedupeKey = `unminted_setup_fee_manual_billing:${unmintedSetupFeeObligation.estimateId}`;
        setupFeeAlerted = true === await db.transaction(async (trx) => {
          // Same lock discipline as the terminal-invoice alert above: the
          // shared schedule.invoice.mint advisory locks (own visit + its
          // estimate/date siblings, globally sorted) serialize this
          // revalidation against every concurrent invoice writer, then the
          // dedupe lock makes retries idempotent.
          const { acquireScheduledInvoiceMintLock } = require('../services/scheduled-invoice-mint');
          const { dateOnly } = require('../services/estimate-first-application-invoice');
          const alertSiblingServiceIds = await trx('scheduled_services')
            .where({ source_estimate_id: svc.source_estimate_id, customer_id: svc.customer_id })
            .where('scheduled_date', dateOnly(svc.scheduled_date))
            .pluck('id');
          const alertMintLockIds = Array.from(new Set([String(svc.id), ...alertSiblingServiceIds.map(String)])).sort();
          for (const lockId of alertMintLockIds) {
            await acquireScheduledInvoiceMintLock(trx, lockId);
          }
          await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [dedupeKey]);
          const already = await trx('notifications')
            .where({ recipient_type: 'admin' })
            .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey])
            .first('id', 'metadata');
          // Pre-lock check missed a concurrent park (narrow race): when
          // the standing alert belongs to a DIFFERENT visit, this visit's
          // application is also unbilled — never rewrite the body to a
          // singular instruction without saying so (Codex P0, round 8).
          const alreadyMeta = already && (typeof already.metadata === 'string'
            ? (() => { try { return JSON.parse(already.metadata); } catch { return null; } })()
            : already.metadata);
          const crossVisitNote = already && alreadyMeta?.scheduledServiceId
            && String(alreadyMeta.scheduledServiceId) !== String(svc.id)
            ? ' NOTE: MORE THAN ONE completed visit for this estimate is unbilled — verify EACH completed visit has its application charge billed, and bill the setup fee only ONCE.'
            : '';
          // ATOMIC revalidation on THIS transaction, under the mint locks:
          // 1. An acceptance invoice stamped for the estimate appeared
          //    (concurrent re-accept / manual mint). It resolves the alert
          //    ONLY if the application charge is also covered — a
          //    setup-ONLY acceptance invoice ("$99.00 setup fee only", a
          //    real converter output) carries no first-application line,
          //    and the hold above already suppressed the completion mint,
          //    so skipping the alert here would leave the performed
          //    application uninvoiced with no follow-up (Codex P0, round
          //    1). Coverage = a first-application line/notes marker on the
          //    stamped invoice, or a live invoice on the visit itself.
          // Annual-prepay race recheck under the locks (Codex PR r10
          // P1): a term whose payment settled after the obligation read
          // waives the fee — resolve/skip instead of instructing it.
          const AnnualPrepayReval = require('../services/annual-prepay-renewals');
          const coveredTermNow = await AnnualPrepayReval.coveredTermsAsOf(trx, null)
            .where('t.source_estimate_id', svc.source_estimate_id)
            .first('t.id');
          if (coveredTermNow) {
            logger.warn(`[dispatch] visit ${svc.id}: annual-prepay term now covers estimate ${feeEstimateRef} — setup-fee alert ${already ? 'rewritten as resolved' : 'skipped'} (fee waived by prepay)`);
            if (already) {
              await trx('notifications').where({ id: already.id }).update({
                body: `RESOLVED — no action needed: an annual-prepay term now covers estimate ${feeEstimateRef}; the setup fee is waived by that plan. The earlier manual-billing instruction no longer applies; do NOT bill.`,
                read_at: trx.fn.now(),
                metadata: trx.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ resolvedCovered: true })]),
              });
            }
            return true;
          }
          const stampedNowRows = await trx('invoices')
            .where({ customer_id: svc.customer_id })
            .where('notes', 'like', `%accepted estimate #${unmintedSetupFeeObligation.estimateId}%`)
            .forUpdate()
            .orderBy('created_at', 'desc')
            .select('id', 'invoice_number', 'status', 'notes', 'line_items', 'scheduled_service_id', 'service_record_id');
          const terminalResolvedAway = require('../services/invoice').CANCELLED_SERVICE_RESOLVED_STATUSES;
          // ALL live rows are retained (Codex P0, pre-push round 10):
          // split coverage — one invoice billing the fee, another the
          // application — must be seen across every live row, or the
          // alert instructs staff to re-bill a covered charge.
          const liveStampedRows = stampedNowRows.filter((r) => !terminalResolvedAway.includes(r.status) && r.status !== 'void');
          // 2. A live invoice minted onto the visit itself (Charge Now
          //    racing this alert) covers the VISIT charge only — the alert
          //    then directs the office to collect it and bill the setup fee
          //    beside it instead of duplicating the visit charge.
          const onVisitLockedRows = await trx('invoices')
            .where((qb) => {
              qb.orWhere({ service_record_id: record.id });
              qb.orWhere({ scheduled_service_id: svc.id });
            })
            .forUpdate()
            .orderBy('created_at', 'desc')
            .orderBy('id', 'desc')
            .select('id', 'invoice_number', 'status', 'line_items', 'notes');
          const liveOnVisitRows = onVisitLockedRows.filter((r) => !terminalResolvedAway.includes(r.status) && r.status !== 'void');
          const liveOnVisit = liveOnVisitRows[0] || null;
          // Coverage is judged per CHARGE, from the invoices' actual line
          // items (Codex P0, pre-push rounds 5–6 and 12): a stamped or
          // on-visit invoice counts toward the setup fee only when it
          // billed the fee, and toward the application only when a
          // POSITIVE parseable base line proves it
          // (invoiceBillsBaseApplication) — a "first application" phrase
          // in notes or on a zero/credited/unreadable line is provenance,
          // never charge coverage. Presence of some invoice proves
          // neither — a setup-only invoice must not resolve the
          // application, and a fee-carrying one must never be instructed
          // to bill the fee again.
          const {
            invoiceHasPositiveSetupFeeLine, invoiceBillsBaseApplication,
            sumPositiveSetupFeeCents, sumBaseApplicationCents,
          } = require('../services/estimate-first-application-invoice');
          // Expected FROZEN cents FIRST, coverage compared cents-exact
          // (Codex P0): a nominal partial line ($9.90 on a $99 fee) must
          // never suppress the only follow-up. Rows deduped by id — a
          // stamped invoice attached to this visit appears in both scans.
          const expectedSetupFeeCents = Math.round(Number(unmintedSetupFeeObligation.setupFee || 0) * 100);
          const expectedAppCentsThisVisit = Math.round(Number(
            (Number(mintInvoiceAmount) > 0 ? mintInvoiceAmount : svc.estimated_price) || 0,
          ) * 100);
          const currentVisitIsPrimary = !already || !alreadyMeta?.scheduledServiceId
            || String(alreadyMeta.scheduledServiceId) === String(svc.id);
          const uniqueLiveNow = [...new Map(
            [...liveStampedRows, ...liveOnVisitRows].map((r) => [String(r.id), r]),
          ).values()];
          const liveFeeCentsNow = uniqueLiveNow.reduce((sum, r) => sum + sumPositiveSetupFeeCents(r), 0);
          const feeCovered = expectedSetupFeeCents > 0 && liveFeeCentsNow >= expectedSetupFeeCents;
          const feeCoveredBy = feeCovered
            ? (liveStampedRows.find(invoiceHasPositiveSetupFeeLine)
              || liveOnVisitRows.find(invoiceHasPositiveSetupFeeLine) || uniqueLiveNow[0] || null)
            : null;
          // Only the durable base-application identity counts on every
          // row (Codex P0, round 18), and stamped first-application
          // coverage belongs to the alert's PRIMARY visit only (Codex PR
          // r3 P1) — an additional parked visit needs its own attached
          // invoice.
          const onVisitIdSet = new Set(liveOnVisitRows.map((r) => String(r.id)));
          // A stamped row ATTACHED to another visit counts THERE, never
          // toward this (primary) visit (Codex PR r19 P1) — only
          // unattached acceptance invoices provide the primary fallback.
          const appEligibleRows = uniqueLiveNow.filter((r) => onVisitIdSet.has(String(r.id))
            || (currentVisitIsPrimary && !r.scheduled_service_id && !r.service_record_id));
          const appCentsNow = appEligibleRows.reduce((sum, r) => sum + sumBaseApplicationCents(r), 0);
          const applicationCovered = expectedAppCentsThisVisit > 0
            ? appCentsNow >= expectedAppCentsThisVisit
            : appEligibleRows.some(invoiceBillsBaseApplication);
          const applicationCoveredBy = applicationCovered
            ? (liveOnVisitRows.find(invoiceBillsBaseApplication)
              || (currentVisitIsPrimary ? liveStampedRows.find(invoiceBillsBaseApplication) : null)
              || appEligibleRows[0] || null)
            : null;
          // Out-of-band prepayment proves the APPLICATION collected (the
          // amount was compared against the visit charge), never the fee.
          const applicationCoveredOutOfBand = setupFeePrepaidBeside;
          // Resolution may only speak for the WHOLE estate of parked
          // visits (Codex P0): with other visits persisted on the alert,
          // this transaction can prove only the CURRENT one — leave the
          // alert untouched and hand the full per-visit picture to the
          // shared reconciler after commit.
          const otherParkedIds = [...new Set([
            ...(Array.isArray(alreadyMeta?.parkedVisitIds) ? alreadyMeta.parkedVisitIds.map(String) : []),
            ...(alreadyMeta?.scheduledServiceId ? [String(alreadyMeta.scheduledServiceId)] : []),
          ])].filter((id) => id !== String(svc.id));
          if (feeCoveredBy && (applicationCoveredBy || applicationCoveredOutOfBand) && otherParkedIds.length) {
            setupFeeReconcileAfterCommit = true;
            return true;
          }
          if (feeCoveredBy && (applicationCoveredBy || applicationCoveredOutOfBand)) {
            const feeLabel2 = feeCoveredBy.invoice_number || feeCoveredBy.id;
            logger.warn(`[dispatch] visit ${svc.id}: the setup fee and the application charge for estimate ${feeEstimateRef} are both covered by live invoices — setup-fee alert ${already ? 'rewritten as resolved' : 'skipped'}`);
            if (already) {
              await trx('notifications').where({ id: already.id }).update({
                body: `RESOLVED — no action needed: live invoice ${feeLabel2} (${feeCoveredBy.status}) covers the setup fee and ${applicationCoveredBy ? `invoice ${applicationCoveredBy.invoice_number || applicationCoveredBy.id} (${applicationCoveredBy.status}) covers` : 'an out-of-band prepayment (marked prepaid) covered'} the application charge for estimate ${feeEstimateRef}. The earlier manual-billing instruction no longer applies; do NOT bill again.`,
                // No action left — never a false unread badge (Codex PR r9 P2).
                read_at: trx.fn.now(),
                metadata: trx.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ acceptanceInvoiceId: feeCoveredBy.id, resolvedCovered: true })]),
              });
            }
            return true;
          }
          // REMAINDERS, not the full charge (Codex PR r9 P1): with a
          // partial line already live ($9.90 of $99), instructing the
          // full amount would over-collect — the labels carry exactly
          // what is still owed.
          const feeRemainderCents = Math.max(0, expectedSetupFeeCents - liveFeeCentsNow);
          const appRemainderCents = expectedAppCentsThisVisit > 0
            ? Math.max(0, expectedAppCentsThisVisit - appCentsNow)
            : null;
          const setupFeeLabel = `$${(feeRemainderCents / 100).toFixed(2)}${liveFeeCentsNow > 0 ? ' remaining' : ''}`;
          const firstAppLabel = appRemainderCents !== null && appRemainderCents > 0
            ? ` ($${(appRemainderCents / 100).toFixed(2)}${appCentsNow > 0 ? ' remaining' : ''})`
            : (Number(mintInvoiceAmount) > 0 ? ` ($${Number(mintInvoiceAmount).toFixed(2)})` : '');
          // A dead acceptance invoice no suppressor can surface
          // (detector-reported) means "voided without replacement", not
          // "never minted" — say so.
          const deadInv = unmintedSetupFeeObligation.deadInvoice || null;
          const feeHistoryClause = deadInv
            ? `its WaveGuard setup-fee invoice (${deadInv.invoiceNumber || deadInv.id}, ${deadInv.status}) was voided/canceled and never replaced`
            : 'its WaveGuard setup fee was never invoiced (the accept skipped the acceptance invoice)';
          let alertBody;
          if (feeCoveredBy) {
            // The setup fee is billed (setup-only acceptance invoice) but
            // the performed application is not — the hold suppressed the
            // completion mint.
            const feeInvLabel = feeCoveredBy.invoice_number || feeCoveredBy.id;
            alertBody = `The first visit for accepted estimate ${feeEstimateRef} was completed. Its one-time setup fee is covered by invoice ${feeInvLabel} (${feeCoveredBy.status}), but NO invoice covers the performed application — bill the first application${firstAppLabel} manually using the EXACT line description "First service application" and "accepted estimate #${unmintedSetupFeeObligation.estimateId}" in the invoice notes (so the system recognizes it as billed); do NOT re-bill the setup fee.`;
          } else if (applicationCoveredBy) {
            // The application charge is billed (Charge Now invoice on the
            // visit, or an application-only acceptance invoice) but the
            // fee never was — collect that invoice, bill only the fee.
            const appInvLabel = applicationCoveredBy.invoice_number || applicationCoveredBy.id;
            alertBody = `The first visit for accepted estimate ${feeEstimateRef} was completed, but ${feeHistoryClause}. A live invoice (${appInvLabel}, status ${applicationCoveredBy.status}) covers the visit charge — collect THAT invoice, and bill the one-time setup fee (${setupFeeLabel}) beside it using the EXACT line description "WaveGuard Membership — one-time setup fee" and "accepted estimate #${unmintedSetupFeeObligation.estimateId}" in the invoice notes (so the system recognizes it as billed); do NOT duplicate the visit charge.`;
          } else if (applicationCoveredOutOfBand) {
            alertBody = `The first visit for accepted estimate ${feeEstimateRef} was completed and its visit charge was collected OUT OF BAND (marked prepaid — cash/Zelle/etc.), but ${feeHistoryClause}. Bill ONLY the one-time setup fee (${setupFeeLabel}) using the EXACT line description "WaveGuard Membership — one-time setup fee" and "accepted estimate #${unmintedSetupFeeObligation.estimateId}" in the invoice notes (so the system recognizes it as billed); do NOT bill the visit charge again.`;
          } else {
            alertBody = `The first visit for accepted estimate ${feeEstimateRef} was completed, but ${feeHistoryClause}, so NO invoice was cut and the customer's completion text carried no pay link. Bill BOTH charges manually: the one-time setup fee (${setupFeeLabel}) plus the first application${firstAppLabel}. Use the EXACT line description "First service application" for the application charge and "WaveGuard Membership — one-time setup fee" for the fee, AND include "accepted estimate #${unmintedSetupFeeObligation.estimateId}" in the invoice notes — that linkage is how the system recognizes the charges as billed and retires this alert.`;
          }
          if (already) {
            // resolvedCovered flips back to false: a re-park after a
            // resolved round means the obligation REOPENED (coverage
            // voided) — the alert must read active again or every later
            // lookup treats it as settled (Codex P0, pre-push round 9).
            // Every parked visit is PERSISTED in parkedVisitIds (Codex
            // P0, pre-push round 15): a cross-visit race suppressed this
            // visit's mint too, so reconciliation must require its
            // application billed before resolving — a note alone loses
            // ownership of the second unbilled application.
            const parkedVisitIds = [...new Set([
              ...(Array.isArray(alreadyMeta?.parkedVisitIds) ? alreadyMeta.parkedVisitIds.map(String) : []),
              ...(alreadyMeta?.scheduledServiceId ? [String(alreadyMeta.scheduledServiceId)] : []),
              String(svc.id),
            ])];
            const expectedApplicationCentsByVisit = {
              ...(alreadyMeta?.expectedApplicationCentsByVisit || {}),
              ...(expectedAppCentsThisVisit > 0 ? { [String(svc.id)]: expectedAppCentsThisVisit } : {}),
            };
            await trx('notifications').where({ id: already.id }).update({
              body: alertBody + crossVisitNote,
              // Newly actionable again — surface in the unread badge.
              read_at: null,
              metadata: trx.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ resolvedCovered: false, parkedVisitIds, expectedSetupFeeCents, expectedApplicationCentsByVisit, ...(liveOnVisit ? { liveBesideInvoiceId: liveOnVisit.id } : {}) })]),
            });
            return true;
          }
          const created = await require('../services/notification-service').notifyAdmin(
            'billing',
            'Completed first visit needs manual billing — setup fee was never invoiced',
            alertBody,
            { link: `/admin/customers/${svc.customer_id}`, bell: true, metadata: { scheduledServiceId: svc.id, serviceRecordId: record.id, sourceEstimateId: unmintedSetupFeeObligation.estimateId, expectedSetupFeeCents, ...(expectedAppCentsThisVisit > 0 ? { expectedApplicationCentsByVisit: { [String(svc.id)]: expectedAppCentsThisVisit } } : {}), ...(liveOnVisit ? { liveBesideInvoiceId: liveOnVisit.id } : {}), customerId: svc.customer_id, dedupeKey }, connection: trx },
          );
          if (!created) throw new Error('unminted-setup-fee notification insert failed');
          return true;
        });
      } catch (e) {
        setupFeeAlertError = e;
      }
      if (!setupFeeAlerted) {
        const alertErr = setupFeeAlertError || new Error('unminted-setup-fee notification was not recorded');
        logger.error(`[dispatch] unminted-setup-fee manual-billing alert FAILED for ${svc.id} — closeout NOT finalized: ${alertErr.message}`);
        const released = await CompletionAttempts.releaseCompletionAttemptForResume(completionAttempt, alertErr);
        if (!released) {
          logger.error(`[dispatch] release-for-resume did NOT release attempt ${completionAttempt?.id} for ${svc.id} — retry blocked until the ${Math.ceil(CompletionAttempts.STALE_SIDE_EFFECTS_MS / 60000)}-minute stale window reclaims it`);
        }
        return ({ status: 503, body: {
          error: released
            ? 'This visit needs manual billing (its setup fee was never invoiced) and the office alert could not be recorded — the closeout is saved but NOT finalized. Retry the closeout.'
            : `This visit needs manual billing (its setup fee was never invoiced) and the office alert could not be recorded — the closeout is saved but NOT finalized. It will become retryable within about ${Math.ceil(CompletionAttempts.STALE_SIDE_EFFECTS_MS / 60000)} minutes — retry the closeout then.`,
          code: 'unminted_setup_fee_alert_failed',
          ...(released ? {} : { retryAfterMs: CompletionAttempts.STALE_SIDE_EFFECTS_MS }),
          serviceRecordId: record.id,
        } });
      }
      if (setupFeeReconcileAfterCommit) {
        // Multi-visit resolution deferred from the alert transaction
        // (Codex P0): the shared reconciler proves EVERY parked visit
        // under its own locks. Best-effort — the daily sweep is the net.
        await require('../services/setup-fee-alert-reconcile')
          .reconcileSetupFeeAlert({
            customerId: svc.customer_id,
            sourceEstimateId: svc.source_estimate_id,
            actorLabel: ` visit ${svc.id} post-commit:`,
          })
          .catch((err) => logger.error(`[dispatch] post-commit setup-fee reconcile failed for ${svc.id}: ${err.message}`));
      }
    }
    // Membership dues suppressed a PRICED recurring visit: log + park a
    // one-bell-per-series review alert. Emitted only here — after the
    // invoice checks — so an already-paid / pre-minted / existing invoice
    // (Charge Now / Tap-to-Pay) can neither trigger a false "no invoice was
    // cut → bill manually" instruction (duplicate-charge vector) nor burn
    // the series' dedupe key (Codex r2). With those states excluded,
    // membership coverage IS the deciding reason invoicing was skipped.
    // Cadence children inherit the booking modal's create_invoice_on_complete
    // via createInvoiceEffective (admin-schedule.js), so neither the stamped
    // price nor the flag is per-visit operator intent — but a genuinely
    // billable recurring add-on must not vanish silently; the alert copy
    // tells the office to KEEP the series' price (clearing it would make
    // future occurrences complete silently with no alert — Codex r2).
    if (!shouldInvoice && autopayCoversVisit && hasVisitPrice && !recapReviewOnly
      && !alreadyPaid && !prepaidCovered && !preMintedInvoice && !existingCompletionInvoice) {
      logger.info(`[dispatch] visit ${svc.id}: monthly membership dues cover this recurring visit — stamped estimated_price $${Number(svc.estimated_price).toFixed(2)} NOT invoiced`);
      try {
        const dedupeKey = `dues_covered_priced_series:${svc.recurring_parent_id || svc.id}`;
        await db.transaction(async (trx) => {
          // Transaction-scoped advisory lock serializes concurrent
          // completions of the same series so the check-then-insert can't
          // double-bell (Codex r3).
          await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [dedupeKey]);
          const already = await trx('notifications')
            .where({ recipient_type: 'admin' })
            .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey])
            .first();
          if (already) return;
          await require('../services/notification-service').notifyAdmin(
            'billing',
            'Visit covered by membership dues — stamped price not billed',
            `A completed recurring visit for a monthly-membership customer carried a $${Number(svc.estimated_price).toFixed(2)} per-visit price${svc.create_invoice_on_complete ? " and the series' create-invoice default" : ''}. Membership dues cover plan visits, so NO invoice was cut. If this series is actually a separately billable add-on, bill this visit manually and KEEP its per-visit price — every visit in the series will complete uninvoiced the same way, so bill each manually or roll the add-on into the customer's monthly rate.`,
            // bell: false — billing FYI, not a money failure; silenced under
            // GATE_ADMIN_BELL_POLICY even though category 'billing' rings.
            { link: `/admin/customers/${svc.customer_id}`, bell: false, metadata: { scheduledServiceId: svc.id, customerId: svc.customer_id, dedupeKey }, connection: trx },
          );
        });
      } catch (e) { logger.warn(`[dispatch] dues-covered review alert failed: ${e.message}`); }
    }
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
    // Backfill (re-derived from the structured_notes freeze above, before the
    // invoice decision) re-forces quiet AFTER the frozen-delivery
    // re-derivation — an auto_send posture must not un-suppress a backdated
    // closeout.
    if (isBackfillCompletion) {
      suppressTypedCustomerComms = true;
      effectiveSendCompletionSms = false;
    }
    if (resumingCommittedCompletion && shouldRejectPhotoCaptionBannedCopy({
      captionBannedViolations,
      isInternalOnlyCompletion,
      resumingCommittedCompletion,
      typedDeliveryMode,
    })) {
      return ({ status: 422, body: photoCaptionBannedCopyPayload(captionBannedViolations) });
    }
    // Warm the cross-sell card's property-evidence cache (owner lane
    // 2026-08-13). Placed AFTER the frozen-delivery re-derivation above
    // (pre-push r6 P1: on a crash-resumed completion the live profile can
    // disagree with the record's frozen typedReportDelivery in either
    // direction — spending on a frozen internal-only report, or skipping
    // the warm for a frozen auto-send one) and BEFORE any customer
    // artifact is minted. Bounded wait, the T&S auto-scorer's pattern: on
    // timeout the warm finishes in the background and the next view
    // self-heals; a cold first view is exactly today's CTA behavior.
    // 'disabled' (no public token is ever minted) and 'internal_only'
    // (staff-review shadow) reports can't reach a customer — no spend.
    // crossSellWarm is retained for the post-maintenance re-warm below,
    // which must chain on it rather than race its in-flight lookup.
    let crossSellWarm = null;
    if (useServiceReportV1 && !isIncompleteVisit && !isBackfillCompletion && record?.id
      && !['disabled', 'internal_only'].includes(typedDeliveryMode)) {
      const { prewarmReportCrossSellEvidenceBounded } = require('../services/service-report/evidence-prewarm');
      const bounded = prewarmReportCrossSellEvidenceBounded(record, db, { maxWaitMs: 10000 });
      crossSellWarm = bounded.warm;
      await bounded.outcome;
    }
    const portalUrl = publicPortalUrl();
    let reportUrl = portalUrl;
    let reportToken = null;
    // Retained for the withhold branch ahead of the SMS lane: the bell for a
    // failed mint fires THERE (where the completion text is actually
    // withheld), not here — a mint failure on a visit that was never going to
    // text (internal-only, no phone, already handled) is a log line, not a
    // "text withheld" bell (GitHub Codex r1 P1).
    let reportTokenMintError = null;
    const serviceReportV1Delivery = shouldSendServiceReportV1Delivery(record);
    // delivery_mode 'disabled' (typed kill switch) suppresses the customer
    // report entirely — don't mint a public token at all (Codex P2). The
    // record still exists; flipping the mode back later can mint on demand.
    if (typedDeliveryMode !== 'disabled') {
      try {
        const { ensureReportToken } = require('../routes/reports-public');
        reportToken = await ensureReportToken(record.id);
        if (reportToken) reportUrl = `${portalUrl}/report/${reportToken}`;
      } catch (err) {
        // Post-commit: the visit still completes. A report-v1 visit's
        // completion text is WITHHELD below (completionSmsWithheldForMissing-
        // ReportToken) so the customer is not told "your report is ready"
        // with a link to the portal home; that branch raises the bell.
        reportTokenMintError = err;
        logger.error(`[dispatch] service report token mint failed: ${err.message}`);
      }
    }
    // Auto-publish tech-captured visual moments to the customer report
    // (owner 2026-08-27, dark ship — kill switch GATE_AUTO_PUBLISH_VISUAL_MOMENTS).
    // Runs BEFORE the PDF enqueue below so the rendered artifact carries
    // the promoted moments, and independent of the email branch (codex P1
    // ×2 on this branch). Each moment is screened INDIVIDUALLY: the caption
    // that will render (customer_caption, falling back to ai_caption) must
    // be non-empty and pass the same banned-copy + access-code guards as
    // every other customer copy path — violators stay internal_only for
    // the existing admin review flow. Fail-soft: errors never block the
    // completion. Also invalidates the visual-moment PDF cache, matching
    // the admin visibility endpoint's contract. Publishes ONLY on a
    // customer-delivered completion: typed internal_only/disabled modes
    // keep their admin-review/suppression contract and quiet backfills send
    // nothing (codex P1 r2) — isInternalOnlyCompletion alone only covers
    // untyped consultations.
    if (!isInternalOnlyCompletion && !isIncompleteVisit && !isBackfillCompletion
      && typedDeliveryMode === 'auto_send') {
      try {
        const { gateEnvValue } = require('../config/feature-gates');
        if (gateEnvValue('GATE_AUTO_PUBLISH_VISUAL_MOMENTS')) {
          const { customerCopyViolations, containsReportAccessCode } = require('../services/service-report/technician-report-copy');
          const candidates = await db('visual_service_moments')
            .where({ job_id: svc.id, visibility_status: 'internal_only' })
            .whereNull('deleted_at')
            .select('id', 'customer_caption', 'ai_caption', 'tag_group', 'media_storage_key', 'note');
          // Provenance rules (codex P1 r4): never auto-publish moments whose
          // customer copy could derive from the raw technician note — the
          // 'recommendation' tag's template embeds the note verbatim — nor
          // the 'access' group (entry points / access issues carry the exact
          // details the access-code screen exists to keep off reports).
          // Only moments WITH media publish (a note-only moment is an
          // internal visual note), and only on an explicit customer_caption
          // or media-derived ai_caption — the note-templated fallback caption
          // never qualifies. Media content itself is not machine-screenable;
          // flipping the gate is the owner's acceptance of that.
          const AUTO_PUBLISH_EXCLUDED_TAG_GROUPS = new Set(['recommendation', 'access']);
          const publishable = candidates.filter((m) => {
            if (AUTO_PUBLISH_EXCLUDED_TAG_GROUPS.has(String(m.tag_group || ''))) return false;
            // Storage key REQUIRED: the report loader signs media from
            // media_storage_key only, so a legacy URL-only row would publish
            // as a caption-only card (codex inline r7).
            if (!m.media_storage_key) return false;
            const caption = String(m.customer_caption || m.ai_caption || '').trim();
            if (!caption || customerCopyViolations(caption).length) return false;
            // The tech's raw note is never published, but it is the best
            // available signal for what the MEDIA shows: a note that carries
            // an access code (gate/lockbox/keypad) almost certainly describes
            // a photo of one — hold that moment internal (uncapped codex P1
            // r11). Media content itself is not machine-screenable here; the
            // gate flip is the owner's acceptance of that residual risk.
            if (containsReportAccessCode(String(m.note || ''))) return false;
            return true;
          });
          let promoted = 0;
          let promotionError = null;
          for (const m of publishable) {
            // Conditional on the EXACT screened state (codex P1 r3): a
            // concurrent admin rejection, deletion, or caption edit between
            // the screen and this write leaves the row untouched — only a
            // row still internal_only, undeleted, with the captions the
            // screen approved is promoted.
            try {
              promoted += await db('visual_service_moments')
                .where({ id: m.id, job_id: svc.id, visibility_status: 'internal_only' })
                .whereNull('deleted_at')
                .whereRaw('customer_caption IS NOT DISTINCT FROM ?', [m.customer_caption ?? null])
                .whereRaw('ai_caption IS NOT DISTINCT FROM ?', [m.ai_caption ?? null])
                // EVERY screened field is frozen — tag group, note, and
                // storage key too — so a concurrent edit that adds an access
                // code to the note (or swaps the media) after the screen
                // leaves the row internal (uncapped codex P1 r12).
                .whereRaw('tag_group IS NOT DISTINCT FROM ?', [m.tag_group ?? null])
                .whereRaw('note IS NOT DISTINCT FROM ?', [m.note ?? null])
                .whereRaw('media_storage_key IS NOT DISTINCT FROM ?', [m.media_storage_key ?? null])
                .update({
                  visibility_status: 'approved_customer',
                  customer_caption: db.raw('COALESCE(customer_caption, ai_caption)'),
                  updated_at: db.fn.now(),
                });
            } catch (rowErr) {
              // A later row failing must not skip cache invalidation for
              // the rows already promoted (uncapped codex P1 r8).
              promotionError = rowErr;
              break;
            }
          }
          if (promoted) {
            const { invalidateVisualMomentReportPdfCache } = require('../services/visual-service-notes');
            await invalidateVisualMomentReportPdfCache(svc.id).catch(() => {});
            logger.info(`[dispatch] auto-published ${promoted}/${candidates.length} visual moment(s) for ${svc.id}`);
          }
          if (promotionError) throw promotionError;
          if (!promoted && candidates.length) {
            logger.info(`[dispatch] visual moments held internal_only for ${svc.id}: ${candidates.length} failed the caption screen`);
          }
        }
      } catch (vmErr) {
        logger.warn(`[dispatch] visual-moment auto-publish failed (non-blocking): ${vmErr.message}`);
      }
    }
    // Only auto_send completions queue a PDF render. 'disabled' is the typed
    // kill switch; 'internal_only' (Phase-1b shadow) can't render either —
    // the headless renderer opens /report/:token?mode=pdf without a staff
    // JWT, and the public report routes 404 suppressed reports for
    // non-staff. Staff review the shadow via the HTML report; the PDF only
    // feeds customer sends, which are suppressed anyway.
    if (serviceReportV1Delivery && reportToken && typedDeliveryMode === 'auto_send'
      && !(lawnPdfCorrectionNeeded && !lawnPdfCorrectionMarked)) {
      await enqueuePdfRenderJob({
        serviceRecordId: record.id,
        payload: {
          source: 'dispatch_complete',
          token: reportToken,
        },
      }).catch((err) => {
        logger.warn(`[dispatch] service report PDF render queue failed for ${record.id}: ${err.message}`);
      });
      // A grounded-recommendation regen that outlived its bounded wait still
      // writes when it lands — re-render the PDF then, so the queued artifact
      // doesn't permanently carry the stale confirm-time copy (codex P1 r8).
      if (lawnRecRegenAttempted && !lawnRecRegenGrounded && lawnRecFinalCopyPromise) {
        // Deliberately detached recovery chain — explicit void + logged
        // catch per repo detachment style (codex P1 r19).
        void lawnRecFinalCopyPromise.then(async (finalCopy) => {
          // Recovery render for EVERY not-grounded-at-wait outcome (fast
          // fail, late grounded, late fail — codex P1 r14+r18): the
          // finalCopy chain has already run the grounded write or the
          // retrying sanitize. Unverified (sanitize kept erroring) → no
          // re-render; render-time guards protect the web report and the
          // held email stays gated by the worker. Verified with no change →
          // nothing to correct.
          if (!finalCopy?.verified || !finalCopy?.changed) {
            if (finalCopy && !finalCopy.verified) {
              logger.warn(`[dispatch] recovery render skipped for ${record.id} — final copy unverified`);
            }
            return;
          }
          try {
            // Copy changed after the first render may have stored a stale
            // PDF — clear the storage key so the next render is forced
            // fresh instead of served from the object match (codex P1 r18).
            await db('service_records').where({ id: record.id })
              .update({ pdf_storage_key: null })
              .catch((invErr) => logger.warn(`[dispatch] pdf key invalidation failed for ${record.id}: ${invErr.message}`));
            // enqueuePdfRenderJob dedupes against an ACTIVE job — a render
            // already in flight may have loaded pre-write data, so a deduped
            // 'rendering' result is NOT the correction; retry until the
            // active job settles and a fresh render actually queues (codex
            // P1 r11). A deduped 'queued' job hasn't started yet and will
            // read post-write data — that IS the correction.
            for (let attempt = 0; attempt < 12; attempt += 1) {
              const res = await enqueuePdfRenderJob({
                serviceRecordId: record.id,
                payload: { source: 'grounded_regen_late', token: reportToken },
              });
              if (res.queued || res.job?.status === 'queued') {
                logger.info(`[dispatch] PDF re-queued for ${record.id} after late grounded recommendation write (attempt ${attempt + 1})`);
                return;
              }
              await new Promise((resolve) => { setTimeout(resolve, 15000).unref?.(); });
            }
            logger.warn(`[dispatch] late PDF re-queue gave up for ${record.id} — active render never settled`);
          } catch (requeueErr) {
            logger.warn(`[dispatch] late PDF re-queue failed for ${record.id}: ${requeueErr.message}`);
          }
        }).catch((recoveryErr) => logger.error(`[dispatch] PDF recovery chain failed for ${record.id}: ${recoveryErr.message}`));
      }
    }
    // Best-effort: queue the "Your Visit, in Motion" recap render for pest visits
    // (flag-gated via PEST_RECAP). The pipeline self-skips non-eligible visits and a
    // failure here never blocks completion; the tech approves before it ever sends.
    // Backfill closeouts skip the enqueue entirely: the pending row is inert on
    // its own, but it feeds the success overlay's "Approve & send" card — an
    // operator-reachable "today's visit" text days after the fact — so this
    // rail is gated like the other customer-contact rails. Recap delivery also
    // refuses the structured_notes.backfill marker as defense in depth.
    if (process.env.PEST_RECAP === 'true' && typedDeliveryMode === 'auto_send' && String(record.service_line || '').toLowerCase() === 'pest' && record.scheduled_service_id) {
      if (isBackfillCompletion) {
        logger.info(`[dispatch] backfill completion: pest recap render NOT enqueued for visit ${svc.id} — quiet closeout, nothing to approve or send`);
      } else {
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
        completionInput.actor,
        'service_report_mms_preview_v1',
        'SERVICE_REPORT_MMS_PREVIEW_ENABLED',
        false,
      );
      // A grounded-recommendation regen still pending past its bounded wait
      // means this preview could bake the stale confirm-time copy into an
      // image TEXTED to the customer — unrecallable, unlike the PDF (which
      // re-queues) and the web report (which heals). Omit the image on that
      // rare path; the SMS still links to the live report (codex P1 r10).
      if (mmsPreviewEnabled && reportToken && lawnRecRegenAttempted && !lawnRecRegenGrounded) {
        logger.warn(`[dispatch] MMS preview omitted for ${record.id} — grounded recommendation regen ${lawnRecRegenTimedOut ? 'still pending' : 'failed'}; SMS sends without an image`);
      } else if (mmsPreviewEnabled && reportToken) {
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
      // Backfill closeouts leave the completion invoice EXACTLY as minted for
      // office review (Codex P1, fix round): applying the out-of-band
      // prepayment here reduces the total, inserts a payments row, and can
      // flip the invoice paid — invoice mutation the quiet path promises not
      // to make, even for money the operator already collected. The operator
      // applies the recorded prepayment while reviewing the open invoice.
      if (isBackfillCompletion) {
        logger.info(`[dispatch] backfill completion: prepaid credit NOT auto-applied for visit ${svc.id} — invoice ${invoiceRow.invoice_number || invoiceRow.id} left open for review (prepaid_amount $${Number(svc.prepaid_amount).toFixed(2)}${svc.prepaid_method ? ` via ${svc.prepaid_method}` : ''} on file)`);
        return invoiceRow;
      }
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

      let flippedPaidByPrepayment = false;
      const creditedResult = await db.transaction(async (trx) => {
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
        flippedPaidByPrepayment = paidByPrepayment;
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
        if (paidByPrepayment) {
          // The recorded prepayment fully settled the invoice — complete any
          // active payment plan on the SAME trx (codex r5 P1; mirrors the
          // admin-schedule prepaid-at-visit path).
          await require('../services/payment-plans').completeActivePlansForInvoice(lockedInvoice.id, trx);
        }
        return creditedInvoice;
      });
      // A cash/Zelle prepayment that fully covers the invoice flips it paid
      // with NO Stripe webhook behind it, so the annual-prepay payment sync
      // (pending-term activation + the pending-window slice resolution the
      // reconcile left "until the invoice resolves") would never run.
      // Mirror the prepaid-receipt path (admin-schedule): best-effort — the
      // daily covered-term sweep is the recovery net.
      if (flippedPaidByPrepayment && creditedResult?.id) {
        try {
          await AnnualPrepayRenewals.syncTermForInvoicePayment(creditedResult);
        } catch (err) {
          logger.warn(`[dispatch] annual-prepay sync after prepaid credit failed for invoice ${creditedResult.id}: ${err.message}`);
        }
      }
      return creditedResult;
    };

    // Secure plan-choice setup fee (owner decision 2026-07-24): a
    // per-application selection on a solo pest/mosquito series stamped
    // pending_setup_fee on the series parent — the FIRST live completion
    // mint carries it as its own line so the office never bills it
    // manually. The claim is DURABLE across crashes (Codex #2980 r2):
    // claiming flips the stamp NEGATIVE (in-progress marker) instead of
    // clearing it; a successful mint clears it, an in-process failure
    // restores it positive, and a worker that dies mid-window leaves the
    // negative stamp for the recovery branch below — which checks whether
    // the minted setup line actually exists on a series invoice and either
    // heals (billed: clear, no second line) or re-adopts the claim (not
    // billed: mint it now). Exact-value CAS (+ an updated_at lease guard on
    // adoption) collapses concurrent completions to one fee. Never under
    // backfill (frozen-money posture) and never for callbacks.
    let secureSetupFee = null;
    if (shouldInvoice && !isBackfillCompletion && !svc.is_callback) {
      try {
        const setupParentId = svc.recurring_parent_id || svc.id;
        const parentRow = await db('scheduled_services')
          .where({ id: setupParentId })
          .first('pending_setup_fee', 'updated_at');
        const rawFee = parentRow?.pending_setup_fee != null ? Number(parentRow.pending_setup_fee) : null;
        if (rawFee) {
          const amount = Math.round(Math.abs(rawFee) * 100) / 100;
          if (rawFee < 0) {
            // Orphaned claim from a dead worker. The durable truth is the
            // invoice itself: does any non-void series invoice already
            // carry the setup line?
            const lineExists = await db('invoices')
              .whereIn('scheduled_service_id', db('scheduled_services').select('id').where(function series() {
                this.where({ id: setupParentId }).orWhere({ recurring_parent_id: setupParentId });
              }))
              // Only COLLECTIBLE-or-settled invoices prove the fee is
              // billed (Codex #2980 r3): a voided/cancelled/refunded
              // invoice collects nothing, so treating it as proof would
              // clear the claim and the customer permanently skips the
              // selected fee.
              .whereNotIn('status', ['void', 'cancelled', 'canceled', 'refunded'])
              .whereRaw('line_items::text ILIKE ?', ['%one-time setup fee%'])
              .first('id');
            if (lineExists) {
              // Backfill the immutable claim record before healing: a
              // worker that died between the mint commit and the record
              // insert left the invoice recordless, and healing without
              // one would strand the resumed Auto Pay in manual review
              // (Codex #3503). The clearing claim's own amount is the
              // server-side truth.
              try {
                await db('setup_fee_claims')
                  .insert({
                    invoice_id: lineExists.id,
                    scheduled_service_id: setupParentId,
                    amount,
                  })
                  .onConflict('invoice_id')
                  .ignore();
              } catch (recErr) {
                logger.warn(`[dispatch] setup-fee claim record backfill failed for invoice ${lineExists.id} (resume stays manual-review): ${recErr.message}`);
              }
              await db('scheduled_services')
                .where({ id: setupParentId, pending_setup_fee: parentRow.pending_setup_fee })
                .update({ pending_setup_fee: null, updated_at: new Date() });
              logger.info(`[dispatch] orphaned setup-fee claim healed for series ${setupParentId} — fee already on invoice ${lineExists.id}`);
            } else {
              const adopted = await db('scheduled_services')
                .where({ id: setupParentId, pending_setup_fee: parentRow.pending_setup_fee, updated_at: parentRow.updated_at })
                .update({ updated_at: new Date() });
              if (adopted === 1) {
                secureSetupFee = { parentId: setupParentId, amount };
                logger.warn(`[dispatch] orphaned setup-fee claim ADOPTED for series ${setupParentId} ($${amount}) — minting on visit ${svc.id}`);
              }
            }
          } else {
            const claimed = await db('scheduled_services')
              .where({ id: setupParentId, pending_setup_fee: parentRow.pending_setup_fee })
              .update({ pending_setup_fee: -amount, updated_at: new Date() });
            if (claimed === 1) {
              secureSetupFee = { parentId: setupParentId, amount };
              logger.info(`[dispatch] setup-fee claim consumed for series ${setupParentId} ($${amount}) — minting on visit ${svc.id}`);
            }
          }
        }
      } catch (e) {
        // Unreadable stamp mints the plain visit invoice — the fee stays
        // stamped for the next completion rather than risking a double line.
        logger.warn(`[dispatch] setup-fee claim failed for visit ${svc.id}: ${e.message}`);
      }
    }
    if (shouldInvoice) {
      try {
        // A REQUIRED resume mints the FROZEN amount or nothing (Codex P0,
        // fix round 10): reaching here without it (a record committed
        // before the money freeze existed, or corrupt notes) means the only
        // available number is a live recomputation from mutable billing
        // state — refuse, and take the fail-closed release/503 path in the
        // catch below rather than finalize with the wrong money.
        if (backfillReviewMintRequired && resumingCommittedCompletion
          && backfillFrozenMintAmount == null) {
          throw new Error('required backfill mint amount missing from the frozen structured_notes — refusing to mint a recomputed amount');
        }
        const InvoiceService = require('../services/invoice');
        // LIVE typed one-time REQUIRED mint (the population the removed
        // pre-gate covered): inherit the gate's fail-closed verification —
        // a failed suppressor lookup means an invoice may exist unseen, and
        // minting anyway could collect twice. Refuse; the release/503 catch
        // makes the closeout retryable and the retry re-runs the lookups.
        const typedLiveRequiredMint = backfillReviewMintRequired && !isBackfillCompletion;
        if (typedLiveRequiredMint && invoiceLookupFailed) {
          throw new Error('existing-invoice lookups failed — refusing to mint a possible duplicate invoice for this one-time completion');
        }
        // EVERY estimate-linked lane fails closed on a failed lookup before
        // minting (codex hardening P0): the sibling first-application lookup
        // is what detects a canceled ACCEPTANCE invoice that carried the
        // one-time setup fee — if it errored, minting here would recreate
        // only the visit charge and permanently drop the fee (and could
        // duplicate an unseen suppressor invoice). The throw lands in the
        // same release-for-resume/503 catch as the typed lane; the retry
        // re-runs the lookups.
        if (invoiceLookupFailed && svc.source_estimate_id) {
          throw new Error('existing-invoice lookups failed — refusing to mint for an estimate-linked visit whose sibling/setup-fee suppressors could not be verified');
        }
        // Resolved here — inside the mint try — so a derivation failure
        // follows the lane's own failure posture (r5/r6): required lanes
        // release for resume, non-required lanes stay non-blocking.
        // REQUIRED lanes only (r11 P0): a non-required mint passes NO
        // explicit rate — the early derivation is bound to
        // completionResolvedPayer, and a Bill-To change before create()'s
        // own definitive resolution would marry the stale rate (e.g. an
        // exempt self-pay 0%) to the new payer's invoice. create() derives
        // tax AFTER its payer resolution instead, atomically.
        const mintInvoiceTaxRate = backfillReviewMintRequired
          ? await resolveMintInvoiceTaxRate()
          : undefined;
        const mintOptions = {
          // The frozen money on a required resume — the exact number the
          // decision's amount guard just passed (mintInvoiceAmount /
          // mintInvoiceTaxRate are one derivation, fix round 10).
          amount: mintInvoiceAmount,
          description: svc.service_type,
          taxRate: mintInvoiceTaxRate,
          // Frozen money authority — REQUIRED lanes only (r6 P0): an
          // ordinary live lane has no frozen retry posture, so a
          // FROZEN_PAYER_DIVERGED there would be swallowed by the
          // non-blocking catch and finalize the closeout invoice-less
          // (lost AR). Non-required mints let create() re-resolve the
          // payer and apply its own exemption semantics to the fresh rate.
          frozenPayerId: backfillReviewMintRequired ? mintInvoicePayerId : undefined,
          frozenTaxAuthority: backfillReviewMintRequired,
          // Frozen-money mints bypass scheduled replay (Codex P0, fix round
          // 11): with the flag on, createFromService REBUILDS the line items
          // from the CURRENT scheduled-service row + add-ons + stored line
          // discounts (buildScheduledServiceInvoiceLines) and the amount
          // param degrades to a fallback — so a post-commit price/add-on/
          // discount edit changed the minted total despite the round-10
          // freeze, and even the FIRST run could mint a replay total (gross
          // − stored discounts) different from the cents it had just frozen,
          // leaving a resume to re-mint a different number than run one.
          // Every backfill mint is a REQUIRED mint (the round-9 posture
          // governs every branch: posture false never reaches this block),
          // so under backfill the mint is a single line at the frozen
          // amount, BOTH first run and resume — one code path, no
          // first-run-vs-resume divergence; subtotal ≡ the frozen cents and
          // total ≡ cents + tax at the frozen rate by construction (no
          // discount inputs, deposit credit + accrual skipped below;
          // create()'s residential-never-taxed policy can only ever zero
          // the tax, never move the subtotal). The single line keeps the
          // reviewer-facing label (service type); line-level fidelity is
          // deliberately traded for provable money — the reviewer edits or
          // void+re-creates for itemization. Live FIRST-RUN completions
          // keep replay; a live REQUIRED resume (typed one-time, frozen
          // posture) mints the frozen single line for the same
          // provable-money reason — replay would rebuild from the
          // by-then-mutable row and drift from the frozen cents.
          useScheduledReplay: !isBackfillCompletion
            && !(backfillReviewMintRequired && resumingCommittedCompletion),
          // Live replay mints prove the row price hasn't moved since this
          // completion derived its amount (codex #3344 r2) — a WaveGuard
          // reprice landing mid-completion 409s and the retry bills fresh
          // (for the required lane, via the release catch restamping the
          // frozen cents from the 409's locked price — codex r5 P1).
          // Frozen-money lanes bypass replay entirely and keep their
          // provable frozen figure.
          scheduledPriceBasis: svc.estimated_price,
          // Backfill: record.service_date is the backdated visit day — using
          // it here would mint the invoice instantly overdue and light up the
          // dunning/overdue surfaces for a quiet backlog closeout. Due today
          // instead: the exact net terms a normal same-day completion gets.
          dueDate: isBackfillCompletion ? etDateString() : serviceDateOnly(record.service_date),
          // Claimed plan-choice setup fee rides the SAME mint (one invoice,
          // one auto-charge) — the claim above is the idempotency authority.
          extraLineItems: secureSetupFee
            ? [{
              description: 'One-time setup fee',
              quantity: 1,
              unit_price: secureSetupFee.amount,
              amount: secureSetupFee.amount,
              category: 'Setup fee',
              // Durable single-use auto-charge marker (see allowance block).
              secure_claim: true,
            }]
            : undefined,
          // Backfill: createFromService otherwise rolls an accepted
          // estimate's unapplied deposit forward into this invoice
          // (consumeDepositCredit + a credit line that reduces or zeroes the
          // total) — deposit-ledger movement and invoice mutation the quiet
          // path leaves to the reviewer, exactly like the prepaid/account-
          // credit/auto-charge rails gated off below (Codex P1, PR #2897
          // fix round). The invoice mints at face value; the deposit stays
          // on the estimate's ledger for the reviewer to apply.
          skipDepositCredit: isBackfillCompletion,
          // Statement accrual is a billing side effect too (Codex P1, PR
          // #2897 fix round 5): for a payer-billed NET15/NET30 visit under
          // GATE_PAYER_STATEMENTS, create() otherwise attaches this invoice
          // to the payer's OPEN monthly statement and recomputes the
          // statement total — landing the quiet review-only closeout on a
          // consolidated bill before anyone has looked at it. Mint it
          // UNATTACHED instead (still payer-billed: payer_id / PO /
          // snapshot all stamp normally, so it stays individually sendable);
          // where it bills is the reviewer's call (breadcrumb below).
          skipAccrual: isBackfillCompletion,
        };
        // Serialized find-or-create for the live typed mint (pre-push Codex
        // P0, gate-removal rounds 2-4): invoices.scheduled_service_id is
        // NOT unique, and the pre-completion writers (office Charge Now
        // pre-mint, checkout tender sheets) can race this mint — two
        // collectible invoices for one visit could collect twice. Mint
        // through the ONE transaction-aware helper every scheduled-service
        // invoice writer shares (services/scheduled-invoice-mint): the
        // shared two-key ['schedule.invoice.mint', svc.id] advisory lock
        // serializes the writers, the in-lock replay re-check adopts any
        // invoice that landed after the suppressor lookups ran (reused:
        // true), create() runs on the lock transaction's own connection so
        // no second pooled connection is held while the lock is, and the
        // estimate-deposit roll-forward keeps its hardened retry/fallback
        // discipline. Replay line items are built BEFORE the lock
        // (read-only); a REQUIRED resume mints the frozen single line for
        // the provable-money reason mintOptions documents. Every other
        // lane keeps the direct createFromService mint.
        let adoptedConcurrentInvoice = false;
        if (typedLiveRequiredMint) {
          const { mintScheduledServiceInvoiceWithDeposit } = require('../services/scheduled-invoice-mint');
          const useReplayLines = !resumingCommittedCompletion;
          const scheduledInvoice = useReplayLines
            ? await InvoiceService.buildLineItemsForScheduledService(svc.id, {
              fallbackAmount: mintInvoiceAmount,
              fallbackDescription: svc.service_type,
            })
            : null;
          let typedMintLines = scheduledInvoice?.lineItems?.length
            ? scheduledInvoice.lineItems
            : [{
              description: svc.service_type,
              quantity: 1,
              unit_price: mintInvoiceAmount,
              amount: mintInvoiceAmount,
              category: svc.service_type,
            }];
          if (secureSetupFee) {
            typedMintLines = [...typedMintLines, {
              description: 'One-time setup fee',
              quantity: 1,
              unit_price: secureSetupFee.amount,
              amount: secureSetupFee.amount,
              category: 'Setup fee',
              // Durable single-use marker — see the sibling mint above.
              secure_claim: true,
            }];
          }
          const minted = await mintScheduledServiceInvoiceWithDeposit({
            // A REQUIRED resume mints the FROZEN amount — and PROVES it
            // (codex r7 P0): the guard compares the caller snapshot to the
            // locked row, so the resume passes the frozen cents AS the
            // snapshot price. Frozen ≡ locked row is the typed lane's money
            // identity (the freeze stamps estimated_price at commit and the
            // r5 catch restamps it from every reprice refusal), so a match
            // mints the provable frozen figure and ANY divergence — a
            // reprice after the restamp, or a restamp write that failed —
            // 409s back into the refresh→release loop instead of silently
            // billing the stale freeze. primary_line_price is NULL on the
            // synthetic snapshot (r9-round pre-push P0): invoice lines
            // PREFER primary_line_price, so the frozen single line at
            // estimated_price is provable money ONLY for a visit with no
            // primary line — null makes the guard PROVE that absence, and
            // a primary-carrying locked row 409s instead of silently
            // billing the wrong single-line total. First runs keep the
            // live snapshot: a mid-flight reprice 409s, the catch restamps
            // the frozen cents from the locked price, and the resume bills
            // the moved price.
            svc: useReplayLines
              ? svc
              : { ...svc, estimated_price: mintInvoiceAmount, primary_line_price: null },
            allowPriceMovement: false,
            buildCreateParams: () => ({
              customerId: svc.customer_id,
              serviceRecordId: record.id,
              scheduledServiceId: svc.id,
              lineItems: typedMintLines,
              discountIds: scheduledInvoice?.discountIds || undefined,
              taxRate: mintInvoiceTaxRate,
              frozenTaxAuthority: true,
              frozenPayerId: mintInvoicePayerId,
              dueDate: serviceDateOnly(record.service_date),
              trustedStoredDiscountSources: scheduledInvoice ? ['scheduled_service'] : [],
            }),
          });
          invoice = minted.invoice;
          adoptedConcurrentInvoice = minted.reused === true;
        } else {
          try {
            invoice = await InvoiceService.createFromService(record.id, mintOptions);
          } catch (mintErr) {
            // Typed reprice refusal on a NON-required live lane (codex r6
            // P1): these lanes' failure posture is non-blocking — the
            // completion finalizes succeeded — so without an in-place retry
            // the 409 that exists to make the retry bill fresh would
            // instead finalize the visit with NO invoice at all (lost AR,
            // strictly worse than the stale price it refused). Rebuild once
            // from the price the refusal proved current (read under the
            // mint's own row lock): amount AND basis move together, so the
            // replay rebuilds from the moved price and a SECOND movement
            // mid-retry 409s again and falls through to the non-blocking
            // catch like any transient failure. Required lanes never enter
            // this branch's 409 (backfill mints bypass replay; typed
            // one-time mints go through the serialized helper above and
            // release for resume on refusal).
            if (mintErr?.code === 'SCHEDULED_PRICE_MOVED'
              && Number.isInteger(mintErr.currentEstimatedPriceCents)
              && mintErr.currentEstimatedPriceCents > 0) {
              const movedPrice = mintErr.currentEstimatedPriceCents / 100;
              logger.warn(`[dispatch] visit ${svc.id} repriced mid-mint — retrying the completion invoice at the moved price $${movedPrice.toFixed(2)}`);
              invoice = await InvoiceService.createFromService(record.id, {
                ...mintOptions,
                amount: movedPrice,
                scheduledPriceBasis: movedPrice,
              });
            } else {
              throw mintErr;
            }
          }
          // createFromService can ADOPT an invoice another mint committed
          // first (codex r6 round) — fold that into the same
          // adopted-concurrent handling as the serialized helper's
          // `reused` flag: setup-fee claim restore, service-record
          // back-link, and already-paid messaging all key off it.
          if (invoice?.adopted_existing_invoice) adoptedConcurrentInvoice = true;
        }
        // An adopted concurrent invoice was minted by another writer — the
        // claimed setup fee did NOT ride it; restore the claim (guarded on
        // the exact negative marker) instead of retiring it below.
        if (secureSetupFee && adoptedConcurrentInvoice) {
          try {
            await db('scheduled_services')
              .where({ id: secureSetupFee.parentId, pending_setup_fee: -secureSetupFee.amount })
              .update({ pending_setup_fee: secureSetupFee.amount, updated_at: new Date() });
          } catch (restoreErr) {
            logger.warn(`[dispatch] setup-fee restore failed for visit ${svc.id} (recovery will adopt): ${restoreErr.message}`);
          }
          secureSetupFee = null;
        }
        // Back-link an adopted pre-mint to the fresh service_record (same
        // contract as the pre-minted suppressor path above).
        if (adoptedConcurrentInvoice && !invoice.service_record_id) {
          try {
            await db('invoices').where({ id: invoice.id }).update({
              service_record_id: record.id,
              technician_id: svc.technician_id || invoice.technician_id || null,
              updated_at: new Date(),
            });
          } catch (e) { logger.warn(`[dispatch] Could not back-link adopted invoice to service_record: ${e.message}`); }
        }
        // The mint landed — retire the durable setup-fee claim (guarded on
        // the exact negative marker). If this clear fails or the process
        // dies first, the orphaned-claim recovery above finds the minted
        // line on the next completion and heals without a second charge.
        // Retire ONLY when the fee actually rides the invoice (codex r6
        // round): createFromService can now ADOPT an invoice another mint
        // committed first — the claimed fee did not ride that one, so the
        // claim goes back positive (the recovery re-mints it on the next
        // completion) instead of being silently retired unbilled.
        if (secureSetupFee) {
          const feeRode = JSON.stringify(invoice?.line_items || '')
            .toLowerCase().includes('one-time setup fee');
          // Immutable claim record FIRST (before the retire below): if the
          // process dies after the retire commits but before the saved-card
          // rail runs, this row is the authorization evidence the resumed
          // request recovers — server-written only, matched on invoice_id +
          // exact cents at read time. Insert failure degrades to the old
          // behavior (resume routes to manual review), never blocks the
          // mint or the retire.
          if (feeRode && invoice?.id) {
            try {
              await db('setup_fee_claims')
                .insert({
                  invoice_id: invoice.id,
                  scheduled_service_id: secureSetupFee.parentId,
                  amount: secureSetupFee.amount,
                })
                .onConflict('invoice_id')
                .ignore();
            } catch (recErr) {
              logger.warn(`[dispatch] setup-fee claim record insert failed for invoice ${invoice.id} (crash-resume will route to review): ${recErr.message}`);
            }
          }
          try {
            await db('scheduled_services')
              .where({ id: secureSetupFee.parentId, pending_setup_fee: -secureSetupFee.amount })
              .update(feeRode
                ? { pending_setup_fee: null, updated_at: new Date() }
                : { pending_setup_fee: secureSetupFee.amount, updated_at: new Date() });
            if (!feeRode) {
              logger.warn(`[dispatch] setup-fee claim RESTORED for series ${secureSetupFee.parentId} — the completion adopted an invoice the fee did not ride`);
            }
          } catch (clearErr) {
            logger.warn(`[dispatch] setup-fee claim clear failed for series ${secureSetupFee.parentId} (recovery will heal): ${clearErr.message}`);
          }
        }
        // Point the reviewer at the money the skip left behind — the same
        // breadcrumb the prepaid skip logs (applyPrepaidCreditToInvoice).
        if (isBackfillCompletion && svc.source_estimate_id) {
          try {
            const { pendingDepositCredit } = require('../services/estimate-deposits');
            const unappliedDeposit = await pendingDepositCredit(svc.source_estimate_id);
            if (unappliedDeposit?.amount > 0) {
              logger.info(`[dispatch] backfill completion: estimate deposit NOT auto-applied for visit ${svc.id} — $${Number(unappliedDeposit.amount).toFixed(2)} unapplied deposit credit on estimate ${svc.source_estimate_id}; invoice ${invoice.invoice_number || invoice.id} left open for review`);
            }
          } catch (e) { logger.warn(`[dispatch] backfill deposit-credit review log failed: ${e.message}`); }
        }
        // Statement-accrual breadcrumb — same reviewer contract as the
        // deposit/prepaid skips above. Attachment happens ONLY at create
        // (invoice.js stamps payer_statement_id on the insert; no
        // attach-existing-invoice path exists anywhere), so the operator's
        // route to consolidate this invoice after review is void + re-create
        // (the fresh mint accrues to the open statement), or send it
        // individually to the AP — an unattached payer invoice is the
        // supported individual shape.
        if (isBackfillCompletion && invoice?.payer_id && !invoice.payer_statement_id) {
          try {
            const { isEnabled } = require('../config/feature-gates');
            if (isEnabled('payerStatements')) {
              const payerRow = await db('payers').where({ id: invoice.payer_id }).first('payment_terms');
              if (['net15', 'net30'].includes(payerRow?.payment_terms)) {
                logger.info(`[dispatch] backfill completion: payer-statement accrual SKIPPED for visit ${svc.id} — ${payerRow.payment_terms} invoice ${invoice.invoice_number || invoice.id} minted OFF the payer's open statement for review; to bill it on the monthly statement, void + re-create it (attach happens only at create), or send it individually to the AP`);
              }
            }
          } catch (e) { logger.warn(`[dispatch] backfill accrual-skip review log failed: ${e.message}`); }
        }
        invoice = await applyPrepaidCreditToInvoice(invoice);
        // An adopted concurrent invoice may already be settled — mirror the
        // pre-minted suppressor's SMS branch instead of promising a fresh
        // invoice.
        if (adoptedConcurrentInvoice && ['paid', 'prepaid'].includes(invoice.status)) {
          alreadyPaid = true;
        } else {
          invoiceCreated = true;
        }
        payUrl = await shortenOrPassthrough(`${portalUrl}/pay/${invoice.token}`, {
          kind: 'invoice', entityType: 'invoices', entityId: invoice.id, customerId: invoice.customer_id,
          codePrefix: invoiceShortCodePrefix(invoice),
        });
      } catch (invErr) {
        // A claimed setup fee whose mint failed goes back POSITIVE on the
        // series parent (guarded on the exact negative marker) — otherwise
        // the failed attempt would leave the in-progress claim for the
        // recovery path to re-adopt later instead of retrying cleanly now.
        if (secureSetupFee) {
          try {
            await db('scheduled_services')
              .where({ id: secureSetupFee.parentId, pending_setup_fee: -secureSetupFee.amount })
              .update({ pending_setup_fee: secureSetupFee.amount, updated_at: new Date() });
          } catch (restoreErr) {
            logger.warn(`[dispatch] setup-fee restore failed for visit ${svc.id} (recovery will adopt): ${restoreErr.message}`);
          }
        }
        // Fail-closed leg of the REQUIRED-mint promise (Codex P0, PR #2897
        // fix rounds 7-8; broadened round 9; extended to LIVE typed
        // one-time completions when the pre-transaction billing gate was
        // removed, owner ruling 2026-07-27). The removed gate was
        // FAIL-CLOSED — a typed one-time visit could not complete unbilled
        // — and its promise moved to the mint above; every backfill shape
        // the decision billed (scheduler flag, monthly-rate/tier, explicit
        // lanes, priced-visits gate) carries the same promise: the quiet
        // closeout's open review invoice. So when the frozen posture says
        // the mint was EXPECTED and NO invoice row exists (a partial
        // createFromService that did insert one converges on resume via the
        // existing-invoice suppressors), the completion must NOT finalize
        // succeeded: release the attempt's side-effects claim back to
        // 'side_effects_pending' — the machinery's immediately-resumable
        // state — and 503 with a retry instruction. The service_record
        // transaction is already committed, so the retry re-enters via the
        // resume claim: the frozen structured_notes REQUIRED-mint posture
        // and the hash-pinned body drive the same shouldInvoice decision
        // again, and the mint retries. Every NON-required shape (all other
        // live lanes) keeps the non-blocking behavior below exactly.
        // The posture here is the ROUTE-LEVEL effective value: the
        // commit-time live derivation on first run, the FROZEN
        // structured_notes posture on resume (fix round 8) — never a fresh
        // recomputation from the by-now-mutable billing profile.
        if (backfillReviewMintRequired && !invoice?.id) {
          logger.error(`[dispatch] REQUIRED completion-invoice mint FAILED for ${svc.id} (${isBackfillCompletion ? 'backfill review' : 'live typed one-time'}) — closeout NOT finalized: ${invErr.message}`);
          // Reprice refusal refreshes the FROZEN money (codex #3344 r5 P1):
          // the resume this release promises mints the frozen cents with
          // replay disabled — without this, the stale-price 409 the guard
          // just raised would be replayed as the stale price itself. The
          // required live lane's amount IS estimated_price (typed one-time
          // requires hasVisitPrice, so completionInvoiceAmount returns it),
          // and the attached cents were read under the mint's own row lock
          // — the moved price is the new money truth, so restamp it as the
          // frozen figure. A FAILED restamp is safe to release anyway
          // (codex r7 P0): the live typed resume passes the frozen cents AS
          // the guard's price snapshot, so a resume whose freeze disagrees
          // with the locked row 409s right back into this refresh instead
          // of minting the stale figure — the release IS the restamp's
          // retry, never a stale-mint promise. Zero/absent cents never
          // restamp — a frozen figure must stay a positive committed price.
          if (invErr?.code === 'SCHEDULED_PRICE_MOVED'
            && invErr.currentPrimaryLinePriceCents == null
            && Number.isInteger(invErr.currentEstimatedPriceCents)
            && invErr.currentEstimatedPriceCents > 0) {
            try {
              await mergeRecordNotesKeys(record.id, {
                backfillMintAmountCents: invErr.currentEstimatedPriceCents,
              });
              logger.warn(`[dispatch] frozen mint amount refreshed to ${invErr.currentEstimatedPriceCents}c for ${svc.id} after mid-mint reprice — the resume bills the moved price`);
            } catch (refreshErr) {
              logger.error(`[dispatch] frozen mint refresh FAILED for ${svc.id} — the resume will mint the pre-reprice freeze: ${refreshErr.message}`);
            }
          } else if (invErr?.code === 'SCHEDULED_PRICE_MOVED'
            && invErr.currentPrimaryLinePriceCents != null) {
            // Primary-carrying visit (r9-round pre-push P0): the locked row
            // holds a primary_line_price, so estimated_price is NOT the
            // whole bill and no single frozen figure can honestly cover it
            // — never restamp a guess. The resume's null-primary proof
            // 409s right back here, so the closeout stays unfinalized and
            // parked for the operator instead of minting wrong money.
            logger.error(`[dispatch] frozen mint NOT refreshed for ${svc.id} — the visit carries a primary line price, so a single-line freeze cannot honestly cover the bill; bill manually or clear primary_line_price, then retry the closeout`);
          } else if (invErr?.code === 'FROZEN_PAYER_DIVERGED') {
            // Bill-To reconciliation (codex r5 P1): without a restamp,
            // every resume restores the SAME stale frozen payer and 409s
            // again — an unrecoverable loop. Re-derive the tax authority
            // for the CURRENT payer with the exact fail-closed derivation
            // the freeze used, and restamp it beside the frozen amount;
            // the release below then promises a resume that mints under
            // the reconciled authority. A failed re-derivation releases
            // anyway — the resume re-raises the divergence and lands back
            // here to retry the reconciliation.
            try {
              const PayerService = require('../services/payer');
              const currentPayer = await PayerService.resolveForInvoice({
                customerId: svc.customer_id,
                scheduledServiceId: svc.id,
                throwOnError: true,
              });
              const currentPayerBilled = !!currentPayer?.payerId;
              let reconciledRate = 0;
              // Same guards as deriveCompletionTaxRate (r12 P0): exempt
              // payer → 0, and the residential-zero policy — a payer
              // change on a residential completion must not reconcile a
              // county rate the customer never owed.
              if (!(currentPayerBilled && currentPayer?.taxExempt === true)
                && ['commercial', 'business'].includes(svc.property_type)) {
                const TaxCalculator = require('../services/tax-calculator');
                const rr = await TaxCalculator.calculateTax(
                  svc.customer_id,
                  svc.service_type,
                  Number(mintInvoiceAmount) || 0,
                  currentPayerBilled ? { skipCustomerExemption: true } : {},
                );
                const r = Number(rr?.rate);
                if (!(Number.isFinite(r) && r >= 0 && r < 1)) {
                  throw new Error(`re-derived rate unusable: ${rr?.rate}`);
                }
                reconciledRate = r;
              }
              await mergeRecordNotesKeys(record.id, {
                backfillMintTaxRate: reconciledRate,
                backfillMintPayerId: currentPayer?.payerId || null,
              });
              logger.warn(`[dispatch] frozen Bill-To reconciled for ${svc.id} — the resume mints for ${currentPayer?.payerId ? `payer ${currentPayer.payerId}` : 'self-pay'} at rate ${reconciledRate}`);
            } catch (reconcileErr) {
              logger.error(`[dispatch] frozen Bill-To reconciliation FAILED for ${svc.id} — the resume re-raises the divergence and retries the reconciliation: ${reconcileErr.message}`);
            }
          }
          const released = await CompletionAttempts.releaseCompletionAttemptForResume(completionAttempt, invErr);
          if (!released) {
            // The conditional flip found the attempt not in
            // side_effects_running (finalized-attempt race, or the release
            // UPDATE itself failed). Never force it — but never promise an
            // immediate retry either: the retry claims 409
            // completion_side_effects_running until the stale window
            // reclaims the row (Codex P1, fix round 8).
            logger.error(`[dispatch] release-for-resume did NOT release attempt ${completionAttempt?.id} for ${svc.id} — retry blocked until the ${Math.ceil(CompletionAttempts.STALE_SIDE_EFFECTS_MS / 60000)}-minute stale window reclaims it`);
          }
          return ({ status: 503, body: {
            error: released
              ? 'The completion invoice could not be created — the closeout is saved but NOT finalized. Retry the closeout to mint the invoice.'
              : `The completion invoice could not be created — the closeout is saved but NOT finalized. It will become retryable within about ${Math.ceil(CompletionAttempts.STALE_SIDE_EFFECTS_MS / 60000)} minutes — retry the closeout then.`,
            code: 'backfill_invoice_mint_failed',
            ...(released ? {} : { retryAfterMs: CompletionAttempts.STALE_SIDE_EFFECTS_MS }),
            serviceRecordId: record.id,
          } });
        }
        logger.error(`[dispatch] Auto-invoice failed (non-blocking): ${invErr.message}`);
        // Exception-based (CLAUDE.md rule 14): a LIVE mint failure used to
        // be a log line only — the visit completed, the customer got the
        // report-only text, and the office found out when nobody paid
        // (2026-08-31→09-01: four priced completions, one still unbilled
        // two days later). Bell once per visit; the office bills by hand.
        // This catch covers the WHOLE invoicing block, so `invoice` may
        // already hold a committed row when a later step (prepaid credit,
        // back-link) threw — then the office must RECONCILE that invoice,
        // never mint a second one (GH r1 P1). No amount in the copy: the
        // base amount here is not the total the mint would have produced
        // (add-ons, discounts, setup fee, tax — GH r1 P1). The SMS path runs
        // AFTER this bell and can skip or fail on its own, so the copy does
        // not claim the text was delivered (GH r1 P2). Fail-soft — the
        // completion is already committed.
        try {
          const NotificationService = require('../services/notification-service');
          const { acquireScheduledInvoiceMintLock } = require('../services/scheduled-invoice-mint');
          const visitLabel = `${svc.service_type || 'this visit'} on ${String(svc.scheduled_date).slice(0, 10)}`;
          // Under the visit's invoice-mint lock, RESCAN for a live invoice
          // and pick the wording in the same transaction (GH r2 P1): the
          // failed mint released its lock, and Charge Now / checkout /
          // a resume can mint between that release and this bell — a
          // "create the invoice" instruction beside a live invoice is how
          // a second collectible invoice happens. notifyAdmin dedupes on
          // this trx too (its `trx` option), so lock, rescan, wording and
          // insert commit together.
          const bell = await db.transaction(async (trx) => {
            await acquireScheduledInvoiceMintLock(trx, svc.id);
            const liveNow = invoice?.id
              ? invoice
              : await completionSuppressorInvoiceLookup(trx, { scheduled_service_id: svc.id });
            return liveNow?.id
              ? NotificationService.notifyAdmin(
              'billing',
              'Completion invoice needs review — a post-mint step failed',
              `The completion for ${visitLabel} committed and invoice ${liveNow.invoice_number || liveNow.id} exists, but a later invoicing step failed. Review that invoice on the customer page before it is sent — do NOT create a second invoice for this visit.`,
              {
                link: `/admin/customers/${svc.customer_id}`,
                bell: true,
                dedupeKey: `live_invoice_postmint_failed:${svc.id}`,
                trx,
                metadata: {
                  customerId: svc.customer_id,
                  scheduledServiceId: svc.id,
                  serviceRecordId: record.id,
                  invoiceId: liveNow.id,
                  error: String(invErr?.message || '').slice(0, 200),
                },
              },
            )
            : NotificationService.notifyAdmin(
              'billing',
              'Completion invoice not created — bill this visit by hand',
              `The completion for ${visitLabel} committed, but its invoice could not be created; any completion text that sends will carry no pay link. Create and send the invoice from the customer page at the visit's price plus any add-ons or setup fee.`,
              {
                link: `/admin/customers/${svc.customer_id}`,
                bell: true,
                dedupeKey: `live_invoice_mint_failed:${svc.id}`,
                trx,
                metadata: {
                  customerId: svc.customer_id,
                  scheduledServiceId: svc.id,
                  serviceRecordId: record.id,
                  error: String(invErr?.message || '').slice(0, 200),
                },
              },
            );
          });
          // notifyAdmin returns null (no throw) when its dedupe lock/insert
          // fails — log that too, or a lost bell reads as delivered.
          if (!bell) logger.error(`[dispatch] live invoice-mint-failed bell NOT recorded for ${svc.id} (notifyAdmin returned null)`);
        } catch (bellErr) {
          logger.error(`[dispatch] live invoice-mint-failed bell FAILED for ${svc.id}: ${bellErr.message}`);
        }
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
    // Backfill closeouts never auto-consume account credit: the invoice must
    // land open and untouched for operator review (Codex P1, stale-sweep
    // lane) — silently draining a referral credit into a days-old backdated
    // bill (possibly flipping it prepaid) is a money movement the quiet path
    // promises not to make. The operator applies credit deliberately if it
    // belongs on the bill.
    // Appointment-card one-time completion lane (owner-approved 2026-08-01,
    // GATE_APPT_CARD_COMPLETION_CHARGE): the /secure lane's invite promises
    // "your card is only charged after service is completed" — for a
    // ONE-TIME visit whose card came through that lane (a completed or
    // satisfied appointment_card_requests row: page consent or auto-secure
    // under the same v10 enrollment consent), the completion invoice
    // auto-charges through the SAME rail as per-application billing, capped
    // at the visit's stamped estimated_price. Explicit membership /
    // annual-prepay / per-application lanes are excluded (they have their
    // own billing), as is any visit with an estimate_card_holds row (the
    // hold rail owns estimate-flow one-time bookings). Every failure mode
    // fails toward NOT auto-charging — the pay-link flow is the unchanged
    // fallback. Detected BEFORE the account-credit auto-apply below (Codex
    // #3153 r9 P1): an over-cap invoice on this lane must not consume
    // credit either — partial credit would be drained on a bill the lane
    // routes to review, and full coverage would flip it prepaid without
    // the cap ever being evaluated.
    let apptCardOneTimeCharge = false;
    let apptCardAcceptedAmount = null;
    let apptCardOverCap = false;
    let apptCardLaneUnresolved = false;
    ({ apptCardOneTimeCharge, apptCardAcceptedAmount, apptCardOverCap, apptCardLaneUnresolved } = await resolveAppointmentCardLane({
      svc, invoice, alreadyPaid, visitPerformed, perApplicationBilling, annualPrepayBilling, explicitMembershipLane,
    }));
    // Extended completion auto-charge lane (owner rulings 2026-08-26/27;
    // GATE_COMPLETION_AUTOPAY_CHARGE) — admission, hold exclusion, and the
    // PRE-CREDIT anchor/over-cap come from the shared verdict (derived here,
    // BEFORE the account-credit apply below, which reads them as fences).
    const {
      extendedAutopayCharge, extendedChargeCandidate, extendedLaneAnchor, extendedLaneOverCap,
    } = await resolveExtendedLane({
      svc, invoice, alreadyPaid, visitPerformed, perApplicationBilling, apptCardOneTimeCharge, apptCardLaneUnresolved, customerAutopayActive,
    });
    if (!isBackfillCompletion
      && invoice?.id && !alreadyPaid && !invoice.payer_id
      && !['paid', 'prepaid'].includes(String(invoice.status || '').toLowerCase())
      // Over-cap appointment-lane invoices keep their credit untouched
      // (Codex #3153 r9 P1) — the lane routes them to office review, and
      // review must see the bill exactly as minted. An UNVERIFIABLE lane
      // (lookup error) is treated the same (r10). The extended lane
      // mirrors the posture: over-cap / anchor-less invoices keep their
      // credit untouched for review.
      && !apptCardOverCap && !apptCardLaneUnresolved
      && !(extendedChargeCandidate && extendedLaneOverCap)
      && require('../config/feature-gates').gates.autoApplyAccountCredit) {
      try {
        const { applyAccountCreditToInvoice } = require('../services/customer-credit');
        // The appointment lane's frozen cap rides INTO the credit apply
        // (Codex #3153 r16 P1) and is re-checked against the LOCKED
        // invoice — the preflight fence above is an unlocked snapshot an
        // invoice edit can outrun. NULL accepted amount = cap 0 (the lane
        // is unchargeable, so credit must not touch its bill either).
        const creditResult = await applyAccountCreditToInvoice({
          invoiceId: invoice.id,
          ...(apptCardOneTimeCharge ? {
            maxAuthorizedSubtotal: apptCardAcceptedAmount != null ? apptCardAcceptedAmount : 0,
            // Live payer serialized inside the credit transaction (Codex
            // #3153 r21 P1) — a payer assigned after the invoice was
            // pre-minted must not have the homeowner's credit consumed.
            requireSelfPayScheduledServiceId: svc.id,
            // One-time lane re-verified INSIDE the credit locks (Codex
            // #3153 r24 P1): a lane change racing this route must not have
            // credit consumed (or the invoice marked prepaid) for a visit
            // that is no longer one-time — mirrors the saved-card guard.
            requireOneTimeLane: true,
          } : {}),
          // The extended lane's anchor rides INTO the credit apply the same
          // way the appointment lane's frozen cap does (pre-push P1) and is
          // re-checked against the LOCKED invoice — an invoice edit racing
          // this window must not have credit consumed past the anchor.
          ...(extendedChargeCandidate && !apptCardOneTimeCharge ? {
            maxAuthorizedSubtotal: extendedLaneAnchor != null ? extendedLaneAnchor : 0,
            requireSelfPayScheduledServiceId: svc.id,
            // Stopped-dunning honored before credit moves (pre-push P0
            // round 9) — a stop instruction must not have credit consumed
            // or the invoice flipped prepaid past the charge guard.
            refuseWhenDunningStopped: true,
            // Competing card-consent excluded before credit moves too
            // (pre-push P0 round 10) — mirrors the charge boundary.
            requireNoAppointmentCardLane: true,
            // The anchor AUTHORITY is re-derived under the credit apply's
            // own locks too (pre-push P0 round 2) — a price drop, mode
            // flip, or coverage stamp racing this window consumes nothing.
            requireExtendedCompletionAnchor: true,
          } : {}),
        });
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
    // collectible self-pay invoice. ANY saved tender collects (owner ruling
    // 2026-07-09: capture a payment method at signup and auto-charge it after
    // every visit — card or bank): chargeInvoiceWithSavedCard locks the PI to
    // the saved method's family, and customerOnAutopay already forces
    // card-only when the customer's ach_status is unhealthy. A card charge
    // settles inline (receipt SMS); an ACH debit lands 'processing' — money
    // in flight, so the pay link is suppressed and the webhook settles
    // processing→paid (receipt delivers then). Failure is non-blocking by
    // design: the invoice stays open and the completion SMS carries the pay
    // link exactly as before, so the customer experience degrades to manual
    // pay — never a blocked completion and never a double charge (the helper
    // fail-closes on a live PaymentIntent).
    // Completion-time payment texts (owner opt-in via sms_templates rows):
    // autoChargedReceiptPending — the inline auto-charge settled with the
    // combined report+receipt template active and receipt-text prefs
    // allowing it; the receipt job was enqueued DEFERRED, and the combined
    // text claims receipt_sent_at only AFTER confirmed delivery — every
    // earlier bail (crash, block, deactivated template) leaves the deferred
    // job to send the classic receipt. paymentFailedSmsContext — structured
    // facts of a genuine processor decline; the decline notice
    // (`payment_failed` template) sends as its own text and, when it
    // actually delivers, the completion SMS goes report-only.
    let autoChargedReceiptPending = false;
    let paymentFailedSmsContext = null;
    // Backfill closeouts never move money automatically: the visit is days
    // old and an off-session charge (plus the receipt/decline texts it can
    // spawn) would hit the customer with zero fresh context. Skipping the
    // whole rail leaves the exact no-chargeable-method posture — invoice
    // open and collectible, autoChargedReceiptPending/paymentFailedSmsContext
    // untouched — for explicit operator collection.
    if (isBackfillCompletion && (perApplicationBilling || apptCardOneTimeCharge || extendedChargeCandidate) && visitPerformed && invoice?.id && !alreadyPaid
      && customerAutopayActive) {
      logger.info(`[dispatch] backfill completion: completion auto-charge skipped for visit ${svc.id} — invoice ${invoice.id} left open for operator collection`);
    }
    const completionChargeSource = perApplicationBilling
      ? 'per_application_completion'
      : (apptCardOneTimeCharge ? 'appointment_card_completion' : 'autopay_completion');
    if (!isBackfillCompletion
      && (perApplicationBilling || apptCardOneTimeCharge || extendedChargeCandidate) && visitPerformed && invoice?.id && !alreadyPaid && !invoice.payer_id
      && !['paid', 'prepaid', 'void', 'processing'].includes(String(invoice.status || '').toLowerCase())
      && customerAutopayActive) {
      // Above-quote guardrail (card-on-file spec §3.6, owner default = HARD
      // CAP) — the accepted per-visit amount, the setup-fee allowance and the
      // cap ceiling come from the shared verdict; the charge service
      // re-enforces the same ceiling against the LOCKED invoice below.
      const { acceptedPerVisit, invoiceSubtotal, netInvoiceSubtotal, capCeiling } = await resolveCompletionChargeCap({
        svc, invoice, perApplicationBilling, apptCardOneTimeCharge, apptCardAcceptedAmount, extendedLaneAnchor, secureSetupFee,
      });
      if (acceptedPerVisit == null) {
        // No accepted amount to cap against (multi-service plan with no
        // row price or customer fee) — never auto-charge uncapped
        // (Codex #2680): route to office review, keep the pay-link flow.
        logger.warn(`[dispatch] completion auto-charge (${completionChargeSource}) skipped for visit ${svc.id}: no accepted amount on file to cap against — routed to office review`);
        try {
          await require('../services/notification-service').notifyAdmin(
            'billing',
            'Auto Pay charge skipped — no accepted amount on file',
            extendedAutopayCharge
              ? `A completed visit has an invoice but no accepted amount on file to cap the auto-charge against (no visit price and no membership rate). Auto Pay was NOT charged — review and bill manually or stamp the amount.`
              : `A completed visit has an invoice but no per-application amount on file to cap the auto-charge against. Auto Pay was NOT charged — review and bill manually or stamp the amount.`,
            { link: `/admin/customers/${svc.customer_id}`, metadata: { scheduledServiceId: svc.id, invoiceId: invoice.id, invoiceSubtotal } },
          );
        } catch (e) { logger.warn(`[dispatch] uncapped-charge review alert failed: ${e.message}`); }
      } else if (netInvoiceSubtotal > capCeiling + 0.005) {
        logger.warn(`[dispatch] completion auto-charge (${completionChargeSource}) skipped for visit ${svc.id}: invoice subtotal $${netInvoiceSubtotal} (net of discounts) exceeds accepted per-visit $${acceptedPerVisit} — routed to office review`);
        try {
          await require('../services/notification-service').notifyAdmin(
            'billing',
            'Auto Pay charge above accepted amount — review',
            `A completed visit's invoice ($${netInvoiceSubtotal.toFixed(2)} before tax, net of discounts) exceeds the accepted ${extendedAutopayCharge ? 'per-visit/membership' : 'per-application'} amount ($${acceptedPerVisit.toFixed(2)}). Auto Pay was NOT charged — review and bill manually or adjust the invoice.`,
            { link: `/admin/customers/${svc.customer_id}`, metadata: { scheduledServiceId: svc.id, invoiceId: invoice.id, invoiceSubtotal: netInvoiceSubtotal, acceptedPerVisit } },
          );
        } catch (e) { logger.warn(`[dispatch] above-quote review alert failed: ${e.message}`); }
      } else {
      // Combined report+receipt text (owner opt-in): armed BEFORE the charge
      // because the receipt-delivery queue drains ~1s after it — a successful
      // charge immediately claims receipt_sent_at so the queue's SMS leg
      // yields to the combined completion SMS. The receipt EMAIL leg is
      // unaffected either way. Arming requires the template active AND the
      // customer's receipt-text prefs to allow it — the combined text carries
      // receipt facts, so it must honor the same opt-outs the separate
      // receipt SMS does (preflighted here; the send itself still runs the
      // completion policy).
      const combinedReceiptArmed = await isOptInSmsTemplateEnabled('service_complete_paid_receipt')
        && await customerWantsReceiptTexts(svc.customer_id);
      try {
        const { customerOnAutopay: customerOnAutopayFresh, getChargeableAutopayMethod, isChargeableAutopayMethod } = require('../services/autopay-eligibility');
        const autopayPm = await getChargeableAutopayMethod({ id: svc.customer_id }, db);
        // Auto Pay re-resolved at the CHARGE boundary (Codex #3153 r12 P1):
        // customerAutopayActive was computed early in this long handler — a
        // pause/opt-out committing in between touches the CUSTOMER row,
        // which the method re-read above cannot see. Lookup failure charges
        // nothing (falls to the pay-link fallback like a missing method).
        let autopayStillActive = false;
        try {
          const freshCustomer = await db('customers').where({ id: svc.customer_id })
            .first('id', 'autopay_enabled', 'autopay_paused_until', 'autopay_payment_method_id', 'ach_status');
          autopayStillActive = !!freshCustomer && await customerOnAutopayFresh(freshCustomer);
        } catch (autopayRecheckErr) {
          logger.warn(`[dispatch] charge-boundary Auto Pay re-check failed for visit ${svc.id} — not charging: ${autopayRecheckErr.message}`);
        }
        // Live payer re-resolve at the charge boundary (Codex #3153 r13
        // P1): a payer assigned after the invoice was pre-minted lives only
        // on scheduled_services — the reused invoice's payer_id stays null.
        // Payer present (or lookup failure) → skip the charge exactly like
        // a missing chargeable method; the payer flows own the bill.
        let liveSelfPay = false;
        try {
          const boundaryPayer = await require('../services/payer').resolveForInvoice({
            customerId: String(svc.customer_id),
            scheduledServiceId: String(svc.id),
            throwOnError: true,
          });
          liveSelfPay = !boundaryPayer?.payerId;
        } catch (payerRecheckErr) {
          logger.warn(`[dispatch] charge-boundary payer re-check failed for visit ${svc.id} — not charging: ${payerRecheckErr.message}`);
        }
        if (liveSelfPay && autopayStillActive && isChargeableAutopayMethod(autopayPm)) {
          // deferReceiptDelivery: with the combined text armed, the receipt
          // job is enqueued a few minutes out — nothing is pre-stamped, so a
          // crash/block anywhere before the combined text delivers leaves
          // the job to send the classic receipt when it comes due.
          await StripeService.chargeInvoiceWithSavedCard(invoice.id, autopayPm.id, {
            // Atomic re-enforcement of the SAME ceiling the preflight above
            // validated (Codex #3153 r7 P0): the charge service re-checks it
            // against the LOCKED invoice, so an invoice edit racing this
            // window refuses instead of charging above consent — the
            // pay-link fallback takes over exactly like a decline.
            maxAuthorizedSubtotal: capCeiling,
            // Auto Pay + self-pay serialized inside the charge transaction
            // (r13/r14): FOR UPDATE on the customer and scheduled-service
            // rows orders the charge against concurrently-committing
            // pause/opt-out, method-switch, and payer-assignment edits.
            requireAutopayForCustomerId: svc.customer_id,
            requireSelfPayScheduledServiceId: svc.id,
            // The appointment lane also revalidates one-time-lane
            // membership under the locks (Codex #3153 r23 P1) — a billing
            // change racing this completion must refuse, never
            // double-collect beside dues/prepay. Per-application keeps its
            // own semantics (false).
            requireOneTimeLane: apptCardOneTimeCharge,
            // The extended lane must not charge past a FROZEN
            // appointment-card consent it failed to classify (pre-push
            // P0): any appointment_card_requests row appearing on the
            // visit — gate off, lookup raced, or inserted after the
            // unlocked admission check — refuses under the visit lock
            // (COMPETING_CARD_CONSENT → office review); a visit the
            // appt-card lane itself owns has apptCardOneTimeCharge=true
            // and never sets this.
            requireNoAppointmentCardLane: extendedAutopayCharge,
            // The locked invoice must still be THIS visit's bill (pre-push
            // P0 round 8) — the shared verdict checks it too; this is the
            // charge service's own assertion under the same locks.
            ...(extendedAutopayCharge ? { requireInvoiceScheduledServiceBinding: true } : {}),
            // The extended lane's cap AUTHORITY is re-derived and
            // re-asserted under the charge's own customer/visit/invoice
            // locks (pre-push P0): a billing-mode flip into
            // per-application/membership/annual-prepay, a coverage stamp,
            // or a price edit racing this window refuses instead of
            // charging beside dues/prepay coverage.
            requireExtendedCompletionAnchor: extendedAutopayCharge,
            ...(extendedAutopayCharge ? {
              // The extended lane charges EXISTING invoices, so it must
              // honor an explicit stopped-dunning instruction (pre-push P0
              // round 3: disputed bill / check in the mail stays
              // 'sent'/'overdue' and collectible) — the guard re-checks
              // under the invoice lock.
              refuseWhenDunningStopped: true,
              // Freeze the POST-CREDIT amount due in cents against the
              // locked invoice (pre-push P0 round 3): a tax-rate or raw
              // total edit racing this window can raise invoice.total
              // without moving the subtotal the cap compares — the
              // due-cents ceiling refuses instead of charging the larger
              // amount.
              maxAuthorizedChargeCents: Math.max(0, Math.round((Number(invoice.total || 0) - Number(invoice.credit_applied || 0)) * 100)),
            } : {}),
            deferReceiptDelivery: combinedReceiptArmed,
          });
          const fresh = await db('invoices').where({ id: invoice.id }).first();
          if (fresh) invoice = fresh;
          const freshStatus = String(invoice.status || '').toLowerCase();
          if (['paid', 'prepaid'].includes(freshStatus)) {
            alreadyPaid = true;
            invoiceCreated = false;
            payUrl = null;
            // Combined receipt only for an ACTUAL card charge ('paid'): a
            // 'prepaid' outcome means account credit covered the invoice
            // with no Stripe charge and no receipt job enqueued — a
            // combined "payment" text would cite $0/no card and stamp a
            // receipt nothing is queued to back. A pre-existing
            // receipt_sent_at means another path already sent this
            // invoice's receipt — never restate it.
            autoChargedReceiptPending = combinedReceiptArmed
              && freshStatus === 'paid'
              && !invoice.receipt_sent_at;
            try {
              await require('../services/autopay-log').logAutopay(svc.customer_id, 'charge_success', {
                details: { source: completionChargeSource, invoice_id: invoice.id, scheduled_service_id: svc.id },
              });
            } catch (e) { /* log-only */ }
          } else if (freshStatus === 'processing') {
            // ACH debit initiated — money in flight. NOT paid yet (the
            // receipt waits for the webhook's processing→paid settlement),
            // but the customer must not be invited to pay again either:
            // suppress the pay link and let the invoice ride 'processing'
            // (uncollectible everywhere by INVOICE_UNCOLLECTIBLE_STATUSES).
            invoiceCreated = false;
            payUrl = null;
            try {
              await require('../services/autopay-log').logAutopay(svc.customer_id, 'charge_success', {
                details: { source: completionChargeSource, invoice_id: invoice.id, scheduled_service_id: svc.id, ach_processing: true },
              });
            } catch (e) { /* log-only */ }
          }
          // Full-balance sweep (owner ruling 2026-08-08): the visit's own
          // charge just SETTLED on this method — collect the customer's
          // other open DELIVERED self-pay invoices through the same
          // chargeInvoiceWithSavedCard rail, one capped charge per invoice,
          // oldest first, stop on first failure. 'paid' ONLY (pre-push r2
          // P0): an ACH debit in 'processing' is money in flight, not proof
          // the tender is good — sweeping behind it would stack debits that
          // can all still fail. Detached so the tech's completion response
          // never waits on N Stripe round-trips; every outcome lands in
          // autopay_log. Dark behind GATE_COMPLETION_BALANCE_SWEEP
          // (re-checked inside the service).
          if (freshStatus === 'paid') {
            const sweepArgs = {
              customerId: svc.customer_id,
              excludeInvoiceId: invoice.id,
              paymentMethodId: autopayPm.id,
              triggerScheduledServiceId: svc.id,
            };
            // Resolved BEFORE the tick is scheduled — a deferred require
            // would run outside the request (and after teardown in tests).
            const { runCompletionBalanceSweep } = require('../services/completion-balance-sweep');
            setImmediate(() => {
              runCompletionBalanceSweep(sweepArgs)
                .catch((sweepErr) => logger.error(`[dispatch] balance sweep crashed for customer ${sweepArgs.customerId}: ${sweepErr.message}`));
            });
          }
        }
      } catch (chargeErr) {
        const suppressAlternateCollection = StripeService.savedCardChargeSuppressesAlternateCollection(chargeErr);
        const reconciliationRequired = StripeService.savedCardChargeNeedsReconciliation(chargeErr);
        const fallbackPolicy = completionSavedCardFallbackPolicy({
          suppressAlternateCollection,
          reconciliationRequired,
        });
        if (suppressAlternateCollection) {
          // Stripe collected or may have collected the money. The service
          // either owns an active charge claim or parked the invoice for
          // reconciliation. Suppress this request's fallback collection rails.
          paymentReconciliationRequired = reconciliationRequired;
          // This completion response must never expose a second collection rail
          // while another saved-card request owns the invoice. Even a fresh
          // claim can still succeed, and status-only manual-payment endpoints do
          // not have enough Stripe context to distinguish that in-flight owner.
          if (fallbackPolicy.suppressFallback) {
            invoiceCreated = false;
            payUrl = null;
            paymentCollectionSuppressed = true;
          }
          // Keep a defensive caller-side park for older/mocked service
          // implementations. `processing` is excluded from balance and pay
          // surfaces; when a PI is known, the webhook can still settle it.
          if (reconciliationRequired) try {
            // Bind the succeeded PI to the row while parking: the webhook's
            // settle path refuses a 'processing' invoice whose active PI
            // doesn't match, so without this binding the self-heal never
            // fires and the park is permanent (Codex round-9 P1). The
            // rollback erased the binding chargeInvoiceWithSavedCard wrote.
            // ATOMIC status guard (Codex round-10): the succeeded webhook can
            // settle the invoice paid via waves_invoice_id BEFORE this catch
            // runs — an unconditional park would downgrade that fresh 'paid'
            // back to money-in-flight. Only a still-collectible row parks.
            const parked = await db('invoices').where({ id: invoice.id })
              .whereNotIn('status', ['paid', 'prepaid', 'processing', 'void', 'refunded', 'canceled', 'cancelled'])
              .update({
                status: 'processing',
                ...(chargeErr.stripePaymentIntentId ? { stripe_payment_intent_id: chargeErr.stripePaymentIntentId } : {}),
                updated_at: new Date(),
              });
            const fresh = await db('invoices').where({ id: invoice.id }).first();
            if (fresh) invoice = fresh;
            if (!parked && ['paid', 'prepaid'].includes(String(invoice.status || '').toLowerCase())) {
              // The webhook won the race and settled it — this is the happy
              // self-heal, not an orphan situation anymore.
              alreadyPaid = true;
            }
          } catch (parkErr) {
            logger.error(`[dispatch] failed to park orphaned invoice ${invoice?.id} as processing: ${parkErr.message}`);
          }
          logger.error(`[dispatch] completion autopay charge (${completionChargeSource}) fenced alternate collection for invoice ${invoice?.id} (${chargeErr.code}, PI ${chargeErr.stripePaymentIntentId || 'unknown'}, reconciliation=${reconciliationRequired}, fallbackSuppressed=${fallbackPolicy.suppressFallback})`);
        } else {
          logger.warn(`[dispatch] completion autopay charge (${completionChargeSource}) failed for invoice ${invoice?.id} (falls back to pay link): ${chargeErr.message}`);
          // Arm the decline notice ONLY off the charge service's structured
          // decline facts — a real processor decline on the confirm. Guard
          // errors ("Invoice already paid", active-PI races), config and DB
          // failures carry no facts and must never text a customer that
          // their payment failed. attemptedAmount is the surcharge-inclusive
          // total the charge actually attempted; card facts come from the
          // exact method row the charge used.
          if (chargeErr.wavesCardDecline) {
            paymentFailedSmsContext = chargeErr.wavesCardDecline;
          }
        }
        try {
          await require('../services/autopay-log').logAutopay(svc.customer_id, 'charge_failed', {
            details: { source: completionChargeSource, invoice_id: invoice?.id, scheduled_service_id: svc.id, orphaned: chargeErr.code === 'STRIPE_CHARGED_DB_FAILED', collection_suppressed: fallbackPolicy.suppressFallback, collection_fenced: suppressAlternateCollection, reconciliation_required: reconciliationRequired, error: String(chargeErr.message || '').slice(0, 300) },
          });
        } catch (e) { /* log-only */ }
      } // end try/catch — paired with the above-quote guard's else
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
      if (paymentCollectionSuppressed) {
        // A fresh in-progress collision suppresses this request's card-hold
        // rail without mutating the hold: the owning request may still decline
        // deterministically. Only a truly ambiguous/orphaned outcome is parked
        // terminal for manual review.
        if (paymentReconciliationRequired) {
          await db('estimate_card_holds')
            .where({ scheduled_service_id: svc.id })
            .whereIn('status', ['held', 'charging'])
            .update({ status: 'charge_review', updated_at: db.fn.now() })
            .catch((e) => logger.error(`[admin-dispatch] failed to park card hold for payment reconciliation: ${e.message}`));
        }
      } else if (isBackfillCompletion) {
        // Backfill closeouts never move money automatically: skip the hold
        // charge entirely, leaving any live hold 'held' — un-charged and
        // reviewable, the same posture the hold service's own withheld-for-
        // review paths use — and bell the office so it doesn't sit silent
        // (holds don't surface on the unpaid-invoice feeds).
        try {
          const CardHolds = require('../services/estimate-card-holds');
          const liveHold = await CardHolds.heldCardForScheduledService(svc.id);
          if (liveHold) {
            logger.warn(`[dispatch] backfill completion: card-hold charge skipped for visit ${svc.id} — hold left held for operator review`);
            await require('../services/notification-service').notifyAdmin(
              'billing',
              'Card hold not charged — backfilled completion',
              'A stale visit was closed out as a backdated backfill, so its saved-card hold was NOT charged. Review the visit and charge or release the hold manually.',
              {
                link: liveHold.customer_id ? `/admin/customers/${liveHold.customer_id}` : '/admin/dispatch',
                metadata: { scheduledServiceId: svc.id, invoiceId: invoice.id, holdId: liveHold.id, source: 'backfill_completion' },
              },
            );
          }
        } catch (e) { logger.warn(`[dispatch] backfill card-hold review alert failed: ${e.message}`); }
      } else try {
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
        } else if (holdCharge?.reason === 'charge_in_progress') {
          // Keep the hold and completion fallbacks retryable. Every card rail
          // now checks the durable attempt fence server-side, so it cannot mint
          // a second PI while the owner is active; if that owner declines, the
          // existing pay link/mobile action works without another delivery job.
          logger.info(`[admin-dispatch] completion fallback retained while saved-card claim is active for invoice ${invoice.id}`);
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
    // A released resume ignores a fresh 'sending' marker: the run that set
    // it ended (it released the attempt) and its failed-status writes both
    // threw, so honoring it would skip the text and finalize without sending
    // (GitHub Codex r3 P1 on the split PR). A stale-window reclaim keeps the
    // guard — that run may still be mid-send.
    const completionSmsSendingFresh = recordStructuredNotes.completionSmsStatus === 'sending'
      && completionSmsAttemptedAt
      && Date.now() - completionSmsAttemptedAt < 10 * 60 * 1000
      && !resumingReleasedCompletion;
    const completionSmsAlreadyHandled = !!recordStructuredNotes.sentSmsBody
      || recordStructuredNotes.completionSmsStatus === 'sent'
      // 'deferred' = a send-window hold requeued the text on the
      // scheduled-SMS rail; that queued row owns the obligation, so a
      // re-completion must not send a second copy.
      || recordStructuredNotes.completionSmsStatus === 'deferred'
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

    const reviewCadenceEnabled = require('../config/feature-gates').isEnabled('reviewSequences');
    const shouldBundleReview =
      effectiveSendCompletionSms &&
      !completionSmsAlreadyHandled &&
      !recapSmsAlreadySentForVisit &&
      effectiveRequestReview &&
      svc.cust_phone &&
      !serviceReportV1Delivery &&
      (completionReviewDelayMinutes === undefined || completionReviewDelayMinutes === 0) &&
      // Cadence mode owns the ask: the review link is its own Day-0 message at
      // the smart send window, never bundled into the completion/receipt SMS
      // (bundling would also dodge the sequence's cap/cooldown bookkeeping).
      !reviewCadenceEnabled;

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

    // Digital business card: mint the customer's card off their first
    // completed visit, tied to the tech on record (services/customer-card.js).
    // Fire-and-forget — a mint failure never blocks the completion, and the
    // card.issued email inside is dark behind GATE_DIGITAL_BUSINESS_CARD.
    // Internal-only completion profiles (e.g. Waves Assessment) suppress all
    // customer comms/public tokens above, so they must not mint a
    // customer-facing card either (Codex P1 on PR #2588). Non-performed
    // outcomes also skip: no service was delivered, and minting would tie
    // the lifetime card to the wrong first visit/tech. 'incomplete' does NOT
    // return early in this handler — it records the alert and continues — so
    // it belongs here too, matching the referral-credit non-performed guard
    // (Codex P2 #2588 r2 + r5).
    // Backfill closeouts stay on the quiet path here too: the mint still runs
    // (pure data setup — card row / promoter enroll / short link), but
    // suppressIssuedEmail keeps the card.issued email from firing off a
    // days-old visit; it sends on the next real completion instead.
    const cardMintOutcomePerformed = !['inspection_only', 'customer_declined', 'incomplete'].includes(visitOutcome);
    if (!isInternalOnlyCompletion && cardMintOutcomePerformed) {
      try {
        const CustomerCardService = require('../services/customer-card');
        void CustomerCardService.ensureCardForCompletion({
          customerId: svc.customer_id,
          serviceRecordId: record.id,
          scheduledServiceId: svc.id,
          suppressIssuedEmail: isBackfillCompletion,
          // The card's public "First visit" date must show the day the visit
          // happened — for a backfill that's the backdated service day the
          // record already carries, not the office closeout instant.
          firstVisitAt: isBackfillCompletion ? toETNoonServiceDate(record.service_date) : null,
        }).catch((e) => logger.warn(`[dispatch] card mint failed (customerId=${svc.customer_id}): ${e.message}`));
      } catch (e) {
        logger.warn(`[dispatch] card mint dispatch failed: ${e.message}`);
      }
    }

    // Decline notice (owner-managed `payment_failed` template): a genuine
    // processor decline texts its own message carrying the pay link —
    // deliberately INDEPENDENT of the completion-SMS block below, so a
    // disabled / already-handled / failed completion text never drops the
    // notice. Rendered AND sent before the block: the completion SMS only
    // drops its pay link once this notice has actually delivered, so a
    // blocked/failed notice never strands the customer without a collection
    // link. Renders null while the template row is missing/disabled — that
    // keeps today's fallback (the pay link rides the completion SMS) until
    // the owner confirms the copy. The autopay_ entry point routes it
    // through the GATE_AUTOPAY_CUSTOMER_SMS rollout gate like every other
    // automated-charge customer text.
    let paymentFailedNoticeSent = false;
    // Resume dedupe: the side-effects resume path reruns the auto-charge, so
    // a crash after this notice delivered but before the completion attempt
    // was marked succeeded would text the same decline twice. 'sending' also
    // counts as handled for DEDUPE (a crash mid-send has an unknown outcome
    // and a duplicate payment text is worse than a drop — the admin
    // payment-failed bell covers the drop), as does 'deferred' (a queued
    // scheduled-rail row owns the one notice; its registry hooks settle the
    // status to sent/failed), but only a confirmed 'sent' suppresses the
    // completion SMS's pay link.
    const priorPaymentFailedNoticeStatus = String(recordStructuredNotes.paymentFailedNoticeStatus || '');
    if (priorPaymentFailedNoticeStatus === 'sent') {
      paymentFailedNoticeSent = true;
    } else if (paymentFailedSmsContext && !['sending', 'deferred'].includes(priorPaymentFailedNoticeStatus)
      && svc.cust_phone && invoice?.id && invoiceCreated && payUrl
      && require('../services/invoice-helpers').isInvoiceCollectibleStatus(invoice.status)
      && !invoice.payer_id
      // Backfill closeouts are quiet end-to-end — a declined backlog charge
      // parks on the admin payment-failed bell instead of texting the
      // customer about a visit from days/weeks ago.
      && !isBackfillCompletion) {
      try {
        const { formatCardLine, invoiceAmountDue } = require('../services/invoice-helpers');
        const attempted = Number(paymentFailedSmsContext.attemptedAmount);
        const paymentFailedBody = await renderTemplate('payment_failed', {
          first_name: svc.first_name || '',
          service_type: normalizeServiceTypeForTemplate(svc.service_type),
          service_date: new Date().toLocaleDateString('en-US', {
            weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York',
          }),
          pay_url: payUrl,
          // Surcharge-inclusive attempted total from the charge itself; the
          // amount-due fallback only covers a decline that somehow carried
          // no amount — never advertise $0.00.
          amount: (Number.isFinite(attempted) && attempted > 0 ? attempted : invoiceAmountDue(invoice)).toFixed(2),
          card_line: formatCardLine(paymentFailedSmsContext.cardBrand, paymentFailedSmsContext.cardLast4),
          card_last4: paymentFailedSmsContext.cardLast4 || '',
        }, {
          workflow: 'dispatch_service_complete',
          entity_type: 'service_record',
          entity_id: record.id,
        });
        if (paymentFailedBody) {
          // Durable 'sending' marker BEFORE the send — the resume-dedupe
          // above keys off it. Mutate the in-memory notes too so the later
          // completion-SMS writes (which spread recordStructuredNotes)
          // carry the marker forward instead of clobbering it.
          recordStructuredNotes.paymentFailedNoticeStatus = 'sending';
          recordStructuredNotes.paymentFailedNoticeAttemptedAt = new Date().toISOString();
          await mergeRecordNotesKeys(record.id, {
            paymentFailedNoticeStatus: recordStructuredNotes.paymentFailedNoticeStatus,
            paymentFailedNoticeAttemptedAt: recordStructuredNotes.paymentFailedNoticeAttemptedAt,
          });
          const failResult = await sendCustomerMessage({
            to: svc.cust_phone,
            body: paymentFailedBody,
            channel: 'sms',
            audience: 'customer',
            purpose: 'payment_failure',
            customerId: svc.customer_id,
            invoiceId: invoice.id,
            entryPoint: 'autopay_completion_decline',
            identityTrustLevel: 'phone_matches_customer',
            // billing_mode_at_send: the owner autopay digest (#3607) classifies
            // the text against the lane that authorized it.
            metadata: { original_message_type: 'payment_failed', service_record_id: record.id, invoice_id: invoice.id, billing_mode_at_send: resolveBillingLane({ billing_mode: svc.cust_billing_mode, waveguard_tier: svc.cust_waveguard_tier, monthly_rate: svc.cust_monthly_rate }).mode },
          });
          paymentFailedNoticeSent = !!failResult.sent;
          // Send-window hold: the decline is deliberately independent of
          // completion messaging — when the operator skipped the separate
          // completion SMS, this notice is the ONLY carrier of the failure
          // + pay link, and an unqueued 'failed' silently commits an unpaid
          // invoice with no customer-facing collection path. Queue the
          // exact rendered notice on the scheduled rail; the registry's
          // recheck suppresses a meanwhile-paid/payer-billed invoice, its
          // finalize runs the same markDeliverySent + notes flip as the
          // inline success below, and its onTerminal restores 'failed'.
          // The completion SMS keeps its pay link either way (only a
          // confirmed 'sent' drops it) — a morning double-link is coherent
          // copy; a night with no link is not.
          let paymentFailedNoticeDeferred = false;
          if (!failResult.sent && failResult.code === 'QUIET_HOURS_HOLD' && failResult.deferred && failResult.nextAllowedAt) {
            try {
              const TWILIO_NUMBERS = require('../config/twilio-numbers');
              await db('sms_log').insert({
                customer_id: svc.customer_id,
                direction: 'outbound',
                from_phone: TWILIO_NUMBERS.getOutboundNumber(),
                to_phone: svc.cust_phone,
                message_body: paymentFailedBody,
                status: 'scheduled',
                scheduled_for: new Date(failResult.nextAllowedAt),
                message_type: 'payment_failed',
                metadata: JSON.stringify({
                  entry_point: 'autopay_completion_decline_deferred',
                  service_record_id: record.id,
                  invoice_id: invoice.id,
                  pay_url: payUrl,
                  original_message_type: 'payment_failed',
                  // Lane that authorized the decline notice — the replay
                  // forwards it so the owner autopay digest (#3607)
                  // classifies the morning send against it.
                  billing_mode_at_send: resolveBillingLane({ billing_mode: svc.cust_billing_mode, waveguard_tier: svc.cust_waveguard_tier, monthly_rate: svc.cust_monthly_rate }).mode,
                  original_block_code: failResult.code,
                  replay_purpose: 'payment_failure',
                  refresh_customer_phone: true,
                  resolve_from_by_customer: true,
                }),
              });
              paymentFailedNoticeDeferred = true;
            } catch (queueErr) {
              logger.error(`[dispatch] held payment-failed notice requeue failed for invoice ${invoice.id} — recording failed (completion SMS keeps the pay link): ${queueErr.message}`);
            }
          }
          recordStructuredNotes.paymentFailedNoticeStatus = failResult.sent ? 'sent' : (paymentFailedNoticeDeferred ? 'deferred' : 'failed');
          if (failResult.sent) recordStructuredNotes.paymentFailedNoticeSentAt = new Date().toISOString();
          else if (!paymentFailedNoticeDeferred) recordStructuredNotes.paymentFailedNoticeError = failResult.code || failResult.reason || 'unknown';
          await mergeRecordNotesKeys(record.id, {
            paymentFailedNoticeStatus: recordStructuredNotes.paymentFailedNoticeStatus,
            ...(failResult.sent
              ? { paymentFailedNoticeSentAt: recordStructuredNotes.paymentFailedNoticeSentAt }
              : (paymentFailedNoticeDeferred ? {} : { paymentFailedNoticeError: recordStructuredNotes.paymentFailedNoticeError })),
          }).catch((noteErr) => logger.warn(`[dispatch] payment-failed notice status write failed: ${noteErr.message}`));
          record.structured_notes = recordStructuredNotes;
          if (paymentFailedNoticeDeferred) {
            logger.info(`[dispatch] payment-failed notice for invoice ${invoice.id} held outside the 8AM-8PM ET send window — queued for ${failResult.nextAllowedAt}`);
          } else if (!failResult.sent) {
            logger.warn(`[dispatch] payment-failed notice not sent for invoice ${invoice.id} (completion SMS keeps the pay link): ${failResult.code || failResult.reason || 'unknown'}`);
          } else {
            // The notice DELIVERED the pay link — the invoice must finalize
            // exactly as if the completion SMS had carried it (draft →
            // sent, sent_at/sms_sent_at, lead-conversion updates), because
            // the completion SMS below now goes report-only.
            try {
              const InvoiceService = require('../services/invoice');
              invoice = await InvoiceService.markDeliverySent(invoice.id, {
                sms: true,
                source: 'payment_failed_notice',
                payUrl,
              });
            } catch (statusErr) {
              logger.warn(`[dispatch] invoice delivery status sync after payment-failed notice failed for ${invoice?.id}: ${statusErr.message}`);
            }
          }
        }
      } catch (failErr) {
        logger.warn(`[dispatch] payment-failed notice errored for invoice ${invoice?.id} (completion SMS keeps the pay link): ${failErr.message}`);
      }
    }

    // Report EMAIL enqueue, independent of the SMS lane (email-only customers
    // still get the report). Hoisted into a function so the SMS lane's
    // retry-503 exit below can queue the email BEFORE releasing the attempt
    // (GitHub Codex r4 P1): the email channel must never wait on a retry
    // the tech may not make. Idempotent — emailAlreadyHandled plus the
    // queue's per-record dedupe make the call at the original site a no-op
    // after an early one. Not called from the token-withhold exit: with no
    // token there is nothing to email either; the retry that re-mints
    // re-enters both lanes.
    const queueServiceReportEmailIfEligible = async () => {
      const serviceReportEmailEnabled = serviceReportV1Delivery
        ? await runtimeServiceReportFlag(
            completionInput.actor,
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
          const disabledDelta = {
            serviceReportV1EmailStatus: 'disabled',
            serviceReportV1EmailDisabledAt: new Date().toISOString(),
          };
          const disabledNotes = { ...latestNotes, ...disabledDelta };
          await mergeRecordNotesKeys(record.id, disabledDelta)
            .catch((updateErr) => logger.warn(`[dispatch] v1 report email disabled status update failed: ${updateErr.message}`));
          record.structured_notes = disabledNotes;
        }
      }

      if (serviceReportEmailEligible({ serviceReportV1Delivery, suppressTypedCustomerComms }) && serviceReportEmailEnabled) {
        const latestNotes = parseJsonObject(record.structured_notes);
        const emailAlreadyHandled = ['queued', 'sending', 'sent', 'skipped'].includes(latestNotes.serviceReportV1EmailStatus);
        if (!emailAlreadyHandled) {
          try {
            // The email worker rebuilds and ATTACHES the current PDF at send
            // time — an emailed attachment is unrecallable. While grounded
            // copy is still pending, the job is enqueued DURABLY with a
            // 20-minute hold (survives a process restart, unlike a promise
            // callback — codex P1 r15+r16); the settlement callback below
            // pulls next_attempt_at forward the moment copy settles, so the
            // hold only fully elapses if the process died — and by then the
            // locked late write/sanitize has landed anyway.
            // Hold on timeout even if the regen landed grounded MEANWHILE
            // (codex P1 r22): the initial PDF may have started rendering the
            // stale copy during the timed-out window, and only the held path's
            // worker fence + key invalidation guarantees the email attaches a
            // post-settlement render.
            const emailHoldMs = lawnRecRegenAttempted && (lawnRecRegenTimedOut || !lawnRecRegenGrounded)
              ? 20 * 60 * 1000 : 0;
            const queued = await enqueueServiceReportV1EmailDelivery({
              serviceRecordId: record.id,
              customerId: svc.customer_id,
              token: reportToken,
              reportUrl,
              pdfUrl: reportToken ? `${portalUrl}/api/reports/${reportToken}` : null,
              delayMs: emailHoldMs,
              payload: {
                scheduled_service_id: svc.id,
                source: emailHoldMs ? 'dispatch_complete_held_for_grounding' : 'dispatch_complete',
                // The delivery worker enforces grounding readiness itself for
                // held jobs (elapsed time is not proof the settlement ran —
                // codex P1 r17).
                // The assessment identity rides on EVERY lawn-report delivery,
                // not just held ones (issue #3135). When regeneration settles
                // inside the hold window the job is enqueued normally, and
                // without this the worker had no assessment to fence — that
                // delivery dispatched with no version check and no send seal.
                // awaiting_grounding stays hold-only: it means "sanitize before
                // sending", which is a held-path obligation.
                ...(completedLawnAssessmentId ? { lawn_assessment_id: completedLawnAssessmentId } : {}),
                ...(emailHoldMs ? { awaiting_grounding: true } : {}),
              },
            });
            if (emailHoldMs && queued.delivery?.id && lawnRecFinalCopyPromise) {
              const heldDeliveryId = queued.delivery.id;
              logger.info(`[dispatch] report email held ${Math.round(emailHoldMs / 60000)}m for ${record.id} pending grounded copy`);
              void lawnRecFinalCopyPromise.then(async (finalCopy) => {
                // Pull forward only on VERIFIED settlement (codex P1 r18) —
                // unverified keeps the full hold, and the worker's own
                // sanitize gate still protects the send.
                if (!finalCopy?.verified) return;
                await db('service_report_deliveries')
                  .where({ id: heldDeliveryId, status: 'queued' })
                  .update({ next_attempt_at: new Date(), updated_at: new Date() })
                  .catch((pullErr) => logger.warn(`[dispatch] held email pull-forward failed for ${record.id}: ${pullErr.message}`));
              }).catch((chainErr) => logger.error(`[dispatch] held email pull-forward chain failed for ${record.id}: ${chainErr.message}`));
            }
            const queuedDelta = {
              serviceReportV1EmailStatus: queued.delivery?.status || (queued.skipped ? 'skipped' : 'queued'),
              serviceReportV1EmailDeliveryId: queued.delivery?.id || null,
              serviceReportV1EmailQueuedAt: queued.delivery?.created_at || new Date().toISOString(),
              serviceReportV1EmailError: queued.ok ? null : queued.error || null,
            };
            const queuedNotes = { ...latestNotes, ...queuedDelta };
            await mergeRecordNotesKeys(record.id, queuedDelta);
            record.structured_notes = queuedNotes;
          } catch (err) {
            const failedDelta = {
              serviceReportV1EmailStatus: 'failed',
              serviceReportV1EmailError: err.message || 'Email queue failed',
              serviceReportV1EmailFailedAt: new Date().toISOString(),
            };
            const failedNotes = { ...latestNotes, ...failedDelta };
            await mergeRecordNotesKeys(record.id, failedDelta)
              .catch((updateErr) => logger.error(`[dispatch] v1 report email queue status update failed: ${updateErr.message}`));
            record.structured_notes = failedNotes;
            logger.error(`[dispatch] v1 report email queue failed: ${err.message}`);
          }
        }
      }
    };

    // Third-party Bill-To delivery, callable from the resumable SMS exit as
    // well as the ordinary finalization below: the payer AP channel does not
    // depend on the homeowner text, so a retryable completion-SMS failure
    // must not leave the payer invoice a draft until the tech retries
    // (GitHub Codex #3745 r6 P1). Idempotent — the status check skips an
    // invoice already sent/finalized on a resumed attempt.
    const sendPayerInvoiceToApIfEligible = async () => {
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
      // email_sent_at is sendInvoiceEmail's own durable stamp: an accepted AP
      // email whose markDeliverySent then failed leaves status 'draft' with
      // the stamp set, and a resumed attempt must not mail it again (GitHub
      // Codex r3 P2 on the split PR).
      const payerInvoiceAlreadyDelivered = !!invoiceAlreadySent
        || !!invoice?.email_sent_at
        || ['sent', 'viewed', 'overdue', 'paid', 'prepaid', 'processing', 'void', 'refunded', 'canceled', 'cancelled']
          .includes(String(invoice?.status || '').toLowerCase());
      // Backfill closeouts skip the automatic payer AP send too — the invoice
      // stays unfinalized for the operator to review and send by hand (same
      // recovery path as a failed AP send below).
      if (invoice?.id && invoiceCreated && invoice.payer_id && !payerInvoiceAlreadyDelivered && !isBackfillCompletion) {
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
    };

    if (effectiveSendCompletionSms && svc.cust_phone && !completionSmsAlreadyHandled && !recapSmsAlreadySentForVisit
      && completionSmsWithheldForMissingReportToken({ serviceReportV1Delivery, typedDeliveryMode, reportToken })) {
      // Report-v1 visit with no public report token (mint failed above): the
      // report-lane template would render "your report is ready" around
      // reportUrl, which is the portal HOME on this path (delivery.js only
      // null-guards an empty url). Withhold the text instead. Marked 'failed'
      // — the existing one-shot vocabulary (closeout-status reads it as
      // completion_sms_failed, and it is NOT completionSmsAlreadyHandled, so a
      // resumed completion after the mint recovers sends normally). This
      // branch is the only place the token-mint bell fires: it is reached only
      // when a text WOULD have gone out (phone on file, not suppressed, not
      // already handled), so the bell always corresponds to a real withheld
      // text — same dedupe/transport as the email and PDF lane alerts. No
      // separate SMS-failure bell on this path.
      const withheldDelta = {
        completionSmsStatus: 'failed',
        completionSmsError: 'report token unavailable — completion text withheld',
        completionSmsFailedAt: new Date().toISOString(),
      };
      const withheldNotes = { ...recordStructuredNotes, ...withheldDelta };
      await mergeRecordNotesKeys(record.id, withheldDelta)
        .catch((updateErr) => logger.error(`[dispatch] completion SMS withheld status update failed: ${updateErr.message}`));
      record.structured_notes = withheldNotes;
      await markBundledReviewFailed();
      logger.error(`[dispatch] Completion SMS withheld for service_record ${record.id}: report token unavailable`);
      const { alertServiceReportTokenMintFailed } = require('../services/service-report/failure-alerts');
      await alertServiceReportTokenMintFailed({
        serviceRecordId: record.id,
        customerId: svc.customer_id,
        error: reportTokenMintError || 'report token unavailable',
      });
      // The withheld text must stay RECOVERABLE (GitHub Codex r2 P1): if this
      // handler ran on to markCompletionAttemptSucceeded, every later submit
      // would replay the stored response / 409 service_already_completed and
      // never re-enter this lane, and there is no manual report-send action.
      // So exit through the same release-for-resume + 503 the required-mint
      // and manual-billing alert failures use: the service_record is already
      // committed, the attempt goes back to side_effects_pending, and the
      // tech's retry re-enters here — ensureReportToken runs again and, once
      // it succeeds, the 'failed' marker above is not completionSmsAlreadyHandled
      // so the report text sends normally.
      // The payer AP channel does not depend on the report token or the
      // homeowner text — deliver it before releasing, exactly as the SMS
      // resume exit does, or a payer invoice sits as a draft until the tech
      // retries (GitHub Codex r2 P1 on the split PR).
      await sendPayerInvoiceToApIfEligible();
      const withheldErr = reportTokenMintError || new Error('report token unavailable');
      const released = await CompletionAttempts.releaseCompletionAttemptForResume(completionAttempt, withheldErr);
      if (!released) {
        logger.error(`[dispatch] release-for-resume did NOT release attempt ${completionAttempt?.id} for ${svc.id} — retry blocked until the ${Math.ceil(CompletionAttempts.STALE_SIDE_EFFECTS_MS / 60000)}-minute stale window reclaims it`);
      }
      return ({ status: 503, body: {
        error: released
          ? 'The service report link could not be created, so the completion text was NOT sent — the closeout is saved but NOT finalized. Retry the closeout.'
          : `The service report link could not be created, so the completion text was NOT sent — the closeout is saved but NOT finalized. It will become retryable within about ${Math.ceil(CompletionAttempts.STALE_SIDE_EFFECTS_MS / 60000)} minutes — retry the closeout then.`,
        code: 'service_report_token_mint_failed',
        ...(released ? {} : { retryAfterMs: CompletionAttempts.STALE_SIDE_EFFECTS_MS }),
        serviceRecordId: record.id,
      } });
    } else if (effectiveSendCompletionSms && svc.cust_phone && !completionSmsAlreadyHandled && !recapSmsAlreadySentForVisit) {
      // Set the moment the provider ACCEPTS the text and read by the catch
      // below: a route-local failure after acceptance (the post-send notes
      // merge, an event insert) must never be reported as "not delivered"
      // (GitHub Codex r3 P1).
      let completionSmsProviderAccepted = false;
      // What the attempted text IS (body/type/channel/review/pay-link), taken
      // before the provider call so the catch can stamp the honest 'sent'
      // state when acceptance is known only from the thrown error
      // (sentSmsBody is scoped inside the try).
      let completionSmsAcceptedSnapshot = null;
      // A definite provider REJECTION (or failed quiet-hours requeue) seen
      // inside the try, kept here so a route-local write that throws AFTER
      // it (the failed-notes merge, the bundled-review release) still takes
      // the rejection path in the catch instead of finalizing as a
      // pre-acceptance exception (GitHub Codex r2 P1 on the split PR).
      // Normalized to the providerOutcome shape the catch already reads.
      let completionSmsRejectedOutcome = null;
      // The ONE committed-but-not-finalized exit for a recoverable completion
      // text failure (GitHub Codex r3 P1): finalizing here would make every
      // later submit replay the stored response, and there is no dedicated
      // completion-SMS resend action (building one is a customer-comm side
      // effect — Adam's call). Same release-for-resume + 503 as the
      // token-mint failure: the 'failed' marker is not
      // completionSmsAlreadyHandled, so the tech's retry re-enters the lane
      // and re-sends. The email channel does not depend on the text: it is
      // queued first so the customer keeps it even if the tech never retries
      // (GitHub Codex r4 P1). Used by the provider-rejection path inside the
      // try and by the catch when a rejection's audit insert threw.
      const exitForCompletionSmsResume = async (sendErr) => {
        await queueServiceReportEmailIfEligible();
        await sendPayerInvoiceToApIfEligible();
        const released = await CompletionAttempts.releaseCompletionAttemptForResume(completionAttempt, sendErr);
        if (!released) {
          logger.error(`[dispatch] release-for-resume did NOT release attempt ${completionAttempt?.id} for ${svc.id} — retry blocked until the ${Math.ceil(CompletionAttempts.STALE_SIDE_EFFECTS_MS / 60000)}-minute stale window reclaims it`);
        }
        return ({ status: 503, body: {
          error: released
            ? 'The completion text could not be sent — the closeout is saved but NOT finalized. Retry the closeout to send it.'
            : `The completion text could not be sent — the closeout is saved but NOT finalized. It will become retryable within about ${Math.ceil(CompletionAttempts.STALE_SIDE_EFFECTS_MS / 60000)} minutes — retry the closeout then.`,
          code: 'completion_sms_send_failed',
          ...(released ? {} : { retryAfterMs: CompletionAttempts.STALE_SIDE_EFFECTS_MS }),
          serviceRecordId: record.id,
        } });
      };
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
        const allowCompletionInvoiceLinkBase = !suppressCompletionInvoiceLink
          && includePayLink !== false
          && !prepaidCovered
          && !alreadyPaid
          && !autopayCoversVisit
          // Collectible statuses only: a crash-resumed completion reloads the
          // invoice through the existing-invoice path with invoiceCreated/
          // payUrl set for any non-paid status — a 'processing' invoice (ACH
          // autopay debit in flight, or the orphaned-charge park) must never
          // get a pay link texted for money already moving (Codex round-6
          // P1). Mirrors the invoicePaymentActionRequired guard.
          && (!invoice || require('../services/invoice-helpers').isInvoiceCollectibleStatus(invoice.status))
          // Third-party Bill-To: never text the homeowner the pay link for a
          // payer-billed invoice — AR routes to the payer's AP inbox. The
          // homeowner still gets the report-only completion SMS (no pay_url).
          && !invoice?.payer_id;
        // The decline notice (sent before this block) carries the pay link
        // as its own text — the completion SMS goes report-only only once
        // that notice has ACTUALLY delivered.
        const allowCompletionInvoiceLink = allowCompletionInvoiceLinkBase && !paymentFailedNoticeSent;
        const usePaidCompletionTemplate = alreadyPaid
          || prepaidCovered
          || autopayCoversVisit
          || ['paid', 'prepaid'].includes(String(invoice?.status || '').toLowerCase());
        // Lawn Report V2 write-gate: freeze the synthesis onto the record (single
        // source of truth) and run the consistency check. Its smsSummary is no
        // longer read — the completion text is the plain DB template for every
        // service line (owner ruling 2026-08-01) — but the freeze and the
        // consistency check are what the REPORT reads, so the gate stays.
        // Best-effort; never blocks completion.
        if (serviceReportV1Delivery && typedDeliveryMode === 'auto_send') {
          try {
            const { finalizeLawnReportSynthesis } = require('../services/service-report/lawn-report-write-gate');
            const gate = await finalizeLawnReportSynthesis({ service: record, knex: db });
            // recordStructuredNotes was parsed BEFORE the gate wrote structured_notes.lawnReportV2;
            // fold the frozen synthesis back in so the later sending/sent writes (which
            // spread recordStructuredNotes) don't clobber it.
            if (gate.frozen) recordStructuredNotes.lawnReportV2 = gate.frozen;
          } catch { /* best-effort — render-time reconciliation still applies */ }
        }
        // The trace/applications lookup that used to feed this call is gone
        // with the re-entry line. It existed so the SMS could apply the same
        // read-time exterior normalization the report does (codex P2 #3007
        // r12/r13); with no advisory in the text there is nothing to
        // normalize, and resolveTracedExteriorZone queries scheduled_services,
        // resolves a completion profile and reads treatment_zone_maps — real
        // synchronous work on every completion whose result would be discarded.
        // {reservice_line} for every completion-family template (EXPAND half —
        // supplied before any body carries the token; see
        // service-report/delivery.js). '' unless GATE_RESERVICE_STREAMLINE +
        // GATE_RESERVICE_SELF_SERVE are on and the plan grants a lane, so
        // today's renders are byte-identical. Never throws.
        const { reserviceLineForCustomer } = require('../services/reservice-link');
        const completionReserviceLine = await reserviceLineForCustomer(svc.customer_id);
        // {past_due_line} for the with-invoice completion texts (EXPAND half —
        // same rollout discipline as {reservice_line} above: supplied at every
        // completion-family render site BEFORE any body carries the token, so
        // neither deploy ordering can suppress a send). Computed only when the
        // text will carry a pay link — a paid/prepaid or report-only
        // completion supplies '' — and excluding the visit's own invoice
        // (today's bill is not a past-due balance). '' unless
        // GATE_COMPLETION_SMS_BALANCE is on AND the customer has an older
        // open self-pay balance; never throws.
        // Suppressed outside the 8AM-8PM send window (codex P1): a late
        // completion's rendered body is FROZEN into the scheduled-SMS queue
        // (dispatch_completion_deferred below) and replayed verbatim at the
        // window open — a balance settled overnight (portal payment, sweep)
        // would still be asserted at 8 AM with no recheck. The pay link
        // tolerates that staleness (its target renders live paid state); a
        // static sentence claiming money owed does not, so a deferred
        // completion simply carries no balance line. The precheck MIRRORS
        // the authoritative validator's gating (codex r3 P2): with
        // GATE_SMS_SEND_WINDOW off the validator never defers — nighttime
        // completions send immediately, no frozen replay exists, and the
        // line rides; only a window that can actually hold suppresses. The
        // residual precheck→handoff race is closed by the
        // stripBalanceLineFromBody pass at the QUIET_HOURS_HOLD below.
        const { isWithinSendWindowET } = require('../services/messaging/send-window');
        const { isEnabled: gateEnabled } = require('../config/feature-gates');
        const { pastDueSmsLineForCustomer } = require('../services/open-balance');
        const completionSmsCanDefer = gateEnabled('smsSendWindow') && !isWithinSendWindowET();
        const completionPastDueLine = (invoiceCreated && payUrl && allowCompletionInvoiceLink && !completionSmsCanDefer)
          ? await pastDueSmsLineForCustomer(svc.customer_id, { excludeInvoiceId: invoice?.id || null })
          : '';
        const serviceReportV1SmsContext = serviceReportV1Delivery
          ? buildServiceReportV1DeliveryContext({
            record,
            service: svc,
            reportUrl,
            smsReportUrl: reportSmsUrl,
            payUrl: invoiceCreated && payUrl && allowCompletionInvoiceLink ? payUrl : null,
            reserviceLine: completionReserviceLine,
            pastDueLine: completionPastDueLine,
          })
          : null;
        // A billed report-v1 visit may take the report lane only when the
        // with-invoice template is BOTH gated on and actually renderable. The
        // probe is fail-closed (isOptInSmsTemplateEnabled), so a missing or
        // deactivated row leaves the generic service_complete_with_invoice
        // path exactly as it behaves today rather than arming a send that
        // would have to fall back mid-flight. Gate/template are only consulted
        // for a billed visit — an un-billed completion keeps its unchanged
        // path without a per-completion template lookup.
        const reportV1InvoiceArmed = serviceReportV1SmsContext?.enabled
          && serviceReportV1SmsContext.smsType === 'service_report_v1_with_invoice'
          && require('../config/feature-gates').isEnabled('reportV1InvoiceSms')
          && await isOptInSmsTemplateEnabled('service_report_v1_with_invoice');
        if (completionUsesReportLane({
          reportLaneEnabled: !!serviceReportV1SmsContext?.enabled,
          invoiceCreated,
          usePaidCompletionTemplate,
          reportV1InvoiceArmed,
        })) {
          sentSmsType = serviceReportV1SmsContext.smsType;
          // Always the editable DB template (owner ruling 2026-08-01). The lawn
          // lane used to swap in a prebuilt body leading with the V2 synthesis —
          // the score band plus a watering action — which made lawn texts read
          // nothing like pest and pushed them past one segment. That synthesis
          // belongs on the report. The write-gate above still runs: it freezes
          // the synthesis onto the record and runs the consistency check, both
          // of which the REPORT depends on; only its SMS lead-in is retired.
          let body = await renderTemplate(sentSmsType, serviceReportV1SmsContext.vars, {
            workflow: 'dispatch_service_complete',
            entity_type: 'service_record',
            entity_id: record.id,
          });
          // A toggled-off or removed variant must not cost the customer their
          // completion text (owner report 2026-07-06: the since-removed
          // progress variant was inactive and progress visits would have
          // texted nothing). For the BILLED lane the bar is higher: the text
          // must actually carry the pay link, so the RENDERED body is checked
          // for the URL rather than trusting the arming probe.
          // isOptInSmsTemplateEnabled only proves the row exists and is
          // active — an operator can edit {pay_url} out of the body in /admin,
          // and `sms_template_variants` outranks the base row anyway, so an
          // active template can render a perfectly good text with no way to
          // pay. Either way this falls to the generic invoice template;
          // dropping to the base report copy would leave a customer holding an
          // open invoice and no link. Only the un-billed lane can fall back to
          // bare report copy (where sentSmsType is already service_report_v1
          // and there is nothing to fall back to).
          if (sentSmsType === 'service_report_v1_with_invoice'
            && !reportV1InvoiceBodyCarriesPayLink(body, payUrl)) {
            sentSmsType = 'service_complete_with_invoice';
            body = await renderTemplate(sentSmsType, {
              first_name: svc.first_name || '',
              service_type: displayServiceType,
              portal_url: reportSmsUrl || reportUrl,
              pay_url: payUrl,
              reservice_line: completionReserviceLine,
              past_due_line: completionPastDueLine,
            }, {
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
            reservice_line: completionReserviceLine,
            past_due_line: completionPastDueLine,
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
            // Annual-prepay coverage means the plan paid for this visit when
            // it was bought, not today — service_complete_prepaid's "Thanks
            // for your payment today" reads wrong there (owner report
            // 2026-07-09). Plan-covered visits get the annual-prepay variant;
            // a disabled/missing variant falls back to the base paid template
            // so the toggle can never cost the customer their completion text.
            const paidTemplateVars = {
              first_name: svc.first_name || '',
              service_type: displayServiceType,
              portal_url: reportSmsUrl || reportUrl,
              reservice_line: completionReserviceLine,
              past_due_line: completionPastDueLine,
            };
            const paidTemplateContext = {
              workflow: 'dispatch_service_complete',
              entity_type: 'service_record',
              entity_id: record.id,
            };
            let body = null;
            // Re-check the receipt-text prefs at selection time: the
            // pre-charge probe can go stale in the window before this send,
            // and the combined text carries receipt facts under the
            // completion purpose — an opt-out flipped in between must win.
            // Skipping here is safe either way: no claim gets stamped, so
            // the DEFERRED receipt job enforces the receipt policy itself.
            if (autoChargedReceiptPending && await customerWantsReceiptTexts(svc.customer_id)) {
              // This completion's auto-charge settled inline and the combined
              // template is active: ONE text carries the report and the
              // receipt facts (amount, card, receipt link); the receipt job
              // was enqueued deferred and skips its SMS leg only after the
              // confirmed-delivery claim below.
              try {
                const InvoiceService = require('../services/invoice');
                const receiptFacts = await InvoiceService.receiptSmsFacts(invoice);
                sentSmsType = 'service_complete_paid_receipt';
                body = await renderTemplate(sentSmsType, {
                  ...paidTemplateVars,
                  amount: receiptFacts.amount,
                  card_line: receiptFacts.cardLine,
                  receipt_url: receiptFacts.receiptUrl,
                }, paidTemplateContext);
              } catch (factsErr) {
                logger.warn(`[dispatch] combined receipt facts failed for invoice ${invoice?.id}: ${factsErr.message}`);
              }
              // A null body here (template deactivated between the pre-charge
              // probe and now, or facts failure) falls through to the standard
              // paid template; the post-block recovery restores the separate
              // receipt the claim stood down.
            }
            if (!body && annualPrepayCovered) {
              sentSmsType = 'service_complete_annual_prepay';
              body = await renderTemplate(sentSmsType, paidTemplateVars, paidTemplateContext);
            }
            if (!body) {
              sentSmsType = 'service_complete_prepaid';
              body = await renderTemplate(sentSmsType, paidTemplateVars, paidTemplateContext);
            }
            if (!body) throw new Error('SMS template service_complete_prepaid is missing or inactive');
            sentSmsBody = `${body}${reviewSuffix}`.trim();
            completionSmsWasTruncated = false;
          } else {
            let body = await renderTemplate('service_complete', {
              first_name: svc.first_name || '',
              service_type: displayServiceType,
              portal_url: reportSmsUrl || reportUrl,
              reservice_line: completionReserviceLine,
              past_due_line: completionPastDueLine,
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
        // The lawn score/tip fold-in was REMOVED 2026-08-01 (owner ruling).
        // It appended the confirmed assessment's score line and a
        // recommendation-derived tip — watering advice among it — to lawn
        // completion texts, and budgeted two segments to fit them. That is the
        // same content the synthesis lead-in carried, arriving by a second
        // route: lawn texts still read nothing like pest, and still ran long.
        // The score and the tip belong on the report, which the text links to.
        // buildCompletionScoreBlock existed only to format that fold-in and had
        // no other caller, so it is removed with it; computeAssessmentScoreParts
        // stays — sendAssessmentNotification (unlinked assessments, manual
        // re-send) still uses it.
        if (sentSmsBody) {
          // smsNotesDelta accumulates every key this SMS leg owns — each
          // persisted write below merges the delta only (mergeRecordNotesKeys),
          // never the whole snapshot.
          const smsNotesDelta = {
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
          const sendingNotes = { ...recordStructuredNotes, ...smsNotesDelta };
          await mergeRecordNotesKeys(record.id, smsNotesDelta);
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
          // Captured BEFORE the provider call: sendCustomerMessage throws
          // past acceptance when its audit insert fails (providerOutcome on
          // the error), and the catch needs what was sent — body, type,
          // channel, whether the review link rode along, whether the
          // pay-link bookkeeping applies — to record the honest 'sent' state
          // (pre-push Codex P1 on #3772). Acceptance itself is
          // completionSmsProviderAccepted / e.providerOutcome, never this.
          completionSmsAcceptedSnapshot = {
            body: sentSmsBody,
            type: sentSmsType,
            channel: sentSmsChannel,
            reviewCarried: !bundledReviewUrl || sentSmsBody.includes(bundledReviewUrl),
            // Block-scoped inside this try; the accepted-error catch reads it
            // from the snapshot for the invoice bookkeeping.
            invoiceLinkAllowed: allowCompletionInvoiceLink,
          };
          let smsResult = await sendCustomerMessage(sendInput);
          if (!smsResult.sent && !smsResult.blocked && attemptedMms) {
            logger.warn(`[dispatch] MMS service report send failed for ${record.id}; retrying SMS-only`);
            const fallbackMetadata = { ...smsMetadata };
            delete fallbackMetadata.mediaUrls;
            delete fallbackMetadata.allowMediaUrls;
            fallbackMetadata.mms_fallback_reason = smsResult.reason || smsResult.code || 'provider_failure';
            completionSmsAcceptedSnapshot.channel = 'sms';
            smsResult = await sendCustomerMessage({
              ...sendInput,
              metadata: fallbackMetadata,
            });
            sentSmsChannel = 'sms';
            mmsFallbackToSms = true;
            smsNotesDelta.completionSmsMmsFallbackAt = new Date().toISOString();
            smsNotesDelta.completionSmsMmsFallbackReason = fallbackMetadata.mms_fallback_reason;
            sendingNotes.completionSmsMmsFallbackAt = smsNotesDelta.completionSmsMmsFallbackAt;
            sendingNotes.completionSmsMmsFallbackReason = smsNotesDelta.completionSmsMmsFallbackReason;
          }
          completionSmsProviderAccepted = smsResult.sent === true;
          // Send-window hold: a late completion (catch-up bookkeeping after
          // 8 PM) must not text at night, but this is a ONE-SHOT sender — no
          // worker retries a 'blocked' status — so the held text is requeued
          // on the scheduled-SMS rail and goes out at the window open.
          // Queued as the plain-SMS body (no MMS attachment): the executor
          // replays text-only, mirroring this route's own MMS→SMS fallback.
          // The bundled review link rides inside the queued body, so the
          // review claim is NOT marked failed on this path. If the enqueue
          // itself fails, fall through to the ordinary blocked handling.
          let completionHoldQueued = false;
          let completionHoldQueueError = null;
          if (!smsResult.sent
            && smsResult.code === 'QUIET_HOURS_HOLD'
            && smsResult.deferred
            && smsResult.nextAllowedAt) {
            try {
              const TWILIO_NUMBERS = require('../config/twilio-numbers');
              // Queue row + 'deferred' notes marker commit ATOMICALLY: the
              // marker is what the re-completion idempotency guard reads
              // (completionSmsAlreadyHandled), so a committed queue row
              // without it would let a later re-completion send a second
              // completion text while the first still sits queued.
              const deferredDelta = {
                completionSmsStatus: 'deferred',
                completionSmsDeferredTo: smsResult.nextAllowedAt,
              };
              // The balance clause never rides a frozen replay body (codex
              // P2, round 2): the send-window PREcheck at the line's compute
              // site can pass at 19:5x while the authoritative validator at
              // the provider handoff defers the send — this hold IS that
              // deferral, so strip the clause here and the queued body
              // matches what the precheck-suppressed path would have
              // rendered. The pay link stays (its target renders live paid
              // state); only the static balance sentence is removed.
              const deferredReplayBody = require('../services/open-balance')
                .stripBalanceLineFromBody(sentSmsBody, completionPastDueLine);
              await db.transaction(async (trx) => {
                await trx('sms_log').insert({
                customer_id: svc.customer_id,
                direction: 'outbound',
                from_phone: TWILIO_NUMBERS.getOutboundNumber(),
                to_phone: svc.cust_phone,
                message_body: deferredReplayBody,
                status: 'scheduled',
                scheduled_for: new Date(smsResult.nextAllowedAt),
                message_type: sentSmsType,
                metadata: JSON.stringify({
                  entry_point: 'dispatch_completion_deferred',
                  service_record_id: record.id,
                  original_block_code: smsResult.code,
                  refresh_customer_phone: true,
                  // from_phone above is a NOT-NULL placeholder — the
                  // executor resolves the customer's LOCATION number at
                  // send time so the morning text stays on their thread.
                  resolve_from_by_customer: true,
                  // Delivery-time finalization references (services/
                  // dispatch-completion-deferred.js, invoked by the
                  // scheduled-SMS executor AFTER the provider accepts): the
                  // invoice draft→sent flip, the bundled review's delivered
                  // mark, and the combined-receipt claim all run at actual
                  // delivery — never here, so a terminally-blocked replay
                  // leaves the invoice in draft on the operator's radar.
                  ...(invoice?.id && invoiceCreated && payUrl && allowCompletionInvoiceLink
                    ? { mark_invoice_delivery: true, invoice_id: invoice.id, pay_url: payUrl }
                    : {}),
                  ...(bundledReviewRequestId && bundledReviewUrl && sentSmsBody.includes(bundledReviewUrl)
                    ? { bundled_review_request_id: bundledReviewRequestId }
                    : {}),
                  ...(sentSmsType === 'service_complete_paid_receipt' && invoice?.id
                    ? { stamp_receipt_invoice_id: invoice.id }
                    : {}),
                }),
                });
                await trx('service_records').where({ id: record.id }).update({
                  structured_notes: trx.raw(
                    "COALESCE(structured_notes::jsonb, '{}'::jsonb) || ?::jsonb",
                    [JSON.stringify(deferredDelta)],
                  ),
                });
              });
              Object.assign(smsNotesDelta, deferredDelta);
              completionHoldQueued = true;
              // The bundled review ask rides inside the queued body. Its
              // standalone fallback is armed by the scheduled-SMS executor
              // ONLY if the queued row terminally blocks — a fixed timer
              // here would race a still-retryable replay and double-text
              // the ask (delivered replays mark the request delivered via
              // the finalization hook instead).
            } catch (queueErr) {
              completionHoldQueueError = queueErr;
              logger.error(`[dispatch] Completion SMS requeue failed for record ${record.id}: ${queueErr.message}`);
            }
          }
          if (completionHoldQueued) {
            // Notes marker already committed atomically with the queue row
            // above — only sync the in-memory snapshot here.
            record.structured_notes = { ...sendingNotes, ...smsNotesDelta };
            logger.info(`[dispatch] Completion SMS for customer ${svc.customer_id} held outside the 8AM-8PM ET send window — queued for ${smsResult.nextAllowedAt}`);
          } else if (!smsResult.sent) {
            // A quiet-hours hold whose scheduled-SMS enqueue FAILED is not a
            // policy block even though the result still says blocked: the
            // deferral was never persisted and no worker will ever send it
            // (GitHub Codex r3 P1) — it is a delivery failure with the
            // enqueue error.
            const holdEnqueueFailed = !!completionHoldQueueError;
            const policyBlocked = smsResult.blocked && !holdEnqueueFailed;
            completionSmsRejectedOutcome = policyBlocked ? null : {
              sent: false,
              terminal: !holdEnqueueFailed && smsResult.terminal === true,
              providerAlerted: !holdEnqueueFailed && !!smsResult.providerAlerted,
              providerErrorCode: holdEnqueueFailed ? 'SEND_WINDOW_REQUEUE_FAILED' : (smsResult.providerErrorCode || smsResult.code || null),
              providerHttpStatus: smsResult.providerHttpStatus || null,
              error: holdEnqueueFailed
                ? `send-window requeue failed: ${completionHoldQueueError.message || completionHoldQueueError}`
                : (smsResult.reason || smsResult.code || 'SMS send failed'),
            };
            Object.assign(smsNotesDelta, {
              completionSmsStatus: policyBlocked ? 'blocked' : 'failed',
              completionSmsError: holdEnqueueFailed
                ? `send-window requeue failed: ${completionHoldQueueError.message || completionHoldQueueError}`
                : (smsResult.reason || smsResult.code || 'SMS send failed'),
              completionSmsFailedAt: new Date().toISOString(),
            });
            const failedNotes = { ...sendingNotes, ...smsNotesDelta };
            await mergeRecordNotesKeys(record.id, smsNotesDelta);
            record.structured_notes = failedNotes;
            await markBundledReviewFailed(smsResult);
            logger.warn(`[dispatch] Completion SMS blocked/failed for customer ${svc.customer_id}: ${holdEnqueueFailed ? 'send-window requeue failed' : (smsResult.code || smsResult.reason || 'unknown')}`);
            // 'blocked' is a policy outcome (consent / opt-out) and intentional;
            // only a delivery FAILURE bells — this is a one-shot sender and
            // nothing retries it, so the bell is the only signal.
            if (!policyBlocked) {
              // A permanent provider refusal (twilio-sms.js terminal: true —
              // e.g. an invalid number) cannot be recovered by re-running
              // the send, so the closeout finalizes and the bell says what
              // to fix. Everything else — a retryable provider failure or a
              // failed requeue — is recoverable by re-entering this lane.
              const resumable = holdEnqueueFailed || smsResult.terminal !== true;
              if (smsResult.providerAlerted && !holdEnqueueFailed) {
                // A Twilio API exception already raised twilio_failure from
                // TwilioService.sendSMS (providerAlerted rides up from the
                // provider wrapper's catch) — one provider event, one bell
                // (GitHub Codex r4 P1). The completion-specific recovery
                // still reaches the tech through the 503 below and the
                // closeout reader's completion_sms_failed fact.
                logger.info(`[dispatch] completion SMS failure for ${record.id} already alerted as twilio_failure (${smsResult.providerErrorCode || smsResult.providerHttpStatus || 'api'}) — no completion_sms_failed bell`);
              } else {
                const { alertCompletionSmsFailed } = require('../services/service-report/failure-alerts');
                await alertCompletionSmsFailed({
                  serviceRecordId: record.id,
                  customerId: svc.customer_id,
                  smsType: sentSmsType,
                  // sendCustomerMessage wraps every provider failure as the
                  // generic code PROVIDER_FAILURE and carries the actionable
                  // Twilio classification (21610, 21614, 20429 …) in
                  // providerErrorCode — same precedence as dropped-call-sms.js.
                  errorClass: holdEnqueueFailed
                    ? 'SEND_WINDOW_REQUEUE_FAILED'
                    : (smsResult.providerErrorCode || smsResult.code || 'provider_failure'),
                  error: holdEnqueueFailed
                    ? completionHoldQueueError
                    : (smsResult.reason || smsResult.code || 'SMS send failed'),
                  resumable,
                });
              }
              if (resumable) {
                return exitForCompletionSmsResume(holdEnqueueFailed
                  ? completionHoldQueueError
                  : new Error(smsResult.reason || smsResult.code || 'Completion SMS provider failure'));
              }
            }
          } else {
            Object.assign(smsNotesDelta, {
              completionSmsStatus: 'sent',
              sentSmsBody,
              sentSmsAt: new Date().toISOString(),
              sentSmsType,
              sentSmsChannel,
              serviceReportPreviewAssetId: serviceReportPreviewAsset?.id || null,
            });
            const sentNotes = { ...sendingNotes, ...smsNotesDelta };
            await mergeRecordNotesKeys(record.id, smsNotesDelta);
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
            if (sentSmsType === 'service_complete_paid_receipt' && invoice?.id) {
              // Confirmed-delivery claim: the deferred receipt job now skips
              // its SMS leg (email leg unaffected). Stamped ONLY here — any
              // earlier bail leaves receipt_sent_at null and the deferred
              // job sends the classic receipt when it comes due.
              await db('invoices').where({ id: invoice.id }).whereNull('receipt_sent_at')
                .update({ receipt_sent_at: db.fn.now(), updated_at: new Date() })
                .catch((stampErr) => logger.warn(`[dispatch] combined-receipt claim failed for invoice ${invoice.id} — the deferred receipt may also text: ${stampErr.message}`));
            }
          }
        }
      } catch (e) {
        // sendCustomerMessage attaches providerOutcome to the error it throws
        // when Twilio ACCEPTED the message but the audit row failed to
        // persist (send-customer-message.js auditErr); the flag covers the
        // route-local writes AFTER acceptance (the 'sent' notes merge, event
        // inserts) that throw a plain error. Either way the text most likely
        // reached the customer, so the honest state is 'sent' with the audit
        // error recorded — NOT 'failed' (closeout-status would report
        // completion_sms_failed, the UI would say the text failed, and a
        // resume would send it again — GitHub Codex r2/r3/r4 P1s). No
        // failure bell, no release-for-resume, and the bundled review is
        // marked exactly as the success path would have.
        const providerAccepted = completionSmsProviderAccepted || e.providerOutcome?.sent === true;
        if (providerAccepted) {
          const snap = completionSmsAcceptedSnapshot || {};
          const acceptedDelta = {
            completionSmsStatus: 'sent',
            ...(snap.body ? { sentSmsBody: snap.body } : {}),
            sentSmsAt: new Date().toISOString(),
            ...(snap.type ? { sentSmsType: snap.type } : {}),
            ...(snap.channel ? { sentSmsChannel: snap.channel } : {}),
            completionSmsAuditError: e.message || 'post-send write failed',
          };
          const acceptedNotes = { ...parseJsonObject(record.structured_notes), ...acceptedDelta };
          await mergeRecordNotesKeys(record.id, acceptedDelta)
            .catch((updateErr) => logger.error(`Completion SMS accepted-state update failed: ${updateErr.message}`));
          record.structured_notes = acceptedNotes;
          if (snap.reviewCarried !== false) await markBundledReviewDelivered();
          else await markBundledReviewFailed();
          // The text reached the customer, so the invoice bookkeeping the
          // success branch performs after acceptance still applies: a
          // delivered pay-link text must not leave the invoice in draft, and a
          // delivered combined receipt must claim receipt_sent_at so the
          // deferred receipt job skips its SMS leg (GitHub Codex r5 P1). Both
          // are idempotent (markDeliverySent is a status sync; the claim is
          // whereNull) and best-effort like their success-path twins.
          if (invoice?.id && invoiceCreated && payUrl && snap.invoiceLinkAllowed) {
            try {
              const InvoiceService = require('../services/invoice');
              invoice = await InvoiceService.markDeliverySent(invoice.id, {
                sms: true,
                source: snap.type || 'completion_sms_with_invoice',
                payUrl,
              });
            } catch (statusErr) {
              logger.warn(`[dispatch] Invoice delivery status sync failed for ${invoice.id} after an accepted send: ${statusErr.message}`);
            }
          }
          if (snap.type === 'service_complete_paid_receipt' && invoice?.id) {
            await db('invoices').where({ id: invoice.id }).whereNull('receipt_sent_at')
              .update({ receipt_sent_at: db.fn.now(), updated_at: new Date() })
              .catch((stampErr) => logger.warn(`[dispatch] combined-receipt claim failed for invoice ${invoice.id} after an accepted send — the deferred receipt may also text: ${stampErr.message}`));
          }
          logger.warn(`[dispatch] Completion SMS for service_record ${record.id} was accepted by the provider (${e.providerOutcome?.providerMessageId || 'no message id'}) but a post-send write failed (${e.message}) — recorded as sent, no failure bell, do not re-send`);
        } else {
          // sendCustomerMessage attaches providerOutcome on BOTH outcomes
          // when the audit insert throws: a definite provider REJECTION that
          // reached here is the ordinary !smsResult.sent case wearing an
          // exception — the text did not go out and the cause is the
          // provider's, so it gets the same terminal/retryable split, the
          // same one-bell rule, and the same release-for-resume (pre-push
          // Codex P1 on the split PR).
          const rejected = (e.providerOutcome && e.providerOutcome.sent === false ? e.providerOutcome : null)
            || completionSmsRejectedOutcome;
          const failedDelta = {
            completionSmsStatus: 'failed',
            completionSmsError: (rejected ? rejected.error : null) || e.message || 'SMS send failed',
            completionSmsFailedAt: new Date().toISOString(),
          };
          const failedNotes = { ...parseJsonObject(record.structured_notes), ...failedDelta };
          await mergeRecordNotesKeys(record.id, failedDelta)
            .catch((updateErr) => logger.error(`Completion SMS failure status update failed: ${updateErr.message}`));
          record.structured_notes = failedNotes;
          await markBundledReviewFailed();
          logger.error(`Completion SMS failed: ${e.message}`);
          // A send that THREW before acceptance (an inactive template, a
          // render failure) is not recovered by re-running it — the cause
          // needs an operator fix first, and holding the closeout open would
          // 503 every retry until then, stranding the email/PDF lanes behind
          // it. So that path finalizes, and the bell says so (pre-push Codex
          // P1 r5): resumable:false, no release-for-resume. A provider
          // rejection is resumable unless the provider called it terminal.
          const resumable = rejected ? rejected.terminal !== true : false;
          if (rejected?.providerAlerted) {
            logger.info(`[dispatch] completion SMS failure for ${record.id} already alerted as twilio_failure (${rejected.providerErrorCode || rejected.providerHttpStatus || 'api'}) — no completion_sms_failed bell`);
          } else {
            const { alertCompletionSmsFailed } = require('../services/service-report/failure-alerts');
            await alertCompletionSmsFailed({
              serviceRecordId: record.id,
              customerId: svc.customer_id,
              smsType: null,
              errorClass: rejected
                ? (rejected.providerErrorCode || 'provider_failure')
                : (e.code || e.name || 'exception'),
              error: rejected ? (rejected.error || e.message || 'Completion SMS provider failure') : e,
              resumable,
            });
          }
          if (resumable) {
            return exitForCompletionSmsResume(new Error(rejected.error || 'Completion SMS provider failure'));
          }
        }
      }
    } else if (effectiveSendCompletionSms && svc.cust_phone && recapSmsAlreadySentForVisit) {
      // Record the skip in structured_notes so the audit trail (and the
      // completionSmsStatus surfaced in the response) shows WHY no
      // completion SMS went out for a visit that asked for one.
      const skippedDelta = {
        completionSmsStatus: 'skipped_recap_sms_already_sent',
        completionSmsSkippedAt: new Date().toISOString(),
      };
      const skippedNotes = { ...recordStructuredNotes, ...skippedDelta };
      await mergeRecordNotesKeys(record.id, skippedDelta)
        .catch((updateErr) => logger.warn(`[dispatch] completion SMS skip status update failed: ${updateErr.message}`));
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

    await queueServiceReportEmailIfEligible();

    // Only schedule the delayed follow-up message when the review wasn't
    // already bundled into the completion SMS above.
    // Legacy mode is SMS-only, so no phone = no ask. Cadence mode has its own
    // channel resolver with an SMS→email fallback (sendOutreachTouch), so an
    // email-only customer must still reach enrollment (Codex P2, r1) — the
    // resolver stops the sequence with no_contact/opted_out when neither
    // channel is available.
    if (effectiveRequestReview && (svc.cust_phone || reviewCadenceEnabled) && !bundledReviewUrl) {
      try {
        const ReviewService = require('../services/review-request');
        await ReviewService.enrollPostService({
          customerId: svc.customer_id,
          serviceRecordId: record.id,
          // Direct visit identity for plan resolution (codex #3235 r5 P1).
          scheduledServiceId: svc.id || null,
          serviceType: svc.service_type || null,
          techName: svc.tech_name || null,
          completedAt: new Date(),
          triggeredBy: 'auto',
          // Only an operator-SELECTED timing travels as an explicit delay —
          // it wins in both modes (Codex P2, r2). Untouched selector =
          // undefined = legacy 120-min default / cadence smart window.
          delayMinutes: completionReviewDelayMinutes,
          legacyDelayMinutes: 120,
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
        actorId: completionInput.actor.technicianId,
        // Same backfill contract as the first markComplete above: normally
        // idempotent by now, but when that call failed this one performs the
        // real flip — it must honor the duration policy AND the backdated
        // completed_at stamp too.
        untrustedLifecycleSpan: isBackfillCompletion,
        completedAt: backfillTrackerCompletedAt,
        // Same fence as the first markComplete above (codex rounds 13/17).
        expectedCorrectionSeq: svc.time_on_site_correction_seq ?? null,
      });
      await recordTrackTransitionResultFailure({
        jobId: svc.id,
        action: 'refresh_complete_tracker',
        actorId: completionInput.actor.technicianId,
        result,
      });
    } catch (e) {
      logger.error(`[admin-dispatch] refresh complete tracker failed: ${e.message}`);
      await recordTrackTransitionFailure({
        jobId: svc.id,
        action: 'refresh_complete_tracker',
        actorId: completionInput.actor.technicianId,
        error: e,
      });
    }

    if (!resumingCommittedCompletion) {
      try {
        await db('activity_log').insert({
          admin_user_id: completionInput.actor.technicianId, customer_id: svc.customer_id,
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

    // Yard-sign kit consumption (sign card + stake + sticker per completed
    // visit). Runs on the resume path too — the partial unique index on
    // product_inventory_movements makes it at-most-once per (product, visit).
    // Skipped for an incomplete visit, for inspection_only /
    // customer_declined closeouts and for an internal-only completion
    // profile such as a Waves Assessment (no sign is left). Never throws. Runs
    // BEFORE job costing so the initial cost calc sees the kit movements
    // (pre-push codex P1).
    try {
      const { consumeCompletionSupplies } = require('../services/supplies-consumption');
      await consumeCompletionSupplies(db, {
        scheduledServiceId: svc.id,
        serviceRecordId: record?.id || null,
        customerId: svc.customer_id || null,
        technicianId: svc.technician_id || null,
        isIncompleteVisit,
        visitPerformed,
        isInternalOnlyCompletion,
        serviceLine: reportServiceLine,
        serviceType: svc.service_type || null,
      });
    } catch (e) { logger.error(`[dispatch] completion supplies consumption failed: ${e.message}`); }

    // Job costing (non-blocking, fire-and-forget). Runs on FIRST RUN and on
    // RESUME (Codex P2, PR #2897 fix round 13): the required-mint throw can
    // 503 out of the mint try AFTER the record committed but BEFORE this
    // line, so a resumed retry that then succeeds would finalize with no
    // job_costs row / service_records financials until a manual recalc. The
    // !resumingCommittedCompletion guard here was born as part of a batch
    // wrap with the genuinely once-only side effects (activity log,
    // job_complete notification — 8bfd069bd); costing itself needs no
    // once-only protection: calculateJobCost is an idempotent UPSERT that
    // re-derives everything from persisted state (five other callers invoke
    // it repeatedly — manual recalc, expenses CRUD, billing-recovery,
    // projects, the financials backfill), and its durable
    // structured_notes.backfill guard re-derives the untrusted-span policy
    // on every run, so a resume recomputes the same values a completed
    // first run wrote. The opts are resume-safe too: isBackfillCompletion /
    // effectiveTimeOnSite are the frozen re-derivations by this point.
    try {
      const JobCosting = require('../services/job-costing');
      // Backfill: the row's actual_start/actual_end pair now spans a stale
      // check-in (days/weeks back) to today's office closeout, and the
      // tech-window time_entries fallback would scoop every job clocked in
      // between — either way weeks of labor booked to one visit. Labor may
      // only come from entries tied to THIS job or the operator's explicit
      // timeOnSite — never elapsed math over the stale span (same rule as
      // service_time_minutes via applyBackfillDurationPolicy). Forwarded
      // through the same workday-capped sanitizer the duration policy
      // uses (idempotent on the already-sanitized effectiveTimeOnSite),
      // so persisted duration and costed labor can never disagree.
      void JobCosting.calculateJobCost(svc.id, undefined, isBackfillCompletion
        ? { untrustedLifecycleSpan: true, explicitLaborMinutes: backfillTimeOnSiteMinutes(effectiveTimeOnSite) }
        : {}).catch(e =>
        logger.error(`[dispatch] Job cost calc failed: ${e.message}`)
      );
    } catch (e) { logger.error(`[dispatch] Job costing require failed: ${e.message}`); }

    // Follow-up suggestion for the RESPONSE (success-overlay CTA). On the
    // normal path this is the pre-transaction verdict whose alert already
    // parked atomically inside the completion trx above. On crash-resume,
    // runTypedValidation was bypassed (typedFindings stays null) and the
    // original transaction already parked-or-skipped the alert — so
    // re-derive the verdict from the committed snapshot purely so the
    // resumed response still carries the CTA, and best-effort re-park to
    // cover completions committed before the in-trx park deployed (the
    // dedup + live-child guards make this a no-op everywhere else).
    // Untyped alert-policy profiles (bed_bug_treatment post-untype) resume
    // through the same lane: their completion froze typedFollowupVerdict
    // into structured_notes, and the frozen-verdict read below is
    // form-independent. NO profile condition here — a profile deactivated,
    // repointed, or policy-cleared between the commit and a crash retry
    // must not hide the persisted promise from the resumed response; the
    // obligation helper reads the frozen verdict first and returns null
    // cheaply for lanes that never froze one (codex P2 r6).
    if (resumingCommittedCompletion && !isIncompleteVisit && !followupSuggestion) {
      try {
        const obligation = await typedFollowupObligationForCompletedSource({
          scheduledService: { ...svc, status: 'completed' },
        });
        if (obligation?.suggestion) {
          followupSuggestion = obligation.suggestion;
          if (followupSuggestion.required) {
            await parkFollowupAlert({
              scheduledService: svc,
              suggestion: followupSuggestion,
              serviceRecordId: obligation.serviceRecordId || record?.id || null,
              serviceName: completionProfile?.serviceName || null,
              customerName: [svc.first_name, svc.last_name].filter(Boolean).join(' ').trim() || null,
              source: 'typed_completion',
            });
          }
        }
      } catch (e) {
        logger.warn(`[dispatch] resumed follow-up derivation failed for ${svc.id}: ${e.message}`);
      }
    }

    // Third-party Bill-To: route the payer-billed auto-invoice to the AP inbox
    // (closure defined beside exitForCompletionSmsResume, which also runs it).
    await sendPayerInvoiceToApIfEligible();

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
      // Backfill closeouts leave the invoice for office review by contract —
      // the mobile client opens the in-person payment sheet on this flag, and
      // a backdated cleanup must not prompt anyone to collect on the spot.
      && !isBackfillCompletion
      && !paymentCollectionSuppressed
      // Collectible statuses only — 'processing' (an in-flight ACH autopay
      // debit, incl. the per-application completion charge and the orphaned-
      // charge park) must not reopen the mobile collection sheet for a visit
      // whose money is already moving (Codex round-5). Also covers
      // paid/prepaid/void/refunded via the shared helper.
      && require('../services/invoice-helpers').isInvoiceCollectibleStatus(invoice.status)
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
    // Backfill exclusion: crediting a referral posts real $25 account credits
    // to BOTH parties and texts/emails the referrer. A backdated cleanup of a
    // months-old row must not move money or contact anyone — and the reward is
    // single-use, so firing it here would also burn the guard on a visit
    // nobody is announcing. The referral stays claimable on a real completion.
    const closedDealVisitPerformed = visitOutcome !== 'inspection_only'
      && visitOutcome !== 'customer_declined'
      && !isIncompleteVisit;
    const referralVisitPerformed = closedDealVisitPerformed && !isBackfillCompletion;
    if (referralVisitPerformed) {
      try {
        const referralEngine = require('../services/referral-engine');
        await referralEngine.creditReferralOnFirstService({ customerId: svc.customer_id, serviceId: svc.id });
      } catch (referralErr) {
        logger.warn(`[referral] first-service credit failed for customer=${svc?.customer_id}: ${referralErr.message}`);
      }
    }
    // Same closed-deal signal as the referral credit, and gated by the same
    // performed-visit guard — but NOT by the backfill guard. Converting the
    // originating lead is a pure data write (lead-estimate-link resolves the
    // lead and calls leadAttribution.markConverted; no SMS, email, or money
    // anywhere in that path), so it does not violate the quiet-path contract.
    // It must NOT be deferred either: a stale-sweep closeout is the LAST
    // completion these rows will ever get, so suppressing it would strand the
    // originating lead 'open' forever with no later completion to convert it —
    // permanently understating won-deal attribution. Best-effort + idempotent;
    // only matches never-converted leads.
    if (closedDealVisitPerformed) {
      try {
        const { convertLeadFromEvent } = require('../services/lead-estimate-link');
        await convertLeadFromEvent({ source: 'service_completed', customerId: svc.customer_id });
      } catch (leadErr) {
        logger.warn(`[lead-trigger] first-service conversion failed for customer=${svc?.customer_id}: ${leadErr.message}`);
      }
    }

    // Recurring plan refill / end-of-plan flag — same maintenance the
    // admin-schedule completion path runs (see recurring-series-extend).
    // The row's status is 'completed' regardless of visitOutcome (the
    // service_record carries 'incomplete'), so the visit consumed its series
    // slot either way and the refill check is due. Idempotent on the durable
    // resume path (it only tops up when upcoming < 2 and dedupes on dates).
    // Failure-isolated: never fails the committed completion.
    try {
      const { runPostCompletionSeriesMaintenance } = require('../services/recurring-series-extend');
      await runPostCompletionSeriesMaintenance({ db, svc, source: 'dispatch_complete' });
      // Re-warm AFTER the refill (codex #3382 r2 P2): when this completion
      // consumed a series' last scheduled visit, the earlier bounded warm
      // ran against an ownership view with no upcoming row — the composer
      // suppresses that (recent uncorroborated identity) and spends
      // nothing. The refill just created the next visit, so the report IS
      // card-eligible now; this pass does the real warm. CHAINED on the
      // first warm's own promise (pre-push r6 P1: after a bounded timeout
      // the first lookup is still in flight, and performPropertyLookup has
      // no in-flight dedupe — an unconditional second call could hit slow
      // providers twice and race cache writes). crossSellWarm non-null ⇔
      // the guard passed earlier under the frozen posture, so this reuses
      // that decision; cache-first makes it a no-op read whenever the
      // first warm already did the work. Fire-and-forget: everything
      // customer-facing already went out.
      if (crossSellWarm) {
        const { prewarmReportCrossSellEvidence } = require('../services/service-report/evidence-prewarm');
        void crossSellWarm.catch(() => null).then(() => prewarmReportCrossSellEvidence(record, db));
      }
    } catch (seriesErr) {
      logger.error(`[dispatch] recurring series maintenance failed (non-blocking): ${seriesErr.message}`);
    }

    // Completion comms guard (GATE_COMPLETION_COMMS_GUARD, dark by default):
    // a visit completed while the customer has a pending reschedule/away
    // flag or an unanswered inbound text surfaces an admin exception (bell
    // notification + dispatch_alerts card). POST-COMMIT by placement — the
    // completion record and the invoice decision are durable above — and
    // fail-soft by construction: the runner checks the gate, owns its own
    // advisory-lock dedupe (completion-comms:<serviceId>) and swallows its
    // errors, and this try/catch backstops it (dues-covered exemplar
    // pattern). A guard throw must NEVER fail the completion; it never
    // blocks or alters invoicing and sends no customer communications.
    // Backfills excluded, matching the route-wide quiet-closeout posture
    // (referral credit, payer AP send, timer sync): a backdated cleanup must
    // not ring a live bell correlating a months-old visit with an unrelated
    // inbound text or customer-wide flag from the last week.
    if (!isBackfillCompletion) {
      try {
        const { runCompletionCommsGuard } = require('../services/completion-comms-guard');
        await runCompletionCommsGuard({ serviceId: svc.id, customerId: svc.customer_id });
      } catch (commsGuardErr) {
        logger.warn(`[dispatch] completion comms guard failed (non-blocking): ${commsGuardErr.message}`);
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
      completionAdvisories: completionAdvisoryMessages({
        blackout: waveguardBlackoutApproval,
        nLimit: waveguardNLimitApproval,
        manager: waveguardManagerApproval,
        calibration: waveguardCalibrationAdvisory,
        inventory: waveguardInventoryAdvisory,
      }),
      ...(completionTimerSync.corrected != null ? { timeEntryCorrected: completionTimerSync.corrected } : {}),
      ...(completionTimerSync.blocked ? { timeEntryCorrectionBlocked: completionTimerSync.blocked } : {}),
      ...(typedFindingsType ? {
        typedFindingsType,
        typedDeliveryMode,
        followupSuggestion,
      } : {
        // Untyped alert-policy completions (bed_bug post-20260731400000)
        // parked the same obligation — the panel needs the suggestion to
        // render its Book-follow-up CTA (codex P1 r1).
        ...(followupSuggestion ? { followupSuggestion } : {}),
        // A suppressed untyped delivery posture must reach the panel too:
        // the success overlays disclose internal-only/disabled delivery
        // from typedDeliveryMode, else they claim "SMS + Report sent" on a
        // completion the server suppressed (codex P2 r8).
        ...(typedDeliveryMode !== 'auto_send' ? { typedDeliveryMode } : {}),
      }),
    };
    // Refresh the stored response with the final invoice info — this is an
    // UPDATE of an already-succeeded row (set above immediately after the
    // trx commit), not a state transition.
    await CompletionAttempts.markCompletionAttemptSucceeded(completionAttempt, { record, invoice, response: responsePayload });
    markedSucceeded = true;
    return ({ status: 200, body: responsePayload });
  } catch (err) {
    // Only mark failed if we haven't already marked succeeded. After the
    // durable trx commits and the attempt is succeeded, an unhandled throw
    // in a recoverable side effect must NOT flip it back — that would
    // allow a retry to re-create service_record / invoice / SMS.
    if (!markedSucceeded && !durableCompletionCommitted) {
      await CompletionAttempts.markCompletionAttemptFailed(completionAttempt, err, db);
    } else {
      logger.error(
        `[dispatch] Post-commit error in /complete (attempt ${completionAttempt?.id} remains resumable): ${err.message}`
      );
    }
    throw err;
  }
}

module.exports = {
  completeScheduledService,
  COMPLETION_ACCESS_CODE_RE,
  serviceReportEmailEligible,
  lawnAssessmentCompletionBlockPayload,
  preflightLawnAssessmentCompletion,
  ensureSmsContainsReportLink,
  serviceDateOnly,
  backfillCompletionPlan,
  BACKFILL_MAX_TIME_ON_SITE_MINUTES,
  backfillTimeOnSiteMinutes,
  BACKFILL_INFERRED_START_FIELDS,
  BACKFILL_LIFECYCLE_END_FIELDS,
  BACKFILL_RECORD_END_FIELDS,
  applyBackfillDurationPolicy,
  applyBackfillRecordTimingPolicy,
  backfillCompletionEndInstant,
  syncLinkedJobTimer,
  liveTimeOnSitePlan,
  adjustedCompletionEndInstant,
  REENTRY_EDIT_MAX_MINUTES,
  completionReentryPlan,
  frozenResumeCompletionState,
  productReentryFloor,
  deductProductInventory,
  parseJsonObject,
  completionAllowsTechnicianPestRating,
  pestPressureConfigAllowsTechnicianRating,
  shouldRejectPhotoCaptionBannedCopy,
  internalOnlyProductsBlockPayload,
  completionOwnershipError,
  techTipsGateOn,
  reportReconcileBlockPayload,
  shouldCaptureApplicationConditions,
  completionSavedCardFallbackPolicy,
  reportV1InvoiceBodyCarriesPayLink,
  completionUsesReportLane,
  completionSmsWithheldForMissingReportToken,
  backfillExpectedMintAtCommit,
  shouldAutoInvoiceCompletion,
};
