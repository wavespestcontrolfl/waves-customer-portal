/**
 * Basic payroll, layer 1b-2b (owner 2026-10-25, "can we start building basic
 * now, and add layers to it at later stages?"): weekly pay runs, the paycheck
 * the portal works out for each W-2 technician, and the pay stub. Dark behind
 * GATE_PAYROLL (the route checks it; these functions only run behind that
 * check).
 *
 * The portal prepares the numbers. The owner pays the technician (paper
 * check, or bank transfer with the employee's written OK) and makes every tax
 * deposit and filing himself. Nothing here moves money or sends a message.
 *
 * A run covers one staff week (Monday-Sunday). A draft takes every W-2
 * technician with an APPROVED weekly timesheet (time_weekly_summary, paid
 * minutes after auto lunch), the pay rate on the technician, and the W-4 in
 * force on the pay date, and runs computePaycheck(). A technician whose
 * paycheck cannot be worked out is listed as blocked with the reason, and a
 * W-2 technician with time but no approved week is listed as waiting. A run
 * cannot be finalized while anyone is blocked or waiting, so nobody is left
 * unpaid without being seen.
 *
 * Year-to-date gross is the sum of FINALIZED, non-voided checks of the same
 * calendar year that come before this one in (pay date, week start) order.
 * That ordering also drives the stub's year-to-date columns, so the two never
 * disagree. Because later checks depend on earlier ones, a run cannot be
 * finalized or voided while a later finalized check exists for the same
 * technician and year: void the later run first.
 *
 * GATE_PAYROLL_TIME_OFF (owner 2026-10-26): a draft also pays the paid time off
 * and holiday days recorded in payroll_time_off (services/payroll-time-off.js)
 * for the week. They are hours not worked: paid at the straight rate on the same
 * check, never counted toward overtime. A W-2 technician with time off and no
 * worked time that week gets a check for the time off alone. Time off never
 * bypasses the timesheet: a technician whose worked time is not approved stays
 * waiting. Gate off, every function here reads and returns what it did before.
 *
 * GATE_PAYROLL_PAY_LINES (owner 2026-10-29, D5 part 1): a draft also pays the open
 * pay lines of services/payroll-pay-lines.js (review bonus, commission, health
 * allowance, employer HSA money) and the extra overtime they cause in the federal
 * regular rate (payroll-regular-rate.js). A W-2 technician with lines and no hours,
 * one who has left too, gets a check for the lines alone. Finalize marks the lines
 * paid in its own transaction; void reopens them. Gate off, every function here
 * reads and returns what it did before.
 *
 * Every write runs in one transaction with row locks. Audit events are
 * critical and carry ids only.
 */
const crypto = require('crypto');
const Joi = require('joi');
const db = require('../models/db');
const { recordAuditEvent } = require('./audit-log');
const { computePaycheck } = require('./payroll-calc');
const { currentW4For, PayrollError } = require('./payroll-w4');
const { csvRow } = require('./csv-generators');
const { syncPayrollFilingsSafe } = require('./payroll-tax-calendar');
const { etDateString, validCalendarDate } = require('../utils/datetime-et');
const {
  STAFF_WORK_DATE_SQL,
  addStaffWorkDays,
  staffWeekStartForWorkDate,
} = require('../utils/staff-time-work-date');
const { WAVES_BUSINESS_NAME, WAVES_ADDRESS_LINE } = require('../constants/business');
const { PAYROLL_LOCK_NS, PAYROLL_LOCK_KEY, lockPayrollMutations } = require('./payroll-lock');
const { shiftCloseReviewLive, payrollTimeOffLive } = require('../config/feature-gates');
const {
  payLinesOn, openLinesFor, priceLines, totalsOf, markLinesPaid, reopenLinesOfRun,
} = require('./payroll-pay-lines');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REASON = 500;
const MAX_CHECK_NUMBER = 30;
const MAX_RUNS = 200;

// payroll_checks column -> computePaycheck output key.
const MONEY_COLUMNS = {
  gross_cents: 'grossPayCents',
  regular_pay_cents: 'regularPayCents',
  overtime_pay_cents: 'overtimePayCents',
  overtime_premium_cents: 'overtimePremiumCents',
  federal_income_tax_cents: 'federalIncomeTaxCents',
  social_security_cents: 'socialSecurityEmployeeCents',
  medicare_cents: 'medicareEmployeeCents',
  additional_medicare_cents: 'additionalMedicareCents',
  net_cents: 'netPayCents',
  employer_social_security_cents: 'socialSecurityEmployerCents',
  employer_medicare_cents: 'medicareEmployerCents',
  futa_cents: 'futaCents',
  fl_reemployment_cents: 'floridaReemploymentCents',
};
const MONEY_KEYS = Object.keys(MONEY_COLUMNS);
const EMPLOYEE_TAX_KEYS = ['federal_income_tax_cents', 'social_security_cents', 'medicare_cents', 'additional_medicare_cents'];
const EMPLOYER_TAX_KEYS = ['employer_social_security_cents', 'employer_medicare_cents', 'futa_cents', 'fl_reemployment_cents'];

// GATE_PAYROLL_TIME_OFF, read at call time. The typeof guard keeps a test mock of
// feature-gates that lacks the reader working (off).
const timeOffOn = () => typeof payrollTimeOffLive === 'function' && payrollTimeOffLive();

// payroll_checks time-off columns, read and written only with the gate on.
const TIME_OFF_MINUTE_COLUMNS = ['pto_minutes', 'holiday_minutes'];
const TIME_OFF_PAY_COLUMNS = ['pto_pay_cents', 'holiday_pay_cents'];
const TIME_OFF_COLUMNS = [...TIME_OFF_MINUTE_COLUMNS, ...TIME_OFF_PAY_COLUMNS];

// GATE_PAYROLL_PAY_LINES: payroll_checks column -> computePaycheck output key. Null on a
// check made with the gate off; read and written only with the gate on.
const PAY_LINE_COLUMNS = {
  review_bonus_cents: 'reviewBonusCents',
  commission_cents: 'commissionCents',
  health_allowance_cents: 'healthAllowanceCents',
  hsa_employer_cents: 'hsaEmployerCents',
  line_overtime_premium_cents: 'lineOvertimePremiumCents',
  qualified_overtime_cents: 'qualifiedOvertimeCents',
  simple_compensation_cents: 'simpleCompensationCents',
};
const PAY_LINE_KEYS = Object.keys(PAY_LINE_COLUMNS);
// A check drafted with the gate on stored its pay line figures (qualified_overtime_cents is
// never null then). It keeps showing them after the gate is turned off, so a paid stub, run
// and CSV still add up; a check drafted with the gate off stored none and shows none.
const storedLines = (row) => row.qualified_overtime_cents != null;

