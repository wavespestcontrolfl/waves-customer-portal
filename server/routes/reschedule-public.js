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
 * POST /:token/find-slots — Waves AI date/time search. Same natural-language
 *   parser the public /book funnel and the estimate page use (parseWhen),
 *   but clamped to the reschedule window [advance_days_min, advance_days_max]
 *   — the AI must never surface a date the page's own slot list wouldn't
 *   offer, so there is no 90-day specific-date reach here.
 *
 * POST /:token  — commit. The requested slot is re-validated against a fresh
 *   single-day availability run (a customer can only commit a slot the engine
 *   still offers — lunch/cap/route rules included), then committed through
 *   SmartRebooker.reschedule, which owns the advisory-lock + tech-route
 *   overlap conflict check, reschedule_log audit, and escalation flagging.
 *   A recurring visit moves just this one date — EXCEPT a big pull-forward
 *   (≥ REANCHOR_PULLFORWARD_DAYS earlier than the current date), which
 *   commits through SmartRebooker.rescheduleSeries so every later occurrence
 *   re-anchors to the new date (owner ruling 2026-07-13). Never allowLive:
 *   live/terminal visits 409. A pending visit whose time already passed is a
 *   MISSED visit and may be rebooked (eligibility returns missed:true).
 *
 * Post-commit (best-effort): AppointmentReminders.handleReschedule re-arms
 * the 72h/24h reminder row for the new time and sends the standard
 * appointment_rescheduled confirmation text (series re-anchors instead
 * re-arm every shifted occurrence silently and send ONE
 * appointment_series_rescheduled text); the dispatch board gets a live
 * job_update broadcast per moved row; the office gets the same internal
 * alert text a self-booked appointment fires. Shifted siblings whose kept
 * tech would double-book were committed UNASSIGNED inside the rebooker trx
 * and are parked as a schedule_conflict admin notification here.
 */

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../models/db');
const logger = require('../services/logger');
const SmartRebooker = require('../services/rebooker');
const { etDateString, addETDays, etParts } = require('../utils/datetime-et');
const { stampedDivergesSql } = require('../services/stamped-address');

// Token format: 64-char lowercase hex (matches encode(gen_random_bytes(32), 'hex')).
const TOKEN_RE = /^[a-f0-9]{64}$/;

const RESCHEDULABLE_STATUSES = new Set(['pending', 'confirmed', 'rescheduled']);

// Owner ruling 2026-07-13: a BIG pull-forward on a recurring visit re-anchors
// the whole series (SmartRebooker.rescheduleSeries) so the plan's cadence
// follows the new date instead of leaving a long protection gap. "Big" =
// the new date is at least this many days EARLIER than the visit's current
// date. Push-backs and small nudges never re-anchor — only this visit moves,
// exactly as the page has always promised.
const REANCHOR_PULLFORWARD_DAYS = Math.max(
  1,
  Number(process.env.RESCHEDULE_REANCHOR_PULLFORWARD_DAYS) || 14
);

// Customer-quoted arrival window: 2 hours from window_start (owner rule —
// the same promise the page, reminders, and the late detector all quote).
const ARRIVAL_PROMISE_MINUTES = 120;

// Days the target date sits EARLIER than the visit's current date (negative
// for push-backs). Both args are YYYY-MM-DD strings; UTC-noon parse avoids
// DST edges.
function pullForwardDays(currentDateStr, targetDateStr) {
  const cur = new Date(`${String(currentDateStr).split('T')[0]}T12:00:00Z`).getTime();
  const tgt = new Date(`${String(targetDateStr).split('T')[0]}T12:00:00Z`).getTime();
  if (!Number.isFinite(cur) || !Number.isFinite(tgt)) return 0;
  return Math.round((cur - tgt) / 86400000);
}

// True cadence membership ONLY. Booster-month extras share
// recurring_parent_id but carry is_recurring=false (admin-schedule booster
// creation — "the auto-extend path leaves them alone"), and moving a booster
// must never shift the underlying base plan. Genuine child occurrences carry
// is_recurring=true themselves, so the flag alone is the right gate.
function isSeriesVisit(svc) {
  return !!svc?.is_recurring;
}

