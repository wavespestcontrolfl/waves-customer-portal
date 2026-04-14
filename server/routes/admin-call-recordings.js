const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const CallRecordingProcessor = require('../services/call-recording-processor');

router.use(adminAuthenticate, requireTechOrAdmin);

// GET /stats — processing dashboard stats
router.get('/stats', async (req, res, next) => {
  try {
    const stats = await CallRecordingProcessor.getStats();
    res.json(stats);
  } catch (err) { next(err); }
});

// GET /recordings — list recordings with processing status
router.get('/recordings', async (req, res, next) => {
  try {
    const { status, limit = 50, page = 1 } = req.query;
    let query = db('call_log')
      .whereNotNull('recording_url')
      .where('recording_url', '!=', '')
      .leftJoin('customers', 'call_log.customer_id', 'customers.id')
      .select(
        'call_log.*',
        'customers.first_name', 'customers.last_name',
        'customers.email as customer_email', 'customers.phone as customer_phone'
      )
      .orderBy('call_log.created_at', 'desc');

    if (status) query = query.where('call_log.processing_status', status);

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const recordings = await query.limit(parseInt(limit)).offset(offset);

    const [{ count: total }] = await db('call_log')
      .whereNotNull('recording_url')
      .where('recording_url', '!=', '')
      .count('* as count');

    res.json({ recordings, total: parseInt(total), page: parseInt(page) });
  } catch (err) { next(err); }
});

// POST /process/:callSid — process a single recording
router.post('/process/:callSid', async (req, res, next) => {
  try {
    const result = await CallRecordingProcessor.processRecording(req.params.callSid);
    res.json(result);
  } catch (err) { next(err); }
});

// POST /process-all — process all pending recordings
router.post('/process-all', async (req, res, next) => {
  try {
    const result = await CallRecordingProcessor.processAllPending();
    res.json(result);
  } catch (err) { next(err); }
});

// GET /recording/:id — get single recording detail
router.get('/recording/:id', async (req, res, next) => {
  try {
    const recording = await db('call_log')
      .where('call_log.id', req.params.id)
      .leftJoin('customers', 'call_log.customer_id', 'customers.id')
      .select('call_log.*', 'customers.first_name', 'customers.last_name', 'customers.email as customer_email')
      .first();

    if (!recording) return res.status(404).json({ error: 'Recording not found' });
    res.json({ recording });
  } catch (err) { next(err); }
});

// GET /audio/:id — proxy Twilio recording audio (avoids auth redirect)
router.get('/audio/:id', async (req, res) => {
  try {
    const config = require('../config');
    const recording = await db('call_recordings').where({ id: req.params.id })
      .orWhere({ recording_sid: req.params.id })
      .first();

    if (!recording?.recording_url) return res.status(404).json({ error: 'Recording not found' });

    // Fetch from Twilio with auth
    let url = recording.recording_url;
    if (!url.endsWith('.mp3')) url += '.mp3';
    if (!url.startsWith('http')) url = `https://api.twilio.com${url}`;

    const authHeader = 'Basic ' + Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString('base64');
    const audioRes = await fetch(url, { headers: { Authorization: authHeader } });

    if (!audioRes.ok) return res.status(audioRes.status).json({ error: 'Failed to fetch recording' });

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    const buffer = await audioRes.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// CALL DISPOSITION — Tag calls + block spam numbers
// ═══════════════════════════════════════════════════════════════════

// Disposition labels for timeline entries
const DISPOSITION_LABELS = {
  new_lead_booked: 'New Lead — Booked',
  new_lead_no_booking: 'New Lead — No Booking',
  existing_service_q: 'Service Question',
  existing_complaint: 'Complaint',
  spam: 'Spam / Wrong Number',
};

// PUT /calls/:id/disposition — tag a call
router.put('/calls/:id/disposition', async (req, res, next) => {
  try {
    const { disposition } = req.body;

    // Find the call record
    let call = await db('call_log').where({ id: req.params.id }).first();
    if (!call) call = await db('call_log').where({ twilio_call_sid: req.params.id }).first();
    if (!call) return res.status(404).json({ error: 'Call not found' });

    if (disposition === 'spam') {
      // SPAM: block number + delete call from log
      if (call.from_phone) {
        await db.raw(`
          CREATE TABLE IF NOT EXISTS blocked_numbers (
            id serial PRIMARY KEY, phone varchar(20) NOT NULL UNIQUE,
            reason varchar(50) DEFAULT 'spam', blocked_by varchar(100),
            blocked_at timestamptz DEFAULT NOW()
          )
        `).catch(() => {});
        await db('blocked_numbers').insert({
          phone: call.from_phone, reason: 'spam', blocked_by: 'admin',
        }).onConflict('phone').ignore();
        logger.info(`[calls] Blocked spam number: ${call.from_phone}`);
      }
      // Delete the call log entry
      await db('call_log').where({ id: call.id }).del();
      // Delete any SMS sent to this number (missed call follow-up etc.)
      if (call.from_phone) {
        await db('sms_log').where({ to_phone: call.from_phone }).del().catch(() => {});
      }
      res.json({ success: true, disposition, deleted: true });
    } else {
      // NON-SPAM: save disposition + attach to customer timeline
      await db('call_log').where({ id: call.id }).update({ disposition, updated_at: new Date() });

      // Attach to customer timeline if customer_id exists
      if (call.customer_id) {
        const label = DISPOSITION_LABELS[disposition] || disposition;
        const duration = call.duration_seconds ? `${Math.floor(call.duration_seconds / 60)}m ${call.duration_seconds % 60}s` : '';
        await db('customer_interactions').insert({
          customer_id: call.customer_id,
          interaction_type: 'inbound_call',
          subject: `Call tagged: ${label}${duration ? ` (${duration})` : ''}`,
          body: call.transcript_text || null,
          metadata: JSON.stringify({
            disposition,
            callSid: call.twilio_call_sid,
            phone: call.from_phone,
            duration: call.duration_seconds,
            recordingUrl: call.recording_url || null,
          }),
        }).catch(() => {});
        logger.info(`[calls] Tagged call ${call.id} as "${label}" → customer ${call.customer_id} timeline`);
      }

      res.json({ success: true, disposition });
    }
  } catch (err) { next(err); }
});

// GET /blocked — list blocked numbers
router.get('/blocked', async (req, res, next) => {
  try {
    await db.raw('CREATE TABLE IF NOT EXISTS blocked_numbers (id serial PRIMARY KEY, phone varchar(20) NOT NULL UNIQUE, reason varchar(50), blocked_by varchar(100), blocked_at timestamptz DEFAULT NOW())').catch(() => {});
    const numbers = await db('blocked_numbers').orderBy('blocked_at', 'desc');
    res.json({ numbers });
  } catch (err) { next(err); }
});

// DELETE /blocked/:phone — unblock a number
router.delete('/blocked/:phone', async (req, res, next) => {
  try {
    await db('blocked_numbers').where({ phone: req.params.phone }).del();
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
