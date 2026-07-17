const SERVICE_COVERAGE_CONFIG_KEY = 'service_reports.service_coverage';

const DEFAULT_SERVICE_COVERAGE_CONFIG = {
  enabled: true,
  showOnCustomerReports: true,
  defaultTitle: 'Service Coverage',
  titleByServiceLine: {
    pest: 'Service Coverage',
    lawn: 'Lawn Coverage',
    termite: 'Inspection & Treatment Coverage',
    tree_shrub: 'Tree & Shrub Coverage',
    mosquito: 'Mosquito Service Coverage',
    rodent: 'Rodent Service Coverage',
    commercial: 'Service Coverage',
    other: 'Service Coverage',
  },
  introByServiceLine: {
    default: "Here's where your technician completed work, inspected, or marked an area as inaccessible during today's visit.",
    pest: "Here's where your technician completed pest control service, inspected, or marked an area as inaccessible during today's visit.",
    lawn: "Here's where your technician completed lawn service, inspected, or marked an area as inaccessible during today's visit.",
    termite: "Here's where your technician inspected, treated, checked stations, or marked an area as inaccessible during today's visit.",
    tree_shrub: "Here's where your technician inspected, treated, or marked landscape areas that need attention during today's visit.",
    mosquito: "Here's where your technician completed mosquito service, inspected, or marked an area as inaccessible during today's visit.",
    rodent: "Here's where your technician checked rodent service areas, inspected, or marked an area as inaccessible during today's visit.",
    commercial: "Here's where your technician completed work, inspected, or marked an area as inaccessible during today's visit.",
  },
  disclaimerText: 'Service coverage is based on technician-marked locations and available visit data. It is not a property survey.',
  showAddress: true,
  showServiceDate: true,
  showMap: true,
  showList: true,
  showSummaryCounts: true,
  showLegend: true,
  defaultLayout: 'split',
  mobileLayout: 'summary_map_list',
  showInaccessibleReasonsToCustomer: true,
  showTechnicianNotesToCustomer: false,
  showExactMapPins: true,
  allowApproximateMapPins: true,
  mapPrecisionMode: 'exact',
  statusLabels: {
    completed: 'Completed',
    treated: 'Treated',
    inspected: 'Inspected',
    checked: 'Checked',
    inaccessible: 'Inaccessible',
    needs_attention: 'Needs Attention',
    needs_follow_up: 'Follow-Up Recommended',
    skipped: 'Skipped',
    not_serviced: 'Not Serviced',
  },
  statusDisplay: {
    completed: { icon: 'check', colorToken: 'success' },
    treated: { icon: 'check', colorToken: 'success' },
    inspected: { icon: 'search', colorToken: 'info' },
    checked: { icon: 'map-pin', colorToken: 'info' },
    inaccessible: { icon: 'lock', colorToken: 'warning' },
    needs_attention: { icon: 'alert', colorToken: 'attention' },
    needs_follow_up: { icon: 'alert', colorToken: 'attention' },
    skipped: { icon: 'alert', colorToken: 'warning' },
    not_serviced: { icon: 'lock', colorToken: 'neutral' },
  },
  actionCopyTemplates: {
    pest_perimeter_treated: 'Exterior perimeter service completed.',
    pest_entry_points_treated: 'Entry points inspected and treated.',
    lawn_fertilized: 'Lawn treatment completed.',
    lawn_weed_control: 'Weed control applied.',
    termite_station_checked: 'Station checked.',
    termite_bait_replaced: 'Bait replaced and station checked.',
    tree_shrub_treated: 'Plant health treatment completed.',
    inaccessible: 'Technician could not access this area.',
  },
  areaTemplatesByServiceLine: {
    pest: ['Perimeter', 'Entry Points', 'Garage', 'Kitchen', 'Bathrooms', 'Attic', 'Lanai', 'Yard', 'Rodent Stations'],
    lawn: ['Front Lawn', 'Back Lawn', 'Left Side Yard', 'Right Side Yard', 'Landscape Beds', 'Turf', 'Irrigation Zones'],
    termite: ['Exterior Foundation', 'Garage', 'Attic', 'Crawl Space', 'Interior Checkpoints', 'Bait Stations', 'Station Group A', 'Station Group B'],
    tree_shrub: ['Front Landscape Bed', 'Rear Landscape Bed', 'Palms', 'Hedges', 'Ornamentals', 'Tree Group', 'Shrub Group'],
    mosquito: ['Yard Perimeter', 'Shrub Line', 'Standing Water Area', 'Breeding Site', 'Patio/Lanai', 'Dense Vegetation'],
    rodent: ['Exterior Bait Stations', 'Garage', 'Attic', 'Entry Points', 'Traps', 'Exclusion Points'],
  },
};

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

