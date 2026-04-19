const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { etDateString } = require('../utils/datetime-et');

function capitalizeName(name) {
  if (!name) return '';
  return name.trim().toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase())
    .replace(/\bMc(\w)/g, (_, c) => 'Mc' + c.toUpperCase())
    .replace(/\bO'(\w)/g, (_, c) => "O'" + c.toUpperCase());
}

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
      from_phone: From,
      to_phone: To,
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

    // Build TwiML response — answer with recording enabled
    // timeout=15 ensures Twilio hangs up the dial BEFORE the carrier voicemail can answer (~20-25s)
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Thank you for calling Waves Pest Control. Please hold while we connect you.</Say>
  <Dial record="record-from-answer-dual" recordingStatusCallback="/api/webhooks/twilio/recording-status" recordingStatusCallbackEvent="completed" timeout="15" action="/api/webhooks/twilio/call-complete">
    <Number>${numberConfig?.forwardTo || '+19413187612'}</Number>
  </Dial>
</Response>`;

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

    // If no answer, play Waves custom voicemail greeting + record
    if (['no-answer', 'busy', 'failed'].includes(status)) {
      const voicemailAudio = process.env.WAVES_VOICEMAIL_URL || 'https://jet-wolverine-3713.twil.io/assets/waves-voicemail.mp3';
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${voicemailAudio}</Play>
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

      // Update existing call_log entry, or create one if missing
      const updated = await db('call_log').where('twilio_call_sid', CallSid).update(recordingData);
      if (updated === 0) {
        // No call_log entry exists — create one so the recording isn't orphaned
        await db('call_log').insert({
          twilio_call_sid: CallSid,
          call_sid: CallSid,
          from_phone: req.body.From || null,
          to_phone: req.body.To || null,
          direction: 'inbound',
          status: 'completed',
          ...recordingData,
        }).catch(e => logger.error(`[recording-status] Fallback insert failed: ${e.message}`));
        logger.info(`Recording saved (new call_log entry): ${CallSid} → ${RecordingSid} (${RecordingDuration}s)`);
      } else {
        logger.info(`Recording saved: ${CallSid} → ${RecordingSid} (${RecordingDuration}s)`);
      }

      // Auto-process recording when ready
      try {
        const processor = require('../services/call-recording-processor');
        // Queue for processing (don't block the webhook response)
        setTimeout(async () => {
          try {
            await processor.processRecording(CallSid);
          } catch (e) { logger.error(`Auto-process recording failed: ${e.message}`); }
        }, 5000); // 5 second delay to ensure recording is fully available
      } catch (e) { logger.error(`Recording auto-process setup failed: ${e.message}`); }
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
      await db('call_log').where('twilio_call_sid', CallSid).update({
        transcription: TranscriptionText,
        transcription_status: TranscriptionStatus === 'completed' ? 'completed' : 'failed',
        updated_at: new Date(),
      });

      logger.info(`Transcription received: ${CallSid} (${TranscriptionText.length} chars)`);
    }

    res.sendStatus(200);
  } catch (err) {
    logger.error(`Transcription webhook error: ${err.message}`);
    res.sendStatus(200);
  }
});

// =========================================================================
// POST /api/webhooks/twilio/outbound-admin-prompt — Step 1: Admin picks up, press 1 to connect
// =========================================================================
router.post('/outbound-admin-prompt', async (req, res) => {
  try {
    const customerNumber = req.query.customerNumber || req.body.customerNumber;
    const callerIdNumber = req.query.callerIdNumber || req.body.callerIdNumber;
    const leadName = req.query.leadName || req.body.leadName || '';
    const domain = process.env.SERVER_DOMAIN || process.env.RAILWAY_PUBLIC_DOMAIN || 'portal.wavespestcontrol.com';

    const namePrompt = leadName ? `New quote request from ${leadName}.` : `Outbound call to ${customerNumber.replace(/\+1(\d{3})(\d{3})(\d{4})/, '$1 $2 $3')}.`;
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="https://${domain}/api/webhooks/twilio/outbound-connect?customerNumber=${encodeURIComponent(customerNumber)}&amp;callerIdNumber=${encodeURIComponent(callerIdNumber)}" method="POST" timeout="10">
    <Say voice="alice">${namePrompt} Press 1 to connect.</Say>
  </Gather>
  <Say voice="alice">No input received. Goodbye.</Say>
</Response>`;
    res.type('text/xml').send(twiml);
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

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Connecting now.</Say>
  <Dial callerId="${callerIdNumber}" record="record-from-answer-dual" recordingStatusCallback="/api/webhooks/twilio/recording-status" recordingStatusCallbackEvent="completed">
    <Number>${customerNumber}</Number>
  </Dial>
</Response>`;
    res.type('text/xml').send(twiml);
  } catch (err) {
    logger.error(`Outbound connect error: ${err.message}`);
    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, unable to connect.</Say></Response>');
  }
});

// =========================================================================
// POST /api/webhooks/twilio/call-status — Status callback for outbound calls
// =========================================================================
router.post('/call-status', async (req, res) => {
  try {
    const { CallSid, CallStatus, CallDuration } = req.body;

    await db('call_log').where('twilio_call_sid', CallSid).update({
      status: CallStatus,
      duration_seconds: parseInt(CallDuration || 0),
      updated_at: new Date(),
    });

    res.sendStatus(200);
  } catch (err) {
    logger.error(`Call status webhook error: ${err.message}`);
    res.sendStatus(200);
  }
});

module.exports = router;
