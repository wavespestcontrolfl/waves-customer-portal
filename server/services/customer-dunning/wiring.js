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
const Runner = require('./runner');
const BalanceSet = require('./balance-set');

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

// Whether the last successful kill-switch read in this process found open schedules. With the live gate
// dark, schedules exist only if it was on before (promotion runs under the live gate alone), so a failed
// read alerts the office only when the engine is reachable (the live gate on, here always with an
// allowlist) or this process has seen schedules to release; otherwise it is only logged. That keeps the
// switch at zero office alerts while the gate is dark and the table empty (production today). A failure
// that persists is not hidden by it: the per-invoice batch reads the same table in its ownership predicate
// and fails loudly on its own.
let lastReadSawOpen = false;

/**
 * KILL SWITCH (§9.4), run by runPending BEFORE its per-invoice batch: every open schedule that is dark is
 * released (closed_reason released_gate_off / released_prereq_off; members re-land through
 * releaseMembers, dated no earlier than the next run, so none sends today). Gate on with no allowlist
 * reads nothing. Never throws: a read or release failure is logged (and raised to the office when the
 * engine is reachable, see lastReadSawOpen), and the per-invoice run goes on. A schedule with a send in
 * flight (a fresh claim) is left for the next run. Under the shadow gate (live gate off), a dark schedule
 * shadowRun would judge gets its full shadow verdict logged first: released, it never reaches that scan.
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
    if (FeatureGates.dunningCustomerScheduleLive() || lastReadSawOpen) {
      await alertReleaseFailed({ dedupeKey: `customer-dunning-release-failed:read:${etDateString(now)}` });
    }
    return tally;
  }
  lastReadSawOpen = open.length > 0;
  const shadowFirst = FeatureGates.dunningCustomerScheduleShadowLive() && !FeatureGates.dunningCustomerScheduleLive();
  for (const schedule of open) {
    const reason = darkReason(schedule.customer_id);
    if (!reason) continue;
    if (shadowFirst) await Runner.shadowVerdictBeforeRelease(schedule, now);
    await releaseOne(schedule, reason, now, tally);
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
    } else if (out.reason === 'evidence_unreadable' || out.reason === 'outcome_unconfirmed') {
      // Nothing was handed back (the current step's delivery could not be read, or a leg's outcome is
      // unconfirmed and handing back could send it again): the office hears of it.
      tally.failed += 1;
      logger.error(`[customer-dunning] kill switch did not release schedule ${schedule.id} (${reason}): ${out.reason}`);
      await alertReleaseFailed({ customerId: schedule.customer_id, dedupeKey: `customer-dunning-release-failed:${schedule.id}` });
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
 * only while the live gate covers the customer. Never sends for a dark schedule. `expectedStepIndex`: the
 * step the operator confirmed; a schedule that moved on since sends nothing (SCHEDULE_CHANGED).
 */
async function sendNowForSchedule(scheduleId, customerId, { now = new Date(), expectedStepIndex = null } = {}) {
  if (!liveForCustomer(customerId)) return { routedTo: 'customer_schedule', scheduleId, ...NOT_LIVE };
  return Admin.sendNow(scheduleId, { now, expectedStepIndex });
}

// The invoice panel's send-now for a customer on combined reminders sends the COMBINED step, so it needs the
// operator's confirmation of that step (Codex #5503 r2 P1: a panel showing the invoice's own "Day 14" sent
// the schedule's "Day 60" across every invoice). Without it, or for another schedule, nothing is sent.
const COMBINED_CONFIRM_REQUIRED = Object.freeze({
  ok: false,
  reason: 'combined_confirm_required',
  message: 'This customer is on combined reminders. Reload to see the combined step before sending.',
});
// The operator confirmed a combined step, but the customer is no longer on combined reminders: the
// invoice's own next step is a different message, so it is not sent in its place.
const COMBINED_SCHEDULE_CLOSED = Object.freeze({
  ok: false,
  reason: 'combined_schedule_closed',
  message: 'This customer is no longer on combined reminders. Reload to see this invoice\'s next step before sending.',
});

/**
 * The invoice send-now's routing for an OWNED invoice (invoice-followups.js sendNextTouchNow). `confirmed`
 * = { scheduleId, stepIndex } from the request (the combined step the panel showed), or null.
 */
