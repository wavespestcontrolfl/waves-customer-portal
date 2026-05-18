import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Cloud,
  CloudRain,
  CloudSun,
  Eye,
  FileCheck2,
  Lock,
  MapPin,
  Printer,
  Route,
  Share2,
  Sun,
  Wind,
  Download,
} from 'lucide-react';
import {
  COLORS as B,
  FONTS,
} from '../theme-brand';
import BrandFooter from '../components/BrandFooter';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const SERVICE_REPORT_TIME_ZONE = 'America/New_York';
const PRESSURE_INDEX_DISPLAY_FLOOR = 0.3;
const DEFAULT_PORTAL_DESCRIPTION = 'Your Waves service reports, billing, and account — view past visits, track action items, and schedule the next service.';
const sentReportEvents = new Set();
const REVIEW_LOCATIONS = [
  {
    key: 'parrish',
    name: 'Parrish',
    areaLabel: 'Parrish, Palmetto, and Ellenton',
    reviewUrl: 'https://g.page/r/Ca-4KKoWwFacEBM/review',
    match: ['parrish', 'palmetto', 'ellenton', '34219', '34221', '34222'],
  },
  {
    key: 'sarasota',
    name: 'Sarasota',
    areaLabel: 'Sarasota and Siesta Key',
    reviewUrl: 'https://g.page/r/CRkzS6M4EpncEBM/review',
    match: ['sarasota', 'siesta', '34231', '34232', '34233', '34236', '34237', '34238', '34239', '34240', '34241'],
  },
  {
    key: 'venice',
    name: 'Venice',
    areaLabel: 'Venice, North Port, and Englewood',
    reviewUrl: 'https://g.page/r/CURA5pQ1KatBEBM/review',
    match: ['venice', 'north port', 'englewood', 'nokomis', '34223', '34224', '34275', '34285', '34286', '34287', '34288', '34289', '34292', '34293'],
  },
  {
    key: 'lakewood-ranch',
    name: 'Lakewood Ranch',
    areaLabel: 'Lakewood Ranch and Bradenton',
    reviewUrl: 'https://g.page/r/CVRc_P5butTMEBM/review',
    match: ['lakewood ranch', 'bradenton', '34202', '34203', '34205', '34208', '34209', '34210', '34211', '34212'],
  },
];
const TREATMENT_OVERLAY_COLORS = ['#0f766e', '#b45309', '#2563eb', '#be123c', '#4d7c0f', '#7c2d12', '#4338ca', '#047857'];

function calendarDateFromDateOnlyValue(value) {
  if (!value) return null;
  const raw = String(value);
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.000)?(?:Z|\+00:00)?)?$/.exec(raw);
  if (!dateOnly) return null;
  return new Date(Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 12));
}

export function formatDate(value) {
  if (!value) return '';
  const raw = String(value);
  const dateOnly = calendarDateFromDateOnlyValue(value);
  const date = dateOnly
    ? dateOnly
    : new Date(raw);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('en-US', {
    timeZone: SERVICE_REPORT_TIME_ZONE,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatMetric(metric) {
  if (metric.value == null || metric.value === '') return '—';
  if (metric.key === 'pressure_index') return formatPressureIndex(metric.value);
  if (metric.format === 'decimal_1') return Number(metric.value).toFixed(1);
  return `${metric.value}${metric.unit ? ` ${metric.unit}` : ''}`;
}

function pressureDisplayNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.max(n, PRESSURE_INDEX_DISPLAY_FLOOR) * 10) / 10;
}

function formatPressureIndex(value) {
  const n = pressureDisplayNumber(value);
  return n == null ? '—' : n.toFixed(1);
}

function metricHelpText(metric) {
  if (metric?.key === 'on_site_min' && (metric.value == null || metric.value === '')) {
    return 'On-site duration unavailable — service may have been completed offline.';
  }
  return undefined;
}

function valueOrDash(value, suffix = '') {
  if (value == null || value === '') return '-';
  return `${value}${suffix}`;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours} hr ${minutes.toString().padStart(2, '0')} min`;
  if (minutes > 0) return `${minutes} min ${seconds.toString().padStart(2, '0')} sec`;
  return `${seconds} sec`;
}

function formatReadyTime(value, timezone = SERVICE_REPORT_TIME_ZONE) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('en-US', {
    timeZone: timezone || SERVICE_REPORT_TIME_ZONE,
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatClockTime(value, timezone = SERVICE_REPORT_TIME_ZONE) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('en-US', {
    timeZone: timezone || SERVICE_REPORT_TIME_ZONE,
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatReportTitleDate(value) {
  if (!value) return '';
  const date = value instanceof Date && !Number.isNaN(value.getTime())
    ? new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), 12))
    : (() => {
      const raw = String(value);
      const dateOnly = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
      if (dateOnly) return new Date(Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 12));
      const parsed = new Date(raw);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    })();
  if (!date) return '';
  return date.toLocaleDateString('en-US', {
    timeZone: SERVICE_REPORT_TIME_ZONE,
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function serviceDisplayName(data = {}) {
  return data.serviceDisplayName || data.serviceType || data.serviceLineDisplay || 'Service';
}

function reportDocumentTitle(data = {}) {
  if (!data || data.error) return 'Waves Customer Portal';
  const serviceName = serviceDisplayName(data);
  const date = formatReportTitleDate(data.serviceDate);
  if (data.reportVersion === 'service_report_v1' || serviceName !== 'Service') {
    return ['Service report', date, serviceName].filter(Boolean).join(' · ');
  }
  return 'Waves Customer Portal';
}

function reportDocumentDescription(data = {}) {
  if (!data || data.error) return DEFAULT_PORTAL_DESCRIPTION;
  const serviceName = serviceDisplayName(data);
  const date = formatReportTitleDate(data.serviceDate);
  if (serviceName === 'Service' && !date) return DEFAULT_PORTAL_DESCRIPTION;
  return date
    ? `Waves service report for ${date}: ${serviceName}. View visit details, action items, and next service.`
    : `Waves service report: ${serviceName}. View visit details, action items, and next service.`;
}

function updateDocumentMeta(selector, attrName, value) {
  if (typeof document === 'undefined' || !value) return;
  let element = document.head.querySelector(selector);
  if (!element) {
    element = document.createElement('meta');
    if (selector.includes('property=')) {
      const property = selector.match(/property="([^"]+)"/)?.[1];
      if (property) element.setAttribute('property', property);
    } else {
      const name = selector.match(/name="([^"]+)"/)?.[1];
      if (name) element.setAttribute('name', name);
    }
    document.head.appendChild(element);
  }
  element.setAttribute(attrName, value);
}

function applyReportDocumentMetadata(data = {}) {
  if (typeof document === 'undefined') return;
  const title = reportDocumentTitle(data);
  const description = reportDocumentDescription(data);
  document.title = title;
  updateDocumentMeta('meta[name="description"]', 'content', description);
  updateDocumentMeta('meta[property="og:title"]', 'content', title);
  updateDocumentMeta('meta[property="og:description"]', 'content', description);
  updateDocumentMeta('meta[name="twitter:title"]', 'content', title);
  updateDocumentMeta('meta[name="twitter:description"]', 'content', description);
}

function visitTimeRange(data = {}) {
  const arrived = formatClockTime(data.visitTiming?.arrivedAt);
  const exited = formatClockTime(data.visitTiming?.exitedAt);
  if (arrived && exited) return `Arrived ${arrived} | Finished ${exited}`;
  if (arrived) return `Arrived ${arrived}`;
  if (exited) return `Finished ${exited}`;
  return '';
}

export function cleanVisitSummary(value) {
  let text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  text = text.replace(/^Thanks for having us out today\.\s*/i, 'Your routine service is complete. ');
  text = text.replace(/\band also knocked\b/i, 'and knocked');
  text = text.replace(/\s*,?\s*and\s*-\s*Waves\.?$/i, '.');
  text = text.replace(/\s+-\s*Waves\.?$/i, '.');
  text = text.replace(/You should see activity ease over the next 1-2 weeks\.?/i, 'You may see activity ease over the next 1-2 weeks.');
  text = text.replace(/\s+\./g, '.').replace(/\.{2,}/g, '.');
  return text;
}

function visitSummaryCopy(data = {}) {
  return cleanVisitSummary(data.summary) || 'Your routine service is complete.';
}

function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function advisoryDisplayRows(advisory = {}) {
  return [
    positiveNumber(advisory.exterior_reentry_min) != null
      ? ['Exterior re-entry', `${Math.round(positiveNumber(advisory.exterior_reentry_min))} min`]
      : null,
    positiveNumber(advisory.interior_reentry_min) != null
      ? ['Interior re-entry', `${Math.round(positiveNumber(advisory.interior_reentry_min))} min`]
      : null,
    positiveNumber(advisory.irrigation_hold_hr) != null
      ? ['Irrigation hold', `${Math.round(positiveNumber(advisory.irrigation_hold_hr))} hr`]
      : null,
  ].filter(Boolean);
}

function trackReportEvent(token, eventName, metadata = {}) {
  if (!token || !eventName) return;
  const key = `${token}:${eventName}:${JSON.stringify(metadata)}`;
  if (sentReportEvents.has(key)) return;
  sentReportEvents.add(key);
  fetch(`${API_BASE}/reports/${token}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventName, channel: 'public_report', metadata }),
    keepalive: true,
  }).catch(() => {});
}

function dynamicHeroSummary(data) {
  if (data?.serviceLine === 'lawn' && data?.lawnAssessment?.customerSummary) {
    return `Lawn assessment is complete. ${data.lawnAssessment.customerSummary}`;
  }
  const context = data?.dynamicContext || {};
  if (!context.reentry && !context.pressureTrend) return null;
  const findings = Array.isArray(data?.findings) ? data.findings : [];
  if (findings.some((finding) => ['critical', 'high'].includes(String(finding.severity || '').toLowerCase()))) {
    return 'Service is complete. One recommendation needs your attention to help reduce recurring activity.';
  }
  const pendingTarget = (context.reentry?.targets || []).find((target) => (
    Number.isFinite(Date.parse(target.readyAt)) && Date.parse(target.readyAt) > Date.now()
  ));
  if (pendingTarget) {
    return `Service is complete. ${pendingTarget.label} areas are ready at ${formatReadyTime(pendingTarget.readyAt, context.reentry.displayTimezone)}.`;
  }
  if (context.pressureTrend?.direction === 'down') {
    return `Service is complete. ${context.pressureTrend.customerSummary}`;
  }
  if (context.pressureTrend?.direction === 'up') {
    return 'Service is complete. Pest pressure increased this visit, and we treated the active zones.';
  }
  return 'Your routine service is complete.';
}

function conditionRows(conditions = {}) {
  const rows = [
    ['Air temp', conditions.temp_f ?? conditions.temp, '°F'],
    ['Humidity', conditions.humidity_pct ?? conditions.humidity, '%'],
    ['Wind', conditions.wind_mph ?? conditions.wind, conditions.wind_mph != null && conditions.wind_mph !== '' ? ' mph' : ''],
    ['Rain last 24 hr', conditions.rain_24h_in, ' in'],
    ['Sky', conditions.sky ?? conditions.cloudCover, ''],
    ['Source', conditions.source, ''],
  ];
  return rows.map(([label, value, suffix]) => [
    label,
    value == null || value === '' ? 'Not recorded' : `${value}${suffix}`,
  ]);
}

function formatEnumLabel(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const special = {
    ghost_ant: 'ghost ants',
    american_roach: 'American roaches',
    german_roach: 'German roaches',
    fire_ant: 'fire ants',
    spider: 'spiders',
    perimeter_spray: 'Perimeter spray',
    bait_placement: 'Bait placement',
    spot_treatment: 'Spot treatment',
    pin_stream: 'Pin stream',
    broadcast_spray: 'Broadcast spray',
    granular_broadcast: 'Granular broadcast',
    fog_ulv: 'ULV fog',
    st_augustine: 'St. Augustine',
    in_ground: 'In-ground',
    front_yard: 'Front yard',
    back_yard: 'Back yard',
    side_yard: 'Side yard',
    trouble_spot: 'Trouble spot',
  };
  const key = raw.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (special[key]) return special[key];
  return key.split('_').filter(Boolean).map((word, index) => (
    index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word
  )).join(' ');
}

function applicationPurpose(app = {}, serviceLine = 'pest') {
  const method = String(app.method || '').toLowerCase();
  const product = String(app.product?.name || '').toLowerCase();
  const category = String(app.product?.category || '').toLowerCase();
  if (serviceLine === 'lawn') {
    if (method.includes('spot') || category.includes('herb') || product.includes('weed')) return 'Targeted weed treatment';
    if (category.includes('fung') || product.includes('fung')) return 'Fungus control application';
    if (method.includes('granular') || category.includes('fert') || product.includes('fert')) return 'Lawn nutrient application';
    return 'Lawn treatment application';
  }
  if (serviceLine === 'mosquito') return 'Mosquito pressure reduction';
  if (serviceLine === 'termite' || serviceLine === 'rodent') {
    if (method.includes('station')) return 'Station service';
    if (method.includes('bait')) return 'Bait placement';
  }
  if (method.includes('bait') || product.includes('bait') || product.includes('gel')) return 'Targeted ant bait';
  if (method.includes('perimeter') || method.includes('broadcast')) return 'Perimeter protection';
  if (method.includes('spot') || method.includes('pin')) return 'Targeted treatment';
  if (method.includes('fog')) return 'Mosquito pressure reduction';
  return 'Treatment application';
}

function applicationPurposeCopy(app = {}, serviceLine = 'pest') {
  const purpose = applicationPurpose(app, serviceLine);
  if (purpose === 'Targeted weed treatment') return 'Applied where visible weed pressure or service notes called for targeted control.';
  if (purpose === 'Fungus control application') return 'Applied to support turf health where fungus pressure or seasonal conditions called for protection.';
  if (purpose === 'Lawn nutrient application') return 'Used to support turf density, color, and recovery within the documented lawn program.';
  if (purpose === 'Lawn treatment application') return 'Recorded as part of today’s lawn care visit and treatment plan.';
  if (purpose === 'Station service') return 'Checked or serviced at the documented station locations.';
  if (purpose === 'Bait placement') return 'Placed at documented activity or monitoring points.';
  if (purpose === 'Perimeter protection') return 'Used along treated exterior zones to maintain the protective band.';
  if (purpose === 'Targeted ant bait') return 'Placed for light ant activity at the documented active zone.';
  if (purpose === 'Targeted treatment') return 'Applied only where activity or conditions called for treatment.';
  if (purpose === 'Mosquito pressure reduction') return 'Applied to reduce resting adult mosquito pressure around target areas.';
  return 'Application recorded for this visit.';
}

function productIdentifierDetails(app = {}) {
  const details = [];
  const epa = String(app.product?.epa_reg || '').trim();
  const active = String(app.product?.active_ingredient || '').trim();
  if (epa) details.push(`EPA registration number recorded: ${epa}.`);
  if (active) details.push(`Active ingredient recorded: ${active}.`);
  return details;
}

function applicationTechnicalExplanation(app = {}, serviceLine = 'pest') {
  const method = String(app.method || '').toLowerCase();
  const productName = String(app.product?.name || 'This product');
  const active = String(app.product?.active_ingredient || '').trim();
  const product = productName.toLowerCase();
  const details = [];

  if (serviceLine === 'lawn') {
    details.push(`${productName} was documented as part of today’s lawn treatment plan. The treatment is interpreted against turf density, weed pressure, fungus signal, color health, thatch, irrigation context, and recent lawn history so the next visit can track response instead of treating each visit as isolated.`);
    details.push(...productIdentifierDetails(app));
    return details;
  }

  if (method.includes('bait') || product.includes('bait') || product.includes('gel')) {
    details.push(`${productName} is a targeted bait placement. Foraging ants feed on the bait and can carry it back to other ants, which helps reduce activity at the source instead of only addressing the visible trail.`);
    details.push('Bait depends on foraging behavior, so light activity near the placement for a short period can be normal while ants locate and share the bait.');
    details.push(...productIdentifierDetails(app));
    return details;
  }

  if (method.includes('perimeter') || method.includes('broadcast')) {
    details.push(`${productName} was used as a residual exterior perimeter application. Target pests contact treated surfaces as they move through edges, thresholds, utility penetrations, protected corners, and other entry-prone paths.`);
    details.push('The goal is to reduce entry pressure by maintaining a label-directed treatment band outside the structure. This is designed for residual control over time, not as a guarantee that every insect stops immediately at the edge of the treated zone.');
    if (/demand|cs|lambda/i.test(`${productName} ${active}`)) {
      details.push('Demand CS is a capsule-suspension formulation; the active ingredient is held in small capsules that remain on treated surfaces and release as pests contact the application zone.');
    }
    details.push(...productIdentifierDetails(app));
    return details;
  }

  if (method.includes('spot') || method.includes('pin')) {
    details.push(`${productName} was used as a targeted application at documented activity points. This limits treatment to the areas where activity, access, or conducive conditions were observed.`);
    details.push(...productIdentifierDetails(app));
    return details;
  }

  if (serviceLine === 'mosquito' || method.includes('fog')) {
    details.push(`${productName} was documented for mosquito pressure reduction around target resting areas. Mosquito applications are interpreted with weather, shade, moisture, foliage, and recurring pressure because outdoor pressure can rebuild from nearby breeding or resting sites.`);
    details.push(...productIdentifierDetails(app));
    return details;
  }

  details.push(`${productName} was documented for this service visit. The application is interpreted with the treated zones, target pests, technician findings, site conditions, and recent service history.`);
  details.push(...productIdentifierDetails(app));
  return details;
}

function applicationZoneIds(app = {}) {
  const ids = Array.isArray(app.zone_ids)
    ? app.zone_ids
    : (Array.isArray(app.zoneIds) ? app.zoneIds : []);
  return ids.map((id) => String(id)).filter(Boolean);
}

function applicationProductName(app = {}) {
  return app.product?.name || app.productName || 'Product application';
}

function applicationEpaReg(app = {}) {
  return app.product?.epa_reg || app.epaReg || '';
}

function applicationActiveIngredient(app = {}) {
  return app.product?.active_ingredient || app.activeIngredient || '';
}

function isRenderableTreatmentApplication(app = {}) {
  return String(app.method || '').toLowerCase() !== 'station_check';
}

function buildTreatmentOverlayRows(data = {}) {
  const applications = Array.isArray(data.applications) ? data.applications : [];
  const zoneById = new Map((data.zones || []).map((zone) => [String(zone.id), zone]));
  return applications.map((app, originalIndex) => {
    const id = String(app.id || `application-${originalIndex + 1}`);
    const zoneIds = applicationZoneIds(app);
    const zones = zoneIds.map((zoneId) => zoneById.get(String(zoneId))).filter(Boolean);
    return { app, id, zoneIds, zones };
  }).filter(({ app, zones }) => isRenderableTreatmentApplication(app) && zones.length).map(({ app, id, zoneIds, zones }, index) => {
    const zoneLetters = zones.map((zone) => zone.letter).filter(Boolean);
    const zoneLabels = zones.map((zone) => zone.label).filter(Boolean);
    const targets = Array.isArray(app.targets) ? app.targets.map(formatEnumLabel).filter(Boolean) : [];
    const technicalDetails = applicationTechnicalExplanation(app, data.serviceLine);
    const customerDetail = technicalDetails.find((detail) => (
      !/^EPA registration number recorded:/i.test(detail)
      && !/^Active ingredient recorded:/i.test(detail)
    )) || applicationPurposeCopy(app, data.serviceLine);
    const rateDetails = [
      app.rate && app.rateUnit ? `Rate ${app.rate} ${app.rateUnit}` : null,
      app.totalAmount && app.amountUnit ? `Total ${app.totalAmount} ${app.amountUnit}` : null,
    ].filter(Boolean);

    return {
      id,
      mapNumber: String(index + 1),
      color: TREATMENT_OVERLAY_COLORS[index % TREATMENT_OVERLAY_COLORS.length],
      productName: applicationProductName(app),
      purpose: applicationPurpose(app, data.serviceLine),
      methodLabel: app.methodLabel || formatEnumLabel(app.method) || 'Application',
      zoneIds,
      zones,
      zoneText: zoneLetters.length
        ? `Zones ${zoneLetters.join(', ')}${zoneLabels.length ? `: ${zoneLabels.join(', ')}` : ''}`
        : (app.applicationArea || 'Treated area recorded'),
      targetText: targets.length ? targets.join(', ') : '',
      epaReg: applicationEpaReg(app),
      activeIngredient: applicationActiveIngredient(app),
      rateDetails,
      customerDetail,
    };
  });
}

function applicationZoneText(app = {}, zoneById = new Map()) {
  const zones = applicationZoneIds(app).map((id) => zoneById.get(String(id))).filter(Boolean);
  const letters = zones.map((zone) => zone.letter).filter(Boolean);
  const labels = zones.map((zone) => zone.label).filter(Boolean);
  if (letters.length) return `Zones ${letters.join(', ')}`;
  if (labels.length) return labels.join(', ');
  return app.applicationArea || 'Treated zones recorded';
}

function applicationGroupPurposeCopy(purpose, serviceLine = 'pest') {
  if (purpose === 'Perimeter protection') {
    return 'These products were used along treated exterior zones to help maintain the protective band.';
  }
  if (purpose === 'Lawn nutrient application') {
    return 'These products were applied as part of the lawn program to support turf density, color, and recovery.';
  }
  if (purpose === 'Targeted weed treatment') {
    return 'These products were applied where visible weed pressure or service notes called for targeted control.';
  }
  if (purpose === 'Fungus control application') {
    return 'These products were applied to support turf health where fungus pressure or seasonal conditions called for protection.';
  }
  if (purpose === 'Mosquito pressure reduction') {
    return 'These products were applied to reduce mosquito pressure around target resting areas.';
  }
  return applicationPurposeCopy({ method: '', product: {} }, serviceLine).replace(/^Application recorded.*$/i, 'These products were documented for this service visit.');
}

