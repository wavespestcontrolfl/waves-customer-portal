// Supporting index for get_report_engagement's 14-day re-service rate
// (intelligence-bar/dashboard-tools.js getReserviceWithin14Days): its
// candidate and legacy branches select service_records by a service_date
// window alone, and every existing service_records index leads with
// customer_id or scheduled_service_id (or is partial), so even a one-day
// request scanned the whole completion history twice. Plain index, not
// CONCURRENTLY: migrations run inside a transaction pre-deploy (same as
// no_show_evidence_indexes / call_log_callback_linkage_indexes).
exports.up = async function up(knex) {
  await knex.raw('CREATE INDEX IF NOT EXISTS service_records_service_date_idx ON service_records (service_date)');
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS service_records_service_date_idx');
};
