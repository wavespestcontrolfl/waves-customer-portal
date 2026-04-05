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

module.exports = router;
