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
const shotList = require('./lawn-photo-shots');

const LAWN_CATEGORY = 'lawn_care';
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

// LEGACY advisory photo rule, for an assessment NOT captured under the shot list
// (GATE_LAWN_SHOT_LIST off at capture): at least this many usable photos, one wide
// shot and one close-up (the assessment prompt needs both before confidence can
// exceed low). The zones come from the shared shot definitions: the wide shots are
// the pairable overviews (front, back, side) and the close-ups are the detail
// shots, which for a legacy capture are only close_up and trouble. A capture under
// the shot list uses the shared minimum instead (evaluatePhotoFloor).
const LEGACY_PHOTO_FLOOR = Object.freeze({ minPhotos: 3 });

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
 * whose key is a recurring lawn plan key. Billing per application is how most
 * program customers pay (prod 10-06: 28 of 34 recurring lawn customers), and the
 * plan engine treats it as a membership lane, so a per-application customer's
 * recurring lawn plan visit is 'recurring' like any other; their other visits
 * (callbacks, non-plan keys) stay 'per_application'.
 */
function lawnFastVisitType(profile, billingMode, isCallback = false) {
  // A failed billing read cannot assert any type (a per-application customer would
  // read as recurring), so it is 'unknown' and gets no program defaults.
  if (billingMode === BILLING_MODE_UNKNOWN) return 'unknown';
  const notProgram = billingMode === 'per_application' ? 'per_application' : 'other';
  const billingType = String(profile?.billingType || '').toLowerCase();
  if (billingType === 'one_time' || billingMode === 'one_time') return 'one_time';
  if (isCallback === true || !profile || profile.synthesized) return notProgram;
  if (billingType === 'recurring' && require('./service-report/lawn-program-line').isRecurringLawnPlanKey(profile.serviceKey)) return 'recurring';
  return notProgram;
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
  // The three lawn_care sheets partition the visits: the lawn re-service and Tree & Shrub
  // (which shares the lawn_care category) are decided by their OWN sheets' predicates, and
  // the Waves Assessment visit is its own diagnostic lane. Derived from the completion
  // profile, never the client.
  if (require('./lawn-reservice-fast-context').isLawnReserviceProfile(profile)) return 'lawn_re_service';
  if (require('./tree-shrub-fast-context').isTreeShrubFastProfile(profile)) return 'tree_shrub';
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
  // STRICT profile read: the non-strict resolver swallows a failed availability probe
  // into a synthesized profile that has lost projectBacked / requiresProject /
  // companions, which would approve a project-backed or companion visit. A failed
  // read is a null profile here (profile_unavailable); a SUCCESSFUL read that finds
  // no profile row may still synthesize one, as it always has.
  const base = await resolveEligibility(serviceId, knex, { strict: true });
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
  if (rule.mode === 'water_in') return `Water in ${rule.water_in_inches} in within ${rule.water_in_by_hours} h${rule.water_in_same_day ? ', same day' : ''}`;
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
      // The report freezes this wording at completion, so the preview shows it.
      forCompletion: true,
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

// The hint the technician's photo step shows (client/src/lib/lawn-photo-shots.js
// shotListHint), word for word, so the sheet's warning and the photo step never
// disagree. server/tests/lawn-fast-complete-photo-status.test.js pins the two.
const shotListWarning = (missing) => `Aim for at least ${shotList.SHOT_MINIMUM} photos: front, back or side, canopy close-up, and blade and crown. Still needed: ${missing.join(', ')}. This is a guide only, and Analyze lawn works at any time.`;

const zoneOf = (photo) => String(photo?.zone || '').trim().toLowerCase();

/**
 * Advisory photo status. Never a refusal: `warning` is text for the sheet, null
 * when the minimum is met. `basis` says which rule judged it.
 *   shot list (the assessment was captured under it, or the gate is on and there is
 *   no assessment yet): the SHARED minimum (shared/lawn-photo-shots.json): `missing`
 *   are the shared helper's unmet minimum slots, by label, and the warning is the
 *   photo step's own hint.
 *   legacy: the interim rule (LEGACY_PHOTO_FLOOR), expressed with the shared zone sets.
 */
function evaluatePhotoFloor(photos, { shotList: underShotList = false } = {}) {
  const usable = (Array.isArray(photos) ? photos : []).filter((p) => p && p.quality_gate_passed !== false);
  if (underShotList) {
    const missing = shotList.missingMinimumSlots(usable.map(zoneOf));
    return {
      soft: true,
      basis: 'shot_list',
      count: usable.length,
      minPhotos: shotList.SHOT_MINIMUM,
      meetsFloor: missing.length === 0,
      missing,
      warning: missing.length ? shotListWarning(missing) : null,
    };
  }
  const hasWide = usable.some((p) => shotList.PAIRABLE_SHOT_ZONES.includes(zoneOf(p)));
  const hasCloseUp = usable.some((p) => shotList.NON_PAIRABLE_SHOT_ZONES.includes(zoneOf(p)));
  const missing = [];
  if (usable.length < LEGACY_PHOTO_FLOOR.minPhotos) missing.push('photos');
  if (!hasWide) missing.push('wide');
  if (!hasCloseUp) missing.push('close_up');
  const parts = [];
  if (missing.includes('photos')) parts.push(`${usable.length} of ${LEGACY_PHOTO_FLOOR.minPhotos} photos`);
  if (missing.includes('wide')) parts.push('no wide shot');
  if (missing.includes('close_up')) parts.push('no close-up');
  return {
    soft: true,
    basis: 'legacy',
    count: usable.length,
    minPhotos: LEGACY_PHOTO_FLOOR.minPhotos,
    meetsFloor: missing.length === 0,
    missing,
    warning: missing.length ? `Photo set is light (${parts.join(', ')}). You can still finish; more photos make a stronger read.` : null,
  };
}

// Whether the assessment was captured under the shot list: the marker the assess
// route stores beside each photo (lawn_assessments.photos[].photoVocabulary), or,
// for a row captured before the marker existed, the shared zone-vocabulary
// fallback. With no assessment yet, the gate decides.
function capturedUnderShotListRow(assessmentRow, photos) {
  if (!assessmentRow) return featureGates.gateEnvValue('GATE_LAWN_SHOT_LIST');
  let stored = assessmentRow.photos;
  if (typeof stored === 'string') {
    try { stored = JSON.parse(stored); } catch { stored = null; }
  }
  if (Array.isArray(stored) && stored.some((meta) => meta?.photoVocabulary === shotList.PHOTO_VOCABULARY)) return true;
  return shotList.capturedUnderShotList((Array.isArray(photos) ? photos : []).map(zoneOf));
}

// The context's photoStatus. No assessment yet: with the shot list live, the shared
// minimum as the target (nothing captured); with it off, null (as before). A failed
// photo read on an existing assessment reads as no status (recorded upstream).
function photoStatusFor(assessmentRow, photos) {
  if (!assessmentRow) return featureGates.gateEnvValue('GATE_LAWN_SHOT_LIST') ? evaluatePhotoFloor([], { shotList: true }) : null;
  if (!photos) return null;
  return evaluatePhotoFloor(photos, { shotList: capturedUnderShotListRow(assessmentRow, photos) });
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
// Whether the customer report would accept this assessment for the visit. The
// report resolves its lawn assessment through the property-history resolver when
// GATE_LAWN_PROPERTY_HISTORY is on: installedForVisit picks the visit's installed
// row (resolveVisit rejects a link whose property differs from the visit's), and
// resolveLawnAssessmentAndHistory then requires historyForAssessment's current row
// to be that same assessment (property scope: a NULL property on either side, a
// customer with one property, a recorded move, all decided there). The SAME two
// calls decide it here, so an assessment captured before the office moved the visit
// to another property is not a usable confirmed assessment. With the gate off the
// report does no property check, and neither does this. Reads throw (callers fail
// closed).
async function assessmentUsableForReport(svc, assessmentRow, knex) {
  if (!featureGates.gateEnvValue('GATE_LAWN_PROPERTY_HISTORY')) return true;
  const history = require('./lawn-assessment-history');
  const installed = await history.installedForVisit({ customerId: svc.customer_id, serviceId: svc.id }, knex);
  if (!installed || String(installed.id) !== String(assessmentRow.id)) return false;
  const resolved = await history.historyForAssessment(installed, { knex });
  return !!resolved.current && String(resolved.current.id) === String(assessmentRow.id);
}

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

// GATE_LAWN_SPOT_RULES: the rate the program approved for a line the plan gave no rate (a
// spot row: the plan sizes none), from its staged protocol row (`ratePer1000` / `rateUnit`,
// the values v13SpotReference prints), so the sheet figures a spot amount from it rather
// than the catalog default. `{}` when the gate is off, the plan already carries a rate, the
// row has none, or the row states a concentration (a surfactant figures nothing).
function programRateFor(item, programRows) {
  const row = programRows?.get(String(item.product.id));
  if (!row || item.mix?.ratePer1000 != null || row.gates?.concentration) return {};
  return Number(row.ratePer1000) > 0 && row.rateUnit ? { ratePer1000: Number(row.ratePer1000), rateUnit: row.rateUnit } : {};
}

// GATE_LAWN_TROUBLE_AREAS: the places the yearly limits are judged at (lawn-trouble-areas.js), or null (gate off: every
// decision is the lawn-wide one, as before).
const limitPlaces = () => (featureGates.lawnTroubleAreasLive() ? require('./lawn-trouble-areas').PLACE_IDS : null);

// With the treatment guide live, a weed mix whose limit read failed carries the guide's one wording
// (its products are released to the search, which the note names). The spot-rules note stands without it.
const unreadableWeedNote = (weedMix) => (featureGates.lawnTreatmentGuideLive() && weedMix.mode === 'unavailable'
  ? { ...weedMix, note: require('./lawn-treatment-guide').UNREADABLE_NOTE } : weedMix);

// GATE_LAWN_SPOT_RULES: the weed add-ons as one cap-aware entry (see lawn-weed-mix.js), as
// `{ weedMix }` to spread into plannedProducts, or `{}` (gate off, or no weed group). Its
// limit read is caught inside (mode 'unavailable'); only a defect lands in the catch here.
async function loadWeedMix({ addOns, svc, plan, knex, readFailures }) {
  if (!featureGates.lawnSpotRulesLive()) return {};
  try {
    const weedMix = await require('./lawn-weed-mix').buildWeedMix({ addOns, svc, structured: plan?.protocol?.structured, knex, places: limitPlaces() });
    return weedMix ? { weedMix: unreadableWeedNote(weedMix) } : {};
  } catch (err) {
    logger.warn(`[lawn-fast] weed mix unavailable for ${svc.id}: ${err?.code || err?.name || 'Error'}`);
    readFailures.add('weed_mix');
    return {};
  }
}

// GATE_LAWN_TREATMENT_GUIDE: the chinch bug product for this lawn, as `{ chinch }` to spread into
// plannedProducts (the standing "Chinch bugs found" entry, every month) or `{}` (gate off, no
// staged chinch rows). `chinch.item` is the add-on the tap opens, shaped like a plan add-on: the
// month's own add-on when the plan holds the product, else built from the program's staged row
// (an off-plan product the sheet records like any catalog product the technician adds), and only
// while the plan is eligible for the visit (the same rule the add-ons are built behind).
async function loadChinch({ loaded, sheet, svc, knex, readFailures }) {
  // Only where the plan offers anything for this visit: an ineligible plan (no program applies, the
  // profile does not match the property, the protocol is not the visit's) offers no chinch product.
  if (!featureGates.lawnTreatmentGuideLive() || !loaded.eligible) return {};
  try {
    const chinch = await chinchOffer({ svc, structured: loaded.plan?.protocol?.structured, sheetAddOns: sheet.addOns, knex, places: limitPlaces() });
    return chinch ? { chinch } : {};
  } catch (err) {
    logger.warn(`[lawn-fast] chinch product unavailable for ${svc.id}: ${err?.code || err?.name || 'Error'}`);
    readFailures.add('treatment_guide');
    return {};
  }
}

// GATE_LAWN_TREATMENT_GUIDE: the month's add-ons a guide card may own (the fungicide, the caterpillar
// and the wetting-agent rows, by what their staged rows say), as `{ guidedProductIds }` or `{}`. The
// sheet holds their taps until the fresh guide has answered, so a card never finds its product
// already on the sheet. Pure; no limit read.
function guidedProductIds(loaded, sheet) {
  if (!featureGates.lawnTreatmentGuideLive() || !loaded.eligible) return {};
  const guide = require('./lawn-treatment-guide');
  const rows = require('./waveguard-plan-engine').v13ProtocolRows(loaded.plan?.protocol?.structured);
  const candidates = loaded.addOns.map((raw, i) => ({ raw, item: sheet.addOns[i] }));
  const picks = guide.pickAddOns(candidates, rows);
  return {
    guidedProductIds: Object.values(picks).filter(Boolean).map((pick) => pick.item.productId),
    // Every take-all fungicide of the month (a pick or not): the sheet never lists it with the plain add-ons.
    takeAllProductIds: guide.takeAllAddOns(candidates, rows).map((candidate) => candidate.item.productId),
  };
}

/**
 * The month's take-all fungicide product ids for a visit, as a Set of lower-case ids (empty when the visit has no plan): the same
 * staged-row rule the guide answer's `takeAllProductIds` uses (`takeAllAddOns`). The completion asks it before it records a
 * `take_all` trouble area, so the sheet's hint alone never creates one.
 */
async function takeAllProductIdsFor(svc, knex = db) {
  return (await troubleTypeIdsFor(svc, knex)).takeAll;
}

/**
 * What the completion confirms a trouble-type hint against, as `{ takeAll, chinch }` (Sets of lower-case product ids): the month's take-all
 * fungicide rows (takeAllAddOns) and the chinch ladder's rungs (the staged-row rule resolveChinch uses). Empty for a visit with no plan.
 */
async function troubleTypeIdsFor(svc, knex = db) {
  const empty = { takeAll: new Set(), chinch: new Set() };
  const loaded = await loadPlan(svc, knex);
  if (!loaded?.eligible) return empty;
  const guide = require('./lawn-treatment-guide');
  const sheet = await sheetPlanned(loaded, knex);
  const structured = loaded.plan?.protocol?.structured;
  const rows = require('./waveguard-plan-engine').v13ProtocolRows(structured);
  const candidates = loaded.addOns.map((raw, i) => ({ raw, item: sheet.addOns[i] }));
  const lower = (id) => String(id).toLowerCase();
  return {
    takeAll: new Set(guide.takeAllAddOns(candidates, rows).map((candidate) => lower(candidate.item.productId))),
    chinch: new Set((await guide.chinchLadderIds({ structured, knex })).map(lower)),
  };
}

async function chinchOffer({ svc, structured, sheetAddOns, knex, places = null }) {
  const guide = require('./lawn-treatment-guide');
  const found = await guide.resolveChinch({ svc, structured, knex, places });
  if (!found) return null;
  // One item per product, however many places offer it.
  const items = new Map();
  const itemFor = async (f) => {
    const key = String(f.productId).toLowerCase();
    if (items.has(key)) return items.get(key);
    const planned = sheetAddOns.find((addOn) => String(addOn.productId).toLowerCase() === key);
    let item = planned;
    if (!item) {
      const catalog = (await loadCatalogRows([f.productId], knex)).get(f.productId) || null;
      const entry = productRuleEntry(f.productId, catalog);
      const staged = f.stagedRow;
      const rate = Number(staged.rate_per_1000);
      const engine = require('./waveguard-plan-engine');
      const gates = typeof staged.gates === 'string' ? JSON.parse(staged.gates) : staged.gates;
      item = {
        productId: f.productId,
        name: f.name,
        applicationMethod: 'spot_treatment',
        amount: null,
        amountUnit: null,
        treatedSqft: null,
        areaUnit: null,
        ratePer1000: rate > 0 ? rate : null,
        rateUnit: rate > 0 ? staged.rate_unit || null : null,
        approvedForReport: entry.approvedForReport,
        wateringRule: entry.rule,
        wateringSummary: entry.ruleSummary,
        mowHoldDays: entry.mowHoldDays,
        line: null,
        substituteFor: null,
        gateNotes: typeof engine.v13GateNotes === 'function' ? engine.v13GateNotes(gates, { monthNumber: visitMonthOf(svc) }).map((note) => note.text) : [],
      };
    }
    items.set(key, item);
    return item;
  };
  // The offer for one answer of the ladder: the add-on its tap opens (the month's own when the plan holds the product,
  // else built from the program's staged row: an off-plan product the sheet records like any catalog product the
  // technician adds), and why.
  const offerOf = async (f) => {
    const { rungIds, blockedIds, unreadableIds } = f;
    // chinchOnlyIds exists only with the places gate live (see lawn-treatment-guide chinchOnlyIdsOf).
    const only = f.chinchOnlyIds ? { chinchOnlyIds: f.chinchOnlyIds } : {};
    if (!f.productId) return { item: null, note: f.note, rungIds, blockedIds, unreadableIds, ...only };
    return { item: await itemFor(f), note: f.note, rungIds, blockedIds, unreadableIds, ...only };
  };
  const top = await offerOf(found);
  if (!found.byPlace) return top;
  const byPlace = {};
  for (const [place, answer] of Object.entries(found.byPlace)) byPlace[place] = await offerOf(answer);
  return { ...top, byPlace };
}

// The visit's month (1-12, ET).
const visitMonthOf = (svc) => Number(String(etCalendarDayOf(svc.scheduled_date) || '').slice(5, 7)) || null;

// The plan's lists for a recurring visit, raw: `{ plan, items, addOns }` (the completion defaults'
// planned rows and opt-in rows that name a product), or null when the completion-defaults gates are
// off. A failed plan read throws.
async function loadPlan(svc, knex) {
  if (!require('./lawn-completion-defaults').lawnCompletionDefaultsEnabled()) return null;
  const plan = await require('./waveguard-plan-engine').buildPlanForService(svc.id, { db: knex, includeCompletionDefaults: true });
  const withProduct = (list) => (Array.isArray(list) ? list : []).filter((item) => item?.product?.id);
  return {
    plan,
    // The plan's own eligibility for this visit: the rule behind the items and the add-ons.
    eligible: plan?.completionDefaults?.eligible === true,
    items: withProduct(plan?.completionDefaults?.items),
    addOns: withProduct(plan?.completionDefaults?.addOns),
  };
}

// The plan's lists as the sheet reads them: `{ items, addOns }`, in the plan's order.
async function sheetPlanned({ plan, items, addOns }, knex) {
  const rows = await loadCatalogRows([...items, ...addOns].map((item) => String(item.product.id)), knex);
  const programRows = featureGates.lawnSpotRulesLive() ? require('./waveguard-plan-engine').v13ProtocolRows(plan?.protocol?.structured) : null;
  const plannedItem = (item) => {
    const entry = productRuleEntry(String(item.product.id), rows.get(String(item.product.id)) || null);
    return {
      productId: item.product.id,
      name: item.product.name || entry.name,
      applicationMethod: item.applicationMethod || null,
      amount: item.mix?.amount ?? null,
      amountUnit: item.mix?.amountUnit ?? null,
      // The treated area and planned rate exactly as the full form's completion defaults
      // prefill them (lawnPlanSelections reads mix.treatedSqft in square feet and
      // mix.ratePer1000 / mix.rateUnit): the same plan item, nothing computed here. null
      // when the plan carries none (never invented); /complete then asks for the area.
      treatedSqft: item.mix?.treatedSqft ?? null,
      areaUnit: item.mix?.treatedSqft != null ? 'sqft' : null,
      ratePer1000: item.mix?.ratePer1000 ?? null,
      rateUnit: item.mix?.rateUnit ?? null,
      ...programRateFor(item, programRows),
      approvedForReport: entry.approvedForReport,
      wateringRule: entry.rule,
      wateringSummary: entry.ruleSummary,
      mowHoldDays: entry.mowHoldDays,
    };
  };
  return {
    items: items.map(plannedItem),
    addOns: addOns.map((item) => ({
      ...plannedItem(item),
      line: typeof item.raw === 'string' && item.raw.trim() ? item.raw.trim() : null,
      substituteFor: item.substitution?.originalProductName || null,
      gateNotes: (Array.isArray(item.gateNotes) ? item.gateNotes : []).map((note) => note?.text).filter((text) => typeof text === 'string' && text),
    })),
  };
}

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
  const empty = (unavailable = null) => ({ source: null, items: [], addOns: [], unavailable });
  if (visitType === 'unknown') return empty('billing_mode_lookup_failed');
  // buildPlanForService keys the program off the CUSTOMER (tier / billing mode),
  // so it can return the seasonal recipe for a member's one-time or
  // per-application appointment. Only a recurring program appointment gets it.
  if (visitType !== 'recurring') return empty();
  try {
    const loaded = await loadPlan(svc, knex);
    if (!loaded) return empty();
    const sheet = await sheetPlanned(loaded, knex);
    const weed = await loadWeedMix({ addOns: loaded.addOns, svc, plan: loaded.plan, knex, readFailures });
    const chinch = await loadChinch({ loaded, sheet, svc, knex, readFailures });
    return {
      source: 'plan',
      unavailable: null,
      items: sheet.items,
      // The visit's month (1-12, ET), for the add-on row's title.
      month: visitMonthOf(svc),
      // The window's opt-in products as the same plan built them (the visit's
      // substitute, the plan's mix and method), offered as one-tap add-ons, with
      // the protocol's own words for when they go down and the plan's gate notes.
      addOns: sheet.addOns,
      ...weed,
      ...chinch,
      ...(readFailures.has('treatment_guide') ? {} : guidedProductIds(loaded, sheet)),
      // GATE_LAWN_TROUBLE_AREAS: what the places' limit read needs (stripped from the payload by the context).
      ...(featureGates.lawnTroubleAreasLive() ? { troubleSeed: troubleSeedOf({ loaded, sheet, weed, chinch }) } : {}),
    };
  } catch (err) {
    logger.warn(`[lawn-fast] planned products unavailable for ${svc.id}: ${err?.code || err?.name || 'Error'}`);
    readFailures.add('planned_products');
    return empty('planned_products_lookup_failed');
  }
}

// GATE_LAWN_TROUBLE_AREAS: the products whose limits the context reads per place (`blocked`), and the staged rows the
// plan's limit reader needs. The weed group and the chinch rungs are left out: their decisions carry a place of their own
// (weedMix.byPlace, chinch.byPlace).
function troubleSeedOf({ loaded, sheet, weed, chinch }) {
  const decided = new Set([
    ...(weed.weedMix?.groupProductIds || []),
    ...(chinch.chinch?.rungIds || []),
  ].map((id) => String(id).toLowerCase()));
  const products = [...sheet.items, ...sheet.addOns]
    .filter((item) => item.productId && !decided.has(String(item.productId).toLowerCase()))
    .map((item) => ({ id: item.productId, name: item.name }));
  return { products, rows: require('./waveguard-plan-engine').v13ProtocolRows(loaded.plan?.protocol?.structured) };
}

// The height-of-cut capture is optional: a failed flag read hides it (false), the
// less permissive side, and is recorded. The shared isUserFeatureEnabled swallows
// its own query failure into the default, so the same predicate is read here to
// keep the failure visible.
async function loadTurfHeightCapture(technicianId, knex, readFailures) {
  if (!isUuid(technicianId)) return false;
  try {
    const row = await knex('user_feature_flags').where({ user_id: technicianId, flag_key: 'turf-height-capture' }).first('enabled');
    return row ? !!row.enabled : false;
  } catch {
    readFailures.add('turf_height_flag');
    return false;
  }
}

// The visit's latest assessment and whether Fast Complete may count it. A failed
// assessment read reads as "no confirmed assessment" (Complete stays disabled, and
// the submit preflight checks the database itself), never as confirmed. A confirmed
// assessment the report would reject (captured for the visit's former property) is
// unusable with the SAME verdict the submit enforces; a failed property check reads
// as unusable too.
async function loadAssessmentState(svc, knex, readFailures) {
  let assessmentRow = null;
  let assessmentReadFailed = false;
  let assessmentUnusable = null;
  try {
    assessmentRow = await loadLatestAssessment(svc, knex);
  } catch (err) {
    logger.warn(`[lawn-fast] assessment unavailable for ${svc.id}: ${err?.code || err?.name || 'Error'}`);
    assessmentReadFailed = true;
    readFailures.add('assessment');
  }
  if (assessmentRow && assessmentRow.confirmed_by_tech === true) {
    try {
      if (!(await assessmentUsableForReport(svc, assessmentRow, knex))) assessmentUnusable = 'property_scope';
    } catch (err) {
      logger.warn(`[lawn-fast] assessment property check unavailable for ${svc.id}: ${err?.code || err?.name || 'Error'}`);
      assessmentUnusable = 'property_check_failed';
      readFailures.add('assessment_property_check');
    }
  }
  return { assessmentRow, assessmentReadFailed, assessmentUnusable };
}

// GATE_LAWN_RAINFAST_WATCH (P31): a helpful extra for the technician. When the
// PRIOR lawn visit at this property recorded a rainfast retreat-check, the
// technician sees one fixed line on the sheet. The customer sentence promises
// nothing, so nothing depends on this line being shown (it is absent when the
// property-history gate is off, by design). The prior visit comes from the property-scoped history
// (the same resolver the completion defaults and the report copy use; it needs
// GATE_LAWN_PROPERTY_HISTORY, as the visit memory's own prior does), and its
// memory is read from THAT visit's record for THIS customer. Advisory and fail
// closed: any miss, a failed read or an unproven property is no line, and never
// a refusal or a read failure the sheet has to report.
async function loadReCheckNote(svc, knex) {
  if (typeof featureGates.lawnRainfastWatchLive !== 'function' || !featureGates.lawnRainfastWatchLive()
    || !featureGates.gateEnvValue('GATE_LAWN_PROPERTY_HISTORY')) return undefined;
  try {
    const history = require('./lawn-assessment-history');
    const prior = await history.historyBeforeVisit({
      customerId: svc.customer_id, scheduledService: svc, throughVisitDate: etCalendarDayOf(svc.scheduled_date),
    }, knex);
    const previous = prior?.previous;
    const recordId = previous?.history_record_id || previous?.service_record_id || null;
    if (!prior?.scope?.propertyId || !previous?.id || !recordId) return null;
    const row = await knex('service_records').where({ id: recordId, customer_id: svc.customer_id }).first('structured_notes');
    const { storedVisitMemoryFor } = require('./service-report/lawn-visit-memory');
    const line = require('./service-report/lawn-rainfast-watch').reCheckLine(storedVisitMemoryFor(row?.structured_notes, String(previous.id))?.retreatCheck);
    return line ? { line } : null;
  } catch (err) {
    logger.warn(`[lawn-fast] re-check note unavailable for ${svc.id}: ${err?.code || err?.name || 'Error'}`);
    return null;
  }
}

// GATE_LAWN_REPORT_FACTS: the keys the sheet reads to record what the report facts need. Built here, outside the
// context builder's decision path, as a small table of key -> live reader; a key exists only while its reader is live
// (off = byte-identical). `lawnReportTies`: the sheet records the standing chinch tap as a find only while the report
// ties are live. `lawnReportFacts`: the sheet names the spot rows whose area it recorded (lawnFast.spotAreas).
const REPORT_FACTS_CONTEXT_KEYS = Object.freeze([
  ['lawnReportTies', () => featureGates.lawnReportTiesLive()],
  ['lawnReportFacts', () => featureGates.lawnReportFactsLive()],
]);
function reportFactsContextKeys() {
  return Object.fromEntries(REPORT_FACTS_CONTEXT_KEYS.filter(([, live]) => live()).map(([key]) => [key, true]));
}

/**
 * The sheet's context for one scheduled service. `{ ok: false, reason }` for a
 * missing visit; an ineligible visit answers `eligible: false` with the reason
 * and the visit identity and skips the heavier reads.
 */
async function buildLawnFastContext(serviceId, { knex = db, technicianId = null, productIds } = {}) {
  const base = await resolveLawnFastEligibility(serviceId, knex);
  if (!base.ok) return { ok: false, reason: base.reason };
  const { svc, profile, reason, visitType, readFailures } = base;
  // The technician rides the identity so a reassignment since the sheet opened is
  // caught at submit (recapVisitIdentityChanged compares it when sent).
  const service = { ...recapServiceIdentity(svc, profile), technicianId: svc.technician_id ?? null };
  if (reason) return { ok: true, eligible: false, reason, visitType, service };

  const { assessmentRow, assessmentReadFailed, assessmentUnusable } = await loadAssessmentState(svc, knex, readFailures);
  const photos = assessmentRow ? await loadAssessmentPhotos(assessmentRow.id, knex, readFailures) : null;
  const typed = !!profile.findingsType;
  const { unavailable: plannedProductsUnavailable, troubleSeed, ...plannedProducts } = await loadPlannedProducts(svc, knex, visitType, readFailures);
  const turfHeightCapture = typed ? false : await loadTurfHeightCapture(technicianId, knex, readFailures);
  const reCheck = await loadReCheckNote(svc, knex);

  return {
    ok: true,
    eligible: true,
    reason: null,
    visitType,
    service,
    visitDate: etCalendarDayOf(svc.scheduled_date),
    // The completion profile's typed findings form (null when it has none). A one-time lawn
    // visit carries 'one_time_lawn_treatment', and /complete then requires lawn_condition.
    findingsType: profile.findingsType || null,
    // The height-of-cut capture is a lawn-visit feature the typed lawn form
    // never renders (mirrors /complete's turfHeightApplicable).
    turfHeightCapture,
    plannedProducts,
    // GATE_LAWN_SPOT_RULES: the sheet asks for a spot row's area (and holds Complete without
    // one). The key exists only while the gate is live, so gate off is byte-identical.
    ...(featureGates.lawnSpotRulesLive() ? { spotRules: true } : {}),
    // GATE_LAWN_TROUBLE_AREAS: the closed list of places, the lawn's known trouble areas and the products a limit closes
    // at a place (lawn-trouble-areas.js). The key exists only while the gate is live, so gate off is byte-identical.
    ...await require('./lawn-trouble-areas').buildContextBlock({ knex, svc, seed: troubleSeed, readFailures, extraIds: productIds }),
    // GATE_LAWN_TREATMENT_GUIDE: the sheet reads the "Suggested from this lawn" cards once the
    // assessment is confirmed (the treatment-guide route). Only a visit with a plan has any, and
    // the key exists only while the gate is live, so gate off is byte-identical.
    // A visit whose program rows could not be read has no guide at all (the read failure is named), rather
    // than a guide that claims a clean "no chinch rows staged".
    ...(featureGates.lawnTreatmentGuideLive() && plannedProducts.source === 'plan' && !readFailures.has('treatment_guide') ? { treatmentGuide: true } : {}),
    // GATE_LAWN_REPORT_FACTS context keys (the standing chinch find, the recorded spot areas), present only while live.
    ...reportFactsContextKeys(),
    // Why the planned list is empty when it is empty because a read failed
    // (null otherwise), so the sheet can say defaults could not be loaded.
    plannedProductsUnavailable: plannedProductsUnavailable || null,
    // The application methods a product row may take, the lawn re-service
    // sheet's own list ({ value, label, common, requiresSqft }).
    methods: require('./lawn-reservice-fast-context').lawnMethodChoices(),
    // The assessment must be CONFIRMED before the visit completes; the sheet
    // reads `confirmed` to enable Complete.
    assessment: {
      exists: !!assessmentRow,
      id: assessmentRow?.id ?? null,
      confirmed: assessmentRow?.confirmed_by_tech === true && !assessmentUnusable,
      // Why a confirmed assessment is not usable (null otherwise): 'property_scope' =
      // the report would reject it for this visit's property; the tech analyzes again.
      unusableReason: assessmentUnusable,
      readFailed: assessmentReadFailed,
    },
    // Advisory only: a light photo set is a warning, never a refusal. null when the
    // photo read failed, or there is no assessment yet and the shot list is off.
    photoStatus: photoStatusFor(assessmentRow, photos),
    // Same-spot pairing needs the previous visit's front photo; no shared
    // lookup for lawn photos exists yet, so the context carries none.
    previousFrontPhoto: null,
    // P31: the prior visit's rainfast re-check line, or null. The key exists only
    // while GATE_LAWN_RAINFAST_WATCH is live, so gate off is byte-identical.
    ...(reCheck !== undefined ? { reCheck } : {}),
    // Names of the reads that failed while building this context ([] when none).
    readFailures: [...readFailures],
  };
}

// ── treatment guide ─────────────────────────────────────────────────────────

// GATE_LAWN_TROUBLE_AREAS: the guide's per-place blocks with the products the sheet names (Search-added rows outside the month's recipe)
// read per place too, in the context's shape; an entry the guide already read stands. `undefined` while the gate is off or nothing was read.
async function withSearchedProducts({ svc, knex, rows, ids, known }) {
  if (!featureGates.lawnTroubleAreasLive() || !Array.isArray(ids) || !ids.length) return known;
  const extra = await require('./lawn-trouble-areas').searchedPlaceBlocks({ knex, svc, rows, ids });
  return { ...extra, ...(known || {}) };
}

// GATE_LAWN_TROUBLE_AREAS: the lawn's active take_all areas (a stored area is server-confirmed; a cleared one is not active), less the
// places where the month's take-all product is closed by a limit. `[]` while the gate is off, as the card always had it; a failed read is
// `[]` too (the check-only card, never a guess).
async function takeAllAreasOn({ svc, knex, offers }) {
  if (!featureGates.lawnTroubleAreasLive()) return [];
  try {
    const productId = offers?.fungus?.takeAll ? offers.fungus.item.productId : null;
    const closed = (offers?.placeBlocked || {})[productId] || {};
    return (await require('./lawn-trouble-areas').loadActive(knex, svc.property_id)).filter((area) => area.type === 'take_all' && !closed[area.place]);
  } catch (err) {
    logger.warn(`[lawn-fast] take-all areas unavailable for ${svc.id}: ${err?.code || err?.name || 'Error'}`);
    return [];
  }
}

/**
 * GET /:serviceId/lawn-fast/treatment-guide?assessmentId=: the "Suggested from this lawn" cards for
 * the visit's CONFIRMED assessment (GATE_LAWN_TREATMENT_GUIDE, lawn-treatment-guide.js). The sheet
 * asks once the technician confirms; the plan is read again here so the cards name the same add-ons
 * the sheet lists, each one's limits read fresh. Read-only; nothing is added or recorded.
 * `{ ok: true, v: 1, assessmentId, cards, weedMix, takeAllProductIds }` (`takeAllProductIds` are the plan's take-all fungicide rows read now, which the
 * sheet prefers to the context's; `weedMix` is the Weed spots decision read fresh, the
 * sheet's one source for the weed entry, the weed card and the search exclusion; null when the month has no
 * weed group), `blockedProductIds` (the governed products the fresh read kept out because of a limit, a hold or
 * a failed limit read: see lawn-treatment-guide.blockedProductIds), and `chinch` (the standing chinch tap's decision read fresh the same way: `{ item, note }`, or null
 * when the protocol stages no chinch product), or `{ ok: false, reason }`: disabled, invalid_assessment,
 * not_found, not_eligible, not_confirmed, not_usable. A plan or limit read that fails throws (a 500:
 * the sheet then shows no cards and works as before).
 */
async function buildLawnTreatmentGuide({ serviceId, assessmentId, knex = db, productIds = null }) {
  if (!featureGates.lawnTreatmentGuideLive()) return { ok: false, reason: 'disabled' };
  if (!isUuid(assessmentId)) return { ok: false, reason: 'invalid_assessment' };
  const base = await resolveLawnFastEligibility(serviceId, knex);
  if (!base.ok) return { ok: false, reason: base.reason };
  const { svc, reason, visitType, readFailures } = base;
  if (reason) return { ok: false, reason: 'not_eligible' };
  const assessment = await knex('lawn_assessments').where({ id: assessmentId, service_id: svc.id, customer_id: svc.customer_id }).first();
  if (!assessment) return { ok: false, reason: 'not_found' };
  if (assessment.confirmed_by_tech !== true) return { ok: false, reason: 'not_confirmed' };
  if (!(await assessmentUsableForReport(svc, assessment, knex))) return { ok: false, reason: 'not_usable' };
  const guide = require('./lawn-treatment-guide');
  const result = (cards, weedMix = null, chinch = null, ids = {}) => ({
    ok: true, v: 1, assessmentId: assessment.id, cards, weedMix, chinch, blockedProductIds: ids.blocked || [], unreadableProductIds: ids.unreadable || [], unreadableNote: guide.UNREADABLE_NOTE,
    // The take-all fungicide rows of the plan as read now (an assignment or a substitution may have changed them since the sheet opened).
    takeAllProductIds: ids.takeAll || [],
    // GATE_LAWN_TROUBLE_AREAS: the per-place blocks this read found (the key exists only while the gate is live).
    ...(ids.placeBlocked ? { placeBlocked: ids.placeBlocked } : {}),
  });
  // Only a recurring program visit has a plan, and so any product to suggest.
  const loaded = visitType === 'recurring' ? await loadPlan(svc, knex) : null;
  if (!loaded) return result([]);

  const structured = loaded.plan?.protocol?.structured;
  const sheet = await sheetPlanned(loaded, knex);
  const rows = require('./waveguard-plan-engine').v13ProtocolRows(structured);
  const weedMix = (await loadWeedMix({ addOns: loaded.addOns, svc, plan: loaded.plan, knex, readFailures })).weedMix || null;
  // loadWeedMix catches a defect into readFailures for the context's sake; here that would read as "no weed group".
  if (readFailures.has('weed_mix')) throw new Error('weed mix unavailable');
  const candidates = loaded.addOns.map((raw, i) => ({ raw, item: sheet.addOns[i] }));
  const [offers, chinch] = await Promise.all([
    guide.addOnOffers({ candidates, rows, svc, knex, places: limitPlaces() }),
    loaded.eligible ? chinchOffer({ svc, structured, sheetAddOns: sheet.addOns, knex, places: limitPlaces() }) : null,
  ]);
  // A read that throws fails the request (the sheet then follows the context's decisions); only a
  // missing run row, which a legacy assessment legitimately has, reads as no run.
  const run = (await require('./lawn-visit-runs').loadRun(assessment.id, knex)) || null;
  return result(guide.buildCards({
    signals: guide.signalsFromAssessment(assessment, run),
    month: visitMonthOf(svc),
    offers: { ...offers, chinch },
    weeds: guide.weedOffer(weedMix, sheet.addOns),
    // GATE_LAWN_TROUBLE_AREAS: the lawn's take-all areas on file (server-confirmed, active) at places the take-all product is not closed at.
    troubleAreas: await takeAllAreasOn({ svc, knex, offers }),
  }), weedMix, chinch, { blocked: guide.blockedProductIds({ offers, chinch, weedMix }), unreadable: guide.unreadableProductIds({ offers, chinch, weedMix }), takeAll: guide.takeAllAddOns(candidates, rows).map((candidate) => candidate.item.productId), placeBlocked: await withSearchedProducts({ svc, knex, rows, ids: productIds, known: offers.placeBlocked }) });
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

const lawnFastEchoMissing = (lawnFast) => !lawnFast || typeof lawnFast !== 'object' || Array.isArray(lawnFast) || !('visitType' in lawnFast);

// The refusal for a visit type that cannot be confirmed or has changed since the sheet
// opened (see preflightLawnFastCompletion), or null.
function visitTypeRefusal(verdict, lawnFast) {
  if (verdict.readFailures.has('billing_mode')) {
    return {
      status: 503,
      payload: { error: 'Could not verify the visit type for this service. Try again in a moment.', code: 'lawn_fast_visit_type_unavailable' },
    };
  }
  if (lawnFast.visitType !== verdict.visitType) {
    return {
      status: 409,
      payload: {
        error: 'This visit changed since it was opened. Close and reopen it to review the current plan before completing.',
        code: 'visit_identity_changed',
        reason: 'visit_type_changed',
      },
    };
  }
  return null;
}

/**
 * Preflight for a /complete body carrying a `lawnFast` block. Returns
 * `{ status, payload }` (the shape preflightLawnAssessmentCompletion returns) to
 * refuse, or null to proceed. Order: gate (always, first), then an incomplete outcome
 * is exempt from the rest; otherwise visit identity echoed, visit type echoed,
 * eligible visit, visit type recomputed, confirmed assessment. The same visit-type
 * verdict is enforced again under the completion lock
 * (assertLawnFastVisitTypeUnderLock); that locked check is the authority. The photo floor is never checked here (advisory; see
 * evaluatePhotoFloor).
 *
 * It runs only on a FRESH completion attempt (the caller's claim.action ===
 * 'proceed'); a replay of a stored result and a resume of a committed completion
 * return before it, so a retry of an already-completed submit under its own
 * idempotency key never reaches it. A visit whose status is already 'completed'
 * is still let through (a fresh key on a completed visit is the main flow's
 * to answer: service_already_completed), the only status allowed.
 *
 * The submit's `lawnFast` block must echo the context's `visitType` (the sheet must
 * send `lawnFast: { visitType }` from the context it opened with): the preflight
 * recomputes it with the same strict reads and compares.
 *   block or visitType key missing                400 lawn_fast_expected_visit_required (correctable)
 *   billing read failed at submit                  503 lawn_fast_visit_type_unavailable (retry, same key)
 *   type changed since open (or echoed 'unknown')  409 visit_identity_changed, reason
 *                                                  visit_type_changed (terminal: the main flow's own
 *                                                  changed-visit code, so the hook treats it the same)
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
 * With GATE_LAWN_TROUBLE_AREAS live the last check is the places: every spot-treatment row carries a place (400
 * lawn_place_required / lawn_place_invalid) that the yearly limits allow (400 lawn_place_limit), by the same limit reader
 * the sheet followed (lawn-trouble-areas.js preflightPlaces).
 *
 * An incomplete visit OUTCOME is not judged (nothing to confirm; the quick sheet
 * only submits completed), like the lawn assessment preflight.
 */
async function preflightLawnFastCompletion({ knex = db, svc, lawnAssessmentId = null, isIncompleteVisit = false, expectedVisit = null, lawnFast = null, products = null } = {}) {
  // The dark gate comes FIRST: any /complete carrying a lawnFast block is refused while
  // the gate is off, whatever its outcome.
  if (!featureGates.lawnFastCompleteLive()) {
    return {
      status: 409,
      payload: { error: 'Lawn Fast Complete is not available. Use the full completion form.', code: 'lawn_fast_disabled' },
    };
  }
  // An incomplete OUTCOME records no products and has no assessment to confirm, so the
  // identity echo, the visit-type check, eligibility and the assessment checks are exempt
  // (the main flow's own checks, including its expectedVisit compare when sent, still run).
  if (isIncompleteVisit) return null;
  if (expectedVisitIncomplete(expectedVisit)) {
    return {
      status: 400,
      payload: {
        error: 'Reopen this visit from the schedule so the sheet can confirm it is still the same visit.',
        code: 'lawn_fast_expected_visit_required',
      },
    };
  }
  // The visit type the sheet opened with must be echoed too (the key, like the identity
  // keys): the planned recipe it preselected belongs to that type.
  if (lawnFastEchoMissing(lawnFast)) {
    return {
      status: 400,
      payload: {
        error: 'Reopen this visit from the schedule so the sheet can confirm it is still the same visit.',
        code: 'lawn_fast_expected_visit_required',
      },
    };
  }
  const verdict = await resolveLawnFastEligibility(svc.id, knex, { allowStatuses: ['completed'] });
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
  // The visit type is recomputed with the SAME function and the SAME strict reads the
  // context used (billing lane + strict profile). If the billing read failed the type
  // cannot be known now, so nothing is accepted (503, retry). Otherwise the echoed type
  // must equal it: the office may have moved the customer to per-application billing, or
  // changed the profile's billing type, while the sheet was open, and the recipe it
  // preselected then no longer applies. An echoed 'unknown' (the context could not tell)
  // can never equal a successful recompute, so it is refused as changed too.
  const typeRefusal = visitTypeRefusal(verdict, lawnFast);
  if (typeRefusal) return typeRefusal;
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
  // The customer report must be able to use it: the SAME property-scope verdict the
  // context reports (assessmentUsableForReport). A failed check throws, never passes.
  if (!(await assessmentUsableForReport(svc, assessment, knex))) {
    return {
      status: 400,
      payload: {
        error: 'This lawn assessment was captured for a different property than this visit. Analyze and confirm it again for this visit.',
        code: 'lawn_fast_assessment_required',
        reason: 'property_scope',
      },
    };
  }
  // GATE_LAWN_TROUBLE_AREAS: every spot row names a place, and the place the yearly limits forbid is refused
  // (lawn-trouble-areas.js preflightPlaces; null while the gate is off).
  return require('./lawn-trouble-areas').preflightPlaces({ knex, svc, products });
}

// The visit type re-judged INSIDE the completion transaction, beside the main flow's
// locked-row identity compare: billing_mode is read from the LOCKED customer row
// (the existing FOR SHARE read selects it), the profile with the strict resolver on the
// transaction, and the same lawnFastVisitType result is compared with the type the
// sheet echoed. A change since the unlocked preflight (the office moved the customer
// to per-application billing, say) aborts with visit_identity_changed / visit_type_changed
// through the main flow's own error path. A failed read aborts retryably
// (lawn_fast_visit_type_unavailable, 503), never passes. A profile edit racing the commit
// is out of scope: the profile is catalog data this transaction does not lock. Nothing
// runs for a request without a lawnFast block.
async function assertLawnFastVisitTypeUnderLock({ trx, lockedCustomer, lockedSvc, lawnFast }) {
  if (lawnFast === null || lawnFast === undefined) return;
  const unavailable = () => Object.assign(new Error('lawn fast visit type unavailable'), { code: 'lawn_fast_visit_type_unavailable' });
  if (!lockedCustomer || !('billing_mode' in lockedCustomer) || !lockedSvc) throw unavailable();
  let profile;
  try {
    profile = await require('./service-completion-profiles').resolveCompletionProfileForScheduledService(lockedSvc, trx, { strict: true });
  } catch (err) {
    logger.warn(`[lawn-fast] visit type unavailable under the completion lock for ${lockedSvc.id}: ${err?.code || err?.name || 'Error'}`);
    throw unavailable();
  }
  const visitType = lawnFastVisitType(profile, lockedCustomer.billing_mode || null, lockedSvc.is_callback === true);
  if (!lawnFast || typeof lawnFast !== 'object' || lawnFast.visitType !== visitType) {
    throw Object.assign(new Error('visit type changed during completion'), { code: 'visit_identity_changed', reason: 'visit_type_changed' });
  }
}

module.exports = {
  LEGACY_PHOTO_FLOOR,
  isUuid,
  BILLING_MODE_UNKNOWN,
  lawnFastVisitType,
  REQUIRED_IDENTITY_KEYS,
  lawnFastIneligibleReason,
  resolveLawnFastEligibility,
  evaluatePhotoFloor,
  buildLawnFastContext,
  buildLawnFastWateringPreview,
  buildLawnTreatmentGuide,
  takeAllProductIdsFor,
  troubleTypeIdsFor,
  preflightLawnFastCompletion,
  assertLawnFastVisitTypeUnderLock,
};