function mergeObject(defaultValue = {}, overrideValue = {}) {
  const merged = { ...defaultValue };
  Object.entries(overrideValue || {}).forEach(([key, value]) => {
    if (
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && defaultValue[key]
      && typeof defaultValue[key] === 'object'
      && !Array.isArray(defaultValue[key])
    ) {
      merged[key] = mergeObject(defaultValue[key], value);
      return;
    }
    merged[key] = value;
  });
  return merged;
}

function mergeServiceCoverageConfig(config = {}) {
  return mergeObject(DEFAULT_SERVICE_COVERAGE_CONFIG, parseJsonObject(config));
}

async function loadServiceCoverageConfig(knex) {
  const row = await knex('system_settings')
    .where({ key: SERVICE_COVERAGE_CONFIG_KEY })
    .first()
    .catch(() => null);
  return mergeServiceCoverageConfig(parseJsonObject(row?.value));
}

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function normalizeServiceCoverageLine(...values) {
  const raw = values.map((value) => normalizeText(value)).filter(Boolean).join(' ');
  if (!raw) return 'other';
  if (raw.includes('tree') || raw.includes('shrub') || raw.includes('palm') || raw.includes('ornamental')) return 'tree_shrub';
  if (raw.includes('termite')) return 'termite';
  if (raw.includes('mosquito')) return 'mosquito';
  if (raw.includes('rodent') || raw.includes('rat') || raw.includes('mouse') || raw.includes('mice')) return 'rodent';
  if (raw.includes('lawn') || raw.includes('turf') || raw.includes('weed') || raw.includes('fertil')) return 'lawn';
  if (raw.includes('commercial')) return 'commercial';
  if (raw.includes('pest') || raw.includes('roach') || raw.includes('ant') || raw.includes('spider')) return 'pest';
  return 'other';
}

function normalizeCoverageStatus(status, actionTypes = []) {
  const raw = normalizeText(status);
  const actions = actionTypes.map(normalizeText).join(' ');
  const combined = `${raw} ${actions}`.trim();
  if (!combined) return 'completed';
  if (/\b(inaccessible|locked|no access|access issue|blocked)\b/.test(combined)) return 'inaccessible';
  if (/\b(needs attention|activity found|issue noted|customer action)\b/.test(combined)) return 'needs_attention';
  if (/\b(follow up|follow-up|return visit)\b/.test(combined)) return 'needs_follow_up';
  if (/\b(skip|skipped|weather)\b/.test(combined)) return 'skipped';
  if (/\b(not serviced|not included)\b/.test(combined)) return 'not_serviced';
  // inspect(?:ed|ion)? — the bare \binspect\b form never matched the plain
  // status "inspected" (word boundary fails before "ed"), so those areas
  // fell through to 'completed' (audit 2026-07-16)
  if (/\b(inspect(?:ed|ion)?|no activity found|entry point found)\b/.test(combined)) return 'inspected';
  if (/\b(station checked|device checked|checked|monitor)\b/.test(combined)) return 'checked';
  if (/\b(treat|treated|spot treated)\b/.test(combined)) return 'treated';
  if (/\b(fertil|weed control|insect treatment|disease treatment|bait replaced|baited|service|serviced|complete|completed|applied|placed)\b/.test(combined)) return 'completed';
  return 'completed';
}

function zoneLookup(zones = []) {
  return new Map((Array.isArray(zones) ? zones : []).map((zone, index) => [
    String(zone.id),
    {
      id: zone.id,
      label: zone.label,
      letter: zone.letter || String.fromCharCode(65 + (index % 26)),
      geometry: parseJsonObject(zone.geometry),
      geometryGeoJson: zone.geometryGeoJson || zone.geometry_geojson,
      geometryImage: parseJsonObject(zone.geometryImage || zone.geometry_image),
    },
  ]));
}

function itemGeometry(location = {}, zone = null) {
  return location.geometry
    || location.geometryGeoJson
    || location.geometry_geojson
    || zone?.geometryGeoJson
    || zone?.geometry
    || null;
}

function itemImageGeometry(location = {}, zone = null) {
  return location.imageGeometry
    || location.image_geometry
    || location.geometryImage
    || location.geometry_image
    || zone?.geometryImage
    || zone?.geometry_image
    || null;
}

