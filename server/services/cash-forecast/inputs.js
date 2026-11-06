/**
 * Storage for the owner-typed inputs of the 13-week cash forecast.
 *
 * Every function takes the knex instance first, so a test can pass a fake.
 * Money is whole cents. A removed item is set inactive, never deleted.
 * A repeating-bill mark (step 2c) is the owner's business/household label for one bill the finder shows,
 * keyed on the merchant key engine.js gives it. A label only: clearing it deletes the row.
 * Dates go out as 'YYYY-MM-DD' strings (pg DATE arrives as a UTC-midnight Date on Railway).
 */
const { validCalendarDate, dateOnlyString } = require('../../utils/datetime-et');

const KINDS = ['insurance', 'health', 'tax_account', 'ads', 'card_payoff', 'hire', 'other'];
const CADENCES = ['once', 'weekly', 'biweekly', 'monthly'];
const MAX_AMOUNT_CENTS = 100000000;
const MAX_FLOOR_CENTS = 100000000;
const MAX_RECEIPT_CENTS = 10000000000;
const MAX_RECEIPT_MONTHS = 48;
const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MARKS = ['business', 'household'];
// engine.js merchantKey: one or two words of capital letters or &, each 2+ long
const MARK_KEY = /^[A-Z&]{2,}( [A-Z&]{2,})?$/;
const MAX_MARK_KEY = 80;

const ITEMS = 'cash_forecast_items';
const SETTINGS = 'cash_forecast_settings';
const MARK_ROWS = 'cash_forecast_line_marks';

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined;
}

// A whole number given as a JS integer or a string of digits. Returns null when it is neither.
function toInt(v) {
  if (typeof v === 'number') return Number.isSafeInteger(v) ? v : null;
  if (typeof v === 'string' && /^-?\d{1,15}$/.test(v.trim())) return Number(v.trim());
  return null;
}

function isRealDate(s) {
  return typeof s === 'string' && validCalendarDate(s) !== null;
}

