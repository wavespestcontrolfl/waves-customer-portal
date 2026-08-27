// Snapshot of the appointment-level discount's catalog cap
// (discounts.max_discount_dollars) on the visit row, beside the
// discount_service_*_filter snapshots. Stored replays (auto-extend, series
// propagation, template spawn) reconstruct the discount from the row alone —
// never from the live catalog — so a capped preset must carry its cap here
// or every sibling recomputes at the uncapped percentage (Codex #3531 r7 P1).
// NULL = no cap, exactly today's behavior.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  if (await knex.schema.hasColumn('scheduled_services', 'discount_max_dollars')) return;
  await knex.schema.alterTable('scheduled_services', (table) => {
    table.decimal('discount_max_dollars', 10, 2).nullable();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  if (!(await knex.schema.hasColumn('scheduled_services', 'discount_max_dollars'))) return;
  await knex.schema.alterTable('scheduled_services', (table) => {
    table.dropColumn('discount_max_dollars');
  });
};