// True when committing `targetDateStr` for this visit re-anchors the series.
function shouldReanchor(svc, targetDateStr) {
  if (!isSeriesVisit(svc)) return false;
  return pullForwardDays(apptDateStr(svc.scheduled_date), targetDateStr) >= REANCHOR_PULLFORWARD_DAYS;
}

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

// AI search spends a model call per request — same budget as the estimate
// page's find-slots limiter.
const findSlotsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many searches. Please try again in a minute.' },
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

  // A pending/confirmed visit whose time already passed was MISSED, not
  // served — the customer may rebook it from the same link (owner ruling
  // 2026-07-13: "we missed each other — pick a new time"). Terminal and
  // live states were already rejected above; the rebooker only validates
  // the TARGET date, so a future target on a past visit commits cleanly.
  const dateStr = apptDateStr(svc.scheduled_date);
  const todayEt = etDateString(now);
  if (dateStr && dateStr < todayEt) return { ok: true, missed: true };
  if (dateStr === todayEt) {
    // Same-day: the visit is only MISSED once BOTH the internal job block
    // (window_end) AND the customer-quoted arrival promise (window_start +
    // 2h — owner rule, same constant the page displays) have elapsed.
    // window_end alone is often just the job-duration block: a 9:00 visit
    // with window_end 10:00 is still legitimately "on the way" at 10:05
    // inside the quoted 9–11 arrival window, and must not read as missed.
    const toMin = (t) => {
      const [h, m] = String(t).split(':').map(Number);
      return h * 60 + (m || 0);
    };
    const candidates = [];
    const start = hhmm(svc.window_start);
    const end = hhmm(svc.window_end);
    if (end) candidates.push(toMin(end));
    if (start) candidates.push(toMin(start) + ARRIVAL_PROMISE_MINUTES);
    if (candidates.length) {
      const nowEt = etParts(now);
      if (Math.max(...candidates) <= nowEt.hour * 60 + nowEt.minute) {
        return { ok: true, missed: true };
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
      // Availability must be computed around the BOOKED property, not the
      // customer's primary mirror (codex round-7 P1): stamped fields win
      // under the same output names, and coords follow the divergence rule —
      // a divergent stamp with no visit coords leaves lat/lng null so
      // buildAvailabilityForService geocodes the (stamped) address text.
      db.raw('COALESCE(s.service_address_line1, c.address_line1) as address_line1'),
      db.raw('COALESCE(s.service_address_city, c.city) as city'),
      db.raw('COALESCE(s.service_address_state, c.state) as state'),
      db.raw('COALESCE(s.service_address_zip, c.zip) as zip'),
      db.raw(`COALESCE(s.lat, CASE WHEN NOT ${stampedDivergesSql('s', 'c')} THEN c.latitude END) as latitude`),
      db.raw(`COALESCE(s.lng, CASE WHEN NOT ${stampedDivergesSql('s', 'c')} THEN c.longitude END) as longitude`),
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

// parseWhen options for the AI search: clamped to the reschedule window on
// BOTH ends — unlike /book's find-slots (which opens the horizon to
// MAX_BOOKING_HORIZON_DAYS for a named date), the search here never surfaces
// a date the page's own slot list wouldn't offer, because POST /:token
// rejects anything outside bookingRange().
function searchParseOpts(config, now = new Date()) {
  return {
    now,
    minDaysOut: config.advance_days_min ?? 1,
    maxDaysOut: config.advance_days_max ?? 14,
    defaultWindowDays: config.advance_days_max ?? 14,
  };
}

async function buildAvailabilityForService(svc, { rangeFrom, rangeTo, config, timeOfDay }) {
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
    ...(timeOfDay ? { timeOfDay } : {}),
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
      // isRecurring drives the "only this visit moves" note and includes
      // boosters (they belong to a plan even though they never re-anchor it).
      // reanchorPullForwardDays is the re-anchor threshold and is series-only:
      // pulls ≥ this many days forward shift the whole series (owner ruling
      // 2026-07-13). The client uses it to warn before Confirm; the POST
      // enforces the same rule regardless.
      isRecurring: !!(svc.is_recurring || svc.recurring_parent_id),
      reanchorPullForwardDays: isSeriesVisit(svc) ? REANCHOR_PULLFORWARD_DAYS : null,
      // The visit's time already passed without service — the page renders
      // the "we missed each other" rebook framing instead of the standard
      // reschedule copy.
      missed: !!elig.missed,
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

// Waves AI date/time search — parses the customer's natural-language "when"
// and returns matching open slots in the same shape GET's `availability`
// uses, so the page can splice the results straight into its day list.
router.post('/:token/find-slots', findSlotsLimiter, async (req, res, next) => {
  if (!TOKEN_RE.test(req.params.token || '')) {
    return res.status(404).json({ error: 'Not found' });
  }

  const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
  if (!query) return res.status(400).json({ error: 'query required' });
  if (query.length > 500) return res.status(400).json({ error: 'query too long' });

  try {
    const svc = await loadByToken(req.params.token);
    if (!svc || svc.customer_deleted_at) return res.status(404).json({ error: 'Not found' });

    const elig = eligibility(svc);
    if (!elig.ok) {
      return res.status(409).json({ error: 'This appointment can no longer be rescheduled online.', reason: elig.reason });
    }

    const booking = require('./booking');
    const config = await booking._internals.loadBookingConfig();
    const range = bookingRange(config);

    const { parseWhen, summarizeWindow } = require('../services/scheduling/parse-when');
    const when = await parseWhen(query, searchParseOpts(config));

    let availability = null;
    try {
      // No expandOpenDays here (unlike /book's find-slots): the search must be
      // a pure filter over what this page's GET list and the POST commit
      // revalidation offer — synthetic open-day windows would 409 SLOT_TAKEN
      // at commit because the single-day revalidation doesn't expand either.
      availability = await buildAvailabilityForService(svc, {
        rangeFrom: when.dateFrom,
        rangeTo: when.dateTo,
        config,
        timeOfDay: when.timeOfDay,
      });
    } catch (err) {
      logger.error(`[reschedule-public] find-slots availability failed for ${svc.id}: ${err.message}`);
    }
    if (!availability) {
      return res.status(503).json({ error: 'Slot search is unavailable right now. Please pick from the times below.' });
    }

    const slotCount = (availability.days || []).reduce((n, d) => n + (Array.isArray(d.slots) ? d.slots.length : 0), 0);
    return res.json({
      summary: summarizeWindow(when, { count: slotCount, nearby: availability.nearby }),
      understood: when.understood,
      window: { date_from: when.dateFrom, date_to: when.dateTo },
      time_of_day: when.timeOfDay,
      availability: {
        slots: availability.slots,
        days: availability.days,
        nearby: availability.nearby,
        rangeFrom: range.rangeFrom,
        rangeTo: range.rangeTo,
      },
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
      // If the commit this retry replays was a series re-anchor, the success
      // card must still say the following visits moved — recover the flag
      // from the reschedule_log row the original commit wrote (series
      // commits log reason_code '<reason>_series').
      let replaySeriesShifted = false;
      if (isSeriesVisit(svc)) {
        try {
          const lastLog = await db('reschedule_log')
            .where({ scheduled_service_id: svc.id })
            .orderBy('created_at', 'desc')
            .first('reason_code', 'new_date');
          replaySeriesShifted = !!lastLog
            && String(lastLog.reason_code || '').endsWith('_series')
            && String(lastLog.new_date).split('T')[0] === date;
        } catch (err) {
          logger.warn(`[reschedule-public] replay series-log lookup failed for ${svc.id}: ${err.message}`);
        }
      }
      return res.json({
        success: true,
        replayed: true,
        originalDate: svc.scheduled_date,
        newDate: date,
        window: { start: startTime, end: hhmm(svc.window_end) },
        startLabel: label12(startTime),
        endLabel: label12(svc.window_end),
        seriesShifted: replaySeriesShifted,
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
    // Big pull-forward on a recurring visit re-anchors the whole series
    // (owner ruling 2026-07-13): the customer getting service ~a month early
    // should have every later visit follow, not sit a double interval out.
    // Strict statuses only (no allowLive) — eligibility already gated those.
    const reanchor = shouldReanchor(svc, date);
    let result;
    try {
      result = reanchor
        ? await SmartRebooker.rescheduleSeries(
          svc.id,
          date,
          newWindow,
          'customer_request',
          'customer_self_serve',
          // Anchor keeps the tech whose route offered the slot (the
          // rebooker applies it with the same lock + overlap guard the
          // single path uses); siblings keep their existing techs.
          { technicianId: slot.technician_id }
        )
        : await SmartRebooker.reschedule(
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
    const shiftedOccurrences = reanchor && Array.isArray(result.rescheduledOccurrences)
      ? result.rescheduledOccurrences
      : null;

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

    // Post-commit, best-effort reminder + notification sync.
    //
    // Single visit: handleReschedule re-arms reminders AND sends the standard
    // appointment_rescheduled confirmation text.
    //
    // Series re-anchor: mirror the admin dispatch series path — re-arm every
    // shifted occurrence WITHOUT per-occurrence texts (sendNotification:false,
    // coverDueWindows so the 15-min cron can't double-remind in the gap), then
    // send ONE appointment_series_rescheduled confirmation and mark the
    // reschedule notice sent for every shifted row.
    const AppointmentReminders = require('../services/appointment-reminders');
    if (shiftedOccurrences) {
      for (const occ of shiftedOccurrences) {
        try {
          // coverDueWindows:true — same duplicate-reminder race guard the
          // admin series path uses: an already-due 24h window must not let
          // the 15-min cron text a standard reminder in the gap before our
          // series SMS lands. The no-send hole this opens (no phone,
          // template missing, send blocked) is closed below: every no-send
          // path explicitly RE-ARMS the covered windows so the cron still
          // reminds — the customer never ends up with silence.
          await AppointmentReminders.handleReschedule(
            occ.id,
            `${String(occ.date).split('T')[0]}T${hhmm(occ.windowStart) || slot.start_time}`,
            { sendNotification: false, coverDueWindows: true }
          );
        } catch (err) {
          logger.error(`[reschedule-public] series reminder sync failed for ${occ.id}: ${err.message}`);
        }
      }
      let seriesNoticeSent = false;
      try {
        const smsTemplatesRouter = require('./admin-sms-templates');
        const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
        const { arrivalWindowRange, formatSmsTimeRange } = require('../utils/sms-time-format');
        const customer = await db('customers').where({ id: svc.customer_id }).first('phone');
        if (customer?.phone && typeof smsTemplatesRouter.getTemplate === 'function') {
          const displayDate = new Date(`${date}T12:00:00`).toLocaleDateString('en-US', {
            weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/New_York',
          });
          const arrivalRange = arrivalWindowRange(slot.start_time);
          const body = await smsTemplatesRouter.getTemplate('appointment_series_rescheduled', {
            first_name: svc.cust_first_name || 'there',
            start_date: displayDate,
            window_text: arrivalRange ? `, ${formatSmsTimeRange(arrivalRange)}` : '',
          }, {
            workflow: 'customer_self_serve_series_reschedule',
            entity_type: 'scheduled_service',
            entity_id: svc.id,
          });
          if (body) {
            const msg = await sendCustomerMessage({
              to: customer.phone,
              body,
              channel: 'sms',
              audience: 'customer',
              purpose: 'appointment',
              customerId: svc.customer_id,
              identityTrustLevel: 'phone_matches_customer',
              metadata: { original_message_type: 'reschedule_series_confirmation', source: 'reschedule_public' },
            });
            if (!(msg?.blocked || msg?.sent === false)) {
              seriesNoticeSent = true;
              await AppointmentReminders.markRescheduleNoticeSent(shiftedOccurrences.map((occ) => occ.id));
            }
          }
        }
      } catch (err) {
        logger.warn(`[reschedule-public] series confirmation SMS failed for ${svc.id}: ${err.message}`);
      }
      if (!seriesNoticeSent) {
        // No-send path (no phone / template missing / blocked / send threw):
        // the covered 24h/72h flags above would otherwise suppress due
        // reminders entirely. Re-arm them so the 15-min cron still reminds
        // the customer of the new times — a possible duplicate was the risk
        // covering guards against; silence is worse.
        try {
          await db('appointment_reminders')
            .whereIn('scheduled_service_id', shiftedOccurrences.map((occ) => occ.id))
            .update({
              reminder_72h_sent: false,
              reminder_72h_sent_at: null,
              reminder_24h_sent: false,
              reminder_24h_sent_at: null,
              updated_at: db.fn.now(),
            });
        } catch (err) {
          logger.error(`[reschedule-public] series reminder re-arm failed for ${svc.id}: ${err.message}`);
        }
      }
    } else {
      try {
        await AppointmentReminders.handleReschedule(svc.id, `${date}T${slot.start_time}`);
      } catch (err) {
        logger.error(`[reschedule-public] reminder sync failed for ${svc.id}: ${err.message}`);
      }
    }

    // Live dispatch-board refresh, same broadcast the admin reschedule emits
    // (every shifted occurrence on a series re-anchor).
    try {
      const { emitDispatchJobUpdate } = require('../services/dispatch-assignment');
      const jobIds = shiftedOccurrences ? shiftedOccurrences.map((occ) => occ.id) : [svc.id];
      for (const jobId of jobIds) {
        await emitDispatchJobUpdate({ jobId, actorId: null });
      }
    } catch (err) {
      logger.error(`[reschedule-public] board broadcast failed for ${svc.id}: ${err.message}`);
    }

    // Series-shift conflicts: the rebooker validated each shifted sibling
    // INSIDE the commit trx and cleared the tech on any that would have
    // double-booked a route (occ.conflicted) — nothing double-booked ever
    // commits. Owner model is hands-off + exception-based: park the
    // unassigned ones as an admin notification for reassignment from
    // dispatch.
    const siblingConflicts = (shiftedOccurrences || [])
      .filter((occ) => occ.conflicted)
      .map((occ) => ({ id: occ.id, date: String(occ.date).split('T')[0] }));
    if (siblingConflicts.length) {
      logger.warn(`[reschedule-public] series re-anchor for ${svc.id} unassigned ${siblingConflicts.length} conflicting sibling(s): ${JSON.stringify(siblingConflicts)}`);
      try {
        const NotificationService = require('../services/notification-service');
        const notif = await NotificationService.notifyAdmin(
          'schedule_conflict',
          'Series re-anchor needs a look',
          `${[svc.cust_first_name, svc.cust_last_name].filter(Boolean).join(' ') || 'A customer'} pulled a recurring visit forward; ${siblingConflicts.length} shifted future visit(s) landed on already-booked windows and were left UNASSIGNED (${siblingConflicts.map((c) => c.date).join(', ')}). Reassign from dispatch.`,
          { metadata: { customerId: svc.customer_id, scheduledServiceId: svc.id, conflicts: siblingConflicts } }
        );
        if (!notif) {
          logger.error(`[reschedule-public] schedule_conflict notification insert FAILED for ${svc.id} — unassigned siblings: ${JSON.stringify(siblingConflicts)}`);
        }
      } catch (err) {
        logger.error(`[reschedule-public] schedule_conflict notification failed for ${svc.id}: ${err.message} — unassigned siblings: ${JSON.stringify(siblingConflicts)}`);
      }
    }

    // Office alert — same internal ping a new self-booked appointment fires.
    try {
      if (process.env.ADAM_PHONE) {
        const TwilioService = require('../services/twilio');
        const name = [svc.cust_first_name, svc.cust_last_name].filter(Boolean).join(' ') || 'Customer';
        const displayDate = new Date(`${date}T12:00:00`).toLocaleDateString('en-US', {
          weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York',
        });
        const seriesNote = shiftedOccurrences
          ? `\nSERIES RE-ANCHORED — ${shiftedOccurrences.length} visit(s) shifted${siblingConflicts.length ? ` — ⚠️ ${siblingConflicts.length} left UNASSIGNED (see bell)` : ''}`
          : '';
        await TwilioService.sendSMS(
          process.env.ADAM_PHONE,
          `🔁 Customer self-rescheduled:\n${name}\n${svc.service_type || 'service'}\n${apptDateStr(svc.scheduled_date)} → ${displayDate} ${slot.start_label}-${slot.end_label}${seriesNote}\n${svc.city || ''}`,
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
      // The success card tells the customer their following visits moved too.
      seriesShifted: !!shiftedOccurrences,
      occurrencesRescheduled: shiftedOccurrences ? shiftedOccurrences.length : 1,
    });
  } catch (err) {
    next(err);
  }
});

router._test = {
  eligibility,
  bookingRange,
  searchParseOpts,
  apptDateStr,
  label12,
  pullForwardDays,
  shouldReanchor,
  REANCHOR_PULLFORWARD_DAYS,
};

module.exports = router;
