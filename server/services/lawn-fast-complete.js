/**
 * Lawn Fast Complete, server half (GATE_LAWN_FAST_COMPLETE, lawn report rebuild
 * PR-C1). A lawn visit is a quick job; this is what the one-screen completion
 * sheet needs, built beside the pest, lawn re-service and tree & shrub sheets:
 *
 *   - buildLawnFastContext      GET  /:serviceId/lawn-fast/context
 *   - buildLawnFastWateringPreview  POST /:serviceId/lawn-fast/watering-preview
 *   - preflightLawnFastCompletion   the /complete `lawnFast` block's preflight
 *
 * Everything here is a read or a check: no write, no customer text or email. The
 * sheet completes through the existing /complete path and its existing messaging.
 *
 * Eligibility (owner 2026-10-03, "all lawn, but focus on the recurring"): every
 * regular lawn visit type is eligible, recurring program visits (the primary
 * path), per-application and one-time lawn visits. One function decides it,
 * lawnFastIneligibleReason. Nothing is refused for its visit type; the lawn
 * re-service keeps its own sheet and gate, and the Waves Assessment visit is its
 * own diagnostic lane.
 *
 * The photo minimum is ADVISORY (owner: nothing blocks the technician beyond
 * what the preflight strictly needs): it is reported as a warning in the context
 * and never refuses a completion.
 */
const db = require('../models/db');
const logger = require('./logger');
const featureGates = require('../config/feature-gates');
const { resolveEligibility, recapServiceIdentity, RECAP_COMPARED_IDENTITY_KEYS } = require('./pest-recap');
const { etCalendarDayOf } = require('../utils/datetime-et');
const { ASSESSMENT_EXPERIENCE_KEYS } = require('../config/completion-lane-registry');

const LAWN_CATEGORY = 'lawn_care';
// The lawn re-service (free between-visit callback) has its own sheet and gate
// (GATE_LAWN_RESERVICE_FAST_COMPLETE); it never opens here.
const RESERVICE_KEY = 'lawn_re_service';
// 'rescheduled' is the phantom row a legacy customer reschedule leaves behind
// (both schedule feeds hide it); /complete does not refuse it, so this does.
const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'skipped', 'no_show', 'incomplete', 'rescheduled']);

// FAIL-CLOSED RULE for every read in this file: a caught read failure is recorded
// (a Set of read names, like the report's readFailures) and NEVER continues with
// a value that is more permissive than a successful read could have produced.
// Everything that depends on the failed read is withheld or reported unknown, and
// the response names the failure so the sheet can say why. A read with no catch
// throws (a 500), which also fails closed.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Every id taken from the client reaches a uuid column; a malformed value would
// raise Postgres 22P02 (a 500), so it is checked first.
const isUuid = (value) => typeof value === 'string' && UUID_RE.test(value);
// The customer's billing lane could not be read: the visit type is unknown.
const BILLING_MODE_UNKNOWN = Symbol('billing_mode_unknown');

// Advisory photo floor, interim until the shared shot list lands: at least this
// many usable photos, one wide shot and one close-up (the assessment prompt
// needs both before confidence can exceed low). 'back' and 'side' are the
// legacy wide zones (lawn-visit-input.js).
const PHOTO_FLOOR = Object.freeze({
  minPhotos: 3,
  wideZones: Object.freeze(['front', 'back', 'side']),
  closeUpZones: Object.freeze(['close_up', 'trouble']),
});

/**
 * Which kind of lawn visit this APPOINTMENT is: 'recurring' (a recurring lawn
 * program visit, the primary path), 'per_application', 'one_time', 'other', or
 * 'unknown' (the billing lane could not be read).
 * Informational for the eligibility rule (it never makes a visit ineligible) but
 * decisive for the program recipe: only a 'recurring' appointment gets planned
 * products. It is decided from the appointment itself, never the customer's plan
 * or tier (a WaveGuard member's one-time job is not a program visit), by the
 * report's own rule (lawn-program-line.resolveProgramVisit): not a callback, a
 * real (not synthesized) completion profile whose billing type is recurring and
 * whose key is a recurring lawn plan key. A customer billed per application is
 * 'per_application' whatever the visit's key, since those visits start blank.
 */
