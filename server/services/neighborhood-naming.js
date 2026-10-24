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
 * Where each home got to lives on the row (customer_properties.neighborhood_naming,
 * see its migration): a home is picked only once its wait has passed, least
 * recently tried first, in SQL before the batch LIMIT. A run of homes that
 * cannot be named therefore never holds the head of the queue, across restarts
 * too. A county lookup that errors waits an hour and is never read as "no name"
 * (three errors in a row end the pass); a county answer with no name waits a
 * day, and the caller pass retries a home no sooner than a day. Nothing is
 * sent and no bell rings; logs carry counts only, never an address or a name.
 */

const db = require('../models/db');
const logger = require('./logger');
const { lookupCountyParcelByPoint, lookupSarasotaPlatNames, countyParcelGisDisabled } = require('./property-lookup/county-parcel-gis');
const { CUSTOMER_STAGES } = require('./customer-stages');
const {
  countyHint, neighborhoodNameFromSubdivision, resolvePropertyNeighborhood, upsertNeighborhood, withPlatName, sameHouse,
  communityKey, spokenName,
} = require('./neighborhood-access');

const COUNTY_BATCH = 20; // homes the county is asked about per tick
const CALLER_BATCH = 50; // homes linked from a call per tick (no network)
const MAX_GIS_FAILURES_IN_A_ROW = 3;

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

// The naming state counts only while it was written for this address.
const ADDRESS_KEY_SQL = "md5(coalesce(p.address_line1, '') || '|' || coalesce(p.zip, ''))";
const FRESH_SQL = `coalesce(p.neighborhood_naming->>'addr' = ${ADDRESS_KEY_SQL}, false)`;
const stateTime = (key) => `(CASE WHEN ${FRESH_SQL} THEN (p.neighborhood_naming->>'${key}')::timestamptz END)`;
// Not waiting: never tried, or the wait since the last try has passed.
const COUNTY_DUE_SQL = `(${stateTime('county_at')} IS NULL OR ${stateTime('county_at')}
  <= ?::timestamptz - (CASE WHEN p.neighborhood_naming->>'county_answered' = 'true' THEN interval '24 hours' ELSE interval '1 hour' END))`;
const CALLER_DUE_SQL = `(${stateTime('caller_at')} IS NULL OR ${stateTime('caller_at')} <= ?::timestamptz - interval '24 hours')`;
const COUNTY_ANSWERED_SQL = `coalesce(${FRESH_SQL} AND p.neighborhood_naming->>'county_answered' = 'true', false)`;

// Record a try on the row, for the address the try was made at: a home that
// moved meanwhile is not stamped, and state written for an old address is dropped.
function stampNaming(home, patch) {
  return db.raw(
    `UPDATE customer_properties p SET neighborhood_naming =
       (CASE WHEN ${FRESH_SQL} THEN p.neighborhood_naming ELSE '{}'::jsonb END)
       || ?::jsonb || jsonb_build_object('addr', ${ADDRESS_KEY_SQL})
     WHERE p.id = ? AND p.address_line1 IS NOT DISTINCT FROM ? AND p.zip IS NOT DISTINCT FROM ?`,
    [JSON.stringify(patch), home.id, home.address_line1, home.zip],
  );
}

const HOME_COLUMNS = ['p.id', 'p.customer_id', 'p.address_line1', 'p.city', 'p.zip', 'p.latitude', 'p.longitude',
  'p.neighborhood_source', 'p.neighborhood_checked_at', 'p.county_subdivision'];

