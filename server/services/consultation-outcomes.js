/**
 * Consultation outcomes — a won/warm/cold/lost record on Waves Assessment
 * visits (server/services/assessment-booking.js: an assessment is NOT a win,
 * the owner walks the property and quotes later). This service records the
 * technician's read of the visit (warm/cold/lost, interests, a soft quote)
 * and reconciles it to 'won' only when a REAL booking or accept later closes
 * for that customer — recording 'won' directly is rejected.
 *
 * Table: server/models/migrations/20260923000010_consultation_outcomes.js
 * One row per scheduled_service_id (unique), upserted on re-record.
 *
 * RECONCILIATION MODEL (round 10): direct hooks (markWonForCustomer called
 * from admin-leads.js and admin-schedule.js right after a qualifying
 * booking commits) are the FAST PATH at the two main manual-booking routes,
 * catching most real sales the moment they happen; the hourly sweep,
 * reconcileOpenConsultationOutcomes, is the COMPLETENESS GUARANTEE that
 * catches every other insert path (existing or future) within its next
 * tick, so this service never again needs a new direct hook wired in to
 * stay correct.
 */

const db = require('../models/db');
const logger = require('./logger');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');
const {
  isAssessmentServiceRow,
  isAssessmentServiceType,
  isAssessmentBooking,
} = require('./assessment-booking');
const { isAlwaysFreeServiceType } = require('./no-cost-visit-types');
const { OFFICE_REVIEW_PENDING_SOURCE_ACTIONS } = require('./call-booking-source-actions');

const OUTCOME_VALUES = ['warm', 'cold', 'lost'];
const LOST_REASON_VALUES = ['price', 'competitor', 'diy', 'not_ready', 'no_show', 'other'];
const CADENCE_VALUES = ['month', 'quarter', 'visit', 'year'];
const WON_WINDOW_DAYS = 90;

function makeError(message, statusCode, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.status = statusCode;
  err.isOperational = true;
  err.code = code;
  return err;
}

