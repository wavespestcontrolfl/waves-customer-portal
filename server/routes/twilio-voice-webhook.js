const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const twilio = require('twilio');
const VoiceResponse = twilio.twiml.VoiceResponse;
const { alertTwilioFailure, isFailureStatus } = require('../services/twilio-failure-alerts');
const { recordTouchpoint, syncVoiceMessageForCall } = require('../services/conversations');
const { tryClaimInboundWebhook, releaseInboundWebhook } = require('../services/messaging/inbound-dedupe');
const { getCallRoutingConfig } = require('../services/call-routing-config');
const { decideVoiceRoute } = require('../services/voice-route-decision');
const { buildRelayTwiML, RELAY_WS_PATH } = require('../services/voice-agent/relay-protocol');
const { isRelayAttached } = require('../services/voice-agent/relay-server');

// Single TTS voice for every <Say> in the voice flow. The flow previously
// mixed three tiers — legacy `alice`, standard Polly.Joanna, and bare <Say>
// (Twilio default voice) — which sounded like three different robots on one
// call. Polly.Joanna-Neural is the highest GA/SLA-covered tier of the same
// Joanna voice; the pre-recorded ElevenLabs brand assets remain <Play>.
// Env-swappable without a code change.
const SAY_VOICE = process.env.TWILIO_SAY_VOICE || 'Polly.Joanna-Neural';

function notifyTwilioFailure(payload) {
  void alertTwilioFailure(payload).catch((err) => {
    logger.error(`[twilio-alerts] async notification failed: ${err.message}`);
  });
}

function scheduleRecordingRecovery(callSid) {
  if (!callSid) return;
  setTimeout(async () => {
    try {
      const processor = require('../services/call-recording-processor');
      if (processor.recoverRecordingForCall) await processor.recoverRecordingForCall(callSid);
    } catch (err) {
      logger.warn(`[call-status] Recording recovery failed for ${maskSid(callSid)}: ${err.message}`);
    }
    // After recordings had their chance to land: a customer's unanswered
    // call with no voicemail rings the missed-call bell (owner ruling
    // 2026-08-28). The terminal status lands BEFORE the caller enters
    // voicemail (up to 120s of recording + the recording callback), so the
    // bell waits a further 3 minutes — 5 from the terminal update, the same
    // grace the durable sweep uses (codex r6). Idempotent per call inside.
    setTimeout(async () => {
      try {
        await require('../services/missed-call-bell').ringMissedCallIfUnanswered(callSid);
      } catch (err) {
        logger.warn(`[call-status] missed-call bell failed for ${maskSid(callSid)}: ${err.message}`);
      }
    }, 3 * 60 * 1000);
  }, 2 * 60 * 1000);
}

// Phone normalization consolidated to server/utils/phone.js (PR1 of
// call-triage work — see docs/call-triage-discovery.md §9). The unified
// implementation is the verbatim toE164 contract that previously lived
// here: preserve `+`-prefixed country codes for non-NANP callers and
// fall back to raw on garbage.
const { toE164, isLikelyE164 } = require('../utils/phone');

function phoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

// Shared with the admin spam-disposition guard (utils/known-caller-phone).
const { customerPhoneLookupKey, knownCallerPhoneExists } = require('../utils/known-caller-phone');

function maskPhone(value) {
  const digits = phoneDigits(value);
  return digits ? `***${digits.slice(-4)}` : 'unknown';
}

// Raw phone-match fetch (up to 2 rows). Callers that need to LINK a customer
// use findSingleCustomerByPhone below (1 match or nothing); callers that only
// need to know whether ANY customer exists on this number — like the
// pre-connect screen's known-customer bypass — check length > 0, because a
// number shared by 2+ records is still unmistakably a known caller even
// though it is not safe to auto-link.
async function findCustomerPhoneMatches(dbLike, phone) {
  const key = customerPhoneLookupKey(phone);
  if (!key) return [];

  const query = dbLike('customers').whereNull('deleted_at');
  if (key.length === 10) {
    query.whereRaw(
      "(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = ? OR regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = ?)",
      [key, `1${key}`]
    );
  } else {
    query.whereRaw("regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = ?", [key]);
  }

  return query.orderBy('updated_at', 'desc').limit(2);
}

async function findSingleCustomerByPhone(dbLike, phone) {
  const matches = await findCustomerPhoneMatches(dbLike, phone);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    logger.warn(`[voice] ${matches.length} customers share caller phone ${maskPhone(phone)}; not auto-linking call_log`);
  }
  return null;
}

// Screen-bypass identity check lives in utils/known-caller-phone.js —
// ONE mechanism shared with the admin spam-disposition guard, so the set of
// numbers the screen lets through and the set we refuse to hard-block can
// never drift apart. Column set = pipeline identity cols + secondary_phone.