async function countyPass({ lookup, platLookup, nowIso }) {
  const rows = await liveHomes()
    .whereRaw(`NOT (${NO_PIN_SQL})`)
    .where((w) => w.whereNull('p.neighborhood_id').orWhere('p.neighborhood_source', 'caller'))
    // Never checked, a bare plat number to read, or a caller link the county
    // may yet confirm or correct (asked again once a day).
    .where((w) => w.whereNull('p.neighborhood_checked_at').orWhereRaw(NUMERIC_PLAT_SQL).orWhere('p.neighborhood_source', 'caller'))
    .whereRaw(COUNTY_DUE_SQL, [nowIso])
    // Never-checked homes first, then the re-checks; within each, the one
    // tried longest ago.
    .orderByRaw(`(p.neighborhood_checked_at IS NULL) DESC, ${stateTime('county_at')} ASC NULLS FIRST, p.id`)
    .limit(COUNTY_BATCH)
    .select(HOME_COLUMNS);
  const tally = {};
  let failuresInARow = 0;
  for (const home of rows) {
    if (failuresInARow >= MAX_GIS_FAILURES_IN_A_ROW) break;
    let parcel;
    try {
      const diag = { errors: [] };
      parcel = await lookup(Number(home.latitude), Number(home.longitude), { county: countyHint(home.zip), diag });
      // A null parcel with a recorded error is an outage, not a miss. A parcel
      // found after an earlier county's error (a county-line ZIP) is an answer.
      if (diag.errors.length && !parcel) throw new Error('county GIS error');
      if (parcel) parcel = await withPlatName(parcel, platLookup);
    } catch {
      failuresInARow += 1;
      tally.gis_error = (tally.gis_error || 0) + 1;
      await stampNaming(home, { county_at: nowIso, county_answered: false });
      continue;
    }
    failuresInARow = 0;
    const recheck = Boolean(home.neighborhood_checked_at);
    const { status } = await db.transaction((trx) => resolvePropertyNeighborhood(home, {
      conn: trx, lookup: async () => parcel, onlyUnchecked: !recheck, recheck,
    }));
    tally[status] = (tally[status] || 0) + 1;
    // The county answered without a home to link: it waits a day. A claim lost
    // to a concurrent writer (already_checked, stale_lookup) is simply seen again.
    if (['no_name', 'no_parcel', 'situs_mismatch'].includes(status)) await stampNaming(home, { county_at: nowIso, county_answered: true });
  }
  return tally;
}

// ---- the caller's own words ----------------------------------------------------

const GENERIC_WORDS = /^(?:NONE|NO|NA|N\/A|UNKNOWN|UNSURE|NOT SURE|DONT KNOW|SAME|HOME|HOUSE|NOT IN (?:A )?SUBDIVISION)$/;
// Towns and counties are places, not communities: a gate code filed under one
// would reach every home in it.
const PLACE_NAMES = new Set(['BRADENTON', 'PARRISH', 'PALMETTO', 'ELLENTON', 'LAKEWOOD RANCH', 'SARASOTA', 'VENICE', 'NORTH PORT',
  'ENGLEWOOD', 'NOKOMIS', 'OSPREY', 'PORT CHARLOTTE', 'PUNTA GORDA', 'MYAKKA CITY', 'LONGBOAT KEY', 'ANNA MARIA',
  'HOLMES BEACH', 'BRADENTON BEACH', 'MANATEE', 'SARASOTA COUNTY', 'MANATEE COUNTY', 'CHARLOTTE COUNTY', 'CHARLOTTE', 'FLORIDA']);

// What the customer said → the community name the directory would hold, or
// null (a street, a town, "not sure", too long to be a name).

function callerCommunityName(words, city) {
  const said = spokenName(words);
  const s = communityKey(said);
  if (s.length < 3 || s.length > 60 || s.split(' ').length > 8 || /^\d/.test(s) || GENERIC_WORDS.test(said)) return null;
  const name = neighborhoodNameFromSubdivision(s);
  if (!name) return null;
  const place = String(city || '').toUpperCase().replace(/\s+/g, ' ').trim();
  return PLACE_NAMES.has(name.toUpperCase()) || name.toUpperCase() === place ? null : name;
}

const zip5 = (z) => (/^(\d{5})(?:-?\d{4})?$/.exec(String(z || '').trim()) || [])[1] || null;
const cityKey = (c) => String(c || '').toUpperCase().replace(/[^A-Z\s]/g, ' ').replace(/\s+/g, ' ').trim();

