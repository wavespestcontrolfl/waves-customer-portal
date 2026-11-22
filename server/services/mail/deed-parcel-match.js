'use strict';

/**
 * Turns a Clerk deed's legal description ("LOT 171 BLK 48 RYE RANCH") into the parcel it names, using the county
 * parcel map the portal already reads, and says whether that parcel is one brand-new home.
 *
 * One lot number exists in several phases of a subdivision, and the Clerk's text leaves the phase out, so a lot query
 * often returns 2 to 13 parcels. Which of them the deed means cannot be proven from owner names: spellings vary, the
 * map shows the seller for weeks after the deed, and a builder can hold the same lot number twice. So a deed matches
 * only when the query returns exactly one parcel, that parcel's plat name is the deed's subdivision by an exact
 * grammar, and it has a new-home permit. Everything else is "not matched", with the reason.
 *
 * The query is wider than the decision, and it covers every spelling the decision reads as the same lot or the same
 * name (one list of lot forms, one letters-and-digits comparison, used by both). So the map's own spelling cannot
 * hide a second parcel from "exactly one".
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
 * metes and bounds, several lots). The character set is narrow, and parcelWhere lets only its capitals and digits
 * reach the where string (no quote, no % or _ wildcard, no semicolon or parenthesis).
 */
function parseLegal(description) {
  const text = String(description || '').toUpperCase().replace(/\s+/g, ' ').trim();
  const m = text.match(LEGAL_PATTERN);
  if (!m || SEVERAL_LOTS.test(m[3])) return null;
  return { lot: m[1], block: m[2] || null, subdivision: m[3] };
}

// The forms one deed lot or block number can have on the map: itself, without leading zeros, zero-padded up to four
// characters ("5", "05", "005", "0005"; "12A", "012A"), and each with lower-case letters ("12a"). Measured
// 2026-11-22: 346 parcels have a lot with a leading zero (91 values, "01" to "0406"), 22 have a lower-case letter in
// the lot. This list is the query's IN list and the local test of "the same number": one definition for both.
function mapForms(value) {
  const bare = value.replace(/^0+(?=.)/, '');
  const forms = new Set([value, bare]);
  if (/^\d/.test(bare)) for (let width = bare.length + 1; width <= 4; width += 1) forms.add(bare.padStart(width, '0'));
  for (const form of [...forms]) forms.add(form.toLowerCase());
  return [...forms];
}
const sameNumber = (mapValue, deedValue) => mapForms(deedValue).includes(mapValue || '');

// The letters and digits of the deed's subdivision words ("O'NEIL ESTATES" = ONEILESTATES). Two names are the same
// name up to this key: spacing and punctuation differ on the map ("RYE  RANCH", "ST. JOHNS", "ST JOHN'S").
const lettersOf = (text) => text.replace(/[^A-Z0-9]/g, '');