// Builds the spoken caller name stamped into call_log at /voice time and read
// back in the post-accept connect announcement. A matched customer/lead yields a
// name; an unmatched caller (or a number shared by 2+ records, which
// findSingleCustomerByPhone deliberately returns null for) yields null and the
// announcement falls back to the number. Mirrors the sanitize-and-cap pattern
// used by /outbound-admin-prompt and /lead-alert-announce.
function spokenCallerName(customer) {
  if (!customer) return null;
  const name = [customer.first_name, customer.last_name]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/[^\p{L}\p{N}\s.'’-]/gu, '')
    .trim()
    .slice(0, 60);
  return name || null;
}

// Spoken to the staff member AFTER they press 1 to accept — by which point a
// human, never carrier voicemail, is on the line — so it is safe to read caller
// identity here. Derived from the persisted call_log row (name stamped into
// metadata by /voice), never from a URL. A matched customer/lead is announced
// by name; everyone else is announced as an unknown number (the digits
// themselves are intentionally not read aloud).
function connectingAnnouncement(row) {
  const meta = parseJsonObject(row?.metadata);
  const name = String(meta.screen_caller_name || '')
    .replace(/[^\p{L}\p{N}\s.'’-]/gu, '')
    .trim()
    .slice(0, 60);
  // Sandy PR 2A: a transferred call carries its ≤20-word whisper — read from
  // the persisted packet only, spoken only here (after press-1; the screen
  // leg stays generic). No packet ⇒ today's line.
  // A transfer whose BOTH packet writes failed still carries the outcome
  // stamp: the generic whisper prompts the recap (codex r1 P2).
  if ((meta.relay_handoff && typeof meta.relay_handoff === 'object') || row?.call_outcome === 'ai_transferred') {
    const { transferWhisper } = require('../services/voice-agent/relay-transfer');
    return transferWhisper(meta.relay_handoff, name);
  }
  if (name) return `Connecting your call from ${name}.`;
  return 'Connecting your call from an unknown number.';
}

/**
 * The staff simul-ring: <Dial record> with the press-1 screen on every leg
 * and /call-complete as the action. Shared by /voice and the PR 2A transfer
 * in /relay-complete — one shape, so the screen URLs never diverge.
 */
function appendStaffRingDial(twiml, forwardNumbers, ringTimeoutSec, { language = null } = {}) {
  const dial = twiml.dial({
    record: 'record-from-answer-dual',
    recordingStatusCallback: '/api/webhooks/twilio/recording-status',
    recordingStatusCallbackEvent: 'completed',
    timeout: ringTimeoutSec,
    // A Spanish caller's selection rides the action (the ?lang=es the relay
    // leg already uses), so an unanswered ring's voicemail stays Spanish.
    action: /^es/i.test(String(language || '')) ? '/api/webhooks/twilio/call-complete?lang=es' : '/api/webhooks/twilio/call-complete',
    answerOnBridge: true,
  });
  for (const number of forwardNumbers) {
    dial.number({
      url: '/api/webhooks/twilio/inbound-forward-screen',
      method: 'POST',
    }, number);
  }
  return dial;
}

async function fetchTwilioCall(callSid) {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return null;
  try {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    return await client.calls(callSid).fetch();
  } catch (err) {
    logger.warn(`[recording-status] Twilio call metadata lookup failed for ${maskSid(callSid)}: ${err.message}`);
    return null;
  }
}

function maskSid(sid) {
  if (!sid) return 'none';
  const value = String(sid);
  if (value.length <= 8) return `${value.slice(0, 2)}…`;
  return `${value.slice(0, 2)}…${value.slice(-6)}`;
}

// ── Recording-callback idempotency ─────────────────────────────────────────
// Twilio delivers /recording-status at least once, not exactly once: a retry
// after a webhook timeout (the 2026-08-29 pool-exhaustion 502s), and the
// ring-first flow's SECOND recording (outer <Dial record> + inner voicemail
// <Record> share one CallSid). Applying every delivery as a blind overwrite
// desynchronised rows: a retry reset transcription_status to 'pending' on a
// row whose transcript was already complete, and a second recording landing
// after processing swapped recording_url out from under the transcript and
// extraction that were built from the first one — with processRecording
// then skipping the row as already_processed, nothing ever reconciled it.
//
// Pure decision, exported for tests. `row` is the call_log row the callback
// resolved to; `incoming` is the callback's recording.
//   attach    — the row has no recording yet: store it (first delivery).
//   duplicate — same RecordingSid again: touch nothing, still schedule the
//               (claim-fenced, idempotent) processing attempt.
//   replace   — a DIFFERENT recording on a row nothing has finished on:
//               last-wins as before (the voicemail recording superseding the
//               short dial-leg recording is the normal ring-first order), the
//               superseded recording is kept in metadata, and the row's
//               processing_status is reset to NULL in the same write so the
//               sweep re-runs it on the new audio (voicemail/spam rows would
//               otherwise never re-enter the sweep with a transcript present).
//   park      — a different recording on a row that is being processed or
//               already finished: never overwrite the recording the transcript
//               came from. Kept in metadata.additional_recordings and surfaced
//               for review; the office adopts it deliberately.
function isPanQuarantinedRow(row) {
  const raw = row?.transcription_metadata;
  try {
    const meta = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
    return String(meta?.pan_detected) === 'true';
  } catch {
    return false;
  }
}

// Statuses under which the recording on the row is load-bearing: a pass is
// reading it right now, or the transcript/extraction/lead were built from it
// and no automatic pass will ever run again. Every OTHER status (NULL,
// pending, voicemail, spam, no_transcription, extraction_failed) re-transcribes
// from recording_url on its next pass, so a replacement stays consistent.
// …and the finished downstream-failure states: extraction ran and cards,
// leads or notifications may already exist for that audio, so a different
// recording is parked for a deliberate decision, never swapped in and
// auto-reprocessed.
const RECORDING_LOAD_BEARING_STATUSES = new Set(['processing', 'processed', 'customer_creation_failed', 'lead_creation_failed']);
// The attach/replace write re-checks the same set IN the statement (a pass
// can land any of them between the read and the write). Built from the set
// so the decision and the fence can never name different statuses.
const NOT_LOAD_BEARING_SQL = `(processing_status IS NULL OR processing_status NOT IN (${[...RECORDING_LOAD_BEARING_STATUSES].map((s) => `'${s}'`).join(', ')}))`;

function listedRecordingReason(metadata, sid) {
  try {
    const m = typeof metadata === 'string' ? JSON.parse(metadata) : (metadata || {});
    const has = (list) => (Array.isArray(m[list]) ? m[list] : []).some((e) => e && e.recording_sid === sid);
    if (has('superseded_recordings')) return 'already_superseded';
    if (has('additional_recordings')) return 'already_parked';
    return null;
  } catch { return null; }
}

function decideRecordingAttach(row, incoming) {
  const currentSid = row?.recording_sid || null;
  const currentUrl = String(row?.recording_url || '').trim();
  if (currentSid && incoming?.recording_sid && currentSid === incoming.recording_sid) {
    return { action: 'duplicate' };
  }
  // A retry of a recording this row already SUPERSEDED or PARKED is a
  // duplicate too: matched only against the current SID, REC1's retry after
  // REC2 replaced it would replace REC2 back (and process the older audio)
  // or park REC1 with a spurious card.
  const listed = incoming?.recording_sid ? listedRecordingReason(row?.metadata, incoming.recording_sid) : null;
  if (listed) return { action: 'duplicate', reason: listed };
  // A pass in flight, or one that finished, on a row with NO recording yet
  // (a PAN-masked transcript pass, a manual Process on a cached Twilio
  // transcript) is load-bearing too: installing the first recording under
  // it would let that pass finalize as processed without ever transcribing
  // the audio, and the retry would then skip it as already_processed.
  const status = row?.processing_status == null ? null : String(row.processing_status);
  if (RECORDING_LOAD_BEARING_STATUSES.has(status)) {
    return { action: 'park', reason: `processing_status_${status}` };
  }
  if (!currentSid && !currentUrl) return { action: 'attach' };
  return {
    action: 'replace',
    superseded: {
      recording_sid: currentSid,
      recording_url: currentUrl || null,
      recording_duration_seconds: row?.recording_duration_seconds ?? null,
    },
  };
}

// ── Call-status monotonicity ──────────────────────────────────────────────
// Twilio's status callbacks are not ordered: an outbound call registers
// initiated/ringing/answered/completed, and a retried or delayed 'ringing'
// arriving after 'completed' must not roll a finished call back to ringing —
// recoverMissingRecentRecordings and the unrecorded-call watchdog only look at
// status='completed' rows, so a downgraded row silently leaves their sweep.
const TERMINAL_CALL_STATUSES = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled']);

function nextCallStatus(existingStatus, incomingStatus) {
  if (!incomingStatus) return existingStatus || null;
  // `completed` is absorbing: a call that connected stays completed however
  // late a busy/failed/no-answer callback for one of its legs arrives. An
  // unsuccessful terminal may still advance to completed.
  if (existingStatus === 'completed') return existingStatus;
  if (TERMINAL_CALL_STATUSES.has(existingStatus) && !TERMINAL_CALL_STATUSES.has(incomingStatus)) {
    return existingStatus;
  }
  return incomingStatus;
}

// ── Built-in transcription precedence ─────────────────────────────────────
// The voicemail <Record transcribe> fires /transcription with Twilio's rough
// built-in text, usually a minute or two after the recording — often AFTER
// the processor has already written the diarized OpenAI transcript the
// extraction ran on. Letting the late built-in text overwrite that swapped
// the displayed transcript for one the extraction never saw. The built-in
// text is a fallback: it fills an empty row, or replaces its own earlier
// copy, and never displaces a provider transcript.
function builtinTranscriptMayReplace(row) {
  if (!row) return false;
  if (!row.transcription) return true;
  const provider = row.transcription_provider ? String(row.transcription_provider) : null;
  if (!provider || provider === 'twilio_builtin') return true;
  // Sandy PR 2A: a transferred call's row may still carry the relay's OWN
  // transcript when the recording's built-in text arrives (Sandy closed
  // before the unanswered ring reached voicemail). That text is the only
  // recording transcript the row will get if the providers fail — and the
  // AI segment is durable in metadata.relay_transcript (end()'s stash), from
  // which the processor rebuilds the composite. Never for a non-transfer.
  return provider === 'conversation_relay' && (isTransferredRow(row) || isReconnectedRow(row)) && relayTranscriptStashed(row);
}

/** PR 2B: a call that reconnected (relay_reconnects > 0) — its recording is evidence-bearing like a transfer's. */
function isReconnectedRow(row) {
  return (Number(parseJsonObject(row && row.metadata).relay_reconnects) || 0) > 0;
}

/** The AI segment is safe in metadata.relay_transcript (PR 2A) — or in durable metadata.relay_segments (PR 2B: a silent resumed leg wrote no stash). */
function relayTranscriptStashed(row) {
  const meta = parseJsonObject(row && row.metadata);
  if (meta.relay_transcript && typeof meta.relay_transcript === 'object' && String(meta.relay_transcript.text || '').trim()) return true;
  return Array.isArray(meta.relay_segments) && meta.relay_segments.some((seg) => seg && typeof seg === 'object' && String(seg.text || '').trim());
}
// The SQL twin of the rule above, re-checked in the write.
const RELAY_STASHED_TRANSFER_SQL = "(transcription_provider = 'conversation_relay' AND (COALESCE(metadata->'relay_transcript'->>'text', '') <> '' OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(metadata->'relay_segments') = 'array' THEN metadata->'relay_segments' ELSE '[]'::jsonb END) seg WHERE COALESCE(seg->>'text', '') <> '')) AND (metadata->'relay_handoff' IS NOT NULL OR COALESCE(metadata->>'relay_transfer_ring_at', '') <> '' OR call_outcome = 'ai_transferred' OR COALESCE((metadata->>'relay_reconnects')::int, 0) > 0))";

// A second recording that arrived while the row's recording was load-bearing
// (decideRecordingAttach → park). Nothing is lost: the recording rides in
// metadata.additional_recordings, and an advisory Needs Review card names it
// so the office can listen and adopt it deliberately (the adopt-recording
// admin action swaps it in and force-reprocesses). Idempotent per
// RecordingSid: a retried callback does not append twice or file twice.
// Carried by every write that would keep audio on the row — the attach
// UPDATE and the park UPDATE alike — so a PAN stamp landing between the
// handler's read and its write makes the write skip instead of storing
// card audio on a quarantined call.
const NOT_PAN_QUARANTINED_SQL = "(transcription_metadata IS NULL OR (transcription_metadata::jsonb ->> 'pan_detected') IS DISTINCT FROM 'true')";

async function parkAdditionalRecording(row, extra) {
  const entry = {
    recording_sid: extra.recording_sid || null,
    recording_url: extra.recording_url || null,
    recording_duration_seconds: extra.recording_duration_seconds ?? null,
    received_at: new Date().toISOString(),
    parked_because: extra.reason || null,
  };
  const { buildTriageItem } = require('../services/call-routing-gates');
  const card = () => buildTriageItem({
    callLogId: row.id,
    flag: 'additional_recording',
    extraction: null,
    severity: 'advisory',
    extraPayload: {
      recording_sid: entry.recording_sid,
      recording_duration_seconds: entry.recording_duration_seconds,
      parked_because: entry.parked_because,
      kept_recording_sid: row.recording_sid || null,
    },
  });
  // The park and its review card commit TOGETHER: a card insert that fails
  // rolls the park back, the error reaches the handler, and the handler
  // answers 500 so Twilio delivers the callback again — a parked recording
  // with no card would otherwise be invisible to the office for good.
  let appended = 0;
  await db.transaction(async (trx) => {
    appended = await trx('call_log')
      .where({ id: row.id })
      .whereRaw(NOT_PAN_QUARANTINED_SQL)
      // Append only when this RecordingSid is not already parked — a retry
      // of the same callback must not grow the list.
      .whereRaw(
        "NOT COALESCE(metadata -> 'additional_recordings', '[]'::jsonb) @> ?::jsonb",
        [JSON.stringify([{ recording_sid: entry.recording_sid }])],
      )
      // …and never when it is the row's CURRENT recording: a retry decided
      // "already parked" on a read an operator's adoption (or a later
      // callback's replace) has since overtaken would otherwise re-park the
      // active recording and file a spurious adoption card for it (Codex
      // #3736 r12 P2). The fence is in the write, where the race is.
      .whereRaw('recording_sid IS DISTINCT FROM ?', [entry.recording_sid])
      .update({
        metadata: trx.raw(
          "jsonb_set(COALESCE(metadata, '{}'::jsonb), '{additional_recordings}',"
          + " COALESCE(metadata -> 'additional_recordings', '[]'::jsonb) || ?::jsonb, true)",
          [JSON.stringify([entry])],
        ),
      });
    if (appended > 0) {
      // The call is under review the moment its card exists: review_status
      // is the aggregate the dashboard counts (AGENTS.md; Codex #3736 r15
      // P2), set in the same transaction as the card.
      await trx('call_log').where({ id: row.id }).update({ review_status: 'open' });
      // One open card per call: a SECOND parked recording rides the open
      // card's payload (parked_recording_sids) instead of vanishing behind
      // the conflict target, so the office sees every recording it can adopt.
      await trx('triage_items')
        .insert(card())
        .onConflict(trx.raw("(call_log_id, reason_code) WHERE status IN ('open', 'in_progress')"))
        .merge({
          payload: trx.raw(
            "jsonb_set(COALESCE(triage_items.payload, '{}'::jsonb), '{parked_recording_sids}',"
            + " (SELECT COALESCE(jsonb_agg(DISTINCT v), '[]'::jsonb) FROM (SELECT e AS v FROM jsonb_array_elements(COALESCE(triage_items.payload -> 'parked_recording_sids', '[]'::jsonb)) e"
            + " UNION SELECT to_jsonb(triage_items.payload ->> 'recording_sid') WHERE triage_items.payload ->> 'recording_sid' IS NOT NULL UNION SELECT to_jsonb(?::text)) u), true)",
            [entry.recording_sid],
          ),
        });
    }
  }).catch((err) => {
    err.parkFailed = true;
    throw err;
  });
  if (appended === 0) {
    // Either a retry of an already-parked RecordingSid or a PAN stamp that
    // landed after the handler read the row. A quarantined call never keeps
    // audio, parked or attached: delete the incoming recording at Twilio
    // instead of parking it, and file no card for audio that no longer
    // exists. A plain retry files nothing either — the card was filed with
    // the first delivery, and re-filing would reopen one the office already
    // resolved by adopting or dismissing the recording.
    const now = await db('call_log').where({ id: row.id }).first('transcription_metadata', 'recording_sid');
    if (isPanQuarantinedRow(now)) {
      logger.warn(`[recording-status] recording ${maskSid(entry.recording_sid)} for ${maskSid(row.twilio_call_sid)} arrived as the call was PAN-quarantined — deleting instead of parking`);
      const processor = require('../services/call-recording-processor');
      // The incoming recording first (its failure state must be saved), then
      // the row as it is — its CURRENT recording, the audio the card may
      // have been heard on, and every parked one.
      await processor.quarantineCardRecording(
        { ...row, recording_sid: entry.recording_sid, recording_url: entry.recording_url },
        { source: 'recording_status_post_quarantine_park' },
      ).catch((e) => logger.error(`[recording-status] post-quarantine parked recording delete failed: ${e.message}`));
      await processor.quarantineCardRecording(row, { source: 'recording_status_post_quarantine_park' })
        .catch((e) => logger.error(`[recording-status] post-quarantine current recording delete failed: ${e.message}`));
      return { parked: false, quarantined: true };
    }
    // The SID became the row's current recording between the read and the
    // write (adopted, or made current by a competing callback): it is not
    // parked and must not get a card — the row already carries it.
    if (now?.recording_sid && now.recording_sid === entry.recording_sid) {
      return { parked: false, quarantined: false, duplicate: true, reason: 'now_current' };
    }
    // A retry of an already-parked SID files nothing — UNLESS the first
    // delivery's card insert failed after the park landed: with no card in
    // ANY status the parked recording is invisible to the office, and the
    // carrier's retry is the durable second chance to file it. A card that
    // exists (open, or resolved by adopting / dismissing) is left alone.
    const anyCard = await db('triage_items')
      .where({ call_log_id: row.id, reason_code: 'additional_recording' })
      .first('id')
      .catch(() => null);
    if (anyCard) return { parked: false, quarantined: false, duplicate: true };
    // Parked earlier with no card at all (a pre-transaction row): file it.
    // A failure here is the same failure as a rolled-back park — the
    // recording is parked with no card — and gets the same 500 so Twilio
    // delivers the callback again.
    await db.transaction(async (trx) => {
      await trx('triage_items')
        .insert(card())
        .onConflict(trx.raw("(call_log_id, reason_code) WHERE status IN ('open', 'in_progress')"))
        .ignore();
      // The recovered card opens the call for review like a first-delivery
      // park does (hook P1 on r15): the aggregate the dashboard counts.
      await trx('call_log').where({ id: row.id }).update({ review_status: 'open' });
    }).catch((err) => { err.parkFailed = true; throw err; });
    return { parked: false, quarantined: false, duplicate: true, cardFiled: true };
  }
  return { parked: true, quarantined: false };
}

function sanitizeVoiceProviderError(value) {
  return String(value || '')
    .replace(/https:\/\/lookups\.twilio\.com\/v2\/PhoneNumbers\/[^?\s)]+/gi, 'https://lookups.twilio.com/v2/PhoneNumbers/[phone]')
    .replace(/%2B\d{10,15}/g, '[phone]')
    .replace(/\+\d{10,15}\b/g, '[phone]')
    .replace(/\b\d{10,15}\b/g, '[phone]');
}

let warnedForwardNumberFallback = false;

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function rememberForwardAccept({ parentCallSid, dialCallSid, answeredByNumber }) {
  if (!parentCallSid) {
    logger.warn(`[voice] Forward accept missing ParentCallSid for child ${maskSid(dialCallSid)}`);
    return 0;
  }

  const acceptance = {
    accepted: true,
    parent_call_sid: parentCallSid,
    dial_call_sid: dialCallSid || null,
    answered_by_number: toE164(answeredByNumber) || null,
    csr_name: resolveCsrName(answeredByNumber),
    accepted_at: new Date().toISOString(),
  };

  return db('call_log')
    .where('twilio_call_sid', parentCallSid)
    .update({
      metadata: db.raw(
        "jsonb_set(COALESCE(metadata, '{}'::jsonb), '{forward_acceptance}', ?::jsonb, true)",
        [JSON.stringify(acceptance)]
      ),
      updated_at: new Date(),
    });
}

// Merge the /voice webhook's rich metadata onto a call_log row the
// /call-status inbound fallback inserted first (see the per-SID advisory
// lock in the /voice handler). Fresh fields win on shared keys — the routing
// values are identical either way — while keys only the fallback wrote
// (e.g. source: 'status_callback') survive as provenance of which endpoint
// created the row. Metadata may arrive as a jsonb object or a legacy string.
function foldVoiceMetadata(existingMetadata, freshMetadata) {
  let prior = {};
  if (existingMetadata && typeof existingMetadata === 'object') {
    prior = existingMetadata;
  } else if (typeof existingMetadata === 'string' && existingMetadata) {
    try { prior = JSON.parse(existingMetadata) || {}; } catch { prior = {}; }
  }
  return { ...prior, ...freshMetadata };
}

// Compact, parse-safe capture of Twilio's Marketplace `AddOns` webhook param
// for the call_log metadata audit trail. Parsed object when valid JSON,
// truncated string when not (still evidence of WHAT arrived), null when the
// param is absent entirely.
function parseAddOnsForAudit(addOnsRaw) {
  if (!addOnsRaw) return null;
  try {
    return typeof addOnsRaw === 'string' ? JSON.parse(addOnsRaw) : addOnsRaw;
  } catch {
    return String(addOnsRaw).slice(0, 1000);
  }
}

function metadataHasForwardAcceptance(metadata, { parentCallSid, dialCallSid }) {
  const acceptance = parseJsonObject(metadata).forward_acceptance || {};
  if (acceptance.accepted !== true) return false;
  if (parentCallSid && acceptance.parent_call_sid === parentCallSid) return true;
  return !!(dialCallSid && acceptance.dial_call_sid === dialCallSid);
}

async function wasForwardAccepted({ parentCallSid, dialCallSid }) {
  if (parentCallSid) {
    const parentRow = await db('call_log')
      .where('twilio_call_sid', parentCallSid)
      .select('metadata')
      .first();
    if (metadataHasForwardAcceptance(parentRow?.metadata, { parentCallSid, dialCallSid })) return true;
  }

  if (!dialCallSid) return false;

  const childMatch = await db('call_log')
    .whereRaw("metadata -> 'forward_acceptance' ->> 'dial_call_sid' = ?", [dialCallSid])
    .select('metadata')
    .first();
  return metadataHasForwardAcceptance(childMatch?.metadata, { parentCallSid, dialCallSid });
}

function resolveInboundDialCompletion({ status, duration, forwardAccepted }) {
  const shouldRecordVoicemail = ['no-answer', 'busy', 'failed'].includes(status)
    || (status === 'completed' && !forwardAccepted);

  let answeredBy = 'unknown';
  if (status === 'completed' && duration > 0 && forwardAccepted) answeredBy = 'human';
  else if (status === 'no-answer' || status === 'busy') answeredBy = 'missed';
  if (shouldRecordVoicemail) answeredBy = 'voicemail';

  return { shouldRecordVoicemail, answeredBy };
}

function shouldAlertInboundDialFailure({ status, shouldRecordVoicemail }) {
  // A failed staff-forward leg is not a failed customer call when the same
  // TwiML response deliberately continues into Waves-owned voicemail. Alert
  // only when the dial failure is terminal; downstream webhook/recording
  // failures have their own failure paths.
  return isFailureStatus(status) && !shouldRecordVoicemail;
}

function parseForwardNumbers(value) {
  const seen = new Set();
  return String(value || '')
    .split(',')
    .map(n => toE164(n.trim()))
    .filter(Boolean)
    .filter((n) => {
      if (seen.has(n)) return false;
      seen.add(n);
      return true;
    });
}

function getFallbackForwardNumbers() {
  const explicit = parseForwardNumbers(process.env.WAVES_FALLBACK_FORWARD_NUMBERS);
  if (explicit.length || String(process.env.WAVES_FALLBACK_FORWARD_NUMBERS || '').trim()) return explicit;

  const envFallback = parseForwardNumbers([
    process.env.OWNER_PHONE,
    process.env.ADAM_PHONE,
    process.env.VIRGINIA_PHONE,
    process.env.OFFICE_MANAGER_PHONE,
    process.env.WAVES_OFFICE_MANAGER_PHONE,
  ].filter(Boolean).join(','));

  if (envFallback.length && !warnedForwardNumberFallback) {
    logger.warn('[voice] WAVES_FALLBACK_FORWARD_NUMBERS is not configured; using staff phone env fallback for inbound forwarding');
    warnedForwardNumberFallback = true;
  }

  return envFallback;
}

// Map the staff number that pressed 1 to a CSR name, for call-scoring
// attribution. The inbound <Dial> simul-rings distinct per-person numbers, so
// the winning leg's To/Called identifies who answered. Operator-controlled via
// WAVES_CSR_NUMBER_MAP ("+19415551234:Virginia,+19415995678:Adam"); falls back
// to the same named per-person env vars that feed the dial list. Returns null
// when unmapped so downstream scoring stays 'Unknown' rather than guessing.
function getCsrNumberMap() {
  const map = new Map();
  const addEntry = (rawNumber, name) => {
    const e164 = toE164(rawNumber);
    if (e164 && name && !map.has(e164)) map.set(e164, name);
  };
  // Explicit override first (operator-authoritative).
  String(process.env.WAVES_CSR_NUMBER_MAP || '')
    .split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .forEach((pair) => {
      const idx = pair.lastIndexOf(':');
      if (idx > 0) addEntry(pair.slice(0, idx), pair.slice(idx + 1).trim());
    });
  // Named per-person env fallback (same identities the dial already uses).
  addEntry(process.env.VIRGINIA_PHONE, 'Virginia');
  addEntry(process.env.ADAM_PHONE, 'Adam');
  addEntry(process.env.OFFICE_MANAGER_PHONE, 'Office Manager');
  addEntry(process.env.WAVES_OFFICE_MANAGER_PHONE, 'Office Manager');
  addEntry(process.env.OWNER_PHONE, 'Waves');
  return map;
}

function resolveCsrName(staffNumber) {
  const e164 = toE164(staffNumber);
  if (!e164) return null;
  return getCsrNumberMap().get(e164) || null;
}

const VOICEMAIL_COMPLETE_ACTION = '/api/webhooks/twilio/voicemail-complete';

// ── Pre-connect caller screen ────────────────────────────────────────────
// Unknown-caller calls arriving with STIR/SHAKEN attestation B (the carrier
// can't vouch the caller owns the displayed number) are the spoofed-number
// robocall population. 60 days of the ground truth captured on this webhook:
// 25% of inbound calls are unknown+B, 67% of those end as dead-air
// voicemails, and only ~2% of lead-producing calls arrive on B. Attestation
// A, C, and MISSING all bypass — most real leads arrive with no attestation
// at all, so absence is NOT suspicion.
//
// With GATE_CALL_PRECONNECT_SCREEN on, qualifying callers must press a key
// before staff phones ring; no key → the Waves voicemail recorder, never a
// bare hangup (a confused human still reaches voicemail; a silent robocall
// voicemail is auto-hidden by the dead-air suppression in the admin call
// log). Gate off = shadow: qualifying calls are stamped
// metadata.preconnect_screen='would_gate' so daily volume is judgeable
// before any caller ever hears the prompt. Lifecycle stamps: 'gated' at the
// challenge, then 'passed' (key pressed) or 'failed' (fell to voicemail).
function preconnectScreenDecision({ knownCaller, stirVerstat, gateOn }) {
  if (knownCaller || !/-B$/.test(String(stirVerstat || ''))) return 'none';
  return gateOn ? 'gate' : 'would_gate';
}

// Pass/fail re-enter THIS route via query params (?screened=1 / ?screenfail=1)
// so the normal routing, idempotency claim, and voicemail flows are reused
// verbatim — no new public webhook route exists.
function buildPreconnectChallengeTwiML() {
  const twiml = new VoiceResponse();
  const gatherOpts = {
    input: 'dtmf',
    numDigits: 1,
    timeout: 6,
    action: '/api/webhooks/twilio/voice?screened=1',
    method: 'POST',
  };
  twiml
    .gather(gatherOpts)
    .say({ voice: SAY_VOICE }, 'Thank you for calling Waves Pest Control. To be connected, please press one.');
  twiml
    .gather(gatherOpts)
    .say({ voice: SAY_VOICE }, 'Please press one to be connected.');
  twiml.redirect({ method: 'POST' }, '/api/webhooks/twilio/voice?screenfail=1');
  return twiml.toString();
}

async function stampPreconnectScreen(callSid, value) {
  try {
    const row = await db('call_log')
      .where('twilio_call_sid', callSid)
      .orderBy('created_at', 'desc')
      .first();
    if (!row) return;
    let meta = {};
    try {
      meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
    } catch { meta = {}; }
    meta.preconnect_screen = value;
    await db('call_log')
      .where({ id: row.id })
      .update({ metadata: JSON.stringify(meta), updated_at: new Date() });
  } catch (err) {
    logger.warn(`[preconnect-screen] stamp '${value}' failed for ${maskSid(callSid)}: ${err.message}`);
  }
}

function appendVoicemailRecording(twiml, { language = null } = {}) {
  if (/^es/i.test(String(language || ''))) {
    // Spanish failover (GATE_VOICE_SPANISH_MENU): a caller who chose Spanish
    // never hears English voicemail. The asset is optional — without it the
    // Spanish <Say> alone precedes the recorder.
    const spanishAudio = process.env.WAVES_VOICEMAIL_URL_ES;
    if (spanishAudio) twiml.play(spanishAudio);
    twiml.say(SPANISH_SAY, 'Su mensaje será grabado y transcrito.');
  } else {
    const voicemailAudio = process.env.WAVES_VOICEMAIL_URL || 'https://jet-wolverine-3713.twil.io/assets/waves-voicemail.mp3';
    twiml.play(voicemailAudio);
    twiml.say({ voice: SAY_VOICE }, 'Your message will be recorded and transcribed.');
  }
  twiml.record({
    maxLength: 120,
    action: VOICEMAIL_COMPLETE_ACTION,
    method: 'POST',
    transcribe: true,
    transcribeCallback: '/api/webhooks/twilio/transcription',
    playBeep: true,
    recordingStatusCallback: '/api/webhooks/twilio/recording-status',
    recordingStatusCallbackEvent: 'completed',
  });
}

function queueVoiceMessageSync(callSid) {
  if (!callSid) return;
  // Intentional fire-and-forget, but catch/log so a sync failure never becomes an
  // unhandled rejection (AGENTS.md floating-promise rule). Promise.resolve()
  // tolerates a sync/void return from the helper (e.g. in tests).
  Promise.resolve(syncVoiceMessageForCall(callSid)).catch((err) =>
    logger.warn(`[voice] voice message sync failed for ${maskSid(callSid)}: ${err.message}`));
}

const AGENT_FALLBACK_ACTION = '/api/webhooks/twilio/agent-fallback';
const RELAY_COMPLETE_ACTION = '/api/webhooks/twilio/relay-complete';
/**
 * Sandy PR 2A: the relay ended with reason 'transfer' — hand the caller to
 * the staff simul-ring. The outcome stamp is idempotent (the tool already
 * wrote ai_transferred with the packet; this covers a packet write that
 * never landed — still terminal for the socket's reconcile). No summary and
 * no id ride the URL; the whisper is read from the row after press-1. A
 * sandbox call (?sandbox=1) never rings staff: the transfer is on its own
 * row already, the leg simply ends. No staff numbers ⇒ voicemail, never a
 * stranded caller.
 */
async function appendRelayTransfer(req, twiml, callSid, handoff = {}, recoveryFallback = null) {
  if ((req.query || {}).sandbox === '1') {
    logger.info(`[relay-complete] sandbox transfer for ${maskSid(callSid)} — hanging up (no staff ring on the sandbox)`);
    twiml.hangup();
    return 'hangup';
  }
  // The frame names the socket's claim owner (owner-bound writes below).
  const owner = typeof handoff.owner === 'string' && handoff.owner ? handoff.owner.slice(0, 128) : null;
  // The one voicemail stamp every fallback on this callback takes: owner +
  // eligible-state fenced, so a reconnect that took the row meanwhile keeps
  // its own reconcile (hook / codex r3 P1).
  const ringClaim = recoveryFallback ? require('crypto').randomUUID() : null;
  const transferRow = (ownRingClaim = null) => {
    const q = db('call_log').where('twilio_call_sid', callSid);
    return recoveryFallback ? require('../services/voice-agent/relay-recovery').fallbackFence(q, { ...recoveryFallback, ringClaim: ownRingClaim }) : q;
  };
  const stampTransferVoicemail = () => transferRow(ringClaim)
    .whereRaw("((metadata->>'relay_session_claim_owner') IS NULL OR (metadata->>'relay_session_claim_owner') = ?)", [owner])
    .where((q) => q.whereNull('call_outcome').orWhere('call_outcome', 'ai_transferred'))
    .update({ answered_by: 'voicemail', call_outcome: 'voicemail', updated_at: new Date() });
  if (callSid) {
    // ONE staff ring per call, claimed atomically: Twilio may retry this
    // action callback, and every retry would otherwise render a fresh
    // <Dial> (hook P1). The claim stamps metadata.relay_transfer_ring_at
    // and, in the same statement, the ai_transferred outcome when the row
    // is not already terminal (the tool normally wrote it; this covers a
    // packet write that never landed). 0 rows = already rung ⇒ a bare
    // terminal response. BOUNDED: a stalled pool may never hold the TwiML
    // past Twilio's webhook timeout (codex r1 P1) — and a claim that did not
    // CONFIRM (timeout / error) falls to voicemail, never to a ring that a
    // retry could duplicate (hook P1): the one-ring guarantee needs a
    // durable claim, and voicemail is the non-duplicating fallback every
    // other relay failure already takes.
    const { RELAY_TERMINAL_OUTCOMES } = require('../services/voice-agent/relay-protocol');
    // OWNER-BOUND (hook P1): the frame names the socket's claim owner; a
    // row now owned by a reconnect (or claimed while this frame says
    // unclaimed) matches 0 rows, so a superseded socket cannot ring staff.
    const claimPromise = transferRow()
        .whereRaw("COALESCE(metadata->>'relay_transfer_ring_at', '') = ''")
        .whereRaw("((metadata->>'relay_session_claim_owner') IS NULL OR (metadata->>'relay_session_claim_owner') = ?)", [owner])
        // A row already sent to voicemail (the fallback below, or a failed
        // session) is never rung: a Twilio retry after that fallback would
        // otherwise match again and Dial staff over the recorder (codex r4 P1).
        .where((q) => q.whereNull('call_outcome').orWhereNotIn('call_outcome', ['voicemail', 'relay_failed']))
        .update({
          call_outcome: db.raw('CASE WHEN call_outcome IS NULL OR call_outcome NOT IN (?, ?, ?) THEN ? ELSE call_outcome END', [...RELAY_TERMINAL_OUTCOMES, 'ai_transferred']),
          metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('relay_transfer_ring_at', ?::text) || ?::jsonb", [new Date().toISOString(), JSON.stringify(ringClaim ? { relay_transfer_ring_claim: ringClaim } : {})]),
          updated_at: new Date(),
        })
        .catch((err) => { logger.warn(`[relay-complete] transfer ring claim failed for ${maskSid(callSid)}: ${err.message}`); return 'error'; });
    const claimed = await withDeadline(claimPromise, STAMP_DEADLINE_MS, 'timeout');
    if (claimed === 0) {
      logger.warn(`[relay-complete] transfer ring already claimed for ${maskSid(callSid)} — retry gets a bare response`);
      return 'bare';
    }
    if (!(Number(claimed) > 0)) {
      // The recorder's action is /voicemail-complete, which never
      // re-classifies: stamp voicemail here (bounded, best-effort) so a
      // transfer that reached nobody is not reported as a success (codex r2 P1).
      logger.error(`[relay-complete] transfer ring claim ${claimed} for ${maskSid(callSid)} — voicemail instead of an unconfirmed ring`);
      const stamped = await withDeadline(
        stampTransferVoicemail().catch((err) => logger.warn(`[relay-complete] unconfirmed-ring voicemail stamp failed for ${maskSid(callSid)}: ${err.message}`)),
        STAMP_DEADLINE_MS,
      );
      // The deadline does not cancel the queued claim (codex r6 P1): if it
      // lands later — the row then reads ai_transferred + ring claimed while
      // the caller is in voicemail — re-stamp voicemail when it does
      // (detached, same fence; the claim's CASE keeps an already-landed
      // voicemail, and the claim itself skips voicemail rows).
      if (claimed === 'timeout') {
        void claimPromise
          .then((rows) => (Number(rows) > 0 ? stampTransferVoicemail() : 0))
          .then((rows) => { if (Number(rows) > 0) logger.warn(`[relay-complete] late ring claim for ${maskSid(callSid)} re-stamped as voicemail`); })
          .catch((err) => logger.warn(`[relay-complete] late-claim voicemail re-stamp failed for ${maskSid(callSid)}: ${err.message}`));
      }
      if (recoveryFallback && !(Number(stamped) > 0)) return stamped == null ? 'unconfirmed' : 'bare';
      queueVoiceMessageSync(callSid);
      appendVoicemailRecording(twiml, { language: relayCompleteLanguage(req) });
      return 'voicemail';
    }
  }
  const forwardNumbers = getFallbackForwardNumbers();
  if (forwardNumbers.length === 0) {
    // The recorder's action is /voicemail-complete, so /call-complete never
    // runs to re-classify this call: stamp voicemail here, exactly as the
    // relay-failure path does, or it reports as transferred to nobody.
    logger.error(`[relay-complete] transfer for ${maskSid(callSid)} but no staff forward numbers configured — voicemail`);
    if (callSid) {
      // Bounded like every other stamp on this callback: a stalled pool must
      // not hold the voicemail TwiML past Twilio's timeout (hook P1).
      const stamped = await withDeadline(
        stampTransferVoicemail().catch((err) => logger.warn(`[relay-complete] no-staff voicemail stamp failed for ${maskSid(callSid)}: ${err.message}`)),
        STAMP_DEADLINE_MS,
      );
      if (recoveryFallback && !(Number(stamped) > 0)) return stamped == null ? 'unconfirmed' : 'bare';
      queueVoiceMessageSync(callSid);
    }
    appendVoicemailRecording(twiml, { language: relayCompleteLanguage(req) });
    return 'voicemail';
  }
  appendStaffRingDial(twiml, forwardNumbers, 30, { language: relayCompleteLanguage(req) });
  return 'ring';
}

/** A call_log row that went through a Sandy transfer: the packet, the ring claim, or the outcome. */
function isTransferredRow(row) {
  if (!row) return false;
  const meta = parseJsonObject(row.metadata);
  return Boolean((meta.relay_handoff && typeof meta.relay_handoff === 'object') || meta.relay_transfer_ring_at)
    || row.call_outcome === 'ai_transferred';
}

/** The relay end frame's HandoffData: a JSON object string, or nothing. Never throws. */
function parseHandoffData(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
// The production relay profile (STT / turn-taking tuning attributes + the
// telemetry <Parameter>s). relay-profiles is the only chooser; every relay
// leg spreads this in. Unset ⇒ {} ⇒ byte-identical TwiML.
function activeRelayTwiMLOptions(opts) {
  return require('../services/voice-agent/relay-profiles').activeRelayTwiMLOptions(opts);
}

// ── Spanish language vestibule (GATE_VOICE_SPANISH_MENU) ───────────────────
// ONE implementation of the language-selection TwiML, used by every inbound
// execution mode that can ultimately answer a customer (the staff-ring path
// and the AI-answers-first path). The existing greeting <Play> sits INSIDE
// the <Gather> so the key window overlaps audio the caller was already going
// to hear; the one Spanish sentence follows it; `timeout` (which Twilio
// starts only AFTER nested verbs finish) is short. A key press during
// playback submits immediately. No key ⇒ the Gather falls through to the
// next verb — exactly today's TwiML (actionOnEmptyResult stays false, so the
// action is never hit on a timeout). Any key ⇒ Twilio POSTs Digits to
// /voice?lang=menu; only '2' selects Spanish (see the contract in /voice).
const LANGUAGE_MENU_ACTION = '/api/webhooks/twilio/voice?lang=menu';
const LANGUAGE_MENU_TIMEOUT_SEC = 1;
const SPANISH_MENU_PROMPT = 'Para español, oprima dos.';
const SPANISH_SAY_VOICE = process.env.TWILIO_SAY_VOICE_ES || 'Polly.Lupe-Neural';
const SPANISH_SAY = { language: 'es-US', voice: SPANISH_SAY_VOICE };

// Whether THIS call may be offered the vestibule. Every leg of the decision
// fails closed: gate on, owner switch on, a REACHABLE relay (Spanish is a
// relay session — a dial-kind agent cannot run it), and never on a
// re-entry (the menu is offered once per call).
function languageVestibule({ routingConfig, handoffKind, reentry }) {
  if (reentry) return null;
  const { isEnabled } = require('../config/feature-gates');
  if (!isEnabled('voiceSpanishMenu')) return null;
  if (!routingConfig || routingConfig.spanishMenuEnabled !== true) return null;
  if (handoffKind !== 'relay') return null;
  return { relayUrl: String(routingConfig.agentEndpoint || '').trim(), voice: routingConfig.spanishVoice || null };
}

// Append the greeting to `twiml`: bare <Play> when no vestibule (byte-identical
// to before), else the greeting + Spanish sentence inside the one <Gather>.
// `greetingUrl` null (the answers-first relay path has no greeting MP3 — the
// relay welcomeGreeting is its disclosure) renders the Gather with only the
// Spanish sentence.
// The greeting MP3 = the FL §934.03 recording / transcription / AI-processing
// disclosure (see the /voice handler). One resolver so every path that
// transcribes a caller — including the sandbox — plays the same asset.
function wavesGreetingUrl() {
  return process.env.WAVES_GREETING_URL
    || 'https://jet-wolverine-3713.twil.io/assets/ElevenLabs_2025-09-20T05_54_14_Veda%20Sky%20-%20Customer%20Care%20Agent_pvc_sp114_s58_sb72_se89_b_m2.mp3';
}

function appendLanguageVestibule(twiml, { greetingUrl, vestibule }) {
  if (!vestibule) {
    if (greetingUrl) twiml.play(greetingUrl);
    return false;
  }
  const gather = twiml.gather({
    input: 'dtmf',
    numDigits: 1,
    timeout: LANGUAGE_MENU_TIMEOUT_SEC,
    action: LANGUAGE_MENU_ACTION,
    method: 'POST',
  });
  if (greetingUrl) gather.play(greetingUrl);
  gather.say(SPANISH_SAY, SPANISH_MENU_PROMPT);
  return true;
}

// The relay TwiML is a hand-built XML string (relay-protocol), so the
// answers-first relay path splices the vestibule in through the SAME builder
// (a throwaway VoiceResponse rendered and unwrapped) — never a second copy of
// the Gather markup.
function vestibuleInnerXml({ greetingUrl, vestibule }) {
  const tmp = new VoiceResponse();
  appendLanguageVestibule(tmp, { greetingUrl, vestibule }); // bare <Play> when no vestibule
  return tmp.toString().replace(/^<\?xml[^>]*\?>/, '').replace(/^<Response>/, '').replace(/<\/Response>$/, '').replace(/^<Response\/>$/, '');
}

// Spanish relay leg for a caller who pressed 2: the SAME Sandy relay session
// in es-US (Spanish greeting = the §934.03 + automated-assistant disclosure,
// non-interruptible; Twilio's default es-US voice unless the owner set one;
// <Parameter lang=es> rides into the setup frame → RelayConversation.language).
// The selection ALSO rides the signed <Connect action> URL (?lang=es) so the
// failover voicemail is deterministically Spanish — Twilio's signature covers
// the query string, and no best-effort DB stamp sits on that path.
const RELAY_COMPLETE_ACTION_ES = `${RELAY_COMPLETE_ACTION}?lang=es`;
function relayCompleteLanguage(req) {
  return req && req.query && req.query.lang === 'es' ? 'es' : null;
}
// Resolved ONCE per call so the row stamp and the rendered TwiML agree.
function spanishRelayOptions() {
  const { SPANISH_LANGUAGE } = require('../services/voice-agent/relay-protocol');
  // An English-only recognizer profile (Deepgram Flux) is dropped for this
  // leg — the leg runs untuned rather than fail setup (codex r10 P1).
  return activeRelayTwiMLOptions({ language: SPANISH_LANGUAGE });
}
function buildSpanishRelayTwiML({ vestibule, callSid, relayOpts = spanishRelayOptions() }) {
  const { buildRelayTwiML, spanishWelcomeGreeting, SPANISH_LANGUAGE } = require('../services/voice-agent/relay-protocol');
  return buildRelayTwiML({
    wsUrl: vestibule.relayUrl,
    callSid,
    action: RELAY_COMPLETE_ACTION_ES,
    language: SPANISH_LANGUAGE,
    voice: vestibule.voice || null,
    welcomeGreeting: spanishWelcomeGreeting(),
    ...relayOpts,
    parameters: { lang: 'es' },
  });
}

// Best-effort audit writes on the live routing path must never hold the
// TwiML: a stalled query (held row lock) is bounded and routing continues.
// `.catch` alone handles rejection, not a query that never settles.
const STAMP_DEADLINE_MS = 1500;
function withDeadline(promise, ms = STAMP_DEADLINE_MS, fallback = null) {
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([Promise.resolve(promise).catch(() => fallback), deadline]).finally(() => clearTimeout(timer));
}

// A non-2 key on the language menu RE-PLAYS the greeting (hook P0): any DTMF
// interrupts the greeting nested in the <Gather>, and that greeting IS the FL
// §934.03 disclosure — the English continuation then reaches a RECORDED staff
// leg, so the disclosure must be heard uninterrupted first. Twilio does not
// report whether the nested <Play> completed, so the replay is unconditional.
// Only the press-2 branch may skip it: the Spanish relay carries its own
// non-interruptible disclosure. (Cost: a wrong-key caller hears the greeting
// twice — the price of a complete disclosure, not an oversight.)
// The Gather action contract: only an exact '2' selects Spanish. Anything
// else (other digit, '*', '#', multi-char, missing, malformed) = English
// continuation, and the continuation never re-offers the vestibule.
function spanishSelected(reqBody) {
  const digits = reqBody && reqBody.Digits;
  if (typeof digits !== 'string' && typeof digits !== 'number') return false; // arrays/objects never select
  return String(digits).trim() === '2';
}

// Classify how the configured agent endpoint is reachable, so the live-routing
// paths emit the right TwiML and never strand a call:
//   'relay'          → our ConversationRelay WebSocket agent (agentEndpoint is a
//                      wss:// URL) AND the relay ws server ACTUALLY attached
//                      (isRelayAttached — reflects VOICE_RELAY_ENABLED +
//                      ANTHROPIC_API_KEY + VOICE_RELAY_WS_SECRET + deps loaded).
//                      Handed off via <Connect><ConversationRelay>, NOT <Dial>.
//   'relay_disabled' → a wss:// endpoint is configured but the relay ws server
//                      did NOT attach → treat as no reachable agent (caller stays
//                      on the normal human/voicemail flow; never dial a wss URL).
//   'dial'           → a PSTN number or SIP URI agent → <Dial> handoff.
//   'none'           → no endpoint configured.
//
// A ws/wss endpoint that isn't a VALID relay target (wrong scheme, wrong path)
// classifies as 'relay_disabled' — never 'dial' (can't dial a ws URL) and never
// 'relay' — so a misconfigured endpoint falls through to voicemail rather than
// emitting <Connect><ConversationRelay> to a dead/insecure socket.
// Hostnames the relay is allowed to live on. The DB-configured `agentEndpoint`
// is operator-supplied, and buildRelayTwiML appends VOICE_RELAY_WS_SECRET to it
// — so a typo'd or malicious host (e.g. wss://attacker.example/ws/voice-agent)
// must NOT be trusted, or it would leak the secret and hand the call off-site.
// Trust only this portal's own public origin (PUBLIC_PORTAL_URL / PORTAL_URL /
// RAILWAY_PUBLIC_DOMAIN) plus loopback for local dev.
function trustedRelayHostnames() {
  const set = new Set(['localhost', '127.0.0.1']);
  for (const env of [process.env.PUBLIC_PORTAL_URL, process.env.PORTAL_URL, process.env.RAILWAY_PUBLIC_DOMAIN]) {
    if (!env) continue;
    try {
      const h = new URL(/^[a-z]+:\/\//i.test(env) ? env : `https://${env}`).hostname;
      if (h) set.add(h);
    } catch { /* ignore unparseable env */ }
  }
  return set;
}
function isRelayEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  const secureWs = url.protocol === 'wss:';
  const localDevWs = url.protocol === 'ws:' && /^(localhost|127\.0\.0\.1)$/.test(url.hostname);
  if (!(secureWs || localDevWs)) return false;
  if (url.pathname !== RELAY_WS_PATH) return false;
  return trustedRelayHostnames().has(url.hostname); // host must be OUR portal origin
}
function agentHandoffKind(config) {
  const endpoint = String(config?.agentEndpoint || '').trim();
  if (!endpoint) return 'none';
  if (/^wss?:\/\//i.test(endpoint)) {
    return (isRelayEndpoint(endpoint) && isRelayAttached()) ? 'relay' : 'relay_disabled';
  }
  return 'dial';
}

// Hand the live call to a DIAL-reachable AI voice agent (PSTN number or SIP
// URI). ConversationRelay (wss://) agents are handed off at the call site via
// buildRelayTwiML — never here — so this guards against ever dialing a wss URL
// as a phone number. Returns true when a <Dial> handoff was appended.
//
// FAIL-OPEN BY CONSTRUCTION: the <Dial> carries a short `timeout` and an
// `action` callback (/agent-fallback). If the agent endpoint does not answer
// (no-answer/busy/failed), Twilio invokes the action and the caller drops to
// the Waves voicemail — never dead air, never a trapped call.
function appendAgentHandoff(twiml, config, opts = {}) {
  const endpoint = String(config?.agentEndpoint || '').trim();
  // A wss:// (ConversationRelay) endpoint cannot be dialed; the call site emits
  // <Connect><ConversationRelay> instead. Guard so a stray call never tries.
  if (!endpoint || /^wss?:\/\//i.test(endpoint)) return false;
  const dialOpts = {
    answerOnBridge: true,
    timeout: Math.max(5, Number(config?.agentTimeoutSec) || 10),
    action: AGENT_FALLBACK_ACTION,
    method: 'POST',
  };
  // Pass the original caller's number through as the caller ID so the agent —
  // and the lead it captures — see the real customer, not the Waves line that
  // dialed out. Only set when we have it; otherwise Twilio uses the dialing
  // number and the agent confirms the callback number verbally (prompt does).
  // Only pass a real phone as the Dial callerId — a blocked/anonymous From would
  // come back from toE164 unchanged and an invalid callerId can fail the agent
  // Dial; omit it so Twilio uses the default caller ID instead.
  const callerId = toE164(opts.callerId || '');
  if (isLikelyE164(callerId)) dialOpts.callerId = callerId;
  const dial = twiml.dial(dialOpts);
  if (/^sips?:/i.test(endpoint)) dial.sip(endpoint);
  else dial.number(endpoint);
  return true;
}

// =========================================================================
// POST /api/webhooks/twilio/voice — Inbound voice call webhook
//
// Twilio hits this when a call comes in to any Waves number.
// We answer, enable recording, and log the call.
// =========================================================================
router.post('/voice', async (req, res) => {
  // Whether THIS delivery took the dedupe ledger row (see /sms for rationale).
  let claimOwned = false;
  // Flipped true once the call_log row (insert-or-enrich under the per-SID
  // lock below) has committed, after which we must not release the claim on error.
  let callLogged = false;
  try {
    const { isEnabled } = require('../config/feature-gates');
    if (!isEnabled('twilioVoice')) {
      logger.info(`[GATE BLOCKED] Voice call from ${maskPhone(req.body.From)} (gate: twilioVoice)`);
      return res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="${SAY_VOICE}">Thank you for calling Waves Pest Control. Please call back during business hours or text us at 941-318-7612.</Say></Response>`);
    }

    const { From, To, CallSid, CallStatus, Direction } = req.body;

    // ── Idempotency claim (must run before spam-block + all side-effects) ──
    // Twilio can redeliver the same CallSid. Claim it first so a redelivery
    // does not duplicate the call_log row, touchpoint, paid Lookup, OR the
    // spam-block audit write (RED audit R1). Unlike /sms we don't short-circuit
    // — the call still needs routing TwiML — so `firstDelivery` gates the
    // side-effecting work instead. Fails open (processable but not owned);
    // only an owner releases the claim on error.
    const voiceClaim = await tryClaimInboundWebhook(CallSid, 'voice');
    const firstDelivery = voiceClaim.processable;
    claimOwned = voiceClaim.owned;

    // ── Spam block (must run before any other routing) ──
    // Runs on every delivery so routing stays correct, but only records the
    // blocked-attempt audit row on the first delivery (recordAttempt).
    const { checkInboundBlock } = require('../middleware/spam-block');
    const blockResult = await checkInboundBlock({
      from: From, to: To, channel: 'voice', twilioSid: CallSid, addOns: req.body.AddOns,
      // Blocked calls return TwiML before the call_log insert below ever
      // runs, so their spam evidence must ride the blocked_call_attempts
      // audit row instead — same fields the allowed path stores in metadata.
      signals: { stir_verstat: req.body.StirVerstat || null, addons: parseAddOnsForAudit(req.body.AddOns) },
      recordAttempt: firstDelivery,
    });
    if (blockResult.blocked) return res.type('text/xml').send(blockResult.twiml);

    const numberConfig = TWILIO_NUMBERS.findByNumber(To);

    // Match caller to customer. The raw matches are fetched once: a single
    // match links the call; 2+ matches deliberately do NOT auto-link (shared
    // number) but still count as a known caller for the screen bypass below.
    const customerPhoneMatches = await findCustomerPhoneMatches(db, From);
    let customer = customerPhoneMatches.length === 1 ? customerPhoneMatches[0] : null;
    if (customerPhoneMatches.length > 1) {
      logger.warn(`[voice] ${customerPhoneMatches.length} customers share caller phone ${maskPhone(From)}; not auto-linking call_log`);
    }

    // Pre-connect screen decision (see helpers above). Re-entries from the
    // challenge TwiML arrive on this same route with ?screened=1 (a key was
    // pressed) or ?screenfail=1 (both Gathers timed out) — they are never a
    // first delivery, so the insert/stamp below doesn't double-fire.
    const screenReentry = req.query.screened === '1'
      ? 'passed'
      : (req.query.screenfail === '1' ? 'failed' : null);
    // Language-vestibule re-entry (?lang=menu): Twilio POSTed a key press from
    // the <Gather>. Never a first delivery, never re-screened, never re-offered
    // the menu. Only an exact '2' selects Spanish; anything else continues in
    // English exactly as the Gather timeout would have.
    const langReentry = req.query.lang === 'menu';
    const spanishChosen = langReentry && spanishSelected(req.body);
    let knownCaller = customerPhoneMatches.length > 0;
    // Service-contact slot phones (spouse/tenant — the canonical inbound
    // identity set) also bypass the screen. Checked only when it could
    // change the outcome (no primary match, B attestation, not a re-entry)
    // so the extra query never runs on ordinary calls; a check failure
    // fails OPEN — never challenge a caller because Postgres hiccupped.
    if (!knownCaller && !screenReentry && !langReentry && /-B$/.test(String(req.body.StirVerstat || ''))) {
      try {
        knownCaller = await knownCallerPhoneExists(db, From);
      } catch (err) {
        logger.warn(`[preconnect-screen] known-caller check failed (failing open, no challenge): ${err.message}`);
        knownCaller = true;
      }
    }
    const screenDecision = (screenReentry || langReentry) ? 'none' : preconnectScreenDecision({
      knownCaller,
      stirVerstat: req.body.StirVerstat,
      gateOn: isEnabled('callPreconnectScreen'),
    });

    // #4: Caller ID Enrichment via Twilio Lookup API
    if (firstDelivery && !customer && From) {
      try {
        const lookupUrl = `https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(From)}?Fields=caller_name`;
        const twilioAuth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
        const lookupRes = await fetch(lookupUrl, { headers: { Authorization: `Basic ${twilioAuth}` } });
        if (lookupRes.ok) {
          const lookupData = await lookupRes.json();
          const callerName = lookupData.caller_name?.caller_name;
          if (callerName && callerName !== 'UNKNOWN' && callerName.trim().length > 0) {
            logger.info(`[CallerID] Lookup matched for inbound call ${maskSid(CallSid)}; deferring customer creation until transcript confirms first name`);
          }
        }
      } catch (lookupErr) {
        // Non-critical — Twilio Lookup is a paid add-on, may not be enabled
        logger.info(`[CallerID] Lookup skipped: ${sanitizeVoiceProviderError(lookupErr.message)}`);
      }
    }

    // Log the inbound call (first delivery only — see claim above).
    // Serialized per-CallSid with /call-status and /recording-status: an
    // instantly-terminal call (no-answer/busy) can deliver its status
    // callback before this handler commits, and that endpoint's inbound
    // fallback insert then double-logs the SID (14 sub-second race pairs in
    // prod before the unique index). If the fallback won the race, fold in
    // the fields only this webhook knows instead of inserting — and never
    // touch the terminal status/duration it already recorded.
    if (firstDelivery) {
    const freshCallMetadata = ({
        location: numberConfig?.label || 'unknown',
        numberType: numberConfig?.type || 'unknown',
        domain: numberConfig?.domain || null,
        // Read back after press-1 by connectingAnnouncement(). Stored server-side
        // so the caller's name never enters a callback URL (request-logger safe).
        screen_caller_name: spokenCallerName(customer),
        // Spam-signal ground truth (2026-07-09): the STIR/SHAKEN attestation
        // and the Marketplace AddOns verdicts arrive ONLY on this initial
        // webhook and were previously dropped on the floor. Captured so
        // screening accuracy can be judged from call_log against the
        // pipeline's own spam classifications BEFORE any caller is ever
        // challenged or blocked. NULL addons = Twilio attached nothing —
        // that absence is itself a finding (Marchex was silent for months).
        stir_verstat: req.body.StirVerstat || null,
        addons: parseAddOnsForAudit(req.body.AddOns),
        // Pre-connect screen lifecycle: 'would_gate' (shadow, gate off) or
        // 'gated' (challenge issued) → later 'passed'/'failed'. Absent for
        // known customers and non-B attestation.
        ...(screenDecision !== 'none'
          ? { preconnect_screen: screenDecision === 'gate' ? 'gated' : 'would_gate' }
          : {}),
      });
    await db.transaction(async (trx) => {
      // Same per-SID advisory lock as /call-status and /recording-status.
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [CallSid]);
      const existing = await trx('call_log')
        .where('twilio_call_sid', CallSid)
        .first('id', 'customer_id', 'metadata');
      if (existing) {
        await trx('call_log').where({ id: existing.id }).update({
          customer_id: existing.customer_id || customer?.id || null,
          metadata: JSON.stringify(foldVoiceMetadata(existing.metadata, freshCallMetadata)),
          updated_at: new Date(),
        });
      } else {
        await trx('call_log').insert({
          customer_id: customer?.id || null,
          direction: 'inbound',
          from_phone: toE164(From),
          to_phone: toE164(To),
          twilio_call_sid: CallSid,
          status: CallStatus || 'ringing',
          metadata: JSON.stringify(freshCallMetadata),
        });
      }
    });
    // call_log now committed — don't release the claim on a later error.
    callLogged = true;

    // Dual-write to unified messages table. Recording + transcription
    // arrive in later webhooks and update this row via twilio_sid.
    void recordTouchpoint({
      customerId: customer?.id,
      channel: 'voice',
      ourEndpointId: To,
      contactPhone: customer ? null : From,
      direction: 'inbound',
      authorType: 'customer',
      twilioSid: CallSid,
      metadata: {
        location: numberConfig?.label || 'unknown',
        numberType: numberConfig?.type || 'unknown',
        domain: numberConfig?.domain || null,
      },
    }).catch((err) => {
      logger.error(`recordTouchpoint failed for inbound CallSid=${maskSid(CallSid)}: ${err.message}`);
    });
    } else {
      logger.info(`[twilio-voice] Duplicate inbound voice ${maskSid(CallSid)} — routing only, skipped re-logging`);
    }

    logger.info(`Inbound call: ${maskPhone(From)} -> ${maskPhone(To)} (${maskSid(CallSid)}) customer=${customer ? 'known' : 'unknown'}`);

    // Build TwiML response — this webhook IS production inbound routing:
    // all 25 Waves numbers point their voice_url here (verified against
    // the IncomingPhoneNumbers API 2026-06-12). The Studio Flow "Waves
    // Inbound — All Numbers" (FW5fdc2e44...) still exists in the console
    // but is dormant — no number routes to it.
    //
    // FL §934.03 (2025) — interception lawful when all parties have
    // given prior consent. The greeting MP3 is the operative
    // disclosure: when that audio asset is changed, the new asset MUST
    // contain recording/transcription/AI-processing language.
    // WAVES_GREETING_URL exists so the asset can be swapped without a
    // code deploy; fallback to the production URL is documented and
    // intentional.
    const greetingUrl = wavesGreetingUrl();

    // ── Pre-connect caller screen (before any staff ring / agent leg) ──
    if (screenReentry === 'failed') {
      // Both Gathers timed out — dead air or a caller who can't press keys.
      // Never a bare hangup: route to the Waves voicemail recorder so a real
      // human still gets through. Greeting MP3 first — it carries the
      // FL §934.03 recording disclosure and MUST precede the recorder.
      // Both audit writes are best-effort: a transient DB failure must never
      // bubble to the outer catch and replace the promised voicemail
      // fallback with the generic error TwiML.
      await stampPreconnectScreen(CallSid, 'failed');
      await db('call_log').where('twilio_call_sid', CallSid).update({
        answered_by: 'voicemail',
        call_outcome: 'voicemail',
        updated_at: new Date(),
      }).catch((err) => {
        logger.warn(`[preconnect-screen] failed-outcome update skipped for ${maskSid(CallSid)}: ${err.message}`);
      });
      logger.info(`[preconnect-screen] no key from ${maskPhone(From)} (${maskSid(CallSid)}) — routing to Waves voicemail`);
      const failTwiml = new VoiceResponse();
      failTwiml.play(greetingUrl);
      appendVoicemailRecording(failTwiml);
      return res.type('text/xml').send(failTwiml.toString());
    }
    if (screenReentry === 'passed') {
      // Any keypress proves a human; continue into the normal flow below.
      await stampPreconnectScreen(CallSid, 'passed');
      logger.info(`[preconnect-screen] caller ${maskPhone(From)} passed (${maskSid(CallSid)}) — continuing normal routing`);
    } else if (screenDecision === 'gate') {
      logger.info(`[preconnect-screen] challenging unknown B-attestation caller ${maskPhone(From)} (${maskSid(CallSid)})`);
      return res.type('text/xml').send(buildPreconnectChallengeTwiML());
    }

    // ── AI voice agent routing (opt-in; default path untouched) ──
    // The agent NEVER fronts a call unless GATE_VOICE_AI_AGENT is on AND the
    // owner enabled "answers first" (manual toggle or active nightly schedule)
    // AND an agent endpoint is configured. Gate off short-circuits before any
    // config read, so the staff simul-ring below is byte-for-byte unchanged.
    // Whole block is fail-open: any error continues to the normal flow.
    let ringTimeoutSec = 30;
    // Language vestibule for THIS call (null = not offered). Decided inside the
    // agent block because Spanish is a relay session: no agent gate/endpoint
    // ⇒ no Spanish path ⇒ no menu. Falls open to null on any error.
    let vestibule = null;
    try {
      if (isEnabled('voiceAiAgent')) {
        const routingConfig = await getCallRoutingConfig(db);
        // Only let the configured ring timeout shorten the staff ring when the
        // AI can actually back the call up afterward (endpoint set + backstop
        // enabled). Otherwise keep the normal 30s — never cut staff off early
        // for an AI that can't answer.
        const handoffKind = agentHandoffKind(routingConfig);
        // Only shorten the staff ring when the AI can ACTUALLY back the call up
        // (a reachable agent + backstop enabled). A wss endpoint with the relay
        // server off is NOT reachable → keep the full 30s staff ring.
        const agentReachable = handoffKind === 'relay' || handoffKind === 'dial';
        const backstopActive = agentReachable && routingConfig.noAnswerBackstopEnabled !== false;
        if (backstopActive) ringTimeoutSec = routingConfig.ringTimeoutSec || 30;
        vestibule = languageVestibule({ routingConfig, handoffKind, reentry: langReentry });
        // ── Spanish branch: the caller pressed 2 ──
        // Eligibility is re-proven on the re-entry (gate + switch + reachable
        // relay) — the menu is evidence of intent, not authority. If Spanish
        // cannot start now, the call continues in English (fail open, logged).
        if (spanishChosen) {
          const spanishLeg = languageVestibule({ routingConfig, handoffKind, reentry: false });
          if (spanishLeg) {
            logger.info(`[voice] Spanish vestibule: press 2 → es-US relay for ${maskSid(CallSid)}`);
            // Bounded (codex #3561 r2): the caller who pressed 2 must hear
            // the Spanish leg even if this row is locked. The failover path
            // does not depend on this stamp (it rides the signed action URL);
            // the persistence path re-proves from it and simply declines
            // when it is absent.
            const stamped = await withDeadline(
              db('call_log').where('twilio_call_sid', CallSid)
                .update({
                  answered_by: 'ai_agent',
                  metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ caller_language: 'es' })]),
                  updated_at: new Date(),
                })
                .catch((err) => { logger.warn(`[voice] Spanish language stamp skipped for ${maskSid(CallSid)}: ${err.message}`); return null; }),
            );
            if (stamped == null) logger.warn(`[voice] Spanish language stamp did not settle in time for ${maskSid(CallSid)} — routing anyway`);
            // Profile stamped before the relay opens — same reason as the
            // English legs (codex r13 P2).
            const relayOpts = spanishRelayOptions();
            // The English answer already stamped the active profile; an empty
            // Spanish resolution (English-only profile dropped) clears it.
            await withDeadline(stampRelayProfile(CallSid, relayOpts, { clearWhenEmpty: Boolean(activeRelayTwiMLOptions().relayProfileId) }));
            return res.type('text/xml').send(buildSpanishRelayTwiML({ vestibule: spanishLeg, callSid: CallSid, relayOpts }));
          }
          logger.warn(`[voice] Spanish chosen but no Spanish session can start (${handoffKind}) for ${maskSid(CallSid)} — continuing in English`);
        }
        const decision = decideVoiceRoute({ phase: 'initial', gateEnabled: true, config: routingConfig, now: new Date() });
        if (decision.action === 'agent' && agentReachable) {
          logger.info(`[voice] AI answers-first (${decision.reason}, ${handoffKind}) for ${maskSid(CallSid)}`);
          await db('call_log').where('twilio_call_sid', CallSid)
            .update({ answered_by: 'ai_agent', updated_at: new Date() })
            .catch(() => {});
          if (handoffKind === 'relay') {
            // The greeting MP3 (= the FL §934.03 recorded-line notice) plays
            // BEFORE the relay on this path too (owner ruling 2026-08-28: the
            // relay greeting is Sandy's opener, not the notice). With the
            // vestibule offered it sits inside the Gather; otherwise a bare
            // <Play> — same builder as every other path, spliced into the
            // hand-built relay XML. CallSid binds the upgrade token to THIS
            // call (relay-protocol): the ws endpoint accepts no reusable
            // credential.
            // The profile is stamped on the row BEFORE the relay opens (bounded,
            // fail-soft): a setup Twilio rejects never reaches the ws frame that
            // would otherwise record it (codex r12 P2).
            const relayOpts = activeRelayTwiMLOptions();
            await withDeadline(stampRelayProfile(CallSid, relayOpts));
            const relayXml = buildRelayTwiML({
              wsUrl: routingConfig.agentEndpoint.trim(), callSid: CallSid, action: RELAY_COMPLETE_ACTION,
              ...relayOpts,
            });
            const inner = vestibuleInnerXml({ greetingUrl, vestibule });
            return res.type('text/xml').send(inner ? relayXml.replace('<Response>', `<Response>${inner}`) : relayXml);
          }
          const agentTwiml = new VoiceResponse();
          appendLanguageVestibule(agentTwiml, { greetingUrl, vestibule }); // FL §934.03 disclosure before the agent leg (replayed on a menu re-entry — see hook P0 note)
          appendAgentHandoff(agentTwiml, routingConfig, { callerId: From });
          return res.type('text/xml').send(agentTwiml.toString());
        }
      }
    } catch (agentErr) {
      logger.error(`[voice] answers-first routing failed; using normal flow: ${agentErr.message}`);
      ringTimeoutSec = 30;
      vestibule = null;
    }

    // Mirror the Studio Flow's `forward_call` widget, but add callee
    // screening. Without "press 1 to accept", carrier voicemail can answer
    // Adam/Virginia's cell and steal the caller before Twilio reaches the
    // Waves-owned voicemail recorder.
    const twiml = new VoiceResponse();
    appendLanguageVestibule(twiml, { greetingUrl, vestibule }); // greeting = disclosure; replayed on a menu re-entry (hook P0)
    const forwardNumbers = getFallbackForwardNumbers();
    if (forwardNumbers.length === 0) {
      logger.error('[voice] No inbound staff forward numbers configured; sending caller to Waves voicemail');
      await db('call_log').where('twilio_call_sid', CallSid).update({
        answered_by: 'voicemail',
        call_outcome: 'voicemail',
        updated_at: new Date(),
      });
      appendVoicemailRecording(twiml);
      return res.type('text/xml').send(twiml.toString());
    }

    appendStaffRingDial(twiml, forwardNumbers, ringTimeoutSec);

    res.type('text/xml').send(twiml.toString());
  } catch (err) {
    logger.error(`Voice webhook error: ${err.message}`);
    // Release the claim only if this delivery owns it AND call_log hasn't
    // committed yet (!callLogged), so a Twilio retry can reprocess rather than
    // duplicate the row. A fail-open delivery must not delete a sibling's good
    // claim (see claim above).
    if (claimOwned && !callLogged) void releaseInboundWebhook(req.body?.CallSid);
    notifyTwilioFailure({
      channel: 'voice',
      direction: 'inbound',
      phase: 'webhook',
      status: 'failed',
      sid: req.body?.CallSid,
      errorMessage: err.message,
      from: req.body?.From,
      to: req.body?.To,
      link: '/admin/communications',
    });
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="${SAY_VOICE}">We're sorry, please try again.</Say></Response>`);
  }
});

// =========================================================================
// POST /api/webhooks/twilio/call-complete — Called when the dial completes
// =========================================================================
router.post('/call-complete', async (req, res) => {
  try {
    const { CallSid, CallDuration, DialCallSid, DialCallStatus, DialCallDuration } = req.body;

    const duration = parseInt(DialCallDuration || CallDuration || 0);
    const status = DialCallStatus || 'completed';
    const forwardAccepted = await wasForwardAccepted({ parentCallSid: CallSid, dialCallSid: DialCallSid });
    const { shouldRecordVoicemail, answeredBy } = resolveInboundDialCompletion({
      status,
      duration,
      forwardAccepted,
    });

    const callUpdate = {
      status,
      // A Sandy transfer (PR 2A) reaches this Dial AFTER the relay leg: the
      // AI portion (row created → packet transferred_at) is added back so the
      // saved duration is the whole call, not the staff leg (codex r1 P2).
      // One expression, no extra read; rows without a packet keep `duration`.
      duration_seconds: db.raw(
        "? + COALESCE(CASE WHEN (metadata->'relay_handoff'->>'transferred_at') IS NOT NULL "
        + "THEN GREATEST(0, EXTRACT(EPOCH FROM ((metadata->'relay_handoff'->>'transferred_at')::timestamptz - created_at)))::int ELSE 0 END, 0)",
        [duration],
      ),
      answered_by: answeredBy,
      updated_at: new Date(),
    };
    if (shouldRecordVoicemail) callUpdate.call_outcome = 'voicemail';

    await db('call_log').where('twilio_call_sid', CallSid).update(callUpdate);
    queueVoiceMessageSync(CallSid);

    if (shouldAlertInboundDialFailure({ status, shouldRecordVoicemail })) {
      notifyTwilioFailure({
        channel: 'voice',
        direction: 'inbound',
        phase: 'dial',
        status,
        sid: CallSid,
        from: req.body?.From,
        to: req.body?.To,
        link: '/admin/communications',
      });
    }

    logger.info(`Call complete: ${maskSid(CallSid)} status=${status} duration=${duration}s`);

    // If no answer, play Waves custom voicemail greeting + record.
    //
    // FL §934.03 disclosure: the inbound /voice greeting already
    // notified the caller that the call may be recorded/transcribed/
    // AI-processed BEFORE the dial bridged. That same call is still
    // in progress here, so the consent persists into the voicemail
    // path. We add a brief reaffirmation before <Record> for clarity
    // and to cover the edge case where WAVES_VOICEMAIL_URL doesn't
    // include disclosure language (asset content is opaque to repo —
    // tracked as a separate audit item).
    if (shouldRecordVoicemail) {
      const twiml = new VoiceResponse();
      let handedToAgent = false;
      // Sandy PR 2A: an UNANSWERED transfer ring must not hand the caller —
      // who asked for a person — straight back to Sandy (hook P1). The
      // durable transfer markers decide; a read that fails or times out
      // reads as "not a transfer" (today's path).
      // An UNCONFIRMED read (error / timeout — not "no row") fails CLOSED to
      // voicemail: a transient DB incident must not route a caller who asked
      // for a person back to Sandy (hook P1).
      const transferRow = await withDeadline(
        db('call_log').where('twilio_call_sid', CallSid).first('metadata', 'call_outcome').then((r) => r || false),
        STAMP_DEADLINE_MS,
        'unconfirmed',
      );
      const wasTransfer = transferRow === 'unconfirmed' || isTransferredRow(transferRow);
      if (wasTransfer) logger.info(`[call-complete] ${transferRow === 'unconfirmed' ? 'transfer lookup unconfirmed' : 'unanswered Sandy transfer'} ${maskSid(CallSid)} — voicemail, no AI backstop`);
      // Fail-open AI backstop: replace dumb voicemail with the bilingual agent
      // when enabled (the greeting/disclosure already played at /voice, so
      // consent persists). Any error → fall through to voicemail below.
      try {
        const { isEnabled } = require('../config/feature-gates');
        if (isEnabled('voiceAiAgent') && !wasTransfer) {
          const routingConfig = await getCallRoutingConfig(db);
          const decision = decideVoiceRoute({
            phase: 'after_dial',
            gateEnabled: true,
            noHumanAnswered: true,
            dialStatus: status,
            config: routingConfig,
            now: new Date(),
          });
          if (decision.action === 'agent') {
            const handoffKind = agentHandoffKind(routingConfig);
            if (handoffKind === 'relay') {
              logger.info(`[call-complete] AI backstop relay (${decision.reason}) for ${maskSid(CallSid)}`);
              // Handed to the agent — correct the voicemail outcome stamped above
              // (the final outcome resolves when the relay session ends), and
              // the STATUS: the row carries the unanswered staff dial's
              // 'no-answer' / 'busy', but the parent call is live again with
              // Sandy — a terminal status here would read as a closed call
              // to the transfer packet's fence (PR 2A). /call-status stamps
              // completed on the real hangup.
              // CONFIRMED before the relay renders (codex r6 P2): a reset that
              // failed would leave the terminal status on a live Sandy call
              // and every later transfer refused; with the DB down the
              // session could not claim the row either — voicemail is the
              // coherent fallback.
              const resetPromise = db('call_log').where('twilio_call_sid', CallSid)
                .update({ status: 'in-progress', answered_by: 'ai_agent', call_outcome: null, updated_at: new Date() })
                .catch((err) => { logger.warn(`[call-complete] backstop status reset failed for ${maskSid(CallSid)}: ${err.message}`); return 0; });
              const reset = await withDeadline(resetPromise, STAMP_DEADLINE_MS, 'timeout');
              if (reset === 'timeout') {
                // The deadline does not cancel the queued UPDATE: if it lands
                // after the recorder started it would re-open a call Sandy
                // never took — put the voicemail classification back when it
                // does (detached; codex r6 P1).
                void resetPromise
                  .then((rows) => (Number(rows) > 0
                    ? db('call_log').where('twilio_call_sid', CallSid).where('answered_by', 'ai_agent').whereNull('call_outcome')
                      .update({ status, answered_by: answeredBy, call_outcome: 'voicemail', updated_at: new Date() })
                    : 0))
                  .then((rows) => { if (Number(rows) > 0) logger.warn(`[call-complete] late backstop reset for ${maskSid(CallSid)} put back to voicemail`); })
                  .catch((err) => logger.warn(`[call-complete] late backstop reset compensation failed for ${maskSid(CallSid)}: ${err.message}`));
              }
              if (Number(reset) > 0) {
                // CallSid binds the upgrade token to THIS call (relay-protocol).
                // Profile stamped before the relay opens — same reason as /voice.
                const relayOpts = activeRelayTwiMLOptions();
                await withDeadline(stampRelayProfile(CallSid, relayOpts));
                return res.type('text/xml').send(buildRelayTwiML({
                  wsUrl: routingConfig.agentEndpoint.trim(), callSid: CallSid, action: RELAY_COMPLETE_ACTION,
                  ...relayOpts,
                }));
              }
              logger.warn(`[call-complete] backstop relay skipped for ${maskSid(CallSid)} — status reset unconfirmed; voicemail`);
            }
            if (handoffKind === 'dial') {
              logger.info(`[call-complete] AI backstop dial (${decision.reason}) for ${maskSid(CallSid)}`);
              handedToAgent = appendAgentHandoff(twiml, routingConfig, { callerId: req.body?.From });
            }
            // 'relay_disabled' / 'none' → fall through to Waves voicemail below.
          }
        }
      } catch (agentErr) {
        logger.error(`[call-complete] backstop routing failed; using voicemail: ${agentErr.message}`);
      }
      if (!handedToAgent) appendVoicemailRecording(twiml, { language: relayCompleteLanguage(req) });
      return res.type('text/xml').send(twiml.toString());
    }

    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  } catch (err) {
    logger.error(`Call complete webhook error: ${err.message}`);
    notifyTwilioFailure({
      channel: 'voice',
      direction: 'inbound',
      phase: 'call_complete_webhook',
      status: 'failed',
      sid: req.body?.CallSid,
      errorMessage: err.message,
      from: req.body?.From,
      to: req.body?.To,
      link: '/admin/communications',
    });
    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  }
});

// =========================================================================
// POST /api/webhooks/twilio/voicemail-complete — Terminal <Record> action
// =========================================================================
router.post('/voicemail-complete', (req, res) => {
  res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
});

// =========================================================================
// POST /api/webhooks/twilio/relay-complete — <Connect action> for the AI relay
//
// Twilio requests this when a <Connect><ConversationRelay> session ends. On a
// relay/WS FAILURE (the session-ending errors Twilio documents, e.g. 64102 /
// 64105, a rejected upgrade, or a transient disconnect) we fall OPEN to the
// Waves voicemail so a no-answer-backstop call is never stranded; on a normal
// end (agent finished, or the caller hung up) we just complete the call.
//
// NOTE: ConversationRelay result param names vary by version — verify
// ErrorCode/SessionStatus against the live account on the first call (same
// caveat as relay-protocol.parsePrompt). Unrecognized → clean hangup (valid
// TwiML), never dead air.
// =========================================================================
router.post('/relay-complete', async (req, res) => {
  const body = req.body || {};
  const callSid = body.CallSid;
  const errorCode = [body.ErrorCode, body.errorCode].find(Boolean);
  const sessionStatus = String(body.SessionStatus || body.sessionStatus || '').toLowerCase();
  const failed = !!errorCode || ['failed', 'error', 'disconnected'].includes(sessionStatus);
  const failure = errorCode || sessionStatus;
  const sandbox = req.query.sandbox === '1';
  const twiml = new VoiceResponse();
  const handoff = parseHandoffData(body.HandoffData);
  if (!failed) {
    if (handoff.reason === 'transfer') await appendRelayTransfer(req, twiml, callSid, handoff);
    return res.type('text/xml').send(twiml.toString());
  }

  const recovery = require('../services/voice-agent/relay-recovery');
  let secondFailure = false;
  let recoveryFallback = null;
  if (callSid && recovery.isRecoveryGateOn()) {
    const reconnect = await attemptRelayReconnect(req, callSid, failure);
    if (reconnect.xml) return res.type('text/xml').send(reconnect.xml);
    if (reconnect.unconfirmed) return res.status(503).type('text/xml').send(twiml.toString());
    if (reconnect.duplicate) return res.type('text/xml').send(twiml.toString());
    recoveryFallback = { generation: reconnect.fallbackGeneration, callbackGeneration: Number(req.query.gen) || 0 };
    secondFailure = reconnect.secondFailure === true;
    if (secondFailure && !sandbox && await appendSecondFailureTransfer(req, twiml, callSid, recoveryFallback)) {
      return res.type('text/xml').send(twiml.toString());
    }
  }
  // Both failure destinations use the same fenced write. A lost fence never
  // emits fallback instructions for a call now owned by a healthy reconnect.
  if (callSid) {
    const patch = sandbox ? {
      status: 'failed',
      call_outcome: require('../services/voice-agent/relay-protocol').RELAY_FAILED_OUTCOME,
      metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ relay_sandbox_failed: String(failure).slice(0, 64) })]),
    } : {
      answered_by: 'voicemail', call_outcome: 'voicemail',
      ...(secondFailure ? { status: 'completed' } : {}),
    };
    const row = db('call_log').where('twilio_call_sid', callSid);
    if (recoveryFallback) recovery.fallbackFence(row, recoveryFallback);
    const write = row.update({ ...patch, updated_at: new Date() })
      .catch((err) => logger.warn(`[relay-complete] fallback stamp failed for ${maskSid(callSid)}: ${err.message}`));
    // Gate-off behavior retains its unbounded best-effort reporting write.
    const stamped = await (recoveryFallback ? withDeadline(write, STAMP_DEADLINE_MS, null) : write);
    if (recoveryFallback && !(Number(stamped) > 0)) return res.status(stamped == null ? 503 : 200).type('text/xml').send(twiml.toString());
    if (!sandbox) queueVoiceMessageSync(callSid);
  }
  if (sandbox) twiml.hangup();
  else appendVoicemailRecording(twiml, { language: relayCompleteLanguage(req) });
  res.type('text/xml').send(twiml.toString());
});

