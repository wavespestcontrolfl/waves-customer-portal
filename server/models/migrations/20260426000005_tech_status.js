/**
 * Live tech status — single row per technician, upserted from the
 * Bouncie webhook + tech mobile app heartbeats. Drives the admin
 * dispatch board's left-pane roster (Section 2.1 of the tech-tracking
 * spec).
 *
 * Why a singleton instead of a log: the dispatch board only reads
 * "where is each tech right now" — never history. Bouncie GPS history
 * already lives in vehicle_locations; per-job timeline lives in
 * job_status_history. Keeping this row narrow and one-per-tech keeps
 * the dispatch board read fast (one indexed scan, no aggregation,
 * no DISTINCT ON).
 *
 * status set comes straight from the spec's tech roster pill values:
 * en_route / on_site / wrapping_up / driving / break / idle. string +
 * CHECK rather than a Postgres ENUM — same lesson the en-route fix
 * paid (ALTER ENUM is painful, ALTER CHECK is one DDL).
 */
exports.up = async function (knex) {
  await knex.schema.createTable('tech_status', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tech_id').notNullable().unique()
      .references('id').inTable('technicians').onDelete('CASCADE');
    t.string('status', 30).notNullable().defaultTo('idle');
    t.decimal('lat', 10, 7);
    t.decimal('lng', 10, 7);
    t.uuid('current_job_id')
      .references('id').inTable('scheduled_services').onDelete('SET NULL');
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.index('updated_at', 'idx_tech_status_updated');
  });

  await knex.raw(`
    ALTER TABLE tech_status
      ADD CONSTRAINT tech_status_status_check
      CHECK (status IN (
        'en_route',
        'on_site',
        'wrapping_up',
        'driving',
        'break',
        'idle'
      ))
  `);
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('tech_status');
};
