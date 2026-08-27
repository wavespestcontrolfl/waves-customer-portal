// Snapshot of the appointment-level discount's catalog cap
// (discounts.max_discount_dollars) on the visit row, beside the
// discount_service_*_filter snapshots. Stored replays (auto-extend, series
// propagation, template spawn) reconstruct the discount from the row alone —
// never from the live catalog — so a capped preset must carry its cap here
// or every sibling recomputes at the uncapped percentage (Codex #3531 r7 P1).
// NULL = no cap, exactly today's behavior.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  if (!(await knex.schema.hasColumn('scheduled_services', 'discount_max_dollars'))) {
    await knex.schema.alterTable('scheduled_services', (table) => {
      table.decimal('discount_max_dollars', 10, 2).nullable();
    });
  }
  // Existing visits tied to a catalog preset get a one-time snapshot of the
  // cap in force when this lands — the same posture as the 20260716 scope
  // snapshot. Without it every pre-existing capped series replays uncapped
  // (Codex #3531 r9 P1). Runtime replay never re-reads the catalog.
  if (!(await knex.schema.hasTable('discounts'))) return;
  if (!(await knex.schema.hasColumn('discounts', 'max_discount_dollars'))) return;
  if (!(await knex.schema.hasColumn('scheduled_services', 'discount_id'))) return;
  await knex.raw(`
    UPDATE scheduled_services AS scheduled
    SET discount_max_dollars = discounts.max_discount_dollars
    FROM discounts
    WHERE scheduled.discount_id = discounts.id
      AND scheduled.discount_max_dollars IS NULL
      AND discounts.max_discount_dollars IS NOT NULL
  `);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  if (!(await knex.schema.hasColumn('scheduled_services', 'discount_max_dollars'))) return;
  await knex.schema.alterTable('scheduled_services', (table) => {
    table.dropColumn('discount_max_dollars');
  });
};
