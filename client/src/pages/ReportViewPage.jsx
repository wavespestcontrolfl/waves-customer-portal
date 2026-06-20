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
import PestPressureCard from '../components/PestPressureCard';
import ActivityCard from '../components/ActivityCard';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const WAVES_PHONE_DISPLAY = '(941) 297-5749';
const WAVES_PHONE_TEL = '+19412975749';
const FONT_BODY = "'Inter', system-ui, sans-serif";
const ESTIMATE_BG = '#FAF8F3';
const ESTIMATE_BORDER = '#E7E2D7';
const ESTIMATE_MUTED = '#6B7280';
const ESTIMATE_TEXT = '#1B2C5B';
const ESTIMATE_BODY = '#3F4A65';
const ESTIMATE_BUTTON_BG = B.blueDeeper;
const ESTIMATE_INPUT_BORDER = '#CFE7F5';
const ESTIMATE_INPUT_BG = '#F8FCFE';
const SERVICE_REPORT_TIME_ZONE = 'America/New_York';
const PRESSURE_INDEX_DISPLAY_FLOOR = 0.3;
const DEFAULT_PORTAL_DESCRIPTION = 'Your Waves service reports, billing, and account — view past visits, track action items, and schedule the next service.';
const sentReportEvents = new Set();
// Tokens whose /data payload came back flagged staffViewer: trackReportEvent
// drops every event for them so staff QA never pollutes customer analytics.
const staffViewTokens = new Set();
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
    key: 'bradenton',
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

// Compact axis label ("Jun 10") for the lawn trend chart. Uses the same robust
// parse + report time zone as formatDate, so a full timestamp or Date value no
// longer slips through and renders as "Invalid Date". Returns '' when the value
// can't be parsed, letting the caller fall back to a visit-number label.
export function formatShortDate(value) {
  if (!value) return '';
  const dateOnly = calendarDateFromDateOnlyValue(value);
  const date = dateOnly || new Date(String(value));
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', {
    timeZone: SERVICE_REPORT_TIME_ZONE,
    month: 'short',
    day: 'numeric',
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

export function getFirstPresentValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function getFirstValidTimelineValue(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return value;
  }
  return null;
}

export function getReportArrivalTime(report = {}) {
  return getFirstValidTimelineValue(
    report?.serviceRecord?.arrived_at,
    report?.serviceRecord?.arrivedAt,
    report?.serviceRecord?.actual_start_time,
    report?.serviceRecord?.actualStartTime,
    report?.serviceRecord?.check_in_time,
    report?.serviceRecord?.checkInTime,

    report?.service_record?.arrived_at,
    report?.service_record?.actual_start_time,
    report?.service_record?.check_in_time,

    report?.arrived_at,
    report?.arrivedAt,
    report?.actual_start_time,
    report?.actualStartTime,
    report?.check_in_time,
    report?.checkInTime,

    report?.scheduledService?.arrived_at,
    report?.scheduledService?.arrivedAt,
    report?.scheduledService?.actual_start_time,
    report?.scheduledService?.actualStartTime,
    report?.scheduledService?.check_in_time,
    report?.scheduledService?.checkInTime,

    report?.scheduled_service?.arrived_at,
    report?.scheduled_service?.actual_start_time,
    report?.scheduled_service?.check_in_time,

    report?.visitTiming?.arrivedAt,
    report?.visitTiming?.arrived_at,
    report?.serviceRecord?.started_at,
    report?.service_record?.started_at,
    report?.started_at,
  );
}

export function getReportCompletionTime(report = {}) {
  return getFirstValidTimelineValue(
    report?.serviceRecord?.completed_at,
    report?.serviceRecord?.completedAt,
    report?.serviceRecord?.actual_end_time,
    report?.serviceRecord?.actualEndTime,
    report?.serviceRecord?.check_out_time,
    report?.serviceRecord?.checkOutTime,

    report?.service_record?.completed_at,
    report?.service_record?.actual_end_time,
    report?.service_record?.check_out_time,

    report?.completed_at,
    report?.completedAt,
    report?.actual_end_time,
    report?.actualEndTime,
    report?.check_out_time,
    report?.checkOutTime,

    report?.scheduledService?.completed_at,
    report?.scheduledService?.completedAt,
    report?.scheduledService?.actual_end_time,
    report?.scheduledService?.actualEndTime,
    report?.scheduledService?.check_out_time,
    report?.scheduledService?.checkOutTime,

    report?.scheduled_service?.completed_at,
    report?.scheduled_service?.actual_end_time,
    report?.scheduled_service?.check_out_time,

    report?.visitTiming?.exitedAt,
    report?.visitTiming?.exited_at,
    report?.serviceRecord?.ended_at,
    report?.service_record?.ended_at,
    report?.ended_at,
  );
}

export function getMinutesBetween(start, end) {
  if (!start || !end) return null;

  const startDate = new Date(start);
  const endDate = new Date(end);

  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return null;
  }

  const diffMs = endDate.getTime() - startDate.getTime();

  if (diffMs <= 0) {
    return null;
  }

  return Math.round(diffMs / 60000);
}

export function formatTimelineTime(value) {
  return formatClockTime(value) || null;
}

export function formatDurationMinutes(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return null;
  }

  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (remainingMinutes === 0) {
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }

  return `${hours} hr ${remainingMinutes} min`;
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
  const arrived = formatTimelineTime(getReportArrivalTime(data));
  const exited = formatTimelineTime(getReportCompletionTime(data));
  if (arrived && exited) return `Arrived ${arrived} | Finished ${exited}`;
  if (arrived) return `Arrived ${arrived}`;
  if (exited) return `Finished ${exited}`;
  return '';
}

export function visitTimeLabel(data = {}) {
  const arrived = formatClockTime(data.visitTiming?.arrivedAt);
  const exited = formatClockTime(data.visitTiming?.exitedAt);
  if (arrived && exited && arrived !== exited) return `${arrived} to ${exited}`;
  return arrived || exited || '';
}

