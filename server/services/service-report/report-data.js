const db = require('../../models/db');
const { METHOD_LABELS, renderTreatmentMap } = require('./treatment-map');
const { detectServiceLine, getServiceLineConfig } = require('./service-line-configs');
const { pressureFromFindings } = require('./pressure-index');
const { validatePhotoChainRows } = require('./photo-chain');
const { buildSatelliteTreatmentMapContext } = require('./satellite-treatment-map');
const { resolveTechPhotoUrl } = require('../tech-photo');

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

function minutesFromElapsed(value) {
  if (!value) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  const text = String(value);
  const hms = text.match(/^(\d+):(\d{2}):(\d{2})$/);
  if (hms) return Math.round((Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3])) / 60);
  const ms = text.match(/^(\d+):(\d{2})$/);
  if (ms) return Math.round((Number(ms[1]) * 60 + Number(ms[2])) / 60);
  const numeric = Number(text);
  return Number.isFinite(numeric) ? Math.round(numeric) : null;
}

function methodFromProduct(product, serviceLine) {
  const raw = String(product.application_method || product.method || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
  if (raw && raw !== 'null') return raw;
  const category = String(product.product_category || '').toLowerCase();
  if (category.includes('bait') || category.includes('gel') || category.includes('glue')) return 'bait_placement';
  if (category.includes('fert') || category.includes('granular')) return 'granular_broadcast';
  if (serviceLine === 'mosquito') return 'fog_ulv';
  if (serviceLine === 'lawn') return category.includes('herb') ? 'spot_treatment' : 'broadcast_spray';
  if (serviceLine === 'rodent' || serviceLine === 'termite') return 'station_check';
  return 'perimeter_spray';
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
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
      app.method,
      app.methodLabel,
      app.applicationMethod,
      app.application_method,
    );
    values.push(...parseJsonArray(app.targets));
  }

  for (const zone of zones || []) {
    values.push(zone.label, zone.category);
  }

  return uniqueStrings(values);
}

function treatmentScope({ service = {}, applications = [], zones = [] } = {}) {
  const text = scopeTextValues({ service, applications, zones })
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
  const hasInterior = /\b(interior|inside|indoor|kitchen|bath|bathroom|baseboard|baseboards|bedroom|living room|laundry|utility room|pantry|closet)\b/.test(text);
  const hasExterior = /\b(exterior|outside|outdoor|perimeter|foundation|eaves|soffit|yard|front|back|rear|side|lanai|patio|pool|driveway|landscape|mulch|entry|threshold|lawn)\b/.test(text);
  return { hasInterior, hasExterior, hasExplicitScope: text.trim().length > 0 };
}