function markerFromGeometry(geometry) {
  if (!geometry || geometry.type !== 'Point' || !Array.isArray(geometry.coordinates)) return null;
  const [lng, lat] = geometry.coordinates;
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return null;
  return { lat: Number(lat), lng: Number(lng) };
}

function geometryType(geometry) {
  return String(geometry?.type || '').toLowerCase();
}

function isCustomerVisible(location = {}) {
  if (location.isVisibleToCustomer === false) return false;
  if (location.customerVisible === false) return false;
  if (location.customer_visible === false) return false;
  if (location.internalOnly === true) return false;
  if (location.internal_only === true) return false;
  return true;
}

function areaKey(areaName) {
  const text = normalizeText(areaName);
  if (/\bentry|door|window|threshold|opening|access point\b/.test(text)) return 'entry_points';
  if (/\bperimeter|foundation|exterior\b/.test(text)) return 'perimeter';
  if (/\bstation|bait\b/.test(text)) return 'station';
  if (/\bfront lawn|back lawn|side yard|turf|yard|lawn\b/.test(text)) return 'lawn';
  if (/\bweed\b/.test(text)) return 'weed';
  if (/\bplant|shrub|tree|palm|hedge|landscape\b/.test(text)) return 'plant';
  return 'generic';
}

function customerDescriptionForItem({
  location = {},
  serviceLine,
  areaName,
  normalizedStatus,
  config,
}) {
  const explicit = String(
    location.customerDescription
    || location.customer_description
    || location.descriptionForCustomer
    || location.customerVisibleNote
    || location.customer_visible_note
    || '',
  ).trim();
  if (explicit && !/^(perimeter|entry points?|treated|serviced)$/i.test(explicit)) return explicit;

  const templates = config.actionCopyTemplates || {};
  const key = areaKey(areaName);
  const reason = String(location.inaccessibleReason || location.inaccessible_reason || location.skippedReason || location.skipped_reason || '').trim();

  if (normalizedStatus === 'inaccessible') {
    return reason && config.showInaccessibleReasonsToCustomer !== false
      ? `Technician could not access this area because ${reason}.`
      : templates.inaccessible || 'Technician could not access this area.';
  }
  if (normalizedStatus === 'needs_attention') return 'Technician noted an issue that may need attention.';
  if (normalizedStatus === 'needs_follow_up') return 'Technician flagged this area for follow-up.';
  if (normalizedStatus === 'skipped') return reason ? `Service was skipped because ${reason}.` : 'Service was skipped for this area.';
  if (normalizedStatus === 'not_serviced') return 'This area was not serviced on this visit.';

  if (serviceLine === 'termite') {
    if (normalizeText(location.status).includes('bait')) return templates.termite_bait_replaced || 'Bait replaced and station checked.';
    if (key === 'station' || normalizedStatus === 'checked') return templates.termite_station_checked || 'Station checked.';
    if (normalizedStatus === 'inspected') return 'Inspection completed.';
  }
  // Inspected/checked areas must never fall through to the line-specific
  // "…treatment completed" copy — an inspected zone was looked at, not
  // treated, and the chip beside this text already says "Inspected".
  if (normalizedStatus === 'inspected' || normalizedStatus === 'checked') return `${areaName} inspected.`;

  if (serviceLine === 'pest' || serviceLine === 'rodent' || serviceLine === 'mosquito') {
    if (key === 'perimeter') return templates.pest_perimeter_treated || 'Exterior perimeter service completed.';
    if (key === 'entry_points') return templates.pest_entry_points_treated || 'Entry points inspected and treated.';
  }
  if (serviceLine === 'lawn') {
    const statusText = normalizeText(location.status);
    if (statusText.includes('weed')) return templates.lawn_weed_control || 'Weed control applied.';
    return templates.lawn_fertilized || 'Lawn treatment completed.';
  }
  if (serviceLine === 'tree_shrub') return templates.tree_shrub_treated || 'Plant health treatment completed.';
  if (normalizedStatus === 'treated') return `${areaName} treatment completed.`;
  return `${areaName} service completed.`;
}