function fail(error) {
  return { ok: false, error };
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const ok = (value) => ({ value });
const bad = (error) => ({ error });
const oneOf = (list, name) => (v) => (list.includes(v) ? ok(v) : bad(`${name} must be one of: ${list.join(', ')}`));
const wholeCents = (min, max, message) => (v) => {
  const n = toInt(v);
  return n !== null && n >= min && n <= max ? ok(n) : bad(message);
};
const realDate = (name, { nullable = false } = {}) => (v) => {
  if (nullable && v === null) return ok(null);
  return isRealDate(v) ? ok(v) : bad(`${name} must be a real date as YYYY-MM-DD`);
};

// One check per field: { value } or { error }. Unknown keys are ignored (never written).
const ITEM_FIELDS = {
  kind: oneOf(KINDS, 'kind'),
  label: (v) => {
    const label = typeof v === 'string' ? v.trim() : '';
    return label.length >= 1 && label.length <= 120 ? ok(label) : bad('label must be 1 to 120 characters');
  },
  amount_cents: wholeCents(1, MAX_AMOUNT_CENTS, `amount_cents must be a whole number of cents from 1 to ${MAX_AMOUNT_CENTS}`),
  cadence: oneOf(CADENCES, 'cadence'),
  first_date: realDate('first_date'),
  last_date: realDate('last_date', { nullable: true }), // an explicit null clears it on update
  active: (v) => (typeof v === 'boolean' ? ok(v) : bad('active must be true or false')),
};
const ITEM_REQUIRED = ['kind', 'label', 'amount_cents', 'cadence', 'first_date'];

function checkReceipts(r) {
  if (!isPlainObject(r)) return bad('last_year_receipts must be an object of month to cents');
  const keys = Object.keys(r);
  if (keys.length > MAX_RECEIPT_MONTHS) return bad(`last_year_receipts can hold at most ${MAX_RECEIPT_MONTHS} months`);
  const badKey = keys.find((k) => !MONTH_KEY.test(k));
  if (badKey) return bad(`last_year_receipts key "${badKey}" must look like YYYY-MM`);
  const badValue = keys.find((k) => wholeCents(0, MAX_RECEIPT_CENTS, '')(r[k]).error !== undefined);
  if (badValue) return bad(`last_year_receipts value for ${badValue} must be a whole number of cents from 0 to ${MAX_RECEIPT_CENTS}`);
  return ok(Object.fromEntries(keys.map((k) => [k, toInt(r[k])])));
}

const SETTINGS_FIELDS = {
  floor_cents: (v) => (v === null ? ok(null)
    : wholeCents(0, MAX_FLOOR_CENTS, `floor_cents must be empty or a whole number of cents from 0 to ${MAX_FLOOR_CENTS}`)(v)),
  last_year_receipts: checkReceipts,
};

// Runs each given field's check; reports the first error. `required` fields must be present.
function checkFields(input, fields, required) {
  if (!isPlainObject(input)) return fail('Input must be an object');
  const missing = required.find((k) => !has(input, k));
  if (missing) return fail(`${missing} is required`);
  const value = {};
  for (const [key, check] of Object.entries(fields).filter(([k]) => has(input, k))) {
    const r = check(input[key]);
    if (r.error !== undefined) return fail(r.error);
    value[key] = r.value;
  }
  return { ok: true, value };
}

function validateItemInput(input, { partial = false } = {}) {
  const r = checkFields(input, ITEM_FIELDS, partial ? [] : ITEM_REQUIRED);
  if (!r.ok) return r;
  // a create without last_date stores NULL
  const value = partial ? r.value : { last_date: null, ...r.value };
  if (value.first_date && value.last_date && value.last_date < value.first_date) return fail('last_date must not be before first_date');
  return { ok: true, value };
}

function validateSettingsInput(input) {
  const r = checkFields(input, SETTINGS_FIELDS, []);
  if (r.ok && !Object.keys(r.value).length) return fail('Give floor_cents or last_year_receipts');
  return r;
}

const BAD_MARK_KEY = 'key must be a repeating bill key from the forecast';
const isMarkKey = (key) => typeof key === 'string' && key.length <= MAX_MARK_KEY && MARK_KEY.test(key);

function validateMarkInput(key, input) {
  if (!isMarkKey(key)) return fail(BAD_MARK_KEY);
  const r = checkFields(input, { mark: oneOf(MARKS, 'mark') }, ['mark']);
  return r.ok ? { ok: true, value: { key, mark: r.value.mark } } : r;
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function requireUuid(id) {
  if (typeof id !== 'string' || !UUID.test(id)) throw badRequest('id must be a uuid');
}

// pg returns bigint as a string and DATE as a Date; hand back numbers and day strings.
function shapeItem(row) {
  if (!row) return null;
  const out = { ...row, amount_cents: Number(row.amount_cents) };
  for (const key of ['first_date', 'last_date']) if (key in row) out[key] = dateOnlyString(row[key]) || null;
  return out;
}

function shapeSettings(row) {
  if (!row) return { floor_cents: null, last_year_receipts: {}, updated_at: null };
  let receipts = row.last_year_receipts;
  if (typeof receipts === 'string') {
    try { receipts = JSON.parse(receipts); } catch { receipts = {}; }
  }
  const out = {};
  for (const [k, v] of Object.entries(receipts && typeof receipts === 'object' ? receipts : {})) out[k] = Number(v);
  return {
    floor_cents: row.floor_cents === null || row.floor_cents === undefined ? null : Number(row.floor_cents),
    last_year_receipts: out,
    updated_at: row.updated_at || null,
  };
}

async function listItems(db, { includeInactive = false } = {}) {
  let q = db(ITEMS);
  if (!includeInactive) q = q.where({ active: true });
  const rows = await q.orderBy([
    { column: 'first_date', order: 'asc' },
    { column: 'label', order: 'asc' },
  ]);
  return rows.map(shapeItem);
}

async function createItem(db, input, actorId) {
  const v = validateItemInput(input);
  if (!v.ok) throw badRequest(v.error);
  const [row] = await db(ITEMS)
    .insert({ ...v.value, entered_by: actorId || null })
    .returning('*');
  return shapeItem(row);
}

async function updateItem(db, id, patch, actorId) {
  requireUuid(id);
  const v = validateItemInput(patch, { partial: true });
  if (!v.ok) throw badRequest(v.error);
  if (!Object.keys(v.value).length) throw badRequest('Nothing to change');

  // A patch that moves only one end of the date range is checked against the stored other end.
  // A patch that clears last_date (null) leaves no end to check.
  const hasFirst = has(v.value, 'first_date');
  const setsLast = has(v.value, 'last_date');
  const hasLast = setsLast && v.value.last_date !== null;
  if (hasFirst !== hasLast && !(hasFirst && setsLast)) {
    const current = await db(ITEMS).where({ id }).first();
    if (!current) return null;
    const first = hasFirst ? v.value.first_date : dateOnlyString(current.first_date);
    const last = hasLast ? v.value.last_date : dateOnlyString(current.last_date);
    if (first && last && last < first) throw badRequest('last_date must not be before first_date');
  }

  const [row] = await db(ITEMS)
    .where({ id })
    .update({ ...v.value, updated_at: db.fn.now() })
    .returning('*');
  return shapeItem(row);
}

async function deactivateItem(db, id, actorId) {
  requireUuid(id);
  const [row] = await db(ITEMS)
    .where({ id })
    .update({ active: false, updated_at: db.fn.now() })
    .returning('*');
  return shapeItem(row);
}

async function getSettings(db) {
  const row = await db(SETTINGS).where({ id: 1 }).first();
  return shapeSettings(row);
}

async function saveSettings(db, input, actorId) {
  const v = validateSettingsInput(input);
  if (!v.ok) throw badRequest(v.error);
  const fields = { ...v.value };
  if (fields.last_year_receipts) fields.last_year_receipts = JSON.stringify(fields.last_year_receipts);
  const stamp = { updated_by: actorId || null, updated_at: db.fn.now() };
  const [row] = await db(SETTINGS)
    .insert({ id: 1, ...fields, ...stamp })
    .onConflict('id')
    .merge({ ...fields, ...stamp })
    .returning('*');
  return shapeSettings(row);
}

// key -> 'business' | 'household'
async function listMarks(db) {
  const rows = await db(MARK_ROWS).select('key', 'mark');
  return Object.fromEntries(rows.map((r) => [r.key, r.mark]));
}

async function saveMark(db, key, input, actorId) {
  const v = validateMarkInput(key, input);
  if (!v.ok) throw badRequest(v.error);
  const stamp = { updated_by: actorId || null, updated_at: db.fn.now() };
  const [row] = await db(MARK_ROWS)
    .insert({ ...v.value, ...stamp })
    .onConflict('key')
    .merge({ mark: v.value.mark, ...stamp })
    .returning(['key', 'mark', 'updated_at']);
  return row;
}

// Clearing a mark that is not there is no error: the bill simply has no label.
async function clearMark(db, key) {
  if (!isMarkKey(key)) throw badRequest(BAD_MARK_KEY);
  const removed = await db(MARK_ROWS).where({ key }).del();
  return { key, mark: null, removed: Number(removed) > 0 };
}

module.exports = {
  KINDS,
  CADENCES,
  MARKS,
  validateItemInput,
  validateSettingsInput,
  validateMarkInput,
  listItems,
  createItem,
  updateItem,
  deactivateItem,
  getSettings,
  saveSettings,
  listMarks,
  saveMark,
  clearMark,
};
