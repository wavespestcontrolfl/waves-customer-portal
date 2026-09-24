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
 * WHAT COUNTS AS A WIN (round 11): a NEW recurring or one-time purchase
 * attributable to the consultation — see isQualifyingSaleBooking below for
 * the full positive rule a candidate scheduled_services row must pass.
 *
 * RECONCILIATION MODEL (round 10): direct hooks (markWonForCustomer called
 * from admin-leads.js and admin-schedule.js right after a qualifying
 * booking commits) are the FAST PATH at the two main manual-booking routes,
 * catching most real sales the moment they happen; the hourly sweep,
 * reconcileOpenConsultationOutcomes, is the COMPLETENESS GUARANTEE that
 * catches every other insert path (existing or future) within its next
 * tick, so this service never again needs a new direct hook wired in to
 * stay correct. FAIRNESS (round 12): the sweep orders by
 * (last_reconciled_at NULLS FIRST, recorded_at ASC), not recorded_at alone
 * — see the FAIRNESS paragraph above reconcileOpenConsultationOutcomes.
 *
 * WON_VIA PROVENANCE: every automatic win reads office_booking or
 * estimate_accept. No column on scheduled_services distinguishes who booked
 * a row from who it is assigned to, so there is no door-side auto-detection.
 * 'closeout_booking' stays in the DB CHECK enum for the tech-closeout PR
 * (PR1b), which passes it explicitly because that caller already knows the
 * booking was made at the door.
 */

const db = require('../models/db');
const logger = require('./logger');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');
const { isAssessmentBooking } = require('./assessment-booking');
const { isAlwaysFreeServiceType } = require('./no-cost-visit-types');
const { OFFICE_REVIEW_PENDING_SOURCE_ACTIONS } = require('./call-booking-source-actions');

const OUTCOME_VALUES = ['warm', 'cold', 'lost'];
const LOST_REASON_VALUES = ['price', 'competitor', 'diy', 'not_ready', 'no_show', 'other'];
const CADENCE_VALUES = ['month', 'quarter', 'visit', 'year'];
const WON_WINDOW_DAYS = 90;

// Consultation visits that never happened: a sale is never attributed to
// one (local audit P1). One list shared by every win path — the evidence
// win, markWonForCustomer and the sweep's selection — so they cannot drift.
// `rescheduled` is a pending-rebook placeholder on the CONSULTATION side
// (appointment-public.js reports it as pending_rebook — Codex #4710 r6 P2),
// never a visit that happened; as a SALE booking it still qualifies
// (QUALIFYING_BOOKING_STATUSES), which is a separate list.
const DEAD_CONSULTATION_STATUSES = ['no_show', 'cancelled', 'skipped', 'rescheduled'];

// Outcomes a later sale converts to won (Codex #4710 r4 P2): warm and cold,
// and `lost` too — a customer who declined at the door and bought within
// the 90-day window is a win. Never a no-show loss (the visit never
// happened). The prior outcome is kept in pre_win_outcome so a win whose
// sale dies returns to it.
const CONVERTIBLE_OUTCOMES = ['warm', 'cold', 'lost'];

// Adds the "this prior outcome can convert" guard for one prior value to a
// consultation_outcomes query (column names unprefixed).
function whereConvertible(q, prior) {
  q.where('outcome', prior);
  if (prior === 'lost') {
    q.where(function notNoShowLoss() {
      this.whereNull('lost_reason').orWhereNot('lost_reason', 'no_show');
    });
  }
  return q;
}
// P1 :924 (round 12): the sweep's OWN row-SELECTION cutoff only — never
// the EVIDENCE bound findSaleEvidenceForConsultation applies (that stays
// exactly WON_WINDOW_DAYS from the visit's scheduled_date; see its own
// comment). "Which rows does this hourly tick look at" and "does this
// evidence timestamp fall inside the 90-day window" are two separate
// questions — reconcileOpenConsultationOutcomes' own comment explains why
// conflating them dropped a row the moment its window closed. `ss.
// scheduled_date` is a DATE column (no time-of-day), so "within the last
// N hours" is applied at day granularity — ceil(48/24) = 2 extra days on
// the sweep's own selection cutoff.
const SWEEP_GRACE_HOURS = 48;
const SWEEP_GRACE_DAYS = Math.ceil(SWEEP_GRACE_HOURS / 24);

function makeError(message, statusCode, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.status = statusCode;
  err.isOperational = true;
  err.code = code;
  return err;
}

