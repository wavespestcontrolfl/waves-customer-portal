'use strict';

/**
 * 48-Hour Multi-Call + SMS Episode Reconciliation (PR B2, $0.00 spend, no new gate).
 *
 * Connects related calls and texts within a 48-hour customer episode using 100%
 * deterministic DB logic (zero extra LLM prompt tokens) and strictly delegates
 * triage card resolution to the repo's ONE authoritative mechanisms:
 * 1. Post-finalization, generation-fenced episode reconciliation:
 *    - Delegates Call 1 open address/name card resolution directly to
 *      `triage-auto-resolve.reconcileSiblingCallsNow` (inheriting all confirmed-unbooked,
 *      single-property, unit, locality, lockTriageCall, and gate protections).
 *    - Delegates Call 1 `customer_email_missing` settlement directly to
 *      `customer-email-fanout.resolveOpenEmailReviewCards` (never touching
 *      `email_unverified` / `email_invalid`).
 *    - Retires ONLY identifiable call-intake new-lead alerts tied to the booked `leadId`
 *      on confirmed/fulfilled non-re-service visits (including voicemail-first leads),
 *      with an atomic SQL `processing_generation` + released-token fence.
 * 2. Suppresses false "Quote asked by text" owed-quote bells ONLY when an inbound photo
 *    SMS is a delivery-only photo submission answering an inbound 48h call where `Agent:`
 *    explicitly requested photos (never suppressing questions, bids, ballparks, or mixed
 *    service/scheduling captions).
 * 3. Preserves first-touch `lead_source` across repeat or outbound callback calls within
 *    48h (comparing earlier tracking lines + linked lead attribution while verifying
 *    caller identity on shared lines and keeping an explicit spoken referral override).
 */

const logger = require('./logger');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
const { excludeUnresolvedSendReservations } = require('./messaging/review-ask-reservation');
const { cleanValidEmailOrNull } = require('../utils/intake-normalize');
const { attributionForSourceType } = require('./ads/call-attribution');
const { isReService } = require('./re-service');

const EPISODE_WINDOW_HOURS = 48;
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

const NON_DELIVERY_ASK_RE = /\?|\b(?:how\s+much|quote|price|pricing|cost|estimate|rate|charge|charges|ballpark|bid|range|approx\w*|rough\s+(?:idea|number|figure)|schedule|book|appoint\w*|also|too\b|(?:i|we)\s+(?:need|want|would\s+like)\b|looking\s+for\b|another\s+property|please\s+(?:treat|spray|send|quote|price|check|schedule|book|come|call|add)|can\s+you\b|do\s+you\b|would\s+(?:it|that|this)\b|what\s+would\b|run\s+me\b)\b/i;
const PHOTO_SUBJECT_RE = '(?:(?:of|from|for)\\s+(?:the\\s+|my\\s+|our\\s+|those\\s+|these\\s+)?(?:(?:front|back|side)\\s+)?(?:yard|lawn|grass|house|home|porch|patio|pool|garage|attic|kitchen|bathroom|bedroom|wall|ceiling|roof|eaves|tree|trees|bush|bushes|shrub|shrubs|nest|hive|mound|ant(?:s|\\s+mound)?|bug|bugs|pest|pests|weed|weeds|roach(?:es)?|wasp(?:s|\\s+nest)?|hornet(?:s|\\s+nest)?|bee(?:s|\\s+hive)?|termite(?:s)?|rodent(?:s)?|mouse|mice|rat|rats|flea|fleas|spider|spiders|spot|spots|patch|patches|damage|area|issue|problem|visit|call|tech(?:nician)?))';
const PHOTO_DELIVERY_TAIL_RE = `(?:\\s+(?:${PHOTO_SUBJECT_RE}|you\\s+(?:asked|requested)(?:\\s+for)?|as\\s+requested|for\\s+you|from\\s+(?:our|the)\\s+call|attached|below|above|now|just\\s+now)){0,3}(?:\\s*[,!-]?\\s*(?:thanks|thank\\s+you|thx|ty))?`;
// Delivery-only caption: the ENTIRE message (optional greeting + photo-delivery phrase +
// strictly allowlisted subject/closing tail) states only that photos are being delivered.
const DELIVERY_ONLY_PHOTO_CAPTION_RE = new RegExp(
  `^(?:(?:hi|hello|hey|thanks|thank\\s+you|ok(?:ay)?|sure)\\s*[,!.—-]?\\s*)*(?:(?:here(?:'s|’s| is| are)?|attached(?:\\s+is|\\s+are)?|sending|sent|sharing)\\s+(?:is\\s+|are\\s+)?(?:the\\s+|a\\s+|my\\s+|some\\s+)?(?:pic(?:ture)?s?|photos?|images?|snapshots?)|(?:the\\s+|a\\s+|my\\s+)?(?:pic(?:ture)?s?|photos?|images?)\\s+(?:of|from|as\\s+requested|you\\s+asked|for\\s+you))${PHOTO_DELIVERY_TAIL_RE}[.!]?$`,
  'i',
);
const STAFF_PHOTO_REQUEST_RE = /\b(?:text|send|shoot|email|message|snap)\b[^.!?\n]{0,50}\b(?:pic(?:ture)?s?|photos?|images?)\b/i;
const RESERVICE_LABEL_RE = /\b(?:re[- ]?service|callback\s+treatment|covered\s+re[- ]?service)\b/i;

