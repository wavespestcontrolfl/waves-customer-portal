/**
 * Public self-serve reschedule routes — /api/public/reschedule/:token.
 *
 * No auth. The scheduled_services.reschedule_token (64-char hex, minted by
 * migration 20260702000010) is the only gate, mirroring the /track/:token
 * model: rate limit mitigates brute force, 404 is reserved for bad/unknown
 * tokens, and every other edge case returns a well-shaped payload the
 * ReschedulePage renders.
 *
 * GET  /:token  — appointment summary + live open slots. Slots come from the
 *   same route-aware availability builder the public /book funnel uses
 *   (buildBookingAvailability), over the same booking_config advance-days
 *   window, with the appointment's own row excluded from the occupied-route
 *   set so it doesn't block the slot it is moving out of.
 *
 * POST /:token  — commit. The requested slot is re-validated against a fresh
 *   single-day availability run (a customer can only commit a slot the engine
 *   still offers — lunch/cap/route rules included), then committed through
 *   SmartRebooker.reschedule, which owns the advisory-lock + tech-route
 *   overlap conflict check, reschedule_log audit, and escalation flagging.
 *   Single occurrence ONLY — a recurring visit moves just this one date; the
 *   series cadence is never shifted from this surface (no rescheduleSeries,
 *   no allowLive: live/terminal visits 409).
 *
 * Post-commit (best-effort): AppointmentReminders.handleReschedule re-arms
 * the 72h/24h reminder row for the new time and sends the standard
 * appointment_rescheduled confirmation text; the dispatch board gets a live
 * job_update broadcast; the office gets the same internal alert text a
 * self-booked appointment fires.
 */

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../models/db');
const logger = require('../services/logger');
const SmartRebooker = require('../services/rebooker');
const { etDateString, addETDays, etParts } = require('../utils/datetime-et');

// Token format: 64-char lowercase hex (matches encode(gen_random_bytes(32), 'hex')).
const TOKEN_RE = /^[a-f0-9]{64}$/;

const RESCHEDULABLE_STATUSES = new Set(['pending', 'confirmed', 'rescheduled']);

router.use(rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in a minute.' },
}));

// Tighter limiter on the commit — actual writes.
const commitLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again in a minute.' },
});

function apptDateStr(scheduledDate) {
  if (!scheduledDate) return null;
  return scheduledDate instanceof Date
    ? scheduledDate.toISOString().slice(0, 10)
    : String(scheduledDate).slice(0, 10);
}

function hhmm(t) {
  return t ? String(t).slice(0, 5) : null;
}

// '14:00' → '2:00 PM' — for responses that echo a window the availability
// engine didn't label (e.g. the idempotent-replay short-circuit).
function label12(t) {
  const parts = hhmm(t);
  if (!parts) return null;
  const [h, m] = parts.split(':').map(Number);
  if (Number.isNaN(h)) return parts;
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 || 12;
  return `${hour12}:${String(m || 0).padStart(2, '0')} ${suffix}`;
}

// Customer-facing eligibility for the appointment behind the token.
// Returns { ok: true } or { ok: false, reason } with a customer-safe reason:
//   completed | cancelled | in_progress | past | not_available
function eligibility(svc, now = new Date()) {
  const status = String(svc.status || '').toLowerCase();
  if (status === 'completed') return { ok: false, reason: 'completed' };
  if (status === 'cancelled' || status === 'canceled') return { ok: false, reason: 'cancelled' };
  if (status === 'en_route' || status === 'on_site') return { ok: false, reason: 'in_progress' };
  if (!RESCHEDULABLE_STATUSES.has(status)) return { ok: false, reason: 'not_available' };

  const dateStr = apptDateStr(svc.scheduled_date);
  const todayEt = etDateString(now);
  if (dateStr && dateStr < todayEt) return { ok: false, reason: 'past' };
  if (dateStr === todayEt) {
    // Same-day appointment whose window already elapsed in ET is as done as
    // yesterday's — the rebooker would reject the move anyway.
    const cutoff = hhmm(svc.window_end) || hhmm(svc.window_start);
    if (cutoff) {
      const nowEt = etParts(now);
      const [ch, cm] = cutoff.split(':').map(Number);
      if (ch * 60 + (cm || 0) <= nowEt.hour * 60 + nowEt.minute) {
        return { ok: false, reason: 'past' };
      }
    }
  }
  return { ok: true };
}

