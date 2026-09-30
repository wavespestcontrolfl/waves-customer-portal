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
 *   Passes rankProfile:'reservice' to buildBookingAvailability — with
 *   GATE_RESERVICE_RANK_AFTER_NEW live (owner ruling 2026-09-24: new-customer
 *   bookings get first pick of open time), the suggested strip and each
 *   day's is_best_fit badge rank packed slots against existing stops ahead
 *   of empty-day slots, with a 5-business-day latency guard; the offered
 *   slot set itself (days[].slots) never changes. Gate off: byte-identical
 *   (see reserviceAvailabilityPayload below — every availability object on
 *   this route carries `rank_profile: 'reservice'` ONLY while the gate is
 *   actually live, omitted entirely when it's off, so the client's own
 *   "keep the ranked strip after a search" behavior keys off that flag
 *   rather than the route, and the kill switch genuinely restores the old
 *   UI).
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
const { capacityEnabled } = require('../services/scheduling/policy');
const { noStore } = require('../middleware/no-store');
const { etDateString, addETDays } = require('../utils/datetime-et');
const {
  RESERVICE_LANES,
  reserviceSelfServeEnabled,
  reserviceLanesForCustomer,
  openReserviceCallbacks,
  reserviceLaneAvailability,
} = require('../services/reservice-scheduler');
const {
  RESERVICE_PEST_CHOICES,
  normalizeRequestPests,
  pestLabels,
} = require('../services/reservice-request');

// GATE_RESERVICE_PEST_CHIPS (nested inside reserviceSelfServe — see
// feature-gates.js): GET's optional pestChoices key and POST's `pests`
// normalization. Off = byte-identical to before this gate existed.
function pestChipsEnabled() {
  return require('../config/feature-gates').isEnabled('reservicePestChips');
}

// Token-keyed customer data (name, availability around their address) —
// never cacheable.
router.use(noStore);

// Also enforce the dark response before local limits when this router is
// mounted independently of index.js's pre-limiter guard.
router.use((req, res, next) => {
  if (!reserviceSelfServeEnabled()) return res.status(404).json({ error: 'Not found' });
  return next();
});

// Token format: 64-char lowercase hex (encode(gen_random_bytes(32), 'hex')).
const TOKEN_RE = /^[a-f0-9]{64}$/;

// Customer-facing note length cap ("what's going on") — flows into the
// visit's dispatch notes via createSelfBooking's customer_notes handling.
const MAX_DETAILS_LENGTH = 400;
const LOCATION_REVIEW_ERROR = 'We need to confirm your service address before we can schedule this re-service online. Text or call us and we’ll take care of it.';

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
      'address_line1', 'address_line2', 'city', 'state', 'zip', 'latitude', 'longitude', 'phone'
    );
}

// createSelfBooking consults the address-bound staff review only when a
// returning customer's stored coordinate pair is missing. Mirror that exact
// boundary on this surface: a matching permanent review block must not be
// turned into another list of slots that commit will refuse, while a complete
// stored pair and the dark review gate retain the existing flow.
async function reserviceLocationReviewRequired(customer) {
  const hasStoredPair = ['latitude', 'longitude'].every((field) => customer?.[field] != null
    && String(customer[field]).trim() !== ''
    && Number.isFinite(Number(customer[field]))
    && Number(customer[field]) !== 0);
  if (hasStoredPair) return false;
  const reviewed = await require('../services/customer-geocode-review').reviewedServiceLocation({
    customer_id: customer.id,
    service_address_line1: customer.address_line1 || null,
    service_address_line2: customer.address_line2 || null,
    service_address_city: customer.city || null,
    service_address_state: customer.state || null,
    service_address_zip: customer.zip || null,
  });
  return reviewed?.permanent === true
    && !reviewed.location
    && reviewed.reason === 'address_review_required';
}

function locationReviewFailure() {
  return { error: LOCATION_REVIEW_ERROR, code: 'LOCATION_REVIEW_REQUIRED' };
}

