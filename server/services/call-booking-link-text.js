/**
 * Automatic "booking link" text after a call — owner-approved 2026-09-26.
 *
 * When a NEW lead calls (or is called back after they contacted us first)
 * wanting someone to come out, and the call ends with nothing booked, this
 * lane texts them the existing free-consultation booking link
 * (lead-consultation-link.js's /inspection/:token page) so they can pick a
 * time themselves instead of waiting on a callback. It reuses that link
 * builder and the canonical sendCustomerMessage pipeline verbatim — no new
 * SMS copy, no new sender, no new STOP/consent handling.
 *
 * Gate: GATE_CALL_BOOKING_LINK_TEXT (default off; off = byte-identical —
 * nothing is read or written by this module). Also requires
 * GATE_LEAD_INSPECTION_LINK live (buildLeadConsultationSmsLine's own gate) —
 * with that off, every dispatch attempt gets `link_disabled` and sends
 * nothing; this module does not duplicate that check.
 *
 * Timing (owner rule): never before 2 hours after the call ends — staff get
 * the first shot at a callback — and never texted by the delayed job outside
 * 8 AM–8 PM ET, so a call ending at/after 6 PM ET waits for 8 AM ET the next
 * morning instead of a 2-hour offset that would land after 8 PM.
 *
 * Mechanism (no new table): the decision and its timer both live on the
 * call's own `call_log.metadata.call_booking_link_text` — set once, at most,
 * per call:
 *   { status: 'skipped', reason, staged_at }                — never eligible
 *   { status: 'pending', lead_id, send_at, staged_at }       — waiting out the delay
 *   { status: 'sent', lead_id, send_at, sent_at, ... }        — texted
 *   { status: 'skipped', reason, send_at, dispatched_at }     — was pending, blocked at send time
 * A cron tick (scheduler.js, every 5 min, mirroring reschedule-link-promises)
 * calls sweep(): stage() evaluates newly-extracted calls once, dispatch()
 * claims and sends whatever is due. Every terminal send-time decision (sent
 * or skipped-at-dispatch) also gets an `activity_log` row so it shows up
 * without opening the call's raw metadata; the (much larger) volume of
 * ordinary stage-time "not eligible at all" calls does not — that population
 * is nearly every call the business takes, and logging all of them to
 * activity_log would just be noise next to the metadata already on the row.
 *
 * Every "never" condition is re-checked at dispatch time against fresh rows
 * (see dispatchClaimedCall / DISPATCH_CHECKS) — a call staged eligible two
 * hours ago is a DIFFERENT, and possibly no-longer-true, fact by the time
 * the delay is up.
 *
 * Known limitation: a provider outcome sms-auto-send.js classifies as
 * "ambiguous" (accepted by Twilio but not yet confirmed) leaves the row
 * 'claimed' rather than 'sent' or 'skipped' — deliberately, to avoid a
 * duplicate text — and, unlike reschedule-link-promises, this lane has no
 * admin review surface for that state; it is expected to be rare given the
 * volume (~1–2 sends/day) and is visible only by querying call_log directly.
 */

'use strict';

const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');
const { callStartedAt, callDurationSeconds } = require('../utils/call-timeline');
const { etParts } = require('../utils/datetime-et');
const { nextSendWindowOpenET, isWithinSendWindowET } = require('./messaging/send-window');
const { isOpenLeadRow } = require('./lead-statuses');
const { buildLeadConsultationSmsLine, isUsPhone } = require('./lead-consultation-link');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { isRealProviderSend, isAmbiguousProviderOutcome } = require('./sms-auto-send');

const GATE = 'callBookingLinkText';
const METADATA_KEY = 'call_booking_link_text';
const MESSAGE_TYPE = 'call_booking_link_text';

// Bounds how far back the staging pass looks for never-yet-evaluated calls —
// extraction normally lands within minutes, so a call still unevaluated
// after this long is not worth an indefinite retry.
const STAGING_LOOKBACK_DAYS = 3;
const STAGING_BATCH = 200;
const DISPATCH_BATCH = 50;

// v2_extraction_status flips to 'valid' before the call pipeline's own
// lead-creation/linkage step necessarily lands (codex pre-push P1): staging
// a call the INSTANT extraction is marked valid can catch it between those
// two writes and stamp a permanent 'no_lead_linkage' for a lead that exists
// moments later, with no retry (the metadata key itself is what stops a
// second look). Waiting this long after the row's own LAST WRITE
// (updated_at — see stage()'s query) before staging it at all is far
// cheaper than a retry/defer scheme, and costs nothing against the 2-hour
// minimum delay this lane already imposes.
const STAGING_GRACE_MINUTES = 15;

