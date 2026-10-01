'use strict';

/**
 * Staff controls for a customer's reminder schedule (dunning consolidation
 * §8): pause / resume / release / send-now. Reached through wiring.js (the
 * POST /admin/customers/:id/dunning-schedule/* routes and the per-invoice
 * send-now routing). Each is guarded on the state it read.
 */

const db = require('../../models/db');
const Schedule = require('./schedule');
const Runner = require('./runner');
const { OPEN_STATUSES, CLAIM_TTL_MS } = require('./constants');

// One rule for every control write against a claim: while another run holds a
// FRESH claim (a send in flight) pause and release refuse and say so; resume
// clears the claim so a worker from before the pause cannot regain authority.
const IN_FLIGHT = Object.freeze({
  ok: false, reason: 'in_flight', message: 'The reminder is sending right now. Try again in a minute.',
});

const openScheduleQuery = (scheduleId) => db(Schedule.TABLE).where({ id: scheduleId }).whereIn('status', OPEN_STATUSES);

async function pause(scheduleId, { reason = 'admin_paused', adminId = null, now = new Date() } = {}) {
  const staleBefore = new Date(now.getTime() - CLAIM_TTL_MS);
  const changed = await openScheduleQuery(scheduleId).whereIn('status', ['active', 'held', 'autopay_hold'])
    .where(function unclaimedOrStale() { this.whereNull('touch_claimed_at').orWhere('touch_claimed_at', '<=', staleBefore); })
    .update({
      status: 'paused', paused_reason: String(reason), paused_by_admin_id: adminId, next_touch_at: null, updated_at: db.fn.now(),
    });
  if (Number(changed) === 1) return { ok: true };
  const row = await openScheduleQuery(scheduleId).first();
  return row && Schedule.claimIsFresh(row, now) ? { ...IN_FLIGHT } : { ok: false };
}

// A resumed schedule picks up at its current step no earlier than the next
// run (the same floor a held step uses), never sending in the click itself.
async function resume(scheduleId, { now = new Date() } = {}) {
  const changed = await db(Schedule.TABLE).where({ id: scheduleId, status: 'paused' }).update({
    status: 'active', next_touch_at: require('../invoice-followups').heldTouchFloor(now), paused_reason: null,
    touch_claimed_at: null, paused_by_admin_id: null, held_reason: null, held_since: null, hold_alerted_at: null, updated_at: db.fn.now(),
  });
  return { ok: Number(changed) === 1 };
}

async function release(scheduleId, { now = new Date() } = {}) {
  const schedule = await openScheduleQuery(scheduleId).first();
  if (!schedule) return { ok: false, reason: 'not_open' };
  const out = await Schedule.release(schedule, 'released_admin', now);
  if (out.reason === 'in_flight') return { ...IN_FLIGHT };
  return { ok: out.closed, released: out.landed.length };
}

// The claim refuses while the schedule, or one of its active member rows (a per-invoice send), carries a
// fresh claim: that is a send in flight, and the admin is told so rather than "nothing happened".
async function claimInFlight(scheduleId, now) {
  const row = await openScheduleQuery(scheduleId).first();
  if (!row) return false;
  if (Schedule.claimIsFresh(row, now)) return true;
  return (await Schedule.activeMemberRows(row.customer_id)).some((member) => Schedule.claimIsFresh(member, now));
}

/** Fires the CURRENT stage through the normal send path with operator channels. */
async function sendNow(scheduleId, { now = new Date() } = {}) {
  const out = await Runner.processSchedule(scheduleId, now, { operatorInitiated: true, force: true });
  if (out.outcome === 'skipped' && out.reason === 'not_claimable' && await claimInFlight(scheduleId, now)) {
    return { routedTo: 'customer_schedule', scheduleId, ...IN_FLIGHT };
  }
  return { routedTo: 'customer_schedule', scheduleId, ...out };
}

module.exports = { pause, resume, release, sendNow };
