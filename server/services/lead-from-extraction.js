/**
 * createLeadFromExtraction — shared lead writer for AI-captured inbound calls.
 *
 * Used by the bilingual voice-agent webhook (routes/webhooks-voice-agent.js).
 * It mirrors the lead insert / empty-only enrich / ai-triage activity shape of
 * the voicemail pipeline in call-recording-processor.js (processRecording), so
 * an agent-captured lead is indistinguishable from a transcribed-voicemail lead
 * in the Leads UI. Only columns that the voicemail path already writes are
 * touched here (plus preferred_language, added by migration
 * 20260626000000) — no schema guessing.
 *
 * Self-contained on purpose: the voicemail path's customer-creation and lead
 * logic is left byte-for-byte untouched (the #1 requirement is not to
 * destabilize the live call path), so this module re-implements only the small
 * phone-match lookup it needs rather than importing internals. It links an
 * existing customer when one unambiguously matches but never creates a
 * customer — the lead is the capture artifact; conversion stays a human step.
 *
 * Core lead writes PROPAGATE on failure (the caller — the agent webhook —
 * returns 5xx so ElevenLabs retries). Unlike the voicemail path there is no
 * persisted recording/transcript to replay, so a swallowed DB error would
 * silently lose the only copy of the lead. Secondary writes (customer language
 * hint, activity log) stay best-effort.
 */
const db = require('../models/db');
const logger = require('./logger');
const { properCase } = require('../utils/name-case');

const isEmpty = (v) => v === null || v === undefined || v === '';
const phoneDigits = (v) => String(v || '').replace(/\D/g, '');
const nameCase = (v) => (v && String(v).trim() ? properCase(String(v).trim()) : null);

// Mirror call-recording-processor's lead-creation guard: only these lifecycle
// stages may be (re)opened as a lead from a call. Active/won/churned customers
// are NOT reopened as fresh leads from an ordinary support call.
const LEAD_PIPELINE_STAGES = new Set([
  'new_lead', 'contacted', 'qualified', 'estimate_needed', 'estimate_draft',
  'estimate_sent', 'estimate_viewed', 'follow_up', 'negotiating',
]);
const isLeadStage = (stage) => LEAD_PIPELINE_STAGES.has(String(stage || '').toLowerCase());

const normName = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// True only when BOTH a captured first name and the customer's first name are
// present AND they differ — i.e. likely a different person on a shared line, so
// we shouldn't link the call/lead to that customer.
function nameConflicts(extracted, customer) {
  const ex = normName(extracted && extracted.first_name);
  const cust = normName(customer && customer.first_name);
  if (!ex || !cust) return false;
  return ex !== cust;
}

function maskPhone(value) {
  const d = phoneDigits(value);
  return d ? `***${d.slice(-4)}` : 'unknown';
}

function lookupKey(value) {
  const d = phoneDigits(value);
  if (d.length === 11 && d.startsWith('1')) return d.slice(1);
  return d;
}

// Single unambiguous customer match by phone, mirroring the 10-digit RIGHT-match
// used in call-recording-processor + twilio-voice-webhook. Returns null when
// there is no match or more than one (never auto-links an ambiguous number).
async function findCustomerByPhone(phone) {
  const key = lookupKey(phone);
  if (!key) return null;
  const q = db('customers').whereNull('deleted_at');
  if (key.length === 10) {
    q.whereRaw("RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [key]);
  } else {
    q.whereRaw("regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = ?", [key]);
  }
  const matches = await q.orderBy('updated_at', 'desc').limit(2);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    logger.warn(`[voice-agent-lead] ${matches.length} customers share ${maskPhone(phone)}; not auto-linking`);
  }
  return null;
}

// Resolve lead_sources.twilio_phone_number across the hand-entered shapes
// (E.164 / 11-digit / 10-digit / formatted) — mirrors processRecording.
async function resolveLeadSourceId(toPhone) {
  try {
    const digits = phoneDigits(toPhone);
    const ten = digits.length >= 10 ? digits.slice(-10) : null;
    const variants = new Set([toPhone].filter(Boolean));
    if (ten) {
      variants.add(ten);
      variants.add(`1${ten}`);
      variants.add(`+1${ten}`);
      variants.add(`(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`);
    }
    if (variants.size === 0) return null;
    const ls = await db('lead_sources')
      .where('is_active', true)
      .whereIn('twilio_phone_number', [...variants])
      .first();
    return ls ? ls.id : null;
  } catch (e) {
    logger.warn(`[voice-agent-lead] lead_source lookup failed: ${e.message}`);
    return null;
  }
}

/**
 * @param {object} extracted  agent-captured fields:
 *   { first_name, last_name, email, address_line1, city, zip,
 *     requested_service|matched_service, preferred_date_time, pain_points,
 *     call_summary, lead_quality ('hot'|'warm'|'cold') }
 * @param {object} opts { phone, toPhone, callSid, language, callDurationSeconds }
 * @returns {Promise<{ leadId: string|null, customerId: string|null, created: boolean }>}
 */
