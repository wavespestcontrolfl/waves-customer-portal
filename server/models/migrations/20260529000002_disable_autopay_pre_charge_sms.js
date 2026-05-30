exports.up = async function(knex) {
  const exists = await knex.schema.hasTable('sms_templates');
  if (!exists) return;

  await knex('sms_templates')
    .where({ template_key: 'autopay_pre_charge' })
    .update({ is_active: false });
};

exports.down = async function(knex) {
  const exists = await knex.schema.hasTable('sms_templates');
  if (!exists) return;

  await knex('sms_templates')
    .where({ template_key: 'autopay_pre_charge' })
    .update({ is_active: true });
};