async function loadByToken(token) {
  return db('scheduled_services as s')
    .leftJoin('customers as c', 's.customer_id', 'c.id')
    .where('s.reschedule_token', token)
    .first(
      's.id',
      's.customer_id',
      's.technician_id',
      's.scheduled_date',
      's.window_start',
      's.window_end',
      's.status',
      's.service_type',
      's.estimated_duration_minutes',
      's.is_recurring',
      's.recurring_parent_id',
      's.self_booking_id',
      'c.first_name as cust_first_name',
      'c.last_name as cust_last_name',
      'c.address_line1',
      'c.city',
      'c.state',
      'c.zip',
      'c.latitude',
      'c.longitude',
      'c.deleted_at as customer_deleted_at'
    );
}

// The reschedule window mirrors the public /book funnel's config-driven
// range: [today + advance_days_min, today + advance_days_max].
function bookingRange(config, now = new Date()) {
  return {
    rangeFrom: etDateString(addETDays(now, config.advance_days_min ?? 1)),
    rangeTo: etDateString(addETDays(now, config.advance_days_max ?? 14)),
  };
}

async function buildAvailabilityForService(svc, { rangeFrom, rangeTo, config }) {
  const booking = require('./booking');
  const { resolveBookingCoords, buildBookingAvailability } = booking._internals;

  let lat = svc.latitude != null ? parseFloat(svc.latitude) : null;
  let lng = svc.longitude != null ? parseFloat(svc.longitude) : null;
  if (!lat || !lng) {
    const address = [svc.address_line1, svc.city, svc.state, svc.zip].filter(Boolean).join(', ');
    const resolved = await resolveBookingCoords({ address: address || null, city: svc.city || null });
    lat = resolved.lat;
    lng = resolved.lng;
  }
  if (!lat || !lng) return null;

  const duration = svc.estimated_duration_minutes || config.slot_duration_minutes || 60;
  return buildBookingAvailability({
    lat,
    lng,
    duration,
    rangeFrom,
    rangeTo,
    config,
    today: new Date(),
    excludeServiceIds: [svc.id],
  });
}

