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
// A deed that names a phase, unit, section or plat book itself ("... PH I", "... UNIT 3") is not handled. The map
// spells such a part in several ways (PH and PHASE), and this module compares names letter by letter: two spellings
// of one part would count as two names. The Clerk's text leaves these parts out (0 of 69 measured deeds have one).
// One id of a phase, subphase, unit or section: IIA, ID9, IV-C1, II-B-9, 9A, N9A, A-D ... The plat-name grammar
// (platRestKnown) reads the map's ids with it, and the deed-side guard below refuses a deed word with it: one
// definition for both.
const PHASE_ID = /^(?:[IVX]{1,4}[A-Z]?[0-9]{0,2}|[A-Z]?[0-9]{1,2}[A-Z]?|[A-Z])(?:-(?:[IVX]{1,4}|[0-9]{1,2}[A-Z]?|[A-Z][0-9]{0,2})){0,3}$/;
const isPhaseId = (token) => typeof token === 'string' && token.length <= 12 && PHASE_ID.test(token);
// A plat-part word: the marker alone, or written as one word with any id the grammar reads ("PH2", "PHIIA",
// "PHN1A", "UNIT3A", "SECB"), or a plat book ("PB", "PB81"). Not PHILLIPS, SECOND. A few plain words read as a
// marker and an id too (PHIL, UNITY): a deed with one is refused, which only means it is not matched.
const PLAT_PART_MARKERS = ['SUBPHASE', 'SUBPH', 'PHASE', 'PH', 'SECTION', 'SEC', 'UNIT'];
const isPlatPartWord = (word) => /^PB\d*$/.test(word)
  || PLAT_PART_MARKERS.some((marker) => word.startsWith(marker) && (word.length === marker.length || isPhaseId(word.slice(marker.length))));
// The words are read three ways, so a marker split by marks or by spaces is seen too: split at every mark
// ("P.H. II" = P, H, II), split at spaces with the marks taken out (PH, II), and with single characters in a row
// joined ("S E C 2" = SEC2).
function platPartReadings(words) {
  const byMark = words.split(/[^A-Z0-9]+/).filter(Boolean);
  const bySpace = words.split(' ').map((word) => word.replace(/[^A-Z0-9]/g, '')).filter(Boolean);
  const joined = [];
  let run = '';
  for (const word of byMark) {
    if (word.length === 1) {
      run += word;
    } else {
      if (run) joined.push(run);
      run = '';
      joined.push(word);
    }
  }
  if (run) joined.push(run);
  return [byMark, bySpace, joined];
}
const namesPlatPart = (words) => platPartReadings(words).some((list) => list.some(isPlatPartWord));
// A lot or block number has one letter at most ("12A", "B"). The map writes a letter in either case, and the list
// of forms (mapForms) covers both cases of one letter, not every mix of two ("12Ab"): such a deed is not handled.
const ONE_NUMBER = /^(?=.)[0-9]*[A-Z]?[0-9]*$/;
// The capitals and digits of a name ("O'NEIL ESTATES" = ONEILESTATES). Two names are the same name up to this key:
// spacing and punctuation differ on the map ("RYE  RANCH", "ST. JOHNS", "ST JOHN'S"). The query and the local
// comparison both use it, on the name as written (no change of case).
const lettersOf = (text) => text.replace(/[^A-Z0-9]/g, '');
// A deed's name must leave a key of three characters at least, and the key may not end with SUBDIVISION: the map
// adds that word to some plat names and leaves it out of others, so parseLegal drops it from the end of the name.
const usableKey = (name) => lettersOf(name).length >= 3 && !lettersOf(name).endsWith('SUBDIVISION');
// A deed has a block or it has none (null, or left out). Every other value must be a valid block number: 0 or ''
// is not "no block", so it cannot drop the block from the question.
const hasBlock = (legal) => legal.block !== null && legal.block !== undefined;

/**
 * Lot, block and subdivision words from a deed description, or null when it is not one plain lot (a condo unit,
 * metes and bounds, several lots), names a phase, unit, section or plat book itself, or has a lot or block number
 * with two letters. The character set is narrow, and parcelWhere lets only its capitals and digits
 * reach the where string (no quote, no % or _ wildcard, no semicolon or parenthesis).
 */
