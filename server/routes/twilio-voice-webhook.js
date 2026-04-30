const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { etDateString } = require('../utils/datetime-et');
const VoiceResponse = require('twilio').twiml.VoiceResponse;

function capitalizeName(name) {
  if (!name) return '';
  return name.trim().toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase())
    .replace(/\bMc(\w)/g, (_, c) => 'Mc' + c.toUpperCase())
    .replace(/\bO'(\w)/g, (_, c) => "O'" + c.toUpperCase());
}

// Phone normalization consolidated to server/utils/phone.js (PR1 of
// call-triage work — see docs/call-triage-discovery.md §9). The unified
// implementation is the verbatim toE164 contract that previously lived
// here: preserve `+`-prefixed country codes for non-NANP callers and
// fall back to raw on garbage.
const { toE164 } = require('../utils/phone');

// =========================================================================
// POST /api/webhooks/twilio/voice — Inbound voice call webhook
//
// Twilio hits this when a call comes in to any Waves number.
// We answer, enable recording, and log the call.
// =========================================================================
router.post('/voice', async (req, res) => {
  try {
    const { isEnabled } = require('../config/feature-gates');
    if (!isEnabled('twilioVoice')) {
      logger.info(`[GATE BLOCKED] Voice call from ${req.body.From} (gate: twilioVoice)`);
      return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Thank you for calling Waves Pest Control. Please call back during business hours or text us at 941-318-7612.</Say></Response>');
    }

    const { From, To, CallSid, CallStatus, Direction } = req.body;

    // ── Spam block (must run before any other routing) ──
    const { checkInboundBlock } = require('../middleware/spam-block');
    const blockResult = await checkInboundBlock({ from: From, to: To, channel: 'voice', twilioSid: CallSid });
    if (blockResult.blocked) return res.type('text/xml').send(blockResult.twiml);

    const numberConfig = TWILIO_NUMBERS.findByNumber(To);

    // Match caller to customer
    let customer = await db('customers').where({ phone: From }).first();

    // #4: Caller ID Enrichment via Twilio Lookup API
    if (!customer && From) {
      try {
        const lookupUrl = `https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(From)}?Fields=caller_name`;
        const twilioAuth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
        const lookupRes = await fetch(lookupUrl, { headers: { Authorization: `Basic ${twilioAuth}` } });
        if (lookupRes.ok) {
          const lookupData = await lookupRes.json();
          const callerName = lookupData.caller_name?.caller_name;
          if (callerName && callerName !== 'UNKNOWN' && callerName.trim().length > 0) {
            // Create a lightweight customer record with the caller name
            const nameParts = callerName.trim().split(/\s+/);
            const firstName = capitalizeName(nameParts[0] || 'Unknown');
            const lastName = capitalizeName(nameParts.slice(1).join(' ') || '');
            try {
              const [newCust] = await db('customers').insert({
                first_name: firstName,
                last_name: lastName,
                phone: From,
                address_line1: '', city: '', state: 'FL', zip: '',
                lead_source: 'twilio_lookup',
                pipeline_stage: 'new_lead',
                pipeline_stage_changed_at: new Date(),
                last_contact_date: new Date(),
                last_contact_type: 'call_inbound',
                member_since: etDateString(),
                waveguard_tier: null,
                crm_notes: `Auto-created from Twilio Lookup: ${callerName}`,
              }).returning('*');
              customer = newCust;
              logger.info(`[CallerID] Created customer from lookup: ${callerName} (${From})`);
            } catch (createErr) {
              if (!createErr.message?.includes('duplicate') && !createErr.message?.includes('unique')) {
                logger.error(`[CallerID] Failed to create customer: ${createErr.message}`);
              }
            }
          }
        }
      } catch (lookupErr) {
        // Non-critical — Twilio Lookup is a paid add-on, may not be enabled
        logger.info(`[CallerID] Lookup skipped: ${lookupErr.message}`);
      }
    }

    // Log the inbound call
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
      }),
    });

    // Dual-write to unified messages table. Recording + transcription
    // arrive in later webhooks and update this row via twilio_sid.
    require('../services/conversations').recordTouchpoint({
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
    }).catch(() => {});

    logger.info(`Inbound call: ${From} → ${To} (${CallSid}) customer=${customer?.first_name || 'unknown'}`);

    // Build TwiML response — fallback path that mirrors the production
    // Studio Flow ("Waves Inbound — All Numbers", FW5fdc2e44...).
    //
    // Production routing for every Waves Twilio number lives in that
    // Studio Flow — see Twilio Console. This /voice webhook is the
    // FALLBACK that runs when (a) the Studio Flow is bypassed (rare),
    // (b) an inbound number is provisioned but not yet wired into the
    // flow, or (c) the call_log contract-test harness exercises this
    // path directly.
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

    // Forward target list. Personal cells are NEVER hardcoded as a
    // default in route code (codex review on PR #523, AGENTS.md:
    // hardcoded Twilio numbers drift when numbers move). Source of
    // truth is the WAVES_FALLBACK_FORWARD_NUMBERS env var (CSV of
    // E.164). Per-number forwardTo from twilio-numbers config is the
    // secondary source. If neither is set we route the caller directly
    // to voicemail rather than emit `<Dial></Dial>` (Twilio warning
    // 13223, "invalid dial configuration", which would drop the call
    // before voicemail and is what codex flagged as P1 on PR #523).
    const forwardNumbers = (
      process.env.WAVES_FALLBACK_FORWARD_NUMBERS
      || numberConfig?.forwardTo
      || ''
    )
      .split(',')
      .map(n => n.trim())
      .filter(Boolean);

    let twiml;
    if (forwardNumbers.length === 0) {
      logger.warn(
        `[voice-fallback] No forward targets configured for ${To}. Set WAVES_FALLBACK_FORWARD_NUMBERS or numberConfig.forwardTo. Routing caller directly to voicemail.`
      );
      // Inline voicemail TwiML — mirrors the no-answer fork at
      // /call-complete (line ~191) but emitted directly so we don't
      // have to round-trip through Twilio with an invalid empty
      // <Dial>. Caller hears the (compliance-verified) greeting MP3
      // first so the FL §934.03 disclosure still plays before the
      // recording starts.
      const voicemailAudio = process.env.WAVES_VOICEMAIL_URL
        || 'https://jet-wolverine-3713.twil.io/assets/waves-voicemail.mp3';
      twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${greetingUrl}</Play>
  <Play>${voicemailAudio}</Play>
  <Say voice="alice">Your message will be recorded and transcribed.</Say>
  <Record maxLength="120" transcribe="true" transcribeCallback="/api/webhooks/twilio/transcription" playBeep="true" recordingStatusCallback="/api/webhooks/twilio/recording-status" recordingStatusCallbackEvent="completed" />
  <Say voice="alice">Thank you. We'll get back to you soon. Goodbye.</Say>
</Response>`;
    } else {
      // timeout=15 — must stay BELOW typical carrier voicemail pickup
      // (~20-25s) so we hand off to /call-complete's portal voicemail
      // TwiML when the field staff don't answer, instead of letting
      // the cell's carrier voicemail record. If the cell voicemail
      // answers, Twilio considers the dial completed (status=completed,
      // duration>0), the no-answer fork in /call-complete is skipped,
      // and we lose the recording from the AI extraction pipeline.
      // Studio Flow uses timeout=30 because its `forward_call` widget
      // unconditionally falls through to record_voicemail_3 regardless
      // of dial outcome — the /voice fallback here does NOT have that
      // unconditional fallthrough, so the timeout has to be tighter.
      // (codex P1 on PR #523, after the 99e9fab fallback alignment.)
      const numberXml = forwardNumbers.map(n => `<Number>${n}</Number>`).join('');
      twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${greetingUrl}</Play>
  <Dial record="record-from-answer-dual" recordingStatusCallback="/api/webhooks/twilio/recording-status" recordingStatusCallbackEvent="completed" timeout="15" action="/api/webhooks/twilio/call-complete">
    ${numberXml}
  </Dial>
</Response>`;
    }

    res.type('text/xml').send(twiml);
  } catch (err) {
    logger.error(`Voice webhook error: ${err.message}`);
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>We're sorry, please try again.</Say></Response>`);
  }
});