/**
 * PR 2B — the one reconnect. The claim is ONE bounded, fenced UPDATE
 * (relay-recovery.claimReconnect): 0 rows = already reconnected or not
 * resumable ⇒ null (the caller takes the second-failure path); an
 * unconfirmed claim (timeout / error) ⇒ HTTP 503 without fallback instructions.
 * A claim that LANDS
 * after the deadline is put back to the fallback's shape when it does (the
 * deadline cannot cancel a queued UPDATE). Then the relay renders again for
 * the same CallSid — same action (language / sandbox), resumed greeting,
 * `resumed=1` parameter — with a token minted AFTER the stamp, so the new
 * socket's generation is ≥ the row's reconnect fence. Returns
 * { xml, duplicate, secondFailure, fallbackGeneration, unconfirmed };
 * duplicate when this is a retry of the first leg's callback on a row that
 * already reconnected (ignore it); secondFailure when the resumed leg
 * itself failed (its action carried `gen`).
 */
async function attemptRelayReconnect(req, callSid, failure) {
  const recovery = require('../services/voice-agent/relay-recovery');
  const nowMs = Date.now();
  const claimPromise = recovery.claimReconnect(db, { callSid, nowMs })
    .catch((err) => { logger.warn(`[relay-complete] reconnect claim failed for ${maskSid(callSid)}: ${err.message}`); return 'error'; });
  const claimed = await withDeadline(claimPromise, STAMP_DEADLINE_MS, 'timeout');
  if (claimed === 'timeout') {
    void claimPromise
      .then((rows) => (Number(rows) > 0 ? recovery.undoLateReconnect(db, { callSid, nowMs }) : 0))
      .then((rows) => { if (Number(rows) > 0) logger.warn(`[relay-complete] late reconnect claim for ${maskSid(callSid)} put back to voicemail`); })
      .catch((err) => logger.warn(`[relay-complete] late reconnect compensation failed for ${maskSid(callSid)}: ${err.message}`));
  }
  if (Number(claimed) > 0) return renderRelayReconnect(req, callSid, failure, nowMs);
  if (claimed !== 0) return { unconfirmed: true };
  const state = await recovery.readReconnectState(db, callSid, { timeoutMs: STAMP_DEADLINE_MS });
  if (!state) return { unconfirmed: true };
  const result = { xml: null, duplicate: false, secondFailure: false, fallbackGeneration: state.reconnectMs || 0 };
  if (state.transferClaimed) return { ...result, duplicate: true };
  if (state.reconnects < 1) return result;
  const callbackGeneration = Number(req.query.gen) || null;
  result.secondFailure = callbackGeneration !== null && callbackGeneration === state.reconnectMs;
  if (result.secondFailure) return result;
  // A live resumed socket makes this an old callback. A missing stamp is
  // likewise not permission to reissue; retain the previous duplicate rule.
  if (!state.reconnectMs || state.claimGen >= state.reconnectMs) return { ...result, duplicate: true };
  // The first response was lost before a resumed socket claimed the call.
  const reissued = await reissueRelayReconnect(callSid, state.reconnectMs);
  if (reissued.ms) return renderRelayReconnect(req, callSid, failure, reissued.ms);
  if (reissued.rows !== 0) return { unconfirmed: true };
  // A concurrent reissue or resumed claim wins; a terminal row can fall back.
  const current = await recovery.readReconnectState(db, callSid, { timeoutMs: STAMP_DEADLINE_MS });
  if (!current) return { unconfirmed: true };
  result.duplicate = current.transferClaimed || Boolean(current.reconnectMs && (current.reconnectMs !== state.reconnectMs || current.claimGen >= current.reconnectMs));
  return result;
}

