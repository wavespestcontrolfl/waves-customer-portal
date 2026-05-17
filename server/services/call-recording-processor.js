/**
 * Call Recording Processor.
 *
 * Processes Twilio call recordings end-to-end:
 *   1. Transcribe audio (Gemini or Twilio built-in)
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

function capitalizeName(name) {
  if (!name) return '';
  return name.trim().toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase())
    .replace(/\bMc(\w)/g, (_, c) => 'Mc' + c.toUpperCase())
    .replace(/\bO'(\w)/g, (_, c) => "O'" + c.toUpperCase());
}
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { subscribeOrResubscribe, EMAIL_RE } = require('./newsletter-subscribers');
const { sendConfirmationEmail } = require('./newsletter-confirm');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { resolveLocation } = require('../config/locations');
const { parseETDateTime, formatETDate, formatETTime, etDateString } = require('../utils/datetime-et');

const DEFAULT_CALL_BOOKING_TECHNICIAN_NAME = process.env.CALL_BOOKING_DEFAULT_TECHNICIAN_NAME || 'Adam B.';

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
  const buffer = Buffer.from(await res.arrayBuffer());
  return buffer.toString('base64');
}

// ── Transcribe audio via Gemini (download + inline base64) ──
async function transcribeWithGemini(mp3Url) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  try {
    // Download audio from Twilio (requires auth)
    logger.info(`[call-proc] Downloading recording: ${mp3Url}`);
    const audioBase64 = await downloadRecording(mp3Url);
    logger.info(`[call-proc] Downloaded ${Math.round(audioBase64.length / 1024)}KB audio`);

    const model = process.env.GEMINI_TRANSCRIPTION_MODEL || 'gemini-2.5-flash';
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inlineData: { mimeType: 'audio/mpeg', data: audioBase64 } },
              { text: `Transcribe this phone call recording for Waves Pest Control (pest control + lawn care, SW Florida).

Rules:
- Label every turn "Agent:" or "Caller:" on its own line.
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
      logger.warn(`[call-proc] Gemini transcription failed: ${res.status} ${errBody.slice(0, 200)}`);
      return null;
    }
    const data = await res.json();
    // Gemini 2.5 may return thinking parts — skip those
    const parts = data.candidates?.[0]?.content?.parts || [];
    const textPart = parts.find(p => p.text && !p.thought);
    return textPart?.text || parts[0]?.text || null;
  } catch (err) {
    logger.error(`[call-proc] Gemini transcription error: ${err.message}`);
    return null;
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
    return JSON.parse(cleaned);
  } catch (e) {
    logger.error(`[call-proc] Invalid JSON from Gemini: ${e.message} — raw: ${cleaned.slice(0, 200)}`);
    return { first_name: null, is_spam: false, is_voicemail: false, call_summary: 'AI extraction returned invalid JSON', lead_quality: 'cold' };
  }
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
    // Step 1: Transcribe — Gemini is the source of truth. Twilio's built-in is fallback only.
    let transcription = null;

    if (call.recording_url) {
      transcription = await transcribeWithGemini(call.recording_url);
      if (transcription) {
        await db('call_log').where({ id: call.id }).update({
          transcription,
          transcription_status: 'completed',
          updated_at: new Date(),
        });
        logger.info(`[call-proc] Gemini transcription complete: ${transcription.length} chars`);
      }
    }

    // Fallback: use Twilio's built-in transcription if Gemini failed or no recording URL
    if (!transcription) {
      const freshCall = await db('call_log').where('twilio_call_sid', callSid).select('transcription').first();
      if (freshCall?.transcription) {
        transcription = freshCall.transcription;
        logger.info(`[call-proc] Gemini unavailable — falling back to Twilio transcription: ${transcription.length} chars`);
      } else if (call.transcription) {
        transcription = call.transcription;
        logger.info(`[call-proc] Gemini unavailable — using cached Twilio transcription: ${transcription.length} chars`);
      }
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
      extracted = await extractCallData(transcription, call.from_phone, { callStartedAt: call.created_at });
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

    // Skip voicemail/spam
    if (extracted.is_voicemail || extracted.is_spam) {
      await db('call_log').where({ id: call.id }).update({
        ai_extraction: JSON.stringify(extracted),
        processing_status: extracted.is_spam ? 'spam' : 'voicemail',
        processing_token: null,
        processing_started_at: null,
        updated_at: new Date(),
      });
      logger.info(`[call-proc] Skipping ${callSid}: ${extracted.is_spam ? 'spam' : 'voicemail'}`);
      return { success: true, skipped: true, reason: extracted.is_spam ? 'spam' : 'voicemail' };
    }

    // Step 3: Create or update customer
    let customerId = call.customer_id;
    const phone = extracted.phone || call.from_phone;
    let newsletterResult = null;
    let newsletterCandidate = null;

    if (!customerId && phone) {
      // Try to find existing customer by phone
      const existing = await db('customers').where({ phone }).first();
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

          const [newCust] = await db('customers').insert({
            first_name: capitalizeName(extracted.first_name),
            last_name: extracted.last_name ? capitalizeName(extracted.last_name) : null,
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
          }).returning('*');
          customerId = newCust.id;
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

    // Step 4b: Create lead in leads table for pipeline tracking
    // Note: we create the lead DIRECTLY here instead of going through lead-attribution,
    // because Step 3 already created the customer — attribution would find the customer
    // and skip lead creation (race condition).
    let leadId = null;
    if (customerId && !extracted.is_spam) {
      try {
        // Check if lead already exists for this phone
        const existingLead = phone ? await db('leads').where('phone', phone).orderBy('created_at', 'desc').first() : null;

        if (existingLead) {
          leadId = existingLead.id;
          logger.info(`[call-proc] Found existing lead ${leadId} for ${phone}`);
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
            if (ls) leadSourceId = ls.id;
            else logger.warn(`[call-proc] No lead_source matched ${call.to_phone} (variants tried: ${[...variants].join(', ')})`);
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
    if (extracted.appointment_confirmed && extracted.preferred_date_time && customerId && hasSpecificTime && canCreateAppointmentFromCall) {
      try {
        let customer = await db('customers').where({ id: customerId }).first();
        if (customer) {
          customer = await backfillCustomerFromAppointmentContact(customerId, customer, extracted, call.from_phone);
          const customerValidation = validatePhoneCallAppointmentCustomer(customer, extracted, call.from_phone);
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

          try {
            const tpl = await db('sms_templates').where({ template_key: 'appointment_call_confirmed' }).first();
            if (tpl?.body) {
              smsBody = tpl.body
                .replace(/\{first_name\}/g, firstName)
                .replace(/\{service_type\}/g, serviceType)
                .replace(/\{date_time\}/g, extracted.preferred_date_time)
                .replace(/\{date\}/g, parsedDate)
                .replace(/\{time\}/g, parsedTime);
            }
          } catch { /* template table may not exist */ }

          if (!smsBody) {
            smsBody = `Hello ${firstName}! Your ${serviceType} appointment has been scheduled.\n\n` +
              `Date/Time: ${extracted.preferred_date_time}\n\n` +
              `We'll send you a reminder before your appointment. Reply to this text or call (941) 318-7612 with any questions.\n\n` +
              `- Waves Pest Control`;
          }

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
                };
                const [created] = await trx('scheduled_services').insert(insertData).returning('*');
                return created;
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

          // Only send the confirmation SMS if the schedule row landed.
          if (scheduledServiceId) {
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
            } else if (!alreadySent) {
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
              } else {
                logger.info(`[call-proc] Appointment SMS sent to customer ${customerId}`);
                appointmentResult = { smsSent: true, scheduledServiceId, service: serviceType, dateTime: extracted.preferred_date_time, scheduledDate: scheduledDateForLog, windowStart: windowStartForLog };
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
    if (customerId && extracted.email) {
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
    // We don't know which CSR actually answered (the inbound <Dial> forwards
    // to a single number that may ring multiple people). Score against
    // 'Unknown' so analytics aren't all silently booked to one name; fix
    // properly when we add per-CSR routing.
    let csrScoreResult = null;
    if (transcription && transcription.length > 50) {
      try {
        const CSRCoach = require('./csr/csr-coach');
        const scoreResult = await CSRCoach.scoreCall({
          csrName: 'Unknown',
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

    if (newsletterCandidate) {
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
  summarizeCustomerServiceContext,
  resolveSchedulableCallService,
  validatePhoneCallAppointmentCustomer,
};

module.exports = CallRecordingProcessor;
