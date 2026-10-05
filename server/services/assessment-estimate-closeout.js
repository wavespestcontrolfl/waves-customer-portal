// Estimate sent after a Waves Assessment ⇒ the assessment is closed (owner
// ruling 2026-10-04). The assessment is the walkthrough; the estimate is what
// comes out of it. Once the estimate has gone to the customer the walkthrough
// happened, and nobody should have to tap Complete on it. Dark by default:
// GATE_ESTIMATE_SENT_CLOSES_ASSESSMENT.
//
// A SWEEP OVER DURABLE STATE, not a hook on each send path. An estimate is
// marked sent from many places (the admin send routes, scheduled sends, the
// report's click-to-estimate, the website quote). Hooking each one means one
// best-effort call per rail and a retry story for every way that call can be
// lost; the invoice-issued closeout took five review rounds to learn that
// (#5886). So this reads what is durably true — an open assessment visit and
// an estimate with a sent_at stamp for the same customer — every ten minutes,
// and closes what the rule admits. A send path added later needs no wiring.
//
// The close itself is the canonical completion. A Waves Assessment's profile
// is internal-only: no service report, no completion text, no review ask, no
// invoice. Nothing is reimplemented here; this module decides WHICH visit.
const db = require('../models/db');
const logger = require('./logger');
const { etDateString, dateOnlyString } = require('../utils/datetime-et');
const {
  scopeToAssessmentBookings, isAssessmentBooking, ASSESSMENT_DISPLAY_NAME, ASSESSMENT_SERVICE_KEY,
} = require('./assessment-booking');

const gateLive = () => require('../config/feature-gates').estimateSentClosesAssessmentLive();

// The technician has set out for, or reached, the assessment.
const STARTED_STATUSES = ['en_route', 'on_site'];
// Nobody is known to have gone. A NULL status is a live visit (the
// repository's legacy live-visit convention).
const UNSTARTED_STATUSES = ['pending', 'confirmed'];

// Visits that never happened: an estimate is never matched to one.
const DEAD_STATUSES = ['cancelled', 'no_show', 'skipped', 'rescheduled'];

// Refusals that only mean "the visit changed while it was being closed":
// retried on the next tick, never rested.
const RACE_CODES = ['visit_changed', 'service_reassigned', 'visit_identity_changed'];
const AUDIT_CLOSED = 'visit.assessment_closed_on_estimate_sent';
// The estimate ↔ assessment pairing, written INSIDE the completion's record
// transaction by the locked guard, so it commits exactly when the close does.
const AUDIT_PAIRED = 'visit.assessment_estimate_paired';
const AUDIT_REFUSED = 'visit.assessment_close_on_estimate_sent_refused';
// The close ALWAYS runs in the backfill posture, on the visit day too
// (completeScheduledService admits the same day for a system quiet
// closeout): nobody timed this visit, so its time on site stays unknown
// rather than being booked from arrived_at to whenever the sweep ran (Codex
// r3 P1 #5903). One posture means one request per visit: the completion
// hashes its request and matches a committed attempt's resume on it, so the
// request is constant and carries no visit identity (a date correction or a
// customer merge between attempts would change the hash and strand the
// retry). Identity is decided on the locked row by lockedVisitGuard.
// What the completion's record is built from; compared between the row it
// loaded and the row it locked.
const IDENTITY_FIELDS = ['customer_id', 'scheduled_date', 'service_type', 'service_id'];
const identityValue = (visit, field) => (field === 'scheduled_date'
  ? (visit && visit.scheduled_date ? dateOnlyString(visit.scheduled_date) : null)
  : String((visit && visit[field]) ?? ''));
const KEY_PREFIX = 'assessment-estimate:';
const idempotencyKeyFor = (visitId) => `${KEY_PREFIX}${visitId}:backfill`;

