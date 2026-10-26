/**
 * Payroll time off (owner ruling 2026-10-26: "Paid days off. The portal's
 * payroll cannot pay time off or holidays. Fix: add this before the tech's first
 * day off."). Dark behind GATE_PAYROLL_TIME_OFF (the route checks it; these
 * functions only run behind that check).
 *
 * An admin records one paid day off per W-2 technician per date: kind 'pto' or
 * 'holiday', and the paid hours (up to 24, two decimals). A pay run for the week
 * that holds the date pays those hours at the straight rate (payroll-runs.js).
 * The benefits policy is not final, so no allowance and no holiday list live in
 * code: the yearly allowance is a setting on the technician and only warns.
 *
 * Once the pay run for the staff week that holds the date is finalized (not
 * voided), the day cannot be added, changed or removed, whichever technician the
 * run paid: a run finalized without a check for this technician would otherwise
 * never pay a day added afterwards. Void the pay run first. The write takes
 * the same advisory lock finalizeRun takes (lockPayrollMutations), so a finalize
 * and a time-off edit cannot interleave.
 *
 * Recording time off here does not mark the technician out on the schedule
 * (technician_absences is a separate record).
 */
const Joi = require('joi');
const db = require('../models/db');
const { recordAuditEvent } = require('./audit-log');
const { PayrollError } = require('./payroll-w4');
const { lockPayrollMutations } = require('./payroll-runs');
const { etDateString, validCalendarDate } = require('../utils/datetime-et');
const { addStaffWorkDays, staffWeekStartForWorkDate } = require('../utils/staff-time-work-date');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = ['pto', 'holiday'];
const MAX_NOTE = 500;
const MAX_DAYS_AWAY = 400;
const MAX_ALLOWANCE_HOURS = 400;
const LOCKED_MESSAGE = "This week's pay run is final. Void it first to change its pay.";
const KIND_WORDS = { pto: 'Paid time off', holiday: 'Holiday' };

function validate(schema, input) {
  const { value, error } = schema.validate(input || {}, { abortEarly: true, convert: true, allowUnknown: false });
  if (error) throw new PayrollError(400, error.details[0].message);
  return value;
}

const requireUuid = (id, what) => {
  if (!UUID_RE.test(String(id || ''))) throw new PayrollError(404, `${what} not found.`);
  return String(id);
};
const actorOf = (actor) => (actor && typeof actor === 'object' ? actor.id : actor) || null;

// Hours as typed -> hundredths of an hour (an integer). At most 2 decimals; 'hours'
// must be above 0 and at most 24. Anything else is refused, never read as zero.
function hoursToHundredths(value) {
  let text = null;
  if (typeof value === 'number' && Number.isFinite(value)) text = String(value);
  else if (typeof value === 'string') text = value.trim();
  if (text === null || !/^\d+(?:\.\d{1,2})?$/.test(text)) {
    throw new PayrollError(400, 'Hours must be a number with at most 2 decimal places');
  }
  const [whole, fraction = ''] = text.split('.');
  const hundredths = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (hundredths <= 0) throw new PayrollError(400, 'Hours must be more than 0');
  if (hundredths > 2400) throw new PayrollError(400, 'Hours must be 24 or fewer for one day');
  return hundredths;
}

// Hundredths of an hour -> minutes text for numeric(10,2): h * 60 / 100 minutes.
const minutesText = (hundredths) => {
  const hundredthsOfMinute = hundredths * 60;
  return `${Math.floor(hundredthsOfMinute / 100)}.${String(hundredthsOfMinute % 100).padStart(2, '0')}`;
};
const hoursText = (minutes) => (Math.round((Number(minutes) || 0) / 60 * 100) / 100).toFixed(2);

const kindSchema = Joi.string().valid(...KINDS).required()
  .messages({ 'any.only': 'Pick paid time off or holiday', 'any.required': 'Pick paid time off or holiday', 'string.base': 'Pick paid time off or holiday' });
