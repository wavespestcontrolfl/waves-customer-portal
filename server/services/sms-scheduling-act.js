'use strict';
/**
 * SMS scheduling executor, MOVE (GATE_SMS_SCHEDULING_ACT_MOVE, dark).
 *
 * The decide step (sms-scheduling-decide.js) recorded a would-move: a customer
 * accepted one offered time for one visit and every check passed. With this
 * gate on, that decision is carried out here, through the same choke points
 * the customer's own reschedule link uses (routes/reschedule-public.js):
 *   1. claim the decision row (one executor per decision, never retried);
 *   2. the link's own verdict on the visit, and its picker rebuilt for that one
 *      day: the accepted time must still be offered;
 *   3. the link's own move (one visit, or the series for a recurring visit's
 *      date move), pinned to the visit as the decide step read it. Under the move's locks the guard reads every fence again (the offer
 *      is still open, the visit is as it was checked, nothing newer on the
 *      conversation, no move logged since the offer went out, no staff
 *      schedule-change request, no unanswered reminder reply-1/2 offer) and
 *      writes "moved" on the decision and "accepted" on the offer in the
 *      move's own transaction: the visit moves and the record says so, or
 *      neither happens;
 *   4. the standard rescheduled text and reminder sync, exactly as the link
 *      sends them (code-rendered from the committed visit, never model words).
 *
 * Anything that refuses leaves the visit untouched and the text to staff, as
 * today. Never throws.
 *
 * PII: never logs message bodies or phone numbers.
 */

const db = require('../models/db');
const logger = require('./logger');
const { gateEnvValue } = require('../config/feature-gates');
const { dateOnlyString } = require('../utils/datetime-et');
const { phoneIdentitySql } = require('./sms-response-policy');

const REASON_CODE = 'customer_request'; // reschedule_log.reason_code varchar(30)
// reschedule_log.initiated_by varchar(20). Its own value, so the scheduling
// funnel never scores the executor's move as a person confirming the decision.
const INITIATED_BY = 'sms_offer_ai';
// The customer-driven SMS surface the series reconciler already finishes.
const SOURCE_SURFACE = 'sms_reply';
// A reply the 15-minute sweep recovered hours later is not acted on: the
// customer has waited too long for a move and a text to arrive unannounced.
const MAX_REPLY_AGE_MS = 15 * 60000;

/** GATE_SMS_SCHEDULING_ACT_MOVE, read at call time: a flip needs no redeploy. */
function actMoveLive() {
  return gateEnvValue('GATE_SMS_SCHEDULING_ACT_MOVE');
}

// Code only, never the message: a Knex error embeds bound values.
const errorCode = (err) => String(err?.code || err?.name || 'error').slice(0, 40);
const hhmm = (value) => (value == null ? null : String(value).slice(0, 5));

function refusal(reason, detail = null) {
  return { executed: false, status: 'refused', reason, ...(detail ? { detail: String(detail).slice(0, 60) } : {}) };
}

function guardError(reason) {
  return Object.assign(new Error(reason), { code: 'SMS_ACT_REFUSED', refusal: reason });
}

/** One executor per decision: only an unclaimed would-move is taken. */
async function claimDecision(dbh, decisionId) {
  const rows = await dbh('sms_offer_decisions')
    .where({ id: decisionId, outcome: 'would_move' })
    .whereNull('execution_status')
    .update({ execution_status: 'claimed' })
    .returning('id');
  return rows.length > 0;
}

// The result of a claim that did not move. Never overwrites "moved".
async function closeClaim(dbh, decisionId, status, execution) {
  await dbh('sms_offer_decisions')
    .where({ id: decisionId, execution_status: 'claimed' })
    .update({ execution_status: status, execution: JSON.stringify(execution), executed_at: dbh.fn.now() });
}

/**
 * The checks the move runs under its own locks, and the two writes that
 * commit with it. `expected` is the visit as the decide step checked it.
 */
