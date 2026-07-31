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
 *   - address flags → the call's customer now has a service address on file
 *     (address_line1 + zip both present)
 *   - missing_last_name → the customer now has a last name
 *   - scheduling/quality flags → the call verifiably produced a booking
 *     (scheduled_services.source_call_log_id provenance — not same-day
 *     coincidence)
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

// Cleared when THIS call provably produced a booking (source_call_log_id
// provenance): the scheduling ambiguity / quality doubt the card raised was
// answered by the booking itself. Deliberately EXCLUDES reschedule_or_cancel
// and existing_appointment_coordination — those cards carry a requested
// schedule TRANSITION for the office to apply, and a created booking proves
// nothing about whether the cancellation/reschedule/coordination happened.
const BOOKING_OUTCOME_CODES = new Set([
  'not_confirmed', 'confirmed_without_start_time', 'ambiguous_scheduling',
  'ambiguous_pest_or_service', 'voicemail', 'low_extraction_confidence',
]);

// Informational flags with no owed work attached — they inform a record edit
// or a callback that either happened long ago or never will. Aged cards keep
// their payload (nothing is deleted) and dedup re-arms on terminal status,
// so a recurrence files a fresh card.
//
// Age dismissal additionally requires the ROW's severity = 'advisory': the
// same reason code can be inserted blocking at one site and advisory at
// another (insert-site severity in call-recording-processor), and a blocking
// card is owed review no matter how old it gets. NOT listed on purpose:
// implied_consent_non_ani_recipient (explicitly asks the office to confirm
// the recipient before the held confirmation SMS goes out — owed work).
const ADVISORY_AGE_CODES = new Set([
  'rental_or_tenant_occupied', 'secondary_contact_captured',
  'second_service_address', 'multi_property_call', 'address_recovered',
  'address_readback', 'caller_phone_not_on_file', 'name_email_mismatch',
  'no_sms_consent_captured', 'sms_consent_missing',
  'low_extraction_confidence', 'voicemail', 'caller_not_authorized',
  'email_unverified', 'email_invalid', 'missing_last_name',
]);

const RULE_NOTES = {
  address_moot: 'Auto-resolved: customer record now has a service address on file (street + zip); address flag is moot.',
  name_moot: 'Auto-resolved: customer record now has a last name; flag is moot.',
  booking_outcome: 'Auto-resolved: this call produced a booking (scheduled_services source_call_log_id linkage); the scheduling/quality flag is moot.',
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

// Did the CALL's own extraction supply a service address? The blocking-loop
// insert sites create address cards with BASE payloads (no address fields),
// so the payload check above cannot see the held-for-validation case there —
// the authoritative signal is the stored V2 extraction. Fail closed: a
// missing/unparseable extraction keeps the card (we cannot prove the call
// supplied nothing).
function callSuppliedAddress(extractionRaw) {
  let extraction = extractionRaw;
  if (!extraction) return true;
  if (typeof extraction === 'string') {
    try {
      extraction = JSON.parse(extraction);
    } catch {
      return true;
    }
  }
  const addr = extraction?.property?.service_address || {};
  return Boolean(
    String(addr.raw_text || '').trim()
    || String(addr.street_line_1 || '').trim()
    || String(addr.city || '').trim()
    || String(addr.postal_code || '').trim(),
  );
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
      && customerPredatesCall(item)
      && !hasNewAddressEvidence(item.payload)
      && !callSuppliedAddress(item.call_extraction)
      && String(item.customer_address_line1 || '').trim() !== ''
      && String(item.customer_zip || '').trim() !== '') {
    return { action: 'resolve', rule: 'address_moot' };
  }
  if (code === 'missing_last_name' && String(item.customer_last_name || '').trim() !== '') {
    return { action: 'resolve', rule: 'name_moot' };
  }
  if (BOOKING_OUTCOME_CODES.has(code) && ctx.bookedCallIds.has(item.call_log_id)) {
    return { action: 'resolve', rule: 'booking_outcome' };
  }
  if (code === 'spam_or_wrong_number' && ageDays(item.created_at, now) >= SPAM_AGE_DAYS) {
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

async function sweep({ now = new Date() } = {}) {
  // OPEN only — in_progress is human-claimed and must never be swept.
  const items = await db('triage_items as t')
    .leftJoin('call_log as cl', 'cl.id', 't.call_log_id')
    .leftJoin('customers as c', 'c.id', 'cl.customer_id')
    .where('t.status', 'open')
    .select(
      't.id', 't.call_log_id', 't.reason_code', 't.status', 't.severity',
      't.created_at', 't.payload',
      'cl.created_at as call_created_at',
      'cl.ai_extraction_enriched as call_extraction',
      'c.created_at as customer_created_at',
      'c.address_line1 as customer_address_line1',
      'c.zip as customer_zip',
      'c.last_name as customer_last_name',
    );

  // Booking provenance in one bulk query (only for calls that need it).
  const bookingCandidateCallIds = [...new Set(
    items.filter((i) => BOOKING_OUTCOME_CODES.has(i.reason_code)).map((i) => i.call_log_id),
  )];
  const bookedCallIds = new Set();
  if (bookingCandidateCallIds.length) {
    const booked = await db('scheduled_services')
      .whereIn('source_call_log_id', bookingCandidateCallIds)
      .distinct('source_call_log_id');
    for (const b of booked) bookedCallIds.add(b.source_call_log_id);
  }

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
  // whose row lost the race must not drive the review_status sync below.
  const counts = {};
  const touchedCalls = new Map(); // call_log_id -> status we applied last
  const itemCallById = new Map(applied.map((d) => [d.item.id, d.item.call_log_id]));
  for (const rule of Object.keys(RULE_NOTES)) {
    const group = applied.filter((d) => d.rule === rule);
    if (!group.length) continue;
    const action = group[0].action;
    const status = action === 'resolve' ? 'resolved' : 'dismissed';
    const updatedRows = await db('triage_items')
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
  // status of the transition that cleared it.
  let callsSynced = 0;
  for (const [callLogId, appliedStatus] of touchedCalls) {
    try {
      const remaining = await db('triage_items')
        .where({ call_log_id: callLogId })
        .whereIn('status', ['open', 'in_progress'])
        .count({ n: '*' })
        .first();
      const next = Number(remaining?.n || 0) > 0 ? 'open' : appliedStatus;
      await db('call_log').where({ id: callLogId }).update({ review_status: next, updated_at: now });
      callsSynced += 1;
    } catch (err) {
      logger.warn(`[triage-sweep] review_status sync failed for call ${callLogId}: ${err.message}`);
    }
  }

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
  ADDRESS_MOOT_CODES,
  BOOKING_OUTCOME_CODES,
  ADVISORY_AGE_CODES,
  RULE_NOTES,
  SPAM_AGE_DAYS,
  ADVISORY_AGE_DAYS,
  MAX_TRANSITIONS_PER_RUN,
};