// A call that ends without at least this much talk time is a hang-up, a
// voicemail greeting, or a dropped call before the ask — never a "no visit
// was set" conversation to follow up on.
const MIN_CONVERSATION_SECONDS = 30;

// The one-hour follow-up pager (server/services/followup-sla-watcher.js)
// treats a promised callback the same way: this text SUPPLEMENTS it, never
// replaces it — nothing here cancels or reads a call_commitments row.

// caller.relationship_to_property values that mean the person on the phone
// is not the resident who would receive this text (owner rule: property
// manager, realtor, lender, or relative) — 'owner', 'tenant', and
// 'spouse_partner' are treated as the property's own household;
// 'unknown' (relationship never stated) is treated as ungrounded-but-not-a-
// third-party, since most residential callers never explicitly say "I own
// this house."
const THIRD_PARTY_RELATIONSHIPS = new Set([
  'property_manager', 'real_estate_agent', 'lender', 'hoa_board_member', 'employee', 'other',
]);

const RESIDENTIAL_PROPERTY_TYPES = new Set([
  'single_family', 'condo', 'townhouse', 'mobile_home', 'multi_family',
]);

// service_intent values that mean "wanted someone to come out" (look at a
// problem, an in-person quote, or a recurring plan) as opposed to a priced
// one-time job (preventative_one_time — goes through the estimate/Book
// button instead), a phone-only price ask (quote_only), or an
// existing-customer intent.
const WANTS_ONSITE_INTENTS = new Set([
  'active_infestation_treatment', 'inspection_only', 'recurring_membership_inquiry',
]);

// V2 triage_flags this lane must never send against — see
// server/schemas/call-extraction.persisted.schema.json for the full enum.
// Deliberately excludes flags this lane's own checks already cover from a
// more specific angle (e.g. cancellation_request is also an existing-
// customer/complaint shape) only where a second exclusion would be inert;
// every flag here is its own reason not to text.
const EXCLUDED_TRIAGE_FLAGS = new Set([
  'out_of_service_area', 'hoa_common_area_requires_approval', 'commercial_requires_quote',
  'caller_not_authorized', 'no_sms_consent_captured', 'do_not_contact_requested',
  'address_unverifiable', 'competing_quotes_active', 'spam_or_wrong_number',
  'cancellation_request', 'manual_review_requested', 'quote_promised',
]);

const NON_CONVERSATION_DISPOSITIONS = new Set([
  'voicemail_processed', 'spam_discarded', 'wrong_number_closed', 'vendor_logged',
]);

function parseMetadata(call) {
  try {
    const raw = call?.metadata;
    return (typeof raw === 'string' ? JSON.parse(raw) : raw) || {};
  } catch {
    return {};
  }
}

function leadIdOf(call) {
  const meta = parseMetadata(call);
  return meta?.lead_id || meta?.relay_lead_id || null;
}

// call-recording-processor.js's fresh-lead-insert path deliberately does
// NOT stamp metadata.lead_id for the most common "brand new lead" shape —
// a stamp-less, phone-bearing fresh insert self-links through its OWN
// leads.twilio_call_sid instead, and only a REUSED lead (whose sid already
// belongs to an earlier call) gets the metadata stamp, since a reused
// lead's sid can't be rolled onto this call (codex pre-push P1). leadIdOf
// alone would read no_lead_linkage for every such fresh lead; falling back
// to a SID lookup is required to ever resolve it.
async function resolveLeadId(conn, call) {
  const stamped = leadIdOf(call);
  if (stamped) return stamped;
  if (!call.twilio_call_sid) return null;
  const lead = await conn('leads').where({ twilio_call_sid: call.twilio_call_sid }).whereNull('deleted_at').first('id');
  return lead?.id || null;
}

