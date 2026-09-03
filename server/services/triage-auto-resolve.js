/**
 * Triage auto-resolve sweep — the dead-letter drain.
 *
 * Why this exists: triage_items had accumulated ~1,800 open cards against 32
 * ever resolved (2026-05-28 → 07-30). Nothing ages out, and the only paths
 * off the queue are per-card human verdicts — so genuinely actionable cards
 * (a confirmed-but-unbooked callback, an owed quote) drown among hundreds of
 * advisory flags whose moment has passed. The queue must be a park for
 * EXCEPTIONS, not a landfill.
 *
 * Policy (owner rule: hands-off + exception-based — deterministic green
 * auto-applies with an audit trail, exceptions stay parked):
 *
 *   RESOLVE (the flagged condition is PROVABLY moot now):
 *   - address flags → a trusted, pre-existing, live customer record has a
 *     service address on file AND the call supplied no address of its own
 *   - missing_last_name → a trusted, pre-existing, live customer record has
 *     a surname the call did not itself supply, for a caller whose first
 *     name agrees with that record
 *   (Scheduling-doubt cards get NO booking-based auto-resolution from call
 *   linkage alone: linkage timestamps can't distinguish a current routing
 *   outcome from a stale pre-reprocess booking. The evidence rule below
 *   beats that only by requiring the booking to postdate the CARD.)
 *
 *   RESOLVE ON EVIDENCE (GATE_TRIAGE_AUTO_RESOLVE_EVIDENCE, layered on the
 *   gate above — the owed action was PERFORMED after the card was filed):
 *   - quote_promised → an estimate DIRECTLY linked to the call (estimator
 *     stamp / minted-lead FK) delivered after the card
 *   - email_unverified → the call-captured address opened/clicked a later
 *     message (delivery alone proves only that a mailbox exists)
 *   - caller_not_authorized → a human added the caller's number as a
 *     service contact after the card, and it is on a slot now
 *   - not_confirmed → a live booking created after the card: this call's
 *     own (source_call_log_id), or a same-customer one inside the requested
 *     window for the requested service on a single-property account
 *   - address flags → a visit COMPLETED after the card for a single-property
 *     customer whose on-file street matches every address the call named
 *
 *   DISMISS (informational card aged out unactioned):
 *   - spam_or_wrong_number after SPAM_AGE_DAYS
 *   - listed informational flags after ADVISORY_AGE_DAYS
 *   Dismissed — not resolved — deliberately: knowledge-index
 *   resolution-sync builds learning artifacts from RESOLVED cards only, and
 *   an aged-out card carries no resolution knowledge.
 *
 *   NEVER TOUCHED (fail-closed allowlist — any reason_code not explicitly
 *   listed is skipped): owed-work and held-booking cards (quote_promised,
 *   cancellation_request, after_hours_emergency, prior_complaint_unresolved,
 *   commercial_requires_quote, auto_booking_skipped_after_approval, the
 *   existing-appointment holds, outbound_booking_review, …),
 *   email_bounce_reverify (owns its lifecycle in email-bounce-reverify.js),
 *   extraction/v2 failures, and anything in_progress (human-claimed).
 *
 * Mirrors the event-driven auto-resolution precedent (outbound-review-confirm,
 * customer-email-fanout, the processor's hallucination dismissal) including
 * the call_log.review_status re-sync that admin-triage's transitionCore does.
 * Dark by default behind GATE_TRIAGE_AUTO_RESOLVE; writes only triage_items
 * transitions + call_log.review_status. Kill switch: unset the gate.
 */

const db = require('../models/db');
const logger = require('./logger');
const { lockTriageCall } = require('../utils/triage-locks');
const { etCalendarDayOf } = require('../utils/datetime-et');

const SPAM_AGE_DAYS = 7;
const ADVISORY_AGE_DAYS = 30;
// Per-run transition cap: the historical backlog drains over a few nightly
// runs instead of one giant write burst (also bounds the knowledge-index
// re-sync triggered by updated_at bumps).
const MAX_TRANSITIONS_PER_RUN = 500;

const ADDRESS_MOOT_CODES = new Set([
  'missing_service_address', 'low_confidence_address', 'address_unverifiable',
  'address_unverified', 'address_validation_unavailable',
]);
// missing_unit_number is deliberately NOT address-moot: the moot rule fires on
// street + zip existing on file, and a multi-unit building address has both
// while the unit is still uncollected — the ask stands until performed.
//
// It gets NO event-driven auto-resolution either (unlike the email cards). A
// later call validating some unit at the same building does not answer THIS
// call's ask: a landlord whose first call was about unit A without naming it,
// followed by a call about unit B, would have A's task closed by B's
// acceptance. Nothing in the data ties an accepted unit to a specific earlier
// unit-less ask — the earlier extraction has no unit by definition. So the
// card is a human verdict, exactly like its siblings in the owed-confirmation
// list below.

// Mirror of FAIL_OPEN_CUSTOMER_STAGES in call-recording-processor.js: only
// these pipeline stages carry a trustworthy on-file address. Terminal and
// dormant records (lost, disqualified, duplicate, churned, …) hold stale
// data that routing deliberately refuses to recover from — the sweep must
// not treat it as authoritative either.
const TRUSTED_CUSTOMER_STAGES = new Set(['active_customer', 'won', 'at_risk']);

