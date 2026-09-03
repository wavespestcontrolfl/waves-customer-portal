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
const { v2PrimaryLabelForCategory } = require('../utils/lead-service-interest');

const SPAM_AGE_DAYS = 7;
const ADVISORY_AGE_DAYS = 30;
// Per-run transition cap: the historical backlog drains over a few nightly
// runs instead of one giant write burst (also bounds the knowledge-index
// re-sync triggered by updated_at bumps).
const MAX_TRANSITIONS_PER_RUN = 500;

const ADDRESS_MOOT_CODES = new Set([
  'missing_service_address', 'low_confidence_address', 'address_unverifiable',
  'address_unverified', 'address_validation_unavailable',
  // The central routing gate's own address reason files an address_review
  // card too; it carries the same snapshots and answers to the same visit.
  'address_not_validated',
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
// The meaningful service words of a text.
const serviceTokens = (text) => [...new Set(String(text || '').toLowerCase().split(/[^a-z]+/).filter((t) => t && !SERVICE_STOPWORDS.has(t)))];

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

// Every address the CALL supplied (payload as-heard, the snapshotted V2
// street/raw) must agree with the on-file address — street key AND whatever
// locality the reading carries (city, ZIP). Fail closed: no heard address
// (nothing to prove), an unparseable extraction, or any heard address that
// keys or localizes differently keeps the card.
const cityKey = (v) => String(v || '').toLowerCase().replace(/[^a-z]/g, '');
const zip5 = (v) => (String(v || '').match(/\b\d{5}\b/) || [null])[0];

// City / ZIP hints from a raw "123 Main St, Bradenton, FL 34205" reading:
// the segment after the first comma (state tokens and digits stripped) and
// any 5-digit group past the street segment.
function localityOfRaw(text) {
  const s = String(text || '');
  const comma = s.indexOf(',');
  if (comma === -1) return { city: null, zip: null };
  const rest = s.slice(comma + 1);
  const seg = rest.split(',')[0].replace(/\b(fl|florida)\b/i, '').replace(/\d/g, '').trim();
  return { city: seg || null, zip: zip5(rest) };
}

// Does a reading's locality agree with the on-file one? Only the fields the
// reading carries are compared — but a field the reading carries and the
// file LACKS cannot be established, so it fails (two readings naming
// different cities must not both pass a street-only file). A reading with
// neither city nor ZIP still has to pass the street key.
// The unit named by an address: an explicit line2 ("Apt 4" / "#4") or one
// embedded in the street ("100 Main St Apt 4"), through the shared
// customer-properties keys so "Apt 4" == "Unit 4" == "#4".
function unitOf(line1, line2) {
  const { unitKey, streetEmbeddedUnitKey } = require('./customer-properties');
  return unitKey(line2) || streetEmbeddedUnitKey(line1) || '';
}
const onFileUnit = (item) => unitOf(item.customer_address_line1, item.customer_address_line2);

// A heard reading's unit must equal the on-file unit when it names one (a
// unit the file lacks cannot be established); a reading without a unit
// still has to pass the street key and locality.
function heardUnitMatches(item, reading) {
  const heardUnit = unitOf(reading.text, reading.line2);
  return !heardUnit || heardUnit === onFileUnit(item);
}

function localityAgrees(file, { city, zip }) {
  const heardZip = zip5(zip);
  if (heardZip && heardZip !== zip5(file.zip)) return false;
  const heardCity = cityKey(city);
  if (heardCity && heardCity !== cityKey(file.city)) return false;
  return true;
}
const localityMatches = (item, reading) => localityAgrees({ city: item.customer_city, zip: item.customer_zip }, reading);

// Readings come ONLY from the card: payload.address_as_heard and the
// heard_address snapshot call-routing-gates stamps at filing. Never the
// call's rolling extraction columns — a force-reprocess rewrites those while
// the open card keeps its ask. A card with neither fails closed.
function heardAddressMatchesOnFile(item) {
  const onFile = addressKey(item.customer_address_line1);
  if (!onFile) return false;
  const heard = [];
  const payload = parseMaybeJson(item.payload);
  if (!payload || typeof payload !== 'object') return false;
  if (payload.address_as_heard) heard.push({ text: payload.address_as_heard, ...localityOfRaw(payload.address_as_heard) });
  const snap = payload.heard_address;
  if (snap && typeof snap === 'object') {
    if (snap.street_line_1) heard.push({ text: snap.street_line_1, line2: snap.street_line_2, city: snap.city, zip: snap.postal_code });
    if (snap.raw_text) heard.push({ text: snap.raw_text, ...localityOfRaw(snap.raw_text) });
    // A unit / city / ZIP fragment with no street is an ask about SOME
    // address that cannot be keyed.
    if (!snap.street_line_1 && !snap.raw_text && [snap.street_line_2, snap.city, snap.postal_code].some((v) => String(v || '').trim())) return false;
  }
  const readings = heard.filter((h) => String(h.text || '').trim());
  if (!readings.length) return false;
  // Every reading must key AND agree — one unkeyable representation (a bare
  // street, a fragment) is unverified evidence, not ignorable.
  return readings.every((h) => readingMatchesOnFile(item, h));
}

// One heard reading against the on-file address: street key, locality, unit.
function readingMatchesOnFile(item, reading) {
  const onFile = addressKey(item.customer_address_line1);
  return Boolean(onFile) && addressKey(reading.text) === onFile
    && localityMatches(item, reading) && heardUnitMatches(item, reading);
}

// Did the CARD's filing-time ask (scheduling_window.requested_address —
// never the call's rolling extraction) name no address at all, or exactly
// the on-file one? Any other shape — a second property, a different
// street, a locality/unit-only fragment, or no snapshot — is not an ask
// the on-file address answers.
// The readings of the card's filing-time ask, or null when the ask is not
// one address (no snapshot, a second property, or a unit / city / ZIP
// fragment with no street). An empty list = the ask named no address.
// The card's filing-time ask: scheduling_window on the scheduling-shaped
// cards, quote_scope on quote_promised — the same snapshot under two keys.
function requestAsk(item) {
  const payload = parseMaybeJson(item.payload);
  return payload?.scheduling_window || payload?.quote_scope || null;
}

function requestedAddressReadings(item) {
  const ask = requestAsk(item)?.requested_address;
  if (!ask || typeof ask !== 'object') return null;
  if (Number(ask.additional_properties) > 0) return null;
  const readings = [
    { text: ask.street_line_1, line2: ask.street_line_2, city: ask.city, zip: ask.postal_code },
    { text: ask.raw_text, ...localityOfRaw(ask.raw_text) },
  ].filter((r) => String(r.text || '').trim());
  if (!readings.length && [ask.street_line_2, ask.city, ask.postal_code].some((v) => String(v || '').trim())) return null;
  return readings;
}

function requestedAddressIsOnFile(item) {
  const readings = requestedAddressReadings(item);
  if (!readings) return false;
  return readings.every((r) => readingMatchesOnFile(item, r));
}

// The address a booking is POSITIVELY at: its stamped service_address_*
// when the stamp carries a locality (a street-only legacy stamp — the
// backfill leaves those — cannot prove WHICH "123 Main St"), else the
// active property row it points at, else null.
function bookingPlace(visit, places) {
  if (visit.service_address_line1 && (zip5(visit.service_address_zip) || cityKey(visit.service_address_city))) {
    return { key: addressKey(visit.service_address_line1), unit: unitOf(visit.service_address_line1, visit.service_address_line2), city: visit.service_address_city, zip: visit.service_address_zip };
  }
  return visit.property_id ? places.get(String(visit.property_id)) || null : null;
}

// Is a booking at the address the CARD asked for? The ask named no address
// or exactly the on-file one → the booking must be positively at the
// on-file address. The ask named another address → the booking must be
// positively at THAT one (every reading keys to it, locality and unit
// agreeing). Any other ask shape binds nothing, so nothing qualifies. A
// reprocess that moved the extracted property and minted this call's own
// booking elsewhere must not close the original ask.
function bookingAtRequestedAddress(item, visit, places) {
  if (requestedAddressIsOnFile(item)) return visitAtOnFileAddress(item, visit, places);
  const readings = requestedAddressReadings(item);
  if (!readings || !readings.length) return false;
  const place = bookingPlace(visit, places);
  if (!place || !place.key) return false;
  if (place.customer_id && String(place.customer_id) !== String(item.call_customer_id)) return false;
  return readings.every((r) => {
    const unit = unitOf(r.text, r.line2);
    return addressKey(r.text) === place.key && (!unit || unit === place.unit) && localityAgrees(place, r);
  });
}

// The requested service categories the CARD snapshotted at filing time
// (call-routing-gates writes scheduling_window.requested_service_categories)
// as match requirements — ONE requirement PER CATEGORY, because a
// multi-service ask (pest + lawn) is fulfilled only when bookings cover every
// category. A requirement is the token lists that each answer it: the
// category enum's own words (the engine's estimate lines carry the enum as
// their service key) and, when the enum stands for ONE catalog service, that
// service's words through v2PrimaryLabelForCategory — the identity map the
// compose path already reads, never a local copy: the catalog books
// stinging_insect as "Bee / Wasp Nest Removal" under the specialty category,
// so neither a booking's service_type nor its snapshot says "stinging" or
// "insect" (codex r22 P2). Never the call's ai_extraction_enriched: that
// column is a rolling snapshot a force-reprocess overwrites while the open
// card keeps its original ask. A card filed before the snapshot existed
// yields no categories, so its association arm stays closed.
function requestedServiceTokens(item) {
  const ask = requestAsk(item);
  const cats = ask?.requested_service_categories;
  if (!Array.isArray(cats)) return [];
  const out = [];
  for (const c of cats) {
    const answers = [c, v2PrimaryLabelForCategory(c)].map(serviceTokens).filter((tokens) => tokens.length);
    if (answers.length) out.push(answers);
  }
  // The specific service the caller named narrows the PRIMARY category —
  // one requirement, not two: a flea treatment filed under pest_general is
  // not answered by a generic quarterly pest booking, and a second
  // pest_general the model listed as a separate request stays its own
  // requirement needing its own booking (codex r17 P1). It narrows every
  // answer alike.
  const specific = serviceTokens(ask?.requested_specific_service);
  if (specific.length) {
    if (out.length) out[0] = out[0].map((tokens) => [...new Set([...tokens, ...specific])]);
    else out.push([specific]);
  }
  return out;
}

// Every requirement answered by a DIFFERENT record: a caller who asked for
// a flea treatment AND a separate general-pest visit is not answered by one
// flea booking that happens to match both token lists. Backtracking over
// tiny lists (a handful of requirements, a customer's live bookings).
function coveredByDistinct(requirements, records, wordsOf) {
  const used = new Set();
  const place = (i) => {
    if (i === requirements.length) return true;
    for (const r of records) {
      if (used.has(r) || !serviceTypeMatches(wordsOf(r), requirements[i])) continue;
      used.add(r);
      if (place(i + 1)) return true;
      used.delete(r);
    }
    return false;
  };
  return requirements.length > 0 && place(0);
}

// A record answers a requirement only when EVERY token of one of its
// answers appears in the record's words (a booking's service_type plus the
// canonical category snapshot admin-schedule stamps; an estimate line's
// names and families): "Subterranean Termite" is not drywood_termite,
// "Rodent Control" is not rodent_exclusion.
function serviceTypeMatches(serviceText, requirement) {
  const words = new Set(String(serviceText || '').toLowerCase().split(/[^a-z]+/).filter(Boolean));
  return requirement.some((tokens) => tokens.length > 0 && tokens.every((t) => words.has(t)));
}

// The ET wall clock ('YYYY-MM-DDTHH:MM') the call CONFIRMED, from the
// card's snapshot — null when the snapshot carries no clock time. ONE
// reading for both the day and the hour, and the same one the processor
// books scheduled_date / window_start from (v2IsoToEtWallClock: an ET
// offset is the agreed wall clock verbatim even when the seasonal offset is
// wrong, any other encoding is an instant rendered in ET) — rendering the
// day as an instant instead would compare a different calendar day than
// the booking path wrote near midnight.
function confirmedWall(item) {
  const raw = parseMaybeJson(item.payload)?.scheduling_window?.confirmed_start_at;
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)) return null;
  const { v2IsoToEtWallClock } = require('./call-recording-processor');
  return v2IsoToEtWallClock(raw) || null;
}
const confirmedWallClock = (item) => confirmedWall(item)?.slice(11, 16) || null;

