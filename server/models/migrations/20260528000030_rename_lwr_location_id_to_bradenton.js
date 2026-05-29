/**
 * Rename the internal GBP/office location id 'lakewood-ranch' -> 'bradenton'.
 *
 * Waves has 5 staffed offices but only 4 Google Business Profiles. The GBP
 * branded "Waves Pest Control Lakewood Ranch" on Google is physically the
 * BRADENTON office (13649 Luxe Ave); the Lakewood Ranch office proper
 * (9040 Town Center) has no GBP. The internal location id was historically
 * 'lakewood-ranch' — this renames it to 'bradenton' to match the office it
 * actually is (see server/config/locations.js). DISPLAY names stay
 * "Lakewood Ranch" (the public GBP brand); only the internal key changes.
 *
 * This backfills the short location_id key across every table that stores it,
 * so DB rows stay joined to the renamed config entry. Idempotent (only exact
 * 'lakewood-ranch' matches) and reversible. NOTE: the beehiiv segment tag and
 * the GBP_REFRESH_TOKEN_LWR env var are intentionally left unchanged.
 */

const OLD_ID = 'lakewood-ranch';
const NEW_ID = 'bradenton';

// [table, column] pairs that store the short office/location id.
const TARGETS = [
  ['google_reviews', 'location_id'],
  ['gbp_locations', 'location_id'],
  ['gbp_updates', 'location_id'],
  ['review_requests', 'location_id'],
  ['customers', 'nearest_location_id'],
  ['lead_sources', 'gbp_location_id'],
];

async function remap(knex, from, to) {
  const results = {};
  for (const [table, col] of TARGETS) {
    const hasTable = await knex.schema.hasTable(table).catch(() => false);
    if (!hasTable) continue;
    const hasCol = await knex.schema.hasColumn(table, col).catch(() => false);
    if (!hasCol) continue;
    const n = await knex(table).where(col, from).update({ [col]: to });
    results[`${table}.${col}`] = n;
  }
  return results;
}

exports.up = async function (knex) {
  await remap(knex, OLD_ID, NEW_ID);
};

exports.down = async function (knex) {
  await remap(knex, NEW_ID, OLD_ID);
};
