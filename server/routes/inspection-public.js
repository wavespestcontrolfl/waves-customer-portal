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
const { verifyLeadConsultationToken, smsChannelFor } = require('../utils/lead-consultation-token');
const { lockCustomerComms } = require('../utils/customer-comms-lock');
const { geocodeAddressWithStatus } = require('../services/geocoder');
const { reverseGeocodeCounty } = require('../services/address-validation');
const { isInServiceAreaCounty } = require('../services/call-triage-flags');
const { isInServiceAreaBox } = require('../services/service-area');
const { isAssessmentServiceType, ASSESSMENT_SERVICE_KEY } = require('../services/assessment-booking');
// The Waves Assessment's catalog identity for travel-gap padding — shared by
// the offer (buildAvailabilityForLead) and the commit (callbackVisit).
const ASSESSMENT_EXPECTED_IDENTITY = Object.freeze({ catalogServiceKey: ASSESSMENT_SERVICE_KEY, serviceType: 'Waves Assessment' });
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
  'status', 'customer_id', 'converted_at', 'first_contact_channel', 'twilio_call_sid',
];

async function loadLead(dbConn, leadId, { forUpdate = false } = {}) {
  const q = dbConn('leads').where({ id: leadId }).whereNull('deleted_at');
  if (forUpdate) q.forUpdate();
  return q.first(...LEAD_ROW_FIELDS);
}

// The lead's EXISTING customer link, only when it is proven (Codex #4737 P0):
// leads.customer_id can be set from unverified submitted contact info
// (public-quote.js links a quote lead to an existing customer by phone/
// email), so it is never proof of ownership on its own. Trusted only when
// the link holder is verified for the lead's phone (leadContactVerified —
// the originating call's caller ID, or a phone-bound SMS claim) AND that
// phone is the linked customer's own. Anything else is treated as no link:
// none of that customer's address, visits or reschedule links are exposed,
// and a booking goes onto a separate prospect (the existing link is left
// as it is).
const CONSULTATION_PROSPECT_ACTIVITY = 'consultation_prospect';

async function loadTrustedCustomer(dbConn, lead, token) {
  if (!lead?.id) return null;
  // The prospect THIS flow created for this lead (local audit P1): an
  // unverified lead's own booking must be found again on a retry, or every
  // retry would mint another prospect and slip the assessment dedupe. Only
  // this route writes this activity type, so it is server-owned provenance,
  // unlike leads.customer_id.
  const created = await dbConn('lead_activities')
    .where({ lead_id: lead.id, activity_type: CONSULTATION_PROSPECT_ACTIVITY })
    .orderBy('created_at', 'desc')
    .first('metadata');
  const meta = typeof created?.metadata === 'string' ? JSON.parse(created.metadata) : created?.metadata;
  if (meta?.customer_id) {
    const prospect = await loadCustomer(dbConn, meta.customer_id);
    if (prospect) return prospect;
  }
  if (!lead.customer_id) return null;
  const customer = await loadCustomer(dbConn, lead.customer_id);
  if (!customer) return null;
  const last10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);
  if (!last10(customer.phone) || last10(customer.phone) !== last10(lead.phone)) return null;
  return (await leadContactVerified(lead, token, dbConn)) ? customer : null;
}