// Informational flags with no owed work attached — they inform a record edit
// or a callback that either happened long ago or never will. Aged cards keep
// their payload (nothing is deleted) and dedup re-arms on terminal status,
// so a recurrence files a fresh card.
//
// Age dismissal additionally requires the ROW's severity = 'advisory': the
// same reason code can be inserted blocking at one site and advisory at
// another (insert-site severity in call-recording-processor), and a blocking
// card is owed review no matter how old it gets.
//
// NOT listed on purpose — advisory-by-design cards that carry an OWED
// office confirmation which stands until performed, no matter how old
// (an appointment booked 30+ days out still needs its read-back):
// address_recovered / address_readback (street read-back before the visit),
// caller_phone_not_on_file (identity check before the ANI is saved),
// email_unverified / email_invalid (dictated-email read-back; fanout
// resolves them on correction), implied_consent_non_ani_recipient
// (recipient confirmation before the held SMS), caller_not_authorized
// (account-holder confirmation), rental_or_tenant_occupied (access/
// property confirmation), second_service_address and
// secondary_contact_captured (captured data awaiting application),
// missing_last_name (owed full-name capture — the name_moot rule closes it
// on independent surname evidence), missing_unit_number (owed unit capture
// for a multi-unit building — street+zip on file does NOT answer it), and
// the fail-open confirmation pair
// low_extraction_confidence / name_email_mismatch (the office owes
// confirming the doubted fields; analogous to email_unverified).
//
// What remains is purely informational: multi-property mentions, the
// SMS-only consent-capture notes (consent enforcement lives in the
// messaging validators, not this card), and voicemail markers.
const ADVISORY_AGE_CODES = new Set([
  'multi_property_call',
  'no_sms_consent_captured', 'sms_consent_missing',
  'voicemail',
]);

const RULE_NOTES = {
  address_moot: 'Auto-resolved: customer record now has a service address on file (street + zip); address flag is moot.',
  name_moot: 'Auto-resolved: customer record now has a last name; flag is moot.',
  // Evidence rules (GATE_TRIAGE_AUTO_RESOLVE_EVIDENCE) — each proves the
  // owed action was PERFORMED after the card was filed.
  quote_fulfilled: 'Auto-resolved: an estimate linked to this call was delivered after the call; the promised quote went out.',
  email_engaged: 'Auto-resolved: the email captured on this call opened or clicked a later message; the read-back is moot.',
  caller_phone_added: "Auto-resolved: the caller's number was added as a service contact on the account after this call.",
  booking_created: 'Auto-resolved: a live appointment matching the requested window was booked after this card was filed.',
  visit_completed_at_address: 'Auto-resolved: a visit was completed at the address this call named; the address is proven.',
  spam_aged: `Auto-dismissed: spam/wrong-number advisory unactioned after ${SPAM_AGE_DAYS} days.`,
  advisory_aged: `Auto-dismissed: informational flag unactioned after ${ADVISORY_AGE_DAYS} days.`,
};

// scheduled_services statuses that are a booking still going to happen or
// one that did (scheduled_services_status_check minus cancelled /
// rescheduled / skipped / no_show).
const LIVE_BOOKING_STATUSES = new Set(['pending', 'confirmed', 'en_route', 'on_site', 'completed']);
// service-contact-events `source` values written by a person: the admin
// customer PUT and the portal account-holder save. 'call' (pipeline) and
// 'dedupe' / 'dedupe_undo' (merges) are automated.
const HUMAN_CONTACT_SOURCES = new Set(['admin', 'portal']);
// Category words too generic to prove a visit is for the requested service.
const SERVICE_STOPWORDS = new Set(['control', 'care', 'service', 'services', 'treatment', 'general', 'and', 'the', 'of']);

function parseMaybeJson(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined; // unparseable — callers fail closed
  }
}