function normalizeAdvisoryForTreatmentScope(advisory = {}, { service = {}, applications = [], zones = [] } = {}) {
  const normalized = { ...parseJsonObject(advisory) };
  const scope = treatmentScope({ service, applications, zones });

  if (normalized.interior_reentry_min != null && !scope.hasInterior) {
    normalized.interior_reentry_min = 0;
  }
  if (normalized.exterior_reentry_min != null && scope.hasInterior && !scope.hasExterior) {
    normalized.exterior_reentry_min = 0;
  }

  return normalized;
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

function initialsForName(value) {
  const parts = String(value || 'Waves team').trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'W';
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
  if (metric.aggregate === 'count_findings') return context.findings.length;
  if (metric.aggregate === 'pressure_index') return context.pressureIndex;
  if (metric.key === 'linear_ft') {
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

function findingSeverityForObservation(text) {
  const lower = String(text || '').toLowerCase();
  if (lower.includes('customer concern') || lower.includes('access')) return 'medium';
  if (lower.includes('rodent') || lower.includes('fungus')) return 'medium';
  if (lower.includes('standing water') || lower.includes('irrigation')) return 'low';
  return 'low';
}

function lawnScoreValue(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
}

function calculateLawnOverallScore(row = {}) {
  const explicit = lawnScoreValue(row.overall_score);
  if (explicit != null) return explicit;
  const turf = Number(row.turf_density) || 0;
  const weeds = Number(row.weed_suppression) || 0;
  const color = Number(row.color_health) || 0;
  const fungus = Number(row.fungus_control) || 0;
  const thatch = Number(row.thatch_level) || 0;
  return Math.round((turf * 0.30) + (weeds * 0.25) + (color * 0.20) + (fungus * 0.15) + (thatch * 0.10));
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
  const delta = Number(current.overallScore || 0) - Number(initial.overallScore || 0);
  if (delta > 0) return `Lawn health is up ${delta} point${delta === 1 ? '' : 's'} since your first assessment.`;
  if (delta < 0) return `Lawn health is down ${Math.abs(delta)} point${Math.abs(delta) === 1 ? '' : 's'} since your first assessment.`;
  return 'Lawn health is holding steady since your first assessment.';
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

  return knex('lawn_assessments')
    .where(baseCriteria)
    .orderBy('service_date', 'desc')
    .orderBy('created_at', 'desc')
    .first()
    .catch(() => null);
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
        turfDensity: (Number(assessment.turf_density) || 0) - (Number(initialRow.turf_density) || 0),
        weedSuppression: (Number(assessment.weed_suppression) || 0) - (Number(initialRow.weed_suppression) || 0),
        colorHealth: (Number(assessment.color_health) || 0) - (Number(initialRow.color_health) || 0),
        fungusControl: (Number(assessment.fungus_control) || 0) - (Number(initialRow.fungus_control) || 0),
        thatchLevel: (Number(assessment.thatch_level) || 0) - (Number(initialRow.thatch_level) || 0),
        overall: calculateLawnOverallScore(assessment) - calculateLawnOverallScore(initialRow),
      },
    };
  }

  const turfProfile = await knex('customer_turf_profiles')
    .where({ customer_id: service.customer_id, active: true })
    .first()
    .catch(() => null);
  const trend = historyRows.map((row) => ({
    date: row.service_date,
    overallScore: calculateLawnOverallScore(row),
    turfDensity: lawnScoreValue(row.turf_density),
    weedSuppression: lawnScoreValue(row.weed_suppression),
    colorHealth: lawnScoreValue(row.color_health),
    fungusControl: lawnScoreValue(row.fungus_control),
    thatchScore: lawnScoreValue(row.thatch_level),
    season: row.season || null,
  }));

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
    observations: assessment.observations || '',
    aiSummary: assessment.ai_summary || null,
    fawnSnapshot: parseJsonObject(assessment.fawn_snapshot),
    turfProfile: turfProfile ? {
      grassType: turfProfile.grass_type || null,
      cultivar: turfProfile.cultivar || null,
      sunExposure: turfProfile.sun_exposure || null,
      lawnSqft: turfProfile.lawn_sqft || null,
      irrigationType: turfProfile.irrigation_type || null,
      soilPh: turfProfile.soil_ph || null,
      knownChinchHistory: !!turfProfile.known_chinch_history,
      knownDiseaseHistory: !!turfProfile.known_disease_history,
      knownDroughtStress: !!turfProfile.known_drought_stress,
    } : null,
    customerSummary: lawnAssessmentSummary(currentScore, initialScore, trend.length),
  };
}

