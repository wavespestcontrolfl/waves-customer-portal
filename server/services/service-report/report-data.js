const db = require('../../models/db');
const { renderTreatmentMap } = require('./treatment-map');
const { detectServiceLine, getServiceLineConfig } = require('./service-line-configs');
const { pressureFromFindings } = require('./pressure-index');

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

function hasRecordedMeasurement(measurements) {
  return Object.values(measurements || {}).some((value) => value != null && value !== '');
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
  const zones = dbZones.length ? dbZones : defaultZones(areaLabels, serviceLine);
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

  const applications = products.map((product, index) => ({
    id: product.id || `product-${index + 1}`,
    product: {
      name: product.product_name,
      epa_reg: product.epa_reg_number || '',
      active_ingredient: product.active_ingredient || '',
      category: product.product_category || '',
    },
    method: methodFromProduct(product, serviceLine),
    zone_ids: matchZoneIds(product, zones),
    rate: product.application_rate,
    rateUnit: product.rate_unit,
    totalAmount: product.total_amount,
    amountUnit: product.amount_unit,
    appliedAt: product.applied_at || product.created_at,
  }));

  const flagFindings = findings
    .filter((finding) => ['high', 'critical'].includes(finding.severity) && finding.zoneId)
    .map((finding) => ({ zone_id: finding.zoneId, label: finding.title }));

  const mapSvg = renderTreatmentMap({
    geometry: effectiveGeometry,
    zones,
    applications,
    flags: flagFindings,
  });

  const onSiteMin = minutesFromElapsed(structured.timeOnSite)
    || (service.started_at && service.ended_at
      ? Math.max(0, Math.round((new Date(service.ended_at) - new Date(service.started_at)) / 60000))
      : null);
  const treatedZoneIds = new Set(applications.flatMap((app) => app.zone_ids || []));
  const recommendations = uniqueStrings([
    ...protocol.recommendations,
    ...findings.map((finding) => finding.recommendation).filter(Boolean),
  ]);
  const measurements = {
    soilTemp: service.soil_temp,
    thatch: service.thatch_measurement,
    soilPh: service.soil_ph,
    moisture: service.soil_moisture,
  };
  const photoPayload = await Promise.all(photos.map(async (photo) => ({
    id: photo.id,
    url: await photoUrl(photo),
    caption: photo.caption || '',
    stateBadge: photo.state_badge || null,
    zoneId: photo.zone_id || null,
    capturedAt: photo.captured_at || photo.created_at,
    aiTags: parseJsonArray(photo.ai_tags),
  })));
  const advisory = {
    ...config.advisoryDefaults,
    ...parseJsonObject(service.advisory),
    ...(service.irrigation_recommendation ? { irrigation: service.irrigation_recommendation } : {}),
  };

  return {
    reportVersion: 'service_report_v1',
    token,
    serviceRecordId: service.id,
    serviceType: service.service_type,
    serviceLine,
    serviceLineDisplay: config.displayName,
    serviceDate: service.service_date,
    technicianName: service.technician_name || 'Waves team',
    customerName: `${service.first_name || ''} ${service.last_name || ''}`.trim(),
    cityState: `${service.city || ''}${service.state ? ', ' + service.state : ''}`.trim().replace(/^,\s*/, ''),
    visitOutcome: protocol.visitOutcome || 'completed',
    summary: structured.customerRecap || '',
    customerInteraction: service.customer_interaction || structured.customerInteraction || null,
    serviceAreas: areaLabels,
    pressureIndex,
    metrics: [
      { key: 'on_site_min', label: 'On-site', value: onSiteMin, unit: 'min', format: 'integer' },
      { key: 'zones', label: 'Zones', value: `${treatedZoneIds.size}/${zones.length}`, format: 'ratio' },
      { key: 'applications', label: 'Applications', value: applications.length, format: 'integer' },
      { key: 'pressure_index', label: 'Pressure index', value: pressureIndex, format: 'decimal_1' },
    ],
    mapSvg,
    zones: zones.map((zone) => ({ id: zone.id, letter: zone.letter, label: zone.label, category: zone.category })),
    applications,
    conditions: {
      ...parseJsonObject(service.conditions),
      ...parseJsonObject(service.weather_data),
    },
    measurements: hasRecordedMeasurement(measurements) ? measurements : null,
    findings,
    recommendations,
    protocol,
    advisory,
    photos: photoPayload,
    pdfUrl: null,
    legacy: {
      notes: service.technician_notes || '',
      measurements: {
        ...measurements,
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
  hasRecordedMeasurement,
  methodFromProduct,
  defaultGeometry,
  defaultZones,
};