function toDate(value) {
  const d = value ? new Date(value) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

function strictlyAfter(value, boundary) {
  const a = toDate(value);
  const b = toDate(boundary);
  return Boolean(a && b && a > b);
}

// The shared suffix-canonical, unit-stripped street key (customer-properties):
// "1234 Palm Ave" == "1234 Palm Avenue Unit 2", but != "1234 Palm St". Heard
// addresses may carry a trailing ", City" — only the street segment keys.
// Null unless it starts with a house number (a bare street proves nothing).
function addressKey(text) {
  const { streetKey } = require('./customer-properties');
  const street = String(text || '').split(',')[0].trim();
  if (!/^\d/.test(street)) return null;
  return streetKey(street) || null;
}

// Every address the CALL supplied (payload as-heard, V2 street/raw, V1
// street) must agree with the on-file street address. Fail closed: no heard
// address (nothing to prove), an unparseable extraction, or any heard
// address that keys differently keeps the card.
function heardAddressMatchesOnFile(item) {
  const onFile = addressKey(item.customer_address_line1);
  if (!onFile) return false;
  const heard = [];
  const payload = parseMaybeJson(item.payload);
  if (payload === undefined) return false;
  if (payload?.address_as_heard) heard.push(payload.address_as_heard);
  const v2 = parseMaybeJson(item.call_extraction);
  if (v2 === undefined) return false;
  const addr = v2?.property?.service_address || {};
  if (addr.street_line_1) heard.push(addr.street_line_1);
  if (addr.raw_text) heard.push(addr.raw_text);
  const v1 = parseMaybeJson(item.call_extraction_v1);
  if (v1 === undefined) return false;
  if (v1?.address_line1) heard.push(v1.address_line1);
  const heardValues = heard.map((h) => String(h || '').trim()).filter(Boolean);
  if (!heardValues.length) return false;
  // Every heard value must key AND agree — one unkeyable representation
  // (a bare street, a fragment) is unverified evidence, not ignorable.
  return heardValues.every((h) => addressKey(h) === onFile);
}

// The requested service categories the CARD snapshotted at filing time
// (call-routing-gates writes scheduling_window.requested_service_categories),
// as match tokens. Never the call's ai_extraction_enriched: that column is a
// rolling snapshot a force-reprocess overwrites while the open card keeps
// its original ask. A card filed before the snapshot existed yields no
// tokens, so its association arm stays closed.
function requestedServiceTokens(item) {
  const payload = parseMaybeJson(item.payload);
  const cats = payload?.scheduling_window?.requested_service_categories;
  if (!Array.isArray(cats)) return [];
  const tokens = new Set();
  for (const c of cats) {
    for (const t of String(c || '').toLowerCase().split(/[^a-z]+/)) {
      if (t && !SERVICE_STOPWORDS.has(t)) tokens.add(t);
    }
  }
  return [...tokens];
}

function serviceTypeMatches(serviceType, requestedTokens) {
  if (!requestedTokens.length) return false;
  const words = new Set(String(serviceType || '').toLowerCase().split(/[^a-z]+/).filter(Boolean));
  return requestedTokens.some((t) => words.has(t));
}

// The calendar days (ET, YYYY-MM-DD) the caller asked for, from the card's
// scheduling payload. Inclusive; a single requested date is a one-day window.
function requestedWindow(item) {
  const payload = parseMaybeJson(item.payload);
  const w = payload?.scheduling_window || {};
  const startRaw = w.confirmed_start_at || w.requested_date_range_start;
  if (!startRaw || !toDate(startRaw)) return null;
  const start = etCalendarDayOf(startRaw);
  const end = w.requested_date_range_end && toDate(w.requested_date_range_end) ? etCalendarDayOf(w.requested_date_range_end) : start;
  return end >= start ? { start, end } : { start: end, end: start };
}

function phoneDigits(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

function callerPhone(item) {
  return String(item.call_direction || '').startsWith('outbound') ? item.call_to_phone : item.call_from_phone;
}

// Is the caller's number on one of the account's five phone slots now?
// Mirror of the processor's caller_phone_not_on_file identity check.
function callerPhoneOnFile(item) {
  const ani = phoneDigits(callerPhone(item));
  if (!ani) return false;
  return [
    item.customer_phone, item.customer_service_contact_phone,
    item.customer_service_contact2_phone, item.customer_service_contact3_phone,
    item.customer_secondary_phone,
  ].some((slot) => phoneDigits(slot) === ani);
}

// The address THIS card is about: the release target the processor
// snapshotted onto the card at filing time (payload.email_release_target).
// Never the card's email_candidates (alternative spellings awaiting the
// read-back — one may be another customer's real address), never the hold's
// held_email (mutable: fanout retargets it when the customer's email
// changes), never the call's rolling extraction columns. A card filed
// without a target (the dictation demoted every reading, or it predates
// the snapshot) has no evidence and waits for a human.
function capturedEmails(item) {
  const payload = parseMaybeJson(item.payload);
  const e = String(payload?.email_release_target || '').trim().toLowerCase();
  return e ? [e] : [];
}

function ageDays(createdAt, now) {
  const created = createdAt ? new Date(createdAt) : null;
  if (!created || Number.isNaN(created.getTime())) return 0;
  return (now.getTime() - created.getTime()) / (24 * 3600 * 1000);
}

// Did THIS call supply new address evidence (heard address, recovery
// candidates)? The routing guard (call-triage-flags.js fail-open recovery)
// only falls back to the on-file address when the call carried no new
// address — mirror that: a card holding a NEW address for validation must
// not be resolved just because the customer's unrelated primary address
// exists. Base-payload cards ({flag, confidence, scheduling_status}) carry
// no such evidence and stay moot-eligible.
function hasNewAddressEvidence(payloadRaw) {
  let payload = payloadRaw;
  if (!payload) return false;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      return true; // unparseable → fail closed, keep the card
    }
  }
  return Boolean(
    payload.address_as_heard
    || (Array.isArray(payload.address_candidates) && payload.address_candidates.length)
    || payload.address_recovered,
  );
}

// Did the CALL's own extractions supply a service address? The blocking-loop
// insert sites create address cards with BASE payloads (no address fields),
// so the payload check above cannot see the held-for-validation case there —
// the authoritative signals are the stored extractions. BOTH are checked:
// the V1↔V2 bridge deliberately opens a blocking address_unverified card
// when V2 heard no address but V1 captured one, so V2 alone would wrongly
// prove "no address supplied" exactly there. Fail closed: a missing V2 or
// an unparseable extraction keeps the card (we cannot prove the call
// supplied nothing).
function callSuppliedAddress(v2Raw, v1Raw) {
  let v2 = v2Raw;
  if (!v2) return true;
  if (typeof v2 === 'string') {
    try {
      v2 = JSON.parse(v2);
    } catch {
      return true;
    }
  }
  // Full component set of the routing guard — partial evidence (a unit /
  // street_line_2 or a subdivision alone) is still NEW location evidence
  // that holds the card for review.
  const addr = v2?.property?.service_address || {};
  if (String(addr.raw_text || '').trim()
      || String(addr.street_line_1 || '').trim()
      || String(addr.street_line_2 || '').trim()
      || String(addr.city || '').trim()
      || String(addr.postal_code || '').trim()
      || String(addr.subdivision_or_community || '').trim()) {
    return true;
  }
  // V1 (legacy flat shape): a null V1 means no legacy evidence to consult;
  // an unparseable one fails closed.
  let v1 = v1Raw;
  if (v1 == null) return false;
  if (typeof v1 === 'string') {
    try {
      v1 = JSON.parse(v1);
    } catch {
      return true;
    }
  }
  return Boolean(
    String(v1?.address_line1 || '').trim()
    // A unit alone ("it's Unit B at the same street") is new partial
    // address evidence — the routing demotion treats address_line2 as such.
    || String(v1?.address_line2 || '').trim()
    || String(v1?.city || '').trim()
    || String(v1?.zip || '').trim(),
  );
}

