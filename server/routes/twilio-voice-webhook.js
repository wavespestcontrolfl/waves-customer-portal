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
  }, 2 * 60 * 1000);
}

// Phone normalization consolidated to server/utils/phone.js (PR1 of
// call-triage work — see docs/call-triage-discovery.md §9). The unified
// implementation is the verbatim toE164 contract that previously lived
// here: preserve `+`-prefixed country codes for non-NANP callers and
// fall back to raw on garbage.
const { toE164 } = require('../utils/phone');

function phoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function customerPhoneLookupKey(value) {
  const normalized = toE164(value);
  const digits = phoneDigits(normalized || value);
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

function maskPhone(value) {
  const digits = phoneDigits(value);
  return digits ? `***${digits.slice(-4)}` : 'unknown';
}

async function findSingleCustomerByPhone(dbLike, phone) {
  const key = customerPhoneLookupKey(phone);
  if (!key) return null;

  const query = dbLike('customers').whereNull('deleted_at');
  if (key.length === 10) {
    query.whereRaw(
      "(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = ? OR regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = ?)",
      [key, `1${key}`]
    );
  } else {
    query.whereRaw("regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = ?", [key]);
  }

  const matches = await query.orderBy('updated_at', 'desc').limit(2);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    logger.warn(`[voice] ${matches.length} customers share caller phone ${maskPhone(phone)}; not auto-linking call_log`);
  }
  return null;
}

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

// Read a number aloud only when it is a genuine North American (NANP) number.
// A '+'-prefixed value carries an explicit country code, so only +1 followed by
// 10 digits qualifies; other international callers (e.g. +49…/+44…) fall back to
// the generic confirmation so staff are never read a misleading U.S.-style
// number. Bare (no '+') 10-digit or 1+10-digit values are treated as US.
function spokenPhoneDigits(raw) {
  const str = String(raw || '').trim();
  const digits = str.replace(/\D/g, '');
  let nanp = null;
  if (str.startsWith('+')) {
    if (digits.length === 11 && digits.startsWith('1')) nanp = digits.slice(1);
  } else if (digits.length === 10) {
    nanp = digits;
  } else if (digits.length === 11 && digits.startsWith('1')) {
    nanp = digits.slice(1);
  }
  if (!nanp) return '';
  return `${nanp.slice(0, 3)}. ${nanp.slice(3, 6)}. ${nanp.slice(6)}.`;
}

