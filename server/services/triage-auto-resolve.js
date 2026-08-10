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
 *   (Scheduling-doubt cards get NO booking-based auto-resolution: linkage
 *   timestamps can't distinguish a current routing outcome from a stale
 *   pre-reprocess booking, so those cards wait for human verdicts.)
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
const { lockTriageCall, lockTriageCustomer } = require('../utils/triage-locks');

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
// while the unit is still uncollected — the ask stands until performed. It is
// closed event-driven instead (resolveOpenUnitNumberCards below) when a later
// call's AV accepts a subpremise-complete address for the same building.

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
  spam_aged: `Auto-dismissed: spam/wrong-number advisory unactioned after ${SPAM_AGE_DAYS} days.`,
  advisory_aged: `Auto-dismissed: informational flag unactioned after ${ADVISORY_AGE_DAYS} days.`,
};

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

// ── Event-driven unit-number resolution ─────────────────────────────────
//
// Mirror of customer-email-fanout's resolveOpenEmailReviewCards, for the one
// address ask the nightly moot rules above deliberately never touch: a LATER
// call whose Address Validation accepted a subpremise-complete address (the
// caller finally supplied the unit and it validated) answers the standing
// missing_unit_number card. Without this the card outlives the very
// acceptance that collected the unit (codex #3324 r1 P2).
//
// Same-building corroboration: only cards whose call heard the SAME street
// (V1 address_line1 or V2 street_line_1, unit designators stripped, compared
// suffix-insensitively) as the accepted verdict resolve — a multi-property
// customer's acceptance for a different address must not clear the condo's
// unit ask. A card whose call carried multi-property evidence
// (additional_properties) is never auto-resolved either: one validated unit
// cannot prove which of a landlord's several units in the SAME building it
// answers (pre-push audit P1). Fail closed: missing/unparseable streets keep
// the card. And when MORE THAN ONE open card matches the accepted building,
// none resolve: separate unit-less calls can be two different units in the
// same building (unit 202 validating must not close unit 101's outstanding
// ask), and nothing in the data can attribute the single validated door to
// one card over another — fail closed and leave them for human review
// (pre-push audit P1 r3; the pre-PR status quo for those cards anyway).

// Pure per-card predicate, exported for tests. `row` carries the card's
// call extractions (call_extraction = V2 enriched, call_extraction_v1 = V1);
// `acceptedAddress` is the AV normalized shape ({street_line_1, city,
// postal_code}). The V2 street is AUTHORITATIVE when present — the
// missing-unit verdict was produced by Address Validation run on the
// V2-heard address — and V1 is consulted only when V2 heard no street. Fail
// closed on an unparseable extraction (either side) and on a V1/V2 street
// disagreement: a card whose two extractions name different buildings cannot
// be attributed to either. Building identity is street + PLACE: ZIP is the
// strong discriminator when both sides have one; the city comparison applies
// only when no ZIP pair exists (postal-city aliases — the same rule
// customer-address-fanout documents); NO corroborating pair at all fails
// closed, so an identically-numbered street in another city/ZIP never
// resolves this building's card (pre-push audit P1 r4).
const streetLineKey = (line) => {
  const { streetCompareKey } = require('./call-triage-flags');
  const { splitStreetLineUnit } = require('../utils/address-normalizer');
  const street = splitStreetLineUnit(line).street;
  return street ? streetCompareKey(street) : '';
};
const placeNameKey = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const zip5Of = (z) => (String(z || '').match(/^\d{5}/) || [''])[0];

