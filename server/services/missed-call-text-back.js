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
 * sign-off/signature; after-hours calls get the text at the next 8 AM ET,
 * only if nobody has called or texted them by then.
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
 * phones, even when call_log never linked a customer_id).
 *
 * State lives in call_log.metadata under lane-OWN keys (never the bell's):
 *   missed_call_text_leased_at   — fenced lease (reclaimable once stale)
 *   missed_call_text_settled_at  — terminal
 *   missed_call_text_outcome     — 'sent' or 'skipped:<reason>'
 *
 * One text per phone number EVER, shared with the voicemail-lead lane — a
 * row in voicemail_sms_claims (phone PRIMARY KEY), the permanent per-phone
 * claim services/voicemail-lead-sms.js already takes, so whichever lane
 * texts a number first, the other never does. This lane's rows carry
 * lead_id NULL (every voicemail-lane row has a lead) and the CLAIM_*
 * outcomes below. The claim is taken only at the provider boundary
 * (providerBoundaryCheck, run by Twilio right before the SDK request), so
 * no claim exists for a text that never got that far; a row left by a
 * crash past it is treated as possibly delivered — at most once, never
 * twice. Released only when the pipeline proves nothing was sent and the
 * failure can clear (a hold, a non-terminal provider failure).
 *
 * Timing: every call gets one send slot (SEND_SLOT_MS) from the first
 * moment it may be texted — after the voicemail-landing grace, or at the
 * next 8 AM ET when the window is closed by then. Outside 8am-8pm ET
 * nothing is sent; the call stays UNSETTLED and the durable sweep
 * (scheduler.js, every 2 minutes) sends it once the window reopens,
 * re-checking "still uncontacted" right before it does. Past the slot the
 * call is skipped for good, so a gate flipped on mid-morning, a crashed pod
 * or a hung hook never produces an hours-late "sorry we missed your call".
 */

const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');
const { whereNotBlockedCall } = require('../middleware/spam-block');
const {
  missedCallShapeEligible, UNKNOWN_CALLER_MIN_SECONDS,
  UNANSWERED, UNANSWERED_STATUSES, TERMINAL_STATUSES, VOICEMAIL_GRACE_MS,
} = require('./missed-call-bell');
const { isWithinSendWindowET, nextSendWindowOpenET } = require('./messaging/send-window');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { renderSmsTemplate } = require('./sms-template-renderer');
const { isRealProviderSend, isAmbiguousProviderOutcome } = require('./sms-auto-send');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { knownCallerPhoneExists } = require('../utils/known-caller-phone');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
const { excludeUnresolvedSendReservations } = require('./messaging/review-ask-reservation');

const GATE = 'missedCallTextBack';
const MESSAGE_TYPE = 'missed_call_text_back';
// voicemail-lead-sms.js's provisional outcome: its claim is taken but its
// text is not out yet, and it deletes the row on a failure that never
// consumed the one-shot.
const VOICEMAIL_CLAIM_IN_FLIGHT = 'claimed';
// This lane's outcomes on its shared voicemail_sms_claims row (see header).
const CLAIM = {
  DISPATCHING: 'missed_call_dispatching', // taken at the provider boundary
  SENT: 'missed_call_sent',
  UNCERTAIN: 'missed_call_uncertain', // the provider may hold it
  BLOCKED: 'missed_call_blocked', // permanent rejection — the number can't take a text
};
// providerBoundaryCheck's refusal codes, read back off the pipeline result.
const BOUNDARY = {
  NOT_MISSED: 'MISSED_CALL_NO_LONGER_MISSED',
  CONTACTED: 'MISSED_CALL_ALREADY_CONTACTED',
  WINDOW: 'MISSED_CALL_WINDOW_CLOSED',
  TOO_OLD: 'MISSED_CALL_TOO_OLD',
  CLAIMED: 'MISSED_CALL_PHONE_CLAIMED',
  CLAIM_BUSY: 'MISSED_CALL_CLAIM_IN_FLIGHT',
  CHECK_FAILED: 'MISSED_CALL_CHECK_FAILED',
};
// Same lease length / shape as missed-call-bell.js — long enough to cover
// the lookups + send, reclaimable by the sweep once stale.
const LEASE_MS = 10 * 60 * 1000;
// A DISPATCHING claim is held for one provider round trip; one this old was
// left by an attempt that died between the claim and its outcome.
const STALE_CLAIM_MS = LEASE_MS;
// The one send slot per call (see header): 30 minutes from the first moment
// the call may be texted. An in-hours miss goes out within minutes; an
// after-hours miss goes out between 8:00 and 8:30 AM ET.
const SEND_SLOT_MS = 30 * 60 * 1000;
// Belt on top of the slot: no call older than this is ever texted. The
// longest legitimate wait — a call just before 8 PM ET whose slot moves to
// the next morning — is about 12.5 hours.
const MAX_CALL_AGE_MS = 14 * 60 * 60 * 1000;

// Later-call outcomes that mean someone already spoke with the caller.
const ANSWERED_BY_SOMEONE = ['human', 'ai_agent'];
const AI_OUTCOMES = ['ai_handled', 'ai_transferred'];
// Outbound sms_log statuses that reached nobody — lead-auto-reply.js's
// delayed-reply rule: scheduled, cancelled, or bounced.
const UNSENT_STATUSES = ['scheduled', 'cancelled', 'canceled', 'failed', 'undelivered'];

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
 * voicemail-landing grace (measured from when it ended). If the window is
 * closed then, or closes before the slot would run out, the slot moves to
 * the next 8 AM ET instead — the owner's after-hours rule.
 */
function sendSlotDeadline(row) {
  const terminalAt = callEndedAt(row);
  if (!Number.isFinite(terminalAt)) return null;
  const readyAt = terminalAt + VOICEMAIL_GRACE_MS;
  const inHoursEnd = readyAt + SEND_SLOT_MS;
  if (isWithinSendWindowET(new Date(readyAt)) && isWithinSendWindowET(new Date(inHoursEnd))) return inHoursEnd;
  return nextSendWindowOpenET(new Date(readyAt)).getTime() + SEND_SLOT_MS;
}

/** Bounded catch-up, exported for tests: past the send slot, or past the overall age belt. */
function tooOldToText(row, now = Date.now()) {
  const createdAt = new Date(row.created_at).getTime();
  if (!Number.isFinite(createdAt) || now - createdAt > MAX_CALL_AGE_MS) return true;
  const deadline = sendSlotDeadline(row);
  return deadline === null || now > deadline;
}

// This lane's in-flight claim row — lead_id NULL (a voicemail-lane row always
// has a lead) and still DISPATCHING. Every write after the boundary insert
// is fenced on it, so this lane never touches a claim it did not take.
function ownInFlightClaim(phone, dbi = db) {
  return dbi('voicemail_sms_claims').where({ phone, outcome: CLAIM.DISPATCHING }).whereNull('lead_id');
}
function releaseClaim(phone) {
  return ownInFlightClaim(phone).del()
    .catch((err) => logger.warn(`[missed-call-text-back] claim release failed for ${maskPhone(phone)} (${err?.code || err?.name || 'error'})`));
}
// Keep the claim with its final outcome. `claimed` false means the provider
// consumed the one-shot without the boundary check ever taking the row (a
// path that skipped it) — record it anyway so neither lane texts again.
function keepClaim(phone, outcome, claimed) {
  const write = claimed
    ? ownInFlightClaim(phone).update({ outcome })
    : db('voicemail_sms_claims').insert({ phone, lead_id: null, outcome }).onConflict('phone').ignore();
  return write.catch((err) => logger.warn(`[missed-call-text-back] claim stamp failed for ${maskPhone(phone)} (${err?.code || err?.name || 'error'})`));
}

// sms_log rows that are a text that actually reached the other side — the
// definition lead-auto-reply.js's delayed-reply check uses: an inbound
// text, or an outbound one Twilio accepted (a real SM/MM sid) that was not
// scheduled, cancelled or bounced. Never an unresolved send reservation (a
// 'sending' placeholder — gratitude coordination writes one for THIS send
// before the boundary; a failed send deletes its own).
function deliveredTexts(dbi) {
  return excludeUnresolvedSendReservations(dbi('sms_log'))
    .where((q) => q.where({ direction: 'inbound' })
      .orWhere((out) => out.where({ direction: 'outbound' })
        .whereRaw("COALESCE(twilio_sid, '') ~ '^(SM|MM)'")
        .where((st) => st.whereNull('status').orWhereNotIn('status', UNSENT_STATUSES))));
}

// "Still uncontacted" — checked before the lease work and again at the
// provider boundary (owner: "only if nobody has called or texted them by
// then"): no customer record knows the number now, we haven't called them
// since the missed call, no later call from them was answered (by a person
// or Sandy) or left a voicemail, no text reached them or came from them
// since, and no staff reply to them is scheduled or mid-send (the human
// wins — lead-auto-reply.js's same rule). This lane's own texts are never
// contact: they are the one-shot claim's business.
async function stillUncontacted(phone, row, dbi = db) {
  if (await knownCallerPhoneExists(dbi, phone)) return false;
  const digits = phone.replace(/\D/g, '').slice(-10);
  if (digits.length !== 10) return true;
  const phoneMatches = (column) => [`RIGHT(regexp_replace(COALESCE(${column}, ''), '[^0-9]', '', 'g'), 10) = ?`, [digits]];
  const laterCall = await dbi('call_log')
    .modify((q) => whereNotSandboxCall(q)) // a Sandy bake-off call is not contact
    .where('created_at', '>=', row.created_at)
    .whereNot('id', row.id)
    .where((q) => q
      .where((out) => out.where('direction', 'outbound').whereRaw(...phoneMatches('to_phone')))
      .orWhere((inb) => inb.where('direction', 'inbound').whereRaw(...phoneMatches('from_phone'))
        .where((handled) => handled
          .whereIn('answered_by', ANSWERED_BY_SOMEONE)
          .orWhereIn('call_outcome', AI_OUTCOMES)
          .orWhereNotNull('recording_sid')
          .orWhereNotNull('recording_url')
          .orWhereNotNull('voicemail_callback_alerted_at'))))
    .first('id');
  if (laterCall) return false;
  const texted = await deliveredTexts(dbi)
    .whereRaw("COALESCE(message_type, '') <> ?", [MESSAGE_TYPE])
    .where('created_at', '>=', row.created_at)
    .where((q) => q.whereRaw(...phoneMatches('from_phone')).orWhereRaw(...phoneMatches('to_phone')))
    .first('id');
  if (texted) return false;
  const { HUMAN_REPLY_TYPES } = require('./sms-suggest-mode');
  const humanReplyInFlight = await dbi('sms_log')
    .where({ direction: 'outbound' })
    .whereIn('message_type', HUMAN_REPLY_TYPES)
    .whereIn('status', ['scheduled', 'sending'])
    .where('created_at', '>=', row.created_at)
    .whereRaw(...phoneMatches('to_phone'))
    .first('id');
  return !humanReplyInFlight;
}

// A claim this lane took at the provider boundary and never resolved: the
// attempt died between the claim and its outcome. The local sms_log cannot
// prove absence (a post-accept log insert can fail), so ask the provider
// (TwilioService.findOutboundMessageSince, the same reconciliation
// prep-guide-sender.js runs on its stale claims). No outbound message to the
// number since the claim → nothing was sent: release the orphan. A message
// → stamp it sent. No answer → leave it for the next pass. Returns the claim
// row that stands afterwards, or null.
async function reconcileStaleClaim(phone, claim) {
  if (claim.lead_id || claim.outcome !== CLAIM.DISPATCHING) return claim;
  const claimedAt = new Date(claim.created_at).getTime();
  if (!Number.isFinite(claimedAt) || Date.now() - claimedAt < STALE_CLAIM_MS) return claim; // still in flight
  const provider = await require('./twilio').findOutboundMessageSince({ to: phone, sentAfter: claim.created_at });
  if (provider?.found) {
    await ownInFlightClaim(phone).update({ outcome: CLAIM.SENT });
  } else if (provider?.found === false && !provider.unavailable) {
    await ownInFlightClaim(phone).where('created_at', '<', new Date(Date.now() - STALE_CLAIM_MS)).del();
    logger.info(`[missed-call-text-back] Released an orphaned claim for ${maskPhone(phone)} — the provider has no message since it`);
  }
  return (await db('voicemail_sms_claims').where({ phone }).first('lead_id', 'outcome', 'created_at')) || null;
}

// What an existing claim row on the number means for a call: 'in_flight'
// (the other send is mid-handoff, or an orphan not yet reconciled — it may
// still be released, so wait and retry inside the send slot), or the
// consumed one-shot's settle reason.
function claimState(claim) {
  if (claim.lead_id) return claim.outcome === VOICEMAIL_CLAIM_IN_FLIGHT ? 'in_flight' : 'voicemail_lead_texted';
  return claim.outcome === CLAIM.DISPATCHING ? 'in_flight' : 'already_sent_to_phone';
}

// An earlier first-touch text to this number — a settle reason, 'in_flight',
// or null — as the early skip before any pipeline work (the atomic guarantee
// is the boundary claim). Reads the shared claim row (this lane's own or the
// voicemail lane's, a landline stamped there included — a landline stays a
// landline), then the sms_log history of both lanes' message types — texts
// that actually went out only (deliveredTexts): an unresolved reservation's
// fate is the claim's business, and a reconciled orphan the provider proved
// unsent, or a bounced text, must not survive here as a completed one.
async function priorTextReason(phone) {
  const found = await db('voicemail_sms_claims').where({ phone }).first('lead_id', 'outcome', 'created_at');
  const claim = found && await reconcileStaleClaim(phone, found);
  if (claim) return claimState(claim);
  const sentBefore = (messageType) => deliveredTexts(db)
    .where({ to_phone: phone, message_type: messageType })
    .first('id');
  if (await sentBefore(MESSAGE_TYPE)) return 'already_sent_to_phone';
  return (await sentBefore('voicemail_quote_link')) ? 'voicemail_lead_texted' : null;
}

// Orphan cleanup, independent of any call: a claim this lane left unresolved
// blocks BOTH lanes on that number — including the voicemail lane on a later
// voicemail this lane never sees, and after the call that took it has aged
// out. Run by every sweep pass, gate on or off (it only resolves this lane's
// own rows; it sends nothing). Bounded per pass.
async function reconcileOrphanedClaims({ limit = 20 } = {}) {
  const stale = await db('voicemail_sms_claims')
    .whereNull('lead_id')
    .where('outcome', CLAIM.DISPATCHING)
    .where('created_at', '<', new Date(Date.now() - STALE_CLAIM_MS))
    .orderBy('created_at', 'asc')
    .limit(limit)
    .select('phone', 'lead_id', 'outcome', 'created_at');
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
// terminal outcome is safe to settle immediately without a fence. Pure
// checks and the window come first, so an after-hours call waiting for
// 8 AM costs the 2-minute sweep no queries.
async function precheckRow(row, now) {
  if (tooOldToText(row, now)) return { ok: false, outcome: 'skipped:too_old', reason: 'too_old' };

  const fromNumber = fromNumberForDialed(row.to_phone);
  if (!fromNumber) return { ok: false, outcome: 'skipped:unsupported_line', reason: 'unsupported_line' };

  const phone = normalizePhoneE164(row.from_phone);
  if (!phone) return { ok: false, outcome: 'skipped:bad_phone', reason: 'bad_phone' };
  // A Waves line or a staff forward / CSR cell calling in is never a lead
  // (same exclusion as outbound-voicemail-sms.js).
  if (TWILIO_NUMBERS.isInternalNumber(phone)) return { ok: false, outcome: 'skipped:internal_number', reason: 'internal_number' };

  if (!isWithinSendWindowET(new Date(now))) {
    // Never sent in the moment outside 8am-8pm ET. Stays unsettled — the
    // sweep re-evaluates every 2 minutes and sends inside the call's slot.
    return { ok: false, deferred: true, nextAttemptAt: nextSendWindowOpenET(new Date(now)) };
  }

  // In-hours voicemail-landing grace, from when the call ended — same
  // window the bell's own sweep uses (a voicemail can still be
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
async function sendWithLease(row, { fromNumber, phone }, releaseLease, settleFenced) {
  try {
    // A resumed lease whose earlier attempt sent the text but crashed before
    // settling 'sent' is caught by priorTextReason below (the claim row, or
    // this lane's own sms_log row) — never double-texted.
    if (!(await stillUncontacted(phone, row))) {
      await settleFenced('skipped:already_contacted');
      return { outcome: 'skipped', reason: 'already_contacted' };
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
  } catch (e) {
    await releaseLease();
    logger.warn(`[missed-call-text-back] contact recheck failed — releasing lease (fail closed): ${e.code || e.name || 'db_error'}`);
    return { outcome: 'error' };
  }

  // requiredVars: an admin edit or a weighted variant that drops the
  // callback number never renders (the same list guards template edits).
  const { REQUIRED_TEMPLATE_PLACEHOLDERS } = require('../routes/admin-sms-templates');
  const body = await renderSmsTemplate(MESSAGE_TYPE, {
    callback_clause: callbackClause(fromNumber),
  }, {
    workflow: MESSAGE_TYPE,
    entity_type: 'call_log',
    entity_id: row.id,
  }, { requiredVars: REQUIRED_TEMPLATE_PLACEHOLDERS[MESSAGE_TYPE] });
  if (!body) {
    await releaseLease();
    logger.info(`[missed-call-text-back] Template ${MESSAGE_TYPE} missing/disabled — skipped for ${maskPhone(phone)}`);
    return { outcome: 'skipped', reason: 'template_disabled' };
  }

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
 * voicemail lane's), still uncontacted, then the one-shot claim (taken here
 * and nowhere earlier), then, as the last step after the last await, a
 * fresh clock against the 8am-8pm window and the call's send slot. A
 * refusal after the claim leaves it to classifySendOutcome to release.
 */
function providerBoundaryCheck(row, phone, attempt) {
  return async ({ dbi = db } = {}) => {
    try {
      const current = await dbi('call_log').where({ id: row.id }).modify(whereNotBlockedCall).first();
      if (!textBackCoreEligible(current)) {
        return { ok: false, code: BOUNDARY.NOT_MISSED, reason: 'the call is no longer an unanswered, message-less miss' };
      }
      if (!(await stillUncontacted(phone, row, dbi))) {
        return { ok: false, code: BOUNDARY.CONTACTED, reason: 'the caller was contacted after the missed call' };
      }
      const claimed = await dbi('voicemail_sms_claims')
        .insert({ phone, lead_id: null, outcome: CLAIM.DISPATCHING })
        .onConflict('phone')
        .ignore()
        .returning('phone');
      if (!claimed?.length) {
        const holder = await dbi('voicemail_sms_claims').where({ phone }).first('lead_id', 'outcome');
        return !holder || claimState(holder) === 'in_flight'
          ? { ok: false, code: BOUNDARY.CLAIM_BUSY, reason: 'another send holds this number', retryable: true }
          : { ok: false, code: BOUNDARY.CLAIMED, reason: 'this number was already texted' };
      }
      attempt.claimed = true;
      const now = Date.now();
      if (!isWithinSendWindowET(new Date(now))) {
        return { ok: false, code: BOUNDARY.WINDOW, reason: 'outside 8am-8pm ET', retryable: true };
      }
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
      },
    });
    return { value };
  } catch (err) {
    if (err?.providerOutcome && typeof err.providerOutcome === 'object') return { value: err.providerOutcome };
    return { threw: true, err };
  }
}

// providerBoundaryCheck's terminal refusals: nothing reached the provider.
// (A claim is held only for the post-claim clock refusals; released below.)
const BOUNDARY_SETTLES = {
  [BOUNDARY.NOT_MISSED]: 'not_missed',
  [BOUNDARY.CONTACTED]: 'already_contacted',
  [BOUNDARY.TOO_OLD]: 'too_old',
  [BOUNDARY.CLAIMED]: 'already_sent_to_phone',
};

async function classifySendOutcome(result, phone, attempt, row, { releaseLease, settleFenced }) {
  if (result.sent && isRealProviderSend(result)) {
    await keepClaim(phone, CLAIM.SENT, attempt.claimed);
    await settleFenced('sent');
    logger.info(`[missed-call-text-back] Sent to ${maskPhone(phone)} (call_log ${row.id})`);
    return { outcome: 'sent' };
  }
  if (isAmbiguousProviderOutcome(result)) {
    // The provider may still hold the text — keep the claim (a missed text
    // beats a doubled one) and settle; neither lane retries this number.
    await keepClaim(phone, CLAIM.UNCERTAIN, attempt.claimed);
    await settleFenced('skipped:provider_uncertain');
    return { outcome: 'skipped', reason: 'provider_uncertain' };
  }
  const boundaryReason = !result.sent && BOUNDARY_SETTLES[result.code];
  if (boundaryReason) {
    if (attempt.claimed) await releaseClaim(phone);
    await settleFenced(`skipped:${boundaryReason}`);
    return { outcome: 'skipped', reason: boundaryReason };
  }
  if (!result.sent && (result.terminal === true || (result.blocked && !result.retryable && !result.deferred))) {
    // Terminal: a policy refusal (STOP/suppression, no consent, the
    // landline validator) or a permanent provider rejection. Nothing was
    // sent. A claim this attempt took is kept as BLOCKED — a number that
    // can never take a text is not retried by either lane.
    const reason = result.code || (result.terminal === true ? 'provider_rejected' : 'policy_block');
    if (attempt.claimed) await keepClaim(phone, CLAIM.BLOCKED, true);
    await settleFenced(`skipped:${reason}`);
    return { outcome: 'skipped', reason };
  }
  // Nothing left the system and the failure can clear: an upstream
  // suppression sentinel (sent:true with no real send — a gate or template
  // raced off), a hold the pipeline says to retry (the window boundary, a
  // callback-number hold, this lane's own window/recheck refusals) or a
  // non-terminal provider failure. Release both so a later sweep pass
  // retries inside the send slot.
  if (attempt.claimed) await releaseClaim(phone);
  await releaseLease();
  return { outcome: 'error', reason: result.sent ? 'send_suppressed' : (result.code || 'provider_failed') };
}

/**
 * Attempt (or defer, or skip) a text-back for one call_log row. Shared core
 * for both the post-call hook and the durable sweep so the two paths can
 * never diverge. Returns { outcome: 'sent' | 'deferred' | 'pending' | 'skipped' | 'error', reason? }.
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
    if (pre.deferred) return { outcome: 'deferred', nextAttemptAt: pre.nextAttemptAt };
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

  return sendWithLease(row, pre, releaseLease, settleFenced);
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
 * eligible unknown-caller misses — in-hours calls the post-call hook hasn't
 * reached yet, and after-hours calls waiting for the next 8 AM ET.
 * Idempotent — attemptForRow's own lease + claim make a re-offer a no-op.
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
      .whereRaw('COALESCE(updated_at, created_at) < ?', [new Date(now - VOICEMAIL_GRACE_MS)])
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
        // window or send slot by the time the pass started.
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
  // voicemail-lead-sms.js resolves a stale claim of this lane's the same way.
  reconcileStaleClaim,
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
    stillUncontacted,
    priorTextReason,
    providerBoundaryCheck,
    reconcileOrphanedClaims,
  },
};
