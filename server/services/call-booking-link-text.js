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
 * morning instead of a 2-hour offset that would land after 8 PM. Also never
 * more than an hour LATE: staging skips a call outright (`stale_at_staging`,
 * terminal — see STAGING_STALE_MS) when its computed send_at is already
 * more than an hour in the past at the moment staging looks at it — an
 * off->on gate re-enable, long worker downtime, or a genuine processing
 * backlog is never a reason to burst-text a pile of hours-stale follow-ups
 * the instant staging catches up. This cap applies only at staging; a call
 * already staged and deferred at dispatch time keeps its own send_at and
 * the separate 24h original_send_at bound.
 *
 * Mechanism (no new table): the decision and its timer both live on the
 * call's own `call_log.metadata.call_booking_link_text` — set once, at most,
 * per call:
 *   { status: 'skipped', reason, staged_at }                — never eligible
 *   { status: 'pending', lead_id, send_at, original_send_at, staged_at } — waiting out the delay
 *     (original_send_at is set once at staging and never rewritten by a
 *     later retry deferral, which only ever advances send_at itself — the
 *     fixed anchor a retry's own 24h give-up measures against)
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
const markerDb = require('../models/marker-db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');
const { callStartedAt, callDurationSeconds } = require('../utils/call-timeline');
const { etParts } = require('../utils/datetime-et');
const { nextSendWindowOpenET, isWithinSendWindowET } = require('./messaging/send-window');
const { isOpenLeadRow } = require('./lead-statuses');
const { buildLeadConsultationSmsLine, isUsPhone } = require('./lead-consultation-link');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { isRealProviderSend, isAmbiguousProviderOutcome } = require('./sms-auto-send');
const { excludeUnresolvedSendReservations } = require('./messaging/review-ask-reservation');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { phoneIdentityKey } = require('../utils/phone');
const { lockSmsPhone } = require('../utils/customer-comms-lock');
const {
  computeDeterministicTriageFlags, mergeTriageFlags, suppressAddressFlagsForAV,
  suppressUnsupportedModelFlags, BLOCKING_TRIAGE_FLAGS,
} = require('./call-triage-flags');

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
// How far in the past the computed send_at may already be at the MOMENT OF
// STAGING before this call is skipped outright rather than queued (codex
// r6 P2 — this cap replaces an activation-boundary self-heal mechanism this
// lane tried and removed: a heartbeat-based "was the gate off" inference
// cannot tell a genuine disabled interval apart from ordinary worker/deploy
// downtime, and drew findings two rounds running). Whatever caused the
// gap — a gate re-enabled after being off, long worker downtime, or a
// genuine processing backlog — staging every previously-unstaged call the
// instant it catches up would burst-text a pile of stale follow-ups; this
// caps the damage at the one rule that actually matters to the owner: a
// booking-link text is never sent more than an hour after its OWN
// scheduled time. Applies ONLY at staging (stageOne, below) — a call
// ALREADY staged and deferred at dispatch time (outside the send window, a
// retryable send outcome) keeps its own advancing send_at and the
// SEPARATE, unrelated 24h original_send_at bound (NOT_READY_GIVE_UP_MS)
// that governs a stalled DISPATCH, never this staging-time cap.
const STAGING_STALE_MS = 60 * 60 * 1000;
// How long past its send time a staged call may stay mid-reprocess before
// the send gives up (see dispatchClaimedCall's readiness fence). Shared
// with the retryable-send bound below — both measure "how stale can this
// staged call get before we stop trying," from the SAME anchor
// (entry.send_at), just for two different reasons a send hasn't landed yet.
const NOT_READY_GIVE_UP_MS = 24 * 60 * 60 * 1000;
// When sendCustomerMessage reports a retryable/deferred outcome with no
// explicit nextAllowedAt (e.g. a transient provider failure), how soon the
// next sweep tries again — short, since the 5-minute cron will pick it up
// on one of its next several ticks either way.
const RETRY_BACKOFF_MS = 30 * 60 * 1000;
// Bounds sweep()'s own due-row query and recoverStaleClaims' own SELECT
// (codex #5018 r10 P2): both scan call_log through a metadata->>'status'
// JSON expression with no index of its own, so without a created_at bound
// each scan grows with the table's ENTIRE history rather than just this
// lane's own live rows. Rather than adding a migration for a JSON-path
// index, both bound created_at instead — indexed since this lane's own
// earliest migration (server/models/migrations/20260401000039_ai_assistant.js:
// `t.index('created_at')`), so the scan itself stays small as history
// grows. The bound is the maximum lifetime a row can LEGITIMATELY still be
// 'pending' or 'claimed': STAGING_LOOKBACK_DAYS (staging never considers
// an older call in the first place) + NOT_READY_GIVE_UP_MS (a 'pending'
// row this far past its own ORIGINAL send_at is given up on by
// sendReadiness/pastRetryDeadline; a 'claimed' row is moved out of
// 'claimed' well inside this window, via STALE_CLAIM_MS) + a one-day
// margin for the ordinary 2h/8am-ET initial delay and cron-tick
// granularity. A row moved to 'ambiguous' status (recoverAbandonedClaim)
// is invisible to EITHER query's own status filter regardless of
// created_at, so this bound never risks skipping one that still needs
// examining — only a genuinely stuck 'pending'/'claimed' row, which by
// construction cannot legitimately be this old, would ever fall outside
// it.
const QUEUE_SCAN_LOOKBACK_MS = (STAGING_LOOKBACK_DAYS * 24 * 60 * 60 * 1000) + NOT_READY_GIVE_UP_MS + (24 * 60 * 60 * 1000);

// Mirrors reschedule-link-promises.js's activationBoundary pattern: the
// first live sweep anywhere fixes an instant in system_settings (or an
// explicit env override wins), and staging only ever considers calls that
// started at or after it — so flipping the gate on never picks up days of
// pre-existing valid-but-unstaged calls and texts them all in one burst
// (codex r1 P1). Own key/env, since this is a different gate/lane.
const ACTIVATION_SETTINGS_KEY = 'call_booking_link_text_activated_at';
// See persistedActivationBoundary's own doc comment for why this is
// captured HERE, at module load, rather than read fresh later.
const MODULE_LOAD_AT = new Date();

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
//
// 'home_buyer' (schema 1.15.0, codex #5006 P1): a buyer under contract, not
// the owner yet. The owner ruling that authorized this relationship
// (call-agent rulebook, "WDO buyers") scopes it narrowly — a buyer ordering
// their OWN WDO inspection with a CONFIRMED time agreed on the call — and
// this lane already never reaches a call with a confirmed booking
// (STAGING_CHECKS' own already_booked_on_call / disposition_booked
// entries below fire first for that exact shape). Any home_buyer call that
// reaches THIS check is therefore never the WDO-buyer case the owner
// authorized — send-the-buyer-a-booking-link would text a free-consultation
// link to someone who does not yet own the property, which the ruling
// never covers. Fails closed, same as the property_manager/lender group.
const THIRD_PARTY_RELATIONSHIPS = new Set([
  'property_manager', 'real_estate_agent', 'lender', 'hoa_board_member', 'employee', 'other', 'home_buyer',
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
  'callback_number_needed',
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
//
// leads.twilio_call_sid carries no unique index (admin-estimate-
// persistence.js's own revalidation query names the same gap) — checked
// for an existing ambiguity-aware resolver first; that one deliberately
// picks the newest row for a DIFFERENT purpose (revalidating a linkage
// that already exists). Minting a fresh send to the WRONG lead is the
// worse failure mode here, so this fails CLOSED instead (codex r1 P1):
// two or more live rows sharing a sid resolve to no lead at all, not an
// arbitrary pick.
async function resolveLeadLinkage(conn, call) {
  const stamped = leadIdOf(call);
  if (stamped) return { leadId: stamped, ambiguous: false };
  if (!call.twilio_call_sid) return { leadId: null, ambiguous: false };
  const rows = await conn('leads').where({ twilio_call_sid: call.twilio_call_sid }).whereNull('deleted_at').limit(2).select('id');
  if (rows.length > 1) return { leadId: null, ambiguous: true };
  return { leadId: rows[0]?.id || null, ambiguous: false };
}

async function resolveLeadId(conn, call) {
  return (await resolveLeadLinkage(conn, call)).leadId;
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

// The dispatch-time twin of customerPredatesThisCall, for the LEAD's own
// customer_id rather than the call's (codex #5018 r10 P2): a lead can be
// open (no customer_id) at STAGING time and get linked to an existing
// customer afterward — a manual merge in the admin Leads page, a different
// call resolving the same person, or this same call's own later
// reprocessing pass — before DISPATCH ever runs. The owner's never-rule is
// "not an existing customer," and that is now true of this lead regardless
// of what it looked like when staged; trusting the staged decision here
// would text a free-consultation link to someone who has since become a
// real customer. Same created_customer_id exception as
// customerPredatesThisCall: a lead linked to the customer THIS call's own
// legacy call-created-customer path just minted is a new lead who happens
// to already have a customer row, not someone "already active."
function leadLinkedToExistingCustomer(call, lead) {
  if (!lead?.customer_id) return false;
  const createdId = parseMetadata(call).created_customer_id;
  return String(createdId || '') !== String(lead.customer_id);
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
// means GENUINE prior contact, not merely a lead record that happens to
// predate this call. This lane used to compare the lead's own
// first_contact_at against the call — replaced (codex #5012 P1) by the
// canonical, shared probe every other outbound-return-message lane already
// uses: hasPriorContact (outbound-call-reason.js) checks an actual
// customer relationship, a real prior inbound CALL, a real prior inbound
// TEXT, or any lead record at all with a matching phone before `before` —
// unbounded, not the 48h lookback resolveOutboundCallReason's own reason
// classifier uses for a different question. Reused verbatim rather than
// reimplemented (CLAUDE.md rule 15).
//
// customerId reuses outboundPriorContactCustomerId (call-recording-
// processor.js) — the ALREADY-FIXED canonical resolver, never
// customerPredatesThisCall (codex #5012 r2 P1: that helper only excludes a
// customer THIS call's own legacy path minted; it has no comparison
// against the customer ROW'S OWN created_at at all, so a customer linked to
// this call but actually created concurrently with or after it — a web-form
// signup, a different reprocess, an unrelated later signup on the same
// number — would still short-circuit hasPriorContact's own customerId
// branch to an automatic true, exactly the TCPA-implied-consent gap
// outboundPriorContactCustomerId's own predatesCall() exists to close for
// every OTHER caller of this same probe). A live (deleted_at IS NULL)
// lookup of the linked customer's created_at is required to apply that
// same timing check here — customerPredatesThisCall itself is still
// correct and unchanged for its OWN, different purpose (the owner's
// existing-customer never-rule in STAGING_CHECKS, which does not carry a
// prior-CONTACT timing claim the way this outbound check does).
//
// phone is the call's own contact number (resolveCallContactPhone(call,
// null), no extracted-phone override) — the exact number this call
// actually used, never a dictated callback the caller has not necessarily
// always held. before is callStartedAt(call), NOT call.created_at (codex
// pre-push P1, preserved from the original check): a post-call fallback
// row (status callback / recording-status recovery — call-timeline.js's
// POST_CALL_ROW_SOURCES) stamps created_at AFTER the call ends, while
// callStartedAt backs the call's own length out of it — comparing against
// the later created_at would read evidence recorded DURING this same call
// as having preceded it.
async function outboundPriorContactMissing(conn, call) {
  if (!String(call?.direction || '').startsWith('outbound')) return false;
  const { hasPriorContact } = require('./outbound-call-reason');
  const { resolveCallContactPhone, outboundPriorContactCustomerId } = require('./call-recording-processor');
  const before = callStartedAt(call) || new Date(call.created_at);
  const callCustomerCreatedAt = call.customer_id
    ? (await conn('customers').where({ id: call.customer_id }).whereNull('deleted_at').first('created_at').catch(() => null))?.created_at || null
    : null;
  const has = await hasPriorContact({
    customerId: outboundPriorContactCustomerId({ call, callMeta: parseMetadata(call), callCustomerCreatedAt, before }),
    phone: resolveCallContactPhone(call, null),
    before,
  });
  return !has;
}

async function outboundStagingReason(conn, call) {
  return (await outboundPriorContactMissing(conn, call)) ? 'outbound_without_prior_contact' : null;
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
// bare start callEndedAt would return). The two row shapes neither
// function derives from created_at at all are a bridged outbound-connect
// call and a callback attempt with its own signed customer-leg receipt,
// both handled by their own branches below.
function callEndFor(call) {
  // The exact customer-leg end, when it exists (codex r3 P2 — replaces the
  // two estimation branches this round's earlier fixes kept swapping
  // between, neither of which was ever exact): /outbound-dial-complete
  // (twilio-voice-webhook.js) stamps metadata.customer_leg = { status,
  // sid, duration_seconds, ended_at } the instant Twilio's own
  // DialCallStatus lands for the CUSTOMER leg itself, for a callback
  // attempt placed through /outbound-connect (a relatedCallId/
  // relatedCommitmentId bridge — exactly how a return call THIS lane cares
  // about is placed). No estimation needed once this is on the row.
  const customerLegEndedAt = parseMetadata(call)?.customer_leg?.ended_at;
  if (String(call?.direction || '').startsWith('outbound') && customerLegEndedAt) {
    const ended = new Date(customerLegEndedAt);
    if (!Number.isNaN(ended.getTime())) return ended;
  }
  // Outbound-connect bridge with no customer-leg receipt yet (an older row,
  // or the dial-complete write hasn't landed): bridged_at is stamped the
  // instant the admin presses 1 — BEFORE the customer's own leg even
  // starts ringing — and duration_seconds is the PARENT (admin) leg's
  // total length, which starts at the admin's OWN answer, earlier still.
  // bridged_at + duration_seconds can therefore only run LATE, by however
  // long the press-1 prompt and the customer's own ring time took — never
  // early (codex r1 P2 established the late direction; the recording-
  // duration branch this replaced (codex r2 P2) ran EARLY instead, since
  // Twilio's recorded duration measures only the customer's talk time and
  // misses hold/silence on the line — codex r3 P2). Erring late here is
  // the deliberately SAFE direction for this lane's own 2-hour-delay /
  // 6pm-ET-cutoff rule: a text computed a few seconds later than the true
  // end is harmless, while an early reading could place the computed
  // send_at inside the owner's 2-hour staff-first window, or read a call
  // that actually ended at/after 6 PM ET as ending just before it — sending
  // at 8 PM instead of waiting for 8 AM the next morning.
  if (call?.bridged_at) {
    const bridged = new Date(call.bridged_at);
    if (!Number.isNaN(bridged.getTime())) {
      const duration = Number(call?.duration_seconds);
      const durationSeconds = Number.isFinite(duration) && duration > 0 ? duration : 0;
      return new Date(bridged.getTime() + durationSeconds * 1000);
    }
  }
  // Every other row: callStartedAt already backs the length out of a
  // post-call (recovered / status-callback) row, so start + duration is
  // the end for ring-time rows, post-call rows, and plain outbound rows
  // alike (callEndedAt returns bare created_at for those, i.e. too early).
  const durationMs = callDurationSeconds(call) * 1000;
  const start = callStartedAt(call);
  return start ? new Date(start.getTime() + durationMs) : null;
}

// How much of this call was actual TALK time, for the call_too_short
// screen only (codex r1 P1) — never used for callEndFor/computeSendAt,
// which need the call's wall-clock length, not just the customer's speaking
// time. For an outbound call (a bridge especially), duration_seconds runs
// from Twilio's Dial/bridge start and includes staff ringing and the
// press-1 prompt before the customer ever picks up, while
// recording_duration_seconds — present once the recording itself is
// processed — measures only the recorded (customer) conversation. Inbound
// calls have no such staff-ringing prefix, so they stay on the ordinary
// callDurationSeconds (which itself already prefers recording_duration_
// seconds over a missing/zero duration_seconds).
function conversationSeconds(call) {
  if (String(call.direction || '').startsWith('outbound')) {
    const recorded = Number(call?.recording_duration_seconds);
    if (Number.isFinite(recorded) && recorded > 0) return recorded;
  }
  return callDurationSeconds(call);
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

// The Waves-owned line THIS call actually used, so the automated text rides
// the SAME line the caller reached instead of deriveOutboundNumber's
// location-based fallback (a Bradenton default when no fromNumber/
// customerId narrows it — codex r1 P2). Mirrors outbound-voicemail-sms.js's
// own replyFromNumber and dropped-call-sms.js's existing 8/20 fence in
// spirit: reuse the line the customer already saw. Validated against the
// registry — never a tech line (owner ruling: automated texts stay on the
// location lines), a staff-forward/CSR cell, or the AI toll-free line. A
// lead-webhook auto-bridge's own from_phone/to_phone are the INTERNAL alert
// leg to staff (Adam's cell), never the customer-facing line — the line
// that actually rings the lead rides metadata.bridgeCallerId instead
// (server/routes/lead-webhook.js), checked first for that reason. No valid
// line resolved → null, and the caller falls back to deriveOutboundNumber
// exactly as before this check existed.
//
// PR #5012 (not yet merged) adds the identical validation for outbound
// calls under the name outboundWavesCallerId
// (server/services/outbound-call-reason.js) — merge the two into one
// shared helper once it lands, rather than keeping two copies.
function managedLineForCall(call) {
  const meta = parseMetadata(call);
  const outbound = String(call?.direction || '').startsWith('outbound');
  const candidate = meta.bridgeCallerId || (outbound ? call?.from_phone : call?.to_phone);
  if (!candidate) return null;
  if (!TWILIO_NUMBERS.findByNumber(candidate)) return null;
  if (TWILIO_NUMBERS.isTechLine(candidate)) return null;
  if (TWILIO_NUMBERS.isStaffForwardNumber(candidate)) return null;
  if (candidate === TWILIO_NUMBERS.tollFree.number) return null;
  return candidate;
}

// Mirrors the canonical pipeline's own final-flags derivation
// (call-recording-processor.js's enforce-mode pass) verbatim (codex #5018
// r11 P1) — never reinvented. extraction.triage_flags alone is the MODEL's
// raw self-report; computeDeterministicTriageFlags' output (
// low_extraction_confidence, address_unverified, caller_phone_missing, …)
// is derived fresh every time the processor runs and is merged into its
// OWN route_decisions row, never written back onto the persisted
// ai_extraction_enriched.triage_flags — so reading that field alone (as
// this lane used to) silently misses every deterministic-only flag,
// including a low-confidence extraction the model flagged nothing on.
// contactPhone matters: computeDeterministicTriageFlags treats a caller
// who never restated their number as unreachable (caller_phone_missing)
// UNLESS the ANI is dialable — omitting it here would false-block nearly
// every ordinary call, the same trap the processor's own comment warns
// about at its own call site.
function finalTriageFlagsFor(call, extraction) {
  const { resolveCallContactPhone } = require('./call-recording-processor');
  const addressValidation = call.ai_address_validation;
  const modelFlags = suppressAddressFlagsForAV(
    suppressUnsupportedModelFlags(extraction.triage_flags, extraction), addressValidation,
  );
  const deterministicFlags = computeDeterministicTriageFlags(extraction, {
    addressValidation, contactPhone: resolveCallContactPhone(call, null),
  });
  return mergeTriageFlags(modelFlags, deterministicFlags);
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
  // conversationSeconds, not callDurationSeconds (codex r1 P1 — see its own
  // doc comment): an outbound bridge's duration_seconds includes staff
  // ringing and the press-1 prompt, which would stamp a real customer
  // conversation call_too_short. Also covers the earlier fix (a recovered
  // row carrying only recording_duration_seconds).
  (call) => (conversationSeconds(call) < MIN_CONVERSATION_SECONDS ? 'call_too_short' : null),
  (call, extraction) => (NON_CONVERSATION_DISPOSITIONS.has(extraction.recommended_disposition) ? 'not_a_conversation' : null),
  // Duration alone proves the clock ran, never that the caller and Waves
  // actually spoke (codex #5018 r11 P2) — a call that connected and dropped
  // in the first few seconds can still carry enough ring/hold time to clear
  // conversationSeconds above. hasRealTwoWayConversation (PR #5012) requires
  // several exchanged turns across at least two distinct raw speaker
  // labels — reused via its production promotion on CallRecordingProcessor
  // (see that file's own comment) rather than reimplemented.
  (call) => (require('./call-recording-processor').hasRealTwoWayConversation(call.transcription) ? null : 'not_two_way_conversation'),
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
  // The field itself, not only the triage flag (codex pre-push P1): the
  // processor derives quote_promised into its own final flag list and does
  // not merge it back into the persisted extraction's triage_flags, so the
  // flag check above can miss a promised quote. A quote we owe is the
  // estimate's job, never the free-visit link's.
  (call, extraction) => (extraction.service_request?.quote_promised === true ? 'quote_promised' : null),
  (call, extraction) => (extraction.service_request?.urgency === 'no_appointment_needed' ? 'no_appointment_needed' : null),
  (call, extraction) => (extraction.scheduling?.status === 'confirmed' ? 'already_booked_on_call' : null),
  (call, extraction) => {
    const disposition = extraction.recommended_disposition;
    return (disposition === 'booked' || disposition === 'no_action_needed') ? `disposition_${disposition}` : null;
  },
  (call, extraction) => (extraction.consent?.do_not_contact_request === true ? 'do_not_contact' : null),
  (call, extraction) => (extraction.consent?.sms_consent_given === false ? 'sms_consent_refused' : null),
  // Owner rule: never text someone who said the number isn't theirs (codex
  // pre-push P1). Read straight off the extraction: callback_number_needed
  // is derived into the processor's final flags, and the canonical sender
  // does not enforce this call-specific hold. A disclaimer skips the text
  // even when a spoken number was given, because staff call those back.
  (call, extraction) => (extraction.caller?.caller_id_disclaimed === true ? 'caller_id_disclaimed' : null),
  (call, extraction) => (extraction.caller?.preferred_contact_method === 'phone' ? 'prefers_phone_contact' : null),
  (call, extraction) => {
    const leadQuality = extraction.sentiment_and_lead?.lead_quality;
    return ['wrong_number', 'spam_or_solicitation', 'out_of_service_area'].includes(leadQuality) ? `lead_quality_${leadQuality}` : null;
  },
  // Safety net, checked LAST (codex #5018 r11 P1): the canonical merge
  // (model + deterministic flags, mirroring the pipeline's own
  // finalTriageFlagsFor exactly) reaches several of the SAME conditions
  // several checks above already name more specifically — quote_promised,
  // callback_number_needed (via caller_id_disclaimed), commercial_requires_quote
  // (via not_residential), do_not_contact_requested, spam_or_wrong_number
  // (via lead_quality) — and those earlier, narrower checks are deliberately
  // left to claim their own specific reason first. This entry's real job is
  // catching what NONE of them name at all: low_extraction_confidence,
  // address-derived flags (missing_service_address, address_unverified, …),
  // caller_phone_missing, ambiguous_scheduling, and the rest of
  // BLOCKING_TRIAGE_FLAGS/EXCLUDED_TRIAGE_FLAGS — a call the canonical
  // pipeline itself would hold for review is never eligible for an
  // automated follow-up text either, whatever the model's own raw
  // triage_flags said.
  (call, extraction) => {
    const flags = finalTriageFlagsFor(call, extraction);
    const hit = flags.find((f) => EXCLUDED_TRIAGE_FLAGS.has(f) || BLOCKING_TRIAGE_FLAGS.has(f));
    return hit ? `triage_flag_${hit}` : null;
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

// Mirrors reschedule-link-promises.js's persistedActivationBoundary
// exactly: unset, the boundary is READ FROM system_settings (this repo's
// existing generic key/value store) rather than derived from this
// process's own start time, which would move it forward on every restart.
// The first live sweep anywhere to find nothing stored writes now() there;
// every sweep after, on this process or any future one, reads the same
// instant back. onConflict + a re-read means a multi-process race still
// converges every process on the SAME winning instant.
// This module's OWN load time — captured once, at require, which happens
// at process boot (scheduler.js requires this lane unconditionally,
// regardless of the gate). Used ONLY as the very first persisted
// boundary's fallback value below, instead of a DB-time read taken at
// whatever moment the first 5-minute cron tick happens to run (codex r2
// P2: that left a real gap — an eligible call landing between the gate
// going live and that first tick was permanently stamped pre_activation).
// GATE_CALL_BOOKING_LINK_TEXT is read once at feature-gates.js's own
// module load (`gates.callBookingLinkText`), so flipping it live on
// Railway REQUIRES a redeploy — a fresh process — meaning this process's
// own boot time already IS gate-live time for any process that ever sees
// isEnabled(GATE) return true. onConflict('key').ignore() still means
// only the very FIRST process (of a rolling deploy, say) to find nothing
// stored ever writes; every other process, and every later restart, just
// reads the same persisted value back.
async function persistedActivationBoundary(conn) {
  const existing = await conn('system_settings').where({ key: ACTIVATION_SETTINGS_KEY }).first('value');
  if (existing?.value) return new Date(existing.value);
  await conn('system_settings').insert({
    key: ACTIVATION_SETTINGS_KEY, value: MODULE_LOAD_AT.toISOString(), category: 'call_booking_link_text',
    description: 'First live-activation instant for GATE_CALL_BOOKING_LINK_TEXT; a call that started before it is historical, not a live never-booked lead to chase.',
  }).onConflict('key').ignore();
  const settled = await conn('system_settings').where({ key: ACTIVATION_SETTINGS_KEY }).first('value');
  return settled?.value ? new Date(settled.value) : MODULE_LOAD_AT;
}

// CALL_BOOKING_LINK_TEXT_ACTIVATED_AT (an ISO instant), when set, always
// wins — read fresh each call, exactly like reschedule-link-promises' own
// env override. Unset, falls back to the persisted boundary.
async function activationBoundary(conn) {
  const configured = process.env.CALL_BOOKING_LINK_TEXT_ACTIVATED_AT;
  const parsed = configured ? new Date(configured) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : persistedActivationBoundary(conn);
}

/**
 * Evaluates and stamps every V2-extracted call this lane has not yet looked
 * at (bounded lookback). Never re-evaluates a call twice — the metadata key
 * itself is the "already decided" marker, so a permanently-skipped call is
 * never rescanned.
 */
async function stage(conn = db, { now = new Date() } = {}) {
  const boundary = await activationBoundary(conn);
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
    // from_phone / to_phone / source: resolveCallContactPhone needs them to
    // find an outbound call's dialed number for the prior-contact check
    // (pre-push P1). Without them every outbound call read as cold.
    .select('id', 'customer_id', 'direction', 'source', 'from_phone', 'to_phone', 'bridged_at', 'duration_seconds', 'recording_duration_seconds', 'created_at', 'metadata', 'twilio_call_sid', 'ai_extraction_enriched', 'ai_address_validation', 'transcription');
  let staged = 0;
  let ineligible = 0;
  for (const call of calls) {
    try {
      const decided = await stageOne(conn, call, now, boundary);
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

async function stageOne(conn, call, now, boundary = null) {
  const staged_at = now.toISOString();
  // Activation boundary: a call that started before the gate's first live
  // activation is historical — never stage it, whatever else about it
  // would otherwise be eligible (codex r1 P1).
  if (boundary) {
    const callAt = callStartedAt(call) || new Date(call.created_at);
    if (callAt.getTime() < boundary.getTime()) {
      await claimMetadata(conn, call.id, { status: 'skipped', reason: 'pre_activation', staged_at });
      return 'skipped';
    }
  }
  const linkage = await resolveLeadLinkage(conn, call);
  if (linkage.ambiguous) {
    await claimMetadata(conn, call.id, { status: 'skipped', reason: 'ambiguous_lead_linkage', staged_at });
    return 'skipped';
  }
  const leadId = linkage.leadId;
  const extraction = extractionOf(call);
  const reason = stagingIneligibleReason(call, extraction, leadId) || (await outboundStagingReason(conn, call));
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
  // Staging staleness cap (codex r6 P2 — see STAGING_STALE_MS's own doc
  // comment): a computed send time already more than an hour in the past
  // AT THE MOMENT OF STAGING is never queued at all — this is what bounds
  // an off->on re-enable, long downtime, or a backlog to "the office sees
  // it was missed," never a burst of hours-late texts.
  if (now.getTime() - new Date(send_at).getTime() > STAGING_STALE_MS) {
    await claimMetadata(conn, call.id, { status: 'skipped', reason: 'stale_at_staging', staged_at });
    return 'skipped';
  }
  // original_send_at is set ONCE here and never overwritten by a later
  // retry deferral (codex r2 P1): a retry re-queues with a NEW send_at (the
  // next attempt time), and measuring the 24h retry give-up against that
  // same, repeatedly-advancing field would let consecutive transient
  // failures push the deadline out indefinitely. This field is the one
  // fixed anchor every retry's own give-up check reads instead.
  await claimMetadata(conn, call.id, { status: 'pending', lead_id: leadId, send_at, original_send_at: send_at, staged_at });
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
  // jsonb_build_object's key argument is variadic/polymorphic — Postgres
  // cannot infer a bare named parameter's type from it alone (unlike the
  // `->`/`->>` operators below, which fix the type from their own
  // signature), and Knex expands each :key occurrence into its OWN
  // positional $N even though they all carry the same value. Without the
  // explicit ::text cast, Postgres rejects the whole claim with "could not
  // determine data type of parameter $1" — every dispatch attempt then
  // fails the claim and the row is never sent (codex r3 P1; the mocked
  // raw-query unit tests can't catch this, since they never touch a real
  // Postgres parser).
  const result = await conn.raw(
    `UPDATE call_log SET metadata = COALESCE(metadata, '{}'::jsonb) ||
       jsonb_build_object(:key::text, (metadata->:key) || jsonb_build_object('status', 'claimed', 'claimed_at', :claimed_at::text))
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
  // excludeUnresolvedSendReservations (codex r1 P2): 'sending' also covers
  // a pre-provider reply/review-ask RESERVATION row — a placeholder that
  // never reached Twilio, not delivery evidence. Every other caller of
  // this helper applies it before its own further .where()s.
  const row = await excludeUnresolvedSendReservations(conn('sms_log')).where('direction', 'outbound').where('created_at', '>=', since)
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
  ({ call, lead }) => (leadLinkedToExistingCustomer(call, lead) ? 'existing_customer' : null),
  ({ lead }) => (lead.is_commercial === true ? 'commercial_lead' : null),
  ({ lead }) => (!lead.phone || !isUsPhone(lead.phone) ? 'lead_phone_unusable' : null),
  async ({ conn, call }) => ((await outboundPriorContactMissing(conn, call)) ? 'outbound_without_prior_contact' : null),
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
// Implied transactional consent from a call is PERSONAL to whoever was
// actually ON the call — the same rule call-recording-processor.js's own
// confirmation-SMS send enforces ("implied consent is PERSONAL to the
// caller... It authorizes texting only the number that reached us"; see
// its own checkTcpaConsent call site). It never extends to a number a lead
// record was edited to AFTER the call (codex r5 P1) — this lane's
// consentBasis: 'transactional_allowed' is only honest when the actual
// send destination is one of:
//   (a) the call's own contact number itself — the inbound ANI, or for an
//       outbound call the number actually dialed — via
//       resolveCallContactPhone(call, null) (no extracted-phone override,
//       exactly like admin-triage.js's own disclaimed-number check reuses
//       it); or
//   (b) the number the caller SPOKE on this call
//       (extraction.caller.phone_e164), and ONLY when the extraction
//       itself recorded EXPLICIT SMS consent for it
//       (consent.sms_consent_given === true) — implied consent alone never
//       covers a spoken alternate, matching the owner's caller_id_disclaimed
//       staging rule and checkTcpaConsent's own explicit-consent branch.
// Anything else (most commonly: the lead's phone was edited to a different
// number sometime after the call) fails closed — no consent basis covers
// it, so this never sends there, retryable or not; a human can always
// text that new number by hand. Compared by the repo's canonical phone
// identity (NANP last-10 / +digits — server/utils/phone.js), never a raw
// string match.
function consentedDestination(call, extraction, phone) {
  const target = phoneIdentityKey(phone);
  if (!target) return false;
  const { resolveCallContactPhone } = require('./call-recording-processor');
  const contactPhone = resolveCallContactPhone(call, null);
  if (contactPhone && target === phoneIdentityKey(contactPhone)) return true;
  const spoken = extraction?.caller?.phone_e164;
  return !!spoken && target === phoneIdentityKey(spoken) && extraction?.consent?.sms_consent_given === true;
}

// falsy, so the loop returns before any later check ever dereferences it —
// every check past that point may safely assume `lead` is a real row.
async function dispatchIneligibleReason(ctx) {
  for (const check of DISPATCH_CHECKS) {
    const reason = await check(ctx);
    if (reason) return reason;
  }
  return null;
}

// Re-runs the MUTABLE never-send predicates immediately before Twilio's own
// messages.create() call, via send-customer-message.js's providerPreSendCheck
// hook (server/services/twilio.js: called once, on the SAME connection the
// provider handoff holds, right after the annual-offer guard and right
// before the SDK request — codex r2 P2). dispatchIneligibleReason's own
// checks, run once earlier in dispatchClaimedCall, can go stale across every
// await between there and the actual provider request: a staff booking, an
// estimate link, a lead closure, or a manual consultation-link send can all
// land in that gap. Only the checks that can genuinely change in that
// narrow window are worth repeating here — not the whole DISPATCH_CHECKS
// table (call-nature/property/etc. never change after the call ended).
// `dbi` is send-customer-message.js's own connection for this step
// (sometimes a transaction), never this function's own outer `conn` — it
// is the freshest possible read. A failing check returns { ok: false,
// code } with no retryable/deferred flags, which twilio.js/send-customer-
// message.js turn into a plain blocked (never-retried) outcome —
// recordSendOutcome's own final fallback then records it as a terminal
// skip under that code, exactly as if dispatchIneligibleReason itself had
// caught it moments earlier.
function neverSendRecheck(call, leadId, destinationPhone) {
  return async ({ dbi }) => {
    try {
      const lead = await dbi('leads').where({ id: leadId }).whereNull('deleted_at').first();
      if (!lead || !isOpenLeadRow(lead)) return { ok: false, code: 'lead_no_longer_open' };
      if (lead.estimate_id) return { ok: false, code: 'estimate_linked' };
      // Re-verified on the freshest possible read, same reason as every
      // other check on this hook (codex #5018 r10 P2): dispatchIneligibleReason's
      // own check ran moments earlier, and either fact can change in the
      // gap between there and the actual provider request — a manual
      // merge into an existing customer, or a commercial flag correction.
      if (leadLinkedToExistingCustomer(call, lead)) return { ok: false, code: 'existing_customer' };
      if (lead.is_commercial === true) return { ok: false, code: 'commercial_lead' };
      // Re-verifies the SAME fact dispatchClaimedCall's own earlier
      // phone_changed_before_send check made, on the freshest possible read
      // (codex r6 P1): that earlier check compared built.phone against
      // lead.phone at THAT moment, but staff can correct the phone in the
      // gap between there and this hook's own call — the actual last thing
      // that runs before messages.create(). Sending the minted bearer link
      // (/inspection/:token) to a number staff just retired for THIS lead
      // would hand whoever now holds it the lead's current name and address
      // (inspection-public.js's buildLeadPayload) — worse than merely
      // losing the send. Compared by canonical phone identity, matching
      // consentedDestination's own comparator, never a raw string match.
      if (phoneIdentityKey(lead.phone) !== phoneIdentityKey(destinationPhone)) return { ok: false, code: 'phone_changed_before_send' };
      // Re-verified even though nothing between the earlier send-time check
      // and here can change the destination string itself (codex r5 P1) —
      // the same last-moment-before-the-provider-request discipline every
      // other check on this hook already follows.
      if (!consentedDestination(call, extractionOf(call), destinationPhone)) return { ok: false, code: 'destination_not_consented' };
      const callStart = callStartedAt(call) || new Date(call.created_at);
      if (await bookedSinceCall(dbi, lead.customer_id, callStart)) return { ok: false, code: 'booked_since_call' };
      if (await linkSentRecently(dbi, leadId, new Date())) return { ok: false, code: 'link_sent_recently' };
      // Stamped HERE, as the LAST thing before returning ok — the true
      // provider-start boundary (codex r8 P2). NOT on dbi (codex #5018 r11
      // pre-push P1): dbi is now the phone-locked transaction the lane's
      // own withSmsHandoff opens, the SAME one Twilio's own request runs
      // on — a timeout/thrown error from messages.create() itself rolls
      // that whole transaction back, discarding this stamp right along
      // with it even though Twilio may already have the request. That
      // would make recoverStaleClaims/recoverAbandonedClaim misread a
      // genuinely ambiguous send as a safe-to-retry pre-provider failure
      // and text the lead twice. markerDb() (models/marker-db.js) is the
      // SAME dedicated single-statement connection outside the root pool
      // that visit-completion-summary.js's own claimDispatchThroughHandoff
      // uses for exactly this "durable marker from inside a held handoff"
      // need (CLAUDE.md rule 15) — this UPDATE commits immediately and
      // independently, so it survives whatever dbi/Twilio do next. Every
      // check above this line still reads dbi (the freshest, lock-
      // consistent view) — only this one write moves. Every one of
      // sendCustomerMessage's own earlier pre-provider steps (acquiring the
      // handoff reservation, its first suppression/consent read) still
      // fails or throws BEFORE this write — flowing to
      // recoverAbandonedClaim's ordinary retry rail — and only a failure in
      // the narrow window AFTER this (the callback_number_needed check, the
      // final isStillValid recheck, or messages.create() itself) is still,
      // correctly, terminal-ambiguous, now durably so.
      const entry = parseMetadata(call)[METADATA_KEY] || {};
      await recordDecision(markerDb(), call, { ...entry, status: 'claimed', handoff_started_at: new Date().toISOString() }, { logActivity: false });
      return { ok: true };
    } catch (err) {
      // A DB read failing here is an infrastructure hiccup, not a
      // deliberate "never eligible" refusal (codex r3 P1): twilio.js's own
      // providerPreSendCheck contract maps an UNCAUGHT throw's retryable
      // flag through checkErr?.retryable, which a plain thrown Error never
      // carries — so letting this propagate would turn an ordinary
      // transient failure into a PERMANENT, non-retryable skip even though
      // Twilio was never contacted. Returning (never throwing) a retryable
      // refusal instead flows through sendSMS's own verdict shape into
      // recordSendOutcome's existing bounded retry rail — the SAME rail an
      // ordinary retryable send outcome already uses — so this row is
      // picked back up on a later sweep instead of being lost.
      logger.warn(`[call-booking-link-text] neverSendRecheck failed for call ${call.id} (${err.code || err.name || 'error'})`);
      return { ok: false, retryable: true, code: 'never_send_recheck_failed', reason: err.message };
    }
  };
}

// The ownership fence at send time: 'wait' while the processor holds or is
// rewriting the row, a skip reason once it gave up or ended non-valid, null
// when the row is ready to judge.
function sendReadiness(call, entry, now) {
  if (call.processing_token || call.v2_extraction_status == null) {
    // original_send_at, NOT entry.send_at (codex #5018 r10 P2): a retry
    // deferral advances send_at itself (the NEXT attempt time), so measuring
    // this timeout against that same, repeatedly-advancing field would let
    // consecutive reprocess stalls push the give-up out indefinitely —
    // exactly the bug pastRetryDeadline's own anchor already avoids for the
    // send-retry case. Same fixed anchor, same NOT_READY_GIVE_UP_MS bound.
    const anchor = entry.original_send_at || entry.send_at;
    const dueAt = anchor ? new Date(anchor) : null;
    const overdue = dueAt && !Number.isNaN(dueAt.getTime()) && now.getTime() - dueAt.getTime() > NOT_READY_GIVE_UP_MS;
    return overdue ? 'call_not_ready_timeout' : 'wait';
  }
  return call.v2_extraction_status === 'valid' ? null : `extraction_${call.v2_extraction_status}`;
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
  // The processor's own ownership fence, re-checked at send time (codex
  // pre-push P1): staging only judged a row that was valid and quiet. A
  // reprocess since then holds processing_token and resets
  // v2_extraction_status to null while it rewrites the extraction and the
  // lead linkage. That's a reason to WAIT, not to judge half-written state.
  // Checked before the linkage re-check below, which a mid-reprocess row
  // would fail spuriously. A reprocess that ends non-valid is a skip, and a
  // row still not ready a day past its send time gives up with a reason
  // instead of being re-claimed forever.
  const readiness = sendReadiness(call, entry, now);
  if (readiness === 'wait') {
    // original_send_at must ride along even though send_at itself is
    // unchanged here (codex r2 P1): metadataPatch REPLACES the whole
    // nested entry, so leaving the field out of this write would silently
    // erase it, not merely leave it as-is.
    await recordDecision(conn, call, { status: 'pending', lead_id: leadId, send_at: entry.send_at, original_send_at: entry.original_send_at || entry.send_at }, { logActivity: false });
    return { sent: false, skipped: 'call_not_ready', deferred: true };
  }
  if (readiness) return skip(readiness);
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
    // original_send_at survives this deferral too (codex r2 P1) — an
    // overnight quiet-hours crossing must not reset the 24h retry anchor
    // to "tomorrow morning" on top of whatever transient failures already
    // deferred it.
    await recordDecision(conn, call, { status: 'pending', lead_id: leadId, send_at, original_send_at: entry.original_send_at || entry.send_at }, { logActivity: false });
    return { sent: false, skipped: 'outside_send_window', deferred: true };
  }
  // Checked BEFORE ever minting or sending, not only after a retryable
  // failure (codex r3 P1): an overnight deferral or an outage can carry a
  // retry past original_send_at + 24h while the row is still 'pending' at
  // dispatch time. Judging the deadline only after a send attempt means a
  // provider that happens to succeed on that overdue attempt would still
  // text a stale follow-up and record it as a normal send.
  if (pastRetryDeadline(entry, now)) return skip('send_retry_timeout');
  const lead = await conn('leads').where({ id: leadId }).whereNull('deleted_at').first();
  const reason = await dispatchIneligibleReason({ conn, call, lead, leadId, now });
  if (reason) return skip(reason);

  const built = await buildLeadConsultationSmsLine(lead.id, lead.first_name);
  if (!built.url) {
    const linkReason = built.reason ? `link_unavailable:${built.reason}` : 'link_unavailable';
    // built.transient (codex r2 P2) marks a genuine unexpected failure in
    // the builder itself (a DB hiccup, not a deliberate refusal — gate
    // off, an ineligible lead, an invalid phone, a missing signing secret
    // are never flagged). Requeue it through the SAME bounded retry rail
    // recordSendOutcome already owns for a retryable send outcome —
    // original_send_at's deadline, the backoff, and the give-up path —
    // rather than a second copy of that logic here.
    if (built.transient) return recordSendOutcome(conn, call, entry, leadId, now, { sent: false, retryable: true, code: linkReason });
    return skip(linkReason);
  }
  // The token is signed for built.phone — the builder's OWN fresh DB read,
  // not lead.phone from the row this function fetched moments earlier
  // (codex r1 P1). Sending to lead.phone while the phone changed in that
  // narrow window would deliver a token that proves delivery to the OLD
  // number while it actually reaches whoever holds the new one now. Skip
  // rather than silently sending to the new number — a changed phone this
  // close to send time deserves a human look, not an automated guess.
  if (built.phone && built.phone !== lead.phone) return skip('phone_changed_before_send');

  // Implied transactional consent covers ONLY the call's own contact
  // number or an explicitly-consented spoken number — never a number the
  // lead was edited to since (codex r5 P1; see consentedDestination's own
  // doc comment). destinationPhone is the exact string the actual send
  // below targets, never recomputed differently.
  const destinationPhone = built.phone || lead.phone;
  if (!consentedDestination(call, extractionOf(call), destinationPhone)) return skip('destination_not_consented');

  // handoff_started_at is stamped inside neverSendRecheck itself (codex r8
  // P2), not here — sendCustomerMessage still does its OWN fallible
  // pre-provider work (acquiring the provider handoff reservation, a fresh
  // suppression/consent read) before it ever reaches that hook, and
  // stamping this row 'claimed'+handoff_started_at before any of that ran
  // left a throw in that gap permanently ambiguous even though Twilio was
  // never contacted. See neverSendRecheck's own doc comment for exactly
  // where the boundary now sits.
  const managedLine = managedLineForCall(call);
  const result = await sendCustomerMessage({
    to: destinationPhone,
    body: built.line,
    channel: 'sms',
    audience: 'lead',
    purpose: 'missed_call_followup',
    leadId: lead.id,
    identityTrustLevel: 'phone_provided_unverified',
    consentBasis: { status: 'transactional_allowed', source: 'call_booking_link_text' },
    entryPoint: 'call_booking_link_text',
    metadata: { original_message_type: MESSAGE_TYPE, call_log_id: call.id, lead_id: lead.id, ...(managedLine ? { fromNumber: managedLine } : {}) },
    providerPreSendCheck: neverSendRecheck(call, leadId, destinationPhone),
    // codex #5018 r11 P1: without a locked handoff, a STOP committed after
    // send-customer-message.js's FIRST suppression/consent read (well before
    // this call even reaches the provider) and before this hook's own
    // request is never re-caught — neverSendRecheck re-derives this lane's
    // OWN never-send conditions, not suppression/consent, and the provider
    // handoff has no transaction of its own to reload them on. Locking the
    // phone (the SAME key the inbound STOP writer takes, applyInboundOptout
    // via lockSmsPhone) serializes this send against a concurrent STOP
    // commit; the generic wrapper send-customer-message.js builds around
    // whatever transaction this opens is what actually reloads suppression
    // and consent before handing off to neverSendRecheck and then Twilio —
    // nothing lane-specific needs re-checking here, only the lock.
    withSmsHandoff: (handoff) => conn.transaction(async (trx) => {
      await lockSmsPhone(trx, destinationPhone);
      return handoff(trx);
    }),
  }).catch((err) => (isRealProviderSend(err?.providerOutcome) || isAmbiguousProviderOutcome(err?.providerOutcome)) ? err.providerOutcome : Promise.reject(err));

  return recordSendOutcome(conn, call, entry, leadId, now, result);
}

// Bounded by the SAME 24h give-up this lane already applies to a stalled
// reprocess (NOT_READY_GIVE_UP_MS), measured from original_send_at — the
// ONE fixed anchor staging sets once and no retry deferral ever rewrites
// (codex r2 P1). entry.send_at itself is NOT that anchor: each retry
// re-queues with a NEW send_at (the next attempt time), so measuring
// against that same, repeatedly-advancing field would let consecutive
// transient failures push this deadline out indefinitely. A row staged
// before this field existed falls back to its own send_at once, which is
// still strictly more correct than never bounding it at all.
function pastRetryDeadline(entry, now) {
  const anchor = entry.original_send_at || entry.send_at;
  const originalSendAt = anchor ? new Date(anchor) : now;
  if (Number.isNaN(originalSendAt.getTime())) return false;
  return now.getTime() - originalSendAt.getTime() > NOT_READY_GIVE_UP_MS;
}

// Everything that happens AFTER sendCustomerMessage returns — split out of
// dispatchClaimedCall purely to keep that function's own branching within
// the repo's structural-lint threshold (CLAUDE.md rule 20: this moves
// decisions out wholesale, it doesn't hide them behind a one-use wrapper —
// every branch here is a DIFFERENT terminal outcome dispatchClaimedCall
// would otherwise have to classify itself).
async function recordSendOutcome(conn, call, entry, leadId, now, result) {
  const skip = async (reason) => {
    await recordDecision(conn, call, { status: 'skipped', reason, lead_id: leadId, send_at: entry.send_at });
    return { sent: false, skipped: reason };
  };
  if (result.sent && isRealProviderSend(result)) {
    await recordDecision(conn, call, {
      status: 'sent', lead_id: leadId, send_at: entry.send_at, sent_at: now.toISOString(), provider_message_id: result.providerMessageId,
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
  // A retryable/deferred outcome (send-customer-message.js's own
  // { retryable, deferred, nextAllowedAt } — a quiet-hours hold crossed by
  // this sweep, CONSENT_LOOKUP_FAILED, or a transient provider failure) is
  // a reason to WAIT, not to give up (codex r1 P1) — the same principle as
  // the send-window deferral in dispatchClaimedCall. Re-queue as 'pending'
  // at nextAllowedAt, or a short backoff when the result named none,
  // bounded by the SAME 24h give-up this lane already applies to a stalled
  // reprocess: past that, from the ORIGINAL send_at, stop retrying and
  // record a reason.
  if (result.retryable || result.deferred) {
    if (pastRetryDeadline(entry, now)) return skip(result.code || result.reason || 'send_retry_timeout');
    const nextAllowedAt = result.nextAllowedAt ? new Date(result.nextAllowedAt) : null;
    const send_at = (nextAllowedAt && !Number.isNaN(nextAllowedAt.getTime()) ? nextAllowedAt : new Date(now.getTime() + RETRY_BACKOFF_MS)).toISOString();
    // original_send_at carries forward UNCHANGED through every deferral —
    // it is the fixed anchor pastRetryDeadline reads, never the advancing
    // send_at (codex r2 P1).
    await recordDecision(conn, call, { status: 'pending', lead_id: leadId, send_at, original_send_at: entry.original_send_at || entry.send_at }, { logActivity: false });
    return { sent: false, skipped: result.code || result.reason || 'send_retryable', deferred: true };
  }
  const blockedReason = result.blocked ? (result.code || result.reason || 'policy_block') : (result.code || result.reason || 'provider_failed');
  return skip(blockedReason);
}

// A 'claimed' row a whole sweep tick failed to bring to a terminal status
// itself (codex r3 P2) — either THIS process just saw dispatchClaimedCall
// throw (sweep()'s own catch, immediately), or a LATER, possibly different,
// process finds a row still 'claimed' well past when any single tick's
// synchronous claim-then-dispatch could still legitimately be in flight
// (staleClaimRecovery below, after STALE_CLAIM_MS — the previous worker
// most likely died mid-dispatch and never got to run any catch at all).
// Both callers share this one decision: handoff_started_at (stamped inside
// neverSendRecheck itself, as the actual provider-start boundary — see its
// own doc comment) is the ONE fact that says whether resending is safe.
// Absent, the failure happened strictly before any network attempt, so
// this is exactly as safe to requeue as any other retryable send outcome —
// through the SAME bounded rail (original_send_at's own 24h deadline, then
// the ordinary backoff) recordSendOutcome already owns for that case.
// Present, the provider may already have this exact attempt — moved to
// its own terminal 'ambiguous' status (codex r8 P2 — previously left
// merely 'claimed' with no further write, which matched
// recoverStaleClaims' own WHERE clause on every future sweep forever;
// enough of those piling up, oldest-created-at-first, could occupy the
// whole DISPATCH_BATCH window and starve a genuinely recoverable
// pre-handoff row from ever being reached). Never resent — 'ambiguous'
// matches neither claimForDispatch's 'pending' filter nor this function's
// own 'claimed' one — and logged (not a customer-facing outcome, but
// visible in the activity feed rather than only by querying call_log
// directly, unlike this lane's own documented pre-existing limitation for
// a live ambiguous provider outcome, which converges on this SAME status
// once IT goes stale enough for a stale-claim sweep to find it too).
async function recoverAbandonedClaim(conn, call, now) {
  const entry = parseMetadata(call)[METADATA_KEY] || {};
  if (entry.handoff_started_at) {
    await recordDecision(conn, call, { ...entry, status: 'ambiguous', reason: 'ambiguous_provider_outcome' });
    return { ambiguous: true };
  }
  if (pastRetryDeadline(entry, now)) {
    await recordDecision(conn, call, { status: 'skipped', reason: 'worker_error', lead_id: entry.lead_id, send_at: entry.send_at });
    return { ambiguous: false, terminal: true };
  }
  const send_at = new Date(now.getTime() + RETRY_BACKOFF_MS).toISOString();
  await recordDecision(conn, call, {
    status: 'pending', lead_id: entry.lead_id, send_at, original_send_at: entry.original_send_at || entry.send_at,
  }, { logActivity: false });
  return { ambiguous: false, terminal: false };
}

// How long a 'claimed' row may sit with no terminal status before the next
// sweep treats it as abandoned by a dead worker rather than one still
// legitimately in flight — a single tick's own claim-then-dispatch is
// synchronous and normally resolves in well under a second, so this is a
// wide safety margin, not a tuning knob for ordinary latency.
const STALE_CLAIM_MS = 15 * 60 * 1000;

// Safety net for a worker that died between claimForDispatch and any
// terminal write — no process ever ran a catch for that row, so without
// this it would stay 'claimed' forever, invisible to the 'pending'-only
// dispatch query above and to sweep()'s own per-row catch (codex r3 P2).
// Re-reads each candidate fresh before recovering it — the batched SELECT
// is only a candidate list; a row a concurrent tick already resolved
// between that read and here must not be recovered twice.
async function recoverStaleClaims(conn, now) {
  const cutoff = new Date(now.getTime() - STALE_CLAIM_MS);
  const stale = await conn('call_log')
    .where('created_at', '>=', new Date(now.getTime() - QUEUE_SCAN_LOOKBACK_MS))
    .whereRaw("metadata->:key->>'status' = 'claimed'", { key: METADATA_KEY })
    .whereRaw("(metadata->:key->>'claimed_at')::timestamptz <= :cutoff", { key: METADATA_KEY, cutoff })
    .orderBy('created_at', 'asc').limit(DISPATCH_BATCH).select('id');
  let recovered = 0;
  for (const row of stale) {
    try {
      const call = await conn('call_log').where({ id: row.id }).first();
      if (!call || (parseMetadata(call)[METADATA_KEY] || {}).status !== 'claimed') continue;
      const outcome = await recoverAbandonedClaim(conn, call, now);
      if (!outcome.ambiguous) recovered += 1;
    } catch (err) {
      logger.warn(`[call-booking-link-text] stale-claim recovery failed for call ${row.id} (${err.code || err.name || 'error'})`);
    }
  }
  return recovered;
}

async function sweep(conn = db, { now = new Date() } = {}) {
  if (!isEnabled(GATE)) return { staged: 0, ineligible: 0, sent: 0, dispatchSkipped: 0 };
  const { staged, ineligible } = await stage(conn, { now });
  const due = await conn('call_log')
    .where('created_at', '>=', new Date(now.getTime() - QUEUE_SCAN_LOOKBACK_MS))
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
      // revisited by the 'pending'-only query above, so it must reach a
      // terminal status here — but NEVER a blind worker_error the way this
      // used to (codex r3 P2): recoverAbandonedClaim reads handoff_started_at
      // off the row itself to decide whether the provider might already
      // have this exact attempt (never resend) or whether it is safe to
      // requeue through the ordinary retry rail instead of giving up
      // outright on a failure that never reached Twilio at all.
      const failedCall = await conn('call_log').where({ id: row.id }).first().catch(() => null);
      const outcome = failedCall ? await recoverAbandonedClaim(conn, failedCall, now).catch(() => null) : null;
      if (!outcome || !outcome.ambiguous) dispatchSkipped += 1;
    }
  }
  // Safety net for a worker that died between claimForDispatch and any
  // terminal write in a PAST sweep — this process's own per-row catch above
  // only ever covers a throw IT observes; nothing else would ever revisit
  // such a row otherwise (see recoverStaleClaims' own doc comment).
  let staleClaimsRecovered = 0;
  try {
    staleClaimsRecovered = await recoverStaleClaims(conn, now);
  } catch (err) {
    logger.warn(`[call-booking-link-text] stale-claim recovery sweep failed (${err.code || err.name || 'error'})`);
  }
  return { staged, ineligible, sent, dispatchSkipped, staleClaimsRecovered };
}

module.exports = {
  GATE,
  METADATA_KEY,
  MESSAGE_TYPE,
  STAGING_LOOKBACK_DAYS,
  STAGING_GRACE_MINUTES,
  STAGING_STALE_MS,
  QUEUE_SCAN_LOOKBACK_MS,
  MIN_CONVERSATION_SECONDS,
  computeSendAt,
  callEndFor,
  conversationSeconds,
  managedLineForCall,
  stagingIneligibleReason,
  outboundPriorContactMissing,
  outboundStagingReason,
  resolveLeadId,
  resolveLeadLinkage,
  activationBoundary,
  persistedActivationBoundary,
  ACTIVATION_SETTINGS_KEY,
  MODULE_LOAD_AT,
  neverSendRecheck,
  consentedDestination,
  stage,
  stageOne,
  claimForDispatch,
  dispatchClaimedCall,
  recoverAbandonedClaim,
  recoverStaleClaims,
  STALE_CLAIM_MS,
  sweep,
  _private: { leadIdOf, extractionOf, parseMetadata, bookedSinceCall, linkSentRecently },
};
