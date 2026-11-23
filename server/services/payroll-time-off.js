/**
 * Payroll time off (owner ruling 2026-10-26: "Paid days off. The portal's
 * payroll cannot pay time off or holidays. Fix: add this before the tech's first
 * day off."). Dark behind GATE_PAYROLL_TIME_OFF (the route checks it; these
 * functions only run behind that check).
 *
 * An admin records one paid day off per W-2 technician per date: kind 'pto' or
 * 'holiday', and the paid hours (up to 24, two decimals). A pay run for the week
 * that holds the date pays those hours at the straight rate (payroll-runs.js).
 * No holiday list lives in code.
 *
 * Time-off bank (owner 2026-11-21, payroll-time-off-bank.js): a technician whose
 * yearly hours are set has a bank. The pay run pays paid time off only from the
 * bank; here the bank only warns, and a day is never refused. A paid-time-off day
 * can be marked as illness (the only kind the bank pays up to day 90). With no
 * yearly hours set there is no bank and every recorded hour is paid.
 *
 * Once the pay run for the staff week that holds the date is finalized (not
 * voided), the day cannot be added, changed or removed, whichever technician the
 * run paid: a run finalized without a check for this technician would otherwise
 * never pay a day added afterwards. Void the pay run first. The write takes
 * the same advisory lock finalizeRun takes (lockPayrollMutations), so a finalize
 * and a time-off edit cannot interleave. Saving the yearly hours takes it too:
 * that setting turns a bank on or off, and a finalize must read one answer.
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
const bank = require('./payroll-time-off-bank');

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

// Returns the id as Postgres spells it (lowercase): the bank reads key their answers by the id of the row.
const requireUuid = (id, what) => {
  if (!UUID_RE.test(String(id || ''))) throw new PayrollError(404, `${what} not found.`);
  return String(id).toLowerCase();
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

// A paid-time-off day for illness. A holiday is never an illness day.
const illnessSchema = Joi.boolean().default(false).messages({ 'boolean.base': 'Illness must be yes or no' });
const ILLNESS_KIND_MESSAGE = 'Only a paid time off day can be marked as illness';

const createSchema = Joi.object({
  technicianId: Joi.string().trim().required()
    .messages({ 'any.required': 'Pick a technician', 'string.empty': 'Pick a technician', 'string.base': 'Pick a technician' }),
  workDate: Joi.string().trim().required()
    .messages({ 'any.required': 'Pick a date', 'string.empty': 'Pick a date', 'string.base': 'Pick a date' }),
  kind: kindSchema,
  hours: hoursSchema,
  note: noteSchema,
  illness: illnessSchema,
});
// No default on a change: a screen loaded before the illness mark existed sends none, and the mark must stay.
const updateSchema = Joi.object({
  kind: kindSchema, hours: hoursSchema, note: noteSchema,
  illness: Joi.boolean().messages({ 'boolean.base': 'Illness must be yes or no' }),
});
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
// The minimum paid hours of a full workweek (payroll-week-minimum.js). Empty clears it.
const MAX_WEEK_MINIMUM_HOURS = 40;
const weekMinimumSchema = Joi.object({
  hours: Joi.any().custom((value, helpers) => {
    if (value == null || value === '') return null;
    let text = null;
    if (typeof value === 'number' && Number.isFinite(value)) text = String(value);
    else if (typeof value === 'string') text = value.trim();
    if (text === null || !/^\d+(?:\.\d{1,2})?$/.test(text)) return helpers.message('Minimum hours must be a number with at most 2 decimal places');
    if (Number(text) <= 0 || Number(text) > MAX_WEEK_MINIMUM_HOURS) {
      return helpers.message(`Minimum hours must be more than 0 and ${MAX_WEEK_MINIMUM_HOURS} or fewer`);
    }
    return text;
  }).required().messages({ 'any.required': 'Enter the minimum hours, or leave it empty to clear it' }),
  // The employee's last day (owner 2026-11-23 *a*). Empty clears it; left out keeps it.
  lastDay: Joi.any().custom((value, helpers) => {
    if (value == null || value === '') return null;
    const day = typeof value === 'string' ? validCalendarDate(value.trim()) : null;
    return day || helpers.message('Last day must be a date (YYYY-MM-DD)');
  }),
  // What the page showed: a save from a page read before another change is refused (409), so an old tab never
  // puts back a full-week minimum another tab ended. Left out = no check (a caller with no page).
  shown: Joi.object({
    hours: Joi.any().allow(null),
    lastDay: Joi.any().allow(null),
  }),
});
const WEEK_MINIMUM_STALE = 'The minimum or the last day changed since this page was read. Read the page again.';
const sameHours = (a, b) => (a == null || a === '' ? null : Number(a)) === (b == null || b === '' ? null : Number(b));
const LAST_DAY_PAID = (week) => `A final pay run already paid this employee for the week of ${week} or later, so the last day `
  + 'cannot change there. Void that pay run first.';
// The pay week of a bank payout, by its first day. Empty takes the payout back.
const PAYOUT_WEEK_MESSAGE = 'Pick the first day of a pay week (YYYY-MM-DD)';
const payoutWeek = (value, helpers) => {
  if (value == null || value === '') return null;
  const day = typeof value === 'string' ? validCalendarDate(value.trim()) : null;
  if (!day || staffWeekStartForWorkDate(day) !== day) return helpers.message(PAYOUT_WEEK_MESSAGE);
  return day;
};
// What a page shows of a payout (payoutOf): none, set (its pay run is not final), paid (a final pay run kept
// it), or missed (that week's final pay run kept none).
const PAYOUT_STATES = ['none', 'set', 'paid', 'missed'];
function payoutStateOf(payout) {
  if (!payout) return 'none';
  if (payout.final) return 'paid';
  return payout.missed ? 'missed' : 'set';
}
// `shownWeekStart` and `shownState`: the payout the page showed when the button was pressed (empty week and
// 'none' = no payout). The change is made only when the employee's payout is still that one, in that state
// (setPtoPayoutWeek).
const SHOWN_MESSAGE = 'Send the bank payout the page shows (shownWeekStart, empty for none, and shownState)';
const PAYOUT_CHANGED = 'The bank payout of this employee changed after this page was read. Check it, then press again.';
const PAYOUT_PAID = 'That bank payout is paid: its pay run is final. Void that pay run to change it.';
const PAYOUT_WEEK_PASSED = 'This employee already has a final paycheck or bank payout in a later week. Pick a week after it.';
const payoutSchema = Joi.object({
  weekStart: Joi.any().custom(payoutWeek).required().messages({ 'any.required': PAYOUT_WEEK_MESSAGE }),
  shownWeekStart: Joi.any().custom(payoutWeek).required().messages({ 'any.required': SHOWN_MESSAGE }),
  shownState: Joi.any().valid(...PAYOUT_STATES).required().messages({ 'any.required': SHOWN_MESSAGE, 'any.only': SHOWN_MESSAGE }),
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
  'o.id', 'o.technician_id', 'o.kind', 'o.minutes', 'o.note', 'o.illness', 't.name',
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
    illness: row.illness === true,
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

// The bank only warns here: the pay run decides what it pays. Plain text, or null for a technician
// with no bank. `day` = { workDate, illness } of the paid-time-off day just saved.
async function bankWarning(conn, technicianId, name, day) {
  const tech = (await bank.bankTechnicians(conn, [technicianId])).get(technicianId);
  if (!tech) return null;
  const parts = [];
  const sums = (await bank.bankSums(conn, [technicianId])).get(technicianId);
  const usableFrom = bank.usableFromOf(tech.hireDate);
  if (!usableFrom) {
    parts.push(`Add the hire date of ${name} in Time Tracking, Team. The pay run needs it to pay time off.`);
  } else if (day.workDate < tech.hireDate) {
    parts.push(`This day is before the hire date of ${name}. The time-off bank does not pay it, so this day is unpaid.`);
  } else if (day.workDate < usableFrom && !day.illness) {
    parts.push(`This day is in the first ${bank.USE_AFTER_DAYS} days of the job. Until ${usableFrom} the time-off bank pays only illness days, up to ${bank.EARLY_ILLNESS_HOURS} hours, so this day is unpaid.`);
  } else if (day.workDate < usableFrom) {
    // An illness day in the first days of the job: the hours the rule allows can be used up.
    const early = await bank.earlyIllnessWaiting(conn, technicianId, { hireDate: tech.hireDate, usableFrom, earlyPaid: sums.earlyPaid });
    if (early.short > 0) {
      parts.push(`Until ${usableFrom} the time-off bank pays illness days up to ${bank.EARLY_ILLNESS_HOURS} hours in all. ${name} has ${bank.hoursText(early.left)} of those hours left and ${bank.hoursText(early.waiting)} hours of illness days waiting for a pay run, so ${bank.hoursText(early.short)} hours are unpaid.`);
    }
  }
  const held = Math.max(0, sums.bank);
  const waiting = await bank.ptoWaiting(conn, technicianId);
  if (waiting > held) {
    parts.push(`${name} has ${bank.hoursText(held)} hours in the time-off bank today and ${bank.hoursText(waiting)} hours of paid time off waiting for a pay run. A pay run pays only the hours the bank holds then.`);
  }
  return parts.length ? `${parts.join(' ')} The day is saved.` : null;
}

async function balance(query, conn = db) {
  const technicianId = requireUuid(query && query.technicianId, 'Technician');
  const thisYear = Number(etDateString().slice(0, 4));
  const raw = query && query.year != null && query.year !== '' ? String(query.year).trim() : String(thisYear);
  if (!/^\d{4}$/.test(raw) || Number(raw) < 2020 || Number(raw) > thisYear + 2) {
    throw new PayrollError(400, 'Year must be a four-digit year');
  }
  const year = Number(raw);
  // One read-only snapshot for every figure. A pay run that is finalized between two reads would show the
  // bank from before it next to the waiting hours from after it.
  return conn.transaction((trx) => balanceAt(trx, technicianId, year), { isolationLevel: 'repeatable read', readOnly: true });
}

async function balanceAt(conn, technicianId, year) {
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
  // The time-off bank today (all years); only for a technician with a bank.
  const banked = (await bank.bankTechnicians(conn, [technicianId])).get(technicianId);
  return {
    technicianId,
    year,
    allowanceHours: allowance,
    ptoHoursBooked: hoursText(booked),
    ptoHoursPaid: hoursText(paid.minutes),
    holidayDaysBooked: Number(holidays.days),
    ...(banked ? {
      bank: {
        balanceHours: bank.hoursText((await bank.bankSums(conn, [technicianId])).get(technicianId).bank),
        waitingHours: bank.hoursText(await bank.ptoWaiting(conn, technicianId)),
        fullWeekHours: (bank.fullWeekHundredths(banked.hoursPerYear) / 100).toFixed(2),
        capHours: bank.CAP_HOURS,
        usableFrom: bank.usableFromOf(banked.hireDate),
        payout: await payoutOf(conn, technicianId, banked.payoutWeek),
      },
    } : {}),
  };
}

// The standing "Pay out the bank" instruction, or null when there is none: { weekStart, final }, with `hours`
// when final and `missed: true` when the week is closed without it.
//   final   the finalized pay run of that week kept the payout among its decisions (payroll_runs.bank_payouts),
//           with the hours it paid out. Only a void of that run changes it.
//   missed  that week's pay run is final and kept no payout for the employee (it was finalized with the gate
//           off, or before the employee had a bank): no run will pay the bank out until the owner acts.
async function payoutOf(conn, technicianId, weekStart) {
  if (!weekStart) return null;
  const done = await conn('payroll_runs').where({ week_start: weekStart, status: 'finalized' }).first('id', 'bank_payouts');
  if (!done) return { weekStart, final: false };
  const kept = (Array.isArray(done.bank_payouts) ? done.bank_payouts : []).find((row) => row.technicianId === technicianId);
  return kept ? { weekStart, final: true, hours: kept.hours } : { weekStart, final: false, missed: true };
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
  if (v.illness && v.kind !== 'pto') throw new PayrollError(400, ILLNESS_KIND_MESSAGE);
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
        note: v.note || null, illness: v.illness, created_by: actorId,
      }).returning('id');
      const id = inserted && inserted.id ? inserted.id : inserted;
      await audit(trx, actorId, 'payroll.time_off_added', id, { technician_id: technicianId, entry_id: id, work_date: workDate, kind: v.kind });
      const warning = v.kind === 'pto' ? await bankWarning(trx, technicianId, tech.name, { workDate, illness: v.illness }) : null;
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
  if (v.illness && v.kind !== 'pto') throw new PayrollError(400, ILLNESS_KIND_MESSAGE);
  const actorId = actorOf(actor);
  return conn.transaction(async (trx) => {
    await lockPayrollMutations(trx);
    const row = await trx('payroll_time_off as o').where('o.id', id).forUpdate('o')
      .first('o.technician_id', 'o.illness', trx.raw("to_char(o.work_date, 'YYYY-MM-DD') as work_date"));
    if (!row) throw new PayrollError(404, 'Time off entry not found.');
    await refuseWhenPaid(trx, row.work_date);
    // With no illness field sent, a paid time off day keeps its mark. A holiday has none.
    const illness = v.kind === 'pto' ? (v.illness ?? row.illness) : false;
    await trx('payroll_time_off').where({ id }).update({
      kind: v.kind, minutes: minutesText(v.hours), note: v.note || null, illness, updated_by: actorId, updated_at: trx.fn.now(),
    });
    await audit(trx, actorId, 'payroll.time_off_changed', id, {
      technician_id: row.technician_id, entry_id: id, work_date: row.work_date, kind: v.kind,
    });
    const entry = await loadEntry(trx, id);
    const warning = v.kind === 'pto' ? await bankWarning(trx, row.technician_id, entry.name, { workDate: row.work_date, illness }) : null;
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

const PAYOUT_HOLDS_ALLOWANCE = 'A time-off bank payout is set for this employee. Take it back first ("Do not pay out", owner account), then clear the yearly hours.';

// The yearly paid time off hours, a setting: what a year of full weeks adds to the technician's time-off bank
// (payroll-time-off-bank.js). null clears it: no bank, and the pay run pays every recorded hour.
async function setPtoAllowance(technicianId, input, actor, conn = db) {
  requireUuid(technicianId, 'Technician');
  const v = validate(allowanceSchema, input);
  const actorId = actorOf(actor);
  return conn.transaction(async (trx) => {
    // The lock finalizeRun takes: a finalize in progress read "no bank" or "bank" for this technician, and the
    // setting must not change under it. A finalize that starts after this save sees the new answer and a changed token.
    await lockPayrollMutations(trx);
    const tech = await trx('technicians').where({ id: technicianId }).forUpdate()
      .first('id', 'employment_type', trx.raw("to_char(pto_payout_week_start, 'YYYY-MM-DD') as payout_week"));
    if (!tech) throw new PayrollError(404, 'Technician not found.');
    if (tech.employment_type !== 'w2') throw new PayrollError(409, 'Paid time off is for W-2 employees.');
    // With no yearly hours there is no bank, and the pay run could not pay out what the owner set. The payout is
    // taken back first (the owner account), or its pay run is made final.
    // tech.id: the id as the row spells it. A pay run keeps its payouts by that spelling, and the id in the
    // address can be typed in capitals.
    if (v.hoursPerYear == null && tech.payout_week && !(await payoutOf(trx, tech.id, tech.payout_week)).final) {
      throw new PayrollError(409, PAYOUT_HOLDS_ALLOWANCE);
    }
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

// The minimum paid hours of a full workweek, a setting (offer letter, "Hours and schedule"; payroll-week-minimum.js),
// and the employee's last day when they leave (its week pays the scheduled days up to it; later weeks no minimum).
// hours null clears both: the pay run pays the hours on file and no more. A change of the last day is refused once a
// final check of the employee covers its week (the earlier of the old and the new day) or a later one: a paid week
// never changes under it. Void that pay run first.
async function setWeekMinimum(technicianId, input, actor, conn = db) {
  requireUuid(technicianId, 'Technician');
  const v = validate(weekMinimumSchema, input);
  const actorId = actorOf(actor);
  return conn.transaction(async (trx) => {
    // The lock finalizeRun takes: the setting never changes under a finalize. A draft read before the save is stale
    // after it (the check and its token change).
    await lockPayrollMutations(trx);
    const tech = await trx('technicians').where({ id: technicianId }).forUpdate()
      .first('id', 'employment_type', 'paid_week_minimum_hours',
        trx.raw("to_char(paid_week_minimum_last_day, 'YYYY-MM-DD') AS last_day"),
        trx.raw("to_char(hire_date, 'YYYY-MM-DD') AS hire_date"));
    if (!tech) throw new PayrollError(404, 'Technician not found.');
    if (v.shown && (!sameHours(v.shown.hours, tech.paid_week_minimum_hours) || (v.shown.lastDay || null) !== tech.last_day)) {
      throw new PayrollError(409, WEEK_MINIMUM_STALE);
    }
    // Clearing is always allowed: a setting kept from W-2 days must not come back when the person is W-2 again.
    if (v.hours != null && tech.employment_type !== 'w2') throw new PayrollError(409, 'A minimum paid week is for W-2 employees.');
    const lastDay = v.hours == null ? null : (v.lastDay === undefined ? tech.last_day : v.lastDay);
    // A last day before the hire date ended an earlier stay (a rehire moved the hire date past it): the pay run no
    // longer reads it, so it is not guarded and can be cleared or replaced.
    const shownLast = tech.last_day && tech.hire_date && tech.last_day < tech.hire_date ? null : tech.last_day;
    if (lastDay !== tech.last_day && (lastDay || shownLast)) {
      const earliest = [lastDay, shownLast].filter(Boolean).sort()[0];
      const week = staffWeekStartForWorkDate(earliest);
      const paid = await trx('payroll_checks').where({ technician_id: tech.id, status: 'finalized' })
        .where('week_start', '>=', week).first('id');
      if (paid) throw new PayrollError(409, LAST_DAY_PAID(week));
    }
    await trx('technicians').where({ id: technicianId })
      .update({ paid_week_minimum_hours: v.hours, paid_week_minimum_last_day: lastDay, updated_at: trx.fn.now() });
    await recordAuditEvent({
      trx, critical: true, actor_type: 'admin', actor_id: actorId,
      action: 'payroll.week_minimum_changed', resource_type: 'technicians', resource_id: technicianId,
      metadata: { technician_id: technicianId, hours: v.hours, last_day: lastDay },
    });
    const row = await trx('technicians').where({ id: technicianId })
      .first('id', 'paid_week_minimum_hours', trx.raw("to_char(paid_week_minimum_last_day, 'YYYY-MM-DD') AS last_day"));
    return {
      id: row.id,
      paidWeekMinimumHours: row.paid_week_minimum_hours == null ? null : Number(row.paid_week_minimum_hours),
      paidWeekMinimumLastDay: row.last_day || null,
    };
  });
}

// "Pay out the bank" (handbook, "When you leave"): the pay run for the week starting `weekStart` pays the
// technician every hour the bank holds after that week, on their check (payroll-time-off-bank.js). The handbook
// pays unused hours except after a quit without 14 days' notice or a dismissal for misconduct, so only the
// owner account sets this (the route), one decision each time. null takes it back. Nothing is paid until that
// pay run is final, and a final pay run does not read the setting again: a week whose run is final cannot be
// picked, and what that run decided stays on its row (payroll_runs.bank_payouts).
async function setPtoPayoutWeek(technicianId, input, actor, conn = db) {
  requireUuid(technicianId, 'Technician');
  const v = validate(payoutSchema, input);
  const actorId = actorOf(actor);
  return conn.transaction(async (trx) => {
    // The lock finalizeRun takes, as for the yearly hours: the setting must not change under a finalize.
    await lockPayrollMutations(trx);
    const tech = await trx('technicians').where({ id: technicianId }).forUpdate()
      .first('id', 'employment_type', 'pto_hours_per_year', trx.raw("to_char(pto_payout_week_start, 'YYYY-MM-DD') as payout_week"));
    if (!tech) throw new PayrollError(404, 'Technician not found.');
    // Another tab can have changed the payout since the page was read: moved it, taken it back, made its pay
    // run final, or voided that run. A press there must not change a payout the owner did not see: "Do not pay
    // out" for week A would clear week B, and a new week set from a page that showed week A as paid would
    // drop week A after its run was voided. Asked under the payroll lock and the row lock, for a set and for a
    // take-back. tech.id: the id as the row spells it, which is how a pay run keeps its payouts.
    const now = await payoutOf(trx, tech.id, tech.payout_week);
    if ((tech.payout_week || null) !== v.shownWeekStart || payoutStateOf(now) !== v.shownState) {
      throw new PayrollError(409, PAYOUT_CHANGED);
    }
    // A payout that a final pay run kept is paid: only a void of that run changes it (no page offers "Do not
    // pay out" then). Another week can still be set (the employee leaves a second time); the run keeps its
    // own record.
    if (!v.weekStart && now && now.final) throw new PayrollError(409, PAYOUT_PAID);
    // A payout is set only for an employee with a bank. It is taken back whatever they are now: a pay run holds
    // for a payout whose bank is gone, and this is how the owner lets it go.
    if (v.weekStart && (tech.employment_type !== 'w2' || tech.pto_hours_per_year == null)) {
      throw new PayrollError(409, 'This employee has no time-off bank.');
    }
    if (v.weekStart && await trx('payroll_runs').where({ week_start: v.weekStart, status: 'finalized' }).first('id')) {
      throw new PayrollError(409, "That week's pay run is final. Void it first, or pick a later pay run.");
    }
    // A week before a final bank check or a final payout of theirs could never pay the bank out: no pay run of
    // that week can be made final (payroll-runs.js finalizeRun), and the payout would hold their next paychecks.
    if (v.weekStart && await bank.laterWeekBankUseExists(trx, v.weekStart, tech.id)) {
      throw new PayrollError(409, PAYOUT_WEEK_PASSED);
    }
    await trx('technicians').where({ id: tech.id }).update({ pto_payout_week_start: v.weekStart, updated_at: trx.fn.now() });
    await recordAuditEvent({
      trx, critical: true, actor_type: 'admin', actor_id: actorId,
      action: 'payroll.pto_payout_week_changed', resource_type: 'technicians', resource_id: tech.id,
      metadata: { technician_id: tech.id, week_start: v.weekStart },
    });
    return { id: tech.id, ptoPayoutWeekStart: v.weekStart };
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
  setWeekMinimum,
  setPtoPayoutWeek,
};