function sendNowForInvoiceOnSchedule(scheduleId, customerId, confirmed, { now = new Date() } = {}) {
  if (!confirmed || String(confirmed.scheduleId) !== String(scheduleId) || !Number.isInteger(confirmed.stepIndex)) {
    return { routedTo: 'customer_schedule', scheduleId, ...COMBINED_CONFIRM_REQUIRED };
  }
  return sendNowForSchedule(scheduleId, customerId, { now, expectedStepIndex: confirmed.stepIndex });
}

/** The send-now answer for a confirmed combined step whose customer has no open schedule any more. */
const combinedScheduleClosed = (scheduleId) => ({ routedTo: 'customer_schedule', scheduleId, ...COMBINED_SCHEDULE_CLOSED });

// How long the panel's GET waits for the invoice count before showing the step without it.
const SUMMARY_COUNT_TIMEOUT_MS = 4000;

/**
 * How many invoices a combined send would cover right now: the members of the set the send itself resolves
 * (resolveDunnableSet, the pay page's own authority, so quiet members with a completed or absent sequence
 * count too), never the active sequence rows alone (Codex local review P2: 2 active + 1 sequence-less read
 * "all 2 invoices" while the message and pay link covered 3). Read-only. null when the set cannot be read
 * in time or names nothing (a hold that could not resolve the balance, nothing open): the panel then says
 * "all invoices on their balance" rather than a number that may be wrong.
 */
async function combinedCoverage(customerId, { now = new Date(), timeoutMs = SUMMARY_COUNT_TIMEOUT_MS } = {}) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref?.();
  });
  try {
    const set = await Promise.race([BalanceSet.resolveDunnableSet(customerId, { now }), timeout]);
    const invoiceIds = Array.isArray(set?.members) ? set.members.map((m) => String(m.invoice_id)) : [];
    return { count: invoiceIds.length > 0 ? invoiceIds.length : null, invoiceIds };
  } catch (err) {
    logger.warn(`[customer-dunning] invoice count for customer ${customerId} unreadable: ${redactContact(err.message)}`);
    return { count: null, invoiceIds: [] };
  } finally {
    clearTimeout(timer);
  }
}

// Why a paused schedule is paused, as the panel says it before anyone presses Resume: what the office
// typed (a staff pause), or the engine's own reason in plain English (no way to reach them, archived...).
function pausedReasonOf(schedule) {
  if (schedule.status !== 'paused') return { pausedBy: null, pausedReason: null };
  const reason = String(schedule.paused_reason || '').trim();
  if (schedule.paused_by_admin_id || reason === 'admin_paused') {
    return { pausedBy: 'staff', pausedReason: reason && reason !== 'admin_paused' ? reason : null };
  }
  return { pausedBy: 'system', pausedReason: Schedule.reasonText(reason) };
}

/**
 * What the invoice panel shows (GET /api/admin/invoices/:id/followup) for a customer on combined
 * reminders: the open schedule, the human name of its current step and how many invoices a send would
 * cover (null when it cannot be read). null when the customer has no open schedule.
 *
 * `controllable`: the live gate covers this customer now. A schedule can stay open for a while after the
 * gate, a prerequisite or the allowlist turns off (until the next run releases it); the panel offers no
 * pause / resume then, and controlCustomerSchedule refuses them (a pause pressed in that window would be
 * carried onto every per-invoice reminder by the release).
 *
 * `coveringInvoiceId`: asked on behalf of an invoice with no reminder row of its own. Answered only when
 * the combined balance really names that invoice (a paid or excluded invoice of the same customer, or a
 * balance that cannot be read, gets null: the panel says nothing rather than something wrong).
 */
async function customerScheduleSummary(customerId, { now = new Date(), countTimeoutMs, coveringInvoiceId = null } = {}) {
  if (!UUID.test(String(customerId || ''))) return null;
  const schedule = await Schedule.openScheduleFor(customerId);
  if (!schedule) return null;
  const coverage = await combinedCoverage(customerId, { now, timeoutMs: countTimeoutMs });
  if (coveringInvoiceId && !coverage.invoiceIds.includes(String(coveringInvoiceId))) return null;
  const stepIndex = Number(schedule.step_index);
  return {
    id: schedule.id,
    // The panel's pause / resume buttons post to the customer's own schedule routes.
    customerId: schedule.customer_id,
    status: schedule.status,
    stepIndex,
    stepLabel: Schedule.STEPS[stepIndex]?.label || null,
    invoiceCount: coverage.count,
    nextTouchAt: schedule.next_touch_at || null,
    controllable: liveForCustomer(schedule.customer_id),
    ...pausedReasonOf(schedule),
  };
}

