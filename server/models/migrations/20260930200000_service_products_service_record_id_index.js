// Supporting index for the texting AI's LABEL FACTS read (sms-label-facts.js
// readLastVisitLabelFactsOnce: service_products WHERE service_record_id IN
// (the newest visit's records)) and every other per-visit product read
// (service reports, email division, compliance). The initial schema declared
// service_products.service_record_id as a foreign key, but Postgres does not
// index a referencing column, and no later migration added one (checked:
// every service_products index is the primary key), so each read scanned the
// whole product history. Plain index, not CONCURRENTLY: migrations run inside
// a transaction pre-deploy (same as service_records_service_date_idx and
// call_commitments_evidence_closed_idx), and the table is small enough for a
// fast build. IF NOT EXISTS makes a re-run a no-op.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('service_products'))) return;
  if (!(await knex.schema.hasColumn('service_products', 'service_record_id'))) return;
  await knex.raw('CREATE INDEX IF NOT EXISTS service_products_service_record_id_idx ON service_products (service_record_id)');
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS service_products_service_record_id_idx');
};
