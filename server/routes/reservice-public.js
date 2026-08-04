/**
 * Public self-serve re-service routes — /api/public/reservice/:token.
 *
 * The standing customer link (customers.reservice_token, migration
 * 20260804000001) that lets an ACTIVE recurring / WaveGuard customer book
 * their FREE between-visit re-service callback (pest_re_service /
 * lawn_re_service — services/re-service.js) without calling the office.
 *
 * No auth. The 64-char hex token is the only gate, mirroring the
 * /reschedule/:token model: token format gate, 60 req/min rate limit,
 * noStore privacy headers, 404 reserved for bad/unknown tokens (and for the
 * whole surface while GATE_RESERVICE_SELF_SERVE is dark — unobservable until
 * the owner flips it), and every other edge case returns a well-shaped
 * payload the ReservicePage renders.
 *
 * GET  /:token — lane eligibility + live open slots. Lanes come from LIVE
 *   plan state (services/reservice-scheduler.js): pest and/or lawn, each
 *   carrying its open-callback dedupe — a lane with a pending/confirmed
 *   callback already on the books is NOT re-bookable; the payload hands over
 *   that visit's /reschedule link instead ("already booked — move it").
 *   Slots come from the same route-aware availability builder the public
 *   /book funnel and the reschedule page use (buildBookingAvailability),
 *   over the same booking_config advance-days window, around the CUSTOMER's
 *   coordinates. When both lanes are open the browse list is computed at the
 *   LONGER lane duration so every offered slot commits cleanly for either.
 *
 * POST /:token/find-slots — Waves AI date/time search. Same parser the
 *   reschedule page uses (parseWhen), clamped to the booking window on both
 *   ends so the search never surfaces a date the commit would reject.
 *
 * POST /:token — commit. Lane re-validated (eligibility + open-callback
 *   dedupe re-checked fresh), then the requested slot is re-validated
 *   against a fresh single-day availability run at the LANE's real duration
 *   (a customer can only commit a slot the engine still offers — the same
 *   anti-forgery model reschedule-public uses in place of the funnel's
 *   signed-offer HMAC), then committed through booking.js
 *   createSelfBooking with the internal `callbackVisit` option: the visit
 *   persists is_callback=true (completion never bills the monthly rate),
 *   carries the re-service catalog service_id, and skips the funnel-only
 *   card-capture step and ad attribution. All of createSelfBooking's
 *   transactional guarantees (advisory locks, blackout dates, global
 *   occupancy, self-book day caps, idempotent replay) apply unchanged.
 *
 * Post-commit (inside createSelfBooking, best-effort): the standard
 * appointment confirmation SMS/email — which carries the NEW visit's
 * /reschedule link, closing the loop with the rescheduler — plus the office
 * internal alert ("🔁 Free re-service self-booked"). This route additionally
 * returns the new visit's rescheduleUrl so the success card can offer
 * "need to move it?" immediately.
 */

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../models/db');
const logger = require('../services/logger');
const { noStore } = require('../middleware/no-store');
const { etDateString, addETDays } = require('../utils/datetime-et');
const {
  RESERVICE_LANES,
  reserviceSelfServeEnabled,
  reserviceLanesForCustomer,
  openReserviceCallbacks,
} = require('../services/reservice-scheduler');

// Token-keyed customer data (name, availability around their address) —
// never cacheable.
router.use(noStore);

// Token format: 64-char lowercase hex (encode(gen_random_bytes(32), 'hex')).
const TOKEN_RE = /^[a-f0-9]{64}$/;

// Customer-facing note length cap ("what's going on") — flows into the
// visit's dispatch notes via createSelfBooking's customer_notes handling.
const MAX_DETAILS_LENGTH = 400;

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

// AI search spends a model call per request — same budget as the reschedule
// page's find-slots limiter.
const findSlotsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many searches. Please try again in a minute.' },
});

async function loadByToken(token) {
  return db('customers')
    .where('reservice_token', token)
    .whereNull('deleted_at')
    .first(
      'id', 'first_name', 'last_name', 'active', 'waveguard_tier', 'monthly_rate',
      'address_line1', 'city', 'state', 'zip', 'latitude', 'longitude', 'phone'
    );
}

// The booking window mirrors the public /book funnel's config-driven range —
// identical to reschedule-public's bookingRange.
function bookingRange(config, now = new Date()) {
  return {
    rangeFrom: etDateString(addETDays(now, config.advance_days_min ?? 1)),
    rangeTo: etDateString(addETDays(now, config.advance_days_max ?? 14)),
  };
}