const requireUuid = (id, what) => {
  if (!UUID_RE.test(String(id || ''))) throw new PayrollError(404, `${what} not found.`);
  return String(id);
};

function validate(schema, input) {
  const { value, error } = schema.validate(input || {}, { abortEarly: true, convert: true, allowUnknown: false });
  if (error) throw new PayrollError(400, error.details[0].message);
  return value;
}

const actorOf = (actor) => (actor && typeof actor === 'object' ? actor.id : actor) || null;

const createSchema = Joi.object({
  weekStart: Joi.string().trim().required()
    .messages({ 'any.required': 'Pick a week', 'string.empty': 'Pick a week', 'string.base': 'Pick a week' }),
  payDate: Joi.string().trim().allow('', null).optional()
    .messages({ 'string.base': 'Pay date must be a real date (YYYY-MM-DD)' }),
});
const finalizeSchema = Joi.object({
  token: Joi.string().trim().max(200).required()
    .messages({ 'any.required': 'Reload the pay run before you finalize it', 'string.empty': 'Reload the pay run before you finalize it', 'string.base': 'Reload the pay run before you finalize it' }),
});
const voidSchema = Joi.object({
  reason: Joi.string().trim().min(1).max(MAX_REASON).required()
    .messages({
      'any.required': 'Give a reason for the void', 'string.empty': 'Give a reason for the void', 'string.base': 'Give a reason for the void',
      'string.max': `Reason must be at most ${MAX_REASON} characters`,
    }),
});
const checkNumberSchema = Joi.object({
  checkNumber: Joi.string().trim().min(1).max(MAX_CHECK_NUMBER).pattern(/^[\x20-\x7E]+$/).required()
    .messages({
      'any.required': 'Enter the check number', 'string.empty': 'Enter the check number', 'string.base': 'Enter the check number',
      'string.max': `Check number must be at most ${MAX_CHECK_NUMBER} characters`,
      'string.pattern.base': 'Check number can use letters, numbers and common symbols only',
    }),
});

// ---- Weeks and dates (ET calendar dates as text; never local-time Date parsing)

// The Friday after the week ends: Monday + 11 days.
const defaultPayDate = (weekStart) => addStaffWorkDays(weekStart, 11);

function validateWeek(weekStart, today = etDateString()) {
  const day = validCalendarDate(weekStart);
  if (!day) throw new PayrollError(400, 'Week must be a real date (YYYY-MM-DD)');
  if (staffWeekStartForWorkDate(day) !== day) throw new PayrollError(400, 'The week must start on a Monday');
  const end = addStaffWorkDays(day, 6);
  if (end >= today) throw new PayrollError(409, 'That week is not finished yet. Pick a week that ended.');
  return { start: day, end };
}

function resolvePayDate(start, end, payDate) {
  if (payDate == null || payDate === '') return defaultPayDate(start);
  const day = validCalendarDate(payDate);
  if (!day) throw new PayrollError(400, 'Pay date must be a real date (YYYY-MM-DD)');
  if (day <= end) throw new PayrollError(400, 'Pay date must be after the week ends');
  return day;
}

// ---- Money text

