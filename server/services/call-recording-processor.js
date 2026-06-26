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
const { resolveLocation } = require('../config/locations');
const { parseETDateTime, formatETDate, formatETTime, etDateString } = require('../utils/datetime-et');
const { normalizeCallExtraction, applyContactNormalization } = require('../utils/intake-normalize');
const { properCase } = require('../utils/name-case');
const { validateModelOutput, validatePersisted, SCHEMA_VERSION } = require('../schemas/validate-extraction');
const { normalizeExtractionV2 } = require('../utils/normalize-extraction-v2');
const { buildExtractionPrompt, PROMPT_HASH } = require('./prompts/call-extraction-v1');
const { writeLegacyShadowRouteDecision } = require('./call-route-decisions');
const { stageCustomerFieldCandidates } = require('./call-field-candidates');
const modelOutputSchema = require('../schemas/call-extraction.model-output.schema.json');

const CALL_EXTRACTION_V2_ENABLED = process.env.CALL_EXTRACTION_V2_ENABLED === 'true';
const CALL_EXTRACTION_V2_DRIVES_ROUTING =
  process.env.CALL_EXTRACTION_V2_DRIVES_ROUTING === 'true'
  || process.env.CALL_TRIAGE_ENFORCE_V2_GATES === 'true';
const { computeDeterministicTriageFlags, mergeTriageFlags, suppressAddressFlagsForAV, canAutoRoute, hasCanonicalWriteBlock } = require('./call-triage-flags');
const { computeAppointmentIdempotencyKey, computeAddressHash, checkTcpaConsent, buildRouteDecision, buildTriageItem } = require('./call-routing-gates');
const { isV2Extraction, flatView } = require('../utils/extraction-compat');
const { validateAddress, buildAddressLines } = require('./address-validation');
const { renderSmsTemplate } = require('./sms-template-renderer');
const { syncVoiceMessageForCall } = require('./conversations');

const DEFAULT_CALL_BOOKING_TECHNICIAN_NAME = process.env.CALL_BOOKING_DEFAULT_TECHNICIAN_NAME || 'Adam B.';
const OPENAI_TRANSCRIPTIONS_API = 'https://api.openai.com/v1/audio/transcriptions';
const OPENAI_RESPONSES_API = 'https://api.openai.com/v1/responses';
const OPENAI_TRANSCRIPTION_MODEL = process.env.OPENAI_TRANSCRIPTION_MODEL || 'gpt-4o-transcribe-diarize';
const OPENAI_TRANSCRIPT_LABEL_MODEL = process.env.OPENAI_TRANSCRIPT_LABEL_MODEL || process.env.OPENAI_MODEL || 'gpt-5-mini';
const OPENAI_COMPLETENESS_FALLBACK_SECONDS = Number(process.env.OPENAI_COMPLETENESS_FALLBACK_SECONDS) || 600;
const OPENAI_COMPLETENESS_FALLBACK_CHARS = Number(process.env.OPENAI_COMPLETENESS_FALLBACK_CHARS) || 7000;
const OPENAI_TRANSCRIPTION_PROMPT = `Transcribe this phone call recording for Waves Pest Control (pest control and lawn care, Southwest Florida).

Preserve fillers like "um" and "uh", numbers, addresses, phone numbers, and proper nouns exactly as spoken.
Use punctuation and line breaks where helpful. Do not summarize, translate, or add commentary.`;
const GEMINI_TRANSCRIPTION_MODEL = process.env.GEMINI_TRANSCRIPTION_MODEL || 'gemini-2.5-flash';
// v2 extraction uses Gemini 2.5 Pro — most capable model for the deeply-nested
// v1.0.0 schema (better structured-output adherence + fewer hallucinations than
// Flash), and unlike Claude Opus 4.7 it still supports temperature (extraction
// pins temp 0.2 for determinism). Env-overridable for instant rollback.
const GEMINI_EXTRACTION_MODEL = process.env.GEMINI_EXTRACTION_MODEL || 'gemini-2.5-pro';

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

