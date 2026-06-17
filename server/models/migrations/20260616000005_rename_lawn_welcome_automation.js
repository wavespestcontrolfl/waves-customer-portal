exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('automation_templates'))) return;

  const cols = await knex('automation_templates').columnInfo();
  const update = {
    name: 'Lawn Care Welcome',
    ...(cols.sms_template ? { sms_template: null } : {}),
    ...(cols.updated_at ? { updated_at: new Date() } : {}),
  };

  await knex('automation_templates')
    .where({ key: 'lawn_service' })
    .update(update);
};

exports.down = async function down() {
  // Do not restore onboarding-labeled automation copy.
};
