exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  await knex('sms_templates')
    .where({ template_key: ['estimate', 'onetime', 'followup'].join('_') })
    .del();
};

exports.down = async function () {
  // Retired SMS copy; rollback should not recreate the deleted template.
};
