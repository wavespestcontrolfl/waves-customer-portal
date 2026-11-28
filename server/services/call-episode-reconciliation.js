'use strict';

/**
 * 48-Hour Multi-Call + SMS Episode Reconciliation (PR B2, $0.00 spend, no new gate).
 *
 * Connects related calls and texts within a 48-hour customer episode using 100%
 * deterministic DB logic (zero extra LLM prompt tokens) and strictly delegates
 * triage card resolution to the repo's ONE authoritative mechanisms:
 * 1. Sanitized 48h SMS + household sibling context readers (URL/bearer-link, PAN,
 *    access-code, and prompt-delimiter scrubbed).
 * 2. Post-finalization, generation-fenced episode reconciliation:
 *    - Delegates Call 1 open address/name card resolution directly to
 *      `triage-auto-resolve.reconcileSiblingCallsNow` (inheriting all confirmed-unbooked,
 *      single-property, unit, locality, lockTriageCall, and gate protections).
 *    - Delegates Call 1 `customer_email_missing` settlement directly to
 *      `customer-email-fanout.resolveOpenEmailReviewCards` (never touching
 *      `email_unverified` / `email_invalid`).
 *    - Retires ONLY identifiable call-intake new-lead alerts tied to the booked `leadId`
 *      on confirmed/fulfilled non-re-service visits (including voicemail-first leads).
 * 3. Suppresses false "Quote asked by text" owed-quote bells ONLY when an inbound photo
 *    SMS is a delivery-only photo submission answering an inbound 48h call where `Agent:`
 *    explicitly requested photos (never suppressing questions, bids, ballparks, or mixed
 *    service/scheduling captions).
 * 4. Preserves first-touch `lead_source` across repeat or outbound callback calls within
 *    48h (comparing earlier tracking lines + linked lead attribution while keeping an
 *    explicit spoken referral override on the current call).
 */

const logger = require('./logger');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
const { excludeUnresolvedSendReservations } = require('./messaging/review-ask-reservation');
const { cleanValidEmailOrNull } = require('../utils/intake-normalize');
const { scrubPans } = require('../utils/pan-scrub');
const { redactAccessCodes } = require('./context-aggregator');
const { streetKey } = require('./customer-properties');
const { attributionForSourceType } = require('./ads/call-attribution');

const EPISODE_WINDOW_HOURS = 48;
const MAX_EPISODE_SMS = 5;
const MAX_SMS_SNIPPET_CHARS = 140;
const PHOTO_LOOKUP_TIMEOUT_MS = 800;

const ADDRESS_CONFLICT_HOLD_REASONS = Object.freeze(new Set([
  'street_level_address_review',
  'on_file_house_number_conflict',
  'address_unit_conflict',
  'second_service_address',
  'multi_property_call',
]));

// Only identifiable call-intake new-lead alerts (never website quote alerts from
// public-quote.js or missed-callback alerts sharing metadata.leadId).
const CALL_NEW_LEAD_ALERT_TITLES = Object.freeze([
  'Untracked call lead',
  'New call lead',
  'New voicemail lead',
]);

// Confirmed or fulfilled booking states only (excludes pending, rescheduled, cancelled, skipped, no_show).
const CONFIRMED_OR_FULFILLED_STATUSES = Object.freeze(new Set([
  'confirmed',
  'en_route',
  'on_site',
  'completed',
]));

const GENERIC_LEAD_SOURCES = Object.freeze(new Set([
  '', 'phone_call', 'direct', 'phone', 'phone_tracking', 'inbound_call', 'outbound_call', 'unknown',
]));

