const express = require('express');
const router = express.Router();
const Joi = require('joi');
const db = require('../models/db');
const { authenticate } = require('../middleware/auth');
const logger = require('../services/logger');

router.use(authenticate);

// =========================================================================
// GET /api/schedule — Upcoming scheduled services
// =========================================================================
router.get('/', async (req, res, next) => {
  try {
    const { days = 90 } = req.query;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + parseInt(days));

    const upcoming = await db('scheduled_services')
      .where({ 'scheduled_services.customer_id': req.customerId })
      .whereIn('scheduled_services.status', ['pending', 'confirmed', 'rescheduled'])
      .where('scheduled_services.scheduled_date', '>=', new Date().toISOString().split('T')[0])
      .where('scheduled_services.scheduled_date', '<=', cutoff.toISOString().split('T')[0])
      .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
      .select(
        'scheduled_services.*',
        'technicians.name as technician_name'
      )
      .orderBy('scheduled_services.scheduled_date', 'asc');

    res.json({
      upcoming: upcoming.map(s => ({
        id: s.id,
        date: s.scheduled_date,
        windowStart: s.window_start,
        windowEnd: s.window_end,
        serviceType: s.service_type,
        status: s.status,
        technician: s.technician_name,
        customerConfirmed: s.customer_confirmed,
        confirmedAt: s.confirmed_at,
        notes: s.notes,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /api/schedule/:id/confirm — Customer confirms appointment
// =========================================================================
router.post('/:id/confirm', async (req, res, next) => {
  try {
    const service = await db('scheduled_services')
      .where({ id: req.params.id, customer_id: req.customerId })
      .whereIn('status', ['pending', 'rescheduled'])
      .first();

    if (!service) {
      return res.status(404).json({ error: 'Appointment not found or already confirmed' });
    }

    await db('scheduled_services')
      .where({ id: req.params.id })
      .update({
        status: 'confirmed',
        customer_confirmed: true,
        confirmed_at: new Date(),
        updated_at: new Date(),
      });

    logger.info(`Appointment confirmed by customer: ${req.params.id}`);

    res.json({ success: true, message: 'Appointment confirmed' });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /api/schedule/:id/reschedule — Customer requests reschedule
// =========================================================================
router.post('/:id/reschedule', async (req, res, next) => {
  try {
    const schema = Joi.object({
      preferredDate: Joi.date().iso().min('now').optional(),
      notes: Joi.string().max(500).optional(),
    });

    const { preferredDate, notes } = await schema.validateAsync(req.body);

    const service = await db('scheduled_services')
      .where({ id: req.params.id, customer_id: req.customerId })
      .whereIn('status', ['pending', 'confirmed'])
      .first();

    if (!service) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    await db('scheduled_services')
      .where({ id: req.params.id })
      .update({
        status: 'rescheduled',
        customer_confirmed: false,
        notes: notes
          ? `${service.notes ? service.notes + ' | ' : ''}RESCHEDULE REQUEST: ${notes}${preferredDate ? ` (preferred: ${preferredDate})` : ''}`
          : service.notes,
        updated_at: new Date(),
      });

    logger.info(`Reschedule requested by customer: ${req.params.id}`);

    // TODO: Trigger internal notification to scheduling team

    res.json({
      success: true,
      message: 'Reschedule request submitted. Our team will contact you to confirm a new date.',
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /api/schedule/next — Get the next upcoming service
// =========================================================================
router.get('/next', async (req, res, next) => {
  try {
    const nextService = await db('scheduled_services')
      .where({ 'scheduled_services.customer_id': req.customerId })
      .whereIn('scheduled_services.status', ['pending', 'confirmed'])
      .where('scheduled_services.scheduled_date', '>=', new Date().toISOString().split('T')[0])
      .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
      .select('scheduled_services.*', 'technicians.name as technician_name')
      .orderBy('scheduled_services.scheduled_date', 'asc')
      .first();

    if (!nextService) {
      return res.json({ next: null });
    }

    res.json({
      next: {
        id: nextService.id,
        date: nextService.scheduled_date,
        windowStart: nextService.window_start,
        windowEnd: nextService.window_end,
        serviceType: nextService.service_type,
        status: nextService.status,
        technician: nextService.technician_name,
        customerConfirmed: nextService.customer_confirmed,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
