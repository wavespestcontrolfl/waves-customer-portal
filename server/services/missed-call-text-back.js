/**
 * Missed-call text-back — an UNKNOWN caller (no customer record on file)
 * calls a Waves line, nobody answers, they wait 25s+ (the missed-call
 * bell's own floor) and hang up with no voicemail: text them ONE reply from
 * the exact line they called.
 *
 * Owner rulings 2026-09-26: unknown callers only (a customer record at any
 * pipeline stage, lead stages included, rings the missed-call bell
 * instead); brand reads "Waves" only (never "Waves Pest Control"); NO
 * "Reply STOP to opt out." line ("they called us" —
 * docs/sms-stop-line-policy.md's deliberate-exceptions section); no
 * sign-off/signature.
 *
 * Owner ruling 2026-09-28: a caller reaching out to us is a customer action
 * (same idea as the 2026-08-29 ruling that put form replies in
 * CUSTOMER_ACTION_ENTRY_POINTS), so this text goes out at ANY hour — no
 * holding to 8 AM. This module carries NO window check of its own any more;
 * `missed_call_text_back` is a CUSTOMER_ACTION_ENTRY_POINTS entry
 * (messaging/validators/send-window.js), so the general 8am-8pm ET
 * moratorium (server/services/messaging/send-window.js) never applies to
 * this entry point in the first place. A night miss still waits out its own
 * voicemail-landing grace (a voicemail can land seconds after the terminal
 * status), then sends inside its normal 30-minute slot like any other call.
 *
 * Eligibility reuses server/services/missed-call-bell.js's
 * `missedCallShapeEligible` (outcome-unanswered, the 25s unknown-caller
 * floor, withheld/sentinel IDs, Nomorobo spam, voice_relay_sandbox, no
 * recording, no voicemail_callback_alerted_at, not ai_handled /
 * ai_transferred) with `unknownCallers` forced true. It deliberately skips
 * the bell's own delivery state: with GATE_MISSED_CALL_UNKNOWN_CALLERS on,
 * the bell rings and settles the same call first, and that must not hide
 * the call from this lane. Two restrictions of its own on top:
 * `customer_id IS NULL`, and no customer record knows the number
 * (utils/known-caller-phone.js — primary, service-contact and secondary
 * phones, even when call_log never linked a customer_id). And the owner's
 * automated-first-touch holds (rulings 2026-09-27, shared with the
 * voicemail quote-link text — messaging/auto-text-holds.js): no text to a
 * number with a quote or estimate on file, an open lead a staff member is
 * working, a do-not-contact request, a call that showed a salesperson,
 * vendor, robocall, wrong number or job applicant, or a text either way
 * from 7 days before the call on.
 *
 * State lives in call_log.metadata under lane-OWN keys (never the bell's):
 *   missed_call_text_leased_at   — fenced lease (reclaimable once stale)
 *   missed_call_text_settled_at  — terminal
 *   missed_call_text_outcome     — 'sent' or 'skipped:<reason>'
 *
 * One text per phone number EVER — a row in the lane's own
 * missed_call_text_claims (phone PRIMARY KEY; the voicemail_sms_claims /
 * dropped_call_sms_claims contract). Owner ruling 2026-09-27: this text and
 * the voicemail quote-link text stay separate lanes — this one skips anyone
 * the voicemail lane has claimed or texted (or who left a voicemail), and
 * the voicemail lane still answers a voicemail left after this text. The
 * claim is taken only at the provider boundary (providerBoundaryCheck, run
 * by Twilio right before the SDK request), so no claim exists for a text
 * that never got that far; a row left by a crash past it is reconciled
 * against the provider, and otherwise treated as possibly delivered — at
 * most once, never twice. Released only when the pipeline proves nothing
 * was sent and the failure can clear (a hold, a non-terminal provider
 * failure, a terminal rejection of our own sender or account).
 *
 * Timing: every call gets one send slot (SEND_SLOT_MS) from the first
 * moment it may be texted — right after the voicemail-landing grace, any
 * hour of the day. Past the slot the call is skipped for good, so a crashed
 * pod or a hung hook never produces an hours-late "sorry we missed your
 * call"; the durable sweep (scheduler.js, every 2 minutes) is what actually
 * catches a call the post-call hook missed, re-checking "still uncontacted"
 * right before it sends.
 */

const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');
const { whereNotBlockedCall } = require('../middleware/spam-block');
const {
  missedCallShapeEligible, UNKNOWN_CALLER_MIN_SECONDS,
  UNANSWERED, UNANSWERED_STATUSES, TERMINAL_STATUSES, VOICEMAIL_GRACE_MS,
} = require('./missed-call-bell');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { renderSmsTemplate } = require('./sms-template-renderer');
const { normalizeGsmPunctuation } = require('./messaging/gsm-normalize');
const { stripSmsUrlScheme } = require('./messaging/sms-link-policy');
const { isRealProviderSend, isAmbiguousProviderOutcome } = require('./sms-auto-send');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { knownCallerPhoneExists } = require('../utils/known-caller-phone');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
const { autoTextHoldReason, deliveredTexts } = require('./messaging/auto-text-holds');

