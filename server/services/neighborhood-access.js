/**
 * Neighborhood access directory (gate-code directory PR 1).
 *
 * A neighborhood is named from the county parcel roll's recorded subdivision,
 * collapsed to the community's base name so every phase of one development
 * shares a row ("OAKWOOD GLEN PH IV SUBPH 4A & 4B PB66/57" → "Oakwood Glen"). A
 * neighborhood's gate codes are shared by every stop in it (owner ruling
 * 2026-10-01); a customer's own property codes never come here.
 *
 * Only the backfill script calls this today. Runtime writers (the SMS
 * auto-save, Customer 360, call extraction) arrive in PR 2 behind
 * GATE_NEIGHBORHOOD_ACCESS.
 */

const db = require('../models/db');
const { lookupCountyParcelByPoint, subdivisionBaseName } = require('./property-lookup/county-parcel-gis');

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

module.exports = {
  neighborhoodNameFromSubdivision,
  isKeypadCode,
  matchKey,
  upsertNeighborhood,
  parcelMatchesProperty,
  resolvePropertyNeighborhood,
  fileNeighborhoodCode,
};
