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
const { firstExternalPhone, last10 } = require('../external-phone');

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
  // MULTIPLE rows matching the same full name (one customer, several
  // properties) are still ambiguous — picking the newest would green-draft
  // the wrong property.
  const byName = rows.filter((r) => {
    const last = String(r.last_name || '').trim().toLowerCase();
    const first = String(r.first_name || '').trim().toLowerCase();
    if (!callerLast || last !== callerLast) return false;
    return !callerFirst || !first || first === callerFirst;
  });
  if (byName.length === 1) return { customer: byName[0], ambiguous: false };
  return { customer: byName[0] || rows[0], ambiguous: true };
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
    // A failed query is NOT a no-match — an existing member could be hiding
    // behind the error, so callers that gate member pricing on this result
    // must be able to fail closed instead of quoting them as a new prospect.
    return { customer: null, ambiguous: false, unavailable: true };
  }
}

// Lead for THIS call first (leads created/reused by the processor carry the
// call's twilio_call_sid); the phone fallback is bounded to leads that
// existed by ~the time this call processed — a NEWER unrelated lead on a
// shared/long-lived number must not supply the address or notification link.
async function loadLeadForCall(call, phone, { phoneFallback = true } = {}) {
  const LEAD_COLS = ['id', 'first_name', 'last_name', 'phone', 'email', 'address', 'city', 'zip',
    'service_interest', 'urgency', 'is_commercial', 'status', 'created_at', 'updated_at'];
  try {
    if (call?.twilio_call_sid) {
      const byCall = await db('leads')
        .select(LEAD_COLS)
        .where({ twilio_call_sid: call.twilio_call_sid })
        .whereNull('deleted_at')
        .orderBy('created_at', 'desc')
        .first();
      if (byCall) return { lead: byCall, forThisCall: true };
    }
    const digits = last10(phone);
    if (!digits) return { lead: null, forThisCall: false };
    // A REUSED open lead (the processor updates it without restamping
    // twilio_call_sid) is THIS call's lead: it was touched at/after the call
    // started. It outranks any newer-by-created_at stale/foreign lead on the
    // same last-10 — and on an AMBIGUOUS shared line it is the ONLY
    // phone-matched lead trusted at all. BOUNDED at the call's processing
    // window: on a retried/backfilled old call, an open-ended >= start would
    // claim any lead touched in the days since — a later unrelated
    // interaction's lead would get current-call priority AND be mutated via
    // leads.estimate_id. Outside the window the lead falls to the byPhone
    // path (forThisCall=false), which is the conservative direction;
    // processor-CREATED leads are sid-stamped and already claimed above.
    if (call?.created_at) {
      const processedBy = new Date(new Date(call.created_at).getTime() + 2 * 3600 * 1000);
      const reused = await db('leads')
        .select(LEAD_COLS)
        .whereRaw("regexp_replace(coalesce(phone, ''), '\\D', '', 'g') LIKE ?", [`%${digits}`])
        .whereNull('deleted_at')
        .where('updated_at', '>=', call.created_at)
        .where('updated_at', '<=', processedBy)
        .orderBy('updated_at', 'desc')
        .first();
      if (reused) return { lead: reused, forThisCall: true };
    }
    if (!phoneFallback) return { lead: null, forThisCall: false };
    let q = db('leads')
      .select(LEAD_COLS)
      .whereRaw("regexp_replace(coalesce(phone, ''), '\\D', '', 'g') LIKE ?", [`%${digits}`])
      .whereNull('deleted_at')
      .orderBy('created_at', 'desc');
    if (call?.created_at) {
      const cutoff = new Date(new Date(call.created_at).getTime() + 2 * 3600 * 1000);
      q = q.where('created_at', '<=', cutoff);
    }
    const byPhone = await q.first();
    // Touched-since-call leads were already claimed above — anything left is
    // prior phone history.
    return { lead: byPhone || null, forThisCall: false };
  } catch (err) {
    logger.warn(`[estimator-engine] lead load failed: ${err.message}`);
    return { lead: null, forThisCall: false };
  }
}