function buildCoverageItem({ location = {}, index, zonesById, fallbackArea, report, config }) {
  const zoneId = location.zoneId || location.zone_id || null;
  const zone = zoneId ? zonesById.get(String(zoneId)) : null;
  const serviceLine = normalizeServiceCoverageLine(
    location.serviceLine,
    location.service_line,
    location.serviceType,
    location.service_type,
    report.serviceLine,
    report.serviceType,
    report.serviceDisplayName,
  );
  const actionTypes = [
    ...[].concat(location.actionTypes || location.action_types || []),
    location.actionType,
    location.action_type,
    location.method,
  ].filter(Boolean);
  const normalizedStatus = normalizeCoverageStatus(location.status, actionTypes);
  const areaName = String(location.areaName || location.area_name || location.name || zone?.label || fallbackArea || `Area ${index + 1}`).trim();
  const markerLabel = String(location.markerLabel || location.marker_label || zone?.letter || String.fromCharCode(65 + (index % 26))).trim();
  const geometry = itemGeometry(location, zone);
  const imageGeometry = itemImageGeometry(location, zone);
  const marker = location.marker || markerFromGeometry(geometry);
  const statusLabel = (config.statusLabels || {})[normalizedStatus] || DEFAULT_SERVICE_COVERAGE_CONFIG.statusLabels[normalizedStatus] || 'Completed';

  return {
    id: String(location.id || location.coverageItemId || location.coverage_item_id || `coverage_item_${index + 1}`),
    serviceReportId: String(report.serviceReportId || report.serviceRecordId || report.id || ''),
    serviceLine,
    markerLabel,
    areaName,
    customerDescription: customerDescriptionForItem({
      location,
      serviceLine,
      areaName,
      normalizedStatus,
      config,
    }),
    internalDescription: String(location.internalDescription || location.internal_description || location.description || '').trim(),
    status: normalizedStatus,
    customerStatusLabel: statusLabel,
    statusLabel,
    actionTypes,
    inaccessibleReason: location.inaccessibleReason || location.inaccessible_reason || location.skippedReason || location.skipped_reason || null,
    needsFollowUp: normalizedStatus === 'needs_follow_up' || Boolean(location.needsFollowUp || location.needs_follow_up),
    followUpReason: location.followUpReason || location.follow_up_reason || null,
    technicianNote: location.technicianNote || location.technician_note || null,
    showTechnicianNoteToCustomer: config.showTechnicianNotesToCustomer === true && Boolean(location.showTechnicianNoteToCustomer || location.show_technician_note_to_customer),
    geometryId: location.geometryId || location.geometry_id || zoneId || null,
    zoneId,
    marker,
    geometry,
    imageGeometry,
    polygon: geometryType(geometry).includes('polygon') ? geometry : null,
    line: geometryType(geometry).includes('line') ? geometry : null,
    sortOrder: Number.isFinite(Number(location.sortOrder || location.sort_order)) ? Number(location.sortOrder || location.sort_order) : index,
    isVisibleToCustomer: true,
  };
}

