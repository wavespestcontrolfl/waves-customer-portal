/**
 * Snapshot service-scoped appointment discount filters on each scheduled
 * series. Recurring children must replay the scope agreed at booking even if
 * an administrator later edits the reusable discount catalog entry.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  const [hasKey, hasCategory, hasServiceKey, hasServiceCategory] = await Promise.all([
    knex.schema.hasColumn('scheduled_services', 'discount_service_key_filter'),
    knex.schema.hasColumn('scheduled_services', 'discount_service_category_filter'),
    knex.schema.hasColumn('scheduled_services', 'service_key_snapshot'),
    knex.schema.hasColumn('scheduled_services', 'service_category_snapshot'),
  ]);
  if (!hasKey || !hasCategory || !hasServiceKey || !hasServiceCategory) {
    await knex.schema.alterTable('scheduled_services', (table) => {
      if (!hasKey) table.string('discount_service_key_filter', 200).nullable();
      if (!hasCategory) table.string('discount_service_category_filter', 200).nullable();
      if (!hasServiceKey) table.string('service_key_snapshot', 200).nullable();
      if (!hasServiceCategory) table.string('service_category_snapshot', 200).nullable();
    });
  }

  if (await knex.schema.hasTable('scheduled_service_addons')) {
    const [hasAddonKey, hasAddonCategory] = await Promise.all([
      knex.schema.hasColumn('scheduled_service_addons', 'service_key_snapshot'),
      knex.schema.hasColumn('scheduled_service_addons', 'service_category_snapshot'),
    ]);
    if (!hasAddonKey || !hasAddonCategory) {
      await knex.schema.alterTable('scheduled_service_addons', (table) => {
        if (!hasAddonKey) table.string('service_key_snapshot', 200).nullable();
        if (!hasAddonCategory) table.string('service_category_snapshot', 200).nullable();
      });
    }
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
  await knex.raw(`
    UPDATE scheduled_services AS scheduled
    SET service_key_snapshot = services.service_key,
        service_category_snapshot = services.category
    FROM services
    WHERE scheduled.service_id = services.id
      AND (scheduled.service_key_snapshot IS NULL
        OR scheduled.service_category_snapshot IS NULL)
  `);
  if (await knex.schema.hasTable('scheduled_service_addons')) {
    await knex.raw(`
      UPDATE scheduled_service_addons AS addon
      SET service_key_snapshot = services.service_key,
          service_category_snapshot = services.category
      FROM services
      WHERE addon.service_id = services.id
        AND (addon.service_key_snapshot IS NULL
          OR addon.service_category_snapshot IS NULL)
    `);
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('scheduled_service_addons')) {
    const [hasAddonKey, hasAddonCategory] = await Promise.all([
      knex.schema.hasColumn('scheduled_service_addons', 'service_key_snapshot'),
      knex.schema.hasColumn('scheduled_service_addons', 'service_category_snapshot'),
    ]);
    if (hasAddonKey || hasAddonCategory) {
      await knex.schema.alterTable('scheduled_service_addons', (table) => {
        if (hasAddonCategory) table.dropColumn('service_category_snapshot');
        if (hasAddonKey) table.dropColumn('service_key_snapshot');
      });
    }
  }
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  const [hasKey, hasCategory, hasServiceKey, hasServiceCategory] = await Promise.all([
    knex.schema.hasColumn('scheduled_services', 'discount_service_key_filter'),
    knex.schema.hasColumn('scheduled_services', 'discount_service_category_filter'),
    knex.schema.hasColumn('scheduled_services', 'service_key_snapshot'),
    knex.schema.hasColumn('scheduled_services', 'service_category_snapshot'),
  ]);
  if (hasKey || hasCategory || hasServiceKey || hasServiceCategory) {
    await knex.schema.alterTable('scheduled_services', (table) => {
      if (hasServiceCategory) table.dropColumn('service_category_snapshot');
      if (hasServiceKey) table.dropColumn('service_key_snapshot');
      if (hasCategory) table.dropColumn('discount_service_category_filter');
      if (hasKey) table.dropColumn('discount_service_key_filter');
    });
  }
};
