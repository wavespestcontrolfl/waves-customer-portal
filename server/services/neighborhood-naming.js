/**
 * Neighborhood naming pass (GATE_NEIGHBORHOOD_NAMING; owner 2026-10-24 "ok go").
 *
 * The directory (neighborhood-access.js) only learns a home's community when a
 * gate code is saved, so most live homes were never looked up, and Sarasota
 * homes the county names by plat NUMBER stayed unnamed. This pass runs inside
 * the 15-minute gate-code sweep, before it files, and does two things:
 *
 *  1. County pass. A small batch of live homes with a pin: homes never checked,
 *     and checked homes whose county_subdivision is a bare Sarasota plat number
 *     (their plat name is now read from the plat layer). The lookup and plat
 *     read run outside any transaction; the write is
 *     resolvePropertyNeighborhood's claim, so a concurrent writer wins.
 *  2. Caller pass. A home the county could not name takes the community the
 *     customer SAID on a call about that same address (call extraction
 *     subdivision_or_community), matched to the county's directory entry of that
 *     name or added as a 'customer' neighborhood. The link is source 'caller':
 *     unconfirmed, so any code filed from it files needs_confirm. The county
 *     always wins over it (resolvePropertyNeighborhood overwrites a caller link
 *     the county can name) and an office pick is never touched.
 *
 * A county outage is never read as "no name": a lookup that errors leaves the
 * home exactly as it was and out of the batch for an hour; three failures in a
 * row end the pass. Homes the county answered about without a name wait a day.
 * That memory lives in this process, so a restart re-asks once. Nothing is
 * sent and no bell rings; logs carry counts only, never an address or a name.
 */

const db = require('../models/db');
const logger = require('./logger');
const { lookupCountyParcelByPoint, lookupSarasotaPlatNames, countyParcelGisDisabled } = require('./property-lookup/county-parcel-gis');
const { CUSTOMER_STAGES } = require('./customer-stages');
const {
  countyHint, neighborhoodNameFromSubdivision, resolvePropertyNeighborhood, upsertNeighborhood, withPlatName, sameHouse,
} = require('./neighborhood-access');

const COUNTY_BATCH = 20; // homes the county is asked about per tick
const CALLER_BATCH = 50; // homes linked from a call per tick (no network)
const GIS_FAILURE_COOLDOWN_MS = 60 * 60 * 1000;
const ANSWERED_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MAX_GIS_FAILURES_IN_A_ROW = 3;

// propertyId -> earliest time to ask again; countyAnswered = homes the county
// answered about without naming them (the caller pass may then name them).
const retryAt = new Map();
const countyAnswered = new Set();
function resetNamingState() {
  retryAt.clear();
  countyAnswered.clear();
}

// coalesce: a checked home whose roll gave no subdivision at all is NOT a number.
const NUMERIC_PLAT_SQL = "coalesce(p.county_subdivision, '') ~ '^[0-9]{1,6}$' AND coalesce(p.county_subdivision, '') !~ '^0+$'";
const NO_PIN_SQL = 'p.latitude IS NULL OR p.longitude IS NULL OR p.latitude = 0 OR p.longitude = 0';

// Live homes: an active property of an active customer in a customer stage
// (the one-time backfill's scope), never an office pick.
const liveHomes = () => db('customer_properties as p')
  .join('customers as c', 'c.id', 'p.customer_id')
  .where('p.active', true)
  .whereNull('c.deleted_at')
  .where('c.active', true)
  .whereIn('c.pipeline_stage', CUSTOMER_STAGES)
  .where((w) => w.whereNull('p.neighborhood_source').orWhereNot('p.neighborhood_source', 'office'));

const HOME_COLUMNS = ['p.id', 'p.customer_id', 'p.address_line1', 'p.city', 'p.zip', 'p.latitude', 'p.longitude',
  'p.neighborhood_source', 'p.neighborhood_checked_at', 'p.county_subdivision'];

