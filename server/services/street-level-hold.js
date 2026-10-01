/**
 * Street-level address hold (GATE_CALL_LEAD_FORM_ADDRESS_STREET_LEVEL, owner
 * ruling 2026-09-30): a call-booked visit at a web-form address Google matched
 * only to the street. It lives on the office-review pending path; the durable
 * signal is its outbound_booking_review triage card (payload.street_level_address
 * + payload.scheduled_service_id). The hold lasts while the visit is
 * unconfirmed (customer_confirmed = false) and not cancelled / skipped /
 * rescheduled.
 *
 * Customer-facing reminders wait for the office confirm: the confirm hook arms
 * them (runOutboundReviewConfirmHook), so neither the registration self-heal
 * nor the reminder send pass may act on a held visit.
 */

const db = require('../models/db');
const logger = require('./logger');

// Builds the hold subquery on `q` (a knex builder, e.g. inside whereExists /
// whereNotExists): a card for the outer visit `visitAlias` while that visit is
// unconfirmed and not cancelled / skipped / rescheduled.
function heldVisitSubquery(q, visitAlias = 'ss', { includeClosedOut = false } = {}) {
  const sub = q.select(1)
    .from('triage_items as hold_ti')
    .where('hold_ti.reason_code', 'outbound_booking_review')
    .whereRaw("COALESCE(hold_ti.payload->>'street_level_address', '') = 'true'")
    .whereRaw(`hold_ti.payload->>'scheduled_service_id' = ${visitAlias}.id::text`)
    .whereRaw(`${visitAlias}.customer_confirmed = false`)
    .whereRaw(`${visitAlias}.status NOT IN ('cancelled', 'skipped', 'rescheduled')`);
  // A closeout that settled the hold without approving it (incomplete / declined) is not a live hold —
  // except to the activation guard, which must still refuse to activate it (includeClosedOut).
  return includeClosedOut ? sub : sub.whereRaw("COALESCE(hold_ti.payload->>'closed_out', '') = ''");
}

// The same hold subquery as inline SQL text, for raw-SQL scanners (e.g. `AND NOT EXISTS (${heldVisitSql('s')})`).
// Built from heldVisitSubquery so the two can never drift; the only bindings are constants, inlined by toQuery().
let sqlCompiler = null;
function heldVisitSql(visitAlias = 'ss', opts = {}) {
  // A connection-less knex instance: it only compiles the builder to text (never opens a pool).
  if (!sqlCompiler) sqlCompiler = require('knex')({ client: 'pg' });
  return heldVisitSubquery(sqlCompiler.queryBuilder(), visitAlias, opts).toQuery();
}

// THE live predicate: true while the visit is an unconfirmed street-level hold
// (card present, customer_confirmed false, not cancelled / skipped / rescheduled),
// read fresh from the database. (findStreetLevelHoldCard below is the different
// question — "was this ever a hold", status-agnostic.) A lookup error answers
// true ("still held"): the reminder path must hold on a blip, and the bell path
// rings on a blip.
async function isStreetLevelHoldVisit(scheduledServiceId, conn = db, { includeClosedOut = false } = {}) {
  if (!scheduledServiceId) return false;
  try {
    const row = await conn('scheduled_services as ss')
      .where('ss.id', scheduledServiceId)
      .whereExists(function () { heldVisitSubquery(this, 'ss', { includeClosedOut }); })
      .first('ss.id');
    return !!row;
  } catch (err) {
    logger.warn(`[street-level-hold] hold lookup failed for ${scheduledServiceId}: ${err.code || err.name || 'error'}`);
    return true;
  }
}

function parsePayload(v) {
  if (v && typeof v === 'object') return v;
  try { const o = JSON.parse(v); return o && typeof o === 'object' ? o : null; } catch { return null; }
}

