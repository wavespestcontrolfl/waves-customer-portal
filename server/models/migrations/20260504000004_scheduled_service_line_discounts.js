exports.up = async function (knex) {
  const serviceCols = await knex('scheduled_services').columnInfo();
  await knex.schema.alterTable('scheduled_services', (t) => {
    if (!serviceCols.line_discount_id) t.uuid('line_discount_id').nullable();
    if (!serviceCols.line_discount_name) t.string('line_discount_name', 200).nullable();
    if (!serviceCols.line_discount_type) t.string('line_discount_type', 30).nullable();
    if (!serviceCols.line_discount_amount) t.decimal('line_discount_amount', 10, 2).nullable();
    if (!serviceCols.line_discount_dollars) t.decimal('line_discount_dollars', 10, 2).nullable();
  });

  const hasAddons = await knex.schema.hasTable('scheduled_service_addons');
  if (hasAddons) {
    const addonCols = await knex('scheduled_service_addons').columnInfo();
    await knex.schema.alterTable('scheduled_service_addons', (t) => {
      if (!addonCols.discount_id) t.uuid('discount_id').nullable();
      if (!addonCols.discount_name) t.string('discount_name', 200).nullable();
      if (!addonCols.discount_type) t.string('discount_type', 30).nullable();
      if (!addonCols.discount_amount) t.decimal('discount_amount', 10, 2).nullable();
      if (!addonCols.discount_dollars) t.decimal('discount_dollars', 10, 2).nullable();
    });
  }
};

exports.down = async function (knex) {
  const hasAddons = await knex.schema.hasTable('scheduled_service_addons');
  if (hasAddons) {
    const addonCols = await knex('scheduled_service_addons').columnInfo();
    await knex.schema.alterTable('scheduled_service_addons', (t) => {
      if (addonCols.discount_id) t.dropColumn('discount_id');
      if (addonCols.discount_name) t.dropColumn('discount_name');
      if (addonCols.discount_type) t.dropColumn('discount_type');
      if (addonCols.discount_amount) t.dropColumn('discount_amount');
      if (addonCols.discount_dollars) t.dropColumn('discount_dollars');
    });
  }

  const serviceCols = await knex('scheduled_services').columnInfo();
  await knex.schema.alterTable('scheduled_services', (t) => {
    if (serviceCols.line_discount_id) t.dropColumn('line_discount_id');
    if (serviceCols.line_discount_name) t.dropColumn('line_discount_name');
    if (serviceCols.line_discount_type) t.dropColumn('line_discount_type');
    if (serviceCols.line_discount_amount) t.dropColumn('line_discount_amount');
    if (serviceCols.line_discount_dollars) t.dropColumn('line_discount_dollars');
  });
};