function parseLegal(description) {
  const text = String(description || '').toUpperCase().replace(/\s+/g, ' ').trim();
  const m = text.match(LEGAL_PATTERN);
  if (!m || SEVERAL_LOTS.test(m[3]) || namesPlatPart(m[3])) return null;
  if (!ONE_NUMBER.test(m[1]) || (m[2] && !ONE_NUMBER.test(m[2]))) return null;
  // "SAMPLE GROVE SUBDIVISION" is the plat "SAMPLE GROVE": the map adds that word to some names and leaves it out of
  // others, and the plat-name grammar reads it as an optional part after the name. A mark around the word
  // ("... SUBDIVISION.") changes nothing. A name whose key still ends with it ("... RESUBDIVISION") is not handled.
  const subdivision = m[3].replace(/(?:[^A-Z0-9]+SUBDIVISION)+[^A-Z0-9]*$/, '');
  if (subdivision.length < 3 || !usableKey(subdivision)) return null;
  return { lot: m[1], block: m[2] || null, subdivision };
}

// The forms one deed lot or block number can have on the map: without leading zeros, zero-padded up to six
// characters ("5", "05" ... "000005"; "12A", "012A" ...), and each with lower-case letters ("12a"). The list depends
// only on the number without its zeros, so "5" and "05", or "A" and "0A", give the same list. Measured 2026-11-22:
// 346 parcels have a lot with a leading zero (91 values, "01" to "0406"), 22 have a lower-case letter in the lot.
// This list is the query's IN list and the local test of "the same number": one definition for both.
function mapForms(value) {
  const bare = value.replace(/^0+(?=.)/, '');
  const forms = [];
  for (let width = bare.length; width <= Math.max(6, bare.length); width += 1) forms.push(bare.padStart(width, '0'));
  return [...new Set([...forms, ...forms.map((form) => form.toLowerCase())])];
}
const sameNumber = (mapValue, deedValue) => typeof mapValue === 'string' && mapForms(deedValue).includes(mapValue);