function lawnFastVisitType(profile, billingMode, isCallback = false) {
  // A failed billing read cannot assert any type (a per-application customer would
  // read as recurring), so it is 'unknown' and gets no program defaults.
  if (billingMode === BILLING_MODE_UNKNOWN) return 'unknown';
  if (billingMode === 'per_application') return 'per_application';
  const billingType = String(profile?.billingType || '').toLowerCase();
  if (billingType === 'one_time' || billingMode === 'one_time') return 'one_time';
  if (isCallback === true || !profile || profile.synthesized) return 'other';
  if (billingType === 'recurring' && require('./service-report/lawn-program-line').isRecurringLawnPlanKey(profile.serviceKey)) return 'recurring';
  return 'other';
}

/**
 * THE eligibility rule for the lawn Fast Complete sheet: why this visit cannot
 * use it, or null. Any lawn_care visit is eligible; only a visit the sheet
 * cannot complete correctly, or one with its own lane, is refused. Pure.
 *
 * @param {{ svc: object, profile: object|null, visitGroupStatus?: string|null,
 *           hasVisitGroup?: boolean, allowStatuses?: string[] }} facts
 * `allowStatuses` lists visit statuses NOT treated as terminal (the submit
 * preflight passes ['completed'], see preflightLawnFastCompletion).
 */
function lawnFastIneligibleReason({ svc, profile, hasVisitGroup = false, visitGroupStatus = null, allowStatuses = [] }) {
  if (!profile) return 'profile_unavailable';
  if (profile.category !== LAWN_CATEGORY) return 'not_lawn';
  if (profile.serviceKey === RESERVICE_KEY) return 'lawn_re_service';
  if (ASSESSMENT_EXPERIENCE_KEYS.includes(profile.serviceKey)) return 'assessment_visit';
  if (profile.projectBacked || profile.requiresProject) return 'project_backed';
  if (Array.isArray(profile.companions) && profile.companions.length) return 'has_companions';
  // A grouped stop takes the full form. An orphaned pointer blocks too:
  // dissolution NULLs child visit_id, so a missing visit row means something is
  // mid-flight (same rule as /completion-status and the sibling sheets).
  if (hasVisitGroup && String(visitGroupStatus || '') !== 'dissolved') return 'grouped_visit';
  const status = String(svc?.status || '');
  if (TERMINAL_STATUSES.has(status) && !allowStatuses.includes(status)) return 'terminal_status';
  return null;
}

async function loadBillingMode(svc, knex, readFailures) {
  try {
    const row = await knex('customers').where({ id: svc.customer_id }).first('billing_mode');
    return row?.billing_mode || null;
  } catch (err) {
    // No driver message: it can echo SQL and bound values.
    logger.warn(`[lawn-fast] billing mode unavailable for ${svc.id}: ${err?.code || err?.name || 'Error'}`);
    readFailures.add('billing_mode');
    return BILLING_MODE_UNKNOWN;
  }
}

/**
 * Load the visit and decide eligibility. `{ ok: false, reason: 'not_found' }`
 * for a missing visit (or a malformed id, which no visit can have); otherwise
 * `{ ok, svc, profile, reason, visitType, readFailures }` with `reason` null when
 * eligible. Eligibility reads no billing data, so a failed billing read changes
 * only `visitType` (to 'unknown'), never the verdict. `withVisitType: false`
 * skips that read (the submit preflight does not need the type).
 */
