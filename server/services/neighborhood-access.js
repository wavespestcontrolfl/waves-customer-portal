/**
 * Neighborhood access directory (gate-code directory PR 1).
 *
 * A neighborhood is named from the county parcel roll's recorded subdivision,
 * collapsed to the community's base name so every phase of one development
 * shares a row ("OAKWOOD GLEN PH IV SUBPH 4A & 4B PB66/57" → "Oakwood Glen"). A
 * neighborhood's gate codes are shared by every stop in it (owner ruling
 * 2026-10-01); a customer's own property codes never come here.
 *
 * Two callers: the one-time backfill (ops/agents/neighborhood-access-backfill.js)
 * and, behind GATE_NEIGHBORHOOD_ACCESS, the 15-minute filing sweep below,
 * which picks up a gate code saved by ANY writer (office, customer portal,
 * call, customer text, Intelligence Bar) without a hook in each one.
 */

const db = require('../models/db');
const { lookupCountyParcelByPoint, subdivisionBaseName } = require('./property-lookup/county-parcel-gis');
const { SERVICE_AREA_COUNTY_ZIPS } = require('../config/county-zips');

// The county module's subdivisionBaseName gives the estimator's base PLAT
// (cut at PH/PHASE/UNIT/SEC/SECTION/PB) — deliberately narrow, because its
// sqft-median query matches that base by name and a broader base would widen
// the comparable homes behind pricing. A neighborhood is the whole COMMUNITY,
// so the directory starts from that same base and collapses further: the
// sub-phase, replat, addition and tract pieces the plat base keeps, and
// plat/condo-book references with no keyword in front ("… CB34/1").
const COMMUNITY_SUFFIX = /\s+(?:PHS|PHASES|SUBPH|UNITS|UN|SP|REPLAT|A REPLAT|ADD|ADDITION|TRACT|BLK|BLOCK|LOT|LOTS|CB|OR)\b.*$/;
const BOOK_REF = /\s+(?:PB|CB|OR)?\s*\d+\s*\/\s*\d+\s*$/;
const NOT_A_NAME = /^(?:NOT IN (?:A )?SUBDIVISION|NONE|N\/A|UNKNOWN|ACREAGE|UNPLATTED)\b/;
const SMALL_WORDS = new Set(['at', 'of', 'the', 'and', 'on', 'in', 'by']);