// Spoken to the staff member AFTER they press 1 to accept — by which point a
// human, never carrier voicemail, is on the line — so it is safe to read caller
// identity here. Derived from the persisted call_log row (name stamped into
// metadata by /voice; number from the from_phone column), never from a URL.
function connectingAnnouncement(row) {
  const name = String(parseJsonObject(row?.metadata).screen_caller_name || '')
    .replace(/[^\p{L}\p{N}\s.'’-]/gu, '')
    .trim()
    .slice(0, 60);
  if (name) return `Connecting your call from ${name}.`;
  const spoken = spokenPhoneDigits(row?.from_phone);
  if (spoken) return `Connecting your call from an unknown number. ${spoken}`;
  return 'Connecting your call.';
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

function appendVoicemailRecording(twiml) {
  const voicemailAudio = process.env.WAVES_VOICEMAIL_URL || 'https://jet-wolverine-3713.twil.io/assets/waves-voicemail.mp3';
  twiml.play(voicemailAudio);
  twiml.say({ voice: 'alice' }, 'Your message will be recorded and transcribed.');
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
  void syncVoiceMessageForCall(callSid);
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
  // Flipped true once the call_log row (non-idempotent; twilio_call_sid not
  // unique) has committed, after which we must not release the claim on error.
  let callLogged = false;
  try {
    const { isEnabled } = require('../config/feature-gates');
    if (!isEnabled('twilioVoice')) {
      logger.info(`[GATE BLOCKED] Voice call from ${maskPhone(req.body.From)} (gate: twilioVoice)`);
      return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Thank you for calling Waves Pest Control. Please call back during business hours or text us at 941-318-7612.</Say></Response>');
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
      recordAttempt: firstDelivery,
    });
    if (blockResult.blocked) return res.type('text/xml').send(blockResult.twiml);

    const numberConfig = TWILIO_NUMBERS.findByNumber(To);

    // Match caller to customer
    let customer = await findSingleCustomerByPhone(db, From);

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

    // Log the inbound call (first delivery only — see claim above)
    if (firstDelivery) {
    await db('call_log').insert({
      customer_id: customer?.id || null,
      direction: 'inbound',
      from_phone: toE164(From),
      to_phone: toE164(To),
      twilio_call_sid: CallSid,
      status: CallStatus || 'ringing',
      metadata: JSON.stringify({
        location: numberConfig?.label || 'unknown',
        numberType: numberConfig?.type || 'unknown',
        domain: numberConfig?.domain || null,
        // Read back after press-1 by connectingAnnouncement(). Stored server-side
        // so the caller's name never enters a callback URL (request-logger safe).
        screen_caller_name: spokenCallerName(customer),
      }),
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

    logger.info(`Inbound call: ${maskPhone(From)} -> ${maskPhone(To)} (${maskSid(CallSid)}) customer=${customer?.first_name || 'unknown'}`);

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
    const greetingUrl = process.env.WAVES_GREETING_URL
      || 'https://jet-wolverine-3713.twil.io/assets/ElevenLabs_2025-09-20T05_54_14_Veda%20Sky%20-%20Customer%20Care%20Agent_pvc_sp114_s58_sb72_se89_b_m2.mp3';

    // Mirror the Studio Flow's `forward_call` widget, but add callee
    // screening. Without "press 1 to accept", carrier voicemail can answer
    // Adam/Virginia's cell and steal the caller before Twilio reaches the
    // Waves-owned voicemail recorder.
    const twiml = new VoiceResponse();
    twiml.play(greetingUrl);
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

    const dial = twiml.dial({
      record: 'record-from-answer-dual',
      recordingStatusCallback: '/api/webhooks/twilio/recording-status',
      recordingStatusCallbackEvent: 'completed',
      timeout: 30,
      action: '/api/webhooks/twilio/call-complete',
      answerOnBridge: true,
    });

    for (const number of forwardNumbers) {
      dial.number({
        url: '/api/webhooks/twilio/inbound-forward-screen',
        method: 'POST',
      }, number);
    }

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
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>We're sorry, please try again.</Say></Response>`);
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
      duration_seconds: duration,
      answered_by: answeredBy,
      updated_at: new Date(),
    };
    if (shouldRecordVoicemail) callUpdate.call_outcome = 'voicemail';

    await db('call_log').where('twilio_call_sid', CallSid).update(callUpdate);
    queueVoiceMessageSync(CallSid);

    if (isFailureStatus(status)) {
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

    logger.info(`Call complete: ${CallSid} status=${status} duration=${duration}s`);

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
      appendVoicemailRecording(twiml);
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

    gather.say({ voice: 'Polly.Joanna' }, 'Waves call. Press 1 to connect.');
    twiml.say({ voice: 'Polly.Joanna' }, 'No input received. Goodbye.');
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
            .select('metadata', 'from_phone')
            .first();
        } catch (lookupErr) {
          logger.warn(`[voice] forward-accept caller lookup failed for ${maskSid(parentCallSid)}: ${lookupErr.message}`);
        }
      }
      twiml.say({ voice: 'Polly.Joanna' }, connectingAnnouncement(callRow));
    } else {
      twiml.say({ voice: 'Polly.Joanna' }, 'Goodbye.');
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

      let updated = 0;
      let matchedSid = null;
      if (ParentCallSid) {
        updated = await db('call_log')
          .where('twilio_call_sid', ParentCallSid)
          .update(recordingData);
        if (updated > 0) matchedSid = ParentCallSid;
      }
      if (updated === 0) {
        updated = await db('call_log')
          .where('twilio_call_sid', CallSid)
          .update(recordingData);
        if (updated > 0) matchedSid = CallSid;
      }

      if (updated > 0) {
        logger.info(`Recording saved: ${matchedSid} → ${RecordingSid} (${RecordingDuration}s)`);
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
              await trx('call_log').where({ id: existing.id }).update(recordingData);
              matchedSid = primaryCallSid;
              logger.info(`[recording-status] Attached recording ${maskSid(RecordingSid)} to existing Studio-originated call ${maskSid(primaryCallSid)}`);
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

      // Auto-process recording when ready. Use the SID we actually
      // landed the recording on — for forwarded inbound calls that's
      // the parent CallSid, not the child dial leg's CallSid that
      // Twilio sent on this webhook. Skip auto-processing entirely if
      // we couldn't attach the recording to any row above.
      //
      // 10-minute delay (PR #467): Twilio's recording-status:completed
      // fires before the MP3 is reliably fetchable from their CDN, so the
      // auth'd download in the processor can 404 or return a partial
      // buffer and Gemini gets garbage. Empirically ~10 min is the
      // propagation window where the download stabilizes. The 5-min
      // processAllPending cron in scheduler.js is the restart-safe
      // backstop if this in-memory timer is lost — it applies the same
      // age gate, so it will not fire ahead of the window.
      if (matchedSid) {
        queueVoiceMessageSync(matchedSid);
        try {
          const processor = require('../services/call-recording-processor');
          setTimeout(async () => {
            try {
              await processor.processRecording(matchedSid);
            } catch (e) { logger.error(`Auto-process recording failed: ${e.message}`); }
          }, 10 * 60 * 1000);
        } catch (e) { logger.error(`Recording auto-process setup failed: ${e.message}`); }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    logger.error(`Recording status webhook error: ${err.message}`);
    res.sendStatus(200);
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
      const update = {
        transcription: TranscriptionText,
        transcription_status: TranscriptionStatus === 'completed' ? 'completed' : 'failed',
        transcription_provider: 'twilio_builtin',
        transcription_model: null,
        transcription_metadata: JSON.stringify({
          provider: 'twilio_builtin',
          source: 'twilio_transcription_webhook',
          transcription_status: TranscriptionStatus || null,
          transcript_chars: TranscriptionText.length,
          recording_sid_present: !!RecordingSid,
        }),
        updated_at: new Date(),
      };

      let updated = 0;
      let matchedSid = null;
      if (ParentCallSid) {
        updated = await db('call_log').where('twilio_call_sid', ParentCallSid).update(update);
        if (updated > 0) matchedSid = ParentCallSid;
      }
      if (updated === 0) {
        updated = await db('call_log').where('twilio_call_sid', CallSid).update(update);
        if (updated > 0) matchedSid = CallSid;
      }

      if (updated > 0) {
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
    twiml.say({ voice: 'alice' }, `${eventLabel}. ${leadName}. Phone ${spokenPhone}`);
    twiml.pause({ length: 1 });
    twiml.say({ voice: 'alice' }, `Again. ${eventLabel}. ${leadName}. Phone ${spokenPhone}`);
    res.type('text/xml').send(twiml.toString());
  } catch (err) {
    logger.error(`Lead alert announce error: ${err.message}`);
    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>New lead received. Check admin portal.</Say></Response>');
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
      { voice: 'Polly.Joanna' },
      `${eventLabel ? `${eventLabel}. ` : ''}Calling ${firstName}. Press 1 to connect.`
    );

    twiml.say('No response received. Goodbye.');
    twiml.hangup();

    res.type('text/xml').send(twiml.toString());
  } catch (err) {
    logger.error(`Outbound admin prompt error: ${err.message}`);
    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Error. Goodbye.</Say></Response>');
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
      reject.say({ voice: 'Polly.Joanna' }, 'Goodbye.');
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
    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, unable to connect.</Say></Response>');
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
        await trx('call_log').where('twilio_call_sid', CallSid).update({
          status: CallStatus,
          duration_seconds: parseInt(CallDuration || existing.duration_seconds || 0),
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

    if (!isOutbound && CallStatus === 'completed') {
      scheduleRecordingRecovery(CallSid);
    }

    if (isFailureStatus(CallStatus)) {
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
  connectingAnnouncement,
  customerPhoneLookupKey,
  findSingleCustomerByPhone,
  maskPhone,
  maskSid,
  metadataHasForwardAcceptance,
  spokenCallerName,
  spokenPhoneDigits,
  rememberForwardAccept,
  resolveCsrName,
  resolveInboundDialCompletion,
  sanitizeVoiceProviderError,
  wasForwardAccepted,
};

module.exports = router;
