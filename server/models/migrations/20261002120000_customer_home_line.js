/**
 * Customer home line (owner ruling 2026-10-02, "local line everywhere").
 *
 * Each customer gets ONE persistent Waves location line (bradenton /
 * parrish / sarasota / venice) that every new outbound text and call uses.
 * The line is derived from the service address (config/locations.js
 * resolveServiceLocation) and stored with the address key it was derived
 * from, so it only moves when the address does — a later city-map or
 * geocode change never moves a customer between threads.
 *
 *   home_line_location_id  a WAVES_LOCATIONS id
 *   home_line_address_key  customer-property-address-keys addressKey() of
 *                          the address the line was derived from (or set for)
 *   home_line_source       'derived' (the sweep) | 'staff' (a manual pick)
 *   home_line_set_at       when it was last written
 *
 * Additive, all nullable, no backfill here: the gated home-line sweep
 * (services/home-line.js) stamps rows. No customer communication.
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('customers', (t) => {
    t.string('home_line_location_id', 30);
    t.text('home_line_address_key');
    t.string('home_line_source', 16);
    t.timestamp('home_line_set_at', { useTz: true });
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('customers', (t) => {
    t.dropColumn('home_line_set_at');
    t.dropColumn('home_line_source');
    t.dropColumn('home_line_address_key');
    t.dropColumn('home_line_location_id');
  });
};
