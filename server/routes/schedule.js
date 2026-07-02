const express = require('express');
const router = express.Router();
const Joi = require('joi');
const db = require('../models/db');
const { authenticate } = require('../middleware/auth');
const logger = require('../services/logger');
const { normalizeServiceType } = require('../utils/service-normalizer');
const { etDateString } = require('../utils/datetime-et');

router.use(authenticate);

const listQuerySchema = Joi.object({
  days: Joi.number().integer().min(1).max(365).default(90),
});

// =========================================================================
// GET /api/schedule — Upcoming scheduled services
// =========================================================================
router.get('/', async (req, res, next) => {
  try {
    const { value, error } = listQuerySchema.validate(req.query, { stripUnknown: true });
    if (error) return res.status(400).json({ error: error.details[0].message });
    const { days } = value;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + days);

    const upcoming = await db('scheduled_services')
      .where({ 'scheduled_services.customer_id': req.customerId })
      .whereIn('scheduled_services.status', ['pending', 'confirmed', 'rescheduled'])
      // A call-created follow-up (visit 2) is dispatch-owned until the office
      // confirms the exact time — hide the still-pending, never-confirmed row
      // so the portal can't surface (and confirm) the default interval before
      // dispatch reviews it. De Morgan with NULL-safe legs: most rows have no
      // source_action, and `NOT (NULL = x)` would filter them out.
      .where((qb) => qb
        .whereNull('scheduled_services.source_action')
        .orWhereNot('scheduled_services.source_action', 'ai_call_pipeline_followup')
        .orWhereNot('scheduled_services.status', 'pending')
        .orWhere('scheduled_services.customer_confirmed', true))
      .where('scheduled_services.scheduled_date', '>=', etDateString())
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
        serviceType: normalizeServiceType(s.service_type),
        status: s.status,
        technician: s.technician_name,
        customerConfirmed: s.customer_confirmed,
        confirmedAt: s.confirmed_at,
        notes: s.notes,
        // Plan-coverage signals so the portal can distinguish recurring WaveGuard
        // visits from one-time visits and free re-service callbacks.
        isRecurring: s.is_recurring === true,
        isCallback: s.is_callback === true,
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

    // A call-created follow-up (visit 2) is dispatch-owned until the office
    // confirms the exact time — the row is hidden from the customer list
    // above; refuse a direct confirm too (same 404 shape, no info leak).
    if (service.source_action === 'ai_call_pipeline_followup'
      && service.status === 'pending'
      && !service.customer_confirmed) {
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
    // Floor "now" to start of current UTC day so a customer submitting today's
    // date from an earlier-UTC timezone isn't incorrectly rejected as "past",
    // but yesterday's date still fails validation.
    const todayStartUtc = new Date();
    todayStartUtc.setUTCHours(0, 0, 0, 0);

    const schema = Joi.object({
      preferredDate: Joi.date().iso().min(todayStartUtc).optional(),
      notes: Joi.string().trim().max(500).optional(),
    });

    const { preferredDate, notes } = await schema.validateAsync(req.body);

    const service = await db('scheduled_services')
      .where({ id: req.params.id, customer_id: req.customerId })
      .whereIn('status', ['pending', 'confirmed'])
      .first();

    if (!service) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    // Same dispatch-owned guard as list/confirm: a call-created follow-up
    // dispatch hasn't confirmed yet is hidden from the customer, so a
    // direct reschedule against its id must refuse too (same 404 shape,
    // no info leak).
    if (service.source_action === 'ai_call_pipeline_followup'
      && service.status === 'pending'
      && !service.customer_confirmed) {
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
      // Same dispatch-owned guard as the list above: a still-pending,
      // never-confirmed call-created follow-up can't surface as the
      // customer's next appointment (NULL-safe De Morgan legs).
      .where((qb) => qb
        .whereNull('scheduled_services.source_action')
        .orWhereNot('scheduled_services.source_action', 'ai_call_pipeline_followup')
        .orWhereNot('scheduled_services.status', 'pending')
        .orWhere('scheduled_services.customer_confirmed', true))
      .where('scheduled_services.scheduled_date', '>=', etDateString())
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
        serviceType: normalizeServiceType(nextService.service_type),
        status: nextService.status,
        technician: nextService.technician_name,
        customerConfirmed: nextService.customer_confirmed,
        // Plan-coverage signals so the portal can distinguish a recurring WaveGuard
        // visit from a one-time visit or a free re-service callback.
        isRecurring: nextService.is_recurring === true,
        isCallback: nextService.is_callback === true,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