async function resolveLawnFastEligibility(serviceId, knex = db, { allowStatuses = [], withVisitType = true } = {}) {
  if (!isUuid(serviceId)) return { ok: false, reason: 'not_found' };
  const base = await resolveEligibility(serviceId, knex);
  if (!base.ok) return { ok: false, reason: base.reason };
  const { svc, profile } = base;
  const readFailures = new Set();
  let visitGroupStatus = null;
  if (svc.visit_id) {
    // No catch: a failed read throws (a 500), never an eligible verdict.
    const visit = await knex('service_visits').where({ id: svc.visit_id }).first('status');
    visitGroupStatus = visit ? String(visit.status || '') : null;
  }
  const reason = lawnFastIneligibleReason({ svc, profile, hasVisitGroup: !!svc.visit_id, visitGroupStatus, allowStatuses });
  let visitType = null;
  if (profile && withVisitType) {
    const billingMode = reason === 'not_lawn' ? null : await loadBillingMode(svc, knex, readFailures);
    visitType = lawnFastVisitType(profile, billingMode, svc.is_callback === true);
  }
  return { ok: true, svc, profile, reason, visitType, readFailures };
}

// ── watering rules ──────────────────────────────────────────────────────────

const ruleSummary = (rule) => {
  if (!rule) return 'No watering rule on file';
  if (rule.mode === 'hold') {
    return rule.hold_until === 'dry' ? 'Hold watering until the treatment has dried' : `Hold watering ${rule.hold_hours} h`;
  }
  if (rule.mode === 'water_in') return `Water in ${rule.water_in_inches} in within ${rule.water_in_by_hours} h`;
  return 'No watering instruction';
};

// The report's frozen product facts for a catalog row: the SAME builder the
// completion freezes (report-data.approvedReportProductFacts), so the rule a
// product carries here is the rule the report would print. null = not approved
// for reports (no facts, so no rule, so no claim).
function reportFactsFor(row) {
  return require('./service-report/report-data').approvedReportProductFacts(row);
}

async function loadCatalogRows(ids, knex) {
  if (!ids.length) return new Map();
  const rows = await knex('products_catalog').whereIn('id', ids).select('*');
  return new Map((Array.isArray(rows) ? rows : []).map((row) => [String(row.id), row]));
}

function productRuleEntry(id, row) {
  const facts = row ? reportFactsFor(row) : null;
  return {
    productId: id,
    name: row?.name || null,
    approvedForReport: !!facts,
    rule: facts?.wateringRule ?? null,
    mowHoldDays: facts?.mowHoldDays ?? null,
    ruleSummary: ruleSummary(facts?.wateringRule ?? null),
    facts,
  };
}

const publicRuleEntry = ({ facts, ...entry }) => entry;

const MAX_PREVIEW_PRODUCTS = 20;

// The report-side context the watering instruction and banner are built from,
// loaded the way buildLawnAssessmentReportData loads it, for THIS visit:
//   - scheduleUnconfirmed (a moved home withholds the irrigation entries):
//     reportScheduleUnconfirmed over the property preferences, the active turf
//     profile and the visit's assessment;
//   - the week plan card the banner's plan sentence reads (GATE_IRRIGATION_WEEK_PLAN):
//     the current week's snapshot, only when it binds to this premise, rendered by
//     buildReportWeekPlan, the report's own builder.
// Validates what the client sent before any query: products_catalog.id and
// scheduled_services.id are uuid columns, so a malformed value would raise 22P02.
function parsePreviewRequest(serviceId, productIds) {
  if (!Array.isArray(productIds) || productIds.some((id) => typeof id !== 'string' || !isUuid(id.trim()))) {
    return { ok: false, reason: 'invalid_product_ids' };
  }
  // Postgres returns uuid columns in canonical lowercase, so ids are
  // lowercased before dedupe and map lookup: an uppercase id must find its row.
  const ids = [...new Set(productIds.map((id) => id.trim().toLowerCase()))];
  if (ids.length > MAX_PREVIEW_PRODUCTS) return { ok: false, reason: 'too_many_products' };
  if (!isUuid(serviceId)) return { ok: false, reason: 'not_found' };
  return { ok: true, ids };
}