// P1-A (round 5 — the round-4 advisory lock was itself a real deadlock,
// caught by the pre-push auditor): recordOutcome's write+evidence-check
// must serialize against markWonForCustomer's reconciling UPDATE, or both
// reconciliation directions can miss a concurrent sale — markWonForCustomer
// runs first, finds zero open rows (the outcome hasn't been recorded yet),
// and commits having done nothing; recordOutcome's own evidence check then
// runs (and commits) before that write is visible, so it can't see it
// either. A warm/cold row can be inserted whose sale already closed and
// never gets reconciled either way. A SAVEPOINT does not fix this — a
// savepoint isolates a FAILURE inside a transaction from the rest of it; it
// does nothing about two SEPARATE, concurrently-committing transactions
// each missing the other's write.
//
// Round 4 closed that gap with a customer-scoped pg_advisory_xact_lock, but
// introduced a NEW deadlock: recordOutcome's insert into
// consultation_outcomes implicitly takes an FK KEY SHARE lock on the
// `customers` (and `leads`) rows it references, taken AFTER the advisory
// lock; a caller of markWonForCustomer (estimate-converter.js's accept
// path: `customers` FOR UPDATE; admin-leads.js's schedule-appointment:
// `leads` FOR UPDATE) already holds that row lock BEFORE it reaches
// markWonForCustomer's advisory-lock call, further down the same
// transaction. FOR UPDATE conflicts with KEY SHARE — TxA (recordOutcome)
// holds the advisory lock and waits on the row (held FOR UPDATE by TxB);
// TxB holds the row FOR UPDATE and waits on the advisory lock (held by
// TxA). Classic ABBA.
//
// FIX: the row lock IS the serialization point — no separate advisory key.
// recordOutcome takes `customers` FOR NO KEY UPDATE (lockCustomerRow,
// below) as the FIRST statement of the transaction that also does its
// insert/merge + evidence check (see recordOutcome). FOR NO KEY UPDATE
// conflicts with FOR UPDATE, with a plain UPDATE's own implicit lock, and
// with itself — so it serializes against every caller exactly as the
// advisory lock intended — and it does NOT conflict with the KEY SHARE the
// insert itself then takes on that SAME row (already held, a no-op
// re-acquisition in the same transaction), which is what removes the ABBA
// cycle: there is no second resource (advisory key) left to reverse-order
// against. markWonForCustomer takes the identical lock, on the identical
// row, as the first statement INSIDE its own savepoint (not on `trx`
// directly — see markWonForCustomer) — never leads, only customers (see
// "why customers only" below).
//
// VERIFIED CALLER ORDER (do not "leads before customers" by assumption —
// admin-leads.js's own comment says otherwise): admin-leads.js's
// schedule-appointment rebook branch explicitly locks `customers` FOR NO
// KEY UPDATE BEFORE `leads` FOR UPDATE ("Customer 360 and lead tools lock
// customer before lead. This row may be promoted below, so acquire its
// write lock in that order."). estimate-converter.js's accept path locks
// only `customers` FOR UPDATE (no leads). Locking `customers` FIRST, as
// recordOutcome's only explicit row lock, matches every caller's order.
//
// ROUND 6 — WIDENED THE CHOKEPOINT, DID NOT JUST REORDER: round 5's own
// "customers only, never an explicit leads pre-lock" reasoning (removed
// here) was insufficient — it only considered an EXPLICIT lock statement,
// not the INSERT's own UNAVOIDABLE implicit FK KEY SHARE lock on whatever
// `lead_id` references. estimate-manual-acceptance.js's call-linkage-
// correction guard (line ~579) locks `leads` FOR UPDATE BEFORE its
// `customers` lock — the OPPOSITE order from admin-leads.js, a real,
// pre-existing cross-file inconsistency this lane cannot resolve (touching
// either of those files is out of scope). Because recordOutcome's INSERT
// references `lead_id` at all, it is FORCED to take an implicit KEY SHARE
// on that row no matter what recordOutcome itself explicitly pre-locks —
// so no in-code lock ORDER inside consultation-outcomes.js can satisfy
// both callers' orders simultaneously. The fix widens the chokepoint
// instead: 20260923000010_consultation_outcomes.js (the table's own
// migration) is already on this PR's pushed branch and cannot be edited —
// Railway's preview has already run it, so an in-place edit is a silent
// no-op there, and the pre-push migration guard blocks the edit anyway. A
// SEPARATE migration, server/models/migrations/
// 20260924000004_drop_consultation_outcomes_lead_fk.js, DROPS the foreign
// key constraint on `lead_id` (keeps the column and its index; leads are
// soft-deleted only, so there was no cascade behavior riding on the FK).
// With no FK, the INSERT takes NO lock of any kind on the referenced lead
// row — recordOutcome's transaction now holds `customers` FOR NO KEY
// UPDATE and, by construction, NO OTHER ROW LOCK. `customers` is the only
// resource recordOutcome and
// markWonForCustomer's lock ever contend on, so a cycle needs two
// transactions to touch two SHARED resources in reversed order — with
// exactly one shared resource, taken as each side's very first touch of
// it, no cycle is possible.
//
// EVERY OTHER FK ON consultation_outcomes, checked the same way (does any
// closeout/completion or estimate-accept transaction hold THAT referenced
// row FOR UPDATE/UPDATE and then lock `customers`?):
//   - customer_id → customers: safe BY CONSTRUCTION — recordOutcome holds
//     this exact row itself, first; the INSERT's KEY SHARE on it is a
//     no-op re-acquisition.
//   - scheduled_service_id → scheduled_services: safe. The completion/
//     closeout transaction (complete-scheduled-service.js
//     completeScheduledService, persistRecord) explicitly documents and
//     locks `customers FOR SHARE` BEFORE `scheduled_services FOR UPDATE`
//     ("Customer FOR SHARE is taken BEFORE the visit lock — the same
//     customer → visit order customer-dedupe's executeMerge uses"). An
//     EARLIER `scheduled_services FOR UPDATE` in the same function
//     (visitRecheck, the visit-group re-check) runs in its OWN separate
//     `db.transaction(visitRecheck)` that commits and releases before
//     persistRecord's transaction opens — never held concurrently with
//     the later customers lock. estimate-converter.js's
//     acquireConverterInvoiceDepositLocks (the estimate-accept deposit
//     lock helper) takes `customers FOR KEY SHARE` THEN
//     `scheduled_services FOR UPDATE`, and is only ever called (from
//     convertEstimate) after that flow's own earlier `customers FOR
//     UPDATE` (a stronger, already-held lock) — same order throughout.
//   - technician_id → technicians: safe. `technicians FOR UPDATE` is
//     taken in exactly one place repo-wide (admin-timetracking.js's PUT
//     .../capabilities), a technician-record edit that never touches
//     `customers` in the same transaction — no shared resource, so no
//     cycle is possible regardless of order. The only other
//     `technicians` lock reads (complete-scheduled-service.js,
//     estimate-converter.js) are FOR SHARE, which doesn't conflict with
//     KEY SHARE at all (Postgres row-lock matrix: FOR SHARE and FOR KEY
//     SHARE never conflict with each other), so even a concurrent one is
//     never a wait point.
//   - There is no won_booking_id / won_estimate_id or other attribution
//     FK on this table — won_at/won_via are plain timestamp/string
//     columns, not foreign keys.
async function lockCustomerRow(database, customerId) {
  if (!customerId) return;
  await database('customers').where({ id: customerId }).forNoKeyUpdate().first('id');
}

// Postgres SQLSTATEs a genuine lock conflict can surface as — Postgres's
// own deadlock detector aborts one side (40P01), or a stricter isolation
// level's write conflict (40001, not used here under READ COMMITTED but
// mapped defensively) — never a caller bug. Same convention as
// estimate-public.js's accept-transaction `.catch`: map to the retryable
// 409 shape the route already returns for an operational error, instead of
// an unmapped 500 that reads as "your save failed" when a retry would
// simply succeed.
const RETRYABLE_TX_SQLSTATES = new Set(['40P01', '40001']);
function isRetryableTxError(err) {
  return !!(err && RETRYABLE_TX_SQLSTATES.has(err.code));
}

// Sync check for a caller that already has a scheduled_services row (with or
// without the joined catalog columns) — reuses the shared predicate rather
// than re-deriving it. Callers that only have a bare service_type string, or
// need the catalog-FK fallback for a legacy row, use isAssessmentBooking
// (async, DB-aware) directly instead.
function isConsultationVisit(svcRow) {
  if (!svcRow) return false;
  return isAssessmentServiceType(svcRow.service_type) || isAssessmentServiceRow(svcRow);
}

// The lead this visit's outcome belongs to. Mirrors admin-leads.js
// schedule-appointment: an assessment booking claims the lead by stamping
// leads.customer_id, so the newest non-deleted lead on that customer is the
// link — best-effort, never blocks the outcome write.
async function deriveLinkage(svcRow, database) {
  const customerId = svcRow.customer_id || null;
  const technicianId = svcRow.technician_id || null;
  let leadId = null;
  if (customerId) {
    try {
      const leadRow = await database('leads')
        .where({ customer_id: customerId })
        .whereNull('deleted_at')
        .orderBy('created_at', 'desc')
        .first('id');
      leadId = leadRow ? leadRow.id : null;
    } catch (err) {
      logger.warn(`[consultation-outcomes] lead lookup failed for customer ${customerId}: ${err.message}`);
    }
  }
  return { customerId, technicianId, leadId };
}

