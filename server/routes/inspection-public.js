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
 *   fixed-up address isn't asked for again next time. Street-level quality
 *   filtering (no ZIP/city centroids, no partial matches) always applies,
 *   but the geocode itself no longer discards a result for being outside
 *   the service box (`requireInServiceArea: false` — geocoder.js) — that
 *   determination belongs to `checkServiceArea` alone (below), so a
 *   genuinely out-of-box address answers `out_of_area`, never the
 *   misleading `address_unresolved` a swallowed box-reject used to produce
 *   (Codex pre-push P1, 2026-09-24). geocode failure / unparseable input →
 *   422 `address_unresolved` (recoverable — the client keeps the address
 *   form up); an actually-resolved location outside the service area → 422
 *   `out_of_area` (the client stops on the waitlist card); the service-area
 *   check itself unavailable (a Google key is configured but the reverse-
 *   geocode came back empty — provider timeout/outage, never silently
 *   treated as "fine") → 503 `service_area_unavailable` (recoverable — the
 *   client keeps the form up with a "try again" message). Either way
 *   nothing books. checkServiceArea applies uniformly to every resolved
 *   location, including a customer's STORED coordinates, which otherwise
 *   never pass through the geocoder's own box test at all (the short-circuit
 *   branch in resolveServiceAddress returns them directly).
 *
 *   Phase 1 (lock on a per-lead key → re-read the lead fresh → re-run
 *   eligibility → provision the customer, re-resolving the address against
 *   the FRESH customer row so a second concurrent commit can never
 *   overwrite the first's just-persisted address with its own stale
 *   supplied one → re-validate the picked SLOT if the address changed,
 *   keeping the matched slot object (technician/end_time can differ at a
 *   different location, not just the start_time — Codex pre-push P1,
 *   2026-09-24) → COMMIT, releasing the lock) makes the customer row a
 *   durable, visible fact, and the slot correct, before anything calls
 *   createSelfBooking. If the fresh re-resolve itself FAILS (geocoder
 *   error/timeout — distinct from "another commit's address won"): a
 *   customer row that's STILL addressless is safe to persist the pre-lock
 *   VALIDATED address onto (nothing stored to conflict with); a customer
 *   row that already has a DIFFERENT stored address we simply couldn't
 *   re-resolve this attempt is never touched and never combined with the
 *   pre-lock location — that pairing is exactly what would let
 *   createSelfBooking's fresh reload dispatch to whatever's actually
 *   stored while the slot was validated for a different address (Codex
 *   pre-push P1, 2026-09-24) — the commit answers 422 `address_unresolved`
 *   instead, recoverable, no booking, no customer update. (key convention
 *   matches admin-agents.js/admin-
 *   dashboard.js's single-hashtext-arg form).
 *
 *   Booking itself goes through booking.js's createSelfBooking with the
 *   internal-only `callbackVisit` option — `isCallback: false` (this is NOT
 *   a re-service warranty callback) and `dedupeLane` left at its TRUE
 *   DEFAULT (Codex pre-push P1, 2026-09-24 — round 4 disabled it here,
 *   fearing a false-hit on an unrelated pest/lawn re-service; round 5 fixes
 *   that at the source instead of opting out of the mechanism entirely):
 *   services/reservice-scheduler.js's `laneForCallbackRow` now classifies
 *   ASSESSMENT_SERVICE_KEY as its own `'assessment'` lane — checked BEFORE
 *   the pest/lawn cases, so an assessment row can never fall through to the
 *   pest default — and `openCallbackExistsForLane`'s query was widened to
 *   also match rows on that service_key. Neither change touches
 *   RESERVICE_LANES itself (reservice-public.js's loadLaneCatalog iterates
 *   that map to build the /reservice page's own two-lane catalog; a third
 *   entry there would wrongly offer "Waves Assessment" as a bookable
 *   RE-SERVICE), and the 'pest'/'lawn' lanes' own query RESULT is
 *   unaffected (an assessment row is now fetched but classifies as
 *   'assessment', so it never matches those lanes' `.some(...)` check) —
 *   reservice-public.js's own tests pass unmodified. With dedupeLane on,
 *   the lane check and the insert both run inside createSelfBooking's
 *   SINGLE insert transaction, on ONE connection, under the reservice-lane
 *   advisory lock keyed `${custId}:${ASSESSMENT_SERVICE_KEY}` (a DIFFERENT
 *   key from the real pest/lawn lanes for the same customer, so no
 *   cross-lane blocking) — genuinely atomic: two concurrent commits at
 *   DIFFERENT slots can no longer both insert (the prior design's separate
 *   phase-2 lock-then-release-then-book-then-recheck could not close this
 *   without either deadlocking or risking pool exhaustion against
 *   createSelfBooking's own second connection — see git history). A
 *   duplicate throws `ALREADY_BOOKED`, mapped here to the SAME `{ state:
 *   'already_booked', visit, rescheduleUrl }` shape GET returns, resolved
 *   against whichever visit survived. The pre-lock idempotent short-circuit
 *   above still exists as a fast path (skips geocoding/address work
 *   entirely for an obviously-already-booked lead) — it is NOT what
 *   prevents the race; the lane dedupe is. The lead gets (or keeps) a
 *   customer row and is linked (`leads.customer_id`) but nothing else on
 *   the lead changes — status/pipeline_stage/
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
 *   no-ops on) a newsletter_subscribers row tagged `expansion_waitlist:<county>`
 *   at status `waitlist` — deliberately NOT `active` (buildSubscriberQuery in
 *   newsletter-sender.js selects status='active' with no source exclusion,
 *   so an active row enrols in ordinary newsletter sends, and this token
 *   never proved ownership of the typed email) and NOT `pending` either
 *   (that status has its own live double-opt-in meaning — a future
 *   unrelated admin CSV import matching this email would queue it a REAL
 *   confirmation email). `waitlist` is a new, otherwise-unused value on this
 *   free-text column — invisible to every existing status-keyed query. No
 *   email sent (Codex pre-push P1, 2026-09-24).
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
const { isInServiceAreaBox } = require('../services/service-area');
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
      // requireInServiceArea:false — street-level quality filtering stays
      // (partial matches, ZIP/city centroids, no-match all still reject),
      // but a genuinely out-of-box address is no longer silently discarded
      // here as "unresolved". checkServiceArea (below, applied by every
      // caller) is the one place that decides in/out of area, so a valid
      // address that's simply outside the box correctly reaches out_of_area
      // instead of address_unresolved (Codex pre-push P1, 2026-09-24).
      const { location } = await geocodeAddressWithStatus(addressStr, { serviceAddress: true, requireInServiceArea: false });
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

// County/box verdict for an ALREADY-RESOLVED location — takes a location,
// never raw address text, so a geocode failure upstream can never be
// conflated with "resolved but out of area". Applies uniformly regardless
// of where the location came from, INCLUDING a customer's stored
// latitude/longitude (resolveServiceAddress's short-circuit branch returns
// those directly, skipping the geocoder's own box test entirely, so this is
// the only place stored coordinates ever get checked against the service
// area at all).
//
// With a Google key configured: reverse-geocodes the county
// (SERVICE_AREA_COUNTIES is authoritative). A null county here is NOT
// permission to book (Codex pre-push P1, 2026-09-24) — it means the
// provider call failed/timed out, or Google genuinely couldn't place a
// county on the coordinate; either way it's unknowable, not "fine", so this
// answers a distinct `unavailable:true` the caller turns into a recoverable
// 503 rather than silently letting the booking through.
//
// Without a key (documented fallback): the box test is the ONLY area check
// available, so it's run explicitly here — never a bare `ok: true`.
async function checkServiceArea(location) {
  if (!location) return { ok: false, county: null };
  const key = process.env.GOOGLE_API_KEY || process.env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    return { ok: isInServiceAreaBox(location.lat, location.lng), county: null };
  }
  let county = null;
  try {
    county = await reverseGeocodeCounty({ latitude: location.lat, longitude: location.lng }, key);
  } catch (err) {
    logger.warn(`[inspection-public] county reverse-geocode failed: ${err.message}`);
  }
  if (!county) return { ok: false, county: null, unavailable: true };
  return { ok: isInServiceAreaCounty(county), county };
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
    if (area.unavailable) return res.status(503).json({ error: 'service_area_unavailable' });
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
    if (area.unavailable) return res.status(503).json({ error: 'service_area_unavailable' });
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
    // file header for why that would deadlock). Also re-runs
    // resolveServiceAddress against the FRESH customer row (Codex pre-push
    // P1, 2026-09-24): two concurrent commits for the same addressless lead
    // can each resolve a DIFFERENT address before either takes the lock —
    // without this re-check, the second would blindly overwrite the
    // first's just-persisted address with its own stale supplied one, and
    // the first's own createSelfBooking (which reloads the customer fresh)
    // would then book against the second's address instead of its own. The
    // fresh customer row's own address always wins now; a supplied address
    // is only ever persisted when the fresh row still has none.
    const phase1 = await db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`${COMMIT_LOCK_NS}:${lead.id}`]);

      const freshLead = await loadLead(trx, lead.id);
      if (!freshLead) return { eligibility: { state: 'gone', visit: null, rescheduleUrl: null } };
      const freshCustRow = freshLead.customer_id ? await loadCustomer(trx, freshLead.customer_id) : null;

      const eligibility = await resolveEligibility(trx, freshLead, freshCustRow);
      if (eligibility.state !== 'ok') return { eligibility };

      let provisioned = freshCustRow;
      let location = resolved.location;

      if (!freshCustRow) {
        provisioned = await createCustomerForLead(trx, lead, resolved.address, resolved.location);
        await trx('leads').where({ id: lead.id }).update({ customer_id: provisioned.id, updated_at: new Date() });
      } else {
        const freshResolved = await resolveServiceAddress(lead, freshCustRow, addressInput);
        if (freshResolved.source === 'customer') {
          // Another commit already fixed up this customer's address —
          // THAT one wins, not our (possibly different) pre-lock supplied
          // address. The slot above was validated against OUR location;
          // slotStillOpen (below) re-validates it against this one.
          provisioned = freshCustRow;
          location = freshResolved.location;
        } else if (freshResolved.location) {
          // Still no working stored address on the fresh row — persist
          // whatever resolved (re-derived fresh rather than reusing the
          // pre-lock value, though in the common single-commit case
          // they're identical).
          await trx('customers').where({ id: freshCustRow.id }).update({
            address_line1: freshResolved.address.line1,
            address_line2: freshResolved.address.line2,
            city: freshResolved.address.city,
            state: freshResolved.address.state,
            zip: freshResolved.address.zip,
            latitude: freshResolved.location.lat,
            longitude: freshResolved.location.lng,
            updated_at: new Date(),
          });
          provisioned = {
            ...freshCustRow,
            address_line1: freshResolved.address.line1, address_line2: freshResolved.address.line2,
            city: freshResolved.address.city, state: freshResolved.address.state, zip: freshResolved.address.zip,
            latitude: freshResolved.location.lat, longitude: freshResolved.location.lng,
          };
          location = freshResolved.location;
        } else if (freshCustRow.address_line1) {
          // Fresh resolution failed (geocoder error/timeout) and the
          // customer has a DIFFERENT stored address on file that we simply
          // couldn't re-resolve on this attempt — never combine the
          // pre-lock LOCATION (validated for the supplied address) with
          // this customer ROW (whose stored address might describe a
          // different property): createSelfBooking reloads the customer
          // fresh and would dispatch to whatever's actually in the DB, not
          // the location the slot was checked against (Codex pre-push P1,
          // 2026-09-24). We can't tell here whether the stored address is
          // still good (a transient blip) or genuinely broken, so refuse
          // recoverably rather than guess — the client can retry.
          return { addressUnresolved: true };
        } else {
          // Fresh resolution failed even though the pre-lock one succeeded,
          // but the customer STILL has no stored address at all (nothing to
          // conflict with) — safe to persist the address that WAS validated
          // pre-lock, so createSelfBooking's fresh reload sees the SAME
          // location the slot was checked against.
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
          // `location` already defaults to resolved.location at the top of
          // this callback — unchanged, now backed by a matching customer row.
        }
      }

      // Re-validate the chosen slot when the fresh location differs from
      // what it was checked against pre-lock (only possible when another
      // commit's address won above) — and return the MATCHED slot object,
      // not just a boolean: a different location can carry a different
      // technician/end_time for the same start_time, and the booking call
      // below must use the refreshed slot's own fields, never the original
      // pre-lock slot's (Codex pre-push P1, 2026-09-24).
      let matchedSlot = slot;
      if (location.lat !== resolved.location.lat || location.lng !== resolved.location.lng) {
        const dayAvailability = await buildAvailabilityForLead(location, {
          rangeFrom: date, rangeTo: date, config, duration: catalog.durationMinutes,
        });
        matchedSlot = dayAvailability?.days?.find((d) => d.date === date)?.slots
          ?.find((s) => s.start_time === time) || null;
      }

      return { custRow: provisioned, location, slot: matchedSlot };
    });

    if (phase1.eligibility) {
      return res.json(eligibilityResponse(phase1.eligibility, leadPayload));
    }
    if (phase1.addressUnresolved) {
      return res.status(422).json({ error: 'address_unresolved' });
    }
    if (!phase1.slot) {
      let refreshed = null;
      try {
        refreshed = await buildAvailabilityForLead(phase1.location, { ...range, config, duration: catalog.durationMinutes });
      } catch (err) {
        logger.warn(`[inspection-public] refresh availability failed for lead ${lead.id}: ${err.message}`);
      }
      return res.status(409).json({
        error: 'That time is no longer open. Here are the latest available times.',
        code: 'SLOT_TAKEN',
        availability: refreshed ? shapeAvailability(refreshed, range) : null,
      });
    }
    custRow = phase1.custRow;
    const bookingLocation = phase1.location;
    const bookingSlot = phase1.slot;

    // Phase 2 — createSelfBooking's OWN atomic per-customer lane dedupe
    // (dedupeLane, left at its true default — no transaction of ours wraps
    // this call, so no connection of ours is held while it opens its own;
    // see the file header). The lane check and the insert both run inside
    // createSelfBooking's single insert transaction, on ONE connection,
    // under the SAME `pg_advisory_xact_lock(['reservice-lane', custId+':'+
    // serviceKey])` reservice-public.js's pest/lawn lanes use — genuinely
    // atomic, unlike the prior "release the lock, then book, then recheck"
    // design (Codex pre-push P1, 2026-09-24): two concurrent commits at
    // DIFFERENT slots can no longer both insert. `laneForCallbackRow`
    // (services/reservice-scheduler.js) classifies ASSESSMENT_SERVICE_KEY
    // as its own 'assessment' lane — checked before the pest/lawn cases, so
    // it can never fall through to the pest default — and
    // `openCallbackExistsForLane`'s query was widened to also match on
    // that service_key; both are additive changes that leave 'pest'/'lawn'
    // byte-identical (reservice-public's own tests still pass unmodified).
    // A duplicate throws ALREADY_BOOKED, caught below and mapped to the
    // same `{ state: 'already_booked', visit, rescheduleUrl }` shape GET
    // returns, resolved against whichever visit survived.
    const { createSelfBooking } = booking._internals;
    const result = await createSelfBooking({
      slot_date: date,
      slot_start: bookingSlot.start_time,
      slot_end: bookingSlot.end_time,
      technician_id: bookingSlot.technician_id || null,
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
        // Not a re-service warranty callback — see booking.js's callbackVisit
        // contract. dedupeLane is left at its true default (on): the
        // 'assessment' lane above is what makes this call atomic.
        isCallback: false,
        alertLabel: '🔁 Free consultation self-booked:',
      },
    });

    if (!result.ok) {
      if (result.code === 'ALREADY_BOOKED') {
        // The atomic lane dedupe inside createSelfBooking's own insert
        // transaction caught a duplicate — resolve and return the SAME
        // already_booked shape GET returns, pointing at whichever visit is
        // now the customer's open assessment.
        const eligibility = await resolveEligibility(db, lead, custRow);
        return res.json(eligibilityResponse(eligibility, leadPayload));
      }
      if (result.status === 409) {
        let refreshed = null;
        try {
          refreshed = await buildAvailabilityForLead(bookingLocation, { ...range, config, duration: catalog.durationMinutes });
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
      visit: { date, window: { start: bookingSlot.start_time, end: bookingSlot.end_time } },
      startLabel: bookingSlot.start_label,
      endLabel: bookingSlot.end_label,
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

    // status: 'waitlist' — deliberately NOT 'active' (Codex pre-push P1,
    // 2026-09-24: an 'active' row enrols in ordinary newsletter sends —
    // buildSubscriberQuery in newsletter-sender.js selects on status='active'
    // with no source exclusion — and this token never proved ownership of
    // the typed email, so it must not be treated as a confirmed subscriber
    // either). Also deliberately NOT 'pending': that status has its own live
    // meaning (server/services/newsletter-subscribers.js's double-opt-in) —
    // a future unrelated admin CSV import matching this email would queue it
    // a REAL confirmation email (admin-newsletter.js's
    // status='pending' AND confirmation_sent_at IS NULL sweep), which is
    // exactly the send this route must never trigger. 'waitlist' is a new,
    // otherwise-unused value on this free-text column (no CHECK constraint)
    // — invisible to every existing status-keyed query, so this row is held
    // only for a future expansion announcement (owner ruling, scope doc
    // lead-inspection-link-scope.md §7), never today's newsletter.
    await db('newsletter_subscribers')
      .insert({
        email,
        source: `expansion_waitlist:${county || 'unknown'}`,
        status: 'waitlist',
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