const URL_OR_SHORTLINK_RE = /\b(?:https?:\/\/\S+|www\.\S+|(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|to|ly|me|app|link|us|info|biz)\/\S*)/gi;
const DELIMITER_GUARD_RE = /<<<\s*PRIOR_CALL_DATA|PRIOR_CALL_DATA\s*>>>|<<<|>>>/gi;
const NON_DELIVERY_ASK_RE = /\?|\b(?:how\s+much|quote|price|pricing|cost|estimate|rate|charge|charges|ballpark|bid|range|approx\w*|rough\s+(?:idea|number|figure)|schedule|book|appoint\w*|also|too\b|(?:i|we)\s+(?:need|want|would\s+like)\b|looking\s+for\b|another\s+property|please\s+(?:treat|spray|send|quote|price|check|schedule|book|come|call|add)|can\s+you\b|do\s+you\b|would\s+(?:it|that|this)\b)\b/i;
// Delivery-only caption: the ENTIRE message (single sentence, optional polite opener/closer)
// states that a photo/picture is attached or being sent.
const DELIVERY_ONLY_PHOTO_CAPTION_RE = /^(?:(?:hi|hello|hey|thanks|thank\s+you|ok(?:ay)?|sure)\s*[,!.—-]?\s*)*(?:(?:here(?:'s|’s| is| are)?|attached(?:\s+is|\s+are)?|sending|sent|sharing)\s+(?:is\s+|are\s+)?(?:the\s+|a\s+|my\s+|some\s+)?(?:pic(?:ture)?s?|photos?|images?|snapshots?)|(?:the\s+|a\s+|my\s+)?(?:pic(?:ture)?s?|photos?|images?)\s+(?:of|from|as\s+requested|you\s+asked|for\s+you))(?:[^.!?;\n]{0,80})[.!]?$/i;
const STAFF_PHOTO_REQUEST_RE = /\b(?:text|send|shoot|email|message|snap)\b[^.!?\n]{0,50}\b(?:pic(?:ture)?s?|photos?|images?)\b/i;
const RESERVICE_LABEL_RE = /\b(?:re[- ]?service|callback\s+treatment|covered\s+re[- ]?service)\b/i;

const last10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);

function anchorDate(value) {
  const d = value ? new Date(value) : new Date();
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function windowStartFrom(anchor, hours = EPISODE_WINDOW_HOURS) {
  return new Date(anchor.getTime() - hours * 3600 * 1000);
}

function parseMaybeJson(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

function normalizedStreetKey(line1) {
  const street = String(line1 || '').split(',')[0].trim();
  if (!/^\d/.test(street)) return null;
  return streetKey(street) || null;
}

function sanitizeEpisodeSmsBody(body) {
  const clean = redactAccessCodes(scrubPans(String(body || '')))
    .replace(URL_OR_SHORTLINK_RE, '[link removed]')
    .replace(DELIMITER_GUARD_RE, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.slice(0, MAX_SMS_SNIPPET_CHARS);
}

function isGenericCallLeadSource(source) {
  return GENERIC_LEAD_SOURCES.has(String(source || '').trim().toLowerCase());
}

function shouldPreserveExistingLeadSource(existingSource, incomingSource) {
  return !isGenericCallLeadSource(existingSource) && isGenericCallLeadSource(incomingSource);
}

// Read-only sanitized recent SMS helper (<=48h strictly before anchor).
async function loadRecentEpisodeSms(conn, contactPhone, anchorCreatedAt = null) {
  const digits = last10(contactPhone);
  if (digits.length < 10 || typeof conn !== 'function') return [];
  try {
    const anchor = anchorDate(anchorCreatedAt);
    const since = windowStartFrom(anchor);
    const rows = await conn('sms_log')
      .modify(excludeUnresolvedSendReservations)
      .whereRaw(
        "(right(regexp_replace(coalesce(from_phone,''),'\\D','','g'),10) = ? OR right(regexp_replace(coalesce(to_phone,''),'\\D','','g'),10) = ?)",
        [digits, digits],
      )
      .where('created_at', '>=', since)
      .where('created_at', '<', anchor)
      .orderBy('created_at', 'desc')
      .limit(MAX_EPISODE_SMS)
      .select('direction', 'message_body', 'created_at');

    return rows
      .map((row) => {
        const text = sanitizeEpisodeSmsBody(row.message_body);
        if (!text) return null;
        const hoursAgo = Math.max(1, Math.round((anchor.getTime() - new Date(row.created_at).getTime()) / 3600000));
        return {
          direction: row.direction === 'outbound' ? 'Waves' : 'Customer',
          hoursAgo,
          text,
        };
      })
      .filter(Boolean);
  } catch (err) {
    logger.warn(`[call-episode] recent SMS lookup skipped: ${err.code || err.name || 'db_error'}`);
    return [];
  }
}

// Find strictly earlier non-spam sibling calls within 48h for the same customer_id
// (plus optional exact household normalized_street + last_name lookup).
async function findRecentEpisodeSiblingCalls(conn, {
  customerId = null,
  currentCallId = null,
  anchorCreatedAt = null,
  normalizedStreet = null,
  lastName = null,
  includeHouseholdMatch = false,
} = {}) {
  if (typeof conn !== 'function') return [];
  const anchor = anchorDate(anchorCreatedAt);
  const since = windowStartFrom(anchor);
  const byId = new Map();
  const cols = ['id', 'twilio_call_sid', 'customer_id', 'metadata', 'created_at', 'direction', 'to_phone'];

  if (customerId) {
    const q = whereNotSandboxCall(conn('call_log'))
      .where({ customer_id: customerId })
      .whereNotIn('processing_status', ['spam', 'voicemail'])
      .where('created_at', '>=', since)
      .where('created_at', '<', anchor)
      .orderBy('created_at', 'desc')
      .limit(10);
    if (currentCallId) q.whereNot('id', currentCallId);
    const rows = await q.select(...cols);
    for (const r of rows) byId.set(String(r.id), r);
  }

  const cleanLast = String(lastName || '').trim().toLowerCase();
  if (includeHouseholdMatch && normalizedStreet && cleanLast) {
    const custRows = await conn('customers')
      .whereRaw("LOWER(TRIM(COALESCE(last_name, ''))) = ?", [cleanLast])
      .whereNotNull('address_line1')
      .whereNot('active', false)
      .limit(20)
      .select('id', 'address_line1');
    const householdIds = custRows
      .filter((c) => normalizedStreetKey(c.address_line1) === normalizedStreet)
      .map((c) => c.id);
    if (householdIds.length) {
      const q = whereNotSandboxCall(conn('call_log'))
        .whereIn('customer_id', householdIds)
        .whereNotIn('processing_status', ['spam', 'voicemail'])
        .where('created_at', '>=', since)
        .where('created_at', '<', anchor)
        .orderBy('created_at', 'desc')
        .limit(10);
      if (currentCallId) q.whereNot('id', currentCallId);
      const rows = await q.select(...cols);
      for (const r of rows) byId.set(String(r.id), r);
    }
  }

  return [...byId.values()];
}

function isVisitReServiceRow(visit) {
  if (!visit) return true;
  if (visit.is_callback === true) return true;
  if (RESERVICE_LABEL_RE.test(String(visit.service_type || ''))) return true;
  return false;
}

async function isConfirmedNonReServiceBooking(conn, bookedServiceId, customerId) {
  if (!bookedServiceId || !customerId) return false;
  const visit = await conn('scheduled_services')
    .where({ id: bookedServiceId, customer_id: customerId })
    .first('id', 'status', 'is_callback', 'service_type', 'service_id');
  if (!visit || isVisitReServiceRow(visit)) return false;
  if (!CONFIRMED_OR_FULFILLED_STATUSES.has(String(visit.status || ''))) return false;
  if (visit.service_id) {
    const cat = await conn('service_catalog')
      .where({ id: visit.service_id })
      .first('service_key', 'name')
      .catch(() => null);
    if (cat && (String(cat.service_key || '').includes('reservice')
      || String(cat.service_key || '').includes('re_service')
      || RESERVICE_LABEL_RE.test(String(cat.name || '')))) {
      return false;
    }
  }
  return true;
}

function callSidMatchesBookedLead(sibling, leadIdStr, leadCallSid) {
  if (!sibling?.twilio_call_sid) return false;
  if (leadCallSid && String(sibling.twilio_call_sid) === String(leadCallSid)) return true;
  const md = parseMaybeJson(sibling.metadata);
  return Boolean(md && md.lead_id && String(md.lead_id) === leadIdStr);
}

// Retire ONLY identifiable call-intake new-lead alerts tied directly to the booked
// `leadId` or its originating call SID (never website quote alerts from public-quote.js
// or missed-callback alerts sharing metadata.leadId). Works even when Call 1 was a
// customerless voicemail whose lead only attached on Call 2.
async function retireBookedLeadBells(conn, { leadId, siblings, anchor, since }) {
  if (!leadId) return 0;
  const leadIdStr = String(leadId);
  const leadRow = await conn('leads').where({ id: leadId }).whereNull('deleted_at').first('id', 'twilio_call_sid');
  const leadCallSid = leadRow?.twilio_call_sid || null;
  const matchingCallSids = [
    ...new Set([
      ...(leadCallSid ? [leadCallSid] : []),
      ...(siblings || []).filter((s) => callSidMatchesBookedLead(s, leadIdStr, leadCallSid)).map((s) => s.twilio_call_sid),
    ]),
  ];

  const now = new Date();
  const count = await conn('notifications')
    .whereNull('done_at')
    .whereIn('category', ['new_lead', 'lead'])
    .whereIn('title', CALL_NEW_LEAD_ALERT_TITLES)
    .where('created_at', '>=', since)
    .where('created_at', '<', anchor)
    .where((qb) => {
      qb.whereRaw("metadata->>'leadId' = ?", [leadIdStr]);
      if (matchingCallSids.length) {
        const placeholders = matchingCallSids.map(() => '?').join(', ');
        qb.orWhereRaw(`metadata->>'callSid' IN (${placeholders})`, matchingCallSids);
      }
    })
    .update({
      done_at: now,
      read_at: conn.raw('COALESCE(read_at, ?)', [now]),
      done_by: 'call_episode_reconciliation',
      resolution: 'Follow-up call booked appointment within 48h episode',
    });
  return Number(count || 0);
}

function hasAddressConflictHold(opts) {
  const reasons = Array.isArray(opts.bridgeNeedsConfirmation) ? opts.bridgeNeedsConfirmation : [];
  if (opts.streetLevelPending === true || opts.appointmentResult?.streetLevelPending === true
      || opts.appointmentResult?.pendingOfficeReview === true) {
    return true;
  }
  return reasons.some((r) => ADDRESS_CONFLICT_HOLD_REASONS.has(r));
}

function isCallTerminalNoise(opts) {
  return opts.isSpam === true || opts.extracted?.is_spam === true
    || opts.isVoicemail === true || opts.extracted?.is_voicemail === true;
}

async function callGenerationStillCurrent(conn, callId, procGeneration) {
  if (procGeneration == null) return true;
  const row = await conn('call_log').where({ id: callId }).first('processing_generation', 'processing_token');
  if (!row || row.processing_token != null) return false;
  return Number(row.processing_generation) === Number(procGeneration);
}

async function settleSiblingTriageCards(conn, { customerId, priorCallIds, anchor, opts }) {
  if (!priorCallIds.length) return 0;
  const triageReconciler = opts.triageReconciler || require('./triage-auto-resolve').reconcileSiblingCallsNow;
  const sweepRes = await triageReconciler({ callIds: priorCallIds, now: anchor });
  let resolved = Number(sweepRes?.applied || 0);

  const customer = await conn('customers').where({ id: customerId }).first('id', 'email', 'active');
  if (customer && customer.active !== false && cleanValidEmailOrNull(customer.email)) {
    const emailResolver = opts.emailResolver || require('./customer-email-fanout').resolveOpenEmailReviewCards;
    const emailResolved = await emailResolver({
      customerId,
      email: customer.email,
      source: '48h episode follow-up call',
      reasonCodes: ['customer_email_missing'],
      restrictToCallLogIds: priorCallIds,
    }, conn);
    resolved += Number(emailResolved || 0);
  }
  return resolved;
}

async function maybeRetireBookedLeadBells(conn, { customerId, siblings, anchor, since, opts }) {
  const bookedServiceId = opts.bookedServiceId || opts.appointmentResult?.scheduledServiceId || null;
  const leadId = opts.leadId || null;
  if (!bookedServiceId || !leadId) return 0;
  if (!(await isConfirmedNonReServiceBooking(conn, bookedServiceId, customerId))) return 0;
  return retireBookedLeadBells(conn, { leadId, siblings, anchor, since });
}

// Post-finalization, generation-fenced episode reconciliation:
// - Delegates Call 1 open address/name card resolution to triage-auto-resolve.reconcileSiblingCallsNow
// - Delegates Call 1 customer_email_missing settlement to customer-email-fanout.resolveOpenEmailReviewCards
// - Retires stale Call 1 call-intake new-lead alerts on confirmed non-re-service bookings
// Best-effort & non-throwing by contract.
async function reconcilePriorEpisodeOnCallCompletion(conn, opts = {}) {
  const empty = { cardsResolved: 0, bellsRetired: 0 };
  const callId = opts.callId || opts.call?.id || null;
  const customerId = opts.customerId || null;
  if (!conn || !callId || !customerId || isCallTerminalNoise(opts)) return empty;
  try {
    if (!(await callGenerationStillCurrent(conn, callId, opts.procGeneration))) return empty;
    if (hasAddressConflictHold(opts)) return empty;

    const anchor = anchorDate(opts.callCreatedAt || opts.call?.created_at);
    const since = windowStartFrom(anchor);
    const siblings = await findRecentEpisodeSiblingCalls(conn, {
      customerId,
      currentCallId: callId,
      anchorCreatedAt: anchor,
    });
    const priorCallIds = siblings.map((s) => s.id);
    const cardsResolved = await settleSiblingTriageCards(conn, { customerId, priorCallIds, anchor, opts });
    const bellsRetired = await maybeRetireBookedLeadBells(conn, { customerId, siblings, anchor, since, opts });
    return { cardsResolved, bellsRetired };
  } catch (err) {
    logger.warn(`[call-episode] reconciliation failed for call ${callId}: ${err.code || err.name || 'db_error'}`);
    return empty;
  }
}

// Pure predicate: is this inbound SMS a delivery-only photo submission (bare media
// OR a single photo-delivery caption with zero questions, bids, ballparks, or
// additional service/scheduling requests)?
function isPhotoSubmissionSms({ triggerBody = '', hasMedia = false } = {}) {
  const body = String(triggerBody || '').trim();
  if (!body) return Boolean(hasMedia);
  if (NON_DELIVERY_ASK_RE.test(body)) return false;
  return DELIVERY_ONLY_PHOTO_CAPTION_RE.test(body);
}

// Pure predicate: did diarized Waves staff (`Agent:` lines ONLY) explicitly ask for
// photos/pictures in this call transcript? Fails open (false) when speaker labels are absent.
function transcriptRequestedPhotos(transcription) {
  const text = String(transcription || '');
  if (!text) return false;
  const agentLines = text
    .split('\n')
    .filter((line) => /^\s*Agent\s*:/i.test(line))
    .join('\n');
  if (!agentLines) return false;
  return STAFF_PHOTO_REQUEST_RE.test(agentLines);
}

async function smsRowHasMedia(conn, triggerSmsLogId, timeoutMs) {
  if (!triggerSmsLogId || typeof conn !== 'function') return false;
  try {
    const row = await conn('sms_log')
      .modify(excludeUnresolvedSendReservations)
      .where({ id: triggerSmsLogId })
      .timeout(timeoutMs, { cancel: true })
      .first('metadata');
    const md = parseMaybeJson(row?.metadata);
    return Array.isArray(md?.media) && md.media.length > 0;
  } catch {
    return false;
  }
}

// Suppress false "Quote asked by text" ONLY when a customer texts a delivery-only
// photo follow-up answering a recent INBOUND call (<=48h; excludes outbound calls
// whose speaker labels may swap) where Agent: explicitly asked for photos.
// Fail-open & bounded so Twilio webhook latency is preserved and real quotes never drop.
async function isPhotoFollowUpToRecentCall(conn, {
  phone,
  triggerBody = '',
  triggerSmsLogId = null,
  hasMedia,
  now = null,
  timeoutMs = PHOTO_LOOKUP_TIMEOUT_MS,
} = {}) {
  const digits = last10(phone);
  if (digits.length < 10 || typeof conn !== 'function') return false;
  try {
    const mediaPresent = hasMedia !== undefined
      ? Boolean(hasMedia)
      : await smsRowHasMedia(conn, triggerSmsLogId, timeoutMs);
    if (!isPhotoSubmissionSms({ triggerBody, hasMedia: mediaPresent })) return false;

    const anchor = anchorDate(now);
    const since = windowStartFrom(anchor);
    const recentCalls = await whereNotSandboxCall(conn('call_log'))
      .whereRaw(
        "(right(regexp_replace(coalesce(from_phone,''),'\\D','','g'),10) = ? OR right(regexp_replace(coalesce(to_phone,''),'\\D','','g'),10) = ?)",
        [digits, digits],
      )
      .whereRaw("COALESCE(direction, '') NOT LIKE 'outbound%'")
      .whereNotIn('processing_status', ['spam', 'voicemail'])
      .whereNotNull('transcription')
      .where('created_at', '>=', since)
      .where('created_at', '<=', anchor)
      .orderBy('created_at', 'desc')
      .limit(5)
      .timeout(timeoutMs, { cancel: true })
      .select('id', 'transcription');

    return recentCalls.some((c) => transcriptRequestedPhotos(c.transcription));
  } catch (err) {
    logger.warn(`[call-episode] photo follow-up lookup failed (fail-open): ${err.code || err.name || 'db_error'}`);
    return false;
  }
}

function sourceFromLeadRow(leadRow) {
  if (!leadRow?.source_type) return null;
  const mapped = attributionForSourceType(leadRow.source_type)?.leadSource || leadRow.source_type;
  // Generic tracking wrappers (`phone_tracking`) defer to the dialed number configuration.
  if (isGenericCallLeadSource(mapped)) return null;
  return {
    at: new Date(leadRow.created_at).getTime(),
    source: mapped,
    detail: leadRow.name || mapped,
    callSid: leadRow.twilio_call_sid || null,
  };
}

async function priorCallFirstTouchCandidate(conn, { digits, currentCallId, since, anchor, twilioNumbers, leadByCallSid }) {
  if (!twilioNumbers || typeof twilioNumbers.findByNumber !== 'function') return null;
  const q = whereNotSandboxCall(conn('call_log'))
    .whereRaw("right(regexp_replace(coalesce(from_phone,''),'\\D','','g'),10) = ?", [digits])
    .whereRaw("COALESCE(direction, '') NOT LIKE 'outbound%'")
    .whereNotIn('processing_status', ['spam'])
    .where('created_at', '>=', since)
    .where('created_at', '<', anchor)
    .orderBy('created_at', 'asc')
    .limit(5);
  if (currentCallId) q.whereNot('id', currentCallId);
  const priorCalls = await q.select('twilio_call_sid', 'to_phone', 'created_at');
  for (const prior of priorCalls) {
    const callAt = new Date(prior.created_at).getTime();
    const linkedLead = prior.twilio_call_sid ? leadByCallSid.get(String(prior.twilio_call_sid)) : null;
    if (linkedLead) return { ...linkedLead, at: callAt };
    const cfg = twilioNumbers.findByNumber(prior.to_phone);
    if (!cfg) continue;
    const resolved = twilioNumbers.getLeadSourceFromNumber(prior.to_phone);
    if (resolved && !isGenericCallLeadSource(resolved.source)) {
      return {
        at: callAt,
        source: resolved.source,
        detail: resolved.detail || resolved.domain || cfg.domain || resolved.area || 'prior inbound call',
      };
    }
  }
  return null;
}

async function priorLeadFirstTouchCandidates(conn, { digits, since, anchor }) {
  const rows = await conn('leads')
    .join('lead_sources', 'leads.lead_source_id', 'lead_sources.id')
    .whereNull('leads.deleted_at')
    .whereRaw("right(regexp_replace(coalesce(leads.phone,''),'\\D','','g'),10) = ?", [digits])
    .where('leads.created_at', '>=', since)
    .where('leads.created_at', '<', anchor)
    .orderBy('leads.created_at', 'asc')
    .limit(5)
    .select('leads.created_at', 'leads.twilio_call_sid', 'lead_sources.source_type', 'lead_sources.name');
  const list = (Array.isArray(rows) ? rows : []).map(sourceFromLeadRow).filter(Boolean);
  const byCallSid = new Map();
  for (const item of list) {
    if (item.callSid && !byCallSid.has(String(item.callSid))) byCallSid.set(String(item.callSid), item);
  }
  return { earliest: list[0] || null, byCallSid };
}

// Preserve first-touch acquisition lead_source across repeat or outbound callback calls
// within 48h — even when Call 2 dials a different tracking line (e.g. Google Ads voicemail
// followed by an inbound GBP call). Explicit spoken referral on Call 2 still wins.
// Fail-open to currentLeadSource on any error.
async function resolveFirstTouchCallLeadSource(conn, {
  contactPhone,
  currentCallId = null,
  currentCallCreatedAt = null,
  currentLeadSource = null,
  hasExplicitReferral = false,
  referredByName = '',
  twilioNumbers = null,
} = {}) {
  const fallback = currentLeadSource || { source: 'phone_call' };
  if (hasExplicitReferral || Boolean(referredByName)) return fallback;

  const digits = last10(contactPhone);
  if (digits.length < 10 || typeof conn !== 'function') return fallback;

  try {
    const anchor = anchorDate(currentCallCreatedAt);
    const since = windowStartFrom(anchor);
    const { earliest: leadCand, byCallSid } = await priorLeadFirstTouchCandidates(conn, { digits, since, anchor });
    const callCand = await priorCallFirstTouchCandidate(conn, {
      digits, currentCallId, since, anchor, twilioNumbers, leadByCallSid: byCallSid,
    });
    const candidates = [callCand, leadCand].filter(Boolean);
    if (!candidates.length) return fallback;
    candidates.sort((a, b) => a.at - b.at);
    return { source: candidates[0].source, detail: String(candidates[0].detail || '').slice(0, 200) };
  } catch (err) {
    logger.warn(`[call-episode] first-touch lead_source lookup skipped: ${err.code || err.name || 'db_error'}`);
    return fallback;
  }
}

module.exports = {
  EPISODE_WINDOW_HOURS,
  isGenericCallLeadSource,
  shouldPreserveExistingLeadSource,
  loadRecentEpisodeSms,
  findRecentEpisodeSiblingCalls,
  reconcilePriorEpisodeOnCallCompletion,
  isPhotoSubmissionSms,
  transcriptRequestedPhotos,
  isPhotoFollowUpToRecentCall,
  resolveFirstTouchCallLeadSource,
  _test: {
    normalizedStreetKey,
    sanitizeEpisodeSmsBody,
    isVisitReServiceRow,
    isConfirmedNonReServiceBooking,
    callGenerationStillCurrent,
  },
};
