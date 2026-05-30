const TEMPLATE_KEYS = [
  'lead_service_pest',
  'lead_service_lawn',
  'lead_service_one_time',
  'lead_address_needed',
  'lead_safe_ack',
];

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
