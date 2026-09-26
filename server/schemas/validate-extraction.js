const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const modelOutputSchema = require('./call-extraction.model-output.schema.json');
const persistedSchema = require('./call-extraction.persisted.schema.json');

// 1.1.0: additive — property.additional_properties (multi-property calls),
// service_request.quote_requested / quote_promised, triage flags
// multi_property_call + quote_promised. All optional: 1.0.0 payloads
// still validate.
// 1.2.0: additive — top-level secondary_contact (a second person named as a
// party to the service: realtor's buyer, landlord's tenant, spouse). Optional
// and nullable: 1.0.0 / 1.1.0 payloads still validate.
// 1.3.0: additive — top-level other_parties_mentioned (call named more people
// than the one secondary_contact), triage flag
// existing_appointment_coordination, primary_service_category bed_bug/wdo,
// pest_type no_see_ums/flies_gnats/scorpions/moles/love_bugs/bats,
// severity_signal swarmers_seen. All optional/enum-widening: older payloads
// still validate.
// 1.4.0: additive — top-level secondary_contacts ARRAY (up to 3 other
// parties; first entry mirrors secondary_contact for older readers).
// Optional/nullable: older payloads still validate.
// 1.5.0: additive — top-level call_nature + recommended_disposition enums
// (zero-triage disposition layer), spam_verdict object (content-signal input
// to the layered spam classifier; never a discard decision alone), language.
// All optional/nullable: 1.0.0–1.4.0 payloads still validate.
// 1.6.0: additive — secondary_contact(.s[]).is_billing_party boolean (the
// paying third party for call→payer Bill-To linkage). Optional; older payloads
// (which lack it) still validate.
// 1.7.0: additive enum widening (multi-party extraction gap 2026-07-11 —
// WDO/realtor/lender arranger calls produced NO secondary_contact):
// caller.relationship_to_property gains real_estate_agent + lender;
// secondary_contact(.s[]).role gains lender. Older payloads still validate.
// 1.8.0: additive — scheduling.agent_committed_booking boolean (OUR agent
// explicitly committed to the confirmed slot; evidence-pinned to an
// AGENT-spoken quote). Feeds the gated caller_not_authorized fail-open in
// canAutoRoute (GATE_CALL_AGENT_COMMIT_BOOKING). Optional/nullable: older
// payloads still validate.
// 1.9.0: additive — property-role classification (owner directive 2026-08-15,
// a multi-property call misclassified a customer's portfolio): property.service_address_occupancy
// (same enum as additional_properties[].occupancy),
// property.service_address_is_primary_residence, and
// additional_properties[].is_primary_residence. All optional/nullable: older
// payloads still validate. Consumed by property-role-proposals (gated,
// GATE_CALL_PROPERTY_ROLE) — fill-or-park, never a silent primary flip.
// 1.12.0: additive — service_request.price object (call-agent audit
// 2026-09-23: quoted_price_usd's accepted-total-only rule left every
// unaccepted, ranged, unit-bearing, or prepay/tier price null). Captures
// amount_usd/amount_max_usd (ranges), unit, accepted, stated_by,
// prepay_term, tier_mentioned, evidence_quote. quoted_price_usd keeps its
// existing semantics and consumers unchanged. Optional/nullable: older
// payloads still validate.
// 1.13.0: additive, two owner-approved #4707 follow-ups (codex r5 P2s).
// (1) service_request.price.caller_response — an explicit
// accepted/declined/no_response/not_at_issue enum that replaces the old
// boolean-only `accepted`, which conflated "caller declined" with "caller
// never responded". `accepted` stays for backward compatibility, derived
// from caller_response (true iff 'accepted'; false for
// declined/no_response; null for not_at_issue/null). (2) service_request.
// prices[] (maxItems 6) — every distinct price stated on a call that quotes
// more than one (e.g. a one-time price AND a monthly price); `price` stays
// the single PRIMARY entry (the accepted one if any, else the first
// stated) so every existing reader of `price` keeps working unchanged.
// Both additive/optional: older payloads still validate.
// 1.14.0: additive — caller.caller_id_disclaimed (boolean|null) and
// caller.phone_note (string|null, <=160 chars). Live miss 2026-09-25 (call
// 6fee5f34): the caller said "this is our office line... they don't pick
// up, I pick up, and then text" — the schema had no way to record that the
// Twilio ANI is NOT the caller's own number, so the customer and every
// booking confirmation/reminder SMS landed on a shared office line.
// caller_id_disclaimed is true only when the caller explicitly says the
// incoming number isn't theirs; phone_note carries their own words.
// Feeds the deterministic callback_number_needed triage flag
// (call-triage-flags.js) when no spoken callback number also covers it.
// Optional/nullable: older payloads still validate.
const SCHEMA_VERSION = '1.14.0';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

ajv.addFormat('e164', /^\+[1-9]\d{1,14}$/);

const validateModelOutputFn = ajv.compile(modelOutputSchema);
const validatePersistedFn = ajv.compile(persistedSchema);

function validateModelOutput(data) {
  const valid = validateModelOutputFn(data);
  return {
    valid,
    errors: valid ? null : [...validateModelOutputFn.errors],
  };
}

function validatePersisted(data) {
  const valid = validatePersistedFn(data);
  return {
    valid,
    errors: valid ? null : [...validatePersistedFn.errors],
  };
}

module.exports = {
  SCHEMA_VERSION,
  validateModelOutput,
  validatePersisted,
};