// The query is wider than the decision, and covers everything the decision reads as the same:
//   lot, block   field IN (every form of the number, mapForms).
//   subdivision  the deed's letters and digits in order, with anything between and after them:
//                LIKE 'R%Y%E%R%A%N%C%H%'. That returns every name with this key at its start, however the map
//                spaces or punctuates it (2,004 parcels have two spaces together in the name, 650 an apostrophe),
//                and some names with other letters. Those stay in the answer too, as unknown plats.
// Shapes: field IN ('..', ...) and one LIKE, joined by AND. No OR, no function. The county's firewall answers these
// shapes (measured 2026-11-22 on the lots of 69 real deeds: no rejection, about 0.5 s each, the same parcels as an
// exact prefix) and rejects others with an HTML "Request Rejected" page (two UPPER(...) calls joined by AND or OR;
// see also the 10-02 notes in county-parcel-gis.js). A function on the name is not possible: the firewall also
// rejects one UPPER(PAR_SUBDIV_NAME) LIKE next to the IN lists (69 of 69 lots, measured 2026-11-22). So the pattern
// is in capitals, and the local comparison reads the name as the map sent it, as the query does: a lower-case
// letter is not one of the deed's letters. The map stores the names in capitals (no parcel's name has a lower-case
// letter, counted 2026-11-22). A rejected request is not JSON: it throws below,
// an outage, never "no parcel". Only capitals and digits of the deed's text reach the where string.
function parcelWhere(legal) {
  // The values parseLegal gives, and no other: capitals and digits for the numbers, LEGAL_PATTERN's signs in the name.
  const plain = (value, max) => typeof value === 'string' && value.length <= max && ONE_NUMBER.test(value);
  const named = typeof legal.subdivision === 'string' && /^[A-Z0-9][A-Z0-9 &'.-]{2,}$/.test(legal.subdivision)
    && !namesPlatPart(legal.subdivision) && usableKey(legal.subdivision);
  if (!plain(legal.lot, 6) || !named || (hasBlock(legal) && !plain(legal.block, 4))) throw new TypeError('parcelWhere needs the lot, block and subdivision of a parsed deed');
  const letters = lettersOf(legal.subdivision);
  const inList = (value) => mapForms(value).map((form) => `'${form}'`).join(', ');
  let where = `PAR_SUBDIV_LOT IN (${inList(legal.lot)}) AND PAR_SUBDIV_NAME LIKE '${letters.split('').join('%')}%'`;
  if (hasBlock(legal)) where += ` AND PAR_SUBDIV_BLOCK IN (${inList(legal.block)})`;
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

// The marks a plat name has between its letters and digits (a deed's name has the same ones, LEGAL_PATTERN). Only
// these are passed over in the comparison. The query's pattern lets anything stand between two letters, so the map
// can send "RYE east RANCH" for "RYE RANCH": that is other words, not the deed's name with marks.
const NAME_MARKS = " &'.,-";

// The map's name split where the deed's letters and digits end, comparing capitals and digits only: the part the
// deed's words cover, and the rest. null when the name's capitals and digits do not start with the deed's, or
// something that is not a mark stands between them: other words ("RYE CREEK RANCH" for "RYE RANCH"), which the
// query returns because its pattern is wide.
function splitAtDeedWords(name, deedWords) {
  const key = lettersOf(deedWords);
  let matched = 0;
  let at = 0;
  while (matched < key.length && at < name.length) {
    const ch = name[at];
    if ((ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9')) {
      if (ch !== key[matched]) return null;
      matched += 1;
    } else if (!NAME_MARKS.includes(ch)) {
      return null; // a lower-case letter or a sign never seen between the deed's letters: not the deed's name
    }
    at += 1;
  }
  return matched === key.length ? { covered: name.slice(0, at), rest: name.slice(at) } : null;
}

// The map's plat name is the deed's subdivision words, or those words and then a phase and plat-book part: "SAMPLE
// GROVE" on the deed, "SAMPLE GROVE PH IIA PB81/1" on the map. The whole rest of the name must fit this grammar,
// taken from the 126 plat names of 32 real subdivisions (2026-11-22):
//   [PH|PHASE <ids> [SUBPH|SUBPHASE <ids>]] [PB<book>/<page>]   or   SUBDIVISION [PB<book>/<page>]
//   <ids> = phase ids (PHASE_ID above) joined by ",", "AND", "&" or a space
// A name that does not fit ("SAMPLE GROVE ESTATES", "... WEST PB1/2", "... PH II REPLAT OF LOT 4", "... PH III-A
// TOWNHOMES") may be another subdivision or another piece of land: its parcel is marked platKnown false, and
// chooseParcel matches nothing while one is in the answer.
// The rest is read token by token (no pattern runs over the whole list, so a long name costs linear time).
const BOOK_PAGE = /^[0-9]{1,4}\/[0-9]{1,4}$/;
const isPhaseWord = (token) => token === 'PH' || token === 'PHASE';
const isSubphaseWord = (token) => token === 'SUBPH' || token === 'SUBPHASE';
const platTokens = (text) => text.replace(/,/g, ' , ').split(' ').filter(Boolean);

function platRestKnown(rest) {
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
  if (tokens[i] === 'SUBDIVISION') {
    i += 1;
  } else if (isPhaseWord(tokens[i])) {
    i += 1;
    if (!readIds()) return false;
    if (isSubphaseWord(tokens[i])) {
      i += 1;
      if (!readIds()) return false;
    }
  }
  const book = tokens[i] || '';
  if (book.startsWith('PB') && BOOK_PAGE.test(book.slice(2))) i += 1;
  else if (book === 'PB' && BOOK_PAGE.test(tokens[i + 1] || '')) i += 2;
  return i > 0 && i === tokens.length;
}

// True when the map's plat name is the deed's subdivision: the deed's words, or those words and then a rest that
// fits the grammar. False for every other name of the answer:
//   - other words ("RYE CREEK RANCH" for "RYE RANCH", "SAINT JOHNS" for "ST JOHNS");
//   - the deed's words and then something else ("... ESTATES", "RYE RANCHES");
//   - the deed's letters cover a plat-part word of the map ("PH" under a deed written "RANCHP HII"): the
//     deed-side guard reads the deed's words, and this reads the map's words.
// Such a parcel may be the same land under another spelling. It is never set aside: it stays in the answer, and
// chooseParcel matches nothing while one is there.
function platNameKnown(mapName, deedWords) {
  const split = splitAtDeedWords(String(mapName || ''), deedWords);
  if (split === null) return false;
  if (/^[A-Z0-9]/.test(split.rest)) return false; // the deed's words end inside a word of the map's name
  if (namesPlatPart(split.covered)) return false;
  const tail = split.rest.replace(/ +/g, ' ').trim();
  return tail === '' || platRestKnown(tail);
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
  // asked) a form of the block. The values are read as the map sent them, not trimmed: the query compares them that
  // way ("5 " is not "5" to it, and a name with a space in front does not start with the deed's first letter; no
  // parcel has such a name, counted 2026-11-22).
  const sent = (key) => (typeof attrs[key] === 'string' ? attrs[key] : null);
  const asked = sameNumber(sent('PAR_SUBDIV_LOT'), legal.lot)
    && hasDeedLetters(sent('PAR_SUBDIV_NAME') || '', lettersOf(legal.subdivision))
    && (!hasBlock(legal) || sameNumber(sent('PAR_SUBDIV_BLOCK'), legal.block));
  if (!asked) throw new Error('parcel map sent a parcel that is not the lot asked for');
  parcel.platKnown = platNameKnown(parcel.subdivision, legal.subdivision);
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
  // No parcel of the answer is set aside. One whose name is not the deed's plat (platKnown false) stops the match.
  return parcels;
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