// Does the caller's heard FIRST name agree with the linked customer record?
// The phone matcher deliberately falls back to the sole phone owner even
// when name matching fails — a spouse or new phone owner can be linked to
// an account whose surname is not theirs, and that surname must not moot
// the caller's own full-name task. Fail closed: no heard first name or an
// unparseable extraction keeps the card.
function callerMatchesCustomerFirstName(item) {
  const onFile = String(item.customer_first_name || '').trim().toLowerCase();
  if (!onFile) return false;
  const heard = [];
  for (const raw of [item.call_extraction_v1, item.call_extraction]) {
    if (raw == null) continue;
    let parsed = raw;
    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        return false;
      }
    }
    const v1Name = String(parsed?.first_name || '').trim().toLowerCase();
    const v2Name = String(parsed?.caller?.first_name || '').trim().toLowerCase();
    if (v1Name) heard.push(v1Name);
    if (v2Name) heard.push(v2Name);
  }
  return heard.length > 0 && heard.includes(onFile);
}

// Was the customer record created BEFORE this call? If the record was born
// from (or after) the call, its on-file address most plausibly came from
// this very call's unvalidated extraction — resolving the card against it
// would be circular. Fail closed on missing timestamps.
function customerPredatesCall(item) {
  const cust = item.customer_created_at ? new Date(item.customer_created_at) : null;
  const call = item.call_created_at ? new Date(item.call_created_at) : null;
  if (!cust || !call || Number.isNaN(cust.getTime()) || Number.isNaN(call.getTime())) return false;
  return cust < call;
}

// Did this call CONFIRM an appointment that never became a booking? With
// GATE_CALL_FAIL_OPEN_BOOKING off, a confirmed call from an existing
// customer can be held solely on its address card — that card is then the
// ONLY visible trace of the lost booking, and resolving it as "address
// moot" would hide a confirmed-but-unbooked appointment. Fail closed on an
// unparseable extraction.
function callConfirmedUnbooked(item, ctx) {
  let v2 = item.call_extraction;
  if (!v2) return false; // no V2 → no confirmed-slot claim to protect
  if (typeof v2 === 'string') {
    try {
      v2 = JSON.parse(v2);
    } catch {
      return true;
    }
  }
  if (v2?.scheduling?.status !== 'confirmed') return false;
  return !ctx.bookedCallIds.has(item.call_log_id);
}

// Does the customer's current surname match what THIS call's extractions
// heard? backfillCustomerFromAppointmentContact writes last_name onto even
// PRE-EXISTING customers from the call's merged extraction (a V1-only
// surname survives the merge while V2 emits missing_last_name) — a matching
// surname is therefore not independent evidence. Fail closed on an
// unparseable extraction.
function surnameCameFromCall(item) {
  const onFile = String(item.customer_last_name || '').trim().toLowerCase();
  if (!onFile) return false;
  const heard = [];
  for (const raw of [item.call_extraction_v1, item.call_extraction]) {
    if (raw == null) continue;
    let parsed = raw;
    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        return true;
      }
    }
    const v1Name = String(parsed?.last_name || '').trim().toLowerCase();
    const v2Name = String(parsed?.caller?.last_name || '').trim().toLowerCase();
    if (v1Name) heard.push(v1Name);
    if (v2Name) heard.push(v2Name);
  }
  return heard.includes(onFile);
}

