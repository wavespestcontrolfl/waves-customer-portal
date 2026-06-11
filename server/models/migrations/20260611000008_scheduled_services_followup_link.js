/**
 * Follow-up appointment linkage for typed specialty completions.
 *
 * followup_included — visit is part of an already-paid program (e.g. the
 * 14-day cockroach re-treatment, rodent trap checks): the typed completion
 * billing pre-gate bypasses these (admin-dispatch reads svc.followup_included).
 *
 * followup_source_service_id — the completed visit this follow-up was booked
 * from. Serves as the idempotency key for the schedule-followup endpoint
 * (retried CTA taps return the existing booking instead of double-booking).
 */

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('scheduled_services');
  if (!hasTable) return;
  const hasIncluded = await knex.schema.hasColumn('scheduled_services', 'followup_included');
  if (!hasIncluded) {
    await knex.schema.alterTable('scheduled_services', (t) => {
      t.boolean('followup_included').notNullable().defaultTo(false);
    });
  }
  const hasSource = await knex.schema.hasColumn('scheduled_services', 'followup_source_service_id');
  if (!hasSource) {
    await knex.schema.alterTable('scheduled_services', (t) => {
      t.uuid('followup_source_service_id').nullable()
        .references('id').inTable('scheduled_services').onDelete('SET NULL');
    });
  }
  // Partial UNIQUE index = the DB-enforced idempotency guarantee for the
  // schedule-followup endpoint (concurrent CTA taps can't double-book).
  // Cancelled/skipped follow-ups drop out of the index so a replacement
  // can be booked.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_scheduled_services_followup_source_open
    ON scheduled_services (followup_source_service_id)
    WHERE followup_source_service_id IS NOT NULL
      AND status NOT IN ('cancelled', 'skipped')
  `);
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('scheduled_services');
  if (!hasTable) return;
  if (await knex.schema.hasColumn('scheduled_services', 'followup_source_service_id')) {
    await knex.raw('DROP INDEX IF EXISTS uq_scheduled_services_followup_source_open');
    await knex.schema.alterTable('scheduled_services', (t) => {
      t.dropColumn('followup_source_service_id');
    });
  }
  if (await knex.schema.hasColumn('scheduled_services', 'followup_included')) {
    await knex.schema.alterTable('scheduled_services', (t) => {
      t.dropColumn('followup_included');
    });
  }
};
