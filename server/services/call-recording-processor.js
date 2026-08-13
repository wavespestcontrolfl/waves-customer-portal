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
const { lockTriageCall } = require('../utils/triage-locks');
const { resolveLocation } = require('../config/locations');
const { parseETDateTime, formatETDate, formatETTime, etDateString, etParts } = require('../utils/datetime-et');
const { promoteCustomerOnBooking } = require('./customer-stages');
const { normalizeCallExtraction, applyContactNormalization } = require('../utils/intake-normalize');
const { composeServiceInterest, composeWordsForV2Category, v2PrimaryLabelForCategory, labelIsSpecialtyPestFamily, hasTermiteWorkCue, v2InexpressibleFamilyWords } = require('../utils/lead-service-interest');
const { properCase } = require('../utils/name-case');
const { validateModelOutput, validatePersisted, SCHEMA_VERSION } = require('../schemas/validate-extraction');
const { normalizeExtractionV2 } = require('../utils/normalize-extraction-v2');
const { scrubPansDetailed, scrubSegments } = require('../utils/pan-scrub');
const { buildExtractionPrompt, buildPriorCallBlock, extractionPromptVersion, PROMPT_HASH } = require('./prompts/call-extraction-v1');
const { dispatchWithFallback } = require('./llm/call');
const { writeLegacyShadowRouteDecision } = require('./call-route-decisions');
const { stageCustomerFieldCandidates } = require('./call-field-candidates');
const modelOutputSchema = require('../schemas/call-extraction.model-output.schema.json');

const CALL_EXTRACTION_V2_ENABLED = process.env.CALL_EXTRACTION_V2_ENABLED === 'true';
const CALL_EXTRACTION_V2_DRIVES_ROUTING =
  process.env.CALL_EXTRACTION_V2_DRIVES_ROUTING === 'true'
  || process.env.CALL_TRIAGE_ENFORCE_V2_GATES === 'true';
// V2-PRIMARY (owner promotion 2026-07-23): when ON and the V2 extraction is
// valid, adoptV2PrimaryFields() makes V2 the driver for the canonical
// customer/lead writes (adoption site right below the shadow-extraction
// block). Appointment auto-create and every SMS stay behind their existing
// gates (canAutoRoute / evaluateV2AppointmentGate / TCPA). REQUIRES enforce
// mode (DRIVES_ROUTING): demoting routing to shadow demotes adoption with it,
// so "shadow" always means the full legacy V1 drive — V2 must never book or
// mint records in a mode whose routing gate (canAutoRoute → v2RoutingBlocked)
// isn't running (codex P1, PR #2972). Kill switch for adoption alone:
// CALL_EXTRACTION_V2_PRIMARY=false. Read per call so a Railway var flip
// demotes without waiting on anything else.
function callExtractionV2PrimaryEnabled() {
  return CALL_EXTRACTION_V2_ENABLED
    && CALL_EXTRACTION_V2_DRIVES_ROUTING
    && process.env.CALL_EXTRACTION_V2_PRIMARY !== 'false';
}
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
const { computeDeterministicTriageFlags, mergeTriageFlags, suppressAddressFlagsForAV, canAutoRoute, hasCanonicalWriteBlock, deriveCallReviewBridge, deriveEmailReview, mergeNeedsConfirmation, detectRentalSignal, normalizeCounty, ADVISORY_TRIAGE_FLAGS, FAIL_OPEN_KNOWN_CUSTOMER_ADDRESS_FLAGS, streetCompareKey, isMissingUnitNumber } = require('./call-triage-flags');
const { recoverStreetAddress, RECOVERABLE_STATUSES } = require('./address-validation/recovery');
const { detectContactDictationSignals, decodeDictatedContacts, applyEmailDictationPolicy, CONTACT_DICTATION_TRANSCRIPTION_PROMPT } = require('./contact-dictation');
const { arbitrateQuarantinedEmail } = require('./contact-quarantine-arbiter');
const { computeAppointmentIdempotencyKey, computeAddressHash, checkTcpaConsent, buildRouteDecision, buildTriageItem, V2_DECISION_VERSION } = require('./call-routing-gates');
// Zero-triage layers (2026-07-10) — all dark-gated in feature-gates.js.
const { isEnabled } = require('../config/feature-gates');
const { decideDisposition } = require('./call-disposition');
const { classifyCall, recordVerdict } = require('./call-spam-classifier');
const { enrichFromCall } = require('./call-profile-enrichment');
const { isV2Extraction, flatView, adoptV2PrimaryFields, EXTRACTION_INVALID_JSON_SUMMARY } = require('../utils/extraction-compat');
const { loadBookableCallServices, loadCallReServiceRows, hasCallReServiceIntent, isReServiceCatalogRow, reServiceLaneForRow, resolveCallBookingCatalogService, resolveCallBookingPrice, resolveCallFollowUpPlan, callBookingInvoiceOnComplete, callFollowUpBillingShape, callBookingDateOnly } = require('./call-booking-catalog');
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

// Time-sanity screen for transcript-parsed booking times (advisory only —
// NEVER a block: owner's call is to book exactly as before and flag for
// review). The transcript parse has no clamp, so "Sunday 7pm" books 19:00
// verbatim; these flags put that on a triage card instead of leaving it to
// be discovered on the dispatch board. Bounds mirror the self-booking
// surfaces' working day (booking_config defaults 08:00–17:00 ET).
const CALL_BOOKING_DAY_START_MIN = 8 * 60;
const CALL_BOOKING_DAY_END_MIN = 17 * 60;
function callBookingTimeMinutes(value) {
  if (!value) return null;
  const [h, m] = String(value).split(':').map(Number);
  if (!Number.isFinite(h)) return null;
  return h * 60 + (Number.isFinite(m) ? m : 0);
}

/**
 * @param {object}  args
 * @param {string} [args.scheduledDate]     'YYYY-MM-DD'
 * @param {string} [args.windowStart]       'HH:MM'
 * @param {string} [args.windowEnd]         'HH:MM' — preferred end source.
 * @param {number} [args.durationMinutes]   fallback when windowEnd is absent
 *                                          (defaults to the catalog default).
 */
function callBookingTimeSanityFlags({
  scheduledDate,
  windowStart,
  windowEnd,
  durationMinutes,
} = {}) {
  const flags = [];
  if (scheduledDate) {
    try {
      const dow = etParts(parseETDateTime(`${String(scheduledDate).split('T')[0]}T12:00`)).dayOfWeek;
      if (dow === 0 || dow === 6) flags.push('weekend');
    } catch { /* unparseable date — the booking guards upstream own that */ }
  }
  const startMin = callBookingTimeMinutes(windowStart);
  if (startMin != null) {
    const startOutside = startMin < CALL_BOOKING_DAY_START_MIN
      || startMin >= CALL_BOOKING_DAY_END_MIN;
    if (startOutside) flags.push('outside_business_hours');
    // A start INSIDE the working day still runs past close when the visit is
    // long enough: a 60-minute booking at 16:30 ends at 17:30. Checking only
    // the start let every one of those through clean. Only raised when the
    // start itself passed — a 19:00 start is already flagged above and a
    // second flag for its equally-late end is noise on the same card.
    if (!startOutside) {
      const explicitEnd = callBookingTimeMinutes(windowEnd);
      const duration = Number(durationMinutes) > 0
        ? Number(durationMinutes)
        : DEFAULT_CALL_BOOKING_DURATION_MINUTES;
      // An end at or before start (parse noise, or a window crossing
      // midnight) is not evidence of an overrun — fall back to the duration.
      const endMin = explicitEnd != null && explicitEnd > startMin
        ? explicitEnd
        : startMin + duration;
      if (endMin > CALL_BOOKING_DAY_END_MIN) flags.push('ends_after_business_hours');
    }
  }
  return flags;
}

// AUTHORITATIVE post-commit conflict recheck for a fresh call booking — a
// short rung-1 transaction of its own: date lock(s) + one shared-module
// read PER ROW the call created, no row locks, nothing written. The in-txn
// advisory read races unlocked:
// two concurrent call bookings — or a call booking interleaving a rung-1
// writer whose global predicate ran before this insert committed — can EACH
// see no committed conflict and land overlapping rows with no card fired.
// Serializing just the CHECK closes that. Every committing scheduling writer
// runs the global predicate under the date lock before committing (ORDERING
// CONTRACT, scheduling/occupancy.js), so by the time this lock is granted a
// concurrent writer either already saw this booking's committed row (and
// aborted its own commit — no overlap exists) or committed first and is
// visible to this read (card fires). Of two concurrent call bookings, the
// later recheck always sees the earlier insert. Detection-only: the booking
// already committed and is never unwound here (owner's book+flag rule).
//
// `visits` is one entry per row THIS call created — the primary, plus the
// auto-created follow-up child when there is one: the primary's date/window
// says nothing about an overlap on the follow-up's OWN date (typically
// +14d), so each row is rechecked against its own scheduled_date/window.
// Rung-1 keys are taken one per DISTINCT date, ascending
// (acquireOccupancyLocks — the contract's multi-date rule), before any
// read; every probe excludes ALL of this call's fresh rows (the row being
// checked plus its siblings). excludeCustomerId applies to the PRIMARY
// probe ONLY: the booking txn's same-customer same-day hold
// (existing_appointment_same_date) vets exactly one date — the primary's —
// so only there are the customer's own rows already handled. The follow-up
// lands on a date that guard never looked at, where the customer's
// existing visit is a real, reportable clash — customer-excluding it left
// that card unfired. Each finding is annotated with WHICH created visit it
// clashes (overlaps_visit: 'primary'|'follow_up' + overlaps_service_id)
// plus same_customer (only reachable on non-primary probes) so the triage
// card can say. The bare single-date arguments remain supported as the
// one-visit form.
async function recheckCallBookingConflicts({
  visits,
  scheduledDate,
  windowStart,
  windowEnd,
  excludeCustomerId,
  excludeServiceIds,
}) {
  const { acquireOccupancyLocks, findConflictingVisits } = require('./scheduling/occupancy');
  const targets = (Array.isArray(visits) && visits.length ? visits : [
    { role: 'primary', scheduledDate, windowStart, windowEnd },
  ]).filter((v) => v && v.scheduledDate && v.windowStart && v.windowEnd);
  if (!targets.length) return [];
  const freshRowIds = [...new Set([
    ...(excludeServiceIds || []),
    ...targets.map((v) => v.id),
  ].filter(Boolean))];
  return db.transaction(async (trx) => {
    await acquireOccupancyLocks(trx, targets.map((v) => v.scheduledDate));
    const findings = [];
    for (const visit of targets) {
      const isPrimary = (visit.role || 'primary') === 'primary';
      const rows = await findConflictingVisits({
        db: trx,
        date: visit.scheduledDate,
        windowStart: visit.windowStart,
        windowEnd: visit.windowEnd,
        // PRIMARY-ONLY (see header): the in-txn same-day guard owns
        // same-customer semantics for the primary's date alone. A follow-up
        // probe keeps the customer's rows in view — its own fresh siblings
        // are still excluded via freshRowIds below.
        excludeCustomerId: isPrimary ? excludeCustomerId : null,
        excludeServiceIds: freshRowIds,
      });
      for (const row of rows) {
        findings.push({
          ...row,
          overlaps_visit: visit.role || 'primary',
          overlaps_service_id: visit.id || null,
          // Same-customer marker for the card copy. Only non-primary probes
          // can surface one (the primary excludes the customer's rows).
          same_customer: excludeCustomerId != null && row.customer_id != null
            && String(row.customer_id) === String(excludeCustomerId),
        });
      }
    }
    return findings;
  });
}
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
// Literal keyword hints for the gpt-transcribe family (the gpt-4o-transcribe
// generation rejects the parameter, hence the model guard below). These are
// the proper nouns prod transcripts have actually misheard — service-area
// place names ("Englewood" → "Inglewood") and product/brand terms.
const DEFAULT_TRANSCRIPTION_KEYWORDS = [
  'Waves Pest Control', 'WaveGuard', 'Sentricon', 'Termidor', 'WDO',
  'Bradenton', 'Sarasota', 'Venice', 'Parrish', 'Palmetto', 'Ellenton',
  'Englewood', 'North Port', 'Port Charlotte', 'Lakewood Ranch', 'Myakka',
];
const ENV_TRANSCRIPTION_KEYWORDS = String(process.env.OPENAI_TRANSCRIPTION_KEYWORDS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

function transcriptionKeywords() {
  return ENV_TRANSCRIPTION_KEYWORDS.length ? ENV_TRANSCRIPTION_KEYWORDS : DEFAULT_TRANSCRIPTION_KEYWORDS;
}

function modelSupportsKeywordHints(model) {
  const m = String(model || '');
  return m === 'gpt-transcribe' || m.startsWith('gpt-transcribe-')
    || m === 'gpt-live-transcribe' || m.startsWith('gpt-live-transcribe-');
}
// Default tracks the newest stable Flash: Google retired gemini-2.5-flash
// (rolling 404 brown-outs starting 2026-07-09), so a dead default here means
// the fallback transcriber fails exactly when OpenAI needs it.
const GEMINI_TRANSCRIPTION_MODEL = process.env.GEMINI_TRANSCRIPTION_MODEL || 'gemini-3.5-flash';
// Gemini-leg model for the V2 extraction route below (also the legacy env
// name, kept so an existing GEMINI_EXTRACTION_MODEL override still governs
// the gemini leg). NOTE: the dictation decoder and street recovery have
// their own vars (GEMINI_CONTACT_DECODER_MODEL / GEMINI_RECOVERY_MODEL)
// with literal defaults, so an extraction rollback never silently degrades
// the mishear-recovery lanes.
const GEMINI_EXTRACTION_MODEL = process.env.GEMINI_EXTRACTION_MODEL || 'gemini-2.5-pro';
// V2 extraction route — owner-locked 2026-07-18 off the 25-call bake-off run
// through the EXACT V2 contract (identical prompt + ajv validate + normalize):
// gpt-5.6-sol led consensus agreement 97.8% with 25/25 contract-valid vs the
// gemini-2.5-pro incumbent's 91.7% (last place, dragged by a 24% phone-field
// agreement). Claude Opus 4.8 is the cross-provider fallback per the house
// automatic-fallback-to-Claude rule, with schema validation running INSIDE
// the dispatcher so contract-invalid primary output fails over instead of
// failing the call. Defaults are PINNED per provider (never tier or
// report-writer aliases — an ops change to another lane's model env must not
// silently swap the extractor). Kill switch: CALL_EXTRACTION_PROVIDER=gemini
// ALONE restores the Gemini leg (via llm/call.js, same greedy temp-0 JSON
// mode) — model overrides are PER-PROVIDER (CALL_EXTRACTION_MODEL = the
// OpenAI leg only, MODEL_CALL_EXTRACTION_ANTHROPIC = the Claude leg,
// GEMINI_EXTRACTION_MODEL = the Gemini leg), so a lingering OpenAI model
// override can never ride along into another provider during a rollback.
// A typo'd provider must not brick the route (unknown provider → dispatch
// rejects every leg → not_run → every call held for triage). Fail OPEN to
// the bake-off-winning default with a loud error, never fail closed.
const RAW_EXTRACTION_PROVIDER = process.env.CALL_EXTRACTION_PROVIDER || 'openai';
const CALL_EXTRACTION_PROVIDER = ['openai', 'anthropic', 'gemini'].includes(RAW_EXTRACTION_PROVIDER)
  ? RAW_EXTRACTION_PROVIDER
  : 'openai';
if (CALL_EXTRACTION_PROVIDER !== RAW_EXTRACTION_PROVIDER) {
  logger.error(`[call-proc-v2] CALL_EXTRACTION_PROVIDER "${RAW_EXTRACTION_PROVIDER}" is not openai|anthropic|gemini — using openai`);
}
const CALL_EXTRACTION_MODEL_FOR = {
  openai: process.env.CALL_EXTRACTION_MODEL || 'gpt-5.6-sol',
  anthropic: MODELS.CALL_EXTRACTION_ANTHROPIC,
  gemini: GEMINI_EXTRACTION_MODEL,
};
const CALL_EXTRACTION_ROUTE = Object.freeze({
  // Stable dispatch-metrics identity — the resolved routes can coincide with
  // other lanes' (call-research shares the Sol primary by default).
  name: 'callExtraction',
  primary: Object.freeze({
    provider: CALL_EXTRACTION_PROVIDER,
    model: CALL_EXTRACTION_MODEL_FOR[CALL_EXTRACTION_PROVIDER] || CALL_EXTRACTION_MODEL_FOR.openai,
  }),
  fallback: CALL_EXTRACTION_PROVIDER === 'anthropic'
    ? Object.freeze({ provider: 'openai', model: CALL_EXTRACTION_MODEL_FOR.openai })
    : Object.freeze({ provider: 'anthropic', model: MODELS.CALL_EXTRACTION_ANTHROPIC }),
});
// V1 (legacy) extractor model — historically hardcoded in the request URL,
// which made V1 the only lane without a zero-deploy rollback lever.
// 2026-07-09: the old gemini-2.5-flash default 404'd (model retired by
// Google) and six calls died unprocessed — keep this on a live model.
const GEMINI_EXTRACTION_V1_MODEL = process.env.GEMINI_EXTRACTION_V1_MODEL || 'gemini-3.5-flash';

// Transcription-hallucination guard (2026-07-10). The Gemini fallback
// transcriber can invent a full conversation from a near-empty voicemail —
// observed live: a 5-second recording produced 4,777 characters of a
// fabricated "Amanda" pest-control call, which then minted a phantom
// estimate_send lead and slipped past the spam classifier as legit content.
// Human speech averages ~12-15 chars/sec; 25 is a hard ceiling no real
// recording reaches, so a transcript whose length is physically impossible
// for its recording duration is a hallucination. Applied only to transcripts
// long enough to matter, and only when the recording duration is known.
const MAX_TRANSCRIPT_CHARS_PER_SECOND = Number(process.env.CALL_MAX_TRANSCRIPT_CHARS_PER_SEC || 25);
const MIN_TRANSCRIPT_CHARS_FOR_GUARD = 120;
const TRANSCRIPTION_REJECTED_SENTINEL = '[Recording had no usable speech; an implausible transcription was rejected.]';

// PAN redaction guard (card-on-file spec Phase 0). One transcription pass
// yields up to three artifacts carrying the same audio — the labeled
// transcript string, the diarized segment array, and the dictation-focused
// contact-pass string — so a blurted card number must be scrubbed from all
// three together or it survives in transcript_structured / the dictation
// decoder prompt. Returns new values plus the total mask count (for a
// PAN-free log line); never throws (scrubPansDetailed passes non-strings
// through untouched).
function scrubTranscriptArtifacts({ transcription, contactPassTranscript, segments } = {}) {
  let count = 0;
  const main = scrubPansDetailed(transcription);
  count += main.count;
  const contactPass = scrubPansDetailed(contactPassTranscript);
  count += contactPass.count;
  const segScrub = scrubSegments(segments);
  count += segScrub.count;
  return {
    transcription: main.text,
    contactPassTranscript: contactPass.text,
    segments: segScrub.segments,
    count,
  };
}

// Scrub a persisted transcript_structured JSON blob (segments +
// contact_pass_transcript) — the fallback-heal path touches legacy rows
// whose structured artifact may predate the PAN guard, and healing only
// call_log.transcription would leave the raw card number stored in the
// sibling column (Codex #2676 round-2 P1). Returns { json, count }; a
// null/unparseable blob passes through untouched.
function scrubStructuredTranscript(json) {
  if (!json) return { json, count: 0 };
  let parsed;
  try {
    parsed = typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    return { json, count: 0 };
  }
  if (!parsed || typeof parsed !== 'object') return { json, count: 0 };
  let count = 0;
  if (Array.isArray(parsed.segments)) {
    const segScrub = scrubSegments(parsed.segments);
    parsed.segments = segScrub.segments;
    count += segScrub.count;
  }
  if (typeof parsed.contact_pass_transcript === 'string') {
    const s = scrubPansDetailed(parsed.contact_pass_transcript);
    count += s.count;
    if (s.count) parsed.contact_pass_transcript = s.text;
  }
  return { json: count ? JSON.stringify(parsed) : json, count };
}

// ── PAN quarantine ── Spec invariant #1: card data may not persist in ANY
// medium, including audio. When the scrub masks card data from a call's
// transcript, the RECORDING still carries it and stays replayable from the
// message thread — so the Twilio recording is deleted, our references are
// stripped (call_log.recording_url + the voice message's media), and the
// detection is stamped into transcription_metadata. Best-effort and
// idempotent: a failed Twilio delete still strips local references, and the
// office gets a heads-up either way (a quarantined recording is an
// exception a human should know about, never a silent event).
async function quarantineCardRecording(call, { source = 'transcript_scrub' } = {}) {
  if (!call?.id) return { quarantined: false };
  const recordingUrl = call.recording_url || null;
  const sid = call.recording_sid
    || (recordingUrl && (recordingUrl.match(/\/Recordings\/(RE[a-f0-9]{32})/i) || [])[1])
    || null;
  let twilioDeleted = false;
  if (sid) {
    try {
      const client = twilioClient();
      if (client) {
        await client.recordings(sid).remove();
        twilioDeleted = true;
      }
    } catch (err) {
      logger.error(`[call-proc] PAN quarantine: Twilio recording delete failed for ${maskSid(sid)}: ${err.message}`);
    }
  }
  let alreadyQuarantined = false;
  try {
    const row = await db('call_log').where({ id: call.id }).first('transcription_metadata');
    // jsonb columns come back as OBJECTS from Postgres, strings from mocks/
    // sqlite — handle both or a quarantine would clobber the provider/source
    // metadata instead of merging (Codex #2676 round-4 P2).
    const raw = row?.transcription_metadata;
    let meta = {};
    try {
      meta = typeof raw === 'string' ? JSON.parse(raw) : (raw && typeof raw === 'object' ? raw : {});
    } catch { meta = {}; }
    // pan_detected can now be stamped BEFORE the first quarantine call
    // (same-write stamps in the webhook/fallback paths), so it no longer
    // implies the office was alerted — pan_notified is the notify guard,
    // and it is stamped ONLY AFTER the alert actually sends (round-17 P2:
    // stamping it in this update meant a failed/interrupted notifyAdmin
    // was never retried and the office never heard about the quarantine).
    alreadyQuarantined = meta.pan_notified === true;
    await db('call_log').where({ id: call.id }).update({
      recording_url: null,
      transcription_metadata: JSON.stringify({
        ...meta,
        pan_detected: true,
        recording_quarantined: twilioDeleted || meta.recording_quarantined === true,
        quarantine_source: meta.quarantine_source || source,
        // A failed Twilio delete must not lose the only SID a later retry
        // needs — recovery's incomplete-quarantine retry reads it back
        // (round-13 P1). Cleared-URL rows otherwise have nothing to retry.
        ...(sid && !twilioDeleted ? { quarantine_recording_sid: sid } : {}),
      }),
      updated_at: new Date(),
    });
  } catch (err) {
    logger.error(`[call-proc] PAN quarantine: call_log strip failed for call ${call.id}: ${err.message}`);
  }
  // Clear the recording media already synced onto the unified voice message
  // — recording_url null keeps the helper from re-adding it, and the
  // explicit media:null patch removes what an earlier sync attached.
  try {
    await updateUnifiedVoiceMessage({ ...call, recording_url: null }, { media: null });
  } catch { /* best-effort */ }
  // One office heads-up per call, however many detection points re-run the
  // quarantine (wrapper + choke + backfill are all idempotent on the strip).
  if (!alreadyQuarantined) {
    try {
      await require('./notification-service').notifyAdmin(
        'billing',
        'Card number heard on a recorded call',
        'A card number was detected in a call transcript. The transcript was masked and the recording was quarantined — remind callers we never take card numbers by phone; text the secure link instead.',
        { link: call.customer_id ? `/admin/customers/${call.customer_id}` : '/admin/communications', metadata: { callId: call.id, twilioDeleted, source } },
      );
      // Alert DELIVERED — only now mark it, so a failed/interrupted send
      // retries on the next quarantine/recovery touch (round-17 P2).
      try {
        const fresh = await db('call_log').where({ id: call.id }).first('transcription_metadata');
        const rawFresh = fresh?.transcription_metadata;
        let freshMeta = {};
        try { freshMeta = typeof rawFresh === 'string' ? JSON.parse(rawFresh) : (rawFresh && typeof rawFresh === 'object' ? rawFresh : {}); } catch { freshMeta = {}; }
        await db('call_log').where({ id: call.id }).update({
          transcription_metadata: JSON.stringify({ ...freshMeta, pan_notified: true }),
          updated_at: new Date(),
        });
      } catch (stampErr) {
        logger.warn(`[call-proc] pan_notified stamp failed (a duplicate alert may follow): ${stampErr.message}`);
      }
    } catch (e) { logger.warn(`[call-proc] PAN quarantine notify failed: ${e.message}`); }
  }
  return { quarantined: true, twilioDeleted, alreadyQuarantined };
}

// PAN-quarantine stamps are DURABLE (Codex #2676 round-9 P1): the recovery
// sweep and the recording-status webhook key off
// transcription_metadata.pan_detected, so any later metadata overwrite
// (fallback provenance, the implausible-rejection sentinel) must carry the
// stamps forward — a provider-return quarantine followed by a Twilio
// fallback write would otherwise erase the stamp and let a delayed
// callback reattach the card audio. Read-merge just before the write; on a
// read failure the metadata is written as-is (quarantine re-runs are
// idempotent and re-stamp on the next touch).
async function withPanStamps(callId, metadata) {
  const out = { ...(metadata || {}) };
  try {
    const row = await db('call_log').where({ id: callId }).first('transcription_metadata');
    const raw = row?.transcription_metadata;
    let prior = {};
    try {
      prior = typeof raw === 'string' ? JSON.parse(raw) : (raw && typeof raw === 'object' ? raw : {});
    } catch { prior = {}; }
    if (prior.pan_detected === true) {
      out.pan_detected = true;
      if (prior.recording_quarantined === true) out.recording_quarantined = true;
      if (prior.quarantine_source && !out.quarantine_source) out.quarantine_source = prior.quarantine_source;
      if (prior.pan_count && !out.pan_count) out.pan_count = prior.pan_count;
      // The retry SID and the notify marker are load-bearing (round-14 P1):
      // dropping quarantine_recording_sid on a later provenance write
      // leaves recovery with nothing to retry a failed Twilio delete
      // against, and dropping pan_notified re-fires the office alert.
      if (prior.quarantine_recording_sid && !out.quarantine_recording_sid) out.quarantine_recording_sid = prior.quarantine_recording_sid;
      if (prior.pan_notified === true) out.pan_notified = true;
    }
  } catch (err) {
    logger.warn(`[call-proc] pan-stamp merge failed for call ${callId}: ${err.message}`);
  }
  return out;
}

// Spoken-content length only: strip diarization speaker labels and collapse
// whitespace so a valid short diarized call's formatting overhead ("Agent:",
// "Caller:", newlines) can't push it over the ceiling. Labels first (line-
// anchored), then whitespace-collapse.
function spokenCharCount(transcription) {
  return String(transcription || '')
    .replace(/^\s*(?:agent|caller|customer|speaker\s*\d+)\s*:/gim, '')
    .replace(/\s+/g, ' ')
    .trim().length;
}

function isImplausibleTranscript(transcription, recordingSeconds) {
  const chars = spokenCharCount(transcription);
  if (chars < MIN_TRANSCRIPT_CHARS_FOR_GUARD) return false;
  // Unknown/zero duration → never reject (fail open; never drop a real transcript).
  if (!recordingSeconds || recordingSeconds <= 0) return false;
  return (chars / recordingSeconds) > MAX_TRANSCRIPT_CHARS_PER_SECOND;
}

// AI-extraction retry budget. A failure marks the row extraction_failed and
// increments call_log.extraction_attempts; processAllPending re-runs it while
// under this cap (≥10 min between attempts via the sweep's age gate), which
// rides out transient provider errors. At the cap a blocking triage item is
// filed so the call can't die silently.
const CALL_EXTRACTION_MAX_ATTEMPTS = Math.max(1, parseInt(process.env.CALL_EXTRACTION_MAX_ATTEMPTS || '3', 10) || 3);

// Human-readable "confirm before dispatch" reasons surfaced by the address /
// identity bridge below. Shown on the lead's AI-triage activity so Virginia
// knows exactly what to verify on the callback, instead of dispatching on a
// silently-unverified address or an incomplete account holder.
const CONFIRM_REASON_TEXT = {
  address_unverified: 'service address could not be verified — read it back to the caller',
  missing_unit_number: 'address is a multi-unit building (condo/townhome) given without a unit — ask which unit number before dispatch',
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
  caller_phone_not_on_file: "caller's number isn't on the matched account — confirm it's really them, then save the number to the account",
  call_dropped_mid_intake: 'the call dropped mid-conversation before the address was captured — check the review card for the text/contact outcome before any outreach',
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

// Common NANP nickname/diminutive groups — "Bob" calling from a line whose
// record says "Robert" is the same person for phone-scoped matching (the
// phone already narrows candidates to one household/office; last-name
// agreement is still enforced where both are known).
const NICKNAME_GROUPS = [
  ['robert', 'rob', 'bob', 'bobby', 'robbie'],
  ['william', 'will', 'bill', 'billy', 'willie', 'liam'],
  ['michael', 'mike', 'mikey', 'mick'],
  ['james', 'jim', 'jimmy', 'jamie'],
  ['thomas', 'tom', 'tommy'],
  ['david', 'dave', 'davey'],
  ['daniel', 'dan', 'danny'],
  ['christopher', 'chris', 'topher'],
  ['christine', 'christina', 'chris', 'chrissy', 'tina'],
  ['katherine', 'catherine', 'kate', 'kathy', 'cathy', 'katie', 'kat', 'kitty'],
  ['elizabeth', 'liz', 'beth', 'lizzie', 'eliza', 'betsy'],
  ['margaret', 'peggy', 'meg', 'maggie', 'marge'],
  ['john', 'jack', 'johnny', 'jon'],
  ['jonathan', 'jon', 'johnny'],
  ['richard', 'rick', 'rich', 'dick', 'ricky'],
  ['anthony', 'tony'],
  ['steven', 'stephen', 'steve'],
  ['joseph', 'joe', 'joey'],
  ['samuel', 'sam', 'sammy'],
  ['samantha', 'sam', 'sammy'],
  ['alexander', 'alex', 'al'],
  ['alexandra', 'alex', 'lexi', 'sandra'],
  ['matthew', 'matt'],
  ['andrew', 'andy', 'drew'],
  ['gregory', 'greg'],
  ['jeffrey', 'jeff'],
  ['edward', 'ed', 'eddie', 'ted', 'ned'],
  ['ronald', 'ron', 'ronnie'],
  ['donald', 'don', 'donnie'],
  ['kenneth', 'ken', 'kenny'],
  ['lawrence', 'larry'],
  ['gerald', 'jerry'],
  ['terrence', 'terry'],
  ['patrick', 'pat', 'paddy'],
  ['patricia', 'pat', 'patty', 'trish', 'tricia'],
  ['susan', 'sue', 'susie', 'suzy'],
  ['deborah', 'debra', 'deb', 'debbie'],
  ['barbara', 'barb', 'babs'],
  ['jennifer', 'jen', 'jenny'],
  ['jessica', 'jess', 'jessie'],
  ['victoria', 'vicky', 'tori'],
  ['nicholas', 'nick', 'nicky'],
  ['timothy', 'tim', 'timmy'],
  ['benjamin', 'ben', 'benny'],
  ['charles', 'charlie', 'chuck', 'chas'],
  ['frederick', 'fred', 'freddie'],
  ['raymond', 'ray'],
  ['walter', 'walt', 'wally'],
  ['harold', 'hal', 'harry'],
  ['henry', 'hank', 'harry'],
  ['francis', 'frank', 'frankie'],
  ['frances', 'fran', 'frannie'],
  ['dorothy', 'dot', 'dottie'],
  ['florence', 'flo'],
  ['virginia', 'ginny', 'ginger'],
  ['pamela', 'pam'],
  ['cynthia', 'cindy'],
  ['sandra', 'sandy'],
  ['linda', 'lindy'],
  ['rebecca', 'becky', 'becca'],
  ['kimberly', 'kim'],
  ['michelle', 'shelly'],
  ['stephanie', 'steph'],
  ['melissa', 'mel', 'missy'],
  ['amanda', 'mandy'],
  ['abigail', 'abby'],
  ['gabriel', 'gabe'],
  ['gabriella', 'gabby'],
  ['isabella', 'izzy', 'bella'],
  ['zachary', 'zach', 'zack'],
  ['joshua', 'josh'],
  ['nathaniel', 'nathan', 'nate', 'nat'],
  ['leonard', 'leo', 'lenny'],
  ['theodore', 'ted', 'theo', 'teddy'],
  ['albert', 'al', 'bert'],
  ['arthur', 'art', 'artie'],
  ['eugene', 'gene'],
  ['vincent', 'vince', 'vinny'],
  ['peter', 'pete'],
  ['philip', 'phil'],
  ['douglas', 'doug'],
  ['russell', 'russ', 'rusty'],
  ['martin', 'marty'],
  ['stanley', 'stan'],
  ['norman', 'norm'],
  ['dennis', 'denny'],
  ['glenn', 'glen'],
  ['carolyn', 'caroline', 'carol', 'carrie'],
  ['eleanor', 'ellie', 'nora'],
  ['emily', 'em', 'emmy'],
  ['natalie', 'nat'],
  ['angela', 'angie'],
  ['brenda', 'bren'],
  ['sharon', 'shari'],
  ['diane', 'diana', 'di'],
  ['janet', 'jan'],
  ['janice', 'jan'],
  ['judith', 'judy'],
  ['carol', 'carole'],
  ['ann', 'anne', 'annie', 'anna'],
  ['mary', 'marie', 'maria', 'molly', 'polly'],
  ['martha', 'marty', 'mattie'],
  ['helen', 'nell', 'nellie'],
  ['ruth', 'ruthie'],
  ['gerald', 'gerry'],
  ['gordon', 'gordy'],
  ['leslie', 'les'],
  ['wesley', 'wes'],
  ['curtis', 'curt'],
  ['calvin', 'cal'],
  ['bernard', 'bernie'],
  ['clifford', 'cliff'],
  ['duane', 'dwayne'],
  ['randall', 'randy'],
  ['rodney', 'rod'],
  ['roger', 'rodge'],
  ['bradley', 'brad'],
  ['brandon', 'bran'],
  ['jacob', 'jake'],
  ['lucas', 'luke'],
  ['maxwell', 'max'],
  ['oliver', 'ollie'],
  ['sebastian', 'seb'],
  ['veronica', 'ronnie'],
  ['gwendolyn', 'gwen'],
  ['jacqueline', 'jackie'],
  ['josephine', 'jo', 'josie'],
  ['kathleen', 'kathy', 'kate'],
  ['lillian', 'lily'],
  ['madeline', 'maddie'],
  ['penelope', 'penny'],
  ['priscilla', 'cilla'],
  ['rosemary', 'rose', 'rosie'],
  ['suzanne', 'sue', 'suzy'],
  ['valerie', 'val'],
  ['yvonne', 'vonnie'],
];
const NICKNAME_LOOKUP = new Map();
for (const group of NICKNAME_GROUPS) {
  for (const name of group) {
    const set = NICKNAME_LOOKUP.get(name) || new Set();
    for (const variant of group) set.add(variant);
    NICKNAME_LOOKUP.set(name, set);
  }
}
function firstNameVariants(normalizedFirst) {
  const variants = NICKNAME_LOOKUP.get(normalizedFirst);
  return variants ? [...variants] : [normalizedFirst];
}
function sameFirstName(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const variants = NICKNAME_LOOKUP.get(a);
  return !!variants && variants.has(b);
}

function extractedNameMatchesCustomer(extracted = {}, customer = {}) {
  const extractedFirst = normalizeNamePart(extracted.first_name);
  const customerFirst = normalizeNamePart(customer.first_name);
  if (!extractedFirst || !customerFirst) return true;
  if (!sameFirstName(extractedFirst, customerFirst)) return false;

  const extractedLast = normalizeNamePart(extracted.last_name);
  const customerLast = normalizeNamePart(customer.last_name);
  if (extractedLast && customerLast && extractedLast !== customerLast) return false;
  return true;
}

function customerPhoneMatches(phone, customer = {}) {
  return samePhone(phone, customer.phone);
}

// Extracted VERBATIM to the shared util (codex P1 PR #3303 r19) — the
// attribution retire path mirrors this exact gate on phone-matched
// successors; never re-inline or duplicate it.
const { LEAD_PIPELINE_STAGES, shouldCreateCallLeadForCustomer } = require('../utils/call-lead-customer-gate');
// Dialed-number → lead_sources resolution, shared with the finalization
// rejection-repair branch (codex P1 PR #3303 r20).
const { resolveCallLeadSource } = require('../utils/call-lead-source');

// Terminal lead statuses (`leads.status`). Mirrors admin-leads.js's own
// "active lead" definition (status NOT IN these). The customer-less recovery
// path reuses only ACTIVE leads — a denylist of these terminal outcomes rather
// than an open-status allowlist, so every open pipeline status (estimate_sent /
// estimate_viewed / estimate_drafted / awaiting_address / …) is covered without
// enumerating a growing set, while won/lost/disqualified/duplicate rows fall
// through to a fresh insert instead of hiding the inquiry on a closed lead.
const TERMINAL_LEAD_STATUSES = ['won', 'lost', 'disqualified', 'duplicate'];

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

// Stages whose on-file data fail-open booking may trust (see
// summarizeKnownCaller.isExistingCustomer).
const FAIL_OPEN_CUSTOMER_STAGES = new Set(['active_customer', 'won', 'at_risk']);

// Cross-call threading: the most recent OTHER call from this number whose
// extraction is worth handing to the model as continuation context. Callers
// finish one arrangement across several calls (a realtor whose first call cut
// off mid-dictation, three calls in one morning completing one WDO booking,
// "my coworker called Monday") — without this, call 2's extraction restarts
// from nothing. PII-light and compact by design; spam/voicemail priors are
// excluded (robocall context would only mislead). Read-only; fails open null.
const PRIOR_CALL_LOOKBACK_DAYS = 7;
// Prior-call text is UNTRUSTED prompt data: it originated from a caller's
// speech (via transcription + extraction), so it gets flattened (no newlines,
// no backticks/quotes that could fake a delimiter) and hard-capped before it
// is interpolated — and the prompt block labels it as data, never
// instructions.
function sanitizePriorText(value, max = 300) {
  return String(value || '')
    // The block's own data delimiters must never survive inside the data —
    // a prior caller speaking the literal marker could close the boundary
    // early and drop the rest of their text outside the NOT-instructions
    // fence. Strip the token and any angle-bracket runs that could rebuild it.
    .replace(/PRIOR_CALL_DATA/gi, ' ')
    .replace(/[<>]{2,}/g, ' ')
    .replace(/[\r\n`"]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
async function summarizePriorCall(contactPhone, currentCallId = null, conn = db, currentCallCreatedAt = null) {
  try {
    const digits = String(contactPhone || '').replace(/\D/g, '').slice(-10);
    if (digits.length < 10) return null;
    // Both directions: an office CALLBACK stores the contact's number in
    // to_phone (Waves line in from_phone) — that conversation is prior
    // context for the contact's next inbound call too.
    const q = conn('call_log')
      .whereRaw(
        "(right(regexp_replace(coalesce(from_phone,''),'\\D','','g'),10) = ? OR right(regexp_replace(coalesce(to_phone,''),'\\D','','g'),10) = ?)",
        [digits, digits],
      )
      .whereNotNull('ai_extraction')
      .whereNotIn('processing_status', ['spam', 'voicemail'])
      .orderBy('created_at', 'desc');
    // The 7-day window anchors to the CALL's own time when known (falls back
    // to now()) — a force-reprocess or backfill days later must still find
    // the continuation that happened minutes before the call.
    if (currentCallCreatedAt) {
      q.whereRaw(`created_at >= ?::timestamptz - interval '${PRIOR_CALL_LOOKBACK_DAYS} days'`, [currentCallCreatedAt]);
    } else {
      q.where('created_at', '>=', conn.raw(`now() - interval '${PRIOR_CALL_LOOKBACK_DAYS} days'`));
    }
    if (currentCallId) q.whereNot('id', currentCallId);
    // "Prior" means STRICTLY EARLIER: a force-reprocess or out-of-order queue
    // drain must never hand call 1 the extraction of call 2 as its past.
    if (currentCallCreatedAt) q.where('created_at', '<', currentCallCreatedAt);
    const row = await q.first('id', 'created_at', 'call_summary', 'ai_extraction');
    if (!row) return null;
    const v1 = typeof row.ai_extraction === 'string' ? JSON.parse(row.ai_extraction) : (row.ai_extraction || {});
    if (v1.is_spam === true) return null;
    const name = [v1.first_name, v1.last_name].map((s) => String(s || '').trim()).filter(Boolean).join(' ');
    const address = [v1.address_line1, v1.city, v1.zip].map((s) => String(s || '').trim()).filter(Boolean).join(', ');
    const sc = v1.secondary_contact && typeof v1.secondary_contact === 'object' ? v1.secondary_contact : null;
    const scName = sc ? [sc.first_name, sc.last_name].map((s) => String(s || '').trim()).filter(Boolean).join(' ') : '';
    // Age is relative to the CALL being processed, not to wall-clock — a
    // reprocess/backfill days later must still describe "18h before this
    // call", not "9 days ago".
    const anchorMs = currentCallCreatedAt ? new Date(currentCallCreatedAt).getTime() : Date.now();
    const hoursAgo = Math.max(1, Math.round((anchorMs - new Date(row.created_at).getTime()) / 3600000));
    return {
      hoursAgo,
      summary: sanitizePriorText(row.call_summary || v1.call_summary) || null,
      captured: {
        name: sanitizePriorText(name, 80) || null,
        phone: sanitizePriorText(v1.phone, 24) || null,
        email: sanitizePriorText(v1.email, 120) || null,
        address: sanitizePriorText(address, 160) || null,
        requested_service: sanitizePriorText(v1.requested_service || v1.matched_service, 80) || null,
        secondary_contact: scName ? sanitizePriorText(`${scName}${sc.role ? ` (${sc.role})` : ''}${sc.email ? `, ${sc.email}` : ''}${sc.phone ? `, ${sc.phone}` : ''}`, 200) : null,
        appointment: (v1.appointment_confirmed && v1.preferred_date_time) ? sanitizePriorText(v1.preferred_date_time, 40) : null,
      },
    };
  } catch (err) {
    logger.warn(`[call-proc] prior-call lookup skipped: ${err.message}`);
    return null;
  }
}

// Short, PII-light caller hint for the extraction prompt. Returns null when the
// inbound number doesn't map to a single known customer.
function summarizeKnownCaller(customer) {
  if (!customer) return null;
  const name = [customer.first_name, customer.last_name]
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .join(' ');
  const accountType = classifyCallerAccount(customer.pipeline_stage);
  return {
    name: name || null,
    accountType,
    // Fail-open booking inputs: an established customer with an address already
    // on file (Google-verified at signup) shouldn't be re-blocked for not
    // restating it on a familiar call. Fail-open trust is limited to stages we
    // ACTIVELY serve — a terminal prospect (lost/disqualified/duplicate) also
    // classifies as 'established_customer' for prompt purposes, but its stale
    // on-file data must never clear address/confidence blockers; dormant/
    // churned accounts likewise fall back to normal review.
    isExistingCustomer: FAIL_OPEN_CUSTOMER_STAGES.has(String(customer.pipeline_stage || '').trim().toLowerCase()),
    hasAddress: !!String(customer.address_line1 || '').trim(),
    // The on-file address components, for the fail-open V1 conflict check: a
    // legacy V1 address that conflicts with them (different street, unit,
    // city, or ZIP) is a NEW address that must hold for review, never
    // silently rebook to the primary.
    addressLine1: String(customer.address_line1 || '').trim() || null,
    addressLine2: String(customer.address_line2 || '').trim() || null,
    addressCity: String(customer.city || '').trim() || null,
    addressZip: String(customer.zip || '').trim() || null,
  };
}

// Fail-open V1 address-conflict demotion, shared by the ENFORCE path and the
// shadow/AUDIT recompute — the saved shadow decision must hold exactly where
// enforce would hold, or rollout metrics overstate safe fail-open bookings.
// When address flags failed open (V2 heard no address) but legacy V1 captured
// ANY address component (street, unit — line2 or embedded, city, ZIP), the
// booking demotes to the blocked path (address_review card) UNLESS the
// evidence is a street-anchored echo of the on-file address (same street
// key, no conflicting unit/city/ZIP) — that is a duplicate, not a new
// address. Partial-only evidence (city/ZIP/unit with NO street) demotes even
// when it matches: it cannot disambiguate a second property in the same
// city/ZIP, mirroring the V2 rule that any partial component is a
// new-address signal. Same normalization family as the property-linkage
// exact match (customer-properties), so this guard can't disagree with the
// stamp downstream. Returns the (possibly demoted) routing result; never
// mutates.
/**
 * The EXACT fail-open routing context production hands canAutoRoute for a
 * call. Exported so the three offline routing audits MIRROR production rather
 * than approximating it (local pre-push audit P1; round-13 residual): a
 * hand-rolled "linked customer with an address" test also granted the lane to
 * OUTBOUND calls and to dormant/lost/duplicate accounts, whose stale on-file
 * data must never clear a blocker — both directions of error land on the
 * permissive side of a promotion gate.
 *
 * The caller must still run demoteFailOpenOnV1AddressConflict on the result,
 * exactly as the live path does — the two are one contract.
 */
function buildFailOpenRoutingContext({
  call = {}, customer = null, contactPhone = null, failOpenEnabled = false,
} = {}) {
  const knownCaller = customer ? summarizeKnownCaller(customer) : null;
  return {
    knownCaller,
    options: {
      // Fail-open is INBOUND-only: an outbound callback is our own dial, not
      // a customer volunteering their identity by calling the office.
      failOpen: !!failOpenEnabled && !isOutboundCall(call),
      callerAni: contactPhone,
      knownCustomer: (knownCaller && knownCaller.isExistingCustomer)
        ? { hasAddress: knownCaller.hasAddress }
        : null,
    },
  };
}

function demoteFailOpenOnV1AddressConflict(routingResult, extracted, knownCaller) {
  if (!routingResult?.allowed
    || !(routingResult.failedOpenFlags || []).some((f) => FAIL_OPEN_KNOWN_CUSTOMER_ADDRESS_FLAGS.has(f))) {
    return routingResult;
  }
  const { streetKey, unitKey, streetEmbeddedUnitKey, normalizeZip } = require('./customer-properties');
  const cityKey = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  const legacyV1Street = String(extracted?.address_line1 || '').trim();
  const v1Unit = unitKey(extracted?.address_line2) || streetEmbeddedUnitKey(legacyV1Street);
  const v1City = cityKey(extracted?.city);
  const v1Zip = normalizeZip(extracted?.zip);
  if (!legacyV1Street && !v1Unit && !v1City && !v1Zip) return routingResult;
  const onFileStreet = String(knownCaller?.addressLine1 || '').trim();
  const onFileUnit = unitKey(knownCaller?.addressLine2) || streetEmbeddedUnitKey(onFileStreet);
  const v1AddressConflicts = !legacyV1Street
    || !onFileStreet
    || streetKey(legacyV1Street) !== streetKey(onFileStreet)
    || (v1Unit && v1Unit !== onFileUnit)
    || (v1City && v1City !== cityKey(knownCaller?.addressCity))
    || (v1Zip && v1Zip !== normalizeZip(knownCaller?.addressZip));
  if (!v1AddressConflicts) return routingResult;
  return {
    allowed: false,
    reason: 'v1_only_new_address',
    flags: routingResult.flags,
    appointmentBlockingFlags: ['address_unverified'],
  };
}

// Non-lead call-content classification — shared with the attribution retire
// path's durable-evidence gate (codex P1 PR #3303 r18), so the linkage
// decision and the successor-inheritance gate can never drift apart. The
// definitions (NON_LEAD_CALL_TYPES + isNonLeadCallContent) moved verbatim to
// the util; semantics unchanged.
const { NON_LEAD_CALL_TYPES, isNonLeadCallContent } = require('../utils/non-lead-call-content');

// A stale worker that lost its processing_token claim must not record or
// merge first-touch holds (Codex #3084 r44): the peer that reclaimed the
// call mints the fresh review card and records extraction B — a late merge
// from this worker would overwrite the pending ledger target with the stale
// extraction A, and resolving the visible B card would then release
// first-touch mail to the unreviewed A address. The r44 read-only
// pre-check was itself a TOCTOU (Codex #3084 r45): a worker could pass
// it, stall past the reclaim threshold, and still merge late. The ledger
// write now runs inside a transaction whose FIRST statement locks the
// call_log row conditioned on the token — a reclaim's token rotation
// queues behind that row lock until the merge commits, so ownership holds
// THROUGH the write. Returns the record result when owned, 'claim_lost'
// when the token no longer matches (the reclaiming peer's own Step 6/8
// owns the ledger record), or null on a failed/unverifiable write (the
// end-of-run retry re-attempts).
async function recordFirstTouchHoldOwned(args, procToken) {
  // Retry around the WHOLE transaction (Codex #3084 r47): a statement
  // error ABORTS the transaction, so the helper's internal per-attempt
  // retries could only fail with 25P02 in here — each attempt gets a
  // fresh transaction instead (the helper runs single-attempt inside it),
  // keeping the advertised transient-failure tolerance before the run is
  // pushed into extraction recovery.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const outcome = await db.transaction(async (trx) => {
        // Lock ORDER matters (Codex #3084 r46): the email-correction fanout
        // locks first_touch_holds FOR UPDATE and then UPDATES the same
        // call's call_log row (the review_status sync) — locking call_log
        // first here was the reverse acquisition order, a deadlock Postgres
        // breaks by aborting one side (a 500 on the operator's correction).
        // Take the call's existing hold rows FIRST, then the
        // token-conditioned call_log lock — the same
        // first_touch_holds → call_log order the fanout uses, with hold
        // INSERTS on both paths coming only after their call_log access.
        if (await trx.schema.hasTable('first_touch_holds')) {
          await trx('first_touch_holds')
            .where({ call_log_id: args.callLogId })
            .forUpdate()
            .select('id');
        }
        const owned = await trx('call_log')
          .where({ id: args.callLogId })
          .where('processing_token', procToken)
          .forUpdate()
          .first('id');
        if (!owned) {
          logger.info('[call-proc] processing claim lost — skipping the hold ledger write (the owner records it)');
          return 'claim_lost';
        }
        const { recordFirstTouchHold } = require('./lead-first-touch-resume');
        return await recordFirstTouchHold({ ...args, dbh: trx, attempts: 1 });
      });
      if (outcome !== null) return outcome; // recorded, or 'claim_lost'
      // null: the single in-transaction attempt failed and was swallowed —
      // fall through to a fresh transaction.
    } catch (claimErr) {
      logger.warn(`[call-proc] token-fenced hold record attempt ${attempt} failed: ${claimErr.message}`);
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
  }
  logger.warn('[call-proc] token-fenced hold record failed after 3 transactions — the end-of-run retry re-attempts');
  return null;
}

// Mint email read-back cards ATOMICALLY with the release-claim invalidation
// (Codex #3084 r54): an autocommit card insert followed by a separate repen
// left a window where a release — its one card question already answered
// under the send lock — could see the fresh card commit while the
// invalidation still waited on its hold-row lock, and send the DOI/drip to
// the now-unreviewed address before committing. One transaction, r52 shape:
// hold-row locks FIRST, then the processing_token-conditioned call_log lock
// (a stale worker aborts the mint entirely — the owner files its own card),
// then the card writes, then repenHoldsForFreshEmailReview riding the same
// transaction as a savepoint. The card and the invalidation now commit or
// roll back TOGETHER, so r44's dangerous half-state (card durably filed,
// claims still valid) cannot exist; a failed mint leaves no card, which the
// token-fenced end-of-run recovery covers. repen's r44 durable-state error
// still propagates (the caller fails the run retryably).
async function mintEmailReviewCardsFenced({ callLogId, procToken, cards, callSid, invalidateClaims = true }) {
  if (!cards.length) return;
  try {
    const minted = await db.transaction(async (trx) => {
      // Advisory lock FIRST (Codex #3084 r55): with no hold rows yet — the
      // normal early-processing state — the FOR UPDATE below locks nothing,
      // and the mint would take call_log before triage_items while the
      // fanout/admin-triage writers hold cards and then update call_log:
      // an insert conflicting with a still-open card would deadlock. The
      // shared per-call advisory lock serializes this mint against every
      // card writer regardless of what rows exist.
      await lockTriageCall(trx, callLogId);
      if (await trx.schema.hasTable('first_touch_holds')) {
        await trx('first_touch_holds')
          .where({ call_log_id: callLogId })
          .forUpdate()
          .select('id');
      }
      const owned = await trx('call_log')
        .where({ id: callLogId })
        .where('processing_token', procToken)
        .forUpdate()
        .first('id');
      if (!owned) return false;
      for (const card of cards) {
        await trx('triage_items')
          .insert(card)
          .onConflict(db.raw('(call_log_id, reason_code) WHERE status IN (\'open\', \'in_progress\')'))
          .ignore();
      }
      if (invalidateClaims) {
        const { repenHoldsForFreshEmailReview } = require('./lead-first-touch-resume');
        await repenHoldsForFreshEmailReview(callLogId, trx);
      }
      return true;
    });
    if (!minted) {
      logger.info(`[call-proc] processing claim lost for ${maskSid(callSid)} — skipping the email card mint (the owner files it)`);
    }
  } catch (mintErr) {
    if (mintErr.emailReviewStateUnavailable) throw mintErr;
    // EVERY mint failure fails the run (Codex #3084 r55): continuing
    // without the card leaves a window where the new hold records with no
    // live current-cycle card — if an older cycle has a RESOLVED email
    // card, the ledger sweep can read that historical disposition as
    // approval and release the fresh extraction before the end-of-run
    // recovery ever files its card. Retryable, same path as the r44
    // durable-state failures.
    logger.error(`[call-proc] fenced email card mint failed for ${maskSid(callSid)}: ${mintErr.message} — failing the run (retryable)`);
    const stateErr = new Error('email_review_state_unavailable');
    stateErr.emailReviewStateUnavailable = true;
    throw stateErr;
  }
}

// True when the call has a live email read-back card — the extracted address
// is a transcription guess and must not receive first-touch email until the
// office confirms it. 'in_progress' counts as live (canonical open-review set,
// admin-triage.js). Fails toward HOLD on a lookup error: a bounce to a wrong
// guess burns sender reputation and mints a suppression on an address the
// customer may later confirm; a held send is recoverable from the review card.
async function shouldHoldLeadEmailEnrollment(callLogId, { procToken = null, callSid = null, extractedEmail = null } = {}) {
  try {
    const open = await db('triage_items')
      .where({ call_log_id: callLogId })
      .whereIn('status', ['open', 'in_progress'])
      .whereIn('reason_code', ['email_unverified', 'email_invalid'])
      .first('id');
    return !!open;
  } catch (err) {
    logger.warn(`[call-proc] email-review lookup failed — holding first-touch email: ${err.message}`);
    // Persist a recovery marker (Codex #3084): without a live card the
    // standard resume paths (triage resolve / email correction) have nothing
    // to release, and the lead would stay silently outside the drip forever.
    //
    // The marker rides mintEmailReviewCardsFenced (r56): the old shape
    // autocommitted the card and THEN invalidated claims in a separate
    // transaction — a releaser could lock the hold and pass its card check
    // in that gap, then enroll/send while the invalidation waited on its
    // lock. Card + invalidation now commit or roll back together under the
    // advisory/token fence, same as both bridge sites.
    try {
      // The card must SHOW the address it approves (the r53 contract):
      // TriageInboxTabV2 renders only email_as_heard/email_candidates/
      // confirmation_question, and resolving this card releases the HELD
      // targets — surface them. Read in the same failure domain as the
      // mint: if the holds table is also unreadable, the catch below fails
      // the run (r44 posture) rather than filing an evidence-free card.
      const holdRows = await db('first_touch_holds')
        .where({ call_log_id: callLogId })
        .select('held_email');
      // On the FIRST Step-6 failure no hold row exists yet (r57 —
      // recordFirstTouchHoldOwned runs after this helper returns, and the
      // run will record extracted.email as the held target): the current
      // extraction IS the address this card would release, so it stands
      // in as the evidence when the ledger has nothing.
      const heldEmails = [...new Set(holdRows.map((r) => String(r.held_email || '').trim()).filter(Boolean))];
      if (!heldEmails.length && extractedEmail && String(extractedEmail).trim()) {
        heldEmails.push(String(extractedEmail).trim());
      }
      const { buildTriageItem } = require('./call-routing-gates');
      await mintEmailReviewCardsFenced({
        callLogId,
        procToken,
        callSid,
        cards: [buildTriageItem({
          callLogId,
          flag: 'email_unverified',
          extraction: { meta: { call_summary: null } },
          severity: 'advisory',
          extraPayload: {
            hold_reason: 'email_review_lookup_error',
            ...(heldEmails.length ? {
              email_as_heard: heldEmails[0],
              email_candidates: heldEmails,
              confirmation_question: 'The email review-state lookup failed mid-run — read this address back with the customer before releasing.',
            } : {}),
          },
        })],
      });
      // Claim lost (stale worker): the current owner files its own card
      // for its cycle — holding without our card is safe, our run's later
      // token CAS will fail anyway.
    } catch (markerErr) {
      if (markerErr.emailReviewStateUnavailable) throw markerErr;
      // Neither the review state nor a recovery marker is available — a
      // silent `true` here would durably hold both sends with no card
      // visible to an operator and no resolution trigger left (Codex #3084
      // r12). Fail the run instead: the outer procErr catch stamps
      // extraction_failed with the capped retry budget, and the sweep
      // re-processes the call when the DB recovers.
      logger.error(`[call-proc] email-hold recovery marker insert failed: ${markerErr.message}`);
      const stateErr = new Error('email_review_state_unavailable');
      stateErr.emailReviewStateUnavailable = true;
      throw stateErr;
    }
    return true;
  }
}

// Word-of-mouth referral detection from the AI call extraction. The prompt sets
// referred_by to the referrer's name (or 'unnamed') ONLY on an explicit referral.
// Returns that name, or '' when there's no referral — used to override the dialed-
// number source with the 'referral' channel so word-of-mouth is attributed.
// Extracted VERBATIM to the shared util (codex P1 r24) so the attribution
// retire's successor rehome judges referral evidence the SAME way; never
// re-inline it here.
const { referrerNameFromExtracted, REFERRAL_PLACEHOLDER_VALUES } = require('../utils/call-lead-source');

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

// One quote-promised bell per call PER PATH. Reprocessing the same recording
// (stale-lock reclaim, hung-fetch retry) re-enters both notify sites — one
// real call has rung three bells, with the early runs on the no-lead path
// because lead creation only succeeded on the final run.
// Lane-aware on purpose: a stale no-lead bell ("no lead is tracking this
// promise") must NOT suppress the corrected lead-linked bell a successful
// retry produces — the lead path passes ignoreNoLead to dedupe only against
// equivalent (lead-path) bells, while the no-lead path dedupes against any.
// Fail-open: a dedupe-query error must cost a duplicate bell, never the bell.
// Estimator engine gate (GATE_ESTIMATOR_ENGINE). The generic quote-promised
// bells below always fire synchronously — they are the DURABLE owed-quote
// guarantee (the engine runs as a floating promise and a restart mid-draft
// must not lose the promise). When the engine finishes it UPGRADES that
// same bell in place with the draft link, keeping one bell per call.
function estimatorEngineOn() {
  try {
    return require('./estimator-engine').estimatorEngineEnabled();
  } catch {
    return false;
  }
}

async function quotePromisedAlreadyNotified(callSid, { ignoreNoLead = false } = {}) {
  if (!callSid) return false;
  try {
    let query = db('notifications')
      .where({ recipient_type: 'admin' })
      .whereRaw("metadata->>'callSid' = ?", [callSid])
      .whereRaw("metadata->>'quote_promised' = 'true'");
    if (ignoreNoLead) {
      query = query.whereRaw("(metadata->>'no_lead') IS DISTINCT FROM 'true'");
    }
    const existing = await query.first('id');
    return !!existing;
  } catch (e) {
    logger.warn(`[call-proc] quote-promised dedupe check failed (notifying anyway): ${e.message}`);
    return false;
  }
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
    // Billing flag: V1's own flag always stands. A V2 flag is only inherited
    // when V1 and V2 are POSITIVELY the same person — a shared email, phone, or
    // full name. The identity-conflict check above can't see this gap: if V1
    // extracted an email-only contact and V2 a name-only billing party, nothing
    // conflicts, yet they may be different people — inheriting V2's flag would
    // bill V1's inbox for V2's payer. Requiring a positive shared identifier
    // keeps the legitimate gap-fill (same name, V2 adds the flag) while refusing
    // to carry an "owner pays" flag onto an unrelated contact's email.
    is_billing_party: v1.is_billing_party === true
      || (v2.is_billing_party === true && (
        (!!v1.email && !!v2.email && norm(v1.email) === norm(v2.email))
        || (!!v1.phone && !!v2.phone && last10(v1.phone) === last10(v2.phone))
        || (!!norm(v1.first_name) && norm(v1.first_name) === norm(v2.first_name)
          && !!norm(v1.last_name) && norm(v1.last_name) === norm(v2.last_name))
      )),
    notes: v1.notes || v2.notes,
  };
}

// Ordered, deduped list of ALL other parties on the call (up to 3, the slot
// budget). Entry 1 = the single-contact V1/V2 resolution above (identity-
// conflict rule intact); entries 2+ = the V2 array's additional people (V1
// only ever emits one). Dedupe key: phone last-10, else email, else full name.
function identityConflicts(a, b) {
  if (!a || !b) return false;
  const last10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);
  const norm = (v) => String(v || '').trim().toLowerCase();
  return (a.phone && b.phone && last10(a.phone) !== last10(b.phone))
    || (a.email && b.email && norm(a.email) !== norm(b.email))
    || (a.first_name && b.first_name && norm(a.first_name) !== norm(b.first_name))
    || (a.last_name && b.last_name && norm(a.last_name) !== norm(b.last_name));
}

function resolveCallSecondaryContacts(extracted = {}, v2Extraction = null) {
  const { mapSecondaryContactsToLegacy, mapSecondaryContactToLegacy } = require('../utils/extraction-compat');
  const primary = resolveCallSecondaryContact(extracted, v2Extraction);
  let v2List = mapSecondaryContactsToLegacy(v2Extraction?.secondary_contacts);
  // When the single-contact resolver rejected V2's person on an identity
  // conflict (V1 wins unmerged), that same person is REQUIRED to lead the V2
  // array as the mirror entry — appending it here would resurrect the
  // rejected identity as an "additional" contact and fan notifications out
  // to it (codex P1). Drop the conflicting mirror; genuinely-different
  // extra parties (entries 2+) stay.
  const v2Single = mapSecondaryContactToLegacy(v2Extraction?.secondary_contact);
  if (primary && v2Single && identityConflicts(primary, v2Single)) {
    const last10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);
    const norm = (v) => String(v || '').trim().toLowerCase();
    v2List = v2List.filter((c) => !(
      (c.phone && v2Single.phone && last10(c.phone) === last10(v2Single.phone))
      || (c.email && v2Single.email && norm(c.email) === norm(v2Single.email))
      || (!c.phone && !c.email && norm(c.first_name) === norm(v2Single.first_name) && norm(c.last_name || '') === norm(v2Single.last_name || ''))
    ));
  }
  // Dedup by ANY shared identifier, not a single priority key: the merged
  // primary entry may carry a phone while V2's mirror of the same person has
  // only an email/name — a one-key scheme gives them different keys and the
  // duplicate burns one of the three slots, dropping a real third party
  // (codex round-6 P2).
  const last10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);
  const norm = (v) => String(v || '').trim().toLowerCase();
  const nameOf = (c) => [c.first_name, c.last_name].map(norm).filter(Boolean).join(' ');
  const sameParty = (a, b) => (
    (last10(a.phone) && last10(a.phone) === last10(b.phone))
    || (norm(a.email) && norm(a.email) === norm(b.email))
    || (nameOf(a) && nameOf(a) === nameOf(b))
  );
  const out = [];
  for (const candidate of [primary, ...v2List]) {
    if (!candidate) continue;
    if (!last10(candidate.phone) && !norm(candidate.email) && !nameOf(candidate)) continue;
    if (out.some((c) => sameParty(c, candidate))) continue;
    out.push(candidate);
    if (out.length >= 3) break;
  }
  return out;
}

// Third-party payer (Bill-To) linkage from a call (GATE_CALL_PAYER_LINKING):
// when the caller named a DISTINCT paying party (is_billing_party) with a usable
// AP email, find-or-create a `payers` Bill-To and return its id so it can be
// stamped on the booking — the existing PayerService.resolveForInvoice()
// precedence (scheduled_service.payer_id ?? customer.payer_id) then routes the
// completion invoice to the payer's AP inbox with zero further changes. An AP
// email is REQUIRED: a payer with no inbox can't be invoiced, so we skip (book
// without a payer) rather than mint an unroutable Bill-To. Gated behind BOTH the
// payer-linking gate AND secondary-contact capture (the payer IS a secondary
// party). Never throws — a payer-lookup blip must not block the booking.
async function resolveCallBillingPayer(secondaryContacts, v2Extraction = null, caller = null) {
  if (!isEnabled('callPayerLinking') || process.env.GATE_CALL_SECONDARY_CONTACT !== 'true') return null;
  const candidates = Array.isArray(secondaryContacts) ? [...secondaryContacts] : [];
  // A V2-extracted billing party can be PRUNED from the merged list when its
  // identity conflicts with V1's secondary contact (resolveCallSecondaryContacts
  // drops the V2 mirror so notifications don't fan out to the rejected identity).
  // But that party is the PAYER, billed at its OWN AP email — so also scan the
  // raw V2 contacts here. Keying the payer on the party's own email keeps it the
  // correct inbox regardless of the notification-routing decision.
  if (v2Extraction) {
    const { mapSecondaryContactToLegacy, mapSecondaryContactsToLegacy } = require('../utils/extraction-compat');
    const v2Single = mapSecondaryContactToLegacy(v2Extraction.secondary_contact);
    const v2Arr = mapSecondaryContactsToLegacy(v2Extraction.secondary_contacts);
    for (const c of [v2Single, ...v2Arr]) if (c) candidates.push(c);
  }
  const norm = (v) => String(v || '').trim().toLowerCase();
  const last10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);
  // Match against EVERY caller identifier — from BOTH extractors, since the
  // helper scans raw V2 contacts and V2 may be the only side that captured the
  // caller's email/alternate phone. The caller may be duplicated into a slot
  // carrying only a callback number or a V2-only email.
  const callerEmails = new Set(
    [caller?.email, ...(Array.isArray(caller?.emails) ? caller.emails : [])]
      .map((e) => norm(e)).filter(Boolean),
  );
  const callerPhone10s = new Set(
    [caller?.phone, ...(Array.isArray(caller?.phones) ? caller.phones : [])]
      .map((p) => last10(p)).filter((p) => p.length === 10),
  );
  // A billing party must be flagged, have its OWN usable email, AND be a DISTINCT
  // third party — never the CALLER duplicated into a slot for a self-pay "I'll
  // pay" call (that would turn a self-pay booking into a payer-billed invoice).
  const flagged = candidates.filter((c) => c && c.is_billing_party === true
    && EMAIL_RE.test(norm(c.email))
    && !callerEmails.has(norm(c.email))
    && !(last10(c.phone).length === 10 && callerPhone10s.has(last10(c.phone))));
  // Fail closed on ambiguity: a call naming multiple DISTINCT billing parties
  // (tenant+owner+manager, or a model duplicate) must NOT silently pick one —
  // leave the booking unlinked (self-pay) for office review. (The same party can
  // legitimately appear twice — merged list + raw V2 — so dedupe by email.)
  const distinctEmails = [...new Set(flagged.map((c) => norm(c.email)))];
  if (distinctEmails.length !== 1) {
    if (distinctEmails.length > 1) {
      logger.warn(`[call-proc] payer linkage: ${distinctEmails.length} distinct billing parties flagged — leaving booking unlinked for review`);
    }
    return null;
  }
  const party = flagged.find((c) => norm(c.email) === distinctEmails[0]);
  if (!party) return null;
  try {
    const PayerService = require('./payer');
    const { payer } = await PayerService.findOrCreatePayerByEmail({
      apEmail: party.email,
      displayName: [party.first_name, party.last_name].filter(Boolean).join(' ').trim() || null,
      apPhone: party.phone || null,
    });
    return payer ? payer.id : null;
  } catch (err) {
    logger.warn(`[call-proc] payer linkage failed: ${err.message}`);
    return null;
  }
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
async function persistCallSecondaryContact(customerId, contact, { smsConsentExplicit = false } = {}) {
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
  // Role backfill on a known number: the person already sits in a slot
  // (pre-migration write or admin-entered) whose role column is empty —
  // record the relationship the call just identified, or future calls from
  // that number can't pass the household-role matching gate unless the
  // caller also repeats a matching first name (codex round-8 P2). The
  // customer's OWN phone matches nothing here (no slot to backfill).
  const backfillSlotRole = async () => {
    const roleToRecord = String(contact.role || '').trim().toLowerCase();
    if (!roleToRecord || roleToRecord === 'unknown') return false;
    const matched = SERVICE_CONTACT_SLOTS.find((s) => (
      (contact.phone && last10(customer[s.phone]) && last10(customer[s.phone]) === last10(contact.phone))
      || (contact.email && lowerEmail(customer[s.email]) && lowerEmail(customer[s.email]) === lowerEmail(contact.email))
    ));
    if (!matched || String(customer[matched.roleCol] || '').trim()) return false;
    const roleWriteAt = new Date();
    const wrote = await db('customers')
      .where({ id: customerId })
      .where((q) => q.whereNull(matched.roleCol).orWhere(matched.roleCol, ''))
      // Re-assert the slot still holds the SAME person as the snapshot the
      // role was matched against — a concurrent edit replacing the contact
      // must make this a 0-row no-op, never a role write onto (and an audit
      // event describing) somebody else.
      .whereRaw('?? IS NOT DISTINCT FROM ?', [matched.name, customer[matched.name] ?? null])
      .whereRaw('?? IS NOT DISTINCT FROM ?', [matched.phone, customer[matched.phone] ?? null])
      .whereRaw('?? IS NOT DISTINCT FROM ?', [matched.email, customer[matched.email] ?? null])
      .update({ [matched.roleCol]: roleToRecord.slice(0, 30) });
    if (wrote) {
      // 360 timeline event — post-write, best-effort, awaited (the recorder
      // never throws; a failure only warns and never fails the pipeline).
      // The write-time stamp orders it against later locked saves.
      await require('./service-contact-events').recordServiceContactChanges({
        customerId,
        before: customer,
        after: { ...customer, [matched.roleCol]: roleToRecord.slice(0, 30) },
        source: 'call',
        occurredAt: roleWriteAt,
      });
    }
    return !!wrote;
  };
  if (contact.phone && knownPhones.includes(last10(contact.phone))) {
    if (await backfillSlotRole()) return 'skipped_phone_on_record_role_backfilled';
    return 'skipped_phone_on_record';
  }
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
  if (!contact.phone && emailOnRecord) {
    if (await backfillSlotRole()) return 'skipped_email_on_record_role_backfilled';
    return 'skipped_email_on_record';
  }
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
  const contactRole = String(contact.role || '').trim().toLowerCase();
  const slotWrite = {
    [emptySlot.name]: fullName ? capitalizeName(fullName) : null,
    [emptySlot.phone]: contact.phone || null,
    [emptySlot.email]: slotEmail,
    // The extracted relationship (home_buyer/tenant/...) — recorded so
    // role-aware recipient selection is possible later; 'unknown' stays null.
    [emptySlot.roleCol]: (contactRole && contactRole !== 'unknown') ? contactRole.slice(0, 30) : null,
    // Consent artifact (#2948): stamp ONLY when (a) the V2 extraction
    // recorded explicit SMS consent on the call (the same
    // v2SmsConsentExplicit rail that gates same-call fanout), AND (b) the
    // resulting stamp describes only consented people — i.e. the row had
    // no other contact phones, or its existing contacts were already
    // stamped. Conversely, adding a phone WITHOUT explicit consent to a
    // stamped row must CLEAR the stamp — the old stamp never described the
    // new phone, and leaving it would authorize texting them (codex r5).
    ...((contact.phone && smsConsentExplicit
      && (!SERVICE_CONTACT_SLOTS.some((s) => String(customer[s.phone] || '').trim())
        || customer.service_contacts_consent_at)) ? {
      service_contacts_consent_at: new Date(),
      service_contacts_consent_source: 'call_pipeline_request',
      service_contacts_consent_text_version: 'call-2026-07-23',
    } : {}),
    ...((contact.phone && !smsConsentExplicit && customer.service_contacts_consent_at) ? {
      service_contacts_consent_at: null,
      service_contacts_consent_source: null,
      service_contacts_consent_text_version: null,
    } : {}),
  };
  const slotWriteAt = new Date();
  const updated = await write.update(slotWrite);
  if (!updated) return 'skipped_slot_race';
  // 360 timeline event — post-write, best-effort, awaited (the recorder
  // never throws). The conditional WHERE proved the slot was still empty at
  // write time, so merging slotWrite over the read snapshot diffs to exactly
  // this one addition; the write-time stamp orders it against later saves.
  await require('./service-contact-events').recordServiceContactChanges({
    customerId,
    before: customer,
    after: { ...customer, ...slotWrite },
    source: 'call',
    occurredAt: slotWriteAt,
  });
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
// A caller with NO usable phone at all (blocked/anonymous caller ID — the
// sentinel filter nulls it) can still be a workable lead, but only when they
// spoke a VALID email: with no callback number the email is the office's only
// way to reach them, so an address alone (locatable, not contactable) is not
// enough, and the voicemail waiver can't apply — the reachback it waives INTO
// is the phone. Without this branch a fully-identified prospect calling from
// a blocked number produced no lead row anywhere (name + email + address +
// quote promised → invisible in Leads/Customers, triage cards only).
// Extracted VERBATIM to the shared util (pre-push P1 PR #3303 r20) — the
// attribution retire path mirrors this exact gate on customer-less
// phone-matched successors; never re-inline or duplicate it.
const { hasWorkableLeadSignal } = require('../utils/workable-lead-signal');

// A voicemail landing on the TERMINAL skip path despite concrete service
// intent — the workable-lead gate declined it (existing customer matched, or
// a non-lead call_type veto), so no lead, no bell, nothing but a comms-inbox
// row. That silence lost a WDO-closing lead in May 2026 (recovered only by a
// manual re-key that minted a duplicate account). Returns the notification
// payload for the customer_voicemail_callback bell, or null when the
// voicemail carries no workable service signal (plain "call me back" messages
// stay bell-free). Pure decision core — the caller owns the gate check, the
// customer lookup, and the dedupe.
function voicemailCallbackAlertPlan({ extracted = {}, voicemailChannel = false, voicemailLeadPath = false, vmPhone = null, outbound = false, knownCustomer = false, transcript = '' } = {}) {
  if (!voicemailChannel || voicemailLeadPath) return null;
  // An OUTBOUND call reaching the customer's voicemail records OUR message —
  // a staff recording that names the service would otherwise satisfy the
  // service-signal test and ring a bogus callback bell.
  if (outbound) return null;
  if (extracted.is_spam) return null;
  if (!vmPhone) return null;
  // Owner ruling (Adam, 2026-07-30): a voicemail from a KNOWN customer rings
  // the callback bell even without concrete service intent — plain "call me
  // back" customer messages were ending terminal and silent. Unknown callers
  // still need the workable service signal, so solicitor/robocall voicemails
  // stay bell-free. Dead-air recordings ([VOICEMAIL]/[NO SPEECH] markers with
  // no spoken content, e.g. a customer pocket dial) never ring on the
  // known-customer basis.
  const workable = hasWorkableLeadSignal({ extracted, phone: vmPhone, voicemail: true });
  const spokenContent = String(transcript || '').replace(/\[(?:VOICEMAIL|NO SPEECH)\]/gi, '').trim();
  if (!workable && !(knownCustomer && spokenContent)) return null;
  const name = [capitalizeName(extracted.first_name), capitalizeName(extracted.last_name || '')]
    .filter(Boolean)
    .join(' ');
  return {
    name: name || null,
    service: extracted.matched_service || extracted.requested_service || null,
    phone: vmPhone,
  };
}

// Phone columns consulted for inbound identity: the customer's own number
// PLUS the three service-contact slot phones — the pipeline itself records
// spouses/tenants into those slots, and matching that ignored them forked a
// duplicate customer the next time that person called (audit #7/F1).
const CONTACT_MATCH_PHONE_COLS = ['phone', 'service_contact_phone', 'service_contact2_phone', 'service_contact3_phone'];
// Canonical persisted-schema county spellings, keyed by normalizeCounty()
// output (the schema enum is Proper-case; "DeSoto" has interior caps).
const AV_COUNTY_ENUM = { manatee: 'Manatee', sarasota: 'Sarasota', charlotte: 'Charlotte', desoto: 'DeSoto' };
// Slot roles that identify the HOUSEHOLD/account vs people who serve many
// accounts and must never auto-link on a slot-phone hit alone. lender is
// agent-type (schema 1.7.0): a loan officer/title coordinator arranges
// inspections for MANY buyers — their next call is usually a different
// customer, so a slot-phone hit alone must go to review, not auto-link.
const HOUSEHOLD_SLOT_ROLES = new Set(['tenant', 'spouse_partner', 'family_member', 'home_buyer', 'home_seller', 'landlord']);
const AGENT_TYPE_SLOT_ROLES = new Set(['real_estate_agent', 'property_manager', 'lender']);
// Slot-only match gating: the number belongs to a person STORED ON this
// account (tenant/spouse/buyer/agent). Household-type roles identify the
// account; agent-type people (realtor, property manager) serve MANY accounts
// — a realtor's next call is usually about a DIFFERENT buyer, so an
// unconditional link would book the new visit on the old customer. Household
// role or a first-name agreement with the slot's OWN name links.
function slotOnlyLinkAllowed(customer, phone, extracted = {}) {
  const slotEntry = matchedSlotEntry(customer, phone);
  const slotRole = String(slotEntry?.contactRole || '').toLowerCase();
  if (AGENT_TYPE_SLOT_ROLES.has(slotRole)) return false;
  if (HOUSEHOLD_SLOT_ROLES.has(slotRole)) return true;
  const extractedFirst = normalizeNamePart(extracted.first_name);
  const slotFirst = normalizeNamePart(String(slotEntry?.name || '').split(/\s+/)[0]);
  return !!extractedFirst && !!slotFirst && sameFirstName(extractedFirst, slotFirst);
}

function matchedSlotEntry(customer, phone) {
  const { SERVICE_CONTACT_SLOTS } = require('./customer-contact');
  for (const slot of SERVICE_CONTACT_SLOTS) {
    if (samePhone(phone, customer[slot.phone])) {
      return { name: customer[slot.name] || null, contactRole: customer[slot.roleCol] || null };
    }
  }
  return null;
}

// Disambiguation leg (b): an AV-DECISIVE call address that matches exactly
// one candidate's mirror address or active property is a deterministic
// second signal. Shared by the single-match branch (an agent-role slot hit
// calling about the very property they're stored on must attach, not
// duplicate the customer — codex round-9 P2) and the multi-match cascade.
// Returns the owning candidate or null; never throws.
async function avAddressUniqueOwner(matches, opts) {
  if (!opts.avDecisive || !opts.callAddress?.address_line1) return null;
  try {
    const { addressKey } = require('./customer-properties');
    const callKey = addressKey(opts.callAddress);
    if (!callKey) return null;
    const candidateIds = matches.map((m) => m.id);
    const props = await db('customer_properties')
      .whereIn('customer_id', candidateIds)
      .where({ active: true })
      .select('customer_id', 'address_line1', 'address_line2', 'city', 'zip');
    const owners = new Set();
    for (const m of matches) {
      if (addressKey(m) === callKey) owners.add(m.id);
    }
    for (const p of props) {
      if (addressKey(p) === callKey) owners.add(p.customer_id);
    }
    if (owners.size !== 1) return null;
    const ownerId = [...owners][0];
    return matches.find((m) => m.id === ownerId) || null;
  } catch (e) {
    logger.warn(`[call-proc] address-based disambiguation failed: ${e.code || e.message}`);
    return null;
  }
}

async function findCustomerForCallContact(phone, extracted = {}, opts = {}) {
  const contactKey = phoneKey(phone);
  if (!contactKey) return null;

  const predicateFor = (col) => (contactKey.length === 10
    ? `RIGHT(regexp_replace(COALESCE(${col}, ''), '[^0-9]', '', 'g'), 10) = ?`
    : `regexp_replace(COALESCE(${col}, ''), '[^0-9]', '', 'g') = ?`);
  const base = () => {
    const query = db('customers').whereNull('deleted_at');
    return query.where(function orPhones() {
      for (const col of CONTACT_MATCH_PHONE_COLS) {
        this.orWhereRaw(predicateFor(col), [contactKey]);
      }
    });
  };
  const matchedViaPrimary = (c) => samePhone(phone, c.phone);

  if (opts.preferredCustomerId) {
    const preferred = await db('customers')
      .where({ id: opts.preferredCustomerId })
      .whereNull('deleted_at')
      .first();
    if (preferred && customerPhoneMatches(phone, preferred)) return preferred;
  }

  // A name-agreeing slot match found by the fast path but deferred until the
  // sole-primary-owner check can run (codex round-6 P2).
  let deferredSlotNamed = null;
  const firstName = normalizeNamePart(extracted.first_name);
  if (firstName) {
    // Nickname-tolerant: "Bob" matches a record filed as "Robert" — the phone
    // already scopes candidates to one household/office, and the last-name
    // ordering below still prefers a full-name agreement.
    let namedQuery = base()
      .whereRaw(
        `LOWER(regexp_replace(COALESCE(first_name, ''), '[^a-zA-Z0-9]', '', 'g')) = ANY(?)`,
        [firstNameVariants(firstName)]
      );

    const lastName = normalizeNamePart(extracted.last_name);
    if (lastName) {
      namedQuery = namedQuery.orderByRaw(
        "CASE WHEN LOWER(regexp_replace(COALESCE(last_name, ''), '[^a-zA-Z0-9]', '', 'g')) = ? THEN 0 ELSE 1 END",
        [lastName]
      );
    }

    const [named] = await namedQuery.orderBy('updated_at', 'desc').limit(1);
    // The name fast path is only safe when the number is the customer's OWN
    // phone. A slot-phone hit (base() searches those too) whose account
    // first name happens to match the caller must still pass the slot-role
    // gating below — a realtor stored on a same-named customer would
    // otherwise link and book on the old account (codex round-2 P1). And
    // even a role-passing slot match must not outrank the number's sole
    // PRIMARY owner (cascade leg (a)) — defer it into the multi-match
    // branch so the owner check runs first (codex round-6 P2).
    if (named && extractedNameMatchesCustomer(extracted, named)) {
      if (matchedViaPrimary(named)) return named;
      if (slotOnlyLinkAllowed(named, phone, extracted)) deferredSlotNamed = named;
    }
    // No name match — but the AI-extracted name is frequently wrong (it can pick
    // up the technician's name from the call audio, e.g. "Adam"). Returning null
    // here makes the caller spawn a NEW customer even when the phone already maps
    // to one, creating a duplicate. Fall through to the phone-only single-match
    // below instead — this is the behavior the caller already documents
    // ("phone-only matching is allowed only when the number maps to a single
    // active customer") and keeps the genuine shared-phone case (2+ matches) safe.
  }

  const matches = await base().orderBy('updated_at', 'desc').limit(25);
  if (matches.length === 1) {
    const only = matches[0];
    if (matchedViaPrimary(only)) return only;
    if (slotOnlyLinkAllowed(only, phone, extracted)) return only;
    // The slot-role gate blocks agent-type roles because a realtor/property
    // manager calls about MANY properties — but when the AV-decisive call
    // address matches THIS customer's mirror or active property, the call is
    // about this account and must attach rather than spawn a duplicate
    // customer (codex round-9 P2). Same deterministic second signal as
    // multi-match leg (b).
    if (await avAddressUniqueOwner(matches, opts)) return only;
    // Anything weaker falls through to the legacy create/lead path exactly
    // as before slot matching existed.
    return null;
  }
  if (matches.length > 1) {
    // Exact population first: uniqueness decisions on a CAPPED sample would
    // auto-link when the tie-breaking row sits beyond the cap (codex P2).
    const shareCount = await Promise.resolve()
      .then(() => base().count('* as n').first())
      .then((r) => parseInt(r?.n || 0, 10) || matches.length)
      .catch(() => matches.length);
    const cascadeSound = shareCount === matches.length;
    // ── Multi-match disambiguation cascade (audit #7) — each leg is a
    // deterministic second signal; anything weaker stays ambiguous. Legs run
    // only when the fetched set IS the full population. ──
    if (cascadeSound) {
    // (a) The number is exactly ONE candidate's own primary phone (the others
    //     merely hold it in a service-contact slot): the primary owns it.
    const primaryOwners = matches.filter(matchedViaPrimary);
    if (primaryOwners.length === 1) return primaryOwners[0];
    // (a2) No sole primary owner — a fast-path slot match whose account name
    //      agrees with the caller AND whose slot role passes the household
    //      gating is the next-strongest signal (deferred from above so leg
    //      (a) could run first; codex round-6 P2).
    if (deferredSlotNamed) return deferredSlotNamed;
    // (A unique slot-only hit already returned at matches.length === 1 —
    // the slot columns are part of base(). Two customers holding the same
    // number in slots stays ambiguous on purpose: realtors/property managers
    // sit in many customers' slots.)
    // (b) AV-validated call address matches exactly one candidate (their
    //     mirror address or one of their active properties). Gated on a
    //     decisive AV verdict so a raw mis-transcribed street can't link.
    {
      const owner = await avAddressUniqueOwner(matches, opts);
      if (owner) return owner;
    }
    // (c) All candidates share one address key — a household sharing a line;
    //     any of them is the household, most-recently-active wins.
    try {
      const { addressKey } = require('./customer-properties');
      const keys = new Set(matches.map((m) => addressKey(m)).filter(Boolean));
      if (keys.size === 1 && matches.every((m) => addressKey(m))) {
        logger.info(`[call-proc] Shared phone maps to one household (${matches.length} records); linking most recent`);
        return matches[0];
      }
    } catch { /* fall through to ambiguous */ }
    }

    logger.warn(`[call-proc] ${shareCount} customers share call contact phone ${maskPhone(phone)}; not auto-linking without a second deterministic signal`);
    // Surface the ambiguity to callers that can act on it (Step 3 suppresses
    // the new-customer create and opens a review card) without changing the
    // null contract for the ones that can't.
    if (opts.multiMatchOut && typeof opts.multiMatchOut === 'object') {
      opts.multiMatchOut.candidates = matches.map((m) => ({
        id: m.id,
        name: [m.first_name, m.last_name].filter(Boolean).join(' ') || null,
      }));
      opts.multiMatchOut.shareCount = shareCount;
    }
  }
  return null;
}

async function registerScheduleSideEffects({ scheduledServiceId, customerId, scheduledDate, windowStart, serviceType, closeReminderWindows = false }) {
  try {
    const AppointmentReminders = require('./appointment-reminders');
    await AppointmentReminders.registerAppointment(
      scheduledServiceId,
      customerId,
      `${scheduledDate}T${windowStart || '08:00'}`,
      serviceType,
      'call_recording',
      // closeReminderWindows: a WINDOWLESS visit registers the canonical
      // pre-closed placeholder at the date+08:00 slot instead of an ARMED
      // reminder at a fabricated start — the cron must never text a time
      // nobody chose (Codex #3361 r24 P1; same rule the confirm hook's
      // registration leg applies).
      { sendConfirmation: false, closeReminderWindows }
    );
  } catch (err) {
    logger.error(`[call-proc] Appointment reminder registration failed: ${err.message}`);
  }

  // Inspection credit: fast redemption for a confirmed call booking, same
  // as every other booking surface (Codex #3178 r27 P2) — the marker alone
  // leaves the credit unminted until the hourly sweep, and a Charge Now /
  // pay link sent in that window collects the full amount. This helper's
  // one caller is the fresh, non-outbound-review booking path (pending
  // outbound rows redeem at office confirmation instead), and it runs
  // post-commit. Best-effort — the sweep remains the durable guarantee.
  try {
    await require('./inspection-credit').redeemInspectionCreditForBooking({
      customerId,
      scheduledServiceId,
      createdBy: 'system:inspection_credit_call_booking',
    });
  } catch (err) {
    logger.warn(`[call-proc] inspection credit fast redemption deferred to sweep for ${scheduledServiceId}: ${err.message}`);
  }

  // Dispatch-v2 reads scheduled_services directly; no legacy dispatch sync.
}

// Resolve which existing lead (if any) this call should reuse, by caller phone
// — or, when the caller ID was blocked/anonymous (phone null), by the spoken
// email, so a repeat anonymous caller doesn't mint a duplicate lead per call.
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
// The eligibility a SAME-CALL (sid-matched) lead row must satisfy, applied
// IDENTICALLY at lookup time and at write time. It lives in one function
// because hand-repeating a subset at the write is a bug factory: three
// consecutive review rounds each named a different predicate the write had
// missed — ownership for a phone-less retry, ownership for a phone-bearing
// one, then the lifecycle trio — because the lookup builds eligibility here
// and the guarded write rebuilt it ~400 lines away. One function means the
// two can no longer drift, and a new predicate added here is automatically
// enforced at both sites.
function applySameCallLeadEligibility(query, { customerId, unclaimedOnly, workableUnnamedLead, phoneAuthorizedStamp = false }) {
  let out = query.whereNull('deleted_at');
  if (workableUnnamedLead) {
    out = out.whereNotIn('status', TERMINAL_LEAD_STATUSES).whereNull('converted_at');
  }
  if (unclaimedOnly || (!customerId && !phoneAuthorizedStamp)) {
    // Anonymous retries require an UNCLAIMED row too, not just the
    // shared-phone-ambiguity case: unclaimedOnly is derived from shared-phone
    // candidates and is false for a customer-less caller, so without the
    // `!customerId` arm a row claimed between attempts stayed eligible and
    // an anonymous extraction could overwrite a customer-owned lead
    // (audit P1 r15). EXCEPTION (codex P2 on the root fix): a
    // PHONE-authorized stamp (metadata.lead_link_via === 'phone') was
    // legitimately allowed to target a customer-owned lead at stamp time —
    // the phone path applies no ownership filter for a customer-less
    // caller — so its retry keeps the same ownership rules the original
    // linkage ran under instead of the anonymous-strict set. Email/legacy
    // stamps (via absent) stay strict; shared-phone ambiguity
    // (unclaimedOnly) is never relaxed.
    out = out.whereNull('customer_id');
  } else if (customerId) {
    out = out.where((q) => q.whereNull('customer_id').orWhere('customer_id', customerId));
  }
  return out;
}

async function findReusableCallLead(database, { phone, email = null, firstName = null, lastName = null, customerId, workableUnnamedLead, unclaimedOnly, callSid = null, stampedLeadId = null, stampedLeadVia = null }) {
  // Same-call retry FIRST, before any contact-based branch: a retry of this
  // call (extraction_failed reprocessing) must reuse the lead an earlier
  // attempt already inserted, and the call SID is the strongest identity
  // there is. Extracted phone/email are MUTABLE across reprocessing attempts
  // — branching on them first let a retry whose contact fields changed
  // reuse an unrelated phone-matched lead or mint a second lead for the
  // same SID (codex P2 r8 + audit P1 r14). The SID row still passes the
  // SAME ownership/lifecycle filters as the contact-based lookups (audit P1
  // r17): a retry that now resolves to a different customer must not adopt
  // a lead another customer owns, and the workableUnnamedLead path stays
  // active-leads-only — an ineligible SID row falls through to contact
  // reuse or a fresh mint like any other rejected candidate.
  // A retry can also be identified by the call_log.metadata.lead_id STAMP:
  // a REUSED lead keeps its ORIGINAL call's sid, so for a phone-less call
  // that reused someone else's row the stamp IS this call's same-call
  // identity. The SID stays AUTHORITATIVE over the stamp — a stale stamp can
  // transiently coexist with a newly inserted sid-linked lead when a prior
  // attempt failed before its linkage maintenance ran, and OR-ing the two
  // and taking the newest let retries pick an arbitrary one (audit P1 r21).
  // Resolve the sid lead first; consult the stamp only when no eligible sid
  // lead exists. Both arms pass the SAME eligibility as the contact lookups.
  // The return carries WHICH arm resolved the row ({ lead, matchedVia }) —
  // the guarded write must inherit the eligibility of the arm that actually
  // selected the row (pre-push P1 r2 on the root fix): a stamp-selected row
  // passed applySameCallLeadEligibility (unclaimed for a customer-less
  // caller) and the write must repeat exactly that, while a row the PHONE
  // fallback selected runs the phone path's own ownership rules. Inferring
  // the arm after the fact (id/phone equality) misclassified both
  // directions.
  if (callSid) {
    // An ineligible sid row falls through to contact reuse or a fresh mint
    // like any other rejected candidate.
    const own = await applySameCallLeadEligibility(
      database('leads').where('twilio_call_sid', callSid),
      { customerId, unclaimedOnly, workableUnnamedLead },
    ).orderBy('created_at', 'desc').first();
    if (own) return { lead: own, matchedVia: 'same_call_sid' };
  }
  if (stampedLeadId) {
    // A phone-authorized stamp keeps the ownership rules its original
    // linkage ran under (see applySameCallLeadEligibility) — otherwise a
    // legitimately customer-owned phone-reused lead was rejected here and,
    // when the phone fallback could no longer re-select it, the retry
    // minted a duplicate and settled the durable link (codex P2).
    const own = await applySameCallLeadEligibility(
      database('leads').where('id', stampedLeadId),
      { customerId, unclaimedOnly, workableUnnamedLead, phoneAuthorizedStamp: stampedLeadVia === 'phone' },
    ).orderBy('created_at', 'desc').first();
    if (own) return { lead: own, matchedVia: 'same_call_stamp' };
  }
  // The email key must be a REAL email, validated here and not just at the
  // workable-signal gate: customer-attached calls reach this lookup without
  // passing hasWorkableLeadSignal, so a phone-less call carrying a malformed
  // capture like "unknown" could otherwise reuse and claim an unrelated lead
  // storing the same garbage value (pre-push audit P1, PR #3275).
  const emailLcRaw = String(email || '').trim().toLowerCase();
  const emailLc = EMAIL_RE.test(emailLcRaw) ? emailLcRaw : '';
  if (!phone && !emailLc) return { lead: null, matchedVia: null };
  let query = database('leads').whereNull('deleted_at');
  // Email matching engages ONLY when there is no phone: a phone match stays
  // the sole identity key for identified callers (an email-also match could
  // absorb a different household member's lead sharing one inbox). And an
  // email match may only land on an UNCLAIMED lead — a spoken email is weak
  // identity (shared inbox, transcription collision), so a lead a customer
  // owns is invisible here and the ambiguous caller gets a fresh row instead
  // of overwriting someone else's lead (codex P1, PR #3275).
  query = phone
    ? query.where('phone', phone)
    : query.whereRaw('LOWER(TRIM(email)) = ?', [emailLc]).whereNull('customer_id');
  if (workableUnnamedLead) {
    query = query.whereNotIn('status', TERMINAL_LEAD_STATUSES).whereNull('converted_at');
  }
  if (unclaimedOnly) {
    // Shared-phone ambiguity: the call could belong to ANY of the candidate
    // customers, so it must never reuse (and enrich) a lead one of them owns
    // — another caller's transcript would land on the wrong customer's lead
    // while the office adjudicates (codex round-6 P2).
    query = query.whereNull('customer_id');
  } else if (customerId) {
    query = query.where((q) => q.whereNull('customer_id').orWhere('customer_id', customerId));
  }
  // Phone identity is strong — the newest match wins outright.
  if (phone) {
    const row = await query.orderBy('created_at', 'desc').first();
    return { lead: row || null, matchedVia: row ? 'phone' : null };
  }
  // Email-matched candidates need POSITIVE identity corroboration, not just
  // absence of conflict: two different anonymous callers can share one inbox
  // (or a transcription collision can fabricate the overlap), and reusing
  // across them overwrites the first prospect's rolling extraction and
  // swallows the second's new-lead surfacing — a silently lost prospect.
  // Reuse requires the stated first name and the candidate's to BOTH exist
  // and match, with last names non-conflicting; missing name data on either
  // side forces a fresh row instead (pre-push audit P1 r7 — the cost is a
  // recoverable duplicate, fail-closed beats a cross-prospect merge).
  // The corroboration lives IN the query, not in a post-fetch scan: a shared
  // inbox can hold any number of active unclaimed leads, and the caller's
  // own row must be found however deep it sits — a capped scan still minted
  // duplicates past the cap (codex P2 r6/r13).
  const norm = (v) => String(v || '').trim().toLowerCase();
  const firstLc = norm(firstName);
  if (!firstLc) return { lead: null, matchedVia: null }; // positive corroboration impossible — fresh row
  query = query.whereRaw('LOWER(TRIM(first_name)) = ?', [firstLc]);
  const lastLc = norm(lastName);
  if (lastLc) {
    query = query.whereRaw(
      "(last_name IS NULL OR TRIM(last_name) = '' OR LOWER(TRIM(last_name)) = ?)",
      [lastLc],
    );
  }
  const row = await query.orderBy('created_at', 'desc').first();
  return { lead: row || null, matchedVia: row ? 'email' : null };
}

// The lead stamp an earlier attempt of this call may have written
// (call_log.metadata.lead_id — the reused-lead linkage). One
// parser for every site that reconciles it: Step 4b, the implausible-
// transcript rejection, and the spam/veto terminal exits.
function parseStampedLeadId(call) {
  return parseStampedLeadLink(call).leadId;
}

// The stamp plus its AUTHORITY (metadata.lead_link_via, 'phone' | 'email'):
// which identity linked this call to the lead when the stamp was written.
// A phone-authorized stamp on a customer-OWNED lead is legitimate (the
// phone path applies no ownership filter for a customer-less caller), so a
// retry's stamp-arm eligibility must not reject it with the
// anonymous-strict unclaimed rule — that minted a duplicate and settled the
// supposedly durable link whenever the phone fallback could no longer
// re-select the row (lead phone corrected, or the retry's extraction lost
// the number — codex P2 r1 ×2 on the root fix). Stamps written before this
// key exists parse as via=null and keep the strict treatment.
function parseStampedLeadLink(call) {
  try {
    const md = typeof call?.metadata === 'string' ? JSON.parse(call.metadata) : (call?.metadata || {});
    if (!md?.lead_id) return { leadId: null, via: null };
    return {
      leadId: String(md.lead_id),
      via: md.lead_link_via === 'phone' || md.lead_link_via === 'email' ? md.lead_link_via : null,
    };
  } catch { return { leadId: null, via: null }; }
}

// Decides whether THIS pass writes the durable call→lead stamp
// (call_log.metadata.lead_id + rollback ledgers + ordering marker).
//
// ROOT FIX (owner ruling 2026-08-11): phone-bearing reuse stamps too.
// findReusableCallLead links a phone-bearing call to an existing lead
// without touching the lead's sid, so the association used to be
// reconstructable only by phone matching — the approximation five
// #3347-era review findings traced their residual holes to (mutable
// phones, later distinct same-number leads, post-window reprocessing).
// With the stamp the linkage is durable, and the bridge/sweep phone
// arms become transitional coverage for pre-fix legacy calls only.
//
// Arm 1 (fresh stamp): ANY reuse of a lead that does not carry this
// call's own sid. The same-sid exclusion is what keeps the standing
// invariant true — stamps are only ever written for different-sid
// leads (a same-sid row IS this call's own insert; the sid is its
// durable linkage). Race-recovered rows are freshly minted with this
// call's sid, so they self-link the same way.
// Arm 2 (re-stamp): a retry whose current stamp already points at the
// final lead refreshes the ledgers in the same fenced transaction as
// its writes — including a retry that GAINED a phone but is enriching
// the lead its earlier attempt stamped (codex P1 r22), or a lost
// rejection would be unable to CAS-restore this pass's mutations.
function shouldStampCallLeadLinkage({ existingLead, raceRecovered, callTwilioSid, leadId, currentStampedLeadId }) {
  return (!!existingLead && !raceRecovered
    && !(callTwilioSid && existingLead.twilio_call_sid === callTwilioSid))
    || (!raceRecovered && !!leadId && currentStampedLeadId === String(leadId));
}


// Re-applies the PHONE arm's selecting predicates against the LOCKED lead
// row before the stamp is written (codex P2 on the root fix): a
// phone-matched lead edited (number corrected away), closed, converted, or
// soft-deleted between findReusableCallLead and the transaction's row lock
// no longer satisfies the identity/lifecycle the selection was based on —
// and the ordinary phone-path write only repeats customer ownership, so
// without this the pass stamped a durable association onto (and enriched)
// an obsolete row. Mirrors the phone branch's own predicate set exactly:
// phone equality, deleted_at, the workableUnnamedLead lifecycle trio, and
// the ownership arm.
function phoneReuseStillValidOnLockedRow(lockedLead, { phone, customerId, unclaimedOnly, workableUnnamedLead }) {
  if (!lockedLead) return false;
  if (lockedLead.deleted_at) return false;
  if (String(lockedLead.phone || '') !== String(phone)) return false;
  if (workableUnnamedLead) {
    if (TERMINAL_LEAD_STATUSES.includes(lockedLead.status)) return false;
    if (lockedLead.converted_at) return false;
  }
  if (unclaimedOnly && lockedLead.customer_id != null) return false;
  if (customerId && lockedLead.customer_id != null
    && String(lockedLead.customer_id) !== String(customerId)) return false;
  return true;
}

// Derives the authority a stamp records (metadata.lead_link_via) from the
// SELECTING ARM, never from bare phone presence (pre-push P1 on r4): a
// retry can carry a resolved phone that has nothing to do with the lead —
// a spouse's callback number on an email-authorized stamp — and stamping
// 'phone' from presence alone would hand later customer-less retries the
// relaxed ownership rule for a linkage the number never corroborated.
// 'phone' requires actual corroboration THIS pass: the phone arm selected
// the row (revalidated under the lock), the locked lead already carries
// the caller's number, or this pass's enrichment writes it (fill-only —
// the lead will carry it from here on). Otherwise a stamp-selected row
// PRESERVES its prior authority (a historical phone corroboration stands
// through a phone-less retry; a legacy/via-less stamp stays strict as
// 'email'), and a fresh email-arm stamp records 'email'.
function deriveStampLinkAuthority({ phone, existingLeadVia, priorStampedLeadVia, lockedLeadPhone, writesPhone }) {
  const phoneCorroborated = !!phone && (
    existingLeadVia === 'phone'
    || String(lockedLeadPhone || '') === String(phone)
    || !!writesPhone
  );
  if (phoneCorroborated) return 'phone';
  if (existingLeadVia === 'same_call_stamp' && priorStampedLeadVia === 'phone') return 'phone';
  return 'email';
}

// The lead columns the reuse enrichment can mutate — snapshotted
// into call_log.metadata.lead_prior_state at stamp time and restored when a
// later attempt rejects the call. One list so the stamp and the restore can
// never drift.
const STAMPED_LEAD_RESTORE_FIELDS = [
  'first_name', 'last_name', 'email', 'phone', 'address', 'city', 'zip',
  'service_interest', 'urgency', 'transcript_summary', 'extracted_data',
  'is_qualified', 'status', 'next_follow_up_at', 'customer_id',
];

// Key-sorted deep copy so two JSON values that are structurally equal
// serialize to the SAME string. The prior side of a ledger snapshot comes
// back through PostgreSQL's JSONB (which re-keys objects), while the
// written side is this process's own stringify — comparing the raw strings
// with === skipped successor re-parenting on identical values (pre-push P1
// r3), and a later rejection then restored the earlier rejected call's
// extraction. The SQL CAS casts to ::jsonb and never had the problem;
// canonicalizing at snapshot time makes the JS-side comparisons match it.
function canonicalJsonValue(v) {
  if (Array.isArray(v)) return v.map(canonicalJsonValue);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonicalJsonValue(v[k]);
    return out;
  }
  return v;
}

function serializeStampedLeadValue(field, v) {
  if (v instanceof Date) return v.toISOString();
  if (field === 'extracted_data' && v != null) {
    try {
      return JSON.stringify(canonicalJsonValue(typeof v === 'string' ? JSON.parse(v) : v));
    } catch {
      return typeof v === 'string' ? v : JSON.stringify(v);
    }
  }
  return v ?? null;
}

// Snapshot ONLY the fields this call's enrichment is about to write — the
// prior values (from the pre-enrichment row) and the written values (from
// the actual update payload). Restore compares written vs current per
// field, so a staff edit after enrichment survives rejection untouched.
function snapshotStampedLeadStates(leadRow, leadUpdates) {
  const prior = {};
  const written = {};
  for (const f of STAMPED_LEAD_RESTORE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(leadUpdates || {}, f)) continue;
    prior[f] = serializeStampedLeadValue(f, leadRow?.[f]);
    written[f] = serializeStampedLeadValue(f, leadUpdates[f]);
  }
  return { prior, written };
}

// The lead columns Step 4b writes FILL-ONLY (set only while the lead's own
// value is still empty). Their decision basis is the `current` row, read
// BEFORE the enrichment transaction takes its row lock — an admin edit or a
// concurrent call can fill one of them in that gap, and re-applying the
// stale decision would overwrite the newer entry despite the documented
// fill-only behavior (codex P2 r17). Re-decided against the LOCKED row
// inside the transaction; keep this list in step with the fill-if-empty
// assignments in Step 4b.
const FILL_ONLY_LEAD_FIELDS = ['phone', 'first_name', 'last_name', 'email', 'address', 'city', 'zip'];

function dropFilledLeadColumns(leadUpdates, lockedLead) {
  if (!lockedLead || !leadUpdates) return leadUpdates;
  const stillEmpty = (v) => v === null || v === undefined || v === '';
  let out = leadUpdates;
  for (const f of FILL_ONLY_LEAD_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(out, f)) continue;
    if (stillEmpty(lockedLead[f])) continue;
    if (out === leadUpdates) out = { ...leadUpdates };
    delete out[f];
  }
  return out;
}

// Fill-only fields this pass's extraction SUPPLIED whose value the lead
// ALREADY carries — the caller REAFFIRMED them on this call (codex P1
// r4/r5). Called with the RAW extracted identity values, never the
// fill-only payload: a field the predecessor filled on an EARLIER call is
// omitted from leadUpdates at construction (the normal sequential
// restatement), not just dropped under the lock (the concurrent fill).
// Reaffirmed fields must enter this call's lead_written_state (as the
// lead's current value, prior = the same, so this call's own rejection
// no-ops the field): without the claim, a PREDECESSOR call later
// reprocessed as spam/voicemail/vetoed sees no successor ownership and
// restores the field to its old baseline — often null — erasing a value
// an ACCEPTED later call independently stated. A supplied value that
// DIFFERS from the lead's is not a reaffirmation and claims nothing.
// Phone compares on the last 10 digits; other fields case-insensitively.
function reaffirmedFilledLeadFields(suppliedValues, lockedLead) {
  const out = {};
  if (!lockedLead || !suppliedValues) return out;
  const norm = (f, v) => {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    if (f === 'phone') {
      const digits = s.replace(/\D/g, '');
      return digits.length >= 10 ? digits.slice(-10) : digits;
    }
    return s;
  };
  for (const f of FILL_ONLY_LEAD_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(suppliedValues, f)) continue;
    const lockedVal = lockedLead[f];
    if (lockedVal === null || lockedVal === undefined || lockedVal === '') continue;
    const supplied = norm(f, suppliedValues[f]);
    if (supplied && supplied === norm(f, lockedVal)) out[f] = lockedVal;
  }
  return out;
}

// Re-decide the CONDITIONAL (non-identity) lead fields against the LOCKED
// row (codex P1 r22): every one of these decisions is made from `current`,
// read before the enrichment transaction takes its row lock, and a staff
// edit or a concurrent call in that gap would otherwise be clobbered by the
// stale payload despite the lock — a filled service_interest overwritten, a
// re-parked status reopened, a pulled-in follow-up pushed out, and the
// needs_confirmation union computed against reasons that no longer exist.
// The rolling per-call fields (transcript_summary, this call's own
// extraction payload) refresh unconditionally by design. Dropped or
// recomputed keys also stay out of the rollback ledgers, exactly like the
// identity drops. Pure: returns the reconciled payload plus what the call
// site must sync (the re-judged contact completeness; whether the
// service_interest fill was dropped, so the persisted-label pair the V2
// reassert consumes can be nulled — its WHERE is self-guarded, but the
// label must tell the truth). Runs AFTER dropFilledLeadColumns, so a
// dropped identity key means the locked value is the live one.
function reconcileConditionalLeadFieldsUnderLock(updates, lockedLead, { bridgeNeedsConfirmation = [], leadQuality = null } = {}) {
  if (!lockedLead || !updates) return { updates, contact: null, serviceInterestDropped: false };
  const stillEmpty = (v) => v === null || v === undefined || v === '';
  const out = { ...updates };
  let serviceInterestDropped = false;
  // service_interest is fill-if-empty.
  if (Object.prototype.hasOwnProperty.call(out, 'service_interest') && !stillEmpty(lockedLead.service_interest)) {
    delete out.service_interest;
    serviceInterestDropped = true;
  }
  // urgency: 'urgent' is upgrade-only and always applies; 'normal' was a
  // fill-if-empty decision.
  if (out.urgency === 'normal' && !stillEmpty(lockedLead.urgency)) delete out.urgency;
  // The 'unresponsive' → 'new' reopen only holds while the row is still
  // parked as unresponsive.
  if (Object.prototype.hasOwnProperty.call(out, 'status') && lockedLead.status !== 'unresponsive') delete out.status;
  // The quote-due follow-up is pull-in-only vs the live row.
  if (Object.prototype.hasOwnProperty.call(out, 'next_follow_up_at')) {
    const lockedFollowUp = lockedLead.next_follow_up_at ? new Date(lockedLead.next_follow_up_at) : null;
    if (lockedFollowUp && !isNaN(lockedFollowUp.getTime()) && lockedFollowUp <= out.next_follow_up_at) {
      delete out.next_follow_up_at;
    }
  }
  // extracted_data replaces wholesale, but two of its members and
  // is_qualified derive from the pre-lock row: re-union needs_confirmation
  // with the LOCKED row's standing reasons, and re-judge contact
  // completeness with the locked values behind this pass's effective fills.
  let contact = null;
  if (Object.prototype.hasOwnProperty.call(out, 'extracted_data')) {
    let payload = null;
    try { payload = JSON.parse(out.extracted_data); } catch { payload = null; }
    if (payload) {
      const lockedPriorNeedsConfirmation = (() => {
        try {
          const data = typeof lockedLead.extracted_data === 'string'
            ? JSON.parse(lockedLead.extracted_data)
            : (lockedLead.extracted_data || {});
          return Array.isArray(data.needs_confirmation) ? data.needs_confirmation : [];
        } catch { return []; }
      })();
      const remergedNeedsConfirmation = mergeNeedsConfirmation(lockedPriorNeedsConfirmation, bridgeNeedsConfirmation);
      contact = leadContactCompleteness({
        first_name: out.first_name ?? lockedLead.first_name,
        last_name: out.last_name ?? lockedLead.last_name,
        service_address: out.address ?? lockedLead.address,
        email: out.email ?? lockedLead.email,
      });
      delete payload.needs_confirmation;
      delete payload.missing_for_qualification;
      if (remergedNeedsConfirmation.length) payload.needs_confirmation = remergedNeedsConfirmation;
      if (contact.missing.length) payload.missing_for_qualification = contact.missing;
      out.extracted_data = JSON.stringify(payload);
      if (Object.prototype.hasOwnProperty.call(out, 'is_qualified')) {
        out.is_qualified = ['hot', 'warm'].includes(leadQuality) && contact.complete;
      }
    }
  }
  return { updates: out, contact, serviceInterestDropped };
}

// Postgres casts for the per-field compare-and-swap — parameters arrive as
// text; non-text columns need explicit casts for IS NOT DISTINCT FROM.
const STAMPED_LEAD_FIELD_CASTS = {
  extracted_data: '::jsonb',
  next_follow_up_at: '::timestamptz',
  is_qualified: '::boolean',
  customer_id: '::uuid',
};

// Clear the call's lead stamp AND put the stamped lead's prior state back in
// ONE transaction, fenced on the processing token. The stamp row is
// RE-READ inside the transaction (never the in-memory call object — an
// in-flight attempt may have stamped after the row was loaded), and the
// restore is a per-field COMPARE-AND-SWAP: each field goes back to its
// pre-enrichment value ONLY while it still equals what this call wrote —
// a staff edit made after the enrichment survives rejection untouched
// (pre-push P0 r20: a row-level sentinel silently deleted admin edits to
// fields the editor changes without touching the summary). The reused lead
// itself is never retired here — it predates the call.
// Returns false when the fence lost (peer owns the call); THROWS on
// transient DB failure so callers escalate to the extraction_failed retry
// instead of finalizing half-reconciled.
// `existingTrx` lets the stamp+enrich transaction settle a chronological
// restamp's old epoch inside ITSELF (it already holds the lead lock this
// body takes — same-transaction re-locks are no-ops); every other caller
// omits it and gets the standalone transaction.
async function clearStampAndRestoreLead(call, procToken, callSid, existingTrx = null, attribution = { mode: 'keep' }) {
  const run = async (trx) => {
    const readOwnMd = async () => {
      const fresh = await trx('call_log').where({ id: call.id }).first('metadata');
      try {
        return typeof fresh?.metadata === 'string' ? JSON.parse(fresh.metadata) : (fresh?.metadata || {});
      } catch { return {}; }
    };
    let md = await readOwnMd();
    let stampedLeadId = md?.lead_id ? String(md.lead_id) : null;
    if (!stampedLeadId) {
      // Definitive retirement is provenance-only, NOT stamp-gated
      // (pre-push P1 r11): a sid-linked call carries source_call_id on its
      // funnel row but never a metadata stamp, and a force-reprocess that
      // reclassifies it spam/voicemail/implausible/non-lead must not leave
      // that row reporting funnel stage and revenue for a rejected call.
      // Fenced the same way the stamp-clear write is: only the claim
      // holder may retire — and the ownership read takes the row lock
      // (pre-push P0 r18): a plain SELECT left a window where a peer
      // could reclaim the call between the check and the delete, and the
      // stale worker would irreversibly retire booked/completed
      // attribution despite having lost ownership. FOR UPDATE holds the
      // call row through the retirement in this same transaction, so a
      // reclaimer serializes behind it and this worker's token either
      // still matches (it owns the row) or the read returns nothing.
      if (attribution.mode !== 'retire') return true;
      const owned = await trx('call_log')
        .where({ id: call.id })
        .where('processing_token', procToken)
        .forUpdate()
        .first('id');
      if (!owned) return false;
      await require('./ads/call-attribution').retireAllCallAttributionRows(trx, call.id);
      return true;
    }
    // Reconciliation is SERIALIZED on the stamped lead's row — the same
    // FOR UPDATE lock the stamp+enrich transaction takes, acquired BEFORE
    // the call_log clear so every stamp writer follows one lock order
    // (leads → call_log) and two transactions can never deadlock. Without
    // it, two retries concurrently rejecting calls stamped to the same
    // lead raced (codex P1 r22): the later call could clear its stamp and
    // restore first, while the earlier transaction still saw it as a live
    // successor, skipped every overlapping field, and left this call's
    // AI-written values on the lead with both calls finishing rejected.
    // Own metadata is RE-READ under the lock — a sibling's reconciliation
    // may have re-parented THIS call's baseline while we waited — and the
    // successor scan below is consistent for the same reason: nothing can
    // stamp, clear, or re-parent against this lead without the lock.
    for (let attempt = 0; ; attempt += 1) {
      await trx('leads').where({ id: stampedLeadId }).forUpdate().first();
      md = await readOwnMd();
      const lockedStampedLeadId = md?.lead_id ? String(md.lead_id) : null;
      if (!lockedStampedLeadId) return true;
      if (lockedStampedLeadId === stampedLeadId) break;
      // The stamp moved to a different lead while we waited (only this
      // call's own token holder can do that — vanishingly rare). Re-lock
      // the lead it points at now; give up to the caller's retry path
      // rather than looping unbounded.
      stampedLeadId = lockedStampedLeadId;
      if (attempt >= 2) throw new Error('call→lead stamp kept moving during reconciliation');
    }
    const priorState = md.lead_prior_state && typeof md.lead_prior_state === 'object' ? md.lead_prior_state : null;
    const writtenState = md.lead_written_state && typeof md.lead_written_state === 'object' ? md.lead_written_state : null;
    const ownSeq = Number.isFinite(Number(md.lead_stamp_seq)) ? Number(md.lead_stamp_seq) : null;
    // The pre-stamp settle persists the FORMER lead's identity atomically
    // with its clear (codex P1 r17): the settle commits in its own
    // transaction before the replacement stamp's — if that later
    // transaction fails, the retry claims a call with NO stamp and no
    // preSettleStampedLeadId, so the moved-link branch (its legacy-blocker
    // check and pending-transfer marker) would be skipped and
    // runCallPpcAttribution would double-count the call against the former
    // lead's unresolved legacy row. The breadcrumb rides THIS fenced
    // write; a successful restamp removes it in the stamp transaction.
    const clearedExpr = "((((COALESCE(metadata, '{}'::jsonb) - 'lead_id') - 'lead_prior_state') - 'lead_written_state') - 'lead_stamp_seq') - 'lead_link_via'";
    const cleared = await trx('call_log')
      .where({ id: call.id })
      .where('processing_token', procToken)
      .update({
        metadata: attribution.preserveFormerLeadId
          ? db.raw(`jsonb_set(${clearedExpr}, '{attribution_former_lead_id}', ?::jsonb, true)`, [JSON.stringify(String(stampedLeadId))])
          : db.raw(clearedExpr),
        updated_at: new Date(),
      });
    if (!cleared) return false;
    // Attribution disposition rides the clear (codex P0/P1, PR #3303): the
    // funnel row THIS call created (exact provenance — lead_id +
    // source_call_id; NULL-provenance and other calls' rows never match)
    // accumulates booked/completed stages and revenue via
    // lead-funnel-bridge, so a blanket delete-and-recreate LOSES history.
    // The CALL SITE states intent:
    //   'retire'   — definitive unlink (rejection terminals, the non-lead
    //                verdict, a mint failure): the call supports no lead.
    //   'transfer' — the call's linkage MOVED to a known lead (pre-stamp
    //                settle, stale-stamp maintenance): the row follows via
    //                the shared primitive, stages intact; a target-slot
    //                conflict retires (the target's row is another call's
    //                evidence).
    //   'keep'     — the row already sits on the right lead (same-lead
    //                chronological restamp) or the caller cannot rule a
    //                surviving linkage out: never destroy history.
    if (attribution.mode === 'retire') {
      // Provenance-wide (every lead's row for this call), not just the
      // stamped lead's — rejection means the call supports no lead at all
      // (pre-push P1 r11).
      await require('./ads/call-attribution').retireAllCallAttributionRows(trx, call.id);
    } else if (attribution.mode === 'transfer' && attribution.transferToLeadId
      && String(attribution.transferToLeadId) !== String(stampedLeadId)) {
      await require('./ads/call-attribution').reconcileMovedCallAttributionRow(
        trx, call.id, stampedLeadId, attribution.transferToLeadId, new Date(),
      );
    }
    if (priorState && writtenState) {
      // Successors are read BEFORE the restore because they gate it (codex
      // P2 r19). Two calls can write the SAME value to a field — both
      // setting urgency='urgent' or is_qualified=true is the common case —
      // and the per-field CAS cannot tell whose value is live: it sees
      // current == this call's written and restores the pre-THIS baseline,
      // silently erasing a LATER accepted call's evidence. Re-parenting
      // runs after the restore and only rewrites baselines, so it never
      // puts that value back. A field any later snapshot also wrote is
      // therefore left alone — it is that call's evidence too, and its own
      // rejection will reconcile it.
      const eq = (a, b) => (a ?? null) === (b ?? null);
      const successors = (await trx('call_log')
        .whereRaw("metadata->>'lead_id' = ?", [stampedLeadId])
        .whereNot('id', call.id)
        .select('id', 'metadata'))
        .map((s) => {
          let sm = null;
          try { sm = typeof s.metadata === 'string' ? JSON.parse(s.metadata) : (s.metadata || {}); } catch { sm = null; }
          return { id: s.id, md: sm };
        });
      // "Later" uses the same lead_stamp_seq ordering the re-parent loop
      // does — a per-lead monotonic integer allocated under the lead lock,
      // NOT a wall-clock timestamp (pre-push P1 r3: millisecond app clocks
      // collide under concurrency and skew across pods, and a misordered
      // marker preserves or resurrects the wrong call's values). A missing
      // marker on either side skips conservatively.
      const laterSnapshots = successors.filter((s) => {
        const sSeq = Number.isFinite(Number(s.md?.lead_stamp_seq)) ? Number(s.md.lead_stamp_seq) : null;
        return ownSeq !== null && sSeq !== null && sSeq > ownSeq;
      });
      const ownedByLater = new Set();
      for (const s of laterSnapshots) {
        const sWritten = s.md?.lead_written_state;
        if (!sWritten || typeof sWritten !== 'object') continue;
        for (const f of Object.keys(sWritten)) ownedByLater.add(f);
      }
      const frags = [];
      const binds = [];
      for (const f of STAMPED_LEAD_RESTORE_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(writtenState, f)) continue;
        if (ownedByLater.has(f)) continue;
        const cast = STAMPED_LEAD_FIELD_CASTS[f] || '';
        frags.push(`${f} = CASE WHEN ${f} IS NOT DISTINCT FROM ?${cast} THEN ?${cast} ELSE ${f} END`);
        binds.push(writtenState[f] ?? null, (Object.prototype.hasOwnProperty.call(priorState, f) ? priorState[f] : null) ?? null);
      }
      if (frags.length) {
        frags.push('updated_at = ?');
        binds.push(new Date());
        await trx.raw(
          `UPDATE leads SET ${frags.join(', ')} WHERE id = ? AND deleted_at IS NULL`,
          [...binds, stampedLeadId],
        );
        logger.info(`[call-proc] Reconciled the stamped lead's state after rejection for ${maskSid(callSid)}`);
        // Re-judge qualification against the POST-RESTORE row (codex P1
        // r4): the restore may have removed a contact field a later
        // accepted call's qualification relied on but never restated —
        // is_qualified=true must not survive on a lead whose contact
        // fields no longer support it. DOWNGRADE ONLY: an incomplete
        // judgment here never promotes, and a complete row is left
        // exactly as the surviving owners wrote it.
        const restoredRow = await trx('leads')
          .where({ id: stampedLeadId })
          .whereNull('deleted_at')
          .first('is_qualified', 'first_name', 'last_name', 'address', 'email');
        if (restoredRow?.is_qualified) {
          const restoredContact = leadContactCompleteness({
            first_name: restoredRow.first_name,
            last_name: restoredRow.last_name,
            service_address: restoredRow.address,
            email: restoredRow.email,
          });
          if (!restoredContact.complete) {
            await trx('leads')
              .where({ id: stampedLeadId })
              .update({ is_qualified: false, updated_at: new Date() });
          }
        }
      }
      // Re-parent SUCCESSOR snapshots (audit P1 r21): a call that reused
      // this lead AFTER this one snapshotted THIS call's written values as
      // its rollback baseline — if this call rejects first and the
      // successor rejects later, the successor's restore would resurrect
      // data belonging to an already-rejected call. Point those baseline
      // entries at this call's own prior values instead. (The reverse order
      // needs nothing: the successor's restore re-materializes this call's
      // written values first, and this call's CAS then matches and restores
      // its own prior.) Only snapshots stamped AFTER this call's are
      // eligible — a PREDECESSOR whose prior value coincidentally equals
      // this call's written value (an is_qualified flip-flop is the classic
      // cycle) must keep its own baseline, or rejecting it later restores
      // the wrong value (codex P2 r13) — which is exactly the
      // laterSnapshots filter computed above. Successor lookup rides the
      // metadata lead_id index.
      for (const s of laterSnapshots) {
        const sPrior = s.md?.lead_prior_state;
        if (!sPrior || typeof sPrior !== 'object') continue;
        let changed = false;
        for (const f of Object.keys(writtenState)) {
          if (Object.prototype.hasOwnProperty.call(sPrior, f) && eq(sPrior[f], writtenState[f])) {
            sPrior[f] = Object.prototype.hasOwnProperty.call(priorState, f) ? (priorState[f] ?? null) : null;
            changed = true;
          }
        }
        if (changed) {
          await trx('call_log').where({ id: s.id }).update({
            metadata: db.raw(
              "jsonb_set(COALESCE(metadata, '{}'::jsonb), '{lead_prior_state}', ?::jsonb, true)",
              [JSON.stringify(sPrior)],
            ),
            updated_at: new Date(),
          });
        }
      }
    }
    return true;
  };
  return existingTrx ? run(existingTrx) : db.transaction(run);
}

// Former-lead linkage reconciliation for a STAMP-LESS successful relink
// (codex P1 PR #3303 r18): a standalone keep-settle persisted
// metadata.attribution_former_lead_id, and only the in-loop stamp path
// consumed it — a retry that gained a phone (or selected a sid-linked
// lead) settles stamp-less, skipped the former lead's legacy-blocker check
// and the pending-transfer marker, and runCallPpcAttribution then inserted
// a SECOND row for the new lead while the former lead's unresolved row
// stood. Also covers a live-stamp maintenance TRANSFER
// (transferredFormerLeadId), whose reconcile outcome
// clearStampAndRestoreLead cannot surface: a 'none' there with a stranded
// legacy row is the same double-count.
//
// One transaction in the repo-wide lock order (leads → call_log), fenced
// on the processing token; the authoritative breadcrumb is re-read under
// the lock, so a breadcrumb the stamp transaction already consumed reads
// back cleared and the whole call no-ops. Returns { conflictRetired } —
// true suppresses this pass's funnel write, exactly like the in-stamp
// moved-link branch. Fence loss throws abortProcessing.
async function reconcileFormerLeadLinkage({
  call, procToken, callSid, leadId, transferredFormerLeadId = null,
  leadSourceRow = null, extracted = {}, customerId = null,
}) {
  let conflictRetired = false;
  await db.transaction(async (trx) => {
    // The final lead's row lock serializes this with concurrent stampers
    // and rejections; the fenced call-row lock makes the breadcrumb read
    // authoritative. The target is re-validated LIVE under its lock
    // (codex P1 r19): soft-deleted between linkage and this transaction,
    // transferring the former lead's history onto it would strand the row
    // where runCallPpcAttribution's live-lead predicate can never repair
    // it, and consuming the breadcrumb would erase the only retry state.
    // Keep the breadcrumb (a later reprocess re-runs this reconciliation)
    // and suppress this pass's funnel write.
    const lockedTarget = await trx('leads')
      .where({ id: leadId })
      .whereNull('deleted_at')
      .forUpdate()
      .first('id');
    if (!lockedTarget) {
      conflictRetired = true;
      logger.warn(`[call-proc] stamp-less relink of ${callSid} targets a missing/deleted lead ${leadId} — breadcrumb retained, funnel write suppressed`);
      return;
    }
    const owned = await trx('call_log')
      .where({ id: call.id })
      .where('processing_token', procToken)
      .forUpdate()
      .first('id', 'metadata');
    if (!owned) {
      const lost = new Error('processing claim lost during former-lead linkage reconciliation');
      lost.abortProcessing = true;
      throw lost;
    }
    let ownedMd = {};
    try {
      ownedMd = typeof owned.metadata === 'string' ? (JSON.parse(owned.metadata) || {}) : (owned.metadata || {});
    } catch { ownedMd = {}; }
    const breadcrumb = ownedMd.attribution_former_lead_id ? String(ownedMd.attribution_former_lead_id) : null;
    const formerLeadId = breadcrumb || (transferredFormerLeadId ? String(transferredFormerLeadId) : null);
    let markerPayload = null;
    if (formerLeadId && formerLeadId !== String(leadId)) {
      const attrMod = require('./ads/call-attribution');
      // The transfer-settle path already moved the row when it could —
      // re-running is a no-op there ('none': the source row is gone) and
      // the BREADCRUMB path's actual move. Outcome semantics mirror the
      // in-stamp moved-link branch.
      const moveOutcome = await attrMod.reconcileMovedCallAttributionRow(
        trx, call.id, formerLeadId, leadId, new Date(),
      );
      if (moveOutcome === 'retired_conflict') conflictRetired = true;
      if (moveOutcome === 'none') {
        // 'none' is ambiguous: the former row may be gone (a completed
        // transfer — fine) or LEGACY NULL-provenance (frozen — another
        // call may own it). Only the stranded legacy shape suppresses
        // this pass's funnel write and arms the durable retry marker,
        // exactly like the stamped path (codex P1 r11/r12).
        const stranded = await trx('ad_service_attribution')
          .where({ lead_id: formerLeadId })
          .whereNull('source_call_id')
          .first('id');
        if (stranded) {
          conflictRetired = true;
          const markerAttr = leadSourceRow
            ? attrMod.attributionForSourceType(leadSourceRow.source_type)
            : null;
          const markerBridgeTarget = leadSourceRow
            && require('./ads/google-call-bridge').isBridgeTargetNumber(leadSourceRow.twilio_phone_number);
          if (customerId && markerAttr && !markerBridgeTarget) {
            markerPayload = {
              from_lead_id: String(formerLeadId),
              // The marker's TARGET, persisted explicitly (codex P1 r19):
              // this relink is deliberately STAMP-LESS (gained-phone /
              // sid-linked — no metadata.lead_id), and the transfer sweep
              // derives its target from the stamp, so without this the
              // sweep read the marker as a positively-cleared linkage and
              // deleted it without ever writing the attribution it
              // carried. The sweep gives a live stamp precedence.
              to_lead_id: String(leadId),
              lead_source: markerAttr.leadSource,
              is_paid: markerAttr.isPaid,
              detail: leadSourceRow.name || 'inbound call',
              service_interest: extracted.matched_service || extracted.requested_service || null,
            };
          }
          logger.warn(`[call-proc] stamp-less relink of ${callSid} left a legacy unprovenanced row on lead ${formerLeadId} — funnel write suppressed to avoid double-counting`);
        }
      }
    }
    // Consume the breadcrumb (and arm the marker) in ONE fenced write; the
    // same-lead breadcrumb (linkage returned home) clears without
    // reconciliation — its row already sits on this lead and the funnel
    // write dedupes by lead. Nothing to write when only the transfer path
    // ran breadcrumb-less and found no stranded row.
    if (breadcrumb || markerPayload) {
      const cleared = await trx('call_log')
        .where({ id: call.id })
        .where('processing_token', procToken)
        .update({
          metadata: markerPayload
            ? db.raw(
              "jsonb_set(COALESCE(metadata, '{}'::jsonb) - 'attribution_former_lead_id', '{attribution_transfer_pending}', ?::jsonb, true)",
              [JSON.stringify(markerPayload)],
            )
            : db.raw("COALESCE(metadata, '{}'::jsonb) - 'attribution_former_lead_id'"),
          updated_at: new Date(),
        });
      if (!cleared) {
        const lost = new Error('processing claim lost during former-lead breadcrumb consumption');
        lost.abortProcessing = true;
        throw lost;
      }
    }
  });
  return { conflictRetired };
}

// New-lead admin surfacing for a lead minted by call processing — the fresh
// insert on a lookup miss AND the claim-race recovery mint (codex P2, PR
// #3275: a race-recovered lead is just as new as a fresh one, and on the
// phone-less path the SMS rail fails closed, so skipping this left it with
// no bell or push at all). Untracked calls ring the admin bell directly —
// category 'lead' is default-denied under GATE_ADMIN_BELL_POLICY, but a new
// lead must ring like every other new lead. Tracked marketing calls fire the
// same new_lead bell + Web Push the web-form path sends. Best-effort BY
// CONTRACT: never throws — the race-mint call site sits inside the mint's
// try/catch, where a thrown notify error would be misread as a mint failure
// and null out a lead that DID insert.
async function notifyNewCallLead({ leadId, phone, extracted, leadSourceId, leadSourceRow, call }) {
  const callerName = [capitalizeName(extracted.first_name), capitalizeName(extracted.last_name || '')]
    .filter(Boolean)
    .join(' ');
  if (!leadSourceId) {
    try {
      await require('./notification-service').notifyAdmin(
        'lead',
        'Untracked call lead',
        `New lead from a call we couldn't attribute: ${callerName || 'Unknown caller'} (${phone || 'unknown number'}). No marketing source matched — tag the source or follow up.`,
        {
          link: `/admin/leads?lead=${leadId}`,
          metadata: { leadId, phone, callSid: call.twilio_call_sid },
          bell: true,
        },
      );
    } catch (notifyErr) {
      logger.warn(`[call-proc] untracked-call admin notify failed: ${notifyErr.message}`);
    }
  } else {
    try {
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
    // null = TRANSIENT FAILURE, distinct from the deliberate `false` no-ops
    // above (quote kept open, lead already won/unowned, lost race) — the
    // legacy-activation hook keys retryability on exactly this distinction
    // (Codex #3361 r6 P1). Same falsiness for every truthiness-checking
    // caller.
    return null;
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
    // The subscriber row is re-verified and LOCKED through the provider
    // call (Codex #3084 r51 — the same pending/token lock-through-send
    // discipline as resendPendingConfirmation): subscribeOrResubscribe
    // pre-stamps confirmation_sent_at in its own committed statement, so a
    // one-click/admin unsubscribe could otherwise commit in the gap and
    // still be mailed the confirmation. Under the row lock the unsubscribe
    // queues and lands strictly after the send decision. A refused
    // re-verify skips the send: the row is no longer OUR pending payload
    // (unsubscribed, or rotated — the rotation's own callback owns its
    // delivery), and the conditional stamp-clear below no-ops for the same
    // reason. A commit error AFTER a successful send is harmless — the
    // transaction held only the row lock, and the pre-stamp is already
    // durable.
    let sendRefused = false;
    try {
      await db.transaction(async (trx) => {
        const liveSubscriber = await trx('newsletter_subscribers')
          .where({
            id: result.subscriber.id,
            confirmation_token: result.subscriber.confirmation_token,
            status: 'pending',
          })
          .whereRaw('LOWER(email) = ?', [String(result.subscriber.email || emailLc).trim().toLowerCase()])
          .forUpdate()
          .first('id');
        if (!liveSubscriber) {
          sendRefused = true;
          return;
        }
        await sendConfirmationEmail(result.subscriber);
        confirmationEmailSent = true;
      });
      if (sendRefused) {
        logger.info(`[call-proc] Newsletter confirmation skipped for customer ${customerId}: subscriber no longer pending at the locked re-verify`);
        confirmationEmailSent = false;
      }
    } catch (e) {
      if (confirmationEmailSent === true) {
        // The provider accepted the message and only the (write-free)
        // transaction commit failed — the DOI is out and the pre-stamp is
        // durable; do NOT clear it or the retry double-mails.
        logger.warn(`[call-proc] newsletter send transaction commit errored after the send for customer ${customerId}: ${e.code || e.name || 'db_error'} — pre-stamp stands`);
        e = null;
      }
      if (e) {
        logger.warn(`[call-proc] Newsletter confirmation email failed for customer ${customerId}`);
        confirmationEmailSent = false;
        // subscribeOrResubscribe stamps confirmation_sent_at BEFORE the send —
        // clear it on failure so retry paths (the first-touch-resume DOI
        // dedupe guard, the stale-pending sweep) never read the pre-send
        // stamp as delivery (Codex #3084 r13). Scoped to the ATTEMPTED
        // email/token/status (Codex #3084 r27): a correction rotating the
        // subscriber mid-send pre-stamps its OWN DOI, and an id-only clear
        // would null the rotated token's timestamp — making the newer mailed
        // token permanent (no expiry, purge-exempt). Zero rows = rotated →
        // the rotation's own callback owns its stamp.
        if (result.subscriber?.id) {
          try {
            await db('newsletter_subscribers')
              .where({
                id: result.subscriber.id,
                confirmation_token: result.subscriber.confirmation_token,
                status: 'pending',
              })
              .whereRaw('LOWER(email) = ?', [String(result.subscriber.email || emailLc).trim().toLowerCase()])
              .update({ confirmation_sent_at: null, updated_at: new Date() });
          } catch (clearErr) {
            logger.warn(`[call-proc] confirmation_sent_at clear failed for subscriber ${result.subscriber.id}: ${clearErr.code || clearErr.name || 'db_error'}`);
          }
        }
      }
    }
  }

  logger.info(`[call-proc] Newsletter subscriber ${result.action} for customer ${customerId}`);
  return {
    action: result.action,
    subscriberId: result.subscriber?.id || null,
    // The attempted token rides the outcome (Codex #3084 r32) so a send
    // failure can be verified against the EXACT attempt — corrections
    // rotate the token, and an A→B→A rotation restores id+email with a
    // newer token whose DOI may already be delivered.
    confirmationToken: result.subscriber?.confirmation_token || null,
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

// Resolve the booked visit's OWN address (the call's post-AV service address)
// and, when it exactly key-matches one of the customer's known properties,
// that property's id. Exact addressKey match only — a booking must never be
// GUESSED onto a property. Returns nulls when the call carried no address
// (readers COALESCE back to the customer mirror, i.e. today's behavior).
async function resolveCallBookingPropertyLinkage(customerId, extracted, trx = db) {
  const clean = (v, max) => {
    const s = String(v == null ? '' : v).trim();
    return s ? s.slice(0, max) : null;
  };
  let address = {
    line1: clean(extracted.address_line1, 200),
    line2: clean(extracted.address_line2, 100),
    city: clean(extracted.city, 50),
    state: clean(extracted.state, 2),
    zip: clean(extracted.zip, 10),
  };
  if (!address.line1) {
    // The caller didn't state an address on this call (e.g. an existing
    // customer confirming a re-service). Dispatch to their on-file,
    // Google-verified address instead of leaving the visit address blank —
    // never book a location-less appointment. Falls THROUGH to the exact
    // property match below: the on-file address may itself be an active
    // customer_properties row whose property_id + geocode the visit should
    // carry (map pin), same as a caller-stated address.
    let onFile = null;
    try {
      const cust = await trx('customers').where({ id: customerId })
        .first('address_line1', 'address_line2', 'city', 'state', 'zip');
      if (cust && String(cust.address_line1 || '').trim()) {
        onFile = {
          line1: clean(cust.address_line1, 200),
          line2: clean(cust.address_line2, 100),
          city: clean(cust.city, 50),
          state: clean(cust.state, 2),
          zip: clean(cust.zip, 10),
        };
      }
    } catch (e) {
      logger.warn(`[call-proc] on-file address fallback failed for booking: ${e.code || e.message}`);
    }
    if (!onFile) return { propertyId: null, address: null, lat: null, lng: null };
    address = onFile;
  }
  let propertyId = null;
  let lat = null;
  let lng = null;
  try {
    const { addressKey } = require('./customer-properties');
    const callKey = addressKey({
      address_line1: address.line1, address_line2: address.line2, city: address.city, zip: address.zip,
    });
    if (callKey) {
      const props = await trx('customer_properties')
        .where({ customer_id: customerId, active: true })
        .select('id', 'address_line1', 'address_line2', 'city', 'zip', 'latitude', 'longitude');
      const matches = props.filter((p) => addressKey(p) === callKey);
      if (matches.length === 1) {
        propertyId = matches[0].id;
        // The property's own geocode rides along — without it the visit's
        // map pin would fall back to the customer's PRIMARY coordinates
        // while the text shows the rental (codex P1).
        if (matches[0].latitude != null && matches[0].longitude != null) {
          lat = matches[0].latitude;
          lng = matches[0].longitude;
        }
      }
    }
  } catch (e) {
    logger.warn(`[call-proc] property-linkage resolution failed (booking proceeds unlinked): ${e.code || e.message}`);
  }
  return { propertyId, address, lat, lng };
}

/**
 * Property-scope premise for a phone re-service booking (codex #3222 r8):
 * resolveCallBookingPropertyLinkage's null propertyId is AMBIGUOUS — it can
 * mean the on-file address (no property row / legacy account) OR a caller-
 * stated address that matched nothing. And a linked propertyId can be the
 * backfilled PRIMARY row, whose coverage often predates property linkage
 * (legacy rows carry null property_id), so requiring property-scoped
 * coverage for the primary would false-hold valid requests.
 *
 *   'account'  — the booking premise IS the customer's primary/on-file
 *                address (linked primary row, or address equal to the
 *                on-file address, or no address at all): the account-level
 *                lane grant suffices, legacy unlinked coverage included.
 *   'property' — a linked NON-primary property (a rental, a second home):
 *                needs its own qualifying live coverage.
 *   'unknown'  — a stated address that matches neither a property row nor
 *                the on-file address: never a free visit there, hold.
 * Fail-closed: classification errors return 'unknown'.
 */
async function classifyReServiceBookingPremise({ customer, propertyLinkage, trx = db }) {
  const linkedId = propertyLinkage?.propertyId || null;
  if (linkedId) {
    try {
      const prop = await trx('customer_properties').where({ id: linkedId }).first('is_primary');
      return prop?.is_primary ? { scope: 'account' } : { scope: 'property', propertyId: linkedId };
    } catch (e) {
      logger.warn(`[call-proc] re-service premise lookup failed for property ${linkedId}: ${e.code || e.message}`);
      return { scope: 'unknown' };
    }
  }
  const booked = propertyLinkage?.address || null;
  if (!booked) return { scope: 'account' };
  try {
    const { addressKey } = require('./customer-properties');
    const bookedKey = addressKey({
      address_line1: booked.line1, address_line2: booked.line2, city: booked.city, zip: booked.zip,
    });
    const onFileKey = addressKey({
      address_line1: customer?.address_line1, address_line2: customer?.address_line2, city: customer?.city, zip: customer?.zip,
    });
    if (bookedKey === onFileKey) return { scope: 'account' };
  } catch (e) {
    logger.warn(`[call-proc] re-service premise address compare failed: ${e.code || e.message}`);
  }
  return { scope: 'unknown' };
}

// A booked row IS a covered re-service callback when it carries the
// is_callback stamp or the re-service catalog label — the authority for
// row-based decisions (lead conversion on reuse/attach), where the CURRENT
// resolver opinion may differ from what was actually booked (codex #3231).
function isReServiceBookingRow(row) {
  if (!row) return false;
  if (row.is_callback === true) return true;
  const { isReService } = require('./re-service');
  return isReService({ serviceType: row.service_type });
}

// Conversion-gate variant (codex #3231 r7): an operator-created re-service
// carrying a billable extra (is_callback + positive estimated_price —
// admin-schedule supports this) is a PAID sale, not a $0 callback, and its
// lead must still convert. Only an actually-free callback suppresses.
function isFreeReServiceBookingRow(row) {
  return isReServiceBookingRow(row) && !(Number(row?.estimated_price) > 0);
}

async function findExistingCallAppointment({ customerId, call, scheduledDate, windowStart, serviceType, trx = db }) {
  if (!customerId) return null;

  // An ATTACHED booking (a human's row this call was linked to — see
  // findAttachableCallAppointment) carries no Call SID marker in notes and
  // no phone_call booking_source, so a reprocess would miss it through both
  // lookups below and re-book the visit. source_call_log_id is the durable
  // this-call linkage (stamped on attach AND on fresh inserts), so it is
  // checked first. Child rows stamp it too — same exclusion as below.
  if (call.id) {
    const linked = await trx('scheduled_services')
      .where({ customer_id: customerId, source_call_log_id: call.id })
      .whereNull('parent_service_id')
      .whereNotIn('status', ['cancelled', 'rescheduled'])
      .orderBy('created_at', 'asc')
      .first();
    if (linked) return linked;
  }

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

// Card-on-file spec §3 Phase 5.5: the guard above only sees THIS call's own
// rows. A visit booked by a HUMAN through another channel while the call was
// still being processed (the office books it in the portal mid-call; the
// customer self-books right after hanging up) is invisible to it, and the
// pipeline would insert a duplicate. Find live parent visits for this
// customer with the SAME service line within ±1 day of the extracted date:
//  - exactly one match → the visit already exists; the caller ATTACHES the
//    call to it (stamps source_call_log_id) instead of inserting.
//  - multiple matches → ambiguous; the caller holds for human review.
// phone_call-sourced rows and rows already linked to a call are excluded:
// other calls' bookings keep their own dedup story (the same-day hold),
// and re-attaching them would hijack that call's linkage.
async function findAttachableCallAppointment({ customerId, scheduledDate, serviceType, trx = db }) {
  const none = { row: null, ambiguous: [] };
  if (!customerId || !scheduledDate || !serviceType) return none;
  const anchor = new Date(`${scheduledDate}T00:00:00Z`);
  if (Number.isNaN(anchor.getTime())) return none;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const windowFrom = new Date(anchor.getTime() - DAY_MS).toISOString().slice(0, 10);
  const windowTo = new Date(anchor.getTime() + DAY_MS).toISOString().slice(0, 10);
  const candidates = await trx('scheduled_services')
    .where({ customer_id: customerId })
    .whereNull('parent_service_id')
    .whereIn('status', ['pending', 'confirmed'])
    .whereNull('source_call_log_id')
    .where((qb) => qb.whereNull('booking_source').orWhereNot('booking_source', 'phone_call'))
    .whereBetween('scheduled_date', [windowFrom, windowTo])
    .whereRaw('LOWER(TRIM(service_type)) = LOWER(TRIM(?))', [serviceType])
    .orderBy('created_at', 'asc');
  const rows = Array.isArray(candidates) ? candidates : [];
  if (rows.length === 1) return { row: rows[0], ambiguous: [] };
  if (rows.length > 1) return { row: null, ambiguous: rows };
  return none;
}

// Attach evidence check (Codex #2771): same service line within ±1 day is
// not enough for a multi-property customer — the call may discuss the
// rental while the only nearby manual booking is for the primary home.
// Attach only when the candidate's property evidence AGREES with the
// call's resolved linkage: matching property ids, or matching service
// address line 1, or no explicit evidence on either side (both resolve to
// the customer's primary property). One-sided evidence can't confirm the
// match — the caller falls through to the normal hold/insert path, since
// a different property's visit is not a duplicate.
// Slot evidence for the attach guard (Codex #2771 r9): property + service
// + ±1 day alone can't distinguish "re-confirming the visit the office
// just booked" from "adding a SECOND visit near an existing one" — and
// attaching in the second case silently loses the requested booking.
// Attach only when the candidate sits on the SAME date as the call's
// extracted date AND the window agrees (or the call carried no usable
// time); neighbor-day and different-time matches hold for human review.
function attachCandidateSlotAgrees(candidate, { scheduledDate, windowStart } = {}) {
  const candDate = callBookingDateOnly(candidate?.scheduled_date);
  if (!candDate || !scheduledDate || candDate !== scheduledDate) return false;
  const candStart = String(candidate?.window_start || '').slice(0, 5);
  const reqStart = String(windowStart || '').slice(0, 5);
  if (!candStart || !reqStart) return true;
  return candStart === reqStart;
}

function attachCandidateMatchesProperty(candidate, linkage) {
  const norm = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const candProp = candidate?.property_id || null;
  const linkProp = linkage?.propertyId || null;
  if (candProp && linkProp) return String(candProp) === String(linkProp);
  const candAddr = norm(candidate?.service_address_line1);
  const linkAddr = norm(linkage?.address?.line1);
  if (candAddr && linkAddr) {
    if (candAddr !== linkAddr) return false;
    // Same street ≠ same unit (Codex #2771 r2): a multi-unit address must
    // agree on line2 too — Apt A's booking is not evidence for a call
    // about Apt B, and a one-sided unit can't confirm the match.
    if (norm(candidate?.service_address_line2) !== norm(linkage?.address?.line2)) return false;
    // Same street name ≠ same property (Codex #2771 r3): "123 Main St"
    // exists in Bradenton AND Venice — city and ZIP must agree wherever
    // both sides carry them (both-empty passes; a conflict refuses).
    const candCity = norm(candidate?.service_address_city);
    const linkCity = norm(linkage?.address?.city);
    if (candCity && linkCity && candCity !== linkCity) return false;
    const zip5 = (v) => String(v || '').trim().slice(0, 5);
    const candZip = zip5(candidate?.service_address_zip);
    const linkZip = zip5(linkage?.address?.zip);
    if (candZip && linkZip && candZip !== linkZip) return false;
    return true;
  }
  return !candProp && !linkProp && !candAddr && !linkAddr;
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
  // PERSISTED-OR-REVIEW: only emails actually STORED (customer.email or a
  // service-contact slot) satisfy this gate — appointment-email's recipient
  // resolver reads stored addresses only, so an email that exists solely in
  // the extraction (slot write gated off, slots full, race, or a
  // persistCallSecondaryContact skip) could never receive the confirmation.
  // The gated persistence runs BEFORE this gate on a freshly re-read customer
  // row, so a successfully stored secondary email passes via slotEmail; when
  // it wasn't stored, the booking correctly holds as
  // missing_required_customer_fields for the office instead of auto-creating
  // an appointment whose named recipient is unreachable.
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
  if (!String(merged.streetAddress || '').trim()) missing.push('street_address');
  if (!String(merged.city || '').trim()) missing.push('city');
  if (!String(merged.state || '').trim()) missing.push('state');
  if (!String(merged.zip || '').trim()) missing.push('zip');

  // Email is ADVISORY, not required (owner ruling 2026-07-31): a caller who
  // books but never gives an email must still book — most confirmations go
  // by SMS, and the office collects the email via the advisory card the call
  // site files. A stored/extracted email that fails EMAIL_RE also lands here
  // (garbled capture ≈ no capture). PERSISTED-OR-REVIEW above still governs
  // WHICH emails count when one exists.
  const advisory = [];
  if (!EMAIL_RE.test(String(merged.email || '').trim().toLowerCase())) {
    advisory.push('email');
  }

  return { ok: missing.length === 0, missing, advisory, details: merged };
}

async function backfillCustomerFromAppointmentContact(customerId, customer = {}, extracted = {}, callerPhone = null, { suppressPhone = false } = {}) {
  if (!customerId) return customer;
  const updates = {};
  if (!customer.first_name && extracted.first_name) updates.first_name = capitalizeName(extracted.first_name);
  if (!customer.last_name && extracted.last_name) updates.last_name = capitalizeName(extracted.last_name);
  // suppressPhone: the caller-phone identity check flagged that this call's
  // ANI isn't on any of the linked customer's phone slots — writing the
  // number here would permanently save an UNVERIFIED phone to a possibly
  // wrong account before the office gets the review the advisory card
  // promises (codex P1). The rest of the backfill still runs.
  if (!customer.phone && (extracted.phone || callerPhone) && !suppressPhone) updates.phone = extracted.phone || callerPhone;
  // A GARBLED stored email counts as absent (codex round-12 P2): the first
  // call can persist an EMAIL_RE-failing capture; treating that truthy value
  // as "has an email" would block the later call's VALID capture from ever
  // replacing it — and the customer_email_missing card would sit open with
  // no path to the fix. Only an invalid stored value is replaceable; a valid
  // stored email is never overwritten by a call capture.
  const storedEmailInvalid = customer.email && !EMAIL_RE.test(String(customer.email).trim().toLowerCase());
  const extractedEmailValid = extracted.email && EMAIL_RE.test(String(extracted.email).trim().toLowerCase());
  if ((!customer.email || storedEmailInvalid) && extractedEmailValid) updates.email = extracted.email;
  if (!customer.address_line1 && extracted.address_line1) updates.address_line1 = extracted.address_line1;
  if (!customer.city && extracted.city) updates.city = extracted.city;
  if (!customer.state && extracted.state) updates.state = extracted.state;
  if (!customer.zip && extracted.zip) updates.zip = extracted.zip;
  if (Object.keys(updates).length === 0) return customer;
  updates.updated_at = new Date();
  // An empty→value email write has no old address to retarget, so the
  // lightweight path (resolve the cards only) is right. REPLACING a garbled
  // stored email is a different write: copies of that old address really are
  // out there — leads, estimates, newsletter tokens, open sends — and
  // AGENTS.md requires every email change to fan out. Skipping it left those
  // bound to an address the customer cannot receive (local pre-push audit
  // P1, and round-13 residual #1). Either way the read-back cards filed for
  // THIS capture must not settle: the capture is unverified by design, so
  // only customer_email_missing resolves (round-9 + round-10 P2).
  //
  // BOTH paths serialize with a concurrent merge-undo's claim check via the
  // shared normalized-email advisory lock (r16 — every writer that ASSIGNS
  // an email must, or revertMerge's "is this address claimed?" probe is
  // dishonest). The guard is proceed-with-fresh-read: only the email column
  // is ever dropped (filled concurrently / owned by another live customer)
  // — the rest of the backfill always lands, and the extraction/triage
  // records keep the heard address for office review either way.
  //
  // The replacement additionally runs the customer write and the fan-out in
  // ONE guarded transaction (codex round-24 P1): writing the email first
  // and swallowing a fan-out failure left the customer on the new address
  // with snapshots half-migrated — permanently, because the next call sees
  // a VALID stored email and never retries. The guard's failure path rolls
  // both back, keeping the malformed value — the retryable state.
  const replacingGarbledEmail = !!(updates.email && storedEmailInvalid);
  const fanout = require('./customer-email-fanout');
  const guarded = await fanout.applyCustomerUpdatesWithEmailClaimGuard({
    customerId, updates,
    source: 'call-appointment-contact-backfill',
    ...(replacingGarbledEmail ? {
      replaceExpectedEmail: customer.email,
      applyWithEmailInTrx: async (trx) => {
        await trx('customers').where({ id: customerId }).update(updates);
        await fanout.propagateCustomerEmailChange({
          before: customer,
          after: { id: customerId, email: updates.email },
          source: 'call-captured email replacing a garbled address (appointment backfill)',
          reviewReasonCodes: ['customer_email_missing'],
        }, trx);
      },
    } : {}),
  });
  if (updates.email && !guarded.emailApplied) delete updates.email;
  if (updates.email && !replacingGarbledEmail) {
    // Empty→value only: the replacement's card settlement rides the
    // fan-out inside the guarded transaction above.
    try {
      await fanout.resolveOpenEmailReviewCards({
        customerId, email: updates.email,
        source: 'call-captured email (appointment backfill)',
        reasonCodes: ['customer_email_missing'],
      });
    } catch (e) {
      logger.warn(`[call-proc] email review-card resolution failed after backfill for customer ${customerId}: ${e.message}`);
    }
  }
  return { ...customer, ...updates };
}

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

// ── Download Twilio recording (authenticated) ──
// ── Provider-fetch timeouts ─────────────────────────────────────────────
//
// A HUNG provider call (TCP black hole, provider incident) never throws, so
// it never increments the extraction retry budget — the 10-min stale-lock
// reclaim just re-runs it every cycle forever while the zombie runs pile up.
// Bounding every provider fetch converts a hang into an ordinary thrown
// TimeoutError that flows the EXISTING failure paths: extraction_attempts +
// exhausted triage for extraction, the Gemini fallback / no_transcription
// path for transcription, and the audit-log skip for the label pass.
// Defaults are deliberately generous — these kill hangs, they must never
// race a slow-but-working provider (a 9-minute recording transcribes slowly).
// Env-tunable without deploy.
function envMs(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const PROVIDER_FETCH_TIMEOUTS_MS = {
  recording_download: envMs('CALL_PROC_DOWNLOAD_TIMEOUT_MS', 120000),
  transcription: envMs('CALL_PROC_TRANSCRIBE_TIMEOUT_MS', 300000),
  transcript_label: envMs('CALL_PROC_LABEL_TIMEOUT_MS', 120000),
  extraction: envMs('CALL_PROC_EXTRACT_TIMEOUT_MS', 180000),
};
function providerTimeoutSignal(kind) {
  return AbortSignal.timeout(PROVIDER_FETCH_TIMEOUTS_MS[kind] || PROVIDER_FETCH_TIMEOUTS_MS.extraction);
}

// Twilio's recording-status webhook fires before the MP3 is reliably
// fetchable from their CDN — an early authenticated download can 404 (handled
// by the !res.ok throw) or, worse, return a truncated 200 whose partial audio
// transcribes into a silently incomplete transcript that gets marked
// processed forever. Prod recordings run ~7.8KB/s (64kbps mp3); a buffer far
// below that floor for the recording's KNOWN duration is a partial read, not
// a short call. The floor is deliberately loose (≈40% of the observed rate)
// so a codec/bitrate change degrades to a no-op rather than false rejects.
const MIN_AUDIO_BYTES_PER_SEC = Number(process.env.CALL_PROC_MIN_AUDIO_BYTES_PER_SEC) || 3000;
// A truncated download is only "not ready" while Twilio's CDN can still be
// propagating. Past this window (measured from the call row's creation) the
// recording is as complete as it will ever get, so verification stands down
// and behavior reverts to the pre-verification path.
const NOT_READY_MAX_AGE_MS = Number(process.env.CALL_PROC_NOT_READY_MAX_AGE_MS) || 60 * 60 * 1000;
const RECORDING_NOT_READY = 'RECORDING_NOT_READY';

// Estimate playable duration from the MP3 frame header (Twilio recordings are
// CBR, so bytes*8/bitrate is accurate). Returns null when no parseable Layer
// III header is found — callers then fall back to the loose byte floor.
function estimateMp3DurationSeconds(buffer) {
  if (!buffer || buffer.length < 4) return null;
  const MPEG1_L3_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const MPEG2_L3_KBPS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const scanLimit = Math.min(buffer.length - 4, 65536);
  for (let i = 0; i <= scanLimit; i++) {
    if (buffer[i] !== 0xff || (buffer[i + 1] & 0xe0) !== 0xe0) continue;
    const versionBits = (buffer[i + 1] >> 3) & 0x03; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5, 1=reserved
    const layerBits = (buffer[i + 1] >> 1) & 0x03;   // 1=Layer III
    const bitrateIdx = (buffer[i + 2] >> 4) & 0x0f;
    if (versionBits === 1 || layerBits !== 1 || bitrateIdx === 0 || bitrateIdx === 15) continue;
    const kbps = versionBits === 3 ? MPEG1_L3_KBPS[bitrateIdx] : MPEG2_L3_KBPS[bitrateIdx];
    if (!kbps) continue;
    return (buffer.length * 8) / (kbps * 1000);
  }
  return null;
}

function verifyRecordingBuffer(buffer, expectedSeconds, contentLength) {
  const bytes = buffer ? buffer.length : 0;
  const declared = Number(contentLength);
  if (Number.isFinite(declared) && declared > 0 && bytes < declared) {
    return { ok: false, reason: 'short_read', bytes, declared };
  }
  const seconds = Number(expectedSeconds);
  // Sub-3s recordings are legitimately tiny; duration checks only mean
  // anything when the duration is known and non-trivial.
  if (!Number.isFinite(seconds) || seconds < 3) return { ok: true, bytes };
  // Primary check: decoded audio duration must cover ≥90% of the recording's
  // known length. Catches truncated 200s whose Content-Length matches the
  // truncated body — a byte floor alone passes any prefix over the floor
  // rate, silently losing the tail (Codex #3037 P1).
  const estimated = estimateMp3DurationSeconds(buffer);
  if (estimated !== null) {
    if (estimated < seconds * 0.9) {
      return { ok: false, reason: 'duration_shortfall', bytes, estimated_seconds: Math.round(estimated), expected_seconds: seconds };
    }
    return { ok: true, bytes };
  }
  // No parseable MP3 header (unexpected codec): loose byte floor, tuned so a
  // codec/bitrate change degrades to a no-op rather than false rejects.
  if (bytes < seconds * MIN_AUDIO_BYTES_PER_SEC) {
    return { ok: false, reason: 'below_duration_floor', bytes, expected_min: seconds * MIN_AUDIO_BYTES_PER_SEC };
  }
  return { ok: true, bytes };
}

async function downloadRecording(mp3Url, opts = {}) {
  const twilioAuth = Buffer.from(
    `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
  ).toString('base64');

  const res = await fetch(mp3Url, {
    headers: { Authorization: `Basic ${twilioAuth}` },
    redirect: 'follow',
    signal: providerTimeoutSignal('recording_download'),
  });
  if (!res.ok) {
    const err = new Error(`Download failed: ${res.status}`);
    // 404 on a URL Twilio just announced = CDN propagation lag, not a
    // missing recording — callers treat it as retryable, same as a
    // truncated buffer below.
    if (res.status === 404 && opts.expectedSeconds) err.code = RECORDING_NOT_READY;
    throw err;
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (opts.expectedSeconds) {
    const verdict = verifyRecordingBuffer(buffer, opts.expectedSeconds, res.headers.get('content-length'));
    if (!verdict.ok) {
      const err = new Error(`Recording not ready: ${verdict.reason} (${verdict.bytes} bytes for ${opts.expectedSeconds}s)`);
      err.code = RECORDING_NOT_READY;
      throw err;
    }
  }
  return buffer;
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
      signal: providerTimeoutSignal('transcript_label'),
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
      if (modelSupportsKeywordHints(model)) {
        for (const keyword of transcriptionKeywords()) form.append('keywords[]', keyword);
      }
    }
    form.append('temperature', '0');

    const res = await fetch(OPENAI_TRANSCRIPTIONS_API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: providerTimeoutSignal('transcription'),
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
    // PAN redaction guard — applied at the PROVIDER RETURN, before any other
    // LLM sees the text: the labeling pass (labelTranscriptWithOpenAI)
    // consumes this raw transcript, so scrubbing only at persistence would
    // still embed a blurted card number in the labeling prompt (Codex #2676
    // round-1 P1). The dictation contact-pass rides this same function, so
    // it is covered here too.
    const panScrub = scrubPansDetailed(text);
    // scrubSegments bridges adjacent-segment splits — a readback the
    // provider divided across two segments must not hide below the
    // 13-digit floor on either side (Codex #2676 round-5 P1).
    const segScrub = scrubSegments(normalizeOpenAISegments(data));
    const segments = segScrub.segments;
    const segScrubCount = segScrub.count;
    if (panScrub.count + segScrubCount > 0) {
      logger.warn(`[call-proc] PAN scrub masked ${panScrub.count + segScrubCount} card artifact(s) at OpenAI provider return`);
    }
    return {
      text: panScrub.text,
      segments,
      provider: 'openai',
      model,
      responseFormat: diarized ? 'diarized_json' : 'json',
      // Carried up to processRecording's quarantine trigger — the provider
      // scrub masks the text, so the later choke-point scrub sees a clean
      // transcript and would otherwise never learn the AUDIO carries a card
      // (Codex #2676 round-3 P1).
      panCount: panScrub.count + segScrubCount,
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
        signal: providerTimeoutSignal('transcription'),
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
    const raw = (textPart?.text || parts[0]?.text || '').trim() || null;
    if (!raw) return null;
    // PAN redaction guard at the provider return (see the OpenAI twin above).
    const panScrub = scrubPansDetailed(raw);
    return { text: panScrub.text, panCount: panScrub.count };
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
      // forceContactPass (bounce re-verify): the primary transcript may have
      // normalized a misheard address into a shape that no longer trips the
      // dictation signals — the caller knows an email was dictated.
      && (opts.forceContactPass === true || detectContactDictationSignals(result.transcription).any)
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
          // Same audio as the primary — max(), not sum, so one blurted card
          // heard by both passes still counts once for the quarantine trigger.
          result.metadata.pan_count = Math.max(result.metadata.pan_count || 0, second.panCount || 0);
        }
        logger.info(`[call-proc] contact-dictation pass complete: ${second.text.length} chars (${contactModel})`);
      }
    }
  } catch (err) {
    logger.warn(`[call-proc] contact-dictation pass skipped: ${err.message}`);
  }
  // Quarantine at the WRAPPER so every caller is covered — processRecording,
  // the re-transcription backfill, and direct consumers like the bounce
  // reverify's forceContactPass re-listen all flow through here, and the
  // provider-return scrub means the detection only surfaces as
  // metadata.pan_count (Codex #2676 round-4 P1). The quarantine stamps ride
  // result.metadata so the caller's transcript write persists them instead
  // of clobbering the flags with fresh provenance (round-4 P2).
  try {
    const panCount = Number(result?.metadata?.pan_count || 0);
    // Quarantine is EXPLICITLY opt-in (opts.quarantine) — inferring it from
    // opts.call flipped read-only callers into mutators (the extraction
    // replay script) while silently skipping callers that pass no row (the
    // bounce reverify) — Codex #2676 round-5 P1. Mutating pipelines
    // (processRecording, the retranscription backfill, bounce reverify)
    // pass quarantine: true; diagnostic/replay callers stay pure reads.
    if (panCount > 0 && opts.quarantine === true && opts.call?.id) {
      // Persist the MASKED transcript before the audio is stripped
      // (round-18 P2): a crash between this quarantine and the caller's
      // transcript write would otherwise leave pan_detected + no audio +
      // no transcription — unrecoverable (the text existed only in
      // memory) and invisible to the quarantined backstop. The caller's
      // later provenance write overwrites this with the same content.
      if (typeof result?.transcription === 'string' && result.transcription.length) {
        try {
          await db('call_log').where({ id: opts.call.id }).update({
            transcription: result.transcription,
            updated_at: new Date(),
          });
        } catch (preErr) {
          logger.warn(`[call-proc] pre-quarantine transcript persist failed: ${preErr.message}`);
        }
      }
      const q = await quarantineCardRecording(opts.call, { source: 'transcription' });
      if (result.metadata) {
        result.metadata.pan_detected = true;
        result.metadata.recording_quarantined = q.twilioDeleted === true;
      }
      opts.call.recording_url = null;
    }
  } catch (err) {
    logger.error(`[call-proc] PAN quarantine at transcribe wrapper failed: ${err.message}`);
  }
  return result;
}

async function transcribeRecordingPrimary(mp3Url, opts = {}, bufferRef = {}) {
  try {
    logger.info(`[call-proc] Downloading recording for transcription: ${mp3Url}`);
    // Verification (and the retryable not-ready classification) only applies
    // inside the CDN propagation window. An old row's recording is as complete
    // as it will ever get — verifying it would either reject it forever
    // (starving the sweep on dead URLs, Codex #3037 P2) or block a partial
    // recording that is still better transcribed than dropped.
    const callCreatedMs = opts.call?.created_at ? new Date(opts.call.created_at).getTime() : null;
    // Anchor the window at call END (created_at + duration), not call start —
    // the recording only exists once the call ends, so an hour-long call
    // anchored at creation would already be outside the window when the
    // recording-completed webhook fires and would never get verification
    // (Codex #3037 round-2 P2).
    const callEndMs = Number.isFinite(callCreatedMs)
      ? callCreatedMs + recordingDurationSeconds(opts.call || {}) * 1000
      : null;
    const withinPropagationWindow = Number.isFinite(callEndMs)
      && (Date.now() - callEndMs) < NOT_READY_MAX_AGE_MS;
    let audioBuffer;
    try {
      audioBuffer = await downloadRecording(mp3Url, {
        expectedSeconds: withinPropagationWindow
          ? (recordingDurationSeconds(opts.call || {}) || null)
          : null,
      });
    } catch (err) {
      if (err.code === RECORDING_NOT_READY) {
        // CDN propagation lag (404 or truncated buffer for the known
        // duration). Transcribing partial audio would persist a silently
        // incomplete transcript, so surface not-ready and let the caller
        // leave the row claimable for the next sweep instead.
        logger.warn(`[call-proc] Recording not ready yet, deferring: ${err.message}`);
        return { transcription: null, provider: null, notReady: true };
      }
      throw err;
    }
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
            pan_count: openai?.panCount || 0,
          },
        };
      }
      logger.warn('[call-proc] OpenAI transcript missing usable Agent/Caller labels; trying Gemini fallback');
    }

    const gemini = await transcribeWithGemini(audioBuffer, opts);
    if (gemini?.text) {
      return {
        transcription: gemini.text,
        provider: 'gemini_fallback',
        model: GEMINI_TRANSCRIPTION_MODEL,
        structuredSegments: null,
        metadata: {
          audio_bytes: audioBuffer.length,
          fallback_reason: openaiTranscript ? 'openai_labeling_or_completeness' : 'openai_unavailable',
          openai_model: OPENAI_TRANSCRIPTION_MODEL,
          // Same audio — the discarded OpenAI pass and the Gemini pass both
          // detect the same card; max() avoids double-counting it.
          pan_count: Math.max(openai?.panCount || 0, gemini.panCount || 0),
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
            pan_count: openai?.panCount || 0,
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
          pan_count: openai?.panCount || 0,
        },
      };
    }

    return { transcription: null, provider: null };
  } catch (err) {
    logger.error(`[call-proc] Recording transcription download/setup error: ${err.message}`);
    return { transcription: null, provider: null };
  }
}

// ── Recurring-intent default for matched_service ──
//
// Owner rule (2026-07-11, the Detwiler call): a NEW-LEAD caller who voices
// ANY recurring interest — a package, a membership, treatments "every X
// months", quarterly/monthly — wants the recurring pest PROGRAM; the single
// pest that prompted the call (a wasp nest, an ant trail) is the entry
// point, not the service. The extraction prompt carries the same rule; this
// deterministic pass backstops model drift. Scope is deliberately narrow:
// general-pest singular services only (termite/rodent/WDO/lawn lanes have
// their own recurring semantics), the caller's own words only (an agent's
// ignored upsell must not flip the classification), and never when the
// caller explicitly declines a plan.
// Keys are suffix-normalized (trailing " Service" stripped): the model copies
// names from the live catalog, and specialty rows have carried both suffixed
// and unsuffixed forms across catalog renames. Generic one-time pest entries
// only — the German/Native Roach KNOCKDOWN protocols are deliberately absent:
// a heavy-infestation knockdown is the required first visit, not a coarse
// mislabel, and collapsing it into the program would lose the protocol.
const RECURRING_OVERRIDE_SOURCES = new Set([
  'one-time pest control',
  'pest control', // bare "Pest Control Service" — the scheduler's one-time fallback label
  'bee / wasp nest removal',
  'wasp nest removal',
  'wasp control',
  'yellow jacket control',
  'hornet nest removal',
  'mud dauber nest removal',
  'fire ant treatment',
  'general pest control',
  // Both roach forms: the catalog row renamed Cockroach Control Service →
  // Cockroach Treatment (migration 20260730160000), and stored pre-rename
  // extractions still carry the old name.
  'cockroach control',
  'cockroach treatment',
  'initial pest cleanout',
]);
// Strips the "Service" token at the end OR before a parenthetical, so both
// "Quarterly Pest Control Service" and "General Pest Control Service
// (Bi-Monthly)" normalize to comparable keys.
const normalizeServiceKey = (v) => String(v || '').trim().toLowerCase().replace(/\s+service(?=\s*\(|$)/, '');
// The recurring pest programs (suffix-normalized), including the seeded-DB
// alias forms. The prod rows carry the "* Pest Control Service" names,
// active + booking_enabled (verified in prod 2026-07-11). Also used to
// RETARGET a model-picked cadence when the caller unambiguously chose a
// different one.
const RECURRING_PEST_PROGRAMS = new Set([
  'monthly pest control',
  'bi-monthly pest control',
  'quarterly pest control',
  'semiannual pest control',
  'general pest control (monthly)',
  'general pest control (bi-monthly)',
  'general pest control (quarterly)',
  'general pest control (semiannual)',
]);
// Program words that are unambiguous on their own. Bare cadence words —
// including "quarterly"/"semiannual" — are NOT here: they only count with
// the pest-pressure/history guard below ("we get ants every month" and
// "I USED TO HAVE quarterly service" are not plan asks). Bare
// "ongoing"/"year-round" are nowhere: as descriptions ("an ongoing ant
// problem", "year-round bugs") they're pressure, and the genuine asks are
// the service-anchored forms here (plus "keep … year-round").
const RECURRING_INTENT_STRONG_RE = /\b(recurring|re-?occurring|ongoing (?:service|plan|treatments?|maintenance|coverage)|year[- ]?round (?:service|plan|coverage|protection|treatments?)|keep[^.?!;]{0,40}\byear[- ]?round|(?:service|maintenance|pest|treatment) plans?|(?:a|any|your|the|what|which) plans?\b(?!\s+(?:to|this|tonight|today|tomorrow|for|later|already|next|on|that|changed?|fell|got)\b|\s+(?:sun|mon|tues?|wednes|thurs?|fri|satur)day\b)|(?<!\bpayment )(?<!\bfinanc(?:e|ing) )(?<!\binstallment )plans\b(?!\s+(?:to|this|tonight|today|tomorrow|for|later|already|next|on|that|changed?|fell|got)\b|\s+(?:sun|mon|tues?|wednes|thurs?|fri|satur)day\b)|(?<!\bpayment )packages?|memberships?)\b/i;
const RECURRING_CADENCE_RE = /\b(?:bi[- ]?)?monthly\b|\bquarterly\b|\bsemi[- ]?annual(?:ly)?\b|\btwice a year\b|\bevery (?:other )?(?:single )?(?:few |couple (?:of )?)?(?:\d+ |two |three |four |six )?(?:week|month)s?\b/gi;
// "we get/see/have fire ants every month" describes pressure, not a plan
// ask. "have" is pressure ONLY as possession — request idioms ("can I
// have…", "want to have…") are excluded by lookbehind.
const PEST_PRESSURE_BEFORE_RE = /\b(?:get(?:ting)?|got|has|(?<!\b(?:can|could|may) (?:i|we) )(?<!\b(?:do|does|did) (?:you|they) )(?<!\byou guys )(?<!\b(?:want|need|like|love|prefer)(?:ed)? to )have|had|having|been|see(?:ing|n)?|notice(?:d|ing)?|noticing|find(?:ing)?|found|spot(?:ted|ting)?|deal(?:ing)? with|show(?:s|ing)? up|come(?:s|ing)? (?:back|out of|in)|(?:was|were|used to be) (?:on|with|getting|doing)|(?:i'?m|we'?re|am|are|currently|already|still) (?:on|with|using))\b[^.?!]{0,40}$/i;
// ...but a request verb AFTER the pressure verb re-frames the clause as an
// ask: "I HAVE ants and WANT monthly service".
const REQUEST_VERB_RE = /\b(?:want(?:s|ed)?|need(?:s)?|prefer|sign(?:ing)?(?: me| us)? up|set(?:ting)? up|start|get started|schedule|book|interested in|looking for|put (?:me|us) on)\b/i;
// Declines: negated-want forms, bare opt-outs ("no package, only the nest"),
// and "just a one-time" — the latter only when not itself negated ("NOT just
// a one-time" / "I don't want just a one-time" are recurring requests).
// NOTE: "contract"/"subscription" are deliberately NOT opt-out words — "no
// contract" is month-to-month sales language ("can I do quarterly with no
// contract?") and usually accompanies WANTING the plan.
// The negated-want gap is clause-bounded (no ;) and must not cross another
// "want/need" — "I don't want just a one-time; I want a package" pivots to a
// request and is NOT a decline.
const RECURRING_DECLINED_RE = /\b(?:don'?t|do not|doesn'?t|does not|isn'?t|is not|won'?t|not) (?:want|need|interested in|looking for)\b(?:(?!\b(?:want|need)\b)[^.?!;]){0,50}\b(?:recurring|plans?|packages?|memberships?|ongoing|quarterly|(?:bi[- ]?)?monthly|semi[- ]?annual(?:ly)?)|\b(?:no|without|skip(?:ping)?) (?:a |the |any )?(?:(?:service|maintenance|pest|treatment) )?(?:recurring|plans?|packages?|memberships?|quarterly|(?:bi[- ]?)?monthly|semi[- ]?annual(?:ly)?)\b|(?<!\b(?:not|than)\s)(?<!\b(?:don'?t|do not|doesn'?t|won'?t|didn'?t) (?:want|need) )\bjust (?:a |the )?one[- ]?time\b/i;
// A decline whose object is ONLY a cadence ("no monthly", "don't want
// quarterly") excludes that cadence, it does not decline recurring service —
// the negated-cadence filter already keeps it from being chosen. Only a
// decline naming the PROGRAM itself (plan/package/recurring/one-time…)
// carries veto semantics.
const PROGRAM_DECLINE_RE = /\b(?:recurring|plans?|packages?|memberships?|ongoing|one[- ]?time)\b/i;

// A cadence word the caller is EXCLUDING ("but not monthly", "instead of
// monthly") must not count as their chosen cadence.
const NEGATED_CADENCE_BEFORE_RE = /(?:\b(?:not|no|never|without|rather than|instead of|(?:don'?t|do not|doesn'?t|does not|isn'?t|is not|can'?t|cannot|won'?t) (?:want|need|do|offer|provide|carry|interested in)|(?:not|never) (?:interested in|looking for|into)|no longer (?:want|need|on|interested in))\s+(?:the |a |any )?|\b(?:not|no|never|(?:don'?t|do not) want)\s+(?:the |a |any )?(?:(?:bi[- ]?)?monthly|quarterly|semi[- ]?annual(?:ly)?),? (?:or|nor|and) )$/i;
// Billing cadence is not service cadence: "can I PAY MONTHLY for the one-time
// treatment?" is a payment-terms question.
const PAYMENT_CONTEXT_BEFORE_RE = /\b(?:pay(?:ing)?|billed?|billing|charged?|payments?|installments?|invoiced?)\b[^.?!]{0,15}$/i;

// True when `re` (global) matches somewhere that reads as SERVICE cadence:
// not negated, and not preceded by a pest-pressure verb in the same clause —
// unless a request verb after the pressure verb turned the clause into an ask.
function serviceCadenceMatch(re, text) {
  const scan = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let m;
  while ((m = scan.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 60), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 20);
    const billingNounAfter = /^\s{0,2}(?:payments?|installments?|billing|invoices?|price|pricing|cost)\b/i.test(after);
    if (!billingNounAfter && !NEGATED_CADENCE_BEFORE_RE.test(before) && !PAYMENT_CONTEXT_BEFORE_RE.test(before)) {
      const pressure = before.match(PEST_PRESSURE_BEFORE_RE);
      if (!pressure || REQUEST_VERB_RE.test(before.slice(pressure.index))) return true;
    }
    if (scan.lastIndex === m.index) scan.lastIndex++;
  }
  return false;
}

// Transcribers emit curly apostrophes; every guard regex here uses ASCII
// ones — normalize before matching or "don’t want a recurring plan" slips
// past the decline guard.
const normalizeApostrophes = (s) => String(s || '').replace(/[‘’]/g, "'");

// Speaker turns from a labelled transcript: a turn starts at a
// "Speaker:" label (incl. raw diarized "Speaker 1:") and absorbs unlabelled
// continuation lines (a diarized turn can wrap), so continuations inherit
// their speaker.
function speakerTurns(transcription) {
  const lines = String(transcription || '').split('\n');
  const turns = [];
  for (const line of lines) {
    const label = line.match(/^\s*([A-Za-z][A-Za-z0-9 ]{0,20}?)\s*:/);
    if (label) {
      turns.push({ speaker: /^(caller|customer)$/i.test(label[1].trim()) ? 'caller' : 'other', text: line });
    } else if (turns.length) {
      turns[turns.length - 1].text += `\n${line}`;
    }
  }
  return turns;
}

// The caller's own turns when the transcript is caller-labelled. Two
// distinct fallbacks: NO labels at all → whole transcript (fail-open —
// better a rare agent-word trigger than losing the rule); labels present
// but none identifiable as the caller (raw "Speaker 1:"/"Speaker 2:"
// diarization) → EMPTY (fail-closed — scanning the whole text there would
// let an agent's ignored upsell trigger the override).
function callerOnlyText(transcription) {
  const turns = speakerTurns(transcription);
  if (!turns.length) return String(transcription || '');
  const callerTurns = turns.filter((t) => t.speaker === 'caller');
  return callerTurns.map((t) => t.text).join('\n');
}

// True when `re` matches somewhere NOT immediately preceded by negation —
// an agent's "So just the nest, NOT quarterly service?" is a one-time
// confirmation, not a plan offer.
function nonNegatedMatch(re, text) {
  const scan = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let m;
  while ((m = scan.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 60), m.index);
    if (!NEGATED_CADENCE_BEFORE_RE.test(before)) return true;
    if (scan.lastIndex === m.index) scan.lastIndex++;
  }
  return false;
}

// An agent plan offer the caller ACCEPTS is caller intent too ("we can put
// you on quarterly service" → "yes, that works"). Returns the offer turn
// ({ text, index }) or null; `afterIndex` scopes the scan so a counteroffer
// accepted AFTER a decline can be found. The ignored-upsell guard survives:
// an offer with no affirmative reply returns nothing.
// Bare "ok(ay)" is deliberately absent — it's conversational acknowledgment
// ("okay." while the agent pitches), not acceptance. A negation right after
// the affirmation word ("definitely not", "yeah, no") is a REJECTION.
const PLAN_AFFIRMATION_RE = /^\s*(?:caller|customer)\s*:\s*(?:(?:um|uh|well|hmm|so|oh|ok(?:ay)?)[,.\s]+){0,3}(?:yes|yeah|yep|yup|sure|sounds good|that works|that'?s fine|let'?s do (?:that|it)|perfect|please do|sign me up|absolutely|definitely)\b(?!\s*,?\s*(?:not|no|never|don'?t)\b)/i;
function acceptedPlanOffer(turns, afterIndex = -1) {
  for (let i = Math.max(0, afterIndex + 1); i + 1 < turns.length; i++) {
    if (turns[i].speaker !== 'other' || turns[i + 1].speaker !== 'caller') continue;
    const offer = turns[i].text;
    if ((nonNegatedMatch(RECURRING_INTENT_STRONG_RE, offer) || serviceCadenceMatch(RECURRING_CADENCE_RE, offer))
      && PLAN_AFFIRMATION_RE.test(turns[i + 1].text)) {
      return { text: offer, index: i };
    }
  }
  return null;
}

// The program name for a cadence, resolved from the LIVE bookable catalog
// when it's available (booking exact-matches catalog names, and seeded
// environments carry different row names than prod's, e.g. "General Pest
// Control Service (Bi-Monthly)") — hardcoded prod names as fallback.
function resolveProgramName(cadenceKey, fallback, catalogNames) {
  const finders = {
    monthly: (n) => /\bmonthly\b/i.test(n) && !/\bbi[- ]?monthly\b/i.test(n),
    bimonthly: (n) => /\bbi[- ]?monthly\b/i.test(n),
    semiannual: (n) => /semi[- ]?annual/i.test(n),
    quarterly: (n) => /\bquarterly\b/i.test(n),
  };
  const fits = finders[cadenceKey];
  const hit = (Array.isArray(catalogNames) ? catalogNames : [])
    .find((n) => /pest control/i.test(n) && fits(String(n)));
  return hit || fallback;
}

function applyRecurringIntentDefault(extracted, transcription, bookableServiceNames = []) {
  if (!extracted || extracted.is_lead !== true) return extracted;
  // specific_service_name outranks matched_service in catalog booking
  // resolution (call-booking-catalog.js), so a singular value THERE would
  // book the one-time service no matter what matched_service says — both
  // fields get the rule.
  const matchedKey = normalizeServiceKey(extracted.matched_service);
  const specificKey = normalizeServiceKey(extracted.specific_service_name);
  const matchedIsSingular = RECURRING_OVERRIDE_SOURCES.has(matchedKey);
  const specificIsSingular = RECURRING_OVERRIDE_SOURCES.has(specificKey);
  const matchedIsRecurring = RECURRING_PEST_PROGRAMS.has(matchedKey);
  const specificIsRecurring = RECURRING_PEST_PROGRAMS.has(specificKey);
  if (!matchedIsSingular && !specificIsSingular && !matchedIsRecurring && !specificIsRecurring) return extracted;

  const normalized = normalizeApostrophes(transcription);
  const turns = speakerTurns(normalized);
  const callerText = callerOnlyText(normalized);
  // A decline only vetoes when nothing recurring FOLLOWS it — a caller who
  // rejects one option and chooses another ("I don't want the monthly plan;
  // can we do quarterly instead?"), or who accepts the agent's COUNTEROFFER
  // after declining ("I don't want a monthly plan" → Agent: "we can do
  // quarterly" → "yes"), made a recurring request.
  const decline = callerText.match(RECURRING_DECLINED_RE);
  let postDeclineOffer = null;
  if (decline && PROGRAM_DECLINE_RE.test(decline[0])) {
    const afterDecline = callerText.slice(decline.index + decline[0].length);
    const declineTurnIdx = turns.reduce(
      (acc, t, i) => (t.speaker === 'caller' && RECURRING_DECLINED_RE.test(t.text) ? i : acc), -1
    );
    postDeclineOffer = acceptedPlanOffer(turns, declineTurnIdx);
    // Negation-aware: a REPEATED opt-out after the first decline ("I don't
    // want a package either") is not fresh intent.
    if (!nonNegatedMatch(RECURRING_INTENT_STRONG_RE, afterDecline)
      && !serviceCadenceMatch(RECURRING_CADENCE_RE, afterDecline)
      && !postDeclineOffer) return extracted;
  }
  const callerVoiced = nonNegatedMatch(RECURRING_INTENT_STRONG_RE, callerText)
    || serviceCadenceMatch(RECURRING_CADENCE_RE, callerText);
  const acceptedOffer = postDeclineOffer || (callerVoiced ? null : acceptedPlanOffer(turns, -1));
  if (!callerVoiced && !acceptedOffer) return extracted;
  // Cadence: honor the ONE cadence the caller actually chose (from their own
  // words, or from the agent offer they accepted); when they float several
  // ("quarterly or every six months? I don't know") or name none, pest
  // defaults to quarterly — same default as the estimate engine
  // (estimate-converter.js). Family matches carry the same pest-pressure
  // guard as intent detection.
  const cadenceText = acceptedOffer ? acceptedOffer.text : callerText;
  const families = [
    { key: 'monthly', fallback: 'Monthly Pest Control Service', re: /\bmonthly\b|\bevery (?:single )?month\b/gi, veto: /\bbi[- ]?monthly\b|\bevery other month\b/i },
    { key: 'bimonthly', fallback: 'Bi-Monthly Pest Control Service', re: /\bbi[- ]?monthly\b|\bevery other month\b|\bevery (?:two|2) months\b/gi },
    { key: 'semiannual', fallback: 'Semiannual Pest Control Service', re: /\bsemi[- ]?annual(?:ly)?\b|\btwice a year\b|\bevery (?:six|6) months\b/gi },
    { key: 'quarterly', fallback: 'Quarterly Pest Control Service', re: /\bquarterly\b|\bevery (?:three|3) months\b/gi },
  ];
  // Vetoes are negation-aware too: "I want monthly, not bi-monthly" must
  // not let the (negated) bi-monthly mention erase the monthly choice.
  const hits = families.filter((f) => serviceCadenceMatch(f.re, cadenceText)
    && !(f.veto && nonNegatedMatch(f.veto, cadenceText)));
  // The default must never be a cadence the caller explicitly EXCLUDED ("a
  // plan, but no quarterly"): walk the ladder to the first family whose
  // tokens aren't negated in the text (mentioned somewhere but never
  // positively — a positive hit already cleared it).
  const negatedInText = (f) => new RegExp(f.re.source, 'i').test(cadenceText) && !serviceCadenceMatch(f.re, cadenceText);
  const ladder = ['quarterly', 'bimonthly', 'semiannual', 'monthly']
    .map((k) => families.find((f) => f.key === k));
  const chosen = hits.length === 1 ? hits[0] : (ladder.find((f) => !negatedInText(f)) || ladder[0]);
  const programName = (family) => resolveProgramName(family.key, family.fallback, bookableServiceNames);

  const retarget = (isSingular, isRecurring, current) => {
    if (isSingular) return programName(chosen);
    // Already a recurring program: retarget ONLY on one unambiguous caller
    // cadence (the model can default to quarterly over an explicit
    // bi-monthly ask); ambiguity keeps the model's pick.
    if (isRecurring && hits.length === 1) return programName(hits[0]);
    return current;
  };
  const out = { ...extracted };
  out.matched_service = retarget(matchedIsSingular, matchedIsRecurring, extracted.matched_service);
  out.specific_service_name = retarget(specificIsSingular, specificIsRecurring, extracted.specific_service_name);
  // When only specific_service_name carries the program (V2 can map a
  // category to a null legacy matched_service), fill matched_service too —
  // lead enrichment and the V2 backfill read matched_service for
  // service_interest, and the pipeline label must match what books.
  if (!out.matched_service && RECURRING_PEST_PROGRAMS.has(normalizeServiceKey(out.specific_service_name))) {
    out.matched_service = out.specific_service_name;
  }
  if (out.matched_service === extracted.matched_service && out.specific_service_name === extracted.specific_service_name) return extracted;
  logger.info(`[call-proc] recurring-intent default: "${extracted.specific_service_name || extracted.matched_service}" -> "${out.specific_service_name || out.matched_service}"`);
  return out;
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
  // services like "Cockroach Treatment"), backstopped by the legacy
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
  const priorCallBlock = buildPriorCallBlock(opts.priorCall);

  const prompt = `Analyze this phone call transcript for Waves Pest Control (pest control + lawn care, SW Florida). Waves is an established company with many existing customers, so not every call is a new sales lead — some are existing customers coordinating service, complaints, or billing.

Waves only schedules pest control, lawn care, mosquito, termite, rodent, bed bug, WDO, and tree/shrub services. Calls about unrelated work such as website SEO, organic traffic, marketing, advertising, or a construction company are not Waves appointments.

Caller phone: ${callerPhone || 'unknown'}
Call date in Eastern Time: ${callDateET}
${knownCallerBlock}${priorCallBlock}
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
  "secondary_contact": {"first_name": "string or null", "last_name": "string or null", "phone": "string or null", "email": "string or null", "role": "one of: home_buyer, home_seller, tenant, landlord, lender, spouse_partner, family_member, real_estate_agent, property_manager, other, unknown", "wants_notifications": true/false, "is_billing_party": true/false (true ONLY when the caller clearly says THIS person pays — 'the owner pays by credit card', 'bill the management company'; merely being owner/landlord/manager is NOT enough), "notes": "string or null"} or null,
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
  "matched_service": "best match from: ${matchedServiceList}, or null — prefer the MOST SPECIFIC service that fits (e.g. a German/kitchen cockroach infestation cleanout is Cockroach Treatment, not General Pest Control)",
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
- ARRANGER CALLS HAVE A SECONDARY CONTACT BY DEFAULT: a caller who identifies as a realtor/agent, lender or title/closing coordinator, property manager, or landlord is arranging service for someone else — real-estate/WDO-inspection calls almost always name the buyer (and often the seller/occupant providing access). If such a caller named anyone with a name or contact detail and you are about to return null, re-scan the transcript — you likely missed the party.
- RELAYED DETAILS BELONG TO THE OTHER PERSON: a phone/email the caller dictates FOR another person ("the buyer is Joseph — his email is ...", "her phone number is ...") goes on secondary_contact, NEVER into the top-level email/phone, even though the caller is the one speaking it.
- The CALLER's own identity always goes in the top-level first_name/last_name/phone/email fields. secondary_contact is ONLY the other person — never duplicate the caller into it, and never put the other person's phone/email into the caller's fields.
- role describes the secondary person's relationship to the transaction (the BUYER a realtor is booking for is home_buyer, not real_estate_agent; a loan officer named as a party is lender).
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

IMPORTANT — matched_service: recurring interest beats the single presenting pest:
- When the caller voices ANY interest in recurring/ongoing service — a "package", a "plan", a "membership", treatments "every X months/weeks", "quarterly", "monthly", "twice a year", keeping bugs away year-round, or asking what cadence you usually do — matched_service MUST be the recurring pest program, even when the visible complaint is a single pest (a wasp nest, an ant trail, one roach sighting). The single-pest service (Bee / Wasp Nest Removal Service, One-Time Pest Control Service, Fire Ant Treatment Service, …) is correct ONLY when no recurring interest is voiced.
- Cadence: use the one the CALLER chose — "Monthly Pest Control Service", "Bi-Monthly Pest Control Service" (every other month), "Quarterly Pest Control Service", or "Semiannual Pest Control Service" (every six months / twice a year). When they float options without choosing ("quarterly or every six months? I don't know what you usually do") or name no cadence, use "Quarterly Pest Control Service" — pest defaults to quarterly.
- A caller ACCEPTING the agent's plan offer ("we can put you on quarterly service" → "yes, that works") counts as voicing recurring interest.
- This rule reads the CALLER's interest, not the agent's pitch: an agent offering a plan the caller ignores or declines does not trigger it. A caller who explicitly wants one-time only ("just the one treatment, no plan", "no package") keeps the single service.
- Pest-frequency OBSERVATIONS are not plan interest: "we get fire ants every month in that corner" describes pressure, not a request for monthly service — do not classify it as recurring unless the caller also asks about ongoing treatment.
- The specific pest still belongs in requested_service and pain_points — only matched_service defaults to the program.

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

  // One generation attempt: HTTP/timeout failures THROW (the extraction_failed
  // sweep + triage machinery owns those); only the parse verdict is retried.
  const generateOnce = async () => {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EXTRACTION_V1_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        signal: providerTimeoutSignal('extraction'),
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
    return text.replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim();
  };

  // Invalid JSON gets ONE immediate fresh-request retry before falling back
  // to the null-name stub (2026-07-23: a single truncated/malformed response
  // silently no-oped a booked call's entire downstream — the stub is a last
  // resort, not the first response to a bad sample).
  const V1_PARSE_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= V1_PARSE_ATTEMPTS; attempt += 1) {
    const cleaned = await generateOnce();
    try {
      return normalizeCallExtraction(JSON.parse(cleaned), { callerPhone });
    } catch (e) {
      // Fixed message + length ONLY — the raw model output is a call
      // extraction carrying the caller's name/phone/address, and JSON.parse
      // error messages themselves echo a fragment of the rejected input
      // (`Unexpected token 'J', "John Smith"…`), so e.message can't be
      // logged either (AGENTS.md PII-in-logs).
      if (attempt < V1_PARSE_ATTEMPTS) {
        logger.warn(`[call-proc] Invalid JSON from Gemini (${cleaned.length} chars) — retrying (${attempt + 1}/${V1_PARSE_ATTEMPTS})`);
        continue;
      }
      logger.error(`[call-proc] Invalid JSON from Gemini (${cleaned.length} chars) after ${V1_PARSE_ATTEMPTS} attempts`);
      return normalizeCallExtraction({
        first_name: null,
        is_spam: false,
        is_voicemail: false,
        call_summary: EXTRACTION_INVALID_JSON_SUMMARY,
        lead_quality: 'cold',
      }, { callerPhone });
    }
  }
  // Unreachable — the loop always returns — but keeps the function's
  // contract explicit for static analysis.
  throw new Error('extractCallData: attempt loop exited without a verdict');
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
    // Same PII rule as the v1 site above: JSON.parse error messages echo a
    // fragment of the rejected model output — fixed message + length only.
    logger.error(`[call-proc-v2] JSON parse failed (${String(rawText).length} chars)`);
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
  const keyFor = (provider) => {
    if (provider === 'openai') return !!process.env.OPENAI_API_KEY;
    if (provider === 'anthropic') return !!process.env.ANTHROPIC_API_KEY;
    return !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
  };
  if (![CALL_EXTRACTION_ROUTE.primary, CALL_EXTRACTION_ROUTE.fallback].some((r) => keyFor(r.provider))) {
    return { status: 'not_run', extraction: null, errors: null };
  }

  const callDateET = etDateString(opts.callStartedAt || new Date());
  const prompt = buildV2ExtractionPrompt(transcription, callerPhone, callDateET, {
    bookableServiceNames: opts.bookableServiceNames,
    // Existing-customer hint — V1 has had this since the non-lead veto work;
    // without it V2 reads "still on for Tuesday at 10?" as a fresh confirmed
    // booking (the duplicate-appointment path).
    knownCaller: opts.knownCaller,
    // Cross-call threading: prior call from this number, so a continuation
    // completes the earlier record instead of restarting from nothing.
    priorCall: opts.priorCall,
  });

  // Cross-provider dispatch with the model-output schema validated INSIDE
  // the dispatcher — contract-invalid primary output (valid JSON, wrong
  // shape) fails over to the Claude leg instead of failing the call. No
  // explicit timeoutMs: an explicit budget is a shared deadline whose first
  // leg gets the full remainder (a stalled primary would starve the
  // fallback); the dispatcher's default budget splits evenly across legs.
  // temperature: 0 pins greedy decode on the legs that still accept
  // sampling controls (the gemini rollback leg). It is deliberately NOT
  // plumbed to the OpenAI leg — the Responses API 400s ("Unsupported
  // parameter: 'temperature' is not supported with this model") on the
  // GPT-5.6 reasoning line, so the primary's repeat-stability rests on the
  // reasoning model's default decoding; Anthropic strips-and-retries in
  // callAnthropic for the same reason.
  const res = await dispatchWithFallback(CALL_EXTRACTION_ROUTE, {
    text: prompt,
    jsonMode: true,
    maxTokens: 16384,
    temperature: 0,
  }, {
    validate: (result) => (result.json && validateModelOutput(result.json).valid ? null : 'extraction_schema_invalid'),
  });

  if (!res.ok || !res.text) {
    const failures = res.failures || [];
    logger.error(`[call-proc-v2] extraction dispatch failed (${res.reason}): ${JSON.stringify(failures.slice(0, 3))}`);
    // Every-leg-schema-invalid keeps the schema_failed classification the
    // finalize tail would have produced; transport/config failures keep the
    // parse_failed retry path (extraction_attempts + sweeper).
    // Persist the PER-LEG failure list on both paths — downstream health
    // accounting (v2-promotion-readiness) derives failed fallback attempts
    // from these rows, since a both-legs-failed row stamps the primary model.
    const allSchema = failures.length > 0 && failures.every((f) => f.reason === 'extraction_schema_invalid');
    return allSchema
      ? { status: 'schema_failed', extraction: null, errors: failures }
      : { status: 'parse_failed', extraction: null, errors: failures.length ? failures : [{ message: res.reason || 'dispatch_failed' }] };
  }

  // Serialize the object the dispatcher VALIDATED, not the raw text: the
  // dispatcher's loose parser repairs preambles/trailing commas, so a
  // repaired schema-valid response must not re-fail finalize's strict parse.
  return finalizeV2Extraction(JSON.stringify(res.json), {
    callId: opts.callId || null,
    extractionModel: res.model || CALL_EXTRACTION_ROUTE.primary.model,
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
// Retry budget exhausted — surface a blocking Needs Review card. Without it
// the call dies with no route decision, no lead, no customer, and nothing in
// any inbox (exactly how six calls were silently lost to a retired-model 404
// on 2026-07-09). Shared by BOTH failure writers: the AI-extraction catch and
// processRecording's outer guard — every path that stamps extraction_failed
// counts against the same budget and surfaces the same card at the cap. The
// partial unique index dedupes re-files while a card is already open.
async function fileExtractionExhaustedTriage(callLogId, attempts, err, callSid) {
  if (attempts < CALL_EXTRACTION_MAX_ATTEMPTS) return;
  try {
    const failTriageItem = buildTriageItem({
      callLogId,
      flag: 'extraction_failed_permanent',
      extraction: { meta: { call_summary: `Call processing failed ${attempts} time(s); automatic retries exhausted. Fix the cause, then use Reprocess on the call recording.` } },
      extraPayload: { attempts, last_error: String(err?.message || err).slice(0, 500) },
    });
    await db('triage_items').insert(failTriageItem).onConflict(db.raw('(call_log_id, reason_code) WHERE status IN (\'open\', \'in_progress\')')).ignore();
  } catch (triageErr) {
    logger.warn(`[call-proc] extraction-failure triage insert failed for ${maskSid(callSid)}: ${triageErr.message}`);
  }
}


// ── Zero-triage layers (2026-07-10, all dark-gated; failures never fail the call) ──
// Shared by the main completion path AND the spam/voicemail early exits —
// the suspected-spam/voicemail population is exactly what the classifier's
// live accrual must cover. The spam classifier records its verdict; the
// disposition layer stamps the terminal enum on call_log.disposition; the
// enrichment writer persists gate codes / pets / internal color. Order
// matters: the classifier verdict feeds the disposition decision.
async function applyZeroTriageLayers({ call, callSid, contactPhone, extracted, v2Result, appointmentResult = null, customerId = null, transcript = null }) {
  try {
    const v2ForDisposition = v2Result?.status === 'valid' ? v2Result.extraction : null;
    let spamVerdictResult = null;
    if (isEnabled('callSpamClassifier')) {
      const lineTypeRow = await db('phone_line_types')
        .where({ phone: contactPhone }).first().catch(() => null);
      spamVerdictResult = await classifyCall({
        call, extraction: v2ForDisposition, legacy: extracted,
        // Cache stores line TYPE only — omit caller_name entirely so the
        // classifier treats CNAM as unknown (never as known-nameless) and
        // falls back to the AddOns envelope.
        lineType: lineTypeRow ? { type: lineTypeRow.line_type } : null,
        // Raw transcript for the deterministic robocall-script signature —
        // the independent second signal for script families whose rotating
        // local numbers carry no vendor/line risk.
        transcript,
      });
      await recordVerdict(call.id, spamVerdictResult);
    }
    if (isEnabled('callDispositionV1')) {
      const { disposition, reason } = decideDisposition({
        extraction: v2ForDisposition,
        legacy: extracted,
        spamVerdict: spamVerdictResult,
        outcome: {
          appointmentCreated: !!appointmentResult?.scheduledServiceId,
          customerId: customerId || null,
          isKnownCustomer: !!call.customer_id || !!customerId,
        },
      });
      await db('call_log').where({ id: call.id }).update({ disposition, updated_at: new Date() });
      logger.info(`[call-proc] Disposition for ${maskSid(callSid)}: ${disposition} (${reason})`);
    }
    if (customerId) {
      await enrichFromCall({ customerId, extraction: v2ForDisposition, legacy: extracted, callCreatedAt: call.created_at });
    }
  } catch (zeroTriageErr) {
    logger.warn(`[call-proc] zero-triage layer error for ${maskSid(callSid)}: ${zeroTriageErr.message}`);
  }
}

// ══════════════════════════════════════════════════════════════
const CallRecordingProcessor = {
  // Re-used by the bounce audio-reverify lane (email-bounce-reverify.js) —
  // full pipeline incl. the letter-fidelity contact-dictation second pass,
  // plus the same hallucination guard the live pipeline applies.
  transcribeRecording,
  isImplausibleTranscript,
  /**
   * Process a call recording end-to-end.
   * Called from recording-status webhook or manually from admin.
   */
  async processRecording(callSid, opts = {}) {
    const processingStartedAt = new Date();
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
    // This pass's MONOTONIC generation — assigned by the claim write below
    // (processing_generation + 1). The token is the claim MUTEX; the
    // generation is the pass IDENTITY that survives finalization: a cleared
    // token cannot distinguish "my pass finalized normally" from "a newer
    // pass ran since", so every post-finalization ownership fence (the
    // detached estimator's block/quarantine writes) compares generations
    // instead (PR #3304 — replaces the token-NULL predicates).
    let procGeneration = null;
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
        // Retryable-failure guard: the sweep's cap/backoff filter only
        // protects sweep-originated runs — direct callers (the
        // recording-status webhook's setTimeout, duplicate Twilio callbacks)
        // land here too. Without this clause a burst of timers could re-claim
        // a just-failed row back-to-back and burn the whole retry budget in
        // seconds instead of the intended 10-minute spacing, or keep poking a
        // row already at the cap. Enforce both atomically at claim time.
        // Admin Reprocess (force=true) takes the other branch and is exempt.
        .where(function () {
          this.whereRaw("processing_status IS DISTINCT FROM 'extraction_failed'")
            .orWhere(function () {
              this.whereRaw('COALESCE(extraction_attempts, 0) < ?', [CALL_EXTRACTION_MAX_ATTEMPTS])
                .andWhere('updated_at', '<', db.raw("NOW() - INTERVAL '10 minutes'"));
            });
        })
        .update({
          processing_status: 'processing',
          processing_token: procToken,
          processing_generation: db.raw('processing_generation + 1'),
          // DURABLE — finalization must NOT clear this (pre-push audit P1,
          // ambiguity-record r9). It records when the LAST processing pass
          // started, and the bridge-ambiguity phone snapshot bounds its
          // lead capture on it: every pass that can link a lead — the
          // age-unlimited force-reprocess included — claims here first.
          // In-flight state is carried by processing_token/status alone;
          // every reader COALESCEs behind a status guard.
          processing_started_at: new Date(),
          updated_at: new Date(),
        }, ['processing_generation']);
      // PG returns the updated rows ([] = claim lost); count-shaped results
      // (0/1) come from environments without RETURNING — accept both.
      const claimedRows = Array.isArray(claimed) ? claimed : null;
      if (claimedRows ? !claimedRows.length : !claimed) {
        logger.info(`[call-proc] Concurrent run detected for ${callSid} — skipping`);
        return { success: true, skipped: true, reason: 'already_processing' };
      }
      procGeneration = claimedRows?.[0]?.processing_generation != null
        ? Number(claimedRows[0].processing_generation) : null;
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
        .update({
          processing_status: 'processing',
          processing_token: procToken,
          processing_generation: db.raw('processing_generation + 1'),
          // DURABLE — finalization must NOT clear this (pre-push audit P1,
          // ambiguity-record r9). It records when the LAST processing pass
          // started, and the bridge-ambiguity phone snapshot bounds its
          // lead capture on it: every pass that can link a lead — the
          // age-unlimited force-reprocess included — claims here first.
          // In-flight state is carried by processing_token/status alone;
          // every reader COALESCEs behind a status guard.
          processing_started_at: new Date(),
          updated_at: new Date(),
        }, ['processing_generation']);
      // Same both-shapes tolerance as the non-force claim above.
      const claimedRows = Array.isArray(claimed) ? claimed : null;
      if (claimedRows ? !claimedRows.length : !claimed) {
        logger.info(`[call-proc] Force run blocked by in-flight peer for ${callSid} — skipping`);
        return { success: true, skipped: true, reason: 'already_processing' };
      }
      procGeneration = claimedRows?.[0]?.processing_generation != null
        ? Number(claimedRows[0].processing_generation) : null;
    }

    logger.info(`[call-proc] Processing recording for ${callSid}`);

    // Outer guard: any unhandled throw between the claim above and the
    // terminal-status writes below would otherwise wedge the row in
    // processing_status='processing' until the 10-min stale reclaim. Release
    // the lock to a recoverable terminal state so manual retry works
    // immediately and the real error reaches the caller.
    try {
    // `call` was loaded BEFORE the atomic claim above, and a stale worker
    // can commit a lead stamp (fenced on ITS token, still valid then) in
    // that window — Step 4b's priorStampedLeadId would then read the
    // pre-stamp metadata, leave the peer's stamp unreconciled at exit, or
    // overwrite its ledgers with a fresh-mode stamp (pre-push P1 r2). One
    // authoritative re-read now that ownership is ours; from here on no
    // peer can write linkage state (every stamp/clear is token-fenced).
    // Inside the outer guard: a transient failure releases the claim to
    // the retry path instead of wedging the row at 'processing'.
    const claimedRow = await db('call_log').where({ id: call.id }).first('metadata');
    if (claimedRow) call.metadata = claimedRow.metadata;
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
    // A hallucinated PRIMARY transcript (OpenAI/Gemini inventing dialogue over
    // near-silence) is discarded here so the Twilio-builtin fallback below can
    // supply a real transcript; the terminal rejection only fires if the
    // fallback is also missing/implausible.
    let primaryTranscriptRejected = false;
    let rejectedPrimaryChars = 0; // provenance for the discarded primary (audit/tuning)
    // Twilio CDN hasn't finished propagating the MP3 (404 or truncated
    // buffer for the known duration) — release the claim untouched instead
    // of stamping no_transcription, so the next timer/cron attempt retries
    // against complete audio.
    let recordingNotReady = false;

    if (call.recording_url) {
      const result = await transcribeRecording(call.recording_url, { call, contactPhone, quarantine: true });
      transcription = result.transcription;
      recordingNotReady = result.notReady === true;
      contactPassTranscript = result.contactPassTranscript || null;
      // PAN redaction guard (card-on-file spec Phase 0): a card number
      // blurted on the recorded line must become a non-event — scrubbed
      // BEFORE the plausibility gate, BEFORE persistence, and therefore
      // before every LLM consumer (extraction, CSR coach, dictation decode
      // read this variable; everything else re-reads the row written from
      // it). Segments and the contact-pass stream carry the same audio, so
      // all three artifacts are scrubbed together.
      const scrubbed = scrubTranscriptArtifacts({
        transcription,
        contactPassTranscript,
        segments: result.structuredSegments,
      });
      transcription = scrubbed.transcription;
      contactPassTranscript = scrubbed.contactPassTranscript;
      result.structuredSegments = scrubbed.segments;
      // Provider-detected PANs are already quarantined inside
      // transcribeRecording (which also nulled call.recording_url — same
      // object). This branch covers CHOKE-NOVEL detections only: text some
      // future/side path delivered unscrubbed. The flags ride
      // result.metadata so the transcript write below persists them.
      if (scrubbed.count > 0) {
        logger.warn(`[call-proc] PAN scrub masked ${scrubbed.count} card number(s) at the choke point for ${maskSid(callSid)}`);
        await quarantineCardRecording(call, { source: 'primary_transcription' });
        call.recording_url = null;
        if (result?.metadata) {
          result.metadata.pan_detected = true;
          result.metadata.pan_count = Number(result.metadata.pan_count || 0) + scrubbed.count;
        }
      }
      // recordingSeconds is hoisted so the primary gate here and the terminal
      // rejection below share one value.
      const recordingSecondsForGate = Number(call.recording_duration_seconds) || Number(call.duration_seconds) || null;
      if (transcription && isImplausibleTranscript(transcription, recordingSecondsForGate)) {
        logger.warn(`[call-proc] Primary transcript implausible for ${maskSid(callSid)}: ${transcription.length} chars / ${recordingSecondsForGate}s — discarding, trying Twilio fallback`);
        primaryTranscriptRejected = true;
        rejectedPrimaryChars = transcription.length; // keep the metric before discarding
        transcription = null;
        contactPassTranscript = null;
      }
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
          transcription_metadata: JSON.stringify(await withPanStamps(call.id, transcriptionProvenance.metadata)),
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

    // Recording not ready (CDN propagation): release the claim with the row
    // restored to its PRE-CLAIM status — no no_transcription stamp, no
    // attempt counters — so the 10-minute fallback timer / 5-minute cron
    // retries against complete audio. Restoring (not nulling) matters for a
    // force-reprocess of an already-processed row: nulling would resurrect it
    // as pending and bypass the processed-row dedup guard, repeating
    // downstream side effects (Codex #3037 P1). `call.processing_status` was
    // read before the claim; 'processing' (stale-reclaim takeover) maps to
    // NULL since restoring a phantom in-flight marker would block the row for
    // another stale window. Skips the Twilio-builtin fallback on purpose:
    // real audio a few minutes from now beats Twilio's rough transcript.
    if (!transcription && recordingNotReady) {
      const preClaimStatus = call.processing_status === 'processing' ? null : (call.processing_status || null);
      await db('call_log').where({ id: call.id }).where('processing_token', procToken).update({
        processing_status: preClaimStatus,
        processing_token: null,
        updated_at: new Date(),
      });
      logger.info(`[call-proc] Deferred ${maskSid(callSid)} — recording not fully propagated yet (status restored to ${preClaimStatus || 'pending'})`);
      return { success: false, skipped: true, reason: 'recording_not_ready' };
    }

    // Fallback: use Twilio's built-in transcription if OpenAI/Gemini failed or no recording URL.
    // The rejection sentinel is NOT a usable transcript — on an admin
    // force-reprocess of an already-rejected call it's what's stored in
    // call_log.transcription, so treat it (and cached copies of it) as no fallback.
    const isUsableFallback = (t) => t && t !== TRANSCRIPTION_REJECTED_SENTINEL;
    if (!transcription) {
      const freshCall = await db('call_log').where('twilio_call_sid', callSid).select('transcription', 'transcript_structured').first();
      if (isUsableFallback(freshCall?.transcription)) {
        // Rows written before the PAN guard deployed (or by an unscrubbed
        // legacy path) re-enter the live pipeline here — scrub on read so
        // the LLM consumers downstream never see a stored PAN, and heal the
        // sibling transcript_structured artifact in the same touch (its
        // segments/contact-pass may carry the same pre-guard PAN).
        const fallbackScrub = scrubPansDetailed(freshCall.transcription);
        const structuredScrub = scrubStructuredTranscript(freshCall.transcript_structured);
        transcription = fallbackScrub.text;
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
          // Persist the scrubbed text, not just the local copy — a legacy
          // PAN-bearing row would otherwise stay exposed to every
          // persisted-row consumer (Codex #2676 round-1 P1). Detection is
          // stamped in this SAME update (round-12 P1): a crash before the
          // quarantine below must not leave a masked transcript with no
          // durable signal that the audio still needs deleting.
          transcription,
          ...(structuredScrub.count > 0 ? { transcript_structured: structuredScrub.json } : {}),
          transcription_provider: transcriptionProvenance.provider,
          transcription_model: null,
          transcription_metadata: JSON.stringify(await withPanStamps(call.id, {
            ...transcriptionProvenance.metadata,
            ...(fallbackScrub.count + structuredScrub.count > 0
              ? { pan_detected: true, pan_count: fallbackScrub.count + structuredScrub.count, quarantine_source: 'fallback_heal_pending' }
              : {}),
          })),
          updated_at: new Date(),
        });
        if (fallbackScrub.count + structuredScrub.count > 0) {
          await quarantineCardRecording(call, { source: 'fallback_heal' });
          call.recording_url = null;
        }
        logger.info(`[call-proc] OpenAI/Gemini unavailable - falling back to Twilio transcription: ${transcription.length} chars`);
      } else if (isUsableFallback(call.transcription)) {
        const cachedScrub = scrubPansDetailed(call.transcription);
        const cachedStructuredScrub = scrubStructuredTranscript(call.transcript_structured);
        transcription = cachedScrub.text;
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
          transcription, // scrubbed — see the fresh-row twin above
          ...(cachedStructuredScrub.count > 0 ? { transcript_structured: cachedStructuredScrub.json } : {}),
          transcription_provider: transcriptionProvenance.provider,
          transcription_model: null,
          transcription_metadata: JSON.stringify(await withPanStamps(call.id, {
            ...transcriptionProvenance.metadata,
            ...(cachedScrub.count + cachedStructuredScrub.count > 0
              ? { pan_detected: true, pan_count: cachedScrub.count + cachedStructuredScrub.count, quarantine_source: 'fallback_heal_pending' }
              : {}),
          })),
          updated_at: new Date(),
        });
        if (cachedScrub.count + cachedStructuredScrub.count > 0) {
          await quarantineCardRecording(call, { source: 'fallback_heal' });
          call.recording_url = null;
        }
        logger.info(`[call-proc] OpenAI/Gemini unavailable - using cached Twilio transcription: ${transcription.length} chars`);
      }
    }
    // ── Transcription-hallucination guard ── run BEFORE the transcript is
    // written to the message thread or handed to extraction, so a fabricated
    // conversation never becomes a phantom lead / disposition / SMS. Recording
    // duration (actual audio) preferred; call duration (incl. ring) is a safe
    // looser fallback. Terminal 'voicemail' so the retry sweep won't re-run it
    // (a re-transcribe would just hallucinate again).
    const recordingSeconds = Number(call.recording_duration_seconds) || Number(call.duration_seconds) || null;
    const fallbackImplausible = transcription && isImplausibleTranscript(transcription, recordingSeconds);
    // Two terminal-rejection cases: (a) the Twilio fallback ALSO produced an
    // implausible transcript; (b) the primary was implausible and no usable
    // fallback exists. Both finalize as an empty voicemail — NOT no_transcription
    // (which would retry and re-hallucinate). A plausible Twilio fallback after a
    // rejected primary flows through normally.
    if (fallbackImplausible || (!transcription && primaryTranscriptRejected)) {
      // Provenance: for the primary-hallucinated path `transcription` was already
      // nulled, so use the char count captured before discarding it.
      const rawChars = transcription ? transcription.length : rejectedPrimaryChars;
      const cps = recordingSeconds && rawChars
        ? Math.round((fallbackImplausible ? spokenCharCount(transcription) : rawChars) / recordingSeconds)
        : null;
      logger.warn(`[call-proc] Rejecting implausible transcription for ${maskSid(callSid)}: ${fallbackImplausible ? `fallback ${rawChars} chars / ${recordingSeconds}s (~${cps} c/s)` : 'primary hallucinated, no usable fallback'} — empty voicemail, no extraction`);
      let priorMeta = {};
      try {
        const rawPrior = call.transcription_metadata;
        priorMeta = typeof rawPrior === 'string' ? JSON.parse(rawPrior) : (rawPrior && typeof rawPrior === 'object' ? rawPrior : {});
      } catch { priorMeta = {}; }
      // A prior attempt may have STAMPED a reused (different-sid) lead as
      // this call's linkage — unlink it and restore that lead's prior
      // summary, atomically and fenced, BEFORE the rejection update (codex
      // P1 r16 / audit P1 r19: without this, the stamp consumers kept
      // presenting the rejected call — and its hallucinated summary — as
      // lead evidence). Fence-lost bails exactly like the rejection write's
      // own 0-row path below.
      // The settle's attribution retirement and the rejection write commit
      // as ONE fenced transaction (pre-push P0 r12): committed separately,
      // a fence reclaim between them left the call retryable while its
      // booked/completed funnel history was already deleted — irreversible
      // data loss, since a retry recreates only a stage='lead' row. A
      // 0-row terminal write throws inside the transaction so the retire
      // and stamp clear roll back with it.
      const rejectionMeta = JSON.stringify(await withPanStamps(call.id, { ...priorMeta, transcription_rejected: true, reject_reason: fallbackImplausible ? 'implausible_length' : 'primary_hallucinated_no_fallback', raw_chars: rawChars, recording_seconds: recordingSeconds, chars_per_second: cps }));
      const rejectionStampSettled = await db.transaction(async (trx) => {
        const settled = await clearStampAndRestoreLead(call, procToken, callSid, trx, { mode: 'retire' });
        if (!settled) return false;
        const rejected = await trx('call_log')
          .where({ id: call.id })
          .where('processing_token', procToken)
          .update({
            processing_status: 'voicemail',
            answered_by: 'voicemail',
            call_outcome: 'voicemail',
            transcription: TRANSCRIPTION_REJECTED_SENTINEL,
            transcription_metadata: rejectionMeta,
            ai_extraction: null,
            ai_extraction_enriched: null,
            v2_extraction_status: null,
            disposition: null,
            review_status: null,
            customer_id: null,
            processing_token: null,
            updated_at: new Date(),
          });
        if (rejected === 0) {
          const lost = new Error('rejection fence lost');
          lost.fenceLost = true;
          throw lost;
        }
        return true;
      }).catch((e) => { if (e.fenceLost) return false; throw e; });
      if (!rejectionStampSettled) {
        logger.warn(`[call-proc] Skipped implausible-transcript rejection for ${callSid} — ownership lost (peer reclaimed via stale-lock window).`);
        return { success: true, skipped: true, reason: 'transcription_rejected_ownership_lost' };
      }
      // Dismiss any open Needs Review cards a prior hallucinated extraction
      // filed for this call — clearing review_status alone doesn't remove them
      // (the inbox lists from triage_items.status), so they'd stay actionable.
      try {
        // Shared per-call lock contract (utils/triage-locks.js) with the
        // nightly sweep / admin-triage / email-fanout writers — an unordered
        // bulk card update outside the protocol can deadlock against their
        // sibling pre-locks, and an aborted statement here would leave stale
        // open cards under an already-cleared review_status.
        const dismissed = await db.transaction(async (trx) => {
          await lockTriageCall(trx, call.id);
          return trx('triage_items')
            .where({ call_log_id: call.id })
            .whereIn('status', ['open', 'in_progress'])
            .update({ status: 'dismissed', resolution_note: 'Transcript rejected as an implausible hallucination.', resolved_at: new Date(), updated_at: new Date() });
        });
        if (dismissed > 0) logger.info(`[call-proc] Dismissed ${dismissed} stale triage card(s) for ${maskSid(callSid)} after transcript rejection`);
      } catch (trErr) {
        logger.warn(`[call-proc] stale-triage dismissal skipped for ${maskSid(callSid)}: ${trErr.message}`);
      }
      // Retire phantom lead artifacts a PRIOR hallucinated extraction created
      // (admin force-reprocess path): soft-delete unconverted leads keyed by
      // this call SID so the phantom lead the guard neutralizes doesn't linger.
      // Scoped tight — only leads sourced from THIS call, never won/converted.
      try {
        const retired = await db('leads')
          .where({ twilio_call_sid: callSid })
          .whereNull('deleted_at')
          .whereNotIn('status', ['won', 'converted'])
          .update({ deleted_at: new Date(), lost_reason: 'transcription_rejected_hallucination', updated_at: new Date() });
        if (retired > 0) logger.info(`[call-proc] Retired ${retired} phantom call-sourced lead(s) for ${maskSid(callSid)} after transcript rejection`);
      } catch (leadErr) {
        logger.warn(`[call-proc] phantom-lead retire skipped for ${maskSid(callSid)}: ${leadErr.message}`);
      }
      await updateUnifiedVoiceMessage(
        { ...call, transcription: TRANSCRIPTION_REJECTED_SENTINEL, answered_by: 'voicemail' },
        { body: TRANSCRIPTION_REJECTED_SENTINEL, answered_by: 'voicemail' }
      ).catch((e) => logger.warn(`[call-proc] unified message update skipped for ${maskSid(callSid)}: ${e.message}`));
      return { success: true, skipped: true, reason: 'transcription_rejected_implausible' };
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
    // Cross-call threading context: the latest other call from this number in
    // the last week, so a continuation call completes the earlier record
    // instead of restarting from nothing. Fail-open — extraction proceeds
    // without it.
    const priorCall = await summarizePriorCall(contactPhone, call.id, db, call.created_at);

    // Bookable service catalog: fed to both extraction prompts (so the model
    // can name a specific bookable service) and to the booking block below
    // (service_id / price / duration / follow-up interval). Fails open to [].
    const bookableCallServices = await loadBookableCallServices(db);
    // Covered re-service rows, loaded separately: NOT part of the prompt
    // catalog block (they are booking_enabled=false by design — the reservice
    // self-serve lane owns eligibility), only reachable through the
    // deterministic existing-customer revisit override in the resolver.
    const callReServiceRows = await loadCallReServiceRows(db);
    const bookableServiceNames = bookableCallServices.map((s) => s.name).filter(Boolean);
    // Catalog-aware provenance: the catalog block is part of the rendered
    // V2 prompt, so every stamp for this call must carry its hash.
    const v2PromptVersion = extractionPromptVersion(bookableServiceNames);

    let extracted;
    try {
      extracted = await extractCallData(transcription, contactPhone, { callStartedAt: call.created_at, knownCaller, bookableServiceNames, priorCall });
    } catch (err) {
      logger.error(`[call-proc] AI extraction failed: ${err.message}`);
      // Increment in SQL, not from the in-memory row: the stale-reclaim path
      // means `call` can predate another run's failed attempt.
      const [failedRow] = await db('call_log').where({ id: call.id }).update({
        processing_status: 'extraction_failed',
        extraction_attempts: db.raw('COALESCE(extraction_attempts, 0) + 1'),
        processing_token: null,
        updated_at: new Date(),
      }).returning(['extraction_attempts']);
      const attempts = Number(failedRow?.extraction_attempts) || 0;
      await fileExtractionExhaustedTriage(call.id, attempts, err, callSid);
      return { success: false, error: `AI extraction failed: ${err.message}` };
    }

    // Owner rule: recurring interest beats the single presenting pest — a
    // deterministic backstop on top of the same instruction in the prompt.
    // INBOUND ONLY (all three call sites): diarization label assignment is
    // inconsistent on outbound calls — observed live 2026-07-11, the Copeman
    // outbound call labeled the WAVES AGENT as "Caller:" — so the caller-text
    // scan could read the agent's own plan pitch as customer intent. The
    // prompt-driven model, which sees the whole conversation, still applies
    // the rule on outbound calls.
    if (!isOutboundCall(call)) extracted = applyRecurringIntentDefault(extracted, transcription, bookableServiceNames);

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
          priorCall,
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
          // Provenance = the model that actually produced the output (the
          // fallback leg stamps its own model), not the configured primary.
          ai_extraction_model: v2Result.extraction?.meta?.extraction_model || CALL_EXTRACTION_ROUTE.primary.model,
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
          ai_extraction_model: CALL_EXTRACTION_ROUTE.primary.model,
          ai_extraction_prompt_version: v2PromptVersion,
          updated_at: new Date(),
        });
      }
    }

    // Non-new-lead natures must not mint a CUSTOMER: the create branch only
    // checks name/phone/voicemail/spam, and V2-primary adoption can supply a
    // valid name + phone from a job applicant OR a billing/existing-customer
    // call whose number matches nobody on file (codex r3 + r5 P2). For the
    // existing-customer natures the classification itself asserts the caller
    // already has a record — minting a duplicate contradicts it; the call
    // stays customer-less and the enforce gate's triage cards carry the
    // review. Only creation is held: a matched existing customer proceeds
    // through the update path untouched.
    // Gated on the SAME switch as adoption (codex r4 P2): with V2-primary
    // killed or routing demoted, the pipeline reverts to pure legacy behavior
    // — a V2 false-positive must not suppress a valid V1 customer create.
    const V2_NON_CUSTOMER_CALL_NATURES = new Set([
      'job_applicant',
      'billing_question',
      'existing_customer_service',
      'existing_customer_scheduling',
      // 'other' is an explicitly non-new-lead classification — indeterminate
      // non-sales calls must not mint customer records either (codex r6 P2).
      // A NULL call_nature stays out of the hold: the schema reserves null
      // for truly indeterminate calls, where legacy creation behavior stands.
      'other',
    ]);
    const v2NonCustomerCallNature = callExtractionV2PrimaryEnabled()
      && v2Result?.status === 'valid'
      && V2_NON_CUSTOMER_CALL_NATURES.has(v2Result.extraction?.call_nature);

    // ── V2-primary field adoption (owner promotion 2026-07-23) ──
    // A valid V2 extraction now DRIVES the canonical writes: its identity /
    // address / scheduling fields merge into the legacy-shaped `extracted`
    // BEFORE voicemail routing, the spam skip, the dictation/AV lanes, and
    // the customer/lead upserts read it. Until now V2 only gated routing —
    // when the V1 leg parse-failed to the null-name stub, a booked call
    // produced no customer, no lead, no appointment, and no SMS even though
    // ai_extraction_enriched held the complete picture. Adoption changes
    // WHAT the pipeline knows, never what it may DO: auto-booking still
    // requires the enforce gate's approval and SMS still requires consent.
    // The merged object stays legacy-flat, so canonical ai_extraction keeps
    // the reader-compatible shape.
    if (callExtractionV2PrimaryEnabled() && v2Result?.status === 'valid' && isV2Extraction(v2Result.extraction)) {
      const adoption = adoptV2PrimaryFields(extracted, v2Result.extraction, {
        etWallClock: v2IsoToEtWallClock,
        callerPhone: contactPhone,
      });
      extracted = adoption.merged;
      if (adoption.adoptedFields.length) {
        // Field NAMES only — values are caller PII (AGENTS.md PII-in-logs).
        logger.info(`[call-proc] V2-primary adopted ${adoption.adoptedFields.length} field(s) for ${maskSid(callSid)}: ${adoption.adoptedFields.join(', ')}`);
        // The owner recurring-intent backstop ran on the PRE-adoption V1
        // fields (a stub call had nothing to upgrade). Re-assert it over the
        // adopted service labels BEFORE any lead write consumes them, exactly
        // like the enforce path's approved-booking re-assert (codex P2).
        if (!isOutboundCall(call)) extracted = applyRecurringIntentDefault(extracted, transcription, bookableServiceNames);
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
      // A blocked-caller-ID voicemail (vmPhone null) rides the same
      // email-backed branch as a live anonymous call: hasWorkableLeadSignal
      // demands a VALID spoken email when there is no phone, so "call me
      // back" voicemails with no reachback still terminal-skip. The
      // quote-link text-back downstream fails closed in the service
      // (missing_input) — a phone-less voicemail lead is email-reachback
      // only (codex P1, PR #3275).
      if (hasWorkableLeadSignal({ extracted, phone: vmPhone, voicemail: true })) {
        const vmCustomer = call.customer_id
          ? { id: call.customer_id }
          : (vmPhone ? await findCustomerForCallContact(vmPhone, extracted).catch(() => null) : null);
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
      // The recurring-intent default keyed off is_lead and ran before this
      // promotion — a "wasp nest, and I'd like the quarterly package"
      // voicemail was still is_lead=false then. Re-run it now that the
      // deterministic signals made this a lead (idempotent, no-op otherwise).
      if (!isOutboundCall(call)) extracted = applyRecurringIntentDefault(extracted, transcription, bookableServiceNames);
    }

    // Skip spam and non-workable voicemail
    if (extracted.is_spam || (voicemailChannel && !voicemailLeadPath)) {
      // A retry newly classified spam/non-workable must first unlink any
      // earlier attempt's lead stamp AND restore that lead's prior summary
      // — atomically, fenced (codex P1 r15 / audit P1 r17/r19). A transient
      // failure here throws to the outer extraction_failed guard rather
      // than finalizing with the rejected linkage in place.
      const terminalUpdate = {
        ai_extraction: JSON.stringify(extracted),
        processing_status: extracted.is_spam ? 'spam' : 'voicemail',
        processing_token: null,
        updated_at: new Date(),
      };
      if (extracted.is_voicemail) {
        terminalUpdate.answered_by = 'voicemail';
        terminalUpdate.call_outcome = 'voicemail';
      }
      // Fenced like the finalization write, and BEFORE the shadow/triage
      // side effects (pre-push P1 r2): the settle above is not an
      // ownership guarantee — it returns true with nothing to clear, and
      // the claim can be reclaimed between its commit and this write. A
      // stale worker must not null a peer's token, overwrite its terminal
      // status, or run this path's downstream effects.
      // A draft this call already produced must be INVALIDATED before the
      // terminal verdict is recorded (codex P1/P0, PR #3304 GH r8/r8c): a
      // forced retry can reclassify a quote call as spam or a non-workable
      // voicemail, and clearing the metadata stamp does not help — a
      // sid-linked lead still resolves for send and accept. Running it
      // BEFORE the terminal write is what makes it durable: a failure
      // THROWS into the extraction_failed path, so the retry sweep runs
      // the whole verdict again rather than leaving a live public token on
      // a rejected call's draft. The invalidation is idempotent (it skips
      // an already-marked row), so a retry is free.
      {
        const { invalidateDraftForCall } = require('./estimator-engine');
        const invalidation = await invalidateDraftForCall(call.id, {
          reason: extracted.is_spam ? 'call_rejected_spam' : 'call_rejected_voicemail',
          // Fenced on THIS pass's claim: a worker that lost its token must
          // not invalidate a draft the replacement worker owns. The
          // generation arm keeps the fence valid after our own
          // finalization without re-opening the stale-worker hole.
          ownershipFence: { callLogId: call.id, procToken, procGeneration },
        });
        if (!invalidation.ok) {
          // Queue the durable retry BEFORE failing the pass: the throw
          // routes to extraction_failed (retried while the budget lasts),
          // and the queue covers the case where that budget is already
          // spent (codex P0, PR #3304 GH r8d).
          const { markQuarantinePending } = require('./estimator-engine');
          await markQuarantinePending(call.id, extracted.is_spam ? 'call_rejected_spam' : 'call_rejected_voicemail', { procGeneration });
          throw new Error(`draft invalidation failed on the ${extracted.is_spam ? 'spam' : 'voicemail'} verdict: ${invalidation.error || 'unknown'}`);
        }
      }
      // Merge note (#3303 × #3304): the invalidation above stays OUTSIDE
      // this transaction on purpose — its durability contract is that a
      // failure throws to extraction_failed with a quarantine queue
      // behind it, and a rollback here would undo that.
      // The settle's attribution retirement and the fenced terminal write
      // commit as ONE transaction, BEFORE the shadow/triage side effects
      // (pre-push P1 r2, P0 r12): committed separately, a fence reclaim
      // between them left the call retryable while its funnel history was
      // already deleted. A 0-row terminal write throws inside the
      // transaction so the retire and stamp clear roll back with it.
      const terminalSettled = await db.transaction(async (trx) => {
        const settled = await clearStampAndRestoreLead(call, procToken, callSid, trx, { mode: 'retire' });
        if (!settled) return false;
        const terminalWrote = await trx('call_log')
          .where({ id: call.id })
          .where('processing_token', procToken)
          .update(terminalUpdate);
        if (!terminalWrote) {
          const lost = new Error('terminal fence lost');
          lost.fenceLost = true;
          throw lost;
        }
        return true;
      }).catch((e) => { if (e.fenceLost) return false; throw e; });
      if (!terminalSettled) {
        logger.warn(`[call-proc] Skipped spam/voicemail terminal write for ${maskSid(callSid)} — ownership lost (peer reclaimed).`);
        return { success: true, skipped: true, reason: 'terminal_write_ownership_lost' };
      }
      // SECOND invalidation pass, after the terminal status committed
      // (codex P1, PR #3304 GH r8g): the pre-write pass stamps the durable
      // call-side block first, so a composer that had already locked the
      // call could still have inserted between that stamp and the scan.
      // This sweeps whatever landed. Best-effort — the block marker keeps
      // any straggler unsendable, and the scheduler queue retries.
      try {
        const { invalidateDraftForCall: invalidateAgain } = require('./estimator-engine');
        await invalidateAgain(call.id, {
          reason: extracted.is_spam ? 'call_rejected_spam' : 'call_rejected_voicemail',
          // Generation-fenced like the first invalidation (pre-push P1,
          // PR #3304): the terminal write cleared this pass's token, so a
          // newer force-reprocess can claim the call and start composing
          // a valid replacement — an unfenced sweep would stamp the old
          // rejection and archive that replacement. Same generation =
          // still ours; a newer claim wins.
          ownershipFence: { callLogId: call.id, procToken, procGeneration },
        });
      } catch (sweepErr) {
        logger.warn(`[call-proc] post-terminal draft sweep failed (non-blocking): ${sweepErr.message}`);
      }
      await writeLegacyShadowRouteDecision({
        call,
        extracted,
        customerId: call.customer_id || null,
        finalStatus: extracted.is_spam ? 'spam' : 'voicemail',
      });
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
      // The suspected-spam/voicemail population must still get classifier
      // verdicts + terminal dispositions — it's the population the live
      // accrual exists to measure. Customer resolution hasn't run on this
      // path; enrichment keys on the webhook's pre-linked customer if any.
      await applyZeroTriageLayers({ call, callSid, contactPhone, extracted, v2Result, customerId: call.customer_id || null, transcript: transcription });

      // Service-request voicemail that the workable-lead gate declined
      // (existing customer, or non-lead call_type veto): surface a callback
      // bell instead of ending silent. Bell only — never customer comms.
      // Best-effort: an alert failure must never break call processing.
      if (isEnabled('voicemailCallbackAlert')) {
        try {
          const vmAlertPhone = resolveCallContactPhone(call, extracted.phone);
          // Customer lookup moved ahead of the plan: known-customer identity
          // is now an alert basis of its own (owner ruling 2026-07-30), not
          // just payload enrichment. Pre-linked calls fetch the full row —
          // the banner needs the customer's NAME when the caller doesn't say
          // theirs (the typical known-customer "call me back" voicemail).
          const vmAlertCustomer = call.customer_id
            ? (await db('customers').where({ id: call.customer_id }).first().catch(() => null)) || { id: call.customer_id }
            : await findCustomerForCallContact(vmAlertPhone, extracted).catch(() => null);
          const alertPlan = voicemailCallbackAlertPlan({
            extracted,
            voicemailChannel,
            voicemailLeadPath,
            vmPhone: vmAlertPhone,
            outbound: isOutboundCall(call),
            knownCustomer: Boolean(vmAlertCustomer?.id),
            transcript: transcription,
          });
          if (alertPlan) {
            // One alert per call even across reprocessing (retranscription
            // backfill re-runs terminal voicemails through this path). The
            // claim is a single atomic UPDATE on the call row — deliberately
            // NOT a notifications-row check, because bell rows are
            // preference-gated and pushes are delivered independently, so a
            // delivery-dependent dedupe re-alerts whenever the bell row is
            // missing. Claim-then-deliver: a delivery failure after the
            // claim stays best-effort (triggerNotification never throws).
            const claimed = await db('call_log')
              .where({ id: call.id })
              .whereNull('voicemail_callback_alerted_at')
              .update({ voicemail_callback_alerted_at: new Date() });
            if (claimed) {
              const { triggerNotification } = require('./notification-triggers');
              // Extraction name first (the caller's own words), matched
              // customer's account name as fallback.
              const vmCustomerName = [vmAlertCustomer?.first_name, vmAlertCustomer?.last_name]
                .filter(Boolean).join(' ') || null;
              await triggerNotification('customer_voicemail_callback', {
                ...alertPlan,
                name: alertPlan.name || vmCustomerName,
                customerId: vmAlertCustomer?.id || null,
                callLogId: call.id,
              });
            }
          }
        } catch (alertErr) {
          logger.warn(`[call-proc] voicemail callback alert failed for ${callSid}: ${alertErr.message}`);
        }
      }

      // Reconcile-only draft-linkage pass on the TERMINAL path too (codex
      // P1, PR #3304 GH r8): a forced retry can reclassify a call that
      // already produced an estimator draft as spam or a non-workable
      // voicemail, and this return sits far upstream of the normal hook —
      // the old draft would keep its former lead linkage and a live public
      // token. Clearing the metadata stamp is not enough for a SID-linked
      // lead: the send validator still resolves it by sid, so the draft
      // must be INVALIDATED. Runs after the token-fenced terminal write
      // (the pass no longer owns processing_token) and never blocks.
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
    let v2SmsConsentExplicit = false;
    // True ONLY when the enforce-mode TCPA gate cleared the SMS via IMPLIED
    // inbound consent (no explicit sms_consent_given). The non-ANI recipient
    // hold at the send site keys off this — a send cleared by explicit consent
    // or by the legacy (V2-off) path must not be held.
    let v2SmsClearedByImpliedConsent = false;
    let v2EmailBlocked = false;
    let v2CanonicalWriteBlocked = false;
    // Does the veto include a DEFINITIVE content rejection? Only
    // spam_or_wrong_number proves prior attribution fraudulent —
    // out_of_service_area and do_not_contact_requested are policy holds,
    // and force-reprocessing a previously booked call under one must not
    // delete its accumulated revenue (pre-push P0 r15).
    let v2VetoDefinitiveRejection = false;
    let v2ApprovedExtraction = null;
    // Address/identity bridge (populated below in shadow mode): "confirm before
    // dispatch" reasons that flag the call for a human without blocking writes.
    const bridgeNeedsConfirmation = [];
    // In-run email-review signal: set the moment either bridge branch decides
    // the extracted email needs read-back, BEFORE any card insert — so a
    // failed triage insert cannot release the first-touch email hold below.
    let emailReviewHeldThisRun = false;

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

        // ── Quarantine arbiter (dark: CONTACT_QUARANTINE_ARBITER_ENABLED) ──
        // A quarantined email no longer just sits null awaiting review: a
        // second agent rules on the candidates using evidence the transcripts
        // can't provide (DNS deliverability per domain, cross-customer
        // ownership, business-name coherence). adopt/adopt_with_confirmation
        // fills extracted.email before the customer/lead upserts and
        // first-touch sends read it; a decisive adopt also releases the
        // forced read-back flag below. The module re-checks every hard gate
        // deterministically (candidate membership, deliverable domain,
        // ownership) before returning an adoptable verdict — and fails open
        // to the existing quarantine on any error.
        if (dictationEmailPayload?.email_candidates?.length && !extracted.email) {
          const ownCustomerId = call.customer_id
            || (await findCustomerForCallContact(contactPhone, extracted).catch(() => null))?.id
            || null;
          const arbiter = await arbitrateQuarantinedEmail({
            entry: contactDictation.emails?.[0] || null,
            demotedEmail: extracted.email_raw || null,
            transcripts: { primary: transcription, contactPass: contactPassTranscript },
            callerContext: {
              first_name: extracted.first_name || null,
              last_name: extracted.last_name || null,
              organization: v2Result?.extraction?.caller?.organization_name || null,
              call_summary: extracted.call_summary || null,
              // Independent second opinion: the schema-valid V2 extraction's
              // caller email. Only a VALIDATED payload counts as evidence —
              // and it's exactly the tiebreaker the arbiter lacked when it
              // stored charlesw.robb@ over V2's (correct) charleswrobb@.
              v2_email: (v2Result?.status === 'valid' && v2Result?.extraction?.caller?.email) || null,
            },
            ownCustomerId,
          });
          if (arbiter) {
            dictationEmailPayload.arbiter = {
              verdict: arbiter.verdict,
              chosen_value: arbiter.chosenValue,
              confidence: arbiter.confidence,
              reasoning: arbiter.reasoning,
              eliminated: arbiter.eliminated,
              domain_evidence: arbiter.domainEvidence,
              ...(arbiter.confirmationQuestion ? { confirmation_question: arbiter.confirmationQuestion } : {}),
            };
            // The Needs Review card renders only the TOP-LEVEL
            // confirmation_question (TriageInboxTabV2) — lift the arbiter's
            // question there for any verdict that keeps the card open, or a
            // decoder-questionless quarantine would open a card with no
            // read-back prompt.
            if (arbiter.verdict !== 'adopt' && arbiter.confirmationQuestion) {
              dictationEmailPayload.confirmation_question = arbiter.confirmationQuestion;
            }
            // adopt_with_confirmation ALSO writes — owner ruling (2026-07-09):
            // a quarantined profile never ships email-less when a candidate
            // passes every hard gate; the promised first-touch email goes out
            // and the read-back card stays open for the human confirm. The
            // gates (candidate membership, deliverable domain, cross-customer
            // ownership) are enforced deterministically inside the module.
            if (arbiter.chosenValue && (arbiter.verdict === 'adopt' || arbiter.verdict === 'adopt_with_confirmation')) {
              extracted.email = arbiter.chosenValue;
              logger.info(`[quarantine-arbiter] ${arbiter.verdict} email for ${maskSid(callSid)} (confidence ${arbiter.confidence})`);
            } else {
              logger.info(`[quarantine-arbiter] review verdict for ${maskSid(callSid)} — quarantine stands`);
            }
          }
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
        // "Building resolved, unit missing" is not a garbled street — the
        // recovery module refuses it outright (codex r10 P1), so the
        // ambiguous hold stands and missing_unit_number names the ask
        // instead of an accepted wrong-parcel verdict auto-routing a
        // unit-less condo booking.
        avMissingUnitOnly: isMissingUnitNumber(v2AddressValidation),
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
    // Which extraction pass recovered (codex final-round P2). The offline
    // audits reconstruct the routing verdict from the address_recovered card
    // — the processor deliberately persists the ORIGINAL unresolvable verdict
    // — so the card must say WHICH pass it speaks for. Without the stamp, a
    // card left over from an earlier pass vouches for a later reprocess where
    // recovery FAILED, turning an unverified address into a counted
    // auto-route and skewing the promotion gate permissive. Stamped with the
    // same provenance the row itself carries (call_log.ai_extraction_model /
    // ai_extraction_prompt_version), so the audits can match exactly.
    const recoveryPassStamp = {
      extraction_model: v2Result?.extraction?.meta?.extraction_model || CALL_EXTRACTION_ROUTE.primary.model,
      extraction_prompt_version: v2PromptVersion,
    };
    // Model + prompt identifies an extractor COHORT, not an individual pass
    // (codex round-18 P2): reprocess the same call on the same extractor with
    // recovery failing this time and the pass-1 card — kept alive by the
    // open-row onConflict-ignore — would still stamp-match the rewritten row
    // and forge a 'corrected' verdict for all three audits. So the marker is
    // reconciled with THIS pass before either filing site runs: a pass that
    // recovered (re)stamps it, a pass that did NOT strips the stamp and
    // records when it was superseded. An unstamped card reconstructs nothing,
    // so the forged verdict is gone in the same write.
    //
    // The card itself is left OPEN either way. The office's read-back task is
    // about the street now on the customer record, which the earlier pass DID
    // persist — invalidating the audit marker must not silently delete a real
    // piece of work. Best-effort: a failed reconcile leaves a stamp the
    // audits may over-trust, which is why the pass stamp is belt-and-braces
    // rather than the only check.
    await db('triage_items')
      .where({ call_log_id: call.id, reason_code: 'address_recovered' })
      .update({
        payload: addressRecovery?.recovered
          ? db.raw('coalesce(payload, \'{}\'::jsonb) || ?::jsonb', [JSON.stringify(recoveryPassStamp)])
          : db.raw('(coalesce(payload, \'{}\'::jsonb) - \'extraction_model\' - \'extraction_prompt_version\') || ?::jsonb',
            [JSON.stringify({ recovery_superseded_at: new Date().toISOString() })]),
        updated_at: new Date(),
      })
      .catch((e) => logger.warn(`[call-proc] recovery-marker reconcile failed for ${maskSid(callSid)}: ${e.code || e.name || 'db_error'}`));

    // Explicit SMS consent is a property of the CALL, not of the routing mode:
    // the secondary-contact fan-out at the send site requires it even when V2
    // runs in shadow (or routing is legacy), where the enforce branch below
    // never executes. Only a VALID extraction counts — a schema_failed/
    // normalization_failed payload is untrusted model output and must not
    // authorize texting anyone. With no valid V2 extraction there is no
    // consent evidence and it stays false (fan-out fail-closed as before).
    v2SmsConsentExplicit = v2Result?.status === 'valid'
      && isV2Extraction(v2Result?.extraction)
      && v2Result.extraction?.consent?.sms_consent_given === true;

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
          // Fail-open booking (GATE_CALL_FAIL_OPEN_BOOKING): a confirmed booking
          // isn't held over recoverable contact-field flags — the ANI satisfies
          // caller_phone_missing, an existing customer's on-file address clears
          // address flags, a garbled email (name_email_mismatch) is advisory.
          const failOpenBooking = isEnabled('callFailOpenBooking') && !isOutboundCall(call);
          const knownCustomerForFailOpen = (knownCaller && knownCaller.isExistingCustomer)
            ? { hasAddress: knownCaller.hasAddress } : null;
          let routingResult = canAutoRoute(v2Extraction, {
            contactPhone, addressValidation,
            failOpen: failOpenBooking, callerAni: contactPhone, knownCustomer: knownCustomerForFailOpen,
            agentCommitFailOpen: isEnabled('callAgentCommitBooking') && !isOutboundCall(call),
            // Grounds the agent-commitment evidence quote against the labeled
            // source transcript — evidence objects are untrusted model output.
            transcript: transcription,
            // Speaker labels are LLM-inferred today — the demotion stays dark
            // until this companion gate flips (see feature-gates.js).
            transcriptLabelsTrusted: isEnabled('callAgentCommitTrustedLabels'),
            // Slot binding needs the call time: a spoken weekday only names a
            // unique date within the 7 days after the call.
            callStartedAt: call.created_at,
          });
          // Address fail-open is only safe when the on-file address really is
          // the booking address — V1-captured address evidence that conflicts
          // with it demotes to the address-review hold BEFORE the route
          // decision is recorded (see demoteFailOpenOnV1AddressConflict; the
          // audit path applies the same rule so shadow metrics agree). No
          // address values in the log — PII; the review card carries them.
          {
            const demoted = demoteFailOpenOnV1AddressConflict(routingResult, extracted, knownCaller);
            if (demoted !== routingResult) {
              logger.info(`[call-proc-v2] Fail-open demoted to review for ${maskSid(callSid)}: V1-only address evidence conflicts with the on-file address`);
              routingResult = demoted;
            }
          }
          if (routingResult.allowed && routingResult.failedOpenFlags?.length) {
            logger.info(`[call-proc] Fail-open booking for ${maskSid(callSid)}: proceeding despite recoverable flags ${routingResult.failedOpenFlags.join(', ')} (office to confirm)`);
          }
          // `extracted` is post-adoptV2PrimaryFields here — the MERGED
          // canonical record. It must be consulted for the unit ask: the
          // adoption retains a V1 unit V2 dropped, so the AV verdict can
          // report a missing subpremise the record already has.
          const deterministicFlags = computeDeterministicTriageFlags(v2Extraction, { contactPhone, addressValidation, canonicalRecord: extracted });
          // Strip model address flags too when AV accepted/corrected — otherwise
          // a stale model out_of_service_area would hard-veto a verified address.
          const modelFlags = suppressAddressFlagsForAV(v2Extraction.triage_flags, addressValidation);
          const finalFlags = mergeTriageFlags(modelFlags, deterministicFlags);
          // Implied consent (GATE_CALL_INBOUND_IMPLIED_CONSENT): an inbound
          // caller who booked has implied consent for the transactional
          // confirmation SMS (established business relationship; they called
          // us) — but implied consent is PERSONAL to the caller. It authorizes
          // texting only the number that reached us (the inbound ANI); it does
          // NOT authorize texting a spoken alternate callback number (which the
          // customer.phone||extracted.phone||ANI resolution can prefer over the
          // ANI) nor fanning a confirmation out to a secondary service contact.
          // Those alternate recipients still require explicit sms_consent_given
          // (v2SmsConsentExplicit, captured mode-independently above) and are
          // enforced at the send site.
          const tcpa = checkTcpaConsent(v2Extraction, {
            impliedConsent: isEnabled('callInboundImpliedConsent') && !isOutboundCall(call),
          });
          v2SmsBlocked = !tcpa.canSms;
          v2SmsClearedByImpliedConsent = tcpa.canSms && tcpa.reason === 'implied_consent_inbound';
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
              .insert(buildTriageItem({ callLogId: call.id, flag, extraction: v2Extraction, severity: 'advisory', addressValidation }))
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
                  // V1-flat key — recoverStreetAddress remaps its winner out
                  // of the AV-normalized shape before returning.
                  address_recovered: addressRecovery.recovered.address_line1,
                  address_candidates: addressRecovery.candidates || [],
                  recovery_method: addressRecovery.method || null,
                  ...recoveryPassStamp,
                  ...(contactDictation?.addresses?.[0]?.confirmation_question
                    ? { confirmation_question: contactDictation.addresses[0].confirmation_question } : {}),
                },
              }))
              .onConflict(db.raw('(call_log_id, reason_code) WHERE status IN (\'open\', \'in_progress\')'))
              .ignore();
            bridgeNeedsConfirmation.push('address_recovered');
          }

          // When AV accepted or corrected the address, adopt Google's
          // normalized form (street/city/state/zip + county) into the
          // extraction BEFORE the routing branch — BOTH paths persist
          // extracted.* downstream (approved: dispatch + customer/lead upsert;
          // blocked: the lead/customer writes that still run for triaged
          // calls). Adopting only on approval left blocked calls saving the
          // raw transcript spelling even though AV had already resolved the
          // rooftop address (live 2026-07-27: a phantom city and a split
          // street name reached lead rows). The gate and flag computation
          // above already consumed the AV verdict, so adopting here changes
          // what gets SAVED, not what routes.
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
              // The reverse geocoder returns long names ("Manatee County") but
              // the persisted schema's county enum allows only the four short
              // names — writing the raw value would leave ai_extraction_enriched
              // schema-invalid while v2_extraction_status still says valid
              // (codex round-2 P2). Unmappable → omit, keep whatever was there.
              ...(AV_COUNTY_ENUM[normalizeCounty(addressValidation.county)]
                ? { county: AV_COUNTY_ENUM[normalizeCounty(addressValidation.county)] } : {}),
            };
            if (n.street_line_1) extracted.address_line1 = n.street_line_1;
            if (n.city) extracted.city = n.city;
            if (n.state) extracted.state = n.state;
            if (n.postal_code) extracted.zip = n.postal_code;
            // The canonical V2 blob was serialized to ai_extraction_enriched
            // BEFORE this normalization (right after extraction) — re-persist
            // it so enriched-blob consumers (the estimator context-builder
            // prefers it over ai_extraction) see the normalized address too,
            // not the raw model spelling (codex P2). Best-effort: a failed
            // rewrite leaves the pre-adoption blob, which is the old behavior.
            await db('call_log').where({ id: call.id })
              .update({ ai_extraction_enriched: JSON.stringify(v2Extraction) })
              .catch((e) => logger.warn(`[call-proc-v2] enriched-blob re-persist after AV adoption failed: ${e.code || e.name || 'db_error'}`));
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
              const triageItem = buildTriageItem({ callLogId: call.id, flag, extraction: v2Extraction, addressValidation });
              await db('triage_items').insert(triageItem).onConflict(db.raw('(call_log_id, reason_code) WHERE status IN (\'open\', \'in_progress\')')).ignore();
            }
            // Demoted flags survive a block by ANOTHER gate (codex round-4
            // P2): an agent-committed call held on e.g. address_unverified
            // must still surface the "confirm the account holder" advisory —
            // the demotion removed caller_not_authorized from the blocking
            // set, so without this loop it would appear on no card at all.
            // Mirrors the allowed branch's fail-open advisory loop; onConflict
            // dedups against any same-reason row.
            for (const f of (routingResult.failedOpenFlags || []).slice(0, 10)) {
              try {
                await db('triage_items')
                  .insert(buildTriageItem({ callLogId: call.id, flag: f, extraction: v2Extraction, severity: 'advisory', addressValidation }))
                  .onConflict(db.raw('(call_log_id, reason_code) WHERE status IN (\'open\', \'in_progress\')')).ignore();
              } catch (fe) {
                logger.warn(`[call-proc-v2] blocked-branch fail-open advisory insert failed for ${maskSid(callSid)} (${f}): ${fe.message}`);
              }
            }
            v2RoutingBlocked = true;
            v2CanonicalWriteBlocked = hasCanonicalWriteBlock(finalFlags);
            v2VetoDefinitiveRejection = (finalFlags || []).includes('spam_or_wrong_number');
            logger.info(`[call-proc-v2] Routing blocked for ${callSid}: ${triageReasons.join(', ')}${v2CanonicalWriteBlocked ? ' (canonical-write veto)' : ''}`);
          } else {
            // Approved — dispatch proceeds on the AV-normalized address
            // adopted above (both branches adopt it now).
            // Fail-open recovery: this appointment was allowed only because
            // recoverable flags were dropped from the blocking set. Surface
            // them as ADVISORY review items so the office confirms the field
            // (phone via ANI, garbled email, on-file address, low confidence) —
            // book-and-flag, never book-and-hide (owner directive).
            if (routingResult.failedOpenFlags?.length) {
              for (const f of routingResult.failedOpenFlags) {
                try {
                  await db('triage_items')
                    .insert(buildTriageItem({ callLogId: call.id, flag: f, extraction: v2Extraction, severity: 'advisory', addressValidation }))
                    .onConflict(db.raw('(call_log_id, reason_code) WHERE status IN (\'open\', \'in_progress\')')).ignore();
                } catch (fe) {
                  logger.warn(`[call-proc-v2] fail-open advisory insert failed for ${maskSid(callSid)} (${f}): ${fe.message}`);
                }
              }
              // Address flags failed open ⇒ V2 heard NO new address and this
              // booking must dispatch to the customer's on-file address. Any
              // legacy V1 street that survives to this point key-matches the
              // on-file street (a differing V1-only street was demoted to
              // review above), so it's an unvalidated duplicate at best —
              // left alone it would win over the on-file address at the
              // property-linkage stamp. Clear it so
              // resolveCallBookingPropertyLinkage falls back to the on-file,
              // Google-verified address. No street values in the log — PII.
              if (routingResult.failedOpenFlags.some((f) => FAIL_OPEN_KNOWN_CUSTOMER_ADDRESS_FLAGS.has(f))) {
                if (String(extracted.address_line1 || '').trim()) {
                  logger.info(`[call-proc] Fail-open on-file address for ${maskSid(callSid)}: dropped an unvalidated legacy V1 street (key-matches the on-file address)`);
                }
                extracted.address_line1 = null;
                extracted.address_line2 = null;
                extracted.city = null;
                extracted.state = null;
                extracted.zip = null;
              }
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
    // V2 can capture an as-heard malformed email ("brandon@gmail") that the
    // V1 extractor returned null for; normalizeCaller demotes it to the V2
    // caller.email_raw. The email review below (repair + ownership gate +
    // read-back triage, in BOTH the shadow-bridge and enforce branches) only
    // reads the legacy extracted.email/email_raw — carry the V2 capture into
    // that channel so the only captured address isn't silently lost.
    try {
      const v2CallerRawEmail = v2Result?.extraction?.caller?.email_raw || null;
      if (v2CallerRawEmail && !extracted.email && !extracted.email_raw) {
        extracted.email_raw = v2CallerRawEmail;
      }
    } catch (_e) { /* best-effort — V1's own capture still flows */ }

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
        // A decisive arbiter adopt resolved the dictation — the read-back
        // card would only re-ask a settled question. The bridge's
        // deriveEmailReview gives EVERY call-captured email a read-back
        // reason unconditionally, so the settled reasons must be REMOVED,
        // not just not-re-added. adopt_with_confirmation and review verdicts
        // keep the flag (card stays open). EXCEPTION: when the bridge's
        // domain-typo corrector proposes a DIFFERENT value than the arbiter
        // adopted (normalizedEmail below overwrites extracted.email), the
        // question is NOT settled — the reasons stay so the card survives
        // the conflicting correction.
        if (dictationEmailPayload?.arbiter?.verdict === 'adopt'
            && (!normalizedEmail || normalizedEmail === dictationEmailPayload.arbiter.chosen_value)) {
          for (const settled of ['email_unverified', 'email_invalid']) {
            const at = needsConfirmation.indexOf(settled);
            if (at !== -1) needsConfirmation.splice(at, 1);
          }
        } else if (dictationEmailPayload
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
        if (needsConfirmation.includes('email_unverified') || needsConfirmation.includes('email_invalid')) {
          emailReviewHeldThisRun = true;
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
              // Name the building the ask is about ON the card. "Ask which
              // unit" is useless without saying which address, and
              // call_log.ai_extraction* is a rolling latest-pass snapshot a
              // reprocess overwrites — so the address is captured here, at
              // filing time. Shadow mode: the legacy V1 record is the source
              // of truth for the address, and the bridge only files this ask
              // when AV's building corroborates it.
              if (flag === 'missing_unit_number') {
                await db('triage_items')
                  .insert(buildTriageItem({
                    callLogId: call.id,
                    flag,
                    extraction: v2Result?.extraction || { meta: { call_summary: extracted.call_summary || null } },
                    severity: 'advisory',
                    // Google's resolved building when it has one (a corrected
                    // street/ZIP rides on this verdict shape), else what the
                    // legacy record holds.
                    addressValidation: v2AddressValidation,
                    extraPayload: v2AddressValidation?.normalized?.street_line_1 ? null : {
                      unit_ask_building: {
                        street_line_1: rawStreetBeforeAdopt || extracted.address_line1 || null,
                        city: extracted.city || null,
                        postal_code: extracted.zip || null,
                      },
                    },
                  }))
                  .onConflict(db.raw('(call_log_id, reason_code) WHERE status IN (\'open\', \'in_progress\')'))
                  .ignore();
                continue;
              }
              const isEmailFlag = flag === 'email_unverified' || flag === 'email_invalid';
              // Email cards are minted in the FENCED transaction below
              // (Codex #3084 r54) — their insert must be atomic with the
              // release-claim invalidation, or an in-flight release can
              // send between the card commit and the repen.
              if (isEmailFlag) continue;
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
                    // Same pass stamp the enforce site writes — this is the
                    // site that files the card in SHADOW mode, which is
                    // exactly the cohort the promotion gate audits.
                    ...(flag === 'address_recovered' ? recoveryPassStamp : {}),
                    ...(contactDictation?.addresses?.[0]?.confirmation_question
                      ? { confirmation_question: contactDictation.addresses[0].confirmation_question } : {}),
                  } : null,
                }))
                .onConflict(db.raw('(call_log_id, reason_code) WHERE status IN (\'open\', \'in_progress\')'))
                .ignore();
            } catch (triageErr) {
              logger.warn(`[call-proc-bridge] triage_items insert failed for ${maskSid(callSid)}: ${triageErr.message}`);
            }
          }
          // Card mint + claim invalidation ride ONE token-fenced
          // transaction (Codex #3084 r54 — see mintEmailReviewCardsFenced;
          // r43's invalidation and r44's durable-state error semantics
          // both preserved, now atomic with the card writes).
          await mintEmailReviewCardsFenced({
            callLogId: call.id,
            procToken,
            callSid,
            cards: needsConfirmation.slice(0, 10)
              .filter((flag) => flag === 'email_unverified' || flag === 'email_invalid')
              .map((flag) => buildTriageItem({
                callLogId: call.id,
                flag,
                extraction: v2Result?.extraction || { meta: { call_summary: extracted.call_summary || null } },
                severity: 'advisory',
                extraPayload: dictationEmailPayload,
              })),
          });
        }
      } catch (bridgeErr) {
        // The bridge is advisory EXCEPT for the r44 invalidation: with the
        // card durably inserted and the hold claims NOT invalidated, an
        // in-flight release can send the unreviewed address — that state
        // must fail the run, not be skipped.
        if (bridgeErr.emailReviewStateUnavailable) throw bridgeErr;
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
        // Same arbiter release as the shadow branch: a decisive adopt closed
        // the question, and deriveEmailReview adds a read-back reason for
        // every call-captured email unconditionally — remove the settled
        // ones. Anything less than a decisive adopt keeps the card, and so
        // does a domain-typo correction that would CHANGE the adopted value
        // (the correction write below must never land unreviewed).
        if (dictationEmailPayload?.arbiter?.verdict === 'adopt'
            && (!correctedEmail || correctedEmail === dictationEmailPayload.arbiter.chosen_value)) {
          for (const settled of ['email_unverified', 'email_invalid']) {
            const at = emailReasons.indexOf(settled);
            if (at !== -1) emailReasons.splice(at, 1);
          }
        } else if (dictationEmailPayload
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
        if (emailReasons.includes('email_unverified') || emailReasons.includes('email_invalid')) {
          emailReviewHeldThisRun = true;
        }
        if (emailReasons.length) {
          bridgeNeedsConfirmation.push(...emailReasons);
          // Same Needs Review surfacing as the shadow branch: the inbox is
          // driven by triage_items rows, so without these an auto-routed call
          // in enforce/V2-off mode would never show the read-back prompt.
          // Same fenced mint as the shadow branch (Codex #3084 r54): the
          // card writes and the r43 claim invalidation ride one
          // token-fenced transaction; r44's durable-state error still
          // throws into the extraction_failed retry. Decoder evidence
          // (candidates + the exact read-back question) rides each card.
          await mintEmailReviewCardsFenced({
            callLogId: call.id,
            procToken,
            callSid,
            invalidateClaims: emailReasons.includes('email_unverified') || emailReasons.includes('email_invalid'),
            cards: emailReasons.slice(0, 10).map((flag) => buildTriageItem({
              callLogId: call.id,
              flag,
              extraction: v2Result?.extraction || { meta: { call_summary: extracted.call_summary || null } },
              severity: 'advisory',
              extraPayload: dictationEmailPayload,
            })),
          });
        }
      } catch (emailErr) {
        // Advisory EXCEPT the r44 invalidation — see the shadow branch.
        if (emailErr.emailReviewStateUnavailable) throw emailErr;
        logger.warn(`[call-proc] email review skipped for ${maskSid(callSid)}: ${emailErr.message}`);
      }
    }

    // Hard veto → record extraction for audit, skip all canonical writes
    // (no customer, no lead, no appointment, no automation). Mirrors the
    // spam/voicemail early-return below.
    if (v2CanonicalWriteBlocked) {
      // Hard-veto exit precedes Step 4b's stamp reconciliation — unlink the
      // earlier attempt's lead stamp and restore that lead's prior summary,
      // atomically and fenced (codex P1 r15 / audit P1 r17/r19); a
      // transient failure throws to the outer extraction_failed guard.
      // The settle's attribution retirement and the fenced terminal write
      // commit as ONE transaction (pre-push P1 r2, P0 r12): committed
      // separately, a fence reclaim between them left the call retryable
      // while its funnel history was already deleted. A 0-row terminal
      // write throws inside the transaction so the retire and stamp clear
      // roll back with it.
      const vetoSettled = await db.transaction(async (trx) => {
        // Only a DEFINITIVE rejection settles the stamp at all (codex P1,
        // PR #3303 r3): a policy hold (out_of_service_area /
        // do_not_contact_requested) invalidates neither the call→lead
        // linkage nor its attribution — 'keep' preserved the funnel row
        // but the clear still removed the stamp, and the bridge then read
        // the missing linkage as a settled unlink and retired the row
        // anyway. Policy holds preserve stamp, lead state, and row.
        if (v2VetoDefinitiveRejection) {
          const settled = await clearStampAndRestoreLead(call, procToken, callSid, trx, { mode: 'retire' });
          if (!settled) return false;
        }
        const vetoWrote = await trx('call_log')
          .where({ id: call.id })
          .where('processing_token', procToken)
          .update({
            ai_extraction: JSON.stringify(extracted),
            call_summary: extracted.call_summary || null,
            sentiment: extracted.sentiment || null,
            lead_quality: extracted.lead_quality || null,
            processing_status: extracted.is_spam ? 'spam' : 'processed',
            review_status: 'open',
            processing_token: null,
            // A definitive rejection that finalizes 'processed' (wrong
            // number with is_spam false) needs the durable marker or the
            // bridge re-attributes it next scan (pre-push P1 r16). A
            // NON-definitive policy hold CLEARS a stale marker instead
            // (codex P1, PR #3303 r4): a force-reprocess that corrected a
            // prior definitive rejection into out_of_service_area/DNC
            // must not leave the call terminally rejected forever.
            metadata: v2VetoDefinitiveRejection
              ? db.raw("jsonb_set(COALESCE(metadata, '{}'::jsonb), '{no_attribution}', 'true'::jsonb, true)")
              : db.raw("COALESCE(metadata, '{}'::jsonb) - 'no_attribution'"),
            updated_at: new Date(),
          });
        if (!vetoWrote) {
          const lost = new Error('veto fence lost');
          lost.fenceLost = true;
          throw lost;
        }
        return true;
      }).catch((e) => { if (e.fenceLost) return false; throw e; });
      if (!vetoSettled) {
        logger.warn(`[call-proc] Skipped V2 hard-veto terminal write for ${maskSid(callSid)} — ownership lost (peer reclaimed).`);
        return { success: true, skipped: true, reason: 'terminal_write_ownership_lost' };
      }
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
    const callSecondaryContacts = resolveCallSecondaryContacts(extracted, v2CanonicalExtraction);
    const callSecondaryContact = callSecondaryContacts[0] || null;
    // Capture the caller's email BEFORE the secondary-contact scrub below clears
    // it — payer linking (resolveCallBillingPayer) uses it to reject a billing
    // party that is really the caller duplicated into a slot (self-pay "I'll
    // pay"). After the scrub extracted.email can be null, defeating that guard.
    const callerEmailPreScrub = extracted.email || null;

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
    if (process.env.GATE_CALL_SECONDARY_CONTACT === 'true' && callSecondaryContacts.length) {
      const scrubLast10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);
      const aniLast10 = scrubLast10(call.from_phone);
      for (const secondary of callSecondaryContacts) {
        if (extracted.email && secondary.email
            && String(extracted.email).toLowerCase() === String(secondary.email).toLowerCase()) {
          extracted.email = null;
          logger.info(`[call-proc] Scrubbed secondary contact's email off the caller fields for ${maskSid(callSid)}`);
        }
        if (extracted.phone && secondary.phone
            && scrubLast10(extracted.phone) === scrubLast10(secondary.phone)
            && aniLast10 && scrubLast10(extracted.phone) !== aniLast10) {
          extracted.phone = null;
          logger.info(`[call-proc] Scrubbed secondary contact's phone off the caller fields for ${maskSid(callSid)}`);
        }
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

    const sharedPhoneAmbiguity = {};
    if (!customerId && phone) {
      // Try to find an existing customer by the external contact phone.
      // Name match wins; phone-only matching needs a second deterministic
      // signal (single owner / AV-address / household) — see the cascade.
      const existing = await findCustomerForCallContact(phone, extracted, {
        multiMatchOut: sharedPhoneAmbiguity,
        callAddress: {
          address_line1: extracted.address_line1,
          address_line2: extracted.address_line2 || null,
          city: extracted.city,
          zip: extracted.zip,
        },
        // Keyed on the same effective (recovery-aware) verdict the routing
        // gate consumes: when street recovery found a single validated
        // premise, extracted already carries the recovered address, so the
        // address-disambiguation leg must see it as decisive too — otherwise
        // an agent-role slot caller about the recovered property minted a
        // duplicate customer (codex round-10 P2).
        avDecisive: ['validated_accept', 'corrected'].includes(effectiveAddressValidation?.status),
      });
      if (existing) {
        customerId = existing.id;
        // Update with any new info
        const updates = {};
        // Same garbled-stored-email rule as the appointment backfill
        // (codex round-12 P2): invalid stored value is replaceable by a
        // VALID capture; a valid stored email is never overwritten.
        const existingEmailInvalid = existing.email && !EMAIL_RE.test(String(existing.email).trim().toLowerCase());
        const capturedEmailValid = extracted.email && EMAIL_RE.test(String(extracted.email).trim().toLowerCase());
        if ((!existing.email || existingEmailInvalid) && capturedEmailValid) updates.email = extracted.email;
        if ((!existing.address_line1 || existing.address_line1 === '') && extracted.address_line1) {
          updates.address_line1 = extracted.address_line1;
          if (extracted.city) updates.city = extracted.city;
          if (extracted.zip) updates.zip = extracted.zip;
        }
        if (Object.keys(updates).length > 0) {
          // Same contract as the appointment backfill above: a REPLACEMENT of
          // a garbled stored email must fan out (copies of the old address
          // exist) and does so in ONE transaction with the customer write, so
          // a partial fan-out cannot strand snapshots on an address the
          // record no longer holds (codex round-24 P1); an empty→value write
          // only settles the missing-email card; neither settles the
          // read-back cards filed for this unverified capture (round-9 +
          // round-10 P2; fan-out gap from the local pre-push audit P1). Both
          // paths ride the email-claim guard (r16): every writer that
          // ASSIGNS an email serializes with a concurrent merge-undo's
          // claim probe via the shared normalized-email advisory lock —
          // proceed-with-fresh-read, so only the email column is ever
          // dropped and the address backfill still lands.
          const fanout = require('./customer-email-fanout');
          const replacingGarbled = !!(updates.email && existingEmailInvalid);
          const guarded = await fanout.applyCustomerUpdatesWithEmailClaimGuard({
            customerId, updates,
            source: 'call-extraction-backfill',
            ...(replacingGarbled ? {
              replaceExpectedEmail: existing.email,
              applyWithEmailInTrx: async (trx) => {
                await trx('customers').where({ id: customerId }).update(updates);
                await fanout.propagateCustomerEmailChange({
                  before: existing,
                  after: { id: customerId, email: updates.email },
                  source: 'call-captured email replacing a garbled address (phone-match update)',
                  reviewReasonCodes: ['customer_email_missing'],
                }, trx);
              },
            } : {}),
          });
          if (updates.email && guarded.emailApplied && !replacingGarbled) {
            try {
              await fanout.resolveOpenEmailReviewCards({
                customerId, email: updates.email,
                source: 'call-captured email (phone-match update)',
                reasonCodes: ['customer_email_missing'],
              });
            } catch (e) {
              logger.warn(`[call-proc] email review-card resolution failed after phone-match update for customer ${customerId}: ${e.message}`);
            }
          }
        }
      } else if (sharedPhoneAmbiguity.candidates) {
        // Shared phone, no deterministic tiebreak: minting ANOTHER customer
        // on this number would make it permanently multi-match (the duplicate
        // flywheel, audit #7). Keep the call customer-less — the workable-lead
        // path below still captures the prospect — and open a blocking review
        // card so the office attaches it to the right record (or a new one).
        logger.warn(`[call-proc] Suppressing customer create for ${maskSid(callSid)}: shared phone matches ${sharedPhoneAmbiguity.shareCount} customers`);
        await db('triage_items')
          .insert(buildTriageItem({
            callLogId: call.id,
            flag: 'shared_phone_ambiguous',
            extraction: v2CanonicalExtraction || undefined,
            extraPayload: {
              share_count: sharedPhoneAmbiguity.shareCount,
              candidates: sharedPhoneAmbiguity.candidates,
              extracted_name: [extracted.first_name, extracted.last_name].filter(Boolean).join(' ') || null,
            },
          }))
          .onConflict(db.raw('(call_log_id, reason_code) WHERE status IN (\'open\', \'in_progress\')'))
          .ignore()
          .catch((triageErr) => logger.warn(`[call-proc] shared-phone triage insert failed for ${maskSid(callSid)}: ${triageErr.message}`));
      } else if (extracted.first_name && phone && !extracted.is_voicemail && !v2NonCustomerCallNature) {
        // Create new customer. NEVER from a voicemail — a one-sided message
        // transcription is too lossy to mint a customer record from (the Josh
        // incident: first name + mangled address became a "real" customer).
        // A workable voicemail becomes a customer-less Needs-Review lead in
        // Step 4b instead; the office completes it into a customer by hand.
        // NEVER from a V2 non-lead nature either (v2NonCustomerCallNature) —
        // an applicant is not a customer, and a billing/existing-customer
        // call from an unmatched number must hold for review, not mint a
        // duplicate record (codex r5 P2).
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

          // Account layer: attach-or-create so the new lead profile is
          // login-complete (portal refresh sessions FK customer_accounts).
          // Lazy require: route module from a service (load-cycle risk).
          const { ensureCustomerAccount } = require('../routes/admin-customers');
          const account = await ensureCustomerAccount(db, {
            firstName: extracted.first_name,
            lastName: extracted.last_name || null,
            phone,
            email: extracted.email || null,
          });
          // Customer creation and its call-creation provenance marker are
          // ONE transaction (Codex #3084 r23/r25): a crash before the
          // Step-4 link update leaves the new customer matchable by phone,
          // and the reclaiming run (createdCustomerFromCall=false) could
          // never prove authorship — the rebuild would skip the newsletter
          // DOI forever. Customer row exists ⇒ marker exists; the marker
          // keys the retry rebuild (never timestamps — a customer someone
          // else created in the window must not be auto-subscribed). The
          // customer-link update later in the run re-asserts it (r24).
          // call_log.customer_id is set HERE too (pre-push P0, r54): the
          // email-correction fanout discovers its scope — cards, hold
          // rows, advisory locks — through call_log.customer_id, so a
          // customer visible before the link left a window where an
          // operator correcting the brand-new record missed this call
          // entirely, and the run could later record the stale extracted
          // address with the correction's evidence nowhere on the call.
          // Token-fenced: a worker that lost the claim rolls the whole
          // creation back (the owning run creates and links its own).
          let newCust;
          await db.transaction(async (trx) => {
            [newCust] = await trx('customers').insert(applyContactNormalization({
              account_id: account.accountId,
              is_primary_profile: !account.existingCustomer,
              profile_label: account.existingCustomer ? 'Additional property' : 'Primary',
              first_name: extracted.first_name,
              last_name: extracted.last_name || null,
              phone,
              email: extracted.email || null,
              address_line1: addrLine || null,
              // The extraction carries the unit separately — dropping it made
              // condo/apartment customers unfindable by any unit-bearing
              // address search and defeated the estimate builder's address
              // auto-match. DELIBERATELY extracted.address_line2 only, no V2
              // fallback: adoptV2PrimaryFields already copies a SAFE V2 unit
              // into `extracted` under primary mode and rejects streetless
              // V2 address components — reading V2 directly here would glue
              // a V2 unit onto an unrelated V1 street (audit P1 r3), and in
              // shadow/kill-switch mode the canonical row must stay fully
              // V1-driven (audit P1 r2). Same 100-char clamp as the booking
              // property-linkage path.
              address_line2: String(extracted.address_line2 || '').trim().slice(0, 100) || null,
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
            const linked = await trx('call_log')
              .where({ id: call.id })
              .where('processing_token', procToken)
              .update({
                customer_id: newCust.id,
                metadata: trx.raw(
                  "jsonb_set(COALESCE(metadata, '{}'::jsonb), '{created_customer_id}', ?::jsonb, true)",
                  [JSON.stringify(String(newCust.id))],
                ),
                updated_at: new Date(),
              });
            if (!linked) {
              const lost = new Error('processing claim lost during customer creation — rolled back');
              lost.claimLost = true;
              throw lost;
            }
          });
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

    // NOTE — no same-call auto-reconciliation of the unit ask. It was built
    // (codex asked for it: evidence re-extracted from THIS call IS
    // attributable to THIS call's ask, unlike a later call's) and then
    // removed, because every version of it closed an owed task on evidence
    // that was not yet durable: the reconciliation runs here, while the
    // customer/lead writes and the final call persistence happen later and
    // can still fail — leaving the task closed against a dispatch record
    // that is still unit-less. Reconciling only after those writes would
    // mean re-reading persisted state and clearing the lead's rolled-up
    // reason in the same breath, which is a lot of machinery for the narrow
    // case of an operator force-reprocessing one call.
    //
    // The doctrine holds instead: this ask is closed by a human verdict
    // (AGENTS.md call-pipeline rules). A reprocess that captures the unit
    // leaves a stale card the office dismisses in one click — the same
    // flow every other owed-confirmation card already uses.

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

    // Phone-verification lane (owner directive 2026-07-27): when a call ends
    // up linked to an EXISTING customer whose on-file numbers do NOT include
    // the number the caller actually dialed from, the link came from
    // something weaker than the phone (a pre-set call.customer_id, a
    // name/context match) — never trust it silently. Advisory card carries
    // the number + the matched identity so the office confirms it's really
    // them and saves the number to the account (future calls then hard-match
    // by phone). Identity compares the inbound ANI (call.from_phone), NOT
    // resolveCallContactPhone's result — that helper prefers a DICTATED
    // callback number, which says nothing about who is on the line (codex
    // P2). Skips brand-new customers (their phone IS this call's) and
    // outbound dials. Best-effort: a failed check must never break call
    // processing.
    let callerPhoneUnverified = false;
    // Anonymous/restricted sentinels and internal forwarding numbers are
    // truthy but say nothing about the caller — without the usability gate
    // they'd open bogus "save this number" cards and suppress legitimate
    // backfills (pre-push audit P1).
    const verifiableAni = firstExternalPhone(call.from_phone);
    if (customerId && verifiableAni && !createdCustomerFromCall && !isOutboundCall(call)) {
      try {
        // CONTACT_MATCH_PHONE_COLS plus secondary_phone: the matcher's column
        // set omits it deliberately, but for IDENTITY an ANI stored in the
        // admin-editable secondary slot is on file — flagging it would ask the
        // office to save a number the account already has (codex round-2 P2).
        const identityPhoneCols = [...CONTACT_MATCH_PHONE_COLS, 'secondary_phone'];
        const linked = await db('customers').where({ id: customerId })
          .first(['first_name', 'last_name', ...identityPhoneCols]);
        const phoneOnFile = !!linked && identityPhoneCols.some((col) => samePhone(verifiableAni, linked[col]));
        if (linked && !phoneOnFile) {
          callerPhoneUnverified = true;
          await db('triage_items')
            .insert(buildTriageItem({
              callLogId: call.id,
              flag: 'caller_phone_not_on_file',
              extraction: v2CanonicalExtraction,
              severity: 'advisory',
              extraPayload: {
                caller_phone: verifiableAni,
                matched_customer_name: [linked.first_name, linked.last_name].filter(Boolean).join(' ') || null,
                on_file_phone: linked.phone || null,
              },
            }))
            .onConflict(db.raw('(call_log_id, reason_code) WHERE status IN (\'open\', \'in_progress\')'))
            .ignore();
          // Mirror into the bridge list: the finalizer sets
          // call_log.review_status='open' from bridgeNeedsConfirmation, and
          // the lead timeline's CONFIRM-BEFORE-DISPATCH note reads it too —
          // without this, a mismatch-only call looks fully processed
          // (codex round-2 P2).
          if (!bridgeNeedsConfirmation.includes('caller_phone_not_on_file')) {
            bridgeNeedsConfirmation.push('caller_phone_not_on_file');
          }
          logger.info(`[call-proc] Caller ANI not on any phone slot of linked customer ${customerId} — advisory identity-confirm card opened for ${maskSid(callSid)}`);
        }
      } catch (e) {
        // Fail CLOSED: we couldn't prove the number is on file, so the
        // appointment backfill must not save it (the exact corruption this
        // guard exists to prevent). Suppression only skips one phone write —
        // call processing continues. No e.message — DB errors can echo bound
        // PII (pre-push audit P1s).
        callerPhoneUnverified = true;
        logger.warn(`[call-proc] caller-phone-on-file check errored for ${maskSid(callSid)} — failing closed on phone backfill: ${e.code || e.name || 'db_error'}`);
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
    // Phones whose opt-in CLAIM failed (render/insert error): the same-call
    // fan-out must exclude them — no row means grandfathered, and a claim
    // failure must fail CLOSED for that phone, not text it (#2956 r13).
    const optinClaimFailedPhones = new Set();
    if (process.env.GATE_CALL_SECONDARY_CONTACT === 'true' && customerId && callSecondaryContacts.length) {
      // Every extracted party (up to 3), in notification-centrality order —
      // each entry passes the SAME per-contact gates (wants_notifications,
      // dedup, cross-customer, empty slot). Stop early when slots run out.
      for (const secondaryEntry of callSecondaryContacts) {
      try {
        const result = await persistCallSecondaryContact(customerId, secondaryEntry, { smsConsentExplicit: v2SmsConsentExplicit });
        logger.info(`[call-proc] secondary contact for ${maskSid(callSid)}: ${result}`);
        // Recipient double opt-in parity with the portal flow (#2956): a
        // call-created phone recipient gets the same claim + confirmation
        // ask (dark template = nothing pends; gate off = no-op). The CLAIM
        // is awaited so the same-call fan-out below can never race a
        // rowless (grandfathered-looking) new phone; the Twilio dispatch
        // stays async.
        if (result === 'written' && secondaryEntry?.phone && v2SmsConsentExplicit) {
          try {
            const { claimRecipientOptins, dispatchRecipientOptins } = require('./recipient-optin');
            const custRow = await db('customers').where({ id: customerId }).first();
            if (custRow) {
              const optLast10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);
              const claims = await claimRecipientOptins({
                customer: custRow,
                contacts: [{
                  name: [secondaryEntry.first_name, secondaryEntry.last_name].filter(Boolean).join(' '),
                  firstName: secondaryEntry.first_name || '',
                  phone: secondaryEntry.phone,
                }],
                // The just-written slot must be ASKED — prior phones are the
                // OTHER slots only.
                priorPhones: [custRow.service_contact_phone, custRow.service_contact2_phone, custRow.service_contact3_phone]
                  .filter((ph) => optLast10(ph) !== optLast10(secondaryEntry.phone)),
                propertyAddress: [custRow.address_line1, custRow.city].filter(Boolean).join(', '),
              });
              if (claims.length) {
                void dispatchRecipientOptins(claims, custRow)
                  .catch((err) => logger.warn(`[call-proc] recipient opt-in dispatch failed for ${maskSid(callSid)}: ${err.message}`));
              }
            }
          } catch (optErr) {
            const failedKey = String(secondaryEntry.phone || '').replace(/\D/g, '').slice(-10);
            optinClaimFailedPhones.add(failedKey);
            // Durable fail-closed: the slot is already committed, so leave a
            // BLOCKING ask_failed row (save-retryable) — the in-memory set
            // only protects this processing run.
            if (failedKey) {
              await db('recipient_optin').insert({
                phone_key: failedKey,
                phone_e164: String(secondaryEntry.phone || '').trim(),
                status: 'ask_failed',
                customer_id: customerId,
                requested_by: 'call_pipeline',
                requested_at: new Date(),
              }).onConflict(['customer_id', 'phone_key']).ignore().catch(() => {});
            }
            logger.warn(`[call-proc] recipient opt-in hook failed for ${maskSid(callSid)}: ${optErr.message}`);
          }
        }
        if (result === 'skipped_phone_belongs_to_other_customer') {
          // Distinct review card: the named contact's number is another
          // customer's primary phone — the office decides whether it's the
          // same household, a realtor's office line, or a mishear.
          await db('triage_items')
            .insert(buildTriageItem({
              callLogId: call.id,
              flag: 'secondary_contact_is_existing_customer',
              extraction: v2CanonicalExtraction || undefined,
              extraPayload: { secondary_contact: secondaryEntry },
            }))
            .onConflict(db.raw('(call_log_id, reason_code) WHERE status IN (\'open\', \'in_progress\')'))
            .ignore()
            .catch((triageErr) => logger.warn(`[call-proc] secondary-collision triage insert failed for ${maskSid(callSid)}: ${triageErr.message}`));
        }
        if (result === 'skipped_slots_full') break;
      } catch (e) {
        // Code/name only — a DB error message can echo the contact's phone/email.
        logger.warn(`[call-proc] secondary-contact write skipped for ${maskSid(callSid)}: ${e.code || e.name || 'db_error'}`);
      }
      }
    }

    // Step 4: Update call log with extraction results.
    // Keep the row claimed as 'processing' while downstream side effects run.
    // The terminal status is written only after leads/estimates/scheduling have
    // had a chance to land, so a crash cannot mark the call processed early.
    // A job-applicant veto is an INTENTIONAL skip, not a creation failure —
    // without excluding it here the call would close as
    // customer_creation_failed and pollute failure reporting (codex r4 P2).
    const customerExpected = !!(extracted.first_name && phone && !extracted.is_voicemail && !extracted.is_spam && !v2NonCustomerCallNature);
    const customerLanded = !!customerId;
    // Downgraded below if a customer-less recovery lead was expected but its
    // insert failed — that lead is the only durable record for this call, and
    // customerExpected is false, so a swallowed failure would otherwise look
    // fully 'processed'.
    let finalStatus = (customerExpected && !customerLanded) ? 'customer_creation_failed' : 'processed';
    // Armed by the non-lead-verdict stamp settle: its attribution retire
    // must ride the FINAL fenced status write, not the settle's own
    // transaction (pre-push P0 r12).
    let deferredNonLeadAttributionRetire = false;
    await db('call_log').where({ id: call.id }).update({
      customer_id: customerId || call.customer_id,
      // Call-creation provenance rides the SAME durable write that links
      // the customer (Codex #3084 r24): customer_id persisted ⇒ marker
      // persisted, so a recovery run can never see a call-created customer
      // whose newsletter rebuild marker is missing. (The creation-time
      // stamp above is a best-effort early copy for mid-run readers.)
      ...(createdCustomerFromCall && customerId ? {
        metadata: db.raw(
          "jsonb_set(COALESCE(metadata, '{}'::jsonb), '{created_customer_id}', ?::jsonb, true)",
          [JSON.stringify(String(customerId))],
        ),
      } : {}),
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
    // The composed service_interest the enrichment pass actually wrote (null
    // when it wrote nothing) — the V2 recurring-default backfill's ownership
    // predicate must match THIS persisted value, not a label recomputed after
    // the V2 merge has overwritten matched/requested (codex P1 07-15).
    let persistedServiceInterestLabel = null;
    // Just the "+ Family" tail of that label (never its primary): the backfill
    // recompose may only carry SECONDARY families forward — reinjecting the
    // whole label would resurrect a stale V1 primary the validated V2 merge
    // corrected (codex P1 07-15).
    let persistedServiceInterestExtras = null;
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
    // Set when a same-call row is dropped because it is no longer ours (see
    // the ownership re-read in Step 4b). workableUnnamedLead is false
    // whenever customerId exists, so the customer-attached rejection needs
    // its own signal to reach the Needs Review surfacing below (codex P2).
    let sameCallOwnershipRejected = false;
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
    // A stamp an EARLIER ATTEMPT of this call may have written
    // (call_log.metadata.lead_id). Parsed OUTSIDE the lead section: it must
    // be reconciled on EVERY retry outcome — including a retry that gained a
    // phone or was vetoed out of lead creation entirely — or the consumers
    // that read the stamp keep associating this call with a lead a prior
    // attempt chose (audit P1 r22).
    const { leadId: priorStampedLeadId, via: priorStampedLeadVia } = parseStampedLeadLink(call);
    // Linkage completion flag: once this call's flow involves a reused lead
    // or a prior stamp, it must EXIT with its linkage settled (stamped,
    // re-pointed, or cleared by the maintenance block). A throw anywhere
    // before that block would otherwise be swallowed by the section's
    // non-blocking catch and finalize the call with missing or stale
    // linkage (audit P1 r21) — the catch escalates while this is set.
    // ARMED FROM THE PRIOR STAMP AT DECLARATION, not after the reuse
    // lookup: a transient findReusableCallLead failure on a stamped retry
    // would otherwise finalize with the old stamp unrevalidated (codex P1
    // r14).
    let leadLinkagePending = !!priorStampedLeadId;
    // Assigned inside the try once the lead source resolves; declared out
    // here so the section catch can run it on a benign failure (codex P2).
    // The default no-op keeps pre-lead-source failures safe.
    let runCallPpcAttribution = async () => {};
    // Set when a repoint transfer hit a target-slot conflict — this pass's
    // attribution must not run against the target's foreign row (codex P1,
    // PR #3303 r4).
    let attributionConflictRetired = false;
    if (shouldCreateLead) {
      try {
        // Check if lead already exists for this phone — or by spoken email
        // when the caller ID was blocked (see findReusableCallLead for the
        // per-path filters: soft-deleted excluded always; active-only
        // on the customer-less recovery path; unclaimed-or-ours on the
        // customer-attached path, so a shared-phone lead owned by another
        // customer is never reused/overwritten; UNCLAIMED-only when the phone
        // is ambiguous across customers — this call must not enrich a lead
        // one of the candidates owns while the office adjudicates).
        // Built ONCE and passed to both the lookup and the guarded same-call
        // write, so the two can never enforce different eligibility.
        const sameCallEligibility = {
          customerId,
          workableUnnamedLead,
          unclaimedOnly: !!sharedPhoneAmbiguity.candidates,
        };
        const { lead: existingLead, matchedVia: existingLeadVia } = await findReusableCallLead(db, {
          phone,
          email: phone ? null : (extracted.email || null),
          firstName: extracted.first_name || null,
          lastName: extracted.last_name || null,
          callSid: call.twilio_call_sid || null,
          stampedLeadId: priorStampedLeadId,
          stampedLeadVia: priorStampedLeadVia,
          ...sameCallEligibility,
        });
        // Same-call reuse (a retry found the lead THIS call's earlier attempt
        // inserted, by sid — or already REUSED, by stamp) is strong identity,
        // so the weak-identity write revalidation must not apply its
        // email/name predicates to it (a name-less caller's own row would
        // fail them and re-mint). Decided by the LOOKUP'S OWN provenance,
        // never inferred from id/phone equality after the fact (pre-push P1
        // r1+r2 on the root fix): a stamp-arm-rejected customer-owned row
        // the phone fallback re-finds is plain phone reuse (its write runs
        // the phone path's ownership rules, keeping retries idempotent),
        // while a row the stamp arm itself selected keeps the same-call
        // strict predicates its lookup enforced — so a claim landing
        // between lookup and write 0-rows instead of overwriting the
        // newly-claimed lead.
        const sameCallLeadReuse = existingLeadVia === 'same_call_sid'
          || existingLeadVia === 'same_call_stamp';
        // The guarded write and the 0-row recheck repeat EXACTLY the
        // eligibility the selecting arm enforced — including the
        // phone-authorized-stamp relaxation when the stamp arm applied it
        // (codex P2): a stamp-arm hit under relaxed ownership must not be
        // re-judged by the strict set at write time, and vice versa. Sid-arm
        // hits stay strict (a sid row is this call's own insert).
        const sameCallWriteEligibility = {
          ...sameCallEligibility,
          phoneAuthorizedStamp: existingLeadVia === 'same_call_stamp' && priorStampedLeadVia === 'phone',
        };
        // A fresh insert with no prior stamp self-links via its own sid at
        // insert time — REUSE of a different-sid lead puts linkage state in
        // play (a leftover stamp already armed the flag at declaration).
        // Phone-bearing reuse included: since the durable-linkage root fix
        // it stamps exactly like phone-less reuse, so its failures must
        // escalate to the retry lane the same way. A same-sid reuse is this
        // call's own row — the sid is the durable linkage, no stamp needed.
        if (existingLead
          && !(call.twilio_call_sid && existingLead.twilio_call_sid === call.twilio_call_sid)) {
          leadLinkagePending = true;
        }
        // The stamp as it stands NOW — updated when the in-loop stamp+write
        // transaction runs, so the post-loop maintenance reconciles the
        // ACTUAL stamp, not the one from processing start.
        let currentStampedLeadId = priorStampedLeadId;

        // Resolve the dialed number's marketing source ONCE — used by both the
        // existing-lead and new-lead paths, and for PPC attribution of paid calls.
        // Match every plausible shape of `lead_sources.twilio_phone_number` (it has
        // historically been hand-entered: E.164 `+19413187612`, 11-digit
        // `19413187612`, 10-digit `9413187612`, formatted `(941) 318-7612`).
        let leadSourceId = null;
        let leadSourceRow = null;
        try {
          // Shared with the rejection-repair branch at finalization (codex
          // P1 r20) — never re-inline the variant matching or the referral
          // override, or a repaired row lands on a different channel than
          // the original write.
          const { row: ls, variants, matchedByNumber } = await resolveCallLeadSource({
            dbc: db,
            toPhone: call.to_phone,
            preferReferral: !!referrerNameFromExtracted(extracted),
          });
          if (!matchedByNumber) {
            logger.warn(`[call-proc] No lead_source matched ${maskPhone(call.to_phone)} (variants tried: ${variants.map(maskPhone).join(', ')})`);
          }
          if (ls) { leadSourceId = ls.id; leadSourceRow = ls; }
        } catch (e) {
          logger.warn(`[call-proc] lead_source lookup failed: ${e.message}`);
        }

        // Assigned HERE (before anything downstream can throw) and invoked
        // after the enrichment/claim-race block — and also from the section
        // catch on a benign failure, so a transient enrichment error cannot
        // permanently drop the call from paid/organic funnel reporting
        // (codex P2). Reads leadId/customerId at CALL time (final values);
        // fully self-guarded, never throws.
        runCallPpcAttribution = async () => {
          try {
            const callAttr = leadSourceRow
              ? require('./ads/call-attribution').attributionForSourceType(leadSourceRow.source_type)
              : null;
            const isBridgeTarget = leadSourceRow
              && require('./ads/google-call-bridge').isBridgeTargetNumber(leadSourceRow.twilio_phone_number);
            if (leadId && customerId && callAttr && !isBridgeTarget && !attributionConflictRetired) {
              // Token-fenced under the call row lock (pre-push P0 r17):
              // with sourceCallId in play, a STALE worker's provenance
              // recovery could move the history-bearing row back — or
              // conflict-retire it — before its own finalization writes
              // zero rows; that loss is irreversible. Ownership is
              // verified inside the transaction and every attribution
              // statement rides it, in the repo-wide leads → call_log
              // acquisition order.
              const pending = db.transaction(async (trx) => {
                // Repo-wide lock order is leads → call_log (the bridge
                // and every stamp writer). Lock the selected lead FIRST
                // (pre-push P1 r8) — the funnel insert's FK takes KEY
                // SHARE on this lead anyway, and acquiring the call row
                // first inverted the order against a stamp writer
                // holding the lead and waiting on this call. The LOCKED
                // row's eligibility and owner are authoritative (GH P1
                // r6): a lead soft-deleted or reassigned after the
                // enrichment write must not receive attribution keyed to
                // the stale snapshot's customer.
                const lockedLead = await trx('leads')
                  .where({ id: leadId })
                  .whereNull('deleted_at')
                  .forUpdate()
                  .first('id', 'customer_id');
                if (!lockedLead) return;
                const owned = await trx('call_log')
                  .where({ id: call.id })
                  .where('processing_token', procToken)
                  .forUpdate()
                  .first('id', 'metadata');
                if (!owned) return;
                // A LIVE pending-transfer marker DEFERS the funnel write to
                // the daily sweep (codex P1 r13): a later pass revisiting
                // the SAME stamped lead skips the moved-link branch
                // (preSettleStampedLeadId === leadId), so
                // attributionConflictRetired starts false again and this
                // write would double-count the call against the former
                // lead's still-unresolved legacy row. Read under the row
                // lock — serialized with both the marker writer and the
                // sweep — so the marker's presence is authoritative: while
                // it stands, ONLY the sweep may complete the write.
                let ownedMd = {};
                try {
                  ownedMd = typeof owned.metadata === 'string'
                    ? (JSON.parse(owned.metadata) || {})
                    : (owned.metadata || {});
                } catch { ownedMd = {}; }
                if (ownedMd.attribution_transfer_pending) {
                  // REFRESH the deferred decision before deferring (codex
                  // P1 r14): this pass may have re-classified the service
                  // or referral — the sweep writes the MARKER's saved
                  // fields, so leaving the old payload would record stale
                  // channel/service attribution once the blocker resolves.
                  // from_lead_id and last_attempt_at are preserved; only
                  // the funnel decision is re-supplied from THIS pass.
                  // The TARGET refreshes with the decision (codex P1 r23).
                  // A later force-reprocess can move the call again to a
                  // phone- or sid-linked lead, and that relink is
                  // deliberately stamp-less — so the sweep has no live
                  // stamp to override a stale to_lead_id and would resolve
                  // the marker against the obsolete lead once the legacy
                  // blocker cleared. This pass holds the authoritative
                  // answer in its own locked leadId.
                  const refreshed = {
                    ...ownedMd.attribution_transfer_pending,
                    ...(leadId ? { to_lead_id: String(leadId) } : {}),
                    lead_source: callAttr.leadSource,
                    is_paid: callAttr.isPaid,
                    detail: leadSourceRow.name || 'inbound call',
                    service_interest: extracted.matched_service || extracted.requested_service || null,
                  };
                  await trx('call_log')
                    .where({ id: call.id })
                    .where('processing_token', procToken)
                    .update({
                      metadata: db.raw(
                        "jsonb_set(COALESCE(metadata, '{}'::jsonb), '{attribution_transfer_pending}', ?::jsonb, true)",
                        [JSON.stringify(refreshed)],
                      ),
                      updated_at: new Date(),
                    });
                  return;
                }
                const attrRes = await require('./ads/call-attribution').recordCallPpcAttribution({
                // The locked owner EXACTLY (GH P1 r6) — an unassigned
                // lead's live owner is NULL and recordCallPpcAttribution
                // refuses it, instead of pairing the row with the
                // pre-lock snapshot's customer.
                customerId: lockedLead.customer_id || null,
                leadId,
                leadSource: callAttr.leadSource, // funnel channel key (paid or organic)
                isPaid: callAttr.isPaid,
                leadSourceDetail: leadSourceRow.name || 'inbound call',
                // Pass the PRIMARY matched service, NOT the composed
                // multi-service label (and not the lead row's
                // service_interest, which enrichment may have just written
                // as the composite): attribution derives a single
                // service_line via inferServiceLine, whose keyword order
                // (lawn before pest) would bucket a pest-primary "… + Lawn
                // Care Service" composite as lawn and skew paid/organic ROI
                // (codex r3). The secondary families live on the lead's
                // service_interest; the single-line funnel field carries the
                // primary by design.
                serviceInterest: extracted.matched_service || extracted.requested_service || null,
                leadDate: call.created_at || null, // date by the actual call
                // Provenance for the bridge's repoint reconciliation (codex
                // P1, PR #3303): the funnel row THIS call creates carries
                // its call id, so a later stamp repoint can transfer or
                // retire exactly this row and never another call's.
                sourceCallId: call.id || null,
                dbc: trx,
                });
                // recordCallPpcAttribution catches its own SQL errors and
                // returns reason 'error' — but a failed statement has
                // ABORTED this transaction, so resolving normally would
                // let PostgreSQL roll it back silently while the call
                // finalizes without attribution (pre-push P1 r10, same
                // rule as google-call-bridge). Throw so the catch below
                // logs it as the real failure it is.
                if (attrRes?.reason === 'error') {
                  throw new Error(attrRes.error || 'attribution_write_failed');
                }
              }).catch((txnErr) => {
                // Never silent, and never final (pre-push P1 r8, GH P1
                // r6): dedicated/organic calls have no bridge scan to
                // re-heal a dropped attribution, so a failed transaction
                // (deadlocked transfer, aborted insert) must RETHROW
                // after logging — the outer processing failure path then
                // marks the call retryable instead of finalizing it as
                // processed with permanently wrong funnel state.
                logger.warn(`[call-proc] PPC attribution transaction failed for ${callSid}: ${txnErr.code || txnErr.name || 'error'}`);
                const wrapped = new Error(`PPC attribution transaction failed: ${txnErr.code || txnErr.name || 'error'}`);
                wrapped.attributionTxnFailure = true;
                throw wrapped;
              });
              await pending;
            }
          } catch (attrErr) {
            // Only the dispatch scaffolding (source lookups, gating) is
            // swallowed here — a failed attribution TRANSACTION
            // propagates so the run retries (GH P1 r6).
            if (attrErr.attributionTxnFailure) throw attrErr;
            logger.warn(`[call-proc] PPC attribution dispatch failed: ${attrErr.code || attrErr.name || 'error'}`);
          }
        };

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

          // Untracked inbound call → no lead_source matched → admin bell so the
          // "Unattributed" lead can be source-tagged; tracked marketing call →
          // the same new_lead bell + Web Push the web-form path sends. Both
          // branches live in notifyNewCallLead (shared with the claim-race
          // recovery mint below) and never throw — a notify failure must never
          // break call processing.
          await notifyNewCallLead({ leadId, phone, extracted, leadSourceId, leadSourceRow, call });
        }

        // Dropped-call detector, phase 1 of 2 (owner directive 2026-08-01): a
        // LIVE inbound intake conversation that ran MIN_CALL_SECONDS+, ended
        // with no farewell in the transcript tail, and captured no service
        // address on either extraction leg is a drop-mid-intake — an engaged
        // caller who got cut off (a 2026-07-27 live case: a long engaged
        // call dropped at the address exchange and no callback happened).
        // Detection + the bridge flag run HERE, before the enrichment write
        // below consumes bridgeNeedsConfirmation into needs_confirmation and
        // the ai_triage timeline note. The text + review card run in phase 2
        // (after enrichment) because the enrichment write REBUILDS
        // extracted_data and would clobber the send module's per-lead claim
        // stamp.
        let droppedMidIntake = false;
        let droppedCallSeconds = 0;
        // Raw detector verdict BEFORE the reused-lead-address suppression —
        // the claim-race recovery below needs it to re-judge suppression
        // against the replacement row (codex P2 r8).
        let droppedDetectorFired = false;
        if (leadId && !voicemailLeadPath && !extracted.is_voicemail && !extracted.is_spam
          && !isOutboundCall(call) && transcription) {
          try {
            const DroppedCallSmsDetect = require('./dropped-call-sms');
            // recordingDurationSeconds: fresh recording jobs can have
            // duration_seconds unset while recording_duration_seconds is
            // populated (the race this file already handles elsewhere).
            droppedCallSeconds = recordingDurationSeconds(call);
            // A reused open lead can already carry the address from a prior
            // call — a later abrupt call that doesn't restate it is NOT a
            // missing-address drop; don't card it or text for information
            // already on file (codex P1).
            const leadAddressOnFile = !!String(existingLead?.address || '').trim();
            droppedDetectorFired = DroppedCallSmsDetect.detectDroppedMidIntake({
              durationSeconds: droppedCallSeconds,
              transcription,
              extracted,
              v2Extraction: v2Result?.status === 'valid' ? v2Result.extraction : null,
            });
            droppedMidIntake = !leadAddressOnFile && droppedDetectorFired;
            // A PRE-EXISTING linked customer whose record already carries the
            // service address is not missing anything — the card would
            // falsely claim so (codex P2). One read, only when detection
            // otherwise fired.
            if (droppedMidIntake && customerId && !createdCustomerFromCall) {
              const custAddr = await db('customers').where({ id: customerId })
                .first('address_line1').catch(() => null);
              if (String(custAddr?.address_line1 || '').trim()) droppedMidIntake = false;
            }
            if (droppedMidIntake && !bridgeNeedsConfirmation.includes('call_dropped_mid_intake')) {
              bridgeNeedsConfirmation.push('call_dropped_mid_intake');
            }
          } catch (dropErr) {
            logger.warn(`[call-proc] dropped-call detection failed (non-blocking): ${dropErr.message}`);
          }
        }

        // Enrich lead with AI-extracted data. For an existing lead, only fill
        // fields that are still empty so we don't clobber Virginia's manual
        // edits when a follow-up call comes in. For a brand-new lead (just
        // inserted above) every column we'd touch is null, so the
        // empty-only rule is equivalent to "fill everything" anyway.
        if (leadId) {
          let current = existingLead || (await db('leads').where({ id: leadId }).first());
          const isEmpty = (v) => v === null || v === undefined || v === '';

          // The enrichment below runs as a PASS over `current` so the
          // claim-race recovery can re-run the SAME pass against a freshly
          // minted row instead of maintaining a second hand-built insert that
          // drifts from this one (pre-push audit P1 r5; AGENTS.md: no
          // parallel mechanisms). At most two passes ever run.
          let leadUpdates;
          let contact;
          let enriched = 0;
          let raceRecovered = false;
          for (;;) {
            leadUpdates = {};
            // A retry can RECOVER a callback number and still reuse the
            // phone-less lead via same-call SID identity — without this fill
            // the lead stayed unreachable by phone forever and later calls
            // could not reuse it by number (audit P1 r23). Fill-if-empty
            // like the other identity fields; an existing phone never moves.
            if (phone && isEmpty(current?.phone)) leadUpdates.phone = phone;
            if (extracted.first_name && isEmpty(current?.first_name)) leadUpdates.first_name = capitalizeName(extracted.first_name);
            if (extracted.last_name && isEmpty(current?.last_name)) leadUpdates.last_name = capitalizeName(extracted.last_name);
            if (extracted.email && isEmpty(current?.email)) leadUpdates.email = extracted.email;
            if (extracted.address_line1 && isEmpty(current?.address)) leadUpdates.address = extracted.address_line1;
            if (extracted.city && isEmpty(current?.city)) leadUpdates.city = extracted.city;
            if (extracted.zip && isEmpty(current?.zip)) leadUpdates.zip = extracted.zip;
            // Multi-service calls: matched_service is single-slot, so append the
            // requested families it doesn't cover ("pest and lawn" must not
            // price as pest-only). Fill-if-empty semantics unchanged.
            // When the V2 gate approved this call, compose the extras from the
            // V2-APPROVED service categories (primary + secondary_categories),
            // mapped to scannable legacy service words: a V1-hallucinated
            // family V2 rejected must not leak onto the lead label (codex r9),
            // and flatView's requested_service is the raw primary category
            // token ("pest_general"), which drops V2's secondaries and scans
            // as nothing (codex r10). matched_service stays V1 here — the
            // recurring-default backfill below re-asserts it post-merge.
            const v2ServiceRequest = v2ApprovedExtraction?.service_request || null;
            const v2RequestedForCompose = (() => {
              if (!v2ServiceRequest) return null;
              // composeWordsForV2Category, NOT mapServiceCategoryToLegacy: the
              // legacy map collapses palm_injection into Tree & Shrub and
              // hard-labels termite as inspection (codex r11).
              let cats = [v2ServiceRequest.primary_service_category,
                ...(Array.isArray(v2ServiceRequest.secondary_categories) ? v2ServiceRequest.secondary_categories : [])];
              // A specialty catalog pick (flea/stinging/bed-bug) rides the
              // coarse pest_general category in the V2 enum — the generic
              // category word is the SAME job, not an extra pest request
              // (codex r20).
              const v2SpecificPick = flatView(v2ApprovedExtraction).specific_service_name;
              if (v2SpecificPick && labelIsSpecialtyPestFamily(v2SpecificPick)) {
                // Only the coarse category BACKING the specialty pick (the
                // PRIMARY slot) is redundant — a separate pest_general
                // SECONDARY is a real second request (codex r22).
                cats = cats.filter((c, i) => !(i === 0 && (c === 'pest_general' || c === 'bundled_waveguard')));
              }
              // Null-mapped categories (other/inspection_only/future enums)
              // yield an EMPTY category-authoritative request — never fall
              // back to V1 caller text under V2 approval (codex r12)…
              const words = cats.map((c) => composeWordsForV2Category(c)).filter(Boolean);
              // …EXCEPT for families the V2 enum cannot express at all
              // (tree/shrub, wildlife): those exist only in the caller text,
              // so scan it for JUST them (codex r14 — closes the enum gap
              // without reopening the V1-hallucination door).
              const inexpressible = v2InexpressibleFamilyWords(extracted.requested_service);
              return [words.join(' and '), inexpressible].filter(Boolean).join(' and ');
            })();
            // Prefix with the primary the V2 merge will adopt (same adoption
            // rule as the merge below: V2 anchored a specific service, V1 had
            // no label, or the category maps one-to-one) — a V1 primary V2
            // rejected must not lead the label (codex r12).
            const matchedForCompose = (() => {
              if (v2ServiceRequest === null) return extracted.matched_service;
              const v2Flat = flatView(v2ApprovedExtraction);
              // A V2-anchored catalog pick IS the primary: "Palm Injection"
              // must lead the label, not the coarse category mapping
              // ("Tree & Shrub Care") that would then re-append the specific
              // as a fake second service (codex r13).
              if (v2Flat.specific_service_name) return v2Flat.specific_service_name;
              const v2Cat = v2ServiceRequest.primary_service_category || null;
              // Categories whose legacy mapping is null/coarse (stinging,
              // exclusion) lead with their own family label — else a
              // wasp-only call renders as two services (codex r15).
              const catPrimary = v2PrimaryLabelForCategory(v2Cat);
              if (catPrimary) return catPrimary;
              // Termite category with no specific pick: flatView's coarse
              // "Termite Inspection" would pair with the composed
              // "+ Termite Service" as a phantom double — pick the single
              // right primary from the caller's work cue (codex r22).
              if (v2Cat === 'termite') {
                return hasTermiteWorkCue(extracted.requested_service) ? 'Termite Service' : 'Termite Inspection';
              }
              const preciseV2Category = v2Cat === 'bed_bug' || v2Cat === 'wdo';
              return v2Flat.matched_service
                && (!extracted.matched_service || preciseV2Category)
                ? v2Flat.matched_service
                : extracted.matched_service;
            })();
            const serviceInterestLabel = composeServiceInterest(
              v2ServiceRequest !== null
                ? {
                  ...extracted,
                  matched_service: matchedForCompose,
                  requested_service: v2RequestedForCompose,
                  // Only the V2-ADOPTED specific may mark coverage — a stale
                  // V1 specific belonging to a secondary family (e.g. V1
                  // "Monthly Lawn Care Service" under V2 pest+lawn) would
                  // swallow that secondary's tail (codex r21).
                  specific_service_name: flatView(v2ApprovedExtraction).specific_service_name || null,
                }
                : extracted,
              // Caller wording still decides termite work-vs-inspection —
              // families stay category-authoritative under V2 approval.
              v2ServiceRequest !== null ? { cueText: extracted.requested_service } : {},
            );
            if (serviceInterestLabel && isEmpty(current?.service_interest)) {
              leadUpdates.service_interest = serviceInterestLabel;
              persistedServiceInterestLabel = serviceInterestLabel;
              // composeServiceInterest always prefixes the label with the
              // matched service it composed with (matchedForCompose under V2
              // approval), so the slice is exactly the extras.
              persistedServiceInterestExtras = serviceInterestLabel === matchedForCompose
                ? null
                : serviceInterestLabel.slice(String(matchedForCompose || '').length);
            }
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
            contact = leadContactCompleteness(mergedContact);
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
              // Recovery-pass rows keep the audit stamp the mint used to
              // carry — this write REPLACES extracted_data wholesale.
              ...(raceRecovered ? { claim_race_recovery: true } : {}),
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
            // Computed as a standalone value (not just assigned inline) so
            // the chronological-restamp settle path can RE-SUPPLY it after
            // the rollback empties the row (codex P1 r6).
            const quotePromisedDue = callQuotePromised ? (() => {
              try {
                const nowET = new Date();
                let quoteDue = parseETDateTime(`${etDateString(nowET)}T17:00`);
                if (!(quoteDue instanceof Date) || isNaN(quoteDue.getTime()) || quoteDue <= nowET) {
                  const tomorrow = new Date(nowET.getTime() + 24 * 60 * 60 * 1000);
                  quoteDue = parseETDateTime(`${etDateString(tomorrow)}T10:00`);
                }
                return (quoteDue instanceof Date && !isNaN(quoteDue.getTime())) ? quoteDue : null;
              } catch (dueErr) {
                logger.warn(`[call-proc] quote-due follow-up stamp skipped: ${dueErr.message}`);
                return null;
              }
            })() : null;
            if (quotePromisedDue) {
              const existingFollowUp = current?.next_follow_up_at ? new Date(current.next_follow_up_at) : null;
              // Only PULL IN the follow-up (or set one where none exists) —
              // an existing earlier or already-overdue follow-up stays put.
              if (!existingFollowUp || isNaN(existingFollowUp.getTime()) || existingFollowUp > quotePromisedDue) {
                leadUpdates.next_follow_up_at = quotePromisedDue;
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
            if (sameCallLeadReuse) {
              // Same-call reuse skips the weak-identity (email/name)
              // revalidation, but it must still repeat the FULL same-call
              // eligibility as the race backstop — ownership AND lifecycle.
              // Reusing the lookup's own function instead of re-deriving a
              // subset here is the point: each predicate this write used to
              // omit was a separate review finding (a claimed row
              // overwritten, then a soft-deleted or closed row enriched
              // while the call finished clean). A 0-row outcome lands in the
              // reconciliation below.
              enrichmentWrite = applySameCallLeadEligibility(enrichmentWrite, sameCallWriteEligibility);
            }
            if (!phone && existingLead && !sameCallLeadReuse) {
              // Email-matched REUSE revalidation (phone-less caller): weak
              // identity, so the write repeats the FULL lookup eligibility —
              // email + not-deleted + status/conversion + name corroboration
              // — not just unclaimed-ness/ownership (codex P1 r2 / P2 r6 /
              // P1 r8). An admin correcting the candidate's email or name or
              // closing it between lookup and write must 0-row into the
              // recovery mint below, never apply this caller's rolling
              // extraction to a row that no longer matches. Applied for
              // customer-attached phone-less reuse too (audit P1 r9), but
              // ONLY when a candidate was actually reused: fresh phone-less
              // inserts — which on the customer-attached path bypass
              // hasWorkableLeadSignal and can carry an absent or malformed
              // email — must not fail their own enrichment against these
              // predicates (audit P1 r10). The strict unclaimed predicate
              // stays anonymous-only, since a customer-attached write may
              // land on a row this same customer just claimed. A pass-2
              // recovery row (email/names from THIS extraction, status
              // 'new') passes everything here.
              if (!customerId) enrichmentWrite = enrichmentWrite.whereNull('customer_id');
              enrichmentWrite = enrichmentWrite
                .whereNull('deleted_at')
                .whereRaw('LOWER(TRIM(email)) = ?', [String(extracted.email || '').trim().toLowerCase()]);
              if (workableUnnamedLead) {
                enrichmentWrite = enrichmentWrite
                  .whereNotIn('status', TERMINAL_LEAD_STATUSES)
                  .whereNull('converted_at');
              }
              // Reuse only ever happened with both first names present and
              // matching, so the equality predicate is well-defined here.
              enrichmentWrite = enrichmentWrite.whereRaw(
                'LOWER(TRIM(first_name)) = ?',
                [String(extracted.first_name || '').trim().toLowerCase()],
              );
              const statedLastLc = String(extracted.last_name || '').trim().toLowerCase();
              if (statedLastLc) {
                enrichmentWrite = enrichmentWrite.whereRaw(
                  "(last_name IS NULL OR TRIM(last_name) = '' OR LOWER(TRIM(last_name)) = ?)",
                  [statedLastLc],
                );
              }
            }
            // Reuse of a different-sid lead (phone-bearing or phone-less —
            // both stamp since the root fix): the rollback snapshot
            // (prior + written values) must be DURABLE BEFORE the
            // lead mutation commits — the stamp and the enrichment write
            // run in ONE transaction (audit P1 r20: a crash between them
            // left the lead mutated with no rollback state, and a retry
            // then snapshotted the mutated row as its baseline). When
            // re-stamping the SAME lead on a retry, the existing
            // lead_prior_state is preserved so the ORIGINAL baseline
            // survives re-enrichment; lead_written_state always refreshes
            // to THIS pass's payload.
            // ALSO taken when a retry GAINED a phone but is enriching the
            // lead its earlier phone-less attempt already stamped (codex P1
            // r22): the stamp is deliberately retained in that case (see the
            // maintenance block), so this pass's writes — the phone fill,
            // the rolling summary/extraction, qualification — must land in
            // the same fenced transaction and refresh lead_written_state,
            // or a later rejection's CAS cannot match and roll them back.
            // A race-recovered row is freshly minted, so a pre-existing
            // stamp can never point at it; the sid-match exclusion cannot
            // co-occur with a stamp either (stamps are only ever written
            // for different-sid leads).
            const stampThisPass = shouldStampCallLeadLinkage({
              existingLead,
              raceRecovered,
              callTwilioSid: call.twilio_call_sid,
              leadId,
              currentStampedLeadId,
            });
            if (stampThisPass) {
              // A prior stamp pointing at a DIFFERENT lead must be settled
              // (cleared + its lead's state restored) BEFORE the
              // replacement stamp overwrites the ledgers (codex P1 r14) —
              // the CASE-merge in the stamp SQL only protects SAME-lead
              // re-stamps; overwriting a different lead's ledger stranded
              // the anonymous call's enrichment on a now-claimed lead
              // permanently.
              // The funnel-row TRANSFER does NOT ride this standalone
              // settle (pre-push P1 r9): if the stamp/enrich transaction
              // below then failed, the call would land extraction_failed
              // with no stamp while its attribution sat on a target whose
              // linkage never committed — and a later rejection could not
              // retire it. The settle only clears/restores ('keep'); the
              // transfer runs INSIDE the stamp transaction, after the
              // replacement linkage is written (see preSettleStampedLeadId
              // below).
              let preSettleStampedLeadId = null;
              if (currentStampedLeadId && currentStampedLeadId !== String(leadId)) {
                preSettleStampedLeadId = currentStampedLeadId;
                let priorSettled;
                try {
                  // preserveFormerLeadId: the settle's clear persists the
                  // former lead as metadata.attribution_former_lead_id in
                  // the SAME fenced write (codex P1 r17) — a failed
                  // restamp's retry recovers it below.
                  priorSettled = await clearStampAndRestoreLead(call, procToken, callSid, null, { mode: 'keep', preserveFormerLeadId: true });
                } catch (settleErr) {
                  if (settleErr.abortProcessing) throw settleErr;
                  const wrapped = new Error(`call→lead link pre-stamp settle failed: ${settleErr.code || settleErr.name || 'db_error'}`);
                  wrapped.abortProcessing = true;
                  throw wrapped;
                }
                if (!priorSettled) {
                  const lost = new Error('processing claim lost during call→lead link pre-stamp settle');
                  lost.abortProcessing = true;
                  throw lost;
                }
                currentStampedLeadId = null;
              }
              if (!preSettleStampedLeadId) {
                // RETRY breadcrumb (codex P1 r17): a prior attempt settled
                // the old stamp and then failed before its replacement
                // stamp committed — this retry claims the call with no
                // stamp, so the moved-link branch below would never see
                // the former lead, skipping the legacy-blocker check and
                // the pending-transfer marker and double-counting the
                // call. The settle persisted the former lead's id into
                // call metadata (read fresh at claim time); a successful
                // restamp clears it in the stamp write.
                try {
                  const cmd = typeof call.metadata === 'string' ? JSON.parse(call.metadata) : (call.metadata || {});
                  if (cmd.attribution_former_lead_id
                    && String(cmd.attribution_former_lead_id) !== String(leadId)) {
                    preSettleStampedLeadId = String(cmd.attribution_former_lead_id);
                  }
                } catch { /* unparseable metadata — no breadcrumb */ }
              }
              let phoneReuseRevokedUnderLock = false;
              enriched = await db.transaction(async (trx) => {
                // Snapshot under a ROW LOCK inside the same transaction that
                // stamps and updates (codex P2 r16): two concurrent
                // phone-less calls reusing one lead could both derive their
                // baseline from the pre-both row, and the later call's
                // rejection would then restore a snapshot that erases the
                // earlier call's committed enrichment. The locked read
                // serializes stampers so each baseline reflects committed
                // state — and, since r17, so does the fill-only decision
                // below (identity races stay the guarded write's job).
                const lockLeadRow = () => trx('leads')
                  .where({ id: leadId })
                  .forUpdate()
                  .first();
                let lockedLead = await lockLeadRow();
                // A PHONE-selected row is revalidated against the LOCKED
                // state BEFORE anything is written (codex P2): the lookup's
                // selecting predicates can stop holding in the gap (number
                // corrected away, row closed/converted/soft-deleted), and
                // the phone-path write below only repeats ownership — the
                // pass would stamp a durable association onto an obsolete
                // row. On failure nothing is stamped or enriched; the
                // association is dropped after the transaction (Needs
                // Review lane) and maintenance settles any prior stamp.
                // Same-call arms keep their own eligibility (the guarded
                // write repeats it) and the email arm's write enforces its
                // full predicate set in SQL already.
                if (existingLeadVia === 'phone'
                  && !phoneReuseStillValidOnLockedRow(lockedLead, { phone, ...sameCallEligibility })) {
                  phoneReuseRevokedUnderLock = true;
                  return 0;
                }
                // Is this a CHRONOLOGICAL restamp — a force-reprocess of an
                // older call after a DIFFERENT call enriched the same reused
                // lead (codex P2 r17)? Its old stamp belongs to a finished
                // epoch: merging that ledger into the new stamp mixed
                // mutations from two epochs, and because the intervening
                // call's stamp stays chronologically EARLIER than this
                // restamp, its rejection was never re-parented — it could
                // restore this call's original, already-settled values
                // straight over accepted state (pre-push P1 r2; supersedes
                // the r18 merge). SETTLE the old epoch first — the full
                // clear + CAS-restore + successor re-parent, inside THIS
                // transaction (the lead lock is already ours) — then stamp
                // a fresh epoch: with the old stamp gone the SQL below
                // starts both ledgers and the ordering marker fresh, and
                // the payload is re-decided against the POST-SETTLE row.
                const freshCall = await trx('call_log').where({ id: call.id }).first('metadata');
                let freshMd = {};
                try {
                  freshMd = typeof freshCall?.metadata === 'string' ? JSON.parse(freshCall.metadata) : (freshCall?.metadata || {});
                } catch { freshMd = {}; }
                const ownSeq = (freshMd?.lead_id && String(freshMd.lead_id) === String(leadId)
                  && Number.isFinite(Number(freshMd.lead_stamp_seq))) ? Number(freshMd.lead_stamp_seq) : null;
                if (ownSeq !== null) {
                  const interveningStamp = await trx('call_log')
                    .whereRaw("metadata->>'lead_id' = ?", [String(leadId)])
                    .whereNot('id', call.id)
                    .whereRaw("COALESCE((metadata->>'lead_stamp_seq')::bigint, 0) > ?", [ownSeq])
                    .first('id');
                  if (interveningStamp) {
                    const settled = await clearStampAndRestoreLead(call, procToken, callSid, trx, { mode: 'keep' });
                    if (!settled) {
                      const lost = new Error('processing claim lost during call→lead restamp settle');
                      lost.abortProcessing = true;
                      throw lost;
                    }
                    lockedLead = await lockLeadRow();
                    // RE-SUPPLY the payload keys the pre-settle read hid
                    // (codex P1 r6): leadUpdates was built against
                    // `current`, where THIS call's own first-run values sat
                    // in the fill-only and fill-if-empty columns — the
                    // settle just rolled them back to baseline, and the
                    // drop/reconcile helpers below can only REMOVE keys, so
                    // the accepted reprocessing would commit with its own
                    // extraction erased. Add each supply back when absent;
                    // the under-lock deciders (dropFilledLeadColumns + the
                    // conditional reconcile) then gate every one of them
                    // against the POST-SETTLE row, exactly as if the
                    // payload had been built there.
                    const resupply = (f, v) => {
                      if (v && !Object.prototype.hasOwnProperty.call(leadUpdates, f)) leadUpdates[f] = v;
                    };
                    resupply('phone', phone);
                    resupply('first_name', extracted.first_name ? capitalizeName(extracted.first_name) : null);
                    resupply('last_name', extracted.last_name ? capitalizeName(extracted.last_name) : null);
                    resupply('email', extracted.email);
                    resupply('address', extracted.address_line1);
                    resupply('city', extracted.city);
                    resupply('zip', extracted.zip);
                    if (serviceInterestLabel && !Object.prototype.hasOwnProperty.call(leadUpdates, 'service_interest')) {
                      leadUpdates.service_interest = serviceInterestLabel;
                      persistedServiceInterestLabel = serviceInterestLabel;
                      persistedServiceInterestExtras = serviceInterestLabel === matchedForCompose
                        ? null
                        : serviceInterestLabel.slice(String(matchedForCompose || '').length);
                    }
                    if (extracted.lead_quality && !Object.prototype.hasOwnProperty.call(leadUpdates, 'urgency')) {
                      leadUpdates.urgency = 'normal';
                    }
                    if (existingLead && !Object.prototype.hasOwnProperty.call(leadUpdates, 'status')) {
                      leadUpdates.status = 'new';
                    }
                    resupply('next_follow_up_at', quotePromisedDue);
                  }
                }
                // Fill-only columns are re-decided against the LOCKED row
                // (codex P2 r17) — post-settle on a restamp, so a value the
                // settle just rolled back is fillable again: `current` was
                // read before the lock, and a name/email/address an admin
                // or another call entered in that gap would otherwise be
                // overwritten by this pass's stale fill. Dropping the key
                // here also keeps it out of the rollback ledgers below — a
                // field this call never wrote must never be restored by its
                // rejection. The conditional (non-identity) decisions are
                // re-made the same way (pre-push P1 r22).
                const reconciled = reconcileConditionalLeadFieldsUnderLock(
                  dropFilledLeadColumns(leadUpdates, lockedLead),
                  lockedLead,
                  { bridgeNeedsConfirmation, leadQuality: extracted.lead_quality },
                );
                if (reconciled.serviceInterestDropped) {
                  persistedServiceInterestLabel = null;
                  persistedServiceInterestExtras = null;
                }
                if (reconciled.contact) contact = reconciled.contact;
                const effectiveUpdates = reconciled.updates;
                const { prior, written } = snapshotStampedLeadStates(lockedLead || current, effectiveUpdates);
                // Reaffirmed fills claim ledger ownership without a write
                // (codex P1 r4): the caller restated a value the lead
                // already carries, so this call's written state records the
                // CURRENT value with prior = the same — its own rejection
                // no-ops the field, but a predecessor's rejection now sees
                // a live successor owner and leaves the value alone.
                // Supplied values come from THIS call's RAW extraction, not
                // from leadUpdates (codex P1 r5): the fill-only
                // construction above already omitted every field the lead
                // carried at the pre-lock read — which is exactly the
                // normal sequential restatement (predecessor filled it on
                // an earlier call) the claim exists for. leadUpdates only
                // ever catches the concurrent fill between read and lock.
                const suppliedIdentity = {
                  phone,
                  first_name: extracted.first_name,
                  last_name: extracted.last_name,
                  email: extracted.email,
                  address: extracted.address_line1,
                  city: extracted.city,
                  zip: extracted.zip,
                };
                for (const [f, v] of Object.entries(reaffirmedFilledLeadFields(suppliedIdentity, lockedLead))) {
                  const sv = serializeStampedLeadValue(f, v);
                  written[f] = sv;
                  prior[f] = sv;
                }
                // Ledger composition has two live modes — a chronological
                // restamp was settled above and lands here stamp-less, so
                // it takes the fresh branch:
                //   different lead (or settled restamp) → fresh prior +
                //     fresh written + fresh ordering marker
                //   same lead, retry → merged: prior keeps the ORIGINAL
                //     baseline for shared keys and only ADDS keys first
                //     written this pass; written keeps fill-once fields
                //     from earlier passes (absent from later payloads —
                //     replacing wholesale made rejection unable to restore
                //     them) with this pass's values winning shared keys;
                //     the ordering marker is preserved.
                const sameLead = "COALESCE(metadata, '{}'::jsonb)->>'lead_id' = ?";
                const priorExpr = `CASE WHEN ${sameLead}`
                  + " THEN ?::jsonb || COALESCE(metadata->'lead_prior_state', '{}'::jsonb)"
                  + ' ELSE ?::jsonb END';
                const writtenExpr = `CASE WHEN ${sameLead}`
                  + " THEN COALESCE(metadata->'lead_written_state', '{}'::jsonb) || ?::jsonb"
                  + ' ELSE ?::jsonb END';
                const seqExpr = `CASE WHEN ${sameLead}`
                  + " THEN COALESCE(metadata->'lead_stamp_seq', ?::jsonb) ELSE ?::jsonb END";
                // The ordering marker is a PER-LEAD MONOTONIC INTEGER, not a
                // wall-clock timestamp (pre-push P1 r3: millisecond app
                // clocks collide under concurrency and skew across pods,
                // and the strict > comparisons then misorder rejection
                // re-parenting). Allocation is race-free because every
                // stamper holds this lead's row lock.
                const seqRow = await trx('call_log')
                  .whereRaw("metadata->>'lead_id' = ?", [String(leadId)])
                  .select(db.raw("COALESCE(MAX((metadata->>'lead_stamp_seq')::bigint), 0) + 1 AS next_seq"))
                  .first();
                const nextSeq = JSON.stringify(Number(seqRow?.next_seq || 1));
                const stamped = await trx('call_log')
                  .where({ id: call.id })
                  .where('processing_token', procToken)
                  .update({
                    // lead_stamp_seq is the ORDERING marker for rejection
                    // re-parenting (only snapshots stamped AFTER this call's
                    // may be re-parented — a predecessor's baseline must
                    // never be rewritten; codex P2 r13). Preserved on a
                    // same-lead RETRY; a different-lead stamp and a settled
                    // restamp both take a fresh marker, which is what makes
                    // the restamp the newest mutation on the lead.
                    // The trailing removal clears the settle's
                    // attribution_former_lead_id breadcrumb once the
                    // replacement stamp durably lands (codex P1 r17) — the
                    // moved-link branch below consumes it this same
                    // transaction.
                    // lead_link_via records the AUTHORITY that linked this
                    // call to the lead (codex P2), derived from the
                    // SELECTING ARM by deriveStampLinkAuthority — never
                    // from bare phone presence (pre-push P1 on r4). Retry
                    // eligibility for a phone-authorized stamp keeps the
                    // phone path's ownership rules; email/legacy stamps
                    // stay strict.
                    metadata: db.raw(
                      "(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(COALESCE(metadata, '{}'::jsonb), '{lead_id}', ?::jsonb, true)"
                      + `, '{lead_prior_state}', ${priorExpr}, true)`
                      + `, '{lead_written_state}', ${writtenExpr}, true)`
                      + `, '{lead_stamp_seq}', ${seqExpr}, true)`
                      + ", '{lead_link_via}', ?::jsonb, true)) - 'attribution_former_lead_id'",
                      [
                        JSON.stringify(String(leadId)),
                        String(leadId), JSON.stringify(prior), JSON.stringify(prior),
                        String(leadId), JSON.stringify(written), JSON.stringify(written),
                        String(leadId), nextSeq, nextSeq,
                        JSON.stringify(deriveStampLinkAuthority({
                          phone,
                          existingLeadVia,
                          priorStampedLeadVia,
                          lockedLeadPhone: lockedLead?.phone,
                          writesPhone: Object.prototype.hasOwnProperty.call(effectiveUpdates, 'phone')
                            && String(effectiveUpdates.phone || '') === String(phone),
                        })),
                      ],
                    ),
                    updated_at: new Date(),
                  });
                if (!stamped) {
                  const lost = new Error('processing claim lost during call→lead link stamp');
                  lost.abortProcessing = true;
                  throw lost;
                }
                // The moved linkage just COMMITTED (stamp written in this
                // transaction) — now the funnel row this call created on
                // the previously stamped lead follows it, stages intact
                // (pre-push P0/P1 r8/r9). Same transaction, same lead lock.
                if (preSettleStampedLeadId && String(preSettleStampedLeadId) !== String(leadId)) {
                  // Outcome captured (codex P1, PR #3303 r4): a
                  // retired_conflict means the target lead owns a row this
                  // call cannot prove is its own, and the later
                  // attribution pass must not touch it. The shared
                  // unprovenanced-row freeze in recordCallPpcAttribution
                  // is the backstop; suppressing the pass here avoids the
                  // wasted round-trip and keeps intent explicit.
                  const moveOutcome = await require('./ads/call-attribution').reconcileMovedCallAttributionRow(
                    trx, call.id, preSettleStampedLeadId, leadId, new Date(),
                  );
                  if (moveOutcome === 'retired_conflict') attributionConflictRetired = true;
                  // A LEGACY row on the former lead cannot move (codex P1,
                  // PR #3303 r11 — the bridge path already suppresses this
                  // shape): NULL provenance is permanently frozen because
                  // another call may own it, so the transfer reports
                  // 'none' with the old row still in place. Letting this
                  // pass insert a provenanced row for the new lead would
                  // count the same call on BOTH leads — the row cannot be
                  // discovered by call id, so nothing would ever reconcile
                  // them. Suppress the write and name both for an operator.
                  if (moveOutcome === 'none') {
                    const stranded = await trx('ad_service_attribution')
                      .where({ lead_id: preSettleStampedLeadId })
                      .whereNull('source_call_id')
                      .first('id');
                    if (stranded) {
                      attributionConflictRetired = true;
                      // The suppressed write stays in a RETRY LANE (codex
                      // P1 r12): the call finalizes as 'processed' and —
                      // unlike a bridge-target call, which the daily bridge
                      // scan keeps re-detecting — nothing ever rescans a
                      // dedicated/organic call, so once the operator
                      // resolved the legacy row the new lead stayed
                      // unattributed forever. Persist a durable marker
                      // carrying the CALL-TIME funnel decision (source /
                      // paid / detail / service) in the SAME fenced
                      // transaction as the stamp; the daily attribution
                      // sweep (sweepPendingAttributionTransfers) completes
                      // the write against the LIVE stamped lead once the
                      // blocking row is gone. Gated on the exact predicate
                      // the suppressed write ran under — a non-attributing
                      // source or bridge target would never have written,
                      // so it gets no marker.
                      const attrMod = require('./ads/call-attribution');
                      const markerAttr = leadSourceRow
                        ? attrMod.attributionForSourceType(leadSourceRow.source_type)
                        : null;
                      const markerBridgeTarget = leadSourceRow
                        && require('./ads/google-call-bridge').isBridgeTargetNumber(leadSourceRow.twilio_phone_number);
                      if (customerId && markerAttr && !markerBridgeTarget) {
                        await trx('call_log')
                          .where({ id: call.id })
                          .where('processing_token', procToken)
                          .update({
                            metadata: db.raw(
                              "jsonb_set(COALESCE(metadata, '{}'::jsonb), '{attribution_transfer_pending}', ?::jsonb, true)",
                              [JSON.stringify({
                                from_lead_id: String(preSettleStampedLeadId),
                                lead_source: markerAttr.leadSource,
                                is_paid: markerAttr.isPaid,
                                detail: leadSourceRow.name || 'inbound call',
                                service_interest: extracted.matched_service || extracted.requested_service || null,
                              })],
                            ),
                            updated_at: new Date(),
                          });
                      }
                      logger.warn(`[call-proc] repoint of ${callSid} left a legacy unprovenanced row on lead ${preSettleStampedLeadId} — funnel write suppressed to avoid double-counting`);
                    }
                  }
                }
                return enrichmentWrite.transacting(trx).update(effectiveUpdates);
              });
              if (phoneReuseRevokedUnderLock) {
                // The locked row no longer satisfies the phone arm's
                // selecting predicates — nothing was stamped or enriched.
                // Drop the association (Needs Review lane); the maintenance
                // block settles any prior stamp via its lead-less branch.
                logger.warn(`[call-proc] phone-reused lead ${leadId} no longer matches the selecting predicates under lock — dropping the association for ${maskSid(callSid)}`);
                leadId = null;
                sameCallOwnershipRejected = true;
              } else {
                currentStampedLeadId = String(leadId);
              }
            } else {
              enriched = await enrichmentWrite.update(leadUpdates);
            }
            // A same-call row is excluded from the remint below because a
            // claim between lookup and write usually means an admin linked
            // OUR OWN row — still this call's lead, so enrichment is simply
            // skipped. That reasoning fails when the row was assigned to a
            // DIFFERENT customer: keeping leadId would pair this call's PPC
            // attribution, triage activity and notifications with a foreign
            // lead (codex P2). Re-read the owner on a 0-row same-call write
            // and drop the association when it is not ours; downstream skips
            // cleanly on a null leadId, and sameCallOwnershipRejected drives
            // the Needs Review card below — workableUnnamedLead cannot,
            // because it is false whenever customerId exists, so the
            // customer-attached rejection would otherwise finish silently as
            // 'processed' with no lead and no card (codex P2).
            if (!enriched && sameCallLeadReuse && leadId) {
              // Re-run the SAME eligibility against the row rather than
              // comparing one column: a 0-row write means it failed SOME
              // predicate, and which one does not change the decision. An
              // ineligible row — claimed by another customer, soft-deleted,
              // closed or converted — is no longer this call's lead.
              let stillEligible = null;
              let verified = true;
              try {
                stillEligible = await applySameCallLeadEligibility(
                  db('leads').where({ id: leadId }), sameCallWriteEligibility,
                ).first('id');
              } catch (eligErr) {
                // FAIL CLOSED (codex P2): swallowing this and keeping leadId
                // left attribution, voicemail/dropped-call actions and
                // booking consumers pointing at the very row the guarded
                // write just refused.
                verified = false;
                logger.warn(`[call-proc] same-call eligibility re-read failed: ${eligErr.code || eligErr.name || 'db_error'}`);
              }
              if (!verified || !stillEligible) {
                logger.warn(`[call-proc] same-call lead ${leadId} ${verified ? 'is no longer eligible' : 'eligibility unverifiable'} — dropping the association for ${maskSid(callSid)}`);
                leadId = null;
                sameCallOwnershipRejected = true;
              }
            }
            if (!enriched && !sameCallLeadReuse && phone && existingLead && !raceRecovered
              && leadId && currentStampedLeadId === String(leadId)) {
              // Stamped phone-bearing reuse whose guarded write landed 0
              // rows: beyond the row id, the plain phone write carries only
              // the customer-ownership backstop, so 0 rows means the lead
              // was claimed by a DIFFERENT customer between lookup and
              // write (or the row vanished). Before the root fix this pass
              // finalized with leadId still pointing at the foreign row —
              // now that the stamp is durable state it must not survive
              // pointing there either. Re-check the write's own predicate
              // and drop the association when it no longer holds; the
              // maintenance block below then settles the stamp via its
              // lead-less branch and the Needs Review card surfaces the
              // call. Fail closed on an unverifiable re-read, same doctrine
              // as the same-call check above. Eligibility here is the PHONE
              // path's own, NOT applySameCallLeadEligibility — a
              // customer-less phone caller may legitimately reuse a claimed
              // lead (phone is strong identity), so only the ownership
              // backstop the write itself ran under applies.
              let stillOurs = null;
              let verified = true;
              try {
                let recheck = db('leads').where({ id: leadId });
                if (customerId) {
                  recheck = recheck.where((q) => q.whereNull('customer_id').orWhere('customer_id', customerId));
                }
                stillOurs = await recheck.first('id');
              } catch (eligErr) {
                verified = false;
                logger.warn(`[call-proc] phone-reuse ownership re-read failed: ${eligErr.code || eligErr.name || 'db_error'}`);
              }
              if (!verified || !stillOurs) {
                logger.warn(`[call-proc] phone-reused lead ${leadId} ${verified ? 'was claimed by another customer' : 'ownership unverifiable'} — dropping the association for ${maskSid(callSid)}`);
                leadId = null;
                sameCallOwnershipRejected = true;
              }
            }
            if (!enriched && existingLead && !sameCallLeadReuse && !phone && !raceRecovered) {
              // sameCallLeadReuse is EXCLUDED from the remint (codex P2
              // r16): a same-call row claimed between the lookup and the
              // anonymous unclaimed backstop is still THIS call's lead —
              // keep its id and skip enrichment, exactly like a fresh
              // insert claimed during its first attempt. Reminting here
              // inserted and notified a duplicate for the identical call.
              // Recovery is for REUSED email-matched candidates only (hence
              // the existingLead gate): a 0-row write on a lead THIS call
              // just inserted means an admin legitimately claimed our own
              // fresh row mid-flight — it is still this call's lead, so the
              // enrichment is simply skipped, never re-minted and re-notified
              // as a duplicate (pre-push audit P1 r6). Customer-attached
              // phone-less reuse recovers here too now that its write also
              // carries the full email/name eligibility (audit P1 r9) — its
              // mint keeps the customer link.
              // The email-matched lead was claimed or corrected between
              // lookup and the guarded write (0 rows). leadId must not keep
              // pointing at a lead that is no longer this caller's —
              // downstream writers (triage activity, text-back, follow-ups)
              // would target the foreign row. Mint the fresh lead this caller
              // would have gotten on a lookup miss — a MINIMAL identity row
              // mirroring the normal fresh insert — then loop back and re-run the same
              // enrichment pass against it, so the recovered lead keeps every
              // current-call field (service_interest, quote markers, the
              // follow-up deadline) and its qualification/completeness are
              // judged on THIS call's extraction alone, never the foreign
              // candidate's (codex P1 r3 + pre-push audit P1 r5). On mint
              // failure, drop leadId so downstream skips cleanly.
              try {
                const [raceFresh] = await db('leads').insert({
                  lead_source_id: leadSourceId,
                  customer_id: customerId || null,
                  phone: null,
                  first_name: capitalizeName(extracted.first_name) || null,
                  last_name: capitalizeName(extracted.last_name) || null,
                  email: extracted.email || null,
                  address: extracted.address_line1 || null,
                  city: extracted.city || null,
                  zip: extracted.zip || null,
                  lead_type: extracted.is_voicemail ? 'voicemail' : 'inbound_call',
                  first_contact_at: new Date(),
                  first_contact_channel: 'call',
                  twilio_call_sid: call.twilio_call_sid,
                  call_duration_seconds: call.duration_seconds,
                  call_recording_url: call.recording_url,
                  status: 'new',
                }).returning('*');
                logger.warn(`[call-proc] email-matched lead ${leadId} lost the claim race — minted fresh lead ${raceFresh.id}`);
                leadId = raceFresh.id;
                current = raceFresh;
                raceRecovered = true;
                // A race-recovery mint IS a new lead — surface it exactly like
                // a fresh insert (codex P2 r5: the reuse path never runs the
                // new-lead notification, and the phone-less SMS rail fails
                // closed, so this lead otherwise landed with no bell or push).
                // notifyNewCallLead never throws, so a notify failure cannot
                // be mistaken for a mint failure by the catch below.
                await notifyNewCallLead({ leadId, phone: null, extracted, leadSourceId, leadSourceRow, call });
                // The dropped-call suppression above was judged against the
                // REPLACED candidate's on-file address; the recovery row
                // carries only this call's extraction, which the detector
                // already found address-less. Revive detection here — inside
                // the loop — so the pass-2 extracted_data, the triage note,
                // and the phase-2 card/text all see it (codex P2 r8). The
                // pre-existing-customer suppression still stands and is
                // re-checked (the read never throws — a throw here would be
                // misread as a mint failure).
                if (droppedDetectorFired && !droppedMidIntake) {
                  let reviveDropped = true;
                  if (customerId && !createdCustomerFromCall) {
                    const custAddr = await db('customers').where({ id: customerId })
                      .first('address_line1').catch(() => null);
                    if (String(custAddr?.address_line1 || '').trim()) reviveDropped = false;
                  }
                  if (reviveDropped) {
                    droppedMidIntake = true;
                    if (!bridgeNeedsConfirmation.includes('call_dropped_mid_intake')) {
                      bridgeNeedsConfirmation.push('call_dropped_mid_intake');
                    }
                  }
                }
                continue;
              } catch (raceErr) {
                // Sanitized code only — a Postgres/Knex error message can
                // echo the failing row's values, and this insert carries the
                // caller's name/email/address (codex P1 r12).
                logger.warn(`[call-proc] fresh-lead mint after claim race failed for ${maskSid(callSid)}: ${raceErr.code || raceErr.name || 'db_error'}`);
                leadId = null;
              }
            }
            // If the recovery pass ALSO wrote 0 rows (the just-minted row
            // was claimed before this write landed), leadId is deliberately
            // KEPT: the minted row persisted and IS this call's lead — the
            // same reasoning as a claim on a fresh insert above. Nulling it
            // marked the call lead_creation_failed and opened a false
            // failure card even though the lead exists (codex P2 r13);
            // enrichment simply skips via enriched=0.
            break;
          }

          // Set when the maintenance settle below TRANSFERRED this call's
          // linkage off a live stamp — the former lead may still hold a
          // legacy (NULL-provenance) row this call cannot move, and the
          // breadcrumb-consumption block after the settle owns that check
          // (codex P1 r18).
          let maintenanceFormerLeadId = null;
          // Call→lead linkage maintenance for every stamped linkage
          // (phone-less always; phone-bearing whenever a stamp is or was
          // in play — a stamp-less phone-bearing fresh insert self-links
          // via its sid and needs nothing here), WITHOUT
          // rolling the lead's twilio_call_sid (rolling it destroyed the
          // older call's identity — audit P1 r16): a reused lead keeps its
          // ORIGINAL call's sid, so this call's association lives in
          // call_log.metadata.lead_id (codex P1 r15; same jsonb pattern as
          // created_customer_id). The stamp is REQUIRED state, not
          // best-effort — it is the only linkage admin history, agent
          // context, and estimator grounding have for this call, and a stale
          // stamp from an earlier attempt that reused a DIFFERENT lead
          // double-associates the call under the OR-join consumers (codex
          // P1 r19 ×2). Writes are fenced on the processing token; a lost
          // fence or write failure aborts into the extraction_failed retry
          // path via abortProcessing (the lead-section catch rethrows it).
          if (!phone || currentStampedLeadId) {
            const finalLeadCarriesSid = raceRecovered || !existingLead
              || (!!call.twilio_call_sid && existingLead.twilio_call_sid === call.twilio_call_sid);
            // Clearing a stamp ALSO restores that lead's prior state via the
            // per-field compare-and-swap — one transaction, fenced (audit P1
            // r18/r19/r20). Fence-lost maps to the same abortProcessing the
            // direct writes use. The STAMP itself is written in-loop,
            // atomically with the enrichment write — maintenance only ever
            // clears.
            const settleClear = async (attribution) => {
              let ok;
              try {
                ok = await clearStampAndRestoreLead(call, procToken, callSid, null, attribution);
              } catch (clearErr) {
                if (clearErr.abortProcessing) throw clearErr;
                const wrapped = new Error(`call→lead link clear failed: ${clearErr.code || clearErr.name || 'db_error'}`);
                wrapped.abortProcessing = true;
                throw wrapped;
              }
              if (!ok) {
                const lost = new Error('processing claim lost during call→lead link clear');
                lost.abortProcessing = true;
                throw lost;
              }
            };
            if (!leadId) {
              // Mint failure dropped the lead — a leftover stamp would leave
              // the OR-join consumers associating this call with a lead that
              // is now foreign (it lost the claim race). Unlink the stamp,
              // but 'keep' the funnel row (codex P1, PR #3303 r3): a mint
              // failure is transient, not a verdict — the call can
              // finalize lead_creation_failed (outside the automatic retry
              // lane) and a retire here would permanently delete
              // booked/completed history with no definitive rejection.
              // When a later pass re-attributes, provenance recovery moves
              // the row. preserveFormerLeadId (pre-push P1 r18): the
              // lead_creation_failed retry restamps with no
              // preSettleStampedLeadId — the breadcrumb keeps the former
              // lead recoverable for the legacy-blocker check.
              if (currentStampedLeadId) await settleClear({ mode: 'keep', preserveFormerLeadId: true });
            } else if (finalLeadCarriesSid) {
              // The final lead is linked by its own sid — a leftover stamp
              // pointing at a different lead must not survive. The call's
              // linkage MOVED: its funnel row transfers to the final lead,
              // stages intact (codex P0, PR #3303).
              if (currentStampedLeadId && currentStampedLeadId !== String(leadId)) {
                await settleClear({ mode: 'transfer', transferToLeadId: leadId });
                maintenanceFormerLeadId = currentStampedLeadId;
              }
            } else if (phone) {
              // Phone-bearing final lead not carrying this call's sid.
              // Since the root fix the in-loop stamp transaction already
              // settled-and-restamped this case (stamp == leadId here), so
              // this branch is a BACKSTOP for passes that reached
              // maintenance without stamping: a stale stamp pointing at a
              // different lead must not survive (audit P1 r22); a stamp
              // already pointing at this lead stays accurate. The funnel row
              // follows the moved linkage.
              if (currentStampedLeadId && currentStampedLeadId !== String(leadId)) {
                await settleClear({ mode: 'transfer', transferToLeadId: leadId });
                maintenanceFormerLeadId = currentStampedLeadId;
              }
            }
            leadLinkagePending = false;
          }

          // Former-lead linkage reconciliation for EVERY successful
          // replacement linkage, not only stamped ones (codex P1 r18): a
          // standalone keep-settle persisted attribution_former_lead_id,
          // and only the in-loop stamp path consumed it — a retry that
          // GAINED a phone (or selected a sid-linked lead) settles
          // stamp-less, skipped the former lead's legacy-blocker check and
          // the pending-transfer marker, and runCallPpcAttribution then
          // inserted a SECOND row for the new lead while the former lead's
          // unresolved row stood. Also runs after a live-stamp maintenance
          // TRANSFER, whose reconcile outcome clearStampAndRestoreLead
          // cannot surface: a 'none' there with a stranded legacy row is
          // the same double-count. Idempotent — a breadcrumb the stamp
          // transaction already consumed reads back cleared under the lock
          // and the block no-ops. Gated on a SUCCESSFUL linkage (leadId):
          // a lead-less exit keeps the breadcrumb for the next retry, by
          // design. Cheap pre-check on claim-time metadata only decides
          // whether to open the transaction; the authoritative breadcrumb
          // is re-read fenced under the lock.
          const claimTimeBreadcrumb = (() => {
            try {
              const cmd = typeof call.metadata === 'string' ? JSON.parse(call.metadata) : (call.metadata || {});
              return cmd.attribution_former_lead_id ? String(cmd.attribution_former_lead_id) : null;
            } catch { return null; }
          })();
          if (leadId && (maintenanceFormerLeadId || claimTimeBreadcrumb)) {
            try {
              const recon = await reconcileFormerLeadLinkage({
                call,
                procToken,
                callSid,
                leadId,
                transferredFormerLeadId: maintenanceFormerLeadId,
                leadSourceRow,
                extracted,
                customerId,
              });
              if (recon.conflictRetired) attributionConflictRetired = true;
            } catch (reconErr) {
              if (reconErr.abortProcessing) throw reconErr;
              // REQUIRED reconciliation — swallowing this would finalize
              // the call with an unconsumed breadcrumb AND fire the funnel
              // write, the exact double-count this block closes. Same
              // retry lane as the settle failures above.
              const wrapped = new Error(`former-lead linkage reconciliation failed: ${reconErr.code || reconErr.name || 'db_error'}`);
              wrapped.abortProcessing = true;
              throw wrapped;
            }
          }

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
          if (callQuotePromised && enriched
            && !(await quotePromisedAlreadyNotified(call.twilio_call_sid, { ignoreNoLead: true }))) {
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
        // Runs AFTER the enrichment/claim-race block above so the funnel row
        // targets the FINAL leadId — attribution kicked off before recovery
        // could land on a lead the race rejected, leaving the replacement
        // lead unattributed and reporting pointing at the wrong row
        // (codex P1 r11). AWAITED, not fire-and-forget (codex P2): a call
        // that books during this same run reaches
        // convertCallLeadOnPhoneBooking → bridgeLeadFunnelStage, which only
        // UPDATES an existing ad_service_attribution row. If the insert were
        // still in flight the bridge would update zero rows and the row
        // would then land at funnel_stage 'lead', reporting a booked lead at
        // the initial stage until some future transition. The write is a
        // single insert whose own failure is already swallowed, so awaiting
        // it cannot throw or meaningfully delay processing. The body lives
        // in runCallPpcAttribution (assigned near the lead_source lookup) so
        // the section catch can fire it too.
        await runCallPpcAttribution();

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

        // Dropped-call detector, phase 2 of 2: the gated one-shot text (all
        // send-side gates — feature gate, quiet hours, one-per-phone claim,
        // landline, STOP suppression, template kill switch — live in the
        // service) and the always-on review card. Runs after the enrichment
        // write so the module's extracted_data claim stamp survives.
        if (droppedMidIntake && leadId) {
          try {
            const DroppedCallSms = require('./dropped-call-sms');
            // Card evidence must say WHY there is no text: a caller who asked
            // on the call not to be contacted renders as do-not-contact, not
            // "call them back" (codex P1).
            let smsOutcome = v2Result?.extraction?.consent?.do_not_contact_request === true
              ? { sent: false, skipped: 'policy_block', code: 'DNC_REQUESTED_ON_CALL' }
              : { sent: false, skipped: 'not_eligible' };
            // A customer record created FROM THIS CALL is still a new
            // prospect (Step 3 mints one for any named live caller);
            // classification fails CLOSED to card-only.
            const genuineNewProspect = DroppedCallSms.eligibleNewProspect({
              customerId,
              createdCustomerFromCall,
              isOutbound: isOutboundCall(call),
              v2Status: v2Result?.status,
              callNature: v2Result?.extraction?.call_nature,
              doNotContactRequested: v2Result?.extraction?.consent?.do_not_contact_request === true,
            });
            // TCPA: implied consent is PERSONAL to the inbound ANI. The
            // resolved contact phone can be a DICTATED callback number —
            // possibly someone else's handset — and must never receive the
            // automated text (codex P1). No usable external ANI → card-only.
            const smsAni = firstExternalPhone(call.from_phone);
            if (genuineNewProspect && !smsAni) {
              smsOutcome = { sent: false, skipped: 'no_usable_ani' };
            } else if (genuineNewProspect) {
              // Inner catch: the review card below MUST still open when the
              // send path throws — a failed text plus no card is exactly the
              // silent-cold-lead outcome this lane prevents.
              try {
                smsOutcome = await DroppedCallSms.sendDroppedCallAddressRequest({
                  leadId, extracted, call, phone: smsAni, expectedCustomerId: customerId || null,
                });
              } catch (sendErr) {
                logger.warn(`[call-proc] dropped-call text failed (card still opens): ${sendErr.message}`);
                smsOutcome = { sent: false, skipped: 'send_error' };
              }
            }
            await db('triage_items')
              .insert(buildTriageItem({
                callLogId: call.id,
                flag: 'call_dropped_mid_intake',
                extraction: v2Result?.status === 'valid' ? v2Result.extraction : null,
                extraPayload: {
                  // The ANI the text went to (never a dictated callback
                  // number) — the bounce handler's legacy fallback and the
                  // office both need the number that was actually texted.
                  caller_phone: smsAni || phone || null,
                  dropped_after_seconds: droppedCallSeconds || null,
                  address_request_sms: smsOutcome.sent ? 'sent' : (smsOutcome.skipped || 'not_sent'),
                  ...(smsOutcome.code ? { address_request_sms_code: smsOutcome.code } : {}),
                },
              }))
              .onConflict(db.raw('(call_log_id, reason_code) WHERE status IN (\'open\', \'in_progress\')'))
              .ignore();
            // Reprocess refresh: the insert above no-ops when an open card
            // already exists (first run: gate off / quiet hours / transient
            // block with released claims). A successful send on THIS run
            // must update that stale card or it keeps saying "not sent —
            // call them back" after the text went out (codex P2).
            if (smsOutcome.sent) {
              await db('triage_items')
                .where({ call_log_id: call.id, reason_code: 'call_dropped_mid_intake' })
                .whereIn('status', ['open', 'in_progress'])
                .update({
                  payload: db.raw("COALESCE(payload, '{}'::jsonb) || jsonb_build_object('address_request_sms', 'sent') - 'address_request_sms_code'"),
                  updated_at: new Date(),
                })
                .catch((e) => logger.warn(`[call-proc] dropped-call card sent-refresh failed: ${e.code || e.name || 'db_error'}`));
            }
            // A delivery bounce can race this insert (callback lands between
            // the awaited send and here — its card flip found no row). The
            // claim outcome is the bounce handler's authority: reconcile the
            // fresh card so it never permanently says 'sent' for a text that
            // already bounced.
            // Reconcile terminal bounce outcomes for a FRESH send AND for a
            // rebuilt card whose original text already went out (reprocess
            // path returns already_sent_to_phone) — a 21610 that landed
            // while the first card insert was lost must reach the rebuilt
            // card too (codex P1).
            const bounceVerdict = (smsOutcome.sent || smsOutcome.skipped === 'already_sent_to_phone')
              ? await DroppedCallSms.terminalBounceOutcome(smsAni || phone) : null;
            // An opt-out is PHONE-level truth and applies to any card for
            // this number; 'undelivered' is call-specific — an old call's
            // bounce must not stamp a NEW call's card (codex P2).
            // A START reply clears the canonical suppression and re-enables
            // SMS — an opted_out claim is then STALE and must not stamp DNC
            // onto new cards (codex P2). Verify against the live store.
            let optOutStillActive = false;
            if (bounceVerdict?.outcome === 'opted_out') {
              optOutStillActive = !!(await db('messaging_suppression')
                .where({ phone: smsAni || phone, active: true })
                .first('id')
                .catch(() => null));
            }
            const bounceOutcome = bounceVerdict
              && ((bounceVerdict.outcome === 'opted_out' && optOutStillActive)
                || (bounceVerdict.outcome === 'undelivered'
                  && (!bounceVerdict.callLogId || String(bounceVerdict.callLogId) === String(call.id))))
              ? bounceVerdict.outcome : null;
            if (bounceOutcome) {
              await db('triage_items')
                .where({ call_log_id: call.id, reason_code: 'call_dropped_mid_intake' })
                .whereIn('status', ['open', 'in_progress'])
                .update({
                  payload: bounceOutcome === 'opted_out'
                    ? db.raw("COALESCE(payload, '{}'::jsonb) || jsonb_build_object('address_request_sms', 'undelivered', 'address_request_sms_code', 'SUPPRESSED_PROVIDER_OPT_OUT_21610')")
                    : db.raw("COALESCE(payload, '{}'::jsonb) || jsonb_build_object('address_request_sms', 'undelivered')"),
                  updated_at: new Date(),
                })
                .catch((e) => logger.warn(`[call-proc] dropped-call card bounce reconcile failed: ${e.code || e.name || 'db_error'}`));
            }
            logger.info(`[call-proc] Dropped call mid-intake for ${maskSid(callSid)} — review card opened (sms: ${smsOutcome.sent ? 'sent' : smsOutcome.skipped || 'skipped'})`);
          } catch (dropErr) {
            logger.warn(`[call-proc] dropped-call card/text failed (non-blocking): ${dropErr.message}`);
          }
        }

      } catch (leadErr) {
        // Required-linkage failures must reach the outer extraction_failed
        // guard — swallowing them finalized the call with its only
        // call→lead association missing or stale (codex P1 r19). The
        // pending flag catches the same failure ARRIVING EARLIER: any throw
        // between the reuse decision and the maintenance block would
        // otherwise finalize with unsettled linkage (audit P1 r21).
        if (leadErr.abortProcessing) throw leadErr;
        if (leadLinkagePending) {
          // Sanitized cause only — enrichment DB errors can echo the failing
          // row's name/email/address, and the outer catch logs this message
          // with its stack (codex P1 r15b).
          const unsettled = new Error(`call exited with unsettled lead linkage: ${leadErr.code || leadErr.name || 'error'}`);
          unsettled.abortProcessing = true;
          throw unsettled;
        }
        // This catch FINALIZES the call (non-blocking) — fire the funnel
        // attribution before doing so, or a transient enrichment error
        // permanently drops a tracked customer-attached call from
        // paid/organic reporting: the lead already exists, so the run still
        // completes as `processed` and nothing retries it (codex P2).
        // leadId holds the final selection made before the throw, and
        // recordCallPpcAttribution dedupes by lead + first-touch, so a
        // double fire is harmless.
        await runCallPpcAttribution();
        logger.error(`[call-proc] Lead creation failed (non-blocking): ${leadErr.message}`);
      }
    } else {
      // Lead creation skipped. THREE very different reasons live here
      // (pre-push P0 r14, narrowed P0 r8):
      //   - DEFINITIVE content rejection (wrong_number call_type, or the
      //     V2 spam/wrong-number flag): the call was never a prospect at
      //     all — prior attribution is fraudulent, so it retires at
      //     finalization, armed REGARDLESS of stamp presence (a
      //     sid-linked call has a provenanced row but no stamp; P1 r13),
      //     deferred to the final fenced status write where the verdict
      //     becomes durable (P0 r12).
      //   - ORDINARY non-sales classification (existing-customer
      //     scheduling/service, billing, complaint, a bare
      //     is_lead=false): no NEW lead is created, but a force-reprocess
      //     of a valid historical call must NEVER delete the original
      //     inquiry's booked/completed revenue because the model now
      //     files the transcript under service chatter. Stamp, lead, and
      //     funnel row all stand — mirrors the V2 veto's own
      //     definitive-rejection gate.
      //   - LIFECYCLE skip (the caller's prospect record has since
      //     advanced to won/active_customer): the ORIGINAL inquiry and its
      //     booked/completed revenue are still perfectly valid.
      const definitiveContentRejection = nonLeadCall
        && (v2VetoDefinitiveRejection
          || String(extracted?.call_type || '').trim().toLowerCase() === 'wrong_number');
      if (definitiveContentRejection) deferredNonLeadAttributionRetire = true;
      // The stamp settle is gated the SAME way (pre-push P0 r15/r8): a
      // cleared stamp reads to the bridge's repoint reconciliation as a
      // settled unlink, which would retire the exact funnel row the
      // retire-gate above just preserved — so only a definitive rejection
      // clears it. Lifecycle skips and ordinary non-sales classifications
      // leave the stamp, the lead's state, and the funnel row standing.
      if (definitiveContentRejection && priorStampedLeadId) {
      // The retry was VETOED out of lead creation but an earlier attempt
      // stamped a lead — the stamp must not survive a non-lead verdict,
      // and the lead's prior summary comes back with the clear, in one
      // fenced transaction (audit P1 r22/r18/r19). abortProcessing
      // reaches the outer extraction_failed guard directly. 'keep': the
      // retire rides finalization, not this settle (pre-push P0 r12).
      try {
        // preserveFormerLeadId (pre-push P1 r18, same class as the
        // pre-stamp settle): this standalone clear commits long before
        // the fenced final verdict — if later work fails, the retry
        // would claim an extraction_failed call with neither stamp nor
        // breadcrumb, and a subsequent VALID retry repointing to a new
        // lead would skip the legacy-blocker check and double-count.
        const settled = await clearStampAndRestoreLead(call, procToken, callSid, null, { mode: 'keep', preserveFormerLeadId: true });
        if (!settled) {
          const lost = new Error('processing claim lost during call→lead link clear (non-lead path)');
          lost.abortProcessing = true;
          throw lost;
        }
      } catch (clearErr) {
        if (clearErr.abortProcessing) throw clearErr;
        const wrapped = new Error(`call→lead link clear failed (non-lead path): ${clearErr.code || clearErr.name || 'db_error'}`);
        wrapped.abortProcessing = true;
        throw wrapped;
      }
      }
    }

    // Quote promised but NO lead artifact — an established customer past the
    // lead pipeline stages (or any other shouldCreateLead veto) can still be
    // promised a post-call quote while booking or discussing service. The
    // lead-path notification above never fires for them, so the promise would
    // live only in the recording — the exact failure mode this notification
    // exists to prevent. Surface it at the customer level instead.
    if (callQuotePromised && !leadId && !extracted.is_spam
      && !(await quotePromisedAlreadyNotified(call.twilio_call_sid))) {
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

    // Estimator engine (GATE_ESTIMATOR_ENGINE, default OFF): quote-flavored
    // calls get a priced DRAFT estimate composed from the transcript + SMS
    // thread + profile + arbitrated property data. The generic quote-promised
    // bell above already rang synchronously (the DURABLE owed-quote record);
    // the engine upgrades that bell in place with the draft when it finishes.
    // Non-blocking by contract — a drafting failure must never break call
    // processing or eat the promise. The settled chain is retained so the
    // assessment pre-draft hook below can sequence AFTER it (never a second
    // concurrent composer run for the same call).
    let estimatorEnginePromise = null;
    let reconcileOnlyDraftLinksPending = false;
    if (estimatorEngineOn() && !extracted.is_spam
      && (callQuotePromised || callQuoteRequested)) {
      // Fire-and-forget: the DEEP composer + property pipeline can take
      // minutes, and the scheduling/confirmation work below must not wait on
      // a drafting pass. The engine's own dedupe guards make re-entry safe
      // and it degrades to the fallback notification on any failure.
      const { maybeDraftEstimateForCall } = require('./estimator-engine');
      estimatorEnginePromise = maybeDraftEstimateForCall({
        callLogId: call.id,
        quotePromised: callQuotePromised === true,
        // THIS pass owns the claim while the engine composes — the
        // creator's linkage fence must not read our own token as a
        // competing reprocess (codex P1, PR #3304 GH r8e). The generation
        // is the pass identity that SURVIVES finalization: the detached
        // composer routinely finishes after the token clears, and its
        // late writes are legitimate exactly while no newer pass has
        // claimed the call since (same generation).
        ownerProcToken: procToken,
        ownerProcGeneration: procGeneration,
      })
        .then((engineOutcome) => {
          logger.info(`[call-proc] estimator engine lane=${engineOutcome.lane} created=${engineOutcome.created} for ${callSid}`);
        })
        .catch(async (engineErr) => {
          logger.error(`[call-proc] estimator engine failed (non-blocking): ${engineErr.message}`);
          // A failed identity QUARANTINE must not vanish with this
          // fire-and-forget catch (codex P0, PR #3304 GH r8d): the call
          // finalizes as processed and is not eligible for another
          // automatic pass, so the unmarked draft would stay public and
          // sendable after a transient outage. Stamp the DURABLE retry
          // queue the scheduler drains.
          if (engineErr.quarantineFailed) {
            const { markQuarantinePending } = require('./estimator-engine');
            const queued = await markQuarantinePending(call.id, 'email_identity_conflict', { procGeneration });
            if (!queued) {
              // Neither the estimate markers NOR the durable queue landed
              // (codex P0, PR #3304 GH r8h) — the unmarked draft would stay
              // public and sendable with nothing scheduled. Push the call
              // into the retry lane so the whole pass runs again; the
              // estimator re-quarantines from a clean slate.
              try {
                let lastResortQ = db('call_log').where({ id: call.id })
                  .whereNull('processing_token');
                // Generation-fenced (pre-push P1, PR #3304): this detached
                // handler can fire after a NEWER pass claimed and finalized
                // — overwriting its settled status with extraction_failed
                // would recreate the exact NULL-token ambiguity the
                // generation counter closes. Same generation = still ours.
                if (procGeneration != null) {
                  lastResortQ = lastResortQ.where('processing_generation', procGeneration);
                }
                const pushed = await lastResortQ.update({
                  processing_status: 'extraction_failed',
                  updated_at: new Date(),
                });
                if (pushed) {
                  logger.error(`[call-proc] quarantine queue write failed for ${callSid} — call pushed to the retry lane`);
                } else {
                  logger.info(`[call-proc] quarantine retry-lane write skipped for ${callSid} — a newer pass owns the call`);
                }
              } catch (lastResortErr) {
                logger.error(`[call-proc] quarantine retry-lane write ALSO failed for ${callSid}: ${lastResortErr.message}`);
              }
            }
          }
        });
    } else {
      // Reconcile-only pass (codex P1, PR #3304 GH r6): even when this run
      // is not an eligible drafting run — gate off, retry no longer
      // quote-flavored, spam-classified — a linkage correction must still
      // invalidate any existing draft for this call, or the stale draft
      // keeps its old lead links and a live public token indefinitely.
      // It runs AFTER the token-fenced finalization (codex P0 GH r7b):
      // this pass still holds processing_token here, and the fallback
      // linkage context deliberately refuses a call with a live token, so
      // firing now would silently no-op on exactly the transient-context
      // case it exists for. See the post-finalization hook below.
      reconcileOnlyDraftLinksPending = true;
    }

    // A customer-less recovery lead is the ONLY durable record for this call, so
    // a swallowed insert failure must not read as a clean 'processed'. Mark it
    // failed, open review_status, AND write a triage_items row — the Needs Review
    // inbox (admin-triage) is driven by triage_items, not review_status alone, so
    // without this the failed recovery call would never surface for a human.
    // sameCallOwnershipRejected joins the condition (codex P2): a
    // customer-ATTACHED retry whose sid row was claimed by another customer
    // has its association dropped above, but workableUnnamedLead is false
    // whenever customerId exists — so without this the call finished as a
    // clean 'processed' with no lead and nothing for a human to look at.
    // Same flag and lane: the lead this call needed is not available.
    if ((workableUnnamedLead || sameCallOwnershipRejected) && !leadId) {
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
        // The PRECISE catalog pick outranks flatView's coarse category map —
        // overwriting with the coarse label here undid the adoption layer's
        // precise label and mislabeled CSR-facing subjects/metadata (e.g.
        // 'Wildlife Exclusion' → 'Rodent Control'; codex #2972 r10 P2).
        extracted.matched_service = v2Flat.specific_service_name || v2Flat.matched_service;
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
      // The V2 merge can restore a singular service — specific_service_name
      // outranks matched_service in catalog booking, and the V2 prompt does
      // not carry the recurring-interest rule (adding it would re-version the
      // shadow prompt mid-promotion-cohort). Re-assert the owner rule over
      // the merged fields; no-op when nothing singular survived.
      const preReassertMatched = extracted.matched_service;
      const preReassertSpecific = extracted.specific_service_name;
      if (!isOutboundCall(call)) extracted = applyRecurringIntentDefault(extracted, transcription, bookableServiceNames);
      if (extracted.matched_service !== preReassertMatched
        || extracted.specific_service_name !== preReassertSpecific) {
        // ai_extraction and the lead's service_interest were persisted BEFORE
        // this V2 merge ran — backfill them so pipeline reporting shows the
        // same program the appointment books. Fail-open: booking proceeds
        // on the in-memory value regardless.
        try {
          await db('call_log').where({ id: call.id }).update({
            ai_extraction: JSON.stringify(extracted),
            updated_at: new Date(),
          });
          if (leadId) {
            // Mirror the enrichment path's conventions: fill-if-empty (plus
            // the one value this run is known to have written — the
            // pre-reassert AI pick) so an office-edited service_interest is
            // never clobbered, AND the ownership predicate so a lead claimed
            // by another customer between lookup and this write is left alone.
            await db('leads')
              .where({ id: leadId })
              .where((qb) => {
                qb.whereNull('customer_id');
                if (customerId) qb.orWhere({ customer_id: customerId });
              })
              .where((qb) => {
                qb.whereNull('service_interest').orWhere({ service_interest: '' });
                if (preReassertMatched) qb.orWhere({ service_interest: preReassertMatched });
                // Enrichment may have persisted a COMPOSED label (matched +
                // uncovered requested families) from the pre-V2-merge
                // extraction — match the exact value it wrote, not a label
                // recomputed from the since-mutated fields.
                if (persistedServiceInterestLabel && persistedServiceInterestLabel !== preReassertMatched) {
                  qb.orWhere({ service_interest: persistedServiceInterestLabel });
                }
              })
              .update({
                // Recompose over BOTH the post-merge request and the SECONDARY
                // families enrichment already persisted: the V2 merge can
                // narrow requested_service to the primary category only, and a
                // primary-only recompose here would erase those tails. Only
                // the extras carry forward — never the pre-merge primary,
                // which the validated V2 merge may have corrected.
                service_interest: composeServiceInterest({
                  ...extracted,
                  requested_service: [persistedServiceInterestExtras, extracted.requested_service]
                    .filter(Boolean).join(' '),
                }) || extracted.matched_service,
              });
          }
        } catch (bfErr) {
          logger.warn(`[call-proc] recurring-default backfill failed open: ${bfErr.message}`);
        }
      }
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
    // Live re-service lane context for the resolver's revisit override (codex
    // #3222 r1): eligibility is the reservice lane's OWN plan check
    // (reserviceLanesForCustomer — live recurring/WaveGuard coverage), never
    // completed history. Lanes with an open callback are deliberately NOT
    // filtered out here (codex r3): the re-service anchor must still resolve
    // so the locked booking transaction can refuse the duplicate into
    // hold-for-review or attach to the existing visit — dropping the lane
    // would fall back to a generic label that books a second appointment
    // outside the dedupe entirely. Intent-gated so the lookups only run on
    // revisit-shaped calls; fail-closed — an error grants no lanes (generic
    // anchoring, never a free visit).
    let callReServiceLanes = [];
    if (customerId && callReServiceRows.length > 0 && hasCallReServiceIntent(extracted)) {
      try {
        const { reserviceLanesForCustomer } = require('./reservice-scheduler');
        const reServiceCustomerRow = await db('customers').where({ id: customerId }).first();
        // Same inactive guard the public re-service route applies before its
        // lane lookup (codex #3222 r2): reserviceLanesForCustomer itself does
        // not reject deactivated rows, and a lingering WaveGuard tier/rate
        // plus pest evidence would otherwise still grant the pest lane.
        callReServiceLanes = (reServiceCustomerRow && reServiceCustomerRow.active !== false)
          ? await reserviceLanesForCustomer(reServiceCustomerRow)
          : [];
      } catch (reErr) {
        callReServiceLanes = [];
        logger.warn(`[call-proc] re-service lane lookup failed for ${maskSid(callSid)} (falling back to generic anchoring): ${reErr.message}`);
      }
    }
    let callBookingCatalogRow = resolveCallBookingCatalogService({
      extracted,
      transcription,
      services: bookableCallServices,
      reServices: callReServiceRows,
      reServiceLanes: callReServiceLanes,
      coarseServiceLabel: serviceResolution.ok ? serviceResolution.service : null,
    });
    // Never book a made-up service (owner directive 2026-07-10): service_type
    // MUST be a real admin-catalog service. When the service was UNCLEAR
    // (serviceResolution.noMatch — no coarse label AND no catalog match) OR it
    // only resolved to the legacy generic "Waves Appointment" placeholder
    // (ok:true but not a real catalog row, e.g. "come out Tuesday" with no
    // service named), and fail-open is active, fall back to "Waves Assessment"
    // (assess on-site) — a real catalog row, not an invented label. Gated so it
    // NEVER fires on a hard veto (unsupported/out-of-scope call, admin-only),
    // which returns ok:false WITHOUT noMatch and must stay un-bookable, and
    // never overrides a service that DID resolve to a real specific service.
    const resolvedGenericOnly = serviceResolution.ok
      && serviceResolution.service === GENERIC_CALL_APPOINTMENT_SERVICE;
    let genericBookingUnbookable = false;
    if (!callBookingCatalogRow && (serviceResolution.noMatch === true || resolvedGenericOnly)
        && isEnabled('callFailOpenBooking') && !isOutboundCall(call)) {
      const wavesAssessment = bookableCallServices.find((s) => /^waves assessment$/i.test(String(s.name || '')));
      if (wavesAssessment) {
        callBookingCatalogRow = wavesAssessment;
        logger.info(`[call-proc] Service unclear for ${maskSid(callSid)} — booking as "Waves Assessment" (catalog fallback; assess on-site)`);
      } else if (resolvedGenericOnly) {
        // The fallback row is unavailable (catalog load failed, or the row is
        // inactive / not booking-enabled). Booking would otherwise proceed on
        // serviceResolution.ok with the made-up generic label and
        // service_id=null — exactly what the real-catalog-service invariant
        // forbids. Hold for review instead; the skip path files the
        // auto_booking_skipped_after_approval card with this reason. (The
        // noMatch case needs no flag: ok:false + no catalog row already
        // can't book.)
        genericBookingUnbookable = true;
        logger.warn(`[call-proc] "Waves Assessment" fallback row unavailable for ${maskSid(callSid)} — holding generic booking for review`);
      }
    }
    // Use the module-level isOutboundCall(call) helper — a local `const
    // isOutboundCall` here shadows it for the WHOLE function scope, putting the
    // phantom-guard references above (Step 0) in the temporal dead zone:
    // "Cannot access 'isOutboundCall' before initialization" on every call that
    // reaches them with a pre-linked customer_id.
    // The Waves Assessment fallback (above) already set callBookingCatalogRow
    // when the service was UNCLEAR (noMatch) under fail-open, so the existing
    // (catalogRow && noMatch) branch books it. Hard vetoes (ok:false, no
    // noMatch) never set a catalog row, so they stay un-bookable.
    // Outbound-callback booking (GATE_CALL_OUTBOUND_BOOKING): a confirmed
    // booking on an OUTBOUND call creates the appointment live, same as an
    // inbound one (owner directive 2026-08-11 — the office-review hold was
    // removed). It requires a REAL resolved service (a catalog row, or ok on a
    // non-generic service): the Waves-Assessment generic fallback is
    // inbound-only (see above), so an unclear/generic outbound call stays
    // unbooked for the office. It ALSO requires V2 routing to actually run in
    // ENFORCE mode: outside enforce the confidence / address-validation /
    // HOA-commercial gates never evaluate and v2RoutingBlocked stays false,
    // so a call those gates would have vetoed books live — containment the
    // removed review hold used to provide (Codex #3361 r4 P1). Shadow/legacy
    // routing keeps the pre-gate behavior: outbound bookings stay manual.
    const outboundAutoBooking = isOutboundCall(call) && isEnabled('callOutboundBooking')
      && CALL_EXTRACTION_V2_DRIVES_ROUTING && CALL_EXTRACTION_V2_ENABLED;
    // The v2 TCPA verdict is only computed in ENFORCE routing mode — but
    // outbound consent is never implied, and the removed review hold used to
    // be the backstop that kept a shadow/legacy-mode outbound booking from
    // texting. Recompute the verdict for outbound bookings regardless of
    // routing mode, fail-closed: with no extraction/consent data,
    // checkTcpaConsent blocks SMS and keeps the email fallback (Codex #3361
    // r2 P1). OR-composition only ever tightens — enforce-mode's own verdict
    // is identical for outbound (implied consent is inbound-only).
    if (outboundAutoBooking) {
      try {
        const outboundTcpa = checkTcpaConsent(
          v2ApprovedExtraction || v2CanonicalExtraction || null,
          { impliedConsent: false },
        );
        v2SmsBlocked = v2SmsBlocked || !outboundTcpa.canSms;
        v2EmailBlocked = v2EmailBlocked || !outboundTcpa.canEmail;
      } catch (tcpaErr) {
        v2SmsBlocked = true;
        logger.warn(`[call-proc] outbound TCPA recompute failed for ${maskSid(callSid)} — SMS blocked fail-closed: ${tcpaErr.message}`);
      }
    }
    const inboundCanCreate = !isOutboundCall(call)
      && (serviceResolution.ok || (!!callBookingCatalogRow && serviceResolution.noMatch === true));
    // Outbound requires a REAL catalog row (never a coarse ok-label with
    // service_id null) AND must respect a hard veto: resolveSchedulableCallService
    // returns ok:false WITHOUT noMatch for an unsupported/admin-only call, and
    // that must stay un-bookable even if a catalog keyword happened to match.
    const outboundCanCreate = outboundAutoBooking
      && !!callBookingCatalogRow
      && (serviceResolution.ok || serviceResolution.noMatch === true);
    const canCreateAppointmentFromCall = !genericBookingUnbookable
      && (inboundCanCreate || outboundCanCreate);
    if (extracted.appointment_confirmed && extracted.preferred_date_time && customerId && hasSpecificTime && !canCreateAppointmentFromCall) {
      appointmentResult = {
        service: serviceResolution.service || extracted.matched_service || extracted.requested_service || null,
        dateTime: extracted.preferred_date_time,
        scheduleCreated: false,
        smsSent: false,
        skippedReason: isOutboundCall(call) ? 'outbound_call'
          : (genericBookingUnbookable ? 'generic_service_fallback_unavailable' : serviceResolution.reason),
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
      // Declared OUTSIDE the try so the catch can see whether a schedule row
      // was already inserted when a later confirmation/SMS step threw — the
      // insert-first contract means the booking can be real even on error.
      let scheduledServiceId = null;
      try {
        let customer = await db('customers').where({ id: customerId }).first();
        if (customer) {
          customer = await backfillCustomerFromAppointmentContact(customerId, customer, extracted, contactPhone, { suppressPhone: callerPhoneUnverified });
          const customerValidation = validatePhoneCallAppointmentCustomer(customer, extracted, contactPhone);
          // Email advisory (owner ruling 2026-07-31): file the "collect the
          // email" card whenever the email is missing — INDEPENDENT of the
          // other required fields (codex round-7 P2). A caller missing
          // email+zip previously produced a card listing only the zip, so the
          // office completing the booking manually was never told to collect
          // the email. Card failure never changes the booking outcome.
          if (customerValidation.advisory?.includes('email')) {
            await db('triage_items')
              .insert(buildTriageItem({
                callLogId: call.id,
                flag: 'customer_email_missing',
                extraction: v2ApprovedExtraction || undefined,
                severity: 'advisory',
              }))
              .onConflict(db.raw('(call_log_id, reason_code) WHERE status IN (\'open\', \'in_progress\')'))
              .ignore()
              .catch((e) => logger.warn(`[call-proc] email-missing advisory insert failed for ${maskSid(callSid)}: ${e.message}`));
          }
          // Email-less bookings in SHADOW/LEGACY mode still require a
          // positively validated address (codex round-7 P1). canAutoRoute's
          // central address-trust gate only runs in enforce mode — and
          // pre-PR, the email requirement was what (incidentally) held these
          // bookings there. Without this, making email advisory would newly
          // dispatch email-less callers to addresses nobody validated.
          // Enforce mode is exempt: canAutoRoute already applied the full
          // contract, including the known-customer on-file-address lane this
          // site cannot evaluate.
          const enforceModeActive = CALL_EXTRACTION_V2_DRIVES_ROUTING && CALL_EXTRACTION_V2_ENABLED;
          // The verdict must validate the address actually being BOOKED
          // (codex round-13, residual #2 closed pre-merge): AV runs on the
          // V2 extraction's address, but this legacy/shadow branch books the
          // V1 `extracted` address. When the two streets disagree,
          // deriveCallReviewBridge deliberately refuses adoption — so a
          // positive verdict for V2's street says NOTHING about the V1
          // street the tech would drive to. Suffix-insensitive street key +
          // city + zip against AV's normalized form; a missing normalized
          // form or a mismatch keeps the hold. Enforce mode is untouched
          // (canAutoRoute owns the contract there, and it books the same
          // V2 address the verdict was computed for).
          const avNormalized = effectiveAddressValidation?.normalized || null;
          // The unit must match too (codex final-round P1): AV sends
          // street_line_2 to Google but its normalized form omits the
          // subpremise, so the unit is compared against the V2 extraction's
          // OWN address — the exact input the verdict was computed on. V1
          // Apt A with a verdict for V2 Apt B holds. No valid V2 extraction
          // means AV never ran on anything, so the gate fails closed.
          // v2ApprovedExtraction is assigned only in the ENFORCE branch — in
          // shadow/legacy mode (where this gate actually applies) it is
          // always null, which made the gate permanently closed (codex
          // final-round P1: fail-closed, so safe, but it nullified the
          // intended positive-AV liberalization). The SHADOW extraction is
          // the address AV was computed on in those modes; only a VALID
          // extraction counts — an invalid payload is untrusted output and,
          // consistently, AV wouldn't have a meaningful verdict for it.
          const v2ForAddressCheck = v2ApprovedExtraction
            || ((v2Result?.status === 'valid' && isV2Extraction(v2Result?.extraction)) ? v2Result.extraction : null);
          const v2StatedAddress = v2ForAddressCheck?.property?.service_address || null;
          // A SUCCESSFUL recovery moves the verdict's input (codex
          // final-round P2): the effective verdict was computed on the
          // premise recovery confirmed, and deriveCallReviewBridge adopted
          // that same premise into `extracted` — so the ORIGINAL V2 street
          // (the garble recovery exists to fix) disagrees BY CONSTRUCTION
          // and would hold exactly the bookings recovery just rescued. The
          // recovered premise is the verdict input in that case; the V2
          // extraction still supplies the stated UNIT, which recovery never
          // re-hears (its Autocomplete input is street-only, and AV's
          // normalized form carries no subpremise at all).
          // recoverStreetAddress REMAPS its winner to the V1-flat shape
          // (address_line1/city/state/zip) before returning — it is only
          // AV-normalized inside confirmPrediction (codex round-18 P2).
          // Reading street_line_1 off it yielded undefined, which failed the
          // whole predicate closed and silently un-did the recovery fix.
          const recoveredVerdictInput = (addressRecovery?.recovered && addressRecovery.avResult)
            ? { street_line_1: addressRecovery.recovered.address_line1, city: addressRecovery.recovered.city }
            : null;
          const v2ValidatedAddress = recoveredVerdictInput || v2StatedAddress;
          const unitKey = (v) => String(v || '').toLowerCase().replace(/[#.,]/g, ' ').replace(/\s+/g, ' ').trim();
          // City included (codex final-round P1): ZIP almost always pins the
          // city, but multi-city ZIPs exist and deriveCallReviewBridge
          // refuses adoption on a city disagreement — the gate matches that
          // bar. With street+city+zip+unit all matched against BOTH the
          // AV-normalized form and the V2 input, the match is total.
          const cityKey = (v) => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim();
          // ...but only where the bridge itself demands it (codex round-18
          // P2). For `validated_accept` Google changed NOTHING, so a city the
          // caller's record does not share means V2 named a different place →
          // hold. For `corrected` the difference IS Google's trusted
          // correction, the shadow path writes the normalized city into
          // `extracted`, and deriveCallReviewBridge deliberately does not
          // reject on it — so demanding the ORIGINAL V2 city here would hold
          // every city correction. The unconditional match against the
          // verdict's own normalized city below is what keeps this safe:
          // the booked city always has to be the validated one.
          const requireStatedCityMatch = String(effectiveAddressValidation?.status || '') === 'validated_accept';
          const avValidatesBookedAddress = !!avNormalized && !!v2ValidatedAddress && !!v2StatedAddress
            && streetCompareKey(String(extracted.address_line1 || '')) === streetCompareKey(String(avNormalized.street_line_1 || ''))
            && String(extracted.zip || '').trim() === String(avNormalized.postal_code || '').trim()
            && cityKey(extracted.city) === cityKey(avNormalized.city)
            && streetCompareKey(String(extracted.address_line1 || '')) === streetCompareKey(String(v2ValidatedAddress.street_line_1 || ''))
            && (!requireStatedCityMatch || cityKey(extracted.city) === cityKey(v2ValidatedAddress.city))
            && unitKey(extracted.address_line2) === unitKey(v2StatedAddress.street_line_2);
          const avPositiveForBooking = !!effectiveAddressValidation
            && ['validated_accept', 'corrected'].includes(String(effectiveAddressValidation.status || ''))
            && effectiveAddressValidation.inServiceArea === true
            && avValidatesBookedAddress;
          const emailAdvisoryHold = !enforceModeActive
            && customerValidation.ok
            && !!customerValidation.advisory?.includes('email')
            && !avPositiveForBooking;
          if (!customerValidation.ok || emailAdvisoryHold) {
            const missingFields = customerValidation.ok ? ['email'] : customerValidation.missing;
            appointmentResult = {
              service: serviceResolution.service,
              dateTime: extracted.preferred_date_time,
              scheduleCreated: false,
              smsSent: false,
              skippedReason: 'missing_required_customer_fields',
              missingFields,
            };
            logger.warn(
              `[call-proc] Skipping appointment auto-create for ${callSid}: missing required customer fields ` +
              missingFields.join(', ') + (emailAdvisoryHold ? ' (email-less booking outside enforce mode requires a validated address)' : '')
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
            // Implied-consent recipient scope: implied consent is PERSONAL to
            // the caller. When it is the only clearance and the resolved
            // customer phone differs from the inbound ANI (saved primary is a
            // spouse/alternate/service-contact slot), the confirmation goes to
            // the ANI — the number that called us and booked — never to a
            // non-consenting third party, and not held either: the caller DID
            // consent by calling. Held only when the ANI itself is undialable.
            const smsLast10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);
            const smsTargetIsInboundAni = smsLast10(smsPhone).length === 10
              && smsLast10(smsPhone) === smsLast10(contactPhone);
            const redirectImpliedToAni = v2SmsClearedByImpliedConsent && !smsTargetIsInboundAni
              && smsLast10(contactPhone).length === 10;
            const smsRecipient = redirectImpliedToAni ? contactPhone : smsPhone;
            if (redirectImpliedToAni) {
              logger.info(`[call-proc] Implied-consent confirmation for ${maskSid(callSid)} goes to the inbound caller's number (resolved customer phone differs)`);
            }

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
          // Rendering is DEFERRED until after the scheduled_services insert:
          // the row (and its reschedule_token) must exist before a real
          // appointment-page link can be minted for the v2 body (codex r4).
          let alreadySent = false;

          // Create the scheduled_services record FIRST. Previously we sent
          // the SMS first and inserted the schedule row afterward — if the
          // insert threw, the customer received "your appointment is booked"
          // for an appointment that never landed on the schedule. Now: insert
          // first, send only if it succeeded. (scheduledServiceId itself is
          // declared above the outer try so the catch keeps the booked id.)
          let scheduledDateForLog = null;
          let windowStartForLog = null;
          let scheduleWasReused = false;
          let followUpCreated = null;
          // Cross-customer overlap findings from inside the booking txn —
          // advisory only (owner's chosen behavior: the booking proceeds
          // exactly as before; a triage card + admin bell surface the clash).
          let bookingTimeConflicts = [];
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

            // Hourly-start rule enforced in the COMMON creation path (codex
            // round-5 P1). window_start is always HH:00:00 (AGENTS.md, owner
            // 2026-07-27) and this is the code that writes it — but
            // canAutoRoute's central gate only runs inside the
            // CALL_EXTRACTION_V2_DRIVES_ROUTING enforce branch, so in shadow
            // or legacy mode nothing checked it. That gap became reachable
            // when this PR made a missing email advisory: a 09:30 call with
            // no email used to stop at missing_required_customer_fields and
            // now gets this far. Guarding here covers enforce, shadow and
            // legacy alike, at the single place window_start is derived.
            // Seconds are checked on the ORIGINAL value, not the formatted
            // one (codex round-10 P1): windowStart came through an Intl
            // format that omits seconds, so "T09:00:30" reduces to "09:00"
            // and would pass the minutes regex — booking a silently rounded
            // start. A free-text preferred_date_time ("tomorrow at 2 pm")
            // has no T-seconds group and is unaffected.
            const rawStartSeconds = String(extracted.preferred_date_time || '').match(/T\d{2}:\d{2}:(\d{2})/);
            const offHourStart = (windowStart && !/^\d{2}:00(:00)?$/.test(windowStart))
              || (rawStartSeconds && rawStartSeconds[1] !== '00');
            if (scheduledDate && windowStart && offHourStart) {
              logger.warn(`[call-proc] Confirmed start ${windowStart} is not on the hour (or carries seconds); holding booking for the office to place on an hour boundary`);
              appointmentResult = {
                service: serviceType,
                dateTime: extracted.preferred_date_time,
                scheduleCreated: false,
                smsSent: false,
                skippedReason: 'off_hour_start',
              };
              // File the review card HERE, not just in the enforce-mode audit
              // (codex round-6 P1): this hold also runs in shadow/legacy mode,
              // where the approved-but-unbooked audit never executes — without
              // this insert a clean 09:30 call was held with no appointment
              // AND no card, and the office would never place the promised
              // booking on an hour boundary. The payload carries the agreed
              // date/time so the card is actionable without a re-listen (the
              // V2 scheduling payload rides along when available; legacy calls
              // still get the parsed values). onConflict dedups against the
              // enforce-mode insert for the same reason code.
              await db('triage_items')
                .insert(buildTriageItem({
                  callLogId: call.id,
                  flag: 'off_hour_start',
                  extraction: v2ApprovedExtraction || undefined,
                  extraPayload: {
                    preferred_date_time: extracted.preferred_date_time || null,
                    scheduled_date: scheduledDate,
                    window_start: windowStart,
                    service_type: serviceType,
                  },
                }))
                .onConflict(db.raw('(call_log_id, reason_code) WHERE status IN (\'open\', \'in_progress\')'))
                .ignore()
                .catch((e) => logger.warn(`[call-proc] off-hour triage insert failed for ${maskSid(callSid)}: ${e.message}`));
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
              // service's catalog interval (default 14 days). Never for a
              // covered re-service (codex #3222 r2): the re-service IS the
              // free callback visit — a child row would be a second open
              // callback from the same call, invisible to the lane dedupe's
              // semantics and without the is_callback marker.
              const callFollowUpPlan = isReServiceCatalogRow(callBookingCatalogRow)
                ? null
                : resolveCallFollowUpPlan({
                  extracted,
                  catalogRow: callBookingCatalogRow,
                  parentDate: scheduledDate,
                  parentWindowStart: windowStart || '09:00',
                });
              let reusedExistingSchedule = false;
              // Set when the call was ATTACHED to a live booking made by a
              // human through another channel (see the attach guard below):
              // the id drives the distinct log line, and the skipped-plan
              // flag surfaces the promised-but-not-auto-booked visit 2 as an
              // advisory review card after commit.
              let attachedManualBookingId = null;
              let attachSkippedFollowUpPlan = false;
              // Resolve the Bill-To payer once, before the transaction (it's a
              // reusable find-or-create keyed on AP email, independent of the
              // booking's atomicity), for the fresh insert + fresh follow-up
              // child to stamp. Reused rows are left as-is (see the note below).
              const v2CallerForPayer = v2CanonicalExtraction?.caller || {};
              const callBookingPayerId = await resolveCallBillingPayer(
                callSecondaryContacts, v2CanonicalExtraction,
                {
                  emails: [callerEmailPreScrub, extracted.email, v2CallerForPayer.email],
                  phones: [contactPhone, extracted.phone, v2CallerForPayer.phone_e164, v2CallerForPayer.phone_raw_spoken],
                },
              );
              const svc = await db.transaction(async (trx) => {
                await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))', ['call-recording-schedule', callSid]);
                // Rung 6 (scheduling/occupancy.js ORDERING CONTRACT — r25):
                // every scheduled_services insert in this transaction (the
                // booking + linked follow-up visits) serializes against a
                // concurrent merge-undo of this customer, BEFORE any row
                // lock. Taken after the call-SID advisory (which the undo
                // never takes — no cycle); blocking is safe here, this
                // transaction holds only advisory keys so far.
                const { lockCustomerComms } = require('../utils/customer-comms-lock');
                if (customer?.id) {
                  await lockCustomerComms(trx, customer.id);
                  // Revalidate UNDER the fence (r26): the pre-transaction
                  // read/validation may predate an undo this acquire just
                  // waited out — an inherited address/name could be gone.
                  // A fresh row that still validates drives the booking
                  // (property linkage + confirmation render live values); a
                  // failing one aborts into the schedErr catch, so nothing
                  // books, no SMS goes out, and the approved-but-unbooked
                  // review card reaches the office to book manually.
                  const freshCallCustomer = await trx('customers').where({ id: customer.id }).first();
                  const freshValidation = freshCallCustomer
                    ? validatePhoneCallAppointmentCustomer(freshCallCustomer, extracted, contactPhone)
                    : { ok: false, missing: ['customer_row'] };
                  if (!freshValidation.ok) {
                    throw new Error(`customer record changed while waiting on the comms fence (merge-undo in flight?) — missing ${freshValidation.missing.join(', ')}; booking held for office review`);
                  }
                  customer = freshCallCustomer;
                  // Call OWNERSHIP re-reads too (r40): a journaled
                  // call_log the undo repointed while we waited means
                  // customerId is the stale kept id — the insert would
                  // source a kept-customer appointment from the restored
                  // customer's call, invisible to the undo's probes.
                  // Abort into the schedErr path (no booking, no SMS, the
                  // approved-but-unbooked card reaches the office).
                  const freshCallRow = await trx('call_log')
                    .where({ id: call.id }).first('customer_id');
                  if (freshCallRow?.customer_id
                    && String(freshCallRow.customer_id) !== String(customer.id)) {
                    throw new Error('call ownership changed while waiting on the comms fence (merge-undo) — booking held for office review');
                  }
                }
                // Re-service lane advisory lock (codex #3222 r2 — the SAME
                // namespace+key createSelfBooking takes, so a phone booking
                // and a self-serve commit for the customer's lane serialize
                // against each other, not just against themselves). Lock
                // order vs the self-serve writer is compatible: both take
                // customer-comms before this terminal reservice-lane rung.
                // Taken here, before the same-call replay lookup, for
                // lock-order clarity — the replay/attach paths below still
                // win for a reprocessed call, and the open-callback dedupe
                // itself runs on the fresh-insert path only (after them).
                if (isReServiceCatalogRow(callBookingCatalogRow)) {
                  await trx.raw(
                    'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
                    ['reservice-lane', `${customerId}:${callBookingCatalogRow.service_key}`],
                  );
                }
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
                          // Mirror the primary's Bill-To onto the follow-up: an
                          // unpriced follow-up is billed at completion, and
                          // without this PayerService.resolveForInvoice would
                          // fall back to customer.payer_id/self-pay and send the
                          // second visit's invoice to the homeowner instead of
                          // the named payer. Always matches the parent (a fresh
                          // primary already carries callBookingPayerId here).
                          payer_id: primaryRow.payer_id || null,
                          technician_id: primaryRow.technician_id || defaultTechnicianId,
                          // Visit 2 treats the same property as visit 1 —
                          // coordinates included, or the stamped child would
                          // render the right address with no map pin.
                          property_id: primaryRow.property_id || null,
                          lat: primaryRow.lat ?? null,
                          lng: primaryRow.lng ?? null,
                          service_address_line1: primaryRow.service_address_line1 || null,
                          service_address_line2: primaryRow.service_address_line2 || null,
                          service_address_city: primaryRow.service_address_city || null,
                          service_address_state: primaryRow.service_address_state || null,
                          service_address_zip: primaryRow.service_address_zip || null,
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
                  // An ATTACHED human booking resurfacing through the linked
                  // (source_call_log_id) lookup keeps its attach semantics on
                  // reprocess (Codex #2771 r5): no AI follow-up child on a
                  // human's booking — a manually planned visit 2 is a
                  // standalone parent row the child-dedup guard can't see.
                  // Fresh AI inserts always carry booking_source
                  // 'phone_call', so anything else came from the attach path.
                  const isAttachedManualBooking = String(existing.booking_source || '') !== 'phone_call';
                  let primaryRow = existing;
                  if (!isAttachedManualBooking && !existing.technician_id && defaultTechnicianId) {
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
                  // A covered re-service is a $0 callback, not a closed sale
                  // (codex #3222 follow-up): converting the lead would record
                  // a won deal and promote funnel metrics off a free visit —
                  // judged from the REUSED row's own identity (codex #3231:
                  // a reprocess may resolve differently than what booked).
                  // A SKIPPED reused row was a REJECTED booking (the dispatch
                  // Skip action — same rejection semantics the activation
                  // helper honors): a replay must not close its lead as won
                  // or spawn its follow-up visit (Codex #3361 r8 P1).
                  const primaryRowSkipped = String(primaryRow.status || '') === 'skipped';
                  if (!primaryRowSkipped && (!isFreeReServiceBookingRow(primaryRow) || callQuotePromised)) {
                    await convertCallLeadOnPhoneBooking(trx, {
                      leadId,
                      customerId,
                      scheduledServiceId: primaryRow.id,
                      callSid,
                      keepOpenForQuote: callQuotePromised,
                    });
                  }
                  if (isAttachedManualBooking) {
                    attachedManualBookingId = primaryRow.id;
                    attachSkippedFollowUpPlan = !!callFollowUpPlan;
                  } else if (!primaryRowSkipped) {
                    // After the backfill so the child inherits the assigned tech.
                    followUpCreated = await ensureCallFollowUpVisit(primaryRow);
                  }
                  return primaryRow;
                }
                // Which property is this visit FOR? Resolved BEFORE the
                // attach guard (Codex #2771): attach evidence needs the
                // call's own property linkage, and the fresh-insert path
                // below stamps the same resolution so dispatch and the tech
                // portal render the booked property, not the customer's
                // primary mirror (a rental booking used to dispatch to the
                // customer's home).
                const propertyLinkage = await resolveCallBookingPropertyLinkage(customerId, {
                  ...extracted,
                  // flatView historically dropped street_line_2; a condo unit
                  // must survive into the stamp/key (codex P2).
                  address_line2: extracted.address_line2
                    || v2ApprovedExtraction?.property?.service_address?.street_line_2
                    || v2CanonicalExtraction?.property?.service_address?.street_line_2
                    || null,
                }, trx);
                // findExistingCallAppointment only sees THIS call's rows —
                // a visit booked through ANY other channel (a human in the
                // portal mid-call, online self-booking) is invisible to it,
                // and a customer merely re-confirming such a visit ("still
                // on for Tuesday at 10?") would re-book it here, with
                // duplicate reminders and a second confirmation SMS. The AI
                // never books over a human: exactly one live row with the
                // same service line within ±1 day AND agreeing property
                // evidence → ATTACH the call to it (source_call_log_id
                // makes the linkage durable — a reprocess finds it via the
                // linked lookup) instead of inserting; several plausible
                // rows → hold for human review; a property mismatch falls
                // through (a different property's visit is not a duplicate).
                const attachable = await findAttachableCallAppointment({
                  customerId, scheduledDate, serviceType, trx,
                });
                const attachMatch = attachable.row && attachCandidateMatchesProperty(attachable.row, propertyLinkage)
                  ? attachable.row
                  : null;
                if (attachMatch
                  && (attachMatch.status !== 'confirmed'
                    || !attachCandidateSlotAgrees(attachMatch, { scheduledDate, windowStart }))) {
                  // Hold for human review instead of attaching when the
                  // match is a PENDING office hold (Codex #2771 r3 —
                  // attaching would mark the call handled while the visit
                  // stays unconfirmed and unarmed) or when the requested
                  // SLOT disagrees (r9 — a neighbor-day or different-time
                  // row may be a separate visit the customer is adding, and
                  // silently attaching would lose the new booking; a same
                  // date+window match is a re-confirmation, anything else
                  // is a human's call).
                  return {
                    __held: {
                      reason: 'ambiguous_existing_appointment',
                      existingId: attachMatch.id,
                      existingStatus: attachMatch.status,
                      existingService: attachMatch.service_type,
                    },
                  };
                }
                if (attachMatch) {
                  const attachNote = `Attached from phone call — Call SID: ${callSid}.`;
                  // Claim-based attach (Codex #2771): two concurrent calls
                  // can both read this row while source_call_log_id is still
                  // NULL — the guarded update lets exactly one win; the
                  // loser holds for human review instead of hijacking the
                  // winner's linkage.
                  const [stamped] = await trx('scheduled_services')
                    .where({ id: attachable.row.id })
                    .whereNull('source_call_log_id')
                    .update({
                      source_call_log_id: call.id,
                      // JobDrawer-only: notes is customer-visible verbatim
                      // (GET /api/schedule), so the linkage cue stays out of it.
                      internal_notes: attachable.row.internal_notes
                        ? `${attachable.row.internal_notes} ${attachNote}`
                        : attachNote,
                      updated_at: new Date(),
                    })
                    .returning('*');
                  if (!stamped) {
                    return {
                      __held: {
                        reason: 'ambiguous_existing_appointment',
                        existingId: attachable.row.id,
                        existingStatus: attachable.row.status,
                        existingService: attachable.row.service_type,
                      },
                    };
                  }
                  reusedExistingSchedule = true;
                  attachedManualBookingId = attachable.row.id;
                  attachSkippedFollowUpPlan = !!callFollowUpPlan;
                  const primaryRow = stamped;
                  // The deal still closed — same idempotent, ownership-guarded
                  // conversion as the reuse path above, same re-service
                  // exception ($0 callback, not a sale — judged from the
                  // ATTACHED row's own identity, codex #3231).
                  if (!isFreeReServiceBookingRow(primaryRow) || callQuotePromised) {
                    await convertCallLeadOnPhoneBooking(trx, {
                      leadId,
                      customerId,
                      scheduledServiceId: primaryRow.id,
                      callSid,
                      keepOpenForQuote: callQuotePromised,
                    });
                  }
                  // Deliberately NO ensureCallFollowUpVisit on an attached
                  // human booking: a manually planned visit 2 is a standalone
                  // parent row the child-dedup guard can't see, so an AI
                  // child here risks exactly the double-booking this guard
                  // exists to prevent. A promised visit 2 surfaces as an
                  // advisory review card instead (post-commit below).
                  return primaryRow;
                }
                if (attachable.ambiguous.length) {
                  return {
                    __held: {
                      reason: 'ambiguous_existing_appointment',
                      existingId: attachable.ambiguous[0].id,
                      existingStatus: attachable.ambiguous[0].status,
                      existingService: attachable.ambiguous[0].service_type,
                      existingIds: attachable.ambiguous.map((r) => r.id),
                    },
                  };
                }
                // Any live same-day parent visit for this customer that the
                // attach guard did not claim (different service line, or an
                // excluded shape like another call's booking) still means a
                // human decides: hold instead of inserting a duplicate. (A
                // genuine second same-day visit is rare enough that one
                // review card beats a phantom double-dispatch.)
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
                // Cross-customer occupancy check (shared scheduling/occupancy
                // module) — the only date-collision guard above is
                // customer-scoped, so a booking overlapping ANOTHER
                // customer's visit sailed through silently. One active tech
                // means any overlap is a real clash. ADVISORY ONLY by owner
                // decision: never hold or block — record the clashing rows
                // and book exactly as before; the post-commit triage card +
                // admin notification below surface them. excludeCustomerId
                // keeps the existing same-customer semantics (the same-day
                // guard above already owns those). Best-effort: a query
                // failure must never fail the booking txn.
                //
                // NO date-wide occupancy lock in THIS txn, and this read is
                // therefore only the fast-path signal, not the verdict: it
                // sees committed truth as of now, so a concurrent rung-1
                // writer mid-commit — or a second concurrent call booking —
                // is invisible to it. The AUTHORITATIVE detection is the
                // post-commit recheck below (recheckCallBookingConflicts),
                // which takes the date lock in a short transaction of its
                // own. The lock stays out of this txn on purpose: the
                // booking must never wait on (or lose to) a scheduling
                // lock, and the post-insert work here row-locks leads/
                // customers/estimates — tables the estimate-accept txn
                // locks BEFORE taking rung 1 inside commitReservation, so
                // holding rung 1 across them would invert the lock order
                // (deadlock-abort risk to a booking the owner says always
                // proceeds).
                try {
                  const { findConflictingVisits } = require('./scheduling/occupancy');
                  bookingTimeConflicts = await findConflictingVisits({
                    db: trx,
                    date: scheduledDate,
                    windowStart: windowStart || '09:00',
                    windowEnd: windowEnd || '10:00',
                    excludeCustomerId: customerId,
                  });
                } catch (occErr) {
                  logger.warn(`[call-proc] booking occupancy check failed for ${maskSid(callSid)} (booking proceeds unflagged): ${occErr.message}`);
                  bookingTimeConflicts = [];
                }
                // Re-service lane dedupe on the FRESH-INSERT path only,
                // under the reservice-lane advisory lock taken above and
                // AFTER the replay/attach lookups (codex #3222 r2 — mirrors
                // createSelfBooking's lock → replay → dedupe order, so a
                // reprocessed call reuses its own booking instead of seeing
                // it as "already booked"). A hit holds for human review via
                // the __held return — same non-blocking shape as the
                // same-day hold above, keeping this occupancy-to-insert
                // region free of booking-blocking exceptions (the source
                // contract in call-booking-conflict-flag.test.js) — so no
                // booking, no SMS, and the reason-flagged review card sends
                // the office to the existing visit. An unverifiable lane
                // holds too: fail closed, never a possibly-duplicate free
                // visit.
                if (isReServiceCatalogRow(callBookingCatalogRow)) {
                  const { reserviceLanesForCustomer, openCallbackExistsForLane } = require('./reservice-scheduler');
                  const reServiceLane = reServiceLaneForRow(callBookingCatalogRow);
                  // Eligibility REVALIDATED under the locks (codex #3222 r6
                  // — mirrors the reservice route's commit-time re-check),
                  // and the customer row is read FOR UPDATE (r8): the admin
                  // customer update row-locks before flipping `active`, so
                  // sharing that row lock serializes a deactivation against
                  // this booking — after this read it waits out the insert's
                  // commit instead of landing between check and insert.
                  // Unverifiable → hold, fail closed.
                  let lockedReServiceCustomer = null;
                  try {
                    lockedReServiceCustomer = await trx('customers').where({ id: customerId }).forUpdate().first();
                  } catch (lockErr) {
                    logger.warn(`[call-proc] re-service customer lock failed for ${maskSid(callSid)} (holding for review): ${lockErr.message}`);
                  }
                  if (!lockedReServiceCustomer || lockedReServiceCustomer.active === false) {
                    return { __held: { reason: 'reservice_eligibility_lapsed' } };
                  }
                  // Premise FIRST (codex #3222 r7/r8/r10): the coverage that
                  // may back this free visit is the premise's own —
                  //   primary/on-file  → legacy unlinked rows + rows linked
                  //                      to the primary property (coverage
                  //                      living ONLY at a rental must not
                  //                      back a free visit at the primary);
                  //   non-primary      → only rows linked to that property;
                  //   unmatched addr   → hold.
                  const reServicePremise = await classifyReServiceBookingPremise({
                    customer: lockedReServiceCustomer,
                    propertyLinkage,
                    trx,
                  });
                  if (reServicePremise.scope === 'unknown') {
                    return { __held: { reason: 'reservice_property_uncovered' } };
                  }
                  let coverageScope = null;
                  if (reServicePremise.scope === 'property') {
                    coverageScope = { propertyId: reServicePremise.propertyId, includeUnlinked: false };
                  } else {
                    // Fail closed on a failed primary lookup: degrading to
                    // unlinked-only coverage would silently narrow (or, for
                    // an all-linked account, empty) the premise — hold for
                    // review instead, same as an unknown premise.
                    let primaryPropertyId = null;
                    try {
                      const primaryProp = await trx('customer_properties')
                        .where({ customer_id: customerId, is_primary: true, active: true })
                        .first('id');
                      primaryPropertyId = primaryProp?.id || null;
                    } catch (primErr) {
                      logger.warn(`[call-proc] primary-property lookup failed for ${maskSid(callSid)} (holding for review): ${primErr.message}`);
                      return { __held: { reason: 'reservice_property_uncovered' } };
                    }
                    coverageScope = { propertyId: primaryPropertyId, includeUnlinked: true };
                  }
                  // Lanes read ON THE TRANSACTION with the qualifying
                  // coverage rows locked (codex r9) and premise-scoped
                  // (r10): an admin cancellation serializes against this
                  // booking, and only the premise's own coverage counts.
                  // Unverifiable → hold, fail closed.
                  let laneStillEligible = false;
                  try {
                    laneStillEligible = (await reserviceLanesForCustomer(
                      lockedReServiceCustomer, trx, { lockCoverage: true, coverageScope },
                    )).includes(reServiceLane);
                  } catch (eligErr) {
                    logger.warn(`[call-proc] re-service eligibility recheck failed for ${maskSid(callSid)} (holding for review): ${eligErr.message}`);
                  }
                  if (!laneStillEligible) {
                    return {
                      __held: {
                        reason: reServicePremise.scope === 'property'
                          ? 'reservice_property_uncovered'
                          : 'reservice_eligibility_lapsed',
                      },
                    };
                  }
                  let laneCallbackOpen = true;
                  try {
                    laneCallbackOpen = await openCallbackExistsForLane(trx, customerId, reServiceLane);
                  } catch (dedupeErr) {
                    logger.warn(`[call-proc] re-service lane dedupe check failed for ${maskSid(callSid)} (holding for review): ${dedupeErr.message}`);
                  }
                  if (laneCallbackOpen) {
                    return { __held: { reason: 'open_reservice_callback_exists' } };
                  }
                }
                // Bill-To linkage (callBookingPayerId resolved above, before the
                // transaction): stamp payer_id (per-job) so the completion
                // invoice routes to the payer. (propertyLinkage resolved above,
                // before the attach guard.)
                const insertData = {
                  customer_id: customerId,
                  payer_id: callBookingPayerId || null,
                  technician_id: defaultTechnicianId,
                  property_id: propertyLinkage.propertyId,
                  ...(propertyLinkage.lat != null && propertyLinkage.lng != null
                    ? { lat: propertyLinkage.lat, lng: propertyLinkage.lng }
                    : {}),
                  service_address_line1: propertyLinkage.address?.line1 || null,
                  service_address_line2: propertyLinkage.address?.line2 || null,
                  service_address_city: propertyLinkage.address?.city || null,
                  service_address_state: propertyLinkage.address?.state || null,
                  service_address_zip: propertyLinkage.address?.zip || null,
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
                  // A phone-booked covered re-service is the same free
                  // callback the reservice lane books — mirror the
                  // createSelfBooking callbackVisit shape exactly (codex
                  // #3222 r1+r2): is_callback is the explicit marker every
                  // downstream free-callback path keys on (inspection-credit
                  // exclusion, callback reporting, the lane's open-callback
                  // dedupe, completion's monthly-dues suppression), and the
                  // price/invoice overrides make the row unbillable even if
                  // the extractor captured a number (the plan rate, a
                  // misheard fee) — resolveCallBookingPrice also refuses to
                  // price these rows, so this is belt and braces.
                  ...(isReServiceCatalogRow(callBookingCatalogRow) ? {
                    is_callback: true,
                    estimated_price: null,
                    create_invoice_on_complete: false,
                  } : {}),
                  status: 'confirmed',
                  customer_confirmed: true,
                  confirmed_at: new Date(),
                  notes: [
                    // Customer-visible (GET /api/schedule returns notes verbatim):
                    // keep it customer-safe. The office review cue lives in
                    // internal_notes below.
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
                  // Inspection credit: a booked phone sale is a REAL
                  // customer booking — durable evidence, same transaction
                  // (Codex #3178 r6 P0). The hourly sweep mints from it.
                  await require('./inspection-credit').markBookingForInspectionCredit(trx, {
                    customerId: created.customer_id,
                    scheduledServiceId: created.id,
                    source: 'phone_call',
                  });
                  // A phone-booked appointment is the deal closing — convert the
                  // call's lead to won in the SAME transaction (mirrors the
                  // admin-leads schedule-appointment route), so the conversion
                  // can't commit without the appointment row. Every other booking
                  // path already converts; this one silently didn't, stranding
                  // phone-booked callers as `new` in the pipeline. EXCEPT a
                  // covered re-service: a $0 callback is not a closed sale
                  // (codex #3222 follow-up) — the caller is already a plan
                  // customer and the lead must not record a won deal.
                  if (!isReServiceCatalogRow(callBookingCatalogRow) || callQuotePromised) {
                    await convertCallLeadOnPhoneBooking(trx, {
                      leadId,
                      customerId,
                      scheduledServiceId: created.id,
                      callSid,
                      keepOpenForQuote: callQuotePromised,
                    });
                  }
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
                  // the lead must still convert (idempotent, ownership-guarded) —
                  // unless this is a covered re-service ($0 callback, not a
                  // sale — judged from the reused row's own identity, codex
                  // #3231) or a SKIPPED row (a rejected booking; a replay
                  // must not close its lead or spawn its follow-up visit,
                  // Codex #3361 r8 P1).
                  const existingByKeySkipped = String(existingByKey.status || '') === 'skipped';
                  if (!existingByKeySkipped && (!isFreeReServiceBookingRow(existingByKey) || callQuotePromised)) {
                    await convertCallLeadOnPhoneBooking(trx, {
                      leadId,
                      customerId,
                      scheduledServiceId: existingByKey.id,
                      callSid,
                      keepOpenForQuote: callQuotePromised,
                    });
                  }
                  // This is exactly the retry whose first attempt may have
                  // lost the savepointed follow-up insert — ensure visit 2.
                  if (!existingByKeySkipped) {
                    followUpCreated = await ensureCallFollowUpVisit(existingByKey);
                  }
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
                      // Ambiguous-attach holds carry EVERY plausible row so the
                      // review card shows the full choice, not just the oldest.
                      existing_scheduled_service_ids: svc.__held.existingIds || null,
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
                if (attachedManualBookingId) {
                  logger.info(`[call-proc] Attached call ${callSid} to existing ${svc.booking_source || 'manually created'} booking ${svc.id}; not creating duplicate`);
                } else {
                  logger.info(`[call-proc] Reusing existing phone-call scheduled service ${svc.id} for ${callSid}; not creating duplicate`);
                }
              }
              scheduledServiceId = svc.id;
              if (scheduleWasReused) {
                // The reused row can be a LEGACY outbound-review booking
                // (created pending before the 2026-08-11 hold removal): the
                // reuse branches convert its lead and the replay repair arms
                // reminders, but nothing stamped customer_confirmed — leaving
                // the row hidden from customer self-service with its review
                // card open even though customer-facing side effects armed
                // (Codex #3361 r4 P0). The shared helper activates it
                // (hook-first, stamp-on-success); one indexed read and a
                // no-op for every other reused row.
                await require('./outbound-review-confirm')
                  .activateLegacyOutboundReviewRowIfNeeded(db, svc.id, 'call-proc-reuse');
              }
              // NOTE: payer_id is stamped only on FRESH bookings (insert +
              // fresh follow-up child). Retroactively backfilling the Bill-To on
              // a REUSED/pre-gate row is intentionally out of scope here — it
              // entangles invoice consistency (Charge-Now pre-completion invoices,
              // completed-visit self-pay invoices, existing follow-up children)
              // that a booking-time stamp can't safely reconcile. Those one-off
              // rows are corrected by the office (or a dedicated backfill).
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
              } else if (attachedManualBookingId) {
                // ATTACH reuse (call attached to a manually created booking):
                // that booking owns its own reminder registration — only the
                // fast redemption must re-run (Codex #3178 r37 P2) or a
                // Charge Now / pay link in the next hour collects the full
                // amount. Best-effort; the sweep stays the guarantee.
                try {
                  await require('./inspection-credit').redeemInspectionCreditForBooking({
                    customerId,
                    scheduledServiceId: svc.id,
                    createdBy: 'system:inspection_credit_call_booking_replay',
                  });
                } catch (replayErr) {
                  logger.warn(`[call-proc] replay credit redemption deferred to sweep for ${svc.id}: ${replayErr.message}`);
                }
              } else if (!['pending', 'confirmed', 'rescheduled'].includes(String(svc.status || ''))) {
                // Same-key replay reusing a row that is no longer pre-visit
                // live (skipped / no_show / completed / mid-visit): arming
                // reminders or re-arming a confirmation would message a
                // customer about a visit that already resolved (Codex #3361
                // r3 P1). Redemption stays — it is evidence-gated and the
                // money seam must still settle.
                try {
                  await require('./inspection-credit').redeemInspectionCreditForBooking({
                    customerId,
                    scheduledServiceId: svc.id,
                    createdBy: 'system:inspection_credit_call_booking_replay',
                  });
                } catch (replayErr) {
                  logger.warn(`[call-proc] replay credit redemption deferred to sweep for ${svc.id}: ${replayErr.message}`);
                }
              } else {
                // Same-key REPLAY of this call's OWN still-live booking
                // (idempotency conflict): the first attempt committed the
                // visit but may have died before its side effects ran (Codex
                // #3178 r37 P2; #3361 r2 P2) — repair BOTH rails, not just
                // redemption. registerScheduleSideEffects is idempotent
                // (registration dedupes by scheduled_service_id; redemption
                // is evidence-gated), so a replay whose first attempt did
                // complete is a no-op.
                // Register against the CURRENT slot, not the reuse-trx
                // snapshot (Codex #3361 r25 P2, same rule as the confirm
                // hook's registration leg): an office edit clearing or
                // moving the arrival time between the snapshot read and
                // this post-commit repair fired its reminder sync before
                // any reminder row existed — registering from the stale
                // snapshot would then insert an ARMED reminder at a start
                // the office already removed. An edit landing after this
                // read finds the just-registered row and the DB sync
                // trigger owns its state from there, the same contract
                // every live booking's reminder row carries.
                let replaySlotDate = svc.scheduled_date;
                let replaySlotStart = svc.window_start;
                try {
                  const freshReplaySlot = await db('scheduled_services')
                    .where({ id: svc.id })
                    .first('scheduled_date', 'window_start');
                  if (freshReplaySlot) {
                    replaySlotDate = freshReplaySlot.scheduled_date;
                    replaySlotStart = freshReplaySlot.window_start;
                  }
                } catch { /* fall back to the reuse snapshot */ }
                const replayDate = replaySlotDate instanceof Date
                  ? replaySlotDate.toISOString().split('T')[0]
                  : String(replaySlotDate || '').split('T')[0];
                await registerScheduleSideEffects({
                  scheduledServiceId: svc.id,
                  customerId,
                  scheduledDate: replayDate,
                  // A reused row whose arrival time was CLEARED after the
                  // first attempt (window_start null) must register the
                  // canonical windowless pre-closed placeholder, never an
                  // armed reminder at a fabricated 09:00 — the office
                  // explicitly removed that time (Codex #3361 r24 P1).
                  windowStart: replaySlotStart ? String(replaySlotStart).slice(0, 5) : null,
                  serviceType: svc.service_type,
                  closeReminderWindows: !replaySlotStart,
                });
                // Post-registration slot verify (Codex #3361 r26 P2): the
                // fresh read above still leaves a gap before the reminder
                // insert — an edit landing inside it synced before the row
                // existed, exactly the ordering the confirm hook's shared
                // verify repairs (windowless → canonical placeholder
                // conversion; moved slot → guarded resync). Best-effort on
                // this rail: a failed repair logs, and a re-delivered
                // replay (or the visit's own next edit) re-runs it.
                let replaySlotVerified = false;
                try {
                  const { verifyReminderSlotAfterRegistration } = require('./outbound-review-confirm');
                  replaySlotVerified = await verifyReminderSlotAfterRegistration(db, {
                    serviceId: svc.id,
                    slotDate: replaySlotDate,
                    slotStart: replaySlotStart,
                    routeTag: 'call-proc-replay',
                  });
                  if (!replaySlotVerified) {
                    logger.warn(`[call-proc] replay slot verify left ${svc.id} unrepaired — confirmation repairs skipped; a later replay or the visit's own edits resync it`);
                  }
                } catch (slotVerifyErr) {
                  logger.warn(`[call-proc] replay slot verify failed for ${svc.id} — confirmation repairs skipped: ${slotVerifyErr.message}`);
                }
                // Confirmation repair, evidence-gated: the reused-row branch
                // below never re-sends inline, and selfHealMissingReminderRows
                // marks recreated rows confirmation_sent=true — so a
                // confirmation lost to the crash would stay lost. Re-arm onto
                // the 15-min stranded-confirmation sweep ONLY when THIS run's
                // call-level SMS verdict cleared on EXPLICIT consent (the
                // sweep's sender has no v2SmsBlocked/clearance context of its
                // own — a consent-blocked booking must stay off it, Codex
                // #3361 r3 P1; and an implied-consent clearance is excluded
                // outright because it is personal to the inbound ANI, a
                // recipient decision the sweep cannot re-derive), no
                // per-visit delivery evidence exists, and the visit is still
                // in the future; the sweep's canonical send owns fan-out and
                // cannot double-text a customer the first attempt reached.
                // A WINDOWLESS reused row (arrival time cleared) skips both
                // confirmation repairs outright: a windowless visit has no
                // time to confirm — its registration above is the pre-closed
                // placeholder, and any confirmation would render a time
                // nobody chose (Codex #3361 r24 P1). A FAILED slot verify
                // skips them too (Codex #3361 r27 P2): the repairs below are
                // built on replaySlotStart, and with the verify unrepaired
                // that slot may be stale — re-arming the sweep or emailing
                // from it would send the customer an obsolete time. The
                // retry rail is the same one the verify itself leans on: a
                // later replay (or the visit's own next edit) re-runs both.
                if (replaySlotVerified && replaySlotStart && !v2SmsBlocked && !v2SmsClearedByImpliedConsent) {
                  try {
                    // ALL THREE delivery ledgers, not just messaging_audit_log
                    // (Codex #3361 r7 P2): appointment EMAILS audit into
                    // customer_interactions, and a Twilio-accepted SMS whose
                    // final audit write failed still landed durably in
                    // sms_log (no visit id there — key by customer + type
                    // since THIS visit's row was created; a cross-visit match
                    // skips the re-arm, failing toward silence).
                    let confirmationDelivered = await db('messaging_audit_log')
                      .where({ appointment_id: String(svc.id), purpose: 'appointment_confirmation' })
                      .whereNotNull('sent_at')
                      .first('id');
                    if (!confirmationDelivered) {
                      confirmationDelivered = await db('customer_interactions')
                        .where({ interaction_type: 'email_outbound' })
                        .whereRaw("metadata->>'scheduled_service_id' = ?", [String(svc.id)])
                        .whereRaw("metadata->>'status' = 'sent'")
                        .first('id');
                    }
                    if (!confirmationDelivered) {
                      confirmationDelivered = await db('sms_log')
                        .where({ customer_id: customerId, message_type: 'confirmation', direction: 'outbound' })
                        .where('created_at', '>=', svc.created_at || new Date(0))
                        // Provider-ACCEPTED rows only (Codex #3361 r8 P2): the
                        // quiet-hours rail inserts status='scheduled'
                        // confirmation rows before Twilio ever accepts them —
                        // a queued secondary copy is not evidence the primary
                        // customer was reached. Same genuine-SID pattern the
                        // cancellation-notice worker uses.
                        .whereRaw("twilio_sid ~ '^(SM|MM)'")
                        .first('id');
                    }
                    if (!confirmationDelivered) {
                      const rearmed = await db('appointment_reminders')
                        // windows_preclosed belt (write-time): a placeholder's
                        // confirmation closed in its insert and must never
                        // re-arm, even if the visit went windowless after the
                        // svc snapshot above was read.
                        .where({ scheduled_service_id: svc.id, cancelled: false, windows_preclosed: false })
                        .where('appointment_time', '>', new Date())
                        // Live-status check at WRITE time, not the earlier
                        // svc snapshot: a tech can complete the visit between
                        // the reuse read and this update, and the stranded-
                        // confirmation pass sends without a status guard of
                        // its own (Codex #3361 r6 P1).
                        .whereRaw("EXISTS (SELECT 1 FROM scheduled_services ss WHERE ss.id = appointment_reminders.scheduled_service_id AND ss.status IN ('pending','confirmed','rescheduled'))")
                        .update({ confirmation_sent: false, confirmation_sent_at: null, updated_at: new Date() });
                      if (rearmed > 0) {
                        logger.info(`[call-proc] replay of ${svc.id}: no confirmation evidence — re-armed for the stranded-confirmation sweep`);
                      }
                    }
                  } catch (confirmRepairErr) {
                    logger.warn(`[call-proc] replay confirmation repair failed for ${svc.id}: ${confirmRepairErr.message}`);
                  }
                } else if (replaySlotVerified && replaySlotStart && v2SmsBlocked && !v2EmailBlocked) {
                  // Consent-blocked SMS with email still permitted: the
                  // inline r21 fallback emails the confirmation, but a crash
                  // between the committed insert and that send loses it — and
                  // the sweep re-arm above is (correctly) skipped for a
                  // consent-blocked booking, so nothing would ever retry the
                  // email (Codex #3361 r23 P2). Repair the EMAIL leg only:
                  // evidence-gated on the email audit ledger, idempotent at
                  // the sender (per-occurrence keys), future visits only, and
                  // never touching the stranded-confirmation sweep (its
                  // canonical sender is an SMS rail).
                  try {
                    const emailEvidence = await db('customer_interactions')
                      .where({ interaction_type: 'email_outbound' })
                      .whereRaw("metadata->>'scheduled_service_id' = ?", [String(svc.id)])
                      .whereRaw("metadata->>'status' = 'sent'")
                      .first('id');
                    const replayApptTime = parseETDateTime(
                      `${replayDate}T${String(replaySlotStart).slice(0, 5)}`,
                    );
                    if (!emailEvidence && replayApptTime.getTime() > Date.now()) {
                      const AppointmentReminders = require('./appointment-reminders');
                      const reached = await AppointmentReminders.deliverConfirmationByChannel({
                        customerId,
                        scheduledServiceId: svc.id,
                        serviceLabel: svc.service_type,
                        smsPermanentlyBlocked: true,
                        // Stub, no SMS side effects: the primary text is
                        // consent-blocked on this run's verdict, and the
                        // helper enforces the channel prefs, the
                        // confirmation opt-out, and the prefs-unavailable
                        // fail-closed rule before its email fallback runs.
                        smsAttempt: async () => false,
                        // The reused-row liveness snapshot above is stale by
                        // now — a cancellation committed since must win, so
                        // the sender re-reads the status immediately before
                        // its email leg (Codex #3361 r27 P2). Fail-closed;
                        // the evidence-gated retry re-runs on a later replay.
                        requireLiveVisitStatus: true,
                      });
                      if (reached) {
                        logger.info(`[call-proc] replay of ${svc.id}: consent-blocked SMS — confirmation email repaired`);
                      }
                    }
                  } catch (emailRepairErr) {
                    logger.warn(`[call-proc] replay email-confirmation repair failed for ${svc.id}: ${emailRepairErr.message}`);
                  }
                }
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
              // Schedule-conflict / time-sanity review card (advisory —
              // owner's chosen behavior: the booking above already landed
              // exactly as before; this only surfaces it). Fresh inserts
              // only: reused/attached rows were validated when first
              // created, and bookingTimeConflicts was computed inside THIS
              // run's insert txn. Mirrors the unassigned_auto_booking
              // pattern above; the admin bell rides the same channel other
              // schedule anomalies use (notification-service.notifyAdmin).
              if (!scheduleWasReused) {
                // Re-run the occupancy read now that the insert is COMMITTED,
                // under the date locks (see recheckCallBookingConflicts for
                // why this one is authoritative where the in-txn read is
                // only a fast path) — one probe PER ROW this call created:
                // the primary, and the follow-up child against its OWN
                // date/window (merely excluding it from the primary's query
                // left an overlap on the follow-up's own date fireless).
                // The helper applies excludeCustomerId to the PRIMARY probe
                // ONLY — the in-txn same-day guard vets same-customer rows
                // on the primary's date and no other, so the follow-up's
                // probe must keep the customer's own visits in view (a +14d
                // follow-up over the customer's existing visit that day is
                // exactly the card the office needs). This run's own fresh
                // rows stay excluded from every probe. Best-effort in the
                // same spirit as the in-txn read — a recheck failure falls
                // back to the in-txn findings rather than dropping an
                // already-detected card.
                try {
                  const recheckVisits = [{
                    id: svc.id,
                    role: 'primary',
                    scheduledDate,
                    windowStart: windowStart || '09:00',
                    windowEnd: windowEnd || '10:00',
                  }];
                  if (followUpCreated) {
                    recheckVisits.push({
                      id: followUpCreated.id,
                      role: 'follow_up',
                      // returning('*') hands scheduled_date back as a Date —
                      // normalize to the 'YYYY-MM-DD' the lock key + DATE
                      // predicate expect.
                      scheduledDate: callBookingDateOnly(followUpCreated.scheduled_date),
                      windowStart: followUpCreated.window_start,
                      windowEnd: followUpCreated.window_end,
                    });
                  }
                  bookingTimeConflicts = await recheckCallBookingConflicts({
                    visits: recheckVisits,
                    excludeCustomerId: customerId,
                    excludeServiceIds: [svc.id, followUpCreated?.id],
                  });
                } catch (recheckErr) {
                  logger.warn(`[call-proc] post-commit occupancy recheck failed for ${maskSid(callSid)} (falling back to in-txn advisory findings): ${recheckErr.message}`);
                }
                const timeSanityFlags = callBookingTimeSanityFlags({
                  scheduledDate,
                  windowStart: windowStart || '09:00',
                  // Same end/duration the visit row above was written with,
                  // so the card flags a visit that RUNS past close, not just
                  // one that starts after it.
                  windowEnd: windowEnd || '10:00',
                  durationMinutes: callBookingCatalogRow?.default_duration_minutes
                    || DEFAULT_CALL_BOOKING_DURATION_MINUTES,
                });
                if (bookingTimeConflicts.length || timeSanityFlags.length) {
                  const conflictFlag = bookingTimeConflicts.length
                    ? 'booking_time_conflict'
                    : 'booking_out_of_hours';
                  await db('triage_items')
                    .insert(buildTriageItem({
                      callLogId: call.id,
                      flag: conflictFlag,
                      extraction: v2ApprovedExtraction || undefined,
                      severity: 'advisory',
                      extraPayload: {
                        scheduled_service_id: svc.id,
                        scheduled_date: scheduledDate,
                        window_start: windowStart || '09:00',
                        // The end is what the ends_after_business_hours flag
                        // is about — the card is unreadable without it.
                        window_end: windowEnd || '10:00',
                        service: svc.service_type,
                        conflicting_visits: bookingTimeConflicts.map((r) => ({
                          id: r.id,
                          customer_id: r.customer_id,
                          window_start: r.window_start,
                          window_end: r.window_end,
                          service_type: r.service_type,
                          status: r.status,
                          // WHICH of this call's rows it clashes — the
                          // office can't act on "overlap" without knowing
                          // whether it's visit 1 or the +14d follow-up. The
                          // in-txn fallback rows carry no annotation; they
                          // were probed against the primary's window only.
                          overlaps_visit: r.overlaps_visit || 'primary',
                          // A follow-up clash can be with THIS customer's
                          // own existing visit (the recheck only customer-
                          // excludes the primary's probe) — without the
                          // marker the card reads as a cross-customer
                          // double-booking. In-txn fallback rows were
                          // customer-excluded, so false is honest there.
                          same_customer: r.same_customer || false,
                        })),
                        // The follow-up child this call created (when one
                        // was), so a follow_up-tagged clash above resolves
                        // to a concrete visit on the card.
                        follow_up: followUpCreated ? {
                          scheduled_service_id: followUpCreated.id,
                          scheduled_date: callBookingDateOnly(followUpCreated.scheduled_date),
                          window_start: followUpCreated.window_start,
                          window_end: followUpCreated.window_end,
                        } : null,
                        time_sanity_flags: timeSanityFlags,
                      },
                    }))
                    .onConflict(db.raw('(call_log_id, reason_code) WHERE status IN (\'open\', \'in_progress\')'))
                    .ignore()
                    .catch((triageErr) => logger.warn(`[call-proc] booking-conflict triage insert failed for ${maskSid(callSid)}: ${triageErr.message}`));
                  try {
                    const conflictBits = [];
                    if (bookingTimeConflicts.length) {
                      let overlapBit = `overlaps ${bookingTimeConflicts.length} existing visit${bookingTimeConflicts.length === 1 ? '' : 's'}`;
                      // Say WHICH created visit clashes when the follow-up
                      // child is involved — the headline names the primary's
                      // date, so a follow-up-date clash is unreadable
                      // without the attribution.
                      const followUpClashes = bookingTimeConflicts.filter((r) => r.overlaps_visit === 'follow_up').length;
                      if (followUpClashes) {
                        const followUpDate = callBookingDateOnly(followUpCreated?.scheduled_date);
                        overlapBit += followUpClashes === bookingTimeConflicts.length
                          ? ` (all on the follow-up visit's date${followUpDate ? `, ${followUpDate}` : ''})`
                          : ` (${followUpClashes} on the follow-up visit's date${followUpDate ? `, ${followUpDate}` : ''})`;
                      }
                      // Same-customer clashes (follow-up over the customer's
                      // own existing visit) read very differently from a
                      // cross-customer double-booking — say so.
                      const sameCustomerClashes = bookingTimeConflicts.filter((r) => r.same_customer).length;
                      if (sameCustomerClashes) {
                        overlapBit += sameCustomerClashes === bookingTimeConflicts.length
                          ? " — the customer's own existing visit"
                          : ` — ${sameCustomerClashes} of them the customer's own existing visit${sameCustomerClashes === 1 ? '' : 's'}`;
                      }
                      conflictBits.push(overlapBit);
                    }
                    if (timeSanityFlags.includes('outside_business_hours')) conflictBits.push('outside 8am–5pm');
                    if (timeSanityFlags.includes('weekend')) conflictBits.push('on a weekend');
                    await require('./notification-service').notifyAdmin(
                      'schedule',
                      bookingTimeConflicts.length ? 'Call booking overlaps the schedule' : 'Call booking outside normal hours',
                      `Phone-booked ${svc.service_type || 'visit'} on ${scheduledDate} at ${windowStart || '09:00'} ${conflictBits.join(' and ')} — review it on the dispatch board.`,
                      {
                        link: '/admin/dispatch',
                        metadata: {
                          scheduledServiceId: svc.id,
                          followUpScheduledServiceId: followUpCreated?.id || null,
                          callSid,
                          conflicting_visit_ids: bookingTimeConflicts.map((r) => r.id),
                          time_sanity_flags: timeSanityFlags,
                        },
                      },
                    );
                  } catch (notifyErr) {
                    logger.warn(`[call-proc] booking-conflict admin notify failed for ${maskSid(callSid)}: ${notifyErr.message}`);
                  }
                }
              }
              if (attachedManualBookingId && attachSkippedFollowUpPlan) {
                // The call promised a follow-up treatment, but the primary is
                // a human's booking so no AI child was created (a manually
                // planned visit 2 would be a standalone row the child-dedup
                // guard can't see). Surface it — visit 2 is booked by hand.
                await db('triage_items')
                  .insert(buildTriageItem({
                    callLogId: call.id,
                    flag: 'attached_booking_followup_unbooked',
                    extraction: v2ApprovedExtraction || v2CanonicalExtraction || undefined,
                    severity: 'advisory',
                    extraPayload: {
                      scheduled_service_id: svc.id,
                      scheduled_date: svc.scheduled_date || null,
                      service: svc.service_type || null,
                    },
                  }))
                  .onConflict(db.raw('(call_log_id, reason_code) WHERE status IN (\'open\', \'in_progress\')'))
                  .ignore()
                  .catch((triageErr) => logger.warn(`[call-proc] attached-booking follow-up triage insert failed for ${maskSid(callSid)}: ${triageErr.message}`));
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

          // SMS cleared ONLY by IMPLIED inbound consent, the resolved target
          // isn't the caller's own number, AND the ANI itself is undialable —
          // there is no consented SMS recipient. Hold the SMS LEG ONLY: the
          // TCPA gate still allowed email, and deliverConfirmationByChannel
          // below is the sole reader of the email/both confirmation
          // preference, so the send path must still run with the SMS attempt
          // suppressed. The office confirms the number via the review card.
          // (A dialable ANI redirects to the caller instead — see
          // smsRecipient. Sends cleared by explicit sms_consent_given or by
          // the legacy V2-off path go to the resolved customer phone.)
          const holdImpliedSmsLeg = v2SmsClearedByImpliedConsent && !smsTargetIsInboundAni && !redirectImpliedToAni;
          if (scheduledServiceId && !v2SmsBlocked && holdImpliedSmsLeg) {
            logger.info(`[call-proc] Holding confirmation SMS leg for ${callSid}: implied consent doesn't cover non-ANI recipient and the ANI is undialable (email leg unaffected)`);
            appointmentResult = { ...(appointmentResult || {}), smsSent: false, smsBlockedReason: 'implied_consent_non_ani_recipient' };
            // The appointment BOOKED with no confirmation TEXT and the number
            // needs confirming — that must reach the Needs Review inbox (the
            // approved-but-unbooked card below is skipped because the
            // schedule row exists).
            await db('triage_items')
              .insert(buildTriageItem({
                callLogId: call.id,
                flag: 'implied_consent_non_ani_recipient',
                extraction: v2ApprovedExtraction || undefined,
                severity: 'advisory',
                extraPayload: { scheduled_service_id: scheduledServiceId, confirmation_sms_sent: false },
              }))
              .onConflict(db.raw('(call_log_id, reason_code) WHERE status IN (\'open\', \'in_progress\')'))
              .ignore()
              .catch((e) => logger.warn(`[call-proc] held-confirmation triage insert failed for ${maskSid(callSid)}: ${e.message}`));
          }
          // Card-on-file spec §3 Phase 5.3, REORDERED by owner ruling
          // 2026-08-06: the card/Auto Pay link goes out FIRST, before the
          // confirmation text — right after the call, when the appointment
          // is top of mind (was: after the confirmation leg). Same
          // call-level TCPA clearance as before (Codex #2771 P1): a
          // v2-blocked or held-implied-consent call has no consented SMS
          // recipient, so it gets no card text either, and a redirected
          // implied-consent send goes to the resolved recipient (the
          // inbound caller who consented), never a non-consenting saved
          // number. The funnel owns the rest (gate, exemptions,
          // saved-method auto-secure, dedup, one-text-ever, the email leg
          // riding a confirmed text) and is idempotent on reused/attached
          // rows. Dark until APPOINTMENT_CARD_REQUEST + the template flip.
          if (scheduledServiceId && !v2SmsBlocked && !holdImpliedSmsLeg) {
            // Durable clearance record (codex #3234 r3): this exact guard IS
            // the call-level SMS clearance decision, and nothing else
            // persists it — the pre-visit card backstop keys on this stamp
            // so a hold honored here stays honored days later. Covers fresh,
            // reused, and attached rows alike (the guard runs for all of
            // them). Best-effort: a failed stamp only makes the backstop
            // more conservative, never less.
            try {
              await db('scheduled_services')
                .where({ id: scheduledServiceId })
                .whereNull('call_sms_cleared_at')
                .update({
                  call_sms_cleared_at: new Date(),
                  // The number this clearance covers (codex r4): an
                  // implied-consent redirect points at the caller's ANI,
                  // not necessarily customers.phone — the backstop must
                  // reuse exactly this recipient.
                  call_sms_cleared_recipient: (smsRecipient || null),
                });
            } catch (clearErr) {
              logger.warn(`[call-proc] call-sms clearance stamp failed for visit ${scheduledServiceId}: ${clearErr.message}`);
            }
            try {
              const { requestCardForAppointment } = require('./appointment-card-request');
              await requestCardForAppointment({
                scheduledServiceId,
                trigger: 'ai_call_pipeline',
                recipientPhone: smsRecipient || null,
              });
            } catch (cardErr) {
              logger.warn(`[call-proc] card-request funnel failed for visit ${scheduledServiceId}: ${cardErr.message}`);
            }
          } else if (scheduledServiceId) {
            // No call-level SMS clearance (TCPA gate blocked, or the
            // implied-consent leg is held): run ONLY the funnel's
            // non-messaging side — the policy exemption + saved-card
            // auto-secure (appointment-card-request step 2). delivery 'none'
            // exits before any token mint or send, so the call-level verdict
            // that just blocked messaging cannot be bypassed on stored
            // consent (Codex #3361 r1+r3 P1). Deliberately NO
            // call_sms_cleared_at stamp and NO call-recipient override:
            // call-level clearance was not given, so the stamp the pre-visit
            // backstop keys on must not assert it.
            try {
              const { requestCardForAppointment } = require('./appointment-card-request');
              await requestCardForAppointment({ scheduledServiceId, trigger: 'ai_call_pipeline', delivery: 'none' });
            } catch (cardErr) {
              logger.warn(`[call-proc] card-request funnel (auto-secure-only path) failed for visit ${scheduledServiceId}: ${cardErr.message}`);
            }
          }
          // Only send the confirmation if the schedule row landed. A
          // v2-TCPA-blocked call (SMS consent not captured) still routes
          // through the channel-aware delivery below with its SMS leg HELD —
          // an email/both-preference customer keeps the email confirmation
          // (AGENTS: TCPA consent before any SMS, email fallback; Codex
          // #3361 P1). Default-'sms' customers stay silent exactly as
          // before. Only full do-not-contact (email blocked too) skips
          // entirely — keeping scheduledServiceId either way: the schedule
          // row EXISTS, and dropping the id made the downstream
          // approved-but-unbooked audit read this as a skipped booking,
          // starving the assessment pre-draft hook.
          if (scheduledServiceId && v2SmsBlocked && v2EmailBlocked) {
            logger.info(`[call-proc] Skipping confirmation for ${callSid}: v2 TCPA gate blocked (SMS + email)`);
            appointmentResult = { ...(appointmentResult || {}), scheduledServiceId, smsSent: false, smsBlockedReason: 'v2_tcpa_gate' };
          } else if (scheduledServiceId) {
            if (!scheduleWasReused) {
              // The row landed, so the v2 factory can mint the REAL
              // appointment-page link (lazy: only runs when the gate is on
              // and the _v2 row is active). Legacy body unchanged.
              const { renderAppointmentPageTemplate, confirmationArrivalWindow } = require('./appointment-reminders');
              smsBody = await renderAppointmentPageTemplate('appointment_confirmation',
                async () => {
                  const { buildAppointmentLink } = require('./appointment-link');
                  const apptLink = await buildAppointmentLink(scheduledServiceId, { customerId });
                  // The v2 body quotes the 2-hour arrival window, resolved
                  // from the BOOKED row — parsedTime is the caller's
                  // extracted preference and can differ from what landed.
                  const window = await confirmationArrivalWindow({ scheduledServiceId });
                  return {
                    first_name: firstName,
                    service_type: serviceType,
                    date: parsedDate,
                    time: parsedTime,
                    window,
                    appointment_line: apptLink.line,
                  };
                },
                {
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

              // Content-level dedup: even if the concurrent-run guard
              // misses (e.g., admin reprocess inside the same minute),
              // don't fire an identical confirmation the customer just got.
              // Dedupe against the ACTUAL recipient (smsRecipient) — an
              // implied-consent send redirected to the ANI must be found
              // here on a reprocess/retry, or the caller texts twice.
              try {
                const existing = await db('sms_log')
                  .where({ to_phone: smsRecipient, message_type: 'confirmation' })
                  .where('message_body', smsBody)
                  .where('created_at', '>', new Date(Date.now() - 10 * 60 * 1000))
                  .first();
                if (existing) alreadySent = true;
              } catch { /* sms_log query issue — send anyway */ }
            }

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
                // The v2 TCPA gate blocks the text outright (the smsAttempt
                // stub below returns blocked without sending) while email
                // stays permitted: let the default-'sms' channel fall back to
                // the confirmation email instead of leaving the newly live
                // booking with no immediate confirmation at all (Codex #3361
                // r21 P1). Deliberately NOT set for the implied-consent
                // non-ANI hold — that path files its own Needs Review card so
                // the office confirms the number first.
                smsPermanentlyBlocked: v2SmsBlocked && !v2EmailBlocked,
                smsAttempt: async () => {
                  smsRan = true;
                  let confirmationRearmed = false;
                  // SMS leg held (implied consent with no consented
                  // recipient, or the v2 TCPA gate blocked SMS): skip only
                  // the primary text — the channel email leg and the gated
                  // fan-out/email-only legs below still run (their own
                  // consent gates: explicit-consent for SMS fan-out,
                  // v2EmailBlocked for the email slots). The held codes
                  // never match QUIET_HOURS_HOLD, so the 8 AM sweep re-arm
                  // below cannot resurrect a consentless text.
                  const sendResult = (holdImpliedSmsLeg || v2SmsBlocked)
                    ? {
                      sent: false,
                      blocked: true,
                      code: holdImpliedSmsLeg ? 'implied_consent_non_ani_recipient' : 'v2_tcpa_gate',
                    }
                    : await sendCustomerMessage({
                      to: smsRecipient,
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
                    // Send-window hold: this after-hours phone booking
                    // registered its reminder with sendConfirmation:false
                    // (this path owns the confirmation), so nothing would
                    // retry a held text and the customer never learns their
                    // visit is booked. Re-arm confirmation_sent so the
                    // 15-minute stranded-confirmation sweep delivers the
                    // standard confirmation at the 8:00 AM window open —
                    // same handoff as the estimate-accept flow.
                    if (sendResult.code === 'QUIET_HOURS_HOLD' && sendResult.deferred && scheduledServiceId) {
                      try {
                        const rearmed = await db('appointment_reminders')
                          .where({ scheduled_service_id: scheduledServiceId })
                          .where({ cancelled: false })
                          .update({ confirmation_sent: false, confirmation_sent_at: null, updated_at: new Date() });
                        if (rearmed > 0) {
                          // The sweep's canonical confirmation fans out to
                          // EVERY appointment contact — the secondary loop
                          // below must not also queue held copies, or those
                          // contacts get both at 8:00 AM. ONLY when a row
                          // actually re-armed: reminder registration is
                          // best-effort (registerScheduleSideEffects
                          // swallows its failure), so a 0-row update means
                          // NO sweep row owns delivery and the secondary
                          // rail must stay active.
                          confirmationRearmed = true;
                          logger.info(`[call-proc] Confirmation for ${scheduledServiceId} held (send window) — re-armed for the stranded-confirmation sweep`);
                        } else {
                          logger.warn(`[call-proc] Confirmation for ${scheduledServiceId} held (send window) but NO reminder row to re-arm — held secondaries will queue individually`);
                        }
                      } catch (rearmErr) {
                        logger.error(`[call-proc] confirmation re-arm failed for ${scheduledServiceId}: ${rearmErr.message}`);
                      }
                    }
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
                  // The SMS legs require EXPLICIT sms_consent_given: implied
                  // inbound consent is personal to the caller and never
                  // authorizes texting a separate service-contact recipient
                  // (buyer/tenant/realtor). The email-only leg below sends no
                  // SMS, so it is NOT gated on SMS consent — only on the
                  // confirmation opt-out and the do-not-contact email block.
                  if (process.env.GATE_CALL_SECONDARY_CONTACT === 'true') {
                    try {
                      const { getAppointmentContacts, isServiceContactRole } = require('./customer-contact');
                      const freshCustomer = await db('customers').where({ id: customerId }).first();
                      const prefsRow = await db('notification_prefs').where({ customer_id: customerId }).first() || {};
                      const fanLast10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);
                      const { filterRecipientsByOptin } = require('./recipient-optin');
                      const extraContacts = !v2SmsConsentExplicit ? [] : (await filterRecipientsByOptin(
                        getAppointmentContacts(freshCustomer || {}, prefsRow), customerId
                      )).filter((c) => c.phone && fanLast10(c.phone) !== fanLast10(smsPhone)
                        // Claim-failed phones fail CLOSED (no row ≠ grandfathered here).
                        && !optinClaimFailedPhones.has(fanLast10(c.phone)));
                      for (const contact of extraContacts) {
                        // Same ladder as the primary send; the schedule row
                        // exists by this point, so the factory mints the
                        // same appointment-page link.
                        const {
                          renderAppointmentPageTemplate: renderApptLadder,
                          confirmationArrivalWindow: contactArrivalWindow,
                        } = require('./appointment-reminders');
                        const contactFirst = String(contact.name || '').trim().split(/\s+/)[0] || firstName;
                        const contactBody = await renderApptLadder('appointment_confirmation',
                          async () => {
                            const { buildAppointmentLink } = require('./appointment-link');
                            const apptLink = await buildAppointmentLink(scheduledServiceId, { customerId });
                            const window = await contactArrivalWindow({ scheduledServiceId });
                            return {
                              first_name: contactFirst,
                              service_type: serviceType,
                              date: parsedDate,
                              time: parsedTime,
                              window,
                              appointment_line: apptLink.line,
                            };
                          },
                          {
                            first_name: contactFirst,
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
                        const contactResult = await sendCustomerMessage({
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
                        if (!contactResult.sent && contactResult.code === 'QUIET_HOURS_HOLD'
                          && contactResult.deferred && contactResult.nextAllowedAt
                          && confirmationRearmed) {
                          // Primary was held too and the confirmation sweep
                          // was successfully re-armed — its 8:00 AM canonical
                          // send fans out to every appointment contact, so a
                          // queued copy here would double-text this contact.
                          logger.info(`[call-proc] held ${contact.role} confirmation NOT queued — re-armed sweep owns delivery to all contacts`);
                        } else if (!contactResult.sent && contactResult.code === 'QUIET_HOURS_HOLD'
                          && contactResult.deferred && contactResult.nextAllowedAt) {
                          // The primary confirmation reached Twilio before the
                          // 20:00 cutoff but THIS contact's send crossed it —
                          // re-arming the whole confirmation would duplicate
                          // the delivered primary, so persist only the held
                          // secondary on the scheduled-SMS rail. NO
                          // refresh_customer_phone: this row belongs to the
                          // CONTACT's phone; a send-time swap to the account
                          // holder's number would misdeliver. The reprocess
                          // dedupe above also matches this queued row (same
                          // phone/type/body), so a re-run can't double-queue.
                          try {
                            const TWILIO_NUMBERS = require('../config/twilio-numbers');
                            await db('sms_log').insert({
                              customer_id: customerId,
                              direction: 'outbound',
                              from_phone: TWILIO_NUMBERS.getOutboundNumber(),
                              to_phone: contact.phone,
                              message_body: contactBody,
                              status: 'scheduled',
                              scheduled_for: new Date(contactResult.nextAllowedAt),
                              message_type: 'confirmation',
                              metadata: JSON.stringify({
                                entry_point: 'call_booking_contact_confirmation_deferred',
                                scheduled_service_id: scheduledServiceId,
                                appointment_contact_role: contact.role,
                                original_block_code: contactResult.code,
                                replay_purpose: 'appointment_confirmation',
                                resolve_from_by_customer: true,
                              }),
                            });
                            logger.info(`[call-proc] Appointment SMS to ${contact.role} held outside the 8AM-8PM ET send window — queued for ${contactResult.nextAllowedAt}`);
                          } catch (queueErr) {
                            logger.error(`[call-proc] held contact-confirmation requeue failed for ${contact.role} (customer ${customerId}): ${queueErr.message}`);
                          }
                        } else if (!contactResult.sent) {
                          logger.warn(`[call-proc] Appointment SMS fan-out to ${contact.role} blocked/failed for customer ${customerId}: ${contactResult.code || contactResult.reason || 'unknown'}`);
                        } else {
                          logger.info(`[call-proc] Appointment SMS fanned out to ${contact.role} for customer ${customerId}`);
                        }
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
                      // v2EmailBlocked (do-not-contact) suppresses the email
                      // leg the same way the TCPA gate suppresses SMS.
                      const confirmationOptedOut = prefsRow?.appointment_confirmation === false;
                      const { getServiceContactSlots } = require('./customer-contact');
                      const emailOnlySlots = (confirmationOptedOut || v2EmailBlocked) ? [] : getServiceContactSlots(freshCustomer || {})
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
              if (smsRan && confirmationReached && appointmentResult && appointmentResult.smsBlocked) {
                // The blocked text was rescued by an email leg (the TCPA
                // fallback above, or a 'both' channel's email) — record it so
                // the route-decision log doesn't read as "never notified".
                appointmentResult.emailSent = true;
              }
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
        // The schedule row can already exist (insert-first contract): a
        // confirmation/SMS failure must not erase its id — the
        // approved-but-unbooked audit would read a real booking as skipped
        // and the assessment pre-draft hook below would starve.
        appointmentResult = { error: err.message, ...(scheduledServiceId ? { scheduledServiceId, smsSent: false } : {}) };
      }
    }

    // The "collect the email" card belongs to the CALL, not to the booking
    // (codex round-20 P2, generalized in round-22 P2). EVERY branch above
    // that ends without a schedule row short-circuits the customer-validation
    // path — v2 routing blocked, an unsupported service, an unavailable
    // generic fallback, an outbound call — and in each of them an email-less
    // caller previously got only the OTHER card, leaving whoever completes
    // the booking by hand unaware the email is missing. Filing it once here,
    // after the chain and keyed on "no booking was created", covers all of
    // them without a third copy of the rule; the creation branch keeps its
    // own filing because it runs post-backfill, where a secondary-contact
    // slot email may have satisfied the requirement in the meantime.
    //
    // Reads the stored row rather than backfilling: these paths must not
    // write to the customer record, and the validator already merges the
    // call's own captured email, so a caller who DID give one gets no card.
    // The open-row conflict clause makes a second insert a no-op. Card
    // failure never changes the call outcome.
    // Keyed on "no schedule row was created", NOT on appointmentResult being
    // truthy (codex round-24 P2): a confirmed email-less call with no
    // preferred_date_time — or only a vague time — leaves every branch above
    // unentered, so appointmentResult stays undefined and requiring it
    // skipped exactly the held bookings the office has to finish by hand.
    if (customerId && !appointmentResult?.scheduleCreated) {
      try {
        const unbookedCustomer = await db('customers').where({ id: customerId }).first();
        if (unbookedCustomer
          && validatePhoneCallAppointmentCustomer(unbookedCustomer, extracted, contactPhone).advisory?.includes('email')) {
          await db('triage_items')
            .insert(buildTriageItem({
              callLogId: call.id,
              flag: 'customer_email_missing',
              extraction: v2ApprovedExtraction || undefined,
              severity: 'advisory',
            }))
            .onConflict(db.raw('(call_log_id, reason_code) WHERE status IN (\'open\', \'in_progress\')'))
            .ignore();
        }
      } catch (e) {
        logger.warn(`[call-proc] email-missing advisory insert failed for ${maskSid(callSid)}: ${e.message}`);
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
      const heldReasons = new Set(['existing_appointment_same_date', 'ambiguous_existing_appointment', 'auto_booking_previously_cancelled', 'open_reservice_callback_exists', 'reservice_eligibility_lapsed', 'reservice_property_uncovered']);
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
          // Same-run outcome update: targets the row THIS process wrote
          // moments ago, so the CURRENT version only (a reprocess writes —
          // and updates — its own fresh v2-1.1.0 row).
          .where({ call_log_id: call.id, decision_version: V2_DECISION_VERSION, mode: 'enforce' })
          .update({
            final_action_taken: bookedServiceId ? 'auto_route' : 'auto_route_skipped',
            ...(bookedServiceId ? { created_scheduled_service_id: bookedServiceId } : {}),
          });
      } catch (rdErr) {
        logger.warn(`[call-proc] route_decisions outcome update failed for ${maskSid(callSid)}: ${rdErr.message}`);
      }
    }

    // Booking-triggered estimate pre-draft (GATE_ESTIMATOR_BOOKING_PREDRAFTS,
    // default OFF): a phone-booked Waves Assessment (the fail-open catch-all)
    // seeds a draft through the FULL engine call context. Self-filtering
    // (non-assessment bookings return skipped) and fire-and-forget — never
    // blocks call processing. Sequenced AFTER the quote lane's engine run
    // settles so the paid composer never runs twice concurrently: for a
    // call the engine already drafted, the delegation's early
    // existing-draft path re-notifies with quotePromised=true (an
    // assessment booking IS an owed quote — the initial launch may have
    // run quote-requested-only) and the booking linkage merges in;
    // otherwise this is the first and only engine run for the call.
    if (appointmentResult?.scheduledServiceId) {
      try {
        const { bookingPreDraftsEnabled, maybePreDraftForBooking } = require('./estimator-engine/booking-predraft');
        if (bookingPreDraftsEnabled()) {
          const preDraftBookingId = appointmentResult.scheduledServiceId;
          void (estimatorEnginePromise || Promise.resolve())
            .catch(() => {})
            // THIS pass's identity rides the delegation (codex P1, PR
            // #3304 — generation-rework GH round): the hook runs after the
            // engine promise settles — often after finalization clears the
            // token — and without the generation the delegated pass-start
            // clear could not retire this pass's own (or an older)
            // generation-stamped draft block.
            .then(() => maybePreDraftForBooking(preDraftBookingId, {
              ownerProcToken: procToken,
              ownerProcGeneration: procGeneration,
            }))
            .then((outcome) => {
              if (outcome?.drafted) {
                logger.info(`[call-proc] assessment pre-draft created for ${maskSid(callSid)} (estimate ${outcome.estimateId})`);
              }
            })
            .catch((err) => logger.warn(`[call-proc] assessment pre-draft failed for ${maskSid(callSid)}: ${err.message}`));
        }
      } catch (predraftErr) {
        logger.warn(`[call-proc] assessment pre-draft hook unavailable: ${predraftErr.message}`);
      }
    }

    // Step 6: Enroll in the local new_lead automation sequence.
    // Variable name kept as `beehiivResult` for schema/log continuity;
    // carries the local enrollment result now.
    let beehiivResult = null;
    // Ledger-write outcomes for the two hold sites — null means the durable
    // record FAILED (after internal retries) and the end-of-run
    // reconciliation must re-attempt it (Codex #3084 r8): the ledger row is
    // the only thing the release paths read.
    let dripHoldRecorded = null;
    let newsletterHoldRecorded = null;
    if (customerId && extracted.email && v2EmailBlocked) {
      logger.info(`[call-proc] Skipping new_lead automation enroll for ${callSid}: v2 TCPA gate blocked all outbound (do_not_contact)`);
      beehiivResult = { skipped: 'v2_tcpa_gate' };
    } else if (customerId && extracted.email
        && (emailReviewHeldThisRun || await shouldHoldLeadEmailEnrollment(call.id, { procToken, callSid, extractedEmail: extracted.email }))) {
      // Owner rule 2026-07-30 (the spelled-email bounce incident): a
      // call-captured email flagged for read-back (email_unverified /
      // email_invalid) is a transcription GUESS — the live incident's
      // spelled-out address hard-bounced within a minute of the first drip
      // send, burning sender reputation and landing a SendGrid suppression
      // on a wrong address. Hold the first-touch drip until the office
      // confirms the address; the fanout resumes it on confirmation. The
      // in-run flag covers a failed review-card insert; the DB check covers
      // admin force-reprocess after the run.
      logger.info(`[call-proc] Skipping new_lead automation enroll for ${maskSid(callSid)}: extracted email is under read-back review`);
      beehiivResult = { skipped: 'email_under_review' };
      // Ledger row carries the address ACTUALLY held (post dictation/
      // arbiter/domain correction) — the release engine sends to this, never
      // to a matched customer's stale stored email. runStartedAt lets the
      // helper keep a live earlier-run card's address (the one the operator
      // is reviewing) instead of overwriting it with a fresh unreviewed guess.
      // Token-fenced with the claim held THROUGH the merge (Codex #3084
      // r44/r45): a stale worker must not merge its extraction over the
      // reclaiming peer's ledger record. null keeps the end-of-run retry
      // eligible (which re-checks ownership itself).
      dripHoldRecorded = await recordFirstTouchHoldOwned(
        { callLogId: call.id, customerId, heldEmail: extracted.email, heldDrip: true, runStartedAt: processingStartedAt },
        procToken,
      );
    } else if (customerId && !extracted.email && extracted.email_raw && !v2EmailBlocked
        && (emailReviewHeldThisRun || await shouldHoldLeadEmailEnrollment(call.id, { procToken, callSid, extractedEmail: extracted.email }))) {
      // A DEMOTED address (dictation policy moved the unconfirmed guess to
      // email_raw) still owes this customer the first-touch drip once the
      // office confirms the real spelling (Codex #3084 r18): without a
      // held_drip row the email-correction fanout would resume only the
      // newsletter hold Step 8 records. The EMPTY held address is inert to
      // every automated release — the invalid-address guard blocks sends
      // and the sweep skips empty-address rows — so only the correction's
      // explicit address releases it.
      logger.info(`[call-proc] Skipping new_lead automation enroll for ${maskSid(callSid)}: extracted email was demoted to read-back review`);
      beehiivResult = { skipped: 'email_under_review' };
      // Token-fenced through the merge (r44/r45) — see the primary
      // drip-hold site above.
      dripHoldRecorded = await recordFirstTouchHoldOwned(
        { callLogId: call.id, customerId, heldEmail: '', heldDrip: true, runStartedAt: processingStartedAt },
        procToken,
      );
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

    // A RETRY run (extraction_failed → reprocess) re-enters with
    // call_log.customer_id already persisted by the failed attempt, so the
    // creation branch above never rebuilds newsletterCandidate — and the
    // whole newsletter chain below would be skipped, leaving the
    // call-created customer without a DOI or a held_newsletter flag forever
    // (Codex #3084 r20). Reconstruct the candidate for customers CREATED BY
    // THIS CALL (durable provenance marker below, r23), reading the CURRENT
    // stored email so a correction made during the failed window wins.
    // Matched pre-existing customers keep the old behavior: no
    // auto-subscribe.
    // Gated on the pre-claim processing_status (Codex #3084 r21):
    // `call.processing_status` was read BEFORE the claim, so it still says
    // whether THIS run is a recovery pass — the extraction_failed retry, or
    // a stale-claim reclaim ('processing': a worker died after persisting
    // customer_id but before the newsletter step, Codex #3084 r22). An
    // admin force reprocess of a PROCESSED call must not rebuild — its
    // subscribe path re-sends the pending DOI (confirmation_resent) on
    // every force.
    // Runs BEFORE Step 7's customer_interactions insert (Codex #3084 r39):
    // this block can THROW into the extraction_failed retry path, and the
    // unguarded timeline insert below is not idempotent — each replay
    // would duplicate the interaction entry, so the only throwing recovery
    // step sits ahead of it.
    if (!newsletterCandidate && customerId && !createdCustomerFromCall
        && ['extraction_failed', 'processing'].includes(call.processing_status)) {
      try {
        // ACTUAL call-creation provenance, not timestamps (Codex #3084
        // r23): the creation branch stamps created_customer_id into
        // call_log.metadata, so a customer someone else created between
        // the call row and the failed attempt (merely matched by it) can
        // never be classified as call-created and auto-subscribed.
        const rebuildMeta = typeof call.metadata === 'string'
          ? (() => { try { return JSON.parse(call.metadata); } catch { return {}; } })()
          : (call.metadata || {});
        const custRow = await db('customers').where({ id: customerId }).first('email', 'first_name', 'last_name');
        if (custRow && String(rebuildMeta?.created_customer_id || '') === String(customerId)) {
          // Honor DELIVERY EVIDENCE before rebuilding (Codex #3084
          // r46/r47): the dead worker may have died AFTER its DOI send but
          // before the final call_log status write — every recovery pass
          // would then take subscribeOrResubscribe's confirmation_resent
          // path and mail the same confirmation again. The evidence is the
          // POST-PROVIDER completion marker Step 8 stamps into
          // call_log.metadata only after sendConfirmationEmail returned —
          // never the subscriber's confirmation_sent_at, which is written
          // BEFORE the provider call and cannot prove delivery (r47): a
          // crash in that pre-stamp→send window now correctly REPLAYS the
          // send instead of stranding the customer pending forever.
          const doiRecentlySent = rebuildMeta?.newsletter_doi_sent_at
            && (Date.now() - new Date(rebuildMeta.newsletter_doi_sent_at).getTime()) < 24 * 60 * 60 * 1000;
          // A HELD newsletter released by ANY OTHER path is delivery
          // evidence too (Codex #3084 r48): the mid-run card release, the
          // triage resolve, the ledger sweep and the correction fanout all
          // send the held DOI through resumeHeldFirstTouch, and none of
          // them writes this run's post-provider marker — only Step 8's own
          // send does. Without the ledger a recovery pass on a call whose
          // hold was already released rebuilds the candidate and
          // subscribeNewCallCustomerToNewsletter mails confirmation_resent
          // to an inbox that just received the confirmation. The ledger IS
          // the durable per-call record: released_newsletter is written
          // only on a newsletterDelivered() outcome (the DOI went out, or
          // the helper deliberately skipped with nothing left to send), so
          // it is exactly the "nothing more to mail for this call" signal —
          // and unlike the marker it is untimed, because a released hold
          // settles the question permanently for this call.
          let ledgerReleased = false;
          if (!doiRecentlySent && await db.schema.hasTable('first_touch_holds')) {
            ledgerReleased = !!(await db('first_touch_holds')
              .where({ call_log_id: call.id, held_newsletter: true, released_newsletter: true })
              .first('id'));
          }
          if (doiRecentlySent || ledgerReleased) {
            newsletterResult = newsletterResult || { skipped: 'confirmation_recently_sent' };
            logger.info(`[call-proc] Skipping newsletter rebuild on retry — the held DOI already went out (${ledgerReleased ? 'hold ledger' : 'completion marker'}; ${maskSid(callSid)})`);
          } else {
            newsletterCandidate = {
              customerId,
              email: custRow.email || extracted.email || null,
              firstName: custRow.first_name || (extracted.first_name ? capitalizeName(extracted.first_name) : null),
              lastName: custRow.last_name || null,
            };
            logger.info(`[call-proc] Rebuilt newsletter candidate for call-created customer on retry (${maskSid(callSid)})`);
          }
        }
      } catch (rebuildErr) {
        logger.warn(`[call-proc] newsletter candidate rebuild failed for ${maskSid(callSid)}: ${rebuildErr.code || rebuildErr.name || 'db_error'}`);
        // A recovery run that cannot rebuild the candidate must NOT
        // finalize 'processed' (Codex #3084 r30): the retry sweep never
        // revisits a processed call, so a transient customers-read failure
        // here would permanently cost the call-created customer its DOI
        // and its durable held_newsletter record. Same contract as the
        // ledger-unavailable throw in the reconciliation below: land in
        // the outer procErr catch, which stamps extraction_failed with the
        // capped retry budget — this branch only runs on recovery passes,
        // so a normal first attempt is never affected.
        const recoverErr = new Error('newsletter_rebuild_unavailable');
        recoverErr.newsletterRebuildUnavailable = true;
        throw recoverErr;
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
    } else if (newsletterCandidate
        && (emailReviewHeldThisRun || await shouldHoldLeadEmailEnrollment(call.id, { procToken, callSid, extractedEmail: extracted.email }))) {
      // Same hold as the new_lead drip: the newsletter double-opt-in
      // confirmation is ALSO a first-touch email to the unconfirmed address.
      logger.info(`[call-proc] Skipping newsletter subscribe for ${callSid}: extracted email is under read-back review`);
      newsletterResult = { skipped: 'email_under_review' };
      // runStartedAt: if an operator already SETTLED this call's hold during
      // the run (email correction / accept verdict), the helper re-pends the
      // newsletter hold against that settled address — never the stale
      // in-memory candidate captured before the correction.
      // The hold's address is the CURRENTLY REVIEWED extraction — never the
      // candidate's stored email (Codex #3084 r21): on a retry run the
      // rebuilt candidate carries the customer's OLDER stored address, and
      // recording it here would let the new card's resolution release both
      // sends to an address the operator never read back. No extracted
      // email (demoted) → empty inert address, correction-only release.
      // Token-fenced through the merge (r44/r45) — see the drip-hold sites.
      newsletterHoldRecorded = await recordFirstTouchHoldOwned(
        { callLogId: call.id, customerId, heldEmail: extracted.email || '', heldNewsletter: true, runStartedAt: processingStartedAt },
        procToken,
      );
    } else if (newsletterCandidate) {
      const stillOwned = await db('call_log')
        .where({ id: call.id })
        .where('processing_token', procToken)
        .first('id');
      if (stillOwned) {
        try {
          newsletterResult = await subscribeNewCallCustomerToNewsletter(newsletterCandidate);
          if (newsletterResult?.confirmationEmailSent === true) {
            // POST-PROVIDER completion marker (Codex #3084 r47): the
            // subscriber's confirmation_sent_at is stamped BEFORE the
            // provider call, so it cannot prove delivery — this durable
            // per-call marker is written only after sendConfirmationEmail
            // returned, and the recovery rebuild keys its skip on it.
            // Token-fenced; best-effort: a lost write costs one duplicate
            // DOI on a recovery pass, never a missed one.
            try {
              await db('call_log')
                .where({ id: call.id })
                .where('processing_token', procToken)
                .update({
                  metadata: db.raw(
                    "jsonb_set(COALESCE(metadata, '{}'::jsonb), '{newsletter_doi_sent_at}', ?::jsonb, true)",
                    [JSON.stringify(new Date().toISOString())],
                  ),
                  updated_at: new Date(),
                });
            } catch (markErr) {
              logger.warn(`[call-proc] DOI completion marker write failed for ${maskSid(callSid)}: ${markErr.code || markErr.name || 'db_error'}`);
            }
          }
        } catch (e) {
          logger.warn(`[call-proc] Newsletter subscribe failed for customer ${newsletterCandidate.customerId}`);
          newsletterResult = { error: 'newsletter_subscribe_failed' };
        }
      } else {
        logger.warn(`[call-proc] Skipped newsletter subscribe for ${callSid} — ownership lost (peer reclaimed via stale-lock window).`);
      }
    }

    // Mid-run release race (Codex #3084 r3): the email review card is
    // inserted minutes before the customer link and the holds above — an
    // admin who accepts the visible card during THIS run resolves it while
    // the in-run flag still forces the hold, and no later release exists.
    // Reconcile at the end of the run: if anything was held but no live
    // card remains, release now (consent is re-checked inside the helper).
    if (customerId
        && (beehiivResult?.skipped === 'email_under_review' || newsletterResult?.skipped === 'email_under_review')) {
      try {
        // A hold without its ledger row is unreleasable — the release paths
        // read only first_touch_holds. If either write failed (after the
        // helper's own retries), re-attempt once more before the run can
        // finish (Codex #3084 r8).
        const dripHeld = beehiivResult?.skipped === 'email_under_review';
        const newsHeld = newsletterResult?.skipped === 'email_under_review';
        if ((dripHeld && dripHoldRecorded === null) || (newsHeld && newsletterHoldRecorded === null)) {
          // Token-fenced through the merge (Codex #3084 r44/r45): a lost
          // claim hands the ledger to the reclaiming peer's own run — the
          // retry (and its six-failures escalation) applies only while
          // this worker still owns the call.
          const retried = await recordFirstTouchHoldOwned({
            callLogId: call.id,
            customerId,
            // Currently reviewed extraction only (Codex #3084 r21) — a
            // rebuilt candidate's stored email must never become the held
            // target of a card the operator hasn't read back.
            heldEmail: extracted.email || '',
            heldDrip: dripHeld && dripHoldRecorded === null,
            heldNewsletter: newsHeld && newsletterHoldRecorded === null,
            runStartedAt: processingStartedAt,
          }, procToken);
          if (retried === 'claim_lost') {
            logger.info(`[call-proc] processing claim lost for ${maskSid(callSid)} — the reclaiming peer records the hold ledger`);
          } else if (retried === null) {
            logger.error(`[call-proc] first-touch hold ledger write STILL failing for ${maskSid(callSid)} — held send(s) have no durable release record`);
            // Six straight write failures — without this row the held
            // send(s) can never be released, so the run must NOT complete
            // as processed. Throwing lands in the outer procErr catch,
            // which stamps extraction_failed with the capped retry budget:
            // the sweep re-processes the call (reprocessing is
            // bounded-safe) and re-attempts the ledger write.
            const ledgerErr = new Error('first_touch_hold_ledger_unavailable');
            ledgerErr.holdLedgerUnavailable = true;
            throw ledgerErr;
          }
        }
        if (!(await shouldHoldLeadEmailEnrollment(call.id, { procToken, callSid, extractedEmail: extracted.email }))) {
          // No LIVE card. Two very different reasons (Codex #3084 r4):
          //   - an admin resolved the card mid-run → release now;
          //   - the card insert FAILED, so no card ever existed → the
          //     address is still unverified; persist the recovery marker
          //     and stay held (the standard resume paths release it).
          // Resolved DURING this run (Codex #3084 r6): a force-reprocess of
          // a call whose card resolved in an EARLIER cycle must not read
          // that historical row as a fresh operator confirmation.
          // Created BY this run too (Codex #3084 r49): when a force-reprocess
          // overlaps an OPEN card from an earlier cycle, this run's card
          // insert is absorbed by the partial unique index — the operator
          // who resolves that surviving card mid-run reviewed the OLD
          // cycle's payload, not this run's extraction, so a wall-clock
          // resolved_at test alone would release a newly extracted,
          // unverified address. Requiring the resolved card to have been
          // created after processingStartedAt binds the release to a card
          // whose payload THIS run wrote. The overlap case falls through to
          // the recovery-marker branch below: a fresh card describing the
          // current extraction is filed, the hold stays pending, and the
          // operator's resolve of THAT card releases it.
          const resolvedCard = await db('triage_items')
            .where({ call_log_id: call.id })
            .whereIn('reason_code', ['email_unverified', 'email_invalid'])
            .whereIn('status', ['resolved'])
            .where('resolved_at', '>=', processingStartedAt)
            .where('created_at', '>=', processingStartedAt)
            .first('id');
          if (resolvedCard) {
            // Scoped to THIS call (Codex #3084 r8): releasing by customerId
            // alone would claim every pending hold for the customer,
            // including other calls whose read-back cards are still open.
            const { resumeHeldFirstTouch } = require('./lead-first-touch-resume');
            await resumeHeldFirstTouch({ callLogId: call.id, customerId, source: 'mid_run_card_release' });
          } else {
            try {
            const { buildTriageItem } = require('./call-routing-gates');
            // The recovery card must SHOW the address it approves (Codex
            // #3084 r53): resolving it releases the drip/DOI to the run's
            // current extraction (the retarget below makes that the held
            // target), and the Needs Review card renders email_as_heard /
            // email_candidates / confirmation_question — a payload with
            // only the call summary asks the operator to approve an
            // address they never saw. Carry the dictation decoder's full
            // evidence when it exists, and always surface the current
            // extraction as a candidate so the release target is on the
            // card verbatim.
            const recoveryEmailEvidence = { ...(dictationEmailPayload || {}) };
            if (extracted.email) {
              const existingCandidates = Array.isArray(recoveryEmailEvidence.email_candidates)
                ? recoveryEmailEvidence.email_candidates : [];
              const heldLc = String(extracted.email).trim().toLowerCase();
              if (!existingCandidates.some((c) => String(c?.value || '').trim().toLowerCase() === heldLc)) {
                recoveryEmailEvidence.email_candidates = [{ value: extracted.email }, ...existingCandidates];
              }
            }
            // The WHOLE recovery — card insert, ledger retarget, claim
            // invalidation — rides ONE token-fenced transaction (Codex
            // #3084 r52, completing r51): a worker stalled past the
            // reclaim window must not file an extraction-A card that
            // absorbs the reclaiming peer's own insert (partial unique
            // index), must not overwrite the peer's held target, and must
            // not re-pend the peer's holds. Ownership lost = all three
            // abort; the owner's run records its own card and target.
            // Same r46 lock order — hold rows first, then the
            // token-conditioned call_log lock, then the card write.
            //
            // Retarget semantics (r50): the replacement card describes
            // THIS run's extraction — Step 6 preserved a prior cycle's
            // address while that cycle's card was still live, and with
            // the old card resolved mid-run, resolving the replacement
            // card would otherwise release the OLD — still unverified,
            // possibly hard-bounced — target. Pending/releasing rows
            // only (a released row's held_email is r19 delivery
            // evidence); never over an operator's explicit correction
            // (corrected_at, the r39 marker); no updated_at bump (the
            // r12 rule — the repen owns lease invalidation).
            const recoveryOwned = await db.transaction(async (trx) => {
              // Advisory lock FIRST (Codex #3084 r57): same rule as
              // mintEmailReviewCardsFenced — without it, this trx can own
              // the hold while an admin verdict holds the advisory lock
              // and bulk-resolves the fresh card the moment it commits,
              // releasing a target the operator never reviewed. Taking
              // lockTriageCall first serializes recovery-card creation
              // with every card writer.
              await lockTriageCall(trx, call.id);
              await trx('first_touch_holds')
                .where({ call_log_id: call.id })
                .forUpdate()
                .select('id');
              const owned = await trx('call_log')
                .where({ id: call.id })
                .where('processing_token', procToken)
                .forUpdate()
                .first('id');
              if (!owned) return false;
              await trx('triage_items')
                .insert(buildTriageItem({
                  callLogId: call.id,
                  flag: 'email_unverified',
                  extraction: { meta: { call_summary: extracted.call_summary || null } },
                  severity: 'advisory',
                  extraPayload: {
                    ...recoveryEmailEvidence,
                    hold_reason: 'review_card_insert_failed',
                    held_drip: beehiivResult?.skipped === 'email_under_review',
                    held_newsletter: newsletterResult?.skipped === 'email_under_review',
                  },
                }))
                .onConflict(db.raw('(call_log_id, reason_code) WHERE status IN (\'open\', \'in_progress\')'))
                .ignore();
              await trx('first_touch_holds')
                .where({ call_log_id: call.id })
                .whereIn('status', ['pending', 'releasing'])
                .whereNull('corrected_at')
                .update({ held_email: extracted.email || '' });
              // The recovery card is a live review too — invalidate any
              // in-flight release claim for the call (Codex #3084 r43),
              // inside the same fence (r52). A failure throws (r44), rolls
              // back the card and retarget with it, and the catch below
              // fails the run.
              const { repenHoldsForFreshEmailReview } = require('./lead-first-touch-resume');
              await repenHoldsForFreshEmailReview(call.id, trx);
              return true;
            });
            if (!recoveryOwned) {
              logger.info(`[call-proc] processing claim lost for ${maskSid(callSid)} — skipping the recovery card, retarget, and re-pend (the owner records them)`);
            }
            } catch (markerErr) {
              // Without this card the pending hold is invisible to
              // operators AND ineligible for the sweep (no resolved card
              // ever exists) — neither send would have a release trigger
              // left (Codex #3084 r17). Fail the run like the other
              // durable-state failures: the outer catch stamps
              // extraction_failed and the retry re-attempts the insert.
              logger.error(`[call-proc] end-of-run recovery card insert failed for ${maskSid(callSid)}: ${markerErr.message}`);
              const stateErr = new Error('email_review_state_unavailable');
              stateErr.emailReviewStateUnavailable = true;
              throw stateErr;
            }
          }
        }
      } catch (reconcileErr) {
        // Reconciliation is best-effort EXCEPT when durable hold state
        // cannot be persisted at all — an unwritable ledger or an
        // undeterminable review state with no recovery marker must fail the
        // run (retryable) rather than complete with an invisible hold.
        if (reconcileErr.holdLedgerUnavailable || reconcileErr.emailReviewStateUnavailable) throw reconcileErr;
        logger.warn(`[call-proc] first-touch hold reconciliation failed for ${maskSid(callSid)}: ${reconcileErr.message}`);
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
          // Same merged record the live lane consulted — the reconstruction
          // must agree with it, or the shadow metrics count a unit ask the
          // live pass suppressed.
          canonicalRecord: extracted,
        });
        finalFlags = mergeTriageFlags(modelFlags, deterministicFlags);
        routingResult = canAutoRoute(v2ExtractionForAudit, {
          contactPhone,
          addressValidation: v2AddressValidation,
          // Keep the audit/shadow decision consistent with the enforce path.
          failOpen: isEnabled('callFailOpenBooking') && !isOutboundCall(call),
          callerAni: contactPhone,
          knownCustomer: (knownCaller && knownCaller.isExistingCustomer) ? { hasAddress: knownCaller.hasAddress } : null,
          agentCommitFailOpen: isEnabled('callAgentCommitBooking') && !isOutboundCall(call),
          transcript: transcription,
          transcriptLabelsTrusted: isEnabled('callAgentCommitTrustedLabels'),
          callStartedAt: call.created_at,
        });
        // Mirror the enforce path's V1 address-conflict demotion — the saved
        // shadow decision must hold exactly where enforce would hold, or
        // rollout metrics overstate safe fail-open bookings.
        routingResult = demoteFailOpenOnV1AddressConflict(routingResult, extracted, knownCaller);

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
        validator: V2_DECISION_VERSION,
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
        ai_validation_model: v2ExtractionForAudit?.meta?.extraction_model || CALL_EXTRACTION_ROUTE.primary.model,
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

    const finalized = await db.transaction(async (trx) => {
      const written = await trx('call_log')
        .where({ id: call.id })
        .where('processing_token', procToken)
        .update({
          processing_status: finalStatus,
          processing_token: null,
          // Address unverifiable / caller-not-owner / missing surname, or a
          // customer-less recovery lead that failed to persist → open the call for
          // human review instead of letting it look fully processed.
          ...(bridgeNeedsConfirmation.length || finalStatus === 'lead_creation_failed' ? { review_status: 'open' } : {}),
          updated_at: new Date(),
        });
      // The non-lead verdict's attribution retire becomes durable HERE,
      // atomically with the final status (pre-push P0 r12) — never on the
      // earlier settle, whose pass could still have failed into a retry.
      if (written > 0 && !deferredNonLeadAttributionRetire && !isNonLeadCallContent(extracted)) {
        // A successful non-rejecting LEAD pass SUPERSEDES a previous
        // no-attribution verdict (pre-push P1 r15): without clearing the
        // marker, the bridge would never attribute the corrected call —
        // shouldRetryLeadAttribution exits on it forever. An ordinary
        // non-sales classification (pre-push P0 r8) is NOT such a
        // correction — it validates no attribution, so it must not
        // reopen a definitively rejected call to the bridge.
        {
          // The LIVE row, not the in-memory snapshot: the repair decision
          // below reads linkage state this pass may have just rewritten.
          const liveRow = await trx('call_log')
            .where({ id: call.id })
            .first('metadata', 'twilio_call_sid', 'to_phone');
          // ONLY the parse is guarded (codex P1 r21). Every database
          // statement below must PROPAGATE: a failed statement has already
          // aborted this transaction, so swallowing it would let the
          // callback return `written` and report a finalized call whose
          // status write, token clear and repair were all rolled back —
          // the same silent-rollback trap the attribution write refuses at
          // the runCallPpcAttribution site. A throw here lands in the
          // outer `catch (procErr)` extraction_failed retry lane.
          let mdRaw = null;
          try {
            mdRaw = typeof liveRow?.metadata === 'string'
              ? JSON.parse(liveRow.metadata)
              : (liveRow?.metadata || {});
          } catch { mdRaw = null; /* unparseable metadata: leave the marker, conservative */ }
          if (mdRaw && mdRaw.no_attribution) {
            // REPAIR, not just forgiveness (codex P1 r20): the earlier
            // rejection retired this call's funnel row, and when THIS pass
            // created no lead (shouldCreateLead false — e.g. the customer
            // has since advanced past the lead-pipeline stages)
            // runCallPpcAttribution is still its default no-op. A
            // bridge-target call gets a later rescan; a dedicated/organic
            // one never does, so clearing the marker alone would drop the
            // corrected inquiry's booked/completed revenue permanently.
            // Arm the SAME durable marker the repoint lane uses — the
            // transfer sweep already locks leads → call_log, re-verifies
            // the target, and completes exactly this write.
            let repairPayload = null;
            // A resolved leadId does NOT mean the repair is unnecessary
            // (codex P1 r26): the rejection demoted this call's row to
            // legacy, so runCallPpcAttribution refuses it as
            // 'unprovenanced_row' and writes nothing. Clearing the verdict
            // and its recorded lead ids here would then destroy the only
            // evidence of what to reclaim. Arm the marker in BOTH cases —
            // the sweep's repair branch re-points the demoted row — using
            // this pass's own lead when it has one.
            if (!mdRaw.attribution_transfer_pending) {
              // The lead the REJECTION itself recorded is authoritative
              // (codex P1 r21): a lead phone-REUSED before the root fix
              // carries neither this call's sid nor a stamp (stampThisPass
              // required !phone until then), so for those legacy calls
              // stamp/sid resolution alone silently finds no target —
              // exactly the linkage mode this repair exists to rescue.
              // Post-fix phone reuse stamps, so the mdRaw.lead_id arm
              // below now resolves for it too.
              // Only an unambiguous, still-live record is used; anything
              // else falls through to the durable-linkage arms.
              const recordedLeadIds = Array.isArray(mdRaw.no_attribution_lead_ids)
                ? [...new Set(mdRaw.no_attribution_lead_ids.filter(Boolean).map(String))]
                : [];
              let target = leadId ? String(leadId) : null;
              if (!target && recordedLeadIds.length === 1) {
                const recordedLead = await trx('leads')
                  .where({ id: recordedLeadIds[0] })
                  .whereNull('deleted_at')
                  .first('id');
                if (recordedLead) target = String(recordedLead.id);
              }
              if (!target && mdRaw.lead_id) target = String(mdRaw.lead_id);
              if (!target && liveRow?.twilio_call_sid) {
                // `leads.twilio_call_sid` is NOT unique, and this query is
                // not the processor's authoritative newest-first
                // resolution — an arbitrary pick would move the corrected
                // call's history onto the wrong lead. Require a UNIQUE
                // live match and otherwise fail closed to a plain clear
                // (codex P1 r21).
                const sidLeads = await trx('leads')
                  .where({ twilio_call_sid: liveRow.twilio_call_sid })
                  .whereNull('deleted_at')
                  .limit(2)
                  .select('id');
                if (sidLeads.length === 1) target = String(sidLeads[0].id);
              }
              if (target) {
                const { row: repairSource } = await resolveCallLeadSource({
                  dbc: trx,
                  toPhone: liveRow.to_phone,
                  preferReferral: !!referrerNameFromExtracted(extracted),
                });
                const repairAttr = repairSource
                  ? require('./ads/call-attribution').attributionForSourceType(repairSource.source_type)
                  : null;
                // Bridge-target numbers are excluded exactly as the
                // primary writer excludes them — the bridge owns their
                // attribution and rescans on its own schedule.
                const repairIsBridge = repairSource
                  && require('./ads/google-call-bridge').isBridgeTargetNumber(repairSource.twilio_phone_number);
                if (repairAttr && !repairIsBridge) {
                  repairPayload = {
                    to_lead_id: target,
                    lead_source: repairAttr.leadSource,
                    is_paid: repairAttr.isPaid,
                    detail: repairSource.name || 'inbound call',
                    service_interest: extracted.matched_service || extracted.requested_service || null,
                    repair_of_rejection: true,
                  };
                  // The EXACT row the rejection demoted on this lead
                  // (codex P1 r32) — the sweep's reclaim is conditioned
                  // on this identity, never on "some legacy row on the
                  // lead": a reused lead's pre-migration or web
                  // acquisition row is unprovenanced too, and seizing it
                  // overwrites another acquisition's owner and
                  // dimensions. No recorded demote on this lead means
                  // there is nothing of this call's to reclaim.
                  const demotedRecorded = Array.isArray(mdRaw.no_attribution_demoted_rows)
                    ? mdRaw.no_attribution_demoted_rows.find(
                      (d) => d && d.id && String(d.lead_id) === String(target),
                    )
                    : null;
                  if (demotedRecorded) repairPayload.reclaim_row_id = String(demotedRecorded.id);
                }
              }
            }
            await trx('call_log').where({ id: call.id }).update({
              metadata: repairPayload
                ? db.raw(
                  "jsonb_set(COALESCE(metadata, '{}'::jsonb) - 'no_attribution' - 'no_attribution_lead_ids' - 'no_attribution_demoted_rows', '{attribution_transfer_pending}', ?::jsonb, true)",
                  [JSON.stringify(repairPayload)],
                )
                : db.raw("COALESCE(metadata, '{}'::jsonb) - 'no_attribution' - 'no_attribution_lead_ids' - 'no_attribution_demoted_rows'"),
            });
          }
        }
      }
      if (written > 0 && deferredNonLeadAttributionRetire) {
        // WHICH leads this rejection is about to strip, captured BEFORE
        // the retire clears the provenance that names them (codex P1 r21).
        // A phone-REUSED lead carries neither this call's sid nor a stamp,
        // so the verdict itself is the only place that still knows the
        // answer — without it a later corrected pass cannot tell what to
        // repair. Reassigned-to-successor rows are recorded too and cost
        // nothing: the repair's write then refuses as 'other_call' (the
        // lead is counted once by design) and the sweep clears the marker.
        const retiredLeadIds = [...new Set(
          (await trx('ad_service_attribution')
            .where({ source_call_id: call.id })
            .whereNotNull('lead_id')
            .select('lead_id'))
            .map((r) => String(r.lead_id)),
        )];
        // WHICH rows the retire DEMOTED to legacy, by exact id (codex P1
        // r32): a lead id alone is not enough for the later reclaim — a
        // reused lead can carry OTHER unprovenanced rows (pre-migration,
        // web acquisition), and "some legacy row on the lead" seized an
        // unrelated acquisition's row and overwrote its owner and
        // dimensions. Only a row this rejection itself demoted is provably
        // this call's history.
        const demotedRows = [];
        await require('./ads/call-attribution').retireAllCallAttributionRows(trx, call.id, { demoted: demotedRows });
        // Durable no-attribution verdict, same transaction (pre-push P1
        // r14): the google bridge would otherwise re-join this call's
        // sid-linked lead on its next scan and recreate the row just
        // retired. Spam/voicemail terminals are self-evident from
        // processing_status; the non-lead verdict finalizes 'processed'
        // and needs this marker.
        await trx('call_log')
          .where({ id: call.id })
          .update({
            metadata: (() => {
              if (!retiredLeadIds.length) {
                return db.raw(
                  "jsonb_set(COALESCE(metadata, '{}'::jsonb), '{no_attribution}', 'true'::jsonb, true)",
                );
              }
              if (!demotedRows.length) {
                return db.raw(
                  "jsonb_set(jsonb_set(COALESCE(metadata, '{}'::jsonb), '{no_attribution}', 'true'::jsonb, true), '{no_attribution_lead_ids}', ?::jsonb, true)",
                  [JSON.stringify(retiredLeadIds)],
                );
              }
              return db.raw(
                "jsonb_set(jsonb_set(jsonb_set(COALESCE(metadata, '{}'::jsonb), '{no_attribution}', 'true'::jsonb, true), '{no_attribution_lead_ids}', ?::jsonb, true), '{no_attribution_demoted_rows}', ?::jsonb, true)",
                [JSON.stringify(retiredLeadIds), JSON.stringify(demotedRows)],
              );
            })(),
          });
      }
      return written;
    });
    if (finalized === 0) {
      logger.warn(`[call-proc] Skipped final status write for ${callSid} — ownership lost (peer reclaimed via stale-lock window).`);
    } else if (finalStatus === 'customer_creation_failed') {
      logger.warn(`[call-proc] Marked ${callSid} customer_creation_failed — required customer fields were incomplete`);
    }

    // Zero-triage layers, fenced on finalization: finalized === 0 means a
    // peer reclaimed the processing_token — this attempt's extraction is
    // stale and must not record verdicts, stamp a disposition, or enrich.
    if (finalized > 0) {
      await applyZeroTriageLayers({ call, callSid, contactPhone, extracted, v2Result, appointmentResult, customerId, transcript: transcription });
    }

    // Reconcile-only draft-linkage pass, AFTER the fenced finalization
    // cleared processing_token (codex P0, PR #3304 GH r7b): the fallback
    // context this pass may need refuses a call whose token is still held
    // — running it earlier no-opped on the transient-context case. Fenced
    // on `finalized` for the same reason zero-triage is: a peer that
    // reclaimed the call owns the reconcile too. Never blocks the result.
    if (finalized > 0 && reconcileOnlyDraftLinksPending) {
      try {
        const { reconcileDraftLinksForCall, markReconcilePending } = require('./estimator-engine');
        const outcome = await reconcileDraftLinksForCall(call.id);
        if (outcome) logger.info(`[call-proc] reconcile-only draft-linkage pass for ${callSid}: ${outcome}`);
        // 'error' means the reconcile did NOT persist — and this call is
        // finalized, so nothing re-enters the pipeline on its own. Queue
        // the durable retry the scheduler sweep drains (local audit P0,
        // PR #3304); a queue write that itself fails is caught below and
        // logged — the pass stays non-blocking by contract.
        if (outcome === 'error') await markReconcilePending(call.id);
      } catch (recErr) {
        logger.warn(`[call-proc] reconcile-only draft-linkage pass failed (non-blocking): ${recErr.message}`);
        try {
          const { markReconcilePending } = require('./estimator-engine');
          await markReconcilePending(call.id);
        } catch { /* markReconcilePending never throws; belt-and-braces */ }
      }
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
        //
        // This write shares the extraction retry budget: without the
        // increment, a repeatable post-extraction error would come back
        // through the sweep every 10 minutes with attempts still 0 —
        // an uncapped retry loop over side-effect-laden code. Counting it
        // here caps that loop at CALL_EXTRACTION_MAX_ATTEMPTS and files the
        // same blocking card at the cap. (Re-running after partial side
        // effects is bounded-safe: the idempotency keys, won-status skips,
        // and same-date dup holds make reprocessing a supported operation.)
        const releasedRows = await db('call_log')
          .where({ id: call.id })
          .where('processing_token', procToken)
          .update({
            processing_status: 'extraction_failed',
            extraction_attempts: db.raw('COALESCE(extraction_attempts, 0) + 1'),
            processing_token: null,
            updated_at: new Date(),
          }).returning(['extraction_attempts']);
        if (!releasedRows.length) {
          logger.warn(`[call-proc] Skipped lock release for ${callSid} — ownership lost (peer reclaimed via stale-lock window).`);
        } else {
          const attempts = Number(releasedRows[0]?.extraction_attempts) || 0;
          await fileExtractionExhaustedTriage(call.id, attempts, procErr, callSid);
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
    //   - processing_status='extraction_failed' with retry budget left (extraction_attempts
    //     < CALL_EXTRACTION_MAX_ATTEMPTS) — 10-min age gate spaces the attempts so a
    //     provider brown-out isn't burned through in one cron tick. 7-day created_at fence:
    //     belt-and-suspenders with the migration backfill (which parks pre-existing failures
    //     at the cap) so ancient calls can never be resurrected into fresh leads/SMS.
    //   - processing_status='processing' but stale > 10 min (orphaned claim from crash/hang)
    // Duration filter uses recording_duration_seconds (set by the recording-status webhook)
    // with duration_seconds fallback, since the call-status webhook may not have populated
    // the latter yet — earlier filter on duration_seconds alone excluded fresh recordings.
    const pending = await db('call_log')
      .where(function () {
        this.where(function () {
          this.where('recording_url', '!=', '').whereNotNull('recording_url');
        })
        // PAN-quarantined rows keep recording_url NULL by design, but their
        // MASKED transcript still needs extraction/lead/appointment
        // processing — the webhook processes them immediately, and this
        // branch is the restart-safe backstop (Codex #2676 round-11 P1).
        // 10-min age gate lets the immediate path win.
        .orWhere(function () {
          this.whereRaw("(transcription_metadata::jsonb ->> 'pan_detected') = 'true'")
            .whereNotNull('transcription')
            .where(function () {
              this.whereNull('processing_status')
                .orWhere('processing_status', 'pending')
                // The immediate webhook processing can claim the row and
                // die — a stale 'processing' quarantined row must re-enter
                // the backstop too (round-12 P1).
                .orWhere(function () {
                  this.where('processing_status', 'processing')
                    .andWhereRaw("COALESCE(processing_started_at, updated_at) < NOW() - INTERVAL '10 minutes'");
                })
                // A transient extraction failure on a quarantined row must
                // keep its normal retry budget (round-13 P1): the outer
                // extraction_failed branch requires recording_url, which
                // quarantine keeps null by design.
                .orWhere(function () {
                  this.where('processing_status', 'extraction_failed')
                    .andWhereRaw('COALESCE(extraction_attempts, 0) < ?', [CALL_EXTRACTION_MAX_ATTEMPTS])
                    .andWhere('created_at', '>', db.raw("NOW() - INTERVAL '7 days'"));
                });
            })
            .andWhere('updated_at', '<', db.raw("NOW() - INTERVAL '10 minutes'"));
        });
      })
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
          this.where('processing_status', 'extraction_failed')
            .andWhereRaw('COALESCE(extraction_attempts, 0) < ?', [CALL_EXTRACTION_MAX_ATTEMPTS])
            .andWhere('updated_at', '<', db.raw("NOW() - INTERVAL '10 minutes'"))
            .andWhere('created_at', '>', db.raw("NOW() - INTERVAL '7 days'"));
        })
        .orWhere(function () {
          this.where('processing_status', 'processing')
            .andWhereRaw("COALESCE(processing_started_at, updated_at) < NOW() - INTERVAL '10 minutes'");
        });
      })
      .where(function () {
        this.where(db.raw('COALESCE(recording_duration_seconds, duration_seconds, 0) > ?', [10]))
          // Quarantined rows already proved they carry real content (a card
          // readback was heard) — never duration-filter them out.
          .orWhereRaw("(transcription_metadata::jsonb ->> 'pan_detected') = 'true'");
      })
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
    // PAN quarantine guard (Codex #2676 round-7 P1) — checked BEFORE the
    // recording-url short-circuit (round-14 P1): a same-write stamp can
    // land while recording_url is still populated (crash before the
    // quarantine nulled it), and 'already_has_recording' would leave that
    // replayable card audio untouched forever. Stamped rows are
    // quarantine work whatever the URL state; the stamp is the durable
    // guard, and every recovery entry point flows through here.
    try {
      const rawMeta = call.transcription_metadata;
      const meta = typeof rawMeta === 'string' ? JSON.parse(rawMeta) : (rawMeta && typeof rawMeta === 'object' ? rawMeta : {});
      if (meta.pan_detected === true) {
        // Incomplete quarantine (transient Twilio delete failure, or a
        // crash between stamp and quarantine): this sweep is the durable
        // place to RETRY — skipping forever would leave the card audio at
        // Twilio (round-12 P1). The saved quarantine SID is the audio
        // whose delete actually FAILED — prefer it over the row's possibly
        // older recording_sid (round-14 P1: the two-recording flow deleted
        // the old audio and never retried the fresh one). Complete
        // quarantines just skip.
        const retrySid = meta.quarantine_recording_sid || call.recording_sid || null;
        // Retry when the DELETE is incomplete — or when the delete finished
        // but the office ALERT never delivered (pan_notified missing,
        // round-18 P2): quarantineCardRecording is idempotent on the strip
        // and re-sends the alert via the pan_notified guard.
        if ((meta.recording_quarantined !== true && (retrySid || call.recording_url))
          || meta.pan_notified !== true) {
          try {
            await quarantineCardRecording({ ...call, recording_sid: retrySid }, { source: 'recovery_quarantine_retry' });
          } catch (qErr) {
            logger.warn(`[call-proc] recovery quarantine retry failed for ${maskSid(callSid)}: ${qErr.message}`);
          }
        }
        return { success: true, skipped: true, reason: 'pan_quarantined' };
      }
    } catch { /* unparseable metadata -> treat as unstamped */ }
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

    // Incomplete PAN quarantines (round-15 P1): pan_detected without
    // recording_quarantined means a Twilio delete is still owed. These rows
    // fall outside the missing-recording filters above — the backfill feeds
    // calls OLDER than the 7-day window, and the stamped-before-quarantine
    // crash window leaves recording_url POPULATED — so they get their own
    // candidate set; recoverRecordingForCall's pan guard runs the retry.
    let quarantineRetries = [];
    try {
      quarantineRetries = await db('call_log')
        .select('twilio_call_sid')
        .whereNotNull('twilio_call_sid')
        .whereRaw("(transcription_metadata::jsonb ->> 'pan_detected') = 'true'")
        // Incomplete delete OR undelivered office alert (round-18 P2) —
        // both are quarantine work the retry path finishes.
        .whereRaw("(COALESCE(transcription_metadata::jsonb ->> 'recording_quarantined', 'false') <> 'true' OR COALESCE(transcription_metadata::jsonb ->> 'pan_notified', 'false') <> 'true')")
        .orderBy('created_at', 'desc')
        .limit(10);
    } catch (qErr) {
      logger.warn(`[call-proc] incomplete-quarantine sweep query failed: ${qErr.message}`);
    }
    const seenSids = new Set();
    const sweepRows = [...rows, ...quarantineRetries].filter((row) => {
      if (!row.twilio_call_sid || seenSids.has(row.twilio_call_sid)) return false;
      seenSids.add(row.twilio_call_sid);
      return true;
    });

    const results = [];
    for (const row of sweepRows) {
      try {
        results.push({ callSid: row.twilio_call_sid, ...(await this.recoverRecordingForCall(row.twilio_call_sid)) });
      } catch (err) {
        results.push({ callSid: row.twilio_call_sid, success: false, error: err.message });
      }
    }

    const recovered = results.filter((r) => r.recovered).length;
    if (recovered > 0) logger.info(`[call-proc] Recovered ${recovered} missing recent recording(s)`);
    return { checked: sweepRows.length, recovered, results };
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

// Named production export for the first-touch resume lane (2026-07-30): the
// held newsletter subscribe is re-driven from lead-first-touch-resume once
// the office settles the email read-back question.
CallRecordingProcessor.resumeNewsletterForCallCustomer = subscribeNewCallCustomerToNewsletter;

CallRecordingProcessor._test = {
  isImplausibleTranscript,
  reconcileFormerLeadLinkage,
  recheckCallBookingConflicts,
  scrubTranscriptArtifacts,
  scrubStructuredTranscript,
  canonicalWavesService,
  referrerNameFromExtracted,
  resolveDefaultCallBookingTechnician,
  resolveDefaultCallBookingTechnicianId,
  resolveCallContactPhone,
  summarizeCustomerServiceContext,
  resolveSchedulableCallService,
  maskPhone,
  validatePhoneCallAppointmentCustomer,
  slotOnlyLinkAllowed,
  extractedNameMatchesCustomer,
  findCustomerForCallContact,
  normalizeCallExtraction,
  shouldCreateCallLeadForCustomer,
  findExistingCallAppointment,
  findAttachableCallAppointment,
  attachCandidateMatchesProperty,
  attachCandidateSlotAgrees,
  classifyCallerAccount,
  summarizeKnownCaller,
  summarizePriorCall,
  providerTimeoutSignal,
  PROVIDER_FETCH_TIMEOUTS_MS,
  downloadRecording,
  verifyRecordingBuffer,
  estimateMp3DurationSeconds,
  modelSupportsKeywordHints,
  transcriptionKeywords,
  isNonLeadCallContent,
  leadContactCompleteness,
  hasWorkableLeadSignal,
  voicemailCallbackAlertPlan,
  shouldHoldLeadEmailEnrollment,
  mintEmailReviewCardsFenced,
  transcribeRecording,
  extractCallDataV2,
  CALL_EXTRACTION_ROUTE,
  normalizeOpenAISegments,
  convertCallLeadOnPhoneBooking,
  findReusableCallLead,
  applySameCallLeadEligibility,
  clearStampAndRestoreLead,
  dropFilledLeadColumns,
  reaffirmedFilledLeadFields,
  reconcileConditionalLeadFieldsUnderLock,
  FILL_ONLY_LEAD_FIELDS,
  deriveStampLinkAuthority,
  parseStampedLeadId,
  parseStampedLeadLink,
  phoneReuseStillValidOnLockedRow,
  shouldStampCallLeadLinkage,
  snapshotStampedLeadStates,
  resolveCallAdditionalProperties,
  resolveCallQuoteSignals,
  resolveCallSecondaryContact,
  resolveCallSecondaryContacts,
  resolveCallBillingPayer,
  persistCallSecondaryContact,
  resolveCallBookingPropertyLinkage,
  demoteFailOpenOnV1AddressConflict,
  buildFailOpenRoutingContext,
  sameFirstName,
  firstNameVariants,
  v2IsoToEtWallClock,
  phoneNearMissOfAni,
  isUsableContactPhone,
  labeledTranscriptPreservesWords,
  applyRecurringIntentDefault,
  callBookingTimeSanityFlags,
};

// Production contract for the re-transcription backfill (NOT test-only):
// same transcriber + same hallucination guard the live path uses, so a
// backfilled transcript can never be lower-integrity than a live one.
CallRecordingProcessor.transcribeRecording = transcribeRecording;
CallRecordingProcessor.isImplausibleTranscript = isImplausibleTranscript;
CallRecordingProcessor.quarantineCardRecording = quarantineCardRecording;
CallRecordingProcessor.scrubStructuredTranscript = scrubStructuredTranscript;
CallRecordingProcessor.withPanStamps = withPanStamps;
CallRecordingProcessor.updateUnifiedVoiceMessage = updateUnifiedVoiceMessage;

// Routing contract shared with the OFFLINE AUDITS (NOT test-only): the
// promotion-readiness gate, the replay variance report and the shadow
// verifier must build the fail-open context and apply the V1-conflict
// demotion exactly as the live path does, or their verdicts drift from
// production — which is how a promotion gate goes permissive without anyone
// changing the gate. Deliberately on the module surface, not `_test`.
CallRecordingProcessor.buildFailOpenRoutingContext = buildFailOpenRoutingContext;
CallRecordingProcessor.demoteFailOpenOnV1AddressConflict = demoteFailOpenOnV1AddressConflict;

module.exports = CallRecordingProcessor;