// Two-way SMS with this caller UP TO THE END of the call — service requests
// arrive across channels ("I texted you the photos"), and the thread often
// carries the address or sqft the call lacked. Bounded to the call's end so
// a reprocessed old call (or a later text about a different property) can't
// leak post-call messages into the composer's evidence.
async function loadSmsThread(phone, { limit = 20, before = null, since = null } = {}) {
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
    // Lookback floor: with only an upper bound, a light texter's "latest 20"
    // reaches months into the past and stale texts about another property
    // get labeled as this call's RECENT SMS THREAD for the composer.
    if (since) q = q.where('created_at', '>=', since);
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

  // Bound the SMS thread at the call's END, not its start — call_log rows
  // are created when the inbound call first rings, so a start bound would
  // exclude exactly the during-call texts ("just texted you the address")
  // this loader exists to capture. Unknown duration degrades to the start
  // bound; a reprocessed old call still can't leak later messages.
  const callDurationSeconds = Number(
    call.recording_duration_seconds || call.duration_seconds || call.duration || 0
  ) || 0;
  const callEndsAt = new Date(new Date(call.created_at).getTime() + callDurationSeconds * 1000);
  // 30-day lookback floor relative to THIS call — see loadSmsThread.
  const smsSince = new Date(new Date(call.created_at).getTime() - 30 * 86400000);

  const [leadMatch, smsThread, priorEstimates] = await Promise.all([
    loadLeadForCall(call, phone, { phoneFallback: !customerMatch.ambiguous }),
    // A shared line with MULTIPLE profiles carries texts, estimates, and
    // leads for other people/properties — none of that history may steer
    // the composer on an ambiguous match.
    customerMatch.ambiguous ? Promise.resolve([]) : loadSmsThread(phone, { before: callEndsAt, since: smsSince }),
    customerMatch.ambiguous ? Promise.resolve([]) : loadPriorEstimates(phone),
  ]);
  const lead = leadMatch.lead;

  return {
    call,
    transcript: String(call.transcription),
    extraction,
    extractionSource,
    phone,
    customer: customer || null,
    customerPhoneAmbiguous: customerMatch.ambiguous,
    lead: lead || null,
    // Distinguishes THIS call's lead (sid-matched or touched by this call's
    // processing) from prior phone history — the current lead's address
    // outranks the saved profile for second-property quotes.
    leadIsForThisCall: leadMatch.forThisCall,
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

// SMS-origin context: the thread IS the conversation, so it becomes the
// transcript (and smsThread stays empty — duplicating it would double-weight
// the same evidence in the composer prompt). Ambiguous shared-phone lines
// error out entirely: unlike a call, there is no independent transcript —
// the thread history itself cannot be attributed to one profile, and no
// caller-name extraction exists to disambiguate.
async function buildSmsThreadContext({ phone, triggerAt = new Date() }) {
  if (!last10(phone)) return { error: 'no_usable_phone' };
  const customerMatch = await loadCustomerByPhone(phone, null);
  if (customerMatch.ambiguous) return { error: 'ambiguous_phone' };
  const customer = customerMatch.customer;
  const before = new Date(triggerAt);
  const smsSince = new Date(before.getTime() - 30 * 86400000);
  const [leadMatch, smsThread, priorEstimates] = await Promise.all([
    // call=null: skips the sid + reused-lead branches; pure phone fallback.
    loadLeadForCall(null, phone, { phoneFallback: true }),
    loadSmsThread(phone, { limit: 40, before, since: smsSince }),
    loadPriorEstimates(phone),
  ]);
  const transcript = smsThread
    .map((m) => `[${m.direction === 'inbound' ? 'Customer' : 'Waves'}] ${m.body}`)
    .join('\n');
  if (transcript.trim().length < 40) return { error: 'no_usable_thread' };
  return {
    call: null,
    transcript,
    extraction: null,
    // 'none' keeps the lane classifier's non-enriched flag — an SMS draft
    // can never land green, which is the right floor for text-only evidence.
    extractionSource: 'none',
    phone,
    customer: customer || null,
    customerPhoneAmbiguous: false,
    lead: leadMatch.lead || null,
    leadIsForThisCall: false,
    smsThread: [],
    priorEstimates,
    isExistingCustomer: !!(customer
      && ['active_customer', 'won', 'at_risk'].includes(customer.pipeline_stage)),
  };
}

module.exports = {
  buildCallContext,
  buildSmsThreadContext,
  existingDraftForCall,
  // Origin-specific context builders reuse these reads so call, web-lead,
  // and SMS sessions all resolve contacts/history with the same shared-line
  // safeguards. They are reads only; callers still own temporal bounds.
  loadCustomerByPhone,
  loadPriorEstimates,
  loadSmsThread,
  _private: {
    extractionFromCall,
    firstExternalPhone,
    last10,
    loadLeadForCall,
    pickCustomerMatch,
  },
};
