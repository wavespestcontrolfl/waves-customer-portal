const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const { METHOD_LABELS, renderTreatmentMap } = require('./treatment-map');
const { detectServiceLine, getServiceLineConfig, isRodentAdjacentServiceType } = require('./service-line-configs');
const { customerVisiblePressureIndex } = require('../pest-pressure/display');
const { loadActiveConfig, loadScoreForServiceRecord, loadHistoryForCustomer } = require('../pest-pressure/store');
const { buildPestPressureCustomerView } = require('../pest-pressure/customer-view');
const { isOneTimePressureExcludedRecord } = require('../pest-pressure/one-time-exclusion');
const { buildNoActivityFinding } = require('./no-activity-finding');
const { isCardCustomerSurfaceable } = require('../lawn-recommendation-visibility');
const { buildIrrigationAdvice } = require('./irrigation-advice');
const { buildMowingHeightContext } = require('./turf-height');
const { buildLawnReportV2, grassLabelFor } = require('./lawn-report-v2');
const { buildTreeShrubReportV2 } = require('./tree-shrub-report-v2');
const { applyLawnReportNarrative } = require('./lawn-report-narrative');
const { applyVisitSummaryNarrative } = require('./visit-summary-narrative');
const { applyRodentReportNarrative, applyTypedReportNarrative } = require('./rodent-report-narrative');
const { technicianReportCustomerCopy } = require('./technician-report-copy');
const { getTurfHeightForVisit, getTurfHeightTrend } = require('../turf-height-service');
const { resolveZoneRowsImageDrift } = require('./zone-drift');
const { buildStationMapReportContext } = require('../termite-stations');
const { fetchServiceWeekWeather, toCoordinate } = require('./application-conditions');
const { validatePhotoChainRows } = require('./photo-chain');
const { buildSatelliteTreatmentMapContext } = require('./satellite-treatment-map');
const { computeLinearFt, computeOnSiteMin } = require('./metrics-band');
const { loadActivityCustomerView, buildTypedVisitTimeline } = require('./activity-scores-store');
const {
  loadServiceCoverageConfig,
  normalizeServiceCoverage,
} = require('./service-coverage');
const {
  loadVisitTimelineConfig,
  buildVisitTimeline,
} = require('./visit-timeline');
const {
  loadApprovedVisualServiceMomentsForReport,
} = require('../visual-service-notes');
const { resolveTechPhotoUrl } = require('../tech-photo');
const { minutesFromElapsed } = require('../../utils/duration-minutes');
const {
  formatTechnicianForCustomer,
  initialsForCustomerTechnicianName,
} = require('../../utils/technician-name');
const { etDateString, parseETDateTime } = require('../../utils/datetime-et');
const featureGates = require('../../config/feature-gates');
const { configuredPublicPortalOrigin } = require('../../utils/portal-url');

