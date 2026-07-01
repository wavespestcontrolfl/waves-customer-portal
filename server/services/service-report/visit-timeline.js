const { parseETDateTime } = require('../../utils/datetime-et');

const VISIT_TIMELINE_CONFIG_KEY = 'service_reports.visit_timeline';
const VISIT_TIMELINE_TIME_ZONE = 'America/New_York';

const DEFAULT_VISIT_TIMELINE_CONFIG = Object.freeze({
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
});

const SERVICE_COMPLETED_DESCRIPTIONS = Object.freeze({
  pest: 'Your technician completed the pest control service and finalized the report.',
  lawn: 'Your technician completed the lawn service and finalized the report.',
  termite: 'Your technician completed the termite service and finalized the report.',
  tree_shrub: 'Your technician completed the tree and shrub service and finalized the report.',
  mosquito: 'Your technician completed the mosquito service and finalized the report.',
  rodent: 'Your technician completed the rodent service and finalized the report.',
  default: 'Your technician completed the service and finalized the report.',
});

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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeObject(base, override) {
  const output = { ...base };
  Object.entries(override || {}).forEach(([key, value]) => {
    if (value === undefined) return;
    if (
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && base[key]
      && typeof base[key] === 'object'
      && !Array.isArray(base[key])
    ) {
      output[key] = mergeObject(base[key], value);
      return;
    }
    output[key] = value;
  });
  return output;
}

function mergeVisitTimelineConfig(value = {}) {
  const candidate = parseJsonObject(value);
  const merged = mergeObject(clone(DEFAULT_VISIT_TIMELINE_CONFIG), candidate);
  merged.enabled = merged.enabled !== false;
  merged.showOnCustomerReports = merged.showOnCustomerReports !== false;
  merged.title = String(merged.title || DEFAULT_VISIT_TIMELINE_CONFIG.title).trim() || DEFAULT_VISIT_TIMELINE_CONFIG.title;
  merged.showTechnicianEnRoute = merged.showTechnicianEnRoute !== false;
  merged.showTechnicianOnSite = merged.showTechnicianOnSite !== false;
  merged.serviceCompletedRequiredWhenReportCompleted = merged.serviceCompletedRequiredWhenReportCompleted !== false;
  merged.showServiceCompleted = merged.serviceCompletedRequiredWhenReportCompleted
    ? true
    : merged.showServiceCompleted !== false;
  merged.showCustomerContact = merged.showCustomerContact !== false;
  merged.showCustomerContactAsTimelineEvent = merged.showCustomerContactAsTimelineEvent === true;
  merged.showReportGenerated = merged.showReportGenerated === true;
  merged.showExactTimes = merged.showExactTimes !== false;
  merged.showDuration = merged.showDuration === true;
  merged.minimumDurationMinutes = Math.max(1, Number.parseInt(merged.minimumDurationMinutes, 10) || 5);
  merged.showTimingNoteWhenDurationUnavailable = merged.showTimingNoteWhenDurationUnavailable !== false;
  merged.showDataSourceNote = merged.showDataSourceNote !== false;
  merged.dataSourceNote = String(merged.dataSourceNote || DEFAULT_VISIT_TIMELINE_CONFIG.dataSourceNote).trim()
    || DEFAULT_VISIT_TIMELINE_CONFIG.dataSourceNote;
  return merged;
}

async function loadVisitTimelineConfig(knex) {
  try {
    const row = await knex('system_settings')
      .where({ key: VISIT_TIMELINE_CONFIG_KEY })
      .first();
    return mergeVisitTimelineConfig(row?.value || {});
  } catch {
    return mergeVisitTimelineConfig();
  }
}