// call_log.customer_id alone does NOT mean "an existing customer" (codex
// pre-push P1): the legacy call-created-customer path (call-recording-
// processor.js's "Create new customer" branch) mints a brand-new customers
// row for a first-time caller with a name and phone — no prior relationship
// at all — and stamps BOTH customer_id and this exact provenance marker,
// created_customer_id, on the SAME call in one transaction. A customer_id
// this call itself just created is a NEW lead who happens to already have
// a customer row in this legacy path, not someone "active" before the
// call; only a customer_id that predates this call (no matching marker) is
// the owner's "already an active customer" never-rule.
function customerPredatesThisCall(call) {
  if (!call.customer_id) return false;
  const createdId = parseMetadata(call).created_customer_id;
  return String(createdId || '') !== String(call.customer_id);
}

function extractionOf(call) {
  try {
    const raw = call?.ai_extraction_enriched;
    return (typeof raw === 'string' ? JSON.parse(raw) : raw) || null;
  } catch {
    return null;
  }
}

// jsonb-merge fragment for `.update({ metadata: ... })` — never clobbers a
// sibling metadata key another writer set on the same call_log row.
function metadataPatch(conn, value) {
  return conn.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ [METADATA_KEY]: value })]);
}

// "an outbound return call to someone who contacted us first" (owner rule)
// means the lead's OWN record already existed before THIS outbound call was
// placed — an earlier inbound contact created it. A cold outbound call that
// itself minted the lead (or one created after) is not a return call,
// whatever the transcript's content classifies as (codex pre-push P1: the
// V2 call_nature classifier judges the CONVERSATION, not who called whom
// first, so a cold outbound pitch a caller responds to warmly can still
// read as 'new_lead'). Shared by staging (its own lead fetch) and dispatch
// (reusing the lead row it already fetched for other checks) so the two
// never apply a different standard.
//
// Compares against callStartedAt(call), NOT call.created_at (codex pre-push
// P1): call-recording-processor.js's own leadFirstContactAt stamps a newly
// minted lead's first_contact_at from callStartedAt(call) too, and for a
// post-call fallback row (status callback / recording-status recovery —
// call-timeline.js's POST_CALL_ROW_SOURCES) created_at is stamped AFTER the
// call ends while callStartedAt backs the call's own length out of it.
// Comparing first_contact_at against the later created_at on such a row
// would read a lead THIS SAME call minted as having contacted us first.
function outboundPriorContactMissing(call, lead) {
  if (!String(call.direction || '').startsWith('outbound')) return false;
  const firstContact = lead?.first_contact_at || lead?.created_at;
  if (!firstContact) return true;
  const callAt = callStartedAt(call) || new Date(call.created_at);
  return new Date(firstContact).getTime() >= callAt.getTime();
}

async function outboundStagingReason(conn, call, leadId) {
  if (!String(call.direction || '').startsWith('outbound')) return null;
  const lead = leadId ? await conn('leads').where({ id: leadId }).first('first_contact_at', 'created_at') : null;
  return outboundPriorContactMissing(call, lead) ? 'outbound_without_prior_contact' : null;
}

// This lane deliberately does NOT use call-commitments.js's callEndedAt for
// the call's end. That function adds duration on top of created_at for
// EVERY inbound row, including a post-call one (a status-callback or
// recording-status recovery insert — call-timeline.js's
// POST_CALL_ROW_SOURCES) whose created_at is already stamped after the
// call ended — reading a call that really ended at 5:55 PM as ending at
// 6:05 PM. And for a plain outbound row with no bridged_at, it returns the
// bare created_at with no duration added at all — too EARLY, the opposite
// error. Both are wrong for the 2-hour / 6 PM-cutoff rule this lane runs
// on (codex pre-push rounds 8–9).
//
// callStartedAt(call) already backs a post-call row's own length out of
// created_at, so start + duration is correct uniformly: ring-time rows
// (created_at IS the start — start + duration is the ordinary end),
// post-call/recovered rows (callStartedAt already subtracted the
// duration — adding it back reaches the true end, not created_at's
// inflated one), and plain outbound rows (start + duration, never the
// bare start callEndedAt would return). The one row shape neither
// function derives from created_at at all is a bridged outbound-connect
// call, handled by its own branch below exactly as callEndedAt's is.
function callEndFor(call) {
  const durationMs = callDurationSeconds(call) * 1000;
  // Outbound-connect bridge: Twilio's duration runs from the answer;
  // created_at predates dialing.
  if (call?.bridged_at) {
    const bridged = new Date(call.bridged_at);
    if (!Number.isNaN(bridged.getTime())) return new Date(bridged.getTime() + durationMs);
  }
  // Every other row: callStartedAt already backs the length out of a
  // post-call (recovered / status-callback) row, so start + duration is
  // the end for ring-time rows, post-call rows, and plain outbound rows
  // alike (callEndedAt returns bare created_at for those, i.e. too early).
  const start = callStartedAt(call);
  return start ? new Date(start.getTime() + durationMs) : null;
}