router.get('/:token', async (req, res, next) => {
  if (!TOKEN_RE.test(req.params.token || '')) {
    return res.status(404).json({ error: 'Not found' });
  }

  try {
    const svc = await loadByToken(req.params.token);
    if (!svc || svc.customer_deleted_at) return res.status(404).json({ error: 'Not found' });

    const elig = eligibility(svc);
    const base = {
      state: elig.ok ? 'reschedulable' : 'not_reschedulable',
      reason: elig.ok ? null : elig.reason,
      customerFirstName: svc.cust_first_name || null,
      service: { type: svc.service_type || 'service' },
      // Single-occurrence contract: a recurring visit moves only this date.
      isRecurring: !!(svc.is_recurring || svc.recurring_parent_id),
      current: {
        date: apptDateStr(svc.scheduled_date),
        windowStart: hhmm(svc.window_start),
        windowEnd: hhmm(svc.window_end),
      },
    };

    if (!elig.ok) return res.json({ ...base, availability: null });

    const booking = require('./booking');
    const config = await booking._internals.loadBookingConfig();
    const range = bookingRange(config);

    let availability = null;
    try {
      availability = await buildAvailabilityForService(svc, { ...range, config });
    } catch (err) {
      logger.error(`[reschedule-public] availability failed for ${svc.id}: ${err.message}`);
    }

    return res.json({
      ...base,
      availability: availability
        ? {
          slots: availability.slots,
          days: availability.days,
          nearby: availability.nearby,
          rangeFrom: range.rangeFrom,
          rangeTo: range.rangeTo,
        }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:token', commitLimiter, async (req, res, next) => {
  if (!TOKEN_RE.test(req.params.token || '')) {
    return res.status(404).json({ error: 'Not found' });
  }

  const date = typeof req.body?.date === 'string' ? req.body.date.trim() : '';
  const startTime = typeof req.body?.start_time === 'string' ? req.body.start_time.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(startTime)) {
    return res.status(400).json({ error: 'date (YYYY-MM-DD) and start_time (HH:MM) required' });
  }

  try {
    const svc = await loadByToken(req.params.token);
    if (!svc || svc.customer_deleted_at) return res.status(404).json({ error: 'Not found' });

    const elig = eligibility(svc);
    if (!elig.ok) {
      return res.status(409).json({ error: 'This appointment can no longer be rescheduled online.', reason: elig.reason });
    }

    // Idempotent replay: a retried POST (network retry, double-tap) whose
    // target matches the visit's current date + start already succeeded —
    // committing again would duplicate the reschedule_log row, re-send the
    // reschedule notice, and count toward the escalation threshold.
    if (apptDateStr(svc.scheduled_date) === date && hhmm(svc.window_start) === startTime) {
      return res.json({
        success: true,
        replayed: true,
        originalDate: svc.scheduled_date,
        newDate: date,
        window: { start: startTime, end: hhmm(svc.window_end) },
        startLabel: label12(startTime),
        endLabel: label12(svc.window_end),
      });
    }

    const booking = require('./booking');
    const config = await booking._internals.loadBookingConfig();
    const range = bookingRange(config);
    if (date < range.rangeFrom || date > range.rangeTo) {
      return res.status(400).json({ error: 'That date is outside the online scheduling window.' });
    }

    // Anti-forgery: the customer can only commit a slot the availability
    // engine still offers for that day (route feasibility, lunch reserve,
    // self-book day caps, whole-hour grid). The rebooker's transactional
    // conflict check below still owns the race.
    const dayAvailability = await buildAvailabilityForService(svc, {
      rangeFrom: date,
      rangeTo: date,
      config,
    });
    const day = dayAvailability?.days?.find((d) => d.date === date);
    const slot = day?.slots?.find((s) => s.start_time === startTime);
    if (!slot) {
      let refreshed = null;
      try {
        refreshed = await buildAvailabilityForService(svc, { ...range, config });
      } catch (err) {
        logger.warn(`[reschedule-public] refresh availability failed for ${svc.id}: ${err.message}`);
      }
      return res.status(409).json({
        error: 'That time is no longer open. Here are the latest available times.',
        code: 'SLOT_TAKEN',
        availability: refreshed
          ? { slots: refreshed.slots, days: refreshed.days, nearby: refreshed.nearby, rangeFrom: range.rangeFrom, rangeTo: range.rangeTo }
          : null,
      });
    }

    const newWindow = { start: slot.start_time, end: slot.end_time };
    let result;
    try {
      result = await SmartRebooker.reschedule(
        svc.id,
        date,
        newWindow,
        'customer_request',
        'customer_self_serve',
        { technicianId: slot.technician_id }
      );
    } catch (err) {
      if (err?.statusCode) {
        return res.status(err.statusCode).json({ error: err.message, code: err.code || null });
      }
      throw err;
    }

    // Self-booked visits carry a linked self_booked_appointments row that the
    // public availability builder counts for max_self_books_per_day
    // (booking.js fullDays) — move it with the visit or the old day stays
    // artificially full while the new day goes uncounted. Best-effort right
    // after the rebooker commit; a failure only skews the day-cap counting.
    if (svc.self_booking_id) {
      try {
        await db('self_booked_appointments')
          .where({ id: svc.self_booking_id })
          .update({
            date,
            start_time: slot.start_time,
            end_time: slot.end_time,
            technician_id: slot.technician_id || null,
            updated_at: db.fn.now(),
          });
      } catch (err) {
        logger.error(`[reschedule-public] self-booking row sync failed for ${svc.id}: ${err.message}`);
      }
    }

    // Post-commit, best-effort: reminder re-arm + the standard
    // appointment_rescheduled confirmation text (handleReschedule owns both).
    try {
      const AppointmentReminders = require('../services/appointment-reminders');
      await AppointmentReminders.handleReschedule(svc.id, `${date}T${slot.start_time}`);
    } catch (err) {
      logger.error(`[reschedule-public] reminder sync failed for ${svc.id}: ${err.message}`);
    }

    // Live dispatch-board refresh, same broadcast the admin reschedule emits.
    try {
      const { emitDispatchJobUpdate } = require('../services/dispatch-assignment');
      await emitDispatchJobUpdate({ jobId: svc.id, actorId: null });
    } catch (err) {
      logger.error(`[reschedule-public] board broadcast failed for ${svc.id}: ${err.message}`);
    }

    // Office alert — same internal ping a new self-booked appointment fires.
    try {
      if (process.env.ADAM_PHONE) {
        const TwilioService = require('../services/twilio');
        const name = [svc.cust_first_name, svc.cust_last_name].filter(Boolean).join(' ') || 'Customer';
        const displayDate = new Date(`${date}T12:00:00`).toLocaleDateString('en-US', {
          weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York',
        });
        await TwilioService.sendSMS(
          process.env.ADAM_PHONE,
          `🔁 Customer self-rescheduled:\n${name}\n${svc.service_type || 'service'}\n${apptDateStr(svc.scheduled_date)} → ${displayDate} ${slot.start_label}-${slot.end_label}\n${svc.city || ''}`,
          { messageType: 'internal_alert' }
        );
      }
    } catch (err) {
      logger.warn(`[reschedule-public] office alert failed for ${svc.id}: ${err.message}`);
    }

    return res.json({
      success: true,
      originalDate: result.originalDate,
      newDate: date,
      window: newWindow,
      startLabel: slot.start_label,
      endLabel: slot.end_label,
    });
  } catch (err) {
    next(err);
  }
});

router._test = {
  eligibility,
  bookingRange,
  apptDateStr,
  label12,
};

module.exports = router;
