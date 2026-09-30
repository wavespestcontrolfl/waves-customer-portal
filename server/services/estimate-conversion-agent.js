const db = require('../models/db');
const logger = require('./logger');
const { excludeUnresolvedSendReservations } = require('./messaging/review-ask-reservation');
const { gateEnvValue } = require('../config/feature-gates');

const WORKFLOW = 'estimate_conversion_sms';
const SERVICE_SCHEDULING_WORKFLOW = 'service_scheduling_sms';
const CUSTOMER_SMS_TRIAGE_WORKFLOW = 'customer_sms_triage';
const AGENT_NAME = 'waves-estimate-conversion-shadow';
const SERVICE_SCHEDULING_AGENT_NAME = 'waves-service-scheduling-shadow';
const CUSTOMER_SMS_TRIAGE_AGENT_NAME = 'waves-customer-sms-triage-shadow';
const DECISION_VERSION = '2026-06-01.1';

const OPEN_ESTIMATE_STATUSES = ['draft', 'scheduled', 'sending', 'sent', 'viewed', 'send_failed'];
const OPEN_LEAD_STATUSES = ['new', 'contacted', 'estimate_sent', 'estimate_viewed', 'follow_up'];

const ACCEPTANCE_RE = /\b(give (you|your team) a try|want to start|ready to start|let'?s (do it|move forward|get started)|go ahead|sign me up|i'?ll move forward|i think i will|start (the )?service|move forward with)\b/i;
const SCHEDULE_WINDOW_RE = /\b(week of|next week|couple weeks?|any time|start (on|the week of|that week|next week|for|service)|january|february|march|april|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const HOME_QUESTION_RE = /\b(do i need to be home|need to be home|have to be home|do we need to be there|access to the exterior)\b/i;
const SERVICE_QUESTION_RE = /\b(typical visit|outline of the service|what'?s included|does it include|sweep|sweeping|webs?|lanai|cage|front door|entry points?|shrubs?)\b/i;
const GENERAL_ESTIMATE_QUESTION_RE = /\b(how much|fees?|price|pricing|cost|bundle|bundled|add that|add .*later|come inside|inside|safe for pets?|new estimate|proceed with (a )?service)\b|\?/i;
const SERVICE_SCHEDULING_PROMPT_RE = /\b(availability|available|what availability|what works|what time|what day|can y'?all do|can you do|does .* work|appointment|schedule|reschedule|adjust around your schedule|route)\b/i;
const TIME_AVAILABILITY_RE = /\b([1-9]|1[0-2])(?::[0-5]\d)?\s?(a\.?m\.?|p\.?m\.?)?\b|\b(morning|afternoon|evening|midday|noon|early|late)\b/i;
const WEATHER_RE = /\b(rain|raining|storm|weather|wash(ed)? out|radar|lightning|thunder)\b/i;
const RESCHEDULE_RE = /\b(reschedule|move|push|change|adjust)\b/i;
const TIME_TOKEN_RE = /\b([1-9]|1[0-2])(?::[0-5]\d)?\s?(a\.?m\.?|p\.?m\.?)\b|\b(morning|afternoon|evening|midday|noon)\b/ig;
const DAY_TOKEN_RE = /\b(today|tomorrow|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/ig;
const COURTESY_ONLY_RE = /^(thanks?|thank you|ty|ok(?:ay)?|sounds good|great|perfect|got it|yes|no|yep|nope|cool)[\s!.]*$/i;
const CUSTOMER_NUDGE_RE = /\b(hey|hello|hi|checking in|follow(?:ing)? up|any thoughts|when you would|when can|where are we|update)\b/i;
const BILLING_RE = /\b(invoice|payment|paid|pay|card|zelle|venmo|receipt|charge|autopay|auto-pay|refund)\b/i;
const COMPLAINT_RE = /\b(problem|issue|not working|still seeing|came back|upset|frustrated|disappointed|missed|no show|never showed|late|cancel)\b/i;
const PHOTO_RE = /\b(photo|picture|image|pic|photos|pictures|attached|screenshot)\b/i;

function normalizePhoneLast10(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

function extractShortCode(text) {
  const match = String(text || '').match(/\/l\/([a-zA-Z0-9_-]{3,80})\b/);
  return match ? match[1] : null;
}

function firstNameFrom(value) {
  return String(value || '').trim().split(/\s+/)[0] || 'there';
}

function confidenceLabel(score) {
  if (score >= 0.85) return 'high';
  if (score >= 0.6) return 'medium';
  return 'low';
}

function classifyEstimateSmsIntent(body, context = {}) {
  const text = String(body || '').trim();
  if (!text) {
    return {
      intent: null,
      confidence: 0,
      recommendedActions: [],
      autoActionsAllowed: [],
      blockedActions: [],
      safetyFlags: [],
      suggestedMessage: null,
      reasoningSummary: 'Empty SMS body; no decision.',
    };
  }

  const hasEstimate = !!context.estimate;
  const accepted = ACCEPTANCE_RE.test(text);
  const scheduleWindow = SCHEDULE_WINDOW_RE.test(text);
  const homeQuestion = HOME_QUESTION_RE.test(text);
  const serviceQuestion = SERVICE_QUESTION_RE.test(text);
  const generalEstimateQuestion = hasEstimate && GENERAL_ESTIMATE_QUESTION_RE.test(text);

  if (!accepted && !scheduleWindow && !homeQuestion && !serviceQuestion && !generalEstimateQuestion) {
    return {
      intent: null,
      confidence: 0,
      recommendedActions: [],
      autoActionsAllowed: [],
      blockedActions: [],
      safetyFlags: [],
      suggestedMessage: null,
      reasoningSummary: 'No estimate-conversion signal detected.',
    };
  }

  const recommendedActions = [];
  const autoActionsAllowed = [];
  const blockedActions = [];
  const safetyFlags = ['billing_invoice_only', 'never_create_subscription', 'never_charge_card'];

  let intent = 'estimate_question';
  let score = hasEstimate ? 0.62 : 0.48;

  if (accepted) {
    intent = 'accepted_estimate_by_text';
    score = hasEstimate ? 0.93 : 0.78;
    recommendedActions.push(
      'mark_conversion_intent',
      'mark_estimate_accepted_after_review',
      'link_lead_to_estimate',
      'propagate_waveguard_tier',
      'set_next_follow_up'
    );
    autoActionsAllowed.push('mark_conversion_intent', 'link_lead_to_estimate', 'set_next_follow_up');
  }

  if (serviceQuestion) {
    recommendedActions.push('answer_service_scope_question');
    autoActionsAllowed.push('draft_service_scope_reply');
  }

  if (generalEstimateQuestion && !serviceQuestion && !homeQuestion) {
    recommendedActions.push('draft_estimate_question_reply');
    autoActionsAllowed.push('draft_estimate_question_reply');
  }

  if (homeQuestion) {
    recommendedActions.push('answer_home_access_question');
    autoActionsAllowed.push('draft_home_access_reply');
  }

  if (scheduleWindow) {
    recommendedActions.push('offer_calendar_slots_for_requested_window');
    blockedActions.push('silently_schedule_without_confirmed_slot');
    safetyFlags.push('scheduling_requires_explicit_slot');
    if (!accepted && intent === 'estimate_question') {
      intent = 'scheduling_window_question';
      score = Math.max(score, hasEstimate ? 0.72 : 0.58);
    }
  }

  blockedActions.push('create_subscription', 'charge_card');

  const firstName = firstNameFrom(context.customer?.first_name || context.estimate?.customer_name);
  let suggestedMessage = null;
  if (homeQuestion && scheduleWindow) {
    suggestedMessage = `Hello ${firstName}! You do not need to be home for the first visit as long as we have access to the exterior areas. I can look at openings for that week and send you the best available options.`;
  } else if (homeQuestion) {
    suggestedMessage = `Hello ${firstName}! You do not need to be home for most exterior quarterly visits as long as we have access to the outside areas. We document the service and send the report after completion.`;
  } else if (serviceQuestion) {
    suggestedMessage = `Hello ${firstName}! A typical quarterly visit includes exterior sweep-downs, foundation and entry-point treatment, and treatment around bedding areas and shrubs where needed. The service report documents what was completed.`;
  } else if (accepted && scheduleWindow) {
    suggestedMessage = `Hello ${firstName}! Sounds good. I can look at openings for that week and send you the best available options before we lock in the first visit.`;
  } else if (accepted) {
    suggestedMessage = `Hello ${firstName}! Sounds good. I can help get the estimate marked accepted and confirm the next scheduling step.`;
  }

  return {
    intent,
    confidence: score,
    recommendedActions: [...new Set(recommendedActions)],
    autoActionsAllowed: [...new Set(autoActionsAllowed)],
    blockedActions: [...new Set(blockedActions)],
    safetyFlags: [...new Set(safetyFlags)],
    suggestedMessage,
    reasoningSummary: buildReasoningSummary({ accepted, scheduleWindow, homeQuestion, serviceQuestion, generalEstimateQuestion, hasEstimate }),
  };
}

function classifyServiceSchedulingSmsIntent(body, context = {}) {
  const text = String(body || '').trim();
  if (!text) {
    return {
      intent: null,
      confidence: 0,
      recommendedActions: [],
      autoActionsAllowed: [],
      blockedActions: [],
      safetyFlags: [],
      suggestedMessage: null,
      reasoningSummary: 'Empty SMS body; no service scheduling decision.',
    };
  }

  const hasCustomer = !!context.customer;
  const hasEstimate = !!context.estimate;
  const accepted = ACCEPTANCE_RE.test(text);
  const scheduleWindow = SCHEDULE_WINDOW_RE.test(text);
  const activeSchedulingThread = hasActiveServiceSchedulingThread(context.recentSmsThread);
  const availabilityReply = scheduleWindow || (activeSchedulingThread && TIME_AVAILABILITY_RE.test(text));
  const weatherMention = WEATHER_RE.test(text);
  const rainReschedule = weatherMention && (RESCHEDULE_RE.test(text) || activeSchedulingThread);
  if (!hasCustomer || !(availabilityReply || rainReschedule) || accepted || (hasEstimate && !activeSchedulingThread)) {
    return {
      intent: null,
      confidence: 0,
      recommendedActions: [],
      autoActionsAllowed: [],
      blockedActions: [],
      safetyFlags: [],
      suggestedMessage: null,
      reasoningSummary: 'No active customer service-scheduling signal detected.',
    };
  }

  const scenarioLabel = classifyServiceSchedulingScenario(text, { activeSchedulingThread, rainReschedule });
  return {
    intent: rainReschedule ? 'service_reschedule_weather_question' : 'service_scheduling_window_reply',
    confidence: rainReschedule ? 0.82 : 0.86,
    recommendedActions: [
      'draft_service_scheduling_reply',
      'check_route_availability',
      'confirm_service_window_after_review',
    ],
    autoActionsAllowed: ['draft_service_scheduling_reply'],
    blockedActions: [
      'silently_schedule_without_confirmed_slot',
      'create_subscription',
      'charge_card',
    ],
    safetyFlags: [
      'existing_customer_service_thread',
      'scheduling_requires_explicit_slot',
      'never_create_subscription',
      'never_charge_card',
    ],
    // No template draft for this lane. The old fill-in template split the
    // customer's text at commas and "or" and pasted the pieces back as "the
    // windows you offered" (a re-service request came back quoting the
    // customer's own words about roaches and glue traps). The grounded LLM
    // draft in processInboundSms is the only draft; when it is unavailable
    // this row carries no draft and a person writes the reply (/agent-draft
    // may still show an older pending card on the thread, which the send
    // check refuses as superseded).
    suggestedMessage: null,
    reasoningSummary: activeSchedulingThread
      ? 'existing customer text answers a recent service scheduling prompt; route as service scheduling, not estimate conversion.'
      : 'existing customer text references service availability or a scheduling window; route as service scheduling, not estimate conversion.',
    metadata: {
      scenarioLabel,
    },
  };
}

function classifyCustomerSmsTriageIntent(body, context = {}) {
  const text = String(body || '').trim();
  if (!text) {
    return {
      intent: null,
      confidence: 0,
      recommendedActions: [],
      autoActionsAllowed: [],
      blockedActions: [],
      safetyFlags: [],
      suggestedMessage: null,
      reasoningSummary: 'Empty SMS body; no customer SMS triage decision.',
    };
  }

  const hasKnownContext = !!context.customer || !!context.estimate || !!context.lead;
  const firstName = firstNameFrom(
    context.customer?.first_name
      || context.estimate?.customer_name
      || context.lead?.first_name
  );
  const blockedActions = ['send_without_human_review', 'create_subscription', 'charge_card'];
  const safetyFlags = ['human_review_required', 'never_create_subscription', 'never_charge_card'];

  if (!hasKnownContext) {
    return {
      intent: 'needs_customer_lookup',
      confidence: 0.52,
      recommendedActions: ['identify_sender_before_replying'],
      autoActionsAllowed: [],
      blockedActions,
      safetyFlags: [...safetyFlags, 'needs_customer_lookup'],
      suggestedMessage: null,
      reasoningSummary: 'inbound SMS did not match a specialized workflow and no customer, lead, or estimate context was found.',
      metadata: { scenarioLabel: 'unknown_sender' },
    };
  }

  if (COURTESY_ONLY_RE.test(text)) {
    return {
      intent: 'no_reply_needed',
      confidence: 0.84,
      recommendedActions: ['mark_no_reply_needed'],
      autoActionsAllowed: [],
      blockedActions,
      safetyFlags: [...safetyFlags, 'no_reply_needed'],
      suggestedMessage: null,
      reasoningSummary: 'inbound SMS appears to be a short courtesy acknowledgement; likely no reply needed.',
      metadata: { scenarioLabel: 'no_reply_needed', noReplyNeeded: true },
    };
  }

  const recommendedActions = [];
  const autoActionsAllowed = [];
  let intent = 'general_customer_sms_needs_review';
  let confidence = 0.62;
  let suggestedMessage = null;
  let scenarioLabel = 'general_customer_reply';
  const extraSafetyFlags = [];

  if (BILLING_RE.test(text)) {
    intent = 'billing_question_needs_review';
    confidence = 0.72;
    recommendedActions.push('review_billing_context', 'draft_billing_reply_after_review');
    autoActionsAllowed.push('draft_billing_reply_after_review');
    extraSafetyFlags.push('billing_invoice_only');
    scenarioLabel = 'billing_question';
    suggestedMessage = `Hello ${firstName}! I can take a look at the billing details and follow up with the right answer.`;
  } else if (COMPLAINT_RE.test(text)) {
    intent = 'customer_issue_needs_review';
    confidence = 0.74;
    recommendedActions.push('review_customer_issue', 'draft_customer_issue_reply');
    autoActionsAllowed.push('draft_customer_issue_reply');
    extraSafetyFlags.push('customer_issue');
    scenarioLabel = 'customer_issue';
    suggestedMessage = `Hello ${firstName}! I am sorry about that. Let me look into it and I will follow up with the best next step.`;
  } else if (PHOTO_RE.test(text)) {
    intent = 'photo_or_attachment_needs_review';
    confidence = 0.68;
    recommendedActions.push('review_photo_or_attachment', 'draft_photo_acknowledgement');
    autoActionsAllowed.push('draft_photo_acknowledgement');
    scenarioLabel = 'photo_received';
    suggestedMessage = `Hello ${firstName}! Thanks for sending that over. I will take a look and follow up with the best next step.`;
  } else if (CUSTOMER_NUDGE_RE.test(text) || /\?$/.test(text)) {
    intent = 'customer_nudge_needs_reply';
    confidence = 0.7;
    recommendedActions.push('review_thread_context', 'draft_customer_reply');
    autoActionsAllowed.push('draft_customer_reply');
    scenarioLabel = 'customer_nudge';
    suggestedMessage = `Hello ${firstName}! I see your message. Let me check on this and I will follow up with you shortly.`;
  } else {
    recommendedActions.push('review_thread_context', 'decide_if_reply_needed');
  }

  return {
    intent,
    confidence,
    recommendedActions: [...new Set(recommendedActions)],
    autoActionsAllowed: [...new Set(autoActionsAllowed)],
    blockedActions,
    safetyFlags: [...new Set([...safetyFlags, ...extraSafetyFlags])],
    suggestedMessage,
    reasoningSummary: 'inbound SMS did not match estimate conversion or service scheduling; queued for general customer SMS triage.',
    metadata: { scenarioLabel },
  };
}

function classifyServiceSchedulingScenario(text, { activeSchedulingThread = false, rainReschedule = false } = {}) {
  if (rainReschedule) return 'rain_reschedule';
  const dayMatches = Array.from(String(text || '').matchAll(DAY_TOKEN_RE));
  const timeMatches = Array.from(String(text || '').matchAll(TIME_TOKEN_RE));
  if (dayMatches.length > 1 || (dayMatches.length >= 1 && timeMatches.length > 1)) return 'scheduling_multi_window';
  if (activeSchedulingThread && timeMatches.length && !dayMatches.length) return 'scheduling_time_only';
  return 'scheduling_general';
}

function hasActiveServiceSchedulingThread(thread = []) {
  const rows = Array.isArray(thread) ? thread : [];
  return rows.some((row) => (
    row?.direction === 'outbound'
    && SERVICE_SCHEDULING_PROMPT_RE.test(String(row.body || row.message_body || ''))
  ));
}

function routeEstimateOrCustomerReply(body, context = {}) {
  const serviceScheduling = classifyServiceSchedulingSmsIntent(body, context);
  if (serviceScheduling.intent) {
    return {
      workflow: SERVICE_SCHEDULING_WORKFLOW,
      agentName: SERVICE_SCHEDULING_AGENT_NAME,
      decision: serviceScheduling,
    };
  }

  const estimateConversion = classifyEstimateSmsIntent(body, context);
  if (estimateConversion.intent) {
    return {
      workflow: WORKFLOW,
      agentName: AGENT_NAME,
      decision: estimateConversion,
    };
  }

  return {
    workflow: CUSTOMER_SMS_TRIAGE_WORKFLOW,
    agentName: CUSTOMER_SMS_TRIAGE_AGENT_NAME,
    decision: classifyCustomerSmsTriageIntent(body, context),
  };
}

function buildReasoningSummary({ accepted, scheduleWindow, homeQuestion, serviceQuestion, generalEstimateQuestion, hasEstimate }) {
  const parts = [];
  if (accepted) parts.push('customer text contains a verbal acceptance signal');
  if (scheduleWindow) parts.push('customer references timing or a scheduling window');
  if (homeQuestion) parts.push('customer asks whether they need to be home');
  if (serviceQuestion) parts.push('customer asks about service scope');
  if (generalEstimateQuestion && !serviceQuestion && !homeQuestion) parts.push('customer asks a general estimate question');
  parts.push(hasEstimate ? 'an open estimate context was found' : 'no open estimate context was found');
  return parts.join('; ') + '.';
}

async function resolveEstimateContext({ customer, phone, body }) {
  const shortCode = extractShortCode(body);
  if (shortCode) {
    const short = await db('short_codes')
      .whereRaw('LOWER(code) = ?', [shortCode.toLowerCase()])
      .where({ kind: 'estimate' })
      .first();
    if (short?.entity_id) {
      // An old short link can point at a closed courtship (accepted /
      // declined / expired, or archived-by-sweep with its status still
      // sent/viewed). Only an OPEN un-archived estimate may anchor the
      // conversion agent — otherwise fall through to the customer/phone
      // lookups below.
      const estimate = await db('estimates')
        .where({ id: short.entity_id })
        .whereIn('status', OPEN_ESTIMATE_STATUSES)
        .whereNull('archived_at')
        .first();
      if (estimate) return { estimate, shortCode };
    }
  }

  if (customer?.id) {
    // whereNull(archived_at): archived rows keep sent/viewed status but the
    // courtship already closed — never resolve one as "the open estimate".
    const estimate = await db('estimates')
      .where({ customer_id: customer.id })
      .whereIn('status', OPEN_ESTIMATE_STATUSES)
      .whereNull('archived_at')
      .orderByRaw('COALESCE(last_viewed_at, viewed_at, sent_at, updated_at, created_at) DESC')
      .first();
    if (estimate) return { estimate, shortCode: null };
  }

  const last10 = normalizePhoneLast10(phone);
  if (last10) {
    const estimate = await db('estimates')
      .whereIn('status', OPEN_ESTIMATE_STATUSES)
      .whereNull('archived_at')
      .whereRaw("RIGHT(REGEXP_REPLACE(COALESCE(customer_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [last10])
      .orderByRaw('COALESCE(last_viewed_at, viewed_at, sent_at, updated_at, created_at) DESC')
      .first();
    if (estimate) return { estimate, shortCode: null };
  }

  return { estimate: null, shortCode: shortCode || null };
}

async function resolveLeadContext({ customer, phone, estimate }) {
  if (estimate?.id) {
    const lead = await db('leads').where({ estimate_id: estimate.id }).whereNull('deleted_at').orderBy('created_at', 'desc').first();
    if (lead) return lead;
  }

  if (customer?.id) {
    const lead = await db('leads')
      .where({ customer_id: customer.id })
      .whereNull('deleted_at')
      .whereIn('status', OPEN_LEAD_STATUSES)
      .orderBy('created_at', 'desc')
      .first();
    if (lead) return lead;
  }

  const last10 = normalizePhoneLast10(phone);
  if (last10) {
    return db('leads')
      .whereNull('deleted_at')
      .whereIn('status', OPEN_LEAD_STATUSES)
      .whereRaw("RIGHT(REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [last10])
      .orderBy('created_at', 'desc')
      .first();
  }

  return null;
}

async function resolveRecentSmsThread({ customer, phone, smsLogId }) {
  const last10 = normalizePhoneLast10(phone);
  if (!customer?.id && !last10) return [];

  let currentCreatedAt = null;
  if (smsLogId) {
    const current = await db('sms_log').where({ id: smsLogId }).select('created_at').first();
    currentCreatedAt = current?.created_at || null;
  }

  // codex #4331 P2 (structural pass): an unresolved review-ask reservation
  // must not read as a delivered message in this composer-facing thread.
  const q = excludeUnresolvedSendReservations(db('sms_log'))
    .select('id', 'direction', 'message_body', 'message_type', 'admin_user_id', 'created_at')
    // Recruiting threads (job_*) are owner-only and never customer context —
    // an applicant sharing this phone must not feed interview links or
    // replies into estimate routing (codex #4623 r15).
    .whereRaw("COALESCE(message_type, '') NOT LIKE 'job\\_%'")
    .orderBy('created_at', 'desc')
    .limit(8);

  q.where(function filterIdentity() {
    if (customer?.id) this.where('customer_id', customer.id);
    if (last10) {
      this.orWhereRaw("RIGHT(REGEXP_REPLACE(COALESCE(from_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [last10])
        .orWhereRaw("RIGHT(REGEXP_REPLACE(COALESCE(to_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [last10]);
    }
  });
  if (currentCreatedAt) q.where('created_at', '<=', currentCreatedAt);

  const rows = await q;
  return rows.reverse().map((row) => ({
    id: row.id,
    direction: row.direction,
    body: row.message_body,
    type: row.message_type,
    adminUserId: row.admin_user_id || null,
    createdAt: row.created_at,
    isTrigger: smsLogId ? row.id === smsLogId : false,
  }));
}

function buildInputSnapshot({ body, customer, estimate, lead, from, to, shortCode }) {
  return {
    sms: {
      body,
      from_last4: String(from || '').replace(/\D/g, '').slice(-4) || null,
      to_last4: String(to || '').replace(/\D/g, '').slice(-4) || null,
      short_code: shortCode || null,
    },
    customer: customer ? {
      id: customer.id,
      name: [customer.first_name, customer.last_name].filter(Boolean).join(' ') || null,
      city: customer.city || null,
      waveguard_tier: customer.waveguard_tier || null,
    } : null,
    estimate: estimate ? {
      id: estimate.id,
      status: estimate.status,
      customer_name: estimate.customer_name,
      waveguard_tier: estimate.waveguard_tier,
      monthly_total: estimate.monthly_total,
      annual_total: estimate.annual_total,
      onetime_total: estimate.onetime_total,
      address: estimate.address,
      sent_at: estimate.sent_at,
      viewed_at: estimate.viewed_at,
      last_viewed_at: estimate.last_viewed_at,
    } : null,
    lead: lead ? {
      id: lead.id,
      status: lead.status,
      service_interest: lead.service_interest,
      waveguard_tier: lead.waveguard_tier,
      estimate_id: lead.estimate_id,
      next_follow_up_at: lead.next_follow_up_at,
    } : null,
  };
}

/**
 * Grounded LLM pass for the human-review draft (the "Agent Review Draft" card
 * in the comms composer). The deterministic classifiers above stay the router
 * — intent, actions, safety flags are unchanged — but suggested_message was a
 * fill-in-the-blank template that interpolated raw customer clauses whenever a
 * part-of-day word matched ("Hello Catherine! Hello what happened this morning
 * helps."). This replaces the template text with the shadow drafter's
 * draft → verify → revise engine (house voice; model routed per the SMS
 * reply-drafting split in config/models.js — default drafts on the mini
 * route, save-the-sale on Sonnet, FLAGSHIP fallback), so review drafts and
 * shadow/suggest drafts share one voice and one fact-discipline contract.
 *
 * Returns { reply, model, promptVersion, passes } — reply may be '' when the
 * drafter judges no reply warranted (courtesy ack), which the caller stores as
 * NULL so the composer shows no card. Returns null when the draft is
 * unavailable (LLM error, verify loop never converged, redaction placeholder
 * leaked, kill switch AGENT_REVIEW_LLM_DRAFTS=false, or no matched customer)
 * — the caller then falls back to the deterministic template, so an LLM miss
 * never blocks the decision row.
 *
 * Customer-scoped on purpose: without the webhook's matched customer row, a
 * phone re-lookup could aggregate a DIFFERENT account's facts into the prompt
 * (shared numbers) — lead-only estimate threads keep the template.
 */
async function generateLlmReviewDraft({ customer, body, decision, estimate, estimateLinked = true }) {
  if (process.env.AGENT_REVIEW_LLM_DRAFTS === 'false') return null;
  if (!customer) return null;
  try {
    const drafter = require('./sms-shadow-drafter');
    const ContextAggregator = require('./context-aggregator');
    const { hasSchedulingIntent } = require('./sms-intent');
    const context = await ContextAggregator.getContextForCustomer(customer);

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const { parsed, passes, converged, model, promptVersion, openTimesSnapshot, labelFactsSnapshot, factsGeneratedAt } = await drafter.generateGroundedDraft({
      laneId: 'estimate_followup', // the drafter's own lanes are the live SMS ones
      client,
      context,
      inboundMessage: body,
      intent: { intent: decision.intent, confidence: decision.confidence },
      schedulingIntent: hasSchedulingIntent(body),
      // Real-answers OPEN TIMES (pre-push audit P1): without city,
      // fetchOpenTimesBlock always returns null even for a matched
      // customer with a known city, and GATE_SMS_REAL_ANSWERS's rewritten
      // prompt would tell the model to offer times it was never given.
      // Same customer row + convention draftShadowReply uses.
      city: customer?.city || null,
      // Live, sendable draft: a visit-backed offer may run with no city
      // (GATE_SMS_OFFERS_SCHEDULER; replay/backfill callers never pass this).
      liveOpenTimes: true,
      // Pre-push audit P2: the ALREADY-RESOLVED estimate (resolveEstimateContext,
      // above this call in processInboundSms) so the offered slots reflect
      // THAT estimate's own service minutes — the same second argument
      // check_availability itself passes to getAvailableSlots.
      // A message linked to the estimate (its short code, or estimate or
      // quote wording — Codex #5194 r2) is priced with it. An unlinked open
      // estimate is one of the jobs the reply may be about: the drafter's
      // service identity step decides between it, the customer's visits
      // and any service they ask for ("can you add lawn service Tuesday?"
      // is about lawn, never the estimate — Codex #5194 r3/r4).
      estimateId: estimate?.id && estimateLinked ? estimate.id : null,
      openEstimate: estimate?.id && !estimateLinked ? { id: estimate.id, service: estimate.service_interest || null } : null,
    });
    // Only a verified-clean draft may replace the template: unconverged means
    // the reply still asserts facts the context doesn't support after the
    // revision budget — exactly the fabrication class this lane exists to stop.
    if (!parsed || !converged) return null;
    if (parsed.reply && require('./sms-suggest-mode').hasRedactionPlaceholder(parsed.reply)) {
      logger.warn(`[estimate-conversion-agent] LLM review draft leaked a redaction placeholder (customer=${customer.id}); using template`);
      return null;
    }
    // House rule: no UNGROUNDED prices in customer SMS. This lane's draft
    // lands in the composer's Use Draft button — same delivery boundary as
    // suggest-mode. With GATE_SMS_REAL_ANSWERS off, this stays the old
    // blanket hasPriceQuote reject (byte-identical). With the gate on, the
    // house-voice prompt is instructed to answer billing questions with
    // exact grounded amounts (Codex r3: rejecting every hasPriceQuote match
    // here discarded every verified v12 answer in favor of the template) —
    // reuse the shared authoritative-amount guard so only a FABRICATED or
    // unverifiable amount falls back; a real balance/invoice/dues figure
    // passes.
    if (parsed.reply) {
      if (gateEnvValue('GATE_SMS_REAL_ANSWERS')) {
        if (drafter.replyQuotesUngroundedAmount(parsed.reply, context)) {
          logger.warn(`[estimate-conversion-agent] LLM review draft quoted an ungrounded amount (customer=${customer.id}); using template`);
          return null;
        }
      } else if (require('./sms-suggest-mode').hasPriceQuote(parsed.reply)) {
        logger.warn(`[estimate-conversion-agent] LLM review draft quoted a price (customer=${customer.id}); using template`);
        return null;
      }
    }
    // The version THIS draft actually used (pre-push audit P1) — resolved
    // per call inside generateGroundedDraft off the ACTUAL gate state, not
    // the static drafter.PROMPT_VERSION (which stays house_voice_v11
    // forever once GATE_SMS_REAL_ANSWERS goes live). Persisted onto
    // agent_decisions.prompt_version below (processInboundSms), so this
    // must record what generated THIS row, not a label that never moves.
    // Pre-push audit P1: the actions this draft promises (payment link,
    // booking, escalate for a follow-up) ride to the review card the same
    // way the suggestion lane's do, so /agent-draft can show them.
    return {
      reply: parsed.reply, model, promptVersion, passes, openTimesSnapshot: openTimesSnapshot ?? null, labelFactsSnapshot: labelFactsSnapshot ?? null,
      intendedActions: Array.isArray(parsed.intended_actions) ? parsed.intended_actions : [],
      factsGeneratedAt: factsGeneratedAt ?? null,
    };
  } catch (err) {
    logger.warn(`[estimate-conversion-agent] LLM review draft failed (${err.message}); using template`);
    return null;
  }
}

async function processInboundSms({ customer, from, to, body, smsLogId, sourceMessageId } = {}) {
  if (!body || typeof body !== 'string') return null;

  try {
    const { estimate, shortCode } = await resolveEstimateContext({ customer, phone: from, body });
    const lead = await resolveLeadContext({ customer, phone: from, estimate });
    const recentSmsThread = await resolveRecentSmsThread({ customer, phone: from, smsLogId });
    const routed = routeEstimateOrCustomerReply(body, { customer, estimate, lead, recentSmsThread });
    const { workflow, agentName, decision } = routed;

    if (!decision.intent) return null;

    const idempotencyKey = sourceMessageId
      ? `${workflow}:twilio:${sourceMessageId}`
      : smsLogId
        ? `${workflow}:sms_log:${smsLogId}`
        : null;

    // Idempotency BEFORE the LLM draft, not just on insert: a fail-open
    // webhook redelivery or replay of an already-handled SMS would otherwise
    // run the full context aggregation + draft→verify→revise loop and then
    // have the insert dropped by onConflict — burning provider calls for
    // nothing. A concurrent duplicate can still slip past this read, but the
    // onConflict ignore below keeps the table correct; this check only
    // exists to avoid the wasted LLM spend on the common redelivery path.
    if (idempotencyKey) {
      const existing = await db('agent_decisions')
        .where({ idempotency_key: idempotencyKey })
        .first('id');
      if (existing) return null; // same semantics as the ignored insert: nothing new
    }

    // Follow-up #8 (Codex r9): the resolved estimate reaches the drafter's
    // availability lookup only when the inbound is routed as an ESTIMATE
    // interaction — a reschedule of an existing visit is priced with that
    // visit's service, not an unrelated open estimate's service_interest.
    // Only the estimate's own short code pins it (Codex #5194 r2/r8): "about
    // my estimate" or "can you quote lawn service?" leaves it one job the
    // reply may be about, and the drafter's service identity step weighs it
    // against the customer's visits and the service they name.
    const estimateLinked = Boolean(shortCode);
    const llmDraft = await generateLlmReviewDraft({ customer, body, decision, estimate: workflow === WORKFLOW ? estimate : null, estimateLinked });
    // The house no-price rule applies to WHATEVER text lands in the composer
    // card when the LLM path is rejected or unavailable. The scheduling lane
    // offers no template at all (it used to echo raw inbound text); the
    // remaining templates are fixed copy, but the guard stays as a backstop.
    // NULL = the agent offers no draft; the human writes the reply.
    const reviewDraftText = llmDraft ? (llmDraft.reply || null) : decision.suggestedMessage;
    // llmDraft is only ever returned once its own reply already cleared the
    // gate-aware amount guard above (grounded amount allowed on, blanket
    // hasPriceQuote reject off) — re-running hasPriceQuote here would throw
    // away that verified v12 answer (Codex r3). The deterministic template
    // (decision.suggestedMessage) never passed
    // any guard, so it keeps the unconditional hasPriceQuote reject
    // regardless of gate state.
    const reviewSuggestedMessage = llmDraft
      ? reviewDraftText
      : (reviewDraftText && require('./sms-suggest-mode').hasPriceQuote(reviewDraftText)
        ? null
        : reviewDraftText);

    const entityType = estimate ? 'estimate' : lead ? 'lead' : customer ? 'customer' : 'sms';
    const entityId = estimate?.id || lead?.id || customer?.id || null;

    const payload = {
      workflow,
      agent_name: agentName,
      decision_version: DECISION_VERSION,
      mode: 'shadow',
      status: 'pending_review',
      entity_type: entityType,
      entity_id: entityId,
      customer_id: customer?.id || estimate?.customer_id || lead?.customer_id || null,
      lead_id: lead?.id || null,
      estimate_id: estimate?.id || null,
      source_channel: 'sms',
      sms_log_id: smsLogId || null,
      source_message_id: sourceMessageId || null,
      detected_intent: decision.intent,
      confidence: decision.confidence,
      confidence_label: confidenceLabel(decision.confidence),
      input_snapshot: JSON.stringify({
        ...buildInputSnapshot({ body, customer, estimate, lead, from, to, shortCode }),
        routing: { workflow },
        recent_sms_thread: recentSmsThread,
        reply_training_hint: decision.metadata || null,
        // Provenance for the review draft: which engine produced
        // suggested_message. no_reply=true means the LLM judged a courtesy
        // ack that warrants no reply — suggested_message is NULL by design,
        // not a drafting failure.
        review_draft: llmDraft
          ? { source: 'llm', passes: llmDraft.passes, no_reply: !llmDraft.reply }
          : { source: 'template' },
        // Codex P2 (open-times send-time recheck): the minimum needed to
        // revalidate quoted OPEN TIMES windows before this decision is ever
        // sent — read back by verifyAgentDecisionForSend (admin-communications.js)
        // at /sms and /schedule-sms time. Absent for template drafts and for
        // any llm draft whose reply never quoted an open-times window.
        ...(llmDraft?.openTimesSnapshot ? { open_times_snapshot: llmDraft.openTimesSnapshot } : {}),
        // LABEL FACTS source, re-verified at send (agent-decision-send-checks).
        ...(llmDraft?.labelFactsSnapshot ? { label_facts_snapshot: llmDraft.labelFactsSnapshot } : {}),
        // Same sanitized shape publishSuggestion persists, read back by
        // GET /agent-draft (pre-push audit P1). Template drafts carry none.
        ...(llmDraft && Array.isArray(llmDraft.intendedActions)
          ? { intended_actions: require('./sms-suggest-mode').sanitizeIntendedActions(llmDraft.intendedActions) || [] }
          : {}),
        // Codex #5194 P2: the instant the drafter rendered FOLLOW-UP SLA
        // RIGHT NOW, read back by slaDraftedAt (sms-followup-sla.js) at both
        // send seams in place of this row's later created_at.
        ...(llmDraft?.factsGeneratedAt instanceof Date && Number.isFinite(llmDraft.factsGeneratedAt.getTime())
          ? { facts_generated_at: llmDraft.factsGeneratedAt.toISOString() }
          : {}),
      }),
      recommended_actions: JSON.stringify(decision.recommendedActions),
      auto_actions_allowed: JSON.stringify(decision.autoActionsAllowed),
      blocked_actions: JSON.stringify(decision.blockedActions),
      safety_flags: JSON.stringify(decision.safetyFlags),
      suggested_message: reviewSuggestedMessage,
      reasoning_summary: decision.reasoningSummary,
      model: llmDraft ? llmDraft.model : 'deterministic_rules',
      prompt_version: llmDraft ? llmDraft.promptVersion : null,
      idempotency_key: idempotencyKey,
    };

    const insert = db('agent_decisions').insert(payload).returning('*');
    if (idempotencyKey) insert.onConflict('idempotency_key').ignore();
    const [row] = await insert;
    return row || null;
  } catch (err) {
    logger.warn(`[estimate-conversion-agent] shadow decision skipped: ${err.message}`);
    return null;
  }
}

module.exports = {
  CUSTOMER_SMS_TRIAGE_AGENT_NAME,
  CUSTOMER_SMS_TRIAGE_WORKFLOW,
  WORKFLOW,
  SERVICE_SCHEDULING_WORKFLOW,
  AGENT_NAME,
  SERVICE_SCHEDULING_AGENT_NAME,
  DECISION_VERSION,
  classifyCustomerSmsTriageIntent,
  classifyEstimateSmsIntent,
  classifyServiceSchedulingSmsIntent,
  extractShortCode,
  normalizePhoneLast10,
  processInboundSms,
  routeEstimateOrCustomerReply,
  _test: {
    buildInputSnapshot,
    classifyCustomerSmsTriageIntent,
    classifyServiceSchedulingScenario,
    confidenceLabel,
    hasActiveServiceSchedulingThread,
    resolveRecentSmsThread,
    generateLlmReviewDraft,
  },
};