function serviceLocationFingerprint(customer) {
  return [
    customer?.address_line1,
    customer?.address_line2,
    customer?.city,
    customer?.state,
    customer?.zip,
    customer?.latitude,
    customer?.longitude,
  ].map(value => String(value ?? '').trim()).join('|');
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
      // Clamp to the callback band (15–90, the same range
      // resolveCallbackDuration honors) so a fat-fingered catalog edit can't
      // shrink the overlap window or block whole days. Floor is 15, not the
      // funnel's 45 — re-services are true 15–30 min visits and the shorter
      // duration is what lets the slot search fit them into route gaps.
      durationMinutes: Number.isInteger(rawDuration) && rawDuration >= 15 && rawDuration <= 90
        ? rawDuration
        : meta.fallbackDuration,
    };
  }
  return byLane;
}

// Route-aware availability around the CUSTOMER's property, built on the
// pin the re-service commit books at (booking's customerBookingLocation:
// the stored pin, else a staff-verified pin or the canonical geocode) — an
// offer made anywhere else would be for a location the commit never uses
// (Codex #4992 P1). Nothing resolvable, no offers.
async function buildAvailabilityForCustomer(customer, { rangeFrom, rangeTo, config, duration, timeOfDay, lanes }) {
  const booking = require('./booking');
  const { customerBookingLocation, buildBookingAvailability, bookInsertionOffersLive } = booking._internals;

  const location = await customerBookingLocation(customer);
  if (!location) return null;

  return buildBookingAvailability({
    lat: location.lat,
    lng: location.lng,
    duration,
    serviceKey: lanes.map(lane => ({ pest: 'pest_control', lawn: 'lawn_care' })[lane]).join('+'),
    rangeFrom,
    rangeTo,
    config,
    today: new Date(),
    // Self-serve surface — enforce the notice window (owner ruling 2026-09-23).
    selfServeNotice: true,
    // Re-service rank profile (GATE_RESERVICE_RANK_AFTER_NEW, owner ruling
    // 2026-09-24): only takes effect when the gate is live — see
    // buildBookingAvailability's own doc comment. Passed unconditionally so
    // every browse/search/commit-revalidation call on this route (the only
    // caller of buildAvailabilityForCustomer) opts in the same way; it never
    // filters the offered slot set, so the commit-time re-validation below
    // still accepts exactly what days[].slots offers.
    rankProfile: 'reservice',
    // This route's commit (line ~533 below) is createSelfBooking — while
    // bookInsertionOffersLive() is live it re-verifies with traffic and
    // persists the certified route order, so an inserted offer here is safe
    // to commit at the position it was offered (see the capacityPlacement
    // comment inside buildBookingAvailability, booking.js). This callback
    // flow skips the signed-offer HMAC (its anti-forgery proof is a fresh
    // rebuild in the same request, a few lines before createSelfBooking) —
    // bookInsertionOffersLive() is what keeps that rebuild's capacityPlacement
    // and the commit's own preparedCapacity gate reading the same env.
    capacityPlacement: bookInsertionOffersLive(),
    ...(timeOfDay ? { timeOfDay } : {}),
  });
}

// The one shape every availability response on this route sends — GET,
// find-slots, and both SLOT_TAKEN refreshes. `rank_profile` (buildBookingAvailability
// -> applyReserviceProfile's rankProfileFields) rides along ONLY when
// GATE_RESERVICE_RANK_AFTER_NEW was actually live for this build; omitted
// entirely when it's off, so a gate flip restores a byte-identical payload.
// The client (ScheduleFlowPage.jsx) keys its "keep the ranked strip visible
// after an AI search" exception on this flag rather than on the route/flow
// name, so the kill switch actually restores the old UI (pre-push audit r3
// P1 on #4926).
function reserviceAvailabilityPayload(availability, range) {
  return {
    slots: availability.slots,
    days: availability.days,
    nearby: availability.nearby,
    rangeFrom: range.rangeFrom,
    rangeTo: range.rangeTo,
    ...(availability.rank_profile ? { rank_profile: availability.rank_profile } : {}),
  };
}

