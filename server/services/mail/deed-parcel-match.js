'use strict';

/**
 * Turns a Clerk deed's legal description ("LOT 171 BLK 48 RYE RANCH") into the parcel it names, using the county
 * parcel map the portal already reads, and picks the one parcel that is a brand-new home.
 *
 * The parcel map still shows the builder as owner for weeks after the deed, and one lot number exists in several
 * phases of a subdivision, so a lot query often returns 2 to 6 parcels. The new-home permit is the proof that a
 * parcel is a new home (a parcel with no such permit is never matched). The owner on the map says which phase the
 * seller conveyed. A match needs positive proof only: one parcel with a permit, and either the seller's exact name
 * on it or no other parcel in the answer. Two names that look different prove nothing (spellings vary), so no rule
 * here reads "this parcel is not the seller's".
 */

const { countyParcelGisDisabled } = require('../property-lookup/county-parcel-gis');

// Same layer as COUNTY_LAYERS.Manatee.url in server/services/property-lookup/county-parcel-gis.js (that constant is
// not exported, so the address is repeated here; change both together).
const PARCEL_LAYER_URL = 'https://gis.manateepao.gov/arcgis/rest/services/Website/WebLayers/MapServer/0/query';
const OUT_FIELDS = 'PARID,SITUS_ADDRESS,SITUS_POSTAL_CITY,SITUS_POSTAL_ZIP,PAR_SUBDIV_NAME,PAR_SUBDIV_LOT,PAR_SUBDIV_BLOCK,PAR_OWNER_NAME1,PAR_OWNER_NAME2,BLDGS_SQFT_LIVING,BLDG_R1_STORIES,BLDG_R1_YRBUILT';
const USER_AGENT = 'Mozilla/5.0 (WavesPortal mail-new-home-list)';
const DEFAULT_TIMEOUT_MS = 15000;
const RESULT_LIMIT = 25;
const MAX_BODY_BYTES = 1024 * 1024; // real answers are 1 to 6 KB
// Every text the map sends for a parcel is plain printable ASCII (measured: A-Z, a-z, 0-9, space and & , - /).
const PLAIN_TEXT = /^[\x20-\x7E]*$/;
// An owner name is only compared, never printed, so a letter with an accent may pass (GARCÍA). Still no control
// character, no replacement character and no other sign.
const OWNER_TEXT = /^[\x20-\x7E\p{L}\p{M}]*$/u;

