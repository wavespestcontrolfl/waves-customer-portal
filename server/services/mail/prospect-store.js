'use strict';

/**
 * The only module that touches the database for the mail lists: mail_prospects (this feature's table) and two reads
 * of tables other jobs fill (construction_permit_records, customers). Every function takes a knex handle or a
 * transaction as its last argument so a test can inject one; the default is the portal's shared handle.
 */

const db = require('../../models/db');
const {
  looseAddressKey, monthsAgoIso, CONSTRUCTION_ACTIVE_MONTHS, ACTIVE_SEEN_WITHIN_DAYS,
} = require('../property-lookup/manatee-permit-sync');

// The two partial unique indexes over the live rows, and the reason a row gets when one of them refuses it.
const LIVE_INDEX_REASONS = {
  mail_prospects_one_live_per_parcel: 'duplicate_parcel',
  mail_prospects_one_live_per_permit: 'duplicate_permit',
};
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

const oneLine = (text) => String(text || '').toUpperCase().replace(/\s+/g, ' ').trim();

/**
 * True when the permit's address line names exactly the parcel's street address. The county report writes the line
 * as street, two spaces, city, zip ("200 SAMPLE TRL  PARRISH 34219"); about one line in ten has single spaces only.
 *   - with the two-space break: the street part is the parcel's whole street address (the caller's loose key has
 *     already matched the zip);
 *   - with single spaces only: the whole line is the parcel's street address, city and zip.
 * Any other shape proves nothing. Counted 2026-11-22 on 529 recent permits whose loose key matched their parcel:
 * 528 pass (490 by the street part, 38 by the whole line); the other one is a parcel with a unit number.
 */
function permitNamesParcelAddress(addressRaw, parcel) {
  const street = oneLine(parcel.addressLine1);
  if (!street) return false;
  const parts = String(addressRaw || '').trim().split(/\s{2,}/);
  if (parts.length === 2) return oneLine(parts[0]) === street;
  if (parts.length === 1) return oneLine(parts[0]) === `${street} ${oneLine(parcel.city)} ${oneLine(parcel.zip)}`;
  return false;
}

/**
 * The newest new-home permit of each parcel, as `{ [parid]: permit row }`. `parcels` are the county map's parcels:
 * `{ parid, addressLine1, city, zip }`.
 *
 * A permit is the parcel's own when all three agree:
 *   - its parcel number is a form of the parcel's number (permitPinForms),
 *   - its loose address key is the parcel's (the permit sync's key: house number, first street word, zip), and
 *   - its address line names exactly the parcel's street address (permitNamesParcelAddress).
 * The number alone is not proof. The pin of a 9-digit parcel number P is P plus a 0, and P0 can be another parcel's
 * own 10-digit number (5 such pairs on the county map, counted 2026-11-22). The loose key alone is not proof either:
 * it drops the street's last words, so "101 Sample Ct" and "101 Sample Dr" share one. The whole street address
 * settles it, and each parcel is judged alone, so the answer does not depend on which other parcels are asked in
 * the same call. A parcel or a permit without an address proves nothing: no permit. Two parcels that share a number
 * form and the whole address are one mailbox; the table's permit index then lets only one of them be live.
 *
 * A new-home permit is a residential permit whose work starts with "New", is not an accessory building or a guest
 * house, is not canceled or withdrawn, and is one of:
 *   - finished: a certificate of occupancy in the last NEW_HOME_CO_MONTHS months. A home finished long ago is not a
 *     new home any more: a company that sells it now is an investor, not its builder.
 *   - still open: no certificate yet (some builders close before the county files it), by the permit sync's own
 *     rule for "under construction": issued in the last CONSTRUCTION_ACTIVE_MONTHS months, seen in the county's
 *     report in the last ACTIVE_SEEN_WITHIN_DAYS days, not closed. A permit that left the report keeps its last
 *     status for ever; it must not count for ever.
 * Months count back from today in Eastern time (monthsAgoIso), not from the database session's date.
 */
