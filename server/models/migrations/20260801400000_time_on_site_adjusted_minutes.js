/**
 * Durable admin time-on-site correction stamp (codex P2 #3152 round 5).
 *
 * The correction's durable marker normally lives in
 * service_records.structured_notes.timeOnSiteAdjusted — but a corrected visit
 * with NO resolvable report record (pre-FK legacy rows with no/ambiguous
 * matches) had nowhere to persist it, so every later no-opts job-cost
 * recalculation re-booked labor from the inflated job-linked time entry the
 * operator had just corrected. Dedicated column per the one-shot-stamp rule
 * (full-blob/jsonb carriers get erased by snapshot writers): written by
 * PATCH /api/admin/dispatch/:serviceId/time-on-site, read by
 * calculateJobCost's durable re-derivation from the scheduled_services row
 * it already holds.
 */
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('scheduled_services');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('scheduled_services', 'time_on_site_adjusted_minutes');
  if (hasColumn) return;
  await knex.schema.alterTable('scheduled_services', (t) => {
    t.integer('time_on_site_adjusted_minutes').nullable();
  });
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('scheduled_services');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('scheduled_services', 'time_on_site_adjusted_minutes');
  if (!hasColumn) return;
  await knex.schema.alterTable('scheduled_services', (t) => {
    t.dropColumn('time_on_site_adjusted_minutes');
  });
};
