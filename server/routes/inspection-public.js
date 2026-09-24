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
 *   Phase 1 (lock on a per-lead key → re-read the lead + customer fresh via
 *   `trx` → re-run eligibility → provision the customer → COMMIT, releasing
 *   the lock) makes the customer row a durable, visible fact before
 *   anything calls createSelfBooking. NOTHING inside this transaction does
 *   network I/O or opens a second connection (Codex pre-push P1,
 *   2026-09-24) — a Google geocode/county lookup, buildAvailabilityForLead
 *   (always the global `db` connection, plus a gated weather-outlook call
 *   of its own), or resolveEligibility's rescheduleUrlFor (same: hardwired
 *   to the global `db`, no trx parameter to give it) stalling while the
 *   lock is held risks exhausting the connection pool against itself under
 *   load. So: an existing customer's fresh row is never RE-RESOLVED here —
 *   its stored-address fields are compared against the PRE-LOCK snapshot
 *   the pre-lock resolution was actually computed against (`resolved`,
 *   already geocoded + area-checked before the lock was ever taken).
 *   Identical → `resolved` still describes this row, reused outright (an
 *   address that was still empty gets `resolved`'s validated value written
 *   back, a plain trx UPDATE with no new resolution). Different — another
 *   commit changed the row, or the lead linked to a customer, in the
 *   window between the pre-lock read and the lock — fails closed to 422
 *   `address_unresolved`, recoverable: the client retries, and the retry's
 *   own pre-lock read sees the row as it now stands. The chosen SLOT is
 *   re-validated (keeping the matched slot object — technician/end_time
 *   can differ at a different location, not just the start_time) AFTER
 *   this transaction commits and the lock releases, not inside it, for the
 *   same network-I/O reason — a verified unlinked lead reusing an existing
 *   property (resolveOrLinkCustomerForLead, below) can hand back a
 *   location that differs from the lead's own pre-lock one. (key
 *   convention matches admin-agents.js/admin-dashboard.js's
 *   single-hashtext-arg form).
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
 *   An unlinked lead whose phone matches an existing customer
 *   (`leadContactVerified`) only reuses that customer when the phone is
 *   independently corroborated — an inbound-call lead's caller ID, or an
 *   SMS-delivered token's `channel` claim — never a bare public-form
 *   submission. Otherwise it always gets its own separate prospect profile
 *   and never sees another customer's visit data, reschedule URL, or
 *   booking (Codex pre-push P1, 2026-09-24).
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

// The SINGLE source of truth for loadLead's select list — every field this
// file's lead-row readers use, including `first_contact_channel`
// (leadContactVerified's inbound-call check). loadLead is built by
// spreading this constant, never a separately hand-written column list, so
// the two can never drift apart again (Codex pre-push P1, 2026-09-24:
// loadLead's own select omitted `first_contact_channel`, silently making
// the inbound-call verification branch dead in production — only the
// mocked test row happened to carry the field, so every test passed while
// the real route always fell through to the SMS-channel check). A
// structural test sweeps leadContactVerified / resolveOrLinkCustomerForLead
// / matchExistingAccountProfile's own source for every `lead.<field>` /
// `freshLead.<field>` access and asserts each one is a member here.
const LEAD_ROW_FIELDS = [
  'id', 'first_name', 'last_name', 'phone', 'email', 'address', 'city', 'zip',
  'status', 'customer_id', 'converted_at', 'first_contact_channel',
];

async function loadLead(dbConn, leadId) {
  return dbConn('leads').where({ id: leadId }).whereNull('deleted_at').first(...LEAD_ROW_FIELDS);
}

async function loadCustomer(dbConn, customerId) {
  return dbConn('customers').where({ id: customerId }).whereNull('deleted_at').first(
    'id', 'first_name', 'last_name', 'phone', 'email',
    'address_line1', 'address_line2', 'city', 'state', 'zip', 'latitude', 'longitude'
  );
}

// Every field the commit's phase-1 lock uses to decide whether a fresh
// customer re-read still matches what the pre-lock resolution was computed
// against — round 13 (Codex pre-push P1, 2026-09-24): re-resolving a
// changed address under the lock would mean a geocode/county network call
// while holding it, never allowed, so an actual difference here fails
// closed instead (see the commit handler's phase 1).
const STORED_ADDRESS_FIELDS = ['address_line1', 'address_line2', 'city', 'state', 'zip', 'latitude', 'longitude'];

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