const LEGAL_PATTERN = /^LOT ([0-9A-Z]{1,6})(?: (?:BLK|BLOCK) ([0-9A-Z]{1,4}))? ([A-Z0-9][A-Z0-9 &'.-]{2,80})$/;
// "LOT 1 AND 2 SAMPLE GROVE" and "LOT 3 THRU 5 ..." name several lots: not one home.
const SEVERAL_LOTS = /^(AND|THRU|THROUGH|TO|&)(\s|$)/;

/**
 * Lot, block and subdivision words from a deed description, or null when it is not one plain lot (a condo unit,
 * metes and bounds, several lots). The character set is so narrow that, once every apostrophe is doubled, the values
 * are safe inside a where string (no quote can end the string, no % or _ wildcard, no semicolon or parenthesis).
 */
function parseLegal(description) {
  const text = String(description || '').toUpperCase().replace(/\s+/g, ' ').trim();
  const m = text.match(LEGAL_PATTERN);
  if (!m || SEVERAL_LOTS.test(m[3])) return null;
  return { lot: m[1], block: m[2] || null, subdivision: m[3] };
}

const quote = (value) => value.replaceAll("'", "''");

// Plain field comparisons joined by AND, and nothing else. The county's firewall answers that shape and rejects
// others with an HTML "Request Rejected" page (measured 2026-11-22, the same in two rounds: two UPPER(...) calls
// joined by AND or OR are rejected; see also the 10-02 notes in county-parcel-gis.js). Production gets answers for an
// AND query on this layer too (the estimator's subdivision query, logged 11-11 and 11-18). The map stores these
// names in capitals (plain and UPPER() counts are equal for 32 real subdivisions), so no function is needed. A
// rejected request is not JSON: it throws below, an outage, never "no parcel".
function parcelWhere(legal) {
  let where = `PAR_SUBDIV_LOT = '${quote(legal.lot)}' AND PAR_SUBDIV_NAME LIKE '${quote(legal.subdivision)}%'`;
  if (legal.block) where += ` AND PAR_SUBDIV_BLOCK = '${quote(legal.block)}'`;
  return where;
}

// The map's subdivision name is the deed's words, or those words and then a phase, unit, section or plat-book part
// ("SAMPLE GROVE" on the deed, "SAMPLE GROVE PH IIA PB81/1" on the map). Measured on three real days: every parcel
// of a deed's lot continues with PH, PHASE, PB<book>/<page> or SUBDIVISION (96 of 96); UNIT, SEC and SECTION are the
// other plat words county-parcel-gis.js knows (subdivisionBaseName). Any other continuation is another plat
// ("SAMPLE GROVE ESTATES", "SAMPLE GROVE WEST PH I", "... PH II" for a deed that says "... PH I"). The query returns
// those too (a LIKE cannot ask for this), and queryParcels drops them.
const PLAT_PART = /^(PH|PHASE|UNIT|SEC|SECTION|SUBDIVISION|PB)(?![A-Z])/;
const namesSubdivision = (mapName, deedWords) => {
  const name = String(mapName || '').toUpperCase();
  return name === deedWords || (name.startsWith(`${deedWords} `) && PLAT_PART.test(name.slice(deedWords.length + 1).trimStart()));
};

const positiveOrNull = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// One text attribute of a parcel: null when the map has none, the trimmed text when it is plain. Anything else (a
// number, a damaged character) fails the lookup: this text may be printed as an address.
function textAttr(attrs, key, allowed = PLAIN_TEXT) {
  const value = attrs[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !allowed.test(value)) throw new Error(`parcel map sent a ${key} that is not plain text`);
  return value.trim() || null;
}

function toParcel(attrs, legal) {
  // A field that was asked for and did not come back is a broken answer, not "the map has none" (which is null):
  // a missing second owner field must never read as "no second owner".
  const lacking = OUT_FIELDS.split(',').find((key) => !Object.hasOwn(attrs, key));
  if (lacking) throw new Error(`parcel map answer lacks the field ${lacking}`);
  const parid = textAttr(attrs, 'PARID');
  // One candidate dropped could make another look like the only one, so a parcel without a usable number fails
  // the lookup. (The map's parcel number is 9 or 10 digits.)
  if (!parid || !/^\d{9,10}$/.test(parid)) throw new Error('parcel map sent a parcel without a 9 or 10 digit parcel number');
  const zip = (textAttr(attrs, 'SITUS_POSTAL_ZIP') || '').match(/^\d{5}/);
  const yearBuilt = positiveOrNull(attrs.BLDG_R1_YRBUILT);
  const livingSqft = positiveOrNull(attrs.BLDGS_SQFT_LIVING); // the map sends 2594.0; the column is an integer
  const parcel = {
    parid,
    addressLine1: textAttr(attrs, 'SITUS_ADDRESS'),
    city: textAttr(attrs, 'SITUS_POSTAL_CITY'),
    zip: zip ? zip[0] : null,
    subdivision: textAttr(attrs, 'PAR_SUBDIV_NAME'),
    lot: textAttr(attrs, 'PAR_SUBDIV_LOT'),
    block: textAttr(attrs, 'PAR_SUBDIV_BLOCK'),
    ownerName: textAttr(attrs, 'PAR_OWNER_NAME1', OWNER_TEXT),
    ownerName2: textAttr(attrs, 'PAR_OWNER_NAME2', OWNER_TEXT),
    livingSqft: livingSqft === null ? null : Math.round(livingSqft),
    stories: positiveOrNull(attrs.BLDG_R1_STORIES),
    yearBuilt: yearBuilt === null ? null : Math.round(yearBuilt),
  };
  // The answer must be the answer to this question: the lot, the subdivision prefix and (when asked) the block.
  const asked = parcel.lot === legal.lot && (parcel.subdivision || '').toUpperCase().startsWith(legal.subdivision)
    && (!legal.block || parcel.block === legal.block);
  if (!asked) throw new Error('parcel map sent a parcel that is not the lot asked for');
  return parcel;
}

// Reads the body's bytes up to the cap, whatever the headers say (the capped read of bid-desk/charlotte-county.js),
// then decodes them as strict UTF-8: a damaged byte is an error, never a replacement character in an address.
async function readCapped(res) {
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error('parcel map answer is too large');
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error('parcel map answer is too large');
    }
    chunks.push(Buffer.from(value));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new Error('parcel map answer is not valid UTF-8');
  }
}