/** The bounded re-stamp for a replay: { ms } when it landed, { rows: 0 } when refused, {} when unconfirmed. */
async function reissueRelayReconnect(callSid, priorMs) {
  const recovery = require('../services/voice-agent/relay-recovery');
  const nowMs = Date.now();
  const promise = recovery.reissueReconnect(db, { callSid, priorMs, nowMs })
    .catch((err) => { logger.warn(`[relay-complete] reconnect re-issue failed for ${maskSid(callSid)}: ${err.message}`); return 'error'; });
  const rows = await withDeadline(promise, STAMP_DEADLINE_MS, 'timeout');
  if (rows === 'timeout') {
    void promise
      .then((n) => (Number(n) > 0 ? recovery.undoLateReconnect(db, { callSid, nowMs }) : 0))
      .then((n) => { if (Number(n) > 0) logger.warn(`[relay-complete] late reconnect re-issue for ${maskSid(callSid)} put back to voicemail`); })
      .catch((err) => logger.warn(`[relay-complete] late re-issue compensation failed for ${maskSid(callSid)}: ${err.message}`));
  }
  if (Number(rows) > 0) return { ms: nowMs };
  return rows === 0 ? { rows: 0 } : {};
}

/**
 * The reconnect render for a claim stamped `genMs` (the fresh claim, or the
 * re-issue of one whose response was lost): the SAME action (language /
 * sandbox) carrying `gen=<genMs>`, the resumed greeting, `resumed=1`, and a
 * token minted now — after the stamp, so the new socket's generation is ≥
 * the row's fence. No reachable relay ⇒ the claim is put back to the
 * fallback's shape and today's path runs.
 */
