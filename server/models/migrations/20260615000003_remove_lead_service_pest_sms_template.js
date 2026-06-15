exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  await knex('sms_templates')
    .where({ template_key: ['lead', 'service', 'pest'].join('_') })
    .del();
};

exports.down = async function () {
  // Retired lead-intake SMS copy; rollback should not recreate it.
};
