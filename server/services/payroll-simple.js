/**
 * Basic payroll: the SIMPLE IRA at Schwab (owner 2026-11-04, B2 A; plan starts 1 Jan 2027).
 * Dark behind GATE_PAYROLL (the route checks it; these functions only run behind that check).
 * No gate of its own: with no election row a pay run reads and returns what it did before.
 *
 * An admin types the election from the signed salary reduction agreement into
 * payroll_simple_ira_elections: whether the employee takes part (Waves pays the 2% nonelective
 * contribution for every participant, never withheld) and how much of each check the employee
 * saves, as a percent of gross pay OR a dollar amount per check. Rows are evidence (a trigger
 * blocks UPDATE and DELETE); a correction is a new row, the same as a W-4 (payroll-w4.js).
 *
 * currentSimpleFor() is what a pay run calls. simpleYtdBefore() gives the year-to-date deferral and
 * participant pay a run needs for the yearly limit and the 2% pay cap.
 */
const Joi = require('joi');
const db = require('../models/db');
const { recordAuditEvent } = require('./audit-log');
const { etDateString, validCalendarDate } = require('../utils/datetime-et');
const {
  PayrollError, calendarDate, validate, requireUuid, lockW2Technician, MAX_NOTE,
} = require('./payroll-w4');
const { lockPayrollMutations } = require('./payroll-lock');

const MAX_DOLLARS_PER_CHECK = 1000000;
// The first day of the Schwab plan (owner 2026-11-04). No election may start before it, so a form signed
// earlier (the plan is set up in advance) waits until then and no check before it is touched.
const PLAN_START = '2027-01-01';

// "3", "3.5" or "3.25" (a percent of gross pay, at most 100) -> basis points; blank -> null.
const percentToBp = (label) => Joi.any().custom((value, helpers) => {
  if (value == null || value === '') return null;
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : String(value).trim();
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(text) || Number(text) > 100) {
    return helpers.message(`${label} must be a percent from 0 to 100 with at most 2 decimal places`);
  }
  return Math.round(Number(text) * 100);
}).default(null);

// "50" or "50.25" (dollars per check) -> cents; blank -> null.
const dollarsToCents = (label) => Joi.any().custom((value, helpers) => {
  if (value == null || value === '') return null;
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text) || Number(text) > MAX_DOLLARS_PER_CHECK) {
    return helpers.message(`${label} must be a dollar amount with at most 2 decimal places, up to ${MAX_DOLLARS_PER_CHECK}`);
  }
  const [whole, fraction = ''] = text.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}).default(null);

function electionSchema(today) {
  return Joi.object({
    participant: Joi.boolean().strict().required()
      .messages({ 'any.required': 'Say whether the employee takes part', 'boolean.base': 'Say whether the employee takes part' }),
    deferralPercent: percentToBp('Percent of each check'),
    deferralDollars: dollarsToCents('Dollars from each check'),
    signedOn: calendarDate('Date signed').required()
      .custom((value, helpers) => (value > today ? helpers.message('Date signed cannot be in the future') : value))
      .messages({ 'any.required': 'Date signed is required', 'string.empty': 'Date signed is required' }),
    effectiveOn: calendarDate('First pay date').optional(),
    note: Joi.string().trim().max(MAX_NOTE).allow('', null).default(null)
      .messages({ 'string.max': `Note must be at most ${MAX_NOTE} characters` }),
  });
}

// Dates leave Postgres as text so a server time zone can never move a day.
const columns = (conn) => [
  'id', 'participant', 'deferral_bp', 'deferral_cents', 'note', 'created_at',
  conn.raw("to_char(signed_on, 'YYYY-MM-DD') as signed_on"),
  conn.raw("to_char(effective_on, 'YYYY-MM-DD') as effective_on"),
];

// The shape computePaycheck() takes as `simple` (payroll-calc.js) gets built from this in
// payroll-runs.js; the settings screen shows the same fields. deferral_cents is a bigint (text).
const serialize = (row) => ({
  id: row.id,
  participant: row.participant,
  deferralBp: row.deferral_bp == null ? null : Number(row.deferral_bp),
  deferralCents: row.deferral_cents == null ? null : Number(row.deferral_cents),
  signedOn: row.signed_on,
  effectiveOn: row.effective_on,
});

const serializeHistoryRow = (row) => ({
  ...serialize(row),
  note: row.note || null,
  enteredAt: row.created_at ? new Date(row.created_at).toISOString() : null,
});

const newestFirst = [{ column: 'effective_on', order: 'desc' }, { column: 'created_at', order: 'desc' }];

// The election in force on payDate: the latest effective_on not after it; a same-day correction
// (later created_at) wins. null when none applies yet.
async function currentSimpleFor(technicianId, payDate, conn = db) {
  const day = validCalendarDate(payDate);
  if (!day) throw new Error('payDate must be a real YYYY-MM-DD date');
  const row = await conn('payroll_simple_ira_elections')
    .where({ technician_id: technicianId })
    .where('effective_on', '<=', day)
    .orderBy(newestFirst)
    .first(columns(conn));
  return row ? serialize(row) : null;
}