async function countyPass({ lookup, platLookup, now }) {
  const rows = await liveHomes()
    .whereRaw(`NOT (${NO_PIN_SQL})`)
    .where((w) => w.whereNull('p.neighborhood_id').orWhere('p.neighborhood_source', 'caller'))
    .where((w) => w.whereNull('p.neighborhood_checked_at').orWhereRaw(NUMERIC_PLAT_SQL))
    // Never-checked homes first, then the plat-number re-checks.
    .orderByRaw('(p.neighborhood_checked_at IS NULL) DESC, p.id')
    .limit(COUNTY_BATCH * 10)
    .select(HOME_COLUMNS);
  const tally = {};
  let asked = 0;
  let failuresInARow = 0;
  for (const home of rows) {
    if (asked >= COUNTY_BATCH || failuresInARow >= MAX_GIS_FAILURES_IN_A_ROW) break;
    if ((retryAt.get(home.id) || 0) > now) continue;
    asked += 1;
    let parcel;
    try {
      const diag = { errors: [] };
      parcel = await lookup(Number(home.latitude), Number(home.longitude), { county: countyHint(home.zip), diag });
      // A null parcel with a recorded error is an outage, not a miss.
      if (diag.errors.length) throw new Error('county GIS error');
      if (parcel) parcel = await withPlatName(parcel, platLookup);
    } catch {
      failuresInARow += 1;
      tally.gis_error = (tally.gis_error || 0) + 1;
      retryAt.set(home.id, now + GIS_FAILURE_COOLDOWN_MS);
      continue;
    }
    failuresInARow = 0;
    const recheck = Boolean(home.neighborhood_checked_at);
    const { status } = await db.transaction((trx) => resolvePropertyNeighborhood(home, {
      conn: trx, lookup: async () => parcel, onlyUnchecked: !recheck, recheck,
    }));
    tally[status] = (tally[status] || 0) + 1;
    if (status !== 'linked') retryAt.set(home.id, now + ANSWERED_COOLDOWN_MS);
    if (['no_name', 'no_parcel', 'situs_mismatch'].includes(status)) countyAnswered.add(home.id);
  }
  return tally;
}

// ---- the caller's own words ----------------------------------------------------

const GENERIC_WORDS = /^(?:NONE|NO|NA|N\/A|UNKNOWN|UNSURE|NOT SURE|DONT KNOW|SAME|HOME|HOUSE|NOT IN (?:A )?SUBDIVISION)$/;
const TRAILING_LABEL = /\s+(?:COMMUNITY|SUBDIVISION|NEIGHBORHOOD|HOA|HOMEOWNERS ASSOCIATION|HOME OWNERS ASSOCIATION)$/;
// Towns and counties are places, not communities: a gate code filed under one
// would reach every home in it.
const PLACE_NAMES = new Set(['BRADENTON', 'PARRISH', 'PALMETTO', 'ELLENTON', 'LAKEWOOD RANCH', 'SARASOTA', 'VENICE', 'NORTH PORT',
  'ENGLEWOOD', 'NOKOMIS', 'OSPREY', 'PORT CHARLOTTE', 'PUNTA GORDA', 'MYAKKA CITY', 'LONGBOAT KEY', 'ANNA MARIA',
  'HOLMES BEACH', 'BRADENTON BEACH', 'MANATEE', 'SARASOTA COUNTY', 'MANATEE COUNTY', 'CHARLOTTE COUNTY', 'CHARLOTTE', 'FLORIDA']);

