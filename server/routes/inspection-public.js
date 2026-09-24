/**
 * Public consultation-booking routes — /api/public/inspection/:token.
 *
 * "Book with Adam" (scope doc lead-inspection-link-scope.md §3): a lead-
 * scoped deep link that books the free Waves Assessment (owner ruling
 * 2026-09-08: an assessment is NOT a win — see services/assessment-booking.js)
 * without calling the office. Modeled directly on reservice-public.js — same
 * shell, same anti-forgery model (fresh single-day availability rebuild in
 * place of the funnel's signed-offer HMAC), same rate limits and privacy
 * posture — but scoped to a LEAD rather than a standing customer token.
 *
 * Token: mintLeadConsultationToken/verifyLeadConsultationToken
 * (utils/lead-consultation-token.js) — a 14-day HMAC carrying the lead id in
 * the token itself (`<leadId>.<exp>.<sig>`), namespaced apart from the
 * lead-prefill token so the two are never interchangeable. Whole surface is
 * dark behind GATE_LEAD_INSPECTION_LINK (leadInspectionLinkLive(), strict
 * `=== 'true'`, read at call time) — every route 404s while off.
 *
 * A well-formed but past-TTL token answers `{ state: 'expired' }` (200) so
 * the page can say so; a malformed/mis-signed token 404s like an unknown
 * customer token everywhere else in this route family. Distinguishing the
 * two re-verifies with nowSec pinned to 0 (the mint's `exp` is always a
 * positive unix-seconds value, so `exp < 0` never trips — this isolates the
 * TTL check from the signature/shape check without touching the shared
 * token util, whose verify contract is otherwise unchanged).
 *
 * GET  /:token — lead identity (masked) + availability. States: `ok`;
 *   `already_booked` (an open, non-terminal Waves Assessment visit already
 *   exists for the lead's customer — hand back its /reschedule link);
 *   `converted` (the lead converted, or already has a future booked
 *   NON-assessment visit — same shape as already_booked); `gone` (lead
 *   deleted/missing). Availability needs coordinates: the lead's linked
 *   customer's stored coords, else a geocode of whichever address is on
 *   file (customer row first, then the lead's own fields); with no address
 *   at all (or an address that fails to resolve), `availability: null` and
 *   `needs_address: true` — the page asks for one via POST /:token/availability
 *   before showing times.
 *
 * POST /:token/availability — address-first availability for a lead with no
 *   address on file yet (or whose stored one won't resolve). Same out-of-area
 *   stop as the commit. Does not persist anything — the address is stored
 *   only when the visit actually books.
 *
 * POST /:token/find-slots — the same natural-language search reservice uses.
 *
 * POST /:token — commit. Idempotent: a lead whose customer already holds an
 *   open assessment short-circuits to the same `already_booked` shape (200)
 *   instead of a second visit — checked BEFORE geocoding/creating anything.
 *   Address required only when neither the lead nor its (existing) customer
 *   has one on file; geocoded and checked against the service area (county
 *   via services/address-validation's reverseGeocodeCounty when available,
 *   else the service-area bounding box the geocoder itself already enforces
 *   — services/service-area.js) — out of area 422s and books nothing. The
 *   slot is re-validated against a fresh single-day availability build
 *   (anti-forgery, matching reservice-public). Booking goes through
 *   booking.js's createSelfBooking with the internal-only `callbackVisit`
 *   option — `isCallback: false` and `dedupeLane: false` (see booking.js:
 *   this is a free internal booking like a re-service callback in every way
 *   that matters for skipping the funnel's signed-offer/card-capture/ad-
 *   attribution/customer-promotion machinery, but it is NOT a re-service
 *   warranty callback, so it must not set is_callback or take the
 *   reservice-lane dedupe, which is keyed to pest/lawn re-service lanes and
 *   would false-hit on an unrelated open re-service). The lead gets (or
 *   keeps) a customer row and is linked (`leads.customer_id`) but nothing
 *   else on the lead changes — status/pipeline_stage/converted_at/member_since
 *   all stay untouched, matching promoteCustomerOnBooking's own
 *   isAssessmentServiceType guard and admin-leads.js's identical assessment
 *   posture. The free-text note rides `scheduled_services.internal_notes`
 *   (never `notes`, which is customer/tech visible) via a best-effort
 *   post-commit update, same posture as reservice-public's reschedule-link
 *   lookup. Office alert: booking.js's internal alert with `alertLabel`
 *   swapped to "🔁 Free consultation self-booked:" — no other customer
 *   comms beyond createSelfBooking's own standard confirmation.
 *
 * POST /:token/waitlist — the out-of-area stop's one-field ask: inserts (or
 *   no-ops on) a newsletter_subscribers row tagged `expansion_waitlist:<county>`.
 *   No email sent.
 */

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../models/db');
const logger = require('../services/logger');
const { noStore } = require('../middleware/no-store');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { leadInspectionLinkLive } = require('../config/feature-gates');
const { verifyLeadConsultationToken } = require('../utils/lead-consultation-token');
const { geocodeAddressWithStatus } = require('../services/geocoder');
const { reverseGeocodeCounty } = require('../services/address-validation');
const { isInServiceAreaCounty } = require('../services/call-triage-flags');
const { isAssessmentServiceType, ASSESSMENT_SERVICE_KEY } = require('../services/assessment-booking');
const { TERMINAL_STATUSES } = require('../services/waveguard-existing-services');
const { parseRawAddress } = require('../utils/address-normalizer');
const { buildRescheduleLink } = require('../services/reschedule-link');