async function newHomePermitsForParcels(parcels, conn = db) {
  const wanted = new Map(); // pin form -> the parcels that could own a permit under it
  for (const parcel of parcels || []) {
    const key = looseAddressKey(parcel?.addressLine1, parcel?.zip);
    if (!key) continue;
    for (const pin of permitPinForms(parcel.parid)) {
      if (!wanted.has(pin)) wanted.set(pin, []);
      wanted.get(pin).push({ parid: String(parcel.parid), key, parcel });
    }
  }
  if (wanted.size === 0) return {};
  const coFloor = monthsAgoIso(NEW_HOME_CO_MONTHS);
  const issuedFloor = monthsAgoIso(CONSTRUCTION_ACTIVE_MONTHS);
  const seenAfter = new Date(Date.now() - ACTIVE_SEEN_WITHIN_DAYS * 24 * 60 * 60 * 1000);
  const rows = await conn('construction_permit_records')
    .whereIn('parcel_pin', [...wanted.keys()])
    .whereRaw("LOWER(COALESCE(permit_type, '')) = 'residential'")
    .whereRaw("type_of_work ILIKE 'New%'")
    .whereRaw("type_of_work NOT ILIKE '%accessory%'")
    .whereRaw("type_of_work NOT ILIKE '%guest%'")
    .whereRaw("LOWER(COALESCE(status, '')) NOT IN ('canceled', 'withdrawn')")
    .where((b) => b
      .where('co_date', '>=', coFloor)
      .orWhere((open) => open
        .whereNull('co_date')
        .where('issued_date', '>=', issuedFloor)
        .where('last_seen_at', '>=', seenAfter)
        .whereRaw("LOWER(COALESCE(status, '')) <> 'closed'")))
    .orderByRaw('issued_date DESC NULLS LAST, permit_no DESC')
    // Dates come back as YYYY-MM-DD text: a pg DATE read as a JS Date can slip a day with the server's time zone.
    .select('permit_no', 'parcel_pin', 'address_loose_key', 'address_raw', conn.raw("to_char(co_date, 'YYYY-MM-DD') AS co_date"), conn.raw("to_char(issued_date, 'YYYY-MM-DD') AS issued_date"));
  const out = {};
  for (const row of rows) { // newest first: a parcel keeps its first
    for (const { parid, key, parcel } of wanted.get(row.parcel_pin) || []) {
      if (!out[parid] && row.address_loose_key === key && permitNamesParcelAddress(row.address_raw, parcel)) out[parid] = row;
    }
  }
  return out;
}

/**
 * True when any customers row (customer, lead or cancelled) has the same house number, first street word and zip:
 * the same loose key the permit sync uses, compared in JS.
 *
 * The query only narrows, and it cannot drop a row with the same key: a key is made from the house number and the
 * zip's five digits, so such a row holds both (wherever the spaces, tabs or a ZIP+4 are). Both are digits only and
 * bound as parameters. Every candidate is read: a cut-off list could hide the one row that is this home.
 */
async function addressKnownToWaves(addressLine1, zip, conn = db) {
  const key = looseAddressKey(addressLine1, zip);
  const number = String(addressLine1 || '').trim().match(/^\d+/);
  const zip5 = String(zip || '').match(/\d{5}/);
  if (!key || !number || !zip5) return false;
  const rows = await conn('customers')
    .where('zip', 'like', `%${zip5[0]}%`)
    .where('address_line1', 'like', `%${number[0]}%`)
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
 * the list under another deed, or its permit already backs another live home, a unique index refuses the write; the
 * row is then kept as not_eligible with the reason duplicate_parcel or duplicate_permit, so the deed is never read
 * again and the run does not fail. Any other refusal (a live row without a parcel or a permit, an unknown status)
 * is the caller's error and is thrown. Returns the status that was saved.
 *
 * The write and its fallback are one unit: one transaction (a savepoint inside a caller's transaction) that first
 * takes a lock on the deed's identity. A second save of the same deed waits for the whole first save, so it can
 * never land between the refused write and the fallback and then be overwritten by that fallback. The first write
 * runs in its own savepoint, so a refusal rolls back only that write.
 */
async function saveProspect(row, conn = db) {
  return conn.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [`mail_prospects:${row.list_key}:${row.source}:${row.source_ref}`]);
    try {
      return await trx.transaction((attempt) => upsert(row, attempt));
    } catch (err) {
      const refused = err && err.code === '23505' ? String(err.constraint || err.message) : '';
      const index = Object.keys(LIVE_INDEX_REASONS).find((name) => refused.includes(name));
      if (!index) throw err;
      return upsert({ ...row, status: 'not_eligible', reason: LIVE_INDEX_REASONS[index] }, trx);
    }
  });
}

module.exports = {
  findBySourceRefs, newHomePermitsForParcels, addressKnownToWaves, saveProspect, permitPinForms, NEW_HOME_CO_MONTHS,
};