// Round 12 fix (codex P1, post-push): quotedAmount is written straight into
// consultation_outcomes.quoted_amount, a decimal(10,2) column (migration
// 20260923000010_consultation_outcomes.js — 8 digits before the point, 2
// after: [0, 99999999.99]). The pre-fix guard
// (`quotedAmount != null && !Number.isFinite(Number(quotedAmount))`)
// accepted anything Number() coerces to a finite value — '' (Number('')
// === 0) and whitespace-only strings, booleans (Number(true) === 1),
// negative numbers, and values far past the column's range (1e9) — and
// then wrote the RAW value straight through, so a value outside the
// column's precision threw a raw, unmapped Postgres 22P02/numeric-overflow
// 500 on a technician's save instead of a clean 400.
//
// Returns null for an absent or blank amount (same as omitted — a
// technician clearing the field or leaving it untouched must not become a
// validation error), or the amount rounded to the nearest cent. Throws 400
// VALIDATION for anything else: a boolean, an object/array, a non-numeric
// string, a negative amount, or a value outside decimal(10,2)'s range.
function normalizeQuotedAmount(rawValue) {
  if (rawValue === null || rawValue === undefined) return null;
  let candidate = rawValue;
  if (typeof candidate === 'string') {
    candidate = candidate.trim();
    if (candidate === '') return null; // blank input — treated as omitted
  } else if (typeof candidate !== 'number') {
    // Booleans, arrays, objects — never a number or a numeric string.
    throw makeError('quotedAmount must be a number', 400, 'VALIDATION');
  }
  const num = Number(candidate);
  if (!Number.isFinite(num)) {
    throw makeError('quotedAmount must be a number', 400, 'VALIDATION');
  }
  // Compared in whole CENTS (integer math), not the raw float, so a value
  // sitting exactly at the boundary can't land on the wrong side of the
  // check from float rounding.
  const cents = Math.round(num * 100);
  if (cents < 0 || cents > 9999999999) {
    throw makeError('quotedAmount must be between 0 and 99,999,999.99', 400, 'VALIDATION');
  }
  return cents / 100;
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

// The lead this visit's outcome belongs to. Mirrors admin-leads.js
// schedule-appointment: an assessment booking claims the lead by stamping
// leads.customer_id, so the newest non-deleted lead on that customer is the
// link — best-effort, never blocks the outcome write.
// The lead a consultation belongs to (Codex #4710 P2): the lead whose own
// appointment_scheduled activity names this visit, else the customer's
// newest lead created on/before the visit was booked, else the newest lead —
// never simply the customer's most recent inquiry, which could be a later,
// unrelated one (and would skew the per-source breakdown).
async function deriveLinkage(svcRow, database) {
  const customerId = svcRow.customer_id || null;
  const technicianId = svcRow.technician_id || null;
  let leadId = null;
  if (customerId) {
    try {
      // Codex #4710 r10 P2 :305: isolated in its own SAVEPOINT (a nested
      // transaction — `database` here is often already a caller
      // transaction/savepoint, e.g. markNoShow's job-status or repair-sweep
      // transaction). Postgres aborts the WHOLE enclosing transaction on any
      // statement error regardless of whether the client catches it in JS —
      // so catching the error right here, as before, did NOT actually
      // restore `database` to a usable state: the consultation_outcomes
      // insert that runs immediately after deriveLinkage returns would then
      // fail with "current transaction is aborted", instead of performing
      // the documented best-effort write with leadId: null. Same discipline
      // as every other best-effort read in this file (waves-db §5b).
      leadId = await database.transaction(async (sp) => {
        const booked = await sp('lead_activities as la')
          .join('leads as l', 'l.id', 'la.lead_id')
          .where('l.customer_id', customerId)
          .whereNull('l.deleted_at')
          .where('la.activity_type', 'appointment_scheduled')
          .whereRaw("la.metadata->>'appointmentId' = ?", [String(svcRow.id)])
          .orderBy('la.created_at', 'desc')
          .first('la.lead_id');
        if (booked?.lead_id) return booked.lead_id;
        const base = () => sp('leads').where({ customer_id: customerId }).whereNull('deleted_at');
        const beforeBooking = svcRow.created_at
          ? await base().where('created_at', '<=', svcRow.created_at).orderBy('created_at', 'desc').first('id')
          : null;
        const leadRow = beforeBooking || await base().orderBy('created_at', 'desc').first('id');
        return leadRow ? leadRow.id : null;
      });
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
  // Codex #4710 r10 P2 :335: only a STRING can match either documented
  // shape below — a boolean or an epoch-ms number is neither, but both
  // parse to a finite Date through parseETDateTime's final `new Date(...)`
  // fallback, so without this gate they reached the "neither regex
  // matched" branch and were WAVED THROUGH by its old `return true`
  // (unsupported-shape bug below). Reject up front instead of relying on
  // that branch to catch every non-string too.
  if (typeof followUpAt !== 'string') return false;
  const parsed = parseETDateTime(followUpAt);
  if (!(parsed instanceof Date) || Number.isNaN(parsed.getTime())) return false;
  // A naive wall-clock value must round-trip (Codex #4710 P2): parsing
  // normalizes overflow ("2026-02-31T09:00" → March 3, "T99:99" → days
  // later) and a nonexistent DST wall time shifts an hour, so the ET
  // date/hour/minute the Date lands on must equal what was typed.
  const naive = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/.exec(String(followUpAt).trim());
  if (!naive) {
    // An explicit offset/Z value must round-trip too (Codex #4710 r6 P2):
    // shift the instant by its own offset and compare the wall-clock parts
    // that were typed. Non-ISO inputs (a Date, epoch ms) pass as before.
    const withOffset = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i
      .exec(String(followUpAt).trim());
    // Codex #4710 r10 P2 :335: a parseable-but-unsupported shape (e.g.
    // "09/25/2026 09:00") must be REJECTED, not waved through to
    // parseETDateTime's host-UTC `new Date(...)` fallback — that fallback
    // exists for internal callers (an already-absolute Date, an epoch
    // number), not for this route's validated string input, whose contract
    // documents exactly the two regex shapes above. A naive non-ISO string
    // silently read as UTC is P1-B's exact bug, reopened here.
    if (!withOffset) return false;
    const tz = withOffset[4].toUpperCase();
    const offsetMinutes = tz === 'Z' ? 0
      : (tz[0] === '-' ? -1 : 1) * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(-2)));
    const wall = new Date(parsed.getTime() + offsetMinutes * 60000).toISOString();
    return wall.slice(0, 10) === withOffset[1] && wall.slice(11, 13) === withOffset[2] && wall.slice(14, 16) === withOffset[3];
  }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
  }).formatToParts(parsed).map((p) => [p.type, p.value]));
  return etDateString(parsed) === naive[1] && parts.hour === naive[2] && parts.minute === naive[3];
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

// Round 8-11: successive rounds patched findSaleEvidenceForConsultation's
// non-assessment-booking evidence check with one more excluded class at a
// time (P1-B is_callback, then recurring_parent_id, then followup_included +
// isAlwaysFreeServiceType; round 9 added the office-review check; round 11
// folded in an explicit $0 price and prepay-term-renewal linkage). Round 8
// was the restructure — ONE positive predicate, THE decision point both
// call sites use, instead of scattered negative checks that need
// re-deriving (and re-missing a case) every time a new non-sale booking
// shape turns up; rounds 9-11 are new terms added to that ONE predicate,
// not new scattered checks.
//
// THE RULE: a scheduled_services row counts as evidence of a real,
// confirmed sale — a NEW recurring/one-time purchase attributable to the
// consultation — only if its status is one still on the books in some
// active-or-done form (not cancelled/skipped/no_show — a visit that never
// happened proves nothing was bought); it is not an AI-created booking
// still awaiting office review (OFFICE_REVIEW_PENDING_SOURCE_ACTIONS +
// customer_confirmed — voice-agent/outbound-callback bookings; office
// confirm is what makes one real, exactly as job-status.js's own
// OFFICE_REVIEW_PENDING_SOURCE_ACTIONS + customer_confirmed check keys the
// SAME "still needs activation" decision on); and it is not one of the six
// already-established non-sale classes: a free re-service callback
// (is_callback), a recurring-series child spawned onto an EXISTING plan
// (recurring_parent_id), an included $0 follow-up minted from a completion
// (followup_included), any other service type this codebase already
// treats as ALWAYS no-cost by name (isAlwaysFreeServiceType), an EXPLICIT
// $0 price (estimated_price === 0 — a genuine complimentary/comp visit,
// e.g. health-alerts.js's retention "free_service" action; NULL/undefined
// stays qualifying since plenty of real bookings carry no price at
// insert), or a row seeded for an annual-prepay TERM's coverage
// (annual_prepay_term_id set — annual-prepay-renewals.js's buildInsert
// stamps this on EVERY visit it seeds for a term, first-ever or later
// renewal alike; the sale event for annual prepay is the term's own
// payment, evidenced separately via an accepted estimate — evidence type
// (b) above — never via this scheduled_services insert, so excluding it
// here loses no true evidence).
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
// booking, which never sets it at all. estimated_price is read the same
// disciplined way: `=== 0` is a NUMBER (or a numeric-string — Postgres
// returns `decimal` columns as strings, so a raw `estimated_price:
// '0.00'` row must resolve the same as the JS number `0`), never a bare
// falsy check, so NULL/undefined (no price stamped, the common case) is
// never mistaken for a genuine zero.
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
  if (row.estimated_price != null && Number(row.estimated_price) === 0) return false;
  if (row.annual_prepay_term_id) return false;
  // Existing-membership coverage (local audit P1): admin-schedule books a
  // monthly member's series with no base price stamp and invoicing off
  // (memberSeriesCovered) — the dues are the sale, made earlier. A
  // recurring row that bills nothing is that coverage, not a new sale; a
  // priced add-on on a covered visit keeps its positive stamp and still
  // counts.
  if (row.is_recurring && !(Number(row.estimated_price) > 0) && row.create_invoice_on_complete === false) return false;
  if (isAlwaysFreeServiceType(row.service_type)) return false;
  return true;
}

