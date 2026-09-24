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
 * `=== 'true'`, read at call time) — every route 404s while off. The gate
 * check is the router's FIRST middleware, ahead of every rate limiter, so a
 * probe hammering the dark route always sees a uniform 404 and never a
 * revealing 429 (Codex pre-push P0, 2026-09-24) — the per-handler checks
 * below are kept too, as a second line of defense for anything that ever
 * calls a handler directly.
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
 *   before showing times. `resolveEligibility` (the already_booked/converted/
 *   gone logic) and `resolveServiceAddress` (the address resolution) are
 *   shared with the commit path below, so both GET and POST answer from the
 *   exact same rules — see each function's own comment.
 *
 * POST /:token/availability — address-first availability for a lead with no
 *   address on file yet (or whose stored one won't resolve). Same out-of-area
 *   stop as the commit, and the same address_unresolved/out_of_area split
 *   (a geocode failure is recoverable — the form stays up — an actually-
 *   resolved location outside the service area is not). Does not persist
 *   anything — the address is stored only when the visit actually books.
 *
 * POST /:token/find-slots — the same natural-language search reservice uses,
 *   plus an optional `address` field for a lead with none on file yet (the
 *   address gate may not have resolved one into `needs_address:false` before
 *   the customer tries the AI search box).
 *
 * POST /:token — commit. Idempotent: a lead whose customer already holds an
 *   open assessment short-circuits to the same `already_booked` shape (200)
 *   instead of a second visit — checked BEFORE geocoding/creating anything,
 *   and AGAIN under a per-lead advisory lock right before booking (below) so
 *   two concurrent commits can't both pass the pre-lock check and both book.
 *   Address resolution (`resolveServiceAddress`) prefers the stored address
 *   (customer row, then the lead's own fields) but falls through to a
 *   supplied one whenever the stored address is missing OR fails to geocode
 *   — never the reverse. A resolved address that isn't the customer's own
 *   on-file one is written back onto the customer row before booking, so a
 *   fixed-up address isn't asked for again next time. geocode failure /
 *   unparseable input → 422 `address_unresolved` (recoverable — the client
 *   keeps the address form up); an actually-resolved location outside the
 *   service area → 422 `out_of_area` (the client stops on the waitlist
 *   card). Either way nothing books. The slot is re-validated against a
 *   fresh single-day availability build (anti-forgery, matching
 *   reservice-public). Booking goes through booking.js's createSelfBooking
 *   with the internal-only `callbackVisit` option — `isCallback: false` and
 *   `dedupeLane: false` (see booking.js: this is a free internal booking
 *   like a re-service callback in every way that matters for skipping the
 *   funnel's signed-offer/card-capture/ad-attribution/customer-promotion
 *   machinery, but it is NOT a re-service warranty callback, so it must not
 *   set is_callback or take the reservice-lane dedupe, which is keyed to
 *   pest/lawn re-service lanes and would false-hit on an unrelated open
 *   re-service). createSelfBooking's own dedupe (dedupeLane:false) only
 *   catches an exact repeat customer/date/time — it does NOT catch two
 *   different slots for the same lead, so the customer-provisioning +
 *   eligibility re-check + booking sequence below runs under a per-lead
 *   `pg_advisory_xact_lock` (Codex pre-push P1, 2026-09-24; key convention
 *   matches admin-agents.js/admin-dashboard.js's single-hashtext-arg form).
 *   It's two short lock acquisitions on the SAME key rather than one held
 *   transaction spanning the whole thing: createSelfBooking opens its OWN
 *   transaction on a SEPARATE pooled connection and does a fresh customer
 *   re-read there, so a customer row (or address update) created/held
 *   uncommitted inside our lock transaction would make that fresh read
 *   block on our own open transaction's FK check — a guaranteed deadlock
 *   with two transactions each waiting on the other. Phase 1 (lock →
 *   re-read the lead fresh → re-run eligibility → provision the customer →
 *   COMMIT, releasing the lock) makes the customer row a durable, visible
 *   fact before anything calls createSelfBooking. Phase 2 (lock, same key,
 *   held through the createSelfBooking call → commits after) re-runs
 *   eligibility once more and is what actually closes the double-assessment
 *   race: a second commit blocked on phase 2's lock only proceeds once the
 *   first's booking has fully committed, so its own re-check sees it. The
 *   lead gets (or keeps) a customer row and is linked (`leads.customer_id`)
 *   but nothing else on the lead changes — status/pipeline_stage/
 *   converted_at/member_since all stay untouched, matching
 *   promoteCustomerOnBooking's own isAssessmentServiceType guard and
 *   admin-leads.js's identical assessment posture. The free-text note rides
 *   `scheduled_services.internal_notes` (never `notes`, which is
 *   customer/tech visible) via a best-effort post-commit update, same
 *   posture as reservice-public's reschedule-link lookup. Office alert:
 *   booking.js's internal alert with `alertLabel` swapped to "🔁 Free
 *   consultation self-booked:" — no other customer comms beyond
 *   createSelfBooking's own standard confirmation.
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

// Per-lead advisory-lock namespace for the commit's provisioning/booking
// critical section (see the file header and the commit handler below).
const COMMIT_LOCK_NS = 'inspection_commit';

// Dark-gate check FIRST — before noStore and every rate limiter below, so a
// prober hammering this route while GATE_LEAD_INSPECTION_LINK is off always
// gets a uniform 404, never a 429 that would reveal a rate-limited (and
// therefore real) route (Codex pre-push P0, 2026-09-24).
router.use((req, res, next) => {
  if (!leadInspectionLinkLive()) return res.status(404).json({ error: 'not_found' });
  next();
});

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

// The lead-facing identity payload every state shape carries — factored out
// so GET and the commit's eligibility short-circuits (which answer the same
// shapes GET does) can't drift from each other.
function buildLeadPayload(lead, custRow) {
  const hasAddress = !!(custRow?.address_line1 || lead.address);
  const addressDisp = custRow?.address_line1
    ? addressDisplay({ line1: custRow.address_line1, city: custRow.city, zip: custRow.zip })
    : (lead.address ? addressDisplay({ line1: lead.address, city: lead.city, zip: lead.zip }) : null);
  return {
    first_name: lead.first_name || null,
    phone_masked: maskPhone(lead.phone),
    has_address: hasAddress,
    address_display: addressDisp,
  };
}

async function loadLead(dbConn, leadId) {
  return dbConn('leads').where({ id: leadId }).whereNull('deleted_at').first(
    'id', 'first_name', 'last_name', 'phone', 'email', 'address', 'city', 'zip',
    'status', 'customer_id', 'converted_at'
  );
}

async function loadCustomer(dbConn, customerId) {
  return dbConn('customers').where({ id: customerId }).whereNull('deleted_at').first(
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

// Single address-resolution authority for this whole route family (GET,
// /availability, /find-slots, and the commit): tries the linked customer's
// stored COORDS first (no geocode needed), then its address TEXT, then
// (only when the customer has no address of its own) the lead's own raw
// fields, and only falls through to a caller-SUPPLIED address string when
// none of the stored options resolve. A stored address that merely fails to
// geocode is treated exactly like a missing one — it must never win over a
// supplied address just because it's non-empty (Codex pre-push P1,
// 2026-09-24: the earlier version let stored PRESENCE alone block a
// supplied address, so a customer whose on-file address had gone stale
// could never book by typing a fresh one).
//
// Returns { location: {lat,lng}|null, address: {line1,line2,city,state,zip}|null,
// source: 'customer'|'lead'|'supplied'|null, unresolved: boolean }. `unresolved`
// is true when SOME address text existed (stored or supplied) but none of it
// geocoded — callers answer that 422 `address_unresolved` (recoverable: the
// client keeps the address form up with an inline message), never
// `out_of_area` (reserved for an actually-RESOLVED location outside the
// service county/box — see checkServiceArea, which takes a location, not
// address text, for exactly this reason).
async function resolveServiceAddress(lead, custRow, suppliedAddress) {
  if (custRow?.latitude != null && custRow?.longitude != null) {
    return {
      location: { lat: parseFloat(custRow.latitude), lng: parseFloat(custRow.longitude) },
      address: {
        line1: custRow.address_line1 || null, line2: custRow.address_line2 || null,
        city: custRow.city || null, state: custRow.state || 'FL', zip: custRow.zip || null,
      },
      source: 'customer',
      unresolved: false,
    };
  }

  let anyAddressText = false;
  async function tryGeocode(address) {
    const addressStr = [address.line1, address.city, address.state, address.zip].filter(Boolean).join(', ');
    if (!addressStr) return null;
    anyAddressText = true;
    try {
      const { location } = await geocodeAddressWithStatus(addressStr, { serviceAddress: true });
      return location || null;
    } catch (err) {
      logger.warn(`[inspection-public] address geocode failed: ${err.message}`);
      return null;
    }
  }

  if (custRow?.address_line1) {
    const address = {
      line1: custRow.address_line1, line2: custRow.address_line2 || null,
      city: custRow.city || null, state: custRow.state || 'FL', zip: custRow.zip || null,
    };
    const location = await tryGeocode(address);
    if (location) return { location, address, source: 'customer', unresolved: false };
  }

  if (lead.address) {
    const address = { line1: lead.address, line2: null, city: lead.city || null, state: 'FL', zip: lead.zip || null };
    const location = await tryGeocode(address);
    if (location) return { location, address, source: 'lead', unresolved: false };
  }

  const suppliedInput = typeof suppliedAddress === 'string' ? suppliedAddress.trim() : '';
  if (suppliedInput) {
    const parsed = parseRawAddress(suppliedInput);
    const address = {
      line1: parsed.line1 || suppliedInput, line2: null,
      city: parsed.city || null, state: parsed.state || 'FL', zip: parsed.zip || null,
    };
    const location = await tryGeocode(address);
    if (location) return { location, address, source: 'supplied', unresolved: false };
  }

  return { location: null, address: null, source: null, unresolved: anyAddressText };
}

// County/box verdict for an ALREADY-RESOLVED location — reverse-geocodes the
// county when a Google key is configured (authoritative — SERVICE_AREA_COUNTIES),
// else trusts the box test the geocoder itself already enforced via
// serviceAddress:true (any location resolveServiceAddress returned already
// passed it). Takes a location, never raw address text, so a geocode
// failure upstream can never be conflated with "resolved but out of area."
async function checkServiceArea(location) {
  if (!location) return { ok: false, county: null };
  const key = process.env.GOOGLE_API_KEY || process.env.GOOGLE_MAPS_API_KEY;
  let county = null;
  if (key) {
    try {
      county = await reverseGeocodeCounty({ latitude: location.lat, longitude: location.lng }, key);
    } catch (err) {
      logger.warn(`[inspection-public] county reverse-geocode failed: ${err.message}`);
    }
  }
  if (county) return { ok: isInServiceAreaCounty(county), county };
  return { ok: true, county: null };
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
// Takes an explicit `dbConn` (plain `db` or a `trx`) so the commit path can
// re-run this exact query under its advisory lock.
async function findOpenVisit(dbConn, customerId, { assessmentOnly = false, excludeAssessment = false, futureOnly = false } = {}) {
  let q = dbConn('scheduled_services')
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

// The one already_booked/converted/gone/ok predicate — GET's own state
// logic, factored out so the commit path can re-run the EXACT same check
// (first as a cheap pre-lock fast path, then again under the per-lead
// advisory lock) without the two ever drifting apart. `dbConn` lets the
// commit path run this against a `trx` for the lock-protected re-checks.
async function resolveEligibility(dbConn, lead, custRow) {
  if (custRow) {
    const openAssessment = await findOpenVisit(dbConn, custRow.id, { assessmentOnly: true });
    if (openAssessment) {
      return { state: 'already_booked', visit: openAssessment, rescheduleUrl: await rescheduleUrlFor(openAssessment.id) };
    }
  }
  // 'converted' fires on the lead's own converted_at even without a
  // resolvable customer row (a converted lead should always have one, but
  // this must not silently fall through to 'ok' if that row is ever
  // missing) — the future-visit lookup itself still needs the customer.
  if (lead.converted_at || custRow) {
    const futureOtherVisit = custRow
      ? await findOpenVisit(dbConn, custRow.id, { excludeAssessment: true, futureOnly: true })
      : null;
    if (lead.converted_at || futureOtherVisit) {
      return { state: 'converted', visit: futureOtherVisit || null, rescheduleUrl: futureOtherVisit ? await rescheduleUrlFor(futureOtherVisit.id) : null };
    }
  }
  return { state: 'ok', visit: null, rescheduleUrl: null };
}

// Shapes a non-'ok' resolveEligibility result into the response body — the
// SAME shape GET returns for already_booked/converted, so the commit's
// short-circuits (pre-lock fast path, and the lock-protected re-checks) are
// indistinguishable from a GET reload for the client.
function eligibilityResponse(eligibility, leadPayload) {
  const base = {
    state: eligibility.state,
    lead: leadPayload,
    visit: eligibility.visit ? visitShape(eligibility.visit) : null,
    rescheduleUrl: eligibility.rescheduleUrl || null,
  };
  if (eligibility.state === 'already_booked') {
    return { ...base, code: 'ALREADY_BOOKED', error: 'You already have a consultation on the books.' };
  }
  return base;
}

// Minimal customer provisioning from a lead's own contact fields — same
// shape as lead-webhook.js's new-customer branch, but an assessment
// provisions a PROSPECT: no member_since, pipeline_stage stays 'new_lead'
// (matches admin-leads.js's identical assessmentVisit carve-out and
// promoteCustomerOnBooking's own isAssessmentServiceType guard). Takes an
// explicit `dbConn` so the commit path can run this inside its phase-1 lock
// transaction (committed before phase 2 ever calls createSelfBooking — see
// the file header).
async function createCustomerForLead(dbConn, lead, address, location) {
  const { ensureCustomerAccount } = require('./admin-customers');
  const { createDefaultCustomerRows } = require('../services/customer-default-rows');
  const account = await ensureCustomerAccount(dbConn, {
    firstName: lead.first_name || 'New Lead',
    lastName: lead.last_name || '',
    phone: lead.phone || '',
    email: lead.email || null,
  });
  const [created] = await dbConn('customers').insert({
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
  await createDefaultCustomerRows(dbConn, created.id);
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
    const lead = await loadLead(db, verified.leadId);
    if (!lead) return res.json({ state: 'gone' });

    const custRow = lead.customer_id ? await loadCustomer(db, lead.customer_id) : null;
    const leadPayload = buildLeadPayload(lead, custRow);

    const eligibility = await resolveEligibility(db, lead, custRow);
    if (eligibility.state !== 'ok') {
      return res.json(eligibilityResponse(eligibility, leadPayload));
    }

    const resolved = await resolveServiceAddress(lead, custRow, null);
    const booking = require('./booking');
    const config = await booking._internals.loadBookingConfig();
    const range = bookingRange(config);
    const catalog = await loadAssessmentCatalog();

    let availability = null;
    if (resolved.location) {
      try {
        const built = await buildAvailabilityForLead(resolved.location, { ...range, config, duration: catalog.durationMinutes });
        availability = built ? shapeAvailability(built, range) : null;
      } catch (err) {
        logger.error(`[inspection-public] availability failed for lead ${lead.id}: ${err.message}`);
      }
    }

    return res.json({
      state: 'ok',
      lead: leadPayload,
      availability,
      needs_address: !resolved.location,
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
    const lead = await loadLead(db, verified.leadId);
    if (!lead) return res.status(404).json({ error: 'not_found' });
    const custRow = lead.customer_id ? await loadCustomer(db, lead.customer_id) : null;

    const resolved = await resolveServiceAddress(lead, custRow, addressInput);
    if (!resolved.location) {
      return res.status(422).json({ error: 'address_unresolved' });
    }
    const area = await checkServiceArea(resolved.location);
    if (!area.ok) return res.status(422).json({ error: 'out_of_area', county: area.county || null });

    const booking = require('./booking');
    const config = await booking._internals.loadBookingConfig();
    const range = bookingRange(config);
    const catalog = await loadAssessmentCatalog();
    let availability = null;
    try {
      const built = await buildAvailabilityForLead(resolved.location, { ...range, config, duration: catalog.durationMinutes });
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
  const addressInput = typeof req.body?.address === 'string' ? req.body.address.trim() : '';
  const verified = verifyLeadConsultationToken(req.params.token);
  if (!verified) return res.status(404).json({ error: 'not_found' });

  try {
    const lead = await loadLead(db, verified.leadId);
    if (!lead) return res.status(404).json({ error: 'not_found' });
    const custRow = lead.customer_id ? await loadCustomer(db, lead.customer_id) : null;
    const resolved = await resolveServiceAddress(lead, custRow, addressInput);
    if (!resolved.location) {
      return res.status(400).json({
        error: resolved.unresolved
          ? "We couldn't find that address. Please check it and try again."
          : 'An address is needed before we can search for times.',
      });
    }

    const booking = require('./booking');
    const config = await booking._internals.loadBookingConfig();
    const range = bookingRange(config);
    const catalog = await loadAssessmentCatalog();

    const { parseWhen, summarizeWindow } = require('../services/scheduling/parse-when');
    const when = await parseWhen(query, searchParseOpts(config));

    let availability = null;
    try {
      availability = await buildAvailabilityForLead(resolved.location, {
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
    const lead = await loadLead(db, verified.leadId);
    if (!lead) return res.status(404).json({ error: 'not_found' });

    let custRow = lead.customer_id ? await loadCustomer(db, lead.customer_id) : null;
    const leadPayload = buildLeadPayload(lead, custRow);

    // Cheap pre-lock fast path: an obviously-ineligible lead (an existing
    // assessment from a previous commit, a converted lead) never needs to
    // geocode, check the service area, or take the lock at all. NOT
    // authoritative on its own — the lock-protected re-checks in phase 1/2
    // below are what actually closes the concurrent-commit race.
    const preCheck = await resolveEligibility(db, lead, custRow);
    if (preCheck.state !== 'ok') {
      return res.json(eligibilityResponse(preCheck, leadPayload));
    }

    const resolved = await resolveServiceAddress(lead, custRow, addressInput);
    if (!resolved.location) {
      if (resolved.unresolved) return res.status(422).json({ error: 'address_unresolved' });
      return res.status(400).json({ error: 'address required' });
    }
    const area = await checkServiceArea(resolved.location);
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
    const dayAvailability = await buildAvailabilityForLead(resolved.location, {
      rangeFrom: date, rangeTo: date, config, duration: catalog.durationMinutes,
    });
    const day = dayAvailability?.days?.find((d) => d.date === date);
    const slot = day?.slots?.find((s) => s.start_time === time);
    if (!slot) {
      let refreshed = null;
      try {
        refreshed = await buildAvailabilityForLead(resolved.location, { ...range, config, duration: catalog.durationMinutes });
      } catch (err) {
        logger.warn(`[inspection-public] refresh availability failed for lead ${lead.id}: ${err.message}`);
      }
      return res.status(409).json({
        error: 'That time is no longer open. Here are the latest available times.',
        code: 'SLOT_TAKEN',
        availability: refreshed ? shapeAvailability(refreshed, range) : null,
      });
    }

    // Phase 1 — lock, re-read the lead's customer_id FRESH (a concurrent
    // commit's phase 1 may have just linked one), re-run eligibility, then
    // provision the customer (create for an unlinked lead, or fix up an
    // addressless/unresolvable one) INSIDE this transaction so it's a
    // committed fact — never left open across the createSelfBooking call in
    // phase 2, which reloads the customer on a separate connection (see the
    // file header for why that would deadlock).
    const phase1 = await db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`${COMMIT_LOCK_NS}:${lead.id}`]);

      const freshLead = await loadLead(trx, lead.id);
      if (!freshLead) return { eligibility: { state: 'gone', visit: null, rescheduleUrl: null } };
      const freshCustRow = freshLead.customer_id ? await loadCustomer(trx, freshLead.customer_id) : null;

      const eligibility = await resolveEligibility(trx, freshLead, freshCustRow);
      if (eligibility.state !== 'ok') return { eligibility };

      let provisioned = freshCustRow;
      if (!freshCustRow) {
        provisioned = await createCustomerForLead(trx, lead, resolved.address, resolved.location);
        await trx('leads').where({ id: lead.id }).update({ customer_id: provisioned.id, updated_at: new Date() });
      } else if (resolved.source !== 'customer') {
        // The customer's own stored address wasn't what resolved (missing or
        // unresolvable) — write back the address that DID resolve so this
        // lead's next load (or commit) doesn't need the address gate again.
        await trx('customers').where({ id: freshCustRow.id }).update({
          address_line1: resolved.address.line1,
          address_line2: resolved.address.line2,
          city: resolved.address.city,
          state: resolved.address.state,
          zip: resolved.address.zip,
          latitude: resolved.location.lat,
          longitude: resolved.location.lng,
          updated_at: new Date(),
        });
        provisioned = {
          ...freshCustRow,
          address_line1: resolved.address.line1, address_line2: resolved.address.line2,
          city: resolved.address.city, state: resolved.address.state, zip: resolved.address.zip,
          latitude: resolved.location.lat, longitude: resolved.location.lng,
        };
      }
      return { custRow: provisioned };
    });

    if (phase1.eligibility) {
      return res.json(eligibilityResponse(phase1.eligibility, leadPayload));
    }
    custRow = phase1.custRow;

    // Phase 2 — re-acquire the SAME per-lead lock, held through the whole
    // createSelfBooking call. A second commit blocked here only proceeds
    // once THIS one's booking has fully committed, so its own re-check
    // (also inside this function) sees it and short-circuits instead of
    // creating a second assessment.
    const phase2 = await db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`${COMMIT_LOCK_NS}:${lead.id}`]);

      const eligibility = await resolveEligibility(trx, lead, custRow);
      if (eligibility.state !== 'ok') return { eligibility };

      const { createSelfBooking } = booking._internals;
      const bookingResult = await createSelfBooking({
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
      return { result: bookingResult };
    });

    if (phase2.eligibility) {
      return res.json(eligibilityResponse(phase2.eligibility, leadPayload));
    }
    const result = phase2.result;

    if (!result.ok) {
      if (result.status === 409) {
        let refreshed = null;
        try {
          refreshed = await buildAvailabilityForLead(resolved.location, { ...range, config, duration: catalog.durationMinutes });
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
    const lead = await loadLead(db, verified.leadId);
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
  buildLeadPayload,
  bookingRange,
  searchParseOpts,
  loadAssessmentCatalog,
  resolveServiceAddress,
  checkServiceArea,
  findOpenVisit,
  resolveEligibility,
  buildAvailabilityForLead,
  COMMIT_LOCK_NS,
};

module.exports = router;