const hoursSchema = Joi.any().custom((value, helpers) => {
  if (value == null || value === '') return helpers.message('Enter the hours');
  try { return hoursToHundredths(value); } catch (err) { return helpers.message(err.message); }
}).required().messages({ 'any.required': 'Enter the hours' });
const noteSchema = Joi.string().trim().max(MAX_NOTE).allow('', null).default(null)
  .messages({ 'string.max': `Note must be at most ${MAX_NOTE} characters`, 'string.base': 'Note must be text' });

const createSchema = Joi.object({
  technicianId: Joi.string().trim().required()
    .messages({ 'any.required': 'Pick a technician', 'string.empty': 'Pick a technician', 'string.base': 'Pick a technician' }),
  workDate: Joi.string().trim().required()
    .messages({ 'any.required': 'Pick a date', 'string.empty': 'Pick a date', 'string.base': 'Pick a date' }),
  kind: kindSchema,
  hours: hoursSchema,
  note: noteSchema,
});
const updateSchema = Joi.object({ kind: kindSchema, hours: hoursSchema, note: noteSchema });
const allowanceSchema = Joi.object({
  hoursPerYear: Joi.any().custom((value, helpers) => {
    if (value == null || value === '') return null;
    let text = null;
    if (typeof value === 'number' && Number.isFinite(value)) text = String(value);
    else if (typeof value === 'string') text = value.trim();
    if (text === null || !/^\d+(?:\.\d{1,2})?$/.test(text)) return helpers.message('Hours per year must be a number with at most 2 decimal places');
    if (Number(text) > MAX_ALLOWANCE_HOURS) return helpers.message(`Hours per year must be ${MAX_ALLOWANCE_HOURS} or fewer`);
    return text;
  }).required().messages({ 'any.required': 'Enter the hours per year, or leave it empty to clear it' }),
});

// ---- Dates (ET calendar dates as text)

function checkWorkDate(workDate, today = etDateString()) {
  const day = validCalendarDate(workDate);
  if (!day) throw new PayrollError(400, 'Date must be a real date (YYYY-MM-DD)');
  if (day < addStaffWorkDays(today, -MAX_DAYS_AWAY) || day > addStaffWorkDays(today, MAX_DAYS_AWAY)) {
    throw new PayrollError(400, `Date must be within ${MAX_DAYS_AWAY} days of today`);
  }
  return day;
}

// ---- Reading

const entryColumns = (conn) => [
  'o.id', 'o.technician_id', 'o.kind', 'o.minutes', 'o.note', 't.name',
  conn.raw("to_char(o.work_date, 'YYYY-MM-DD') as work_date"),
];

function serializeEntry(row) {
  return {
    id: row.id,
    technicianId: row.technician_id,
    name: row.name,
    workDate: row.work_date,
    kind: row.kind,
    hours: hoursText(row.minutes),
    note: row.note || null,
  };
}

async function listTimeOff(query, conn = db) {
  const from = validCalendarDate(query && query.from);
  const to = validCalendarDate(query && query.to);
  if (!from || !to) throw new PayrollError(400, 'Pick a start date and an end date (YYYY-MM-DD)');
  if (to < from) throw new PayrollError(400, 'The end date must be on or after the start date');
  if (to > addStaffWorkDays(from, MAX_DAYS_AWAY)) throw new PayrollError(400, `Pick a range of ${MAX_DAYS_AWAY} days or fewer`);
  const rows = await conn('payroll_time_off as o')
    .join('technicians as t', 't.id', 'o.technician_id')
    .where('o.work_date', '>=', from)
    .where('o.work_date', '<=', to)
    .orderBy([{ column: 'o.work_date' }, { column: 't.name' }, { column: 'o.technician_id' }])
    .select(entryColumns(conn));
  return rows.map(serializeEntry);
}

async function loadEntry(conn, id) {
  const row = await conn('payroll_time_off as o')
    .join('technicians as t', 't.id', 'o.technician_id')
    .where('o.id', id)
    .first(entryColumns(conn));
  return row ? serializeEntry(row) : null;
}

// Paid time off booked in a calendar year for one technician, in minutes.
async function ptoMinutesBooked(conn, technicianId, year) {
  const row = await conn('payroll_time_off')
    .where({ technician_id: technicianId, kind: 'pto' })
    .where('work_date', '>=', `${year}-01-01`)
    .where('work_date', '<=', `${year}-12-31`)
    .first(conn.raw('COALESCE(SUM(minutes), 0) AS minutes'));
  return Number(row.minutes);
}

