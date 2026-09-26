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
 * One text per phone number EVER — an atomic claim on sms_send_claims
 * (key `missed_call_text:<E164>`, never pruned: sms-send-claims.js
 * PERMANENT_CLAIM_PREFIXES), plus an sms_log history check. Released only
 * on an outcome that never consumed the one-shot (template disabled, a
 * pipeline hold, a non-terminal provider failure) — never on a real send
 * or a terminal block.
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

const GATE = 'missedCallTextBack';
const MESSAGE_TYPE = 'missed_call_text_back';
// Listed in sms-send-claims.js PERMANENT_CLAIM_PREFIXES so the shared daily
// prune never deletes it (a pruned claim would let the number be texted
// again).
const CLAIM_PREFIX = 'missed_call_text:';
// Same lease length / shape as missed-call-bell.js — long enough to cover
// the lookups + send, reclaimable by the sweep once stale.
const LEASE_MS = 10 * 60 * 1000;
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
 * When the call's one send slot closes (ms epoch), or null when its
 * timestamps are unreadable. The slot opens when the call clears the
 * voicemail-landing grace (measured from its terminal update, the same
 * clock the bell uses). If the window is closed then, or closes before the
 * slot would run out, the slot moves to the next 8 AM ET instead — the
 * owner's after-hours rule.
 */
function sendSlotDeadline(row) {
  const terminalAt = new Date(row.updated_at || row.created_at).getTime();
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

// Atomic one-text-per-number-EVER claim on the shared sms_send_claims table
// (the same cross-process gate tech-line / bi-briefing-sms /
// outbound-voicemail-sms use) — a plain conflict-free insert, same
// semantics as voicemail_sms_claims' one-shot-forever phone claim. No
// staleness reclaim: there is no legitimate retry window for an EVER send,
// so a claim row is released explicitly (see releaseClaim) on every outcome
// that never consumed the one-shot, never reclaimed by age.
async function claimPhone(phone) {
  const claim = await db.raw(
    `INSERT INTO sms_send_claims (claim_key) VALUES (?)
     ON CONFLICT (claim_key) DO NOTHING
     RETURNING id`,
    [CLAIM_PREFIX + phone],
  );
  return (claim?.rows || []).length > 0;
}
function releaseClaim(phone) {
  return db('sms_send_claims').where({ claim_key: CLAIM_PREFIX + phone }).del()
    .catch((err) => logger.warn(`[missed-call-text-back] claim release failed for ${maskPhone(phone)} (${err?.code || err?.name || 'error'})`));
}

// "Still uncontacted" — re-checked right before send (owner: "only if
// nobody has called or texted them by then"): no customer record knows the
// number now, we haven't called them since the missed call, no later call
// from them was answered (by a person or Sandy) or left a voicemail, and no
// SMS either way since the missed call.
async function stillUncontacted(phone, row) {
  if (await knownCallerPhoneExists(db, phone)) return false;
  const digits = phone.replace(/\D/g, '').slice(-10);
  if (digits.length === 10) {
    const phoneMatches = (column) => [`RIGHT(regexp_replace(COALESCE(${column}, ''), '[^0-9]', '', 'g'), 10) = ?`, [digits]];
    const laterCall = await db('call_log')
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
  }
  const smsSince = await db('sms_log')
    .where((q) => q.where('to_phone', phone).orWhere('from_phone', phone))
    .where('created_at', '>=', row.created_at)
    .first('id');
  return !smsSince;
}

// An earlier unprompted first-touch text to this number, or null: this
// lane's own (belt-and-suspenders under the claim — the sms_log row
// outlives any claim), or the voicemail-lead-sms lane's (its own
// one-per-number-ever claim table + sms_log message_type). A landline
// stamped by that lane counts too — a landline stays a landline.
async function priorTextReason(phone) {
  const own = await db('sms_log').where({ to_phone: phone, message_type: MESSAGE_TYPE }).first('id');
  if (own) return 'already_sent_to_phone';
  const claimed = await db('voicemail_sms_claims').where({ phone }).first('phone');
  if (claimed) return 'voicemail_lead_texted';
  const logged = await db('sms_log').where({ to_phone: phone, message_type: 'voicemail_quote_link' }).first('id');
  return logged ? 'voicemail_lead_texted' : null;
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

  if (!isWithinSendWindowET(new Date(now))) {
    // Never sent in the moment outside 8am-8pm ET. Stays unsettled — the
    // sweep re-evaluates every 2 minutes and sends inside the call's slot.
    return { ok: false, deferred: true, nextAttemptAt: nextSendWindowOpenET(new Date(now)) };
  }

  // In-hours voicemail-landing grace, from the terminal update — same
  // window the bell's own sweep uses (a voicemail can still be
  // recording/uploading right after the terminal status lands).
  const terminalAt = new Date(row.updated_at || row.created_at).getTime();
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
    // Also doubles as a safety net on a resumed lease: if a prior attempt
    // sent the text but crashed before settling 'sent', stillUncontacted
    // finds that same sms_log row and this retry skips instead of sending
    // a second text — settled here as already_contacted rather than sent,
    // which is a fine label for "a message already went to this number".
    if (!(await stillUncontacted(phone, row))) {
      await settleFenced('skipped:already_contacted');
      return { outcome: 'skipped', reason: 'already_contacted' };
    }
    const prior = await priorTextReason(phone);
    if (prior) {
      await settleFenced(`skipped:${prior}`);
      return { outcome: 'skipped', reason: prior };
    }
  } catch (e) {
    await releaseLease();
    logger.warn(`[missed-call-text-back] contact recheck failed — releasing lease (fail closed): ${e.code || e.name || 'db_error'}`);
    return { outcome: 'error' };
  }

  let claimed;
  try {
    claimed = await claimPhone(phone);
  } catch (e) {
    await releaseLease();
    logger.warn(`[missed-call-text-back] send claim failed — releasing lease (fail closed): ${e.code || e.name || 'db_error'}`);
    return { outcome: 'error' };
  }
  if (!claimed) {
    await settleFenced('skipped:already_sent_to_phone');
    return { outcome: 'skipped', reason: 'already_sent_to_phone' };
  }

  const body = await renderSmsTemplate(MESSAGE_TYPE, {
    callback_clause: callbackClause(fromNumber),
  }, {
    workflow: MESSAGE_TYPE,
    entity_type: 'call_log',
    entity_id: row.id,
  });
  if (!body) {
    await releaseClaim(phone);
    await releaseLease();
    logger.info(`[missed-call-text-back] Template ${MESSAGE_TYPE} missing/disabled — skipped for ${maskPhone(phone)}`);
    return { outcome: 'skipped', reason: 'template_disabled' };
  }

  const result = await dispatchOrThrown(row, phone, body, fromNumber);
  if (result.threw) {
    await releaseClaim(phone);
    await releaseLease();
    logger.warn(`[missed-call-text-back] send threw for ${maskPhone(phone)}: ${result.err.code || result.err.name || 'error'}`);
    return { outcome: 'error' };
  }
  return classifySendOutcome(result.value, phone, row, { releaseLease, settleFenced });
}

