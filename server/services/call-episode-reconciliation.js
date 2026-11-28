'use strict';

/**
 * 48-Hour Multi-Call + SMS Episode Reconciliation (PR B2, $0.00 spend, no new gate).
 *
 * Connects related calls and texts within a 48-hour customer episode using 100%
 * deterministic DB logic (zero extra LLM prompt tokens) and strictly delegates
 * every card/alert status write to the repo's ONE authoritative mechanism:
 * 1. Post-finalization, generation-fenced episode reconciliation:
 *    - Delegates Call 1 open address/name card resolution directly to
 *      `triage-auto-resolve.reconcileSiblingCallsNow` (inheriting all confirmed-unbooked,
 *      single-property, unit, locality, lockTriageCall, and gate protections).
 *    - Delegates Call 1 `customer_email_missing` settlement directly to
 *      `customer-email-fanout.resolveOpenEmailReviewCards` (never touching
 *      `email_unverified` / `email_invalid`).
 *    - Delegates open `new_lead` alert retirement directly to
 *      `admin-alert-relevance.reconcileLeadAlertsNow` (inheriting `newLeadMovedOn`,
 *      `done_by: 'relevance'`, `metadata.retired`, kill switch, and automatic re-arming
 *      if a follow-up booking is later cancelled).
 * 2. Suppresses false "Quote asked by text" owed-quote bells ONLY when an inbound photo
 *    SMS is a delivery-only photo submission answering an inbound 48h call where `Agent:`
 *    explicitly requested photos (never suppressing questions, bids, ballparks, or mixed
 *    service/scheduling captions).
 * 3. Preserves first-touch `lead_source` across repeat or outbound callback calls within
 *    48h (comparing earlier tracking lines + linked lead attribution while verifying
 *    caller identity across BOTH leads and calls on shared lines and keeping an explicit
 *    spoken referral override).
 */

const logger = require('./logger');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
const { excludeUnresolvedSendReservations } = require('./messaging/review-ask-reservation');
const { cleanValidEmailOrNull } = require('../utils/intake-normalize');
const { attributionForSourceType } = require('./ads/call-attribution');

const EPISODE_WINDOW_HOURS = 48;
const PHOTO_LOOKUP_TIMEOUT_MS = 800;

const ADDRESS_CONFLICT_HOLD_REASONS = Object.freeze(new Set([
  'street_level_address_review',
  'on_file_house_number_conflict',
  'address_unit_conflict',
  'second_service_address',
  'multi_property_call',
]));

const GENERIC_LEAD_SOURCES = Object.freeze(new Set([
  '', 'phone_call', 'direct', 'phone', 'phone_tracking', 'inbound_call', 'outbound_call', 'unknown',
]));

