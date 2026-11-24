// Phone → "does any LIVE customer record know this number?" — the single
// identity mechanism shared by the pre-connect voice screen (known-caller
// bypass) and the admin spam-disposition guard. One column set, one query.
//
// Column set = the call pipeline's CONTACT_MATCH_PHONE_COLS (primary phone +
// the three service-contact slots it records spouses/tenants into) plus
// secondary_phone — identical to call-recording-processor's identityPhoneCols.
// Never a subset: a number the pipeline would attribute to a customer must
// also be one we refuse to hard-block and one the screen lets through.
const { toE164 } = require('./phone');

const KNOWN_CALLER_PHONE_COLS = [
  'phone',
  'service_contact_phone',
  'service_contact2_phone',
  'service_contact3_phone',
  'secondary_phone',
];

function phoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

// 10-digit national key (drops a leading country 1); '' when unparseable.
function customerPhoneLookupKey(value) {
  const normalized = toE164(value);
  const digits = phoneDigits(normalized || value);
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

/**
 * First live customer whose identity phone columns contain `phone`.
 * @param {Function} dbLike knex-like (db or trx)
 * @param {string} phone
 * @param {string[]} [columns] columns to select (default id + name)
 * @returns {Promise<object|null>}
 */
// Live customers whose identity phone columns contain `phone` (at most `limit`).
// `timeoutMs` (optional) puts a cancelling statement timeout on the read.
async function knownCallerCustomers(dbLike, phone, columns, limit, timeoutMs) {
  const key = customerPhoneLookupKey(phone);
  if (!key) return [];
  const keys = key.length === 10 ? [key, `1${key}`] : [key];
  const placeholder = keys.map(() => '?').join(', ');
  const frag = KNOWN_CALLER_PHONE_COLS
    .map((col) => `regexp_replace(COALESCE(${col}, ''), '[^0-9]', '', 'g') IN (${placeholder})`)
    .join(' OR ');
  let query = dbLike('customers')
    .select(columns)
    .whereNull('deleted_at')
    .whereRaw(`(${frag})`, KNOWN_CALLER_PHONE_COLS.flatMap(() => keys));
  if (timeoutMs) query = query.timeout(timeoutMs, { cancel: true });
  const rows = await query.limit(limit);
  return rows || [];
}

async function findKnownCallerCustomer(dbLike, phone, columns = ['id', 'first_name', 'last_name'], timeoutMs) {
  const rows = await knownCallerCustomers(dbLike, phone, columns, 1, timeoutMs);
  return rows[0] || null;
}

/**
 * The ONE live customer whose identity phone columns contain `phone`; null for
 * none or for two or more (never guess). Same columns and keys as
 * findKnownCallerCustomer.
 */
async function findOnlyKnownCallerCustomer(dbLike, phone, columns = ['id']) {
  const rows = await knownCallerCustomers(dbLike, phone, columns, 2);
  return rows.length === 1 ? rows[0] : null;
}

async function knownCallerPhoneExists(dbLike, phone, timeoutMs) {
  return Boolean(await findKnownCallerCustomer(dbLike, phone, ['id'], timeoutMs));
}

module.exports = {
  KNOWN_CALLER_PHONE_COLS,
  customerPhoneLookupKey,
  findKnownCallerCustomer,
  findOnlyKnownCallerCustomer,
  knownCallerPhoneExists,
};
