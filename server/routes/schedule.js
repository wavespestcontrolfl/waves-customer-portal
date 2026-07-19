const express = require('express');
const router = express.Router();
const Joi = require('joi');
const db = require('../models/db');
const { authenticate } = require('../middleware/auth');
const logger = require('../services/logger');
const NotificationService = require('../services/notification-service');
const { normalizeServiceType } = require('../utils/service-normalizer');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { DISPATCH_OWNED_PENDING_SOURCE_ACTIONS } = require('../services/call-booking-source-actions');
const { hasCancellableWork } = require('../services/cancellation-eligibility');

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
    // ET calendar day, matching the etDateString() lower bound below — a UTC
    // cutoff rolls the window an ET-evening early (scheduled_date is a DATE).
    const cutoffDate = etDateString(addETDays(new Date(), days));

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
        .orWhereNotIn('scheduled_services.source_action', DISPATCH_OWNED_PENDING_SOURCE_ACTIONS)
        .orWhereNot('scheduled_services.status', 'pending')
        .orWhere('scheduled_services.customer_confirmed', true))
      .where('scheduled_services.scheduled_date', '>=', etDateString())
      .where('scheduled_services.scheduled_date', '<=', cutoffDate)
      .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
      .select(
        'scheduled_services.*',
        'technicians.name as technician_name'
      )
      .orderBy('scheduled_services.scheduled_date', 'asc');

    // The SAME cancellation-eligibility verdict POST /api/requests enforces,
    // so the Plan tab's Account Options gate renders from the server's
    // answer instead of approximating it from the visit list above — which
    // deliberately omits rows the guard still counts (date-exempt
    // 'rescheduled' rebook intents, dispatch-owned pending follow-ups) and
    // says nothing about billing.
    const cancellable = await hasCancellableWork(req.customerId);

    res.json({
      hasCancellableWork: cancellable,
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
        // Self-serve deep link (same page the reminder texts link) — the
        // portal's Reschedule buttons open this instead of drafting an SMS
        // to the office. Same-customer row, so exposing the token here adds
        // no reach beyond what the customer's own texts already carry.
        // Null for legacy pre-backfill rows → the button falls back to SMS.
        rescheduleUrl: s.reschedule_token ? `/reschedule/${s.reschedule_token}` : null,
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
    if (DISPATCH_OWNED_PENDING_SOURCE_ACTIONS.includes(service.source_action)
      && service.status === 'pending'
      && !service.customer_confirmed) {
      return res.status(404).json({ error: 'Appointment not found or already confirmed' });
    }

    // The staff board can move this visit after the read above. Gate the write
    // on the customer and status we actually observed so a stale portal click
    // cannot revive a cancelled/completed visit (or overwrite an in-progress
    // transition).
    const updatedCount = await db('scheduled_services')
      .where({
        id: req.params.id,
        customer_id: req.customerId,
        status: service.status,
      })
      .update({
        status: 'confirmed',
        customer_confirmed: true,
        confirmed_at: new Date(),
        updated_at: new Date(),
      });

    if (!updatedCount) {
      return res.status(409).json({
        error: 'This appointment changed before it could be confirmed. Refresh to see the latest status.',
      });
    }

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
    // Floor "now" to the start of the current EASTERN day. A date-only ISO
    // preferredDate parses as UTC midnight, so a UTC floor rejected "today"
    // from 7/8 p.m. ET onward (UTC had already rolled to tomorrow); the ET
    // floor accepts today all evening while yesterday still fails.
    const todayStartEt = new Date(`${etDateString()}T00:00:00Z`);

    const schema = Joi.object({
      preferredDate: Joi.date().iso().min(todayStartEt).optional(),
      notes: Joi.string().trim().max(500).optional(),
    });

    const { preferredDate, notes } = await schema.validateAsync(req.body);

    // Lock the row before deriving the appended notes and changing status.
    // This preserves DB timestamp precision and makes an earlier staff edit
    // finish before we read it. A separate durable service_requests row below
    // ensures a later queued staff write cannot erase the customer's request.
    const outcome = await db.transaction(async (trx) => {
      const service = await trx('scheduled_services')
        .where({ id: req.params.id, customer_id: req.customerId })
        .whereIn('status', ['pending', 'confirmed'])
        .forUpdate()
        .first();

      if (!service) {
        return { statusCode: 404, error: 'Appointment not found' };
      }

      // Same dispatch-owned guard as list/confirm: a call-created follow-up
      // dispatch hasn't confirmed yet is hidden from the customer, so a
      // direct reschedule against its id must refuse too (same 404 shape,
      // no info leak).
      if (DISPATCH_OWNED_PENDING_SOURCE_ACTIONS.includes(service.source_action)
        && service.status === 'pending'
        && !service.customer_confirmed) {
        return { statusCode: 404, error: 'Appointment not found' };
      }

      const updatedCount = await trx('scheduled_services')
        .where({
          id: req.params.id,
          customer_id: req.customerId,
          status: service.status,
        })
        .update({
          status: 'rescheduled',
          customer_confirmed: false,
          notes: notes
            ? `${service.notes ? service.notes + ' | ' : ''}RESCHEDULE REQUEST: ${notes}${preferredDate ? ` (preferred: ${preferredDate})` : ''}`
            : service.notes,
          updated_at: new Date(),
        });

      if (!updatedCount) {
        return {
          statusCode: 409,
          error: 'This appointment changed before the request was submitted. Refresh to see the latest status.',
        };
      }

      // Keep the customer intent in the staff request queue as the durable,
      // append-only receipt. Appointment editors have independent write paths,
      // so status/notes alone cannot be the sole record of this request.
      await trx('service_requests').insert({
        customer_id: req.customerId,
        category: 'schedule_change',
        subject: `Reschedule request: ${normalizeServiceType(service.service_type)}`,
        description: [
          `Appointment ${service.id}: ${normalizeServiceType(service.service_type)} on ${service.scheduled_date}`,
          preferredDate ? `Preferred date: ${preferredDate}` : null,
          notes ? `Customer notes: ${notes}` : null,
        ].filter(Boolean).join('\n'),
        urgency: 'routine',
        photos: JSON.stringify([]),
        status: 'new',
        source: 'customer_portal_reschedule',
      });

      return { service };
    });

    if (outcome.error) {
      return res.status(outcome.statusCode).json({ error: outcome.error });
    }
    const { service } = outcome;

    logger.info(`Reschedule requested by customer: ${req.params.id}`);

    // The durable status/notes update is authoritative. Surface it in the
    // operator notification feed as a best-effort alert so the promised
    // follow-up is not dependent on someone noticing the status change.
    try {
      const customerName = [req.customer?.first_name, req.customer?.last_name].filter(Boolean).join(' ') || 'Customer';
      const notification = await NotificationService.notifyAdmin(
        'schedule',
        `Reschedule request from ${customerName}`,
        `${normalizeServiceType(service.service_type)} on ${service.scheduled_date}` +
          (preferredDate ? `\nPreferred date: ${preferredDate}` : '') +
          (notes ? `\nNotes: ${notes}` : ''),
        {
          icon: '📅',
          link: `/admin/schedule?serviceId=${encodeURIComponent(service.id)}`,
          metadata: {
            scheduledServiceId: service.id,
            customerId: req.customerId,
            preferredDate: preferredDate || null,
          },
        },
      );
      if (!notification) {
        logger.error(`Admin notification did not persist for reschedule request ${service.id}`);
      }
    } catch (notificationErr) {
      logger.error(`Failed to notify staff about reschedule request ${service.id}: ${notificationErr.message}`);
    }

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
        .orWhereNotIn('scheduled_services.source_action', DISPATCH_OWNED_PENDING_SOURCE_ACTIONS)
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
        // Self-serve deep link — see the list route's note above.
        rescheduleUrl: nextService.reschedule_token ? `/reschedule/${nextService.reschedule_token}` : null,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