// ANY failure of a read that feeds the move guard (preferences, turf profile,
// the visit's assessment) or the week plan is listed in `omitted`, and the
// preview then returns NO sentence: the report's move guard would withhold the
// former home's sprinkler figures and its plan sentence is part of the wording,
// so a sentence built from missing context could differ from (and be more
// permissive than) the report's. Nothing rebuilds the instruction around it.
async function loadReportWateringContext(svc, knex) {
  const reportData = require('./service-report/report-data');
  const omitted = [];
  const customerId = svc.customer_id;
  let turfProfile = null;
  let propertyPrefs = null;
  let assessment = null;
  try {
    turfProfile = await knex('customer_turf_profiles').where({ customer_id: customerId, active: true }).first();
    propertyPrefs = await knex('property_preferences').where({ customer_id: customerId }).first();
    assessment = await loadLatestAssessment(svc, knex);
  } catch (err) {
    logger.warn(`[lawn-fast] irrigation context unavailable for ${svc.id}: ${err?.code || err?.name || 'Error'}`);
    omitted.push('irrigation_context');
  }
  const scheduleUnconfirmed = reportData.reportScheduleUnconfirmed({ propertyPrefs, turfProfile, assessment });

  let weekPlan = null;
  if (featureGates.isEnabled('irrigationWeekPlan')) {
    try {
      const { loadCurrentWeekPlan, planBindsToService } = require('./irrigation-week-plan');
      const { resolveVisitAddress } = require('./service-report/report-identity-snapshot');
      const snapshot = await loadCurrentWeekPlan(customerId, { strict: true });
      const address = resolveVisitAddress({
        visit: svc,
        customer: {
          address_line1: svc.cust_address_line1,
          address_line2: svc.cust_address_line2,
          city: svc.cust_city,
          state: svc.cust_state,
          zip: svc.cust_zip,
        },
      });
      const premise = { address_line1: address.line1, address_line2: address.line2, city: address.city, zip: address.zip };
      if (snapshot?.plan && planBindsToService(snapshot, premise)) {
        weekPlan = reportData.buildReportWeekPlan(snapshot, assessment?.service_date || etCalendarDayOf(svc.scheduled_date));
      }
    } catch (err) {
      logger.warn(`[lawn-fast] week plan unavailable for ${svc.id}: ${err?.code || err?.name || 'Error'}`);
      omitted.push('week_plan');
    }
  }
  return { scheduleUnconfirmed, weekPlan, assessment, omitted };
}

/**
 * The watering preview for the chosen products: each product's rule, and the
 * one customer-facing watering instruction the REPORT would print, built by the
 * report's own functions (buildReportWateringInstruction, then
 * buildWateringBanner) from the same frozen-fact shape AND the same visit
 * context (property irrigation entries, move guard, this week's plan), so the
 * sheet's sentence can never differ from the report's. With
 * GATE_LAWN_WATERING_RULE off the report prints none, so neither does this
 * (rules are still listed).
 *
 * Provisional inputs (the report uses what exists at completion / render time):
 *   - completionTime: the report anchors its "until Thu 3 PM" labels to the
 *     visit's completion time; before completion it is `asOf` (now), so the
 *     response says the times hold "if completed now";
 *   - weekPlanLine: the plan sentence is composed on every report render from the
 *     plan present then, so it may differ from a later render;
 *   - assessment: with no confirmed assessment the report has no banner at all
 *     yet; the preview shows what it will say once one is confirmed.
 * A context read that fails withholds the whole sentence (`sentence: null`,
 * `lines: []`) and is named in `omitted`; the sheet never shows wording the
 * report's own guards might withhold or word differently.
 * `{ ok: false, reason }` for a bad request.
 */
