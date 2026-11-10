/**
 * Payroll pay rate steps (owner 2026-11-05: the first technician starts at $23.00 an hour, then $25
 * automatically in the first full pay week after day 90).
 *
 * An admin records a future hourly rate and the Monday it starts (payroll_rate_steps). On that Monday
 * the portal changes technicians.pay_rate by itself: applyDueSteps() runs from a daily job and at the
 * start of every pay run draft, recompute and finalize. It stores the rate it replaces as previous_rate,
 * so a pay run for an EARLIER week still pays the earlier rate when it is drafted after the step.
 * rateForWeek() is that rule; evaluate() in payroll-runs.js applies it with withWeekRates().
 *
 * No feature gate. With no step rows every function here reads and returns what the payroll code did
 * before: withWeekRates() hands back the very same rows, applyDueSteps() changes nothing.
 * Nothing here sends a message to anyone.
 */
const Joi = require('joi');
const db = require('../models/db');
const { recordAuditEvent } = require('./audit-log');
const { etDateString } = require('../utils/datetime-et');
const { addStaffWorkDays, staffWeekStartForWorkDate } = require('../utils/staff-time-work-date');
const { floridaMinimumWageCentsFor } = require('./payroll-calc');
const {
  PayrollError, calendarDate, validate, requireUuid, lockW2Technician, MAX_NOTE,
} = require('./payroll-w4');
const { lockPayrollMutations } = require('./payroll-lock');

const MAX_RATE = 999999.99;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTOR_ERROR = 'An admin is needed to change a pay rate step.';

// "25" or "25.50" -> whole cents; anything else is refused.
const hourlyRateCents = Joi.any().custom((value, helpers) => {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : String(value == null ? '' : value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text) || Number(text) <= 0 || Number(text) > MAX_RATE) {
    return helpers.message(`Hourly rate must be a dollar amount above 0 with at most 2 decimal places, up to ${MAX_RATE}`);
  }
  const [whole, fraction = ''] = text.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}).required().messages({ 'any.required': 'Hourly rate is required' });

const stepSchema = Joi.object({
  effectiveOn: calendarDate('Start date').required()
    .messages({ 'any.required': 'Start date is required', 'string.empty': 'Start date is required' }),
  hourlyRate: hourlyRateCents,
  note: Joi.string().trim().max(MAX_NOTE).allow('', null).default(null)
    .messages({ 'string.max': `Note must be at most ${MAX_NOTE} characters` }),
});

const dollarsText = (cents) => (cents / 100).toFixed(2);
const toNumber = (rate) => (rate == null ? null : Number(rate));
const actorIdOf = (actor) => (actor && typeof actor === 'object' ? actor.id : actor) || null;

// Dates leave Postgres as text so a server time zone can never move a day.
const columns = (conn) => [
  'id', 'technician_id', 'hourly_rate', 'previous_rate', 'applied_at', 'cancelled_at', 'note', 'created_at',
  conn.raw("to_char(effective_on, 'YYYY-MM-DD') as effective_on"),
];

const isoOrNull = (value) => (value ? new Date(value).toISOString() : null);

function serialize(row) {
  let status = 'scheduled';
  if (row.cancelled_at) status = 'cancelled';
  else if (row.applied_at) status = 'applied';
  return {
    id: row.id,
    technicianId: row.technician_id,
    effectiveOn: row.effective_on,
    hourlyRate: row.hourly_rate,
    previousRate: row.previous_rate,
    status,
    appliedAt: isoOrNull(row.applied_at),
    cancelledAt: isoOrNull(row.cancelled_at),
    note: row.note || null,
    createdAt: isoOrNull(row.created_at),
  };
}

/**
 * The hourly rate that pays the week starting weekStart. PURE. `steps` are that technician's
 * non-cancelled steps (rows: effective_on text, hourly_rate, previous_rate, applied_at).
 * (a) A step already applied after the week changed technicians.pay_rate, so the week reads the rate
 *     stored from before the earliest such step. (b) Otherwise a step that is due but not applied yet
 *     (the daily job has not run) already prices the week. (c) Otherwise the current rate, so a later
 *     manual edit of pay_rate still counts for every week after the last applied step.
 */