// Lead-token surface — never cacheable (name, phone, address).
router.use(noStore);

// Customer-supplied free text caps ("anything we should know") — mirrors
// reservice-public's MAX_DETAILS_LENGTH.
const MAX_NOTES_LENGTH = 400;

router.use(rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in a minute.' },
}));

const commitLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again in a minute.' },
});

const findSlotsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many searches. Please try again in a minute.' },
});

// A well-formed-but-expired token still verifies here (nowSec pinned to 0 —
// mint's `exp` is always positive, so the TTL comparison never trips) —
// isolates "expired" from "garbage" without changing the shared token util.
function verifyIgnoringExpiry(token) {
  return verifyLeadConsultationToken(token, 0);
}

function maskPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits ? `***${digits.slice(-4)}` : '';
}

function addressDisplay({ line1, city, zip } = {}) {
  const tail = [city, zip].filter(Boolean).join(' ');
  return [line1, tail].filter(Boolean).join(', ') || null;
}

async function loadLead(leadId) {
  return db('leads').where({ id: leadId }).whereNull('deleted_at').first(
    'id', 'first_name', 'last_name', 'phone', 'email', 'address', 'city', 'zip',
    'status', 'customer_id', 'converted_at'
  );
}

async function loadCustomer(customerId) {
  return db('customers').where({ id: customerId }).whereNull('deleted_at').first(
    'id', 'first_name', 'last_name', 'phone', 'email',
    'address_line1', 'address_line2', 'city', 'state', 'zip', 'latitude', 'longitude'
  );
}

// The booking window mirrors reservice-public's — the config-driven range
// the /book funnel and reschedule page also use.
function bookingRange(config, now = new Date()) {
  return {
    rangeFrom: etDateString(addETDays(now, config.advance_days_min ?? 1)),
    rangeTo: etDateString(addETDays(now, config.advance_days_max ?? 14)),
  };
}

function searchParseOpts(config, now = new Date()) {
  return {
    now,
    minDaysOut: config.advance_days_min ?? 1,
    maxDaysOut: config.advance_days_max ?? 14,
    defaultWindowDays: config.advance_days_max ?? 14,
  };
}

// The Waves Assessment catalog row. A missing row still lets the page load
// (falls back to a 30-min slot grid), but the commit refuses to book without
// a real catalog id.
async function loadAssessmentCatalog() {
  const row = await db('services')
    .where({ service_key: ASSESSMENT_SERVICE_KEY })
    .first('id', 'default_duration_minutes');
  const rawDuration = parseInt(row?.default_duration_minutes, 10);
  return {
    serviceId: row?.id || null,
    serviceType: 'Waves Assessment',
    durationMinutes: Number.isInteger(rawDuration) && rawDuration >= 15 && rawDuration <= 90 ? rawDuration : 30,
  };
}