function buildMoveGuard({ decisionId, offer, visitId, customerId, now, target, expected, inboundSmsLogId, repliedAt }) {
  return async ({ trx }) => {
    const fences = require('./call-reschedule-apply');
    // The visit's own row lock: the portal request route holds it while it
    // files a schedule-change request, so that request is either visible
    // below or starts after this move.
    const row = await trx('scheduled_services').where({ id: visitId }).forUpdate()
      .first('scheduled_date', 'window_start', 'window_end', 'status', 'customer_id', 'visit_id');
    // The locked visit is still the one the decide step checked: an Edit
    // appointment save logs no move, and the series mover pins only date and
    // start, so the comparison is made here for both movers.
    const unchanged = row && dateOnlyString(row.scheduled_date) === expected.date
      && hhmm(row.window_start) === expected.start && hhmm(row.window_end) === expected.end
      && row.status === expected.status && String(row.customer_id) === String(customerId) && !row.visit_id;
    if (!unchanged) throw guardError('visit_changed');
    const current = await trx('sms_offers').where({ id: offer.id }).forUpdate().first('id', 'status');
    if (!current || current.status !== 'open') throw guardError('offer_closed');
    const moved = await trx('reschedule_log').where({ scheduled_service_id: visitId })
      .where('created_at', '>', offer.sent_at).first('id');
    if (moved) throw guardError('moved_since_offer');
    // Anything newer on this conversation, either way: the customer wrote
    // again ("actually, leave it") or someone at Waves already answered. The
    // decision read only the thread up to its own text.
    const newer = await trx('sms_log')
      .whereRaw(`${phoneIdentitySql("CASE WHEN direction = 'inbound' THEN from_phone ELSE to_phone END")} = ?`, [offer.phone_last10])
      .whereRaw(`${phoneIdentitySql("CASE WHEN direction = 'inbound' THEN to_phone ELSE from_phone END")} = ?`, [offer.waves_line])
      .where('created_at', '>', repliedAt)
      .whereNot('id', inboundSmsLogId)
      .first('id');
    if (newer) throw guardError('newer_message');
    if (await fences.openPortalRequest(trx, customerId, visitId)) throw guardError('portal_request_open');
    if (await fences.pendingSmsOffer(trx, customerId, visitId, now)) throw guardError('reminder_offer_pending');
    const marked = await trx('sms_offer_decisions')
      .where({ id: decisionId, execution_status: 'claimed' })
      .update({ execution_status: 'moved', mode: 'live', execution: JSON.stringify(target), executed_at: trx.fn.now() });
    if (!marked) throw guardError('claim_lost');
    await trx('sms_offers').where({ id: offer.id })
      .update({ status: 'accepted', closed_at: trx.fn.now(), updated_at: trx.fn.now() });
  };
}

const stampEffects = (dbh, key) => dbh.raw("COALESCE(execution, '{}'::jsonb) || jsonb_build_object(?::text, to_jsonb(now()))", [key]);

/**
 * A single move's customer notice and reminder sync, taken once. The claim
 * (effects_started_at on the decision) is written before the send, so a
 * process that died between the move's commit and this point leaves a moved
 * decision with no claim, which finishMoveEffects picks up; one that died
 * mid-send is never sent twice. The sync is pinned to the slot this move
 * committed, so it never overwrites a newer move's reminder state.
 */
async function notifySingleMove({ dbh, decisionId, visitId, date, start, deps = {} }) {
  const claimed = await dbh('sms_offer_decisions')
    .where({ id: decisionId, execution_status: 'moved' })
    .whereRaw("execution->>'effects_started_at' IS NULL")
    .update({ execution: stampEffects(dbh, 'effects_started_at') })
    .returning('id');
  if (!claimed.length) return false;
  try {
    // Re-arms the reminders and sends the standard rescheduled text. After
    // hours the text is held and the confirmation sweep sends it at 8 AM.
    await (deps.reminders || require('./appointment-reminders')).handleReschedule(visitId, `${date}T${start}`, { expectSchedule: { date, windowStart: start } });
    await dbh('sms_offer_decisions').where({ id: decisionId }).update({ execution: stampEffects(dbh, 'effects_done_at') });
  } catch (err) {
    logger.error(`[sms-scheduling-act] reminder sync failed for ${visitId}: ${errorCode(err)}`);
  }
  return true;
}

const EFFECTS_MIN_AGE_MS = 2 * 60000;
const EFFECTS_LOOKBACK_MS = 24 * 3600000;

/**
 * Single moves whose notice never started (the process exited right after the
 * move committed): finish them. Runs on the offer-ledger cron, gate on or off,
 * so a kill switch never strands a customer who was already moved. A series
 * move is the series reconciler's. Never throws.
 */
async function finishMoveEffects({ now = new Date(), dbh = db, deps = {} } = {}) {
  let finished = 0;
  try {
    const nowMs = new Date(now).getTime();
    const rows = await dbh('sms_offer_decisions as d')
      .join('sms_offers as o', 'o.id', 'd.sms_offer_id')
      .where('d.execution_status', 'moved')
      .where('d.executed_at', '>=', new Date(nowMs - EFFECTS_LOOKBACK_MS))
      .where('d.executed_at', '<=', new Date(nowMs - EFFECTS_MIN_AGE_MS))
      .whereRaw("d.execution->>'effects_started_at' IS NULL")
      .whereRaw("COALESCE(d.execution->>'series', 'false') <> 'true'")
      .limit(20)
      .select('d.id', 'd.execution', 'o.scheduled_service_id');
    for (const row of rows) {
      const target = typeof row.execution === 'string' ? JSON.parse(row.execution) : (row.execution || {});
      if (!row.scheduled_service_id || !target.date || !target.start) continue;
      if (await notifySingleMove({ dbh, decisionId: row.id, visitId: row.scheduled_service_id, date: target.date, start: target.start, deps })) finished += 1;
    }
    return { finished };
  } catch (err) {
    logger.warn(`[sms-scheduling-act] effects sweep failed: ${errorCode(err)}`);
    return { finished, error: true };
  }
}

