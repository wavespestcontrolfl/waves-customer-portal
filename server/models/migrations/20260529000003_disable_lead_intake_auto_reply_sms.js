const TEMPLATE_KEYS = [];

exports.up = async function(knex) {
  const exists = await knex.schema.hasTable('sms_templates');
  if (!exists) return;

  await knex('sms_templates')
    .whereIn('template_key', TEMPLATE_KEYS)
    .update({ is_active: false });
};

exports.down = async function(knex) {
  const exists = await knex.schema.hasTable('sms_templates');
  if (!exists) return;

  await knex('sms_templates')
    .whereIn('template_key', TEMPLATE_KEYS)
    .update({ is_active: true });
};