// Coordinates for the availability build: the linked customer's stored
// coords first, else a geocode of whichever address is on file (customer
// row, then the lead's own fields). Null when there is nothing to geocode or
// the geocode doesn't resolve to a usable service address.
async function resolveCoords(lead, custRow) {
  if (custRow?.latitude != null && custRow?.longitude != null) {
    return { lat: parseFloat(custRow.latitude), lng: parseFloat(custRow.longitude) };
  }
  const address = custRow?.address_line1
    ? [custRow.address_line1, custRow.city, custRow.state || 'FL', custRow.zip].filter(Boolean).join(', ')
    : (lead.address ? [lead.address, lead.city, 'FL', lead.zip].filter(Boolean).join(', ') : null);
  if (!address) return null;
  try {
    const { location } = await geocodeAddressWithStatus(address, { serviceAddress: true });
    return location;
  } catch (err) {
    logger.warn(`[inspection-public] coord resolution failed: ${err.message}`);
    return null;
  }
}

// Service-area verdict for a free-text address: reverse-geocode the county
// when a Google key is configured (authoritative — SERVICE_AREA_COUNTIES),
// else fall back to the box test the geocoder itself already enforced via
// serviceAddress:true (a returned location already passed it).
async function checkServiceArea(addressStr) {
  const { location } = await geocodeAddressWithStatus(addressStr, { serviceAddress: true });
  if (!location) return { ok: false, county: null, location: null };
  const key = process.env.GOOGLE_API_KEY || process.env.GOOGLE_MAPS_API_KEY;
  let county = null;
  if (key) {
    try {
      county = await reverseGeocodeCounty({ latitude: location.lat, longitude: location.lng }, key);
    } catch (err) {
      logger.warn(`[inspection-public] county reverse-geocode failed: ${err.message}`);
    }
  }
  if (county) return { ok: isInServiceAreaCounty(county), county, location };
  return { ok: true, county: null, location };
}

async function buildAvailabilityForLead(coords, { rangeFrom, rangeTo, config, duration, timeOfDay }) {
  const booking = require('./booking');
  const { buildBookingAvailability } = booking._internals;
  return buildBookingAvailability({
    lat: coords.lat,
    lng: coords.lng,
    duration,
    // Any active field tech, no lane concept here — the reservice pest lane's
    // key drives the same route-capacity computation for a one-off visit.
    serviceKey: 'pest_control',
    rangeFrom,
    rangeTo,
    config,
    today: new Date(),
    selfServeNotice: true,
    ...(timeOfDay ? { timeOfDay } : {}),
  });
}

function shapeAvailability(availability, range) {
  return {
    slots: availability.slots,
    days: availability.days,
    nearby: availability.nearby,
    rangeFrom: range.rangeFrom,
    rangeTo: range.rangeTo,
  };
}

function visitShape(row) {
  return {
    date: typeof row.scheduled_date === 'string'
      ? row.scheduled_date.slice(0, 10)
      : (row.scheduled_date?.toISOString?.().slice(0, 10) || null),
    window: {
      start: row.window_start ? String(row.window_start).slice(0, 5) : null,
      end: row.window_end ? String(row.window_end).slice(0, 5) : null,
    },
    serviceType: row.service_type || null,
  };
}

async function rescheduleUrlFor(visitId) {
  try {
    const { url } = await buildRescheduleLink(visitId, { reuseExisting: true });
    return url || null;
  } catch (err) {
    logger.warn(`[inspection-public] reschedule-link lookup failed for ${visitId}: ${err.message}`);
    return null;
  }
}