// Round 12, P2 consultation-outcomes.js:411 (codex, post-push): the
// same-day/same-technician closeout auto-detection layer (isCloseoutEvidence
// + the creatorTechnicianId params it needed) is REMOVED — no column on
// scheduled_services has ever distinguished who booked a row from who it's
// assigned to (grepped the whole schema; see the file header), so it could
// only ever resolve false. consultationStats now reports a single `won`
// count plus a won_by_via breakdown instead of a permanently-zero at-door
// metric. 'closeout_booking' stays in the DB CHECK enum
// (20260923000010_consultation_outcomes.js) — it's simply reachable only
// by a caller passing it explicitly: a future tech-closeout PR (PR1b) that
// DOES know a booking was closed at the door calls markWonForCustomer/
// recordOutcome with `via`/`won_via: 'closeout_booking'` directly, no
// auto-detection needed since that caller already has the context.

// Effective attribution timestamp for a scheduled_services booking (P2
// consultation-outcomes.js:537, codex): an office-review booking
// (OFFICE_REVIEW_PENDING_SOURCE_ACTIONS — voice_agent /
// ai_call_outbound_review) exists as a PENDING row from the moment the
// agent takes the call, but isQualifyingSaleBooking only lets it through
// once customer_confirmed is true — the office's confirmation is the
// moment it became a REAL booking, not its created_at, which can predate
// the visit (and the window) entirely: a row created before the
// consultation but confirmed after it must still count, dated at the
// confirmation. A legacy row with no confirmed_at value (or any other
// source_action) falls back to created_at exactly as before.
function effectiveBookingTimestamp(booking) {
  if (OFFICE_REVIEW_PENDING_SOURCE_ACTIONS.includes(booking.source_action) && booking.confirmed_at) {
    return booking.confirmed_at;
  }
  return booking.created_at;
}

/**
 * Reconciliation from the CONSULTATION side (P1-1): a sale can commit
 * BEFORE the technician gets around to recording the visit's outcome, in
 * which case markWonForCustomer already ran and found nothing to win — a
 * warm/cold row recorded afterward would otherwise sit open forever.
 *
 * Round 12, P2 consultation-outcomes.js:520 (codex, post-push): collects the
 * EARLIEST qualifying candidate from EACH of the two sources below (not
 * "the first source with any match") and returns the overall-earliest one,
 * deriving won_via from whichever source it came from. leads.converted_at is
 * deliberately not a source — it is stamped for free bookings too. Every
 * candidate is still bounded to [visit's scheduled_date (ET), min(now,
 * scheduled_date + 90 days)] (P1-2 — never a future date, never past the
 * visit's own window):
 *   (a) an accepted estimate for this customer (estimates.status='accepted',
 *       accepted_at),
 *   (b) a non-assessment scheduled_services row for this customer that is a
 *       genuine NEW booking — another consultation, a free callback
 *       (is_callback), a recurring-series child spawned onto an EXISTING
 *       plan (recurring_parent_id), an included $0 follow-up minted from a
 *       completion (followup_included), or any other ALWAYS-free service
 *       type (isAlwaysFreeServiceType — appointment/estimate/re-service/
 *       follow-up/re-visit by name) is never itself a sale. Dated at
 *       effectiveBookingTimestamp(booking) — confirmed_at for an
 *       office-review booking, created_at otherwise (P2 :537 above).
 * Returns { won_via, won_at } for the earliest match across both sources,
 * or null.
 */
async function findSaleEvidenceForConsultation(database, {
  customerId, scheduledDateStr, windowStart = null, now = new Date(),
}) {
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
  // The window opens at the consultation's own arrival time (Codex #4710 r9
  // P2), not ET midnight — an estimate accepted or a visit booked that
  // morning, before an afternoon consultation, preceded it and is not its
  // sale. No window on file → the start of the day, as before.
  const startClock = windowStart ? `${String(windowStart).slice(0, 5)}:00` : '00:00:00';
  const lowerBound = parseETDateTime(`${scheduledDateStr}T${startClock}`);
  const upperBound = new Date(parseETDateTime(`${upperBoundStr}T23:59:59`).getTime() + 999);

  // Round 12, P2 :520: gather one candidate per source (never return on
  // the first match) and pick the overall-earliest at the end.
  const candidates = [];

  // leads.converted_at is NOT evidence (local audit P1): admin-leads.js
  // stamps it for any non-assessment booking, including an always-free
  // Estimate Visit. A real conversion always leaves a qualifying booking or
  // an accepted estimate, which the two sources below read directly.

  const acceptedEstimate = await database('estimates')
    .where({ customer_id: customerId, status: 'accepted' })
    .whereNotNull('accepted_at')
    .where('accepted_at', '>=', lowerBound)
    .where('accepted_at', '<=', upperBound)
    .orderBy('accepted_at', 'asc')
    .first('accepted_at');
  if (acceptedEstimate) {
    candidates.push({ won_via: 'estimate_accept', won_at: new Date(acceptedEstimate.accepted_at) });
  }

  // Round 12, P2 :537: bounded by EITHER created_at or confirmed_at falling
  // in the window (a superset of what actually qualifies) — an
  // office-review row's created_at can sit outside the window entirely
  // while its confirmed_at is the only in-window timestamp, so the query
  // must not exclude it before effectiveBookingTimestamp gets a chance to
  // read the right column. Each candidate row is re-checked against the
  // bounds below using its OWN effective timestamp before being accepted.
  const bookings = await database('scheduled_services')
    .where({ customer_id: customerId })
    .where(function boundedByEitherTimestamp() {
      this.where(function createdInWindow() {
        this.where('created_at', '>=', lowerBound).where('created_at', '<=', upperBound);
      }).orWhere(function confirmedInWindow() {
        this.whereNotNull('confirmed_at').where('confirmed_at', '>=', lowerBound).where('confirmed_at', '<=', upperBound);
      });
    })
    .orderBy('created_at', 'asc')
    .select(
      'id', 'service_type', 'service_id', 'created_at', 'confirmed_at',
      // Every field isQualifyingSaleBooking's single positive rule needs —
      // see the comment above that function for what each one decides.
      'status', 'source_action', 'customer_confirmed',
      'is_callback', 'recurring_parent_id', 'followup_included',
      'estimated_price', 'annual_prepay_term_id',
      'is_recurring', 'create_invoice_on_complete',
    );
  let earliestBookingAt = null;
  let earliestBookingId = null;
  for (const booking of bookings) {
    // Codex #4710 r10 P2 :600: the cheap SYNC predicate runs FIRST — a
    // recurring series creates every child in one batch, so the hourly sweep
    // could otherwise issue a `services` catalog query (isAssessmentBooking,
    // async) per row for hundreds of rows guaranteed to fail
    // isQualifyingSaleBooking anyway (cancelled, a callback, a recurring
    // child, an included follow-up, …). Only a row that survives the sync
    // rule pays for the catalog lookup.
    if (!isQualifyingSaleBooking(booking)) continue;
    if (await isAssessmentBooking(booking, database)) continue; // another consultation is not a sale — separate, async, checked only for surviving candidates
    const effectiveAt = new Date(effectiveBookingTimestamp(booking));
    if (effectiveAt < lowerBound || effectiveAt > upperBound) continue; // the OR above is a superset of the true bound — re-check the row's own effective timestamp
    if (!earliestBookingAt || effectiveAt < earliestBookingAt) {
      earliestBookingAt = effectiveAt;
      earliestBookingId = booking.id;
    }
  }
  if (earliestBookingAt) {
    candidates.push({ won_via: 'office_booking', won_at: earliestBookingAt, booking_id: earliestBookingId });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => a.won_at.getTime() - b.won_at.getTime());
  return candidates[0];
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
  outcomeRowId, customerId, scheduledDateStr, windowStart = null, now,
}) {
  let won = null;
  await database.transaction(async (sp) => {
    const evidence = await findSaleEvidenceForConsultation(sp, { customerId, scheduledDateStr, windowStart, now });
    if (!evidence) return;
    // One guarded UPDATE per prior outcome so pre_win_outcome is a plain
    // literal (no raw column reference) — at most one of the two can match.
    let wonRow = null;
    for (const prior of CONVERTIBLE_OUTCOMES) {
       
      const [row] = await whereConvertible(sp('consultation_outcomes').where({ id: outcomeRowId }), prior)
        // A consultation that never happened is never won, even when
        // re-recorded warm/cold afterwards (local audit P1) — same exclusion
        // as markWonForCustomer and the sweep.
        .whereIn('scheduled_service_id', function notDeadVisit() {
          this.select('id').from('scheduled_services').whereNotIn('status', DEAD_CONSULTATION_STATUSES);
        })
        .update({
          outcome: 'won',
          won_at: evidence.won_at,
          won_via: evidence.won_via,
          // Remember the win's booking and prior outcome so the sweep can
          // reopen it if that booking dies (Codex #4710 r3 P1).
          won_evidence_booking_id: evidence.booking_id || null,
          pre_win_outcome: prior,
          updated_at: new Date(),
        })
        .returning('*');
      if (row) { wonRow = row; break; }
    }
    won = wonRow || null;
  });
  return won;
}

