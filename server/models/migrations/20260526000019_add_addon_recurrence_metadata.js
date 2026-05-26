exports.up = async function (knex) {
  const hasAddons = await knex.schema.hasTable('scheduled_service_addons');
  if (!hasAddons) return;

  const cols = await knex('scheduled_service_addons').columnInfo();
  await knex.schema.alterTable('scheduled_service_addons', (t) => {
    if (!cols.recurring_pattern) t.string('recurring_pattern', 40).nullable();
    if (!cols.recurring_interval_days) t.integer('recurring_interval_days').nullable();
    if (!cols.recurring_nth) t.integer('recurring_nth').nullable();
    if (!cols.recurring_weekday) t.integer('recurring_weekday').nullable();
    if (!cols.skip_weekends) t.boolean('skip_weekends').nullable();
    if (!cols.weekend_shift) t.string('weekend_shift', 12).nullable();
  });
};

exports.down = async function (knex) {
  const hasAddons = await knex.schema.hasTable('scheduled_service_addons');
  if (!hasAddons) return;

  const cols = await knex('scheduled_service_addons').columnInfo();
  await knex.schema.alterTable('scheduled_service_addons', (t) => {
    if (cols.recurring_pattern) t.dropColumn('recurring_pattern');
    if (cols.recurring_interval_days) t.dropColumn('recurring_interval_days');
    if (cols.recurring_nth) t.dropColumn('recurring_nth');
    if (cols.recurring_weekday) t.dropColumn('recurring_weekday');
    if (cols.skip_weekends) t.dropColumn('skip_weekends');
    if (cols.weekend_shift) t.dropColumn('weekend_shift');
  });
};
