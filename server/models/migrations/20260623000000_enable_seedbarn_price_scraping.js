// Enable price scraping for the SeedBarn vendor row.
//
// The base inventory seed (20260401000019_inventory.js) inserted SeedBarn but —
// unlike the other four Shopify storefronts in that same array (Chemical Warehouse,
// Seed World USA, Intermountain Turf, GCI Turf Academy, all `price_scraping_enabled:
// true`) — omitted the flag, so it defaults to false and the weekly scan's
// scrapableVendors() (server/services/price-scan/weekly-scan.js) silently skips it.
// SeedBarn (seedbarn.com) is covered by the generic Shopify adapter shipped in
// PR #2012 (its host is on the shopify-hosts.js allowlist), so this flips the one
// missing flag to bring it in line with the other four.
//
// Idempotent: matches the existing row by case-insensitive name and updates only the
// flag — re-running is a no-op, and it does nothing if the row isn't present.

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('vendors'))) return;
  await knex('vendors')
    .whereRaw('LOWER(name) = LOWER(?)', ['SeedBarn'])
    .update({ price_scraping_enabled: true, updated_at: new Date() });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('vendors'))) return;
  await knex('vendors')
    .whereRaw('LOWER(name) = LOWER(?)', ['SeedBarn'])
    .update({ price_scraping_enabled: false, updated_at: new Date() });
};
