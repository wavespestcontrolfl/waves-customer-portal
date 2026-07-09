/**
 * Call Recording Processor.
 *
 * Processes Twilio call recordings end-to-end:
 *   1. Transcribe audio (OpenAI, Gemini fallback, or Twilio built-in)
 *   2. AI extraction: customer info, appointment details, pain points, sentiment
 *   3. Create/update customer in portal DB
 *   4. If appointment detected → create calendar row, register reminders, send confirmation SMS + log
 *   5. Tag lead in Beehiiv + enroll in automation
 *   6. Full audit trail in call_log
 */

const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const MODELS = require('../config/models');
const twilio = require('twilio');

// Delegates to the shared robust title-caser (Mc/Mac/O'/particles/hyphens) so
// AI call-extracted names match every other ingestion path.
function capitalizeName(name) {
  return properCase(name);
}
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { subscribeOrResubscribe, EMAIL_RE } = require('./newsletter-subscribers');
const { sendConfirmationEmail } = require('./newsletter-confirm');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { isLikelyE164 } = require('../utils/phone');
const { resolveLocation } = require('../config/locations');
const { parseETDateTime, formatETDate, formatETTime, etDateString, etParts } = require('../utils/datetime-et');
const { promoteCustomerOnBooking } = require('./customer-stages');
const { normalizeCallExtraction, applyContactNormalization } = require('../utils/intake-normalize');
const { properCase } = require('../utils/name-case');
const { validateModelOutput, validatePersisted, SCHEMA_VERSION } = require('../schemas/validate-extraction');
const { normalizeExtractionV2 } = require('../utils/normalize-extraction-v2');
const { buildExtractionPrompt, extractionPromptVersion, PROMPT_HASH } = require('./prompts/call-extraction-v1');
const { writeLegacyShadowRouteDecision } = require('./call-route-decisions');
const { stageCustomerFieldCandidates } = require('./call-field-candidates');
const modelOutputSchema = require('../schemas/call-extraction.model-output.schema.json');

const CALL_EXTRACTION_V2_ENABLED = process.env.CALL_EXTRACTION_V2_ENABLED === 'true';
const CALL_EXTRACTION_V2_DRIVES_ROUTING =
  process.env.CALL_EXTRACTION_V2_DRIVES_ROUTING === 'true'
  || process.env.CALL_TRIAGE_ENFORCE_V2_GATES === 'true';
// Boot-time flag audit — makes three silent operational traps visible:
// (1) enforce mode is the OR of two env vars, so unsetting
//     CALL_EXTRACTION_V2_DRIVES_ROUTING is a no-op while the legacy
//     CALL_TRIAGE_ENFORCE_V2_GATES alias is still set;
// (2) DRIVES_ROUTING without V2_ENABLED kills BOTH the enforce gate and the
//     shadow bridge — bare legacy V1 routing, worse than either intended mode;
// (3) enforce without ADDRESS_VALIDATION_ENABLED never suppresses the model's
//     near-universal address_unverifiable flag → ~zero auto-routing.
{
  const aliasRaw = process.env.CALL_TRIAGE_ENFORCE_V2_GATES;
  const drivesRaw = process.env.CALL_EXTRACTION_V2_DRIVES_ROUTING;
  console.log(`[call-proc] flags: v2Enabled=${CALL_EXTRACTION_V2_ENABLED} enforce=${CALL_EXTRACTION_V2_DRIVES_ROUTING} (DRIVES_ROUTING=${drivesRaw ?? 'unset'}, ENFORCE_V2_GATES alias=${aliasRaw ?? 'unset'}) av=${process.env.ADDRESS_VALIDATION_ENABLED ?? 'unset'}`);
  if (aliasRaw === 'true' && drivesRaw !== 'true') {
    console.warn('[call-proc] WARNING: enforce mode is pinned ON by the legacy CALL_TRIAGE_ENFORCE_V2_GATES alias — unsetting CALL_EXTRACTION_V2_DRIVES_ROUTING will NOT demote to shadow until the alias is also unset.');
  }
  if (CALL_EXTRACTION_V2_DRIVES_ROUTING && !CALL_EXTRACTION_V2_ENABLED) {
    console.warn('[call-proc] WARNING: CALL_EXTRACTION_V2_DRIVES_ROUTING without CALL_EXTRACTION_V2_ENABLED — enforce gate AND shadow bridge are both dead; running bare legacy V1 routing.');
  }
  if (CALL_EXTRACTION_V2_DRIVES_ROUTING && process.env.ADDRESS_VALIDATION_ENABLED !== 'true') {
    console.warn('[call-proc] WARNING: enforce mode without ADDRESS_VALIDATION_ENABLED — address_unverifiable is never suppressed, so virtually no call will auto-route.');
  }
}
const { computeDeterministicTriageFlags, mergeTriageFlags, suppressAddressFlagsForAV, canAutoRoute, hasCanonicalWriteBlock, deriveCallReviewBridge, deriveEmailReview, mergeNeedsConfirmation, detectRentalSignal, ADVISORY_TRIAGE_FLAGS } = require('./call-triage-flags');
const { recoverStreetAddress, RECOVERABLE_STATUSES } = require('./address-validation/recovery');
const { detectContactDictationSignals, decodeDictatedContacts, applyEmailDictationPolicy, CONTACT_DICTATION_TRANSCRIPTION_PROMPT } = require('./contact-dictation');
const { computeAppointmentIdempotencyKey, computeAddressHash, checkTcpaConsent, buildRouteDecision, buildTriageItem } = require('./call-routing-gates');
const { isV2Extraction, flatView } = require('../utils/extraction-compat');
const { loadBookableCallServices, resolveCallBookingCatalogService, resolveCallBookingPrice, resolveCallFollowUpPlan, callBookingInvoiceOnComplete, callFollowUpBillingShape, callBookingDateOnly } = require('./call-booking-catalog');
const { validateAddress, buildAddressLines } = require('./address-validation');
const { renderSmsTemplate } = require('./sms-template-renderer');
const { syncVoiceMessageForCall } = require('./conversations');

// Prod technician row is named "Adam" (verified 2026-07-08) — the old
// 'Adam B.' default never name-matched and assignment survived only on the
// sole-active-technician fallback.
const DEFAULT_CALL_BOOKING_TECHNICIAN_NAME = process.env.CALL_BOOKING_DEFAULT_TECHNICIAN_NAME || 'Adam';
// Owner directive 2026-07-08: call-booked visits default to a 60-minute
// duration when the catalog doesn't specify one.
const DEFAULT_CALL_BOOKING_DURATION_MINUTES = 60;
const OPENAI_TRANSCRIPTIONS_API = 'https://api.openai.com/v1/audio/transcriptions';
const OPENAI_RESPONSES_API = 'https://api.openai.com/v1/responses';
const OPENAI_TRANSCRIPTION_MODEL = process.env.OPENAI_TRANSCRIPTION_MODEL || 'gpt-4o-transcribe-diarize';
const OPENAI_TRANSCRIPT_LABEL_MODEL = process.env.OPENAI_TRANSCRIPT_LABEL_MODEL || process.env.OPENAI_MODEL || 'gpt-5-mini';
const OPENAI_COMPLETENESS_FALLBACK_SECONDS = Number(process.env.OPENAI_COMPLETENESS_FALLBACK_SECONDS) || 600;
const OPENAI_COMPLETENESS_FALLBACK_CHARS = Number(process.env.OPENAI_COMPLETENESS_FALLBACK_CHARS) || 7000;
const OPENAI_TRANSCRIPTION_PROMPT = `Transcribe this phone call recording for Waves Pest Control (pest control and lawn care, Southwest Florida).

Preserve fillers like "um" and "uh", numbers, addresses, phone numbers, and proper nouns exactly as spoken.
Street names in addresses are real words or proper names — prefer a plausible street name over a nonsense phonetic rendering.
When a caller spells something letter-by-letter or with phonetic markers like "B as in boy", write each letter and marker separately exactly as spoken — never merge a spelled sequence into a guessed word, email, or web address.
Use punctuation and line breaks where helpful. Do not summarize, translate, or add commentary.`;
const GEMINI_TRANSCRIPTION_MODEL = process.env.GEMINI_TRANSCRIPTION_MODEL || 'gemini-2.5-flash';
// v2 extraction uses Gemini 2.5 Pro — most capable model for the deeply-nested
// v1.0.0 schema (better structured-output adherence + fewer hallucinations than
// Flash), and unlike Claude Opus 4.7 it still supports temperature (extraction
// pins temp 0 for determinism). Env-overridable for instant rollback.
// NOTE: this var governs the V2 extractor ONLY — the dictation decoder and
// street recovery have their own vars (GEMINI_CONTACT_DECODER_MODEL /
// GEMINI_RECOVERY_MODEL) with literal defaults, so an extraction rollback no
// longer silently degrades the mishear-recovery lanes.
const GEMINI_EXTRACTION_MODEL = process.env.GEMINI_EXTRACTION_MODEL || 'gemini-2.5-pro';
// V1 (legacy) extractor model — historically hardcoded in the request URL,
// which made V1 the only lane without a zero-deploy rollback lever.
const GEMINI_EXTRACTION_V1_MODEL = process.env.GEMINI_EXTRACTION_V1_MODEL || 'gemini-2.5-flash';

// Human-readable "confirm before dispatch" reasons surfaced by the address /
// identity bridge below. Shown on the lead's AI-triage activity so Virginia
// knows exactly what to verify on the callback, instead of dispatching on a
// silently-unverified address or an incomplete account holder.
const CONFIRM_REASON_TEXT = {
  address_unverified: 'service address could not be verified — read it back to the caller',
  address_recovered: 'street name was garbled in transcription — matched to a single validated address; read it back to the caller',
  out_of_service_area: 'address resolves outside the service area — verify the county',
  caller_not_authorized: 'caller is arranging service for someone else — confirm the account holder',
  missing_last_name: "no last name captured — get the account holder's full name",
  rental_or_tenant_occupied: 'rental / tenant-occupied property — confirm property access and whether to tag it a rental',
  second_service_address: 'service address differs from the one on file — may be a second property (e.g. a rental vs. their home)',
  email_unverified: 'email was spelled out on the call — read it back to the caller before relying on it (spelled letters mishear)',
  email_invalid: 'captured email is not a valid address — re-collect it on the callback',
  email_bounced: 'email on file hard-bounced (mailbox rejected) — get a corrected address; estimates/receipts will not deliver',
  secondary_contact_captured: 'a second contact (buyer/tenant/spouse) was named on the call — confirm their name and number before relying on them for notifications',
};
const describeConfirmReason = (r) => CONFIRM_REASON_TEXT[r] || r;
// Normalized street comparison (case/space/punctuation-insensitive) — "12338
// Amber Creek" != "12398 Amber Creek", but "Ambercreek" == "Amber Creek".
const normStreet = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function twilioClient() {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return null;
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

function recordingMediaUrl(recording) {
  if (recording.mediaUrl) return `${recording.mediaUrl}.mp3`;
  if (!recording.uri) return null;
  return `https://api.twilio.com${recording.uri.replace(/\.json$/, '')}.mp3`;
}

function newestCompletedRecording(recordings) {
  return recordings
    .filter((r) => r && r.status === 'completed' && r.sid)
    .sort((a, b) => new Date(b.dateCreated || 0) - new Date(a.dateCreated || 0))[0] || null;
}

function maskSid(sid) {
  if (!sid) return 'none';
  const value = String(sid);
  if (value.length <= 8) return `${value.slice(0, 2)}...`;
  return `${value.slice(0, 2)}...${value.slice(-6)}`;
}

async function updateUnifiedVoiceMessage(call, patch = {}) {
  if (!call?.twilio_call_sid) return null;
  const media = call.recording_url
    ? [{
        type: 'recording',
        url: call.recording_url,
        sid: call.recording_sid || null,
        duration_seconds: call.recording_duration_seconds || call.duration_seconds || null,
      }]
    : null;

  const update = {
    updated_at: new Date(),
    ...patch,
  };
  if (media) update.media = JSON.stringify(media);

  try {
    return await syncVoiceMessageForCall(call.twilio_call_sid, update);
  } catch (err) {
    logger.warn(`[call-proc] Unified voice message update failed for ${maskSid(call.twilio_call_sid)}: ${err.message}`);
    return null;
  }
}

function isOutboundCall(call = {}) {
  return String(call.direction || '').toLowerCase().startsWith('outbound');
}

function phoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function phoneKey(value) {
  const digits = phoneDigits(value);
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

function samePhone(a, b) {
  const aKey = phoneKey(a);
  const bKey = phoneKey(b);
  return !!aKey && !!bKey && aKey === bKey;
}

function maskPhone(value) {
  const digits = phoneDigits(value);
  return digits ? `***${digits.slice(-4)}` : 'unknown';
}

// Blocked/anonymous caller-ID presentations. Twilio substitutes digit
// sentinels for suppressed caller IDs — +266696687 spells ANONYMOUS,
// +7378742833 spells RESTRICTED — and carriers pass literal words through.
// toE164 returns these raw, and they LOOK usable downstream: the first named
// blocked caller used to mint a customer keyed on the sentinel, and every
// later blocked caller single-matched onto that one phantom record (strangers'
// addresses, emails, and bookings merging onto it).
const PHONE_SENTINELS = new Set(['266696687', '7378742833', '86282452253']);
const PHONE_SENTINEL_WORDS = /^(anonymous|restricted|unavailable|unknown|blocked)$/i;
function isUsableContactPhone(value) {
  const v = String(value || '').trim();
  if (!v || PHONE_SENTINEL_WORDS.test(v)) return false;
  if (!isLikelyE164(v)) return false;
  const digits = v.replace(/\D/g, '');
  return !PHONE_SENTINELS.has(digits) && !PHONE_SENTINELS.has(digits.replace(/^1/, ''));
}

// Return the first candidate that is a real EXTERNAL number — i.e. not one of our
// own lines AND not a staff forward/CSR cell. An INTERNAL number appearing as the
// caller/callee is a call-forwarding artifact (a DNI tracking number masking the
// true caller, or the staff cell the inbound <Dial> forwarded to), never a real
// customer; keying a lead/customer on it collapses many callers onto one phantom
// record (or onto a CSR). Skipping internal candidates (and returning null when
// every candidate is internal or an anonymous sentinel) stops that at the source.
function firstExternalPhone(...candidates) {
  for (const c of candidates) {
    const v = c && String(c).trim();
    if (v && !TWILIO_NUMBERS.isInternalNumber(v) && isUsableContactPhone(v)) return v;
  }
  return null;
}

// Hamming distance over the last 7 digits when both numbers share length —
// a spoken callback number ONE OR TWO digits off the ANI is almost always the
// caller misreciting (or the transcriber mishearing) their OWN number, not a
// genuinely different callback line. Genuine "reach me on my husband's cell"
// numbers differ wholesale and never trip this.
function phoneNearMissOfAni(extracted, ani) {
  const a = phoneKey(extracted);
  const b = phoneKey(ani);
  if (!a || !b || a === b) return false;
  if (a.length !== b.length || a.length < 10) return false;
  const a7 = a.slice(-7);
  const b7 = b.slice(-7);
  let diff = a.slice(0, -7) === b.slice(0, -7) ? 0 : Infinity;
  if (!Number.isFinite(diff)) return false;
  for (let i = 0; i < 7; i += 1) if (a7[i] !== b7[i]) diff += 1;
  return diff > 0 && diff <= 2;
}

function resolveCallContactPhone(call = {}, extractedPhone = null) {
  const extracted = String(extractedPhone || '').trim();
  if (isOutboundCall(call)) {
    if (extracted && !samePhone(extracted, call.from_phone)) {
      if (phoneNearMissOfAni(extracted, call.to_phone)) {
        logger.warn(`[call-proc] Extracted callback ${maskPhone(extracted)} is a near-miss of dialed ${maskPhone(call.to_phone)} — keeping the dialed number (likely mistranscribed digits)`);
        return firstExternalPhone(call.to_phone, call.from_phone);
      }
      return firstExternalPhone(extracted, call.to_phone, call.from_phone);
    }
    return firstExternalPhone(call.to_phone, extracted, call.from_phone);
  }

  if (extracted && !samePhone(extracted, call.to_phone)) {
    // The verified ANI beats a spoken number that differs from it by only a
    // digit or two — one misheard digit used to re-key the whole call
    // (matching, the customer's stored phone, the confirmation SMS target)
    // onto a stranger's number.
    if (phoneNearMissOfAni(extracted, call.from_phone)) {
      logger.warn(`[call-proc] Extracted callback ${maskPhone(extracted)} is a near-miss of ANI ${maskPhone(call.from_phone)} — keeping the ANI (likely mistranscribed digits)`);
      return firstExternalPhone(call.from_phone, call.to_phone);
    }
    return firstExternalPhone(extracted, call.from_phone, call.to_phone);
  }
  return firstExternalPhone(call.from_phone, extracted, call.to_phone);
}

function normalizeNamePart(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function extractedNameMatchesCustomer(extracted = {}, customer = {}) {
  const extractedFirst = normalizeNamePart(extracted.first_name);
  const customerFirst = normalizeNamePart(customer.first_name);
  if (!extractedFirst || !customerFirst) return true;
  if (extractedFirst !== customerFirst) return false;

  const extractedLast = normalizeNamePart(extracted.last_name);
  const customerLast = normalizeNamePart(customer.last_name);
  if (extractedLast && customerLast && extractedLast !== customerLast) return false;
  return true;
}

function customerPhoneMatches(phone, customer = {}) {
  return samePhone(phone, customer.phone);
}

const LEAD_PIPELINE_STAGES = new Set([
  'new_lead',
  'contacted',
  'qualified',
  'estimate_needed',
  'estimate_draft',
  'estimate_sent',
  'estimate_viewed',
  'follow_up',
  'negotiating',
]);

// Terminal lead statuses (`leads.status`). Mirrors admin-leads.js's own
// "active lead" definition (status NOT IN these). The customer-less recovery
// path reuses only ACTIVE leads — a denylist of these terminal outcomes rather
// than an open-status allowlist, so every open pipeline status (estimate_sent /
// estimate_viewed / estimate_drafted / awaiting_address / …) is covered without
// enumerating a growing set, while won/lost/disqualified/duplicate rows fall
// through to a fresh insert instead of hiding the inquiry on a closed lead.
const TERMINAL_LEAD_STATUSES = ['won', 'lost', 'disqualified', 'duplicate'];

function shouldCreateCallLeadForCustomer(customer, { createdCustomerFromCall = false } = {}) {
  if (!customer) return false;
  if (createdCustomerFromCall) return true;
  return LEAD_PIPELINE_STAGES.has(String(customer.pipeline_stage || '').toLowerCase());
}

// Coarse account classification of a phone-matched caller, used only to give the
// extraction model context ("this caller is already a Waves customer"). Mirrors
// shouldCreateCallLeadForCustomer's stage split: a customer still in a pipeline
// stage is an open lead; anything else (won / active_customer / churned …) is an
// established customer whose routine coordination/complaint/billing calls are not
// new leads.
function classifyCallerAccount(pipelineStage) {
  const stage = String(pipelineStage || '').trim().toLowerCase();
  if (!stage) return 'unknown';
  return LEAD_PIPELINE_STAGES.has(stage) ? 'open_lead' : 'established_customer';
}

// Short, PII-light caller hint for the extraction prompt. Returns null when the
// inbound number doesn't map to a single known customer.
function summarizeKnownCaller(customer) {
  if (!customer) return null;
  const name = [customer.first_name, customer.last_name]
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .join(' ');
  return {
    name: name || null,
    accountType: classifyCallerAccount(customer.pipeline_stage),
  };
}

// Call types that are NOT new sales leads. spam/voicemail are handled by their
// own booleans + early return; these are the existing-customer/non-sales calls
// the classifier now labels so they stop spawning leads. Kept narrow on purpose:
// a genuine new prospect is `new_inquiry`, so vetoing on these never drops a real
// lead, it only stops re-triaging people who already bought or aren't buying.
const NON_LEAD_CALL_TYPES = new Set([
  'existing_customer_scheduling',
  'existing_customer_service',
  'complaint',
  'billing',
  'wrong_number',
]);

// Content-based veto: the call is not a new lead when the model explicitly says
// so (is_lead === false) or labels it a non-lead call_type. Both signals are
// optional — when the model omits them (or extraction fell back), this returns
// false so behavior matches the legacy pipeline-stage-only gate.
function isNonLeadCallContent(extracted = {}) {
  if (extracted && extracted.is_lead === false) return true;
  const callType = String(extracted?.call_type || '').trim().toLowerCase();
  return NON_LEAD_CALL_TYPES.has(callType);
}

// Word-of-mouth referral detection from the AI call extraction. The prompt sets
// referred_by to the referrer's name (or 'unnamed') ONLY on an explicit referral.
// Returns that name, or '' when there's no referral — used to override the dialed-
// number source with the 'referral' channel so word-of-mouth is attributed.
const REFERRAL_PLACEHOLDER_VALUES = new Set([
  'null', 'none', 'n/a', 'na', 'no', 'false', 'true', 'unknown', 'undefined',
  'not mentioned', 'not stated', 'not specified', 'not provided', 'nobody', 'no one',
]);
function referrerNameFromExtracted(extracted = {}) {
  // Model-generated JSON has no schema enforcement — fail CLOSED: a non-string
  // sentinel (e.g. boolean false) or a placeholder phrase must NOT be read as a
  // referrer name and flip a normal call to lead_source='referral'.
  const v = extracted?.referred_by;
  if (typeof v !== 'string') return '';
  const raw = v.trim();
  if (!raw || REFERRAL_PLACEHOLDER_VALUES.has(raw.toLowerCase())) return '';
  return raw.slice(0, 100); // sane cap for a name/'unnamed' (detail is clamped again at write)
}

// Additional properties discussed on the call (multi-property callers: a
// landlord's rental + home, two units, a second house). Prefer the V1
// extraction's normalized entries; fall back to the V2 extraction's
// property.additional_properties (mapped to the same flat shape). Both sources
// were normalized/filtered upstream, so entries here always carry a street.
function resolveCallAdditionalProperties(extracted = {}, v2Extraction = null) {
  const v1Entries = Array.isArray(extracted.additional_properties) ? extracted.additional_properties : [];
  if (v1Entries.length) return v1Entries;
  const { mapAdditionalPropertiesToLegacy } = require('../utils/extraction-compat');
  return mapAdditionalPropertiesToLegacy(v2Extraction?.property?.additional_properties);
}

// Quote signals from EITHER extractor. quote_promised means the agent committed
// to send a quote AFTER the call (work still owed) — it keeps the lead open in
// the pipeline even when an appointment was also booked, and fires the
// quote-promised admin notification. quote_requested is informational (stored
// on the lead) and never changes routing on its own.
function resolveCallQuoteSignals(extracted = {}, v2Extraction = null) {
  const svc = v2Extraction?.service_request || {};
  return {
    quoteRequested: extracted.quote_requested === true || svc.quote_requested === true,
    quotePromised: extracted.quote_promised === true || svc.quote_promised === true,
  };
}

// Secondary contact from EITHER extractor (a realtor's home buyer, a landlord's
// tenant, a spouse). Both sources were normalized upstream, so an object here
// always carries at least a name, phone, or email. When BOTH extractors caught
// the same person, merge field-wise (V1 wins where present, V2 fills gaps —
// split parses where one extractor caught the phone/email the other missed);
// when their identities conflict (different phone, email, or first name), the
// V1 extraction wins unmerged — never chimera two different people.
function resolveCallSecondaryContact(extracted = {}, v2Extraction = null) {
  const { mapSecondaryContactToLegacy } = require('../utils/extraction-compat');
  const v1 = (extracted.secondary_contact && typeof extracted.secondary_contact === 'object')
    ? extracted.secondary_contact
    : null;
  const v2 = mapSecondaryContactToLegacy(v2Extraction?.secondary_contact);
  if (!v1 || !v2) return v1 || v2;

  const last10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);
  const norm = (v) => String(v || '').trim().toLowerCase();
  const conflicts = (v1.phone && v2.phone && last10(v1.phone) !== last10(v2.phone))
    || (v1.email && v2.email && norm(v1.email) !== norm(v2.email))
    || (v1.first_name && v2.first_name && norm(v1.first_name) !== norm(v2.first_name))
    // Same first name is NOT the same person when the surnames disagree —
    // without this, "Joe Smith" (V1) could inherit "Joe Jones"'s (V2) phone.
    || (v1.last_name && v2.last_name && norm(v1.last_name) !== norm(v2.last_name));
  if (conflicts) return v1;

  return {
    first_name: v1.first_name || v2.first_name,
    last_name: v1.last_name || v2.last_name,
    phone: v1.phone || v2.phone,
    email: v1.email || v2.email,
    role: (v1.role && v1.role !== 'unknown') ? v1.role : v2.role,
    // OR, not V1-wins: either extractor observing the caller's direction
    // ("send notifications to the buyer and myself") is enough.
    wants_notifications: v1.wants_notifications === true || v2.wants_notifications === true,
    notes: v1.notes || v2.notes,
  };
}

// Persist a call's secondary contact into the customer's first EMPTY
// service-contact slot so the existing appointment fan-out
// (customer-contact.js getAppointmentContacts: confirmation, en-route,
// tech-arrived) starts including them. Only runs when the CALLER directed
// notifications to this person (wants_notifications) — a merely-mentioned
// person stays in the triage payload / lead extracted_data for the office to
// decide on. Two guardrails:
// - Never overwrite: only a fully empty slot is written; a phone/email already
//   on the record (primary or any slot) makes this a no-op.
// - Filling a slot silently REPLACES the primary in appointment texts
//   (getAppointmentContacts drops the primary unless appointment_notify_primary
//   is set) — so when this write adds the customer's FIRST service contact, it
//   also sets appointment_notify_primary=true to keep the caller in the loop.
//   A customer who already had service contacts keeps their existing
//   notify-primary choice: that was an explicit admin decision.
// Returns a short status string for logging/tests.
async function persistCallSecondaryContact(customerId, contact) {
  if (!customerId || !contact || contact.wants_notifications !== true) return 'skipped_no_intent';
  if (!contact.phone && !contact.email) return 'skipped_no_contact_info';
  const { SERVICE_CONTACT_SLOTS } = require('./customer-contact');
  const customer = await db('customers').where({ id: customerId }).first();
  if (!customer) return 'skipped_no_customer';

  const last10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);
  const lowerEmail = (v) => String(v || '').trim().toLowerCase();
  const knownPhones = [customer.phone, ...SERVICE_CONTACT_SLOTS.map((s) => customer[s.phone])]
    .map(last10).filter(Boolean);
  const knownEmails = [customer.email, ...SERVICE_CONTACT_SLOTS.map((s) => customer[s.email])]
    .map(lowerEmail).filter(Boolean);
  if (contact.phone && knownPhones.includes(last10(contact.phone))) return 'skipped_phone_on_record';
  // Cross-customer guard: a secondary phone that belongs to a DIFFERENT
  // existing customer must never land in this customer's fan-out slots —
  // customer B would start receiving customer A's appointment texts at
  // service_contact_authorized trust. The call site escalates this to its own
  // review flag so the office adjudicates the collision.
  if (contact.phone) {
    const otherCustomer = await db('customers')
      .whereNull('deleted_at')
      .whereNot('id', customerId)
      .whereRaw("RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [last10(contact.phone)])
      .first('id');
    if (otherCustomer) return 'skipped_phone_belongs_to_other_customer';
  }
  // Email dedup runs INDEPENDENTLY of the phone: a contact with a new phone
  // but an email already on the record (primary or any slot) keeps the phone
  // and drops the duplicate email — otherwise the caller's own address gets
  // re-filed under the buyer/tenant's name and future appointment emails
  // reach it mislabeled. Email-only contacts with a known email are a no-op.
  const emailOnRecord = contact.email && knownEmails.includes(lowerEmail(contact.email));
  if (!contact.phone && emailOnRecord) return 'skipped_email_on_record';
  const slotEmail = emailOnRecord ? null : (contact.email || null);

  const slotHasContent = (s) => !!(String(customer[s.name] || '').trim()
    || String(customer[s.phone] || '').trim() || String(customer[s.email] || '').trim());
  // The two notify-primary prefs guard DIFFERENT channels, so "already had a
  // service contact" is judged PER CHANNEL: appointment texts drop the primary
  // on the first slot PHONE (getAppointmentContacts is phone-based), report
  // emails drop the primary on the first slot EMAIL. A name-only placeholder
  // slot never carried notifications on either channel. Slot SELECTION still
  // avoids any slot with content, so a placeholder is never overwritten.
  const hadSlotPhone = SERVICE_CONTACT_SLOTS.some((s) => !!String(customer[s.phone] || '').trim());
  const hadSlotEmail = SERVICE_CONTACT_SLOTS.some((s) => !!String(customer[s.email] || '').trim());
  const emptySlot = SERVICE_CONTACT_SLOTS.find((s) => !slotHasContent(s));
  if (!emptySlot) return 'skipped_slots_full';

  const fullName = [contact.first_name, contact.last_name]
    .map((v) => String(v || '').trim()).filter(Boolean).join(' ') || null;
  // Prefs FIRST, slot second: the moment a service-contact slot is populated,
  // getAppointmentContacts / getServiceReportEmailRecipients drop the primary
  // unless the notify-primary prefs are set — so the prefs write must land
  // BEFORE the slot becomes visible, or a crash between the two silently cuts
  // the caller out of the updates they explicitly asked for. The inverse
  // failure (prefs set, slot write loses the race below) is benign: with no
  // new contact the prefs are inert defaults-plus.
  // Per channel: writing the customer's first slot PHONE flips
  // appointment_notify_primary (texts); writing their first slot EMAIL flips
  // service_report_notify_primary (report emails — the realtor who said "the
  // buyer and myself" needs the WDO report too). A channel where a reachable
  // slot already existed keeps its existing admin-configured choice.
  const prefsToSet = {};
  // Unconditional per-channel flip on the FIRST reachable slot contact:
  // prefs rows default both notify-primary columns to FALSE (call-created
  // customers insert one moments before this), so "preserve an existing
  // false" would leave prefsToSet empty for virtually every first secondary
  // contact and silently cut the caller out of the updates they asked for
  // (codex P1). Tradeoff accepted: an admin's deliberate opt-out set while
  // the customer had zero slot contacts can be re-enabled by a later call —
  // rare, visible on the prefs UI, and strictly better than the inverse.
  if (contact.phone && !hadSlotPhone) prefsToSet.appointment_notify_primary = true;
  if (slotEmail && !hadSlotEmail) prefsToSet.service_report_notify_primary = true;
  if (Object.keys(prefsToSet).length) {
    await db('notification_prefs')
      .insert({ customer_id: customerId, ...prefsToSet })
      .onConflict('customer_id')
      .merge(prefsToSet);
  }
  // Conditional write: the slot was chosen from a prior read, so re-assert its
  // emptiness in the UPDATE's WHERE — a concurrent admin edit or reprocessed
  // call filling it between read and write must make this a 0-row no-op, never
  // an overwrite.
  let write = db('customers').where({ id: customerId });
  for (const col of [emptySlot.name, emptySlot.phone, emptySlot.email]) {
    write = write.where((q) => q.whereNull(col).orWhere(col, ''));
  }
  const updated = await write.update({
    [emptySlot.name]: fullName ? capitalizeName(fullName) : null,
    [emptySlot.phone]: contact.phone || null,
    [emptySlot.email]: slotEmail,
  });
  if (!updated) return 'skipped_slot_race';
  return 'written';
}

// A lead is "qualified" only once we've actually captured the contact info the
// office needs to work it: first + last name, a service street address, and an
// email. Phone is implicit (caller ID). Evaluate against the MERGED record
// (this call's extraction OR what a prior call already stored), so a follow-up
// call that restates nothing doesn't un-qualify an already-complete lead.
const QUALIFYING_CONTACT_FIELDS = ['first_name', 'last_name', 'service_address', 'email'];
const QUALIFYING_CONTACT_LABELS = {
  first_name: 'first name',
  last_name: 'last name',
  service_address: 'service address',
  email: 'email',
};
function leadContactCompleteness(fields = {}) {
  const present = (v) => !!String(v == null ? '' : v).trim();
  const missing = QUALIFYING_CONTACT_FIELDS.filter((key) => !present(fields[key]));
  return { complete: missing.length === 0, missing };
}

// A real new-sales prospect we can still work even though the customer upsert
// was skipped — almost always because the caller never stated a name (the
// customer create is gated on first_name). We still have a lead worth chasing
// when there's a callback number, a concrete service interest, and at least one
// way to reach or locate them (email or service address). Such leads are created
// customer-less and UNqualified so they land in Needs Review for the office to
// complete — they are never auto-converted to a customer and, because Step 6 and
// the newsletter subscribe stay gated on `customerId`, never trigger outbound.
// Spam is early-returned before this runs; the caller still guards is_spam +
// the non-lead content veto (isNonLeadCallContent) at the gate.
// For a VOICEMAIL the email/address reachback requirement is waived: a prospect
// who left a message asking about service gave us a callback number by
// definition, and that number IS the reachback (we text the quote link / call
// back). Requiring email/address would drop exactly the "call me back about
// pest control" messages the voicemail lead path exists to capture.
function hasWorkableLeadSignal({ extracted = {}, phone = null, voicemail = false } = {}) {
  if (!phone) return false;
  const text = (v) => String(v == null ? '' : v).trim();
  const hasServiceIntent = !!(text(extracted.matched_service) || text(extracted.requested_service));
  const hasReachback = !!(text(extracted.email) || text(extracted.address_line1));
  return hasServiceIntent && (hasReachback || voicemail === true);
}

async function findCustomerForCallContact(phone, extracted = {}, opts = {}) {
  const contactKey = phoneKey(phone);
  if (!contactKey) return null;

  const base = () => {
    const query = db('customers').whereNull('deleted_at');
    if (contactKey.length === 10) {
      return query.whereRaw("RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [contactKey]);
    }
    return query.whereRaw("regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = ?", [contactKey]);
  };

  if (opts.preferredCustomerId) {
    const preferred = await db('customers')
      .where({ id: opts.preferredCustomerId })
      .whereNull('deleted_at')
      .first();
    if (preferred && customerPhoneMatches(phone, preferred)) return preferred;
  }

  const firstName = normalizeNamePart(extracted.first_name);
  if (firstName) {
    let namedQuery = base()
      .whereRaw("LOWER(regexp_replace(COALESCE(first_name, ''), '[^a-zA-Z0-9]', '', 'g')) = ?", [firstName]);

    const lastName = normalizeNamePart(extracted.last_name);
    if (lastName) {
      namedQuery = namedQuery.orderByRaw(
        "CASE WHEN LOWER(regexp_replace(COALESCE(last_name, ''), '[^a-zA-Z0-9]', '', 'g')) = ? THEN 0 ELSE 1 END",
        [lastName]
      );
    }

    const [named] = await namedQuery.orderBy('updated_at', 'desc').limit(1);
    if (named && extractedNameMatchesCustomer(extracted, named)) return named;
    // No name match — but the AI-extracted name is frequently wrong (it can pick
    // up the technician's name from the call audio, e.g. "Adam"). Returning null
    // here makes the caller spawn a NEW customer even when the phone already maps
    // to one, creating a duplicate. Fall through to the phone-only single-match
    // below instead — this is the behavior the caller already documents
    // ("phone-only matching is allowed only when the number maps to a single
    // active customer") and keeps the genuine shared-phone case (2+ matches) safe.
  }

  const matches = await base().orderBy('updated_at', 'desc').limit(2);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    // Exact count, not the limit(2)-capped fetch — a number forked five ways
    // used to log as "2", hiding the badly-shared phones from ops review.
    const shareCount = await Promise.resolve()
      .then(() => base().count('* as n').first())
      .then((r) => parseInt(r?.n || 0, 10) || matches.length)
      .catch(() => matches.length);
    logger.warn(`[call-proc] ${shareCount} customers share call contact phone ${maskPhone(phone)}; not auto-linking without name match`);
  }
  return null;
}

async function registerScheduleSideEffects({ scheduledServiceId, customerId, scheduledDate, windowStart, serviceType }) {
  try {
    const AppointmentReminders = require('./appointment-reminders');
    await AppointmentReminders.registerAppointment(
      scheduledServiceId,
      customerId,
      `${scheduledDate}T${windowStart || '08:00'}`,
      serviceType,
      'call_recording',
      { sendConfirmation: false }
    );
  } catch (err) {
    logger.error(`[call-proc] Appointment reminder registration failed: ${err.message}`);
  }

  // Dispatch-v2 reads scheduled_services directly; no legacy dispatch sync.
}

// Resolve which existing lead (if any) this call should reuse, by caller phone.
// Soft-deleted leads never absorb a new call — a fresh lead is made.
// - Customer-less recovery path (workableUnnamedLead): only an ACTIVE lead
//   (status not terminal, not converted), so a recovered inquiry lands on an
//   open row or a fresh one — never silently attached to a won/lost/
//   disqualified/duplicate lead where it would not surface.
// - Customer-attached path: only a lead that is UNCLAIMED (customer_id NULL)
//   or already owned by this customer. A phone-matched lead can BELONG to
//   another customer (shared/household numbers): reusing it would write this
//   caller's extraction + ai_triage activity onto the other customer's lead,
//   and the booking-conversion ownership guard would then (rightly) refuse to
//   close it — stranding this caller's booked deal with no convertible lead.
//   A foreign-owned lead is invisible here; the caller gets a fresh row.
async function findReusableCallLead(database, { phone, customerId, workableUnnamedLead }) {
  if (!phone) return null;
  let query = database('leads').where('phone', phone).whereNull('deleted_at');
  if (workableUnnamedLead) {
    query = query.whereNotIn('status', TERMINAL_LEAD_STATUSES).whereNull('converted_at');
  }
  if (customerId) {
    query = query.where((q) => q.whereNull('customer_id').orWhere('customer_id', customerId));
  }
  return query.orderBy('created_at', 'desc').first();
}

// Convert the call's lead to won when the pipeline books an appointment,
// on the SAME transaction as the scheduled_services insert (mirrors the
// admin-leads schedule-appointment route: conversion cannot commit without
// the appointment row). Skips only `won` (idempotent reprocessing) and
// `duplicate` (the deal belongs to another lead row) — a lost/unresponsive
// lead that books DID close, so won is the correct terminal state for it.
// Runs in a NESTED transaction (savepoint): a plain try/catch inside the
// booking txn would leave it aborted after a SQL error and doom the COMMIT,
// rolling back the booking. The savepoint contains a conversion failure to
// the conversion alone; the booking still commits.
async function convertCallLeadOnPhoneBooking(trx, { leadId, customerId, scheduledServiceId, callSid, keepOpenForQuote = false }) {
  if (!leadId) return false;
  try {
    return await trx.transaction(async (inner) => {
      // Quote still owed (the agent promised to send an estimate after the
      // call): the booked appointment does NOT close the deal. Claim the lead
      // for the customer so it can't be reused elsewhere, log the booking on
      // its timeline, but leave the status OPEN so it stays in the leads
      // pipeline until the quote is actually sent/worked. The customer is
      // deliberately NOT promoted to 'won' either — their pipeline_stage keeps
      // mirroring the open lead.
      if (keepOpenForQuote) {
        const ownedOrUnclaimedOpen = (q) =>
          q.whereNull('customer_id').orWhere('customer_id', customerId);
        // The reused lead can carry a CLOSED status (lost / unresponsive /
        // disqualified — findReusableCallLead's customer-attached path doesn't
        // filter them). "Stays open for the quote" must mean VISIBLY open:
        // reopen those to 'new' in the same claim write, or the promised
        // quote hides in a closed lead the pipeline view never shows.
        const currentLead = await inner('leads')
          .where({ id: leadId })
          .whereNotIn('status', ['won', 'duplicate'])
          .where(ownedOrUnclaimedOpen)
          .first('id', 'status');
        if (!currentLead) return false;
        const OPEN_LEAD_STATUSES = new Set(['new', 'contacted', 'estimate_sent', 'estimate_viewed']);
        const claimUpdates = { customer_id: customerId, updated_at: new Date() };
        if (!OPEN_LEAD_STATUSES.has(String(currentLead.status || '').toLowerCase())) {
          claimUpdates.status = 'new';
        }
        const claimed = await inner('leads')
          .where({ id: leadId })
          .whereNotIn('status', ['won', 'duplicate'])
          .where(ownedOrUnclaimedOpen)
          .update(claimUpdates);
        if (claimed) {
          await inner('lead_activities').insert({
            lead_id: leadId,
            activity_type: 'appointment_booked',
            description: 'Appointment booked by phone — lead kept OPEN: agent promised to send a quote after the call',
            performed_by: 'system',
            metadata: JSON.stringify({
              customerId,
              triggerSource: 'appointment_booked_quote_pending',
              scheduledServiceId,
              callSid,
            }),
          });
        }
        logger.info(`[call-proc] Lead ${leadId} kept open (quote promised) despite phone booking for ${callSid}`);
        return false;
      }
      // Ownership guard: leadId can come from the phone-only existing-lead
      // lookup, and a caller phone can be shared across leads. Only a lead
      // that is unclaimed (customer_id NULL) or already belongs to the
      // booked customer may be closed here — never reassign another
      // customer's lead. Repeated in the UPDATE predicate so a concurrent
      // claim between the read and the write can't slip through.
      const ownedOrUnclaimed = (q) =>
        q.whereNull('customer_id').orWhere('customer_id', customerId);
      const convertible = await inner('leads')
        .where({ id: leadId })
        .whereNotIn('status', ['won', 'duplicate'])
        .where(ownedOrUnclaimed)
        .first('id');
      if (!convertible) return false;
      const updated = await inner('leads')
        .where({ id: leadId })
        .whereNotIn('status', ['won', 'duplicate'])
        .where(ownedOrUnclaimed)
        .update({
          status: 'won',
          customer_id: customerId,
          converted_at: new Date(),
          is_qualified: true,
          updated_at: new Date(),
        });
      if (!updated) return false;
      await inner('lead_activities').insert({
        lead_id: leadId,
        activity_type: 'converted',
        description: `Converted to customer (${customerId}) — appointment booked by phone`,
        performed_by: 'system',
        metadata: JSON.stringify({
          customerId,
          triggerSource: 'appointment_booked',
          scheduledServiceId,
          callSid,
        }),
      });
      // Promote the customer row alongside the lead (the shared
      // booking-promotion helper, same as the admin paths): a phone-booked
      // account left at new_lead falls outside the canonical live-customer
      // stages and is under-counted by every dashboard.
      await promoteCustomerOnBooking(inner, customerId);
      // Re-own the lead's estimates to the customer, like the canonical
      // booking path (admin-leads → linkLeadEstimatesToCustomer): a won
      // lead's quote left at customer_id NULL stays invisible to
      // customer-keyed estimate flows and EstimateConverter refuses it.
      // Deliberately INSIDE the savepoint: the helper swallows SQL errors,
      // which leave the transaction it ran on aborted — contained here that
      // dooms only this savepoint (conversion retries on reprocessing via
      // the reuse paths), never the booking commit.
      const convertedLead = await inner('leads')
        .where({ id: leadId })
        .first('id', 'estimate_id');
      if (convertedLead) {
        const { linkLeadEstimatesToCustomer } = require('./lead-estimate-link');
        await linkLeadEstimatesToCustomer({ database: inner, lead: convertedLead, customerId });
      }
      // Funnel-row mirror for the direct 'won' write above (won → 'booked').
      // Same containment rationale as linkLeadEstimatesToCustomer: the bridge
      // swallows SQL errors, so it runs INSIDE the savepoint where an aborted
      // subtransaction dooms only the conversion, never the booking commit.
      const { bridgeLeadFunnelStage } = require('./lead-funnel-bridge');
      await bridgeLeadFunnelStage(leadId, 'won', inner);
      logger.info(`[call-proc] Lead ${leadId} converted to won (appointment_booked) for ${callSid}`);
      return true;
    });
  } catch (err) {
    logger.error(`[call-proc] Lead conversion on phone booking failed for ${callSid}: ${err.message}`);
    return false;
  }
}

async function subscribeNewCallCustomerToNewsletter({ customerId, email, firstName, lastName }) {
  const emailLc = String(email || '').trim().toLowerCase();
  if (!customerId || !emailLc) return null;

  if (!EMAIL_RE.test(emailLc)) {
    logger.warn(`[call-proc] Newsletter subscribe skipped for customer ${customerId}: invalid email from extraction`);
    return { skipped: true, reason: 'invalid_email' };
  }

  const existing = await db('newsletter_subscribers').where({ email: emailLc }).first();
  if (existing?.status === 'unsubscribed') {
    if (!existing.customer_id) {
      await db('newsletter_subscribers')
        .where({ id: existing.id })
        .update({ customer_id: customerId, updated_at: new Date() });
    } else if (existing.customer_id !== customerId) {
      logger.info(`[call-proc] Newsletter subscriber link unchanged for customer ${customerId}: previously linked elsewhere`);
    }
    logger.info(`[call-proc] Newsletter subscribe skipped for customer ${customerId}: previously unsubscribed`);
    return { skipped: true, reason: 'previously_unsubscribed' };
  }

  const result = await subscribeOrResubscribe({
    email: emailLc,
    firstName: firstName || null,
    lastName: lastName || null,
    source: 'call_recording',
    strict: true,
    requireConfirmation: true,
  });

  let confirmationEmailSent = null;
  if (result.action === 'confirmation_sent' || result.action === 'confirmation_resent') {
    try {
      await sendConfirmationEmail(result.subscriber);
      confirmationEmailSent = true;
    } catch (e) {
      logger.warn(`[call-proc] Newsletter confirmation email failed for customer ${customerId}`);
      confirmationEmailSent = false;
    }
  }

  logger.info(`[call-proc] Newsletter subscriber ${result.action} for customer ${customerId}`);
  return {
    action: result.action,
    subscriberId: result.subscriber?.id || null,
    confirmationEmailSent,
  };
}

// V2 emits confirmed_start_at / follow_up_start_at as ISO 8601 with an ET
// offset. The legacy parser wants a bare ET wall clock ("YYYY-MM-DDTHH:MM"),
// and the old `.slice(0, 16)` trusted the wall clock blindly — a model that
// emitted UTC ("...T14:00:00Z" for a 10 AM ET booking) or a wrong-season
// offset booked 4-5 hours off. When the string carries ANY zone suffix,
// trust the encoded INSTANT and render its ET wall clock (identity for a
// correct ET offset). Zone-less strings pass through as wall clock.
function v2IsoToEtWallClock(value) {
  const raw = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)) return null;
  // An ET offset (either season) means the model encoded the agreed LOCAL
  // wall clock — that wall clock is what was agreed on the call, so keep it
  // verbatim even when the seasonal offset is wrong (codex P1: converting a
  // July "-05:00" as an instant shifted a real 10 AM booking to 11 AM).
  if (/(?:-04:?00|-05:?00)$/.test(raw)) return raw.slice(0, 16);
  // UTC "Z" or any non-ET offset: the wall clock is NOT ET — trust the
  // encoded instant and render its ET wall clock.
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      const p = etParts(parsed);
      const pad = (n) => String(n).padStart(2, '0');
      return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
    }
  }
  return raw.slice(0, 16);
}