// Pure classifier, exported for tests. `item` is a triage_items row joined
// with its call's customer fields; `ctx.bookedCallIds` is a Set of
// call_log_ids that have a scheduled_services row via source_call_log_id.
// Returns { action: 'resolve'|'dismiss', rule } or null (untouched).
// Order matters: moot-condition resolves outrank age-based dismissal so a
// card that is BOTH old and moot records the real reason it closed.
function classifyTriageItem(item, ctx, { now = new Date() } = {}) {
  if (item.status !== 'open') return null;
  const code = item.reason_code;

  // Address cards are moot ONLY for a customer who existed before the call,
  // has a full on-file address, and whose call supplied no address of its
  // own (payload evidence AND the call's extraction both empty) — the
  // mirror of the routing guard's on-file-address recovery condition. A
  // call that DID state an address keeps its card held for validation.
  if (ADDRESS_MOOT_CODES.has(code)
      && !item.customer_deleted_at
      && TRUSTED_CUSTOMER_STAGES.has(String(item.customer_pipeline_stage || '').trim().toLowerCase())
      && customerPredatesCall(item)
      && !hasNewAddressEvidence(item.payload)
      && !callSuppliedAddress(item.call_extraction, item.call_extraction_v1)
      && !callConfirmedUnbooked(item, ctx)
      && String(item.customer_address_line1 || '').trim() !== ''
      && String(item.customer_zip || '').trim() !== '') {
    return { action: 'resolve', rule: 'address_moot' };
  }
  // Same provenance guards as addresses: a customer created FROM this call
  // — or a pre-existing one whose surname was BACKFILLED from this call's
  // merged extraction — cannot moot its own identity card. Only a surname
  // that predates the call (record older than the call AND not matching
  // what the call heard) is independent evidence.
  if (code === 'missing_last_name'
      && !item.customer_deleted_at
      && TRUSTED_CUSTOMER_STAGES.has(String(item.customer_pipeline_stage || '').trim().toLowerCase())
      && customerPredatesCall(item)
      && callerMatchesCustomerFirstName(item)
      && !surnameCameFromCall(item)
      && String(item.customer_last_name || '').trim() !== '') {
    return { action: 'resolve', rule: 'name_moot' };
  }
  // Evidence rules: ctx.evidence is the per-item proof map loadEvidence()
  // built (empty when GATE_TRIAGE_AUTO_RESOLVE_EVIDENCE is off, so none of
  // these can fire). Each flag is true only when the proof postdates the
  // CARD — see loadEvidence for the exact predicates.
  const ev = ctx.evidence instanceof Map ? ctx.evidence.get(item.id) : null;
  if (ev) {
    if (code === 'quote_promised' && ev.estimate_direct) {
      return { action: 'resolve', rule: 'quote_fulfilled' };
    }
    if (code === 'email_unverified' && ev.email_engaged) {
      return { action: 'resolve', rule: 'email_engaged' };
    }
    if (code === 'caller_not_authorized' && ev.caller_phone_added && callerPhoneOnFile(item)) {
      return { action: 'resolve', rule: 'caller_phone_added' };
    }
    if (code === 'not_confirmed' && ev.booking_after_card) {
      return { action: 'resolve', rule: 'booking_created' };
    }
    if (ADDRESS_MOOT_CODES.has(code)
        && !item.customer_deleted_at
        && ev.visit_completed_at_address
        && heardAddressMatchesOnFile(item)) {
      return { action: 'resolve', rule: 'visit_completed_at_address' };
    }
  }
  if (code === 'spam_or_wrong_number'
      && ageDays(item.created_at, now) >= SPAM_AGE_DAYS) {
    return { action: 'dismiss', rule: 'spam_aged' };
  }
  if (ADVISORY_AGE_CODES.has(code)
      && item.severity === 'advisory'
      && ageDays(item.created_at, now) >= ADVISORY_AGE_DAYS) {
    return { action: 'dismiss', rule: 'advisory_aged' };
  }
  return null;
}

async function runTriageAutoResolve({ now = new Date() } = {}) {
  const { isEnabled } = require('../config/feature-gates');
  if (!isEnabled('triageAutoResolve')) {
    return { skipped: true, reason: 'gated_off' };
  }
  const { runExclusive } = require('../utils/cron-lock');
  return runExclusive('triage-auto-resolve', () => sweep({ now }));
}

// The joined evidence rows the classifier consumes. OPEN only —
// in_progress is human-claimed and must never be swept. With `itemIds`,
// reloads exactly those cards (still open-only) — used for the locked
// revalidation pass.
function loadCandidateItems(conn, itemIds = null) {
  const q = conn('triage_items as t')
    .leftJoin('call_log as cl', 'cl.id', 't.call_log_id')
    .leftJoin('customers as c', 'c.id', 'cl.customer_id')
    .where('t.status', 'open')
    .select(
      't.id', 't.call_log_id', 't.reason_code', 't.status', 't.severity',
      't.created_at', 't.payload',
      'cl.created_at as call_created_at',
      'cl.ai_extraction_enriched as call_extraction',
      'cl.ai_extraction as call_extraction_v1',
      // Evidence-rule inputs: the call's identity for the estimate linkage
      // (call-commitments' resolveFulfillment reads these) and the caller's
      // number for the phone-slot check.
      'cl.customer_id as call_customer_id',
      'cl.direction as call_direction',
      'cl.from_phone as call_from_phone',
      'cl.to_phone as call_to_phone',
      'cl.duration_seconds as call_duration_seconds',
      'cl.bridged_at as call_bridged_at',
      'cl.twilio_call_sid as call_twilio_call_sid',
      'cl.metadata as call_metadata',
      'c.created_at as customer_created_at',
      'c.deleted_at as customer_deleted_at',
      'c.pipeline_stage as customer_pipeline_stage',
      'c.address_line1 as customer_address_line1',
      'c.zip as customer_zip',
      'c.first_name as customer_first_name',
      'c.last_name as customer_last_name',
      'c.phone as customer_phone',
      'c.service_contact_phone as customer_service_contact_phone',
      'c.service_contact2_phone as customer_service_contact2_phone',
      'c.service_contact3_phone as customer_service_contact3_phone',
      'c.secondary_phone as customer_secondary_phone',
    );
  if (itemIds) q.whereIn('t.id', itemIds);
  return q;
}

const EVIDENCE_CODES = new Set([
  'quote_promised', 'email_unverified', 'caller_not_authorized', 'not_confirmed',
  ...ADDRESS_MOOT_CODES,
]);

