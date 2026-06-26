const db = require('../../models/db');
const { METHOD_LABELS, renderTreatmentMap } = require('./treatment-map');
const { detectServiceLine, getServiceLineConfig } = require('./service-line-configs');
const { customerVisiblePressureIndex } = require('../pest-pressure/display');
const { loadActiveConfig, loadScoreForServiceRecord, loadHistoryForCustomer } = require('../pest-pressure/store');
const { buildPestPressureCustomerView } = require('../pest-pressure/customer-view');
const { buildNoActivityFinding } = require('./no-activity-finding');
const { isCardCustomerSurfaceable } = require('../lawn-recommendation-visibility');
const { buildIrrigationAdvice } = require('./irrigation-advice');
const { buildMowingHeightContext } = require('./turf-height');
const { buildLawnReportV2, grassLabelFor } = require('./lawn-report-v2');
const { buildTreeShrubReportV2 } = require('./tree-shrub-report-v2');
const { applyLawnReportNarrative } = require('./lawn-report-narrative');
const { getTurfHeightForVisit, getTurfHeightTrend } = require('../turf-height-service');
const { fetchServiceWeekWeather } = require('./application-conditions');
const { validatePhotoChainRows } = require('./photo-chain');
const { buildSatelliteTreatmentMapContext } = require('./satellite-treatment-map');
const { computeLinearFt, computeOnSiteMin } = require('./metrics-band');
const { loadActivityCustomerView } = require('./activity-scores-store');
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
    irrigationNotes: catalog.irrigation_notes || null,
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
        'irrigation_notes',
        'label_verified_at',
        'label_version',
        'approved_for_service_report',
      );
  } catch {
    return products;
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

function buildLawnWaterContext({ assessment = {}, turfProfile = null, propertyPrefs = null, fawnSnapshot = {}, serviceDate = null, completionRainfallInchesToday = null, completionRainfall7dInches = null, completionEt0Inches = null, completionDailyRain = null } = {}) {
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
    // Per-day rainfall over the trailing 7 days at the client's lat/lng (same
    // Open-Meteo source as rainfallInches7d), raw as [{ date, inches }]. The
    // report's 7-day chart renders from this so it matches the weekly total and
    // is property-specific. Null when no complete window is available.
    dailyRain7d: Array.isArray(completionDailyRain) ? completionDailyRain : null,
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
  const textExterior = /\b(exterior|outside|outdoor|perimeter|foundation|eaves|soffit|yard|front|back|rear|side|lanai|patio|pool|driveway|landscape|mulch|entry|threshold|lawn)\b/.test(text);
  // Structured action scope is additive: an interior treatment fires interior
  // even when only exterior areas were chipped (and vice-versa).
  const action = structuredActionScope(service);
  return {
    hasInterior: textInterior || action.hasInterior,
    hasExterior: textExterior || action.hasExterior,
    hasExplicitScope: text.trim().length > 0 || action.hasTreatment,
  };
}

function normalizeAdvisoryForTreatmentScope(advisory = {}, { service = {}, applications = [], zones = [] } = {}) {
  const normalized = { ...parseJsonObject(advisory) };
  const scope = treatmentScope({ service, applications, zones });

  if (normalized.interior_reentry_min != null && scope.hasExplicitScope && scope.hasExterior && !scope.hasInterior) {
    normalized.interior_reentry_min = 0;
  }
  if (normalized.exterior_reentry_min != null && scope.hasExplicitScope && scope.hasInterior && !scope.hasExterior) {
    normalized.exterior_reentry_min = 0;
  }

  return normalized;
}

// Build the advisory persisted at completion time from the exact inputs the
// completion route has on hand. This is the write-path gate: whatever scope is
// resolved here is what the customer sees — the report build can only zero it
// further, never restore it. Kept as a pure helper so the scope wiring is
// directly testable without the full /complete route harness.
function buildCompletionAdvisory({ advisoryDefaults = {}, completionAreas = [], protocolActionScopes = [], applications = [] } = {}) {
  return normalizeAdvisoryForTreatmentScope(advisoryDefaults, {
    service: {
      areas_serviced: completionAreas,
      structured_notes: {
        areasTreated: completionAreas,
        protocolActionScopesCompleted: protocolActionScopes,
      },
    },
    applications,
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

function matchZoneIds(product, zones) {
  const explicit = parseJsonArray(product.zone_ids);
  if (explicit.length) return explicit.map(String);
  const area = String(product.application_area || product.area || '').toLowerCase();
  if (area) {
    const matched = zones.filter((zone) => {
      return String(zone.label || '').toLowerCase().includes(area)
        || area.includes(String(zone.label || '').toLowerCase());
    });
    if (matched.length) return matched.map((zone) => String(zone.id));
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
  if (photo.s3_url) return photo.s3_url;
  if (!photo.s3_key || !PhotoService) return null;
  try {
    return await PhotoService.getViewUrl(photo.s3_key, 15 * 60);
  } catch {
    return null;
  }
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

function shouldAddNoActivityFinding({ service = {}, structured = {}, protocol = {} } = {}) {
  const visitOutcome = String(protocol.visitOutcome || service.visit_outcome || service.status || 'completed').toLowerCase();
  const concernText = String(
    structured.customerConcernText
    || structured.customer_concern_text
    || structured.customerConcern
    || structured.customer_concern
    || '',
  ).trim();
  return visitOutcome === 'completed'
    && !(protocol.observations || []).length
    && !(protocol.recommendations || []).length
    && !concernText;
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
  if (explicit != null && row.stress_damage != null) return explicit;
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
    return await PhotoService.getViewUrl(photo.s3_key, 15 * 60);
  } catch {
    return null;
  }
}

async function firstLawnAssessmentPhoto(knex, assessmentId) {
  if (!assessmentId) return null;
  return knex('lawn_assessment_photos')
    .where({ assessment_id: assessmentId, customer_visible: true })
    .orderBy('is_best_photo', 'desc')
    .orderBy('quality_score', 'desc')
    .orderBy('photo_order', 'asc')
    .first()
    .catch(() => null);
}

async function loadLinkedLawnAssessment(service, knex = db) {
  if (!service?.customer_id) return null;

  const baseCriteria = { customer_id: service.customer_id, confirmed_by_tech: true };
  const byRecord = service.id
    ? await knex('lawn_assessments')
      .where({ ...baseCriteria, service_record_id: service.id })
      .orderBy('confirmed_at', 'desc')
      .orderBy('created_at', 'desc')
      .first()
      .catch(() => null)
    : null;
  if (byRecord) return byRecord;

  const scheduledServiceId = service.scheduled_service_id || service.service_id;
  const byService = scheduledServiceId
    ? await knex('lawn_assessments')
      .where({ ...baseCriteria, service_id: scheduledServiceId })
      .orderBy('confirmed_at', 'desc')
      .orderBy('created_at', 'desc')
      .first()
      .catch(() => null)
    : null;
  if (byService) return byService;

  // Intentionally NO customer-wide fallback. A visit only shows the Lawn
  // Intelligence card for an assessment linked to THIS visit (by service
  // record or scheduled service). Falling back to the customer's most-recent
  // assessment would label last month's scores as today's result, so when the
  // visit has no assessment of its own we show nothing.
  return null;
}

async function buildLawnAssessmentReportData(service, serviceLine, knex = db) {
  if (serviceLine !== 'lawn') return null;
  const assessment = await loadLinkedLawnAssessment(service, knex);
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
    const [beforePhoto, afterPhoto] = await Promise.all([
      firstLawnAssessmentPhoto(knex, initialRow.id),
      firstLawnAssessmentPhoto(knex, assessment.id),
    ]);
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
  try {
    const weekWeather = await fetchServiceWeekWeather({
      latitude: service.customer_latitude ?? service.latitude ?? service.lat,
      longitude: service.customer_longitude ?? service.longitude ?? service.lng,
      serviceDate: assessment.service_date,
    });
    completionRainfall7dInches = weekWeather.rainInches;
    completionEt0Inches = weekWeather.et0Inches;
    completionDailyRain = weekWeather.dailyRain;
  } catch (e) { /* non-blocking */ }
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
      // other surfaces (lawn-snapshot, waveguard-plan-engine), so it is not emitted here.
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
  const [rawProducts, geometryRow, dbZones, dbFindings, photos, scheduledService, approvedVisualMoments] = await Promise.all([
    knex('service_products').where({ service_record_id: service.id }).orderBy('created_at').catch(() => []),
    knex('property_geometries').where({ customer_id: service.customer_id }).orderBy('version', 'desc').first().catch(() => null),
    knex('property_zones').where({ customer_id: service.customer_id, is_active: true }).orderBy('letter').catch(() => []),
    knex('service_findings').where({ service_record_id: service.id }).orderBy('created_at').catch(() => []),
    knex('service_photos').where({ service_record_id: service.id }).orderBy('sort_order').orderBy('created_at').catch(() => []),
    scheduledServicePromise,
    loadApprovedVisualServiceMomentsForReport(service, knex).catch(() => []),
  ]);
  const products = await attachApprovedReportProductFacts(knex, rawProducts);

  const areaLabels = locationAreaLabels([
    ...parseJsonArray(service.areas_serviced),
    ...parseJsonArray(structured.areasServiced),
    ...parseJsonArray(structured.areasTreated),
  ]);
  const supportedDbZones = dbZones.filter((zone) => zoneSupportsServiceLine(zone, serviceLine));
  const zones = supportedDbZones.length ? supportedDbZones : defaultZones(areaLabels, serviceLine);
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

  const lawnAssessment = await buildLawnAssessmentReportData(service, serviceLine, knex);
  // Mowing height-of-cut — surfaced at the top level (not inside lawnAssessment)
  // so it shows on lawn reports even when there's no vision assessment. Null when
  // not a lawn visit or no reading was captured. The trend is capped at THIS
  // report's reading time so a long-lived report token can't expose later visits.
  let mowingHeight = null;
  if (serviceLine === 'lawn') {
    const turfReading = await getTurfHeightForVisit(service.id, knex);
    const turfTrend = turfReading
      ? await getTurfHeightTrend(service.customer_id, 12, knex, turfReading.measured_at)
      : [];
    mowingHeight = buildMowingHeightContext(turfReading, turfTrend);
  }
  const lawnProgramOverview = await loadLawnProgramOverviewContext(knex, service, serviceLine, scheduledService);
  const hasLawnAssessmentSignal = hasLawnAssessmentCustomerSignal(lawnAssessment);

  // Typed reports carry their real findings in the snapshot (rendered by
  // TypedFindingsCard) — the legacy no-activity fallback would contradict
  // e.g. an active cockroach visit's snapshot.
  if (!typedSnapshot && !findings.length && !hasLawnAssessmentSignal && shouldAddNoActivityFinding({ service, structured, protocol })) {
    findings.push({
      id: `no-activity-${service.id}`,
      zoneId: null,
      ...buildNoActivityFinding(serviceLine),
    });
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
        }).catch(() => [])
      : Promise.resolve([]),
    serviceCoverageConfigPromise,
    visitTimelineConfigPromise,
  ]);
  // Typed specialty reports never render Pest Pressure — these service
  // types can detect to the 'pest' line and slip past the recurring-label
  // gates, which would leak the pressure UI (or its insufficient-data
  // placeholder) onto e.g. a cockroach cleanout report. Explicit gate.
  const pestPressure = typedSnapshot
    ? null
    : buildPestPressureCustomerView({
      config: pestPressureConfig,
      scoreRow: pestPressureRow,
      serviceRecord: service,
      historyRows: pestPressureHistory,
    });
  const activity = typedSnapshot
    ? await loadActivityCustomerView(knex, { snapshot: typedSnapshot, service }).catch(() => null)
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
      .map(async (snapshot) => ({
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
        activity: await loadActivityCustomerView(knex, { snapshot, service }).catch(() => null),
      })),
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
        irrigation_notes: product.approved_report_product_facts?.irrigationNotes || null,
        label_verified_at: product.approved_report_product_facts?.labelVerifiedAt || null,
        label_version: product.approved_report_product_facts?.labelVersion || null,
        facts_approved: !!product.approved_report_product_facts,
      },
      method,
      methodLabel: METHOD_LABELS[method] || method.replace(/_/g, ' '),
      zone_ids: matchZoneIds(product, zones),
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
  // Drop the turf-height gauge image from the customer DISPLAY payload only — it's
  // a measurement/QA artifact, not a field photo. It stays in `photos` so the
  // tamper-evident hash chain (validated below) remains intact. Fail-soft.
  let gaugePhotoId = null;
  try {
    const gaugeRow = await knex('turf_height_readings')
      .where({ service_record_id: service.id })
      .whereNotNull('gauge_photo_id')
      .first('gauge_photo_id');
    gaugePhotoId = gaugeRow?.gauge_photo_id || null;
  } catch { gaugePhotoId = null; }
  const photoPayload = await Promise.all(photos
    .filter((photo) => !gaugePhotoId || String(photo.id) !== String(gaugePhotoId))
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
    })));
  // Lawn visits capture turf photos in the tech's Lawn Assessment block instead
  // of a separate Service Photos upload. Surface those turf photos in the
  // customer gallery so the single capture point feeds both the lawn scorecard
  // and the report's photo gallery. Appended AFTER the service_photos hash chain
  // is validated below so the tamper-evident chain stays over service_photos only.
  if (serviceLine === 'lawn') {
    const linkedAssessment = await loadLinkedLawnAssessment(service, knex);
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
        if (!url) return null;
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
  const advisory = normalizeAdvisoryForTreatmentScope({
    ...config.advisoryDefaults,
    ...parseJsonObject(service.advisory),
    ...(service.irrigation_recommendation ? { irrigation: service.irrigation_recommendation } : {}),
  }, { service, applications });
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
    serviceDisplayName: serviceDisplayName(service),
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

  // Lawn Report V2 — visual-insight payload (flag-gated, additive). Deterministic
  // structure (diagnosis / water / mowing / treatment / trends) from the data already
  // computed for V1; optional LLM narrative overlay (VOICE) varies the prose per visit
  // and falls back to the deterministic copy field-by-field. Never blocks the report.
  let reportV2 = null;
  if (serviceLine === 'lawn' && process.env.LAWN_REPORT_V2 === 'true' && lawnAssessment) {
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

      reportV2 = buildLawnReportV2({
        lawnAssessment,
        mowingHeight,
        applications,
        actions: Array.isArray(protocol?.actions) ? protocol.actions : [],
        customerConcern: structured.customerConcern || structured.customer_concern || '',
        waterSnapshot,
      });
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
          const fmtDate = (iso) => new Date(`${String(iso).slice(0, 10)}T12:00:00Z`)
            .toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
          const nextRow = await knex('scheduled_services')
            .where('customer_id', service.customer_id)
            .andWhere('scheduled_date', '>', afterIso)
            .whereIn('status', ['pending', 'confirmed', 'en_route', 'on_site', 'rescheduled'])
            .whereRaw('LOWER(service_type) LIKE ?', ['%lawn%'])
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
        reportV2 = await applyLawnReportNarrative(reportV2, {
          grassLabel: grassLabelFor(lawnAssessment?.turfProfile?.grassType),
          observations: lawnAssessment?.observations || '',
          customerConcern: structured.customerConcern || structured.customer_concern || '',
        }).catch(() => reportV2);
      }
    } catch {
      // Best-effort + additive: a V2 build hiccup must never break the report.
      reportV2 = null;
    }
  }

  // Tree & Shrub Report V2 — visual plant-health payload (flag-gated, additive).
  // Mirrors the lawn path: a tech-confirmed tree_shrub_assessments row, scored from
  // the visit's photos, drives the five diagnosis categories + insights. Best-effort:
  // a build hiccup or unmigrated tables must never break the report.
  if (!reportV2 && serviceLine === 'tree_shrub' && process.env.TREE_SHRUB_REPORT_V2 === 'true') {
    try {
      const { buildTreeShrubAssessmentReportData } = require('../tree-shrub-assessment');
      const treeShrubAssessment = await buildTreeShrubAssessmentReportData(service, serviceLine, knex);
      if (treeShrubAssessment) {
        reportV2 = buildTreeShrubReportV2({
          treeShrubAssessment,
          applications,
          actions: Array.isArray(protocol?.actions) ? protocol.actions : [],
          customerConcern: structured.customerConcern || structured.customer_concern || '',
          waterSnapshot: null, // Phase 3: landscape water calibration
        });
        // Next scheduled tree & shrub visit — confident date from a real upcoming
        // row, else omitted (never invent a precise date the data can't back).
        if (reportV2) {
          try {
            const svcRaw = service.service_date;
            const svcIso = svcRaw ? (svcRaw instanceof Date ? svcRaw.toISOString().slice(0, 10) : String(svcRaw).slice(0, 10)) : '';
            const todayIso = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
            const afterIso = svcIso && svcIso > todayIso ? svcIso : todayIso;
            const fmtDate = (iso) => new Date(`${String(iso).slice(0, 10)}T12:00:00Z`)
              .toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
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

  return {
    reportVersion: 'service_report_v1',
    reportV2,
    token,
    serviceRecordId: service.id,
    serviceType: service.service_type,
    serviceDisplayName: serviceDisplayName(service),
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
    reviewRequestEligible: !service.has_left_google_review,
    hasLeftGoogleReview: !!service.has_left_google_review,
    customerName: `${service.first_name || ''} ${service.last_name || ''}`.trim(),
    // customerPhone/customerEmail intentionally NOT in the public report payload —
    // the report token is a shareable bearer credential, so contact PII must not
    // ride it. (Recap SMS loads the phone server-side via its own query.)
    cityState: `${service.city || ''}${service.state ? ', ' + service.state : ''}`.trim().replace(/^,\s*/, ''),
    // Membership tier for this visit (see reportWaveGuardTier above). Consumed by the
    // report viewer to suppress the per-visit "Time on site" duration for members while
    // non-member reports honor the admin showDuration setting.
    waveGuardTier,
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
    summary: structured.customerRecap || '',
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
    // Companion sections, ordered as stored (declared profile order),
    // already viewer-filtered above — customers never receive
    // internal_only entries.
    companionReports,
    metrics,
    mapSvg,
    mapSvgUrl: `/api/reports/${token}/map.svg`,
    treatmentMap: {
      schematic: {
        svg: mapSvg,
        label: 'Schematic view of inspected and treated zones. Service zones are approximate.',
      },
      satellite: satelliteMap,
      footer: 'Treatment areas are technician-reported service zones, not survey boundaries.',
    },
    serviceCoverage,
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
    photos: photoPayload,
    photoChain,
    pdfUrl: `/api/reports/${token}`,
    legacy: {
      notes: service.technician_notes || '',
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
  calculateLawnOverallScore,
  lawnScoreDelta,
  lawnScoreValue,
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