async function renderRelayReconnect(req, callSid, failure, genMs) {
  const { isEnabled } = require('../config/feature-gates');
  const recovery = require('../services/voice-agent/relay-recovery');
  const sandbox = req.query.sandbox === '1';
  const language = relayCompleteLanguage(req);
  const { buildRelayTwiML, RELAY_WS_PATH, SPANISH_LANGUAGE } = require('../services/voice-agent/relay-protocol');
  let wsUrl = null;
  let spanishVoice = null;
  if (sandbox) {
    wsUrl = `wss://${sandboxRelayHost(req)}${RELAY_WS_PATH}`;
  } else {
    try {
      const routingConfig = await withDeadline(getCallRoutingConfig(db), STAMP_DEADLINE_MS, null);
      if (isEnabled('voiceAiAgent') && routingConfig && agentHandoffKind(routingConfig) === 'relay') {
        wsUrl = routingConfig.agentEndpoint.trim();
        spanishVoice = routingConfig.spanishVoice || null; // the Spanish leg's voice, as the vestibule renders it
      }
    } catch (err) {
      logger.warn(`[relay-complete] reconnect routing lookup failed for ${maskSid(callSid)}: ${err.message}`);
    }
  }
  if (!wsUrl) {
    // The claim landed but nothing can answer it: put the row back so the
    // fallback below is what the record says happened.
    logger.warn(`[relay-complete] reconnect for ${maskSid(callSid)} has no reachable relay — falling back`);
    await withDeadline(
      recovery.undoLateReconnect(db, { callSid, nowMs: genMs, outcome: sandbox ? 'relay_failed' : 'voicemail', answeredBy: sandbox ? null : 'voicemail', status: 'failed' })
        .catch((err) => logger.warn(`[relay-complete] reconnect undo failed for ${maskSid(callSid)}: ${err.message}`)),
      STAMP_DEADLINE_MS,
    );
    return { xml: null, duplicate: false, secondFailure: false, fallbackGeneration: genMs };
  }
  const spanish = language === 'es';
  // The SAME relay profile the first leg opened with (the row's stamp —
  // a sandbox cell, raw cell-99 attrs, or the production profile), so the
  // recovery is attributed to that profile; no stamp ⇒ the active profile.
  const stamped = await recovery.readReconnectState(db, callSid, { timeoutMs: STAMP_DEADLINE_MS });
  if (!stamped) return { unconfirmed: true }; // never replace unreadable attribution with today's active profile
  const relayOpts = stamped.profile || activeRelayTwiMLOptions(spanish ? { language: SPANISH_LANGUAGE } : {});
  await withDeadline(stampRelayProfile(callSid, relayOpts));
  logger.info(`[relay-complete] reconnecting ${maskSid(callSid)} after ${failure} (${sandbox ? 'sandbox' : 'prod'}${spanish ? ', es' : ''})`);
  // The resumed leg's action carries the reconnect generation, so its own
  // failure callback is told apart from a retry of the first leg's.
  const baseAction = sandbox ? RELAY_COMPLETE_ACTION_SANDBOX : (spanish ? RELAY_COMPLETE_ACTION_ES : RELAY_COMPLETE_ACTION);
  const action = `${baseAction}${baseAction.includes('?') ? '&' : '?'}gen=${genMs}`;
  if (!recovery.isRecoveryGateOn() || (!sandbox && !isEnabled('voiceAiAgent'))) {
    return { xml: null, duplicate: false, secondFailure: false, fallbackGeneration: genMs };
  }
  const xml = buildRelayTwiML({
    wsUrl,
    callSid,
    action,
    ...(spanish ? { language: SPANISH_LANGUAGE, voice: spanishVoice || null } : {}),
    welcomeGreeting: recovery.resumeGreeting(language),
    tokenNow: genMs, // a concurrent reissue makes this token stale at the atomic claim fence
    ...relayOpts,
    parameters: { resumed: '1', ...(spanish ? { lang: 'es' } : {}) },
  });
  return { xml, duplicate: false, secondFailure: false };
}

/**
 * PR 2B — the second failure: office open AND the transfer gate on ⇒ the
 * 2A staff ring (owner-bound to the row's current claim owner, read bounded;
 * the whisper is the generic line — no packet). Anything else ⇒ false and
 * the caller falls to today's voicemail. The capture floor already ran at
 * the first segment's close, so the lead exists either way.
 */
async function appendSecondFailureTransfer(req, twiml, callSid, recoveryFallback) {
  try {
    const { isTransferGateOn } = require('../services/voice-agent/relay-transfer');
    if (!isTransferGateOn()) return false;
    const { loadOfficeHours, isOfficeOpenAt } = require('../services/voice-agent/relay-context');
    const hours = await withDeadline(loadOfficeHours(), STAMP_DEADLINE_MS, null);
    if (!hours || isOfficeOpenAt(hours, new Date()) !== true) return false;
    // An UNCONFIRMED owner read (timeout / error) is not a proven-null owner:
    // the ring claim would then match 0 rows and the caller would get an
    // empty response — fall back to voicemail instead (codex r1 P1).
    const row = await withDeadline(
      db('call_log').where('twilio_call_sid', callSid).first('metadata').then((r) => r || false).catch(() => 'unconfirmed'),
      STAMP_DEADLINE_MS,
      'unconfirmed',
    );
    if (row === 'unconfirmed') {
      logger.warn(`[relay-complete] second failure for ${maskSid(callSid)} — owner read unconfirmed, voicemail instead of a ring`);
      return false;
    }
    const owner = row ? (parseJsonObject(row.metadata).relay_session_claim_owner || null) : null;
    logger.info(`[relay-complete] second failure for ${maskSid(callSid)} — office open, ringing staff`);
    const result = await appendRelayTransfer(req, twiml, callSid, { reason: 'transfer', owner: owner ? String(owner) : null }, recoveryFallback);
    if (result === 'unconfirmed') return false;
    if (result === 'voicemail') {
      // The ring fell to voicemail (no staff numbers / unconfirmed ring
      // claim): the reconnect claim had put the row back to in-progress and
      // nothing after this voicemail finalizes it — stamp the terminal
      // status here too (codex r5 P2). Fenced on the voicemail outcome.
      await withDeadline(
        db('call_log').where('twilio_call_sid', callSid).where('call_outcome', 'voicemail').update({ status: 'completed', updated_at: new Date() })
          .catch((err) => logger.warn(`[relay-complete] second-failure voicemail status stamp failed for ${maskSid(callSid)}: ${err.message}`)),
        STAMP_DEADLINE_MS,
      );
    }
    return true;
  } catch (err) {
    logger.warn(`[relay-complete] second-failure transfer skipped for ${maskSid(callSid)}: ${err.message}`);
    return false;
  }
}

// =========================================================================
// POST /api/webhooks/twilio/relay-sandbox — the ONLY test path for Sandy.
//
// The dead GA# sandbox number's voice URL points here (it used to point at a
// Twilio Function holding a copy of the WS secret; the secret now lives on
// the server only). Every sandbox call gets a call_log row with
// source='voice_relay_sandbox', so the relay session's transcript, latency
// summary and version stamps land through the SAME end() reconcile a
// production call uses — and every call reader (calls tab, unified inbox,
// KPIs, corpus miners, self-audits) excludes the source through
// relay-protocol.whereNotSandboxCall. The session itself is a DRY RUN: the ws
// upgrade proves the source from this row and the relay answers its write
// tools (lead, re-service, booking) without running them — a test call, or
// a stranger dialling the test number, can never create dispatch work.
//
// Cell selection: a two-digit DTMF code inside the first three seconds picks
// a relay profile (relay-profiles SANDBOX_CELLS; '99' = raw
// VOICE_RELAY_SANDBOX_ATTRS) — the audio runner sends it with `sendDigits`. A
// human caller who waits gets the production profile, i.e. exactly what a
// customer would hear — after the same recording disclosure MP3 every
// production inbound path plays. Fail closed: not the sandbox number ⇒ 403;
// relay not attached ⇒ a spoken notice and hangup, never a stranded call.
// Signature validation is the mount's (index.js), same as /voice.
// =========================================================================
const RELAY_SANDBOX_CELL_ACTION = '/api/webhooks/twilio/relay-sandbox/cell';
const RELAY_COMPLETE_ACTION_SANDBOX = `${RELAY_COMPLETE_ACTION}?sandbox=1`;
const SANDBOX_CELL_GATHER_TIMEOUT_SEC = 3;