// Per-item proof map for the evidence rules. Every predicate compares
// against the CARD's created_at (strict >): evidence that predates the card
// — including anything the filing pass itself wrote — never counts. Empty
// when the evidence gate is off. With `lock`, the scheduled_services rows
// that prove a booking/visit are held FOR UPDATE until commit, the same
// contract loadBookedCallIds applies.
async function loadEvidence(conn, items, { lock = false } = {}) {
  const evidence = new Map();
  const { isEnabled } = require('../config/feature-gates');
  if (!isEnabled('triageAutoResolveEvidence')) return evidence;
  const candidates = items.filter((i) => EVIDENCE_CODES.has(i.reason_code) && i.status === 'open');
  if (!candidates.length) return evidence;
  const flag = (id, key) => {
    const cur = evidence.get(id) || {};
    cur[key] = true;
    evidence.set(id, cur);
  };

  // quote_promised → an estimate DIRECTLY linked to this call, delivered
  // after the CARD (call-commitments' batched direct routes — three queries
  // for the whole backlog, each card its own boundary; association-strength
  // matches — same customer, unlinked — are ignored on purpose).
  const quoteItems = candidates.filter((i) => i.reason_code === 'quote_promised');
  if (quoteItems.length) {
    const { directEstimatesSentAfter } = require('./call-commitments');
    try {
      const proofs = await directEstimatesSentAfter(conn, quoteItems.map((item) => ({
        key: item.id,
        callId: item.call_log_id,
        twilioCallSid: item.call_twilio_call_sid,
        after: new Date(Math.max(toDate(item.created_at)?.getTime() || 0, toDate(item.call_created_at)?.getTime() || 0)),
      })));
      for (const item of quoteItems) {
        const proof = proofs.get(item.id);
        if (proof && strictlyAfter(proof.matched_at, item.created_at)) flag(item.id, 'estimate_direct');
      }
    } catch (err) {
      logger.warn(`[triage-sweep] estimate evidence lookup failed: ${err.message}`);
    }
  }

  // email_unverified → the card's release target ENGAGED (opened/clicked — a
  // delivery alone only proves some mailbox exists) with a message SENT
  // after the card (an older message opened later proves nothing about
  // this call's capture), and never bounced/complained.
  const emailItems = candidates.filter((i) => i.reason_code === 'email_unverified');
  const emailsByItem = new Map(emailItems.map((i) => [i.id, capturedEmails(i)]));
  const allEmails = [...new Set([...emailsByItem.values()].flat())];
  if (allEmails.length) {
    const rows = await conn('email_messages')
      .whereRaw('LOWER(recipient_email_snapshot) IN (' + allEmails.map(() => '?').join(', ') + ')', allEmails)
      .whereNotNull('sent_at')
      .whereNull('bounced_at')
      .whereNull('complained_at')
      .whereNotIn('status', ['bounced', 'failed', 'complained', 'dropped'])
      .where(function engaged() {
        this.whereNotNull('opened_at').orWhereNotNull('clicked_at');
      })
      .select('recipient_email_snapshot', 'sent_at', 'opened_at', 'clicked_at');
    for (const item of emailItems) {
      const mine = new Set(emailsByItem.get(item.id));
      const hit = rows.some((r) => mine.has(String(r.recipient_email_snapshot || '').toLowerCase())
        && strictlyAfter(r.sent_at, item.created_at)
        && (strictlyAfter(r.opened_at, item.created_at) || strictlyAfter(r.clicked_at, item.created_at)));
      if (hit) flag(item.id, 'email_engaged');
    }
  }

  // caller_not_authorized → a HUMAN (admin or portal account holder — never
  // the call pipeline or a dedupe merge) added/updated a service contact
  // whose number ends in the caller's last four after the card (service-
  // contact-events writes the masked number and the source to
  // activity_log.metadata). The classifier additionally requires the number
  // to be on a slot NOW.
  const authItems = candidates.filter((i) => i.reason_code === 'caller_not_authorized' && i.call_customer_id);
  if (authItems.length) {
    const rows = await conn('activity_log')
      .whereIn('customer_id', [...new Set(authItems.map((i) => i.call_customer_id))])
      .whereIn('action', ['service_contact_added', 'service_contact_updated'])
      .select('customer_id', 'action', 'created_at', 'metadata');
    for (const item of authItems) {
      const last4 = phoneDigits(callerPhone(item)).slice(-4);
      if (last4.length !== 4) continue;
      const hit = rows.some((r) => {
        if (String(r.customer_id) !== String(item.call_customer_id)) return false;
        if (!strictlyAfter(r.created_at, item.created_at)) return false;
        const meta = parseMaybeJson(r.metadata);
        if (!HUMAN_CONTACT_SOURCES.has(String(meta?.source || ''))) return false;
        // An update event also fires for name/email/role-only edits and still
        // carries the unchanged phone — only a phone change is evidence.
        if (r.action === 'service_contact_updated'
          && !(Array.isArray(meta?.changed_fields) && meta.changed_fields.includes('phone'))) return false;
        return String(meta?.phone || '').slice(-4) === last4;
      });
      if (hit) flag(item.id, 'caller_phone_added');
    }
  }

  // Bookings and visits for the not_confirmed / address arms.
  const visitItems = candidates.filter((i) => (i.reason_code === 'not_confirmed' || ADDRESS_MOOT_CODES.has(i.reason_code)) && i.call_customer_id);
  if (visitItems.length) {
    const customerIds = [...new Set(visitItems.map((i) => i.call_customer_id))];
    const propertyIds = new Map();
    const propertyKeys = new Map();
    const propRows = await conn('customer_properties')
      .whereIn('customer_id', customerIds)
      .select('id', 'customer_id', 'address_line1');
    for (const r of propRows) {
      const list = propertyIds.get(String(r.customer_id)) || [];
      list.push(String(r.id));
      propertyIds.set(String(r.customer_id), list);
      propertyKeys.set(String(r.id), addressKey(r.address_line1));
    }
    const multiProperty = (customerId) => (propertyIds.get(String(customerId)) || []).length > 1;

    const q = conn('scheduled_services')
      .whereIn('customer_id', customerIds)
      .whereNull('parent_service_id')
      // Positive allowlist: a live booking is one that is still going to
      // happen or did happen. cancelled / rescheduled / skipped / no_show
      // rows prove nothing.
      .whereIn('status', [...LIVE_BOOKING_STATUSES])
      .orderBy('id', 'asc')
      .select('id', 'customer_id', 'source_call_log_id', 'status', 'service_type', 'scheduled_date', 'created_at', 'completed_at', 'service_address_line1', 'property_id');
    if (lock) q.forUpdate();
    const visits = await q;

    for (const item of visitItems) {
      const mine = visits.filter((v) => String(v.customer_id) === String(item.call_customer_id));
      if (item.reason_code === 'not_confirmed') {
        // Direct: a live booking THIS call minted, created after the card
        // (a booking that predates the card belongs to an earlier pass of
        // the same call and is exactly the stale-provenance case the header
        // refuses to trust).
        const direct = mine.some((v) => String(v.source_call_log_id) === String(item.call_log_id)
          && strictlyAfter(v.created_at, item.created_at));
        if (direct) {
          flag(item.id, 'booking_after_card');
          continue;
        }
        // Association: single-property customer, booking created after the
        // card, inside the requested window, for the requested service.
        if (multiProperty(item.call_customer_id)) continue;
        const window = requestedWindow(item);
        if (!window) continue;
        const tokens = requestedServiceTokens(item);
        const assoc = mine.some((v) => {
          if (!strictlyAfter(v.created_at, item.created_at) || !toDate(v.scheduled_date)) return false;
          // Inside the requested days exactly — no association horizon
          // around them, or an unrelated recurring visit nearby would count.
          const day = etCalendarDayOf(v.scheduled_date);
          return day >= window.start && day <= window.end && serviceTypeMatches(v.service_type, tokens);
        });
        if (assoc) flag(item.id, 'booking_after_card');
      } else {
        // Address cards: a visit COMPLETED after the card for a
        // single-property customer. The classifier adds the heard-address
        // ↔ on-file street match.
        if (multiProperty(item.call_customer_id)) continue;
        const onFile = addressKey(item.customer_address_line1);
        if (!onFile) continue;
        const ownProperties = propertyIds.get(String(item.call_customer_id)) || [];
        const done = mine.some((v) => {
          if (v.status !== 'completed' || !strictlyAfter(v.completed_at, item.created_at)) return false;
          // POSITIVE linkage to the on-file address, or nothing: the visit's
          // effective address is its stamped service_address_* when present,
          // else the address of the account's own property row it points
          // at. A visit with neither is only associated with the customer
          // and proves nothing about where service happened.
          if (v.service_address_line1) return addressKey(v.service_address_line1) === onFile;
          if (!v.property_id || !ownProperties.includes(String(v.property_id))) return false;
          return propertyKeys.get(String(v.property_id)) === onFile;
        });
        if (done) flag(item.id, 'visit_completed_at_address');
      }
    }
  }
  return evidence;
}