// parseWhen options for the AI search: clamped to the booking window on BOTH
// ends (same posture as reschedule-public — the search must never surface a
// date the page's own slot list and the commit wouldn't accept).
function searchParseOpts(config, now = new Date()) {
  return {
    now,
    minDaysOut: config.advance_days_min ?? 1,
    maxDaysOut: config.advance_days_max ?? 14,
    defaultWindowDays: config.advance_days_max ?? 14,
  };
}

// Catalog rows for the two lanes, keyed by lane. A missing row (partial
// seed) simply drops that lane — the office lane still exists by phone.
async function loadLaneCatalog() {
  const keys = Object.values(RESERVICE_LANES).map((l) => l.serviceKey);
  const rows = await db('services')
    .whereIn('service_key', keys)
    .select('id', 'service_key', 'name', 'default_duration_minutes');
  const byLane = {};
  for (const [lane, meta] of Object.entries(RESERVICE_LANES)) {
    const row = rows.find((r) => r.service_key === meta.serviceKey);
    if (!row) continue;
    const rawDuration = parseInt(row.default_duration_minutes, 10);
    byLane[lane] = {
      serviceId: row.id,
      serviceKey: row.service_key,
      serviceType: row.name || meta.label,
      // Clamp to the availability engine's sane band (45–90, the same range
      // resolveBookingDuration honors) so a fat-fingered catalog edit can't
      // shrink the overlap window or block whole days.
      durationMinutes: Number.isInteger(rawDuration) && rawDuration >= 45 && rawDuration <= 90
        ? rawDuration
        : meta.fallbackDuration,
    };
  }
  return byLane;
}

// Route-aware availability around the CUSTOMER's property — the coords
// resolution mirrors reschedule-public's buildAvailabilityForService (stored
// coords first, geocode of the address text as fallback).
async function buildAvailabilityForCustomer(customer, { rangeFrom, rangeTo, config, duration, timeOfDay }) {
  const booking = require('./booking');
  const { resolveBookingCoords, buildBookingAvailability } = booking._internals;

  let lat = customer.latitude != null ? parseFloat(customer.latitude) : null;
  let lng = customer.longitude != null ? parseFloat(customer.longitude) : null;
  if (!lat || !lng) {
    const address = [customer.address_line1, customer.city, customer.state, customer.zip]
      .filter(Boolean).join(', ');
    const resolved = await resolveBookingCoords({ address: address || null, city: customer.city || null });
    lat = resolved.lat;
    lng = resolved.lng;
  }
  if (!lat || !lng) return null;

  return buildBookingAvailability({
    lat,
    lng,
    duration,
    rangeFrom,
    rangeTo,
    config,
    today: new Date(),
    ...(timeOfDay ? { timeOfDay } : {}),
  });
}

// Lane state for the payload: which lanes the customer holds, and per lane
// whether an open callback already blocks it (with the tie-in reschedule
// link). Returns { lanes: [...payload rows], bookableLanes: ['pest',...] }.
async function resolveLaneState(customer, laneCatalog) {
  // Churned/deactivated rows keep their token but lose eligibility — the
  // page renders the friendly not-eligible state with the office contacts.
  const eligible = customer.active === false ? [] : await reserviceLanesForCustomer(customer);
  const open = eligible.length ? await openReserviceCallbacks(customer.id) : {};
  const lanes = eligible
    .filter((lane) => laneCatalog[lane])
    .map((lane) => ({
      key: lane,
      label: laneCatalog[lane].serviceType,
      alreadyBooked: open[lane] || null,
    }));
  return {
    lanes,
    bookableLanes: lanes.filter((l) => !l.alreadyBooked).map((l) => l.key),
  };
}