const last10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);
const normName = (v) => String(v || '').toLowerCase().replace(/[^a-z]/g, '').trim();

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

function isGenericCallLeadSource(source) {
  return GENERIC_LEAD_SOURCES.has(String(source || '').trim().toLowerCase());
}

function shouldPreserveExistingLeadSource(existingSource, incomingSource) {
  return !isGenericCallLeadSource(existingSource) && isGenericCallLeadSource(incomingSource);
}

// Find strictly earlier non-spam sibling calls within 48h for the same customer_id.
async function findRecentEpisodeSiblingCalls(conn, {
  customerId = null,
  currentCallId = null,
  anchorCreatedAt = null,
} = {}) {
  if (typeof conn !== 'function' || !customerId) return [];
  const anchor = anchorDate(anchorCreatedAt);
  const since = windowStartFrom(anchor);
  const cols = ['id', 'twilio_call_sid', 'customer_id', 'metadata', 'created_at', 'direction', 'to_phone'];
  const q = whereNotSandboxCall(conn('call_log'))
    .where({ customer_id: customerId })
    .whereNotIn('processing_status', ['spam', 'voicemail'])
    .where('created_at', '>=', since)
    .where('created_at', '<', anchor)
    .orderBy('created_at', 'desc')
    .limit(10);
  if (currentCallId) q.whereNot('id', currentCallId);
  return q.select(...cols);
}

function isVisitReServiceRow(visit) {
  if (!visit) return true;
  if (visit.is_callback === true) return true;
  if (isReService({ serviceType: visit.service_type })) return true;
  if (RESERVICE_LABEL_RE.test(String(visit.service_type || ''))) return true;
  return false;
}

// Fails CLOSED on missing catalog row or lookup error so a re-service / included
// trap follow-up never retires an active new-lead alert.
async function isConfirmedNonReServiceBooking(conn, bookedServiceId, customerId) {
  if (!bookedServiceId || !customerId) return false;
  try {
    const visit = await conn('scheduled_services')
      .where({ id: bookedServiceId, customer_id: customerId })
      .first('id', 'status', 'is_callback', 'service_type', 'service_id');
    if (!visit || isVisitReServiceRow(visit)) return false;
    if (!CONFIRMED_OR_FULFILLED_STATUSES.has(String(visit.status || ''))) return false;
    if (visit.service_id) {
      const svc = await conn('services')
        .where({ id: visit.service_id })
        .first('service_key', 'name');
      if (!svc) return false;
      if (isReService({ serviceKey: svc.service_key, serviceName: svc.name, serviceType: visit.service_type })
        || RESERVICE_LABEL_RE.test(String(svc.name || ''))) {
        return false;
      }
    }
    return true;
  } catch (err) {
    logger.warn(`[call-episode] booking verification failed (fail-closed): ${err.code || err.name || 'db_error'}`);
    return false;
  }
}

