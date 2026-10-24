/**
 * Shared bills + home office (GATE_TAX_SHARED_BILLS, nested under
 * GATE_BANK_IMPORT).
 *
 * A shared bill is a payee that is part business (a phone plan with some
 * business lines, home internet). When Bank Import turns a staged row into an
 * expense and the row's description names a shared bill, the expense's
 * deductible amount is cut to the bill's business share.
 *
 * Matching is plain text, never a regex built from what the owner typed: both
 * the pattern and the description are normalized (upper case, letters and
 * digits, one space between runs, 300 characters at most) and the pattern must
 * appear in the description on word boundaries. So VERIZON matches
 * "WITHDRAWAL FROM VERIZON WIRELESS PAYMENT" and does NOT match "VERIZONWRLS"
 * (no space between the words). When a bank prints a name glued to digits
 * ("SPECTRUM855 707 7328MO" after normalizing), store the pattern as the glued
 * text ("SPECTRUM855"), because the normalized text has no word break there.
 *
 * The home office is kept per tax year and computed on read. Simplified
 * method: $5 a square foot, 300 sq ft at most ($1,500 a year). Actual method
 * (Form 8829, GATE_TAX_RETURN_ENGINE): the year's rent, utilities, insurance
 * and other home costs times office sq ft over home sq ft, no 300 sq ft limit
 * and no proration by months. The simplified method is valid only on a timely
 * original return (Rev. Proc. 2013-13 section 4.03).
 */
const db = require('../models/db');
const { etParts } = require('../utils/datetime-et');
const { taxSharedBillsLive } = require('../config/feature-gates');

const DESC_CAP = 300;
const PATTERN_MIN = 3;
const PATTERN_MAX = 60;
const LABEL_MAX = 80;
const NOTES_MAX = 500;
const HOME_SQ_FT_MAX = 100000;
const HOME_AMOUNT_MAX = 10000000;
const HOME_OFFICE_RATE = 5; // dollars per square foot, simplified method
const HOME_OFFICE_MAX_SQ_FT = 300;
const FIRST_YEAR = 2020;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function httpError(status, message) {
  const e = new Error(message); e.status = status; return e;
}

function isOn() { return !!taxSharedBillsLive(); }

function normalize(text) {
  return String(text == null ? '' : text)
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .slice(0, DESC_CAP)
    .trim();
}

function patternMatches(normPattern, normDescription) {
  if (!normPattern || !normDescription) return false;
  return (` ${normDescription} `).includes(` ${normPattern} `);
}

// The longest matching pattern wins; a tie goes to the lowest id string.
function matchBill(description, bills) {
  const desc = normalize(description);
  if (!desc) return null;
  let best = null;
  for (const bill of bills || []) {
    if (!bill || bill.enabled === false) continue;
    const pattern = normalize(bill.pattern);
    if (!patternMatches(pattern, desc)) continue;
    if (!best
      || pattern.length > best.len
      || (pattern.length === best.len && String(bill.id) < String(best.bill.id))) {
      best = { bill, len: pattern.length };
    }
  }
  return best ? best.bill : null;
}

// round half up to cents, in integers so 10.05 x 50% is 5.03 and not 5.02
function shareOf(amountDeductible, pct) {
  const amount = Number(amountDeductible);
  const pctN = Number(pct);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(pctN) || pctN <= 0) return 0;
  const cents = Math.round(amount * 100);
  const pctHundredths = Math.round(Math.min(pctN, 100) * 100);
  const share = Math.floor((cents * pctHundredths + 5000) / 10000);
  return Math.min(Math.max(share, 0), cents) / 100;
}

// The expense note records the share the books claimed, in one fixed shape
// this module writes and reads back (later passes apply on top of it). The
// label loses brackets so it can never close or fake the marker.
function sharedNote(bill) {
  const label = String(bill.label || '').replace(/[[\]]/g, '').trim();
  return ` [Shared bill: ${label} ${Number(bill.business_pct)}%]`;
}
const BOOKED_SHARE = /\[Shared bill: [^\]]* (\d{1,3}(?:\.\d{1,2})?)%\]/g;
function bookedSharePct(notes) {
  const all = [...String(notes || '').matchAll(BOOKED_SHARE)];
  if (!all.length) return null;
  const pct = Number(all[all.length - 1][1]);
  return Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct : null;
}

