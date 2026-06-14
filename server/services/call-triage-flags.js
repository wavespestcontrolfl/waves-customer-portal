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
    }
    // validated_accept / corrected → clean, no address flag (the whole point:
    // a corrected bad zip clears triage instead of holding the call).
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

  // A decisive AV acceptance is authoritative for the address + service area —
  // drop any address flags reached above (incl. a lead_quality-sourced
  // out_of_service_area) so a verified in-area address is not held.
  return suppressAddressFlagsForAV(flags, opts.addressValidation);
}

const SMS_ONLY_FLAGS = new Set([
  'no_sms_consent_captured',
  'sms_consent_missing',
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
]);

function suppressAddressFlagsForAV(flags, addressValidation) {
  const s = addressValidation?.status;
  if (s !== 'validated_accept' && s !== 'corrected') return flags || [];
  return (flags || []).filter((f) => !ADDRESS_FLAGS_SUPERSEDED_BY_AV.has(f));
}

function mergeTriageFlags(modelFlags, deterministicFlags) {
  return [...new Set([...(modelFlags || []), ...(deterministicFlags || [])])];
}

function canAutoRoute(extraction, opts = {}) {
  if (!extraction) return { allowed: false, reason: 'no_extraction' };

  const modelFlags = suppressAddressFlagsForAV(extraction.triage_flags || [], opts.addressValidation);
  const deterministicFlags = computeDeterministicTriageFlags(extraction, opts);
  const finalFlags = mergeTriageFlags(modelFlags, deterministicFlags);
  const appointmentBlockingFlags = finalFlags.filter(f => !SMS_ONLY_FLAGS.has(f));

  if (appointmentBlockingFlags.length > 0) {
    return { allowed: false, reason: 'triage_flags', flags: finalFlags, appointmentBlockingFlags };
  }

  const confidence = extraction.confidence || {};
  const threshold = opts.confidenceThreshold || DEFAULT_CONFIDENCE_THRESHOLD;

  if (typeof confidence.overall !== 'number' || confidence.overall < threshold) {
    return { allowed: false, reason: 'low_confidence', overall: confidence.overall };
  }

  const scheduling = extraction.scheduling || {};
  if (scheduling.status !== 'confirmed') {
    return { allowed: false, reason: 'not_confirmed', schedulingStatus: scheduling.status };
  }

  if (!scheduling.confirmed_start_at) {
    return { allowed: false, reason: 'confirmed_without_start_time', schedulingStatus: scheduling.status };
  }

  if (extraction.consent?.do_not_contact_request === true) {
    return { allowed: false, reason: 'do_not_contact' };
  }

  return { allowed: true, flags: finalFlags };
}

module.exports = {
  computeDeterministicTriageFlags,
  mergeTriageFlags,
  suppressAddressFlagsForAV,
  canAutoRoute,
  SMS_ONLY_FLAGS,
  CANONICAL_WRITE_BLOCKING_FLAGS,
  hasCanonicalWriteBlock,
  hasNameEmailMismatch,
  isDialablePhone,
  SERVICE_AREA_COUNTIES,
  normalizeCounty,
  isInServiceAreaCounty,
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_ADDRESS_CONFIDENCE_THRESHOLD,
};