async function buildLawnFastWateringPreview({ serviceId, productIds, knex = db, now = new Date() }) {
  const request = parsePreviewRequest(serviceId, productIds);
  if (!request.ok) return request;
  const { ids } = request;
  const svc = await require('./pest-recap').loadServiceWithCustomer(serviceId, knex);
  if (!svc) return { ok: false, reason: 'not_found' };

  // No catch on the catalog read: a failure throws (a 500), never a rule-less preview.
  const rows = await loadCatalogRows(ids, knex);
  const entries = ids.map((id) => productRuleEntry(id, rows.get(id) || null));
  const wateringRuleLive = featureGates.lawnWateringRuleLive();
  const out = {
    ok: true,
    wateringRuleLive,
    asOf: now.toISOString(),
    provisional: [],
    omitted: [],
    products: entries.map(publicRuleEntry),
    state: null,
    lines: [],
    sentence: null,
    mowHold: null,
  };
  if (!wateringRuleLive || !entries.length) return out;

  const reportData = require('./service-report/report-data');
  const context = await loadReportWateringContext(svc, knex);
  const { assessment } = context;
  if (context.omitted.length) {
    out.omitted.push(...context.omitted);
    return out;
  }
  out.provisional.push('completionTime');
  if (context.weekPlan) out.provisional.push('weekPlanLine');
  if (assessment?.confirmed_by_tech !== true) out.provisional.push('assessment');

  let instruction;
  try {
    // A product the catalog does not have is an unknown rule, exactly as a report
    // product with no frozen facts: no claim.
    instruction = await reportData.buildReportWateringInstruction({
      products: entries.map((entry) => ({ product_name: entry.name, approved_report_product_facts: entry.facts })),
      service: { customer_id: svc.customer_id },
      completionTime: now,
      lawnAssessment: { waterContext: { scheduleUnconfirmed: context.scheduleUnconfirmed } },
      knex,
    });
  } catch (err) {
    // The report builds no instruction when its irrigation inputs cannot be read.
    logger.warn(`[lawn-fast] watering inputs unavailable for ${serviceId}: ${err?.code || err?.name || 'Error'}`);
    out.omitted.push('irrigation_inputs');
    return out;
  }
  const banner = reportData.buildWateringBanner(instruction, context.weekPlan);
  if (banner) {
    out.state = banner.state;
    out.lines = banner.lines;
    out.sentence = banner.lines.length ? banner.lines.join(' ') : null;
    out.mowHold = banner.mowHold || null;
  }
  return out;
}

// ── photos and assessment ───────────────────────────────────────────────────

/**
 * Advisory photo status for an assessment. Never a refusal: `warning` is text
 * for the sheet, null when the floor is met.
 */
function evaluatePhotoFloor(photos) {
  const usable = (Array.isArray(photos) ? photos : []).filter((p) => p && p.quality_gate_passed !== false);
  const zoneOf = (p) => String(p.zone || '').trim().toLowerCase();
  const hasWide = usable.some((p) => PHOTO_FLOOR.wideZones.includes(zoneOf(p)));
  const hasCloseUp = usable.some((p) => PHOTO_FLOOR.closeUpZones.includes(zoneOf(p)));
  const missing = [];
  if (usable.length < PHOTO_FLOOR.minPhotos) missing.push('photos');
  if (!hasWide) missing.push('wide');
  if (!hasCloseUp) missing.push('close_up');
  const parts = [];
  if (missing.includes('photos')) parts.push(`${usable.length} of ${PHOTO_FLOOR.minPhotos} photos`);
  if (missing.includes('wide')) parts.push('no wide shot');
  if (missing.includes('close_up')) parts.push('no close-up');
  return {
    soft: true,
    count: usable.length,
    minPhotos: PHOTO_FLOOR.minPhotos,
    meetsFloor: missing.length === 0,
    missing,
    warning: missing.length ? `Photo set is light (${parts.join(', ')}). You can still finish; more photos make a stronger read.` : null,
  };
}

async function loadLatestAssessment(svc, knex) {
  return knex('lawn_assessments')
    .where({ service_id: svc.id, customer_id: svc.customer_id })
    .orderBy('created_at', 'desc')
    .orderBy('updated_at', 'desc')
    .first();
}