// Building identity of a card, from its call's extractions:
//   { key, zip, city }     — the extractions unambiguously name ONE building
//   { multiProperty: true } — the call mentioned additional properties, so it
//                             could concern ANY building (incl. the accepted)
//   null                    — identity cannot be established (unparseable
//                             extraction, no street, V1/V2 disagreement)
function unitCardBuildingIdentity(row) {
  const parse = (raw) => {
    if (raw == null) return null;
    if (typeof raw !== 'string') return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined; // unparseable — distinct from absent
    }
  };
  const v2 = parse(row.call_extraction);
  if (v2 === undefined) return null;
  const v1 = parse(row.call_extraction_v1);
  if (v1 === undefined) return null;
  // Multi-property evidence from EITHER extraction shape — the pipeline
  // prefers legacy V1 additional_properties when present, so V1-only
  // evidence is just as disqualifying (pre-push audit P1 r6).
  if ((Array.isArray(v2?.property?.additional_properties) && v2.property.additional_properties.length > 0)
      || (Array.isArray(v1?.additional_properties) && v1.additional_properties.length > 0)) {
    return { multiProperty: true };
  }
  const v2Addr = v2?.property?.service_address || {};
  const v2Key = streetLineKey(String(v2Addr.street_line_1 || '').trim());
  const v1Key = streetLineKey(String(v1?.address_line1 || '').trim());
  if (v2Key && v1Key && v2Key !== v1Key) return null;
  const key = v2Key || v1Key; // V2 (AV's input) outranks; V1 only when V2 silent
  if (!key) return null;
  return {
    key,
    zip: v2Key ? zip5Of(v2Addr.postal_code || v2Addr.zip) : zip5Of(v1?.zip),
    city: v2Key ? placeNameKey(v2Addr.city) : placeNameKey(v1?.city),
  };
}

// Does an identified card name the accepted building? Street key equality +
// place corroboration: ZIP when both sides carry one (strong discriminator),
// else city (postal-city aliases); no corroborating pair fails closed.
function identityMatchesAcceptedAddress(identity, acceptedAddress) {
  const accepted = (acceptedAddress && typeof acceptedAddress === 'object') ? acceptedAddress : {};
  const acceptedKey = streetLineKey(accepted.street_line_1);
  if (!acceptedKey || !identity?.key || identity.key !== acceptedKey) return false;
  const acceptedZip = zip5Of(accepted.postal_code);
  if (acceptedZip && identity.zip) return acceptedZip === identity.zip;
  const acceptedCity = placeNameKey(accepted.city);
  return !!acceptedCity && !!identity.city && acceptedCity === identity.city;
}

// Pure per-card predicate, kept exported for tests: identified,
// single-property, and naming the accepted building.
function unitCardAnsweredByAcceptedStreet(row, acceptedAddress) {
  const identity = unitCardBuildingIdentity(row);
  return !!identity && !identity.multiProperty && identityMatchesAcceptedAddress(identity, acceptedAddress);
}

// Can this call's acceptance speak for a card at all? Only for work that
// already existed when the call came in: a REPROCESS of an older call must
// not erase a unit ask a LATER call raised, since its evidence predates that
// work (codex r9 P1). The accepting call's own cards are always eligible
// (same-call reprocess). Mirrors the SQL bound exactly: no accepting-call
// identity at all = no bound requested (the call processor always supplies
// both); an id without a timestamp admits only that call's own cards; a
// card with an unusable timestamp fails closed.
function unitCardWithinAcceptanceChronology(row, { acceptingCallId = null, acceptingCallAt = null } = {}) {
  if (!acceptingCallId && !acceptingCallAt) return true;
  if (acceptingCallId && row?.call_log_id && String(row.call_log_id) === String(acceptingCallId)) return true;
  if (!acceptingCallAt) return false;
  const created = row?.created_at ? new Date(row.created_at) : null;
  const accepted = new Date(acceptingCallAt);
  if (!created || Number.isNaN(created.getTime()) || Number.isNaN(accepted.getTime())) return false;
  return created <= accepted;
}

