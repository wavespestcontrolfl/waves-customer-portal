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
  _private: { extractionFromCall, firstExternalPhone, last10 },
} = require('./estimator-engine/context-builder');
const { loadCurrentServiceSpendContext } = require('./estimate-membership-context');

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
    const rows = await db('leads')
      .whereNull('deleted_at')
      .whereNot('id', lead.id)
      .whereRaw("RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [digits])
      .limit(10)
      .select('first_name', 'last_name');
    if (!rows.length) return false;
    // A REPEAT lead for the same person is not a shared line — suppressing
    // it would price a returning customer as a new account and hide their
    // own SMS/estimate history. Fail closed: only a FULL name match (both
    // last names AND both first names present and equal) reads as the same
    // person — a missing first name on a family line could be a different
    // household member, so it stays shared.
    const norm = (value) => String(value || '').trim().toLowerCase();
    const leadFirst = norm(lead.first_name);
    const leadLast = norm(lead.last_name);
    return rows.some((row) => {
      const first = norm(row.first_name);
      const last = norm(row.last_name);
      const samePerson = !!(leadLast && last && last === leadLast
        && leadFirst && first && first === leadFirst);
      return !samePerson;
    });
  } catch (err) {
    logger.warn(`[agent-estimate] shared-phone check failed: ${err.message}`);
    return true;
  }
}

