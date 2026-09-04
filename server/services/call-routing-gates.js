const crypto = require('crypto');

function computeAppointmentIdempotencyKey({
  callLogId,
  schedulingStatus,
  confirmedStartAt,
  primaryServiceCategory,
  addressHash,
}) {
  const parts = [
    'call-pipeline-v2',
    callLogId || 'unknown',
    schedulingStatus || 'unknown',
    confirmedStartAt || 'no-confirmed-start',
    primaryServiceCategory || 'unknown-service',
    addressHash || 'unknown-address',
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 64);
}

function computeAddressHash(serviceAddress) {
  if (!serviceAddress) return null;
  const parts = [
    (serviceAddress.street_line_1 || '').toLowerCase().trim(),
    (serviceAddress.city || '').toLowerCase().trim(),
    (serviceAddress.postal_code || '').trim(),
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

// opts.impliedConsent (gated, INBOUND calls only): a customer who called US,
// requested service, and agreed to a time has an established business
// relationship and implied consent for a TRANSACTIONAL confirmation (not
// marketing). A do-not-contact request always overrides. Owner directive
// 2026-07-10: don't hold an inbound booker's confirmation over a missing
// explicit "yes you can text me."
function checkTcpaConsent(extraction, opts = {}) {
  if (!extraction || !extraction.consent) {
    return opts.impliedConsent
      ? { canSms: true, canEmail: true, reason: 'implied_consent_inbound' }
      : { canSms: false, canEmail: true, reason: 'no_consent_data' };
  }

  const consent = extraction.consent;

  if (consent.do_not_contact_request === true) {
    return { canSms: false, canEmail: false, reason: 'do_not_contact_requested' };
  }

  if (consent.sms_consent_given === true) {
    return { canSms: true, canEmail: true, reason: 'sms_consent_given' };
  }

  if (opts.impliedConsent) {
    return { canSms: true, canEmail: true, reason: 'implied_consent_inbound' };
  }

  return { canSms: false, canEmail: true, reason: 'sms_consent_not_given' };
}

// v2-1.1.0: agent-commitment authorization (gated demotion of
// caller_not_authorized) changed what canAutoRoute can decide — the
// route_decisions migration contract requires a version bump so reprocessing
// a call writes a NEW decision row instead of being onConflict-ignored into
// the stale pre-rule one. EVERY consumer must use these constants: the
// producer and same-run outcome update take V2_DECISION_VERSION (they own
// only rows this code writes); history-spanning readers (admin review
// queues) take V2_DECISION_VERSIONS so pre-bump rows stay visible.
// v2-1.2.0: unknown-relationship callers no longer hard-block on
// caller_not_authorized, and an AV-localized in-area premise no longer
// hard-blocks a confirmed booking on address_unverified (owner ruling
// 2026-07-31) — both change what canAutoRoute can decide, so reprocessing
// must write a new decision row instead of onConflict-ignoring into the
// pre-rule one.
// v2-1.3.0: street recovery now REFUSES a PREMISE verdict whose only missing
// component is the subpremise (a resolved building given without its unit —
// address-validation/recovery.js `avMissingUnitOnly`). Such a call previously
// could recover into an accepted verdict and auto-route; it now keeps its
// address hold and lands in review. That changes what canAutoRoute can
// decide, and the producer inserts with onConflict-ignore, so without a bump
// a force-reprocess would keep the stale auto_route recommendation while the
// fresh run holds the call — corrupting the promotion metrics and any
// feedback tied to that decision row.
const V2_DECISION_VERSION = 'v2-1.3.0';
const V2_DECISION_VERSIONS = ['v2-1.0.0', 'v2-1.1.0', 'v2-1.2.0', 'v2-1.3.0'];

function buildRouteDecision({
  callLogId,
  extraction,
  finalTriageFlags,
  routingResult,
  action,
  mode = 'enforce',
  recordingSid = null,
}) {
  const scheduling = extraction?.scheduling || {};
  const confidence = extraction?.confidence || {};

  return {
    call_log_id: callLogId,
    decision_version: V2_DECISION_VERSION,
    mode,
    // The recording this decision was derived from is part of the audit
    // key: a replaced recording's pass writes its OWN row instead of
    // colliding with (and then updating) the discarded audio's decision.
    recording_sid: recordingSid || '',
    validator_recommendation: routingResult?.allowed
      ? (scheduling.status === 'confirmed' ? 'auto_create_appointment' : 'upsert_customer_only')
      : 'needs_review',
    final_action_taken: action,
    // Only ACTUAL vetoes reach the audit record (codex round-5 P2 +
    // round-7 P2). Two failure modes to avoid:
    //   - the central gates return reasons that are not triage flags
    //     (address_not_validated / off_hour_start) — the reason itself is
    //     the veto and must lead;
    //   - a call held on a hard flag can simultaneously carry ADVISORY
    //     flags (prior_complaint_unresolved, competing_quotes_active, an
    //     unknown model flag). finalTriageFlags contains those too, so
    //     serializing it recorded advisories as vetoes and the AI feedback
    //     aggregation counted them as such. The triage_flags path uses
    //     routingResult.appointmentBlockingFlags — exactly the flags that
    //     blocked. Central-gate and scheduling returns carry no blocking
    //     flags by construction (the flag stage passed), so they fall back
    //     to [] — never to finalTriageFlags.
    blocked_reasons: JSON.stringify(
      routingResult?.allowed
        ? []
        : [
          ...(routingResult?.reason && routingResult.reason !== 'triage_flags' ? [routingResult.reason] : []),
          // Fallback when appointmentBlockingFlags is absent: a named
          // NON-flag reason (central gates, low_confidence, scheduling)
          // means the flag stage passed — record nothing extra. No reason
          // at all is the legacy shape some callers/tests still produce —
          // keep its historical finalTriageFlags behavior.
          ...(routingResult?.appointmentBlockingFlags
            ?? (routingResult?.reason && routingResult.reason !== 'triage_flags' ? [] : finalTriageFlags)),
        ],
    ),
    allowed_reasons: JSON.stringify(routingResult?.allowed ? ['all_gates_passed'] : []),
    ai_validation_model: extraction?.meta?.extraction_model || null,
    ai_validation_prompt_version: extraction?.meta?.extraction_prompt_version || null,
    ai_validation_schema_version: extraction?.meta?.schema_version || null,
    created_at: new Date(),
  };
}

// The filing-time snapshot of WHAT and WHERE the caller asked for — the
// evidence sweep matches later bookings (scheduling_window) and delivered
// estimates (quote_scope) against THIS, never the call's rolling
// ai_extraction_enriched: a force-reprocess overwrites that while the open
// card keeps its original ask.
function askSnapshot(extraction) {
  const request = extraction?.service_request || {};
  const address = extraction?.property?.service_address || {};
  const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const list = (v) => (Array.isArray(v) ? v : []);
  return {
    // The requested categories (primary + secondaries), the specific
    // catalog service the caller named (a coarse category — pest_general
    // for a flea treatment — is not the ask, and a generic booking in that
    // category must not answer it), and the cadence asked for (a recurring-
    // plan inquiry and a one-time request both reduce to the same category,
    // and a one-time booking must never answer the plan ask).
    requested_service_categories: [request.primary_service_category, ...list(request.secondary_categories)].filter((c) => text(c)),
    requested_specific_service: text(request.specific_service_name),
    requested_service_intent: text(request.service_intent),
    // WHERE the caller asked for service: the sweep's same-customer booking
    // arm applies only when the ask named no address or exactly the on-file
    // one.
    requested_address: {
      street_line_1: address.street_line_1 ?? null,
      street_line_2: address.street_line_2 ?? null,
      city: address.city ?? null,
      postal_code: address.postal_code ?? null,
      raw_text: address.raw_text ?? null,
      // The OTHER properties the call named: how many, and each one with a
      // street as the sweep's readings — a two-property ask is judged
      // property by property, and a named property the snapshot cannot
      // read fails closed (codex r24 P2).
      additional_properties: list(extraction?.property?.additional_properties).length,
      additional: list(extraction?.property?.additional_properties)
        .filter((p) => p && typeof p === 'object' && text(p.street_line_1))
        .map((p) => ({ street_line_1: text(p.street_line_1), street_line_2: p.street_line_2 ?? null, city: p.city ?? null, postal_code: p.postal_code ?? null, raw_text: p.raw_text ?? null })),
    },
  };
}

// The on-file address a card snapshots (see buildTriageItem.onFileAddress):
// the customers columns by name, or null without a street.
function onFileAddressSnapshot(a) {
  const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  if (!a || typeof a !== 'object' || !text(a.address_line1)) return null;
  return { address_line1: text(a.address_line1), address_line2: text(a.address_line2), city: text(a.city), zip: text(a.zip) };
}

// secondary_contact_captured items are only useful if the row carries the
// contact to confirm. Several sites insert this flag (the enforce-mode
// deterministic-flags loop first, the processor's payload-rich insert
// second) and the open-row unique index makes the FIRST insert win — so
// attach the extraction's own secondary_contact here, where every insert
// site flows through, instead of relying on the caller to pass it.
function secondaryContactPayload(extraction) {
  if (!extraction?.secondary_contact) return {};
  return {
    secondary_contact: extraction.secondary_contact,
    // Full multi-party list (1.4.0) so the card shows EVERY named party.
    ...(Array.isArray(extraction?.secondary_contacts) && extraction.secondary_contacts.length > 1
      ? { secondary_contacts: extraction.secondary_contacts }
      : {}),
    // 4th+ parties exist beyond the array — cue the office to re-listen.
    ...(extraction?.other_parties_mentioned === true ? { other_parties_mentioned: true } : {}),
  };
}

// Scheduling-shaped cards carry the model's captured window fields so the
// office can book "Tuesday, first slot" from the card instead of re-listening
// to the recording — plus the filing-time service snapshot, so the
// evidence sweep matches later bookings (scheduling_window) and delivered
// quotes against what THIS call asked for, never the rolling extraction.
function schedulingWindowSnapshot(extraction) {
  const s = extraction.scheduling;
  return {
    status: s.status ?? null,
    confirmed_start_at: s.confirmed_start_at ?? null,
    requested_date_range_start: s.requested_date_range_start ?? null,
    requested_date_range_end: s.requested_date_range_end ?? null,
    preferred_time_of_day: s.preferred_time_of_day ?? null,
    // Days the caller EXCLUDED from the requested range ("Tuesday to
    // Thursday, not Wednesday"): a booking on one does not answer the ask
    // (codex r16 P1).
    blackout_dates: Array.isArray(s.blackout_dates) ? s.blackout_dates.filter((d) => typeof d === 'string' && d.trim()) : [],
    callback_window_start: s.callback_window_start ?? null,
    callback_window_end: s.callback_window_end ?? null,
    scheduling_notes_raw: s.scheduling_notes_raw ?? null,
    ...askSnapshot(extraction),
  };
}
const SCHEDULING_PAYLOAD_FLAGS = new Set([
  'not_confirmed', 'confirmed_without_start_time', 'ambiguous_scheduling',
  'reschedule_or_cancel', 'cancellation_request',
  'existing_appointment_coordination', 'auto_booking_skipped_after_approval',
  // The off-hour card's whole job is to show the agreed time so the office
  // can place it on an hour boundary — it needs the scheduling payload.
  'off_hour_start',
  // The authorization card keeps its filing-time scheduling status: the
  // evidence sweep must never clear it while the call's CONFIRMED
  // appointment is still unbooked, and a reprocess can rewrite the
  // rolling extraction's status underneath the open card.
  'caller_not_authorized',
  // Address-review cards too: when a confirmed call is held solely on its
  // address card, the sweep's completed-visit rule must keep the card
  // until a booking answers the snapshotted ask.
  'missing_service_address', 'low_confidence_address', 'address_unverifiable',
  'address_unverified', 'address_validation_unavailable',
  'address_not_validated',
]);

// Address-review cards carry the address the call NAMED, snapshotted at
// filing: the evidence sweep proves "a visit completed at the address this
// call named" against THIS, never the call's rolling extraction columns
// (a force-reprocess rewrites those while the open card keeps its ask).
const ADDRESS_SNAPSHOT_FLAGS = new Set([
  'missing_service_address', 'low_confidence_address', 'address_unverifiable',
  'address_unverified', 'address_validation_unavailable',
  'address_not_validated',
]);
function heardAddressSnapshot(extraction) {
  const sa = extraction?.property?.service_address || {};
  return { street_line_1: sa.street_line_1 ?? null, street_line_2: sa.street_line_2 ?? null, city: sa.city ?? null, postal_code: sa.postal_code ?? null, raw_text: sa.raw_text ?? null };
}

// "Ask which unit" is useless without saying which building — and the
// enforce lane files this card through the generic deterministic-flags
// loop, which passes no extraPayload. Same argument as the secondary
// contact above: attach it HERE, where every insert site flows through
// (the open-row unique index makes the first insert win). The shadow
// bridge passes its own extraPayload to override this with the LEGACY V1
// address, which is what the record holds in that mode.
// Prefer GOOGLE's resolved building over the extraction's. A verdict can
// carry `hasReplaced` (a corrected street or ZIP) alongside the missing
// subpremise, and deriveStatus returns `ambiguous` for it — so nothing
// downstream adopts the correction, and stamping the extraction would
// print the misheard street on a card whose entire job is to say WHICH
// building needs a unit (codex r17 P2). The normalized form is the
// building Google actually resolved.
function unitAskBuilding(extraction, addressValidation) {
  const sa = extraction?.property?.service_address || {};
  const n = addressValidation?.normalized || {};
  return {
    street_line_1: n.street_line_1 || sa.street_line_1 || null,
    city: n.city || sa.city || null,
    postal_code: n.postal_code || sa.postal_code || sa.zip || null,
  };
}

// Flag → the payload it carries, ONE table (codex r29 P2): every stamp
// whose flag set contains the card's flag is merged into the payload, in
// this order. Adding a card type is a row here, not a branch in the
// constructor.
const FLAG_PAYLOAD_STAMPS = [
  { flags: new Set(['secondary_contact_captured']), stamp: ({ extraction }) => secondaryContactPayload(extraction) },
  // Multi-property cards previously carried no addresses — the one surface
  // built to tell the office "there's a second property" required transcript
  // archaeology to learn WHICH property.
  { flags: new Set(['multi_property_call']),
    stamp: ({ extraction }) => (Array.isArray(extraction?.property?.additional_properties) && extraction.property.additional_properties.length
      ? { additional_properties: extraction.property.additional_properties } : {}) },
  { flags: SCHEDULING_PAYLOAD_FLAGS, stamp: ({ extraction }) => (extraction?.scheduling ? { scheduling_window: schedulingWindowSnapshot(extraction) } : {}) },
  // A promised quote is a promise about SPECIFIC services at ONE address:
  // the delivered estimate must cover those services and price that
  // address before the card closes (codex r17 P1). Same snapshot as the
  // scheduling cards, under its own key — quote cards carry no window.
  { flags: new Set(['quote_promised']), stamp: ({ extraction }) => ({ quote_scope: askSnapshot(extraction) }) },
  // The surname card's provenance evidence: the names THIS call heard, at
  // filing (codex r18 P1). The merged V1 names the surname backfill writes
  // from arrive as extraPayload.heard_name_v1 from the processor.
  { flags: new Set(['missing_last_name']),
    stamp: ({ extraction }) => ({ heard_name: { first_name: extraction?.caller?.first_name ?? null, last_name: extraction?.caller?.last_name ?? null } }) },
  { flags: ADDRESS_SNAPSHOT_FLAGS, stamp: ({ extraction }) => ({ heard_address: heardAddressSnapshot(extraction) }) },
  { flags: new Set(['missing_unit_number']), stamp: ({ extraction, addressValidation }) => ({ unit_ask_building: unitAskBuilding(extraction, addressValidation) }) },
];

function buildTriageItem({
  callLogId,
  flag,
  extraction,
  severity = 'blocking',
  // Flag-specific evidence merged into the payload (e.g. the as-heard vs
  // recovered street + candidate list for address flags) so the Needs Review
  // card can show WHAT to confirm, not just that something needs confirming.
  extraPayload = null,
  // The AV verdict behind this card, when the caller has one. Only the
  // unit-ask stamp reads it — see below.
  addressValidation = null,
  // The linked customer's on-file address AT FILING (the processor's
  // known-caller lookup), stamped on every card as payload.on_file_address
  // — null when the call had no linked customer with a street. The
  // evidence sweep judges "the ask named no address" and "the ask named
  // exactly the on-file one" against THIS, never the customer's current
  // columns: a record moved from property A to B after the card would
  // otherwise let a booking or estimate at B close the call's implicit
  // property-A ask (codex r29 P1). A card filed without it (the backlog)
  // gets no on-file evidence — fail closed.
  onFileAddress = null,
}) {
  const flagToCategoryMap = {
    out_of_service_area: 'out_of_service_area',
    missing_service_address: 'address_review',
    low_confidence_address: 'address_review',
    address_unverified: 'address_review',
    // Specific companion to address_unverified: AV resolved the building but
    // the unit number is missing (condo/townhome) — same review lane.
    missing_unit_number: 'address_review',
    address_validation_unavailable: 'address_review',
    // MODEL flag — fail-open books past it for a known customer, so its
    // advisory card must land in the address-review lane, not service_unknown.
    address_unverifiable: 'address_review',
    ambiguous_scheduling: 'time_ambiguous',
    reschedule_or_cancel: 'time_ambiguous',
    // Gate-rejection reason strings double as flags on the Needs Review row —
    // unmapped they filed under service_unknown, so a caller who said
    // "Tuesday, first slot" was buried with billing questions instead of
    // showing up as a booking that needs a time.
    not_confirmed: 'time_ambiguous',
    confirmed_without_start_time: 'time_ambiguous',
    // Confirmed at a :15/:30/:45 start — window_start is always HH:00:00
    // (owner rule), so the office places it on an hour boundary rather than
    // the pipeline silently rounding a time the caller was told.
    off_hour_start: 'time_ambiguous',
    // Auto-route needs a positively validated address (or a dispatch to the
    // customer's verified on-file one). Nothing to fix on the time — the
    // office confirms WHERE the visit goes.
    address_not_validated: 'address_review',
    cancellation_request: 'time_ambiguous',
    after_hours_emergency: 'time_ambiguous',
    existing_appointment_coordination: 'time_ambiguous',
    auto_booking_skipped_after_approval: 'time_ambiguous',
    existing_appointment_same_date: 'time_ambiguous',
    // Phone re-service refused because the lane already has an open free
    // callback (call-recording-processor's in-transaction lane dedupe) —
    // scheduling coordination, same review lane as the same-day hold.
    open_reservice_callback_exists: 'time_ambiguous',
    // Phone re-service held because the live-lane eligibility recheck under
    // the booking locks no longer grants the lane (plan cancelled or
    // customer deactivated since resolution) — office decides what to book.
    reservice_eligibility_lapsed: 'time_ambiguous',
    // Phone re-service held because the call's resolved property has no
    // qualifying live coverage of its own (multi-property account — the
    // account-level lane grant does not extend to an uncovered rental).
    reservice_property_uncovered: 'time_ambiguous',
    // Several live bookings plausibly match the call (same service line
    // within a day of the discussed date) — a human picks which one the
    // call belongs to instead of the AI inserting a duplicate.
    ambiguous_existing_appointment: 'time_ambiguous',
    // The call was attached to a human's existing booking, so the promised
    // follow-up treatment was NOT auto-booked — the office books visit 2.
    attached_booking_followup_unbooked: 'time_ambiguous',
    auto_booking_previously_cancelled: 'time_ambiguous',
    // Pending booking created from an OUTBOUND callback — office confirms the
    // appointment (and any card/payer) before it's treated as booked.
    outbound_booking_review: 'time_ambiguous',
    multi_property_call: 'address_review',
    caller_not_authorized: 'customer_field_conflict',
    hoa_common_area_requires_approval: 'customer_field_conflict',
    commercial_requires_quote: 'customer_field_conflict',
    prior_complaint_unresolved: 'customer_field_conflict',
    sms_consent_missing: 'customer_field_conflict',
    // Booked appointment whose confirmation SMS was HELD (implied consent
    // covers only the inbound ANI and the ANI was undialable) — the office
    // confirms the number and sends the confirmation manually.
    implied_consent_non_ani_recipient: 'customer_field_conflict',
    low_extraction_confidence: 'service_unknown',
    spam_or_wrong_number: 'service_unknown',
    caller_phone_missing: 'customer_field_conflict',
    do_not_contact_requested: 'customer_field_conflict',
    lead_creation_failed: 'customer_field_conflict',
    name_email_mismatch: 'name_review',
    // Hard bounce on a call-captured email → audio re-verification proposed
    // candidates for the owner's read-back confirm (email-bounce-reverify.js).
    email_bounce_reverify: 'name_review',
    // Call-dictated email flags (call-recording-processor bridge): the card
    // carries the as-heard address, candidates, and the read-back question —
    // the same contact-confirm job as the two name_review flags above.
    email_unverified: 'name_review',
    email_invalid: 'name_review',
    // Booking proceeded WITHOUT an email (advisory, owner ruling 2026-07-31)
    // — the office collects it on the confirmation touch.
    customer_email_missing: 'name_review',
    voicemail: 'service_unknown',
    // Shadow address/identity bridge reasons (deriveCallReviewBridge).
    missing_last_name: 'name_review',
    rental_or_tenant_occupied: 'customer_field_conflict',
    second_service_address: 'address_review',
    // Call-classified property roles (occupancy contradiction / primary-
    // residence flip) awaiting the office's one-click apply — the card
    // payload carries property_role_proposals (property-role-proposals.js).
    property_role_confirm: 'address_review',
    address_recovered: 'address_review',
    address_readback: 'address_review',
    secondary_contact_captured: 'customer_field_conflict',
    secondary_contact_is_existing_customer: 'customer_field_conflict',
    shared_phone_ambiguous: 'customer_field_conflict',
    // The call linked to an existing customer via something WEAKER than the
    // phone (pre-set call.customer_id, name/context) and the caller's number
    // is not on any of that customer's phone slots — the office confirms the
    // identity and saves the number to the account if it's really them.
    caller_phone_not_on_file: 'customer_field_conflict',
    // The intake call died mid-conversation before the service address was
    // captured — the office calls the prospect back (an address-request text
    // may also have gone out; the payload says which).
    call_dropped_mid_intake: 'address_review',
    unassigned_auto_booking: 'time_ambiguous',
    // Advisory schedule-clash / time-sanity cards for AI call bookings
    // (call-recording-processor): the visit BOOKED as normal — the card
    // surfaces a cross-customer time overlap, or a transcript-parsed time
    // outside 8a–5p / on a weekend, for the office to re-slot.
    booking_time_conflict: 'time_ambiguous',
    booking_out_of_hours: 'time_ambiguous',
    // AI extraction retry budget exhausted (call-recording-processor) — the
    // call has NO extraction, so nothing downstream (lead/customer/route
    // decision) exists; this card is the only surface it gets.
    extraction_failed_permanent: 'service_unknown',
    // A second Twilio recording arrived while the row's recording was
    // load-bearing (a pass was reading it, or the call had finished) — the
    // office listens and adopts it deliberately (twilio-voice-webhook
    // parkAdditionalRecording; admin adopt-recording action).
    additional_recording: 'service_unknown',
    // The pass expected to mint a customer (named caller, phone, real
    // prospect) and the insert did not land — same lane as its lead twin,
    // and this card is the only surface the failure gets.
    customer_creation_failed: 'customer_field_conflict',
  };

  const synopsis = extraction?.meta?.call_summary || null;
  const flagPayload = Object.assign({}, ...FLAG_PAYLOAD_STAMPS
    .filter(({ flags }) => flags.has(flag))
    .map(({ stamp }) => stamp({ extraction, addressValidation })));

  return {
    call_log_id: callLogId,
    category: flagToCategoryMap[flag] || 'service_unknown',
    severity,
    reason_code: flag,
    status: 'open',
    summary: synopsis,
    payload: JSON.stringify({
      flag,
      confidence: extraction?.confidence?.overall,
      // Always present (null = the call made no scheduling claim): the
      // evidence sweep's confirmed-unbooked guard fails closed on a card
      // with no status key at all.
      scheduling_status: extraction?.scheduling?.status ?? null,
      on_file_address: onFileAddressSnapshot(onFileAddress),
      ...flagPayload,
      ...(extraPayload && typeof extraPayload === 'object' ? extraPayload : {}),
    }),
    created_at: new Date(),
    updated_at: new Date(),
  };
}

// Review cards that SURVIVE a recording swap (the webhook's replace and the
// operator's adopt-recording retire the rest as superseded): the card about
// the recordings themselves, the owed dispatch-blocking unit question (human
// verdict only — AGENTS.md), and the email-review cards whose newest
// resolved disposition the first-touch release gate reads as operator
// approval and whose bounce read-back the owner owes (Codex #3764 r3 + r4).
const SUPERSEDE_KEPT_REASON_CODES = Object.freeze([
  'additional_recording',
  'missing_unit_number',
  'email_unverified',
  'email_invalid',
  'email_bounce_reverify',
]);

module.exports = {
  SUPERSEDE_KEPT_REASON_CODES,
  onFileAddressSnapshot,
  computeAppointmentIdempotencyKey,
  computeAddressHash,
  checkTcpaConsent,
  buildRouteDecision,
  buildTriageItem,
  V2_DECISION_VERSION,
  V2_DECISION_VERSIONS,
};