// The part of day a booking lands in, from its window_start or its legacy
// time_window band — the bands route-reorder and the IB booking tool
// already define (morning 08:00–12:00, afternoon 12:00–17:00, evening
// after). Null when the row carries no clock at all.
function bookingPartOfDay(visit) {
  const band = String(visit.time_window || '').trim().toLowerCase();
  const start = visit.window_start ? String(visit.window_start).slice(0, 5) : (band === 'morning' ? '08:00' : band === 'afternoon' ? '12:00' : null);
  if (!start || !/^\d{2}:\d{2}$/.test(start)) return null;
  const hour = Number(start.slice(0, 2));
  return hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
}

// Does the booking honor the time of day the card snapshotted? A morning /
// afternoon / evening preference is part of the ask: a Tuesday-afternoon
// booking does not answer "Tuesday morning". 'any' / 'unspecified' /
// null bind nothing. A row with no clock cannot prove the preference.
const TIME_OF_DAY_BANDS = new Set(['morning', 'afternoon', 'evening']);
function timeOfDayMatches(item, visit) {
  const pref = parseMaybeJson(item.payload)?.scheduling_window?.preferred_time_of_day;
  if (!TIME_OF_DAY_BANDS.has(pref)) return true;
  return bookingPartOfDay(visit) === pref;
}