// The ONE place a "final" booking location is ever produced — every caller
// that needs a location to book, persist, or validate a slot against goes
// through this, both the pre-lock resolve and (Codex pre-push P1,
// 2026-09-24) the commit's under-the-lock re-resolve. Wraps
// resolveServiceAddress with checkServiceArea so a location can never reach
// a code path without having passed the area check: before this, phase 1
// could replace an already-checked pre-lock location with
// freshResolved.location (e.g. the customer's OWN stored address, which
// failed to geocode pre-lock but resolves once re-tried under the lock) and
// nothing ever ran checkServiceArea on that new location — an out-of-area
// stored address could reach booking unchecked. Returns the SAME resolved
// shape resolveServiceAddress does on success (`{ location, address,
// source, unresolved: false }`); on failure, `{ location: null, failure:
// 'address_required' | 'address_unresolved' | 'out_of_area' |
// 'service_area_unavailable', county? }` — every caller maps `failure`
// directly onto the matching response the file already uses for each case.
async function finalizeBookingLocation(lead, custRow, suppliedAddress) {
  const resolved = await resolveServiceAddress(lead, custRow, suppliedAddress);
  if (!resolved.location) {
    return { location: null, failure: resolved.unresolved ? 'address_unresolved' : 'address_required' };
  }
  const areaFailure = await serviceAreaFailure(resolved.location);
  if (areaFailure) return { location: null, ...areaFailure };
  return resolved;
}