// A call is about THIS home only when its street and number match AND its
// locality does: a valid 5-digit ZIP equal to the home's, or (no usable ZIP on
// the call) the same city. A call with neither, or with a different ZIP or
// city, is the same house number and street in another town.
function sameLocality(call, home) {
  const callZip = zip5(call.zip);
  if (callZip) return callZip === zip5(home.zip);
  return Boolean(cityKey(call.city)) && cityKey(call.city) === cityKey(home.city);
}

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
      db.raw("ai_extraction_enriched #>> '{property,service_address,city}' AS city"),
    );
  const names = new Set(calls
    .filter((c) => sameHouse(c.street, home.address_line1) && sameLocality(c, home))
    .map((c) => callerCommunityName(c.words, home.city)));
  names.delete(null);
  return names.size === 1 ? [...names][0] : null;
}

// The evidence was matched against `home`, read earlier: under the lock the
// row must still be that home (same customer, address line, city and ZIP), or
// an address edit between the reads would attach the OLD address's community
// to the new one.
async function linkFromCaller(home, county, name) {
  return db.transaction(async (trx) => {
    const open = await trx('customer_properties').where({ id: home.id, active: true }).whereNull('neighborhood_id')
      .where((w) => w.whereNull('neighborhood_source').orWhereNot('neighborhood_source', 'office'))
      .forUpdate().first('customer_id', 'address_line1', 'city', 'zip');
    if (!open) return 'already_linked';
    if (['customer_id', 'address_line1', 'city', 'zip'].some((f) => String(open[f] || '') !== String(home[f] || ''))) return 'address_changed';
    // An existing community in the county under any spelling of the name wins
    // (upsertNeighborhood matches by community key); only a name the directory
    // does not hold adds a 'customer' neighborhood.
    const hood = await upsertNeighborhood(trx, { county, subdivision: name, source: 'customer' });
    if (!hood) return 'no_name';
    // A neighborhood the office switched off stays off: no link.
    const live = await trx('neighborhoods').where({ id: hood.id, active: true }).first('id');
    if (!live) return 'switched_off';
    await trx('customer_properties').where({ id: home.id }).update({ neighborhood_id: hood.id, neighborhood_source: 'caller' });
    return 'linked';
  });
}

async function callerPass({ nowIso }) {
  const hasWords = db('call_log as cl').select(1).whereRaw('cl.customer_id = p.customer_id')
    .whereRaw("btrim(coalesce(cl.ai_extraction_enriched #>> '{property,service_address,subdivision_or_community}', '')) <> ''");
  // The county could not name it: checked with no plat number to read, no pin
  // to ask about, or answered without a name (stored on the row).
  const rows = await liveHomes()
    .whereNull('p.neighborhood_id')
    .whereExists(hasWords)
    .where((w) => w.whereRaw(`p.neighborhood_checked_at IS NOT NULL AND NOT (${NUMERIC_PLAT_SQL})`)
      .orWhereRaw(NO_PIN_SQL)
      .orWhereRaw(COUNTY_ANSWERED_SQL))
    .whereRaw(CALLER_DUE_SQL, [nowIso])
    .orderByRaw(`${stateTime('caller_at')} ASC NULLS FIRST, p.id`)
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
    // Anything but a link waits a day, so these homes never hold the batch.
    if (status !== 'linked') await stampNaming(home, { caller_at: nowIso });
  }
  return tally;
}

async function runNamingPass({ lookup = lookupCountyParcelByPoint, platLookup = lookupSarasotaPlatNames, now = Date.now() } = {}) {
  if (countyParcelGisDisabled()) return { skipped: 'gis_off' };
  const nowIso = new Date(now).toISOString();
  const county = await countyPass({ lookup, platLookup, nowIso });
  const caller = await callerPass({ nowIso });
  if (Object.keys(county).length || Object.keys(caller).length) {
    logger.info(`[neighborhood-naming] pass: ${JSON.stringify({ county, caller })}`);
  }
  return { county, caller };
}

module.exports = { runNamingPass, callerCommunityName, linkFromCaller };
