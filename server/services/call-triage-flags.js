const { correctEmailDomain, meetsConfidence } = require('../utils/email-typo-correction');
const { looksGarbledTranscriptEmail } = require('../utils/intake-normalize');
const { parseRawAddress, splitStreetLineUnit, splitUnitFirstLine, normalizeStreetLine, normalizeState, normalizeUnitLine, unitLineValueKey, unitAnywhereOnLine, STREET_SUFFIX_ALIASES } = require('../utils/address-normalizer');

const SERVICE_AREA_COUNTIES = new Set(['Manatee', 'Sarasota', 'Charlotte', 'DeSoto']);

// A reachable number, not a withheld-caller-ID placeholder. Twilio delivers
// blocked/unavailable caller ID as text ("anonymous", "unknown", "restricted",
// "unavailable") rather than a dialable E.164, so "truthy" is not enough — we
// require at least 10 digits before treating an ANI as a real callback number.
function isDialablePhone(value) {
  if (!value) return false;
  return String(value).replace(/\D/g, '').length >= 10;
}

// Role/shared mailboxes whose local-part legitimately won't contain a person's
// name — don't treat these as a name↔email mismatch.
const GENERIC_EMAIL_LOCALPARTS = new Set([
  'info', 'office', 'sales', 'admin', 'contact', 'support', 'service',
  'billing', 'accounts', 'accounting', 'hello', 'noreply', 'mail', 'email',
]);

// Common, non-name mailbox affixes. A delimited segment that is one of these
// is NOT evidence of a different person (jsmith.home@, maria.work@).
const NON_NAME_EMAIL_AFFIXES = new Set([
  'home', 'work', 'family', 'personal', 'official', 'real', 'team', 'group',
  'online', 'here', 'only', 'usa', 'dev', 'biz', 'llc', 'inc', 'mail', 'email',
]);
const EMAIL_PREFIX_NAME_EQUIVALENTS = new Map([
  ['ronnie', 'ronni'],
]);

function nameTokenMatchesEmailLocal(token, local) {
  const t = String(token || '').replace(/[^a-z]/g, '');
  if (t.length < 3) return false;
  if (local.includes(t)) return true;

  // Known spoken/extracted spelling drift from reviewed call ground truth:
  // Ronni is often extracted as Ronnie while the email remains ronnir.
  const equivalentPrefix = EMAIL_PREFIX_NAME_EQUIVALENTS.get(t);
  if (equivalentPrefix && local.startsWith(equivalentPrefix)) {
    return true;
  }

  return false;
}

// Detects when the extracted caller name is NOT corroborated by the email's
// local-part — e.g. spoken "Jeanette" with email gennettryan@ (really Ryan
// Gennett). We do NOT guess the right name (email-based inference is
// unreliable); we only flag the contradiction so it routes to name_review
// instead of auto-booking a name we can't corroborate. Conservative: skips
// when there's no usable name, no name-shaped email, or a generic mailbox.
function hasNameEmailMismatch(caller = {}) {
  const email = String(caller.email || '').toLowerCase();
  const at = email.indexOf('@');
  if (at < 1) return false;
  const localRaw = email.slice(0, at);              // keep separators for (2)
  const local = localRaw.replace(/[^a-z]/g, '');
  if (local.length < 4) return false;            // too short to reason about
  if (GENERIC_EMAIL_LOCALPARTS.has(local)) return false;
  // Multi-segment role mailbox with no personal name at all (office.sales@,
  // sales.support@): every delimited segment is a role/affix word. The collapsed
  // form ("officesales") isn't an exact generic match, so guard it here before
  // the zero-token check below would wrongly flag a clean shared-mailbox booking.
  const localSegments = localRaw.split(/[^a-z]+/).filter((s) => s.length >= 2);
  if (localSegments.length > 0
    && localSegments.every((s) => GENERIC_EMAIL_LOCALPARTS.has(s) || NON_NAME_EMAIL_AFFIXES.has(s))) {
    return false;
  }
  const tokens = [...new Set(
    [caller.first_name, caller.last_name, caller.name_full]
      .filter(Boolean)
      .flatMap((n) => String(n).toLowerCase().split(/\s+/))
      .map((t) => t.replace(/[^a-z]/g, ''))
      .filter((t) => t.length >= 3)
  )];
  if (tokens.length === 0) return false;          // no usable name to check

  const present = tokens.filter((t) => nameTokenMatchesEmailLocal(t, local));

  // (1) Not one extracted name token appears anywhere → uncorroborated name.
  // This is what caught the real incident (spoken "Jeanette", surname extracted
  // as null, email gennettryan@ — "jeanette" appears nowhere).
  if (present.length === 0) return true;

  // (2) A separator-delimited segment names someone else. Only act on EXPLICIT
  // boundaries (john.smith@, j_smith@, maria-rodriguez@): a delimited segment of
  // name length (>=4) that matches no extracted token — and isn't a known
  // mailbox affix (home/work/family/...) — while an extracted token is still
  // missing means the email encodes a different name than we captured.
  // We deliberately do NOT mine separator-less concatenations (jsmithhome,
  // gennettryan): once a token is a substring, "home" vs "ryan" can't be told
  // apart from an affix without a name dictionary, and over-triaging common
  // first-initial+surname+suffix mailboxes costs more than missing a rare
  // concatenated typo — a wholly wrong name is already caught by (1).
  if (present.length < tokens.length) {
    const foreignSegment = localRaw
      .split(/[^a-z]+/)
      .filter((seg) => seg.length >= 4
        && !NON_NAME_EMAIL_AFFIXES.has(seg)
        && !GENERIC_EMAIL_LOCALPARTS.has(seg)) // a delimited role mailbox (office.john@) is not a name
      .some((seg) => !tokens.some((t) => nameTokenMatchesEmailLocal(t, seg) || seg.includes(t) || t.includes(seg)));
    if (foreignSegment) return true;
  }
  return false;
}

// Normalized lookup: lowercase, " county" suffix stripped, whitespace collapsed.
const SERVICE_AREA_COUNTIES_NORMALIZED = new Set(
  [...SERVICE_AREA_COUNTIES].map((c) => normalizeCounty(c))
);