// P1-B: followUpAt is a caller-supplied datetime, often typed by a
// technician as a naive local string ("2026-09-25T09:00", no offset). Railway
// runs TZ=UTC, so a bare `new Date(followUpAt)` on that string reads it as
// UTC — 9am ET became 9am UTC, four hours early. parseETDateTime already
// carries the exact fix for this shape of bug (server/utils/datetime-et.js):
// a naive "YYYY-MM-DDTHH:mm[:ss]" string is treated as ET wall-clock; a
// string with an explicit offset/Z, an already-absolute Date, or anything
// else passes straight to `new Date(...)` unchanged. recordOutcome validates
// followUpAt up front (see below) and rejects an invalid one with 400 before
// this is ever called, so a truthy followUpAt reaching here is always valid.
function isValidFollowUpAt(followUpAt) {
  if (followUpAt == null || followUpAt === '') return true; // optional — not a validation failure
  const parsed = parseETDateTime(followUpAt);
  return parsed instanceof Date && !Number.isNaN(parsed.getTime());
}

function defaultFollowUpAt(outcome, followUpAt) {
  if (followUpAt) return parseETDateTime(followUpAt);
  if (outcome === 'warm') return addETDays(new Date(), 3);
  if (outcome === 'cold') return addETDays(new Date(), 30);
  return null;
}