// The query is wider than the decision, and covers everything the decision reads as the same:
//   lot, block   field IN (every form of the number, mapForms).
//   subdivision  the deed's letters and digits in order, with anything between and after them:
//                LIKE 'R%Y%E%R%A%N%C%H%'. That returns every name with this key at its start, however the map
//                spaces or punctuates it (2,004 parcels have two spaces together in the name, 650 an apostrophe),
//                and some names with other letters, which are set aside locally.
// Shapes: field IN ('..', ...) and one LIKE, joined by AND. No OR, no function. The county's firewall answers these
// shapes (measured 2026-11-22 on the lots of 69 real deeds: no rejection, about 0.5 s each, the same parcels as an
// exact prefix) and rejects others with an HTML "Request Rejected" page (two UPPER(...) calls joined by AND or OR;
// see also the 10-02 notes in county-parcel-gis.js). The map stores the names in capitals (no parcel's name has a
// lower-case letter, counted 2026-11-22), so no function is needed. A rejected request is not JSON: it throws below,
// an outage, never "no parcel". Only capitals and digits of the deed's text reach the where string.
function parcelWhere(legal) {
  // The values parseLegal gives, and no other: capitals and digits for the numbers, LEGAL_PATTERN's signs in the name.
  const plain = (value, max) => typeof value === 'string' && value.length <= max && /^[0-9A-Z]+$/.test(value);
  const named = typeof legal.subdivision === 'string' && /^[A-Z0-9][A-Z0-9 &'.-]*$/.test(legal.subdivision);
  if (!plain(legal.lot, 6) || !named || (legal.block && !plain(legal.block, 4))) throw new TypeError('parcelWhere needs the lot, block and subdivision of a parsed deed');
  const letters = lettersOf(legal.subdivision);
  const inList = (value) => mapForms(value).map((form) => `'${form}'`).join(', ');
  let where = `PAR_SUBDIV_LOT IN (${inList(legal.lot)}) AND PAR_SUBDIV_NAME LIKE '${letters.split('').join('%')}%'`;
  if (legal.block) where += ` AND PAR_SUBDIV_BLOCK IN (${inList(legal.block)})`;
  return where;
}

// True when the map's name is one the query's LIKE pattern returns: the deed's letters and digits in order, the
// first at the start. (A plain search letter by letter, no pattern, so a long name costs linear time.)
function hasDeedLetters(name, letters) {
  let at = 0;
  for (let i = 0; i < letters.length; i += 1) {
    const found = name.indexOf(letters[i], at);
    if (found === -1 || (i === 0 && found !== 0)) return false;
    at = found + 1;
  }
  return letters.length > 0;
}

// The rest of the map's name after the deed's words, comparing letters and digits only. null when the name's
// letters and digits do not start with the deed's: other words, another name ("RYE CREEK RANCH" for "RYE RANCH"),
// which the query returns only because its pattern is wide.
function restAfterDeedWords(name, deedWords) {
  const key = lettersOf(deedWords);
  let matched = 0;
  let at = 0;
  while (matched < key.length && at < name.length) {
    const ch = name[at];
    if ((ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9')) {
      if (ch !== key[matched]) return null;
      matched += 1;
    }
    at += 1;
  }
  return matched === key.length ? name.slice(at) : null;
}

// The map's plat name is the deed's subdivision words, or those words and then a phase and plat-book part: "SAMPLE
// GROVE" on the deed, "SAMPLE GROVE PH IIA PB81/1" on the map. The whole rest of the name must fit this grammar,
// taken from the 126 plat names of 32 real subdivisions (2026-11-22):
//   [PH|PHASE <ids> [SUBPH|SUBPHASE <ids>]] [PB<book>/<page>]   or   SUBDIVISION [PB<book>/<page>]
//   <ids> = phase ids joined by ",", "AND", "&" or a space; an id = IIA, ID9, IV-C1, II-B-9, 9A, N9A, A-D ...
// A name that does not fit ("SAMPLE GROVE ESTATES", "... WEST PB1/2", "... PH II REPLAT OF LOT 4", "... PH III-A
// TOWNHOMES") may be another subdivision or another piece of land: its parcel is marked platKnown false, and
// chooseParcel matches nothing while one is in the answer.
// The rest is read token by token (no pattern runs over the whole list, so a long name costs linear time).
const PHASE_ID = /^(?:[IVX]{1,4}[A-Z]?[0-9]{0,2}|[A-Z]?[0-9]{1,2}[A-Z]?|[A-Z])(?:-(?:[IVX]{1,4}|[0-9]{1,2}[A-Z]?|[A-Z][0-9]{0,2})){0,3}$/;
const isPhaseId = (token) => typeof token === 'string' && token.length <= 12 && PHASE_ID.test(token);
const BOOK_PAGE = /^[0-9]{1,4}\/[0-9]{1,4}$/;
const isPhaseWord = (token) => token === 'PH' || token === 'PHASE';
const isSubphaseWord = (token) => token === 'SUBPH' || token === 'SUBPHASE';
const platTokens = (text) => text.replace(/,/g, ' , ').split(' ').filter(Boolean);

// How far the deed's own words already go into the grammar: 0 no phase, 1 a phase, 2 a subphase or SUBDIVISION.
// (The Clerk's text leaves the phase out in all 69 measured deeds; this keeps "... PH I" on a deed from refusing
// "... PH I SUBPH A PB1/2" on the map.)
function platStage(deedWords) {
  const tokens = platTokens(deedWords);
  if (tokens.some((token) => isSubphaseWord(token) || token === 'SUBDIVISION')) return 2;
  return tokens.some(isPhaseWord) ? 1 : 0;
}

function platRestKnown(rest, startStage) {
  const tokens = platTokens(rest);
  let i = 0;
  // One or more ids; between two ids a comma, AND, &, a comma and then AND or &, or nothing.
  const readIds = () => {
    if (!isPhaseId(tokens[i])) return false;
    i += 1;
    for (;;) {
      let next = i;
      if (tokens[next] === ',') next += 1;
      if (tokens[next] === 'AND' || tokens[next] === '&') next += 1;
      if (!isPhaseId(tokens[next])) return true;
      i = next + 1;
    }
  };
  let stage = startStage;
  if (stage === 0 && tokens[i] === 'SUBDIVISION') {
    i += 1;
    stage = 2;
  } else if (stage === 0 && isPhaseWord(tokens[i])) {
    i += 1;
    if (!readIds()) return false;
    stage = 1;
  }
  if (stage === 1 && isSubphaseWord(tokens[i])) {
    i += 1;
    if (!readIds()) return false;
  }
  const book = tokens[i] || '';
  if (book.startsWith('PB') && BOOK_PAGE.test(book.slice(2))) i += 1;
  else if (book === 'PB' && BOOK_PAGE.test(tokens[i + 1] || '')) i += 2;
  return i > 0 && i === tokens.length;
}

// How the map's plat name relates to the deed's subdivision words:
//   'known'    the deed's words, or those words and then a rest that fits the grammar.
//   'unknown'  the deed's words and then something else ("... ESTATES", "RYE RANCHES"): maybe the same land.
//   'other'    other words: another name.
function platRelation(mapName, deedWords) {
  const rest = restAfterDeedWords(String(mapName || '').toUpperCase(), deedWords);
  if (rest === null) return 'other';
  if (/^[A-Z0-9]/.test(rest)) return 'unknown'; // the deed's words end inside a word of the map's name
  const tail = rest.replace(/ +/g, ' ').trim();
  return tail === '' || platRestKnown(tail, platStage(deedWords)) ? 'known' : 'unknown';
}

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
  // The answer must be the answer to this question: a form of the lot, the subdivision's letters in order and (when
  // asked) a form of the block.
  const asked = sameNumber(parcel.lot, legal.lot)
    && hasDeedLetters((parcel.subdivision || '').toUpperCase(), lettersOf(legal.subdivision))
    && (!legal.block || sameNumber(parcel.block, legal.block));
  if (!asked) throw new Error('parcel map sent a parcel that is not the lot asked for');
  const relation = platRelation(parcel.subdivision, legal.subdivision);
  parcel.platKnown = relation === 'other' ? null : relation === 'known';
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
  // A parcel under other words is not a candidate. Every parcel whose letters and digits start with the deed's
  // stays in the list, known plat name or not.
  return parcels.filter((p) => p.platKnown !== null);
}

// A name's compare key: accents folded (GARCÍA = GARCIA), "&" read as AND, then capitals and digits only (the map
// writes "M/I HOMES OF SARASOTA LLC" where the deed says "M I HOMES OF SARASOTA LLC"). '' for no name and for a name
// with a letter that is still not plain ASCII: such a name is equal to nothing.
function nameKey(name) {
  const folded = String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/&/g, ' AND ');
  return /[^\x00-\x7F]/.test(folded) ? '' : folded.replace(/[^A-Z0-9]/g, '');
}

