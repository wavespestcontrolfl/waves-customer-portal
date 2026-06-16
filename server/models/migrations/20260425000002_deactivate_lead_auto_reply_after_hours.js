exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
};