// ⭐ FAIL CLOSED ON A LIVE LINE. The sandbox is a DRY RUN: a registered Waves
// number pointed here would silently swallow genuine callers (no lead, no
// booking, no KPI). A number is sandbox-eligible only if the registry does
// not own it, or owns it as `unassigned` — the parking spot a retired line
// moves to (config/twilio-numbers.js). The AI toll-free line reports as a
// location, so it is refused like any other owned line.
let sandboxNumberWarned = null;
function sandboxNumber() {
  const n = toE164(process.env.VOICE_RELAY_SANDBOX_NUMBER || '') || null;
  if (!n) return null;
  const last10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);
  const parked = (TWILIO_NUMBERS.unassigned || []).some((u) => last10(u.number) === last10(n));
  if (TWILIO_NUMBERS.isOwnedNumber(n) && !parked) {
    if (sandboxNumberWarned !== n) {
      sandboxNumberWarned = n;
      logger.error(`[relay-sandbox] VOICE_RELAY_SANDBOX_NUMBER ${maskPhone(n)} is a REGISTERED Waves line — sandbox refused (park it under twilio-numbers.unassigned or pick an unregistered number)`);
    }
    return null;
  }
  return n;
}

function isSandboxCall(req) {
  const target = sandboxNumber();
  return !!target && toE164(req.body?.To || '') === target;
}

// The relay socket must open on THIS deploy: a branch bake-off on a Railway
// preview whose SERVER_DOMAIN is unset must not hand the call to production's
// socket, whose database has no sandbox row for it (codex r14 P1). The
// request's Host is Twilio-signature-covered, so it is trustworthy here.
function sandboxRelayHost(req) {
  return process.env.SERVER_DOMAIN
    || process.env.RAILWAY_PUBLIC_DOMAIN
    || (req && req.headers && String(req.headers.host || '').replace(/:\d+$/, ''))
    || 'portal.wavespestcontrol.com';
}
function sandboxRelayXml({ callSid, cell, req = null }) {
  const { buildRelayTwiML, RELAY_WS_PATH } = require('../services/voice-agent/relay-protocol');
  const domain = sandboxRelayHost(req);
  return buildRelayTwiML({
    wsUrl: `wss://${domain}${RELAY_WS_PATH}`,
    callSid,
    action: RELAY_COMPLETE_ACTION_SANDBOX,
    ...(cell || activeRelayTwiMLOptions()),
  });
}

// The profile the relay is about to open with lands on the sandbox row BEFORE
// the relay opens: a profile whose attributes make Twilio reject
// <ConversationRelay> never reaches the WS setup frame, so no session exists
// to stamp it at close — and that is exactly the profile a bake-off must be
// able to attribute. The fallback (production) profile counts too. Fail-soft:
// a stamp failure must not cost the caller the call.
// `clearWhenEmpty`: the Spanish leg follows an English response that already
// stamped the active profile; when the Spanish options resolve to nothing
// (an English-only profile was dropped) the row must say so, or the untuned
// leg is attributed to a profile it never used (codex r14 P2).
async function stampRelayProfile(callSid, opts, { clearWhenEmpty = false } = {}) {
  const has = Boolean(opts && opts.relayProfileId);
  if (!has && !clearWhenEmpty && process.env.GATE_VOICE_RELAY_RECOVERY !== 'true') return;
  const stamp = has
    ? { relay_profile_id: opts.relayProfileId, relay_attrs: opts.relayAttrs || {} }
    : { relay_profile_id: null, relay_attrs: null };
  try {
    await db('call_log')
      .where({ twilio_call_sid: callSid })
      .update({
        metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify(stamp)]),
      });
  } catch (stampErr) {
    logger.warn(`[voice-relay] profile stamp failed ${maskSid(callSid)}: ${stampErr.message}`);
  }
}

// The call_log row for this CallSid exists AND carries the sandbox source —
// the row-level proof the WS upgrade will later trust.
async function sandboxRowOwned(callSid) {
  const { VOICE_RELAY_SANDBOX_SOURCE } = require('../services/voice-agent/relay-protocol');
  const row = await db('call_log').where({ twilio_call_sid: callSid }).first('source');
  return Boolean(row) && row.source === VOICE_RELAY_SANDBOX_SOURCE;
}

function refuseSandbox(req, res, why) {
  logger.warn(`[relay-sandbox] refused: ${why} (To=${maskPhone(req.body?.To)} ${maskSid(req.body?.CallSid)})`);
  return res.status(403).type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
}

router.post('/relay-sandbox', async (req, res) => {
  try {
    if (!isSandboxCall(req)) return refuseSandbox(req, res, 'not the sandbox number');
    const { CallSid, From, To, CallStatus } = req.body || {};
    if (!CallSid) return refuseSandbox(req, res, 'no CallSid');
    const twiml = new VoiceResponse();
    const { VOICE_RELAY_SANDBOX_SOURCE, RELAY_FAILED_OUTCOME } = require('../services/voice-agent/relay-protocol');
    // EVERY sandbox call gets its row (the public-route contract), the
    // relay-unavailable ones included — a failed bake-off attempt must be
    // attributable. Retry-safe on the CallSid unique index: a Twilio
    // redelivery re-renders the same TwiML without a second row.
    // Same per-CallSid advisory lock as /voice and /call-status (codex r10
    // P1): when the status callback wins the webhook-ordering race it has
    // already written its generic fallback row (source column NULL). This
    // request is Twilio-signed AND addressed to the sandbox number, so it is
    // the authority on what the call is — it ADOPTS that row (sandbox source,
    // no customer link) instead of losing the conflict and refusing the call.
    // Any row with a NON-null foreign source is left alone and refused below.
    // The caller's STIR attestation rides the row exactly as /voice stores it
    // (metadata.stir_verstat — what verifyInboundCaller reads), so a bake-off
    // from an A-attested known caller gets production's account context and
    // tool posture (codex r13 P2).
    const sandboxMeta = { relay_sandbox: true, stir_verstat: req.body.StirVerstat || null };
    await db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [CallSid]);
      const existing = await trx('call_log').where({ twilio_call_sid: CallSid }).first('id', 'source');
      if (!existing) {
        await trx('call_log').insert({
          direction: 'inbound',
          from_phone: toE164(From) || null,
          to_phone: toE164(To) || null,
          twilio_call_sid: CallSid,
          status: CallStatus || 'ringing',
          source: VOICE_RELAY_SANDBOX_SOURCE,
          metadata: JSON.stringify(sandboxMeta),
        });
      } else if (existing.source == null || existing.source === VOICE_RELAY_SANDBOX_SOURCE) {
        // NULL = /call-status's generic fallback row (adopt); sandbox-sourced =
        // /call-status saw the sandbox number first and wrote the row without
        // StirVerstat (merge the attestation in). Either way the row is ours.
        await trx('call_log').where({ id: existing.id }).update({
          source: VOICE_RELAY_SANDBOX_SOURCE,
          customer_id: null,
          metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify(sandboxMeta)]),
          updated_at: new Date(),
        });
      }
    });
    // ⭐ FAIL CLOSED ON A FOREIGN ROW. The WS upgrade derives `sandbox` from
    // this row's source, so a pre-existing row with a NON-sandbox source under
    // this CallSid would open a PRODUCTION session for a call admitted through
    // the sandbox route. The row must be ours.
    if (!(await sandboxRowOwned(CallSid))) return refuseSandbox(req, res, 'call_log row is not sandbox-sourced');
    if (!isRelayAttached()) {
      logger.warn(`[relay-sandbox] relay not attached — hanging up ${maskSid(CallSid)}`);
      // The same terminal stamp /relay-complete?sandbox=1 writes, with the reason.
      await db('call_log')
        .where({ twilio_call_sid: CallSid })
        .update({
          status: 'failed',
          call_outcome: RELAY_FAILED_OUTCOME,
          metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ relay_sandbox_failed: 'relay_not_attached' })]),
          updated_at: new Date(),
        });
      twiml.say({ voice: SAY_VOICE }, 'The voice relay is not attached on this deploy. Goodbye.');
      twiml.hangup();
      return res.type('text/xml').send(twiml.toString());
    }
    // The recording disclosure (FL §934.03 — the sandbox number is publicly
    // dialable and the relay transcribes every caller) plays INSIDE the cell
    // <Gather>, so digits count from the first second of the call: a runner
    // that sends its cell code at answer is heard (Twilio drops digits sent
    // before a <Gather> starts). A human caller presses nothing, hears the
    // whole disclosure, and falls through to the default relay in the SAME
    // document after the timeout. The cell continuation replays the
    // disclosure (a digit cut it short) and then renders the relay.
    const gather = twiml.gather({
      input: 'dtmf',
      numDigits: 2,
      timeout: SANDBOX_CELL_GATHER_TIMEOUT_SEC,
      action: RELAY_SANDBOX_CELL_ACTION,
      method: 'POST',
    });
    gather.play(wavesGreetingUrl());
    const gatherInner = twiml.toString().replace(/^<\?xml[^>]*\?>/, '').replace(/^<Response>/, '').replace(/<\/Response>$/, '');
    // No digits ⇒ this document's relay opens with the production profile.
    await stampRelayProfile(CallSid, activeRelayTwiMLOptions());
    const relayXml = sandboxRelayXml({ callSid: CallSid, req });
    logger.info(`[relay-sandbox] answering ${maskSid(CallSid)} from=${maskPhone(From)}`);
    return res.type('text/xml').send(relayXml.replace('<Response>', `<Response>${gatherInner}`));
  } catch (err) {
    logger.error(`[relay-sandbox] error: ${err.message}`);
    return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
  }
});

router.post('/relay-sandbox/cell', async (req, res) => {
  try {
    if (!isSandboxCall(req)) return refuseSandbox(req, res, 'not the sandbox number');
    const { CallSid } = req.body || {};
    if (!CallSid) return refuseSandbox(req, res, 'no CallSid');
    // The same ownership check the answer handler applies: no relay renders
    // over a row that is not sandbox-sourced.
    if (!(await sandboxRowOwned(CallSid))) return refuseSandbox(req, res, 'call_log row is not sandbox-sourced');
    const digits = String(req.body?.Digits || '').trim();
    const { resolveSandboxCell } = require('../services/voice-agent/relay-profiles');
    const cell = resolveSandboxCell(digits);
    logger.info(`[relay-sandbox] cell "${digits}" → ${cell ? cell.relayProfileId : 'production profile'} ${maskSid(CallSid)}`);
    await stampRelayProfile(CallSid, cell || activeRelayTwiMLOptions());
    // A digit INTERRUPTS the disclosure nested in the answer <Gather> (same
    // rule as the language menu above), and Twilio does not report whether
    // the <Play> completed — so the continuation replays the complete
    // disclosure before the relay transcribes a word. Unconditional.
    const replay = new VoiceResponse();
    replay.play(wavesGreetingUrl());
    const replayInner = replay.toString().replace(/^<\?xml[^>]*\?>/, '').replace(/^<Response>/, '').replace(/<\/Response>$/, '');
    return res.type('text/xml').send(sandboxRelayXml({ callSid: CallSid, cell, req }).replace('<Response>', `<Response>${replayInner}`));
  } catch (err) {
    logger.error(`[relay-sandbox] cell error: ${err.message}`);
    return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
  }
});

// =========================================================================
// POST /api/webhooks/twilio/agent-fallback — runs when the AI agent <Dial>
// completes. Agent answered (DialCallStatus 'completed') → end the call. Agent
// unreachable (no-answer/busy/failed/unknown) → fall OPEN to the Waves
// voicemail so the caller is never left in dead air.
// =========================================================================
router.post('/agent-fallback', async (req, res) => {
  const twiml = new VoiceResponse();
  const dialStatus = String(req.body?.DialCallStatus || '').toLowerCase();
  const callSid = req.body?.CallSid;
  const agentDuration = parseInt(req.body?.DialCallDuration || 0, 10) || 0;
  try {
    if (dialStatus === 'completed') {
      // Agent answered & handled the call — reconcile status/outcome AND the
      // agent-leg duration so logs/metrics reflect the real AI conversation
      // instead of the prior staff-leg status ('ringing' answers-first, or
      // 'no-answer'/30s after-dial backstop).
      if (callSid) {
        await db('call_log').where('twilio_call_sid', callSid)
          .update({ status: 'completed', answered_by: 'ai_agent', call_outcome: 'ai_handled', duration_seconds: agentDuration, updated_at: new Date() })
          .catch((e) => logger.warn(`[agent-fallback] call_log update failed: ${e.message}`));
      }
    } else {
      // Agent unreachable → fall open to voicemail; reflect the agent-leg status.
      if (callSid) {
        await db('call_log').where('twilio_call_sid', callSid)
          .update({ status: dialStatus || 'no-answer', answered_by: 'voicemail', call_outcome: 'voicemail', updated_at: new Date() })
          .catch((e) => logger.warn(`[agent-fallback] call_log update failed: ${e.message}`));
      }
      appendVoicemailRecording(twiml);
    }
  } catch (err) {
    logger.error(`[agent-fallback] error; falling back to voicemail: ${err.message}`);
    appendVoicemailRecording(twiml);
  }
  // Re-sync the unified messages row so Customer 360 / comms timeline pick up the
  // final answered_by/status/duration of the AI leg (it was created + synced at
  // /voice and /call-complete before the agent leg finished).
  if (callSid) queueVoiceMessageSync(callSid);
  res.type('text/xml').send(twiml.toString());
});

// =========================================================================
// POST /api/webhooks/twilio/inbound-forward-screen — press-1 screen for staff
//
// Runs on the forwarded staff leg before Twilio bridges the customer. This
// keeps Adam/Virginia's carrier voicemail from answering the customer call.
// A human must press 1; voicemail systems time out and hang up, allowing the
// parent <Dial> to continue or fall through to the Waves-owned voicemail path.
// =========================================================================
router.post('/inbound-forward-screen', (req, res) => {
  try {
    // Generic prompt only — the caller's identity is announced after press-1 (in
    // /inbound-forward-accept), never here. Carrier voicemail commonly answers
    // this leg before timing out, and would record whatever is spoken, so no
    // caller name/number may be read until a human has accepted. "Waves" still
    // signals a business call vs a personal one. No DB lookup here, so a database
    // hiccup can never stop the screening prompt from playing.
    const twiml = new VoiceResponse();
    const gather = twiml.gather({
      numDigits: 1,
      action: '/api/webhooks/twilio/inbound-forward-accept',
      method: 'POST',
      timeout: 7,
    });

    gather.say({ voice: SAY_VOICE }, 'Waves call. Press 1 to connect.');
    twiml.say({ voice: SAY_VOICE }, 'No input received. Goodbye.');
    twiml.hangup();

    res.type('text/xml').send(twiml.toString());
  } catch (err) {
    logger.error(`Inbound forward screen error: ${err.message}`);
    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
  }
});

// =========================================================================
// POST /api/webhooks/twilio/inbound-forward-accept — accept/reject staff leg
// =========================================================================
router.post('/inbound-forward-accept', async (req, res) => {
  try {
    const digits = String(req.body?.Digits || '').trim();
    const twiml = new VoiceResponse();

    if (digits === '1') {
      const parentCallSid = req.body?.ParentCallSid || null;
      await rememberForwardAccept({
        parentCallSid,
        dialCallSid: req.body?.CallSid,
        answeredByNumber: req.body?.To || req.body?.Called,
      });
      // Announce who's calling now that a human has accepted. This is enrichment
      // only — a lookup failure must never break the connect, so fall back to a
      // generic confirmation on any error.
      let callRow = null;
      if (parentCallSid) {
        try {
          callRow = await db('call_log')
            .where('twilio_call_sid', parentCallSid)
            .select('metadata', 'from_phone', 'call_outcome')
            .first();
        } catch (lookupErr) {
          logger.warn(`[voice] forward-accept caller lookup failed for ${maskSid(parentCallSid)}: ${lookupErr.message}`);
        }
      }
      twiml.say({ voice: SAY_VOICE }, connectingAnnouncement(callRow));
    } else {
      twiml.say({ voice: SAY_VOICE }, 'Goodbye.');
      twiml.hangup();
    }

    res.type('text/xml').send(twiml.toString());
  } catch (err) {
    logger.error(`Inbound forward accept error: ${err.message}`);
    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
  }
});