// Isolates the try/catch around the provider call: a real or ambiguous
// outcome carried on a thrown error's .providerOutcome is treated the same
// as a returned result (the pipeline's own contract).
async function dispatchOrThrown(row, phone, body, fromNumber) {
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
      metadata: {
        original_message_type: MESSAGE_TYPE,
        call_sid: row.twilio_call_sid,
        call_log_id: row.id,
        fromNumber,
      },
    });
    return { value };
  } catch (err) {
    if (isRealProviderSend(err?.providerOutcome) || isAmbiguousProviderOutcome(err?.providerOutcome)) {
      return { value: err.providerOutcome };
    }
    return { threw: true, err };
  }
}

async function classifySendOutcome(result, phone, row, { releaseLease, settleFenced }) {
  if (result.sent && isRealProviderSend(result)) {
    await settleFenced('sent');
    logger.info(`[missed-call-text-back] Sent to ${maskPhone(phone)} (call_log ${row.id})`);
    return { outcome: 'sent' };
  }
  if (result.sent) {
    // Upstream suppression sentinel (a downstream gate/template raced off
    // between the render above and here) — no text left the system and the
    // one-shot was never consumed. Release both so a later sweep pass,
    // inside the send slot, can retry once the config recovers.
    await releaseClaim(phone);
    await releaseLease();
    return { outcome: 'error', reason: 'send_suppressed' };
  }
  if (isAmbiguousProviderOutcome(result)) {
    // The provider may still hold the text — KEEP the phone claim (a missed
    // text beats a doubled one). Release only the call lease; the next
    // sweep pass finds the phone already claimed and settles the call as
    // already_sent_to_phone, with no risk of a second send either way.
    await releaseLease();
    return { outcome: 'error', reason: 'ambiguous_provider_outcome' };
  }
  if (result.terminal === true || (result.blocked && !result.retryable && !result.deferred)) {
    // Terminal: a policy refusal (STOP/suppression, no consent, the
    // landline validator) or a permanent provider rejection. Keep the claim
    // — this number is not to be retried.
    await settleFenced(`skipped:${result.code || 'policy_block'}`);
    return { outcome: 'skipped', reason: result.code || 'policy_block' };
  }
  // Nothing left the system and the one-shot was never consumed: a hold the
  // pipeline says to retry (a send-window boundary, a callback-number hold,
  // a consent recheck that could not run) or a non-terminal provider
  // failure. Release both so a later sweep pass retries inside the slot.
  await releaseClaim(phone);
  await releaseLease();
  return { outcome: 'error', reason: result.code || 'provider_failed' };
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
        const result = await attemptForRow(r, now);
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
  CLAIM_PREFIX,
  MAX_CALL_AGE_MS,
  SEND_SLOT_MS,
  VOICEMAIL_GRACE_MS,
  textBackIfMissed,
  sweepMissedCallTextBacks,
  _private: {
    textBackCoreEligible,
    sendSlotDeadline,
    tooOldToText,
    callbackClause,
    fromNumberForDialed,
    normalizePhoneE164,
    attemptForRow,
    stillUncontacted,
    priorTextReason,
  },
};