async function queryParcels(legal, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  // The portal's kill switch for county parcel maps. Off is "no answer" (an error), never "no parcel".
  if (countyParcelGisDisabled()) throw new Error('parcel map lookups are turned off (COUNTY_PARCEL_GIS_DISABLED)');
  const params = new URLSearchParams({
    where: parcelWhere(legal),
    outFields: OUT_FIELDS,
    returnGeometry: 'false',
    resultRecordCount: String(RESULT_LIMIT),
    f: 'json',
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let text;
  try {
    const res = await fetchImpl(`${PARCEL_LAYER_URL}?${params}`, {
      method: 'GET',
      redirect: 'manual', // the map answers directly; a 3xx is refused below, so no other site can supply parcels
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (res.status !== 200) throw new Error(`parcel map answered HTTP ${res.status}`);
    text = await readCapped(res);
  } finally {
    clearTimeout(timer);
    controller.abort(); // ends a request whose answer was refused before its body was read to the end
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error('parcel map answer is not JSON');
  }
  if (!body || typeof body !== 'object') throw new Error('parcel map answer is not JSON');
  if (body.error) throw new Error('parcel map answered with an error');
  // "No parcel" is an answer only when the map says so with an empty list; a missing list is a broken answer.
  if (!Array.isArray(body.features)) throw new Error('parcel map answer has no parcel list');
  // A full list may be a cut-off list, whether or not the map says so. (The most seen for one lot is 13.)
  if (body.exceededTransferLimit || body.features.length >= RESULT_LIMIT) throw new Error('parcel map answer was cut off (too many parcels)');
  const parcels = body.features.map((f) => toParcel(f?.attributes || {}, legal));
  if (new Set(parcels.map((p) => p.parid)).size !== parcels.length) throw new Error('parcel map sent one parcel twice');
  return parcels.filter((p) => namesSubdivision(p.subdivision, legal.subdivision));
}

// A name's compare key: accents folded (GARCÍA = GARCIA), "&" read as AND, then capitals and digits only (the map
// writes "M/I HOMES OF SARASOTA LLC" where the deed says "M I HOMES OF SARASOTA LLC"). '' for no name and for a name
// with a letter that is still not plain ASCII: such a name is equal to nothing.
function nameKey(name) {
  const folded = String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/&/g, ' AND ');
  return /[^\x00-\x7F]/.test(folded) ? '' : folded.replace(/[^A-Z0-9]/g, '');
}

// True when one of the map's two owner fields is exactly a seller's name (by compare key). Measured on three real
// days: 64 of 65 parcels still under the seller's name are this form; the map does not cut names short. A spelling
// that differs more is not the seller's here, and that only ever costs a match.
function sellerOwns(parcel, sellerNames) {
  const sellers = new Set((sellerNames || []).map(nameKey).filter(Boolean));
  return [parcel.ownerName, parcel.ownerName2].map(nameKey).some((key) => key && sellers.has(key));
}

/**
 * The one new home among the parcels a lot query returned, or why there is none. Only a parcel with a new-home
 * permit can be the home, and there must be exactly one.
 *   owner_permit  that parcel is under the seller's exact name on the map.
 *   permit        that parcel is the only parcel the query returned: it is the lot the deed names (the map already
 *                 shows the next owner, or spells the seller another way).
 * Everything else is ambiguous: two parcels with a permit (the same lot number in two phases; who owns the other
 * one cannot be proven from a name), or several parcels where the one with the permit is not under the seller's
 * exact name. The owners of the other parcels are never read. Measured on three real days: 60 of 78 deeds match
 * (56 owner_permit, 4 permit); 6 more would need a second proof, such as the buyer's name on the map later.
 */
function chooseParcel({ sellerNames, parcels, permitsByParid }) {
  if (!parcels || parcels.length === 0) return { status: 'no_parcel' };
  const withPermit = parcels.filter((p) => Boolean(permitsByParid && permitsByParid[p.parid]));
  if (withPermit.length === 0) return { status: 'no_permit' };
  if (withPermit.length > 1) return { status: 'ambiguous' };
  const [home] = withPermit;
  const pick = (basis) => ({ status: 'matched', basis, parcel: home, permit: permitsByParid[home.parid] });
  if (sellerOwns(home, sellerNames)) return pick('owner_permit');
  return parcels.length === 1 ? pick('permit') : { status: 'ambiguous' };
}

module.exports = {
  PARCEL_LAYER_URL, parseLegal, parcelWhere, queryParcels, sellerOwns, chooseParcel,
};