function groupApplicationsByPurpose(applications = [], data = {}) {
  const zoneById = new Map((data.zones || []).map((zone) => [String(zone.id), zone]));
  const groups = new Map();
  for (const app of applications) {
    const purpose = applicationPurpose(app, data.serviceLine);
    const method = app.methodLabel || formatEnumLabel(app.method) || 'Application';
    const zones = applicationZoneText(app, zoneById);
    const key = [purpose, method, zones].join('|');
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        purpose,
        method,
        zones,
        copy: applicationGroupPurposeCopy(purpose, data.serviceLine),
        products: [],
      });
    }
    groups.get(key).products.push(app);
  }
  return Array.from(groups.values());
}

function conditionInterpretation(conditions = {}) {
  const wind = Number(conditions.wind_mph ?? conditions.wind);
  const rain = Number(conditions.rain_24h_in);
  const hasWind = Number.isFinite(wind);
  const hasRain = Number.isFinite(rain);
  if (!hasWind && !hasRain) {
    return 'Weather was marked suitable for treatment.';
  }
  if (Number.isFinite(wind) && wind > 10) {
    return 'Wind was elevated, so treatment was adjusted to match label and site conditions.';
  }
  if (Number.isFinite(rain) && rain > 0.25) {
    return 'Recent rainfall was noted. Treatment decisions were adjusted for site conditions.';
  }
  if (hasRain && hasWind && rain <= 0.1 && wind <= 10) {
    return 'Weather was suitable for treatment. Low rainfall and moderate wind supported exterior application.';
  }
  if ((!hasRain || rain <= 0.1) && (!hasWind || wind <= 10)) {
    return 'Weather was marked suitable for treatment.';
  }
  return 'Conditions were documented at application time for this service record.';
}

function lawnScoreLabel(score) {
  const value = Number(score);
  if (!Number.isFinite(value)) return 'Tracking';
  if (value >= 85) return 'Strong';
  if (value >= 70) return 'Improving';
  if (value >= 55) return 'Watch';
  return 'Needs attention';
}

function lawnMetricRows(assessment = {}) {
  const scores = assessment.scores || {};
  return [
    ['Turf density', scores.turfDensity],
    ['Weed suppression', scores.weedSuppression],
    ['Color health', scores.colorHealth],
    ['Fungus control', scores.fungusControl],
    ['Thatch level', scores.thatchScore],
  ];
}

function lawnAssessmentBody(assessment = {}) {
  const observations = String(assessment.observations || assessment.scores?.observations || '').trim();
  if (observations) return observations;
  const profile = assessment.turfProfile;
  if (profile?.grassType) {
    return `Assessment captured for ${formatEnumLabel(profile.grassType).toLowerCase()} turf. Scores reflect visible turf density, weed pressure, color, fungus signal, and thatch conditions.`;
  }
  return 'Assessment scores reflect visible turf density, weed suppression, color health, fungus control, and thatch conditions documented during this lawn visit.';
}

function weatherIconInfo(conditions = {}, weatherCall) {
  const wind = Number(conditions.wind_mph ?? conditions.wind);
  const rain = Number(conditions.rain_24h_in);
  const sky = String(conditions.sky || conditions.condition || '').toLowerCase();
  const headline = String(weatherCall?.headline || '').toLowerCase();
  const signal = `${sky} ${headline}`.toLowerCase();

  if ((Number.isFinite(wind) && wind > 10) || /\bwind\b/.test(headline)) return { Icon: Wind, label: 'Wind noted' };
  if ((Number.isFinite(rain) && rain > 0.1) || /\brain|storm|shower|drizzle\b/.test(signal)) {
    return { Icon: CloudRain, label: 'Rain noted' };
  }
  if (/\bclear|sun|sunny\b/.test(signal)) return { Icon: Sun, label: 'Sunny conditions' };
  if (/\bpartly|mostly sunny|few clouds\b/.test(signal)) return { Icon: CloudSun, label: 'Partly cloudy' };
  if (/\bcloud|overcast\b/.test(signal)) return { Icon: Cloud, label: 'Cloud cover' };
  return { Icon: CloudSun, label: 'Treatment weather' };
}

function recommendedFinding(findings = []) {
  const ranked = [...findings].sort((a, b) => {
    const rank = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
    return (rank[String(b.severity || '').toLowerCase()] || 0) - (rank[String(a.severity || '').toLowerCase()] || 0);
  });
  return ranked.find((finding) => String(finding.recommendation || '').trim()) || null;
}

function actionButtonStyle(kind = 'plain') {
  const isPrimary = kind === 'primary';
  return {
    minHeight: 38,
    padding: '9px 12px',
    borderRadius: 8,
    border: `1px solid ${isPrimary ? B.blueDeeper : '#CBD5E1'}`,
    background: isPrimary ? B.blueDeeper : '#FFFFFF',
    color: isPrimary ? '#FFFFFF' : B.blueDeeper,
    fontFamily: FONTS.heading,
    fontWeight: 850,
    fontSize: 14,
    lineHeight: 1,
    cursor: 'pointer',
    textDecoration: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    boxShadow: 'none',
    textTransform: 'none',
    whiteSpace: 'nowrap',
  };
}

function reviewLocationForReport(data = {}) {
  const haystack = [
    data.serviceAddress,
    data.cityState,
    data.property?.city,
    data.property?.postal_code,
    data.property?.zip,
  ].filter(Boolean).join(' ').toLowerCase();
  return REVIEW_LOCATIONS.find((location) => location.match.some((term) => haystack.includes(term))) || REVIEW_LOCATIONS[3];
}

function ReentryTargetTile({ target, nowMs, mode, timezone }) {
  const readyAtMs = Date.parse(target.readyAt);
  const hasReadyAt = Number.isFinite(readyAtMs);
  const ready = hasReadyAt && readyAtMs <= nowMs;
  return (
    <div className="reentry-target-tile">
      <div className="sr-cell-label">{target.label}</div>
      <div className="reentry-target-value">
        {!hasReadyAt
          ? 'Ready time pending'
          : mode === 'live'
          ? (ready ? 'Ready now' : `Ready in ${formatDuration(readyAtMs - nowMs)}`)
          : `Ready after ${formatReadyTime(target.readyAt, timezone)}`}
      </div>
    </div>
  );
}