async function findExistingCallAppointment({ customerId, call, scheduledDate, windowStart, serviceType, trx = db }) {
  if (!customerId) return null;

  const marker = `Call SID: ${call.twilio_call_sid}`;
  // Both lookups answer "was the PRIMARY appointment for this call already
  // created?" — a linked follow-up child (visit 2) carries the same Call SID
  // marker and booking_source, so child rows must be excluded or a reprocess
  // whose primary was cancelled/rescheduled would adopt the pending follow-up
  // as the confirmed booking and never recreate the actual visit.
  const marked = await trx('scheduled_services')
    .where({ customer_id: customerId })
    .whereNull('parent_service_id')
    .whereNotIn('status', ['cancelled', 'rescheduled'])
    .where('notes', 'like', `%${marker}%`)
    .orderBy('created_at', 'asc')
    .first();
  if (marked) return marked;

  if (!scheduledDate || !windowStart || !serviceType) return null;

  const callCreatedAt = call.created_at ? new Date(call.created_at) : null;
  const query = trx('scheduled_services')
    .where({ customer_id: customerId, booking_source: 'phone_call' })
    .whereNull('parent_service_id')
    .where('scheduled_date', scheduledDate)
    .whereRaw('window_start::time = ?::time', [windowStart])
    .whereRaw('LOWER(TRIM(service_type)) = LOWER(TRIM(?))', [serviceType])
    .whereNotIn('status', ['cancelled', 'rescheduled'])
    .orderBy('created_at', 'asc');

  if (callCreatedAt && !isNaN(callCreatedAt.getTime())) {
    query.where('created_at', '>=', new Date(callCreatedAt.getTime() - 5 * 60 * 1000));
  }

  return query.first();
}

const UNSUPPORTED_CALL_RE = /\b(seo|organic traffic|google ranking|search engine optimization|lead generation|contractor leads?)\b/i;
const UNSUPPORTED_CONSTRUCTION_BUSINESS_RE = /\bconstruction (?:company|business)\b/i;
const UNSUPPORTED_CONSTRUCTION_ADVICE_RE = /\b(?:advice|consult(?:ing)?|guidance|strategy)\b/i;
const UNSUPPORTED_MARKETING_CONTEXT_RE = /\b(?:marketing|advertising|social media)\s+(?:advice|consult(?:ing)?|strategy|campaign|management|services?)\b|\b(?:advice|consult(?:ing)?|strategy|campaign|management|services?)\s+(?:for|about|on|around)?\s*(?:marketing|advertising|social media)\b|\bads?\s+(?:campaign|consult(?:ing)?|management|strategy)\b|\b(?:campaign|consult(?:ing)?|management|strategy)\s+(?:for|about|on|around)?\s*ads?\b/i;
const UNSUPPORTED_WEBSITE_CONTEXT_RE = /\b(?:website|web site|webpage|web page)\b.{0,80}\b(?:seo|ranking|traffic|design|development|redesign|optimi[sz]ation|build|builder|audit)\b|\b(?:seo|ranking|traffic|design|development|redesign|optimi[sz]ation|build|builder|audit)\b.{0,80}\b(?:website|web site|webpage|web page)\b/i;
const ADMIN_FOLLOWUP_CONTEXT_RE = /\b(?:compliance report|service report|sticker|invoice|billing|receipt|payment|pay online|paid online|w-?9|certificate|paperwork)\b/i;
const ADMIN_COMPLETED_WORK_RE = /\b(?:follow(?:ed)? up|completed service|completed inspection|already completed|inspection report|compliance report|service report|sticker|certificate|w-?9|paperwork)\b/i;
const ADMIN_DOC_REQUEST_RE = /\b(?:needs?|wants?|looking for|asked for|request(?:ed|ing)?|send|sent|email(?:ed)?|text)\b.{0,35}\b(?:(?:wdo|termite|inspection|service|compliance)\s+)?(?:report|paperwork|sticker|certificate|invoice|receipt|payment link)\b|\b(?:wdo|termite|inspection|service|compliance)\s+report\b/i;
const ADMIN_PAYMENT_REQUEST_RE = /\b(?:make|making|take|taking|process|processing|submit|submitted)\s+(?:a\s+)?payment\b|\bneeds?\s+(?:to\s+)?(?:make\s+)?(?:a\s+)?payment\b|\bwants?\s+to\s+(?:make\s+)?(?:a\s+)?payment\b|\b(?:pay|paid|paying)\b.{0,35}\b(?:invoice|bill|balance|service|inspection|report)\b|\bpayment\b.{0,35}\b(?:for|on)\b.{0,35}\b(?:service|inspection|treatment|report|rodent|pest|termite|wdo)\b/i;
const ADMIN_NON_BILLING_DOC_RE = /\b(?:report|paperwork|sticker|certificate|w-?9|compliance)\b/i;
const NEW_FIELD_VISIT_INTENT_RE = /\b(?:(?:schedule|scheduled|scheduling|calendar|book|booking|booked|set up)\b.{0,45}\b(?:appointment|visit|service call|inspection|treatment|tech|technician|come out|pest control|roach(?:es)?|rodent|rat|mice|mosquito|lawn|termite inspection|wdo inspection|bed\s*bug|tree|shrub)|(?:appointment|visit|service call|field service|tech|technician)\b.{0,45}\b(?:confirmed|scheduled|booked|set|for|on|at)|next available\b.{0,45}\b(?:appointment|visit|service|inspection|treatment|tech|technician)|come out|send (?:someone|a tech|a technician) out|send out (?:someone|a tech|a technician)|get (?:it|me|us) (?:going|on (?:the )?schedule)|pop (?:it|me|us) on (?:the )?(?:schedule|calendar)|put (?:it|me|us) on (?:the )?(?:schedule|calendar))\b/i;
const CONFIRMED_FIELD_SERVICE_APPOINTMENT_RE = /\b(?:confirmed|scheduled|booked)\b.{0,100}\b(?:for|with)\b.{0,45}\b(?:service|appointment|visit|inspection|treatment|pest|bugs?|roach(?:es)?|cockroach(?:es)?|rodents?|rats?|mice|mouse|mosquito(?:es|s)?|lawn|grass|weeds?|termite(?:s)?|pre[-\s]?slab|preslab|soil treatment|soil poison|wdo|bed\s*bugs?|trees?|shrubs?)\b/i;
const CONFIRMED_TIME_LOGISTICS_RE = /\b(?:confirmed|scheduled|booked|set(?: up)?)\b.{0,100}\b(?:\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m|p\.m)|noon|midday)\b/i;
const FIELD_SERVICE_REQUEST_RE = /\b(?:needs?|wants?|looking for|asked for|request(?:ed|ing)?|schedule|scheduled|scheduling|book|booking|booked|set(?: up)?|has|having|issue(?:s)?(?: with)?|problem(?:s)?(?: with)?|treat(?:ment)?|control|remove|removal|spray)\b.{0,90}\b(?:pest|bugs?|roach(?:es)?|cockroach(?:es)?|ants?|spiders?|wasps?|hornets?|fleas?|ticks?|rodents?|rats?|mice|mouse|mosquito(?:es|s)?|lawn|grass|weeds?|termite(?:s)?|pre[-\s]?slab|preslab|soil treatment|soil poison|wdo|bed\s*bugs?|trees?|shrubs?)\b/i;
const HISTORY_REFERENCE_RE = /\b(?:same (?:thing|service|treatment)|same as (?:before|last time)|previous (?:service|treatment|estimate|quote)|last (?:service|treatment|estimate|quote)|from (?:my|the|that) (?:estimate|quote)|the (?:estimate|quote|service|treatment) we (?:talked about|discussed|sent)|as quoted|already quoted)\b/i;
const HISTORY_ESTIMATE_REFERENCE_RE = /\b(?:estimate|quote|quoted)\b/i;
const HISTORY_SERVICE_REFERENCE_RE = /\b(?:same (?:thing|service|treatment)|same as (?:before|last time)|previous (?:service|treatment)|last (?:service|treatment)|service we (?:talked about|discussed)|treatment we (?:talked about|discussed))\b/i;
const HISTORY_DISMISSAL_RE = /\b(?:did not|didn't|do not|don't|dont|does not|doesn't|doesnt|not|no longer)\b.{0,60}\b(?:last|previous|estimate|quote|quoted|service|treatment)\b|\b(?:last|previous|estimate|quote|quoted|service|treatment)\b.{0,60}\b(?:did not|didn't|do not|don't|dont|does not|doesn't|doesnt|not|no longer|instead)\b/i;
const HISTORY_TIMING_NEGATION_RE = /\b(?:last|previous|estimate|quote|quoted|service|treatment)\b.{0,60}\bnot\s+(?:until|before|after|yet)\b|\bnot\s+(?:until|before|after|yet)\b.{0,60}\b(?:last|previous|estimate|quote|quoted|service|treatment)\b/i;
const PRE_SLAB_NEGATION_RE = /\b(?:without|don't need|doesn't need|dont need|doesnt need|no)\s+(?:pre[-\s]?slab|preslab|soil poison|soil treatment|termiticide|termidor)\b|\b(?:not|isn't|is not|wasn't|was not)\b(?:(?!\b(?:need|needs|needed|want|wants|wanted|request|requested|schedule|scheduled|book|booked)\b)[^.;,]){0,40}\b(?:pre[-\s]?slab|preslab|soil poison|soil treatment|termiticide|termidor)\b|\b(?:pre[-\s]?slab|preslab|soil poison|soil treatment|termiticide|termidor)\b[^.;,]{0,40}\b(?:not|isn't|is not|wasn't|was not|no)\b/i;
const PRE_SLAB_TIMING_NEGATION_RE = /\b(?:pre[-\s]?slab|preslab|soil poison|soil treatment|termiticide|termidor|slab|concrete)\b.{0,60}\bnot\s+(?:until|before|after|yet)\b|\bnot\s+(?:until|before|after|yet)\b.{0,60}\b(?:pre[-\s]?slab|preslab|soil poison|soil treatment|termiticide|termidor|slab|concrete)\b/i;
const PRE_SLAB_NOT_YET_RE = /\b(?:not|without)\b.{0,40}\b(?:pre[-\s]?slab|preslab|soil poison|soil treatment|termiticide|termidor)\b.{0,25}\byet\b/i;
const GENERIC_TERMITE_NEGATION_RE = /\b(?:no|without)\s+(?:active\s+)?termites?\b|\b(?:not|isn't|is not|wasn't|was not)\b[^.;,]{0,30}\btermites?\b|\btermites?\b[^.;,]{0,25}\b(?:isn't|is not|wasn't|was not|not (?:active|present|found|seen|an? issue|a problem)|no (?:activity|signs?|evidence|issue|problem|concern))\b/i;
const POSITIVE_TERMITE_REQUEST_RE = /\btermite\s+(?:inspection|treatment|service)\b|\b(?:inspect(?:ion)?|treat(?:ment)?)\s+(?:for\s+)?termites?\b|\b(?:needs?|wants?|looking for|asked for|request(?:ed|ing)?|schedule|scheduled|book|booking|booked)\b.{0,50}\btermites?\b/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERIC_CALL_APPOINTMENT_SERVICE = 'Waves Appointment';