// The `simple` input of computePaycheck() for the check of a technician on payDate: undefined unless a
// participant election is in force. `saved` is that technician's simpleYtdBefore entry. `id` is the
// election row behind the check (payroll-runs.js stores it).
async function simpleInputFor(technicianId, payDate, saved, conn = db) {
  const election = await currentSimpleFor(technicianId, payDate, conn);
  if (!election || !election.participant) return undefined;
  return {
    id: election.id,
    deferralBp: election.deferralBp,
    deferralCents: election.deferralCents,
    ytdDeferralCents: saved.deferral,
    ytdCompensationCents: saved.compensation,
  };
}

// The Payroll tab's technician rows (payroll-w4.js listPayrollTechnicians) with the election in force
// today on each: currentSimple, null when none has been entered.
async function withCurrentSimple(technicians, conn = db) {
  const today = etDateString();
  return Promise.all(technicians.map(async (tech) => ({ ...tech, currentSimple: await currentSimpleFor(tech.id, today, conn) })));
}

async function listSimple(technicianId, conn = db) {
  requireUuid(technicianId);
  const rows = await conn('payroll_simple_ira_elections')
    .where({ technician_id: technicianId })
    .orderBy(newestFirst)
    .select(columns(conn));
  return rows.map(serializeHistoryRow);
}

async function recordSimple(technicianId, input, actor, conn = db) {
  requireUuid(technicianId);
  const today = etDateString();
  const v = validate(electionSchema(today), input);
  if (v.deferralPercent != null && v.deferralDollars != null) throw new PayrollError(400, 'Enter a percent or a dollar amount, not both');
  if (!v.participant && (v.deferralPercent != null || v.deferralDollars != null)) {
    throw new PayrollError(400, 'An employee who does not take part cannot save from pay');
  }
  const effectiveOn = v.effectiveOn || (v.signedOn > PLAN_START ? v.signedOn : PLAN_START);
  if (effectiveOn < v.signedOn) throw new PayrollError(400, 'First pay date cannot be before the date signed');
  if (effectiveOn < PLAN_START) throw new PayrollError(400, 'First pay date cannot be before the plan starts (January 1, 2027)');
  const actorId = (actor && typeof actor === 'object' ? actor.id : actor) || null;
  return conn.transaction(async (trx) => {
    // Finalize reads the election under this lock and then freezes the checks; an election saved in between
    // would not be in the frozen figures, so saving one waits for a finalize or void in progress.
    await lockPayrollMutations(trx);
    await lockW2Technician(trx, technicianId, 'SIMPLE IRA');
    const [inserted] = await trx('payroll_simple_ira_elections').insert({
      technician_id: technicianId,
      participant: v.participant,
      deferral_bp: v.deferralPercent,
      deferral_cents: v.deferralDollars,
      signed_on: v.signedOn,
      effective_on: effectiveOn,
      entered_by: actorId,
      note: v.note || null,
    }).returning('id');
    const id = inserted && inserted.id ? inserted.id : inserted;
    // Audit metadata is ids only: no amounts, no note.
    await recordAuditEvent({
      trx, critical: true, actor_type: 'admin', actor_id: actorId,
      action: 'payroll.simple_ira_recorded', resource_type: 'payroll_simple_ira_elections', resource_id: id,
      metadata: { technician_id: technicianId, election_id: id },
    });
    return serializeHistoryRow(await trx('payroll_simple_ira_elections').where({ id }).first(columns(trx)));
  });
}

/**
 * Year-to-date before a check, for the yearly deferral limit and the 2% pay cap: finalized,
 * non-voided checks of the same calendar year that sort before (payDate, weekStart), the same order
 * as payroll-runs.js ytdBefore. `compensation` counts the gross of checks that had an election
 * behind them (the participant's pay). Map of technician id -> { deferral, compensation } in cents.
 */
async function simpleYtdBefore(conn, technicianIds, payDate, weekStart) {
  const byTech = new Map(technicianIds.map((id) => [id, { deferral: 0, compensation: 0 }]));
  if (!technicianIds.length) return byTech;
  const year = payDate.slice(0, 4);
  const rows = await conn('payroll_checks')
    .where('status', 'finalized')
    .whereIn('technician_id', technicianIds)
    .whereNotNull('simple_election_id')
    .where('pay_date', '>=', `${year}-01-01`)
    .where('pay_date', '<=', `${year}-12-31`)
    .where(function before() {
      this.where('pay_date', '<', payDate).orWhere(function sameDay() {
        this.where('pay_date', payDate).andWhere('week_start', '<', weekStart);
      });
    })
    .groupBy('technician_id')
    .select('technician_id', conn.raw('SUM(simple_deferral_cents) AS deferral'), conn.raw('SUM(gross_cents) AS compensation'));
  for (const r of rows) byTech.set(r.technician_id, { deferral: Number(r.deferral), compensation: Number(r.compensation) });
  return byTech;
}

module.exports = { PLAN_START, currentSimpleFor, simpleInputFor, withCurrentSimple, listSimple, recordSimple, simpleYtdBefore };