// The advisory photo set. A failed read is recorded and reads as no photo status
// (no warning to show, nothing refused): the floor is advisory, so withholding it
// is neither more permissive nor blocking.
async function loadAssessmentPhotos(assessmentId, knex, readFailures) {
  try {
    return await knex('lawn_assessment_photos').where({ assessment_id: assessmentId }).select('zone', 'quality_gate_passed');
  } catch (err) {
    logger.warn(`[lawn-fast] photo status unavailable: ${err?.code || err?.name || 'Error'}`);
    readFailures.add('photo_status');
    return null;
  }
}

// ── planned products ────────────────────────────────────────────────────────

/**
 * The visit's planned products with each one's watering rule: `{ source, items,
 * unavailable }`. Only a recurring program appointment has a plan: with the
 * completion-defaults gates off, or on a visit that is not one (one-time,
 * per-application, callback, other), the list is empty and the sheet starts
 * blank. An UNKNOWN visit type (billing read failed) and a failed plan or
 * catalog read also give the empty list, with `unavailable` naming why, so the
 * sheet can say the defaults could not be loaded. Empty is never more permissive
 * than a loaded plan: the tech adds what they applied. Nothing here blocks
 * opening the sheet.
 */
async function loadPlannedProducts(svc, knex, visitType, readFailures) {
  const empty = (unavailable = null) => ({ source: null, items: [], unavailable });
  if (visitType === 'unknown') return empty('billing_mode_lookup_failed');
  // buildPlanForService keys the program off the CUSTOMER (tier / billing mode),
  // so it can return the seasonal recipe for a member's one-time or
  // per-application appointment. Only a recurring program appointment gets it.
  if (visitType !== 'recurring') return empty();
  try {
    if (!require('./lawn-completion-defaults').lawnCompletionDefaultsEnabled()) return empty();
    const plan = await require('./waveguard-plan-engine').buildPlanForService(svc.id, { db: knex, includeCompletionDefaults: true });
    const items = Array.isArray(plan?.completionDefaults?.items) ? plan.completionDefaults.items : [];
    const withProduct = items.filter((item) => item?.product?.id);
    const rows = await loadCatalogRows(withProduct.map((item) => String(item.product.id)), knex);
    return {
      source: 'plan',
      unavailable: null,
      items: withProduct.map((item) => {
        const entry = productRuleEntry(String(item.product.id), rows.get(String(item.product.id)) || null);
        return {
          productId: item.product.id,
          name: item.product.name || entry.name,
          applicationMethod: item.applicationMethod || null,
          amount: item.mix?.amount ?? null,
          amountUnit: item.mix?.amountUnit ?? null,
          approvedForReport: entry.approvedForReport,
          wateringRule: entry.rule,
          wateringSummary: entry.ruleSummary,
          mowHoldDays: entry.mowHoldDays,
        };
      }),
    };
  } catch (err) {
    logger.warn(`[lawn-fast] planned products unavailable for ${svc.id}: ${err?.code || err?.name || 'Error'}`);
    readFailures.add('planned_products');
    return empty('planned_products_lookup_failed');
  }
}

// The height-of-cut capture is optional: a failed flag read hides it (false), the
// less permissive side, and is recorded.
async function loadTurfHeightCapture(technicianId, knex, readFailures) {
  if (!technicianId) return false;
  try {
    return await require('./feature-flags').isUserFeatureEnabled(technicianId, 'turf-height-capture', false, knex);
  } catch {
    readFailures.add('turf_height_flag');
    return false;
  }
}

/**
 * The sheet's context for one scheduled service. `{ ok: false, reason }` for a
 * missing visit; an ineligible visit answers `eligible: false` with the reason
 * and the visit identity and skips the heavier reads.
 */