function compactText(...parts) {
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function hasPreSlabTermiteContext(text) {
  const value = String(text || '').toLowerCase();
  if (
    PRE_SLAB_NEGATION_RE.test(value)
    && !PRE_SLAB_NOT_YET_RE.test(value)
    && !PRE_SLAB_TIMING_NEGATION_RE.test(value)
  ) return false;
  const explicitPreSlab = /\b(pre[-\s]?slab|preslab)\b/.test(value);
  const soilOrTermiticideTreatment = /\b(?:soil poison|soil treatment|slab pre[-\s]?treat|termiticide|termidor)\b/.test(value);
  const termiteTreatment = /\btermites?\b.{0,40}\btreat(?:ment)?\b|\btreat(?:ment)?\b.{0,40}\btermites?\b/.test(value);
  const concreteTiming = /\b(?:before (?:the )?(?:slab|concrete)|slab pour|pour(?:ing)? concrete)\b/.test(value);
  const constructionCue = /\b(?:pre[-\s]?construction|new construction|slab|concrete)\b/.test(value);
  const newConstructionTermite = /\b(?:pre[-\s]?construction|new construction)\b/.test(value)
    && /\b(?:termite|termiticide|termidor|soil poison|soil treatment|pre[-\s]?slab|preslab|slab pour|before (?:the )?(?:slab|concrete))\b/.test(value);
  return explicitPreSlab || ((soilOrTermiticideTreatment || termiteTreatment) && (constructionCue || concreteTiming)) || newConstructionTermite;
}

function canonicalWavesService(value) {
  const text = String(value || '').toLowerCase();
  if (!text) return null;
  if (hasPreSlabTermiteContext(text)) return 'Pre-Slab Termidor';
  if (/\bbora[-\s]?care\b|\bborate\b|\bwood treatment\b/.test(text)) return 'Termite Wood Treatment';
  if (/\bfoam\b.{0,40}\bdrill\b|\bdrill\b.{0,40}\bfoam\b|\bvoid treatment\b|\bspot termite\b/.test(text)) return 'Termite Foam Drill';
  if (/\btrench(?:ing)?\b|\brod(?:ding)?\b|\bliquid(?:\s+termite)?\s+perimeter\b|\btermidor\b/.test(text)) return 'Liquid Termite Perimeter';
  if (/\bwdo\b|wood destroying organism/.test(text)) return 'WDO Inspection';
  if (/\bbed\s*bugs?\b|\bbedbugs?\b/.test(text)) return 'Bed Bug Treatment';
  if (/\brodents?\b|\brats?\b|\bmouse\b|\bmice\b|\bbait stations?\b/.test(text)) return 'Rodent Control';
  if (/\bmosquito(?:es|s)?\b/.test(text)) return 'Mosquito Control';
  if (/\btermites?\b/.test(text) && (!GENERIC_TERMITE_NEGATION_RE.test(text) || POSITIVE_TERMITE_REQUEST_RE.test(text))) return 'Termite Inspection';
  if (/\btrees?\b|\bshrubs?\b|\bornamentals?\b|\bpalms?\b/.test(text)) return 'Tree & Shrub Care';
  if (/\blawns?\b|\bturf\b|\bgrass\b|\bfertili[sz](e|er|ation|ing)?\b|\bweeds?\b|\bchinch\b|\bsod\b|\bfungus\b|\bfungal\b/.test(text)) return 'Lawn Care';
  if (/\bpest(s| control)?\b|\bbugs?\b|\binsects?\b|\broach(?:es)?\b|\bcockroach(?:es)?\b|\bants?\b|\bspiders?\b|\bwasps?\b|\bhornets?\b|\bfleas?\b|\bticks?\b|\bsilverfish\b|\bearwigs?\b|\bmillipedes?\b|\bcentipedes?\b|\bpalmetto bugs?\b/.test(text)) return 'General Pest Control';
  return null;
}

function hasUnsupportedCallContext(value) {
  const text = String(value || '');
  const constructionBusiness = UNSUPPORTED_CONSTRUCTION_BUSINESS_RE.test(text);
  const constructionFieldService = hasFieldServiceRequestText({}, text) || NEW_FIELD_VISIT_INTENT_RE.test(text);
  const unsupportedConstructionBusiness = constructionBusiness
    && (UNSUPPORTED_CONSTRUCTION_ADVICE_RE.test(text) || !constructionFieldService);
  return UNSUPPORTED_CALL_RE.test(text)
    || unsupportedConstructionBusiness
    || UNSUPPORTED_MARKETING_CONTEXT_RE.test(text)
    || UNSUPPORTED_WEBSITE_CONTEXT_RE.test(text);
}

function hasFieldServiceRequestIntent(extracted = {}, value = '') {
  const text = String(value || '');
  const requestedText = compactText(extracted.requested_service);
  const requestedService = canonicalWavesService(requestedText);
  const matchedService = canonicalWavesService(extracted.matched_service);
  if (hasConfirmedFieldServiceAppointment(extracted, text)) return true;
  if (hasFieldServiceRequestText(extracted, text)) return true;
  if (
    extracted.appointment_confirmed
    && extracted.preferred_date_time
    && matchedService
    && CONFIRMED_TIME_LOGISTICS_RE.test(text)
    && !ADMIN_NON_BILLING_DOC_RE.test(text)
    && !ADMIN_COMPLETED_WORK_RE.test(text)
  ) return true;
  if (
    extracted.appointment_confirmed
    && extracted.preferred_date_time
    && requestedText
    && requestedService
    && !ADMIN_PAYMENT_REQUEST_RE.test(text)
    && !ADMIN_COMPLETED_WORK_RE.test(text)
    && !ADMIN_DOC_REQUEST_RE.test(requestedText)
    && !ADMIN_PAYMENT_REQUEST_RE.test(requestedText)
  ) return true;
  if (requestedText && requestedService && !ADMIN_FOLLOWUP_CONTEXT_RE.test(requestedText) && !ADMIN_DOC_REQUEST_RE.test(text) && !ADMIN_PAYMENT_REQUEST_RE.test(text)) return true;

  return false;
}

function hasConfirmedFieldServiceAppointment(extracted = {}, value = '') {
  const text = String(value || '');
  if (!extracted.appointment_confirmed || !extracted.preferred_date_time) return false;
  if (!canonicalWavesService(compactText(extracted.matched_service, extracted.requested_service))) return false;
  if (!CONFIRMED_FIELD_SERVICE_APPOINTMENT_RE.test(text)) return false;
  if (!ADMIN_NON_BILLING_DOC_RE.test(text)) return true;

  let stripped = text;
  for (let i = 0; i < 3; i += 1) {
    stripped = stripped.replace(ADMIN_DOC_REQUEST_RE, ' ');
  }
  return CONFIRMED_FIELD_SERVICE_APPOINTMENT_RE.test(stripped);
}

function hasFieldServiceRequestText(extracted = {}, value = '') {
  const text = String(value || '');
  const service = canonicalWavesService(compactText(extracted.requested_service, extracted.matched_service, text));
  if (!service || !FIELD_SERVICE_REQUEST_RE.test(text)) return false;
  if (!ADMIN_DOC_REQUEST_RE.test(text) && !ADMIN_PAYMENT_REQUEST_RE.test(text)) return true;
  let stripped = text;
  for (let i = 0; i < 3; i += 1) {
    stripped = stripped
      .replace(ADMIN_DOC_REQUEST_RE, ' ')
      .replace(ADMIN_PAYMENT_REQUEST_RE, ' ');
  }
  return FIELD_SERVICE_REQUEST_RE.test(stripped);
}

function hasFieldVisitIntent(extracted = {}, value = '') {
  if (hasFieldServiceRequestIntent(extracted, value)) return true;
  return NEW_FIELD_VISIT_INTENT_RE.test(String(value || ''));
}

function hasConfirmedGenericAppointment(extracted = {}, value = '') {
  if (!extracted.appointment_confirmed || !extracted.preferred_date_time) return false;
  const text = String(value || '');
  if (!text.trim()) return false;
  if (ADMIN_DOC_REQUEST_RE.test(text) || ADMIN_PAYMENT_REQUEST_RE.test(text)) return false;
  if (ADMIN_FOLLOWUP_CONTEXT_RE.test(text) && !NEW_FIELD_VISIT_INTENT_RE.test(text)) return false;
  return NEW_FIELD_VISIT_INTENT_RE.test(text)
    || CONFIRMED_TIME_LOGISTICS_RE.test(text)
    || /\b(?:appointment|visit|service call|schedule|scheduled|scheduling|booked|booking|set up|come out|tech|technician)\b/i.test(text)
    || /\bput\s+(?:me|us|him|her|them|it)\s+down\b/i.test(text);
}

function hasAdministrativeOnlyContext(value, extracted = {}) {
  const text = String(value || '');
  const fieldServiceRequest = hasFieldServiceRequestIntent(extracted, text);
  const adminRequest = ADMIN_DOC_REQUEST_RE.test(text) || ADMIN_PAYMENT_REQUEST_RE.test(text);
  const newVisitInCompletedWorkCall = hasFieldServiceRequestText(extracted, text) || NEW_FIELD_VISIT_INTENT_RE.test(text);
  if (adminRequest && !fieldServiceRequest) {
    return true;
  }
  if (ADMIN_FOLLOWUP_CONTEXT_RE.test(text) && ADMIN_COMPLETED_WORK_RE.test(text) && !fieldServiceRequest && !newVisitInCompletedWorkCall) {
    return true;
  }
  return ADMIN_FOLLOWUP_CONTEXT_RE.test(text) && !fieldServiceRequest && !NEW_FIELD_VISIT_INTENT_RE.test(text);
}

function extractHistoryServiceText(value, depth = 0) {
  if (depth > 4 || value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => extractHistoryServiceText(item, depth + 1)).join(' ');
  if (typeof value !== 'object') return '';

  return Object.entries(value)
    .filter(([key]) => /service|treatment|program|name|label|description|interest|type|requested|matched/i.test(key))
    .map(([, item]) => extractHistoryServiceText(item, depth + 1))
    .join(' ');
}

function summarizeCustomerServiceContext(customerServiceContext = {}) {
  const rows = [
    ...(customerServiceContext.estimates || []),
    ...(customerServiceContext.serviceRecords || []),
    ...(customerServiceContext.scheduledServices || []),
  ];
  return rows.map((row) => compactText(
    row.service_interest,
    row.service_type,
    row.notes,
    row.technician_notes,
    row.internal_notes,
    extractHistoryServiceText(row.estimate_data),
    extractHistoryServiceText(row.service_data),
    extractHistoryServiceText(row.structured_notes)
  )).join(' ');
}

function customerHistoryRowText(row = {}) {
  return compactText(
    row.service_interest,
    row.service_type,
    row.notes,
    row.technician_notes,
    row.internal_notes,
    extractHistoryServiceText(row.estimate_data),
    extractHistoryServiceText(row.service_data),
    extractHistoryServiceText(row.structured_notes)
  );
}

function customerHistoryRowTime(row = {}) {
  const raw = row.service_date || row.scheduled_date || row.created_at || 0;
  const time = new Date(raw).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function serviceFromHistoryRows(rows = []) {
  return [...rows]
    .sort((a, b) => customerHistoryRowTime(b) - customerHistoryRowTime(a))
    .map((row) => (
      canonicalWavesService(compactText(row.service_interest, row.service_type))
      || canonicalWavesService(customerHistoryRowText(row))
    ))
    .find(Boolean) || null;
}

function completedServiceRows(rows = []) {
  return rows.filter((row) => !row.status || row.status === 'completed');
}

function customerVisibleEstimateRows(rows = []) {
  return rows.filter((row) => !row.status || row.status !== 'draft');
}

function hasHistoryDismissal(text) {
  return HISTORY_DISMISSAL_RE.test(text) && !HISTORY_TIMING_NEGATION_RE.test(text);
}

function isTermiteService(service) {
  return [
    'Termite Inspection',
    'Pre-Slab Termidor',
    'Liquid Termite Perimeter',
    'Termite Wood Treatment',
    'Termite Foam Drill',
  ].includes(service);
}

function resolveCustomerHistoryService(customerServiceContext = {}, referenceText = '') {
  const text = String(referenceText || '');
  if (!HISTORY_REFERENCE_RE.test(text)) return null;

  const estimates = customerVisibleEstimateRows(customerServiceContext.estimates || []);
  const serviceRows = completedServiceRows(customerServiceContext.serviceRecords || []);
  const completedScheduledRows = completedServiceRows(customerServiceContext.scheduledServices || []);
  const mentionsEstimate = HISTORY_ESTIMATE_REFERENCE_RE.test(text);
  const mentionsService = HISTORY_SERVICE_REFERENCE_RE.test(text);

  if (mentionsEstimate) {
    const estimateService = serviceFromHistoryRows(estimates);
    if (estimateService || !mentionsService) return estimateService;
  }
  if (mentionsService && !mentionsEstimate) return serviceFromHistoryRows([
    ...serviceRows,
    ...completedScheduledRows,
  ]);

  return serviceFromHistoryRows([
    ...estimates,
    ...serviceRows,
    ...completedScheduledRows,
  ]);
}

async function loadCustomerServiceContext(customerId, conn = db) {
  if (!customerId) return null;

  const [estimates, serviceRecords, scheduledServices] = await Promise.all([
    conn('estimates')
      .where({ customer_id: customerId })
      .whereIn('status', ['sent', 'viewed', 'accepted', 'declined', 'expired'])
      .select('service_interest', 'notes', 'estimate_data', 'status', 'created_at')
      .orderBy('created_at', 'desc')
      .limit(8)
      .catch((err) => {
        logger.warn(`[call-proc] Estimate history lookup failed for customer ${customerId}: ${err.message}`);
        return [];
      }),
    conn('service_records')
      .where({ customer_id: customerId })
      .where({ status: 'completed' })
      .select('service_type', 'technician_notes', 'service_data', 'structured_notes', 'status', 'service_date', 'created_at')
      .orderBy('service_date', 'desc')
      .orderBy('created_at', 'desc')
      .limit(8)
      .catch((err) => {
        logger.warn(`[call-proc] Service history lookup failed for customer ${customerId}: ${err.message}`);
        return [];
      }),
    conn('scheduled_services')
      .where({ customer_id: customerId })
      .where({ status: 'completed' })
      .select('service_type', 'notes', 'internal_notes', 'status', 'scheduled_date', 'created_at')
      .orderBy('scheduled_date', 'desc')
      .orderBy('created_at', 'desc')
      .limit(8)
      .catch((err) => {
        logger.warn(`[call-proc] Scheduled-service history lookup failed for customer ${customerId}: ${err.message}`);
        return [];
      }),
  ]);

  return { estimates, serviceRecords, scheduledServices };
}

function resolveSchedulableCallService(extracted = {}, opts = {}) {
  const requestedText = compactText(extracted.requested_service);
  const extractedDetailText = compactText(
    extracted.requested_service,
    extracted.call_summary,
    extracted.pain_points
  );
  const fullContextText = compactText(
    extractedDetailText,
    opts.transcription
  );
  const adminContextText = compactText(
    ADMIN_FOLLOWUP_CONTEXT_RE.test(String(extracted.requested_service || '')) ? extracted.requested_service : null,
    extracted.call_summary,
    extracted.pain_points,
    opts.transcription
  );
  const matchedService = canonicalWavesService(extracted.matched_service);
  const requestedService = canonicalWavesService(extracted.requested_service);
  const detailService = canonicalWavesService(extractedDetailText);
  const requestedHistoryReference = HISTORY_REFERENCE_RE.test(requestedText);
  const explicitRequestedTermiteInspection = requestedService === 'Termite Inspection'
    && /\binspect(?:ion)?\b/i.test(requestedText)
    && !requestedHistoryReference;

  if (hasUnsupportedCallContext(extractedDetailText)) {
    return { ok: false, reason: 'unsupported_service', service: null };
  }
  if (hasAdministrativeOnlyContext(adminContextText, extracted)) {
    return { ok: false, reason: 'administrative_followup', service: null };
  }

  const hasHistoryReference = HISTORY_REFERENCE_RE.test(fullContextText);
  const historyService = resolveCustomerHistoryService(
    opts.customerServiceContext || opts.customerHistory || {},
    fullContextText
  );
  const shouldUsePreSlabDetail = detailService === 'Pre-Slab Termidor'
    && !explicitRequestedTermiteInspection
    && (!matchedService || matchedService === 'Termite Inspection' || requestedService === 'Pre-Slab Termidor');
  const shouldUseHistoryService = hasHistoryReference
    && historyService
    && !hasHistoryDismissal(fullContextText)
    && !explicitRequestedTermiteInspection
    && (!detailService || (detailService === 'Termite Inspection' && isTermiteService(historyService)));

  const service = shouldUsePreSlabDetail
    ? detailService
    : (shouldUseHistoryService ? historyService : (matchedService || requestedService || detailService));
  if (!service && hasUnsupportedCallContext(fullContextText)) {
    return { ok: false, reason: 'unsupported_service', service: null };
  }
  if (!service && hasConfirmedGenericAppointment(extracted, fullContextText)) {
    return { ok: true, reason: null, service: GENERIC_CALL_APPOINTMENT_SERVICE };
  }
  // noMatch distinguishes "no coarse label fit" (rescuable by an exact
  // bookable-catalog match) from the context vetoes above (unsupported topic /
  // admin-only call), which a catalog match must never override.
  if (!service) return { ok: false, reason: 'unsupported_service', service: null, noMatch: true };
  return { ok: true, reason: null, service };
}

async function resolveDefaultCallBookingTechnician(conn = db) {
  const configuredId = String(process.env.CALL_BOOKING_DEFAULT_TECHNICIAN_ID || '').trim();
  if (configuredId) {
    if (!UUID_RE.test(configuredId)) {
      logger.warn(`[call-proc] CALL_BOOKING_DEFAULT_TECHNICIAN_ID is not a valid UUID: ${configuredId}`);
    } else {
      const configuredTech = await conn('technicians')
        .where({ id: configuredId })
        .where(function () {
          this.where({ active: true }).orWhereNull('active');
        })
        .first('id', 'name');
      if (configuredTech?.id) return { id: configuredTech.id, name: configuredTech.name || null };
      logger.warn(`[call-proc] CALL_BOOKING_DEFAULT_TECHNICIAN_ID did not match an active technician: ${configuredId}`);
    }
  }

  const tech = await conn('technicians')
    .whereRaw('LOWER(TRIM(name)) = LOWER(TRIM(?))', [DEFAULT_CALL_BOOKING_TECHNICIAN_NAME])
    .where(function () {
      this.where({ active: true }).orWhereNull('active');
    })
    .first('id', 'name');
  if (tech?.id) return { id: tech.id, name: tech.name || DEFAULT_CALL_BOOKING_TECHNICIAN_NAME };

  // Name mismatch (e.g. the row is "Adam", not "Adam B.") used to silently
  // book with no technician. When exactly one active technician exists there
  // is no ambiguity — assign them and say so.
  const activeTechs = await conn('technicians')
    .where(function () {
      this.where({ active: true }).orWhereNull('active');
    })
    .select('id', 'name');
  if (activeTechs.length === 1) {
    logger.info(`[call-proc] Default call-booking technician name "${DEFAULT_CALL_BOOKING_TECHNICIAN_NAME}" not found; using sole active technician ${activeTechs[0].name}`);
    return { id: activeTechs[0].id, name: activeTechs[0].name || null };
  }

  logger.warn(`[call-proc] Default call-booking technician not found: ${DEFAULT_CALL_BOOKING_TECHNICIAN_NAME}`);
  return null;
}

async function resolveDefaultCallBookingTechnicianId(conn = db) {
  const tech = await resolveDefaultCallBookingTechnician(conn);
  return tech?.id || null;
}

function hasUsablePhone(value) {
  return String(value || '').replace(/\D/g, '').length >= 10;
}

function validatePhoneCallAppointmentCustomer(customer = {}, extracted = {}, callerPhone = null) {
  // A service-contact slot email satisfies the email requirement: it is a
  // deliverable account email (appointment-email's resolveRecipients includes
  // slot emails). Load-bearing for the realtor-books-for-buyer flow — the
  // secondary-contact scrub clears the buyer's email off the CALLER's fields,
  // and the gated persistence writes it into a slot BEFORE this gate runs, so
  // without the slot fallback the exact call this feature targets would be
  // skipped as missing_required_customer_fields.
  const slotEmail = customer.service_contact_email
    || customer.service_contact2_email
    || customer.service_contact3_email
    || null;
  const merged = {
    firstName: customer.first_name || extracted.first_name || null,
    lastName: customer.last_name || extracted.last_name || null,
    phone: customer.phone || extracted.phone || callerPhone || null,
    email: customer.email || extracted.email || slotEmail || null,
    streetAddress: customer.address_line1 || extracted.address_line1 || null,
    city: customer.city || extracted.city || null,
    state: customer.state || extracted.state || null,
    zip: customer.zip || extracted.zip || null,
  };

  const missing = [];
  if (!String(merged.firstName || '').trim()) missing.push('first_name');
  if (!String(merged.lastName || '').trim()) missing.push('last_name');
  if (!hasUsablePhone(merged.phone)) missing.push('phone');
  if (!EMAIL_RE.test(String(merged.email || '').trim().toLowerCase())) missing.push('email');
  if (!String(merged.streetAddress || '').trim()) missing.push('street_address');
  if (!String(merged.city || '').trim()) missing.push('city');
  if (!String(merged.state || '').trim()) missing.push('state');
  if (!String(merged.zip || '').trim()) missing.push('zip');

  return { ok: missing.length === 0, missing, details: merged };
}

async function backfillCustomerFromAppointmentContact(customerId, customer = {}, extracted = {}, callerPhone = null) {
  if (!customerId) return customer;
  const updates = {};
  if (!customer.first_name && extracted.first_name) updates.first_name = capitalizeName(extracted.first_name);
  if (!customer.last_name && extracted.last_name) updates.last_name = capitalizeName(extracted.last_name);
  if (!customer.phone && (extracted.phone || callerPhone)) updates.phone = extracted.phone || callerPhone;
  if (!customer.email && extracted.email) updates.email = extracted.email;
  if (!customer.address_line1 && extracted.address_line1) updates.address_line1 = extracted.address_line1;
  if (!customer.city && extracted.city) updates.city = extracted.city;
  if (!customer.state && extracted.state) updates.state = extracted.state;
  if (!customer.zip && extracted.zip) updates.zip = extracted.zip;
  if (Object.keys(updates).length === 0) return customer;
  updates.updated_at = new Date();
  await db('customers').where({ id: customerId }).update(updates);
  return { ...customer, ...updates };
}

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

// ── Download Twilio recording (authenticated) ──
async function downloadRecording(mp3Url) {
  const twilioAuth = Buffer.from(
    `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
  ).toString('base64');

  const res = await fetch(mp3Url, {
    headers: { Authorization: `Basic ${twilioAuth}` },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function normalizeOpenAITranscript(data) {
  if (!data) return null;
  if (typeof data === 'string') return data.trim() || null;

  if (Array.isArray(data.segments)) {
    const speakerLabels = new Map();
    const text = data.segments
      .map((segment) => {
        const speaker = segment.speaker || segment.speaker_id || segment.speaker_label;
        const body = String(segment.text || '').trim();
        if (!body) return null;
        if (!speaker) return body;
        if (!speakerLabels.has(speaker)) speakerLabels.set(speaker, `Speaker ${speakerLabels.size + 1}`);
        return `${speakerLabels.get(speaker)}: ${body}`;
      })
      .filter(Boolean)
      .join('\n');
    return text.trim() || null;
  }

  if (typeof data.text === 'string') return data.text.trim() || null;
  return null;
}

// Normalize OpenAI diarized_json segments into a stable, storable shape:
// { id, index, speaker, start_ms, end_ms, text }. OpenAI reports segment
// start/end in SECONDS (float) — converted to integer ms here. `id` preserves
// the provider's stable identifier verbatim (gpt-4o-transcribe-diarize returns
// a STRING like "seg_001"), so a stored segment can be reconciled with the raw
// API payload; `index` is our positional fallback for ordering. Keeps the RAW
// diarization speaker label (A/B/speaker_0); the human Agent/Caller labels live
// on the text transcript, produced by a separate labeling pass.
function normalizeOpenAISegments(data) {
  if (!data || !Array.isArray(data.segments)) return null;
  const segments = data.segments
    .map((seg, i) => {
      const text = String(seg.text || '').trim();
      if (!text) return null;
      const start = Number(seg.start);
      const end = Number(seg.end);
      return {
        id: seg.id != null ? seg.id : null,
        index: i,
        speaker: seg.speaker || seg.speaker_id || seg.speaker_label || null,
        start_ms: Number.isFinite(start) ? Math.round(start * 1000) : null,
        end_ms: Number.isFinite(end) ? Math.round(end * 1000) : null,
        text,
      };
    })
    .filter(Boolean);
  return segments.length ? segments : null;
}

function transcriptHasAgentCallerLabels(transcript) {
  return /(^|\n)\s*(Agent|Caller)\s*:/i.test(String(transcript || ''));
}

function recordingDurationSeconds(call = {}) {
  return Number(call.recording_duration_seconds || call.duration_seconds || call.duration || 0) || 0;
}

function shouldTryGeminiBeforeAcceptingOpenAI(transcript, opts = {}) {
  const text = String(transcript || '');
  const durationSeconds = recordingDurationSeconds(opts.call || {});
  return durationSeconds >= OPENAI_COMPLETENESS_FALLBACK_SECONDS
    || text.length >= OPENAI_COMPLETENESS_FALLBACK_CHARS;
}

function extractOpenAIText(data) {
  if (typeof data?.output_text === 'string') return data.output_text;
  const parts = [];
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === 'output_text' && content.text) parts.push(content.text);
      if (content?.type === 'text' && content.text) parts.push(content.text);
    }
  }
  return parts.join('');
}

async function labelTranscriptWithOpenAI(transcript, opts = {}) {
  const text = String(transcript || '').trim();
  if (!text || transcriptHasAgentCallerLabels(text)) return text || null;
  if (!process.env.OPENAI_API_KEY) return null;

  const direction = isOutboundCall(opts.call) ? 'outbound' : 'inbound';
  const contactPhone = resolveCallContactPhone(opts.call || {}, opts.contactPhone);

  try {
    const res = await fetch(OPENAI_RESPONSES_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_TRANSCRIPT_LABEL_MODEL,
        input: `Relabel this Waves Pest Control phone transcript for downstream extraction.

Call direction: ${direction}
External customer/contact phone: ${contactPhone || 'unknown'}

Rules:
- Preserve every spoken word exactly. Do not summarize, add facts, omit turns, or rewrite meaning.
- Rewrite only speaker prefixes so each turn starts with exactly "Agent:" or "Caller:".
- "Agent" means Waves staff. "Caller" means the external customer/contact, including on outbound calls placed by Waves.
- If a speaker identity is unclear, infer from context such as greetings, scheduling role, company references, and whether the speaker provides customer contact/service details.
- Return the relabeled transcript only.

Transcript:
${text}`,
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      logger.warn(`[call-proc] OpenAI transcript labeling failed: ${res.status} ${errBody.slice(0, 200)}`);
      return null;
    }

    const data = await res.json();
    const labeled = extractOpenAIText(data).trim();
    if (!transcriptHasAgentCallerLabels(labeled)) {
      logger.warn('[call-proc] OpenAI transcript labeling returned no Agent/Caller labels');
      return null;
    }
    // The labeling pass re-emits the ENTIRE transcript, and both extractors
    // read its output as evidence — a sampled word swap here ("do not want to
    // cancel" losing its "not") corrupts every downstream decision. The model
    // is only allowed to rewrite speaker prefixes, so after stripping the
    // per-line "<label>:" prefix from both versions the spoken-word content
    // must be identical. Any content drift → discard the labeled version and
    // let callers fall back to the raw transcript (labels lost, words safe).
    if (!labeledTranscriptPreservesWords(text, labeled)) {
      logger.warn('[call-proc] OpenAI transcript labeling altered spoken words — discarding labeled version');
      return null;
    }
    return labeled;
  } catch (err) {
    logger.error(`[call-proc] OpenAI transcript labeling error: ${err.message}`);
    return null;
  }
}

// Content-integrity check for the labeling pass: strip each line's speaker
// prefix ("Agent:", "Caller:", "Speaker 1:", ...) from both versions, then
// compare the remaining spoken-word token multisets. Exact equality required —
// a tolerance would mask exactly the single-word corruption (a dropped "not")
// this exists to catch. Reflowed turns are fine (multiset, not sequence).
function labeledTranscriptPreservesWords(original, labeled) {
  const contentTokens = (transcript) => {
    const tokens = [];
    for (const line of String(transcript || '').split('\n')) {
      const content = line.replace(/^\s*[^:\n]{1,30}:\s*/, '');
      for (const tok of content.toLowerCase().split(/[^a-z0-9']+/)) {
        if (tok) tokens.push(tok);
      }
    }
    return tokens;
  };
  const counts = new Map();
  for (const tok of contentTokens(original)) counts.set(tok, (counts.get(tok) || 0) + 1);
  for (const tok of contentTokens(labeled)) {
    const n = counts.get(tok);
    if (!n) return false;
    if (n === 1) counts.delete(tok);
    else counts.set(tok, n - 1);
  }
  return counts.size === 0;
}

// ── Primary transcription via OpenAI (multipart upload) ──
// opts.model/opts.prompt override the defaults for secondary passes (the
// contact-dictation pass runs gpt-4o-transcribe with a dictation-focused
// prompt). NOTE: gpt-4o-transcribe-diarize does NOT support the prompt
// parameter (or logprobs/timestamp_granularities) — prompting only ever
// applies on non-diarize models, which is why the branch below exists.
async function transcribeWithOpenAI(audioBuffer, opts = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const model = opts.model || OPENAI_TRANSCRIPTION_MODEL;
  const prompt = opts.prompt || OPENAI_TRANSCRIPTION_PROMPT;
  try {
    const form = new FormData();
    form.append('file', new Blob([audioBuffer], { type: 'audio/mpeg' }), 'call-recording.mp3');
    form.append('model', model);
    form.append('language', 'en');
    const diarized = model.includes('diarize');
    form.append('response_format', diarized ? 'diarized_json' : 'json');
    if (diarized) {
      form.append('chunking_strategy', 'auto');
    } else {
      form.append('prompt', prompt);
    }
    form.append('temperature', '0');

    const res = await fetch(OPENAI_TRANSCRIPTIONS_API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      logger.warn(`[call-proc] OpenAI transcription failed: ${res.status} ${errBody.slice(0, 200)}`);
      return null;
    }

    const contentType = res.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await res.json() : await res.text();
    const text = normalizeOpenAITranscript(data);
    if (!text) return null;
    return {
      text,
      segments: normalizeOpenAISegments(data),
      provider: 'openai',
      model,
      responseFormat: diarized ? 'diarized_json' : 'json',
    };
  } catch (err) {
    logger.error(`[call-proc] OpenAI transcription error: ${err.message}`);
    return null;
  }
}

// ── Secondary fallback transcription via Gemini (inline base64) ──
async function transcribeWithGemini(audioBuffer, opts = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  try {
    const audioBase64 = audioBuffer.toString('base64');
    const direction = isOutboundCall(opts.call) ? 'outbound' : 'inbound';
    const contactPhone = resolveCallContactPhone(opts.call || {}, opts.contactPhone);
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TRANSCRIPTION_MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inlineData: { mimeType: 'audio/mpeg', data: audioBase64 } },
              { text: `Transcribe this phone call recording for Waves Pest Control (pest control + lawn care, SW Florida).
Call direction: ${direction}.
External customer/contact phone: ${contactPhone || 'unknown'}.

Rules:
- Label every turn "Agent:" or "Caller:" on its own line.
- "Agent" means Waves staff. "Caller" means the external customer/contact, including on outbound calls placed by Waves.
- Transcribe verbatim — preserve fillers ("um", "uh"), numbers, addresses, phone numbers, and proper nouns exactly as spoken.
- Street names in addresses are real words or proper names — prefer a plausible street name over a nonsense phonetic rendering.
- When a caller spells something letter-by-letter or with phonetic markers ("B as in boy"), write each letter and marker separately exactly as spoken — never merge a spelled sequence into a guessed word, email, or web address.
- If audio is silent, unintelligible, or only voicemail tones, output exactly: [VOICEMAIL] or [NO SPEECH].
- Do NOT summarize, translate, or add commentary. Output the transcript only, nothing before or after.` },
            ],
          }],
          generationConfig: { temperature: 0 },
        }),
      }
    );
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      logger.warn(`[call-proc] Gemini fallback transcription failed: ${res.status} ${errBody.slice(0, 200)}`);
      return null;
    }
    const data = await res.json();
    // Gemini 2.5 may return thinking parts — skip those
    const parts = data.candidates?.[0]?.content?.parts || [];
    const textPart = parts.find(p => p.text && !p.thought);
    return (textPart?.text || parts[0]?.text || '').trim() || null;
  } catch (err) {
    logger.error(`[call-proc] Gemini fallback transcription error: ${err.message}`);
    return null;
  }
}

// Wrapper: primary transcription + (when the call dictated contact info) a
// SECOND full-call pass on a promptable model. The diarized primary cannot be
// prompted, so token-level dictation fidelity ("W, C as in Charlie, W, six
// three") comes from this pass; the contact-dictation decoder consumes both
// transcripts as evidence. Best-effort — a contact-pass failure never affects
// the primary result.
async function transcribeRecording(mp3Url, opts = {}) {
  const bufferRef = {};
  const result = await transcribeRecordingPrimary(mp3Url, opts, bufferRef);
  try {
    if (
      result?.transcription
      && bufferRef.buffer
      && process.env.CONTACT_DICTATION_ENABLED !== 'false'
      && detectContactDictationSignals(result.transcription).any
    ) {
      const contactModel = process.env.OPENAI_CONTACT_PASS_MODEL || 'gpt-4o-transcribe';
      const second = await transcribeWithOpenAI(bufferRef.buffer, {
        model: contactModel,
        prompt: CONTACT_DICTATION_TRANSCRIPTION_PROMPT,
      });
      if (second?.text) {
        result.contactPassTranscript = second.text;
        if (result.metadata) {
          result.metadata.contact_pass_model = second.model;
          result.metadata.contact_pass_chars = second.text.length;
        }
        logger.info(`[call-proc] contact-dictation pass complete: ${second.text.length} chars (${contactModel})`);
      }
    }
  } catch (err) {
    logger.warn(`[call-proc] contact-dictation pass skipped: ${err.message}`);
  }
  return result;
}

async function transcribeRecordingPrimary(mp3Url, opts = {}, bufferRef = {}) {
  try {
    logger.info(`[call-proc] Downloading recording for transcription: ${mp3Url}`);
    const audioBuffer = await downloadRecording(mp3Url);
    bufferRef.buffer = audioBuffer;
    logger.info(`[call-proc] Downloaded ${Math.round(audioBuffer.length / 1024)}KB audio`);

    const openai = await transcribeWithOpenAI(audioBuffer);
    const openaiTranscript = openai?.text || null;
    // Raw diarized segments (speaker + timestamps) — preserved alongside the
    // text so a future re-extraction has word-level/speaker structure without
    // re-paying for transcription. Only OpenAI yields these; Gemini fallback
    // is text-only.
    const structuredSegments = openai?.segments || null;
    const openaiNeedsCompletenessFallback = openaiTranscript
      && shouldTryGeminiBeforeAcceptingOpenAI(openaiTranscript, opts);

    if (openaiNeedsCompletenessFallback) {
      logger.warn('[call-proc] OpenAI transcript is long/near limit; trying Gemini before accepting it');
    }

    if (openaiTranscript && !openaiNeedsCompletenessFallback) {
      const labeledTranscript = await labelTranscriptWithOpenAI(openaiTranscript, opts);
      if (labeledTranscript) {
        return {
          transcription: labeledTranscript,
          provider: 'openai',
          model: OPENAI_TRANSCRIPTION_MODEL,
          structuredSegments,
          metadata: {
            audio_bytes: audioBuffer.length,
            response_format: openai?.responseFormat || null,
            label_provider: 'openai',
            label_model: OPENAI_TRANSCRIPT_LABEL_MODEL,
            fallback_attempted: false,
          },
        };
      }
      logger.warn('[call-proc] OpenAI transcript missing usable Agent/Caller labels; trying Gemini fallback');
    }

    const geminiTranscript = await transcribeWithGemini(audioBuffer, opts);
    if (geminiTranscript) {
      return {
        transcription: geminiTranscript,
        provider: 'gemini_fallback',
        model: GEMINI_TRANSCRIPTION_MODEL,
        structuredSegments: null,
        metadata: {
          audio_bytes: audioBuffer.length,
          fallback_reason: openaiTranscript ? 'openai_labeling_or_completeness' : 'openai_unavailable',
          openai_model: OPENAI_TRANSCRIPTION_MODEL,
        },
      };
    }

    if (openaiTranscript) {
      const labeledTranscript = await labelTranscriptWithOpenAI(openaiTranscript, opts);
      if (labeledTranscript) {
        return {
          transcription: labeledTranscript,
          provider: 'openai_post_gemini_fallback',
          model: OPENAI_TRANSCRIPTION_MODEL,
          structuredSegments,
          metadata: {
            audio_bytes: audioBuffer.length,
            response_format: openai?.responseFormat || null,
            label_provider: 'openai',
            label_model: OPENAI_TRANSCRIPT_LABEL_MODEL,
            fallback_attempted: true,
            fallback_provider: 'gemini',
            fallback_model: GEMINI_TRANSCRIPTION_MODEL,
          },
        };
      }
      logger.warn('[call-proc] Using raw OpenAI transcript because labeling and Gemini fallback failed');
      return {
        transcription: openaiTranscript,
        provider: 'openai_unlabeled_fallback',
        model: OPENAI_TRANSCRIPTION_MODEL,
        structuredSegments,
        metadata: {
          audio_bytes: audioBuffer.length,
          response_format: openai?.responseFormat || null,
          label_provider: null,
          fallback_attempted: true,
          fallback_provider: 'gemini',
          fallback_model: GEMINI_TRANSCRIPTION_MODEL,
        },
      };
    }

    return { transcription: null, provider: null };
  } catch (err) {
    logger.error(`[call-proc] Recording transcription download/setup error: ${err.message}`);
    return { transcription: null, provider: null };
  }
}

// ── AI extraction via Gemini ──
//
// Same JSON schema as the prior Claude implementation — only the model
// endpoint changed. Gemini's response_mime_type='application/json'
// forces structured output so we rarely have to strip markdown fences,
// but we still guard-parse for the "text-only refusal" edge case.
async function extractCallData(transcription, callerPhone, opts = {}) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not configured');
  }
  const callDateET = etDateString(opts.callStartedAt || new Date());

  // Known-caller context: when the inbound number maps to a single existing
  // customer we tell the model who's calling, so it can tell a NEW prospect
  // (a lead) apart from an existing customer coordinating a visit, reporting a
  // problem, or asking about billing (not leads).
  const knownCaller = opts.knownCaller || null;
  // matched_service picks from the live bookable catalog first (specific
  // services like "Cockroach Control Service"), backstopped by the legacy
  // coarse labels so intent gating (canonicalWavesService) keeps working.
  const LEGACY_MATCHED_SERVICES = [
    'General Pest Control', 'Lawn Care', 'Mosquito Control', 'Termite Inspection', 'WDO Inspection',
    'Pre-Slab Termidor', 'Liquid Termite Perimeter', 'Termite Wood Treatment', 'Termite Foam Drill',
    'Rodent Control', 'Bed Bug Treatment', 'Tree & Shrub Care',
  ];
  const bookableNames = Array.isArray(opts.bookableServiceNames) ? opts.bookableServiceNames.filter(Boolean) : [];
  const matchedServiceList = [...new Set([...bookableNames, ...LEGACY_MATCHED_SERVICES])].join(', ');
  const knownCallerBlock = knownCaller
    ? `\nKNOWN CALLER: This phone number matches an EXISTING Waves ${
        knownCaller.accountType === 'established_customer' ? 'customer' : 'contact'
      }${knownCaller.name ? ` (${knownCaller.name})` : ''}. They are already in our system — treat coordination of an existing/scheduled visit, "are you coming today?", arrival check-ins, complaints about work already done, reschedules, and billing/invoice questions as NOT a new lead (is_lead=false). Only treat a brand-new service request they haven't bought yet as a lead.\n`
    : '';

  const prompt = `Analyze this phone call transcript for Waves Pest Control (pest control + lawn care, SW Florida). Waves is an established company with many existing customers, so not every call is a new sales lead — some are existing customers coordinating service, complaints, or billing.

Waves only schedules pest control, lawn care, mosquito, termite, rodent, bed bug, WDO, and tree/shrub services. Calls about unrelated work such as website SEO, organic traffic, marketing, advertising, or a construction company are not Waves appointments.

Caller phone: ${callerPhone || 'unknown'}
Call date in Eastern Time: ${callDateET}
${knownCallerBlock}
Transcript:
${transcription}

Extract the following as JSON. Use null for anything not clearly stated:
{
  "first_name": "string or null",
  "last_name": "string or null",
  "email": "string or null",
  "phone": "string or null — the callback number the caller STATES on the call; null when none is stated (the server falls back to caller ID — do NOT echo the caller ID here)",
  "address_line1": "street address or null",
  "city": "string or null — the city as stated, even when outside Florida (out-of-area calls need the real city for triage)",
  "state": "FL",
  "zip": "string or null",
  "additional_properties": [{"address_line1": "street address", "address_line2": "unit or null", "city": "string or null", "state": "FL", "zip": "string or null", "is_rental": true/false, "property_type": "condo/house/commercial/etc or null", "notes": "anything the caller said about this property, or null"}],
  "secondary_contact": {"first_name": "string or null", "last_name": "string or null", "phone": "string or null", "email": "string or null", "role": "one of: home_buyer, home_seller, tenant, landlord, spouse_partner, family_member, real_estate_agent, property_manager, other, unknown", "wants_notifications": true/false, "notes": "string or null"} or null,
  "requested_service": "what service they're calling about",
  "appointment_confirmed": true/false,
  "preferred_date_time": "ISO 8601 local (no timezone) in Eastern Time: YYYY-MM-DDTHH:MM — e.g. 2026-04-20T14:00 for April 20, 2026 at 2:00 PM ET. null if not confirmed.",
  "is_voicemail": true/false,
  "is_spam": true/false,
  "is_lead": true/false,
  "call_type": "one of: new_inquiry, existing_customer_scheduling, existing_customer_service, complaint, billing, spam, wrong_number, voicemail, other",
  "sentiment": "positive/neutral/negative/frustrated",
  "pain_points": "brief summary of customer concerns or pest issues",
  "call_summary": "2-3 sentence summary of the call",
  "lead_quality": "hot/warm/cold/spam",
  "matched_service": "best match from: ${matchedServiceList}, or null — prefer the MOST SPECIFIC service that fits (e.g. a German/kitchen cockroach infestation cleanout is Cockroach Control Service, not General Pest Control)",
  "quoted_price": number or null,
  "quote_requested": true/false,
  "quote_promised": true/false,
  "follow_up_visit_mentioned": true/false,
  "follow_up_date_time": "same ISO format as preferred_date_time, or null",
  "referred_by": "if the caller EXPLICITLY says a friend / neighbor / existing customer referred or recommended them, the referrer's name — or 'unnamed' if they say they were referred but don't name who. Else null."
}

IMPORTANT — multiple properties (address_line1 vs additional_properties):
- When the caller wants service at MORE THAN ONE property (a second home, a rental, another unit, "we bought a condo AND a house"), address_line1/city/zip hold the PRIMARY property and EVERY other property goes in additional_properties — never drop one, never merge two addresses into one.
- Primary = the property the caller treats as their main one (owner-occupied beats rental; the booked-visit property beats an unbooked one; else the first address given).
- When the caller says a second property has the "same" city/ZIP/community as the first ("same zip and everything"), RESOLVE it: copy the stated city/ZIP onto that entry.
- is_rental: true when the caller says the property is a rental, investment property, tenant-occupied, or Airbnb/short-term rental.
- additional_properties is [] when only one property is discussed. Never invent a second property from a mailing address or a passing mention of a neighbor's home.

IMPORTANT — secondary_contact (a SECOND person who is a party to the service):
- Set secondary_contact when the caller names ANOTHER person as a party to the service being arranged AND gives at least their name or contact info — a realtor booking an inspection names the home buyer, a landlord names the tenant, a spouse names the account holder, an adult child books for a parent.
- The CALLER's own identity always goes in the top-level first_name/last_name/phone/email fields. secondary_contact is ONLY the other person — never duplicate the caller into it, and never put the other person's phone/email into the caller's fields.
- role describes the secondary person's relationship to the transaction (the BUYER a realtor is booking for is home_buyer, not real_estate_agent).
- wants_notifications: true ONLY when the caller explicitly directs that this person receive notifications, confirmations, updates, the report, or the invoice ("send notifications to the buyer and myself", "text my tenant when you're on the way"). A person merely mentioned — or explicitly excluded ("you don't have to involve Matt") — gets wants_notifications false.
- When several other people are mentioned, extract the one the caller designates for contact/notifications; if none is designated, the one most central to the service (the property's buyer/occupant beats a bystander).
- Apply the same spelled-out-input, correction, and do-not-invent rules as the caller's own contact fields. A person mentioned with no name AND no contact info: secondary_contact is null.

IMPORTANT — quote_requested / quote_promised (drives the sales pipeline):
- quote_requested: true when getting a QUOTE/estimate/pricing is a reason for the call — "can I get a quote", "what would it cost for...", "send me an estimate". A caller who only booked without asking for a quote: false.
- quote_promised: true ONLY when the AGENT commits to send a quote/estimate AFTER the call ("we'll send you a quote this afternoon", "I'll email you an estimate", "we'll text you pricing"). A price merely spoken on the call is NOT a promised quote. This field means WORK IS STILL OWED to the caller after hangup — set it even when an appointment was also booked.

IMPORTANT — assessments vs formal inspections (service matching):
- A caller who SUSPECTS a pest problem or wants someone to come look, diagnose, or check ("I think I have termites", "something is eating my lawn", "can someone come take a look") matches "Waves Assessment" — NOT a formal inspection service.
- "WDO Inspection Service" is ONLY for an explicitly requested wood-destroying-organism REPORT: real-estate sale/closing/refinance, lender or VA requirement, "termite letter"/"clearance letter", or the caller literally asks for a WDO inspection.
- The Pre-Slab Termidor rule above still wins for pre-construction/soil-treatment requests.

IMPORTANT — transcript reliability (the transcript is evidence, not truth):
- CORRECTIONS: when the caller corrects themselves ("it's 555-2091 — sorry, no, 555-2901"), the LAST clearly confirmed value wins. Apply this to every field: phone, address, date, time, email, service.
- FINAL OUTCOME WINS: in a long call the plan can change ("Tuesday... actually let's do Wednesday", cancel → reschedule). Extract the FINAL agreed state at hangup, not an earlier abandoned one.
- NEGATION: read carefully around "not/don't/never" — "I do NOT want to cancel" is not a cancellation. A missed negation reverses the meaning; when a negation makes intent unclear, use the more conservative value.
- WHO SAID IT: only the CALLER's words establish agreement, consent, or a request. An agent reading a script ("you can cancel any time"), suggesting, or summarizing is not the caller agreeing. "Yeah, that sounds fine" only confirms what the caller was directly responding to.
- SIMILAR-SOUNDING NUMBERS: fifteen/fifty, "two oh five"/"205", B/D/P/T/V letters — when the transcript makes a number or spelled letter genuinely ambiguous and it isn't confirmed elsewhere in the call, return null rather than guess.
- MENTIONED ≠ AGREED: something discussed hypothetically ("if it comes back you could do quarterly") was not requested, booked, or purchased.

IMPORTANT — referred_by (word-of-mouth attribution):
- Set referred_by ONLY on an explicit referral: "my neighbor Jane told me to call", "a friend recommended you", "you treat my sister's house and she said to call". Use the referrer's name if stated, else "unnamed".
- Do NOT infer a referral from a passing mention of a neighbor, or from Google / website / ad / Facebook / "saw your truck" mentions. When unsure, use null.

IMPORTANT — is this a new lead? Set call_type and is_lead together:
- "new_inquiry" (is_lead=true): a NEW prospective customer asking about service, pricing, availability, or booking for the first time. This is the ONLY call_type that is a lead.
- "existing_customer_scheduling" (is_lead=false): an existing customer confirming, coordinating, rescheduling, or asking about an already-scheduled or in-progress visit — e.g. "are you coming today?", "what time will the tech arrive?", a tech-arrival check-in.
- "existing_customer_service" (is_lead=false): an existing customer with a question or problem about service already performed, or a general account question that is not a new purchase.
- "complaint" (is_lead=false): a complaint about service quality, a missed or late appointment, or a technician issue.
- "billing" (is_lead=false): an invoice, payment, receipt, refund, or account-balance question.
- "spam" (is_lead=false): a solicitor, vendor pitch, robocall, or marketing call (also set is_spam=true).
- "wrong_number" (is_lead=false): a misdial or a call clearly not meant for Waves.
- "voicemail" (is_lead=false): a voicemail with NO workable content — a hang-up, dead air, unintelligible audio, or a message that states no reason for calling (also set is_voicemail=true).
- "other" (is_lead=false): none of the above.
An EXISTING customer requesting a NEW, different service they have not purchased is still a lead (new_inquiry, is_lead=true).
Voicemail is a CHANNEL, not a content type: whenever no live two-way conversation took place (the caller left a message), set is_voicemail=true — then classify call_type by what the MESSAGE says, exactly as if it had been a live call. A NEW prospect leaving a message asking about service, pricing, or a callback about service is "new_inquiry" (is_lead=true) even though it arrived as a voicemail. Reserve call_type "voicemail" for messages whose content fits none of the other categories.

IMPORTANT — lead_quality (only meaningful when is_lead=true; use "cold" otherwise):
- "hot": ready to buy now — asking to book, requesting the soonest opening, an urgent active infestation, or explicitly says "sign me up".
- "warm": genuinely interested but not urgent — wants a quote, is deciding, will likely move forward soon.
- "cold": just shopping or researching — comparing providers, gathering info, "I'll call you back", "getting a few quotes", price-checking with no commitment.
- "spam": not a real prospect (solicitor / robocall / wrong number).
Do not inflate quality: a caller who is still comparing companies or said they'd call back is "cold", not "warm".

IMPORTANT — appointment_confirmed rules:
- Only set appointment_confirmed to true if BOTH a specific DATE and a specific TIME were explicitly agreed to by the caller.
- Vague references like "tomorrow", "next week", "noonish", "sometime Tuesday" do NOT count — the caller must confirm an actual time (e.g. "10 AM", "2:30 PM", "noon").
- If the agent says "I'll text you" or "let me check" without the caller confirming a specific time slot, appointment_confirmed must be false.
- preferred_date_time must include the confirmed time, not just a date.
- Resolve relative dates against the call date above in Eastern Time. "Today" means ${callDateET}; do not invent a prior year or use the model's training/current date.
  - Do not set appointment_confirmed to true for unrelated business advice, SEO, marketing, construction advice, or other non-Waves services even if a time was discussed.
  - Do set appointment_confirmed to true when a builder or construction company explicitly books a Waves pre-slab/preconstruction termite, soil-treatment, or concrete-pour field-service appointment with a specific date and time.
- Do not set appointment_confirmed to true for follow-up/admin calls about an invoice, payment, receipt, compliance report, sticker, certificate, W-9, report, or paperwork unless the caller and agent also explicitly book a new Waves field-service visit.
- If the caller asks for soil poison, soil treatment, pre-slab/preconstruction termite work, new-construction termite treatment, or treatment before a slab/concrete pour, matched_service must be "Pre-Slab Termidor" — not "Termite Inspection".

IMPORTANT — quoted_price and follow-up visit:
- quoted_price: the TOTAL price in US dollars the agent quoted AND the caller accepted for the service being booked (agent: "that runs around 350 total", caller agrees -> 350). Use the total package price when quoted as a total across multiple treatments. null when no price was quoted, the caller didn't accept, or the amount is uncertain or a range. Never estimate or invent a price.
- follow_up_visit_mentioned: true ONLY when the agent and caller specifically discussed a SECOND/follow-up treatment visit as part of this booking (e.g. "our standard protocol is two treatments", "we'll come back in two weeks"). A generic "call us if it comes back" is NOT a follow-up visit.
- follow_up_date_time: set ONLY when a specific follow-up date (and time) was explicitly agreed on the call. Most calls: null — the office schedules the follow-up at the standard interval.

IMPORTANT — customer name rules:
- Capture both first_name and last_name whenever the caller clearly states both.
- If only one name is clearly stated, put it in first_name and leave last_name null.
- Do not invent a last name from caller ID, address, email, or context.

IMPORTANT — spelled-out names and emails are authoritative over how they sounded:
- When the caller spells a name or email letter-by-letter, or with phonetic markers ("B as in boy", "V as in Victor", "N as in Nancy"), the SPELLED letters are the source of truth — use them, not the word as it was transcribed phonetically. Callers spell precisely because the spoken form is easy to mishear (e.g. the caller says "Smyth" but then spells S-M-I-T-H, so the correct value is "Smith", and the email is jane.smith@example.com — NOT smyth). This is an illustrative example only — never copy this name or email into the output.
- When an email is described relative to the name (e.g. "first name dot last name"), build it from the SPELLED name parts, not the misheard spoken form.
- Transcription often CONCATENATES a phonetic spelling into nonsense tokens: "blikenboy, vlikenvictor" is "B like in boy, V like in Victor" — decode each such token to its letter (B, V). A run of these tokens ending in digits is a spelled email local part ("blikenboy vlikenvictor 42 at gmail.com" → bv42@gmail.com). Decode the letters even when the words are jammed together.
- The decoded spelled letters ALSO beat the caller's own read-back of the finished email as transcribed — the read-back is one more chance for the transcriber to mishear. A transcribed local part that looks like a URL fragment ("www.", "http") is a mis-hearing, never a real mailbox: reconstruct it from the spelled letters, and if you cannot reconstruct it confidently, return null.

IMPORTANT — customer contact rules:
- Do not invent email addresses. Only return email when the caller clearly says or spells the complete address.
- If the transcript contains an uncertain, partial, or malformed email, return null.
- Return the caller phone unless the caller clearly gives a different callback number.
- Do not overwrite or infer customer identity from transcript context alone; uncertain names, phones, emails, or addresses must be null.

Return ONLY valid JSON.`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EXTRACTION_V1_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          response_mime_type: 'application/json',
          temperature: 0, // closed-enum structured extraction — greedy decode; 0.2 was pure routing-gate noise
        },
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gemini HTTP ${res.status}: ${body.slice(0, 240)}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text?.trim() || '{}';
  // response_mime_type:application/json usually prevents fences, but strip
  // defensively in case the model falls back to markdown.
  const cleaned = text.replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim();
  try {
    return normalizeCallExtraction(JSON.parse(cleaned), { callerPhone });
  } catch (e) {
    logger.error(`[call-proc] Invalid JSON from Gemini: ${e.message} — raw: ${cleaned.slice(0, 200)}`);
    return normalizeCallExtraction({
      first_name: null,
      is_spam: false,
      is_voicemail: false,
      call_summary: 'AI extraction returned invalid JSON',
      lead_quality: 'cold',
    }, { callerPhone });
  }
}

// ── V2 Extraction (shadow pipeline — stores alongside, never replaces v1) ──

// The v1.0.0 schema is too deep/enum-heavy for Gemini's constrained-decoding
// response_schema ("too many states for serving"), so we use plain JSON mode and
// embed the schema as prompt guidance. Correctness is guaranteed by the two-pass
// ajv validation in finalizeV2Extraction — the model output is never trusted directly.
// Shared by the live Gemini path and the OpenAI shadow so both send the identical prompt.
function buildV2ExtractionPrompt(transcription, callerPhone, callDateET, promptOpts = {}) {
  return buildExtractionPrompt(transcription, callerPhone, callDateET, promptOpts)
    + '\n\n═══ OUTPUT CONTRACT ═══\n'
    + 'Return ONLY a single JSON object that conforms EXACTLY to this JSON Schema: '
    + 'every required field present, every enum value exact, no extra fields, '
    + 'use null for unknown nullable fields.\n'
    + JSON.stringify(modelOutputSchema);
}

// Parse → validate(model-output) → inject server meta → normalize → validate(persisted).
// Provider-agnostic tail shared by the Gemini and OpenAI extraction paths. Fails closed
// to a status string; never trusts model output directly.
function finalizeV2Extraction(rawText, { callId = null, extractionModel, promptVersion = null } = {}) {
  // Pass 1: parse JSON
  let parsed;
  try {
    const cleaned = String(rawText).replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    logger.error(`[call-proc-v2] JSON parse failed: ${e.message} (${String(rawText).length} chars)`);
    return { status: 'parse_failed', extraction: null, errors: [{ message: e.message }] };
  }

  // Pass 2: validate against model-output schema
  const modelValidation = validateModelOutput(parsed);
  if (!modelValidation.valid) {
    logger.warn(`[call-proc-v2] Model output schema validation failed: ${JSON.stringify(modelValidation.errors?.slice(0, 5))}`);
    return { status: 'schema_failed', extraction: parsed, errors: modelValidation.errors };
  }

  // Inject server-owned metadata
  parsed.meta = {
    ...parsed.meta,
    call_id: callId,
    schema_version: SCHEMA_VERSION,
    extracted_at: new Date().toISOString(),
    extraction_model: extractionModel,
    extraction_prompt_version: promptVersion || PROMPT_HASH,
  };

  // Normalize
  let normalized;
  try {
    normalized = normalizeExtractionV2(parsed);
  } catch (e) {
    logger.error(`[call-proc-v2] Normalization failed: ${e.message}`);
    return { status: 'normalization_failed', extraction: parsed, errors: [{ message: e.message }] };
  }

  // Pass 3: validate against persisted schema
  const persistedValidation = validatePersisted(normalized);
  if (!persistedValidation.valid) {
    logger.warn(`[call-proc-v2] Persisted schema validation failed: ${JSON.stringify(persistedValidation.errors?.slice(0, 5))}`);
    return { status: 'schema_failed', extraction: normalized, errors: persistedValidation.errors };
  }

  return { status: 'valid', extraction: normalized, errors: null };
}

async function extractCallDataV2(transcription, callerPhone, opts = {}) {
  if (!process.env.GEMINI_API_KEY) return { status: 'not_run', extraction: null, errors: null };

  const callDateET = etDateString(opts.callStartedAt || new Date());
  const prompt = buildV2ExtractionPrompt(transcription, callerPhone, callDateET, {
    bookableServiceNames: opts.bookableServiceNames,
    // Existing-customer hint — V1 has had this since the non-lead veto work;
    // without it V2 reads "still on for Tuesday at 10?" as a fresh confirmed
    // booking (the duplicate-appointment path).
    knownCaller: opts.knownCaller,
  });

  let rawText;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EXTRACTION_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            response_mime_type: 'application/json',
            // Greedy decode — this output feeds the routing gate directly;
            // 0.2 sampling could flip a borderline scheduling.status between
            // reprocesses of the same call.
            temperature: 0,
          },
        }),
      }
    );

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.error(`[call-proc-v2] Gemini HTTP ${res.status}: ${body.slice(0, 240)}`);
      return { status: 'parse_failed', extraction: null, errors: [{ message: `Gemini HTTP ${res.status}` }] };
    }

    const data = await res.json();
    rawText = data?.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text?.trim() || '{}';
  } catch (err) {
    logger.error(`[call-proc-v2] Gemini request failed: ${err.message}`);
    return { status: 'parse_failed', extraction: null, errors: [{ message: err.message }] };
  }

  return finalizeV2Extraction(rawText, {
    callId: opts.callId || null,
    extractionModel: GEMINI_EXTRACTION_MODEL,
    // The catalog block is part of the rendered prompt, so the stamped
    // version must carry its hash or cohorts mix under one version.
    promptVersion: extractionPromptVersion(opts.bookableServiceNames),
  });
}