// =========================================================================
// POST /api/webhooks/twilio/recording-status — Recording completed callback
// =========================================================================
router.post('/recording-status', async (req, res) => {
  try {
    const { CallSid, RecordingSid, RecordingUrl, RecordingDuration, RecordingStatus } = req.body;

    if (RecordingStatus === 'completed' && CallSid) {
      const recordingData = {
        recording_url: RecordingUrl ? RecordingUrl + '.mp3' : null,
        recording_sid: RecordingSid,
        recording_duration_seconds: parseInt(RecordingDuration || 0),
        transcription_status: 'pending',
        updated_at: new Date(),
      };

      // For inbound calls answered via <Dial record="record-from-answer-dual">,
      // Twilio attaches the recording to the *child* dial leg — its CallSid
      // differs from the parent inbound CallSid we wrote at /voice. The
      // recording-status callback also carries `ParentCallSid`, which lets
      // us land the recording on the correct parent row. Trying parent
      // first means the by-CallSid match below only catches the rare
      // single-leg / non-dial cases (e.g. voicemail recording on the parent).
      const ParentCallSid = req.body.ParentCallSid || null;
      const requestFrom = req.body.From || null;
      const requestTo = req.body.To || null;

      // PAN-quarantined rows must never re-attach audio: the built-in
      // transcription webhook can flag + quarantine BEFORE this callback
      // delivers the recording URL, and storing it here would put the card
      // audio right back on the row/message (Codex #2676 round-5 P1). The
      // updates skip quarantined rows; the freshly delivered recording is
      // then deleted at Twilio below instead of stored.
      const notQuarantined = function notQuarantined() {
        this.whereNull('transcription_metadata')
          .orWhereRaw("(transcription_metadata::jsonb ->> 'pan_detected') IS DISTINCT FROM 'true'");
      };
      // Resolve the row FIRST (parent preferred, child fallback) so the
      // attach is decided against what the row already holds — see
      // decideRecordingAttach. The guarded UPDATE below still carries the
      // quarantine predicate and a recording_sid fence, so a stamp or a
      // competing delivery landing between this read and the write makes
      // the write skip instead of overwriting.
      const ATTACH_COLUMNS = [
        'id', 'twilio_call_sid', 'recording_sid', 'recording_url', 'recording_duration_seconds',
        'processing_status', 'transcription_metadata', 'metadata',
      ];
      let targetRow = null;
      if (ParentCallSid) {
        targetRow = await db('call_log').where('twilio_call_sid', ParentCallSid).first(...ATTACH_COLUMNS);
      }
      if (!targetRow) {
        targetRow = await db('call_log').where('twilio_call_sid', CallSid).first(...ATTACH_COLUMNS);
      }
      let updated = 0;
      let matchedSid = null;
      let attach = null;
      // A duplicate delivery for a row in a SETTLED state schedules no pass
      // (Codex #3736 r15 P1): the non-force dedup guard skips only
      // 'processed', so a Twilio at-least-once retry of a parked SID would
      // re-run extraction — customer, lead, booking, messaging work — on a
      // voicemail / spam / *_failed row that was deliberately left there.
      // Only a row still awaiting a pass gets the duplicate-recovery attempt.
      const RETRYABLE_STATUSES = new Set([null, 'extraction_failed', 'no_transcription']);
      let duplicateOfSettledRow = false;
      // Decide against what the row holds, write with that decision fenced
      // in, and if the fence refused (a competing callback attached first,
      // or a pass claimed the row after the read) re-read and decide AGAIN
      // against the row as it is now. Two rounds cover one interleaving;
      // whatever still cannot be written is parked, so a RecordingSid is
      // never dropped on the floor — Twilio gets a 200 and will not retry.
      const park = async (row, reason) => {
        const outcome = await parkAdditionalRecording(row, {
          recording_sid: RecordingSid,
          recording_url: recordingData.recording_url,
          recording_duration_seconds: recordingData.recording_duration_seconds,
          reason,
        });
        if (!outcome.parked) return;
        logger.warn(`[recording-status] recording ${maskSid(RecordingSid)} for ${maskSid(row.twilio_call_sid)} parked for review (${reason}) — recording_url kept`);
      };
      for (let round = 0; round < 2 && targetRow && !isPanQuarantinedRow(targetRow); round += 1) {
        attach = decideRecordingAttach(targetRow, { recording_sid: RecordingSid });
        if (attach.action === 'duplicate') {
          // Exactly-once for the row: nothing to write. The processing
          // attempt below is still scheduled — it is claim-fenced and skips
          // an already-processed row, and it is what recovers a first
          // delivery whose in-memory timers a deploy wiped. A retry of a
          // PARKED recording still goes through the park path: it writes
          // nothing new but files the review card if the first delivery
          // lost it.
          if (attach.reason === 'already_parked') await park(targetRow, 'retry');
          duplicateOfSettledRow = !RETRYABLE_STATUSES.has(targetRow.processing_status || null);
          matchedSid = targetRow.twilio_call_sid;
          logger.info(`[recording-status] duplicate delivery of ${maskSid(RecordingSid)} for ${maskSid(matchedSid)} — row untouched`);
          break;
        }
        if (attach.action === 'park') {
          await park(targetRow, attach.reason);
          break;
        }
        const write = { ...recordingData };
        if (attach.action === 'replace') {
          // The row's transcript/extraction (if any) describe the OLD
          // audio. Reset processing_status atomically with the swap so the
          // restart-safe sweep re-runs the call on the new recording even
          // if the in-memory timer below is lost to a deploy: the sweep's
          // fresh branch is `processing_status IS NULL`, and it never
          // re-enters voicemail/spam rows that still carry a transcript.
          write.processing_status = null;
          // …and the retry budget: extraction_attempts counted failures on
          // the OLD audio, and the sweep's cap would otherwise refuse the
          // new recording after a single transient error (Codex #3736 r11).
          write.extraction_attempts = 0;
          // The transcript, its structure and its provider describe the OLD
          // audio: cleared with the swap, or a transcription failure on the
          // new audio would fall back to them and finish the call with the
          // new recording and the old words. PAN stamps (transcription_
          // metadata) are left alone — they are durable by contract.
          write.transcription = null;
          write.transcript_structured = null;
          write.transcription_provider = null;
          // …and everything derived from that transcript: a deferred or
          // failed reprocess must not leave the old call's identity, service
          // and synopsis rendered beside the new audio.
          Object.assign(write, {
          // A rejected-transcript row was parked as 'voicemail' by
          // transcriptRejectionUpdate — answered_by/call_outcome stamped from
          // the audio being discarded here, and the next pass reads either
          // as deterministic voicemail evidence and cannot reclassify the
          // replacement as a live call (Codex #3736 r6 P1). Clear them only
          // when they came with a rejected transcript; Twilio's own dial-
          // completion stamps (no rejection) stay.
          answered_by: db.raw("CASE WHEN transcription_status = 'rejected' AND answered_by = 'voicemail' THEN NULL ELSE answered_by END"),
          call_outcome: db.raw("CASE WHEN transcription_status = 'rejected' AND call_outcome = 'voicemail' THEN NULL ELSE call_outcome END"),
          ai_extraction: null,
          ai_extraction_enriched: null,
          ai_extraction_validation_errors: null,
          v2_extraction_status: null,
          call_summary: null,
          lead_synopsis: null,
          sentiment: null,
          lead_quality: null,
          // The routing audit on the row was derived from the discarded
          // audio too; the replacement pass writes its own, and its route
          // decision is a new row keyed on the new recording (r7 P1).
          ai_validation: null,
          ai_address_validation: null,
          // …and the recording-derived disposition (spam_discarded,
          // callback_task_created…): a deferred or failed replacement pass
          // would otherwise leave the new audio wearing the old terminal
          // outcome to every consumer (Codex #3736 r17 P2).
          disposition: null, });
          // Last-wins as before, but the superseded recording is kept: the
          // dial-leg recording a voicemail replaced is still evidence.
          write.metadata = db.raw(
            "jsonb_set(COALESCE(metadata, '{}'::jsonb), '{superseded_recordings}',"
            + " COALESCE(metadata -> 'superseded_recordings', '[]'::jsonb) || ?::jsonb, true)",
            [JSON.stringify([{ ...attach.superseded, superseded_at: new Date().toISOString(), superseded_by: RecordingSid || null }])],
          );
        }
        const baseline = targetRow;
        // A failed attach/replace transaction (a deadlock, a transient
        // error in the swap or the card retirement) must reach the handler's
        // catch as a redelivery request (Codex #3736 r16 P1): a 200 would
        // tell Twilio the SID was stored while it is stored nowhere, and the
        // recovery sweep cannot find it (the row still has its old URL).
        updated = await db.transaction(async (trx) => {
        const n = await trx('call_log')
          .where({ id: baseline.id })
          .where(notQuarantined)
          // Fence on the recording this decision was made against.
          .where(function recordingUnchanged() {
            if (baseline.recording_sid) this.where('recording_sid', baseline.recording_sid);
            else this.whereNull('recording_sid');
          })
          // Attach and replace are both decided on the status the row had
          // when it was READ; a pass can claim it between that read and this
          // write (and start transcribing the old audio, or finalize without
          // the new audio). Re-checked in the write; zero rows re-decides.
          .whereRaw(NOT_LOAD_BEARING_SQL)
          .update(write);
        // A replace retires the review cards the OLD audio raised (address,
        // scheduling, email, routing): they describe a recording this call
        // no longer has, and the re-run's ON CONFLICT DO NOTHING inserts
        // would otherwise leave them actionable on stale evidence. The
        // additional_recording card is about the recordings themselves and
        // stays. Same transaction as the swap (Codex #3736 r10 P1).
        // The cards in SUPERSEDE_KEPT_REASON_CODES stay (the unit question
        // and the email-review cards close only on a human verdict — never
        // because the audio changed; Codex #3764 r3 + r4 P1).
        if (n > 0 && attach.action === 'replace') {
          const { SUPERSEDE_KEPT_REASON_CODES } = require('../services/call-routing-gates');
          const retired = await trx('triage_items')
            .where({ call_log_id: baseline.id })
            .whereNotIn('reason_code', SUPERSEDE_KEPT_REASON_CODES)
            .whereIn('status', ['open', 'in_progress'])
            .update({ status: 'resolved', resolved_at: new Date(), resolution_note: `Superseded: recording ${baseline.recording_sid || 'none'} replaced by ${RecordingSid}` });
          // The review flag follows the cards (Codex #3736 r14 P2): with the
          // old audio's cards retired and nothing else open, a row that was
          // review-open (a V2-vetoed spam row, say) must not stay counted.
          if (retired > 0) {
            const stillOpen = await trx('triage_items')
              .where({ call_log_id: baseline.id })
              .whereIn('status', ['open', 'in_progress'])
              .first('id');
            if (!stillOpen) await trx('call_log').where({ id: baseline.id }).update({ review_status: null });
          }
        }
        return n;
        }).catch((err) => { err.attachFailed = true; throw err; });
        if (updated > 0) {
          matchedSid = baseline.twilio_call_sid;
          break;
        }
        // Stale decision. Re-read and go round once more; on the second
        // refusal, park rather than lose the recording.
        const nowRow = await db('call_log').where({ id: baseline.id }).first(...ATTACH_COLUMNS);
        if (!nowRow) break;
        targetRow = nowRow;
        if (isPanQuarantinedRow(nowRow)) break;
        if (round === 1) {
          attach = { action: 'park', reason: 'write_contended' };
          await park(nowRow, attach.reason);
        }
      }

      let quarantinedMatch = null;
      let stampedRaceRow = null;
      if (updated === 0 && !matchedSid && attach?.action !== 'park') {
        quarantinedMatch = await db('call_log')
          .whereIn('twilio_call_sid', [ParentCallSid, CallSid].filter(Boolean))
          .whereRaw("(transcription_metadata::jsonb ->> 'pan_detected') = 'true'")
          .first();
      }

      if (updated > 0) {
        logger.info(`Recording saved: ${maskSid(matchedSid)} → ${maskSid(RecordingSid)} (${RecordingDuration}s)`);
        // A recording makes this the voicemail lane's call: retire any
        // missed-call bell already rung for it — unconditionally, not only
        // when the voicemail-callback alert fires (codex r6).
        await require('../services/notification-service').supersedeMissedCallAdmin({ callSid: matchedSid })
          .catch((e) => logger.warn(`[recording-status] missed-call supersede failed for ${maskSid(matchedSid)}: ${e.message}`));
      } else if (quarantinedMatch) {
        logger.warn(`[recording-status] recording ${maskSid(RecordingSid)} arrived for PAN-quarantined call ${maskSid(quarantinedMatch.twilio_call_sid)} — deleting instead of attaching`);
        const qProcessorDelete = require('../services/call-recording-processor');
        await qProcessorDelete.quarantineCardRecording(
          {
            ...quarantinedMatch,
            // The recording that JUST arrived is RecordingSid — preferring
            // the row's stale recording_sid would re-delete the old audio
            // and leave the newly delivered PAN-bearing recording at Twilio
            // (Codex #2676 round-11 P1).
            recording_sid: RecordingSid || quarantinedMatch.recording_sid,
            recording_url: RecordingUrl ? `${RecordingUrl}.mp3` : quarantinedMatch.recording_url,
          },
          { source: 'recording_status_post_quarantine' },
        ).catch((e) => logger.error(`[recording-status] post-quarantine recording delete failed: ${e.message}`));
        // …and the row's own recording plus every parked one (a 404 on an
        // already-deleted one is a complete delete, never a retry).
        await qProcessorDelete.quarantineCardRecording(quarantinedMatch, { source: 'recording_status_post_quarantine' })
          .catch((e) => logger.error(`[recording-status] post-quarantine current recording delete failed: ${e.message}`));
        // The masked transcript is still a REAL transcript — extraction /
        // lead / appointment processing must run for this call (Codex #2676
        // round-9 P1). Processed IMMEDIATELY (round-11 P1): there is no CDN
        // propagation to wait out (the transcript is already stored and the
        // audio is gone), and the 10-minute in-memory timer would strand the
        // row on a restart. processAllPending's quarantined branch is the
        // durable backstop. processRecording handles the null recording_url
        // by falling back to the stored (masked) transcription.
        try {
          const qProcessor = require('../services/call-recording-processor');
          void qProcessor.processRecording(quarantinedMatch.twilio_call_sid)
            .catch((e) => logger.error(`[recording-status] quarantined-transcript processing failed: ${e.message}`));
          queueVoiceMessageSync(quarantinedMatch.twilio_call_sid);
        } catch (e) {
          logger.error(`[recording-status] quarantined-transcript processing setup failed: ${e.message}`);
        }
      } else if (matchedSid) {
        // Duplicate delivery: the row already carries this recording. No
        // Studio-recovery insert, no re-attach — only the idempotent
        // processing attempt below.
      } else if (attach?.action === 'park') {
        // Handled above: the row keeps the recording its transcript came
        // from and the office decides whether to adopt the new one. No
        // orphan insert, no auto-processing of a recording the row does
        // not carry.
      } else if (!ParentCallSid) {
        const primaryCallSid = CallSid;
        try {
          const twilioCall = (!requestFrom || !requestTo) ? await fetchTwilioCall(primaryCallSid) : null;
          const recoveredFrom = requestFrom || twilioCall?.from || null;
          const recoveredTo = requestTo || twilioCall?.to || null;

          await db.transaction(async (trx) => {
            // Serialize with /call-status, which may insert the same
            // Studio-originated parent call at completion time.
            await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [primaryCallSid]);

            const existing = await trx('call_log').where('twilio_call_sid', primaryCallSid).first();
            if (existing) {
              // Same quarantine guard as the direct updates above — and the
              // same zero-row handling (round-18 P2): a stamp landing
              // between the earlier lookup and this transaction means the
              // guarded update silently skips, and the just-arrived
              // recording must be quarantine-deleted, not left at Twilio.
              const guardedCount = await trx('call_log').where({ id: existing.id }).where(notQuarantined).update(recordingData);
              if (guardedCount === 0) {
                stampedRaceRow = existing;
              } else {
                matchedSid = primaryCallSid;
                logger.info(`[recording-status] Attached recording ${maskSid(RecordingSid)} to existing Studio-originated call ${maskSid(primaryCallSid)}`);
              }
              return;
            }

            if (!recoveredFrom || !recoveredTo) {
              logger.warn(
                `[recording-status] No parent call_log row and no recoverable From/To for CallSid=${maskSid(primaryCallSid)}; skipping orphan insert (recording=${maskSid(RecordingSid)})`
              );
              return;
            }
            if (twilioCall?.direction && !String(twilioCall.direction).startsWith('inbound')) {
              logger.warn(
                `[recording-status] No parent call_log row for non-inbound CallSid=${maskSid(primaryCallSid)}; skipping orphan insert (recording=${maskSid(RecordingSid)})`
              );
              return;
            }

            const fromPhone = toE164(recoveredFrom);
            const toPhone = toE164(recoveredTo);
            const numberConfig = TWILIO_NUMBERS.findByNumber(toPhone);
            const customer = fromPhone ? await findSingleCustomerByPhone(trx, fromPhone) : null;

            await trx('call_log').insert({
              customer_id: customer?.id || null,
              direction: 'inbound',
              from_phone: fromPhone,
              to_phone: toPhone,
              twilio_call_sid: primaryCallSid,
              call_sid: CallSid,
              status: twilioCall?.status || 'completed',
              duration_seconds: parseInt(twilioCall?.duration || RecordingDuration || 0),
              metadata: JSON.stringify({
                location: numberConfig?.label || 'unknown',
                numberType: numberConfig?.type || 'unknown',
                domain: numberConfig?.domain || null,
                source: twilioCall ? 'twilio_recording_status_recovered' : 'twilio_studio_recording_status',
              }),
              ...recordingData,
            });
            matchedSid = primaryCallSid;
            logger.info(`[recording-status] Created Studio-originated call_log row from recording callback ${maskSid(CallSid)}`);
          });
        } catch (insertErr) {
          logger.warn(`[recording-status] Failed to recover Studio-originated call_log row for CallSid=${maskSid(CallSid)}: ${insertErr.message}`);
        }
      } else {
        // No parent row found by either SID. The previous fallback inserted
        // a synthetic row using req.body.To/From, but on the dial-leg
        // callback those are the *forwarding* leg — the Twilio number ↔ the
        // forwarded-to destination (for example, a staff cell). Inserting that row
        // attributed every forwarded call to the destination number, which
        // polluted the dashboard's calls-by-source JOIN with phantom
        // staff-cell rows. Match the status_callback
        // handler's defensive pattern: log and skip rather than synthesize
        // a wrongly-attributed row.
        logger.warn(
          `[recording-status] No parent call_log row for CallSid=${maskSid(CallSid)} ParentCallSid=${maskSid(ParentCallSid)}; skipping orphan insert (recording=${maskSid(RecordingSid)})`
        );
      }

      if (stampedRaceRow) {
        // The Studio-branch race resolved to a PAN-stamped row — same
        // handling as quarantinedMatch: delete the just-arrived recording
        // and process the masked transcript immediately (round-18 P2).
        logger.warn(`[recording-status] recording ${maskSid(RecordingSid)} arrived for PAN-stamped call ${maskSid(stampedRaceRow.twilio_call_sid)} (guarded update raced) — deleting instead of attaching`);
        await require('../services/call-recording-processor').quarantineCardRecording(
          {
            ...stampedRaceRow,
            recording_sid: RecordingSid || stampedRaceRow.recording_sid,
            recording_url: RecordingUrl ? `${RecordingUrl}.mp3` : stampedRaceRow.recording_url,
          },
          { source: 'recording_status_post_quarantine' },
        ).catch((e) => logger.error(`[recording-status] raced post-quarantine delete failed: ${e.message}`));
        // …and the row's own recording plus every parked one, now — the
        // first call records the row's current SID as owed but deletes only
        // the just-arrived one; without this mirror of the quarantinedMatch
        // path the current PAN-bearing audio waited for the recovery sweep.
        await require('../services/call-recording-processor').quarantineCardRecording(stampedRaceRow, { source: 'recording_status_post_quarantine' })
          .catch((e) => logger.error(`[recording-status] raced post-quarantine current recording delete failed: ${e.message}`));
        try {
          const rProcessor = require('../services/call-recording-processor');
          void rProcessor.processRecording(stampedRaceRow.twilio_call_sid)
            .catch((e) => logger.error(`[recording-status] raced quarantined-transcript processing failed: ${e.message}`));
          queueVoiceMessageSync(stampedRaceRow.twilio_call_sid);
        } catch (e) {
          logger.error(`[recording-status] raced quarantined processing setup failed: ${e.message}`);
        }
      }

      // Auto-process recording when ready. Use the SID we actually
      // landed the recording on — for forwarded inbound calls that's
      // the parent CallSid, not the child dial leg's CallSid that
      // Twilio sent on this webhook. Skip auto-processing entirely if
      // we couldn't attach the recording to any row above.
      //
      // Two timers (PR #467 + verified-download follow-up): Twilio's
      // recording-status:completed fires before the MP3 is reliably
      // fetchable from their CDN — an early download can 404 or return a
      // partial buffer. The EARLY timer (default 2 min) is safe because the
      // processor now verifies the downloaded bytes against the recording's
      // known duration and defers (releases its claim untouched) when the
      // audio isn't fully propagated; most recordings are ready well before
      // 10 minutes, so this cuts typical transcript latency by ~8 min. The
      // 10-minute timer stays as the second attempt for recordings the
      // early pass deferred, and the 5-min processAllPending cron in
      // scheduler.js remains the restart-safe backstop if these in-memory
      // timers are lost (deploys wipe them — it happened to the first
      // post-cutover call on 2026-07-28).
      if (matchedSid) {
        queueVoiceMessageSync(matchedSid);
        if (duplicateOfSettledRow) {
          logger.info(`[recording-status] duplicate delivery for ${maskSid(matchedSid)} on a settled row — no pass scheduled`);
        } else try {
          const processor = require('../services/call-recording-processor');
          const earlyDelayMs = Number(process.env.CALL_PROC_EARLY_PROCESS_DELAY_MS) || 2 * 60 * 1000;
          const fallbackDelayMs = 10 * 60 * 1000;
          const attempt = async (label) => {
            try {
              return await processor.processRecording(matchedSid);
            } catch (e) {
              logger.error(`Auto-process recording failed (${label}): ${e.message}`);
              return null;
            }
          };
          // The fallback timer is chained on the EARLY attempt's outcome, not
          // scheduled unconditionally: once the early pass reaches ANY result
          // other than a not-ready deferral, re-invoking processRecording at
          // 10 min would re-claim non-'processed' terminal rows (voicemail,
          // spam) and repeat transcription/extraction (Codex #3037 round-2
          // P2). Deferral or error → schedule the second attempt for the
          // remainder of the original 10-minute window. If the process
          // restarts and both in-memory timers are lost, the 5-min cron is
          // still the backstop, unchanged.
          setTimeout(async () => {
            const result = await attempt('early');
            const needsFallback = !result || result.reason === 'recording_not_ready';
            if (needsFallback) {
              setTimeout(() => attempt('fallback'), Math.max(fallbackDelayMs - earlyDelayMs, 60 * 1000));
            }
          }, earlyDelayMs);
        } catch (e) { logger.error(`Recording auto-process setup failed: ${e.message}`); }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    logger.error(`Recording status webhook error: ${err.message}`);
    // A park that did not commit (its review card insert failed and rolled
    // the park back) is the one failure Twilio must deliver again: a 200
    // here would drop the recording for good.
    res.sendStatus(err && (err.parkFailed || err.attachFailed) ? 500 : 200);
  }
});

// =========================================================================
// POST /api/webhooks/twilio/transcription — Twilio's built-in transcription callback
// =========================================================================
router.post('/transcription', async (req, res) => {
  try {
    const { CallSid, RecordingSid, TranscriptionText, TranscriptionStatus } = req.body;

    if (TranscriptionText && CallSid) {
      // Same parent-vs-child SID story as /recording-status: for inbound
      // calls answered via <Dial>, the transcription callback arrives with
      // the child dial-leg CallSid, but the row we want to update is keyed
      // by the parent CallSid. Try ParentCallSid first, fall back to
      // CallSid for non-dial single-leg cases.
      const ParentCallSid = req.body.ParentCallSid || null;
      // PAN redaction guard (card-on-file spec Phase 0): this is the one
      // transcript persistence path that bypasses call-recording-processor's
      // scrub (Twilio's built-in transcription writes the row directly), so
      // a blurted card number must be masked here too.
      const panScrub = require('../utils/pan-scrub').scrubPansDetailed(TranscriptionText);
      const scrubbedTranscription = panScrub.text;
      // Resolve the target row FIRST (parent preferred, child fallback) so
      // the metadata write can MERGE an existing PAN-quarantine stamp — a
      // fresh metadata object here would drop pan_detected when this
      // webhook lands after a provider/backfill quarantine whose card
      // readback Twilio's own transcript happened to omit, and the
      // recording-status/recovery guards key on that stamp
      // (Codex #2676 round-10 P1).
      let targetRow = null;
      const TRANSCRIPTION_COLUMNS = ['id', 'twilio_call_sid', 'recording_sid', 'transcription', 'transcription_provider', 'transcription_metadata', 'metadata', 'call_outcome'];
      if (ParentCallSid) {
        targetRow = await db('call_log').where('twilio_call_sid', ParentCallSid).first(...TRANSCRIPTION_COLUMNS);
      }
      if (!targetRow) {
        targetRow = await db('call_log').where('twilio_call_sid', CallSid).first(...TRANSCRIPTION_COLUMNS);
      }
      let updated = 0;
      let matchedSid = null;
      if (targetRow) {
        const CallProc = require('../services/call-recording-processor');
        const panStamp = panScrub.count > 0
          ? { pan_detected: true, pan_count: panScrub.count, quarantine_source: 'twilio_transcription_webhook_pending' }
          : {};
        // A built-in transcript belongs to ONE recording. Recording A's late
        // callback after B replaced (or the office adopted) it must not put
        // A's words on B's row — the swap cleared the transcript, so this
        // text would land and a failed provider transcription of B would
        // then fall back to it. Decided against the row as read and fenced
        // in the write; the PAN stamp below still lands (A's audio is kept
        // as evidence and its card number still quarantines).
        const staleRecording = !!RecordingSid && !!targetRow.recording_sid && targetRow.recording_sid !== RecordingSid;
        if (staleRecording) {
          logger.info(`[transcription] built-in transcript for ${maskSid(targetRow.twilio_call_sid)} is for ${maskSid(RecordingSid)}, not the row's current recording — text kept out`);
        }
        if (!staleRecording && builtinTranscriptMayReplace(targetRow)) {
          const update = {
            transcription: scrubbedTranscription,
            transcription_status: TranscriptionStatus === 'completed' ? 'completed' : 'failed',
            transcription_provider: 'twilio_builtin',
            transcription_model: null,
            transcription_metadata: CallProc.transcriptionMetadataWrite({
              provider: 'twilio_builtin',
              source: 'twilio_transcription_webhook',
              transcription_status: TranscriptionStatus || null,
              transcript_chars: scrubbedTranscription.length,
              recording_sid_present: !!RecordingSid,
              // Detection stamped in the SAME write that persists the scrubbed
              // text (round-12 P1): a crash before the best-effort quarantine
              // below — or a concurrent /recording-status callback — must
              // still see a durable pan_detected on the row.
              ...panStamp,
            }),
            updated_at: new Date(),
          };
          // The precedence is re-checked IN the write: a provider transcript
          // that landed between the read above and this update keeps its
          // place (see builtinTranscriptMayReplace).
          updated = await db('call_log')
            .where({ id: targetRow.id })
            .where(function builtinMayReplace() {
              this.whereNull('transcription')
                .orWhereNull('transcription_provider')
                .orWhere('transcription_provider', 'twilio_builtin')
                .orWhereRaw(RELAY_STASHED_TRANSFER_SQL);
            })
            // …and still the recording this text describes (a swap landing
            // between the read and this write makes it skip).
            .where(function currentRecording() {
              if (RecordingSid) this.whereNull('recording_sid').orWhere('recording_sid', RecordingSid);
            })
            .update(update);
          if (updated > 0) matchedSid = targetRow.twilio_call_sid;
        }
        if (updated === 0) {
          // A provider transcript is already on the row: the built-in text
          // is not stored over it. A card number Twilio's text caught that
          // the provider transcript did not still has to leave a durable
          // detection stamp and quarantine the audio.
          logger.info(`[transcription] built-in transcript for ${maskSid(targetRow.twilio_call_sid)} kept out — a provider transcript is already on the row`);
          if (panScrub.count > 0) {
            // Merge the detection stamp INTO the row's current metadata in
            // SQL — never serialize the snapshot read above: the processor
            // can write newer provider provenance between that read and
            // this write, and a rebuilt blob would replace it (codex P1).
            await db('call_log').where({ id: targetRow.id }).update({
              transcription_metadata: db.raw(
                "COALESCE(transcription_metadata, '{}'::jsonb) || ?::jsonb",
                [JSON.stringify({ ...panStamp, builtin_pan_detected_after_provider_transcript: true })],
              ),
              updated_at: new Date(),
            });
            matchedSid = targetRow.twilio_call_sid;
            updated = 1;
          }
        }
      }

      if (updated > 0) {
        // Card data detected: the recording itself still carries it — the
        // transcript mask alone leaves the PAN replayable from the audio.
        // Quarantine (Twilio delete + reference strip + office heads-up)
        // BEFORE the message sync so the media never lands in the thread.
        if (panScrub.count > 0) {
          try {
            const callRow = await db('call_log').where('twilio_call_sid', matchedSid).first();
            if (callRow) {
              // This webhook can arrive BEFORE /recording-status stamps the
              // row — carry its own RecordingSid so the Twilio delete can
              // still identify the audio (Codex #2676 round-5 P1). The
              // /recording-status guard covers the reverse ordering.
              const qProcessor = require('../services/call-recording-processor');
              // The audio that produced THIS PAN transcript is the
              // callback's RecordingSid — deleted first (round-12 P1) — and
              // then the row AS IT IS: its current recording and every parked
              // or superseded one (the same two steps as /recording-status).
              // Overriding the row's SID alone deleted the callback's audio,
              // cleared the current recording's URL and left that audio at
              // Twilio with nothing owed.
              if (RecordingSid && RecordingSid !== callRow.recording_sid) {
                await qProcessor.quarantineCardRecording(
                  { ...callRow, recording_sid: RecordingSid, recording_url: null },
                  { source: 'twilio_transcription_webhook' },
                );
              }
              await qProcessor.quarantineCardRecording(callRow, { source: 'twilio_transcription_webhook' });
            }
          } catch (qErr) {
            logger.error(`[transcription] PAN quarantine failed for ${maskSid(matchedSid)}: ${qErr.message}`);
          }
        }
        queueVoiceMessageSync(matchedSid);
        logger.info(`Transcription received: ${maskSid(CallSid)} (${TranscriptionText.length} chars)`);
      } else {
        logger.warn(
          `[transcription] No call_log row for CallSid=${maskSid(CallSid)} ParentCallSid=${maskSid(ParentCallSid)}; transcription dropped (recording=${maskSid(RecordingSid)})`
        );
      }
    }

    res.sendStatus(200);
  } catch (err) {
    logger.error(`Transcription webhook error: ${err.message}`);
    res.sendStatus(200);
  }
});

// =========================================================================
// POST /api/webhooks/twilio/lead-alert-announce — One-way voice alert on new lead
// Reads the lead name + phone aloud (twice) and hangs up. Never dials the lead.
// =========================================================================
router.post('/lead-alert-announce', async (req, res) => {
  try {
    const leadName = req.query.leadName || req.body.leadName || 'a new caller';
    const leadPhoneRaw = req.query.leadPhone || req.body.leadPhone || '';
    const eventLabel = String(req.query.eventLabel || req.body.eventLabel || 'New Waves lead')
      .replace(/[^\w\s.,:-]/g, '')
      .trim()
      .slice(0, 80) || 'New Waves lead';
    const spokenPhone = leadPhoneRaw.replace(/\+1(\d{3})(\d{3})(\d{4})/, '$1. $2. $3.');
    const twiml = new VoiceResponse();
    twiml.pause({ length: 1 });
    twiml.say({ voice: SAY_VOICE }, `${eventLabel}. ${leadName}. Phone ${spokenPhone}`);
    twiml.pause({ length: 1 });
    twiml.say({ voice: SAY_VOICE }, `Again. ${eventLabel}. ${leadName}. Phone ${spokenPhone}`);
    res.type('text/xml').send(twiml.toString());
  } catch (err) {
    logger.error(`Lead alert announce error: ${err.message}`);
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="${SAY_VOICE}">New lead received. Check admin portal.</Say></Response>`);
  }
});

// =========================================================================
// POST /api/webhooks/twilio/outbound-admin-prompt — Step 1: Admin picks up, press 1 to connect
// =========================================================================
router.post('/outbound-admin-prompt', async (req, res) => {
  try {
    const { callLogId, customerNumber, callerIdNumber, leadName: rawName = '' } = req.query;
    const eventLabel = String(req.query.eventLabel || req.body.eventLabel || '')
      .replace(/[^\w\s.,:-]/g, '')
      .trim()
      .slice(0, 80);
    const firstName = rawName.trim().split(/\s+/)[0] || 'a customer';

    const params = new URLSearchParams();
    if (callLogId) params.set('callLogId', callLogId);
    params.set('customerNumber', customerNumber);
    if (callerIdNumber) params.set('callerIdNumber', callerIdNumber);

    const twiml = new VoiceResponse();
    const gather = twiml.gather({
      numDigits: 1,
      action: `/api/webhooks/twilio/outbound-connect?${params.toString()}`,
      method: 'POST',
      timeout: 8,
    });

    gather.say(
      { voice: SAY_VOICE },
      `${eventLabel ? `${eventLabel}. ` : ''}Calling ${firstName}. Press 1 to connect.`
    );

    twiml.say({ voice: SAY_VOICE }, 'No response received. Goodbye.');
    twiml.hangup();

    res.type('text/xml').send(twiml.toString());
  } catch (err) {
    logger.error(`Outbound admin prompt error: ${err.message}`);
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="${SAY_VOICE}">Error. Goodbye.</Say></Response>`);
  }
});

