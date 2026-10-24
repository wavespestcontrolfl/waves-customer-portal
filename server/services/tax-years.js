/**
 * Tax-year records for the return engine (GATE_TAX_RETURN_ENGINE, nested under
 * GATE_BANK_IMPORT). One row per tax year in `tax_years`: the owner's inputs
 * (filing status, income outside the business, estimates paid), the
 * carryovers that come IN from the prior year, and, once the year is marked
 * filed, a frozen snapshot of the computed return.
 *
 * A carry-in that is NULL on a year takes the prior year's FILED snapshot
 * carry-out, or 0 when there is none (resolveCarryIn). Any number the owner
 * entered, 0 included, wins; a PUT of null clears it back to the default. A
 * year that is filed cannot be edited until it is unmarked.
 */
const db = require('../models/db');
const { etDateString } = require('../utils/datetime-et');
const { dateCellStr } = require('./pnl-report');
const { FILING_STATUSES } = require('./tax-year-constants');
const { strictNumber, parseYear, httpError } = require('./tax-shared-bills');

const NOTES_MAX = 500;
const AMOUNT_MAX = 1000000000;
const CARRY_FIELDS = { nol: 'nol_in', qbi_loss: 'qbi_loss_in', sec179: 'sec179_carry_in', home_office: 'home_office_carry_in' };
const CARRY_COLUMNS = Object.values(CARRY_FIELDS); // nullable: NULL = the default
const MONEY_FIELDS = ['other_income', 'estimates_paid'];
const EDITABLE = ['filing_status', 'notes', ...MONEY_FIELDS, ...CARRY_COLUMNS];

const DEFAULTS = {
  filing_status: 'single', status: 'draft', filed_on: null, other_income: 0, estimates_paid: 0,
  nol_in: null, qbi_loss_in: null, sec179_carry_in: null, home_office_carry_in: null, filed_snapshot: null, notes: null,
};

function present(row) {
  if (!row) return row;
  const out = { ...row, filed_on: row.filed_on ? dateCellStr(row.filed_on) : null };
  for (const k of MONEY_FIELDS) out[k] = Number(row[k]) || 0;
  for (const k of CARRY_COLUMNS) out[k] = row[k] == null ? null : Number(row[k]);
  return out;
}

function parseMoney(value, name) {
  const n = strictNumber(value);
  if (!Number.isFinite(n) || n < 0 || n > AMOUNT_MAX) throw httpError(400, `${name} must be an amount from 0 to ${AMOUNT_MAX}`);
  return Math.round(n * 100) / 100;
}

// A real calendar day (2026-02-30 is refused), not before the year began and
// not after today (ET).
function parseFiledOn(value, year, today = etDateString()) {
  if (value === undefined || value === null || value === '') return today;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw httpError(400, 'filed_on must be a date like 2026-04-15');
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) throw httpError(400, 'filed_on is not a real date');
  if (value < `${year}-01-01` || value > today) throw httpError(400, `filed_on must be from ${year}-01-01 to today`);
  return value;
}

async function listYears() {
  const rows = await db('tax_years').orderBy('tax_year', 'desc')
    .select('tax_year', 'filing_status', 'status', 'filed_on');
  return rows.map((r) => ({ ...r, filed_on: r.filed_on ? dateCellStr(r.filed_on) : null }));
}

// the stored row, or the defaults for a year with no row yet
async function getYearRow(year) {
  const y = parseYear(year);
  const row = await db('tax_years').where({ tax_year: y }).first();
  return row ? { exists: true, row: present(row) } : { exists: false, row: { tax_year: y, ...DEFAULTS } };
}

