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
const TWILIO_NUMBERS = require('../../config/twilio-numbers');

function last10(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

// First candidate that is a real EXTERNAL number. Forwarded inbound calls can
// carry a Waves/DNI tracking line in from_phone — keying context loads on it
// would feed another customer's SMS thread into the composer (mirrors
// firstExternalPhone in the call processor).
function firstExternalPhone(...candidates) {
  for (const candidate of candidates) {
    const v = candidate && String(candidate).trim();
    if (v && last10(v) && !TWILIO_NUMBERS.isInternalNumber(v)) return v;
  }
  return null;
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
// gets the raw transcript regardless. The processor persists schema_failed
// V2 payloads in ai_extraction_enriched for AUDIT — only status 'valid' may
// drive behavior (same contract as the processor's canonical-write rule).
function extractionFromCall(call) {
  if (call.v2_extraction_status === 'valid') {
    const enriched = parseMaybeJson(call.ai_extraction_enriched);
    if (enriched && typeof enriched === 'object' && enriched.property) {
      return { extraction: enriched, source: 'enriched' };
    }
  }
  const v1 = parseMaybeJson(call.ai_extraction);
  if (v1 && typeof v1 === 'object') return { extraction: v1, source: 'v1' };
  return { extraction: null, source: 'none' };
}

// Shared lines are real (property managers, family numbers): when several
// customer rows match the last-10, prefer the one whose name matches the
// caller established on the call, and mark the match ambiguous otherwise so
// the lane classifier forces a review instead of silently quoting the wrong
// profile's address.
function pickCustomerMatch(rows, extraction) {
  if (!rows.length) return { customer: null, ambiguous: false };
  if (rows.length === 1) return { customer: rows[0], ambiguous: false };
  const callerLast = String(extraction?.caller?.last_name || '').trim().toLowerCase();
  const callerFirst = String(extraction?.caller?.first_name || '').trim().toLowerCase();
  // FULL-name agreement: the last name must match, and when both sides carry
  // a first name it must match too — a same-first-name-different-last-name
  // row on a shared line is a different person, not a confident match.
  const byName = rows.find((r) => {
    const last = String(r.last_name || '').trim().toLowerCase();
    const first = String(r.first_name || '').trim().toLowerCase();
    if (!callerLast || last !== callerLast) return false;
    return !callerFirst || !first || first === callerFirst;
  });
  if (byName) return { customer: byName, ambiguous: false };
  return { customer: rows[0], ambiguous: true };
}

async function loadCustomerByPhone(phone, extraction) {
  const digits = last10(phone);
  if (!digits) return { customer: null, ambiguous: false };
  try {
    const rows = await db('customers')
      .select('id', 'first_name', 'last_name', 'phone', 'email', 'address_line1', 'city', 'state', 'zip',
        'pipeline_stage', 'waveguard_tier', 'member_since', 'lawn_type', 'property_sqft', 'lot_sqft',
        'property_type', 'company_name')
      .whereRaw("regexp_replace(coalesce(phone, ''), '\\D', '', 'g') LIKE ?", [`%${digits}`])
      .whereNull('deleted_at')
      .orderBy('created_at', 'desc')
      .limit(5);
    return pickCustomerMatch(rows, extraction);
  } catch (err) {
    logger.warn(`[estimator-engine] customer load failed: ${err.message}`);
    return { customer: null, ambiguous: false };
  }
}

// Lead for THIS call first (leads created/reused by the processor carry the
// call's twilio_call_sid); the phone fallback is bounded to leads that
// existed by ~the time this call processed — a NEWER unrelated lead on a
// shared/long-lived number must not supply the address or notification link.
async function loadLeadForCall(call, phone, { phoneFallback = true } = {}) {
  const LEAD_COLS = ['id', 'first_name', 'last_name', 'phone', 'email', 'address', 'city', 'zip',
    'service_interest', 'urgency', 'is_commercial', 'status', 'created_at'];
  try {
    if (call?.twilio_call_sid) {
      const byCall = await db('leads')
        .select(LEAD_COLS)
        .where({ twilio_call_sid: call.twilio_call_sid })
        .whereNull('deleted_at')
        .orderBy('created_at', 'desc')
        .first();
      if (byCall) return byCall;
    }
    // On an AMBIGUOUS shared line, a phone-matched lead is as untrusted as
    // the ambiguous profiles — only the sid-matched lead may speak for this
    // call.
    if (!phoneFallback) return null;
    const digits = last10(phone);
    if (!digits) return null;
    let q = db('leads')
      .select(LEAD_COLS)
      .whereRaw("regexp_replace(coalesce(phone, ''), '\\D', '', 'g') LIKE ?", [`%${digits}`])
      .whereNull('deleted_at')
      .orderBy('created_at', 'desc');
    if (call?.created_at) {
      const cutoff = new Date(new Date(call.created_at).getTime() + 2 * 3600 * 1000);
      q = q.where('created_at', '<=', cutoff);
    }
    return await q.first();
  } catch (err) {
    logger.warn(`[estimator-engine] lead load failed: ${err.message}`);
    return null;
  }
}

// Two-way SMS with this caller UP TO the call — service requests arrive
// across channels ("I texted you the photos"), and the thread often carries
// the address or sqft the call lacked. Bounded to the call timestamp so a
// reprocessed old call (or a later text about a different property) can't
// leak post-call messages into the composer's evidence.
async function loadSmsThread(phone, { limit = 20, before = null } = {}) {
  const digits = last10(phone);
  if (!digits) return [];
  try {
    let q = db('sms_log')
      .select('from_phone', 'to_phone', 'message_body', 'created_at')
      .where(function whereEitherDirection() {
        this.whereRaw("regexp_replace(coalesce(from_phone, ''), '\\D', '', 'g') LIKE ?", [`%${digits}`])
          .orWhereRaw("regexp_replace(coalesce(to_phone, ''), '\\D', '', 'g') LIKE ?", [`%${digits}`]);
      })
      .orderBy('created_at', 'desc')
      .limit(limit);
    if (before) q = q.where('created_at', '<=', before);
    const rows = await q;
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
  // On OUTBOUND calls from_phone is the Waves line and the customer is the
  // dialed party; forwarded INBOUND calls can carry a Waves/DNI line in
  // from_phone too — internal numbers never key the context loads (mirrors
  // resolveCallContactPhone in the call processor).
  const outbound = String(call.direction || '').toLowerCase() === 'outbound';
  // v1 extraction stores the caller phone at top-level `phone` (the enriched
  // shape uses caller.phone_e164) — on forwarded-call artifacts where both
  // legs are internal, the extracted number is the only real caller signal.
  const extractedPhone = extraction?.caller?.phone_e164 || extraction?.phone || null;
  const phone = outbound
    ? firstExternalPhone(call.to_phone, extractedPhone, call.from_phone)
    : firstExternalPhone(call.from_phone, extractedPhone, call.to_phone);

  // The processor's own shared-phone/slot/address disambiguation already ran
  // — when it resolved a customer for this call, that beats a phone rematch.
  let customerMatch = { customer: null, ambiguous: false };
  if (call.customer_id) {
    try {
      const resolved = await db('customers')
        .select('id', 'first_name', 'last_name', 'phone', 'email', 'address_line1', 'city', 'state', 'zip',
          'pipeline_stage', 'waveguard_tier', 'member_since', 'lawn_type', 'property_sqft', 'lot_sqft',
          'property_type', 'company_name')
        .where({ id: call.customer_id })
        .whereNull('deleted_at')
        .first();
      if (resolved) customerMatch = { customer: resolved, ambiguous: false };
    } catch (err) {
      logger.warn(`[estimator-engine] resolved-customer load failed: ${err.message}`);
    }
  }

  if (!customerMatch.customer) {
    customerMatch = await loadCustomerByPhone(phone, extraction);
  }
  const customer = customerMatch.customer;

  const [lead, smsThread, priorEstimates] = await Promise.all([
    loadLeadForCall(call, phone, { phoneFallback: !customerMatch.ambiguous }),
    // A shared line with MULTIPLE profiles carries texts about other
    // properties — feeding that history to the composer lets it lift an
    // unrelated address as evidence. Ambiguous match → no SMS context.
    customerMatch.ambiguous ? Promise.resolve([]) : loadSmsThread(phone, { before: call.created_at }),
    loadPriorEstimates(phone),
  ]);

  return {
    call,
    transcript: String(call.transcription),
    extraction,
    extractionSource,
    phone,
    customer: customer || null,
    customerPhoneAmbiguous: customerMatch.ambiguous,
    lead: lead || null,
    smsThread,
    priorEstimates,
    // An AMBIGUOUS shared-phone match must never unlock member pricing
    // (setup-fee waiver, combined-tier discounts) for whoever happens to be
    // rows[0] — ambiguous profiles inform the composer but price as a lead.
    isExistingCustomer: !!(customer
      && !customerMatch.ambiguous
      && ['active_customer', 'won', 'at_risk'].includes(customer.pipeline_stage)),
  };
}

module.exports = {
  buildCallContext,
  existingDraftForCall,
  _private: { extractionFromCall, last10, loadSmsThread, pickCustomerMatch },
};