function rateForWeek(currentRate, steps, weekStart) {
  const byDay = [...(steps || [])].sort((a, b) => (a.effective_on < b.effective_on ? -1 : 1));
  const later = byDay.find((s) => s.applied_at && s.effective_on > weekStart);
  if (later) return later.previous_rate;
  const due = byDay.filter((s) => !s.applied_at && s.effective_on <= weekStart).pop();
  return due ? due.hourly_rate : currentRate;
}

// The pay run's technician rows with pay_rate replaced by that week's rate: ONE query for all of them.
// A technician with no step keeps the same row object, so a run with no steps is unchanged.
async function withWeekRates(conn, rows, weekStart) {
  const ids = [...new Set(rows.map((row) => row.technician_id))];
  if (!ids.length) return rows;
  const steps = await conn('payroll_rate_steps').whereIn('technician_id', ids).whereNull('cancelled_at')
    .select('technician_id', 'hourly_rate', 'previous_rate', 'applied_at', conn.raw("to_char(effective_on, 'YYYY-MM-DD') as effective_on"));
  if (!steps.length) return rows;
  const byTech = new Map();
  for (const step of steps) byTech.set(step.technician_id, [...(byTech.get(step.technician_id) || []), step]);
  return rows.map((row) => {
    const mine = byTech.get(row.technician_id);
    return mine ? { ...row, pay_rate: rateForWeek(row.pay_rate, mine, weekStart) } : row;
  });
}

/**
 * Applies every step that is due on `today` (Eastern date), oldest first, inside the caller's
 * transaction. Idempotent: an applied step is never read again. Takes the payroll lock only when
 * something is due, so a pay run with nothing due waits for nothing.
 */
async function applyDueSteps(trx, { today = etDateString() } = {}) {
  const open = () => trx('payroll_rate_steps').whereNull('applied_at').whereNull('cancelled_at').where('effective_on', '<=', today);
  if (!(await open().first('id'))) return [];
  await lockPayrollMutations(trx);
  const due = await open().orderBy([{ column: 'effective_on' }, { column: 'created_at' }, { column: 'id' }]).forUpdate().select('id', 'technician_id', 'hourly_rate');
  const applied = [];
  for (const step of due) {
    const tech = await trx('technicians').where({ id: step.technician_id }).forUpdate().first('id', 'pay_rate');
    await trx('technicians').where({ id: step.technician_id }).update({ pay_rate: step.hourly_rate, updated_at: trx.fn.now() });
    await trx('payroll_rate_steps').where({ id: step.id }).update({ previous_rate: tech.pay_rate, applied_at: trx.fn.now() });
    // The same action a manual pay rate edit records (admin-timetracking.js), plus the step behind it.
    await recordAuditEvent({
      trx, critical: true, actor_type: 'system', actor_id: null,
      action: 'payroll.pay_rate_changed', resource_type: 'technicians', resource_id: step.technician_id,
      metadata: {
        technician_id: step.technician_id, old_pay_rate: toNumber(tech.pay_rate), new_pay_rate: toNumber(step.hourly_rate), rate_step_id: step.id,
      },
    });
    applied.push(step.id);
  }
  return applied;
}

// The daily job: its own transaction.
const applyDueStepsDaily = (conn = db) => conn.transaction((trx) => applyDueSteps(trx));

// The first Monday strictly after day 90, where day 1 is the hire date; null without a hire date.
function suggestedDay90Monday(hireDate) {
  if (!hireDate) return null;
  const afterDay90 = addStaffWorkDays(hireDate, 90);
  const monday = staffWeekStartForWorkDate(afterDay90);
  return monday === afterDay90 ? monday : addStaffWorkDays(monday, 7);
}

async function listSteps(technicianId, conn = db) {
  requireUuid(technicianId);
  const tech = await conn('technicians').where({ id: technicianId }).first(conn.raw("to_char(hire_date, 'YYYY-MM-DD') as hire_date"));
  if (!tech) throw new PayrollError(404, 'Technician not found.');
  const rows = await conn('payroll_rate_steps').where({ technician_id: technicianId })
    .orderBy([{ column: 'effective_on', order: 'desc' }, { column: 'created_at', order: 'desc' }]).select(columns(conn));
  return { steps: rows.map(serialize), suggestedDay90Monday: suggestedDay90Monday(tech.hire_date) };
}

