const express = require('express');
const router = express.Router();
const Joi = require('joi');
const db = require('../models/db');
const TwilioService = require('../services/twilio');
const { authenticate } = require('../middleware/auth');
const logger = require('../services/logger');

router.use(authenticate);

// Safely parse a JSON column; tolerate already-parsed objects and bad data.
function safeJsonParse(val, fallback = null) {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch { return fallback; }
}

const STEP_NAMES = ['', 'Scheduled', 'Confirmed', 'En Route', 'On-Site', 'In Progress', 'Wrapping Up', 'Complete'];

const OFFICES = {
  lakewood_ranch: { name: 'Waves Pest Control Lakewood Ranch', phone: '(941) 318-7612', area: 'Lakewood Ranch / Bradenton' },
  sarasota: { name: 'Waves Pest Control Sarasota', phone: '(941) 318-7612', area: 'Sarasota / Siesta Key' },
  venice: { name: 'Waves Pest Control Venice', phone: '(941) 318-7612', area: 'Venice / North Port' },
  parrish: { name: 'Waves Pest Control Parrish', phone: '(941) 297-2817', area: 'Parrish / Palmetto / Ellenton' },
};

const CITY_TO_OFFICE = {
  'lakewood ranch': 'lakewood_ranch', 'bradenton': 'lakewood_ranch', 'university park': 'lakewood_ranch',
  'sarasota': 'sarasota', 'siesta key': 'sarasota', 'lido key': 'sarasota',
  'venice': 'venice', 'north port': 'venice', 'englewood': 'venice', 'port charlotte': 'venice',
  'parrish': 'parrish', 'palmetto': 'parrish', 'ellenton': 'parrish', 'terra ceia': 'parrish',
  'sun city center': 'parrish', 'ruskin': 'parrish', 'apollo beach': 'parrish',
};

function resolveOffice(customer) {
  const city = (customer?.city || '').toLowerCase().trim();
  const key = CITY_TO_OFFICE[city] || 'lakewood_ranch';
  return OFFICES[key];
}

function formatTracker(row, service, tech, customer) {
  const notes = safeJsonParse(row.live_notes, []);
  const summary = safeJsonParse(row.service_summary, null);

  return {
    id: row.id,
    currentStep: row.current_step,
    steps: Array.from({ length: 7 }, (_, i) => ({
      step: i + 1,
      name: STEP_NAMES[i + 1],
      completedAt: row[`step_${i + 1}_at`] || null,
    })),
    etaMinutes: row.eta_minutes,
    liveNotes: notes,
    serviceSummary: summary,
    service: {
      id: service?.id,
      date: service?.scheduled_date,
      type: service?.service_type,
      windowStart: service?.window_start,
      windowEnd: service?.window_end,
    },
    technician: {
      id: tech?.id,
      name: tech?.name,
      initials: tech?.name ? tech.name.split(' ').map(n => n[0]).join('') : '?',
    },
    office: resolveOffice(customer),
  };
}

// =========================================================================
// GET /api/tracking/active — active tracker for customer
// =========================================================================
router.get('/active', async (req, res, next) => {
  try {
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();

    const tracker = await db('service_tracking')
      .where({ 'service_tracking.customer_id': req.customerId })
      .where(function () {
        this.where('current_step', '<', 7)
          .orWhere('step_7_at', '>=', fourHoursAgo);
      })
      .orderBy('created_at', 'desc')
      .first();

    if (!tracker) return res.json({ tracker: null });

    const service = await db('scheduled_services').where({ id: tracker.scheduled_service_id }).first();
    const tech = tracker.technician_id ? await db('technicians').where({ id: tracker.technician_id }).first() : null;

    res.json({ tracker: formatTracker(tracker, service, tech, req.customer) });
  } catch (err) { next(err); }
});

