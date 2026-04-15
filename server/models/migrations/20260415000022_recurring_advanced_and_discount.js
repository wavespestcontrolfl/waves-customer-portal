/**
 * Add advanced recurring options (nth-weekday-of-month, custom interval)
 * and per-service discount fields.
 */

exports.up = async function (knex) {
  const add = async (col, builder) => {
    const has = await knex.schema.hasColumn('scheduled_services', col);
    if (!has) await knex.schema.alterTable('scheduled_services', builder);
  };

  await add('recurring_nth', (t) => t.smallint('recurring_nth').nullable());
  await add('recurring_weekday', (t) => t.smallint('recurring_weekday').nullable());
  await add('recurring_interval_days', (t) => t.smallint('recurring_interval_days').nullable());
  await add('discount_type', (t) => t.string('discount_type', 20).nullable());
  await add('discount_amount', (t) => t.decimal('discount_amount', 10, 2).nullable());
};

exports.down = async function (knex) {
  const drop = async (col) => {
    const has = await knex.schema.hasColumn('scheduled_services', col);
    if (has) await knex.schema.alterTable('scheduled_services', (t) => t.dropColumn(col));
  };
  await drop('recurring_nth');
  await drop('recurring_weekday');
  await drop('recurring_interval_days');
  await drop('discount_type');
  await drop('discount_amount');
};
