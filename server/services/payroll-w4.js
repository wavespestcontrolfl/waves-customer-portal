/**
 * Basic payroll, layer 1b-2a (owner 2026-10-25, "can we start building basic
 * now, and add layers to it at later stages?"): the Form W-4 elections and the
 * pay method of each W-2 technician. Dark behind GATE_PAYROLL (the route checks
 * it; these functions only run behind that check).
 *
 * The legal W-4 stays on PAPER: it carries the SSN and the employee's
 * signature, and the employer keeps it 4 years. An admin types the elections
 * from the signed form into payroll_w4_elections. No SSN and no bank account
 * number enter the portal. Rows are evidence (a trigger blocks UPDATE and
 * DELETE); a correction is a new row.
 *
 * currentW4For() is what a pay run calls. It returns the election in exactly the
 * shape computePaycheck() takes as `w4`.
 *
 * Pay is by paper check, or by bank transfer only with the employee's written
 * OK (Florida law). The portal records the method and the date that OK was
 * received, nothing else.
 */
const Joi = require('joi');
const db = require('../models/db');
const { recordAuditEvent } = require('./audit-log');
const { etDateString, validCalendarDate } = require('../utils/datetime-et');
const { payrollTimeOffLive, payrollPayLinesLive, payrollFamilyEmployeeLive, payrollMercuryStatusLive } = require('../config/feature-gates');
const { rollIrs } = require('./payroll-tax-calendar');

const FILING_STATUSES = ['single', 'married_separately', 'married_jointly', 'head_of_household'];
const PAY_METHODS = ['check', 'bank_transfer'];
const MAX_AMOUNT = 1000000;
const MAX_NOTE = 500;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class PayrollError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'PayrollError';
    this.status = status;
  }
}

// A non-negative dollar amount with at most 2 decimals. A blank means 0.
// Anything else ('1e3', '-5', '1.234', 'abc') is refused, never read as zero.
const amount = (label) => Joi.any().custom((value, helpers) => {
  if (value == null || value === '') return '0.00';
  let text = null;
  if (typeof value === 'number' && Number.isFinite(value)) text = String(value);
  else if (typeof value === 'string') text = value.trim();
  if (text === null || !/^\d+(?:\.\d{1,2})?$/.test(text)) {
    return helpers.message(`${label} must be a dollar amount with at most 2 decimal places`);
  }
  if (Number(text) > MAX_AMOUNT) return helpers.message(`${label} must be at most ${MAX_AMOUNT}`);
  return text;
}).default('0.00');

const calendarDate = (label) => Joi.string().trim().custom((value, helpers) => (
  validCalendarDate(value) ? value : helpers.message(`${label} must be a real date (YYYY-MM-DD)`)
));

function w4Schema(today) {
  const thisYear = Number(today.slice(0, 4));
  return Joi.object({
    formYear: Joi.number().integer().min(2020).max(thisYear + 1).required()
      .messages({ 'any.required': 'Form year is required', 'number.base': 'Form year must be a year', 'number.integer': 'Form year must be a year', 'number.min': 'Form year must be 2020 or later', 'number.max': `Form year must be ${thisYear + 1} or earlier` }),
    filingStatus: Joi.string().valid(...FILING_STATUSES).required()
      .messages({ 'any.only': 'Pick a filing status', 'any.required': 'Pick a filing status', 'string.base': 'Pick a filing status' }),
    step2Checkbox: Joi.boolean().default(false),
    step3Amount: amount('Step 3 credits'),
    step4aOtherIncome: amount('Step 4(a) other income'),
    step4bDeductions: amount('Step 4(b) deductions'),
    step4cExtraWithholding: amount('Step 4(c) extra withholding'),
    exempt: Joi.boolean().default(false),
    signedOn: calendarDate('Date signed').required()
      .custom((value, helpers) => (value > today ? helpers.message('Date signed cannot be in the future') : value))
      .messages({ 'any.required': 'Date signed is required', 'string.empty': 'Date signed is required' }),
    effectiveOn: calendarDate('First pay date').optional(),
    note: Joi.string().trim().max(MAX_NOTE).allow('', null).default(null)
      .messages({ 'string.max': `Note must be at most ${MAX_NOTE} characters` }),
  });
}

function payMethodSchema(today) {
  return Joi.object({
    payMethod: Joi.string().valid(...PAY_METHODS).required()
      .messages({ 'any.only': 'Pick paper check or bank transfer', 'any.required': 'Pick paper check or bank transfer', 'string.base': 'Pick paper check or bank transfer' }),
    consentOn: calendarDate('Written OK date').allow('', null).optional()
      .custom((value, helpers) => (value && value > today ? helpers.message('Written OK date cannot be in the future') : value)),
  });
}

function validate(schema, input) {
  const { value, error } = schema.validate(input || {}, { abortEarly: true, convert: true, allowUnknown: false });
  if (error) throw new PayrollError(400, error.details[0].message);
  return value;
}