// How far back an estimate's send still closes an assessment, how old an
// assessment may be, and how long a refused visit rests before it is asked
// again (the sweep runs every ten minutes; a refusal about what the visit IS
// would otherwise be re-run and re-audited 144 times a day). The rest is part
// of the candidate query, so a resting visit takes no slot.
const ESTIMATE_WINDOW_DAYS = 14;
const ASSESSMENT_WINDOW_DAYS = 30;
const REFUSAL_REST_HOURS = 6;

const isStarted = (status) => status != null && STARTED_STATUSES.includes(String(status));
const isUnstarted = (status) => status == null || UNSTARTED_STATUSES.includes(String(status));

function validTime(value) {
  const time = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(time) ? time : null;
}

// THE rule. Null when the estimate's send closes the assessment, else the
// reason it stays open. "After the assessment" is read from durable stamps,
// never from the clock at call time, so a sweep ten minutes or ten days
// later reaches the same verdict:
//  - STARTED (en_route / on_site): the estimate was sent after the technician
//    set out (arrived_at, else en_route_at). GPS often misses the arrival, so
//    en_route counts: an estimate sent after the technician left for the
//    property came out of that visit.
//  - UNSTARTED: nobody is known to have gone, so the estimate must have been
//    sent on a LATER ET day than the visit. An estimate sent on or before the
//    visit day is a quote ahead of the walkthrough and closes nothing.
//  - A future visit, every terminal status, and an assessment that carries a
//    price or a prepayment never close.
function assessmentEstimateCloseRefusal(visit, estimateSentAt, { today = etDateString() } = {}) {
  const started = isStarted(visit.status);
  if (!started && !isUnstarted(visit.status)) return `visit_${visit.status}`;
  const day = visit.scheduled_date ? dateOnlyString(visit.scheduled_date) : null;
  if (!day || day > today) return 'visit_in_future';
  // An assessment is a free walkthrough. One that carries money (a visit
  // price, a recorded prepayment) is not the ordinary case and is left to a
  // person: this close never bills, so it must not be the one to decide that
  // nothing is owed. (A linked invoice is the third form: liveRefusal.)
  // The visit's price is estimated_price, or — when that is unset — the
  // structured primary_line_price the completion's invoice amount also reads
  // (Codex r6 P2). An explicit estimated_price of 0 stays authoritative.
  const price = visit.estimated_price != null ? Number(visit.estimated_price) : Number(visit.primary_line_price);
  if (price > 0 || Number(visit.prepaid_amount) > 0) return 'assessment_has_charge';
  const sentTime = validTime(estimateSentAt);
  if (sentTime == null) return 'estimate_not_sent';
  const sentDay = etDateString(new Date(sentTime));
  if (!started) return sentDay > day ? null : 'estimate_not_after_visit_day';
  if (sentDay < day) return 'estimate_before_visit';
  const startedTime = validTime(visit.arrived_at) ?? validTime(visit.en_route_at);
  // No start stamp on a started visit: the day comparison above stands in.
  return startedTime == null || sentTime > startedTime ? null : 'estimate_before_visit';
}

// This closeout's own completion attempt, committed but not finished (the
// canonical completion commits status='completed' before its post-commit
// work and parks a crashed run under its idempotency key).
// COMMITTED only (Codex r6 P1 #5903): a resume is owed when the completion
// wrote its record and status and parked its post-commit work. A pre-commit
// `pending` attempt committed nothing, so it is no proof this closeout
// completed the visit — a visit completed by someone else must not be
// finished through this quiet lane on its strength.
const PARKED_STATUSES = ['side_effects_pending', 'side_effects_running'];
const OWN_PARKED_ATTEMPT_SQL = "EXISTS (SELECT 1 FROM service_completion_attempts a WHERE a.service_id = s.id AND a.idempotency_key LIKE 'assessment-estimate:' || s.id::text || ':%' AND a.status IN ('side_effects_pending', 'side_effects_running') AND a.service_record_id IS NOT NULL)";

