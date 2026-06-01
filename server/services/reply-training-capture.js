const db = require('../models/db');
const logger = require('./logger');

const TRAINING_TABLE = 'reply_training_examples';
const CONTEXT_MESSAGE_LIMIT = 20;
const RECENT_CALL_LIMIT = 5;
const RECENT_SERVICE_LIMIT = 5;
const RECENT_ESTIMATE_LIMIT = 5;
const RECENT_LEAD_LIMIT = 5;
const INBOUND_LOOKBACK_DAYS = 21;
const AGENT_DECISION_LINK_LOOKBACK_DAYS = 7;

let hasTrainingTableCache = null;

function parseJson(value, fallback = {}) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_err) {
    return fallback;
  }
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function classifyScenario({ inboundBody = '', outboundBody = '', metadata = {} } = {}) {
  const text = `${inboundBody} ${outboundBody}`.toLowerCase();
  if (metadata.scenarioLabel) return String(metadata.scenarioLabel).slice(0, 80);
  if (/\b(turner|orikin|terminix|moxie|truly nolen|competitor|quote from|another company)\b/.test(text)) return 'competitor_comparison';
  if (/\b(price|pricing|cost|how much|discount|coupon|expensive|cheap|payment|invoice|card|autopay|prepay)\b/.test(text)) return 'pricing_or_payment_question';
  if (/\b(schedule|available|appointment|tomorrow|today|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|time)\b/.test(text)) return 'scheduling';
  if (/\b(pet|dog|cat|kid|baby|safe|inside|odor|smell|dry|rain|weather)\b/.test(text)) return 'safety_or_prep_question';
  if (/\b(roach|ant|spider|mosquito|termite|rodent|rat|mouse|flea|tick|wasp|bee|attic|lanai|boracare|bora-care)\b/.test(text)) return 'service_scope_or_pest_question';
  if (/\b(not happy|upset|complaint|still seeing|didn't work|did not work|issue|problem|callback|warranty)\b/.test(text)) return 'service_concern';
  if (/\b(review|google|feedback|stars?)\b/.test(text)) return 'review_or_feedback';
  return 'general_customer_reply';
}

function shouldCaptureReply({ channel, direction, authorType, adminUserId, messageType, body } = {}) {
  if (channel !== 'sms') return false;
  if (direction !== 'outbound') return false;
  if (!normalizeText(body)) return false;
  if (authorType !== 'admin' && !adminUserId) return false;
  if (['internal_alert', 'system_note'].includes(String(messageType || '').toLowerCase())) return false;
  return true;
}

function compactMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    channel: row.channel,
    direction: row.direction,
    authorType: row.author_type,
    body: row.body || null,
    messageType: row.message_type || null,
    deliveryStatus: row.delivery_status || null,
    createdAt: row.created_at,
  };
}

function compactCall(row) {
  return {
    id: row.id,
    direction: row.direction || null,
    fromPhone: row.from_phone || null,
    toPhone: row.to_phone || null,
    status: row.status || row.call_status || null,
    disposition: row.disposition || null,
    synopsis: row.lead_synopsis || null,
    transcription: row.transcription || null,
    aiExtraction: parseJson(row.ai_extraction, null),
    createdAt: row.created_at,
  };
}

function compactService(row) {
  return {
    id: row.id,
    serviceDate: row.service_date || row.scheduled_date || null,
    serviceType: row.service_type || row.service_line || row.type || null,
    status: row.status || null,
    notes: row.notes || row.service_notes || row.tech_notes || null,
    createdAt: row.created_at,
  };
}