function normalizeCounty(value) {
  if (!value) return null;
  return String(value)
    .toLowerCase()
    .replace(/\s+county\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim() || null;
}

function isInServiceAreaCounty(county) {
  const normalized = normalizeCounty(county);
  return normalized !== null && SERVICE_AREA_COUNTIES_NORMALIZED.has(normalized);
}

// 0.5 is the prompt rubric's "very uncertain" boundary. The old 0.7 sat in
// the "inferred with reasonable confidence" band and, combined with a rubric
// that scored completeness rather than fidelity, flagged 19 clear calls in
// the 2026-09-02..08 audit (short calls with no address to extract scored
// 0.05-0.45). The rubric now scores only what was returned; this threshold
// catches genuinely garbled extractions, not short ones.
const DEFAULT_CONFIDENCE_THRESHOLD = 0.5;
const DEFAULT_ADDRESS_CONFIDENCE_THRESHOLD = 0.6;

// Relationships that make the caller a third party to the property. 'owner'
// is the account holder; 'unknown' is NOT non-owner (owner ruling
// 2026-07-31, call a771fa15) — most homeowners never state "it's my house",
// so the model returns 'unknown' plus on_site_authorization=false and the
// pair used to hard-block every ordinary call (31 of 65 processed calls in
// the 2026-09-02..08 audit, none of them a real third party). A spouse or
// partner on the household is an authorized party for pest service, not a
// stranger arranging it for someone else, so it is owner-equivalent here.
const OWNER_EQUIVALENT_RELATIONSHIPS = new Set(['owner', 'spouse_partner', 'unknown']);
function isExplicitlyNonOwner(relationship) {
  const r = String(relationship || 'unknown').trim().toLowerCase() || 'unknown';
  return !OWNER_EQUIVALENT_RELATIONSHIPS.has(r);
}

// The model emits triage_flags of its own (same vocabulary). A model-emitted
// caller_not_authorized is only as good as the relationship it rests on:
// when the caller is not explicitly a third party, drop it so the merge
// cannot reintroduce the block the deterministic pass no longer raises.
function suppressUnsupportedModelFlags(modelFlags, extraction) {
  const flags = Array.isArray(modelFlags) ? modelFlags : [];
  if (!flags.includes('caller_not_authorized')) return flags;
  if (isExplicitlyNonOwner(extraction?.caller?.relationship_to_property)) return flags;
  return flags.filter((f) => f !== 'caller_not_authorized');
}

function computeDeterministicTriageFlags(extraction, opts = {}) {
  if (!extraction || !extraction.meta) return [];

  const flags = [];
  const caller = extraction.caller || {};
  const property = extraction.property || {};
  const addr = property.service_address || {};
  const consent = extraction.consent || {};
  const scheduling = extraction.scheduling || {};
  const confidence = extraction.confidence || {};
  const sentiment = extraction.sentiment_and_lead || {};
  const history = extraction.customer_history || {};
  const overallThreshold = opts.confidenceThreshold || DEFAULT_CONFIDENCE_THRESHOLD;
  const addressThreshold = opts.addressConfidenceThreshold || DEFAULT_ADDRESS_CONFIDENCE_THRESHOLD;

  if (extraction.meta.is_voicemail) flags.push('voicemail');
  if (extraction.meta.is_spam) flags.push('spam_or_wrong_number');

  // Address flags. When Google Address Validation produced a decisive verdict
  // (opts.addressValidation), it is authoritative for both address validity and
  // service area — it supersedes the model's confidence guess and county string.
  // Otherwise (validation disabled, no address to check, or the API errored) we
  // fall back to the model/confidence signals.
  const av = opts.addressValidation || null;
  const avStatus = av?.status || null;
  const avDecisive = avStatus && avStatus !== 'not_attempted' && avStatus !== 'api_unavailable';

  if (avDecisive) {
    if (avStatus === 'out_of_service_area') {
      flags.push('out_of_service_area');
    } else if (avStatus === 'confirm_needed' || avStatus === 'missing_component' || avStatus === 'ambiguous') {
      flags.push('address_unverified');
    } else if (typeof confidence.service_address === 'number' && confidence.service_address < addressThreshold) {
      // AV accepted a REAL premise — but the model wasn't sure it heard the
      // right street. "Palm Ave" misheard as "Park Ave" validates cleanly at
      // the wrong (real) house; the model's low confidence was the only
      // signal, and it used to be discarded here. Advisory: the call still
      // auto-routes on AV's verdict, the office just reads the street back.
      flags.push('address_readback');
    }
    // validated_accept / corrected → clean, no blocking address flag (the
    // whole point: a corrected bad zip clears triage instead of holding the
    // call).

    // AV resolved the BUILDING but Google reports the unit designator
    // missing (condo/townhome address given without a unit). Advisory by
    // construction — deliberately NOT in BLOCKING_TRIAGE_FLAGS — because it
    // never stands alone: this shape always carries the unresolved status
    // above, whose address_unverified hold is what keeps the call in
    // review. (The call processor also refuses street recovery on this
    // shape, so the hold can never be swapped for an accepted wrong-parcel
    // verdict.) This flag only NAMES the specific ask behind that hold:
    // "which unit?" instead of "could not be verified".
    //
    // opts.canonicalRecord is the MERGED flat record the pipeline will
    // actually dispatch against. It must be consulted, not the extraction:
    // adoptV2PrimaryFields retains a V1 unit that V2 dropped for the same
    // address, so the AV verdict can report a missing subpremise the
    // canonical record already supplies (codex r16 P1). Omitting the opt
    // preserves the old behavior for callers with no merged record.
    // `inServiceArea === false` is checked as well as the status, not instead
    // of it: deriveStatus tests completeness BEFORE service area, so a
    // resolved PREMISE in an unsupported county returns `ambiguous` and never
    // reaches the out_of_service_area branch (codex r17 P2). Collecting a
    // unit cannot make an out-of-area building serviceable, so that ask is
    // busywork the office can never usefully perform.
    if (avStatus !== 'out_of_service_area'
        && av?.inServiceArea !== false
        && isMissingUnitNumber(av)
        && !(opts.canonicalRecord && recordCarriesUnit(opts.canonicalRecord))) {
      flags.push('missing_unit_number');
    }
  } else {
    if (!addr.street_line_1 && !addr.city && !addr.postal_code) {
      flags.push('missing_service_address');
    }
    if (typeof confidence.service_address === 'number' && confidence.service_address < addressThreshold) {
      flags.push('low_confidence_address');
    }
    if (addr.county && !isInServiceAreaCounty(addr.county)) {
      flags.push('out_of_service_area');
    }
    // Validation was attempted with a real address but the API was unreachable.
    // Don't silently auto-route an address we couldn't verify — hold for review.
    if (avStatus === 'api_unavailable') {
      flags.push('address_validation_unavailable');
    }
  }

  if (scheduling.status === 'ambiguous') {
    flags.push('ambiguous_scheduling');
  }

  if (scheduling.status === 'reschedule_requested' || scheduling.status === 'canceled') {
    flags.push('reschedule_or_cancel');
  }

  if (consent.do_not_contact_request === true) {
    flags.push('do_not_contact_requested');
  }

  // caller.phone_e164 is the SPOKEN callback number — usually null because the
  // caller doesn't re-state their number. We almost always have the Twilio ANI
  // (passed as opts.contactPhone), so only flag when there's genuinely no way to
  // reach them. The ANI must be a DIALABLE number — a withheld caller ID arrives
  // as "anonymous"/"unknown" text, which must NOT count as reachable (else we'd
  // auto-route a customer we can't call or text back). Without the ANI threaded
  // in, this fired on nearly every inbound call and sent everything to triage.
  if (!caller.phone_e164 && !isDialablePhone(opts.contactPhone)) {
    flags.push('caller_phone_missing');
  }

  if (hasNameEmailMismatch(caller)) {
    flags.push('name_email_mismatch');
  }

  if (sentiment.lead_quality === 'spam_or_solicitation' || sentiment.lead_quality === 'wrong_number') {
    if (!flags.includes('spam_or_wrong_number')) flags.push('spam_or_wrong_number');
  }

  if (sentiment.lead_quality === 'out_of_service_area') {
    if (!flags.includes('out_of_service_area')) flags.push('out_of_service_area');
  }

  if (property.hoa_common_area_service === true) {
    flags.push('hoa_common_area_requires_approval');
  }

  if (history.prior_complaint_mentioned === true) {
    flags.push('prior_complaint_unresolved');
  }

  if (typeof confidence.overall === 'number' && confidence.overall < overallThreshold) {
    flags.push('low_extraction_confidence');
  }

  if (caller.on_site_authorization === false && isExplicitlyNonOwner(caller.relationship_to_property)) {
    flags.push('caller_not_authorized');
  }

  if (property.property_type === 'commercial' || property.hoa_common_area_service === true) {
    if (!flags.includes('hoa_common_area_requires_approval')) {
      flags.push('commercial_requires_quote');
    }
  }

  // Advisory identity signals — emitted here (not just in the shadow bridge) so
  // they survive once CALL_EXTRACTION_V2_DRIVES_ROUTING is promoted and the
  // bridge is guarded off. They are ADVISORY (see ADVISORY_TRIAGE_FLAGS): they
  // reach Needs Review but do NOT block an otherwise-routable appointment.
  if (caller.first_name && !String(caller.last_name || '').trim()
      && (sentiment.lead_quality === 'hot' || sentiment.lead_quality === 'warm')) {
    flags.push('missing_last_name');
  }
  if (detectRentalSignal({ extracted: { call_summary: extraction.meta.call_summary }, callerRelationship: caller.relationship_to_property })) {
    flags.push('rental_or_tenant_occupied');
  }
  // Multi-property + promised-quote signals — deterministic from the extraction
  // body so they reach Needs Review even when the model omitted the flag.
  // Both ADVISORY: they inform the office, never hold an appointment.
  if (Array.isArray(property.additional_properties) && property.additional_properties.length > 0) {
    flags.push('multi_property_call');
  }
  if (extraction.service_request?.quote_promised === true) {
    flags.push('quote_promised');
  }
  // A second person was named as a party to the service (realtor's buyer,
  // landlord's tenant) — deterministic from the extraction body. ADVISORY:
  // the office confirms their contact info; the booking itself is fine.
  const secondary = extraction.secondary_contact;
  if (secondary && (secondary.name_full || secondary.first_name || secondary.phone_e164 || secondary.email)) {
    flags.push('secondary_contact_captured');
  }

  // A decisive AV acceptance is authoritative for the address + service area —
  // drop any address flags reached above (incl. a lead_quality-sourced
  // out_of_service_area) so a verified in-area address is not held.
  return suppressAddressFlagsForAV(flags, opts.addressValidation);
}

const SMS_ONLY_FLAGS = new Set([
  'no_sms_consent_captured',
  'sms_consent_missing',
]);

// Advisory flags — they surface in the Needs Review inbox (informational: missing
// surname, rental/tenant-occupied, a second service address) but must NOT block
// an otherwise-routable appointment. Excluded from appointmentBlockingFlags.
const ADVISORY_TRIAGE_FLAGS = new Set([
  'missing_last_name',
  'rental_or_tenant_occupied',
  'second_service_address',
  // Recovered-street read-back reminder — informs the callback, never blocks
  // routing (the recovered premise passed Address Validation).
  'address_recovered',
  // AV accepted a real premise but the model's own address confidence was low
  // (possible valid-but-wrong-street mishear) — read the street back on the
  // confirmation call; never blocks the AV-approved routing.
  'address_readback',
  // AV resolved a multi-unit building given without its unit (missing
  // subpremise) — names the specific ask for the callback. The call is
  // already held by the address_unverified hard flag; this must not add a
  // second block.
  'missing_unit_number',
  // Caller discussed more than one property — the extra addresses are recorded
  // (customer_properties) / surfaced on the lead; the booked visit itself is fine.
  'multi_property_call',
  // Agent promised to send a quote after the call — work is owed to the caller,
  // but the appointment that was ALSO booked must still auto-route.
  'quote_promised',
  // A second contact (buyer/tenant/spouse) was named on the call — the office
  // confirms their info; never holds the appointment.
  'secondary_contact_captured',
  // Prior-complaint mention (owner ruling 2026-07-31): a returning customer
  // saying "last time the ants came back — can you come Tuesday at 10" is a
  // BOOKING, not a dispute. The card tells the office to review the history
  // before the visit; it never holds the appointment.
  'prior_complaint_unresolved',
  // Caller is also shopping competitor quotes — a SALES signal, not a safety
  // one: if they agreed to a time, book it and tell the office there's
  // competitive pressure. Advisory in the pre-refactor design too (the old
  // call-triage-safety.js ADVISORY set); blocking here was an unintended
  // regression, now pinned by the schema-classification contract test.
  'competing_quotes_active',
]);

// Explicit allowlist of flags allowed to HOLD an appointment (owner ruling
// 2026-07-31): the model's triage_flags vocabulary evolves with the prompt/
// schema, and the previous advisory-blocklist design meant any NEW (or
// hallucinated) flag name silently blocked bookings. Flags outside every
// known set now demote to failedOpenFlags in canAutoRoute — advisory card
// files, booking proceeds. Sources of truth: the deterministic emitters
// above + the model-output schema triage_flags enum.
// Blocking flags that mean "someone must act on an existing visit". The
// enforce path opens call_log.review_status when one of these holds the
// call, so the change has a visible owner and not just a triage card.
const SCHEDULING_CHANGE_REVIEW_FLAGS = ['cancellation_request', 'reschedule_or_cancel', 'existing_appointment_coordination'];

const BLOCKING_TRIAGE_FLAGS = new Set([
  'out_of_service_area',
  'hoa_common_area_requires_approval',
  'commercial_requires_quote',
  'caller_not_authorized',
  'do_not_contact_requested',
  'address_unverifiable',
  'address_unverified',
  'missing_service_address',
  'low_confidence_address',
  'address_validation_unavailable',
  'low_extraction_confidence',
  'ambiguous_pest_or_service',
  'spam_or_wrong_number',
  'after_hours_emergency',
  'cancellation_request',
  'manual_review_requested',
  'ambiguous_scheduling',
  'reschedule_or_cancel',
  'existing_appointment_coordination',
  'voicemail',
  'caller_phone_missing',
  'name_email_mismatch',
]);

// Flags that mean "this is not a customer we should write to canonical tables."
// When any of these fire, skip customer upsert + lead creation entirely — the
// call is recorded in call_log + triage_items for audit, but does not pollute
// the customers/leads pipeline. Soft blocks (not_confirmed, ambiguous, hoa,
// caller_not_authorized, etc.) are still real prospects and DO create a
// customer/lead; they only block the appointment auto-creation.
const CANONICAL_WRITE_BLOCKING_FLAGS = new Set([
  'spam_or_wrong_number',
  'out_of_service_area',
  'do_not_contact_requested',
]);

function hasCanonicalWriteBlock(flags) {
  return (flags || []).some((f) => CANONICAL_WRITE_BLOCKING_FLAGS.has(f));
}

// Address/service-area flags that a decisive AV acceptance overrides. These can
// be emitted by the MODEL (extraction.triage_flags) as well as deterministically,
// so when AV affirmatively accepts/corrects an in-area premise they must be
// stripped from BOTH sources — otherwise a stale model `out_of_service_area`
// would still hard-veto an address AV just verified.
const ADDRESS_FLAGS_SUPERSEDED_BY_AV = new Set([
  'missing_service_address',         // deterministic
  'low_confidence_address',          // deterministic
  'address_unverified',              // deterministic (AV confirm_needed/missing/ambiguous)
  'address_validation_unavailable',  // deterministic (AV api error)
  'out_of_service_area',             // model + deterministic
  'address_unverifiable',            // MODEL flag (schema enum / prompt). The model marks nearly every call address_unverifiable; AV accept/correct authoritatively resolves the address, so this must clear too or clean addresses never auto-route.
  'missing_unit_number',             // deterministic (AV premise w/ missing subpremise) — clears ONLY on a SUB_PREMISE-granularity accept (exact door validated); see the filter's granularity exception below.
]);

// AV resolved a real building (PREMISE) but Google lists the unit designator
// (subpremise) as the missing input — a multi-unit condo/townhome building
// address given without the unit number. County rolls model these communities
// as building-level master parcels, so without the unit nothing downstream
// (parcel match, dispatch, interior treatment) can target the right home.
/**
 * SHADOW-MODE guard for the unit ask (codex r12 P1). The AV verdict describes
 * the address V2 sent; in shadow mode the LEGACY V1 record is what the lead
 * and the review card actually hold. "Ask which unit" is only useful — and
 * only true — when those are the same building, so the ask is filed just when
 * AV's resolved building corroborates the legacy street (suffix-insensitive,
 * unit designators irrelevant here since the whole point is that there is no
 * unit) AND the place agrees where both sides state one — the same rule the
 * adoption path's sameLocation uses, because "100 Main St" exists in several
 * cities (codex r13 P1). Fails closed: a V1/V2 street or place disagreement, a
 * legacy record with no street, or an AV result with no normalized street
 * files nothing — the generic address_unverified hold already covers the call,
 * and a unit task pointing at a building the record does not hold is worse
 * than none (it is human-only work, never auto-resolved).
 *
 * The enforce lane does NOT use this street/place corroboration — there V2 IS
 * the record — but it DOES share recordCarriesUnit below.
 */
/**
 * Does this flat record already state a unit? Both shapes count: a dedicated
 * line 2, and a unit peeled out of the street line ("100 Example Ct Apt 4").
 *
 * Shared by BOTH lanes on purpose. The unit ask is never auto-resolved, so
 * filing one for a unit the record already holds creates a permanent,
 * unanswerable task — and each lane reaches that state by its own route:
 * shadow mode via the legacy V1 record (codex r14 P1), enforce mode via
 * adoptV2PrimaryFields, which deliberately RETAINS a V1 address_line2 that V2
 * omitted for the same address (extraction-compat.js; codex r16 P1) — so the
 * canonical record can carry a unit that V2's extraction, and therefore the
 * AV verdict built from it, never saw.
 */
function recordCarriesUnit(flatRecord = {}) {
  const { splitStreetLineUnit } = require('../utils/address-normalizer');
  if (String(flatRecord.address_line2 || '').trim()) return true;
  return !!splitStreetLineUnit(flatRecord.address_line1).unit;
}

function unitAskCorroborated(av, extracted = {}) {
  if (!isMissingUnitNumber(av)) return false;
  // Out-of-area buildings get no unit ask — same reasoning as the enforce
  // lane: the status is `ambiguous` because completeness outranks the
  // service-area test, and a unit cannot make the address serviceable.
  if (av?.inServiceArea === false) return false;
  const { splitStreetLineUnit, normalizeStreetLine } = require('../utils/address-normalizer');
  if (recordCarriesUnit(extracted)) return false;
  // Compare through the CANONICAL suffix table, not streetCompareKey's
  // hand-written strip list (codex r15 P1): that list omits pairs the
  // normalizer already aliases — "100 Example Loop" vs Google's "100 Example
  // Lp" — and a false mismatch here silently suppresses the ask, leaving the
  // office with the generic hold and no instruction to collect the unit.
  // streetCompareKey itself is deliberately left alone: the adoption rule and
  // the second-address check are calibrated to its narrower matching.
  const buildingKey = (line) => normalizeStreetLine(splitStreetLineUnit(line).street)
    .toLowerCase().replace(/[^a-z0-9]/g, '');
  const avKey = buildingKey(av?.normalized?.street_line_1);
  const legacyKey = buildingKey(extracted.address_line1);
  if (!avKey || !legacyKey || avKey !== legacyKey) return false;
  const placeKey = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const zip5 = (z) => (String(z || '').match(/^\d{5}/) || [''])[0];
  const avZip = zip5(av?.normalized?.postal_code);
  const legacyZip = zip5(extracted.zip);
  if (avZip && legacyZip && avZip !== legacyZip) return false;
  const avCity = placeKey(av?.normalized?.city);
  const legacyCity = placeKey(extracted.city);
  // Postal-city names alias (Bradenton / Lakewood Ranch share 34211), so a
  // city mismatch only disqualifies when no ZIP pair already agreed.
  if (!(avZip && legacyZip) && avCity && legacyCity && avCity !== legacyCity) return false;
  return true;
}

function isMissingUnitNumber(av) {
  return !!(av && av.granularity === 'PREMISE'
    && Array.isArray(av.missingComponents)
    // The unit must be the ONLY thing missing (codex r11 P1). With another
    // component missing too, the address is not merely unit-less — the
    // street itself is incompletely resolved, which IS recoverable input,
    // so this must not claim it as a unit-only ask and skip recovery.
    && av.missingComponents.length === 1
    && av.missingComponents[0] === 'subpremise');
}

function suppressAddressFlagsForAV(flags, addressValidation) {
  const s = addressValidation?.status;
  if (s !== 'validated_accept' && s !== 'corrected') return flags || [];
  // The unit ask only clears on AFFIRMATIVE unit validation: an accept at
  // SUB_PREMISE granularity means Google confirmed the exact door. A
  // PREMISE-level accept proves the building only — it says nothing about
  // which unit, so a stale unit ask survives it (pre-push audit P1).
  return (flags || []).filter((f) => !ADDRESS_FLAGS_SUPERSEDED_BY_AV.has(f)
    || (f === 'missing_unit_number' && addressValidation?.granularity !== 'SUB_PREMISE'));
}

function mergeTriageFlags(modelFlags, deterministicFlags) {
  return [...new Set([...(modelFlags || []), ...(deterministicFlags || [])])];
}

// Address flags that fail-open booking treats as recoverable ONLY for an
// EXISTING customer with an address already on file (Google-verified at
// signup) — they didn't restate it because they're known. Never includes
// out_of_service_area, which stays a hard block. New-customer addresses are
// still governed by Google Address Validation.
const FAIL_OPEN_KNOWN_CUSTOMER_ADDRESS_FLAGS = new Set([
  'address_unverifiable', 'missing_service_address', 'low_confidence_address', 'address_unverified',
]);

// Normalization for quote↔transcript grounding: case-, punctuation- and
// whitespace-insensitive so transcription formatting differences don't break
// a genuine verbatim match.
function normalizeForGrounding(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Grounds a claimed AGENT quote against the SOURCE transcript's speaker
// turns. The extraction's evidence objects (quote AND speaker label) are
// model output — untrusted; a hallucinated evidence entry must never clear a
// hard block. So the quote must actually appear inside a single
// "Agent:"-attributed turn of the labeled transcript we extracted from.
// Fail closed: no transcript, a quote found only in caller turns, or ANY
// speaker-attribution ambiguity. Labeling must be COMPLETE — every non-empty
// line carries an Agent:/Caller: prefix, and both speakers appear (codex P1:
// a partially-labeled transcript would otherwise let a third party's or the
// caller's unlabeled line be attributed to the agent turn above it; and an
// agent-only labeling is a one-sided call that cannot contain a two-party
// commitment). A legitimately labeled multi-line turn fails this check —
// conservative and accepted; the main transcription is one line per turn.
// The 12-char normalized minimum keeps trivial fillers ("okay", "sounds
// good") from grounding a commitment claim. A quote the model stitched
// across two turns fails per-turn containment — also closed, also correct:
// the commitment sentence is a single agent utterance.
// Negation/hedge screen (codex round-6 P1): the model can pin a VERBATIM
// FRAGMENT that strips the negation around it — "Sunday at 10 AM" grounds
// inside the agent turn "Sunday at 10 AM won't work, but I'll ask someone to
// call you back", and the slot matcher would then see a clean single
// mention. Deterministic containment can't parse negation, so the screen is
// applied to the WHOLE turn the quote grounds in: any negation or hedge
// token in that turn fails the grounding. Curated, conservative, fail-closed
// — a benign turn containing "not" is sacrificed to triage rather than
// risking a booking the agent rejected.
// Codex round 10, P1 (:655): a bare rejection token ("Yeah, but no.") named
// none of the phrases below, so a caller's flat "no"/"nope"/"nah" never
// tripped this screen on its own — only multi-word hedges did. Added as
// defense in depth alongside pulling "but" out of the shared commitment
// vocabulary (above): either fix alone already closes the specific "Yeah,
// but no." regression, but a bare rejection token is exactly the shape this
// screen exists to catch, so it belongs here regardless.
const NEGATION_HEDGE_TOKENS = [
  ' not ', ' won t ', ' wont ', ' can t ', ' cant ', ' cannot ', ' don t ',
  ' dont ', ' doesn t ', ' doesnt ', ' isn t ', ' isnt ', ' unable ',
  ' instead ', ' unless ', ' rather ', ' maybe ', ' might ',
  ' unfortunately ', ' call you back ', ' have to check ', ' let me check ',
  ' see if ', ' ask someone ', ' no ', ' nope ', ' nah ',
];
// Codex round 22, P1 (:611): the bare noncommittal "We'll see." / "Let's
// see." — whitelisted words only, and "see if" was the only see-hedge.
// Anchored to the END of the sentence (a courtesy tail aside), so the
// commitment heads "we'll see you/him/her/them" never match.
const SEE_HEDGE_RE = /(?:^| )(?:(?:we|i) (?:ll|will|shall)(?: (?:just|have to|just have to))? see|let s see|let us see)(?: (?:then|thanks|thank you|okay|ok|so))*$/;
function turnHasNegationOrHedge(normalizedTurn) {
  // "No problem." is an affirmation, not the bare-"no" rejection (codex
  // round 10, P2) — drop the phrase before the token screen.
  const padded = ` ${normalizedTurn} `.replace(/ no problem(?= )/g, '');
  return NEGATION_HEDGE_TOKENS.some((t) => padded.includes(t))
    || SEE_HEDGE_RE.test(normalizedTurn);
}

// Conditional-language screen (codex P0): "If the homeowner approves, we
// will see you Sunday at noon" is not a commitment — authorization does not
// exist yet. A blacklist cannot anticipate every conditional phrasing, so
// this fails CLOSED on conditional structure: any conditional token rejects
// the turn outright, and "if" rejects unless it opens one of the benign
// closing phrases agents actually use ("just let us know if anything
// changes"). Everything unrecognized goes to triage.
const CONDITIONAL_TOKENS = [
  ' unless ', ' assuming ', ' provided ', ' as long as ', ' pending ',
  ' depends ', ' depending ', ' when ', ' once ', ' should the ',
  ' subject to ',
];
// "if" is exempt ONLY inside the exact recognized closing construction —
// "(just) let us know if <benign follower>" (codex P0, round 7g: "we will
// book you for Sunday at noon IF ANYTHING CHANGES" is a conditional booking
// even though the follower matches, so the follower alone is not enough:
// the words BEFORE the "if" must be the let-us-know closer).
const BENIGN_IF_PRECEDER_RE = /(?:^| )(?:just )?let us know $/;
// Codex round 18, P1 (:1590): the follower was matched as a PREFIX, so
// "Let us know if anything changes, and then we will put you down." read
// as a closed conditional and its appended booking consequent was never
// checked. The follower must now END the sentence — only a courtesy tail
// ("thanks", "thank you so much", "bye") may follow it.
const BENIGN_IF_FOLLOWER_RE = /^if (?:anything changes|that changes|anything comes up|something comes up|you need anything|you have any questions)(?: (?:thanks|thank you|so much|much|bye|talk to you soon))* $/;
function turnHasUnresolvedConditional(normalizedTurn) {
  const padded = ` ${normalizedTurn} `;
  if (CONDITIONAL_TOKENS.some((t) => padded.includes(t))) return true;
  let idx = padded.indexOf(' if ');
  while (idx !== -1) {
    if (!BENIGN_IF_PRECEDER_RE.test(padded.slice(0, idx + 1))
      || !BENIGN_IF_FOLLOWER_RE.test(padded.slice(idx + 1))) return true;
    idx = padded.indexOf(' if ', idx + 1);
  }
  return false;
}

// Affirmative commitment contract (codex P0, final form): blacklists cannot
// enumerate every conditional/tentative phrasing ("subject to homeowner
// approval", "pencil you in", …), so the decision is inverted into a CLOSED
// VOCABULARY: every word of the grounding turn must come from the small set
// a plain affirmative commitment sentence is built from — discourse openers,
// first-person commitment heads and verbs, slot glue, day/date/time words,
// and the benign closers agents actually say. Conditional, tentative,
// approval-seeking, or otherwise unexpected language is OUT of vocabulary by
// construction and fails closed to triage. Numbers are permitted as tokens;
// what they may MEAN is validated separately by quoteBindsConfirmedSlot.
// The negation/conditional screens above stay as defense in depth.
// Codex round 10, P1 (:655): "yeah" and "but" were added here (codex round
// 9) only because the real PINNED grounding sentence started with "But
// yeah, …" — but this Set is also the closed vocabulary every OTHER
// sentence's stripped text is checked against (turnVocabularyTokenOk /
// otherSentenceIsClean), so a free "but" here let an OTHER sentence go
// contrastive-clean too: "We'll see you Sunday at noon. Yeah, but no."
// named no scheduling predicate and no declarative-poison term, and every
// token (yeah/but/no) happened to be vocabulary, so the rejection the
// caller actually spoke ("no") read as a benign aside. "but"/"yeah" are
// discourse OPENERS, not ordinary content words that belong anywhere in a
// sentence — they already live in COMMITMENT_OPENER_TOKENS for exactly that
// reason. Pulled out of the shared/base vocabulary; commitmentTurnVocabularyOk
// (the PINNED-sentence-only check, below) now admits them via
// COMMITMENT_OPENER_TOKENS as an explicit extra set instead, so "But yeah,
// we'll see you Sunday at noon." still grounds as the pinned sentence, but
// no OTHER sentence can borrow either word to launder a rejection.
const COMMITMENT_TURN_VOCAB = new Set([
  'so', 'ok', 'okay', 'alright', 'awesome', 'perfect', 'great', 'sounds',
  'good', 'yep', 'yes', 'and', 'then', 'all', 'set', 'right',
  'we', 'i', 'll', 'will', 're', 'are', 'you', 'your', 'it', 'that', 's',
  // Third-party point-of-contact commitments ("we'll see him Monday", a
  // booking made for someone other than the caller — codex P1, live miss
  // 17ed9362, a lender scheduling a WDO inspection for the homeowner) use
  // the ordinary object pronoun in place of "you"; the closed vocabulary
  // must carry it too.
  'him', 'her', 'them',
  'see', 'confirm', 'confirmed', 'confirming', 'book', 'booked', 'booking',
  'schedule', 'scheduled', 'have', 'put', 'get', 'got', 'be', 'come',
  'coming', 'out', 'there', 'down', 'visit', 'appointment', 'inspection',
  'for', 'at', 'on', 'the', 'this', 'of', 'to', 'in',
  'noon', 'midnight', 'am', 'pm', 'a', 'm', 'p', 'o', 'clock', 'morning', 'afternoon',
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  'just', 'let', 'us', 'know', 'anything', 'changes', 'if', 'comes', 'up',
  'need', 'needs', 'questions', 'thanks', 'thank', 'much', 'bye', 'talk',
  'soon', 'welcome', 'care', 'no', 'problem',
  // Ordinary, clearly non-contingent filler (codex round-3 whitelist
  // inversion — otherSentenceIsClean, below, requires every OTHER sentence
  // in the turn to be built from this same closed vocabulary, so a handful
  // of plain declarative words a non-conditional benign aside actually uses
  // had to join it): "go" (ordinary movement verb — "it should go to him");
  // "made"/"send"/"momentarily" (small-talk / "I'll send you a text
  // momentarily" filler). "should" is deliberately NOT here, and not in
  // BENIGN_CONDITIONAL_GLUE_WORDS either (codex round 7, P1): a FREE
  // "should" token let "We should get your okay." pass — no scheduling
  // predicate, no declarative-poison term, and the whole sentence was
  // otherwise vocabulary-safe once "should" was admitted anywhere. "should"
  // now only reaches a sentence through NOTIFICATION_ROUTING_RE, an
  // anchored whole-sentence shape, never a free token in any Set.
  'go', 'made', 'send', 'momentarily',
]);
// A tiny closed set of CONNECTOR/filler words for a benign CONDITIONAL
// sentence's carve-out ONLY (codex round-3 whitelist inversion) — never the
// base COMMITMENT_TURN_VOCAB, never the pinned commitment sentence. Unlocked
// only once the sentence has already cleared BOTH gates: it has a
// conditional trigger, AND every extracted clause is benign (clauseIsBenign).
// At that point the sentence's remaining tokens are just how the agent
// phrases resolving a benign routing mixup ("let me know", "goes to the
// wrong person/number", "I'll make sure that gets figured out") — words too
// specific/generic to trust unconditionally everywhere else in the turn.
// Codex round 4, finding 2 (live miss 17ed9362's actual single Agent:
// turn): "It's autonomously done, so if it goes to you, I'll make sure
// that's rectified." needs "autonomously"/"done"/"rectified" once its one
// clause ("it goes to you") clears clauseIsBenign against the PREVIOUS
// sentence's "notification".
//
// "should" was here too, for the non-conditional declarative's OWN
// vocabulary check in otherSentenceIsClean (round 5) — "Yep, it should go
// to him, the notification." Codex round 7, P1: a FREE "should" token in
// ANY set otherSentenceIsClean's vocabulary check consults is available to
// EVERY sentence, conditional or not, and "We should get your okay."
// otherwise named no declarative-poison term and no scheduling predicate.
// "should" is now recognized ONLY via NOTIFICATION_ROUTING_RE, an anchored
// whole-sentence shape (below) — never as a free token here.
const BENIGN_CONDITIONAL_GLUE_WORDS = new Set([
  'me', 'tell', 'goes', 'wrong', 'person', 'number', 'make', 'sure', 'gets', 'figured',
  'autonomously', 'done', 'rectified',
]);
// codex round 7, P1: the ONLY way "should" grounds any sentence now — the
// specific "a notification/email/text routes to a party" declarative shape
// ("Yep, it should go to him, the notification."), matched whole-sentence,
// never as a vocabulary token. Checked as an immediate pass in
// otherSentenceIsClean, the same way REINFORCING_AFFIRMATION_RE is.
// Codex round 18, P1 (:746): a bare "it"/"that" subject names no topic —
// after "who has to approve this?", "It should go to him." routes the
// DECISION, not a notification. A pronoun subject now grounds only when
// the sentence itself names the notification/email/text after it.
const NOTIFICATION_ROUTING_RE = /^(?:ok|okay|yep|yes|yeah|so|and)? ?(?:the (?:notification|email|text|confirmation text) should (?:go|be sent|be going) to (?:him|her|them|you|the (?:client|owner|homeowner|point of contact))(?: the (?:notification|email|text))?|(?:it|that) should (?:go|be sent|be going) to (?:him|her|them|you|the (?:client|owner|homeowner|point of contact)) the (?:notification|email|text))$/;
function turnVocabularyTokenOk(tok, extraSets) {
  if (!tok) return true;
  if (COMMITMENT_TURN_VOCAB.has(tok)) return true;
  if (extraSets && extraSets.some((set) => set.has(tok))) return true;
  if (/^\d{1,4}$/.test(tok)) return true;
  if (/^\d{1,2}(st|nd|rd|th)$/.test(tok)) return true;
  return false;
}
// PINNED-sentence-only vocabulary check (codex round 10, P1 :655): openers
// like "but"/"yeah" are valid ONLY at the head of the pinned commitment
// sentence itself (COMMITMENT_OPENER_TOKENS, below — turnHasAffirmativeCommitmentForm
// already requires them there), never as free tokens OTHER sentences can
// also draw on, so they're passed here as an explicit extra set rather than
// living in the shared COMMITMENT_TURN_VOCAB.
function commitmentTurnVocabularyOk(normalizedTurn) {
  return normalizedTurn.split(' ').every((tok) => turnVocabularyTokenOk(tok, [COMMITMENT_OPENER_TOKENS]));
}

// Affirmative sentence FORM (codex P0, interrogatives): normalization strips
// punctuation, so "Will you be there Sunday at noon?" survives the closed
// vocabulary. After optional discourse openers, the turn must BEGIN with a
// first-person commitment head — interrogative-initial forms (will/are/can
// leading) never match and fail closed.
const COMMITMENT_OPENER_TOKENS = new Set([
  'so', 'ok', 'okay', 'alright', 'awesome', 'perfect', 'great', 'sounds',
  'good', 'yep', 'yes', 'yeah', 'but', 'and', 'then', 'all', 'right',
]);
// Full head+predicate templates (codex P0, round 7f): a bare first-person
// prefix accepted non-commitments ("we will NEED YOU TO CONFIRM…"). The
// commitment PREDICATE is part of the template — anything after the subject
// that isn't an explicit commitment verb phrase fails closed. "See him"/
// "see her"/"see them" (codex P1, live miss 17ed9362) cover a booking made
// for a third-party point of contact, not the caller.
const COMMITMENT_HEADS = [
  'we ll see you ', 'we will see you ', 'i ll see you ', 'i will see you ',
  'we ll see him ', 'we will see him ', 'i ll see him ', 'i will see him ',
  'we ll see her ', 'we will see her ', 'i ll see her ', 'i will see her ',
  'we ll see them ', 'we will see them ', 'i ll see them ', 'i will see them ',
  'we ll confirm ', 'we will confirm ', 'i ll confirm ', 'i will confirm ',
  'we ll be there ', 'we will be there ', 'we ll be out ', 'we will be out ',
  'we ll come ', 'we will come ',
  'we ll book you ', 'we will book you ',
  'we ll get you on the schedule ', 'we will get you on the schedule ',
  'we ll put you on the schedule ', 'we will put you on the schedule ',
  'we ll have you down ', 'we will have you down ',
  'we re confirmed', 'we are confirmed', 'we re on for ', 'we are on for ',
  'you re confirmed', 'you are confirmed', 'you re booked', 'you are booked',
  'you re all set', 'you are all set', 'you re on the schedule',
  'you are on the schedule', 'it s confirmed',
];
// Complete-sentence grammar (codex P0, round 7k): a prefix-only head check
// accepted meaning-inverting tails ("you are all set TO CONFIRM Sunday at
// noon", "we will see you Sunday at noon AND YOU NEED TO CONFIRM"). The
// whole sentence must now parse as: openers* + commitment head + slot words
// only + at most one exact benign closer. Slot words are the closed glue/
// day/date/time set — anything else after the head fails closed.
const SLOT_WORDS = new Set([
  'for', 'at', 'on', 'the', 'this', 'it', 'of',
  'noon', 'midnight', 'am', 'pm', 'a', 'm', 'p', 'o', 'clock',
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
]);
const BENIGN_CLOSERS = [
  'and just let us know if anything changes',
  'just let us know if anything changes',
  'and let us know if anything changes',
  'let us know if anything changes',
  'and thanks so much', 'thanks so much', 'thank you', 'see you then',
];
function turnHasAffirmativeCommitmentForm(normalizedTurn) {
  const toks = normalizedTurn.split(' ').filter(Boolean);
  let i = 0;
  while (i < toks.length && COMMITMENT_OPENER_TOKENS.has(toks[i])) i += 1;
  let rest = `${toks.slice(i).join(' ')} `;
  const head = COMMITMENT_HEADS.find((h) => rest.startsWith(h));
  if (!head) return false;
  rest = rest.slice(head.length).trim();
  for (const closer of BENIGN_CLOSERS) {
    if (rest === closer || rest.endsWith(` ${closer}`)) {
      rest = rest.slice(0, rest.length - closer.length).trim();
      break;
    }
  }
  return rest.split(' ').every((tok) => (
    !tok
    || SLOT_WORDS.has(tok)
    || /^\d{1,4}$/.test(tok)
    || /^\d{1,2}(st|nd|rd|th)$/.test(tok)
  ));
}

// Shared normalization for commitment text: lowercase alnum tokens with the
// punctuated day-period collapse ("10 a.m." → "10 am") applied consistently
// to quotes AND sentences, so containment never breaks on formatting.
function normalizeCommitmentText(s) {
  return ` ${normalizeForGrounding(s)} `.replace(/ ([ap]) m(?= )/g, ' $1m').replace(/\s+/g, ' ').trim();
}

// SENTENCE-scoped grounding (codex P0, round 7i): checking form on the TURN
// while binding the slot from the QUOTE let a splice through — "We will see
// you Tuesday at 10 AM. Are you booked Sunday at noon?" with the second
// sentence pinned passed the form check via the first. Sentence boundaries
// are preserved (split on .!?; after collapsing "a.m."/"p.m." so the
// abbreviation dots don't split), and the PINNED sentence (the one
// containing the quote) must: pass the negation/conditional screens,
// satisfy the closed vocabulary AND the affirmative commitment form, and
// bind the slot. A quote spanning sentences grounds nowhere and fails
// closed; if the quote appears in several sentences, EVERY one must pass
// (ambiguity fails closed).
//
// OTHER sentences of the same turn (codex P1, live miss 17ed9362: Adam's
// turn was "Awesome. Yep, it should go to him, the notification. It's
// autonomously done, so if it goes to you, I'll make sure that's rectified.
// But yeah, we'll see him on Monday at 10 o'clock." — the pinned quote was
// the last sentence, and an earlier round's turn-wide vocabulary/conditional
// screen poisoned it over a CONDITIONAL ABOUT WHICH INBOX GETS THE EMAIL
// NOTIFICATION, not about the booking) do not need the closed commitment
// vocabulary VERBATIM — but codex round 3 converged this from a BLACKLIST
// ("poison when it contains X/Y/Z") to a WHITELIST (otherSentenceIsClean,
// below), the same inversion the pinned sentence's commitmentTurnVocabularyOk
// already used. Three successive blacklist rounds (interrogatives, negation/
// hedge, authorization/unavailability vocabulary, conditional-clause topic
// scoping) kept missing shapes nobody had enumerated yet — "cancel",
// "permitting", "contingent", "space", "actually" were never on any poison
// list, so "Actually, we have to cancel.", "Weather permitting.", and "If we
// have space I'll email you." (the consequent verb swallowing the actual
// condition) all read as clean turns. A whitelist needs no such list: those
// words simply aren't IN the closed vocabulary either.
//
// otherSentenceIsClean (codex round 5 converged this further): OTHER
// sentences may not talk about scheduling AT ALL — only the pinned
// commitment sentence is allowed scheduling/booking vocabulary. Rounds 3-4
// still relied on vocabulary MEMBERSHIP (a growing word list) as the
// primary gate, and round 5 found that growing the shared vocabulary for
// one shape ("should", "confirmation") quietly opened new holes for
// another ("We should confirm the appointment." passed because every word,
// including "should", happened to be vocab). The real invariant is
// SCHEDULING CONTENT, not word membership: after the interrogative,
// negation/hedge, and declarative-poison screens, every benign topic
// PHRASE (who a notification/email/text/invoice/report goes to) is
// stripped out of the sentence's text first (stripBenignTopicPhrases —
// phrase-scoped only; the individual words are never added to any
// vocabulary Set), and if any SCHEDULING_PREDICATE_TERM remains in what's
// left, the sentence poisons — zero new words needed for
// "confirm"/"appointment"/"book" shapes ever again. A conditional sentence
// gets ONE further requirement on top, never a substitute: every extracted
// clause must still be benign (clauseIsBenign — unchanged: still runs the
// authorization/unavailability/scheduling-staffing poison-term checks
// against the clause's own raw text, still requires a benign topic, still
// falls back to the previous sentence only for a bare-pronoun clause).
// Only after both the predicate screen (and, for a conditional, the clause
// check) pass does the STRIPPED text still have to be built from the base
// vocabulary plus the small BENIGN_CONDITIONAL_GLUE_WORDS filler set. This
// is what still lets "Yep, it should go to him, the notification." (no
// scheduling term once "notification" is phrase-stripped) and "It's
// autonomously done, so if it goes to you, I'll make sure that's
// rectified." (a bare-pronoun clause resolving against the previous
// sentence's benign topic) ground, while "We should confirm the
// appointment.", "We need your confirmation of the appointment.", and "If
// you need it, we will book the appointment." all fail on "confirm"/
// "confirmation"/"book"+"appointment" — present in the SCHEDULING_PREDICATE_TERMS
// screen regardless of conditional structure or vocabulary membership.
// Splits one speaker turn into its sentences. Sentence chunks KEEP their
// terminator (codex P0, round 7n): splitting on [.!?;]+ discarded the "?"
// that makes "So we will confirm it for noon on Sunday?" a QUESTION — an
// interrogative sentence can never be the commitment sentence. "a.m."/
// "p.m." abbreviation dots are collapsed first so they don't split a
// sentence in two.
function splitSentences(turn) {
  const chunks = (String(turn).replace(/\b([ap])\.\s?m\.?/gi, '$1m').match(/[^.!?;]+[.!?;]*/g) || []);
  return chunks
    .map((c) => ({ raw: c, ns: normalizeCommitmentText(c), interrogative: c.includes('?') }))
    .filter((s) => s.ns);
}

// Codex round 23, P1 (:958): the commitment can be taken back in a LATER
// agent turn ("Agent: We'll see you Sunday at 10 o'clock." … "Agent:
// Actually, Sunday won't work."), and only the pinned turn was ever read.
// Later agent turns get a retraction screen — not the allowlist (they are
// ordinary call wrap-up: address, email, questions): any negation/hedge,
// any authorization/unavailability poison, an explicit change marker, or
// scheduling content that does not itself bind the SAME confirmed slot
// retracts the commitment and holds the call for a human.
const RETRACTION_MARKER_TERMS = [
  ' actually ', ' instead ', ' change ', ' changed ', ' switch ', ' move ', ' moved ',
  ' cancel ', ' cancelled ', ' canceled ', ' scratch that ', ' never mind ', ' nevermind ',
  ' wait ', ' hold on ', ' correction ', ' sorry ',
];
function laterAgentSentenceRetracts(sentence, confirmedStartAt, callStartedAt) {
  const ns = sentence.ns;
  const padded = ` ${ns} `;
  if (turnHasNegationOrHedge(ns)) return true;
  if (sentenceHasDeclarativePoisonVocabulary(ns)) return true;
  if (RETRACTION_MARKER_TERMS.some((t) => padded.includes(t))) return true;
  // Codex round 24, P1 (:958): slot binding alone let "Sunday at noon is
  // off." through as a same-slot mention. A later sentence with scheduling
  // content passes only as a full RESTATEMENT — the same checks the pinned
  // commitment sentence itself must pass.
  if (sentenceHasSchedulingPredicate(stripBenignTopicPhrases(ns))) {
    return !(!sentence.interrogative
      && commitmentTurnVocabularyOk(ns)
      && !turnHasUnresolvedConditional(ns)
      && turnHasAffirmativeCommitmentForm(ns)
      && quoteBindsConfirmedSlot(ns, confirmedStartAt, callStartedAt));
  }
  return false;
}
function agentCommitmentSentenceVerified(quote, transcript, confirmedStartAt, callStartedAt) {
  const q = normalizeCommitmentText(quote);
  if (!q || q.length < 12) return false;
  const agentTurns = [];
  let sawCaller = false;
  for (const line of String(transcript || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = line.match(/^\s*(agent|caller)\s*:\s*(.*)$/i);
    if (!m) return false;
    if (m[1].toLowerCase() === 'agent') agentTurns.push(m[2]);
    else sawCaller = true;
  }
  if (!agentTurns.length || !sawCaller) return false;
  const containing = [];
  for (let t = 0; t < agentTurns.length; t += 1) {
    const sentences = splitSentences(agentTurns[t]);
    for (let i = 0; i < sentences.length; i += 1) {
      const s = sentences[i];
      if (!s.ns.includes(q)) continue;
      const otherSentencesClean = sentences.every((other, j) => j === i
        || otherSentenceIsClean(other, sentences[j - 1]?.ns));
      const laterTurnsClean = agentTurns.slice(t + 1).every((later) => splitSentences(later)
        .every((ls) => !laterAgentSentenceRetracts(ls, confirmedStartAt, callStartedAt)));
      containing.push({ ...s, otherSentencesClean: otherSentencesClean && laterTurnsClean });
    }
  }
  if (!containing.length) return false;
  return containing.every(({ ns, interrogative, otherSentencesClean }) => !interrogative
    && otherSentencesClean
    // codex round 4: the PINNED sentence gets the same unconditional
    // declarative-poison screen as every other sentence — "we'll see you
    // Sunday, he still needs to confirm" already fails
    // turnHasAffirmativeCommitmentForm's slot-word-only tail below, but
    // that's the form check's accident, not a guarantee this screen makes
    // explicit.
    && !sentenceHasDeclarativePoisonVocabulary(ns)
    && commitmentTurnVocabularyOk(ns)
    && !turnHasNegationOrHedge(ns)
    && !turnHasUnresolvedConditional(ns)
    && turnHasAffirmativeCommitmentForm(ns)
    && quoteBindsConfirmedSlot(ns, confirmedStartAt, callStartedAt));
}

// Slot binding (codex round-2 P1): the grounded commitment quote must refer
// to the SAME slot the extraction put in confirmed_start_at — a call that
// discusses several dates can otherwise pair an agent commitment to Tuesday
// at 10 with a model mix-up that left Sunday noon in confirmed_start_at, and
// the unauthorized Sunday appointment books. Deterministic token check on the
// normalized quote: it must contain BOTH the confirmed slot's ET weekday
// name AND its ET hour in a spoken form ("noon"/"midnight" or the 12-hour
// number). Relative-day commitments ("we'll see you tomorrow at 10") fail —
// conservative and accepted: the call date isn't threaded here, so relative
// days can't be verified and those calls stay in triage.
const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];

// Adjacent-sentence poisoning for agentCommitmentSentenceVerified (codex P1,
// live miss 17ed9362; hardened after a local-fallback-auditor P1 on an
// earlier allowlist-of-bad-topics draft of this check). DEFAULT IS POISON —
// a conditional elsewhere in the grounding turn poisons the pinned
// commitment unless it is IDENTIFIABLY about one of a small, curated set of
// known-benign, non-booking topics (who a notification/email/text/invoice/
// report goes to). This is the same "blacklists can't enumerate everything,
// so fail closed by default" shape as the closed commitment vocabulary
// above: "if we have space", "if the technician has time", "weather
// permitting" all still poison with NO term enumerated for any of them —
// unlike an allowlist of bad topics (homeowner/approval/schedule/…), a
// denylist of GOOD topics never needs to anticipate every way a booking can
// still be conditional.
// codex round 5: also covers "confirmation email"/"confirmation sms"/"text
// message"/"email notification" — the SAME communication-channel-routing
// topic, phrased with a different pair of words agents actually use.
const BENIGN_NON_BOOKING_TOPICS = [
  ' notification ', ' notifications ', ' notify ', ' email ', ' e mail ',
  ' text ', ' texts ', ' invoice ', ' invoices ', ' report ', ' reports ',
  ' inbox ', ' confirmation text ', ' confirmation email ', ' confirmation sms ',
  ' text message ', ' email notification ',
];
// Longest-phrase-first ordering for stripBenignTopicPhrases, below: " text "
// is itself a listed phrase, so stripping in list order would remove "text"
// out of "confirmation text" BEFORE the two-word phrase ever gets a chance
// to match, stranding a bare "confirmation" in the sentence — and
// "confirmation" is deliberately a SCHEDULING_PREDICATE_TERM (codex round
// 5, instruction 3: "confirmation" exists ONLY inside this phrase list, so
// it must always be consumed as part of a whole multi-word phrase, never
// left as a stray token). Sorting longest-first guarantees a multi-word
// phrase is always tried before any of its component single words.
const BENIGN_NON_BOOKING_TOPICS_BY_LENGTH_DESC = [...BENIGN_NON_BOOKING_TOPICS]
  .sort((a, b) => b.length - a.length);
// Removes every benign topic PHRASE from a normalized sentence, leaving
// everything else untouched (codex round 5: reverts round 3's merge of
// these phrases' individual words into COMMITMENT_TURN_VOCAB — a token
// like "confirmation" must never sit in ANY vocabulary Set; the topic is
// handled by deleting it from the TEXT before either the
// SCHEDULING_PREDICATE_TERMS screen or the vocabulary check ever sees it).
function stripBenignTopicPhrases(ns) {
  let stripped = ` ${ns} `;
  for (const phrase of BENIGN_NON_BOOKING_TOPICS_BY_LENGTH_DESC) {
    stripped = stripped.split(phrase).join(' ');
  }
  return stripped.replace(/\s+/g, ' ').trim();
}
// Declarative poison vocabulary (codex P1, rounds 1-2 of this PR's local+
// Codex audit): a sentence naming who has to sign off, the act of
// approving/authorizing, an unmet-approval DECLARATIVE ("Homeowner approval
// is still required."), or a plain statement that someone/something is
// unavailable poisons the pinned commitment REGARDLESS of conditional
// structure — none of "That still needs the homeowner's sign-off.",
// "Homeowner approval is still required.", or "The technician is
// unavailable." carries an "if"/"unless"/"subject to" trigger word, so a
// conditional-gated screen alone never sees them. Checked unconditionally,
// before any conditional-structure test. Built as two proper phrase lists
// (not a single narrow token like the old ` unable `) so a future round
// adds a phrase here without touching the flow below.
const AUTHORIZATION_PARTY_OR_ACT_TERMS = [
  ' homeowner ', ' owner ', ' landlord ', ' tenant ',
  ' approve ', ' approves ', ' approved ', ' approval ',
  ' sign off ', ' authorize ', ' authorizes ', ' authorized ', ' authorization ',
  ' permission ', ' confirm with ', ' check with ', ' run it by ',
  ' needs to okay ', ' decision maker ', ' decision ', ' okay with ', ' ok with ',
  ' still required ', ' still needs ', ' still need ',
  ' needs approval ', ' need approval ', ' pending approval ',
  ' waiting on ', ' waiting to hear ', ' need to confirm ', ' needs to confirm ',
  ' have to confirm ', ' has to confirm ', ' get back to you ', ' getting back to you ',
  ' need the go ahead ', ' needs the go ahead ', ' need the ok ', ' needs the ok ',
];
const UNAVAILABILITY_TERMS = [
  ' unavailable ', ' not available ', ' no availability ', ' booked up ',
  ' fully booked ', ' no openings ', ' no opening ', ' cant make ', ' can t make ',
  ' cannot make ', ' cannot ', ' unable ', ' not free ', ' has no time ',
  ' doesn t have time ', ' does not have time ',
  // Codex round 11, P1 (:1331): "We are (all) booked." is the business
  // stating it has NO capacity — the same meaning as "booked up"/"fully
  // booked". Anchored to the first-person-plural subject so "You're all
  // booked." / "It's booked." (the caller's slot) are untouched.
  ' we are booked ', ' we re booked ', ' we are all booked ', ' we re all booked ',
];
// Anchored companion to AUTHORIZATION_PARTY_OR_ACT_TERMS (codex round 4,
// finding 1): "I need him to confirm the appointment." names no term from
// that phrase list, and every one of its individual WORDS (i/need/him/to/
// confirm/the/appointment) is ordinary COMMITMENT_TURN_VOCAB on its own —
// round 3's assumption that these two lists are "by construction" excluded
// from the base vocabulary was true only because the words each list uses
// happened not to overlap with base vocab THEN; "him"/"need"/"confirm" are
// all base vocab now. Two anchored SHAPES (never an ever-growing word list):
//   (a) "need(s)"/"going to need" + a PARTY (him/her/them/someone/the
//       owner/the homeowner/the client — codex round 8: also the CALLER
//       themself, you/us/me/you guys/y'all, normalized text strips
//       apostrophes so "y all" — "I need YOU to okay it." names no party
//       from the original third-party-only list, since the caller isn't a
//       third party) + "to" + an AUTHORIZATION VERB (confirm/approve/sign
//       off/sign/okay/ok/authorize), with an optional trailing object
//       (codex round 8: "okay IT"/"sign off ON IT"/"confirm IT" are the
//       same shape as the bare verb, just with a pronoun object) — the
//       third-party INFINITIVE form, "I need him/you TO confirm (it)".
//   (b) codex round 6, P1: "We need your okay." names no party/verb pair
//       from shape (a) either (it's a DIRECT OBJECT, not "him to confirm").
//       "need(s)/going to need/waiting on/waiting for" + a POSSESSIVE
//       (your/his/her/their/the owner's/the homeowner's/the client's —
//       normalized text strips apostrophes, so "owner s") + an
//       AUTHORIZATION NOUN (okay/ok/approval/confirmation/go ahead/sign
//       off/permission/authorization/blessing) directly, no "to <verb>".
// Codex round 13, P1 (:1084): "We need your yes." — a bare "yes" is an
// authorization noun too ("your yes" = your approval), as is "green light".
// One shared alternative for every approval-noun shape below (possessive,
// request, non-possessive), so a noun added once poisons in all three.
// ("go-ahead"/"sign-off" normalize to "go ahead"/"sign off".)
// The OBJECT-form approval PARTY shared by every anchored approval shape
// below (third parties and the caller themself; normalized text strips
// apostrophes, so "y all"). Codex round 14, P1 (:1037): hoisted into one
// alternative so the delegated-decision shape reuses exactly this set, with
// "my boss"/"the boss" added (only ever widens what poisons).
const APPROVAL_PARTY_ALT = '(?:him|her|them|someone|the owner|the homeowner|the client|you|us|me|you guys|y all|my boss|the boss|his boss|her boss)';
const AUTHORIZATION_NOUN_ALT = '(?:okay|ok|yes|approval|confirmation|go ahead|green light|sign off|permission|authorization|blessing)';
const AUTHORIZATION_NEED_RE = new RegExp(`\\b(?:(?:need|needs|going to need) ${APPROVAL_PARTY_ALT} to (?:confirm|approve|sign off|sign|okay|ok|authorize)(?: it| on it)?|(?:need|needs|going to need|waiting on|waiting for) (?:your|his|her|their|the owner s|the homeowner s|the client s) ${AUTHORIZATION_NOUN_ALT})\\b`);
// codex round 7, P1(b): AUTHORIZATION_NEED_RE covers "need"/"waiting on"
// TRIGGERS; this covers the ACT of chasing that authorization down —
// "should get your okay.", "have to get his sign off.", "once we have your
// go ahead" — none of which say "need" or "waiting on" at all. Anchored
// SHAPE, not a word list: (get/getting/obtain/secure/have/wait for/waiting
// for) + a POSSESSIVE (your/his/her/their/the owner's/the homeowner's/the
// client's — normalized text strips apostrophes) + an AUTHORIZATION NOUN.
const APPROVAL_REQUEST_RE = new RegExp(`\\b(?:get|getting|obtain|secure|have|wait for|waiting for) (?:your|his|her|their|the (?:owner|homeowner|client) s) ${AUTHORIZATION_NOUN_ALT}\\b`);
// Codex round 10, P1 (:1044): the NON-possessive form — "We need the
// okay." / "Just have to get an approval." — names the same outstanding
// authorization with an article instead of an owner. Fails closed: "we
// have the okay" also poisons, which only ever leaves a turn in triage.
// Codex round 16, P1 (:1109): DEMONSTRATIVE determiners — "We need that
// okay." / "need this approval" — are the same outstanding-authorization
// shape, so that/this/any join the determiner set.
// Codex round 22, P1 (:1121): ASR/elliptical "We need yes." drops the
// determiner. For the unambiguous NEED verbs (need/require/wait for) the
// determiner is now optional; get/have keep requiring one, since "have
// okay"/"get yes" are not natural and "okay"/"yes" double as openers.
const NON_POSSESSIVE_APPROVAL_RE = new RegExp(`\\b(?:(?:need|needs|needed|require|requires|get|getting|obtain|secure|have|wait for|waiting for) (?:the|an|a|some|that|this|any)|need|needs|needed|require|requires|wait for|waiting for) ${AUTHORIZATION_NOUN_ALT}\\b`);
// Codex round 9, P1 (:713): neither AUTHORIZATION_NEED_RE nor
// APPROVAL_REQUEST_RE covers a DIRECTIVE the agent gives to have a third
// party grant approval — "I will tell him to okay it." names no "need"/
// "waiting"/"get...your" trigger, and every one of its words
// (i/will/him/to/okay/it) is ordinary COMMITMENT_TURN_VOCAB; "tell" itself
// only reached the sentence because BENIGN_CONDITIONAL_GLUE_WORDS is passed
// to turnVocabularyTokenOk for EVERY other sentence in otherSentenceIsClean,
// not just a conditional one (see that Set's comment) — so the whole
// sentence read as clean. A third anchored SHAPE, same family as (a)/(b)
// above: (tell/ask/have/get) + a PARTY (the same third-party/caller set as
// AUTHORIZATION_NEED_RE) + an optional "to" + an AUTHORIZATION VERB
// (confirm/approve/sign off/sign/okay/ok/authorize), with the same optional
// trailing object ("it"/"on it") — "tell him to okay it", "ask her to
// approve it", "have him sign off on it". "to" is optional because the
// causative forms ("have"/"get") read naturally without it ("have him sign
// off"); being lenient here only widens what poisons, never what grounds.
// Codex round 20, P1 (:1138): the directive can go through a CHANNEL —
// "We'll text him to okay it." / "We'll send him a link to approve it." —
// and stripBenignTopicPhrases later removes the channel verb, leaving only
// whitelisted words. Channel verbs join the directive set, and up to three
// object words ("a link", "the email") may sit between the party and "to".
const THIRD_PARTY_APPROVAL_DIRECTIVE_RE = new RegExp(`\\b(?:tell|ask|have|get|text|txt|email|e mail|message|call|phone|ring|remind|ping|contact|send|shoot) ${APPROVAL_PARTY_ALT} (?:(?:[a-z]+ ){0,3}to )?(?:confirm|approve|sign off|sign|okay|ok|authorize)(?: it| on it)?\\b`);
// Codex round 9, P1 (:1048): AUTHORIZATION_NEED_RE's shape (a) only covers
// "need(s) <PARTY> to <verb>" where the party needing to act is the OBJECT
// of "need" — it never matches a SUBJECT-LED phrasing where the party
// needing to act IS the sentence's subject: "You need to okay it." names no
// object party at all (there's nothing between "need" and "to"), and every
// one of its words (you/need/to/okay/it) is ordinary COMMITMENT_TURN_VOCAB,
// so it read as clean. A fourth anchored SHAPE, same family as (a)/(b)/the
// third-party directive above: a PARTY (the same third-party/caller set,
// now including the "he/she/they" subject forms and "you"/"y'all"/"you
// guys" for the caller) as the SENTENCE'S SUBJECT, directly followed by a
// need-auxiliary (need/needs/have/has/got/gotta/must), an optional "to",
// and an AUTHORIZATION VERB, with the same optional trailing object
// ("it"/"on it") as the other shapes — "you need to okay it", "he has to
// sign off", "they must approve it", "you guys gotta authorize it". Also
// covers the phrase-verb "give the go ahead" (no trailing-object variant
// needed; the phrase already ends the verb).
// Codex round 11, P1 (:1126): FIRST-PERSON subjects — "I need to okay
// it." / "We need to okay it." — are the same outstanding-approval shape
// (the agent's side still has to authorize), so "i"/"we" join the subject
// set. The auxiliary + authorization-verb anchor is unchanged: "We have
// confirmed" / "I have okayed it" never match ("confirm"/"okay" must end at
// a word boundary), so the past-tense reinforcement forms still ground.
// Codex round 12, P1 (:1137): a FUTURE/MODAL auxiliary between the subject
// and the need-auxiliary — "You'll need to okay it." normalizes to "you ll
// need to okay it", and "ll"/"will" are whitelisted, so the subject was never
// directly followed by "need". Up to two modal/adverb tokens (ll/will/would/
// d/should/may/might/shall/re going to/are going to/going to/gonna/still/
// also/just) may now sit between them — "you'll need to", "you will have
// to", "they're going to need to", "he'll still have to". Only widens what
// poisons; the auxiliary + authorization-verb anchor is unchanged.
// Codex round 19, P1 (:1169, :1215): the subject can also be MISSING —
// an ASR fragment ("Need to okay it.", "Have to okay it.") at the start of
// the sentence after at most two openers — or INHERITED through a
// coordinator ("You may get a text and need to okay it." — the benign
// routing span carried the subject, so no subject sits before "need").
// Both now take the same slot as a named subject; the auxiliary +
// authorization-verb anchor is unchanged.
const SUBJECT_LED_APPROVAL_NEED_RE = /(?:^(?:(?:so|and|but|yeah|yep|yes|ok|okay|alright) ){0,2}|\b(?:i|we|you|he|she|they|someone|the owner|the homeowner|the client|y all|you guys|and|or|but|then|so|also) )(?:(?:ll|will|would|d|should|may|might|shall|re going to|are going to|is going to|going to|re gonna|are gonna|gonna|still|also|just) ){0,2}(?:need|needs|have|has|got|gotta|must)(?: to)? (?:confirm|approve|sign off|sign|okay|ok|authorize|give the go ahead)(?: it| on it)?\b/;
// Unconditional declarative-poison check (codex rounds 2, 4, 7, 9 and this
// round): either term list, or any anchored shape, anywhere in the sentence
// poisons regardless of conditional structure. Restored as a real function
// and run FIRST in otherSentenceIsClean's whitelist (codex round 4, finding
// 1) — round 3 assumed the vocabulary early-return alone would already
// reject these words, but "him"/"need"/"confirm"/"the"/"appointment" are all
// in COMMITMENT_TURN_VOCAB, so commitmentTurnVocabularyOk(other.ns) returned
// true and short-circuited past clauseIsBenign entirely, before it ever
// ran. This screen must run BEFORE the whitelist early return, not after.
// It also guards the PINNED commitment sentence
// (agentCommitmentSentenceVerified's final check, below) as a second,
// independent layer: "we'll see you Sunday, he still needs to confirm"
// already fails turnHasAffirmativeCommitmentForm's slot-word-only tail
// today, but that's an accident of the form check, not a guarantee — this
// check makes the safety property explicit rather than incidental.
// Codex round 14, P1 (:1037): a DELEGATED decision — "It's up to him." —
// names no approval verb or noun at all, and every word (it/s/up/to/him) is
// ordinary COMMITMENT_TURN_VOCAB. Anchored shape: (it's/that's) + optional
// "all" + (up to/on) + APPROVAL_PARTY_ALT ("It's up to him", "That's on the
// owner"), a bare "up to <PARTY>" fragment ("Up to you."), or a SUBJECT
// party that decides ("He decides", "The owner has the final say", "You
// make the call").
const DELEGATED_DECISION_RE = new RegExp(`\\b(?:(?:(?:it s|it is|its|that s|that is|thats) (?:all )?)?up to ${APPROVAL_PARTY_ALT}|(?:it s|it is|its|that s|that is|thats) (?:all )?on ${APPROVAL_PARTY_ALT}|(?:he|she|they|someone|the owner|the homeowner|the client|you|y all|you guys|my boss|the boss|his boss|her boss) (?:decides|decide|makes the call|make the call|has the final say|have the final say|has to decide|have to decide|gets to decide|get to decide))\\b`);
// Codex round 14, P1 (:1476): agent/caller-side MODAL uncertainty — "We may
// get you in." — stayed clean because "may" is vocabulary (the month). A
// subject + (may/might/could possibly/should be able to/may|might|could be
// able to) poisons. The month use never has a subject directly before it
// followed by a word ("see you May 3rd"/"May the 3rd" are excluded by the
// lookahead; "in May" has no subject), and the benign notification-routing
// modals ("it may go to him", "you may get a text") are removed first by
// BENIGN_MODAL_ROUTING_RE, an anchored phrase, before the test.
// Codex round 15, P1 (:1192): stripping the benign span whole also stripped
// its SUBJECT, so a verb coordinated onto it — "It may go to him and may put
// you down." / "…go to him, may put you down." — lost the subject the
// regex keys on. The benign span is now replaced by its own subject (the
// span is exempt, the subject is not), and a coordinator (and/or/but/then/
// so/also) directly before the modal counts as carrying the subject over.
// "It may go to him." / "You may get a text." alone still leave only the
// bare subject behind, so they stay benign.
const MODAL_UNCERTAINTY_RE = /\b(?:we|i|you|it|that|this|he|she|they|and|or|but|then|so|also) (?:may(?= [a-z])(?! the \d)|might|could possibly|should be able to|may be able to|might be able to|could be able to)\b/;
// Codex round 18, P1 (:746), same rule as NOTIFICATION_ROUTING_RE: a bare
// "It may go to him." names no topic and can route the decision itself, so
// the pronoun form is benign only with the notification/email/text named.
const BENIGN_MODAL_ROUTING_RE = /\b(?:(you) may (?:get|receive) (?:a|an|the) (?:text message|text|email|notification|confirmation text|confirmation email)|(it|that) may (?:go|be sent|be going) to (?:him|her|them|you) the (?:notification|email|text))\b/g;
function sentenceHasModalUncertainty(ns) {
  return MODAL_UNCERTAINTY_RE.test(ns.replace(BENIGN_MODAL_ROUTING_RE, (_span, you, itThat) => you || itThat));
}
// Codex round 17, P1 (:1020): an approval named as the SUBJECT of a future
// or pending verb — "The okay will come in the email." / "Your approval
// should come through." — is still outstanding authorization, and once the
// benign topic ("email") is stripped every remaining token is whitelisted.
// Anchored shape on the RAW sentence: a determiner + an approval noun
// (AUTHORIZATION_NOUN_ALT minus "confirmation", which names the ordinary
// booking-confirmation message: "The confirmation will come by text.") + a
// future/pending auxiliary.
// Codex round 18, P1 (:1213): ASR drops the article — "Okay will come in
// the email." The determiner is now optional for the unambiguous approval
// nouns anywhere, and for okay/ok/yes (also ordinary discourse openers) at
// the start of the sentence, after at most one opener.
const PENDING_APPROVAL_AUX_ALT = '(?:will|ll|would|should|shall|is going to|s going to|has to|needs to|still|is still|s still|is coming|s coming|comes|come|is pending|s pending)';
const PENDING_APPROVAL_SUBJECT_RE = new RegExp(
  `\\b(?:(?:the|your|his|her|their|that|this|an|a|our) )?(?:approval|go ahead|green light|sign off|permission|authorization|blessing) ${PENDING_APPROVAL_AUX_ALT}\\b`
  + `|\\b(?:the|your|his|her|their|that|this|an|a|our) (?:okay|ok|yes) ${PENDING_APPROVAL_AUX_ALT}\\b`
  + `|^(?:(?:so|and|but|yeah|yep|yes|ok|okay|alright) )?(?:okay|ok|yes) ${PENDING_APPROVAL_AUX_ALT}\\b`,
);
// Codex round 21, P1 (:1143, :1181): the approval-verb family, closed at
// the VERB instead of per carrier. Every shape so far — directives ("tell
// him to okay it", "send the email to him to okay it"), needs ("need to
// okay it"), future promises ("You will okay it.") — puts an authorization
// verb right after an infinitive "to" or a modal/future auxiliary. That
// position alone now poisons, whoever the subject is and whatever
// channel or object sits before it. "confirm" is left out on purpose: it
// is a pinned commitment head ("We'll confirm you for…") and already a
// SCHEDULING_PREDICATE_TERMS entry for every other sentence.
const APPROVAL_VERB_USE_RE = /\b(?:to|will|ll|would|d|should|shall|can|could|must|gonna|may|might|please) (?:approve|sign off|sign|okay|ok|authorize|give the go ahead|give the okay|give the green light)\b/;
function sentenceHasDeclarativePoisonVocabulary(ns) {
  const padded = ` ${ns} `;
  return AUTHORIZATION_PARTY_OR_ACT_TERMS.some((t) => padded.includes(t))
    || UNAVAILABILITY_TERMS.some((t) => padded.includes(t))
    || AUTHORIZATION_NEED_RE.test(ns)
    || APPROVAL_REQUEST_RE.test(ns)
    || NON_POSSESSIVE_APPROVAL_RE.test(ns)
    || THIRD_PARTY_APPROVAL_DIRECTIVE_RE.test(ns)
    || SUBJECT_LED_APPROVAL_NEED_RE.test(ns)
    || DELEGATED_DECISION_RE.test(ns)
    || PENDING_APPROVAL_SUBJECT_RE.test(ns)
    || APPROVAL_VERB_USE_RE.test(ns)
    || sentenceHasModalUncertainty(ns);
}
// These two lists (and the regex above) ALSO do their work inside
// clauseIsBenign, below, where they matter for a different reason: a
// CONDITIONAL sentence's clause is checked directly against them (clause
// text is a raw-text substring, not yet vocabulary-tokenized) before the
// clause is ever allowed to unlock the expanded conditional-carve-out
// vocabulary in otherSentenceIsClean.
// Scheduling/availability/staffing vocabulary for CONDITION CLAUSES (codex
// P1, round 2 of this PR's local+Codex audit): a conditional clause is
// non-benign the instant it touches scheduling/staffing/availability, no
// matter what the sentence's CONSEQUENT says — "If the technician is
// available, I'll email you." must poison on "technician"/"available" in
// the CLAUSE, not read as benign because "email" sits in the consequent.
const CONDITION_CLAUSE_POISON_TERMS = [
  ' technician ', ' tech ', ' available ', ' availability ', ' unavailable ',
  ' schedule ', ' scheduled ', ' scheduling ', ' reschedule ', ' rescheduled ',
  ' appointment ', ' appointments ', ' visit ', ' staff ', ' staffing ',
  ' crew ', ' route ', ' slot ', ' calendar ', ' book ', ' booked ', ' booking ',
];
// Every conditional trigger word this PR's local+Codex audit has raised,
// used BOTH to split a sentence into its individual condition clauses (see
// extractConditionalClauses) and to decide whether a sentence is a
// conditional at all (turnHasUnresolvedConditional, above, folds these into
// CONDITIONAL_TOKENS as whole-token phrases). "if" is deliberately absent
// from CONDITIONAL_TOKENS (it gets the benign-closer exemption there) but
// IS a trigger here, so a clause that starts with an "if" nested inside an
// already-conditional sentence still gets split out and evaluated on its
// own. Bare "should" is deliberately EXCLUDED — "it should go to him" is
// ordinary modal usage, not a conditional; only the inverted "should the
// technician be unavailable…" construction is.
const CONDITION_TRIGGER_RE = /\b(if|unless|as long as|provided|once|when|assuming|subject to|depending|depends|pending|should the)\b/i;
// A first-person consequent head ("I'll"/"we'll"/"I will"/"we will") ends a
// condition clause the same way a comma does (codex P1, round 3: "If we
// have space I'll email you." has NO comma, so a comma-only boundary swept
// the benign consequent verb "email" into the SAME clause as the actual
// condition "we have space", and clauseIsBenign then read the whole thing
// as benign because "email" appears somewhere in it — the real condition,
// scheduling capacity, was never isolated). Whichever boundary — comma or
// consequent head — comes first in the raw text wins.
const CONSEQUENT_HEAD_RE = /\b(i'?ll|we'?ll|i will|we will)\b/i;
// Splits a raw sentence into EVERY condition clause it contains — not just
// the first (codex P1, finding 1: "If the email goes to you, let me know,
// AND IF the technician is available, I'll call you." has TWO clauses; a
// single-match extractor read only the benign first one and missed the
// technician-availability clause entirely). Each clause runs from just
// after its trigger word to the next comma, the next first-person
// consequent head, the next trigger word, or the end of the sentence —
// whichever comes first, so one clause never eats into the next or into
// its own consequent.
// Codex round 14, P1 (:1413): a clause also ends where a NEW SUBJECT head
// begins after its first word — "If the email goes to you then we are all
// set" / "…goes to you you're all set" has no comma and no I'll/we'll head,
// so the present-tense consequent rode inside the (benign-topic) antecedent
// clause and was never inspected as a consequent. Cutting there moves it
// into the consequent, where splitConditionalSentence's caller judges it.
// Only ever SHORTENS an antecedent (fail-closed direction).
const CLAUSE_SUBJECT_BOUNDARY_RE = /\S[\s,]+((?:then|we|i|you['\u2019]?re|you are|you['\u2019]?ll|you will|it['\u2019]?s|it is|that['\u2019]?s|that is|everything)\b)/i;
function conditionalClauseCut(segment) {
  const cuts = [segment.length];
  const commaIdx = segment.indexOf(',');
  if (commaIdx !== -1) cuts.push(commaIdx);
  const headMatch = CONSEQUENT_HEAD_RE.exec(segment);
  if (headMatch) cuts.push(headMatch.index);
  const subjectMatch = CLAUSE_SUBJECT_BOUNDARY_RE.exec(segment);
  if (subjectMatch) cuts.push(subjectMatch.index + subjectMatch[0].length - subjectMatch[1].length);
  return Math.min(...cuts);
}
// Splits a raw conditional sentence into its condition CLAUSES and every
// piece of text that is NOT a condition clause — the CONSEQUENTS (codex
// round 14: the text before the first trigger, e.g. "We'll put you down"
// in "We'll put you down if…", and the remainder of each trigger segment
// after its clause is cut). Both are returned normalized; empty pieces are
// dropped.
function splitConditionalSentence(rawSentence) {
  const s = String(rawSentence || '');
  const re = new RegExp(CONDITION_TRIGGER_RE.source, 'gi');
  const triggers = [...s.matchAll(re)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
  const clauses = [];
  const leading = triggers.length ? normalizeCommitmentText(s.slice(0, triggers[0].start)) : '';
  const consequents = triggers.length ? [leading] : [];
  // Codex round 19, P1 (:1543): every trigger needs its OWN consequent.
  // Filtering empty pieces let one trigger's benign consequent cover a
  // second, dangling one ("If the email goes to you, I'll make sure that's
  // rectified, and if the text goes to him." then "We're all set."). Only
  // the FIRST trigger may take the text before it ("Let me know if the
  // email goes to you.") as its consequent.
  let danglingTrigger = false;
  triggers.forEach((trigger, i) => {
    const segEnd = i + 1 < triggers.length ? triggers[i + 1].start : s.length;
    const segment = s.slice(trigger.end, segEnd);
    const cut = conditionalClauseCut(segment);
    const clause = normalizeCommitmentText(segment.slice(0, cut));
    if (clause) clauses.push(clause);
    const consequent = normalizeCommitmentText(segment.slice(cut));
    consequents.push(consequent);
    const own = trimConsequentFillers(consequent) || (i === 0 ? trimConsequentFillers(leading) : '');
    if (!own) danglingTrigger = true;
  });
  return { clauses, consequents: consequents.filter(Boolean), danglingTrigger };
}
function extractConditionalClauses(rawSentence) {
  return splitConditionalSentence(rawSentence).clauses;
}
const CONDITION_CLAUSE_GLUE_WORDS = new Set([
  'it', 'that', 'this', 'they', 'he', 'she', 'is', 'are', 'was', 'were',
  'does', 'do', 'did', 'goes', 'go', 'went', 'gone', 'comes', 'come', 'came',
  'to', 'you', 'us', 'we', 'i', 'me', 'him', 'her', 'them', 'not', 'up',
  'down', 'out', 'back', 'over', 'there', 'here', 's', 'll', 'd', 'the', 'a',
]);
function isBarePronounClause(clauseNs) {
  const toks = clauseNs.split(' ').filter(Boolean);
  return toks.length > 0 && toks.every((t) => CONDITION_CLAUSE_GLUE_WORDS.has(t));
}
// Decides whether ONE already-extracted, already-normalized condition
// clause is safe. DEFAULT IS POISON, same shape as the rest of this file:
// any authorization/unavailability/scheduling-staffing term ANYWHERE in the
// clause poisons it outright (codex P1, finding 5: the benign/poison call
// must be about the clause's own subject, never rescued by a benign word
// living in the sentence's consequent), and a clause is only benign when it
// is IDENTIFIABLY about one of the small, curated, non-booking topics (who
// a notification/email/text/invoice/report goes to). A BARE-PRONOUN clause
// ("if it does", "if it goes to you") names no topic of its own, so ONLY
// then does the referent resolve against the PREVIOUS sentence's benign
// nouns; a clause with any actual content word never falls back.
// Codex round 22, P1 (:1406): "If we are all set and the email goes to
// you" — one benign topic ("email") anywhere in the clause used to clear
// the WHOLE compound antecedent, booking-status half included. A clause
// coordinated with and/or/but is now judged per component: every
// component must be benign on its own.
const CLAUSE_COORDINATOR_RE = / (?:and|or|but) /;
const BENIGN_CLAUSE_SHAPE_RE = /^(?:(?:the|your|a|an|that|this) )?(?:confirmation text|confirmation email|confirmation sms|text message|email notification|notification|notifications|email|e mail|text|texts|invoice|invoices|report|reports) (?:goes|go|went|is going|gets sent|get sent|is sent|was sent|comes|ends up going|ends up) to (?:you|him|her|them|someone else|the wrong (?:person|number|email|address|inbox)|your (?:spam|junk)(?: folder)?|spam|junk)$/;
function clauseIsBenign(clauseNs, prevNs) {
  if (!clauseNs) return false;
  if (CLAUSE_COORDINATOR_RE.test(clauseNs)) {
    return clauseNs.split(CLAUSE_COORDINATOR_RE).every((part) => clauseComponentIsBenign(part.trim(), prevNs));
  }
  return clauseComponentIsBenign(clauseNs, prevNs);
}
function clauseComponentIsBenign(clauseNs, prevNs) {
  if (!clauseNs) return false;
  const padded = ` ${clauseNs} `;
  if (AUTHORIZATION_PARTY_OR_ACT_TERMS.some((t) => padded.includes(t))) return false;
  if (UNAVAILABILITY_TERMS.some((t) => padded.includes(t))) return false;
  if (AUTHORIZATION_NEED_RE.test(clauseNs)) return false;
  if (APPROVAL_REQUEST_RE.test(clauseNs)) return false;
  if (NON_POSSESSIVE_APPROVAL_RE.test(clauseNs)) return false;
  if (THIRD_PARTY_APPROVAL_DIRECTIVE_RE.test(clauseNs)) return false;
  if (SUBJECT_LED_APPROVAL_NEED_RE.test(clauseNs)) return false;
  if (APPROVAL_VERB_USE_RE.test(clauseNs)) return false;
  if (CONDITION_CLAUSE_POISON_TERMS.some((t) => padded.includes(t))) return false;
  // Codex round 23, P1 (:1429): a benign topic ANYWHERE in the clause used
  // to clear it, so an unpunctuated compound ("If we're all set the email
  // goes to you") rode through on "email". Same inversion as the owner's
  // other-sentence allowlist: the WHOLE clause must be the benign routing
  // shape — a notification/email/text/invoice/report going to a party.
  if (BENIGN_CLAUSE_SHAPE_RE.test(clauseNs)) return true;
  if (prevNs && isBarePronounClause(clauseNs)) {
    const prevPadded = ` ${prevNs} `;
    if (BENIGN_NON_BOOKING_TOPICS.some((t) => prevPadded.includes(t))) return true;
  }
  return false;
}
// Codex round 5: the vocabulary-membership approach itself was the
// recurring hole — growing COMMITMENT_TURN_VOCAB for one shape ("should")
// silently widened what EVERY other sentence could say, and a merged
// benign-topic token ("confirmation") turned out to double as an ordinary
// scheduling word. The converged invariant instead: OTHER sentences may
// not talk about scheduling AT ALL. SCHEDULING_PREDICATE_TERMS is checked
// on the sentence's text directly (after benign topic PHRASES are
// stripped, so a genuine "confirmation text"/"email notification" aside
// never trips it) — one list, whole-token/phrase matched, that needs no
// growth for a "confirm"/"appointment"/"book"/"schedule" shape ever again,
// regardless of what other vocabulary exists.
// codex round 6, P2 (:1179): bare ' may ' collided with the MODAL verb —
// "Yep, it may go to him, the notification." poisoned on the month name.
// "may" is deliberately ABSENT from this list; MAY_DATE_RE below recognizes
// it only in genuine date-shaped usage (adjacent to a day number), leaving
// the modal use alone. Every other month name stays a plain phrase entry —
// none of them collide with an ordinary English word the way "may" does.
const SCHEDULING_PREDICATE_TERMS = [
  ' confirm ', ' confirms ', ' confirmed ', ' confirmation ',
  // Codex round 18, P1 (:1375): COMMITMENT_TURN_VOCAB admits "confirming"
  // and "inspection", so an OTHER sentence built on them ("We need you
  // confirming it.") must count as scheduling content too.
  ' confirming ', ' inspection ', ' inspections ',
  // Codex round 21, P1 (:1426): booking idioms built from whitelisted words
  // ("Need to put you down.") — any "<party> down" and "get <party> in".
  ' you down ', ' him down ', ' her down ', ' them down ', ' us down ',
  // Codex round 22, P1 (:1439): "put you in" too — any "<party> in"
  // (get/put/have/squeeze … you in), not one verb at a time.
  ' you in ', ' him in ', ' her in ', ' them in ', ' us in ',
  ' coming out ',
  ' appointment ', ' appointments ',
  ' book ', ' booked ', ' booking ',
  ' schedule ', ' scheduled ', ' scheduling ', ' reschedule ', ' rescheduled ',
  ' visit ', ' visits ',
  ' see you ', ' see him ', ' see her ', ' see them ',
  ' be there ', ' be out ', ' come out ',
  ' sunday ', ' monday ', ' tuesday ', ' wednesday ', ' thursday ', ' friday ', ' saturday ',
  ' january ', ' february ', ' march ', ' april ', ' june ', ' july ',
  ' august ', ' september ', ' october ', ' november ', ' december ',
  ' tomorrow ', ' today ', ' tonight ', ' next week ',
  ' am ', ' pm ', ' clock ', ' noon ', ' midnight ',
  // Codex round 16, P1 (:1373): spoken day periods are admitted by
  // COMMITMENT_TURN_VOCAB, so an OTHER sentence naming one ("We're set for
  // the morning.") must count as scheduling content, like am/pm.
  ' morning ', ' afternoon ',
  ' technician ', ' tech ', ' crew ', ' route ', ' slot ', ' calendar ',
  ' available ', ' availability ', ' unavailable ',
  ' quote ', ' estimate ', ' price ',
];
// "May" recognized ONLY in date-shaped usage — a day number or ordinal
// immediately adjacent, either order ("May 3rd" / "3rd of May" / "3 May"),
// or with "the" between month and day ("May the 3rd" — codex round 9, P1
// :1263: the original alternation required the day number to sit directly
// after "may", so "That's set for May the 3rd." bypassed it entirely; an
// optional "the " between the month and the day covers the same date shape
// spoken the other common way).
// Codex round 15, P1 (:1377): "We are set for May." names the month with no
// day number. A month-context preposition or determiner directly before
// "may" is the other unambiguous month shape — "for/in/by/until/through/
// since/next/this/last/early/late/mid/end of/beginning of/middle of May" —
// and is scheduling content too. Modal "may" never follows these words with
// the meaning of a verb except "this may <verb>", which MODAL_UNCERTAINTY_RE
// already poisons, so counting it here only ever fails closed; "it may go to
// him" / "you may get a text" have no such word before "may" and stay benign.
const MAY_DATE_RE = /\bmay (?:the )?\d{1,2}(?:st|nd|rd|th)?\b|\b\d{1,2}(?:st|nd|rd|th)? (?:of )?may\b|\b(?:for|in|by|until|till|through|since|next|this|last|early|late|mid|end of|beginning of|middle of) may\b/;
// codex round 6, P2 (:1234): a purely REINFORCING affirmative in an OTHER
// sentence ("You're confirmed.") was getting caught by the
// SCHEDULING_PREDICATE_TERMS screen on "confirmed" — but it adds no new
// scheduling FACT (no day, no time, no place), it only echoes agreement
// with whatever the pinned sentence already states. Recognized as a narrow,
// WHOLE-SENTENCE anchored shape only — never via vocabulary, and never
// allowed to grow past this exact structure: an optional single opener,
// then a subject ("you're"/"we're"/"it's"/"that's"), then an optional
// "all", then one closing affirmative verb, and NOTHING else. Anything
// longer — a reason clause, a weekday, a condition — falls through to the
// ordinary screens below and is judged on its own content, same as any
// other sentence ("You're confirmed once he approves." still poisons via
// the declarative-poison screen on "approves"; "You're confirmed for
// Sunday." still poisons via SCHEDULING_PREDICATE_TERMS on "sunday" — a
// weekday is new scheduling information this narrow shape was never meant
// to cover).
// codex round 7, P2: a direct PAST-TENSE reinforcement from the agent's own
// voice ("We confirmed your appointment.") is the same no-new-fact shape as
// "You're confirmed." above, just phrased in first person with an explicit
// object — extended as a second alternative, still whole-sentence anchored,
// still nothing allowed after the object ("We confirmed your appointment
// for Sunday." still poisons — a weekday is new information outside this
// shape) and still requiring a completed verb ("We'll confirm your
// appointment." uses "confirm", not "confirmed", so it never matches
// either alternative — and as a PINNED sentence it fails
// turnHasAffirmativeCommitmentForm regardless, since it states no slot).
// Codex round 11, P1 (:1331): "booked" is accepted ONLY after a subject
// that names the caller's slot (you/it/that). After "we re"/"we are" it is
// a capacity statement ("We are all booked." = no openings), which also
// poisons via UNAVAILABILITY_TERMS; the we-subject alternative keeps the
// other completions ("We're all set.").
const REINFORCING_AFFIRMATION_RE = /^(?:(?:ok|okay|awesome|perfect|great|alright|so|yep|yes|yeah|and)? ?(?:(?:you re|you are|it s|it is|that s|that is) (?:all )?(?:confirmed|set|booked|good to go|on the books|locked in)|(?:we re|we are) (?:all )?(?:confirmed|set|good to go|on the books|locked in))|(?:ok|okay|awesome|perfect|great|alright|so|yep|yes|yeah|and)? ?(?:we|i) (?:have )?(?:confirmed|booked|scheduled|got you (?:down|booked|scheduled)) (?:your|the|that|this) (?:appointment|visit|service|slot)(?: for you)?)$/;
// True when a normalized sentence (already run through
// stripBenignTopicPhrases) still talks about scheduling — either a term
// from the phrase list above, the date-shaped "May" regex, or a bare 1-4
// digit "time-looking" token (an hour, a bare date number, OR — codex round
// 9, P1 :1263 — that same date number spelled as an ORDINAL, "3rd"/"31st").
// turnVocabularyTokenOk (the final whitelist check every OTHER sentence's
// stripped text still has to pass) already admits a bare `\d{1,2}(st|nd|rd|
// th)` token as ordinary vocabulary — it has to, so the PINNED sentence can
// state "the 3rd" — but this predicate screen never recognized that same
// token as scheduling CONTENT, so "We're set for the 3rd." (an OTHER
// sentence naming a date with no weekday/month/"confirm" term at all)
// cleared every check and never poisoned. Deliberately broad on the digit
// check: fails closed to triage on any short number (an address, a price
// without cents) rather than risk missing a real time or date mention — the
// safe direction for an OTHER sentence, which is never the one that needs to
// state a time.
// Codex round 10, P1 (:1345): a conditional's CONSEQUENT can itself be a
// full booking commitment — "If the email goes to you, we'll have you
// down." has a benign antecedent (clauseIsBenign only ever extracts and
// checks the antecedent, never the consequent — see extractConditionalClauses,
// above), and its consequent "we'll have you down" names no
// SCHEDULING_PREDICATE_TERMS phrase at all ("have you down" was never added
// to that list). Every word of the consequent (we/ll/have/you/down) is
// ordinary COMMITMENT_TURN_VOCAB or BENIGN_CONDITIONAL_GLUE_WORDS
// ("goes" — unlocked once the antecedent clears clauseIsBenign), so the
// sentence read as clean and a second, un-grounded booking commitment
// slipped through as "benign" scheduling routing chatter. Rather than fork
// a growing list of consequent-commitment phrasings, reuse the SAME
// COMMITMENT_HEADS templates the pinned-sentence binder already recognizes
// as a booking commitment (turnHasAffirmativeCommitmentForm, above): any
// one of those exact head phrases appearing anywhere in the (stripped)
// sentence is, by construction, scheduling content, so it counts toward
// this predicate screen the same as any SCHEDULING_PREDICATE_TERMS phrase.
function sentenceContainsCommitmentHead(strippedNs) {
  const padded = ` ${strippedNs} `;
  return COMMITMENT_HEADS.some((head) => padded.includes(` ${head.endsWith(' ') ? head : `${head} `}`));
}
// Codex round 13, P1 (:1397) / round 14, P1 (:1413): a conditional
// sentence's CONSEQUENT is judged on its own, and it is GUILTY UNLESS it is
// one of the known-benign shapes below. Round 13 poisoned only an agent
// future/ability head (we'll/I can + verb); "If the email goes to you, then
// we are all set." is a present-tense commitment that named no such head,
// no scheduling term, and only vocabulary words, so it read as a benign
// aside. Inverting the rule closes the class: every consequent piece (text
// before the first trigger, and each trigger segment's remainder after its
// clause — see splitConditionalSentence) must, after dropping edge
// discourse fillers, match one ANCHORED whole-piece exemption:
//   - the notification-remediation promise ("I'll make sure that's
//     rectified" / "…that gets figured out" — the live 17ed9362 turn),
//   - "let me/us know" (the benign-routing test's consequent),
//   - "it's autonomously done" (the live 17ed9362 turn's preface before
//     "so if it goes to you").
// Anything riding along after an exemption ("…rectified and we'll have you
// down") breaks the anchor and poisons.
const BENIGN_CONDITIONAL_CONSEQUENT_RES = [
  /^(?:i|we) (?:ll|will) make sure (?:that|it) (?:s|is|gets) (?:rectified|figured out|done)$/,
  /^let (?:me|us) know$/,
  /^(?:it s|it is) autonomously done$/,
];
const CONSEQUENT_LEADING_FILLERS = new Set(['so', 'then', 'and', 'yep', 'yes', 'yeah', 'ok', 'okay', 'alright']);
const CONSEQUENT_TRAILING_FILLERS = new Set(['so', 'then', 'and']);
function trimConsequentFillers(consequentNs) {
  const toks = consequentNs.split(' ').filter(Boolean);
  while (toks.length && CONSEQUENT_LEADING_FILLERS.has(toks[0])) toks.shift();
  while (toks.length && CONSEQUENT_TRAILING_FILLERS.has(toks[toks.length - 1])) toks.pop();
  return toks.join(' ');
}
// Codex round 15, P1 (:1537): a DANGLING antecedent — a conditional sentence
// with no consequent at all ("If the email goes to you." followed by "We're
// all set.") — is unexempted too. Sentence punctuation had split the
// consequent into the next sentence, where the reinforcing-affirmation
// shape passed it on its own; the dangling half now poisons instead.
function conditionalConsequentIsUnexempted(rawSentence) {
  const split = splitConditionalSentence(rawSentence);
  const consequents = split.consequents
    .map(trimConsequentFillers)
    .filter(Boolean);
  return !consequents.length
    || split.danglingTrigger
    || consequents.some((c) => !BENIGN_CONDITIONAL_CONSEQUENT_RES.some((re) => re.test(c)));
}
function sentenceHasSchedulingPredicate(strippedNs) {
  const padded = ` ${strippedNs} `;
  if (MAY_DATE_RE.test(strippedNs)) return true;
  if (SCHEDULING_PREDICATE_TERMS.some((t) => padded.includes(t))) return true;
  if (sentenceContainsCommitmentHead(strippedNs)) return true;
  // Codex round 15, P1 (:1487): the vocabulary whitelist admits 1-4 digit
  // tokens, so the screen must reject the same width — "We are set for
  // 2027." (a year) and "We're set for 1030." (a run-together time) named
  // scheduling content through a 4-digit token this screen used to skip.
  return strippedNs.split(' ').some((tok) => /^\d{1,4}(?:st|nd|rd|th)?$/.test(tok));
}
// Top-level CLEARANCE test for ONE sentence OTHER than the pinned
// commitment sentence (agentCommitmentSentenceVerified calls this for every
// sentence in the turn). Order matters:
//   1. Not a question (still asking, not committing).
//   2. No negation/hedge (turnHasNegationOrHedge — defense in depth).
//   3. No declarative poison vocabulary (sentenceHasDeclarativePoisonVocabulary
//      — codex round 4: an authorization/unavailability phrase or the
//      anchored "need <party> to <authorize>" shape poisons UNCONDITIONALLY,
//      checked before anything below ever runs, because a closed vocabulary
//      of ordinary words — "him"/"need"/"confirm"/"the"/"appointment" — can
//      never express that SHAPE on its own).
//   4. A purely REINFORCING affirmative ("You're confirmed."/"We confirmed
//      your appointment.") passes immediately, checked as a narrow
//      whole-sentence ANCHORED shape (REINFORCING_AFFIRMATION_RE, codex
//      rounds 6-7 — never via vocabulary), before the scheduling-predicate
//      screen ever sees "confirmed"/"booked"/etc. Anything longer than the
//      exact shape falls through to the ordinary screens below.
//   5. The narrow notification-routing declarative ("Yep, it should go to
//      him, the notification.") also passes immediately, checked the same
//      way (NOTIFICATION_ROUTING_RE, codex round 7, P1) — the only place
//      "should" grounds a sentence at all now that it is not a free token
//      in any vocabulary Set.
//   6. No SCHEDULING_PREDICATE_TERM in the sentence once benign topic
//      phrases are stripped out (codex round 5, above) — "We should confirm
//      the appointment.", "We need your confirmation of the appointment.",
//      and "If you need it, we will book the appointment." all poison here,
//      on "confirm"/"confirmation"/"book"+"appointment", regardless of
//      conditional structure or vocabulary membership.
//   7. A CONDITIONAL sentence gets ONE further requirement ON TOP of (not
//      instead of) the STRIPPED-text vocabulary check below: every
//      extracted clause must be benign (clauseIsBenign — unchanged: still
//      runs the authorization/unavailability/scheduling-staffing poison-term
//      checks against each clause's own raw text, still requires a benign
//      topic, still falls back to the previous sentence only for a
//      bare-pronoun clause), AND every consequent piece must match an
//      anchored benign exemption (conditionalConsequentIsUnexempted — codex
//      rounds 13-14: guilty unless known-benign). A
//      conditional sentence can only pass through
//      this carve-out — vocabulary-only clearance is never enough for it,
//      unlike a non-conditional declarative.
//   8. Whatever remains of the STRIPPED text must be built from the base
//      COMMITMENT_TURN_VOCAB plus the small BENIGN_CONDITIONAL_GLUE_WORDS
//      filler set (never the raw, unstripped text — the benign topic words
//      are gone by now and never need to sit in any vocabulary Set at all).
// The allowlist itself (owner ruling 2026-09-26). Every entry is a WHOLE
// normalized sentence (^…$); a sentence that adds anything to one of these
// shapes falls off the list and holds the call for a human. The poison
// screens above still run first, as defense in depth.
const ACK_ALT = '(?:ok|okay|awesome|perfect|great|alright|all right|sounds good|yep|yes|yeah|no problem|got it|cool|wonderful|excellent|we made it)';
const COURTESY_ALT = '(?:thanks|thank you(?: so much| very much)?|bye(?: bye)?|talk to you soon|have a (?:good|great|nice) (?:day|one|night|evening|weekend)|take care|you re welcome)';
const BENIGN_SEND_TOPIC_ALT = '(?:(?:a|an|the|your) )?(?:confirmation text|confirmation email|text message|text|email|invoice|report|receipt|notification)';
const SEND_TIMING_ALT = '(?: (?:momentarily|shortly|soon|now|right now|right away|today))?';
const OTHER_SENTENCE_ALLOWED_SHAPES = [
  // bare acknowledgements: "Awesome." / "Yes." / "No problem." / "Awesome, we made it."
  new RegExp(`^${ACK_ALT}(?: ${ACK_ALT})*$`),
  // courtesy closers: "Thank you so much." / "Have a good one." / "Okay, bye."
  new RegExp(`^(?:${ACK_ALT} )*${COURTESY_ALT}(?: ${COURTESY_ALT})*$`),
  // the let-us-know closer: "Just let us know if anything changes, thanks."
  new RegExp(`^(?:${ACK_ALT} )*(?:just )?let (?:us|me) know if (?:anything changes|that changes|anything comes up|something comes up|you need anything|you have any questions)(?: ${COURTESY_ALT})*$`),
  // a benign document/notification send: "I'll email you the invoice." /
  // "I'll send you a confirmation text momentarily."
  new RegExp(`^(?:${ACK_ALT} )*(?:i|we) (?:ll|will|am going to|are going to|re going to) (?:send|email|text) (?:you|him|her|them) ${BENIGN_SEND_TOPIC_ALT}${SEND_TIMING_ALT}$`),
  // a notice the customer will receive: "You may get a text." / "You'll get an email shortly."
  new RegExp(`^(?:${ACK_ALT} )*you (?:ll|will|may|should|re going to|are going to) (?:get|receive) ${BENIGN_SEND_TOPIC_ALT}${SEND_TIMING_ALT}$`),
  // modal notification routing with the topic named: "Yep, it may go to him, the notification."
  new RegExp(`^(?:${ACK_ALT} )*(?:(?:it|that) (?:may|will) (?:go|be sent|be going) to (?:him|her|them|you) the (?:notification|email|text)|the (?:notification|email|text|confirmation text) (?:may|will) (?:go|be sent|be going) to (?:him|her|them|you))$`),
];
function otherSentenceIsClean(other, prevNs) {
  if (other.interrogative) return false;
  if (turnHasNegationOrHedge(other.ns)) return false;
  if (sentenceHasDeclarativePoisonVocabulary(other.ns)) return false;
  if (REINFORCING_AFFIRMATION_RE.test(other.ns)) return true;
  if (NOTIFICATION_ROUTING_RE.test(other.ns)) return true;
  const stripped = stripBenignTopicPhrases(other.ns);
  if (sentenceHasSchedulingPredicate(stripped)) return false;
  // The glue set unlocks ONLY for a sentence whose conditional clauses all
  // cleared clauseIsBenign (codex round 9, P1 :713 root cause) — a plain
  // declarative gets the base vocabulary alone, so "I will tell him to okay
  // it." can never borrow "tell" from the conditional carve-out.
  if (turnHasUnresolvedConditional(other.ns)) {
    const clauses = extractConditionalClauses(other.raw);
    if (!clauses.length || !clauses.every((clause) => clauseIsBenign(clause, prevNs))) return false;
    if (conditionalConsequentIsUnexempted(other.raw)) return false;
    return stripped.split(' ').every((tok) => turnVocabularyTokenOk(tok, [BENIGN_CONDITIONAL_GLUE_WORDS]));
  }
  // Owner ruling 2026-09-26 (after codex round 22): a NON-conditional
  // OTHER sentence grounds only if it IS one of the known-benign shapes —
  // guilty unless allowlisted, the same inversion that converged the
  // conditional consequent (rounds 13-14). Rounds 4-22 each found a new
  // sentence built purely from COMMITMENT_TURN_VOCAB words ("We'll see.",
  // "Need to put you in.", "We need yes.") that the vocabulary screen read
  // as a clean aside; vocabulary membership no longer clears anything here.
  return OTHER_SENTENCE_ALLOWED_SHAPES.some((re) => re.test(other.ns));
}

// Canonical ET wall clock (codex P0, round 7h): the BOOKING path preserves
// the LITERAL wall clock of an ET-offset timestamp even when the seasonal
// offset is wrong (see v2IsoToEtWallClock in call-recording-processor.js —
// a July "12:00-05:00" books NOON, not the 13:00 EDT instant). Binding must
// validate the same wall clock booking writes, or a quote for 1 PM could
// authorize a visit that books at noon. Mirrors that helper exactly:
// ET offsets → literal wall clock; Z/foreign offsets → instant rendered in
// ET; no offset → literal. Returns "YYYY-MM-DDTHH:MM" or null.
function etWallClockOfConfirmedStart(value) {
  const raw = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)) return null;
  if (/(?:-04:?00|-05:?00)$/.test(raw)) return raw.slice(0, 16);
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      try {
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
        }).formatToParts(parsed).map((p) => [p.type, p.value]));
        return `${parts.year}-${parts.month}-${parts.day}T${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`;
      } catch { return null; }
    }
    return null;
  }
  return raw.slice(0, 16);
}