// What the customer said → the community name the directory would hold, or
// null (a street, a town, "not sure", too long to be a name).
function callerCommunityName(words, city) {
  const said = String(words || '').toUpperCase().replace(/['’`.]/g, '').replace(/[^A-Z0-9&/\s-]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const s = said.replace(/^THE\s+/, '').replace(TRAILING_LABEL, '');
  if (s.length < 3 || s.length > 60 || s.split(' ').length > 8 || /^\d/.test(s) || GENERIC_WORDS.test(said)) return null;
  const name = neighborhoodNameFromSubdivision(s);
  if (!name) return null;
  const place = String(city || '').toUpperCase().replace(/\s+/g, ' ').trim();
  return PLACE_NAMES.has(name.toUpperCase()) || name.toUpperCase() === place ? null : name;
}

const zip5 = (z) => (/^(\d{5})/.exec(String(z || '').trim()) || [])[1] || null;

// The one community the customer's calls name for THIS address, or null when
// no call names one or two calls name different ones.
async function communityFromCalls(home) {
  const calls = await db('call_log')
    .where({ customer_id: home.customer_id })
    .whereRaw("btrim(coalesce(ai_extraction_enriched #>> '{property,service_address,subdivision_or_community}', '')) <> ''")
    .orderBy('created_at', 'desc')
    .limit(20)
    .select(
      db.raw("ai_extraction_enriched #>> '{property,service_address,subdivision_or_community}' AS words"),
      db.raw("ai_extraction_enriched #>> '{property,service_address,street_line_1}' AS street"),
      db.raw("ai_extraction_enriched #>> '{property,service_address,postal_code}' AS zip"),
    );
  const names = new Set(calls
    .filter((c) => sameHouse(c.street, home.address_line1) && (!zip5(c.zip) || zip5(c.zip) === zip5(home.zip)))
    .map((c) => callerCommunityName(c.words, home.city)));
  names.delete(null);
  return names.size === 1 ? [...names][0] : null;
}

async function linkFromCaller(home, county, name) {
  return db.transaction(async (trx) => {
    const open = await trx('customer_properties').where({ id: home.id, active: true }).whereNull('neighborhood_id')
      .where((w) => w.whereNull('neighborhood_source').orWhereNot('neighborhood_source', 'office'))
      .forUpdate().first('id');
    if (!open) return 'already_linked';
    const hood = await upsertNeighborhood(trx, { county, subdivision: name, source: 'customer' });
    if (!hood) return 'no_name';
    // A neighborhood the office switched off stays off: no link.
    const live = await trx('neighborhoods').where({ id: hood.id, active: true }).first('id');
    if (!live) return 'switched_off';
    await trx('customer_properties').where({ id: home.id }).update({ neighborhood_id: hood.id, neighborhood_source: 'caller' });
    return 'linked';
  });
}

async function callerPass() {
  const hasWords = db('call_log as cl').select(1).whereRaw('cl.customer_id = p.customer_id')
    .whereRaw("btrim(coalesce(cl.ai_extraction_enriched #>> '{property,service_address,subdivision_or_community}', '')) <> ''");
  const answered = [...countyAnswered];
  // The county could not name it: checked with no plat number to read, no pin
  // to ask about, or answered without a name earlier in this process.
  const rows = await liveHomes()
    .whereNull('p.neighborhood_id')
    .whereExists(hasWords)
    .where((w) => w.whereRaw(`p.neighborhood_checked_at IS NOT NULL AND NOT (${NUMERIC_PLAT_SQL})`)
      .orWhereRaw(NO_PIN_SQL)
      .orWhereIn('p.id', answered))
    .orderBy('p.id')
    .limit(CALLER_BATCH)
    .select(HOME_COLUMNS);
  const tally = {};
  for (const home of rows) {
    const county = countyHint(home.zip);
    let status = 'no_county';
    if (county) {
      const name = await communityFromCalls(home);
      status = name ? await linkFromCaller(home, county, name) : 'no_words';
    }
    tally[status] = (tally[status] || 0) + 1;
  }
  return tally;
}

async function runNamingPass({ lookup = lookupCountyParcelByPoint, platLookup = lookupSarasotaPlatNames, now = Date.now() } = {}) {
  if (countyParcelGisDisabled()) return { skipped: 'gis_off' };
  for (const [id, at] of retryAt) if (at <= now) retryAt.delete(id);
  const county = await countyPass({ lookup, platLookup, now });
  const caller = await callerPass();
  if (Object.keys(county).length || Object.keys(caller).length) {
    logger.info(`[neighborhood-naming] pass: ${JSON.stringify({ county, caller })}`);
  }
  return { county, caller };
}

module.exports = { runNamingPass, callerCommunityName, resetNamingState };