// Codex #4710 r10 P1 :692: reconciliation's customer-row lock had no bounded
// wait — Postgres' default lock_timeout is unlimited and this transaction
// set none, so a customer row wedged by any long-running, unrelated
// transaction could block it indefinitely. That matters here specifically
// (not everywhere lockCustomerRow is used) because scheduler.js:728-737
// runs the WHOLE hourly sweep under runExclusive, and cron-lock.js's
// runExclusive skips a later tick entirely while the previous holder is
// still active — so one wedged row doesn't just stall its own
// reconciliation, it can wedge the ENTIRE completeness sweep (every other
// open outcome, indefinitely) since no later tick ever gets to run. Bound
// the wait so a stuck lock surfaces as a normal, per-row 55P03/57014 error —
// which reconcileOpenConsultationOutcomes' existing per-row try/catch
// already logs and counts, exactly like any other row failure — instead of
// hanging the tick. Same SET LOCAL lock_timeout convention as
// scheduling/catalog-lock.js's withLockWait and inbound-sms-read.js's bell
// retarget. Scoped to this reconciliation path only: recordOutcome's own
// customer lock is a per-request technician write, not part of the
// serialized completeness guarantee, so it is unaffected.
const RECONCILE_LOCK_WAIT_MS = 5000;
// The transaction-local lock wait bound every sweep pass sets before its
// first lock (Codex #4710 r10 P1 + pre-push P1): one blocked row fails
// that row, never the whole runExclusive sweep.
async function boundLockWait(trx) {
  await trx.raw(`SET LOCAL lock_timeout = '${RECONCILE_LOCK_WAIT_MS}ms'`);
}

// The sweep's per-row unit of work: lock the customer row FIRST (P1-A
// discipline — see lockCustomerRow), then attempt the evidence-based win
// for this one already-existing open outcome row, both inside ONE
// transaction. Unlike recordOutcome (which has an insert to run under the
// same lock), the sweep has nothing else to do under it, so lock-then-
// attempt collapses into this one small wrapper.
//
// Round 12 (fairness): stamps last_reconciled_at on the row REGARDLESS of
// whether it won — same fix as reschedule-link-promises.js's
// SCAN_FAIRNESS_ORDER (codex #4293): a sweep that only advances rows it
// CHANGES lets a backlog of exactly-still-open rows sort to the front of
// the LIMIT-bounded query forever, starving every row behind them once the
// backlog exceeds `limit`. Stamping "was examined this tick" separately
// from "changed this tick" is what reconcileOpenConsultationOutcomes'
// (last_reconciled_at NULLS FIRST, recorded_at ASC) ordering relies on. No
// outcome guard on this UPDATE (unlike attemptEvidenceBasedWin's win
// UPDATE) — it only ever touches this ONE column, so stamping a row a
// concurrent process already won in between is harmless and never
// re-selected by the sweep's own WHERE outcome IN (warm,cold) again either
// way.
async function reconcileOneOpenOutcome(database, {
  outcomeRowId, customerId, scheduledDateStr, windowStart = null, now,
}) {
  return database.transaction(async (locked) => {
    // The bound is transaction-local (SET LOCAL — no restore needed, this
    // transaction does nothing else afterward) and set before the lock it
    // is meant to bound; a no-op when there is no customer to lock.
    if (customerId) await boundLockWait(locked);
    await lockCustomerRow(locked, customerId);
    const won = await attemptEvidenceBasedWin(locked, {
      outcomeRowId, customerId, scheduledDateStr, windowStart, now,
    });
    await locked('consultation_outcomes').where({ id: outcomeRowId }).update({ last_reconciled_at: now });
    return won;
  });
}

/**
 * Record (or re-record) the technician's read of a consultation visit.
 * Never accepts outcome 'won' — that is stamped only by markWonForCustomer
 * when a real booking/accept closes.
 */
// The ET instant a visit's arrival window opens, or null when it has no
// usable date/window.
function visitWindowOpensMs(visit) {
  if (!visit.scheduled_date || !visit.window_start) return null;
  const opens = parseETDateTime(`${toDateOnlyString(visit.scheduled_date)}T${String(visit.window_start).slice(0, 5)}`);
  return Number.isNaN(opens?.getTime?.()) ? null : opens.getTime();
}

// Guards on the visit, re-read under the customer lock; first match refuses.
const HELD_VISIT_GUARDS = [
  {
    fails: (v, c) => v.customer_id !== undefined && String(v.customer_id || '') !== String(c.customerId || ''),
    status: 409, code: 'CUSTOMER_CHANGED', message: 'The consultation customer changed — retry',
  },
  {
    fails: (v) => DEAD_CONSULTATION_STATUSES.includes(v.status),
    status: 409, code: 'CONSULTATION_NOT_HELD', message: 'That consultation was marked no-show, cancelled or skipped — its outcome cannot be recorded',
  },
  {
    fails: (v) => Boolean(v.scheduled_date) && toDateOnlyString(v.scheduled_date) > etDateString(new Date()),
    status: 409, code: 'CONSULTATION_IN_FUTURE', message: 'That consultation has not happened yet — record its outcome on or after the visit day',
  },
  {
    fails: (v, c) => (visitWindowOpensMs(v) ?? -Infinity) > c.nowMs,
    status: 409, code: 'CONSULTATION_IN_FUTURE', message: 'That consultation has not started yet — record its outcome once the visit window opens',
  },
  {
    fails: (v, c) => Boolean(c.actingTechnicianId) && !c.actingIsAdmin && String(v.technician_id || '') !== String(c.actingTechnicianId),
    status: 403, code: 'NOT_ASSIGNED', message: 'Not assigned to this consultation',
  },
];