// The key this closeout's parked attempt was claimed under, so a resume sends
// the request that attempt committed (its key and its posture).
async function parkedKey(conn, visitId) {
  const attempt = await conn('service_completion_attempts')
    .where({ service_id: visitId })
    .where('idempotency_key', 'like', `${KEY_PREFIX}${visitId}:%`)
    .whereIn('status', PARKED_STATUSES)
    .whereNotNull('service_record_id')
    .orderBy('updated_at', 'desc')
    .first('idempotency_key');
  return attempt ? attempt.idempotency_key : null;
}

// The rule and the rest, as SQL, so a row the sweep cannot act on this tick
// never takes one of its slots (a full page of refused or not-yet rows would
// otherwise be picked again every tick and starve the eligible visits behind
// it). The JS rule re-decides each row on a fresh read, and the completion
// decides once more under its row lock; this only chooses the page.
function candidateVisits(conn, { today, now }) {
  const { LATEST_HANDOFF_SQL } = require('./call-commitments');
  const oldest = etDateString(new Date(now.getTime() - ASSESSMENT_WINDOW_DAYS * 86400000));
  const estimateSince = new Date(now.getTime() - ESTIMATE_WINDOW_DAYS * 86400000);
  const restSince = new Date(now.getTime() - REFUSAL_REST_HOURS * 3600000);
  // "Sent" is a REAL handoff (Codex r5 P1 #5903): a delivery that reached the
  // customer, or their own acceptance — never a bare sent_at, which a
  // suppressed send stamps while nothing goes out.
  const HANDOFF_SQL = `(${LATEST_HANDOFF_SQL})`;
  const HANDOFF_DAY_SQL = `((${LATEST_HANDOFF_SQL}) AT TIME ZONE 'America/New_York')::date`;
  return conn('scheduled_services as s')
    .leftJoin('services as svc', 'svc.id', 's.service_id')
    .where((q) => q
      .where((open) => scopeToAssessmentBookings(open, 's', 'svc')
        .where('s.scheduled_date', '<=', today)
        .where('s.scheduled_date', '>=', oldest)
        .whereExists(function handedOffAfter() {
          this.select(conn.raw('1')).from('estimates')
            .whereRaw('estimates.customer_id = s.customer_id')
            .whereRaw(`${HANDOFF_SQL} >= ?`, [estimateSince])
            .whereNotExists(function closedAnother() {
              this.select(conn.raw('1')).from('audit_log as used')
                .where('used.action', AUDIT_PAIRED)
                .whereRaw("used.resource_type = 'scheduled_services' AND used.metadata ->> 'estimateId' = estimates.id::text AND used.resource_id <> s.id");
            })
            // One estimate, one assessment (matchedAssessmentId): the
            // estimate's explicit booking link when it has one; otherwise
            // (legacy, unlinked) no newer assessment of this customer on or
            // before the estimate's handoff day.
            .whereRaw(`(estimates.estimate_data ->> 'scheduled_service_id' = s.id::text OR (estimates.estimate_data ->> 'scheduled_service_id' IS NULL AND NOT EXISTS (
              SELECT 1 FROM scheduled_services s2 LEFT JOIN services svc2 ON svc2.id = s2.service_id
              WHERE s2.customer_id = s.customer_id AND s2.id <> s.id
                AND (s2.status IS NULL OR s2.status NOT IN (${DEAD_STATUSES.map(() => '?').join(', ')}))
                AND s2.scheduled_date <= ${HANDOFF_DAY_SQL}
                AND (s2.scheduled_date > s.scheduled_date OR (s2.scheduled_date = s.scheduled_date AND s2.id > s.id))
                AND (LOWER(TRIM(s2.service_type)) = ? OR svc2.service_key = ? OR LOWER(TRIM(svc2.name)) = ?))))`,
            [...DEAD_STATUSES, ASSESSMENT_DISPLAY_NAME.toLowerCase(), ASSESSMENT_SERVICE_KEY, ASSESSMENT_DISPLAY_NAME.toLowerCase()])
            .where((rule) => rule
              .where((started) => started.whereIn('s.status', STARTED_STATUSES)
                .whereRaw(`${HANDOFF_DAY_SQL} >= s.scheduled_date`)
                .whereRaw(`(COALESCE(s.arrived_at, s.en_route_at) IS NULL OR ${HANDOFF_SQL} > COALESCE(s.arrived_at, s.en_route_at))`))
              .orWhere((unstarted) => unstarted
                .where((live) => live.whereIn('s.status', UNSTARTED_STATUSES).orWhereNull('s.status'))
                .whereRaw(`${HANDOFF_DAY_SQL} > s.scheduled_date`)));
        })
        // Money is a person's: no visit price, no prepayment, no linked
        // invoice (a NULL invoice status is a live invoice).
        .whereRaw('COALESCE(s.estimated_price, s.primary_line_price, 0) <= 0 AND COALESCE(s.prepaid_amount, 0) <= 0')
        .whereNotExists(function linkedInvoice() {
          this.select(conn.raw('1')).from('invoices as inv').whereRaw("inv.scheduled_service_id = s.id AND inv.status IS DISTINCT FROM 'void'");
        })
        .whereNotExists(function resting() {
          this.select(conn.raw('1')).from('audit_log as al')
            .whereRaw("al.resource_type = 'scheduled_services' AND al.resource_id = s.id")
            .where('al.action', AUDIT_REFUSED)
            .where('al.created_at', '>=', restSince)
            // Only a refusal about the visit rests it. A failure (a thrown
            // error, or a 5xx the completion returned) is an outage, retried
            // on the very next tick (Codex r4 P2 #5903).
            .whereRaw("COALESCE(al.metadata ->> 'code', '') <> 'error' AND COALESCE(NULLIF(al.metadata ->> 'status', '')::int, 0) < 500")
            // …nor does a race with an edit between the completion's load and
            // its lock: a fresh read of the now-settled visit decides on the
            // next tick (Codex r7 P2 #5903).
            .whereRaw(`COALESCE(al.metadata ->> 'code', '') NOT IN (${RACE_CODES.map(() => '?').join(', ')})`, RACE_CODES);
        }))
      // This closeout's own committed attempt, owed its post-commit work: it
      // resumes from the state it froze, so no current eligibility applies —
      // not the window, not the assessment identity (a later edit to the
      // completed visit must not strand it, Codex r5 P2).
      .orWhere((done) => done.where('s.status', 'completed').whereRaw(OWN_PARKED_ATTEMPT_SQL)))
    // Open visits first: a resume that keeps failing must not take the
    // slots of visits that can close.
    .orderByRaw(`(${OWN_PARKED_ATTEMPT_SQL}) ASC, s.scheduled_date ASC, s.id ASC`)
    .select('s.*', conn.raw(`${OWN_PARKED_ATTEMPT_SQL} as own_attempt_parked`));
}