// Pure selection over the loaded candidate rows, exported for tests.
// Building matching is separate from resolution eligibility (pre-push audit
// P1 r5): EVERY candidate must be positively attributable before anything
// resolves. A card whose building cannot be established, or a multi-property
// call that could concern the accepted building, makes the attribution
// ambiguous and blocks ALL resolution — a lone "ordinary" match next to a
// multi-property sibling must not resolve. Among identified cards, exactly
// one may name the accepted building. Chronology-ineligible cards are not
// candidates at all (the SQL applies the same bound; this is the tested
// statement of the rule and a safety net if the query ever loosens).
function selectUnitCardsToResolve(candidates, acceptedAddress, chronology = {}) {
  let match = null;
  for (const row of candidates || []) {
    if (!unitCardWithinAcceptanceChronology(row, chronology)) continue;
    const identity = unitCardBuildingIdentity(row);
    if (!identity || identity.multiProperty) return [];
    if (identityMatchesAcceptedAddress(identity, acceptedAddress)) {
      if (match) return []; // two same-building asks — cannot attribute the one validated door
      match = row;
    }
  }
  return match ? [match] : [];
}

// Is ANY missing_unit_number card still outstanding for this customer? The
// lead's rolled-up needs_confirmation reason is a single string that can
// stand for asks about SEVERAL buildings at once, so the cards are its
// per-building ledger: the reason may only be cleared while this returns
// false. Read it LIVE at the moment of the lead write — never from an
// earlier snapshot — and pass the lead-write transaction as `conn` so the
// read serializes with concurrent writers on the same lead (codex r8 P1).
async function hasOpenUnitNumberCards(customerId, conn = db) {
  if (!customerId) return true; // fail closed — cannot prove the ledger is empty
  const row = await conn('triage_items as t')
    .join('call_log as cl', 'cl.id', 't.call_log_id')
    .where('t.reason_code', 'missing_unit_number')
    .whereIn('t.status', ['open', 'in_progress'])
    .where('cl.customer_id', customerId)
    .count('* as n')
    .first();
  return parseInt(row?.n || 0, 10) > 0;
}

