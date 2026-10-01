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

const EVIDENCE_UNREADABLE = Object.freeze({
  ok: false, reason: 'evidence_unreadable', message: 'Could not check whether the current reminder already went out. Try again in a minute.',
});

const OUTCOME_UNCONFIRMED = Object.freeze({
  ok: false,
  reason: 'outcome_unconfirmed',
  message: 'The current reminder may already have gone out (its delivery is unconfirmed), so its invoices were not handed back. Check it before releasing.',
});

async function release(scheduleId, { now = new Date() } = {}) {
  const schedule = await openScheduleQuery(scheduleId).first();
  if (!schedule) return { ok: false, reason: 'not_open' };
  const out = await Schedule.release(schedule, 'released_admin', now);
  if (out.reason === 'in_flight') return { ...IN_FLIGHT };
  if (out.reason === 'evidence_unreadable') return { ...EVIDENCE_UNREADABLE };
  if (out.reason === 'outcome_unconfirmed') return { ...OUTCOME_UNCONFIRMED };
  return { ok: out.closed, released: out.landed.length };
}

// Why the claim refused: the schedule, or one of its active member rows (a per-invoice send), carries a
// fresh claim (a send in flight), or the schedule is paused (a paused schedule is never claimed). The admin
// is told which rather than "nothing happened". null = neither (it closed or changed).
async function whyNotClaimable(scheduleId, now) {
  const row = await openScheduleQuery(scheduleId).first();
  if (!row) return null;
  if (Schedule.claimIsFresh(row, now)) return 'in_flight';
  if ((await Schedule.activeMemberRows(row.customer_id)).some((member) => Schedule.claimIsFresh(member, now))) return 'in_flight';
  return row.status === 'paused' ? 'schedule_paused' : null;
}

/**
 * Fires the CURRENT stage through the normal send path with operator channels. `expectedStepIndex` (the
 * step the operator confirmed): a schedule that moved on since is not claimed (409 SCHEDULE_CHANGED).
 */
async function sendNow(scheduleId, { now = new Date(), expectedStepIndex = null } = {}) {
  const out = await Runner.processSchedule(scheduleId, now, { operatorInitiated: true, force: true, expectedStepIndex });
  if (out.outcome === 'skipped' && out.reason === 'not_claimable') {
    const why = await whyNotClaimable(scheduleId, now);
    if (why === 'in_flight') return { routedTo: 'customer_schedule', scheduleId, ...IN_FLIGHT };
    if (why === 'schedule_paused') return { routedTo: 'customer_schedule', scheduleId, ...out, reason: 'schedule_paused' };
  }
  return { routedTo: 'customer_schedule', scheduleId, ...out };
}

module.exports = { pause, resume, release, sendNow };
