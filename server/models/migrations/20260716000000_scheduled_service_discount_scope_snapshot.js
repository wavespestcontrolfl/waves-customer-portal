/**
 * Snapshot service-scoped appointment discount filters on each scheduled
 * series. Recurring children must replay the scope agreed at booking even if
 * an administrator later edits the reusable discount catalog entry.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  const [hasKey, hasCategory] = await Promise.all([
    knex.schema.hasColumn('scheduled_services', 'discount_service_key_filter'),
    knex.schema.hasColumn('scheduled_services', 'discount_service_category_filter'),
  ]);
  if (!hasKey || !hasCategory) {
    await knex.schema.alterTable('scheduled_services', (table) => {
      if (!hasKey) table.string('discount_service_key_filter', 200).nullable();
      if (!hasCategory) table.string('discount_service_category_filter', 200).nullable();
    });
  }

  // Existing series get a one-time immutable snapshot of the catalog scope
  // that is in force when this migration lands. Runtime replay never re-reads
  // these mutable discount fields.
  await knex.raw(`
    UPDATE scheduled_services AS scheduled
    SET discount_service_key_filter = discounts.service_key_filter,
        discount_service_category_filter = discounts.service_category_filter
    FROM discounts
    WHERE scheduled.discount_id = discounts.id
      AND (scheduled.discount_service_key_filter IS NULL
        OR scheduled.discount_service_category_filter IS NULL)
  `);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  const [hasKey, hasCategory] = await Promise.all([
    knex.schema.hasColumn('scheduled_services', 'discount_service_key_filter'),
    knex.schema.hasColumn('scheduled_services', 'discount_service_category_filter'),
  ]);
  if (hasKey || hasCategory) {
    await knex.schema.alterTable('scheduled_services', (table) => {
      if (hasCategory) table.dropColumn('discount_service_category_filter');
      if (hasKey) table.dropColumn('discount_service_key_filter');
    });
  }
};