// The LATEST street-level review card for this visit, whatever its status: a
// recording replacement / adoption supersedes (resolves) the card while the
// visit stays pending, so every reader of the hold (the reuse checks, the
// confirm hook's follow-up and disposition legs) keys off the visit's card, not
// its open state. Returns { id, status, payload, summary } or null.
async function findStreetLevelHoldCard(conn, { callLogId, visitId }) {
  if (!callLogId || !visitId) return null;
  const card = await conn('triage_items')
    .where({ call_log_id: callLogId, reason_code: 'outbound_booking_review' })
    .whereRaw("COALESCE(payload->>'street_level_address', '') = 'true'")
    .whereRaw("payload->>'scheduled_service_id' = ?", [String(visitId)])
    .orderBy('created_at', 'desc')
    .first('id', 'status', 'payload', 'summary');
  if (!card) return null;
  return { ...card, payload: parsePayload(card.payload) || {} };
}

// A cancelled / skipped street-level hold visit no longer needs the office's
// address confirmation: resolve its open review card and recompute the call's
// review_status, under the shared per-call lock. Gated on the card signal (only
// a voice_agent-source visit with a street-level card is touched), idempotent,
// never throws. Tri-state like releaseStreetLevelHoldForCompletion:
//   null  = nothing to do (not a hold, card already settled, visit no longer in `toStatus`)
//   true  = THIS call settled the card
//   false = a hold that could not be settled (database failure) — callers that must not
//           lose the settlement (the unsuccessful closeout) keep the work resumable on it.
async function closeHoldCardForEndedVisit(visitId, toStatus, conn = db, { note = null, closedOut = null } = {}) {
  try {
    const visit = await conn('scheduled_services').where({ id: visitId, source_action: 'voice_agent' }).first('id', 'source_call_log_id');
    if (!visit?.source_call_log_id) return null;
    const card = await findStreetLevelHoldCard(conn, { callLogId: visit.source_call_log_id, visitId });
    if (!card) return null;
    const cardOpen = ['open', 'in_progress'].includes(card.status);
    // A card someone already resolved is nothing to do — except an unsuccessful closeout still has to
    // mark it (the marker is what stops the completed visit reading as a live hold).
    if (!cardOpen && !(closedOut && !card.payload?.closed_out)) return null;
    const { lockTriageCall, syncCallReviewStatus } = require('../utils/triage-locks');
    return await conn.transaction(async (trx) => {
      await lockTriageCall(trx, visit.source_call_log_id);
      // Recheck the visit under the lock: a cancellation can be COMPENSATED (the tech
      // went live, so cancellation-processor restores the prior status), and the card
      // must close only while the visit is still in the terminal status that released it.
      const live = await trx('scheduled_services').where({ id: visitId }).forUpdate().first('status', 'customer_confirmed');
      if (!live || String(live.status) !== String(toStatus)) return null;
      const resolved = await trx('triage_items')
        .where({ id: card.id })
        .whereIn('status', cardOpen ? ['open', 'in_progress'] : ['resolved', 'dismissed'])
        .update({
          updated_at: new Date(),
          // An already-settled card keeps its own status and note; only the marker is added.
          ...(cardOpen ? { status: 'resolved', resolved_at: new Date(), resolution_note: note || `Visit ${toStatus} — the address hold no longer applies.` } : {}),
          // An unsuccessful closeout settles the hold without approving the address: the card carries the
          // marker the hold predicates read (a completed visit would otherwise still read as a live hold).
          ...(closedOut ? { payload: trx.raw("COALESCE(payload, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ closed_out: closedOut })]) } : {}),
        });
      await syncCallReviewStatus(trx, visit.source_call_log_id);
      return resolved > 0 ? true : null;
    });
  } catch (err) {
    logger.warn(`[street-level-hold] closing the hold card for ${visitId} failed: ${err.code || err.name || 'error'}`);
    return false;
  }
}

// A reprocess / recording replacement that reuses a held visit may discover a
// follow-up or correct its date: the confirm hook reads the plan from the visit's
// card, so refresh it there (jsonb merge, same transaction as the caller's). A
// null plan never erases an earlier one. Returns true when a card was updated.
async function refreshHoldFollowUpPlan(conn, { callLogId, visitId, plan }) {
  if (!plan) return false;
  // Serialized with the office-confirm hook, which resolves the card (and consumes its plan) under the
  // same per-call lock: either this refresh lands before the hook reads the card, or the hook already
  // consumed it and the late plan is reconciled into the owed-follow-up task below.
  await require('../utils/triage-locks').lockTriageCall(conn, callLogId);
  const card = await findStreetLevelHoldCard(conn, { callLogId, visitId });
  if (!card) return false;
  const next = { scheduled_date: plan.scheduledDate || null, window_start: plan.windowStart || null };
  const cur = card.payload?.follow_up_plan;
  if (cur && cur.scheduled_date === next.scheduled_date && cur.window_start === next.window_start) return false;
  await conn('triage_items')
    .where({ id: card.id })
    .update({
      payload: conn.raw("COALESCE(payload, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ follow_up_plan: next })]),
      updated_at: new Date(),
    });
  // The confirm already consumed this card: the new plan goes to the owed-follow-up task (an open one
  // takes the current plan, a missing one is filed; a handled one and an existing child are left alone).
  if (!['open', 'in_progress'].includes(card.status)) {
    await require('./outbound-review-confirm').fileOwedFollowUpForStreetLevelHold(conn, { id: visitId, source_call_log_id: callLogId });
  }
  return true;
}

// True when the confirm hook filed the owed-follow-up card for this visit's
// street-level hold (any status). Only the hook's own card counts (its reason
// marker), so other owed-follow-up cards on the call are untouched.
async function hasOwedFollowUpForStreetLevelVisit(conn, visit) {
  if (!visit?.id || !visit.source_call_log_id) return false;
  const hold = await findStreetLevelHoldCard(conn, { callLogId: visit.source_call_log_id, visitId: visit.id });
  if (!hold) return false;
  const owed = await conn('triage_items')
    .where({ call_log_id: visit.source_call_log_id, reason_code: 'attached_booking_followup_unbooked' })
    .whereRaw("payload->>'skipped_reason' = 'street_level_address_confirmed_follow_up_unbooked'")
    .first('id');
  return !!owed;
}

// The other ordering: a cancellation COMPENSATED after the close (the tech went live,
// so cancellation-processor restores the prior status through the shared transition)
// must bring the hold's review card back. On a terminal -> live transition, reopen the
// latest street-level card for the visit and recompute the call's review_status, under
// the per-call lock, only while the visit is an unconfirmed hold again. Idempotent and
// order-independent with closeHoldCardForEndedVisit (which rechecks the live status).
async function reopenHoldCardForRestoredVisit(visitId, conn = db) {
  try {
    const visit = await conn('scheduled_services').where({ id: visitId, source_action: 'voice_agent' }).first('id', 'source_call_log_id');
    if (!visit?.source_call_log_id) return false;
    const card = await findStreetLevelHoldCard(conn, { callLogId: visit.source_call_log_id, visitId });
    if (!card || ['open', 'in_progress'].includes(card.status)) return false;
    const { lockTriageCall, syncCallReviewStatus } = require('../utils/triage-locks');
    return await conn.transaction(async (trx) => {
      await lockTriageCall(trx, visit.source_call_log_id);
      const live = await trx('scheduled_services').where({ id: visitId }).forUpdate().first('status', 'customer_confirmed');
      if (!live || live.customer_confirmed || ['cancelled', 'skipped', 'rescheduled'].includes(String(live.status))) return false;
      // The partial unique index allows one open card per call and reason.
      const standing = await trx('triage_items')
        .where({ call_log_id: visit.source_call_log_id, reason_code: 'outbound_booking_review' })
        .whereIn('status', ['open', 'in_progress'])
        .first('id');
      if (standing) return false;
      const reopened = await trx('triage_items')
        .where({ id: card.id })
        .whereIn('status', ['resolved', 'dismissed'])
        .update({
          status: 'open', resolved_at: null, resolution_source: null, updated_at: new Date(),
          resolution_note: 'Reopened: the visit was restored, so the address hold applies again.',
        });
      await syncCallReviewStatus(trx, visit.source_call_log_id);
      return reopened > 0;
    });
  } catch (err) {
    logger.warn(`[street-level-hold] reopening the hold card for ${visitId} failed: ${err.code || err.name || 'error'}`);
    return false;
  }
}

// The owed-follow-up card the confirm hook filed, while it is still OPEN: copy the
// current plan onto it (jsonb merge). Resolved / dismissed cards are never touched, and
// a null or unchanged plan writes nothing. Returns true when a card was updated.
async function refreshOwedFollowUpPlan(conn, visit, plan) {
  if (!plan || !visit?.id || !visit.source_call_log_id) return false;
  const next = { scheduled_date: plan.scheduledDate || null, window_start: plan.windowStart || null };
  const card = await conn('triage_items')
    .where({ call_log_id: visit.source_call_log_id, reason_code: 'attached_booking_followup_unbooked' })
    .whereRaw("payload->>'skipped_reason' = 'street_level_address_confirmed_follow_up_unbooked'")
    .whereIn('status', ['open', 'in_progress'])
    .first('id', 'payload');
  if (!card) return false;
  const payload = parsePayload(card.payload) || {};
  const cur = payload.follow_up_plan;
  if (cur && cur.scheduled_date === next.scheduled_date && cur.window_start === next.window_start) return false;
  await conn('triage_items')
    .where({ id: card.id })
    .whereIn('status', ['open', 'in_progress'])
    .update({
      payload: conn.raw("COALESCE(payload, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ follow_up_plan: next })]),
      updated_at: new Date(),
    });
  return true;
}

// The visit's service address as one comma line (the form the triage list shows the office).
function visitServiceAddressLine(row) {
  return [row?.service_address_line1, row?.service_address_line2, row?.service_address_city, row?.service_address_state, row?.service_address_zip]
    .map((v) => String(v || '').trim()).filter(Boolean).join(', ');
}
// The visit's date and window start as the hold card writes them ("2026-10-05 13:00"), so the live read
// of a moved hold and the card's own captured `visit_when` are the same shape.
function visitWhenLine(row) {
  const day = row?.scheduled_date instanceof Date ? row.scheduled_date.toISOString().slice(0, 10) : String(row?.scheduled_date || '').slice(0, 10);
  return [day, row?.window_start ? String(row.window_start).slice(0, 5) : null].filter(Boolean).join(' ');
}
// Word boundaries survive ("1 23rd Ave" is not "12 3rd Ave"): punctuation becomes one space.
const normAddress = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// The office confirmed the address it was SHOWN: when a confirm of a live street-level hold names
// that address (expected_service_address), it must still be the visit's address under the row lock,
// or a correction made after the dialog opened would be confirmed unseen. 409 address_changed
// otherwise. An absent expectation (any other caller) keeps today's behavior. Throws a status/code
// error the status routes already map.
async function assertExpectedServiceAddress(trx, visitId, expected) {
  const want = normAddress(expected);
  if (!want) return;
  if (!(await isStreetLevelHoldVisit(visitId, trx))) return;
  const row = await trx('scheduled_services').where({ id: visitId }).forUpdate()
    .first('service_address_line1', 'service_address_line2', 'service_address_city', 'service_address_state', 'service_address_zip');
  if (normAddress(visitServiceAddressLine(row)) !== want) {
    throw Object.assign(new Error('The visit address changed since you opened this. Reload and read the current address back to the customer.'), { status: 409, code: 'address_changed' });
  }
}

// The address an office approval was given for. The approval itself is a job_status_history row, which
// carries no address, so the confirm routes record this witness on the hold's review card, in the SAME
// transaction as the approving transition and under the visit row lock: the normalized service address
// the visit has at that instant (when the dialog sent expected_service_address, the check above already
// proved it equals what the office read back). The lazy / stranded-activation retry compares it with the
// visit's current address (approvedAddressStillCurrent), so a retry cannot release the hold for an
// address nobody confirmed. A later approval overwrites it. No-op (false) unless the visit is a live hold.
async function recordApprovedAddressWitness(trx, visitId) {
  const row = await trx('scheduled_services').where({ id: visitId }).forUpdate()
    .first('source_action', 'source_call_log_id', 'service_address_line1', 'service_address_line2', 'service_address_city', 'service_address_state', 'service_address_zip');
  if (!row || row.source_action !== 'voice_agent' || !row.source_call_log_id) return false;
  if (!(await isStreetLevelHoldVisit(visitId, trx))) return false;
  const card = await findStreetLevelHoldCard(trx, { callLogId: row.source_call_log_id, visitId });
  if (!card) return false;
  await trx('triage_items')
    .where({ id: card.id })
    .update({
      payload: trx.raw("COALESCE(payload, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ approved_address: normAddress(visitServiceAddressLine(row)) })]),
      updated_at: new Date(),
    });
  return true;
}

// True when the office approval recorded for this hold is still for the visit's CURRENT address. A hold
// with no witness (approved before the witness existed, or by a caller that never recorded one) keeps
// the old behavior (true). Fails closed (false) on a lookup error: the retry rail tries again later.
async function approvedAddressStillCurrent(dbh, visitId) {
  try {
    const row = await dbh('scheduled_services').where({ id: visitId })
      .first('source_call_log_id', 'service_address_line1', 'service_address_line2', 'service_address_city', 'service_address_state', 'service_address_zip');
    if (!row?.source_call_log_id) return true;
    const card = await findStreetLevelHoldCard(dbh, { callLogId: row.source_call_log_id, visitId });
    const witness = card?.payload?.approved_address;
    if (typeof witness !== 'string' || !witness) return true;
    return normAddress(visitServiceAddressLine(row)) === witness;
  } catch (err) {
    logger.warn(`[street-level-hold] approved-address check failed for ${visitId}: ${err.code || err.name || 'error'}`);
    return false;
  }
}

// The visits whose links a composer draft carries (the reschedule / appointment link inserts send their
// visit's id). Only well-formed ids ride through, de-duplicated and capped; the shared send step checks each
// for a live street-level hold (metadata.linked_scheduled_service_ids).
const MAX_LINKED_VISITS = 5;
const VISIT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function linkedVisitIdsFrom(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((v) => typeof v === 'string' && VISIT_UUID_RE.test(v)).map((v) => v.toLowerCase()))].slice(0, MAX_LINKED_VISITS);
}

const HOLD_REFUSAL = 'Office must confirm the address first. This booking is waiting on an address check before it can be dispatched.';

// The status routes' hold guard, serialized with promotion: take the visit row lock FOR UPDATE (the
// promoter takes the same lock and re-reads eligibility), then re-read the hold under it. A hold promoted
// after the route's pre-check but before this transaction took the lock is caught here; one promoted
// later finds the visit already confirmed and does not promote. Throws the status/code error the routes map.
async function assertNotLiveHoldUnderLock(trx, visitId) {
  await trx('scheduled_services').where({ id: visitId }).forUpdate().first('id');
  if (await isStreetLevelHoldVisit(visitId, trx)) {
    throw Object.assign(new Error(HOLD_REFUSAL), { status: 409, code: 'street_level_hold' });
  }
}

module.exports = { linkedVisitIdsFrom, visitWhenLine, recordApprovedAddressWitness, approvedAddressStillCurrent, assertNotLiveHoldUnderLock, HOLD_REFUSAL, assertExpectedServiceAddress, visitServiceAddressLine, refreshOwedFollowUpPlan, reopenHoldCardForRestoredVisit, hasOwedFollowUpForStreetLevelVisit, heldVisitSubquery, heldVisitSql, isStreetLevelHoldVisit, findStreetLevelHoldCard, closeHoldCardForEndedVisit, refreshHoldFollowUpPlan };
