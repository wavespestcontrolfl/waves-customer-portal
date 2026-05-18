exports.up = async function up(knex) {
  await knex('email_preference_groups')
    .where({ key: 'service_operational' })
    .update({
      user_can_unsubscribe: false,
      updated_at: new Date(),
    });

  await knex('email_templates')
    .where('template_key', 'like', 'codex.smoke.%')
    .update({
      status: 'archived',
      updated_at: new Date(),
    });
};

exports.down = async function down(knex) {
  await knex('email_preference_groups')
    .where({ key: 'service_operational' })
    .update({
      user_can_unsubscribe: true,
      updated_at: new Date(),
    });
};