// Does a booking's cadence answer the card's snapshotted service intent? A
// recurring-plan ask is answered only by a recurring series — a one-time
// visit in the same category is not the plan the caller asked for — and
// an explicit one-time ask only by a single visit (the booking path keeps
// the single service on an explicit "just one-time"; a series booked
// instead is not that ask). Any other intent (an active infestation) is
// answered by either. A snapshot without the intent binds nothing: fail
// closed.
const RECURRING_INTENT = 'recurring_membership_inquiry';
const ONE_TIME_INTENT = 'preventative_one_time';
function cadenceMatches(item, visit) {
  const intent = parseMaybeJson(item.payload)?.scheduling_window?.requested_service_intent;
  if (intent == null) return false;
  if (intent === RECURRING_INTENT) return visit.is_recurring === true;
  if (intent === ONE_TIME_INTENT) return visit.is_recurring !== true;
  return true;
}

// The calendar days (ET, YYYY-MM-DD) the caller asked for, from the card's
// scheduling payload. Inclusive; a single requested date is a one-day window.
// A confirmed start pins BOTH bounds to the day of the confirmed wall clock
// above — a residual requested range beside it ("Tuesday to Thursday, then
// confirmed Tuesday at 10") is not the ask any more, and a Thursday booking
// must not close a Tuesday confirmation (codex r21 P1). Only the requested
// range is read as instants.
function requestedWindow(item) {
  const payload = parseMaybeJson(item.payload);
  const w = payload?.scheduling_window || {};
  const wall = confirmedWall(item);
  if (wall) return { start: wall.slice(0, 10), end: wall.slice(0, 10) };
  const startRaw = w.requested_date_range_start;
  if (!startRaw || !toDate(startRaw)) return null;
  const start = etCalendarDayOf(startRaw);
  const end = w.requested_date_range_end && toDate(w.requested_date_range_end) ? etCalendarDayOf(w.requested_date_range_end) : start;
  return end >= start ? { start, end } : { start: end, end: start };
}