function callSidMatchesBookedLead(sibling, leadIdStr, leadCallSid) {
  if (!sibling?.twilio_call_sid) return false;
  if (leadCallSid && String(sibling.twilio_call_sid) === String(leadCallSid)) return true;
  const md = parseMaybeJson(sibling.metadata);
  return Boolean(md && md.lead_id && String(md.lead_id) === leadIdStr);
}

// Retire ONLY identifiable call-intake new-lead alerts tied directly to the booked
// `leadId` or its originating call SID (never website quote alerts from public-quote.js
// or missed-callback alerts sharing metadata.leadId). Enforces an atomic SQL
// `processing_generation` + released-token predicate inside the UPDATE.
async function retireBookedLeadBells(conn, { callId, procGeneration, leadId, siblings, anchor, since, resolvedAt }) {
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

  const now = resolvedAt || new Date();
  const q = conn('notifications')
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
    });
  if (callId && procGeneration != null && typeof q.whereExists === 'function') {
    q.whereExists(function generationFence() {
      this.from('call_log')
        .where({ id: callId, processing_generation: procGeneration })
        .whereNull('processing_token')
        .select(1);
    });
  }
  const count = await q.update({
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

async function settleSiblingTriageCards(conn, { callId, customerId, priorCallIds, resolvedAt, opts }) {
  if (!priorCallIds.length) return 0;
  if (!(await callGenerationStillCurrent(conn, callId, opts.procGeneration))) return 0;
  const triageReconciler = opts.triageReconciler || require('./triage-auto-resolve').reconcileSiblingCallsNow;
  const sweepRes = await triageReconciler({ callIds: priorCallIds, now: resolvedAt });
  let resolved = Number(sweepRes?.applied || 0);

  if (!(await callGenerationStillCurrent(conn, callId, opts.procGeneration))) return resolved;
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

async function maybeRetireBookedLeadBells(conn, { callId, customerId, siblings, anchor, since, resolvedAt, opts }) {
  const bookedServiceId = opts.bookedServiceId || opts.appointmentResult?.scheduledServiceId || null;
  const leadId = opts.leadId || null;
  if (!bookedServiceId || !leadId) return 0;
  if (!(await isConfirmedNonReServiceBooking(conn, bookedServiceId, customerId))) return 0;
  return retireBookedLeadBells(conn, {
    callId,
    procGeneration: opts.procGeneration,
    leadId,
    siblings,
    anchor,
    since,
    resolvedAt,
  });
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
    const resolvedAt = opts.resolvedAt ? anchorDate(opts.resolvedAt) : new Date();
    const since = windowStartFrom(anchor);
    const siblings = await findRecentEpisodeSiblingCalls(conn, {
      customerId,
      currentCallId: callId,
      anchorCreatedAt: anchor,
    });
    const priorCallIds = siblings.map((s) => s.id);
    const cardsResolved = await settleSiblingTriageCards(conn, {
      callId, customerId, priorCallIds, resolvedAt, opts,
    });
    const bellsRetired = await maybeRetireBookedLeadBells(conn, {
      callId, customerId, siblings, anchor, since, resolvedAt, opts,
    });
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

function identityConflictsWithCaller(candidate, callerIdentity) {
  const candLast = normName(candidate?.lastName);
  const callLast = normName(callerIdentity?.lastName);
  if (candLast && callLast && candLast !== callLast) return true;
  const candFirst = normName(candidate?.firstName);
  const callFirst = normName(callerIdentity?.firstName);
  if (!candLast && !callLast && candFirst && callFirst && candFirst !== callFirst) return true;
  return false;
}

function sourceFromLeadRow(leadRow, callerIdentity) {
  if (!leadRow?.source_type) return null;
  if (identityConflictsWithCaller({ firstName: leadRow.first_name, lastName: leadRow.last_name }, callerIdentity)) {
    return null;
  }
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

async function isAmbiguousSharedPhone(conn, digits) {
  const matches = await conn('customers')
    .whereNull('deleted_at')
    .whereNot('active', false)
    .whereRaw("right(regexp_replace(coalesce(phone,''),'\\D','','g'),10) = ?", [digits])
    .limit(2)
    .select('id');
  return Array.isArray(matches) && matches.length > 1;
}

async function priorCallFirstTouchCandidate(conn, {
  digits, currentCallId, since, anchor, twilioNumbers, leadByCallSid, callerIdentity,
}) {
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
  const priorCalls = await q.select('twilio_call_sid', 'to_phone', 'created_at', 'ai_extraction');
  for (const prior of priorCalls) {
    const ext = parseMaybeJson(prior.ai_extraction);
    if (identityConflictsWithCaller({ firstName: ext?.first_name, lastName: ext?.last_name }, callerIdentity)) {
      continue;
    }
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

async function priorLeadFirstTouchCandidates(conn, { digits, since, anchor, callerIdentity }) {
  const rows = await conn('leads')
    .join('lead_sources', 'leads.lead_source_id', 'lead_sources.id')
    .whereNull('leads.deleted_at')
    .whereRaw("right(regexp_replace(coalesce(leads.phone,''),'\\D','','g'),10) = ?", [digits])
    .where('leads.created_at', '>=', since)
    .where('leads.created_at', '<', anchor)
    .orderBy('leads.created_at', 'asc')
    .limit(5)
    .select(
      'leads.created_at', 'leads.twilio_call_sid', 'leads.first_name', 'leads.last_name',
      'lead_sources.source_type', 'lead_sources.name',
    );
  const list = (Array.isArray(rows) ? rows : [])
    .map((row) => sourceFromLeadRow(row, callerIdentity))
    .filter(Boolean);
  const byCallSid = new Map();
  for (const item of list) {
    if (item.callSid && !byCallSid.has(String(item.callSid))) byCallSid.set(String(item.callSid), item);
  }
  return { earliest: list[0] || null, byCallSid };
}

function pickEarliestCandidate(candidates, fallback) {
  const valid = candidates.filter(Boolean);
  if (!valid.length) return fallback;
  valid.sort((a, b) => a.at - b.at);
  return { source: valid[0].source, detail: String(valid[0].detail || '').slice(0, 200) };
}

// Preserve first-touch acquisition lead_source across repeat or outbound callback calls
// within 48h — even when Call 2 dials a different tracking line (e.g. Google Ads voicemail
// followed by an inbound GBP call). Verifies caller identity and retains currentLeadSource
// on shared lines or conflicting names; explicit spoken referral on Call 2 still wins.
// Fail-open to currentLeadSource on any error.
async function resolveFirstTouchCallLeadSource(conn, opts = {}) {
  const fallback = opts.currentLeadSource || { source: 'phone_call' };
  if (opts.hasExplicitReferral || Boolean(opts.referredByName)) return fallback;

  const digits = last10(opts.contactPhone);
  if (digits.length < 10 || typeof conn !== 'function') return fallback;

  try {
    if (await isAmbiguousSharedPhone(conn, digits)) return fallback;
    const callerIdentity = { firstName: opts.callerFirstName || null, lastName: opts.callerLastName || null };
    const anchor = anchorDate(opts.currentCallCreatedAt);
    const since = windowStartFrom(anchor);
    const { earliest: leadCand, byCallSid } = await priorLeadFirstTouchCandidates(conn, {
      digits, since, anchor, callerIdentity,
    });
    const callCand = await priorCallFirstTouchCandidate(conn, {
      digits,
      currentCallId: opts.currentCallId || null,
      since,
      anchor,
      twilioNumbers: opts.twilioNumbers || null,
      leadByCallSid: byCallSid,
      callerIdentity,
    });
    return pickEarliestCandidate([callCand, leadCand], fallback);
  } catch (err) {
    logger.warn(`[call-episode] first-touch lead_source lookup skipped: ${err.code || err.name || 'db_error'}`);
    return fallback;
  }
}

module.exports = {
  EPISODE_WINDOW_HOURS,
  isGenericCallLeadSource,
  shouldPreserveExistingLeadSource,
  findRecentEpisodeSiblingCalls,
  reconcilePriorEpisodeOnCallCompletion,
  isPhotoSubmissionSms,
  transcriptRequestedPhotos,
  isPhotoFollowUpToRecentCall,
  resolveFirstTouchCallLeadSource,
  _test: {
    isVisitReServiceRow,
    isConfirmedNonReServiceBooking,
    callGenerationStillCurrent,
    identityConflictsWithCaller,
  },
};