export function serviceReportDateTimeLabel(data = {}) {
  const serviceDate = formatDate(data.serviceDate);
  const serviceTime = visitTimeLabel(data);
  if (serviceDate && serviceTime) return `${serviceDate} at ${serviceTime}`;
  return serviceDate || serviceTime;
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

export function customerInteractionCopy(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const key = raw.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const copy = {
    tech_home_spoke_with_them: 'The technician spoke with someone at the home.',
    tech_home_no_answer: 'The technician did not reach someone at the home.',
    customer_home_spoke_with_them: 'The technician spoke with someone at the home.',
    customer_home_no_answer: 'The technician did not reach someone at the home.',
    spoke: 'The technician spoke with someone at the home.',
    not_home_full_access: 'No one was home, and the technician had full access to complete service.',
    not_home_partial_access: 'No one was home, and the technician completed the accessible areas.',
    customer_specific_concern: 'The customer shared a specific concern with the technician.',
    customer_not_home: 'No one was home during the visit.',
    no_customer_contact: 'No customer interaction was recorded for this visit.',
    gate_access_used: 'The technician used the recorded access instructions.',
  };
  return copy[key] || formatEnumLabel(raw);
}

function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function trackReportEvent(token, eventName, metadata = {}) {
  if (!token || !eventName) return;
  // Staff reads (data payload flagged staffViewer — the /data fetch carried
  // the portal JWT) post NO interaction events: this endpoint is
  // unauthenticated, so a staff QA pass would otherwise record as customer
  // analytics (report_viewed and every tap after it).
  if (staffViewTokens.has(token)) return;
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

function uniqueStrings(values = []) {
  const seen = new Set();
  return values.map((value) => String(value || '').trim()).filter((value) => {
    if (!value) return false;
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function shortList(values = [], limit = 3) {
  const items = uniqueStrings(values).slice(0, limit);
  if (!items.length) return '';
  if (items.length === 1) return items[0];
  return items.join(' · ');
}

function highPriorityFindings(data = {}) {
  return (Array.isArray(data.findings) ? data.findings : [])
    .filter((finding) => ['critical', 'high'].includes(String(finding.severity || '').toLowerCase()));
}

function isCompletedCoverageStatus(status) {
  return ['completed', 'treated', 'serviced', 'device_placed', 'checked'].includes(String(status || '').toLowerCase());
}

function isInaccessibleCoverageStatus(status) {
  return ['inaccessible', 'skipped', 'not_serviced'].includes(String(status || '').toLowerCase());
}

function isActionNeededCoverageStatus(status) {
  const normalized = String(status || '').toLowerCase();
  return isInaccessibleCoverageStatus(normalized) || ['needs_attention', 'needs_follow_up'].includes(normalized);
}

export function latestPendingReentryTarget(targets = [], nowMs = Date.now()) {
  return (Array.isArray(targets) ? targets : []).reduce((latest, target) => {
    const readyAtMs = Date.parse(target?.readyAt);
    if (!Number.isFinite(readyAtMs) || readyAtMs <= nowMs) return latest;
    if (!latest || readyAtMs > latest.readyAtMs) return { target, readyAtMs };
    return latest;
  }, null)?.target || null;
}

export function smartStatusSummary(data = {}, mode = 'live', nowMs = Date.now()) {
  const coverage = normalizeServiceCoverage(data);
  const coverageItems = Array.isArray(coverage?.items) ? coverage.items : [];
  const completedItems = coverageItems.filter((item) => isCompletedCoverageStatus(item.status));
  const actionNeededItems = coverageItems.filter((item) => isActionNeededCoverageStatus(item.status));
  const completedAreas = shortList(completedItems.map((item) => item.areaName || item.name), 4);
  const productsApplied = uniqueStrings((data.applications || []).map((app) => applicationProductName(app)));
  const technician = data.technician?.name || data.technicianName || 'Your Waves technician';
  const completionTime = formatTimelineTime(getReportCompletionTime(data));
  const context = data.dynamicContext || {};
  const reentry = context.reentry || {};
  const targets = Array.isArray(reentry.targets) ? reentry.targets : [];
  const pendingTarget = latestPendingReentryTarget(targets, nowMs);
  const pendingReadyText = pendingTarget
    ? (mode === 'live'
      ? `Ready in ${formatDuration(Date.parse(pendingTarget.readyAt) - nowMs)}`
      : `Ready after ${formatReadyTime(pendingTarget.readyAt, reentry.displayTimezone)}`)
    : null;
  const allReady = targets.length > 0 && targets.every((target) => {
    const readyAtMs = Date.parse(target.readyAt);
    return Number.isFinite(readyAtMs) && readyAtMs <= nowMs;
  });
  const importantFindings = highPriorityFindings(data);
  const primaryFinding = importantFindings[0];

  if (primaryFinding) {
    return {
      heading: 'we found activity that needs attention.',
      status: pendingReadyText || 'Follow-up recommended',
      statusTone: pendingReadyText ? 'pending' : 'warning',
      result: pendingReadyText
        ? `${pendingTarget.label || 'Treated'} areas are still drying. ${primaryFinding.title || 'Activity was noted'} still needs attention.`
        : `${primaryFinding.title || 'Activity was noted'}${primaryFinding.recommendation ? ` ${primaryFinding.recommendation}` : ''}`,
      completedLine: completedAreas ? `${completedItems.length} area${completedItems.length === 1 ? '' : 's'} completed · ${completedAreas}` : 'Service areas completed today.',
      detail: pendingReadyText
        ? 'Keep pets and people away from treated zones until they are ready. We also included the recommended next step below.'
        : 'We treated the documented area today and included the recommended next step below.',
    };
  }

  if (actionNeededItems.length) {
    const item = actionNeededItems[0];
    const area = item.areaName || item.name || 'one area';
    const inaccessible = isInaccessibleCoverageStatus(item.status);
    return {
      heading: inaccessible ? 'one area could not be serviced.' : 'one area needs attention.',
      status: pendingReadyText || (inaccessible ? 'Action needed' : 'Follow-up recommended'),
      statusTone: pendingReadyText ? 'pending' : 'warning',
      result: pendingReadyText
        ? `${pendingTarget.label || 'Treated'} areas are still drying. ${area} was marked ${coverageStatusConfig(item.status).label.toLowerCase()}.`
        : `${area} was marked ${coverageStatusConfig(item.status).label.toLowerCase()}.`,
      completedLine: completedAreas ? `${completedItems.length} area${completedItems.length === 1 ? '' : 's'} completed · ${completedAreas}` : 'Accessible areas were serviced.',
      detail: pendingReadyText
        ? 'Keep pets and people away from treated zones until they are ready. Review the recommended next step below.'
        : (inaccessible
          ? 'You can contact Waves if you want us to return for the inaccessible area.'
          : (item.customerDescription || 'Review the recommended next step below.')),
    };
  }

  if (pendingTarget) {
    return {
      heading: 'your service is complete.',
      status: pendingReadyText,
      statusTone: 'pending',
      result: `${pendingTarget.label || 'Treated'} areas are still drying.`,
      completedLine: completedAreas ? `${completedItems.length} area${completedItems.length === 1 ? '' : 's'} completed · ${completedAreas}` : 'Service completed today.',
      detail: 'Keep pets and people away from treated zones until they are ready.',
    };
  }

  if (context.pressureTrend?.direction === 'down') {
    return {
      heading: 'pest pressure is trending down.',
      status: allReady ? 'Ready now' : 'Service complete',
      statusTone: 'ready',
      result: context.pressureTrend.customerSummary || 'Activity has decreased since the last visit.',
      completedLine: completedAreas ? `${completedItems.length} area${completedItems.length === 1 ? '' : 's'} completed · ${completedAreas}` : 'Protective service maintained today.',
      detail: 'Today we maintained the protective treatment plan for this property.',
    };
  }

  return {
    heading: 'your service is complete.',
    status: allReady ? 'Ready now' : 'Service complete',
    statusTone: allReady ? 'ready' : 'neutral',
    result: 'Routine service completed. No high-priority issues were noted.',
    completedLine: completedAreas ? `${completedItems.length} area${completedItems.length === 1 ? '' : 's'} completed · ${completedAreas}` : 'Service areas were completed today.',
    detail: [
      completionTime ? `${technician} completed the visit at ${completionTime}.` : `${technician} completed the visit.`,
      productsApplied.length ? `${productsApplied.length} product${productsApplied.length === 1 ? '' : 's'} applied.` : null,
    ].filter(Boolean).join(' '),
  };
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
  const pendingTarget = latestPendingReentryTarget(context.reentry?.targets);
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
    ['Wind', conditions.wind_mph ?? conditions.wind, ' mph'],
    ['Rain last 24 hr', conditions.rain_24h_in, ' in'],
    ['Sky', conditions.sky ?? conditions.cloudCover, ''],
    ['Source', conditions.source, ''],
  ];
  return rows
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([label, value, suffix]) => {
      const suffixText = suffix && Number.isFinite(Number(value)) ? suffix : '';
      return [label, `${value}${suffixText}`];
    });
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

function applicationProductSummary(app = {}) {
  return app.product?.service_report_summary || app.product?.public_summary || '';
}

function applicationPrecautionSummary(app = {}) {
  return app.product?.precaution_summary || '';
}

function applicationReentrySummary(app = {}) {
  return app.product?.reentry_summary || '';
}

function applicationManufacturer(app = {}) {
  return app.product?.manufacturer || '';
}

// Product-specific watering guidance for the lawn report, sourced ONLY from the
// approved per-product irrigation note (label-derived `irrigation_notes`). We do
// not synthesize watering intervals from product category/name — that would
// invent label-like guidance, which the product-safety convention forbids
// (see server report-copy-context.js: "do not invent numbers"). When a product
// has no approved watering note, returns null and the report shows the neutral,
// service-note-deferring guidance carried once in the section explainer.
export function lawnWateringGuidance(app = {}) {
  const note = String(app.product?.irrigation_notes || '').trim();
  if (!note) return null;
  return { headline: 'Watering note for this product', detail: note };
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
  // State labels describing the CURRENT health band — never a trend word.
  // "Improving" implied a comparison the first report can't have (no prior
  // assessment); the LawnTrendChart owns trend once there are 2+ visits.
  const value = Number(score);
  if (!Number.isFinite(value)) return 'Tracking';
  if (value >= 85) return 'Strong';
  if (value >= 70) return 'Healthy';
  if (value >= 55) return 'Watch';
  return 'Needs attention';
}

function lawnMetricRows(assessment = {}) {
  const scores = assessment.scores || {};
  return [
    ['Density / Coverage', scores.turfDensity],
    ['Weed Cleanliness', scores.weedSuppression],
    ['Color / Nutrients', scores.colorHealth],
    ['Stress / Damage', scores.stressDamage],
  ];
}

function formatIrrigationInches(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  return `${String(Number(n.toFixed(2))).replace(/\.00$/, '')}" / week`;
}

function formatWaterInches(value) {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return '';
  return `${String(Number(n.toFixed(2))).replace(/\.00$/, '')}"`;
}

function lawnWaterLine(water = {}) {
  const dailyTotal = formatWaterInches(water.effectiveInchesToday);
  const dailyIrrigation = formatWaterInches(water.irrigationInchesPerDay);
  const dailyRain = formatWaterInches(water.rainfallInchesToday);
  const weeklyTotal = formatWaterInches(water.effectiveInches7d);
  const weeklyRain = formatWaterInches(water.rainfallInches7d);
  const target = formatWaterInches(water.targetInchesPerWeek);

  if (weeklyTotal && weeklyRain) {
    return `Estimated weekly water: ${weeklyTotal} including ${weeklyRain} recorded rainfall. Target is about ${target || '1"'} per week before site adjustments.`;
  }
  if (dailyTotal && dailyIrrigation && dailyRain) {
    return `Estimated water today: ${dailyTotal} from about ${dailyIrrigation} scheduled irrigation plus ${dailyRain} recorded rainfall. Target is about ${target || '1"'} per week before site adjustments.`;
  }
  if (dailyRain) {
    return `Rainfall accounted for today: ${dailyRain} recorded near the property. Target is about ${target || '1"'} per week before site adjustments.`;
  }
  if (dailyIrrigation) {
    return `Estimated irrigation: ${dailyIrrigation} per day from the weekly setting. Rainfall was not recorded for this visit.`;
  }
  return '';
}

// Water-balance block: compares what the lawn receives (scheduled irrigation +
// rainfall) to the grass×season recommendation. Surplus reads as over-watering
// (the fungus/mushroom cross-check); deficit as drought stress. When no schedule
// is on file it prompts the customer to add it (deep-links to My Property).
function LawnWaterBalance({ water = {}, grassLabel = 'lawn', mode = 'live', overwateringObserved = false }) {
  const advice = water?.irrigationAdvice;
  if (!advice) {
    const line = lawnWaterLine(water);
    return line ? <div className="lawn-water-line">{line}</div> : null;
  }
  const recommended = formatWaterInches(advice.recommendedInchesPerWeek);

  if (advice.profileMissing) {
    return (
      <div className="lawn-water-line lawn-water-balance" data-water-status="unknown">
        We recommend about <strong>{recommended}/week</strong> of total water (rain + irrigation) for your {grassLabel} this time of year.{' '}
        {mode === 'live'
          ? <a className="lawn-water-cta" href="/?tab=property">Add your irrigation schedule</a>
          : <span>Add your irrigation schedule in the portal</span>}{' '}
        so we can tailor this to your lawn.
      </div>
    );
  }

  const applied = formatWaterInches(advice.appliedInchesPerWeek);
  const gap = formatWaterInches(Math.abs(Number(advice.differentialInchesPerWeek) || 0));
  // When rainfall is known, `applied` is the total water on the lawn (irrigation
  // + rain); when it isn't (a surplus driven by irrigation alone), `applied` is
  // irrigation only — so don't claim rain is part of the number in that case.
  const gettingPhrase = advice.rainKnown
    ? <>Your lawn is getting about <strong>{applied}/week</strong> of water (irrigation + rain)</>
    : <>You're applying about <strong>{applied}/week</strong> of irrigation</>;
  let message;
  if (advice.status === 'surplus') {
    message = overwateringObserved
      ? <>{gettingPhrase} — roughly {gap} more than the ~{recommended} your {grassLabel} needs this season, and the fungal/mushroom signs in today's photos line up with over-watering. Easing back on irrigation should reduce them along with weed pressure.</>
      : <>{gettingPhrase} — roughly {gap} more than the ~{recommended} your {grassLabel} needs this season. Easing back on irrigation can reduce fungus, mushrooms, and weed pressure.</>;
  } else if (advice.status === 'deficit') {
    message = <>{gettingPhrase} — roughly {gap} short of the ~{recommended} your {grassLabel} needs this season.</>;
  } else if (advice.status === 'rain_unknown') {
    message = <>You're applying about <strong>{applied}/week</strong> of irrigation. We couldn't read recent rainfall to finish the water balance — the seasonal target for your {grassLabel} is about {recommended}/week.</>;
  } else {
    message = <>{gettingPhrase}, right around the ~{recommended} target for this season.</>;
  }
  return <div className="lawn-water-line lawn-water-balance" data-water-status={advice.status}>{message}</div>;
}

// Mowing height-of-cut block: Waves measures the maintained height of cut during
// the visit and advises against the grass's ideal band. We don't mow, so the copy
// speaks to how the lawn is being kept — never "we'll fix it". `below` is the
// only alert state (scalping/stress). The QA marker is internal-only (never on
// the customer 'live' surface).
// Standalone — renders from top-level data.mowingHeight so it shows on lawn
// reports even without a vision assessment. Derives its own grass label. No QA
// marker: the report is customer-facing across all modes (incl. ?mode=pdf), so
// internal verification status never appears here (it lives in the admin queue).
function LawnMowingHeight({ mowing }) {
  if (!mowing || mowing.heightIn == null) return null;
  const g = mowing.grassType;
  const grassLabel = g && g !== 'unknown' && g !== 'mixed' ? formatEnumLabel(g) : 'lawn';
  const h = <strong>{mowing.heightIn}&Prime;</strong>;
  const band = mowing.bandLabel;
  let message;
  if (mowing.status === 'below') {
    message = <>Your {grassLabel} is being cut low at {h} (ideal {band}) — raising the mower helps avoid scalping and stress.</>;
  } else if (mowing.status === 'above') {
    message = <>Your {grassLabel} is running a bit long at {h} — easing toward the {band} range keeps it healthiest.</>;
  } else {
    message = <>Your {grassLabel} is being kept at {h} — right in the ideal {band} range.</>;
  }
  return (
    <div className="lawn-water-line lawn-mowing-height" data-mowing-status={mowing.status}>
      <span className="lawn-mowing-label">Mowing height</span> {message}
    </div>
  );
}

function lawnAssessmentBody(assessment = {}) {
  const snapshotSummary = String(assessment.snapshot?.summary || '').trim();
  if (snapshotSummary) return snapshotSummary;
  const snapshotFinding = (assessment.snapshot?.findings || [])
    .map((finding) => String(finding.customerCopy || '').trim())
    .find(Boolean);
  if (snapshotFinding) return snapshotFinding;
  const observations = String(assessment.observations || assessment.scores?.observations || '').trim();
  if (observations) return observations;
  const profile = assessment.turfProfile;
  // The data-driven water balance (target vs. portal irrigation + rainfall) lives
  // in LawnWaterBalance; we no longer surface a tech's manual wet/dry observation.
  const rawGrass = String(profile?.grassType || '').toLowerCase().trim();
  if (rawGrass && rawGrass !== 'unknown' && rawGrass !== 'mixed') {
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
    minHeight: 48,
    padding: '0 18px',
    borderRadius: 10,
    border: isPrimary ? `1px solid ${ESTIMATE_BUTTON_BG}` : `1px solid ${ESTIMATE_BORDER}`,
    background: isPrimary ? ESTIMATE_BUTTON_BG : '#FFFFFF',
    color: isPrimary ? '#FFFFFF' : ESTIMATE_TEXT,
    fontFamily: FONT_BODY,
    fontWeight: 700,
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
        <>
          {neighborhood.customerSummary && (
            <p className="neighborhood-pressure-summary">{neighborhood.customerSummary}</p>
          )}
          <div className="pressure-legend">
            <span>Your home</span>
            <span>Nearby WaveGuard average</span>
          </div>
        </>
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
              {formatShortDate(point.date) || `V${index + 1}`}
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
  const irrigationInches = formatIrrigationInches(profile?.irrigationInchesPerWeek);
  // Only present a grass type the assessment is confident about. 'unknown'/'mixed'
  // are AI fallbacks, not a detected species — surfacing them as fact ("Unknown",
  // "for your Unknown") leaks the assumption to the customer, so they fall back to
  // a generic "your lawn" / no chip. Real detections (St. Augustine, etc.) show.
  const rawGrass = String(profile?.grassType || '').toLowerCase().trim();
  const hasKnownGrass = !!rawGrass && rawGrass !== 'unknown' && rawGrass !== 'mixed';
  const grassLabel = hasKnownGrass ? formatEnumLabel(profile.grassType) : 'lawn';
  // Over-watering evidence for the water-balance cross-link: the explicit vision
  // signal (mushrooms/standing water), or — for older assessments without it — a
  // low fungus-control score (moderate+ fungal activity) as a proxy.
  const fungusControl = Number(assessment.scores?.fungusControl);
  const overwateringObserved = assessment.overwateringSignal === true
    || (Number.isFinite(fungusControl) && fungusControl > 0 && fungusControl <= 50);
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
                hasKnownGrass ? formatEnumLabel(profile.grassType) : null,
                profile.lawnSqft ? `${Number(profile.lawnSqft).toLocaleString()} sq ft turf` : null,
                profile.irrigationType ? `${formatEnumLabel(profile.irrigationType)} irrigation` : null,
                irrigationInches ? `${irrigationInches} irrigation` : null,
              ].filter(Boolean).join(' · ')}
            </div>
          )}
        </div>
        <LawnTrendChart trend={assessment.trend || []} summary={assessment.customerSummary} />
      </div>
      <LawnWaterBalance water={assessment.waterContext} grassLabel={grassLabel} mode={mode} overwateringObserved={overwateringObserved} />
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

function LawnProtocolCard({ protocol }) {
  const window = protocol?.window;
  if (!protocol || !window) return null;
  const tasks = Array.isArray(window.requiredTasks) ? window.requiredTasks : [];
  const products = Array.isArray(protocol.products) ? protocol.products : [];
  const complianceGate = (protocol.gates || []).find((gate) => gate.type === 'ordinance');
  const serviceNote = window.customerNoteTemplates?.[0];
  const equipment = protocol.equipment || {};
  const calibration = protocol.calibration || {};
  const application = protocol.application || {};
  const assignment = protocol.assignment || {};
  const inventory = application.inventory || {};
  const substitutions = Array.isArray(application.substitutions) ? application.substitutions : [];
  const appliedCarrier = application.carrierGalPer1000 ?? calibration.carrierGalPer1000 ?? window.defaultCarrierGalPer1000;
  const sourceLabel = protocol.source === 'completion_ledger'
    ? 'Completed visit'
    : protocol.source === 'appointment_assignment'
      ? 'Assigned appointment'
      : 'Seasonal protocol';

  return (
    <section className="sr-section lawn-protocol-section" id="lawn-protocol">
      <h2>Seasonal lawn protocol</h2>
      <p>{window.goal || 'Today’s lawn visit followed the current St. Augustine seasonal protocol for this property.'}</p>
      <div className="sr-grid-3">
        <div className="sr-cell">
          <div className="sr-cell-label">Program window</div>
          <div className="sr-cell-value">{window.title}</div>
        </div>
        <div className="sr-cell">
          <div className="sr-cell-label">Production mode</div>
          <div className="sr-cell-value">{String(window.productionMode || '').replace(/_/g, ' ') || 'Protocol route'}</div>
        </div>
        <div className="sr-cell">
          <div className="sr-cell-label">Carrier target</div>
          <div className="sr-cell-value">{appliedCarrier ? `${appliedCarrier} gal / 1,000 sq ft` : 'Scout or premium route'}</div>
        </div>
        <div className="sr-cell">
          <div className="sr-cell-label">Report source</div>
          <div className="sr-cell-value">{sourceLabel}</div>
        </div>
        <div className="sr-cell">
          <div className="sr-cell-label">Equipment</div>
          <div className="sr-cell-value">{equipment.systemName || 'Calibrated equipment'}</div>
        </div>
        <div className="sr-cell">
          <div className="sr-cell-label">Calibration</div>
          <div className="sr-cell-value">
            {calibration.status === 'field_verified' ? 'Field verified' : formatEnumLabel(calibration.status || 'Recorded')}
          </div>
        </div>
      </div>
      {(application.treatedSqft || application.totalCarrierGal || calibration.verifiedAt || assignment.assignedAt) && (
        <div className="supporting-detail-card" style={{ marginTop: 12 }}>
          <div className="sr-cell-label">Application record</div>
          <p>
            {[
              application.treatedSqft ? `${Number(application.treatedSqft).toLocaleString()} sq ft treated` : null,
              application.totalCarrierGal ? `${application.totalCarrierGal} gallons carrier used` : null,
              inventory.deductedCount ? `${inventory.deductedCount} inventory deduction${inventory.deductedCount === 1 ? '' : 's'} recorded` : null,
              calibration.verifiedAt ? `calibration verified ${formatDate(calibration.verifiedAt)}` : null,
              assignment.assignedAt && !application.treatedSqft ? `assigned ${formatDate(assignment.assignedAt)}` : null,
            ].filter(Boolean).join(' · ')}
          </p>
        </div>
      )}
      {complianceGate && (
        <div className="supporting-detail-card" style={{ marginTop: 12 }}>
          <div className="sr-cell-label">Compliance gate</div>
          <p>{complianceGate.ruleText}</p>
        </div>
      )}
      {tasks.length > 0 && (
        <div className="supporting-detail-card" style={{ marginTop: 12 }}>
          <div className="sr-cell-label">Field checks tied to this visit</div>
          <p>{tasks.map((task) => formatEnumLabel(task)).join(', ')}</p>
        </div>
      )}
      {application.expectedResponse?.window && (
        <div className="supporting-detail-card" style={{ marginTop: 12 }}>
          <div className="sr-cell-label">What we are watching next</div>
          <p>{application.expectedResponse.window}</p>
        </div>
      )}
      {substitutions.length > 0 && (
        <div className="supporting-detail-card" style={{ marginTop: 12 }}>
          <div className="sr-cell-label">Approved product substitution</div>
          <p>
            {substitutions.map((sub) => (
              `${sub.substituteProductName || 'Approved substitute'} used in place of ${sub.originalProductName || 'the planned product'}`
            )).join(' · ')}
          </p>
        </div>
      )}
      {products.length > 0 && (
        <details className="solution-detail report-accordion">
          <summary>
            <span>Protocol products and gates</span>
            <span className="accordion-action">Details</span>
          </summary>
          <div className="accordion-body solution-detail-body">
            {products.slice(0, 8).map((product) => (
              <div className="solution-product-detail" key={product.id || product.productName}>
                <div className="solution-product-name">{product.productName}</div>
                <p>
                  {formatEnumLabel(product.role)}
                  {product.ratePer1000 != null ? ` · ${product.ratePer1000} ${product.rateUnit || ''}/1,000 sq ft` : ' · label-rate or condition-gated'}
                </p>
              </div>
            ))}
          </div>
        </details>
      )}
      {serviceNote && <p className="smart-status-detail">{serviceNote}</p>}
    </section>
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
  const completionTime = getReportCompletionTime(data);
  const completionDisplayTime = formatTimelineTime(completionTime);
  const nowMs = useReadinessNow(data.dynamicContext?.reentry, mode);
  const readinessBadge = readinessStatusBadge(data.dynamicContext?.reentry, mode, nowMs);
  const smartStatus = smartStatusSummary(data, mode, nowMs);
  const completedEvent = (data.workflowEvents || []).find((event) => event.type === 'service_completed');
  const completionStatus = completionDisplayTime ? 'Completed' : (completedEvent?.status === 'pending' ? 'In progress' : 'Completed');
  const firstName = String(data.customerName || '').trim().split(/\s+/)[0] || 'there';
  const serviceLabel = serviceDisplayName(data);
  const serviceDateTime = serviceReportDateTimeLabel(data);

  return (
    <section className="service-report-hero" id="service-status">
      <div className="service-report-hero-copy">
        <div className="section-eyebrow">Service report{serviceLabel ? ` · ${serviceLabel}` : ''}</div>
        <h1 className="sr-title">Hey {firstName}, {smartStatus.heading}</h1>
        {data.serviceAddress && <div className="service-meta-address">{data.serviceAddress}</div>}
      </div>
      <div className="service-status-card">
        <div className="service-status-main">
          <div>
            <div className="section-eyebrow">Today&apos;s result</div>
            <div className="smart-status-result">{smartStatus.result}</div>
            <div className="sr-meta">{[serviceLabel, serviceDateTime].filter(Boolean).join(' | ')}</div>
          </div>
          {(smartStatus.status || readinessBadge) && (
            <div className={`status-badge status-${smartStatus.statusTone || (readinessBadge?.ready ? 'ready' : 'pending')}`}>
              {smartStatus.status || readinessBadge.label}
            </div>
          )}
        </div>
        <div className="service-status-grid">
          <div className="sr-cell">
            <div className="sr-cell-label">What Waves did today</div>
            <div className="sr-cell-value">{smartStatus.completedLine}</div>
          </div>
          <div className="sr-cell">
            <div className="sr-cell-label">Technician</div>
            <div className="sr-cell-value">{technician}</div>
          </div>
          <div className="sr-cell">
            <div className="sr-cell-label">Completion status</div>
            <div className="sr-cell-value">{completionStatus}</div>
          </div>
        </div>
        {smartStatus.detail && <p className="smart-status-detail">{smartStatus.detail}</p>}
        <HeroConditions
          conditions={data.conditions || {}}
          weatherCall={data.dynamicContext?.premiumExperience?.weatherCall}
        />
      </div>
    </section>
  );
}

// Shown to staff viewing an internal-only (shadow) report in place of the
// download/share bar: no PDF is rendered for these records and the public
// link 404s for customers, so every control there would dead-end. Customers
// never reach this page for suppressed reports (the server 404s them).
function InternalReviewBar() {
  return (
    <section className="report-action-bar" aria-label="Internal review notice">
      <div className="section-eyebrow">Internal Review</div>
      <h2 className="report-action-title">Not sent to the customer</h2>
      <p className="report-action-copy">
        This report is stored for staff review only. Download and share become
        available once this service type graduates to customer delivery.
      </p>
    </section>
  );
}

function ReportActionBar({ pdfUrl, token, onShare }) {
  return (
    <section className="report-action-bar" aria-label="Report tools">
      <div className="section-eyebrow">Report Tools</div>
      <h2 className="report-action-title">Download, share, or print</h2>
      <p className="report-action-copy">For your records.</p>
      <div className="report-action-buttons">
        {pdfUrl
          ? <a href={pdfUrl} download onClick={() => trackReportEvent(token, 'pdf_downloaded')} style={actionButtonStyle('primary')}><Download size={16} /> Download PDF</a>
          : <span style={{ ...actionButtonStyle('primary'), opacity: 0.45, cursor: 'not-allowed' }} aria-disabled="true"><Download size={16} /> Download PDF</span>}
        <button type="button" onClick={onShare} style={actionButtonStyle('primary')}><Share2 size={16} /> Share</button>
        <button type="button" onClick={() => window.print()} style={actionButtonStyle('primary')}><Printer size={16} /> Print</button>
        <a href="/login" style={actionButtonStyle('primary')}><Lock size={16} /> Portal Login</a>
      </div>
    </section>
  );
}

function ReentryReadinessCard({ context, mode, token }) {
  const nowMs = useReadinessNow(context, mode);
  const readiness = readinessSummary(context, mode, nowMs);
  const targets = Array.isArray(context?.targets) ? context.targets : [];
  const timezone = context?.displayTimezone || SERVICE_REPORT_TIME_ZONE;

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
      {targets.length > 0 && (
        <div className="reentry-target-grid readiness-target-grid" aria-label="Re-entry ready times">
          {targets.map((target) => (
            <ReentryTargetTile
              key={target.key || target.label || target.readyAt}
              target={target}
              nowMs={nowMs}
              mode={mode}
              timezone={timezone}
            />
          ))}
        </div>
      )}
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
      {rows.length > 0 && (
        <div className="hero-condition-row">
          {rows.map(([label, value]) => (
            <div className="hero-condition-cell" key={label}>
              <div className="sr-cell-label">{label}</div>
              <div className="sr-cell-value">{value}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function reportAskPrompts(data = {}, serviceLine = 'pest') {
  const prompts = [];
  const add = (text) => {
    const clean = String(text || '').trim();
    if (clean && !prompts.some((prompt) => prompt.toLowerCase() === clean.toLowerCase())) prompts.push(clean);
  };
  const product = uniqueStrings((data.applications || []).map((app) => applicationProductName(app)))[0];
  const hasReentry = Array.isArray(data.dynamicContext?.reentry?.targets) && data.dynamicContext.reentry.targets.length > 0;
  const coverage = normalizeServiceCoverage(data);
  const hasCoverage = Array.isArray(coverage?.items) && coverage.items.length > 0;
  const hasPressure = data.pestPressure
    && data.pestPressure.showOnCustomerReport !== false
    && data.pestPressure.enabled !== false;
  const hasInaccessible = hasCoverage && coverage.items.some((item) => isInaccessibleCoverageStatus(item.status));

  if (hasReentry) add('Is it safe to re-enter now?');
  if (hasCoverage) add('What areas were treated?');
  if (product) add(`Why was ${product} used?`);
  else if ((data.applications || []).length) add('Why were these products used?');
  if (hasPressure) add('What does Pest Pressure mean?');
  if (hasInaccessible) add('What should I do about the inaccessible area?');
  add(serviceLine === 'lawn' ? 'How is my lawn trending?' : 'What should I watch for next?');
  add('When is my next service?');
  return prompts.slice(0, 5);
}

function ReportAskBox({ mode, token, serviceLine, data }) {
  const placeholder = serviceLine === 'lawn' ? 'Ask about this lawn visit' : 'Ask about today’s service';
  const prompts = reportAskPrompts(data, serviceLine);
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
      <div className="section-eyebrow">Ask Waves</div>
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
          aria-label="Ask Waves about this service report"
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

export function quickNavigationLinks({ hasProducts = true, hasVisitTimeline = true, hasPestPressure = false, hasReentry = false, hasActivity = false, hasCoverageMap = true } = {}) {
  return [
    ['#visit-summary', 'Summary'],
    hasReentry ? ['#re-entry', 'Re-entry'] : null,
    hasVisitTimeline ? ['#service-timeline', 'Timeline'] : null,
    // The Map link targets the coverage card's anchor; lawn/tree-shrub reports
    // hide that card, so the link would jump nowhere — omit it there.
    hasCoverageMap ? ['#service-coverage', 'Map'] : null,
    hasProducts ? ['#products-applied', 'Products'] : null,
    hasPestPressure ? ['#pest-pressure', 'Pest Pressure'] : null,
    hasActivity ? ['#activity', 'Activity'] : null,
  ].filter(Boolean);
}

function QuickNavigationAndAsk({ mode, token, serviceLine, data, hasProducts = true, hasVisitTimeline = true, hasPestPressure = false, hasReentry = false, hasActivity = false }) {
  const hasCoverageMap = !(serviceLine === 'lawn' || /tree|shrub/.test(String(serviceLine || '')));
  const links = quickNavigationLinks({ hasProducts, hasVisitTimeline, hasPestPressure, hasReentry, hasActivity, hasCoverageMap });

  return (
    <section className="sr-section quick-report-tools" id="quick-navigation">
      <div className="coverage-section-header">
        <div>
          <h2>Need help with this report?</h2>
          <p className="map-context-copy">Ask Waves about this visit or jump to the section you need.</p>
        </div>
      </div>
      <nav className="quick-nav-row" aria-label="Service report sections">
        {links.map(([href, label]) => (
          <a href={href} key={href}>{label}</a>
        ))}
      </nav>
      <ReportAskBox mode={mode} token={token} serviceLine={serviceLine} data={data} />
    </section>
  );
}

/**
 * Today's Result — the opening card on typed specialty reports (rodent
 * trapping, bed bug, cockroach, etc.). Renders the customer summary that was
 * generated and persisted at completion time (typedReportSnapshot) — what was
 * found, what we did, what happens next — never recomputed client-side.
 */
function TodaysResultCard({ typedReport, sectionId = 'todays-result' }) {
  const result = typedReport?.todaysResult;
  if (!result?.headline) return null;
  return (
    <section className="report-card" data-section="todays-result" id={sectionId}>
      <div className="section-eyebrow">
        {typedReport.isProgressVisit ? typedReport.reportTypeLabel : "Today's result"}
      </div>
      <h2>{result.headline}</h2>
      {result.body && <p className="ai-summary-body">{result.body}</p>}
      {/* The snapshot builder embeds nextStep in body on most paths — only
          render the bullet when it adds something the paragraph doesn't. */}
      {result.nextStep && !(result.body || '').includes(result.nextStep) && (
        <div className="ai-summary-bullets">
          <div className="ai-summary-bullet">{result.nextStep}</div>
        </div>
      )}
    </section>
  );
}

/**
 * Findings on typed specialty reports — rendered from the snapshot's
 * customer-labeled items (reportPriority order resolved at completion).
 * Zero-state values ("No active signs observed today") are results and
 * render like any other finding.
 */
function TypedFindingsCard({ typedReport, sectionId = 'typed-findings' }) {
  const items = typedReport?.findings;
  if (!Array.isArray(items) || !items.length) return null;
  return (
    <section className="sr-section" id={sectionId} data-section="typed-findings">
      <h2>What we found & did</h2>
      <dl style={{ margin: 0, display: 'grid', gap: 12 }}>
        {items.map((item) => (
          <div key={item.fieldKey} style={{ borderBottom: '1px solid #F1F5F9', paddingBottom: 10 }}>
            <dt style={{ fontSize: 12, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#6B7280', fontWeight: 700, marginBottom: 2 }}>
              {item.customerLabel}
            </dt>
            <dd style={{ margin: 0, fontSize: 14, color: '#1B2C5B', lineHeight: 1.5 }}>
              {item.customerValueLabel != null && item.customerValueLabel !== ''
                ? String(item.customerValueLabel)
                : String(item.value)}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * Heading for a companion typed section (combined-service-completions.md) —
 * combined services complete once and render the primary content first,
 * then one block per companion. internal-only entries only ever arrive for
 * STAFF viewers (the server omits them from customer payloads entirely);
 * they reuse the InternalReviewBar visual treatment as a per-section notice.
 */
function CompanionSectionHeader({ companion }) {
  const title = companion.typeLabel || companion.reportTypeLabel || 'Additional service';
  if (companion.internalOnly) {
    return (
      <section className="report-action-bar" aria-label="Internal review notice">
        <div className="section-eyebrow">Internal Review</div>
        <h2 className="report-action-title">{title}</h2>
        <p className="report-action-copy">
          This section is stored for staff review only. The customer copy of
          this report does not include it.
        </p>
      </section>
    );
  }
  return (
    <section className="sr-section" data-section="companion-heading">
      <div className="section-eyebrow">Also completed this visit</div>
      <h2 style={{ margin: 0 }}>{title}</h2>
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

export function reviewRequestCopy(placement = 'top') {
  if (placement === 'bottom') {
    return {
      title: 'Help the next neighbor choose faster',
      cta: 'Share feedback',
    };
  }
  return {
    title: "How did today's visit go?",
    cta: 'Share feedback',
  };
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

export function customerActionItems({ data = {}, coverage, primaryMove, aiSummary, nowMs } = {}) {
  const actions = [];
  const add = (label, detail) => {
    const clean = String(label || '').trim();
    if (!clean || actions.some((action) => action.label.toLowerCase() === clean.toLowerCase())) return;
    actions.push({ label: clean, detail: String(detail || '').trim() });
  };
  const actionNeededCoverage = (coverage?.items || []).find((item) => isActionNeededCoverageStatus(item.status));
  const finding = recommendedFinding(data.findings || []);
  const seriousFinding = highPriorityFindings(data)[0];
  const pendingTarget = latestPendingReentryTarget(data.dynamicContext?.reentry?.targets, nowMs);

  if (primaryMove?.title) add(primaryMove.title, primaryMove.why || primaryMove.impact);
  if (finding?.recommendation) add(finding.recommendation, finding.detail || finding.title);
  if (seriousFinding && !finding?.recommendation) {
    add(
      seriousFinding.title
        ? `Review the documented activity: ${seriousFinding.title}.`
        : 'Review the documented high-priority activity.',
      seriousFinding.detail || 'Waves documented activity that needs attention in this report.',
    );
  }
  if (aiSummary?.recommendedNextStep?.text) add(aiSummary.recommendedNextStep.text);
  if (actionNeededCoverage) {
    const area = actionNeededCoverage.areaName || 'the flagged area';
    if (isInaccessibleCoverageStatus(actionNeededCoverage.status)) {
      add(`Request a follow-up for ${area}.`, actionNeededCoverage.customerDescription);
    } else {
      add(
        `Review ${area} marked ${coverageStatusConfig(actionNeededCoverage.status).label.toLowerCase()}.`,
        actionNeededCoverage.customerDescription,
      );
    }
  }
  if (pendingTarget) {
    add(
      `Wait until ${formatReadyTime(pendingTarget.readyAt, data.dynamicContext?.reentry?.displayTimezone)} before using treated ${String(pendingTarget.label || 'areas').toLowerCase()}.`,
      data.dynamicContext?.reentry?.petAdvisory,
    );
  }
  return actions.slice(0, 3);
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

function AppliedProductsSection({ data, mode = 'live' }) {
  const applications = Array.isArray(data.applications) ? data.applications : [];
  if (!applications.length) return null;
  const isLawn = data.serviceLine === 'lawn';
  const zoneById = new Map((data.zones || []).map((zone) => [String(zone.id), zone]));
  const substitutions = Array.isArray(data.dynamicContext?.lawnProtocol?.application?.substitutions)
    ? data.dynamicContext.lawnProtocol.application.substitutions
    : [];
  const substitutionByName = new Map(
    substitutions
      .filter((sub) => sub.substituteProductName)
      .map((sub) => [String(sub.substituteProductName).toLowerCase(), sub]),
  );

  return (
    <section className="sr-section applied-products-section" id="products-applied">
      <div className="applied-products-header">
        <div>
          <h2>Products Applied</h2>
          <p>Why these products were selected for today&apos;s service.</p>
        </div>
      </div>
      {isLawn && (
        <div className="manufacturer-guideline-note">
          <strong>Following the manufacturer&apos;s directions.</strong> Every product below is
          applied to its manufacturer&apos;s label directions, and each card shows who makes it.
          Once today&apos;s application has dried, your normal watering schedule is fine — your
          technician&apos;s service notes call out anything specific for today&apos;s products.
        </div>
      )}
      {applications.length > 0 && (
        <div className="applied-products-grid">
          {applications.map((app, index) => {
            const productName = applicationProductName(app);
            const active = applicationActiveIngredient(app);
            const epa = applicationEpaReg(app);
            const purpose = applicationPurpose(app, data.serviceLine);
            const why = applicationPurposeCopy(app, data.serviceLine);
            const usedIn = applicationZoneText(app, zoneById);
            const productSummary = applicationProductSummary(app);
            const precautionSummary = applicationPrecautionSummary(app);
            const reentrySummary = applicationReentrySummary(app);
            const manufacturer = applicationManufacturer(app);
            const watering = isLawn ? lawnWateringGuidance(app) : null;
            const substitution = substitutionByName.get(String(productName).toLowerCase());
            const technicalFacts = [
              epa ? `EPA reg. ${epa}` : null,
              app.product?.facts_approved ? 'Approved product facts' : null,
              app.rate && app.rateUnit ? `Rate: ${app.rate} ${app.rateUnit}` : null,
              app.totalAmount && app.amountUnit ? `Total: ${app.totalAmount} ${app.amountUnit}` : null,
              substitution ? `Approved substitute for ${substitution.originalProductName || 'planned protocol product'}` : null,
            ].filter(Boolean);
            return (
              <article className="applied-product-card product-group-card" key={app.id || `${productName}-${index}`}>
                <h3>{productName}</h3>
                {isLawn && manufacturer && (
                  <div className="applied-product-maker">by {manufacturer}</div>
                )}
                <div className="product-purpose-grid">
                  <div>
                    <div className="sr-cell-label">Purpose</div>
                    <p>{purpose}</p>
                  </div>
                  <div>
                    <div className="sr-cell-label">Used in</div>
                    <p>{usedIn}</p>
                  </div>
                  {active && (
                    <div>
                      <div className="sr-cell-label">Active ingredient</div>
                      <p>{active}</p>
                    </div>
                  )}
                </div>
                <div className="product-why">
                  <div className="sr-cell-label">Why used today</div>
                  <p>
                    {substitution
                      ? `This approved seasonal equivalent was used for today's protocol window. ${why}`
                      : why}
                  </p>
                </div>
                {productSummary && (
                  <div className="product-why">
                    <div className="sr-cell-label">Product note</div>
                    <p>{productSummary}</p>
                  </div>
                )}
              <details className="solution-detail report-accordion" open={mode !== 'live'}>
                <summary>
                  <span>More information</span>
                  <span className="accordion-action">Details</span>
                </summary>
                <div className="accordion-body solution-detail-body">
                  <div className="solution-product-detail">
                    <div className="solution-product-name">{productName}</div>
                    {technicalFacts.length > 0 && (
                      <div className="solution-product-facts">{technicalFacts.join(' | ')}</div>
                    )}
                    {applicationTechnicalExplanation(app, data.serviceLine).map((detail) => (
                      <p key={detail}>{detail}</p>
                    ))}
                    {precautionSummary && <p>{precautionSummary}</p>}
                    {reentrySummary && <p>{reentrySummary}</p>}
                    {watering && (
                      <div className="product-watering-guidance">
                        <div className="sr-cell-label">Watering after this application</div>
                        <p className="watering-headline">{watering.headline}</p>
                        <p>{watering.detail}</p>
                      </div>
                    )}
                    {isLawn && manufacturer && (
                      <p className="product-manufacturer-line">
                        Manufacturer: {manufacturer}. Applied to the manufacturer&apos;s label directions.
                      </p>
                    )}
                  </div>
                </div>
              </details>
            </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function LawnProgramOverviewCard({ context }) {
  if (!context) return null;
  const facts = [
    context.turfType ? { label: 'Turf program', value: context.turfType } : null,
    context.referenceAt ? { label: context.contextVerb === 'sent' ? 'Outline sent' : 'Outline recorded', value: formatDate(context.referenceAt) } : null,
    Number(context.viewCount || 0) > 0 ? { label: 'Client views', value: String(context.viewCount) } : null,
    Number(context.productCardCount || 0) > 0 ? { label: 'Product facts', value: `${context.productCardCount} reviewed` } : null,
  ].filter(Boolean);

  return (
    <section className="report-card lawn-program-overview-card" data-section="lawn-program-overview">
      <div className="lawn-program-heading">
        <div className="lawn-program-icon" aria-hidden="true">
          <FileCheck2 size={20} />
        </div>
        <div>
          <div className="section-eyebrow">Lawn care program</div>
          <h2>{context.linked ? 'Program overview linked to this report' : 'How this report fits your lawn program'}</h2>
        </div>
      </div>
      <p className="lawn-program-copy">{context.contextCopy}</p>
      <p className="lawn-program-distinction">{context.distinctionCopy}</p>
      {facts.length > 0 && (
        <div className="lawn-program-facts">
          {facts.map((fact) => (
            <div className="lawn-program-fact" key={fact.label}>
              <div className="sr-cell-label">{fact.label}</div>
              <strong>{fact.value}</strong>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

const COVERAGE_VIEWBOX = { width: 640, height: 340, padding: 28 };
const COVERAGE_STATUSES = {
  completed: { label: 'Completed', tone: 'green', Icon: CheckCircle2 },
  treated: { label: 'Treated', tone: 'green', Icon: CheckCircle2 },
  partially_treated: { label: 'Partially treated', tone: 'light-green', Icon: CheckCircle2 },
  serviced: { label: 'Completed', tone: 'green', Icon: CheckCircle2 },
  inspected: { label: 'Inspected', tone: 'blue', Icon: Eye },
  checked: { label: 'Checked', tone: 'blue', Icon: MapPin },
  spot_treated: { label: 'Spot-treated', tone: 'blue', Icon: Eye },
  skipped: { label: 'Skipped', tone: 'orange', Icon: AlertTriangle },
  inaccessible: { label: 'Inaccessible', tone: 'orange', Icon: AlertTriangle },
  needs_attention: { label: 'Needs Attention', tone: 'orange', Icon: AlertTriangle },
  needs_follow_up: { label: 'Follow-Up Recommended', tone: 'orange', Icon: AlertTriangle },
  activity_found: { label: 'Activity found', tone: 'orange', Icon: MapPin },
  entry_point_found: { label: 'Entry point noted', tone: 'orange', Icon: MapPin },
  blocked: { label: 'Blocked', tone: 'red', Icon: Lock },
  device_checked: { label: 'Checked', tone: 'blue', Icon: MapPin },
  device_placed: { label: 'Placed', tone: 'green', Icon: MapPin },
  not_included: { label: 'Not included', tone: 'gray', Icon: AlertTriangle },
  not_serviced: { label: 'Not Serviced', tone: 'gray', Icon: AlertTriangle },
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

function normalizeServiceCoverageLine(...values) {
  const raw = values.map((value) => String(value || '').toLowerCase().replace(/[_-]+/g, ' ')).filter(Boolean).join(' ');
  if (raw.includes('tree') || raw.includes('shrub') || raw.includes('palm') || raw.includes('ornamental')) return 'tree_shrub';
  if (raw.includes('termite')) return 'termite';
  if (raw.includes('mosquito')) return 'mosquito';
  if (raw.includes('rodent') || raw.includes('rat') || raw.includes('mouse')) return 'rodent';
  if (raw.includes('lawn') || raw.includes('turf') || raw.includes('weed') || raw.includes('fertil')) return 'lawn';
  if (raw.includes('commercial')) return 'commercial';
  if (raw.includes('pest') || raw.includes('roach') || raw.includes('ant') || raw.includes('spider')) return 'pest';
  return 'other';
}

function normalizeCoverageStatus(status, actionTypes = []) {
  const raw = [status, ...[].concat(actionTypes || [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[_-]+/g, ' ');
  if (/\b(inaccessible|locked|no access|access issue|blocked)\b/.test(raw)) return 'inaccessible';
  if (/\b(needs attention|activity found|issue noted|customer action)\b/.test(raw)) return 'needs_attention';
  if (/\b(follow up|follow-up|return visit)\b/.test(raw)) return 'needs_follow_up';
  if (/\b(skip|skipped|weather)\b/.test(raw)) return 'skipped';
  if (/\b(not serviced|not included)\b/.test(raw)) return 'not_serviced';
  if (/\b(inspect|inspection|no activity found|entry point found)\b/.test(raw)) return 'inspected';
  if (/\b(station checked|device checked|checked|monitor)\b/.test(raw)) return 'checked';
  if (/\b(treat|treated|spot treated)\b/.test(raw)) return 'treated';
  return 'completed';
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
  if (status === 'completed' || status === 'treated' || status === 'serviced' || status === 'device_placed') return 'green';
  if (status === 'partially_treated') return 'light-green';
  if (status === 'inspected' || status === 'checked' || status === 'spot_treated' || status === 'device_checked') return 'blue';
  if (status === 'activity_found' || status === 'entry_point_found' || status === 'skipped' || status === 'inaccessible' || status === 'needs_attention' || status === 'needs_follow_up') return 'orange';
  if (status === 'blocked') return 'red';
  if (status === 'not_included' || status === 'not_serviced') return 'gray';
  return serviceType === 'lawn' ? 'green' : 'blue';
}

function coverageLegendLabel(key, serviceType, statuses) {
  if (key === 'green') return statuses.includes('treated') ? 'Treated' : 'Completed';
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
  if (status === 'completed' || status === 'treated' || status === 'serviced' || status === 'partially_treated') return 'A';
  return '!';
}

const DEFAULT_SERVICE_COVERAGE_COPY = {
  defaultTitle: 'Service Area Map',
  titleByServiceLine: {
    pest: 'Service Area Map',
    lawn: 'Lawn Service Area Map',
    termite: 'Inspection & Treatment Map',
    tree_shrub: 'Tree & Shrub Service Map',
    mosquito: 'Mosquito Service Area Map',
    rodent: 'Rodent Service Area Map',
    commercial: 'Service Area Map',
    other: 'Service Area Map',
  },
  introByServiceLine: {
    default: "Here's where your technician completed work, inspected, or marked an area as inaccessible during today's visit.",
    pest: "Here's where your technician completed pest control service, inspected, or marked an area as inaccessible during today's visit.",
    lawn: "Here's where your technician completed lawn service, inspected, or marked an area as inaccessible during today's visit.",
    termite: "Here's where your technician inspected, treated, checked stations, or marked an area as inaccessible during today's visit.",
    tree_shrub: "Here's where your technician inspected, treated, or marked landscape areas that need attention during today's visit.",
    mosquito: "Here's where your technician completed mosquito service, inspected, or marked an area as inaccessible during today's visit.",
    rodent: "Here's where your technician checked rodent service areas, inspected, or marked an area as inaccessible during today's visit.",
  },
  disclaimerText: 'Service coverage is based on technician-marked locations and available visit data. It is not a property survey.',
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
};

function coverageAreaKey(areaName) {
  const text = String(areaName || '').toLowerCase();
  if (/\bentry|door|window|threshold|opening|access point\b/.test(text)) return 'entry_points';
  if (/\bperimeter|foundation|exterior\b/.test(text)) return 'perimeter';
  if (/\bstation|bait\b/.test(text)) return 'station';
  if (/\bfront lawn|back lawn|side yard|turf|yard|lawn\b/.test(text)) return 'lawn';
  if (/\bplant|shrub|tree|palm|hedge|landscape\b/.test(text)) return 'plant';
  return 'generic';
}

function serviceCoverageDescription(location, { areaName, status, serviceLine }) {
  const explicit = String(
    location.customerDescription
    || location.customer_description
    || location.descriptionForCustomer
    || location.customerVisibleNote
    || location.customer_visible_note
    || '',
  ).trim();
  if (explicit && !/^(perimeter|entry points?|treated|serviced)$/i.test(explicit)) return explicit;

  const reason = String(location.inaccessibleReason || location.inaccessible_reason || location.skippedReason || location.skipped_reason || '').trim();
  const areaKey = coverageAreaKey(areaName);
  if (status === 'inaccessible') return reason ? `Technician could not access this area because ${reason}.` : 'Technician could not access this area.';
  if (status === 'needs_attention') return 'Technician noted an issue that may need attention.';
  if (status === 'skipped') return reason ? `Service was skipped because ${reason}.` : 'Service was skipped for this area.';
  if ((serviceLine === 'pest' || serviceLine === 'rodent' || serviceLine === 'mosquito') && areaKey === 'perimeter') return 'Exterior perimeter service completed.';
  if ((serviceLine === 'pest' || serviceLine === 'rodent' || serviceLine === 'mosquito') && areaKey === 'entry_points') return 'Entry points inspected and treated.';
  if (serviceLine === 'lawn') return String(location.status || '').toLowerCase().includes('weed') ? 'Weed control applied.' : 'Lawn treatment completed.';
  if (serviceLine === 'termite' && (areaKey === 'station' || status === 'checked')) return 'Station checked.';
  if (serviceLine === 'termite' && status === 'inspected') return 'Inspection completed.';
  if (serviceLine === 'tree_shrub') return 'Plant health treatment completed.';
  if (status === 'inspected') return `${areaName} inspected.`;
  if (status === 'treated') return `${areaName} treatment completed.`;
  return `${areaName} service completed.`;
}

function serviceCoverageSummary(items = []) {
  return items.reduce((summary, item) => {
    if (item.status === 'inspected' || item.status === 'checked') summary.inspectedCount += 1;
    else if (item.status === 'inaccessible') summary.inaccessibleCount += 1;
    else if (item.status === 'needs_attention' || item.status === 'needs_follow_up') summary.needsAttentionCount += 1;
    else summary.completedCount += 1;
    return summary;
  }, {
    completedCount: 0,
    inspectedCount: 0,
    inaccessibleCount: 0,
    needsAttentionCount: 0,
  });
}

function isCoverageItemVisible(location = {}) {
  return location.isVisibleToCustomer !== false
    && location.customerVisible !== false
    && location.customer_visible !== false
    && location.internalOnly !== true
    && location.internal_only !== true;
}

export function normalizeServiceCoverage(report = {}, configOverride = {}) {
  const config = {
    ...DEFAULT_SERVICE_COVERAGE_COPY,
    ...configOverride,
    titleByServiceLine: { ...DEFAULT_SERVICE_COVERAGE_COPY.titleByServiceLine, ...(configOverride.titleByServiceLine || {}) },
    introByServiceLine: { ...DEFAULT_SERVICE_COVERAGE_COPY.introByServiceLine, ...(configOverride.introByServiceLine || {}) },
    statusLabels: { ...DEFAULT_SERVICE_COVERAGE_COPY.statusLabels, ...(configOverride.statusLabels || {}) },
  };

  if (report.serviceCoverage?.enabled === false) return { ...report.serviceCoverage, enabled: false };
  if (report.serviceCoverage?.enabled) {
    return {
      ...report.serviceCoverage,
      title: report.serviceCoverage.title || config.defaultTitle,
      intro: report.serviceCoverage.intro || report.serviceCoverage.introText || config.introByServiceLine.default,
      disclaimer: report.serviceCoverage.disclaimer || config.disclaimerText,
      items: Array.isArray(report.serviceCoverage.items) ? report.serviceCoverage.items : [],
      settings: {
        showMap: true,
        showList: true,
        showSummaryCounts: true,
        defaultLayout: 'split',
        ...(report.serviceCoverage.settings || {}),
      },
    };
  }

  const serviceLine = normalizeServiceCoverageLine(report.serviceLine, report.serviceType, report.serviceDisplayName, report.coverageServiceType);
  const zoneById = new Map((report.zones || []).map((zone, index) => [String(zone.id), {
    ...zone,
    letter: zone.letter || String.fromCharCode(65 + (index % 26)),
  }]));
  const locations = Array.isArray(report.serviceLocations) ? report.serviceLocations.filter(isCoverageItemVisible) : [];
  const serviceAreas = Array.isArray(report.serviceAreas) ? report.serviceAreas.filter(Boolean) : [];
  const sourceRows = locations.length ? locations : serviceAreas.map((area, index) => ({
    id: `coverage_area_${index + 1}`,
    name: area,
    status: 'completed',
  }));
  const items = sourceRows.map((location, index) => {
    const zone = zoneById.get(String(location.zoneId || location.zone_id || ''));
    const status = normalizeCoverageStatus(location.status, location.actionTypes || location.action_types);
    const areaName = String(location.areaName || location.area_name || location.name || zone?.label || `Area ${index + 1}`).trim();
    const markerLabel = String(location.markerLabel || location.marker_label || zone?.letter || String.fromCharCode(65 + (index % 26))).trim();
    return {
      id: String(location.id || `coverage_item_${index + 1}`),
      serviceLine,
      markerLabel,
      areaName,
      customerDescription: serviceCoverageDescription(location, { areaName, status, serviceLine }),
      status,
      customerStatusLabel: config.statusLabels[status] || coverageStatusConfig(status).label,
      statusLabel: config.statusLabels[status] || coverageStatusConfig(status).label,
      zoneId: location.zoneId || location.zone_id || zone?.id || null,
      geometry: location.geometry || location.geometryGeoJson || location.geometry_geojson || zone?.geometryGeoJson || zone?.geometry || null,
      imageGeometry: location.imageGeometry || location.image_geometry || zone?.geometryImage || zone?.geometry_image || null,
      sortOrder: Number.isFinite(Number(location.sortOrder || location.sort_order)) ? Number(location.sortOrder || location.sort_order) : index,
    };
  }).filter((item, index, all) => all.findIndex((candidate) => (
    candidate.markerLabel === item.markerLabel
    && candidate.areaName.toLowerCase() === item.areaName.toLowerCase()
    && candidate.status === item.status
  )) === index);

  const itemsWithGeometry = items.filter(hasRenderableCoverageGeometry);
  if (!items.length && !itemsWithGeometry.length) return { enabled: false };
  const title = config.titleByServiceLine[serviceLine] || config.defaultTitle;
  const intro = config.introByServiceLine[serviceLine] || config.introByServiceLine.default;
  return {
    enabled: true,
    serviceLine,
    title,
    intro,
    introText: intro,
    address: report.propertyAddress || report.serviceAddress || '',
    serviceDate: report.serviceDate || '',
    disclaimer: config.disclaimerText,
    summary: serviceCoverageSummary(items),
    legend: coverageLegendItems(items, normalizeCoverageServiceType(serviceLine)),
    map: {
      available: itemsWithGeometry.length > 0,
      center: report.mapCenter || null,
      markers: itemsWithGeometry.map((item) => ({
        id: `marker_${item.id}`,
        coverageItemId: item.id,
        label: item.markerLabel,
        status: item.status,
        geometry: item.geometry,
      })),
      polygons: [],
      lines: [],
    },
    groups: [{ serviceLine, title, items }],
    items,
    settings: {
      showMap: true,
      showList: true,
      showSummaryCounts: true,
      defaultLayout: 'split',
    },
  };
}

function coverageAriaLabel(location) {
  const name = location.areaName || location.name || 'Service area';
  const detail = [
    location.statusLabel || location.customerStatusLabel || coverageStatusConfig(location.status).label,
    location.customerDescription,
    ...coverageSummaryParts(location, normalizeCoverageServiceType(location.serviceType)),
  ].filter(Boolean).join(', ');
  return `${location.markerLabel ? `${location.markerLabel}. ` : ''}${name}: ${detail}`;
}

function CoverageMapGeometry({ location, projection, active = false, onActivate }) {
  const geometry = location.geometry;
  const config = coverageStatusConfig(location.status);
  const toneClass = `status-${config.tone}`;
  const label = coverageAriaLabel(location);
  const center = coverageGeometryCenter(geometry, projection);
  const name = location.areaName || location.name || 'Service area';
  const labelText = location.status === 'skipped' || location.status === 'inaccessible'
    ? `${name} skipped`
    : location.status === 'activity_found'
      ? 'Activity noted'
      : location.status === 'entry_point_found'
        ? 'Entry point'
        : name;
  const activateProps = {
    tabIndex: 0,
    role: 'button',
    'aria-label': label,
    'aria-pressed': active ? 'true' : 'false',
    onClick: () => onActivate?.(location.id),
    onFocus: () => onActivate?.(location.id),
    onKeyDown: (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onActivate?.(location.id);
      }
    },
  };

  if (geometry.type === 'Polygon') {
    return (
      <g className={`coverage-geometry-group${active ? ' is-active' : ''}`} {...activateProps}>
        <path className={`coverage-area ${toneClass} status-${location.status}`} d={coveragePolygonPath(geometry.coordinates || [], projection)}>
          <title>{label}</title>
        </path>
        {center && <text x={center.x} y={center.y} className="coverage-map-label">{location.markerLabel || labelText}</text>}
      </g>
    );
  }
  if (geometry.type === 'MultiPolygon') {
    return (
      <g className={`coverage-geometry-group${active ? ' is-active' : ''}`} {...activateProps}>
        {(geometry.coordinates || []).map((polygon, index) => (
          <path key={`${location.id}-poly-${index}`} className={`coverage-area ${toneClass} status-${location.status}`} d={coveragePolygonPath(polygon, projection)}>
            <title>{label}</title>
          </path>
        ))}
        {center && <text x={center.x} y={center.y} className="coverage-map-label">{location.markerLabel || labelText}</text>}
      </g>
    );
  }
  if (geometry.type === 'LineString') {
    return (
      <g className={`coverage-geometry-group${active ? ' is-active' : ''}`} {...activateProps}>
        <path className={`coverage-line ${toneClass} status-${location.status}`} d={coverageLinePath(geometry.coordinates || [], projection)}>
          <title>{label}</title>
        </path>
        {center && <text x={center.x} y={center.y - 10} className="coverage-map-label">{location.markerLabel || labelText}</text>}
      </g>
    );
  }
  if (geometry.type === 'MultiLineString') {
    return (
      <g className={`coverage-geometry-group${active ? ' is-active' : ''}`} {...activateProps}>
        {(geometry.coordinates || []).map((line, index) => (
          <path key={`${location.id}-line-${index}`} className={`coverage-line ${toneClass} status-${location.status}`} d={coverageLinePath(line, projection)}>
            <title>{label}</title>
          </path>
        ))}
        {center && <text x={center.x} y={center.y - 10} className="coverage-map-label">{location.markerLabel || labelText}</text>}
      </g>
    );
  }
  if (geometry.type === 'Point') {
    const point = projectCoveragePoint(geometry.coordinates || [0, 0], projection);
    return (
      <g className={`coverage-marker ${toneClass} status-${location.status}${active ? ' is-active' : ''}`} transform={`translate(${point.x} ${point.y})`} {...activateProps}>
        <title>{label}</title>
        <circle r="16" className="coverage-marker-outer" />
        <circle r="12" className="coverage-marker-inner" />
        <text y="4.5" textAnchor="middle" className="coverage-marker-text">{location.markerLabel || coverageMarkerText(location.status)}</text>
        <text x="16" y="4" className="coverage-map-label coverage-point-label">{labelText}</text>
      </g>
    );
  }
  return null;
}

// Zone identity key for both list and map dedupe. markerLabel alone isn't
// stable — manual labels can collide, auto-labels wrap A-Z past 26 zones,
// and the same letter can appear in two different service-line groups.
// So we compose with areaName and prefix with the item's serviceLine
// (set by normalizeServiceCoverage on every item). Falls back to row id;
// finally to the array index when neither markerLabel nor id exists so
// markerless rows don't all collapse into one bucket.
function coverageZoneKey(item, fallbackIndex = null) {
  if (!item) return null;
  const scope = item.serviceLine ? `${item.serviceLine}::` : '';
  if (item.markerLabel) return `${scope}marker:${item.markerLabel}|${item.areaName || ''}`;
  if (item.id) return `${scope}id:${item.id}`;
  if (fallbackIndex != null) return `${scope}idx:${fallbackIndex}`;
  return null;
}

// When a zone has multiple coverage rows (e.g. completed + needs-attention),
// the map can only render one marker per zone after dedupe — and that
// marker has to be the most attention-worthy status so a green "completed"
// doesn't paper over an orange "needs follow-up". Higher = more urgent.
// List card and map use the same picker so click activation lines up.
const COVERAGE_TONE_SEVERITY = {
  red: 5,
  orange: 4,
  'light-green': 3,
  blue: 2,
  gray: 1,
  green: 0,
};

function coverageItemSeverity(item) {
  if (!item) return -1;
  const tone = coverageStatusConfig(item.status).tone;
  return COVERAGE_TONE_SEVERITY[tone] ?? 0;
}

function pickRepresentativeCoverageItem(items) {
  if (!Array.isArray(items) || !items.length) return null;
  let best = items[0];
  let bestSeverity = coverageItemSeverity(best);
  for (let i = 1; i < items.length; i += 1) {
    const candidate = items[i];
    const sev = coverageItemSeverity(candidate);
    if (sev > bestSeverity) {
      best = candidate;
      bestSeverity = sev;
    }
  }
  return best;
}

function ServiceCoverageMap({
  coverage,
  evidenceLevel,
  mapBackgroundUrl,
  mapAttribution,
  activeItemId,
  onActivate,
  hasStatusText = true,
}) {
  const normalizedServiceType = normalizeCoverageServiceType(coverage?.serviceLine);
  const locations = Array.isArray(coverage?.items) ? coverage.items : [];
  const imageLocations = locations.map(coverageImageDisplayLocation);
  const imageRenderableCount = imageLocations.filter(hasRenderableCoverageGeometry).length;
  const canUseImageGeometry = Boolean(mapBackgroundUrl)
    && imageRenderableCount > 0
    && locations.every((location) => (
      !hasRenderableCoverageGeometry(location)
      || hasRenderableCoverageGeometry(coverageImageDisplayLocation(location))
    ));
  const activeMapBackgroundUrl = canUseImageGeometry ? mapBackgroundUrl : null;
  const displayLocations = useMemo(
    () => locations.map((location) => coverageDisplayLocation(location, canUseImageGeometry)),
    [locations, canUseImageGeometry],
  );
  const renderableLocations = displayLocations.filter(hasRenderableCoverageGeometry);
  // Dedupe by zone identity so multi-status zones don't paint stacked
  // geometries on top of each other (the underlying one is unclickable
  // and `activeItemId` may target the hidden marker). Within a zone we
  // keep the most attention-worthy item via pickRepresentativeCoverageItem
  // so an orange needs-attention doesn't get hidden under a green completed.
  // The list card below this map still surfaces every status for the zone.
  const mapLocations = useMemo(() => {
    const order = [];
    const byKey = new Map();
    renderableLocations.forEach((loc, idx) => {
      const key = coverageZoneKey(loc, idx);
      if (!key) return;
      if (byKey.has(key)) {
        byKey.get(key).push(loc);
      } else {
        order.push(key);
        byKey.set(key, [loc]);
      }
    });
    return order.map((key) => pickRepresentativeCoverageItem(byKey.get(key)));
  }, [renderableLocations]);
  const projection = useMemo(() => buildCoverageProjection(mapLocations), [mapLocations]);
  const legend = Array.isArray(coverage?.legend) && coverage.legend.length
    ? coverage.legend.map((entry) => {
      const config = coverageStatusConfig(entry.key);
      return {
        key: entry.key,
        tone: config.tone,
        Icon: config.Icon,
        label: entry.label || config.label,
      };
    })
    : coverageLegendItems(locations, normalizedServiceType);
  const evidenceNote = EVIDENCE_COPY[evidenceLevel]
    || EVIDENCE_COPY[locations.find((location) => EVIDENCE_COPY[location.evidenceLevel])?.evidenceLevel];
  if (!coverage?.map?.available || !locations.length) return null;

  return (
    <div className="service-coverage-map-panel">
      <div
        className={`service-coverage-map${activeMapBackgroundUrl ? ' has-map-image' : ''}`}
        style={activeMapBackgroundUrl ? { '--coverage-map-image': `url("${activeMapBackgroundUrl}")` } : undefined}
      >
        {projection && renderableLocations.length ? (
          <svg
            role="img"
            aria-label="Service coverage map showing technician-marked service coverage"
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
            {mapLocations.map((location) => (
              <CoverageMapGeometry
                key={location.id || `${location.areaName || location.name}-${location.status}`}
                location={location}
                projection={projection}
                active={activeItemId === location.id}
                onActivate={onActivate}
              />
            ))}
          </svg>
        ) : (
          <div className="coverage-empty-state coverage-empty-state-map">Map geometry is not available for these locations.</div>
        )}
        {activeMapBackgroundUrl && mapAttribution && <div className="map-attribution coverage-map-attribution">{mapAttribution}</div>}
      </div>

      {/* Legend kept whenever the per-zone list is hidden. Summary counts
          alone don't replace it — ServiceCoverageSummary only labels four
          buckets (Completed / Inspected / Inaccessible / Needs Attention)
          and doesn't cover red (blocked), gray (not-serviced/not-included),
          or light-green (partially treated) tones the markers may use.
          The list does label every status per zone in text. */}
      {!hasStatusText && legend.length > 0 && (
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
    </div>
  );
}

function ServiceCoverageSummary({ summary = {} }) {
  const rows = [
    ['Completed', summary.completedCount || 0, 'green'],
    ['Inspected', summary.inspectedCount || 0, 'blue'],
    ['Inaccessible', summary.inaccessibleCount || 0, 'orange'],
    ['Needs Attention', summary.needsAttentionCount || 0, 'orange'],
  ];
  return (
    <div className="service-coverage-summary" aria-label="Service coverage summary">
      {rows.map(([label, value, tone]) => (
        <div className={`service-coverage-chip status-${tone}`} key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

function productNamesForCoverageItem(item = {}, applications = []) {
  const itemZoneId = String(item.zoneId || item.zone_id || '');
  if (!itemZoneId) return [];
  return uniqueStrings((applications || [])
    .filter((app) => applicationZoneIds(app).includes(itemZoneId))
    .map((app) => applicationProductName(app)))
    .slice(0, 4);
}

// Dedupe coverage items by markerLabel — same physical zone listed with
// multiple statuses (e.g., "Completed" + "Inspected") collapses into one
// card with multiple status rows underneath. Items without a markerLabel
// stay as their own card (keyed by id) so nothing gets dropped.
function mergeCoverageItemsByMarker(items, applications) {
  const order = [];
  const byKey = new Map();
  // First pass: bucket the raw items by zone key (preserves order)
  items.forEach((item, idx) => {
    const key = coverageZoneKey(item, idx);
    if (!key) return;
    if (byKey.has(key)) {
      byKey.get(key).rawItems.push(item);
    } else {
      order.push(key);
      byKey.set(key, {
        key,
        markerLabel: item.markerLabel,
        areaName: item.areaName,
        rawItems: [item],
      });
    }
  });
  // Second pass: shape entries + pick the representative id by severity
  // (matches the same picker the map uses for its dedupe, so clicking a
  // merged card activates the marker actually visible on the satellite).
  return order.map((key) => {
    const zone = byKey.get(key);
    const representative = pickRepresentativeCoverageItem(zone.rawItems);
    const entries = zone.rawItems.map((item) => {
      const config = coverageStatusConfig(item.status);
      return {
        id: item.id,
        status: item.status,
        tone: config.tone,
        statusLabel: item.customerStatusLabel || item.statusLabel || config.label,
        description: item.customerDescription,
        products: productNamesForCoverageItem(item, applications),
      };
    });
    return {
      key: zone.key,
      markerLabel: zone.markerLabel,
      areaName: zone.areaName,
      firstItemId: representative ? representative.id : zone.rawItems[0].id,
      entries,
    };
  });
}

function ServiceCoverageList({ coverage, activeItemId, onActivate, applications = [] }) {
  const groups = Array.isArray(coverage?.groups) && coverage.groups.length
    ? coverage.groups
    : [{ serviceLine: coverage?.serviceLine, items: coverage?.items || [] }];
  const showGroupTitles = groups.length > 1;

  return (
    <div className="service-coverage-list" aria-label="Service coverage areas">
      {groups.map((group) => {
        const merged = mergeCoverageItemsByMarker(group.items || [], applications);
        return (
          <div className="service-coverage-list-group" key={group.serviceLine || group.title || 'coverage'}>
            {showGroupTitles && <h3>{group.title || formatEnumLabel(group.serviceLine)}</h3>}
            {merged.map((zone) => {
              const isActive = zone.entries.some((entry) => entry.id === activeItemId);
              const allProducts = Array.from(new Set(zone.entries.flatMap((entry) => entry.products)));
              return (
                <article
                  className={`coverage-summary-row zone-service-row service-coverage-item${isActive ? ' is-active' : ''}`}
                  key={zone.key}
                  tabIndex={0}
                  role="button"
                  aria-pressed={isActive ? 'true' : 'false'}
                  onClick={() => onActivate(zone.firstItemId)}
                  onFocus={() => onActivate(zone.firstItemId)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onActivate(zone.firstItemId);
                    }
                  }}
                >
                  <div className="zone-service-identity">
                    <span className="zone-letter-badge" aria-label={zone.markerLabel ? `Coverage marker ${zone.markerLabel}` : 'Service coverage marker'}>
                      {zone.markerLabel}
                    </span>
                    <div className="zone-service-copy">
                      <h3>{zone.areaName}</h3>
                      {zone.entries.map((entry) => (
                        <p key={`desc-${entry.id}`} className="zone-status-description">
                          {entry.description}
                        </p>
                      ))}
                      {allProducts.length > 0 && (
                        <div className="coverage-product-line">
                          Products used: {allProducts.join(' · ')}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="zone-status-chips">
                    {zone.entries.map((entry) => (
                      <span
                        key={entry.id}
                        className={`coverage-status-chip zone-status-chip status-${entry.tone}`}
                      >
                        {entry.statusLabel}
                      </span>
                    ))}
                  </div>
                </article>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function ServiceCoverageCard({
  coverage,
  evidenceLevel,
  mapBackgroundUrl,
  mapAttribution,
  applications = [],
}) {
  const [activeItemId, setActiveItemId] = useState(null);
  // ALL hooks (useState, useMemo, etc.) must run on every render of this
  // component instance — keep them above any early `return null` guard
  // so a disabled→enabled transition doesn't change hook count and crash
  // the report with a Rules of Hooks violation. coverage may be null
  // here; the optional chaining + Array.isArray fallback keeps inputs safe.
  const items = Array.isArray(coverage?.items) ? coverage.items : [];
  // Initial active id has to be the deduped representative of the first
  // zone, not items[0] itself. The map renders one marker per zone after
  // severity-based dedupe, so if items[0] isn't the chosen representative
  // (e.g. the first entry is "completed" and the second is "needs
  // attention" for the same zone), the active list card would point at
  // an id the map never paints — visible card with no map highlight.
  const initialActiveId = useMemo(() => {
    if (!items.length) return null;
    const firstKey = coverageZoneKey(items[0], 0);
    if (!firstKey) return items[0]?.id || null;
    const zoneItems = items.filter((item, idx) => coverageZoneKey(item, idx) === firstKey);
    const representative = pickRepresentativeCoverageItem(zoneItems);
    return representative?.id || items[0]?.id || null;
  }, [items]);

  if (!coverage?.enabled) return null;

  const showSummary = coverage.settings?.showSummaryCounts !== false;
  const showList = coverage.settings?.showList !== false && items.length > 0;
  const showMap = coverage.settings?.showMap !== false && coverage.map?.available;
  const activeId = activeItemId || initialActiveId;
  const meta = [
    coverage.address,
    coverage.serviceDate ? formatDate(coverage.serviceDate) : null,
  ].filter(Boolean);

  if (!showList && !showMap) {
    return (
      <section className="sr-section service-coverage-section" id="service-coverage">
        <span id="areas-serviced" className="legacy-section-anchor" aria-hidden="true" />
        <span id="service-coverage-map" className="legacy-section-anchor" aria-hidden="true" />
        <h2>{coverage.title || 'Service Area Map'}</h2>
          <div className="coverage-empty-state">{coverage.unavailableText || 'Service coverage details were not recorded for this visit.'}</div>
      </section>
    );
  }

  return (
    <section className="sr-section service-coverage-section unified-service-coverage" id="service-coverage">
      <span id="areas-serviced" className="legacy-section-anchor" aria-hidden="true" />
      <span id="service-coverage-map" className="legacy-section-anchor" aria-hidden="true" />
      <div className="coverage-section-header">
        <div>
          <h2>{coverage.title || 'Service Area Map'}</h2>
          <p className="map-context-copy">{coverage.intro || coverage.introText || DEFAULT_SERVICE_COVERAGE_COPY.introByServiceLine.default}</p>
        </div>
        {meta.length > 0 && (
          <div className="coverage-map-meta" aria-label="Service coverage context">
            {meta.map((item) => <span key={item}>{item}</span>)}
          </div>
        )}
      </div>

      {showSummary && <ServiceCoverageSummary summary={coverage.summary} />}

      {showMap || showList ? (
        <div className={`service-coverage-card-grid${showMap ? ' has-map' : ' list-only'}${showList ? ' has-list' : ' map-only'}`}>
          {showMap ? (
            <ServiceCoverageMap
              coverage={coverage}
              evidenceLevel={evidenceLevel}
              mapBackgroundUrl={mapBackgroundUrl}
              mapAttribution={mapAttribution}
              activeItemId={activeId}
              onActivate={setActiveItemId}
              hasStatusText={showList}
            />
          ) : (
            <p className="coverage-map-unavailable">Coverage map was not recorded for this visit.</p>
          )}
          {showList ? (
            <ServiceCoverageList
              coverage={coverage}
              activeItemId={activeId}
              onActivate={setActiveItemId}
              applications={applications}
            />
          ) : (
            <p className="coverage-map-unavailable">Technician-marked coverage is shown on the map.</p>
          )}
        </div>
      ) : null}

      <p className="map-footnote">{coverage.disclaimer || DEFAULT_SERVICE_COVERAGE_COPY.disclaimerText}</p>
    </section>
  );
}

function workflowIconForType(type) {
  if (type === 'technician_en_route') return Route;
  if (type === 'technician_on_site' || type === 'arrived_on_site') return MapPin;
  if (type === 'customer_interaction') return CheckCircle2;
  if (type === 'inspection_started') return Eye;
  if (type === 'service_completed') return CheckCircle2;
  if (type === 'report_published') return FileCheck2;
  return Clock;
}

const DEFAULT_VISIT_TIMELINE_CONFIG = {
  enabled: true,
  showOnCustomerReports: true,
  title: 'Visit Timeline',
  showTechnicianEnRoute: true,
  showTechnicianOnSite: true,
  showServiceCompleted: true,
  serviceCompletedRequiredWhenReportCompleted: true,
  showCustomerContact: true,
  showCustomerContactAsTimelineEvent: false,
  showReportGenerated: false,
  showExactTimes: true,
  showDuration: false,
  minimumDurationMinutes: 5,
  showTimingNoteWhenDurationUnavailable: true,
  showDataSourceNote: true,
  dataSourceNote: 'Times are based on available technician status updates, vehicle data, and report completion records.',
};

const PRIMARY_VISIT_TIMELINE_TYPES = new Set([
  'technician_en_route',
  'technician_on_site',
  'arrived_on_site',
  'service_completed',
]);

function normalizeVisitTimelineServiceLine(serviceLine, serviceType) {
  const text = `${serviceLine || ''} ${serviceType || ''}`.toLowerCase();
  if (text.includes('lawn')) return 'lawn';
  if (text.includes('termite')) return 'termite';
  if (text.includes('tree') || text.includes('shrub') || text.includes('palm')) return 'tree_shrub';
  if (text.includes('mosquito')) return 'mosquito';
  if (text.includes('rodent')) return 'rodent';
  if (text.includes('commercial')) return 'commercial';
  if (text.includes('pest') || text.includes('quarterly') || text.includes('perimeter')) return 'pest';
  return 'default';
}

function normalizeVisitTimelineEventType(type) {
  const key = String(type || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (key === 'arrived_on_site' || key === 'technician_arrived') return 'technician_on_site';
  if (key === 'visit_completed') return 'service_completed';
  return key;
}

function serviceCompletedDescription(serviceLine) {
  const descriptions = {
    pest: 'Your technician completed the pest control service and finalized the report.',
    lawn: 'Your technician completed the lawn service and finalized the report.',
    termite: 'Your technician completed the termite service and finalized the report.',
    tree_shrub: 'Your technician completed the tree and shrub service and finalized the report.',
    mosquito: 'Your technician completed the mosquito service and finalized the report.',
    rodent: 'Your technician completed the rodent service and finalized the report.',
    default: 'Your technician completed the service and finalized the report.',
  };
  return descriptions[serviceLine] || descriptions.default;
}

function timelineDefaultLabel(type) {
  if (type === 'technician_en_route') return 'Technician en route';
  if (type === 'technician_on_site') return 'Technician on site';
  if (type === 'service_completed') return 'Service completed';
  return formatEnumLabel(type);
}

function timelineDefaultDescription(type, serviceLine, occurredAt) {
  if (type === 'technician_en_route') return 'Your technician was on the way to the property.';
  if (type === 'technician_on_site') return 'Your technician was recorded at the property.';
  if (type === 'service_completed') {
    return occurredAt ? serviceCompletedDescription(serviceLine) : 'The service was marked complete.';
  }
  return '';
}

function visitTimelineSortOrder(type) {
  if (type === 'technician_en_route') return 1;
  if (type === 'technician_on_site') return 2;
  if (type === 'service_completed') return 3;
  return 99;
}

function normalizeVisitTimelineConfig(config = {}) {
  const merged = { ...DEFAULT_VISIT_TIMELINE_CONFIG, ...(config || {}) };
  merged.enabled = merged.enabled !== false;
  merged.showOnCustomerReports = merged.showOnCustomerReports !== false;
  merged.showTechnicianEnRoute = merged.showTechnicianEnRoute !== false;
  merged.showTechnicianOnSite = merged.showTechnicianOnSite !== false;
  merged.serviceCompletedRequiredWhenReportCompleted = merged.serviceCompletedRequiredWhenReportCompleted !== false;
  merged.showServiceCompleted = merged.serviceCompletedRequiredWhenReportCompleted ? true : merged.showServiceCompleted !== false;
  merged.showCustomerContact = merged.showCustomerContact !== false;
  merged.showCustomerContactAsTimelineEvent = merged.showCustomerContactAsTimelineEvent === true;
  merged.showReportGenerated = merged.showReportGenerated === true;
  merged.showExactTimes = merged.showExactTimes !== false;
  merged.showDuration = merged.showDuration === true;
  merged.minimumDurationMinutes = Math.max(1, Number.parseInt(merged.minimumDurationMinutes, 10) || 5);
  merged.showTimingNoteWhenDurationUnavailable = merged.showTimingNoteWhenDurationUnavailable !== false;
  merged.showDataSourceNote = merged.showDataSourceNote !== false;
  merged.title = String(merged.title || 'Visit Timeline').trim() || 'Visit Timeline';
  merged.dataSourceNote = String(merged.dataSourceNote || DEFAULT_VISIT_TIMELINE_CONFIG.dataSourceNote).trim()
    || DEFAULT_VISIT_TIMELINE_CONFIG.dataSourceNote;
  return merged;
}

function normalizeVisitTimelineEvent(event = {}, index = 0, serviceLine = 'default', config = DEFAULT_VISIT_TIMELINE_CONFIG) {
  const type = normalizeVisitTimelineEventType(event.type);
  if (!PRIMARY_VISIT_TIMELINE_TYPES.has(type)) return null;
  const occurredAt = firstValidTimelineValue(
    event.occurredAt,
    event.occurred_at,
    event.timestamp,
    event.time,
  );
  if (!occurredAt && type !== 'service_completed') return null;
  const label = String(event.label || timelineDefaultLabel(type)).trim();
  const customerDescription = String(
    event.customerDescription
    || event.customerVisibleDescription
    || event.customer_visible_description
    || timelineDefaultDescription(type, serviceLine, occurredAt)
    || '',
  ).trim();
  const source = event.source || (type === 'service_completed' ? 'service_report' : 'bouncie');
  const sortOrder = Number(event.sortOrder || event.sort_order || visitTimelineSortOrder(type) || index + 1);
  return {
    ...event,
    id: event.id || `${type}-${index + 1}`,
    type,
    label,
    customerDescription,
    customerVisibleDescription: customerDescription,
    occurredAt,
    timestamp: occurredAt,
    displayTime: config.showExactTimes !== false ? (event.displayTime || event.display_time || formatClockTime(occurredAt) || null) : null,
    source,
    confidence: event.confidence || (occurredAt ? 'high' : 'medium'),
    status: event.status || 'completed',
    sortOrder,
  };
}

export function timelineEventsForDisplay(workflowEvents = []) {
  return (Array.isArray(workflowEvents) ? workflowEvents : [])
    .map((event, index) => normalizeVisitTimelineEvent(event, index))
    .filter(Boolean);
}

const TIMELINE_EVENT_ORDER = [
  'technician_en_route',
  'technician_on_site',
  'arrived_on_site',
  'customer_interaction',
  'inspection_started',
  'service_started',
  'service_completed',
  'quality_reviewed',
  'report_published',
];

function timelineEventOrder(type) {
  const index = TIMELINE_EVENT_ORDER.indexOf(type);
  return index >= 0 ? index : TIMELINE_EVENT_ORDER.length;
}

function sortTimelineEvents(events = []) {
  return [...events]
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const orderDiff = (a.event?.sortOrder || visitTimelineSortOrder(a.event?.type))
        - (b.event?.sortOrder || visitTimelineSortOrder(b.event?.type));
      if (orderDiff !== 0) return orderDiff;

      const aTime = Date.parse(a.event?.timestamp);
      const bTime = Date.parse(b.event?.timestamp);
      const aHasTime = Number.isFinite(aTime);
      const bHasTime = Number.isFinite(bTime);

      if (aHasTime && bHasTime && aTime !== bTime) return aTime - bTime;
      if (aHasTime !== bHasTime) return aHasTime ? -1 : 1;

      const legacyOrderDiff = timelineEventOrder(a.event?.type) - timelineEventOrder(b.event?.type);
      if (legacyOrderDiff !== 0) return legacyOrderDiff;

      return a.index - b.index;
    })
    .map(({ event }) => event);
}

function collapseSameTimeTimelineEvents(events = []) {
  const completed = events.find((event) => event.type === 'service_completed' && event.occurredAt);
  const completedMs = Date.parse(completed?.occurredAt);
  if (!Number.isFinite(completedMs)) return events;
  return events.filter((event) => {
    if (event.type !== 'technician_on_site' || !event.occurredAt) return true;
    const eventMs = Date.parse(event.occurredAt);
    return !Number.isFinite(eventMs) || eventMs !== completedMs;
  });
}

function firstValidTimelineValue(...values) {
  return values.find((value) => value && Number.isFinite(Date.parse(value))) || null;
}

function minutesBetween(start, end) {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  return Math.round((endMs - startMs) / 60000);
}

function formatCompactDurationMinutes(minutes) {
  const value = positiveNumber(minutes);
  if (!value) return '';
  const rounded = Math.max(1, Math.round(value));
  if (rounded < 60) return `${rounded} min`;
  const hours = Math.floor(rounded / 60);
  const remaining = rounded % 60;
  return remaining ? `${hours} hr ${remaining} min` : `${hours} hr`;
}

function timelineAnchorTimes(timingSource = {}, visitTiming = {}) {
  const sourceTiming = timingSource?.visitTiming || {};
  const serviceRecord = timingSource?.serviceRecord || {};
  const scheduledService = timingSource?.scheduledService || timingSource?.scheduled_service || {};
  const arrivedAt = firstValidTimelineValue(
    visitTiming?.arrivedAt,
    visitTiming?.arrived_at,
    sourceTiming?.arrivedAt,
    sourceTiming?.arrived_at,
    sourceTiming?.onSiteAt,
    sourceTiming?.on_site_at,
    serviceRecord?.arrived_at,
    serviceRecord?.actual_start_time,
    serviceRecord?.check_in_time,
    serviceRecord?.started_at,
    scheduledService?.arrivedAt,
    scheduledService?.arrived_at,
    scheduledService?.actualStartTime,
    scheduledService?.actual_start_time,
    scheduledService?.checkInTime,
    scheduledService?.check_in_time,
    timingSource?.arrivedAt,
    timingSource?.arrived_at,
    timingSource?.started_at,
  );
  const completedAt = firstValidTimelineValue(
    visitTiming?.exitedAt,
    visitTiming?.completedAt,
    visitTiming?.completed_at,
    sourceTiming?.exitedAt,
    sourceTiming?.completedAt,
    sourceTiming?.completed_at,
    serviceRecord?.completed_at,
    serviceRecord?.actual_end_time,
    serviceRecord?.check_out_time,
    serviceRecord?.ended_at,
    scheduledService?.completedAt,
    scheduledService?.completed_at,
    scheduledService?.actualEndTime,
    scheduledService?.actual_end_time,
    scheduledService?.checkOutTime,
    scheduledService?.check_out_time,
    timingSource?.completedAt,
    timingSource?.completed_at,
    timingSource?.ended_at,
  );
  const derivedMinutes = minutesBetween(arrivedAt, completedAt);
  const reportedMinutes = positiveNumber(visitTiming?.onSiteMinutes || sourceTiming?.onSiteMinutes);

  return {
    arrivedAt,
    completedAt,
    timeOnSiteDisplay: formatCompactDurationMinutes(derivedMinutes || reportedMinutes),
  };
}

function firstWorkflowEventTimestamp(workflowEvents = [], type) {
  const event = (Array.isArray(workflowEvents) ? workflowEvents : []).find((candidate) => (
    normalizeVisitTimelineEventType(candidate?.type) === type
    && candidate?.status !== 'pending'
  ));
  return firstValidTimelineValue(event?.occurredAt, event?.timestamp, event?.time);
}

function completedTimelineReport(timingSource = {}, workflowEvents = []) {
  const status = String(
    timingSource?.status
    || timingSource?.visitOutcome
    || timingSource?.visitStatus
    || timingSource?.serviceRecord?.status
    || timingSource?.service_record?.status
    || '',
  ).toLowerCase();
  if (['completed', 'complete', 'finalized', 'closed'].includes(status)) return true;
  if (firstWorkflowEventTimestamp(workflowEvents, 'service_completed')) return true;
  return Boolean(getReportCompletionTime(timingSource));
}

function reportGeneratedDetailText(timestamp, { showExactTimes = true } = {}) {
  const dateLabel = formatDate(timestamp);
  const timeLabel = showExactTimes ? formatClockTime(timestamp) : null;
  if (dateLabel && timeLabel) return `Report generated ${dateLabel.replace(/^[A-Za-z]+,\s*/, '')} at ${timeLabel}.`;
  if (dateLabel) return `Report generated ${dateLabel.replace(/^[A-Za-z]+,\s*/, '')}.`;
  return 'Report generated after service completion.';
}

export function normalizeVisitTimeline({
  visitTimeline,
  workflowEvents = [],
  customerInteraction,
  visitTiming = {},
  timingSource = {},
  serviceType,
  serviceLine,
  config = {},
} = {}) {
  const source = visitTimeline && typeof visitTimeline === 'object' ? visitTimeline : null;
  const resolvedConfig = normalizeVisitTimelineConfig({
    ...(source?.config || {}),
    ...(config || {}),
  });
  const normalizedServiceLine = normalizeVisitTimelineServiceLine(
    source?.serviceLine || serviceLine || timingSource?.serviceLine || timingSource?.coverageServiceType,
    serviceType || timingSource?.serviceType,
  );
  const hasServerTimeline = Boolean(source);
  const { arrivedAt, completedAt } = timelineAnchorTimes(timingSource, visitTiming);
  const reportCompleted = source?.status === 'completed' || completedTimelineReport(timingSource, workflowEvents);
  const rawSourceEvents = Array.isArray(source?.events) ? source.events : workflowEvents;
  const nextEvents = (Array.isArray(rawSourceEvents) ? rawSourceEvents : [])
    .map((event, index) => normalizeVisitTimelineEvent(event, index, normalizedServiceLine, resolvedConfig))
    .filter(Boolean);

  const enRouteAt = firstValidTimelineValue(
    timingSource?.en_route_at,
    timingSource?.enRouteAt,
    timingSource?.serviceRecord?.en_route_at,
    timingSource?.scheduledService?.en_route_at,
    firstWorkflowEventTimestamp(workflowEvents, 'technician_en_route'),
  );

  if (!hasServerTimeline && resolvedConfig.showTechnicianEnRoute && enRouteAt && !nextEvents.some((event) => event.type === 'technician_en_route')) {
    nextEvents.push({
      id: 'technician_en_route-derived',
      type: 'technician_en_route',
      label: 'Technician en route',
      occurredAt: enRouteAt,
      timestamp: enRouteAt,
      displayTime: resolvedConfig.showExactTimes !== false ? (formatClockTime(enRouteAt) || null) : null,
      source: 'bouncie',
      status: 'completed',
      customerDescription: 'Your technician was on the way to the property.',
      customerVisibleDescription: 'Your technician was on the way to the property.',
      sortOrder: 1,
    });
  }

  if (!hasServerTimeline && resolvedConfig.showTechnicianOnSite && arrivedAt && !nextEvents.some((event) => event.type === 'technician_on_site')) {
    nextEvents.push({
      id: 'technician_on_site-derived',
      type: 'technician_on_site',
      label: 'Technician on site',
      occurredAt: arrivedAt,
      timestamp: arrivedAt,
      displayTime: resolvedConfig.showExactTimes !== false ? (formatClockTime(arrivedAt) || null) : null,
      source: 'bouncie',
      status: 'completed',
      customerDescription: 'Your technician was recorded at the property.',
      customerVisibleDescription: 'Your technician was recorded at the property.',
      sortOrder: 2,
    });
  }

  if (!hasServerTimeline && resolvedConfig.showServiceCompleted && reportCompleted && !nextEvents.some((event) => event.type === 'service_completed')) {
    nextEvents.push({
      id: 'service_completed-derived',
      type: 'service_completed',
      label: 'Service completed',
      occurredAt: completedAt || null,
      timestamp: completedAt || null,
      displayTime: resolvedConfig.showExactTimes !== false ? (formatClockTime(completedAt) || null) : null,
      source: 'service_report',
      confidence: completedAt ? 'high' : 'medium',
      status: 'completed',
      customerDescription: completedAt ? serviceCompletedDescription(normalizedServiceLine) : 'The service was marked complete.',
      customerVisibleDescription: completedAt ? serviceCompletedDescription(normalizedServiceLine) : 'The service was marked complete.',
      sortOrder: 3,
    });
  }

  const events = collapseSameTimeTimelineEvents(sortTimelineEvents(nextEvents)
    .filter((event) => {
      if (event.type === 'technician_en_route') return resolvedConfig.showTechnicianEnRoute;
      if (event.type === 'technician_on_site') return resolvedConfig.showTechnicianOnSite;
      if (event.type === 'service_completed') return resolvedConfig.showServiceCompleted;
      return false;
    }));

  const sourceDetails = Array.isArray(source?.details) ? source.details : [];
  const interactionText = customerInteractionCopy(customerInteraction || timingSource?.customerInteraction);
  const details = sourceDetails
    .filter((detail) => (
      detail
      && detail.type !== 'report_generated'
      && (detail.type !== 'customer_contact' || resolvedConfig.showCustomerContact)
    ))
    .map((detail, index) => ({
      id: detail.id || `detail-${index + 1}`,
      type: detail.type || 'detail',
      label: detail.label || formatEnumLabel(detail.type || 'detail'),
      text: detail.text || detail.customerDescription || detail.customerVisibleDescription || '',
      occurredAt: firstValidTimelineValue(detail.occurredAt, detail.timestamp),
      displayTime: resolvedConfig.showExactTimes !== false ? (detail.displayTime || formatClockTime(detail.occurredAt || detail.timestamp) || null) : null,
      showAsTimelineEvent: detail.showAsTimelineEvent === true,
    }))
    .filter((detail) => detail.text);
  if (resolvedConfig.showCustomerContact && interactionText && !details.some((detail) => detail.type === 'customer_contact')) {
    details.push({
      id: 'customer_contact',
      type: 'customer_contact',
      label: 'Customer contact',
      text: interactionText,
      occurredAt: null,
      displayTime: null,
      showAsTimelineEvent: resolvedConfig.showCustomerContactAsTimelineEvent,
    });
  }

  const reportGeneratedAt = firstValidTimelineValue(
    source?.reportGeneratedAt,
    timingSource?.reportGeneratedAt,
    timingSource?.report_generated_at,
    firstWorkflowEventTimestamp(workflowEvents, 'report_published'),
  );
  if (resolvedConfig.showReportGenerated && reportGeneratedAt && !details.some((detail) => detail.type === 'report_generated')) {
    details.push({
      id: 'report_generated',
      type: 'report_generated',
      label: 'Report generated',
      text: reportGeneratedDetailText(reportGeneratedAt, { showExactTimes: resolvedConfig.showExactTimes !== false }),
      occurredAt: reportGeneratedAt,
      displayTime: resolvedConfig.showExactTimes !== false ? (formatClockTime(reportGeneratedAt) || null) : null,
      showAsTimelineEvent: false,
    });
  }

  const timelineOnSiteAt = arrivedAt || events.find((event) => event.type === 'technician_on_site')?.occurredAt;
  const timelineCompletedAt = completedAt || events.find((event) => event.type === 'service_completed')?.occurredAt;
  const rawDurationMinutes = minutesBetween(timelineOnSiteAt, timelineCompletedAt);
  const reliableDurationMinutes = rawDurationMinutes != null && rawDurationMinutes >= resolvedConfig.minimumDurationMinutes
    ? rawDurationMinutes
    : null;
  const shouldShowTimingNote = resolvedConfig.showTimingNoteWhenDurationUnavailable
    && reportCompleted
    && timelineOnSiteAt
    && (!reliableDurationMinutes || rawDurationMinutes < resolvedConfig.minimumDurationMinutes);

  return {
    enabled: source?.enabled !== false && resolvedConfig.enabled && resolvedConfig.showOnCustomerReports && events.length > 0,
    title: source?.title || resolvedConfig.title,
    intro: source?.intro || "Here’s a simple summary of today’s service visit.",
    serviceLine: normalizedServiceLine,
    status: reportCompleted ? 'completed' : 'in_progress',
    events,
    details,
    timingNote: source?.timingNote || (shouldShowTimingNote ? 'Exact on-site duration was not available for this visit.' : null),
    dataSourceNote: resolvedConfig.showDataSourceNote ? (source?.dataSourceNote || resolvedConfig.dataSourceNote) : null,
    durationMinutes: resolvedConfig.showDuration
      ? (positiveNumber(source?.durationMinutes) || reliableDurationMinutes)
      : null,
    reportGeneratedAt: reportGeneratedAt || null,
    config: resolvedConfig,
  };
}

export function timelineEventsWithReportTiming(workflowEvents = [], customerInteraction, visitTiming = {}, timingSource = {}) {
  return normalizeVisitTimeline({
    workflowEvents,
    customerInteraction,
    visitTiming,
    timingSource,
    serviceType: timingSource?.coverageServiceType || timingSource?.serviceLine || timingSource?.serviceType,
  }).events;
}

function ServiceTimelineSection({ serviceType, visitTimeline, workflowEvents, customerInteraction, visitTiming, timingSource, loading = false }) {
  const timeline = normalizeVisitTimeline({
    visitTimeline,
    workflowEvents,
    customerInteraction,
    visitTiming,
    timingSource,
    serviceType,
  });
  const events = timeline.events;
  // WaveGuard memberships don't account for an hourly/per-visit time figure on customer-facing
  // service reports — the "Time on site" duration is suppressed (reads as zero) for members.
  // Non-member reports keep honoring the admin "Show duration when reliable" setting, which
  // governs whether timeline.durationMinutes is populated upstream. timingSource is the full
  // report payload (passed as timingSource={data}), so the membership flag is read from it.
  const isWaveGuardMember = Boolean(
    timingSource?.waveGuardTier || timingSource?.waveguardTier || timingSource?.plan?.isWaveGuard,
  );
  const timeOnSiteDisplay = isWaveGuardMember
    ? ''
    : (timeline.durationMinutes ? formatCompactDurationMinutes(timeline.durationMinutes) : '');

  if (loading) {
    return (
      <section className="sr-section service-workflow-section service-workflow-loading" id="service-timeline">
        <h2>Visit Timeline</h2>
        <div className="workflow-skeleton-list">
          <span />
          <span />
          <span />
        </div>
      </section>
    );
  }

  if (!timeline.enabled) return null;

  return (
    <section className="sr-section service-workflow-section" id="service-timeline">
      <div className="coverage-section-header">
        <div>
          <h2>{timeline.title || 'Visit Timeline'}</h2>
          <p className="map-context-copy">{timeline.intro || "Here’s a simple summary of today’s service visit."}</p>
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
                      {event.occurredAt && event.displayTime && <time dateTime={event.occurredAt}>{event.displayTime}</time>}
                    </div>
                    {(event.customerDescription || event.customerVisibleDescription) && <p>{event.customerDescription || event.customerVisibleDescription}</p>}
                  </div>
                </li>
              );
            })}
          </ol>
          {timeline.details.length > 0 && (
            <div className="visit-timeline-details" aria-label="Visit timeline details">
              {timeline.details.map((detail) => (
                <div className="visit-timeline-detail" key={detail.id || detail.type}>
                  <span>{detail.label}</span>
                  <p>{detail.text}</p>
                </div>
              ))}
            </div>
          )}
          {timeOnSiteDisplay && (
            <div className="visit-progress-summary">
              <span>Time on site</span>
              <strong>{timeOnSiteDisplay}</strong>
            </div>
          )}
          {timeline.timingNote && <p className="timeline-note">{timeline.timingNote}</p>}
          {timeline.dataSourceNote && <p className="timeline-note visit-timeline-data-source">{timeline.dataSourceNote}</p>}
        </>
      )}
    </section>
  );
}

function ServiceReportCoverageAndWorkflow({
  serviceType,
  serviceCoverage,
  visitTimeline,
  workflowEvents,
  customerInteraction,
  visitTiming,
  timingSource,
  evidenceLevel,
  mapBackgroundUrl,
  mapAttribution,
  applications = [],
  serviceLine = null,
}) {
  // Lawn and tree & shrub reports don't show the per-area Coverage map — the
  // lawn-intelligence/assessment surfaces tell that story instead. Keep the
  // Visit Timeline for every service line.
  const hideCoverage = serviceLine === 'lawn' || /tree|shrub/.test(String(serviceLine || ''));
  return (
    <>
      <ServiceTimelineSection
        serviceType={serviceType}
        visitTimeline={visitTimeline}
        workflowEvents={workflowEvents}
        customerInteraction={customerInteraction}
        visitTiming={visitTiming}
        timingSource={timingSource}
      />
      {!hideCoverage && (
        <ServiceCoverageCard
          coverage={serviceCoverage}
          evidenceLevel={evidenceLevel}
          mapBackgroundUrl={mapBackgroundUrl}
          mapAttribution={mapAttribution}
          applications={applications}
        />
      )}
    </>
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
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: ESTIMATE_BG, fontFamily: FONT_BODY, padding: 20 }}>
      <div style={{ background: '#fff', borderRadius: 16, border: `1px solid ${ESTIMATE_BORDER}`, padding: 24, width: 'min(420px, 100%)', boxSizing: 'border-box' }}>
        <div style={{ height: 12, width: 120, background: '#F7F5EE', borderRadius: 4 }} />
        <div style={{ height: 32, width: '70%', background: '#F7F5EE', borderRadius: 4, marginTop: 14 }} />
        <div style={{ height: 14, width: '50%', background: '#F7F5EE', borderRadius: 4, marginTop: 10 }} />
      </div>
    </div>
  );
}

function NotFoundState() {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: ESTIMATE_BG, padding: 20, fontFamily: FONT_BODY }}>
      <div style={{ background: '#fff', borderRadius: 16, border: `1px solid ${ESTIMATE_BORDER}`, padding: 32, maxWidth: 420, textAlign: 'center' }}>
        <div style={{ fontFamily: FONTS.serif, fontSize: 28, fontWeight: 500, color: ESTIMATE_TEXT }}>Report unavailable</div>
        <div style={{ fontSize: 15, color: ESTIMATE_BODY, lineHeight: 1.55, marginTop: 8 }}>
          This link may have expired or is not valid.
        </div>
        <a href={`tel:${WAVES_PHONE_TEL}`} style={{ ...actionButtonStyle('primary'), marginTop: 18 }}>Call Waves</a>
      </div>
    </div>
  );
}

function LegacyReport({ data, token }) {
  const pdfUrl = `${API_BASE}/reports/${token}`;
  const firstName = String(data.customerName || '').trim().split(/\s+/)[0] || 'there';
  return (
    <div style={{ minHeight: '100vh', background: ESTIMATE_BG, fontFamily: FONT_BODY, color: ESTIMATE_TEXT, display: 'flex', flexDirection: 'column' }}>
      <header style={{ background: '#fff', borderBottom: `1px solid ${ESTIMATE_BORDER}` }}>
        <div style={{
          maxWidth: 960,
          margin: '0 auto',
          padding: '16px 24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
        }}>
          <a href={`tel:${WAVES_PHONE_TEL}`} style={{ color: ESTIMATE_TEXT, fontSize: 15, fontWeight: 600, textDecoration: 'none' }}>
            {WAVES_PHONE_DISPLAY}
          </a>
          <img src="/waves-logo.png" alt="Waves" style={{ height: 28, display: 'block' }} />
        </div>
      </header>
      <main style={{ flex: 1, maxWidth: 720, width: '100%', margin: '0 auto', padding: '32px 20px 64px', boxSizing: 'border-box' }}>
        <div style={{ padding: '8px 0 24px' }}>
          <div style={{ fontSize: 12, color: ESTIMATE_MUTED, textTransform: 'uppercase', fontWeight: 700, marginBottom: 6 }}>
            Service report{data.serviceType ? ` · ${data.serviceType}` : ''}
          </div>
          <h1 style={{ fontFamily: FONTS.serif, fontSize: 'clamp(34px, 5vw, 48px)', fontWeight: 500, letterSpacing: 0, lineHeight: 1.1, color: ESTIMATE_TEXT, margin: 0 }}>
            Hey {firstName}, here's your service report.
          </h1>
          {data.cityState && <div style={{ fontSize: 20, color: ESTIMATE_BODY, marginTop: 16, lineHeight: 1.35 }}>{data.cityState}</div>}
        </div>
        <section style={{ background: '#fff', borderRadius: 16, padding: 24, border: `1px solid ${ESTIMATE_BORDER}` }}>
          <div style={{ fontSize: 12, color: ESTIMATE_MUTED, textTransform: 'uppercase', fontWeight: 700, marginBottom: 8 }}>Report details</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: ESTIMATE_TEXT }}>{data.serviceType}</div>
          <div style={{ fontSize: 14, color: ESTIMATE_BODY, marginTop: 4 }}>{[formatDate(data.serviceDate), data.technicianName].filter(Boolean).join(' | ')}</div>
          {data.notes && <p style={{ fontSize: 15, color: ESTIMATE_BODY, lineHeight: 1.6, marginTop: 16, whiteSpace: 'pre-wrap' }}>{data.notes}</p>}
          <a href={pdfUrl} download style={{ ...actionButtonStyle('primary'), marginTop: 18 }}><Download size={16} /> Download PDF</a>
        </section>
        <div style={{ marginTop: 16, borderRadius: 16, overflow: 'hidden', border: `1px solid ${ESTIMATE_BORDER}`, background: '#fff' }}>
          <iframe src={pdfUrl} style={{ width: '100%', height: 620, border: 'none' }} title="Service report PDF" />
        </div>
      </main>
      <BrandFooter />
    </div>
  );
}

const VISUAL_PROOF_STAGE_ORDER = {
  Observed: 10,
  Treated: 20,
  Recommendation: 30,
  Access: 40,
  'Before / After': 50,
  General: 60,
};

function visualProofMomentStage(moment = {}) {
  const group = String(moment.tagGroup || '').toLowerCase();
  const code = String(moment.tagCode || '').toLowerCase();
  if (code === 'no_major_activity') return 'General';
  if (group === 'treatment' || code === 'treatment_applied') return 'Treated';
  if (group === 'recommendation' || code === 'recommendation') return 'Recommendation';
  if (group === 'access' || code === 'access_issue' || code === 'entry_point') return 'Access';
  if (group === 'before_after' || code === 'before' || code === 'after') return 'Before / After';
  return 'Observed';
}

function visualProofMomentTime(moment = {}) {
  const value = moment.capturedAt || moment.createdAt;
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function orderVisualProofMoments(moments = []) {
  return [...moments].sort((a, b) => {
    const stageDiff = (VISUAL_PROOF_STAGE_ORDER[visualProofMomentStage(a)] || 99)
      - (VISUAL_PROOF_STAGE_ORDER[visualProofMomentStage(b)] || 99);
    if (stageDiff !== 0) return stageDiff;
    return visualProofMomentTime(a) - visualProofMomentTime(b);
  });
}

function visualProofMomentIntro(moments = []) {
  const stages = new Set(moments.map(visualProofMomentStage));
  if (stages.has('Observed') && stages.has('Treated') && stages.has('Recommendation')) {
    return 'Reviewed service highlights show what was observed, what was treated, and what to watch next.';
  }
  if (stages.has('Observed') && stages.has('Treated')) {
    return 'Reviewed service highlights show what was observed and included in today\'s treatment.';
  }
  if (stages.has('Recommendation')) {
    return 'Reviewed service highlights include follow-up recommendations from today\'s visit.';
  }
  return 'Reviewed service highlights from today\'s visit.';
}

function ServiceReportV1({ data, token, mode = 'live' }) {
  const pdfUrl = data.pdfUrl ? `${API_BASE}${data.pdfUrl.replace(/^\/api/, '')}` : null;
  const reportUrl = typeof window !== 'undefined' ? `${window.location.origin}/report/${token}` : `/report/${token}`;
  const serviceCoverage = normalizeServiceCoverage(data);
  const hasApplications = (data.applications || []).length > 0;
  const dynamicContext = data.dynamicContext || {};
  const premium = dynamicContext.premiumExperience || {};
  const isLawnReport = data.serviceLine === 'lawn' && data.lawnAssessment?.scores;
  const proofMoments = Array.isArray(data.proofMoments)
    ? data.proofMoments
    : (Array.isArray(data.visualServiceMoments) ? data.visualServiceMoments : []);
  const orderedProofMoments = useMemo(() => orderVisualProofMoments(proofMoments), [proofMoments]);

  useEffect(() => {
    if (mode !== 'live') return;
    trackReportEvent(token, 'service_report_viewed');
  }, [mode, token]);

  useEffect(() => {
    if (mode !== 'live') return;
    if (!data.lawnProgramOverview?.packetId) return;
    trackReportEvent(token, 'service_report_linked_to_outline', {
      packetId: data.lawnProgramOverview.packetId,
      estimateId: data.lawnProgramOverview.estimateId || null,
    });
  }, [data.lawnProgramOverview?.estimateId, data.lawnProgramOverview?.packetId, mode, token]);

  const visitTimelineServiceType = data.coverageServiceType || data.serviceLine || data.serviceType;
  const normalizedVisitTimeline = normalizeVisitTimeline({
    visitTimeline: data.visitTimeline,
    workflowEvents: data.workflowEvents,
    customerInteraction: data.customerInteraction,
    visitTiming: data.visitTiming,
    timingSource: data,
    serviceType: visitTimelineServiceType,
  });
  const hasPestPressure = Boolean(data.pestPressure && data.pestPressure.showOnCustomerReport !== false && data.pestPressure.enabled !== false);
  const hasReentry = Boolean(dynamicContext.reentry);

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
          --text: ${ESTIMATE_TEXT};
          --muted: ${ESTIMATE_MUTED};
          --soft: ${ESTIMATE_BODY};
          --line: ${ESTIMATE_BORDER};
          --line-strong: #D4CBB8;
          --paper: #ffffff;
          --wash: ${ESTIMATE_INPUT_BG};
          --soft-blue: ${ESTIMATE_INPUT_BG};
          --soft-blue-border: ${ESTIMATE_INPUT_BORDER};
          --page: ${ESTIMATE_BG};
          --red: ${B.red};
          --report-text: var(--text);
          --report-muted: var(--muted);
          --report-border: var(--line);
          --report-action: ${ESTIMATE_BUTTON_BG};
          --report-surface: var(--paper);
          --shadow-soft: none;
          min-height: 100vh;
          background: var(--page);
          color: var(--text);
          font-family: ${FONT_BODY};
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
          max-width: 960px;
          margin: 0 auto;
          min-height: 62px;
          padding: 16px 24px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          box-sizing: border-box;
        }
        .sr-top-phone {
          color: var(--text);
          font-size: 15px;
          font-weight: 600;
          text-decoration: none;
          white-space: nowrap;
        }
        .sr-brand-lockup {
          display: flex;
          align-items: center;
          gap: 10px;
          min-width: 0;
        }
        .sr-brand-logo {
          height: 28px;
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
          max-width: 720px;
          width: 100%;
          margin: 0 auto;
          padding: 32px 20px 64px;
          box-sizing: border-box;
        }
        .sr-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
        .report-action-bar {
          display: block;
          margin: 0 0 18px;
          padding: 20px 22px;
          background: var(--paper);
          border: 1px solid var(--line);
          border-radius: 16px;
        }
        .report-action-bar .section-eyebrow {
          margin-bottom: 6px;
        }
        .report-action-title {
          margin: 6px 0 4px;
          font-family: ${FONTS.serif};
          font-weight: 500;
          font-size: 24px;
          line-height: 1.2;
          color: var(--text);
        }
        .report-action-copy {
          margin: 2px 0 0;
          color: ${ESTIMATE_BODY};
          font-size: 14px;
          line-height: 1.45;
        }
        .report-action-buttons {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 10px;
          margin-top: 16px;
        }
        .report-action-buttons > a,
        .report-action-buttons > button,
        .report-action-buttons > span {
          width: 100%;
        }
        .service-report-hero {
          padding: 8px 0 0;
        }
        .service-report-hero-copy {
          padding-bottom: 24px;
        }
        .service-status-card {
          display: block;
          padding: 24px;
          background: var(--paper);
          border: 1px solid var(--line);
          border-radius: 16px;
          box-shadow: var(--shadow-soft);
        }
        .sr-title {
          margin: 0;
          color: var(--text);
          font-family: ${FONTS.serif};
          font-size: clamp(34px, 5vw, 48px);
          line-height: 1.1;
          font-weight: 500;
          letter-spacing: 0;
        }
        .sr-meta {
          margin-top: 8px;
          color: ${ESTIMATE_BODY};
          font-size: 15px;
          line-height: 1.55;
        }
        .smart-status-result {
          color: var(--text);
          font-size: 22px;
          line-height: 1.25;
          font-weight: 750;
          letter-spacing: 0;
        }
        .smart-status-detail {
          margin: 14px 0 0;
          color: var(--muted);
          font-size: 14px;
          line-height: 1.5;
        }
        .service-meta-address {
          margin-top: 16px;
          color: ${ESTIMATE_BODY};
          font-size: 20px;
          line-height: 1.35;
          font-weight: 400;
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
          margin-top: 16px;
          padding: 12px 14px 14px;
          border: 1px solid var(--line);
          border-radius: 12px;
          background: #fff;
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
          display: flex;
          gap: 1px;
          overflow-x: auto;
          overflow-y: hidden;
          border: 1px solid var(--line);
          border-radius: 10px;
          background: var(--line);
          scrollbar-width: thin;
          -webkit-overflow-scrolling: touch;
        }
        .hero-condition-cell {
          flex: 0 0 148px;
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
        .status-badge.status-warning {
          border-color: #fdba74;
          background: #ffedd5;
          color: #7c2d12;
        }
        .status-badge.status-neutral {
          border-color: #cbd5e1;
          background: #f8fafc;
          color: #334155;
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
        .service-status-grid {
          grid-template-columns: 1fr;
        }
        .service-status-timeline {
          margin-top: 16px;
          padding: 15px;
          border: 1px solid var(--line);
          border-radius: 12px;
          background: #fff;
        }
        .status-timeline-list {
          display: grid;
          gap: 10px;
          margin-top: 10px;
        }
        .status-timeline-item {
          display: grid;
          grid-template-columns: 30px minmax(0, 1fr);
          gap: 10px;
          align-items: start;
        }
        .status-timeline-marker {
          width: 30px;
          height: 30px;
          border-radius: 999px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border: 1px solid #bbf7d0;
          background: #dcfce7;
          color: #14532d;
        }
        .status-timeline-marker-pending {
          border-color: #cbd5e1;
          background: #f8fafc;
          color: #475569;
        }
        .status-timeline-copy {
          min-width: 0;
          padding-top: 2px;
        }
        .status-timeline-title {
          color: var(--text);
          font-size: 15px;
          line-height: 1.3;
          font-weight: 800;
        }
        .status-timeline-time {
          margin-top: 2px;
          color: var(--muted);
          font-size: 13px;
          line-height: 1.35;
        }
        .status-timeline-summary {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 12px;
          margin-top: 13px;
          padding-top: 13px;
          border-top: 1px solid var(--line);
        }
        .status-timeline-summary-label {
          color: var(--muted);
          font-size: 13px;
          line-height: 1.35;
          font-weight: 700;
        }
        .status-timeline-summary-value {
          color: var(--text);
          font-size: 16px;
          line-height: 1.25;
          font-weight: 850;
          white-space: nowrap;
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
        .visit-timeline-details {
          display: grid;
          gap: 8px;
          margin-top: 12px;
        }
        .visit-timeline-detail {
          border: 1px solid var(--line);
          border-radius: 10px;
          background: var(--wash);
          padding: 10px 12px;
        }
        .visit-timeline-detail span {
          display: block;
          color: var(--text);
          font-size: 13px;
          line-height: 1.35;
          font-weight: 850;
        }
        .visit-timeline-detail p {
          margin: 3px 0 0;
          color: var(--muted);
          font-size: 13px;
          line-height: 1.45;
        }
        .visit-timeline-data-source {
          font-size: 12px;
        }
        .visit-progress-summary {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 12px;
          margin-top: 12px;
          padding: 12px;
          border: 1px solid var(--line);
          border-radius: 10px;
          background: var(--wash);
        }
        .visit-progress-summary span {
          color: var(--muted);
          font-size: 13px;
          line-height: 1.35;
          font-weight: 700;
        }
        .visit-progress-summary strong {
          color: var(--text);
          font-size: 16px;
          line-height: 1.25;
          font-weight: 850;
          white-space: nowrap;
        }
        .legacy-section-anchor {
          position: relative;
          display: block;
          height: 0;
          width: 0;
          overflow: hidden;
        }
        .service-coverage-summary {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin: 14px 0;
        }
        .service-coverage-chip {
          display: inline-flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          min-width: 132px;
          border: 1px solid var(--line);
          border-radius: 999px;
          padding: 8px 11px;
          background: #fff;
          font-size: 12px;
          line-height: 1;
          font-weight: 800;
        }
        .service-coverage-chip strong {
          font-size: 13px;
        }
        .service-coverage-chip.status-green { border-color: #86efac; background: #dcfce7; color: #14532d; }
        .service-coverage-chip.status-blue { border-color: #93c5fd; background: #dbeafe; color: #1e3a8a; }
        .service-coverage-chip.status-orange { border-color: #fdba74; background: #ffedd5; color: #7c2d12; }
        .service-coverage-card-grid {
          display: grid;
          grid-template-columns: minmax(0, .88fr) minmax(320px, 1.12fr);
          grid-template-areas: "list map";
          gap: 14px;
          align-items: start;
        }
        .service-coverage-card-grid.list-only {
          grid-template-columns: 1fr;
          grid-template-areas: "list";
        }
        .service-coverage-card-grid.map-only {
          grid-template-columns: 1fr;
          grid-template-areas: "map";
        }
        .service-coverage-map-panel {
          grid-area: map;
          min-width: 0;
        }
        .service-coverage-list {
          grid-area: list;
          display: grid;
          gap: 8px;
          min-width: 0;
        }
        .service-coverage-list-group {
          display: grid;
          gap: 8px;
        }
        .service-coverage-list-group > h3 {
          margin: 2px 0 4px;
          color: var(--text);
          font-size: 14px;
          line-height: 1.25;
          font-weight: 850;
        }
        .coverage-map-unavailable {
          grid-area: map;
          margin: 0;
          border: 1px dashed var(--line);
          border-radius: 12px;
          background: var(--wash);
          color: var(--muted);
          padding: 14px;
          font-size: 13px;
          line-height: 1.45;
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
          padding: 24px;
          margin-top: 16px;
          break-inside: avoid;
        }
        .sr-section h2 {
          margin: 0 0 16px;
          color: var(--text);
          font-family: ${FONTS.serif};
          font-size: 28px;
          line-height: 1.18;
          font-weight: 500;
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
          fill: #15803D;
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
        .coverage-line.status-green { stroke: #15803D; }
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
        .coverage-geometry-group.is-active .coverage-area,
        .coverage-geometry-group.is-active .coverage-line,
        .coverage-marker.is-active .coverage-marker-outer {
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
          font-size: 14px;
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
          border-left: 5px solid var(--zone-color, var(--line));
          border-radius: 10px;
          background: #fff;
          padding: 11px 12px;
        }
        .zone-service-row {
          align-items: center;
        }
        .service-coverage-item {
          cursor: pointer;
          transition: border-color .16s ease, box-shadow .16s ease, transform .16s ease;
        }
        .service-coverage-item:hover,
        .service-coverage-item:focus,
        .service-coverage-item.is-active {
          border-color: rgba(27,44,91,.36);
          box-shadow: 0 0 0 3px rgba(27,44,91,.08);
          outline: none;
        }
        .zone-service-identity {
          display: flex;
          align-items: center;
          gap: 12px;
          min-width: 0;
        }
        .zone-letter-badge {
          width: 34px;
          height: 34px;
          border-radius: 999px;
          background: var(--zone-color, ${B.blueDeeper});
          color: #fff;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex: 0 0 auto;
          font-size: 13px;
          font-weight: 850;
          line-height: 1;
        }
        .zone-service-copy {
          min-width: 0;
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
        .coverage-product-line {
          margin-top: 8px;
          color: var(--text);
          font-size: 12px;
          line-height: 1.35;
          font-weight: 750;
        }
        .coverage-evidence-note {
          margin-top: 12px;
        }
        .coverage-status-chip.zone-status-chip {
          font-weight: 850;
        }
        .zone-status-chips {
          display: flex;
          flex-direction: column;
          gap: 4px;
          flex-shrink: 0;
          align-items: flex-end;
        }
        .zone-status-description {
          margin: 4px 0 0;
          color: var(--muted);
          font-size: 13px;
          line-height: 1.45;
        }
        .zone-status-description + .zone-status-description {
          margin-top: 2px;
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
        .solution-product-detail {
          display: grid;
          gap: 6px;
        }
        .solution-product-detail + .solution-product-detail {
          border-top: 1px solid var(--line);
          padding-top: 10px;
        }
        .solution-product-name {
          color: var(--text);
          font-size: 15px;
          font-weight: 800;
          line-height: 1.3;
        }
        .solution-product-facts {
          color: var(--muted);
          font-size: 12px;
          line-height: 1.45;
          font-weight: 700;
        }
        .manufacturer-guideline-note {
          border: 1px solid var(--line);
          border-radius: 10px;
          background: var(--wash);
          padding: 12px 14px;
          margin-bottom: 14px;
          color: var(--text);
          font-size: 14px;
          line-height: 1.5;
        }
        .manufacturer-guideline-note strong {
          color: var(--text);
          font-weight: 750;
        }
        .applied-product-maker {
          margin: -2px 0 8px;
          color: var(--muted);
          font-size: 13px;
          line-height: 1.3;
          font-weight: 600;
        }
        .product-watering-guidance {
          border: 1px solid var(--line);
          border-radius: 10px;
          background: var(--wash);
          padding: 10px;
        }
        .product-watering-guidance .watering-headline {
          margin-top: 4px;
          color: var(--text);
          font-weight: 700;
        }
        .product-watering-guidance p + p {
          margin-top: 4px;
        }
        .product-manufacturer-line {
          font-size: 13px;
        }
        .applied-product-card p {
          margin: 0;
          color: var(--muted);
          font-size: 14px;
          line-height: 1.45;
        }
        .product-purpose-grid {
          display: grid;
          gap: 10px;
          margin-top: 12px;
        }
        .product-purpose-grid > div,
        .product-why {
          border: 1px solid var(--line);
          border-radius: 10px;
          background: var(--wash);
          padding: 10px;
        }
        .product-why {
          margin-top: 10px;
          background: #fff;
        }
        .product-purpose-grid p,
        .product-why p {
          margin-top: 4px;
          color: var(--text);
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
        .neighborhood-pressure-summary {
          margin: 10px 0 0;
          color: var(--report-muted);
          font-size: 13px;
          line-height: 1.45;
        }
        .pressure-legend {
          display: flex;
          gap: 16px;
          flex-wrap: wrap;
          margin-top: 8px;
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
        .lawn-program-overview-card {
          background: #fff;
        }
        .lawn-program-heading {
          display: flex;
          align-items: flex-start;
          gap: 12px;
        }
        .lawn-program-heading h2 {
          margin: 3px 0 0;
        }
        .lawn-program-icon {
          width: 42px;
          height: 42px;
          border: 1px solid var(--soft-blue-border);
          border-radius: 10px;
          background: var(--soft-blue);
          color: ${B.blueDeeper};
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex: 0 0 auto;
        }
        .lawn-program-copy,
        .lawn-program-distinction {
          margin: 14px 0 0;
          color: var(--text);
          font-size: 16px;
          line-height: 1.55;
        }
        .lawn-program-distinction {
          padding: 12px;
          border: 1px solid var(--soft-blue-border);
          border-radius: 10px;
          background: var(--soft-blue);
          color: ${ESTIMATE_BODY};
          font-size: 14px;
        }
        .lawn-program-facts {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 1px;
          margin-top: 14px;
          overflow: hidden;
          border: 1px solid var(--line);
          border-radius: 10px;
          background: var(--line);
        }
        .lawn-program-fact {
          min-height: 82px;
          background: #fff;
          padding: 12px;
        }
        .lawn-program-fact strong {
          display: block;
          margin-top: 7px;
          color: var(--text);
          font-size: 15px;
          line-height: 1.25;
          font-weight: 850;
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
        .lawn-water-line,
        .lawn-before-after-line {
          margin-top: 10px;
          color: var(--muted);
          font-size: 13px;
          line-height: 1.45;
          font-weight: 650;
        }
        .lawn-water-line {
          padding: 10px 12px;
          border: 1px solid var(--line);
          border-radius: 8px;
          background: var(--wash);
          max-width: 680px;
          color: var(--text);
          font-weight: 600;
        }
        .lawn-mowing-height .lawn-mowing-label {
          text-transform: uppercase;
          letter-spacing: 0.04em;
          font-size: 11px;
          color: var(--muted);
          margin-right: 4px;
        }
        .lawn-mowing-height[data-mowing-status="below"] {
          border-color: var(--red);
          color: var(--red);
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
        .contact-waves-section,
        .customer-action-section,
        .property-memory-section {
          background: #fff;
        }
        .customer-action-list,
        .property-memory-grid {
          display: grid;
          gap: 10px;
        }
        .customer-action-item,
        .property-memory-item {
          border: 1px solid var(--line);
          border-radius: 10px;
          background: var(--wash);
          padding: 12px;
        }
        .customer-action-title {
          color: var(--text);
          font-size: 16px;
          line-height: 1.35;
          font-weight: 800;
        }
        .customer-action-item p,
        .customer-action-section > p,
        .property-memory-item p {
          margin: 6px 0 0;
          color: var(--muted);
          font-size: 14px;
          line-height: 1.5;
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
          border-radius: 16px;
          box-shadow: var(--shadow-soft);
        }
        .sr-section h2,
        .report-card h2,
        .applied-product-card h3,
        .coverage-summary-row h3,
        .workflow-event-heading h3 {
          font-family: ${FONTS.serif};
          font-weight: 500;
          color: var(--text);
          letter-spacing: 0;
        }
        .sr-section h2,
        .report-card h2 {
          font-size: 28px;
          line-height: 1.18;
        }
        .sr-band,
        .sr-grid-3,
        .executive-status-grid,
        .defense-status-grid,
        .receipt-grid,
        .lawn-score-grid,
        .hero-condition-row,
        .hero-reentry-status .reentry-target-grid {
          border-radius: 10px;
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
          border-radius: 10px;
        }
        .sr-cell-label {
          color: var(--muted);
          font-family: ${FONT_BODY};
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0;
          text-transform: uppercase;
        }
        .section-eyebrow {
          color: var(--muted);
          font-family: ${FONT_BODY};
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0;
          text-transform: uppercase;
        }
        .map-toggle {
          border-color: var(--line-strong);
          border-radius: 8px;
        }
        .map-toggle button {
          font-family: ${FONTS.heading};
          font-weight: 850;
        }
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
          .sr-top-inner { align-items: center; flex-direction: row; }
          .sr-actions { width: 100%; justify-content: stretch; }
          .sr-actions a, .sr-actions button { flex: 1; }
          .sr-shell { padding: 14px 14px 36px; }
          .report-action-bar { padding: 18px 16px; }
          .report-action-buttons { grid-template-columns: 1fr; }
          .service-status-main,
          .readiness-card-header { flex-direction: column; }
          .sr-pressure { justify-self: stretch; }
          .sr-band { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .sr-grid-2, .sr-grid-3, .sr-advisory, .service-status-grid, .readiness-facts, .supporting-detail-grid, .executive-status-grid, .defense-status-grid, .receipt-grid, .one-thing-detail, .lawn-score-grid, .lawn-program-facts, .lawn-assessment-layout { grid-template-columns: 1fr; }
          .lawn-trend-chart { justify-self: stretch; max-width: none; }
          .lawn-photo-strip { grid-template-columns: 1fr; }
          .premium-section-header { flex-direction: column; }
          .sr-row { grid-template-columns: 1fr; }
          .hero-conditions-copy { display: block; }
          .hero-conditions-copy p { margin-top: 6px; text-align: left; }
          .hero-condition-cell { flex-basis: 138px; }
          .report-ask-form { flex-direction: column; }
          .report-ask-actions { grid-template-columns: 1fr; }
          .coverage-section-header { flex-direction: column; }
          .coverage-map-meta { justify-items: start; text-align: left; max-width: none; }
          .service-coverage-summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .service-coverage-chip { min-width: 0; }
          .service-coverage-card-grid,
          .service-coverage-card-grid.has-map,
          .service-coverage-card-grid.list-only,
          .service-coverage-card-grid.map-only {
            grid-template-columns: 1fr;
            grid-template-areas: "map" "list";
          }
          .service-coverage-map { aspect-ratio: 32 / 17; }
          .coverage-map-label { display: none; }
          .coverage-summary-row { align-items: flex-start; flex-direction: column; }
          .zone-service-row { align-items: stretch; }
          .zone-service-identity { width: 100%; }
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
          .sr-actions,
          .report-action-bar { display: none; }
          /* Staff-only companion sections never print — the printed page
             must match the customer artifact (the internal warning header
             is hidden in print, so the body must go with it). */
          .companion-internal { display: none; }
          .service-report-v1 { background: #fff; }
          .sr-shell { padding: 0; }
          .service-status-card,
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
          <a className="sr-top-phone" href={`tel:${WAVES_PHONE_TEL}`}>{WAVES_PHONE_DISPLAY}</a>
          <img src="/waves-logo.png" alt="Waves" className="sr-brand-logo" />
        </div>
      </header>

      <main className="sr-shell">
        {mode === 'live' && (data.internalOnly
          ? <InternalReviewBar />
          : <ReportActionBar pdfUrl={pdfUrl} token={token} onShare={share} />)}

        <ServiceStatusCard data={data} mode={mode} />

        <TodaysResultCard typedReport={data.typedReport} />

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
          {data.serviceLine === 'lawn' && data.mowingHeight && (
            <LawnMowingHeight mowing={data.mowingHeight} />
          )}
        </section>

        {/* Lawn reports lead with the factual record — products applied + the
            visit timeline — right after the assessment. Other service lines
            keep these lower (rendered below, gated by !isLawnReport). The
            program explainer + Ask-Waves move down for lawn. */}
        {isLawnReport && (
          <>
            <AppliedProductsSection data={data} mode={mode} />
            <div id="map">
              <ServiceReportCoverageAndWorkflow
                serviceType={visitTimelineServiceType}
                serviceCoverage={serviceCoverage}
                visitTimeline={normalizedVisitTimeline}
                workflowEvents={data.workflowEvents}
                customerInteraction={data.customerInteraction}
                visitTiming={data.visitTiming}
                timingSource={data}
                evidenceLevel={data.evidenceLevel}
                mapBackgroundUrl={mode === 'live' ? data.treatmentMap?.satellite?.live?.url : null}
                mapAttribution={mode === 'live' ? data.treatmentMap?.satellite?.attributionText : null}
                applications={data.applications || []}
                serviceLine={data.serviceLine}
              />
            </div>
          </>
        )}

        <TypedFindingsCard typedReport={data.typedReport} />

        <LawnProtocolCard protocol={dynamicContext.lawnProtocol} />

        {dynamicContext.pressureTrend && (
          <PressureTrendCard
            context={dynamicContext.pressureTrend}
            neighborhood={dynamicContext.neighborhoodPressure}
            mode={mode}
            token={token}
          />
        )}

        {/* Typed specialty reports render the activity gauge in this slot;
            recurring reports keep PestPressureCard (the server nulls
            pestPressure whenever activity is present, and vice versa).
            Only pass token in live mode so the interactive rating picker
            doesn't render into generated/cached PDFs (mode === 'pdf' /
            'static') where the controls would be non-functional anyway. */}
        {data.activity
          ? <ActivityCard data={data.activity} />
          : <PestPressureCard data={data.pestPressure} token={mode === 'live' ? token : null} />}

        {/* Companion typed sections (combined services): primary content
            first, then one block per companion — heading, Today's Result,
            findings, and the activity gauge, all rendered from the
            companion's frozen snapshot. The server already filtered
            internal_only entries out of customer payloads; the
            companion-internal wrapper additionally excludes staff-only
            sections from PRINT (the print stylesheet hides the warning
            header, so a staff print must match the customer artifact). */}
        {(data.companionReports || []).map((companion) => (
          <div
            key={companion.type}
            className={companion.internalOnly ? 'companion-internal' : undefined}
          >
            <CompanionSectionHeader companion={companion} />
            <TodaysResultCard
              typedReport={companion}
              sectionId={`companion-${companion.type}-todays-result`}
            />
            <TypedFindingsCard
              typedReport={companion}
              sectionId={`companion-${companion.type}-findings`}
            />
            {companion.activity && (
              <ActivityCard
                data={companion.activity}
                sectionId={`companion-${companion.type}-activity`}
              />
            )}
          </div>
        ))}

        {/* Lawn: program explainer drops below the factual record, just above
            Ask-Waves. */}
        {data.serviceLine === 'lawn' && (
          <LawnProgramOverviewCard context={data.lawnProgramOverview} />
        )}

        <QuickNavigationAndAsk
          mode={mode}
          token={token}
          serviceLine={data.serviceLine}
          data={data}
          hasProducts={hasApplications}
          hasVisitTimeline={normalizedVisitTimeline.enabled}
          hasPestPressure={hasPestPressure}
          hasReentry={hasReentry}
          hasActivity={Boolean(data.activity)}
        />

        {/* Non-lawn lines keep Timeline + Coverage and Products here; lawn
            already rendered them up top. */}
        {!isLawnReport && (
          <div id="map">
            <ServiceReportCoverageAndWorkflow
              serviceType={visitTimelineServiceType}
              serviceCoverage={serviceCoverage}
              visitTimeline={normalizedVisitTimeline}
              workflowEvents={data.workflowEvents}
              customerInteraction={data.customerInteraction}
              visitTiming={data.visitTiming}
              timingSource={data}
              evidenceLevel={data.evidenceLevel}
              mapBackgroundUrl={mode === 'live' ? data.treatmentMap?.satellite?.live?.url : null}
              mapAttribution={mode === 'live' ? data.treatmentMap?.satellite?.attributionText : null}
              applications={data.applications || []}
              serviceLine={data.serviceLine}
            />
          </div>
        )}

        {!isLawnReport && (
          <AppliedProductsSection
            data={data}
            mode={mode}
          />
        )}

        {orderedProofMoments.length > 0 && (
          <section className="sr-section" id="service-highlights">
            <h2>Service Highlights</h2>
            <p style={{ fontSize: 15, color: ESTIMATE_BODY, lineHeight: 1.55, margin: '0 0 14px' }}>
              {visualProofMomentIntro(orderedProofMoments)}
            </p>
            <div className="sr-grid-3">
              {orderedProofMoments.map((moment) => (
                <div className="sr-cell" key={moment.id}>
                  {moment.mediaUrl && moment.mediaType === 'video' && (
                    <video
                      src={moment.mediaUrl}
                      controls
                      style={{ width: '100%', borderRadius: 6, border: '0.5px solid #d4d4d4' }}
                    />
                  )}
                  {moment.mediaUrl && moment.mediaType !== 'video' && (
                    <img
                      src={moment.mediaUrl}
                      alt={moment.tagLabel || 'Service highlight'}
                      style={{ width: '100%', borderRadius: 6, border: '0.5px solid #d4d4d4' }}
                    />
                  )}
                  <div className="sr-cell-label">{visualProofMomentStage(moment)}</div>
                  <div className="sr-cell-value">{moment.tagLabel || 'Service highlight'}</div>
                  {moment.locationArea && (
                    <div style={{ fontSize: 14, color: ESTIMATE_MUTED, marginTop: 4 }}>
                      {moment.locationArea}
                    </div>
                  )}
                  <div style={{ fontSize: 14, lineHeight: 1.45, color: ESTIMATE_BODY, marginTop: 6 }}>
                    {moment.customerCaption || 'Service highlight documented by your technician.'}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {(data.photos || []).length > 0 && (
          <section className="sr-section" id="photos">
            <h2>Field photos</h2>
            {data.typedReport?.photoSummary && (
              <p style={{ fontSize: 15, color: '#1B2C5B', lineHeight: 1.55, margin: '0 0 14px' }}>
                {data.typedReport.photoSummary}
              </p>
            )}
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

        <footer className="sr-footer">
          Questions about today&apos;s service? Ask Waves in your portal or call (941) 297-5749.
          {data.waveGuardTier || data.waveguardTier || data.plan?.isWaveGuard ? ' WaveGuard members receive free re-service when covered activity continues after the treatment window.' : ''}
          {' '}This report is provided for your records.
          {/* Only claim tamper-evidence when at least one photo is displayed and
              every displayed photo is part of the chain. Lawn turf photos
              appended to the gallery are deliberately outside the service_photos
              hash chain, and a chain over only a hidden photo (e.g. the gauge
              shot filtered out of the display payload) must not over-claim. */}
          {data.photoChain?.valid === true && (data.photos || []).length > 0 && (data.photos || []).every((p) => p?.hashSha256) ? ' Photos hash-chained and tamper-evident.' : ''}
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
    // Staff browsers attach their portal JWT so internal-only shadow reports
    // (Phase 1b) render for review; the server ignores it for normal reports
    // and customers never have one. Same-origin localStorage only.
    const staffToken = localStorage.getItem('waves_admin_token') || localStorage.getItem('adminToken');
    fetch(dataUrl, {
      cache: 'no-store',
      headers: staffToken ? { Authorization: `Bearer ${staffToken}` } : undefined,
    })
      .then((r) => r.json())
      .then((d) => {
        // Must register BEFORE setData: the view-event effect fires on first
        // render of the report, and a staff read may never post events.
        if (d && d.staffViewer) staffViewTokens.add(token);
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