// True when one of the map's two owner fields is exactly a seller's name (by compare key). It only labels a match
// (the map still shows the seller: the deed and the map agree). It never decides one.
function sellerOwns(parcel, sellerNames) {
  const sellers = new Set((sellerNames || []).map(nameKey).filter(Boolean));
  return [parcel.ownerName, parcel.ownerName2].map(nameKey).some((key) => key && sellers.has(key));
}

/**
 * Whether the parcels a lot query returned are one new home: { status: 'matched', basis, parcel, permit }, or the
 * reason they are not. `parcels` is the list queryParcels resolved with; `permitsByParid` is the permit read for
 * those parcels (an object, empty when none has a permit). A missing input throws.
 *   no_parcel     the map has no such lot.
 *   no_permit     no parcel of the answer has a new-home permit.
 *   unknown_plat  a parcel of the answer has a plat name that is not the deed's subdivision by the grammar.
 *   ambiguous     the lot number exists in more than one phase. (Which one the deed means is not proven here.)
 *   matched       exactly one parcel, and it has a permit. basis = owner_permit when the map still shows the seller
 *                 on it, else permit (the map already shows the next owner, or spells the seller another way).
 * Measured on three real days: 55 of 78 builder-to-person deeds match. 10 more have the lot in several phases; a
 * later check (the buyer's name on the map) could prove those.
 */
function chooseParcel({ sellerNames, parcels, permitsByParid }) {
  // A lookup that was never done is not "nothing found": both inputs must be the results of completed lookups.
  if (!Array.isArray(parcels)) throw new TypeError('chooseParcel needs the parcel list of a completed lookup');
  if (parcels.length === 0) return { status: 'no_parcel' };
  // A plain object only: a Promise (a lookup that was not awaited), a list or a Map has no parcel number keys.
  const proto = permitsByParid === null || typeof permitsByParid !== 'object' ? undefined : Object.getPrototypeOf(permitsByParid);
  if (proto !== Object.prototype && proto !== null) throw new TypeError('chooseParcel needs the permits of a completed lookup');
  const permitOf = (p) => permitsByParid[p.parid] || null;
  if (!parcels.some(permitOf)) return { status: 'no_permit' };
  if (!parcels.every((p) => p.platKnown === true)) return { status: 'unknown_plat' };
  if (parcels.length > 1) return { status: 'ambiguous' };
  const [parcel] = parcels;
  return { status: 'matched', basis: sellerOwns(parcel, sellerNames) ? 'owner_permit' : 'permit', parcel, permit: permitOf(parcel) };
}

module.exports = {
  PARCEL_LAYER_URL, parseLegal, parcelWhere, queryParcels, sellerOwns, chooseParcel,
};
