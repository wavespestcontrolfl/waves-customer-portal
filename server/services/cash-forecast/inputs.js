/**
 * Storage for the owner-typed inputs of the 13-week cash forecast.
 *
 * Every function takes the knex instance first, so a test can pass a fake.
 * Money is whole cents. A removed item is set inactive, never deleted.
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

const ITEMS = 'cash_forecast_items';
const SETTINGS = 'cash_forecast_settings';

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

function validateItemInput(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('Input must be an object');
  const value = {};

  if (has(input, 'kind')) {
    if (!KINDS.includes(input.kind)) return fail(`kind must be one of: ${KINDS.join(', ')}`);
    value.kind = input.kind;
  } else if (!partial) return fail('kind is required');

  if (has(input, 'label')) {
    const label = typeof input.label === 'string' ? input.label.trim() : '';
    if (label.length < 1 || label.length > 120) return fail('label must be 1 to 120 characters');
    value.label = label;
  } else if (!partial) return fail('label is required');

  if (has(input, 'amount_cents')) {
    const n = toInt(input.amount_cents);
    if (n === null || n < 1 || n > MAX_AMOUNT_CENTS) {
      return fail(`amount_cents must be a whole number of cents from 1 to ${MAX_AMOUNT_CENTS}`);
    }
    value.amount_cents = n;
  } else if (!partial) return fail('amount_cents is required');

  if (has(input, 'cadence')) {
    if (!CADENCES.includes(input.cadence)) return fail(`cadence must be one of: ${CADENCES.join(', ')}`);
    value.cadence = input.cadence;
  } else if (!partial) return fail('cadence is required');

  if (has(input, 'first_date')) {
    if (!isRealDate(input.first_date)) return fail('first_date must be a real date as YYYY-MM-DD');
    value.first_date = input.first_date;
  } else if (!partial) return fail('first_date is required');

  if (has(input, 'last_date') && input.last_date !== null) {
    if (!isRealDate(input.last_date)) return fail('last_date must be a real date as YYYY-MM-DD');
    value.last_date = input.last_date;
  } else if (has(input, 'last_date') || !partial) {
    value.last_date = null; // an explicit null clears it on update; a create without it stores NULL
  }

  if (has(input, 'active')) {
    if (typeof input.active !== 'boolean') return fail('active must be true or false');
    value.active = input.active;
  }

  if (value.first_date && value.last_date && value.last_date < value.first_date) {
    return fail('last_date must not be before first_date');
  }
  return { ok: true, value };
}

function validateSettingsInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('Input must be an object');
  const value = {};

  if (has(input, 'floor_cents')) {
    if (input.floor_cents === null) {
      value.floor_cents = null;
    } else {
      const n = toInt(input.floor_cents);
      if (n === null || n < 0 || n > MAX_FLOOR_CENTS) {
        return fail(`floor_cents must be empty or a whole number of cents from 0 to ${MAX_FLOOR_CENTS}`);
      }
      value.floor_cents = n;
    }
  }

  if (has(input, 'last_year_receipts')) {
    const r = input.last_year_receipts;
    const proto = r && typeof r === 'object' ? Object.getPrototypeOf(r) : undefined;
    if (!r || typeof r !== 'object' || Array.isArray(r) || (proto !== Object.prototype && proto !== null)) {
      return fail('last_year_receipts must be an object of month to cents');
    }
    const keys = Object.keys(r);
    if (keys.length > MAX_RECEIPT_MONTHS) return fail(`last_year_receipts can hold at most ${MAX_RECEIPT_MONTHS} months`);
    const clean = {};
    for (const k of keys) {
      if (!MONTH_KEY.test(k)) return fail(`last_year_receipts key "${k}" must look like YYYY-MM`);
      const n = toInt(r[k]);
      if (n === null || n < 0 || n > MAX_RECEIPT_CENTS) {
        return fail(`last_year_receipts value for ${k} must be a whole number of cents from 0 to ${MAX_RECEIPT_CENTS}`);
      }
      clean[k] = n;
    }
    value.last_year_receipts = clean;
  }

  if (!Object.keys(value).length) return fail('Give floor_cents or last_year_receipts');
  return { ok: true, value };
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

module.exports = {
  KINDS,
  CADENCES,
  validateItemInput,
  validateSettingsInput,
  listItems,
  createItem,
  updateItem,
  deactivateItem,
  getSettings,
  saveSettings,
};
