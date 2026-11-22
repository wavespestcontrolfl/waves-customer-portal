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

// Zips where the county permit report and the parcel map write two names for the same place. Counted 2026-11-22
// on 1,040 permits whose street and zip were the parcel's: 1,029 had the parcel's city name and the other 11 were
// these pairs (PARRISH for PALMETTO in 34221 and 34219, BRADENTON for LAKEWOOD RANCH in 34211). New homes are
// built mostly in these zips, so without the pairs 2 of 55 real matched homes were lost. Any other name: no proof.
const SAME_PLACE_CITY_NAMES = {
  34211: ['BRADENTON', 'LAKEWOOD RANCH'],
  34219: ['PALMETTO', 'PARRISH'],
  34221: ['PALMETTO', 'PARRISH'],
};

function cityNamesOf(city, zip) {
  const names = SAME_PLACE_CITY_NAMES[zip] || [];
  return names.includes(city) ? names : [city];
}

/**
 * True when the permit's address line is exactly the parcel's address: its street address, its city and its zip.
 * The county report writes the line as street, two spaces, city, zip ("200 SAMPLE TRL  PARRISH 34219"); about one
 * line in ten has single spaces only.
 *   - with the two-space break: the first part is the parcel's whole street address and the second part is its city
 *     and zip (so a line "900 SAMPLE CT  E PARRISH 34219" is not the parcel "900 SAMPLE CT");
 *   - with single spaces only: the whole line is the parcel's street address, city and zip.
 * The city is the parcel's own name or its other name in SAME_PLACE_CITY_NAMES. Any other shape, another city name
 * or a missing part proves nothing. Counted 2026-11-22 on 529 recent permits whose loose key matched their parcel:
 * 528 pass; the other one is a parcel with a unit number.
 */
function permitNamesParcelAddress(addressRaw, parcel) {
  const [street, city, zip] = [oneLine(parcel.addressLine1), oneLine(parcel.city), oneLine(parcel.zip)];
  if (!street || !city || !zip) return false;
  const parts = String(addressRaw || '').trim().split(/\s{2,}/).map(oneLine);
  const cityAndZip = cityNamesOf(city, zip).map((name) => `${name} ${zip}`);
  if (parts.length === 2) return parts[0] === street && cityAndZip.includes(parts[1]);
  if (parts.length === 1) return cityAndZip.some((tail) => parts[0] === `${street} ${tail}`);
  return false;
}

/**
 * The newest new-home permit of each parcel, as `{ [parid]: permit row }`. `parcels` are the county map's parcels:
 * `{ parid, addressLine1, city, zip }`.
 *
 * A permit is the parcel's own when all three agree:
 *   - its parcel number is a form of the parcel's number (permitPinForms),
 *   - its loose address key is the parcel's (the permit sync's key: house number, first street word, zip), and
 *   - its address line is exactly the parcel's street address, city and zip (permitNamesParcelAddress).
 * The number alone is not proof. The pin of a 9-digit parcel number P is P plus a 0, and P0 can be another parcel's
 * own 10-digit number (5 such pairs on the county map, counted 2026-11-22). The loose key alone is not proof either:
 * it drops the street's last words, so "101 Sample Ct" and "101 Sample Dr" share one. The whole address
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
 * Months count back from today in Eastern time (monthsAgoIso), not from the database session's date. A certificate
 * or an issue date after today is a mistake in the county's data, not a new home: both dates stop at today.
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
  const today = monthsAgoIso(0);
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
    // An issue date after today on any permit: the newest-first order below would put it before the parcel's
    // real permit. A finished home's permit may have no issue date.
    .where((b) => b.whereNull('issued_date').orWhere('issued_date', '<=', today))
    .where((b) => b
      .whereBetween('co_date', [coFloor, today])
      .orWhere((open) => open
        .whereNull('co_date')
        .whereBetween('issued_date', [issuedFloor, today])
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

const houseNumberOf = (line1) => (String(line1 || '').trim().match(/^\d+(?=\s)/) || [null])[0];

/**
 * True when any customers row (customer, lead or cancelled) has the same house number, first street word and zip:
 * the same loose key the permit sync uses, compared in JS, and the same house number. The key joins the number and
 * the street word with nothing between them ("12 34th St" and "123 4th St" share one), so the number is compared
 * by itself too.
 *
 * The query only narrows, and it cannot drop a row with the same key: a key is made from the house number and the
 * zip's five digits, so such a row holds both (wherever the spaces, tabs or a ZIP+4 are). Both are digits only and
 * bound as parameters. Every candidate is read: a cut-off list could hide the one row that is this home.
 */
async function addressKnownToWaves(addressLine1, zip, conn = db) {
  const key = looseAddressKey(addressLine1, zip);
  const number = houseNumberOf(addressLine1);
  const zip5 = String(zip || '').match(/\d{5}/);
  if (!key || !number || !zip5) return false;
  const rows = await conn('customers')
    .where('zip', 'like', `%${zip5[0]}%`)
    .where('address_line1', 'like', `%${number}%`)
    .select('address_line1', 'zip');
  return rows.some((r) => houseNumberOf(r.address_line1) === number && looseAddressKey(r.address_line1, r.zip) === key);
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

// How careful a stored answer is (see saveProspect). `unmatched` is no answer and has no rank.
const ANSWER_RANK = { eligible: 1, held_back: 1, not_eligible: 2 };

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
    .returning(['status', 'reason']);
  return { status: saved.status, reason: saved.reason, written: true };
}

/**
 * Insert the row, or update the one with the same (list_key, source, source_ref). When the home is already live on
 * the list under another deed, or its permit already backs another live home, a unique index refuses the write; the
 * row is then kept as not_eligible with the reason duplicate_parcel or duplicate_permit, so the deed is never read
 * again and the run does not fail. Any other refusal (a live row without a parcel or a permit, an unknown status)
 * is the caller's error and is thrown. Returns `{ status, reason, written }`: the status and the reason the row
 * holds after the call, and whether this call wrote them.
 *
 * The write and its fallback are one unit: one transaction (a savepoint inside a caller's transaction) that first
 * takes a lock on the deed's identity. A second save of the same deed waits for the whole first save, so it can
 * never land between the refused write and the fallback and then be overwritten by that fallback. The first write
 * runs in its own savepoint, so a refusal rolls back only that write.
 *
 * A save never replaces a stored answer with a less careful one. `unmatched` is "no answer yet"; a live home
 * (eligible, held_back) is an answer; not_eligible is the most careful answer. A stored answer is replaced only by
 * a more careful one: a live home by not_eligible, and nothing replaces not_eligible. Else nothing is written and
 * the stored status and reason are returned with `written: false`. Two runs can judge one deed at the same time. The run that could not reach the
 * parcel map must not undo the other's result, and a home one run found to be a known address must stay
 * not_eligible whichever run saves last. The stored row is read under the same lock.
 */
async function saveProspect(row, conn = db) {
  return conn.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [`mail_prospects:${row.list_key}:${row.source}:${row.source_ref}`]);
    const stored = await trx('mail_prospects')
      .where({ list_key: row.list_key, source: row.source, source_ref: row.source_ref })
      .first('status', 'reason');
    const storedRank = stored ? ANSWER_RANK[stored.status] : undefined;
    if (storedRank && !(ANSWER_RANK[row.status] > storedRank)) {
      return { status: stored.status, reason: stored.reason, written: false };
    }
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
