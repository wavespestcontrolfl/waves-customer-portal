'use strict';

// GATE_NEW_CALLER_BOOKING, the timed bells for a visit the office booked by
// address that still has no customer (owner plan 2026-10-25, D4 b and c, D9).
// The agent's link step rings right after its pass (D4a,
// new-caller-link-from-call.js). This sweep rings what no pass reports, on
// that same row (key new-caller-visit:<id>), which a link closes:
//  - no call was picked at Book: nothing will link the visit;
//  - (b) the call ended 90 minutes ago and its recording is not processed;
//  - a finished pass left the visit unlinked and no bell was written (a
//    voicemail or spam verdict ends the pass before the link step, the gate
//    was off then, or the raise failed);
//  - (c) the visit starts within a day: the row rings once more, unless its
//    last ring was already inside that day (D9: the visit stays on the
//    route, and the office links it).
// A call still in its first 90 minutes waits for its own pass. Every ten
// minutes from the scheduler.

const db = require('../../models/db');
const { isEnabled } = require('../../config/feature-gates');
const logger = require('../logger');
const { etDateString, addETDays, parseETDateTime, dateOnlyString } = require('../../utils/datetime-et');
const { callEndedAt } = require('../../utils/call-timeline');
const { whereNotSandboxCall } = require('../voice-agent/relay-protocol');
const { raiseAdminAlert } = require('../admin-alert-compose');
const {
  NEW_CALLER_SOURCE_ACTION, newCallerVisitAlertKey, newCallerVisitLink, slotWords, bookedSlot, raiseWhileVisitWaits,
} = require('./new-caller-visit');

const NO_RECORDING_MS = 90 * 60 * 1000;
const SOON_MS = 24 * 60 * 60 * 1000;
// The sweep reads every waiting visit, a page at a time; the bell cap stops
// the rings in one run, never the reading, so a backlog rings over ticks.
const PAGE_SIZE = 100;
const MAX_ALERTS_PER_RUN = 10;

const WHY = {
  no_call: 'No call was picked when this visit was booked, so nothing links it; it has no reminders or confirmation yet.',
  not_processed: 'The call recording is not processed after 90 minutes, so the visit has no reminders or confirmation yet.',
  processed: 'The call recording did not link the visit to a customer, so it has no reminders or confirmation yet.',
  soon: 'The visit starts within a day and still has no customer, so no reminder or confirmation goes out.',
};
const DETAIL = {
  no_call: 'The office booked this visit by address with no live call picked, so the call recording cannot link it.',
  not_processed: 'The call recording is not processed yet, so the agent has not linked the visit. It may still come in.',
  processed: 'The call recording was processed, but the visit was not linked to a customer.',
  soon: 'The visit is on the route, but with no customer it gets no reminder and no confirmation, and it cannot be completed or invoiced.',
};

const visitStart = (visit) => {
  const { date, time } = bookedSlot(visit);
  return parseETDateTime(`${date}T${time || '08:00'}`).getTime();
};

// Why the visit's bell is due now, or null while the call's own pass may
// still link it. A pass is done at a finished status (the processor's own
// set) or a creation failure, which it writes after the link step. Within a
// day of the visit, a due bell says so.
function stageOf(visit, call, nowMs, completedStatuses) {
  const status = call?.processing_status;
  let stage = null;
  if (!call) stage = 'no_call';
  else if (completedStatuses.has(status) || status === 'customer_creation_failed' || status === 'lead_creation_failed') stage = 'processed';
  else {
    const ended = callEndedAt(call) || new Date(call.created_at);
    if (nowMs - ended.getTime() >= NO_RECORDING_MS) stage = 'not_processed';
  }
  if (!stage) return null;
  return visitStart(visit) - nowMs <= SOON_MS ? 'soon' : stage;
}

