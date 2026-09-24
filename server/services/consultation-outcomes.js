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
 */

const db = require('../models/db');
const logger = require('./logger');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');
const {
  isAssessmentServiceRow,
  isAssessmentServiceType,
  isAssessmentBooking,
} = require('./assessment-booking');

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

function defaultFollowUpAt(outcome, followUpAt) {
  if (followUpAt) return new Date(followUpAt);
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
 *       after the visit (another consultation is never itself a sale).
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
    .select('id', 'service_type', 'service_id', 'created_at');
  for (const booking of bookings) {
    if (await isAssessmentBooking(booking, database)) continue; // another consultation is not a sale
    return { won_via: 'office_booking', won_at: new Date(booking.created_at) };
  }

  return null;
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

  // Atomic upsert guard (waves-db-adjacent — no read-then-write TOCTOU
  // against markWonForCustomer's concurrent reconciliation): the conflict
  // UPDATE only fires while the existing row's outcome is NOT 'won'. A
  // genuine insert (no conflicting row) is unaffected by this WHERE — it
  // only gates the UPDATE branch — so `saved` is undefined in exactly one
  // case: a conflicting row exists AND it is already 'won'.
  const [saved] = await database('consultation_outcomes')
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
  // Savepoint-isolated (waves-db §5b) and best-effort, same as
  // markWonForCustomer: an evidence-lookup hiccup must never fail the record
  // itself, or (if `database` is a caller's live transaction) abort it.
  if (['warm', 'cold'].includes(saved.outcome)) {
    try {
      let won = null;
      await database.transaction(async (sp) => {
        const evidence = await findSaleEvidenceForConsultation(sp, {
          customerId,
          scheduledDateStr: toDateOnlyString(svcRow.scheduled_date),
          now,
        });
        if (!evidence) return;
        const [wonRow] = await sp('consultation_outcomes')
          .where({ id: saved.id })
          .whereIn('outcome', ['warm', 'cold'])
          .update({ outcome: 'won', won_at: evidence.won_at, won_via: evidence.won_via, updated_at: new Date() })
          .returning('*');
        won = wonRow || null;
      });
      if (won) return won;
    } catch (err) {
      logger.warn(`[consultation-outcomes] post-record sale-evidence reconciliation failed for ${scheduledServiceId}: ${err.message}`);
    }
  }

  return saved;
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
    await trx.transaction(async (sp) => {
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
  recordOutcome,
  markWonForCustomer,
  markNoShow,
  consultationStats,
};