function compactEstimate(row) {
  return {
    id: row.id,
    status: row.status || null,
    waveguardTier: row.waveguard_tier || null,
    total: row.total || row.total_price || row.estimated_total || null,
    serviceType: row.service_type || row.primary_service || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function compactLead(row) {
  return {
    id: row.id,
    status: row.status || null,
    sourceType: row.source_type || null,
    channel: row.channel || null,
    name: row.name || null,
    synopsis: row.lead_synopsis || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function tableExists(name) {
  if (name === TRAINING_TABLE && hasTrainingTableCache !== null) return hasTrainingTableCache;
  const exists = await db.schema.hasTable(name).catch(() => false);
  if (name === TRAINING_TABLE) hasTrainingTableCache = exists;
  return exists;
}

function resetTableCacheForTests() {
  hasTrainingTableCache = null;
}

async function findLatestInbound({ conversationId, outboundCreatedAt }) {
  if (!conversationId) return null;
  const since = new Date(new Date(outboundCreatedAt || Date.now()).getTime() - INBOUND_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  return db('messages')
    .where({
      conversation_id: conversationId,
      channel: 'sms',
      direction: 'inbound',
    })
    .where('created_at', '<=', outboundCreatedAt || new Date())
    .where('created_at', '>=', since)
    .orderBy('created_at', 'desc')
    .first();
}

async function findRecentAgentDecisionForReply({ inbound, outboundCreatedAt, customerId } = {}) {
  const before = outboundCreatedAt || new Date();
  const since = new Date(new Date(before).getTime() - AGENT_DECISION_LINK_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const inboundCreatedAt = inbound?.created_at ? new Date(inbound.created_at) : null;
  const afterInbound = inboundCreatedAt && !Number.isNaN(inboundCreatedAt.getTime())
    ? new Date(inboundCreatedAt.getTime() - 5 * 60 * 1000)
    : since;

  if (inbound?.twilio_sid) {
    const exact = await db('agent_decisions')
      .where({
        source_channel: 'sms',
        source_message_id: inbound.twilio_sid,
      })
      .where('created_at', '<=', before)
      .whereIn('status', ['pending_review', 'accepted', 'corrected'])
      .orderByRaw("CASE WHEN status = 'pending_review' THEN 0 ELSE 1 END")
      .orderBy('created_at', 'desc')
      .first()
      .catch(() => null);
    if (exact) return exact;
  }

  if (!customerId) return null;
  return db('agent_decisions')
    .where({
      source_channel: 'sms',
      customer_id: customerId,
    })
    .where('created_at', '<=', before)
    .where('created_at', '>=', afterInbound > since ? afterInbound : since)
    .whereIn('status', ['pending_review', 'accepted', 'corrected'])
    .orderByRaw("CASE WHEN status = 'pending_review' THEN 0 ELSE 1 END")
    .orderBy('created_at', 'desc')
    .first()
    .catch(() => null);
}

async function buildContextSnapshot({ conversation, inbound, outbound, customerId }) {
  const before = outbound.created_at || new Date();
  const messages = await db('messages')
    .where({ conversation_id: outbound.conversation_id })
    .where('created_at', '<=', before)
    .orderBy('created_at', 'desc')
    .limit(CONTEXT_MESSAGE_LIMIT);

  const [customer, calls, services, estimates, leads] = await Promise.all([
    customerId ? db('customers').where({ id: customerId }).first().catch(() => null) : null,
    customerId
      ? db('call_log').where({ customer_id: customerId }).orderBy('created_at', 'desc').limit(RECENT_CALL_LIMIT).catch(() => [])
      : [],
    customerId
      ? db('service_records').where({ customer_id: customerId }).orderBy('created_at', 'desc').limit(RECENT_SERVICE_LIMIT).catch(() => [])
      : [],
    customerId
      ? db('estimates').where({ customer_id: customerId }).orderBy('created_at', 'desc').limit(RECENT_ESTIMATE_LIMIT).catch(() => [])
      : [],
    customerId
      ? db('leads').where({ customer_id: customerId }).orderBy('created_at', 'desc').limit(RECENT_LEAD_LIMIT).catch(() => [])
      : [],
  ]);

  return {
    conversation: {
      id: conversation?.id || outbound.conversation_id,
      channel: conversation?.channel || 'sms',
      contactPhone: conversation?.contact_phone || null,
      ourEndpointId: conversation?.our_endpoint_id || null,
      lastInboundAt: conversation?.last_inbound_at || null,
    },
    customer: customer ? {
      id: customer.id,
      name: [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim() || customer.name || null,
      phone: customer.phone || null,
      email: customer.email || null,
      status: customer.status || null,
    } : null,
    pairedInbound: compactMessage(inbound),
    outboundReply: compactMessage(outbound),
    smsThread: messages.reverse().map(compactMessage),
    recentCalls: calls.map(compactCall),
    recentServices: services.map(compactService),
    recentEstimates: estimates.map(compactEstimate),
    recentLeads: leads.map(compactLead),
  };
}

async function captureReplyExampleForMessage(outboundMessage, options = {}) {
  try {
    if (!(await tableExists(TRAINING_TABLE))) return null;
    if (!outboundMessage?.id) return null;

    const metadata = {
      ...parseJson(outboundMessage.metadata, {}),
      ...(options.metadata || {}),
    };

    if (!shouldCaptureReply({
      channel: outboundMessage.channel,
      direction: outboundMessage.direction,
      authorType: outboundMessage.author_type,
      adminUserId: outboundMessage.admin_user_id,
      messageType: outboundMessage.message_type,
      body: outboundMessage.body,
    })) {
      return null;
    }

    const existing = await db(TRAINING_TABLE)
      .where({ outbound_message_id: outboundMessage.id })
      .first();
    if (existing) return existing;

    const conversation = await db('conversations').where({ id: outboundMessage.conversation_id }).first();
    const customerId = outboundMessage.customer_id || conversation?.customer_id || options.customerId || null;
    const inbound = await findLatestInbound({
      conversationId: outboundMessage.conversation_id,
      outboundCreatedAt: outboundMessage.created_at || new Date(),
    });
    if (!inbound) return null;
    const linkedDecision = metadata.agentDecisionId
      ? null
      : await findRecentAgentDecisionForReply({
        inbound,
        outboundCreatedAt: outboundMessage.created_at || new Date(),
        customerId,
      });
    const sourceAgentDecisionId = metadata.agentDecisionId || linkedDecision?.id || null;
    const linkedDecisionInput = parseJson(linkedDecision?.input_snapshot, {});

    const contextSnapshot = await buildContextSnapshot({
      conversation,
      inbound,
      outbound: outboundMessage,
      customerId,
    });

    const agentDraft = normalizeText(metadata.agentDraft || metadata.suggestedReply || '');
    const outboundBody = normalizeText(outboundMessage.body);
    const payload = {
      channel: outboundMessage.channel,
      conversation_id: outboundMessage.conversation_id,
      customer_id: customerId,
      inbound_message_id: inbound.id,
      outbound_message_id: outboundMessage.id,
      source_agent_decision_id: sourceAgentDecisionId,
      inbound_body: inbound.body || null,
      outbound_body: outboundBody,
      agent_draft: agentDraft || null,
      agent_draft_edited: agentDraft ? agentDraft !== outboundBody : null,
      scenario_label: classifyScenario({
        inboundBody: inbound.body,
        outboundBody,
        metadata: {
          scenarioLabel: metadata.scenarioLabel || linkedDecisionInput?.reply_training_hint?.scenarioLabel,
        },
      }),
      capture_reason: sourceAgentDecisionId ? 'admin_sms_reply_linked_agent_decision' : 'admin_sms_reply',
      context_snapshot: JSON.stringify(contextSnapshot),
      metadata: JSON.stringify({
        ...metadata,
        actualHumanReply: outboundBody,
        linkedAgentDecisionId: sourceAgentDecisionId,
        linkedAgentDecisionWorkflow: linkedDecision?.workflow || null,
        linkedAgentDecisionIntent: linkedDecision?.detected_intent || null,
        outboundMessageType: outboundMessage.message_type || null,
        outboundAdminUserId: outboundMessage.admin_user_id || null,
      }),
      captured_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    };

    const recentEstimate = contextSnapshot.recentEstimates?.[0];
    const recentLead = contextSnapshot.recentLeads?.[0];
    if (recentEstimate?.id) payload.estimate_id = recentEstimate.id;
    if (recentLead?.id) payload.lead_id = recentLead.id;

    const [row] = await db(TRAINING_TABLE).insert(payload).returning('*');
    return row || null;
  } catch (err) {
    logger.warn(`[reply-training] capture failed: ${err.message}`);
    return null;
  }
}

async function captureReplyExampleForTwilioSid(twilioSid, options = {}) {
  if (!twilioSid) return null;
  const outbound = await db('messages')
    .where({ channel: 'sms', twilio_sid: twilioSid })
    .first()
    .catch(() => null);
  if (!outbound) return null;
  return captureReplyExampleForMessage(outbound, options);
}

async function upsertReplyExampleFromAgentReview({
  decision,
  context = {},
  finalReply,
  idealReply,
  actualReply,
  replyVerdict = 'edited',
  reviewNote,
  scenarioLabel,
  reviewedBy,
} = {}) {
  try {
    if (!(await tableExists(TRAINING_TABLE))) return null;
    if (!decision?.id) return null;

    const normalizedVerdict = String(replyVerdict || 'edited').trim() || 'edited';
    const noReplyNeeded = normalizedVerdict === 'no_reply_needed';
    const outboundBody = noReplyNeeded ? null : normalizeText(finalReply || idealReply || actualReply || '');
    if (!noReplyNeeded && !outboundBody) return null;

    const inboundBody = normalizeText(decision.inboundMessage || decision.inputSnapshot?.sms?.body || '');
    const agentDraft = normalizeText(decision.suggestedMessage || '');
    const resolvedScenario = classifyScenario({
      inboundBody,
      outboundBody: outboundBody || '',
      metadata: { scenarioLabel },
    });
    const contextSnapshot = {
      conversation: context.conversation || null,
      customer: context.customer || null,
      lead: context.lead || null,
      estimate: context.estimate || null,
      pairedInbound: {
        id: decision.smsLogId || decision.sourceMessageId || null,
        channel: 'sms',
        direction: 'inbound',
        body: inboundBody,
        createdAt: decision.createdAt || null,
      },
      outboundReply: actualReply ? {
        channel: 'sms',
        direction: 'outbound',
        authorType: 'admin',
        body: normalizeText(actualReply),
      } : null,
      smsThread: context.smsThread || [],
      recentCalls: context.calls || [],
      recentServices: context.services || [],
      recentEstimates: context.estimate ? [context.estimate] : [],
      recentLeads: context.lead ? [context.lead] : [],
      sourceAgentDecision: {
        id: decision.id,
        workflow: decision.workflow,
        detectedIntent: decision.detectedIntent,
        confidence: decision.confidence,
        recommendedActions: decision.recommendedActions || [],
        blockedActions: decision.blockedActions || [],
      },
    };

    const payload = {
      channel: 'sms',
      conversation_id: decision.conversationId || null,
      customer_id: decision.customerId || null,
      lead_id: decision.leadId || null,
      estimate_id: decision.estimateId || null,
      source_agent_decision_id: decision.id,
      inbound_body: inboundBody || null,
      outbound_body: outboundBody,
      agent_draft: agentDraft || null,
      agent_draft_edited: noReplyNeeded ? null : agentDraft ? agentDraft !== outboundBody : null,
      edit_summary: reviewNote || null,
      scenario_label: resolvedScenario,
      capture_reason: 'agent_review_reply_verdict',
      status: 'reviewed',
      review_verdict: normalizedVerdict,
      review_note: reviewNote || null,
      reviewed_by: reviewedBy || null,
      reviewed_at: new Date(),
      context_snapshot: JSON.stringify(contextSnapshot),
      metadata: JSON.stringify({
        source: 'agent_review',
        actualHumanReply: normalizeText(actualReply || '') || null,
        finalReplyProvided: !!normalizeText(outboundBody || ''),
        idealReplyProvided: !!normalizeText(idealReply || finalReply || ''),
        noReplyNeeded,
      }),
      captured_at: new Date(),
      updated_at: new Date(),
    };

    const existing = await db(TRAINING_TABLE)
      .where({ source_agent_decision_id: decision.id })
      .whereIn('capture_reason', ['agent_review_reply_verdict', 'agent_review_actual_or_ideal_reply', 'agent_review_ideal_reply'])
      .first();

    if (existing) {
      const [row] = await db(TRAINING_TABLE)
        .where({ id: existing.id })
        .update(payload)
        .returning('*');
      return row || null;
    }

    const [row] = await db(TRAINING_TABLE)
      .insert({
        ...payload,
        created_at: new Date(),
      })
      .returning('*');
    return row || null;
  } catch (err) {
    logger.warn(`[reply-training] agent review save failed: ${err.message}`);
    return null;
  }
}

module.exports = {
  captureReplyExampleForMessage,
  captureReplyExampleForTwilioSid,
  upsertReplyExampleFromAgentReview,
  _internals: {
    classifyScenario,
    shouldCaptureReply,
    parseJson,
    resetTableCacheForTests,
    findRecentAgentDecisionForReply,
  },
};