function titleCase(name) {
  return name.toLowerCase().split(' ').map((w, i) => {
    if (i > 0 && SMALL_WORDS.has(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(' ');
}

// Raw county subdivision → community display name, or null when the roll
// gives nothing usable (Sarasota's numeric code, "NOT IN SUBDIVISION").
function neighborhoodNameFromSubdivision(raw) {
  let s = String(raw || '').toUpperCase().replace(/\s+/g, ' ').trim();
  if (!s || /^\d+$/.test(s) || NOT_A_NAME.test(s)) return null;
  s = subdivisionBaseName(s.replace(BOOK_REF, '')).replace(COMMUNITY_SUFFIX, '');
  s = s.replace(/\s+A SUBDIVISION$/, '').replace(/[\s,&-]+$/, '').trim();
  if (!s || /^\d+$/.test(s)) return null;
  return titleCase(s);
}

function matchKey(county, name) {
  return `${String(county || '').toLowerCase()}|${String(name).toLowerCase()}`;
}

// The one county whose service-area ZIP set holds this ZIP, else none (a ZIP
// that straddles a county line keeps the Manatee → Sarasota → Charlotte
// fallback). A hint keeps an earlier county's slow layer from spending the
// shared deadline before the right one is asked.
function countyHint(zip) {
  const z = String(zip || '').slice(0, 5);
  const hits = Object.entries(SERVICE_AREA_COUNTY_ZIPS).filter(([, zips]) => zips.includes(z)).map(([county]) => county);
  return hits.length === 1 ? hits[0] : undefined;
}

// A keypad code is digits with an optional leading/trailing # or *. Anything
// else ("Text client for access", "visitor pass set up") is an instruction.
function isKeypadCode(value) {
  return /^[#*]?\s*\d{3,8}\s*[#*]?$/.test(String(value || '').trim());
}

// Find-or-create the neighborhood for a roll name; records the raw name as
// an alias so a later phase maps without another lookup. Returns the alias
// list and updated_at as they were before this call (null for a new row) so
// a backfill can undo the alias append exactly.
async function upsertNeighborhood(conn, { county, subdivision }) {
  const name = neighborhoodNameFromSubdivision(subdivision);
  if (!name) return null;
  const key = matchKey(county, name);
  const raw = String(subdivision).trim();
  // Serialize upserts of one name (a row lock cannot cover a row that does
  // not exist yet), so the prior values read here are the ones the upsert
  // below replaces — two runs creating the same neighborhood would otherwise
  // both read "no row" and the loser's alias append would go unjournaled.
  await conn.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`neighborhood:${key}`]);
  // updated_at as text keeps Postgres's microseconds (a JS Date drops them),
  // so a rollback restores the exact value.
  const prior = await conn('neighborhoods').where({ match_key: key })
    .first('subdivision_names', conn.raw('updated_at::text AS updated_at'));
  const [row] = await conn.raw(
    `INSERT INTO neighborhoods (name, county, match_key, subdivision_names, source)
     VALUES (?, ?, ?, jsonb_build_array(?::text), 'county')
     ON CONFLICT (match_key) DO UPDATE SET
       subdivision_names = CASE
         WHEN neighborhoods.subdivision_names @> jsonb_build_array(?::text) THEN neighborhoods.subdivision_names
         ELSE neighborhoods.subdivision_names || jsonb_build_array(?::text) END,
       updated_at = now()
     RETURNING id, name, (xmax = 0) AS inserted, updated_at::text AS written_at`,
    [name, county || null, key, raw, raw, raw],
  ).then((r) => r.rows);
  const existing = row.inserted || !prior ? null : prior;
  // addedAlias: the one name this call appended (null when it was already
  // there), so an undo can remove exactly it and leave later appends alone.
  const addedAlias = existing && !(existing.subdivision_names || []).includes(raw) ? raw : null;
  return { ...row, prior: existing, addedAlias };
}


// Canonical street line: house number, unit tail and any city/state/ZIP tail
// removed; long forms abbreviated (DRIVE → DR, EAST → E) but suffixes and
// directionals KEPT — "Oak Dr" vs "Oak Ct" and "Main St E" vs "Main St W"
// are different streets. Spelling differences beyond these leave a property
// unlinked (office picks), never linked to the wrong street.
const ABBREVIATIONS = {
  NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W',
  NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW',
  STREET: 'ST', AVENUE: 'AVE', ROAD: 'RD', DRIVE: 'DR', LANE: 'LN', COURT: 'CT',
  PLACE: 'PL', CIRCLE: 'CIR', BOULEVARD: 'BLVD', TERRACE: 'TER', TRAIL: 'TRL',
  PARKWAY: 'PKWY', COVE: 'CV', POINTE: 'PT', POINT: 'PT', GLEN: 'GLN', PLAZA: 'PLZ',
  CROSSING: 'XING', BEND: 'BND', TRACE: 'TRCE', HIGHWAY: 'HWY', LP: 'LOOP',
  // Further USPS Publication 28 suffix pairs common in the service area.
  ALLEY: 'ALY', ANNEX: 'ANX', BAYOU: 'BYU', BLUFF: 'BLF', BRANCH: 'BR', BRIDGE: 'BRG',
  BROOK: 'BRK', CANYON: 'CYN', CAUSEWAY: 'CSWY', CENTER: 'CTR', CLIFF: 'CLF', CLUB: 'CLB',
  COMMON: 'CMN', COMMONS: 'CMNS', CORNER: 'COR', COURSE: 'CRSE', COURTS: 'CTS', CREEK: 'CRK',
  CRESCENT: 'CRES', CREST: 'CRST', ESTATE: 'EST', ESTATES: 'ESTS', EXPRESSWAY: 'EXPY',
  EXTENSION: 'EXT', FALLS: 'FLS', FIELD: 'FLD', FIELDS: 'FLDS', FOREST: 'FRST', FORK: 'FRK',
  FREEWAY: 'FWY', GARDEN: 'GDN', GARDENS: 'GDNS', GATEWAY: 'GTWY', GLENS: 'GLNS', GREEN: 'GRN',
  GROVE: 'GRV', HARBOR: 'HBR', HAVEN: 'HVN', HEIGHTS: 'HTS', HILL: 'HL', HILLS: 'HLS',
  HOLLOW: 'HOLW', ISLAND: 'IS', ISLANDS: 'ISS', JUNCTION: 'JCT', KEY: 'KY', KNOLL: 'KNL',
  LAKE: 'LK', LAKES: 'LKS', LANDING: 'LNDG', MANOR: 'MNR', MEADOW: 'MDW', MEADOWS: 'MDWS',
  MILL: 'ML', MOUNT: 'MT', ORCHARD: 'ORCH', OVERPASS: 'OPAS', PASSAGE: 'PSGE', PINE: 'PNE',
  PINES: 'PNES', PLAINS: 'PLNS', PORT: 'PRT', PRAIRIE: 'PR', RANCH: 'RNCH', RIDGE: 'RDG',
  RIVER: 'RIV', ROUTE: 'RTE', SHOAL: 'SHL', SHORE: 'SHR', SHORES: 'SHRS', SPRING: 'SPG',
  SPRINGS: 'SPGS', SQUARE: 'SQ', STATION: 'STA', STREAM: 'STRM', SUMMIT: 'SMT', TRAILS: 'TRLS',
  TURNPIKE: 'TPKE', VALLEY: 'VLY', VIEW: 'VW', VILLAGE: 'VLG', VILLE: 'VL', VISTA: 'VIS',
  WALKS: 'WALK', WELLS: 'WLS', TERR: 'TER', CRT: 'CT', CRCL: 'CIR', CIRC: 'CIR',
};
function streetLine(line, cities = []) {
  let s = ` ${String(line || '').toUpperCase().replace(/[^A-Z0-9,\s]/g, ' ').replace(/\s+/g, ' ').trim()} `;
  s = s.replace(/,.*$/, ' '); // ", FL 34285" / ", SARASOTA FL"
  s = s.replace(/\s(?:APT|APARTMENT|UNIT|STE|SUITE|BLDG|LOT)\s.*$/, ' ');
  s = s.replace(/\s\d{5}(?:\s\d{4})?\s*$/, ' ').replace(/\s(?:FL|FLORIDA)\s*$/, ' ');
  for (const city of cities) {
    const c = String(city || '').toUpperCase().replace(/[^A-Z\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (c && s.trimEnd().endsWith(` ${c}`)) s = `${s.trimEnd().slice(0, -c.length)} `;
  }
  const tokens = s.trim().split(/\s+/).filter(Boolean).map((t) => ABBREVIATIONS[t] || t);
  if (tokens.length && /^\d+$/.test(tokens[0])) tokens.shift();
  return tokens.length ? tokens.join(' ') : null;
}

const DIRECTIONAL = /\s(?:N|S|E|W|NE|NW|SE|SW)$/;
// Same street, allowing a trailing directional that one side simply omits
// ("142ND TER" vs "142ND TER E"); two different directionals never match.
function sameStreet(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const bare = (x) => x.replace(DIRECTIONAL, '');
  return (DIRECTIONAL.test(a) !== DIRECTIONAL.test(b)) && bare(a) === bare(b);
}

const leadingNumber = (s) => (String(s || '').match(/^\s*(\d+)/) || [])[1] || null;

// A stored pin can be a ZIP centroid or a wrong-city geocode that still falls
// inside the service area (ops/agents/reset-out-of-area-coords.js leaves
// those), so the parcel under it proves nothing by itself. Link only when one
// of the parcel's situs lines (any unit's, for a stacked condo parcel) is the
// property's own house number and full street, and both ZIPs are known and
// equal.
function parcelMatchesProperty(parcel, property) {
  const number = leadingNumber(property.address_line1);
  const street = streetLine(property.address_line1);
  if (!number || !street) return false;
  const cities = [parcel.situsCity, property.city];
  const lines = [parcel.situsAddress, ...(parcel.situsLines || [])].filter(Boolean);
  const sameAddress = lines.some((l) => leadingNumber(l) === number && sameStreet(streetLine(l, cities), street));
  if (!sameAddress) return false;
  // Fail closed: both ZIPs must be known and equal — a matching street with
  // no locality check could be the same street in another town.
  const zip = String(property.zip || '').slice(0, 5);
  const situsZip = String(parcel.situsZip || '').slice(0, 5);
  return /^\d{5}$/.test(zip) && zip === situsZip;
}

// Link one property to its neighborhood from the county roll. An office pick
// (neighborhood_source='office') is never overwritten, and nothing is written
// unless the parcel under the pin is this property's own parcel. With
// onlyUnchecked (the backfill), the property is claimed under a row lock and
// written only if it is still unlinked and unchecked, so two runs can never
// both write — and journal — the same row. Returns { status, neighborhood?,
// subdivision?, wrote } for the caller's report.
async function resolvePropertyNeighborhood(property, { conn = db, lookup = lookupCountyParcelByPoint, onlyUnchecked = false } = {}) {
  if (property.neighborhood_source === 'office') return { status: 'office_pick', wrote: false };
  const lat = Number(property.latitude);
  const lng = Number(property.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { status: 'no_coords', wrote: false };

  const parcel = await lookup(lat, lng);
  if (!parcel) return { status: 'no_parcel', wrote: false };
  if (!parcelMatchesProperty(parcel, property)) return { status: 'situs_mismatch', wrote: false };
  const unchecked = (q) => (onlyUnchecked ? q.whereNull('neighborhood_id').whereNull('neighborhood_checked_at') : q);
  const notOffice = (q) => q.where((w) => w.whereNull('neighborhood_source').orWhereNot('neighborhood_source', 'office'));
  if (onlyUnchecked) {
    const claimed = await unchecked(notOffice(conn('customer_properties').where({ id: property.id })))
      .forUpdate().first('address_line1', 'city', 'zip', 'latitude', 'longitude');
    if (!claimed) return { status: 'already_checked', wrote: false };
    // The lookup ran on an earlier snapshot; an address move since then
    // (syncPrimaryAddress clears coords and the link) makes it stale.
    const same = ['address_line1', 'city', 'zip'].every((f) => String(claimed[f] || '') === String(property[f] || ''))
      && Number(claimed.latitude) === lat && Number(claimed.longitude) === lng;
    if (!same) return { status: 'stale_lookup', wrote: false };
  }
  const subdivision = parcel.subdivision || null;
  const neighborhood = subdivision ? await upsertNeighborhood(conn, { county: parcel.county, subdivision }) : null;

  const wrote = await unchecked(notOffice(conn('customer_properties').where({ id: property.id })))
    .update({
      neighborhood_id: neighborhood ? neighborhood.id : null,
      neighborhood_source: neighborhood ? 'county' : null,
      county_subdivision: subdivision,
      neighborhood_checked_at: conn.fn.now(),
    });
  // The stamp this write left (the rollback applies only while it is still there).
  const { t: checkedAt } = await conn('customer_properties').where({ id: property.id })
    .first(conn.raw('neighborhood_checked_at::text AS t'));
  if (!neighborhood) return { status: 'no_name', subdivision, wrote: wrote > 0, checkedAt };
  return { status: 'linked', neighborhood, subdivision, wrote: wrote > 0, checkedAt };
}

// Mark live rows needs_confirm; returns [{ id, updated_at }] as they were
// before (updated_at as Postgres text, microseconds intact), for each row
// this call moved off active.
async function flagForConfirm(conn, ids) {
  if (!ids.length) return [];
  const before = await conn('neighborhood_access')
    .whereIn('id', ids)
    .where('status', 'active')
    .select('id', conn.raw('updated_at::text AS updated_at'));
  if (!before.length) return [];
  await conn('neighborhood_access')
    .whereIn('id', before.map((r) => r.id))
    .update({ status: 'needs_confirm', updated_at: conn.fn.now() });
  const after = await writtenAt(conn, 'neighborhood_access', before.map((r) => r.id));
  return before.map((r) => ({ ...r, written_at: after.get(r.id) }));
}

// updated_at as Postgres text (microseconds intact) for each id, read after
// a write — a rollback statement applies only while the row still carries it.
async function writtenAt(conn, table, ids) {
  const rows = await conn(table).whereIn('id', ids).select('id', conn.raw('updated_at::text AS t'));
  return new Map(rows.map((r) => [r.id, r.t]));
}

// File one customer-given neighborhood gate value under the neighborhood.
// Writers are serialized per neighborhood (row lock), so two concurrent
// filings of different codes cannot both stay active.
// - The same code from a second neighbor files once — but an unconfirmed
//   second copy still flags the existing row, so the outcome never depends
//   on which customer is filed first.
// - A second DIFFERENT live code marks every live coded row needs_confirm:
//   one is stale or the community has two gates — the office decides.
// - Free text always files needs_confirm: the source field takes anything,
//   and an instruction meant for one house ("text me at the gate") must not
//   reach every stop in the neighborhood until the office confirms it.
// Returns { status, id?, flagged } where flagged lists [{ id, updated_at }]
// for rows this call moved active → needs_confirm.
async function fileNeighborhoodCode(conn, { neighborhoodId, value, source, sourceCustomerId, unconfirmed = false }) {
  const text = String(value || '').trim();
  if (!text) return { status: 'empty', flagged: [] };
  await conn('neighborhoods').where({ id: neighborhoodId }).forUpdate().first('id');
  const keypad = isKeypadCode(text);
  const code = keypad ? text.replace(/\s+/g, '') : null;
  const status = unconfirmed || !keypad ? 'needs_confirm' : 'active';

  const existing = await conn('neighborhood_access')
    .where({ neighborhood_id: neighborhoodId })
    .whereNot('status', 'retired')
    .where((q) => (keypad ? q.whereRaw('lower(code) = lower(?)', [code]) : q.where({ instructions: text })))
    .first('id');
  if (existing) {
    const flagged = status === 'needs_confirm' ? await flagForConfirm(conn, [existing.id]) : [];
    return { status: 'duplicate', id: existing.id, flagged };
  }

  const [ins] = await conn('neighborhood_access').insert({
    neighborhood_id: neighborhoodId,
    access_type: keypad ? 'keypad' : 'instructions',
    code,
    instructions: keypad ? null : text,
    status,
    source,
    source_customer_id: sourceCustomerId || null,
  }).returning('id');
  const id = ins.id ?? ins;
  const written = (await writtenAt(conn, 'neighborhood_access', [id])).get(id);
  if (!keypad) return { status: 'filed', id, written_at: written, flagged: [] };

  const others = await conn('neighborhood_access')
    .where({ neighborhood_id: neighborhoodId })
    .whereNotNull('code')
    .whereNot('status', 'retired')
    .whereNot('id', id)
    .pluck('id');
  if (others.length) {
    const flagged = await flagForConfirm(conn, others);
    const self = status === 'active' ? await flagForConfirm(conn, [id]) : [];
    return { status: 'filed_conflict', id, written_at: self.length ? self[0].written_at : written, flagged };
  }
  return { status: 'filed', id, written_at: written, flagged: [] };
}

// Same physical street, whatever the spelling: suffix and directional long
// forms abbreviated, a trailing directional one side omits tolerated, two
// different directionals never equal. Shared with customer-properties.js's
// address-move check so both decide "same street" one way.
function sameStreetLine(a, b) {
  return sameStreet(streetLine(a), streetLine(b));
}

// ---- runtime filing sweep (gate-code directory PR 2) --------------------------
// Every 15 minutes, behind GATE_NEIGHBORHOOD_ACCESS: each customer whose
// current neighborhood gate code has not been filed yet — no
// neighborhood_access_filings row, or one for a different value (compared by
// sha256, the code itself is never stored there) — has it filed under their
// property's neighborhood (the property is linked from the county roll first
// if it never was). One sweep covers every writer — office, portal, call,
// text, Intelligence Bar — and any added later, with no hook in each; it needs
// no time watermark, so a save that commits mid-pass is simply seen next pass,
// and an unrelated preference edit never re-files a code the office retired.
// A new code that differs from the one on file flags both and rings ONE
// Customers bell per neighborhood.
const SOURCE = 'profile';
const UNCONFIRMED_MARK = 'is unconfirmed: confirm on site';
const FINAL_OUTCOMES = new Set(['filed', 'duplicate', 'filed_conflict']);
// The one hash expression, used by the candidate query and the ledger write
// alike, so the two can never disagree on what "this value" is. It hashes the
// value as fileNeighborhoodCode files it: trimmed, and for a keypad code (the
// isKeypadCode pattern) with its inner whitespace removed — "# 1234" and
// "#1234" are one code, "12 34" is an instruction. No "?" in the pattern:
// knex reads one in raw SQL as a binding.
const TRIMMED_VALUE_SQL = "regexp_replace(pp.neighborhood_gate_code, '^\\s+|\\s+$', '', 'g')";
const CANONICAL_VALUE_SQL = `CASE WHEN ${TRIMMED_VALUE_SQL} ~ '^[#*]{0,1}\\s*\\d{3,8}\\s*[#*]{0,1}$'
  THEN regexp_replace(${TRIMMED_VALUE_SQL}, '\\s+', '', 'g') ELSE ${TRIMMED_VALUE_SQL} END`;
const VALUE_HASH_SQL = `encode(sha256(convert_to(${CANONICAL_VALUE_SQL}, 'UTF8')), 'hex')`;

// The customers whose current code (non-empty, customer not deleted) is not
// filed where their property now is: no filing for that exact value, or a
// filing in a different neighborhood than the one property's current link (an
// address move cleared it, or the office re-linked it). A filing that could not
// finish (lookup failed, no pin, two properties) left no row, so it is retried
// every pass.
async function unfiledGateCodeCustomers(conn) {
  return conn('property_preferences as pp')
    .join('customers as c', 'c.id', 'pp.customer_id')
    .leftJoin('neighborhood_access_filings as f', 'f.customer_id', 'pp.customer_id')
    .whereNull('c.deleted_at')
    .whereRaw("btrim(coalesce(pp.neighborhood_gate_code, '')) <> ''")
    .where((w) => w.whereNull('f.customer_id')
      // The filed neighborhood was deleted (FK SET NULL, e.g. the backfill
      // rollback): nothing is filed any more.
      .orWhereNull('f.neighborhood_id')
      .orWhereRaw(`f.value_hash <> ${VALUE_HASH_SQL}`)
      .orWhereRaw(`f.neighborhood_id IS DISTINCT FROM (
        SELECT CASE WHEN count(*) = 1 THEN (array_agg(p.neighborhood_id))[1] END
        FROM customer_properties p WHERE p.customer_id = pp.customer_id AND p.active)`))
    .orderBy('pp.customer_id')
    .pluck('pp.customer_id');
}

// File one customer's current code. Lock order matches every preference
// writer (customer preference advisory lock → customer → properties →
// preferences), then the neighborhood row inside fileNeighborhoodCode.
async function fileOneSavedCode(customerId, lookup) {
  // County lookup (network) runs outside any transaction, only for a single
  // active property that was never checked.
  const props = await db('customer_properties').where({ customer_id: customerId, active: true })
    .select('id', 'customer_id', 'address_line1', 'city', 'zip', 'latitude', 'longitude',
      'neighborhood_id', 'neighborhood_source', 'neighborhood_checked_at');
  if (props.length !== 1) return { status: props.length ? 'multi_property' : 'no_property' };
  const snapshot = props[0];
  // A NULL, blank or zero coordinate is no pin (Number(null) is 0, and a stored
  // 0 is the placeholder customer-geocode-review.js also treats as no pin).
  const hasPin = [snapshot.latitude, snapshot.longitude].every((v) => v !== null && v !== undefined && String(v).trim() !== ''
    && Number.isFinite(Number(v)) && Number(v) !== 0);
  const parcel = !snapshot.neighborhood_id && !snapshot.neighborhood_checked_at && snapshot.neighborhood_source !== 'office' && hasPin
    ? await lookup(Number(snapshot.latitude), Number(snapshot.longitude), { county: countyHint(snapshot.zip) })
    : null;

  return db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['property-preferences', String(customerId)]);
    const customer = await trx('customers').where({ id: customerId }).whereNull('deleted_at').forUpdate()
      .first('id', 'first_name');
    if (!customer) return { status: 'customer_gone' };
    const active = await trx('customer_properties').where({ customer_id: customerId, active: true }).forUpdate()
      .select('id', 'neighborhood_id');
    if (active.length !== 1 || active[0].id !== snapshot.id) return { status: 'property_changed' };
    const prefs = await trx('property_preferences').where({ customer_id: customerId }).forUpdate()
      .first('neighborhood_gate_code', 'access_notes');
    const value = String(prefs?.neighborhood_gate_code || '').trim();
    if (!value) return { status: 'no_code' };
    // A code the 10-01 message harvest marked unconfirmed files needs_confirm
    // (and flags an existing copy) — only while the note names THIS code
    // ("Gate code 2424 is unconfirmed: confirm on site."); a replacement code
    // saved later, with the old note left behind, is not the one it doubted.
    const markedUnconfirmed = String(prefs?.access_notes || '').includes(`Gate code ${value} ${UNCONFIRMED_MARK}`);
    let neighborhoodId = active[0].neighborhood_id;
    if (!neighborhoodId && parcel) {
      const linked = await resolvePropertyNeighborhood(snapshot, { conn: trx, lookup: async () => parcel, onlyUnchecked: true });
      neighborhoodId = linked.neighborhood ? linked.neighborhood.id : null;
    }
    if (!neighborhoodId) return { status: 'no_neighborhood' };
    // The same value already filed in a DIFFERENT neighborhood than the one just
    // resolved: the property moved (or the office re-linked it), so the code is
    // old evidence — it may be the former address's gate. File it for the
    // office to confirm, never active. Back in the same neighborhood, nothing
    // is carried and an active code stays active.
    const [carried] = (await trx.raw(`SELECT (f.value_hash = ${VALUE_HASH_SQL}) AS same_value, f.neighborhood_id
      FROM neighborhood_access_filings f JOIN property_preferences pp ON pp.customer_id = f.customer_id
      WHERE f.customer_id = ?`, [customerId])).rows;
    // Same value, same neighborhood: already filed (the link was only cleared
    // and re-resolved). Filing again would re-insert a code the office has
    // since retired, because fileNeighborhoodCode skips retired rows.
    if (carried?.same_value && carried.neighborhood_id === neighborhoodId) return { status: 'already_filed', neighborhoodId };
    const carriedFromElsewhere = Boolean(carried?.same_value && carried.neighborhood_id && carried.neighborhood_id !== neighborhoodId);
    const unconfirmed = markedUnconfirmed || carriedFromElsewhere;
    const filed = await fileNeighborhoodCode(trx, { neighborhoodId, value, source: SOURCE, sourceCustomerId: customerId, unconfirmed });
    if (FINAL_OUTCOMES.has(filed.status)) {
      // Ledger the value filed, in the same transaction as the filing.
      // The hash is taken from the locked preferences row itself.
      await trx.raw(`INSERT INTO neighborhood_access_filings (customer_id, value_hash, neighborhood_id, outcome)
        SELECT pp.customer_id, ${VALUE_HASH_SQL}, ?, ? FROM property_preferences pp WHERE pp.customer_id = ?
        ON CONFLICT (customer_id) DO UPDATE SET value_hash = EXCLUDED.value_hash,
          neighborhood_id = EXCLUDED.neighborhood_id, outcome = EXCLUDED.outcome, filed_at = now()`,
      [neighborhoodId, filed.status, customerId]);
    }
    return { ...filed, neighborhoodId, firstName: customer.first_name || null };
  });
}

const CONFLICT_KEY_PREFIX = 'neighborhood-gate-conflict:';

// Two or more live codes in a neighborhood, at least one awaiting the office.
async function neighborhoodHasCodeConflict(conn, neighborhoodId) {
  const rows = await conn('neighborhood_access').where({ neighborhood_id: neighborhoodId })
    .whereNotNull('code').whereNot('status', 'retired').select('status');
  return rows.length > 1 && rows.some((r) => r.status === 'needs_confirm');
}

// ONE Customers bell per neighborhood with conflicting live codes (rings
// again only after a fix and a comeback); the name is the community's, never
// a code. Opens the customer whose update made the conflict.
async function raiseConflictBell(neighborhoodId, customerId, firstName) {
  const n = await db('neighborhoods').where({ id: neighborhoodId }).first('name');
  const live = await db('neighborhood_access').where({ neighborhood_id: neighborhoodId })
    .whereNotNull('code').whereNot('status', 'retired').count('* as n').first();
  // At most 40 characters, cut at a word boundary.
  const fullName = String(n?.name || 'A neighborhood');
  const name = fullName.length <= 40 ? fullName : fullName.slice(0, 41).replace(/\s+\S*$/, '');
  const who = firstName ? `${String(firstName).slice(0, 20)}'s update` : 'the latest update';
  const { composeAdminAlert } = require('./admin-alert-compose');
  const { raiseAdminAlertWithReopen } = require('./admin-alert-episodes');
  const count = Number(live?.n) || 2;
  const base = `${name} now has ${count} different gate codes on file`;
  // The composer's why limit is 110; a long name drops the "after …" clause.
  // A name the composer rejects (initials read as a second sentence, a
  // bracket, an exclamation point) never costs the bell: drop the customer's
  // name, then the community's.
  const whys = [`${base} after ${who}.`, `${base}.`, `A neighborhood now has ${count} different gate codes on file.`];
  let composed;
  for (const why of whys) {
    try {
      composed = composeAdminAlert({
        area: 'Customers',
        action: 'confirm a neighborhood gate code',
        why,
        severity: 'needs-you',
        link: `/admin/customers?customerId=${customerId}`,
        subject: { type: 'customer', id: String(customerId) },
        doneWhen: 'gate_code_confirmed',
        who: 'person',
      });
      break;
    } catch (err) {
      if (err.code !== 'ADMIN_ALERT_RULE' || why === whys[whys.length - 1]) throw err;
    }
  }
  return raiseAdminAlertWithReopen('customer', composed.headline, composed.why, {
    dedupeKey: `${CONFLICT_KEY_PREFIX}${neighborhoodId}`,
    dedupeVersion: 'v1',
    refreshOnDedupe: true,
    // A standing conflict's refresh (a third code, a newer customer) never
    // re-rings a bell a person read; a real comeback after the conflict was
    // resolved still rings (raiseAdminAlertWithReopen overrides this).
    ringOnRefresh: () => false,
    bellDefault: true,
    link: composed.link,
    // customerId top-level: the central internal-test-customer suppression reads it.
    metadata: { ...composed.metadata, customerId: String(customerId), neighborhoodId },
  });
}

// Every neighborhood that has a code conflict right now.
async function conflictedNeighborhoods(conn) {
  return conn('neighborhood_access as a')
    .whereNotNull('a.code').whereNot('a.status', 'retired')
    .groupBy('a.neighborhood_id')
    .havingRaw('count(*) > 1')
    .havingRaw("bool_or(a.status = 'needs_confirm')")
    .pluck('a.neighborhood_id');
}

// The customer the conflict bell opens: of the customers whose CURRENT code is
// filed in this neighborhood and matches one of its unconfirmed codes, the one
// whose code was filed last (filed_at moves only when the code itself changes:
// the reset trigger clears the row on a change, a re-filing rewrites it — an
// unrelated preference edit never does). Else the newest unconfirmed row's own
// source customer. Internal test accounts are skipped: the bell's central
// suppression would silence a conflict a real customer is part of. Null when
// no customer record backs the conflict (the office tab, PR 3, lists it).
async function conflictCustomer(conn, neighborhoodId) {
  const { isInternalTestCustomerId } = require('./internal-test-customers');
  const filed = (await conn.raw(`SELECT f.customer_id, c.first_name
    FROM neighborhood_access_filings f
    JOIN property_preferences pp ON pp.customer_id = f.customer_id
    JOIN customers c ON c.id = f.customer_id AND c.deleted_at IS NULL
    WHERE f.neighborhood_id = ? AND f.value_hash = ${VALUE_HASH_SQL}
      AND EXISTS (SELECT 1 FROM neighborhood_access a
        WHERE a.neighborhood_id = f.neighborhood_id AND a.status = 'needs_confirm'
          AND a.code IS NOT NULL AND lower(a.code) = lower(${CANONICAL_VALUE_SQL}))
    ORDER BY f.filed_at DESC, f.customer_id`, [neighborhoodId])).rows;
  const sources = await conn('neighborhood_access as a')
    .join('customers as c', 'c.id', 'a.source_customer_id')
    .whereNull('c.deleted_at')
    .where({ 'a.neighborhood_id': neighborhoodId, 'a.status': 'needs_confirm' })
    .whereNotNull('a.code')
    .orderBy('a.updated_at', 'desc')
    .select('a.source_customer_id as customer_id', 'c.first_name');
  const pick = [...filed, ...sources].find((r) => !isInternalTestCustomerId(r.customer_id));
  return pick ? { customerId: pick.customer_id, firstName: pick.first_name || null } : null;
}

// Ring (or refresh) the bell for one conflicted neighborhood; false when no
// customer backs it.
async function ringForConflict(neighborhoodId) {
  const who = await conflictCustomer(db, neighborhoodId);
  if (!who) return false;
  await raiseConflictBell(neighborhoodId, who.customerId, who.firstName);
  return true;
}

// Raise the bell for a standing conflict that has none open (the raise after
// filing failed, or the process stopped between the two). A bell a person
// dismissed is still open by key and is left alone.
async function reconcileConflictBells(alreadyRaised) {
  const { openAdminAlertKeys } = require('./admin-alert-episodes');
  const open = new Set(await openAdminAlertKeys(db, CONFLICT_KEY_PREFIX));
  let raised = 0;
  for (const neighborhoodId of await conflictedNeighborhoods(db)) {
    if (alreadyRaised.has(neighborhoodId) || open.has(`${CONFLICT_KEY_PREFIX}${neighborhoodId}`)) continue;
    if (await ringForConflict(neighborhoodId)) raised += 1;
  }
  return raised;
}

// The emitter clears its own bells: a neighborhood whose codes no longer
// conflict (the office confirmed or retired one) has its bell closed done.
async function closeResolvedConflictBells() {
  const { openAdminAlertKeys, closeAdminAlertKeys } = require('./admin-alert-episodes');
  const keys = await openAdminAlertKeys(db, CONFLICT_KEY_PREFIX);
  const resolved = [];
  for (const key of keys) {
    if (!(await neighborhoodHasCodeConflict(db, key.slice(CONFLICT_KEY_PREFIX.length)))) resolved.push(key);
  }
  return closeAdminAlertKeys(db, resolved, 'gate_code_confirmed', {
    resolution: 'Cleared: the neighborhood has one gate code on file again',
  });
}

// The bell side of a pass: ring for the neighborhoods this pass touched that
// now conflict, raise any standing conflict whose bell never landed, and close
// the resolved ones. Returns how many touched neighborhoods conflict, and how
// many bell steps failed so the pass reports them to job health.
async function settleConflictBells(touched, logger) {
  const raisedNow = new Set();
  let failed = 0;
  let conflicts = 0;
  for (const neighborhoodId of touched) {
    try {
      if (!(await neighborhoodHasCodeConflict(db, neighborhoodId))) continue;
      conflicts += 1;
      if (await ringForConflict(neighborhoodId)) raisedNow.add(neighborhoodId);
    } catch (err) {
      failed += 1;
      logger.warn(`[neighborhood-access] conflict bell failed for neighborhood ${neighborhoodId} (${err.code || err.name || 'error'})`);
    }
  }
  // A conflict filed earlier whose bell never landed is raised now.
  try {
    await reconcileConflictBells(raisedNow);
  } catch (err) {
    failed += 1;
    logger.warn(`[neighborhood-access] conflict bell reconcile failed (${err.code || err.name || 'error'})`);
  }
  try {
    await closeResolvedConflictBells();
  } catch (err) {
    failed += 1;
    logger.warn(`[neighborhood-access] conflict bell close failed (${err.code || err.name || 'error'})`);
  }
  return { failed, conflicts };
}

async function sweepSavedGateCodes({ lookup = lookupCountyParcelByPoint } = {}) {
  const { neighborhoodAccessLive } = require('../config/feature-gates');
  if (!neighborhoodAccessLive()) return { skipped: 'gate_off' };
  const logger = require('./logger');
  // A cleared code clears its filing: restoring the same code later is new
  // evidence (A → blank → A files again, like A → B → A). The
  // neighborhood_access_filing_reset trigger does this at write time for any
  // change, including one undone before this pass; this catches rows from
  // before the trigger existed.
  await db.raw(`DELETE FROM neighborhood_access_filings f WHERE NOT EXISTS (
    SELECT 1 FROM property_preferences pp
    WHERE pp.customer_id = f.customer_id AND btrim(coalesce(pp.neighborhood_gate_code, '')) <> '')`);
  const customerIds = await unfiledGateCodeCustomers(db);
  const tally = {};
  let failed = 0;
  // Neighborhoods where this pass filed a new code or flagged an existing one
  // (a duplicate that demoted an active copy can create a conflict too).
  const touched = new Set();
  for (const customerId of customerIds) {
    try {
      const r = await fileOneSavedCode(customerId, lookup);
      tally[r.status] = (tally[r.status] || 0) + 1;
      if (r.status === 'filed_conflict' || (r.status === 'duplicate' && r.flagged?.length)) touched.add(r.neighborhoodId);
    } catch (err) {
      failed += 1;
      // Never the message: a knex error carries its bindings, which can hold a code.
      logger.warn(`[neighborhood-access] filing failed for customer ${customerId} (${err.code || err.name || 'error'})`);
    }
  }
  const bells = await settleConflictBells(touched, logger);
  return { customers: customerIds.length, tally, failed, bellsFailed: bells.failed, conflicts: bells.conflicts };
}

// ---- admin day-feed fallback (gate-code directory PR 3a) ---------------------
// The neighborhood's gate entries for each visit, keyed by visit id, so the
// office's day feed can show "Gate: …" for a customer with no gate code of
// their own. The visit's own property (scheduled_services.property_id), else
// the customer's ONE active property; none or several = no fallback. Shown:
// confirmed entries (a code or instructions), and unconfirmed KEYPAD codes
// (a conflict shows every code, flagged) — never an unconfirmed instruction,
// which may be meant for one house only. Raw codes: staff surfaces only, never
// an LLM prompt or a customer page.
async function neighborhoodGateEntriesForVisits(conn, visits) {
  const out = new Map();
  if (!visits?.length) return out;
  const withProperty = visits.filter((v) => v.property_id);
  const withoutProperty = visits.filter((v) => !v.property_id && v.customer_id);
  const propertyNeighborhood = new Map();
  if (withProperty.length) {
    const rows = await conn('customer_properties')
      .whereIn('id', [...new Set(withProperty.map((v) => v.property_id))])
      .select('id', 'neighborhood_id');
    for (const r of rows) propertyNeighborhood.set(r.id, r.neighborhood_id);
  }
  const customerNeighborhood = new Map();
  if (withoutProperty.length) {
    const rows = await conn('customer_properties')
      .whereIn('customer_id', [...new Set(withoutProperty.map((v) => v.customer_id))])
      .where({ active: true })
      .select('customer_id', 'neighborhood_id');
    const byCustomer = new Map();
    for (const r of rows) byCustomer.set(r.customer_id, [...(byCustomer.get(r.customer_id) || []), r.neighborhood_id]);
    for (const [customerId, ids] of byCustomer) if (ids.length === 1) customerNeighborhood.set(customerId, ids[0]);
  }
  const visitNeighborhood = new Map();
  for (const v of visits) {
    const n = v.property_id ? propertyNeighborhood.get(v.property_id) : customerNeighborhood.get(v.customer_id);
    if (n) visitNeighborhood.set(v.id, n);
  }
  if (!visitNeighborhood.size) return out;
  const entries = await conn('neighborhood_access')
    .whereIn('neighborhood_id', [...new Set(visitNeighborhood.values())])
    .where((w) => w.where('status', 'active')
      .orWhere((q) => q.where('status', 'needs_confirm').where('access_type', 'keypad').whereNotNull('code')))
    .orderBy([{ column: 'status' }, { column: 'gate_label' }, { column: 'code' }])
    .select('neighborhood_id', 'gate_label', 'access_type', 'code', 'instructions', 'status');
  const byNeighborhood = new Map();
  for (const e of entries) byNeighborhood.set(e.neighborhood_id, [...(byNeighborhood.get(e.neighborhood_id) || []), e]);
  for (const [visitId, n] of visitNeighborhood) {
    const list = byNeighborhood.get(n);
    if (list?.length) out.set(visitId, list);
  }
  return out;
}

module.exports = {
  sweepSavedGateCodes,
  sameStreetLine,
  neighborhoodNameFromSubdivision,
  isKeypadCode,
  matchKey,
  upsertNeighborhood,
  parcelMatchesProperty,
  resolvePropertyNeighborhood,
  fileNeighborhoodCode,
  countyHint,
  VALUE_HASH_SQL,
  neighborhoodGateEntriesForVisits,
};