async function audit(action, { visitId, estimateId, code = null, status = null, error = null }) {
  try {
    await require('./audit-log').recordAuditEvent({
      actor_type: 'system',
      action,
      resource_type: 'scheduled_services',
      resource_id: visitId,
      metadata: { estimateId, code, status, ...(error ? { error } : {}) },
      // Critical, so a failed insert reaches the catch below and is logged:
      // the closed row is also the estimate's pairing record.
      critical: true,
    });
  } catch (err) {
    logger.warn(`[assessment-estimate-closeout] audit write failed for visit ${visitId}: ${err.message}`);
  }
}

// ONE estimate closes ONE assessment: the visit its booking link names, else
// (legacy) the newest assessment of that customer on or before the day the
// estimate was sent — the walkthrough the estimate
// came out of. An older assessment still open behind it (abandoned, then
// rebooked) is not closed by the same estimate, whether the newer one is
// still open or already completed (GitHub r1 P1 #5903). Newest = latest
// scheduled day, then id; the candidate query applies the same order in SQL.
async function matchedAssessmentId(conn, customerId, estimate) {
  // The estimate's own booking link (estimator-engine/booking-predraft.js
  // writes estimate_data.scheduled_service_id): when present it decides,
  // whatever else the customer has booked (Codex r4 P1 #5903). It names
  // this customer's visit or nothing.
  let data = estimate.estimate_data;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = null; } }
  const linked = data && data.scheduled_service_id ? String(data.scheduled_service_id) : null;
  if (linked) {
    const visit = await conn('scheduled_services').where({ id: linked, customer_id: customerId }).first('id');
    return visit ? visit.id : null;
  }
  // Legacy, unlinked: the newest assessment on or before the send day.
  const sentDay = etDateString(new Date(estimate.sent_at));
  const query = conn('scheduled_services as s')
    .leftJoin('services as svc', 'svc.id', 's.service_id')
    .where('s.customer_id', customerId)
    .where('s.scheduled_date', '<=', sentDay)
    .where((q) => q.whereNotIn('s.status', DEAD_STATUSES).orWhereNull('s.status'))
    .orderBy([{ column: 's.scheduled_date', order: 'desc' }, { column: 's.id', order: 'desc' }])
    .first('s.id');
  const newest = await scopeToAssessmentBookings(query, 's', 'svc');
  return newest ? newest.id : null;
}

