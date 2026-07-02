const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { buildPipelineResponse } = require('../services/pipeline-opportunities');

const MAX_CANDIDATES = 5000;
const DEFAULT_REVIEWED_HISTORY_LIMIT = 20;
const MAX_REVIEWED_HISTORY_LIMIT = 100;
const SAVED_VIEW_NAME_MAX = 80;
const SAVED_VIEW_SEARCH_MAX = 160;
const SAVED_VIEW_SOURCE_MAX = 80;
const SAVED_VIEW_SORTS = new Set(['default', 'next_follow_up']);
const SAVED_VIEW_DATE_RANGES = new Set(['all', '7d', '30d']);
const SAVED_VIEW_FILTERS = new Set([
  'all',
  'needs_action',
  'new',
  'estimate_needed',
  'draft',
  'sent',
  'viewed',
  'follow_up',
  'duplicate_risk',
  'won',
  'lost',
]);

router.use(adminAuthenticate, requireTechOrAdmin);

function performedBy(req) {
  return [req.technician?.first_name, req.technician?.last_name].filter(Boolean).join(' ') || 'Admin';
}

function searchDigits(search) {
  return String(search || '').replace(/\D/g, '');
}

function searchRef(search) {
  return String(search || '').trim().replace(/^#/, '');
}

function cleanId(value) {
  return typeof value === 'string' ? value.trim() : value;
}

function firstPresent(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== '') ?? null;
}

function hasLegacyLeadSourceColumn(database = db) {
  if (!database?.schema?.hasColumn) return Promise.resolve(false);
  return database.schema.hasColumn('leads', 'lead_source').catch(() => false);
}

function leadDisplayName(lead) {
  return [lead?.first_name, lead?.last_name].filter(Boolean).join(' ').trim() || lead?.name || 'Unknown Lead';
}

function estimateDisplayName(estimate) {
  return estimate?.customer_name || estimate?.name || 'Unknown Customer';
}

function compactHistoryRef(prefix, id) {
  if (!id) return null;
  return `${prefix} ${String(id).slice(0, 8)}`;
}

function historyLeadName(row) {
  return [row.lead_first_name, row.lead_last_name].filter(Boolean).join(' ').trim()
    || row.lead_name
    || null;
}

function historyEstimateName(row) {
  return row.estimate_customer_name || row.estimate_name || null;
}

function historyCustomerName(row) {
  return historyEstimateName(row) || historyLeadName(row);
}

function matchCandidateLead(lead) {
  return {
    leadId: lead.id,
    name: leadDisplayName(lead),
    phone: lead.phone || null,
    email: lead.email || null,
    address: lead.address || null,
    serviceInterest: lead.service_interest || lead.serviceInterest || lead.service || null,
    source: lead.source_name || lead.source || lead.lead_source || null,
    status: lead.status || null,
    estimateId: lead.estimate_id || null,
    createdAt: lead.created_at || null,
    updatedAt: lead.updated_at || null,
  };
}

const DUPLICATE_DISMISS_REASONS = new Set([
  'not_same_customer',
  'bad_match',
  'already_handled',
  'other',
]);

function normalizeDismissReason(reason) {
  const normalized = String(reason || '').trim().toLowerCase();
  return DUPLICATE_DISMISS_REASONS.has(normalized) ? normalized : 'not_same_customer';
}

function filterDismissedCandidates(candidates, dismissedLeadIds = []) {
  const dismissedSet = new Set(dismissedLeadIds.map((leadId) => String(leadId)));
  const visibleCandidates = candidates.filter((candidate) => !dismissedSet.has(String(candidate.leadId)));
  return {
    candidates: visibleCandidates,
    dismissedCount: candidates.length - visibleCandidates.length,
  };
}

async function fetchDismissedLeadIdsForEstimate({ database = db, estimateId }) {
  const rows = await database('pipeline_duplicate_risk_dismissals')
    .where('estimate_id', estimateId)
    .select('lead_id');
  return rows.map((row) => row.lead_id).filter(Boolean);
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_err) {
    return {};
  }
}

function cleanSavedViewName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, SAVED_VIEW_NAME_MAX);
}

function clampText(value, max) {
  return String(value || '').trim().slice(0, max);
}

function normalizeSavedViewFilters(filters = {}) {
  const rawFilter = String(filters.filter || filters.stage || 'needs_action').trim();
  const rawSort = String(filters.sort || 'default').trim();
  const rawDateRange = String(filters.dateRange || filters.date_range || 'all').trim();
  return {
    filter: SAVED_VIEW_FILTERS.has(rawFilter) ? rawFilter : 'needs_action',
    search: clampText(filters.search, SAVED_VIEW_SEARCH_MAX),
    sort: SAVED_VIEW_SORTS.has(rawSort) ? rawSort : 'default',
    dateRange: SAVED_VIEW_DATE_RANGES.has(rawDateRange) ? rawDateRange : 'all',
    source: clampText(filters.source, SAVED_VIEW_SOURCE_MAX),
  };
}