// Slot facts of the confirmed start, from the CANONICAL ET wall clock — the
// same value booking writes (see etWallClockOfConfirmedStart above). Null
// when the slot is unreadable or outside the calendar window below.
//
// Calendar disambiguation (codex round-5 P1, tightened round 7): a weekday
// name alone cannot distinguish "this Sunday" from "next Sunday". Compare
// ET CALENDAR dates (an absolute 168h window is not calendar-unique around
// DST transitions) and require the slot to fall 1–6 ET days after the
// call's ET date: same-day is rejected (a "Sunday" spoken on a Sunday is
// ambiguous between today and next week) and day 7 is rejected (same
// weekday again). Within 1–6 days every weekday names exactly one date.
function confirmedSlotFacts(confirmedStartAt, callStartedAt) {
  const wall = etWallClockOfConfirmedStart(confirmedStartAt);
  const call = new Date(String(callStartedAt || ''));
  if (!wall || Number.isNaN(call.getTime())) return null;
  const [year, month, day, hour] = [[0, 4], [5, 7], [8, 10], [11, 13]].map(([a, b]) => Number(wall.slice(a, b)));
  let dayDiff;
  try {
    const callYmd = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(call);
    dayDiff = (Date.UTC(year, month - 1, day) - Date.parse(`${callYmd}T00:00:00Z`)) / 86400000;
  } catch { return null; }
  // A calendar date is timezone-free, so the UTC day-of-week of the wall
  // date is exact.
  const weekday = WEEKDAY_NAMES[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  const monthName = MONTH_NAMES[month - 1];
  if (!(dayDiff >= 1 && dayDiff <= 6) || !weekday || !monthName) return null;
  return { year, month, day, weekday, monthName, hour12: hour % 12 || 12, period: hour >= 12 ? 'pm' : 'am' };
}

// What ONE normalized sentence says about a slot, parsed once into a flat
// mention structure (codex round 13, P2: the binder used to interleave
// parsing and comparison in one 57-branch function). Every field is
// slot-independent; SLOT_BINDING_CHECKS, below, compares it to the slot.
//
// Numbers: every RUN of consecutive number tokens is kept with its
// position (codex round-7j/7k: position matters, not just membership —
// "Sunday 8/2/2 at noon" must not bind a 2026-08-02 slot because the
// trailing 2 happens to equal the day). A lone number directly after
// "the", a weekday, or a month name is in DATE position (codex round 11,
// P1 :1605 — "Sunday the 10 at 10 o'clock" must match the slot DAY, not
// just the hour) unless the next token marks it as an hour (am/pm/o'clock:
// "the 10 o'clock slot", "Sunday 10 am").
//
// Times (codex round-5 P1 — exact binding, not presence): period-attached
// hours ("10 am", "10 00 am"), noon (12 pm) / midnight (12 am), "N
// o'clock" with an optional attached period, and a bare "at N" ONLY when
// it ends the sentence or precedes "on <weekday>" (anywhere else "at 10" is
// too likely an address or unrelated number). A form with no attached
// period (live miss 17ed9362: "at 10 o'clock") takes the sentence's
// STANDALONE period when it states one (codex round 13, P1 :1659: "We'll
// see you Sunday PM at 10." is 22:00, not the inferred 10:00), and only
// otherwise infers one from the Waves business day (7–11 morning, 12 noon,
// 1–6 afternoon). Mentions dedupe by meaning ("12 pm" + "noon" is one);
// any unparseable hour is an invalid mention and fails the binding.
const DATE_POSITION_PREV = new Set(['the', ...WEEKDAY_NAMES, ...MONTH_NAMES]);
const HOUR_MARKER_NEXT = new Set(['am', 'pm', 'o', 'oclock']);
// A period token is ATTACHED when it follows an hour ("10 pm", "10 00 pm")
// or an o'clock ("10 o'clock pm"); any other am/pm is a STANDALONE period.
const PERIOD_ATTACHED_PREV_RE = /^(?:\d{1,2}|clock|oclock)$/;
const DAY_NUMBER_RE = /^\d{1,2}(?:st|nd|rd|th)?$/;
const ORDINAL_DAY_RE = /^\d{1,2}(?:st|nd|rd|th)$/;
const SPOKEN_TIME_RES = [
  /(?:^| )(\d{1,2})(?: 00)? (am|pm)(?= |$)/g,
  /(?:^| )(\d{1,2}) o ?clock(?: (am|pm))?(?= |$)/g,
  new RegExp(`(?:^| )at (\\d{1,2})(?= $| on (?:${WEEKDAY_NAMES.join('|')})(?= |$))`, 'g'),
];
function inferPeriodFromBusinessHours(n) {
  if (n >= 7 && n <= 11) return 'am';
  return n >= 1 && n <= 12 ? 'pm' : null;
}
function parseSpokenSlot(normalizedSentence) {
  const ns = String(normalizedSentence || '');
  const toks = ns.split(' ');
  const at = (i) => toks[i] || '';
  const numberRuns = [];
  toks.forEach((tok, i) => {
    if (!/^\d{1,4}$/.test(tok)) return;
    if (!/^\d{1,4}$/.test(at(i - 1))) numberRuns.push({ nums: [], prev: at(i - 1) });
    numberRuns[numberRuns.length - 1].nums.push(Number(tok));
    numberRuns[numberRuns.length - 1].next = at(i + 1);
  });
  const periods = new Set(toks.filter((t, i) => (t === 'am' || t === 'pm') && !PERIOD_ATTACHED_PREV_RE.test(at(i - 1))));
  // More than one standalone period ("AM … PM") states no single period.
  const statedPeriod = periods.size === 1 ? [...periods][0] : null;
  const times = new Set(SPOKEN_TIME_RES.flatMap((re) => [...` ${ns} `.matchAll(re)].map((m) => {
    const n = Number(m[1]);
    const period = m[2] || (periods.size ? statedPeriod : inferPeriodFromBusinessHours(n));
    return n >= 1 && n <= 12 && period ? `${n} ${period}` : 'invalid';
  })));
  if (toks.includes('noon')) times.add('12 pm');
  if (toks.includes('midnight')) times.add('12 am');
  // Codex round 17, P1 (:1705): a LONE period initial right after the hour
  // ("10 o'clock p." → "10 o clock p") states a period the parser can't
  // read; falling back to business-hours inference would bind the wrong
  // half of the day. Reject the time outright (fails binding) instead.
  if (toks.some((t, i) => (t === 'a' || t === 'p') && PERIOD_ATTACHED_PREV_RE.test(at(i - 1)))) times.add('invalid');
  return {
    weekdays: new Set(toks.filter((t) => WEEKDAY_NAMES.includes(t))),
    months: new Set(toks.filter((t) => MONTH_NAMES.includes(t))),
    // The day number directly after each month name ("August 2nd").
    monthDays: toks.flatMap((t, i) => (MONTH_NAMES.includes(t) && DAY_NUMBER_RE.test(at(i + 1)) ? [parseInt(at(i + 1), 10)] : [])),
    ordinals: toks.filter((t) => ORDINAL_DAY_RE.test(t)).map((t) => parseInt(t, 10)),
    numberRuns: numberRuns.map(({ nums, prev, next }) => ({
      nums, datePosition: nums.length === 1 && DATE_POSITION_PREV.has(prev) && !HOUR_MARKER_NEXT.has(next),
    })),
    periods,
    times,
  };
}

// The complete numeric shapes a slot explains: [hour12] · [hour12, 00]
// (spoken ":00") · [day] · [month, day] · [month, day, year] with a 2- or
// 4-digit slot year. Anything else — extra components, stray street
// numbers, prices, a 3–4 digit non-year — fails closed.
const NUMBER_RUN_SHAPES = [
  (r, s) => r.length === 1 && (r[0] === s.hour12 || r[0] === s.day),
  (r, s) => r.length === 2 && r[0] === s.hour12 && r[1] === 0,
  (r, s) => r.length === 2 && r[0] === s.month && r[1] === s.day,
  (r, s) => r.length === 3 && r[0] === s.month && r[1] === s.day && (r[2] === s.year || r[2] === s.year % 100),
];
// Every check must hold. Negations can't be parsed deterministically, so any
// SECOND weekday or time mention fails closed — the extraction prompt
// directs the model to pin the single final commitment sentence.
const SLOT_BINDING_CHECKS = [
  // Exactly one weekday, the slot's.
  (said, slot) => said.weekdays.size === 1 && said.weekdays.has(slot.weekday),
  // Exactly one time mention, the slot's hour AND period.
  (said, slot) => said.times.size === 1 && said.times.has(`${slot.hour12} ${slot.period}`),
  // A standalone period ("Sunday PM at 10") must be the slot's (codex round 13).
  (said, slot) => [...said.periods].every((p) => p === slot.period),
  // Explicit calendar dates (codex P1): "Sunday, August 9, at noon" shares
  // weekday+time with an August 2 slot. Any month name must be the slot's
  // only month, immediately followed by the slot's day number.
  (said, slot) => !said.months.size
    || (said.months.size === 1 && said.months.has(slot.monthName) && said.monthDays[0] === slot.day),
  // Any ordinal ("the 9th") must be the slot's day.
  (said, slot) => said.ordinals.every((d) => d === slot.day),
  // Every number run is a complete shape the slot explains, and a lone
  // number in date position is the slot's day.
  (said, slot) => said.numberRuns.every((run) => (!run.datePosition || run.nums[0] === slot.day)
    && NUMBER_RUN_SHAPES.some((fits) => fits(run.nums, slot))),
];

// Binds one ALREADY-NORMALIZED commitment sentence (normalizeCommitmentText
// output) to the confirmed slot. Sentence-scoped by the caller: the slot
// facts come from the same utterance that passed the affirmative-form and
// vocabulary checks.
function quoteBindsConfirmedSlot(normalizedSentence, confirmedStartAt, callStartedAt) {
  const slot = confirmedSlotFacts(confirmedStartAt, callStartedAt);
  if (!slot) return false;
  const said = parseSpokenSlot(normalizedSentence);
  return SLOT_BINDING_CHECKS.every((check) => check(said, slot));
}

// True only when the model pinned an AGENT-spoken evidence quote for the
// scheduling.agent_committed_booking claim, that quote grounds against an
// agent turn of the source transcript (see agentQuoteGroundedInTranscript),
// AND the quote binds to the confirmed slot (see quoteBindsConfirmedSlot).
// The speaker label alone is NOT the trust boundary — it is model output like
// the rest of the extraction; the transcript grounding is what makes the
// commitment verifiable.
function hasAgentCommittedEvidence(extraction, transcript, callStartedAt) {
  return (Array.isArray(extraction?.evidence) ? extraction.evidence : []).some((e) => (
    String(e?.field_path || '') === '/scheduling/agent_committed_booking'
    && e?.speaker === 'agent'
    && agentCommitmentSentenceVerified(e?.quote, transcript, extraction?.scheduling?.confirmed_start_at, callStartedAt)
  ));
}

/**
 * True when `confirmed_start_at` lands exactly on an hour boundary (owner
 * rule: window_start is ALWAYS HH:00:00 — never :15/:30/:45). The booking
 * path copies this wall clock into window_start unchanged, so every gate
 * that newly ALLOWS a booking must check it.
 *
 * BOTH representations must be on the hour: the raw string's minutes AND
 * seconds (a schema-valid "T10:00:30" would copy a :30-second start), and
 * the canonical ET wall clock (a foreign offset like "+05:30" can carry raw
 * ":00" minutes yet book a ":30" ET wall time — the wall clock is what
 * booking writes, so it is the one that must be exact).
 */
function confirmedStartOnTheHour(confirmedStartAt) {
  // Minutes come from the canonical ET wall clock, NOT the raw string (codex
  // round-4 P2): a foreign offset like "2026-07-11T19:30:00+05:30" carries
  // raw :30 but converts to 10:00 ET, and the ET wall clock is what the
  // booking writes. Judging raw minutes parked valid hourly appointments.
  //
  // Seconds still come from the raw string, because
  // etWallClockOfConfirmedStart returns YYYY-MM-DDTHH:MM only — it has no
  // seconds to inspect. A schema-valid "T10:00:30" would otherwise copy a
  // :30-second start into window_start unchanged (the earlier round-4 P1
  // this guard was originally written for). Absent seconds count as zero.
  const rawSeconds = String(confirmedStartAt || '').match(/T\d{2}:\d{2}:(\d{2})/);
  if (rawSeconds && rawSeconds[1] !== '00') return false;
  const wall = etWallClockOfConfirmedStart(confirmedStartAt);
  return !!wall && wall.slice(14, 16) === '00';
}

// NO address-flag demotion lives here, deliberately (codex round-2 P1,
// 2026-08-01). An earlier revision of this PR demoted address_unverified /
// address_unverifiable when AV returned confirm_needed or missing_component
// with a normalized street at "premise-ish" granularity. That was unsound:
// address-validation/index.js derives those two statuses PRECISELY when the
// address is NOT verifiable — `missing_component` fires when granularity is
// not PREMISE/SUB_PREMISE (PREMISE_PROXIMITY means Google did NOT resolve a
// building), and `confirm_needed` fires on hasUnconfirmedComponents, whose
// own comment reads "Genuinely unverifiable ... Never auto-route these —
// hand to a human."
//
// There is also no narrower version worth writing: a verdict that IS a
// confirmed in-area premise already carries status validated_accept or
// corrected, neither of which raises an address block in the first place —
// so any such predicate is dead code by construction.
//
// An unverifiable address therefore keeps its hard block and reaches the
// office. The sanctioned way to rescue one is address-validation/recovery.js:
// when it confirms exactly ONE real premise the processor adopts it and files
// the advisory `address_recovered` read-back card. Do not re-add a
// routing-side demotion here.

// On-file address satisfaction (2026-09-20 call-agent audit, finding 1). A
// call from a customer we actively serve, whose record already carries a
// Google-verified address, and who stated NO address on this call — the V2
// extraction AND the merged V1 record agree, the same restatement rules the
// fail-open V1 conflict check applies — has nothing address-shaped to
// review: the tech is going where the tech always goes. In the 14 days to
// 2026-09-20, 67 BLOCKING address cards were filed on exactly this shape
// (every existing-customer scheduling call, even a plain cancellation), and
// the auto-resolver later closed them because "the customer record now has
// a service address on file". The four recoverable address flags are removed
// from BOTH the routing verdict and the card set, and recorded on the verdict
// (onFileAddressSatisfiedFlags) so ai_validation.routing keeps the audit
// trail. Never out_of_service_area — a hard block. Confirmed bookings are
// deliberately NOT touched here: they keep the gated fail-open contract in
// canAutoRoute, including its advisory read-back card.
function onFileAddressSatisfaction(flags, extraction, opts = {}) {
  const list = Array.isArray(flags) ? flags : [];
  const none = { flags: list, satisfied: [] };
  const known = opts.knownCustomer;
  // A COMPLETE on-file address: street AND ZIP, the same evidence the
  // auto-resolver's address_moot rule demands — hasAddress alone is derived
  // from address_line1 (codex r3 P2).
  if (!known || !known.hasAddress || !String(known.addressLine1 || '').trim() || !String(known.addressZip || '').trim()) return none;
  if (statesNewAddress(extraction, known)) return none;
  const rec = opts.canonicalRecord;
  if (rec && statesNewAddress({ property: { service_address: {
    street_line_1: rec.address_line1,
    street_line_2: rec.address_line2,
    city: rec.city,
    state: rec.state,
    postal_code: rec.zip,
  } } }, known)) return none;
  const satisfied = list.filter((f) => FAIL_OPEN_KNOWN_CUSTOMER_ADDRESS_FLAGS.has(f));
  if (!satisfied.length) return none;
  return { flags: list.filter((f) => !FAIL_OPEN_KNOWN_CUSTOMER_ADDRESS_FLAGS.has(f)), satisfied };
}

function canAutoRoute(extraction, opts = {}) {
  const out = {};
  const result = canAutoRouteDecision(extraction, opts, out);
  if (out.onFileAddressSatisfiedFlags?.length) result.onFileAddressSatisfiedFlags = out.onFileAddressSatisfiedFlags;
  return result;
}

function canAutoRouteDecision(extraction, opts = {}, out = {}) {
  if (!extraction) return { allowed: false, reason: 'no_extraction' };

  const modelFlags = suppressAddressFlagsForAV(suppressUnsupportedModelFlags(extraction.triage_flags, extraction), opts.addressValidation);
  const deterministicFlags = computeDeterministicTriageFlags(extraction, opts);
  const mergedFlags = mergeTriageFlags(modelFlags, deterministicFlags);
  // Unconfirmed calls only — EVERY confirmed status keeps the fail-open
  // contract below (see onFileAddressSatisfaction), including a confirmed
  // booking still missing its start time: the operator resolving that time
  // must still see the address review (codex #4617 r2 P2).
  const bookingConfirmed = extraction.scheduling?.status === 'confirmed';
  const onFile = bookingConfirmed
    ? { flags: mergedFlags, satisfied: [] }
    : onFileAddressSatisfaction(mergedFlags, extraction, opts);
  out.onFileAddressSatisfiedFlags = onFile.satisfied;
  const finalFlags = onFile.flags;
  // Allowlist, not blocklist (owner ruling 2026-07-31): only flags in
  // BLOCKING_TRIAGE_FLAGS may hold the appointment. Flags outside every
  // known set (new prompt vocabulary, model drift, hallucinated names) are
  // advisory-by-default — carried on failedOpenFlags below so a review card
  // still files while the booking proceeds.
  let appointmentBlockingFlags = finalFlags.filter((f) => BLOCKING_TRIAGE_FLAGS.has(f));
  const unknownFlags = finalFlags.filter((f) => !BLOCKING_TRIAGE_FLAGS.has(f)
    && !SMS_ONLY_FLAGS.has(f) && !ADVISORY_TRIAGE_FLAGS.has(f));

  // Fail-open booking (opts.failOpen): a CONFIRMED appointment must not die over
  // recoverable contact-field flags. Grounded in live misses (2026-07-10):
  // bookings blocked because the caller didn't recite a callback number (the ANI
  // is present), an existing customer didn't restate an address already on file,
  // or a garbled email tripped name_email_mismatch. The flag is still returned
  // (failedOpenFlags) so the office can confirm the field — it just no longer
  // holds the appointment. Hard blocks (out_of_service_area, do_not_contact,
  // caller_not_authorized, spam) are NOT recoverable and stay in the filter —
  // the ONE gated exception is the agent-commitment block below, which demotes
  // caller_not_authorized (only) when OUR agent committed to the slot.
  // Fail-open exists for CONFIRMED bookings only (the feature's contract).
  // An unconfirmed call keeps every flag, so when it blocks on not_confirmed
  // the blocked branch still files the contact/address/name review cards
  // that protect the customer/lead writes — not just the time card.
  const failedOpenFlags = [];
  for (const f of unknownFlags) {
    if (!failedOpenFlags.includes(f)) failedOpenFlags.push(f);
  }
  const confirmedWithStart = extraction.scheduling?.status === 'confirmed'
    && !!extraction.scheduling?.confirmed_start_at;
  // Hoisted: the auto-route exit below also needs to know whether this booking
  // would dispatch to the customer's on-file (already Google-verified) address
  // rather than one stated on this call.
  const knownCustomerHasAddress = !!(opts.knownCustomer && opts.knownCustomer.hasAddress);
  const newAddressGiven = statesNewAddress(extraction, opts.knownCustomer);
  if (opts.failOpen && confirmedWithStart) {
    const aniPresent = String(opts.callerAni || '').replace(/\D/g, '').length >= 10;
    const knownCustomer = !!opts.knownCustomer;
    // A new lead's validated on-file address (addressOnly) lifts the address
    // flags below and nothing else; the confidence exemption stays with
    // established customers (codex #4685 r1 P1).
    const knownCustomerConfidenceTrusted = knownCustomer && !opts.knownCustomer.addressOnly;
    // Address fail-open applies ONLY when the caller did NOT give a new service
    // address on this call — i.e. we're using their on-file, Google-verified
    // address (Barbara's case: she didn't restate it). If they DID provide an
    // address and Google Address Validation couldn't accept it (that's why the
    // flag survived suppressAddressFlagsForAV), a new/secondary/ambiguous
    // address is NOT auto-approved — AV still governs new addresses. ANY
    // service-address component counts as "new address given" — a partial
    // location (city/ZIP/unit only) that AV returns missing_component/
    // unverified for must still stay blocked, or the booking fallback would
    // stamp the customer's on-file primary address instead of the stated one.
    // raw_text counts too: a spoken address the parser couldn't split into
    // components survives ONLY there, and it's still a new address. State/
    // region alone does NOT count — this is a Florida-only portal, "FL" by
    // itself locates nothing (buildAddressLines ignores state-only addresses
    // for the same reason), and treating it as evidence would keep the
    // on-file-address recovery dark for confirmed known-customer bookings.
    // A spoken community/subdivision ("the Lakewood Ranch property") is
    // location evidence too — without street/city/ZIP it can't be verified,
    // so it must hold for review, not fall back to the on-file primary.
    appointmentBlockingFlags = appointmentBlockingFlags.filter((f) => {
      if (f === 'caller_phone_missing' && aniPresent) { failedOpenFlags.push(f); return false; }
      if (f === 'name_email_mismatch') { failedOpenFlags.push(f); return false; }
      if (f === 'low_extraction_confidence' && knownCustomerConfidenceTrusted) { failedOpenFlags.push(f); return false; }
      if (FAIL_OPEN_KNOWN_CUSTOMER_ADDRESS_FLAGS.has(f) && knownCustomerHasAddress && !newAddressGiven) { failedOpenFlags.push(f); return false; }
      return true;
    });
  }

  const startOnTheHour = confirmedStartOnTheHour(extraction.scheduling?.confirmed_start_at);

  // A POSITIVE Address Validation verdict — Google accepted (or corrected)
  // the stated address AND placed it in the service area. One of the two
  // ways the central address-trust gate below is satisfied (codex round-3
  // P1): when AV is disabled or returns not_attempted,
  // computeDeterministicTriageFlags raises NO address flag for a populated,
  // high-confidence address, so without this gate nothing would stand
  // between an unvalidated address and an auto-dispatch (AGENTS.md
  // L367-370: never silent auto-route).
  const avPositivelyValidated = !!opts.addressValidation
    && ['validated_accept', 'corrected'].includes(String(opts.addressValidation.status || ''))
    && opts.addressValidation.inServiceArea === true;

  // caller_not_authorized now fires only for an EXPLICIT third party
  // (isExplicitlyNonOwner) — an 'unknown' relationship never raises it and a
  // model-emitted copy is dropped above — so the unknown-relationship
  // demotion that used to live here (owner ruling 2026-07-31) is satisfied
  // at derivation time. Explicit third parties still route through the
  // agent-commitment demotion below.

  // Agent-commitment authorization (opts.agentCommitFailOpen ←
  // GATE_CALL_AGENT_COMMIT_BOOKING): when OUR agent explicitly committed to
  // the confirmed slot on this call ("we'll confirm it for noon on Sunday"),
  // a third-party caller no longer hard-blocks the booking on
  // caller_not_authorized — the business side accepting the slot IS the
  // authorization. Grounded in a live miss (2026-07-30): a realtor confirming
  // a WDO inspection the owner verbally accepted on the call still parked in
  // triage, so the promised confirmation flow never ran. Guarded three ways:
  // the extraction must claim the commitment, the claim must be evidence-
  // pinned to an AGENT-spoken quote that GROUNDS against an agent turn of the
  // source transcript (evidence objects are untrusted model output — a
  // hallucinated quote or speaker label cannot clear a hard block; see
  // hasAgentCommittedEvidence), and the booking must be confirmed with a
  // start time. The flag is pushed to
  // failedOpenFlags so the enforce path files the advisory "confirm the
  // account holder" card — book-and-flag, never book-and-hide. Every other
  // hard block (spam, out_of_service_area, do_not_contact) is untouched.
  // Independent of opts.failOpen so the two gates flip separately.
  // On-the-hour guard (owner rule: appointment windows ALWAYS start on the
  // hour — never :15/:30/:45). The extraction legitimately confirms times
  // like 2:30 PM, and the booking path copies confirmed_start_at into
  // window_start unchanged — so an off-hour agent commitment must NOT unlock
  // the booking; it stays in triage for the office to place on an hour
  // boundary (codex P1).
  // Full time-component check (codex round-4 P1): minutes AND seconds must
  // be zero — a schema-valid "T10:00:30" would otherwise copy a :30-second
  // start into window_start unchanged. Absent seconds count as zero.
  // BOTH the raw string AND the canonical ET wall clock must be on the hour
  // (codex round-7h): a foreign offset like "+05:30" can carry raw ":00"
  // minutes yet book a ":30" ET wall time — the wall clock is what booking
  // writes, so it is the one that must be exact. Shared with the two
  // 2026-07-31 demotions via confirmedStartOnTheHour so all three gates
  // enforce the identical rule.
  const commitStartOnTheHour = startOnTheHour;
  // opts.transcriptLabelsTrusted (codex round-2 P1): the Agent:/Caller:
  // prefixes the grounding relies on are themselves produced by an LLM
  // labeling pass that is explicitly told to INFER unclear identities, and
  // its integrity check verifies words, not attribution — so complete-but-
  // SWAPPED labels would pass every guard here and let a caller's own
  // sentence clear the hard block. Until speaker labels come from a
  // deterministic source (dual-channel recording / channel-derived
  // diarization), the caller stays in review: the demotion additionally
  // requires this opt, wired to GATE_CALL_AGENT_COMMIT_TRUSTED_LABELS
  // (owner-flip; see feature-gates.js). Fail closed by default.
  if (opts.agentCommitFailOpen && opts.transcriptLabelsTrusted === true
      && confirmedWithStart
      && commitStartOnTheHour
      && extraction.scheduling?.agent_committed_booking === true
      && hasAgentCommittedEvidence(extraction, opts.transcript, opts.callStartedAt)) {
    // Owner ruling 2026-09-24: a commercial/HOA call is NEVER auto-booked on
    // an agreed price alone — only Waves personnel dictating the booking on
    // the recording (this same grounded agent commitment) clears
    // commercial_requires_quote. The flag rides in failedOpenFlags so the
    // office still gets the advisory card. Live miss (2026-09-23 audit): a
    // confirmed $100 commercial booking fell to the lead-response flow.
    appointmentBlockingFlags = appointmentBlockingFlags.filter((f) => {
      if (f === 'caller_not_authorized' || f === 'commercial_requires_quote') { failedOpenFlags.push(f); return false; }
      return true;
    });
  }

  if (appointmentBlockingFlags.length > 0) {
    // Carry demoted flags on blocked returns too (codex round-4 P2): a call
    // whose caller_not_authorized was demoted can STILL block on another flag
    // — the "confirm the account holder" advisory must not vanish exactly
    // when the office lands on the card. The processor's blocked branch files
    // advisory cards from this array, mirroring the allowed branch.
    return { allowed: false, reason: 'triage_flags', flags: finalFlags, appointmentBlockingFlags, failedOpenFlags: failedOpenFlags.length ? failedOpenFlags : undefined };
  }

  const confidence = extraction.confidence || {};
  const threshold = opts.confidenceThreshold || DEFAULT_CONFIDENCE_THRESHOLD;

  // Fail-open: a KNOWN caller with a CONFIRMED time + start isn't held over a low
  // overall-confidence score. Short familiar calls score low (Barbara scored 0),
  // but a returning customer confirming a slot is a real booking.
  // addressOnly trust (a new lead's validated on-file address) never lifts
  // this either (codex #4685 r1 P1).
  const failOpenLowConfidence = opts.failOpen && !!opts.knownCustomer && !opts.knownCustomer.addressOnly
    && extraction.scheduling?.status === 'confirmed' && !!extraction.scheduling?.confirmed_start_at;
  if (!failOpenLowConfidence && (typeof confidence.overall !== 'number' || confidence.overall < threshold)) {
    return { allowed: false, reason: 'low_confidence', overall: confidence.overall, failedOpenFlags: failedOpenFlags.length ? failedOpenFlags : undefined };
  }

  // failedOpenFlags rides these returns too (codex P2): a demoted flag whose
  // call then blocks on scheduling must still reach the office as an
  // advisory card — the processor's blocked branch files cards from
  // failedOpenFlags, so omitting it here made the promised advisory vanish
  // exactly when the call needed review. Mirrors the low_confidence and
  // do_not_contact returns, which already carry it.
  const scheduling = extraction.scheduling || {};
  if (scheduling.status !== 'confirmed') {
    return {
      allowed: false,
      reason: 'not_confirmed',
      schedulingStatus: scheduling.status,
      failedOpenFlags: failedOpenFlags.length ? failedOpenFlags : undefined,
    };
  }

  if (!scheduling.confirmed_start_at) {
    return {
      allowed: false,
      reason: 'confirmed_without_start_time',
      schedulingStatus: scheduling.status,
      failedOpenFlags: failedOpenFlags.length ? failedOpenFlags : undefined,
    };
  }

  if (extraction.consent?.do_not_contact_request === true) {
    return { allowed: false, reason: 'do_not_contact', failedOpenFlags: failedOpenFlags.length ? failedOpenFlags : undefined };
  }

  // CENTRAL address-trust gate (codex round-4 P1). AGENTS.md: auto-create
  // only when confidence ≥ threshold AND **the address validates** AND the
  // service maps AND no HOA/commercial flag — else triage.
  //
  // That contract was previously enforced only incidentally. When AV is
  // disabled or returns not_attempted, computeDeterministicTriageFlags
  // raises NO address flag for a populated, high-confidence address, so
  // whatever else happened to be blocking (caller_not_authorized,
  // prior_complaint_unresolved, competing_quotes_active) was the only thing
  // standing between an unvalidated address and an auto-dispatch. This PR
  // turns those advisory, so the contract now has to be stated directly.
  //
  // Two ways to satisfy it, both meaning "we know where the tech is going":
  //   1. Google positively validated THIS call's address, in service area.
  //   2. The booking dispatches to the customer's on-file address — a known
  //      customer who stated no new address on this call (the established
  //      fail-open recovery; that address was verified when it was saved).
  //
  // Consequence worth stating plainly: with ADDRESS_VALIDATION_ENABLED unset,
  // nothing auto-routes — calls park instead of booking blind. The flag is on
  // in production, and failing closed here is the documented posture.
  const dispatchesToOnFile = dispatchesToOnFileAddress(extraction, opts);
  if (!avPositivelyValidated && !dispatchesToOnFile) {
    return {
      allowed: false,
      reason: 'address_not_validated',
      avStatus: opts.addressValidation?.status || null,
      flags: finalFlags,
      failedOpenFlags: failedOpenFlags.length ? failedOpenFlags : undefined,
    };
  }

  // CENTRAL on-the-hour gate (codex round-3 P1). window_start is ALWAYS
  // HH:00:00 (AGENTS.md, owner 2026-07-27) and the booking path copies this
  // wall clock into window_start unchanged — so an off-hour confirmed start
  // must never auto-create an appointment, whatever cleared the flags.
  //
  // It sits here, at the single exit that every allowed booking passes
  // through, rather than on the individual demotions: this PR turns several
  // previously-blocking signals advisory (prior_complaint_unresolved,
  // competing_quotes_active, a missing email, unknown model flags), and each
  // of those newly-allowed paths would otherwise need its own copy of the
  // guard — and the pre-existing clean-call path never had one at all.
  //
  // Off-hour calls reach the office as a time card and are placed on an hour
  // boundary, exactly as the agent-commitment path has always done. Nothing
  // is rounded automatically: the caller was told a specific time, so moving
  // it is a human decision.
  if (!confirmedStartOnTheHour(scheduling.confirmed_start_at)) {
    return {
      allowed: false,
      reason: 'off_hour_start',
      confirmedStartAt: scheduling.confirmed_start_at,
      flags: finalFlags,
      failedOpenFlags: failedOpenFlags.length ? failedOpenFlags : undefined,
    };
  }

  return {
    allowed: true,
    flags: finalFlags,
    failedOpenFlags: failedOpenFlags.length ? failedOpenFlags : undefined,
    ...(!avPositivelyValidated && dispatchesToOnFile ? { usesOnFileAddress: true } : {}),
  };
}

// Suffix-insensitive street comparison shared by the shadow bridge and the
// second-address check, so "123 Main St" and "123 Main Street" compare equal
// (otherwise a benign expansion opens a false second_service_address review).
const streetHouseNum = (s) => (String(s || '').trim().match(/^\d+/) || [''])[0];
const STREET_SUFFIX_WORDS = new Set([...Object.keys(STREET_SUFFIX_ALIASES), ...Object.values(STREET_SUFFIX_ALIASES).map(value => value.toLowerCase())]);
const streetNameOnly = (s) => String(s || '').toLowerCase().replace(/[.,#]/g, ' ')
  .replace(/^\s*\d+\s*/, '')
  .replace(/\b(st|street|ave|avenue|rd|road|dr|drive|ln|lane|ct|court|blvd|boulevard|cir|circle|pl|place|ter|terrace|way|trl|trail|pkwy|parkway|hwy|highway)\b/g, '')
  .replace(/\s+/g, ' ').trim();
/** Normalized "<house> <street-name>" key with common suffixes stripped. */
function streetCompareKey(s) {
  return `${streetHouseNum(s)} ${streetNameOnly(s)}`.trim();
}

/**
 * Address/identity review bridge — pure decision used by the call processor when
 * V2 address validation runs in SHADOW (V2 enabled, not yet driving routing). It
 * lets the legacy live write consume just the AV verdict without taking on the
 * full enforce-mode routing gate. Given the AV result, the legacy flat
 * `extracted` record, and the V2 model triage flags, returns:
 *   - normalizedAddress: the {address_line1, city, state, zip} subset to adopt
 *     when AV decisively accepted/corrected an in-area premise (null otherwise),
 *   - normalizedEmail: a HIGH-confidence domain-typo correction of the captured
 *     email ("jane@gmial.com" → "jane@gmail.com") to adopt BEFORE the upsert and
 *     the first-touch sends read extracted.email (null otherwise) — catching at
 *     intake what bounce-recovery would otherwise repair after a bounce,
 *   - needsConfirmation: human-review reasons — an unverifiable / out-of-area
 *     address (only when a street was actually given), caller-not-owner, a
 *     missing surname on a real (hot/warm) prospect, and a transcription-spelled
 *     email (email_unverified / email_invalid) to read back on the callback.
 *     The email reasons are ADVISORY ONLY, mirroring address_unverified here:
 *     they ride needs_confirmation, never the routing triage flags — most
 *     spelled emails are fine and must not hold a call for review.
 * `addressRecovery` (optional) is the address-validation/recovery.js result for
 * an unverifiable street: when it confirmed exactly ONE real premise, that
 * premise is adopted as normalizedAddress and the review reason becomes
 * address_recovered (read the recovered street back on the callback) instead of
 * address_unverified — the transcription garbled the street ("C Phone Trl"),
 * recovery found what the caller plausibly said ("Seafoam Trl"), and a human
 * still confirms it before anyone drives there.
 * Pure: no side effects. The caller mutates `extracted` and persists the reasons.
 */
function deriveCallReviewBridge({ addressValidation, extracted = {}, v2TriageFlags = [], callerRelationship = null, addressRecovery = null } = {}) {
  const av = addressValidation || null;
  const status = av && av.status ? av.status : null;
  const hadStreet = !!String(extracted.address_line1 || '').trim();
  const needsConfirmation = [];
  let normalizedAddress = null;

  if (av && av.normalized && (status === 'validated_accept' || status === 'corrected')) {
    const n = av.normalized;
    const adopt = {};
    if (n.street_line_1) adopt.address_line1 = n.street_line_1;
    if (n.city) adopt.city = n.city;
    if (n.state) adopt.state = n.state;
    if (n.postal_code) adopt.zip = n.postal_code;
    // Google validated the V2 address is a real premise — NOT that the caller
    // said it. In shadow mode the legacy V1 extraction is source-of-record, so
    // adopt only when the validated street matches the legacy one (normalization
    // / ZIP correction). On a street disagreement, hold for review instead of
    // overwriting a possibly-correct legacy address with a V2 mix-up.
    const normTok = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    // Same PREMISE as what the caller (V1) said — not just a real address Google
    // happened to validate. Require a corroborating legacy house number (don't
    // graft a V2-only house number onto a street-only legacy address), full
    // street-name equality, and matching city/ZIP when both sides have them.
    const sameLocation = () => {
      if (adopt.address_line1) {
        const hn = streetHouseNum(adopt.address_line1), ho = streetHouseNum(extracted.address_line1);
        if (!hn || !ho || hn !== ho) return false;          // need a matching legacy house number
        const sn = streetNameOnly(adopt.address_line1), so = streetNameOnly(extracted.address_line1);
        if (sn && so && sn !== so) return false;            // different street → hold for review
      }
      // For validated_accept Google changed NOTHING, so a different city/ZIP means
      // V2 sent a different place → hold. For `corrected` the difference IS
      // Google's trusted correction (e.g. a bad ZIP), so don't reject on it.
      if (status === 'validated_accept') {
        if (adopt.city && extracted.city && normTok(adopt.city) !== normTok(extracted.city)) return false;
        if (adopt.zip && extracted.zip && normTok(adopt.zip) !== normTok(extracted.zip)) return false;
      }
      return true;
    };
    if (Object.keys(adopt).length) {
      if (!hadStreet) {
        // No legacy street to corroborate — don't adopt a V2-only address.
      } else if (!sameLocation()) {
        needsConfirmation.push('address_unverified'); // V1/V2 location disagreement -> review
      } else {
        normalizedAddress = adopt;
      }
    }
  } else if (hadStreet && (status === 'missing_component' || status === 'ambiguous' || status === 'confirm_needed')) {
    if (addressRecovery && addressRecovery.recovered && addressRecovery.recovered.address_line1) {
      const r = addressRecovery.recovered;
      normalizedAddress = {
        address_line1: r.address_line1,
        ...(r.city ? { city: r.city } : {}),
        ...(r.state ? { state: r.state } : {}),
        ...(r.zip ? { zip: r.zip } : {}),
      };
      needsConfirmation.push('address_recovered');
    } else {
      needsConfirmation.push('address_unverified');
    }
    // Building resolved but the unit designator is the missing piece — the
    // ask survives recovery too (recovery fixes a garbled street, not a
    // missing unit) and persists until the office collects it. Corroboration
    // rule below.
    if (unitAskCorroborated(av, extracted)) needsConfirmation.push('missing_unit_number');
  } else if (hadStreet && status === 'out_of_service_area') {
    needsConfirmation.push('out_of_service_area');
  }

  const flags = Array.isArray(v2TriageFlags) ? v2TriageFlags : [];
  // Same relationship rule as routing (codex r1 P2): in shadow mode the
  // processor hands the RAW V2 flags here, so a model-emitted
  // caller_not_authorized on an unknown / spouse caller would still open
  // the review card enforce mode no longer raises. Only an explicit third
  // party (tenant, agent, manager, other) carries the ask.
  if (flags.includes('caller_not_authorized') && isExplicitlyNonOwner(callerRelationship)) needsConfirmation.push('caller_not_authorized');
  // The V2 deterministic pass (fed the same AV verdict) may also flag the
  // missing unit — consume it under the SAME corroboration rule, deduped
  // against the branch's own push.
  if (flags.includes('missing_unit_number')
      && unitAskCorroborated(av, extracted)
      && !needsConfirmation.includes('missing_unit_number')) {
    needsConfirmation.push('missing_unit_number');
  }

  if (extracted.first_name && !String(extracted.last_name || '').trim()
      && (extracted.lead_quality === 'hot' || extracted.lead_quality === 'warm')) {
    needsConfirmation.push('missing_last_name');
  }

  // Rental / tenant-occupied property — flagged so the office can plan property
  // access (occupant != owner) and decide whether to tag it a rental.
  if (detectRentalSignal({ extracted, callerRelationship })) {
    needsConfirmation.push('rental_or_tenant_occupied');
  }

  // Email review — shared with the enforce-mode/V2-off fallback in the call
  // processor, so email hygiene is never shadow-bridge-only.
  const emailReview = deriveEmailReview(extracted);
  needsConfirmation.push(...emailReview.needsConfirmation);

  return { normalizedAddress, normalizedEmail: emailReview.normalizedEmail, needsConfirmation };
}

// Syntactic sanity only — deliverability is unknowable until a send. Anything
// failing this is transcription garbage, not an address worth storing plans on.
const BASIC_EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Email review — pure, extraction-mode-independent (the call processor runs
 * it via the shadow bridge OR directly in enforce/V2-off modes; first-touch
 * sends read extracted.email in every mode).
 *
 * A transcription-spelled email is the top source of hard bounces (letters
 * mishear: "A-L-L-E-N-S" → "K-L-L-E-N-S"; the mailbox can't be verified
 * live), and the first automated email fires within seconds of intake — so
 * every call-captured email gets a read-back reason, and a high-confidence
 * domain typo is corrected up front. Local parts are NEVER touched
 * (email-typo-correction contract): a wrong local part is only discoverable
 * by asking the caller, which is what the reason drives.
 * extracted.email_raw carries what intake normalization rejected (the
 * normalizer nulls non-regex emails before this runs) so invalid captures
 * still get their reason — and a missing-dot typo its fix.
 */
function deriveEmailReview(extracted = {}) {
  const needsConfirmation = [];
  let normalizedEmail = null;
  const rawEmail = String(extracted.email || extracted.email_raw || '').trim().toLowerCase();
  if (rawEmail) {
    // URL-shaped local part ("www.cw63@gmail.com") = transcription garble the
    // normalizer already demoted to email_raw. Classify it email_invalid
    // BEFORE domain correction — a garbled local part must never be repaired
    // into an adoptable address (the literal may be a stranger's mailbox).
    if (looksGarbledTranscriptEmail(rawEmail)) {
      needsConfirmation.push('email_invalid');
      return { normalizedEmail, needsConfirmation };
    }
    // Correction BEFORE shape classification: correctEmailDomain repairs
    // shapes the basic regex rejects ("jane@gmailcom" → missing-dot rule), so
    // classifying first would strand exactly the typos the adopt path fixes.
    const candidate = correctEmailDomain(rawEmail);
    if (candidate && meetsConfidence(candidate.confidence, 'high')) {
      normalizedEmail = candidate.corrected;
      needsConfirmation.push('email_unverified');
    } else if (!BASIC_EMAIL_SHAPE.test(rawEmail)) {
      needsConfirmation.push('email_invalid');
    } else {
      needsConfirmation.push('email_unverified');
    }
  }
  return { normalizedEmail, needsConfirmation };
}

/**
 * Merge needs_confirmation reasons across calls on the same lead. Reasons are
 * read-back reminders that persist until the office confirms them — a later
 * call that never restates the address/email must not erase the earlier call's
 * warnings (the lead's extracted_data is otherwise a rolling latest-call
 * snapshot, so a quick follow-up call was wiping address_unverified /
 * email_unverified off the lead). Union of both, with two supersede rules: an
 * address recovered-and-validated on the newer call replaces the stale
 * address_unverified.
 *
 * missing_unit_number gets NO supersede rule and is owed until the office
 * performs it, like every other read-back reason here: a later call that
 * validates SOME unit at the building does not answer THIS ask (a landlord's
 * unnamed unit A followed by a call about unit B), and the earlier
 * extraction has no unit to tie the acceptance to. See the owed-confirmation
 * doctrine in triage-auto-resolve.js.
 */
function mergeNeedsConfirmation(prior, next) {
  const nextArr = Array.isArray(next) ? next : [];
  const merged = [...new Set([...(Array.isArray(prior) ? prior : []), ...nextArr])];
  return nextArr.includes('address_recovered')
    ? merged.filter((r) => r !== 'address_unverified')
    : merged;
}

/**
 * True when a call indicates a rental / tenant-occupied property — a non-owner-
 * occupant caller (tenant / property manager), OR an owner calling about their
 * tenants ("my tenants have ants"). Shared by the shadow bridge and the enforce-
 * path deterministic flags so the classification is identical in both modes.
 * `extracted` is a loose bag of free-text fields (pain_points / call_summary /
 * requested_service) — pass V1 `extracted` or `{ call_summary }` from V2.
 */
function detectRentalSignal({ extracted = {}, callerRelationship = null } = {}) {
  const rel = String(callerRelationship || '').toLowerCase();
  if (rel === 'tenant' || rel === 'property_manager') return true;
  return /\b(tenants?|renters?|rental|landlord)\b/i.test(
    `${extracted.pain_points || ''} ${extracted.call_summary || ''} ${extracted.requested_service || ''}`
  );
}

// Any field that means "the caller stated a service address on THIS call".
// One list, because two copies drift.
const NEW_ADDRESS_FIELDS = [
  'street_line_1', 'line1', 'street', 'street_line_2', 'line2', 'unit', 'apt',
  'city', 'locality', 'postal_code', 'zip', 'zip_code',
  'subdivision_or_community', 'raw_text',
];

/**
 * Did the caller state a NEW service address on this call? A known
 * customer's on-file address (opts.knownCustomer.addressLine1/addressCity/
 * addressZip) may be passed so that RESTATING it — "1234 Sample Palm", "I'm
 * in Parrish", "same zip" — is not mistaken for a second property. Live
 * misses (2026-09-05): a matched customer who said only "I'm in Parrish"
 * had the city-only fragment sent to Google, returned missing_component,
 * and lost the on-file trust that would have booked the confirmed estimate.
 * A restatement must AGREE with the file on every component it names; any
 * conflicting street, city or ZIP is a new address and holds for review.
 */
function statesNewAddress(extraction, knownCustomer = null) {
  const sa = extraction?.property?.service_address || {};
  const state = normalizeState(sa.state);
  const stated = (state && state !== 'FL') || NEW_ADDRESS_FIELDS.some((k) => String(sa[k] || '').trim());
  if (!stated) return false;
  return !restatesOnFileAddress(sa, knownCustomer);
}

const zip5Of = (v) => (String(v || '').match(/\d{5}/) || [''])[0];
const cityKey = (v) => String(v || '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
// Canonical unit structure distinguishes Bldg 4 Apt 5 from Apt 45; a hyphen
// between a digit and a letter is formatting (4-B = 4B), but a hyphen
// between two DIGITS is a real separator (Apt 4-5 is not Apt 45 — codex
// r10 P1), so only the former is dropped.
const unitKey = value => unitLineValueKey(normalizeUnitLine(value)).replace(/(?<!\d)-|-(?!\d)/g, '');
const statedValues = values => values.map(value => String(value || '').trim()).filter(Boolean);
const UNIT_WORD = /^(?:#|apt|apartment|unit|ste|suite|bldg|building|fl|floor|lot|spc|space|rm|room)$/i;

// codex P2: "Parrish FL" / "Parrish, FL 34219" / "34219 Parrish" restate the
// on-file locality just as plainly as a bare "Parrish" — appending the
// already-agreed state and/or ZIP must not turn a locality restatement into
// unrecognized street evidence. True only when EVERY word of the phrase
// (after stripping the "in / I'm in" lead-in and punctuation) is consumed by
// the saved city, "FL"/"Florida", or the saved ZIP (zip5 or ZIP+4) — any one
// unmatched word (e.g. "Heights" in "Parrish Heights FL") still falls
// through to street-evidence comparison below.
function rawIsPureLocalityPhrase(raw, savedCity, savedZip) {
  if (!raw || !savedCity) return false;
  const stripped = String(raw).trim()
    .replace(/^(?:i\s*'?m\s+|i\s+am\s+|we\s*'?re\s+|we\s+are\s+)?in\s+/i, '')
    .trim();
  // Tokenize on anything that is not a letter, digit or ZIP+4 hyphen so
  // punctuation never hides a token — and NEVER strip digits: a ZIP that
  // is not the saved one ("34203 Parrish" against 34219) is a contradiction
  // the caller voiced, not noise (codex r9 P1).
  const tokens = stripped.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);
  if (!tokens.length) return false;
  let consumedLocalityToken = false;
  const cityWords = [];
  for (const token of tokens) {
    if (token === 'fl' || token === 'florida') {
      consumedLocalityToken = true;
      continue;
    }
    if (/\d/.test(token)) {
      const zipHead = token.replace(/-\d{4}$/, '');
      if (!savedZip || zipHead !== savedZip) return false;
      consumedLocalityToken = true;
      continue;
    }
    cityWords.push(token);
  }
  if (!cityWords.length) return consumedLocalityToken;
  return cityKey(cityWords.join(' ')) === savedCity;
}
// Spoken directionals ("North Main Street") and the saved abbreviation
// ("N Main St") are the same street (codex r9 P2) — canonicalize both sides
// the way suffixes already are, so an AV-incomplete known-customer booking
// still recognizes its own saved address.
const DIRECTIONAL_ALIASES = {
  north: 'n', south: 's', east: 'e', west: 'w',
  northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
};
function restatementStreetParts(line) {
  const tokens = normalizeStreetLine(line).toLowerCase().split(/\s+/).filter(Boolean)
    .map(token => String(STREET_SUFFIX_ALIASES[token] || DIRECTIONAL_ALIASES[token] || token).toLowerCase());
  const house = /^\d+$/.test(tokens[0]) ? tokens.shift() : '';
  return { house, ...streetNameParts(tokens) };
}

// Name + suffix-less name of an already house-less token list — a numbered
// street ("42 St") keeps its number (pre-push audit P1: re-parsing the
// remainder as a house number made 42 St and 43 St the same street).
const DIRECTIONAL_TOKENS = new Set(Object.values(DIRECTIONAL_ALIASES));
function streetNameParts(tokens) {
  const name = tokens.join(' ');
  const rest = [...tokens];
  // The suffix may sit BEFORE a trailing post-directional ("Main St N" vs
  // the suffixless "Main N") — strip the recognized suffix ahead of an
  // optional directional run (codex r6 P2).
  const tail = [];
  while (rest.length > 1 && DIRECTIONAL_TOKENS.has(rest[rest.length - 1])) tail.unshift(rest.pop());
  if (STREET_SUFFIX_WORDS.has(rest[rest.length - 1])) rest.pop();
  return { name, withoutSuffix: [...rest, ...tail].join(' ') };
}

function restatesOnFileAddress(sa, knownCustomer) {
  const saved = knownCustomer || {};
  const onFile = splitStreetLineUnit(saved.addressLine1);
  if (!onFile.street || sa.subdivision_or_community) return false;
  const raw = String(sa.raw_text || '').trim()
    .replace(/,\s*same (?:as (?:before|always)|place|address)\.?$/i, '')
    .replace(/^(?:over )?(?:on|at)\s+/i, '');
  const { unit: leadingUnit, rest: rawAddress = raw } = splitUnitFirstLine(raw) || {};
  const parsed = parseRawAddress(rawAddress);
  const structured = statedValues([sa.street_line_1, sa.line1, sa.street]).map(splitStreetLineUnit);
  // EVERY unit the raw phrase names is compared ("Apt 4, 500 Main St Apt 5"
  // against on-file Apt 4 is a contradiction, not a restatement — codex
  // r11 P1); a first-match pick let the later unit vanish.
  // The parsed street's own unit is a FRAGMENT of the whole-line unit when
  // the parser split a compound unit across line1/city ("Bldg 4 Apt 5" →
  // line1 "… Bldg 4", city "Apt 5") — only consulted when the whole line
  // carried no unit at all (codex r12 P2).
  const rawUnits = [leadingUnit, unitAnywhereOnLine(rawAddress) || unitAnywhereOnLine(parsed.line1)].filter(Boolean);
  // The comma-free parser reads an alphabetic unit value as a city + state
  // ("100 Main St Apt CT" → city "Apt", state CT): a unit designator in the
  // city slot is neither a locality nor geography (codex r12 P2).
  const parsedCityIsUnitWord = UNIT_WORD.test(parsed.city || '');
  const parsedCity = parsedCityIsUnitWord ? '' : parsed.city;
  const parsedState = parsedCityIsUnitWord ? '' : parsed.state;
  // …and that designator + value pair IS the caller's unit ("Apt CT"), which
  // no unit detector recognizes on its own because the value is alphabetic.
  if (parsedCityIsUnitWord && parsed.state && !rawUnits.length) rawUnits.push(`${parsed.city} ${parsed.state}`);
  const savedUnit = unitKey(saved.addressLine2 || onFile.unit);
  const units = statedValues([sa.street_line_2, sa.line2, sa.unit, sa.apt, ...rawUnits, ...structured.map(part => part.unit)]);
  const cities = statedValues([sa.city, sa.locality]).map(cityKey);
  const zips = statedValues([sa.postal_code, sa.zip, sa.zip_code, parsed.zip]).map(zip5Of);
  const states = statedValues([sa.state, parsedState]).map(normalizeState);
  const savedCity = cityKey(saved.addressCity);
  const savedZip = zip5Of(saved.addressZip);
  const comparisons = [
    ...cities.map(value => [value, savedCity]), ...zips.map(value => [value, savedZip]),
    ...states.map(value => [value, 'FL']), ...units.map(value => [unitKey(value), savedUnit]),
  ];
  if (comparisons.some(([value, expected]) => value && value !== expected)) return false;

  // Ignore only positive locality restatements or a short acknowledgment.
  // Every other raw phrase is compared as street evidence, including names
  // with no house number or suffix; unknown words cannot disappear behind a city.
  // Whole-phrase check only (codex r9 P1): cityKey() drops digits, so a
  // "compare the letters to the city" shortcut let "34203 Parrish" pass as
  // a plain "Parrish" — the contradictory ZIP vanished.
  const rawIsLocality = raw === savedZip || rawIsPureLocalityPhrase(raw, savedCity, savedZip);
  const acknowledgment = /^(?:yes|(?:the )?same (?:place|address|as before|as always))\.?$/i.test(raw);
  const rawCity = cityKey(parsedCity);
  // A city slot holding the TAIL of a compound raw unit ("Apt 5" of
  // "Bldg 4 Apt 5") is that unit, not a locality.
  const cityUnitLine = String(normalizeUnitLine(parsed.city) || '').toLowerCase();
  const cityIsUnit = Boolean(cityUnitLine) && rawUnits.some((unit) => {
    const line = String(normalizeUnitLine(unit) || '').toLowerCase();
    return line === cityUnitLine || line.endsWith(` ${cityUnitLine}`);
  });
  const tailAgrees = [!rawCity, rawCity === savedCity, cityIsUnit].some(Boolean);
  const streets = structured.map(part => part.street);
  if (raw && !rawIsLocality && !acknowledgment) streets.push(tailAgrees ? splitStreetLineUnit(parsed.line1).street : rawAddress);
  // A raw ZIP restatement carrying ordinary punctuation or ZIP+4 ("34219.",
  // "34219-1234") is not the exact-string match rawIsLocality looks for, so it
  // falls through to the push above — but a bare ZIP parses to an EMPTY
  // street (parsed.line1 ''), and that phantom entry vetoed agreement on real,
  // already-matched ZIP evidence below (codex P2). Only actual street text is
  // street evidence; nothing the caller actually said disappears here.
  const streetEvidence = streets.filter(Boolean);
  // A building street alone cannot identify the saved apartment. City/ZIP
  // only callers still use the complete on-file address at booking time.
  if (savedUnit && streetEvidence.length && !units.length) return false;
  const expected = restatementStreetParts(onFile.street);
  const agree = streetEvidence.map(restatementStreetParts).every(part => part.name && [expected.name, expected.withoutSuffix].includes(part.name)
    && (!part.house || part.house === expected.house));
  return agree && [streetEvidence.length, cities.length, zips.length, acknowledgment, rawIsLocality && raw].some(Boolean);
}

/**
 * A validated call address that disagrees with the linked customer's on-file
 * street by HOUSE NUMBER ONLY (same street name, same locality where both
 * sides carry one). live incident, 2026-09-16: the web form saved 1260
 * Example Street (a number that does not exist), the call validated 1250
 * at premise level, and the never-overwrite-a-filled-field rule kept the
 * profile as it was — correctly — while nothing surfaced the disagreement.
 * The correction lane only acts on correction language ("actually", "wrong"),
 * and stating an address while asking for a quote is a mention by design, so
 * this is the one shape that had no owner: a typo'd number on the RIGHT
 * street. A different street is a second property (multi_property_call /
 * second_service_address own that); a different ZIP or city is not a typo.
 * Returns the evidence for an advisory review card, or null. Pure.
 */
// A fractional premise ("12 1/2 Main St") is ONE house token: without the
// fraction 12 1/2 reads as 12 (no conflict) or leaves "1/2" in the street
// name (a different street) — codex r16 P2.
const HOUSE_TOKEN = /^(\d+[a-z]?(?:-\d+[a-z]?)?(?:\s+\d\/\d)?)\b\s*/i;
function houseAndName(line) {
  const text = String(line || '').trim();
  const m = text.match(HOUSE_TOKEN);
  if (!m) return { house: '', name: '', withoutSuffix: '' };
  const tokens = normalizeStreetLine(text.slice(m[0].length)).toLowerCase().split(/\s+/).filter(Boolean)
    .map(token => String(STREET_SUFFIX_ALIASES[token] || DIRECTIONAL_ALIASES[token] || token).toLowerCase());
  return { house: m[1].toLowerCase().replace(/\s+/g, ' '), ...streetNameParts(tokens) };
}

// Do two street lines name the SAME house on the same street by the
// detector's own rules: equal house token, and the street names equal with
// or without a trailing suffix ("1250 Main" == "1250 Main St") — codex
// #4666 P2. False when either side carries no house token.
function sameHouseNumberStreet(a, b) {
  // Unit-first legacy lines ("Apt 4, 1250 Main St") are peeled on both
  // sides before the trailing-unit split (codex r9 P2).
  const peel = (line) => {
    const text = String(line || '');
    const rest = (splitUnitFirstLine(text) || {}).rest || text;
    return splitStreetLineUnit(rest).street || rest;
  };
  const x = houseAndName(peel(a));
  const y = houseAndName(peel(b));
  if (!x.house || !y.house || x.house !== y.house || !x.name || !y.name) return false;
  return [y.name, y.withoutSuffix].includes(x.name) || [x.name, x.withoutSuffix].includes(y.name);
}

function onFileHouseNumberConflict({ addressValidation = null, onFileAddress = null } = {}) {
  const av = addressValidation;
  if (!av || !(av.status === 'validated_accept' || av.status === 'corrected')) return null;
  const stated = String(av.normalized?.street_line_1 || '').trim();
  const onFile = String(onFileAddress?.address_line1 || '').trim();
  if (!stated || !onFile) return null;
  // House tokens may be alphanumeric or hyphenated (1250A, 12-14) — the
  // restatement parser's digits-only house would leave those unkeyed and
  // this exact disagreement unsurfaced (codex r2 P2).
  // A legacy unit-FIRST on-file line ("Apt 4, 1260 Main St") is peeled the
  // same way the restatement path peels it before the trailing-unit split
  // (codex r8 P2).
  const onFileStreetLine = (splitUnitFirstLine(onFile) || {}).rest || onFile;
  const a = houseAndName(splitStreetLineUnit(stated).street || stated);
  const b = houseAndName(splitStreetLineUnit(onFileStreetLine).street || onFileStreetLine);
  if (!a.house || !b.house || a.house === b.house) return null;
  if (!a.name || !b.name) return null;
  const sameStreet = [b.name, b.withoutSuffix].includes(a.name) || [a.name, a.withoutSuffix].includes(b.name);
  if (!sameStreet) return null;
  const statedZip = zip5Of(av.normalized?.postal_code);
  const onFileZip = zip5Of(onFileAddress.zip);
  if (statedZip && onFileZip && statedZip !== onFileZip) return null;
  const statedCity = cityKey(av.normalized?.city);
  const onFileCity = cityKey(onFileAddress.city);
  // Postal-city names alias (Bradenton / Lakewood Ranch share 34211) — the
  // same rule the address comparison above applies: a city mismatch vetoes
  // the conflict only when no ZIP pair already positively agreed (codex r30
  // P1).
  if (!(statedZip && onFileZip) && statedCity && onFileCity && statedCity !== onFileCity) return null;
  return {
    stated_street: stated,
    on_file_street: onFile,
    stated_house_number: a.house,
    on_file_house_number: b.house,
    // The stated locality rides along so the auto-resolve rule can hold the
    // record to the SAME premise, not just the same leading digits.
    stated_city: String(av.normalized?.city || '').trim() || null,
    stated_zip: statedZip || null,
  };
}

/**
 * Would this booking dispatch to the customer's ON-FILE (already Google-
 * verified) address rather than one stated on this call? That is the only
 * shape the address fail-open covers: a known customer who did not restate
 * their address. If they DID state one and it could not be validated, the
 * fail-open must not apply.
 *
 * EXPORTED and shared with the offline audits on purpose (codex round-19 P1):
 * the promotion-readiness backstop exempts these routes from the phantom
 * criterion, and a hand-copied "has an address on file" test silently
 * exempted low-confidence NEW-address routes too — hiding exactly the
 * auto-routes that criterion exists to catch. One predicate, both callers,
 * no drift.
 */
function dispatchesToOnFileAddress(extraction, opts = {}) {
  return !!(opts.failOpen
    && opts.knownCustomer && opts.knownCustomer.hasAddress
    && !statesNewAddress(extraction, opts.knownCustomer));
}

module.exports = {
  onFileHouseNumberConflict,
  sameHouseNumberStreet,
  SCHEDULING_CHANGE_REVIEW_FLAGS,
  isExplicitlyNonOwner,
  computeDeterministicTriageFlags,
  statesNewAddress,
  dispatchesToOnFileAddress,
  mergeTriageFlags,
  suppressAddressFlagsForAV,
  isMissingUnitNumber,
  unitAskCorroborated,
  recordCarriesUnit,
  deriveCallReviewBridge,
  deriveEmailReview,
  mergeNeedsConfirmation,
  detectRentalSignal,
  streetCompareKey,
  canAutoRoute,
  onFileAddressSatisfaction,
  SMS_ONLY_FLAGS,
  ADVISORY_TRIAGE_FLAGS,
  BLOCKING_TRIAGE_FLAGS,
  CANONICAL_WRITE_BLOCKING_FLAGS,
  confirmedStartOnTheHour,
  quoteBindsConfirmedSlot,
  normalizeCommitmentText,
  hasAgentCommittedEvidence,
  etWallClockOfConfirmedStart,
  FAIL_OPEN_KNOWN_CUSTOMER_ADDRESS_FLAGS,
  hasCanonicalWriteBlock,
  hasNameEmailMismatch,
  isDialablePhone,
  SERVICE_AREA_COUNTIES,
  normalizeCounty,
  isInServiceAreaCounty,
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_ADDRESS_CONFIDENCE_THRESHOLD,
};