// After the commit, each effect on its own: a failed sync must not read as a
// failed move.
async function afterMove({ dbh, decisionId, svc, date, window, technicianId, result, deps }) {
  if (svc.self_booking_id) {
    try {
      // Only while the visit still holds this move's time: a newer move owns
      // the snapshot after that.
      await dbh('self_booked_appointments').where({ id: svc.self_booking_id })
        .whereExists(function stillAtTarget() {
          this.select(dbh.raw('1')).from('scheduled_services').where('scheduled_services.id', svc.id)
            .whereRaw('scheduled_services.scheduled_date = ?::date', [date])
            .whereRaw("to_char(scheduled_services.window_start, 'HH24:MI') = ?", [window.start]);
        })
        .update({ date, start_time: window.start, end_time: window.end, technician_id: technicianId || null, updated_at: dbh.fn.now() });
    } catch (err) {
      logger.warn(`[sms-scheduling-act] self-booking sync failed for ${svc.id}: ${errorCode(err)}`);
    }
  }
  if (result?.seriesMoveId) {
    // A recurring visit's date move shifted the later visits with it: the
    // shared pass owns the one series text, the reminder sync and the board,
    // and the reconciler finishes it if this process dies.
    try {
      const effects = deps.applySeriesMoveEffects || require('../routes/admin-dispatch').applySeriesMoveEffects;
      await effects({ result, serviceId: svc.id, newDate: date, newWindow: window, notify: true, actorId: null, reasonText: null });
    } catch (err) {
      logger.error(`[sms-scheduling-act] series effects failed for ${svc.id} (reconciler will retry): ${errorCode(err)}`);
    }
    return;
  }
  await notifySingleMove({ dbh, decisionId, visitId: svc.id, date, start: window.start, deps });
  try {
    await (deps.emitDispatchJobUpdate || require('./dispatch-assignment').emitDispatchJobUpdate)({ jobId: svc.id, actorId: null });
  } catch (err) {
    logger.warn(`[sms-scheduling-act] board broadcast failed for ${svc.id}: ${errorCode(err)}`);
  }
}