function mapSavedView(row) {
  return {
    id: row.id,
    name: row.name,
    filters: normalizeSavedViewFilters(parseJsonObject(row.filters)),
    sortOrder: row.sort_order || 0,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

async function listSavedPipelineViews({ database = db, technicianId }) {
  if (!technicianId) return [];
  const rows = await database('admin_pipeline_saved_views')
    .where('technician_id', technicianId)
    .orderBy('sort_order', 'asc')
    .orderBy('created_at', 'asc')
    .select('*');
  return rows.map(mapSavedView);
}

async function createSavedPipelineView({
  database = db,
  technicianId,
  name,
  filters,
}) {
  if (!technicianId) {
    const err = new Error('technicianId is required');
    err.status = 400;
    throw err;
  }
  const cleanName = cleanSavedViewName(name);
  if (!cleanName) {
    const err = new Error('Saved view name is required');
    err.status = 400;
    throw err;
  }

  const maxSort = await database('admin_pipeline_saved_views')
    .where('technician_id', technicianId)
    .max('sort_order as max_sort')
    .first();
  const nextSort = Number(maxSort?.max_sort || 0) + 1;
  const [row] = await database('admin_pipeline_saved_views')
    .insert({
      technician_id: technicianId,
      name: cleanName,
      filters: normalizeSavedViewFilters(filters),
      sort_order: nextSort,
      updated_at: new Date(),
    })
    .returning('*');
  return mapSavedView(row);
}

async function deleteSavedPipelineView({ database = db, technicianId, viewId }) {
  if (!technicianId || !viewId) {
    const err = new Error('Saved view not found');
    err.status = 404;
    throw err;
  }
  const deleted = await database('admin_pipeline_saved_views')
    .where({ id: viewId, technician_id: technicianId })
    .del();
  if (!deleted) {
    const err = new Error('Saved view not found');
    err.status = 404;
    throw err;
  }
  return { deleted: true, id: viewId };
}

function parseOpportunityRef(value) {
  const raw = String(value || '').trim();
  if (!raw) return { leadId: null, estimateId: null };
  const leadMatch = raw.match(/(?:^|:)lead:([^:]+)/i);
  const estimateMatch = raw.match(/(?:^|:)estimate:([^:]+)/i);
  if (leadMatch || estimateMatch) {
    return {
      leadId: leadMatch ? cleanId(leadMatch[1]) : null,
      estimateId: estimateMatch ? cleanId(estimateMatch[1]) : null,
    };
  }
  if (raw.startsWith('lead:')) return { leadId: cleanId(raw.slice(5)), estimateId: null };
  if (raw.startsWith('estimate:')) return { leadId: null, estimateId: cleanId(raw.slice(9)) };
  return { leadId: null, estimateId: raw };
}

function historyLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_REVIEWED_HISTORY_LIMIT;
  return Math.min(Math.max(parsed, 1), MAX_REVIEWED_HISTORY_LIMIT);
}

function historyEvent({
  id,
  type,
  title,
  description = null,
  actor = null,
  occurredAt = null,
  source = null,
  metadata = {},
}) {
  return {
    id: id || `${type}:${occurredAt || Math.random().toString(36).slice(2)}`,
    type,
    title,
    description,
    actor,
    occurredAt,
    source,
    metadata: metadata || {},
  };
}

function compareOccurredAt(left, right) {
  const leftTime = left.occurredAt ? new Date(left.occurredAt).getTime() : 0;
  const rightTime = right.occurredAt ? new Date(right.occurredAt).getTime() : 0;
  return rightTime - leftTime;
}

function activityTitle(type) {
  return String(type || 'activity')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function mapLeadActivityEvent(row) {
  const metadata = parseJsonObject(row.metadata);
  return historyEvent({
    id: `lead_activity:${row.id}`,
    type: row.activity_type || 'lead_activity',
    title: activityTitle(row.activity_type),
    description: row.description || null,
    actor: row.performed_by || null,
    occurredAt: row.created_at || null,
    source: 'lead_activity',
    metadata: {
      estimateId: metadata.estimateId || metadata.estimate_id || null,
      hasMetadata: Object.keys(metadata).length > 0,
    },
  });
}

function estimateLifecycleEvents(estimate) {
  if (!estimate) return [];
  return [
    estimate.created_at && historyEvent({
      id: `estimate:${estimate.id}:created`,
      type: 'estimate_created',
      title: 'Estimate Created',
      description: estimate.status ? `Status: ${estimate.status}` : null,
      actor: estimate.created_by_name || null,
      occurredAt: estimate.created_at,
      source: 'estimate',
      metadata: { estimateId: estimate.id },
    }),
    estimate.sent_at && historyEvent({
      id: `estimate:${estimate.id}:sent`,
      type: 'estimate_sent',
      title: 'Estimate Sent',
      occurredAt: estimate.sent_at,
      source: 'estimate',
      metadata: { estimateId: estimate.id },
    }),
    estimate.viewed_at && historyEvent({
      id: `estimate:${estimate.id}:viewed`,
      type: 'estimate_viewed',
      title: 'Estimate Viewed',
      occurredAt: estimate.viewed_at,
      source: 'estimate',
      metadata: { estimateId: estimate.id },
    }),
    estimate.accepted_at && historyEvent({
      id: `estimate:${estimate.id}:accepted`,
      type: 'estimate_accepted',
      title: 'Estimate Accepted',
      occurredAt: estimate.accepted_at,
      source: 'estimate',
      metadata: { estimateId: estimate.id },
    }),
    estimate.declined_at && historyEvent({
      id: `estimate:${estimate.id}:declined`,
      type: 'estimate_declined',
      title: 'Estimate Declined',
      occurredAt: estimate.declined_at,
      source: 'estimate',
      metadata: { estimateId: estimate.id },
    }),
  ].filter(Boolean);
}

function leadLifecycleEvents(lead) {
  if (!lead) return [];
  return [
    lead.created_at && historyEvent({
      id: `lead:${lead.id}:created`,
      type: 'lead_created',
      title: 'Lead Created',
      description: lead.status ? `Status: ${lead.status}` : null,
      occurredAt: lead.created_at,
      source: 'lead',
      metadata: { leadId: lead.id },
    }),
    lead.first_contact_at && historyEvent({
      id: `lead:${lead.id}:first_contact`,
      type: 'lead_contacted',
      title: 'Lead Contacted',
      occurredAt: lead.first_contact_at,
      source: 'lead',
      metadata: { leadId: lead.id },
    }),
  ].filter(Boolean);
}

function mapDismissalTimelineEvent(row) {
  return historyEvent({
    id: `duplicate_dismissal:${row.id}`,
    type: 'duplicate_dismissed',
    title: 'Duplicate Match Dismissed',
    description: normalizeDismissReason(row.reason).replace(/_/g, ' '),
    actor: row.dismissed_by_name || null,
    occurredAt: row.updated_at || row.created_at || null,
    source: 'duplicate_review',
    metadata: {
      estimateId: row.estimate_id || null,
      leadId: row.lead_id || null,
      hasNote: Boolean(row.note),
    },
  });
}

function mapAuditTimelineEvent(row) {
  const metadata = parseJsonObject(row.metadata);
  const title = row.action === 'pipeline.duplicate_risk.reopen_link'
    ? 'Duplicate Link Reopened'
    : row.action === 'pipeline.duplicate_risk.reopen_dismissal'
      ? 'Dismissed Match Reopened'
      : activityTitle(row.action);
  return historyEvent({
    id: `audit:${row.id}`,
    type: row.action || 'audit_event',
    title,
    actor: row.actor_name || row.actor_type || null,
    occurredAt: row.created_at || null,
    source: 'audit_log',
    metadata: {
      estimateId: metadata.estimateId || metadata.estimate_id || row.resource_id || null,
      leadId: metadata.leadId || metadata.lead_id || null,
    },
  });
}

function mapDismissalHistory(row) {
  return {
    id: row.id,
    action: 'dismissed',
    estimateId: row.estimate_id || null,
    leadId: row.lead_id || null,
    estimateRef: compactHistoryRef('Est', row.estimate_id),
    leadRef: compactHistoryRef('Lead', row.lead_id),
    estimateLabel: historyEstimateName(row),
    leadLabel: historyLeadName(row),
    customerName: historyCustomerName(row),
    reason: row.reason || null,
    actor: row.dismissed_by_name || null,
    hasNote: Boolean(row.note),
    createdAt: row.updated_at || row.created_at || null,
  };
}

function mapLinkedHistory(row) {
  const metadata = parseJsonObject(row.metadata);
  const estimateId = metadata.estimateId || metadata.estimate_id || null;
  return {
    id: row.id,
    action: 'linked',
    estimateId,
    leadId: row.lead_id || null,
    estimateRef: compactHistoryRef('Est', estimateId),
    leadRef: compactHistoryRef('Lead', row.lead_id),
    estimateLabel: historyEstimateName(row),
    leadLabel: historyLeadName(row),
    customerName: historyCustomerName(row),
    reason: null,
    actor: row.performed_by || null,
    hasNote: false,
    createdAt: row.created_at || null,
  };
}

function linkedHistoryKey(item) {
  if (!item?.leadId || !item?.estimateId) return null;
  return `${item.leadId}:${item.estimateId}`;
}

function filterReopenedLinkedHistory(items, unlinkRows = []) {
  const reopenedByPair = new Map();
  for (const row of unlinkRows) {
    const metadata = parseJsonObject(row.metadata);
    const estimateId = metadata.estimateId || metadata.estimate_id || null;
    const leadId = row.lead_id || metadata.leadId || metadata.lead_id || null;
    if (!estimateId || !leadId) continue;
    const createdAt = row.created_at ? new Date(row.created_at).getTime() : 0;
    const key = `${leadId}:${estimateId}`;
    reopenedByPair.set(key, Math.max(reopenedByPair.get(key) || 0, createdAt));
  }

  return items.filter((item) => {
    if (item.action !== 'linked') return true;
    const key = linkedHistoryKey(item);
    if (!key || !reopenedByPair.has(key)) return true;
    const linkedAt = item.createdAt ? new Date(item.createdAt).getTime() : 0;
    return linkedAt > reopenedByPair.get(key);
  });
}

function compareHistoryCreatedAt(left, right) {
  const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : 0;
  const rightTime = right.createdAt ? new Date(right.createdAt).getTime() : 0;
  return rightTime - leftTime;
}

function applyEstimateHistoryContext(items, estimates = []) {
  const estimatesById = new Map(estimates.map((estimate) => [String(estimate.id), estimate]));
  return items.map((item) => {
    if (!item.estimateId) return item;
    const estimate = estimatesById.get(String(item.estimateId));
    if (!estimate) return item;
    const estimateLabel = item.estimateLabel || estimate.customer_name || null;
    return {
      ...item,
      estimateLabel,
      customerName: item.customerName || estimateLabel,
    };
  });
}

async function getReviewedHistory({ database = db, limit = DEFAULT_REVIEWED_HISTORY_LIMIT } = {}) {
  const safeLimit = historyLimit(limit);
  const dismissalTableExists = await database.schema.hasTable('pipeline_duplicate_risk_dismissals');
  const dismissalRows = dismissalTableExists
    ? await database('pipeline_duplicate_risk_dismissals')
      .leftJoin('technicians', 'pipeline_duplicate_risk_dismissals.dismissed_by', 'technicians.id')
      .leftJoin('estimates', 'pipeline_duplicate_risk_dismissals.estimate_id', 'estimates.id')
      .leftJoin('leads', 'pipeline_duplicate_risk_dismissals.lead_id', 'leads.id')
      .select(
        'pipeline_duplicate_risk_dismissals.*',
        database.raw('technicians.name as dismissed_by_name'),
        database.raw('estimates.customer_name as estimate_customer_name'),
        database.raw('leads.first_name as lead_first_name'),
        database.raw('leads.last_name as lead_last_name'),
      )
      .orderBy('pipeline_duplicate_risk_dismissals.updated_at', 'desc')
      .limit(safeLimit)
    : [];

  const linkedRows = await database('lead_activities')
    .leftJoin('leads', 'lead_activities.lead_id', 'leads.id')
    .where('lead_activities.activity_type', 'linked_estimate')
    .select(
      'lead_activities.id',
      'lead_activities.lead_id',
      'lead_activities.performed_by',
      'lead_activities.metadata',
      'lead_activities.created_at',
      database.raw('leads.first_name as lead_first_name'),
      database.raw('leads.last_name as lead_last_name'),
    )
    .orderBy('lead_activities.created_at', 'desc')
    .limit(safeLimit);

  const unlinkRows = await database('lead_activities')
    .where('activity_type', 'unlinked_estimate')
    .select('id', 'lead_id', 'metadata', 'created_at')
    .orderBy('created_at', 'desc')
    .limit(MAX_REVIEWED_HISTORY_LIMIT);

  const mappedItems = [
    ...dismissalRows.map(mapDismissalHistory),
    ...linkedRows.map(mapLinkedHistory),
  ];
  const estimateIds = [...new Set(mappedItems.map((item) => item.estimateId).filter(Boolean))];
  const estimateRows = estimateIds.length
    ? await database('estimates').whereIn('id', estimateIds).select('id', 'customer_name')
    : [];
  const data = applyEstimateHistoryContext(filterReopenedLinkedHistory(mappedItems, unlinkRows), estimateRows)
    .sort(compareHistoryCreatedAt)
    .slice(0, safeLimit);

  return { data };
}

async function getOpportunityHistory({
  database = db,
  opportunityId = '',
  leadId = null,
  estimateId = null,
  limit = 80,
} = {}) {
  const parsed = parseOpportunityRef(opportunityId);
  const cleanLeadId = cleanId(leadId) || parsed.leadId;
  const requestedEstimateId = cleanId(estimateId) || parsed.estimateId;
  let cleanEstimateId = requestedEstimateId;

  if (!cleanLeadId && !cleanEstimateId) {
    const err = new Error('leadId or estimateId is required');
    err.status = 400;
    throw err;
  }

  const [lead, estimateById] = await Promise.all([
    cleanLeadId
      ? database('leads')
        .leftJoin('lead_sources', 'leads.lead_source_id', 'lead_sources.id')
        .select('leads.*', database.raw('lead_sources.name as source_name'))
        .where('leads.id', cleanLeadId)
        .whereNull('leads.deleted_at')
        .first()
      : null,
    cleanEstimateId
      ? database('estimates')
        .leftJoin('technicians', 'estimates.created_by_technician_id', 'technicians.id')
        .select('estimates.*', database.raw('technicians.name as created_by_name'))
        .where('estimates.id', cleanEstimateId)
        .first()
      : null,
  ]);

  if (cleanLeadId && !lead) {
    const err = new Error('Lead not found');
    err.status = 404;
    throw err;
  }
  if (cleanEstimateId && (!estimateById || estimateById.archived_at)) {
    const err = new Error('Estimate not found');
    err.status = 404;
    throw err;
  }

  cleanEstimateId = cleanEstimateId || lead?.estimate_id || null;
  const estimate = estimateById || (cleanEstimateId
    ? await database('estimates')
      .leftJoin('technicians', 'estimates.created_by_technician_id', 'technicians.id')
      .select('estimates.*', database.raw('technicians.name as created_by_name'))
      .where('estimates.id', cleanEstimateId)
      .whereNull('estimates.archived_at')
      .first()
    : null);
  if (!requestedEstimateId && cleanEstimateId && !estimate) {
    cleanEstimateId = null;
  }

  const historyLimitSafe = historyLimit(limit);
  const leadActivityRows = cleanLeadId
    ? await database('lead_activities')
      .where('lead_id', cleanLeadId)
      .select('id', 'lead_id', 'activity_type', 'description', 'performed_by', 'metadata', 'created_at')
      .orderBy('created_at', 'desc')
      .limit(historyLimitSafe)
    : [];

  const dismissalTableExists = await database.schema.hasTable('pipeline_duplicate_risk_dismissals');
  let dismissalQuery = null;
  if (dismissalTableExists && cleanEstimateId) {
    dismissalQuery = database('pipeline_duplicate_risk_dismissals')
      .leftJoin('technicians', 'pipeline_duplicate_risk_dismissals.dismissed_by', 'technicians.id')
      .select(
        'pipeline_duplicate_risk_dismissals.*',
        database.raw('technicians.name as dismissed_by_name'),
      )
      .where('pipeline_duplicate_risk_dismissals.estimate_id', cleanEstimateId);
    if (cleanLeadId) dismissalQuery = dismissalQuery.where('pipeline_duplicate_risk_dismissals.lead_id', cleanLeadId);
  }
  const dismissalRows = dismissalQuery
    ? await dismissalQuery.orderBy('pipeline_duplicate_risk_dismissals.updated_at', 'desc').limit(historyLimitSafe)
    : [];

  const auditActions = ['pipeline.duplicate_risk.reopen_dismissal', 'pipeline.duplicate_risk.reopen_link'];
  const auditRows = cleanEstimateId
    ? await database('audit_log')
      .leftJoin('technicians as audit_technicians', 'audit_log.actor_id', 'audit_technicians.id')
      .select(
        'audit_log.id',
        'audit_log.actor_type',
        'audit_log.actor_id',
        'audit_log.action',
        'audit_log.resource_type',
        'audit_log.resource_id',
        'audit_log.metadata',
        'audit_log.created_at',
        database.raw('audit_technicians.name as actor_name'),
      )
      .where('audit_log.resource_type', 'estimate')
      .where('audit_log.resource_id', cleanEstimateId)
      .whereIn('action', auditActions)
      .orderBy('audit_log.created_at', 'desc')
      .limit(historyLimitSafe)
    : [];

  const filteredAuditRows = cleanLeadId
    ? auditRows.filter((row) => {
      const metadata = parseJsonObject(row.metadata);
      const rowLeadId = metadata.leadId || metadata.lead_id || null;
      return !rowLeadId || String(rowLeadId) === String(cleanLeadId);
    })
    : auditRows;

  const events = [
    ...leadLifecycleEvents(lead),
    ...estimateLifecycleEvents(estimate),
    ...leadActivityRows.map(mapLeadActivityEvent),
    ...dismissalRows.map(mapDismissalTimelineEvent),
    ...filteredAuditRows.map(mapAuditTimelineEvent),
  ].sort(compareOccurredAt).slice(0, historyLimitSafe);

  return {
    opportunity: {
      opportunityId: cleanLeadId ? `lead:${cleanLeadId}` : `estimate:${cleanEstimateId}`,
      leadId: cleanLeadId || null,
      estimateId: cleanEstimateId || null,
      customerName: firstPresent(estimate ? estimateDisplayName(estimate) : null, lead ? leadDisplayName(lead) : null),
      leadName: lead ? leadDisplayName(lead) : null,
      estimateName: estimate ? estimateDisplayName(estimate) : null,
      source: firstPresent(lead?.source_name, lead?.source, lead?.lead_source, estimate?.source, estimate?.lead_source),
      status: firstPresent(estimate?.status, lead?.status),
    },
    data: events,
  };
}

async function getLinkCandidateLeads({ database = db, estimateId }) {
  const id = cleanId(estimateId);
  if (!id) {
    const err = new Error('estimateId is required');
    err.status = 400;
    throw err;
  }

  const estimate = await database('estimates').where('id', id).first();
  if (!estimate || estimate.archived_at) {
    const err = new Error('Estimate not found');
    err.status = 404;
    throw err;
  }

  const phoneDigits = searchDigits(estimate.customer_phone || estimate.phone).slice(-10);
  const email = String(estimate.customer_email || estimate.email || '').trim().toLowerCase();
  const address = String(estimate.address || estimate.service_address || '').trim();
  const nameParts = String(estimate.customer_name || estimate.name || '').trim().split(/\s+/).filter(Boolean);
  const hasMatchSignal = phoneDigits.length >= 7 || email || address || nameParts.length;
  if (!hasMatchSignal) {
    return {
      estimate: {
        estimateId: estimate.id,
        name: estimateDisplayName(estimate),
        phone: estimate.customer_phone || null,
        email: estimate.customer_email || null,
        address: estimate.address || null,
        serviceInterest: estimate.service_interest || null,
        status: estimate.status || null,
        createdAt: estimate.created_at || null,
        updatedAt: estimate.updated_at || null,
      },
      candidates: [],
      dismissedCount: 0,
    };
  }

  let query = database('leads')
    .leftJoin('lead_sources', 'leads.lead_source_id', 'lead_sources.id')
    .select('leads.*', 'lead_sources.name as source_name')
    .whereNull('leads.deleted_at')
    .limit(10);

  query = query.where(function () {
    if (phoneDigits.length >= 7) {
      this.orWhereRaw("RIGHT(regexp_replace(COALESCE(leads.phone, ''), '[^0-9]', '', 'g'), 10) = ?", [phoneDigits]);
    }
    if (email) {
      this.orWhereRaw('LOWER(COALESCE(leads.email, \'\')) = ?', [email]);
    }
    if (address) {
      this.orWhereILike('leads.address', `%${address}%`);
    }
    if (nameParts.length) {
      this.orWhere(function () {
        for (const part of nameParts.slice(0, 2)) {
          this.orWhereILike('leads.first_name', `%${part}%`)
            .orWhereILike('leads.last_name', `%${part}%`);
        }
      });
    }
  });

  const rows = await query.orderBy('leads.updated_at', 'desc');
  const dismissedLeadIds = await fetchDismissedLeadIdsForEstimate({ database, estimateId: id });
  const filtered = filterDismissedCandidates(rows.map(matchCandidateLead), dismissedLeadIds);

  return {
    estimate: {
      estimateId: estimate.id,
      name: estimateDisplayName(estimate),
      phone: estimate.customer_phone || null,
      email: estimate.customer_email || null,
      address: estimate.address || null,
      serviceInterest: estimate.service_interest || null,
      status: estimate.status || null,
      createdAt: estimate.created_at || null,
      updatedAt: estimate.updated_at || null,
    },
    candidates: filtered.candidates,
    dismissedCount: filtered.dismissedCount,
  };
}

async function linkOpportunityRecords({
  database = db,
  leadId,
  estimateId,
  force = false,
  actor = 'Admin',
}) {
  const cleanLeadId = cleanId(leadId);
  const cleanEstimateId = cleanId(estimateId);
  if (!cleanLeadId || !cleanEstimateId) {
    const err = new Error('leadId and estimateId are required');
    err.status = 400;
    throw err;
  }

  return database.transaction(async (trx) => {
    const lead = await trx('leads').where('id', cleanLeadId).whereNull('deleted_at').first();
    if (!lead) {
      const err = new Error('Lead not found');
      err.status = 404;
      throw err;
    }

    const estimate = await trx('estimates').where('id', cleanEstimateId).first();
    if (!estimate || estimate.archived_at) {
      const err = new Error('Estimate not found');
      err.status = 404;
      throw err;
    }

    if (lead.estimate_id && String(lead.estimate_id) !== String(cleanEstimateId) && !force) {
      const err = new Error('Lead is already linked to a different estimate');
      err.status = 409;
      err.code = 'lead_already_linked';
      err.currentEstimateId = lead.estimate_id;
      throw err;
    }

    const [updatedLead] = await trx('leads')
      .where('id', cleanLeadId)
      .update({
        estimate_id: cleanEstimateId,
        updated_at: new Date(),
      })
      .returning('*');

    await trx('lead_activities').insert({
      lead_id: cleanLeadId,
      activity_type: 'linked_estimate',
      description: `Linked estimate ${cleanEstimateId}`,
      performed_by: actor,
      metadata: JSON.stringify({
        estimateId: cleanEstimateId,
        previousEstimateId: lead.estimate_id || null,
        source: 'admin_pipeline',
        forced: Boolean(force),
      }),
    });

    return {
      lead: updatedLead,
      estimate,
      linked: true,
    };
  });
}

async function dismissDuplicateRisk({
  database = db,
  estimateId,
  leadId = null,
  reason = 'not_same_customer',
  note = '',
  actorId = null,
}) {
  const cleanEstimateId = cleanId(estimateId);
  if (!cleanEstimateId) {
    const err = new Error('estimateId is required');
    err.status = 400;
    throw err;
  }

  const cleanLeadId = cleanId(leadId);
  if (!cleanLeadId) {
    const err = new Error('leadId is required');
    err.status = 400;
    throw err;
  }
  const cleanReason = normalizeDismissReason(reason);
  const cleanNote = String(note || '').trim() || null;

  return database.transaction(async (trx) => {
    const estimate = await trx('estimates').where('id', cleanEstimateId).first();
    if (!estimate || estimate.archived_at) {
      const err = new Error('Estimate not found');
      err.status = 404;
      throw err;
    }

    if (cleanLeadId) {
      const lead = await trx('leads').where('id', cleanLeadId).whereNull('deleted_at').first();
      if (!lead) {
        const err = new Error('Lead not found');
        err.status = 404;
        throw err;
      }
    }

    const now = new Date();
    const [dismissal] = await trx('pipeline_duplicate_risk_dismissals')
      .insert({
        estimate_id: cleanEstimateId,
        lead_id: cleanLeadId,
        dismissed_by: actorId || null,
        reason: cleanReason,
        note: cleanNote,
        updated_at: now,
      })
      .onConflict(['estimate_id', 'lead_id'])
      .merge({
        lead_id: cleanLeadId,
        dismissed_by: actorId || null,
        reason: cleanReason,
        note: cleanNote,
        updated_at: now,
      })
      .returning('*');

    await trx('audit_log').insert({
      actor_type: actorId ? 'technician' : 'system',
      actor_id: actorId || null,
      action: 'pipeline.duplicate_risk.dismiss',
      resource_type: 'estimate',
      resource_id: cleanEstimateId,
      metadata: {
        estimateId: cleanEstimateId,
        leadId: cleanLeadId,
        reason: cleanReason,
        hasNote: Boolean(cleanNote),
        source: 'admin_pipeline',
      },
    });

    return {
      dismissed: true,
      dismissal,
      estimate,
    };
  });
}

async function reopenReviewedDuplicate({
  database = db,
  action,
  estimateId,
  leadId,
  actorId = null,
  actor = 'Admin',
}) {
  const cleanAction = String(action || '').trim().toLowerCase();
  const cleanEstimateId = cleanId(estimateId);
  const cleanLeadId = cleanId(leadId);
  if (!cleanEstimateId || !cleanLeadId) {
    const err = new Error('estimateId and leadId are required');
    err.status = 400;
    throw err;
  }

  if (cleanAction === 'dismissed') {
    return database.transaction(async (trx) => {
      const deleted = await trx('pipeline_duplicate_risk_dismissals')
        .where({ estimate_id: cleanEstimateId, lead_id: cleanLeadId })
        .del();
      if (!deleted) {
        const err = new Error('Reviewed dismissal not found');
        err.status = 404;
        throw err;
      }

      await trx('audit_log').insert({
        actor_type: actorId ? 'technician' : 'system',
        actor_id: actorId || null,
        action: 'pipeline.duplicate_risk.reopen_dismissal',
        resource_type: 'estimate',
        resource_id: cleanEstimateId,
        metadata: {
          estimateId: cleanEstimateId,
          leadId: cleanLeadId,
          source: 'admin_pipeline',
        },
      });

      return { reopened: true, action: 'dismissed', estimateId: cleanEstimateId, leadId: cleanLeadId };
    });
  }

  if (cleanAction === 'linked') {
    return database.transaction(async (trx) => {
      const lead = await trx('leads').where('id', cleanLeadId).whereNull('deleted_at').first();
      if (!lead) {
        const err = new Error('Lead not found');
        err.status = 404;
        throw err;
      }
      if (String(lead.estimate_id || '') !== String(cleanEstimateId)) {
        const err = new Error('Lead is no longer linked to this estimate');
        err.status = 409;
        err.code = 'link_changed';
        err.currentEstimateId = lead.estimate_id || null;
        throw err;
      }

      const [updatedLead] = await trx('leads')
        .where('id', cleanLeadId)
        .where('estimate_id', cleanEstimateId)
        .update({
          estimate_id: null,
          updated_at: new Date(),
        })
        .returning('*');
      if (!updatedLead) {
        const err = new Error('Lead is no longer linked to this estimate');
        err.status = 409;
        err.code = 'link_changed';
        err.currentEstimateId = null;
        throw err;
      }

      await trx('lead_activities').insert({
        lead_id: cleanLeadId,
        activity_type: 'unlinked_estimate',
        description: `Unlinked estimate ${cleanEstimateId}`,
        performed_by: actor,
        metadata: JSON.stringify({
          estimateId: cleanEstimateId,
          previousEstimateId: cleanEstimateId,
          source: 'admin_pipeline',
        }),
      });

      await trx('audit_log').insert({
        actor_type: actorId ? 'technician' : 'system',
        actor_id: actorId || null,
        action: 'pipeline.duplicate_risk.reopen_link',
        resource_type: 'estimate',
        resource_id: cleanEstimateId,
        metadata: {
          estimateId: cleanEstimateId,
          leadId: cleanLeadId,
          source: 'admin_pipeline',
        },
      });

      return { reopened: true, action: 'linked', estimateId: cleanEstimateId, leadId: cleanLeadId };
    });
  }

  const err = new Error('action must be dismissed or linked');
  err.status = 400;
  throw err;
}

function applyLeadSearch(query, search) {
  const term = String(search || '').trim();
  if (!term) return query;
  const s = `%${term}%`;
  const ref = searchRef(term);
  const digits = searchDigits(search);
  return query.where(function () {
    this.whereILike('leads.first_name', s)
      .orWhereILike('leads.last_name', s)
      .orWhereILike('leads.phone', s)
      .orWhereILike('leads.email', s)
      .orWhereILike('leads.address', s)
      .orWhereILike('leads.service_interest', s)
      .orWhereILike('lead_sources.name', s);
    if (ref) {
      this.orWhereRaw('leads.id::text ILIKE ?', [`%${ref}%`])
        .orWhereRaw('leads.estimate_id::text ILIKE ?', [`%${ref}%`]);
    }
    if (digits.length >= 7) {
      this.orWhereRaw("regexp_replace(COALESCE(leads.phone, ''), '[^0-9]', '', 'g') LIKE ?", [`%${digits}%`]);
    }
  });
}

function applyEstimateSearch(query, search) {
  const term = String(search || '').trim();
  if (!term) return query;
  const s = `%${term}%`;
  const ref = searchRef(term);
  const digits = searchDigits(search);
  return query.where(function () {
    this.whereILike('estimates.customer_name', s)
      .orWhereILike('estimates.customer_phone', s)
      .orWhereILike('estimates.customer_email', s)
      .orWhereILike('estimates.address', s)
      .orWhereILike('estimates.service_interest', s)
      .orWhereILike('estimates.lead_source', s)
      .orWhereILike('estimates.source', s);
    if (ref) {
      this.orWhereRaw('estimates.id::text ILIKE ?', [`%${ref}%`])
        .orWhereRaw('estimates.customer_id::text ILIKE ?', [`%${ref}%`]);
    }
    if (digits.length >= 7) {
      this.orWhereRaw("regexp_replace(COALESCE(estimates.customer_phone, ''), '[^0-9]', '', 'g') LIKE ?", [`%${digits}%`]);
    }
  });
}

function applyLeadSourceFilter(query, source, { hasLegacyLeadSource = false } = {}) {
  const term = String(source || '').trim();
  if (!term) return query;
  const sourceTerm = `%${term}%`;
  return query.where(function () {
    this.whereILike('lead_sources.name', sourceTerm)
      .orWhereILike('lead_sources.channel', sourceTerm)
      .orWhereILike('leads.lead_type', sourceTerm);
    if (hasLegacyLeadSource) {
      this.orWhereILike('leads.lead_source', sourceTerm);
    }
  });
}

async function fetchLeads({ search, source, ownerId }) {
  const hasLegacyLeadSource = source ? await hasLegacyLeadSourceColumn() : false;
  let query = db('leads')
    .leftJoin('lead_sources', 'leads.lead_source_id', 'lead_sources.id')
    .leftJoin('technicians', 'leads.assigned_to', 'technicians.id')
    .select(
      'leads.*',
      'lead_sources.name as source_name',
      'lead_sources.source_type',
      'lead_sources.channel as source_channel',
      db.raw('technicians.name as assigned_name'),
    )
    .whereNull('leads.deleted_at')
    .orderBy('leads.first_contact_at', 'desc')
    .limit(MAX_CANDIDATES + 1);

  query = applyLeadSearch(query, search);
  query = applyLeadSourceFilter(query, source, { hasLegacyLeadSource });
  if (ownerId) query = query.where('leads.assigned_to', ownerId);
  return query;
}

async function fetchEstimates({ search, source, ownerId }) {
  let query = db('estimates')
    .leftJoin('technicians', 'estimates.created_by_technician_id', 'technicians.id')
    .select('estimates.*', 'technicians.name as created_by_name')
    .whereNull('estimates.archived_at')
    .orderBy('estimates.created_at', 'desc')
    .limit(MAX_CANDIDATES + 1);

  query = applyEstimateSearch(query, search);
  if (source) {
    const sourceTerm = `%${String(source).trim()}%`;
    query = query.where(function () {
      this.whereILike('estimates.source', sourceTerm)
        .orWhereILike('estimates.lead_source', sourceTerm);
    });
  }
  if (ownerId) query = query.where('estimates.created_by_technician_id', ownerId);
  return query;
}

async function fetchDismissedDuplicatePairs() {
  const exists = await db.schema.hasTable('pipeline_duplicate_risk_dismissals');
  if (!exists) return [];
  return db('pipeline_duplicate_risk_dismissals').select('estimate_id', 'lead_id');
}

// GET /api/admin/pipeline/saved-views
router.get('/saved-views', async (req, res, next) => {
  try {
    const savedViews = await listSavedPipelineViews({
      technicianId: req.technicianId || req.technician?.id || null,
    });
    res.json({ savedViews });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/pipeline/saved-views
router.post('/saved-views', async (req, res, next) => {
  try {
    const savedView = await createSavedPipelineView({
      technicianId: req.technicianId || req.technician?.id || null,
      name: req.body?.name,
      filters: req.body?.filters || {},
    });
    res.status(201).json({ savedView });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// DELETE /api/admin/pipeline/saved-views/:viewId
router.delete('/saved-views/:viewId', async (req, res, next) => {
  try {
    res.json(await deleteSavedPipelineView({
      technicianId: req.technicianId || req.technician?.id || null,
      viewId: req.params.viewId,
    }));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// GET /api/admin/pipeline/opportunities
router.get('/opportunities', async (req, res, next) => {
  try {
    const query = {
      search: req.query.search || '',
      stage: req.query.stage || req.query.filter || '',
      status: req.query.status || '',
      needsAction: req.query.needsAction ?? '',
      source: String(req.query.source || '').trim(),
      ownerId: req.query.ownerId || req.query.owner_id || '',
      dateFrom: req.query.dateFrom || req.query.date_from || '',
      dateTo: req.query.dateTo || req.query.date_to || '',
      sort: req.query.sort || 'default',
      page: req.query.page || 1,
      pageSize: req.query.pageSize || req.query.page_size || 50,
    };

    const [leadsRaw, estimatesRaw, dismissedDuplicatePairs] = await Promise.all([
      fetchLeads(query),
      fetchEstimates(query),
      fetchDismissedDuplicatePairs(),
    ]);
    const truncated = leadsRaw.length > MAX_CANDIDATES || estimatesRaw.length > MAX_CANDIDATES;
    const leads = leadsRaw.slice(0, MAX_CANDIDATES);
    const estimates = estimatesRaw.slice(0, MAX_CANDIDATES);

    res.json(buildPipelineResponse({
      leads,
      estimates,
      query,
      truncated,
      candidateStats: {
        candidateCap: MAX_CANDIDATES,
        leadCandidates: leadsRaw.length,
        estimateCandidates: estimatesRaw.length,
        leadCandidatesReturned: leads.length,
        estimateCandidatesReturned: estimates.length,
      },
      dismissedDuplicatePairs,
    }));
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/pipeline/opportunities/reviewed-history
router.get('/opportunities/reviewed-history', async (req, res, next) => {
  try {
    res.json(await getReviewedHistory({ limit: req.query.limit }));
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/pipeline/opportunities/history
router.get('/opportunities/history', async (req, res, next) => {
  try {
    res.json(await getOpportunityHistory({
      opportunityId: req.query.opportunityId || req.query.opportunity_id || '',
      leadId: req.query.leadId || req.query.lead_id || null,
      estimateId: req.query.estimateId || req.query.estimate_id || null,
      limit: req.query.limit,
    }));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// GET /api/admin/pipeline/opportunities/:estimateId/link-candidates
router.get('/opportunities/:estimateId/link-candidates', async (req, res, next) => {
  try {
    res.json(await getLinkCandidateLeads({ estimateId: req.params.estimateId }));
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/pipeline/opportunities/link
router.post('/opportunities/link', async (req, res, next) => {
  try {
    const result = await linkOpportunityRecords({
      leadId: req.body.leadId || req.body.lead_id,
      estimateId: req.body.estimateId || req.body.estimate_id,
      force: req.body.force === true,
      actor: performedBy(req),
    });
    res.json(result);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({
        error: err.message,
        code: err.code,
        currentEstimateId: err.currentEstimateId,
      });
    }
    next(err);
  }
});

// POST /api/admin/pipeline/opportunities/:estimateId/dismiss-duplicate-risk
router.post('/opportunities/:estimateId/dismiss-duplicate-risk', async (req, res, next) => {
  try {
    const result = await dismissDuplicateRisk({
      estimateId: req.params.estimateId,
      leadId: req.body.leadId || req.body.lead_id || null,
      reason: req.body.reason,
      note: req.body.note,
      actorId: req.technicianId || req.technician?.id || null,
    });
    res.json(result);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
});

// POST /api/admin/pipeline/opportunities/reviewed-history/reopen
router.post('/opportunities/reviewed-history/reopen', async (req, res, next) => {
  try {
    const result = await reopenReviewedDuplicate({
      action: req.body.action,
      estimateId: req.body.estimateId || req.body.estimate_id,
      leadId: req.body.leadId || req.body.lead_id,
      actorId: req.technicianId || req.technician?.id || null,
      actor: performedBy(req),
    });
    res.json(result);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({
        error: err.message,
        code: err.code,
        currentEstimateId: err.currentEstimateId,
      });
    }
    next(err);
  }
});

module.exports = router;
module.exports.__private = {
  applyEstimateSearch,
  applyLeadSearch,
  applyLeadSourceFilter,
  hasLegacyLeadSourceColumn,
  applyEstimateHistoryContext,
  compareHistoryCreatedAt,
  dismissDuplicateRisk,
  fetchDismissedDuplicatePairs,
  fetchDismissedLeadIdsForEstimate,
  filterDismissedCandidates,
  filterReopenedLinkedHistory,
  getLinkCandidateLeads,
  getOpportunityHistory,
  getReviewedHistory,
  historyEvent,
  historyLimit,
  linkOpportunityRecords,
  listSavedPipelineViews,
  createSavedPipelineView,
  deleteSavedPipelineView,
  mapSavedView,
  mapAuditTimelineEvent,
  mapDismissalHistory,
  mapDismissalTimelineEvent,
  mapLeadActivityEvent,
  mapLinkedHistory,
  normalizeSavedViewFilters,
  normalizeDismissReason,
  parseOpportunityRef,
  parseJsonObject,
  reopenReviewedDuplicate,
  searchDigits,
  searchRef,
};