// =========================================================================
// GET /api/tracking/today — auto-create tracker for today's service
// =========================================================================
router.get('/today', async (req, res, next) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    // Check for existing tracker
    let tracker = await db('service_tracking')
      .where({ 'service_tracking.customer_id': req.customerId })
      .where('current_step', '<=', 7)
      .orderBy('created_at', 'desc')
      .first();

    if (tracker) {
      const service = await db('scheduled_services').where({ id: tracker.scheduled_service_id }).first();
      const tech = tracker.technician_id ? await db('technicians').where({ id: tracker.technician_id }).first() : null;
      return res.json({ tracker: formatTracker(tracker, service, tech, req.customer) });
    }

    // Find today's scheduled service
    const scheduled = await db('scheduled_services')
      .where({ customer_id: req.customerId })
      .where('scheduled_date', today)
      .whereNotIn('status', ['cancelled', 'completed'])
      .first();

    if (!scheduled) return res.json({ tracker: null });

    // Auto-create tracker
    const [newTracker] = await db('service_tracking').insert({
      scheduled_service_id: scheduled.id,
      customer_id: req.customerId,
      technician_id: scheduled.technician_id,
      current_step: 1,
      step_1_at: db.fn.now(),
    }).returning('*');

    const tech = scheduled.technician_id ? await db('technicians').where({ id: scheduled.technician_id }).first() : null;

    res.json({ tracker: formatTracker(newTracker, scheduled, tech, req.customer) });
  } catch (err) { next(err); }
});

// =========================================================================
// PUT /api/tracking/:id/step — advance step
// =========================================================================
router.put('/:id/step', async (req, res, next) => {
  try {
    const stepSchema = Joi.object({
      step: Joi.number().integer().min(1).max(7).required(),
      note: Joi.string().trim().max(500).optional().allow(''),
      etaMinutes: Joi.number().integer().min(0).max(720).optional(),
    });
    const { value: vStep, error: stepErr } = stepSchema.validate(req.body, { stripUnknown: true });
    if (stepErr) return res.status(400).json({ error: stepErr.details[0].message });
    const { step, note, etaMinutes } = vStep;
    const trackerId = req.params.id;

    const tracker = await db('service_tracking')
      .where({ id: trackerId, customer_id: req.customerId })
      .first();

    if (!tracker) return res.status(404).json({ error: 'Tracker not found' });

    // Monotonic progression only: may stay on current step or advance by one.
    // Prevents rolling back a "Complete" tracker or skipping ahead silently.
    const currentStep = tracker.current_step || 1;
    if (step < currentStep || step > currentStep + 1) {
      return res.status(400).json({
        error: `Invalid step transition (current=${currentStep}, requested=${step})`,
      });
    }

    const updates = {
      current_step: step,
      [`step_${step}_at`]: db.fn.now(),
    };
    if (etaMinutes !== undefined) updates.eta_minutes = etaMinutes;

    // Append note if provided
    if (note) {
      const notes = safeJsonParse(tracker.live_notes, []);
      notes.push({ note, timestamp: new Date().toISOString() });
      updates.live_notes = JSON.stringify(notes);
    }

    await db('service_tracking').where({ id: trackerId }).update(updates);

    // Send SMS at key steps
    const customer = req.customer;
    const service = await db('scheduled_services').where({ id: tracker.scheduled_service_id }).first();
    const tech = tracker.technician_id ? await db('technicians').where({ id: tracker.technician_id }).first() : null;
    const techName = tech?.name || 'Your tech';
    const techFirst = techName.split(' ')[0];

    const formatWindow = () => {
      if (!service?.window_start) return 'today';
      const fmt = (t) => { const [h, m] = t.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; };
      return `${fmt(service.window_start)} – ${fmt(service.window_end)}`;
    };

    // Only send SMS when tech is en route — other steps update in the portal
    try {
      if (step === 3) {
        const etaText = etaMinutes ? `ETA: ~${etaMinutes} minutes.` : '';
        await TwilioService.sendSMS(customer.phone,
          `🌊 ${techName} is headed to your property! ${etaText} Please make sure gates are unlocked and pets are secured. Track live in your Waves portal. 🚐`);
      }
    } catch (smsErr) {
      logger.error(`Tracking SMS failed: ${smsErr.message}`);
    }

    // Fetch updated
    const updated = await db('service_tracking').where({ id: trackerId }).first();
    res.json({ tracker: formatTracker(updated, service, tech, req.customer) });
  } catch (err) { next(err); }
});