// The ET days the caller excluded from the requested range, as snapshotted
// at filing. A booking on one of them is not the appointment asked for.
function blackoutDays(item) {
  const raw = parseMaybeJson(item.payload)?.scheduling_window?.blackout_dates;
  return new Set((Array.isArray(raw) ? raw : []).filter((d) => toDate(d)).map((d) => etCalendarDayOf(d)));
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
  const snap = payload.heard_address;
  return Boolean(
    payload.address_as_heard
    || (Array.isArray(payload.address_candidates) && payload.address_candidates.length)
    || payload.address_recovered
    // The filing-time snapshot of the address the call named is new
    // evidence in its own right — a later reprocess clearing the rolling
    // extraction must not make the card moot against the on-file address.
    || (snap && typeof snap === 'object' && Object.values(snap).some((v) => String(v ?? '').trim() !== '')),
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
  const names = heardNames(item);
  return Boolean(names) && names.first.length > 0 && names.first.includes(onFile);
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

// The CARD's answer to the same question, for the evidence arms: its
// filing-time scheduling status (scheduling_window.status when the card
// carries the window, else the base payload's scheduling_status every card
// records) — never the rolling extraction a force-reprocess rewrites from
// confirmed to requested. A confirmed call counts as booked ONLY when the
// booking arm found a live booking answering the card's snapshotted ask
// (service, address, days — `booking_after_card`), not any row that
// happens to point at the call: a skipped visit or a reprocessed booking
// for another service is not the appointment the caller confirmed. A card
// with no status at all cannot prove the appointment was not confirmed
// and fails closed.
function cardSchedulingStatus(item) {
  const payload = parseMaybeJson(item.payload);
  const window = payload?.scheduling_window;
  if (window && typeof window === 'object' && window.status !== undefined) return window.status;
  return payload?.scheduling_status;
}
function cardConfirmedUnbooked(item, ev) {
  const status = cardSchedulingStatus(item);
  if (status === undefined) return true;
  if (status !== 'confirmed') return false;
  return !(ev && ev.booking_after_card);
}

// Does the customer's current surname match what THIS call's extractions
// heard? backfillCustomerFromAppointmentContact writes last_name onto even
// PRE-EXISTING customers from the call's merged extraction (a V1-only
// surname survives the merge while V2 emits missing_last_name) — a matching
// surname is therefore not independent evidence. Fail closed on an
// unparseable extraction.
// The names THIS card heard, snapshotted at filing: payload.heard_name
// (the V2 caller, call-routing-gates) and payload.heard_name_v1 (the merged
// V1 extraction the processor passes — the one the surname backfill writes
// from). Never the call's rolling extraction columns: a force-reprocess
// rewrites those while the open card keeps its original ask, and a
// surname the rewrite dropped would then read as independent evidence
// (codex r18 P1). Null when the card predates the snapshot.
function heardNames(item) {
  const payload = parseMaybeJson(item.payload);
  // The merged V1 names are the ones the surname backfill writes from: a
  // card carrying only the V2 caller (filed by an insert site that passed
  // no V1 snapshot) cannot separate a backfilled surname from an
  // independent one — fail closed, as a pre-snapshot card does (codex r19
  // P1).
  const v1 = payload?.heard_name_v1;
  if (!v1 || typeof v1 !== 'object') return null;
  const snaps = [payload?.heard_name, v1].filter((s) => s && typeof s === 'object');
  const pick = (key) => snaps.map((s) => String(s[key] || '').trim().toLowerCase()).filter(Boolean);
  return { first: pick('first_name'), last: pick('last_name') };
}

function surnameCameFromCall(item) {
  const onFile = String(item.customer_last_name || '').trim().toLowerCase();
  if (!onFile) return false;
  const names = heardNames(item);
  // No filing-time names (a pre-snapshot card): not independent evidence.
  if (!names) return true;
  return names.last.includes(onFile);
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
    // Clearing the authorization question must not make a confirmed-but-
    // unbooked call (the routing block kept its appointment from being
    // created, and no not_confirmed sibling exists) read as fully resolved
    // — the promised appointment is still owed.
    if (code === 'caller_not_authorized' && ev.caller_phone_added && callerPhoneOnFile(item)
        && !cardConfirmedUnbooked(item, ev)) {
      return { action: 'resolve', rule: 'caller_phone_added' };
    }
    if (code === 'not_confirmed' && ev.booking_after_card) {
      return { action: 'resolve', rule: 'booking_created' };
    }
    // A confirmed call held solely on its address card has no not_confirmed
    // sibling: an unrelated recurring visit completing at the address must
    // not close the call's only trace while the confirmed appointment was
    // never created.
    if (ADDRESS_MOOT_CODES.has(code)
        && !item.customer_deleted_at
        && ev.visit_completed_at_address
        && heardAddressMatchesOnFile(item)
        && !cardConfirmedUnbooked(item, ev)) {
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
      'c.address_line2 as customer_address_line2',
      'c.zip as customer_zip',
      'c.city as customer_city',
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

// ── Evidence arms ───────────────────────────────────────────────────────
// One loader per rule; loadEvidence below runs them and hands each a
// `flag(itemId, key)` writer. Every predicate compares against the CARD's
// created_at (strict >): evidence that predates the card — including
// anything the filing pass itself wrote — never counts.

// The boundary a card's evidence must follow: the later of the card and
// its call (a card cannot predate its call, but the guard is free).
const cardBoundary = (item) => new Date(Math.max(
  toDate(item.created_at)?.getTime() || 0,
  toDate(item.call_created_at)?.getTime() || 0,
));

// quote_promised → an estimate DIRECTLY linked to this call, delivered
// after the CARD (call-commitments' batched direct routes — three queries
// for the whole backlog, each card its own boundary; association-strength
// matches — same customer, unlinked — are ignored on purpose). The proof
// must also belong to the call's CURRENT customer (or, unowned, carry the
// caller's number): a relink moves the call and its lead but not the
// estimates, and the old customer's estimate proves nothing to the new one.
// And it must COVER the card's filing-time quote_scope — the services asked
// for, at the address asked for (estimateCoversAsk): a reprocess that moved
// the service or the property, or an estimate pricing part of a multi-
// service ask, does not keep the promise this card recorded.
async function loadEstimateEvidence(conn, items, flag) {
  const quoteItems = items.filter((i) => i.reason_code === 'quote_promised');
  if (!quoteItems.length) return;
  const { directEstimatesSentAfter } = require('./call-commitments');
  try {
    const proofs = await directEstimatesSentAfter(conn, quoteItems.map((item) => ({
      key: item.id,
      callId: item.call_log_id,
      twilioCallSid: item.call_twilio_call_sid,
      callStartedAt: item.call_created_at,
      customerId: item.call_customer_id || null,
      phone: callerPhone(item),
      after: cardBoundary(item),
      covers: (row, siblings) => estimateCoversAsk(item, row, siblings),
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
async function loadEmailEvidence(conn, items, flag) {
  // Bound to the CUSTOMER the call is linked to: an address can be
  // duplicated across customers (or used by a test send), and another
  // recipient's open answers nothing about this caller's read-back. A card
  // on an unlinked call has no customer to bind to and gets no evidence.
  const bound = items.filter((i) => i.reason_code === 'email_unverified' && i.call_customer_id);
  if (!bound.length) return;
  // A call an owner verdict DENIED (first_touch_holds.last_error =
  // 'email_denied_await_correction', stamped by admin-triage and cleared
  // only by an explicit approval there or the correction fanout) gets no
  // email evidence: a force-reprocess can file a fresh card on that call,
  // and engagement on the address a human already ruled wrong is not this
  // sweep's to overrule — closing the card here would strand the
  // deny-stamped hold, which the ledger sweep excludes, pending forever.
  const denied = new Set((await conn('first_touch_holds')
    .whereIn('call_log_id', [...new Set(bound.map((i) => i.call_log_id))])
    .where('last_error', 'email_denied_await_correction')
    .select('call_log_id')).map((h) => String(h.call_log_id)));
  const emailItems = bound.filter((i) => !denied.has(String(i.call_log_id)));
  const emailsByItem = new Map(emailItems.map((i) => [i.id, capturedEmails(i)]));
  const allEmails = [...new Set([...emailsByItem.values()].flat())];
  if (!allEmails.length) return;
  const rows = await conn('email_messages')
    .where('recipient_type', 'customer')
    .whereIn('recipient_id', [...new Set(emailItems.map((i) => String(i.call_customer_id)))])
    .whereRaw('LOWER(recipient_email_snapshot) IN (' + allEmails.map(() => '?').join(', ') + ')', allEmails)
    .whereNotNull('sent_at')
    .whereNull('bounced_at')
    .whereNull('complained_at')
    .whereNotIn('status', ['bounced', 'failed', 'complained', 'dropped'])
    .where(function engaged() {
      this.whereNotNull('opened_at').orWhereNotNull('clicked_at');
    })
    .orderBy('id', 'asc')
    .select('recipient_id', 'recipient_email_snapshot', 'sent_at', 'opened_at', 'clicked_at');
  for (const item of emailItems) {
    const mine = new Set(emailsByItem.get(item.id));
    const hit = rows.some((r) => String(r.recipient_id) === String(item.call_customer_id)
      && mine.has(String(r.recipient_email_snapshot || '').toLowerCase())
      && strictlyAfter(r.sent_at, item.created_at)
      && (strictlyAfter(r.opened_at, item.created_at) || strictlyAfter(r.clicked_at, item.created_at)));
    if (hit) flag(item.id, 'email_engaged');
  }
}

// caller_not_authorized → a HUMAN (admin or portal account holder — never
// the call pipeline or a dedupe merge) added a service contact, or changed
// one's PHONE, to EXACTLY the caller's number after the card: the event's
// keyed phone fingerprint (service-contact-events writes it next to the
// masked number, the source and the changed fields) equals the caller's.
// The masked …1234 alone is ambiguous and is never compared; events
// written before the fingerprint existed cannot match. The classifier
// additionally requires the number to be on a slot NOW.
async function loadContactEvidence(conn, items, flag) {
  const authItems = items.filter((i) => i.reason_code === 'caller_not_authorized' && i.call_customer_id);
  if (!authItems.length) return;
  const { phoneFingerprint } = require('./service-contact-events');
  const rows = await conn('activity_log')
    .whereIn('customer_id', [...new Set(authItems.map((i) => i.call_customer_id))])
    .whereIn('action', ['service_contact_added', 'service_contact_updated'])
    .select('customer_id', 'action', 'created_at', 'metadata');
  for (const item of authItems) {
    const callerPrint = phoneFingerprint(callerPhone(item));
    if (!callerPrint) continue;
    const hit = rows.some((r) => {
      if (String(r.customer_id) !== String(item.call_customer_id)) return false;
      if (!strictlyAfter(r.created_at, item.created_at)) return false;
      const meta = parseMaybeJson(r.metadata);
      if (!HUMAN_CONTACT_SOURCES.has(String(meta?.source || ''))) return false;
      // An update event also fires for name/email/role-only edits and still
      // carries the unchanged phone — only a phone change is evidence.
      if (r.action === 'service_contact_updated'
        && !(Array.isArray(meta?.changed_fields) && meta.changed_fields.includes('phone'))) return false;
      return Boolean(meta?.phone_fingerprint) && meta.phone_fingerprint === callerPrint;
    });
    if (hit) flag(item.id, 'caller_phone_added');
  }
}

// POSITIVE linkage between a scheduled_services row and the card's on-file
// address, or nothing: the row's effective address is its stamped
// service_address_* when present, else the ACTIVE property row of this
// customer it points at — street key AND locality must agree. A row with
// neither is only associated with the customer and proves nothing about
// where service happens. The unit is part of the identity: Unit B is not
// Unit A, and a unit-less stamp cannot prove a unit.
function visitAtOnFileAddress(item, visit, places) {
  const onFile = addressKey(item.customer_address_line1);
  if (!onFile) return false;
  const place = bookingPlace(visit, places);
  if (!place) return false;
  if (place.customer_id && String(place.customer_id) !== String(item.call_customer_id)) return false;
  return place.key === onFile && place.unit === onFileUnit(item) && localityMatches(item, place);
}

// not_confirmed → bookings created after the card that COLLECTIVELY cover
// every service category the card snapshotted at filing. Booking
// provenance is PARENT rows only (follow-up children are not the booking
// the call asked for). Direct = this call's own booking; association =
// same customer, single ACTIVE property, the card's filing-time ask named
// no address or exactly the on-file one, scheduled inside the requested
// days, positively linked to the on-file address. Direct bookings are held
// to the snapshot too — the service AND the requested address: a reprocess
// that re-classified the call or moved its property and minted a different
// booking must not close the original ask. A card with no snapshot (filed before it
// existed — the historical backlog) gets NO booking evidence: without the
// requested service there is nothing to prove a booking answered, and a
// reprocess could have re-classified the call. Those cards stay for humans.
function bookingCoversRequest(item, mine, { singleProperty, places }) {
  const categories = requestedServiceTokens(item);
  if (!categories.length) return false;
  const parents = mine.filter((v) => !v.parent_service_id && strictlyAfter(v.created_at, item.created_at));
  // The requested days bind every booking, this call's own included — a
  // reprocess that moved only the date and minted a new booking must not
  // close the original ask. A card that asked for no date binds none. A
  // CONFIRMED call binds the agreed hour too, not merely its day: another
  // booking that afternoon is not the appointment the caller confirmed,
  // and a row with no window_start cannot prove the hour. A REQUESTED ask
  // with a morning / afternoon / evening preference binds that band, and a
  // day the caller excluded from the range is never answered by a booking
  // on it (a row with no date cannot prove it avoided one).
  const window = requestedWindow(item);
  const hour = confirmedWallClock(item);
  const blackout = blackoutDays(item);
  const inAsk = (v) => {
    if (!cadenceMatches(item, v)) return false;
    if (hour && String(v.window_start || '').slice(0, 5) !== hour) return false;
    if (!hour && !timeOfDayMatches(item, v)) return false;
    if (blackout.size && (!toDate(v.scheduled_date) || blackout.has(etCalendarDayOf(v.scheduled_date)))) return false;
    if (!window) return true;
    if (!toDate(v.scheduled_date)) return false;
    const day = etCalendarDayOf(v.scheduled_date);
    return day >= window.start && day <= window.end;
  };
  const direct = parents.filter((v) => String(v.source_call_log_id) === String(item.call_log_id) && inAsk(v) && bookingAtRequestedAddress(item, v, places));
  let pool = direct;
  if (singleProperty && requestedAddressIsOnFile(item) && window) {
    pool = pool.concat(parents.filter((v) => inAsk(v) && visitAtOnFileAddress(item, v, places)));
  }
  return coveredByDistinct(categories, pool, (v) => `${v.service_type || ''} ${v.service_category_snapshot || ''}`);
}

// The priced LINES an estimate carries, each with its own service words
// and cadence — a delivered quote is judged line by line: distinct
// requested services need distinct priced lines, and the line answering a
// service must carry the asked cadence (codex r19 P1 ×2). Three sources,
// in order: an AUTHORED commercial proposal is the quote (its lines replace
// the engine's entirely — the pricing audit's rule — because the engine's
// manual-quote placeholders stay in the blob with their quote-required
// booleans cleared and no price, codex r20 P1); else the engine result's
// typed lists; else, for a legacy or manual row with no typed lines, ONE
// line at the cadence its totals columns show. A line is one that PRICES
// something: a quote-required / manual-review entry or one with no positive
// amount is a placeholder, not a quote. Never estimate_text (the rendered
// document's boilerplate names services it does not price), never the
// category column (RESIDENTIAL / COMMERCIAL), and never an input flag
// beside typed lines (the flag selects a service; only a line prices it).
const RECURRING = { recurring: true, oneTime: false };
const ONE_TIME = { recurring: false, oneTime: true };
// Where the engine result prices its lines and which field carries the
// price: recurring programs (monthly — or annual / per-application for a
// termite bond or a per-visit program, codex r21 P2), the one-time job
// lists, and the raw lineItems read row by row. An item included ON the
// program is priced into the recurring plan and quotes no standalone job.
const RECURRING_AMOUNT_KEYS = ['mo', 'monthly', 'monthlyTotal', 'monthly_total', 'annual', 'annualTotal', 'annual_total', 'perApplication', 'pricePerApplication', 'amount'];
const ONE_TIME_AMOUNT_KEYS = ['price', 'amount', 'total'];
const amountOf = (entry, keys) => keys.map((k) => Number(entry?.[k])).find((n) => Number.isFinite(n) && n > 0) || 0;
const RECURRING_LINE = { cadence: RECURRING, amountKeys: RECURRING_AMOUNT_KEYS };
const ONE_TIME_LINE = { cadence: ONE_TIME, amountKeys: ONE_TIME_AMOUNT_KEYS };
// The raw engine result's lineItems — the shape the public quote and the
// automated estimator persist, with no typed containers — mix cadences, so
// each row is read by the engine's own rule (estimate-engine's
// recurringItems / oneTimeItems, the pricing audit's normalizeEngineLineItems):
// a row carrying recurring money (annual, monthly, per-application) is a
// program; any other priced row is a one-time job (codex r23 P2).
const rawLine = (entry) => (amountOf(entry, RECURRING_AMOUNT_KEYS) > 0 ? RECURRING_LINE : ONE_TIME_LINE);
const ENGINE_LINE_SOURCES = [
  { list: (root) => root.recurring?.services, line: () => RECURRING_LINE },
  { list: (root) => root.oneTime?.items, line: () => ONE_TIME_LINE },
  { list: (root) => root.oneTime?.specItems, line: () => ONE_TIME_LINE },
  { list: (root) => root.specItems, line: () => ONE_TIME_LINE },
  { list: (root) => root.lineItems, line: rawLine },
];
const isPlaceholder = (entry) => entry.quoteRequired === true || entry.requiresManualReview === true;
const entryNames = (entry) => [entry.service, entry.serviceKey, entry.service_key, entry.name, entry.label, entry.description, entry.detail, entry.det];

// One line per priced entry — its own name fields plus the service family
// the shared line reader's text patterns assign them; the same entry
// persisted under both result roots is one line, not two.
function lineCollector() {
  const { serviceKeysFromText, SERVICE_LINE_LABELS } = require('./estimate-service-lines');
  const lines = [];
  const seen = new Set();
  const add = (rawNames, cadence, priced) => {
    if (!priced) return;
    const names = rawNames.filter((w) => typeof w === 'string' && w.trim());
    const identity = [...names, cadence.recurring].join('|');
    if (seen.has(identity)) return;
    seen.add(identity);
    const families = serviceKeysFromText(...names).flatMap((k) => (k && k !== 'unknown' ? [k, SERVICE_LINE_LABELS[k]] : []));
    lines.push({ words: [...names, ...families].join(' '), ...cadence });
  };
  return { lines, add };
}

// An authored proposal's lines from the CANONICAL normalizer (the shape
// the PDF, billing and the pricing audit read): programs → recurring,
// building line items per their frequency (a line's service is its
// description, the normalizer's one name field; the building it sits under
// is a place, not a service — codex r22 P2), corrective work → one-time.
function proposalLines(row, add) {
  const proposal = require('./estimate-proposal').normalizeProposal(row);
  if (proposal.enabled !== true) return;
  for (const program of proposal.programs || []) add([program.label, program.service], RECURRING, program.annual > 0);
  for (const building of proposal.buildings || []) {
    for (const item of building.lineItems || []) {
      add([item.description], item.frequency === 'one_time' ? ONE_TIME : RECURRING, item.amount > 0);
    }
  }
  for (const work of proposal.correctiveWork || []) add([work.label, work.service], ONE_TIME, work.amount > 0);
}

// The engine result's typed lines, from both persisted roots.
function engineLines(data, add) {
  const { SERVICE_LINE_LABELS } = require('./estimate-service-lines');
  for (const root of [data.result, data.engineResult].filter((r) => r && typeof r === 'object')) {
    for (const source of ENGINE_LINE_SOURCES) {
      const entries = source.list(root);
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object' || isPlaceholder(entry)) continue;
        const onProgram = entry.onProg === true || entry.includedOnProgram === true;
        const { cadence, amountKeys } = source.line(entry);
        add(entryNames(entry), onProgram ? RECURRING : cadence, onProgram || amountOf(entry, amountKeys) > 0);
      }
    }
    const injection = root.results?.injection || root.injection || {};
    add(['palm_injection', SERVICE_LINE_LABELS.palm_injection], RECURRING,
      amountOf(injection, ['mo', 'monthly']) > 0 || amountOf(root.recurring || {}, ['palmInjectionMo', 'palm_injection_mo']) > 0);
  }
}

// A legacy or manual row with no typed lines: service_interest, the
// families the shared reader infers from its inputs and text, and the
// engine's svc* input flags — at the cadence its totals columns show.
function legacyLine(row, data) {
  const { inferEstimateServiceLines, SERVICE_LINE_LABELS } = require('./estimate-service-lines');
  const words = [row.service_interest];
  for (const line of inferEstimateServiceLines(row)) {
    if (line.key && line.key !== 'unknown') words.push(line.key, SERVICE_LINE_LABELS[line.key]);
  }
  for (const inputs of [data.inputs, data.engineInputs].filter((i) => i && typeof i === 'object')) {
    for (const [k, v] of Object.entries(inputs)) {
      if (k.startsWith('svc') && v) words.push(k.slice(3).replace(/([a-z])([A-Z])/g, '$1 $2'));
    }
  }
  return {
    words: words.filter((w) => typeof w === 'string').join(' '),
    recurring: Number(row.monthly_total) > 0 || Number(row.annual_total) > 0,
    oneTime: Number(row.onetime_total) > 0,
  };
}

function estimateLines(row) {
  const data = require('./estimate-service-lines').parseEstimateData(row.estimate_data) || {};
  const { lines, add } = lineCollector();
  if (data.proposal?.enabled === true) proposalLines(row, add);
  if (!lines.length) engineLines(data, add);
  return lines.length ? lines : [legacyLine(row, data)];
}

// An estimate as the address-bearing record the booking rules understand:
// its address column through the canonical estimates.address parser (the
// one property linkage reads — "77 Oak St, Unit 4, Bradenton, FL 34205" is a
// street, a unit and a locality, never a city called "Unit 4", codex r23
// P2) or, failing that, the property row it prices. A street with no
// locality cannot prove WHICH street, exactly as a street-only visit stamp
// cannot.
function estimateAsVisit(row) {
  const { parseEstimateAddress } = require('./estimate-property-linkage');
  const parsed = parseEstimateAddress(row.address);
  if (parsed) {
    return { service_address_line1: parsed.address_line1, service_address_line2: parsed.address_line2 || null, service_address_city: parsed.city || null, service_address_zip: parsed.zip || null };
  }
  if (row.property_address_line1) {
    return { service_address_line1: row.property_address_line1, service_address_line2: row.property_address_line2 || null, service_address_city: row.property_city || null, service_address_zip: row.property_zip || null };
  }
  return null;
}

// Does a delivered estimate keep the quote THIS card recorded? Every
// requested service (the primary narrowed by the specific one, each
// secondary) must be priced by its OWN line — of the estimate or of a
// sibling in its group — at the cadence the ask carries, and each such
// estimate must price the address the ask named (the on-file one when it
// named none). Cadence is the booking arm's rule (cadenceMatches), applied
// to the line that answers the service: a recurring-plan ask needs a
// recurring line pricing THAT service (a one-time pest job beside a
// recurring lawn program is not a recurring pest quote), an explicit
// one-time ask a one-time line, any other intent a line at either cadence,
// and a snapshot with no intent nothing (codex r18 + r19 P1). Distinct
// requirements need distinct lines, exactly as bookings do — one flea line
// does not answer a flea treatment AND a separately requested general-pest
// quote (codex r19 P1). A card with no quote_scope (filed before the
// snapshot existed) has no ask to cover, so nothing qualifies.
function estimateCoversAsk(item, row, siblings = []) {
  const requirements = requestedServiceTokens(item);
  if (!requirements.length) return false;
  const intent = requestAsk(item)?.requested_service_intent;
  if (typeof intent !== 'string' || !intent) return false;
  // Every service must be priced AT the asked address: a sibling pricing
  // the other property in a multi-property proposal covers nothing here
  // (codex r18 P1), and the cited estimate itself must be at the address.
  const atAsk = (e) => {
    const visit = estimateAsVisit(e);
    return Boolean(visit) && bookingAtRequestedAddress(item, visit, new Map());
  };
  if (!atAsk(row)) return false;
  const atCadence = intent === RECURRING_INTENT ? (l) => l.recurring
    : intent === ONE_TIME_INTENT ? (l) => l.oneTime
      : (l) => l.recurring || l.oneTime;
  const lines = [row, ...siblings.filter(atAsk)].flatMap(estimateLines).filter(atCadence);
  return coveredByDistinct(requirements, lines, (l) => l.words);
}

// Bookings and completed visits for the not_confirmed / address arms.
async function loadVisitEvidence(conn, items, flag) {
  // not_confirmed cards, address cards, and every card whose call CONFIRMED
  // an appointment (the confirmed-unbooked guard is answered only by a
  // booking matching the card's snapshotted ask).
  const needsBooking = (i) => i.reason_code === 'not_confirmed' || cardSchedulingStatus(i) === 'confirmed';
  const visitItems = items.filter((i) => (needsBooking(i) || ADDRESS_MOOT_CODES.has(i.reason_code)) && i.call_customer_id);
  if (!visitItems.length) return;
  const customerIds = [...new Set(visitItems.map((i) => i.call_customer_id))];
  // ACTIVE rows only — the uniqueness customer-properties'
  // soleActivePropertyId defines; an inactive historical duplicate does
  // not make an account multi-property.
  const propRows = await conn('customer_properties')
    .whereIn('customer_id', customerIds)
    .where('active', true)
    .orderBy('id', 'asc')
    .select('id', 'customer_id', 'address_line1', 'address_line2', 'city', 'zip');
  const places = new Map();
  const activeCount = new Map();
  for (const r of propRows) {
    places.set(String(r.id), { customer_id: r.customer_id, key: addressKey(r.address_line1), unit: unitOf(r.address_line1, r.address_line2), city: r.city, zip: r.zip });
    activeCount.set(String(r.customer_id), (activeCount.get(String(r.customer_id)) || 0) + 1);
  }
  // The association and address arms need EXACTLY one active property —
  // an account with none (a legacy row whose only address is the customers
  // column) proves as little about WHICH address as one with several
  // (pre-push hook P1 on 12f3c751c).
  const singleProperty = (customerId) => (activeCount.get(String(customerId)) || 0) === 1;

  // Positive allowlist: a live booking is one that is still going to happen
  // or did happen. cancelled / rescheduled / skipped / no_show rows prove
  // nothing. Children stay in: a completed follow-up child IS a visit at
  // the address (the booking arm filters parents itself).
  const visits = await conn('scheduled_services')
    .whereIn('customer_id', customerIds)
    .whereIn('status', [...LIVE_BOOKING_STATUSES])
    .orderBy('id', 'asc')
    .select('id', 'customer_id', 'source_call_log_id', 'parent_service_id', 'status', 'service_type', 'service_category_snapshot', 'scheduled_date',
      'window_start', 'time_window', 'is_recurring', 'created_at', 'completed_at', 'service_address_line1', 'service_address_line2', 'service_address_city', 'service_address_zip', 'property_id');
  // Indexed once — the backlog is cards × a customer's own visits, not
  // cards × every fetched visit.
  const visitsByCustomer = new Map();
  for (const v of visits) {
    const list = visitsByCustomer.get(String(v.customer_id)) || [];
    list.push(v);
    visitsByCustomer.set(String(v.customer_id), list);
  }

  for (const item of visitItems) {
    const mine = visitsByCustomer.get(String(item.call_customer_id)) || [];
    if (needsBooking(item)
      && bookingCoversRequest(item, mine, { singleProperty: singleProperty(item.call_customer_id), places })) {
      flag(item.id, 'booking_after_card');
    }
    if (ADDRESS_MOOT_CODES.has(item.reason_code) && singleProperty(item.call_customer_id)) {
      // Address cards: a visit COMPLETED after the card, positively at the
      // on-file address, for a single-property customer. The classifier
      // adds the heard-address ↔ on-file match.
      const done = mine.some((v) => v.status === 'completed'
        && strictlyAfter(v.completed_at, item.created_at)
        && visitAtOnFileAddress(item, v, places));
      if (done) flag(item.id, 'visit_completed_at_address');
    }
  }
}

// Per-item proof map for the evidence rules — the four arms above over the
// open evidence-coded cards. Empty when the evidence gate is off.
async function loadEvidence(conn, items) {
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
  await loadEstimateEvidence(conn, candidates, flag);
  await loadEmailEvidence(conn, candidates, flag);
  await loadContactEvidence(conn, candidates, flag);
  await loadVisitEvidence(conn, candidates, flag);
  return evidence;
}

async function sweep({ now = new Date() } = {}) {
  const items = await loadCandidateItems(db);

  // Booking provenance (live source-linked rows only — the canonical
  // lookup's predicates: no cancelled/rescheduled rows, no follow-up
  // children) feeds the confirmed-unbooked address guard.
  const loadBookedCallIds = async (conn, callIds) => {
    const set = new Set();
    if (!callIds.length) return set;
    const booked = await conn('scheduled_services')
      .whereIn('source_call_log_id', callIds)
      .whereNull('parent_service_id')
      .whereNotIn('status', ['cancelled', 'rescheduled'])
      .orderBy('id', 'asc')
      .select('source_call_log_id');
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
    // Per-call ADVISORY locks first (sorted), then the triage-row pre-locks
    // — the shared lockTriageCall contract with admin-triage's
    // transitionCore and verdict writers. Ordering our own row locks was
    // not enough: the admin verdict's bulk UPDATE acquires siblings in
    // planner order, so only a common per-call lock taken by BOTH writers
    // before any card write removes the deadlock and the interleaved-count
    // aggregate race.
    //
    // NO other row class is held. The evidence rows (customers, properties,
    // email_messages, scheduled_services, call_log) are re-read fresh below
    // but never FOR UPDATE: there is no verified global lock order across
    // the schedule and customer routes (property-role staging takes
    // customer → call; the on-site prepay switch takes visit → customer),
    // and every row class this sweep once held produced a new AB-BA
    // deadlock against an existing writer (#3811 r9, r12). The ACCEPTED
    // race is the gap between that fresh re-read and the CAS write, inside
    // one nightly job: a contact removal, property edit, bounce,
    // cancellation, or relink committing in those milliseconds is not
    // seen, and its worst case is one card closed as 'auto' that a human
    // would have kept — visible on the Resolved tab's Auto-closed filter
    // and reversible by reopening the card. Do not re-add row locks here
    // without a verified global order.
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
    // Re-verify every decision UNDER the call locks from FRESH evidence —
    // the pre-lock classification is a candidate list, not a verdict. The
    // joined card/call/customer rows (a customer soft-deleted, demoted, or
    // stripped of the address/surname since the scan must re-arm its
    // guards), booking provenance, and the evidence arms are all reloaded
    // inside the transaction.
    const freshRows = await loadCandidateItems(trx, applied.map((d) => d.item.id));
    const freshById = new Map(freshRows.map((r) => [r.id, r]));
    const freshBookedCallIds = await loadBookedCallIds(trx, allCallIds);
    const freshEvidence = await loadEvidence(trx, freshRows);
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
  cardConfirmedUnbooked,
  surnameCameFromCall,
  heardAddressMatchesOnFile,
  callerPhoneOnFile,
  capturedEmails,
  requestedServiceTokens,
  serviceTypeMatches,
  estimateCoversAsk,
  requestedWindow,
  requestedAddressIsOnFile,
  bookingAtRequestedAddress,
  bookingCoversRequest,
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
