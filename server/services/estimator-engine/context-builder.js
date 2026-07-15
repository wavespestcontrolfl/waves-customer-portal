/**
 * Estimator Engine — call context assembly.
 *
 * Gathers everything the composer + arbitration need for one call: the raw
 * transcript, the enriched extraction (NEVER the v1 extraction alone — v1
 * invalid-JSON failures are a known live failure mode while the enriched
 * pass parses fine), the caller's SMS thread, any matching lead/customer
 * profile, and their prior estimates. Every sub-load is fail-open: a missing
 * signal narrows the draft (or drops it to yellow/red) — it never throws out
 * of the engine.
 */

const db = require('../../models/db');
const logger = require('../logger');

function last10(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function parseMaybeJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// Enriched extraction first (schema-versioned, validated); the raw v1 text
// blob only as a fallback parse. Either may be null — the composer always
// gets the raw transcript regardless.
function extractionFromCall(call) {
  const enriched = parseMaybeJson(call.ai_extraction_enriched);
  if (enriched && typeof enriched === 'object' && enriched.property) {
    return { extraction: enriched, source: 'enriched' };
  }
  const v1 = parseMaybeJson(call.ai_extraction);
  if (v1 && typeof v1 === 'object') return { extraction: v1, source: 'v1' };
  return { extraction: null, source: 'none' };
}

async function loadCustomerByPhone(phone) {
  const digits = last10(phone);
  if (!digits) return null;
  try {
    return await db('customers')
      .select('id', 'first_name', 'last_name', 'phone', 'email', 'address_line1', 'city', 'state', 'zip',
        'pipeline_stage', 'waveguard_tier', 'member_since', 'lawn_type', 'property_sqft', 'lot_sqft',
        'property_type', 'company_name')
      .whereRaw("regexp_replace(coalesce(phone, ''), '\\D', '', 'g') LIKE ?", [`%${digits}`])
      .orderBy('created_at', 'desc')
      .first();
  } catch (err) {
    logger.warn(`[estimator-engine] customer load failed: ${err.message}`);
    return null;
  }
}

async function loadLeadByPhone(phone) {
  const digits = last10(phone);
  if (!digits) return null;
  try {
    return await db('leads')
      .select('id', 'first_name', 'last_name', 'phone', 'email', 'address', 'city', 'zip',
        'service_interest', 'urgency', 'is_commercial', 'status', 'created_at')
      .whereRaw("regexp_replace(coalesce(phone, ''), '\\D', '', 'g') LIKE ?", [`%${digits}`])
      .whereNull('deleted_at')
      .orderBy('created_at', 'desc')
      .first();
  } catch (err) {
    logger.warn(`[estimator-engine] lead load failed: ${err.message}`);
    return null;
  }
}

// Recent two-way SMS with this caller — service requests arrive across
// channels ("I texted you the photos"), and the thread often carries the
// address or sqft the call lacked.
async function loadSmsThread(phone, { limit = 20 } = {}) {
  const digits = last10(phone);
  if (!digits) return [];
  try {
    const rows = await db('sms_log')
      .select('from_phone', 'to_phone', 'message_body', 'created_at')
      .where(function whereEitherDirection() {
        this.whereRaw("regexp_replace(coalesce(from_phone, ''), '\\D', '', 'g') LIKE ?", [`%${digits}`])
          .orWhereRaw("regexp_replace(coalesce(to_phone, ''), '\\D', '', 'g') LIKE ?", [`%${digits}`]);
      })
      .orderBy('created_at', 'desc')
      .limit(limit);
    return rows.reverse().map((r) => ({
      direction: last10(r.from_phone) === digits ? 'inbound' : 'outbound',
      body: String(r.message_body || '').slice(0, 500),
      at: r.created_at,
    }));
  } catch (err) {
    logger.warn(`[estimator-engine] sms thread load failed: ${err.message}`);
    return [];
  }
}

async function loadPriorEstimates(phone, { limit = 5 } = {}) {
  const digits = last10(phone);
  if (!digits) return [];
  try {
    return await db('estimates')
      .select('id', 'status', 'source', 'category', 'service_interest', 'monthly_total',
        'annual_total', 'onetime_total', 'created_at', 'sent_at')
      .whereRaw("regexp_replace(coalesce(customer_phone, ''), '\\D', '', 'g') LIKE ?", [`%${digits}`])
      .orderBy('created_at', 'desc')
      .limit(limit);
  } catch (err) {
    logger.warn(`[estimator-engine] prior estimates load failed: ${err.message}`);
    return [];
  }
}

// An open automated draft for this exact call means a retried processing run
// — never draft twice off one call.
async function existingDraftForCall(callLogId) {
  try {
    return await db('estimates')
      .whereRaw("estimate_data->'estimatorEngine'->>'callLogId' = ?", [String(callLogId)])
      .first();
  } catch (err) {
    logger.warn(`[estimator-engine] existing-draft check failed: ${err.message}`);
    return null;
  }
}

async function buildCallContext(callLogId) {
  const call = await db('call_log').where({ id: callLogId }).first();
  if (!call) return { error: 'call_not_found' };
  if (!call.transcription || String(call.transcription).trim().length < 40) {
    return { error: 'no_usable_transcript', call };
  }

  const { extraction, source: extractionSource } = extractionFromCall(call);
  const phone = call.from_phone || extraction?.caller?.phone_e164 || null;

  const [customer, lead, smsThread, priorEstimates] = await Promise.all([
    loadCustomerByPhone(phone),
    loadLeadByPhone(phone),
    loadSmsThread(phone),
    loadPriorEstimates(phone),
  ]);

  return {
    call,
    transcript: String(call.transcription),
    extraction,
    extractionSource,
    phone,
    customer: customer || null,
    lead: lead || null,
    smsThread,
    priorEstimates,
    isExistingCustomer: !!(customer && ['active_customer', 'won', 'at_risk'].includes(customer.pipeline_stage)),
  };
}

module.exports = {
  buildCallContext,
  existingDraftForCall,
  _private: { extractionFromCall, last10, loadSmsThread },
};
