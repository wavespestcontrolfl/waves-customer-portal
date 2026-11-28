'use strict';

/**
 * 48-Hour Multi-Call + SMS Episode Reconciliation (PR B2, $0.00 spend, no new gate).
 *
 * Connects related calls and texts within a 48-hour customer episode using 100%
 * deterministic DB logic (zero extra LLM prompt tokens):
 * 1. Sanitized 48h SMS + household sibling context readers (URL/bearer-link, PAN,
 *    access-code, and prompt-delimiter scrubbed).
 * 2. Auto-resolves stale Call 1 open address and `customer_email_missing` triage cards
 *    under `lockTriageCall` + `syncCallReviewStatus`, and retires stale Call 1 new-lead
 *    bells tied to the booked lead once Call 2 verifies the address or books a confirmed
 *    non-re-service visit within 48h.
 *    - Strictly preserves `missing_unit_number`, `email_unverified`, `email_invalid`,
 *      `missing_first_name`, `missing_last_name`, human-claimed `in_progress` cards,
 *      multi-property accounts (fail-closed on count error), street-mismatched cards,
 *      and unrelated leads.
 * 3. Suppresses false "Quote asked by text" owed-quote bells when an inbound photo SMS
 *    answers a recent 48h call where diarized `Agent:` speech explicitly asked the caller
 *    to text a picture (unless the SMS explicitly asks for pricing/a quote).
 * 4. Preserves first-touch `lead_source` (Google Ads / GBP / organic / referral) across
 *    repeat or outbound callback calls so Call 2 never overwrites Call 1's channel with
 *    generic `phone_call` / `direct`.
 */

const logger = require('./logger');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
const { excludeUnresolvedSendReservations } = require('./messaging/review-ask-reservation');
const { lockTriageCall, syncCallReviewStatus } = require('../utils/triage-locks');
const { cleanValidEmailOrNull } = require('../utils/intake-normalize');
const { scrubPans } = require('../utils/pan-scrub');
const { redactAccessCodes } = require('./context-aggregator');
const { streetKey } = require('./customer-properties');
const { attributionForSourceType } = require('./ads/call-attribution');

const EPISODE_WINDOW_HOURS = 48;
const MAX_EPISODE_SMS = 5;
const MAX_SMS_SNIPPET_CHARS = 140;
const PHOTO_LOOKUP_TIMEOUT_MS = 800;

// Mirrors ADDRESS_MOOT_CODES in triage-auto-resolve.js.
// Deliberately EXCLUDES `missing_unit_number` (multi-unit landlord hazard) and
// `email_unverified` / `email_invalid` (Codex #3119 r10 P2 & lead-first-touch-resume).
const EPISODE_ADDRESS_CARD_CODES = Object.freeze([
  'missing_service_address',
  'address_unverified',
  'address_unverifiable',
  'low_confidence_address',
  'address_not_validated',
]);
const EPISODE_ADDRESS_CARD_SET = Object.freeze(new Set(EPISODE_ADDRESS_CARD_CODES));

const ADDRESS_CONFLICT_HOLD_REASONS = Object.freeze(new Set([
  'street_level_address_review',
  'on_file_house_number_conflict',
  'second_service_address',
  'multi_property_call',
]));

const GENERIC_LEAD_SOURCES = Object.freeze(new Set([
  '', 'phone_call', 'direct', 'phone', 'inbound_call', 'outbound_call', 'unknown',
]));