// =========================================================================
// POST /api/tracking/:id/note — tech pushes a live note
// =========================================================================
router.post('/:id/note', async (req, res, next) => {
  try {
    const noteSchema = Joi.object({
      note: Joi.string().trim().min(1).max(500).required(),
    });
    const { value: vNote, error: noteErr } = noteSchema.validate(req.body, { stripUnknown: true });
    if (noteErr) return res.status(400).json({ error: noteErr.details[0].message });
    const { note } = vNote;

    const tracker = await db('service_tracking')
      .where({ id: req.params.id, customer_id: req.customerId })
      .first();
    if (!tracker) return res.status(404).json({ error: 'Tracker not found' });

    const notes = safeJsonParse(tracker.live_notes, []);
    notes.push({ note, timestamp: new Date().toISOString() });

    await db('service_tracking')
      .where({ id: req.params.id })
      .update({ live_notes: JSON.stringify(notes) });

    res.json({ success: true, notes });
  } catch (err) { next(err); }
});

// =========================================================================
// PUT /api/tracking/:id/complete — full completion with summary
// =========================================================================
router.put('/:id/complete', async (req, res, next) => {
  try {
    const { summary } = req.body;

    await db('service_tracking')
      .where({ id: req.params.id, customer_id: req.customerId })
      .update({
        current_step: 7,
        step_7_at: db.fn.now(),
        service_summary: summary ? JSON.stringify(summary) : null,
      });

    res.json({ success: true });
  } catch (err) { next(err); }
});

// =========================================================================
// POST /api/tracking/demo/advance — demo: advance by one step
// =========================================================================
router.post('/demo/advance', async (req, res, next) => {
  try {
    if (process.env.NODE_ENV === 'production') {
      return res.status(404).json({ error: 'Not found' });
    }
    const tracker = await db('service_tracking')
      .where({ customer_id: req.customerId })
      .where('current_step', '<', 7)
      .orderBy('created_at', 'desc')
      .first();

    if (!tracker) return res.status(404).json({ error: 'No active tracker' });

    const nextStep = tracker.current_step + 1;
    const demoNotes = {
      3: 'Headed to your property now',
      4: 'Arrived — starting inspection',
      5: 'Treating exterior perimeter — Demand CS applied',
      6: 'Final walkthrough and cleanup',
      7: 'Service complete — all areas treated',
    };

    const updates = {
      current_step: nextStep,
      [`step_${nextStep}_at`]: db.fn.now(),
    };

    if (nextStep === 3) updates.eta_minutes = 12;
    if (nextStep >= 4) updates.eta_minutes = 0;

    if (demoNotes[nextStep]) {
      const notes = safeJsonParse(tracker.live_notes, []);
      notes.push({ note: demoNotes[nextStep], timestamp: new Date().toISOString() });
      updates.live_notes = JSON.stringify(notes);
    }

    if (nextStep === 7) {
      updates.service_summary = JSON.stringify({
        productsApplied: ['Demand CS', 'Advion WDG Granular', 'Alpine WSG'],
        areasTreated: ['Exterior perimeter', 'Garage entry', 'Lanai baseboards', 'All eaves (cobweb sweep)'],
        recommendations: 'Keep garage door sealed at bottom. Consider adding monthly mosquito barrier for rainy season.',
        nextVisitDate: '2026-05-06',
      });
    }

    await db('service_tracking').where({ id: tracker.id }).update(updates);

    const updated = await db('service_tracking').where({ id: tracker.id }).first();
    const service = await db('scheduled_services').where({ id: tracker.scheduled_service_id }).first();
    const tech = tracker.technician_id ? await db('technicians').where({ id: tracker.technician_id }).first() : null;

    res.json({ tracker: formatTracker(updated, service, tech, req.customer) });
  } catch (err) { next(err); }
});

module.exports = router;