// The sweep's list is a snapshot: the bell is written only while the visit
// still waits (raiseWhileVisitWaits), so a link that lands after the list
// was read never gets a new or reopened bell.
async function ringVisit(conn, visit, stage) {
  const { day } = slotWords(bookedSlot(visit).date, '');
  // The day-before ring: a row whose last ring came before the visit's final
  // day rings again; one already rung inside it only takes the new words.
  const finalDayFrom = visitStart(visit) - SOON_MS;
  const soon = stage === 'soon'
    ? { refreshOnDedupe: true, ringOnRefresh: (existing, meta) => new Date(meta?.rungAt || existing.created_at).getTime() < finalDayFrom }
    : {};
  return raiseWhileVisitWaits(conn, visit.id, (trx) => raiseAdminAlert('schedule', {
    area: 'Schedule',
    action: day ? `link the new caller's visit on ${day}` : "link the new caller's visit",
    why: WHY[stage],
    severity: 'needs-you',
    link: newCallerVisitLink(visit),
    subject: { type: 'visit', id: String(visit.id) },
    doneWhen: 'visit_linked',
    who: 'person',
  }, {
    trx,
    dedupeKey: newCallerVisitAlertKey(visit.id),
    bellDefault: true,
    ...soon,
    detail: `${DETAIL[stage]}\nOpen the visit on Dispatch and use Link customer. The reminders and the confirmation go out then.`,
    metadata: { scheduled_service_id: visit.id, call_log_id: visit.source_call_log_id || null, stage },
  }));
}

/**
 * Scheduler entry point. Returns { skipped } with the gate off, else
 * { waiting, due, rung }: visits that still wait for a customer, bells due,
 * bells that rang (a new row, or the day-before ring).
 */
async function runNewCallerVisitBells({ now = new Date(), conn = db } = {}) {
  if (!isEnabled('newCallerBooking')) return { skipped: 'disabled' };
  const completedStatuses = require('../call-recording-processor').COMPLETED_STATUSES;
  // A visit whose day has passed keeps the bell it has; the sweep starts at yesterday.
  const fromDate = etDateString(addETDays(now, -1));
  const result = { waiting: 0, due: 0, rung: 0 };
  let after = null;
  for (;;) {
    // Keyset pages in (date, id) order, after the last visit of the page before.
    const visits = await conn('scheduled_services')
      .where({ source_action: NEW_CALLER_SOURCE_ACTION })
      .whereNull('customer_id')
      .whereNull('parent_service_id')
      .whereNotIn('status', ['cancelled', 'rescheduled'])
      .where('scheduled_date', '>=', fromDate)
      .modify((q) => after && q.whereRaw('(scheduled_date, id) > (?::date, ?::uuid)', [dateOnlyString(after.scheduled_date), after.id]))
      .orderBy([{ column: 'scheduled_date' }, { column: 'id' }])
      .limit(PAGE_SIZE)
      .select('id', 'scheduled_date', 'window_start', 'source_call_log_id');
    result.waiting += visits.length;
    const callIds = [...new Set(visits.map((v) => v.source_call_log_id).filter(Boolean))];
    const calls = callIds.length
      ? await conn('call_log').whereIn('id', callIds).modify((q) => whereNotSandboxCall(q))
        .select('id', 'processing_status', 'created_at', 'metadata', 'duration_seconds', 'recording_duration_seconds')
      : [];
    const callById = new Map(calls.map((c) => [String(c.id), c]));
    for (const visit of visits) {
      const stage = stageOf(visit, callById.get(String(visit.source_call_log_id)) || null, now.getTime(), completedStatuses);
      if (!stage) continue;
      result.due += 1;
      if (result.rung >= MAX_ALERTS_PER_RUN) continue;
      try {
        const { raised } = await ringVisit(conn, visit, stage);
        if (raised && !raised.suppressed && (!raised.deduped || raised.rung)) result.rung += 1;
      } catch (err) {
        logger.warn(`[new-caller-bells] bell for visit ${visit.id} failed: ${err.code || err.name || 'error'}`);
      }
    }
    if (visits.length < PAGE_SIZE) return result;
    after = visits[visits.length - 1];
  }
}

module.exports = { runNewCallerVisitBells, _private: { stageOf, ringVisit, WHY } };
