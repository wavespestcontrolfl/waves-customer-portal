'use strict';

/**
 * Staff controls for a customer's reminder schedule (dunning consolidation
 * §8): pause / resume / release / send-now. PR 2: nothing routes to these yet
 * (the routes and the send-now routing are PR 3); they are complete and tested
 * directly. Each is guarded on the state it read.
 */

const db = require('../../models/db');
const Schedule = require('./schedule');
const Runner = require('./runner');
const { OPEN_STATUSES } = require('./constants');

const openScheduleQuery = (database, scheduleId) => database(Schedule.TABLE).where({ id: scheduleId }).whereIn('status', OPEN_STATUSES);

async function pause(scheduleId, { reason = 'admin_paused', adminId = null, database = db } = {}) {
  const changed = await openScheduleQuery(database, scheduleId).whereIn('status', ['active', 'held', 'autopay_hold']).update({
    status: 'paused', paused_reason: String(reason), paused_by_admin_id: adminId, next_touch_at: null, updated_at: database.fn.now(),
  });
  return { ok: Number(changed) === 1 };
}

// A resumed schedule picks up at its current step no earlier than the next
// run (the same floor a held step uses), never sending in the click itself.
async function resume(scheduleId, { now = new Date(), database = db } = {}) {
  const changed = await database(Schedule.TABLE).where({ id: scheduleId, status: 'paused' }).update({
    status: 'active', next_touch_at: require('../invoice-followups').heldTouchFloor(now), paused_reason: null,
    paused_by_admin_id: null, held_reason: null, held_since: null, hold_alerted_at: null, updated_at: database.fn.now(),
  });
  return { ok: Number(changed) === 1 };
}

async function release(scheduleId, { now = new Date(), database = db } = {}) {
  const schedule = await openScheduleQuery(database, scheduleId).first();
  if (!schedule) return { ok: false, reason: 'not_open' };
  const out = await Schedule.release(schedule, 'released_admin', now, { database });
  return { ok: out.closed, released: out.landed.length };
}

/** Fires the CURRENT stage through the normal send path with operator channels. */
async function sendNow(scheduleId, { now = new Date(), database = db } = {}) {
  const out = await Runner.processSchedule(scheduleId, now, { database, operatorInitiated: true, force: true });
  return { routedTo: 'customer_schedule', scheduleId, ...out };
}

module.exports = { pause, resume, release, sendNow };
