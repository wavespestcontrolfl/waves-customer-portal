'use strict';

/**
 * The live wiring of the customer-level reminder engine (dunning consolidation
 * PR 3, plan §4 / §8 / §9): the kill switch runPending runs before its
 * per-invoice batch, the gate an office send-now must pass, and the
 * per-customer controls behind POST /admin/customers/:id/dunning-schedule/*.
 *
 * The gate readers are read at call time (feature-gates.js): the live gate
 * (GATE_DUNNING_CUSTOMER_SCHEDULE plus its prerequisites, GATE_DUNNING_LADDER_90
 * and the pay-page balance gate) and the canary allowlist. A schedule the live
 * gate does not reach is DARK: nothing would ever send from it, and its
 * per-invoice members stay owned (runPending's batch skips them), so the kill
 * switch hands it back (§7 release: every surviving member re-lands on its own
 * ladder, no step repeated).
 */

const db = require('../../models/db');
const logger = require('../logger');
const { redactContact } = require('../../utils/redact-contact');
const { etDateString } = require('../../utils/datetime-et');
const FeatureGates = require('../../config/feature-gates');
const { OPEN_STATUSES } = require('./constants');
const Schedule = require('./schedule');
const Admin = require('./admin');

/** The live engine covers this customer: the gate and its prerequisites are on, and the allowlist (if any) names them. */
function liveForCustomer(customerId) {
  if (!FeatureGates.dunningCustomerScheduleLive()) return false;
  const allow = FeatureGates.dunningCustomerScheduleAllowlist();
  return !allow || allow.has(String(customerId).toLowerCase());
}

/**
 * Why a customer's schedule is dark now, or null when the live engine covers it. A prerequisite off is
 * named first (with it off the engine cannot run whatever the gate says); otherwise the gate is off, or
 * the customer is outside the canary allowlist (the live gate does not reach them either).
 */
function darkReason(customerId) {
  if (FeatureGates.dunningCustomerScheduleLive()) return liveForCustomer(customerId) ? null : 'released_gate_off';
  return FeatureGates.dunningCustomerSchedulePrereqsLive() ? 'released_gate_off' : 'released_prereq_off';
}

// A failed release leaves the customer's invoices owned by a schedule nothing runs: no reminder at all
// until a person looks. Always raised (Billing, needs-you, person) through raiseAdminAlert.
function alertReleaseFailed({ customerId = null, dedupeKey }) {
  return Schedule.alertStaff({
    verb: 'restart overdue reminders',
    generic: customerId ? 'restart a customer\'s overdue reminders' : 'check combined overdue reminders',
    why: customerId
      ? 'Combined reminders are off but could not hand their invoices back, so they get no overdue reminders.'
      : 'Combined reminders are off but the open schedules could not be read, so some customers get no reminders.',
    doneWhen: 'reminders_restarted',
    dedupeKey,
    customerId,
    subject: customerId ? null : { type: 'check', id: 'customer-dunning-kill-switch' },
  });
}

/**
 * KILL SWITCH (§9.4), run by runPending BEFORE its per-invoice batch: every open schedule that is dark is
 * released (closed_reason released_gate_off / released_prereq_off; members re-land through
 * releaseMembers, dated no earlier than the next run, so none sends today). Gate on with no allowlist
 * reads nothing. Never throws: a read or release failure is logged and raised to the office, and the
 * per-invoice run goes on. A schedule with a send in flight (a fresh claim) is left for the next run.
 */
async function releaseIfDark(now = new Date()) {
  const tally = { released: 0, inFlight: 0, failed: 0 };
  if (FeatureGates.dunningCustomerScheduleLive() && !FeatureGates.dunningCustomerScheduleAllowlist()) return tally;
  let open;
  try {
    open = await db(Schedule.TABLE).whereIn('status', OPEN_STATUSES).orderBy('created_at', 'asc').select('*');
  } catch (err) {
    tally.failed += 1;
    logger.error(`[customer-dunning] kill switch could not read open schedules: ${redactContact(err.message)}`);
    await alertReleaseFailed({ dedupeKey: `customer-dunning-release-failed:read:${etDateString(now)}` });
    return tally;
  }
  for (const schedule of open) {
    const reason = darkReason(schedule.customer_id);
    if (reason) await releaseOne(schedule, reason, now, tally);
  }
  if (tally.released || tally.inFlight || tally.failed) {
    logger.info(`[customer-dunning] kill switch: released=${tally.released} in_flight=${tally.inFlight} failed=${tally.failed}`);
  }
  return tally;
}