// The 2-hour-after / 8am-ET-next-morning rule. A call ending at/after 6 PM
// ET (18:00) waits for the next ET calendar day's 8 AM open — the DST-safe
// noon-anchor nextSendWindowOpenET already computes exactly that for any
// instant at/after the window's own 8 AM boundary. A call ending before
// 6 PM sends 2 hours later, which by construction never lands at/after
// 8 PM ET (18:00 + 2h = 20:00, the window's own exclusive edge).
function computeSendAt(callEnd) {
  const { hour } = etParts(callEnd);
  if (hour >= 18) return nextSendWindowOpenET(callEnd);
  return new Date(callEnd.getTime() + 2 * 60 * 60 * 1000);
}

// Table-driven "never" rules (CLAUDE.md rule 20: table-drive repeated
// conditionals rather than one long if-chain). Each entry is independent and
// named by the reason it returns; order matches the owner's own rule list
// where one rule is a special case of an earlier, broader one (e.g. a
// priced-on-call price is checked only after service_intent already passed).
// Every check tolerates a null `extraction` (returns null itself) — the
// `no_extraction` entry above it in the list is what actually stops the walk.
const STAGING_CHECKS = [
  (call, extraction, leadId) => (!leadId ? 'no_lead_linkage' : null),
  (call) => (customerPredatesThisCall(call) ? 'existing_customer' : null),
  (call, extraction) => (!extraction ? 'no_extraction' : null),
  (call, extraction) => (extraction.meta?.is_voicemail || extraction.meta?.is_spam ? 'voicemail_or_spam' : null),
  (call, extraction) => (extraction.call_nature !== 'new_lead' ? 'not_new_lead_call' : null),
  (call) => ((Number(call.duration_seconds) || 0) < MIN_CONVERSATION_SECONDS ? 'call_too_short' : null),
  (call, extraction) => (NON_CONVERSATION_DISPOSITIONS.has(extraction.recommended_disposition) ? 'not_a_conversation' : null),
  (call, extraction) => {
    const flags = new Set(Array.isArray(extraction.triage_flags) ? extraction.triage_flags : []);
    for (const flag of EXCLUDED_TRIAGE_FLAGS) {
      if (flags.has(flag)) return `triage_flag_${flag}`;
    }
    return null;
  },
  (call, extraction) => {
    const relationship = extraction.caller?.relationship_to_property;
    return relationship && THIRD_PARTY_RELATIONSHIPS.has(relationship) ? 'third_party_caller' : null;
  },
  (call, extraction) => (!RESIDENTIAL_PROPERTY_TYPES.has(extraction.property?.property_type) ? 'not_residential' : null),
  (call) => (call.ai_address_validation?.inServiceArea !== true ? 'not_in_service_area' : null),
  (call, extraction) => (!WANTS_ONSITE_INTENTS.has(extraction.service_request?.service_intent) ? 'service_intent_not_onsite' : null),
  (call, extraction) => {
    const sr = extraction.service_request || {};
    const priced = sr.quoted_price_usd != null || sr.price?.amount_usd != null || (Array.isArray(sr.prices) && sr.prices.length > 0);
    return priced ? 'priced_on_call' : null;
  },
  (call, extraction) => (extraction.service_request?.urgency === 'no_appointment_needed' ? 'no_appointment_needed' : null),
  (call, extraction) => (extraction.scheduling?.status === 'confirmed' ? 'already_booked_on_call' : null),
  (call, extraction) => {
    const disposition = extraction.recommended_disposition;
    return (disposition === 'booked' || disposition === 'no_action_needed') ? `disposition_${disposition}` : null;
  },
  (call, extraction) => (extraction.consent?.do_not_contact_request === true ? 'do_not_contact' : null),
  (call, extraction) => (extraction.consent?.sms_consent_given === false ? 'sms_consent_refused' : null),
  (call, extraction) => (extraction.caller?.preferred_contact_method === 'phone' ? 'prefers_phone_contact' : null),
  (call, extraction) => {
    const leadQuality = extraction.sentiment_and_lead?.lead_quality;
    return ['wrong_number', 'spam_or_solicitation', 'out_of_service_area'].includes(leadQuality) ? `lead_quality_${leadQuality}` : null;
  },
];

