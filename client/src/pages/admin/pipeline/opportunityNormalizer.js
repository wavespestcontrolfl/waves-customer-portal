import { PIPELINE_STAGES } from "./pipelineStages";

const DAY_MS = 24 * 60 * 60 * 1000;
const SENT_STALE_MS = 2 * DAY_MS;
const VIEWED_STALE_MS = DAY_MS;

function firstPresent(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function normalizeStatus(status) {
  return String(status || "").trim().toLowerCase();
}

export function normalizePhoneDigits(value) {
  return String(value || "").replace(/\D/g, "");
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
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function estimateValueCents(estimate) {
  if (!estimate) return { valueCents: null, valueConfidence: "unknown" };
  const explicitCents = firstPresent(
    estimate.totalCents,
    estimate.total_cents,
    estimate.amountCents,
    estimate.amount_cents,
  );
  if (explicitCents !== null) {
    const n = Number(explicitCents);
    return Number.isFinite(n)
      ? { valueCents: Math.round(n), valueConfidence: "estimate_total" }
      : { valueCents: null, valueConfidence: "unknown" };
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
    valueConfidence: value === null ? "unknown" : "estimate_total",
  };
}

function leadValueCents(lead) {
  if (!lead) return { valueCents: null, valueConfidence: "unknown" };
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
    valueConfidence: value === null ? "unknown" : "lead_estimated_value",
  };
}

export function deriveOpportunityStage({ lead, estimate }) {
  const leadStatus = normalizeStatus(lead?.status);
  const estimateStatus = normalizeStatus(estimate?.status);

  if (estimateStatus === "accepted" || leadStatus === "won") {
    return {
      stage: PIPELINE_STAGES.WON,
      status: "won",
      stageReason: "Estimate accepted or lead marked won",
    };
  }

  if (
    estimateStatus === "declined" ||
    estimateStatus === "rejected" ||
    leadStatus === "lost" ||
    leadStatus === "disqualified"
  ) {
    return {
      stage: PIPELINE_STAGES.LOST,
      status: "lost",
      stageReason: "Estimate declined or lead marked lost/disqualified",
    };
  }

  if (estimate?.viewedAt || estimate?.viewed_at || estimateStatus === "viewed") {
    return {
      stage: PIPELINE_STAGES.ESTIMATE_VIEWED,
      status: "active",
      stageReason: "Estimate has been viewed",
    };
  }

  if (
    estimate?.sentAt ||
    estimate?.sent_at ||
    estimateStatus === "sent" ||
    estimateStatus === "scheduled" ||
    estimateStatus === "sending"
  ) {
    return {
      stage: PIPELINE_STAGES.ESTIMATE_SENT,
      status: "active",
      stageReason: "Estimate has been sent",
    };
  }

  if (estimate?.id) {
    return {
      stage: PIPELINE_STAGES.ESTIMATE_DRAFT,
      status: "active",
      stageReason: "Estimate exists but has not been sent",
    };
  }

  if (leadStatus === "qualified" || leadStatus === "estimate_needed") {
    return {
      stage: PIPELINE_STAGES.ESTIMATE_NEEDED,
      status: "active",
      stageReason: "Lead is qualified and has no estimate",
    };
  }

  if (leadStatus === "contacted") {
    return {
      stage: PIPELINE_STAGES.CONTACTED,
      status: "active",
      stageReason: "Lead has been contacted",
    };
  }

  if (leadStatus === "new" || lead?.id) {
    return {
      stage: PIPELINE_STAGES.NEW_LEAD,
      status: "active",
      stageReason: "New or uncontacted lead",
    };
  }

  return {
    stage: PIPELINE_STAGES.NEW_LEAD,
    status: "active",
    stageReason: "Fallback stage",
  };
}

export function deriveNextAction({ lead, estimate, stage, now = new Date() }) {
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
  // Mirrors server pipeline-opportunities.js: an expired estimate keeps its
  // sent/viewed STAGE but the action flips to Extend — the follow-up/resend
  // path refuses expired rows, so "Follow up" is a guaranteed 400. Detect the
  // swept 'expired' status AND a past expiry the sweep hasn't stamped yet.
  const estimateStatusForAction = normalizeStatus(estimate?.status);
  const estimateExpiresAt = asDate(firstPresent(estimate?.expiresAt, estimate?.expires_at));
  const estimateExpired = Boolean(estimate?.id)
    && !["accepted", "declined"].includes(estimateStatusForAction)
    && (estimateStatusForAction === "expired"
      || (estimateExpiresAt ? estimateExpiresAt.getTime() < nowMs : false));

  if (stage === PIPELINE_STAGES.NEW_LEAD) {
    return { nextAction: "contact", needsAction: true, nextActionLabel: "Contact lead", isStale: false };
  }
  if (stage === PIPELINE_STAGES.CONTACTED) {
    return {
      nextAction: "qualify",
      needsAction: !nextFollowUpAt || followUpDue,
      nextActionLabel: "Qualify lead",
      isStale: !nextFollowUpAt || followUpDue,
    };
  }
  if (stage === PIPELINE_STAGES.QUALIFIED || stage === PIPELINE_STAGES.ESTIMATE_NEEDED) {
    return { nextAction: "create_estimate", needsAction: true, nextActionLabel: "Create estimate", isStale: false };
  }
  if (stage === PIPELINE_STAGES.ESTIMATE_DRAFT) {
    // A swept-expired row with no sent/viewed stamp (e.g. an expired
    // scheduled send) derives as draft-stage, but /send rejects expired
    // estimates — Extend first.
    if (estimateExpired) {
      return { nextAction: "extend_estimate", needsAction: true, nextActionLabel: "Extend expiration", isStale: true };
    }
    return { nextAction: "send_estimate", needsAction: true, nextActionLabel: "Send estimate", isStale: false };
  }
  if (stage === PIPELINE_STAGES.ESTIMATE_SENT) {
    if (estimateExpired) {
      return { nextAction: "extend_estimate", needsAction: true, nextActionLabel: "Extend expiration", isStale: true };
    }
    const sentAt = asDate(firstPresent(estimate?.sentAt, estimate?.sent_at, estimate?.updatedAt, estimate?.updated_at));
    const stale = sentAt ? nowMs - sentAt.getTime() >= SENT_STALE_MS : false;
    return {
      nextAction: stale || followUpDue ? "follow_up" : "wait",
      needsAction: stale || followUpDue,
      nextActionLabel: stale || followUpDue ? "Follow up" : "Waiting",
      isStale: stale,
    };
  }
  if (stage === PIPELINE_STAGES.ESTIMATE_VIEWED) {
    if (estimateExpired) {
      return { nextAction: "extend_estimate", needsAction: true, nextActionLabel: "Extend expiration", isStale: true };
    }
    const viewedAt = asDate(firstPresent(estimate?.viewedAt, estimate?.viewed_at, estimate?.lastViewedAt, estimate?.last_viewed_at));
    const stale = viewedAt ? nowMs - viewedAt.getTime() >= VIEWED_STALE_MS : true;
    return {
      nextAction: "follow_up",
      needsAction: stale || followUpDue,
      nextActionLabel: "Follow up",
      isStale: stale,
    };
  }
  if (stage === PIPELINE_STAGES.WON) {
    return { nextAction: "schedule", needsAction: false, nextActionLabel: "Schedule service", isStale: false };
  }
  if (stage === PIPELINE_STAGES.LOST) {
    return { nextAction: "none", needsAction: false, nextActionLabel: "None", isStale: false };
  }
  return { nextAction: "none", needsAction: false, nextActionLabel: "None", isStale: false };
}

function possibleDuplicateRisk({ lead, estimate }) {
  if (!lead || !estimate) return false;
  const leadPhone = normalizePhoneDigits(lead.phone || lead.phoneNumber);
  const estimatePhone = normalizePhoneDigits(estimate.phone || estimate.customerPhone || estimate.customer_phone);
  if (leadPhone && estimatePhone && leadPhone === estimatePhone) return true;
  const leadEmail = String(lead.email || "").trim().toLowerCase();
  const estimateEmail = String(estimate.email || estimate.customerEmail || estimate.customer_email || "").trim().toLowerCase();
  return !!leadEmail && !!estimateEmail && leadEmail === estimateEmail;
}

export function buildOpportunity({ lead = null, estimate = null, now = new Date() }) {
  const leadId = firstPresent(lead?.id, lead?.leadId, lead?.lead_id);
  const estimateId = firstPresent(estimate?.id, estimate?.estimateId, estimate?.estimate_id);
  const customerId = firstPresent(lead?.customerId, lead?.customer_id, estimate?.customerId, estimate?.customer_id);
  const name = firstPresent(
    lead?.name,
    lead?.customerName,
    lead?.customer_name,
    [lead?.first_name, lead?.last_name].filter(Boolean).join(" ").trim(),
    [lead?.firstName, lead?.lastName].filter(Boolean).join(" ").trim(),
    estimate?.customerName,
    estimate?.customer_name,
    estimate?.name,
    "Unknown Customer",
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
  const source = firstPresent(lead?.source_name, lead?.sourceName, lead?.source, lead?.leadSource, lead?.lead_source, estimate?.leadSource, estimate?.lead_source, estimate?.source, "Unknown");
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
    sourceType: lead && estimate ? "lead_estimate" : lead ? "lead" : "estimate",
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

export function normalizeOpportunities({ leads = [], estimates = [], now = new Date() }) {
  const leadList = Array.isArray(leads) ? leads : [];
  const estimateList = Array.isArray(estimates) ? estimates : [];
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
    opportunity.isDuplicateRisk = leadList.some((lead) => possibleDuplicateRisk({ lead, estimate }));
    opportunitiesByKey.set(`estimate:${estimateId}`, opportunity);
  }

  return Array.from(opportunitiesByKey.values());
}

export function buildOpportunitySearchText(opportunity) {
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
    .join(" ")
    .toLowerCase();
}

export function opportunityMatchesFilter(opportunity, filter) {
  switch (filter) {
    case "needs_action":
      return opportunity.needsAction === true;
    case "new":
      return opportunity.stage === PIPELINE_STAGES.NEW_LEAD;
    case "estimate_needed":
      return opportunity.stage === PIPELINE_STAGES.ESTIMATE_NEEDED || opportunity.stage === PIPELINE_STAGES.QUALIFIED;
    case "draft":
      return opportunity.stage === PIPELINE_STAGES.ESTIMATE_DRAFT;
    case "sent":
      return opportunity.stage === PIPELINE_STAGES.ESTIMATE_SENT;
    case "viewed":
      return opportunity.stage === PIPELINE_STAGES.ESTIMATE_VIEWED;
    case "follow_up":
      return opportunity.nextAction === "follow_up" || (
        opportunity.needsAction === true &&
        // Extend-only rows (expired estimates) need action, but Follow Up is
        // exactly the action the server refuses for them — keep them out of
        // the Follow Up queue/count.
        opportunity.nextAction !== "extend_estimate" &&
        [PIPELINE_STAGES.ESTIMATE_SENT, PIPELINE_STAGES.ESTIMATE_VIEWED, PIPELINE_STAGES.CONTACTED].includes(opportunity.stage)
      );
    case "duplicate_risk":
      return opportunity.isDuplicateRisk === true;
    case "won":
      return opportunity.status === "won";
    case "lost":
      return opportunity.status === "lost";
    case "all":
    default:
      return true;
  }
}

export function sortOpportunities(opportunities) {
  return [...opportunities].sort((a, b) => {
    if (a.needsAction !== b.needsAction) return a.needsAction ? -1 : 1;
    const aLast = asDate(a.lastActivityAt)?.getTime() || 0;
    const bLast = asDate(b.lastActivityAt)?.getTime() || 0;
    if (aLast !== bLast) return bLast - aLast;
    const aCreated = asDate(a.createdAt)?.getTime() || 0;
    const bCreated = asDate(b.createdAt)?.getTime() || 0;
    return bCreated - aCreated;
  });
}