const GATE = 'missedCallTextBack';
const MESSAGE_TYPE = 'missed_call_text_back';
// voicemail-lead-sms.js's provisional claim outcome: its text is not out
// yet, and it deletes the row on a failure that never consumed its one-shot.
const VOICEMAIL_CLAIM_IN_FLIGHT = 'claimed';
// Outcomes on the lane's missed_call_text_claims row (see header).
const CLAIM = {
  DISPATCHING: 'dispatching', // taken at the provider boundary
  SENT: 'sent',
  UNCERTAIN: 'uncertain', // the provider may hold it
  BLOCKED: 'blocked', // permanent rejection — the number can't take a text
};
// providerBoundaryCheck's refusal codes, read back off the pipeline result.
const BOUNDARY = {
  NOT_MISSED: 'MISSED_CALL_NO_LONGER_MISSED',
  CONTACTED: 'MISSED_CALL_ALREADY_CONTACTED',
  TOO_OLD: 'MISSED_CALL_TOO_OLD',
  CLAIMED: 'MISSED_CALL_PHONE_CLAIMED',
  CLAIM_BUSY: 'MISSED_CALL_CLAIM_IN_FLIGHT',
  VOICEMAIL_TEXTED: 'MISSED_CALL_VOICEMAIL_TEXTED',
  CONTACT_IN_FLIGHT: 'MISSED_CALL_CONTACT_IN_FLIGHT',
  HELD: 'MISSED_CALL_AUTO_TEXT_HOLD',
  CHECK_FAILED: 'MISSED_CALL_CHECK_FAILED',
};
// Same lease length / shape as missed-call-bell.js — long enough to cover
// the lookups + send, reclaimable by the sweep once stale.
const LEASE_MS = 10 * 60 * 1000;
// A DISPATCHING claim is held for one provider round trip — a short read
// (the disclaimed-number check) and Twilio's own request (30 s client
// timeout). Only after a full day is it treated as left by an attempt that
// died between the claim and its outcome, so a sender that merely stalled
// cannot resume and send beside a retry that took a recycled claim. The
// cost of waiting is small: the claim's own call is long past its 30-minute
// send slot either way, so only a repeat call within the day is affected.
const STALE_CLAIM_MS = 24 * 60 * 60 * 1000;
// The one send slot per call (see header): 30 minutes from the first moment
// the call may be texted — any hour of the day, since owner ruling
// 2026-09-28 dropped the after-hours defer. A miss goes out within minutes
// of clearing its voicemail-landing grace, whatever the clock says.
const SEND_SLOT_MS = 30 * 60 * 1000;
// Belt on top of the slot (sendSlotDeadline is the real bound): no call
// older than this is ever texted, and the sweep reads no further back. The
// legitimate wait is now only the voicemail grace plus the send slot (under
// an hour); this cap is pure backstop headroom for a stalled sweep or a
// backlog, not a scheduled wait.
const MAX_CALL_AGE_MS = 16 * 60 * 60 * 1000;

// Later-call outcomes that mean someone already spoke with the caller.
const ANSWERED_BY_SOMEONE = ['human', 'ai_agent'];
// A click-to-call row before its customer leg is dialed (call-bridge.js
// inserts it 'initiated'; /call-status moves the staff leg along). One still
// in these statuses past BRIDGE_PENDING_MS is a stuck row, not a live call.
const BRIDGE_LIVE_STATUSES = ['initiated', 'queued', 'ringing', 'in-progress'];
const BRIDGE_PENDING_MS = 15 * 60 * 1000;
const AI_OUTCOMES = ['ai_handled', 'ai_transferred'];

function parseMeta(meta) {
  if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
  return meta && typeof meta === 'object' ? meta : {};
}

function maskPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits ? `***${digits.slice(-4)}` : 'unknown';
}

// Same phone-shape contract as the other text-back lanes: the claim key,
// dedupe reads, and the pipeline-written sms_log rows must all agree on ONE
// normalized shape.
function normalizePhoneE164(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (trimmed.startsWith('+')) return trimmed;
  return trimmed;
}