function requireUuid(technicianId) {
  if (!UUID_RE.test(String(technicianId || ''))) throw new PayrollError(404, 'Technician not found.');
  return String(technicianId);
}

// Dates leave Postgres as text so a server time zone can never move a day.
const columns = (conn) => [
  'id', 'form_year', 'filing_status', 'step2_checkbox', 'step3_amount', 'step4a_other_income',
  'step4b_deductions', 'step4c_extra_withholding', 'exempt', 'note', 'created_at',
  conn.raw("to_char(signed_on, 'YYYY-MM-DD') as signed_on"),
  conn.raw("to_char(effective_on, 'YYYY-MM-DD') as effective_on"),
];

// The shape computePaycheck() takes as `w4` (payroll-calc.js), plus the ids and
// dates the settings screen shows. Amounts are the decimal strings NUMERIC returns.
function serializeW4(row) {
  return {
    id: row.id,
    formYear: row.form_year,
    filingStatus: row.filing_status,
    step2Checkbox: row.step2_checkbox,
    step3Amount: row.step3_amount,
    step4aOtherIncome: row.step4a_other_income,
    step4bDeductions: row.step4b_deductions,
    step4cExtraWithholding: row.step4c_extra_withholding,
    exempt: row.exempt,
    signedOn: row.signed_on,
    effectiveOn: row.effective_on,
  };
}

const serializeHistoryRow = (row) => ({
  ...serializeW4(row),
  note: row.note || null,
  enteredAt: row.created_at ? new Date(row.created_at).toISOString() : null,
});

// The election in force on payDate: the latest effective_on not after it; a
// same-day correction (later created_at) wins. null when none applies yet, and
// null when the one in force is an exemption that has lapsed (see below). A null
// is not a block: the pay run withholds as the IRS default (single, no
// adjustments, Tax Topic 753).
// IRS Tax Topic 753: a W-4 claiming exemption "is valid for only the calendar
// year in which it's furnished", and with no new W-4 by February 15 the employer
// withholds as single with no other entries. A February 15 that is a Saturday,
// Sunday or legal holiday moves to the next business day (the IRS forms say so: the
// 2021 Form W-4 asked for the new form by February 16, 2021). signed_on's year stands
// for the year the form was furnished; pay dates after that deadline get null.
async function currentW4For(technicianId, payDate, conn = db) {
  const day = validCalendarDate(payDate);
  if (!day) throw new Error('payDate must be a real YYYY-MM-DD date');
  const row = await conn('payroll_w4_elections')
    .where({ technician_id: technicianId })
    .where('effective_on', '<=', day)
    .orderBy([{ column: 'effective_on', order: 'desc' }, { column: 'created_at', order: 'desc' }])
    .first(columns(conn));
  if (!row) return null;
  const election = serializeW4(row);
  if (election.exempt && day > rollIrs(`${Number(election.signedOn.slice(0, 4)) + 1}-02-15`)) return null;
  return election;
}

async function listW4(technicianId, conn = db) {
  requireUuid(technicianId);
  const rows = await conn('payroll_w4_elections')
    .where({ technician_id: technicianId })
    .orderBy([{ column: 'effective_on', order: 'desc' }, { column: 'created_at', order: 'desc' }])
    .select(columns(conn));
  return rows.map(serializeHistoryRow);
}

async function lockW2Technician(trx, technicianId, what) {
  const tech = await trx('technicians').where({ id: technicianId }).forUpdate().first('id', 'employment_type');
  if (!tech) throw new PayrollError(404, 'Technician not found.');
  if (tech.employment_type !== 'w2') throw new PayrollError(409, `${what} is for W-2 employees.`);
  return tech;
}

async function recordW4(technicianId, input, actor, conn = db) {
  requireUuid(technicianId);
  const today = etDateString();
  const v = validate(w4Schema(today), input);
  const effectiveOn = v.effectiveOn || v.signedOn;
  if (effectiveOn < v.signedOn) throw new PayrollError(400, 'First pay date cannot be before the date signed');
  const actorId = (actor && typeof actor === 'object' ? actor.id : actor) || null;
  return conn.transaction(async (trx) => {
    await lockW2Technician(trx, technicianId, 'W-4');
    const [inserted] = await trx('payroll_w4_elections').insert({
      technician_id: technicianId,
      form_year: v.formYear,
      filing_status: v.filingStatus,
      step2_checkbox: v.step2Checkbox,
      step3_amount: v.step3Amount,
      step4a_other_income: v.step4aOtherIncome,
      step4b_deductions: v.step4bDeductions,
      step4c_extra_withholding: v.step4cExtraWithholding,
      exempt: v.exempt,
      signed_on: v.signedOn,
      effective_on: effectiveOn,
      entered_by: actorId,
      note: v.note || null,
    }).returning('id');
    const id = inserted && inserted.id ? inserted.id : inserted;
    // Audit metadata is ids only: no amounts, no note.
    await recordAuditEvent({
      trx, critical: true, actor_type: 'admin', actor_id: actorId,
      action: 'payroll.w4_recorded', resource_type: 'payroll_w4_elections', resource_id: id,
      metadata: { technician_id: technicianId, election_id: id },
    });
    const row = await trx('payroll_w4_elections').where({ id }).first(columns(trx));
    return serializeHistoryRow(row);
  });
}