// An open outcome a later sale may convert: warm, cold, or lost for any
// reason but a no-show.
function isConvertibleOutcome(row) {
  return CONVERTIBLE_OUTCOMES.includes(row.outcome) && !(row.outcome === 'lost' && row.lost_reason === 'no_show');
}

// Empty strings as SQL NULL for optional text columns.
function blankToNull(fields) {
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v === '' || v == null ? null : v]));
}

// Input validation for recordOutcome, first failing rule wins (Codex #4710
// r9 P2 — one table instead of a chain of branches).
const OUTCOME_INPUT_RULES = [
  { fails: (p) => !p.scheduledServiceId, message: 'scheduledServiceId is required' },
  {
    fails: (p) => p.outcome === 'won',
    message: "outcome 'won' cannot be recorded directly — it is stamped only when a real booking or accept closes",
  },
  { fails: (p) => !OUTCOME_VALUES.includes(p.outcome), message: `outcome must be one of ${OUTCOME_VALUES.join(', ')}` },
  { fails: (p) => p.outcome === 'lost' && !p.lostReason, message: 'lostReason is required when outcome is lost' },
  { fails: (p) => p.lostReason && !LOST_REASON_VALUES.includes(p.lostReason), message: `lostReason must be one of ${LOST_REASON_VALUES.join(', ')}` },
  { fails: (p) => p.quotedCadence && !CADENCE_VALUES.includes(p.quotedCadence), message: `quotedCadence must be one of ${CADENCE_VALUES.join(', ')}` },
  { fails: (p) => p.interests != null && !Array.isArray(p.interests), message: 'interests must be an array' },
  {
    fails: (p) => !isValidFollowUpAt(p.followUpAt),
    message: 'followUpAt must be a valid date/time — a naive local time like "2026-09-25T09:00" is read as ET, or pass an ISO string with an explicit offset/Z',
  },
];

async function recordOutcome(params = {}, opts = {}) {
  try {
    return await recordOutcomeOnce(params, opts);
  } catch (err) {
    if (err?.code !== 'CUSTOMER_CHANGED') throw err;
    return recordOutcomeOnce(params, opts);
  }
}

