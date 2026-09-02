/**
 * Call intelligence — ONE normalized, review-ready view of a processed call.
 *
 * Nothing here is a new source of truth. It reads what the pipeline already
 * persisted on call_log (the V2 extraction, the disposition, the honest
 * processing state, the diarized transcript), the call_commitments rows,
 * the human overrides stamped in metadata, and the later records the call
 * is associated with — and says, for every value, whether it was generated
 * or set by a person. The office reads this instead of the recording.
 */

const { listForCall, refreshFulfillment, buildCallOutcomes, anchorEvidence } = require('./call-commitments');

function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function addressText(addr) {
  if (!addr) return null;
  const parts = [addr.street_line_1, addr.street_line_2, addr.city, addr.state, addr.postal_code].filter(Boolean);
  return parts.length ? parts.join(', ') : (addr.raw_text || null);
}

// Honest processing state, in words an operator can act on.
function describeProcessing(call) {
  const status = call.processing_status || null;
  const timings = parseJson(call.metadata, {})?.processing_timings || null;
  const validationErrors = parseJson(call.ai_extraction_validation_errors, null);
  const heartbeat = call.processing_heartbeat_at ? new Date(call.processing_heartbeat_at) : null;
  const started = call.processing_started_at ? new Date(call.processing_started_at) : null;
  const beatAgeMin = heartbeat ? Math.round((Date.now() - heartbeat.getTime()) / 60000) : null;

  let phase;
  let detail = null;
  let retryable = false;
  const adopted = parseJson(call.metadata, {})?.adopted_recording || null;
  switch (status) {
    case null:
    case 'pending':
      phase = call.recording_url ? 'queued' : 'waiting_for_recording';
      detail = call.recording_url ? 'Recording received; the next sweep will process it.' : 'No recording has arrived for this call yet.';
      if (adopted && call.recording_url) {
        detail = 'An adopted recording is waiting to be processed; the transcript and extraction shown are from the previous recording until it runs.';
      }
      break;
    case 'processing':
      phase = 'processing';
      detail = beatAgeMin == null
        ? 'A pass holds the claim.'
        : beatAgeMin > 10
          ? `A pass claimed this call but its heartbeat stopped ${beatAgeMin} min ago — the sweep will reclaim it.`
          : `A pass is working on it (last heartbeat ${beatAgeMin} min ago).`;
      break;
    case 'processed':
      phase = 'complete';
      break;
    case 'voicemail':
    case 'spam':
      phase = 'complete';
      detail = status === 'spam' ? 'Classified as spam; no lead or customer was created.' : 'Voicemail lane: no live conversation to extract from.';
      break;
    case 'no_transcription':
      phase = 'failed_retrying';
      retryable = true;
      detail = 'Transcription produced nothing; the sweep retries automatically.';
      break;
    case 'extraction_failed':
      phase = Number(call.extraction_attempts || 0) >= 3 ? 'failed' : 'failed_retrying';
      retryable = phase === 'failed_retrying';
      detail = phase === 'failed'
        ? `Extraction failed ${call.extraction_attempts} times; automatic retries are exhausted — Reprocess to try again.`
        : `Extraction failed (attempt ${call.extraction_attempts || 1}); the sweep retries automatically.`;
      break;
    case 'customer_creation_failed':
      phase = 'failed';
      detail = 'The call named a real prospect but the customer record could not be saved — see the review card.';
      break;
    case 'lead_creation_failed':
      phase = 'failed';
      detail = 'The lead this call needed could not be saved — see the review card.';
      break;
    default:
      phase = 'unknown';
      detail = `Unrecognized processing status "${status}".`;
  }
  return {
    status,
    phase,
    detail,
    retryable,
    transcription_status: call.transcription_status || null,
    transcription_provider: call.transcription_provider || null,
    review_status: call.review_status || null,
    v2_extraction_status: call.v2_extraction_status || null,
    extraction_attempts: Number(call.extraction_attempts || 0),
    generation: call.processing_generation == null ? null : Number(call.processing_generation),
    prompt_version: call.ai_extraction_prompt_version || null,
    model: call.ai_extraction_model || null,
    started_at: started ? started.toISOString() : null,
    heartbeat_at: heartbeat ? heartbeat.toISOString() : null,
    timings,
    validation_errors: Array.isArray(validationErrors) ? validationErrors.slice(0, 5) : null,
  };
}