// The estimate that speaks for THIS assessment: the newest sent estimate of
// the customer (inside the window) whose matched assessment is this visit.
// The customer's newest estimate overall may belong to a later assessment —
// A with E1, then B with E2 — and must not hide E1 from A (pre-push audit P1).
// The candidate query selects by the same pairing in SQL.
// An estimate that already closed ONE assessment closes no other (pre-push
// audit P1): resent, or accepted, after a later assessment it would match
// that one too under the date heuristic. The pairing is the closed audit row
// row the locked guard writes in the completion's own transaction
// (AUDIT_PAIRED, metadata.estimateId), read back here and in SQL.
async function estimateClosedAnother(conn, estimateId, visitId) {
  const used = await conn('audit_log')
    .where({ action: AUDIT_PAIRED, resource_type: 'scheduled_services' })
    .whereRaw("metadata ->> 'estimateId' = ?", [String(estimateId)])
    .whereNot('resource_id', visitId)
    .first('id');
  return Boolean(used);
}

async function estimateForAssessment(conn, visit, { now }) {
  if (!visit.customer_id) return null;
  const { HANDOFF_COLS, latestHandoffAt } = require('./call-commitments');
  const since = now.getTime() - ESTIMATE_WINDOW_DAYS * 86400000;
  const rows = await conn('estimates')
    .where({ customer_id: visit.customer_id })
    .select([...HANDOFF_COLS(conn), 'estimate_data']);
  // `sent_at` below is the LATEST real handoff (a delivery or the customer's
  // own acceptance), never the row's sent_at column (Codex r5 P1 #5903).
  const handedOff = rows
    .map((row) => ({ ...row, sent_at: latestHandoffAt(row) }))
    .filter((row) => row.sent_at && row.sent_at.getTime() >= since)
    .sort((x, y) => y.sent_at - x.sent_at);
  for (const estimate of handedOff) {
    if (await estimateClosedAnother(conn, estimate.id, visit.id)) continue;
    if (String(await matchedAssessmentId(conn, visit.customer_id, estimate)) === String(visit.id)) return estimate;
  }
  return null;
}