// Integer cents -> '1234.50'. Integer math only.
function centsText(cents) {
  const n = Math.round(Number(cents) || 0);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
const AUTO_CLOSE_BLOCK_REASON = 'An automatic clock-out needs a real time';
const hoursText = (minutes) => (Math.round((Number(minutes) || 0) / 60 * 100) / 100).toFixed(2);

// ---- One paycheck, no database

/**
 * Works out one technician's check. Returns { check } (the row to insert, minus
 * run_id) or { blocked } with a plain reason. Never throws for a calculation
 * problem: the message of computePaycheck becomes the reason.
 */
function buildCheck({ tech, payDate, weekStart, w4, ytdGrossCents }) {
  const withTimeOff = timeOffOn();
  const withLines = payLinesOn();
  // Open pay lines for this technician and the extra overtime they cause (evaluate()).
  const lines = (withLines && tech.pay_lines) || [];
  const linePremium = (withLines && tech.line_premium) || { extraPremiumCents: 0, weeks: [] };
  let pay;
  try {
    pay = computePaycheck({
      payDate,
      payFrequency: 'weekly',
      hourlyRate: tech.pay_rate,
      regularMinutes: tech.regular_minutes,
      overtimeMinutes: tech.overtime_minutes,
      ...(withTimeOff ? { ptoMinutes: tech.pto_minutes || 0, holidayMinutes: tech.holiday_minutes || 0 } : {}),
      ytdGrossWages: centsText(ytdGrossCents),
      w4,
      ...(withLines ? {
        payLines: { ...totalsOf(lines), lineOvertimePremiumCents: linePremium.extraPremiumCents },
        flsaCovered: tech.flsa_overtime_covered === true,
      } : {}),
    });
  } catch (err) {
    return { blocked: (err && err.message) || 'The paycheck could not be worked out' };
  }
  const check = {
    technician_id: tech.technician_id,
    employee_name: tech.name,
    week_start: weekStart,
    pay_date: payDate,
    hourly_rate: tech.pay_rate,
    regular_minutes: tech.regular_minutes,
    overtime_minutes: tech.overtime_minutes,
    ytd_gross_before_cents: ytdGrossCents,
    w4_election_id: w4.id,
    calc_snapshot: JSON.stringify(lines.length ? { ...pay, payLines: lines, lineOvertimeWeeks: linePremium.weeks } : pay),
    pay_method: tech.pay_method || 'check',
    status: 'draft',
  };
  for (const [column, key] of Object.entries(MONEY_COLUMNS)) check[column] = pay[key];
  if (withLines) for (const [column, key] of Object.entries(PAY_LINE_COLUMNS)) check[column] = pay[key];
  if (withTimeOff) {
    check.pto_minutes = tech.pto_minutes || 0;
    check.holiday_minutes = tech.holiday_minutes || 0;
    check.pto_pay_cents = pay.ptoPayCents;
    check.holiday_pay_cents = pay.holidayPayCents;
  }
  return { check };
}

// The pay lines a check holds: ids, kinds, amounts and spans, in id order. A stored row
// carries them as `pay_lines` (calc_snapshot->'payLines'); a row about to be stored
// carries them in its calc_snapshot text.
function payLinesSignature(row) {
  let lines = row.pay_lines;
  if (!('pay_lines' in row) && typeof row.calc_snapshot === 'string') {
    try { lines = JSON.parse(row.calc_snapshot).payLines; } catch { lines = null; }
  }
  return (Array.isArray(lines) ? lines : [])
    .map((l) => [l.id, l.kind, Number(l.amountCents), l.earnedWeekStart, l.coversFrom || null, l.coversTo || null])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// A token over everything that decides the numbers on a run. It is computed from
// rows as stored (strings from Postgres) and from rows about to be stored
// (numbers), so every value is normalized first.
function tokenOf(run, rows) {
  const withTimeOff = timeOffOn();
  const withLines = payLinesOn();
  const parts = rows.map((row) => [
    row.technician_id,
    Number(row.hourly_rate).toFixed(2),
    Number(row.regular_minutes).toFixed(2),
    Number(row.overtime_minutes).toFixed(2),
    row.pay_method,
    row.w4_election_id,
    Number(row.ytd_gross_before_cents),
    ...MONEY_KEYS.map((key) => Number(row[key])),
    // A time-off change after drafting changes the token, so finalize asks for a reload.
    ...(withTimeOff ? [
      ...TIME_OFF_MINUTE_COLUMNS.map((key) => Number(row[key] || 0).toFixed(2)),
      ...TIME_OFF_PAY_COLUMNS.map((key) => Number(row[key] || 0)),
    ] : []),
    // Adding, removing or changing a pay line after drafting changes the token too.
    ...(withLines ? [...PAY_LINE_KEYS.map((key) => Number(row[key] || 0)), payLinesSignature(row)] : []),
  ]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return crypto.createHash('sha256').update(JSON.stringify([run.week_start, run.pay_date, parts])).digest('hex').slice(0, 32);
}

function sumRows(rows) {
  const total = (keys) => rows.reduce((sum, row) => sum + keys.reduce((s, k) => s + Number(row[k] || 0), 0), 0);
  return {
    checkCount: rows.length,
    grossCents: total(['gross_cents']),
    employeeTaxesCents: total(EMPLOYEE_TAX_KEYS),
    netCents: total(['net_cents']),
    employerTaxesCents: total(EMPLOYER_TAX_KEYS),
    ...(timeOffOn() ? { ptoPayCents: total(['pto_pay_cents']), holidayPayCents: total(['holiday_pay_cents']) } : {}),
  };
}

// ---- Reading

const runColumns = (conn) => [
  'id', 'status', 'void_reason', 'created_by', 'finalized_by', 'voided_by',
  conn.raw("to_char(week_start, 'YYYY-MM-DD') as week_start"),
  conn.raw("to_char(pay_date, 'YYYY-MM-DD') as pay_date"),
  'created_at', 'finalized_at', 'voided_at',
];

const checkColumns = (conn) => [
  'id', 'run_id', 'technician_id', 'employee_name', 'hourly_rate', 'regular_minutes', 'overtime_minutes',
  ...MONEY_KEYS, ...(timeOffOn() ? TIME_OFF_COLUMNS : []),
  ...PAY_LINE_KEYS, conn.raw("calc_snapshot->'payLines' as pay_lines"),
  'ytd_gross_before_cents', 'w4_election_id', 'pay_method', 'check_number', 'status',
  conn.raw("to_char(week_start, 'YYYY-MM-DD') as week_start"),
  conn.raw("to_char(pay_date, 'YYYY-MM-DD') as pay_date"),
];

const iso = (value) => (value ? new Date(value).toISOString() : null);

function serializeCheck(row) {
  return {
    id: row.id,
    technicianId: row.technician_id,
    name: row.employee_name,
    status: row.status,
    hourlyRate: row.hourly_rate,
    regularMinutes: Number(row.regular_minutes),
    overtimeMinutes: Number(row.overtime_minutes),
    regularHours: hoursText(row.regular_minutes),
    overtimeHours: hoursText(row.overtime_minutes),
    payMethod: row.pay_method,
    checkNumber: row.check_number || null,
    grossCents: Number(row.gross_cents),
    regularPayCents: Number(row.regular_pay_cents),
    overtimePayCents: Number(row.overtime_pay_cents),
    federalIncomeTaxCents: Number(row.federal_income_tax_cents),
    socialSecurityCents: Number(row.social_security_cents),
    medicareCents: Number(row.medicare_cents),
    additionalMedicareCents: Number(row.additional_medicare_cents),
    netCents: Number(row.net_cents),
    employerSocialSecurityCents: Number(row.employer_social_security_cents),
    employerMedicareCents: Number(row.employer_medicare_cents),
    futaCents: Number(row.futa_cents),
    flReemploymentCents: Number(row.fl_reemployment_cents),
    ytdGrossBeforeCents: Number(row.ytd_gross_before_cents),
    ...(timeOffOn() ? {
      ptoMinutes: Number(row.pto_minutes || 0),
      holidayMinutes: Number(row.holiday_minutes || 0),
      ptoHours: hoursText(row.pto_minutes),
      holidayHours: hoursText(row.holiday_minutes),
      ptoPayCents: Number(row.pto_pay_cents || 0),
      holidayPayCents: Number(row.holiday_pay_cents || 0),
    } : {}),
    ...(payLinesOn() || storedLines(row) ? {
      reviewBonusCents: Number(row.review_bonus_cents || 0),
      commissionCents: Number(row.commission_cents || 0),
      healthAllowanceCents: Number(row.health_allowance_cents || 0),
      hsaEmployerCents: Number(row.hsa_employer_cents || 0),
      lineOvertimePremiumCents: Number(row.line_overtime_premium_cents || 0),
      payLines: Array.isArray(row.pay_lines) ? row.pay_lines : [],
    } : {}),
  };
}

async function loadRun(conn, id, { lock = false } = {}) {
  const query = conn('payroll_runs').where({ id });
  if (lock) query.forUpdate();
  const run = await query.first(runColumns(conn));
  if (!run) throw new PayrollError(404, 'Pay run not found.');
  return run;
}

const loadCheckRows = (conn, runId, { lock = false } = {}) => {
  const query = conn('payroll_checks').where({ run_id: runId }).orderBy([{ column: 'employee_name' }, { column: 'technician_id' }]);
  if (lock) query.forUpdate();
  return query.select(checkColumns(conn));
};

// Technicians with worked time in the week, approved or not. Same test as the
// timesheet approval screen, so "waiting" matches what the office sees there.
async function workedTechnicianIds(conn, start, end) {
  const daily = await conn('time_entry_daily_summary')
    .where('work_date', '>=', start)
    .where('work_date', '<=', end)
    .whereRaw(`(
      COALESCE(total_shift_minutes, 0) <> 0
      OR COALESCE(total_job_minutes, 0) <> 0
      OR COALESCE(total_drive_minutes, 0) <> 0
      OR COALESCE(total_break_minutes, 0) <> 0
      OR COALESCE(total_admin_minutes, 0) <> 0
      OR COALESCE(job_count, 0) <> 0
    )`)
    .select('technician_id');
  const entries = await conn('time_entries')
    .whereRaw(`${STAFF_WORK_DATE_SQL} BETWEEN ?::date AND ?::date`, [start, end])
    .where('status', '!=', 'voided')
    .select('technician_id');
  return [...new Set([...daily, ...entries].map((row) => row.technician_id))];
}

// GATE_PAYROLL_PAY_LINES: a line's overtime is priced from the approved hours of every
// week it covers. A covered week that holds worked time but no approved timesheet would
// price as no hours, and the line would be paid without that week's overtime for good.
// Map of technician id -> the oldest such week; that technician waits until it is approved.
async function lineWeeksWaiting(conn, priced) {
  const techsByWeek = new Map();
  for (const [technicianId, { missingWeeks = [] }] of priced) {
    for (const week of missingWeeks) techsByWeek.set(week, [...(techsByWeek.get(week) || []), technicianId]);
  }
  const waitingOn = new Map();
  for (const week of [...techsByWeek.keys()].sort()) {
    const worked = new Set(await workedTechnicianIds(conn, week, addStaffWorkDays(week, 6)));
    for (const technicianId of techsByWeek.get(week)) {
      if (worked.has(technicianId) && !waitingOn.has(technicianId)) waitingOn.set(technicianId, week);
    }
  }
  return waitingOn;
}

// GATE_SHIFT_CLOSE_REVIEW: a covered week that holds a shift the system closed (the 11 PM
// job or the 14-hour check) that no admin has edited or confirmed may hold wrong hours, so
// a line priced from it is held like the run's own week. Map of technician id -> the
// oldest such week.
async function lineWeeksUnreviewed(conn, priced) {
  const heldOn = new Map();
  for (const [technicianId, { coveredWeeks = [] }] of priced) {
    if (!coveredWeeks.length) continue;
    const covered = new Set(coveredWeeks);
    const rows = await conn('time_entries')
      .where({ technician_id: technicianId, entry_type: 'shift' })
      .whereNotNull('auto_closed_at')
      .whereNull('auto_close_reviewed_at')
      .whereNot({ status: 'voided' })
      .whereRaw(`${STAFF_WORK_DATE_SQL} BETWEEN ?::date AND ?::date`, [coveredWeeks[0], addStaffWorkDays(coveredWeeks[coveredWeeks.length - 1], 6)])
      .select(conn.raw(`to_char(${STAFF_WORK_DATE_SQL}, 'YYYY-MM-DD') as work_date`));
    const weeks = rows.map((row) => staffWeekStartForWorkDate(row.work_date)).filter((week) => covered.has(week)).sort();
    if (weeks.length) heldOn.set(technicianId, weeks[0]);
  }
  return heldOn;
}

// GATE_PAYROLL_TIME_OFF: paid time off and holiday minutes of W-2 technicians
// dated inside the week, summed per technician. Map of id -> { pto, holiday }.
async function timeOffByTechnician(conn, start, end) {
  const rows = await conn('payroll_time_off as o')
    .join('technicians as t', 't.id', 'o.technician_id')
    .where('o.work_date', '>=', start)
    .where('o.work_date', '<=', end)
    .where('t.employment_type', 'w2')
    .groupBy('o.technician_id', 'o.kind')
    .select('o.technician_id', 'o.kind', conn.raw('SUM(o.minutes) AS minutes'));
  const byTech = new Map();
  for (const row of rows) {
    const entry = byTech.get(row.technician_id) || { pto: 0, holiday: 0 };
    entry[row.kind === 'holiday' ? 'holiday' : 'pto'] = Number(row.minutes);
    byTech.set(row.technician_id, entry);
  }
  return byTech;
}

// Year-to-date gross before a pay date, in cents: finalized, non-voided checks
// of the same calendar year that sort before (payDate, weekStart).
async function ytdBefore(conn, technicianIds, payDate, weekStart) {
  if (!technicianIds.length) return new Map();
  const year = payDate.slice(0, 4);
  const rows = await conn('payroll_checks')
    .where('status', 'finalized')
    .whereIn('technician_id', technicianIds)
    .where('pay_date', '>=', `${year}-01-01`)
    .where('pay_date', '<=', `${year}-12-31`)
    .where(function before() {
      this.where('pay_date', '<', payDate).orWhere(function sameDay() {
        this.where('pay_date', payDate).andWhere('week_start', '<', weekStart);
      });
    })
    .groupBy('technician_id')
    .select('technician_id', conn.raw('SUM(gross_cents) AS ytd'));
  return new Map(rows.map((row) => [row.technician_id, Number(row.ytd)]));
}

/**
 * Works out the whole run from current data: { checks, blocked, waiting }.
 * With lock, the approved weekly rows are locked FOR UPDATE, so an unlock of
 * that week waits for this transaction (unlockWeek then sees the finalized check).
 */
async function evaluate(conn, run, { lock = false } = {}) {
  const start = run.week_start;
  const end = addStaffWorkDays(start, 6);
  const approvedQuery = conn('time_weekly_summary as w')
    .join('technicians as t', 't.id', 'w.technician_id')
    .where('w.week_start', start)
    .where('w.status', 'approved')
    .where('t.employment_type', 'w2')
    .orderBy([{ column: 't.name' }, { column: 'w.technician_id' }])
    .select('w.technician_id', 'w.regular_minutes', 'w.overtime_minutes', 't.name', 't.pay_rate', 't.pay_method',
      ...(payLinesOn() ? ['t.flsa_overtime_covered'] : []));
  if (lock) approvedQuery.forUpdate('w');
  const approved = await approvedQuery;
  const approvedIds = new Set(approved.map((row) => row.technician_id));

  const worked = (await workedTechnicianIds(conn, start, end)).filter((id) => !approvedIds.has(id));
  const waitingRows = worked.length
    ? await conn('technicians').whereIn('id', worked).where({ employment_type: 'w2' }).orderBy('name').select('id', 'name')
    : [];
  const waiting = waitingRows.map((row) => ({
    technicianId: row.id, name: row.name, reason: 'Timesheet for this week is not approved yet',
  }));

  const workedRows = approved.filter((row) => Number(row.regular_minutes || 0) + Number(row.overtime_minutes || 0) > 0);
  let withHours = workedRows;
  // Time off rides on the worked check, or makes a check of its own when nothing
  // was worked. A technician whose worked time waits for approval stays waiting.
  let timeOffOnlyRows = [];
  if (timeOffOn()) {
    const timeOff = await timeOffByTechnician(conn, start, end);
    const waitingIds = new Set(worked);
    withHours = workedRows.map((row) => {
      const off = timeOff.get(row.technician_id);
      return { ...row, pto_minutes: off ? off.pto : 0, holiday_minutes: off ? off.holiday : 0 };
    });
    const workedIds = new Set(workedRows.map((row) => row.technician_id));
    const offOnlyIds = [...timeOff.keys()].filter((id) => !workedIds.has(id) && !waitingIds.has(id));
    if (offOnlyIds.length) {
      const techs = await conn('technicians').whereIn('id', offOnlyIds).where({ employment_type: 'w2' })
        .orderBy([{ column: 'name' }, { column: 'id' }])
        .select('id', 'name', 'pay_rate', 'pay_method', ...(payLinesOn() ? ['flsa_overtime_covered'] : []));
      timeOffOnlyRows = techs.map((row) => ({
        technician_id: row.id, name: row.name, pay_rate: row.pay_rate, pay_method: row.pay_method,
        flsa_overtime_covered: row.flsa_overtime_covered,
        regular_minutes: 0, overtime_minutes: 0,
        pto_minutes: timeOff.get(row.id).pto, holiday_minutes: timeOff.get(row.id).holiday,
      }));
    }
  }
  // GATE_PAYROLL_PAY_LINES: open pay lines ride on the technician's check. A technician
  // with lines and no hours (one who has left too) gets a check for the lines alone,
  // unless their worked time is still waiting for approval.
  const lineMap = payLinesOn() ? await openLinesFor(conn, end, { lock }) : new Map();
  const priced = lineMap.size ? await priceLines(conn, lineMap, { lock }) : new Map();
  const haveCheck = new Set([...withHours, ...timeOffOnlyRows].map((row) => row.technician_id));
  const waitingTechIds = new Set(worked);
  // A line that covers an earlier week whose worked time is not approved yet cannot be
  // priced: the technician waits, and gets no check on this run until that week is approved.
  const lineWait = priced.size ? await lineWeeksWaiting(conn, priced) : new Map();
  for (const [technicianId, week] of lineWait) {
    if (waitingTechIds.has(technicianId)) continue;
    waitingTechIds.add(technicianId);
    waiting.push({
      technicianId,
      name: lineMap.get(technicianId).tech.name,
      reason: `Timesheet for the week of ${week} is not approved yet, and a pay line covers that week`,
    });
  }
  const linesOnlyRows = [...lineMap.values()]
    .filter(({ tech }) => !haveCheck.has(tech.technician_id) && !waitingTechIds.has(tech.technician_id))
    .map(({ tech }) => ({ ...tech, regular_minutes: 0, overtime_minutes: 0, pto_minutes: 0, holiday_minutes: 0 }));
  const ytd = await ytdBefore(conn, [...withHours, ...timeOffOnlyRows, ...linesOnlyRows].map((row) => row.technician_id), run.pay_date, start);
  // GATE_SHIFT_CLOSE_REVIEW: a week holding a shift the system closed (the
  // 11 PM job or the 14-hour check) that no admin has edited or confirmed
  // cannot be paid yet. Minutes are not changed; the line is only held.
  const unreviewed = shiftCloseReviewLive() && withHours.length
    ? new Set((await conn('time_entries')
      .whereIn('technician_id', withHours.map((row) => row.technician_id))
      .where({ entry_type: 'shift' })
      .whereNotNull('auto_closed_at')
      .whereNull('auto_close_reviewed_at')
      .whereNot({ status: 'voided' })
      .whereRaw(`${STAFF_WORK_DATE_SQL} BETWEEN ?::date AND ?::date`, [start, end])
      .distinct('technician_id')).map((row) => row.technician_id))
    : new Set();
  // The same hold for every earlier week a pay line takes its overtime from.
  const lineUnreviewed = shiftCloseReviewLive() && priced.size ? await lineWeeksUnreviewed(conn, priced) : new Map();
  const checks = [];
  const blocked = [];
  for (const row of [...withHours, ...timeOffOnlyRows, ...linesOnlyRows]) {
    if (lineWait.has(row.technician_id)) continue;
    const held = lineMap.get(row.technician_id);
    const tech = held ? { ...row, pay_lines: held.lines, line_premium: priced.get(row.technician_id) } : row;
    if (unreviewed.has(tech.technician_id)) {
      blocked.push({ technicianId: tech.technician_id, name: tech.name, reason: AUTO_CLOSE_BLOCK_REASON });
      continue;
    }
    if (lineUnreviewed.has(tech.technician_id)) {
      blocked.push({
        technicianId: tech.technician_id,
        name: tech.name,
        reason: `${AUTO_CLOSE_BLOCK_REASON} in the week of ${lineUnreviewed.get(tech.technician_id)}, which a pay line covers`,
      });
      continue;
    }
    const w4 = await currentW4For(tech.technician_id, run.pay_date, conn);
    const built = buildCheck({
      tech, payDate: run.pay_date, weekStart: start, w4, ytdGrossCents: ytd.get(tech.technician_id) || 0,
    });
    if (built.blocked) blocked.push({ technicianId: tech.technician_id, name: tech.name, reason: built.blocked });
    else checks.push({ ...built.check, run_id: run.id });
  }
  return { checks, blocked, waiting, lines: lineMap };
}

async function runView(conn, runId, { evaluation = null } = {}) {
  const run = await loadRun(conn, runId);
  const rows = await loadCheckRows(conn, runId);
  const view = {
    id: run.id,
    weekStart: run.week_start,
    weekEnd: addStaffWorkDays(run.week_start, 6),
    payDate: run.pay_date,
    status: run.status,
    createdAt: iso(run.created_at),
    finalizedAt: iso(run.finalized_at),
    voidedAt: iso(run.voided_at),
    voidReason: run.void_reason || null,
    checks: rows.map(serializeCheck),
    blocked: [],
    waiting: [],
    stale: false,
    totals: sumRows(rows),
    token: tokenOf(run, rows),
  };
  if (run.status === 'draft') {
    const live = evaluation || await evaluate(conn, run);
    view.blocked = live.blocked;
    view.waiting = live.waiting;
    view.stale = tokenOf(run, live.checks) !== view.token;
  }
  return view;
}

async function listRuns(conn = db) {
  const runs = await conn('payroll_runs')
    .orderBy([{ column: 'week_start', order: 'desc' }, { column: 'created_at', order: 'desc' }])
    .limit(MAX_RUNS)
    .select(runColumns(conn));
  if (!runs.length) return [];
  const rows = await conn('payroll_checks').whereIn('run_id', runs.map((run) => run.id))
    .select(['run_id', ...MONEY_KEYS, ...(timeOffOn() ? TIME_OFF_PAY_COLUMNS : [])]);
  const byRun = new Map();
  for (const row of rows) {
    if (!byRun.has(row.run_id)) byRun.set(row.run_id, []);
    byRun.get(row.run_id).push(row);
  }
  return runs.map((run) => ({
    id: run.id,
    weekStart: run.week_start,
    weekEnd: addStaffWorkDays(run.week_start, 6),
    payDate: run.pay_date,
    status: run.status,
    createdAt: iso(run.created_at),
    finalizedAt: iso(run.finalized_at),
    voidedAt: iso(run.voided_at),
    totals: sumRows(byRun.get(run.id) || []),
  }));
}

async function getRun(runId, conn = db) {
  requireUuid(runId, 'Pay run');
  return runView(conn, runId);
}

// ---- Writing

const audit = (trx, actorId, action, resourceType, resourceId, metadata) => recordAuditEvent({
  trx, critical: true, actor_type: 'admin', actor_id: actorId, action, resource_type: resourceType, resource_id: resourceId, metadata,
});

async function replaceDraftChecks(trx, runId, checks) {
  await trx('payroll_checks').where({ run_id: runId, status: 'draft' }).del();
  if (checks.length) await trx('payroll_checks').insert(checks);
}

function describeProblems({ blocked, waiting }) {
  const parts = [
    ...waiting.map((w) => `${w.name}: ${w.reason}`),
    ...blocked.map((b) => `${b.name}: ${b.reason}`),
  ];
  return `Fix these before you finalize. ${parts.join('. ')}.`;
}

async function draftRun(input, actor, conn = db) {
  const v = validate(createSchema, input);
  const { start, end } = validateWeek(v.weekStart);
  const payDate = resolvePayDate(start, end, v.payDate);
  const actorId = actorOf(actor);
  const taken = new PayrollError(409, 'That week already has a pay run. Open it, or void it first.');
  let runId;
  try {
    runId = await conn.transaction(async (trx) => {
      if (await trx('payroll_runs').where({ week_start: start }).whereNot({ status: 'voided' }).forUpdate().first('id')) throw taken;
      const [inserted] = await trx('payroll_runs').insert({ week_start: start, pay_date: payDate, created_by: actorId }).returning('id');
      const id = inserted && inserted.id ? inserted.id : inserted;
      const run = await loadRun(trx, id);
      const evaluation = await evaluate(trx, run, { lock: true });
      if (!evaluation.checks.length && !evaluation.blocked.length && !evaluation.waiting.length) {
        throw new PayrollError(409, 'No W-2 hours to pay for that week.');
      }
      await replaceDraftChecks(trx, id, evaluation.checks);
      await audit(trx, actorId, 'payroll.run_drafted', 'payroll_runs', id, { run_id: id });
      return id;
    });
  } catch (err) {
    if (err && err.code === '23505') throw taken;
    throw err;
  }
  return runView(conn, runId);
}

async function recomputeRun(runId, actor, conn = db) {
  requireUuid(runId, 'Pay run');
  const actorId = actorOf(actor);
  await conn.transaction(async (trx) => {
    const run = await loadRun(trx, runId, { lock: true });
    if (run.status !== 'draft') throw new PayrollError(409, 'Only a draft pay run can be recomputed.');
    const evaluation = await evaluate(trx, run, { lock: true });
    await replaceDraftChecks(trx, runId, evaluation.checks);
    await audit(trx, actorId, 'payroll.run_recomputed', 'payroll_runs', runId, { run_id: runId });
  });
  return runView(conn, runId);
}

// One lock for every payroll mutation that reads or changes year-to-date
// figures: finalize and void. Each run locks only its own rows, so two runs for
// different weeks could otherwise both read the same YTD, or a void could pass
// while a later finalize counted the run it voids. Same idiom as
// payment-method-lock.js: pg_advisory_xact_lock(hashtext(ns), hashtext(key)),
// released when the transaction ends. Take it before the first read.
// Draft and recompute do not take it: they write draft rows only, never feed
// another run, and finalize re-evaluates under this lock and compares the
// review token, so a draft built on stale YTD cannot be finalized.
// The lock itself lives in payroll-lock.js (time-tracking.js takes it shared).

// A later finalized check for the same technician and year already counted this
// one's pay in its year-to-date figures.
async function laterFinalCheckExists(trx, run, technicianIds) {
  if (!technicianIds.length) return false;
  const year = run.pay_date.slice(0, 4);
  const found = await trx('payroll_checks')
    .where('status', 'finalized')
    .whereIn('technician_id', technicianIds)
    .where('pay_date', '>=', `${year}-01-01`)
    .where('pay_date', '<=', `${year}-12-31`)
    .where(function later() {
      this.where('pay_date', '>', run.pay_date).orWhere(function sameDay() {
        this.where('pay_date', run.pay_date).andWhere('week_start', '>', run.week_start);
      });
    })
    .whereNot({ run_id: run.id })
    .first('id');
  return Boolean(found);
}

async function finalizeRun(runId, input, actor, conn = db) {
  requireUuid(runId, 'Pay run');
  const v = validate(finalizeSchema, input);
  const actorId = actorOf(actor);
  let changed = false;
  await conn.transaction(async (trx) => {
    await lockPayrollMutations(trx);
    const run = await loadRun(trx, runId, { lock: true });
    if (run.status !== 'draft') throw new PayrollError(409, `This pay run is already ${run.status}.`);
    const evaluation = await evaluate(trx, run, { lock: true });
    if (evaluation.blocked.length || evaluation.waiting.length) throw new PayrollError(409, describeProblems(evaluation));
    if (!evaluation.checks.length) throw new PayrollError(409, 'There are no paychecks to finalize.');
    if (await laterFinalCheckExists(trx, run, evaluation.checks.map((check) => check.technician_id))) {
      throw new PayrollError(409, 'A later pay run is already final. Void it first, then finalize this one.');
    }
    await replaceDraftChecks(trx, runId, evaluation.checks);
    const rows = await loadCheckRows(trx, runId);
    if (tokenOf(run, rows) !== v.token) {
      // Keep the fresh numbers as the draft, so the screen shows what changed.
      changed = true;
      await audit(trx, actorId, 'payroll.run_recomputed', 'payroll_runs', runId, { run_id: runId });
      return;
    }
    const now = trx.fn.now();
    await trx('payroll_checks').where({ run_id: runId, status: 'draft' }).update({ status: 'finalized' });
    // The lines this run paid stay locked from the evaluation above; mark them paid with their check.
    if (payLinesOn()) await markLinesPaid(trx, runId, evaluation.lines);
    await trx('payroll_runs').where({ id: runId }).update({ status: 'finalized', finalized_by: actorId, finalized_at: now });
    await audit(trx, actorId, 'payroll.run_finalized', 'payroll_runs', runId, { run_id: runId });
  });
  if (changed) throw new PayrollError(409, 'Hours or settings changed. Review the new numbers.');
  // Tax calendar rows follow the finalized checks. Never fails the finalize.
  await syncPayrollFilingsSafe({ conn });
  return runView(conn, runId);
}

async function voidRun(runId, input, actor, conn = db) {
  requireUuid(runId, 'Pay run');
  const v = validate(voidSchema, input);
  const actorId = actorOf(actor);
  await conn.transaction(async (trx) => {
    await lockPayrollMutations(trx);
    const run = await loadRun(trx, runId, { lock: true });
    if (run.status === 'voided') throw new PayrollError(409, 'This pay run is already voided.');
    const rows = await loadCheckRows(trx, runId, { lock: true });
    if (run.status === 'finalized' && await laterFinalCheckExists(trx, run, rows.map((row) => row.technician_id))) {
      throw new PayrollError(409, 'A later pay run is already final. Void it first.');
    }
    await trx('payroll_checks').where({ run_id: runId }).whereIn('status', ['draft', 'finalized']).update({ status: 'voided' });
    // Not behind the gate: a line a finalized run paid must reopen even if the gate was turned off since.
    await reopenLinesOfRun(trx, runId);
    await trx('payroll_runs').where({ id: runId }).update({
      status: 'voided', voided_by: actorId, voided_at: trx.fn.now(), void_reason: v.reason,
    });
    await audit(trx, actorId, 'payroll.run_voided', 'payroll_runs', runId, { run_id: runId });
  });
  await syncPayrollFilingsSafe({ conn });
  return runView(conn, runId);
}

async function setCheckNumber(checkId, input, actor, conn = db) {
  requireUuid(checkId, 'Paycheck');
  const v = validate(checkNumberSchema, input);
  const actorId = actorOf(actor);
  await conn.transaction(async (trx) => {
    const check = await trx('payroll_checks').where({ id: checkId }).forUpdate().first('id', 'run_id', 'status', 'pay_method');
    if (!check) throw new PayrollError(404, 'Paycheck not found.');
    if (check.status !== 'finalized') throw new PayrollError(409, 'A check number can be set once the pay run is final.');
    if (check.pay_method !== 'check') throw new PayrollError(409, 'Check numbers are for paper checks only.');
    await trx('payroll_checks').where({ id: checkId }).update({ check_number: v.checkNumber });
    await audit(trx, actorId, 'payroll.check_number_set', 'payroll_checks', checkId, { check_id: checkId, run_id: check.run_id });
  });
  const row = await conn('payroll_checks').where({ id: checkId }).first(checkColumns(conn));
  return serializeCheck(row);
}

// ---- Stub

async function getStub(checkId, conn = db) {
  requireUuid(checkId, 'Paycheck');
  const check = await conn('payroll_checks').where({ id: checkId }).first(checkColumns(conn));
  if (!check) throw new PayrollError(404, 'Paycheck not found.');
  if (check.status === 'draft') throw new PayrollError(409, 'Finalize the pay run to see the stub.');
  if (check.status === 'voided') throw new PayrollError(409, 'This paycheck was voided.');
  const tech = await conn('technicians').where({ id: check.technician_id }).first('ssn_last4');
  const ssnLast4 = tech && /^\d{4}$/.test(String(tech.ssn_last4 || '')) ? String(tech.ssn_last4) : null;
  const year = check.pay_date.slice(0, 4);
  const ytd = await conn('payroll_checks')
    .where({ technician_id: check.technician_id, status: 'finalized' })
    .where('pay_date', '>=', `${year}-01-01`)
    .where('pay_date', '<=', `${year}-12-31`)
    .where(function upToThis() {
      this.where('pay_date', '<', check.pay_date).orWhere(function sameDay() {
        this.where('pay_date', check.pay_date).andWhere('week_start', '<=', check.week_start);
      });
    })
    .first(
      conn.raw('COALESCE(SUM(gross_cents), 0) AS gross'),
      conn.raw('COALESCE(SUM(federal_income_tax_cents), 0) AS federal_income_tax'),
      conn.raw('COALESCE(SUM(social_security_cents), 0) AS social_security'),
      conn.raw('COALESCE(SUM(medicare_cents), 0) AS medicare'),
      conn.raw('COALESCE(SUM(additional_medicare_cents), 0) AS additional_medicare'),
      conn.raw('COALESCE(SUM(net_cents), 0) AS net'),
    );
  const c = serializeCheck(check);
  // Gate on, or a check that stored pay line figures (drafted while it was on).
  const withLines = 'reviewBonusCents' in c;
  const withheld = c.federalIncomeTaxCents + c.socialSecurityCents + c.medicareCents + c.additionalMedicareCents;
  return {
    checkId: c.id,
    runId: check.run_id,
    employer: { name: WAVES_BUSINESS_NAME, addressLine: WAVES_ADDRESS_LINE },
    employee: { name: c.name, ssnLast4 },
    payPeriod: { start: check.week_start, end: addStaffWorkDays(check.week_start, 6) },
    payDate: check.pay_date,
    hours: {
      regular: c.regularHours,
      overtime: c.overtimeHours,
      ...(timeOffOn() ? { pto: c.ptoHours, holiday: c.holidayHours } : {}),
    },
    hourlyRate: c.hourlyRate,
    earnings: {
      regularPayCents: c.regularPayCents,
      overtimePayCents: c.overtimePayCents,
      ...(timeOffOn() ? { ptoPayCents: c.ptoPayCents, holidayPayCents: c.holidayPayCents } : {}),
      ...(withLines ? {
        reviewBonusCents: c.reviewBonusCents,
        commissionCents: c.commissionCents,
        healthAllowanceCents: c.healthAllowanceCents,
        lineOvertimePremiumCents: c.lineOvertimePremiumCents,
      } : {}),
      grossCents: c.grossCents,
    },
    // The employer HSA money is not wages: it is not in gross pay, taxes or net pay.
    ...(withLines ? { employerContributions: { hsaCents: c.hsaEmployerCents } } : {}),
    taxes: {
      federalIncomeTaxCents: c.federalIncomeTaxCents,
      socialSecurityCents: c.socialSecurityCents,
      medicareCents: c.medicareCents,
      additionalMedicareCents: c.additionalMedicareCents,
      totalCents: withheld,
    },
    netCents: c.netCents,
    payMethod: c.payMethod,
    checkNumber: c.checkNumber,
    ytd: {
      grossCents: Number(ytd.gross),
      federalIncomeTaxCents: Number(ytd.federal_income_tax),
      socialSecurityCents: Number(ytd.social_security),
      medicareCents: Number(ytd.medicare),
      additionalMedicareCents: Number(ytd.additional_medicare),
      netCents: Number(ytd.net),
    },
  };
}

// ---- CSV

const CSV_HEADERS = [
  'Employee', 'Regular Hours', 'Overtime Hours', 'Hourly Rate', 'Gross Pay', 'Federal Income Tax',
  'Social Security', 'Medicare', 'Additional Medicare', 'Net Pay', 'Employer Social Security',
  'Employer Medicare', 'FUTA', 'FL Reemployment Tax', 'Pay Method', 'Check Number',
];

// Appended at the END, gate on only, so a reader of the old columns keeps working.
const CSV_TIME_OFF_HEADERS = ['PTO Hours', 'PTO Pay', 'Holiday Hours', 'Holiday Pay'];
// After those, gate GATE_PAYROLL_PAY_LINES on only. HSA From Waves is not in Gross Pay.
const CSV_PAY_LINE_HEADERS = ['Review Bonus', 'Commission', 'Health Allowance', 'Overtime On Bonus And Allowance', 'HSA From Waves'];

function checksToCsv(rows) {
  const withTimeOff = timeOffOn();
  // Gate on, or a check in the run that stored pay line figures (drafted while it was on).
  const withLines = payLinesOn() || rows.some(storedLines);
  const lines = [csvRow([...CSV_HEADERS, ...(withTimeOff ? CSV_TIME_OFF_HEADERS : []), ...(withLines ? CSV_PAY_LINE_HEADERS : [])])];
  for (const row of rows) {
    const c = serializeCheck(row);
    lines.push(csvRow([
      c.name, c.regularHours, c.overtimeHours, c.hourlyRate, centsText(c.grossCents),
      centsText(c.federalIncomeTaxCents), centsText(c.socialSecurityCents), centsText(c.medicareCents),
      centsText(c.additionalMedicareCents), centsText(c.netCents), centsText(c.employerSocialSecurityCents),
      centsText(c.employerMedicareCents), centsText(c.futaCents), centsText(c.flReemploymentCents),
      c.payMethod === 'bank_transfer' ? 'Bank transfer' : 'Paper check', c.checkNumber || '',
      ...(withTimeOff ? [c.ptoHours, centsText(c.ptoPayCents), c.holidayHours, centsText(c.holidayPayCents)] : []),
      ...(withLines ? [
        centsText(c.reviewBonusCents), centsText(c.commissionCents), centsText(c.healthAllowanceCents),
        centsText(c.lineOvertimePremiumCents), centsText(c.hsaEmployerCents),
      ] : []),
    ]));
  }
  return lines.join('\n');
}

async function exportCsv(runId, conn = db) {
  requireUuid(runId, 'Pay run');
  const run = await loadRun(conn, runId);
  if (run.status === 'voided') throw new PayrollError(409, 'This pay run was voided.');
  const rows = await loadCheckRows(conn, runId);
  return { filename: `pay-run-${run.week_start}.csv`, csv: checksToCsv(rows) };
}

module.exports = {
  defaultPayDate,
  validateWeek,
  resolvePayDate,
  centsText,
  buildCheck,
  tokenOf,
  checksToCsv,
  listRuns,
  getRun,
  draftRun,
  recomputeRun,
  finalizeRun,
  voidRun,
  setCheckNumber,
  getStub,
  exportCsv,
  lockPayrollMutations,
  PAYROLL_LOCK_NS,
  PAYROLL_LOCK_KEY,
};