async function setPayMethod(technicianId, input, actor, conn = db) {
  requireUuid(technicianId);
  const today = etDateString();
  const v = validate(payMethodSchema(today), input);
  const consentOn = v.payMethod === 'bank_transfer' ? (v.consentOn || null) : null;
  if (v.payMethod === 'bank_transfer' && !consentOn) {
    throw new PayrollError(400, 'Bank transfer needs the date the employee\'s written OK was received');
  }
  const actorId = (actor && typeof actor === 'object' ? actor.id : actor) || null;
  return conn.transaction(async (trx) => {
    await lockW2Technician(trx, technicianId, 'Pay method');
    await trx('technicians').where({ id: technicianId }).update({
      pay_method: v.payMethod,
      pay_method_consent_on: consentOn,
      updated_at: trx.fn.now(),
    });
    await recordAuditEvent({
      trx, critical: true, actor_type: 'admin', actor_id: actorId,
      action: 'payroll.pay_method_changed', resource_type: 'technicians', resource_id: technicianId,
      metadata: { technician_id: technicianId, pay_method: v.payMethod },
    });
    const row = await trx('technicians').where({ id: technicianId })
      .first('id', 'pay_method', trx.raw("to_char(pay_method_consent_on, 'YYYY-MM-DD') as pay_method_consent_on"));
    return { id: row.id, payMethod: row.pay_method, payMethodConsentOn: row.pay_method_consent_on || null };
  });
}

// W-2 technicians (active or not started yet) for the Payroll tab, each with the
// W-4 in force today. Selects named columns only: never SSN, address or DOB.
async function listPayrollTechnicians(conn = db) {
  const today = etDateString();
  // GATE_PAYROLL_TIME_OFF: the yearly paid time off allowance rides on each row.
  const withTimeOff = typeof payrollTimeOffLive === 'function' && payrollTimeOffLive();
  // GATE_PAYROLL_PAY_LINES: whether federal overtime law covers the employee rides on each row.
  const withCoverage = typeof payrollPayLinesLive === 'function' && payrollPayLinesLive();
  // GATE_PAYROLL_FAMILY_EMPLOYEE: the family employee setting rides on each row (null = not set).
  const withFamily = typeof payrollFamilyEmployeeLive === 'function' && payrollFamilyEmployeeLive();
  // GATE_PAYROLL_MERCURY_STATUS: the Mercury recipient id rides on each row (null = not entered).
  const withMercury = typeof payrollMercuryStatusLive === 'function' && payrollMercuryStatusLive();
  const rows = await conn('technicians')
    .where({ employment_type: 'w2' })
    .whereIn('employment_status', ['active', 'prospective'])
    .orderBy('name')
    .select('id', 'name', 'pay_rate', 'pay_method', 'employment_status',
      ...(withTimeOff ? ['pto_hours_per_year'] : []),
      ...(withCoverage ? ['flsa_overtime_covered'] : []),
      ...(withMercury ? ['mercury_recipient_id'] : []),
      ...(withFamily ? ['family_relationship', 'family_employer_entity', conn.raw("to_char(family_exempt_from, 'YYYY-MM-DD') as family_exempt_from")] : []),
      conn.raw("to_char(pay_method_consent_on, 'YYYY-MM-DD') as pay_method_consent_on"));
  const out = [];
  // One at a time: the list is a dozen rows, and a caller may pass a single connection.
  for (const row of rows) {
    out.push({
      id: row.id,
      name: row.name,
      payRate: row.pay_rate,
      employmentStatus: row.employment_status,
      payMethod: row.pay_method,
      payMethodConsentOn: row.pay_method_consent_on || null,
      currentW4: await currentW4For(row.id, today, conn),
      ...(withTimeOff ? { ptoHoursPerYear: row.pto_hours_per_year == null ? null : Number(row.pto_hours_per_year) } : {}),
      ...(withCoverage ? { flsaOvertimeCovered: row.flsa_overtime_covered == null ? null : row.flsa_overtime_covered } : {}),
      ...(withMercury ? { mercuryRecipientId: row.mercury_recipient_id || null } : {}),
      ...(withFamily ? {
        familyEmployment: row.family_relationship
          ? { relationship: row.family_relationship, entity: row.family_employer_entity, exemptFrom: row.family_exempt_from }
          : null,
      } : {}),
    });
  }
  return out;
}

module.exports = {
  FILING_STATUSES,
  PAY_METHODS,
  PayrollError,
  currentW4For,
  listW4,
  recordW4,
  setPayMethod,
  listPayrollTechnicians,
};
