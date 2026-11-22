'use strict';

/**
 * Turns a Clerk deed's legal description ("LOT 171 BLK 48 RYE RANCH") into the parcel it names, using the county
 * parcel map the portal already reads, and picks the one parcel that is a brand-new home.
 *
 * The parcel map still shows the builder as owner for weeks after the deed, and one lot number exists in several
 * phases of a subdivision, so a lot query often returns 2 to 6 parcels. The new-home permit is the proof that a
 * parcel is a new home (a parcel with no such permit is never matched); the owner test only picks the right phase
 * when more than one parcel has a permit.
 */

// Same layer as COUNTY_LAYERS.Manatee.url in server/services/property-lookup/county-parcel-gis.js (that constant is
// not exported, so the address is repeated here; change both together).
const PARCEL_LAYER_URL = 'https://gis.manateepao.gov/arcgis/rest/services/Website/WebLayers/MapServer/0/query';
const OUT_FIELDS = 'PARID,SITUS_ADDRESS,SITUS_POSTAL_CITY,SITUS_POSTAL_ZIP,PAR_SUBDIV_NAME,PAR_SUBDIV_LOT,PAR_SUBDIV_BLOCK,PAR_OWNER_NAME1,BLDGS_SQFT_LIVING,BLDG_R1_STORIES,BLDG_R1_YRBUILT';
const USER_AGENT = 'Mozilla/5.0 (WavesPortal mail-new-home-list)';
const DEFAULT_TIMEOUT_MS = 15000;
const RESULT_LIMIT = 25;
const MIN_PREFIX_LENGTH = 8;

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

function parcelWhere(legal) {
  let where = `PAR_SUBDIV_LOT = '${quote(legal.lot)}' AND PAR_SUBDIV_NAME LIKE '${quote(legal.subdivision)}%'`;
  if (legal.block) where += ` AND PAR_SUBDIV_BLOCK = '${quote(legal.block)}'`;
  return where;
}

const positiveOrNull = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

function toParcel(attrs) {
  const parid = String(attrs.PARID || '').trim();
  if (!parid) return null;
  const zip = String(attrs.SITUS_POSTAL_ZIP || '').match(/^\d{5}/);
  const yearBuilt = positiveOrNull(attrs.BLDG_R1_YRBUILT);
  const livingSqft = positiveOrNull(attrs.BLDGS_SQFT_LIVING); // the map sends 2594.0; the column is an integer
  return {
    parid,
    addressLine1: String(attrs.SITUS_ADDRESS || '').trim() || null,
    city: String(attrs.SITUS_POSTAL_CITY || '').trim() || null,
    zip: zip ? zip[0] : null,
    subdivision: String(attrs.PAR_SUBDIV_NAME || '').trim() || null,
    lot: String(attrs.PAR_SUBDIV_LOT || '').trim() || null,
    block: String(attrs.PAR_SUBDIV_BLOCK || '').trim() || null,
    ownerName: String(attrs.PAR_OWNER_NAME1 || '').trim() || null,
    livingSqft: livingSqft === null ? null : Math.round(livingSqft),
    stories: positiveOrNull(attrs.BLDG_R1_STORIES),
    yearBuilt: yearBuilt === null ? null : Math.round(yearBuilt),
  };
}

async function queryParcels(legal, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const params = new URLSearchParams({
    where: parcelWhere(legal),
    outFields: OUT_FIELDS,
    returnGeometry: 'false',
    resultRecordCount: String(RESULT_LIMIT),
    f: 'json',
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let body;
  try {
    const res = await fetchImpl(`${PARCEL_LAYER_URL}?${params}`, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (res.status !== 200) throw new Error(`parcel map answered HTTP ${res.status}`);
    try {
      body = JSON.parse(await res.text());
    } catch {
      throw new Error('parcel map answer is not JSON');
    }
  } finally {
    clearTimeout(timer);
  }
  if (!body || typeof body !== 'object') throw new Error('parcel map answer is not JSON');
  if (body.error) throw new Error('parcel map answered with an error');
  if (body.exceededTransferLimit) throw new Error('parcel map answer was cut off (too many parcels)');
  return (Array.isArray(body.features) ? body.features : []).map((f) => toParcel(f?.attributes || {})).filter(Boolean);
}

const alnum = (name) => String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// The map writes "M/I HOMES OF SARASOTA LLC" where the deed says "M I HOMES OF SARASOTA LLC", and sometimes cuts a
// long name short, so a name that starts the other counts when it is long enough not to be a coincidence.
function ownerMatchesSeller(ownerName, sellerNames) {
  const owner = alnum(ownerName);
  if (!owner) return false;
  return (sellerNames || []).some((seller) => {
    const s = alnum(seller);
    if (!s) return false;
    if (s === owner) return true;
    const [shorter, longer] = s.length <= owner.length ? [s, owner] : [owner, s];
    return shorter.length >= MIN_PREFIX_LENGTH && longer.startsWith(shorter);
  });
}

function chooseParcel({ sellerNames, parcels, permitsByParid }) {
  if (!parcels || parcels.length === 0) return { status: 'no_parcel' };
  const withPermit = parcels.filter((p) => permitsByParid && permitsByParid[p.parid]);
  const sellerOwned = withPermit.filter((p) => ownerMatchesSeller(p.ownerName, sellerNames));
  const pick = (parcel, basis) => ({ status: 'matched', basis, parcel, permit: permitsByParid[parcel.parid] });
  if (sellerOwned.length === 1) return pick(sellerOwned[0], 'owner_permit');
  if (withPermit.length === 1 && sellerOwned.length === 0) return pick(withPermit[0], 'permit');
  if (withPermit.length === 0) return { status: 'no_permit' };
  return { status: 'ambiguous' };
}

module.exports = {
  PARCEL_LAYER_URL, parseLegal, parcelWhere, queryParcels, ownerMatchesSeller, chooseParcel,
};