function nextAction({ commitments, disposition, v2, reviewStatus }) {
  const openWaves = commitments
    .filter((c) => c.party === 'waves' && c.status === 'open' && c.human_state !== 'dismissed')
    .sort((a, b) => (a.due_at ? new Date(a.due_at).getTime() : Infinity) - (b.due_at ? new Date(b.due_at).getTime() : Infinity));
  if (openWaves.length) {
    const c = openWaves[0];
    return {
      action: c.description,
      kind: c.kind,
      owner: c.kind === 'technician_follow_up' ? 'technician' : 'office',
      due_at: c.due_at || null,
      due_basis: c.due_basis || (c.due_at ? 'stated' : null),
      commitment_id: c.id,
      basis: c.source === 'human' ? 'office_added' : 'detected_on_call',
    };
  }
  if (reviewStatus === 'open' || reviewStatus === 'in_progress') {
    return { action: 'Clear the review card for this call', kind: 'review', owner: 'office', due_at: null, basis: 'review_open' };
  }
  const recommended = v2?.recommended_disposition || disposition || null;
  const map = {
    estimate_send: 'Send the estimate',
    callback_task_created: 'Call the customer back',
    complaint_escalated: 'Owner follow-up on the complaint',
    cancellation_processed: 'Confirm the cancellation or reschedule was applied',
    lead_response_flow_triggered: 'Watch the lead-response follow-up',
  };
  if (recommended && map[recommended]) {
    return { action: map[recommended], kind: recommended, owner: recommended === 'complaint_escalated' ? 'owner' : 'office', due_at: null, basis: 'disposition' };
  }
  return null;
}

/**
 * Pure. `call` is the call_log row (with customers join fields optional);
 * `commitments` are normalized rows; `outcomes` is buildCallOutcomes' shape.
 */
