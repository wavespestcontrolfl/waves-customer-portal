const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const TWILIO_NUMBERS = require('../config/twilio-numbers');

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
    const numberConfig = TWILIO_NUMBERS.findByNumber(To);

    // Match caller to customer
    const customer = await db('customers').where({ phone: From }).first();

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

    logger.info(`Inbound call: ${From} → ${To} (${CallSid}) customer=${customer?.first_name || 'unknown'}`);

    // Build TwiML response — answer with recording enabled
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Thank you for calling Waves Pest Control. Please hold while we connect you.</Say>
  <Dial record="record-from-answer-dual" recordingStatusCallback="/api/webhooks/twilio/recording-status" recordingStatusCallbackEvent="completed" timeout="20" action="/api/webhooks/twilio/call-complete">
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

    // If no answer, go to voicemail
    if (['no-answer', 'busy', 'failed'].includes(status)) {
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Sorry, no one is available right now. Please leave a message after the beep and we'll call you back shortly.</Say>
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
      await db('call_log').where('twilio_call_sid', CallSid).update({
        recording_url: RecordingUrl ? RecordingUrl + '.mp3' : null,
        recording_sid: RecordingSid,
        recording_duration_seconds: parseInt(RecordingDuration || 0),
        transcription_status: 'pending',
        updated_at: new Date(),
      });

      logger.info(`Recording saved: ${CallSid} → ${RecordingSid} (${RecordingDuration}s)`);

      // Trigger async call recording processing (transcription + AI extraction + customer creation)
      try {
        const CallRecordingProcessor = require('../services/call-recording-processor');
        // Delay processing to allow Twilio transcription to arrive first
        setTimeout(() => {
          CallRecordingProcessor.processRecording(CallSid).catch(err => {
            logger.error(`[call-proc] Async processing failed for ${CallSid}: ${err.message}`);
          });
        }, 60000); // 60s delay to wait for Twilio transcription
      } catch (e) { logger.error(`[call-proc] Failed to queue processing: ${e.message}`); }
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
    const domain = process.env.SERVER_DOMAIN || req.headers.host;

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="https://${domain}/api/webhooks/twilio/outbound-connect?customerNumber=${encodeURIComponent(customerNumber)}&amp;callerIdNumber=${encodeURIComponent(callerIdNumber)}" method="POST" timeout="10">
    <Say voice="alice">Outbound call to ${customerNumber.replace(/\+1(\d{3})(\d{3})(\d{4})/, '$1 $2 $3')}. Press 1 to connect.</Say>
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