function validTimestamp(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const raw = String(value).trim();
  const naiveWallClock = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?$/.test(raw);
  const date = naiveWallClock ? parseETDateTime(raw.replace(/\.\d+$/, '')) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function firstValidTimestamp(...values) {
  for (const value of values) {
    const timestamp = validTimestamp(value);
    if (timestamp) return timestamp;
  }
  return null;
}

function normalizeTimelineServiceLine(serviceLine, serviceType) {
  const text = `${serviceLine || ''} ${serviceType || ''}`.toLowerCase();
  if (text.includes('lawn') || text.includes('turf')) return 'lawn';
  if (text.includes('termite')) return 'termite';
  if (text.includes('tree') || text.includes('shrub') || text.includes('palm')) return 'tree_shrub';
  if (text.includes('mosquito')) return 'mosquito';
  if (text.includes('rodent')) return 'rodent';
  if (text.includes('commercial')) return 'commercial';
  if (text.includes('pest') || text.includes('quarterly') || text.includes('perimeter')) return 'pest';
  return 'default';
}

function normalizeWorkflowType(type) {
  const key = String(type || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (key === 'arrived_on_site' || key === 'technician_arrived') return 'technician_on_site';
  if (key === 'visit_completed') return 'service_completed';
  return key;
}

function workflowEventTimestamp(workflowEvents = [], type) {
  const event = (workflowEvents || []).find((candidate) => (
    normalizeWorkflowType(candidate?.type) === type
    && candidate?.status !== 'pending'
  ));
  return validTimestamp(event?.timestamp || event?.occurredAt || event?.occurred_at) || null;
}

function displayTime(timestamp, config) {
  if (!config.showExactTimes || !timestamp) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString('en-US', {
    timeZone: VISIT_TIMELINE_TIME_ZONE,
    hour: 'numeric',
    minute: '2-digit',
  });
}

function minutesBetween(start, end) {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  return Math.round((endMs - startMs) / 60000);
}

function isCompletedReport({ service = {}, structured = {}, serviceData = {}, workflowEvents = [] } = {}) {
  const status = String(
    service.status
    || service.report_status
    || service.visit_status
    || serviceData.status
    || serviceData.reportStatus
    || structured.status
    || '',
  ).toLowerCase();
  if (['completed', 'complete', 'finalized', 'closed'].includes(status)) return true;
  if (firstValidTimestamp(
    service.completed_at,
    service.actual_end_time,
    service.check_out_time,
    service.ended_at,
    structured.serviceCompletedAt,
    structured.service_completed_at,
    serviceData.serviceCompletedAt,
    serviceData.service_completed_at,
  )) return true;
  return workflowEvents.some((event) => normalizeWorkflowType(event?.type) === 'service_completed' && event?.status !== 'pending');
}

function customerContactText(value) {
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
  return copy[key] || raw.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function reportGeneratedText(timestamp, config) {
  const date = validTimestamp(timestamp);
  if (!date) return 'Report generated after service completion.';
  const displayDate = new Date(date).toLocaleDateString('en-US', {
    timeZone: VISIT_TIMELINE_TIME_ZONE,
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  const time = displayTime(date, config);
  return time ? `Report generated ${displayDate} at ${time}.` : `Report generated ${displayDate}.`;
}

function buildTimelineEvent({ id, type, label, customerDescription, occurredAt, source, sortOrder, confidence = 'high', config }) {
  return {
    id,
    type,
    label,
    customerDescription,
    customerVisibleDescription: customerDescription,
    occurredAt: occurredAt || null,
    timestamp: occurredAt || null,
    displayTime: displayTime(occurredAt, config),
    source,
    confidence,
    status: 'completed',
    sortOrder,
  };
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

function buildVisitTimeline({
  service = {},
  scheduledService = {},
  structured = {},
  serviceData = {},
  serviceLine,
  serviceType,
  workflowEvents = [],
  customerInteraction,
  config,
} = {}) {
  const resolvedConfig = mergeVisitTimelineConfig(config);
  const normalizedLine = normalizeTimelineServiceLine(serviceLine || service.service_line, serviceType || service.service_type);
  const completedReport = isCompletedReport({ service, structured, serviceData, workflowEvents });

  const enRouteAt = firstValidTimestamp(
    service.en_route_at,
    service.scheduled_en_route_at,
    scheduledService.en_route_at,
    structured.enRouteAt,
    structured.en_route_at,
    serviceData.enRouteAt,
    serviceData.en_route_at,
    workflowEventTimestamp(workflowEvents, 'technician_en_route'),
  );
  const onSiteAt = firstValidTimestamp(
    service.arrived_at,
    service.actual_start_time,
    service.check_in_time,
    service.started_at,
    service.scheduled_arrived_at,
    service.scheduled_actual_start_time,
    service.scheduled_check_in_time,
    scheduledService.arrived_at,
    scheduledService.actual_start_time,
    scheduledService.check_in_time,
    structured.arrivedAt,
    structured.arrived_at,
    serviceData.arrivedAt,
    serviceData.arrived_at,
    workflowEventTimestamp(workflowEvents, 'technician_on_site'),
  );
  const completedAt = firstValidTimestamp(
    service.completed_at,
    service.actual_end_time,
    service.check_out_time,
    service.ended_at,
    service.scheduled_completed_at,
    service.scheduled_actual_end_time,
    service.scheduled_check_out_time,
    scheduledService.completed_at,
    scheduledService.actual_end_time,
    scheduledService.check_out_time,
    structured.serviceCompletedAt,
    structured.service_completed_at,
    serviceData.serviceCompletedAt,
    serviceData.service_completed_at,
    workflowEventTimestamp(workflowEvents, 'service_completed'),
  );
  const reportGeneratedAt = firstValidTimestamp(
    service.report_generated_at,
    structured.reportPublishedAt,
    structured.report_published_at,
    serviceData.reportPublishedAt,
    serviceData.report_published_at,
    workflowEventTimestamp(workflowEvents, 'report_published'),
  );

  const events = [];
  if (resolvedConfig.showTechnicianEnRoute && enRouteAt) {
    events.push(buildTimelineEvent({
      id: 'technician_en_route',
      type: 'technician_en_route',
      label: 'Technician en route',
      customerDescription: 'Your technician was on the way to the property.',
      occurredAt: enRouteAt,
      source: 'bouncie',
      sortOrder: 1,
      config: resolvedConfig,
    }));
  }
  if (resolvedConfig.showTechnicianOnSite && onSiteAt) {
    events.push(buildTimelineEvent({
      id: 'technician_on_site',
      type: 'technician_on_site',
      label: 'Technician on site',
      customerDescription: 'Your technician was recorded at the property.',
      occurredAt: onSiteAt,
      source: 'bouncie',
      sortOrder: 2,
      config: resolvedConfig,
    }));
  }
  if (resolvedConfig.showServiceCompleted && completedReport) {
    events.push(buildTimelineEvent({
      id: 'service_completed',
      type: 'service_completed',
      label: 'Service completed',
      customerDescription: completedAt
        ? (SERVICE_COMPLETED_DESCRIPTIONS[normalizedLine] || SERVICE_COMPLETED_DESCRIPTIONS.default)
        : 'The service was marked complete.',
      occurredAt: completedAt,
      source: 'service_report',
      sortOrder: 3,
      confidence: completedAt ? 'high' : 'medium',
      config: resolvedConfig,
    }));
  }

  const interactionText = customerContactText(
    customerInteraction
    || service.customer_interaction
    || structured.customerInteraction
    || structured.customer_interaction
    || serviceData.customerInteraction
    || serviceData.customer_interaction,
  );
  const details = [];
  if (resolvedConfig.showCustomerContact && interactionText) {
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
  if (resolvedConfig.showReportGenerated && reportGeneratedAt) {
    details.push({
      id: 'report_generated',
      type: 'report_generated',
      label: 'Report generated',
      text: reportGeneratedText(reportGeneratedAt, resolvedConfig),
      occurredAt: reportGeneratedAt,
      displayTime: displayTime(reportGeneratedAt, resolvedConfig),
      showAsTimelineEvent: false,
    });
  }

  const rawDurationMinutes = minutesBetween(onSiteAt, completedAt);
  const durationMinutes = rawDurationMinutes != null
    && rawDurationMinutes >= resolvedConfig.minimumDurationMinutes
    ? rawDurationMinutes
    : null;
  const shouldShowTimingNote = resolvedConfig.showTimingNoteWhenDurationUnavailable
    && completedReport
    && onSiteAt
    && (!durationMinutes || rawDurationMinutes < resolvedConfig.minimumDurationMinutes);

  return {
    enabled: resolvedConfig.enabled && resolvedConfig.showOnCustomerReports && events.length > 0,
    title: resolvedConfig.title,
    intro: "Here's a simple summary of today's service visit.",
    serviceLine: normalizedLine,
    status: completedReport ? 'completed' : 'in_progress',
    events: collapseSameTimeTimelineEvents(events.sort((a, b) => a.sortOrder - b.sortOrder)),
    details,
    timingNote: shouldShowTimingNote ? 'Exact on-site duration was not available for this visit.' : null,
    dataSourceNote: resolvedConfig.showDataSourceNote ? resolvedConfig.dataSourceNote : null,
    durationMinutes: resolvedConfig.showDuration ? durationMinutes : null,
    reportGeneratedAt: reportGeneratedAt || null,
    config: {
      enabled: resolvedConfig.enabled,
      showOnCustomerReports: resolvedConfig.showOnCustomerReports,
      title: resolvedConfig.title,
      showTechnicianEnRoute: resolvedConfig.showTechnicianEnRoute,
      showTechnicianOnSite: resolvedConfig.showTechnicianOnSite,
      showServiceCompleted: resolvedConfig.showServiceCompleted,
      serviceCompletedRequiredWhenReportCompleted: resolvedConfig.serviceCompletedRequiredWhenReportCompleted,
      showCustomerContact: resolvedConfig.showCustomerContact,
      showCustomerContactAsTimelineEvent: resolvedConfig.showCustomerContactAsTimelineEvent,
      showReportGenerated: resolvedConfig.showReportGenerated,
      showExactTimes: resolvedConfig.showExactTimes,
      showDuration: resolvedConfig.showDuration,
      minimumDurationMinutes: resolvedConfig.minimumDurationMinutes,
      showTimingNoteWhenDurationUnavailable: resolvedConfig.showTimingNoteWhenDurationUnavailable,
      showDataSourceNote: resolvedConfig.showDataSourceNote,
    },
  };
}

module.exports = {
  VISIT_TIMELINE_CONFIG_KEY,
  DEFAULT_VISIT_TIMELINE_CONFIG,
  SERVICE_COMPLETED_DESCRIPTIONS,
  mergeVisitTimelineConfig,
  loadVisitTimelineConfig,
  normalizeTimelineServiceLine,
  buildVisitTimeline,
};