router.get('/:token', async (req, res, next) => {
  if (!reserviceSelfServeEnabled() || !TOKEN_RE.test(req.params.token || '')) {
    return res.status(404).json({ error: 'Not found' });
  }

  try {
    const customer = await loadByToken(req.params.token);
    if (!customer) return res.status(404).json({ error: 'Not found' });

    const laneCatalog = await loadLaneCatalog();
    const { lanes, bookableLanes } = await resolveLaneState(customer, laneCatalog);

    const base = {
      state: lanes.length === 0
        ? 'not_eligible'
        : (bookableLanes.length === 0 ? 'already_booked' : 'bookable'),
      customerFirstName: customer.first_name || null,
      lanes,
    };
    if (bookableLanes.length === 0) {
      return res.json({ ...base, availability: null });
    }

    const booking = require('./booking');
    const config = await booking._internals.loadBookingConfig();
    const range = bookingRange(config);

    // Browse at the LONGEST bookable-lane duration so every offered slot is
    // feasible for whichever lane the customer picks; the commit re-validates
    // at the lane's own duration anyway (a shorter visit in a longer slot's
    // window only relaxes the constraints).
    const browseDuration = Math.max(...bookableLanes.map((lane) => laneCatalog[lane].durationMinutes));

    let availability = null;
    try {
      availability = await buildAvailabilityForCustomer(customer, { ...range, config, duration: browseDuration });
    } catch (err) {
      logger.error(`[reservice-public] availability failed for customer ${customer.id}: ${err.message}`);
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

// Waves AI date/time search — same shape contract as the reschedule page's
// find-slots so the client splices results straight into its day list.
router.post('/:token/find-slots', findSlotsLimiter, async (req, res, next) => {
  if (!reserviceSelfServeEnabled() || !TOKEN_RE.test(req.params.token || '')) {
    return res.status(404).json({ error: 'Not found' });
  }

  const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
  if (!query) return res.status(400).json({ error: 'query required' });
  if (query.length > 500) return res.status(400).json({ error: 'query too long' });

  try {
    const customer = await loadByToken(req.params.token);
    if (!customer) return res.status(404).json({ error: 'Not found' });

    const laneCatalog = await loadLaneCatalog();
    const { bookableLanes } = await resolveLaneState(customer, laneCatalog);
    if (bookableLanes.length === 0) {
      return res.status(409).json({ error: 'A re-service can no longer be booked from this link.' });
    }

    const booking = require('./booking');
    const config = await booking._internals.loadBookingConfig();
    const range = bookingRange(config);
    const browseDuration = Math.max(...bookableLanes.map((lane) => laneCatalog[lane].durationMinutes));

    const { parseWhen, summarizeWindow } = require('../services/scheduling/parse-when');
    const when = await parseWhen(query, searchParseOpts(config));

    let availability = null;
    try {
      availability = await buildAvailabilityForCustomer(customer, {
        rangeFrom: when.dateFrom,
        rangeTo: when.dateTo,
        config,
        duration: browseDuration,
        timeOfDay: when.timeOfDay,
      });
    } catch (err) {
      logger.error(`[reservice-public] find-slots availability failed for customer ${customer.id}: ${err.message}`);
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
  if (!reserviceSelfServeEnabled() || !TOKEN_RE.test(req.params.token || '')) {
    return res.status(404).json({ error: 'Not found' });
  }

  const date = typeof req.body?.date === 'string' ? req.body.date.trim() : '';
  const startTime = typeof req.body?.start_time === 'string' ? req.body.start_time.trim() : '';
  const lane = typeof req.body?.lane === 'string' ? req.body.lane.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(startTime)) {
    return res.status(400).json({ error: 'date (YYYY-MM-DD) and start_time (HH:MM) required' });
  }
  if (!Object.prototype.hasOwnProperty.call(RESERVICE_LANES, lane)) {
    return res.status(400).json({ error: 'lane must be pest or lawn' });
  }
  const details = typeof req.body?.details === 'string'
    ? req.body.details.trim().slice(0, MAX_DETAILS_LENGTH)
    : '';

  try {
    const customer = await loadByToken(req.params.token);
    if (!customer) return res.status(404).json({ error: 'Not found' });

    const laneCatalog = await loadLaneCatalog();
    const { lanes, bookableLanes } = await resolveLaneState(customer, laneCatalog);
    const laneRow = lanes.find((l) => l.key === lane);
    if (!laneRow) {
      return res.status(409).json({
        error: 'This re-service isn\'t available for your plan online. Text or call us and we\'ll take care of it.',
        code: 'NOT_ELIGIBLE',
      });
    }
    if (!bookableLanes.includes(lane)) {
      // Fresh dedupe hit — hand back the existing visit's reschedule link so
      // the page pivots to "you're already booked — move it instead".
      return res.status(409).json({
        error: 'You already have a re-service visit on the books.',
        code: 'ALREADY_BOOKED',
        alreadyBooked: laneRow.alreadyBooked,
      });
    }
    const catalog = laneCatalog[lane];

    const booking = require('./booking');
    const config = await booking._internals.loadBookingConfig();
    const range = bookingRange(config);
    if (date < range.rangeFrom || date > range.rangeTo) {
      return res.status(400).json({ error: 'That date is outside the online scheduling window.' });
    }

    // Anti-forgery: the customer can only commit a slot the availability
    // engine still offers for that day AT THIS LANE's duration (route
    // feasibility, lunch reserve, day caps, whole-hour grid). Replaces the
    // funnel's signed-offer HMAC for this surface — same model as
    // reschedule-public. createSelfBooking's transactional conflict checks
    // below still own the race.
    const dayAvailability = await buildAvailabilityForCustomer(customer, {
      rangeFrom: date,
      rangeTo: date,
      config,
      duration: catalog.durationMinutes,
    });
    const day = dayAvailability?.days?.find((d) => d.date === date);
    const slot = day?.slots?.find((s) => s.start_time === startTime);
    if (!slot) {
      let refreshed = null;
      try {
        refreshed = await buildAvailabilityForCustomer(customer, {
          ...range, config, duration: catalog.durationMinutes,
        });
      } catch (err) {
        logger.warn(`[reservice-public] refresh availability failed for customer ${customer.id}: ${err.message}`);
      }
      return res.status(409).json({
        error: 'That time is no longer open. Here are the latest available times.',
        code: 'SLOT_TAKEN',
        availability: refreshed
          ? { slots: refreshed.slots, days: refreshed.days, nearby: refreshed.nearby, rangeFrom: range.rangeFrom, rangeTo: range.rangeTo }
          : null,
      });
    }

    const { createSelfBooking } = booking._internals;
    const result = await createSelfBooking({
      slot_date: date,
      slot_start: slot.start_time,
      slot_end: slot.end_time,
      technician_id: slot.technician_id || null,
      customer_notes: details
        ? `Re-service request: ${details}`
        : 'Re-service requested via self-serve link',
      source: 'reservice_link',
      // Server-resolved trust context — the token IS the identity proof
      // (same bearer posture as /reschedule). No pricing, no funnel gates.
      authedCustomer: customer,
      payAtVisit: false,
      customersOnly: false,
      callbackVisit: {
        serviceKey: catalog.serviceKey,
        serviceId: catalog.serviceId,
        serviceType: catalog.serviceType,
        durationMinutes: catalog.durationMinutes,
      },
    });

    if (!result.ok) {
      // A 409 out of the transaction is a slot-level race (SLOT_TAKEN /
      // DAY_FULL) — refresh the list so the page recovers in one step, the
      // same shape the pre-check above answers with.
      if (result.status === 409) {
        let refreshed = null;
        try {
          refreshed = await buildAvailabilityForCustomer(customer, {
            ...range, config, duration: catalog.durationMinutes,
          });
        } catch { /* answer without the refresh */ }
        return res.status(409).json({
          error: result.error,
          code: 'SLOT_TAKEN',
          availability: refreshed
            ? { slots: refreshed.slots, days: refreshed.days, nearby: refreshed.nearby, rangeFrom: range.rangeFrom, rangeTo: range.rangeTo }
            : null,
        });
      }
      return res.status(result.status || 500).json({ error: result.error });
    }

    // Tie-in with the rescheduler: the committed visit minted its own
    // reschedule_token (column DEFAULT) — hand the link back so the success
    // card offers "need to move it?" without waiting for the SMS.
    let rescheduleUrl = null;
    try {
      const serviceRow = await db('scheduled_services')
        .where({ self_booking_id: result.body?.booking?.id })
        .first('reschedule_token');
      if (serviceRow?.reschedule_token) rescheduleUrl = `/reschedule/${serviceRow.reschedule_token}`;
    } catch (err) {
      logger.warn(`[reservice-public] reschedule-link lookup failed for booking ${result.body?.booking?.id}: ${err.message}`);
    }

    return res.json({
      success: true,
      replayed: !!result.body?.replayed,
      lane,
      serviceType: catalog.serviceType,
      date,
      window: { start: slot.start_time, end: slot.end_time },
      startLabel: slot.start_label,
      endLabel: slot.end_label,
      confirmationCode: result.body?.confirmationCode || null,
      rescheduleUrl,
    });
  } catch (err) {
    next(err);
  }
});

router._test = {
  TOKEN_RE,
  MAX_DETAILS_LENGTH,
  bookingRange,
  searchParseOpts,
  loadLaneCatalog,
  resolveLaneState,
};

module.exports = router;