// The Florida minimum wage on the start date; the table ends where the next rate is not known yet.
function checkMinimumWage(rateCents, day) {
  let floor;
  try { floor = Number(floridaMinimumWageCentsFor(day)); } catch {
    throw new PayrollError(400, 'The Florida minimum wage for that start date is not on file yet');
  }
  if (rateCents < floor) throw new PayrollError(400, `Hourly rate cannot be below the Florida minimum wage of $${dollarsText(floor)} on ${day}`);
}

async function createStep(technicianId, input, actor, conn = db) {
  requireUuid(technicianId);
  const v = validate(stepSchema, input);
  const today = etDateString();
  if (v.effectiveOn <= today) throw new PayrollError(400, 'Start date must be after today');
  if (staffWeekStartForWorkDate(v.effectiveOn) !== v.effectiveOn) throw new PayrollError(400, 'Start date must be a Monday');
  checkMinimumWage(v.hourlyRate, v.effectiveOn);
  const actorId = actorIdOf(actor);
  if (!actorId) throw new PayrollError(403, ACTOR_ERROR);
  try {
    return await conn.transaction(async (trx) => {
      await lockPayrollMutations(trx);
      await lockW2Technician(trx, technicianId, 'A pay rate step');
      const [inserted] = await trx('payroll_rate_steps').insert({
        technician_id: technicianId,
        effective_on: v.effectiveOn,
        hourly_rate: dollarsText(v.hourlyRate),
        note: v.note || null,
        created_by: actorId,
      }).returning('id');
      const id = inserted && inserted.id ? inserted.id : inserted;
      await recordAuditEvent({
        trx, critical: true, actor_type: 'admin', actor_id: actorId,
        action: 'payroll.rate_step_created', resource_type: 'payroll_rate_steps', resource_id: id,
        metadata: {
          technician_id: technicianId, rate_step_id: id, effective_on: v.effectiveOn, new_pay_rate: Number(dollarsText(v.hourlyRate)),
        },
      });
      return serialize(await trx('payroll_rate_steps').where({ id }).first(columns(trx)));
    });
  } catch (err) {
    if (err && err.code === '23505') throw new PayrollError(409, 'This technician already has a pay rate change on that date. Cancel it first.');
    throw err;
  }
}

async function cancelStep(stepId, actor, conn = db) {
  if (!UUID_RE.test(String(stepId || ''))) throw new PayrollError(404, 'Pay rate step not found.');
  const actorId = actorIdOf(actor);
  if (!actorId) throw new PayrollError(403, ACTOR_ERROR);
  return conn.transaction(async (trx) => {
    await lockPayrollMutations(trx);
    const step = await trx('payroll_rate_steps').where({ id: stepId }).forUpdate().first('id', 'technician_id', 'applied_at', 'cancelled_at');
    if (!step) throw new PayrollError(404, 'Pay rate step not found.');
    if (step.applied_at) throw new PayrollError(409, 'This step already changed the pay rate. Change the pay rate on the staff record instead.');
    if (step.cancelled_at) throw new PayrollError(409, 'This step is already cancelled.');
    await trx('payroll_rate_steps').where({ id: stepId }).update({ cancelled_at: trx.fn.now(), cancelled_by: actorId });
    await recordAuditEvent({
      trx, critical: true, actor_type: 'admin', actor_id: actorId,
      action: 'payroll.rate_step_cancelled', resource_type: 'payroll_rate_steps', resource_id: stepId,
      metadata: { technician_id: step.technician_id, rate_step_id: stepId },
    });
    return serialize(await trx('payroll_rate_steps').where({ id: stepId }).first(columns(trx)));
  });
}

module.exports = {
  rateForWeek, withWeekRates, applyDueSteps, applyDueStepsDaily, suggestedDay90Monday, listSteps, createStep, cancelStep,
};