// ── Lead Synopsis via Claude (Sales Strategist prompt) ──
async function generateLeadSynopsis(transcription) {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    const response = await client.messages.create({
      model: MODELS.FLAGSHIP,
      max_tokens: 1200,
      messages: [{
        role: 'user',
        content: `Role:
You are a Sales Strategist and Customer Experience Analyst for Waves Pest Control & Lawn Care, a family-owned company serving Southwest Florida (Manatee, Sarasota, and Charlotte counties). You think like a local business owner — direct, practical, no corporate fluff.

Analyze the following lead interaction (call transcription or SMS thread):
${transcription}

Step 0 — Qualify the Lead (Gate Check):
Before any analysis, determine whether this interaction is a new inbound lead — someone reaching out for the first time via website, phone, or text requesting services or information.
If the interaction is any of the following, respond with only: "Not a new lead — no analysis needed." and stop.
- An existing customer calling about a scheduled service, billing, or account issue
- A vendor, solicitor, robocall, or spam
- An internal team conversation
- A callback or follow-up on an already-quoted job

If it IS a new lead, proceed with the full analysis below.

Step 1 — Service Request Identification:
List every service the caller/texter is asking about or implying they need. Be specific. Examples: general pest control (interior/exterior), lawn care program, mosquito treatment, termite inspection, rodent exclusion, WDO inspection, tree & shrub care, fire ant treatment, etc. If they describe a problem without naming a service, map it to the correct Waves service.

Step 2 — Lead Intelligence:
- Primary Pain Point: Urgent infestation? Frustration with a previous provider? Aesthetic/lawn health concern? Quote the specific language they used.
- Buying Triggers: Words or questions that signal purchase intent — asking about scheduling, pricing, "how soon can someone come out," comparing providers, describing urgency. List each one.
- Trust Barriers: Any hesitation signals — pet/child safety concerns, contract aversion, price sensitivity, skepticism about effectiveness, bad past experience. List each one.
- Property Context: Anything mentioned about property size, location, HOA, type (single-family, condo, new construction), or existing conditions.

Step 3 — Actionable Strategy:
A. Immediate Close — What to Say Right Now
Write the exact words (2–4 sentences) the person calling them back or responding to their text should say to win this job today. Match the tone to the customer's energy.

B. WaveGuard Positioning
Based on their specific pain point, write one concise pitch (2–3 sentences) that positions the WaveGuard recurring membership as the solution — not as an upsell, but as the answer to the exact problem they described. Use their own language back at them.

C. Office Follow-Up Action
One specific, concrete step Virginia or the office should take within the next 2 hours to keep this lead warm. Not generic ("follow up") — specific.

Formatting:
Use markdown headers (##) for sections. Use bullet points. Keep the entire output under 400 words. Write like you're handing a cheat sheet to a technician sitting in the truck.`,
      }],
    });

    return response.content[0]?.text?.trim() || null;
  } catch (err) {
    logger.error(`[call-proc] Synopsis generation failed: ${err.message}`);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
// MAIN PROCESSOR
// ══════════════════════════════════════════════════════════════
const CallRecordingProcessor = {
  /**
   * Process a call recording end-to-end.
   * Called from recording-status webhook or manually from admin.
   */
  async processRecording(callSid, opts = {}) {
    const call = await db('call_log').where('twilio_call_sid', callSid).first();
    if (!call) throw new Error(`Call not found: ${callSid}`);

    // Dedup guard — skip if already fully processed (prevents duplicate
    // SMS on webhook retries). opts.force=true bypasses the guard so the
    // admin "Reprocess" button can re-run extraction with updated prompts
    // / model / customer-field backfills without hand-editing the DB.
    if (call.processing_status === 'processed' && !opts.force) {
      logger.info(`[call-proc] Already processed ${callSid} — skipping`);
      return { success: true, skipped: true, reason: 'already_processed' };
    }

    // Concurrent-run guard: the ring-first flow can fire two
    // recording-status webhooks for one call (outer <Dial record> + inner
    // voicemail <Record> share the same CallSid), and both schedule
    // processRecording on a 5s delay. Without this atomic claim, both
    // race through extraction and both send the confirmation SMS. Atomic
    // UPDATE → conditional exit: the first run wins, the second bails.
    // Owner fence for the catch-block release below: write a fresh random
    // token at claim time, match it on release. Only this code path writes
    // processing_token, so unrelated updates to call_log.updated_at (e.g.
    // the Twilio transcription webhook in twilio-voice-webhook.js) can't
    // accidentally invalidate the fence. When the 10-min stale reclaim
    // hands the lock to a peer, the peer's claim overwrites the token and
    // our catch-block UPDATE matches 0 rows — we leave the peer alone.
    const procToken = crypto.randomBytes(16).toString('hex');
    if (!opts.force) {
      // Reclaim stale 'processing' rows older than 10 min — server crash or
      // Gemini hang between claim (this UPDATE) and terminal status write
      // would otherwise wedge the row forever, since both the claim guard
      // below and processAllPending's filter exclude 'processing'.
      // IS DISTINCT FROM (not !=): rows with processing_status IS NULL —
      // the state of every fresh, never-claimed row — must pass these
      // predicates. PostgreSQL's `<>` returns NULL when either side is NULL,
      // and WHERE treats NULL as falsy, so a plain `!=` filter would silently
      // exclude NULL rows and leave them stuck forever.
      const claimed = await db('call_log')
        .where({ twilio_call_sid: callSid })
        .whereRaw("processing_status IS DISTINCT FROM 'processed'")
        .where(function () {
          this.whereRaw("processing_status IS DISTINCT FROM 'processing'")
            .orWhereRaw("COALESCE(processing_started_at, updated_at) < NOW() - INTERVAL '10 minutes'");
        })
        .update({ processing_status: 'processing', processing_token: procToken, processing_started_at: new Date(), updated_at: new Date() });
      if (claimed === 0) {
        logger.info(`[call-proc] Concurrent run detected for ${callSid} — skipping`);
        return { success: true, skipped: true, reason: 'already_processing' };
      }
    } else {
      // force=true bypasses the early-exit on 'processed' rows so admin
      // Reprocess can re-run extraction. It must NOT bypass an actively-
      // processing peer — CallRecordingsPanel.jsx always sends force:true,
      // so without this guard a force click on a row mid-flight would
      // overwrite the peer's processing_token, breaking the peer's
      // catch-block fence and wedging the row at 'processing' forever
      // (the very bug processing_token was added to prevent).
      //
      // Use the same atomic claim as the non-force path, minus the
      // exclude-'processed' filter: in-flight peers (and not-yet-stale
      // 'processing' rows) still block; everything else flows through.
      // Same IS DISTINCT FROM rationale as the non-force claim above: NULL
      // processing_status must pass so a force-reprocess on a never-claimed
      // row can take the lock.
      const claimed = await db('call_log')
        .where({ twilio_call_sid: callSid })
        .where(function () {
          this.whereRaw("processing_status IS DISTINCT FROM 'processing'")
            .orWhereRaw("COALESCE(processing_started_at, updated_at) < NOW() - INTERVAL '10 minutes'");
        })
        .update({ processing_status: 'processing', processing_token: procToken, processing_started_at: new Date(), updated_at: new Date() });
      if (claimed === 0) {
        logger.info(`[call-proc] Force run blocked by in-flight peer for ${callSid} — skipping`);
        return { success: true, skipped: true, reason: 'already_processing' };
      }
    }

    logger.info(`[call-proc] Processing recording for ${callSid}`);

    // Outer guard: any unhandled throw between the claim above and the
    // terminal-status writes below would otherwise wedge the row in
    // processing_status='processing' until the 10-min stale reclaim. Release
    // the lock to a recoverable terminal state so manual retry works
    // immediately and the real error reaches the caller.
    try {
    const contactPhone = resolveCallContactPhone(call);
    // Forwarding-masked call: the inbound leg recorded one of our own internal
    // numbers (a tracking number, or the staff cell it forwarded to) as the caller,
    // so there's no recoverable external contact. We still transcribe/extract + log
    // the call, but won't key a lead/customer on the masked number (that's what
    // created the phantom "collapsed" leads).
    if (!contactPhone && !isOutboundCall(call) && TWILIO_NUMBERS.isInternalNumber(call.from_phone)) {
      logger.warn(`[call-proc] ${maskSid(callSid)}: caller ID is an internal Waves number (${maskPhone(call.from_phone)}) — forwarding-masked; no lead/customer will be keyed on it`);
    }

    // Guard against a pre-linked PHANTOM customer. The voice webhook (and the
    // recording-status orphan insert) auto-links an inbound row to a customer by the
    // From number; a prior forwarding-masked call created phantom customers whose
    // phone IS one of our internal numbers. Honoring that link would re-collapse
    // many callers onto the phantom and spawn a lead/appointment on it — the exact
    // failure this fix exists to stop, and one resolveCallContactPhone alone can't
    // prevent because processRecording seeds customerId from call.customer_id below.
    // Only inbound legs whose From is itself internal can carry such a link (that's
    // how the phantom got matched), so the DB lookup is skipped on normal calls.
    // Clearing call.customer_id here also stops the call_log / candidate-staging
    // fallbacks (customerId || call.customer_id) from resurrecting the phantom; the
    // call then falls through to real phone-based resolution, or stays unkeyed when
    // fully masked. (Cleanup of the already-created phantom rows is handled separately.)
    if (call.customer_id && !isOutboundCall(call) && TWILIO_NUMBERS.isInternalNumber(call.from_phone)) {
      const linked = await db('customers').where({ id: call.customer_id }).select('phone').first().catch(() => null);
      if (linked && TWILIO_NUMBERS.isInternalNumber(linked.phone)) {
        logger.warn(`[call-proc] ${maskSid(callSid)}: pre-linked customer ${call.customer_id} is keyed on an internal number (${maskPhone(linked.phone)}) — phantom from forwarding-masked linking; treating call as unlinked`);
        call.customer_id = null;
        // Persist the unlink now, not just in memory: the terminal early exits
        // below (no_transcription / extraction_failed / spam / voicemail / v2
        // hard veto) write processing_status without touching customer_id, so an
        // in-memory-only clear would leave the phantom link on the row for any
        // call that takes one of those paths. The happy path re-stamps the real
        // resolved customer in Step 4 (customer_id: customerId || call.customer_id).
        await db('call_log').where({ id: call.id }).update({ customer_id: null, updated_at: new Date() });
      }
    }

    // Step 1: Transcribe — OpenAI is the source of record. Gemini and Twilio are fallbacks only.
    let transcription = null;
    let transcriptionProvenance = null;
    // Dictation-focused second-pass transcript (promptable model) — evidence
    // for the contact-field decoder below, never the displayed transcript.
    let contactPassTranscript = null;

    if (call.recording_url) {
      const result = await transcribeRecording(call.recording_url, { call, contactPhone });
      transcription = result.transcription;
      contactPassTranscript = result.contactPassTranscript || null;
      if (transcription) {
        transcriptionProvenance = {
          provider: result.provider || null,
          model: result.model || null,
          metadata: {
            ...(result.metadata || {}),
            provider: result.provider || null,
            model: result.model || null,
            transcript_chars: transcription.length,
            recording_url_present: !!call.recording_url,
          },
        };
        const transcriptUpdate = {
          transcription,
          transcription_status: 'completed',
          transcription_provider: transcriptionProvenance.provider,
          transcription_model: transcriptionProvenance.model,
          transcription_metadata: JSON.stringify(transcriptionProvenance.metadata),
          updated_at: new Date(),
        };
        if (result.structuredSegments || contactPassTranscript) {
          transcriptUpdate.transcript_structured = JSON.stringify({
            provider: result.provider,
            model: result.model || OPENAI_TRANSCRIPTION_MODEL,
            segments: result.structuredSegments || null,
            // Audit trail for the contact-field decoder's second evidence
            // stream (dictation-focused re-transcription of the same audio).
            ...(contactPassTranscript ? { contact_pass_transcript: contactPassTranscript } : {}),
          });
        }
        await db('call_log').where({ id: call.id }).update(transcriptUpdate);
        await updateUnifiedVoiceMessage(
          { ...call, transcription },
          { body: transcription }
        );
        logger.info(`[call-proc] ${result.provider} transcription complete: ${transcription.length} chars`);
      }
    }

    // Fallback: use Twilio's built-in transcription if OpenAI/Gemini failed or no recording URL
    if (!transcription) {
      const freshCall = await db('call_log').where('twilio_call_sid', callSid).select('transcription').first();
      if (freshCall?.transcription) {
        transcription = freshCall.transcription;
        transcriptionProvenance = {
          provider: 'twilio_builtin',
          model: null,
          metadata: {
            provider: 'twilio_builtin',
            fallback_reason: 'openai_gemini_unavailable',
            transcript_chars: transcription.length,
            source: 'fresh_call_log',
          },
        };
        await db('call_log').where({ id: call.id }).update({
          transcription_provider: transcriptionProvenance.provider,
          transcription_model: null,
          transcription_metadata: JSON.stringify(transcriptionProvenance.metadata),
          updated_at: new Date(),
        });
        logger.info(`[call-proc] OpenAI/Gemini unavailable - falling back to Twilio transcription: ${transcription.length} chars`);
      } else if (call.transcription) {
        transcription = call.transcription;
        transcriptionProvenance = {
          provider: 'twilio_builtin',
          model: null,
          metadata: {
            provider: 'twilio_builtin',
            fallback_reason: 'cached_transcription',
            transcript_chars: transcription.length,
            source: 'cached_call_log',
          },
        };
        await db('call_log').where({ id: call.id }).update({
          transcription_provider: transcriptionProvenance.provider,
          transcription_model: null,
          transcription_metadata: JSON.stringify(transcriptionProvenance.metadata),
          updated_at: new Date(),
        });
        logger.info(`[call-proc] OpenAI/Gemini unavailable - using cached Twilio transcription: ${transcription.length} chars`);
      }
    }
    if (transcription) {
      await updateUnifiedVoiceMessage(
        { ...call, transcription },
        { body: transcription }
      );
    }

    if (!transcription) {
      logger.warn(`[call-proc] No transcription available for ${callSid}`);
      await db('call_log').where({ id: call.id }).update({
        processing_status: 'no_transcription',
        processing_token: null,
        processing_started_at: null,
        updated_at: new Date(),
      });
      return { success: false, error: 'No transcription available' };
    }

    // Step 2: AI extraction
    // Resolve a lightweight known-caller hint FIRST (read-only, phone-only) so the
    // classifier knows whether it's talking to an existing customer. This does NOT
    // change the canonical customer resolution in Step 3 below — it only gives the
    // model the context to tell a new-prospect lead apart from an existing customer
    // coordinating a visit, complaining, or asking about billing.
    let knownCaller = null;
    try {
      const knownCustomer = await findCustomerForCallContact(contactPhone, {});
      knownCaller = summarizeKnownCaller(knownCustomer);
    } catch (e) {
      logger.warn(`[call-proc] known-caller pre-lookup skipped for ${maskSid(callSid)}: ${e.message}`);
    }

    // Bookable service catalog: fed to both extraction prompts (so the model
    // can name a specific bookable service) and to the booking block below
    // (service_id / price / duration / follow-up interval). Fails open to [].
    const bookableCallServices = await loadBookableCallServices(db);
    const bookableServiceNames = bookableCallServices.map((s) => s.name).filter(Boolean);
    // Catalog-aware provenance: the catalog block is part of the rendered
    // V2 prompt, so every stamp for this call must carry its hash.
    const v2PromptVersion = extractionPromptVersion(bookableServiceNames);

    let extracted;
    try {
      extracted = await extractCallData(transcription, contactPhone, { callStartedAt: call.created_at, knownCaller, bookableServiceNames });
    } catch (err) {
      logger.error(`[call-proc] AI extraction failed: ${err.message}`);
      await db('call_log').where({ id: call.id }).update({
        processing_status: 'extraction_failed',
        processing_token: null,
        processing_started_at: null,
        updated_at: new Date(),
      });
      return { success: false, error: `AI extraction failed: ${err.message}` };
    }

    // ── Shadow v2 extraction (records alongside v1, no side effects) ──
    let v2Result = null;
    let v2AddressValidation = null;
    if (CALL_EXTRACTION_V2_ENABLED) {
      try {
        v2Result = await extractCallDataV2(transcription, contactPhone, {
          callStartedAt: call.created_at,
          callId: call.id,
          bookableServiceNames,
          knownCaller,
        });
        // Address validation runs in shadow on every valid extraction (no-ops
        // instantly when ADDRESS_VALIDATION_ENABLED is off), so the verdict is
        // recorded for the promotion-readiness gate and reused by the routing
        // gate below without a second API call.
        if (v2Result?.status === 'valid' && v2Result.extraction) {
          try {
            v2AddressValidation = await validateAddress({
              addressLines: buildAddressLines(v2Result.extraction.property?.service_address),
            });
          } catch (avErr) {
            logger.warn(`[call-proc-v2] address validation error for ${callSid}: ${avErr.message}`);
            v2AddressValidation = { status: 'api_unavailable', error: avErr.message };
          }
        }
        const v2Update = {
          ai_extraction_enriched: v2Result.extraction ? JSON.stringify(v2Result.extraction) : null,
          ai_extraction_validation_errors: v2Result.errors ? JSON.stringify(v2Result.errors) : null,
          ai_address_validation: v2AddressValidation ? JSON.stringify(v2AddressValidation) : null,
          v2_extraction_status: v2Result.status,
          ai_extraction_model: GEMINI_EXTRACTION_MODEL,
          ai_extraction_prompt_version: v2PromptVersion,
          updated_at: new Date(),
        };
        await db('call_log').where({ id: call.id }).update(v2Update);
        logger.info(`[call-proc-v2] Shadow extraction stored for ${callSid}: status=${v2Result.status}`);
      } catch (err) {
        logger.error(`[call-proc-v2] Shadow extraction failed for ${callSid}: ${err.message}`);
        // Stamp provenance even on a thrown exception so this failure is
        // attributable to the current extractor — otherwise the promotion
        // readiness gate (which scopes by model+prompt) silently drops
        // current-deploy crashes from the schema-pass denominator.
        await db('call_log').where({ id: call.id }).update({
          v2_extraction_status: 'parse_failed',
          ai_extraction_validation_errors: JSON.stringify([{ message: err.message }]),
          ai_extraction_model: GEMINI_EXTRACTION_MODEL,
          ai_extraction_prompt_version: v2PromptVersion,
          updated_at: new Date(),
        });
      }
    }

    // ── Voicemail routing ──
    // Voicemail detection is deterministic-first: the voice webhook stamps
    // answered_by/call_outcome='voicemail' on call_log when the caller hit the
    // voicemail <Record> path (twilio-voice-webhook.js resolveInboundDialCompletion),
    // so OR that signal with the model's is_voicemail flag. Model-only detection
    // was inconsistent — some voicemails slipped through as live calls and minted
    // partial-data customers, others were dropped entirely.
    const voicemailChannel = !!(
      extracted.is_voicemail
      || call.answered_by === 'voicemail'
      || call.call_outcome === 'voicemail'
    );
    if (voicemailChannel) extracted.is_voicemail = true;

    // A voicemail from a NEW prospect with a callback number and concrete
    // service intent is a workable lead, not a skip: it continues into the
    // normal pipeline and lands as a customer-less UNqualified Needs-Review
    // lead (Step 4b). Customer creation stays hard-off for voicemails (Step 3
    // create branch gates on !is_voicemail), so a mangled voicemail
    // transcription can never mint a partial-data customer. Existing-customer
    // voicemails keep today's behavior: terminal 'voicemail' status, no lead —
    // a normal missed call the office sees in the comms inbox.
    // The content veto for voicemails keys on the content TYPE only. A stale
    // model output can keep the legacy `call_type='voicemail', is_lead=false`
    // shape even when it extracted a concrete requested service, and that
    // boolean must not out-vote deterministic service intent on exactly the
    // channel this path exists to recover (isNonLeadCallContent would veto on
    // it). Real non-lead content — billing, complaint, existing-customer
    // scheduling/service, wrong number — still vetoes.
    const voicemailContentVeto = NON_LEAD_CALL_TYPES.has(
      String(extracted?.call_type || '').trim().toLowerCase()
    );
    let voicemailLeadPath = false;
    if (voicemailChannel && !extracted.is_spam && !isOutboundCall(call) && !voicemailContentVeto) {
      const vmPhone = resolveCallContactPhone(call, extracted.phone);
      if (vmPhone && hasWorkableLeadSignal({ extracted, phone: vmPhone, voicemail: true })) {
        const vmCustomer = call.customer_id
          ? { id: call.customer_id }
          : await findCustomerForCallContact(vmPhone, extracted).catch(() => null);
        voicemailLeadPath = !vmCustomer;
      }
    }
    if (voicemailLeadPath && extracted.is_lead === false) {
      // Reconcile the stale legacy shape so every downstream consumer (the
      // Step 4b nonLeadCall gate, the ai_triage stamp, route decisions) sees
      // what the deterministic signals decided: channel voicemail + callback
      // number + concrete service intent IS a lead. Without this, the same
      // stale boolean that the gate above ignores would re-veto lead creation
      // via isNonLeadCallContent at shouldCreateLead.
      extracted.is_lead = true;
      const staleType = String(extracted.call_type || '').trim().toLowerCase();
      if (!staleType || staleType === 'voicemail' || staleType === 'other') {
        extracted.call_type = 'new_inquiry';
      }
    }

    // Skip spam and non-workable voicemail
    if (extracted.is_spam || (voicemailChannel && !voicemailLeadPath)) {
      await writeLegacyShadowRouteDecision({
        call,
        extracted,
        customerId: call.customer_id || null,
        finalStatus: extracted.is_spam ? 'spam' : 'voicemail',
      });
      const terminalUpdate = {
        ai_extraction: JSON.stringify(extracted),
        processing_status: extracted.is_spam ? 'spam' : 'voicemail',
        processing_token: null,
        processing_started_at: null,
        updated_at: new Date(),
      };
      if (extracted.is_voicemail) {
        terminalUpdate.answered_by = 'voicemail';
        terminalUpdate.call_outcome = 'voicemail';
      }
      await db('call_log').where({ id: call.id }).update(terminalUpdate);
      await updateUnifiedVoiceMessage(
        {
          ...call,
          transcription,
          answered_by: extracted.is_voicemail ? 'voicemail' : call.answered_by,
        },
        {
          body: transcription,
          answered_by: extracted.is_voicemail ? 'voicemail' : call.answered_by || null,
        }
      );
      logger.info(`[call-proc] Skipping ${callSid}: ${extracted.is_spam ? 'spam' : 'voicemail'}`);
      return { success: true, skipped: true, reason: extracted.is_spam ? 'spam' : 'voicemail' };
    }

    if (voicemailChannel) {
      // Workable voicemail continuing to lead creation: stamp the channel on
      // the call log NOW (non-terminal — the row stays claimed as 'processing')
      // so the call reads as a voicemail even if a later step fails, and mirror
      // it to the unified inbox thread exactly like the skip path does.
      await db('call_log').where({ id: call.id }).update({
        answered_by: 'voicemail',
        call_outcome: 'voicemail',
        updated_at: new Date(),
      });
      await updateUnifiedVoiceMessage(
        { ...call, transcription, answered_by: 'voicemail' },
        { body: transcription, answered_by: 'voicemail' }
      );
      logger.info(`[call-proc] Voicemail ${callSid} has workable lead signal — continuing to lead creation`);
    }

    // ── V2 routing gate — evaluated BEFORE canonical customer/lead writes ──
    // Hard vetoes (spam / out-of-area / do-not-contact) skip all canonical
    // writes. Soft blocks (not_confirmed, ambiguous, hoa, etc.) are real
    // prospects: customer + lead are still created, only the appointment is
    // suppressed. Approved calls capture v2's validated scheduling fields so
    // the appointment is created from the data the gate actually checked.
    let v2RoutingBlocked = false;
    let v2SmsBlocked = false;
    let v2EmailBlocked = false;
    let v2CanonicalWriteBlocked = false;
    let v2ApprovedExtraction = null;
    // Address/identity bridge (populated below in shadow mode): "confirm before
    // dispatch" reasons that flag the call for a human without blocking writes.
    const bridgeNeedsConfirmation = [];

    // ── Contact-field dictation decoder (runs in EVERY mode, BEFORE the
    // routing gate so enforce mode benefits too) ──────────────────────────
    // The transcript is EVIDENCE, not the source of truth for dictated
    // emails/addresses: a purpose-built decoder pass reads the diarized
    // transcript plus the dictation-focused second-pass transcript and emits
    // normalized CANDIDATES with confidence + a ready-to-read confirmation
    // question. Exactly one strong, validated email candidate is adopted
    // (behind the same cross-customer ownership gate as the domain-typo
    // correction); anything ambiguous rides the review card — and if the
    // primary extraction already stored an email from that same ambiguous
    // dictation, it is DEMOTED to email_raw so no write/send path can use a
    // value the decoder could not confirm. Street alternatives feed the
    // address-recovery lookup below. Fail-open.
    let contactDictation = null;
    let dictationEmailPayload = null;
    try {
      if (transcription && (contactPassTranscript || detectContactDictationSignals(transcription).any)) {
        contactDictation = await decodeDictatedContacts({ transcript: transcription, contactPassTranscript });
      }
      if (contactDictation) {
        const emailDecision = applyEmailDictationPolicy({ extracted, dictation: contactDictation });
        dictationEmailPayload = emailDecision.payload;
        if (emailDecision.adopt) {
          // Same ownership gate as the domain-typo adoption in the bridge: a
          // decoded email already on file for ANOTHER contact is never
          // auto-adopted onto this caller (fails closed). email_raw keeps the
          // rejected as-transcribed value as evidence.
          const ownCustomerId = call.customer_id
            || (await findCustomerForCallContact(contactPhone, extracted).catch(() => null))?.id
            || null;
          const ownedElsewhere = await require('./email-bounce-recovery')
            .correctedAddressOwnedByOther(emailDecision.adopt, ownCustomerId)
            .catch(() => true);
          if (!ownedElsewhere) {
            extracted.email = emailDecision.adopt;
            logger.info(`[call-proc-dictation] Adopted decoded dictated email for ${maskSid(callSid)}`);
          } else {
            logger.info(`[call-proc-dictation] Skipped decoded email — on file for another contact (${maskSid(callSid)})`);
          }
        } else if (emailDecision.hold && extracted.email) {
          // Quarantine: the stored email came from dictation the decoder
          // could not confirm (ambiguous / risk-flagged) — demote it before
          // the customer/lead upserts and first-touch sends read it.
          if (!extracted.email_raw) extracted.email_raw = extracted.email;
          extracted.email = null;
          logger.info(`[call-proc-dictation] Demoted unconfirmed dictated email to email_raw for ${maskSid(callSid)}`);
        }
      }
    } catch (dictationErr) {
      logger.warn(`[call-proc-dictation] decoder skipped for ${maskSid(callSid)}: ${dictationErr.message}`);
    }

    // ── Garbled-street recovery (every mode; consumed by BOTH gates) ─────
    // Runs before the routing gate: in enforce mode a recovered street must
    // reach canAutoRoute as the validated verdict it is, or the very garble
    // this feature fixes would still block routing and persist raw.
    const rawStreetBeforeAdopt = extracted.address_line1 || null;
    let addressRecovery = null;
    if (v2AddressValidation && RECOVERABLE_STATUSES.has(v2AddressValidation.status)) {
      addressRecovery = await recoverStreetAddress({
        extracted,
        avStatus: v2AddressValidation.status,
        // Street re-hearings the contact-dictation decoder already produced
        // from BOTH transcripts — tried before recovery spends its own
        // phonetic model call.
        extraStreetCandidates: contactDictation?.addresses?.[0]?.street_alternatives || [],
      }).catch(() => null);
    }
    // The winning recovery candidate passed Address Validation itself, so the
    // ENFORCE gate consumes that verdict (validated_accept/corrected) instead
    // of the original unresolvable one. The persisted ai_address_validation
    // shadow row keeps the ORIGINAL verdict; the shadow bridge also receives
    // the original + the recovery result and applies its own adoption rule.
    const effectiveAddressValidation = (addressRecovery?.recovered && addressRecovery.avResult)
      ? addressRecovery.avResult
      : v2AddressValidation;

    if (CALL_EXTRACTION_V2_DRIVES_ROUTING && CALL_EXTRACTION_V2_ENABLED) {
      try {
        const v2Extraction = v2Result?.extraction || null;
        const v2Valid = v2Result?.status === 'valid' && v2Extraction && isV2Extraction(v2Extraction);

        if (!v2Valid) {
          // Fail closed: block appointment + triage, but keep customer/lead
          // (call may be a real lead the validator simply couldn't validate).
          v2RoutingBlocked = true;
          const failReason = v2Result?.status || 'not_run';
          const failTriageItem = buildTriageItem({
            callLogId: call.id,
            flag: `v2_extraction_${failReason}`,
            extraction: v2Extraction || { meta: { call_summary: 'V2 extraction unavailable; fail-closed to triage' } },
          });
          await db('triage_items').insert(failTriageItem).onConflict(db.raw('(call_log_id, reason_code) WHERE status IN (\'open\', \'in_progress\')')).ignore();
          logger.warn(`[call-proc-v2] Fail-closed for ${callSid}: v2_extraction_status=${failReason}`);
        } else {
          const addressValidation = effectiveAddressValidation;
          const routingResult = canAutoRoute(v2Extraction, { contactPhone, addressValidation });
          const deterministicFlags = computeDeterministicTriageFlags(v2Extraction, { contactPhone, addressValidation });
          // Strip model address flags too when AV accepted/corrected — otherwise
          // a stale model out_of_service_area would hard-veto a verified address.
          const modelFlags = suppressAddressFlagsForAV(v2Extraction.triage_flags, addressValidation);
          const finalFlags = mergeTriageFlags(modelFlags, deterministicFlags);
          const tcpa = checkTcpaConsent(v2Extraction);
          v2SmsBlocked = !tcpa.canSms;
          v2EmailBlocked = !tcpa.canEmail;

          const routeDecision = buildRouteDecision({
            callLogId: call.id,
            extraction: v2Extraction,
            finalTriageFlags: finalFlags,
            routingResult,
            action: routingResult.allowed ? 'auto_route' : 'triage_review',
            mode: 'enforce',
          });
          await db('route_decisions').insert(routeDecision).onConflict(['call_log_id', 'decision_version', 'mode']).ignore();

          // Advisory flags (missing surname / rental / second address) reach the
          // Needs Review inbox even when the call AUTO-ROUTES — they inform, they
          // don't block. Without this, promoting DRIVES_ROUTING would silence the
          // identity signals the shadow bridge used to surface. onConflict dedups
          // against the blocked-branch inserts below.
          for (const flag of finalFlags.filter((f) => ADVISORY_TRIAGE_FLAGS.has(f)).slice(0, 10)) {
            await db('triage_items')
              .insert(buildTriageItem({ callLogId: call.id, flag, extraction: v2Extraction, severity: 'advisory' }))
              .onConflict(db.raw('(call_log_id, reason_code) WHERE status IN (\'open\', \'in_progress\')'))
              .ignore();
          }

          // A recovered street auto-routes on the recovered verdict above, but
          // the read-back reminder must still reach the Needs Review inbox —
          // the office confirms the corrected street with the caller before
          // the visit, exactly like the shadow bridge surfaces it.
          if (addressRecovery?.recovered) {
            await db('triage_items')
              .insert(buildTriageItem({
                callLogId: call.id,
                flag: 'address_recovered',
                extraction: v2Extraction,
                severity: 'advisory',
                extraPayload: {
                  address_as_heard: rawStreetBeforeAdopt,
                  address_recovered: addressRecovery.recovered.address_line1,
                  address_candidates: addressRecovery.candidates || [],
                  recovery_method: addressRecovery.method || null,
                  ...(contactDictation?.addresses?.[0]?.confirmation_question
                    ? { confirmation_question: contactDictation.addresses[0].confirmation_question } : {}),
                },
              }))
              .onConflict(db.raw('(call_log_id, reason_code) WHERE status IN (\'open\', \'in_progress\')'))
              .ignore();
            bridgeNeedsConfirmation.push('address_recovered');
          }

          if (!routingResult.allowed) {
            // Prefer the flags that actually BLOCK the appointment. When none do
            // (the block came from a non-flag reason like low_confidence /
            // not_confirmed / confirmed_without_start_time), finalFlags may hold
            // only advisory flags — so fall back to routingResult.reason instead
            // of letting the Needs Review row explain only the advisory note and
            // hide why the call was actually held. (Advisory flags get their own
            // rows from the advisory loop above.)
            const blockingReasons = (routingResult.appointmentBlockingFlags && routingResult.appointmentBlockingFlags.length)
              ? routingResult.appointmentBlockingFlags
              : [routingResult.reason || 'routing_rejected'];
            const triageReasons = blockingReasons;
            for (const flag of triageReasons.slice(0, 10)) {
              const triageItem = buildTriageItem({ callLogId: call.id, flag, extraction: v2Extraction });
              await db('triage_items').insert(triageItem).onConflict(db.raw('(call_log_id, reason_code) WHERE status IN (\'open\', \'in_progress\')')).ignore();
            }
            v2RoutingBlocked = true;
            v2CanonicalWriteBlocked = hasCanonicalWriteBlock(finalFlags);
            logger.info(`[call-proc-v2] Routing blocked for ${callSid}: ${triageReasons.join(', ')}${v2CanonicalWriteBlocked ? ' (canonical-write veto)' : ''}`);
          } else {
            // Approved. When AV accepted or corrected the address, dispatch on
            // Google's normalized address (e.g. the corrected zip), not the
            // caller's raw input. The gate already cleared the address flags;
            // this makes the appointment use the address the gate trusted.
            // CRITICAL: also write the corrected address into `extracted` HERE,
            // before the customer/lead upsert below reads extracted.* — otherwise
            // the saved customer record keeps the uncorrected address even though
            // the gate auto-routed on the corrected one.
            if (addressValidation?.normalized
              && (addressValidation.status === 'validated_accept' || addressValidation.status === 'corrected')) {
              const n = addressValidation.normalized;
              v2Extraction.property = v2Extraction.property || {};
              v2Extraction.property.service_address = {
                ...(v2Extraction.property.service_address || {}),
                ...(n.street_line_1 ? { street_line_1: n.street_line_1 } : {}),
                ...(n.city ? { city: n.city } : {}),
                ...(n.state ? { state: n.state } : {}),
                ...(n.postal_code ? { postal_code: n.postal_code } : {}),
                ...(addressValidation.county ? { county: addressValidation.county } : {}),
              };
              if (n.street_line_1) extracted.address_line1 = n.street_line_1;
              if (n.city) extracted.city = n.city;
              if (n.state) extracted.state = n.state;
              if (n.postal_code) extracted.zip = n.postal_code;
            }
            v2ApprovedExtraction = v2Extraction;
          }
        }
      } catch (err) {
        // Fail closed (soft): hold only the appointment for triage. No TCPA/DNC
        // decision was made here, so do NOT suppress SMS/email follow-up — the
        // call may be a real lead and email/newsletter should still proceed.
        logger.error(`[call-proc-v2] Routing gate error for ${callSid}: ${err.message} — failing closed (appointment only)`);
        v2RoutingBlocked = true;
        try {
          const failTriageItem = buildTriageItem({
            callLogId: call.id,
            flag: 'v2_gate_exception',
            extraction: { meta: { call_summary: `V2 routing gate threw exception: ${err.message}` } },
          });
          await db('triage_items').insert(failTriageItem).onConflict(db.raw('(call_log_id, reason_code) WHERE status IN (\'open\', \'in_progress\')')).ignore();
        } catch (triageErr) {
          logger.error(`[call-proc-v2] Triage insert also failed for ${callSid}: ${triageErr.message}`);
        }
      }
    }

    // ── Address-validation bridge (shadow mode only) ─────────────────────
    // When V2 is enabled but NOT yet driving routing, the Google Address
    // Validation verdict (v2AddressValidation) is computed on every call but
    // otherwise ignored by the live write. Consume just that verdict here — no
    // appointment/routing changes — so the legacy customer/lead write stops
    // silently persisting an unverifiable address as if it were clean:
    //   • validated_accept / corrected → adopt Google's normalized address
    //     (auto-fixes a bad ZIP/street), mirroring the enforce-path approval
    //     branch above. Mutated into `extracted` BEFORE the customer/lead
    //     upsert reads it, so both records get the corrected address.
    //   • missing_component / ambiguous / confirm_needed / out_of_service_area
    //     (a street WAS given) → keep the raw address but record a needs-
    //     confirmation reason so the call is flagged for a human.
    // Plus two identity signals on real prospects: caller-arranging-for-someone-
    // else and a missing surname. When DRIVES_ROUTING is later promoted the full
    // gate above owns all of this, so this bridge is guarded off then.
    if (CALL_EXTRACTION_V2_ENABLED && !CALL_EXTRACTION_V2_DRIVES_ROUTING) {
      try {
        const v2Ext = v2Result?.extraction || null;
        // Merge deterministic caller-authorization flags so `caller_not_authorized`
        // (caller.on_site_authorization === false + non-owner) is caught even when
        // the model omits the redundant triage_flag — matching the enforce gate.
        let bridgeTriageFlags = Array.isArray(v2Ext?.triage_flags) ? v2Ext.triage_flags : [];
        if (v2Ext && isV2Extraction(v2Ext)) {
          try {
            bridgeTriageFlags = mergeTriageFlags(
              bridgeTriageFlags,
              computeDeterministicTriageFlags(v2Ext, { contactPhone, addressValidation: v2AddressValidation })
            );
          } catch (_e) { /* fall back to model flags only */ }
        }
        // addressRecovery + rawStreetBeforeAdopt were computed above the
        // routing gate (shared with enforce mode); the bridge receives the
        // ORIGINAL AV verdict plus the recovery result and applies its own
        // exactly-one-confirmed-premise adoption rule.
        const { normalizedAddress, normalizedEmail, needsConfirmation } = deriveCallReviewBridge({
          addressValidation: v2AddressValidation,
          extracted,
          v2TriageFlags: bridgeTriageFlags,
          callerRelationship: v2Ext?.caller?.relationship_to_property,
          addressRecovery,
        });
        // Decoder-only email evidence: when the primary extraction captured
        // NO email (empty email + email_raw) the bridge's email review stays
        // silent, which would drop the decoder's candidates/question on the
        // floor — exactly the malformed dictation this pass quarantines.
        // Force a read-back reason so the triage item (with payload) exists.
        if (dictationEmailPayload
            && !needsConfirmation.includes('email_unverified')
            && !needsConfirmation.includes('email_invalid')) {
          needsConfirmation.push(dictationEmailPayload.email_candidates.length ? 'email_unverified' : 'email_invalid');
        }
        if (normalizedAddress) {
          // Adopt Google's normalized address BEFORE the customer/lead upsert
          // reads extracted.* below, so both records get the corrected address.
          if (normalizedAddress.address_line1) extracted.address_line1 = normalizedAddress.address_line1;
          if (normalizedAddress.city) extracted.city = normalizedAddress.city;
          if (normalizedAddress.state) extracted.state = normalizedAddress.state;
          if (normalizedAddress.zip) extracted.zip = normalizedAddress.zip;
          if (v2AddressValidation?.status === 'corrected') {
            logger.info(`[call-proc-bridge] Adopted Google-corrected address for ${maskSid(callSid)}`);
          }
          if (needsConfirmation.includes('address_recovered')) {
            logger.info(`[call-proc-bridge] Recovered garbled street via ${addressRecovery?.method} for ${maskSid(callSid)}`);
          }
        }
        if (normalizedEmail) {
          // Same adopt-before-upsert contract as the address above: fix the
          // high-confidence domain typo before the customer/lead writes and the
          // first-touch emails (newsletter confirmation, lead response) read
          // extracted.email — catching at intake what bounce-recovery would
          // otherwise have to repair after a bounce. Ownership gate mirrors
          // bounce-recovery's rule: a corrected address already on file for
          // ANY contact is never auto-adopted onto this caller (a same-person
          // caller already has it on their own record; a different person
          // would receive the new lead's first-touch email). Fails closed.
          // No address value in the log.
          // The caller's own customer id exempts their own on-file email from
          // the ownership gate. call.customer_id may be unresolved here even
          // for a known customer (shared caller phone → Step 3 reconciles by
          // name later), so fall back to the same phone/name resolution Step 3
          // uses before treating the correction as another party's.
          const ownCustomerId = call.customer_id
            || (await findCustomerForCallContact(contactPhone, extracted).catch(() => null))?.id
            || null;
          const ownedElsewhere = await require('./email-bounce-recovery')
            .correctedAddressOwnedByOther(normalizedEmail, ownCustomerId)
            .catch(() => true);
          if (!ownedElsewhere) {
            extracted.email = normalizedEmail;
            logger.info(`[call-proc-bridge] Adopted high-confidence email domain correction for ${maskSid(callSid)}`);
          } else {
            logger.info(`[call-proc-bridge] Skipped email domain correction — corrected address on file for another contact (${maskSid(callSid)})`);
          }
        }
        if (needsConfirmation.length) {
          bridgeNeedsConfirmation.push(...needsConfirmation);
          logger.info(`[call-proc-bridge] ${callSid} needs confirmation: ${needsConfirmation.join(', ')} (av=${v2AddressValidation?.status || 'n/a'})`);
          // Surface in the Needs Review inbox, which is driven by triage_items
          // rows (admin-triage.js filters by status), not call_log.review_status.
          // Shadow mode does not block the write -> severity 'advisory'.
          for (const flag of needsConfirmation.slice(0, 10)) {
            try {
              // Address/email flags carry the correction evidence so the
              // Needs Review card can show "heard X → matched Y" plus the
              // candidate list and the exact question to ask, instead of a
              // bare "could not be verified".
              const isAddressFlag = flag === 'address_unverified' || flag === 'address_recovered';
              const isEmailFlag = flag === 'email_unverified' || flag === 'email_invalid';
              await db('triage_items')
                .insert(buildTriageItem({
                  callLogId: call.id,
                  flag,
                  extraction: v2Result?.extraction || { meta: { call_summary: extracted.call_summary || null } },
                  severity: 'advisory',
                  extraPayload: (isAddressFlag && addressRecovery?.attempted) ? {
                    address_as_heard: rawStreetBeforeAdopt,
                    address_recovered: flag === 'address_recovered' ? extracted.address_line1 : null,
                    address_candidates: addressRecovery.candidates || [],
                    recovery_method: addressRecovery.method || null,
                    ...(contactDictation?.addresses?.[0]?.confirmation_question
                      ? { confirmation_question: contactDictation.addresses[0].confirmation_question } : {}),
                  } : (isEmailFlag ? dictationEmailPayload : null),
                }))
                .onConflict(db.raw('(call_log_id, reason_code) WHERE status IN (\'open\', \'in_progress\')'))
                .ignore();
            } catch (triageErr) {
              logger.warn(`[call-proc-bridge] triage_items insert failed for ${maskSid(callSid)}: ${triageErr.message}`);
            }
          }
        }
      } catch (bridgeErr) {
        logger.warn(`[call-proc-bridge] address/identity bridge skipped for ${maskSid(callSid)}: ${bridgeErr.message}`);
      }
    } else {
      // Enforce-mode (DRIVES_ROUTING) / V2-off fallback: the shadow bridge
      // above owns email hygiene when it runs, but first-touch sends read
      // extracted.email in EVERY mode — the domain-typo correction and the
      // read-back reasons must not be shadow-only. Advisory only, never
      // blocks the pipeline.
      try {
        const { normalizedEmail: correctedEmail, needsConfirmation: emailReasons } = deriveEmailReview(extracted);
        // Same decoder-only fallback as the shadow branch: dictation evidence
        // with no extracted email must still open a read-back triage item.
        if (dictationEmailPayload
            && !emailReasons.includes('email_unverified')
            && !emailReasons.includes('email_invalid')) {
          emailReasons.push(dictationEmailPayload.email_candidates.length ? 'email_unverified' : 'email_invalid');
        }
        if (correctedEmail) {
          // Same ownership gate as the shadow-bridge site above (fails closed),
          // with the same phone/name fallback for a not-yet-linked known caller.
          const ownCustomerId = call.customer_id
            || (await findCustomerForCallContact(contactPhone, extracted).catch(() => null))?.id
            || null;
          const ownedElsewhere = await require('./email-bounce-recovery')
            .correctedAddressOwnedByOther(correctedEmail, ownCustomerId)
            .catch(() => true);
          if (!ownedElsewhere) {
            extracted.email = correctedEmail;
            logger.info(`[call-proc] Adopted high-confidence email domain correction for ${maskSid(callSid)}`);
          } else {
            logger.info(`[call-proc] Skipped email domain correction — corrected address on file for another contact (${maskSid(callSid)})`);
          }
        }
        if (emailReasons.length) {
          bridgeNeedsConfirmation.push(...emailReasons);
          // Same Needs Review surfacing as the shadow branch: the inbox is
          // driven by triage_items rows, so without these an auto-routed call
          // in enforce/V2-off mode would never show the read-back prompt.
          for (const flag of emailReasons.slice(0, 10)) {
            try {
              await db('triage_items')
                .insert(buildTriageItem({
                  callLogId: call.id,
                  flag,
                  extraction: v2Result?.extraction || { meta: { call_summary: extracted.call_summary || null } },
                  severity: 'advisory',
                  // Same decoder evidence as the shadow branch — candidates +
                  // the exact question to ask on the read-back.
                  extraPayload: dictationEmailPayload,
                }))
                .onConflict(db.raw('(call_log_id, reason_code) WHERE status IN (\'open\', \'in_progress\')'))
                .ignore();
            } catch (triageErr) {
              logger.warn(`[call-proc] email triage_items insert failed for ${maskSid(callSid)}: ${triageErr.message}`);
            }
          }
        }
      } catch (emailErr) {
        logger.warn(`[call-proc] email review skipped for ${maskSid(callSid)}: ${emailErr.message}`);
      }
    }

    // Hard veto → record extraction for audit, skip all canonical writes
    // (no customer, no lead, no appointment, no automation). Mirrors the
    // spam/voicemail early-return below.
    if (v2CanonicalWriteBlocked) {
      await db('call_log').where({ id: call.id }).update({
        ai_extraction: JSON.stringify(extracted),
        call_summary: extracted.call_summary || null,
        sentiment: extracted.sentiment || null,
        lead_quality: extracted.lead_quality || null,
        processing_status: extracted.is_spam ? 'spam' : 'processed',
        review_status: 'open',
        processing_token: null,
        processing_started_at: null,
        updated_at: new Date(),
      });
      await updateUnifiedVoiceMessage({ ...call, transcription }, { body: transcription });
      logger.info(`[call-proc] V2 hard veto for ${callSid}; skipped canonical writes (customer/lead/appointment)`);
      return { success: true, skipped: true, reason: 'v2_canonical_write_blocked' };
    }

    // Multi-property / quote / secondary-contact signals from the extractors.
    // Resolved BEFORE the customer upsert (Step 3): the secondary-contact
    // scrub below must run before extracted.email/phone are written onto the
    // caller's record. Canonical writes only trust a V2 extraction that passed
    // schema validation — a schema_failed payload is still stored raw for
    // audit (ai_extraction_enriched, triage payloads) but must not drive
    // customer/lead side effects.
    const v2CanonicalExtraction = v2Result?.status === 'valid' ? v2Result.extraction : null;
    const callAdditionalProps = resolveCallAdditionalProperties(extracted, v2CanonicalExtraction);
    const { quoteRequested: callQuoteRequested, quotePromised: callQuotePromised } =
      resolveCallQuoteSignals(extracted, v2CanonicalExtraction);
    const callSecondaryContact = resolveCallSecondaryContact(extracted, v2CanonicalExtraction);

    // Deterministic backstop for the exact chimera this feature exists to
    // prevent: when the model leaves the SECOND person's email/phone in the
    // caller's top-level fields too (the 2026-07-08 WDO call stored the
    // buyer's email on the realtor's record), clear the caller-side copy
    // BEFORE the upsert persists it. Email: the secondary owns it; the
    // caller's email is simply unknown. Phone: only scrubbed when the ANI
    // disagrees — extracted.phone legitimately equals the ANI on most calls,
    // and resolveCallContactPhone falls back to the ANI once cleared.
    //
    // GATED on the same flag as the slot persistence: the booking validator's
    // email requirement is satisfied by the slot email the gated persistence
    // writes, so scrubbing WITHOUT persisting (gate off) would re-skip the
    // exact realtor-books-for-buyer booking this feature targets as
    // missing_required_customer_fields. Kill state = honest full revert to
    // pre-feature behavior (chimera risk returns while the gate is off).
    if (process.env.GATE_CALL_SECONDARY_CONTACT === 'true' && callSecondaryContact) {
      const scrubLast10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);
      if (extracted.email && callSecondaryContact.email
          && String(extracted.email).toLowerCase() === String(callSecondaryContact.email).toLowerCase()) {
        extracted.email = null;
        logger.info(`[call-proc] Scrubbed secondary contact's email off the caller fields for ${maskSid(callSid)}`);
      }
      const aniLast10 = scrubLast10(call.from_phone);
      if (extracted.phone && callSecondaryContact.phone
          && scrubLast10(extracted.phone) === scrubLast10(callSecondaryContact.phone)
          && aniLast10 && scrubLast10(extracted.phone) !== aniLast10) {
        extracted.phone = null;
        logger.info(`[call-proc] Scrubbed secondary contact's phone off the caller fields for ${maskSid(callSid)}`);
      }
    }

    // Step 3: Create or update customer
    let customerId = call.customer_id;
    const phone = resolveCallContactPhone(call, extracted.phone);
    let newsletterResult = null;
    let newsletterCandidate = null;
    let createdCustomerFromCall = false;

    if (customerId && extracted.first_name && phone) {
      const currentCustomer = await db('customers').where({ id: customerId }).first().catch(() => null);
      if (currentCustomer && customerPhoneMatches(phone, currentCustomer) && !extractedNameMatchesCustomer(extracted, currentCustomer)) {
        const namedCustomer = await findCustomerForCallContact(phone, extracted).catch((e) => {
          logger.warn(`[call-proc] Name-based customer reconciliation failed for ${maskSid(callSid)}: ${e.message}`);
          return null;
        });
        if (namedCustomer && namedCustomer.id !== customerId) {
          logger.warn(
            `[call-proc] Reassigning call ${maskSid(callSid)} from customer ${customerId} to ${namedCustomer.id}; ` +
            'transcript name matched alternate customer'
          );
          customerId = namedCustomer.id;
        }
      }
    }

    if (!customerId && phone) {
      // Try to find an existing customer by the external contact phone.
      // Name match wins; phone-only matching is allowed only when the number
      // maps to a single active customer.
      const existing = await findCustomerForCallContact(phone, extracted);
      if (existing) {
        customerId = existing.id;
        // Update with any new info
        const updates = {};
        if (!existing.email && extracted.email) updates.email = extracted.email;
        if ((!existing.address_line1 || existing.address_line1 === '') && extracted.address_line1) {
          updates.address_line1 = extracted.address_line1;
          if (extracted.city) updates.city = extracted.city;
          if (extracted.zip) updates.zip = extracted.zip;
        }
        if (Object.keys(updates).length > 0) {
          await db('customers').where({ id: customerId }).update(updates);
        }
      } else if (extracted.first_name && phone && !extracted.is_voicemail) {
        // Create new customer. NEVER from a voicemail — a one-sided message
        // transcription is too lossy to mint a customer record from (the Josh
        // incident: first name + mangled address became a "real" customer).
        // A workable voicemail becomes a customer-less Needs-Review lead in
        // Step 4b instead; the office completes it into a customer by hand.
        const loc = resolveLocation(extracted.city || '');
        const code = 'WAVES-' + Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
        const numberConfig = TWILIO_NUMBERS.findByNumber(call.to_phone);
        const leadSource = numberConfig ? TWILIO_NUMBERS.getLeadSourceFromNumber(call.to_phone) : { source: 'phone_call' };
        // Explicit word-of-mouth referral overrides the dialed-number source — the
        // referral is the real acquisition channel, not the tracking line they called.
        const referredByName = referrerNameFromExtracted(extracted);
        if (referredByName) {
          leadSource.source = 'referral';
          // Clamp to customers.lead_source_detail's varchar(200) so a verbose
          // model phrase can't overflow the column and break the customer insert.
          leadSource.detail = (referredByName.toLowerCase() === 'unnamed'
            ? 'Referral (unnamed)' : `Referred by ${referredByName}`).slice(0, 200);
        }

        try {
          // Parse address if AI extracted a full address string
          let addrLine = extracted.address_line1 || '';
          let addrCity = extracted.city || '';
          let addrState = extracted.state || 'FL';
          let addrZip = extracted.zip || '';
          if (addrLine && !addrCity) {
            // Try to parse "8224 Abalone Loop, Parrish 34219" → parts
            const parts = addrLine.split(',').map(p => p.trim());
            if (parts.length >= 2) {
              addrLine = parts[0];
              const cityZip = parts[parts.length - 1].match(/^(.+?)\s*(?:FL\s*)?(\d{5})?$/i);
              if (cityZip) {
                addrCity = capitalizeName(cityZip[1].replace(/\s*FL\s*/i, '').trim());
                if (cityZip[2]) addrZip = cityZip[2];
              }
            }
          }

          const [newCust] = await db('customers').insert(applyContactNormalization({
            first_name: extracted.first_name,
            last_name: extracted.last_name || null,
            phone,
            email: extracted.email || null,
            address_line1: addrLine || null,
            city: addrCity || null,
            state: addrState,
            zip: addrZip || null,
            referral_code: code,
            lead_source: leadSource.source || 'phone_call',
            lead_source_detail: leadSource.detail || numberConfig?.domain || 'inbound call',
            pipeline_stage: 'new_lead',
            pipeline_stage_changed_at: new Date(),
            nearest_location_id: loc.id,
          })).returning('*');
          customerId = newCust.id;
          createdCustomerFromCall = true;
          logger.info(`[call-proc] Created customer ${customerId} from call recording`);

          await db('notification_prefs')
            .insert({ customer_id: customerId })
            .onConflict('customer_id')
            .ignore()
            .catch((e) => logger.warn(`[call-proc] notification_prefs create failed for ${customerId}: ${e.message}`));

          // Auto-create Stripe customer (non-blocking, but log failures so a
          // misconfigured Stripe key surfaces in the logs instead of silently
          // skipping every new customer's billing record)
          try {
            const StripeService = require('./stripe');
            await StripeService.ensureStripeCustomer(customerId);
          } catch (e) {
            logger.warn(`[call-proc] Stripe customer create failed for ${customerId}: ${e.message}`);
          }

          newsletterCandidate = {
            customerId,
            email: extracted.email,
            firstName: capitalizeName(extracted.first_name),
            lastName: extracted.last_name ? capitalizeName(extracted.last_name) : null,
          };
        } catch (err) {
          logger.error(`[call-proc] Customer creation failed: ${err.message}`);
        }
      } else if (!extracted.first_name) {
        logger.info(`[call-proc] Skipping new customer creation for ${callSid}: first name not confirmed`);
      }
    }

    // Advisory review signal for EVERY multi-property call (new customers
    // included — the returning-caller differs-check below can't see a brand-new
    // customer whose two addresses arrived on one call, which is exactly the
    // case that used to drop the second property silently).
    if (callAdditionalProps.length && !bridgeNeedsConfirmation.includes('second_service_address')) {
      bridgeNeedsConfirmation.push('second_service_address');
      try {
        await db('triage_items')
          .insert(buildTriageItem({
            callLogId: call.id,
            flag: 'second_service_address',
            extraction: v2Result?.extraction || { meta: { call_summary: extracted.call_summary || null } },
            severity: 'advisory',
          }))
          .onConflict(db.raw('(call_log_id, reason_code) WHERE status IN (\'open\', \'in_progress\')'))
          .ignore();
      } catch (triageErr) {
        logger.warn(`[call-proc-bridge] multi-property triage insert failed for ${maskSid(callSid)}: ${triageErr.code || triageErr.name || 'db_error'}`);
      }
    }

    // Advisory review signal whenever a second person was named on the call
    // (realtor's buyer, landlord's tenant): the extraction now retains their
    // contact info, but the office should confirm it before relying on it —
    // and when the persistence gate below is off, this triage item is the ONLY
    // surface carrying the second contact besides the lead's extracted_data.
    if (callSecondaryContact && !bridgeNeedsConfirmation.includes('secondary_contact_captured')) {
      bridgeNeedsConfirmation.push('secondary_contact_captured');
      try {
        const secondaryTriageItem = buildTriageItem({
          callLogId: call.id,
          flag: 'secondary_contact_captured',
          extraction: v2Result?.extraction || { meta: { call_summary: extracted.call_summary || null } },
          severity: 'advisory',
          extraPayload: { secondary_contact: callSecondaryContact },
        });
        // MERGE the payload (not ignore): in enforce mode the deterministic-
        // flags loop inserts this flag first with the V2 extraction's contact,
        // but persistence uses the RESOLVED contact (V1 on a V1/V2 identity
        // conflict) — the open Needs Review row must show the person that was
        // actually written to the slot, not a stale competing extraction.
        await db('triage_items')
          .insert(secondaryTriageItem)
          .onConflict(db.raw('(call_log_id, reason_code) WHERE status IN (\'open\', \'in_progress\')'))
          .merge({ payload: secondaryTriageItem.payload, updated_at: new Date() });
      } catch (triageErr) {
        logger.warn(`[call-proc-bridge] secondary-contact triage insert failed for ${maskSid(callSid)}: ${triageErr.code || triageErr.name || 'db_error'}`);
      }
    }

    // Lightweight multi-property signal: a returning caller gave a service
    // address that differs from the one already on their customer record (the
    // one-address-per-customer model can't hold both, and the upsert above only
    // fills an EMPTY address — so a second address would otherwise be dropped
    // silently). We do NOT overwrite (can't tell which is primary) — flag it so
    // the office can decide if it's a second property, e.g. a landlord's rental
    // vs. their own home. Skips brand-new customers (their address IS this call's).
    if (customerId && !createdCustomerFromCall && extracted.address_line1) {
      try {
        // Unit/line2 isn't in the legacy extraction or flatView's flat map, so
        // pull it from the V2 service_address when present — otherwise Unit A and
        // Unit B at one building collapse to the same address key.
        const callUnit = extracted.address_line2 || v2CanonicalExtraction?.property?.service_address?.street_line_2 || null;
        const { addressKey, streetKey, unitKey, streetEmbeddedUnitKey } = require('./customer-properties');
        // When the multi-property table is live, an address already recorded there
        // (the primary OR a prior secondary) is NOT a new second address — don't
        // re-flag it, or the office is asked to confirm a place we already know.
        let knownProperty = false;
        if (process.env.GATE_CUSTOMER_PROPERTIES === 'true') {
          const callKey = addressKey({ address_line1: extracted.address_line1, address_line2: callUnit, city: extracted.city, zip: extracted.zip });
          const props = await db('customer_properties').where({ customer_id: customerId, active: true }).select('address_line1', 'address_line2', 'city', 'zip');
          knownProperty = !!callKey && props.some((p) => addressKey(p) === callKey);
        }
        const existingCust = await db('customers').where({ id: customerId }).select('address_line1', 'address_line2', 'city', 'zip').first();
        // Suffix-CANONICAL street compare so "123 Main St" == "123 Main Street" but
        // "123 Main St" != "123 Main Ave" (canonicalize, don't strip — a stripping
        // key would merge St and Ave and miss a genuinely different street).
        const onFileStreet = streetKey(existingCust?.address_line1);
        const fromCallStreet = streetKey(extracted.address_line1);
        // Compare the full service LOCATION, not just the street: a different
        // street, UNIT, city, or ZIP (both present) is a different property —
        // "100 Main St, Bradenton" != "100 Main St, Sarasota", and Unit A != Unit B.
        const bothPresentAndDiffer = (a, b) => !!normStreet(a) && !!normStreet(b) && normStreet(a) !== normStreet(b);
        // A unit the CALL supplies that differs from what's on file is a different
        // property (Unit A on file, call about Unit B — or no unit on file, call
        // adds one). One-sided: the caller omitting a unit they didn't mention is
        // NOT a change; and a unit already embedded in the stored street (legacy
        // "100 Main St Apt 4" with empty line2) is NOT a new unit.
        // Normalize unit tokens with the SAME designator-stripping addressKey uses
        // (unitKey/streetEmbeddedUnitKey, imported below) so this heuristic can't
        // disagree with the dedup key — a raw normStreet keeps the designator word,
        // making "Apt 4" and "Unit 4" compare as different units for the SAME unit.
        // The call's unit: its own line2 if present, else a unit embedded in its
        // one-line street ("100 Main St Apt 5" with empty line2) — otherwise a
        // different embedded unit at the same street is missed (streetKey strips the
        // trailing unit, so the street compare alone won't catch it).
        const callUnitKey = unitKey(callUnit) || streetEmbeddedUnitKey(extracted.address_line1);
        // The unit (if any) ALREADY on file: its line2, or one embedded in the
        // stored street. Compare the call's unit to THESE exact units — not a raw
        // substring of the street, which falsely matches a bare unit "4" inside the
        // house number "14 Main St" and suppresses real second-property detection.
        const storedEmbeddedUnit = streetEmbeddedUnitKey(existingCust?.address_line1);
        const callAddsDifferentUnit = !!callUnitKey
          && callUnitKey !== unitKey(existingCust?.address_line2)
          && callUnitKey !== storedEmbeddedUnit;
        const locationDiffers = (onFileStreet !== fromCallStreet)
          || callAddsDifferentUnit
          || bothPresentAndDiffer(existingCust?.city, extracted.city)
          || bothPresentAndDiffer(existingCust?.zip, extracted.zip);
        if (!knownProperty && onFileStreet && fromCallStreet && locationDiffers && !bridgeNeedsConfirmation.includes('second_service_address')) {
          bridgeNeedsConfirmation.push('second_service_address');
          logger.info(`[call-proc-bridge] ${callSid} service address differs from customer record (possible second property)`);
          // This flag is appended AFTER the bridge's triage_items loop above, so
          // insert its row here too — the Needs Review inbox is driven by
          // triage_items, not call_log.review_status. Advisory (non-blocking).
          try {
            await db('triage_items')
              .insert(buildTriageItem({
                callLogId: call.id,
                flag: 'second_service_address',
                extraction: v2Result?.extraction || { meta: { call_summary: extracted.call_summary || null } },
                severity: 'advisory',
              }))
              .onConflict(db.raw('(call_log_id, reason_code) WHERE status IN (\'open\', \'in_progress\')'))
              .ignore();
          } catch (triageErr) {
            logger.warn(`[call-proc-bridge] second_service_address triage insert failed for ${maskSid(callSid)}: ${triageErr.code || triageErr.name || 'db_error'}`);
          }
        }
      } catch (e) {
        logger.warn(`[call-proc-bridge] second-address check skipped for ${maskSid(callSid)}: ${e.code || e.name || 'db_error'}`);
      }
    }

    // Phase 1 multi-property persistence (additive, gated, non-blocking). Ensure
    // a primary exists, then record THIS call's service address. recordCallProperty
    // dedups on the full address (so a call about the existing primary is a no-op),
    // makes the row primary + mirrors to customers.address_* when the customer has
    // no primary yet (an addressless customer's first address — captured here even
    // when no second_service_address was raised), and otherwise stores a second
    // property. Never overwrites an existing primary mirror.
    if (process.env.GATE_CUSTOMER_PROPERTIES === 'true' && customerId && extracted.address_line1) {
      try {
        const customerProperties = require('./customer-properties');
        // Unit/line2 from the V2 service_address (legacy extraction + flatView drop it).
        const callUnit = extracted.address_line2 || v2CanonicalExtraction?.property?.service_address?.street_line_2 || null;
        // When this call is the customer's PRIMARY street but adds city/ZIP/unit
        // the records lack, complete the mirror AND the existing primary property
        // (recomputing its key) BEFORE snapshotting — otherwise the primary is
        // captured partial / unitless and a later full-address call duplicates it.
        await customerProperties.completePrimaryFromCall(customerId, {
          address_line1: extracted.address_line1, address_line2: callUnit, city: extracted.city, zip: extracted.zip,
        });
        // Rental signal — works in BOTH shadow and enforce (DRIVES_ROUTING) modes:
        // the shadow bridge may not have run, so re-derive from the V2 extraction.
        // Computed BEFORE ensurePrimaryProperty so a first-call tenant/rental
        // primary is created with the right occupancy (its recordCallProperty
        // branch never runs once the primary exists → it would otherwise stay the
        // default owner_occupied).
        const isRental = bridgeNeedsConfirmation.includes('rental_or_tenant_occupied')
          || detectRentalSignal({ extracted, callerRelationship: v2CanonicalExtraction?.caller?.relationship_to_property });
        // The rental signal is about THIS CALL's address. ensurePrimaryProperty
        // creates the primary from customers.address_*, which can be a DIFFERENT
        // address (the customer's own home) when the call is about a secondary
        // rental — so only let the primary inherit the rental occupancy when the
        // call IS the primary's FULL address. Compare the full addressKey (street +
        // unit + city + ZIP), the same key the dedup uses: street/unit alone would
        // tag a same-street call in a different city, and streetKey strips units so a
        // tenant call for Unit B at the stored Unit A's street would wrongly mark the
        // primary rental. completePrimaryFromCall above already filled any city/ZIP
        // gaps on the customer, so a genuine same-address call matches.
        const custRow = await db('customers').where({ id: customerId })
          .select('address_line1', 'address_line2', 'city', 'zip').first();
        const callAddrKey = customerProperties.addressKey({
          address_line1: extracted.address_line1, address_line2: callUnit, city: extracted.city, zip: extracted.zip,
        });
        const callIsPrimaryAddress = !!callAddrKey && callAddrKey === customerProperties.addressKey(custRow || {});
        // propertyId is null only when the customer is addressless AND has no
        // primary yet — i.e. this call carries their FIRST service address (the
        // !customerId upsert above is skipped when the call is pre-linked, so
        // ensurePrimaryProperty has nothing to backfill from).
        const ensured = await customerProperties.ensurePrimaryProperty(customerId, {
          occupancyType: (isRental && callIsPrimaryAddress) ? 'rental_investment' : undefined,
        });
        const isFirstAddress = !ensured.propertyId;
        // A SECONDARY write needs a complete-enough address (city + ZIP) so its
        // dedup key matches a later full-address call — otherwise a partial row
        // would miss the dedup and duplicate. A partial second address still gets
        // the review flag above. The first/primary address is recorded regardless.
        const hasFullAddress = !!String(extracted.city || '').trim() && !!String(extracted.zip || '').trim();
        if (isFirstAddress || (bridgeNeedsConfirmation.includes('second_service_address') && hasFullAddress)) {
          await customerProperties.recordCallProperty({
            customerId,
            address_line1: extracted.address_line1,
            address_line2: callUnit,
            city: extracted.city,
            state: extracted.state,
            zip: extracted.zip,
            occupancyType: isRental ? 'rental_investment' : 'unknown',
            source: 'call_pipeline',
          });
        }
        // Every ADDITIONAL property discussed on the call (a landlord's second
        // rental, another unit, a second house) is recorded as a secondary
        // property. City + ZIP are required so the dedup key matches a later
        // full-address call — the extraction prompt resolves "same zip and
        // everything" onto each entry, so a complete entry is the normal case;
        // an incomplete one still surfaces via the advisory triage flag above.
        // recordCallProperty dedups on the full address key, so reprocessing a
        // call (or a repeat caller) never duplicates a property.
        for (const extra of callAdditionalProps) {
          const extraCity = String(extra.city || '').trim();
          const extraZip = String(extra.zip || '').trim();
          if (!extraCity || !extraZip) continue;
          await customerProperties.recordCallProperty({
            customerId,
            address_line1: extra.address_line1,
            address_line2: extra.address_line2 || null,
            city: extraCity,
            state: extra.state || extracted.state,
            zip: extraZip,
            // Occupancy is per-property: the call-level rental signal (isRental)
            // belongs to the call's own address, not the extras — a landlord
            // calling about a rental plus their own home must not get the home
            // tagged rental_investment. Both extraction paths normalize a
            // boolean is_rental onto each entry.
            occupancyType: extra.is_rental ? 'rental_investment' : 'unknown',
            source: 'call_pipeline',
          });
        }
      } catch (e) {
        // Log the error CODE/NAME only — a DB error message can echo the failing
        // address (e.g. unique-constraint "Key (address_key)=(...) already exists").
        logger.warn(`[customer-properties] call-pipeline write skipped for ${maskSid(callSid)}: ${e.code || e.name || 'db_error'}`);
      }
    }

    // Secondary-contact persistence (additive, gated, non-blocking). Runs
    // BEFORE the appointment step so a booking made on this same call already
    // fans its confirmation out to the new contact. Kill switch = unset the gate;
    // the triage item + lead extracted_data still carry the contact either way.
    if (process.env.GATE_CALL_SECONDARY_CONTACT === 'true' && customerId && callSecondaryContact) {
      try {
        const result = await persistCallSecondaryContact(customerId, callSecondaryContact);
        logger.info(`[call-proc] secondary contact for ${maskSid(callSid)}: ${result}`);
        if (result === 'skipped_phone_belongs_to_other_customer') {
          // Distinct review card: the named contact's number is another
          // customer's primary phone — the office decides whether it's the
          // same household, a realtor's office line, or a mishear.
          await db('triage_items')
            .insert(buildTriageItem({
              callLogId: call.id,
              flag: 'secondary_contact_is_existing_customer',
              extraction: v2CanonicalExtraction || undefined,
              extraPayload: { secondary_contact: callSecondaryContact },
            }))
            .onConflict(db.raw('(call_log_id, reason_code) WHERE status IN (\'open\', \'in_progress\')'))
            .ignore()
            .catch((triageErr) => logger.warn(`[call-proc] secondary-collision triage insert failed for ${maskSid(callSid)}: ${triageErr.message}`));
        }
      } catch (e) {
        // Code/name only — a DB error message can echo the contact's phone/email.
        logger.warn(`[call-proc] secondary-contact write skipped for ${maskSid(callSid)}: ${e.code || e.name || 'db_error'}`);
      }
    }

    // Step 4: Update call log with extraction results.
    // Keep the row claimed as 'processing' while downstream side effects run.
    // The terminal status is written only after leads/estimates/scheduling have
    // had a chance to land, so a crash cannot mark the call processed early.
    const customerExpected = !!(extracted.first_name && phone && !extracted.is_voicemail && !extracted.is_spam);
    const customerLanded = !!customerId;
    // Downgraded below if a customer-less recovery lead was expected but its
    // insert failed — that lead is the only durable record for this call, and
    // customerExpected is false, so a swallowed failure would otherwise look
    // fully 'processed'.
    let finalStatus = (customerExpected && !customerLanded) ? 'customer_creation_failed' : 'processed';
    await db('call_log').where({ id: call.id }).update({
      customer_id: customerId || call.customer_id,
      ai_extraction: JSON.stringify(extracted),
      call_summary: extracted.call_summary || null,
      sentiment: extracted.sentiment || null,
      lead_quality: extracted.lead_quality || null,
      updated_at: new Date(),
    });

    const v2ExtractionForAudit = v2Result?.status === 'valid' && isV2Extraction(v2Result.extraction)
      ? v2Result.extraction
      : null;
    await stageCustomerFieldCandidates({
      callId: call.id,
      customerId: customerId || call.customer_id || null,
      extraction: extracted,
      v2Extraction: v2ExtractionForAudit,
    }).catch((err) => {
      logger.warn(`[call-proc] Customer field candidate staging skipped for ${maskSid(callSid)}: ${err.message}`);
    });

    // Step 4b: Create lead in leads table for pipeline tracking
    // Note: we create the lead DIRECTLY here instead of going through lead-attribution,
    // because Step 3 already created the customer — attribution would find the customer
    // and skip lead creation (race condition).
    let leadId = null;
    let voicemailSmsResult = null;
    const leadCustomer = customerId
      ? await db('customers').where({ id: customerId }).select('id', 'pipeline_stage').first().catch(() => null)
      : null;
    // A customer-attached lead requires BOTH a customer record we can attach to
    // AND call content that is actually a new-sales inquiry. The content veto
    // stops existing-customer scheduling/complaint/billing calls (and the
    // model's explicit is_lead=false) from spawning leads, even when the caller
    // is still mid-pipeline (so the pipeline-stage gate alone wouldn't catch
    // them).
    const nonLeadCall = isNonLeadCallContent(extracted);
    // ...but a genuine new-sales inquiry we couldn't attach to a customer —
    // because the caller never stated a name, so the customer upsert was skipped
    // — is still a real lead the office must work. Create it customer-less so it
    // lands in Needs Review (UNqualified: missing name) instead of being dropped
    // to a silent no_op. Still gated by the non-lead content veto, so existing-
    // customer / spam / wrong-number calls never take this path.
    const workableUnnamedLead = !customerId && !nonLeadCall
      && hasWorkableLeadSignal({ extracted, phone, voicemail: extracted.is_voicemail === true });
    // The customer-attached path additionally vetoes voicemails: an existing-
    // customer voicemail terminal-skips before Step 3, so a voicemail reaching
    // here with a customerId means a late/racy phone match — treat it like the
    // skip path (no lead), never like a live-call inquiry.
    const shouldCreateLead = !extracted.is_spam && !nonLeadCall
      && (
        (customerId && !extracted.is_voicemail && shouldCreateCallLeadForCustomer(leadCustomer, { createdCustomerFromCall }))
        || workableUnnamedLead
      );
    if (!shouldCreateLead && !extracted.is_spam && (customerId || nonLeadCall)) {
      const skipReason = nonLeadCall
        ? `non-lead call (${extracted.call_type || (extracted.is_lead === false ? 'is_lead=false' : 'unknown')})`
        : `existing customer (${leadCustomer?.pipeline_stage || 'unknown'})`;
      logger.info(`[call-proc] Skipping lead creation for ${skipReason}, customer ${customerId || 'none'}`);
    }
    if (shouldCreateLead) {
      try {
        // Check if lead already exists for this phone (see findReusableCallLead
        // for the per-path filters: soft-deleted excluded always; active-only
        // on the customer-less recovery path; unclaimed-or-ours on the
        // customer-attached path, so a shared-phone lead owned by another
        // customer is never reused/overwritten).
        const existingLead = await findReusableCallLead(db, { phone, customerId, workableUnnamedLead });

        // Resolve the dialed number's marketing source ONCE — used by both the
        // existing-lead and new-lead paths, and for PPC attribution of paid calls.
        // Match every plausible shape of `lead_sources.twilio_phone_number` (it has
        // historically been hand-entered: E.164 `+19413187612`, 11-digit
        // `19413187612`, 10-digit `9413187612`, formatted `(941) 318-7612`).
        let leadSourceId = null;
        let leadSourceRow = null;
        try {
          const digits = (call.to_phone || '').replace(/\D/g, '');
          const ten = digits.length >= 10 ? digits.slice(-10) : null;
          const variants = new Set([call.to_phone].filter(Boolean));
          if (ten) {
            variants.add(ten);
            variants.add(`1${ten}`);
            variants.add(`+1${ten}`);
            variants.add(`(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`);
          }
          const ls = await db('lead_sources')
            .where('is_active', true)
            .whereIn('twilio_phone_number', [...variants])
            .first();
          if (ls) { leadSourceId = ls.id; leadSourceRow = ls; }
          else logger.warn(`[call-proc] No lead_source matched ${maskPhone(call.to_phone)} (variants tried: ${[...variants].map(maskPhone).join(', ')})`);
          // Explicit referral wins over the number-matched source: point the lead at
          // the 'referral' lead_sources row so the PPC funnel attributes it to the
          // referral channel (its per-conversion reward cost), not the dialed line.
          if (referrerNameFromExtracted(extracted)) {
            const refRow = await db('lead_sources').where({ source_type: 'referral', is_active: true }).first().catch(() => null);
            if (refRow) { leadSourceId = refRow.id; leadSourceRow = refRow; }
          }
        } catch (e) {
          logger.warn(`[call-proc] lead_source lookup failed: ${e.message}`);
        }

        if (existingLead) {
          leadId = existingLead.id;
          logger.info(`[call-proc] Found existing lead ${leadId} for ${maskPhone(phone)}`);
        } else {
          const [newLead] = await db('leads').insert({
            lead_source_id: leadSourceId,
            customer_id: customerId,
            phone,
            // A name may be absent (caller never stated it) — store null, not an
            // empty string, so leadContactCompleteness reads it as missing and
            // the lead surfaces UNqualified for the office to complete.
            first_name: capitalizeName(extracted.first_name) || null,
            last_name: capitalizeName(extracted.last_name) || null,
            email: extracted.email || null,
            // 'voicemail' is an established lead_type (admin-agents
            // isMissedCallLead treats it as a missed call needing outreach).
            // first_contact_channel stays 'call' — attribution sweeps and the
            // channel-mix dashboards key on it, and a voicemail IS a call.
            lead_type: extracted.is_voicemail ? 'voicemail' : 'inbound_call',
            first_contact_at: new Date(),
            first_contact_channel: 'call',
            twilio_call_sid: call.twilio_call_sid,
            call_duration_seconds: call.duration_seconds,
            call_recording_url: call.recording_url,
            status: 'new',
          }).returning('*');
          leadId = newLead.id;
          logger.info(`[call-proc] Created new lead ${leadId} (${maskPhone(phone)})${extracted.first_name ? '' : ' — no name captured'}`);

          // Untracked inbound call → no lead_source matched (caller reached the
          // main line / caller-ID didn't match a tracking number). These are the
          // "Unattributed" call leads the dashboard surfaces — notify an admin so
          // it can be source-tagged or followed up. Best-effort; a notify failure
          // must never break call processing.
          if (!leadSourceId) {
            try {
              const callerName = [capitalizeName(extracted.first_name), capitalizeName(extracted.last_name || '')]
                .filter(Boolean)
                .join(' ');
              await require('./notification-service').notifyAdmin(
                'lead',
                'Untracked call lead',
                `New lead from a call we couldn't attribute: ${callerName || 'Unknown caller'} (${phone || 'unknown number'}). No marketing source matched — tag the source or follow up.`,
                {
                  link: `/admin/leads?lead=${leadId}`,
                  metadata: { leadId, phone, callSid: call.twilio_call_sid },
                },
              );
            } catch (notifyErr) {
              logger.warn(`[call-proc] untracked-call admin notify failed: ${notifyErr.message}`);
            }
          } else {
            // Tracked call lead (GBP/spoke/paid tracking number): fire the same
            // new_lead bell + Web Push the web-form path sends. Until now ONLY
            // untracked call leads notified anyone — a tracked marketing call
            // lead (the common case) landed silently and relied on someone
            // happening to open the Leads page. Best-effort; a notify failure
            // must never break call processing.
            try {
              const callerName = [capitalizeName(extracted.first_name), capitalizeName(extracted.last_name || '')]
                .filter(Boolean)
                .join(' ');
              const { triggerNotification } = require('./notification-triggers');
              await triggerNotification('new_lead', {
                title: extracted.is_voicemail ? 'New voicemail lead' : 'New call lead',
                name: callerName || (phone ? maskPhone(phone) : null),
                source: leadSourceRow?.name || null,
                zip: extracted.zip || null,
                service: extracted.matched_service || extracted.requested_service || null,
                phone,
                message: !!extracted.call_summary,
                leadId,
              });
            } catch (notifyErr) {
              logger.warn(`[call-proc] tracked-call new_lead notify failed: ${notifyErr.message}`);
            }
          }
        }

        // Marketing call lead (matched a tracking number), NEW or reused -> surface
        // it in the PPC funnel (ad_service_attribution) so it buckets into the same
        // channel as a web-form lead from that source. attributionForSourceType maps
        // the lead_sources.source_type to the funnel channel key + paid flag: PAID
        // numbers (google_ads/facebook) stay paid; ORGANIC marketing sources (spoke
        // domains -> domain_website, hub city pages -> waves_website, GBP ->
        // google_business) are is_paid=false so they show as their own no-spend
        // channels instead of being invisible (an organic call otherwise makes a
        // lead but no funnel row, hiding whole channels from the LTV:CAC surfaces).
        // Offline / word-of-mouth sources map to null and get no row. campaign_id is
        // null here (the Google call-reporting bridge backfills it later for paid
        // Google). recordCallPpcAttribution dedupes by lead_id and respects
        // first-touch (a web-attributed lead keeps its source), so no double-count.
        // EXCEPTION: the Google Ads call-bridge target number is SHARED (organic hub
        // + paid Google call-extension), resolved by the bridge AFTER the fact — so
        // never pre-attribute THAT one number (it would lock the row before the
        // bridge can mark the call paid). Only that single number is suppressed; the
        // other main_site city-page numbers attribute organic normally.
        // NOTE: stays gated on customerId, so a customer-less recovery lead gets no
        // ad_service_attribution row yet — the lead keeps its lead_source_id and is
        // attributed when it converts to a customer. Lead-only PPC attribution needs
        // schema work on the customer-keyed table; deferred out of this PR.
        const callAttr = leadSourceRow
          ? require('./ads/call-attribution').attributionForSourceType(leadSourceRow.source_type)
          : null;
        const isBridgeTarget = leadSourceRow
          && require('./ads/google-call-bridge').isBridgeTargetNumber(leadSourceRow.twilio_phone_number);
        if (leadId && customerId && callAttr && !isBridgeTarget) {
          require('./ads/call-attribution').recordCallPpcAttribution({
            customerId,
            leadId,
            leadSource: callAttr.leadSource, // funnel channel key (paid or organic)
            isPaid: callAttr.isPaid,
            leadSourceDetail: leadSourceRow.name || 'inbound call',
            // service_interest isn't on the lead row yet (enrichment writes it
            // later) — pass the extracted service so service-line ROI is right.
            serviceInterest: extracted.matched_service || extracted.requested_service || null,
            leadDate: call.created_at || null, // date by the actual call
          }).catch(() => {});
        }

        // Enrich lead with AI-extracted data. For an existing lead, only fill
        // fields that are still empty so we don't clobber Virginia's manual
        // edits when a follow-up call comes in. For a brand-new lead (just
        // inserted above) every column we'd touch is null, so the
        // empty-only rule is equivalent to "fill everything" anyway.
        if (leadId) {
          const current = existingLead || (await db('leads').where({ id: leadId }).first());
          const isEmpty = (v) => v === null || v === undefined || v === '';
          const leadUpdates = {};
          if (extracted.first_name && isEmpty(current?.first_name)) leadUpdates.first_name = capitalizeName(extracted.first_name);
          if (extracted.last_name && isEmpty(current?.last_name)) leadUpdates.last_name = capitalizeName(extracted.last_name);
          if (extracted.email && isEmpty(current?.email)) leadUpdates.email = extracted.email;
          if (extracted.address_line1 && isEmpty(current?.address)) leadUpdates.address = extracted.address_line1;
          if (extracted.city && isEmpty(current?.city)) leadUpdates.city = extracted.city;
          if (extracted.zip && isEmpty(current?.zip)) leadUpdates.zip = extracted.zip;
          if (extracted.matched_service && isEmpty(current?.service_interest)) leadUpdates.service_interest = extracted.matched_service;
          // Urgency is a triage signal, not a hand-edited field — and the
          // leads schema defaults it to 'normal' at insert (migration
          // 20260401000095_lead_attribution.js:43), so an empty-only guard
          // here would never upgrade a freshly-inserted hot lead. Treat it
          // as upgrade-only: a hot extraction always promotes to 'urgent';
          // otherwise only fill if still empty so we don't downgrade an
          // already-urgent lead when a cold follow-up call comes in.
          if (extracted.lead_quality === 'hot') {
            leadUpdates.urgency = 'urgent';
          } else if (extracted.lead_quality && isEmpty(current?.urgency)) {
            leadUpdates.urgency = 'normal';
          }
          // Always refresh the rolling AI-derived fields — they're a snapshot
          // of the latest call, not user-curated content.
          if (extracted.call_summary) leadUpdates.transcript_summary = extracted.call_summary;
          // Qualification now requires BOTH buying intent (hot/warm) AND the
          // contact info the office needs to work the lead: first + last name,
          // a service street address, and an email. Evaluate against the MERGED
          // record (this call OR what a prior call already stored) so a follow-up
          // call that restates nothing doesn't un-qualify a complete lead.
          const mergedContact = {
            first_name: leadUpdates.first_name ?? current?.first_name,
            last_name: leadUpdates.last_name ?? current?.last_name,
            service_address: leadUpdates.address ?? current?.address,
            email: leadUpdates.email ?? current?.email,
          };
          const contact = leadContactCompleteness(mergedContact);
          // needs_confirmation is NOT a rolling snapshot like the fields
          // around it: the reasons are read-back reminders that stand until
          // the office confirms them, and a follow-up call that never
          // restates the address/email must not erase the earlier call's
          // warnings (a quick "slab or footer?" callback was wiping
          // address_unverified/email_unverified off the lead). Union prior +
          // this call; a recovered address supersedes its stale unverified.
          const priorNeedsConfirmation = (() => {
            try {
              const data = typeof current?.extracted_data === 'string'
                ? JSON.parse(current.extracted_data)
                : (current?.extracted_data || {});
              return Array.isArray(data.needs_confirmation) ? data.needs_confirmation : [];
            } catch { return []; }
          })();
          const mergedNeedsConfirmation = mergeNeedsConfirmation(priorNeedsConfirmation, bridgeNeedsConfirmation);
          leadUpdates.extracted_data = JSON.stringify({
            pain_points: extracted.pain_points,
            preferred_date_time: extracted.preferred_date_time,
            sentiment: extracted.sentiment,
            call_type: extracted.call_type || null,
            ...(extracted.is_voicemail ? { voicemail: true } : {}),
            ...(contact.missing.length ? { missing_for_qualification: contact.missing } : {}),
            ...(mergedNeedsConfirmation.length ? { needs_confirmation: mergedNeedsConfirmation } : {}),
            ...(callQuoteRequested ? { quote_requested: true } : {}),
            ...(callQuotePromised ? { quote_promised: true } : {}),
            ...(callAdditionalProps.length ? { additional_properties: callAdditionalProps } : {}),
            ...(callSecondaryContact ? { secondary_contact: callSecondaryContact } : {}),
          });
          // hot/warm AND complete contact. Spam was already early-returned.
          leadUpdates.is_qualified = ['hot', 'warm'].includes(extracted.lead_quality) && contact.complete;
          // Only ever SET the customer link, never clear it. The unnamed-lead
          // path runs with customerId null and can reuse an existing lead
          // found by phone — writing customer_id = null there would detach a
          // lead already linked to a customer.
          if (customerId) leadUpdates.customer_id = customerId;
          // Reopen a reused lead the office parked as 'unresponsive' — the
          // prospect just called back, and 'unresponsive' buckets under
          // closed/lost in the admin leads UI, so a silently reused row would
          // stay hidden from Needs Review. Same reopen semantics as the
          // webhook prefill attach ('unresponsive' → 'new'; real terminal
          // statuses are excluded from reuse upstream on the recovery path
          // and never reopened here).
          if (existingLead && current?.status === 'unresponsive') leadUpdates.status = 'new';
          // Quote promised on the call: stamp a same-day follow-up deadline so
          // the pipeline surfaces the owed quote (agent said "we'll send it
          // this afternoon"). Before 5 PM ET → today 5 PM; after → tomorrow
          // 10 AM. Never moves an EARLIER existing follow-up later.
          if (callQuotePromised) {
            try {
              const nowET = new Date();
              const todayFive = parseETDateTime(`${etDateString(nowET)}T17:00`);
              let quoteDue = todayFive;
              if (!(quoteDue instanceof Date) || isNaN(quoteDue.getTime()) || quoteDue <= nowET) {
                const tomorrow = new Date(nowET.getTime() + 24 * 60 * 60 * 1000);
                quoteDue = parseETDateTime(`${etDateString(tomorrow)}T10:00`);
              }
              const existingFollowUp = current?.next_follow_up_at ? new Date(current.next_follow_up_at) : null;
              // Only PULL IN the follow-up (or set one where none exists) —
              // an existing earlier or already-overdue follow-up stays put.
              if (quoteDue instanceof Date && !isNaN(quoteDue.getTime())
                  && (!existingFollowUp || isNaN(existingFollowUp.getTime()) || existingFollowUp > quoteDue)) {
                leadUpdates.next_follow_up_at = quoteDue;
              }
            } catch (dueErr) {
              logger.warn(`[call-proc] quote-due follow-up stamp skipped: ${dueErr.message}`);
            }
          }
          leadUpdates.updated_at = new Date();
          // findReusableCallLead already excludes a lead owned by ANOTHER
          // customer from the lookup, so `current` is never foreign here. The
          // write repeats that ownership predicate as the race backstop: a
          // concurrent claim between the lookup and this update leaves the
          // just-claimed lead untouched (0 rows) instead of overwriting the
          // other customer's lead with this caller's extraction.
          let enrichmentWrite = db('leads').where({ id: leadId });
          if (customerId) {
            enrichmentWrite = enrichmentWrite.where((q) => q.whereNull('customer_id').orWhere('customer_id', customerId));
          }
          const enriched = await enrichmentWrite.update(leadUpdates);

          // Log AI triage activity — gated on the enrichment write landing, so
          // a lead lost to the ownership race above never gets this caller's
          // triage on its timeline either. When the bridge flagged anything,
          // append a plain-language "confirm before dispatch" line so it's
          // visible on the lead timeline Virginia works, not just in
          // extracted_data.
          const triageBase = `AI extracted from ${extracted.is_voicemail ? 'voicemail' : 'call'}: ${extracted.matched_service || 'general inquiry'}, quality: ${extracted.lead_quality || 'unknown'}`;
          const triageNotes = [];
          if (contact.missing.length) {
            triageNotes.push(`needs for qualification: ${contact.missing.map((f) => QUALIFYING_CONTACT_LABELS[f] || f).join(', ')}`);
          }
          if (bridgeNeedsConfirmation.length) {
            triageNotes.push(`⚠ CONFIRM BEFORE DISPATCH: ${bridgeNeedsConfirmation.map(describeConfirmReason).join('; ')}`);
          }
          const triageDesc = triageNotes.length ? `${triageBase} — ${triageNotes.join(' — ')}` : triageBase;
          if (enriched) await db('lead_activities').insert({
            lead_id: leadId,
            activity_type: 'ai_triage',
            description: triageDesc,
            performed_by: 'AI Call Processor',
            metadata: JSON.stringify({
              call_summary: extracted.call_summary,
              pain_points: extracted.pain_points,
              sentiment: extracted.sentiment,
              call_type: extracted.call_type || null,
              is_qualified: leadUpdates.is_qualified,
              ...(contact.missing.length ? { missing_for_qualification: contact.missing } : {}),
              ...(bridgeNeedsConfirmation.length
                ? { needs_confirmation: bridgeNeedsConfirmation, address_validation_status: v2AddressValidation?.status || null }
                : {}),
            }),
          }).catch(e => logger.warn(`[call-proc] Non-critical op failed: ${e.message}`));

          // The agent promised to send a quote after the call — that promise
          // has no artifact anywhere (no estimate exists yet), so surface it
          // as an admin notification with the deadline. Without this the
          // promise lives only in the recording and dies if nobody remembers
          // (this is exactly what happened on real multi-property quote calls).
          if (callQuotePromised && enriched) {
            try {
              const callerName = [capitalizeName(extracted.first_name), capitalizeName(extracted.last_name || '')]
                .filter(Boolean)
                .join(' ') || (phone ? maskPhone(phone) : 'Unknown caller');
              const servicesText = extracted.matched_service || extracted.requested_service || 'service discussed on the call';
              const propertyCount = 1 + callAdditionalProps.length;
              await require('./notification-service').notifyAdmin(
                'lead',
                'Quote promised on call — send it',
                `${callerName}: the agent promised to send a quote (${servicesText}${propertyCount > 1 ? `, ${propertyCount} properties` : ''}). Send it before end of day — the lead stays open in the pipeline until it goes out.`,
                {
                  link: `/admin/leads?lead=${leadId}`,
                  metadata: { leadId, callSid: call.twilio_call_sid, quote_promised: true, property_count: propertyCount },
                },
              );
            } catch (notifyErr) {
              logger.warn(`[call-proc] quote-promised admin notify failed: ${notifyErr.message}`);
            }
          }
        }

        // Voicemail lead text-back (Layer 3): text the prospect a prefilled
        // quote-wizard link. Only on the voicemail lead path — new prospect,
        // workable signal, no existing customer. All send gates (feature
        // gate, one-shot dedupe, landline, STOP suppression,
        // template kill switch) live in the service. Best-effort: a text-back
        // failure must never break call processing or the lead that was just
        // created.
        if (voicemailLeadPath && leadId) {
          try {
            const VoicemailLeadSms = require('./voicemail-lead-sms');
            voicemailSmsResult = await VoicemailLeadSms.sendVoicemailQuoteLink({
              leadId,
              extracted,
              call,
              phone,
            });
          } catch (smsErr) {
            logger.warn(`[call-proc] voicemail text-back failed (non-blocking): ${smsErr.message}`);
          }
        }
      } catch (leadErr) {
        logger.error(`[call-proc] Lead creation failed (non-blocking): ${leadErr.message}`);
      }
    }

    // Quote promised but NO lead artifact — an established customer past the
    // lead pipeline stages (or any other shouldCreateLead veto) can still be
    // promised a post-call quote while booking or discussing service. The
    // lead-path notification above never fires for them, so the promise would
    // live only in the recording — the exact failure mode this notification
    // exists to prevent. Surface it at the customer level instead.
    if (callQuotePromised && !leadId && !extracted.is_spam) {
      try {
        const callerName = [capitalizeName(extracted.first_name), capitalizeName(extracted.last_name || '')]
          .filter(Boolean)
          .join(' ') || (phone ? maskPhone(phone) : 'Unknown caller');
        const servicesText = extracted.matched_service || extracted.requested_service || 'service discussed on the call';
        const propertyCount = 1 + callAdditionalProps.length;
        await require('./notification-service').notifyAdmin(
          'lead',
          'Quote promised on call — send it',
          `${callerName}: the agent promised to send a quote (${servicesText}${propertyCount > 1 ? `, ${propertyCount} properties` : ''}). Send it before end of day — no lead is tracking this promise.`,
          {
            link: customerId ? `/admin/customers/${customerId}` : '/admin/communications',
            metadata: {
              customerId: customerId || null,
              callSid: call.twilio_call_sid,
              quote_promised: true,
              property_count: propertyCount,
              no_lead: true,
            },
          },
        );
      } catch (notifyErr) {
        logger.warn(`[call-proc] quote-promised (no-lead) admin notify failed: ${notifyErr.message}`);
      }
    }

    // A customer-less recovery lead is the ONLY durable record for this call, so
    // a swallowed insert failure must not read as a clean 'processed'. Mark it
    // failed, open review_status, AND write a triage_items row — the Needs Review
    // inbox (admin-triage) is driven by triage_items, not review_status alone, so
    // without this the failed recovery call would never surface for a human.
    if (workableUnnamedLead && !leadId) {
      finalStatus = 'lead_creation_failed';
      logger.error(`[call-proc] Customer-less recovery lead did not persist for ${callSid} — flagged lead_creation_failed`);
      try {
        const failTriageItem = buildTriageItem({
          callLogId: call.id,
          flag: 'lead_creation_failed',
          extraction: { meta: { call_summary: extracted.call_summary || null } },
        });
        await db('triage_items').insert(failTriageItem)
          .onConflict(db.raw('(call_log_id, reason_code) WHERE status IN (\'open\', \'in_progress\')'))
          .ignore();
      } catch (triageErr) {
        logger.warn(`[call-proc] lead_creation_failed triage item insert skipped for ${callSid}: ${triageErr.message}`);
      }
    }

    // ── Finding 2: when V2 drives routing and approved, schedule from the
    // V2-validated fields, not the unvalidated legacy extraction. canAutoRoute()
    // checked v2's scheduling.confirmed_start_at + service; the appointment +
    // confirmation SMS must use those same values. confirmed_start_at is ET with
    // an explicit offset (e.g. ...T10:00:00-04:00); slice to the ET wall-clock
    // "YYYY-MM-DDTHH:MM" the legacy parser expects.
    if (v2ApprovedExtraction) {
      const v2Flat = flatView(v2ApprovedExtraction);
      const v2WallClock = v2IsoToEtWallClock(v2Flat.preferred_date_time);
      if (v2WallClock) {
        extracted.preferred_date_time = v2WallClock;
      }
      extracted.appointment_confirmed = v2Flat.appointment_confirmed;
      // flatView.matched_service is the coarse category→legacy map ("Termite
      // Inspection" for every termite call). Overwriting V1's specific label
      // with it downgraded e.g. a pre-slab soil-treatment booking to a plain
      // inspection whenever the catalog didn't anchor the request. Adopt it
      // when V2 anchored a catalog service (specific_service_name drives the
      // booking then anyway), when V1 produced no label at all, or when the
      // V2 category maps one-to-one to a concrete service (bed_bug/wdo) —
      // those are more precise than any coarse V1 fallback (codex P2).
      const v2Category = v2Flat.primary_service_category
        || v2ApprovedExtraction?.service_request?.primary_service_category || null;
      const preciseV2Category = v2Category === 'bed_bug' || v2Category === 'wdo';
      if (v2Flat.matched_service && (v2Flat.specific_service_name || !extracted.matched_service || preciseV2Category)) {
        extracted.matched_service = v2Flat.matched_service;
      }
      if (v2Flat.requested_service) extracted.requested_service = v2Flat.requested_service;
      // Catalog-anchored booking fields: the gate validated this extraction, so
      // the booking must use ITS specific service / quoted price / follow-up
      // signal — INCLUDING null/false clears. A truthy-only merge would let a
      // stale unvalidated V1 value (hallucinated price, phantom follow-up)
      // drive catalog selection, estimated_price, or follow-up creation on a
      // V2-approved booking.
      extracted.specific_service_name = v2Flat.specific_service_name || null;
      extracted.quoted_price = typeof v2Flat.quoted_price === 'number' ? v2Flat.quoted_price : null;
      // Quote flags are NOT adopted here: they were already resolved as the
      // union of both extractors (resolveCallQuoteSignals) before the lead
      // writes ran, and a V2 null/false must not clear a V1 quote promise the
      // office was already notified about.
      extracted.follow_up_visit_mentioned = v2Flat.follow_up_visit_mentioned === true;
      extracted.follow_up_date_time = v2IsoToEtWallClock(v2Flat.follow_up_date_time);
      // (AV-normalized address was already written into `extracted` at the gate
      // approval branch above, before the customer/lead upsert — see there.)
      logger.info(`[call-proc-v2] Using v2-approved scheduling fields for ${callSid} appointment`);
    }

    // Step 5: If appointment detected with a SPECIFIC time, send confirmation SMS
    // Guard: reject vague date/time (must contain an actual time like "10 AM", "2:30 PM", "noon")
    let appointmentResult = null;
    const timeStr = (extracted.preferred_date_time || '').toLowerCase();
    const hasSpecificTime = /\d{1,2}:\d{2}|\d{1,2}\s*(am|pm|a\.m|p\.m)|noon|midday/i.test(timeStr);
    const customerServiceContext = customerId ? await loadCustomerServiceContext(customerId) : null;
    const serviceResolution = resolveSchedulableCallService(extracted, { transcription, customerServiceContext });
    // Catalog anchor: the specific bookable service this call maps to, when
    // one resolves. Drives service_type/service_id/price/duration/follow-up on
    // the booking. Also rescues catalog services whose names don't hit the
    // coarse canonicalWavesService buckets (every bookable service must be
    // bookable by phone). null -> legacy coarse-label behavior.
    const callBookingCatalogRow = resolveCallBookingCatalogService({
      extracted,
      transcription,
      services: bookableCallServices,
    });
    // Use the module-level isOutboundCall(call) helper — a local `const
    // isOutboundCall` here shadows it for the WHOLE function scope, putting the
    // phantom-guard references above (Step 0) in the temporal dead zone:
    // "Cannot access 'isOutboundCall' before initialization" on every call that
    // reaches them with a pre-linked customer_id.
    const canCreateAppointmentFromCall = !isOutboundCall(call)
      && (serviceResolution.ok || (!!callBookingCatalogRow && serviceResolution.noMatch === true));
    if (extracted.appointment_confirmed && extracted.preferred_date_time && customerId && hasSpecificTime && !canCreateAppointmentFromCall) {
      appointmentResult = {
        service: serviceResolution.service || extracted.matched_service || extracted.requested_service || null,
        dateTime: extracted.preferred_date_time,
        scheduleCreated: false,
        smsSent: false,
        skippedReason: isOutboundCall(call) ? 'outbound_call' : serviceResolution.reason,
      };
      logger.info(
        `[call-proc] Skipping appointment auto-create for ${callSid}: ` +
        `${appointmentResult.skippedReason} (direction=${call.direction || 'unknown'}, service=${appointmentResult.service || 'none'})`
      );
    }
    if (v2RoutingBlocked) {
      appointmentResult = {
        service: extracted.matched_service || extracted.requested_service || null,
        dateTime: extracted.preferred_date_time,
        scheduleCreated: false,
        smsSent: false,
        skippedReason: 'v2_routing_blocked',
      };
      logger.info(`[call-proc] Appointment blocked by v2 routing gate for ${callSid}`);
    } else if (extracted.appointment_confirmed && extracted.preferred_date_time && customerId && hasSpecificTime && canCreateAppointmentFromCall) {
      try {
        let customer = await db('customers').where({ id: customerId }).first();
        if (customer) {
          customer = await backfillCustomerFromAppointmentContact(customerId, customer, extracted, contactPhone);
          const customerValidation = validatePhoneCallAppointmentCustomer(customer, extracted, contactPhone);
          if (!customerValidation.ok) {
            appointmentResult = {
              service: serviceResolution.service,
              dateTime: extracted.preferred_date_time,
              scheduleCreated: false,
              smsSent: false,
              skippedReason: 'missing_required_customer_fields',
              missingFields: customerValidation.missing,
            };
            logger.warn(
              `[call-proc] Skipping appointment auto-create for ${callSid}: missing required customer fields ` +
              customerValidation.missing.join(', ')
            );
          } else {
            const firstName = customerValidation.details.firstName || '';
            const serviceType = callBookingCatalogRow?.name || serviceResolution.service;
            // Price: transcript-quoted (what the agent and caller agreed)
            // first, catalog list price fallback (one_time services only).
            const priceInfo = resolveCallBookingPrice({
              quotedPrice: extracted.quoted_price,
              catalogRow: callBookingCatalogRow,
            });
            const smsPhone = customerValidation.details.phone;

          // Use SMS template if available, fall back to inline
          let smsBody;
          // Parse separate date/time from preferred_date_time for template compatibility
          let parsedDate = '', parsedTime = '';
          try {
            const dt = parseETDateTime(extracted.preferred_date_time);
            if (!isNaN(dt.getTime())) {
              parsedDate = formatETDate(dt);
              parsedTime = formatETTime(dt);
            } else {
              // Fallback: extract from string
              const dateMatch = extracted.preferred_date_time.match(/(\w+day,?\s+\w+\s+\d+|\w+\s+\d+)/);
              const timeMatch = extracted.preferred_date_time.match(/(\d{1,2}(?::\d{2})?\s*(?:AM|PM|am|pm))/);
              parsedDate = dateMatch ? dateMatch[1] : extracted.preferred_date_time;
              parsedTime = timeMatch ? timeMatch[1]
                : (/\b(noon|midday)\b/i.test(extracted.preferred_date_time) ? '12:00 PM' : '');
            }
          } catch { parsedDate = extracted.preferred_date_time; }

          // Call bookings confirm through the shared appointment_confirmation
          // template (appointment_call_confirmed retired 2026-07-06). The
          // schedule row doesn't exist yet at render time, so the self-serve
          // reschedule link can't be minted — pass an empty clause; the
          // template renders clean without it.
          smsBody = await renderSmsTemplate('appointment_confirmation', {
            first_name: firstName,
            service_type: serviceType,
            date_time: extracted.preferred_date_time,
            date: parsedDate,
            time: parsedTime,
            reschedule_line: '',
          }, {
            workflow: 'call_booking_confirmation',
            entity_type: 'customer',
            entity_id: customer.id,
          });

          // Content-level dedup: even if the concurrent-run guard above
          // misses (e.g., admin reprocess inside the same minute), don't
          // fire an identical confirmation that the customer just got.
          let alreadySent = false;
          try {
            const existing = await db('sms_log')
              .where({ to_phone: smsPhone, message_type: 'confirmation' })
              .where('message_body', smsBody)
              .where('created_at', '>', new Date(Date.now() - 10 * 60 * 1000))
              .first();
            if (existing) alreadySent = true;
          } catch { /* sms_log query issue — send anyway */ }

          // Create the scheduled_services record FIRST. Previously we sent
          // the SMS first and inserted the schedule row afterward — if the
          // insert threw, the customer received "your appointment is booked"
          // for an appointment that never landed on the schedule. Now: insert
          // first, send only if it succeeded.
          let scheduledServiceId = null;
          let scheduledDateForLog = null;
          let windowStartForLog = null;
          let scheduleWasReused = false;
          let followUpCreated = null;
          try {
            const parsedDt = parseETDateTime(extracted.preferred_date_time);
            let scheduledDate, windowStart;
            if (!isNaN(parsedDt.getTime())) {
              // Render the absolute moment back into ET wall-clock components.
              const etOptions = { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false };
              const etDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(parsedDt);
              scheduledDate = etDate; // YYYY-MM-DD in Eastern
              const etTime = new Intl.DateTimeFormat('en-US', etOptions).format(parsedDt);
              windowStart = etTime;
            } else {
              // Fallback: extract date + time from the raw string. Pin parsing
              // to noon so a UTC server's `new Date('April 30 2026')` (which
              // becomes UTC midnight) can't roll the calendar date back a day
              // when we re-render it in ET.
              const dateMatch = extracted.preferred_date_time.match(/(\w+ \d{1,2}(?:,?\s*\d{4})?)/);
              const timeMatch = extracted.preferred_date_time.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i);
              if (dateMatch) {
                const d = new Date(`${dateMatch[1]} 12:00`);
                if (!isNaN(d.getTime())) {
                  scheduledDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
                }
              }
              if (timeMatch) {
                const t = timeMatch[1].toLowerCase();
                let [h, m] = t.replace(/\s*(am|pm)/, '').split(':').map(Number);
                if (isNaN(m)) m = 0;
                if (t.includes('pm') && h < 12) h += 12;
                if (t.includes('am') && h === 12) h = 0;
                windowStart = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
              } else if (/\b(noon|midday)\b/i.test(extracted.preferred_date_time)) {
                // hasSpecificTime accepts "noon"/"midday" but the am/pm regex
                // above can't parse them — they used to fall through to the
                // silent 09:00 default below.
                windowStart = '12:00';
              } else {
                const t24 = extracted.preferred_date_time.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
                if (t24) windowStart = `${String(Number(t24[1])).padStart(2, '0')}:${t24[2]}`;
              }
            }

            // A "specific time required" path must never book a DEFAULT time.
            // If no time parsed, hold for review instead of silently booking
            // 09:00 (and texting the customer a confirmation with a blank
            // time) for a caller who agreed to noon.
            if (scheduledDate && !windowStart) {
              logger.warn(`[call-proc] Could not parse a time from: ${extracted.preferred_date_time}; holding booking instead of defaulting 09:00`);
              appointmentResult = {
                service: serviceType,
                dateTime: extracted.preferred_date_time,
                scheduleCreated: false,
                smsSent: false,
                skippedReason: 'unparseable_time',
              };
              scheduledDate = null;
            }

            const callDateET = etDateString(call.created_at || new Date());
            if (scheduledDate && scheduledDate < callDateET) {
              logger.warn(
                `[call-proc] Extracted appointment date ${scheduledDate} is before call date ${callDateET}; skipping schedule + SMS`
              );
              appointmentResult = {
                service: serviceType,
                dateTime: extracted.preferred_date_time,
                scheduleCreated: false,
                smsSent: false,
                skippedReason: 'past_extracted_date',
              };
              scheduledDate = null;
            }

            if (scheduledDate) {
              // Compute window_end (1 hour after start) and 12-hour display
              let windowEnd = null, windowDisplay = '9:00 AM';
              if (windowStart) {
                const [hh, mm] = windowStart.split(':').map(Number);
                const endH = hh >= 23 ? 23 : hh + 1;
                windowEnd = `${String(endH).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
                const ampm = hh >= 12 ? 'PM' : 'AM';
                const displayH = hh % 12 || 12;
                windowDisplay = `${displayH}:${String(mm).padStart(2, '0')} ${ampm}`;
              }
              // Follow-up visit plan — only when the call specifically
              // discussed a second/follow-up treatment (transcript-driven);
              // date from the transcript when agreed, else parent date + the
              // service's catalog interval (default 14 days).
              const callFollowUpPlan = resolveCallFollowUpPlan({
                extracted,
                catalogRow: callBookingCatalogRow,
                parentDate: scheduledDate,
                parentWindowStart: windowStart || '09:00',
              });
              let reusedExistingSchedule = false;
              const svc = await db.transaction(async (trx) => {
                await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))', ['call-recording-schedule', callSid]);
                const defaultTechnician = await resolveDefaultCallBookingTechnician(trx);
                const defaultTechnicianId = defaultTechnician?.id || null;
                const defaultTechnicianName = defaultTechnician?.name || null;
                // Linked follow-up visit (visit 2). PENDING, not customer-
                // confirmed: the exact time gets confirmed by a human at
                // dispatch. No confirmation SMS and no reminder registration
                // for this row — customer comms go out for the initial
                // visit only (owner directive).
                // Called on the fresh-insert path AND both reuse paths (marker/
                // slot match, idempotency-key conflict) so a retry whose first
                // attempt lost the savepointed follow-up insert — or a
                // reprocess after the primary already exists — still creates
                // the promised second treatment.
                const ensureCallFollowUpVisit = async (primaryRow) => {
                  if (!callFollowUpPlan || !primaryRow?.id) return null;
                  // A terminal primary gets no visit 2 — reprocessing an old
                  // call whose booking since completed or was cancelled must
                  // not book a stray child off it.
                  if (['cancelled', 'completed', 'skipped'].includes(primaryRow.status)) return null;
                  // Any existing follow-up off this primary — whatever its
                  // status or origin (AI child OR a completion-CTA follow-up)
                  // — means dispatch already owns the outcome (a cancelled
                  // child was cancelled on purpose; don't resurrect it). The
                  // idempotency key alone can't catch a reprocess whose
                  // extracted date differs.
                  const existingChild = await trx('scheduled_services')
                    .where((qb) => qb
                      .where({ parent_service_id: primaryRow.id, source_action: 'ai_call_pipeline_followup' })
                      .orWhere({ followup_source_service_id: primaryRow.id }))
                    .first('id');
                  if (existingChild) return null;
                  // A reused primary may have been RESCHEDULED since the call
                  // was first processed — callFollowUpPlan above was spaced
                  // from the extraction's date, so a retry that lost the child
                  // insert would book visit 2 at old-date + interval. Re-space
                  // the plan from the row's actual date (an explicit transcript
                  // date re-validates against it; a plan that no longer
                  // resolves fails closed to no child — dispatch books by hand).
                  let fuPlan = callFollowUpPlan;
                  const primaryActualDate = callBookingDateOnly(primaryRow.scheduled_date);
                  if (primaryActualDate && primaryActualDate !== scheduledDate) {
                    fuPlan = resolveCallFollowUpPlan({
                      extracted,
                      catalogRow: callBookingCatalogRow,
                      parentDate: primaryActualDate,
                      parentWindowStart: String(primaryRow.window_start || '').slice(0, 5) || windowStart || '09:00',
                    });
                    if (!fuPlan) return null;
                  }
                  // Runs in a SAVEPOINT (nested trx): a rejected follow-up
                  // insert must never roll back the confirmed primary
                  // appointment sharing this transaction.
                  const fuStart = fuPlan.windowStart;
                  const [fuH, fuM] = fuStart.split(':').map(Number);
                  const fuEndH = fuH >= 23 ? 23 : fuH + 1;
                  try {
                    return await trx.transaction(async (sp) => {
                      const [fuRow] = await sp('scheduled_services')
                        .insert({
                          customer_id: customerId,
                          technician_id: primaryRow.technician_id || defaultTechnicianId,
                          scheduled_date: fuPlan.scheduledDate,
                          window_start: fuStart,
                          window_end: `${String(fuEndH).padStart(2, '0')}:${String(fuM).padStart(2, '0')}`,
                          window_display: `${fuH % 12 || 12}:${String(fuM).padStart(2, '0')} ${fuH >= 12 ? 'PM' : 'AM'}`,
                          service_type: serviceType,
                          service_id: callBookingCatalogRow?.id || null,
                          parent_service_id: primaryRow.id,
                          status: 'pending',
                          customer_confirmed: false,
                          // Billing shape rides the price: a priced package
                          // total covers both treatments → $0 "included" child
                          // (same no-charge shape as the completion-CTA flow:
                          // followup_included bypasses the one-time billing
                          // pre-gate and completion billing can't fall back to
                          // a monthly rate). An UNPRICED booking's second visit
                          // was never prepaid → billable-neutral like its
                          // unpriced primary, office prices at completion.
                          // followup_source_service_id is stamped either way:
                          // its partial unique index blocks a duplicate
                          // follow-up off this visit and carries no free
                          // semantics of its own.
                          ...callFollowUpBillingShape(priceInfo.price),
                          followup_source_service_id: primaryRow.id,
                          estimated_duration_minutes: callBookingCatalogRow?.default_duration_minutes || DEFAULT_CALL_BOOKING_DURATION_MINUTES,
                          // Customer-safe only: once dispatch confirms this row
                          // the portal filter no longer hides it and
                          // GET /api/schedule returns notes verbatim. The
                          // dispatch instruction + Call SID live in
                          // internal_notes (JobDrawer) — the reuse lookup
                          // (findExistingCallAppointment) excludes child rows,
                          // so the child needs no marker in notes.
                          notes: [
                            'Follow-up treatment (visit 2) booked from your phone call.',
                            priceInfo.price != null ? 'Included in the package price on the initial visit.' : null,
                          ].filter(Boolean).join(' '),
                          internal_notes: [
                            'Booked from phone call — confirm exact time with the customer before dispatch.',
                            `Call SID: ${callSid}.`,
                          ].join(' '),
                          booking_source: 'phone_call',
                          source_call_log_id: call.id,
                          source_action: 'ai_call_pipeline_followup',
                          idempotency_key: computeAppointmentIdempotencyKey({
                            callLogId: call.id,
                            schedulingStatus: 'follow_up',
                            confirmedStartAt: `${fuPlan.scheduledDate}T${fuStart}`,
                            primaryServiceCategory: serviceType,
                            addressHash: computeAddressHash({ street_line_1: customer.address_line1, city: customer.city, postal_code: customer.zip }),
                          }),
                        })
                        .onConflict('idempotency_key')
                        .ignore()
                        .returning('*');
                      return fuRow || null;
                    });
                  } catch (fuErr) {
                    // Savepoint rolled back: visit 2 is lost but the confirmed
                    // primary appointment commits. Dispatch confirms follow-ups
                    // by hand, so surface it in the log for manual recovery.
                    logger.warn(`[call-proc] Follow-up visit insert failed for ${callSid}; primary booking kept: ${fuErr.message}`);
                    return null;
                  }
                };
                const existing = await findExistingCallAppointment({
                  customerId,
                  call,
                  scheduledDate,
                  windowStart: windowStart || '09:00',
                  serviceType,
                  trx,
                });
                if (existing) {
                  reusedExistingSchedule = true;
                  let primaryRow = existing;
                  if (!existing.technician_id && defaultTechnicianId) {
                    const [updatedExisting] = await trx('scheduled_services')
                      .where({ id: existing.id })
                      .update({ technician_id: defaultTechnicianId, updated_at: new Date() })
                      .returning('*');
                    primaryRow = updatedExisting || existing;
                  }
                  // A reused appointment still closed the deal: reprocessing a
                  // call (or recovering from an earlier savepoint-contained
                  // conversion failure) must not strand the lead as open. The
                  // helper's won/duplicate + ownership guards make this a no-op
                  // when the lead already converted.
                  await convertCallLeadOnPhoneBooking(trx, {
                    leadId,
                    customerId,
                    scheduledServiceId: primaryRow.id,
                    callSid,
                    keepOpenForQuote: callQuotePromised,
                  });
                  // After the backfill so the child inherits the assigned tech.
                  followUpCreated = await ensureCallFollowUpVisit(primaryRow);
                  return primaryRow;
                }
                // findExistingCallAppointment only sees THIS call's rows and
                // same-run phone-call bookings — a customer merely
                // re-confirming a visit booked through ANY other channel
                // ("still on for Tuesday at 10?") would re-book it here, with
                // duplicate reminders and a second confirmation SMS. Any live
                // same-day parent visit for this customer means a human
                // decides: hold instead of inserting a duplicate. (A genuine
                // second same-day visit is rare enough that one review card
                // beats a phantom double-dispatch.)
                const sameDayExisting = await trx('scheduled_services')
                  .where({ customer_id: customerId })
                  .whereNull('parent_service_id')
                  .where('scheduled_date', scheduledDate)
                  // completed is excluded: a morning job already done must not
                  // block booking a second visit later the same day (codex P2).
                  .whereNotIn('status', ['cancelled', 'rescheduled', 'skipped', 'completed'])
                  .orderBy('created_at', 'asc')
                  .first();
                if (sameDayExisting) {
                  return {
                    __held: {
                      reason: 'existing_appointment_same_date',
                      existingId: sameDayExisting.id,
                      existingStatus: sameDayExisting.status,
                      existingService: sameDayExisting.service_type,
                    },
                  };
                }
                const insertData = {
                  customer_id: customerId,
                  technician_id: defaultTechnicianId,
                  scheduled_date: scheduledDate,
                  window_start: windowStart || '09:00',
                  window_end: windowEnd || '10:00',
                  window_display: windowDisplay,
                  service_type: serviceType,
                  service_id: callBookingCatalogRow?.id || null,
                  estimated_price: priceInfo.price,
                  create_invoice_on_complete: callBookingInvoiceOnComplete({
                    price: priceInfo.price,
                    catalogRow: callBookingCatalogRow,
                  }),
                  estimated_duration_minutes: callBookingCatalogRow?.default_duration_minutes || DEFAULT_CALL_BOOKING_DURATION_MINUTES,
                  status: 'confirmed',
                  customer_confirmed: true,
                  confirmed_at: new Date(),
                  notes: [
                    'Booked via phone call.',
                    `Call SID: ${callSid}.`,
                    defaultTechnicianName ? `Auto-assigned technician: ${defaultTechnicianName}.` : null,
                    priceInfo.price != null
                      ? `Price ${priceInfo.source === 'transcript' ? 'quoted on call' : 'from service catalog'}: $${priceInfo.price.toFixed(2)}.`
                      : null,
                    extracted.call_summary || null,
                  ].filter(Boolean).join(' ').trim(),
                  // Dispatcher-only price provenance: scheduled_services.notes
                  // is customer-visible (GET /api/schedule returns it verbatim),
                  // so the catalog-vs-quote review cue lives in internal_notes
                  // (surfaced in the dispatch JobDrawer), never in notes.
                  internal_notes: [
                    (priceInfo.source === 'transcript'
                      && callBookingCatalogRow
                      && Number(callBookingCatalogRow.base_price) > 0
                      && Math.abs(Number(callBookingCatalogRow.base_price) - priceInfo.price) >= 0.01)
                      ? `Catalog list price: $${Number(callBookingCatalogRow.base_price).toFixed(2)} — quote differs, review.`
                      : null,
                    // Recurring services never stamp estimated_price (the rate
                    // belongs to plan/subscription billing, not this visit) —
                    // but a rate the agent quoted on the call must not vanish:
                    // it's the number plan setup has to honor.
                    (priceInfo.price == null
                      && callBookingCatalogRow
                      && callBookingCatalogRow.billing_type !== 'one_time'
                      && typeof extracted.quoted_price === 'number'
                      && extracted.quoted_price > 0)
                      ? `Rate quoted on call: $${extracted.quoted_price.toFixed(2)} (recurring service — set up plan billing at this rate; intentionally not stamped on this visit).`
                      : null,
                  ].filter(Boolean).join(' ') || null,
                  booking_source: 'phone_call',
                  source_call_log_id: call.id,
                  source_action: 'ai_call_pipeline',
                  idempotency_key: computeAppointmentIdempotencyKey({
                    callLogId: call.id,
                    schedulingStatus: extracted.appointment_confirmed ? 'confirmed' : 'none',
                    confirmedStartAt: extracted.preferred_date_time,
                    primaryServiceCategory: serviceType,
                    addressHash: computeAddressHash({ street_line_1: customer.address_line1, city: customer.city, postal_code: customer.zip }),
                  }),
                };
                const [created] = await trx('scheduled_services')
                  .insert(insertData)
                  .onConflict('idempotency_key')
                  .ignore()
                  .returning('*');
                if (created) {
                  // A phone-booked appointment is the deal closing — convert the
                  // call's lead to won in the SAME transaction (mirrors the
                  // admin-leads schedule-appointment route), so the conversion
                  // can't commit without the appointment row. Every other booking
                  // path already converts; this one silently didn't, stranding
                  // phone-booked callers as `new` in the pipeline.
                  await convertCallLeadOnPhoneBooking(trx, {
                    leadId,
                    customerId,
                    scheduledServiceId: created.id,
                    callSid,
                    keepOpenForQuote: callQuotePromised,
                  });
                  followUpCreated = await ensureCallFollowUpVisit(created);
                  return created;
                }
                // Idempotency conflict: another writer already created a row with this key.
                // Fetch it and mark as reused so downstream skips duplicate side effects.
                const existingByKey = await trx('scheduled_services')
                  .where({ idempotency_key: insertData.idempotency_key })
                  .first();
                if (existingByKey && ['cancelled', 'rescheduled'].includes(existingByKey.status)) {
                  // The office cancelled this exact auto-booking. Silently
                  // "reusing" the cancelled row resurrected it (lead converted
                  // + follow-up ensured off a dead visit), and re-inserting
                  // would need a salted key — which re-opens the true
                  // double-insert risk the key exists to close. A human books
                  // it by hand if it's real.
                  return {
                    __held: {
                      reason: 'auto_booking_previously_cancelled',
                      existingId: existingByKey.id,
                      existingStatus: existingByKey.status,
                    },
                  };
                }
                if (existingByKey) {
                  reusedExistingSchedule = true;
                  logger.info(`[call-proc] Idempotency conflict for ${callSid}; reusing existing scheduled service ${existingByKey.id}`);
                  // Same as the reuse path above: the appointment exists, so
                  // the lead must still convert (idempotent, ownership-guarded).
                  await convertCallLeadOnPhoneBooking(trx, {
                    leadId,
                    customerId,
                    scheduledServiceId: existingByKey.id,
                    callSid,
                    keepOpenForQuote: callQuotePromised,
                  });
                  // This is exactly the retry whose first attempt may have
                  // lost the savepointed follow-up insert — ensure visit 2.
                  followUpCreated = await ensureCallFollowUpVisit(existingByKey);
                  return existingByKey;
                }
                throw new Error('Idempotency conflict but no existing row found by key — unexpected state');
              });
              if (svc && svc.__held) {
                // Booking held for human review (same-day duplicate or a
                // previously-cancelled auto-booking). No schedule row, no SMS,
                // no side effects. The review card is inserted HERE — not only
                // in the enforce-gated consolidated block below — because the
                // hold also fires in shadow/legacy mode, where a silent hold
                // would otherwise vanish (codex P2).
                appointmentResult = {
                  service: serviceType,
                  dateTime: extracted.preferred_date_time,
                  scheduleCreated: false,
                  smsSent: false,
                  skippedReason: svc.__held.reason,
                  existingScheduledServiceId: svc.__held.existingId || null,
                };
                logger.warn(`[call-proc] Held auto-booking for ${callSid}: ${svc.__held.reason} (existing ${svc.__held.existingId || 'n/a'}, status ${svc.__held.existingStatus || 'n/a'})`);
                await db('triage_items')
                  .insert(buildTriageItem({
                    callLogId: call.id,
                    flag: svc.__held.reason,
                    extraction: v2ApprovedExtraction || v2CanonicalExtraction || undefined,
                    extraPayload: {
                      existing_scheduled_service_id: svc.__held.existingId || null,
                      existing_status: svc.__held.existingStatus || null,
                      existing_service: svc.__held.existingService || null,
                      preferred_date_time: extracted.preferred_date_time || null,
                      service: serviceType || null,
                    },
                  }))
                  .onConflict(db.raw('(call_log_id, reason_code) WHERE status IN (\'open\', \'in_progress\')'))
                  .ignore()
                  .catch((triageErr) => logger.warn(`[call-proc] held-booking triage insert failed for ${maskSid(callSid)}: ${triageErr.message}`));
              } else {
              if (reusedExistingSchedule) {
                scheduleWasReused = true;
                logger.info(`[call-proc] Reusing existing phone-call scheduled service ${svc.id} for ${callSid}; not creating duplicate`);
              }
              scheduledServiceId = svc.id;
              scheduledDateForLog = scheduledDate;
              windowStartForLog = windowStart;
              if (!scheduleWasReused) {
                logger.info(`[call-proc] Scheduled service created: ${svc.id} on ${scheduledDate} at ${windowStart}`);
                await registerScheduleSideEffects({
                  scheduledServiceId: svc.id,
                  customerId,
                  scheduledDate,
                  windowStart: windowStart || '09:00',
                  serviceType: svc.service_type,
                });
              }
              if (!svc.technician_id) {
                // A confirmed, customer-notified booking assigned to NOBODY
                // used to be invisible (log line only) — surface it so the
                // visit can't slip off the dispatch board.
                await db('triage_items')
                  .insert(buildTriageItem({
                    callLogId: call.id,
                    flag: 'unassigned_auto_booking',
                    extraction: v2ApprovedExtraction || undefined,
                    severity: 'advisory',
                    extraPayload: { scheduled_service_id: svc.id, scheduled_date: scheduledDate, service: svc.service_type },
                  }))
                  .onConflict(db.raw('(call_log_id, reason_code) WHERE status IN (\'open\', \'in_progress\')'))
                  .ignore()
                  .catch((triageErr) => logger.warn(`[call-proc] unassigned-booking triage insert failed for ${maskSid(callSid)}: ${triageErr.message}`));
              }
              }
              if (followUpCreated) {
                // Intentionally NO registerScheduleSideEffects here: the
                // follow-up is pending and must not message the customer.
                logger.info(`[call-proc] Follow-up visit created: ${followUpCreated.id} on ${followUpCreated.scheduled_date} (parent ${svc.id}); pending, no customer comms until confirmed`);
              }

            } else if (!appointmentResult) {
              logger.warn(`[call-proc] Could not parse date from: ${extracted.preferred_date_time}; skipping schedule + SMS`);
              appointmentResult = { service: serviceType, dateTime: extracted.preferred_date_time, scheduleCreated: false, smsSent: false, skippedReason: 'unparseable_date' };
            }
          } catch (schedErr) {
            logger.error(`[call-proc] Failed to create scheduled service: ${schedErr.message}; skipping SMS so customer isn't told about an appointment that doesn't exist`);
            appointmentResult = { service: serviceType, dateTime: extracted.preferred_date_time, scheduleError: schedErr.message, smsSent: false };
          }

          // Only send the confirmation SMS if the schedule row landed and TCPA gate allows it.
          if (scheduledServiceId && v2SmsBlocked) {
            logger.info(`[call-proc] Skipping SMS for ${callSid}: v2 TCPA gate blocked (consent not captured)`);
            appointmentResult = { ...(appointmentResult || {}), smsSent: false, smsBlockedReason: 'v2_tcpa_gate' };
          } else if (scheduledServiceId) {
            if (scheduleWasReused) {
              logger.info(`[call-proc] Skipping appointment SMS for reused scheduled service ${scheduledServiceId}`);
              appointmentResult = {
                smsSent: false,
                smsSkippedReason: 'existing_schedule',
                scheduleReused: true,
                scheduledServiceId,
                service: serviceType,
                dateTime: extracted.preferred_date_time,
                scheduledDate: scheduledDateForLog,
                windowStart: windowStartForLog,
              };
            } else if (!smsBody) {
              logger.warn(`[call-proc] appointment_confirmation template missing/disabled; appointment SMS skipped for customer ${customerId}`);
              appointmentResult = {
                smsSent: false,
                smsSkippedReason: 'missing_sms_template',
                scheduledServiceId,
                service: serviceType,
                dateTime: extracted.preferred_date_time,
                scheduledDate: scheduledDateForLog,
                windowStart: windowStartForLog,
              };
            } else if (!alreadySent) {
              // Honor the customer's account-level New Appointment Confirmation
              // channel (sms | email | both). Default 'sms' keeps the exact prior
              // send; email/both also emails the confirmation.
              const AppointmentReminders = require('./appointment-reminders');
              let smsRan = false;
              const confirmationReached = await AppointmentReminders.deliverConfirmationByChannel({
                customerId,
                scheduledServiceId,
                serviceLabel: serviceType,
                smsAttempt: async () => {
                  smsRan = true;
                  const sendResult = await sendCustomerMessage({
                    to: smsPhone,
                    body: smsBody,
                    channel: 'sms',
                    audience: 'customer',
                    purpose: 'appointment_confirmation',
                    customerId,
                    appointmentId: scheduledServiceId,
                    identityTrustLevel: 'phone_matches_customer',
                    metadata: {
                      original_message_type: 'confirmation',
                    },
                  });
                  const primaryOk = !(sendResult.blocked || sendResult.sent === false);
                  if (!primaryOk) {
                    logger.warn(`[call-proc] Appointment SMS blocked for customer ${customerId}: ${sendResult.code || 'unknown'} ${sendResult.reason || ''}`);
                    appointmentResult = {
                      smsSent: false,
                      smsBlocked: true,
                      smsBlockedCode: sendResult.code || null,
                      scheduledServiceId,
                      service: serviceType,
                      dateTime: extracted.preferred_date_time,
                      scheduledDate: scheduledDateForLog,
                      windowStart: windowStartForLog,
                    };
                  } else {
                    logger.info(`[call-proc] Appointment SMS sent to customer ${customerId}`);
                    appointmentResult = { smsSent: true, scheduledServiceId, service: serviceType, dateTime: extracted.preferred_date_time, scheduledDate: scheduledDateForLog, windowStart: windowStartForLog };
                  }
                  // Gated fan-out to the OTHER appointment contacts: the same
                  // call may have named a second notification recipient (just
                  // persisted into a service-contact slot above) — without
                  // this, the buyer/tenant gets later reminders and en-route
                  // texts but misses the initial booking confirmation. Uses
                  // the same contact resolution as the admin confirmation path
                  // (getAppointmentContacts) and re-renders the template per
                  // contact so the greeting carries THEIR name, not the
                  // caller's. Runs REGARDLESS of the primary send's outcome —
                  // a landline/bad primary number must not strand the
                  // buyer/tenant whose slot was just written for this purpose —
                  // and non-blocking: a fan-out failure never voids a primary
                  // confirmation that already went out.
                  if (process.env.GATE_CALL_SECONDARY_CONTACT === 'true') {
                    try {
                      const { getAppointmentContacts, isServiceContactRole } = require('./customer-contact');
                      const freshCustomer = await db('customers').where({ id: customerId }).first();
                      const prefsRow = await db('notification_prefs').where({ customer_id: customerId }).first() || {};
                      const fanLast10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);
                      const extraContacts = getAppointmentContacts(freshCustomer || {}, prefsRow)
                        .filter((c) => c.phone && fanLast10(c.phone) !== fanLast10(smsPhone));
                      for (const contact of extraContacts) {
                        const contactBody = await renderSmsTemplate('appointment_confirmation', {
                          first_name: String(contact.name || '').trim().split(/\s+/)[0] || firstName,
                          service_type: serviceType,
                          date_time: extracted.preferred_date_time,
                          date: parsedDate,
                          time: parsedTime,
                          reschedule_line: '',
                        }, {
                          workflow: 'call_booking_confirmation',
                          entity_type: 'customer',
                          entity_id: customerId,
                        });
                        if (!contactBody) continue;
                        // Same content-level dedup as the primary send: don't
                        // re-fire an identical confirmation on a reprocess.
                        const recentDup = await db('sms_log')
                          .where({ to_phone: contact.phone, message_type: 'confirmation' })
                          .where('message_body', contactBody)
                          .where('created_at', '>', new Date(Date.now() - 10 * 60 * 1000))
                          .first()
                          .catch(() => null);
                        if (recentDup) continue;
                        await sendCustomerMessage({
                          to: contact.phone,
                          body: contactBody,
                          channel: 'sms',
                          audience: 'customer',
                          purpose: 'appointment_confirmation',
                          customerId,
                          appointmentId: scheduledServiceId,
                          identityTrustLevel: isServiceContactRole(contact.role)
                            ? 'service_contact_authorized'
                            : 'phone_matches_customer',
                          metadata: {
                            original_message_type: 'confirmation',
                            appointment_contact_role: contact.role,
                          },
                        });
                        logger.info(`[call-proc] Appointment SMS fanned out to ${contact.role} for customer ${customerId}`);
                      }
                      // Email-only service contacts never appear in the SMS
                      // contact list (getAppointmentContacts is phone-based)
                      // and the default 'sms' channel never runs the email
                      // leg — so an email-only buyer/tenant whose slot email
                      // just made this call BOOKABLE would get nothing.
                      // Send them (and only them) the confirmation email;
                      // recipientFilter keeps the phone-channel primary from
                      // receiving an email their channel choice didn't ask for.
                      // Honors the New Appointment Confirmation opt-out: the
                      // SMS legs are suppressed by sendCustomerMessage's
                      // validator, but the email path bypasses it — an
                      // opted-out account must not leak a confirmation email
                      // (same rule deliverConfirmationByChannel encodes).
                      const confirmationOptedOut = prefsRow?.appointment_confirmation === false;
                      const { getServiceContactSlots } = require('./customer-contact');
                      const emailOnlySlots = confirmationOptedOut ? [] : getServiceContactSlots(freshCustomer || {})
                        .filter((s) => s.email && !s.phone);
                      if (emailOnlySlots.length) {
                        const AppointmentEmail = require('./appointment-email');
                        await AppointmentEmail.sendAppointmentConfirmationEmail({
                          customerId,
                          scheduledServiceId,
                          appointmentTime: parseETDateTime(extracted.preferred_date_time),
                          serviceLabel: serviceType,
                          recipientFilter: emailOnlySlots.map((s) => s.email),
                        });
                        logger.info(`[call-proc] Appointment confirmation emailed to ${emailOnlySlots.length} email-only service contact(s) for customer ${customerId}`);
                      }
                    } catch (fanErr) {
                      logger.warn(`[call-proc] secondary confirmation fan-out skipped for customer ${customerId}: ${fanErr.code || fanErr.name || 'error'}`);
                    }
                  }
                  return primaryOk;
                },
              });
              if (!smsRan) {
                // Email-only confirmation channel: smsAttempt never runs, but the
                // schedule row was created — record it so the route-decision log
                // (created_scheduled_service_id / final_action_taken) reflects reality.
                logger.info(`[call-proc] Appointment confirmation emailed (no SMS) for customer ${customerId}`);
                appointmentResult = { smsSent: false, emailSent: confirmationReached, scheduledServiceId, service: serviceType, dateTime: extracted.preferred_date_time, scheduledDate: scheduledDateForLog, windowStart: windowStartForLog };
              }
            } else {
              logger.info(`[call-proc] Skipping duplicate appointment SMS to customer ${customerId} (sent within last 10 min)`);
              appointmentResult = { smsSent: false, smsSkippedReason: 'duplicate', scheduledServiceId, service: serviceType, dateTime: extracted.preferred_date_time };
            }
          }
          if (followUpCreated) {
            appointmentResult = {
              ...(appointmentResult || {}),
              followUpScheduledServiceId: followUpCreated.id,
              followUpDate: followUpCreated.scheduled_date,
            };
          }
        }
        }
      } catch (err) {
        logger.error(`[call-proc] Appointment SMS failed: ${err.message}`);
        appointmentResult = { error: err.message };
      }
    }

    // A gate-APPROVED booking the legacy insert chain then skipped (past
    // date, missing customer email, unparseable time, same-day duplicate
    // hold, no V1-resolved customer, ...) used to vanish: route_decisions
    // recorded auto_route, no schedule row landed, and no review card ever
    // opened. Every approved-but-unbooked confirmed call now opens ONE
    // blocking review card and corrects the route decision's recorded action
    // + forward-audit pointer.
    if (CALL_EXTRACTION_V2_DRIVES_ROUTING && v2ApprovedExtraction && extracted.appointment_confirmed) {
      const bookedServiceId = appointmentResult?.scheduledServiceId || null;
      // Held bookings already opened their own reason-specific card above.
      const heldReasons = new Set(['existing_appointment_same_date', 'auto_booking_previously_cancelled']);
      if (!bookedServiceId && !heldReasons.has(appointmentResult?.skippedReason)) {
        const skipReason = appointmentResult?.skippedReason
          || appointmentResult?.scheduleError
          || appointmentResult?.error
          || (!customerId ? 'booked_call_without_customer' : 'auto_booking_not_created');
        try {
          await db('triage_items')
            .insert(buildTriageItem({
              callLogId: call.id,
              flag: 'auto_booking_skipped_after_approval',
              extraction: v2ApprovedExtraction,
              extraPayload: {
                skipped_reason: String(skipReason).slice(0, 300),
                missing_fields: appointmentResult?.missingFields || null,
                existing_scheduled_service_id: appointmentResult?.existingScheduledServiceId || null,
                preferred_date_time: extracted.preferred_date_time || null,
                service: appointmentResult?.service || extracted.matched_service || extracted.requested_service || null,
              },
            }))
            .onConflict(db.raw('(call_log_id, reason_code) WHERE status IN (\'open\', \'in_progress\')'))
            .ignore();
        } catch (skipTriageErr) {
          logger.warn(`[call-proc] skip-triage insert failed for ${maskSid(callSid)}: ${skipTriageErr.message}`);
        }
      }
      try {
        await db('route_decisions')
          .where({ call_log_id: call.id, decision_version: 'v2-1.0.0', mode: 'enforce' })
          .update({
            final_action_taken: bookedServiceId ? 'auto_route' : 'auto_route_skipped',
            ...(bookedServiceId ? { created_scheduled_service_id: bookedServiceId } : {}),
          });
      } catch (rdErr) {
        logger.warn(`[call-proc] route_decisions outcome update failed for ${maskSid(callSid)}: ${rdErr.message}`);
      }
    }

    // Step 6: Enroll in the local new_lead automation sequence.
    // Variable name kept as `beehiivResult` for schema/log continuity;
    // carries the local enrollment result now.
    let beehiivResult = null;
    if (customerId && extracted.email && v2EmailBlocked) {
      logger.info(`[call-proc] Skipping new_lead automation enroll for ${callSid}: v2 TCPA gate blocked all outbound (do_not_contact)`);
      beehiivResult = { skipped: 'v2_tcpa_gate' };
    } else if (customerId && extracted.email) {
      try {
        const AutomationRunner = require('./automation-runner');
        const r = await AutomationRunner.enrollCustomer({
          templateKey: 'new_lead',
          customer: {
            email: extracted.email,
            first_name: capitalizeName(extracted.first_name),
            last_name: capitalizeName(extracted.last_name),
            id: customerId,
          },
        });
        beehiivResult = { local: r };
      } catch (err) {
        logger.error(`[call-proc] new_lead enroll failed: ${err.message}`);
        beehiivResult = { error: err.message };
      }
    }

    // Step 7: Log activity
    if (customerId) {
      await db('customer_interactions').insert({
        customer_id: customerId,
        interaction_type: 'call',
        subject: `Inbound call — ${extracted.matched_service || extracted.requested_service || 'General inquiry'}`,
        body: extracted.call_summary || `Call from ${phone}. ${extracted.pain_points || ''}`,
      }).catch(e => logger.warn(`[call-proc] Non-critical op failed: ${e.message}`));
    }

    // Step 7b: Generate lead synopsis (Sales Strategist analysis)
    let synopsis = null;
    if (transcription && !extracted.is_spam && !extracted.is_voicemail) {
      try {
        synopsis = await generateLeadSynopsis(transcription);
        if (synopsis) {
          await db('call_log').where({ id: call.id }).update({ lead_synopsis: synopsis }).catch(e => logger.warn(`[call-proc] Non-critical op failed: ${e.message}`));
          await updateUnifiedVoiceMessage(call, { ai_summary: synopsis });
          // Also write to lead if one was created
          if (leadId) {
            await db('leads').where({ id: leadId }).update({ lead_synopsis: synopsis }).catch(e => logger.warn(`[call-proc] Non-critical op failed: ${e.message}`));
          }
          logger.info(`[call-proc] Lead synopsis generated: ${synopsis.length} chars`);
        }
      } catch (err) {
        logger.error(`[call-proc] Synopsis failed (non-blocking): ${err.message}`);
      }
    }

    // Step 8: CSR Coach scoring — auto-score every transcribed call.
    // The inbound <Dial> simul-rings distinct per-person numbers; the staff leg
    // that pressed 1 is recorded in metadata.forward_acceptance by the
    // /inbound-forward-accept webhook. Resolve that to a CSR name when mapped,
    // and fall back to 'Unknown' so analytics aren't silently booked to one name.
    let csrScoreResult = null;
    if (transcription && transcription.length > 50) {
      try {
        const callMeta = typeof call.metadata === 'string'
          ? (() => { try { return JSON.parse(call.metadata); } catch { return {}; } })()
          : (call.metadata || {});
        const answeredByCsr = callMeta?.forward_acceptance?.csr_name || 'Unknown';
        const CSRCoach = require('./csr/csr-coach');
        const scoreResult = await CSRCoach.scoreCall({
          csrName: answeredByCsr,
          customerId: customerId || null,
          callDirection: 'inbound',
          callSource: call.to_phone || 'unknown',
          transcript: transcription,
          metadata: {
            callSid,
            duration: call.duration_seconds,
            service: extracted.matched_service || extracted.requested_service,
            sentiment: extracted.sentiment,
          },
        });
        csrScoreResult = { score: scoreResult?.score?.total_score, outcome: scoreResult?.score?.call_outcome };
        logger.info(`[call-proc] CSR scored: ${csrScoreResult.score}/15 (${csrScoreResult.outcome})`);
      } catch (err) {
        logger.error(`[call-proc] CSR scoring failed (non-blocking): ${err.message}`);
      }
    }

    if (newsletterCandidate && v2EmailBlocked) {
      logger.info(`[call-proc] Skipping newsletter subscribe for ${callSid}: v2 TCPA gate blocked all outbound (do_not_contact)`);
    } else if (newsletterCandidate) {
      const stillOwned = await db('call_log')
        .where({ id: call.id })
        .where('processing_token', procToken)
        .first('id');
      if (stillOwned) {
        try {
          newsletterResult = await subscribeNewCallCustomerToNewsletter(newsletterCandidate);
        } catch (e) {
          logger.warn(`[call-proc] Newsletter subscribe failed for customer ${newsletterCandidate.customerId}`);
          newsletterResult = { error: 'newsletter_subscribe_failed' };
        }
      } else {
        logger.warn(`[call-proc] Skipped newsletter subscribe for ${callSid} — ownership lost (peer reclaimed via stale-lock window).`);
      }
    }

    if (v2Result) {
      const validationMode = CALL_EXTRACTION_V2_DRIVES_ROUTING ? 'enforce' : 'shadow';
      let routingResult = null;
      let finalFlags = [];

      if (v2ExtractionForAudit) {
        const modelFlags = suppressAddressFlagsForAV(v2ExtractionForAudit.triage_flags, v2AddressValidation);
        const deterministicFlags = computeDeterministicTriageFlags(v2ExtractionForAudit, {
          contactPhone,
          addressValidation: v2AddressValidation,
        });
        finalFlags = mergeTriageFlags(modelFlags, deterministicFlags);
        routingResult = canAutoRoute(v2ExtractionForAudit, {
          contactPhone,
          addressValidation: v2AddressValidation,
        });

        if (!CALL_EXTRACTION_V2_DRIVES_ROUTING) {
          const shadowDecision = buildRouteDecision({
            callLogId: call.id,
            extraction: v2ExtractionForAudit,
            finalTriageFlags: finalFlags,
            routingResult,
            action: routingResult.allowed ? 'shadow_auto_route_candidate' : 'shadow_needs_review_candidate',
            mode: 'shadow',
          });
          await db('route_decisions')
            .insert(shadowDecision)
            .onConflict(['call_log_id', 'decision_version', 'mode'])
            .ignore()
            .catch((err) => logger.warn(`[call-proc-v2] Shadow route decision skipped for ${maskSid(callSid)}: ${err.message}`));
        }
      }

      const validationPayload = {
        validator: 'v2-1.0.0',
        mode: validationMode,
        extraction_status: v2Result.status || null,
        routing: routingResult ? {
          allowed: routingResult.allowed,
          reason: routingResult.reason || null,
          flags: finalFlags,
          appointment_blocking_flags: routingResult.appointmentBlockingFlags || [],
        } : null,
        address_validation_status: v2AddressValidation?.status || null,
        errors: v2Result.errors || null,
        generated_at: new Date().toISOString(),
      };

      await db('call_log').where({ id: call.id }).update({
        ai_validation: JSON.stringify(validationPayload),
        ai_validation_model: v2ExtractionForAudit?.meta?.extraction_model || GEMINI_EXTRACTION_MODEL,
        ai_validation_prompt_version: v2ExtractionForAudit?.meta?.extraction_prompt_version || PROMPT_HASH,
        ai_validation_schema_version: v2ExtractionForAudit?.meta?.schema_version || null,
        updated_at: new Date(),
      }).catch((err) => {
        logger.warn(`[call-proc] AI validation payload write skipped for ${maskSid(callSid)}: ${err.message}`);
      });
    }

    await writeLegacyShadowRouteDecision({
      call,
      extracted,
      customerId,
      leadId,
      finalStatus,
      appointmentResult,
      serviceResolution,
      hasSpecificTime,
      createdCustomerFromCall,
    });

    const finalized = await db('call_log')
      .where({ id: call.id })
      .where('processing_token', procToken)
      .update({
        processing_status: finalStatus,
        processing_token: null,
        processing_started_at: null,
        // Address unverifiable / caller-not-owner / missing surname, or a
        // customer-less recovery lead that failed to persist → open the call for
        // human review instead of letting it look fully processed.
        ...(bridgeNeedsConfirmation.length || finalStatus === 'lead_creation_failed' ? { review_status: 'open' } : {}),
        updated_at: new Date(),
      });
    if (finalized === 0) {
      logger.warn(`[call-proc] Skipped final status write for ${callSid} — ownership lost (peer reclaimed via stale-lock window).`);
    } else if (finalStatus === 'customer_creation_failed') {
      logger.warn(`[call-proc] Marked ${callSid} customer_creation_failed — required customer fields were incomplete`);
    }

    logger.info(`[call-proc] Completed processing for ${callSid}: customer=${customerId}, appointment=${!!extracted.appointment_confirmed}`);

    return {
      success: true,
      callSid,
      customerId,
      leadId,
      extracted,
      appointmentResult,
      newsletterResult,
      beehiivResult,
      voicemailSmsResult,
    };
    } catch (procErr) {
      logger.error(`[call-proc] Unhandled error processing ${callSid}: ${procErr.message}\n${procErr.stack || ''}`);
      try {
        // Fence on processing_token (owner-only column). If the 10-min stale
        // reclaim handed the lock to a peer, the peer's claim overwrote our
        // token and this UPDATE matches 0 rows — we log and bail without
        // disturbing the peer's lock or duplicating side effects.
        const released = await db('call_log')
          .where({ id: call.id })
          .where('processing_token', procToken)
          .update({
            processing_status: 'extraction_failed',
            processing_token: null,
            processing_started_at: null,
            updated_at: new Date(),
          });
        if (released === 0) {
          logger.warn(`[call-proc] Skipped lock release for ${callSid} — ownership lost (peer reclaimed via stale-lock window).`);
        }
      } catch (releaseErr) {
        logger.error(`[call-proc] Failed to release lock for ${callSid}: ${releaseErr.message}`);
      }
      throw procErr;
    }
  },

  /**
   * Process all unprocessed recordings.
   * Called from admin or cron.
   */
  async processAllPending() {
    // Eligibility: a row needs (re)processing if it has a recording AND any of:
    //   - processing_status NULL/pending OR transcription_status='pending' AND transcription
    //     IS NULL (fresh — gated by a 10-min CDN-settle age window so the cron can't beat
    //     the inline setTimeout in twilio-voice-webhook.js to a recording the Twilio CDN
    //     hasn't propagated yet, which produces 404s and partial-buffer downloads)
    //   - processing_status='no_transcription' (known-failed retry — no age gate, run promptly)
    //   - processing_status='processing' but stale > 10 min (orphaned claim from crash/hang)
    // Duration filter uses recording_duration_seconds (set by the recording-status webhook)
    // with duration_seconds fallback, since the call-status webhook may not have populated
    // the latter yet — earlier filter on duration_seconds alone excluded fresh recordings.
    const pending = await db('call_log')
      .where('recording_url', '!=', '')
      .whereNotNull('recording_url')
      .where(function () {
        this.where(function () {
          // Fresh / waiting branches — only after the 10-min CDN-settle window.
          // updated_at on these rows is the recording-status webhook timestamp
          // (or the Twilio transcription webhook if that fired first); either
          // way it tracks recording-land time, not call-start time, so it's a
          // tighter gate than created_at for long calls.
          this.where(function () {
            this.whereNull('processing_status')
              .orWhere('processing_status', 'pending')
              .orWhere(function () {
                this.where('transcription_status', 'pending').whereNull('transcription');
              });
          })
          .andWhere('updated_at', '<', db.raw("NOW() - INTERVAL '10 minutes'"));
        })
        .orWhere('processing_status', 'no_transcription')
        .orWhere(function () {
          this.where('processing_status', 'processing')
            .andWhereRaw("COALESCE(processing_started_at, updated_at) < NOW() - INTERVAL '10 minutes'");
        });
      })
      .where(db.raw('COALESCE(recording_duration_seconds, duration_seconds, 0) > ?', [10]))
      .orderBy('created_at', 'desc')
      .limit(20);

    const results = [];
    for (const call of pending) {
      try {
        const result = await this.processRecording(call.twilio_call_sid);
        results.push({ callSid: call.twilio_call_sid, ...result });
      } catch (err) {
        results.push({ callSid: call.twilio_call_sid, success: false, error: err.message });
      }
    }
    return { processed: results.length, results };
  },

  /**
   * Recover recordings Twilio created but the portal did not receive via the
   * Studio make-http-request / recording-status callback path.
   */
  async recoverRecordingForCall(callSid) {
    if (!callSid) return { success: false, reason: 'missing_call_sid' };

    const client = twilioClient();
    if (!client) return { success: false, reason: 'twilio_not_configured' };

    const call = await db('call_log').where('twilio_call_sid', callSid).first();
    if (!call) return { success: false, reason: 'call_not_found' };
    if (call.recording_url) return { success: true, skipped: true, reason: 'already_has_recording' };

    let recordings;
    try {
      recordings = await client.recordings.list({ callSid, limit: 10 });
    } catch (err) {
      logger.warn(`[call-proc] Recording recovery lookup failed for ${maskSid(callSid)}: ${err.message}`);
      return { success: false, reason: 'twilio_lookup_failed', error: err.message };
    }

    const recording = newestCompletedRecording(recordings);
    if (!recording) return { success: true, skipped: true, reason: 'no_completed_recording' };

    const url = recordingMediaUrl(recording);
    if (!url) return { success: false, reason: 'recording_url_missing' };

    const updated = await db('call_log')
      .where('twilio_call_sid', callSid)
      .where(function () {
        this.whereNull('recording_url').orWhere('recording_url', '');
      })
      .update({
        recording_url: url,
        recording_sid: recording.sid,
        recording_duration_seconds: parseInt(recording.duration || call.duration_seconds || 0),
        transcription_status: 'pending',
        processing_status: call.processing_status || null,
        updated_at: new Date(),
      });

    if (updated === 0) return { success: true, skipped: true, reason: 'already_recovered_by_peer' };

    logger.info(`[call-proc] Recovered missing recording for ${maskSid(callSid)} → ${maskSid(recording.sid)}`);
    return { success: true, recovered: true, recordingSid: recording.sid };
  },

  async recoverMissingRecentRecordings() {
    const rows = await db('call_log')
      .select('twilio_call_sid')
      .where({ direction: 'inbound', status: 'completed' })
      .where(function () {
        this.whereNull('recording_url').orWhere('recording_url', '');
      })
      .whereNotNull('twilio_call_sid')
      .where('created_at', '>=', db.raw("NOW() - INTERVAL '7 days'"))
      .where('created_at', '<=', db.raw("NOW() - INTERVAL '2 minutes'"))
      .where('duration_seconds', '>', 10)
      .orderBy('created_at', 'desc')
      .limit(25);

    const results = [];
    for (const row of rows) {
      try {
        results.push({ callSid: row.twilio_call_sid, ...(await this.recoverRecordingForCall(row.twilio_call_sid)) });
      } catch (err) {
        results.push({ callSid: row.twilio_call_sid, success: false, error: err.message });
      }
    }

    const recovered = results.filter((r) => r.recovered).length;
    if (recovered > 0) logger.info(`[call-proc] Recovered ${recovered} missing recent recording(s)`);
    return { checked: rows.length, recovered, results };
  },

  /**
   * Generate or regenerate lead synopsis for a single call.
   */
  async generateSynopsis(callSid) {
    const call = await db('call_log').where('twilio_call_sid', callSid).first();
    if (!call) throw new Error(`Call not found: ${callSid}`);
    if (!call.transcription) throw new Error('No transcription available');

    const synopsis = await generateLeadSynopsis(call.transcription);
    if (synopsis) {
      await db('call_log').where({ id: call.id }).update({ lead_synopsis: synopsis }).catch(e => logger.warn(`[call-proc] Non-critical op failed: ${e.message}`));
    }
    return { success: true, synopsis };
  },

  /**
   * Get processing stats.
   */
  async getStats() {
    const [totals] = await db('call_log').select(
      db.raw("COUNT(*) FILTER (WHERE recording_url IS NOT NULL) as total_recordings"),
      db.raw("COUNT(*) FILTER (WHERE processing_status = 'processed') as processed"),
      db.raw("COUNT(*) FILTER (WHERE processing_status IS NULL OR processing_status = 'pending') as pending"),
      db.raw("COUNT(*) FILTER (WHERE processing_status = 'voicemail') as voicemail"),
      db.raw("COUNT(*) FILTER (WHERE processing_status = 'spam') as spam"),
      db.raw("COUNT(*) FILTER (WHERE ai_extraction IS NOT NULL AND ai_extraction::text LIKE '%appointment_confirmed\": true%') as appointments"),
      db.raw("COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days' AND recording_url IS NOT NULL) as last_7d"),
      db.raw("COUNT(*) FILTER (WHERE processing_status = 'processed' AND customer_id IS NOT NULL AND ai_extraction IS NOT NULL AND ai_extraction::text NOT LIKE '%\"is_spam\": true%' AND ai_extraction::text NOT LIKE '%\"is_voicemail\": true%') as leads_extracted"),
    );

    // Source analytics: calls grouped by receiving number
    const sourceBreakdown = await db('call_log')
      .select('to_phone')
      .count('* as call_count')
      .whereNotNull('recording_url')
      .groupBy('to_phone')
      .orderBy('call_count', 'desc');

    return {
      totalRecordings: parseInt(totals.total_recordings || 0),
      processed: parseInt(totals.processed || 0),
      pending: parseInt(totals.pending || 0),
      voicemail: parseInt(totals.voicemail || 0),
      spam: parseInt(totals.spam || 0),
      appointments: parseInt(totals.appointments || 0),
      last7d: parseInt(totals.last_7d || 0),
      leadsExtracted: parseInt(totals.leads_extracted || 0),
      sourceBreakdown: sourceBreakdown.map(s => ({ number: s.to_phone, count: parseInt(s.call_count) })),
    };
  },
};

CallRecordingProcessor._test = {
  canonicalWavesService,
  referrerNameFromExtracted,
  resolveDefaultCallBookingTechnician,
  resolveDefaultCallBookingTechnicianId,
  resolveCallContactPhone,
  summarizeCustomerServiceContext,
  resolveSchedulableCallService,
  maskPhone,
  validatePhoneCallAppointmentCustomer,
  extractedNameMatchesCustomer,
  findCustomerForCallContact,
  normalizeCallExtraction,
  shouldCreateCallLeadForCustomer,
  findExistingCallAppointment,
  classifyCallerAccount,
  summarizeKnownCaller,
  isNonLeadCallContent,
  leadContactCompleteness,
  hasWorkableLeadSignal,
  transcribeRecording,
  extractCallDataV2,
  normalizeOpenAISegments,
  convertCallLeadOnPhoneBooking,
  findReusableCallLead,
  resolveCallAdditionalProperties,
  resolveCallQuoteSignals,
  resolveCallSecondaryContact,
  persistCallSecondaryContact,
  v2IsoToEtWallClock,
  phoneNearMissOfAni,
  isUsableContactPhone,
  labeledTranscriptPreservesWords,
};

module.exports = CallRecordingProcessor;