// The soonest open, non-terminal visit for a customer matching the given
// assessment filter. `futureOnly` scopes to scheduled_date >= today (used for
// the "already has a future non-assessment visit" converted check — a past
// terminal-status miss doesn't count, and neither should a same-day one that
// already happened, but a not-yet-terminal same-day row still should).
async function findOpenVisit(customerId, { assessmentOnly = false, excludeAssessment = false, futureOnly = false } = {}) {
  let q = db('scheduled_services')
    .where({ customer_id: customerId })
    .whereNotIn('status', TERMINAL_STATUSES)
    .orderBy([{ column: 'scheduled_date', order: 'asc' }, { column: 'window_start', order: 'asc' }])
    .select('id', 'scheduled_date', 'window_start', 'window_end', 'service_type', 'reschedule_token');
  if (futureOnly) q = q.where('scheduled_date', '>=', etDateString());
  const rows = await q.limit(50);
  for (const row of rows) {
    const assessment = isAssessmentServiceType(row.service_type);
    if (assessmentOnly && !assessment) continue;
    if (excludeAssessment && assessment) continue;
    return row;
  }
  return null;
}

// Minimal customer provisioning from a lead's own contact fields — same
// shape as lead-webhook.js's new-customer branch, but an assessment
// provisions a PROSPECT: no member_since, pipeline_stage stays 'new_lead'
// (matches admin-leads.js's identical assessmentVisit carve-out and
// promoteCustomerOnBooking's own isAssessmentServiceType guard).
async function createCustomerForLead(lead, address, location) {
  const { ensureCustomerAccount } = require('./admin-customers');
  const { createDefaultCustomerRows } = require('../services/customer-default-rows');
  const account = await ensureCustomerAccount(db, {
    firstName: lead.first_name || 'New Lead',
    lastName: lead.last_name || '',
    phone: lead.phone || '',
    email: lead.email || null,
  });
  const [created] = await db('customers').insert({
    account_id: account.accountId,
    is_primary_profile: !account.existingCustomer,
    profile_label: account.existingCustomer ? 'Additional property' : 'Primary',
    first_name: lead.first_name || '',
    last_name: lead.last_name || '',
    phone: lead.phone || '',
    email: lead.email || null,
    address_line1: address.line1 || '',
    address_line2: address.line2 || null,
    city: address.city || '',
    state: address.state || 'FL',
    zip: address.zip || '',
    latitude: location?.lat ?? null,
    longitude: location?.lng ?? null,
    lead_source: 'lead_pipeline',
    pipeline_stage: 'new_lead',
    pipeline_stage_changed_at: new Date(),
  }).returning('*');
  await createDefaultCustomerRows(db, created.id);
  return created;
}

