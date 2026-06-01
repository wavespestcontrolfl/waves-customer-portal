exports.up = async function up(knex) {
  const info = await knex('document_templates').columnInfo().catch(() => ({}));
  await knex.schema.alterTable('document_templates', (t) => {
    if (!info.default_delivery_channel) {
      t.string('default_delivery_channel', 20).notNullable().defaultTo('email');
    }
    if (!info.reminder_schedule_days) {
      t.jsonb('reminder_schedule_days').notNullable().defaultTo(knex.raw("'[1, 3, -1]'::jsonb"));
    }
    if (!info.expire_after_days) {
      t.integer('expire_after_days').notNullable().defaultTo(14);
    }
  });
};

exports.down = async function down(knex) {
  const info = await knex('document_templates').columnInfo().catch(() => ({}));
  await knex.schema.alterTable('document_templates', (t) => {
    if (info.expire_after_days) t.dropColumn('expire_after_days');
    if (info.reminder_schedule_days) t.dropColumn('reminder_schedule_days');
    if (info.default_delivery_channel) t.dropColumn('default_delivery_channel');
  });
};
