const { correctEmailDomain, meetsConfidence } = require('../utils/email-typo-correction');
const { looksGarbledTranscriptEmail } = require('../utils/intake-normalize');

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

const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;
const DEFAULT_ADDRESS_CONFIDENCE_THRESHOLD = 0.6;

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
    if (avStatus !== 'out_of_service_area' && isMissingUnitNumber(av)) {
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

  if (caller.on_site_authorization === false && caller.relationship_to_property !== 'owner') {
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
const NEGATION_HEDGE_TOKENS = [
  ' not ', ' won t ', ' wont ', ' can t ', ' cant ', ' cannot ', ' don t ',
  ' dont ', ' doesn t ', ' doesnt ', ' isn t ', ' isnt ', ' unable ',
  ' instead ', ' unless ', ' rather ', ' maybe ', ' might ',
  ' unfortunately ', ' call you back ', ' have to check ', ' let me check ',
  ' see if ', ' ask someone ',
];
function turnHasNegationOrHedge(normalizedTurn) {
  const padded = ` ${normalizedTurn} `;
  return NEGATION_HEDGE_TOKENS.some((t) => padded.includes(t));
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
];
// "if" is exempt ONLY inside the exact recognized closing construction —
// "(just) let us know if <benign follower>" (codex P0, round 7g: "we will
// book you for Sunday at noon IF ANYTHING CHANGES" is a conditional booking
// even though the follower matches, so the follower alone is not enough:
// the words BEFORE the "if" must be the let-us-know closer).
const BENIGN_IF_PRECEDER_RE = /(?:^| )(?:just )?let us know $/;
const BENIGN_IF_FOLLOWER_RE = /^if (anything changes|that changes|anything comes up|something comes up|you need anything|you have any questions)/;
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
const COMMITMENT_TURN_VOCAB = new Set([
  'so', 'ok', 'okay', 'alright', 'awesome', 'perfect', 'great', 'sounds',
  'good', 'yep', 'yes', 'and', 'then', 'all', 'set', 'right',
  'we', 'i', 'll', 'will', 're', 'are', 'you', 'your', 'it', 'that', 's',
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
]);
function commitmentTurnVocabularyOk(normalizedTurn) {
  return normalizedTurn.split(' ').every((tok) => (
    !tok
    || COMMITMENT_TURN_VOCAB.has(tok)
    || /^\d{1,4}$/.test(tok)
    || /^\d{1,2}(st|nd|rd|th)$/.test(tok)
  ));
}

// Affirmative sentence FORM (codex P0, interrogatives): normalization strips
// punctuation, so "Will you be there Sunday at noon?" survives the closed
// vocabulary. After optional discourse openers, the turn must BEGIN with a
// first-person commitment head — interrogative-initial forms (will/are/can
// leading) never match and fail closed.
const COMMITMENT_OPENER_TOKENS = new Set([
  'so', 'ok', 'okay', 'alright', 'awesome', 'perfect', 'great', 'sounds',
  'good', 'yep', 'yes', 'and', 'then', 'all', 'right',
]);
// Full head+predicate templates (codex P0, round 7f): a bare first-person
// prefix accepted non-commitments ("we will NEED YOU TO CONFIRM…"). The
// commitment PREDICATE is part of the template — anything after the subject
// that isn't an explicit commitment verb phrase fails closed.
const COMMITMENT_HEADS = [
  'we ll see you ', 'we will see you ', 'i ll see you ', 'i will see you ',
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
// abbreviation dots don't split), and the SAME sentence must: contain the
// pinned quote, pass the negation/conditional screens, satisfy the closed
// vocabulary AND the affirmative commitment form, and bind the slot. A quote
// spanning sentences grounds nowhere and fails closed; if the quote appears
// in several sentences, EVERY one must pass (ambiguity fails closed).
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
  // Negation/conditional screens run on the WHOLE TURN (codex P0, round 7l:
  // "If the homeowner approves. We will see you Sunday at noon." — an
  // adjacent conditional sentence must poison the commitment sentence next
  // to it); vocabulary, affirmative form, and slot binding stay scoped to
  // the single sentence containing the pinned quote.
  // Terminal closure for adjacent-sentence bypasses (codex P0, round 7m:
  // "Subject to homeowner approval. We will see you Sunday at noon."):
  // EVERY sentence of the grounding turn must itself pass the closed
  // commitment vocabulary — which cannot express conditions, approvals, or
  // retractions — so any surrounding sentence with out-of-vocabulary words
  // poisons the whole turn. Multi-sentence turns discussing anything beyond
  // the commitment (SMS logistics, addresses, names) fail closed to triage;
  // the pinned single-sentence commitment turn is the supported shape.
  const containing = [];
  for (const turn of agentTurns) {
    const wholeTurn = normalizeCommitmentText(turn);
    // Sentence chunks KEEP their terminator (codex P0, round 7n): splitting
    // on [.!?;]+ discarded the "?" that makes "So we will confirm it for
    // noon on Sunday?" a QUESTION — an interrogative sentence can never be
    // the commitment sentence.
    const chunks = (String(turn).replace(/\b([ap])\.\s?m\.?/gi, '$1m').match(/[^.!?;]+[.!?;]*/g) || []);
    // ANY question mark in the turn poisons it (codex P1, round 7o: a tag
    // question — "You're booked Sunday at noon. Right?" — means the agent is
    // ASKING, not committing, even when the pinned sentence is declarative).
    const turnHasQuestion = String(turn).includes('?');
    const sentences = chunks
      .map((c) => ({ ns: normalizeCommitmentText(c), interrogative: c.includes('?') }))
      .filter((s) => s.ns);
    const turnFullyInVocabulary = sentences.every((s) => commitmentTurnVocabularyOk(s.ns));
    for (const s of sentences) {
      if (s.ns.includes(q)) containing.push({ ...s, wholeTurn, turnFullyInVocabulary, turnHasQuestion });
    }
  }
  if (!containing.length) return false;
  return containing.every(({ ns, interrogative, wholeTurn, turnFullyInVocabulary, turnHasQuestion }) => !interrogative
    && !turnHasQuestion
    && turnFullyInVocabulary
    && !turnHasNegationOrHedge(wholeTurn)
    && !turnHasUnresolvedConditional(wholeTurn)
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

// Binds one ALREADY-NORMALIZED commitment sentence (normalizeCommitmentText
// output) to the confirmed slot. Sentence-scoped by the caller: the slot
// facts come from the same utterance that passed the affirmative-form and
// vocabulary checks.
function quoteBindsConfirmedSlot(normalizedSentence, confirmedStartAt, callStartedAt) {
  const q = ` ${String(normalizedSentence || '')} `;
  // All slot facts derive from the CANONICAL ET wall clock — the same value
  // booking writes (see etWallClockOfConfirmedStart above).
  const wall = etWallClockOfConfirmedStart(confirmedStartAt);
  if (!q.trim() || !wall) return false;
  const wallY = Number(wall.slice(0, 4));
  const wallMo = Number(wall.slice(5, 7));
  const wallD = Number(wall.slice(8, 10));
  const wallH = Number(wall.slice(11, 13));
  if (![wallY, wallMo, wallD, wallH].every(Number.isFinite)) return false;
  // Calendar disambiguation (codex round-5 P1, tightened round 7): a weekday
  // name alone cannot distinguish "this Sunday" from "next Sunday". Compare
  // ET CALENDAR dates (an absolute 168h window is not calendar-unique around
  // DST transitions) and require the slot to fall 1–6 ET days after the
  // call's ET date: same-day is rejected (a "Sunday" spoken on a Sunday is
  // ambiguous between today and next week) and day 7 is rejected (same
  // weekday again). Within 1–6 days every weekday names exactly one date.
  const call = new Date(String(callStartedAt || ''));
  if (Number.isNaN(call.getTime())) return false;
  let dayDiff;
  try {
    const callYmd = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(call);
    dayDiff = (Date.UTC(wallY, wallMo - 1, wallD) - Date.parse(`${callYmd}T00:00:00Z`)) / 86400000;
  } catch { return false; }
  if (!(dayDiff >= 1 && dayDiff <= 6)) return false;
  // Weekday/hour/date facts from the canonical wall clock (a calendar date
  // is timezone-free, so UTC day-of-week of the wall date is exact).
  const weekday = WEEKDAY_NAMES[new Date(Date.UTC(wallY, wallMo - 1, wallD)).getUTCDay()];
  const hour12 = String(wallH % 12 || 12);
  const dayPeriod = wallH >= 12 ? 'pm' : 'am';
  const slotMonth = MONTH_NAMES[wallMo - 1];
  const slotDay = wallD;
  if (!weekday || !slotMonth) return false;
  // Explicit calendar dates must match the slot (codex P1): "Sunday, August
  // 9, at noon" shares weekday+time with an August 2 slot — the weekday
  // window alone cannot catch it. Any month name in the quote must be the
  // slot's ET month AND be immediately followed by the slot's day number
  // (ordinal suffixes tolerated); any standalone ordinal day ("the 9th")
  // must equal the slot's day. Unparseable or mismatched explicit dates
  // fail closed.
  const monthsInQuote = MONTH_NAMES.filter((m) => q.includes(` ${m} `));
  if (monthsInQuote.length) {
    if (monthsInQuote.length > 1 || monthsInQuote[0] !== slotMonth) return false;
    const dm = q.match(new RegExp(` ${slotMonth} (\\d{1,2})(?:st|nd|rd|th)?(?= )`));
    if (!dm || Number(dm[1]) !== slotDay) return false;
  }
  for (const om of q.matchAll(/ (\d{1,2})(?:st|nd|rd|th)(?= )/g)) {
    if (Number(om[1]) !== slotDay) return false;
  }
  // Numeric dates and years (codex P1): "Sunday 8/9 at noon" normalizes to
  // the adjacent digit pair "8 9" — every adjacent pair whose second token
  // is not the ":00" minutes must equal the slot's ET month/day. Any 3–4
  // digit number must be the slot's ET year; anything else is an
  // unvalidated explicit date token and fails closed.
  // Positional numeric-shape consumption (codex round-7j/7k): every RUN of
  // consecutive number tokens must parse as a complete shape the slot
  // explains — position matters, not just membership ("Sunday 8/2/2 at
  // noon" must not book a 2026-08-02 slot because the trailing 2 happens to
  // equal the day). Valid shapes: [hour12] · [hour12, 00] (spoken ":00") ·
  // [month, day] · [month, day, year] with a 2- or 4-digit slot year ·
  // [day] alone. Anything else — extra components, stray street numbers,
  // prices — fails closed.
  const runs = [];
  let run = [];
  for (const tok of q.split(' ')) {
    if (/^\d{1,4}$/.test(tok)) run.push(Number(tok));
    else if (run.length) { runs.push(run); run = []; }
  }
  if (run.length) runs.push(run);
  const h12 = Number(hour12);
  for (const r of runs) {
    const ok = (r.length === 1 && (r[0] === h12 || r[0] === slotDay))
      || (r.length === 2 && r[0] === h12 && r[1] === 0)
      || (r.length === 2 && r[0] === wallMo && r[1] === slotDay)
      || (r.length === 3 && r[0] === wallMo && r[1] === slotDay && (r[2] === wallY || r[2] === wallY % 100));
    if (!ok) return false;
  }
  // Exact binding, not presence (codex round-5 P1): a multi-slot turn
  // ("Sunday at 10 AM won't work, but we'll see you at 11 AM") scatters
  // matching tokens without committing to them. The quote must contain
  // EXACTLY ONE time mention and EXACTLY ONE weekday name, each equal to the
  // confirmed slot's. Time mentions are period-attached hours ("10 am",
  // "10 00 am") plus the unambiguous aliases noon (12 PM) / midnight
  // (12 AM), deduplicated by meaning ("12 pm" + "noon" is one mention).
  // Negations can't be parsed deterministically, so ANY second time or
  // weekday mention fails closed — the extraction prompt directs the model
  // to pin the single final commitment sentence.
  const mentions = new Set();
  for (const m of q.matchAll(/(?:^| )(\d{1,2})(?: 00)? (am|pm)(?= |$)/g)) {
    const h = String(Number(m[1]));
    if (Number(h) >= 1 && Number(h) <= 12) mentions.add(`${h} ${m[2]}`);
    else mentions.add(`invalid ${m[1]} ${m[2]}`);
  }
  if (q.includes(' noon ')) mentions.add('12 pm');
  if (q.includes(' midnight ')) mentions.add('12 am');
  const weekdaysInQuote = WEEKDAY_NAMES.filter((w) => q.includes(` ${w} `));
  return mentions.size === 1
    && mentions.has(`${Number(hour12)} ${dayPeriod}`)
    && weekdaysInQuote.length === 1
    && weekdaysInQuote[0] === weekday;
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

function canAutoRoute(extraction, opts = {}) {
  if (!extraction) return { allowed: false, reason: 'no_extraction' };

  const modelFlags = suppressAddressFlagsForAV(extraction.triage_flags || [], opts.addressValidation);
  const deterministicFlags = computeDeterministicTriageFlags(extraction, opts);
  const finalFlags = mergeTriageFlags(modelFlags, deterministicFlags);
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
  const newAddressGiven = statesNewAddress(extraction);
  if (opts.failOpen && confirmedWithStart) {
    const aniPresent = String(opts.callerAni || '').replace(/\D/g, '').length >= 10;
    const knownCustomer = !!opts.knownCustomer;
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
      if (f === 'low_extraction_confidence' && knownCustomer) { failedOpenFlags.push(f); return false; }
      if (FAIL_OPEN_KNOWN_CUSTOMER_ADDRESS_FLAGS.has(f) && knownCustomerHasAddress && !newAddressGiven) { failedOpenFlags.push(f); return false; }
      return true;
    });
  }

  const startOnTheHour = confirmedStartOnTheHour(extraction.scheduling?.confirmed_start_at);

  // A POSITIVE Address Validation verdict — Google accepted (or corrected)
  // the stated address AND placed it in the service area. Required before
  // the authorization demotion below (codex round-3 P1): when AV is disabled
  // or returns not_attempted, computeDeterministicTriageFlags raises NO
  // address flag for a populated, high-confidence address, so
  // caller_not_authorized was the incidental last block standing between an
  // unvalidated address and an auto-dispatch. Demoting it unconditionally
  // would let an unknown-relationship call book against an address nobody
  // ever validated (AGENTS.md L367-370: never silent auto-route).
  const avPositivelyValidated = !!opts.addressValidation
    && ['validated_accept', 'corrected'].includes(String(opts.addressValidation.status || ''))
    && opts.addressValidation.inServiceArea === true;

  // Unknown relationship is NOT non-owner (owner ruling 2026-07-31, call
  // log a771fa15): most homeowners never STATE "it's my house", so
  // relationship_to_property arrives 'unknown' and on_site_authorization
  // false — and the hard block held a caller who requested service, gave
  // their info, and agreed a start time. The hard block now applies only
  // when the caller is EXPLICITLY a non-owner (tenant/realtor/
  // property_manager/...) — those still route through the agent-commitment
  // demotion below. The flag moves to failedOpenFlags so the office still
  // gets the "confirm the account holder" advisory card — book-and-flag,
  // never book-and-hide.
  //
  // Guarded on a confirmed, on-the-hour start AND a positively validated
  // address: this is the last block on the path, so everything it used to
  // backstop has to be satisfied some other way before it lifts.
  const callerRelationship = String(extraction.caller?.relationship_to_property || 'unknown').trim() || 'unknown';
  const explicitlyNonOwner = callerRelationship !== 'owner' && callerRelationship !== 'unknown';
  // What the guard actually needs is a TRUSTED dispatch address, and the
  // central address-trust gate below recognises exactly two ways to have one:
  // a positive AV verdict, or a known customer's on-file address they did not
  // restate (verified when it was saved). Demanding only the first blocked the
  // commonest shape of the very call this ruling exists for (codex round-20
  // P1) — a returning customer says "same place as always", so nothing is
  // stated, no AV runs, no address flag fires, and caller_not_authorized was
  // left as the incidental last block. Same predicate as the central gate, so
  // the two can never disagree about what "trusted" means.
  const trustedDispatchAddress = avPositivelyValidated || dispatchesToOnFileAddress(extraction, opts);
  if (!explicitlyNonOwner && confirmedWithStart && startOnTheHour && trustedDispatchAddress) {
    appointmentBlockingFlags = appointmentBlockingFlags.filter((f) => {
      if (f === 'caller_not_authorized') { failedOpenFlags.push(f); return false; }
      return true;
    });
  }

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
    appointmentBlockingFlags = appointmentBlockingFlags.filter((f) => {
      if (f === 'caller_not_authorized') { failedOpenFlags.push(f); return false; }
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
  const failOpenLowConfidence = opts.failOpen && !!opts.knownCustomer
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

  return { allowed: true, flags: finalFlags, failedOpenFlags: failedOpenFlags.length ? failedOpenFlags : undefined };
}

// Suffix-insensitive street comparison shared by the shadow bridge and the
// second-address check, so "123 Main St" and "123 Main Street" compare equal
// (otherwise a benign expansion opens a false second_service_address review).
const streetHouseNum = (s) => (String(s || '').trim().match(/^\d+/) || [''])[0];
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
    // missing unit) and persists across calls until the office collects it.
    if (isMissingUnitNumber(av)) needsConfirmation.push('missing_unit_number');
  } else if (hadStreet && status === 'out_of_service_area') {
    needsConfirmation.push('out_of_service_area');
  }

  const flags = Array.isArray(v2TriageFlags) ? v2TriageFlags : [];
  if (flags.includes('caller_not_authorized')) needsConfirmation.push('caller_not_authorized');
  // V2-only address evidence: when legacy V1 missed the street entirely,
  // hadStreet is false and the address branch above never ran — but V2 heard
  // the building address, and its deterministic pass (fed the same AV
  // verdict) already flagged the missing unit. Consume it so the ask still
  // files; dedupe with the branch's own push for the both-heard case.
  if (flags.includes('missing_unit_number') && !needsConfirmation.includes('missing_unit_number')) {
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

/** Did the caller state a service address on this call at all? */
function statesNewAddress(extraction) {
  const sa = extraction?.property?.service_address || {};
  return NEW_ADDRESS_FIELDS.some((k) => String(sa[k] || '').trim());
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
    && !statesNewAddress(extraction));
}

module.exports = {
  computeDeterministicTriageFlags,
  statesNewAddress,
  dispatchesToOnFileAddress,
  mergeTriageFlags,
  suppressAddressFlagsForAV,
  isMissingUnitNumber,
  deriveCallReviewBridge,
  deriveEmailReview,
  mergeNeedsConfirmation,
  detectRentalSignal,
  streetCompareKey,
  canAutoRoute,
  SMS_ONLY_FLAGS,
  ADVISORY_TRIAGE_FLAGS,
  BLOCKING_TRIAGE_FLAGS,
  CANONICAL_WRITE_BLOCKING_FLAGS,
  confirmedStartOnTheHour,
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