function buildCallIntelligence({ call, commitments = [], outcomes = null }) {
  const v2 = parseJson(call.ai_extraction_enriched, null);
  const v1 = parseJson(call.ai_extraction, null);
  const meta = parseJson(call.metadata, {}) || {};
  const structured = parseJson(call.transcript_structured, null);
  const segments = Array.isArray(structured?.segments)
    ? structured.segments.map((s, i) => ({
      index: Number.isFinite(Number(s.index)) ? Number(s.index) : i,
      speaker: s.speaker ?? null,
      start_ms: s.start_ms ?? null,
      end_ms: s.end_ms ?? null,
      text: s.text ?? '',
    }))
    : null;
  const sr = v2?.service_request || {};
  const sched = v2?.scheduling || {};
  const sal = v2?.sentiment_and_lead || {};
  const caller = v2?.caller || {};
  const property = v2?.property || {};
  const override = meta.customer_link_override || null;

  const evidence = anchorEvidence(v2?.evidence || [], { segments, transcript: call.transcription || '' });

  const quoteType = (() => {
    if (sr.quoted_price_usd == null) return null;
    if (sr.service_intent === 'recurring_membership_inquiry' || sr.waveguard_tier_mentioned) return 'recurring_plan_price_discussed';
    if (sr.quote_promised) return 'estimate_to_follow';
    return 'price_mentioned_on_call';
  })();

  return {
    call_id: call.id,
    twilio_call_sid: call.twilio_call_sid || null,
    direction: call.direction || null,
    started_at: call.created_at || null,
    duration_seconds: call.duration_seconds ?? null,
    summary: v2?.meta?.call_summary || call.call_summary || v1?.call_summary || null,
    outcome: {
      disposition: call.disposition || null,
      recommended_disposition: v2?.recommended_disposition || null,
      call_nature: v2?.call_nature || null,
      lead_quality: sal.lead_quality || call.lead_quality || null,
      sentiment: sal.sentiment || call.sentiment || null,
      is_voicemail: v2?.meta?.is_voicemail ?? v1?.is_voicemail ?? null,
      is_spam: v2?.meta?.is_spam ?? v1?.is_spam ?? null,
      language: v2?.language || null,
    },
    intent: {
      primary_service_category: sr.primary_service_category || null,
      secondary_categories: Array.isArray(sr.secondary_categories) ? sr.secondary_categories : [],
      specific_service_name: sr.specific_service_name || v1?.matched_service || v1?.requested_service || null,
      service_intent: sr.service_intent || null,
      urgency: sr.urgency || null,
      pests_observed: Array.isArray(sr.pests_observed) ? sr.pests_observed.map((p) => p?.pest_type).filter(Boolean) : [],
    },
    caller: {
      name: caller.name_full || [caller.first_name, caller.last_name].filter(Boolean).join(' ') || [v1?.first_name, v1?.last_name].filter(Boolean).join(' ') || null,
      relationship_to_property: caller.relationship_to_property || null,
      phone_source: caller.phone_source || null,
      preferred_contact_method: caller.preferred_contact_method || null,
      customer_status: v2?.customer_history?.status || null,
      email_captured: !!(caller.email || v1?.email),
    },
    property: {
      address: addressText(property.service_address) || v1?.address_line1 || null,
      property_type: property.property_type || null,
      hoa_community: property.hoa_community_flag ?? null,
      pets_on_property: property.pets_on_property?.present ?? null,
      pet_notes: property.pets_on_property?.species_notes || null,
      additional_properties: Array.isArray(property.additional_properties) ? property.additional_properties.length : 0,
    },
    appointment: {
      status: sched.status || null,
      confirmed_start_at: sched.confirmed_start_at || null,
      agent_committed_booking: sched.agent_committed_booking ?? null,
      requested_range: sched.requested_date_range_start || sched.requested_date_range_end
        ? { start: sched.requested_date_range_start || null, end: sched.requested_date_range_end || null }
        : null,
      preferred_time_of_day: sched.preferred_time_of_day || null,
      notes: sched.scheduling_notes_raw || null,
    },
    prices: {
      quoted_price_usd: sr.quoted_price_usd ?? null,
      quote_type: quoteType,
      quote_requested: sr.quote_requested ?? null,
      quote_promised: sr.quote_promised ?? v1?.quote_promised ?? null,
      waveguard_tier_mentioned: sr.waveguard_tier_mentioned || null,
    },
    objections: Array.isArray(sal.objections_raised) ? sal.objections_raised : [],
    buying_signals: Array.isArray(sal.buying_signals) ? sal.buying_signals : [],
    triage_flags: Array.isArray(v2?.triage_flags) ? v2.triage_flags : [],
    confidence: v2?.confidence || null,
    evidence,
    commitments,
    next_action: nextAction({ commitments, disposition: call.disposition, v2, reviewStatus: call.review_status }),
    outcomes,
    links: {
      customer_id: call.customer_id || null,
      customer_name: [call.first_name, call.last_name].filter(Boolean).join(' ') || null,
      lead_id: meta.lead_id || null,
      customer_link: override
        ? { source: 'human', customer_id: override.customer_id ?? null, by: override.by || null, at: override.at || null, previous_customer_id: override.previous_customer_id ?? null }
        : { source: call.customer_id ? 'generated' : 'none', customer_id: call.customer_id || null },
    },
    recordings: {
      current: call.recording_sid || null,
      duration_seconds: call.recording_duration_seconds ?? null,
      additional: Array.isArray(meta.additional_recordings) ? meta.additional_recordings : [],
      superseded: Array.isArray(meta.superseded_recordings) ? meta.superseded_recordings : [],
    },
    processing: describeProcessing(call),
    transcript_segments: segments,
    schema: {
      extraction_schema_version: v2?.meta?.schema_version || null,
      commitments_extractor_version: commitments.find((c) => c.extractor_version)?.extractor_version || null,
    },
  };
}

// Loader for the admin route: refreshes fulfillment on open AI rows first so
// "was the promise kept" is answered from records, then builds the view.
async function loadCallIntelligence(conn, callId) {
  const call = await conn('call_log')
    .where('call_log.id', callId)
    .leftJoin('customers', 'call_log.customer_id', 'customers.id')
    .select('call_log.*', 'customers.first_name', 'customers.last_name')
    .first();
  if (!call) return null;
  await refreshFulfillment(conn, call.id, call);
  const [commitments, outcomes] = await Promise.all([
    listForCall(conn, call.id),
    buildCallOutcomes(conn, call),
  ]);
  return buildCallIntelligence({ call, commitments, outcomes });
}

module.exports = { buildCallIntelligence, describeProcessing, loadCallIntelligence, nextAction };