const NON_DELIVERY_ASK_RE = /\?|\b(?:how\s+much|quote|price|pricing|cost|estimate|rate|charge|charges|ballpark|bid|range|approx\w*|rough\s+(?:idea|number|figure)|schedule|book|appoint\w*|also|too\b|(?:i|we)\s+(?:need|want|would\s+like)\b|looking\s+for\b|another\s+property|please\s+(?:treat|spray|send|quote|price|check|schedule|book|come|call|add)|can\s+you\b|do\s+you\b|would\s+(?:it|that|this)\b|what\s+would\b|run\s+me\b)\b/i;
const LEADING_GREETING_RE = /^(?:hi|hello|hey|thanks|thank you|ok|okay|sure)(?:[,!.—-]|\s)+/i;
const TRAILING_THANKS_RE = /(?:[,!-]|\s)+(?:thanks|thank you|thx|ty)[.!]?$/i;
const PHOTO_NOUN_RE = '(?:pic(?:ture)?s?|photos?|images?|snapshots?)';
const PHOTO_SUBJECT_RE = '(?:(?:of|from|for) (?:the |my |our |those |these )?(?:(?:front|back|side) )?(?:yard|lawn|grass|house|home|porch|patio|pool|garage|attic|kitchen|bathroom|bedroom|wall|ceiling|roof|eaves|tree|trees|bush|bushes|shrub|shrubs|nest|hive|mound|ants?(?: mound)?|bugs?|pests?|weeds?|roach(?:es)?|wasps?(?: nest)?|hornets?(?: nest)?|bees?(?: hive)?|termites?|rodents?|mouse|mice|rats?|fleas?|spiders?|spots?|patch(?:es)?|damage|area|issue|problem|visit|call|tech(?:nician)?))';
const PHOTO_TAIL_CHUNK_RE = `(?:${PHOTO_SUBJECT_RE}|you (?:asked|requested)(?: for)?|as requested|for you|from (?:our|the) call|attached|below|above|just now|now)`;
// Linear-time (single-space normalized, no nested quantifiers) delivery-only caption matcher.
const DELIVERY_ONLY_PHOTO_CAPTION_RE = new RegExp(
  `^(?:(?:here(?:'s|’s| is| are)?|attached(?: is| are)?|sending|sent|sharing) (?:(?:is|are) )?(?:(?:the|a|my|some) )?${PHOTO_NOUN_RE}|(?:(?:the|a|my|some) )?${PHOTO_NOUN_RE})(?: ${PHOTO_TAIL_CHUNK_RE}){0,3}[.!]?$`,
  'i',
);
const NEGATED_PHOTO_REQUEST_RE = /\b(?:don'?t|do not|no need to|never|not|won'?t)\b[^.!?\n]{0,25}\b(?:text|send|shoot|email|message|snap)\b[^.!?\n]{0,40}\b(?:pic(?:ture)?s?|photos?|images?)\b/i;
const AGENT_SELF_SEND_PHOTO_RE = /\b(?:i'?ll|i will|we'?ll|we will|let me|going to)\b[^.!?\n]{0,20}\b(?:text|send|shoot|email|message)\b[^.!?\n]{0,30}\b(?:pic(?:ture)?s?|photos?|images?)\b/i;
const CALLER_DIRECTED_PHOTO_REQUEST_RE = /\b(?:can you|could you|would you|if you(?:'d| could| can| want to)?|please|go ahead and|feel free to|just|you can|want to|wanna)\s+(?:text|send|shoot|email|message|snap)\b[^.!?\n]{0,40}\b(?:pic(?:ture)?s?|photos?|images?)\b/i;
const MAX_DELIVERY_CAPTION_CHARS = 160;

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

// Delegates open `new_lead` alert retirement to `admin-alert-relevance.reconcileLeadAlertsNow`
// so every retired alert carries `done_by: 'relevance'` + `metadata.retired` and automatically
// re-arms if the follow-up booking is later cancelled (zero duplicate notification writers).
async function maybeRetireBookedLeadBells(conn, { callId, resolvedAt, opts }) {
  const bookedServiceId = opts.bookedServiceId || opts.appointmentResult?.scheduledServiceId || null;
  const leadId = opts.leadId || null;
  if (!bookedServiceId || !leadId) return 0;
  if (!(await callGenerationStillCurrent(conn, callId, opts.procGeneration))) return 0;
  const alertReconciler = opts.alertReconciler || require('./admin-alert-relevance').reconcileLeadAlertsNow;
  const res = await alertReconciler({ leadId, now: resolvedAt });
  return Number(res?.retired || 0);
}

// Post-finalization, generation-fenced episode reconciliation:
// - Delegates Call 1 open address/name card resolution to triage-auto-resolve.reconcileSiblingCallsNow
// - Delegates Call 1 customer_email_missing settlement to customer-email-fanout.resolveOpenEmailReviewCards
// - Delegates booked-lead `new_lead` alert retirement to admin-alert-relevance.reconcileLeadAlertsNow
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
      callId, resolvedAt, opts,
    });
    return { cardsResolved, bellsRetired };
  } catch (err) {
    logger.warn(`[call-episode] reconciliation failed for call ${callId}: ${err.code || err.name || 'db_error'}`);
    return empty;
  }
}

function stripBoundedGreetings(text) {
  let out = String(text || '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3; i += 1) {
    const next = out.replace(LEADING_GREETING_RE, '').trim();
    if (next === out) break;
    out = next;
  }
  return out.replace(TRAILING_THANKS_RE, '').trim();
}

// Pure predicate: is this inbound SMS a delivery-only photo submission (bare media
// OR a single linear-time photo-delivery caption with zero questions, bids, ballparks,
// or additional service/scheduling requests)?
function isPhotoSubmissionSms({ triggerBody = '', hasMedia = false } = {}) {
  const raw = String(triggerBody || '').trim();
  if (!raw) return Boolean(hasMedia);
  if (raw.length > MAX_DELIVERY_CAPTION_CHARS) return false;
  if (NON_DELIVERY_ASK_RE.test(raw)) return false;
  const body = stripBoundedGreetings(raw);
  if (!body) return Boolean(hasMedia);
  return DELIVERY_ONLY_PHOTO_CAPTION_RE.test(body);
}