// Reads beyond the visit row that keep it open: an unresolved street-level
// address hold, an invoice is linked to it (money: a
// person's), its technician's job timer is still running (they are working
// it right now), or it is one stop of a grouped visit (the whole visit
// closes together).
async function liveRefusal(conn, visit) {
  const invoice = await conn('invoices').where({ scheduled_service_id: visit.id }).whereRaw("status IS DISTINCT FROM 'void'").first('id');
  if (invoice) return 'assessment_has_invoice';
  // An unresolved street-level address hold (a voice-agent booking awaiting
  // the office): completing the visit would stamp the address confirmed
  // without anyone approving it (pre-push audit P1). Fails closed: a lookup
  // error reads as held.
  if (await require('./street-level-hold').isStreetLevelHoldVisit(visit.id, conn)) return 'street_level_hold';
  const { visitJobTimerRunning } = require('./invoice-issued-closeout');
  if (await visitJobTimerRunning(conn, visit.id)) return 'visit_timer_running';
  if (visit.visit_id) {
    const { openMembers } = require('./visit-groups');
    if ((await openMembers(conn, visit.visit_id)).length >= 2) return 'grouped_visit';
  }
  return null;
}

// The canonical completion, asked for nothing customer-facing, in the
// backfill posture (time on site unknown; see idempotencyKeyFor).
async function closeAssessment(visit, { today, now, resumeKey = null }) {
  const { completeScheduledService } = require('./complete-scheduled-service');
  const resuming = Boolean(resumeKey);
  const key = resumeKey || idempotencyKeyFor(visit.id);
  const result = await completeScheduledService({
    serviceId: visit.id,
    idempotencyKey: key,
    body: {
      visitOutcome: 'completed',
      sendCompletionSms: false,
      requestReview: false,
      // No inspection credit offer (owner ruling 2026-10-04, Codex r2 P1
      // #5903): the $75 credit is recorded only when a person completes the
      // assessment by hand. The completion defaults it ON, so it is cleared
      // explicitly.
      offerInspectionCredit: false,
      idempotencyKey: key,
      backfill: true,
    },
    actor: { techRole: 'admin', technicianId: null, technician: null },
    // Nobody's work and nobody's bill: no invoice is minted (so nothing can
    // be charged), and no "<technician> completed" activity line or
    // job_complete notification is written for the assigned technician.
    systemQuietCloseout: true,
    // The WHOLE decision once more, on the visit row the completion has
    // LOCKED, from that row alone: still an assessment, an estimate sent to the
    // customer the row names NOW, the rule, and no running timer or open
    // group. A reschedule, a reclassification, a customer merge, an arrival
    // or a timer start after this module's reads is therefore decided on
    // what is true under the lock, never completed over.
    // A RESUME carries no guard: that attempt already committed the visit as
    // completed on evidence that was good then, and only its post-commit
    // work is owed.
    lockedVisitGuard: resuming ? null : async (trx, lockedVisit, loadedVisit) => {
      // The completion builds its record (customer, service day, service
      // line) from the row it LOADED before this lock. If the locked row
      // differs from that load in any of them, the verdict below would be
      // about one visit and the record about another: refuse, and the next
      // tick reads the visit as it now is.
      if (IDENTITY_FIELDS.some((field) => identityValue(lockedVisit, field) !== identityValue(loadedVisit, field))) return 'visit_changed';
      if (!(await isAssessmentBooking(lockedVisit, trx))) return 'not_assessment';
      const lockedToday = etDateString();
      const estimate = await estimateForAssessment(trx, lockedVisit, { now });
      if (!estimate) return 'estimate_not_sent';
      const refusal = assessmentEstimateCloseRefusal(lockedVisit, estimate.sent_at, { today: lockedToday })
        || await liveRefusal(trx, lockedVisit);
      if (refusal) return refusal;
      // Admitted: record the pairing in THIS transaction, so it commits with
      // the completion or not at all, and a resume keeps it (pre-push audit
      // P1). Not best-effort: a failed insert aborts the close.
      await require('./audit-log').recordAuditEvent({
        actor_type: 'system',
        action: AUDIT_PAIRED,
        resource_type: 'scheduled_services',
        resource_id: lockedVisit.id,
        metadata: { estimateId: estimate.id },
        critical: true,
        trx,
      });
      return null;
    },
  });
  const body = (result && result.body) || {};
  const status = (result && result.status) || null;
  return { closed: status === 200 && body.success === true, status, code: (body.code === 'locked_visit_guard_refused' && body.reason) || body.code || null };
}