async function recordOutcomeOnce(params = {}, { trx } = {}) {
  const database = trx || db;
  const {
    scheduledServiceId, outcome, lostReason = null, interests = [],
    quotedAmount = null, quotedCadence = null, quoteNotes = null,
    followUpAt = null, recordedBy = null,
    // The acting technician (route-supplied) — the ownership check re-runs
    // under the lock, atomic with the write (Codex #4710 P2). Admins skip it.
    actingTechnicianId = null, actingIsAdmin = false,
  } = params;

  // One rule table (Codex #4710 r9 P2): the first failing rule is the 400.
  const invalid = OUTCOME_INPUT_RULES.find((rule) => rule.fails(params));
  if (invalid) throw makeError(invalid.message, 400, 'VALIDATION');
  const normalizedQuotedAmount = normalizeQuotedAmount(quotedAmount);

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
    quoted_amount: normalizedQuotedAmount,
    ...blankToNull({ quoted_cadence: quotedCadence, quote_notes: quoteNotes, recorded_by: recordedBy }),
    follow_up_at: defaultFollowUpAt(outcome, followUpAt),
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

    // The visit re-read under the lock, so both guards are atomic with the
    // write below (Codex #4710 P2 x2): a consultation that never happened
    // (no-show / cancelled / skipped) cannot be re-opened by a late or
    // concurrent closeout, and a technician reassigned off the visit
    // between the route's check and this write cannot overwrite it.
    const liveVisit = await locked('scheduled_services')
      .where({ id: scheduledServiceId })
      .forNoKeyUpdate()
      .first('status', 'technician_id', 'customer_id', 'scheduled_date', 'window_start');
    // A customer merge that repointed the visit between the first read and
    // this lock would otherwise write the retired customer_id (Codex #4710
    // r6 P2) — retried once from the top against the surviving customer.
    // The held-visit guards, as one table (Codex #4710 r6/r7/r8 + P2s;
    // r9 P2 table-driven): a customer merge mid-write retries, a visit that
    // never happened or has not started is refused, and a technician no
    // longer assigned cannot write.
    const guardCtx = { customerId, actingTechnicianId, actingIsAdmin, nowMs: Date.now() };
    const refused = HELD_VISIT_GUARDS.find((guard) => guard.fails(liveVisit || {}, guardCtx));
    if (refused) throw makeError(refused.message, refused.status, refused.code);

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
    if (isConvertibleOutcome(saved)) {
      try {
        // Codex #4710 r10 P2 :890: liveVisit — re-read and locked above,
        // right before the HELD_VISIT_GUARDS checks — is the schedule this
        // write actually validated; svcRow is the PRE-lock read and can be
        // stale (a dispatch move between the two reads changes
        // scheduled_date/window_start but not svcRow's copy of them). Using
        // svcRow here re-opened exactly the race the lock exists to close:
        // the guards above would validate the NEW schedule while the sale
        // search below still searched around the OLD one, so a purchase
        // that actually preceded the real consultation could be recorded as
        // its win (or genuine evidence inside the new window could be
        // missed).
        const won = await attemptEvidenceBasedWin(locked, {
          outcomeRowId: saved.id,
          customerId,
          scheduledDateStr: toDateOnlyString(liveVisit.scheduled_date),
          windowStart: liveVisit.window_start,
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
 *
 * won_via / won_at / won_evidence_booking_id always come from the row's own
 * evidence (findSaleEvidenceForConsultation); a row with no qualifying
 * evidence stays open (Codex #4710 r10 pre-push P1). `via` names the caller
 * for the log; `evidenceBookingId` is accepted for caller compatibility.
 */
async function markWonForCustomer(customerId, { via, trx, now = new Date(), evidenceBookingId = null } = {}) {
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

      // Per open outcome, the EARLIEST qualifying evidence wins (Codex
      // #4710 r4 P2) — the same findSaleEvidenceForConsultation search the
      // sweep and recordOutcome use, so provenance and median_days_to_close
      // never depend on which hook ran first. The booking/acceptance this
      // caller just wrote is visible on this transaction and is one of the
      // candidates; when the search finds nothing for a row, that row is
      // left open. Each write is a guarded
      // UPDATE on the row's still-current outcome, under the customer lock,
      // so a row resolved meanwhile is never overwritten.
      const candidates = await sp('consultation_outcomes as co')
        .join('scheduled_services as ss', 'ss.id', 'co.scheduled_service_id')
        .whereIn('co.outcome', CONVERTIBLE_OUTCOMES)
        // The outcome's OWN customer snapshot decides (Codex #4710 r7 P2);
        // lead linkage is only a fallback for outcomes with no customer —
        // a call relinked to another customer moves its lead, not the
        // consultation, and must not credit it with the new customer's sale.
        .where(function matchCustomerOrItsLeads() {
          this.where('co.customer_id', customerId);
          if (leadIds.length) {
            this.orWhere(function unlinkedOutcomeViaLead() {
              this.whereNull('co.customer_id').whereIn('co.lead_id', leadIds);
            });
          }
        })
        .where('ss.scheduled_date', '>=', cutoff)
        .where('ss.scheduled_date', '<=', nowDateStr)
        // A consultation that never happened (no-show, cancelled, skipped)
        // is never won — even if its best-effort no-show write failed and
        // the row is still open.
        .whereNotIn('ss.status', DEAD_CONSULTATION_STATUSES)
        .select('co.id as outcome_id', 'co.outcome', 'co.lost_reason', 'ss.scheduled_date', 'ss.window_start');

      for (const row of candidates) {
        if (!isConvertibleOutcome(row)) continue;
         
        const evidence = await findSaleEvidenceForConsultation(sp, {
          customerId, scheduledDateStr: toDateOnlyString(row.scheduled_date), windowStart: row.window_start || null, now,
        });
        // No qualifying evidence (e.g. the sale predates this consultation's
        // window on the same day) → not won; the caller's own write is never
        // a fallback (Codex #4710 r10 pre-push P1).
        if (!evidence) continue;
         
        const updated = await whereConvertible(sp('consultation_outcomes').where({ id: row.outcome_id }), row.outcome)
          .update({
            outcome: 'won',
            won_at: evidence.won_at,
            won_via: evidence.won_via,
            won_evidence_booking_id: evidence.booking_id || null,
            pre_win_outcome: row.outcome,
            updated_at: now,
          })
          .returning('id');
        winCount += updated.length;
      }
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
 * hours-long one.
 *
 * FAIRNESS (round 12): ordering by recorded_at ASC alone re-selected the
 * SAME oldest `limit` rows every tick whenever they stayed open (nothing
 * about a still-warm row advances recorded_at) — a backlog of exactly
 * `limit` unresolved rows starves every row behind them forever, the same
 * bug class reschedule-link-promises.js's SCAN_FAIRNESS_ORDER fixed (codex
 * #4293). reconcileOneOpenOutcome stamps last_reconciled_at on every row
 * it examines regardless of outcome; ordering by (last_reconciled_at NULLS
 * FIRST, recorded_at ASC) means a row this tick just checked — whether or
 * not anything about it changed — moves to the back of the line, so the
 * NEXT tick reaches whatever this one's `limit` cutoff left behind.
 *
 * GRACE PERIOD (round 12, P1 :924): the SELECTION cutoff (which rows this
 * tick even looks at) is WON_WINDOW_DAYS + SWEEP_GRACE_DAYS ago, not bare
 * WON_WINDOW_DAYS — a plain cutoff drops a row the INSTANT its window
 * closes, so a sale recorded late on the visit's own last in-window day
 * (e.g. 23:40 ET on day 90) can miss that day's last hourly tick and then
 * never be examined again: the NEXT tick's `now` has already rolled past
 * midnight, and (now - 90 days) has advanced beyond the visit's
 * scheduled_date. The EVIDENCE bound findSaleEvidenceForConsultation
 * applies is untouched (still exactly WON_WINDOW_DAYS from scheduled_date)
 * — evidence dated AFTER the visit's own window still never counts; the
 * grace period only keeps the ROW in the sweep's candidate set for a few
 * more hourly chances to find evidence that was already inside it.
 *
 * Returns { scanned, won, errors } — never throws.
 */
async function reconcileOpenConsultationOutcomes({ now = new Date(), limit = 200 } = {}) {
  const result = { scanned: 0, won: 0, errors: 0 };
  // No-show repair runs FIRST (local audit P1): a no-showed consultation
  // whose best-effort lost/no_show write failed must close as lost before
  // the win pass could see it as an open row with sale evidence.
  await repairMissedNoShowOutcomes({ now, limit, result });
  // Then reopen any win whose evidence booking has since died (Codex #4710
  // r3 P1), so the win pass below re-judges it against the evidence that
  // still stands.
  await reopenWinsWithDeadEvidence({ now, limit, result });
  let rows;
  try {
    const cutoff = etDateString(addETDays(now, -(WON_WINDOW_DAYS + SWEEP_GRACE_DAYS)));
    const nowDateStr = etDateString(now);
    // Same [90-days-ago, today] visit-date window markWonForCustomer's own
    // atomic UPDATE bounds itself to (P1-2) — a consultation scheduled in
    // the future, or one long past its attribution window, is never
    // reconciled by either path. This sweep's own SELECTION cutoff is
    // wider (the grace period above); the actual WIN still requires
    // evidence dated inside the strict 90-day window — that bound lives in
    // findSaleEvidenceForConsultation, not here.
    rows = await db('consultation_outcomes as co')
      .join('scheduled_services as ss', 'ss.id', 'co.scheduled_service_id')
      .whereIn('co.outcome', CONVERTIBLE_OUTCOMES)
      .where(function notNoShowLoss() {
        this.whereNot('co.outcome', 'lost').orWhereNull('co.lost_reason').orWhereNot('co.lost_reason', 'no_show');
      })
      .whereNotNull('co.customer_id')
      .whereNotIn('ss.status', DEAD_CONSULTATION_STATUSES) // never won; no-shows are repaired to lost above
      .where('ss.scheduled_date', '>=', cutoff)
      .where('ss.scheduled_date', '<=', nowDateStr)
      .orderBy([{ column: 'co.last_reconciled_at', order: 'asc', nulls: 'first' }, { column: 'co.recorded_at', order: 'asc' }])
      .limit(limit)
      .select('co.id as outcome_id', 'co.customer_id', 'ss.scheduled_date', 'ss.window_start');
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
        windowStart: row.window_start || null,
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

// Codex #4710 r3 P1: a booking win stays `won` only while the booking behind
// it is still a real sale by isQualifyingSaleBooking (and not an
// assessment). When that booking is later cancelled, skipped, no-showed,
// deleted, or edited into a free visit, surviving in-window evidence
// re-points the win; otherwise the row returns to the outcome it had before the
// win (pre_win_outcome, warm when unknown) and the ordinary win pass can then
// re-judge it against whatever evidence still stands. Each reopen is a
// guarded UPDATE keyed on the same evidence id, so a row re-won meanwhile by
// other evidence is left alone. Mutates `result` in place.
// The open outcome a cleared win returns to: its recorded prior outcome, or
// warm when none was recorded.
function restoredOutcome(preWinOutcome) {
  return CONVERTIBLE_OUTCOMES.includes(preWinOutcome) ? preWinOutcome : 'warm';
}

// Whether a booking win's evidence booking is still this consultation
// customer's real sale: present, owned by the same customer, qualifying by
// isQualifyingSaleBooking, and not itself an assessment.
async function winBookingStillQualifies(locked, row) {
  const booking = await locked('scheduled_services')
    .where({ id: row.won_evidence_booking_id })
    .first(
      'id', 'service_type', 'service_id', 'status', 'source_action', 'customer_confirmed',
      'is_callback', 'recurring_parent_id', 'followup_included', 'estimated_price',
      'annual_prepay_term_id', 'is_recurring', 'create_invoice_on_complete', 'customer_id',
    );
  if (!booking || String(booking.customer_id || '') !== String(row.customer_id || '')) return false;
  return isQualifyingSaleBooking(booking) && !(await isAssessmentBooking(booking, locked));
}

async function reopenWinsWithDeadEvidence({ now, limit, result }) {
  result.reopened = 0;
  let rows;
  try {
    // Every evidence-backed win is re-judged in turn, least recently
    // examined first (last_reconciled_at NULLS FIRST, the same fairness
    // cursor the win pass uses), so a batch LIMIT can never starve an older
    // win (local audit P1).
    // ALL wins, not only booking-backed ones (Codex #4710 r4 P2): the
    // consultation itself can die after the win too, estimate wins included.
    rows = await db('consultation_outcomes as co')
      .where('co.outcome', 'won')
      .orderBy([{ column: 'co.last_reconciled_at', order: 'asc', nulls: 'first' }, { column: 'co.won_at', order: 'asc' }])
      .limit(limit)
      .select('co.id', 'co.customer_id', 'co.scheduled_service_id', 'co.won_evidence_booking_id', 'co.pre_win_outcome');
  } catch (err) {
    logger.error(`[consultation-outcomes] dead-evidence query failed: ${err.message}`);
    result.errors += 1;
    return;
  }
  for (const row of rows) {
    try {
       
      const changed = await db.transaction(async (locked) => {
        await boundLockWait(locked);
        if (row.customer_id) await lockCustomerRow(locked, row.customer_id);
        // Every write here is one of three shapes (Codex #4710 r9 P2 —
        // unified): stamp only, re-point to surviving evidence, or clear the
        // win back to an open (or no-show) outcome.
        const stampOnly = () => locked('consultation_outcomes').where({ id: row.id }).update({ last_reconciled_at: now }).then(() => 0);
        const clearWin = (outcome, extra = {}) => ({
          outcome, ...extra, won_at: null, won_via: null, won_evidence_booking_id: null, pre_win_outcome: null, last_reconciled_at: now, updated_at: now,
        });
        // The CONSULTATION must still have happened (Codex #4710 r4 P2): a
        // no-show becomes lost/no_show (markNoShow's own shape); a cancelled,
        // skipped or rescheduled one returns to its prior outcome.
        const consultation = await locked('scheduled_services').where({ id: row.scheduled_service_id }).first('status', 'scheduled_date', 'window_start');
        if (!consultation || DEAD_CONSULTATION_STATUSES.includes(consultation.status)) {
          const cleared = consultation?.status === 'no_show'
            ? clearWin('lost', { lost_reason: 'no_show' })
            : clearWin(restoredOutcome(row.pre_win_outcome));
          return locked('consultation_outcomes').where({ id: row.id, outcome: 'won' }).update(cleared);
        }
        // An estimate win (no booking behind it) on a live consultation stands.
        if (!row.won_evidence_booking_id) return stampOnly();
        // A booking win stands while its booking is still THIS customer's
        // real sale (local audit P1s: full sale rule, ownership).
        if (await winBookingStillQualifies(locked, row)) return stampOnly();
        // Surviving in-window evidence re-points the win (local audit P1),
        // regardless of the consultation's age; none → cleared.
        const evidence = row.customer_id
          ? await findSaleEvidenceForConsultation(locked, {
            customerId: row.customer_id,
            scheduledDateStr: toDateOnlyString(consultation.scheduled_date),
            windowStart: consultation.window_start,
            now,
          })
          : null;
        const guard = { id: row.id, outcome: 'won', won_evidence_booking_id: row.won_evidence_booking_id };
        return locked('consultation_outcomes').where(guard).update(evidence
          ? { won_at: evidence.won_at, won_via: evidence.won_via, won_evidence_booking_id: evidence.booking_id || null, last_reconciled_at: now, updated_at: now }
          : clearWin(restoredOutcome(row.pre_win_outcome)));
      });
      if (changed) result.reopened += 1;
    } catch (err) {
      result.errors += 1;
      logger.warn(`[consultation-outcomes] reopen failed for outcome ${row.id}: ${err.message}`);
    }
  }
}

// Round 12, P2 job-status.js:514 (codex): the no-show transition writes the
// outcome best-effort inside a savepoint, so a failed write there is logged
// and lost. This pass makes it retryable: any no-showed consultation visit
// in the sweep window whose outcome is still missing or open (warm/cold) is
// re-run through markNoShow, which re-checks isAssessmentBooking and keeps
// its own guarded UPDATE / insert-if-missing. Mutates `result` in place.
async function repairMissedNoShowOutcomes({ now, limit, result }) {
  result.no_show_repaired = 0;
  let rows;
  try {
    const cutoff = etDateString(addETDays(now, -(WON_WINDOW_DAYS + SWEEP_GRACE_DAYS)));
    rows = await db('scheduled_services as ss')
      .leftJoin('services as svc', 'svc.id', 'ss.service_id')
      .leftJoin('consultation_outcomes as co', 'co.scheduled_service_id', 'ss.id')
      .where('ss.status', 'no_show')
      .where('ss.scheduled_date', '>=', cutoff)
      .where(function matchConsultation() {
        this.whereRaw("lower(trim(ss.service_type)) = 'waves assessment'")
          .orWhere('svc.service_key', 'lawn_inspection')
          .orWhereRaw("lower(trim(svc.name)) = 'waves assessment'");
      })
      .where(function missingOrOpen() {
        this.whereNull('co.id').orWhereIn('co.outcome', ['warm', 'cold'])
          // ...or lost for another reason (Codex #4710 r8 P2).
          .orWhere(function lostNotNoShow() {
            this.where('co.outcome', 'lost').where(function reasonNotNoShow() {
              this.whereNull('co.lost_reason').orWhereNot('co.lost_reason', 'no_show');
            });
          });
      })
      .orderBy('ss.scheduled_date', 'asc')
      .limit(limit)
      .select('ss.id as scheduled_service_id');
  } catch (err) {
    logger.error(`[consultation-outcomes] no-show repair query failed: ${err.message}`);
    result.errors += 1;
    return;
  }

  for (const row of rows) {
    try {
      const saved = await db.transaction(async (sp) => {
        await boundLockWait(sp);
        return markNoShow(row.scheduled_service_id, { trx: sp });
      });
      if (saved && saved.outcome === 'lost' && saved.lost_reason === 'no_show') result.no_show_repaired += 1;
    } catch (err) {
      result.errors += 1;
      logger.warn(`[consultation-outcomes] no-show repair failed for visit ${row.scheduled_service_id}: ${err.message}`);
    }
  }
}

/**
 * A consultation visit's status flips to 'no_show'. If it's a consultation
 * with no outcome row (or an open warm/cold one), overwrite/write
 * outcome='lost', lost_reason='no_show'. A visit already 'lost' or 'won' is
 * left untouched — a no-show flip must not regress a closed outcome.
 */
async function markNoShow(scheduledServiceId, { trx, customerLockNowait = false } = {}) {
  const database = trx || db;
  if (!scheduledServiceId) return null;
  // Codex #4710 r10 P2 :1307 (lock order): read the customer id UNLOCKED
  // first, lock THAT customer row, and only then lock/recheck the visit —
  // customer-dedupe.js's executeMerge locks `customers FOR UPDATE` first
  // and only later updates this same scheduled_services row (customer-
  // dedupe.js:1456, 1762-1783). Locking the visit before the insert below's
  // implicit FK KEY SHARE lock on `customers` — the old order — is the
  // opposite of a concurrent merge's order: a classic ABBA deadlock.
  // customer → visit here matches every other lock site in this file (see
  // lockCustomerRow's own "VERIFIED CALLER ORDER" comment) and mirrors
  // recordOutcomeOnce's own svcRow-then-liveVisit shape below.
  const preview = await database('scheduled_services').where({ id: scheduledServiceId }).first('customer_id');
  if (!preview) return null;
  // customerLockNowait (Codex #4710 pre-push P1): the job-status no-show
  // hook runs AFTER its status UPDATE already holds this visit's lock, so a
  // blocking customer wait there is visit → customer — the reverse of every
  // other site. It takes the customer lock NOWAIT instead: busy → this
  // throws (lock_not_available), the caller's savepoint rolls back, and the
  // hourly repair pass (repairMissedNoShowOutcomes) records it later.
  if (customerLockNowait && preview.customer_id) {
    await database('customers').where({ id: preview.customer_id }).forNoKeyUpdate().noWait().first('id');
  } else {
    await lockCustomerRow(database, preview.customer_id);
  }

  // Locked and re-checked (local audit P1): the repair sweep selects visits
  // before processing them, so the office may have reopened/rescheduled one
  // in between. The job-status caller already moved the row to no_show in
  // this same transaction, so the check always holds there.
  const svcRow = await database('scheduled_services').where({ id: scheduledServiceId }).forNoKeyUpdate().first();
  if (!svcRow || svcRow.status !== 'no_show') return null;
  if (!(await isAssessmentBooking(svcRow, database))) return null;

  const now = new Date();

  // Atomic conditional UPDATE — no read-then-write TOCTOU against a
  // concurrent recordOutcome or markWonForCustomer: the WHERE outcome IN
  // (warm, cold) guard lives on the UPDATE itself, so a row that has
  // already resolved lost/won in the meantime is provably untouched by
  // this statement (not by a JS check on a stale read).
  // A lost outcome with any OTHER reason is normalized too (Codex #4710 r8
  // P2): the visit never happened, so a price/competitor loss recorded while
  // it was active must not stand beside the no-show.
  const updated = await database('consultation_outcomes')
    .where({ scheduled_service_id: scheduledServiceId })
    .where(function openOrOtherLoss() {
      this.whereIn('outcome', ['warm', 'cold'])
        .orWhere(function lostNotNoShow() {
          this.where('outcome', 'lost').where(function reasonNotNoShow() {
            this.whereNull('lost_reason').orWhereNot('lost_reason', 'no_show');
          });
        });
    })
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
    // The arithmetic midpoint (Codex #4710 r3 P2) — display rounding
    // belongs to the analytics UI, not the metric.
    : (sortedNumbers[mid - 1] + sortedNumbers[mid]) / 2;
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
// consultationStats helpers (Codex #4710 r9 P2 — table-driven).
// The per-reason / per-channel breakdown each counted outcome feeds.
const OUTCOME_BREAKDOWNS = {
  lost: { bucket: 'lost_by_reason', field: 'lost_reason' },
  won: { bucket: 'won_by_via', field: 'won_via' },
};

// The outcome a visit counts under, or null. A consultation cancelled,
// skipped or rescheduled after its outcome was recorded never happened
// (Codex #4710 r9 P2), so its outcome is not counted; a no-show still counts
// under its lost/no_show outcome.
function countedOutcome(v) {
  if (!v.outcome) return null;
  if (DEAD_CONSULTATION_STATUSES.includes(v.status) && v.status !== 'no_show') return null;
  return v.outcome;
}

// Credit goes to the technician who RECORDED the outcome (its snapshot),
// falling back to the visit's assignee when nothing is recorded yet — a
// dispatch reassignment after closeout never moves the credit.
function creditedTechnician(v) {
  const id = v.outcome_technician_id || v.technician_id || null;
  const name = (v.outcome_technician_id ? v.outcome_technician_name : v.technician_name) || 'Unassigned';
  return { id, name, key: id || 'unassigned' };
}

function bump(counts, key) {
  counts[key] = (counts[key] || 0) + 1;
}

function groupEntry(map, key, create) {
  if (!map.has(key)) map.set(key, create());
  return map.get(key);
}

async function consultationStats({ from, to, trx } = {}) {
  const database = trx || db;
  const now = new Date();
  const fromDate = from || etDateString(addETDays(now, -WON_WINDOW_DAYS));
  const toDate = to || etDateString(now);

  // Mirrors assessment-booking.js's isAssessmentServiceType/isAssessmentServiceRow
  // predicate in SQL (unavoidable for a set-based aggregate) — keep in sync.
  const visits = await database('scheduled_services as ss')
    .leftJoin('services as svc', 'ss.service_id', 'svc.id')
    .leftJoin('consultation_outcomes as co', 'co.scheduled_service_id', 'ss.id')
    // A dispatch reassignment after closeout never moves the credit
    // (Codex #4710 r3 P2).
    // Credit goes to the technician who RECORDED the outcome (its
    // snapshot, otech), falling back to the visit's assignee (tech) when
    // nothing is recorded yet — combined per row below.
    .leftJoin('technicians as tech', 'ss.technician_id', 'tech.id')
    .leftJoin('technicians as otech', 'co.technician_id', 'otech.id')
    // The originating lead even before an outcome is recorded (Codex #4710
    // r6 P2): the outcome's own lead, else the lead whose
    // appointment_scheduled activity names this visit — so a completed
    // visit is counted under its real source whether or not the tech has
    // closed it out yet.
    .leftJoin('leads as l', function originatingLead() {
      this.on('l.id', '=', database.raw(
        "COALESCE(co.lead_id, (SELECT la.lead_id FROM lead_activities la WHERE la.activity_type = 'appointment_scheduled' AND la.metadata->>'appointmentId' = ss.id::text ORDER BY la.created_at DESC LIMIT 1))",
      ));
    })
    // round 12 fix (codex P1 :1064): leads has no `lead_source` column —
    // the source is a FK, leads.lead_source_id -> lead_sources.id, with the
    // human-readable name on lead_sources.name. Selecting the bare
    // `l.lead_source` column that never existed 500'd this endpoint in
    // production (undefined-column) every time it ran against real
    // Postgres; the mocked stats test's hand-built fixture rows hid it
    // since nothing there validates real column existence.
    .leftJoin('lead_sources as lsrc', 'lsrc.id', 'l.lead_source_id')
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
      'co.technician_id as outcome_technician_id',
      'otech.name as outcome_technician_name',
      'co.outcome',
      'co.lost_reason',
      'co.won_via',
      'co.won_at',
      'lsrc.name as lead_source',
    );

  const stats = {
    booked: visits.length,
    showed: 0,
    won: 0,
    won_by_via: {},
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
    const outcome = countedOutcome(v);
    if (showed) stats.showed += 1;
    if (v.status === 'no_show') stats.no_show += 1;
    if (outcome) {
      stats[outcome] += 1;
      const breakdown = OUTCOME_BREAKDOWNS[outcome];
      if (breakdown) bump(stats[breakdown.bucket], v[breakdown.field] || 'unspecified');
    }
    if (outcome === 'won' && v.won_at) {
      // P1-1: v.scheduled_date is a DATE column — toDateOnlyString reads its
      // calendar fields directly (never etDateString, which would shift a
      // UTC-midnight date back a day under Railway's TZ=UTC).
      closeDurations.push(etDaysBetween(new Date(v.won_at), toDateOnlyString(v.scheduled_date)));
    }
    const tech = creditedTechnician(v);
    const source = v.lead_source || 'unknown';
    for (const entry of [
      groupEntry(techMap, tech.key, () => ({ technician_id: tech.id, name: tech.name, showed: 0, won: 0 })),
      groupEntry(sourceMap, source, () => ({ lead_source: source, showed: 0, won: 0 })),
    ]) {
      if (showed) entry.showed += 1;
      if (outcome === 'won') entry.won += 1;
    }
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
  isQualifyingSaleBooking,
  recordOutcome,
  markWonForCustomer,
  reconcileOpenConsultationOutcomes,
  markNoShow,
  consultationStats,
};