function resolveCallContactPhone(call = {}, extractedPhone = null) {
  const extracted = String(extractedPhone || '').trim();
  if (isOutboundCall(call)) {
    if (extracted && !samePhone(extracted, call.from_phone)) return extracted;
    return call.to_phone || extracted || call.from_phone || null;
  }

  if (extracted && !samePhone(extracted, call.to_phone)) return extracted;
  return call.from_phone || extracted || call.to_phone || null;
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

function shouldCreateCallLeadForCustomer(customer, { createdCustomerFromCall = false } = {}) {
  if (!customer) return false;
  if (createdCustomerFromCall) return true;
  return LEAD_PIPELINE_STAGES.has(String(customer.pipeline_stage || '').toLowerCase());
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
    logger.warn(`[call-proc] ${matches.length} customers share call contact phone ${maskPhone(phone)}; not auto-linking without name match`);
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

async function findExistingCallAppointment({ customerId, call, scheduledDate, windowStart, serviceType, trx = db }) {
  if (!customerId) return null;

  const marker = `Call SID: ${call.twilio_call_sid}`;
  const marked = await trx('scheduled_services')
    .where({ customer_id: customerId })
    .whereNotIn('status', ['cancelled', 'rescheduled'])
    .where('notes', 'like', `%${marker}%`)
    .orderBy('created_at', 'asc')
    .first();
  if (marked) return marked;

  if (!scheduledDate || !windowStart || !serviceType) return null;

  const callCreatedAt = call.created_at ? new Date(call.created_at) : null;
  const query = trx('scheduled_services')
    .where({ customer_id: customerId, booking_source: 'phone_call' })
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
  if (!service) return { ok: false, reason: 'unsupported_service', service: null };
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
  if (!tech?.id) {
    logger.warn(`[call-proc] Default call-booking technician not found: ${DEFAULT_CALL_BOOKING_TECHNICIAN_NAME}`);
    return null;
  }
  return { id: tech.id, name: tech.name || DEFAULT_CALL_BOOKING_TECHNICIAN_NAME };
}

async function resolveDefaultCallBookingTechnicianId(conn = db) {
  const tech = await resolveDefaultCallBookingTechnician(conn);
  return tech?.id || null;
}

function hasUsablePhone(value) {
  return String(value || '').replace(/\D/g, '').length >= 10;
}

function validatePhoneCallAppointmentCustomer(customer = {}, extracted = {}, callerPhone = null) {
  const merged = {
    firstName: customer.first_name || extracted.first_name || null,
    lastName: customer.last_name || extracted.last_name || null,
    phone: customer.phone || extracted.phone || callerPhone || null,
    email: customer.email || extracted.email || null,
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
    return labeled;
  } catch (err) {
    logger.error(`[call-proc] OpenAI transcript labeling error: ${err.message}`);
    return null;
  }
}

// ── Primary transcription via OpenAI (multipart upload) ──
async function transcribeWithOpenAI(audioBuffer) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  try {
    const form = new FormData();
    form.append('file', new Blob([audioBuffer], { type: 'audio/mpeg' }), 'call-recording.mp3');
    form.append('model', OPENAI_TRANSCRIPTION_MODEL);
    form.append('language', 'en');
    const diarized = OPENAI_TRANSCRIPTION_MODEL.includes('diarize');
    form.append('response_format', diarized ? 'diarized_json' : 'json');
    if (diarized) {
      form.append('chunking_strategy', 'auto');
    } else {
      form.append('prompt', OPENAI_TRANSCRIPTION_PROMPT);
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
      model: OPENAI_TRANSCRIPTION_MODEL,
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

async function transcribeRecording(mp3Url, opts = {}) {
  try {
    logger.info(`[call-proc] Downloading recording for transcription: ${mp3Url}`);
    const audioBuffer = await downloadRecording(mp3Url);
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

  const prompt = `Analyze this phone call transcript for Waves Pest Control (pest control + lawn care, SW Florida).

Waves only schedules pest control, lawn care, mosquito, termite, rodent, bed bug, WDO, and tree/shrub services. Calls about unrelated work such as website SEO, organic traffic, marketing, advertising, or a construction company are not Waves appointments.

Caller phone: ${callerPhone || 'unknown'}
Call date in Eastern Time: ${callDateET}

Transcript:
${transcription}

Extract the following as JSON. Use null for anything not clearly stated:
{
  "first_name": "string or null",
  "last_name": "string or null",
  "email": "string or null",
  "phone": "string — use caller phone if not stated",
  "address_line1": "street address or null",
  "city": "string or null — must be a Florida city",
  "state": "FL",
  "zip": "string or null",
  "requested_service": "what service they're calling about",
  "appointment_confirmed": true/false,
  "preferred_date_time": "ISO 8601 local (no timezone) in Eastern Time: YYYY-MM-DDTHH:MM — e.g. 2026-04-20T14:00 for April 20, 2026 at 2:00 PM ET. null if not confirmed.",
  "is_voicemail": true/false,
  "is_spam": true/false,
  "sentiment": "positive/neutral/negative/frustrated",
  "pain_points": "brief summary of customer concerns or pest issues",
  "call_summary": "2-3 sentence summary of the call",
  "lead_quality": "hot/warm/cold/spam",
  "matched_service": "best match from: General Pest Control, Lawn Care, Mosquito Control, Termite Inspection, WDO Inspection, Pre-Slab Termidor, Liquid Termite Perimeter, Termite Wood Treatment, Termite Foam Drill, Rodent Control, Bed Bug Treatment, Tree & Shrub Care, or null"
}

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

IMPORTANT — customer name rules:
- Capture both first_name and last_name whenever the caller clearly states both.
- If only one name is clearly stated, put it in first_name and leave last_name null.
- Do not invent a last name from caller ID, address, email, or context.

IMPORTANT — customer contact rules:
- Do not invent email addresses. Only return email when the caller clearly says or spells the complete address.
- If the transcript contains an uncertain, partial, or malformed email, return null.
- Return the caller phone unless the caller clearly gives a different callback number.
- Do not overwrite or infer customer identity from transcript context alone; uncertain names, phones, emails, or addresses must be null.

Return ONLY valid JSON.`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          response_mime_type: 'application/json',
          temperature: 0.2, // keep extraction deterministic
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
function buildV2ExtractionPrompt(transcription, callerPhone, callDateET) {
  return buildExtractionPrompt(transcription, callerPhone, callDateET)
    + '\n\n═══ OUTPUT CONTRACT ═══\n'
    + 'Return ONLY a single JSON object that conforms EXACTLY to this JSON Schema: '
    + 'every required field present, every enum value exact, no extra fields, '
    + 'use null for unknown nullable fields.\n'
    + JSON.stringify(modelOutputSchema);
}

// Parse → validate(model-output) → inject server meta → normalize → validate(persisted).
// Provider-agnostic tail shared by the Gemini and OpenAI extraction paths. Fails closed
// to a status string; never trusts model output directly.
function finalizeV2Extraction(rawText, { callId = null, extractionModel } = {}) {
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
    extraction_prompt_version: PROMPT_HASH,
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
  const prompt = buildV2ExtractionPrompt(transcription, callerPhone, callDateET);

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
            temperature: 0.2,
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

  return finalizeV2Extraction(rawText, { callId: opts.callId || null, extractionModel: GEMINI_EXTRACTION_MODEL });
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

    // Step 1: Transcribe — OpenAI is the source of record. Gemini and Twilio are fallbacks only.
    let transcription = null;
    let transcriptionProvenance = null;

    if (call.recording_url) {
      const result = await transcribeRecording(call.recording_url, { call, contactPhone });
      transcription = result.transcription;
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
        if (result.structuredSegments) {
          transcriptUpdate.transcript_structured = JSON.stringify({
            provider: result.provider,
            model: result.model || OPENAI_TRANSCRIPTION_MODEL,
            segments: result.structuredSegments,
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
    let extracted;
    try {
      extracted = await extractCallData(transcription, contactPhone, { callStartedAt: call.created_at });
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
          ai_extraction_prompt_version: PROMPT_HASH,
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
          ai_extraction_prompt_version: PROMPT_HASH,
          updated_at: new Date(),
        });
      }
    }

    // Skip voicemail/spam
    if (extracted.is_voicemail || extracted.is_spam) {
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
          const addressValidation = v2AddressValidation;
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

          if (!routingResult.allowed) {
            const triageReasons = finalFlags.length > 0 ? finalFlags : [routingResult.reason || 'routing_rejected'];
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
      } else if (extracted.first_name && phone) {
        // Create new customer
        const loc = resolveLocation(extracted.city || '');
        const code = 'WAVES-' + Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
        const numberConfig = TWILIO_NUMBERS.findByNumber(call.to_phone);
        const leadSource = numberConfig ? TWILIO_NUMBERS.getLeadSourceFromNumber(call.to_phone) : { source: 'phone_call' };

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
            lead_source_detail: numberConfig?.domain || 'inbound call',
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

    // Step 4: Update call log with extraction results.
    // Keep the row claimed as 'processing' while downstream side effects run.
    // The terminal status is written only after leads/estimates/scheduling have
    // had a chance to land, so a crash cannot mark the call processed early.
    const customerExpected = !!(extracted.first_name && phone && !extracted.is_voicemail && !extracted.is_spam);
    const customerLanded = !!customerId;
    const finalStatus = (customerExpected && !customerLanded) ? 'customer_creation_failed' : 'processed';
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
    const leadCustomer = customerId
      ? await db('customers').where({ id: customerId }).select('id', 'pipeline_stage').first().catch(() => null)
      : null;
    const shouldCreateLead = customerId && !extracted.is_spam && shouldCreateCallLeadForCustomer(leadCustomer, { createdCustomerFromCall });
    if (!shouldCreateLead && customerId && !extracted.is_spam) {
      logger.info(`[call-proc] Skipping lead creation for existing customer ${customerId} (${leadCustomer?.pipeline_stage || 'unknown'})`);
    }
    if (shouldCreateLead) {
      try {
        // Check if lead already exists for this phone
        const existingLead = phone ? await db('leads').where('phone', phone).orderBy('created_at', 'desc').first() : null;

        if (existingLead) {
          leadId = existingLead.id;
          logger.info(`[call-proc] Found existing lead ${leadId} for ${maskPhone(phone)}`);
        } else {
          // Resolve lead source from the Twilio number. Match every plausible
          // shape of `lead_sources.twilio_phone_number` because that column has
          // historically been hand-entered (E.164 `+19413187612`, 11-digit
          // `19413187612`, 10-digit `9413187612`, formatted `(941) 318-7612`).
          // The previous implementation produced `+1${digits}` from an already-
          // E.164 input (`+119413187612`) — always invalid — so on E.164-stored
          // rows only the exact match worked, and on non-E.164-stored rows
          // nothing matched and lead_source_id silently went null.
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
          } catch (e) {
            logger.warn(`[call-proc] lead_source lookup failed: ${e.message}`);
          }

          const [newLead] = await db('leads').insert({
            lead_source_id: leadSourceId,
            customer_id: customerId,
            phone,
            first_name: capitalizeName(extracted.first_name),
            last_name: capitalizeName(extracted.last_name || ''),
            email: extracted.email || null,
            lead_type: 'inbound_call',
            first_contact_at: new Date(),
            first_contact_channel: 'call',
            twilio_call_sid: call.twilio_call_sid,
            call_duration_seconds: call.duration_seconds,
            call_recording_url: call.recording_url,
            status: 'new',
          }).returning('*');
          leadId = newLead.id;
          logger.info(`[call-proc] Created new lead ${leadId} for ${extracted.first_name} ${extracted.last_name}`);

          // Paid call lead (dedicated Google Ads tracking number) -> surface it in
          // the PPC funnel (ad_service_attribution). campaign_id is null here
          // (single-number bucket; the call-reporting bridge fills the campaign
          // when it matches). Best-effort; never blocks call processing.
          if (customerId && leadSourceRow
              && (leadSourceRow.source_type === 'google_ads' || leadSourceRow.channel === 'paid')) {
            require('./ads/call-attribution').recordCallPpcAttribution({
              customerId,
              leadId,
              leadSource: 'google_ads',
              leadSourceDetail: leadSourceRow.name || 'inbound call',
            }).catch(() => {});
          }

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
          }
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
          leadUpdates.extracted_data = JSON.stringify({
            pain_points: extracted.pain_points,
            preferred_date_time: extracted.preferred_date_time,
            sentiment: extracted.sentiment,
          });
          // is_qualified: hot/warm only. Spam was already early-returned, so
          // checking != 'spam' would mark cold leads qualified.
          leadUpdates.is_qualified = ['hot', 'warm'].includes(extracted.lead_quality);
          leadUpdates.customer_id = customerId;
          leadUpdates.updated_at = new Date();
          await db('leads').where({ id: leadId }).update(leadUpdates);

          // Log AI triage activity
          await db('lead_activities').insert({
            lead_id: leadId,
            activity_type: 'ai_triage',
            description: `AI extracted from call: ${extracted.matched_service || 'general inquiry'}, quality: ${extracted.lead_quality || 'unknown'}`,
            performed_by: 'AI Call Processor',
            metadata: JSON.stringify({ call_summary: extracted.call_summary, pain_points: extracted.pain_points, sentiment: extracted.sentiment }),
          }).catch(e => logger.warn(`[call-proc] Non-critical op failed: ${e.message}`));
        }
      } catch (leadErr) {
        logger.error(`[call-proc] Lead creation failed (non-blocking): ${leadErr.message}`);
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
      if (v2Flat.preferred_date_time && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v2Flat.preferred_date_time)) {
        extracted.preferred_date_time = v2Flat.preferred_date_time.slice(0, 16);
      }
      extracted.appointment_confirmed = v2Flat.appointment_confirmed;
      if (v2Flat.matched_service) extracted.matched_service = v2Flat.matched_service;
      if (v2Flat.requested_service) extracted.requested_service = v2Flat.requested_service;
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
    const isOutboundCall = String(call.direction || '').toLowerCase().startsWith('outbound');
    const canCreateAppointmentFromCall = !isOutboundCall && serviceResolution.ok;
    if (extracted.appointment_confirmed && extracted.preferred_date_time && customerId && hasSpecificTime && !canCreateAppointmentFromCall) {
      appointmentResult = {
        service: serviceResolution.service || extracted.matched_service || extracted.requested_service || null,
        dateTime: extracted.preferred_date_time,
        scheduleCreated: false,
        smsSent: false,
        skippedReason: isOutboundCall ? 'outbound_call' : serviceResolution.reason,
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
            const serviceType = serviceResolution.service;
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
              parsedTime = timeMatch ? timeMatch[1] : '';
            }
          } catch { parsedDate = extracted.preferred_date_time; }

          smsBody = await renderSmsTemplate('appointment_call_confirmed', {
            first_name: firstName,
            service_type: serviceType,
            date_time: extracted.preferred_date_time,
            date: parsedDate,
            time: parsedTime,
          }, {
            workflow: 'appointment_call_confirmed',
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
              }
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
              let reusedExistingSchedule = false;
              const svc = await db.transaction(async (trx) => {
                await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))', ['call-recording-schedule', callSid]);
                const defaultTechnician = await resolveDefaultCallBookingTechnician(trx);
                const defaultTechnicianId = defaultTechnician?.id || null;
                const defaultTechnicianName = defaultTechnician?.name || null;
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
                  if (!existing.technician_id && defaultTechnicianId) {
                    const [updatedExisting] = await trx('scheduled_services')
                      .where({ id: existing.id })
                      .update({ technician_id: defaultTechnicianId, updated_at: new Date() })
                      .returning('*');
                    return updatedExisting || existing;
                  }
                  return existing;
                }
                const insertData = {
                  customer_id: customerId,
                  technician_id: defaultTechnicianId,
                  scheduled_date: scheduledDate,
                  window_start: windowStart || '09:00',
                  window_end: windowEnd || '10:00',
                  window_display: windowDisplay,
                  service_type: serviceType,
                  status: 'confirmed',
                  customer_confirmed: true,
                  confirmed_at: new Date(),
                  notes: [
                    'Booked via phone call.',
                    `Call SID: ${callSid}.`,
                    defaultTechnicianName ? `Auto-assigned technician: ${defaultTechnicianName}.` : null,
                    extracted.call_summary || null,
                  ].filter(Boolean).join(' ').trim(),
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
                if (created) return created;
                // Idempotency conflict: another writer already created a row with this key.
                // Fetch it and mark as reused so downstream skips duplicate side effects.
                const existingByKey = await trx('scheduled_services')
                  .where({ idempotency_key: insertData.idempotency_key })
                  .first();
                if (existingByKey) {
                  reusedExistingSchedule = true;
                  logger.info(`[call-proc] Idempotency conflict for ${callSid}; reusing existing scheduled service ${existingByKey.id}`);
                  return existingByKey;
                }
                throw new Error('Idempotency conflict but no existing row found by key — unexpected state');
              });
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

            } else {
              logger.warn(`[call-proc] Could not parse date from: ${extracted.preferred_date_time}; skipping schedule + SMS`);
              appointmentResult = { service: serviceType, dateTime: extracted.preferred_date_time, scheduleCreated: false, smsSent: false };
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
              logger.warn(`[call-proc] appointment_call_confirmed template missing/disabled; appointment SMS skipped for customer ${customerId}`);
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
                  if (sendResult.blocked || sendResult.sent === false) {
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
                    return false;
                  }
                  logger.info(`[call-proc] Appointment SMS sent to customer ${customerId}`);
                  appointmentResult = { smsSent: true, scheduledServiceId, service: serviceType, dateTime: extracted.preferred_date_time, scheduledDate: scheduledDateForLog, windowStart: windowStartForLog };
                  return true;
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
        }
        }
      } catch (err) {
        logger.error(`[call-proc] Appointment SMS failed: ${err.message}`);
        appointmentResult = { error: err.message };
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
  transcribeRecording,
  extractCallDataV2,
  normalizeOpenAISegments,
};

module.exports = CallRecordingProcessor;