async function createLeadFromExtraction(extracted = {}, opts = {}) {
  const phone = opts.phone || extracted.phone || null;
  const language = opts.language ? String(opts.language).toLowerCase().slice(0, 8) : null;
  const service = extracted.matched_service || extracted.requested_service || null;

  let customerId = null;
  let leadId = null;
  let created = false;

  let customer = await findCustomerByPhone(phone);
  // Name-aware guard: on a shared line the phone-only match can resolve the
  // wrong household member. If the agent captured a name that conflicts with the
  // matched customer's, don't link (treat as a new, unlinked caller) rather than
  // attach the call + language hint to the wrong customer.
  if (customer && nameConflicts(extracted, customer)) {
    logger.info(`[voice-agent-lead] Captured name conflicts with customer on ${maskPhone(phone)}; not linking`);
    customer = null;
  }
  customerId = customer?.id || null;

  // Non-routing language hint on the matched customer — applied even if the lead
  // is skipped below. Best-effort; only fills when empty so a prior preference
  // is never clobbered. (Routing never reads this column.)
  if (language && customerId) {
    await db('customers')
      .where({ id: customerId })
      .whereRaw("COALESCE(preferred_language, '') = ''")
      .update({ preferred_language: language })
      .catch((e) => logger.warn(`[voice-agent-lead] customer language hint failed (non-blocking): ${e.message}`));
  }

  // Guard FIRST (mirror the voicemail processor): a matched lifecycle customer
  // that isn't in a lead stage gets NO lead work — even if a historical/
  // converted lead exists for this phone (so an ordinary support call can't
  // overwrite a won lead). Brand-new callers (no match) and lead-stage customers
  // proceed below.
  if (customer && !isLeadStage(customer.pipeline_stage)) {
    logger.info(`[voice-agent-lead] Skipping lead for ${maskPhone(phone)} — existing ${customer.pipeline_stage || 'lifecycle'} customer`);
    return { leadId: null, customerId, created: false };
  }

  const existingLead = phone
    ? await db('leads').where('phone', phone).orderBy('created_at', 'desc').first()
    : null;

  if (existingLead) {
    leadId = existingLead.id;
  } else {
    const leadSourceId = await resolveLeadSourceId(opts.toPhone);
    const insert = {
      lead_source_id: leadSourceId,
      customer_id: customerId,
      phone,
      first_name: nameCase(extracted.first_name),
      last_name: nameCase(extracted.last_name) || '',
      email: extracted.email || null,
      lead_type: 'inbound_call',
      first_contact_at: new Date(),
      first_contact_channel: 'call',
      status: 'new',
    };
    if (opts.callSid) insert.twilio_call_sid = opts.callSid;
    if (opts.callDurationSeconds != null) insert.call_duration_seconds = opts.callDurationSeconds;
    const [newLead] = await db('leads').insert(insert).returning('*');
    leadId = newLead.id;
    created = true;
    // Log IDs/masked phone only — `service` is caller-provided free text and
    // can contain names/addresses; it belongs in the row, not plain logs.
    logger.info(`[voice-agent-lead] Created lead ${leadId} for ${maskPhone(phone)}`);
  }

  if (leadId) {
    const current = existingLead || (await db('leads').where({ id: leadId }).first());
    const leadUpdates = {};
    if (extracted.first_name && isEmpty(current?.first_name)) leadUpdates.first_name = nameCase(extracted.first_name);
    if (extracted.last_name && isEmpty(current?.last_name)) leadUpdates.last_name = nameCase(extracted.last_name);
    if (extracted.email && isEmpty(current?.email)) leadUpdates.email = extracted.email;
    if (extracted.address_line1 && isEmpty(current?.address)) leadUpdates.address = extracted.address_line1;
    if (extracted.city && isEmpty(current?.city)) leadUpdates.city = extracted.city;
    if (extracted.zip && isEmpty(current?.zip)) leadUpdates.zip = extracted.zip;
    if (service && isEmpty(current?.service_interest)) leadUpdates.service_interest = service;

    // Urgency: upgrade-only (mirror voicemail path) — hot promotes to urgent,
    // otherwise only fill if still empty so a cold follow-up never downgrades.
    if (extracted.lead_quality === 'hot') leadUpdates.urgency = 'urgent';
    else if (extracted.lead_quality && isEmpty(current?.urgency)) leadUpdates.urgency = 'normal';

    if (extracted.call_summary) leadUpdates.transcript_summary = extracted.call_summary;
    leadUpdates.extracted_data = JSON.stringify({
      pain_points: extracted.pain_points,
      preferred_date_time: extracted.preferred_date_time,
      source: 'voice_agent',
      language,
    });
    // Only touch is_qualified when the agent sent a recognized quality, so a
    // later quality-less payload can't demote a previously qualified lead.
    if (extracted.lead_quality) leadUpdates.is_qualified = ['hot', 'warm'].includes(extracted.lead_quality);
    if (language) leadUpdates.preferred_language = language;
    // Only (re)link a customer when one was unambiguously resolved — never
    // null out an existing lead's customer_id on a no-match/ambiguous lookup.
    if (customerId) leadUpdates.customer_id = customerId;
    leadUpdates.updated_at = new Date();
    await db('leads').where({ id: leadId }).update(leadUpdates);

    await db('lead_activities').insert({
      lead_id: leadId,
      activity_type: 'ai_triage',
      description: `AI voice agent captured: ${service || 'general inquiry'}${language === 'es' ? ' (Spanish)' : ''}, quality: ${extracted.lead_quality || 'unknown'}`,
      performed_by: 'AI Voice Agent',
      metadata: JSON.stringify({
        call_summary: extracted.call_summary,
        pain_points: extracted.pain_points,
        language,
        source: 'voice_agent',
      }),
    }).catch((e) => logger.warn(`[voice-agent-lead] activity log failed (non-blocking): ${e.message}`));
  }

  return { leadId, customerId, created };
}

module.exports = { createLeadFromExtraction, findCustomerByPhone, resolveLeadSourceId };