async function moveVisit({ dbh, decisionId, offer, slot, visit, inboundSmsLogId, repliedAt, now, deps }) {
  if (!repliedAt || new Date(now).getTime() - new Date(repliedAt).getTime() > MAX_REPLY_AGE_MS) return refusal('reply_too_old');
  const page = deps.reschedulePublic || require('../routes/reschedule-public')._internals;
  const svc = await page.loadById(offer.scheduled_service_id, dbh);
  if (!svc) return refusal('visit_missing');
  // Exactly the visit the decide step checked, or nothing.
  const same = dateOnlyString(svc.scheduled_date) === dateOnlyString(visit?.scheduled_date)
    && hhmm(svc.window_start) === hhmm(visit?.window_start) && hhmm(svc.window_end) === hhmm(visit?.window_end)
    && svc.status === visit?.status && String(svc.customer_id) === String(offer.customer_id);
  if (!same) return refusal('visit_changed');
  const eligible = await page.pageEligibility(svc, now, dbh);
  if (!eligible.ok) return refusal('not_eligible', eligible.reason);
  const config = await (deps.loadBookingConfig || require('../routes/booking')._internals.loadBookingConfig)();
  const range = page.bookingRange(config, now);
  if (slot.date < range.rangeFrom || slot.date > range.rangeTo) return refusal('outside_booking_range');
  // The link's own anti-forgery rebuild: the accepted time must be one the
  // picker offers for that day right now.
  const availability = await page.buildAvailabilityForService(svc, { rangeFrom: slot.date, rangeTo: slot.date, config });
  const open = availability?.days?.find((d) => d.date === slot.date)?.slots?.find((s) => hhmm(s.start_time) === slot.start);
  if (!open) return refusal('slot_gone');

  const window = { start: hhmm(open.start_time), end: hhmm(open.end_time) };
  const series = page.shouldReanchor(svc, slot.date);
  const target = { date: slot.date, start: window.start, end: window.end, series };
  // The link's own split: a recurring visit's date move shifts the later
  // visits with it (owner rulings 2026-07-13 and 2026-07-30); anything else
  // moves this one visit and keeps the picker's route placement.
  // The link's notice rules again under the mover's locks, on the clock as it
  // reads then: a request that waited across the cutoff is refused, as the
  // link refuses it. A missed visit is being rebooked; its own start is past.
  const notice = deps.notice || require('./scheduling/self-serve-notice');
  const beforeMove = async () => {
    if (!eligible.missed && notice.visitInsideMoveNoticeWindow(svc)) throw guardError('self_serve_notice');
    if (notice.violatesSelfServeNotice({ date: slot.date, startTime: window.start })) throw guardError('self_serve_notice');
  };
  const moveGuard = buildMoveGuard({
    decisionId, offer, visitId: svc.id, customerId: svc.customer_id, now, target, inboundSmsLogId, repliedAt,
    expected: { date: dateOnlyString(svc.scheduled_date), start: hhmm(svc.window_start), end: hhmm(svc.window_end), status: svc.status },
  });
  // Customer-facing move: the offer was built under the travel-gap rule.
  // operationKey: this decision's own, so the series mover never answers with
  // an earlier move to the same time (a replay would skip the guard).
  const shared = { technicianId: open.technician_id, sourceSurface: SOURCE_SURFACE, travelGap: true, beforeMove, moveGuard, operationKey: `sms_offer:${decisionId}` };
  const rebooker = deps.rebooker || require('./rebooker');
  let result;
  try {
    result = series
      // The series text is the shared pass's (afterMove), recorded on the move.
      ? await rebooker.rescheduleSeries(svc.id, slot.date, window, REASON_CODE, INITIATED_BY, {
        ...shared, notifyRequested: true,
        expectAnchor: { scheduled_date: svc.scheduled_date, window_start: svc.window_start },
      })
      : await rebooker.reschedule(svc.id, slot.date, window, REASON_CODE, INITIATED_BY, {
        ...shared, seriesPolicy: 'single', capacityPlacement: true,
        // visit_id pinned: a visit grouped after this read misses the pin and
        // is refused, never re-entered through the grouped mover unguarded.
        expect: {
          scheduled_date: dateOnlyString(svc.scheduled_date), window_start: svc.window_start ?? null, window_end: svc.window_end ?? null,
          status: svc.status, customer_id: svc.customer_id, visit_id: svc.visit_id ?? null,
        },
      });
  } catch (err) {
    if (err?.code === 'SMS_ACT_REFUSED') return refusal(err.refusal);
    // The mover's own refusals (slot taken under lock, the visit changed, a
    // series conflict): operational, nothing was written.
    if (err?.statusCode || err?.isOperational) return refusal('mover_refused', err.code || err.statusCode);
    throw err;
  }
  // The guard writes "moved" in the move's transaction. A mover that returned
  // without it (no path does today) is not treated as this decision's move:
  // no text is sent on an unchecked result.
  const marked = await dbh('sms_offer_decisions').where({ id: decisionId, execution_status: 'moved' }).first('id');
  if (!marked) return refusal('guard_not_run');
  await afterMove({ dbh, decisionId, svc, date: slot.date, window, technicianId: open.technician_id, result, deps });
  return { executed: true, status: 'moved', ...target, seriesMoveId: result?.seriesMoveId || null };
}

/**
 * Carry out one recorded would-move. `visit` is the visit row the decide step
 * checked; `repliedAt` is when the customer's text arrived; `now` is the
 * clock when the executor starts (after the model answered), not the
 * webhook's.
 * → { executed: true, status: 'moved', date, start, end }
 *   or { executed: false, status?, reason }. Never throws.
 */
async function executeMove({ decisionId, offer, slot, visit, inboundSmsLogId, repliedAt, now = new Date(), dbh = db, deps = {} } = {}) {
  if (!actMoveLive()) return { executed: false, reason: 'gate_off' };
  if (!decisionId || offer?.kind !== 'move_visit' || !offer.scheduled_service_id || !slot?.date || !slot?.start || !visit || !inboundSmsLogId) {
    return { executed: false, reason: 'missing_input' };
  }
  let claimed = false;
  try {
    claimed = await claimDecision(dbh, decisionId);
    if (!claimed) return { executed: false, reason: 'already_claimed' };
    const outcome = await moveVisit({ dbh, decisionId, offer, slot, visit, inboundSmsLogId, repliedAt, now, deps });
    if (!outcome.executed) await closeClaim(dbh, decisionId, 'refused', { reason: outcome.reason, detail: outcome.detail || null });
    logger.info(`[sms-scheduling-act] decision ${decisionId} → ${outcome.executed ? 'moved' : `refused (${outcome.reason})`}`);
    return outcome;
  } catch (err) {
    const code = errorCode(err);
    logger.warn(`[sms-scheduling-act] decision ${decisionId} failed: ${code}`);
    if (claimed) await closeClaim(dbh, decisionId, 'failed', { reason: code }).catch(() => {});
    return { executed: false, status: 'failed', reason: 'error' };
  }
}

module.exports = { actMoveLive, executeMove, finishMoveEffects, buildMoveGuard, INITIATED_BY, MAX_REPLY_AGE_MS };