function homeOfficeDeduction(row = {}) {
  if (row.method === 'actual') {
    const office = Number(row.sq_ft) || 0;
    const home = Number(row.home_sq_ft) || 0;
    if (office <= 0 || home <= 0) return 0;
    const cents = ['rent', 'utilities', 'insurance', 'other']
      .reduce((sum, k) => sum + Math.round((Number(row[k]) || 0) * 100), 0);
    return Math.round((cents * Math.min(office, home)) / home) / 100;
  }
  const sq = Math.min(Math.max(Number(row.sq_ft) || 0, 0), HOME_OFFICE_MAX_SQ_FT);
  const m = Math.min(Math.max(Number(row.months) || 0, 0), 12);
  return Math.round((HOME_OFFICE_RATE * 100 * sq * m) / 12) / 100;
}

// A number the owner typed: a real number, or a string that is entirely one.
// "50junk", "", null, true and [] are all refused.
function strictNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN;
}

function parsePct(value) {
  const n = strictNumber(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw httpError(400, 'business_pct must be a number from 0 to 100');
  return Math.round(n * 100) / 100;
}

function parseIntIn(value, min, max, name) {
  const n = strictNumber(value);
  if (!Number.isInteger(n) || n < min || n > max) throw httpError(400, `${name} must be a whole number from ${min} to ${max}`);
  return n;
}

function parseAmount(value, name) {
  if (value == null || value === '') return 0;
  const n = strictNumber(value);
  if (!Number.isFinite(n) || n < 0 || n > HOME_AMOUNT_MAX) throw httpError(400, `${name} must be an amount from 0 to ${HOME_AMOUNT_MAX}`);
  return Math.round(n * 100) / 100;
}

function parsePattern(value) {
  const pattern = normalize(value);
  if (pattern.length < PATTERN_MIN || pattern.length > PATTERN_MAX) {
    throw httpError(400, `pattern must be ${PATTERN_MIN} to ${PATTERN_MAX} letters or digits (spaces and symbols are ignored)`);
  }
  return pattern;
}

function parseLabel(value) {
  const label = typeof value === 'string' ? value.trim() : '';
  if (!label || label.length > LABEL_MAX) throw httpError(400, `label is required (${LABEL_MAX} characters at most)`);
  return label;
}

async function parseCategoryId(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw httpError(400, 'unknown category_id');
  const cat = await db('expense_categories').where({ id: value }).first('id');
  if (!cat) throw httpError(400, 'unknown category_id');
  return value;
}

function present(row) {
  if (!row) return row;
  return { ...row, business_pct: Number(row.business_pct) };
}

async function listBills() {
  const rows = await db('tax_shared_bills as b')
    .leftJoin('expense_categories as c', 'b.category_id', 'c.id')
    .select('b.*', 'c.name as category_name')
    .orderBy('b.label', 'asc')
    .orderBy('b.id', 'asc');
  return rows.map(present);
}

// the create-expense hot path: one query, no joins. A missing table (a deploy
// that is ahead of its migration) reads as no bills, never a failed expense.
async function loadEnabledBills() {
  try {
    const rows = await db('tax_shared_bills').where({ enabled: true }).select('id', 'pattern', 'label', 'business_pct', 'category_id', 'enabled');
    return rows.map(present);
  } catch (err) {
    if (err?.code === '42P01') return [];
    throw err;
  }
}

async function createBill(input = {}) {
  const row = {
    pattern: parsePattern(input.pattern),
    label: parseLabel(input.label),
    business_pct: parsePct(input.business_pct),
    category_id: await parseCategoryId(input.category_id),
    enabled: true,
  };
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw httpError(400, 'enabled must be true or false');
    row.enabled = input.enabled;
  }
  try {
    const [created] = await db('tax_shared_bills').insert(row).returning('*');
    return present(created);
  } catch (err) {
    if (err?.code === '23505') throw httpError(409, 'a shared bill with that pattern already exists');
    throw err;
  }
}