async function sweep({ now = new Date() } = {}) {
  const items = await loadCandidateItems(db);

  // Booking provenance (live source-linked rows only — the canonical
  // lookup's predicates: no cancelled/rescheduled rows, no follow-up
  // children) feeds the confirmed-unbooked address guard.
  const loadBookedCallIds = async (conn, callIds, { lock = false } = {}) => {
    const set = new Set();
    if (!callIds.length) return set;
    const q = conn('scheduled_services')
      .whereIn('source_call_log_id', callIds)
      .whereNull('parent_service_id')
      .whereNotIn('status', ['cancelled', 'rescheduled'])
      .orderBy('id', 'asc')
      .select('source_call_log_id');
    // Under the apply transaction the qualifying booking rows are HELD until
    // commit — a scheduling writer cancelling one blocks and lands after us,
    // where the booking-miss watchdog picks up the newly-unbooked state.
    if (lock) q.forUpdate();
    const booked = await q;
    for (const b of booked) set.add(b.source_call_log_id);
    return set;
  };
  const allItemCallIds = [...new Set(items.map((i) => i.call_log_id))];
  const bookedCallIds = await loadBookedCallIds(db, allItemCallIds);
  const evidence = await loadEvidence(db, items);

  const decisions = [];
  for (const item of items) {
    const decision = classifyTriageItem(item, { bookedCallIds, evidence }, { now });
    if (decision) decisions.push({ item, ...decision });
  }
  const applied = decisions.slice(0, MAX_TRANSITIONS_PER_RUN);
  const deferred = decisions.length - applied.length;

  // Apply per rule in batched CAS updates (status='open' re-checked at write
  // time — an operator or event-driven resolver may have raced us). Touched
  // calls derive from RETURNING on the successful update only: a decision
  // whose row lost the race must not drive the review_status sync.
  //
  // The whole apply phase — transitions AND the review_status sync — runs in
  // ONE transaction: a crash between them would otherwise strand terminal
  // cards under a call still marked 'open', and the next sweep (which scans
  // only open cards) could never repair the stale aggregate. A failure rolls
  // everything back; the nightly rerun is idempotent.
  const counts = {};
  let callsSynced = 0;
  const itemCallById = new Map(applied.map((d) => [d.item.id, d.item.call_log_id]));
  await db.transaction(async (trx) => {
    // Per-call ADVISORY locks first (sorted), then the row pre-locks — the
    // shared lockTriageCall contract with admin-triage's transitionCore and
    // verdict writers. Ordering our own row locks was not enough: the admin
    // verdict's bulk UPDATE acquires siblings in planner order, so only a
    // common per-call lock taken by BOTH writers before any card write
    // removes the deadlock and the interleaved-count aggregate race.
    const allCallIds = [...new Set(applied.map((d) => d.item.call_log_id))].sort();
    for (const callLogId of allCallIds) {
      await lockTriageCall(trx, callLogId);
    }
    if (allCallIds.length) {
      await trx('triage_items')
        .whereIn('call_log_id', allCallIds)
        .orderBy('id', 'asc')
        .forUpdate()
        .select('id');
    }
    // Re-verify every decision UNDER the locks from FRESH evidence — the
    // pre-lock classification is a candidate list, not a verdict. Both the
    // joined card/call/customer rows (a customer soft-deleted, demoted, or
    // stripped of the address/surname in the gap must re-arm its guards)
    // and booking provenance (rows held FOR UPDATE until commit, so
    // scheduling writers serialize behind us) are reloaded inside the
    // transaction.
    const freshRows = await loadCandidateItems(trx, applied.map((d) => d.item.id));
    const freshById = new Map(freshRows.map((r) => [r.id, r]));
    const freshBookedCallIds = await loadBookedCallIds(trx, allCallIds, { lock: true });
    const freshEvidence = await loadEvidence(trx, freshRows, { lock: true });
    const reverified = applied.filter((d) => {
      const fresh = freshById.get(d.item.id);
      if (!fresh) return false; // no longer open — lost the race
      const again = classifyTriageItem(fresh, { bookedCallIds: freshBookedCallIds, evidence: freshEvidence }, { now });
      return again && again.rule === d.rule && again.action === d.action;
    });
    const touchedCalls = new Map(); // call_log_id -> status we applied last
    for (const rule of Object.keys(RULE_NOTES)) {
      const group = reverified.filter((d) => d.rule === rule);
      if (!group.length) continue;
      const action = group[0].action;
      const status = action === 'resolve' ? 'resolved' : 'dismissed';
      const updatedRows = await trx('triage_items')
        .whereIn('id', group.map((d) => d.item.id))
        .where({ status: 'open' })
        .update({
          status,
          resolution_note: RULE_NOTES[rule],
          resolution_source: 'auto',
          resolved_at: now,
          updated_at: now,
        })
        .returning('id');
      counts[rule] = updatedRows.length;
      for (const row of updatedRows) {
        const id = row?.id ?? row;
        const callLogId = itemCallById.get(id);
        if (callLogId) touchedCalls.set(callLogId, status);
      }
    }

    // Mirror admin-triage transitionCore's review_status sync: a call with
    // open/in_progress cards remaining stays 'open'; otherwise it takes the
    // status of the transition that cleared it. The sibling rows are already
    // locked by the up-front acquisition above, so a concurrent operator/
    // event-driven transition either committed before our locks (the count
    // sees it) or blocks until we commit (their subsequent count sees our
    // terminal rows) — interleaved counts can no longer strand
    // review_status 'open' on a fully-terminal call.
    for (const [callLogId, appliedStatus] of touchedCalls) {
      const remaining = await trx('triage_items')
        .where({ call_log_id: callLogId })
        .whereIn('status', ['open', 'in_progress'])
        .count({ n: '*' })
        .first();
      const next = Number(remaining?.n || 0) > 0 ? 'open' : appliedStatus;
      await trx('call_log').where({ id: callLogId }).update({ review_status: next, updated_at: now });
      callsSynced += 1;
    }
  });

  const totalApplied = Object.values(counts).reduce((a, b) => a + b, 0);
  logger.info(`[triage-sweep] scanned=${items.length} applied=${totalApplied} deferred=${deferred} rules=${JSON.stringify(counts)} callsSynced=${callsSynced}`);
  return { skipped: false, scanned: items.length, applied: totalApplied, deferred, counts, callsSynced };
}

module.exports = {
  runTriageAutoResolve,
  classifyTriageItem,
  hasNewAddressEvidence,
  callSuppliedAddress,
  customerPredatesCall,
  callConfirmedUnbooked,
  surnameCameFromCall,
  heardAddressMatchesOnFile,
  callerPhoneOnFile,
  capturedEmails,
  requestedServiceTokens,
  serviceTypeMatches,
  requestedWindow,
  loadEvidence,
  EVIDENCE_CODES,
  LIVE_BOOKING_STATUSES,
  HUMAN_CONTACT_SOURCES,
  ADDRESS_MOOT_CODES,
  ADVISORY_AGE_CODES,
  RULE_NOTES,
  SPAM_AGE_DAYS,
  ADVISORY_AGE_DAYS,
  MAX_TRANSITIONS_PER_RUN,
};
