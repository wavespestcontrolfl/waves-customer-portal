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
 * Gate: GATE_CALL_BOOKING_LINK_TEXT (default off; off = no staging, claim,
 * or send — the only thing that still runs is pruning stale
 * consultation_link_send_attempts rows, since the two manual senders write
 * those regardless of this gate; see sweep()'s own doc comment). Also requires
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
 * Mechanism: the decision and its timer both live on the call's own
 * `call_log.metadata.call_booking_link_text` — set once, at most, per call:
 * The exceptions are two purpose-built durable-marker tables. The first is
 * the pre-provider handoff marker (codex #5018 r13 P1),
 * `call_booking_link_text_handoffs` (migration 20260927160000), keyed by
 * `call_log_id`. It exists ONLY because neverSendRecheck ALSO locks the
 * call_log row FOR UPDATE through the actual provider request (closing a
 * forced-reprocess race), and a marker written to call_log itself from a
 * separate connection would deadlock against that same lock — see
 * neverSendRecheck's own doc comment for the full reasoning. The second is
 * `consultation_link_send_attempts` (migration 20260928130000, codex
 * #5196 P1/P2 follow-up) — the SAME durable-evidence pattern generalized
 * across all three consultation-link senders (this lane's own worker AND
 * the manual sends in admin-leads.js/admin-communications.js), keyed by
 * lead_id + to_phone, so linkSentRecently's phone-scoped manual-race guard
 * can see a competing sender's in-flight attempt even if its own
 * transaction later rolls back. See insertConsultationLinkAttempt's own
 * doc comment.
 *   { status: 'skipped', reason, staged_at }                — never eligible
 *   { status: 'pending', lead_id, send_at, original_send_at, staged_at } — waiting out the delay
 *     (original_send_at is set once at staging and never rewritten by a
 *     later retry deferral, which only ever advances send_at itself — the
 *     fixed anchor a retry's own 24h give-up measures against)
 *   { status: 'sent', lead_id, send_at, sent_at, ... }        — texted
 *   { status: 'skipped', reason, send_at, decided_at, failed? } — was pending, blocked at send time
 *     (failed: true when delivery itself failed, not a policy block)
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
const { lockSmsPhone, lockCustomerComms } = require('../utils/customer-comms-lock');
const { OPEN_ESTIMATE_STATUSES } = require('./estimate-automation-duplicates');
const {
  computeDeterministicTriageFlags, mergeTriageFlags, suppressAddressFlagsForAV,
  suppressUnsupportedModelFlags, BLOCKING_TRIAGE_FLAGS,
} = require('./call-triage-flags');

const GATE = 'callBookingLinkText';
const METADATA_KEY = 'call_booking_link_text';
const MESSAGE_TYPE = 'call_booking_link_text';
// Durable pre-provider marker table (codex #5018 r13 P1; migration
// 20260927160000_call_booking_link_text_handoffs.js) — see neverSendRecheck's
// own doc comment for exactly why this moved off call_log.metadata.
const HANDOFF_MARKER_TABLE = 'call_booking_link_text_handoffs';
// Housekeeping retention for that table — any row this old has long since
// resolved through recoverAbandonedClaim/recoverStaleClaims (both bounded
// well under a day), so it is never read again; the live sweep prunes it.
const HANDOFF_MARKER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// Durable pre-provider marker for ALL THREE consultation-link senders —
// this lane's own automated worker AND the manual sends in
// admin-leads.js/admin-communications.js (migration 20260928130000, codex
// #5196 P1/P2 follow-up). HANDOFF_MARKER_TABLE above only ever protected
// THIS lane's own attempt; a manual send accepted by Twilio whose outer
// transaction then failed to commit released lockSmsPhone with no durable
// evidence anywhere a competing sender could see, so it could resend the
// same link. This table generalizes that evidence across all three
// senders and carries the destination phone, so linkSentRecently's
// phone-scoped manual-race check can use it too. See the migration's own
// header for why it carries no foreign keys.
const CONSULTATION_ATTEMPT_TABLE = 'consultation_link_send_attempts';
// Longer than LINK_SENT_RECENTLY_DEFAULT_WINDOW_MS (14 days, below) — a row
// is never pruned while a dedupe read could still consult it.
const CONSULTATION_ATTEMPT_RETENTION_MS = 15 * 24 * 60 * 60 * 1000;

// linkSentRecently's own default dedupe window — "was this lead's link
// already sent" for the automated lane's own final pre-send refusal.
const LINK_SENT_RECENTLY_DEFAULT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

// Follow-up to codex #5018 r15 P2: admin-leads.js's lead send-sms route and
// admin-communications.js's composer route both take lockSmsPhone before
// dispatch — serializing against THIS lane's own worker send — but neither
// re-checked linkSentRecently on that held connection, so a worker send
// landing moments earlier left staff free to text the same link again
// seconds later. Both now re-run linkSentRecently with THIS short window
// instead of the 14-day default above: staff may deliberately resend an
// older link (that's allowed, unchanged), so only a delivery inside this
// same tiny race window — the two sends interleaving around one
// lockSmsPhone acquisition — is refused.
const MANUAL_SEND_RACE_GUARD_WINDOW_MS = 10 * 60 * 1000;

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
//
// 'family_member' (schema 1.18.0, owner ruling 2026-09-28): a caller
// arranging service at a RELATIVE's home is, by definition, not the
// resident of that service address — a caller phoning about "my
// grandfather's house" would receive a booking-link text at their own
// number for a consultation at a property they don't live at. Same
// reasoning as property_manager/lender/realtor: fails closed into the
// third-party set.
// An unconfirmed family_member call that reaches this lane (the confirmed-
// booking case is filtered out above, same as home_buyer) gets no link.
const THIRD_PARTY_RELATIONSHIPS = new Set([
  'property_manager', 'real_estate_agent', 'lender', 'hoa_board_member', 'employee', 'other', 'home_buyer', 'family_member',
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
// no_sms_consent_captured deliberately excluded: OWNER RULING 2026-09-28 —
// this transactional follow-up may go to a caller who never explicitly
// opted in, as long as it rides the consented destination (consentedDestination's
// ANI/dialed-number path, implied consent); explicit refusals still block it,
// through do_not_contact_requested above, STOP suppression at send, the
// dedicated consent.sms_declined / sms_refusal_unrecorded check in
// STAGING_CHECKS (schema 1.19.0) — sms_declined is a raw consent field, not
// a triage_flags enum value, so it is never one of the flags excluded here —
// and, codex P1 on #5292, a decline spoken on an EARLIER call for the same
// phone (smsDeclinedOnEarlierCall, in DISPATCH_CHECKS and
// NEVER_SEND_RECHECK_STEPS — this call's own extraction is never the only
// evidence consulted). destination_not_consented still blocks it too.
const EXCLUDED_TRIAGE_FLAGS = new Set([
  'out_of_service_area', 'hoa_common_area_requires_approval', 'commercial_requires_quote',
  'caller_not_authorized', 'do_not_contact_requested',
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
  // codex #5018 r15/r16 P1 follow-up: the earlier `.catch(() => null)` here
  // turned a transient failure of THIS lookup into "customer created at an
  // unknown time," which outboundPriorContactCustomerId's own predatesCall()
  // reads no differently from a customer that genuinely never existed —
  // silently permitting an outbound_without_prior_contact stamp on nothing
  // but a DB hiccup, and permanently (this lane stamps that reason at most
  // once per call; there is no retry once it is written). Left to
  // propagate now, exactly like every OTHER prior-contact probe below and
  // the doc comment two paragraphs down already promised: staging's own
  // per-call catch (see stage()) leaves the row undecided rather than
  // wrongly stamped, and both dispatch/neverSendRecheck already treat an
  // uncaught throw here as retryable, never a permanent skip.
  const callCustomerCreatedAt = call.customer_id
    ? (await conn('customers').where({ id: call.customer_id }).whereNull('deleted_at').first('created_at'))?.created_at || null
    : null;
  // conn (codex #5018 pre-push P1): thread the caller's own held connection
  // through hasPriorContact's probes — during dispatchClaimedCall/
  // neverSendRecheck, `conn` is the SAME connection a phone-locked handoff
  // transaction already occupies, and under the supported DB_POOL_MAX=2 a
  // probe opened on the shared pool instead would starve into a
  // connection-acquire timeout (the cron lock takes the other slot). A
  // genuine probe failure now propagates rather than being swallowed into
  // "no prior contact" — see outboundStagingReason's own callers for why
  // that must be retryable, never a permanent skip.
  const has = await hasPriorContact({
    customerId: outboundPriorContactCustomerId({ call, callMeta: parseMetadata(call), callCustomerCreatedAt, before }),
    phone: resolveCallContactPhone(call, null),
    before,
    conn,
  });
  return !has;
}

async function outboundStagingReason(conn, call) {
  return (await outboundPriorContactMissing(conn, call)) ? 'outbound_without_prior_contact' : null;
}

// A call the office is HOLDING at an existing customer's address (GATE_CALL_HOUSEHOLD_HOLD: an open
// or claimed household_address_match card) is never chased with the self-service inspection link:
// the caller may belong to that household, and a link they can book from would recreate the
// duplicate / double booking the hold exists to stop. Only an OPEN or CLAIMED card blocks; a
// resolved (retired, or settled by the office) or dismissed card means there is no hold. Read on the
// connection it is given, so the send-time recheck judges it on the locked handoff's own connection.
async function householdHoldOpen(conn, call) {
  const card = await conn('triage_items')
    .where({ call_log_id: call.id, reason_code: 'household_address_match' })
    .whereIn('status', ['open', 'in_progress'])
    .first('id');
  return !!card;
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
  // codex #5018 P2: internalAlertCallerId() is the new-lead ring TO Adam's
  // cell (never customer-facing) — a bridged call's own from_phone/to_phone
  // is checked here as a fallback only when metadata.bridgeCallerId is
  // absent (see this function's own doc comment above), so a call that
  // reaches this point through THAT fallback could still resolve to the
  // internal alert leg rather than the line that actually rang the lead.
  // Excluded via internalAlertLine() specifically, never a raw
  // internalAlertCallerId() comparison: that method itself FALLS BACK to
  // the ordinary main line when INTERNAL_ALERT_CALLER_ID is unset, and the
  // main line is a genuine customer-facing fallback, not an internal leg —
  // internalAlertLine() already returns null in exactly that case (and
  // when the configured number is already a registered fleet line), so
  // this only excludes a REAL, distinct, env-configured alert number.
  const alertLine = TWILIO_NUMBERS.internalAlertLine();
  if (alertLine && candidate === alertLine.number) return null;
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
  // No sms_consent_given === false check (dry run 2026-09-28): the field is a
  // required boolean the prompt sets true ONLY on an explicit yes, so false
  // means "never asked", not "refused" — it blocked 151 of 159 real new-lead
  // calls, the exact opt-in requirement the owner ruling removed. Refusals
  // still block, but through the dedicated field below (and STOP suppression
  // at send) rather than sms_consent_given, which cannot tell "never asked"
  // from "said no".
  // sms_declined (schema 1.19.0, codex P1 on #5292): sms_consent_given=false
  // ALSO covers an explicit "no" to "may I text you?" — the dry-run removal
  // above stopped catching that refusal along with the "never asked"
  // majority it was meant to unblock. sms_declined is the model's
  // separately-judged field, true ONLY on an explicit decline. It is
  // additive/optional in both schemas (AGENTS.md: extraction schema changes
  // never add to `required`), so a pre-1.19 extraction — or any row the
  // field is simply absent or null on — fails CLOSED here rather than
  // assume no refusal was made.
  (call, extraction) => {
    const declined = extraction.consent?.sms_declined;
    if (typeof declined !== 'boolean') return 'sms_refusal_unrecorded';
    return declined === true ? 'sms_declined' : null;
  },
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
    .modify((q) => require('./voice-agent/relay-protocol').whereNotSandboxCall(q)) // a sandbox test call is never texted
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
    // A call under an OPEN household hold is not a candidate AT ALL (it carries no decision marker, so
    // left in it would be re-selected every sweep and could fill the batch ahead of newer leads). It
    // re-enters the moment its card closes: dismissed -> staged on the next sweep.
    .whereRaw("NOT EXISTS (SELECT 1 FROM triage_items WHERE triage_items.call_log_id = call_log.id AND triage_items.reason_code = 'household_address_match' AND triage_items.status IN ('open', 'in_progress'))")
    .orderBy('created_at', 'asc')
    .limit(STAGING_BATCH)
    // from_phone / to_phone / source: resolveCallContactPhone needs them to
    // find an outbound call's dialed number for the prior-contact check
    // (pre-push P1). Without them every outbound call read as cold.
    // processing_token / updated_at / v2_extraction_status (codex #5018 P2):
    // exactly the three columns this query's own WHERE just filtered on —
    // carried through so claimMetadata can re-check them at UPDATE time
    // (see its own doc comment) instead of trusting they still hold after
    // every async await stageOne makes in between.
    .select('id', 'customer_id', 'direction', 'source', 'from_phone', 'to_phone', 'bridged_at', 'duration_seconds', 'recording_duration_seconds', 'created_at', 'metadata', 'twilio_call_sid', 'ai_extraction_enriched', 'ai_address_validation', 'transcription', 'processing_token', 'updated_at', 'v2_extraction_status');
  let staged = 0;
  let ineligible = 0;
  for (const call of calls) {
    try {
      const decided = await stageOne(conn, call, now, boundary);
      if (decided === 'pending') staged += 1; else if (decided !== 'deferred') ineligible += 1;
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
      await claimMetadata(conn, call, { status: 'skipped', reason: 'pre_activation', staged_at });
      return 'skipped';
    }
  }
  const linkage = await resolveLeadLinkage(conn, call);
  if (linkage.ambiguous) {
    await claimMetadata(conn, call, { status: 'skipped', reason: 'ambiguous_lead_linkage', staged_at });
    return 'skipped';
  }
  const leadId = linkage.leadId;
  const extraction = extractionOf(call);
  const reason = stagingIneligibleReason(call, extraction, leadId) || (await outboundStagingReason(conn, call));
  if (reason) {
    await claimMetadata(conn, call, { status: 'skipped', reason, staged_at });
    return 'skipped';
  }
  // (The candidate query already leaves an open hold out; this re-check covers a card filed between
  // that read and now.) An OPEN household hold DEFERS the call instead of deciding it: no metadata is
  // written, so the next sweep looks again. A dismissal ("really someone new") before the send window then restores
  // the follow-up for a genuine new lead; a resolved card stages normally; a card still open when
  // the lookback ends simply ages out. (Contrast the permanent skips above, which are final.)
  if (await householdHoldOpen(conn, call)) return 'deferred';
  const callEnd = callEndFor(call);
  if (!callEnd) {
    await claimMetadata(conn, call, { status: 'skipped', reason: 'no_call_end_time', staged_at });
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
  //
  // Measured from the send-WINDOW-ADJUSTED time, never the raw nominal
  // offset (codex #5018 round-2 P2): computeSendAt's call-end + 2h offset
  // can itself land before 8 AM ET — a call ending at 1 AM computes a
  // nominal send_at around 3 AM, hours before dispatch is ever allowed at
  // all. Measuring staleness against that too-early instant terminally
  // discarded a call staged at, say, 4:30 AM even though its actual first
  // legal send (today's 8 AM open) was still nearly 3.5 hours away.
  // isWithinSendWindowET/nextSendWindowOpenET (send-window.js, the same
  // shared helper this file already uses for the dispatch-time window
  // check below) compose the adjustment with no hand-rolled ET math:
  // already-legal (within the window) keeps the nominal instant as is;
  // otherwise nextSendWindowOpenET resolves the next open — the SAME
  // calendar day's 8 AM for an early-morning instant (its own `hour < 8`
  // branch never advances the date), the next day's 8 AM for an
  // at/after-8-PM instant.
  const nominalSendAt = new Date(send_at);
  const legalSendAt = isWithinSendWindowET(nominalSendAt) ? nominalSendAt : nextSendWindowOpenET(nominalSendAt);
  if (now.getTime() - legalSendAt.getTime() > STAGING_STALE_MS) {
    await claimMetadata(conn, call, { status: 'skipped', reason: 'stale_at_staging', staged_at });
    return 'skipped';
  }
  // original_send_at is set ONCE here and never overwritten by a later
  // retry deferral (codex r2 P1): a retry re-queues with a NEW send_at (the
  // next attempt time), and measuring the 24h retry give-up against that
  // same, repeatedly-advancing field would let consecutive transient
  // failures push the deadline out indefinitely. This field is the one
  // fixed anchor every retry's own give-up check reads instead.
  await claimMetadata(conn, call, { status: 'pending', lead_id: leadId, send_at, original_send_at: send_at, staged_at });
  return 'pending';
}

// Only the FIRST writer for a given call may set this key — a concurrent
// stage tick (unlikely under the cron's single-instance lock, but cheap to
// guard) loses instead of overwriting a decision another tick already made.
//
// codex #5018 P2: `stage()`'s own SELECT already required processing_token
// IS NULL, v2_extraction_status = 'valid' and updated_at past the grace
// window — but stageOne makes several further awaits (resolveLeadLinkage,
// outboundStagingReason, more) before landing on any of the calls to this
// function, and a forced reprocess can claim processing_token (resetting
// v2_extraction_status and bumping updated_at) in that gap. Stamping a
// decision here after that lands would judge — and permanently record —
// half-rewritten extraction/lead-linkage state. Re-checking the SAME three
// facts the SELECT observed, exactly as read (`call.processing_token`,
// `call.v2_extraction_status`, `call.updated_at`), makes the UPDATE a
// no-op instead: `metadata->key` stays NULL, so this row is simply picked
// up again — quiet, on its own updated_at — by a later tick, the same as
// any other row a reprocess is still touching. Never a completed decision
// recorded against stale ownership.
async function claimMetadata(conn, call, value) {
  await conn('call_log').where({ id: call.id })
    .whereNull('processing_token')
    .where('v2_extraction_status', 'valid')
    .where('updated_at', call.updated_at)
    .whereRaw("metadata->:key IS NULL", { key: METADATA_KEY })
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
  // decided_at: when a call reached its final outcome, so the weekly check
  // reports it in that week rather than the week of the call. staged_at is
  // carried through every rewrite (retries, sends, dispatch skips replace the
  // whole entry), so the week a call was checked in never changes after
  // staging (codex #5358 r6 P2).
  const stagedAt = entry.staged_at || parseMetadata(call)[METADATA_KEY]?.staged_at;
  const kept = stagedAt ? { ...entry, staged_at: stagedAt } : entry;
  const stamped = entry.status === 'pending' ? kept : { ...kept, decided_at: new Date().toISOString() };
  await conn('call_log').where({ id: call.id }).update({ metadata: metadataPatch(conn, stamped), updated_at: new Date() });
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
async function bookedSinceCall(conn, customerId, since, leadPhone) {
  if (customerId) {
    const row = await conn('scheduled_services').where({ customer_id: customerId })
      .where('created_at', '>=', since).whereNotIn('status', ['cancelled']).first('id');
    if (row) return true;
  }
  // Unlinked-customer booking (codex #5018 r15 P2): staff quick-adding a
  // customer straight from the appointment modal, without ever linking
  // this lead, books a real visit the check above can never see — it has
  // no lead.customer_id to check at all (or, after a later correction,
  // points at a DIFFERENT record than whoever actually got booked).
  // Matched by the lead's own phone against the CUSTOMER's stored phone,
  // by canonical NANP identity, through the repo's shared SQL-side
  // matcher (nanpStoredPhoneClause, outbound-call-reason.js) — never a
  // hand-rolled regex. Several customers can share one phone (a couple, a
  // shared office line); any one of them booking after the call is
  // enough to skip — an EXISTS across every matching, non-deleted
  // customer, not a single lookup, since skipping the send is always the
  // safe direction.
  const phoneKey = phoneIdentityKey(leadPhone);
  if (!phoneKey || phoneKey.length !== 10) return false;
  const { nanpStoredPhoneClause } = require('./outbound-call-reason');
  const row = await conn('scheduled_services')
    .join('customers', 'customers.id', 'scheduled_services.customer_id')
    .whereNull('customers.deleted_at')
    .whereRaw(nanpStoredPhoneClause('customers.phone'), [phoneKey])
    .where('scheduled_services.created_at', '>=', since)
    .whereNotIn('scheduled_services.status', ['cancelled'])
    .first('scheduled_services.id');
  return !!row;
}

// codex P1 on #5292 (thread PRRT_kwDOR3YQi86m6KVg, line 729): the dedicated
// consent.sms_declined check above (STAGING_CHECKS) judges only THIS call's
// own extraction. A caller who explicitly declined texts on an EARLIER
// call, then makes a LATER eligible call where texting is never discussed
// again, extracts sms_declined: false ("never asked" on that one call) and
// would read as clear — the cross-call hold in auto-text-holds.js only
// searches do_not_contact_request, never sms_declined. So any call for this
// phone, at or before `asOf`, whose extraction recorded an explicit decline
// blocks this lane.
//
// OWNER RULING 2026-09-29: any past "no texts" blocks this text for good —
// a later opt-in never clears it. Letting a later opt-in supersede drew a
// fresh Codex P1 each round (the opt-in must be bound to the same number,
// then to the same consent scope, ...); this lane sends ~1–3 texts a month,
// so never re-texting a past decliner costs next to nothing and closes that
// class outright.
//
// Only a VALID V2 extraction counts — auto-text-holds.js's own do-not-
// contact probe deliberately also reads legacy/invalid rows for that flag,
// but a nuanced "did the caller actually decline or opt in" judgment is
// model work this lane trusts only from a schema-validated row, matching
// the dedicated sms_declined check's own valid-only posture. auto-text-
// holds.js's own callsWith is NOT reused here (CLAUDE.md rule 15 caveat):
// it takes no `asOf` bound, and this probe must never see a call that, from
// the point of view of the call under judgment, has not happened yet — the
// SAME nanpStoredPhoneClause matcher and non-sandbox modifier it uses are
// reused instead. originCallId is included the same way callsWith includes
// it: the call under judgment itself may carry the decisive statement even
// when its own from/to columns do not literally match `phone` (e.g. a
// spoken alternate number).
async function smsDeclinedOnEarlierCall(conn, phone, { originCallId, asOf } = {}) {
  const phoneKey = phoneIdentityKey(phone);
  if (!phoneKey || phoneKey.length !== 10) return false;
  const { nanpStoredPhoneClause } = require('./outbound-call-reason');
  const row = await conn('call_log')
    .modify((q) => require('./voice-agent/relay-protocol').whereNotSandboxCall(q))
    .where((q) => q.whereRaw(nanpStoredPhoneClause('from_phone'), [phoneKey])
      .orWhereRaw(nanpStoredPhoneClause('to_phone'), [phoneKey])
      // codex r5 P1: a decline can be about the number the caller SPOKE
      // ("call me at B, don't text it") — the same caller.phone_e164 that
      // consentedDestination uses for alternate destinations.
      .orWhereRaw(nanpStoredPhoneClause("(ai_extraction_enriched->'caller'->>'phone_e164')"), [phoneKey])
      .modify((either) => { if (originCallId) either.orWhere('id', originCallId); }))
    .where('v2_extraction_status', 'valid')
    .where('created_at', '<=', asOf)
    // An earlier call with no boolean sms_declined (absent before schema
    // 1.19.0, or a JSON null — ->> is SQL NULL for both): an explicit "no"
    // on it was recorded only as sms_consent_given false, indistinguishable
    // from never asked. Fail closed — such a call
    // counts as a possible decline (owner ruling 2026-09-29: any past "no"
    // blocks; this lane sends ~1–3 texts a month). The call under judgment
    // itself is exempt; its own missing field is sms_refusal_unrecorded at
    // staging.
    .where((q) => q.whereRaw("ai_extraction_enriched->'consent'->>'sms_declined' = 'true'")
      .orWhere((legacy) => legacy.whereRaw("(ai_extraction_enriched->'consent'->>'sms_declined') IS NULL")
        .modify((l) => { if (originCallId) l.whereNot('id', originCallId); })))
    .first('ai_extraction_enriched');
  if (!row) return false;
  const declined = extractionOf(row)?.consent?.sms_declined;
  return declined === true || typeof declined !== 'boolean';
}

// A short_codes row only proves a consultation link was MINTED — not sent.
// Virginia's manual composer (admin-leads.js POST /:id/consultation-link)
// mints one to prefill the composer and the operator can close it without
// ever clicking Send; the estimate-email consultation offer mints its own
// for an EMAIL, which never appears in sms_log at all (codex pre-push P1).
// Requiring the code to actually appear in an accepted outbound SMS is the
// same evidence-not-intent standard reschedule-link-promises' matchingSend
// applies to its own visit links.
//
// A lead can accumulate far more than a handful of minted codes — the manual
// composer mints one on every open, sent or not — so this used to cap the
// candidate codes at the 20 newest and check sms_log only for those. A lead
// with 21+ minted codes in the window could then hide an older code that WAS
// actually texted behind 20 newer opens that never sent, and we'd text the
// same person twice inside the 14-day window. Do it as one correlated EXISTS
// instead: every short_codes row for this lead is a candidate, with no count
// limit and no age bound of its own — the 14-day exclusion this function
// answers for is about when the SMS carrying the link went out, not when
// the code was minted (codex #5018 pre-push P1, round 4: a code minted 15
// days ago but manually texted 3 days ago, still a valid link, was
// invisible here when short_codes carried its own `since` filter, wrongly
// allowing an automated text inside the promised 14-day exclusion). Only
// sms_log's own filters (excludeUnresolvedSendReservations, direction,
// since, status) bound the window.
// windowMs (follow-up to codex #5018 r15 P2): defaults to this lane's own
// 14-day dedupe window. admin-leads.js and admin-communications.js pass
// MANUAL_SEND_RACE_GUARD_WINDOW_MS instead — a short race-only window — when
// reusing this same read as a post-lock manual-send guard; see that
// constant's own comment for why.
// matchPhone (codex #5196 P2): the manual guards ALSO pass the send's own
// current destination phone — scoping the sms_log match to THAT number
// (sms_log.to_phone, via the same nanpStoredPhoneClause matcher every other
// phone comparison in this file already uses), not merely the lead. Before
// this, the guard was lead-wide: a send to phone A, then a lead phone
// change to B, refused a legitimate send to the NEW number B for the same
// lead — the lead's own recent history at the OLD number blocked it. Never
// passed by this lane's own worker call (dispatchIneligibleReason, 14-day
// dedupe) — that stays lead-wide, unchanged: the worker's own concern is
// "has ANY current number for this lead already gotten this link," not one
// specific destination.
async function linkSentRecently(conn, leadId, now, { windowMs = LINK_SENT_RECENTLY_DEFAULT_WINDOW_MS, matchPhone = null } = {}) {
  const since = new Date(now.getTime() - windowMs);
  const matchPhoneKey = matchPhone ? phoneIdentityKey(matchPhone) : null;
  const { nanpStoredPhoneClause } = require('./outbound-call-reason');
  const applyPhoneScope = (query) => (matchPhoneKey && matchPhoneKey.length === 10
    ? query.whereRaw(nanpStoredPhoneClause('sms_log.to_phone'), [matchPhoneKey])
    : query);
  // codex #5196 P1/P2: durable pre-provider evidence from
  // CONSULTATION_ATTEMPT_TABLE (migration 20260928130000) — written by ALL
  // THREE consultation-link senders (this lane's own worker AND the manual
  // sends in admin-leads.js/admin-communications.js), on a SEPARATE,
  // immediately-committed connection (markerDb(), never `trx`) at each
  // sender's REAL attempt boundary — onDispatchStart, right before
  // messages.create() runs — so it exists regardless of whether the
  // sender's own handoff transaction later committed, rolled back, or is
  // still mid-recovery right now. Replaces the original P1-B fix's
  // HANDOFF_MARKER_TABLE-only join, which only ever protected THIS lane's
  // own attempt and left a manual send with no durable evidence a
  // competing sender could see (codex #5196 P1). A row for an attempt that
  // provably never reached Twilio does not linger here — it is deleted at
  // that refusal (onDispatchAbort) or at a definite send failure — so this
  // cannot mistake "never attempted" for "sent"; it can only ever
  // over-count a genuine attempt (success, crash-recovered ambiguous, or a
  // still-settling one) as "recently sent," the same safe-over-silent
  // direction every other check in this function already takes.
  //
  // Phone-scoped when matchPhone is given (codex #5196 P2) — the SAME
  // nanpStoredPhoneClause matcher applyPhoneScope uses on sms_log.to_phone
  // below, applied here to CONSULTATION_ATTEMPT_TABLE.to_phone, so an
  // attempt to phone A never blocks a manual send to a DIFFERENT phone B
  // for the same lead — the exact false refusal the old lead-wide handoff
  // join produced (a lead corrected from A to B within the manual-race
  // window still 409'd a legitimate send to B). Lead-wide (no matchPhone)
  // for this lane's own 14-day dedupe call, unchanged — that call's own
  // concern is "has ANY current number for this lead already gotten this
  // link," not one specific destination.
  const recentAttempt = await (matchPhoneKey && matchPhoneKey.length === 10
    ? conn(CONSULTATION_ATTEMPT_TABLE).whereRaw(nanpStoredPhoneClause('to_phone'), [matchPhoneKey])
    : conn(CONSULTATION_ATTEMPT_TABLE))
    .where('lead_id', leadId)
    .where('started_at', '>=', since)
    .first('id');
  if (recentAttempt) return true;
  // excludeUnresolvedSendReservations (codex r1 P2): 'sending' also covers
  // a pre-provider reply/review-ask RESERVATION row — a placeholder that
  // never reached Twilio, not delivery evidence. Every other caller of
  // this helper applies it before its own further .where()s.
  const recentOutbound = () => applyPhoneScope(excludeUnresolvedSendReservations(conn('sms_log'))
    .where('sms_log.direction', 'outbound')
    .where('sms_log.created_at', '>=', since)
    .whereIn('sms_log.status', ['queued', 'accepted', 'sending', 'sent', 'delivered', 'read']));
  const shortRow = await recentOutbound()
    .whereExists(
      conn('short_codes')
        .where('short_codes.kind', 'consultation')
        .where('short_codes.entity_type', 'leads')
        .where('short_codes.entity_id', leadId)
        .whereRaw("sms_log.message_body LIKE '%/l/' || short_codes.code || '%'"),
    )
    .first('sms_log.id');
  if (shortRow) return true;
  // codex #5018 P2: the check above only sees a SHORT /l/<code> bearer — a
  // manual composer send or a customer forwarding the resolved page URL can
  // carry the long-form /inspection/<token> instead, which never appears in
  // short_codes at all. Never hand-roll that token's signature parsing here
  // — composer-customer-links.js's own consultationLinkRows already
  // resolves both forms (short AND long) the SAME way its send-time
  // refusal check does; reused verbatim (CLAUDE.md rule 15). Only a
  // narrow, indexable LIKE '%/inspection/%' pre-filter reaches this slower
  // per-row decode, so an ordinary lead with no long-form send in its
  // window costs nothing beyond that filtered SELECT.
  const longFormCandidates = await recentOutbound()
    .where('sms_log.message_body', 'like', '%/inspection/%')
    .select('sms_log.message_body');
  if (!longFormCandidates.length) return false;
  const { consultationLinkRows } = require('./composer-customer-links');
  for (const { message_body } of longFormCandidates) {
    // codex #5018 pre-push P1 (this round): pass THIS caller's own `conn`
    // through, never letting consultationLinkRows fall back to a second
    // implicit pool checkout — neverSendRecheck can call this whole
    // function while its own phone-locked handoff already occupies one of
    // a constrained pool's connections, and a second checkout here could
    // time out under that constraint instead of landing on the connection
    // already held.
    const rows = await consultationLinkRows(message_body, conn);
    if (rows.some((row) => !row.invalid && String(row.lead_id) === String(leadId))) return true;
  }
  return false;
}

// codex #5018 P2: `leads.estimate_id` is only the FK RESCUED at send/view
// (see admin-estimates.js's own "Prefer the FK... fall back to the
// public-quote mirror" comment) — a quote-wizard draft the lead hasn't
// opened yet stores the link ONLY in estimates.estimate_data.lead_id
// (public-quote.js's own findPriorOpenWizardLeadId comment: "A wizard
// draft is mirrored through estimate_data.lead_id, not the FK"). Reusing
// admin-estimates.js's exact fallback shape, in the other direction (lead
// -> its estimate, not estimate -> its lead): the LATEST mirror row for
// this lead, judged open by the SAME OPEN_ESTIMATE_STATUSES + archived_at
// check public-quote.js's own live-courtship query applies. A priced
// draft the lead never opened still owns this lead's next step just as
// much as a sent one — this lane's free-consultation text is not it.
async function leadHasOpenEstimateMirror(conn, leadId) {
  if (!leadId) return false;
  const mirror = await conn('estimates')
    .whereRaw("estimate_data->>'lead_id' = ?", [String(leadId)])
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .first('archived_at', 'status');
  if (!mirror) return false;
  return mirror.archived_at == null && OPEN_ESTIMATE_STATUSES.includes(mirror.status);
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
  async ({ conn, lead, leadId }) => {
    if (lead.estimate_id) return 'estimate_linked';
    return (await leadHasOpenEstimateMirror(conn, leadId)) ? 'estimate_linked' : null;
  },
  ({ call, lead }) => (leadLinkedToExistingCustomer(call, lead) ? 'existing_customer' : null),
  ({ lead }) => (lead.is_commercial === true ? 'commercial_lead' : null),
  ({ lead }) => (!lead.phone || !isUsPhone(lead.phone) ? 'lead_phone_unusable' : null),
  async ({ conn, call }) => ((await outboundPriorContactMissing(conn, call)) ? 'outbound_without_prior_contact' : null),
  async ({ conn, call }) => ((await householdHoldOpen(conn, call)) ? 'household_hold' : null),
  async ({ conn, call, lead }) => {
    const callStart = callStartedAt(call) || new Date(call.created_at);
    return (await bookedSinceCall(conn, lead.customer_id, callStart, lead.phone)) ? 'booked_since_call' : null;
  },
  // codex P1 on #5292: a decline spoken on ANY earlier call for this same
  // phone (owner ruling 2026-09-29: never cleared). See smsDeclinedOnEarlierCall's
  // own doc comment.
  async ({ conn, call, lead, now }) => (
    (await smsDeclinedOnEarlierCall(conn, lead.phone, { originCallId: call.id, asOf: now })) ? 'sms_declined_earlier_call' : null),
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
// Table-driven, like DISPATCH_CHECKS/STAGING_CHECKS above (CLAUDE.md rule
// 20 — a complexity fix must remove decisions, not relocate them into
// one-use wrappers). Order matters and several entries populate `ctx` for
// the ones that follow — read each entry's own comment before reordering:
//   - ctx.lead is set by the FIRST entry and read by every entry after it.
//   - ctx.freshCall/ctx.freshEntry are set partway through and read by
//     every entry after THAT point.
// Each entry returns null (pass, keep going) or a verdict object
// ({ code } for a permanent block, or { code, retryable: true } for the
// one in-flight-reprocess case) — the runner below returns the first one.
const NEVER_SEND_RECHECK_STEPS = [
  // .forUpdate() (codex #5018 r12 P1): a plain SELECT let a phone
  // correction committed between this read and messages.create() go
  // unnoticed — admin-leads.js's own PATCH updates leads.phone under a
  // row lock (routes/admin-leads.js ~1155-1180: `trx('leads')…forUpdate()`
  // then `.update(...)`), and without a competing lock here that write
  // can land in the gap and this hook would still send to the phone it
  // read a moment earlier. Locking on dbi — the SAME connection the
  // phone-locked handoff (withSmsHandoff) already holds — makes that
  // writer wait until this whole handoff (through the SDK request)
  // finishes, exactly like the phone-consent lock already does for a
  // STOP. LOCK ORDER: lockSmsPhone (an advisory key, taken by
  // withSmsHandoff BEFORE this function ever runs) always precedes this
  // row lock — the same order lead-response-tools.js's own locked
  // handoff documents ("Booking and estimate acceptance hold this
  // advisory key before rows. Join their fence before either row
  // lock..." — resolveLeadSubject/withLockedLeadSubject). admin-leads.js
  // takes ONLY this row lock, never the phone key, so there is no
  // second writer that could take these two in the opposite order —
  // no inversion, no deadlock risk.
  async (ctx) => {
    ctx.lead = await ctx.dbi('leads').where({ id: ctx.leadId }).whereNull('deleted_at').forUpdate().first();
    return (!ctx.lead || !isOpenLeadRow(ctx.lead)) ? { code: 'lead_no_longer_open' } : null;
  },
  // An open household hold, re-read on the locked handoff's own connection (the office may have
  // opened one, or a reprocess may have filed it, after the dispatch-time check).
  async (ctx) => ((await householdHoldOpen(ctx.dbi, ctx.call)) ? { code: 'household_hold' } : null),
  (ctx) => (ctx.lead.estimate_id ? { code: 'estimate_linked' } : null),
  // codex #5018 P2: the FK alone misses a quote-wizard draft the lead
  // never opened (see leadHasOpenEstimateMirror's own doc comment) —
  // re-checked here too, on `dbi`, the freshest possible read, for the
  // same reason every other check on this hook repeats.
  async (ctx) => ((await leadHasOpenEstimateMirror(ctx.dbi, ctx.leadId)) ? { code: 'estimate_linked' } : null),
  // Re-verified on the freshest possible read, same reason as every
  // other check on this hook (codex #5018 r10 P2): dispatchIneligibleReason's
  // own check ran moments earlier, and either fact can change in the
  // gap between there and the actual provider request — a manual
  // merge into an existing customer, or a commercial flag correction.
  (ctx) => (leadLinkedToExistingCustomer(ctx.call, ctx.lead) ? { code: 'existing_customer' } : null),
  (ctx) => (ctx.lead.is_commercial === true ? { code: 'commercial_lead' } : null),
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
  (ctx) => (phoneIdentityKey(ctx.lead.phone) !== phoneIdentityKey(ctx.destinationPhone) ? { code: 'phone_changed_before_send' } : null),
  // Re-verified even though nothing between the earlier send-time check
  // and here can change the destination string itself (codex r5 P1) —
  // the same last-moment-before-the-provider-request discipline every
  // other check on this hook already follows. Against the STALE `call` —
  // the entry below re-verifies again, against the FRESH one.
  (ctx) => (!consentedDestination(ctx.call, extractionOf(ctx.call), ctx.destinationPhone) ? { code: 'destination_not_consented' } : null),
  // Reload + lock call_log too (codex #5018 r13 P1): everything above
  // re-verifies the LEAD, but a forced reprocess can claim
  // call_log.processing_token AFTER dispatchIneligibleReason ran and
  // rewrite the extraction or lead linkage while THIS handoff is
  // already in flight — the `call` this function closes over goes
  // stale the moment that claim lands, and the checks worth repeating
  // on a fresh read are readiness, lead linkage, and the extraction-
  // derived never-send predicates.
  //
  // LOCK ORDER: leads BEFORE call_log — taken in that order here too,
  // verified against the call processor's OWN established order for a
  // writer that locks both inside one transaction (never guessed, per
  // the review's own instruction):
  //   - call-recording-processor.js finalization, ~line 19477-19479:
  //     "Keep the established leads -> call_log lock order." —
  //     `if (liveLeadConversation) await trx('leads')…forUpdate()`
  //     runs BEFORE the `trx('call_log')…update(...)` that clears
  //     processing_token.
  //   - call-recording-processor.js's lead-stamp reconciliation,
  //     ~line 4334-4341: "[the lead lock is] acquired BEFORE the
  //     call_log clear so every stamp writer follows one lock order
  //     (leads → call_log) and two transactions can never deadlock."
  // Both sites are explicit and consistent: the established order is
  // leads THEN call_log — the opposite of "call_log then leads." This
  // function already takes the lead lock first (above); the call_log
  // lock below preserves that same relative order.
  //
  // Also checked (per the review's own instruction): the processor's
  // OWN processing_token CLAIM — server/services/call-recording-
  // processor.js:7946-8086 — runs inside a real `db.transaction()`,
  // never a bare autocommit UPDATE, but that transaction's own lock
  // set is `customers` (forUpdate, conditional on call.customer_id,
  // line 7948) THEN the `call_log` claim UPDATE itself (lines 7970 and
  // 8042) — it never touches `leads` at all (grepped its exact
  // extent). No shared pair of resources can be locked in opposite
  // orders by the claim and this handoff, so no deadlock risk between
  // them either.
  async (ctx) => {
    ctx.freshCall = await ctx.dbi('call_log').where({ id: ctx.call.id }).forUpdate().first();
    return ctx.freshCall ? null : { code: 'call_not_found' };
  },
  // An in-flight reprocess ('wait') is retryable, never a permanent
  // block — the same principle as dispatchClaimedCall's own pre-
  // handoff readiness check; any other truthy reason (the reprocess
  // already ended non-valid) is terminal, matching that check's own
  // non-wait branch.
  (ctx) => {
    ctx.freshEntry = parseMetadata(ctx.freshCall)[METADATA_KEY] || {};
    const readiness = sendReadiness(ctx.freshCall, ctx.freshEntry, new Date());
    if (readiness === 'wait') return { code: 'call_reprocessing', retryable: true };
    return readiness ? { code: readiness } : null;
  },
  // The lead linkage itself, re-derived exactly like staging did — an
  // attribution correction/merge landing in this same gap must skip
  // rather than send under a linkage this dispatch was never judged
  // against (mirrors dispatchClaimedCall's own pre-handoff check).
  async (ctx) => ((await resolveLeadId(ctx.dbi, ctx.freshCall)) !== ctx.leadId ? { code: 'lead_linkage_changed' } : null),
  // Every extraction-derived never-send predicate, re-run fresh —
  // stagingIneligibleReason's own last entry already folds in the
  // canonical merge (finalTriageFlagsFor: low_extraction_confidence,
  // address flags, caller_phone_missing, …), so a call a reprocess just
  // reclassified as low-confidence, commercial, unauthorized, or
  // explicitly non-consenting is caught here too, never reinvented.
  (ctx) => {
    const staleReason = stagingIneligibleReason(ctx.freshCall, extractionOf(ctx.freshCall), ctx.leadId);
    return staleReason ? { code: staleReason } : null;
  },
  // Re-verified against the FRESH extraction, not the stale `call` the
  // earlier entry above judged (codex #5018 r14 P1): a reprocess can
  // correct the spoken alternate number, or withdraw its explicit
  // sms_consent_given, between that earlier check and this hook's own
  // reload — stagingIneligibleReason judges the call's general
  // eligibility, never this narrower "is THIS destination number itself
  // consented" question. Sending on stale consent evidence would violate the
  // TCPA-consent-before-SMS invariant.
  (ctx) => (!consentedDestination(ctx.freshCall, extractionOf(ctx.freshCall), ctx.destinationPhone) ? { code: 'destination_not_consented' } : null),
  // Re-verified against the FRESH row (codex #5018 r15 P1):
  // stagingIneligibleReason's own table never re-derives outbound
  // eligibility — that lives entirely in outboundStagingReason, a
  // SEPARATE staging-only check dispatchIneligibleReason already ran
  // once against the (by-then already stale) call. The evidence itself
  // (a prior qualifying inbound call/text, or a non-call customer-
  // originated lead) can be reassigned to a DIFFERENT lead by a
  // concurrent merge/correction in the gap between that check and this
  // hook's own reload; re-deriving it fresh here closes that race the
  // same way every other check on this hook already does.
  // outboundPriorContactMissing itself already no-ops for an inbound
  // call (its own opening line). Passed `dbi` (codex #5018 pre-push
  // P1) — the SAME connection this handoff already holds — so its
  // probes never reach for a second pool slot; a genuine probe failure
  // now throws instead of being read as "missing," and lands in this
  // function's own catch below, which already treats an uncaught
  // throw here as a retryable infrastructure hiccup, never a
  // permanent block.
  async (ctx) => ((await outboundPriorContactMissing(ctx.dbi, ctx.freshCall)) ? { code: 'outbound_without_prior_contact' } : null),
  async (ctx) => {
    const callStart = callStartedAt(ctx.call) || new Date(ctx.call.created_at);
    return (await bookedSinceCall(ctx.dbi, ctx.lead.customer_id, callStart, ctx.lead.phone)) ? { code: 'booked_since_call' } : null;
  },
  // codex P1 on #5292: the send-time twin of the DISPATCH_CHECKS entry
  // above, on ctx.dbi under the held lock, so a refusal spoken on a call
  // that lands between dispatch and this actual provider request is still
  // seen. Checked against the ACTUAL send destination (ctx.destinationPhone),
  // not the lead's on-file phone dispatchIneligibleReason judged moments
  // earlier — the same "the real send target, not a stale record" standard
  // phone_changed_before_send and consentedDestination already apply here.
  async (ctx) => (
    (await smsDeclinedOnEarlierCall(ctx.dbi, ctx.destinationPhone, { originCallId: ctx.call.id, asOf: new Date() }))
      ? { code: 'sms_declined_earlier_call' } : null),
  async (ctx) => ((await linkSentRecently(ctx.dbi, ctx.leadId, new Date())) ? { code: 'link_sent_recently' } : null),
];

function neverSendRecheck(call, leadId, destinationPhone) {
  return async ({ dbi }) => {
    try {
      const ctx = { dbi, call, leadId, destinationPhone };
      for (const step of NEVER_SEND_RECHECK_STEPS) {
        const verdict = await step(ctx);
        if (verdict) return { ok: false, ...verdict };
      }
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

// Shared writer for all three consultation-link senders (codex #5196
// P1/P2 follow-up; migration 20260928130000). Runs on markerDb()'s own
// separate connection by default — from inside the sender's held handoff
// transaction, never the sender's own `trx` — or on a transaction already
// open on markerDb() when the caller needs it committed atomically with
// something else (the automated lane's own onDispatchStart below, which
// combines it with HANDOFF_MARKER_TABLE's insert). Returns the new row's
// id so onDispatchAbort/a definite-failure cleanup can delete exactly
// this attempt, never a sibling one.
async function insertConsultationLinkAttempt({ leadId, toPhone, source, callLogId = null }, conn = markerDb()) {
  const inserted = await conn(CONSULTATION_ATTEMPT_TABLE)
    .insert({ lead_id: leadId, to_phone: toPhone, source, call_log_id: callLogId, started_at: new Date() })
    .returning('id');
  return inserted?.[0]?.id ?? inserted?.[0] ?? null;
}

// Best-effort delete by row id — every consultation-link sender's own
// onDispatchAbort, and a DEFINITE post-send failure (not a real provider
// send, not an ambiguous outcome — isRealProviderSend/
// isAmbiguousProviderOutcome), calls this. A cleanup failure just leaves
// the row for linkSentRecently to over-count — the same safe-over-silent
// direction as this lane's own handoff-marker cleanup.
async function deleteConsultationLinkAttempt(attemptId) {
  if (attemptId == null) return;
  try {
    await markerDb()(CONSULTATION_ATTEMPT_TABLE).where({ id: attemptId }).del();
  } catch (err) {
    logger.warn(`[call-booking-link-text] consultation-link attempt cleanup failed for id ${attemptId} (${err.code || err.name || 'error'})`);
  }
}

/**
 * Send-time re-check + dispatch for ONE already-claimed call. Re-derives
 * every "never" condition from fresh rows — nothing here trusts the
 * decision stage() made when it staged this call.
 */
async function dispatchClaimedCall(conn, call, now) {
  const entry = parseMetadata(call)[METADATA_KEY] || {};
  const leadId = entry.lead_id;
  const skip = async (reason, extra = {}) => {
    await recordDecision(conn, call, { status: 'skipped', reason, lead_id: leadId, send_at: entry.send_at, ...extra });
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
  if (pastRetryDeadline(entry, now)) return skip('send_retry_timeout', { failed: true });
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

  // The handoff marker (call_booking_link_text_handoffs, codex #5018 r13
  // P1 — moved off call_log.metadata's own handoff_started_at field) is
  // written via onDispatchStart (codex #5018 r15 P1 — moved OFF
  // providerPreSendCheck/neverSendRecheck itself), invoked by twilio.js at
  // the REAL attempt boundary: immediately before dispatchStarted flips
  // true and messages.create() runs, AFTER providerPreSendCheck's own
  // refusal path AND disclaimedNumberBlocksSend/preSendCheck.isStillValid
  // have all cleared. Marking inside providerPreSendCheck left exactly
  // that gap uncovered — a disclaimed-number hold or a closed send window
  // committing between neverSendRecheck returning ok and messages.create()
  // would have left a marker (and an 'ambiguous', never-resent status) for
  // an SMS that was never actually attempted.
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
    // ON CONFLICT DO NOTHING: this can in principle run more than once for
    // the same call_log_id across retries of the SAME claimed row (a claim
    // is per-dispatch-tick, not per-call) — the FIRST attempt's timestamp
    // is the one that matters; never overwritten.
    //
    // codex #5196 P1: the shared consultation_link_send_attempts row
    // (CONSULTATION_ATTEMPT_TABLE — see its own doc comment for why every
    // sender writes it, not only this lane) is inserted in the SAME
    // markerDb() transaction as the handoff marker, so a failed write can
    // never leave one without the other.
    onDispatchStart: () => markerDb().transaction(async (mtrx) => {
      await mtrx(HANDOFF_MARKER_TABLE)
        .insert({ call_log_id: call.id, handoff_started_at: new Date() }).onConflict('call_log_id').ignore();
      await insertConsultationLinkAttempt(
        { leadId, toPhone: destinationPhone, source: 'call_booking_link_text', callLogId: call.id },
        mtrx,
      );
    }),
    // codex #5018 r15 pre-push P1: onDispatchStart's own INSERT is a real
    // await, real wall-clock time that can itself carry the send window's
    // close boundary the last isStillValid() check ran before it. When
    // twilio.js's OWN recheck right after that await refuses for exactly
    // that reason, it calls this to remove the marker just written — the
    // attempt never reached dispatchStarted/messages.create() at all, so
    // recoverAbandonedClaim must see NO marker here, not a permanent
    // "ambiguous, never resent" for a send that was provably never
    // attempted. Clears BOTH tables (codex #5196), in the same transaction.
    onDispatchAbort: () => markerDb().transaction(async (mtrx) => {
      await mtrx(HANDOFF_MARKER_TABLE).where({ call_log_id: call.id }).del();
      await mtrx(CONSULTATION_ATTEMPT_TABLE).where({ call_log_id: call.id }).del();
    }),
    // codex #5196 r4 P2: a definitive Twilio rejection inside
    // messages.create() fires this INSTEAD of onDispatchAbort, still
    // inside the handoff — lockSmsPhone is held. Same clearDispatchMarkers
    // the post-return path already uses as a backstop.
    onDispatchRejected: () => clearDispatchMarkers(call),
    // codex #5018 structural fix (post-r7): opts INTO twilio.js's in-
    // transaction sms_log insert. This lane's own withSmsHandoff below
    // already takes lockCustomerComms for every candidate customer id
    // BEFORE lockSmsPhone — the insert's customer_id FK KEY SHARE lock on
    // `customers` lands on a customer this handoff has already locked, so
    // it cannot invert against anything this transaction itself acquires.
    // Opting in is what lets linkSentRecently (this lane's own dedupe read)
    // see the evidence before the phone lock releases — the ONE reader
    // this in-transaction write exists for.
    logInHandoff: true,
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
      // codex #5018 pre-push P2 (round 2 finding): customer-comms BEFORE
      // the phone lock — the established order every withSmsConsentLock
      // caller uses (utils/customer-comms-lock.js: lockCustomerComms, then
      // lockSmsPhone). Taking phone first, as this handoff used to, can
      // deadlock against ANY of those callers for a customer that also
      // owns this exact phone: that caller holds comms(customer) and wants
      // phone(this number), while this handoff holds phone(this number)
      // and wants comms(customer) — a genuine two-resource cycle. Separate
      // advisory-lock namespaces (lockSmsPhone's two-key family vs
      // lockCustomerComms's single-key family) only guarantee the two
      // locks are never the SAME lock; they do nothing to prevent this
      // kind of opposite-order cycle between two DIFFERENT locks.
      //
      // Locks every customer neverSendRecheck's own bookedSinceCall call
      // will consider — the lead's own call-created customer id, plus
      // every customer matched by this exact phone via nanpStoredPhoneClause
      // — so a booking writer for any of them (admin-schedule.js's booking
      // route: occupancy lock, then customer-comms, then the customer row
      // lock, then the scheduled_services insert — never touches leads/
      // call_log; admin-leads.js's own lead-conversion booking flow, which
      // documents "take the comms advisory lock FIRST... a lead row lock
      // taken before it could deadlock" and then locks the very lead this
      // handoff holds) genuinely blocks until this handoff finishes,
      // instead of committing a booking in the gap between
      // bookedSinceCall's SELECT and the actual provider request.
      //
      // codex #5018 P2: the estimate-automation duplicate lock (services/
      // estimate-automation-duplicates.js), keyed on this SAME destination
      // phone — public-quote.js's own quote-wizard estimate insert
      // (withAutomatedEstimatePhoneLock, contactPhone) takes it around
      // exactly the write leadHasOpenEstimateMirror's own recheck below
      // reads, so acquiring it here first makes that recheck wait for an
      // in-flight wizard insert to finish rather than racing it — the same
      // "resolve → lock → re-resolve" idiom this file already documents.
      //
      // LOCK ORDER: acquired FIRST, before lockCustomerComms/lockSmsPhone
      // below — not after. This is a THIRD advisory-lock family (its own
      // hashtext namespaces, 'estimate_automation_duplicate'/'_customer',
      // never colliding with lockSmsPhone's 'twilio_21610' two-key lock or
      // lockCustomerComms's single-key one), so ordering it relative to
      // those two is a free choice UNLESS some other caller combines it
      // with either — and one already does: lead-response-tools.js's
      // flag_for_estimate tool wraps withAutomatedEstimatePhoneLock
      // AROUND resolveLeadSubject(..., lock: true), whose own body takes
      // lockCustomerComms (then the customers/leads row locks) INSIDE that
      // callback — i.e., automated-estimate-lock, THEN comms. Taking comms
      // first here, as this handoff already does for its own phone lock
      // below, would invert that: this handoff holds comms(customer) and
      // wants the estimate lock, while flag_for_estimate holds the
      // estimate lock and wants comms(that same customer) — the identical
      // two-resource cycle shape the phone-vs-comms comment right below
      // this one already explains. Matching flag_for_estimate's established
      // order (estimate lock before comms) instead closes it.
      const { acquireAutomatedEstimateLocks } = require('./estimate-automation-duplicates');
      await acquireAutomatedEstimateLocks(trx, destinationPhone);
      // created_customer_id is closure-stable — no speculative read needed:
      // leadLinkedToExistingCustomer (inside neverSendRecheck) refuses
      // whenever lead.customer_id is truthy and differs from
      // call.metadata.created_customer_id, so the ONLY value lead.customer_id
      // can hold by the time bookedSinceCall actually runs is either null or
      // exactly that id. The PHONE-MATCH source below is NOT: it is a live
      // SELECT against `customers`, and a customer minted for this exact
      // destinationPhone AFTER this read but before the re-check just below
      // would never be locked at all — see that re-check's own comment
      // (codex #5018 r15/r16 P1 follow-up).
      //
      // codex #5196 P1-A: /customers/quick-add, the admin "Add customer"
      // form (POST /api/admin/customers/), and the Intelligence Bar's
      // create_customer tool now take THIS SAME lockSmsPhone key/namespace
      // as the first statement of their own insert transaction (before
      // their own duplicate/phone lookup) — see routes/admin-customers.js
      // ensureCustomerAccount's lockPhone comment. Any of those three
      // creating a customer for destinationPhone now BLOCKS until this
      // handoff's transaction commits or rolls back, so they can no longer
      // land invisibly in the gap this re-resolve exists to catch. Not
      // every creator is fenced this way, though — admin-leads.js's own
      // lead-conversion path deliberately does NOT take this lock (would
      // invert lock order against its own occupancy/leads-row locks; see
      // its own comment) beyond the same-lead case its leads-row FOR UPDATE
      // already serializes, and neither the call-recording-processor's
      // automatic call-answered mint nor the public self-service creation
      // paths (booking.js, public-quote.js, estimate-public.js,
      // lead-webhook.js) take it at all. The re-resolve below stays as the
      // backstop for exactly those un-fenced writers — it is NOT
      // superseded, only narrowed.
      const candidateCustomerIds = new Set();
      const createdCustomerId = parseMetadata(call).created_customer_id;
      if (createdCustomerId) candidateCustomerIds.add(String(createdCustomerId));
      const phoneKey = phoneIdentityKey(destinationPhone);
      const { nanpStoredPhoneClause } = require('./outbound-call-reason');
      const phoneMatchedCustomerIds = async () => {
        if (!phoneKey || phoneKey.length !== 10) return [];
        return trx('customers').whereNull('deleted_at')
          .whereRaw(nanpStoredPhoneClause('phone'), [phoneKey]).pluck('id');
      };
      for (const id of await phoneMatchedCustomerIds()) candidateCustomerIds.add(String(id));
      for (const id of [...candidateCustomerIds].sort()) {
        await lockCustomerComms(trx, id);
      }
      await lockSmsPhone(trx, destinationPhone);
      // codex #5018 r15/r16 P1 follow-up (narrowed by codex #5196 P1-A —
      // see the comment above candidateCustomerIds): candidateCustomerIds'
      // phone-match half was read BEFORE any lockCustomerComms call above —
      // a customer minted for this SAME destinationPhone by a writer that
      // does NOT take lockSmsPhone (see that comment for the current list)
      // in the gap between that read and this handoff's own locks is not
      // among them, so a booking committed for it between bookedSinceCall's
      // own read (inside neverSendRecheck, below, on this same `trx`) and
      // the actual provider request is never fenced by this handoff at all
      // — exactly the race lockCustomerComms exists to close. Re-resolve the SAME
      // phone-match query now that every lock above is held: a newly
      // visible id proves the candidate set changed between the two reads.
      // It cannot simply be locked NOW — LOCK ORDER above requires comms
      // BEFORE lockSmsPhone, already taken, and acquiring comms after phone
      // here would invert that order against every OTHER lockCustomerComms
      // caller (the exact two-resource cycle the comment above lockSmsPhone
      // explains) — so this bails out through the ordinary retryable rail
      // instead of the send. recordSendOutcome requeues it, and the next
      // sweep tick re-resolves the full candidate set from scratch under
      // its own fresh locks — never a send to a customer this handoff never
      // actually fenced.
      const freshPhoneMatchedIds = await phoneMatchedCustomerIds();
      const widenedCandidateSet = freshPhoneMatchedIds.some((id) => !candidateCustomerIds.has(String(id)));
      if (widenedCandidateSet) {
        logger.warn(`[call-booking-link-text] candidate customer set widened under lock for call ${call.id} — deferring to the next sweep`);
        return {
          ok: false,
          code: 'candidate_customer_set_changed',
          reason: 'A new customer matched this destination phone after the initial lock snapshot',
          retryable: true,
        };
      }
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
// Send-outcome kinds recordSendOutcome branches on, normalized out of
// send-customer-message.js's own outcome shape (CLAUDE.md rule 20 — this
// classifier removes the compound sent/isRealProviderSend, isAmbiguous, and
// retryable-or-deferred conditions from recordSendOutcome's own body,
// leaving it exactly one branch per kind, each delegated to its own small
// handler below). Order matters, same as the original if-chain: a real
// provider send wins outright, then an ambiguous outcome, then a retryable
// one — anything left over is a definite block.
function classifySendOutcomeKind(result) {
  if (result.sent && isRealProviderSend(result)) return 'sent';
  if (isAmbiguousProviderOutcome(result)) return 'ambiguous';
  if (result.retryable || result.deferred) return 'retryable';
  return 'blocked';
}

async function recordSentDecision(conn, call, entry, leadId, now, result) {
  await recordDecision(conn, call, {
    status: 'sent', lead_id: leadId, send_at: entry.send_at, sent_at: now.toISOString(), provider_message_id: result.providerMessageId,
  });
  return { sent: true, providerMessageId: result.providerMessageId };
}

// Leave the row 'claimed' — a definitive outcome is not known yet and a
// second claim attempt would risk a duplicate text. This mirrors the
// reschedule-link-promises lane's own delivery-uncertain handling; a
// human can always resolve it by hand if it never settles.
function recordAmbiguousDecision(call) {
  logger.warn(`[call-booking-link-text] ambiguous provider outcome for call ${call.id} — leaving claimed`);
  return { sent: false, skipped: 'ambiguous_provider_outcome', ambiguous: true };
}

// codex #5018 pre-push P1 (round 3) / codex #5196 pre-push P1 (Claude
// fallback audit, round 2): a definite, non-ambiguous outcome — retryable
// (e.g. Twilio's own 429/20429 rate limit) OR an outright non-retryable
// block (e.g. Twilio's own terminal 21211/21610/21614 rejection,
// classifyProviderFailure's retryable:false) — can both arrive AFTER
// onDispatchStart already wrote both marker tables. Reaching either
// caller (never the ambiguous kind, handled above both) means send-
// customer-message.js/twilio.js have ALREADY determined this exact
// attempt did NOT reach an ambiguous state, so a marker from it is safe —
// and necessary — to clear. Left in place: a LATER retry that crashes or
// throws before ever reaching Twilio again would find the stale handoff
// marker and recoverAbandonedClaim would misclassify it 'ambiguous, never
// resend' for a follow-up that in fact never sent at all; and the stale
// consultation_link_send_attempts row would wrongly 409 a manual resend
// for MANUAL_SEND_RACE_GUARD_WINDOW_MS and wrongly block this lane's own
// next attempt for LINK_SENT_RECENTLY_DEFAULT_WINDOW_MS — neither
// reflecting a link that was ever delivered. A DELETE for a call_log_id
// that was never written (onDispatchStart never ran) is a harmless no-op,
// so this runs unconditionally rather than tracking whether dispatch
// actually started. Best-effort: a cleanup failure just leaves the stale
// markers for that same (already-handled) misclassification, never a
// duplicate send.
async function clearDispatchMarkers(call) {
  try {
    await markerDb().transaction(async (mtrx) => {
      await mtrx(HANDOFF_MARKER_TABLE).where({ call_log_id: call.id }).del();
      await mtrx(CONSULTATION_ATTEMPT_TABLE).where({ call_log_id: call.id }).del();
    });
  } catch (markerErr) {
    logger.warn(`[call-booking-link-text] stale handoff marker cleanup failed for call ${call.id} (${markerErr.code || markerErr.name || 'error'})`);
  }
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
async function recordRetryableDecision(conn, call, entry, leadId, now, result, skip) {
  // codex round-3 P2: clear BEFORE the deadline exit too — this outcome is
  // still a definite no-send (retryable), so the deadline branch is a
  // terminal skip, not a reason to leave the marker rows as if it sent.
  if (pastRetryDeadline(entry, now)) {
    await clearDispatchMarkers(call);
    return skip(result.code || result.reason || 'send_retry_timeout', { failed: true });
  }
  await clearDispatchMarkers(call);
  const rawNextAllowedAt = result.nextAllowedAt ? new Date(result.nextAllowedAt) : null;
  const nextAllowedAtValid = rawNextAllowedAt && !Number.isNaN(rawNextAllowedAt.getTime());
  const send_at = (nextAllowedAtValid ? rawNextAllowedAt : new Date(now.getTime() + RETRY_BACKOFF_MS)).toISOString();
  // original_send_at carries forward UNCHANGED through every deferral —
  // it is the fixed anchor pastRetryDeadline reads, never the advancing
  // send_at (codex r2 P1).
  await recordDecision(conn, call, { status: 'pending', lead_id: leadId, send_at, original_send_at: entry.original_send_at || entry.send_at }, { logActivity: false });
  return { sent: false, skipped: result.code || result.reason || 'send_retryable', deferred: true };
}

// The refusals a working lane is EXPECTED to hit: the person opted out, is
// suppressed or on do-not-call, has no consent, the number cannot take a
// text, or a customer hold applies. Any other outcome that reaches the
// blocked branch — a provider rejection, or a blocked result from the
// pipeline itself (CONTRACT_VIOLATION, UNKNOWN_POLICY, a failed lookup) —
// is a lane failure the weekly check must surface (codex #5358 r3 P1).
// Listing the healthy codes, not the broken ones, means a new pipeline code
// fails loud instead of reading as a normal skip.
const EXPECTED_REFUSAL_CODES = new Set([
  'SMS_OPTED_OUT', 'PURPOSE_OPTED_OUT', 'SUPPRESSED_OPT_OUT', 'SUPPRESSED_WRONG_NUMBER',
  'SUPPRESSED_MANUAL_DNC', 'SUPPRESSED_NON_MOBILE', 'SUPPRESSED_OTHER', 'DNC_SUPPRESSED',
  'DELIVERY_SUPPRESSED', 'NON_MOBILE_SMS_RECIPIENT', 'NO_CONSENT_RECORD', 'NO_MARKETING_CONSENT',
  'REASSIGNED_NUMBER_RISK', 'IDENTITY_TRUST_TOO_LOW', 'CHANNEL_EMAIL_ONLY', 'MOVE_HOLD',
  'CALLBACK_NUMBER_HOLD', 'QUIET_HOURS_HOLD',
]);

// Twilio's own recipient-side rejections (unsubscribed 21610, non-mobile
// 21614, invalid or unroutable number) come back as a provider failure with
// providerErrorCode and no `blocked`; they are about the number, not the
// lane (codex #5358 r5 P2).
function isRecipientProviderRefusal(result) {
  const { RECIPIENT_TERMINAL_TWILIO_CODES } = require('./messaging/providers/twilio-sms');
  return result.providerErrorCode != null && (RECIPIENT_TERMINAL_TWILIO_CODES || []).includes(String(result.providerErrorCode));
}

function isExpectedRefusal(result) {
  return (result.blocked === true && EXPECTED_REFUSAL_CODES.has(result.code)) || isRecipientProviderRefusal(result);
}

function blockedOutcomeReason(result) {
  if (result.blocked) return result.code || result.reason || 'policy_block';
  return result.code || result.reason || 'provider_failed';
}

async function recordSendOutcome(conn, call, entry, leadId, now, result) {
  const skip = async (reason, extra = {}) => {
    await recordDecision(conn, call, { status: 'skipped', reason, lead_id: leadId, send_at: entry.send_at, ...extra });
    return { sent: false, skipped: reason };
  };
  const kind = classifySendOutcomeKind(result);
  if (kind === 'sent') return recordSentDecision(conn, call, entry, leadId, now, result);
  if (kind === 'ambiguous') return recordAmbiguousDecision(call);
  if (kind === 'retryable') return recordRetryableDecision(conn, call, entry, leadId, now, result, skip);
  // codex #5196 pre-push P1 (Claude fallback audit, round 2): an outright
  // non-retryable block reaches this branch too, and can arrive just as
  // easily AFTER onDispatchStart already wrote both marker tables (a
  // Twilio terminal rejection, not merely a pre-dispatch policy refusal) —
  // see clearDispatchMarkers' own doc comment for why this is unconditional.
  await clearDispatchMarkers(call);
  // An expected refusal (opt-out, suppression, no consent) is a correct
  // skip; anything else is a failure. `failed` lets the weekly check tell
  // the two apart without knowing every code.
  return skip(blockedOutcomeReason(result), isExpectedRefusal(result) ? {} : { failed: true });
}

// A 'claimed' row a whole sweep tick failed to bring to a terminal status
// itself (codex r3 P2) — either THIS process just saw dispatchClaimedCall
// throw (sweep()'s own catch, immediately), or a LATER, possibly different,
// process finds a row still 'claimed' well past when any single tick's
// synchronous claim-then-dispatch could still legitimately be in flight
// (staleClaimRecovery below, after STALE_CLAIM_MS — the previous worker
// most likely died mid-dispatch and never got to run any catch at all).
// Both callers share this one decision: a row in call_booking_link_text_
// handoffs (written via onDispatchStart — twilio.js's own REAL attempt
// boundary, immediately before dispatchStarted flips true and
// messages.create() runs; see dispatchClaimedCall's own doc comment;
// migration 20260927160000, codex #5018 r13/r15 P1 — moved off call_log.
// metadata's own handoff_started_at field, which would have deadlocked
// against that same row's now-held FOR UPDATE lock, and OUT of
// providerPreSendCheck/neverSendRecheck itself, which still has real
// refusal paths — disclaimedNumberBlocksSend, the send-window recheck —
// ahead of it) is the ONE fact that says whether resending is safe.
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
  // Read via `conn` (never markerDb() — this always runs AFTER the handoff
  // transaction that might have written this row has already settled, so
  // there is no row lock left to contend with; codex #5018 r13 P1).
  const handoff = await conn(HANDOFF_MARKER_TABLE).where({ call_log_id: call.id }).first('call_log_id');
  if (handoff) {
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
    .modify((q) => require('./voice-agent/relay-protocol').whereNotSandboxCall(q)) // a sandbox test call is never texted
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

// Housekeeping for the handoff marker table (codex #5018 r13 P1): every
// row here has already resolved through recoverAbandonedClaim/
// recoverStaleClaims (both bounded well under a day) long before it turns
// HANDOFF_MARKER_RETENTION_MS old, so it is never read again — one bounded
// DELETE, capped at DISPATCH_BATCH rows per call like every other bounded
// operation in this lane, via the same subquery-limit shape (DELETE has no
// direct LIMIT in Postgres). A named function, not inlined into sweep(),
// so it can be exercised directly against a real Postgres connection —
// sweep() itself is gate-guarded and cannot be driven from a test that
// does not also mock feature-gates.
async function pruneHandoffMarkers(conn, now) {
  const stale = conn(HANDOFF_MARKER_TABLE)
    .where('handoff_started_at', '<', new Date(now.getTime() - HANDOFF_MARKER_RETENTION_MS))
    .limit(DISPATCH_BATCH).select('call_log_id');
  return conn(HANDOFF_MARKER_TABLE).whereIn('call_log_id', stale).del();
}

// Housekeeping for CONSULTATION_ATTEMPT_TABLE (codex #5196), same shape as
// pruneHandoffMarkers above. CONSULTATION_ATTEMPT_RETENTION_MS (15 days)
// is deliberately longer than LINK_SENT_RECENTLY_DEFAULT_WINDOW_MS (14
// days) — a row is never pruned while a dedupe read could still consult
// it, across all three consultation-link senders, not only this lane's
// own bounded recovery paths.
async function pruneConsultationLinkAttempts(conn, now) {
  const stale = conn(CONSULTATION_ATTEMPT_TABLE)
    .where('started_at', '<', new Date(now.getTime() - CONSULTATION_ATTEMPT_RETENTION_MS))
    .limit(DISPATCH_BATCH).select('id');
  return conn(CONSULTATION_ATTEMPT_TABLE).whereIn('id', stale).del();
}

// One row's claim → dispatch → per-row-failure-recovery attempt, split out
// of sweep()'s own dispatch loop (CLAUDE.md rule 20 — a genuinely separate
// phase, not a relocated fragment): never throws — a genuine per-row
// failure is exactly what recoverAbandonedClaim exists to resolve, and
// either way this returns how the attempt should count toward the caller's
// own sent/dispatchSkipped totals.
async function dispatchDueRow(conn, row, now) {
  try {
    const claimed = await claimForDispatch(conn, row.id);
    if (!claimed) return { sent: 0, dispatchSkipped: 0 };
    const call = await conn('call_log').where({ id: row.id }).first();
    const result = await dispatchClaimedCall(conn, call, now);
    if (result.sent) return { sent: 1, dispatchSkipped: 0 };
    return { sent: 0, dispatchSkipped: (result.ambiguous || result.deferred) ? 0 : 1 };
  } catch (err) {
    logger.warn(`[call-booking-link-text] dispatch failed for call ${row.id} (${err.code || err.name || 'error'})`);
    // A row left 'claimed' after a genuine failure would never be
    // revisited by the 'pending'-only query above, so it must reach a
    // terminal status here — but NEVER a blind worker_error the way this
    // used to (codex r3 P2): recoverAbandonedClaim reads the handoff
    // marker table (codex #5018 r13 P1) to decide whether the provider
    // might already have this exact attempt (never resend) or whether
    // it is safe to requeue through the ordinary retry rail instead of
    // giving up outright on a failure that never reached Twilio at all.
    const failedCall = await conn('call_log').where({ id: row.id }).first().catch(() => null);
    const outcome = failedCall ? await recoverAbandonedClaim(conn, failedCall, now).catch(() => null) : null;
    return { sent: 0, dispatchSkipped: (outcome && outcome.ambiguous) ? 0 : 1 };
  }
}

// Claims and dispatches every row currently due — its own phase, split out
// of sweep() for the same reason as dispatchDueRow above.
async function dispatchDueCalls(conn, now) {
  const due = await conn('call_log')
    .modify((q) => require('./voice-agent/relay-protocol').whereNotSandboxCall(q)) // a sandbox test call is never texted
    .where('created_at', '>=', new Date(now.getTime() - QUEUE_SCAN_LOOKBACK_MS))
    .whereRaw("metadata->:key->>'status' = 'pending'", { key: METADATA_KEY })
    .whereRaw("(metadata->:key->>'send_at')::timestamptz <= :now", { key: METADATA_KEY, now })
    .orderBy('created_at', 'asc').limit(DISPATCH_BATCH).select('id');
  let sent = 0;
  let dispatchSkipped = 0;
  for (const row of due) {
    const counted = await dispatchDueRow(conn, row, now);
    sent += counted.sent;
    dispatchSkipped += counted.dispatchSkipped;
  }
  return { sent, dispatchSkipped };
}

async function sweep(conn = db, { now = new Date() } = {}) {
  if (!isEnabled(GATE)) {
    // codex round-3 P2: the two manual routes (admin-leads.js, admin-
    // communications.js) insert successful consultation_link_send_attempts
    // rows regardless of this gate, so pruning them must not depend on it
    // either or the table grows unbounded while the feature is dark. Never
    // stage, claim or send while the gate is off — this is housekeeping
    // only.
    try {
      await pruneConsultationLinkAttempts(conn, now);
    } catch (err) {
      logger.warn(`[call-booking-link-text] consultation-link attempt housekeeping failed while gate is off (${err.code || err.name || 'error'})`);
    }
    return { staged: 0, ineligible: 0, sent: 0, dispatchSkipped: 0 };
  }
  const { staged, ineligible } = await stage(conn, { now });
  const { sent, dispatchSkipped } = await dispatchDueCalls(conn, now);
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
  // Housekeeping (codex #5018 r13 P1): every row here has already resolved
  // through recoverAbandonedClaim/recoverStaleClaims (both bounded well
  // under a day) long before it turns 7 days old, so it is never read
  // again.
  try {
    await pruneHandoffMarkers(conn, now);
  } catch (err) {
    logger.warn(`[call-booking-link-text] handoff marker housekeeping failed (${err.code || err.name || 'error'})`);
  }
  // Same housekeeping for CONSULTATION_ATTEMPT_TABLE (codex #5196) — every
  // row here has resolved (through this lane's own recovery paths, or a
  // manual sender's own onDispatchAbort/definite-failure cleanup) long
  // before it turns CONSULTATION_ATTEMPT_RETENTION_MS old.
  try {
    await pruneConsultationLinkAttempts(conn, now);
  } catch (err) {
    logger.warn(`[call-booking-link-text] consultation-link attempt housekeeping failed (${err.code || err.name || 'error'})`);
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
  DISPATCH_BATCH,
  HANDOFF_MARKER_TABLE,
  HANDOFF_MARKER_RETENTION_MS,
  pruneHandoffMarkers,
  // consultation_link_send_attempts (codex #5196 P1/P2 follow-up, migration
  // 20260928130000): insertConsultationLinkAttempt/deleteConsultationLinkAttempt
  // are reused directly by admin-leads.js and admin-communications.js's
  // manual sends, the same way linkSentRecently already is — real
  // cross-module callers, not test-only reach-ins.
  CONSULTATION_ATTEMPT_TABLE,
  CONSULTATION_ATTEMPT_RETENTION_MS,
  insertConsultationLinkAttempt,
  deleteConsultationLinkAttempt,
  pruneConsultationLinkAttempts,
  sweep,
  // linkSentRecently + its manual-send race-guard window: reused directly by
  // admin-leads.js and admin-communications.js (see
  // MANUAL_SEND_RACE_GUARD_WINDOW_MS's own comment) — exported properly
  // rather than through _private since these are now real cross-module
  // callers, not test-only reach-ins.
  linkSentRecently,
  LINK_SENT_RECENTLY_DEFAULT_WINDOW_MS,
  MANUAL_SEND_RACE_GUARD_WINDOW_MS,
  // recordRetryableDecision (round-3 P2 follow-up): the pastRetryDeadline
  // early-return's own marker cleanup is otherwise unreachable through
  // dispatchClaimedCall alone (its own pre-send deadline check already
  // gates the identical (entry, now) pair) — a direct reach-in test-only
  // export, same convention as the rest of this bag.
  _private: { isExpectedRefusal, recordDecision,
    leadIdOf, extractionOf, parseMetadata, bookedSinceCall, linkSentRecently, recordRetryableDecision, smsDeclinedOnEarlierCall,
  },
};