async function buildLawnFastContext(serviceId, { knex = db, technicianId = null } = {}) {
  const base = await resolveLawnFastEligibility(serviceId, knex);
  if (!base.ok) return { ok: false, reason: base.reason };
  const { svc, profile, reason, visitType, readFailures } = base;
  // The technician rides the identity so a reassignment since the sheet opened is
  // caught at submit (recapVisitIdentityChanged compares it when sent).
  const service = { ...recapServiceIdentity(svc, profile), technicianId: svc.technician_id ?? null };
  if (reason) return { ok: true, eligible: false, reason, visitType, service };

  // A failed assessment read reads as "no confirmed assessment" (Complete stays
  // disabled, and the submit preflight checks the database itself), never as
  // confirmed.
  let assessmentRow = null;
  let assessmentReadFailed = false;
  try {
    assessmentRow = await loadLatestAssessment(svc, knex);
  } catch (err) {
    logger.warn(`[lawn-fast] assessment unavailable for ${serviceId}: ${err?.code || err?.name || 'Error'}`);
    assessmentReadFailed = true;
    readFailures.add('assessment');
  }
  const photos = assessmentRow ? await loadAssessmentPhotos(assessmentRow.id, knex, readFailures) : null;
  const typed = !!profile.findingsType;
  const { unavailable: plannedProductsUnavailable, ...plannedProducts } = await loadPlannedProducts(svc, knex, visitType, readFailures);
  const turfHeightCapture = typed ? false : await loadTurfHeightCapture(technicianId, knex, readFailures);

  return {
    ok: true,
    eligible: true,
    reason: null,
    visitType,
    service,
    visitDate: etCalendarDayOf(svc.scheduled_date),
    // The height-of-cut capture is a lawn-visit feature the typed lawn form
    // never renders (mirrors /complete's turfHeightApplicable).
    turfHeightCapture,
    plannedProducts,
    // Why the planned list is empty when it is empty because a read failed
    // (null otherwise), so the sheet can say defaults could not be loaded.
    plannedProductsUnavailable: plannedProductsUnavailable || null,
    // The assessment must be CONFIRMED before the visit completes; the sheet
    // reads `confirmed` to enable Complete.
    assessment: {
      exists: !!assessmentRow,
      id: assessmentRow?.id ?? null,
      confirmed: assessmentRow?.confirmed_by_tech === true,
      readFailed: assessmentReadFailed,
    },
    // Advisory only: a light photo set is a warning, never a refusal. null when
    // there is no assessment yet (no photos analyzed) or the read failed.
    photoStatus: photos ? evaluatePhotoFloor(photos) : null,
    // Same-spot pairing needs the previous visit's front photo; no shared
    // lookup for lawn photos exists yet, so the context carries none.
    previousFrontPhoto: null,
    // Names of the reads that failed while building this context ([] when none).
    readFailures: [...readFailures],
  };
}

// ── completion preflight ────────────────────────────────────────────────────

// The visit identity a lawn Fast Complete submit must echo back: the `service`
// object of the context. /complete compares it to the locked row
// (recapVisitIdentityChanged) and refuses 409 visit_identity_changed when the
// customer, property, catalog service, type, date, address, callback flag or
// technician changed since the sheet opened. That comparison only checks keys the
// client sent, so the submit must send EVERY key it compares: pest-recap's list
// plus the technician. A key that is null in the context is echoed as null; the
// KEY is required, not a truthy value.
const REQUIRED_IDENTITY_KEYS = Object.freeze([...RECAP_COMPARED_IDENTITY_KEYS, 'technicianId']);
const expectedVisitIncomplete = (expectedVisit) => !expectedVisit || typeof expectedVisit !== 'object'
  || Array.isArray(expectedVisit) || REQUIRED_IDENTITY_KEYS.some((key) => !(key in expectedVisit));