function dedupeItems(items = []) {
  const seen = new Set();
  return items.filter((item) => {
    const key = [
      item.geometryId,
      item.markerLabel,
      normalizeText(item.areaName),
      item.status,
    ].filter(Boolean).join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function summaryFromItems(items = []) {
  return items.reduce((summary, item) => {
    if (item.status === 'inspected' || item.status === 'checked') summary.inspectedCount += 1;
    else if (item.status === 'inaccessible') summary.inaccessibleCount += 1;
    else if (item.status === 'needs_attention' || item.status === 'needs_follow_up') summary.needsAttentionCount += 1;
    // skipped / not-serviced areas are NOT completed work — counting them as
    // "Completed" told the customer a skipped zone was done (audit 2026-07-16)
    else if (item.status === 'skipped' || item.status === 'not_serviced') summary.skippedCount += 1;
    else summary.completedCount += 1;
    return summary;
  }, {
    completedCount: 0,
    inspectedCount: 0,
    inaccessibleCount: 0,
    needsAttentionCount: 0,
    skippedCount: 0,
  });
}

function statusLegend(items = [], config) {
  const order = ['completed', 'treated', 'inspected', 'checked', 'inaccessible', 'needs_attention', 'needs_follow_up', 'skipped', 'not_serviced'];
  const present = new Set(items.map((item) => item.status));
  return order
    .filter((status) => present.has(status))
    .map((status) => ({
      key: status,
      label: config.statusLabels?.[status] || DEFAULT_SERVICE_COVERAGE_CONFIG.statusLabels[status] || status,
    }));
}

function normalizeServiceCoverage(report = {}, configOverride = {}) {
  const config = mergeServiceCoverageConfig(configOverride);
  if (!config.enabled || !config.showOnCustomerReports) {
    return { enabled: false };
  }

  if (report.serviceCoverage && report.serviceCoverage.enabled !== false) {
    return {
      ...report.serviceCoverage,
      title: report.serviceCoverage.title || config.defaultTitle,
      intro: report.serviceCoverage.intro || report.serviceCoverage.introText || config.introByServiceLine.default,
      disclaimer: report.serviceCoverage.disclaimer || config.disclaimerText,
    };
  }

  const serviceLine = normalizeServiceCoverageLine(report.serviceLine, report.serviceType, report.serviceDisplayName);
  const zonesById = zoneLookup(report.zones);
  const locations = (Array.isArray(report.serviceLocations) ? report.serviceLocations : [])
    .filter(isCustomerVisible);
  const locationItems = locations.map((location, index) => buildCoverageItem({
    location,
    index,
    zonesById,
    report,
    config,
  }));
  const fallbackAreas = (Array.isArray(report.serviceAreas) ? report.serviceAreas : [])
    .filter(Boolean)
    .map((area, index) => buildCoverageItem({
      location: {
        id: `coverage_area_${index + 1}`,
        name: area,
        status: 'completed',
      },
      index,
      zonesById,
      fallbackArea: area,
      report,
      config,
    }));
  const items = dedupeItems(locationItems.length ? locationItems : fallbackAreas)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const markerItems = items.filter((item) => item.marker || item.geometry);
  const mapAvailable = config.showMap !== false && markerItems.length > 0 && config.mapPrecisionMode !== 'hidden';
  if (!items.length && !mapAvailable) {
    return {
      enabled: false,
      unavailableText: 'Service coverage details were not recorded for this visit.',
    };
  }

  const title = config.titleByServiceLine?.[serviceLine] || config.defaultTitle || 'Service Coverage';
  const intro = config.introByServiceLine?.[serviceLine] || config.introByServiceLine?.default || DEFAULT_SERVICE_COVERAGE_CONFIG.introByServiceLine.default;
  const groupsByLine = items.reduce((map, item) => {
    const key = item.serviceLine || serviceLine;
    const group = map.get(key) || { serviceLine: key, title: config.titleByServiceLine?.[key] || title, items: [] };
    group.items.push(item);
    map.set(key, group);
    return map;
  }, new Map());

  return {
    enabled: true,
    serviceReportId: String(report.serviceReportId || report.serviceRecordId || report.id || ''),
    serviceLine,
    title,
    intro,
    introText: intro,
    address: config.showAddress === false ? '' : (report.address || report.serviceAddress || report.propertyAddress || ''),
    serviceDate: config.showServiceDate === false ? '' : (report.serviceDate || report.completedAt || ''),
    disclaimer: config.disclaimerText,
    summary: summaryFromItems(items),
    legend: config.showLegend === false ? [] : statusLegend(items, config),
    map: {
      available: mapAvailable,
      center: report.mapCenter || null,
      zoom: report.mapZoom || 18,
      markers: markerItems.map((item) => ({
        id: `marker_${item.id}`,
        coverageItemId: item.id,
        label: item.markerLabel,
        status: item.status,
        statusLabel: item.statusLabel,
        lat: item.marker?.lat ?? null,
        lng: item.marker?.lng ?? null,
        geometry: item.geometry || null,
      })),
      polygons: items.filter((item) => item.polygon).map((item) => ({
        id: `polygon_${item.id}`,
        coverageItemId: item.id,
        label: item.markerLabel,
        status: item.status,
        geometry: item.polygon,
      })),
      lines: items.filter((item) => item.line).map((item) => ({
        id: `line_${item.id}`,
        coverageItemId: item.id,
        label: item.markerLabel,
        status: item.status,
        geometry: item.line,
      })),
    },
    groups: Array.from(groupsByLine.values()),
    items,
    settings: {
      showMap: config.showMap !== false,
      showList: config.showList !== false,
      showSummaryCounts: config.showSummaryCounts !== false,
      defaultLayout: config.defaultLayout || 'split',
      mobileLayout: config.mobileLayout || 'summary_map_list',
      mapPrecisionMode: config.mapPrecisionMode || 'exact',
    },
  };
}

module.exports = {
  SERVICE_COVERAGE_CONFIG_KEY,
  DEFAULT_SERVICE_COVERAGE_CONFIG,
  mergeServiceCoverageConfig,
  loadServiceCoverageConfig,
  normalizeCoverageStatus,
  normalizeServiceCoverageLine,
  normalizeServiceCoverage,
};