// Each carry-in with its value and where it came from: 'entered' (a number on
// this year, 0 included), 'prior_year' (the prior year's filed snapshot) or
// 'none'. `default_value` is what an empty box would use, so the screen can
// show it even while the owner's own number is in force.
function resolveCarryIn(row, prior) {
  const out = {};
  const priorFiled = prior && prior.row.status === 'filed' && prior.row.filed_snapshot && prior.row.filed_snapshot.result;
  for (const [key, col] of Object.entries(CARRY_FIELDS)) {
    const fromPrior = priorFiled ? Number(prior.row.filed_snapshot.result.carry_out?.[key]) || 0 : 0;
    const fallback = priorFiled
      ? { value: fromPrior, source: 'prior_year', from_year: prior.row.tax_year }
      : { value: 0, source: 'none', from_year: null };
    const base = { default_value: fallback.value, default_source: fallback.source, default_from_year: fallback.from_year };
    out[key] = row[col] == null ? { ...fallback, ...base } : { value: Number(row[col]), source: 'entered', from_year: null, ...base };
  }
  return out;
}

async function getYearDetail(year) {
  const y = parseYear(year);
  const [cur, prior] = await Promise.all([getYearRow(y), getYearRow(y - 1).catch(() => null)]);
  return { year: y, exists: cur.exists, row: cur.row, carry_in: resolveCarryIn(cur.row, prior) };
}

async function upsertYear(year, input = {}) {
  const y = parseYear(year);
  const keys = Object.keys(input || {});
  const unknown = keys.filter((k) => !EDITABLE.includes(k));
  if (unknown.length) throw httpError(400, `unknown field: ${unknown[0]}`);
  const patch = {};
  if ('filing_status' in input) {
    if (!FILING_STATUSES.includes(input.filing_status)) throw httpError(400, `filing_status must be one of ${FILING_STATUSES.join(', ')}`);
    patch.filing_status = input.filing_status;
  }
  for (const k of MONEY_FIELDS) if (k in input) patch[k] = parseMoney(input[k], k);
  // null clears a carry-in back to the default; a number (0 too) is the owner's own
  for (const k of CARRY_COLUMNS) if (k in input) patch[k] = input[k] === null ? null : parseMoney(input[k], k);
  if ('notes' in input) {
    if (input.notes != null && input.notes !== '' && (typeof input.notes !== 'string' || input.notes.length > NOTES_MAX)) {
      throw httpError(400, `notes must be text of ${NOTES_MAX} characters or less`);
    }
    patch.notes = typeof input.notes === 'string' && input.notes.trim() ? input.notes.trim() : null;
  }
  if (!Object.keys(patch).length) throw httpError(400, 'nothing to update');
  const existing = await db('tax_years').where({ tax_year: y }).first('status');
  if (existing && existing.status === 'filed') throw httpError(409, `${y} is marked filed: unmark it before changing it`);
  const now = new Date();
  // the status guard in the WHERE makes a filing that lands between the read
  // above and this write win: zero rows updated reads as the 409
  const [row] = await db('tax_years')
    .insert({ tax_year: y, ...patch, updated_at: now })
    .onConflict('tax_year')
    .merge({ ...patch, updated_at: now })
    .where('tax_years.status', 'draft')
    .returning('*');
  if (!row) throw httpError(409, `${y} is marked filed: unmark it before changing it`);
  return present(row);
}

// Freeze the computed return. Draft to filed only: a year already filed is a 409.
async function markFiled(year, filedOn, snapshot) {
  const y = parseYear(year);
  await db('tax_years').insert({ tax_year: y }).onConflict('tax_year').ignore();
  const [row] = await db('tax_years')
    .where({ tax_year: y, status: 'draft' })
    .update({ status: 'filed', filed_on: filedOn, filed_snapshot: JSON.stringify(snapshot), updated_at: new Date() })
    .returning('*');
  if (!row) throw httpError(409, `${y} is already marked filed`);
  return present(row);
}

async function unmarkFiled(year) {
  const y = parseYear(year);
  const [row] = await db('tax_years')
    .where({ tax_year: y, status: 'filed' })
    .update({ status: 'draft', filed_on: null, filed_snapshot: null, updated_at: new Date() })
    .returning('*');
  if (!row) {
    const exists = await db('tax_years').where({ tax_year: y }).first('tax_year');
    throw httpError(exists ? 409 : 404, exists ? `${y} is not marked filed` : `no ${y} tax year record`);
  }
  return present(row);
}

module.exports = {
  CARRY_FIELDS, listYears, getYearRow, getYearDetail, resolveCarryIn, upsertYear, markFiled, unmarkFiled, parseFiledOn,
};