async function loadCalls(lead, phoneKey) {
  try {
    const digits = last10(phoneKey);
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

async function resolveCustomer(lead, extraction, phoneKey) {
  if (lead.customer_id) {
    try {
      const linked = await db('customers')
        .where({ id: lead.customer_id })
        .whereNull('deleted_at')
        .first('id', 'first_name', 'last_name', 'phone', 'email', 'address_line1', 'city',
          'state', 'zip', 'pipeline_stage', 'waveguard_tier', 'lawn_type', 'property_sqft',
          'lot_sqft', 'property_type', 'company_name');
      return { customer: linked || null, ambiguous: false };
    } catch (err) {
      logger.warn(`[agent-estimate] linked customer load failed: ${err.message}`);
    }
  }
  if (!phoneKey) return { customer: null, ambiguous: false };
  // A phone matching multiple customer rows is ambiguous even when no other
  // LEAD shares the number (phoneIsShared checks leads only) — the caller
  // must treat this exactly like a shared line and suppress phone-scoped
  // history, or one customer's SMS/estimates leak into another lead's session.
  const match = await loadCustomerByPhone(phoneKey, extraction);
  return { customer: match.ambiguous ? null : match.customer, ambiguous: match.ambiguous === true };
}

function suggestedPrompt(lead, currentEstimate, customerAccount = null) {
  const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'this lead';
  const action = currentEstimate?.status === 'draft' && currentEstimate?.source === 'estimator_engine'
    ? 'Review and revise the existing Agent Estimate draft'
    : 'Build a new Agent Estimate draft';
  const accountInstruction = customerAccount?.recognized
    ? ' This is a recognized customer expansion: preserve every active current service and its existing paid price, use the current service keys only to establish the starting membership tier, and quote only services the customer wants to add. Pass this selected lead ID to compute_estimate so the engine applies the combined tier only to those additions. Select the customer presentation from the newly quoted service mix.'
    : '';
  return `${action} for ${name}. Read every supplied quote-form field, call transcript, and SMS before selecting services.${accountInstruction} Verify the home/building sqft and lot sqft; for commercial properties verify the treated unit/building sqft, and for lawn verify treatable turf rather than assuming the whole lot. Check the selected service protocols, product availability (say untracked when no count exists), and collected margin using the $35 loaded labor rate. Use only compute_estimate for dollars. Show assumptions and conflicting facts, then propose create_agent_estimate_draft for my confirmation. Never send automatically.`;
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
  // Twilio substitutes digit sentinels for suppressed caller IDs (ANONYMOUS/
  // RESTRICTED) and forwarded calls can store an internal tracking line —
  // keying phone-scoped history on either merges unrelated blocked callers
  // into this lead's evidence. Only a verified external number is usable.
  const externalPhone = firstExternalPhone(lead.phone);
  const sharedPhone = externalPhone ? await phoneIsShared(lead) : false;
  const phoneKey = externalPhone && !sharedPhone ? externalPhone : null;
  const rawCalls = await loadCalls(lead, phoneKey);
  // Disambiguate the customer match ONLY with the extraction from THIS lead's
  // own call (SID match) — the newest phone-matched call can belong to a
  // different person on a shared/family line, and its caller name would
  // confidently select the wrong customer profile. With no SID-matched call,
  // a multi-customer phone stays ambiguous and history stays suppressed.
  const leadCall = lead.twilio_call_sid
    ? rawCalls.find((call) => call.call_sid === lead.twilio_call_sid)
    : null;
  const { customer, ambiguous: customerAmbiguous } = await resolveCustomer(lead, leadCall?.extraction || null, phoneKey);
  // Phone-scoped history fails closed on BOTH suppression signals: another
  // lead on the number (sharedPhone) or multiple customer rows on the number
  // (customerAmbiguous). Either way the thread/estimates may belong to a
  // different person and must not enter this lead's evidence pack.
  const phoneHistorySuppressed = sharedPhone || customerAmbiguous;
  // Phone-matched call rows are equally cross-contaminated on an ambiguous
  // number; keep only calls tied to THIS lead (its twilio_call_sid or its own
  // transcript summary).
  const calls = customerAmbiguous
    ? rawCalls.filter((call) => (
      (lead.twilio_call_sid && call.call_sid === lead.twilio_call_sid)
      || String(call.id).startsWith('lead-summary:')
    ))
    : rawCalls;
  const [smsThread, priorEstimates, activities, currentEstimate, memories] = await Promise.all([
    (phoneHistorySuppressed || !phoneKey) ? Promise.resolve([]) : loadSmsThread(phoneKey, { limit: 60 }),
    (phoneHistorySuppressed || !phoneKey) ? Promise.resolve([]) : loadPriorEstimates(phoneKey, { limit: 8 }),
    db('lead_activities').where({ lead_id: lead.id }).orderBy('created_at', 'desc').limit(30)
      .select('activity_type', 'description', 'metadata', 'created_at').catch(() => []),
    lead.estimate_id
      ? db('estimates').where({ id: lead.estimate_id }).first('id', 'token', 'status', 'source',
        'monthly_total', 'annual_total', 'onetime_total', 'service_interest', 'estimate_data',
        'customer_phone', 'customer_email', 'updated_at').catch(() => null)
      : Promise.resolve(null),
    db('agent_estimate_memory').where({ status: 'approved' }).orderBy('reviewed_at', 'desc')
      .limit(20).select('id', 'rule_text', 'rationale', 'version', 'reviewed_at').catch(() => []),
  ]);

  const profileIsExisting = !!lead.customer_id || !!customer;
  let customerSpend = {
    existingServiceKeys: [], currentServices: [], currentSpendPerVisitTotal: 0,
    currentTier: null, currentTierLabel: null, currentDiscountPct: 0,
  };
  // A recognized customer whose service lookup FAILED must not silently price
  // as if they had no services — that would drop the membership tier and let
  // an active service be quoted again. The flag makes the pricing paths
  // refuse instead of guessing.
  let serviceContextUnavailable = false;
  if (customer?.id) {
    try {
      customerSpend = await loadCurrentServiceSpendContext(db, customer.id);
    } catch (err) {
      serviceContextUnavailable = true;
      logger.warn(`[agent-estimate] current-service spend load failed: ${err.message}`);
    }
  }
  const customerAccount = customer ? {
    recognized: true,
    customer_id: customer.id,
    match_method: lead.customer_id ? 'linked_customer_id' : 'unambiguous_phone',
    active_plan: customerSpend.existingServiceKeys.length > 0,
    current_tier: customerSpend.currentTierLabel || customer.waveguard_tier || null,
    current_discount_pct: customerSpend.currentDiscountPct,
    existing_service_keys: customerSpend.existingServiceKeys,
    current_services: customerSpend.currentServices,
    current_spend_per_visit_total: customerSpend.currentSpendPerVisitTotal,
    service_context_unavailable: serviceContextUnavailable,
  } : {
    recognized: false,
    customer_id: null,
    match_method: sharedPhone
      ? 'shared_phone_suppressed'
      : (customerAmbiguous ? 'ambiguous_customer_suppressed' : null),
    active_plan: false,
    current_tier: null,
    current_discount_pct: 0,
    existing_service_keys: [],
    current_services: [],
    current_spend_per_visit_total: 0,
  };
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
    customer_account: customerAccount,
    is_existing_customer: profileIsExisting,
    shared_phone_history_suppressed: sharedPhone,
    ambiguous_customer_history_suppressed: customerAmbiguous,
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
      // The send endpoint delivers to the contact snapshot stored ON the
      // estimate, not the lead's current contact — the UI must display and
      // gate on these values so a post-draft lead correction can't silently
      // send the link to a stale phone/email.
      customer_phone: currentEstimate.customer_phone || null,
      customer_email: currentEstimate.customer_email || null,
      agent_origin: currentEngine.origin || null,
      lane: currentEngine.lane || null,
      lane_reasons: currentEngine.laneReasons || [],
      editable_here: currentEstimate.status === 'draft'
        && currentEstimate.source === 'estimator_engine'
        && currentEngine.origin === 'manual_agent',
      presentation_template: currentEngine.presentationTemplate || null,
      service_template_keys: currentEngine.serviceTemplateKeys || [],
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
    suggested_prompt: suggestedPrompt(lead, currentEstimate, customerAccount),
  };
}

module.exports = {
  buildAgentEstimateContext,
  _private: { clampText, collectSubmissionText, compactJson, parseJson, suggestedPrompt },
};
