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
// 1.16.0: additive — scheduling.caller_accepted_slot (boolean|null) and
// scheduling.moved_appointment_date (date|null), each evidence-pinned. Owner
// decision 2026-09-27: the extraction judges a reschedule's agreement (the
// caller accepting the final slot, over the whole call) and names the
// existing appointment being moved; the reschedule applier only verifies the
// pinned quotes verbatim and that they name the agreed time
// (call-reschedule-apply.js). Optional/nullable: older payloads still
// validate.
// 1.15.0: additive enum widening — caller.relationship_to_property gains
// home_buyer (owner ruling 2026-09-26: a buyer under contract ordering their
// own WDO inspection is authorized like a lender or realtor). Buyers used to
// land on "other", which also covers strangers, so no rule could single them
// out. Feeds isAuthorizedWdoArrangerBooking (call-triage-flags.js). Older
// payloads still validate.
// 1.17.0: additive — scheduling.agreed_slot_words (object|null: day/hour/
// period, each verbatim words from the transcript) and
// scheduling.moved_appointment_words (string|null). Owner decision
// 2026-09-27: the extraction now records the agreed time and the moved
// appointment's date as VERBATIM WORDS pinned to the existing
// confirmed_start_at / moved_appointment_date evidence quotes, so the
// reschedule applier only checks the quote is real and contains those words
// instead of parsing speech itself (call-reschedule-agreement.js). Nothing
// consumes them yet outside that gated consumer. Optional/nullable: older
// payloads still validate.
// 1.18.0: additive enum widening — caller.relationship_to_property gains
// family_member (owner ruling 2026-09-28: a relative of the homeowner or
// resident — grandchild, child, parent, sibling, in-law — arranging service
// at THAT relative's home, e.g. "my grandfather's house", is authorized when
// staff confirmed a time on the call). Live miss (call f5a54dbd, 2026-09-28):
// the caller booked a paper-wasp knockdown at "my grandfather's house",
// confirmed Sun Oct 4 11am, and was blocked on caller_not_authorized because "other"
// covers both family and strangers alike. A spouse/partner still uses
// spouse_partner, not this value. Feeds isAuthorizedFamilyMemberBooking
// (call-triage-flags.js). Older payloads still validate.
// 1.19.0: additive — consent.sms_declined (boolean|null). Codex P1 on
// #5292: the dry-run removal of the sms_consent_given===false staging check
// (owner ruling — that field is true only on an explicit yes, so false
// means "never asked", not "refused", and blocked 151/159 real new-lead
// calls) also stopped catching an explicit "no" to "may I text you?",
// which the model recorded the SAME way (sms_consent_given=false).
// sms_declined is the dedicated field: true ONLY on an explicit decline,
// judged separately from sms_consent_given. Optional/nullable in BOTH
// schemas (AGENTS.md: extraction schema changes never add to `required`) —
// a pre-1.19 row, which never has the field at all, still validates. The
// booking-link staging check (call-booking-link-text.js) fails CLOSED
// whenever the field is absent or not a boolean: 'sms_refusal_unrecorded'.
// 1.20.0: additive — scheduling.definite_commitment,
// scheduling.relative_date_used and
// scheduling.moved_appointment_relative_date_used (each boolean|null,
// optional in both schemas, never `required`). Owner direction 2026-09-30
// ("best outcome") after word-list review rounds on #5201 did not converge:
// the extraction judges the LANGUAGE of a reschedule promise — whether the
// agent definitely committed (not could/might/probably/upon X/once Y/if Z)
// and whether the agreed or moved day was said relatively (next week, the
// following Thursday, eight days away) — and resolves relative dates to the
// absolute date it already writes in confirmed_start_at /
// moved_appointment_date. call-reschedule-agreement.js only verifies the
// flags, the quotes and the resolved date's weekday; a missing flag fails
// closed there.
// 1.21.0: additive — secondary_contact(s).wants_appointment_texts and
// .on_site (optional booleans in both schemas, never `required`). Owner ruling
// 2026-09-30 "on-site person is the contact point" (codex P1 on #5467):
// wants_notifications is channel-neutral — it is also set for "email him the
// report/invoice" — and a relationship does not prove presence, so the call
// pipeline needs the extraction to separately record that the caller agreed
// THIS person gets the appointment TEXTS and that the call says they will be
// AT the property (each with an evidence quote) before it stamps the
// service-contact SMS consent artifact. Older payloads, which lack both, still
// validate and simply never qualify.
const SCHEMA_VERSION = '1.21.0';

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