/** The same summary for an invoice with NO reminder row of its own that the combined balance covers. */
async function customerScheduleSummaryForInvoice(invoiceId, opts = {}) {
  if (!UUID.test(String(invoiceId || ''))) return null;
  const invoice = await db('invoices').where({ id: invoiceId }).first('customer_id');
  if (!invoice?.customer_id) return null;
  return customerScheduleSummary(invoice.customer_id, { ...opts, coveringInvoiceId: invoiceId });
}

const CONTROLS = Object.freeze({
  'send-now': (schedule, opts) => sendNowForSchedule(schedule.id, schedule.customer_id, opts),
  pause: (schedule, opts) => Admin.pause(schedule.id, { reason: opts.reason || 'admin_paused', adminId: opts.adminId, now: opts.now }),
  resume: (schedule, opts) => Admin.resume(schedule.id, { now: opts.now }),
  release: (schedule, opts) => Admin.release(schedule.id, { now: opts.now }),
});

const GATED_CONTROLS = new Set(['pause', 'resume']);

const SCHEDULE_CHANGED = 'The reminder schedule changed. Reload and try again.';
const NO_OPEN_SCHEDULE = Object.freeze({ status: 404, body: { error: 'This customer has no open reminder schedule.', code: 'NO_OPEN_SCHEDULE' } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Refusals whose own message is the copy the office reads.
const CONFLICT_CODES = Object.freeze({
  in_flight: 'IN_FLIGHT', schedule_not_live: 'SCHEDULE_NOT_LIVE', evidence_unreadable: 'EVIDENCE_UNREADABLE', outcome_unconfirmed: 'OUTCOME_UNCONFIRMED',
  combined_confirm_required: 'COMBINED_CONFIRM_REQUIRED', combined_schedule_closed: 'COMBINED_SCHEDULE_CLOSED',
});

// A send-now that reached the customer: the step went out (advanced / completed), or one leg did and the
// other retries (told). A settle of a step delivered earlier (`recovered`) also lands here: that step
// did reach the customer. Every other outcome sent nothing.
const SENT_OUTCOMES = new Set(['advanced', 'completed', 'told']);

// Reason codes a send-now can stop on that the alert copy (Schedule.reasonText) does not name.
const NOT_SENT_REASON_TEXT = Object.freeze({
  COLLECTIONS_POLICY: 'the collections contact rules do not allow a reminder now',
  REMINDER_OUTCOME_UNCONFIRMED: 'an earlier attempt is still unconfirmed',
  prefs_unreadable: 'their contact preferences could not be read',
  progress_unreadable: 'earlier reminders could not be read back',
  autopay_unreadable: 'their autopay status could not be read',
  balance_cleared: 'their balance is paid',
  no_active_member: 'no invoice is left to remind',
});
const notSentReason = (reason) => NOT_SENT_REASON_TEXT[reason] || Schedule.reasonText(reason);

// Plain-English "Not sent" copy per outcome (the reason code never reaches the office).
function notSentMessage(out) {
  if (out.reason === 'schedule_paused') return 'Not sent: this customer\'s combined reminders are paused.';
  switch (out.outcome) {
    case 'held': return `Not sent: reminders are on hold (${notSentReason(out.reason)}).`;
    case 'paused': return `Not sent: reminders were paused (${notSentReason(out.reason)}).`;
    case 'autopay_hold': return 'Not sent: the customer is on autopay, so reminders are on hold.';
    case 'closed': return `Not sent: the reminder schedule closed (${notSentReason(out.reason)}).`;
    default: return 'Not sent.';
  }
}

/**
 * HTTP shape of a control's result, shared by the customer routes and the invoice send-now route. A send
 * in flight (Admin's IN_FLIGHT, whose message is the copy the office reads), a dark schedule and a release
 * whose delivery evidence could not be read are 409s with that message; a paused schedule's send-now and
 * any send-now outcome that sent nothing (held, paused, autopay hold, closed) are a 409 NOT_SENT with a
 * plain-English reason; a control whose guarded write matched nothing (`ok: false`), a send-now that could
 * not claim (`skipped`) or lost its claim mid-run (`stale`) is a 409 "changed". Only a send that reached
 * the customer, and a control that did what it said (pause, resume, release), is a 200.
 */
function httpResult(out) {
  if (CONFLICT_CODES[out?.reason]) {
    const code = CONFLICT_CODES[out.reason];
    return { status: 409, body: { error: out.message, code, scheduleId: out.scheduleId } };
  }
  if (out?.reason === 'schedule_paused' || (out?.outcome && !SENT_OUTCOMES.has(out.outcome) && out.outcome !== 'skipped' && out.outcome !== 'stale')) {
    return { status: 409, body: { error: notSentMessage(out), code: 'NOT_SENT', outcome: out.outcome, scheduleId: out.scheduleId } };
  }
  if (out?.ok === false || out?.outcome === 'skipped' || out?.outcome === 'stale') {
    return { status: 409, body: { error: SCHEDULE_CHANGED, code: 'SCHEDULE_CHANGED', scheduleId: out.scheduleId } };
  }
  return { status: 200, body: out };
}

const CONTROL_LABELS = Object.freeze({
  'send-now': 'Send now', pause: 'Pause', resume: 'Resume', release: 'Release',
});

/**
 * Who pressed which combined-reminder control, when, and what happened (owner 10-01: every press of
 * send-now / pause / resume / release is on the customer's activity log). One activity_log row per press
 * that reached a schedule, refusals included. Best effort: a failed write is logged, never fails the press.
 */
async function recordStaffControl({ customerId, control, adminId = null, reason = null, result, via = 'customer' }) {
  const label = CONTROL_LABELS[control] || control;
  const ok = result?.status === 200;
  const body = result?.body || {};
  const what = ok ? 'done' : `not done: ${String(body.error || 'refused').replace(/\.$/, '')}`;
  const why = control === 'pause' && reason ? ` Reason: ${String(reason).slice(0, 200)}` : '';
  try {
    await db('activity_log').insert({
      customer_id: customerId,
      admin_user_id: UUID.test(String(adminId || '')) ? adminId : null,
      action: `combined_reminders_${control.replace('-', '_')}`,
      description: `Combined overdue reminders: ${label} pressed — ${what}.${why}`,
      metadata: JSON.stringify({
        control, via, scheduleId: body.scheduleId || null, httpStatus: result?.status ?? null,
        code: body.code || null, outcome: body.outcome || null,
      }),
    });
  } catch (err) {
    logger.warn(`[customer-dunning] staff control activity_log insert failed (customer ${customerId}, ${control}): ${redactContact(err.message)}`);
  }
}

/** One staff control on the customer's OPEN schedule. Returns { status, body }. Every press that reaches a schedule is recorded. */
async function controlCustomerSchedule(customerId, control, { adminId = null, reason = null, now = new Date() } = {}) {
  const run = CONTROLS[control];
  if (!run) return { status: 404, body: { error: 'Unknown control', code: 'UNKNOWN_CONTROL' } };
  // A non-uuid id can never own a schedule row (and would be a uuid cast error, not a 500, to the office).
  if (!UUID.test(String(customerId || ''))) return NO_OPEN_SCHEDULE;
  const schedule = await Schedule.openScheduleFor(customerId);
  if (!schedule) return NO_OPEN_SCHEDULE;
  // Pause and resume only while the live gate covers the customer (send-now checks this itself). A dark
  // schedule is about to be released; a pause pressed now would land on every per-invoice reminder.
  // Release is never refused here: it is how a dark schedule is cleared by hand.
  const dark = GATED_CONTROLS.has(control) && !liveForCustomer(customerId);
  const out = dark ? { ...NOT_LIVE } : await run(schedule, { adminId, reason, now });
  const result = httpResult({ scheduleId: schedule.id, ...out });
  await recordStaffControl({ customerId, control, adminId, reason, result });
  return result;
}

module.exports = {
  liveForCustomer,
  darkReason,
  releaseIfDark,
  sendNowForSchedule,
  sendNowForInvoiceOnSchedule,
  combinedScheduleClosed,
  customerScheduleSummary,
  customerScheduleSummaryForInvoice,
  controlCustomerSchedule,
  recordStaffControl,
  httpResult,
  _test: { resetReadMemory: () => { lastReadSawOpen = false; } },
};