let PhotoService = null;
try {
  PhotoService = require('../photos');
} catch {
  PhotoService = null;
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function zoneSupportsServiceLine(zone, serviceLine) {
  const serviceLines = parseJsonArray(zone?.service_lines)
    .map((line) => String(line || '').trim().toLowerCase())
    .filter(Boolean);
  if (!serviceLines.length) return true;
  if (!serviceLine) return true;
  return serviceLines.includes(String(serviceLine).toLowerCase());
}

function uniqueStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const text = String(value || '').trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

const NON_LOCATION_AREA_LABELS = new Set([
  'customer spoke with tech',
  'no issues found',
  'follow up recommended',
]);

function normalizeLabel(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function locationAreaLabels(values) {
  return uniqueStrings(values).filter((label) => !NON_LOCATION_AREA_LABELS.has(normalizeLabel(label)));
}

function taggedNoteLines(notes, tags) {
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

// Whether the row RECORDS its method, as opposed to methodFromProduct
// inferring one from category/service-line. The distinction is load-bearing
// for the document (pre-push P1 #3176 r19): an EXPLICIT station_check is a
// deliberate device inspection and must never be re-classified as a product
// application, however pesticide-flavored the product — only an INFERRED
// station_check (legacy null application_method on a termite/rodent product)
// may be overridden by pesticide identity.
function hasExplicitApplicationMethod(product) {
  const raw = String(product.application_method || product.method || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return !!raw && raw !== 'null';
}

function methodFromProduct(product, serviceLine) {
  const raw = String(product.application_method || product.method || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
  if (raw && raw !== 'null') return raw;
  const category = String(product.product_category || '').toLowerCase();
  if (category.includes('bait') || category.includes('gel') || category.includes('glue')) return 'bait_placement';
  if (category.includes('fert') || category.includes('granular')) return 'granular_broadcast';
  if (serviceLine === 'mosquito') return 'fog_ulv';
  if (serviceLine === 'lawn') return category.includes('herb') ? 'spot_treatment' : 'broadcast_spray';
  if (serviceLine === 'palm' || serviceLine === 'tree_shrub') return 'foliar_spray';
  if (serviceLine === 'rodent' || serviceLine === 'termite') return 'station_check';
  return 'perimeter_spray';
}

function inferCatalogProductType(product = {}) {
  if (product.product_type) return product.product_type;
  const category = String(product.category || product.product_category || '').toLowerCase();
  if (/(herbicide|insecticide|fungicide|pgr|growth)/.test(category)) return 'pesticide';
  if (category.includes('fertilizer')) return 'fertilizer';
  if (category.includes('wetting')) return 'wetting_agent';
  if (category.includes('bio')) return 'biostimulant';
  return 'other';
}

function validCatalogEpaReg(value) {
  const text = String(value || '').trim();
  return !!text && !/^(n\/a|not epa|not epa-registered fertilizer|none)$/i.test(text);
}

function approvedReportProductFacts(catalog = {}) {
  if (!catalog || !catalog.approved_for_service_report) return null;
  const productType = inferCatalogProductType(catalog);
  if (productType === 'pesticide' && !validCatalogEpaReg(catalog.epa_reg_number)) return null;
  return {
    productType,
    name: catalog.name || null,
    category: catalog.category || null,
    activeIngredient: catalog.active_ingredient || null,
    epaRegNumber: productType === 'pesticide' ? catalog.epa_reg_number : null,
    manufacturer: catalog.manufacturer || null,
    publicSummary: catalog.public_summary || catalog.portal_summary || null,
    serviceReportSummary: catalog.service_report_summary || catalog.public_summary || catalog.portal_summary || null,
    precautionSummary: catalog.customer_precaution_summary || catalog.customer_safety_summary || catalog.pet_kid_guidance_text || null,
    reentrySummary: catalog.reentry_summary || catalog.reentry_text || null,
    reentryHours: Number.isFinite(Number(catalog.rei_hours)) ? Number(catalog.rei_hours) : null,
    irrigationNotes: catalog.irrigation_notes || null,
    // Tri-state: true = water in after application (e.g. fertilizer), false =
    // keep off / do not water in (e.g. Celsius WG post-emergent), null = unknown.
    irrigationRequired: catalog.irrigation_required == null ? null : Boolean(catalog.irrigation_required),
    labelVerifiedAt: catalog.label_verified_at || null,
    labelVersion: catalog.label_version || null,
  };
}

async function attachApprovedReportProductFacts(knex, products = []) {
  const productIds = [...new Set((products || []).map((product) => product.product_id).filter(Boolean))];
  if (!productIds.length) return products;
  let catalogRows = [];
  try {
    catalogRows = await knex('products_catalog')
      .whereIn('id', productIds)
      .select(
        'id',
        'name',
        'category',
        'product_type',
        'manufacturer',
        'active_ingredient',
        'epa_reg_number',
        'public_summary',
        'portal_summary',
        'service_report_summary',
        'customer_safety_summary',
        'customer_precaution_summary',
        'pet_kid_guidance_text',
        'reentry_text',
        'reentry_summary',
        'rei_hours',
        'irrigation_notes',
        'irrigation_required',
        'label_verified_at',
        'label_version',
        'approved_for_service_report',
      );
  } catch {
    // Signal the failure instead of silently returning bare rows (codex P2
    // r41): a legacy row with product_id but null product_category loses
    // its class identity when this lookup fails, and downstream honesty
    // passes would treat the visit as "no corrective products applied".
    const marked = products.slice();
    marked.catalogEnrichmentFailed = true;
    return marked;
  }
  const catalogById = new Map(catalogRows.map((row) => [String(row.id), row]));
  return products.map((product) => {
    const catalog = catalogById.get(String(product.product_id || ''));
    const facts = approvedReportProductFacts(catalog);
    if (!facts) return product;
    return {
      ...product,
      product_name: product.product_name || facts.name,
      product_category: product.product_category || facts.category,
      active_ingredient: product.active_ingredient || facts.activeIngredient,
      epa_reg_number: product.epa_reg_number || facts.epaRegNumber,
      approved_report_product_facts: facts,
    };
  });
}

function formatPhoneDisplay(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  const d = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return String(raw).trim();
}

function numberOrNull(value) {
  // Nullish/empty must be null, not 0 — otherwise firstNumber() short-circuits
  // on a null first arg (Number(null) === 0) and never reaches its fallbacks,
  // e.g. a null completion-rain value would mask FAWN rainfall, or a null
  // turf-profile irrigation value would mask the customer's portal entry.
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstNumber(...values) {
  for (const value of values) {
    const n = numberOrNull(value);
    if (n != null) return n;
  }
  return null;
}

function roundInches(value) {
  const n = numberOrNull(value);
  return n == null ? null : Math.round(n * 100) / 100;
}

function monthFromServiceDate(serviceDate) {
  if (!serviceDate) return null;
  // A DATE column can arrive as a JS Date object (pg/Knex) or an ISO string.
  // String(Date) yields "Sat Jun 13 2026 ..." whose slice(5,7) is non-numeric,
  // which would silently fall back to the peak-season target. Normalize a Date
  // to YYYY-MM-DD first; ET is behind UTC so a date-only value never crosses a
  // month boundary under toISOString.
  const str = serviceDate instanceof Date ? serviceDate.toISOString() : String(serviceDate);
  const m = Number(str.slice(5, 7));
  return Number.isInteger(m) && m >= 1 && m <= 12 ? m : null;
}

function buildLawnWaterContext({ assessment = {}, turfProfile = null, propertyPrefs = null, fawnSnapshot = {}, serviceDate = null, completionRainfallInchesToday = null, completionRainfall7dInches = null, completionEt0Inches = null, completionDailyRain = null, completionRainConfidence = null, completionRainSource = null } = {}) {
  const turfIrrigationInches = numberOrNull(turfProfile?.irrigation_inches_per_week);
  const assessmentIrrigationInches = numberOrNull(assessment.irrigation_inches_per_week);
  const prefsIrrigationInches = numberOrNull(propertyPrefs?.irrigation_inches_per_week);
  // PORTAL ENTRY WINS: what the customer enters in the portal is what the report
  // shows. The customer's own schedule takes priority over turf/assessment readings.
  const irrigationInchesPerWeek = firstNumber(
    prefsIrrigationInches,
    turfIrrigationInches,
    assessmentIrrigationInches,
  );
  // The portal irrigation toggle (property_preferences.irrigation_system, backfilled
  // to false) only suppresses a value the customer DIDN'T enter — i.e. when the only
  // available reading is the prefs one. An entered portal schedule (which wins above)
  // is shown as-is; a turf/assessment reading is never suppressed by the toggle.
  const irrigationInchesFromPrefsOnly =
    turfIrrigationInches == null && assessmentIrrigationInches == null && prefsIrrigationInches != null;
  const irrigationInchesPerDay = irrigationInchesPerWeek == null ? null : irrigationInchesPerWeek / 7;
  const rainfallInchesToday = firstNumber(
    // Prefer the same rainfall the weather block shows (completion conditions —
    // Open-Meteo) so the water line never reads 0" next to a non-zero "rain last
    // 24 hr". FAWN snapshot fills in only when the completion value is absent.
    completionRainfallInchesToday,
    fawnSnapshot.rainfall_in,
    fawnSnapshot.rain_24h_in,
    fawnSnapshot.precipitation_in,
    assessment.fawn_rainfall_7d,
  );
  const rainfallInches7d = firstNumber(
    // Live Open-Meteo trailing-7-day total — the only real weekly rainfall
    // source; the FAWN snapshot keys below are legacy/unpopulated fallbacks.
    completionRainfall7dInches,
    fawnSnapshot.rainfall_7d,
    fawnSnapshot.rain_7d,
    fawnSnapshot.rainfall_last_7d,
    fawnSnapshot.precipitation_7d,
  );
  // Which provider actually supplied the weekly figure — the customer-facing
  // Source row must credit the real one (codex P2 #3093 r6: a FAWN fallback
  // week was labeled Open-Meteo).
  //
  // The completion figure no longer means "Open-Meteo": with GATE_RAIN_MRMS
  // live it can be MRMS observations, or a per-day mrms+open_meteo blend, and
  // fetchServiceWeekWeather already reports which via rainSource. Hardcoding
  // 'open_meteo' here mislabeled every MRMS week the moment the gate flipped.
  // Fall back to 'open_meteo' only when the weather call gave us no source at
  // all, which is what the pre-engine path did.
  const rainfall7dProvider = completionRainfall7dInches != null
    ? (completionRainSource || 'open_meteo')
    : (rainfallInches7d != null ? 'fawn' : null);
  const dailyInputs = [irrigationInchesPerDay, rainfallInchesToday].filter((value) => value != null);
  const weeklyInputs = [irrigationInchesPerWeek, rainfallInches7d].filter((value) => value != null);

  const grassType = turfProfile?.grass_type || assessment.grass_type || null;
  const irrigationAdvice = buildIrrigationAdvice({
    grassType,
    month: monthFromServiceDate(serviceDate),
    // Reference ET₀ for the service week → weather-driven target (× turf Kc);
    // null falls back to the grass×season seasonal lookup inside the advice.
    referenceEt0InchesWeek: completionEt0Inches,
    irrigationInchesPerWeek,
    // Only a TRUE 7-day total drives the water balance. A 24-hour completion
    // value is not a weekly figure — substituting it would let the advice claim
    // deficit/balanced from a single day of rain. When no weekly total exists the
    // advice returns 'rain_unknown' (and the 24h rain still shows in the weather
    // block + the visible rainfallInchesToday field).
    rainfallInches7d,
    // Portal irrigation-system toggle suppresses a stale weekly-inches value
    // ONLY when that value is the portal-sourced one — never when turf/assessment
    // data supplied it (the toggle's false default would otherwise hide a real
    // schedule shown in the profile line).
    irrigationEnabled: irrigationInchesFromPrefsOnly && propertyPrefs && propertyPrefs.irrigation_system != null
      ? !!propertyPrefs.irrigation_system
      : null,
  });

  // Always return a context for lawn reports: even with no inputs we carry the
  // grass×season recommendation so the report can prompt the customer to add
  // their irrigation schedule.
  return {
    irrigationInchesPerWeek: roundInches(irrigationInchesPerWeek),
    irrigationInchesPerDay: roundInches(irrigationInchesPerDay),
    rainfallInchesToday: roundInches(rainfallInchesToday),
    rainfallInches7d: roundInches(rainfallInches7d),
    effectiveInchesToday: dailyInputs.length ? roundInches(dailyInputs.reduce((sum, value) => sum + value, 0)) : null,
    effectiveInches7d: rainfallInches7d == null ? null : roundInches(weeklyInputs.reduce((sum, value) => sum + value, 0)),
    targetInchesPerWeek: irrigationAdvice.recommendedInchesPerWeek,
    targetInchesPerDay: roundInches(irrigationAdvice.recommendedInchesPerWeek / 7),
    rainfallSource: rainfallInches7d == null && rainfallInchesToday != null
      ? 'fawn_daily_observation'
      : (rainfallInches7d != null ? 'fawn_7_day_observation' : null),
    rainfall7dProvider,
    // Per-day rainfall over the trailing 7 days at the client's lat/lng (same
    // Open-Meteo source as rainfallInches7d), raw as [{ date, inches }]. The
    // report's 7-day chart renders from this so it matches the weekly total and
    // is property-specific. Null when no complete window is available.
    dailyRain7d: Array.isArray(completionDailyRain) ? completionDailyRain : null,
    // 'low' when dailyRain7d is the city-collective fallback (a single-cell model spike
    // was detected) so the report can badge the 7-day chart "Limited data this week".
    dailyRain7dConfidence: completionRainConfidence || null,
    irrigationAdvice,
  };
}

function serviceDisplayName(service) {
  const raw = String(service?.service_type || '').trim();
  return raw || 'Waves service';
}

function scopeTextValues({ service = {}, applications = [], zones = [] } = {}) {
  const structured = parseJsonObject(service.structured_notes);
  const values = [
    ...parseJsonArray(service.areas_serviced),
    ...parseJsonArray(structured.areasServiced),
    ...parseJsonArray(structured.areasTreated),
  ];

  for (const app of applications || []) {
    values.push(
      app.applicationArea,
      app.application_area,
      app.area,
    );
    values.push(...parseJsonArray(app.targets));
  }

  for (const zone of zones || []) {
    values.push(zone.label, zone.category);
  }

  return uniqueStrings(values);
}

// Structured scope is the authoritative signal for completed treatment
// actions: each entry carries an explicit { scope, treatmentApplied } so we
// never have to regex an action label (brittle — e.g. "Interior inspection"
// would falsely match \binterior\b). Only entries with treatmentApplied ===
// true assert scope; an inspection / declined / no-access action contributes
// nothing and must not fire the interior re-entry countdown.
function structuredActionScope(service = {}) {
  const structured = parseJsonObject(service.structured_notes);
  const entries = []
    .concat(Array.isArray(service.protocolActionScopesCompleted) ? service.protocolActionScopesCompleted : [])
    .concat(Array.isArray(structured.protocolActionScopesCompleted) ? structured.protocolActionScopesCompleted : []);
  let hasInterior = false;
  let hasExterior = false;
  let hasTreatment = false;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || entry.treatmentApplied !== true) continue;
    const scope = String(entry.scope || '').toLowerCase();
    if (scope === 'interior') { hasInterior = true; hasTreatment = true; }
    else if (scope === 'exterior') { hasExterior = true; hasTreatment = true; }
  }
  return { hasInterior, hasExterior, hasTreatment };
}

function treatmentScope({ service = {}, applications = [], zones = [] } = {}) {
  const text = scopeTextValues({ service, applications, zones })
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
  // Area chips are a controlled vocabulary and remain a valid scope signal.
  const textInterior = /\b(interior|inside|indoor|kitchen|bath|bathroom|baseboard|baseboards|bedroom|living room|laundry|utility room|pantry|closet)\b/.test(text);
  // fence/trash cover the controlled pest-area chips "Fence line" and
  // "Trash area" — clearly exterior choices that previously fell through
  // and (under the explicit-exterior rule) would wrongly zero the
  // customer's dry-down timer (codex P1 #3007).
  const textExterior = /\b(exterior|outside|outdoor|perimeter|foundation|eaves|soffit|yard|front|back|rear|side|lanai|patio|pool|driveway|landscape|mulch|entry|threshold|lawn|fence|trash)\b/.test(text);
  // Structured action scope is additive: an interior treatment fires interior
  // even when only exterior areas were chipped (and vice-versa).
  const action = structuredActionScope(service);
  return {
    hasInterior: textInterior || action.hasInterior,
    hasExterior: textExterior || action.hasExterior,
    hasExplicitScope: text.trim().length > 0 || action.hasTreatment,
    // TRUE only when a recognized interior/exterior LOCATION signal exists.
    // Target-only text (product target names) makes hasExplicitScope true
    // without classifying anything — the write-path defer must key on this
    // instead, or a trace saved later can't restore the timer (codex P1
    // #3007 r13).
    hasLocationSignal: textInterior || textExterior || action.hasInterior || action.hasExterior,
  };
}

function normalizeAdvisoryForTreatmentScope(advisory = {}, { service = {}, applications = [], zones = [], deferUnknownExteriorZeroing = false } = {}) {
  const normalized = { ...parseJsonObject(advisory) };
  // Admin re-entry correction (PATCH /admin/dispatch/:serviceId/reentry):
  // a typed window is authoritative FOR ITS SIDE ONLY. The marker is
  // per-side ({ exterior, interior } strict booleans; legacy plain `true`
  // covers both) so a one-sided edit never resurrects the untouched side —
  // e.g. correcting the interior window on an interior-only visit must not
  // expose the stored exterior default that scope zeroing would have
  // suppressed (codex P1 PR #3180). Only the correction endpoint writes it.
  const adjustedMarker = normalized.reentry_adjusted;
  const sideAdjusted = (side) => adjustedMarker === true
    || (!!adjustedMarker && typeof adjustedMarker === 'object' && adjustedMarker[side] === true);
  const scope = treatmentScope({ service, applications, zones });

  if (!sideAdjusted('interior') && normalized.interior_reentry_min != null && scope.hasExplicitScope && scope.hasExterior && !scope.hasInterior) {
    normalized.interior_reentry_min = 0;
  }
  // Owner rule 2026-07-27: the Exterior re-entry target exists ONLY when
  // the visit explicitly classified exterior treatment — never as a
  // default timer. A visit with no recorded scope at all therefore shows
  // no exterior row (previously both service-line default timers rendered).
  // This subsumes the old interior-only branch: explicitly-interior visits
  // have hasExterior false and zero out here the same way.
  // WRITE-path callers set deferUnknownExteriorZeroing: an UNKNOWN scope
  // keeps the stored duration so a treatment-zone trace saved AFTER
  // completion can still surface the timer — the read-time normalizer
  // (trace-aware) makes the final display call, and stored zero would be
  // unrecoverable (codex P1 #3007 r11). Explicitly non-exterior scope
  // still zeroes at write.
  if (!sideAdjusted('exterior') && normalized.exterior_reentry_min != null && !(scope.hasExplicitScope && scope.hasExterior)) {
    // WRITE path never zeroes exterior (codex P1 r17): a Treatment Zone
    // Mapper trace can be saved AFTER completion even when the visit
    // recorded interior locations, and a stored zero is unrecoverable.
    // Every DISPLAY surface (report payload, re-entry card, SMS, email)
    // normalizes at read time with trace evidence and zeroes there.
    if (!deferUnknownExteriorZeroing) {
      normalized.exterior_reentry_min = 0;
    }
  }

  return normalized;
}

// Build the advisory persisted at completion time from the exact inputs the
// completion route has on hand. This is the write-path gate: whatever scope is
// resolved here is what the customer sees — the report build can only zero it
// further, never restore it. Kept as a pure helper so the scope wiring is
// directly testable without the full /complete route harness.
// Shared trace-evidence resolver (read paths + SMS/email delivery): a
// technician-traced treatment zone is explicit exterior scope. Only the
// expected missing-table error means "no trace" — a transient failure
// preserves the exterior timer rather than suppressing customer safety
// guidance (codex P1 #3007 r9/r17). Lives here (not reentry.js) so the
// report payload's own advisory normalization can use it without a
// require cycle.
async function resolveTracedExteriorZone(record, knex = db, { precomputedTraceVerdict = null } = {}) {
  if (!record?.scheduled_service_id) return false;
  // Centralized eligibility (GATE_TRACE_ELIGIBILITY): an ineligible lane's
  // saved trace must not drive the exterior dry-down timer either. This
  // function is the single choke point for the report payload, the
  // re-entry context — which reports-public and email-delivery each build
  // independently — and the completion SMS, so the verdict lives HERE
  // rather than at any one call site (codex P1 r2). Gate ON, the verdict
  // ALONE decides (frozen identity + add-on aware — the label checks
  // above read the mutable row and would override in both directions;
  // codex P2 r16). Fail-soft: helper errors fall through to the lookup.
  try {
    const { resolveTraceRenderVerdict, traceEligibilityGateOn } = require('./trace-eligibility');
    const { photoMarksGateOn: exteriorPhotoMarksGateOn } = require('./photo-marks');
    // EITHER gate (codex P1 r7). The shared verdict learned to suppress a
    // photo-only visit, but this choke point only called it under the
    // eligibility gate — so in the marks-first rollout a foam-only visit with
    // a legacy trace still handed an exterior ready-at target to reentry.js,
    // dynamic context, and email delivery. Fixing the callee was not enough;
    // the caller had to stop gating the call.
    if (traceEligibilityGateOn() || exteriorPhotoMarksGateOn()) {
      // The report-payload caller passes its ALREADY-COMBINED verdict
      // (codex P2 r24): recomputing here meant a transient failure in
      // the second add-on pass could strip exterior re-entry guidance
      // from the same payload whose map just rendered. Independent
      // callers (reports-public, email-delivery, SMS) resolve internally.
      const renderVerdict = precomputedTraceVerdict
        || await resolveTraceRenderVerdict(record, knex);
      if (renderVerdict.suppressed) return false;
      // Same conservative error semantics as the legacy lookup below
      // (codex P1 r17): only a MISSING TABLE means "no trace" — any other
      // transient failure preserves the exterior dry-down guidance rather
      // than silently dropping customer re-entry advice.
      try {
        return !!(await knex('treatment_zone_maps')
          .where({ scheduled_service_id: record.scheduled_service_id })
          .first());
      } catch (traceErr) {
        return !(traceErr?.code === '42P01'
          || /no such table|does not exist/i.test(String(traceErr?.message || '')));
      }
    }
  } catch { /* proceed to the ordinary lookup */ }
  // Interior-only treatments (bed bug): a trace saved before the tracer was
  // hidden for this lane is stale EXTERIOR evidence — never let it drive
  // the exterior dry-down timer. Single choke point for the report payload,
  // the re-entry context, and the completion SMS (codex P2 r8). Callers
  // with the resolved profile pass interior_only_lane (stable key, r9).
  if (record.interior_only_lane === true
    || /\bbed\s*bugs?\b/i.test(String(record.service_type || ''))) return false;
  // No caller classification at all (dynamic-context/reentry paths load
  // only service_records.*): resolve the stable lane HERE — a relabeled
  // bed-bug appointment must not slip the label regex (codex P2 r12).
  // Fail-soft: resolver errors fall through to the ordinary trace lookup.
  if (record.interior_only_lane === undefined) {
    try {
      const scheduledRow = await knex('scheduled_services')
        .where({ id: record.scheduled_service_id })
        .first('id', 'service_id', 'service_type');
      if (scheduledRow) {
        if (/\bbed\s*bugs?\b/i.test(String(scheduledRow.service_type || ''))) return false;
        const { resolveCompletionProfileForScheduledService } = require('../service-completion-profiles');
        const laneProfile = await resolveCompletionProfileForScheduledService(scheduledRow, knex);
        if (laneProfile?.serviceKey === 'bed_bug_treatment') return false;
      }
    } catch { /* label fallback above already ran; proceed to the lookup */ }
  }
  try {
    return !!(await knex('treatment_zone_maps')
      .where({ scheduled_service_id: record.scheduled_service_id })
      .first());
  } catch (traceErr) {
    return !(traceErr?.code === '42P01'
      || /no such table|does not exist/i.test(String(traceErr?.message || '')));
  }
}

function buildCompletionAdvisory({ advisoryDefaults = {}, completionAreas = [], protocolActionScopes = [], applications = [], tracedExteriorZone = false } = {}) {
  return normalizeAdvisoryForTreatmentScope(advisoryDefaults, {
    service: {
      areas_serviced: completionAreas,
      structured_notes: {
        areasTreated: completionAreas,
        protocolActionScopesCompleted: protocolActionScopes,
      },
    },
    applications,
    // A technician-traced treatment zone is explicit exterior evidence: the
    // trace is drawn over the property's satellite exterior. Typed T&S
    // closeouts hide areasServiced and clear applicationArea, so without
    // this the explicit-exterior rule would zero the dry-down timer on a
    // visit whose treatment location WAS captured (codex P1 #3007 r5).
    zones: tracedExteriorZone ? [{ label: 'Traced exterior treatment zone' }] : [],
    // Unknown scope keeps the stored duration at write time — a trace saved
    // after completion must still be able to surface the timer, and the
    // read-time normalizer makes the final display decision.
    deferUnknownExteriorZeroing: true,
  });
}

function compactAddress(record) {
  const street = [record.address_line1, record.address_line2]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(', ');
  const region = [
    record.city,
    [record.state, record.zip].map((part) => String(part || '').trim()).filter(Boolean).join(' '),
  ].map((part) => String(part || '').trim()).filter(Boolean).join(', ');
  return [street, region].filter(Boolean).join(', ');
}

function aggregateApplicationArea(applications, preferredUnits = []) {
  const preferred = new Set(preferredUnits);
  return applications.reduce((sum, app) => {
    const value = numberOrNull(app.areaValue);
    if (value == null) return sum;
    if (preferred.size && !preferred.has(String(app.areaUnit || ''))) return sum;
    return sum + value;
  }, 0);
}

function metricValue(metric, context) {
  if (metric.key === 'on_site_min') return context.onSiteMin;
  if (metric.aggregate === 'count_zones') return `${context.treatedZoneIds.size}/${context.zones.length}`;
  if (metric.aggregate === 'count_applications') return context.applications.length;
  if (metric.aggregate === 'count_findings') {
    return context.findings.filter((finding) => finding?.category !== 'no_activity').length;
  }
  if (metric.aggregate === 'pressure_index') return context.pressureIndex;
  if (metric.key === 'linear_ft') {
    if (context.linearFt != null) return context.linearFt;
    const total = Math.round(aggregateApplicationArea(context.applications, ['linear_ft']));
    return total > 0 ? total : null;
  }
  if (metric.key === 'area_sqft') {
    const total = Math.round(aggregateApplicationArea(context.applications, ['sqft']));
    return total > 0 ? total : null;
  }
  const value = context.serviceData?.[metric.key];
  return value == null ? null : value;
}

function buildMetrics(config, context) {
  const metricConfig = Array.isArray(config.metrics) && config.metrics.length === 4
    ? config.metrics
    : [
      { key: 'on_site_min', label: 'On-site', unit: 'min', format: 'integer' },
      { key: 'zones', label: 'Zones', format: 'ratio', aggregate: 'count_zones' },
      { key: 'applications', label: 'Applications', format: 'integer', aggregate: 'count_applications' },
      { key: 'pressure_index', label: 'Pressure index', format: 'decimal_1', aggregate: 'pressure_index' },
    ];
  return metricConfig.map((metric) => ({
    key: metric.key,
    label: metric.label,
    value: metricValue(metric, context),
    unit: metric.unit,
    format: metric.format,
  }));
}

function defaultGeometry() {
  return {
    lot: { w: 620, h: 320 },
    house: { x: 238, y: 100, w: 164, h: 110 },
    garage: { x: 402, y: 128, w: 66, h: 82 },
    lanai: { x: 244, y: 210, w: 150, h: 54 },
    pool: null,
    drive: { x: 424, y: 210, w: 44, h: 94 },
    north_indicator: 'top',
    scale_ft_per_unit: 6,
  };
}

function zoneGeometryForIndex(index) {
  const zones = [
    { x: 64, y: 42, w: 512, h: 46 },
    { x: 64, y: 250, w: 512, h: 46 },
    { x: 64, y: 88, w: 48, h: 162 },
    { x: 528, y: 88, w: 48, h: 162 },
    { x: 232, y: 210, w: 180, h: 58 },
    { x: 416, y: 212, w: 72, h: 92 },
  ];
  return zones[index % zones.length];
}

function defaultZones(labels, serviceLine) {
  const source = labels.length
    ? labels
    : ['Front perimeter', 'Rear perimeter', 'Left perimeter', 'Right perimeter'];
  return source.slice(0, 6).map((label, index) => ({
    id: `default-zone-${index + 1}`,
    letter: String.fromCharCode(65 + index),
    label,
    category: index < 4 ? 'perimeter' : 'lanai',
    geometry: zoneGeometryForIndex(index),
    service_lines: [serviceLine],
  }));
}

function matchZoneIds(product, zones, areaLabels = []) {
  const explicit = parseJsonArray(product.zone_ids);
  if (explicit.length) return explicit.map(String);
  // application_area may be a comma-joined multi-area list ("Kitchen,
  // Bathrooms") since the per-product picker went multi-select — match each
  // listed area independently so multi-word zone labels ("Kitchen west")
  // still resolve. A single-area value splits to itself, so the legacy
  // shape behaves exactly as before.
  const areas = String(product.application_area || product.area || '')
    .toLowerCase()
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (areas.length) {
    const matched = zones.filter((zone) => {
      const label = String(zone.label || '').toLowerCase();
      return areas.some((area) => label.includes(area) || area.includes(label));
    });
    if (matched.length) return matched.map((zone) => String(zone.id));
  }
  // Unscoped product (no explicit ids, no usable area): fan out to THIS
  // visit's chipped areas, not the whole property. With fabricated
  // defaultZones the two sets are identical (zones are built from the
  // chips), but persisted property_zones outlive the visit — fanning out to
  // all of them would mark zones as serviced on reports for visits that
  // never touched them. Falls back to every zone only when no chip matches
  // any zone label (legacy shape, zones from findings, label drift).
  const chipKeys = new Set((areaLabels || []).map((label) => normalizeCoverageLabel(label)).filter(Boolean));
  if (chipKeys.size) {
    const chipped = zones.filter((zone) => chipKeys.has(normalizeCoverageLabel(zone.label)));
    if (chipped.length) return chipped.map((zone) => String(zone.id));
  }
  return zones.map((zone) => String(zone.id));
}

function applicationZoneIds(app = {}) {
  const ids = Array.isArray(app.zone_ids)
    ? app.zone_ids
    : (Array.isArray(app.zoneIds) ? app.zoneIds : []);
  return ids.map((id) => String(id)).filter(Boolean);
}

const SERVICE_LOCATION_STATUSES = new Set([
  'treated',
  'partially_treated',
  'serviced',
  'inspected',
  'spot_treated',
  'skipped',
  'blocked',
  'inaccessible',
  'activity_found',
  'device_checked',
  'device_placed',
  'entry_point_found',
  'not_included',
]);

const WORKFLOW_EVENT_TYPES = new Set([
  'scheduled',
  'technician_en_route',
  'technician_on_site',
  'arrived_on_site',
  'inspection_started',
  'service_started',
  'service_completed',
  'quality_reviewed',
  'report_published',
  'follow_up_recommended',
  'return_visit_needed',
]);

function coverageServiceType(serviceLine) {
  const key = String(serviceLine || '').toLowerCase();
  if (key === 'lawn') return 'lawn';
  if (key === 'pest' || key === 'pest_control' || key === 'termite' || key === 'rodent') return 'pest_control';
  if (key === 'mosquito') return 'mosquito';
  if (key === 'tree_shrub' || key === 'palm') return 'tree_shrub';
  return 'other';
}

function normalizeStatus(value, fallback = 'inspected') {
  const key = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (SERVICE_LOCATION_STATUSES.has(key)) return key;
  if (key === 'checked') return 'device_checked';
  if (key === 'placed') return 'device_placed';
  if (key === 'complete' || key === 'completed') return 'serviced';
  return fallback;
}

function normalizeWorkflowType(value) {
  const key = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return WORKFLOW_EVENT_TYPES.has(key) ? key : 'service_completed';
}

function validTimestamp(value) {
  if (!value) return '';
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  }
  const raw = String(value).trim();
  const naiveWallClock = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?$/.test(raw);
  const date = naiveWallClock ? parseETDateTime(raw.replace(/\.\d+$/, '')) : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function firstValidTimestamp(...values) {
  for (const value of values) {
    const timestamp = validTimestamp(value);
    if (timestamp) return timestamp;
  }
  return null;
}

function publicTimingFields(record = {}) {
  return {
    arrived_at: validTimestamp(record.arrived_at) || null,
    actual_start_time: validTimestamp(record.actual_start_time) || null,
    check_in_time: validTimestamp(record.check_in_time) || null,
    completed_at: validTimestamp(record.completed_at) || null,
    actual_end_time: validTimestamp(record.actual_end_time) || null,
    check_out_time: validTimestamp(record.check_out_time) || null,
    started_at: validTimestamp(record.started_at) || null,
    ended_at: validTimestamp(record.ended_at) || null,
  };
}

function workflowEventTimestamp(workflowEvents = [], type) {
  const event = workflowEvents.find((candidate) => candidate?.type === type && candidate?.status !== 'pending');
  return validTimestamp(event?.timestamp) || null;
}

function resolveReportArrivalTime(service = {}, scheduledService = {}, options = {}) {
  const structured = options.structured || {};
  const serviceData = options.serviceData || {};
  return firstValidTimestamp(
    service.arrived_at,
    service.actual_start_time,
    service.check_in_time,
    service.started_at,
    structured.arrivedAt,
    structured.arrived_at,
    serviceData.arrivedAt,
    serviceData.arrived_at,
    workflowEventTimestamp(options.workflowEvents, 'arrived_on_site'),
    scheduledService?.arrived_at,
    scheduledService?.actual_start_time,
    scheduledService?.check_in_time,
  );
}

function resolveReportCompletionTime(service = {}, scheduledService = {}, options = {}) {
  const structured = options.structured || {};
  const serviceData = options.serviceData || {};
  return firstValidTimestamp(
    service.completed_at,
    service.actual_end_time,
    service.check_out_time,
    service.ended_at,
    structured.serviceCompletedAt,
    structured.service_completed_at,
    serviceData.serviceCompletedAt,
    serviceData.service_completed_at,
    workflowEventTimestamp(options.workflowEvents, 'service_completed'),
    scheduledService?.completed_at,
    scheduledService?.actual_end_time,
    scheduledService?.check_out_time,
  );
}

function normalizeGeometry(value) {
  const geometry = parseJsonObject(value);
  const candidate = geometry.type === 'Feature' && geometry.geometry ? geometry.geometry : geometry;
  if (!candidate || typeof candidate !== 'object') return null;
  if (['Polygon', 'MultiPolygon', 'LineString', 'MultiLineString', 'Point'].includes(candidate.type)) {
    return candidate;
  }
  return null;
}

function closeRing(points) {
  if (!points.length) return [];
  const ring = points.map(([x, y]) => [Number(x) || 0, Number(y) || 0]);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first]);
  return ring;
}

function localGeometryToGeoJson(value) {
  const geometry = parseJsonObject(value);
  if (!geometry || typeof geometry !== 'object') return null;
  if (geometry.type === 'polygon' && Array.isArray(geometry.points) && geometry.points.length) {
    return { type: 'Polygon', coordinates: [closeRing(geometry.points)] };
  }
  if (Array.isArray(geometry.points) && geometry.points.length) {
    return { type: 'Polygon', coordinates: [closeRing(geometry.points)] };
  }
  if (geometry.type === 'circle' || (geometry.cx != null && geometry.cy != null)) {
    return { type: 'Point', coordinates: [Number(geometry.cx) || 0, Number(geometry.cy) || 0] };
  }
  const x = Number(geometry.x);
  const y = Number(geometry.y);
  const w = Number(geometry.w);
  const h = Number(geometry.h);
  if ([x, y, w, h].some((n) => !Number.isFinite(n))) return null;
  return {
    type: 'Polygon',
    coordinates: [[
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
      [x, y],
    ]],
  };
}

function zoneCoverageGeometry(zone = {}) {
  return normalizeGeometry(zone.geometry_geojson)
    || localGeometryToGeoJson(zone.geometry)
    || localGeometryToGeoJson(zone.geometry_image);
}

function zoneCoverageImageGeometry(zone = {}) {
  return normalizeGeometry(zone.geometry_image)
    || localGeometryToGeoJson(zone.geometry_image);
}

function polygonToLineGeometry(geometry) {
  if (!geometry) return null;
  if (geometry.type === 'Polygon') {
    const ring = Array.isArray(geometry.coordinates?.[0]) ? geometry.coordinates[0] : [];
    return ring.length ? { type: 'LineString', coordinates: ring } : null;
  }
  if (geometry.type === 'MultiPolygon') {
    const lines = (geometry.coordinates || [])
      .map((polygon) => Array.isArray(polygon?.[0]) ? polygon[0] : [])
      .filter((ring) => ring.length);
    return lines.length ? { type: 'MultiLineString', coordinates: lines } : null;
  }
  return null;
}

function geometryCoordinatePairs(value, output = []) {
  if (!Array.isArray(value)) return output;
  if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
    output.push([Number(value[0]), Number(value[1])]);
    return output;
  }
  value.forEach((entry) => geometryCoordinatePairs(entry, output));
  return output;
}

function pointFromGeometry(geometry) {
  if (!geometry) return null;
  if (geometry.type === 'Point' && Array.isArray(geometry.coordinates)) return geometry;
  const pairs = geometryCoordinatePairs(geometry.coordinates);
  if (!pairs.length) return null;
  const xs = pairs.map(([x]) => x);
  const ys = pairs.map(([, y]) => y);
  return {
    type: 'Point',
    coordinates: [
      (Math.min(...xs) + Math.max(...xs)) / 2,
      (Math.min(...ys) + Math.max(...ys)) / 2,
    ],
  };
}

function isPerimeterZone(zone = {}) {
  const text = `${zone.label || ''} ${zone.category || ''}`.toLowerCase();
  return /\b(perimeter|foundation|fence|fenceline|exterior|entry|threshold)\b/.test(text);
}

function normalizeCoverageLabel(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function findZoneForLocation(entry = {}, zones = []) {
  const zoneId = entry.zoneId || entry.zone_id || entry.locationId || entry.location_id;
  if (zoneId) {
    const match = zones.find((zone) => String(zone.id) === String(zoneId));
    if (match) return match;
  }
  const name = normalizeCoverageLabel(entry.name || entry.label || entry.area || entry.location);
  if (!name) return null;
  return zones.find((zone) => {
    const zoneLabel = normalizeCoverageLabel(zone.label);
    return zoneLabel === name || zoneLabel.includes(name) || name.includes(zoneLabel);
  }) || null;
}

function normalizeExplicitServiceLocation(location = {}, index, fallbackServiceType, fallbackEvidenceLevel) {
  const serviceType = coverageServiceType(location.serviceType || location.service_type || fallbackServiceType);
  const fallbackStatus = serviceType === 'lawn' ? 'treated' : 'serviced';
  const geometry = normalizeGeometry(location.geometry) || localGeometryToGeoJson(location.geometry);
  const imageGeometry = normalizeGeometry(location.imageGeometry || location.image_geometry || location.geometryImage || location.geometry_image)
    || localGeometryToGeoJson(location.imageGeometry || location.image_geometry || location.geometryImage || location.geometry_image);
  const visibleNote = String(location.customerVisibleNote || location.customer_visible_note || '').trim();
  const areaSqFt = numberOrNull(location.areaSqFt ?? location.area_sqft);
  const evidenceLevel = location.evidenceLevel || location.evidence_level || fallbackEvidenceLevel || 'technician_confirmed';

  return {
    id: String(location.id || `service-location-${index + 1}`),
    serviceType,
    name: String(location.name || location.label || `Service area ${index + 1}`).trim(),
    description: String(location.description || '').trim() || undefined,
    areaSqFt: areaSqFt == null ? undefined : areaSqFt,
    status: normalizeStatus(location.status, fallbackStatus),
    geometry: geometry || undefined,
    imageGeometry: imageGeometry || undefined,
    skippedReason: String(location.skippedReason || location.skipped_reason || '').trim() || undefined,
    blockedReason: String(location.blockedReason || location.blocked_reason || '').trim() || undefined,
    customerVisibleNote: visibleNote || undefined,
    evidenceLevel,
    deviceType: location.deviceType || location.device_type || undefined,
    deviceId: location.deviceId || location.device_id || undefined,
  };
}

function configuredServiceLocations(structured = {}, serviceData = {}, serviceType, evidenceLevel) {
  const candidates = [
    serviceData.serviceLocations,
    serviceData.service_locations,
    serviceData.coverage?.serviceLocations,
    serviceData.coverage?.service_locations,
    structured.serviceLocations,
    structured.service_locations,
    structured.coverage?.serviceLocations,
    structured.coverage?.service_locations,
  ];
  const source = candidates.find((value) => Array.isArray(value));
  if (!source) return [];
  return source
    .map((location, index) => normalizeExplicitServiceLocation(location, index, serviceType, evidenceLevel))
    .filter((location) => location.name);
}

function exceptionEntries(structured = {}, serviceData = {}) {
  return [
    ...parseJsonArray(structured.skippedAreas).map((entry) => ({ entry, status: 'skipped' })),
    ...parseJsonArray(structured.skipped_locations).map((entry) => ({ entry, status: 'skipped' })),
    ...parseJsonArray(serviceData.skippedAreas).map((entry) => ({ entry, status: 'skipped' })),
    ...parseJsonArray(serviceData.skippedLocations).map((entry) => ({ entry, status: 'skipped' })),
    ...parseJsonArray(structured.inaccessibleAreas).map((entry) => ({ entry, status: 'inaccessible' })),
    ...parseJsonArray(serviceData.inaccessibleAreas).map((entry) => ({ entry, status: 'inaccessible' })),
    ...parseJsonArray(structured.blockedAreas).map((entry) => ({ entry, status: 'blocked' })),
    ...parseJsonArray(serviceData.blockedAreas).map((entry) => ({ entry, status: 'blocked' })),
  ];
}

function normalizeExceptionLocation(item, index, zones, serviceType, evidenceLevel) {
  const entry = typeof item.entry === 'string' ? { name: item.entry } : parseJsonObject(item.entry);
  const zone = findZoneForLocation(entry, zones);
  const status = normalizeStatus(entry.status || item.status, item.status);
  const reason = String(entry.reason || entry.skippedReason || entry.skipped_reason || entry.blockedReason || entry.blocked_reason || '').trim();
  const geometry = normalizeGeometry(entry.geometry) || localGeometryToGeoJson(entry.geometry) || (zone ? zoneCoverageGeometry(zone) : null);
  const imageGeometry = normalizeGeometry(entry.imageGeometry || entry.image_geometry || entry.geometryImage || entry.geometry_image)
    || localGeometryToGeoJson(entry.imageGeometry || entry.image_geometry || entry.geometryImage || entry.geometry_image)
    || (zone ? zoneCoverageImageGeometry(zone) : null);
  return {
    id: String(entry.id || `coverage-exception-${index + 1}`),
    serviceType,
    zoneId: zone?.id ? String(zone.id) : undefined,
    name: String(entry.name || entry.label || zone?.label || `Skipped area ${index + 1}`).trim(),
    status,
    geometry: geometry || undefined,
    imageGeometry: imageGeometry || undefined,
    skippedReason: status === 'skipped' || status === 'inaccessible' ? reason || undefined : undefined,
    blockedReason: status === 'blocked' ? reason || undefined : undefined,
    customerVisibleNote: String(entry.customerVisibleNote || entry.customer_visible_note || '').trim() || undefined,
    evidenceLevel,
  };
}

function applicationZoneMap(applications = []) {
  const map = new Map();
  applications.forEach((app) => {
    applicationZoneIds(app).forEach((zoneId) => {
      const key = String(zoneId);
      const rows = map.get(key) || [];
      rows.push(app);
      map.set(key, rows);
    });
  });
  return map;
}

function findingCoverageText(finding = {}) {
  return [
    finding.category,
    finding.title,
    finding.detail,
  ].filter(Boolean).join(' ');
}

function findingSuggestsCleanCoverage(finding = {}) {
  const text = findingCoverageText(finding).toLowerCase().replace(/[_-]+/g, ' ');
  return /\b(no activity|no visible activity|no significant activity|none observed|not observed|no visible signs|clear|clean)\b/.test(text)
    || /\b(no|not|none|without)\b.{0,45}\b(activity|entry point|entry points|entry|pest|dropping|droppings|trail|gap|opening)\b/.test(text);
}

function findingSuggestsEntryPoint(finding = {}) {
  if (findingSuggestsCleanCoverage(finding)) return false;
  return /\b(entry|gap|opening|hole|weep|threshold|door|window|penetration)\b/i.test(findingCoverageText(finding));
}

function findingSuggestsActivity(finding = {}) {
  if (findingSuggestsCleanCoverage(finding)) return false;
  return /\b(activity|trail|dropping|nest|harborage|ant|roach|rodent|termite|wasp|mosquito|pest)\b/i.test(findingCoverageText(finding));
}

function deviceTypeFromApplication(app = {}) {
  const text = `${app.method || ''} ${app.product?.category || ''} ${app.product?.name || ''}`.toLowerCase();
  if (text.includes('trap')) return 'trap';
  if (text.includes('monitor')) return 'monitor';
  if (text.includes('bait') || text.includes('station')) return 'bait_station';
  return 'other';
}

function serviceCoverageLocations({ serviceLine, structured, serviceData, zones, applications, findings, areaLabels, evidenceLevel }) {
  const serviceType = coverageServiceType(serviceLine);
  const configured = configuredServiceLocations(structured, serviceData, serviceType, evidenceLevel);
  if (configured.length) return configured;

  const appByZone = applicationZoneMap(applications);
  const findingsByZone = new Map();
  findings.forEach((finding) => {
    if (!finding.zoneId) return;
    const key = String(finding.zoneId);
    const rows = findingsByZone.get(key) || [];
    rows.push(finding);
    findingsByZone.set(key, rows);
  });

  const areaLabelSet = new Set(locationAreaLabels(areaLabels).map(normalizeCoverageLabel));
  const exceptions = exceptionEntries(structured, serviceData)
    .map((entry, index) => normalizeExceptionLocation(entry, index, zones, serviceType, evidenceLevel))
    .filter((location) => location.name);
  const exceptionZoneIds = new Set(exceptions.map((location) => location.zoneId).filter(Boolean).map(String));
  const exceptionNames = new Set(exceptions.map((location) => normalizeCoverageLabel(location.name)));
  const locations = [];

  zones.forEach((zone, index) => {
    const zoneId = String(zone.id);
    const zoneName = String(zone.label || `Service area ${index + 1}`).trim();
    const zoneNameKey = normalizeCoverageLabel(zoneName);
    if (exceptionZoneIds.has(zoneId) || exceptionNames.has(zoneNameKey)) return;

    const zoneApps = appByZone.get(zoneId) || [];
    const zoneFindings = findingsByZone.get(zoneId) || [];
    const hasApplication = zoneApps.length > 0;
    const hasListedArea = areaLabelSet.has(zoneNameKey);
    const hasFinding = zoneFindings.length > 0;
    if (!hasApplication && !hasListedArea && !hasFinding) return;

    const baseGeometry = zoneCoverageGeometry(zone);
    const baseImageGeometry = zoneCoverageImageGeometry(zone);
    const shouldDrawLine = serviceType === 'pest_control' && hasApplication && isPerimeterZone(zone);
    const geometry = shouldDrawLine ? (polygonToLineGeometry(baseGeometry) || baseGeometry) : baseGeometry;
    const imageGeometry = shouldDrawLine ? (polygonToLineGeometry(baseImageGeometry) || baseImageGeometry) : baseImageGeometry;
    const areaSqFt = numberOrNull(zone.area_sqft ?? zone.areaSqFt);
    const fallbackStatus = serviceType === 'lawn'
      ? (hasApplication ? 'treated' : 'inspected')
      : (hasApplication ? 'serviced' : 'inspected');

    locations.push({
      id: `zone-${zoneId}`,
      serviceType,
      zoneId,
      name: zoneName,
      description: zone.category || undefined,
      areaSqFt: areaSqFt == null ? undefined : areaSqFt,
      status: fallbackStatus,
      geometry: geometry || undefined,
      imageGeometry: imageGeometry || undefined,
      evidenceLevel,
    });
  });

  if (serviceType === 'pest_control') {
    applications.forEach((app, appIndex) => {
      if (app.method !== 'station_check') return;
      applicationZoneIds(app).forEach((zoneId, zoneIndex) => {
        const zone = zones.find((candidate) => String(candidate.id) === String(zoneId));
        if (!zone) return;
        const point = pointFromGeometry(zoneCoverageGeometry(zone));
        const imagePoint = pointFromGeometry(zoneCoverageImageGeometry(zone));
        locations.push({
          id: `device-${app.id || appIndex}-${zoneId}`,
          serviceType,
          zoneId: String(zoneId),
          name: zone.label ? `${zone.label} device` : `Device ${zoneIndex + 1}`,
          status: 'device_checked',
          geometry: point || undefined,
          imageGeometry: imagePoint || undefined,
          evidenceLevel: 'device_logged',
          deviceType: deviceTypeFromApplication(app),
          deviceId: app.deviceId || app.device_id || undefined,
        });
      });
    });

    findings
      .filter((finding) => finding.zoneId && (findingSuggestsActivity(finding) || findingSuggestsEntryPoint(finding)))
      .forEach((finding, index) => {
        const zone = zones.find((candidate) => String(candidate.id) === String(finding.zoneId));
        if (!zone) return;
        const status = findingSuggestsEntryPoint(finding) ? 'entry_point_found' : 'activity_found';
        const point = pointFromGeometry(zoneCoverageGeometry(zone));
        const imagePoint = pointFromGeometry(zoneCoverageImageGeometry(zone));
        locations.push({
          id: `finding-${finding.id || index}`,
          serviceType,
          zoneId: String(finding.zoneId),
          name: zone.label || finding.title || `Activity noted ${index + 1}`,
          status,
          geometry: point || undefined,
          imageGeometry: imagePoint || undefined,
          customerVisibleNote: finding.detail || finding.title || undefined,
          evidenceLevel,
        });
      });
  }

  return [...locations, ...exceptions].filter((location, index, all) => {
    const key = `${location.id}:${location.status}:${normalizeCoverageLabel(location.name)}`;
    return all.findIndex((candidate) => `${candidate.id}:${candidate.status}:${normalizeCoverageLabel(candidate.name)}` === key) === index;
  });
}

function workflowLabel(type, serviceLine) {
  const labels = {
    scheduled: 'Scheduled',
    technician_en_route: 'Technician en route',
    technician_on_site: 'Technician on site',
    arrived_on_site: 'Technician on site',
    inspection_started: 'Inspection started',
    service_started: 'Service started',
    service_completed: 'Service completed',
    quality_reviewed: 'Quality reviewed',
    report_published: 'Report published',
    follow_up_recommended: 'Follow-up recommended',
    return_visit_needed: 'Return visit needed',
  };
  if (type === 'inspection_started' && coverageServiceType(serviceLine) === 'lawn') return 'Property check started';
  return labels[type] || 'Service update';
}

function workflowDescription(type, serviceLine) {
  const serviceType = coverageServiceType(serviceLine);
  if (type === 'technician_en_route') return 'Your technician was on the way to the property.';
  if (type === 'technician_on_site' || type === 'arrived_on_site') return 'Your technician was recorded at the property.';
  if (type === 'inspection_started') {
    return serviceType === 'pest_control'
      ? 'Your technician inspected the scheduled service areas.'
      : 'Your technician checked the scheduled service areas.';
  }
  if (type === 'service_started') return serviceType === 'lawn' ? 'Lawn service began.' : 'Service began.';
  if (type === 'service_completed') {
    if (serviceLine === 'pest' || serviceType === 'pest_control') return 'Your technician completed the pest control service and finalized the report.';
    if (serviceLine === 'lawn') return 'Your technician completed the lawn service and finalized the report.';
    if (serviceLine === 'termite') return 'Your technician completed the termite service and finalized the report.';
    if (serviceLine === 'tree_shrub') return 'Your technician completed the tree and shrub service and finalized the report.';
    if (serviceLine === 'mosquito') return 'Your technician completed the mosquito service and finalized the report.';
    if (serviceLine === 'rodent') return 'Your technician completed the rodent service and finalized the report.';
    return 'Your technician completed the service and finalized the report.';
  }
  if (type === 'quality_reviewed') return 'The visit details were reviewed before publishing.';
  if (type === 'report_published') return 'Your service report was generated.';
  if (type === 'follow_up_recommended') return 'A follow-up was recommended based on today’s visit.';
  if (type === 'return_visit_needed') return 'A return visit was noted for this service.';
  return '';
}

function normalizeWorkflowEvent(event = {}, index, serviceLine) {
  const type = normalizeWorkflowType(event.type || event.eventType || event.event_name);
  const timestamp = validTimestamp(event.timestamp || event.occurredAt || event.occurred_at || event.time);
  if (!timestamp) return null;
  const status = ['completed', 'current', 'pending', 'skipped'].includes(event.status) ? event.status : 'completed';
  return {
    id: String(event.id || `${type}-${index + 1}`),
    type,
    label: String(event.label || workflowLabel(type, serviceLine)).trim(),
    timestamp,
    status,
    customerVisibleDescription: String(event.customerVisibleDescription || event.customer_visible_description || '').trim()
      || workflowDescription(type, serviceLine)
      || undefined,
  };
}

function configuredWorkflowEvents(structured = {}, serviceData = {}, serviceLine) {
  const candidates = [
    serviceData.workflowEvents,
    serviceData.workflow_events,
    structured.workflowEvents,
    structured.workflow_events,
  ];
  const source = candidates.find((value) => Array.isArray(value));
  if (!source) return [];
  return source.map((event, index) => normalizeWorkflowEvent(event, index, serviceLine)).filter(Boolean);
}

function buildWorkflowEvents({ service = {}, structured = {}, serviceData = {}, serviceLine }) {
  const configured = configuredWorkflowEvents(structured, serviceData, serviceLine);
  if (configured.length) return configured.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  const events = [];
  const add = (type, candidates, description) => {
    const list = Array.isArray(candidates) ? candidates : [{ value: candidates }];
    const candidate = list.find((entry) => entry?.value);
    const normalizedTimestamp = validTimestamp(candidate?.value);
    if (!normalizedTimestamp) return;
    if (events.some((event) => event.type === type && event.timestamp === normalizedTimestamp)) return;
    events.push({
      id: type,
      type,
      label: workflowLabel(type, serviceLine),
      timestamp: normalizedTimestamp,
      status: 'completed',
      customerVisibleDescription: description || workflowDescription(type, serviceLine) || undefined,
    });
  };

  add('technician_en_route', [
    { value: service.en_route_at },
    { value: service.scheduled_en_route_at },
    { value: structured.enRouteAt },
    { value: serviceData.enRouteAt },
  ]);
  add('arrived_on_site', [
    { value: service.arrived_at },
    { value: service.actual_start_time },
    { value: service.check_in_time },
    { value: structured.arrivedAt },
    { value: serviceData.arrivedAt },
    { value: service.scheduled_arrived_at },
    { value: service.scheduled_actual_start_time },
    { value: service.scheduled_check_in_time },
    { value: service.started_at },
  ]);
  add('inspection_started', structured.inspectionStartedAt || structured.inspection_started_at || serviceData.inspectionStartedAt || serviceData.inspection_started_at);
  add('service_started', structured.serviceStartedAt || structured.service_started_at || serviceData.serviceStartedAt || serviceData.service_started_at);
  add('service_completed', [
    { value: service.completed_at },
    { value: service.actual_end_time },
    { value: service.check_out_time },
    { value: structured.serviceCompletedAt },
    { value: structured.service_completed_at },
    { value: serviceData.serviceCompletedAt },
    { value: serviceData.service_completed_at },
    { value: service.scheduled_completed_at },
    { value: service.scheduled_actual_end_time },
    { value: service.scheduled_check_out_time },
    { value: service.ended_at },
  ]);
  add('quality_reviewed', structured.qualityReviewedAt || structured.quality_reviewed_at || serviceData.qualityReviewedAt || serviceData.quality_reviewed_at);
  add('report_published', service.report_generated_at || structured.reportPublishedAt || structured.report_published_at || serviceData.reportPublishedAt || serviceData.report_published_at);

  return events
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
    .filter((event, index, all) => (
      all.findIndex((candidate) => candidate.type === event.type) === index
    ));
}

async function photoUrl(photo) {
  // Presign from s3_key FIRST: service_photos.s3_url is a legacy stored-URL
  // column whose values expire/go stale (see the track-public.js note) — it
  // only remains as the fallback for ancient rows that never got a key.
  if (photo.s3_key && PhotoService) {
    try {
      return await PhotoService.getViewUrl(photo.s3_key, PhotoService.CUSTOMER_DWELL_TTL_SECONDS);
    } catch {
      /* fall through to the legacy stored URL */
    }
  }
  return photo.s3_url || null;
}

function buildProtocolPayload(record) {
  const structured = parseJsonObject(record.structured_notes);
  const serviceData = parseJsonObject(record.service_data);
  const protocol = parseJsonObject(serviceData.protocol);
  return {
    actions: uniqueStrings([
      ...parseJsonArray(protocol.actions),
      ...parseJsonArray(structured.protocolActionsCompleted),
      ...taggedNoteLines(record.technician_notes, ['protocol', 'protocol optional', 'action']),
    ]),
    observations: uniqueStrings([
      ...parseJsonArray(protocol.observations),
      ...parseJsonArray(structured.observations),
      ...taggedNoteLines(record.technician_notes, ['found']),
    ]),
    recommendations: uniqueStrings([
      ...parseJsonArray(protocol.recommendations),
      ...parseJsonArray(structured.recommendations),
      ...taggedNoteLines(record.technician_notes, ['next']),
    ]),
    visitOutcome: protocol.visitOutcome || structured.visitOutcome || null,
  };
}

// Customer concern as captured at completion. The completion flow persists
// the tech's concern text as structured_notes.customerConcernText
// (admin-dispatch buildServiceRecordInsert); older/manual rows may carry the
// other spellings. Every reader goes through this helper — the V2 builders
// read `customerConcern` alone for a month, so the "what you flagged"
// concern card never rendered on any lawn or tree & shrub report
// (T&S audit 2026-07-18 P1).
function structuredCustomerConcern(structured = {}) {
  return String(
    structured.customerConcernText
    || structured.customer_concern_text
    || structured.customerConcern
    || structured.customer_concern
    || '',
  ).trim();
}

// LIVE-VIEW-ONLY schedule fields, stripped from every non-live render in one
// place: cached PDFs / static renders are content-key-insensitive snapshots,
// and a reschedule after render would leave a stale appointment fossilized in
// the downloadable document. Covers the top-level nextAppointment AND the V2
// snapshot's nextVisit (lawn + tree & shrub) — the queued PDF renderer
// (pdf-queue.js) builds its payload outside the route helper, so the strip
// must be shared, not route-inlined (codex P2 2026-07-18).
function stripLiveOnlyScheduleFields(data) {
  if (!data || typeof data !== 'object') return data;
  delete data.nextAppointment;
  if (data.reportV2?.snapshot?.nextVisit) delete data.reportV2.snapshot.nextVisit;
  return data;
}

function shouldAddNoActivityFinding({ service = {}, structured = {}, protocol = {}, interiorOnlyLane = false } = {}) {
  const visitOutcome = String(protocol.visitOutcome || service.visit_outcome || service.status || 'completed').toLowerCase();
  const concernText = structuredCustomerConcern(structured);
  // A positive activity rating recorded at completion means SOMETHING was
  // seen — synthesizing "all zones clear" beside it re-creates the exact
  // contradiction the insert guard now prevents (codex P1 #3043 r2).
  const rating = Number(service.client_pest_rating);
  // Infestation-class interior lanes (bed bug, untyped post-20260731400000)
  // never INFER "no activity" from blank optional fields — the visit exists
  // because activity was found; only an EXPLICIT 0 rating states the zero
  // (mirrors the completion-side insert guard, codex P2 r7). Raw-null check
  // first: Number(null) coerces to 0, which would read a MISSING rating as
  // an explicit zero (codex P2 r8).
  if ((interiorOnlyLane || /\bbed\s*bugs?\b/i.test(String(service.service_type || '')))
    && !(service.client_pest_rating != null && Number(service.client_pest_rating) === 0)) {
    return false;
  }
  return visitOutcome === 'completed'
    && !(protocol.observations || []).length
    && !(protocol.recommendations || []).length
    && !concernText
    && !(Number.isFinite(rating) && rating > 0);
}

function findingSeverityForObservation(text) {
  const lower = String(text || '').toLowerCase();
  if (lower.includes('customer concern') || lower.includes('access')) return 'medium';
  if (lower.includes('rodent') || lower.includes('fungus')) return 'medium';
  if (lower.includes('standing water') || lower.includes('irrigation')) return 'low';
  return 'low';
}

function lawnScoreValue(value) {
  // A not-scored category arrives from the DB as NULL (JS null) or '' — guard
  // before Number(), because Number(null) and Number('') are both 0, which would
  // make a missing category masquerade as a real score of 0 (dragging the
  // overall down and fabricating before/after deltas).
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
}

// A category delta is meaningful only when BOTH visits scored that category.
// A missing value means "not assessed", not 0 — returning null keeps the report
// from fabricating a full-magnitude improvement/regression against a blank.
function lawnScoreDelta(afterValue, beforeValue) {
  return afterValue == null || beforeValue == null ? null : afterValue - beforeValue;
}

// Legacy lawn assessments (pre single-voice fix) joined each photo's/model's
// observations with ' | ', which surfaced as contradictory run-on prose on the
// report. The current pipeline stores a single primary voice; collapse any
// legacy join to its first segment so old reports read as one voice too.
function singleVoiceObservation(value) {
  const text = String(value || '');
  const idx = text.indexOf(' | ');
  return idx === -1 ? text : text.slice(0, idx).trim();
}

// Consolidated Stress/Damage for the customer view. New rows store it directly;
// pre-stress_damage rows fall back to the worst of the two legacy signals
// (fungus_control, thatch_level) so historical reports still render a value.
function resolveStressDamage(row = {}) {
  const explicit = lawnScoreValue(row.stress_damage);
  if (explicit != null) return explicit;
  const fungus = lawnScoreValue(row.fungus_control);
  const thatch = lawnScoreValue(row.thatch_level);
  if (fungus == null && thatch == null) return null;
  return Math.min(fungus ?? 100, thatch ?? 100);
}

function calculateLawnOverallScore(row = {}) {
  const explicit = lawnScoreValue(row.overall_score);
  // Trust a stored overall only when it was computed under the four-category
  // model (rows that have stress_damage). Legacy rows keep an overall from the
  // old five-signal weighting, so recompute them to match the four displayed
  // bars (Density/Weed/Color/Stress) instead of hidden fungus/thatch weights.
  // lawnScoreValue (not a raw null-check): a legacy '' stress_damage is
  // "not scored" and must recompute too.
  if (explicit != null && lawnScoreValue(row.stress_damage) != null) return explicit;
  // Weighted average of the four displayed categories, null-aware: a category
  // that wasn't scored is excluded and the weights are renormalized over the
  // ones present, so a missing category doesn't count as 0 and drag the overall
  // down. When all four are present this is the plain 30/25/25/20 average.
  const components = [
    [lawnScoreValue(row.turf_density), 0.30],
    [lawnScoreValue(row.weed_suppression), 0.25],
    [lawnScoreValue(row.color_health), 0.25],
    [resolveStressDamage(row), 0.20],
  ].filter(([value]) => value != null);
  if (!components.length) return null;
  const totalWeight = components.reduce((sum, [, weight]) => sum + weight, 0);
  const weighted = components.reduce((sum, [value, weight]) => sum + (value * weight), 0);
  return Math.round(weighted / totalWeight);
}

function formatLawnAssessmentScore(row) {
  if (!row) return null;
  return {
    assessmentId: row.id,
    assessmentDate: row.service_date,
    overallScore: calculateLawnOverallScore(row),
    turfDensity: lawnScoreValue(row.turf_density),
    weedSuppression: lawnScoreValue(row.weed_suppression),
    colorHealth: lawnScoreValue(row.color_health),
    stressDamage: resolveStressDamage(row),
    // fungusControl/thatchScore retained for back-compat consumers; the customer
    // report now presents the four consolidated categories (stressDamage folds
    // these in).
    fungusControl: lawnScoreValue(row.fungus_control),
    thatchScore: lawnScoreValue(row.thatch_level),
    season: row.season || null,
    observations: row.observations || '',
    aiSummary: row.ai_summary || null,
    recommendations: parseJsonObject(row.recommendations),
    stressFlags: parseJsonObject(row.stress_flags),
  };
}

function lawnAssessmentSummary(current, initial, count) {
  if (!current) return '';
  if (!initial || count < 2) {
    return 'This is your first lawn health assessment. Future reports will show the trend.';
  }
  const delta = lawnScoreDelta(current.overallScore, initial.overallScore);
  // One of the two assessments has no overall score yet — don't claim a trend.
  if (delta == null) return 'Lawn health is being tracked across your assessments.';
  if (delta > 0) return `Lawn health is up ${delta} point${delta === 1 ? '' : 's'} since your first assessment.`;
  if (delta < 0) return `Lawn health is down ${Math.abs(delta)} point${Math.abs(delta) === 1 ? '' : 's'} since your first assessment.`;
  return 'Lawn health is holding steady since your first assessment.';
}

function hasLawnAssessmentCustomerSignal(lawnAssessment) {
  if (!lawnAssessment) return false;
  if (String(lawnAssessment.snapshot?.summary || '').trim()) return true;
  if (String(lawnAssessment.customerSummary || '').trim()) return true;
  if (Array.isArray(lawnAssessment.photos) && lawnAssessment.photos.length) return true;
  const scores = lawnAssessment.scores || {};
  if (Object.values(scores).some((value) => value != null && value !== '')) return true;
  if (String(lawnAssessment.observations || '').trim()) return true;
  const recommendations = lawnAssessment.recommendations || {};
  return Object.values(recommendations).some((value) => String(value || '').trim());
}

function lawnProgramFallbackContext() {
  return {
    linked: false,
    title: 'Your Waves Lawn Care Program Overview',
    contextCopy: 'This lawn service report documents what was actually inspected and completed during today\'s visit.',
    distinctionCopy: 'The program overview explains what may be used through the season. This service report documents what was actually done today.',
  };
}

function outlineCandidateEstimateIds(service = {}, scheduledService = {}, structured = {}, serviceData = {}) {
  return uniqueStrings([
    service.estimate_id,
    service.estimateId,
    service.source_estimate_id,
    service.sourceEstimateId,
    scheduledService?.source_estimate_id,
    scheduledService?.sourceEstimateId,
    scheduledService?.estimate_id,
    scheduledService?.estimateId,
    structured.estimateId,
    structured.estimate_id,
    structured.sourceEstimateId,
    structured.source_estimate_id,
    serviceData.estimateId,
    serviceData.estimate_id,
    serviceData.sourceEstimateId,
    serviceData.source_estimate_id,
  ]);
}

function outlineTurfLabel(row = {}) {
  const summary = parseJsonObject(row.summary_json);
  const content = parseJsonObject(row.content_json);
  return summary.turfLabel
    || summary.turfTypeLabel
    || content?.property?.turfTypeLabel
    || content?.property?.turfType
    || row.turf_type
    || null;
}

function outlineProductCardCount(row = {}) {
  const summary = parseJsonObject(row.summary_json);
  const content = parseJsonObject(row.content_json);
  if (Number.isFinite(Number(summary.productCardCount))) return Number(summary.productCardCount);
  if (Array.isArray(content.productCards)) return content.productCards.length;
  if (Array.isArray(content.product_cards)) return content.product_cards.length;
  return 0;
}

function outlineIsoDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return etDateString(date);
}

function outlineReportReferenceAt(service = {}, scheduledService = {}, structured = {}, serviceData = {}) {
  return firstValidTimestamp(
    service.completed_at,
    service.actual_end_time,
    service.check_out_time,
    service.ended_at,
    structured.serviceCompletedAt,
    structured.service_completed_at,
    serviceData.serviceCompletedAt,
    serviceData.service_completed_at,
    scheduledService?.completed_at,
    scheduledService?.actual_end_time,
    scheduledService?.check_out_time,
    service.started_at,
    service.actual_start_time,
    service.check_in_time,
    structured.serviceStartedAt,
    structured.service_started_at,
    serviceData.serviceStartedAt,
    serviceData.service_started_at,
    scheduledService?.started_at,
    scheduledService?.actual_start_time,
    scheduledService?.check_in_time,
    service.service_date ? `${service.service_date}T23:59:59` : null,
    scheduledService?.service_date ? `${scheduledService.service_date}T23:59:59` : null,
  );
}

function selectOutlinePacketColumns(query) {
  return query.select(
    'id',
    'title',
    'status',
    'turf_type',
    'estimate_id',
    'sent_at',
    'approved_at',
    'created_at',
    'first_viewed_at',
    'last_viewed_at',
    'view_count',
    'content_library_version',
    'protocol_version',
    'product_registry_version',
    'template_version',
    'summary_json',
    'content_json',
  );
}

function orderOutlinePacketsByReferenceDate(query) {
  return query.orderByRaw('COALESCE(sent_at, approved_at, created_at) DESC');
}

async function loadLawnProgramOverviewContext(knex, service, serviceLine, scheduledService = null) {
  if (serviceLine !== 'lawn') return null;
  const fallback = lawnProgramFallbackContext();
  const structured = parseJsonObject(service.structured_notes);
  const serviceData = parseJsonObject(service.service_data);
  const customerId = service.customer_id || service.customerId || scheduledService?.customer_id || null;
  const estimateIds = outlineCandidateEstimateIds(service, scheduledService, structured, serviceData);
  const reportReferenceAt = outlineReportReferenceAt(service, scheduledService, structured, serviceData);
  if (!customerId && !estimateIds.length) return fallback;

  let row = null;
  try {
    const baseQuery = () => knex('service_outline_packets')
      .where({ service_line: 'lawn_care' })
      .whereNull('revoked_at')
      .whereIn('status', ['approved', 'sent', 'viewed']);

    const probe = baseQuery();
    if (!probe || typeof probe.whereNull !== 'function' || typeof probe.whereIn !== 'function') return fallback;

    if (estimateIds.length) {
      let estimateQuery = baseQuery().whereIn('estimate_id', estimateIds);
      if (reportReferenceAt && typeof estimateQuery.whereRaw === 'function') {
        estimateQuery = estimateQuery.whereRaw('COALESCE(sent_at, approved_at, created_at) <= ?', [reportReferenceAt]);
      }
      row = await orderOutlinePacketsByReferenceDate(selectOutlinePacketColumns(estimateQuery))
        .first();
    }

    if (!row && customerId) {
      let fallbackQuery = baseQuery().where({ customer_id: customerId });
      if (reportReferenceAt && typeof fallbackQuery.whereRaw === 'function') {
        fallbackQuery = fallbackQuery.whereRaw('COALESCE(sent_at, approved_at, created_at) <= ?', [reportReferenceAt]);
      }
      row = await orderOutlinePacketsByReferenceDate(selectOutlinePacketColumns(fallbackQuery)).first();
    }
  } catch {
    return fallback;
  }

  if (!row) return fallback;
  const referenceAt = row.sent_at || row.approved_at || row.created_at || null;
  const contextVerb = row.sent_at ? 'sent' : (row.approved_at ? 'approved' : 'created');
  const referenceDate = outlineIsoDate(referenceAt);
  const datePhrase = referenceDate ? ` ${contextVerb} on ${referenceDate}` : '';

  return {
    linked: true,
    packetId: row.id,
    estimateId: row.estimate_id || null,
    title: row.title || fallback.title,
    status: row.status || null,
    sentAt: row.sent_at || null,
    approvedAt: row.approved_at || null,
    createdAt: row.created_at || null,
    referenceAt,
    contextVerb,
    viewedAt: row.last_viewed_at || row.first_viewed_at || null,
    viewCount: Number(row.view_count || 0),
    turfType: outlineTurfLabel(row),
    productCardCount: outlineProductCardCount(row),
    contentLibraryVersion: row.content_library_version || null,
    protocolVersion: row.protocol_version || null,
    productRegistryVersion: row.product_registry_version || null,
    templateVersion: row.template_version || null,
    contextCopy: `This visit follows the Waves Lawn Care Program Overview${datePhrase}.`,
    distinctionCopy: fallback.distinctionCopy,
  };
}

function formatApprovedLawnSnapshot(row) {
  if (!row) return null;
  const findings = parseJsonArray(row.findings)
    .map((finding) => ({
      key: finding.key || null,
      label: finding.label || null,
      severity: finding.severity ?? null,
      customerCopy: finding.customer_copy || finding.customerCopy || '',
      locationLabel: finding.location_label || finding.locationLabel || null,
    }))
    .filter((finding) => finding.customerCopy);
  const treatment = parseJsonObject(row.treatment_context);
  const expectedWindow = parseJsonObject(row.expected_window);
  return {
    id: row.id,
    assessmentId: row.assessment_id || null,
    headline: row.headline || '',
    summary: row.summary_customer || '',
    findings,
    treatment: {
      completedToday: treatment.completed_today === true,
      serviceType: treatment.service_type || null,
      productsAppliedSummary: treatment.products_applied_summary || null,
    },
    weatherContext: parseJsonObject(row.weather_context).customer_copy || null,
    expectedWindow: {
      minDays: expectedWindow.min_days || null,
      maxDays: expectedWindow.max_days || null,
    },
    nextWatchItems: parseJsonArray(row.next_watch_items),
    disclaimers: parseJsonArray(row.disclaimers),
    generatedAt: row.generated_at || null,
  };
}

function formatApprovedLawnRecommendation(row) {
  if (!row) return null;
  const action = parseJsonObject(row.recommended_action);
  return {
    id: row.id,
    type: row.type || null,
    title: row.title || '',
    priority: row.priority || 'low',
    customerCopy: row.customer_copy || '',
    action: {
      type: action.action_type || null,
      label: action.cta_label || null,
      plan: action.plan || null,
    },
  };
}

async function loadApprovedLawnSnapshot({ customerId, assessmentId }, knex = db) {
  if (!customerId || !assessmentId) return null;
  let query = knex('property_health_snapshots')
    .where({
      customer_id: customerId,
      assessment_id: assessmentId,
      domain: 'lawn',
      customer_visible: true,
    });
  if (typeof query.whereNotNull === 'function') {
    query = query.whereNotNull('approved_at');
  }
  const row = await query
    .orderBy('created_at', 'desc')
    .first()
    .catch(() => null);
  if (!row?.approved_at) return null;
  return formatApprovedLawnSnapshot(row);
}

async function loadApprovedLawnRecommendationCards({ customerId, snapshotId }, knex = db) {
  if (!customerId || !snapshotId) return [];
  const rows = await knex('property_recommendation_cards')
    .where({
      customer_id: customerId,
      snapshot_id: snapshotId,
      domain: 'lawn',
    })
    .orderBy('created_at', 'asc')
    .catch(() => []);

  const priorityRank = { high: 1, medium: 2, low: 3 };
  return rows
    .filter(isCardCustomerSurfaceable)
    .sort((a, b) => (priorityRank[a.priority] || 4) - (priorityRank[b.priority] || 4))
    .slice(0, 3)
    .map(formatApprovedLawnRecommendation)
    .filter(Boolean);
}

async function lawnPhotoUrl(photo) {
  if (!photo?.s3_key || String(photo.s3_key).startsWith('pending/') || !PhotoService) return null;
  try {
    return await PhotoService.getViewUrl(photo.s3_key, PhotoService.CUSTOMER_DWELL_TTL_SECONDS);
  } catch {
    return null;
  }
}

// Raised when a render pins an assessment that this report cannot legitimately
// show. NEVER fall back to normal resolution on a bad pin: a pinned render is
// how a send fence proves the attachment carries the copy it sealed, and a
// silent fallback would hand back a plausible PDF containing something else —
// the exact divergence the pin exists to rule out (#3168). Fail the render;
// the delivery defers and retries.
class PinnedAssessmentUnavailable extends Error {
  constructor(assessmentId) {
    super(`pinned lawn assessment ${assessmentId} is not linked to this report`);
    this.code = 'pinned_assessment_unavailable';
    this.assessmentId = assessmentId;
  }
}

// ONE lookup, both answers (#3172 r1).
//
// The pin and the storage-key component must describe the SAME assessment. Two
// independent lookups can straddle a selection change: the render gets pinned
// to B while the object is cached under A's key — which is the very race this
// is meant to close, reintroduced by resolving twice.
//
// Returns { pin, signature }:
//   non-lawn record          → { pin: null, signature: '' }        (nothing to pin)
//   lawn visit, assessment   → { pin: <id>, signature: '-la<hash>' }
//   lawn visit, none         → { pin: PIN_NO_ASSESSMENT, signature: '-la0' }
//
// THROWS on an unreadable lookup: a render that cannot determine the canonical
// answer must not proceed as though there were none, and a cache key must not
// be computed from a guess.
// Render-strategy marker (#3172 r1). Objects cached by the PREVIOUS, unpinned
// render path carry the same -la<hash> as a pinned render of the same
// assessment, so without this they would keep being served after deploy —
// including a PDF produced during the very A-to-B-to-A race this change closes,
// accepted indefinitely because its key looks current.
//
// Bumping this orphans lawn PDFs rendered under an older strategy so they
// regenerate once. Non-lawn records return '' and are untouched: no
// fleet-wide bust. Bump it whenever the way a lawn render RESOLVES ITS INPUTS
// changes, not when those inputs' content changes — content is already covered
// by the hash.
//
// p1 → p2: the week's weather is now FROZEN at first render. A PDF cached
// before that keeps the pre-freeze rainfall forever while /data freezes and
// shows a different number — the emailed attachment and the live report
// disagreeing, which is the whole failure class this lane exists to close.
// Bumping forces those lawn PDFs through one fresh render.
const LAWN_RENDER_STRATEGY = 'p2';

async function resolveCanonicalLawnRender(service, knex = db) {
  const line = service?.service_line || detectServiceLine(service?.service_type);
  if (line !== 'lawn') return { pin: null, signature: '' };

  const assessment = await loadLinkedLawnAssessment(service, knex, { failClosed: true });
  if (!assessment?.id) return { pin: PIN_NO_ASSESSMENT, signature: `-la${LAWN_RENDER_STRATEGY}0` };

  const recs = typeof assessment.recommendations === 'string'
    ? assessment.recommendations
    : JSON.stringify(assessment.recommendations || '');
  const stamp = crypto.createHash('sha1')
    .update(`${assessment.id}|${recs}|${assessment.ai_summary || ''}|${assessment.updated_at ? new Date(assessment.updated_at).toISOString() : ''}`)
    .digest('hex')
    .slice(0, 12);
  return { pin: assessment.id, signature: `-la${LAWN_RENDER_STRATEGY}${stamp}` };
}

// Signature-only entry point for CACHE-LOOKUP sites, which must never throw —
// a report view should not 500 because an assessment read blipped. An
// unreadable state yields a value nothing can match, forcing a re-render
// instead of serving a stale object.
async function lawnAssessmentPdfSignature(service, knex = db) {
  try {
    return (await resolveCanonicalLawnRender(service, knex)).signature;
  } catch {
    return `-laerr${crypto.randomBytes(6).toString('hex')}`;
  }
}

// A pinned render must resolve the EXACT assessment it was asked for, and only
// if this report could legitimately show it (#3168).
//
// The authorization boundary: the pin may only select among assessments the
// report token already exposes — same customer, confirmed, and linked to THIS
// service record or its scheduled service. That is deliberately the same
// candidate set loadLinkedLawnAssessment picks from, so a pin can never widen
// what a token can see. An id belonging to another customer, another visit, or
// an unconfirmed row is refused rather than rendered.
//
// Refusal THROWS. Returning null would render a lawn report with no lawn
// section, which is divergence by omission — see PinnedAssessmentUnavailable.
async function loadPinnedLawnAssessment(service, assessmentId, knex = db) {
  if (!service?.customer_id) throw new PinnedAssessmentUnavailable(assessmentId);

  const baseCriteria = { customer_id: service.customer_id, confirmed_by_tech: true, id: assessmentId };
  const scheduledServiceId = service.scheduled_service_id || service.service_id;

  const byRecord = service.id
    ? await knex('lawn_assessments').where({ ...baseCriteria, service_record_id: service.id }).first()
    : null;
  if (byRecord) return byRecord;

  const byService = scheduledServiceId
    ? await knex('lawn_assessments').where({ ...baseCriteria, service_id: scheduledServiceId }).first()
    : null;
  if (byService) return byService;

  throw new PinnedAssessmentUnavailable(assessmentId);
}

// failClosed (issue #3135): the RENDER path treats an unreadable assessment as
// "no assessment" and degrades the card, which is right for a page. A caller
// that fences a SEND cannot do that — swallowing a transient error there would
// dispatch an unfenced attachment, indistinguishable from a genuine non-lawn
// record. Those callers opt in and get the error propagated instead.
async function loadLinkedLawnAssessment(service, knex = db, { failClosed = false } = {}) {
  if (!service?.customer_id) return null;
  const swallow = (err) => {
    if (failClosed) throw err;
    return null;
  };

  const baseCriteria = { customer_id: service.customer_id, confirmed_by_tech: true };
  const byRecord = service.id
    ? await knex('lawn_assessments')
      .where({ ...baseCriteria, service_record_id: service.id })
      .orderBy('confirmed_at', 'desc')
      .orderBy('created_at', 'desc')
      .first()
      .catch(swallow)
    : null;
  if (byRecord) return byRecord;

  const scheduledServiceId = service.scheduled_service_id || service.service_id;
  const byService = scheduledServiceId
    ? await knex('lawn_assessments')
      .where({ ...baseCriteria, service_id: scheduledServiceId })
      .orderBy('confirmed_at', 'desc')
      .orderBy('created_at', 'desc')
      .first()
      .catch(swallow)
    : null;
  if (byService) return byService;

  // Intentionally NO customer-wide fallback. A visit only shows the Lawn
  // Intelligence card for an assessment linked to THIS visit (by service
  // record or scheduled service). Falling back to the customer's most-recent
  // assessment would label last month's scores as today's result, so when the
  // visit has no assessment of its own we show nothing.
  return null;
}

// The sentinel for "this render must show NO lawn assessment" (#3168). A fence
// that sealed an empty selection needs to pin that too: without it the render
// is simply unpinned, and a row that becomes eligible during the browser's
// fetch and ineligible again before the post-render check slips past both
// checks into the attachment.
const PIN_NO_ASSESSMENT = 'none';

// Persist the week's weather so a report token stops restating its rainfall
// (owner ruling 2026-08-03).
//
// FIRST WRITER WINS, enforced in the UPDATE predicate rather than by a
// read-then-write: a live view and a PDF render can render the same record
// concurrently, and with a provider mid-flip they can resolve DIFFERENT weeks.
// A read-modify-write would let the later one overwrite the value the customer
// was already shown — the exact drift this exists to stop. The `?` guard means
// at most one write per record, ever.
//
// Atomic jsonb merge, never a whole-column rewrite: structured_notes carries
// completion SMS state and the frozen lawn synthesis, and a read-modify-write
// here would clobber a concurrent write to those.
//
// Best-effort by design. A failed freeze must not fail a report view; the next
// render simply tries again.
// Returns the week the record is CANONICALLY frozen to — this render's value if
// it won the write, the existing one if another render got there first, or null
// when nothing could be established.
//
// Returning the winner's value (not a boolean) is the point. Losing the race and
// then carrying on with our own independently fetched numbers would emit a
// second, different version of a report that is supposed to be permanent —
// which is the drift this whole mechanism exists to stop, reappearing in the
// mechanism itself.
// A frozen week belongs to the ASSESSMENT it was fetched for, not merely to
// the record. The week is fetched against assessment.service_date, and a record
// can carry more than one confirmed assessment — a re-do captured days later
// becomes canonical and legitimately has a different date. Scoping the snapshot
// to the record alone would replay the first assessment's rainfall and ET₀
// underneath the new assessment's scores while its PDF signature correctly
// changed: the report would show one visit's turf judged against another
// visit's week.
function ymd(value) {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function frozenWeekMatches(frozen, assessment) {
  return !!frozen && typeof frozen === 'object'
    && frozen.assessmentId === assessment?.id
    && ymd(frozen.serviceDate) === ymd(assessment?.service_date);
}

// Snapshots are stored as a MAP keyed by assessment id, never as one object per
// record. Replacing on a differing id looked equivalent and is not: canonical
// selection can move A → B → A (a re-do, then a pinned delivery for the
// original), and each move would destroy the other assessment's snapshot and
// send that report back to mutable provider data — permanence defeated by the
// mechanism meant to provide it. Keyed, every assessment keeps its own frozen
// week and first-writer-wins applies per key.
function storedWeekFor(structuredNotes, assessmentId) {
  if (!assessmentId) return null;
  const map = parseJsonObject(structuredNotes).lawnWeekWeather;
  if (!map || typeof map !== 'object') return null;
  const entry = map[assessmentId];
  return entry && typeof entry === 'object' ? entry : null;
}

async function freezeLawnWeekWeather(serviceRecordId, weekWeather, knex = db) {
  if (!serviceRecordId || !weekWeather || !weekWeather.assessmentId) return null;
  const { assessmentId } = weekWeather;
  try {
    const updated = await knex('service_records')
      .where({ id: serviceRecordId })
      // First writer wins PER ASSESSMENT — the guard is this key's absence, in
      // the predicate, with no preceding read.
      .whereRaw(
        "COALESCE(structured_notes::jsonb, '{}'::jsonb) -> 'lawnWeekWeather' -> ? IS NULL",
        [assessmentId],
      )
      .update({
        // Two-level merge: the inner || adds this key to the existing map
        // (or an empty one), the outer || puts the map back. A top-level ||
        // with the whole object would replace every other assessment's entry.
        structured_notes: knex.raw(
          "COALESCE(structured_notes::jsonb, '{}'::jsonb) || jsonb_build_object('lawnWeekWeather',"
          + " COALESCE(COALESCE(structured_notes::jsonb, '{}'::jsonb) -> 'lawnWeekWeather', '{}'::jsonb) || ?::jsonb)",
          [JSON.stringify({ [assessmentId]: weekWeather })],
        ),
      });
    if (updated > 0) return weekWeather;

    // Lost the race for THIS key: adopt what the winner stored so both renders
    // agree. Another assessment's entry is not ours to read.
    const row = await knex('service_records')
      .where({ id: serviceRecordId })
      .first('structured_notes');
    return storedWeekFor(row?.structured_notes, assessmentId);
  } catch (err) {
    logger.warn(`[report-data] lawn week-weather freeze failed for ${serviceRecordId}: ${err.message}`);
    return null;
  }
}

async function buildLawnAssessmentReportData(service, serviceLine, knex = db, { pinnedAssessmentId = null } = {}) {
  if (serviceLine !== 'lawn') return null;
  // Pinned-empty is unconditional: the attachment provably carries no lawn
  // section, which is exactly what the fence sealed.
  if (pinnedAssessmentId === PIN_NO_ASSESSMENT) return null;
  const assessment = pinnedAssessmentId
    ? await loadPinnedLawnAssessment(service, pinnedAssessmentId, knex)
    : await loadLinkedLawnAssessment(service, knex);
  if (!assessment) return null;

  const allAssessments = await knex('lawn_assessments')
    .where({ customer_id: service.customer_id, confirmed_by_tech: true })
    .orderBy('service_date', 'asc')
    .orderBy('created_at', 'asc')
    .catch(() => []);
  const assessmentIndex = allAssessments.findIndex((row) => String(row.id) === String(assessment.id));
  const historyRows = assessmentIndex >= 0 ? allAssessments.slice(0, assessmentIndex + 1) : allAssessments;
  const initialRow = historyRows[0] || assessment;
  const currentScore = formatLawnAssessmentScore(assessment);
  const initialScore = formatLawnAssessmentScore(initialRow);

  const latestPhotos = await knex('lawn_assessment_photos')
    .where({ assessment_id: assessment.id, customer_visible: true })
    .orderBy('is_best_photo', 'desc')
    .orderBy('quality_score', 'desc')
    .orderBy('photo_order', 'asc')
    .limit(5)
    .catch(() => []);
  const photos = await Promise.all(latestPhotos.map(async (photo) => ({
    id: photo.id,
    url: await lawnPhotoUrl(photo),
    type: photo.photo_type || 'general',
    zone: photo.zone || null,
    isBest: !!photo.is_best_photo,
    qualityScore: photo.quality_score ?? null,
    scores: {
      turfDensity: lawnScoreValue(photo.turf_density),
      weedCoverage: lawnScoreValue(photo.weed_coverage),
      colorHealth: photo.color_health != null ? Number(photo.color_health) : null,
      fungalActivity: photo.fungal_activity || null,
      thatchVisibility: photo.thatch_visibility || null,
    },
    observations: photo.observations || '',
    takenAt: photo.taken_at || photo.created_at || null,
  })));

  let beforeAfter = null;
  if (historyRows.length >= 2) {
    // The before/after slider claims "the same lawn, then vs now" — pairing the
    // best photo of each visit regardless of WHERE it was taken produced a bed
    // photo next to a curb-strip photo (audit 2026-07-28). Pair by ZONE: pull
    // both visits' visible photos (already rank-ordered), find the first shared
    // zone, and take each side's best photo from it — anchoring on only the
    // single best "before" photo missed valid pairs when a lower-ranked zone
    // matched (pre-push audit P1). Photos without recorded zones (older rows)
    // fall back to best-vs-best; when both sides record zones but none match,
    // drop the photo pair (the score delta still reports) rather than show a
    // false comparison.
    const photosFor = (assessmentId) => knex('lawn_assessment_photos')
      .where({ assessment_id: assessmentId, customer_visible: true })
      .orderBy('is_best_photo', 'desc')
      .orderBy('quality_score', 'desc')
      .orderBy('photo_order', 'asc')
      .catch(() => []);
    const [beforeCandidates, afterCandidates] = await Promise.all([
      photosFor(initialRow.id),
      photosFor(assessment.id),
    ]);
    // Only an explicitly recorded zone is a location claim. photo_type looks
    // locational ('front_yard') but the primary save path synthesizes it from
    // UPLOAD ORDER (admin-lawn-assessment.js — i===0 → 'front_yard'), so
    // keying on it would falsely pair two arbitrary first-selected photos as
    // the same area (codex P1 #3038 r3). Photos without real zones fall back
    // to best-vs-best, same as before this change.
    const zoneKey = (p) => String(p?.zone || '').trim().toLowerCase();
    let beforePhoto = null;
    let afterPhoto = null;
    for (const candidate of beforeCandidates) {
      const zone = zoneKey(candidate);
      if (!zone) continue;
      const match = afterCandidates.find((p) => zoneKey(p) === zone);
      if (match) {
        beforePhoto = candidate;
        afterPhoto = match;
        break;
      }
    }
    if (!beforePhoto) {
      const bothSidesZoned = beforeCandidates.some((p) => zoneKey(p))
        && afterCandidates.some((p) => zoneKey(p));
      beforePhoto = beforeCandidates[0] || null;
      // Zones recorded on both sides but disjoint → no honest pair exists.
      afterPhoto = bothSidesZoned ? null : (afterCandidates[0] || null);
    }
    beforeAfter = {
      before: {
        date: initialRow.service_date,
        photoUrl: beforePhoto ? await lawnPhotoUrl(beforePhoto) : null,
        overallScore: calculateLawnOverallScore(initialRow),
        notes: initialRow.observations || '',
      },
      after: {
        date: assessment.service_date,
        photoUrl: afterPhoto ? await lawnPhotoUrl(afterPhoto) : null,
        overallScore: calculateLawnOverallScore(assessment),
        notes: assessment.observations || '',
      },
      improvement: {
        turfDensity: lawnScoreDelta(lawnScoreValue(assessment.turf_density), lawnScoreValue(initialRow.turf_density)),
        weedSuppression: lawnScoreDelta(lawnScoreValue(assessment.weed_suppression), lawnScoreValue(initialRow.weed_suppression)),
        colorHealth: lawnScoreDelta(lawnScoreValue(assessment.color_health), lawnScoreValue(initialRow.color_health)),
        stressDamage: lawnScoreDelta(resolveStressDamage(assessment), resolveStressDamage(initialRow)),
        fungusControl: lawnScoreDelta(lawnScoreValue(assessment.fungus_control), lawnScoreValue(initialRow.fungus_control)),
        thatchLevel: lawnScoreDelta(lawnScoreValue(assessment.thatch_level), lawnScoreValue(initialRow.thatch_level)),
        overall: lawnScoreDelta(calculateLawnOverallScore(assessment), calculateLawnOverallScore(initialRow)),
      },
    };
  }

  const turfProfile = await knex('customer_turf_profiles')
    .where({ customer_id: service.customer_id, active: true })
    .first()
    .catch(() => null);
  const propertyPrefs = await knex('property_preferences')
    .where({ customer_id: service.customer_id })
    .first()
    .catch(() => null);
  const trend = historyRows.map((row) => ({
    date: row.service_date,
    overallScore: calculateLawnOverallScore(row),
    turfDensity: lawnScoreValue(row.turf_density),
    weedSuppression: lawnScoreValue(row.weed_suppression),
    colorHealth: lawnScoreValue(row.color_health),
    stressDamage: resolveStressDamage(row),
    // fungusControl/thatchScore retained for back-compat consumers; the customer
    // report now presents the four consolidated categories (stressDamage folds
    // these in).
    fungusControl: lawnScoreValue(row.fungus_control),
    thatchScore: lawnScoreValue(row.thatch_level),
    season: row.season || null,
  }));
  const snapshot = await loadApprovedLawnSnapshot({
    customerId: service.customer_id,
    assessmentId: assessment.id,
  }, knex);
  const recommendationCards = snapshot
    ? await loadApprovedLawnRecommendationCards({
      customerId: service.customer_id,
      snapshotId: snapshot.id,
    }, knex)
    : [];
  const defaultCustomerSummary = lawnAssessmentSummary(currentScore, initialScore, trend.length);
  const fawnSnapshot = parseJsonObject(assessment.fawn_snapshot);
  // Mirror the report payload's conditions merge (service.conditions +
  // service.weather_data) so the water line reads the same rain the hero
  // weather card shows, even when conditions is empty/stale.
  const completionConditions = {
    ...parseJsonObject(service.conditions),
    ...parseJsonObject(service.weather_data),
  };
  // Trailing-7-day rainfall + reference ET₀ for the water balance, keyed to the
  // SERVICE DATE (not now) so this long-lived report token always renders the
  // same season-consistent balance. Cached + fail-soft: rain null →
  // 'rain_unknown'; ET₀ null → grass×season fallback target.
  let completionRainfall7dInches = null;
  let completionEt0Inches = null;
  let completionDailyRain = null;
  let completionRainConfidence = null;
  let completionRainSource = null;
  // FROZEN AT FIRST RENDER (owner ruling 2026-08-03).
  //
  // Keying the fetch to the service date already made this stable across
  // renders — but only while the ANSWER for that date stayed the same. Flipping
  // GATE_RAIN_MRMS changed the provider underneath, and issued reports silently
  // restated their rainfall: one live token went 1.15" to 3.23" for a visit that
  // happened days earlier. A report token is a permanent, shareable customer
  // document; a customer reopening last week's report must not find different
  // numbers than the ones they were sent.
  //
  // So the first successful render freezes the week's weather onto the record
  // and every later render replays it. Lazy rather than written at completion,
  // because that also settles the reports already issued: each one freezes at
  // its next view instead of continuing to drift with the provider.
  // Set when a week was fetched but could NOT be frozen. A render in that state
  // is not reproducible — the next one may freeze different provider data — so
  // it must never be durably cached (see weekWeatherUnfrozen on the payload).
  let weekWeatherUnfrozen = false;
  // Distinct from unfrozen: nothing FAILED, the week simply cannot be frozen
  // YET. Suppresses caching without blocking delivery — a state time resolves
  // on its own, so the queue waits for it rather than burning retries, and the
  // customer's report email is not held hostage to it. Carries WHY.
  let weekWeatherPendingReason = null;
  const storedWeekWeather = storedWeekFor(service.structured_notes, assessment?.id);
  // Replayed ONLY for the assessment it was frozen for — see frozenWeekMatches.
  const frozenWeekWeather = frozenWeekMatches(storedWeekWeather, assessment) ? storedWeekWeather : null;
  if (frozenWeekWeather) {
    completionRainfall7dInches = frozenWeekWeather.rainInches ?? null;
    completionEt0Inches = frozenWeekWeather.et0Inches ?? null;
    completionDailyRain = Array.isArray(frozenWeekWeather.dailyRain) ? frozenWeekWeather.dailyRain : null;
    completionRainConfidence = frozenWeekWeather.rainConfidence ?? null;
    completionRainSource = frozenWeekWeather.rainSource ?? null;
  } else {
    const latitude = service.customer_latitude ?? service.latitude ?? service.lat;
    const longitude = service.customer_longitude ?? service.longitude ?? service.lng;
    // Whether a fetch was even POSSIBLE. Without coordinates there is nothing to
    // fetch and nothing that will ever change — a blank week is the settled,
    // reproducible answer, so it stays cacheable. Treating it as unresolved
    // would make every render for a property with no geocode permanently
    // uncacheable and defer its report email forever.
    // toCoordinate, not Number.isFinite(Number(x)): Number(null) and Number('')
    // are 0, so an ungeocoded property would read as a valid coordinate at the
    // equator and its blank week would be misfiled as a transient failure.
    const latN = toCoordinate(latitude);
    const lonN = toCoordinate(longitude);
    const hasCoordinates = latN != null && lonN != null && !(latN === 0 && lonN === 0);
    try {
      const weekWeather = await fetchServiceWeekWeather({
        latitude,
        longitude,
        serviceDate: assessment.service_date,
      });
      completionRainfall7dInches = weekWeather.rainInches;
      completionEt0Inches = weekWeather.et0Inches;
      completionDailyRain = weekWeather.dailyRain;
      // 'low' when the pinpoint week was a single-cell model spike and we fell back to
      // the city-collective series — surfaced on the 7-day chart as "Limited data this week".
      completionRainConfidence = weekWeather.rainConfidence;
      // Which provider actually supplied it — drives the customer-facing Source row.
      completionRainSource = weekWeather.rainSource;
      if (!assessment?.id) {
        // Nothing to scope the snapshot to, so it cannot be frozen safely.
        weekWeatherPendingReason = 'no_assessment';
      } else if (!weekWeather.windowClosed) {
        // The service-day window is still ACCUMULATING. Same-day weather is a
        // deliberately short-lived read (30-minute cache, full-day forecast for
        // the remainder) so afternoon convection can still land — freezing it
        // would pin a forecast as the permanent record of a week that has not
        // happened yet. This also covers completion-time synthesis, which runs
        // on the service day and would otherwise freeze before the customer's
        // first view.
        //
        // Not "unfrozen": nothing failed, and blocking the day's report email
        // over a window that is merely open would stop nearly every lawn
        // delivery. It only suppresses durable CACHING, so tomorrow's first
        // render freezes the settled week instead of a stale same-day object
        // being served under a key that still matches.
        weekWeatherPendingReason = 'open_window';
      } else if (completionRainfall7dInches != null) {
        const canonicalWeek = await freezeLawnWeekWeather(service.id, {
          // The snapshot names the question it answers.
          assessmentId: assessment.id,
          serviceDate: ymd(assessment.service_date),
          rainInches: completionRainfall7dInches,
          et0Inches: completionEt0Inches,
          dailyRain: completionDailyRain,
          rainConfidence: completionRainConfidence,
          rainSource: completionRainSource,
          frozenAt: new Date().toISOString(),
        }, knex);
        // Adopt the canonical week even when THIS render lost the race —
        // carrying on with our own numbers would publish a second, different
        // version of a report that is meant to be permanent.
        if (canonicalWeek) {
          // Copied EXACTLY, nulls included. Falling back to this render's own
          // values for a field the winner left null (MRMS supplied rain while an
          // Open-Meteo outage left et0Inches null) would let the winner render a
          // seasonal fallback target while the loser renders an ET₀-derived one
          // — two different reports both claiming the same frozen week.
          completionRainfall7dInches = canonicalWeek.rainInches ?? null;
          completionEt0Inches = canonicalWeek.et0Inches ?? null;
          completionDailyRain = Array.isArray(canonicalWeek.dailyRain) ? canonicalWeek.dailyRain : null;
          completionRainConfidence = canonicalWeek.rainConfidence ?? null;
          completionRainSource = canonicalWeek.rainSource ?? null;
        } else {
          // Neither wrote nor read back a canonical week. The live report still
          // renders (fail soft — a customer should see their report), but this
          // output is NOT reproducible, so it must not be cached: a later view
          // could freeze different data while a stored PDF kept these numbers
          // forever, and no future PDF request would retry the freeze.
          weekWeatherUnfrozen = true;
        }
      } else if (!hasCoordinates) {
        // No geocode YET. This is not settled — the hourly backstop sweep
        // (services/geocoder.js sweepUngeocodedCustomers) actively retries
        // coordinate-less customers and writes their coordinates later, after
        // which /data resolves and freezes a real week. The PDF key encodes
        // neither coordinates nor freeze state, so a blank-weather PDF cached
        // now would keep being downloaded long after the live report showed
        // real rainfall. Uncacheable — but not delivery-blocking, because an
        // address that never geocodes would otherwise hold the report email
        // forever.
        weekWeatherPendingReason = 'no_coordinates';
      } else {
        // A closed window we DID try to resolve and got nothing for: the
        // providers were unreachable or incomplete. Persisting the null would
        // lock in "no rainfall known" forever, so nothing is frozen — but the
        // blank result is transient, and caching it would serve an empty water
        // card under a key that still matches once a later view freezes the
        // real week.
        weekWeatherUnfrozen = true;
      }
    } catch (e) {
      // The fetch itself threw — transient by definition, and no week was
      // resolved. Render soft, cache nothing.
      weekWeatherUnfrozen = true;
    }
  }
  const waterContext = buildLawnWaterContext({
    assessment,
    turfProfile,
    propertyPrefs,
    fawnSnapshot,
    serviceDate: assessment.service_date,
    completionRainfallInchesToday: firstNumber(
      completionConditions.rain_24h_in,
      completionConditions.rainfall_in,
    ),
    completionRainfall7dInches,
    completionEt0Inches,
    completionDailyRain,
    completionRainConfidence,
    completionRainSource,
  });

  return {
    assessmentId: assessment.id,
    serviceRecordId: assessment.service_record_id || null,
    serviceId: assessment.service_id || null,
    assessmentDate: assessment.service_date,
    scores: currentScore,
    initialScores: initialScore,
    trend,
    photos,
    beforeAfter,
    recommendations: parseJsonObject(assessment.recommendations),
    observations: singleVoiceObservation(assessment.observations),
    aiSummary: assessment.ai_summary || null,
    // Explicit vision overwatering tell (mushrooms/standing water/algae), persisted
    // in composite_scores. Cross-checked with the water-balance surplus on the
    // report. Older assessments lack it → client also falls back to a low
    // fungus_control score as fungal/mushroom evidence.
    overwateringSignal: parseJsonObject(assessment.composite_scores).overwatering_signal === true,
    fawnSnapshot,
    waterContext,
    // NOT reproducible: the week was fetched but could not be frozen, so a
    // later render may show different numbers. Any caller that durably caches
    // a render must skip storing when this is true.
    weekWeatherUnfrozen,
    // Why the week could not be frozen yet, when nothing actually failed.
    weekWeatherPendingReason,
    // What CACHE sites gate on — the superset. Delivery gates on
    // weekWeatherUnfrozen alone, so a merely-pending week never blocks a send.
    weekWeatherUncacheable: weekWeatherUnfrozen || !!weekWeatherPendingReason,
    snapshot,
    recommendationCards,
    turfProfile: turfProfile ? {
      grassType: turfProfile.grass_type || null,
      cultivar: turfProfile.cultivar || null,
      sunExposure: turfProfile.sun_exposure || null,
      lawnSqft: turfProfile.lawn_sqft || null,
      irrigationType: turfProfile.irrigation_type || null,
      // The manual wet/dry/good irrigation_status has been retired from the customer
      // report: a tech's once-a-month point-in-time call isn't a meaningful watering
      // signal. Watering guidance now comes from the data-driven water balance
      // (grass×season target vs. portal irrigation inches + 7-day rainfall) in
      // irrigationAdvice / LawnWaterBalance. The column still exists and is read by
      // other surfaces (waveguard-plan-engine), so it is not emitted here.
      irrigationInchesPerWeek: turfProfile.irrigation_inches_per_week
        ?? assessment.irrigation_inches_per_week
        ?? propertyPrefs?.irrigation_inches_per_week
        ?? null,
      soilPh: turfProfile.soil_ph || null,
      knownChinchHistory: !!turfProfile.known_chinch_history,
      knownDiseaseHistory: !!turfProfile.known_disease_history,
      knownDroughtStress: !!turfProfile.known_drought_stress,
    } : (propertyPrefs ? {
      irrigationInchesPerWeek: propertyPrefs.irrigation_inches_per_week ?? null,
    } : null),
    customerSummary: snapshot?.summary || defaultCustomerSummary,
    trendSummary: defaultCustomerSummary,
  };
}

async function buildReportV1Data(service, token, knex = db, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const preloadedPestPressureConfig = Object.prototype.hasOwnProperty.call(opts, 'pestPressureConfig')
    ? opts.pestPressureConfig
    : undefined;
  const preloadedServiceCoverageConfig = Object.prototype.hasOwnProperty.call(opts, 'serviceCoverageConfig')
    ? opts.serviceCoverageConfig
    : undefined;
  const preloadedVisitTimelineConfig = Object.prototype.hasOwnProperty.call(opts, 'visitTimelineConfig')
    ? opts.visitTimelineConfig
    : undefined;
  const serviceLine = service.service_line || detectServiceLine(service.service_type);
  const config = getServiceLineConfig(serviceLine);
  // Images this build EXPECTS but drops because their URL would not resolve
  // (presign failure on a gallery/turf/gauge photo or the traced snapshot).
  // Rides the payload so the cacheability gate — and the page's own render
  // counter — can refuse to cache a silently incomplete PDF (codex P2
  // #3176 r21).
  let imageResolutionFailures = 0;
  // Owner ruling 2026-07-16: the report kicker mirrors the customer's LINKED
  // service on the schedule ("Monthly Lawn Care Service"), so the scheduled
  // row's service_type (the catalog name) wins over the record's snapshot
  // when the visit is linked; unlinked/legacy records keep the snapshot.
  // A REJECTED row lookup is not the same as "unlinked" (codex P2 r22):
  // the flag routes the record into the unresolved-linked-identity
  // sentinel below instead of the editable label fallback.
  let scheduleRowLookupFailed = false;
  const scheduledServiceRow = service.scheduled_service_id
    ? await knex('scheduled_services')
      .where({ id: service.scheduled_service_id })
      .first('id', 'service_id', 'service_type')
      .catch(() => { scheduleRowLookupFailed = true; return null; })
    : null;
  const linkedServiceName = String(scheduledServiceRow?.service_type || '').trim()
    || serviceDisplayName(service);
  // Interior-only lane classification (bed bug): display labels are
  // admin-editable, so the report-time guards (stale-trace suppression,
  // exterior re-entry evidence, no-activity synth) key on the linked
  // profile's STABLE service key, with the label regex as the
  // unlinked/legacy fallback (codex P2 r9). Fail-soft: a resolver error
  // leaves the label fallback standing.
  let interiorOnlyLane = /\bbed\s*bugs?\b/i.test(
    `${service.service_type || ''} ${scheduledServiceRow?.service_type || ''}`,
  );
  // Rodent trapping joins the no-satellite-spray-outline lanes (owner
  // 2026-08-02): nothing is sprayed on a trapping stop, so an exterior
  // outline would be a claim the visit cannot support. Suppressed HERE, at
  // the render point, rather than only by hiding the closeout button —
  // the tech portal exposes a per-row "Trace treatment zone" action and the
  // save endpoint accepts any service type, so a UI-only fix left three
  // other ways to publish one, including traces saved before this change
  // (codex P2 round 3). Same reasoning the bed-bug lane already documents.
  // FAIL CLOSED (codex P2 on #3159): the live profile lookup can throw,
  // return the default profile, or stop matching a repointed service — and a
  // suppression guard that degrades OPEN republishes the exact spray outline
  // it exists to remove. The immutable snapshot is the authority; the live
  // profile only widens it. Seeded before the try/catch so a throw leaves
  // the snapshot verdict standing.
  const snapshotForTrace = parseJsonObject(service.service_data)?.typedReportSnapshot || null;
  const snapshotFindingsType = snapshotForTrace?.type || null;
  let trapLaneNoSprayMap = snapshotFindingsType === 'rodent_trapping';
  let laneProfile = null;
  let laneProfileLookupFailed = false;
  if (!interiorOnlyLane && scheduledServiceRow) {
    try {
      const { resolveCompletionProfileForScheduledService } = require('../service-completion-profiles');
      laneProfile = await resolveCompletionProfileForScheduledService(scheduledServiceRow, knex);
      interiorOnlyLane = laneProfile?.serviceKey === 'bed_bug_treatment';
      trapLaneNoSprayMap = trapLaneNoSprayMap || laneProfile?.findingsType === 'rodent_trapping';
    } catch { laneProfileLookupFailed = true; /* label fallback stands for the legacy belts */ }
  }
  // Centralized trace eligibility (GATE_TRACE_ELIGIBILITY, dark): ONE
  // registry decides whether this report may carry a spray trace,
  // generalizing the two hand-built lane exclusions above (which stay as
  // the gate-off behavior AND as belt-and-suspenders when it is on). The
  // frozen snapshot's findings type outranks the live profile — the same
  // snapshot-is-authority rule the trap lane ratified — and display names
  // are the last-resort fallback. Scoped require matches this file's
  // pattern for report-time helpers.
  const {
    resolveTraceEligibility, combineLineVerdicts, resolveAddonVerdicts,
    addonVerdictsFromLines, renderAreasFromRecord, traceEligibilityGateOn,
  } = require('./trace-eligibility');
  const { loadMarksByS3Key, buildMarkedPhotoContext, photoMarksGateOn } = require('./photo-marks');
  // Completion-frozen primary identity wins over the live profile —
  // update-details can repoint the schedule row after completion (codex
  // P2 r15); legacy records (field absent) keep the live resolution.
  const frozenTraceData = parseJsonObject(service.service_data) || {};
  const hasFrozenPrimary = Object.prototype.hasOwnProperty.call(frozenTraceData, 'completedServiceKey');
  let traceEligibility = resolveTraceEligibility({
    // A LINKED row whose profile lookup failed must not fall to the
    // editable display name — the unresolvable sentinel reuses the
    // supplied-identity fail-closed rule (codex P2 r20). Unlinked legacy
    // rows (no scheduledServiceRow) keep name fallback.
    serviceKey: hasFrozenPrimary
      ? (frozenTraceData.completedServiceKey || null)
      : (laneProfile?.serviceKey
        || ((laneProfileLookupFailed || scheduleRowLookupFailed) ? 'unresolved:linked_service' : null)),
    findingsType: snapshotFindingsType || (hasFrozenPrimary ? null : laneProfile?.findingsType) || null,
    displayName: `${service.service_type || ''} ${hasFrozenPrimary ? (frozenTraceData.completedServiceName || '') : (scheduledServiceRow?.service_type || '')}`,
    // Render side: conditional lanes (roach family) need the frozen
    // snapshot's recorded treatment — null (no snapshot) fails closed —
    // and generic evidence lanes (pest_re_service) read the recorded
    // areas/actions (codex P1 r13).
    typedValues: snapshotForTrace?.values ?? null,
    renderAreas: renderAreasFromRecord(service),
  });
  // The customer report must reach the same multi-line verdict the PDF
  // signature and re-entry resolver reach through the shared helper — an
  // eligible ADD-ON line rescues an ineligible primary here too (codex
  // P2 r12). Fail-soft: an addon lookup error leaves the primary verdict.
  if (traceEligibilityGateOn() && !traceEligibility.eligible) {
    try {
      // Completion-frozen add-on identities win over the mutable schedule
      // rows; legacy records fall back to the live rows (codex P2 r14).
      const frozenAddonLines = parseJsonObject(service.service_data)?.completedAddonLines;
      traceEligibility = combineLineVerdicts(
        traceEligibility,
        Array.isArray(frozenAddonLines)
          ? await addonVerdictsFromLines(frozenAddonLines, knex, { renderSide: true })
          : await resolveAddonVerdicts(service.scheduled_service_id, knex, { renderSide: true }),
      );
    } catch { /* primary verdict stands */ }
  }
  // The 'photo' variant is eligible for a MARKED-PHOTO card, never for the
  // satellite trace: foam is a point application into wall voids with no
  // perimeter and no area. A trace row saved on such a visit (captured before
  // the lane was classified, or through the admin capture path) must not
  // publish a spray band — the client's traced map treats anything that is
  // not 'outline' as spray, so an unsuppressed 'photo' would render as a
  // perimeter claim. Suppress the trace for every non-satellite variant.
  //
  // The photo-lane clause hangs off THIS feature's own gate, not the
  // eligibility gate (codex P1): the rollout explicitly allows
  // GATE_PHOTO_MARKS on while GATE_TRACE_ELIGIBILITY is still off, and in
  // that order an eligibility-gated clause is inert — a foam visit would
  // publish a saved trace under legacy perimeter copy right beside its
  // marked photo, which is the exact false claim this change exists to stop.
  // Hoisted so BOTH consumers below can honour it. Setting traceSuppressed
  // alone was not enough (codex P1 r2): the map loader and the re-entry
  // resolver each branch on traceEligibilityGateOn() and fall back to the
  // legacy lane booleans when it is off, so with only GATE_PHOTO_MARKS on
  // they never read traceSuppressed at all and a pre-existing foam trace
  // still published as a perimeter map with an exterior advisory.
  // Photo decisions must consider EVERY line, not just the primary (codex
  // P1 r3). The add-on combine above is gated on traceEligibilityGateOn(), so
  // with only GATE_PHOTO_MARKS on a foam ADD-ON on an ineligible primary
  // (termite bait + foam) never reached the verdict — and its saved trace
  // published with legacy perimeter copy. Resolved separately rather than by
  // widening the combine above, so a spray/outline add-on cannot start
  // rescuing primaries in a configuration where the registry is otherwise
  // dark; only a PHOTO verdict is adopted here.
  // Scans EVERY line independently rather than reusing combineLineVerdicts
  // (codex P1 r4): that helper returns the primary when it is eligible, or
  // the FIRST eligible add-on, so a foam line sitting behind an eligible
  // trenching primary — or behind an earlier spray/outline add-on — was never
  // seen. markLaneForService meanwhile offered marks for that same line, so a
  // technician could place points the report then silently dropped.
  //
  // Runs under BOTH gate configurations: the combined verdict can be 'spray'
  // from an eligible primary even with the eligibility gate on, so gating this
  // scan on the gate state would leave the same hole. Only the marks gate
  // guards it, and only a 'photo' verdict is ever adopted — the satellite
  // lane's combined verdict above is left untouched.
  let photoLaneVerdict = traceEligibility.variant === 'photo' ? traceEligibility : null;
  // Tracked alongside, because a photo lane must NOT suppress a satellite
  // trace some OTHER line legitimately earned (codex P1 r5). On a mixed
  // trenching+foam visit the tech can save a trenching trace — the capture
  // path and the field feed both use the combined satellite verdict — so
  // suppressing on "a photo lane exists" silently dropped a trace the tech
  // had successfully recorded. The two artifacts coexist: the marked photo
  // shows the drill points, the trace shows the trenched perimeter.
  // The VERDICT, not a boolean (codex P1 r11): the artifact's variant and
  // caption are read off the satellite line, so reducing it to "some line
  // qualifies" left the serializer below with nothing to describe the trace
  // and it fell back to the primary — which on a mixed visit is the FOAM
  // verdict. That published variant:'photo' on a satellite bitmap, a value
  // the client has no branch for, so an outline lane's legacy perimeter
  // capture wore full spray copy instead of the neutral mismatch wording.
  let satelliteVerdict = (traceEligibility.eligible && traceEligibility.variant !== 'photo')
    ? traceEligibility
    : null;
  if ((photoMarksGateOn() || traceEligibilityGateOn())
    && (!photoLaneVerdict || !satelliteVerdict)) {
    try {
      const frozenPhotoLines = parseJsonObject(service.service_data)?.completedAddonLines;
      const lineVerdicts = Array.isArray(frozenPhotoLines)
        ? await addonVerdictsFromLines(frozenPhotoLines, knex, { renderSide: true })
        : await resolveAddonVerdicts(service.scheduled_service_id, knex, { renderSide: true });
      if (!photoLaneVerdict) {
        photoLaneVerdict = (lineVerdicts || [])
          .find((v) => v?.eligible && v.variant === 'photo') || null;
      }
      if (!satelliteVerdict) {
        satelliteVerdict = (lineVerdicts || [])
          .find((v) => v?.eligible && v.variant !== 'photo') || null;
      }
    } catch { /* fail-soft: no photo lane found, the satellite verdict stands */ }
  }
  const satelliteLineEligible = Boolean(satelliteVerdict);
  // Suppress the satellite trace only when the visit has NO satellite-capable
  // line — i.e. the foam IS the treatment, not one line among several.
  const photoLaneSuppressed = photoMarksGateOn()
    && Boolean(photoLaneVerdict)
    && !satelliteLineEligible;
  // Gate-on suppression keys on the independently resolved SATELLITE
  // capability (codex P1 r7): keying it on the primary verdict's variant
  // meant a foam primary suppressed a trace that a satellite-capable add-on
  // legitimately earned — the mixed-visit bug fixed for the marks gate in r6
  // but left standing on this branch.
  const traceSuppressed = (traceEligibilityGateOn() && !satelliteLineEligible)
    || photoLaneSuppressed;
  const structured = parseJsonObject(service.structured_notes);
  const serviceData = parseJsonObject(service.service_data);
  const protocol = buildProtocolPayload(service);
  // Typed specialty completion snapshot (persisted at completion — the
  // immutable source for Today's Result + customer-labeled findings). Its
  // presence suppresses Pest Pressure for this report and swaps in the
  // activity gauge for trend types.
  const typedSnapshot = serviceData.typedReportSnapshot
    && typeof serviceData.typedReportSnapshot === 'object'
    && serviceData.typedReportSnapshot.type
    ? serviceData.typedReportSnapshot
    : null;

  const scheduledServicePromise = service.scheduled_service_id
    ? knex('scheduled_services').where({ id: service.scheduled_service_id }).first().catch(() => null)
    : Promise.resolve(null);
  // The render-time treatment guard must know when this load FAILED versus
  // legitimately returned no rows — an outage-empty product list would let
  // stale recommendation copy publish unreconciled (codex P1 r25).
  let productsLoadFailed = false;
  const [rawProducts, geometryRow, dbZones, dbFindings, photos, scheduledService, approvedVisualMoments, stationRows, stationCheckRows] = await Promise.all([
    knex('service_products').where({ service_record_id: service.id }).orderBy('created_at').catch(() => { productsLoadFailed = true; return []; }),
    knex('property_geometries').where({ customer_id: service.customer_id }).orderBy('version', 'desc').first().catch(() => null),
    knex('property_zones').where({ customer_id: service.customer_id, is_active: true }).orderBy('letter').catch(() => []),
    knex('service_findings').where({ service_record_id: service.id }).orderBy('created_at').catch(() => []),
    knex('service_photos').where({ service_record_id: service.id }).orderBy('sort_order').orderBy('created_at').catch(() => []),
    scheduledServicePromise,
    loadApprovedVisualServiceMomentsForReport(service, knex).catch(() => []),
    // Bait station map (station-map-v1) — fail-soft to [] so a missing table
    // (pre-migration) or a load error never takes down the report. Retired
    // rows load on purpose: report tokens are long-lived and the builder
    // scopes rows to THE VISIT (a station retired after this visit must keep
    // rendering on this report).
    knex('termite_stations').where({ customer_id: service.customer_id }).orderBy('station_number').catch(() => []),
    knex('termite_station_checks').where({ service_record_id: service.id }).catch(() => []),
  ]);
  const products = await attachApprovedReportProductFacts(knex, rawProducts);
  // A failed catalog enrichment degrades class identity the same way a
  // failed base load does (codex P2 r41): rows with product_id but null
  // product_category can no longer be recognized as fungicide/herbicide,
  // so honesty passes must treat the product picture as UNKNOWN, not "no
  // corrective products applied".
  if (products.catalogEnrichmentFailed
    && rawProducts.some((p) => p.product_id && !String(p.product_category || '').trim())) {
    productsLoadFailed = true;
  }

  const areaLabels = locationAreaLabels([
    ...parseJsonArray(service.areas_serviced),
    ...parseJsonArray(structured.areasServiced),
    ...parseJsonArray(structured.areasTreated),
  ]);
  const supportedDbZones = dbZones.filter((zone) => zoneSupportsServiceLine(zone, serviceLine));
  // Re-anchor technician satellite marks against the render-time image ONCE,
  // here — every downstream consumer (coverage items, satellite overlay)
  // then sees one consistent answer. A re-geocoded property shifts marks to
  // the same ground point; untrusted marks (zoom change / large drift) drop
  // to null. allOrNothing: one untrusted mark clears the WHOLE set — the
  // satellite overlay drops schematic-only zones once any zone keeps a mark,
  // so a partial drop would publish a coverage map missing a treated zone;
  // clearing the set sends the report to the schematic fallback instead.
  const driftLat = numberOrNull(service.customer_latitude ?? service.latitude ?? service.lat);
  const driftLng = numberOrNull(service.customer_longitude ?? service.longitude ?? service.lng);
  const resolvedDbZones = resolveZoneRowsImageDrift(supportedDbZones, {
    center: driftLat != null && driftLng != null ? { lat: driftLat, lng: driftLng } : null,
    zoom: Number(geometryRow?.zoom) || 20,
    width: 640,
    height: 340,
  }, { allOrNothing: true });
  const zones = resolvedDbZones.length ? resolvedDbZones : defaultZones(areaLabels, serviceLine);
  const geometry = parseJsonObject(geometryRow?.geometry);
  const effectiveGeometry = Object.keys(geometry).length ? geometry : defaultGeometry();

  const findings = dbFindings.map((finding) => ({
    id: finding.id,
    zoneId: finding.zone_id || null,
    category: finding.category,
    severity: finding.severity,
    title: finding.title,
    detail: finding.detail || '',
    recommendation: finding.recommendation || '',
  }));

  // Render-time honesty pass for PERSISTED no-activity rows: older completions
  // could stamp "All inspected zones were clear…" even when the homeowner
  // reported something during the visit (the insert guard now suppresses these
  // going forward, but stored rows are permanent). When a customer concern is
  // on record, soften the absolute claim so the report never tells a customer
  // "all clear" right after they flagged something (John Kelleher audit
  // 2026-07-29). PEST ONLY — other lines have their own no-activity copy, and
  // the softened sentence must not claim treatment or a scheduled follow-up
  // the record doesn't evidence (codex P2 #3043 ×2).
  if (serviceLine === 'pest') {
    const renderConcern = structuredCustomerConcern(structured);
    if (renderConcern) {
      for (const finding of findings) {
        if (finding.category === 'no_activity') {
          // Title AND detail (r2), in NEUTRAL wording (r3): the concern may
          // be about service or access ("please avoid the herb garden"), so
          // the copy must not characterize it as a pest sighting.
          finding.title = 'No pest activity confirmed this visit';
          finding.detail = 'Inspected areas showed no confirmed pest activity. The note you shared with us is recorded on this visit’s report.';
        }
      }
    }
  }


  for (const observation of protocol.observations) {
    if (findings.some((finding) => finding.title.toLowerCase() === observation.toLowerCase())) continue;
    findings.push({
      id: `observation-${findings.length + 1}`,
      zoneId: null,
      category: 'observation',
      severity: findingSeverityForObservation(observation),
      title: observation,
      detail: '',
      recommendation: '',
    });
  }

  const lawnAssessment = await buildLawnAssessmentReportData(service, serviceLine, knex, {
    pinnedAssessmentId: opts.pinnedLawnAssessmentId || null,
  });
  // Render-time treatment reconciliation (codex P1 r19): the completion SMS
  // links this report immediately — a customer can open it BEFORE the
  // grounded regen or stored-copy sanitize lands, and nothing shown can be
  // retracted. Reconcile recommendation-derived copy against today's
  // applications in-memory as the last line of defense (pure, no DB/LLM);
  // storage is healed separately by the completion pipeline.
  // Guard outcome, consulted again after the narrative overlay (codex P1 r28).
  let lawnTreatmentGuard = null;
  if (serviceLine === 'lawn' && lawnAssessment?.scores) {
    try {
      const { treatmentGuard } = require('../knowledge-bridge');
      const guardProducts = products.map((p) => ({
        product_name: p.product_name,
        product_id: p.product_id || null,
        product_category: p.product_category || p.approved_report_product_facts?.category || null,
      }));
      // FAIL CLOSED on unverifiable categories (codex P1 r24):
      // attachApprovedReportProductFacts fail-softs to unenriched rows on a
      // catalog outage, which would make this guard silently skip. Verify
      // independently: rows still missing a category but carrying a
      // product_id get one direct catalog lookup — an ERROR there means the
      // applied classes are UNKNOWN, and recommendation-derived copy is
      // suppressed outright rather than trusted.
      let categoriesVerified = !productsLoadFailed;
      const unresolvedIds = [...new Set(guardProducts.filter((p) => !p.product_category && p.product_id).map((p) => String(p.product_id)))];
      if (unresolvedIds.length) {
        try {
          const catRows = await knex('products_catalog').whereIn('id', unresolvedIds).select('id', 'category');
          const catById = new Map(catRows.map((c) => [String(c.id), c.category]));
          for (const gp of guardProducts) {
            if (!gp.product_category && gp.product_id) gp.product_category = catById.get(String(gp.product_id)) || null;
          }
        } catch {
          categoriesVerified = false;
        }
      }
      lawnTreatmentGuard = { verified: categoriesVerified, guardProducts, treatmentGuard };
      if (!categoriesVerified) {
        const NEUTRAL_SUMMARY = 'Today’s applications are in place — we’ll track how the lawn responds and adjust at the next visit.';
        const NEUTRAL_RECS = {
          summary: NEUTRAL_SUMMARY,
          recommendations: [],
          nextVisitFocus: 'Recheck the areas treated today and confirm how the lawn is responding to the applications.',
          customerTip: '',
        };
        if (lawnAssessment.scores.recommendations) lawnAssessment.scores.recommendations = { ...NEUTRAL_RECS };
        if (lawnAssessment.recommendations) lawnAssessment.recommendations = { ...NEUTRAL_RECS };
        lawnAssessment.scores.aiSummary = NEUTRAL_SUMMARY;
        lawnAssessment.aiSummary = NEUTRAL_SUMMARY;
        if (lawnAssessment.snapshot && typeof lawnAssessment.snapshot === 'object') {
          lawnAssessment.snapshot.summary = NEUTRAL_SUMMARY;
          if (Array.isArray(lawnAssessment.snapshot.findings)) lawnAssessment.snapshot.findings = [];
          if (Array.isArray(lawnAssessment.snapshot.nextWatchItems)) lawnAssessment.snapshot.nextWatchItems = [];
        }
        if (Array.isArray(lawnAssessment.recommendationCards)) lawnAssessment.recommendationCards = [];
        if (lawnAssessment.customerSummary) lawnAssessment.customerSummary = NEUTRAL_SUMMARY;
        console.warn('[report-data] product categories unverifiable (catalog lookup failed) — recommendation-derived copy suppressed for this render');
      } else if (guardProducts.length) {
        // Products-aware (codex P1 r26): name-phrased deferrals ("Hold off
        // on Celsius WG") and unresolved-category rows are checked too.
        const NEUTRAL_SUMMARY = 'Today’s applications are in place — we’ll track how the lawn responds and adjust at the next visit.';
        const sanitizeRecsInPlace = (host, key) => {
          const recs = host?.[key];
          if (!recs || typeof recs !== 'object') return;
          const { parsed } = treatmentGuard.sanitizeRecommendationsAgainstTreatment(
            JSON.parse(JSON.stringify(recs)), guardProducts,
          );
          host[key] = parsed;
        };
        // BOTH data shapes: scores.* AND the duplicated top-level fields —
        // reconcileLawnReport reads top-level recommendations.nextVisitFocus
        // and buildLawnReportV2 reads top-level aiSummary (codex P1 r20).
        sanitizeRecsInPlace(lawnAssessment.scores, 'recommendations');
        sanitizeRecsInPlace(lawnAssessment, 'recommendations');
        if (treatmentGuard.contradictsAppliedProducts(lawnAssessment.scores.aiSummary, guardProducts)) {
          lawnAssessment.scores.aiSummary = NEUTRAL_SUMMARY;
        }
        if (treatmentGuard.contradictsAppliedProducts(lawnAssessment.aiSummary, guardProducts)) {
          lawnAssessment.aiSummary = NEUTRAL_SUMMARY;
        }
        // Legacy snapshot + recommendation cards feed the public report
        // assistant (/api/reports/:token/ask) directly — reconcile those
        // customer-facing shapes too (codex P1 r23).
        const contradicts = (text) => treatmentGuard.contradictsAppliedProducts(text, guardProducts);
        const snap = lawnAssessment.snapshot;
        if (snap && typeof snap === 'object') {
          if (contradicts(snap.summary)) snap.summary = NEUTRAL_SUMMARY;
          if (Array.isArray(snap.findings)) {
            snap.findings = snap.findings.filter((f) => !contradicts(`${f?.customerCopy || ''} ${f?.title || ''}`));
          }
          if (Array.isArray(snap.nextWatchItems)) {
            snap.nextWatchItems = snap.nextWatchItems.filter((item) => !contradicts(item));
          }
        }
        if (Array.isArray(lawnAssessment.recommendationCards)) {
          lawnAssessment.recommendationCards = lawnAssessment.recommendationCards.filter(
            (card) => !contradicts(`${card?.title || ''} ${card?.customerCopy || ''} ${card?.reason || ''}`),
          );
        }
        // customerSummary was COPIED from snapshot.summary before this guard
        // ran — reconcile the copy too (heading, dynamic hero, and the
        // report assistant all render it — codex P1 r27).
        if (contradicts(lawnAssessment.customerSummary)) {
          lawnAssessment.customerSummary = NEUTRAL_SUMMARY;
        }
      }
    } catch (guardErr) {
      console.warn(`[report-data] render-time treatment reconciliation skipped: ${guardErr.message}`);
    }
  }
  // Mowing height-of-cut — surfaced at the top level (not inside lawnAssessment)
  // so it shows on lawn reports even when there's no vision assessment. Null when
  // not a lawn visit or no reading was captured. The trend is capped at THIS
  // report's reading time so a long-lived report token can't expose later visits.
  let mowingHeight = null;
  let mowingTrendFallback = null;
  if (serviceLine === 'lawn') {
    const turfReading = await getTurfHeightForVisit(service.id, knex);
    const turfTrend = turfReading
      ? await getTurfHeightTrend(service.customer_id, 12, knex, turfReading.measured_at)
      : [];
    mowingHeight = buildMowingHeightContext(turfReading, turfTrend);
    // No gauge reading THIS visit → the trends grid can still show the mowing
    // history, capped at this visit's completion time (same later-visit guard).
    if (!mowingHeight) {
      const historyCap = validTimestamp(service.completed_at) || validTimestamp(service.updated_at) || null;
      const priorTrend = historyCap
        ? await getTurfHeightTrend(service.customer_id, 12, knex, historyCap)
        : [];
      const withHeights = priorTrend.filter((r) => r && r.manual_height_in != null
        && Number.isFinite(Number(r.manual_height_in)));
      if (withHeights.length >= 2) {
        const latest = withHeights[0]; // getTurfHeightTrend returns newest-first
        mowingTrendFallback = {
          band: { min: Number(latest.target_min_in), max: Number(latest.target_max_in) },
          trend: withHeights.map((r) => ({ heightIn: Number(r.manual_height_in), measuredAt: r.measured_at })),
        };
      }
    }
  }
  const lawnProgramOverview = await loadLawnProgramOverviewContext(knex, service, serviceLine, scheduledService);
  const hasLawnAssessmentSignal = hasLawnAssessmentCustomerSignal(lawnAssessment);

  // Typed reports carry their real findings in the snapshot (rendered by
  // TypedFindingsCard) — the legacy no-activity fallback would contradict
  // e.g. an active cockroach visit's snapshot.
  if (!typedSnapshot && !findings.length && !hasLawnAssessmentSignal
    && !(serviceLine === 'lawn' && productsLoadFailed)
    && shouldAddNoActivityFinding({ service, structured, protocol, interiorOnlyLane })) {
    findings.push({
      id: `no-activity-${service.id}`,
      zoneId: null,
      ...buildNoActivityFinding(serviceLine),
    });
  }

  // LAWN honesty pass (owner report audit 2026-07-30), mirroring the pest pass
  // above but keyed on treatment evidence: a "No lawn issues observed" row
  // (persisted at closeout OR the render-time fallback just above) must not
  // sit on the same page as a visit that applied corrective product classes
  // (fungicide/herbicide) — routine lawn visits are fertilizer + preventive
  // insecticide only. Product rows are the ONLY trigger: keyword-matching the
  // raw technician notes would fire on negated statements ("no weeds or
  // disease observed") and derive customer copy from unparsed prose (codex
  // P1 #3093). The softened wording claims nothing beyond the record: no
  // structured corrective finding was logged.
  if (serviceLine === 'lawn' && findings.some((f) => f.category === 'no_activity')) {
    // Enriched rows, not rawProducts: legacy rows with a null
    // product_category recover it from the catalog via
    // attachApprovedReportProductFacts (codex P2 r17).
    // An outage-empty application set is NOT proof the visit applied
    // nothing — the absolute "no lawn issues" claim must soften on that
    // path too (codex P1 r30).
    const correctiveApplied = productsLoadFailed || products.some((p) =>
      /fungicide|herbicide/i.test(String(p.product_category || p.approved_report_product_facts?.category || '')));
    if (correctiveApplied) {
      for (const finding of findings) {
        if (finding.category === 'no_activity') {
          finding.title = 'No corrective findings logged this visit';
          finding.detail = 'See your technician’s visit summary for what was applied and observed today; no separate corrective finding was logged.';
        }
      }
    }
  }

  // Pest Pressure is computed by the pest-pressure orchestrator on report
  // completion and mirrored back to service_records.pressure_index. Legacy
  // pre-v1 reports without a stored value have no Pest Pressure score.
  const pestPressureConfigPromise = preloadedPestPressureConfig === undefined
    ? loadActiveConfig(knex).catch(() => null)
    : Promise.resolve(preloadedPestPressureConfig);
  const serviceCoverageConfigPromise = preloadedServiceCoverageConfig === undefined
    ? loadServiceCoverageConfig(knex).catch(() => null)
    : Promise.resolve(preloadedServiceCoverageConfig);
  const visitTimelineConfigPromise = preloadedVisitTimelineConfig === undefined
    ? loadVisitTimelineConfig(knex).catch(() => null)
    : Promise.resolve(preloadedVisitTimelineConfig);
  const [pestPressureConfig, pestPressureRow, pestPressureHistory, serviceCoverageConfig, visitTimelineConfig] = await Promise.all([
    pestPressureConfigPromise,
    loadScoreForServiceRecord(knex, service.id).catch(() => null),
    service.customer_id
      ? loadHistoryForCustomer(knex, service.customer_id, {
          serviceLine: serviceLine || null,
          limit: 8,
          beforeOrOnServiceDate: service.service_date || null,
          // Trim same-day sibling rows at this report's own score row so a
          // later visit completed the same day can't chart on this token.
          currentServiceRecordId: service.id || null,
        }).catch(() => [])
      : Promise.resolve([]),
    serviceCoverageConfigPromise,
    visitTimelineConfigPromise,
  ]);
  // Typed specialty reports never render Pest Pressure — these service
  // types can detect to the 'pest' line and slip past the recurring-label
  // gates, which would leak the pressure UI (or its insufficient-data
  // placeholder) onto e.g. a cockroach cleanout report. Explicit gate.
  // Untyped one-time treatments get the same treatment via the resolved
  // completion profile (codex r6): their labels carry no cadence word, so
  // the view's label heuristic alone would render the placeholder card
  // with a live rating picker.
  const pestPressureOneTimeExcluded = typedSnapshot
    ? false
    : await isOneTimePressureExcludedRecord(service, knex);
  const pestPressure = typedSnapshot
    ? null
    : buildPestPressureCustomerView({
      config: pestPressureConfig,
      scoreRow: pestPressureRow,
      serviceRecord: service,
      historyRows: pestPressureHistory,
      oneTimeExcluded: pestPressureOneTimeExcluded,
    });
  const activity = typedSnapshot
    ? await loadActivityCustomerView(knex, { snapshot: typedSnapshot, service }).catch(() => null)
    : null;
  // D2: visit timeline for typed trend programs — derived from the same
  // bounded history as the gauge, so it inherits the trend-type gate
  // (activity exists only for ACTIVITY_INDICATORS types) and the
  // same-day-sibling trim. Null for one-shot types and first visits.
  const typedVisitTimeline = activity
    ? await buildTypedVisitTimeline(knex, { activityView: activity, snapshot: typedSnapshot, service }).catch(() => null)
    : null;

  // Companion typed sections (combined-service-completions.md): each stored
  // snapshot froze its own delivery posture at completion. Server-side
  // filtering here is the privacy boundary — the CUSTOMER payload must not
  // contain internal_only sections at all; staff viewers (opts.staffViewer,
  // resolved by the route with the same staff-JWT signal the Phase-1b
  // suppressed-report read path uses) get every section, flagged
  // internalOnly. Per-entry activity-history failures are non-fatal — a
  // bad history must not take down the report.
  const staffViewer = opts.staffViewer === true;
  const companionSnapshots = Array.isArray(serviceData.companionReportSnapshots)
    ? serviceData.companionReportSnapshots.filter((s) => s && typeof s === 'object' && s.type)
    : [];
  const companionReports = await Promise.all(
    companionSnapshots
      .filter((snapshot) => staffViewer || snapshot.delivery === 'auto_send')
      .map(async (snapshot) => {
        const companionActivity = await loadActivityCustomerView(knex, { snapshot, service }).catch(() => null);
        return {
          type: snapshot.type,
          typeLabel: snapshot.typeLabel || null,
          reportTypeLabel: snapshot.reportTypeLabel || null,
          visitSequence: snapshot.visitSequence || 1,
          isProgressVisit: (snapshot.visitSequence || 1) > 1,
          todaysResult: snapshot.todaysResult || null,
          findings: Array.isArray(snapshot.findings) ? snapshot.findings : [],
          nextStepChips: Array.isArray(snapshot.nextStepChips) ? snapshot.nextStepChips : [],
          photoSummary: snapshot.photoSummary || null,
          schemaVersion: snapshot.schemaVersion || null,
          internalOnly: snapshot.delivery !== 'auto_send',
          activity: companionActivity,
          visitTimeline: companionActivity
            ? await buildTypedVisitTimeline(knex, { activityView: companionActivity, snapshot, service }).catch(() => null)
            : null,
        };
      }),
  );

  // buildPestPressureCustomerView returns null ONLY when Pest Pressure is
  // hidden from the customer (feature off, showOnCustomerReport off, scope
  // excludes the report). When that's the case, the legacy pressureIndex
  // field must also stay hidden — otherwise PDF, email, and any other
  // direct caller of buildReportV1Data would still leak the score even
  // though reports-public.js scrubs its own JSON response. Gate here, at
  // the source, so every caller benefits.
  const pressureIndex = (pestPressure !== null && service.pressure_index != null)
    ? customerVisiblePressureIndex(service.pressure_index)
    : null;

  const applications = products.map((product, index) => {
    const method = methodFromProduct(product, serviceLine);
    return {
      id: product.id || `product-${index + 1}`,
      product: {
        catalogId: product.product_id || null,
        name: product.product_name,
        epa_reg: product.epa_reg_number || product.epa_reg || '',
        active_ingredient: product.active_ingredient || '',
        category: product.product_category || '',
        product_type: product.approved_report_product_facts?.productType || null,
        manufacturer: product.approved_report_product_facts?.manufacturer || null,
        public_summary: product.approved_report_product_facts?.publicSummary || null,
        service_report_summary: product.approved_report_product_facts?.serviceReportSummary || null,
        precaution_summary: product.approved_report_product_facts?.precautionSummary || null,
        reentry_summary: product.approved_report_product_facts?.reentrySummary || null,
        reentry_hours: product.approved_report_product_facts?.reentryHours ?? null,
        irrigation_notes: product.approved_report_product_facts?.irrigationNotes || null,
        irrigation_required: product.approved_report_product_facts?.irrigationRequired ?? null,
        label_verified_at: product.approved_report_product_facts?.labelVerifiedAt || null,
        label_version: product.approved_report_product_facts?.labelVersion || null,
        facts_approved: !!product.approved_report_product_facts,
      },
      method,
      // Explicit vs inferred decides whether pesticide identity may override
      // a station_check classification in the document (see
      // hasExplicitApplicationMethod).
      methodInferred: !hasExplicitApplicationMethod(product),
      methodLabel: METHOD_LABELS[method] || method.replace(/_/g, ' '),
      zone_ids: matchZoneIds(product, zones, areaLabels),
      rate: product.application_rate,
      rateUnit: product.rate_unit,
      totalAmount: product.total_amount,
      amountUnit: product.amount_unit,
      applicationArea: product.application_area || product.area || null,
      areaValue: product.area_value,
      areaUnit: product.area_unit,
      targets: parseJsonArray(product.targets),
      appliedAt: product.applied_at || product.created_at,
    };
  });
  const evidenceLevel = serviceData.evidenceLevel
    || serviceData.evidence_level
    || structured.evidenceLevel
    || structured.evidence_level
    || 'technician_confirmed';
  const serviceLocations = serviceCoverageLocations({
    serviceLine,
    structured,
    serviceData,
    zones,
    applications,
    findings,
    areaLabels,
    evidenceLevel,
  });
  const serviceRecordTiming = publicTimingFields(service);
  const scheduledServiceTiming = publicTimingFields(scheduledService || {});
  const workflowEvents = buildWorkflowEvents({
    service: {
      ...service,
      scheduled_en_route_at: scheduledService?.en_route_at || null,
      scheduled_arrived_at: scheduledService?.arrived_at || null,
      scheduled_actual_start_time: scheduledService?.actual_start_time || null,
      scheduled_check_in_time: scheduledService?.check_in_time || null,
      scheduled_completed_at: scheduledService?.completed_at || null,
      scheduled_actual_end_time: scheduledService?.actual_end_time || null,
      scheduled_check_out_time: scheduledService?.check_out_time || null,
    },
    structured,
    serviceData,
    serviceLine,
  });
  const visitTimeline = buildVisitTimeline({
    service: {
      ...service,
      scheduled_en_route_at: scheduledService?.en_route_at || null,
      scheduled_arrived_at: scheduledService?.arrived_at || null,
      scheduled_actual_start_time: scheduledService?.actual_start_time || null,
      scheduled_check_in_time: scheduledService?.check_in_time || null,
      scheduled_completed_at: scheduledService?.completed_at || null,
      scheduled_actual_end_time: scheduledService?.actual_end_time || null,
      scheduled_check_out_time: scheduledService?.check_out_time || null,
    },
    scheduledService: scheduledService || {},
    structured,
    serviceData,
    serviceLine,
    serviceType: service.service_type,
    workflowEvents,
    // Typed specialty reports name the actual service in the completed event.
    serviceLabel: typedSnapshot ? (linkedServiceName || null) : null,
    customerInteraction: service.customer_interaction || structured.customerInteraction || structured.customer_interaction || null,
    config: visitTimelineConfig,
  });
  const timingOptions = { structured, serviceData, workflowEvents };
  const arrivalTime = resolveReportArrivalTime(service, scheduledService, timingOptions);
  const completionTime = resolveReportCompletionTime(service, scheduledService, timingOptions);
  const centerLat = numberOrNull(service.customer_latitude ?? service.latitude ?? service.lat);
  const centerLng = numberOrNull(service.customer_longitude ?? service.longitude ?? service.lng);
  const mapCenter = centerLat != null && centerLng != null ? { lat: centerLat, lng: centerLng } : null;

  const flagFindings = findings
    .filter((finding) => ['high', 'critical'].includes(finding.severity) && finding.zoneId)
    .map((finding) => ({ zone_id: finding.zoneId, label: finding.title }));

  const mapSvg = renderTreatmentMap({
    geometry: effectiveGeometry,
    zones,
    applications,
    flags: flagFindings,
  });
  const satelliteMap = await buildSatelliteTreatmentMapContext({
    service,
    zones,
    applications,
    flags: flagFindings,
    geometryRow,
    mode: 'live',
  }).catch(() => ({ available: false, fallbackReason: 'build_failed' }));

  // Technician-traced treatment perimeter (Treatment Zone Mapper): the traced
  // path + composited satellite snapshot saved from the tech portal. When
  // present it replaces the generic schematic as the report's coverage map.
  // Fail-soft everywhere — a missing table, row, or S3 signature must never
  // break report rendering. Gated by GATE_TREATMENT_ZONE_MAP.
  let tracedTreatmentZone = null;
  try {
    // Interior-only treatments (bed bug) never render a satellite spray
    // outline — a trace saved before the tracer was hidden for this lane
    // is stale exterior evidence on an interior treatment's report
    // (codex P2 r6; stable-key classification r9).
    // Gate ON: the centralized combined verdict (frozen identity,
    // add-on aware) is the ONLY decider — the legacy lane booleans read
    // the MUTABLE row/label and would both hide a frozen-eligible map
    // after a repoint and override an add-on rescue (codex P2 r16). Gate
    // OFF: the legacy belts, bit-for-bit.
    // photoLaneSuppressed rides the LEGACY belt too: it hangs off
    // GATE_PHOTO_MARKS, so a foam lane's saved trace stays suppressed even
    // when the eligibility gate is off (codex P1 r2).
    if (featureGates.isEnabled('treatmentZoneMap') && service.scheduled_service_id
      && (traceEligibilityGateOn()
        ? !traceSuppressed
        : (!interiorOnlyLane && !trapLaneNoSprayMap && !photoLaneSuppressed))) {
      const tracedRow = await knex('treatment_zone_maps')
        .where({ scheduled_service_id: service.scheduled_service_id })
        .first()
        .catch(() => null);
      if (tracedRow?.snapshot_s3_key && PhotoService) {
        const tracedSnapshotUrl = await PhotoService.getViewUrl(
          tracedRow.snapshot_s3_key,
          PhotoService.CUSTOMER_DWELL_TTL_SECONDS
        ).catch(() => null);
        // A traced row whose snapshot would not presign is an EXPECTED image
        // silently omitted from the artifact (codex P2 #3176 r21) — the
        // cacheability gate must know.
        if (!tracedSnapshotUrl) imageResolutionFailures += 1;
        if (tracedSnapshotUrl) {
          // lawn_highlight rows may carry the transparent highlight layer —
          // the report pulses it over the snapshot (owner 2026-07-30).
          // Fail-soft: no mask (legacy rows, spray/outline saves, presign
          // hiccup) just means a static image.
          let tracedMaskUrl = null;
          if (tracedRow.capture_mode === 'lawn_highlight' && tracedRow.mask_s3_key) {
            tracedMaskUrl = await PhotoService.getViewUrl(
              tracedRow.mask_s3_key,
              PhotoService.CUSTOMER_DWELL_TTL_SECONDS
            ).catch(() => null);
          }
          tracedTreatmentZone = {
            snapshotUrl: tracedSnapshotUrl,
            maskUrl: tracedMaskUrl,
            linearFt: numberOrNull(tracedRow.linear_ft),
            closedLoop: Boolean(tracedRow.closed_loop),
            capturedAt: tracedRow.updated_at || tracedRow.created_at || null,
            // 'lawn' | 'lawn_highlight' | 'perimeter' | 'interior' | null
            // (legacy rows predate the column) — the client only claims
            // "highlighted"/"treated lawn area"/interior coverage for rows
            // actually captured by those workflows (codex P1 #3038; interior
            // owner 2026-07-29; lawn_highlight codex P1 #3075).
            captureMode: tracedRow.capture_mode || null,
            label: tracedRow.capture_mode === 'interior'
              ? 'Interior and perimeter treatment traced on-site by your technician.'
              : 'Treated perimeter traced on-site by your technician.',
            // Traced path in snapshot pixel space (1280x960) so the report
            // can REPLAY the spray application the tech saw (owner
            // 2026-07-21) — px only, the customer surface never needs the
            // lat/lng the row also stores.
            pathPoints: parseJsonArray(tracedRow.path_points)
              .map((p) => ({ x: numberOrNull(p?.px?.x), y: numberOrNull(p?.px?.y) }))
              .filter((p) => p.x != null && p.y != null),
            // Server-decided render variant/caption from the eligibility
            // registry — GATE-SCOPED (codex P1 r11): with the gate off the
            // fields stay null so gate-off payloads render exactly as
            // today (the client's legacy serviceLine switch), matching the
            // legacy capture mode those visits were traced with. The
            // variant goes live with the same flip that changes capture.
            // The PRESENTATION must match the captured bitmap (codex P1
            // r18): a lawn-family capture renders as outline even when the
            // winning verdict came from a spray add-on line — the saved
            // lawn geometry cannot honestly wear spray copy/animation.
            // Read off the SATELLITE line (codex P1 r11), never the primary:
            // on a foam-primary visit whose add-on earned the trace, the
            // primary verdict is 'photo' — not a value this field can carry,
            // and the client falls through it to the spray heading and blue
            // band. The satellite verdict is the one that describes this
            // bitmap's lane.
            variant: (traceEligibilityGateOn() && satelliteVerdict)
              ? ((tracedRow.capture_mode === 'lawn' || tracedRow.capture_mode === 'lawn_highlight')
                ? 'outline' : satelliteVerdict.variant)
              : null,
            captionKey: (traceEligibilityGateOn() && satelliteVerdict)
              ? ((tracedRow.capture_mode === 'lawn' || tracedRow.capture_mode === 'lawn_highlight')
                ? 'lawnCoverage' : satelliteVerdict.captionKey)
              : null,
          };
        }
      }
    }
  } catch {
    tracedTreatmentZone = null;
  }

  // Bait station map (station-map-v1): numbered pins + this visit's statuses
  // over the same live satellite image. Gated to termite-bait-typed reports —
  // the VIEWER-VISIBLE snapshot types, so an internal_only companion's
  // station data never reaches the customer copy and pins never leak onto
  // unrelated (lawn / pest-only) reports for the same property.
  // Resolved ONCE for every consumer of the trap stage. The station map and
  // the narrative both describe the same traps, so deriving this separately
  // in each place is how they came to disagree: the map read the companion
  // snapshots while the narrative saw only the primary, leaving `visitStage`
  // null on a trapping companion — so the deterministic fallback said the
  // mapped traps "were inspected" and the model's copy was never screened by
  // the setup guards, beside a companion finding reading "Traps set" (codex
  // P1 round 10).
  const trapSetupSnapshot = [typedSnapshot, ...companionSnapshots]
    .find((snap) => require('./activity-indicators')
      .isInitialRodentTrapSetup(snap?.type, snap?.visitSequence, snap?.values)) || null;

  // The narrative lanes below TELL THE CUSTOMER the traps went out today, so
  // their stage resolves only from snapshots this viewer is allowed to see.
  // The raw lookup above stays raw for the shared map's wording (round-8
  // ruling: whether traps went out is a fact about the visit) — but an
  // internal_only trapping companion on an auto-sent primary must not leak
  // "your traps were placed" into a summary whose own section is suppressed
  // for this viewer (codex P1 round 12). Staff viewers see internal
  // sections, so their narrative may still name the stage. The primary is
  // always visible here: an internal_only PRIMARY never mints a report
  // token in the first place.
  const narrativeTrapSetupSnapshot = [
    typedSnapshot,
    ...companionSnapshots.filter((snap) => staffViewer || snap.delivery === 'auto_send'),
  ].find((snap) => require('./activity-indicators')
    .isInitialRodentTrapSetup(snap?.type, snap?.visitSequence, snap?.values)) || null;

  const stationMap = buildStationMapReportContext({
    stationRows,
    checkRows: stationCheckRows,
    satelliteMap,
    imageContext: {
      center: mapCenter,
      zoom: Number(geometryRow?.zoom) || 20,
      width: 640,
      height: 340,
    },
    typedTypes: [typedSnapshot?.type, ...companionReports.map((companion) => companion.type)].filter(Boolean),
    serviceDate: service.service_date || null,
    // Read off the FROZEN snapshot that actually OWNS the trapping program —
    // which may be a COMPANION, since typedTypes deliberately lets a
    // non-station primary carry a rodent_trapping companion and that
    // companion selects the map. Deriving this from the primary alone left
    // the companion's "Traps set" finding beside a map still saying
    // "inspected" (codex P2 on #3159). Scoped require matches this file's
    // pattern for report-time helpers.
    // Read off the RAW companion snapshots, not the projected
    // `companionReports` view: that projection is built above from a fixed
    // field list that has no `values`, so the companion arm of this lookup
    // was structurally dead — it could only ever read `undefined` and the
    // primary alone decided the map's wording (codex P2 round 8). The raw
    // array is also unfiltered by delivery, which is correct here: whether
    // the traps went out today is a fact about the visit, not about which
    // companion sections this viewer is allowed to see.
    initialSetup: trapSetupSnapshot != null,
    // The trapping snapshot's own count, so the map can confirm it agrees
    // before restating it (the tech may have hand-edited it away from the
    // autofilled pin count). Same sourcing fix as above.
    typedTrapCount: (() => {
      const trapSnap = [typedSnapshot, ...companionSnapshots]
        .find((snap) => snap?.type === 'rodent_trapping');
      const n = Number(trapSnap?.values?.traps_checked);
      return Number.isInteger(n) ? n : null;
    })(),
  });

  // Does the narrative's own count disagree with the map it sits beside?
  //
  // The map's `setupCountVerified` cannot be the only source (codex P1
  // round 15). It is only emitted when at least one pin carries a per-visit
  // status, and the post-completion station sync is deliberately fail-soft
  // — so a declared setup whose check rows never landed produces a standing
  // registry map with NO dispute flag, and a typed count of 6 beside an
  // 8-pin fallback map licensed the model to say 8 traps were set. For an
  // auto-sent trapping COMPANION nothing else could catch it either: the
  // facts carry the PRIMARY's findings, so the typed 6 never reaches the
  // grounded number set.
  //
  // So the comparison is made here, from the same viewer-visible snapshot
  // the stage came from. `checked` and `total` are both acceptable matches:
  // a synced setup agrees with checked, an unsynced one agrees with total.
  const narrativeTrapCount = (() => {
    const snap = [
      typedSnapshot,
      ...companionSnapshots.filter((s) => staffViewer || s.delivery === 'auto_send'),
    ].find((s) => s?.type === 'rodent_trapping');
    const n = Number(snap?.values?.traps_checked);
    return Number.isInteger(n) ? n : null;
  })();
  const stationCountDisputed = (stationMap?.initialSetup === true && stationMap?.setupCountVerified === false)
    || Boolean(
      narrativeTrapSetupSnapshot
      && stationMap?.program === 'trapping'
      && stationMap?.summary
      && narrativeTrapCount != null
      && narrativeTrapCount !== (stationMap.summary.checked || 0)
      && narrativeTrapCount !== (stationMap.summary.total || 0),
    );

  const onSiteMin = computeOnSiteMin({
    ...service,
    started_at: arrivalTime || service.started_at,
    ended_at: completionTime || service.ended_at,
    timeOnSite: structured.timeOnSite,
  });
  const linearFt = await computeLinearFt(service.id, knex).catch(() => null);
  const treatedZoneIds = new Set(applications.flatMap((app) => app.zone_ids || []));
  const recommendations = uniqueStrings([
    ...protocol.recommendations,
    ...findings.map((finding) => finding.recommendation).filter(Boolean),
  ]);
  // The turf-height gauge image is the on-site lawn-length documentation photo.
  // Surface it in the Mowing Height report module (next to the reading it
  // documents) instead of the generic gallery, so it appears exactly once. We
  // resolve its URL onto `mowingHeight.photoUrl` and exclude it from the gallery
  // payload below. It stays in `photos` so the tamper-evident hash chain
  // (validated below) remains intact. Fail-soft on every step.
  let gaugePhotoId = null;
  try {
    const gaugeRow = await knex('turf_height_readings')
      .where({ service_record_id: service.id })
      .whereNotNull('gauge_photo_id')
      .first('gauge_photo_id');
    gaugePhotoId = gaugeRow?.gauge_photo_id || null;
  } catch { gaugePhotoId = null; }
  if (gaugePhotoId && mowingHeight) {
    try {
      const gaugePhoto = photos.find((p) => String(p.id) === String(gaugePhotoId));
      const gaugeUrl = gaugePhoto ? await photoUrl(gaugePhoto) : null;
      if (gaugePhoto && !gaugeUrl) imageResolutionFailures += 1;
      if (gaugeUrl) mowingHeight = { ...mowingHeight, photoUrl: gaugeUrl };
    } catch { /* fail-soft: report still renders the reading without the photo */ }
  }
  // Build the gallery with ALL photos. The gauge/lawn-length photo is dropped from
  // the gallery LATER (at the return) and only when Lawn Report V2 actually built and
  // surfaced it in the mowing module — so a failed/absent V2 build (legacy path,
  // flag off, no assessment, or a build error) keeps the photo in the gallery instead
  // of losing it (Codex P1).
  // Treated-point marks (GATE_PHOTO_MARKS, dark). Keyed on the photo's S3 key
  // rather than its id because marks placed before completion belong to a
  // staging row that promotion deletes and re-inserts under a new id; the S3
  // key survives that verbatim. Fail-soft to an empty map.
  const photoMarksByKey = await loadMarksByS3Key({
    scheduledServiceId: service.scheduled_service_id,
    knex,
  }).catch(() => new Map());
  const photoPayload = await Promise.all(photos
    .map(async (photo) => ({
      id: photo.id,
      url: await photoUrl(photo),
      caption: photo.caption || '',
      stateBadge: photo.state_badge || null,
      zoneId: photo.zone_id || null,
      capturedAt: photo.captured_at || photo.created_at,
      hashSha256: photo.hash_sha256 || null,
      prevHashSha256: photo.prev_hash_sha256 || null,
      aiTags: parseJsonArray(photo.ai_tags),
      marks: photoMarksByKey.get(photo.s3_key) || [],
    })));
  // Photos that EXIST on the record but whose URL would not resolve are
  // silent omissions the page's onError counter can never see (codex P2
  // #3176 r21) — count them for the cacheability gate.
  imageResolutionFailures += photoPayload.filter((p) => !p.url).length;
  // Lawn visits capture turf photos in the tech's Lawn Assessment block instead
  // of a separate Service Photos upload. Surface those turf photos in the
  // customer gallery so the single capture point feeds both the lawn scorecard
  // and the report's photo gallery. Appended AFTER the service_photos hash chain
  // is validated below so the tamper-evident chain stays over service_photos only.
  if (serviceLine === 'lawn') {
    // Reuse the assessment the SCORECARD resolved rather than resolving again
    // (#3168). A second independent lookup can land on a different row mid-
    // render, producing a report whose copy and photos come from different
    // assessments — and a fence comparing only the selection would still pass
    // it. The scorecard already honoured any pin, so this inherits it.
    // Pinned ABSENCE means the render must carry no assessment content at all —
    // including its turf photos. Falling through to the unpinned resolver here
    // would append photos from whatever assessment is current and put unfenced
    // content in a PDF that is supposed to have none.
    const linkedAssessment = opts.pinnedLawnAssessmentId === PIN_NO_ASSESSMENT
      ? null
      : (lawnAssessment?.assessmentId
        ? { id: lawnAssessment.assessmentId }
        : await loadLinkedLawnAssessment(service, knex));
    if (linkedAssessment?.id) {
      // customer_visible: true == passed the quality gate. Failed-quality
      // photos are stored only for audit (customer_visible: false) and must
      // never reach the customer's permanent report token.
      const turfPhotos = await knex('lawn_assessment_photos')
        .where({ assessment_id: linkedAssessment.id, customer_visible: true })
        .orderBy('photo_order', 'asc')
        .orderBy('taken_at', 'asc')
        .catch(() => []);
      const turfGalleryItems = (await Promise.all(turfPhotos.map(async (photo) => {
        const url = await lawnPhotoUrl(photo);
        // Dropped-but-expected turf photo — same silent-omission class.
        if (!url) { imageResolutionFailures += 1; return null; }
        return {
          id: `lawn-${photo.id}`,
          url,
          caption: photo.caption || photo.observations || '',
          stateBadge: null,
          zoneId: photo.zone_id || null,
          capturedAt: photo.taken_at || photo.created_at,
          hashSha256: null,
          prevHashSha256: null,
          aiTags: [],
        };
      }))).filter(Boolean);
      if (turfGalleryItems.length) photoPayload.push(...turfGalleryItems);
    }
  }
  const photoChain = photos.some((photo) => photo.hash_sha256)
    ? validatePhotoChainRows(photos)
    : { valid: null, photo_count: photos.length, broken_at: null };
  // Pass the already-resolved classification so the resolver does not
  // re-resolve the profile for the report payload path.
  // An ineligible lane's trace must not assert an exterior re-entry window
  // either — a trace on an inspection would otherwise emit a false
  // advisory (scope RC3).
  // Same gate-off gap as the map loader (codex P1 r2): a foam trace must not
  // contribute an exterior re-entry advisory beside the marked photo just
  // because the eligibility gate has not been flipped yet.
  const payloadTracedExteriorZone = (traceEligibilityGateOn()
    ? traceSuppressed
    : (interiorOnlyLane || photoLaneSuppressed))
    ? false
    : await resolveTracedExteriorZone({ ...service, interior_only_lane: false }, knex, {
      // Reuse the payload's combined verdict — ONE verdict per report
      // (codex P2 r24); the resolver only re-checks the zone row.
      ...(traceEligibilityGateOn()
        // The SATELLITE verdict, matching what resolveTraceRenderVerdict
        // itself returns (`renderCapabilities.satellite || eligibility`) —
        // the re-entry scope hangs off the traced exterior artifact, so
        // handing it a foam primary would scope the advisory off the wrong
        // lane on exactly the mixed visits this branch exists for.
        ? {
          precomputedTraceVerdict: {
            suppressed: traceSuppressed,
            eligibility: satelliteVerdict || traceEligibility,
          },
        }
        : {}),
    });
  const advisory = normalizeAdvisoryForTreatmentScope({
    ...config.advisoryDefaults,
    ...parseJsonObject(service.advisory),
    ...(service.irrigation_recommendation ? { irrigation: service.irrigation_recommendation } : {}),
  }, {
    service,
    applications,
    zones: payloadTracedExteriorZone ? [{ label: 'Traced exterior treatment zone' }] : [],
  });
  const metrics = buildMetrics(config, {
    onSiteMin,
    treatedZoneIds,
    zones,
    applications,
    findings,
    pressureIndex,
    linearFt,
    serviceData,
  }).map((metric) => {
    if (lawnAssessment && metric.key === 'pressure_index') {
      return {
        ...metric,
        key: 'lawn_health',
        label: 'Lawn health',
        value: lawnAssessment.scores?.overallScore ?? null,
        unit: '%',
        format: 'integer',
      };
    }
    // Typed gauge types replace the pressure metric with their activity
    // level (worded, not numeric, in the client — value drives the band).
    if (activity && metric.key === 'pressure_index') {
      return {
        ...metric,
        key: 'activity_score',
        label: activity.label,
        value: activity.score,
        unit: '',
        format: 'integer',
      };
    }
    return metric;
  }).filter((metric) => {
    // Drop the pressure_index metric when Pest Pressure is hidden from
    // the customer (pestPressure === null). The lawn-health remap above
    // already replaced the entry's key when a lawn assessment is present,
    // so we only filter the raw pressure_index when it's still that key.
    if (metric.key !== 'pressure_index') return true;
    return pestPressure !== null;
  });
  const technicianName = formatTechnicianForCustomer({
    name: service.technician_name,
    first_name: service.technician_first_name,
    last_name: service.technician_last_name,
  });
  const technicianPhotoUrl = await resolveTechPhotoUrl(
    service.technician_photo_s3_key,
    service.technician_avatar_url || service.technician_photo_url,
    // PhotoService is guard-loaded above — fall back to the helper's default
    // TTL rather than throwing when it's unavailable.
    PhotoService?.CUSTOMER_DWELL_TTL_SECONDS ?? undefined,
  ).catch(() => service.technician_avatar_url || service.technician_photo_url || null);
  const publicZones = zones.map((zone) => ({
    id: zone.id,
    letter: zone.letter,
    label: zone.label,
    category: zone.category,
    geometry: parseJsonObject(zone.geometry),
    geometryGeoJson: normalizeGeometry(zone.geometry_geojson) || undefined,
    geometryImage: parseJsonObject(zone.geometry_image),
  }));
  const serviceCoverage = normalizeServiceCoverage({
    serviceReportId: service.id,
    serviceLine,
    serviceType: service.service_type,
    serviceDisplayName: linkedServiceName,
    serviceDate: service.service_date,
    serviceAddress: compactAddress(service),
    propertyAddress: compactAddress(service),
    mapCenter,
    serviceAreas: areaLabels,
    serviceLocations,
    zones: publicZones,
  }, serviceCoverageConfig || {});

  // WaveGuard membership tier for THIS visit (null for non-members). Prefer the tier
  // frozen at completion (service_records.service_tier — admin-dispatch snapshots the
  // customer's tier at the time of the visit) so a later membership change doesn't
  // rewrite the membership shown on past reports; fall back to the customer's current
  // waveguard_tier only for older records completed before the snapshot existed. Only
  // true membership tiers count: 'One-Time' is an allowed tier for one-off customers
  // (migration 20260414000003) but is NOT a membership, so it must not trigger the
  // member-only display rules (e.g. hiding the per-visit duration).
  const reportWaveGuardTier = service.service_tier || service.waveguard_tier;
  const waveGuardTier = ['Bronze', 'Silver', 'Gold', 'Platinum'].includes(reportWaveGuardTier)
    ? reportWaveGuardTier
    : null;

  // Self-serve re-service eligibility for the report footer. The footer
  // already TELLS members "WaveGuard members receive free re-service…" with
  // no way to act on it — this lets the live view pair the sentence with a
  // "book it" link. ELIGIBILITY BOOLEAN ONLY, never the reservice_token: the
  // report is a forwardable public bearer link, and embedding the standing
  // token would escalate report-view into unauthenticated booking capability
  // (pre-push audit P0, 2026-08-08) — the client links to the AUTHENTICATED
  // portal Schedule tab (?tab=schedule), where the picker card already
  // renders behind login. Gated (GATE_RESERVICE_STREAMLINE +
  // GATE_RESERVICE_SELF_SERVE) and lane-checked through the same shared
  // eligibility helper the SMS clause uses; false renders the footer exactly
  // as it reads today. Best-effort — never blocks the report.
  let reserviceEligible = false;
  try {
    const { reserviceStreamlineAccess } = require('../reservice-link');
    reserviceEligible = !!(await reserviceStreamlineAccess(service.customer_id));
  } catch { /* footer link is optional */ }

  // Lawn Report V2 — THE lawn report (owner ruling 2026-07-09; the
  // LAWN_REPORT_V2 env flag is retired). Deterministic structure
  // (diagnosis / water / mowing / treatment / trends) from the data already
  // computed for V1; optional LLM narrative overlay (VOICE) varies the prose
  // per visit and falls back to the deterministic copy field-by-field. Built
  // whenever the visit has a tech-confirmed linked assessment — visits
  // without one (historical tokens predating the assessment flow) keep the
  // legacy fallback layout client-side. Never blocks the report.
  let reportV2 = null;
  // '-tn...' signature of the narrative text actually rendered into this
  // payload (codex P2 r15) — PDF stores key off this value, never a re-read.
  let treatmentNarrativeRenderedSignature = null;
  if (serviceLine === 'lawn' && lawnAssessment) {
    try {
      // Phase 2: prefer the stored area water-intake snapshot (computed at
      // completion); compute + persist on the fly if absent so a permanent report
      // token self-heals. Also pull the area's 7-day rainfall for the rain chart.
      let waterSnapshot = null;
      try {
        const { computeLawnWaterIntakeSnapshot } = require('../lawn-water-area');
        const snapDate = lawnAssessment.assessmentDate || service.service_date || null;
        waterSnapshot = await knex('lawn_water_intake_snapshots').where({ service_record_id: service.id }).first().catch(() => null);
        if (!waterSnapshot) {
          waterSnapshot = await computeLawnWaterIntakeSnapshot({
            customerId: service.customer_id,
            serviceId: service.service_id || null,
            serviceRecordId: service.id,
            serviceDate: snapDate,
            irrigationInchesPerWeek: lawnAssessment.waterContext?.irrigationInchesPerWeek,
            targetWaterInchesPerWeek: lawnAssessment.waterContext?.targetInchesPerWeek,
            signals: { overwatering: !!lawnAssessment.overwateringSignal },
          }, knex).catch(() => null);
        }
      } catch { /* area calibration optional (tables may be unmigrated/unseeded) */ }

      // Water-gap trend — every persisted per-visit snapshot up to and including
      // this visit (capped so a permanent report token can't expose later visits).
      let waterGapHistory = [];
      try {
        const gapCap = lawnAssessment.assessmentDate || service.service_date || null;
        if (gapCap) {
          const gapRows = await knex('lawn_water_intake_snapshots')
            .where({ customer_id: service.customer_id })
            .whereNotNull('water_gap_inches')
            .whereNotNull('service_date')
            .where('service_date', '<=', gapCap)
            .orderBy('service_date', 'asc')
            .select('service_date', 'water_gap_inches');
          waterGapHistory = gapRows.map((r) => ({
            serviceDate: r.service_date,
            waterGapInches: r.water_gap_inches,
          }));
        }
      } catch { /* snapshots table optional — trend simply doesn't render */ }

      reportV2 = buildLawnReportV2({
        lawnAssessment,
        mowingHeight,
        applications,
        actions: Array.isArray(protocol?.actions) ? protocol.actions : [],
        customerConcern: structuredCustomerConcern(structured),
        waterSnapshot,
        waterGapHistory,
        mowingTrendFallback,
      });
      // AI "What we applied today" narrative — same contract as the T&S path
      // (owner 2026-07-21: across all reports).
      if (reportV2?.snapshot?.treatmentSummary) {
        const { buildTreatmentNarrative } = require('./treatment-narrative');
        const narrative = await buildTreatmentNarrative({
          serviceRecordId: service.id,
          serviceLine: 'lawn',
          treatment: reportV2.treatment,
          findingsText: lawnAssessment.observations || lawnAssessment.customerSummary || '',
          photoSummary: reportV2.photoSummary || '',
          knex,
        });
        reportV2.snapshot.treatmentSummary = narrative?.text || reportV2.snapshot.treatmentSummary;
        treatmentNarrativeRenderedSignature = narrative?.signature || null;
      }
      // 7-day rainfall chart — sourced from the client's exact lat/lng (the same
      // Open-Meteo trailing-7-day series behind waterContext.rainfallInches7d), so
      // the chart is property-specific and always reconciles with the "rain this
      // week" total. (Previously read from a regional area centroid, which could
      // disagree with the property-level weekly total.)
      const clientDailyRain = lawnAssessment.waterContext?.dailyRain7d;
      if (reportV2 && Array.isArray(clientDailyRain) && clientDailyRain.length) {
        reportV2.rain7d = clientDailyRain.map((r) => ({
          // r.date is a YYYY-MM-DD string — anchor at noon ET so the weekday label
          // doesn't shift a day from a UTC-midnight parse.
          d: new Date(`${r.date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' }),
          in: r.inches,
        }));
        // 'low' when the series is the city-collective fallback → chart shows "Limited
        // data this week" instead of implying a precise per-address reading we don't have.
        reportV2.rain7dConfidence = lawnAssessment.waterContext?.dailyRain7dConfidence || null;
        // Which provider measured these days — the chart prints the NOAA
        // attribution + "local totals may vary" only when the numbers really
        // are radar/gauge derived, never over a pure model week.
        reportV2.rain7dSource = lawnAssessment.waterContext?.rainfall7dProvider || null;
      }

      // Next scheduled lawn visit. Honest-precision rule: a CONFIDENT date only from
      // a real upcoming scheduled_services row (same allow-list as context-aggregator);
      // otherwise a clearly-labeled cadence ESTIMATE from the service frequency; else
      // omitted entirely. Never invent a precise date the data can't back.
      if (reportV2) {
        try {
          const svcRaw = service.service_date;
          const svcIso = svcRaw ? (svcRaw instanceof Date ? svcRaw.toISOString().slice(0, 10) : String(svcRaw).slice(0, 10)) : '';
          const todayIso = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
          const afterIso = svcIso && svcIso > todayIso ? svcIso : todayIso;
          // scheduled_date comes back from pg as a Date object; normalize it the
          // same way svcIso does above before slicing, or String(Date) yields
          // "Wed Jul 08 2026 …" and the label renders as "Invalid Date".
          const fmtDate = (val) => {
            const iso = val instanceof Date ? val.toISOString().slice(0, 10) : String(val).slice(0, 10);
            return new Date(`${iso}T12:00:00Z`)
              .toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
          };
          const nextRow = await knex('scheduled_services')
            .where('customer_id', service.customer_id)
            .andWhere('scheduled_date', '>', afterIso)
            // NO 'rescheduled': phantom placeholders hold the OLD date until the
            // office rebooks — publishing one shows a stale time as still real
            // (same rule as the tree-shrub and nextAppointment queries below).
            .whereIn('status', ['pending', 'confirmed', 'en_route', 'on_site'])
            // "turf": commercial lawn persists as "Commercial Turf Treatment Program".
            // Grouped OR so it stays ANDed with the customer/date/status predicates.
            .andWhere((qb) => qb
              .whereRaw('LOWER(service_type) LIKE ?', ['%lawn%'])
              .orWhereRaw('LOWER(service_type) LIKE ?', ['%turf%']))
            .orderBy('scheduled_date', 'asc')
            .first('scheduled_date')
            .catch(() => null);
          let nextVisit = null;
          if (nextRow && nextRow.scheduled_date) {
            nextVisit = { label: fmtDate(nextRow.scheduled_date), source: 'scheduled' };
          } else if (svcIso) {
            const t = String(service.service_type || '').toLowerCase();
            const m = t.match(/every\s+(\d+)\s+week/);
            let weeks = m ? Number(m[1]) : null;
            if (weeks == null) {
              if (/bi-?weekly/.test(t)) weeks = 2;
              else if (/bi-?monthly/.test(t)) weeks = 8;
              else if (/monthly/.test(t)) weeks = 4;
              else if (/quarterly/.test(t)) weeks = 13;
              else if (/weekly/.test(t)) weeks = 1;
            }
            if (weeks) {
              const est = new Date(`${svcIso}T12:00:00Z`);
              est.setUTCDate(est.getUTCDate() + weeks * 7);
              // Report tokens are permanent — only surface an ESTIMATED next visit when
              // it's still in the future; reopening an old report must not show a past
              // date as the "next visit".
              if (est.getTime() > Date.now()) {
                nextVisit = { label: fmtDate(est.toISOString()), source: 'estimated', cadenceWeeks: weeks };
              }
            }
          }
          if (nextVisit && reportV2.snapshot) reportV2.snapshot.nextVisit = nextVisit;
        } catch { /* next-visit lookup is best-effort */ }
      }

      if (reportV2 && process.env.LAWN_REPORT_V2_NARRATIVE === 'true') {
        // The overlay rewrites customer-facing prose and validates only
        // banned-copy + rain-window rules — it can reintroduce advice that
        // contradicts today's applications (codex P1 r28). Skip it entirely
        // when treatment data is unverifiable, and reconcile its output
        // against the guard otherwise, restoring the deterministic string
        // for any field it contradicted.
        if (lawnTreatmentGuard && !lawnTreatmentGuard.verified) {
          console.warn('[report-data] lawn narrative overlay skipped — treatment data unverifiable');
        } else {
          const preOverlay = JSON.parse(JSON.stringify(reportV2));
          reportV2 = await applyLawnReportNarrative(reportV2, {
            grassLabel: grassLabelFor(lawnAssessment?.turfProfile?.grassType),
            observations: lawnAssessment?.observations || '',
            customerConcern: structuredCustomerConcern(structured),
          }).catch(() => reportV2);
          if (lawnTreatmentGuard?.guardProducts?.length) {
            const { treatmentGuard: tg, guardProducts: gp } = lawnTreatmentGuard;
            const bad = (text) => tg.contradictsAppliedProducts(text, gp);
            const restore = (host, prev, key) => {
              if (host && prev && typeof host[key] === 'string' && bad(host[key])) host[key] = prev[key];
            };
            restore(reportV2.snapshot, preOverlay.snapshot, 'statusHeadline');
            restore(reportV2.snapshot, preOverlay.snapshot, 'mainWatch');
            restore(reportV2.snapshot, preOverlay.snapshot, 'customerAction');
            restore(reportV2.snapshot, preOverlay.snapshot, 'rootCause');
            restore(reportV2.snapshot, preOverlay.snapshot, 'wavesNext');
            restore(reportV2.snapshot, preOverlay.snapshot, 'treatmentSummary');
            restore(reportV2.water, preOverlay.water, 'explanation');
            restore(reportV2.mowing, preOverlay.mowing, 'recommendation');
            restore(reportV2.treatment, preOverlay.treatment, 'summary');
            restore(reportV2, preOverlay, 'todaysResult');
            restore(reportV2, preOverlay, 'smsSummary');
            (reportV2.diagnosis || []).forEach((d, i) => {
              const prev = preOverlay.diagnosis?.[i];
              restore(d, prev, 'explanation');
              restore(d, prev, 'customerExplanation');
            });
            (reportV2.insights || []).forEach((ins, i) => {
              const prev = preOverlay.insights?.[i];
              ['headline', 'whatWeSaw', 'whyItMatters', 'wavesAction', 'customerAction', 'nextVisitPlan'].forEach((k) => restore(ins, prev, k));
            });
            if (reportV2.followUp && preOverlay.followUp) restore(reportV2.followUp, preOverlay.followUp, 'reason');
          }
        }
      }
    } catch {
      // Best-effort + additive: a V2 build hiccup must never break the report.
      reportV2 = null;
    }
  }

  // Tree & Shrub Report V2 — visual plant-health payload (unconditional, like
  // lawn: the TREE_SHRUB_REPORT_V2 env flag is retired — owner ungated
  // 2026-07-09 after prod ran flag-on since 06-26). Mirrors the lawn path: a
  // tech-confirmed tree_shrub_assessments row, scored from the visit's
  // photos, drives the five diagnosis categories + insights. Best-effort: a
  // build hiccup or unmigrated tables must never break the report.
  if (!reportV2 && serviceLine === 'tree_shrub') {
    try {
      const { buildTreeShrubAssessmentReportData } = require('../tree-shrub-assessment');
      const treeShrubAssessment = await buildTreeShrubAssessmentReportData(service, serviceLine, knex);
      if (treeShrubAssessment) {
        // Assessment photos the builder dropped for a failed signing are
        // expected images the artifact silently omits (codex P2 #3176 r22).
        imageResolutionFailures += Number(treeShrubAssessment.droppedPhotoCount) || 0;
        reportV2 = buildTreeShrubReportV2({
          treeShrubAssessment,
          applications,
          actions: Array.isArray(protocol?.actions) ? protocol.actions : [],
          customerConcern: structuredCustomerConcern(structured),
          waterSnapshot: null, // Phase 3: landscape water calibration
        });
        // AI "What we applied today" narrative (owner 2026-07-21): why each
        // product, what it does, the benefit — cached per input hash; the
        // deterministic template stands in when generation misses.
        if (reportV2?.snapshot?.treatmentSummary) {
          const { buildTreatmentNarrative } = require('./treatment-narrative');
          const narrative = await buildTreatmentNarrative({
            serviceRecordId: service.id,
            serviceLine: 'tree_shrub',
            treatment: reportV2.treatment,
            // The SCRUBBED summary, not raw observations — a vision overclaim
            // ("scale infestation") must not reach the narrative prompt
            // (codex P2 2026-07-22); the validator also rejects the terms.
            findingsText: reportV2.photoSummary || '',
            photoSummary: reportV2.photoSummary || '',
            knex,
          });
          reportV2.snapshot.treatmentSummary = narrative?.text || reportV2.snapshot.treatmentSummary;
          // Signature of the EXACT text rendered — PDF stores key off this,
          // never a DB re-read (codex P2 r15).
          treatmentNarrativeRenderedSignature = narrative?.signature || null;
        }
        // Next scheduled tree & shrub visit — confident date from a real upcoming
        // row, else omitted (never invent a precise date the data can't back).
        if (reportV2) {
          try {
            const svcRaw = service.service_date;
            const svcIso = svcRaw ? (svcRaw instanceof Date ? svcRaw.toISOString().slice(0, 10) : String(svcRaw).slice(0, 10)) : '';
            const todayIso = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
            const afterIso = svcIso && svcIso > todayIso ? svcIso : todayIso;
            // scheduled_date comes back from pg as a Date object; normalize it the
            // same way svcIso does above before slicing, or String(Date) yields
            // "Wed Jul 08 2026 …" and the label renders as "Invalid Date".
            const fmtDate = (val) => {
              const iso = val instanceof Date ? val.toISOString().slice(0, 10) : String(val).slice(0, 10);
              return new Date(`${iso}T12:00:00Z`)
                .toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
            };
            const nextRow = await knex('scheduled_services')
              .where('customer_id', service.customer_id)
              .andWhere('scheduled_date', '>', afterIso)
              .whereIn('status', ['pending', 'confirmed', 'en_route', 'on_site'])
              .andWhere((b) => b.whereRaw('LOWER(service_type) LIKE ?', ['%tree%']).orWhereRaw('LOWER(service_type) LIKE ?', ['%shrub%']))
              .orderBy('scheduled_date', 'asc')
              .first('scheduled_date')
              .catch(() => null);
            if (nextRow && nextRow.scheduled_date && reportV2.snapshot) {
              reportV2.snapshot.nextVisit = { label: fmtDate(nextRow.scheduled_date), source: 'scheduled' };
            }
          } catch { /* next-visit lookup is best-effort */ }
        }
      }
    } catch {
      reportV2 = null;
    }
  }

  // Next upcoming appointment for this customer (owner ask 2026-07-05: every
  // report shows the next visit, like the estimate documents) — and it must be
  // the next visit OF THIS REPORT'S SERVICE LINE (owner 2026-07-05: a pest
  // report shows the next pest visit, a lawn report the next lawn visit), so
  // candidates are classified with the same detectServiceLine the report
  // itself uses. The visit this report covers is excluded by id so a same-day
  // report never shows its own just-completed slot. Best-effort: never blocks
  // the report.
  // Rodent report refresh gate (owner ask 2026-07-27) — declared before the
  // next-appointment pick because the widened rodent-program match below is
  // part of the gated behavior: with the gate dark, reports keep the strict
  // same-line pick exactly as before (codex round-3 P2), so unsetting the
  // var restores pre-refresh output everywhere.
  const rodentReportRefresh = serviceLine === 'rodent'
    && process.env.GATE_RODENT_REPORT_REFRESH === 'true';

  let nextAppointment = null;
  try {
    const reportTodayIso = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    // Same disclosable statuses as findReportFollowupAppointment: pending /
    // confirmed / en_route / on_site — an in-progress visit IS the customer's
    // next appointment when they open an older report on the service day.
    // NO 'rescheduled': those are phantom placeholders holding the OLD
    // date/window until the office rebooks (see report-followup-appointment.js
    // — publishing one presents a stale time as if it were still real).
    // The service-line match happens in JS (detectServiceLine's rules are
    // regex-heavy and live in one place), so the candidate window must be
    // wide enough that nearer OTHER-line visits can't crowd out the next
    // same-line row — 200 covers ~4 years of weekly visits.
    const upcomingRows = await knex('scheduled_services')
      .where('customer_id', service.customer_id)
      .andWhere('scheduled_date', '>=', reportTodayIso)
      .whereIn('status', ['pending', 'confirmed', 'en_route', 'on_site'])
      .modify((qb) => {
        if (service.scheduled_service_id) qb.whereNot('id', service.scheduled_service_id);
      })
      .orderBy('scheduled_date', 'asc')
      .orderBy('window_start', 'asc')
      .limit(200)
      .catch(() => []);
    // A rodent report's "next visit" spans the whole rodent program —
    // trapping, exclusion, sanitation, proofing — including service names
    // that carry no rodent token ("Exclusion Service" alone falls to the
    // pest default). Owner 2026-07-27: the rodent report shows the next
    // service date if and only if it is rodent-related. The widened match
    // only claims names NO other line detects (the 'pest' fallback) — a
    // "Mosquito Trap Service" still detects as mosquito and stays out —
    // and isRodentAdjacentServiceType's negative guard keeps non-rodent
    // trapping ("Wildlife Trapping") out too. Other report lines keep the
    // strict same-line match.
    // Name shape alone is NOT rodent evidence (codex round-4/5 P2): a
    // generic "Sanitation & Cleanup" booking that has nothing to do with
    // the rodent program would satisfy the regex. The catalog is the
    // authority: a candidate whose scheduled_services.service_id points at
    // a services row with category 'rodent' is rodent-related regardless
    // of its (possibly customized/renamed) service_type label; unlinked
    // legacy rows fall back to exact catalog-NAME matching plus the
    // adjacent-shape regex. Best-effort: an unavailable catalog just keeps
    // the strict same-line match.
    let serviceCategoryById = null;
    let rodentCatalogNames = null;
    if (rodentReportRefresh) {
      try {
        const catalogRows = await knex('services').select('id', 'name', 'category');
        serviceCategoryById = new Map((Array.isArray(catalogRows) ? catalogRows : [])
          .filter((row) => row && row.id)
          .map((row) => [String(row.id), String(row.category || '')]));
        rodentCatalogNames = new Set((Array.isArray(catalogRows) ? catalogRows : [])
          .filter((row) => String(row?.category || '') === 'rodent')
          .map((row) => String(row.name || '').trim().toLowerCase())
          .filter(Boolean));
      } catch { serviceCategoryById = null; rodentCatalogNames = null; }
    }
    const nextApptRow = (Array.isArray(upcomingRows) ? upcomingRows : [])
      .find((row) => {
        // A resolvable catalog link is authoritative in BOTH directions
        // (codex round-8 P2): it admits a rodent-category visit under any
        // label AND vetoes a rodent-sounding label linked to a non-rodent
        // service. Label matching only ever judges unlinked/unresolvable
        // rows.
        const linkedCategory = rodentReportRefresh && serviceCategoryById && row.service_id
          ? serviceCategoryById.get(String(row.service_id)) || null
          : null;
        if (linkedCategory) return linkedCategory === 'rodent';
        const rowLine = detectServiceLine(row.service_type);
        if (rowLine === serviceLine) return true;
        if (!rodentReportRefresh) return false;
        // unlinked legacy rows: exact rodent-catalog name + adjacent shape
        return rowLine === 'pest'
          && isRodentAdjacentServiceType(row.service_type)
          && !!rodentCatalogNames
          && rodentCatalogNames.has(String(row.service_type || '').trim().toLowerCase());
      }) || null;
    if (nextApptRow && nextApptRow.scheduled_date) {
      const rawDate = nextApptRow.scheduled_date;
      nextAppointment = {
        serviceType: nextApptRow.service_type || null,
        scheduledDate: rawDate instanceof Date ? rawDate.toISOString().slice(0, 10) : String(rawDate).slice(0, 10),
        // window_start only — the customer-facing arrival window is always
        // window_start + 2 hours (window_end is the internal job block).
        windowStart: nextApptRow.window_start || null,
      };
    }
  } catch { /* best-effort */ }

  // Pest Visit Summary narrative (env-gated, additive): reweave the frozen
  // completion recap through the same grounded-narrative pattern the lawn
  // report uses, folding in the Pest Pressure trend, the visit's findings,
  // and the next appointment computed above.
  //  - LIVE VIEWS ONLY (opts.mode === 'live', set by the response wrapper —
  //    an explicit opt-in, never a default): queued PDFs, email copies,
  //    static renders, and helper callers like map.svg either fossilize a
  //    reschedulable appointment into a stored document or throw the summary
  //    away entirely — they all keep the plain recap and spend nothing.
  //  - pestPressure non-null = the "recurring pest" gate the pressure card
  //    already computes (showOnCustomerReport / line allow-list /
  //    requireRecurringFrequency) — one-time treatments keep the plain recap.
  //  - typed specialty reports (cockroach cleanout etc.) keep the plain
  //    recap, same as the pressure card.
  // Best-effort: never blocks the report.
  let visitSummary = structured.customerRecap || '';
  let visitSummarySource = visitSummary ? 'recap' : null;
  // Tech-reviewed AI report copy ("Generate AI report" → notes, parsed by
  // its WHAT WE DID / WHAT WE FOUND shape and banned-copy-screened) is the
  // fullest customer-facing account of the visit — it beats the SMS-style
  // recap as the report summary. Typed reports switch only when the frozen
  // snapshot's Today's Result body came from the technician report, so the
  // legacy Visit Summary section (rendered whenever Pest V2 is absent)
  // matches the card above it instead of reverting to the generic recap
  // (Codex P2 #2709) — and a body the snapshot rejected (zero state, old
  // snapshot) never resurfaces via the summary.
  {
    const technicianReport = technicianReportCustomerCopy(service.technician_notes);
    // A viewer-visible trapping snapshot declaring an initial setup screens
    // the body BEFORE it wins the summary. The snapshot that accepted this
    // body can be a different findings type entirely (a non-trapping
    // primary with a trapping COMPANION), so its acceptance never ran the
    // setup guard — and a body generated before the companion's selector
    // changed can still say the traps were checked or that nothing was
    // caught, winning the Visit Summary beside the companion's frozen
    // "Traps set" result (codex P1 r18). Same fallback as the narrative
    // lanes: the recap stays, and with the source left as 'recap' the
    // gated rodent narrative below rebuilds a grounded summary instead.
    // Uses narrativeTrapSetupSnapshot so viewer visibility matches the
    // narrative's stage rules exactly (round 12).
    // The COUNT screen runs from the same viewer-visible trapping snapshot
    // regardless of stage (pre-push P1 on 256c1f9): a follow-up companion
    // whose traps_checked or captures was corrected after the body was
    // generated would otherwise publish the stale number in the summary.
    // Unverifiable values (blank/missing) screen nothing, by
    // countContradictions' own rules.
    const visibleTrapSnapshot = [
      typedSnapshot,
      ...companionSnapshots.filter((snap) => staffViewer || snap.delivery === 'auto_send'),
    ].find((snap) => snap?.type === 'rodent_trapping') || null;
    // Scoped require matches this file's pattern for report-time helpers.
    const indicators = require('./activity-indicators');
    // A confirmed reconciliation prompt (frozen onto the accepting
    // snapshot's todaysResult at completion) is a PERSON overriding the
    // matcher — this render-time screen must honor that decision, not
    // silently re-reject the body they reviewed (codex P1 on the
    // reconciliation round).
    const trapSetupScreened = typedSnapshot?.todaysResult?.reconcileConfirmed === true
      // Companion-only completions freeze the override on the trapping
      // companion (there is no typed primary snapshot to carry it) —
      // viewer-filtered like everything else, since visibleTrapSnapshot is.
      || visibleTrapSnapshot?.todaysResult?.reconcileConfirmed === true
      || !technicianReport?.body
      || (
        (!narrativeTrapSetupSnapshot
          || indicators.setupContradictions(technicianReport.body).length === 0)
        && (!visibleTrapSnapshot
          || indicators.countContradictions(technicianReport.body, {
            traps_checked: visibleTrapSnapshot.values?.traps_checked,
            captures: visibleTrapSnapshot.values?.captures,
          }).length === 0)
      );
    const drivesSummary = technicianReport?.body && trapSetupScreened
      && (!typedSnapshot || typedSnapshot.todaysResult?.bodySource === 'technician_report');
    if (drivesSummary) {
      visitSummary = technicianReport.body;
      visitSummarySource = 'technician_report';
    }
  }
  if (
    serviceLine === 'pest'
    && !typedSnapshot
    && pestPressure
    && visitSummary
    // The AI report is already the rich, reviewed version of this visit —
    // reweaving it through the narrative would only risk distorting it.
    && visitSummarySource !== 'technician_report'
    && opts.mode === 'live'
    && process.env.PEST_VISIT_SUMMARY_NARRATIVE === 'true'
  ) {
    visitSummary = await applyVisitSummaryNarrative({
      recap: visitSummary,
      serviceTypeDisplay: linkedServiceName,
      areasServiced: areaLabels,
      pestPressure,
      findings,
      nextAppointment,
    }).catch(() => structured.customerRecap || '');
  }

  // Rodent report refresh (owner ask 2026-07-27, env-gated): the typed
  // rodent report's Visit Summary is the frozen SMS recap — it never sees
  // the findings, activity reading, trap counts, devices, or photo evidence
  // the rest of the report is built from. The gate reweaves all of it into
  // a detailed grounded narrative (rodent-report-narrative.js), and the
  // client uses the same flag to lift photos into the summary, show the
  // next rodent-related visit, drop the Rodent Service Coverage card (the
  // trap map owns the spatial story), and render the trap-styled map pins.
  // Tech-reviewed "Generate AI report" copy still wins the summary slot;
  // narrative generation is LIVE VIEWS ONLY (same posture as the pest
  // block). The rodentReportRefresh gate itself is computed above, before
  // the next-appointment pick it also widens. Kill switch: unset the var.
  if (
    rodentReportRefresh
    && typedSnapshot
    && visitSummarySource !== 'technician_report'
    && opts.mode === 'live'
  ) {
    const narrated = await applyRodentReportNarrative({
      recap: visitSummary,
      serviceTypeDisplay: linkedServiceName,
      typedReport: typedSnapshot,
      // Explicit, because the trapping snapshot may be a COMPANION while
      // typedReport is the primary — the narrative cannot derive the stage
      // from a snapshot it was never handed (codex P1 round 10). Viewer-
      // filtered (codex P1 round 12): see narrativeTrapSetupSnapshot.
      visitStage: narrativeTrapSetupSnapshot ? 'initial_trap_setup' : null,
      activity,
      stationSummary: stationMap?.summary || null,
      // summary.activity semantics differ by program (traps with a capture
      // vs stations with bait consumption) — the narrative names the fact
      // accordingly and must know which map this is.
      stationProgram: stationMap?.program || null,
      // The map card suppresses its own count line when the tech's typed
      // trap count disagrees with the pinned roster; the narrative must not
      // resurrect the disputed number from stationSummary (codex P1 r12).
      stationCountDisputed,
      applications,
      photos: photoPayload,
      nextAppointment,
    }).catch(() => null);
    if (narrated && narrated !== visitSummary) {
      visitSummary = narrated;
      visitSummarySource = 'rodent_narrative';
    }
  }

  // Typed-report narrative for EVERY OTHER typed specialty report on the
  // V1 surface (owner ask 2026-07-27, second lane): cockroach, bed bug,
  // termite bait, … keep the frozen recap/template as their summary — the
  // gate reweaves the typed data. NOTE: WDO inspections are OUT OF SCOPE
  // here — completion profiles exclude wdo_inspection from V1 and public
  // WDOs render on the project-report surface (codex P2 #3007 r7); a WDO
  // narrative would be its own lane on that surface. COMPANION typed
  // snapshots keep their ratified template bodies BY DESIGN (codex P2
  // r14): the narrative upgrades the report's ONE summary surface; the
  // companion cards are compliance record sections, and per-companion
  // generation would multiply view-time LLM calls without a summary slot
  // to fill.
  // The gate reweaves the
  // typed findings, activity reading, station counts, products, photo
  // evidence, and next same-line visit into the grounded narrative (same
  // engine + guard stack as the rodent refresh). Precedence unchanged: the
  // tech's reviewed "Generate AI report" copy still wins — both the summary
  // slot and a snapshot whose Today's Result body came from it. LIVE VIEWS
  // ONLY, so pdf/static/sms_preview output never varies with the gate (no
  // PDF cache-key impact). The client shows the narrative in whichever
  // summary surface the report renders: the legacy Visit Summary section,
  // or the Today's Result body when Pest/Mosquito V2 suppresses that
  // section (summarySource === 'typed_narrative' drives the override).
  // Kill switch: unset GATE_TYPED_REPORT_NARRATIVE.
  if (
    serviceLine !== 'rodent'
    // Lawn and tree & shrub have their own specialized narrative layers
    // (applyLawnReportNarrative / the T&S V2 composition) — a second
    // generic summary would duplicate or conflict with them, and this
    // engine's guards don't ground agronomic claims (codex P2 #3007 r6).
    && serviceLine !== 'lawn'
    && serviceLine !== 'tree_shrub'
    && typedSnapshot
    && visitSummarySource !== 'technician_report'
    && typedSnapshot.todaysResult?.bodySource !== 'technician_report'
    && opts.mode === 'live'
    && process.env.GATE_TYPED_REPORT_NARRATIVE === 'true'
  ) {
    const narrated = await applyTypedReportNarrative({
      recap: visitSummary,
      serviceTypeDisplay: linkedServiceName,
      reportTypeLabel: typedSnapshot.reportTypeLabel || typedSnapshot.typeLabel || null,
      typedReport: typedSnapshot,
      // Same reason as the rodent lane above: a non-rodent primary can carry
      // a rodent_trapping companion that selects the station map. Viewer-
      // filtered for the same round-12 reason.
      visitStage: narrativeTrapSetupSnapshot ? 'initial_trap_setup' : null,
      activity,
      stationSummary: stationMap?.summary || null,
      stationProgram: stationMap?.program || null,
      stationCountDisputed,
      applications,
      photos: photoPayload,
      nextAppointment,
    }).catch(() => null);
    if (narrated && narrated !== visitSummary) {
      visitSummary = narrated;
      visitSummarySource = 'typed_narrative';
    }
  }

  return {
    reportVersion: 'service_report_v1',
    reportV2,
    token,
    serviceRecordId: service.id,
    serviceType: service.service_type,
    serviceDisplayName: linkedServiceName,
    serviceLine,
    serviceLineDisplay: config.displayName,
    serviceDate: service.service_date,
    coverageServiceType: coverageServiceType(serviceLine),
    technicianName,
    technician: {
      name: technicianName,
      photoUrl: technicianPhotoUrl,
      initials: initialsForCustomerTechnicianName(technicianName),
    },
    // Dark-ship gate for the photo tech card on the report page. The
    // technician identity above is already per-visit
    // (service_records.technician_id, frozen at completion), so past
    // reports keep the tech who actually performed that visit. Records
    // with no technician attached keep the legacy plain-text cell —
    // the card would otherwise show a placeholder identity.
    techVisitCard: process.env.GATE_REPORT_TECH_PHOTO === 'true'
      && !!(service.technician_name || service.technician_first_name),
    reviewRequestEligible: !service.has_left_google_review,
    hasLeftGoogleReview: !!service.has_left_google_review,
    // Canonical review office for the report CTA, resolved SERVER-side
    // (config/locations.js resolveReviewLocation: city → zip → geo → stored
    // id) — the client's own substring tables were incomplete (no Port
    // Charlotte, no 33948) and routed those reports to the Bradenton profile
    // while the SMS and /go surfaces resolved Venice (codex #3285 r5). The
    // client keeps its table only as a fallback for cached old payloads.
    reviewLocation: (() => {
      const { resolveReviewLocation } = require('../../config/locations');
      const loc = resolveReviewLocation({
        city: service.city,
        zip: service.zip,
        latitude: service.customer_latitude ?? service.latitude ?? service.lat,
        longitude: service.customer_longitude ?? service.longitude ?? service.lng,
        nearest_location_id: service.nearest_location_id,
      }, { storedLocationId: service.nearest_location_id || null });
      return loc ? { id: loc.id, name: loc.name, reviewUrl: loc.googleReviewUrl } : null;
    })(),
    customerName: `${service.first_name || ''} ${service.last_name || ''}`.trim(),
    // Owner directive 2026-07-05: the report mirrors the estimate document and
    // shows the customer's own email/phone with the service address. Like the
    // estimate, the report token is a shareable bearer link the customer owns —
    // these are the reader's own contact details, same exposure model as the
    // address that already prints here.
    // Callers alias the customer join differently (the public routes select
    // email/phone; email delivery selects customer_email/customer_phone) —
    // read both so every render path carries the contact block.
    customerEmail: service.email || service.customer_email || null,
    customerPhone: service.phone || service.customer_phone || null,
    cityState: `${service.city || ''}${service.state ? ', ' + service.state : ''}`.trim().replace(/^,\s*/, ''),
    // Membership tier for this visit (see reportWaveGuardTier above). Consumed by the
    // report viewer to suppress the per-visit "Time on site" duration for members while
    // non-member reports honor the admin showDuration setting.
    waveGuardTier,
    // Self-serve re-service eligibility (false while the streamline gate is
    // dark or the plan grants no lane) — the footer's "free re-service"
    // sentence links to the authenticated portal Schedule tab in the live
    // view. Boolean only; the standing token never rides the public report.
    reserviceEligible,
    serviceAddress: compactAddress(service),
    propertyAddress: compactAddress(service),
    mapCenter,
    evidenceLevel,
    visitOutcome: protocol.visitOutcome || 'completed',
    arrived_at: arrivalTime,
    actual_start_time: serviceRecordTiming.actual_start_time || scheduledServiceTiming.actual_start_time || null,
    check_in_time: serviceRecordTiming.check_in_time || scheduledServiceTiming.check_in_time || null,
    completed_at: completionTime,
    actual_end_time: serviceRecordTiming.actual_end_time || scheduledServiceTiming.actual_end_time || null,
    check_out_time: serviceRecordTiming.check_out_time || scheduledServiceTiming.check_out_time || null,
    serviceRecord: serviceRecordTiming,
    scheduledService: scheduledServiceTiming,
    visitTiming: {
      arrivedAt: arrivalTime,
      exitedAt: completionTime,
      onSiteMinutes: onSiteMin,
    },
    summary: visitSummary,
    // 'technician_report' when summary is the tech-reviewed AI report copy,
    // 'rodent_narrative' / 'typed_narrative' when a gated narrative
    // composed it (typed_narrative also drives the client's Today's Result
    // body override on V2-suppressed summaries),
    // 'recap' for the completion recap — lets response wrappers (Pest V2
    // hero) surface the reviewed copy without re-parsing the notes.
    summarySource: visitSummarySource,
    // Customer concern captured at completion — feeds the pest V2 "what you
    // flagged" card (reports-public passes it to buildPestReportV2). Lawn and
    // tree & shrub already consume it inside their own V2 builders.
    customerConcern: structuredCustomerConcern(structured),
    customerInteraction: service.customer_interaction || structured.customerInteraction || null,
    serviceAreas: areaLabels,
    measurements: {
      soilTemp: service.soil_temp,
      thatch: service.thatch_measurement,
      soilPh: service.soil_ph,
      moisture: service.soil_moisture,
    },
    pressureIndex,
    pestPressure,
    activity,
    typedReport: typedSnapshot
      ? {
        type: typedSnapshot.type,
        typeLabel: typedSnapshot.typeLabel || null,
        reportTypeLabel: typedSnapshot.reportTypeLabel || null,
        visitSequence: typedSnapshot.visitSequence || 1,
        isProgressVisit: (typedSnapshot.visitSequence || 1) > 1,
        todaysResult: typedSnapshot.todaysResult || null,
        findings: Array.isArray(typedSnapshot.findings) ? typedSnapshot.findings : [],
        nextStepChips: Array.isArray(typedSnapshot.nextStepChips) ? typedSnapshot.nextStepChips : [],
        photoSummary: typedSnapshot.photoSummary || null,
        schemaVersion: typedSnapshot.schemaVersion || null,
      }
      : null,
    typedVisitTimeline,
    // Companion sections, ordered as stored (declared profile order),
    // already viewer-filtered above — customers never receive
    // internal_only entries.
    companionReports,
    metrics,
    mapSvg,
    mapSvgUrl: `/api/reports/${token}/map.svg`,
    treatmentNarrativeRenderedSignature,
    treatmentMap: {
      schematic: {
        svg: mapSvg,
        label: 'Schematic view of inspected and treated zones. Service zones are approximate.',
      },
      satellite: satelliteMap,
      traced: tracedTreatmentZone,
      footer: 'Treatment areas are technician-reported service zones, not survey boundaries.',
    },
    stationMap,
    // Rodent refresh drops the coverage card ONLY when the trap/station map
    // actually renders in its place — the zone list duplicated it (owner
    // 2026-07-27). That means stationMap.available AND a live view: the
    // client only mounts StationMapCard on mode === 'live' (no satellite
    // basemap in pdf/static per provider ToS), so PDF renders and rodent
    // reports with no station map (exclusion/sanitation visits) keep
    // coverage as their only spatial section. MUST be an explicit
    // `enabled: false` — a null/absent key makes the client REBUILD the
    // card from serviceLocations/serviceAreas (its legacy fallback path).
    serviceCoverage: rodentReportRefresh && stationMap?.available && opts.mode === 'live'
      ? { enabled: false }
      : serviceCoverage,
    // Client-side switch for the refreshed rodent layout (photos in the
    // summary, trap-styled animated map pins). LIVE VIEWS ONLY: stored PDF
    // keys don't carry this gate, so a flag that changed pdf/static markup
    // would keep serving stale cached PDFs across a gate flip (codex P2
    // #3004) — non-live renders keep the legacy layout unconditionally.
    rodentReportRefresh: (rodentReportRefresh && opts.mode === 'live') || undefined,
    nextAppointment,
    visitTimeline,
    serviceLocations,
    workflowEvents,
    zones: publicZones,
    applications,
    conditions: {
      ...parseJsonObject(service.conditions),
      ...parseJsonObject(service.weather_data),
    },
    findings,
    recommendations,
    protocol,
    advisory,
    lawnAssessment,
    mowingHeight,
    lawnProgramOverview,
    visualServiceMoments: approvedVisualMoments,
    proofMoments: approvedVisualMoments,
    // Drop the gauge/lawn-length photo from the gallery only when Lawn Report V2
    // actually built and surfaced it in the mowing module (else it would show
    // twice). A null/failed V2 build keeps it in the gallery so it is never lost.
    photos: (gaugePhotoId && reportV2 && mowingHeight && mowingHeight.photoUrl)
      ? photoPayload.filter((p) => String(p.id) !== String(gaugePhotoId))
      : photoPayload,
    // Marked-photo cards (GATE_PHOTO_MARKS, dark) — one per photo carrying
    // treated-point marks. Empty on every other visit, which is the whole
    // "marks are optional" ruling: no marks means no card, not an empty state.
    // Deliberately carries NO count/total (see photo-marks.js ruling 3).
    markedPhotos: photoPayload
      .map((photo) => {
        const context = buildMarkedPhotoContext({
          marks: photo.marks,
          // photoLaneVerdict, not the primary: a foam ADD-ON makes the visit
          // a photo lane and must be able to publish the card (codex P1 r3).
          // Null when no line is a photo lane — the context then declines on
          // lane_not_eligible, which is the correct answer.
          eligibility: photoLaneVerdict || traceEligibility,
        });
        if (!context.available || !photo.url) return null;
        return {
          photoId: photo.id,
          url: photo.url,
          caption: photo.caption || '',
          marks: context.marks,
          legend: context.legend,
          captionKey: context.captionKey,
        };
      })
      .filter(Boolean),
    photoChain,
    pdfUrl: `/api/reports/${token}`,
    // Canonical PUBLIC origin for links baked into the permanent PDF, and ''
    // when none is configured. The headless renderer opens the page through
    // CLIENT_URL / SERVICE_REPORT_PDF_BASE_URL, which on prod is the raw
    // Railway hostname, so the document can't trust its own origin there.
    // But it must NOT be handed the production default either: a preview
    // deployment's token only resolves on that preview, so with no explicit
    // origin configured the document falls back to its own (see portalBase).
    publicOrigin: configuredPublicPortalOrigin(),
    // A station/trap visit whose placement section was dropped because the
    // LIVE basemap call failed transiently (quota, network, provider config
    // unavailable) — not because the lane is off or the visit has no
    // stations (codex P2 #3176 r23). The cache key hashes provider/env
    // configuration, which is unchanged by a transient miss, so without
    // this flag the map-less PDF would be stored under exactly the key
    // expected after the provider recovers and the report would never
    // regain its map. Counted like an image drop: serve it, cache nothing.
    stationMapTransientlyUnavailable: stationMap?.available === false
      && ['satellite_unavailable', 'provider_config_unavailable', 'build_failed']
        .includes(String(stationMap?.reason || '')),
    // Images this build EXPECTED but silently dropped (URL resolution
    // failed): the document folds this into its render-failure counter and
    // the store paths refuse to cache on it (codex P2 #3176 r21) — a
    // placeholder-free but incomplete PDF must not become the permanent
    // healthy object.
    // Approved moments whose media would not sign come back with a null
    // mediaUrl and the document filters them before any <img> mounts, so
    // neither the page counter nor the URL probe can see them (codex P2
    // #3176 r22). Counted HERE, at the payload boundary, because the
    // moments load long before this return. Videos are excluded — the
    // document never renders them.
    imageResolutionFailures: imageResolutionFailures
      + (Array.isArray(approvedVisualMoments) ? approvedVisualMoments : [])
        .filter((m) => m && m.mediaType !== 'video' && !m.mediaUrl).length,
    legacy: {
      // No raw technician_notes here (owner ruling 2026-07-16): the field is
      // internal — access codes, billing notes — and the only sanctioned path
      // to customer copy is technicianReportCustomerCopy's reviewed parse,
      // which already feeds the summary slot. The client never read this key.
      measurements: {
        soilTemp: service.soil_temp,
        thatch: service.thatch_measurement,
        soilPh: service.soil_ph,
        moisture: service.soil_moisture,
      },
    },
  };
}

module.exports = {
  buildReportV1Data,
  // Pure — exported so the rainfall-provenance contract can be tested against
  // the real implementation rather than a copy of it.
  buildLawnWaterContext,
  resolveTracedExteriorZone,
  structuredCustomerConcern,
  stripLiveOnlyScheduleFields,
  calculateLawnOverallScore,
  lawnScoreDelta,
  lawnScoreValue,
  resolveStressDamage,
  singleVoiceObservation,
  parseJsonObject,
  parseJsonArray,
  uniqueStrings,
  locationAreaLabels,
  taggedNoteLines,
  minutesFromElapsed,
  methodFromProduct,
  inferCatalogProductType,
  approvedReportProductFacts,
  attachApprovedReportProductFacts,
  loadLawnProgramOverviewContext,
  normalizeAdvisoryForTreatmentScope,
  buildCompletionAdvisory,
  serviceDisplayName,
  treatmentScope,
  buildLawnAssessmentReportData,
  loadLinkedLawnAssessment,
  PinnedAssessmentUnavailable,
  loadPinnedLawnAssessment,
  lawnAssessmentPdfSignature,
  resolveCanonicalLawnRender,
  freezeLawnWeekWeather,
  frozenWeekMatches,
  storedWeekFor,
  LAWN_RENDER_STRATEGY,
  PIN_NO_ASSESSMENT,
  formatApprovedLawnSnapshot,
  formatApprovedLawnRecommendation,
  defaultGeometry,
  defaultZones,
  zoneSupportsServiceLine,
  coverageServiceType,
  serviceCoverageLocations,
  buildWorkflowEvents,
  buildVisitTimeline,
  firstValidTimestamp,
  publicTimingFields,
  resolveReportArrivalTime,
  resolveReportCompletionTime,
  monthFromServiceDate,
  firstNumber,
};