// =========================================================================
// POST /api/webhooks/twilio/outbound-connect — Step 2: Admin pressed 1, now dial the customer
// =========================================================================
router.post('/outbound-connect', async (req, res) => {
  try {
    const customerNumber = req.query.customerNumber || req.body.customerNumber;
    const callerIdNumber = req.query.callerIdNumber || req.body.callerIdNumber || TWILIO_NUMBERS.mainLine.number;
    const rawCallLogId = req.query.callLogId || req.body.callLogId;
    const digits = (req.body.Digits || '').trim();

    // Only "1" connects. Any other digit (or a voicemail system mashing keys)
    // hangs up cleanly so we don't bridge a customer to a voicemail tone.
    if (digits !== '1') {
      const reject = new VoiceResponse();
      reject.say({ voice: SAY_VOICE }, 'Goodbye.');
      reject.hangup();
      return res.type('text/xml').send(reject.toString());
    }

    // Guard against the literal string "undefined" slipping in from a caller
    // that forgot to pass callLogId — a NaN/undefined update would throw or
    // no-op silently. call_log.id is a uuid, so we keep it as a string.
    if (rawCallLogId && rawCallLogId !== 'undefined') {
      try {
        await db('call_log')
          .where({ id: rawCallLogId })
          .update({ status: 'bridged', bridged_at: new Date(), updated_at: new Date() });
      } catch (dbErr) {
        // Don't fail the TwiML response on a DB error — log and continue.
        logger.warn(`[outbound-connect] call_log update failed for ${rawCallLogId}: ${dbErr.message}`);
      }
    }

    // Outbound calls record both legs via record-from-answer-dual. The
    // removed "processed with AI" announcement played on THIS (admin) leg
    // before <Dial> ran — the customer was never on the call yet, so it
    // disclosed nothing to them and only delayed the admin (removed
    // 2026-06-12 at Adam's direction). FL §934.03 note: the customer leg
    // has never received a recording disclosure on outbound calls.
    const twiml = new VoiceResponse();
    const dial = twiml.dial({
      callerId: callerIdNumber,
      record: 'record-from-answer-dual',
      recordingStatusCallback: '/api/webhooks/twilio/recording-status',
      recordingStatusCallbackEvent: 'completed',
    });
    dial.number(customerNumber);
    res.type('text/xml').send(twiml.toString());
  } catch (err) {
    logger.error(`Outbound connect error: ${err.message}`);
    notifyTwilioFailure({
      channel: 'voice',
      direction: 'outbound',
      phase: 'outbound_connect_webhook',
      status: 'failed',
      sid: req.body?.CallSid,
      errorMessage: err.message,
      from: req.body?.From,
      to: req.body?.To,
      link: '/admin/communications',
    });
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="${SAY_VOICE}">Sorry, unable to connect.</Say></Response>`);
  }
});

// =========================================================================
// POST /api/webhooks/twilio/call-status — Status callback for outbound calls
//
// Lookup key convention: this endpoint keys on twilio_call_sid (the parent
// leg's CallSid that Twilio supplies). The /outbound-connect handler uses
// callLogId (our own uuid) because it's a child-leg TwiML callback and
// doesn't have a stable CallSid convention yet. Keep them separate — do not
// add callLogId lookup here or the two code paths will drift.
// =========================================================================
router.post('/call-status', async (req, res) => {
  try {
    const { CallSid, CallStatus, CallDuration, From, To, Direction, ErrorCode, ErrorMessage } = req.body;
    const isOutbound = Direction === 'outbound-api' || Direction === 'outbound-dial';

    await db.transaction(async (trx) => {
      // Serialize per-CallSid so overlapping Twilio retries can't both
      // miss `existing` and double-insert. Released at commit/rollback.
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [CallSid]);

      const existing = await trx('call_log').where('twilio_call_sid', CallSid).first();

      if (existing) {
        // Never roll a finished call back to an in-flight status on a late
        // or retried non-terminal event (see nextCallStatus) — and when the
        // status is retained, keep its duration too: a delayed busy/failed/
        // ringing leg callback carries CallDuration "0" and would otherwise
        // zero a completed call's real length (which drops it from the
        // duration-gated recording sweeps).
        const status = nextCallStatus(existing.status, CallStatus);
        const incomingDuration = parseInt(CallDuration || 0) || 0;
        // On a row that is already terminal the duration never decreases: a
        // retried "completed" or a late leg callback can carry
        // CallDuration "0" (a truthy string) and would otherwise zero the
        // real length, dropping the call from the duration-gated sweeps.
        const duration = TERMINAL_CALL_STATUSES.has(existing.status)
          ? Math.max(Number(existing.duration_seconds) || 0, incomingDuration)
          : (incomingDuration || Number(existing.duration_seconds) || 0);
        await trx('call_log').where('twilio_call_sid', CallSid).update({
          status,
          duration_seconds: duration,
          updated_at: new Date(),
        });
        return;
      }

      // Outbound calls always insert via admin-communications.js's originator —
      // its parent-leg `To` is the admin phone (Adam), not the customer, so
      // synthesizing a row from those fields would key the call to the wrong
      // contact. If the row is missing here, the originator's insert failed
      // upstream; log and skip rather than pollute communications history.
      if (isOutbound) {
        logger.warn(
          `Outbound status_callback with no call_log row CallSid=${maskSid(CallSid)} - originator did not insert; skipping fallback insert`
        );
        return;
      }

      // Inbound fallback: Studio Flow bypassed /voice — insert from status-callback fields.
      const fromPhone = toE164(From);
      const toPhone = toE164(To);
      const numberConfig = TWILIO_NUMBERS.findByNumber(toPhone);
      // A status callback for the SANDBOX number that beats /relay-sandbox to
      // the row writes the sandbox row itself: no customer link and no
      // touchpoint — a bake-off call must never reach a customer's history
      // (codex r10 P1). /relay-sandbox finds it already owned.
      if (isSandboxCall(req)) {
        const { VOICE_RELAY_SANDBOX_SOURCE } = require('../services/voice-agent/relay-protocol');
        await trx('call_log').insert({
          direction: 'inbound',
          from_phone: fromPhone,
          to_phone: toPhone,
          twilio_call_sid: CallSid,
          status: CallStatus,
          duration_seconds: parseInt(CallDuration || 0),
          source: VOICE_RELAY_SANDBOX_SOURCE,
          metadata: JSON.stringify({ relay_sandbox: true, source: 'status_callback' }),
        });
        return;
      }
      const customer = From
        ? await findSingleCustomerByPhone(trx, From)
        : null;

      await trx('call_log').insert({
        customer_id: customer?.id || null,
        direction: 'inbound',
        from_phone: fromPhone,
        to_phone: toPhone,
        twilio_call_sid: CallSid,
        status: CallStatus,
        duration_seconds: parseInt(CallDuration || 0),
        metadata: JSON.stringify({
          location: numberConfig?.label || 'unknown',
          numberType: numberConfig?.type || 'unknown',
          domain: numberConfig?.domain || null,
          source: 'status_callback',
        }),
      });

      // Touchpoint is best-effort enrichment — fire-and-forget so a slow
      // unified-messages write can't block Twilio's webhook timeout. Failures
      // are logged with CallSid for recovery, not silently swallowed.
      void recordTouchpoint({
        customerId: customer?.id,
        channel: 'voice',
        ourEndpointId: To,
        contactPhone: customer ? null : From,
        direction: 'inbound',
        authorType: 'customer',
        twilioSid: CallSid,
        metadata: {
          location: numberConfig?.label || 'unknown',
          numberType: numberConfig?.type || 'unknown',
          domain: numberConfig?.domain || null,
          source: 'status_callback',
        },
      }).catch((err) => {
        logger.error(`recordTouchpoint failed for CallSid=${maskSid(CallSid)}: ${err.message}`);
      });
    });

    // A sandbox call has no recording and must never be handed account-level
    // recording audio by the CallSid-keyed recovery lookup (codex r12 P2).
    if (!isOutbound && CallStatus === 'completed' && !isSandboxCall(req)) {
      scheduleRecordingRecovery(CallSid);
    }

    // A failed/busy/no-answer bake-off is its own artifact (the sandbox row),
    // never an admin bell (codex r14 P2).
    if (isFailureStatus(CallStatus) && !isSandboxCall(req)) {
      notifyTwilioFailure({
        channel: 'voice',
        direction: isOutbound ? 'outbound' : 'inbound',
        phase: 'status',
        status: CallStatus,
        sid: CallSid,
        errorCode: ErrorCode,
        errorMessage: ErrorMessage,
        from: From,
        to: To,
        link: '/admin/communications',
      });
    }

    res.sendStatus(200);
  } catch (err) {
    logger.error(`Call status webhook error: ${err.message}`);
    notifyTwilioFailure({
      channel: 'voice',
      direction: 'unknown',
      phase: 'status_webhook',
      status: 'failed',
      sid: req.body?.CallSid,
      errorMessage: err.message,
      from: req.body?.From,
      to: req.body?.To,
      link: '/admin/communications',
    });
    res.sendStatus(200);
  }
});

router._test = {
  stampRelayProfile,
  decideRecordingAttach,
  nextCallStatus,
  builtinTranscriptMayReplace,
  isPanQuarantinedRow,
  TERMINAL_CALL_STATUSES,
  agentHandoffKind,
  appendAgentHandoff,
  languageVestibule,
  appendLanguageVestibule,
  vestibuleInnerXml,
  buildSpanishRelayTwiML,
  relayCompleteLanguage,
  withDeadline,
  spanishSelected,
  appendVoicemailRecording,
  SPANISH_MENU_PROMPT,
  LANGUAGE_MENU_ACTION,
  buildPreconnectChallengeTwiML,
  findCustomerPhoneMatches,
  knownCallerPhoneExists,
  preconnectScreenDecision,
  connectingAnnouncement,
  appendStaffRingDial,
  parseHandoffData,
  isTransferredRow,
  customerPhoneLookupKey,
  findSingleCustomerByPhone,
  foldVoiceMetadata,
  maskPhone,
  maskSid,
  metadataHasForwardAcceptance,
  parseAddOnsForAudit,
  spokenCallerName,
  rememberForwardAccept,
  resolveCsrName,
  resolveInboundDialCompletion,
  sanitizeVoiceProviderError,
  shouldAlertInboundDialFailure,
  wasForwardAccepted,
  activeRelayTwiMLOptions,
  isSandboxCall,
  sandboxRelayXml,
  RELAY_COMPLETE_ACTION_SANDBOX,
  RELAY_SANDBOX_CELL_ACTION,
};

module.exports = router;