// Lane state for the payload: which lanes the customer holds, and per lane
// whether an open callback already blocks it (with the tie-in reschedule
// link). Returns { lanes: [...payload rows], bookableLanes: ['pest',...] }.
async function resolveLaneState(customer, laneCatalog) {
  // Churned/deactivated rows keep their token but lose eligibility — the
  // page renders the friendly not-eligible state with the office contacts.
  // Codex round-11 P2 (PR #5336): the SAME shared computation the SMS promise
  // validators use (reservice-scheduler.reserviceLaneAvailability).
  const { eligible, open } = await reserviceLaneAvailability(customer);
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
      // Gate off: key omitted entirely — byte-identical to before this gate
      // existed (Codex-review contract other reservice payload fields use,
      // e.g. `rank_profile` above).
      ...(pestChipsEnabled() && bookableLanes.length
        ? { pestChoices: Object.fromEntries(bookableLanes.map((key) => [key, RESERVICE_PEST_CHOICES[key]])) }
        : {}),
    };
    if (bookableLanes.length === 0) {
      return res.json({ ...base, availability: null });
    }
    const booking = require('./booking');
    const config = await booking._internals.loadBookingConfig();
    const range = bookingRange(config);

    const requestedLane = req.query.lane;
    if (requestedLane != null && !bookableLanes.includes(requestedLane)) {
      // A parallel booking or plan change should refresh eligibility, not
      // trap Retry on the same stale lane query. Malformed lanes still fail.
      if (Object.hasOwn(RESERVICE_LANES, requestedLane)) return res.json({ ...base, availability: null });
      return res.status(400).json({ error: 'Choose an available service.' });
    }
    const browseLanes = requestedLane ? [requestedLane] : bookableLanes;
    if (capacityEnabled() && browseLanes.length > 1) {
      return res.json({ ...base, availability: null });
    }
    if (await reserviceLocationReviewRequired(customer)) {
      return res.json({ ...base, availability: null, location_review_required: true });
    }
    const browseDuration = Math.max(...browseLanes.map((lane) => laneCatalog[lane].durationMinutes));

    let availability = null;
    try {
      availability = await buildAvailabilityForCustomer(customer, { ...range, config, duration: browseDuration, lanes: browseLanes });
    } catch (err) {
      logger.error(`[reservice-public] availability failed for customer ${customer.id}: ${err.message}`);
    }

    return res.json({
      ...base,
      availability: availability ? reserviceAvailabilityPayload(availability, range) : null,
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

    const requestedLane = req.body?.lane;
    if (requestedLane != null && !bookableLanes.includes(requestedLane)) {
      return res.status(400).json({ error: 'Choose an available service.' });
    }
    const browseLanes = requestedLane ? [requestedLane] : bookableLanes;
    if (capacityEnabled() && browseLanes.length > 1) {
      return res.status(400).json({ error: 'Choose a service before searching for times.' });
    }
    if (await reserviceLocationReviewRequired(customer)) {
      return res.status(409).json(locationReviewFailure());
    }

    const booking = require('./booking');
    const config = await booking._internals.loadBookingConfig();
    const range = bookingRange(config);
    const browseDuration = Math.max(...browseLanes.map((lane) => laneCatalog[lane].durationMinutes));

    const { parseWhen, summarizeWindow } = require('../services/scheduling/parse-when');
    const when = await parseWhen(query, searchParseOpts(config));

    const availability = await buildAvailabilityForCustomer(customer, {
      rangeFrom: when.dateFrom,
      rangeTo: when.dateTo,
      config,
      duration: browseDuration,
      lanes: browseLanes,
      timeOfDay: when.timeOfDay,
    }).catch((err) => {
      logger.error(`[reservice-public] find-slots availability failed for customer ${customer.id}: ${err.message}`);
      return null;
    });
    if (!availability) {
      return res.status(503).json({ error: 'Slot search is unavailable right now. Please pick from the times below.' });
    }

    const slotCount = (availability.days || []).reduce((n, d) => n + (Array.isArray(d.slots) ? d.slots.length : 0), 0);
    return res.json({
      summary: summarizeWindow(when, { count: slotCount, nearby: availability.nearby }),
      understood: when.understood,
      window: { date_from: when.dateFrom, date_to: when.dateTo },
      time_of_day: when.timeOfDay,
      availability: reserviceAvailabilityPayload(availability, range),
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
  // Gate off: ignored outright, regardless of what a crafted body sends.
  const requestedPests = pestChipsEnabled() ? normalizeRequestPests(req.body?.pests, lane) : null;
  const requestedPestLabels = requestedPests ? pestLabels(requestedPests, lane) : [];

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
    if (await reserviceLocationReviewRequired(customer)) {
      return res.status(409).json(locationReviewFailure());
    }

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
      lanes: [lane],
    });
    const day = dayAvailability?.days?.find((d) => d.date === date);
    const slot = day?.slots?.find((s) => s.start_time === startTime);
    if (!slot) {
      let refreshed = null;
      try {
        refreshed = await buildAvailabilityForCustomer(customer, {
          ...range, config, duration: catalog.durationMinutes, lanes: [lane],
        });
      } catch (err) {
        logger.warn(`[reservice-public] refresh availability failed for customer ${customer.id}: ${err.message}`);
      }
      return res.status(409).json({
        error: 'That time is no longer open. Here are the latest available times.',
        code: 'SLOT_TAKEN',
        availability: refreshed ? reserviceAvailabilityPayload(refreshed, range) : null,
      });
    }

    const { createSelfBooking } = booking._internals;
    const result = await createSelfBooking({
      slot_date: date,
      slot_start: slot.start_time,
      slot_end: slot.end_time,
      technician_id: slot.technician_id || null,
      // Pest chips (gated) fold into the same customer-visible line the
      // details box always produced; the plain no-pests fallbacks are
      // untouched.
      customer_notes: requestedPestLabels.length
        ? (details
          ? `Re-service request (${requestedPestLabels.join(', ')}): ${details}`
          : `Re-service request: ${requestedPestLabels.join(', ')}`)
        : (details
          ? `Re-service request: ${details}`
          : 'Re-service requested via self-serve link'),
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
        // Clean re-service request storage (migration 20260927100000) — the
        // customer's own words (or null), always stamped from the details
        // box; `pests` is null unless GATE_RESERVICE_PEST_CHIPS is live.
        // createSelfBooking only writes these columns when they exist
        // (hasColumn guard), so a deploy ahead of the migration is inert.
        ...(details || requestedPestLabels.length ? {
          customerRequest: { text: details || null, source: 'picker', pests: requestedPests },
        } : {}),
      },
    });

    if (!result.ok) {
      // Lane-dedupe race lost inside the transaction (another commit for
      // this lane won under the advisory lock): answer exactly like the
      // pre-check's dedupe hit, with the winning visit's reschedule link.
      if (result.code === 'ALREADY_BOOKED') {
        let booked = null;
        try {
          const open = await openReserviceCallbacks(customer.id);
          booked = open[lane] || null;
        } catch { /* answer without the visit details */ }
        return res.status(409).json({
          error: result.error,
          code: 'ALREADY_BOOKED',
          alreadyBooked: booked,
        });
      }
      // An address, pin, review, or contact can change after the pre-check or
      // while the transaction waits on its fences. Reload the token row so a
      // retired link stays indistinguishable. A genuine location/review change
      // enters address recovery; a contact-only race can safely rebuild times
      // from the current row and keep the customer in the scheduling flow.
      if (result.code === 'LOCATION_CHANGED_RETRY' || result.code === 'CUSTOMER_CHANGED_RETRY') {
        const currentCustomer = await loadByToken(req.params.token);
        if (!currentCustomer) return res.status(404).json({ error: 'Not found' });
        const locationChanged = result.code === 'LOCATION_CHANGED_RETRY'
          || serviceLocationFingerprint(currentCustomer) !== serviceLocationFingerprint(customer);
        if (locationChanged || await reserviceLocationReviewRequired(currentCustomer)) {
          return res.status(409).json(locationReviewFailure());
        }
        let refreshed = null;
        try {
          refreshed = await buildAvailabilityForCustomer(currentCustomer, {
            ...range, config, duration: catalog.durationMinutes, lanes: [lane],
          });
        } catch { /* answer without the refresh; the client reloads */ }
        return res.status(409).json({
          error: 'Your account details changed while we were booking. Please choose a time again.',
          code: 'SLOT_TAKEN',
          availability: refreshed ? reserviceAvailabilityPayload(refreshed, range) : null,
        });
      }
      // Any other 409 out of the transaction is a slot-level race
      // (SLOT_TAKEN / DAY_FULL) — refresh the list so the page recovers in
      // one step, the same shape the pre-check above answers with.
      if (result.status === 409) {
        let refreshed = null;
        try {
          refreshed = await buildAvailabilityForCustomer(customer, {
            ...range, config, duration: catalog.durationMinutes, lanes: [lane],
          });
        } catch { /* answer without the refresh */ }
        return res.status(409).json({
          error: result.error,
          code: 'SLOT_TAKEN',
          availability: refreshed ? reserviceAvailabilityPayload(refreshed, range) : null,
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
  buildAvailabilityForCustomer,
  reserviceLocationReviewRequired,
  serviceLocationFingerprint,
};

module.exports = router;
