// Removes the orphaned knex_migrations row for 20260415000018_pest_service_cost_truing.js,
// which was reverted. Without this, `knex migrate:latest` errors with
// "migration directory is corrupt" and the app fails its healthcheck on boot.
exports.up = async function(knex) {
  await knex('knex_migrations')
    .where('name', '20260415000018_pest_service_cost_truing.js')
    .del();
};

exports.down = async function() {
  // no-op — we do not want to reinsert the orphan row
};