// " at (941) 297-5749" from the line the caller just dialed, or "" when it
// isn't a displayable 10-digit US number — {callback_clause} keeps the
// sentence grammatical either way.
function callbackClause(dialedNumber) {
  const digits = String(dialedNumber || '').replace(/\D/g, '').replace(/^1/, '');
  if (digits.length !== 10) return '';
  return ` at (${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

// The line to send FROM: the dialed line itself, but only when it's one of
// OUR registered SMS-capable numbers, never the field-tech line (owner
// ruling: automated texts never originate from a tech line) and never the
// toll-free AI-assistant line (its replies enter the AI chat flow, not the
// human comms inbox — same exclusion outbound-voicemail-sms.js's
// replyFromNumber applies). Not one of ours (or unknown) → the lane skips
// entirely rather than falling back to a different line the caller never
// saw ring.
function fromNumberForDialed(dialed) {
  if (!dialed) return null;
  if (dialed === TWILIO_NUMBERS.tollFree?.number) return null;
  if (TWILIO_NUMBERS.isTechLine(dialed)) return null;
  // The internal-alert caller ID is never customer-facing (twilio-numbers.js)
  // — unless it is unset and falls back to the main line, which is.
  const alertCallerId = TWILIO_NUMBERS.internalAlertCallerId?.();
  if (alertCallerId && alertCallerId !== TWILIO_NUMBERS.mainLine?.number && dialed === alertCallerId) return null;
  return TWILIO_NUMBERS.findByNumber(dialed) ? dialed : null;
}

/**
 * Pure (no DB) eligibility core, exported for tests: the bell's missed-call
 * shape plus this lane's "unknown caller only" restriction. Never reads the
 * bell's delivery keys (see header). Does NOT cover the known-caller phone
 * match (needs a DB read) or the one-per-number claim.
 */
function textBackCoreEligible(row) {
  return Boolean(row) && !row.customer_id && missedCallShapeEligible(row, { unknownCallers: true });
}

/**
 * When the call ended (ms epoch, NaN when unreadable), from facts a later
 * write can't move: the row's creation plus Twilio's call duration. A
 * retried or late status callback rewrites updated_at on the existing row,
 * so updated_at alone would hand an hours-old call a fresh grace and send
 * slot. updated_at still caps it, for rows created at their terminal
 * status (the status-callback fallback insert).
 */
function callEndedAt(row) {
  const byDuration = new Date(row.created_at).getTime() + Math.max(0, Number(row.duration_seconds) || 0) * 1000;
  const lastWrite = new Date(row.updated_at || row.created_at).getTime();
  const known = [byDuration, lastWrite].filter(Number.isFinite);
  return known.length ? Math.min(...known) : NaN;
}

/**
 * When the call's one send slot closes (ms epoch), or null when its
 * timestamps are unreadable. The slot opens when the call clears the
 * voicemail-landing grace (measured from when it ended) and runs
 * SEND_SLOT_MS from there — any hour of the day (owner ruling 2026-09-28:
 * no after-hours defer to the next morning any more).
 */
function sendSlotDeadline(row) {
  const terminalAt = callEndedAt(row);
  if (!Number.isFinite(terminalAt)) return null;
  return terminalAt + VOICEMAIL_GRACE_MS + SEND_SLOT_MS;
}

/** Bounded catch-up, exported for tests: past the send slot, or past the overall age belt. */
function tooOldToText(row, now = Date.now()) {
  const createdAt = new Date(row.created_at).getTime();
  if (!Number.isFinite(createdAt) || now - createdAt > MAX_CALL_AGE_MS) return true;
  const deadline = sendSlotDeadline(row);
  return deadline === null || now > deadline;
}

// This lane's in-flight claim row, still DISPATCHING. Every write after the
// boundary insert is fenced on it.
function ownInFlightClaim(phone, dbi = db) {
  return dbi('missed_call_text_claims').where({ phone, outcome: CLAIM.DISPATCHING });
}
function releaseClaim(phone) {
  return ownInFlightClaim(phone).del()
    .catch((err) => logger.warn(`[missed-call-text-back] claim release failed for ${maskPhone(phone)} (${err?.code || err?.name || 'error'})`));
}
// Keep the claim with its final outcome. `claimed` false means the provider
// consumed the one-shot without the boundary check ever taking the row (a
// path that skipped it) — record it anyway so the number is never texted
// again.
function keepClaim(phone, outcome, claimed, callLogId = null) {
  const write = claimed
    ? ownInFlightClaim(phone).update({ outcome })
    : db('missed_call_text_claims').insert({ phone, outcome, call_log_id: callLogId }).onConflict('phone').ignore();
  return write.catch((err) => logger.warn(`[missed-call-text-back] claim stamp failed for ${maskPhone(phone)} (${err?.code || err?.name || 'error'})`));
}

// The shared hold check's options for this call (the early check and the
// provider boundary): its own time opens the recent-conversation window,
// its own row is read by id, and this lane's own texts are its one-shot's
// business, not a conversation.
function holdOptions(row, dbi = db) {
  return { callAt: new Date(row.created_at), originCallId: row.id, excludeMessageTypes: [MESSAGE_TYPE], dbi };
}

// Contact since the missed call — checked before the lease work and again
// at the provider boundary (owner: "only if nobody has called or texted
// them by then"). 'contacted' when a customer record knows the number now,
// we have called them since (a click-to-call counts once its customer leg
// was dialed — bridged_at; call-bridge.js rings the staff leg first and
// dials the customer only on press-1), a later call from them was answered (by a
// person or Sandy) or left a voicemail, a text reached them or came from
// them since (deliveredTexts), or a staff reply to them is scheduled or
// mid-send (the human wins — lead-auto-reply.js's same rule). 'in_flight'
// when another automated text to them is mid-handoff (a 'sending' row):
// wait for its outcome rather than cross the provider boundary beside it —
// as is a click-to-call still ringing its staff leg (not bridged, not
// ended, placed within the last BRIDGE_PENDING_MS). null when clear. This
// lane's own texts are never contact: they are the one-shot claim's
// business.
async function contactState(phone, row, dbi = db) {
  if (await knownCallerPhoneExists(dbi, phone)) return 'contacted';
  const digits = phone.replace(/\D/g, '').slice(-10);
  if (digits.length !== 10) return null;
  const phoneMatches = (column) => [`RIGHT(regexp_replace(COALESCE(${column}, ''), '[^0-9]', '', 'g'), 10) = ?`, [digits]];
  const laterCall = await dbi('call_log')
    .modify((q) => whereNotSandboxCall(q)) // a Sandy bake-off call is not contact
    .where('created_at', '>=', row.created_at)
    .whereNot('id', row.id)
    .where((q) => q
      .where((out) => out.where('direction', 'outbound').whereRaw(...phoneMatches('to_phone')).whereNotNull('bridged_at'))
      .orWhere((inb) => inb.where('direction', 'inbound').whereRaw(...phoneMatches('from_phone'))
        .where((handled) => handled
          .whereIn('answered_by', ANSWERED_BY_SOMEONE)
          .orWhereIn('call_outcome', AI_OUTCOMES)
          .orWhereNotNull('recording_sid')
          .orWhereNotNull('recording_url')
          .orWhereNotNull('voicemail_callback_alerted_at'))))
    .first('id');
  if (laterCall) return 'contacted';
  const bridgePending = await dbi('call_log')
    .modify((q) => whereNotSandboxCall(q))
    .where('direction', 'outbound')
    .whereRaw(...phoneMatches('to_phone'))
    .whereNull('bridged_at')
    .whereIn('status', BRIDGE_LIVE_STATUSES)
    .where('created_at', '>=', row.created_at)
    .where('created_at', '>', new Date(Date.now() - BRIDGE_PENDING_MS))
    .first('id');
  const texted = await deliveredTexts(dbi)
    .whereRaw("COALESCE(message_type, '') <> ?", [MESSAGE_TYPE])
    .where('created_at', '>=', row.created_at)
    .where((q) => q.whereRaw(...phoneMatches('from_phone')).orWhereRaw(...phoneMatches('to_phone')))
    .first('id');
  if (texted) return 'contacted';
  const { HUMAN_REPLY_TYPES } = require('./sms-suggest-mode');
  const pending = await dbi('sms_log')
    .where({ direction: 'outbound' })
    .whereRaw("COALESCE(message_type, '') <> ?", [MESSAGE_TYPE])
    .where((q) => q.where('status', 'sending')
      .orWhere((human) => human.whereIn('message_type', HUMAN_REPLY_TYPES).where('status', 'scheduled')))
    .where('created_at', '>=', row.created_at)
    .whereRaw(...phoneMatches('to_phone'))
    .select('message_type');
  if (pending.some((text) => HUMAN_REPLY_TYPES.includes(text.message_type))) return 'contacted';
  return pending.length || bridgePending ? 'in_flight' : null;
}

// A claim this lane took at the provider boundary and never resolved: the
// attempt died between the claim and its outcome. The local sms_log cannot
// prove absence (a post-accept log insert can fail), so ask the provider
// (TwilioService.findOutboundMessageSince, the same reconciliation
// prep-guide-sender.js runs on its stale claims) for THIS lane's text — the
// exact body the attempt stamped on its call before sending, so a staff
// text to the same number never passes for it. That text since the claim →
// stamp it sent; none → release the orphan; no answer → leave it for the
// next pass (possibly delivered, at most once). No stamped body to match
// (the stamp write failed, or the call row is gone) → it can never be
// resolved, and the attempt may have sent: keep the one-shot as uncertain,
// so the bounded orphan pass stops re-reading it (enough of them at the
// head of its batch would starve every newer orphan) and later calls
// settle instead of waiting on it. Returns the claim row that stands
// afterwards, or null.
async function reconcileStaleClaim(phone, claim) {
  if (claim.outcome !== CLAIM.DISPATCHING) return claim;
  const claimedAt = new Date(claim.created_at).getTime();
  if (!Number.isFinite(claimedAt) || Date.now() - claimedAt < STALE_CLAIM_MS) return claim; // still in flight
  const stillStale = () => ownInFlightClaim(phone).where('created_at', '<', new Date(Date.now() - STALE_CLAIM_MS));
  const origin = claim.call_log_id ? await db('call_log').where({ id: claim.call_log_id }).first('metadata') : null;
  const body = parseMeta(origin?.metadata).missed_call_text_body;
  if (!body) {
    await stillStale().update({ outcome: CLAIM.UNCERTAIN });
    logger.warn(`[missed-call-text-back] An orphaned claim for ${maskPhone(phone)} has no stamped text to match — kept as uncertain`);
  } else {
    const provider = await require('./twilio').findOutboundMessageSince({ to: phone, sentAfter: claim.created_at, bodyFragment: body });
    if (provider?.found) {
      await ownInFlightClaim(phone).update({ outcome: CLAIM.SENT });
    } else if (provider?.found === false && !provider.unavailable) {
      await stillStale().del();
      logger.info(`[missed-call-text-back] Released an orphaned claim for ${maskPhone(phone)} — the provider has no message since it`);
    }
  }
  return (await db('missed_call_text_claims').where({ phone }).first('outcome', 'created_at', 'call_log_id')) || null;
}

// What this lane's existing claim on the number means for a call:
// 'in_flight' (another attempt is mid-handoff, or an orphan not yet
// reconciled — it may still be released, so wait and retry inside the send
// slot), or 'already_sent_to_phone' (the one-shot is consumed).
function claimState(claim) {
  return claim.outcome === CLAIM.DISPATCHING ? 'in_flight' : 'already_sent_to_phone';
}

// An earlier text to this number — a settle reason, 'in_flight', or null —
// as the early skip before any pipeline work (the atomic guarantee is the
// boundary claim). This lane's own claim first; then the voicemail lane's
// claim: that lane is answering a voicemail they left (or found the number
// is a landline), and this text yields to it (owner ruling 2026-09-27) —
// waiting while its claim is still provisional, since that lane deletes it
// if its send fails; then the sms_log history of both lanes' types, texts
// that actually went out only (deliveredTexts): an unresolved reservation's
// fate is the claim's business, and a reconciled orphan the provider proved
// unsent, or a bounced text, must not survive here as a completed one.
async function priorTextReason(phone) {
  const found = await db('missed_call_text_claims').where({ phone }).first('outcome', 'created_at', 'call_log_id');
  const claim = found && await reconcileStaleClaim(phone, found);
  if (claim) return claimState(claim);
  const voicemailClaim = await db('voicemail_sms_claims').where({ phone }).first('outcome');
  if (voicemailClaim) return voicemailClaim.outcome === VOICEMAIL_CLAIM_IN_FLIGHT ? 'in_flight' : 'voicemail_lead_texted';
  const sentBefore = (messageType) => deliveredTexts(db)
    .where({ to_phone: phone, message_type: messageType })
    .first('id');
  if (await sentBefore(MESSAGE_TYPE)) return 'already_sent_to_phone';
  return (await sentBefore('voicemail_quote_link')) ? 'voicemail_lead_texted' : null;
}

// Orphan cleanup, independent of any call: a claim this lane left
// unresolved keeps the number from ever being texted, even after the call
// that took it has aged out. Run by every sweep pass, gate on or off (it
// only resolves this lane's own rows; it sends nothing). Bounded per pass.
async function reconcileOrphanedClaims({ limit = 20 } = {}) {
  const stale = await db('missed_call_text_claims')
    .where('outcome', CLAIM.DISPATCHING)
    .where('created_at', '<', new Date(Date.now() - STALE_CLAIM_MS))
    .orderBy('created_at', 'asc')
    .limit(limit)
    .select('phone', 'outcome', 'created_at', 'call_log_id');
  for (const claim of stale) {
    try {
      await reconcileStaleClaim(claim.phone, claim);
    } catch (err) {
      logger.warn(`[missed-call-text-back] orphan reconcile failed for ${maskPhone(claim.phone)}: ${err?.code || err?.name || 'error'}`);
    }
  }
  return stale.length;
}

// Deterministic gates decidable before any lease is taken — every check
// here computes the same answer no matter which process runs it, so a
// terminal outcome is safe to settle immediately without a fence.
async function precheckRow(row, now) {
  if (tooOldToText(row, now)) return { ok: false, outcome: 'skipped:too_old', reason: 'too_old' };

  const fromNumber = fromNumberForDialed(row.to_phone);
  if (!fromNumber) return { ok: false, outcome: 'skipped:unsupported_line', reason: 'unsupported_line' };

  const phone = normalizePhoneE164(row.from_phone);
  if (!phone) return { ok: false, outcome: 'skipped:bad_phone', reason: 'bad_phone' };
  // A Waves line or a staff forward / CSR cell calling in is never a lead
  // (same exclusion as outbound-voicemail-sms.js).
  if (TWILIO_NUMBERS.isInternalNumber(phone)) return { ok: false, outcome: 'skipped:internal_number', reason: 'internal_number' };

  // Voicemail-landing grace, from when the call ended, any hour of the day
  // (owner ruling 2026-09-28: no 8am-8pm window check here any more) — same
  // grace the bell's own sweep uses (a voicemail can still be
  // recording/uploading right after the terminal status lands).
  const terminalAt = callEndedAt(row);
  if (Number.isFinite(terminalAt) && now - terminalAt < VOICEMAIL_GRACE_MS) {
    return { ok: false, pending: true, reason: 'voicemail_grace' };
  }

  // A customer record that knows this number (even though call_log never
  // linked customer_id) is out of scope for this lane — fail closed on a
  // lookup error rather than risk texting an existing customer.
  try {
    if (await knownCallerPhoneExists(db, phone)) return { ok: false, outcome: 'skipped:existing_customer', reason: 'existing_customer' };
  } catch (e) {
    logger.warn(`[missed-call-text-back] customer lookup failed — leaving unsettled (fail closed): ${e.code || e.name || 'db_error'}`);
    return { ok: false, error: true };
  }

  return { ok: true, fromNumber, phone };
}

// Runs with the fenced lease held. Every return path either settles the
// call (one-shot decision made) or releases the lease for a later retry —
// never both silent (a released, unsettled call is picked up again by the
// next sweep pass, until its send slot closes).
async function sendWithLease(row, { fromNumber, phone }, releaseLease, settleFenced, stampBody) {
  try {
    // A resumed lease whose earlier attempt sent the text but crashed before
    // settling 'sent' is caught by priorTextReason below (the claim row, or
    // this lane's own sms_log row) — never double-texted.
    const contact = await contactState(phone, row);
    if (contact === 'contacted') {
      await settleFenced('skipped:already_contacted');
      return { outcome: 'skipped', reason: 'already_contacted' };
    }
    if (contact === 'in_flight') {
      // Another text to them, or a staff call still ringing the staff leg,
      // is mid-handoff: leave this call unsettled so a later pass sees how
      // that one landed.
      await releaseLease();
      return { outcome: 'pending', reason: 'contact_in_flight' };
    }
    const prior = await priorTextReason(phone);
    if (prior === 'in_flight') {
      // Another send holds the number and may still release it: leave this
      // call unsettled so a later pass retries inside its send slot.
      await releaseLease();
      return { outcome: 'pending', reason: 'claim_in_flight' };
    }
    if (prior) {
      await settleFenced(`skipped:${prior}`);
      return { outcome: 'skipped', reason: prior };
    }
    // The owner's holds (see header), after the more specific reasons above.
    const hold = await autoTextHoldReason(phone, holdOptions(row));
    if (hold) {
      await settleFenced(`skipped:${hold}`);
      return { outcome: 'skipped', reason: hold };
    }
  } catch (e) {
    await releaseLease();
    logger.warn(`[missed-call-text-back] contact or hold recheck failed — releasing lease (fail closed): ${e.code || e.name || 'db_error'}`);
    return { outcome: 'error' };
  }

  // requiredVars: an admin edit or a weighted variant that drops the
  // callback number never renders (the same list guards template edits).
  const { REQUIRED_TEMPLATE_PLACEHOLDERS } = require('../routes/admin-sms-templates');
  const rendered = await renderSmsTemplate(MESSAGE_TYPE, {
    callback_clause: callbackClause(fromNumber),
  }, {
    workflow: MESSAGE_TYPE,
    entity_type: 'call_log',
    entity_id: row.id,
  }, { requiredVars: REQUIRED_TEMPLATE_PLACEHOLDERS[MESSAGE_TYPE] });
  if (!rendered) {
    await releaseLease();
    logger.info(`[missed-call-text-back] Template ${MESSAGE_TYPE} missing/disabled — skipped for ${maskPhone(phone)}`);
    return { outcome: 'skipped', reason: 'template_disabled' };
  }
  // The text exactly as Twilio will hold it: sendCustomerMessage strips
  // link schemes and GSM-normalizes a lead text before the provider (both
  // idempotent), so sending this form changes nothing and the stamp below
  // matches the provider's own record whatever an admin edit put in the
  // template.
  const body = normalizeGsmPunctuation(stripSmsUrlScheme(rendered));

  // The exact text, on the call, before anything can reach the provider —
  // what reconcileStaleClaim matches if this attempt dies past the boundary.
  await stampBody(body);

  // Set by providerBoundaryCheck once it takes the claim row.
  const attempt = { claimed: false };
  const result = await dispatchOrThrown(row, phone, body, fromNumber, attempt);
  if (result.threw) {
    logger.warn(`[missed-call-text-back] send threw for ${maskPhone(phone)}: ${result.err.code || result.err.name || 'error'}`);
    if (attempt.claimed) {
      // Past the provider boundary with no outcome — it may have gone out.
      await keepClaim(phone, CLAIM.UNCERTAIN, true);
      await settleFenced('skipped:provider_uncertain');
      return { outcome: 'skipped', reason: 'provider_uncertain' };
    }
    await releaseLease();
    return { outcome: 'error' };
  }
  return classifySendOutcome(result.value, phone, attempt, row, { releaseLease, settleFenced });
}

/**
 * The provider-boundary predicate, passed as sendCustomerMessage's
 * providerPreSendCheck: Twilio runs it once, after every provider
 * preparation await, immediately before the SDK request. Everything that
 * can change between the lease and the handoff is decided again here — the
 * call itself (a voicemail recording that landed late makes it the
 * voicemail lane's), still uncontacted, none of the owner's holds, then the
 * one-shot claim (taken here and nowhere earlier), then the voicemail lane's
 * claim, then, as the last step after the last await, a fresh clock against
 * the call's send slot (any hour — owner ruling 2026-09-28 dropped the
 * 8am-8pm check here). A refusal after the claim leaves it to
 * classifySendOutcome to release.
 */
function providerBoundaryCheck(row, phone, attempt) {
  return async ({ dbi = db } = {}) => {
    try {
      const current = await dbi('call_log').where({ id: row.id }).modify(whereNotBlockedCall).first();
      if (!textBackCoreEligible(current)) {
        return { ok: false, code: BOUNDARY.NOT_MISSED, reason: 'the call is no longer an unanswered, message-less miss' };
      }
      const contact = await contactState(phone, row, dbi);
      if (contact === 'contacted') {
        return { ok: false, code: BOUNDARY.CONTACTED, reason: 'the caller was contacted after the missed call' };
      }
      if (contact === 'in_flight') {
        return { ok: false, code: BOUNDARY.CONTACT_IN_FLIGHT, reason: 'another text or a staff call to this number is mid-handoff', retryable: true };
      }
      // A hold that appeared since the early check (a quote sent, a lead
      // assigned, a call that asked not to be contacted) stops the send
      // here, before any claim; which one rides on the attempt.
      attempt.hold = await autoTextHoldReason(phone, holdOptions(row, dbi));
      if (attempt.hold) return { ok: false, code: BOUNDARY.HELD, reason: 'an owner hold applies to this number' };
      const claimed = await dbi('missed_call_text_claims')
        .insert({ phone, outcome: CLAIM.DISPATCHING, call_log_id: row.id })
        .onConflict('phone')
        .ignore()
        .returning('phone');
      if (!claimed?.length) {
        const holder = await dbi('missed_call_text_claims').where({ phone }).first('outcome');
        return !holder || claimState(holder) === 'in_flight'
          ? { ok: false, code: BOUNDARY.CLAIM_BUSY, reason: 'another send holds this number', retryable: true }
          : { ok: false, code: BOUNDARY.CLAIMED, reason: 'this number was already texted' };
      }
      attempt.claimed = true;
      // Yield to the voicemail lane at the boundary too — read AFTER this
      // lane's claim is in, never before: the two lanes' claims sit in
      // different tables, so reading first left a gap in which that lane
      // could claim unseen and both would send. A voicemail claim committed
      // before this read is seen (back off — wait while it is provisional,
      // settle once it is consumed; classifySendOutcome releases this lane's
      // claim either way). One committed after it came second. The
      // voicemail lane deliberately never reads this lane's claims (owner
      // ruling 2026-09-27: separate lanes — a voicemail left after this
      // text still gets its quote link), so this one-sided order is the
      // whole rule: this lane never sends after a voicemail claim it could
      // have seen.
      const voicemailClaim = await dbi('voicemail_sms_claims').where({ phone }).first('outcome');
      if (voicemailClaim) {
        return voicemailClaim.outcome === VOICEMAIL_CLAIM_IN_FLIGHT
          ? { ok: false, code: BOUNDARY.CLAIM_BUSY, reason: 'the voicemail lane holds this number', retryable: true }
          : { ok: false, code: BOUNDARY.VOICEMAIL_TEXTED, reason: 'the voicemail lane texted this number' };
      }
      const now = Date.now();
      if (tooOldToText(row, now)) return { ok: false, code: BOUNDARY.TOO_OLD, reason: 'the send slot closed' };
      return { ok: true };
    } catch (err) {
      logger.warn(`[missed-call-text-back] boundary recheck failed for ${maskPhone(phone)} — holding the send: ${err?.code || err?.name || 'error'}`);
      return { ok: false, code: BOUNDARY.CHECK_FAILED, reason: 'boundary recheck failed', retryable: true };
    }
  };
}

// Isolates the try/catch around the provider call: an outcome carried on a
// thrown error's .providerOutcome (the pipeline attaches the KNOWN provider
// result when its audit write fails afterwards) is classified exactly like
// a returned one — accepted, uncertain, or a definite not-sent with its own
// retryable/terminal semantics. Only a throw with no provider outcome is a
// bare failure.
async function dispatchOrThrown(row, phone, body, fromNumber, attempt) {
  try {
    const value = await sendCustomerMessage({
      to: phone,
      body,
      channel: 'sms',
      audience: 'lead',
      purpose: 'missed_call_followup',
      identityTrustLevel: 'phone_provided_unverified',
      consentBasis: { status: 'transactional_allowed', source: 'missed_call_text_back' },
      entryPoint: 'missed_call_text_back',
      providerPreSendCheck: providerBoundaryCheck(row, phone, attempt),
      metadata: {
        original_message_type: MESSAGE_TYPE,
        call_sid: row.twilio_call_sid,
        call_log_id: row.id,
        fromNumber,
        templateKey: MESSAGE_TYPE,
      },
    });
    return { value };
  } catch (err) {
    if (err?.providerOutcome && typeof err.providerOutcome === 'object') return { value: err.providerOutcome };
    return { threw: true, err };
  }
}

// providerBoundaryCheck's terminal refusals: nothing reached the provider.
// The ones after the claim insert (the voicemail lane texted, the send slot
// closed) hold this lane's claim; classifySendOutcome matches them here,
// by code, BEFORE its terminal branch, and releases the claim — a refusal
// of this lane's own is never kept as a BLOCKED number.
const BOUNDARY_SETTLES = {
  [BOUNDARY.NOT_MISSED]: 'not_missed',
  [BOUNDARY.CONTACTED]: 'already_contacted',
  [BOUNDARY.TOO_OLD]: 'too_old',
  [BOUNDARY.CLAIMED]: 'already_sent_to_phone',
  [BOUNDARY.VOICEMAIL_TEXTED]: 'voicemail_lead_texted',
};

async function classifySendOutcome(result, phone, attempt, row, { releaseLease, settleFenced }) {
  if (result.sent && isRealProviderSend(result)) {
    await keepClaim(phone, CLAIM.SENT, attempt.claimed, row.id);
    await settleFenced('sent');
    logger.info(`[missed-call-text-back] Sent to ${maskPhone(phone)} (call_log ${row.id})`);
    return { outcome: 'sent' };
  }
  if (isAmbiguousProviderOutcome(result)) {
    // The provider may still hold the text — keep the claim (a missed text
    // beats a doubled one) and settle; neither lane retries this number.
    await keepClaim(phone, CLAIM.UNCERTAIN, attempt.claimed, row.id);
    await settleFenced('skipped:provider_uncertain');
    return { outcome: 'skipped', reason: 'provider_uncertain' };
  }
  const boundaryReason = !result.sent && (result.code === BOUNDARY.HELD
    ? attempt.hold || 'auto_text_hold'
    : BOUNDARY_SETTLES[result.code]);
  if (boundaryReason) {
    if (attempt.claimed) await releaseClaim(phone);
    await settleFenced(`skipped:${boundaryReason}`);
    return { outcome: 'skipped', reason: boundaryReason };
  }
  if (!result.sent && (result.terminal === true || (result.blocked && !result.retryable && !result.deferred))) {
    // Terminal: a policy refusal (STOP/suppression, no consent, the
    // landline validator) or a permanent provider rejection. Nothing was
    // sent, and this call settles. A claim this attempt took is kept as
    // BLOCKED when the refusal is about the recipient — a number that can
    // never take a text is not retried — and released when it is our own
    // sender's or account's (the From cannot send, no permission for the
    // region, a trial restriction): fixing that makes a later missed call's
    // text viable, so it must not use up the number's one text.
    const { SENDER_SIDE_TERMINAL_TWILIO_CODES } = require('./messaging/providers/twilio-sms');
    const senderCode = SENDER_SIDE_TERMINAL_TWILIO_CODES.find((code) => code === String(result.providerErrorCode || ''));
    const reason = senderCode
      ? `sender_rejected_${senderCode}`
      : result.code || (result.terminal === true ? 'provider_rejected' : 'policy_block');
    if (attempt.claimed) {
      if (senderCode) await releaseClaim(phone);
      else await keepClaim(phone, CLAIM.BLOCKED, true);
    }
    await settleFenced(`skipped:${reason}`);
    return { outcome: 'skipped', reason };
  }
  // Nothing left the system and the failure can clear: an upstream
  // suppression sentinel (sent:true with no real send — a gate or template
  // raced off), a hold the pipeline says to retry (a claim in flight, a
  // callback-number hold, this lane's own recheck refusals) or a
  // non-terminal provider failure. Release both so a later sweep pass
  // retries inside the send slot.
  if (attempt.claimed) await releaseClaim(phone);
  await releaseLease();
  return { outcome: 'error', reason: result.sent ? 'send_suppressed' : (result.code || 'provider_failed') };
}

/**
 * Attempt (or skip) a text-back for one call_log row. Shared core for both
 * the post-call hook and the durable sweep so the two paths can never
 * diverge. Returns { outcome: 'sent' | 'pending' | 'skipped' | 'error', reason? }.
 */
async function attemptForRow(row, now = Date.now()) {
  if (!row || !row.twilio_call_sid) return { outcome: 'skipped', reason: 'no_sid' };
  if (!textBackCoreEligible(row)) return { outcome: 'skipped', reason: 'not_missed' };
  const meta = parseMeta(row.metadata);
  if (meta.missed_call_text_settled_at) return { outcome: 'skipped', reason: 'already_settled' };

  const settle = async (outcome) => {
    try {
      await db('call_log').where({ id: row.id })
        .whereRaw("COALESCE(metadata->>'missed_call_text_settled_at', '') = ''")
        .update({ metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('missed_call_text_settled_at', ?::text, 'missed_call_text_outcome', ?::text)", [new Date(Date.now()).toISOString(), outcome]) });
    } catch (e) {
      logger.warn(`[missed-call-text-back] settle write failed for call ${String(row.twilio_call_sid).slice(-6)}: ${e.code || e.name || 'db_error'}`);
    }
  };

  const pre = await precheckRow(row, now);
  if (!pre.ok) {
    if (pre.error) return { outcome: 'error' };
    if (pre.pending) return { outcome: 'pending', reason: pre.reason };
    await settle(pre.outcome);
    return { outcome: 'skipped', reason: pre.reason };
  }

  // Fenced lease: covers the remaining lookups + send, reclaimable once
  // stale by a later sweep pass (crash mid-delivery never loses the call).
  // The mutable eligibility predicates are re-checked IN the lease write,
  // the same set the bell's own claim re-checks, so an answered outcome or
  // a voicemail that landed after the read above loses the race.
  const leaseToken = new Date(Date.now()).toISOString();
  const leased = await db('call_log').where({ id: row.id, direction: 'inbound' })
    .modify(whereNotBlockedCall)
    .whereRaw("COALESCE(metadata->>'missed_call_text_settled_at', '') = ''")
    .whereRaw("(COALESCE(metadata->>'missed_call_text_leased_at', '') = '' OR (metadata->>'missed_call_text_leased_at')::timestamptz < ?)", [new Date(Date.now() - LEASE_MS)])
    .whereNull('customer_id')
    .whereNull('recording_sid')
    .whereNull('recording_url')
    .whereNull('voicemail_callback_alerted_at')
    .whereRaw("COALESCE(call_outcome, '') NOT IN ('ai_handled', 'ai_transferred')")
    .whereRaw('(answered_by IN (?, ?, ?) OR (answered_by IS NULL AND status IN (?, ?, ?)))', [...UNANSWERED, ...UNANSWERED_STATUSES])
    .update({ metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('missed_call_text_leased_at', ?::text)", [leaseToken]) });
  if (!leased) return { outcome: 'skipped', reason: 'lease_lost' };

  const fenced = () => db('call_log').where({ id: row.id }).whereRaw("metadata->>'missed_call_text_leased_at' = ?", [leaseToken]);
  const settleFenced = (outcome) => fenced().update({ metadata: db.raw("metadata || jsonb_build_object('missed_call_text_settled_at', ?::text, 'missed_call_text_outcome', ?::text)", [new Date(Date.now()).toISOString(), outcome]) })
    .catch((e) => logger.warn(`[missed-call-text-back] fenced settle failed: ${e.code || e.name || 'db_error'}`));
  const releaseLease = () => fenced().update({ metadata: db.raw("metadata - 'missed_call_text_leased_at'") })
    .catch((e) => logger.warn(`[missed-call-text-back] lease release failed: ${e.code || e.name || 'db_error'}`));
  const stampBody = (body) => fenced().update({ metadata: db.raw("metadata || jsonb_build_object('missed_call_text_body', ?::text)", [body]) })
    .catch((e) => logger.warn(`[missed-call-text-back] body stamp failed: ${e.code || e.name || 'db_error'}`));

  return sendWithLease(row, pre, releaseLease, settleFenced, stampBody);
}

/**
 * Post-call hook entry point. Fetches the call fresh and runs the shared
 * attempt logic. Gate-checked first so an off gate costs one env read.
 */
async function textBackIfMissed(callSid) {
  if (!callSid) return { outcome: 'skipped', reason: 'no_call_sid' };
  if (!isEnabled(GATE)) return { outcome: 'skipped', reason: 'gate_off' };
  try {
    const row = await db('call_log').where('twilio_call_sid', callSid).modify(whereNotBlockedCall).first();
    if (!row) return { outcome: 'skipped', reason: 'not_found' };
    return await attemptForRow(row, Date.now());
  } catch (err) {
    logger.warn(`[missed-call-text-back] failed for call ${String(callSid).slice(-6)}: ${err.message}`);
    return { outcome: 'error' };
  }
}

/**
 * Durable retry (scheduler.js, every 2 minutes): re-offers unsettled,
 * eligible unknown-caller misses the post-call hook hasn't reached yet, any
 * hour of the day (owner ruling 2026-09-28: no after-hours defer). Idempotent
 * — attemptForRow's own lease + claim make a re-offer a no-op.
 */
async function sweepMissedCallTextBacks({ limit = 50 } = {}) {
  await reconcileOrphanedClaims().catch((err) => logger.warn(`[missed-call-text-back] orphan reconcile pass failed: ${err?.code || err?.name || 'error'}`));
  if (!isEnabled(GATE)) return { sent: 0, offered: 0 };
  const now = Date.now();
  let sent = 0;
  let offered = 0;
  let cursor = null;
  while (offered < limit) {
    const rows = await db('call_log')
      .where({ direction: 'inbound' })
      .modify(whereNotBlockedCall)
      .whereNull('customer_id')
      .modify((q) => whereNotSandboxCall(q))
      .whereIn('status', TERMINAL_STATUSES)
      .whereNull('recording_sid')
      .whereNull('recording_url')
      .whereNull('voicemail_callback_alerted_at')
      .whereRaw("COALESCE(call_outcome, '') NOT IN ('ai_handled', 'ai_transferred')")
      .whereRaw('(answered_by IN (?, ?, ?) OR (answered_by IS NULL AND status IN (?, ?, ?)))', [...UNANSWERED, ...UNANSWERED_STATUSES])
      .where('duration_seconds', '>=', UNKNOWN_CALLER_MIN_SECONDS)
      .whereRaw("COALESCE(metadata->>'missed_call_text_settled_at', '') = ''")
      .whereRaw("(COALESCE(metadata->>'missed_call_text_leased_at', '') = '' OR (metadata->>'missed_call_text_leased_at')::timestamptz < ?)", [new Date(now - LEASE_MS)])
      .where('created_at', '>', new Date(now - MAX_CALL_AGE_MS))
      // Past the voicemail grace since the call ENDED (callEndedAt's clock:
      // created_at + duration, capped by updated_at) — never updated_at
      // alone, which a late or repeated status callback rewrites and would
      // hide the row until its send slot had closed.
      .whereRaw('LEAST(created_at + make_interval(secs => GREATEST(COALESCE(duration_seconds, 0), 0)), COALESCE(updated_at, created_at)) < ?', [new Date(now - VOICEMAIL_GRACE_MS)])
      .modify((q) => {
        if (cursor) q.whereRaw('(created_at, id) > (?, ?)', [cursor.sweep_created_at, cursor.id]);
      })
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .limit(limit)
      .select('*', db.raw('created_at::text AS sweep_created_at'));
    for (const r of rows) {
      // Same eligibility rule as delivery, checked BEFORE counting: a row
      // that can never be texted (withheld ID, Nomorobo spam) is paged past
      // instead of eating the pass's budget — the bell's sweep does the same.
      if (!r.twilio_call_sid || !textBackCoreEligible(r)) continue;
      offered += 1;
      try {
        // A fresh clock per row: a long pass must not judge a later row's
        // send slot by the time the pass started.
        const result = await attemptForRow(r, Date.now());
        if (result.outcome === 'sent') sent += 1;
      } catch (err) {
        logger.warn(`[missed-call-text-back] sweep attempt failed for call ${String(r.twilio_call_sid || r.id).slice(-6)}: ${err.message}`);
      }
      if (offered === limit) return { sent, offered };
    }
    if (rows.length < limit) break;
    cursor = rows[rows.length - 1];
  }
  return { sent, offered };
}

module.exports = {
  GATE,
  MESSAGE_TYPE,
  CLAIM,
  BOUNDARY,
  MAX_CALL_AGE_MS,
  SEND_SLOT_MS,
  VOICEMAIL_GRACE_MS,
  textBackIfMissed,
  sweepMissedCallTextBacks,
  _private: {
    textBackCoreEligible,
    callEndedAt,
    sendSlotDeadline,
    tooOldToText,
    callbackClause,
    fromNumberForDialed,
    normalizePhoneE164,
    attemptForRow,
    contactState,
    priorTextReason,
    providerBoundaryCheck,
    reconcileStaleClaim,
    reconcileOrphanedClaims,
  },
};
