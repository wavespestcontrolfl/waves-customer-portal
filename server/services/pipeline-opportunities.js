const DAY_MS = 24 * 60 * 60 * 1000;
const SENT_STALE_MS = 2 * DAY_MS;
const VIEWED_STALE_MS = DAY_MS;

const PIPELINE_STAGES = {
  NEW_LEAD: 'new_lead',
  CONTACTED: 'contacted',
  QUALIFIED: 'qualified',
  ESTIMATE_NEEDED: 'estimate_needed',
  ESTIMATE_DRAFT: 'estimate_draft',
  ESTIMATE_SENT: 'estimate_sent',
  ESTIMATE_VIEWED: 'estimate_viewed',
  WON: 'won',
  LOST: 'lost',
};

const FILTER_KEYS = [
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
];

function firstPresent(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function normalizeStatus(status) {
  return String(status || '').trim().toLowerCase();
}

function normalizePhoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function asDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function latestDate(...values) {
  return values
    .map(asDate)
    .filter(Boolean)
    .sort((a, b) => b.getTime() - a.getTime())[0] || null;
}

function toIso(value) {
  const date = asDate(value);
  return date ? date.toISOString() : null;
}

function centsFromValue(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function estimateValueCents(estimate) {
  if (!estimate) return { valueCents: null, valueConfidence: 'unknown' };
  const explicitCents = firstPresent(
    estimate.totalCents,
    estimate.total_cents,
    estimate.amountCents,
    estimate.amount_cents,
  );
  if (explicitCents !== null) {
    const n = Number(explicitCents);
    return Number.isFinite(n)
      ? { valueCents: Math.round(n), valueConfidence: 'estimate_total' }
      : { valueCents: null, valueConfidence: 'unknown' };
  }
  const value = firstPresent(
    estimate.total,
    estimate.amount,
    estimate.monthlyTotal,
    estimate.monthly_total,
    estimate.initialServiceValue,
    estimate.initial_service_value,
  );
  return {
    valueCents: centsFromValue(value),
    valueConfidence: value === null ? 'unknown' : 'estimate_total',
  };
}

function leadValueCents(lead) {
  if (!lead) return { valueCents: null, valueConfidence: 'unknown' };
  const value = firstPresent(
    lead.estimatedValue,
    lead.estimated_value,
    lead.monthlyValue,
    lead.monthly_value,
    lead.initialServiceValue,
    lead.initial_service_value,
  );
  return {
    valueCents: centsFromValue(value),
    valueConfidence: value === null ? 'unknown' : 'lead_estimated_value',
  };
}

function deriveOpportunityStage({ lead, estimate }) {
  const leadStatus = normalizeStatus(lead?.status);
  const estimateStatus = normalizeStatus(estimate?.status);

  if (estimateStatus === 'accepted' || leadStatus === 'won') {
    return {
      stage: PIPELINE_STAGES.WON,
      status: 'won',
      stageReason: 'Estimate accepted or lead marked won',
    };
  }

  if (
    estimateStatus === 'declined'
    || estimateStatus === 'rejected'
    || leadStatus === 'lost'
    || leadStatus === 'disqualified'
    // Closed lead statuses that previously fell through to an ACTIVE
    // new_lead stage. unresponsive is now assigned at scale by the daily
    // staleness sweep; duplicate is the same closed class (see the
    // CLOSED_LEAD_STATUSES sets in admin-agents / lead-estimate-link).
    || leadStatus === 'unresponsive'
    || leadStatus === 'duplicate'
  ) {
    return {
      stage: PIPELINE_STAGES.LOST,
      status: 'lost',
      stageReason: 'Estimate declined or lead marked lost/disqualified/unresponsive/duplicate',
    };
  }

  if (estimate?.viewedAt || estimate?.viewed_at || estimateStatus === 'viewed') {
    return {
      stage: PIPELINE_STAGES.ESTIMATE_VIEWED,
      status: 'active',
      stageReason: 'Estimate has been viewed',
    };
  }

  if (
    estimate?.sentAt
    || estimate?.sent_at
    || estimateStatus === 'sent'
    || estimateStatus === 'scheduled'
    || estimateStatus === 'sending'
  ) {
    return {
      stage: PIPELINE_STAGES.ESTIMATE_SENT,
      status: 'active',
      stageReason: 'Estimate has been sent',
    };
  }

  if (estimate?.id) {
    return {
      stage: PIPELINE_STAGES.ESTIMATE_DRAFT,
      status: 'active',
      stageReason: 'Estimate exists but has not been sent',
    };
  }

  if (leadStatus === 'qualified' || leadStatus === 'estimate_needed') {
    return {
      stage: PIPELINE_STAGES.ESTIMATE_NEEDED,
      status: 'active',
      stageReason: 'Lead is qualified and has no estimate',
    };
  }

  if (leadStatus === 'contacted') {
    return {
      stage: PIPELINE_STAGES.CONTACTED,
      status: 'active',
      stageReason: 'Lead has been contacted',
    };
  }

  if (leadStatus === 'new' || lead?.id) {
    return {
      stage: PIPELINE_STAGES.NEW_LEAD,
      status: 'active',
      stageReason: 'New or uncontacted lead',
    };
  }

  return {
    stage: PIPELINE_STAGES.NEW_LEAD,
    status: 'active',
    stageReason: 'Fallback stage',
  };
}

function deriveNextAction({ lead, estimate, stage, now = new Date() }) {
  const nowMs = asDate(now)?.getTime() || Date.now();
  const nextFollowUpAt = asDate(firstPresent(
    lead?.nextFollowUpAt,
    lead?.next_follow_up_at,
    estimate?.nextFollowUpAt,
    estimate?.next_follow_up_at,
    lead?.callbackAt,
    lead?.callback_at,
  ));
  const followUpDue = nextFollowUpAt ? nextFollowUpAt.getTime() <= nowMs : false;

  if (stage === PIPELINE_STAGES.NEW_LEAD) {
    return { nextAction: 'contact', needsAction: true, nextActionLabel: 'Contact lead', isStale: false };
  }
  if (stage === PIPELINE_STAGES.CONTACTED) {
    return {
      nextAction: 'qualify',
      needsAction: !nextFollowUpAt || followUpDue,
      nextActionLabel: 'Qualify lead',
      isStale: !nextFollowUpAt || followUpDue,
    };
  }
  if (stage === PIPELINE_STAGES.QUALIFIED || stage === PIPELINE_STAGES.ESTIMATE_NEEDED) {
    return { nextAction: 'create_estimate', needsAction: true, nextActionLabel: 'Create estimate', isStale: false };
  }
  if (stage === PIPELINE_STAGES.ESTIMATE_DRAFT) {
    return { nextAction: 'send_estimate', needsAction: true, nextActionLabel: 'Send estimate', isStale: false };
  }
  if (stage === PIPELINE_STAGES.ESTIMATE_SENT) {
    const sentAt = asDate(firstPresent(estimate?.sentAt, estimate?.sent_at, estimate?.updatedAt, estimate?.updated_at));
    const stale = sentAt ? nowMs - sentAt.getTime() >= SENT_STALE_MS : false;
    return {
      nextAction: stale || followUpDue ? 'follow_up' : 'wait',
      needsAction: stale || followUpDue,
      nextActionLabel: stale || followUpDue ? 'Follow up' : 'Waiting',
      isStale: stale,
    };
  }
  if (stage === PIPELINE_STAGES.ESTIMATE_VIEWED) {
    const viewedAt = asDate(firstPresent(estimate?.viewedAt, estimate?.viewed_at, estimate?.lastViewedAt, estimate?.last_viewed_at));
    const stale = viewedAt ? nowMs - viewedAt.getTime() >= VIEWED_STALE_MS : true;
    return {
      nextAction: 'follow_up',
      needsAction: stale || followUpDue,
      nextActionLabel: 'Follow up',
      isStale: stale,
    };
  }
  if (stage === PIPELINE_STAGES.WON) {
    return { nextAction: 'schedule', needsAction: false, nextActionLabel: 'Schedule service', isStale: false };
  }
  if (stage === PIPELINE_STAGES.LOST) {
    return { nextAction: 'none', needsAction: false, nextActionLabel: 'None', isStale: false };
  }
  return { nextAction: 'none', needsAction: false, nextActionLabel: 'None', isStale: false };
}

function possibleDuplicateRisk({ lead, estimate }) {
  if (!lead || !estimate) return false;
  const leadPhone = normalizePhoneDigits(lead.phone || lead.phoneNumber);
  const estimatePhone = normalizePhoneDigits(estimate.phone || estimate.customerPhone || estimate.customer_phone);
  if (leadPhone && estimatePhone && leadPhone === estimatePhone) return true;
  const leadEmail = String(lead.email || '').trim().toLowerCase();
  const estimateEmail = String(estimate.email || estimate.customerEmail || estimate.customer_email || '').trim().toLowerCase();
  return !!leadEmail && !!estimateEmail && leadEmail === estimateEmail;
}

function duplicateDismissalKey(estimateId, leadId) {
  return `${String(estimateId)}:${String(leadId)}`;
}

function buildOpportunity({ lead = null, estimate = null, now = new Date() }) {
  const leadId = firstPresent(lead?.id, lead?.leadId, lead?.lead_id);
  const estimateId = firstPresent(estimate?.id, estimate?.estimateId, estimate?.estimate_id);
  const customerId = firstPresent(lead?.customerId, lead?.customer_id, estimate?.customerId, estimate?.customer_id);
  const name = firstPresent(
    lead?.name,
    lead?.customerName,
    lead?.customer_name,
    [lead?.first_name, lead?.last_name].filter(Boolean).join(' ').trim(),
    [lead?.firstName, lead?.lastName].filter(Boolean).join(' ').trim(),
    estimate?.customerName,
    estimate?.customer_name,
    estimate?.name,
    'Unknown Customer',
  );
  const phone = firstPresent(lead?.phone, lead?.phoneNumber, estimate?.phone, estimate?.customerPhone, estimate?.customer_phone);
  const email = firstPresent(lead?.email, estimate?.email, estimate?.customerEmail, estimate?.customer_email);
  const address = firstPresent(lead?.address, estimate?.address, estimate?.serviceAddress, estimate?.service_address);
  const serviceInterest = firstPresent(
    estimate?.serviceName,
    estimate?.service_name,
    estimate?.serviceType,
    estimate?.service_type,
    estimate?.serviceInterest,
    estimate?.service_interest,
    lead?.serviceInterest,
    lead?.service_interest,
    lead?.service,
  );
  const source = firstPresent(lead?.source_name, lead?.sourceName, lead?.source, lead?.leadSource, lead?.lead_source, estimate?.leadSource, estimate?.lead_source, estimate?.source, 'Unknown');
  const campaign = firstPresent(lead?.campaign, lead?.campaignName, lead?.campaign_name, estimate?.campaign, estimate?.campaignName);
  const owner = firstPresent(lead?.assigned_name, lead?.assignedName, lead?.owner, estimate?.createdBy, estimate?.created_by_name);
  const stageInfo = deriveOpportunityStage({ lead, estimate, now });
  const nextInfo = deriveNextAction({ lead, estimate, stage: stageInfo.stage, now });
  const estimateValue = estimateValueCents(estimate);
  const leadValue = leadValueCents(lead);
  const valueCents = estimateValue.valueCents ?? leadValue.valueCents;
  const valueConfidence = estimateValue.valueCents !== null ? estimateValue.valueConfidence : leadValue.valueConfidence;
  const lastActivity = latestDate(
    estimate?.lastViewedAt,
    estimate?.last_viewed_at,
    estimate?.viewedAt,
    estimate?.viewed_at,
    estimate?.sentAt,
    estimate?.sent_at,
    estimate?.updatedAt,
    estimate?.updated_at,
    lead?.lastActivityAt,
    lead?.last_activity_at,
    lead?.updatedAt,
    lead?.updated_at,
    lead?.createdAt,
    lead?.created_at,
    estimate?.createdAt,
    estimate?.created_at,
  );
  const createdAt = toIso(firstPresent(lead?.createdAt, lead?.created_at, estimate?.createdAt, estimate?.created_at));
  const nextFollowUpAt = toIso(firstPresent(
    lead?.nextFollowUpAt,
    lead?.next_follow_up_at,
    estimate?.nextFollowUpAt,
    estimate?.next_follow_up_at,
    lead?.callbackAt,
    lead?.callback_at,
  ));

  return {
    opportunityId: leadId ? `lead:${leadId}` : `estimate:${estimateId}`,
    sourceType: lead && estimate ? 'lead_estimate' : lead ? 'lead' : 'estimate',
    leadId: leadId || null,
    estimateId: estimateId || null,
    customerId: customerId || null,
    name,
    phone: phone || null,
    email: email || null,
    address: address || null,
    serviceInterest: serviceInterest || null,
    source,
    campaign: campaign || null,
    owner: owner || null,
    stage: stageInfo.stage,
    status: stageInfo.status,
    value: valueCents === null ? null : valueCents / 100,
    valueCents,
    valueConfidence,
    lastActivityAt: lastActivity ? lastActivity.toISOString() : null,
    createdAt,
    nextFollowUpAt,
    nextAction: nextInfo.nextAction,
    nextActionLabel: nextInfo.nextActionLabel,
    urgency: firstPresent(lead?.urgency, estimate?.urgency),
    needsAction: nextInfo.needsAction,
    isStale: nextInfo.isStale,
    isDuplicateRisk: false,
    stageReason: stageInfo.stageReason,
    rawLead: lead,
    rawEstimate: estimate,
  };
}

function normalizeOpportunities({
  leads = [],
  estimates = [],
  now = new Date(),
  dismissedDuplicatePairs = [],
}) {
  const leadList = Array.isArray(leads) ? leads : [];
  const estimateList = Array.isArray(estimates) ? estimates : [];
  const dismissedPairKeys = new Set((dismissedDuplicatePairs || []).map((pair) => {
    if (typeof pair === 'string') return pair;
    return duplicateDismissalKey(pair.estimateId ?? pair.estimate_id, pair.leadId ?? pair.lead_id);
  }));
  const opportunitiesByKey = new Map();

  for (const lead of leadList) {
    const leadId = firstPresent(lead?.id, lead?.leadId, lead?.lead_id);
    if (!leadId) continue;
    opportunitiesByKey.set(`lead:${leadId}`, buildOpportunity({ lead, estimate: null, now }));
  }

  for (const estimate of estimateList) {
    const estimateId = firstPresent(estimate?.id, estimate?.estimateId, estimate?.estimate_id);
    if (!estimateId) continue;
    const linkedLeadId = firstPresent(estimate?.lead_id, estimate?.leadId);
    if (linkedLeadId && opportunitiesByKey.has(`lead:${linkedLeadId}`)) {
      const key = `lead:${linkedLeadId}`;
      const existing = opportunitiesByKey.get(key);
      opportunitiesByKey.set(key, buildOpportunity({ lead: existing.rawLead, estimate, now }));
      continue;
    }

    const linkedLead = leadList.find((lead) => {
      const leadEstimateId = firstPresent(lead?.estimate_id, lead?.estimateId);
      return leadEstimateId && String(leadEstimateId) === String(estimateId);
    });
    if (linkedLead) {
      const key = `lead:${firstPresent(linkedLead.id, linkedLead.leadId, linkedLead.lead_id)}`;
      const existing = opportunitiesByKey.get(key);
      opportunitiesByKey.set(key, buildOpportunity({ lead: existing?.rawLead || linkedLead, estimate, now }));
      continue;
    }

    const opportunity = buildOpportunity({ lead: null, estimate, now });
    opportunity.isDuplicateRisk = leadList.some((lead) => {
      const leadId = firstPresent(lead?.id, lead?.leadId, lead?.lead_id);
      return possibleDuplicateRisk({ lead, estimate })
        && !dismissedPairKeys.has(duplicateDismissalKey(estimateId, leadId));
    });
    opportunitiesByKey.set(`estimate:${estimateId}`, opportunity);
  }

  return Array.from(opportunitiesByKey.values());
}

function buildOpportunitySearchText(opportunity) {
  const phoneDigits = normalizePhoneDigits(opportunity.phone);
  return [
    opportunity.opportunityId,
    opportunity.leadId,
    opportunity.estimateId ? `#${opportunity.estimateId}` : null,
    opportunity.estimateId,
    opportunity.name,
    opportunity.phone,
    phoneDigits,
    opportunity.email,
    opportunity.address,
    opportunity.source,
    opportunity.campaign,
    opportunity.serviceInterest,
    opportunity.stage,
    opportunity.status,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function opportunityMatchesFilter(opportunity, filter) {
  switch (filter) {
    case 'needs_action':
      return opportunity.needsAction === true;
    case 'new':
      return opportunity.stage === PIPELINE_STAGES.NEW_LEAD;
    case 'estimate_needed':
      return opportunity.stage === PIPELINE_STAGES.ESTIMATE_NEEDED || opportunity.stage === PIPELINE_STAGES.QUALIFIED;
    case 'draft':
      return opportunity.stage === PIPELINE_STAGES.ESTIMATE_DRAFT;
    case 'sent':
      return opportunity.stage === PIPELINE_STAGES.ESTIMATE_SENT;
    case 'viewed':
      return opportunity.stage === PIPELINE_STAGES.ESTIMATE_VIEWED;
    case 'follow_up':
      return opportunity.nextAction === 'follow_up' || (
        opportunity.needsAction === true
        && [PIPELINE_STAGES.ESTIMATE_SENT, PIPELINE_STAGES.ESTIMATE_VIEWED, PIPELINE_STAGES.CONTACTED].includes(opportunity.stage)
      );
    case 'duplicate_risk':
      return opportunity.isDuplicateRisk === true;
    case 'won':
      return opportunity.status === 'won';
    case 'lost':
      return opportunity.status === 'lost';
    case 'all':
    default:
      return true;
  }
}

function sortOpportunities(opportunities, sort = 'default') {
  return [...opportunities].sort((a, b) => {
    if (sort === 'next_follow_up') {
      const aDue = asDate(a.nextFollowUpAt)?.getTime() || Number.MAX_SAFE_INTEGER;
      const bDue = asDate(b.nextFollowUpAt)?.getTime() || Number.MAX_SAFE_INTEGER;
      if (aDue !== bDue) return aDue - bDue;
    }
    if (a.needsAction !== b.needsAction) return a.needsAction ? -1 : 1;
    const aLast = asDate(a.lastActivityAt)?.getTime() || 0;
    const bLast = asDate(b.lastActivityAt)?.getTime() || 0;
    if (aLast !== bLast) return bLast - aLast;
    const aCreated = asDate(a.createdAt)?.getTime() || 0;
    const bCreated = asDate(b.createdAt)?.getTime() || 0;
    return bCreated - aCreated;
  });
}

function filterOpportunities(opportunities, {
  search = '',
  stage = '',
  status = '',
  needsAction = '',
  source = '',
  ownerId = '',
  dateFrom = '',
  dateTo = '',
} = {}) {
  const q = String(search || '').trim().toLowerCase();
  const phoneQ = normalizePhoneDigits(q);
  const sourceTerm = String(source || '').trim().toLowerCase();
  const start = asDate(dateFrom);
  const end = asDate(dateTo);
  return opportunities.filter((opportunity) => {
    if (stage && stage !== 'all' && !opportunityMatchesFilter(opportunity, stage)) return false;
    if (status && opportunity.status !== status) return false;
    if (needsAction !== '' && String(opportunity.needsAction) !== String(needsAction === true || needsAction === 'true')) return false;
    if (sourceTerm && !String(opportunity.source || '').toLowerCase().includes(sourceTerm)) return false;
    if (ownerId) {
      const rawLeadOwner = opportunity.rawLead?.assigned_to;
      const rawEstimateOwner = opportunity.rawEstimate?.created_by_technician_id;
      if (String(rawLeadOwner || rawEstimateOwner || '') !== String(ownerId)) return false;
    }
    const lastActivity = asDate(opportunity.lastActivityAt);
    if (start && (!lastActivity || lastActivity < start)) return false;
    if (end && (!lastActivity || lastActivity > end)) return false;
    if (!q) return true;
    const haystack = buildOpportunitySearchText(opportunity);
    return haystack.includes(phoneQ.length >= 7 ? phoneQ : q);
  });
}

function countOpportunities(opportunities) {
  const counts = Object.fromEntries(FILTER_KEYS.map((key) => [key, 0]));
  for (const opportunity of opportunities) {
    for (const key of FILTER_KEYS) {
      if (opportunityMatchesFilter(opportunity, key)) counts[key] += 1;
    }
  }
  counts.total = opportunities.length;
  return counts;
}

function paginateOpportunities(opportunities, { page = 1, pageSize = 50 } = {}) {
  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  const safePageSize = Math.min(Math.max(parseInt(pageSize, 10) || 50, 1), 200);
  const total = opportunities.length;
  const offset = (safePage - 1) * safePageSize;
  return {
    data: opportunities.slice(offset, offset + safePageSize),
    pagination: {
      page: safePage,
      pageSize: safePageSize,
      total,
    },
  };
}

function buildPipelineResponse({
  leads = [],
  estimates = [],
  query = {},
  now = new Date(),
  truncated = false,
  candidateStats = {},
  dismissedDuplicatePairs = [],
}) {
  const normalized = normalizeOpportunities({
    leads,
    estimates,
    now,
    dismissedDuplicatePairs,
  });
  const countScope = filterOpportunities(normalized, { ...query, stage: '' });
  const filtered = filterOpportunities(countScope, query);
  const sorted = sortOpportunities(filtered, query.sort);
  const { data, pagination } = paginateOpportunities(sorted, query);
  return {
    data: data.map(({ rawLead, rawEstimate, ...opportunity }) => opportunity),
    counts: countOpportunities(countScope),
    pagination,
    meta: {
      source: 'server',
      truncated,
      candidateCap: candidateStats.candidateCap ?? null,
      leadCandidates: candidateStats.leadCandidates ?? null,
      estimateCandidates: candidateStats.estimateCandidates ?? null,
      leadCandidatesReturned: candidateStats.leadCandidatesReturned ?? null,
      estimateCandidatesReturned: candidateStats.estimateCandidatesReturned ?? null,
      generatedAt: asDate(now)?.toISOString() || new Date().toISOString(),
    },
  };
}

module.exports = {
  PIPELINE_STAGES,
  buildPipelineResponse,
  buildOpportunity,
  buildOpportunitySearchText,
  countOpportunities,
  deriveNextAction,
  deriveOpportunityStage,
  filterOpportunities,
  normalizeOpportunities,
  opportunityMatchesFilter,
  sortOpportunities,
};