// Pure predicate: did diarized Waves staff (`Agent:` lines ONLY) make an affirmative
// caller-directed request for photos/pictures? Rejects negated statements ("don't send
// photos") and agent offers ("I'll send you a photo"). Fails open (false) without labels.
function transcriptRequestedPhotos(transcription) {
  const text = String(transcription || '');
  if (!text) return false;
  const agentLines = text
    .split('\n')
    .filter((line) => /^\s*Agent\s*:/i.test(line));
  return agentLines.some((line) => (
    CALLER_DIRECTED_PHOTO_REQUEST_RE.test(line)
    && !NEGATED_PHOTO_REQUEST_RE.test(line)
    && !AGENT_SELF_SEND_PHOTO_RE.test(line)
  ));
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
  if (candFirst && callFirst && candFirst !== callFirst) return true;
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

function trackingSourceForPriorCall(prior, twilioNumbers, callAt) {
  const cfg = twilioNumbers.findByNumber(prior.to_phone);
  if (!cfg) return null;
  const resolved = twilioNumbers.getLeadSourceFromNumber(prior.to_phone);
  if (!resolved || isGenericCallLeadSource(resolved.source)) return null;
  return {
    at: callAt,
    source: resolved.source,
    detail: resolved.detail || resolved.domain || cfg.domain || resolved.area || 'prior inbound call',
  };
}

async function priorCallFirstTouchCandidate(conn, {
  digits, currentCallId, since, anchor, twilioNumbers, leadByCallSid, rejectedCallSids, callerIdentity,
}) {
  if (!twilioNumbers || typeof twilioNumbers.findByNumber !== 'function') return null;
  const q = whereNotSandboxCall(conn('call_log'))
    .whereRaw("right(regexp_replace(coalesce(from_phone,''),'\\D','','g'),10) = ?", [digits])
    .whereRaw("COALESCE(direction, '') NOT LIKE 'outbound%'")
    .whereNotIn('processing_status', ['spam'])
    .whereRaw("COALESCE(metadata->>'no_attribution', 'false') <> 'true'")
    .where('created_at', '>=', since)
    .where('created_at', '<', anchor)
    .orderBy('created_at', 'asc')
    .limit(5);
  if (currentCallId) q.whereNot('id', currentCallId);
  const priorCalls = await q.select('twilio_call_sid', 'to_phone', 'created_at', 'ai_extraction');
  const rejected = rejectedCallSids || new Set();
  for (const prior of priorCalls) {
    const sid = prior.twilio_call_sid ? String(prior.twilio_call_sid) : null;
    if (sid && rejected.has(sid)) continue;
    const ext = parseMaybeJson(prior.ai_extraction);
    if (identityConflictsWithCaller({ firstName: ext?.first_name, lastName: ext?.last_name }, callerIdentity)) {
      if (sid) rejected.add(sid);
      continue;
    }
    const callAt = new Date(prior.created_at).getTime();
    const linkedLead = sid ? leadByCallSid.get(sid) : null;
    if (linkedLead) return { ...linkedLead, at: callAt };
    const tracked = trackingSourceForPriorCall(prior, twilioNumbers, callAt);
    if (tracked) return tracked;
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
  const rejectedCallSids = new Set();
  const list = [];
  for (const row of (Array.isArray(rows) ? rows : [])) {
    if (identityConflictsWithCaller({ firstName: row.first_name, lastName: row.last_name }, callerIdentity)) {
      if (row.twilio_call_sid) rejectedCallSids.add(String(row.twilio_call_sid));
      continue;
    }
    const item = sourceFromLeadRow(row, callerIdentity);
    if (item) list.push(item);
  }
  const byCallSid = new Map();
  for (const item of list) {
    if (item.callSid && !byCallSid.has(String(item.callSid))) byCallSid.set(String(item.callSid), item);
  }
  return { list, byCallSid, rejectedCallSids };
}

function pickEarliestCandidate(candidates, fallback) {
  const valid = candidates.filter(Boolean);
  if (!valid.length) return fallback;
  valid.sort((a, b) => a.at - b.at);
  return { source: valid[0].source, detail: String(valid[0].detail || '').slice(0, 200) };
}

// Preserve first-touch acquisition lead_source across repeat or outbound callback calls
// within 48h — even when Call 2 dials a different tracking line (e.g. Google Ads voicemail
// followed by an inbound GBP call). Verifies caller identity across BOTH leads and calls
// (retaining rejected SIDs so neither fallback inherits another caller's channel) and
// preserves an explicit spoken referral override. Fail-open to currentLeadSource on error.
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
    const { list: leadList, byCallSid, rejectedCallSids } = await priorLeadFirstTouchCandidates(conn, {
      digits, since, anchor, callerIdentity,
    });
    const callCand = await priorCallFirstTouchCandidate(conn, {
      digits,
      currentCallId: opts.currentCallId || null,
      since,
      anchor,
      twilioNumbers: opts.twilioNumbers || null,
      leadByCallSid: byCallSid,
      rejectedCallSids,
      callerIdentity,
    });
    const leadCand = leadList.find((item) => !item.callSid || !rejectedCallSids.has(String(item.callSid))) || null;
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
    callGenerationStillCurrent,
    identityConflictsWithCaller,
  },
};