/**
 * Preflight for a /complete body carrying a `lawnFast` block. Returns
 * `{ status, payload }` (the shape preflightLawnAssessmentCompletion returns) to
 * refuse, or null to proceed. Order: gate, visit identity echoed, eligible visit,
 * confirmed assessment. The photo floor is never checked here (advisory; see
 * evaluatePhotoFloor).
 *
 * It runs only on a FRESH completion attempt (the caller's claim.action ===
 * 'proceed'); a replay of a stored result and a resume of a committed completion
 * return before it, so a retry of an already-completed submit under its own
 * idempotency key never reaches it. A visit whose status is already 'completed'
 * is still let through (a fresh key on a completed visit is the main flow's
 * to answer: service_already_completed), the only status allowed.
 *
 * Outcome of every reason lawnFastIneligibleReason can return at submit:
 *   profile_unavailable                          503 (retry, same key; a transient lookup failure)
 *   not_lawn, lawn_re_service, assessment_visit,
 *   project_backed, has_companions, grouped_visit,
 *   terminal_status (cancelled, skipped, no_show,
 *     incomplete, rescheduled)                   409 lawn_fast_not_eligible (terminal)
 *   terminal_status when status is 'completed'   allowed (see above)
 * cancelled / skipped / no_show / a future date are also refused earlier by the
 * main completion flow with their own codes.
 *
 * Status codes are chosen for the shared client hook (completionFailureOutcome):
 * a 409 gate/eligibility/identity refusal is terminal (the tech leaves for the
 * schedule or full form); a 400 missing/unconfirmed assessment is correctable
 * (confirm, then resubmit under a fresh key).
 *
 * An incomplete visit OUTCOME is not judged (nothing to confirm; the quick sheet
 * only submits completed), like the lawn assessment preflight.
 */
async function preflightLawnFastCompletion({ knex = db, svc, lawnAssessmentId = null, isIncompleteVisit = false, expectedVisit = null } = {}) {
  if (isIncompleteVisit) return null;
  if (!featureGates.lawnFastCompleteLive()) {
    return {
      status: 409,
      payload: { error: 'Lawn Fast Complete is not available. Use the full completion form.', code: 'lawn_fast_disabled' },
    };
  }
  if (expectedVisitIncomplete(expectedVisit)) {
    return {
      status: 400,
      payload: {
        error: 'Reopen this visit from the schedule so the sheet can confirm it is still the same visit.',
        code: 'lawn_fast_expected_visit_required',
      },
    };
  }
  const verdict = await resolveLawnFastEligibility(svc.id, knex, { allowStatuses: ['completed'], withVisitType: false });
  if (!verdict.ok) {
    return { status: 404, payload: { error: 'Service not found', code: 'lawn_fast_not_found' } };
  }
  if (verdict.reason === 'profile_unavailable') {
    return {
      status: 503,
      payload: { error: 'Could not verify the completion type for this service. Try again in a moment.', code: 'completion_profile_lookup_failed' },
    };
  }
  if (verdict.reason) {
    return {
      status: 409,
      payload: {
        error: 'This visit cannot be completed on the quick sheet. Use the full completion form.',
        code: 'lawn_fast_not_eligible',
        reason: verdict.reason,
      },
    };
  }
  // lawn_assessments.id is a uuid column: a malformed id is not this visit's
  // assessment (and must not reach the query as a 22P02 500).
  const assessment = isUuid(lawnAssessmentId)
    ? await knex('lawn_assessments')
      .where({ id: lawnAssessmentId, service_id: svc.id, customer_id: svc.customer_id })
      .first('id', 'confirmed_by_tech')
    : null;
  if (!assessment) {
    return {
      status: 400,
      payload: {
        error: 'Analyze and confirm the lawn assessment before completing this visit.',
        code: 'lawn_fast_assessment_required',
      },
    };
  }
  if (assessment.confirmed_by_tech !== true) {
    return {
      status: 400,
      payload: {
        error: 'Confirm the lawn assessment before completing this service so it appears in the customer report.',
        code: 'lawn_assessment_unconfirmed',
        lawnAssessmentId: assessment.id,
      },
    };
  }
  return null;
}

module.exports = {
  PHOTO_FLOOR,
  isUuid,
  BILLING_MODE_UNKNOWN,
  lawnFastVisitType,
  REQUIRED_IDENTITY_KEYS,
  lawnFastIneligibleReason,
  resolveLawnFastEligibility,
  evaluatePhotoFloor,
  buildLawnFastContext,
  buildLawnFastWateringPreview,
  preflightLawnFastCompletion,
};
