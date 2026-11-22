'use strict';

/**
 * The only module that touches the database for the mail lists: mail_prospects (this feature's table) and two reads
 * of tables other jobs fill (construction_permit_records, customers). Every function takes a knex handle or a
 * transaction as its last argument so a test can inject one; the default is the portal's shared handle.
 */

const db = require('../../models/db');
const { looseAddressKey } = require('../property-lookup/manatee-permit-sync');

const LIVE_PARCEL_INDEX = 'mail_prospects_one_live_per_parcel';
const KNOWN_ADDRESS_LIMIT = 200;
const NEW_HOME_CO_MONTHS = 24;

// Every writable column. A save writes all of them, so a row that was `unmatched` and is now matched (or the other
// way round) never keeps a stale parcel or permit from the earlier read.
const COLUMNS = [
  'recorded_date', 'seller_names', 'recipient_names', 'buyer_kind', 'consideration', 'legal_description',
  'status', 'reason', 'match_basis', 'parcel_pin', 'permit_no', 'co_date', 'address_line1', 'city', 'state', 'zip',
  'subdivision', 'living_sqft', 'stories', 'year_built',
];
const JSON_COLUMNS = new Set(['seller_names', 'recipient_names']);

/**
 * The forms a county parcel number (PARID, 9 or 10 digits) can take in construction_permit_records.parcel_pin. The
 * county's permit report writes 13 digits (the PARID padded with zeros on the right) and the permit sync keeps the
 * first 10, so the pin of a 10-digit PARID is the PARID and the pin of a 9-digit one is the PARID plus one 0.
 */
function permitPinForms(parid) {
  const id = String(parid || '');
  if (!/^\d{9,10}$/.test(id)) return [];
  const padded = id.padEnd(10, '0');
  return padded === id ? [id] : [id, padded];
}

async function findBySourceRefs(listKey, source, refs, conn = db) {
  if (!refs || refs.length === 0) return [];
  return conn('mail_prospects')
    .where({ list_key: listKey, source })
    .whereIn('source_ref', refs)
    .select('id', 'source_ref', 'status', 'reason', 'last_checked_at');
}

/**
 * The newest new-home permit for each parcel number, as `{ [parid]: permit row }`. A new-home permit is a
 * residential permit whose work starts with "New", is not an accessory building or a guest house, is not
 * canceled or withdrawn, and has no certificate of occupancy older than NEW_HOME_CO_MONTHS.
 */
async function newHomePermitsByParid(parids, conn = db) {
  // A permit number keyed by the parcel it belongs to. The padded form of a 9-digit parcel can equal another
  // parcel's own 10-digit number, so the padded forms go in first and each parcel's exact number then wins.
  const parOfPin = new Map();
  const known = (parids || []).filter((parid) => permitPinForms(parid).length > 0);
  for (const parid of known) {
    for (const pin of permitPinForms(parid)) if (pin !== parid) parOfPin.set(pin, parid);
  }
  for (const parid of known) parOfPin.set(String(parid), parid);
  if (parOfPin.size === 0) return {};
  const rows = await conn('construction_permit_records')
    .whereIn('parcel_pin', [...parOfPin.keys()])
    .whereRaw("LOWER(COALESCE(permit_type, '')) = 'residential'")
    .whereRaw("type_of_work ILIKE 'New%'")
    .whereRaw("type_of_work NOT ILIKE '%accessory%'")
    .whereRaw("type_of_work NOT ILIKE '%guest%'")
    .whereRaw("LOWER(COALESCE(status, '')) NOT IN ('canceled', 'withdrawn')")
    // A home finished long ago is not a new home any more: a company that sells it now is an investor, not its
    // builder. No certificate of occupancy yet still counts (some builders close before the county files it).
    .whereRaw('(co_date IS NULL OR co_date >= CURRENT_DATE - make_interval(months => ?))', [NEW_HOME_CO_MONTHS])
    .orderByRaw('issued_date DESC NULLS LAST, permit_no DESC')
    // Dates come back as YYYY-MM-DD text: a pg DATE read as a JS Date can slip a day with the server's time zone.
    .select('permit_no', 'parcel_pin', conn.raw("to_char(co_date, 'YYYY-MM-DD') AS co_date"), conn.raw("to_char(issued_date, 'YYYY-MM-DD') AS issued_date"));
  const out = {};
  for (const row of rows) {
    const parid = parOfPin.get(row.parcel_pin);
    if (parid && !out[parid]) out[parid] = row; // rows come newest first: keep the first
  }
  return out;
}

/**
 * True when any customers row (customer, lead or cancelled) has the same house number, first street word and zip.
 * The query narrows by zip and house number (the number is digits only and bound as a parameter); the street word
 * is compared in JS with the same loose key the permit sync uses.
 */
async function addressKnownToWaves(addressLine1, zip, conn = db) {
  const key = looseAddressKey(addressLine1, zip);
  const number = String(addressLine1 || '').trim().match(/^(\d+)\s/);
  const zip5 = String(zip || '').match(/\d{5}/);
  if (!key || !number || !zip5) return false;
  const rows = await conn('customers')
    .where('zip', 'like', `${zip5[0]}%`)
    .whereRaw('address_line1 ILIKE ?', [`${number[1]} %`])
    .limit(KNOWN_ADDRESS_LIMIT)
    .select('address_line1', 'zip');
  return rows.some((r) => looseAddressKey(r.address_line1, r.zip) === key);
}

function writableFields(row) {
  const out = {};
  for (const col of COLUMNS) {
    let value = row[col] === undefined ? null : row[col];
    if (col === 'state' && value === null) value = 'FL';
    if (JSON_COLUMNS.has(col)) value = JSON.stringify(value || []);
    out[col] = value;
  }
  return out;
}

async function upsert(row, conn) {
  const fields = writableFields(row);
  const now = conn.fn.now();
  const [saved] = await conn('mail_prospects')
    .insert({
      list_key: row.list_key, source: row.source, source_ref: row.source_ref, ...fields,
      first_seen_at: now, last_checked_at: now, created_at: now, updated_at: now,
    })
    .onConflict(['list_key', 'source', 'source_ref'])
    .merge({ ...fields, last_checked_at: now, updated_at: now }) // first_seen_at and created_at stay as they were
    .returning('status');
  return saved.status;
}

/**
 * Insert the row, or update the one with the same (list_key, source, source_ref). When the home is already live on
 * the list under another deed, the unique index refuses the write; the row is then kept as not_eligible with the
 * reason duplicate_parcel, so the deed is never read again and the run does not fail. The attempt runs in its own
 * (nested) transaction so the refusal never poisons a caller's transaction. Returns the status that was saved.
 */
async function saveProspect(row, conn = db) {
  try {
    return await conn.transaction((trx) => upsert(row, trx));
  } catch (err) {
    if (err && err.code === '23505' && String(err.constraint || err.message).includes(LIVE_PARCEL_INDEX)) {
      return conn.transaction((trx) => upsert({ ...row, status: 'not_eligible', reason: 'duplicate_parcel' }, trx));
    }
    throw err;
  }
}

module.exports = {
  findBySourceRefs, newHomePermitsByParid, addressKnownToWaves, saveProspect, permitPinForms, NEW_HOME_CO_MONTHS,
};