async function allowanceOf(conn, technicianId) {
  const row = await conn('technicians').where({ id: technicianId }).first('pto_hours_per_year');
  return row && row.pto_hours_per_year != null ? Number(row.pto_hours_per_year) : null;
}

// The allowance only warns. Returns plain text, or null.
async function allowanceWarning(conn, technicianId, name, year) {
  const allowance = await allowanceOf(conn, technicianId);
  if (allowance == null) return null;
  const booked = await ptoMinutesBooked(conn, technicianId, year);
  if (booked <= allowance * 60 + 1e-9) return null;
  return `${name} now has ${hoursText(booked)} hours of paid time off booked in ${year}. The yearly allowance is ${allowance} hours. The day is saved.`;
}

async function balance(query, conn = db) {
  const technicianId = requireUuid(query && query.technicianId, 'Technician');
  const thisYear = Number(etDateString().slice(0, 4));
  const raw = query && query.year != null && query.year !== '' ? String(query.year).trim() : String(thisYear);
  if (!/^\d{4}$/.test(raw) || Number(raw) < 2020 || Number(raw) > thisYear + 2) {
    throw new PayrollError(400, 'Year must be a four-digit year');
  }
  const year = Number(raw);
  const tech = await conn('technicians').where({ id: technicianId }).first('id');
  if (!tech) throw new PayrollError(404, 'Technician not found.');
  const allowance = await allowanceOf(conn, technicianId);
  const booked = await ptoMinutesBooked(conn, technicianId, year);
  const holidays = await conn('payroll_time_off')
    .where({ technician_id: technicianId, kind: 'holiday' })
    .where('work_date', '>=', `${year}-01-01`)
    .where('work_date', '<=', `${year}-12-31`)
    .first(conn.raw('COUNT(*) AS days'));
  const paid = await conn('payroll_checks')
    .where({ technician_id: technicianId, status: 'finalized' })
    .where('pay_date', '>=', `${year}-01-01`)
    .where('pay_date', '<=', `${year}-12-31`)
    .first(conn.raw('COALESCE(SUM(pto_minutes), 0) AS minutes'));
  return {
    technicianId,
    year,
    allowanceHours: allowance,
    ptoHoursBooked: hoursText(booked),
    ptoHoursPaid: hoursText(paid.minutes),
    holidayDaysBooked: Number(holidays.days),
  };
}

// ---- Writing

const audit = (trx, actorId, action, id, metadata) => recordAuditEvent({
  trx, critical: true, actor_type: 'admin', actor_id: actorId, action,
  resource_type: 'payroll_time_off', resource_id: id, metadata,
});

// The caller has taken the finalize lock. Refuse when the week's pay run is final.
async function refuseWhenPaid(trx, workDate) {
  const weekStart = staffWeekStartForWorkDate(workDate);
  const paid = await trx('payroll_runs').where({ week_start: weekStart, status: 'finalized' }).first('id');
  if (paid) throw new PayrollError(409, LOCKED_MESSAGE);
}

async function createTimeOff(input, actor, conn = db) {
  const v = validate(createSchema, input);
  const technicianId = requireUuid(v.technicianId, 'Technician');
  const workDate = checkWorkDate(v.workDate);
  const actorId = actorOf(actor);
  const duplicate = new PayrollError(409, 'That technician already has time off recorded for that date. Change that entry instead.');
  try {
    return await conn.transaction(async (trx) => {
      await lockPayrollMutations(trx);
      const tech = await trx('technicians').where({ id: technicianId }).first('id', 'name', 'employment_type');
      if (!tech) throw new PayrollError(404, 'Technician not found.');
      if (tech.employment_type !== 'w2') throw new PayrollError(409, 'Paid time off is for W-2 employees.');
      await refuseWhenPaid(trx, workDate);
      const [inserted] = await trx('payroll_time_off').insert({
        technician_id: technicianId, work_date: workDate, kind: v.kind, minutes: minutesText(v.hours),
        note: v.note || null, created_by: actorId,
      }).returning('id');
      const id = inserted && inserted.id ? inserted.id : inserted;
      await audit(trx, actorId, 'payroll.time_off_added', id, { technician_id: technicianId, entry_id: id, work_date: workDate, kind: v.kind });
      const warning = v.kind === 'pto' ? await allowanceWarning(trx, technicianId, tech.name, workDate.slice(0, 4)) : null;
      return { entry: await loadEntry(trx, id), warning };
    });
  } catch (err) {
    if (err && err.code === '23505') throw duplicate;
    throw err;
  }
}

