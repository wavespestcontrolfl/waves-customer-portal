// server/routes/dispatch.js

// Startup env checks — warn but don't crash
const DISPATCH_ENV_CHECKS = [
  ['ANTHROPIC_API_KEY', 'AI scoring/optimization will use rule-based fallback'],
  ['TWILIO_ACCOUNT_SID', 'SMS notifications on cancel/reschedule will be skipped'],
  ['TWILIO_AUTH_TOKEN', 'SMS notifications on cancel/reschedule will be skipped'],
];
for (const [key, fallback] of DISPATCH_ENV_CHECKS) {
  if (!process.env[key]) console.warn(`[dispatch] Missing env var: ${key} — ${fallback}`);
}

const router = require('express').Router();
const { optimizeDay, absorbCancellation } = require('../services/dispatch/route-optimizer');
const { scoreAll } = require('../services/dispatch/job-scorer');
const { simulate } = require('../services/dispatch/tech-matcher');
const { getRecommendedSlots } = require('../services/dispatch/csr-booker');
const { getDashboardMetrics } = require('../services/dispatch/insight-engine');
const { etDateString } = require('../utils/datetime-et');

let db;
function getDb() {
  if (!db) db = require('../models/db');
  return db;
}

// GET /api/dispatch/routes?date=YYYY-MM-DD&mode=mixed&zone=all
router.get('/routes', async (req, res) => {
  try {
    const { date = etDateString(), mode = 'mixed', zone = 'all' } = req.query;
    const routes = await optimizeDay(date, { mode, zone });
    res.json({ routes, date, mode, zone });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dispatch/routes/reoptimize
router.post('/routes/reoptimize', async (req, res) => {
  try {
    const { date = etDateString(), mode = 'mixed', zone = 'all' } = req.body;
    const routes = await optimizeDay(date, { mode, zone });
    res.json({ routes, message: 'Route reoptimized' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dispatch/jobs/:id/cancel
router.post('/jobs/:id/cancel', async (req, res) => {
  try {
    // Look up the job before cancelling so we have customer info for SMS
    const cancelledJob = await getDb()('dispatch_jobs').where('id', req.params.id).first();

    const result = await absorbCancellation(req.params.id);

    // Send reschedule SMS to the cancelled job's customer
    if (cancelledJob?.sheet_row_id) {
      try {
        const svc = await getDb()('scheduled_services')
          .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
          .where('scheduled_services.id', cancelledJob.sheet_row_id)
          .select('customers.first_name', 'customers.phone', 'customers.id as customer_id')
          .first();

        if (svc?.phone) {
          const TwilioService = require('../services/twilio');
          const svcLabel = (cancelledJob.service_type || 'service').replace(/_/g, ' ');
          await TwilioService.sendSMS(svc.phone,
            `Hi ${svc.first_name || 'there'}, your ${svcLabel} appointment has been rescheduled. We'll confirm your new time shortly. — Waves Pest Control`,
            { customerId: svc.customer_id, messageType: 'reschedule' }
          );
        }
      } catch (smsErr) {
        console.warn('[dispatch] SMS on cancellation failed:', smsErr.message);
      }
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dispatch/jobs?date=YYYY-MM-DD&techId=uuid&status=scheduled
router.get('/jobs', async (req, res) => {
  try {
    const { date, techId, status } = req.query;
    const q = getDb()('dispatch_jobs').orderBy('route_position', 'asc');
    if (date) q.where('scheduled_date', date);
    if (techId) q.where('assigned_tech_id', techId);
    if (status) q.where('status', status);
    const jobs = await q;
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dispatch/jobs/:id/score
router.post('/jobs/:id/score', async (req, res) => {
  try {
    const { date = etDateString() } = req.body;
    const job = await getDb()('dispatch_jobs').where('id', req.params.id).first();
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const { scoreJob } = require('../services/dispatch/job-scorer');
    const scored = await scoreJob(job);
    res.json(scored);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dispatch/match/simulate
// Body: { serviceType, zip, jobCategory }
router.post('/match/simulate', async (req, res) => {
  try {
    const { serviceType, zip, jobCategory } = req.body;
    const result = await simulate(serviceType, zip, jobCategory);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dispatch/techs
router.get('/techs', async (req, res) => {
  try {
    const techs = await getDb()('dispatch_technicians').where('active', true);
    res.json(techs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dispatch/csr/slots
// Body: { scenario, serviceType, zip }
router.post('/csr/slots', async (req, res) => {
  try {
    const { scenario, serviceType, zip } = req.body;
    const result = await getRecommendedSlots(scenario, serviceType, zip);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dispatch/insights?days=30
router.get('/insights', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const metrics = await getDashboardMetrics(days);
    res.json(metrics);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dispatch/sync — sync from portal scheduled_services into dispatch_jobs
router.post('/sync', async (req, res) => {
  try {
    const { syncJobsFromSchedule, syncTechnicians } = require('../services/dispatch/schedule-bridge');
    const techResult = await syncTechnicians();
    const bridgeResult = await syncJobsFromSchedule(req.body?.date);
    res.json({ ok: true, synced: bridgeResult.synced, bridge: bridgeResult, techs: techResult });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
