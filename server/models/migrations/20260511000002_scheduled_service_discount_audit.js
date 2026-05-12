exports.up = async function (knex) {
  const serviceCols = await knex('scheduled_services').columnInfo();
  await knex.schema.alterTable('scheduled_services', (t) => {
    if (!serviceCols.primary_line_price) t.decimal('primary_line_price', 10, 2).nullable();
    if (!serviceCols.discount_id) t.uuid('discount_id').nullable();
    if (!serviceCols.discount_name) t.string('discount_name', 200).nullable();
    if (!serviceCols.discount_dollars) t.decimal('discount_dollars', 10, 2).nullable();
  });

  const addonCols = await knex('scheduled_service_addons').columnInfo();
  await knex.schema.alterTable('scheduled_service_addons', (t) => {
    if (!addonCols.base_price) t.decimal('base_price', 10, 2).nullable();
  });
};

exports.down = async function (knex) {
  const addonCols = await knex('scheduled_service_addons').columnInfo();
  await knex.schema.alterTable('scheduled_service_addons', (t) => {
    if (addonCols.base_price) t.dropColumn('base_price');
  });

  const serviceCols = await knex('scheduled_services').columnInfo();
  await knex.schema.alterTable('scheduled_services', (t) => {
    if (serviceCols.discount_dollars) t.dropColumn('discount_dollars');
    if (serviceCols.discount_name) t.dropColumn('discount_name');
    if (serviceCols.discount_id) t.dropColumn('discount_id');
    if (serviceCols.primary_line_price) t.dropColumn('primary_line_price');
  });
};