function ReentryTimer({ context, mode, token, compact = false }) {
  const generatedAtMs = Date.parse(context.generatedAt) || Date.now();
  const [nowMs, setNowMs] = useState(generatedAtMs);
  const timezone = context.displayTimezone || SERVICE_REPORT_TIME_ZONE;
  const allReady = (context.targets || []).every((target) => Date.parse(target.readyAt) <= nowMs);
  const rootClass = compact ? 'hero-reentry-status reentry-timer' : 'report-card reentry-timer';

  useEffect(() => {
    if (mode !== 'live') return undefined;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [mode]);

  useEffect(() => {
    if (mode !== 'live') return;
    trackReportEvent(token, 'reentry_timer_viewed');
  }, [mode, token]);

  useEffect(() => {
    if (mode !== 'live' || !allReady) return;
    trackReportEvent(token, 'reentry_timer_completed');
  }, [allReady, mode, token]);

  return (
    <section className={rootClass} data-section="reentry-timer">
      <div className="reentry-heading">
        <div className="section-eyebrow">Ready to re-enter</div>
        <h2>{allReady ? 'Treated areas are ready' : 'Re-entry timing'}</h2>
      </div>
      <div className="reentry-details">
        <div className="reentry-target-grid">
          {(context.targets || []).map((target) => (
            <ReentryTargetTile
              key={target.key}
              target={target}
              nowMs={nowMs}
              mode={mode}
              timezone={timezone}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function PressureTrendChart({ points = [], neighborhood, summary }) {
  const width = 320;
  const height = 120;
  const padding = { top: 12, right: 16, bottom: 24, left: 28 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const xFor = (index, count = points.length) => {
    if (count <= 1) return padding.left + chartWidth / 2;
    return padding.left + (index * chartWidth) / (count - 1);
  };
  const yFor = (pressureIndex) => {
    const n = Number(pressureIndex);
    const clamped = Number.isFinite(n) ? Math.max(0, Math.min(5, n)) : 0;
    return padding.top + ((5 - clamped) * chartHeight) / 5;
  };
  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${xFor(index)} ${yFor(point.pressureIndex)}`).join(' ');
  const neighborhoodPoints = neighborhood?.sampleSize >= 20 ? (neighborhood.points || []) : [];
  const neighborhoodPath = neighborhoodPoints
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${xFor(index, neighborhoodPoints.length)} ${yFor(point.avgPressureIndex)}`)
    .join(' ');

  return (
    <svg
      className="pressure-trend-chart"
      role="img"
      aria-label={summary || 'Pest pressure trend over recent visits'}
      viewBox={`0 0 ${width} ${height}`}
    >
      {[0, 2.5, 5].map((value) => (
        <g key={value}>
          <line x1={padding.left} x2={width - padding.right} y1={yFor(value)} y2={yFor(value)} className="chart-gridline" />
          <text x={padding.left - 8} y={yFor(value)} textAnchor="end" dominantBaseline="middle" className="chart-label">{value}</text>
        </g>
      ))}
      <line x1={padding.left} y1={padding.top} x2={padding.left} y2={height - padding.bottom} className="chart-axis" />
      <line x1={padding.left} y1={yFor(0)} x2={width - padding.right} y2={yFor(0)} className="chart-axis" />
      {neighborhoodPath && <path d={neighborhoodPath} className="neighborhood-pressure-line" fill="none" />}
      {points.length > 1 && <path d={path} className="pressure-line" fill="none" />}
      {points.map((point, index) => (
        <g
          key={point.serviceRecordId}
          className="pressure-point-hit"
          tabIndex={0}
          role="img"
          aria-label={`${point.label}: ${formatPressureIndex(point.pressureIndex)} pressure index`}
        >
          <title>{`${point.label}: ${formatPressureIndex(point.pressureIndex)} pressure index${point.mainDriver ? ` · ${point.mainDriver}` : ''}`}</title>
          <circle cx={xFor(index)} cy={yFor(point.pressureIndex)} r="10" className="pressure-point-target" />
          <circle cx={xFor(index)} cy={yFor(point.pressureIndex)} r={index === points.length - 1 ? 4 : 3} className="pressure-point" />
          <text x={xFor(index)} y={Math.max(12, yFor(point.pressureIndex) - 10)} textAnchor="middle" className="pressure-value-label">{formatPressureIndex(point.pressureIndex)}</text>
          <text x={xFor(index)} y={height - 6} textAnchor="middle" className="chart-label">{point.label}</text>
        </g>
      ))}
    </svg>
  );
}

function PressureTrendCard({ context, neighborhood, mode, token, embedded = false }) {
  useEffect(() => {
    if (mode !== 'live') return;
    trackReportEvent(token, 'pressure_trend_viewed');
  }, [mode, token]);

  const current = context.current;
  const pressureHeadline = (() => {
    if (context.direction === 'first_visit') return 'Your first pressure marker';
    if (context.direction === 'down') return 'Pressure is moving your way';
    if (context.direction === 'up') return 'Pressure needs a closer watch';
    if (context.direction === 'flat') return 'Pressure is holding steady';
    return 'Pressure snapshot';
  })();
  const Root = embedded ? 'div' : 'section';
  return (
    <Root className={`${embedded ? 'pressure-trend-card pressure-trend-card-embedded' : 'report-card pressure-trend-card'}`} data-section="pressure-trend">
      <div className="pressure-trend-layout">
        <div>
          {!embedded && <h2>{pressureHeadline}</h2>}
          <p className="pressure-summary">{context.customerSummary}</p>
          {current?.mainDriver && <p className="sr-muted">Main driver this visit: {current.mainDriver}</p>}
        </div>
        <PressureTrendChart points={context.points || []} neighborhood={neighborhood} summary={context.customerSummary} />
      </div>
      {neighborhood?.sampleSize >= 20 && (
        <div className="pressure-legend">
          <span>Your home</span>
          <span>Nearby WaveGuard average</span>
        </div>
      )}
    </Root>
  );
}

function LawnTrendChart({ trend = [], summary }) {
  const width = 320;
  const height = 120;
  const padding = { top: 12, right: 16, bottom: 24, left: 30 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const points = trend.filter((point) => point.overallScore != null);
  const xFor = (index) => {
    if (points.length <= 1) return padding.left + chartWidth / 2;
    return padding.left + (index * chartWidth) / (points.length - 1);
  };
  const yFor = (score) => {
    const clamped = Math.max(0, Math.min(100, Number(score) || 0));
    return padding.top + ((100 - clamped) * chartHeight) / 100;
  };
  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${xFor(index)} ${yFor(point.overallScore)}`).join(' ');

  return (
    <svg
      className="lawn-trend-chart"
      role="img"
      aria-label={summary || 'Lawn health trend over recent assessments'}
      viewBox={`0 0 ${width} ${height}`}
    >
      {[0, 50, 100].map((value) => (
        <g key={value}>
          <line x1={padding.left} x2={width - padding.right} y1={yFor(value)} y2={yFor(value)} className="chart-gridline" />
          <text x={padding.left - 8} y={yFor(value)} textAnchor="end" dominantBaseline="middle" className="chart-label">{value}</text>
        </g>
      ))}
      <line x1={padding.left} y1={padding.top} x2={padding.left} y2={height - padding.bottom} className="chart-axis" />
      <line x1={padding.left} y1={yFor(0)} x2={width - padding.right} y2={yFor(0)} className="chart-axis" />
      {points.length > 1 && <path d={path} className="lawn-health-line" fill="none" />}
      {points.map((point, index) => {
        const label = point.date ? formatDate(point.date).replace(/, \d{4}$/, '') : `Visit ${index + 1}`;
        return (
          <g
            key={`${point.date || index}-${point.overallScore}`}
            className="pressure-point-hit"
            tabIndex={0}
            role="img"
            aria-label={`${label}: ${point.overallScore}% lawn health`}
          >
            <title>{`${label}: ${point.overallScore}% lawn health`}</title>
            <circle cx={xFor(index)} cy={yFor(point.overallScore)} r="10" className="pressure-point-target" />
            <circle cx={xFor(index)} cy={yFor(point.overallScore)} r={index === points.length - 1 ? 4 : 3} className="lawn-health-point" />
            <text x={xFor(index)} y={height - 6} textAnchor="middle" className="chart-label">
              {point.date ? new Date(`${point.date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : `V${index + 1}`}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function LawnAssessmentCard({ assessment, mode, token, embedded = false }) {
  useEffect(() => {
    if (mode !== 'live' || !assessment) return;
    trackReportEvent(token, 'lawn_assessment_viewed');
  }, [assessment, mode, token]);

  if (!assessment?.scores) return null;
  const score = assessment.scores.overallScore;
  const Root = embedded ? 'div' : 'section';
  const profile = assessment.turfProfile;
  const metricRows = lawnMetricRows(assessment);
  const visiblePhotos = (assessment.photos || []).filter((photo) => photo.url).slice(0, 3);

  return (
    <Root className={`${embedded ? 'lawn-assessment-card lawn-assessment-card-embedded' : 'report-card lawn-assessment-card'}`} data-section="lawn-assessment">
      <div className="section-eyebrow">Lawn intelligence</div>
      <div className="lawn-assessment-layout">
        <div>
          <h2>{assessment.customerSummary || 'Lawn health assessment is ready.'}</h2>
          <div className="lawn-overall-score">
            <span>{score != null ? `${score}%` : '-'}</span>
            <div>
              <strong>{lawnScoreLabel(score)}</strong>
              <em>Overall lawn health</em>
            </div>
          </div>
          <p className="pressure-summary">{lawnAssessmentBody(assessment)}</p>
          {profile && (
            <div className="lawn-profile-line">
              {[
                profile.grassType ? formatEnumLabel(profile.grassType) : null,
                profile.lawnSqft ? `${Number(profile.lawnSqft).toLocaleString()} sq ft turf` : null,
                profile.irrigationType ? `${formatEnumLabel(profile.irrigationType)} irrigation` : null,
              ].filter(Boolean).join(' · ')}
            </div>
          )}
        </div>
        <LawnTrendChart trend={assessment.trend || []} summary={assessment.customerSummary} />
      </div>
      <div className="lawn-score-grid">
        {metricRows.map(([label, value]) => (
          <div className="lawn-score-cell" key={label}>
            <div className="sr-cell-label">{label}</div>
            <div className="lawn-score-value">{value != null ? `${value}%` : '-'}</div>
          </div>
        ))}
      </div>
      {visiblePhotos.length > 0 && (
        <div className="lawn-photo-strip">
          {visiblePhotos.map((photo) => (
            <figure key={photo.id}>
              <img src={photo.url} alt={photo.type ? `Lawn ${formatEnumLabel(photo.type).toLowerCase()}` : 'Lawn assessment photo'} />
              <figcaption>{photo.isBest ? 'Best view' : formatEnumLabel(photo.type || 'Turf photo')}</figcaption>
            </figure>
          ))}
        </div>
      )}
      {assessment.beforeAfter?.improvement?.overall != null && (
        <div className="lawn-before-after-line">
          Since first assessment: {assessment.beforeAfter.improvement.overall > 0 ? '+' : ''}{assessment.beforeAfter.improvement.overall} overall points.
        </div>
      )}
    </Root>
  );
}

function TechnicianVisitLine({ data }) {
  const technician = data.technician || {};
  const name = technician.name || data.technicianName || 'Your Waves technician';
  const initials = technician.initials || name.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'W';
  const timing = visitTimeRange(data);

  return (
    <div className="tech-visit-line">
      {technician.photoUrl ? (
        <img src={technician.photoUrl} alt={name} className="tech-photo" />
      ) : (
        <div className="tech-photo tech-photo-fallback" aria-hidden="true">{initials}</div>
      )}
      <div>
        <div className="tech-name">{name}</div>
        <div className="tech-role">Your Waves technician</div>
        {timing && <div className="tech-visit-times">{timing}</div>}
      </div>
    </div>
  );
}

function readinessSummary(context, mode = 'live', nowMsOverride) {
  const fallbackNowMs = mode === 'live' ? Date.now() : Date.parse(context?.generatedAt) || Date.now();
  const nowMs = Number.isFinite(nowMsOverride) ? nowMsOverride : fallbackNowMs;
  const targets = Array.isArray(context?.targets) ? context.targets : [];
  const readyTargets = targets.filter((target) => {
    const readyAtMs = Date.parse(target.readyAt);
    return Number.isFinite(readyAtMs) && readyAtMs <= nowMs;
  });
  const allReady = targets.length > 0 && readyTargets.length === targets.length;
  const areaTypes = targets.map((target) => target.label).filter(Boolean);
  return {
    allReady,
    areaType: areaTypes.length ? areaTypes.join(', ') : 'Treatment areas',
    status: targets.length ? (allReady ? 'Ready now' : 'Ready time pending') : 'See advisory',
    badge: targets.length ? (allReady ? 'Ready now' : 'Re-entry timing') : 'Readiness noted',
    headline: allReady ? `Treated ${areaTypes.join(', ').toLowerCase() || 'areas'} areas are ready now.` : (context?.customerSummary || 'Review the readiness details below.'),
    precautions: context?.petAdvisory || 'None listed',
  };
}

export function readinessStatusBadge(context, mode = 'live', nowMsOverride) {
  if (!context) return null;
  const summary = readinessSummary(context, mode, nowMsOverride);
  return {
    label: summary.badge,
    ready: summary.allReady,
  };
}

function useReadinessNow(context, mode) {
  const generatedAtMs = Date.parse(context?.generatedAt) || Date.now();
  const [nowMs, setNowMs] = useState(mode === 'live' ? Date.now() : generatedAtMs);

  useEffect(() => {
    if (mode !== 'live' || !context) return undefined;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [context, mode]);

  return nowMs;
}

function ServiceStatusCard({ data, mode }) {
  const technician = data.technician?.name || data.technicianName || 'Your Waves technician';
  const arrived = formatClockTime(data.visitTiming?.arrivedAt);
  const completed = formatClockTime(data.visitTiming?.exitedAt);
  const reentryContext = data.dynamicContext?.reentry;
  const nowMs = useReadinessNow(reentryContext, mode);
  const readiness = readinessStatusBadge(reentryContext, mode, nowMs);
  const completedEvent = (data.workflowEvents || []).find((event) => event.type === 'service_completed');
  const completionStatus = completedEvent?.status === 'pending' ? 'In progress' : 'Completed';

  return (
    <section className="sr-hero service-status-card" id="service-status">
      <div className="service-status-main">
        <div>
          <div className="section-eyebrow">Service status</div>
          <h1 className="sr-title">Service report</h1>
          <div className="sr-meta">{serviceDisplayName(data)} | {formatDate(data.serviceDate)}</div>
          {data.serviceAddress && <div className="service-meta-address">{data.serviceAddress}</div>}
        </div>
        {readiness && (
          <div className={`status-badge ${readiness.ready ? 'status-ready' : 'status-pending'}`}>{readiness.label}</div>
        )}
      </div>
      <div className="service-status-grid">
        <div className="sr-cell">
          <div className="sr-cell-label">Technician</div>
          <div className="sr-cell-value">Technician: {technician}</div>
        </div>
        {arrived && (
          <div className="sr-cell">
            <div className="sr-cell-label">Recorded arrival</div>
            <div className="sr-cell-value">{arrived}</div>
          </div>
        )}
        {completed && (
          <div className="sr-cell">
            <div className="sr-cell-label">Recorded completion</div>
            <div className="sr-cell-value">{completed}</div>
          </div>
        )}
        <div className="sr-cell">
          <div className="sr-cell-label">Completion status</div>
          <div className="sr-cell-value">{completionStatus}</div>
        </div>
      </div>
    </section>
  );
}

function ReentryReadinessCard({ context, mode, token }) {
  const nowMs = useReadinessNow(context, mode);
  const readiness = readinessSummary(context, mode, nowMs);

  useEffect(() => {
    if (mode !== 'live' || !context) return;
    trackReportEvent(token, 'reentry_timer_viewed');
  }, [context, mode, token]);

  if (!context) return null;
  return (
    <section className={`sr-section readiness-card ${readiness.allReady ? 'is-ready' : ''}`} id="re-entry">
      <div className="readiness-card-header">
        <div>
          <div className="section-eyebrow">Re-entry / readiness</div>
          <h2>Ready to Re-enter</h2>
          <p>{readiness.headline}</p>
        </div>
        <div className="readiness-status-chip">{readiness.status}</div>
      </div>
      <div className="readiness-facts">
        <div className="sr-cell">
          <div className="sr-cell-label">Treatment area type</div>
          <div className="sr-cell-value">{readiness.areaType}</div>
        </div>
        <div className="sr-cell">
          <div className="sr-cell-label">Status</div>
          <div className="sr-cell-value">{readiness.status}</div>
        </div>
        <div className="sr-cell">
          <div className="sr-cell-label">Precautions</div>
          <div className="sr-cell-value">{readiness.precautions}</div>
        </div>
      </div>
    </section>
  );
}

function HeroConditions({ conditions, weatherCall }) {
  const rows = conditionRows(conditions);
  const copy = weatherCall
    ? [weatherCall.headline, weatherCall.body].filter(Boolean).join(' ')
    : conditionInterpretation(conditions);
  const { Icon, label } = weatherIconInfo(conditions, weatherCall);
  return (
    <div className="hero-conditions">
      <div className="hero-conditions-copy">
        <div className="weather-call-title">
          <span className="weather-call-icon" aria-hidden="true"><Icon size={18} strokeWidth={1.8} /></span>
          <div>
            <div className="section-eyebrow">{weatherCall ? 'Weather call' : 'Conditions at application'}</div>
            <div className="weather-call-icon-label">{label}</div>
          </div>
        </div>
        <p>{copy}</p>
      </div>
      <div className="hero-condition-row">
        {rows.map(([label, value]) => (
          <div className="hero-condition-cell" key={label}>
            <div className="sr-cell-label">{label}</div>
            <div className="sr-cell-value">{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReportAskBox({ mode, token, serviceLine }) {
  const placeholder = serviceLine === 'lawn' ? 'Try: how is my lawn trending?' : 'Try: what was applied today?';
  const prompts = serviceLine === 'lawn'
    ? ['How is my lawn trending?', 'What was applied today?', 'What should I do next?', 'When is my next appointment?']
    : ['What was applied today?', 'When is my next appointment?', 'Is it ready to re-enter?', 'What should I do next?'];
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [asking, setAsking] = useState(false);

  const ask = async (text) => {
    const q = String((text ?? question) || '').trim();
    if (!q || asking) return;
    setAsking(true);
    setAnswer('');
    try {
      const response = await fetch(`${API_BASE}/reports/${token}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'question_failed');
      setAnswer(data.answer || 'I could not answer that from this report.');
      trackReportEvent(token, 'report_question_asked');
    } catch {
      setAnswer('I could not answer that right now. Reply to the text message or call Waves for help.');
    } finally {
      setAsking(false);
    }
  };

  if (mode !== 'live') return null;

  return (
    <div className="report-ask-box">
      <div className="section-eyebrow">Ask Waves AI</div>
      <div className="report-ask-form">
        <input
          id="service-report-question"
          name="service_report_question"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              ask();
            }
          }}
          placeholder={placeholder}
          aria-label="Ask Waves AI about this service report"
        />
        <button type="button" onClick={() => ask()} disabled={asking || !question.trim()}>
          {asking ? 'Checking...' : 'Submit'}
        </button>
      </div>
      <div className="report-ask-actions" aria-label="Example questions">
        {prompts.map((prompt) => (
          <button type="button" key={prompt} onClick={() => ask(prompt)} disabled={asking}>
            {prompt}
          </button>
        ))}
      </div>
      {answer && <div className="report-ask-answer">{answer}</div>}
    </div>
  );
}

export function quickNavigationLinks({ hasProducts = true } = {}) {
  return [
    ['#service-timeline', 'Timeline'],
    ['#areas-serviced', 'Areas Serviced'],
    ['#service-coverage-map', 'Coverage Map'],
    hasProducts ? ['#products-applied', 'Products Applied'] : null,
    ['#what-to-expect', 'What to Expect'],
    ['#supporting-details', 'Details'],
  ].filter(Boolean);
}

function QuickNavigationAndAsk({ mode, token, serviceLine, hasProducts = true }) {
  const links = quickNavigationLinks({ hasProducts });

  return (
    <section className="sr-section quick-report-tools" id="quick-navigation">
      <div className="coverage-section-header">
        <div>
          <h2>Need help with this report?</h2>
          <p className="map-context-copy">Ask Waves AI or jump to the section you need.</p>
        </div>
      </div>
      <nav className="quick-nav-row" aria-label="Service report sections">
        {links.map(([href, label]) => (
          <a href={href} key={href}>{label}</a>
        ))}
      </nav>
      <ReportAskBox mode={mode} token={token} serviceLine={serviceLine} />
    </section>
  );
}

function pressureProgressHeadline(pressureTrend, fallback = 'Service is complete.') {
  if (pressureTrend?.direction === 'first_visit') return 'Your first pressure marker';
  if (pressureTrend?.direction === 'down') return 'Pressure is moving your way';
  if (pressureTrend?.direction === 'up') return 'Pressure needs a closer watch';
  if (pressureTrend?.direction === 'flat') return 'Pressure is holding steady';
  if (pressureTrend?.current?.pressureIndex != null) return 'Pressure snapshot';
  return fallback;
}

function WavesAiSummary({ context = {}, mode, token, pressureTrend, neighborhood, lawnAssessment, serviceLine }) {
  useEffect(() => {
    if (mode !== 'live') return;
    trackReportEvent(token, 'ai_summary_viewed');
  }, [mode, token]);

  const isLawn = serviceLine === 'lawn' && lawnAssessment?.scores;
  const headline = isLawn
    ? (lawnAssessment.customerSummary || 'Lawn assessment is complete.')
    : pressureProgressHeadline(pressureTrend, context.headline || 'Service is complete.');
  const body = isLawn ? lawnAssessmentBody(lawnAssessment) : context.body;

  return (
    <section className="report-card ai-summary-card" data-section="waves-ai-summary">
      {isLawn && <div className="section-eyebrow">Lawn intelligence</div>}
      <h2>{headline}</h2>
      {isLawn ? <LawnMethodologyDropdown /> : <PressureMethodologyDropdown />}
      {body && <p className="ai-summary-body">{body}</p>}
      {!isLawn && Array.isArray(context.bullets) && context.bullets.length > 0 && (
        <div className="ai-summary-bullets">
          {context.bullets.slice(0, 4).map((bullet) => (
            <div className="ai-summary-bullet" key={bullet.text}>{bullet.text}</div>
          ))}
        </div>
      )}
      {isLawn ? (
        <LawnAssessmentCard assessment={lawnAssessment} mode={mode} token={token} embedded />
      ) : pressureTrend && (
        <PressureTrendCard
          context={pressureTrend}
          neighborhood={neighborhood}
          mode={mode}
          token={token}
          embedded
        />
      )}
    </section>
  );
}

function LawnMethodologyDropdown() {
  return (
    <details className="pressure-methodology report-accordion">
      <summary>
        <span>How we score lawn health</span>
        <span className="accordion-action">Details</span>
      </summary>
      <div className="accordion-body">
        <p>
          Lawn health is a 0-100 assessment built from turf photos captured during
          the visit, dual-model vision scoring, technician review, and seasonal
          normalization for Southwest Florida turf. The score weighs turf density,
          weed suppression, color health, fungus control, and thatch level. We also
          compare the current assessment to this property’s baseline and prior
          readings, then interpret it against the treatment plan, expected residual
          activity from products applied, irrigation context, and visible stress
          signals. Higher is better.
        </p>
      </div>
    </details>
  );
}

function PressureMethodologyDropdown() {
  return (
    <details className="pressure-methodology report-accordion">
      <summary>
        <span>How we calculate pest pressure</span>
        <span className="accordion-action">Details</span>
      </summary>
      <div className="accordion-body">
        <p>
          Pest pressure is a 0-5 operational index. The current visit starts with
          documented findings, affected zones, activity level, severity, and the main
          driver observed by the technician. We then compare that signal against this
          property’s historical pressure curve and the treatment plan already in place,
          including residual exterior protection, targeted bait placements, application
          method, treated-zone coverage, and the expected remaining effectiveness window
          for the materials applied. Lower is better. The final reading blends current
          activity with prior visits so a single spike does not overwhelm the trend, while
          recurring pressure still stays visible.
        </p>
      </div>
    </details>
  );
}

function WavesAiPersonalitySummary({ context, mode, token, pressureTrend, neighborhood }) {
  const variants = context.variants || {};
  const active = variants.straight || variants[context.defaultMode] || Object.values(variants)[0];

  useEffect(() => {
    if (mode !== 'live') return;
    trackReportEvent(token, 'ai_summary_personality_viewed', { mode: 'straight' });
  }, [mode, token]);

  if (!active) return null;
  const headline = pressureProgressHeadline(pressureTrend, active.headline || 'Service is complete.');

  return (
    <section className="report-card ai-summary-card premium-ai-summary" data-section="waves-ai-summary">
      <div className="premium-section-header">
        <div>
          <h2>{headline}</h2>
        </div>
      </div>
      {pressureTrend && (
        <PressureTrendCard
          context={pressureTrend}
          neighborhood={neighborhood}
          mode={mode}
          token={token}
          embedded
        />
      )}
      <PressureMethodologyDropdown />
      {active.body && <p className="ai-summary-body">{active.body}</p>}
      {Array.isArray(active.bullets) && active.bullets.length > 0 && (
        <div className="ai-summary-bullets">
          {active.bullets.slice(0, 4).map((bullet) => (
            <div className="ai-summary-bullet" key={bullet.text}>{bullet.text}</div>
          ))}
        </div>
      )}
    </section>
  );
}

function TheOneThing({ move }) {
  if (!move?.title) return null;
  return (
    <section className="report-card the-one-thing" data-section="the-one-thing">
      <div className="section-eyebrow">The one thing</div>
      <h2>{move.title}</h2>
      {(move.why || move.impact) && (
        <div className="one-thing-detail">
          {move.why && (
            <div>
              <div className="sr-cell-label">Why</div>
              <p>{move.why}</p>
            </div>
          )}
          {move.impact && (
            <div>
              <div className="sr-cell-label">Impact</div>
              <p>{move.impact}</p>
            </div>
          )}
        </div>
      )}
      {move.dueLabel && <p className="sr-muted">{move.dueLabel}</p>}
    </section>
  );
}

function statusLabel(value) {
  const labels = {
    active: 'Active',
    clear: 'Clear',
    watched: 'Watched',
    needs_attention: 'Needs attention',
    not_checked: 'Not checked',
  };
  return labels[value] || formatEnumLabel(value);
}

function PropertyDefenseStatus({ context }) {
  if (!context?.items?.length) return null;
  return (
    <section className="report-card property-defense-status" data-section="property-defense-status">
      <div className="section-eyebrow">Property defense status</div>
      <h2>{context.summary}</h2>
      <div className="defense-status-grid">
        {context.items.map((item) => (
          <div className={`defense-status-item status-${item.status}`} key={item.key}>
            <div className="sr-cell-label">{item.label}</div>
            <div className="defense-status-value">{statusLabel(item.status)}</div>
            {item.detail && <div className="sr-row-detail">{item.detail}</div>}
          </div>
        ))}
      </div>
    </section>
  );
}

function BugFileList({ bugFiles = [], mode = 'live', embedded = false }) {
  if (!bugFiles.length) return null;
  const Root = embedded ? 'div' : 'section';
  return (
    <Root className={`${embedded ? 'bug-file-section bug-file-section-embedded' : 'sr-section bug-file-section'}`} data-section="bug-file">
      <h2>The bug file</h2>
      <div className="bug-file-grid">
        {bugFiles.map((bug) => (
          <details className="bug-file-card report-accordion" key={bug.pestKey} open={mode !== 'live'}>
            <summary>
              <span>
                <span className="sr-cell-label">Suspect</span>
                <span className="bug-file-suspect">{bug.suspectLabel}</span>
              </span>
              <span className="accordion-action">Details</span>
            </summary>
            <div className="accordion-body">
              {bug.whereSeen?.text && (
                <div className="bug-file-row">
                  <div className="sr-cell-label">Where we saw it</div>
                  <p>{bug.whereSeen.text}</p>
                </div>
              )}
              {bug.whyItMatters?.text && (
                <div className="bug-file-row">
                  <div className="sr-cell-label">Why it matters</div>
                  <p>{bug.whyItMatters.text}</p>
                </div>
              )}
              {bug.whatWeDid?.text && (
                <div className="bug-file-row">
                  <div className="sr-cell-label">What we did</div>
                  <p>{bug.whatWeDid.text}</p>
                </div>
              )}
              {bug.yourMove?.text && (
                <div className="bug-file-row">
                  <div className="sr-cell-label">Your move</div>
                  <p>{bug.yourMove.text}</p>
                </div>
              )}
            </div>
          </details>
        ))}
      </div>
    </Root>
  );
}

function WhyActivityCard({ context, embedded = false }) {
  if (!context?.title || !context.body) return null;
  const Root = embedded ? 'div' : 'section';
  return (
    <Root className={`${embedded ? 'why-activity-card why-activity-card-embedded' : 'sr-section why-activity-card'}`} data-section="why-activity">
      <h2>{context.title}</h2>
      <p>{context.body}</p>
      {context.whenToTextUs && (
        <div className="when-to-text">
          <div className="sr-cell-label">When to text us</div>
          <p>{context.whenToTextUs}</p>
        </div>
      )}
    </Root>
  );
}

function whatToExpectCopy(context = {}, serviceLine = 'pest') {
  if (serviceLine === 'lawn') {
    return context.body || 'Lawn treatments are evaluated over time. Conditions can continue changing between visits based on irrigation, mowing, rainfall, heat, and turf response.';
  }
  return 'Exterior treatments are applied to reduce activity around entry-prone areas. Some light outdoor activity can still appear while the treatment band is active. Activity should begin to ease over the expected treatment window.';
}

function WhatToExpectNextSection({ context, serviceLine }) {
  return (
    <section className="sr-section what-to-expect-section" id="what-to-expect">
      <h2>What to Expect Next</h2>
      <p>{whatToExpectCopy(context, serviceLine)}</p>
    </section>
  );
}

function WhenToContactUsSection() {
  const items = [
    'Activity increases',
    'Activity moves inside',
    'Activity continues after the expected treatment window',
    'You have questions about treated areas',
  ];
  return (
    <section className="sr-section contact-waves-section" id="when-to-contact">
      <h2>When to Contact Us</h2>
      <p>Text us if:</p>
      <ul>
        {items.map((item) => <li key={item}>{item}</li>)}
      </ul>
      <a href="sms:+19412975749" className="contact-waves-cta">Text Waves</a>
    </section>
  );
}

function ReviewRequestCard({ data, token, mode, placement = 'top' }) {
  if (mode !== 'live') return null;
  if (data?.hasLeftGoogleReview || data?.reviewRequestEligible === false) return null;
  const location = reviewLocationForReport(data);
  const copy = reviewRequestCopy(placement);
  return (
    <section className={`report-card review-request-card review-request-card-${placement}`} data-section={`review-request-${placement}`}>
      <div>
        <h2>{copy.title}</h2>
        {copy.body && <p>{copy.body}</p>}
      </div>
      <a
        className="review-cta"
        href={location.reviewUrl}
        target="_blank"
        rel="noreferrer"
        onClick={() => trackReportEvent(token, 'review_request_clicked', { location: location.key, placement })}
      >
        {copy.cta}
      </a>
    </section>
  );
}

export function reviewRequestCopy(placement = 'top') {
  if (placement === 'bottom') {
    return {
      title: 'Help the next neighbor choose faster',
      body: null,
      cta: 'Share feedback',
    };
  }
  return {
    title: "How did today's visit go?",
    body: 'Share a quick note while the visit is fresh.',
    cta: 'Share feedback',
  };
}

function ExecutiveStatusGrid({ data, pressureTrend, reentry, mode }) {
  const nowMs = mode === 'live' ? Date.now() : Date.parse(reentry?.generatedAt) || Date.now();
  const targets = reentry?.targets || [];
  const readySummary = targets.length
    ? targets.map((target) => {
      const readyAtMs = Date.parse(target.readyAt);
      const value = Number.isFinite(readyAtMs) && readyAtMs <= nowMs
        ? 'Ready now'
        : `Ready after ${formatReadyTime(target.readyAt, reentry.displayTimezone)}`;
      return `${target.label}: ${value}`;
    }).join(' · ')
    : 'See customer advisory';
  const pressureValue = pressureTrend?.current?.pressureIndex ?? data.pressureIndex;

  return (
    <section className="executive-status-grid" aria-label="Executive summary">
      <div className="executive-status-cell">
        <div className="sr-cell-label">Pressure trend</div>
        <div className="executive-status-value">{pressureTrend?.customerSummary || `${formatPressureIndex(pressureValue)} pressure index`}</div>
        <div className="sr-row-detail">Lower is better</div>
      </div>
      <div className="executive-status-cell">
        <div className="sr-cell-label">Ready to re-enter</div>
        <div className="executive-status-value">{readySummary}</div>
      </div>
      <div className="executive-status-cell">
        <div className="sr-cell-label">Today's service</div>
        <div className="executive-status-value">{serviceDisplayName(data)}</div>
        <div className="sr-row-detail">{formatDate(data.serviceDate)}</div>
      </div>
    </section>
  );
}

function SinceLastVisit({ context }) {
  const rows = [
    context.pressureLine ? ['Pressure', context.pressureLine.replace(/^Pressure:\s*/i, '')] : null,
    context.activityLine ? ['Activity', context.activityLine] : null,
    context.actionLine ? ['Customer action', context.actionLine.replace(/^Customer action:\s*/i, '')] : null,
  ].filter(Boolean);
  if (!rows.length) return null;
  return (
    <section className="sr-section since-last-visit">
      <h2>Since last visit</h2>
      <div className="sr-list">
        {rows.map(([label, value]) => (
          <div className="sr-row" key={label}>
            <div>
              <div className="sr-cell-label">{label}</div>
              <div className="sr-row-title">{value}</div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function RecommendedActionCard({ findings = [], aiSummary, primaryMove }) {
  const aiAction = aiSummary?.recommendedNextStep?.text;
  const finding = recommendedFinding(findings);
  const text = primaryMove?.title || aiAction || finding?.recommendation;
  if (!text) return null;
  return (
    <section className="sr-section recommended-action-card">
      <h2>Recommended next step</h2>
      <p className="recommended-action-text">{text}</p>
    </section>
  );
}

function WhatHappenedWhere({ data, token, mode = 'live' }) {
  const zoneById = new Map((data.zones || []).map((zone) => [String(zone.id), zone]));
  const rows = [];
  for (const finding of data.findings || []) {
    if (!finding.zoneId) continue;
    const zone = zoneById.get(String(finding.zoneId));
    rows.push({
      key: `finding-${finding.id}`,
      place: zone ? `${zone.letter} · ${zone.label}` : 'Observed area',
      detail: [finding.title, finding.detail].filter(Boolean).join('. '),
    });
  }
  for (const app of data.applications || []) {
    const zones = (app.zone_ids || []).map((id) => zoneById.get(String(id))).filter(Boolean);
    if (!zones.length) continue;
    rows.push({
      key: `app-${app.id}`,
      place: zones.map((zone) => zone.letter).join(', '),
      detail: `${applicationPurpose(app, data.serviceLine)}. ${applicationPurposeCopy(app, data.serviceLine)}`,
    });
  }
  const deduped = rows.filter((row, index, all) => (
    all.findIndex((candidate) => candidate.place === row.place && candidate.detail === row.detail) === index
  )).slice(0, 6);
  if (!deduped.length) return null;
  return (
    <section className="sr-section what-happened-where">
      <h2>What happened where</h2>
      <div className="where-accordion-list">
        {deduped.map((row) => (
          <details
            className="where-row report-accordion"
            key={row.key}
            open={mode !== 'live'}
            onToggle={(event) => {
              if (event.currentTarget.open) {
                trackReportEvent(token, 'map_interacted', { source: 'what_happened_where', row: row.key });
              }
            }}
          >
            <summary>
              <span className="where-place">{row.place}</span>
              <span className="accordion-action">Details</span>
            </summary>
            <div className="where-detail accordion-body">{row.detail}</div>
          </details>
        ))}
      </div>
    </section>
  );
}

function AppliedProductsSection({ data, showAll = false, showTechnical = false, mode = 'live' }) {
  const applications = Array.isArray(data.applications) ? data.applications : [];
  if (!applications.length) return null;
  const groupedApplications = groupApplicationsByPurpose(applications, data);
  const visibleGroups = showAll ? groupedApplications : groupedApplications.slice(0, 4);

  return (
    <section className="sr-section applied-products-section" id="products-applied">
      <div className="applied-products-header">
        <div>
          <h2>Products Applied</h2>
          <p>What was applied, where, and why.</p>
        </div>
      </div>
      {visibleGroups.length > 0 && (
        <div className="applied-products-grid">
          {visibleGroups.map((group) => (
            <article className="applied-product-card product-group-card" key={group.key}>
              <div className="sr-cell-label">{group.purpose}</div>
              <h3>{group.purpose}</h3>
              <p>{group.copy}</p>
              <div className="product-group-list" aria-label={`${group.purpose} products`}>
                <div className="sr-cell-label">Products</div>
                <ul>
                  {group.products.map((app) => (
                    <li key={app.id}>
                      <strong>{app.product?.name || 'Product application'}</strong>
                      {app.product?.active_ingredient && <span>{app.product.active_ingredient}</span>}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="applied-product-meta">
                <span>Method: {group.method}</span>
                <span>{group.zones}</span>
              </div>
              {showTechnical && (
                <details className="solution-detail report-accordion" open={mode !== 'live'}>
                  <summary>
                    <span>Technical application details</span>
                    <span className="accordion-action">Details</span>
                  </summary>
                  <div className="accordion-body solution-detail-body">
                    {group.products.map((app) => (
                      <p key={`${app.id}-tech`}>
                        {[
                          app.product?.name || 'Product application',
                          app.product?.epa_reg ? `EPA reg. ${app.product.epa_reg}` : null,
                          app.rate && app.rateUnit ? `Rate: ${app.rate} ${app.rateUnit}` : null,
                          app.totalAmount && app.amountUnit ? `Total: ${app.totalAmount} ${app.amountUnit}` : null,
                        ].filter(Boolean).join(' | ')}
                      </p>
                    ))}
                  </div>
                </details>
              )}
            </article>
          ))}
        </div>
      )}
      {!showTechnical && groupedApplications.length > visibleGroups.length && (
        <p className="sr-muted">{groupedApplications.length - visibleGroups.length} more application group{groupedApplications.length - visibleGroups.length === 1 ? '' : 's'} included in the downloadable report.</p>
      )}
    </section>
  );
}

const COVERAGE_VIEWBOX = { width: 640, height: 340, padding: 28 };
const COVERAGE_STATUSES = {
  treated: { label: 'Treated', tone: 'green', Icon: CheckCircle2 },
  partially_treated: { label: 'Partially treated', tone: 'light-green', Icon: CheckCircle2 },
  serviced: { label: 'Serviced', tone: 'green', Icon: CheckCircle2 },
  inspected: { label: 'Inspected', tone: 'blue', Icon: Eye },
  spot_treated: { label: 'Spot-treated', tone: 'blue', Icon: Eye },
  skipped: { label: 'Skipped', tone: 'orange', Icon: AlertTriangle },
  inaccessible: { label: 'Inaccessible', tone: 'orange', Icon: AlertTriangle },
  activity_found: { label: 'Activity found', tone: 'orange', Icon: MapPin },
  entry_point_found: { label: 'Entry point noted', tone: 'orange', Icon: MapPin },
  blocked: { label: 'Blocked', tone: 'red', Icon: Lock },
  device_checked: { label: 'Checked', tone: 'blue', Icon: MapPin },
  device_placed: { label: 'Placed', tone: 'green', Icon: MapPin },
  not_included: { label: 'Not included', tone: 'gray', Icon: AlertTriangle },
};
const EVIDENCE_COPY = {
  technician_confirmed: 'Marked completed by your technician.',
  gps_assisted: 'Technician visit location was used to help confirm service.',
  equipment_verified: 'Treatment activity was recorded for this area.',
  device_logged: 'Device activity was logged during the visit.',
};

function normalizeCoverageServiceType(value) {
  const raw = String(value || '').toLowerCase();
  if (raw.includes('lawn')) return 'lawn';
  if (raw.includes('pest') || raw === 'pest_control' || raw.includes('termite') || raw.includes('rodent')) return 'pest_control';
  if (raw.includes('mosquito')) return 'mosquito';
  if (raw.includes('tree') || raw.includes('shrub') || raw.includes('palm')) return 'tree_shrub';
  return 'other';
}

function coverageStatusConfig(status) {
  return COVERAGE_STATUSES[status] || { label: formatEnumLabel(status) || 'Service location', tone: 'gray', Icon: MapPin };
}

function coverageSectionSubtitle(serviceType) {
  if (serviceType === 'lawn') {
    return 'Your technician marked the areas shown in green as completed during today’s visit.';
  }
  if (serviceType === 'pest_control') {
    return 'Your technician marked serviced, inspected, and inaccessible areas from today’s pest control visit.';
  }
  return 'See where your technician serviced, inspected, or could not access during today’s visit.';
}

function coverageLegendKey(status, serviceType) {
  if (status === 'treated' || status === 'serviced' || status === 'device_placed') return 'green';
  if (status === 'partially_treated') return 'light-green';
  if (status === 'inspected' || status === 'spot_treated' || status === 'device_checked') return 'blue';
  if (status === 'activity_found' || status === 'entry_point_found' || status === 'skipped' || status === 'inaccessible') return 'orange';
  if (status === 'blocked') return 'red';
  if (status === 'not_included') return 'gray';
  return serviceType === 'lawn' ? 'green' : 'blue';
}

function coverageLegendLabel(key, serviceType, statuses) {
  if (key === 'green') return serviceType === 'lawn' ? 'Treated' : 'Serviced';
  if (key === 'light-green') return 'Partially treated';
  if (key === 'blue') return serviceType === 'lawn' ? 'Inspected / spot-treated' : 'Inspected';
  if (key === 'orange') {
    return serviceType === 'pest_control'
      ? (statuses.some((status) => status === 'activity_found' || status === 'entry_point_found') ? 'Activity found / skipped' : 'Skipped / inaccessible')
      : 'Skipped / inaccessible';
  }
  if (key === 'red') return 'Blocked / unsafe';
  if (key === 'gray') return 'Not included';
  return formatEnumLabel(key);
}

function coverageLegendItems(locations, serviceType) {
  const statuses = locations.map((location) => location.status).filter(Boolean);
  const seen = new Set();
  return statuses.map((status) => {
    const key = coverageLegendKey(status, serviceType);
    if (seen.has(key)) return null;
    seen.add(key);
    const Icon = coverageStatusConfig(status).Icon;
    return {
      key,
      tone: key,
      Icon,
      label: coverageLegendLabel(key, serviceType, statuses),
    };
  }).filter(Boolean);
}

function formatSqFt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  return `${Math.round(n).toLocaleString()} sq ft`;
}

function coverageReasonText(location, serviceType) {
  const reason = String(location.skippedReason || location.blockedReason || '').trim();
  if (!reason) return '';
  if (location.status === 'blocked') return `Blocked because: ${reason}`;
  if (serviceType === 'pest_control' && (location.status === 'skipped' || location.status === 'inaccessible')) {
    return `Could not access: ${reason}`;
  }
  if (location.status === 'skipped' || location.status === 'inaccessible') return `Skipped because: ${reason}`;
  return reason;
}

function coverageSummaryParts(location, serviceType) {
  return [
    coverageStatusConfig(location.status).label,
    coverageReasonText(location, serviceType),
    location.customerVisibleNote,
    formatSqFt(location.areaSqFt),
  ].filter(Boolean);
}

function coverageGeometryPairs(value, output = []) {
  if (!Array.isArray(value)) return output;
  if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
    output.push([Number(value[0]), Number(value[1])]);
    return output;
  }
  value.forEach((entry) => coverageGeometryPairs(entry, output));
  return output;
}

function coverageLocationPairs(location) {
  return coverageGeometryPairs(location.geometry?.coordinates);
}

function hasRenderableCoverageGeometry(location) {
  return Boolean(location?.geometry?.type && coverageLocationPairs(location).length);
}

function coverageDisplayLocation(location, preferImageGeometry = false) {
  if (preferImageGeometry && location?.imageGeometry?.type) {
    return { ...location, geometry: location.imageGeometry };
  }
  return location;
}

function coverageImageDisplayLocation(location) {
  return location?.imageGeometry?.type
    ? { ...location, geometry: location.imageGeometry }
    : { ...location, geometry: undefined };
}

function buildCoverageProjection(locations) {
  const pairs = locations.flatMap(coverageLocationPairs);
  if (!pairs.length) return null;
  let minX = Math.min(...pairs.map(([x]) => x));
  let maxX = Math.max(...pairs.map(([x]) => x));
  let minY = Math.min(...pairs.map(([, y]) => y));
  let maxY = Math.max(...pairs.map(([, y]) => y));
  const coordinatesAreNormalized = minX >= 0 && maxX <= 1 && minY >= 0 && maxY <= 1;
  if (coordinatesAreNormalized) return { mode: 'normalized' };
  const coordinatesAreLocal = minX >= 0 && maxX <= COVERAGE_VIEWBOX.width && minY >= 0 && maxY <= COVERAGE_VIEWBOX.height;
  if (coordinatesAreLocal) return { mode: 'local' };
  if (minX === maxX) {
    minX -= 0.0005;
    maxX += 0.0005;
  }
  if (minY === maxY) {
    minY -= 0.0005;
    maxY += 0.0005;
  }
  const hasNegative = pairs.some(([x, y]) => x < 0 || y < 0);
  const yDown = !hasNegative;
  return { minX, maxX, minY, maxY, yDown };
}

function projectCoveragePoint(point, projection) {
  const { width, height, padding } = COVERAGE_VIEWBOX;
  const [rawX, rawY] = point;
  if (projection.mode === 'normalized') {
    return { x: Number(rawX) * width, y: Number(rawY) * height };
  }
  if (projection.mode === 'local') {
    return { x: Number(rawX), y: Number(rawY) };
  }
  const x = padding + ((Number(rawX) - projection.minX) / (projection.maxX - projection.minX)) * (width - padding * 2);
  const yRatio = (Number(rawY) - projection.minY) / (projection.maxY - projection.minY);
  const y = projection.yDown
    ? padding + yRatio * (height - padding * 2)
    : padding + (1 - yRatio) * (height - padding * 2);
  return { x, y };
}

function coverageLinePath(coordinates = [], projection) {
  return coordinates.map((point, index) => {
    const { x, y } = projectCoveragePoint(point, projection);
    return `${index === 0 ? 'M' : 'L'} ${x} ${y}`;
  }).join(' ');
}

function coveragePolygonPath(coordinates = [], projection) {
  return coordinates.map((ring) => `${coverageLinePath(ring, projection)} Z`).join(' ');
}

function coverageGeometryCenter(geometry, projection) {
  const pairs = coverageGeometryPairs(geometry?.coordinates);
  if (!pairs.length || !projection) return null;
  const xs = pairs.map(([x]) => x);
  const ys = pairs.map(([, y]) => y);
  return projectCoveragePoint([
    (Math.min(...xs) + Math.max(...xs)) / 2,
    (Math.min(...ys) + Math.max(...ys)) / 2,
  ], projection);
}

function coverageMarkerText(status) {
  if (status === 'device_checked' || status === 'device_placed') return 'D';
  if (status === 'inspected' || status === 'spot_treated') return 'i';
  if (status === 'treated' || status === 'serviced' || status === 'partially_treated') return 'OK';
  return '!';
}

function coverageAriaLabel(location) {
  const detail = coverageSummaryParts(location, normalizeCoverageServiceType(location.serviceType)).join(', ');
  return `${location.name}: ${detail}`;
}

function CoverageMapGeometry({ location, projection }) {
  const geometry = location.geometry;
  const config = coverageStatusConfig(location.status);
  const toneClass = `status-${config.tone}`;
  const label = coverageAriaLabel(location);
  const center = coverageGeometryCenter(geometry, projection);
  const labelText = location.status === 'skipped' || location.status === 'inaccessible'
    ? `${location.name} skipped`
    : location.status === 'activity_found'
      ? 'Activity noted'
      : location.status === 'entry_point_found'
        ? 'Entry point'
        : location.name;

  if (geometry.type === 'Polygon') {
    return (
      <g className="coverage-geometry-group" tabIndex={0} role="img" aria-label={label}>
        <path className={`coverage-area ${toneClass} status-${location.status}`} d={coveragePolygonPath(geometry.coordinates || [], projection)}>
          <title>{label}</title>
        </path>
        {center && <text x={center.x} y={center.y} className="coverage-map-label">{labelText}</text>}
      </g>
    );
  }
  if (geometry.type === 'MultiPolygon') {
    return (
      <g className="coverage-geometry-group" tabIndex={0} role="img" aria-label={label}>
        {(geometry.coordinates || []).map((polygon, index) => (
          <path key={`${location.id}-poly-${index}`} className={`coverage-area ${toneClass} status-${location.status}`} d={coveragePolygonPath(polygon, projection)}>
            <title>{label}</title>
          </path>
        ))}
        {center && <text x={center.x} y={center.y} className="coverage-map-label">{labelText}</text>}
      </g>
    );
  }
  if (geometry.type === 'LineString') {
    return (
      <g className="coverage-geometry-group" tabIndex={0} role="img" aria-label={label}>
        <path className={`coverage-line ${toneClass} status-${location.status}`} d={coverageLinePath(geometry.coordinates || [], projection)}>
          <title>{label}</title>
        </path>
        {center && <text x={center.x} y={center.y - 10} className="coverage-map-label">{labelText}</text>}
      </g>
    );
  }
  if (geometry.type === 'MultiLineString') {
    return (
      <g className="coverage-geometry-group" tabIndex={0} role="img" aria-label={label}>
        {(geometry.coordinates || []).map((line, index) => (
          <path key={`${location.id}-line-${index}`} className={`coverage-line ${toneClass} status-${location.status}`} d={coverageLinePath(line, projection)}>
            <title>{label}</title>
          </path>
        ))}
        {center && <text x={center.x} y={center.y - 10} className="coverage-map-label">{labelText}</text>}
      </g>
    );
  }
  if (geometry.type === 'Point') {
    const point = projectCoveragePoint(geometry.coordinates || [0, 0], projection);
    return (
      <g className={`coverage-marker ${toneClass} status-${location.status}`} transform={`translate(${point.x} ${point.y})`} tabIndex={0} role="img" aria-label={label}>
        <title>{label}</title>
        <circle r="13" className="coverage-marker-outer" />
        <circle r="9" className="coverage-marker-inner" />
        <text y="3.5" textAnchor="middle" className="coverage-marker-text">{coverageMarkerText(location.status)}</text>
        <text x="16" y="4" className="coverage-map-label coverage-point-label">{labelText}</text>
      </g>
    );
  }
  return null;
}

function ServiceCoverageMapSection({
  serviceType,
  serviceLocations,
  propertyAddress,
  serviceDate,
  evidenceLevel,
  mapBackgroundUrl,
  mapAttribution,
  loading = false,
}) {
  const normalizedServiceType = normalizeCoverageServiceType(serviceType);
  const locations = Array.isArray(serviceLocations) ? serviceLocations : [];
  const imageLocations = locations.map(coverageImageDisplayLocation);
  const imageRenderableCount = imageLocations.filter(hasRenderableCoverageGeometry).length;
  const canUseImageMap = Boolean(mapBackgroundUrl)
    && imageRenderableCount > 0
    && locations.every((location) => (
      !hasRenderableCoverageGeometry(location)
      || hasRenderableCoverageGeometry(coverageImageDisplayLocation(location))
    ));
  const activeMapBackgroundUrl = canUseImageMap ? mapBackgroundUrl : null;
  const displayLocations = useMemo(
    () => locations.map((location) => coverageDisplayLocation(location, canUseImageMap)),
    [locations, canUseImageMap],
  );
  const renderableLocations = displayLocations.filter(hasRenderableCoverageGeometry);
  const projection = useMemo(() => buildCoverageProjection(renderableLocations), [renderableLocations]);
  const legend = coverageLegendItems(locations, normalizedServiceType);
  const evidenceNote = EVIDENCE_COPY[evidenceLevel]
    || EVIDENCE_COPY[locations.find((location) => EVIDENCE_COPY[location.evidenceLevel])?.evidenceLevel];
  const subtitle = coverageSectionSubtitle(normalizedServiceType);

  if (loading) {
    return (
      <section className="sr-section service-coverage-section service-coverage-loading" id="service-coverage-map">
        <h2>Coverage Map</h2>
        <div className="coverage-skeleton-map" aria-label="Loading service coverage map" />
        <div className="coverage-skeleton-list">
          <span />
          <span />
          <span />
        </div>
      </section>
    );
  }

  return (
    <section className="sr-section service-coverage-section" id="service-coverage-map">
      <div className="coverage-section-header">
        <div>
          <h2>Coverage Map</h2>
          <p className="map-context-copy">{subtitle}</p>
        </div>
        {(propertyAddress || serviceDate) && (
          <div className="coverage-map-meta" aria-label="Service map context">
            {propertyAddress && <span>{propertyAddress}</span>}
            {serviceDate && <span>{formatDate(serviceDate)}</span>}
          </div>
        )}
      </div>

      {!locations.length ? (
        <div className="coverage-empty-state">Service coverage map is not available for this visit.</div>
      ) : (
        <>
          <div
            className={`service-coverage-map${activeMapBackgroundUrl ? ' has-map-image' : ''}`}
            style={activeMapBackgroundUrl ? { '--coverage-map-image': `url("${activeMapBackgroundUrl}")` } : undefined}
          >
            {projection && renderableLocations.length ? (
              <svg
                role="img"
                aria-label="Service coverage map showing completed, inspected, skipped, and noted service locations"
                viewBox={`0 0 ${COVERAGE_VIEWBOX.width} ${COVERAGE_VIEWBOX.height}`}
                className="coverage-map-svg"
              >
                <defs>
                  <pattern id="coverage-grid" width="24" height="24" patternUnits="userSpaceOnUse">
                    <path d="M24 0H0V24" className="coverage-grid-line" />
                  </pattern>
                  <pattern id="coverage-partial-pattern" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                    <rect width="9" height="9" className="coverage-partial-bg" />
                    <line x1="0" y1="0" x2="0" y2="9" className="coverage-partial-line" />
                  </pattern>
                </defs>
                <rect width={COVERAGE_VIEWBOX.width} height={COVERAGE_VIEWBOX.height} className="coverage-map-base" />
                {!activeMapBackgroundUrl && (
                  <>
                    <rect x="36" y="30" width="568" height="280" rx="12" className="coverage-map-lot" />
                    <rect x="248" y="124" width="144" height="92" rx="5" className="coverage-map-structure" />
                    <rect x="392" y="146" width="64" height="70" rx="4" className="coverage-map-structure coverage-map-garage" />
                    <path d="M456 217L512 310" className="coverage-map-drive" />
                  </>
                )}
                {renderableLocations.map((location) => (
                  <CoverageMapGeometry key={location.id || `${location.name}-${location.status}`} location={location} projection={projection} />
                ))}
              </svg>
            ) : (
              <div className="coverage-empty-state coverage-empty-state-map">Map geometry is not available for these locations.</div>
            )}
            {activeMapBackgroundUrl && mapAttribution && <div className="map-attribution coverage-map-attribution">{mapAttribution}</div>}
          </div>

          {legend.length > 0 && (
            <div className="coverage-legend" aria-label="Service coverage legend">
              {legend.map(({ key, label, tone, Icon }) => (
                <div className={`coverage-legend-item status-${tone}`} key={key}>
                  <span className="coverage-legend-swatch" aria-hidden="true"><Icon size={14} strokeWidth={2} /></span>
                  <span>{label}</span>
                </div>
              ))}
            </div>
          )}

          {evidenceNote && <p className="coverage-evidence-note">{evidenceNote}</p>}
          <p className="map-footnote">Service coverage is based on technician-marked locations and available visit data. It is not a property survey.</p>
        </>
      )}
    </section>
  );
}

function workflowIconForType(type) {
  if (type === 'technician_en_route') return Route;
  if (type === 'arrived_on_site') return MapPin;
  if (type === 'inspection_started') return Eye;
  if (type === 'service_completed') return CheckCircle2;
  if (type === 'report_published') return FileCheck2;
  return Clock;
}

export function timelineEventsForDisplay(workflowEvents = []) {
  if (!Array.isArray(workflowEvents)) return [];
  return workflowEvents.filter((event) => event?.type !== 'customer_interaction');
}

function hasDuplicateDisplayedEventTimes(events = []) {
  const counts = new Map();
  for (const event of events) {
    const label = formatClockTime(event.timestamp);
    if (!label) continue;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return Array.from(counts.values()).some((count) => count > 1);
}

function ServiceTimelineSection({ serviceType, workflowEvents, loading = false }) {
  const events = timelineEventsForDisplay(workflowEvents);
  const normalizedServiceType = normalizeCoverageServiceType(serviceType);
  const showSameTimeNote = hasDuplicateDisplayedEventTimes(events);

  if (loading) {
    return (
      <section className="sr-section service-workflow-section service-workflow-loading" id="service-timeline">
        <h2>Service Timeline</h2>
        <div className="workflow-skeleton-list">
          <span />
          <span />
          <span />
        </div>
      </section>
    );
  }

  return (
    <section className="sr-section service-workflow-section" id="service-timeline">
      <div className="coverage-section-header">
        <div>
          <h2>Service Timeline</h2>
          <p className="map-context-copy">
            {normalizedServiceType === 'pest_control'
              ? 'Here’s how today’s pest control visit progressed.'
              : 'Here’s how today’s visit progressed.'}
          </p>
        </div>
      </div>

      {!events.length ? (
        <div className="coverage-empty-state">Service timeline details are not available for this visit.</div>
      ) : (
        <>
          <ol className="service-workflow-timeline">
            {events.map((event) => {
              const Icon = workflowIconForType(event.type);
              return (
                <li className={`workflow-event workflow-status-${event.status || 'completed'}`} key={event.id || `${event.type}-${event.timestamp}`}>
                  <span className="workflow-event-icon" aria-hidden="true">
                    <Icon size={16} strokeWidth={2} />
                  </span>
                  <div className="workflow-event-body">
                    <div className="workflow-event-heading">
                      <h3>{event.label || formatEnumLabel(event.type)}</h3>
                      {event.timestamp && <time dateTime={event.timestamp}>{formatClockTime(event.timestamp)}</time>}
                    </div>
                    {event.customerVisibleDescription && <p>{event.customerVisibleDescription}</p>}
                  </div>
                </li>
              );
            })}
          </ol>
          {showSameTimeNote && <p className="timeline-note">Some events were recorded at the same time and are shown in standard service order.</p>}
        </>
      )}
    </section>
  );
}

function AreasServicedSection({ serviceAreas = [], serviceLocations = [], serviceType }) {
  const normalizedServiceType = normalizeCoverageServiceType(serviceType);
  const locationRows = Array.isArray(serviceLocations) && serviceLocations.length
    ? serviceLocations.map((location) => ({
      key: location.id || `${location.name}-${location.status}`,
      name: location.name,
      status: coverageStatusConfig(location.status).label,
      tone: coverageStatusConfig(location.status).tone,
    }))
    : serviceAreas.map((area) => ({
      key: area,
      name: area,
      status: 'Serviced',
      tone: 'green',
    }));

  return (
    <section className="sr-section areas-serviced-section" id="areas-serviced">
      <div className="coverage-section-header">
        <div>
          <h2>Areas Serviced</h2>
          <p className="map-context-copy">{coverageSectionSubtitle(normalizedServiceType)}</p>
        </div>
      </div>
      {!locationRows.length ? (
        <div className="coverage-empty-state">Serviced areas were not recorded for this visit.</div>
      ) : (
        <div className="areas-serviced-list" aria-label="Areas serviced">
          {locationRows.map((row) => (
            <article className="coverage-summary-row" key={row.key}>
              <h3>{row.name}</h3>
              <span className={`coverage-status-chip status-${row.tone}`}>{row.status}</span>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function ServiceReportCoverageAndWorkflow({
  serviceType,
  serviceAreas,
  serviceLocations,
  workflowEvents,
  propertyAddress,
  mapCenter,
  serviceDate,
  evidenceLevel,
  mapBackgroundUrl,
  mapAttribution,
}) {
  return (
    <>
      <ServiceTimelineSection
        serviceType={serviceType}
        workflowEvents={workflowEvents}
      />
      <AreasServicedSection
        serviceType={serviceType}
        serviceAreas={serviceAreas}
        serviceLocations={serviceLocations}
      />
      <ServiceCoverageMapSection
        serviceType={serviceType}
        serviceLocations={serviceLocations}
        propertyAddress={propertyAddress}
        mapCenter={mapCenter}
        serviceDate={serviceDate}
        evidenceLevel={evidenceLevel}
        mapBackgroundUrl={mapBackgroundUrl}
        mapAttribution={mapAttribution}
      />
    </>
  );
}

function SupportingDetailsSection({
  data,
  token,
  mode,
  showDetails,
  serviceNotes,
  findings,
  recommendations,
  advisoryRows,
}) {
  const pressureTrend = data.dynamicContext?.pressureTrend;
  const weatherRows = conditionRows(data.conditions || {});
  const arrival = formatClockTime(data.visitTiming?.arrivedAt);
  const completion = formatClockTime(data.visitTiming?.exitedAt);
  const reportPublished = (data.workflowEvents || []).find((event) => event.type === 'report_published');
  const pressureOpen = mode !== 'live' || showDetails;

  return (
    <section className="sr-section supporting-details-section" id="supporting-details">
      <h2>Supporting Details</h2>
      <div className="supporting-details-list">
        <details className="report-accordion" open={mode !== 'live'}>
          <summary>
            <span>Conditions at application</span>
            <span className="accordion-action">Details</span>
          </summary>
          <div className="accordion-body">
            <p className="supporting-detail-copy">{conditionInterpretation(data.conditions || {})}</p>
            <div className="supporting-detail-grid">
              {weatherRows.map(([label, value]) => (
                <div className="sr-cell" key={label}>
                  <div className="sr-cell-label">{label}</div>
                  <div className="sr-cell-value">{value}</div>
                </div>
              ))}
            </div>
          </div>
        </details>

        {pressureTrend && (
          <details className="report-accordion" open={pressureOpen}>
            <summary>
              <span>Pest Pressure</span>
              <span className="accordion-action">Details</span>
            </summary>
            <div className="accordion-body">
              <PressureTrendCard
                context={pressureTrend}
                neighborhood={data.dynamicContext?.neighborhoodPressure}
                mode={mode}
                token={token}
                embedded
              />
              <PressureMethodologyDropdown />
            </div>
          </details>
        )}

        {(arrival || completion) && (
          <details className="report-accordion" open={mode !== 'live'}>
            <summary>
              <span>Visit timing</span>
              <span className="accordion-action">Details</span>
            </summary>
            <div className="accordion-body">
              <div className="supporting-detail-grid">
                {arrival && (
                  <div className="sr-cell">
                    <div className="sr-cell-label">Recorded arrival</div>
                    <div className="sr-cell-value">{arrival}</div>
                  </div>
                )}
                {completion && (
                  <div className="sr-cell">
                    <div className="sr-cell-label">Recorded completion</div>
                    <div className="sr-cell-value">{completion}</div>
                  </div>
                )}
              </div>
            </div>
          </details>
        )}

        {showDetails && (data.metrics || []).length > 0 && (
          <details className="report-accordion">
            <summary>
              <span>Service metrics</span>
              <span className="accordion-action">Details</span>
            </summary>
            <div className="accordion-body">
              <div className="sr-band supporting-metrics" aria-label="Service metrics">
                {(data.metrics || []).map((metric) => (
                  <div className="sr-metric" key={metric.key} title={metricHelpText(metric)}>
                    <div className="sr-metric-value">{formatMetric(metric)}</div>
                    <div className="sr-metric-label">{metric.label}</div>
                  </div>
                ))}
              </div>
            </div>
          </details>
        )}

        {showDetails && ((data.applications || []).length > 0 || findings.length > 0 || recommendations.length > 0 || serviceNotes) && (
          <details className="report-accordion">
            <summary>
              <span>Report metadata</span>
              <span className="accordion-action">Details</span>
            </summary>
            <div className="accordion-body supporting-metadata">
              {reportPublished?.timestamp && <p>Report published: {formatDate(reportPublished.timestamp)} at {formatClockTime(reportPublished.timestamp)}</p>}
              {data.serviceRecordId && <p>Service record: {data.serviceRecordId}</p>}
              {serviceNotes && <p className="supporting-note">{serviceNotes}</p>}
              {findings.length > 0 && (
                <div className="sr-list">
                  {findings.map((finding) => (
                    <div className={`sr-row ${['high', 'critical'].includes(finding.severity) ? 'sr-finding-high' : ''}`} key={finding.id}>
                      <div>
                        <div className="sr-row-title">{finding.title}</div>
                        {(finding.detail || finding.recommendation) && (
                          <div className="sr-row-detail">
                            {finding.detail}
                            {finding.recommendation && (
                              <>
                                {finding.detail ? ' ' : ''}
                                <strong>Recommended next step:</strong> {finding.recommendation}
                              </>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="sr-pill">{formatEnumLabel(finding.severity)}</div>
                    </div>
                  ))}
                </div>
              )}
              {recommendations.map((rec) => (
                <div className="sr-row" key={rec}>
                  <div className="sr-row-title">{rec}</div>
                  <div className="sr-pill">Recommended next step</div>
                </div>
              ))}
              {!findings.length && !recommendations.length && <p>No activity was observed this visit. Routine protective service will continue on schedule.</p>}
            </div>
          </details>
        )}

        {showDetails && (advisoryRows.length > 0 || data.advisory?.pet_advisory) && (
          <details className="report-accordion">
            <summary>
              <span>Advisory details</span>
              <span className="accordion-action">Details</span>
            </summary>
            <div className="accordion-body">
              <div className="sr-advisory">
                {advisoryRows.map(([label, value]) => (
                  <div key={label}>
                    <strong>{value}</strong>
                    <span>{label}</span>
                  </div>
                ))}
              </div>
              {data.advisory?.pet_advisory && <p className="supporting-detail-copy">{data.advisory.pet_advisory}</p>}
            </div>
          </details>
        )}
      </div>
    </section>
  );
}

function overlayBox(geometry = {}) {
  if (geometry.type === 'circle') {
    const r = Number(geometry.r || 8);
    return {
      x: Number(geometry.cx || 0) - r,
      y: Number(geometry.cy || 0) - r,
      w: r * 2,
      h: r * 2,
    };
  }
  if (geometry.type === 'polygon' && Array.isArray(geometry.points) && geometry.points.length) {
    const xs = geometry.points.map((point) => Number(point[0]) || 0);
    const ys = geometry.points.map((point) => Number(point[1]) || 0);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return {
      x: minX,
      y: minY,
      w: Math.max(...xs) - minX,
      h: Math.max(...ys) - minY,
    };
  }
  return {
    x: Number(geometry.x || 0),
    y: Number(geometry.y || 0),
    w: Number(geometry.w || 0),
    h: Number(geometry.h || 0),
  };
}

function overlayCenter(geometry = {}) {
  if (geometry.type === 'circle') return { x: Number(geometry.cx || 0), y: Number(geometry.cy || 0) };
  const box = overlayBox(geometry);
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

function OverlayShape({ geometry, className = '', fill, children }) {
  if (geometry?.type === 'polygon' && Array.isArray(geometry.points) && geometry.points.length) {
    const points = geometry.points.map((point) => `${Number(point[0]) || 0},${Number(point[1]) || 0}`).join(' ');
    return <polygon points={points} className={className} fill={fill}>{children}</polygon>;
  }
  if (geometry?.type === 'circle') {
    return <circle cx={Number(geometry.cx || 0)} cy={Number(geometry.cy || 0)} r={Number(geometry.r || 8)} className={className} fill={fill}>{children}</circle>;
  }
  const box = overlayBox(geometry);
  return <rect x={box.x} y={box.y} width={box.w} height={box.h} className={className} fill={fill}>{children}</rect>;
}

function SatelliteTreatmentOverlay({ satellite, applicationRows = [], selectedApplicationId, onSelectApplication }) {
  const overlay = satellite?.overlay || {};
  const zones = overlay.zones || [];
  const zonesById = new Map(zones.map((zone) => [String(zone.id), zone]));
  const applications = overlay.applications || [];
  const rowById = new Map(applicationRows.map((row) => [String(row.id), row]));
  const zoneApplicationIds = new Map();
  applications.forEach((app) => {
    const appId = String(app.id);
    (app.zoneIds || []).forEach((zoneId) => {
      const key = String(zoneId);
      const ids = zoneApplicationIds.get(key) || [];
      ids.push(appId);
      zoneApplicationIds.set(key, ids);
    });
  });
  const flags = overlay.flags || [];
  let baitSequence = 1;

  const fillForMethod = (method, color) => {
    if (method === 'bait_placement') return 'none';
    return color || '#0f766e';
  };

  const handleSelect = (appId, event) => {
    event.stopPropagation();
    if (appId) onSelectApplication?.(String(appId), 'satellite');
  };

  const handleKeySelect = (appId, event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    handleSelect(appId, event);
  };

  return (
    <svg
      className="satellite-treatment-overlay"
      viewBox={`0 0 ${overlay.width || 640} ${overlay.height || 340}`}
      role="img"
      aria-label="Waves treatment overlays"
    >
      <defs>
        <pattern id="sat-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="8" className="sat-pattern-line" />
        </pattern>
        <pattern id="sat-wide-hatch" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="12" className="sat-pattern-line" />
        </pattern>
        <pattern id="sat-crosshatch" width="8" height="8" patternUnits="userSpaceOnUse">
          <path d="M0 8L8 0M0 0L8 8" className="sat-pattern-path" />
        </pattern>
        <pattern id="sat-dots" width="6" height="6" patternUnits="userSpaceOnUse">
          <circle cx="1.5" cy="1.5" r="0.8" className="sat-pattern-dot" />
        </pattern>
      </defs>
      <g className="satellite-zone-outlines">
        {zones.map((zone) => (
          <g key={zone.id}>
            <OverlayShape geometry={zone.geometry} className="satellite-zone-outline" />
            <text x={overlayBox(zone.geometry).x + 6} y={overlayBox(zone.geometry).y + 16} className="satellite-zone-label">
              {zone.letter}
            </text>
          </g>
        ))}
      </g>
      <g className="satellite-applications">
        {applications.map((app, fallbackIndex) => {
          const appId = String(app.id);
          const row = rowById.get(appId);
          const color = row?.color || TREATMENT_OVERLAY_COLORS[fallbackIndex % TREATMENT_OVERLAY_COLORS.length];
          const mapNumber = row?.mapNumber || String(fallbackIndex + 1);
          const appLabel = [
            row?.productName || app.productName || 'Product application',
            row?.methodLabel || app.methodLabel || formatEnumLabel(app.method),
            row?.zoneText,
          ].filter(Boolean).join(', ');
          const selected = String(selectedApplicationId || '') === appId;
          return (
            <g
              key={app.id}
              className={`app-layer satellite-application-hit${selected ? ' is-selected' : ''}`}
              data-application-id={app.id}
              data-product-name={app.productName}
              data-epa-reg={app.epaReg}
              role="button"
              tabIndex={0}
              aria-label={`Show ${appLabel}`}
              style={{ '--app-color': color }}
              onClick={(event) => handleSelect(appId, event)}
              onKeyDown={(event) => handleKeySelect(appId, event)}
            >
              <title>{appLabel}</title>
              {(app.zoneIds || []).map((zoneId) => {
              const zone = zonesById.get(String(zoneId));
              if (!zone) return null;
              const center = overlayCenter(zone.geometry);
              const zoneAppIds = zoneApplicationIds.get(String(zoneId)) || [];
              const zoneAppIndex = Math.max(0, zoneAppIds.indexOf(appId));
              const badgeY = center.y + (zoneAppIndex - ((zoneAppIds.length || 1) - 1) / 2) * 20;
              const badgeWidth = Math.max(22, 14 + mapNumber.length * 7);
              if (app.method === 'bait_placement') {
                const sequence = baitSequence++;
                return (
                  <g key={`${app.id}-${zoneId}`} className="satellite-bait-marker" data-marker-sequence={sequence}>
                    <circle cx={center.x} cy={badgeY} r="10" className="satellite-bait-circle" />
                    <text x={center.x} y={badgeY + 4} textAnchor="middle" className="satellite-bait-label">{mapNumber}</text>
                  </g>
                );
              }
              return (
                <g key={`${app.id}-${zoneId}`} data-zone-id={zoneId}>
                  <OverlayShape
                    geometry={zone.geometry}
                    className="satellite-application-overlay"
                    fill={fillForMethod(app.method, color)}
                  />
                  <g className="satellite-application-badge" transform={`translate(${center.x} ${badgeY})`}>
                    <rect x={-badgeWidth / 2} y="-10" width={badgeWidth} height="20" rx="10" />
                    <text x="0" y="4" textAnchor="middle">{mapNumber}</text>
                  </g>
                </g>
              );
              })}
            </g>
          );
        })}
      </g>
      <g className="satellite-flag-markers">
        {flags.map((flag) => {
          const zone = zonesById.get(String(flag.zoneId));
          if (!zone) return null;
          const center = overlayCenter(zone.geometry);
          return (
            <g key={`${flag.zoneId}-${flag.label}`} className="satellite-flag-marker">
              <circle cx={center.x} cy={center.y} r="9" className="satellite-flag-circle" />
              <text x={center.x} y={center.y + 4} textAnchor="middle" className="satellite-flag-mark">!</text>
              <text x={center.x + 13} y={center.y + 4} className="satellite-flag-label">{flag.label}</text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

function TreatmentOverlayKey({ rows = [], selectedRow, onSelect }) {
  if (!rows.length || !selectedRow) return null;
  const identifiers = [
    selectedRow.epaReg ? `EPA reg. ${selectedRow.epaReg}` : null,
    selectedRow.activeIngredient ? `Active ingredient: ${selectedRow.activeIngredient}` : null,
    ...(selectedRow.rateDetails || []),
  ].filter(Boolean);
  return (
    <div className="treatment-overlay-key">
      <div className="treatment-overlay-list" aria-label="Treatment overlay key">
        {rows.map((row) => (
          <button
            type="button"
            key={row.id}
            className={`treatment-overlay-row${row.id === selectedRow.id ? ' is-active' : ''}`}
            style={{ '--app-color': row.color }}
            aria-pressed={row.id === selectedRow.id}
            onClick={() => onSelect?.(row.id, 'overlay_key')}
          >
            <span className="treatment-overlay-number">{row.mapNumber}</span>
            <span className="treatment-overlay-row-copy">
              <strong>{row.productName}</strong>
              <span>{row.methodLabel} · {row.zoneText}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="treatment-overlay-detail" aria-live="polite">
        <div className="sr-cell-label">Selected treatment</div>
        <h3>{selectedRow.productName}</h3>
        <p>{selectedRow.customerDetail}</p>
        <div className="treatment-overlay-meta">
          <span>{selectedRow.purpose}</span>
          <span>{selectedRow.methodLabel}</span>
          <span>{selectedRow.zoneText}</span>
          {selectedRow.targetText && <span>Targets: {selectedRow.targetText}</span>}
          {identifiers.map((detail) => <span key={detail}>{detail}</span>)}
        </div>
      </div>
    </div>
  );
}

function TreatmentMapSection({ data, mode, token, showTapPrompt = false }) {
  const satellite = data.treatmentMap?.satellite;
  const canShowSatellite = mode === 'live' && satellite?.available && satellite.live?.url;
  const [view, setView] = useState(canShowSatellite ? 'satellite' : 'schematic');
  const overlayRows = useMemo(() => buildTreatmentOverlayRows(data), [data]);
  const [selectedAppId, setSelectedAppId] = useState('');

  useEffect(() => {
    if (!canShowSatellite && view !== 'schematic') setView('schematic');
  }, [canShowSatellite, view]);

  useEffect(() => {
    if (!overlayRows.length) {
      if (selectedAppId) setSelectedAppId('');
      return;
    }
    if (!overlayRows.some((row) => row.id === selectedAppId)) {
      setSelectedAppId(overlayRows[0].id);
    }
  }, [overlayRows, selectedAppId]);

  if (!data.mapSvg) return null;
  const activeView = canShowSatellite && view === 'satellite' ? 'satellite' : 'schematic';
  const selectedRow = overlayRows.find((row) => row.id === selectedAppId) || overlayRows[0] || null;
  const description = activeView === 'satellite'
    ? 'Aerial view with product overlays. Service zones are approximate.'
    : 'Schematic view of product overlays and treated zones. Service zones are approximate.';
  const selectApplication = (applicationId, source) => {
    if (!applicationId) return;
    const id = String(applicationId);
    setSelectedAppId(id);
    trackReportEvent(token, 'map_interacted', { view: source, application_id: id });
  };
  const handleSchematicClick = (event) => {
    const appLayer = event.target?.closest?.('.app-layer');
    if (appLayer?.dataset?.applicationId) {
      selectApplication(appLayer.dataset.applicationId, 'schematic');
      return;
    }
    trackReportEvent(token, 'map_interacted', { view: 'schematic' });
  };

  return (
    <section className="sr-section treatment-map-section">
      <div className="treatment-map-header">
        <div>
          <h2>Where we treated today</h2>
          <p className="map-context-copy">{description}</p>
          {showTapPrompt && overlayRows.length > 0 && <p className="map-tap-prompt">Product numbers on the map match the treatment key below.</p>}
        </div>
        {canShowSatellite && (
          <div className="map-toggle" aria-label="Treatment map view">
            <button type="button" className={activeView === 'satellite' ? 'is-active' : ''} onClick={() => setView('satellite')}>Satellite</button>
            <button type="button" className={activeView === 'schematic' ? 'is-active' : ''} onClick={() => setView('schematic')}>Schematic</button>
          </div>
        )}
      </div>

      {activeView === 'satellite' ? (
        <div className="satellite-treatment-map" onClick={() => trackReportEvent(token, 'map_interacted', { view: 'satellite' })}>
          <img src={satellite.live.url} alt="" className="satellite-basemap-image" />
          <SatelliteTreatmentOverlay
            satellite={satellite}
            applicationRows={overlayRows}
            selectedApplicationId={selectedRow?.id}
            onSelectApplication={selectApplication}
          />
          {satellite.attributionText && <div className="map-attribution">{satellite.attributionText}</div>}
        </div>
      ) : (
        <div
          className="sr-map"
          onClick={handleSchematicClick}
          dangerouslySetInnerHTML={{ __html: data.mapSvg }}
        />
      )}
      <TreatmentOverlayKey rows={overlayRows} selectedRow={selectedRow} onSelect={selectApplication} />
      <p className="map-footnote">{data.treatmentMap?.footer || 'Treatment areas are technician-reported service zones, not survey boundaries.'}</p>
    </section>
  );
}

function SmsReportPreview({ data }) {
  const dynamicContext = data.dynamicContext || {};
  const aiSummary = dynamicContext.aiSummary;
  const isLawn = data.serviceLine === 'lawn' && data.lawnAssessment?.scores;
  const actionText = aiSummary?.recommendedNextStep?.text || recommendedFinding(data.findings || [])?.recommendation;
  const headline = isLawn
    ? (data.lawnAssessment.customerSummary || 'Lawn assessment is complete.')
    : (aiSummary?.headline || 'Service is complete.');
  const body = isLawn ? lawnAssessmentBody(data.lawnAssessment) : aiSummary?.body;
  return (
    <div className="sms-preview-page">
      <style>{`
        .sms-preview-page {
          width: 1200px;
          min-height: 1500px;
          background: #f7f7f7;
          color: #171717;
          font-family: Inter, Arial, sans-serif;
          padding: 72px;
          box-sizing: border-box;
        }
        .sms-preview-card {
          background: #fff;
          border: .5px solid #d4d4d4;
          border-radius: 8px;
          padding: 56px;
          min-height: 1356px;
          box-sizing: border-box;
          display: flex;
          flex-direction: column;
          gap: 36px;
        }
        .sms-preview-header {
          display: flex;
          align-items: center;
          gap: 18px;
          border-bottom: .5px solid #d4d4d4;
          padding-bottom: 28px;
        }
        .sms-preview-header img { height: 54px; }
        .sms-preview-kicker,
        .sms-preview-eyebrow {
          color: #525252;
          font-size: 24px;
          line-height: 1.2;
        }
        .sms-preview-date {
          margin-top: 8px;
          font-size: 28px;
        }
        .sms-preview-ai-summary h1 {
          margin: 14px 0 18px;
          font-size: 58px;
          line-height: 1.04;
          font-weight: 500;
          letter-spacing: 0;
        }
        .sms-preview-ai-summary p,
        .sms-preview-action p {
          margin: 0;
          color: #404040;
          font-size: 34px;
          line-height: 1.35;
        }
        .sms-preview-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 18px;
        }
        .sms-preview-tile,
        .sms-preview-action {
          border: .5px solid #d4d4d4;
          border-radius: 8px;
          padding: 28px;
        }
        .sms-preview-tile strong {
          display: block;
          margin-top: 14px;
          font-size: 34px;
          line-height: 1.2;
          font-weight: 500;
        }
        .sms-preview-tile span {
          display: block;
          margin-top: 12px;
          color: #525252;
          font-size: 24px;
        }
        .sms-preview-footer {
          margin-top: auto;
          border-top: .5px solid #d4d4d4;
          padding-top: 28px;
          color: #525252;
          font-size: 26px;
        }
      `}</style>
      <div className="sms-preview-card">
        <div className="sms-preview-header">
          <img src="/waves-logo.png" alt="" />
          <div>
            <div className="sms-preview-kicker">Waves service report</div>
            <div className="sms-preview-date">{formatDate(data.serviceDate)}</div>
          </div>
        </div>
        <div className="sms-preview-ai-summary">
          <div className="sms-preview-eyebrow">Waves AI summary</div>
          <h1>{headline}</h1>
          {body && <p>{body}</p>}
        </div>
        <div className="sms-preview-grid">
          <div className="sms-preview-tile">
            <div className="sms-preview-eyebrow">{isLawn ? 'Lawn health' : 'Pressure trend'}</div>
            <strong>
              {isLawn
                ? `${data.lawnAssessment.scores.overallScore ?? '-'}% overall`
                : dynamicContext.pressureTrend?.customerSummary || `${formatPressureIndex(data.pressureIndex)} pressure index`}
            </strong>
            <span>{isLawn ? 'Higher is better' : 'Lower is better'}</span>
          </div>
          <div className="sms-preview-tile">
            <div className="sms-preview-eyebrow">Ready to re-enter</div>
            <strong>{dynamicContext.reentry?.customerSummary || 'See report'}</strong>
          </div>
        </div>
        {actionText && (
          <div className="sms-preview-action">
            <div className="sms-preview-eyebrow">Recommended next step</div>
            <p>{actionText}</p>
          </div>
        )}
        <div className="sms-preview-footer">View full report from the link in this text.</div>
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#fafafa', fontFamily: FONTS.body }}>
      <div style={{ fontSize: 14, color: '#525252' }}>Loading report...</div>
    </div>
  );
}

function NotFoundState() {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#fafafa', padding: 20, fontFamily: FONTS.body }}>
      <div style={{ background: '#fff', borderRadius: 8, border: '0.5px solid #d4d4d4', padding: 28, maxWidth: 400, textAlign: 'center' }}>
        <div style={{ fontSize: 18, fontWeight: 600, color: '#171717' }}>Report not found</div>
        <a href="tel:+19412975749" style={{ ...actionButtonStyle('primary'), marginTop: 16 }}>Call (941) 297-5749</a>
      </div>
    </div>
  );
}

function LegacyReport({ data, token }) {
  const pdfUrl = `${API_BASE}/reports/${token}`;
  return (
    <div style={{ minHeight: '100vh', background: B.offWhite, fontFamily: FONTS.body }}>
      <div style={{ background: '#111111', padding: '14px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <img src="/waves-logo.png" alt="Waves" style={{ height: 28 }} />
          <div style={{ minWidth: 0 }}>
            <h1 style={{ fontSize: 20, color: '#fff', lineHeight: 1, margin: 0 }}>Service report</h1>
            <div style={{ fontSize: 12, color: '#d4d4d4', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{data.customerName}</div>
          </div>
        </div>
        <a href={pdfUrl} download style={actionButtonStyle('primary')}><Download size={16} /> Download PDF</a>
      </div>
      <main style={{ maxWidth: 720, margin: '16px auto', padding: '0 16px 32px' }}>
        <section style={{ background: '#fff', borderRadius: 8, padding: 20, border: '0.5px solid #d4d4d4' }}>
          <div style={{ fontSize: 18, fontWeight: 600, color: '#171717' }}>{data.serviceType}</div>
          <div style={{ fontSize: 14, color: '#525252', marginTop: 4 }}>{formatDate(data.serviceDate)} | {data.technicianName}</div>
          {data.notes && <p style={{ fontSize: 15, color: '#404040', lineHeight: 1.6, marginTop: 16, whiteSpace: 'pre-wrap' }}>{data.notes}</p>}
        </section>
        <div style={{ marginTop: 16, borderRadius: 8, overflow: 'hidden', border: '0.5px solid #d4d4d4' }}>
          <iframe src={pdfUrl} style={{ width: '100%', height: 620, border: 'none' }} title="Service report PDF" />
        </div>
      </main>
    </div>
  );
}

function ServiceReportV1({ data, token, mode = 'live' }) {
  const pdfUrl = data.pdfUrl ? `${API_BASE}${data.pdfUrl.replace(/^\/api/, '')}` : null;
  const reportUrl = typeof window !== 'undefined' ? `${window.location.origin}/report/${token}` : `/report/${token}`;
  const serviceNotes = String(data.legacy?.notes || '').trim();
  const visitSummary = String(data.summary || '').trim();
  const serviceAreas = Array.isArray(data.serviceAreas) ? data.serviceAreas.filter(Boolean) : [];
  const findings = Array.isArray(data.findings) ? data.findings : [];
  const recommendations = Array.isArray(data.recommendations) ? data.recommendations : [];
  const visitTimingRows = [
    ['Arrival', formatClockTime(data.visitTiming?.arrivedAt)],
    ['Exit', formatClockTime(data.visitTiming?.exitedAt)],
  ].filter(([, value]) => value);
  const measurements = data.measurements || data.legacy?.measurements || {};
  const measurementRows = [
    ['Soil temp', measurements.soilTemp, '°F'],
    ['Thatch', measurements.thatch, '"'],
    ['Soil pH', measurements.soilPh, ''],
    ['Moisture', measurements.moisture, '%'],
  ].filter(([, value]) => value != null && value !== '');
  const hasVisitSummary = Boolean(
    visitSummary ||
    serviceAreas.length ||
    visitTimingRows.length ||
    measurementRows.length,
  );
  const dynamicContext = data.dynamicContext || {};
  const premium = dynamicContext.premiumExperience || {};
  const isLawnReport = data.serviceLine === 'lawn' && data.lawnAssessment?.scores;
  const heroSummary = dynamicHeroSummary(data);
  const hasApplications = Array.isArray(data.applications) && data.applications.length > 0;

  useEffect(() => {
    if (mode !== 'live') return;
    trackReportEvent(token, 'service_report_viewed');
  }, [mode, token]);

  const showDetails = mode !== 'live';
  const advisoryRows = advisoryDisplayRows(data.advisory || {});

  const share = async () => {
    if (navigator.share) {
      await navigator.share({ title: 'Waves service report', url: reportUrl });
      trackReportEvent(token, 'share_link_copied', { method: 'native_share' });
      return;
    }
    await navigator.clipboard?.writeText(reportUrl);
    trackReportEvent(token, 'share_link_copied', { method: 'clipboard' });
  };

  if (mode === 'sms_preview') return <SmsReportPreview data={data} />;

  return (
    <div className="service-report-v1">
      <style>{`
        .service-report-v1 {
          --text: ${B.blueDeeper};
          --muted: #64748B;
          --soft: #64748B;
          --line: #E1E7EF;
          --line-strong: #CBD5E1;
          --paper: #ffffff;
          --wash: #F8FAFC;
          --soft-blue: #EEF6FF;
          --soft-blue-border: #CDEAFE;
          --page: #F8FAFC;
          --red: ${B.red};
          --report-text: var(--text);
          --report-muted: var(--muted);
          --report-border: var(--line);
          --report-action: var(--red);
          --report-surface: var(--paper);
          --shadow-soft: 0 1px 2px rgba(15,23,42,0.04);
          min-height: 100vh;
          background: var(--page);
          color: var(--text);
          font-family: ${FONTS.body};
        }
        .sr-top {
          position: relative;
          z-index: 2;
          background: #fff;
          border-bottom: 1px solid var(--line);
          color: var(--text);
          box-shadow: var(--shadow-soft);
        }
        .sr-top-inner {
          max-width: 1120px;
          margin: 0 auto;
          min-height: 72px;
          padding: 12px 20px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          box-sizing: border-box;
        }
        .sr-brand-lockup {
          display: flex;
          align-items: center;
          gap: 10px;
          min-width: 0;
        }
        .sr-brand-logo {
          height: 30px;
          flex: 0 0 auto;
        }
        .sr-brand-title {
          font-family: ${FONTS.heading};
          font-size: 16px;
          font-weight: 850;
          color: var(--text);
          line-height: 1.1;
          letter-spacing: 0;
        }
        .sr-brand-subtitle {
          margin-top: 3px;
          font-size: 12px;
          color: var(--muted);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .sr-shell {
          max-width: 1040px;
          margin: 0 auto;
          padding: 18px 20px 56px;
          box-sizing: border-box;
        }
        .sr-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
        .sr-hero {
          display: block;
          padding: 24px;
          background: var(--paper);
          border: 1px solid var(--line);
          border-radius: 8px;
          box-shadow: var(--shadow-soft);
        }
        .sr-title {
          margin: 0;
          color: var(--text);
          font-family: ${FONTS.heading};
          font-size: clamp(28px, 4vw, 34px);
          line-height: 1.1;
          font-weight: 850;
          letter-spacing: 0;
        }
        .sr-meta {
          margin-top: 14px;
          color: var(--muted);
          font-size: 15px;
          line-height: 1.55;
        }
        .service-meta-address {
          margin-top: 4px;
          color: var(--text);
          font-size: 15px;
          line-height: 1.45;
          font-weight: 650;
        }
        .tech-visit-line {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-top: 16px;
          padding: 12px 14px;
          border: 1px solid var(--line);
          border-radius: 12px;
          background: var(--wash);
          max-width: 820px;
        }
        .tech-photo {
          width: 54px;
          height: 54px;
          border-radius: 999px;
          object-fit: cover;
          border: 2px solid #fff;
          flex: 0 0 auto;
        }
        .tech-photo-fallback {
          display: flex;
          align-items: center;
          justify-content: center;
          background: ${B.blueDeeper};
          color: #fff;
          font-family: ${FONTS.heading};
          font-size: 18px;
          font-weight: 800;
        }
        .tech-name {
          color: var(--text);
          font-size: 16px;
          line-height: 1.25;
          font-weight: 800;
        }
        .tech-role {
          margin-top: 4px;
          color: var(--muted);
          font-size: 14px;
          line-height: 1.35;
        }
        .tech-visit-times {
          margin-top: 3px;
          color: var(--text);
          font-size: 13px;
          line-height: 1.35;
          font-weight: 650;
        }
        .hero-conditions {
          margin-top: 12px;
          padding: 12px 14px 14px;
          border: 1px solid var(--line);
          border-radius: 12px;
          background: #fff;
          max-width: 820px;
        }
        .hero-conditions-copy {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 14px;
          margin-bottom: 10px;
        }
        .hero-conditions-copy .section-eyebrow {
          margin-bottom: 0;
          flex: 0 0 auto;
        }
        .weather-call-title {
          display: flex;
          align-items: center;
          gap: 10px;
          flex: 0 0 auto;
          min-width: 176px;
        }
        .weather-call-icon {
          width: 34px;
          height: 34px;
          border: 1px solid var(--line);
          border-radius: 999px;
          background: var(--wash);
          color: var(--text);
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex: 0 0 auto;
        }
        .weather-call-icon-label {
          margin-top: 3px;
          color: var(--muted);
          font-size: 12px;
          line-height: 1.2;
        }
        .hero-conditions-copy p {
          margin: 0;
          color: var(--muted);
          font-size: 13px;
          line-height: 1.45;
          text-align: right;
        }
        .hero-condition-row {
          display: grid;
          grid-template-columns: repeat(6, minmax(92px, 1fr));
          gap: 1px;
          overflow: hidden;
          border: 1px solid var(--line);
          border-radius: 10px;
          background: var(--line);
        }
        .hero-condition-cell {
          min-height: 62px;
          padding: 10px;
          background: var(--wash);
        }
        .sr-hero-summary {
          margin: 14px 0 0;
          color: var(--text);
          font-size: 16px;
          line-height: 1.5;
          max-width: 620px;
        }
        .service-status-card {
          margin-top: 0;
        }
        .service-status-main,
        .readiness-card-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 16px;
        }
        .status-badge,
        .readiness-status-chip {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-height: 34px;
          border: 1px solid #86efac;
          border-radius: 999px;
          background: #dcfce7;
          color: #14532d;
          font-size: 12px;
          line-height: 1;
          font-weight: 850;
          white-space: nowrap;
          padding: 8px 11px;
        }
        .status-badge.status-pending {
          border-color: #cbd5e1;
          background: #f8fafc;
          color: #475569;
        }
        .service-status-grid,
        .readiness-facts,
        .supporting-detail-grid {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 1px;
          margin-top: 16px;
          overflow: hidden;
          border: 1px solid var(--line);
          border-radius: 12px;
          background: var(--line);
        }
        .readiness-facts,
        .supporting-detail-grid {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
        .readiness-card {
          border-color: #bbf7d0;
          background: #f0fdf4;
        }
        .readiness-card h2 {
          margin-bottom: 8px;
        }
        .readiness-card p,
        .visit-summary-section p,
        .what-to-expect-section p,
        .contact-waves-section p,
        .supporting-detail-copy {
          margin: 0;
          color: var(--text);
          font-size: 16px;
          line-height: 1.55;
        }
        .quick-report-tools .report-ask-box {
          max-width: none;
        }
        .quick-nav-row {
          display: flex;
          gap: 8px;
          overflow-x: auto;
          padding-bottom: 2px;
          scrollbar-width: thin;
        }
        .quick-nav-row a {
          flex: 0 0 auto;
          border: 1px solid var(--line);
          border-radius: 999px;
          background: #fff;
          color: var(--text);
          font-size: 13px;
          line-height: 1;
          font-weight: 800;
          text-decoration: none;
          padding: 9px 11px;
        }
        .timeline-note {
          margin: 12px 0 0;
          color: var(--muted);
          font-size: 13px;
          line-height: 1.45;
        }
        .areas-serviced-list {
          display: grid;
          gap: 8px;
        }
        .sr-pressure {
          justify-self: end;
          background: var(--paper);
          border: .5px solid var(--line);
          border-radius: 8px;
          padding: 18px;
          min-width: 220px;
        }
        .sr-pressure-value { font-size: 44px; line-height: 1; font-weight: 500; }
        .sr-pressure-label { margin-top: 6px; font-size: 13px; color: var(--muted); }
        .sr-band {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 1px;
          margin: 16px 0 0;
          border: 1px solid var(--line);
          background: var(--line);
          border-radius: 16px;
          overflow: hidden;
        }
        .sr-metric { background: var(--paper); padding: 16px; min-height: 86px; }
        .sr-metric-value { color: var(--text); font-size: 26px; line-height: 1; font-weight: 650; }
        .sr-metric-label { margin-top: 10px; font-size: 13px; color: var(--muted); }
        .sr-section {
          background: var(--paper);
          border: 1px solid var(--line);
          border-radius: 16px;
          padding: 20px;
          margin-top: 16px;
          break-inside: avoid;
        }
        .sr-section h2 {
          margin: 0 0 16px;
          color: var(--text);
          font-size: 21px;
          line-height: 1.2;
          font-weight: 650;
          letter-spacing: 0;
        }
        .sr-map {
          width: 100%;
          overflow: hidden;
          border: 1px solid var(--line);
          border-radius: 10px;
          background: #fff;
        }
        .sr-map svg { display: block; width: 100%; height: auto; }
        .treatment-map-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 16px;
          margin-bottom: 14px;
        }
        .treatment-map-header h2 {
          margin-bottom: 6px;
        }
        .map-context-copy,
        .map-footnote {
          margin: 0;
          color: var(--muted);
          font-size: 13px;
          line-height: 1.45;
        }
        .map-footnote {
          margin-top: 10px;
        }
        .coverage-section-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 16px;
          margin-bottom: 14px;
        }
        .coverage-section-header h2 {
          margin-bottom: 6px;
        }
        .coverage-map-meta {
          display: grid;
          gap: 4px;
          justify-items: end;
          color: var(--muted);
          font-size: 12px;
          line-height: 1.35;
          text-align: right;
          max-width: 220px;
        }
        .service-coverage-map {
          position: relative;
          overflow: hidden;
          border: 1px solid var(--line);
          border-radius: 12px;
          background: #eef2f1;
          aspect-ratio: 32 / 17;
        }
        .service-coverage-map.has-map-image {
          background-image: linear-gradient(rgba(255,255,255,.14), rgba(255,255,255,.22)), var(--coverage-map-image);
          background-size: cover;
          background-position: center;
        }
        .coverage-map-svg {
          display: block;
          width: 100%;
          height: 100%;
        }
        .coverage-map-base {
          fill: url(#coverage-grid);
        }
        .service-coverage-map.has-map-image .coverage-map-base {
          fill: rgba(255,255,255,.10);
        }
        .coverage-grid-line {
          fill: none;
          stroke: rgba(43, 75, 88, .13);
          stroke-width: .7;
        }
        .coverage-map-lot {
          fill: rgba(255,255,255,.72);
          stroke: rgba(43,75,88,.20);
          stroke-width: 1;
        }
        .coverage-map-structure {
          fill: rgba(255,255,255,.86);
          stroke: rgba(43,75,88,.34);
          stroke-width: 1;
        }
        .coverage-map-drive {
          fill: none;
          stroke: rgba(43,75,88,.22);
          stroke-width: 24;
          stroke-linecap: round;
        }
        .coverage-area,
        .coverage-line,
        .coverage-marker-outer,
        .coverage-marker-inner {
          vector-effect: non-scaling-stroke;
        }
        .coverage-area {
          stroke-width: 2;
          fill-opacity: .38;
          stroke-opacity: .95;
        }
        .coverage-area.status-green,
        .coverage-marker.status-green .coverage-marker-inner {
          fill: #16a34a;
          stroke: #14532d;
        }
        .coverage-area.status-light-green,
        .coverage-area.status-partially_treated {
          fill: url(#coverage-partial-pattern);
          stroke: #15803d;
        }
        .coverage-area.status-blue,
        .coverage-marker.status-blue .coverage-marker-inner {
          fill: #2563eb;
          stroke: #1e3a8a;
        }
        .coverage-area.status-orange,
        .coverage-marker.status-orange .coverage-marker-inner {
          fill: #f59e0b;
          stroke: #92400e;
        }
        .coverage-area.status-red,
        .coverage-marker.status-red .coverage-marker-inner {
          fill: #dc2626;
          stroke: #7f1d1d;
        }
        .coverage-area.status-gray,
        .coverage-marker.status-gray .coverage-marker-inner {
          fill: #94a3b8;
          stroke: #475569;
        }
        .coverage-partial-bg {
          fill: rgba(22,163,74,.28);
        }
        .coverage-partial-line {
          stroke: #14532d;
          stroke-width: 2;
          opacity: .65;
        }
        .coverage-line {
          fill: none;
          stroke-width: 7;
          stroke-linecap: round;
          stroke-linejoin: round;
          opacity: .92;
        }
        .coverage-line.status-green { stroke: #16a34a; }
        .coverage-line.status-light-green { stroke: #65a30d; stroke-dasharray: 12 8; }
        .coverage-line.status-blue { stroke: #2563eb; stroke-dasharray: 7 7; }
        .coverage-line.status-orange { stroke: #f59e0b; stroke-dasharray: 10 8; }
        .coverage-line.status-red { stroke: #dc2626; stroke-dasharray: 7 6; }
        .coverage-line.status-gray { stroke: #94a3b8; stroke-dasharray: 8 8; }
        .coverage-geometry-group:focus,
        .coverage-marker:focus {
          outline: none;
        }
        .coverage-geometry-group:focus .coverage-area,
        .coverage-geometry-group:focus .coverage-line,
        .coverage-marker:focus .coverage-marker-outer {
          stroke: #111827;
          stroke-width: 3;
        }
        .coverage-marker-outer {
          fill: rgba(255,255,255,.94);
          stroke: rgba(15,23,42,.28);
          stroke-width: 1.2;
        }
        .coverage-marker-inner {
          stroke-width: 1.5;
        }
        .coverage-marker-text {
          fill: #fff;
          font-family: Inter, Arial, sans-serif;
          font-size: 7px;
          font-weight: 850;
          letter-spacing: 0;
        }
        .coverage-map-label {
          fill: #111827;
          font-family: Inter, Arial, sans-serif;
          font-size: 12px;
          font-weight: 750;
          letter-spacing: 0;
          paint-order: stroke;
          stroke: rgba(255,255,255,.92);
          stroke-width: 4px;
          stroke-linejoin: round;
          pointer-events: none;
        }
        .coverage-point-label {
          text-anchor: start;
        }
        .coverage-legend {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-top: 12px;
        }
        .coverage-legend-item,
        .coverage-status-chip {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          border: 1px solid var(--line);
          border-radius: 999px;
          background: #fff;
          color: var(--text);
          font-size: 12px;
          line-height: 1;
          font-weight: 750;
          white-space: nowrap;
        }
        .coverage-legend-item {
          min-height: 30px;
          padding: 6px 9px;
        }
        .coverage-status-chip {
          align-self: center;
          padding: 7px 9px;
          flex: 0 0 auto;
        }
        .coverage-legend-swatch {
          width: 18px;
          height: 18px;
          border-radius: 999px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          color: #fff;
        }
        .coverage-legend-item.status-green .coverage-legend-swatch,
        .coverage-status-chip.status-green { background: #dcfce7; border-color: #86efac; color: #14532d; }
        .coverage-legend-item.status-green .coverage-legend-swatch { background: #16a34a; color: #fff; }
        .coverage-legend-item.status-light-green .coverage-legend-swatch,
        .coverage-status-chip.status-light-green { background: #ecfccb; border-color: #bef264; color: #365314; }
        .coverage-legend-item.status-light-green .coverage-legend-swatch { background: #65a30d; color: #fff; }
        .coverage-legend-item.status-blue .coverage-legend-swatch,
        .coverage-status-chip.status-blue { background: #dbeafe; border-color: #93c5fd; color: #1e3a8a; }
        .coverage-legend-item.status-blue .coverage-legend-swatch { background: #2563eb; color: #fff; }
        .coverage-legend-item.status-orange .coverage-legend-swatch,
        .coverage-status-chip.status-orange { background: #ffedd5; border-color: #fdba74; color: #7c2d12; }
        .coverage-legend-item.status-orange .coverage-legend-swatch { background: #f59e0b; color: #fff; }
        .coverage-legend-item.status-red .coverage-legend-swatch,
        .coverage-status-chip.status-red { background: #fee2e2; border-color: #fca5a5; color: #7f1d1d; }
        .coverage-legend-item.status-red .coverage-legend-swatch { background: #dc2626; color: #fff; }
        .coverage-legend-item.status-gray .coverage-legend-swatch,
        .coverage-status-chip.status-gray { background: #f1f5f9; border-color: #cbd5e1; color: #334155; }
        .coverage-legend-item.status-gray .coverage-legend-swatch { background: #64748b; color: #fff; }
        .coverage-summary-list {
          display: grid;
          gap: 8px;
          margin-top: 12px;
        }
        .coverage-summary-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          border: 1px solid var(--line);
          border-radius: 10px;
          background: #fff;
          padding: 11px 12px;
        }
        .coverage-summary-row h3 {
          margin: 0;
          color: var(--text);
          font-size: 15px;
          line-height: 1.25;
          font-weight: 800;
          letter-spacing: 0;
        }
        .coverage-summary-row p,
        .coverage-evidence-note {
          margin: 4px 0 0;
          color: var(--muted);
          font-size: 13px;
          line-height: 1.45;
        }
        .coverage-evidence-note {
          margin-top: 12px;
        }
        .coverage-empty-state {
          border: 1px dashed var(--line);
          border-radius: 12px;
          background: var(--wash);
          color: var(--muted);
          padding: 16px;
          font-size: 14px;
          line-height: 1.45;
        }
        .coverage-empty-state-map {
          min-height: 210px;
          display: flex;
          align-items: center;
          justify-content: center;
          text-align: center;
        }
        .service-workflow-timeline {
          list-style: none;
          margin: 0;
          padding: 0;
          display: grid;
          gap: 0;
        }
        .workflow-event {
          display: grid;
          grid-template-columns: 34px minmax(0, 1fr);
          gap: 12px;
          position: relative;
          padding: 0 0 16px;
        }
        .workflow-event:last-child {
          padding-bottom: 0;
        }
        .workflow-event:not(:last-child)::before {
          content: '';
          position: absolute;
          left: 16px;
          top: 34px;
          bottom: 0;
          width: 2px;
          background: var(--line);
        }
        .workflow-event-icon {
          width: 34px;
          height: 34px;
          border-radius: 999px;
          border: 1px solid #bbf7d0;
          background: #dcfce7;
          color: #14532d;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          z-index: 1;
        }
        .workflow-status-pending .workflow-event-icon {
          border-color: #cbd5e1;
          background: #f8fafc;
          color: #475569;
        }
        .workflow-status-current .workflow-event-icon {
          border-color: #93c5fd;
          background: #dbeafe;
          color: #1e3a8a;
        }
        .workflow-status-skipped .workflow-event-icon {
          border-color: #fdba74;
          background: #ffedd5;
          color: #7c2d12;
        }
        .workflow-event-body {
          min-width: 0;
          border: 1px solid var(--line);
          border-radius: 10px;
          background: #fff;
          padding: 11px 12px;
        }
        .workflow-event-heading {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 10px;
        }
        .workflow-event-heading h3 {
          margin: 0;
          color: var(--text);
          font-size: 15px;
          line-height: 1.25;
          font-weight: 800;
          letter-spacing: 0;
        }
        .workflow-event-heading time {
          color: var(--muted);
          font-size: 13px;
          line-height: 1.3;
          white-space: nowrap;
        }
        .workflow-event-body p {
          margin: 5px 0 0;
          color: var(--muted);
          font-size: 13px;
          line-height: 1.45;
        }
        .coverage-skeleton-map,
        .coverage-skeleton-list span,
        .workflow-skeleton-list span {
          display: block;
          border-radius: 10px;
          background: linear-gradient(90deg, #eef2f7, #f8fafc, #eef2f7);
          background-size: 200% 100%;
          animation: report-skeleton 1.2s ease-in-out infinite;
        }
        .coverage-skeleton-map {
          height: 280px;
          margin-top: 12px;
        }
        .coverage-skeleton-list,
        .workflow-skeleton-list {
          display: grid;
          gap: 8px;
          margin-top: 12px;
        }
        .coverage-skeleton-list span,
        .workflow-skeleton-list span {
          height: 48px;
        }
        @keyframes report-skeleton {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        .map-toggle {
          display: inline-flex;
          border: 1px solid var(--line);
          border-radius: 10px;
          overflow: hidden;
          background: #fff;
          flex: 0 0 auto;
        }
        .map-toggle button {
          border: 0;
          border-left: 1px solid var(--line);
          background: #fff;
          color: var(--muted);
          font: inherit;
          font-size: 13px;
          padding: 8px 11px;
          cursor: pointer;
        }
        .map-toggle button:first-child { border-left: 0; }
        .map-toggle button.is-active {
          background: ${B.blueDark};
          color: #fff;
        }
        .satellite-treatment-map {
          position: relative;
          overflow: hidden;
          border: 1px solid var(--line);
          border-radius: 10px;
          background: #111;
          aspect-ratio: 640 / 340;
        }
        .satellite-basemap-image,
        .satellite-treatment-overlay {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
        }
        .satellite-basemap-image {
          object-fit: cover;
          filter: grayscale(100%) contrast(.88) brightness(1.1);
          pointer-events: none;
        }
        .satellite-treatment-overlay {
          pointer-events: auto;
        }
        .satellite-application-hit {
          cursor: pointer;
          outline: none;
        }
        .satellite-zone-outline {
          fill: rgba(255,255,255,.16);
          stroke: #111;
          stroke-width: .9;
          stroke-dasharray: 4 4;
          vector-effect: non-scaling-stroke;
        }
        .satellite-zone-label,
        .satellite-bait-label,
        .satellite-flag-mark,
        .satellite-flag-label {
          font-family: Inter, Arial, sans-serif;
          letter-spacing: 0;
        }
        .satellite-zone-label {
          fill: #111;
          font-size: 11px;
          font-weight: 600;
          paint-order: stroke;
          stroke: rgba(255,255,255,.9);
          stroke-width: 3px;
        }
        .satellite-application-overlay {
          fill-opacity: .34;
          stroke: var(--app-color, #111);
          stroke-width: 1.1;
          vector-effect: non-scaling-stroke;
        }
        .satellite-application-hit.is-selected .satellite-application-overlay,
        .satellite-application-hit:focus .satellite-application-overlay {
          fill-opacity: .5;
          stroke-width: 2;
        }
        .satellite-application-badge rect {
          fill: var(--app-color, #111);
          stroke: rgba(255,255,255,.92);
          stroke-width: 1.2;
          vector-effect: non-scaling-stroke;
        }
        .satellite-application-badge text {
          fill: #fff;
          font-family: Inter, Arial, sans-serif;
          font-size: 10px;
          font-weight: 800;
          letter-spacing: 0;
        }
        .sat-pattern-line,
        .sat-pattern-path {
          stroke: #111;
          stroke-width: .8;
        }
        .sat-pattern-path {
          fill: none;
        }
        .sat-pattern-dot {
          fill: #111;
        }
        .satellite-bait-circle {
          fill: var(--app-color, #fff);
          stroke: rgba(255,255,255,.92);
          stroke-width: 1.2;
          vector-effect: non-scaling-stroke;
        }
        .satellite-bait-label {
          fill: #fff;
          font-size: 10px;
          font-weight: 800;
        }
        .satellite-flag-circle {
          fill: var(--red);
        }
        .satellite-flag-mark {
          fill: #fff;
          font-size: 12px;
          font-weight: 700;
        }
        .satellite-flag-label {
          fill: var(--red);
          font-size: 11px;
          font-weight: 600;
          paint-order: stroke;
          stroke: rgba(255,255,255,.92);
          stroke-width: 3px;
        }
        .map-attribution {
          position: absolute;
          right: 8px;
          bottom: 6px;
          z-index: 2;
          background: rgba(255,255,255,.86);
          color: #404040;
          border: .5px solid rgba(0,0,0,.12);
          border-radius: 4px;
          padding: 3px 6px;
          font-size: 10px;
          line-height: 1.2;
        }
        .treatment-overlay-key {
          display: grid;
          grid-template-columns: minmax(0, .95fr) minmax(0, 1.2fr);
          gap: 12px;
          margin-top: 12px;
          align-items: stretch;
        }
        .treatment-overlay-list {
          display: grid;
          gap: 8px;
          align-content: start;
        }
        .treatment-overlay-row {
          display: grid;
          grid-template-columns: auto minmax(0, 1fr);
          gap: 10px;
          align-items: center;
          width: 100%;
          border: 1px solid var(--line);
          border-radius: 10px;
          background: #fff;
          color: var(--text);
          padding: 10px;
          text-align: left;
          font: inherit;
          cursor: pointer;
        }
        .treatment-overlay-row.is-active {
          border-color: var(--app-color, ${B.blueDark});
          box-shadow: inset 0 0 0 1px var(--app-color, ${B.blueDark});
          background: #fdfdfd;
        }
        .treatment-overlay-number {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 26px;
          height: 26px;
          border-radius: 999px;
          background: var(--app-color, ${B.blueDark});
          color: #fff;
          font-size: 12px;
          line-height: 1;
          font-weight: 850;
        }
        .treatment-overlay-row-copy {
          min-width: 0;
          display: grid;
          gap: 3px;
        }
        .treatment-overlay-row-copy strong {
          color: var(--text);
          font-size: 14px;
          line-height: 1.2;
          font-weight: 800;
          overflow-wrap: anywhere;
        }
        .treatment-overlay-row-copy span {
          color: var(--muted);
          font-size: 12px;
          line-height: 1.35;
        }
        .treatment-overlay-detail {
          border: 1px solid var(--line);
          border-radius: 10px;
          background: var(--wash);
          padding: 14px;
          min-height: 148px;
        }
        .treatment-overlay-detail h3 {
          margin: 6px 0 8px;
          color: var(--text);
          font-size: 19px;
          line-height: 1.2;
          font-weight: 850;
          letter-spacing: 0;
        }
        .treatment-overlay-detail p {
          margin: 0;
          color: var(--text);
          font-size: 14px;
          line-height: 1.5;
        }
        .treatment-overlay-meta {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin-top: 12px;
        }
        .treatment-overlay-meta span {
          border: 1px solid var(--line);
          border-radius: 999px;
          background: #fff;
          color: var(--text);
          font-size: 12px;
          line-height: 1;
          font-weight: 750;
          padding: 6px 8px;
        }
        .sr-grid-2 { display: grid; grid-template-columns: 1fr; gap: 0; }
        .sr-grid-3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; background: var(--line); }
        .sr-cell { background: #fff; padding: 14px; min-height: 72px; }
        .sr-cell-label { font-size: 12px; color: var(--soft); }
        .sr-cell-value { margin-top: 6px; font-size: 15px; color: var(--text); }
        .sr-list { display: grid; gap: 10px; }
        .sr-row {
          border: 1px solid var(--line);
          border-radius: 10px;
          padding: 13px 14px;
          display: grid;
          grid-template-columns: 1fr auto;
          gap: 12px;
        }
        .sr-row-title { font-size: 15px; font-weight: 700; color: var(--text); }
        .sr-row-detail { margin-top: 4px; color: var(--muted); font-size: 13px; line-height: 1.45; }
        .sr-pill { border: 1px solid var(--line); border-radius: 999px; padding: 4px 9px; font-size: 12px; color: ${B.blueDeeper}; background: var(--wash); white-space: nowrap; height: fit-content; }
        .sr-finding-high { border-left: 3px solid var(--red); }
        .sr-advisory { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
        .sr-advisory strong { font-size: 22px; font-weight: 500; display: block; }
        .sr-advisory span { color: var(--muted); font-size: 13px; }
        .sr-footer { color: var(--soft); font-size: 12px; line-height: 1.6; padding: 22px 0 0; }
        .ai-summary-card h2 {
          color: var(--text);
          font-size: 26px;
          line-height: 1.2;
          max-width: 820px;
          font-weight: 650;
        }
        .ai-summary-body {
          margin: 0;
          color: var(--muted);
          font-size: 16px;
          line-height: 1.55;
          max-width: 820px;
        }
        .pressure-methodology {
          margin: 12px 0 14px;
          max-width: 820px;
          background: var(--wash);
        }
        .pressure-methodology summary {
          min-height: 44px;
          font-size: 14px;
          font-weight: 800;
        }
        .pressure-methodology p {
          margin: 0;
          color: var(--muted);
          font-size: 14px;
          line-height: 1.55;
        }
        .ai-summary-bullets {
          margin-top: 16px;
          display: grid;
          gap: 8px;
        }
        .ai-summary-bullet {
          border: 1px solid var(--report-border);
          border-radius: 10px;
          padding: 11px 12px;
          color: var(--report-text);
          background: var(--wash);
          font-size: 14px;
          line-height: 1.45;
        }
        .report-ask-box {
          margin-top: 16px;
          border: 1px solid var(--report-border);
          border-radius: 12px;
          background: var(--wash);
          padding: 14px;
          max-width: 820px;
        }
        .report-ask-prompt {
          color: var(--report-text);
          font-size: 14px;
          line-height: 1.4;
          font-weight: 650;
          margin: -2px 0 10px;
        }
        .report-ask-form {
          display: flex;
          gap: 8px;
        }
        .report-ask-form input {
          flex: 1;
          min-width: 0;
          border: 1px solid var(--report-border);
          border-radius: 10px;
          padding: 11px 12px;
          color: var(--report-text);
          font: inherit;
          font-size: 14px;
          outline: none;
        }
        .report-ask-form button,
        .report-ask-actions button {
          border: 1px solid var(--report-border);
          border-radius: 10px;
          background: #fff;
          color: var(--report-text);
          font: inherit;
          font-size: 14px;
          padding: 10px 12px;
          cursor: pointer;
        }
        .report-ask-form button {
          background: ${B.yellow};
          color: ${B.blueDeeper};
          border-color: ${B.blueDeeper};
          font-weight: 800;
          min-width: 72px;
        }
        .report-ask-form button:disabled,
        .report-ask-actions button:disabled {
          opacity: .5;
          cursor: default;
        }
        .report-ask-actions {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px;
          margin-top: 10px;
        }
        .report-ask-actions button {
          min-height: 48px;
          text-align: left;
          justify-content: flex-start;
          background: ${B.blueDeeper};
          border-color: ${B.blueDeeper};
          color: #fff;
        }
        .report-ask-answer {
          margin-top: 12px;
          border: 1px solid var(--report-border);
          border-radius: 10px;
          padding: 12px;
          color: var(--report-text);
          font-size: 14px;
          line-height: 1.5;
          background: #fff;
          white-space: pre-line;
        }
        .applied-products-header {
          display: flex;
          justify-content: space-between;
          gap: 14px;
          align-items: flex-start;
          margin-bottom: 14px;
        }
        .applied-products-header h2 {
          margin-bottom: 6px;
        }
        .applied-products-header p {
          margin: 0;
          color: var(--muted);
          font-size: 14px;
          line-height: 1.45;
        }
        .applied-products-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
          gap: 10px;
        }
        .applied-product-card {
          border: 1px solid var(--line);
          border-radius: 12px;
          background: #fff;
          padding: 14px;
          min-height: 158px;
        }
        .applied-product-card h3 {
          margin: 8px 0 8px;
          color: var(--text);
          font-size: 18px;
          line-height: 1.2;
          font-weight: 800;
          letter-spacing: 0;
        }
        .solution-detail {
          margin-top: 10px;
        }
        .solution-detail summary {
          align-items: flex-start;
        }
        .solution-detail summary > span:first-child {
          color: var(--text);
          font-size: 14px;
          line-height: 1.45;
          font-weight: 650;
        }
        .solution-detail-body {
          display: grid;
          gap: 10px;
        }
        .applied-product-card p {
          margin: 0;
          color: var(--muted);
          font-size: 14px;
          line-height: 1.45;
        }
        .product-group-card {
          min-height: 0;
        }
        .product-group-list {
          margin-top: 14px;
          border: 1px solid var(--line);
          border-radius: 10px;
          background: var(--wash);
          padding: 12px;
        }
        .product-group-list ul {
          list-style: none;
          margin: 8px 0 0;
          padding: 0;
          display: grid;
          gap: 8px;
        }
        .product-group-list li {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 10px;
          color: var(--text);
          font-size: 14px;
          line-height: 1.35;
        }
        .product-group-list li span {
          color: var(--muted);
          font-size: 12px;
          text-align: right;
        }
        .applied-product-meta {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin-top: 12px;
        }
        .applied-product-meta span {
          border: 1px solid var(--line);
          border-radius: 999px;
          background: var(--wash);
          color: var(--text);
          font-size: 12px;
          line-height: 1;
          font-weight: 750;
          padding: 6px 8px;
        }
        .executive-status-grid {
          display: grid;
          grid-template-columns: 1.2fr 1fr .85fr;
          gap: 1px;
          margin-top: 16px;
          border: 1px solid var(--line);
          background: var(--line);
          border-radius: 16px;
          overflow: hidden;
          break-inside: avoid;
          page-break-inside: avoid;
        }
        .executive-status-cell {
          background: #fff;
          padding: 18px;
          min-height: 112px;
        }
        .executive-status-value {
          margin-top: 8px;
          color: var(--text);
          font-size: 18px;
          line-height: 1.35;
          font-weight: 700;
        }
        .recommended-action-text {
          margin: 0;
          color: var(--text);
          font-size: 18px;
          line-height: 1.45;
        }
        .where-accordion-list {
          display: grid;
          gap: 10px;
        }
        .report-accordion {
          background: #fff;
          border: 1px solid var(--line);
          border-radius: 10px;
          color: var(--text);
          overflow: hidden;
        }
        .report-accordion summary {
          list-style: none;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 14px;
          min-height: 52px;
          padding: 12px 14px;
          cursor: pointer;
        }
        .report-accordion summary::-webkit-details-marker {
          display: none;
        }
        .report-accordion[open] summary {
          background: var(--wash);
          border-bottom: 1px solid var(--line);
        }
        .accordion-body {
          padding: 13px 14px 14px;
        }
        .accordion-action {
          flex: 0 0 auto;
          color: var(--muted);
          font-size: 12px;
          line-height: 1;
          border: 1px solid var(--line);
          border-radius: 999px;
          padding: 5px 8px;
          background: #fff;
        }
        .where-place {
          color: var(--text);
          font-size: 14px;
          font-weight: 800;
        }
        .where-detail {
          color: var(--muted);
          font-size: 14px;
          line-height: 1.45;
          margin: 0;
        }
        .report-card {
          background: var(--report-surface);
          border: 1px solid var(--report-border);
          border-radius: 16px;
          padding: 20px;
          margin-top: 16px;
          break-inside: avoid;
          page-break-inside: avoid;
        }
        .section-eyebrow {
          color: ${B.blueDeeper};
          font-size: 12px;
          line-height: 1.2;
          margin-bottom: 8px;
          font-weight: 800;
        }
        .report-card h2 {
          margin: 0 0 14px;
          color: var(--text);
          font-size: 21px;
          line-height: 1.2;
          font-weight: 650;
          letter-spacing: 0;
        }
        .review-request-card {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          align-items: center;
          gap: 14px;
        }
        .review-request-card-top {
          margin-bottom: 14px;
        }
        .review-request-card h2 {
          margin-bottom: 0;
        }
        .review-request-card .review-cta {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-height: 44px;
          min-width: 210px;
          padding: 12px 18px;
          border: 1px solid ${B.blueDeeper};
          border-radius: 12px;
          background: ${B.yellow};
          color: ${B.blueDeeper};
          font: inherit;
          font-size: 13px;
          line-height: 1;
          font-weight: 900;
          text-decoration: none;
          box-shadow: 3px 3px 0 ${B.blueDeeper};
          transition: transform .15s ease, box-shadow .15s ease;
        }
        .review-request-card .review-cta:hover,
        .review-request-card .review-cta:focus-visible {
          transform: translate(-1px, -1px);
          box-shadow: 4px 4px 0 ${B.blueDeeper};
          outline: none;
        }
        .review-request-card p {
          margin: 0;
          color: var(--muted);
          font-size: 14px;
          line-height: 1.45;
        }
        .sr-muted {
          margin: 12px 0 0;
          color: var(--report-muted);
          font-size: 14px;
          line-height: 1.5;
        }
        .hero-reentry-status {
          margin-top: 12px;
          padding: 12px 14px;
          border: 1px solid var(--line);
          border-radius: 12px;
          background: #fff;
          max-width: 820px;
          display: grid;
          grid-template-columns: minmax(128px, .7fr) minmax(0, 1.3fr);
          gap: 14px;
          align-items: center;
        }
        .hero-reentry-status .section-eyebrow {
          margin-bottom: 4px;
        }
        .hero-reentry-status h2 {
          margin: 0;
          color: var(--text);
          font-size: 18px;
          line-height: 1.25;
          font-weight: 750;
          letter-spacing: 0;
        }
        .reentry-details {
          min-width: 0;
        }
        .reentry-target-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 10px;
        }
        .reentry-target-tile {
          border: 1px solid var(--report-border);
          border-radius: 10px;
          padding: 14px;
          min-height: 78px;
          background: var(--wash);
        }
        .reentry-target-value {
          margin-top: 8px;
          color: var(--report-text);
          font-size: 22px;
          line-height: 1.15;
          font-weight: 700;
        }
        .hero-reentry-status .reentry-target-grid {
          gap: 1px;
          overflow: hidden;
          border: 1px solid var(--line);
          border-radius: 10px;
          background: var(--line);
        }
        .hero-reentry-status .reentry-target-tile {
          min-height: 58px;
          border: 0;
          border-radius: 0;
          padding: 10px 12px;
          background: var(--wash);
        }
        .hero-reentry-status .reentry-target-value {
          margin-top: 4px;
          font-size: 16px;
          line-height: 1.2;
        }
        .reentry-notes {
          display: flex;
          flex-wrap: wrap;
          gap: 4px 14px;
          margin-top: 8px;
        }
        .reentry-notes .sr-muted {
          margin: 0;
          font-size: 13px;
        }
        .pressure-trend-layout {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(260px, 420px);
          gap: 18px;
          align-items: center;
        }
        .pressure-summary {
          margin: 0;
          color: var(--report-text);
          font-size: 16px;
          line-height: 1.5;
        }
        .pressure-trend-chart {
          width: 100%;
          max-width: 420px;
          justify-self: end;
        }
        .pressure-line {
          stroke: ${B.blueDeeper};
          stroke-width: 1.6;
        }
        .pressure-point {
          fill: #fff;
          stroke: ${B.blueDeeper};
          stroke-width: 1.5;
        }
        .pressure-point-target {
          fill: transparent;
          stroke: transparent;
          pointer-events: all;
        }
        .pressure-point-hit {
          cursor: help;
          outline: none;
        }
        .pressure-point-hit:hover .pressure-point,
        .pressure-point-hit:focus .pressure-point {
          fill: var(--wash);
          stroke-width: 2.4;
        }
        .chart-axis,
        .chart-gridline {
          stroke: var(--report-border);
          stroke-width: .7;
        }
        .chart-label {
          fill: var(--report-muted);
          font-size: 10px;
        }
        .pressure-value-label {
          fill: ${B.blueDeeper};
          font-size: 10px;
          font-weight: 850;
          pointer-events: none;
        }
        .neighborhood-pressure-line {
          stroke: var(--report-muted);
          stroke-width: 1;
          stroke-dasharray: 4 4;
        }
        .pressure-legend {
          display: flex;
          gap: 16px;
          flex-wrap: wrap;
          margin-top: 10px;
          color: var(--report-muted);
          font-size: 12px;
        }
        .pressure-trend-card-embedded {
          margin-top: 16px;
          padding-top: 16px;
          border-top: 1px solid var(--line);
        }
        .pressure-trend-card-embedded h2 {
          margin: 0 0 10px;
          color: var(--text);
          font-size: 21px;
          line-height: 1.2;
          font-weight: 650;
          letter-spacing: 0;
        }
        .lawn-assessment-card-embedded {
          margin-top: 16px;
          padding-top: 16px;
          border-top: 1px solid var(--line);
        }
        .lawn-assessment-card h2,
        .lawn-assessment-card-embedded h2 {
          margin: 0 0 12px;
          color: var(--text);
          font-size: 21px;
          line-height: 1.2;
          font-weight: 650;
          letter-spacing: 0;
        }
        .lawn-assessment-layout {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(260px, 420px);
          gap: 18px;
          align-items: center;
        }
        .lawn-overall-score {
          display: inline-flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 12px;
          padding: 10px 12px;
          border: 1px solid var(--line);
          border-radius: 12px;
          background: var(--wash);
        }
        .lawn-overall-score > span {
          color: var(--text);
          font-size: 34px;
          line-height: 1;
          font-weight: 800;
        }
        .lawn-overall-score strong,
        .lawn-overall-score em {
          display: block;
          font-style: normal;
        }
        .lawn-overall-score strong {
          color: var(--text);
          font-size: 14px;
          line-height: 1.2;
        }
        .lawn-overall-score em {
          margin-top: 2px;
          color: var(--muted);
          font-size: 12px;
          line-height: 1.2;
        }
        .lawn-profile-line,
        .lawn-before-after-line {
          margin-top: 10px;
          color: var(--muted);
          font-size: 13px;
          line-height: 1.45;
          font-weight: 650;
        }
        .lawn-trend-chart {
          width: 100%;
          max-width: 420px;
          justify-self: end;
        }
        .lawn-health-line {
          stroke: ${B.blueDeeper};
          stroke-width: 1.6;
        }
        .lawn-health-point {
          fill: #fff;
          stroke: ${B.blueDeeper};
          stroke-width: 1.5;
        }
        .pressure-point-hit:hover .lawn-health-point,
        .pressure-point-hit:focus .lawn-health-point {
          fill: var(--wash);
          stroke-width: 2.4;
        }
        .lawn-score-grid {
          display: grid;
          grid-template-columns: repeat(5, minmax(0, 1fr));
          gap: 1px;
          margin-top: 16px;
          overflow: hidden;
          border: 1px solid var(--line);
          border-radius: 12px;
          background: var(--line);
        }
        .lawn-score-cell {
          min-height: 82px;
          background: #fff;
          padding: 12px;
        }
        .lawn-score-value {
          margin-top: 7px;
          color: var(--text);
          font-size: 22px;
          line-height: 1.1;
          font-weight: 800;
        }
        .lawn-photo-strip {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 10px;
          margin-top: 16px;
        }
        .lawn-photo-strip figure {
          margin: 0;
          border: 1px solid var(--line);
          border-radius: 10px;
          overflow: hidden;
          background: #fff;
        }
        .lawn-photo-strip img {
          display: block;
          width: 100%;
          aspect-ratio: 4 / 3;
          object-fit: cover;
        }
        .lawn-photo-strip figcaption {
          padding: 8px 10px;
          color: var(--muted);
          font-size: 12px;
          line-height: 1.3;
          font-weight: 700;
        }
        .summary-mode-tabs {
          display: inline-flex;
          border: 1px solid var(--line);
          border-radius: 10px;
          overflow: hidden;
          background: #fff;
          flex: 0 0 auto;
        }
        .summary-mode-tabs button {
          border: 0;
          border-left: 1px solid var(--line);
          background: #fff;
          color: var(--muted);
          font: inherit;
          font-size: 13px;
          padding: 8px 11px;
          cursor: pointer;
        }
        .summary-mode-tabs button:first-child {
          border-left: 0;
        }
        .summary-mode-tabs button.is-active {
          background: ${B.blueDark};
          color: #fff;
        }
        .premium-section-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 14px;
        }
        .the-one-thing {
          background: ${B.blueSurface};
        }
        .the-one-thing h2 {
          font-size: 25px;
          line-height: 1.22;
          margin-bottom: 0;
        }
        .one-thing-detail {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 10px;
          margin-top: 16px;
        }
        .one-thing-detail > div {
          border: 1px solid var(--line);
          border-radius: 10px;
          background: #fff;
          padding: 12px;
        }
        .one-thing-detail p,
        .why-activity-card p,
        .bug-file-row p,
        .when-to-text p {
          margin: 6px 0 0;
          color: var(--muted);
          font-size: 14px;
          line-height: 1.5;
        }
        .defense-status-grid {
          display: grid;
          grid-template-columns: repeat(5, minmax(0, 1fr));
          gap: 1px;
          overflow: hidden;
          border: 1px solid var(--line);
          border-radius: 12px;
          background: var(--line);
        }
        .defense-status-item {
          min-height: 118px;
          background: #fff;
          padding: 14px;
        }
        .defense-status-value {
          margin-top: 8px;
          color: var(--text);
          font-size: 17px;
          line-height: 1.2;
          font-weight: 800;
        }
        .defense-status-item.status-needs_attention,
        .defense-status-item.status-watched {
          background: var(--wash);
        }
        .defense-status-item.status-action_required,
        .defense-status-item.status-needs_attention {
          border-left: 3px solid var(--red);
        }
        .bug-file-grid {
          display: grid;
          grid-template-columns: 1fr;
          gap: 10px;
        }
        .bug-file-section-embedded,
        .why-activity-card-embedded {
          margin-top: 14px;
          border-top: 1px solid var(--line);
          padding-top: 14px;
        }
        .bug-file-section-embedded h2,
        .why-activity-card-embedded h2 {
          margin: 0 0 10px;
          color: var(--text);
          font-size: 20px;
          line-height: 1.2;
          font-weight: 750;
          letter-spacing: 0;
        }
        .bug-file-card {
          background: var(--wash);
        }
        .bug-file-suspect {
          margin-top: 6px;
          color: var(--text);
          display: block;
          font-size: 18px;
          line-height: 1.1;
          font-weight: 800;
        }
        .bug-file-row + .bug-file-row {
          margin-top: 14px;
        }
        .why-activity-card {
          background: var(--wash);
        }
        .why-activity-card > p {
          margin: 0;
          color: var(--text);
          font-size: 16px;
          line-height: 1.55;
        }
        .when-to-text {
          margin-top: 14px;
          border: 1px solid var(--line);
          border-radius: 10px;
          background: #fff;
          padding: 12px;
        }
        .what-to-expect-section,
        .contact-waves-section {
          background: #fff;
        }
        .contact-waves-section {
          border-color: var(--soft-blue-border);
          background: var(--soft-blue);
        }
        .contact-waves-section ul {
          margin: 12px 0 0;
          padding-left: 20px;
          color: var(--text);
          font-size: 15px;
          line-height: 1.6;
        }
        .contact-waves-cta {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          margin-top: 14px;
          min-height: 40px;
          border: 1px solid ${B.blueDeeper};
          border-radius: 8px;
          background: ${B.blueDeeper};
          color: #fff;
          font-size: 13px;
          line-height: 1;
          font-weight: 850;
          text-decoration: none;
          padding: 10px 14px;
        }
        .supporting-details-list {
          display: grid;
          gap: 10px;
        }
        .supporting-details-section > h2 {
          margin-bottom: 14px;
        }
        .supporting-detail-grid {
          margin-top: 12px;
        }
        .supporting-details-section .pressure-trend-card-embedded {
          margin-top: 0;
          padding-top: 0;
          border-top: 0;
        }
        .supporting-metadata {
          display: grid;
          gap: 10px;
        }
        .supporting-metadata p,
        .supporting-note {
          margin: 0;
          color: var(--muted);
          font-size: 14px;
          line-height: 1.5;
        }
        .supporting-metrics {
          margin-top: 0;
        }
        .receipt-grid {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 1px;
          overflow: hidden;
          border: 1px solid var(--line);
          border-radius: 12px;
          background: var(--line);
        }
        .receipt-stat {
          min-height: 100px;
          background: #fff;
          padding: 14px;
        }
        .receipt-value {
          margin-top: 8px;
          color: var(--text);
          font-size: 24px;
          line-height: 1.05;
          font-weight: 800;
        }
        .map-tap-prompt {
          margin: 8px 0 0;
          color: ${B.blueDeeper};
          font-size: 13px;
          font-weight: 800;
          line-height: 1.35;
        }
        .sr-nerd-note {
          margin-top: 8px;
          color: var(--muted);
          font-size: 12px;
          line-height: 1.45;
        }
        .sr-section,
        .report-card {
          border-color: var(--line);
          border-radius: 8px;
          box-shadow: var(--shadow-soft);
        }
        .sr-section h2,
        .report-card h2,
        .applied-product-card h3,
        .coverage-summary-row h3,
        .workflow-event-heading h3 {
          font-family: ${FONTS.heading};
          font-weight: 850;
          color: var(--text);
          letter-spacing: 0;
        }
        .sr-section h2,
        .report-card h2 {
          font-size: 20px;
        }
        .sr-band,
        .sr-grid-3,
        .executive-status-grid,
        .defense-status-grid,
        .receipt-grid,
        .lawn-score-grid,
        .hero-condition-row,
        .hero-reentry-status .reentry-target-grid {
          border-radius: 8px;
        }
        .tech-visit-line,
        .hero-conditions,
        .hero-reentry-status,
        .reentry-target-tile,
        .report-ask-box,
        .report-ask-form input,
        .report-ask-form button,
        .report-ask-actions button,
        .report-ask-answer,
        .service-coverage-map,
        .coverage-empty-state,
        .coverage-summary-row,
        .workflow-event-body,
        .map-toggle,
        .satellite-treatment-map,
        .treatment-overlay-row,
        .treatment-overlay-detail,
        .sr-map,
        .sr-row,
        .report-accordion,
        .applied-product-card,
        .when-to-text,
        .one-thing-detail > div,
        .lawn-overall-score,
        .lawn-photo-strip figure,
        .review-request-card .review-cta {
          border-radius: 8px;
        }
        .sr-cell-label {
          color: var(--muted);
          font-family: ${FONTS.heading};
          font-size: 11px;
          font-weight: 850;
          letter-spacing: 0;
          text-transform: uppercase;
        }
        .section-eyebrow {
          color: var(--muted);
          font-family: ${FONTS.heading};
          font-size: 11px;
          font-weight: 850;
          letter-spacing: 0;
          text-transform: uppercase;
        }
        .summary-mode-tabs,
        .map-toggle {
          border-color: var(--line-strong);
          border-radius: 8px;
        }
        .summary-mode-tabs button,
        .map-toggle button {
          font-family: ${FONTS.heading};
          font-weight: 850;
        }
        .summary-mode-tabs button.is-active,
        .map-toggle button.is-active {
          background: ${B.blueDeeper};
          color: #fff;
        }
        .report-ask-box,
        .tech-visit-line,
        .hero-conditions,
        .hero-reentry-status,
        .why-activity-card,
        .bug-file-card,
        .the-one-thing {
          background: var(--soft-blue);
          border-color: var(--soft-blue-border);
        }
        .report-ask-form button {
          background: ${B.blueDeeper};
          border-color: ${B.blueDeeper};
          color: #fff;
        }
        .review-request-card .review-cta {
          background: ${B.blueDeeper};
          border-color: ${B.blueDeeper};
          color: #fff;
          box-shadow: none;
        }
        .review-request-card .review-cta:hover,
        .review-request-card .review-cta:focus-visible {
          transform: none;
          box-shadow: none;
        }
        @media (max-width: 760px) {
          .sr-top-inner { align-items: flex-start; flex-direction: column; }
          .sr-actions { width: 100%; justify-content: stretch; }
          .sr-actions a, .sr-actions button { flex: 1; }
          .sr-shell { padding: 14px 14px 36px; }
          .summary-mode-tabs { width: 100%; }
          .summary-mode-tabs button { flex: 1; }
          .service-status-main,
          .readiness-card-header { flex-direction: column; }
          .sr-hero { grid-template-columns: 1fr; }
          .sr-pressure { justify-self: stretch; }
          .sr-band { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .sr-grid-2, .sr-grid-3, .sr-advisory, .service-status-grid, .readiness-facts, .supporting-detail-grid, .executive-status-grid, .defense-status-grid, .receipt-grid, .one-thing-detail, .lawn-score-grid, .lawn-assessment-layout { grid-template-columns: 1fr; }
          .lawn-trend-chart { justify-self: stretch; max-width: none; }
          .lawn-photo-strip { grid-template-columns: 1fr; }
          .premium-section-header { flex-direction: column; }
          .sr-row { grid-template-columns: 1fr; }
          .hero-conditions-copy { display: block; }
          .hero-conditions-copy p { margin-top: 6px; text-align: left; }
          .hero-condition-row {
            grid-template-columns: repeat(6, minmax(112px, 1fr));
            overflow-x: auto;
          }
          .report-ask-form { flex-direction: column; }
          .report-ask-actions { grid-template-columns: 1fr; }
          .coverage-section-header { flex-direction: column; }
          .coverage-map-meta { justify-items: start; text-align: left; max-width: none; }
          .service-coverage-map { aspect-ratio: 32 / 17; }
          .coverage-map-label { display: none; }
          .coverage-summary-row { align-items: flex-start; flex-direction: column; }
          .coverage-status-chip { align-self: flex-start; }
          .workflow-event-heading { flex-direction: column; gap: 3px; }
          .treatment-map-header { flex-direction: column; }
          .map-toggle { width: 100%; }
          .map-toggle button { flex: 1; }
          .treatment-overlay-key { grid-template-columns: 1fr; }
          .where-row { grid-template-columns: 1fr; }
          .reentry-target-grid, .pressure-trend-layout { grid-template-columns: 1fr; }
          .pressure-trend-chart { justify-self: stretch; max-width: none; }
          .review-request-card { grid-template-columns: 1fr; }
        }
        @media print {
          .sr-top { position: static; }
          .sr-actions { display: none; }
          .service-report-v1 { background: #fff; }
          .sr-shell { padding: 0; }
          .sr-hero,
          .sr-section,
          .report-card,
          .executive-status-grid,
          .sr-band {
            border-color: #d4d4d4;
            box-shadow: none;
          }
          .reentry-timer,
          .pressure-trend-card {
            break-inside: avoid;
            page-break-inside: avoid;
          }
        }
      `}</style>

      <header className="sr-top">
        <div className="sr-top-inner">
          <div className="sr-brand-lockup">
            <img src="/waves-logo.png" alt="Waves" className="sr-brand-logo" />
            <div style={{ minWidth: 0 }}>
              <div className="sr-brand-title">Customer Portal</div>
              <div className="sr-brand-subtitle">Service report · {data.customerName}</div>
            </div>
          </div>
          <div className="sr-actions">
            {pdfUrl && <a href={pdfUrl} download onClick={() => trackReportEvent(token, 'pdf_downloaded')} style={actionButtonStyle('primary')}><Download size={16} /> Download PDF</a>}
            <button type="button" onClick={share} style={actionButtonStyle('primary')}><Share2 size={16} /> Share</button>
            <button type="button" onClick={() => window.print()} style={actionButtonStyle('primary')}><Printer size={16} /> Print</button>
          </div>
        </div>
      </header>

      <main className="sr-shell">
        <ServiceStatusCard data={data} mode={mode} />

        <ReentryReadinessCard context={dynamicContext.reentry} mode={mode} token={token} />

        <section className="sr-section visit-summary-section" id="visit-summary">
          <h2>Visit Summary</h2>
          <p>{visitSummaryCopy(data)}</p>
          {isLawnReport && (
            <LawnAssessmentCard
              assessment={data.lawnAssessment}
              mode={mode}
              token={token}
              embedded
            />
          )}
        </section>

        <QuickNavigationAndAsk mode={mode} token={token} serviceLine={data.serviceLine} hasProducts={hasApplications} />

        <ReviewRequestCard data={data} token={token} mode={mode} placement="top" />

        <div id="map">
          <ServiceReportCoverageAndWorkflow
            serviceType={data.coverageServiceType || data.serviceLine || data.serviceType}
            serviceAreas={serviceAreas}
            serviceLocations={data.serviceLocations}
            workflowEvents={data.workflowEvents}
            propertyAddress={data.propertyAddress || data.serviceAddress}
            mapCenter={data.mapCenter}
            serviceDate={data.serviceDate}
            evidenceLevel={data.evidenceLevel}
            mapBackgroundUrl={mode === 'live' ? data.treatmentMap?.satellite?.live?.url : null}
            mapAttribution={mode === 'live' ? data.treatmentMap?.satellite?.attributionText : null}
          />
        </div>

        <AppliedProductsSection
          data={data}
          showAll={showDetails}
          showTechnical={false}
          mode={mode}
        />

        <RecommendedActionCard findings={findings} aiSummary={dynamicContext.aiSummary} primaryMove={premium.primaryMove} />

        <WhatToExpectNextSection context={premium.whyActivity} serviceLine={data.serviceLine} />

        <WhenToContactUsSection />

        {(data.photos || []).length > 0 && (
          <section className="sr-section" id="photos">
            <h2>Field photos</h2>
            <div className="sr-grid-3">
              {data.photos.map((photo) => (
                <div className="sr-cell" key={photo.id}>
                  {photo.url && <img src={photo.url} alt={photo.caption || 'Service photo'} style={{ width: '100%', borderRadius: 6, border: '0.5px solid #d4d4d4' }} />}
                  <div className="sr-cell-value">{photo.caption || photo.stateBadge || 'Service photo'}</div>
                </div>
              ))}
            </div>
          </section>
        )}

        <ReviewRequestCard data={data} token={token} mode={mode} placement="bottom" />

        <SupportingDetailsSection
          data={data}
          token={token}
          mode={mode}
          showDetails={showDetails}
          serviceNotes={serviceNotes}
          findings={findings}
          recommendations={recommendations}
          advisoryRows={advisoryRows}
        />

        <footer className="sr-footer">
          This report is provided for your records.
          {data.photoChain?.valid === true ? ' Photos hash-chained and tamper-evident.' : ''}
          {' '}For questions, text or call (941) 297-5749.
        </footer>
        <BrandFooter variant="document" />
      </main>
    </div>
  );
}

export default function ReportViewPage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const mode = useMemo(() => {
    if (typeof window === 'undefined') return 'live';
    const requestedMode = new URLSearchParams(window.location.search).get('mode');
    return ['pdf', 'static', 'sms_preview'].includes(requestedMode) ? requestedMode : 'live';
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const dataUrl = `${API_BASE}/reports/${token}/data?mode=${encodeURIComponent(mode)}`;
    fetch(dataUrl, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setData({ error: 'Report not found' });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, mode]);

  useEffect(() => {
    if (!data || data.error) return;
    applyReportDocumentMetadata(data);
  }, [data]);

  if (loading) return <LoadingState />;
  if (!data || data.error) return <NotFoundState />;
  if (data.reportVersion === 'service_report_v1') return <ServiceReportV1 data={data} token={token} mode={mode} />;
  return <LegacyReport data={data} token={token} />;
}