async function updateTimeOff(id, input, actor, conn = db) {
  requireUuid(id, 'Time off entry');
  const v = validate(updateSchema, input);
  const actorId = actorOf(actor);
  return conn.transaction(async (trx) => {
    await lockPayrollMutations(trx);
    const row = await trx('payroll_time_off as o').where('o.id', id).forUpdate('o')
      .first('o.technician_id', trx.raw("to_char(o.work_date, 'YYYY-MM-DD') as work_date"));
    if (!row) throw new PayrollError(404, 'Time off entry not found.');
    await refuseWhenPaid(trx, row.work_date);
    await trx('payroll_time_off').where({ id }).update({
      kind: v.kind, minutes: minutesText(v.hours), note: v.note || null, updated_by: actorId, updated_at: trx.fn.now(),
    });
    await audit(trx, actorId, 'payroll.time_off_changed', id, {
      technician_id: row.technician_id, entry_id: id, work_date: row.work_date, kind: v.kind,
    });
    const entry = await loadEntry(trx, id);
    const warning = v.kind === 'pto' ? await allowanceWarning(trx, row.technician_id, entry.name, row.work_date.slice(0, 4)) : null;
    return { entry, warning };
  });
}

async function deleteTimeOff(id, actor, conn = db) {
  requireUuid(id, 'Time off entry');
  const actorId = actorOf(actor);
  await conn.transaction(async (trx) => {
    await lockPayrollMutations(trx);
    const row = await trx('payroll_time_off as o').where('o.id', id).forUpdate('o')
      .first('o.technician_id', 'o.kind', trx.raw("to_char(o.work_date, 'YYYY-MM-DD') as work_date"));
    if (!row) throw new PayrollError(404, 'Time off entry not found.');
    await refuseWhenPaid(trx, row.work_date);
    await trx('payroll_time_off').where({ id }).del();
    await audit(trx, actorId, 'payroll.time_off_removed', id, {
      technician_id: row.technician_id, entry_id: id, work_date: row.work_date, kind: row.kind,
    });
  });
  return { deleted: true };
}

// The yearly paid time off allowance, a setting. null clears it.
async function setPtoAllowance(technicianId, input, actor, conn = db) {
  requireUuid(technicianId, 'Technician');
  const v = validate(allowanceSchema, input);
  const actorId = actorOf(actor);
  return conn.transaction(async (trx) => {
    const tech = await trx('technicians').where({ id: technicianId }).forUpdate().first('id', 'employment_type');
    if (!tech) throw new PayrollError(404, 'Technician not found.');
    if (tech.employment_type !== 'w2') throw new PayrollError(409, 'Paid time off is for W-2 employees.');
    await trx('technicians').where({ id: technicianId }).update({ pto_hours_per_year: v.hoursPerYear, updated_at: trx.fn.now() });
    await recordAuditEvent({
      trx, critical: true, actor_type: 'admin', actor_id: actorId,
      action: 'payroll.pto_allowance_changed', resource_type: 'technicians', resource_id: technicianId,
      metadata: { technician_id: technicianId },
    });
    const row = await trx('technicians').where({ id: technicianId }).first('id', 'pto_hours_per_year');
    return { id: row.id, ptoHoursPerYear: row.pto_hours_per_year == null ? null : Number(row.pto_hours_per_year) };
  });
}

module.exports = {
  KINDS,
  KIND_WORDS,
  LOCKED_MESSAGE,
  hoursToHundredths,
  minutesText,
  checkWorkDate,
  listTimeOff,
  balance,
  createTimeOff,
  updateTimeOff,
  deleteTimeOff,
  setPtoAllowance,
};