// The visit's scheduled_date as a plain 'YYYY-MM-DD' — pg hands a DATE
// column back as either a Date (midnight UTC on Railway's TZ=UTC box) or,
// over some drivers/mocks, already a string; normalize once (shared by
// consultationStats' own scheduledDateStr derivation below).
//
// P1-1: a DATE column must NEVER be run through etDateString. That helper
// treats its input as an absolute instant and converts it to ET — so pg's
// UTC-midnight Date for '2026-09-10' reads as '2026-09-09' 20:00/19:00 ET
// the day before, and etDateString hands back '2026-09-09'. Read a Date's
// calendar fields with the UTC getters instead (mirrors the Date branch of
// server/services/auto-dispatch/dates.js's toDateStr).
function toDateOnlyString(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

// Round 8: four straight rounds patched findSaleEvidenceForConsultation's
// non-assessment-booking evidence check with one more excluded class at a
// time (P1-B is_callback, then recurring_parent_id, then followup_included +
// isAlwaysFreeServiceType). This is the restructure — ONE positive
// predicate, THE decision point both call sites use, instead of scattered
// negative checks that need re-deriving (and re-missing a case) every time
// a new non-sale booking shape turns up.
//
// THE RULE: a scheduled_services row counts as evidence of a real,
// confirmed sale only if its status is one still on the books in some
// active-or-done form (not cancelled/skipped/no_show — a visit that never
// happened proves nothing was bought), it is not an AI-created booking
// still awaiting office review (OFFICE_REVIEW_PENDING_SOURCE_ACTIONS +
// customer_confirmed — voice-agent/outbound-callback bookings; office
// confirm is what makes one real, exactly as job-status.js's own
// OFFICE_REVIEW_PENDING_SOURCE_ACTIONS + customer_confirmed check keys the
// SAME "still needs activation" decision on), and it is not one of the
// four already-established non-sale classes: a free re-service callback
// (is_callback), a recurring-series child spawned onto an EXISTING plan
// (recurring_parent_id), an included $0 follow-up minted from a completion
// (followup_included), or any other service type this codebase already
// treats as ALWAYS no-cost by name (isAlwaysFreeServiceType).
//
// 'pending' is deliberately IN the qualifying status set: it is the
// default initial status for every ordinary staff/customer booking (e.g.
// admin-leads.js's schedule-appointment inserts status:'pending' and is
// confirmed later) — plain 'pending' is NOT itself an office-review
// signal. Only the source_action + customer_confirmed combination marks a
// row as still awaiting office review; a manual booking's customer_confirmed
// defaults to false too (schema default), so that field is read ONLY in
// combination with OFFICE_REVIEW_PENDING_SOURCE_ACTIONS membership, never
// standalone — reading it standalone would wrongly disqualify every manual
// booking, which never sets it at all.
//
// NOT the "another consultation is not a sale" check (isAssessmentBooking)
// — that one is async (a legacy-row catalog lookup) and stays a separate
// check in the caller's loop; this predicate is intentionally sync and
// single-argument (`row`) so both call sites can run it against a plain
// scheduled_services row with no extra query.
const QUALIFYING_BOOKING_STATUSES = new Set([
  'pending', 'confirmed', 'rescheduled', 'en_route', 'on_site', 'completed',
]);

function isQualifyingSaleBooking(row) {
  if (!row) return false;
  if (!QUALIFYING_BOOKING_STATUSES.has(row.status)) return false;
  if (OFFICE_REVIEW_PENDING_SOURCE_ACTIONS.includes(row.source_action) && !row.customer_confirmed) return false;
  if (row.is_callback) return false;
  if (row.recurring_parent_id) return false;
  if (row.followup_included) return false;
  if (isAlwaysFreeServiceType(row.service_type)) return false;
  return true;
}

/**
 * Reconciliation from the CONSULTATION side (P1-1): a sale can commit
 * BEFORE the technician gets around to recording the visit's outcome, in
 * which case markWonForCustomer already ran and found nothing to win — a
 * warm/cold row recorded afterward would otherwise sit open forever. Checks,
 * in order, for the first qualifying evidence dated on/after the visit's
 * scheduled_date (ET) and on/before BOTH `now` (P1-2 — never a future date)
 * and the visit's own 90-day window:
 *   (a) leads.converted_at for any lead on this customer,
 *   (b) an accepted estimate for this customer (estimates.status='accepted',
 *       accepted_at),
 *   (c) a non-assessment scheduled_services row for this customer created
 *       after the visit that is a genuine NEW booking — another
 *       consultation, a free callback (is_callback), a recurring-series
 *       child spawned onto an EXISTING plan (recurring_parent_id), an
 *       included $0 follow-up minted from a completion (followup_included),
 *       or any other ALWAYS-free service type (isAlwaysFreeServiceType —
 *       appointment/estimate/re-service/follow-up/re-visit by name) is
 *       never itself a sale.
 * Returns { won_via, won_at } for the first match, or null.
 */
async function findSaleEvidenceForConsultation(database, { customerId, scheduledDateStr, now = new Date() }) {
  if (!customerId) return null;

  const nowDateStr = etDateString(now);
  const windowEndDate = addETDays(new Date(`${scheduledDateStr}T12:00:00Z`), WON_WINDOW_DAYS);
  const windowEndStr = etDateString(windowEndDate);
  // Never later than `now` (P1-2), and never past the visit's own window.
  const upperBoundStr = nowDateStr < windowEndStr ? nowDateStr : windowEndStr;

  // P1-2: real Date bounds, applied IN each query, not a JS filter run
  // AFTER an ORDER BY ... LIMIT 1 already picked a row. The old accepted-
  // estimate read ordered by accepted_at ASC and took .first() before
  // checking the range — so a customer's oldest-ever acceptance always won
  // that .first() and could fail the in-range check even though a LATER
  // acceptance qualified, hiding it entirely. Bounding the query itself (and
  // ordering ASC so the earliest QUALIFYING row wins) applies to all three
  // evidence reads. lowerBound is the visit's scheduled_date at ET midnight;
  // upperBound is upperBoundStr's ET day, +999ms so the final sub-second of
  // that day is inclusive (mirrors admin-leads.js's parseInclusiveEnd).
  const lowerBound = parseETDateTime(`${scheduledDateStr}T00:00:00`);
  const upperBound = new Date(parseETDateTime(`${upperBoundStr}T23:59:59`).getTime() + 999);

  const convertedLead = await database('leads')
    .where({ customer_id: customerId })
    .whereNotNull('converted_at')
    .where('converted_at', '>=', lowerBound)
    .where('converted_at', '<=', upperBound)
    .orderBy('converted_at', 'asc')
    .first('converted_at');
  if (convertedLead) {
    return { won_via: 'office_booking', won_at: new Date(convertedLead.converted_at) };
  }

  const acceptedEstimate = await database('estimates')
    .where({ customer_id: customerId, status: 'accepted' })
    .whereNotNull('accepted_at')
    .where('accepted_at', '>=', lowerBound)
    .where('accepted_at', '<=', upperBound)
    .orderBy('accepted_at', 'asc')
    .first('accepted_at');
  if (acceptedEstimate) {
    return { won_via: 'estimate_accept', won_at: new Date(acceptedEstimate.accepted_at) };
  }

  const bookings = await database('scheduled_services')
    .where({ customer_id: customerId })
    .where('created_at', '>=', lowerBound)
    .where('created_at', '<=', upperBound)
    .orderBy('created_at', 'asc')
    .select(
      'id', 'service_type', 'service_id', 'created_at',
      // Every field isQualifyingSaleBooking's single positive rule needs —
      // see the comment above that function for what each one decides.
      'status', 'source_action', 'customer_confirmed',
      'is_callback', 'recurring_parent_id', 'followup_included',
    );
  for (const booking of bookings) {
    if (await isAssessmentBooking(booking, database)) continue; // another consultation is not a sale — separate, async, not part of the sync predicate
    if (!isQualifyingSaleBooking(booking)) continue;
    return { won_via: 'office_booking', won_at: new Date(booking.created_at) };
  }

  return null;
}

// Shared by recordOutcome's post-record reconciliation AND the hourly sweep
// (reconcileOpenConsultationOutcomes, below): runs the evidence check for
// ONE already-identified customer/visit, and — only if it finds qualifying
// evidence — the same guarded win UPDATE (WHERE outcome IN warm/cold, so a
// row that resolved between the caller's read and this write is provably
// untouched). Runs inside its own transaction (a SAVEPOINT when `database`
// is already a caller transaction/savepoint), matching the "insert +
// evidence check as one unit" discipline P1-A established — but this
// function does NOT take the customer-row lock itself; the caller must
// already hold it (recordOutcome via its own lockCustomerRow call before
// the insert; the sweep via reconcileOneOpenOutcome). Returns the won row,
// or null when no qualifying evidence was found. Throws on a genuine DB
// error — best-effort is the CALLER's responsibility (each logs its own
// context), not this shared piece.
async function attemptEvidenceBasedWin(database, {
  outcomeRowId, customerId, scheduledDateStr, now,
}) {
  let won = null;
  await database.transaction(async (sp) => {
    const evidence = await findSaleEvidenceForConsultation(sp, { customerId, scheduledDateStr, now });
    if (!evidence) return;
    const [wonRow] = await sp('consultation_outcomes')
      .where({ id: outcomeRowId })
      .whereIn('outcome', ['warm', 'cold'])
      .update({ outcome: 'won', won_at: evidence.won_at, won_via: evidence.won_via, updated_at: new Date() })
      .returning('*');
    won = wonRow || null;
  });
  return won;
}

// The sweep's per-row unit of work: lock the customer row FIRST (P1-A
// discipline — see lockCustomerRow), then attempt the evidence-based win
// for this one already-existing open outcome row, both inside ONE
// transaction. Unlike recordOutcome (which has an insert to run under the
// same lock), the sweep has nothing else to do under it, so lock-then-
// attempt collapses into this one small wrapper.
async function reconcileOneOpenOutcome(database, {
  outcomeRowId, customerId, scheduledDateStr, now,
}) {
  return database.transaction(async (locked) => {
    await lockCustomerRow(locked, customerId);
    return attemptEvidenceBasedWin(locked, {
      outcomeRowId, customerId, scheduledDateStr, now,
    });
  });
}

/**
 * Record (or re-record) the technician's read of a consultation visit.
 * Never accepts outcome 'won' — that is stamped only by markWonForCustomer
 * when a real booking/accept closes.
 */
async function recordOutcome(params = {}, { trx } = {}) {
  const database = trx || db;
  const {
    scheduledServiceId, outcome, lostReason = null, interests = [],
    quotedAmount = null, quotedCadence = null, quoteNotes = null,
    followUpAt = null, recordedBy = null,
  } = params;

  if (!scheduledServiceId) throw makeError('scheduledServiceId is required', 400, 'VALIDATION');
  if (outcome === 'won') {
    throw makeError(
      "outcome 'won' cannot be recorded directly — it is stamped only when a real booking or accept closes",
      400,
      'VALIDATION',
    );
  }
  if (!OUTCOME_VALUES.includes(outcome)) {
    throw makeError(`outcome must be one of ${OUTCOME_VALUES.join(', ')}`, 400, 'VALIDATION');
  }
  if (outcome === 'lost' && !lostReason) {
    throw makeError('lostReason is required when outcome is lost', 400, 'VALIDATION');
  }
  if (lostReason && !LOST_REASON_VALUES.includes(lostReason)) {
    throw makeError(`lostReason must be one of ${LOST_REASON_VALUES.join(', ')}`, 400, 'VALIDATION');
  }
  if (quotedCadence && !CADENCE_VALUES.includes(quotedCadence)) {
    throw makeError(`quotedCadence must be one of ${CADENCE_VALUES.join(', ')}`, 400, 'VALIDATION');
  }
  if (interests != null && !Array.isArray(interests)) {
    throw makeError('interests must be an array', 400, 'VALIDATION');
  }
  if (quotedAmount != null && !Number.isFinite(Number(quotedAmount))) {
    throw makeError('quotedAmount must be a number', 400, 'VALIDATION');
  }
  if (!isValidFollowUpAt(followUpAt)) {
    throw makeError(
      'followUpAt must be a valid date/time — a naive local time like "2026-09-25T09:00" is read as ET, or pass an ISO string with an explicit offset/Z',
      400,
      'VALIDATION',
    );
  }

  const svcRow = await database('scheduled_services').where({ id: scheduledServiceId }).first();
  if (!svcRow) throw makeError('Scheduled service not found', 404, 'NOT_FOUND');
  if (!(await isAssessmentBooking(svcRow, database))) {
    throw makeError('That visit is not a Waves Assessment consultation', 409, 'NOT_CONSULTATION');
  }

  const { customerId, technicianId, leadId } = await deriveLinkage(svcRow, database);
  const now = new Date();
  const row = {
    scheduled_service_id: scheduledServiceId,
    lead_id: leadId,
    customer_id: customerId,
    technician_id: technicianId,
    outcome,
    lost_reason: outcome === 'lost' ? lostReason : null,
    interests: JSON.stringify(Array.isArray(interests) ? interests : []),
    quoted_amount: quotedAmount != null ? quotedAmount : null,
    quoted_cadence: quotedCadence || null,
    quote_notes: quoteNotes || null,
    follow_up_at: defaultFollowUpAt(outcome, followUpAt),
    recorded_by: recordedBy || null,
    recorded_at: now,
    updated_at: now,
  };

  // P1-A: the insert/merge below AND the evidence check that follows it must
  // run as ONE unit under the shared customer row lock (see lockCustomerRow
  // above) — a transaction of its own (a SAVEPOINT when `database` is
  // already a caller transaction), starting with the lock, BEFORE either
  // the write or the evidence reads. This is what closes the race:
  // whichever of this call and a concurrent markWonForCustomer takes the
  // lock first now runs to completion — write AND evidence check together
  // — before the other proceeds, so the second side's reads are always
  // against the first side's committed state.
  const txResult = database.transaction(async (locked) => {
    await lockCustomerRow(locked, customerId);

    // Atomic upsert guard (waves-db-adjacent — no read-then-write TOCTOU
    // against markWonForCustomer's concurrent reconciliation): the conflict
    // UPDATE only fires while the existing row's outcome is NOT 'won'. A
    // genuine insert (no conflicting row) is unaffected by this WHERE — it
    // only gates the UPDATE branch — so `saved` is undefined in exactly one
    // case: a conflicting row exists AND it is already 'won'.
    const [saved] = await locked('consultation_outcomes')
      .insert(row)
      .onConflict('scheduled_service_id')
      .merge({
        lead_id: row.lead_id,
        customer_id: row.customer_id,
        technician_id: row.technician_id,
        outcome: row.outcome,
        lost_reason: row.lost_reason,
        interests: row.interests,
        quoted_amount: row.quoted_amount,
        quoted_cadence: row.quoted_cadence,
        quote_notes: row.quote_notes,
        follow_up_at: row.follow_up_at,
        recorded_by: row.recorded_by,
        recorded_at: row.recorded_at,
        updated_at: row.updated_at,
      })
      .where('consultation_outcomes.outcome', '<>', 'won')
      .returning('*');

    if (!saved) {
      throw makeError('This consultation already converted — its outcome cannot be edited', 409, 'ALREADY_WON');
    }

    // P1-1: the sale may have already closed BEFORE the tech got around to
    // recording this outcome — markWonForCustomer ran against zero rows in
    // that case, and a warm/cold row saved afterward would sit open forever.
    // Savepoint-isolated (waves-db §5b) and best-effort: an evidence-lookup
    // hiccup must never fail the record itself, or abort the lock-holding
    // transaction above it. attemptEvidenceBasedWin (below) is the SAME
    // evidence-check-then-guarded-UPDATE the hourly sweep
    // (reconcileOpenConsultationOutcomes) reuses for every other insert
    // path — this call site inlines the customer-row lock above because it
    // ALSO has the insert/merge to run under it first; the sweep has no
    // insert, so it locks + attempts in one step via reconcileOneOpenOutcome.
    if (['warm', 'cold'].includes(saved.outcome)) {
      try {
        const won = await attemptEvidenceBasedWin(locked, {
          outcomeRowId: saved.id,
          customerId,
          scheduledDateStr: toDateOnlyString(svcRow.scheduled_date),
          now,
        });
        if (won) return won;
      } catch (err) {
        logger.warn(`[consultation-outcomes] post-record sale-evidence reconciliation failed for ${scheduledServiceId}: ${err.message}`);
      }
    }

    return saved;
  });

  // P1-A: a genuine lock conflict (40P01 deadlock-victim abort, or a
  // serialization failure) is retryable, not a caller error — surface it
  // as the same 409 operational-error shape ALREADY_WON above uses, so the
  // route's existing `isOperational && statusCode` mapping (no route
  // change needed) returns 409 instead of falling through to an unmapped
  // 500 that reads as "your save failed" to a technician who just needs to
  // tap Save again.
  return txResult.catch((txErr) => {
    if (isRetryableTxError(txErr)) {
      throw makeError(
        'A concurrent update interrupted this save — please try again',
        409,
        'CONCURRENT_UPDATE',
      );
    }
    throw txErr;
  });
}

/**
 * Reconciliation: a real booking/accept closed for this customer. Stamps
 * 'won' on every open (warm/cold) consultation_outcomes row for the
 * customer OR its leads whose VISIT was scheduled within the last 90 ET
 * days. Idempotent (only warm/cold rows match; a second call finds none).
 *
 * Best-effort and caller-transaction-safe (waves-db §5b): the write runs
 * inside a SAVEPOINT on the caller's `trx` so a failure here can never abort
 * the booking/accept that is reconciling. Returns the count won (0 on any
 * failure or no match) — never throws.
 */
async function markWonForCustomer(customerId, { via, trx, now = new Date() } = {}) {
  if (!customerId || !trx || !via) return 0;
  try {
    let winCount = 0;
    // P1-A: the lock statement sits INSIDE the savepoint, as its first
    // statement — never directly on `trx` before the savepoint opens (that
    // was round 4's placement, and it was doubly wrong: it both created the
    // FK-KEY-SHARE ABBA cycle described above AND put a failure on that
    // statement outside any savepoint's ROLLBACK TO SAVEPOINT safety net —
    // a genuine deadlock there would have aborted the CALLER's whole
    // transaction (the booking/accept itself), not just this best-effort
    // reconciliation, defeating the entire point of running in a
    // savepoint. With the lock as `sp`'s first statement, ANY failure here
    // — the lock, the reconciling UPDATE, a future addition — is contained
    // by knex's automatic ROLLBACK TO SAVEPOINT before the outer `catch`
    // below ever sees it, so `trx` is always left valid for the caller to
    // keep writing to.
    //
    // Defense-in-depth, not reliance on the caller (P1-A follow-up):
    // proposal-win.js's promoteLinkedCustomerForProposalWin only UPDATEs
    // (and so only locks) `customers` when commercialWinPromotionStamps
    // returns a non-empty patch — a repeat-commercial customer already at
    // active_customer/active/unchurned/non-deleted produces an EMPTY
    // patch, so that caller reaches markWonForCustomer holding NO lock on
    // `customers` at all in that case. Taking the SAME lockCustomerRow
    // here too closes that gap unconditionally, rather than depending on
    // every current AND future caller happening to lock the row first —
    // re-acquiring a lock this transaction already holds (the common
    // case, e.g. admin-leads.js, estimate-converter.js) is a no-op.
    await trx.transaction(async (sp) => {
      await lockCustomerRow(sp, customerId);
      const leadRows = await sp('leads').where({ customer_id: customerId }).select('id');
      const leadIds = leadRows.map((r) => r.id);
      const cutoff = etDateString(addETDays(now, -WON_WINDOW_DAYS));
      // Upper bound (P1-2): a consultation scheduled in the future must never
      // be marked won by today's booking — that would also send
      // median_days_to_close negative. Bounds the window on BOTH sides.
      const nowDateStr = etDateString(now);

      // One atomic UPDATE: the outcome guard (only an open warm/cold row can
      // win) and the [90-day-ago, today] window (a subquery against
      // scheduled_services, not a prior SELECT) both live in the same
      // statement's WHERE, so nothing can flip a row's outcome between
      // "read" and "write" — there is no read. The win count is the rows
      // this UPDATE actually touched, never a pre-computed candidate list.
      const updated = await sp('consultation_outcomes')
        .whereIn('outcome', ['warm', 'cold'])
        .where(function matchCustomerOrItsLeads() {
          this.where('customer_id', customerId);
          if (leadIds.length) this.orWhereIn('lead_id', leadIds);
        })
        .whereIn('scheduled_service_id', function liveVisits() {
          this.select('id').from('scheduled_services')
            .where('scheduled_date', '>=', cutoff)
            .where('scheduled_date', '<=', nowDateStr);
        })
        .update({ outcome: 'won', won_at: now, won_via: via, updated_at: now })
        .returning('id');
      winCount = updated.length;
    });
    return winCount;
  } catch (err) {
    logger.error(`[consultation-outcomes] markWonForCustomer failed for customer ${customerId} (via ${via}): ${err.message}`);
    return 0;
  }
}

/**
 * Round 10 — THE COMPLETENESS GUARANTEE (see the file header): rather than
 * hook markWonForCustomer into every scheduled_services insert site
 * one-by-one (a race the repo cannot win — estimate-accept, proposal-win,
 * admin-leads, admin-schedule, the funnel, voice-relay confirm, re-service,
 * and whatever ships next all create real bookings), this sweep scans every
 * OPEN (warm/cold) consultation_outcomes row whose visit falls within the
 * 90-day attribution window and re-runs the SAME evidence check
 * (findSaleEvidenceForConsultation) recordOutcome's own post-record
 * reconciliation uses. Any insert path this file has no direct hook for —
 * or ever will not — is covered here on the next hourly tick.
 *
 * Idempotent (the guarded UPDATE only ever touches a still-open warm/cold
 * row — a re-run over an already-won row finds nothing to do) and
 * best-effort PER ROW: one row's failure (lock contention, a transient DB
 * error) is logged and skipped, never aborts the rest of the sweep. Bounded
 * by `limit` so one very large backlog can't turn an hourly tick into an
 * hours-long one; the next tick picks up whatever this one didn't reach
 * (oldest-recorded-first, so the same rows aren't perpetually starved by a
 * skewed ordering).
 *
 * Returns { scanned, won, errors } — never throws.
 */
async function reconcileOpenConsultationOutcomes({ now = new Date(), limit = 200 } = {}) {
  const result = { scanned: 0, won: 0, errors: 0 };
  let rows;
  try {
    const cutoff = etDateString(addETDays(now, -WON_WINDOW_DAYS));
    const nowDateStr = etDateString(now);
    // Same [90-days-ago, today] visit-date window markWonForCustomer's own
    // atomic UPDATE bounds itself to (P1-2) — a consultation scheduled in
    // the future, or one long past its attribution window, is never
    // reconciled by either path.
    rows = await db('consultation_outcomes as co')
      .join('scheduled_services as ss', 'ss.id', 'co.scheduled_service_id')
      .whereIn('co.outcome', ['warm', 'cold'])
      .whereNotNull('co.customer_id')
      .where('ss.scheduled_date', '>=', cutoff)
      .where('ss.scheduled_date', '<=', nowDateStr)
      .orderBy('co.recorded_at', 'asc')
      .limit(limit)
      .select('co.id as outcome_id', 'co.customer_id', 'ss.scheduled_date');
  } catch (err) {
    logger.error(`[consultation-outcomes] reconcile sweep query failed: ${err.message}`);
    result.errors += 1;
    return result;
  }

  result.scanned = rows.length;
  for (const row of rows) {
    try {
      const wonRow = await reconcileOneOpenOutcome(db, {
        outcomeRowId: row.outcome_id,
        customerId: row.customer_id,
        scheduledDateStr: toDateOnlyString(row.scheduled_date),
        now,
      });
      if (wonRow) result.won += 1;
    } catch (err) {
      result.errors += 1;
      logger.warn(`[consultation-outcomes] reconcile sweep failed for outcome ${row.outcome_id}: ${err.message}`);
    }
  }
  return result;
}

/**
 * A consultation visit's status flips to 'no_show'. If it's a consultation
 * with no outcome row (or an open warm/cold one), overwrite/write
 * outcome='lost', lost_reason='no_show'. A visit already 'lost' or 'won' is
 * left untouched — a no-show flip must not regress a closed outcome.
 */
async function markNoShow(scheduledServiceId, { trx } = {}) {
  const database = trx || db;
  if (!scheduledServiceId) return null;
  const svcRow = await database('scheduled_services').where({ id: scheduledServiceId }).first();
  if (!svcRow) return null;
  if (!(await isAssessmentBooking(svcRow, database))) return null;

  const now = new Date();

  // Atomic conditional UPDATE — no read-then-write TOCTOU against a
  // concurrent recordOutcome or markWonForCustomer: the WHERE outcome IN
  // (warm, cold) guard lives on the UPDATE itself, so a row that has
  // already resolved lost/won in the meantime is provably untouched by
  // this statement (not by a JS check on a stale read).
  const updated = await database('consultation_outcomes')
    .where({ scheduled_service_id: scheduledServiceId })
    .whereIn('outcome', ['warm', 'cold'])
    .update({ outcome: 'lost', lost_reason: 'no_show', won_via: null, won_at: null, updated_at: now })
    .returning('*');
  if (updated.length) return updated[0];

  // Nothing updated: either no row exists yet, or one exists but is already
  // lost/won (left untouched by design — this read is only to return the
  // current state, not a guard). Insert-if-missing races a concurrent
  // writer via onConflict().ignore(); losing that race reads back whichever
  // row won.
  const existing = await database('consultation_outcomes')
    .where({ scheduled_service_id: scheduledServiceId })
    .first();
  if (existing) return existing;

  const { customerId, technicianId, leadId } = await deriveLinkage(svcRow, database);
  const [created] = await database('consultation_outcomes')
    .insert({
      scheduled_service_id: scheduledServiceId,
      lead_id: leadId,
      customer_id: customerId,
      technician_id: technicianId,
      outcome: 'lost',
      lost_reason: 'no_show',
      interests: JSON.stringify([]),
      recorded_by: 'system:no_show',
      recorded_at: now,
      updated_at: now,
    })
    .onConflict('scheduled_service_id')
    .ignore()
    .returning('*');
  if (created) return created;
  return database('consultation_outcomes').where({ scheduled_service_id: scheduledServiceId }).first();
}

function medianOf(sortedNumbers) {
  if (!sortedNumbers.length) return null;
  const mid = Math.floor(sortedNumbers.length / 2);
  return sortedNumbers.length % 2
    ? sortedNumbers[mid]
    : Math.round((sortedNumbers[mid - 1] + sortedNumbers[mid]) / 2);
}

// ET-safe whole-day difference between two calendar dates (noon-UTC
// anchored, same convention as addETDays) — never a raw ms/86400000 divide,
// which drifts a fraction of a day on the timestamptz side.
function etDaysBetween(laterDate, earlierDateStr) {
  const laterStr = etDateString(laterDate);
  const laterAnchor = Date.parse(`${laterStr}T12:00:00Z`);
  const earlierAnchor = Date.parse(`${earlierDateStr}T12:00:00Z`);
  return Math.round((laterAnchor - earlierAnchor) / 86400000);
}

/**
 * Aggregate analytics over consultation visits SCHEDULED within [from, to]
 * (ET calendar dates, default: the last 90 days) — a cohort view, joined to
 * whatever outcome each visit eventually got (may be after `to`).
 */
async function consultationStats({ from, to, trx } = {}) {
  const database = trx || db;
  const now = new Date();
  const fromDate = from || etDateString(addETDays(now, -WON_WINDOW_DAYS));
  const toDate = to || etDateString(now);

  // Mirrors assessment-booking.js's isAssessmentServiceType/isAssessmentServiceRow
  // predicate in SQL (unavoidable for a set-based aggregate) — keep in sync.
  const visits = await database('scheduled_services as ss')
    .leftJoin('services as svc', 'ss.service_id', 'svc.id')
    .leftJoin('technicians as tech', 'ss.technician_id', 'tech.id')
    .leftJoin('consultation_outcomes as co', 'co.scheduled_service_id', 'ss.id')
    .leftJoin('leads as l', 'l.id', 'co.lead_id')
    .where(function matchConsultation() {
      this.whereRaw("lower(trim(ss.service_type)) = 'waves assessment'")
        .orWhere('svc.service_key', 'lawn_inspection')
        .orWhereRaw("lower(trim(svc.name)) = 'waves assessment'");
    })
    .where('ss.scheduled_date', '>=', fromDate)
    .where('ss.scheduled_date', '<=', toDate)
    .select(
      'ss.status',
      'ss.scheduled_date',
      'ss.technician_id',
      'tech.name as technician_name',
      'co.outcome',
      'co.lost_reason',
      'co.won_via',
      'co.won_at',
      'l.lead_source',
    );

  const stats = {
    booked: visits.length,
    showed: 0,
    won_at_door: 0,
    won_after: 0,
    warm: 0,
    cold: 0,
    lost: 0,
    no_show: 0,
    lost_by_reason: {},
    by_technician: [],
    by_source: [],
    median_days_to_close: null,
  };

  const techMap = new Map();
  const sourceMap = new Map();
  const closeDurations = [];

  for (const v of visits) {
    const showed = v.status === 'completed';
    if (showed) stats.showed += 1;
    if (v.status === 'no_show') stats.no_show += 1;
    if (v.outcome === 'warm') stats.warm += 1;
    else if (v.outcome === 'cold') stats.cold += 1;
    else if (v.outcome === 'lost') {
      stats.lost += 1;
      const reason = v.lost_reason || 'unspecified';
      stats.lost_by_reason[reason] = (stats.lost_by_reason[reason] || 0) + 1;
    } else if (v.outcome === 'won') {
      if (v.won_via === 'closeout_booking') stats.won_at_door += 1;
      else stats.won_after += 1;
      if (v.won_at) {
        // P1-1: v.scheduled_date is a DATE column — toDateOnlyString reads
        // its calendar fields directly rather than routing it through
        // etDateString (which would treat it as an instant and convert to
        // ET, shifting a UTC-midnight date back a day under Railway's
        // TZ=UTC).
        closeDurations.push(etDaysBetween(new Date(v.won_at), toDateOnlyString(v.scheduled_date)));
      }
    }

    const techKey = v.technician_id || 'unassigned';
    if (!techMap.has(techKey)) {
      techMap.set(techKey, {
        technician_id: v.technician_id || null,
        name: v.technician_name || 'Unassigned',
        showed: 0,
        won: 0,
      });
    }
    const techEntry = techMap.get(techKey);
    if (showed) techEntry.showed += 1;
    if (v.outcome === 'won') techEntry.won += 1;

    const sourceKey = v.lead_source || 'unknown';
    if (!sourceMap.has(sourceKey)) sourceMap.set(sourceKey, { lead_source: sourceKey, showed: 0, won: 0 });
    const sourceEntry = sourceMap.get(sourceKey);
    if (showed) sourceEntry.showed += 1;
    if (v.outcome === 'won') sourceEntry.won += 1;
  }

  stats.by_technician = Array.from(techMap.values());
  stats.by_source = Array.from(sourceMap.values());
  stats.median_days_to_close = medianOf(closeDurations.sort((a, b) => a - b));

  return stats;
}

module.exports = {
  OUTCOME_VALUES,
  LOST_REASON_VALUES,
  CADENCE_VALUES,
  WON_WINDOW_DAYS,
  isConsultationVisit,
  isQualifyingSaleBooking,
  recordOutcome,
  markWonForCustomer,
  reconcileOpenConsultationOutcomes,
  markNoShow,
  consultationStats,
};