async function releaseOne(schedule, reason, now, tally) {
  try {
    const out = await Schedule.release(schedule, reason, now);
    if (out.closed) {
      tally.released += 1;
      logger.info(`[customer-dunning] schedule ${schedule.id} (customer ${schedule.customer_id}) released: ${reason}`);
    } else if (out.reason === 'in_flight') {
      tally.inFlight += 1;
      logger.warn(`[customer-dunning] schedule ${schedule.id} not released (${reason}): a send is in flight; the next run releases it`);
    }
  } catch (err) {
    tally.failed += 1;
    logger.error(`[customer-dunning] kill switch could not release schedule ${schedule.id} (${reason}): ${redactContact(err.message)}`);
    await alertReleaseFailed({ customerId: schedule.customer_id, dedupeKey: `customer-dunning-release-failed:${schedule.id}` });
  }
}

const NOT_LIVE = Object.freeze({
  ok: false,
  reason: 'schedule_not_live',
  message: 'Combined reminders are off for this customer; their invoices go back to single reminders at the next run.',
});

/**
 * An office send-now for a customer on a schedule (the invoice follow-up send-now routes here when the
 * customer is owned): the schedule's CURRENT step through the normal send path with operator channels,
 * only while the live gate covers the customer. Never sends for a dark schedule.
 */
async function sendNowForSchedule(scheduleId, customerId, { now = new Date() } = {}) {
  if (!liveForCustomer(customerId)) return { routedTo: 'customer_schedule', scheduleId, ...NOT_LIVE };
  return Admin.sendNow(scheduleId, { now });
}

const CONTROLS = Object.freeze({
  'send-now': (schedule, opts) => sendNowForSchedule(schedule.id, schedule.customer_id, opts),
  pause: (schedule, opts) => Admin.pause(schedule.id, { reason: opts.reason || 'admin_paused', adminId: opts.adminId, now: opts.now }),
  resume: (schedule, opts) => Admin.resume(schedule.id, { now: opts.now }),
  release: (schedule, opts) => Admin.release(schedule.id, { now: opts.now }),
});

const SCHEDULE_CHANGED = 'The reminder schedule changed. Reload and try again.';
const NO_OPEN_SCHEDULE = Object.freeze({ status: 404, body: { error: 'This customer has no open reminder schedule.', code: 'NO_OPEN_SCHEDULE' } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * HTTP shape of a control's result, shared by the customer routes and the invoice send-now route. A send
 * in flight (Admin's IN_FLIGHT, whose message is the copy the office reads) and a dark schedule are 409s
 * with that message; a control whose guarded write matched nothing (`ok: false`), a send-now that could
 * not claim (`skipped`) or lost its claim mid-run (`stale`) is a 409 "changed"; anything else — sent,
 * held, paused, closed — is what happened, 200.
 */
function httpResult(out) {
  if (out?.reason === 'in_flight' || out?.reason === 'schedule_not_live') {
    return { status: 409, body: { error: out.message, code: out.reason === 'in_flight' ? 'IN_FLIGHT' : 'SCHEDULE_NOT_LIVE', scheduleId: out.scheduleId } };
  }
  if (out?.ok === false || out?.outcome === 'skipped' || out?.outcome === 'stale') {
    return { status: 409, body: { error: SCHEDULE_CHANGED, code: 'SCHEDULE_CHANGED', scheduleId: out.scheduleId } };
  }
  return { status: 200, body: out };
}

/** One staff control on the customer's OPEN schedule. Returns { status, body }. */
async function controlCustomerSchedule(customerId, control, { adminId = null, reason = null, now = new Date() } = {}) {
  const run = CONTROLS[control];
  if (!run) return { status: 404, body: { error: 'Unknown control', code: 'UNKNOWN_CONTROL' } };
  // A non-uuid id can never own a schedule row (and would be a uuid cast error, not a 500, to the office).
  if (!UUID.test(String(customerId || ''))) return NO_OPEN_SCHEDULE;
  const schedule = await Schedule.openScheduleFor(customerId);
  if (!schedule) return NO_OPEN_SCHEDULE;
  const out = await run(schedule, { adminId, reason, now });
  return httpResult({ scheduleId: schedule.id, ...out });
}

module.exports = {
  liveForCustomer,
  darkReason,
  releaseIfDark,
  sendNowForSchedule,
  controlCustomerSchedule,
  httpResult,
};