// Never throws on a no-op. Returns { resolved, remainingOpen }: how many
// cards this call resolved, and how many missing_unit_number cards were
// still open/in_progress for the customer at commit time (null when nothing
// ran). NOTE both are point-in-time reporting values for logs and tests —
// the lead-reason decision reads hasOpenUnitNumberCards live under the lead
// lock instead, so a retry that already resolved its card (resolved: 0 the
// second time) still clears the reason, and a card filed concurrently still
// holds it. Shares the per-call lock contract (utils/triage-locks.js) and
// the review_status re-sync with the sweep, admin-triage, and the email
// resolver.
async function resolveOpenUnitNumberCards({
  customerId, acceptedAddress, acceptingCallId = null, acceptingCallAt = null,
  source = 'later call validated the full unit address',
}, conn = db) {
  const none = { resolved: 0, remainingOpen: null };
  if (!customerId || !String(acceptedAddress?.street_line_1 || '').trim()) return none;
  const now = new Date();
  const resolveCards = async (trx) => {
    // Customer-scoped lock FIRST (global order, see utils/triage-locks.js):
    // candidate selection and the update must see the SAME card set, or a
    // concurrent resolver's phantom insert breaks the "two same-building
    // asks resolve none" rule (codex r9 P1). Selection therefore happens
    // INSIDE this transaction, under this lock.
    await lockTriageCustomer(trx, customerId);
    const candidateQuery = trx('triage_items as t')
      .join('call_log as cl', 'cl.id', 't.call_log_id')
      .where('t.reason_code', 'missing_unit_number')
      .whereIn('t.status', ['open', 'in_progress'])
      .where('cl.customer_id', customerId);
    // Chronology bound (codex r9 P1): a REPROCESS of an older call must not
    // erase owed work a LATER call filed — its acceptance is stale evidence
    // for anything raised after it. Cards from the accepting call itself are
    // always eligible (the same-call reprocess case). Fail closed: with no
    // accepting-call timestamp, only that call's own cards are eligible.
    if (acceptingCallAt) {
      candidateQuery.where((qb) => {
        qb.where('t.created_at', '<=', acceptingCallAt);
        if (acceptingCallId) qb.orWhere('t.call_log_id', acceptingCallId);
      });
    } else if (acceptingCallId) {
      candidateQuery.where('t.call_log_id', acceptingCallId);
    }
    const candidates = await candidateQuery.select(
      't.id', 't.call_log_id', 't.created_at',
      'cl.ai_extraction_enriched as call_extraction',
      'cl.ai_extraction as call_extraction_v1',
    );
    const answered = selectUnitCardsToResolve(candidates, acceptedAddress, { acceptingCallId, acceptingCallAt });
    if (!answered.length) {
      const remainingNoop = await trx('triage_items as t')
        .join('call_log as cl', 'cl.id', 't.call_log_id')
        .where('t.reason_code', 'missing_unit_number')
        .whereIn('t.status', ['open', 'in_progress'])
        .where('cl.customer_id', customerId)
        .count('* as n')
        .first();
      return { resolved: 0, remainingOpen: parseInt(remainingNoop?.n || 0, 10) };
    }
    const callIds = [...new Set(answered.map((i) => i.call_log_id).filter(Boolean))].sort();
    for (const callId of callIds) await lockTriageCall(trx, callId);
    const updated = await trx('triage_items')
      .whereIn('id', answered.map((i) => i.id))
      .whereIn('status', ['open', 'in_progress'])
      .update({
        status: 'resolved',
        resolution_note: `Auto-resolved: ${String(source).slice(0, 150)} (Address Validation confirmed the exact unit — SUB_PREMISE accept).`,
        resolved_at: now,
        updated_at: now,
      });
    for (const callId of callIds) {
      const stillOpen = await trx('triage_items')
        .where({ call_log_id: callId })
        .whereIn('status', ['open', 'in_progress'])
        .count('* as n')
        .first();
      await trx('call_log')
        .where({ id: callId })
        .update({ review_status: parseInt(stillOpen?.n || 0, 10) > 0 ? 'open' : 'resolved', updated_at: now });
    }
    // Point-in-time report of what is still outstanding (logs/tests only —
    // the lead-reason license re-reads the ledger live at the lead write).
    const remaining = await trx('triage_items as t')
      .join('call_log as cl', 'cl.id', 't.call_log_id')
      .where('t.reason_code', 'missing_unit_number')
      .whereIn('t.status', ['open', 'in_progress'])
      .where('cl.customer_id', customerId)
      .count('* as n')
      .first();
    return { resolved: updated, remainingOpen: parseInt(remaining?.n || 0, 10) };
  };
  return conn.isTransaction ? resolveCards(conn) : conn.transaction(resolveCards);
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
      'c.created_at as customer_created_at',
      'c.deleted_at as customer_deleted_at',
      'c.pipeline_stage as customer_pipeline_stage',
      'c.address_line1 as customer_address_line1',
      'c.zip as customer_zip',
      'c.first_name as customer_first_name',
      'c.last_name as customer_last_name',
    );
  if (itemIds) q.whereIn('t.id', itemIds);
  return q;
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

  const decisions = [];
  for (const item of items) {
    const decision = classifyTriageItem(item, { bookedCallIds }, { now });
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
    const reverified = applied.filter((d) => {
      const fresh = freshById.get(d.item.id);
      if (!fresh) return false; // no longer open — lost the race
      const again = classifyTriageItem(fresh, { bookedCallIds: freshBookedCallIds }, { now });
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
  resolveOpenUnitNumberCards,
  hasOpenUnitNumberCards,
  unitCardAnsweredByAcceptedStreet,
  selectUnitCardsToResolve,
  unitCardWithinAcceptanceChronology,
  classifyTriageItem,
  hasNewAddressEvidence,
  callSuppliedAddress,
  customerPredatesCall,
  callConfirmedUnbooked,
  surnameCameFromCall,
  ADDRESS_MOOT_CODES,
  ADVISORY_AGE_CODES,
  RULE_NOTES,
  SPAM_AGE_DAYS,
  ADVISORY_AGE_DAYS,
  MAX_TRANSITIONS_PER_RUN,
};
