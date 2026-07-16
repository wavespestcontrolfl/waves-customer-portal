/**
 * Agent Estimate evidence pack for a selected lead.
 *
 * The pack is intentionally source-rich and price-free: quote-form fields,
 * transcripts, SMS, profile facts, and prior estimates. Claude receives it
 * as current-page data; deterministic pricing still happens only through the
 * pricing tool. Shared phone lines fail closed so one person's history never
 * appears on another person's estimate session.
 */

const db = require('../models/db');
const logger = require('./logger');
const {
  loadCustomerByPhone,
  loadPriorEstimates,
  loadSmsThread,
  _private: { extractionFromCall, last10 },
} = require('./estimator-engine/context-builder');

const MAX_EXTRACTED_CHARS = 12000;
const MAX_TRANSCRIPT_CHARS = 24000;

function parseJson(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function clampText(value, max = 2000) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function compactJson(value, maxChars = MAX_EXTRACTED_CHARS) {
  try {
    const text = JSON.stringify(value || {});
    if (text.length <= maxChars) return value || {};
    return { truncated: true, raw_excerpt: text.slice(0, maxChars) };
  } catch {
    return {};
  }
}

function collectSubmissionText(value, path = [], out = []) {
  if (out.length >= 8 || value == null) return out;
  if (Array.isArray(value)) {
    value.slice(0, 12).forEach((item, index) => collectSubmissionText(item, [...path, String(index)], out));
    return out;
  }
  if (typeof value !== 'object') return out;
  for (const [key, child] of Object.entries(value)) {
    if (out.length >= 8) break;
    const nextPath = [...path, key];
    if (typeof child === 'string'
      && /(message|comment|note|description|details|request|concern|problem)/i.test(key)) {
      const text = clampText(child, 1600);
      if (text) out.push({ field: nextPath.join('.'), text });
    } else if (child && typeof child === 'object') {
      collectSubmissionText(child, nextPath, out);
    }
  }
  return out;
}

async function phoneIsShared(lead) {
  const digits = last10(lead?.phone);
  if (!digits) return false;
  try {
    const row = await db('leads')
      .whereNull('deleted_at')
      .whereNot('id', lead.id)
      .whereRaw("RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [digits])
      .first('id');
    return !!row;
  } catch (err) {
    logger.warn(`[agent-estimate] shared-phone check failed: ${err.message}`);
    return true;
  }
}

async function loadCalls(lead, sharedPhone) {
  try {
    const digits = sharedPhone ? null : last10(lead.phone);
    if (!lead.twilio_call_sid && !digits) return [];
    const rows = await db('call_log')
      .where(function callMatch() {
        if (lead.twilio_call_sid) this.orWhere('twilio_call_sid', lead.twilio_call_sid);
        if (digits) {
          this.orWhereRaw("RIGHT(regexp_replace(COALESCE(from_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [digits]);
          this.orWhereRaw("RIGHT(regexp_replace(COALESCE(to_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [digits]);
        }
      })
      .orderBy('created_at', 'desc')
      .limit(3)
      .select('id', 'twilio_call_sid', 'direction', 'duration_seconds', 'transcription',
        'transcription_status', 'recording_url', 'ai_extraction', 'ai_extraction_enriched',
        'v2_extraction_status', 'created_at');
    const calls = rows.map((call) => {
      const { extraction, source } = extractionFromCall(call);
      return {
        id: call.id,
        call_sid: call.twilio_call_sid || null,
        direction: call.direction || null,
        duration_seconds: call.duration_seconds || null,
        created_at: call.created_at,
        transcript: call.transcription
          ? String(call.transcription).slice(0, MAX_TRANSCRIPT_CHARS)
          : null,
        has_recording: !!call.recording_url,
        transcription_status: call.transcription_status || null,
        extraction: compactJson(extraction),
        extraction_source: source,
      };
    });
    const leadSummary = clampText(lead.transcript_summary, 4000);
    if (leadSummary) {
      const matchingCall = calls.find((call) => (
        lead.twilio_call_sid && call.call_sid === lead.twilio_call_sid
      ));
      if (matchingCall) {
        matchingCall.transcript_summary = leadSummary;
      } else {
        calls.unshift({
          id: `lead-summary:${lead.id}`,
          call_sid: lead.twilio_call_sid || null,
          direction: null,
          duration_seconds: lead.call_duration_seconds || null,
          created_at: lead.first_contact_at || lead.created_at || null,
          transcript: null,
          transcript_summary: leadSummary,
          has_recording: !!lead.call_recording_url,
          transcription_status: 'summary_only',
          extraction: {},
          extraction_source: 'none',
        });
      }
    }
    return calls.slice(0, 3);
  } catch (err) {
    logger.warn(`[agent-estimate] call load failed: ${err.message}`);
    return [];
  }
}

async function loadCustomer(lead, extraction, sharedPhone) {
  if (lead.customer_id) {
    try {
      return await db('customers')
        .where({ id: lead.customer_id })
        .whereNull('deleted_at')
        .first('id', 'first_name', 'last_name', 'phone', 'email', 'address_line1', 'city',
          'state', 'zip', 'pipeline_stage', 'waveguard_tier', 'lawn_type', 'property_sqft',
          'lot_sqft', 'property_type', 'company_name');
    } catch (err) {
      logger.warn(`[agent-estimate] linked customer load failed: ${err.message}`);
    }
  }
  if (sharedPhone) return null;
  const match = await loadCustomerByPhone(lead.phone, extraction);
  return match.ambiguous ? null : match.customer;
}

function suggestedPrompt(lead, currentEstimate) {
  const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'this lead';
  const action = currentEstimate?.status === 'draft' && currentEstimate?.source === 'estimator_engine'
    ? 'Review and revise the existing Agent Estimate draft'
    : 'Build a new Agent Estimate draft';
  return `${action} for ${name}. Read every supplied quote-form field, call transcript, and SMS before selecting services. Verify the home/building sqft and lot sqft; for commercial properties verify the treated unit/building sqft, and for lawn verify treatable turf rather than assuming the whole lot. Check the selected service protocols, product availability (say untracked when no count exists), and collected margin using the $35 loaded labor rate. Use only compute_estimate for dollars. Show assumptions and conflicting facts, then propose create_agent_estimate_draft for my confirmation. Never send automatically.`;
}

async function buildAgentEstimateContext(leadId) {
  const lead = await db('leads')
    .leftJoin('lead_sources', 'leads.lead_source_id', 'lead_sources.id')
    .select('leads.*', 'lead_sources.name as source_name', 'lead_sources.channel as source_channel')
    .where('leads.id', leadId)
    .whereNull('leads.deleted_at')
    .first();
  if (!lead) return { error: 'lead_not_found' };

  const extractedData = parseJson(lead.extracted_data);
  const sharedPhone = await phoneIsShared(lead);
  const calls = await loadCalls(lead, sharedPhone);
  const latestExtraction = calls[0]?.extraction || null;
  const [customer, smsThread, priorEstimates, activities, currentEstimate, memories] = await Promise.all([
    loadCustomer(lead, latestExtraction, sharedPhone),
    sharedPhone ? Promise.resolve([]) : loadSmsThread(lead.phone, { limit: 60 }),
    sharedPhone ? Promise.resolve([]) : loadPriorEstimates(lead.phone, { limit: 8 }),
    db('lead_activities').where({ lead_id: lead.id }).orderBy('created_at', 'desc').limit(30)
      .select('activity_type', 'description', 'metadata', 'created_at').catch(() => []),
    lead.estimate_id
      ? db('estimates').where({ id: lead.estimate_id }).first('id', 'token', 'status', 'source',
        'monthly_total', 'annual_total', 'onetime_total', 'service_interest', 'estimate_data', 'updated_at').catch(() => null)
      : Promise.resolve(null),
    db('agent_estimate_memory').where({ status: 'approved' }).orderBy('reviewed_at', 'desc')
      .limit(20).select('id', 'rule_text', 'rationale', 'version', 'reviewed_at').catch(() => []),
  ]);

  const profileIsExisting = !!lead.customer_id || !!customer;
  const currentEstimateData = parseJson(currentEstimate?.estimate_data);
  const currentEngine = currentEstimateData.estimatorEngine || {};
  const contact = {
    name: [lead.first_name, lead.last_name].filter(Boolean).join(' ') || null,
    phone: lead.phone || null,
    email: lead.email || null,
    address: [lead.address, lead.city, lead.zip].filter(Boolean).join(', ') || null,
  };

  return {
    lead: {
      id: lead.id,
      ...contact,
      service_interest: lead.service_interest || null,
      lead_type: lead.lead_type || null,
      status: lead.status || null,
      urgency: lead.urgency || null,
      is_commercial: lead.is_commercial === true,
      source_name: lead.source_name || null,
      source_channel: lead.source_channel || null,
      first_contact_at: lead.first_contact_at || lead.created_at,
    },
    quote_form: {
      message_fields: collectSubmissionText(extractedData),
      extracted_data: compactJson(extractedData),
    },
    calls,
    sms_thread: smsThread,
    activities: (activities || []).map((activity) => ({
      type: activity.activity_type,
      description: clampText(activity.description, 1200),
      metadata: compactJson(parseJson(activity.metadata), 3000),
      created_at: activity.created_at,
    })),
    customer_profile: customer ? {
      id: customer.id,
      name: [customer.first_name, customer.last_name].filter(Boolean).join(' ') || null,
      phone: customer.phone || null,
      email: customer.email || null,
      address: [customer.address_line1, customer.city, customer.state, customer.zip].filter(Boolean).join(', ') || null,
      pipeline_stage: customer.pipeline_stage || null,
      waveguard_tier: customer.waveguard_tier || null,
      lawn_type: customer.lawn_type || null,
      treatable_lawn_sqft: customer.property_sqft || null,
      lot_sqft: customer.lot_sqft || null,
      property_type: customer.property_type || null,
      company_name: customer.company_name || null,
    } : null,
    is_existing_customer: profileIsExisting,
    shared_phone_history_suppressed: sharedPhone,
    prior_estimates: priorEstimates,
    current_estimate: currentEstimate ? {
      id: currentEstimate.id,
      token: currentEstimate.token,
      status: currentEstimate.status,
      source: currentEstimate.source,
      monthly_total: Number(currentEstimate.monthly_total || 0),
      annual_total: Number(currentEstimate.annual_total || 0),
      onetime_total: Number(currentEstimate.onetime_total || 0),
      service_interest: currentEstimate.service_interest || null,
      agent_origin: currentEngine.origin || null,
      lane: currentEngine.lane || null,
      lane_reasons: currentEngine.laneReasons || [],
      editable_here: currentEstimate.status === 'draft'
        && currentEstimate.source === 'estimator_engine'
        && currentEngine.origin === 'manual_agent',
      updated_at: currentEstimate.updated_at,
    } : null,
    approved_learning: memories,
    pricing_policy: {
      pricing_authority: 'generateEstimate',
      loaded_labor_rate_per_hour: 35,
      target_collected_margin: 0.35,
      protocols_and_inventory_may_change_scope_or_review_status_but_never_price: true,
      inventory_null_means: 'untracked, not in stock',
      send_policy: 'operator_only',
    },
    suggested_prompt: suggestedPrompt(lead, currentEstimate),
  };
}

module.exports = {
  buildAgentEstimateContext,
  _private: { clampText, collectSubmissionText, compactJson, parseJson, suggestedPrompt },
};