async function updateBill(id, input = {}) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw httpError(404, 'shared bill not found');
  const patch = {};
  if ('pattern' in input) patch.pattern = parsePattern(input.pattern);
  if ('label' in input) patch.label = parseLabel(input.label);
  if ('business_pct' in input) patch.business_pct = parsePct(input.business_pct);
  if ('category_id' in input) patch.category_id = await parseCategoryId(input.category_id);
  if ('enabled' in input) {
    if (typeof input.enabled !== 'boolean') throw httpError(400, 'enabled must be true or false');
    patch.enabled = input.enabled;
  }
  if (!Object.keys(patch).length) throw httpError(400, 'nothing to update');
  patch.updated_at = new Date();
  try {
    const [updated] = await db('tax_shared_bills').where({ id }).update(patch).returning('*');
    if (!updated) throw httpError(404, 'shared bill not found');
    return present(updated);
  } catch (err) {
    if (err?.code === '23505') throw httpError(409, 'a shared bill with that pattern already exists');
    throw err;
  }
}

async function deleteBill(id) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw httpError(404, 'shared bill not found');
  const n = await db('tax_shared_bills').where({ id }).del();
  if (!n) throw httpError(404, 'shared bill not found');
  return true;
}

function parseYear(value) {
  const n = strictNumber(value);
  const max = etParts().year + 1;
  if (!Number.isInteger(n) || n < FIRST_YEAR || n > max) throw httpError(400, `year must be a whole number from ${FIRST_YEAR} to ${max}`);
  return n;
}

async function getHomeOffice(year) {
  const y = parseYear(year);
  const row = await db('tax_home_office').where({ tax_year: y }).first();
  return row || null;
}

async function upsertHomeOffice(year, input = {}) {
  const y = parseYear(year);
  const method = input.method === undefined ? 'simplified' : input.method;
  if (method !== 'simplified' && method !== 'actual') throw httpError(400, 'method must be simplified or actual');
  const actual = method === 'actual';
  const sqFt = parseIntIn(input.sq_ft, 1, actual ? HOME_SQ_FT_MAX : HOME_OFFICE_MAX_SQ_FT, 'sq_ft');
  const months = parseIntIn(input.months === undefined ? 12 : input.months, 1, 12, 'months');
  let notes = null;
  if (input.notes != null && input.notes !== '') {
    if (typeof input.notes !== 'string' || input.notes.length > NOTES_MAX) throw httpError(400, `notes must be text of ${NOTES_MAX} characters or less`);
    notes = input.notes.trim() || null;
  }
  const fields = { method, sq_ft: sqFt, months, notes, home_sq_ft: null, rent: null, utilities: null, insurance: null, other: null };
  if (actual) {
    fields.home_sq_ft = parseIntIn(input.home_sq_ft, 1, HOME_SQ_FT_MAX, 'home_sq_ft');
    if (fields.home_sq_ft < sqFt) throw httpError(400, 'home_sq_ft must be at least sq_ft (the office is part of the home)');
    for (const k of ['rent', 'utilities', 'insurance', 'other']) fields[k] = parseAmount(input[k], k);
  }
  const now = new Date();
  const [row] = await db('tax_home_office')
    .insert({ tax_year: y, ...fields, updated_at: now })
    .onConflict('tax_year')
    .merge({ ...fields, updated_at: now })
    .returning('*');
  return row;
}

async function deleteHomeOffice(year) {
  const y = parseYear(year);
  return db('tax_home_office').where({ tax_year: y }).del();
}

module.exports = {
  isOn, normalize, patternMatches, matchBill, shareOf, sharedNote, bookedSharePct, homeOfficeDeduction,
  listBills, loadEnabledBills, createBill, updateBill, deleteBill,
  getHomeOffice, upsertHomeOffice, deleteHomeOffice,
  strictNumber, parseYear, httpError,
  PATTERN_MIN, PATTERN_MAX, HOME_OFFICE_RATE, HOME_OFFICE_MAX_SQ_FT,
};