// =========================================================================
// POST /api/webhooks/twilio/call-complete — Called when the dial completes
// =========================================================================
router.post('/call-complete', async (req, res) => {
  try {
    const { CallSid, CallDuration, DialCallStatus, DialCallDuration } = req.body;

    const duration = parseInt(DialCallDuration || CallDuration || 0);
    const status = DialCallStatus || 'completed';

    // Determine if answered
    let answeredBy = 'unknown';
    if (status === 'completed' && duration > 0) answeredBy = 'human';
    else if (status === 'no-answer' || status === 'busy') answeredBy = 'missed';

    await db('call_log').where('twilio_call_sid', CallSid).update({
      status,
      duration_seconds: duration,
      answered_by: answeredBy,
      updated_at: new Date(),
    });

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
    if (['no-answer', 'busy', 'failed'].includes(status)) {
      const voicemailAudio = process.env.WAVES_VOICEMAIL_URL || 'https://jet-wolverine-3713.twil.io/assets/waves-voicemail.mp3';
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${voicemailAudio}</Play>
  <Say voice="alice">Your message will be recorded and transcribed.</Say>
  <Record maxLength="120" transcribe="true" transcribeCallback="/api/webhooks/twilio/transcription" playBeep="true" recordingStatusCallback="/api/webhooks/twilio/recording-status" recordingStatusCallbackEvent="completed" />
  <Say voice="alice">Thank you. We'll get back to you soon. Goodbye.</Say>
</Response>`;
      return res.type('text/xml').send(twiml);
    }

    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  } catch (err) {
    logger.error(`Call complete webhook error: ${err.message}`);
    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
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
      } else {
        // No parent row found by either SID. The previous fallback inserted
        // a synthetic row using req.body.To/From, but on the dial-leg
        // callback those are the *forwarding* leg — the Twilio number ↔ the
        // forwarded-to destination (e.g. Adam's cell). Inserting that row
        // attributed every forwarded call to the destination number, which
        // polluted the dashboard's calls-by-source JOIN with phantom
        // "Unmapped — +19415993489" rows. Match the status_callback
        // handler's defensive pattern: log and skip rather than synthesize
        // a wrongly-attributed row.
        logger.warn(
          `[recording-status] No parent call_log row for CallSid=${CallSid} ParentCallSid=${ParentCallSid || 'none'}; skipping orphan insert (recording=${RecordingSid})`
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
        updated_at: new Date(),
      };

      let updated = 0;
      if (ParentCallSid) {
        updated = await db('call_log').where('twilio_call_sid', ParentCallSid).update(update);
      }
      if (updated === 0) {
        updated = await db('call_log').where('twilio_call_sid', CallSid).update(update);
      }

      if (updated > 0) {
        logger.info(`Transcription received: ${CallSid} (${TranscriptionText.length} chars)`);
      } else {
        logger.warn(
          `[transcription] No call_log row for CallSid=${CallSid} ParentCallSid=${ParentCallSid || 'none'}; transcription dropped (recording=${RecordingSid})`
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
    const spokenPhone = leadPhoneRaw.replace(/\+1(\d{3})(\d{3})(\d{4})/, '$1. $2. $3.');
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="1"/>
  <Say voice="alice">New Waves lead. ${leadName}. Phone ${spokenPhone}</Say>
  <Pause length="1"/>
  <Say voice="alice">Again. ${leadName}. Phone ${spokenPhone}</Say>
</Response>`;
    res.type('text/xml').send(twiml);
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
      `Calling ${firstName}. Press 1 to connect.`
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
    const callerIdNumber = req.query.callerIdNumber || req.body.callerIdNumber || TWILIO_NUMBERS.locations['lakewood-ranch'].number;
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

    // FL §934.03 — outbound calls record both legs via
    // record-from-answer-dual, so the CALLED CUSTOMER must hear the
    // recording disclosure BEFORE any audio is captured. Previous
    // versions put the disclosure as a top-level <Say> before <Dial>,
    // but TwiML at the top of /outbound-connect's response plays on
    // the CALLING (admin) leg only — the customer was bridged in
    // silently and still recorded (codex P1 on PR #523, line 503).
    //
    // The fix uses Twilio's <Number url=""> "whisper" pattern: the
    // url= attribute points at TwiML that Twilio fetches and plays on
    // the CALLED party's leg as soon as they answer; only after the
    // url's TwiML completes does Twilio bridge the legs. This is the
    // documented surface for screening / whisper messages to the
    // called party and runs BEFORE record-from-answer-dual starts
    // capturing customer audio.
    //
    // Admin hears "Connecting now"; admin is already on notice via
    // CLAUDE.md / company policy that admin↔customer calls are
    // recorded, so admin-side disclosure is not load-bearing here.
    const twiml = new VoiceResponse();
    twiml.say({ voice: 'Polly.Joanna' }, 'Connecting now.');
    const dial = twiml.dial({
      callerId: callerIdNumber,
      record: 'record-from-answer-dual',
      recordingStatusCallback: '/api/webhooks/twilio/recording-status',
      recordingStatusCallbackEvent: 'completed',
    });
    dial.number(
      { url: '/api/webhooks/twilio/outbound-callee-disclosure' },
      customerNumber
    );
    res.type('text/xml').send(twiml.toString());
  } catch (err) {
    logger.error(`Outbound connect error: ${err.message}`);
    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, unable to connect.</Say></Response>');
  }
});

// =========================================================================
// POST /api/webhooks/twilio/outbound-callee-disclosure — TwiML played to
// the customer (called party) leg before the outbound bridge completes.
//
// Wired via <Number url> in /outbound-connect. Twilio fetches this URL
// when the customer's phone answers the outbound dial, plays the
// returned TwiML on the customer's leg, and only THEN bridges to the
// admin leg. This is the documented Twilio pattern for a "whisper" /
// screening message to the called party.
//
// FL §934.03 disclosure surface for outbound recorded calls. Runs
// BEFORE record-from-answer-dual starts capturing customer audio,
// closing the gap codex P1 flagged on PR #523. Admin disclosure is
// not duplicated here — admin is on notice via company policy.
// =========================================================================
router.post('/outbound-callee-disclosure', (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">This call from Waves Pest Control may be recorded, transcribed, and processed with A I to improve service. By staying on the line, you consent to this recording and processing.</Say>
</Response>`;
  res.type('text/xml').send(twiml);
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
    const { CallSid, CallStatus, CallDuration, From, To, Direction } = req.body;

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
      const isOutbound = Direction === 'outbound-api' || Direction === 'outbound-dial';
      if (isOutbound) {
        logger.warn(
          `Outbound status_callback with no call_log row CallSid=${CallSid} — originator did not insert; skipping fallback insert`
        );
        return;
      }

      // Inbound fallback: Studio Flow bypassed /voice — insert from status-callback fields.
      const numberConfig = TWILIO_NUMBERS.findByNumber(To);
      const customer = From
        ? await trx('customers').where({ phone: From }).first()
        : null;

      await trx('call_log').insert({
        customer_id: customer?.id || null,
        direction: 'inbound',
        from_phone: From,
        to_phone: To,
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
      void require('../services/conversations').recordTouchpoint({
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
        logger.error(`recordTouchpoint failed for CallSid=${CallSid}: ${err.message}`);
      });
    });

    res.sendStatus(200);
  } catch (err) {
    logger.error(`Call status webhook error: ${err.message}`);
    res.sendStatus(200);
  }
});

module.exports = router;