// The ONE caller of checkServiceArea, mapped to finalizeBookingLocation's
// failure shape (null when the location is in the area). Shared with the
// commit's adopted-property recheck — the only location that does not come
// out of finalizeBookingLocation (local audit P1).
async function serviceAreaFailure(location) {
  const area = await checkServiceArea(location);
  if (area.unavailable) return { failure: 'service_area_unavailable' };
  if (!area.ok) return { failure: 'out_of_area', county: area.county || null };
  return null;
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
// `includeRescheduleUrl` (round 13, Codex pre-push P1, 2026-09-24) defaults
// true for every ordinary (unlocked) caller — GET, the pre-lock fast path,
// the post-createSelfBooking ALREADY_BOOKED resolve — but MUST be passed
// `false` by any caller running under the phase-1 advisory lock:
// rescheduleUrlFor's buildRescheduleLink hits the module-level global `db`
// directly (it has no way to accept a trx), so calling it while a
// transaction holds that lock + a pooled connection risks a second
// connection stalling on the very lock the first is holding. The lock-
// protected callers get `rescheduleUrl: null` here and the route fills it
// in with a SEPARATE, safe rescheduleUrlFor call once the transaction has
// committed and the lock is released.
async function resolveEligibility(dbConn, lead, custRow, { includeRescheduleUrl = true } = {}) {
  if (custRow) {
    const openAssessment = await findOpenVisit(dbConn, custRow.id, { assessmentOnly: true });
    if (openAssessment) {
      return {
        state: 'already_booked',
        visit: openAssessment,
        rescheduleUrl: includeRescheduleUrl ? await rescheduleUrlFor(openAssessment.id) : null,
      };
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
      return {
        state: 'converted',
        visit: futureOtherVisit || null,
        rescheduleUrl: (futureOtherVisit && includeRescheduleUrl) ? await rescheduleUrlFor(futureOtherVisit.id) : null,
      };
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
// the file header). `account` is the ALREADY-RESOLVED ensureCustomerAccount
// result — never re-derived here. resolveOrLinkCustomerForLead (the one
// caller) resolves it once, decides whether an existing property already
// covers this lead, and only calls this when none does (Codex pre-push P1,
// 2026-09-24: this used to call ensureCustomerAccount itself and always
// inserted a new property, even when the phone match already had one at
// the same address, or an open assessment this lead should have hit
// already_booked against instead).
async function createCustomerForLead(dbConn, lead, address, location, account) {
  const { createDefaultCustomerRows } = require('../services/customer-default-rows');
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

// Whether an unlinked lead's own contact fields are trustworthy enough to
// bind this booking onto an EXISTING customer a phone match finds (Codex
// pre-push P1, 2026-09-24 — partly reverses round 10). A public form's
// phone AND email are both unverified claims: submitting a victim's phone
// number would otherwise read that victim's visit date, hand back a BEARER
// /reschedule URL, or book straight onto the victim's account. PHONE ONLY —
// an email match is never grounds to trust the match (matchExistingAccountProfile
// never matches on email anyway) — and only when the phone itself is
// independently corroborated: the lead originated from an inbound call
// (leads.first_contact_channel === 'call' — Twilio caller ID, not a typed
// form field) or this consultation token's own `channel` claim records it
// was delivered by SMS to that exact phone number
// (verifyLeadConsultationToken — server/utils/lead-consultation-token.js).
// Anything else (a web-form or email-delivered lead) is UNVERIFIED.
function leadContactVerified(lead, token) {
  if (!lead) return false;
  if (lead.first_contact_channel === 'call') return true;
  return token?.channel === 'sms';
}

// Round 11 (Codex pre-push P1, 2026-09-24): a "small tolerance" for two
// coordinate pairs describing the SAME rooftop across two geocode passes —
// wide enough to absorb ordinary geocoder jitter, narrow enough that a
// genuinely different nearby address never slips through (~300m at SWFL's
// latitude).
const PROPERTY_COORD_TOLERANCE_DEGREES = 0.003;
function coordsClose(a, b) {
  if (a?.lat == null || a?.lng == null || b?.lat == null || b?.lng == null) return false;
  return Math.abs(parseFloat(a.lat) - parseFloat(b.lat)) <= PROPERTY_COORD_TOLERANCE_DEGREES
    && Math.abs(parseFloat(a.lng) - parseFloat(b.lng)) <= PROPERTY_COORD_TOLERANCE_DEGREES;
}

// Which of an existing phone-matched account's LIVE properties a VERIFIED
// unlinked lead actually belongs to: the one whose FULL normalized address
// matches (streetKey — the same canonical, suffix-normalized street
// comparison admin-customers.js's own duplicate-profile confirm gate uses —
// AND zip, services/customer-properties.js), OR whose stored coordinates
// fall within a small tolerance of the validated location when the zip
// itself doesn't line up (a customer's zip on file can be stale even
// though the rooftop is the same) — never a bare street-name match, which
// would treat "123 Main St" in one zip as the same property as "123 Main
// St" in another (Codex pre-push P1, 2026-09-24). The primary/only-property
// fallback is gated on the lead having NO address text at all
// (`!address?.line1` — round 13, Codex pre-push P1, 2026-09-24): a
// SUPPLIED address that simply doesn't normalize to a street key (a PO
// box, an address streetKey can't parse) is never treated the same as "no
// address" — that used to fall into the same `!key` branch and match the
// primary profile regardless of whether it was actually the right
// property, dispatching the visit to the wrong address. An unresolvable
// key with an address present returns null (a new profile), same as any
// other non-match. Returns null when ensureCustomerAccount found no
// existing customer (ordinary new-account create applies), or when an
// address WAS supplied but matches none of the account's live properties —
// a genuinely different property, created under the SAME account by the
// caller rather than reused.
async function matchExistingAccountProfile(dbConn, account, address, location) {
  if (!account?.existingCustomer) return null;
  const { streetKey, normalizeZip, unitKey, streetEmbeddedUnitKey } = require('../services/customer-properties');
  // Units must agree too (local audit P1): streetKey strips apartment/suite
  // designators, so two units at one street + zip would otherwise match the
  // first profile and book the wrong unit.
  const unitOf = (line1, line2) => unitKey(line2 || '') || streetEmbeddedUnitKey(line1);
  const profiles = await dbConn('customers')
    .where({ account_id: account.accountId })
    .whereNull('deleted_at')
    .orderBy('is_primary_profile', 'desc')
    .orderBy('created_at', 'asc');
  const rows = profiles.length ? profiles : [account.existingCustomer];
  const addressLine1 = address?.line1;
  if (!addressLine1) return rows[0];
  const key = streetKey(addressLine1);
  if (!key) return null;
  const zip = normalizeZip(address?.zip);
  const unit = unitOf(addressLine1, address?.line2);
  return rows.find((row) => {
    if (streetKey(row.address_line1) !== key) return false;
    if (unitOf(row.address_line1, row.address_line2) !== unit) return false;
    if (zip && normalizeZip(row.zip) === zip) return true;
    return coordsClose({ lat: row.latitude, lng: row.longitude }, location);
  }) || null;
}

// The ONE place an unlinked lead gets attached to a customer record. Resolves
// ensureCustomerAccount exactly once (it can WRITE — attaching a legacy
// row's account, or minting a fresh customer_accounts row — so it must never
// run twice for the same commit). UNVERIFIED (leadContactVerified false):
// bypasses phone/email matching entirely (forceNewAccount + ignorePhoneMatch
// — the same admin "create a separate customer" escape hatch
// findAccountByContact already offers, silent here since an anonymous
// public commit can't be asked to confirm) so a submitted victim's phone
// can NEVER bind this booking onto their real account — a coincidental or
// malicious phone match becomes a genuine duplicate prospect, the office's
// merge problem, never a security hole. VERIFIED: reuses a matching
// existing property (re-running eligibility against ITS OWN visits under
// the lead lock before anything else, so an existing open assessment
// short-circuits to already_booked instead of being missed) and returns
// the MATCHED row's own stored location (when it has one) so the caller's
// existing slot re-validation re-checks the booking against the real
// property and fails closed (SLOT_TAKEN) on any mismatch — never provisions
// a duplicate profile there. Otherwise provisions a new property under the
// (matched or freshly created) account. Returns `{ eligibility }` (a
// non-ok short-circuit — the caller returns it as-is, same shape every
// other eligibility short-circuit in this file uses) or `{ customer,
// location? }`.
async function resolveOrLinkCustomerForLead(trx, freshLead, resolved, token) {
  const { ensureCustomerAccount } = require('./admin-customers');
  const verifiedContact = leadContactVerified(freshLead, token);
  const account = await ensureCustomerAccount(trx, {
    firstName: freshLead.first_name || 'New Lead',
    lastName: freshLead.last_name || '',
    phone: freshLead.phone || '',
    email: freshLead.email || null,
    ...(verifiedContact ? {} : { forceNewAccount: true, ignorePhoneMatch: true }),
  });
  if (verifiedContact) {
    const matched = await matchExistingAccountProfile(trx, account, resolved.address, resolved.location);
    if (matched) {
      // includeRescheduleUrl:false — this runs under the caller's advisory
      // lock (round 13, Codex pre-push P1, 2026-09-24); see
      // resolveEligibility's own docblock.
      const eligibility = await resolveEligibility(trx, freshLead, matched, { includeRescheduleUrl: false });
      if (eligibility.state !== 'ok') return { eligibility };
      const matchedLocation = matched.latitude != null && matched.longitude != null
        ? { lat: parseFloat(matched.latitude), lng: parseFloat(matched.longitude) }
        : resolved.location;
      return { customer: matched, location: matchedLocation };
    }
  }
  const created = await createCustomerForLead(trx, freshLead, resolved.address, resolved.location, account);
  return { customer: created };
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

    // GET goes through finalizeBookingLocation like every other producer of a
    // booking location (see its docblock) — a stored address that resolves
    // but sits outside the service area must stop here with the out-of-area
    // page state, not fall through to needs_address:false with an empty
    // calendar (Codex pre-push P1, 2026-09-24).
    const resolved = await finalizeBookingLocation(lead, custRow, null);
    if (resolved.failure === 'out_of_area') {
      return res.json({ state: 'out_of_area', county: resolved.county || null, lead: leadPayload });
    }
    if (resolved.failure === 'service_area_unavailable') {
      return res.json({
        state: 'ok',
        lead: leadPayload,
        availability: null,
        needs_address: false,
        selfServeNotice: true,
        service_area_unavailable: true,
      });
    }

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

    const resolved = await finalizeBookingLocation(lead, custRow, addressInput);
    if (resolved.failure) {
      if (resolved.failure === 'service_area_unavailable') return res.status(503).json({ error: 'service_area_unavailable' });
      if (resolved.failure === 'out_of_area') return res.status(422).json({ error: 'out_of_area', county: resolved.county || null });
      return res.status(422).json({ error: 'address_unresolved' });
    }

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
    // Routed through finalizeBookingLocation (not a raw resolveServiceAddress
    // call) so a directly-supplied out-of-area address can't be used to pull
    // slot availability for a location that would never survive the commit
    // handler's own area check (Codex pre-push P1, 2026-09-24).
    const resolved = await finalizeBookingLocation(lead, custRow, addressInput);
    if (resolved.failure) {
      if (resolved.failure === 'service_area_unavailable') return res.status(503).json({ error: 'service_area_unavailable' });
      if (resolved.failure === 'out_of_area') return res.status(422).json({ error: 'out_of_area', county: resolved.county || null });
      return res.status(400).json({
        error: resolved.failure === 'address_unresolved'
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

    const resolved = await finalizeBookingLocation(lead, custRow, addressInput);
    if (resolved.failure) {
      if (resolved.failure === 'address_required') return res.status(400).json({ error: 'address required' });
      if (resolved.failure === 'service_area_unavailable') return res.status(503).json({ error: 'service_area_unavailable' });
      if (resolved.failure === 'out_of_area') return res.status(422).json({ error: 'out_of_area', county: resolved.county || null });
      return res.status(422).json({ error: 'address_unresolved' });
    }

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
    // provision the customer (create for an unlinked lead, or confirm an
    // existing one's stored address is unchanged) INSIDE this transaction
    // so it's a committed fact — never left open across the createSelfBooking
    // call in phase 2, which reloads the customer on a separate connection
    // (see the file header for why that would deadlock). EVERY read/write
    // in here runs on `trx`, and NOTHING in here does network I/O or opens
    // a second connection (Codex pre-push P1, 2026-09-24): the per-lead
    // advisory lock is held for the duration, and a network call (a Google
    // geocode/county lookup, buildAvailabilityForLead's own DB+weather
    // work) or a second pooled connection (resolveEligibility's
    // rescheduleUrlFor, unless told to skip it — see its own docblock)
    // stalling while that lock is held risks exhausting the pool against
    // itself under load. Two consequences of that rule: (1) an existing
    // customer's fresh row is compared against the PRE-LOCK snapshot's own
    // stored-address fields rather than re-resolved — identical, `resolved`
    // (computed before the lock, already geocoded + area-checked) is still
    // valid and reused outright; different (another commit changed it, or
    // the lead linked to a customer between the pre-lock read and the
    // lock) fails closed with a recoverable error instead of re-geocoding
    // under the lock — the client retries, and the retry's own pre-lock
    // resolve sees the row as it stands now. (2) the chosen slot is
    // re-validated AFTER this transaction commits and the lock releases,
    // never inside it — see below.
    const phase1 = await db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`${COMMIT_LOCK_NS}:${lead.id}`]);

      const freshLead = await loadLead(trx, lead.id);
      if (!freshLead) return { eligibility: { state: 'gone', visit: null, rescheduleUrl: null } };
      const freshCustRow = freshLead.customer_id ? await loadCustomer(trx, freshLead.customer_id) : null;

      // includeRescheduleUrl:false — see resolveEligibility's own docblock.
      const eligibility = await resolveEligibility(trx, freshLead, freshCustRow, { includeRescheduleUrl: false });
      if (eligibility.state !== 'ok') return { eligibility };

      let provisioned = freshCustRow;
      let location = resolved.location;

      if (!freshCustRow) {
        // ensureCustomerAccount may resolve an EXISTING customer by phone
        // even though this lead itself was never linked to one — see
        // resolveOrLinkCustomerForLead's docblock (Codex pre-push P1,
        // 2026-09-24). Its eligibility short-circuit (already_booked on
        // the MATCHED customer's own open assessment) takes priority over
        // ever linking or inserting anything. Everything it does is
        // trx-scoped DB work — no network I/O of its own.
        const linkResult = await resolveOrLinkCustomerForLead(trx, freshLead, resolved, verified);
        if (linkResult.eligibility) return { eligibility: linkResult.eligibility };
        provisioned = linkResult.customer;
        // A reused (verified) profile's OWN stored location, when it has
        // one — never the lead's pre-lock resolved.location — so the
        // post-transaction "location differs from pre-lock" re-check below
        // re-validates the slot against the REAL property and fails
        // closed (SLOT_TAKEN) on any mismatch instead of booking a
        // technician dispatched for a different address (Codex pre-push
        // P1, 2026-09-24).
        if (linkResult.location) location = linkResult.location;
        await trx('leads').where({ id: lead.id }).update({ customer_id: provisioned.id, updated_at: new Date() });
      } else {
        // Compare the fresh row's stored-address fields against the
        // PRE-LOCK custRow snapshot `resolved` was actually computed
        // against (Codex pre-push P1, 2026-09-24) — never re-resolve here,
        // which would mean a geocode/county network call while holding the
        // lock. Identical → the pre-lock resolution still describes this
        // exact row, safe to reuse outright, no new work needed.
        const addressUnchanged = STORED_ADDRESS_FIELDS.every(
          (f) => (freshCustRow[f] ?? null) === (custRow?.[f] ?? null)
        );
        if (!addressUnchanged) {
          // Another commit changed this row's stored address between the
          // pre-lock read and the lock, or the lead linked to a customer
          // in that same window — the pre-lock resolution may no longer
          // describe this row, and re-resolving here is exactly the
          // network call under the lock this rule forbids. Fail closed
          // and recoverable; the client retries.
          return { locationFailure: 'address_unresolved' };
        }
        provisioned = freshCustRow;
        if (resolved.source !== 'customer') {
          // The pre-lock resolution did NOT come from this row's own
          // stored address (it was empty, or the stored one failed to
          // geocode and a lead/supplied fallback won) — write the
          // validated resolution back so a missing/bad address isn't
          // asked for again (this file's own contract — see the header).
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
        // else resolved.source === 'customer': the pre-lock resolution WAS
        // this row's own already-good stored address/coords — nothing to
        // write back; `location` stays resolved.location, set above.
      }

      return { custRow: provisioned, location };
    });

    if (phase1.eligibility) {
      // The lock-protected eligibility check above skipped the reschedule
      // URL (no second connection while the lock was held) — the lock is
      // released now, so a normal, unlocked call is safe.
      if (phase1.eligibility.visit && !phase1.eligibility.rescheduleUrl) {
        phase1.eligibility.rescheduleUrl = await rescheduleUrlFor(phase1.eligibility.visit.id);
      }
      return res.json(eligibilityResponse(phase1.eligibility, leadPayload));
    }
    if (phase1.locationFailure) {
      if (phase1.locationFailure === 'out_of_area') return res.status(422).json({ error: 'out_of_area', county: phase1.county || null });
      if (phase1.locationFailure === 'service_area_unavailable') return res.status(503).json({ error: 'service_area_unavailable' });
      return res.status(422).json({ error: 'address_unresolved' });
    }
    custRow = phase1.custRow;
    const bookingLocation = phase1.location;

    // A verified lead reusing an existing property adopts THAT property's
    // stored coordinates, which the pre-lock area check never saw (local
    // audit P1). Area-check it now, after the lock is released — the
    // availability rebuild below checks slots, not county eligibility.
    if (bookingLocation.lat !== resolved.location.lat || bookingLocation.lng !== resolved.location.lng) {
      const areaFailure = await serviceAreaFailure(bookingLocation);
      if (areaFailure?.failure === 'service_area_unavailable') return res.status(503).json({ error: 'service_area_unavailable' });
      if (areaFailure) return res.status(422).json({ error: 'out_of_area', county: areaFailure.county || null });
    }

    // Re-validate the chosen slot when the final location differs from
    // what it was checked against pre-lock — a verified unlinked lead's
    // reused profile (above) can carry a different stored location than
    // the lead's own pre-lock resolution — and use the MATCHED slot
    // object, not just a boolean: a different location can carry a
    // different technician/end_time for the same start_time. This runs
    // AFTER phase 1's transaction has committed and the advisory lock
    // released (Codex pre-push P1, 2026-09-24): buildAvailabilityForLead
    // always uses the global `db` connection and can do real network I/O
    // of its own (a gated weather-outlook call), neither of which may run
    // while that lock is held.
    let bookingSlot = slot;
    if (bookingLocation.lat !== resolved.location.lat || bookingLocation.lng !== resolved.location.lng) {
      let refreshedDay = null;
      try {
        refreshedDay = await buildAvailabilityForLead(bookingLocation, {
          rangeFrom: date, rangeTo: date, config, duration: catalog.durationMinutes,
        });
      } catch (err) {
        logger.warn(`[inspection-public] slot re-validation failed for lead ${lead.id}: ${err.message}`);
      }
      bookingSlot = refreshedDay?.days?.find((d) => d.date === date)?.slots
        ?.find((s) => s.start_time === time) || null;
    }
    if (!bookingSlot) {
      let refreshed = null;
      try {
        refreshed = await buildAvailabilityForLead(bookingLocation, { ...range, config, duration: catalog.durationMinutes });
      } catch (err) {
        logger.warn(`[inspection-public] refresh availability failed for lead ${lead.id}: ${err.message}`);
      }
      return res.status(409).json({
        error: 'That time is no longer open. Here are the latest available times.',
        code: 'SLOT_TAKEN',
        availability: refreshed ? shapeAvailability(refreshed, range) : null,
      });
    }

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
  finalizeBookingLocation,
  findOpenVisit,
  resolveEligibility,
  buildAvailabilityForLead,
  matchExistingAccountProfile,
  leadContactVerified,
  loadLead,
  LEAD_ROW_FIELDS,
  COMMIT_LOCK_NS,
};

module.exports = router;