router.get('/:token', async (req, res, next) => {
  if (!leadInspectionLinkLive()) return res.status(404).json({ error: 'not_found' });
  const verified = verifyLeadConsultationToken(req.params.token);
  if (!verified) {
    return verifyIgnoringExpiry(req.params.token)
      ? res.json({ state: 'expired' })
      : res.status(404).json({ error: 'not_found' });
  }

  try {
    const lead = await loadLead(verified.leadId);
    if (!lead) return res.json({ state: 'gone' });

    const custRow = lead.customer_id ? await loadCustomer(lead.customer_id) : null;
    const hasAddress = !!(custRow?.address_line1 || lead.address);
    const addressDisp = custRow?.address_line1
      ? addressDisplay({ line1: custRow.address_line1, city: custRow.city, zip: custRow.zip })
      : (lead.address ? addressDisplay({ line1: lead.address, city: lead.city, zip: lead.zip }) : null);
    const leadPayload = {
      first_name: lead.first_name || null,
      phone_masked: maskPhone(lead.phone),
      has_address: hasAddress,
      address_display: addressDisp,
    };

    if (custRow) {
      const openAssessment = await findOpenVisit(custRow.id, { assessmentOnly: true });
      if (openAssessment) {
        return res.json({
          state: 'already_booked',
          lead: leadPayload,
          visit: visitShape(openAssessment),
          rescheduleUrl: await rescheduleUrlFor(openAssessment.id),
        });
      }
    }
    // 'converted' fires on the lead's own converted_at even without a
    // resolvable customer row (a converted lead should always have one, but
    // this must not silently fall through to 'ok' if that row is ever
    // missing) — the future-visit lookup itself still needs the customer.
    if (lead.converted_at || custRow) {
      const futureOtherVisit = custRow
        ? await findOpenVisit(custRow.id, { excludeAssessment: true, futureOnly: true })
        : null;
      if (lead.converted_at || futureOtherVisit) {
        return res.json({
          state: 'converted',
          lead: leadPayload,
          visit: futureOtherVisit ? visitShape(futureOtherVisit) : null,
          rescheduleUrl: futureOtherVisit ? await rescheduleUrlFor(futureOtherVisit.id) : null,
        });
      }
    }

    const coords = await resolveCoords(lead, custRow);
    const booking = require('./booking');
    const config = await booking._internals.loadBookingConfig();
    const range = bookingRange(config);
    const catalog = await loadAssessmentCatalog();

    let availability = null;
    if (coords) {
      try {
        const built = await buildAvailabilityForLead(coords, { ...range, config, duration: catalog.durationMinutes });
        availability = built ? shapeAvailability(built, range) : null;
      } catch (err) {
        logger.error(`[inspection-public] availability failed for lead ${lead.id}: ${err.message}`);
      }
    }

    return res.json({
      state: 'ok',
      lead: leadPayload,
      availability,
      needs_address: !coords,
      selfServeNotice: true,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:token/availability', findSlotsLimiter, async (req, res, next) => {
  if (!leadInspectionLinkLive()) return res.status(404).json({ error: 'not_found' });
  const addressInput = typeof req.body?.address === 'string' ? req.body.address.trim() : '';
  if (!addressInput) return res.status(400).json({ error: 'address required' });
  const verified = verifyLeadConsultationToken(req.params.token);
  if (!verified) return res.status(404).json({ error: 'not_found' });

  try {
    const lead = await loadLead(verified.leadId);
    if (!lead) return res.status(404).json({ error: 'not_found' });

    const area = await checkServiceArea(addressInput);
    if (!area.ok) return res.status(422).json({ error: 'out_of_area', county: area.county || null });

    const booking = require('./booking');
    const config = await booking._internals.loadBookingConfig();
    const range = bookingRange(config);
    const catalog = await loadAssessmentCatalog();
    let availability = null;
    try {
      const built = await buildAvailabilityForLead(area.location, { ...range, config, duration: catalog.durationMinutes });
      availability = built ? shapeAvailability(built, range) : null;
    } catch (err) {
      logger.error(`[inspection-public] address availability failed for lead ${lead.id}: ${err.message}`);
    }
    return res.json({ availability, needs_address: false });
  } catch (err) {
    next(err);
  }
});

router.post('/:token/find-slots', findSlotsLimiter, async (req, res, next) => {
  if (!leadInspectionLinkLive()) return res.status(404).json({ error: 'not_found' });
  const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
  if (!query) return res.status(400).json({ error: 'query required' });
  if (query.length > 500) return res.status(400).json({ error: 'query too long' });
  const verified = verifyLeadConsultationToken(req.params.token);
  if (!verified) return res.status(404).json({ error: 'not_found' });

  try {
    const lead = await loadLead(verified.leadId);
    if (!lead) return res.status(404).json({ error: 'not_found' });
    const custRow = lead.customer_id ? await loadCustomer(lead.customer_id) : null;
    const coords = await resolveCoords(lead, custRow);
    if (!coords) return res.status(400).json({ error: 'An address is needed before we can search for times.' });

    const booking = require('./booking');
    const config = await booking._internals.loadBookingConfig();
    const range = bookingRange(config);
    const catalog = await loadAssessmentCatalog();

    const { parseWhen, summarizeWindow } = require('../services/scheduling/parse-when');
    const when = await parseWhen(query, searchParseOpts(config));

    let availability = null;
    try {
      availability = await buildAvailabilityForLead(coords, {
        rangeFrom: when.dateFrom, rangeTo: when.dateTo, config,
        duration: catalog.durationMinutes, timeOfDay: when.timeOfDay,
      });
    } catch (err) {
      logger.error(`[inspection-public] find-slots availability failed for lead ${lead.id}: ${err.message}`);
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
      availability: shapeAvailability(availability, range),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:token', commitLimiter, async (req, res, next) => {
  if (!leadInspectionLinkLive()) return res.status(404).json({ error: 'not_found' });

  const date = typeof req.body?.date === 'string' ? req.body.date.trim() : '';
  const time = typeof req.body?.time === 'string' ? req.body.time.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):00$/.test(time)) {
    return res.status(400).json({ error: 'date (YYYY-MM-DD) and time (HH:00) required' });
  }
  const addressInput = typeof req.body?.address === 'string' ? req.body.address.trim() : '';
  const notes = typeof req.body?.notes === 'string'
    ? req.body.notes.trim().slice(0, MAX_NOTES_LENGTH)
    : '';

  const verified = verifyLeadConsultationToken(req.params.token);
  if (!verified) return res.status(404).json({ error: 'not_found' });

  try {
    const lead = await loadLead(verified.leadId);
    if (!lead) return res.status(404).json({ error: 'not_found' });

    let custRow = lead.customer_id ? await loadCustomer(lead.customer_id) : null;

    // Idempotent replay: an already-open assessment short-circuits before
    // geocoding or creating anything — a second commit (any date/time) must
    // never mint a second visit.
    if (custRow) {
      const existingAssessment = await findOpenVisit(custRow.id, { assessmentOnly: true });
      if (existingAssessment) {
        return res.json({
          state: 'already_booked',
          code: 'ALREADY_BOOKED',
          error: 'You already have a consultation on the books.',
          visit: visitShape(existingAssessment),
          rescheduleUrl: await rescheduleUrlFor(existingAssessment.id),
        });
      }
    }

    const hasStoredAddress = !!(custRow?.address_line1 || lead.address);
    let address;
    if (hasStoredAddress) {
      address = custRow?.address_line1
        ? { line1: custRow.address_line1, line2: custRow.address_line2, city: custRow.city, state: custRow.state || 'FL', zip: custRow.zip }
        : { line1: lead.address, line2: null, city: lead.city, state: 'FL', zip: lead.zip };
    } else {
      if (!addressInput) return res.status(400).json({ error: 'address required' });
      const parsed = parseRawAddress(addressInput);
      address = {
        line1: parsed.line1 || addressInput,
        line2: null,
        city: parsed.city || null,
        state: parsed.state || 'FL',
        zip: parsed.zip || null,
      };
    }
    const addressStr = [address.line1, address.city, address.state, address.zip].filter(Boolean).join(', ');
    const area = await checkServiceArea(addressStr);
    if (!area.ok) return res.status(422).json({ error: 'out_of_area', county: area.county || null });

    const booking = require('./booking');
    const config = await booking._internals.loadBookingConfig();
    const range = bookingRange(config);
    if (date < range.rangeFrom || date > range.rangeTo) {
      return res.status(400).json({ error: 'That date is outside the online scheduling window.' });
    }
    const catalog = await loadAssessmentCatalog();
    if (!catalog.serviceId) {
      return res.status(503).json({ error: 'Booking is temporarily unavailable — please text or call us.' });
    }

    // Anti-forgery: re-validate against a fresh single-day availability
    // build at the CATALOG's real duration (reservice-public's model).
    const dayAvailability = await buildAvailabilityForLead(area.location, {
      rangeFrom: date, rangeTo: date, config, duration: catalog.durationMinutes,
    });
    const day = dayAvailability?.days?.find((d) => d.date === date);
    const slot = day?.slots?.find((s) => s.start_time === time);
    if (!slot) {
      let refreshed = null;
      try {
        refreshed = await buildAvailabilityForLead(area.location, { ...range, config, duration: catalog.durationMinutes });
      } catch (err) {
        logger.warn(`[inspection-public] refresh availability failed for lead ${lead.id}: ${err.message}`);
      }
      return res.status(409).json({
        error: 'That time is no longer open. Here are the latest available times.',
        code: 'SLOT_TAKEN',
        availability: refreshed ? shapeAvailability(refreshed, range) : null,
      });
    }

    if (!custRow) {
      custRow = await createCustomerForLead(lead, address, area.location);
      await db('leads').where({ id: lead.id }).update({ customer_id: custRow.id, updated_at: new Date() });
    }

    const { createSelfBooking } = booking._internals;
    const result = await createSelfBooking({
      slot_date: date,
      slot_start: slot.start_time,
      slot_end: slot.end_time,
      technician_id: slot.technician_id || null,
      // The customer-VISIBLE `notes` column stays generic — the free-text
      // note rides internal_notes below (never customer/tech visible notes).
      customer_notes: null,
      source: 'inspection_link',
      // Server-resolved trust context — the token proved the lead's identity.
      authedCustomer: custRow,
      payAtVisit: false,
      customersOnly: false,
      callbackVisit: {
        serviceKey: ASSESSMENT_SERVICE_KEY,
        serviceId: catalog.serviceId,
        serviceType: catalog.serviceType,
        durationMinutes: catalog.durationMinutes,
        // Not a re-service warranty callback, and not a pest/lawn re-service
        // lane — see booking.js's callbackVisit contract.
        isCallback: false,
        dedupeLane: false,
        alertLabel: '🔁 Free consultation self-booked:',
      },
    });

    if (!result.ok) {
      if (result.status === 409) {
        let refreshed = null;
        try {
          refreshed = await buildAvailabilityForLead(area.location, { ...range, config, duration: catalog.durationMinutes });
        } catch { /* answer without the refresh */ }
        return res.status(409).json({
          error: result.error,
          code: 'SLOT_TAKEN',
          availability: refreshed ? shapeAvailability(refreshed, range) : null,
        });
      }
      return res.status(result.status || 500).json({ error: result.error });
    }

    let rescheduleUrl = null;
    let scheduledServiceId = null;
    try {
      const serviceRow = await db('scheduled_services')
        .where({ self_booking_id: result.body?.booking?.id })
        .first('id', 'reschedule_token');
      scheduledServiceId = serviceRow?.id || null;
      if (serviceRow?.reschedule_token) rescheduleUrl = `/reschedule/${serviceRow.reschedule_token}`;
    } catch (err) {
      logger.warn(`[inspection-public] reschedule-link lookup failed for booking ${result.body?.booking?.id}: ${err.message}`);
    }

    if (notes && scheduledServiceId) {
      try {
        await db('scheduled_services').where({ id: scheduledServiceId }).update({ internal_notes: notes });
      } catch (err) {
        logger.warn(`[inspection-public] internal_notes write failed for ${scheduledServiceId}: ${err.message}`);
      }
    }

    return res.json({
      success: true,
      state: 'ok',
      replayed: !!result.body?.replayed,
      visit: { date, window: { start: slot.start_time, end: slot.end_time } },
      startLabel: slot.start_label,
      endLabel: slot.end_label,
      rescheduleUrl,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:token/waitlist', findSlotsLimiter, async (req, res, next) => {
  if (!leadInspectionLinkLive()) return res.status(404).json({ error: 'not_found' });
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email is required' });
  }
  const verified = verifyLeadConsultationToken(req.params.token);
  if (!verified) return res.status(404).json({ error: 'not_found' });

  try {
    const lead = await loadLead(verified.leadId);
    if (!lead) return res.status(404).json({ error: 'not_found' });
    const county = typeof req.body?.county === 'string' ? req.body.county.trim() : '';

    await db('newsletter_subscribers')
      .insert({
        email,
        source: `expansion_waitlist:${county || 'unknown'}`,
        status: 'active',
        subscribed_at: new Date(),
      })
      .onConflict('email')
      .ignore();

    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router._test = {
  verifyIgnoringExpiry,
  maskPhone,
  addressDisplay,
  bookingRange,
  searchParseOpts,
  loadAssessmentCatalog,
  resolveCoords,
  checkServiceArea,
  findOpenVisit,
  buildAvailabilityForLead,
};

module.exports = router;