/**
 * Stage-time eligibility — everything decidable from the call + its V2
 * extraction alone, at the moment extraction lands. Returns a skip reason
 * string, or null when eligible to schedule. Also reused verbatim at
 * dispatch time as one of the send-time re-checks (see DISPATCH_CHECKS).
 */
function stagingIneligibleReason(call, extraction, leadId) {
  for (const check of STAGING_CHECKS) {
    const reason = check(call, extraction, leadId);
    if (reason) return reason;
  }
  return null;
}

/**
 * Evaluates and stamps every V2-extracted call this lane has not yet looked
 * at (bounded lookback). Never re-evaluates a call twice — the metadata key
 * itself is the "already decided" marker, so a permanently-skipped call is
 * never rescanned.
 */
async function stage(conn = db, { now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - STAGING_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const readyBy = new Date(now.getTime() - STAGING_GRACE_MINUTES * 60 * 1000);
  const calls = await conn('call_log')
    .where('v2_extraction_status', 'valid')
    .where('created_at', '>=', cutoff)
    // The processor's own ownership fence (reschedule-link-promises.js's
    // identical call_not_ready check) — never judge a row still being
    // written. And the grace window anchors on `updated_at`, not
    // `created_at` (codex pre-push P1): created_at is fixed at ring time,
    // so for a long call or delayed extraction it can already be well past
    // the grace window the MOMENT v2_extraction_status flips valid, while a
    // separate lead-linkage write still lands after. `updated_at` moves with
    // every write to the row, including that one, so the grace period keeps
    // re-arming until the row has genuinely gone quiet.
    .whereNull('processing_token')
    .where('updated_at', '<=', readyBy)
    .whereRaw("metadata->:key IS NULL", { key: METADATA_KEY })
    .orderBy('created_at', 'asc')
    .limit(STAGING_BATCH)
    .select('id', 'customer_id', 'direction', 'bridged_at', 'duration_seconds', 'recording_duration_seconds', 'created_at', 'metadata', 'twilio_call_sid', 'ai_extraction_enriched', 'ai_address_validation');
  let staged = 0;
  let ineligible = 0;
  for (const call of calls) {
    try {
      const decided = await stageOne(conn, call, now);
      if (decided === 'pending') staged += 1; else ineligible += 1;
    } catch (err) {
      logger.warn(`[call-booking-link-text] stage failed for call ${call.id} (${err.code || err.name || 'error'})`);
    }
  }
  // NOTE: this return object is also what the scheduler.js cron wiring
  // receives as `result` from runExclusive — deliberately no field named
  // `skipped` anywhere in this module's sweep()/stage() return shape, since
  // the scheduler's `result?.skipped` check means "runExclusive could not
  // get a lock/connection for this tick," not "this lane skipped a call."
  return { staged, ineligible };
}

async function stageOne(conn, call, now) {
  const leadId = await resolveLeadId(conn, call);
  const extraction = extractionOf(call);
  const reason = stagingIneligibleReason(call, extraction, leadId) || (await outboundStagingReason(conn, call, leadId));
  const staged_at = now.toISOString();
  if (reason) {
    await claimMetadata(conn, call.id, { status: 'skipped', reason, staged_at });
    return 'skipped';
  }
  const callEnd = callEndFor(call);
  if (!callEnd) {
    await claimMetadata(conn, call.id, { status: 'skipped', reason: 'no_call_end_time', staged_at });
    return 'skipped';
  }
  // Clamp to `now` (codex pre-push P1): a skewed duration_seconds could
  // still, in principle, push callEndFor() past the actual present —
  // computeSendAt on an unclamped future end could then push send_at
  // arbitrarily late. Clamping bounds the damage to "delayed by at most
  // the skew," never "delayed indefinitely."
  const clampedEnd = callEnd.getTime() > now.getTime() ? now : callEnd;
  const send_at = computeSendAt(clampedEnd).toISOString();
  await claimMetadata(conn, call.id, { status: 'pending', lead_id: leadId, send_at, staged_at });
  return 'pending';
}

// Only the FIRST writer for a given call may set this key — a concurrent
// stage tick (unlikely under the cron's single-instance lock, but cheap to
// guard) loses instead of overwriting a decision another tick already made.
async function claimMetadata(conn, callId, value) {
  await conn('call_log').where({ id: callId }).whereRaw("metadata->:key IS NULL", { key: METADATA_KEY })
    .update({ metadata: metadataPatch(conn, value), updated_at: new Date() });
}

// Atomically moves exactly one 'pending' row to 'claimed' — the same
// single-row, single-statement claim tech-line.js / outbound-voicemail-sms.js
// use, sized for this lane's one-resource shape (no cross-table lock order
// to join: this touches only call_log, plus the ordinary reads/writes the
// canonical send path already owns).
async function claimForDispatch(conn, callId) {
  const claimed_at = new Date().toISOString();
  const result = await conn.raw(
    `UPDATE call_log SET metadata = COALESCE(metadata, '{}'::jsonb) ||
       jsonb_build_object(:key, (metadata->:key) || jsonb_build_object('status', 'claimed', 'claimed_at', :claimed_at::text))
     WHERE id = :id AND metadata->:key->>'status' = 'pending'
     RETURNING id`,
    { key: METADATA_KEY, claimed_at, id: callId },
  );
  return (result?.rows || []).length > 0;
}

async function recordDecision(conn, call, entry, { logActivity = true } = {}) {
  await conn('call_log').where({ id: call.id }).update({ metadata: metadataPatch(conn, entry), updated_at: new Date() });
  if (!logActivity) return;
  const sent = entry.status === 'sent';
  await conn('activity_log').insert({
    customer_id: null,
    action: sent ? 'call_booking_link_text_sent' : 'call_booking_link_text_skipped',
    description: sent ? 'Automatic booking link text sent after a call that ended without a visit.'
      : `Automatic booking link text skipped: ${entry.reason}.`,
    metadata: { call_log_id: call.id, lead_id: entry.lead_id || null, reason: entry.reason || null,
      send_at: entry.send_at || null, provider_message_id: entry.provider_message_id || null },
  }).catch((err) => logger.warn(`[call-booking-link-text] activity_log write failed for call ${call.id} (${err.code || err.name || 'error'})`));
}

// A booking landing for this lead's own customer record, any time at or
// after the call STARTED — the owner's rule is "no visit was set on the
// call, and nothing got booked after it," and the call's own duration is
// squarely "on the call." `since` must be callStartedAt(call), never
// callEndedAt() (codex pre-push P1): callEndedAt can read a FUTURE instant
// for a post-call fallback row, and a too-late lower bound could miss a
// booking made in the gap between the real end and that bogus future one —
// sending a link to someone who already booked, which is worse than a
// delayed or missed send. The dispatch-time call site is by construction
// always at least 2 hours after the call (see computeSendAt), satisfying
// the owner's 2-hour staff-first window as a side effect of the schedule
// itself regardless of which instant this lower bound anchors on.
async function bookedSinceCall(conn, customerId, since) {
  if (!customerId) return false;
  const row = await conn('scheduled_services').where({ customer_id: customerId })
    .where('created_at', '>=', since).whereNotIn('status', ['cancelled']).first('id');
  return !!row;
}

// A short_codes row only proves a consultation link was MINTED — not sent.
// Virginia's manual composer (admin-leads.js POST /:id/consultation-link)
// mints one to prefill the composer and the operator can close it without
// ever clicking Send; the estimate-email consultation offer mints its own
// for an EMAIL, which never appears in sms_log at all (codex pre-push P1).
// Requiring the code to actually appear in an accepted outbound SMS is the
// same evidence-not-intent standard reschedule-link-promises' matchingSend
// applies to its own visit links.
async function linkSentRecently(conn, leadId, now) {
  const since = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const codes = await conn('short_codes').where({ kind: 'consultation', entity_type: 'leads', entity_id: leadId })
    .where('created_at', '>=', since).orderBy('created_at', 'desc').limit(20).pluck('code');
  if (!codes.length) return false;
  const row = await conn('sms_log').where('direction', 'outbound').where('created_at', '>=', since)
    .whereIn('status', ['queued', 'accepted', 'sending', 'sent', 'delivered', 'read'])
    .where((q) => { for (const code of codes) q.orWhere('message_body', 'like', `%/l/${code}%`); })
    .first('id');
  return !!row;
}

// Table-driven send-time re-check (mirrors STAGING_CHECKS above — CLAUDE.md
// rule 20). Order matters: `lead` is guaranteed non-null once past its own
// entry, and the later entries lean on that. `estimate_linked` is this
// lane's version of "an estimate created or sent for them since the call is
// also a skip" — a priced job routes through the estimate's own Book button
// regardless of when the link got attached.
const DISPATCH_CHECKS = [
  ({ lead }) => (!lead ? 'lead_not_found' : null),
  ({ lead }) => (!isOpenLeadRow(lead) ? 'lead_no_longer_open' : null),
  ({ lead }) => (lead.estimate_id ? 'estimate_linked' : null),
  ({ lead }) => (lead.is_commercial === true ? 'commercial_lead' : null),
  ({ lead }) => (!lead.phone || !isUsPhone(lead.phone) ? 'lead_phone_unusable' : null),
  ({ call, lead }) => (outboundPriorContactMissing(call, lead) ? 'outbound_without_prior_contact' : null),
  async ({ conn, call, lead }) => {
    const callStart = callStartedAt(call) || new Date(call.created_at);
    return (await bookedSinceCall(conn, lead.customer_id, callStart)) ? 'booked_since_call' : null;
  },
  async ({ conn, leadId, now }) => ((await linkSentRecently(conn, leadId, now)) ? 'link_sent_recently' : null),
  // Re-run the full stage-time predicate against the row as it stands now —
  // covers a re-extraction, a status edit, or anything else that changed
  // this call's own facts between staging and dispatch.
  ({ call, leadId }) => stagingIneligibleReason(call, extractionOf(call), leadId),
  // Deliberately NOT an "outside the send window" check here — that is a
  // reason to WAIT, never a reason to give up (codex pre-push P1: a 5:59 PM
  // call is due at 7:59 PM, and a cron tick running even a few minutes late
  // must not permanently lose it). See the reschedule branch in
  // dispatchClaimedCall, which runs before any of these checks.
];

// The FIRST check (lead_not_found) always returns a reason when `lead` is
// falsy, so the loop returns before any later check ever dereferences it —
// every check past that point may safely assume `lead` is a real row.
async function dispatchIneligibleReason(ctx) {
  for (const check of DISPATCH_CHECKS) {
    const reason = await check(ctx);
    if (reason) return reason;
  }
  return null;
}

/**
 * Send-time re-check + dispatch for ONE already-claimed call. Re-derives
 * every "never" condition from fresh rows — nothing here trusts the
 * decision stage() made when it staged this call.
 */
async function dispatchClaimedCall(conn, call, now) {
  const entry = parseMetadata(call)[METADATA_KEY] || {};
  const leadId = entry.lead_id;
  const skip = async (reason) => {
    await recordDecision(conn, call, { status: 'skipped', reason, lead_id: leadId, send_at: entry.send_at });
    return { sent: false, skipped: reason };
  };
  if (!leadId) return skip('no_lead_linkage');
  // The call processor can rewrite call_log.metadata.lead_id later (an
  // attribution correction, a merge into a different lead) while leaving
  // THIS lane's own metadata key untouched (codex pre-push P1) — trusting
  // the staged id would then text whoever the call is linked to NOW, not
  // the lead this send was ever evaluated for. Skip rather than silently
  // restage under the new id; a changed linkage is rare enough that losing
  // the send is the safe direction. resolveLeadId (not the pure leadIdOf)
  // is the correct re-check here too — a fresh, stamp-less lead resolved
  // only through its own twilio_call_sid must not read as "changed" just
  // because it never carried a metadata stamp in the first place.
  if ((await resolveLeadId(conn, call)) !== leadId) return skip('lead_linkage_changed');
  // Outside the 8 AM–8 PM ET window is a reason to WAIT, never a reason to
  // give up (codex pre-push P1) — a call due at 7:59 PM must not be lost
  // just because the 5-minute cron's next tick lands a moment after 8 PM.
  // Re-queue as 'pending' at the next window open rather than terminally
  // skipping; no activity_log row — this is not a decision, just a wait.
  if (!isWithinSendWindowET(now)) {
    const send_at = nextSendWindowOpenET(now).toISOString();
    await recordDecision(conn, call, { status: 'pending', lead_id: leadId, send_at }, { logActivity: false });
    return { sent: false, skipped: 'outside_send_window', deferred: true };
  }
  const lead = await conn('leads').where({ id: leadId }).whereNull('deleted_at').first();
  const reason = await dispatchIneligibleReason({ conn, call, lead, leadId, now });
  if (reason) return skip(reason);

  const built = await buildLeadConsultationSmsLine(lead.id, lead.first_name);
  if (!built.url) return skip(built.reason ? `link_unavailable:${built.reason}` : 'link_unavailable');

  const result = await sendCustomerMessage({
    to: lead.phone,
    body: built.line,
    channel: 'sms',
    audience: 'lead',
    purpose: 'missed_call_followup',
    leadId: lead.id,
    identityTrustLevel: 'phone_provided_unverified',
    consentBasis: { status: 'transactional_allowed', source: 'call_booking_link_text' },
    entryPoint: 'call_booking_link_text',
    metadata: { original_message_type: MESSAGE_TYPE, call_log_id: call.id, lead_id: lead.id },
  }).catch((err) => (isRealProviderSend(err?.providerOutcome) || isAmbiguousProviderOutcome(err?.providerOutcome)) ? err.providerOutcome : Promise.reject(err));

  if (result.sent && isRealProviderSend(result)) {
    await recordDecision(conn, call, {
      status: 'sent', lead_id: lead.id, send_at: entry.send_at, sent_at: now.toISOString(), provider_message_id: result.providerMessageId,
    });
    return { sent: true, providerMessageId: result.providerMessageId };
  }
  if (isAmbiguousProviderOutcome(result)) {
    // Leave the row 'claimed' — a definitive outcome is not known yet and a
    // second claim attempt would risk a duplicate text. This mirrors the
    // reschedule-link-promises lane's own delivery-uncertain handling; a
    // human can always resolve it by hand if it never settles.
    logger.warn(`[call-booking-link-text] ambiguous provider outcome for call ${call.id} — leaving claimed`);
    return { sent: false, skipped: 'ambiguous_provider_outcome', ambiguous: true };
  }
  const blockedReason = result.blocked ? (result.code || result.reason || 'policy_block') : (result.code || result.reason || 'provider_failed');
  return skip(blockedReason);
}

async function sweep(conn = db, { now = new Date() } = {}) {
  if (!isEnabled(GATE)) return { staged: 0, ineligible: 0, sent: 0, dispatchSkipped: 0 };
  const { staged, ineligible } = await stage(conn, { now });
  const due = await conn('call_log')
    .whereRaw("metadata->:key->>'status' = 'pending'", { key: METADATA_KEY })
    .whereRaw("(metadata->:key->>'send_at')::timestamptz <= :now", { key: METADATA_KEY, now })
    .orderBy('created_at', 'asc').limit(DISPATCH_BATCH).select('id');
  let sent = 0;
  let dispatchSkipped = 0;
  for (const row of due) {
    try {
      const claimed = await claimForDispatch(conn, row.id);
      if (!claimed) continue;
      const call = await conn('call_log').where({ id: row.id }).first();
      const result = await dispatchClaimedCall(conn, call, now);
      if (result.sent) sent += 1; else if (!result.ambiguous && !result.deferred) dispatchSkipped += 1;
    } catch (err) {
      logger.warn(`[call-booking-link-text] dispatch failed for call ${row.id} (${err.code || err.name || 'error'})`);
      // A row left 'claimed' after a genuine failure would never be
      // revisited (the dispatch query only selects 'pending') and would
      // never surface a reason either. Park it terminal instead — matching
      // reschedule-link-promises' own worker_error fallback — so it shows
      // up once, with a reason, rather than vanishing silently.
      await conn('call_log').where({ id: row.id }).update({
        metadata: metadataPatch(conn, { status: 'skipped', reason: 'worker_error' }), updated_at: new Date(),
      }).catch(() => {});
      dispatchSkipped += 1;
    }
  }
  return { staged, ineligible, sent, dispatchSkipped };
}

module.exports = {
  GATE,
  METADATA_KEY,
  MESSAGE_TYPE,
  STAGING_LOOKBACK_DAYS,
  STAGING_GRACE_MINUTES,
  MIN_CONVERSATION_SECONDS,
  computeSendAt,
  callEndFor,
  stagingIneligibleReason,
  outboundPriorContactMissing,
  outboundStagingReason,
  resolveLeadId,
  stage,
  stageOne,
  claimForDispatch,
  dispatchClaimedCall,
  sweep,
  _private: { leadIdOf, extractionOf, parseMetadata, bookedSinceCall, linkSentRecently },
};