const URL_OR_SHORTLINK_RE = /\b(?:https?:\/\/\S+|www\.\S+|(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|to|ly|me|app|link|us|info|biz)\/\S*)/gi;
const DELIMITER_GUARD_RE = /<<<\s*PRIOR_CALL_DATA|PRIOR_CALL_DATA\s*>>>|<<<|>>>/gi;
const EXPLICIT_QUOTE_ASK_RE = /\b(?:how\s+much|quote|price|pricing|cost|estimate|rate|charge|charges)\b/i;
const PHOTO_SUBMISSION_RE = /\b(?:(?:here(?:'s|’s| is| are)?|attached|sending|sent|sharing)\b[^.!?\n]{0,45}\b(?:pic(?:ture)?s?|photos?|images?|snapshots?)|(?:pic(?:ture)?s?|photos?)\s+(?:of|from|as\s+requested|you\s+asked|for\s+you))\b/i;
const STAFF_PHOTO_REQUEST_RE = /\b(?:text|send|shoot|email|message|snap)\b[^.!?\n]{0,50}\b(?:pic(?:ture)?s?|photos?|images?)\b/i;

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

  if (customerId) {
    const q = whereNotSandboxCall(conn('call_log'))
      .where({ customer_id: customerId })
      .whereNotIn('processing_status', ['spam', 'voicemail'])
      .where('created_at', '>=', since)
      .where('created_at', '<', anchor)
      .orderBy('created_at', 'desc')
      .limit(10);
    if (currentCallId) q.whereNot('id', currentCallId);
    const rows = await q.select('id', 'twilio_call_sid', 'customer_id', 'lead_id', 'created_at', 'direction', 'to_phone');
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
      const rows = await q.select('id', 'twilio_call_sid', 'customer_id', 'lead_id', 'created_at', 'direction', 'to_phone');
      for (const r of rows) byId.set(String(r.id), r);
    }
  }

  return [...byId.values()];
}

function buildReconcilableCardCodes({ customer, singleProperty, addressVerified, validatedStreetKey, hasAddressConflictHold }) {
  const codes = [];
  if (addressVerified && !hasAddressConflictHold && singleProperty && validatedStreetKey
      && String(customer?.address_line1 || '').trim() && String(customer?.zip || '').trim()) {
    codes.push(...EPISODE_ADDRESS_CARD_CODES);
  }
  if (cleanValidEmailOrNull(customer?.email)) codes.push('customer_email_missing');
  return codes;
}

// Match an open address review card against the street validated on Call 2 (and the
// stored customer street). Never close a Street A card because Call 2 validated Street B.
function addressCardMatchesVerifiedStreet(row, validatedStreetKey) {
  if (!EPISODE_ADDRESS_CARD_SET.has(row?.reason_code)) return true;
  if (!validatedStreetKey) return false;
  const payload = parseMaybeJson(row?.payload);
  if (!payload || typeof payload !== 'object') return true;
  const heardTexts = [
    payload.address_as_heard,
    payload.heard_address?.street_line_1,
    payload.heard_address?.raw_text,
  ].filter((v) => String(v || '').trim());
  if (!heardTexts.length) return true;
  return heardTexts.every((t) => {
    const key = normalizedStreetKey(t);
    return key != null && key === validatedStreetKey;
  });
}

async function resolveOpenSiblingCards(conn, priorCallIds, customerId, codes, currentCallId, validatedStreetKey) {
  if (!priorCallIds.length || !codes.length) return 0;
  let totalResolved = 0;
  const now = new Date();
  const note = `Auto-resolved: follow-up call ${currentCallId} verified missing fields within 48h episode.`;

  for (const priorCallId of priorCallIds) {
    const resolvedForCall = await conn.transaction(async (trx) => {
      await lockTriageCall(trx, priorCallId);
      const openRows = await trx('triage_items')
        .where({ call_log_id: priorCallId, status: 'open' })
        .where((qb) => qb.whereNull('related_customer_id').orWhere('related_customer_id', customerId))
        .whereIn('reason_code', codes)
        .select('id', 'reason_code', 'payload');
      const eligibleIds = openRows
        .filter((r) => addressCardMatchesVerifiedStreet(r, validatedStreetKey))
        .map((r) => r.id);
      if (!eligibleIds.length) return 0;
      const count = await trx('triage_items')
        .whereIn('id', eligibleIds)
        .where({ status: 'open' })
        .update({
          status: 'resolved',
          resolution_rule: 'episode_call_reconciled',
          resolution_source: 'auto',
          resolution_note: note,
          resolved_at: now,
          updated_at: now,
        });
      if (count > 0) await syncCallReviewStatus(trx, priorCallId, 'resolved');
      return count;
    });
    totalResolved += Number(resolvedForCall || 0);
  }
  return totalResolved;
}

async function isConfirmedNonReServiceBooking(conn, bookedServiceId, customerId) {
  if (!bookedServiceId || !customerId) return false;
  const visit = await conn('scheduled_services')
    .where({ id: bookedServiceId, customer_id: customerId })
    .first('id', 'status', 'is_callback');
  if (!visit) return false;
  if (visit.is_callback === true) return false;
  return !['pending', 'cancelled', 'skipped', 'no_show'].includes(String(visit.status || ''));
}

// Retire ONLY new-lead bells tied directly to the booked inquiry (`leadId` and
// sibling calls linked to that exact lead), never unrelated leads for other services.
async function retireBookedLeadBells(conn, { leadId, siblings, anchor, since }) {
  if (!leadId) return 0;
  const leadIdStr = String(leadId);
  const matchingCallSids = siblings
    .filter((s) => s.twilio_call_sid && String(s.lead_id || '') === leadIdStr)
    .map((s) => s.twilio_call_sid);

  const now = new Date();
  const count = await conn('notifications')
    .whereNull('done_at')
    .whereIn('category', ['lead', 'new_lead'])
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

function isVerifiedAddressValidation(av) {
  return Boolean(
    av && ['validated_accept', 'corrected'].includes(String(av.status || '')) && av.inServiceArea === true,
  );
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

function deriveReconciliationSignals(opts = {}) {
  const addressConflictHold = hasAddressConflictHold(opts);
  const av = opts.addressValidation;
  const validatedStreet = av?.normalized?.street_line_1 || opts.validatedStreet || null;
  return {
    callId: opts.callId || opts.call?.id || null,
    callCreatedAt: opts.callCreatedAt || opts.call?.created_at || null,
    customerId: opts.customerId || null,
    leadId: opts.leadId || null,
    bookedServiceId: opts.bookedServiceId || opts.appointmentResult?.scheduledServiceId || null,
    isTerminalNoise: isCallTerminalNoise(opts),
    addressConflictHold,
    addressVerified: opts.addressVerified === true || (isVerifiedAddressValidation(av) && !addressConflictHold),
    validatedStreetKey: normalizedStreetKey(validatedStreet),
  };
}

async function isSingleActivePropertyCustomer(conn, customerId) {
  try {
    const row = await conn('customer_properties')
      .where({ customer_id: customerId, active: true })
      .count('* as n')
      .first();
    const count = parseInt(row?.n, 10);
    // Fail closed if count is unreadable or > 1.
    return Number.isFinite(count) && count <= 1;
  } catch (err) {
    logger.warn(`[call-episode] active property count failed (preserving address cards): ${err.code || err.name || 'db_error'}`);
    return false;
  }
}

// Reconcile Call 1 open triage cards + stale new-lead bells tied to the booked lead
// when Call 2 verifies missing fields or books a confirmed non-re-service visit within 48h.
// Best-effort & non-throwing by contract.
async function reconcilePriorEpisodeOnCallCompletion(conn, opts = {}) {
  const empty = { cardsResolved: 0, bellsRetired: 0 };
  const sig = deriveReconciliationSignals(opts);
  if (!conn || !sig.callId || !sig.customerId || sig.isTerminalNoise) return empty;
  try {
    const anchor = anchorDate(sig.callCreatedAt);
    const since = windowStartFrom(anchor);
    const siblings = await findRecentEpisodeSiblingCalls(conn, {
      customerId: sig.customerId,
      currentCallId: sig.callId,
      anchorCreatedAt: anchor,
    });
    if (!siblings.length) return empty;

    const customer = await conn('customers')
      .where({ id: sig.customerId })
      .first('id', 'email', 'address_line1', 'zip', 'active');
    if (!customer || customer.active === false) return empty;

    const singleProperty = await isSingleActivePropertyCustomer(conn, sig.customerId);
    const customerStreetKey = normalizedStreetKey(customer.address_line1);
    const effectiveValidatedStreet = sig.validatedStreetKey && sig.validatedStreetKey === customerStreetKey
      ? sig.validatedStreetKey
      : null;

    const codes = buildReconcilableCardCodes({
      customer,
      singleProperty,
      addressVerified: sig.addressVerified,
      validatedStreetKey: effectiveValidatedStreet,
      hasAddressConflictHold: sig.addressConflictHold,
    });
    const priorCallIds = siblings.map((s) => s.id);
    const cardsResolved = await resolveOpenSiblingCards(
      conn,
      priorCallIds,
      sig.customerId,
      codes,
      sig.callId,
      effectiveValidatedStreet,
    );

    let bellsRetired = 0;
    if (sig.bookedServiceId && sig.leadId && !sig.addressConflictHold) {
      const confirmedNonCallback = await isConfirmedNonReServiceBooking(conn, sig.bookedServiceId, sig.customerId);
      if (confirmedNonCallback) {
        bellsRetired = await retireBookedLeadBells(conn, { leadId: sig.leadId, siblings, anchor, since });
      }
    }
    return { cardsResolved, bellsRetired };
  } catch (err) {
    logger.warn(`[call-episode] reconciliation failed for call ${sig.callId}: ${err.code || err.name || 'db_error'}`);
    return empty;
  }
}

// Pure predicate: is this inbound SMS submitting photos without explicitly asking for a quote?
function isPhotoSubmissionSms({ triggerBody = '', hasMedia = false } = {}) {
  const body = String(triggerBody || '').trim();
  if (EXPLICIT_QUOTE_ASK_RE.test(body)) return false;
  return Boolean(hasMedia) || PHOTO_SUBMISSION_RE.test(body);
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

// Suppress false "Quote asked by text" when a customer texts photos requested by
// staff on a recent call (<=48h) and does not explicitly ask for pricing in the text.
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

async function priorCallFirstTouchCandidate(conn, { digits, currentCallId, since, anchor, twilioNumbers }) {
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
  const priorCalls = await q.select('to_phone', 'created_at');
  for (const prior of priorCalls) {
    const cfg = twilioNumbers.findByNumber(prior.to_phone);
    if (!cfg) continue;
    const resolved = twilioNumbers.getLeadSourceFromNumber(prior.to_phone);
    if (resolved && !isGenericCallLeadSource(resolved.source)) {
      return {
        at: new Date(prior.created_at).getTime(),
        source: resolved.source,
        detail: resolved.detail || resolved.domain || cfg.domain || resolved.area || 'prior inbound call',
      };
    }
  }
  return null;
}

async function priorLeadFirstTouchCandidate(conn, { digits, since, anchor }) {
  const priorLead = await conn('leads')
    .join('lead_sources', 'leads.lead_source_id', 'lead_sources.id')
    .whereNull('leads.deleted_at')
    .whereRaw("right(regexp_replace(coalesce(leads.phone,''),'\\D','','g'),10) = ?", [digits])
    .where('leads.created_at', '>=', since)
    .where('leads.created_at', '<', anchor)
    .orderBy('leads.created_at', 'asc')
    .first('leads.created_at', 'lead_sources.source_type', 'lead_sources.name');
  if (!priorLead?.source_type) return null;
  const mapped = attributionForSourceType(priorLead.source_type)?.leadSource || priorLead.source_type;
  if (isGenericCallLeadSource(mapped)) return null;
  return {
    at: new Date(priorLead.created_at).getTime(),
    source: mapped,
    detail: priorLead.name || mapped,
  };
}

function shouldKeepCurrentLeadSource({ hasExplicitReferral, referredByName, isOutbound, fallback }) {
  if (hasExplicitReferral || Boolean(referredByName)) return true;
  return !isOutbound && !isGenericCallLeadSource(fallback.source);
}

// Preserve first-touch acquisition lead_source across repeat or outbound callback calls
// within 48h so Call 2 never overwrites Call 1's Google Ads / GBP / organic source with
// generic `phone_call` / `direct`. Fail-open to currentLeadSource on any error.
async function resolveFirstTouchCallLeadSource(conn, {
  contactPhone,
  currentCallId = null,
  currentCallCreatedAt = null,
  currentLeadSource = null,
  hasExplicitReferral = false,
  referredByName = '',
  isOutbound = false,
  twilioNumbers = null,
} = {}) {
  const fallback = currentLeadSource || { source: 'phone_call' };
  if (shouldKeepCurrentLeadSource({ hasExplicitReferral, referredByName, isOutbound, fallback })) return fallback;

  const digits = last10(contactPhone);
  if (digits.length < 10 || typeof conn !== 'function') return fallback;

  try {
    const anchor = anchorDate(currentCallCreatedAt);
    const since = windowStartFrom(anchor);
    const [callCand, leadCand] = await Promise.all([
      priorCallFirstTouchCandidate(conn, { digits, currentCallId, since, anchor, twilioNumbers }),
      priorLeadFirstTouchCandidate(conn, { digits, since, anchor }),
    ]);
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
  EPISODE_ADDRESS_CARD_CODES,
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
    buildReconcilableCardCodes,
    addressCardMatchesVerifiedStreet,
    deriveReconciliationSignals,
  },
};