async function buildReportV1Data(service, token, knex = db) {
  const serviceLine = service.service_line || detectServiceLine(service.service_type);
  const config = getServiceLineConfig(serviceLine);
  const structured = parseJsonObject(service.structured_notes);
  const serviceData = parseJsonObject(service.service_data);
  const protocol = buildProtocolPayload(service);

  const [products, geometryRow, dbZones, dbFindings, photos] = await Promise.all([
    knex('service_products').where({ service_record_id: service.id }).orderBy('created_at').catch(() => []),
    knex('property_geometries').where({ customer_id: service.customer_id }).orderBy('version', 'desc').first().catch(() => null),
    knex('property_zones').where({ customer_id: service.customer_id, is_active: true }).orderBy('letter').catch(() => []),
    knex('service_findings').where({ service_record_id: service.id }).orderBy('created_at').catch(() => []),
    knex('service_photos').where({ service_record_id: service.id }).orderBy('sort_order').orderBy('created_at').catch(() => []),
  ]);

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

  const pressureIndex = service.pressure_index != null
    ? Number(service.pressure_index)
    : pressureFromFindings(findings);

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

  const onSiteMin = minutesFromElapsed(structured.timeOnSite)
    || (service.started_at && service.ended_at
      ? Math.max(0, Math.round((new Date(service.ended_at) - new Date(service.started_at)) / 60000))
      : null);
  const treatedZoneIds = new Set(applications.flatMap((app) => app.zone_ids || []));
  const recommendations = uniqueStrings([
    ...protocol.recommendations,
    ...findings.map((finding) => finding.recommendation).filter(Boolean),
  ]);
  const photoPayload = await Promise.all(photos.map(async (photo) => ({
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
  const photoChain = photos.some((photo) => photo.hash_sha256)
    ? validatePhotoChainRows(photos)
    : { valid: null, photo_count: photos.length, broken_at: null };
  const advisory = normalizeAdvisoryForTreatmentScope({
    ...config.advisoryDefaults,
    ...parseJsonObject(service.advisory),
    ...(service.irrigation_recommendation ? { irrigation: service.irrigation_recommendation } : {}),
  }, { service, applications });
  const lawnAssessment = await buildLawnAssessmentReportData(service, serviceLine, knex);
  const metrics = buildMetrics(config, {
    onSiteMin,
    treatedZoneIds,
    zones,
    applications,
    findings,
    pressureIndex,
    serviceData,
  }).map((metric) => (
    lawnAssessment && metric.key === 'pressure_index'
      ? {
        ...metric,
        key: 'lawn_health',
        label: 'Lawn health',
        value: lawnAssessment.scores?.overallScore ?? null,
        unit: '%',
        format: 'integer',
      }
      : metric
  ));
  const technicianName = service.technician_name || 'Waves team';
  const technicianPhotoUrl = await resolveTechPhotoUrl(
    service.technician_photo_s3_key,
    service.technician_avatar_url || service.technician_photo_url,
  ).catch(() => service.technician_avatar_url || service.technician_photo_url || null);

  return {
    reportVersion: 'service_report_v1',
    token,
    serviceRecordId: service.id,
    serviceType: service.service_type,
    serviceDisplayName: serviceDisplayName(service),
    serviceLine,
    serviceLineDisplay: config.displayName,
    serviceDate: service.service_date,
    technicianName,
    technician: {
      name: technicianName,
      photoUrl: technicianPhotoUrl,
      initials: initialsForName(technicianName),
    },
    reviewRequestEligible: !service.has_left_google_review,
    hasLeftGoogleReview: !!service.has_left_google_review,
    customerName: `${service.first_name || ''} ${service.last_name || ''}`.trim(),
    cityState: `${service.city || ''}${service.state ? ', ' + service.state : ''}`.trim().replace(/^,\s*/, ''),
    serviceAddress: compactAddress(service),
    visitOutcome: protocol.visitOutcome || 'completed',
    visitTiming: {
      arrivedAt: service.started_at || null,
      exitedAt: service.ended_at || null,
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
    zones: zones.map((zone) => ({
      id: zone.id,
      letter: zone.letter,
      label: zone.label,
      category: zone.category,
      geometry: parseJsonObject(zone.geometry),
      geometryImage: parseJsonObject(zone.geometry_image),
    })),
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
  parseJsonObject,
  parseJsonArray,
  uniqueStrings,
  locationAreaLabels,
  taggedNoteLines,
  minutesFromElapsed,
  methodFromProduct,
  normalizeAdvisoryForTreatmentScope,
  serviceDisplayName,
  treatmentScope,
  buildLawnAssessmentReportData,
  defaultGeometry,
  defaultZones,
  zoneSupportsServiceLine,
};
