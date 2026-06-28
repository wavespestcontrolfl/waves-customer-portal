/**
 * geo_grid_ranks — per-pin Google Maps local-pack rank for the geo-grid tracker
 * (Pillar 3). One row per (scan_date, office, keyword, grid pin). map_pack_rank
 * is null when the office's GBP isn't in the returned pack at that pin.
 */
exports.up = async function (knex) {
  await knex.schema.createTable('geo_grid_ranks', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('scan_run_id').notNullable(); // unique per runScan invocation (ISO ts) — separates same-day reruns
    t.date('scan_date').notNullable();
    t.string('office_id').notNullable(); // WAVES_LOCATIONS id (bradenton/parrish/sarasota/venice)
    t.string('keyword').notNullable();
    t.integer('pin_row').notNullable();
    t.integer('pin_col').notNullable();
    t.decimal('latitude', 9, 6).notNullable();
    t.decimal('longitude', 9, 6).notNullable();
    t.integer('map_pack_rank'); // null = not in the returned pack at this pin
    t.boolean('found_in_pack').notNullable().defaultTo(false);
    t.jsonb('top_competitors'); // [{ title, rank }] — top 3 at this pin
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.unique(['scan_run_id', 'office_id', 'keyword', 'pin_row', 'pin_col']);
    t.index(['office_id', 'keyword', 'scan_run_id']);
    t.index(['office_id', 'keyword', 'scan_date']);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('geo_grid_ranks');
};