async function loadCustomer(dbConn, customerId) {
  return dbConn('customers').where({ id: customerId }).whereNull('deleted_at').first(
    'id', 'first_name', 'last_name', 'phone', 'email', 'account_id',
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
  const found = await db('services')
    .where({ service_key: ASSESSMENT_SERVICE_KEY })
    .first('id', 'default_duration_minutes', 'is_active', 'is_archived', 'booking_enabled');
  // A deactivated, archived or booking-disabled assessment row is treated
  // exactly like a missing one (Codex #4737 r5 P2): the page answers
  // "temporarily unavailable" instead of scheduling a retired service.
  const row = found && found.is_active !== false && found.is_archived !== true && found.booking_enabled !== false
    ? found
    : null;
  const rawDuration = parseInt(row?.default_duration_minutes, 10);
  return {
    serviceId: row?.id || null,
    serviceType: 'Waves Assessment',
    durationMinutes: Number.isInteger(rawDuration) && rawDuration >= 15 && rawDuration <= 90 ? rawDuration : 30,
  };
}

// Single address-resolution authority for this whole route family (GET,
// /availability, /find-slots, and the commit). Order:
//   1. an explicitly SUPPLIED address (the page's address form) — a
//      deliberate correction wins over anything stored (Codex #4737 r5 P1:
//      a retry after a failed commit must book at the corrected address,
//      not the one the failed attempt already persisted). A supplied
//      address that does not geocode answers `unresolved` — never a silent
//      fall-back to the stored address the lead was trying to replace;
//   2. the linked customer's stored COORDS (no geocode needed);
//   3. the customer's stored address TEXT, then the lead's own raw fields.
// A stored address that merely fails to geocode is treated exactly like a
// missing one.
//
// Returns { location: {lat,lng}|null, address: {line1,line2,city,state,zip}|null,
// source: 'customer'|'lead'|'supplied'|null, unresolved: boolean }. `unresolved`
// is true when SOME address text existed but none of it geocoded — callers
// answer that 422 `address_unresolved` (recoverable), never `out_of_area`
// (reserved for an actually-RESOLVED location outside the service
// county/box — see checkServiceArea, which takes a location, not text).
async function resolveServiceAddress(lead, custRow, suppliedAddress) {
  const supplied = suppliedAddressFields(suppliedAddress);
  if (supplied) {
    const location = await geocodeServiceAddress(supplied);
    return location
      ? { location, address: supplied, source: 'supplied', unresolved: false }
      : { location: null, address: null, source: null, unresolved: true };
  }
  const stored = storedCoordsResolution(custRow);
  if (stored) return stored;
  let anyAddressText = false;
  for (const { address, source } of storedAddressCandidates(lead, custRow)) {
    anyAddressText = true;
     
    const location = await geocodeServiceAddress(address);
    if (location) return { location, address, source, unresolved: false };
  }
  return { location: null, address: null, source: null, unresolved: anyAddressText };
}

// The page's typed address as structured fields, or null when none.
function suppliedAddressFields(suppliedAddress) {
  const input = typeof suppliedAddress === 'string' ? suppliedAddress.trim() : '';
  if (!input) return null;
  const parsed = parseRawAddress(input);
  return {
    line1: parsed.line1 || input, line2: null,
    city: parsed.city || null, state: parsed.state || 'FL', zip: parsed.zip || null,
  };
}

// The linked customer's stored coordinates as a resolution, or null.
function storedCoordsResolution(custRow) {
  if (custRow?.latitude == null || custRow?.longitude == null) return null;
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

// Stored address text to try, in order: the customer's own, then (only when
// the customer has none) the lead's raw fields.
function storedAddressCandidates(lead, custRow) {
  const candidates = [];
  if (custRow?.address_line1) {
    candidates.push({
      source: 'customer',
      address: {
        line1: custRow.address_line1, line2: custRow.address_line2 || null,
        city: custRow.city || null, state: custRow.state || 'FL', zip: custRow.zip || null,
      },
    });
  }
  if (lead?.address) {
    candidates.push({
      source: 'lead',
      address: { line1: lead.address, line2: null, city: lead.city || null, state: 'FL', zip: lead.zip || null },
    });
  }
  return candidates;
}

// Street-level geocode of one address, or null. requireInServiceArea:false —
// quality filtering stays (partial matches, ZIP/city centroids, no-match all
// reject), but an out-of-box address is not discarded here as "unresolved":
// checkServiceArea is the one place that decides in/out of area (Codex
// pre-push P1, 2026-09-24).
async function geocodeServiceAddress(address) {
  const addressStr = [address.line1, address.city, address.state, address.zip].filter(Boolean).join(', ');
  if (!addressStr) return null;
  try {
    const { location } = await geocodeAddressWithStatus(addressStr, { serviceAddress: true, requireInServiceArea: false });
    return location || null;
  } catch (err) {
    logger.warn(`[inspection-public] address geocode failed: ${err.message}`);
    return null;
  }
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
  // The box is a geographic guard in BOTH modes (local audit P1):
  // reverseGeocodeCounty returns a bare county name, so an out-of-state
  // county with a served county's name (Charlotte County, VA) would pass
  // the name match alone. Outside the box is out of area, no network call.
  if (!isInServiceAreaBox(location.lat, location.lng)) return { ok: false, county: null };
  const key = process.env.GOOGLE_API_KEY || process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return { ok: true, county: null };
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
  const areaFailure = await serviceAreaFailure(resolved.location, resolved.address);
  if (areaFailure) return { location: null, ...areaFailure };
  return resolved;
}

// The ONE caller of checkServiceArea, mapped to finalizeBookingLocation's
// failure shape (null when the location is in the area). Shared with the
// commit's adopted-property recheck — the only location that does not come
// out of finalizeBookingLocation (local audit P1).
async function serviceAreaFailure(location, address = null) {
  const area = await checkServiceArea(location);
  if (area.unavailable) return { failure: 'service_area_unavailable' };
  // Outside the box there is no county lookup; the address's own city/ZIP
  // is the waitlist's region signal instead (Codex #4737 r6 P2).
  const region = [address?.city, address?.zip].filter(Boolean).join(' ') || null;
  if (!area.ok) return { failure: 'out_of_area', county: area.county || region };
  return null;
}

async function buildAvailabilityForLead(coords, { rangeFrom, rangeTo, config, duration, timeOfDay }) {
  const booking = require('./booking');
  const { buildBookingAvailability } = booking._internals;
  return buildBookingAvailability({
    lat: coords.lat,
    lng: coords.lng,
    duration,
    // The assessment's OWN catalog identity (Codex #4737 r1 P2), the same one
    // createSelfBooking's commit probe measures with (callbackVisit), so the
    // offered travel gap and the commit-time check always agree. No funnel
    // key → no service-type filter: any active field tech (owner decision —
    // all active techs, scope doc §7).
    serviceKey: ASSESSMENT_SERVICE_KEY,
    serviceIdentity: ASSESSMENT_EXPECTED_IDENTITY,
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
//
// Both proofs are bound to the lead's CURRENT phone (Codex #4737 r1 P1): a
// phone corrected after the link went out must not inherit the old proof.
// A call lead counts only while its phone still equals the caller ID on
// its originating call_log row; an SMS claim only when its signed digest
// (smsChannelFor) is of this exact phone. Reads run on the caller's trx.
async function leadContactVerified(lead, token, dbConn = db) {
  if (!lead || !lead.phone) return false;
  const last10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);
  if (token?.channel && token.channel === smsChannelFor(lead.phone)) return true;
  if (lead.first_contact_channel !== 'call' || !lead.twilio_call_sid) return false;
  const call = await dbConn('call_log').where({ twilio_call_sid: lead.twilio_call_sid }).first('from_phone');
  return Boolean(call?.from_phone) && last10(call.from_phone) === last10(lead.phone);
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
  const profiles = await dbConn('customers')
    .where({ account_id: account.accountId })
    .whereNull('deleted_at')
    .orderBy('is_primary_profile', 'desc')
    .orderBy('created_at', 'asc');
  const rows = profiles.length ? profiles : [account.existingCustomer];
  if (!address?.line1) return rows[0];
  return rows.find((row) => profileMatchesAddress(row, address, location)) || null;
}

// Whether ONE customer profile is the lead's validated property: the same
// canonical street (streetKey) AND the same unit (local audit P1 —
// streetKey strips apartment/suite designators, so two units at one street
// + zip would otherwise match), and the same zip or stored coordinates
// within tolerance. An address whose street does not normalize never
// matches.
function profileMatchesAddress(row, address, location) {
  const { streetKey, normalizeZip, unitKey, streetEmbeddedUnitKey } = require('../services/customer-properties');
  const unitOf = (line1, line2) => unitKey(line2 || '') || streetEmbeddedUnitKey(line1);
  const key = streetKey(address.line1);
  if (!key || streetKey(row.address_line1) !== key) return false;
  if (unitOf(row.address_line1, row.address_line2) !== unitOf(address.line1, address.line2)) return false;
  const zip = normalizeZip(address.zip);
  if (zip && normalizeZip(row.zip) === zip) return true;
  return coordsClose({ lat: row.latitude, lng: row.longitude }, location);
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
// The live customers carrying this phone (last ten digits), grouped into
// households: an account, or — for a legacy profile with no account yet —
// the profile itself (local audit P1: ensureCustomerAccount still matches
// and attaches those, so they count toward ambiguity).
async function phoneMatchedHouseholds(dbConn, phone) {
  const last10 = String(phone || '').replace(/\D/g, '').slice(-10);
  if (last10.length !== 10) return [];
  const rows = await dbConn('customers')
    .whereNull('deleted_at')
    .whereRaw("right(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [last10])
    .select('id', 'account_id', 'address_line1', 'address_line2', 'city', 'state', 'zip', 'latitude', 'longitude');
  const households = new Map();
  for (const row of rows) {
    const key = row.account_id ? `account:${row.account_id}` : `legacy:${row.id}`;
    if (!households.has(key)) households.set(key, { accountId: row.account_id || null, legacy: row.account_id ? null : row });
  }
  return [...households.values()];
}

// The ONE profile across these households whose address matches the lead's
// validated address, or null when none or more than one does (a supplied
// address is required — "no address" never picks a household). An account
// household searches all its profiles; a legacy one is its single profile.
async function uniqueProfileAcrossAccounts(dbConn, households, resolved) {
  if (!resolved.address?.line1) return null;
  const matches = [];
  for (const household of households) {
    if (household.legacy) {
      if (profileMatchesAddress(household.legacy, resolved.address, resolved.location)) matches.push(household.legacy);
      continue;
    }
     
    const hit = await matchExistingAccountProfile(dbConn, { accountId: household.accountId, existingCustomer: { id: null } }, resolved.address, resolved.location);
    if (hit?.id) matches.push(hit);
  }
  return matches.length === 1 ? matches[0] : null;
}

async function resolveOrLinkCustomerForLead(trx, freshLead, resolved, token) {
  const { ensureCustomerAccount } = require('./admin-customers');
  const verifiedContact = await leadContactVerified(freshLead, token, trx);
  // Several live accounts can legitimately share one phone (Codex #4737 r5
  // P1 — admin-customers.js supports it), while ensureCustomerAccount picks
  // the first. So a verified lead's property is matched across EVERY
  // phone-matched household: a unique address match is reused; none or
  // several get a separate new account, never an "Additional property"
  // under an arbitrarily chosen household. The shared-phone match runs
  // BEFORE any account is created (local audit P1), so a reuse or an
  // already_booked answer never leaves an orphan customer_accounts row.
  const sharedPhoneHouseholds = verifiedContact ? await phoneMatchedHouseholds(trx, freshLead.phone) : [];
  const multiAccount = sharedPhoneHouseholds.length > 1;
  if (multiAccount) {
    const matched = await uniqueProfileAcrossAccounts(trx, sharedPhoneHouseholds, resolved);
    if (matched) return reuseMatchedProfile(trx, freshLead, matched, resolved);
  }
  const account = await ensureCustomerAccount(trx, {
    firstName: freshLead.first_name || 'New Lead',
    lastName: freshLead.last_name || '',
    phone: freshLead.phone || '',
    email: freshLead.email || null,
    ...(verifiedContact && !multiAccount ? {} : { forceNewAccount: true, ignorePhoneMatch: true }),
    // The lead row is already locked, so attaching a phone-matched legacy
    // customer to an account must use the existing non-blocking
    // customer-comms fence + fresh re-resolve (local audit P1), exactly as
    // the lead convert does — a busy fence fails closed (retryable) instead
    // of deadlocking a merge-undo.
    fenceAttach: true,
  });
  if (verifiedContact && !multiAccount) {
    const matched = await matchExistingAccountProfile(trx, account, resolved.address, resolved.location);
    if (matched) return reuseMatchedProfile(trx, freshLead, matched, resolved);
  }
  const created = await createCustomerForLead(trx, freshLead, resolved.address, resolved.location, account);
  // Server-owned provenance for loadTrustedCustomer (local audit P1): this
  // prospect is this lead's own, found again on every retry.
  await trx('lead_activities').insert({
    lead_id: freshLead.id,
    activity_type: CONSULTATION_PROSPECT_ACTIVITY,
    description: 'Consultation page created a prospect profile for this lead',
    performed_by: 'consultation_page',
    metadata: JSON.stringify({ customer_id: created.id }),
  });
  return { customer: created };
}

// A linked lead booking a DIFFERENT property of its account: that account's
// matching profile is reused, else a new "Additional property" profile is
// created under it (a legacy profile with no account is attached to one
// first, through the same non-blocking fence the lead convert uses).
async function resolveOtherAccountProperty(trx, freshLead, linked, resolved) {
  let account = linked.account_id ? { accountId: linked.account_id, existingCustomer: linked } : null;
  if (!account) {
    const { ensureCustomerAccount } = require('./admin-customers');
    account = await ensureCustomerAccount(trx, {
      firstName: linked.first_name || freshLead.first_name || 'New Lead',
      lastName: linked.last_name || freshLead.last_name || '',
      phone: linked.phone || freshLead.phone || '',
      email: linked.email || null,
      fenceAttach: true,
    });
  }
  const existing = await matchExistingAccountProfile(trx, account, resolved.address, resolved.location);
  if (existing) return reuseMatchedProfile(trx, freshLead, existing, resolved);
  const created = await createCustomerForLead(trx, freshLead, resolved.address, resolved.location, account);
  return { customer: created };
}

// A verified lead's existing property, reused: its own open assessment wins
// (already_booked), else it is the booking customer, at its OWN stored pin
// when it has one.
async function reuseMatchedProfile(trx, freshLead, matched, resolved) {
  // includeRescheduleUrl:false — this runs under the caller's advisory
  // lock (round 13, Codex pre-push P1, 2026-09-24); see
  // resolveEligibility's own docblock.
  const eligibility = await resolveEligibility(trx, freshLead, matched, { includeRescheduleUrl: false });
  if (eligibility.state !== 'ok') return { eligibility };
  if (matched.latitude != null && matched.longitude != null) {
    return { customer: matched, location: { lat: parseFloat(matched.latitude), lng: parseFloat(matched.longitude) } };
  }
  // A legacy profile with no stored coordinates gets the validated ones
  // (Codex #4737 r3 P1): createSelfBooking reloads the customer's own
  // coordinates for its commit-time travel check. The customer-comms fence
  // for this customer (known only mid-transaction) is taken NON-blocking:
  // the lead row is already locked, and a blocking wait could deadlock a
  // merge-undo. Not acquired → the coordinates are simply not persisted
  // (the booking still carries the validated location as expectedLocation).
  const { tryLockCustomerComms } = require('../utils/customer-comms-lock');

  if (!(await tryLockCustomerComms(trx, matched.id))) {
    logger.warn(`[inspection-public] comms fence busy for ${matched.id}; coordinates not persisted`);
    return { customer: matched, location: resolved.location };
  }
  const after = { latitude: resolved.location.lat, longitude: resolved.location.lng };
  await trx('customers').where({ id: matched.id }).update({ ...after, updated_at: new Date() });
  return { customer: { ...matched, ...after }, location: resolved.location };
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

    const custRow = await loadTrustedCustomer(db, lead, verified);
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
      // The catalog duration the visit is actually built and booked with
      // (Codex #4737 r4 P2) — the page shows this, never a hardcoded number.
      durationMinutes: catalog.durationMinutes,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:token/availability', findSlotsLimiter, async (req, res, next) => {
  if (!leadInspectionLinkLive()) return res.status(404).json({ error: 'not_found' });
  // Token before body validation (Codex #4737 r1 P0): an invalid token
  // always gets the generic 404, never a validation 400.
  const verified = verifyLeadConsultationToken(req.params.token);
  if (!verified) return res.status(404).json({ error: 'not_found' });
  const addressInput = typeof req.body?.address === 'string' ? req.body.address.trim() : '';
  if (!addressInput) return res.status(400).json({ error: 'address required' });

  try {
    const lead = await loadLead(db, verified.leadId);
    if (!lead) return res.status(404).json({ error: 'not_found' });
    const custRow = await loadTrustedCustomer(db, lead, verified);

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
  // Token before body validation (Codex #4737 r1 P0): an invalid token
  // always gets the generic 404, never a validation 400.
  const verified = verifyLeadConsultationToken(req.params.token);
  if (!verified) return res.status(404).json({ error: 'not_found' });
  const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
  if (!query) return res.status(400).json({ error: 'query required' });
  if (query.length > 500) return res.status(400).json({ error: 'query too long' });
  const addressInput = typeof req.body?.address === 'string' ? req.body.address.trim() : '';

  try {
    const lead = await loadLead(db, verified.leadId);
    if (!lead) return res.status(404).json({ error: 'not_found' });
    const custRow = await loadTrustedCustomer(db, lead, verified);
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

// The linked-customer half of phase 1 (split out of provisionCommitCustomer).
// Runs under its locks; returns { custRow, location } or a terminal
// { locationFailure } / { eligibility }.
async function provisionLinkedCustomer(trx, { freshLead, freshCustRow, custRow, resolved }) {
  let provisioned = freshCustRow;
  const location = resolved.location;
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
  // A supplied address that is NOT an established profile's own address
  // is ANOTHER property of the account (Codex #4737 r6 P1) — it reuses
  // that account's matching profile or becomes a new one; the linked
  // profile is never overwritten (its visits would otherwise dispatch to
  // the new address). A profile with no visits yet (this flow's own
  // prospect, a lead's unvalidated address) is still corrected in place.
  const anotherProperty = resolved.source === 'supplied'
    && Boolean(freshCustRow.address_line1)
    && !profileMatchesAddress(freshCustRow, resolved.address, resolved.location)
    && (await trx('scheduled_services').where({ customer_id: freshCustRow.id }).select('id').limit(1)).length > 0;
  if (anotherProperty) {
    const other = await resolveOtherAccountProperty(trx, freshLead, freshCustRow, resolved);
    if (other.eligibility) return { eligibility: other.eligibility };
    return { custRow: other.customer, location: other.location || resolved.location };
  }
  if (resolved.source !== 'customer') {
    // The pre-lock resolution did NOT come from this row's own
    // stored address (it was empty, or the stored one failed to
    // geocode and a lead/supplied fallback won) — write the
    // validated resolution back so a missing/bad address isn't
    // asked for again (this file's own contract — see the header).
    const after = {
      address_line1: resolved.address.line1,
      address_line2: resolved.address.line2,
      city: resolved.address.city,
      state: resolved.address.state,
      zip: resolved.address.zip,
      latitude: resolved.location.lat,
      longitude: resolved.location.lng,
    };
    await trx('customers').where({ id: freshCustRow.id }).update({ ...after, updated_at: new Date() });
    provisioned = {
      ...freshCustRow,
      address_line1: resolved.address.line1, address_line2: resolved.address.line2,
      city: resolved.address.city, state: resolved.address.state, zip: resolved.address.zip,
      latitude: resolved.location.lat, longitude: resolved.location.lng,
    };
  }
  // else resolved.source === 'customer': the pre-lock resolution WAS
  // this row's own stored address. Its text needs no write-back, but
  // coordinates it lacked are persisted (local audit P1) —
  // createSelfBooking reloads the row for its commit-time travel check,
  // which must never run locationless.
  else if (freshCustRow.latitude == null || freshCustRow.longitude == null) {
    const after = { latitude: resolved.location.lat, longitude: resolved.location.lng };
    await trx('customers').where({ id: freshCustRow.id }).update({ ...after, updated_at: new Date() });
    provisioned = { ...freshCustRow, ...after };
  }
  return { custRow: provisioned, location };
}

// Phase 1 of the commit (split out of the handler, Codex #4737 r1 P2): under
// the per-lead advisory lock, re-read the lead + customer, re-run
// eligibility, and provision/link the customer. Returns { eligibility } for a
// terminal state, { locationFailure } for an address that changed under the
// lock, or { custRow, location } to book with. DB work on `trx` only — no
// network I/O while the lock is held (see the handler's phase-1 note).
async function provisionCommitCustomer({ lead, custRow, resolved, verified }) {
  return db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`${COMMIT_LOCK_NS}:${lead.id}`]);

    // Lock order = admin-leads' (utils/customer-comms-lock.js contract #1):
    // for the customer already known pre-lock, the customer-comms fence
    // FIRST, then that customer's row, then the lead row (Codex #4737 r5 P1).
    // The customer's address can then neither change under the comparison
    // and write-back below nor slip past booking.js's own fenced
    // expectedLocation check.
    if (custRow?.id) {
      await lockCustomerComms(trx, custRow.id);
      await trx('customers').where({ id: custRow.id }).forNoKeyUpdate().first('id');
    }
    // Row-locked: admin-leads' conversion/booking locks and updates the same
    // lead row — FOR UPDATE makes this read wait for it and see its
    // committed customer link / converted_at, never a stale null.
    const freshLead = await loadLead(trx, lead.id, { forUpdate: true });
    if (!freshLead) return { eligibility: { state: 'gone', visit: null, rescheduleUrl: null } };
    const freshCustRow = await loadTrustedCustomer(trx, freshLead, verified);
    // The trusted customer changed between the pre-lock read and the locks
    // (a conversion or merge landed): its row is not the one locked above,
    // so nothing is written — the client retries against the new state.
    if ((freshCustRow?.id || null) !== (custRow?.id || null) && freshCustRow) {
      return { locationFailure: 'address_unresolved' };
    }

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
      // Only an UNLINKED lead gets linked here; an existing but unproven
      // link is left exactly as it is (Codex #4737 P0) — this booking
      // lives on its own prospect.
      if (!freshLead.customer_id) {
        await trx('leads').where({ id: lead.id }).update({ customer_id: provisioned.id, updated_at: new Date() });
      }
    } else {
      const linked = await provisionLinkedCustomer(trx, { freshLead, freshCustRow, custRow, resolved });
      if (!linked.custRow) return linked;
      provisioned = linked.custRow;
      location = linked.location;
    }

    return { custRow: provisioned, location };
  });
}

// Commit-handler helpers (split out, Codex #4737 r1 P2) — each maps one
// repeated decision to its response so the handler reads as phases.

function sendLocationFailure(res, failure, county) {
  if (failure === 'address_required') return res.status(400).json({ error: 'address required' });
  if (failure === 'service_area_unavailable') return res.status(503).json({ error: 'service_area_unavailable' });
  if (failure === 'out_of_area') return res.status(422).json({ error: 'out_of_area', county: county || null });
  return res.status(422).json({ error: 'address_unresolved' });
}

// 409 SLOT_TAKEN with the latest open times at `location` (best-effort
// refresh — answered without it on failure).
async function sendSlotTaken(res, { location, range, config, catalog, leadId, error }) {
  let refreshed = null;
  try {
    refreshed = await buildAvailabilityForLead(location, { ...range, config, duration: catalog.durationMinutes });
  } catch (err) {
    logger.warn(`[inspection-public] refresh availability failed for lead ${leadId}: ${err.message}`);
  }
  return res.status(409).json({
    error: error || 'That time is no longer open. Here are the latest available times.',
    code: 'SLOT_TAKEN',
    availability: refreshed ? shapeAvailability(refreshed, range) : null,
  });
}

// The picked slot re-checked at a location that differs from the one it
// was offered for — the MATCHED slot object (technician/end_time can differ
// by location), or null when it is not open there.
async function revalidateSlotAt(location, { date, time, config, catalog, leadId }) {
  let refreshedDay = null;
  try {
    refreshedDay = await buildAvailabilityForLead(location, {
      rangeFrom: date, rangeTo: date, config, duration: catalog.durationMinutes,
    });
  } catch (err) {
    logger.warn(`[inspection-public] slot re-validation failed for lead ${leadId}: ${err.message}`);
  }
  return findSlotIn(refreshedDay, date, time);
}

// The offered slot object for `date` at `time` in an availability build, or null.
function findSlotIn(availability, date, time) {
  const day = availability?.days?.find((d) => d.date === date);
  return day?.slots?.find((s) => s.start_time === time) || null;
}

function sameLocation(a, b) {
  return a.lat === b.lat && a.lng === b.lng;
}

// After a successful createSelfBooking: the reschedule link, the internal
// note, and the response body. Lookups here are best-effort — the booking
// already committed.
async function finishCommittedBooking({ result, notes, date, bookingSlot }) {
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

  return {
    success: true,
    state: 'ok',
    replayed: !!result.body?.replayed,
    visit: { date, window: { start: bookingSlot.start_time, end: bookingSlot.end_time } },
    startLabel: bookingSlot.start_label,
    endLabel: bookingSlot.end_label,
    rescheduleUrl,
  };
}

function parseCommitBody(body) {
  const date = typeof body?.date === 'string' ? body.date.trim() : '';
  const time = typeof body?.time === 'string' ? body.time.trim() : '';
  const addressInput = typeof body?.address === 'string' ? body.address.trim() : '';
  const notes = typeof body?.notes === 'string' ? body.notes.trim().slice(0, MAX_NOTES_LENGTH) : '';
  const invalid = !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):00$/.test(time);
  return { date, time, addressInput, notes, invalid };
}

// Phase 2 — createSelfBooking with the assessment's internal callbackVisit
// (see the handler's phase-2 note for the lane-dedupe contract).
async function bookAssessmentVisit({ booking, date, bookingSlot, custRow, catalog, bookingLocation }) {
  const { createSelfBooking } = booking._internals;
  return createSelfBooking({
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
      // The identity the offer side measured the travel gap with, so the
      // commit-time check agrees (Codex #4737 r1 P2).
      expectedIdentity: ASSESSMENT_EXPECTED_IDENTITY,
      // The location this slot was validated for — createSelfBooking
      // refuses (409) under its customer fence if the customer's stored pin
      // has moved since (Codex #4737 r5 P1).
      expectedLocation: bookingLocation,
      alertLabel: '🔁 Free consultation self-booked:',
    },
  });
}

// A failed createSelfBooking mapped to the page's responses: ALREADY_BOOKED
// resolves to GET's already_booked shape; a 409 is SLOT_TAKEN with fresh
// times; anything else passes through.
async function sendBookingFailure(res, result, { lead, custRow, leadPayload, bookingLocation, range, config, catalog }) {
  // A validated, in-area address the lead supplied through their own
  // link stays on the customer even when this attempt fails (owner
  // ruling 2026-09-24): undoing it raced concurrent bookings that had
  // already adopted it (Codex #4737 r3/r4). A retry with a different
  // address simply writes that one.
  if (result.code === 'ALREADY_BOOKED') {
    // The atomic lane dedupe inside createSelfBooking's own insert
    // transaction caught a duplicate — resolve and return the SAME
    // already_booked shape GET returns, pointing at whichever visit is
    // now the customer's open assessment.
    const eligibility = await resolveEligibility(db, lead, custRow);
    return res.json(eligibilityResponse(eligibility, leadPayload));
  }
  if (result.status === 409) {
    return sendSlotTaken(res, { location: bookingLocation, range, config, catalog, leadId: lead.id, error: result.error });
  }
  return res.status(result.status || 500).json({ error: result.error });
}

// Phase 1 ended in a terminal answer: eligibility changed under the lock
// (with the reschedule URL filled in now that the lock is released), or the
// customer's stored address changed under it.
async function sendPhase1Terminal(res, phase1, leadPayload) {
  if (phase1.eligibility) {
    // The lock-protected eligibility check above skipped the reschedule
    // URL (no second connection while the lock was held) — the lock is
    // released now, so a normal, unlocked call is safe.
    if (phase1.eligibility.visit && !phase1.eligibility.rescheduleUrl) {
      phase1.eligibility.rescheduleUrl = await rescheduleUrlFor(phase1.eligibility.visit.id);
    }
    return res.json(eligibilityResponse(phase1.eligibility, leadPayload));
  }
  if (phase1.locationFailure) return sendLocationFailure(res, phase1.locationFailure, phase1.county);
}

// The picked date outside the online window, or no assessment catalog row.
function commitWindowFailure(date, range, catalog) {
  if (date < range.rangeFrom || date > range.rangeTo) {
    return { status: 400, error: 'That date is outside the online scheduling window.' };
  }
  if (!catalog.serviceId) return { status: 503, error: 'Booking is temporarily unavailable — please text or call us.' };
  return null;
}

router.post('/:token', commitLimiter, async (req, res, next) => {
  if (!leadInspectionLinkLive()) return res.status(404).json({ error: 'not_found' });
  // Token before body validation (Codex #4737 r1 P0): an invalid token
  // always gets the generic 404, never a validation 400.
  const verified = verifyLeadConsultationToken(req.params.token);
  if (!verified) return res.status(404).json({ error: 'not_found' });

  const { date, time, addressInput, notes, invalid } = parseCommitBody(req.body);
  if (invalid) return res.status(400).json({ error: 'date (YYYY-MM-DD) and time (HH:00) required' });

  try {
    const lead = await loadLead(db, verified.leadId);
    if (!lead) return res.status(404).json({ error: 'not_found' });

    let custRow = await loadTrustedCustomer(db, lead, verified);
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
    if (resolved.failure) return sendLocationFailure(res, resolved.failure, resolved.county);

    const booking = require('./booking');
    const config = await booking._internals.loadBookingConfig();
    const range = bookingRange(config);
    const catalog = await loadAssessmentCatalog();
    const windowFailure = commitWindowFailure(date, range, catalog);
    if (windowFailure) return res.status(windowFailure.status).json({ error: windowFailure.error });

    // Anti-forgery: re-validate against a fresh single-day availability
    // build at the CATALOG's real duration (reservice-public's model).
    const dayAvailability = await buildAvailabilityForLead(resolved.location, {
      rangeFrom: date, rangeTo: date, config, duration: catalog.durationMinutes,
    });
    const slot = findSlotIn(dayAvailability, date, time);
    if (!slot) return sendSlotTaken(res, { location: resolved.location, range, config, catalog, leadId: lead.id });

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
    const phase1 = await provisionCommitCustomer({ lead, custRow, resolved, verified });

    if (phase1.eligibility || phase1.locationFailure) return sendPhase1Terminal(res, phase1, leadPayload);
    custRow = phase1.custRow;
    const bookingLocation = phase1.location;

    // A verified lead reusing an existing property adopts THAT property's
    // stored coordinates, which the pre-lock area check never saw (local
    // audit P1). Area-check it now, after the lock is released — the
    // availability rebuild below checks slots, not county eligibility.
    const locationMoved = !sameLocation(bookingLocation, resolved.location);
    if (locationMoved) {
      const areaFailure = await serviceAreaFailure(bookingLocation, custRow);
      if (areaFailure) return sendLocationFailure(res, areaFailure.failure, areaFailure.county);
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
    const bookingSlot = locationMoved
      ? await revalidateSlotAt(bookingLocation, { date, time, config, catalog, leadId: lead.id })
      : slot;
    if (!bookingSlot) return sendSlotTaken(res, { location: bookingLocation, range, config, catalog, leadId: lead.id });

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
    const result = await bookAssessmentVisit({ booking, date, bookingSlot, custRow, catalog, bookingLocation });

    if (!result.ok) {
      return sendBookingFailure(res, result, { lead, custRow, leadPayload, bookingLocation, range, config, catalog });
    }

    return res.json(await finishCommittedBooking({ result, notes, date, bookingSlot }));
  } catch (err) {
    next(err);
  }
});

router.post('/:token/waitlist', findSlotsLimiter, async (req, res, next) => {
  if (!leadInspectionLinkLive()) return res.status(404).json({ error: 'not_found' });
  // Token before body validation (Codex #4737 r1 P0): an invalid token
  // always gets the generic 404, never a validation 400.
  const verified = verifyLeadConsultationToken(req.params.token);
  if (!verified) return res.status(404).json({ error: 'not_found' });
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email is required' });
  }

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

    // The expansion interest itself lives on the LEAD (local audit P1): the
    // subscriber insert above is ignored for an email already on file
    // (active, unsubscribed, or an earlier waitlist row), and that row's
    // consent/opt-out must stay exactly as it is. This activity row is
    // always written, so the request is never silently lost.
    await db('lead_activities').insert({
      lead_id: lead.id,
      activity_type: 'expansion_waitlist',
      description: `Asked to hear when Waves serves ${county || 'their area'}`,
      performed_by: 'consultation_page',
      metadata: JSON.stringify({ email, county: county || null }),
    });

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