// One candidate visit: decide, close, audit. Never throws.
async function closeOne(conn, row, { today, now }) {
  const visitId = row.id;
  let estimate = null;
  try {
    // Fresh reads: the candidate query is a snapshot.
    const visit = await conn('scheduled_services').where({ id: visitId }).first();
    if (!visit) return { closed: false, reason: 'not_found' };
    const parkedResume = Boolean(row.own_attempt_parked) && visit.status === 'completed';
    if (!parkedResume && !(await isAssessmentBooking(visit, conn))) return { closed: false, reason: 'not_assessment' };
    // This closeout's own attempt committed the visit as completed and still
    // owes its post-commit work: finish it from the state it froze. It needs
    // no fresh evidence — the estimate may have gone back to draft or aged
    // out of the window since, and requiring it again would strand the
    // attempt for good (pre-push audit P1).
    const resuming = parkedResume;
    let resumeKey = null;
    if (resuming) {
      resumeKey = await parkedKey(conn, visitId);
      if (!resumeKey) return { closed: false, reason: 'nothing_parked' };
    } else {
      estimate = await estimateForAssessment(conn, visit, { now });
      if (!estimate) return { closed: false, reason: 'estimate_not_sent' };
      // Not this rule's to decide, or not yet: no audit row, nothing to rest.
      const byRule = assessmentEstimateCloseRefusal(visit, estimate.sent_at, { today });
      if (byRule) return { closed: false, reason: byRule };
      const live = await liveRefusal(conn, visit);
      if (live) {
        await audit(AUDIT_REFUSED, { visitId, estimateId: estimate.id, code: live });
        return { closed: false, reason: live };
      }
    }
    const estimateId = estimate ? estimate.id : null;
    const outcome = await closeAssessment(visit, { today, now, resumeKey });
    if (outcome.closed) {
      logger.info(`[assessment-estimate-closeout] visit ${visitId} ${resuming ? 'completion resumed' : `completed: estimate ${estimateId} was sent after it`}`);
      await audit(AUDIT_CLOSED, { visitId, estimateId, status: outcome.status, ...(resuming ? { code: 'resumed' } : {}) });
      return { closed: true, reason: null };
    }
    const reason = outcome.code || `status_${outcome.status}`;
    logger.warn(`[assessment-estimate-closeout] visit ${visitId} NOT completed (${outcome.status} ${reason})`);
    await audit(AUDIT_REFUSED, { visitId, estimateId, code: reason, status: outcome.status });
    return { closed: false, reason };
  } catch (err) {
    logger.error(`[assessment-estimate-closeout] visit ${visitId} failed: ${err.message}`);
    await audit(AUDIT_REFUSED, { visitId, estimateId: estimate ? estimate.id : null, code: 'error', error: String(err.message || err).slice(0, 500) });
    return { closed: false, reason: 'error' };
  }
}

// The sweep (scheduler: assessment-estimate-closeout, every ten minutes).
async function closeAssessmentsWithSentEstimates({ conn = db, now = new Date(), today = etDateString(now), limit = 25 } = {}) {
  const none = { candidates: 0, closed: 0 };
  if (!gateLive()) return none;
  let rows = [];
  try {
    rows = await candidateVisits(conn, { today, now }).limit(limit);
  } catch (err) {
    logger.error(`[assessment-estimate-closeout] candidate lookup failed: ${err.message}`);
    return none;
  }
  let closed = 0;
  for (const row of rows) {
    const out = await closeOne(conn, row, { today, now });
    if (out.closed) closed += 1;
  }
  if (closed) logger.info(`[assessment-estimate-closeout] ${rows.length} candidate(s), ${closed} closed`);
  return { candidates: rows.length, closed };
}

module.exports = {
  assessmentEstimateCloseRefusal,
  closeAssessmentsWithSentEstimates,
  AUDIT_CLOSED,
  AUDIT_PAIRED,
  AUDIT_REFUSED,
};
