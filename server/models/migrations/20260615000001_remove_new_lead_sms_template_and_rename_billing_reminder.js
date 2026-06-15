exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const cols = await knex('sms_templates').columnInfo();

  await knex('sms_templates')
    .where({ template_key: ['auto', 'new', 'lead'].join('_') })
    .del();

  if (await knex.schema.hasTable('automation_templates')) {
    const automationCols = await knex('automation_templates').columnInfo();
    if (automationCols.sms_template) {
      await knex('automation_templates')
        .where({ key: 'new_lead' })
        .update({
          sms_template: null,
          ...(automationCols.updated_at ? { updated_at: new Date() } : {}),
        });
    }
  }

  await knex('sms_templates')
    .where({ template_key: 'billing_reminder' })
    .update({
      name: 'Billing Reminder (WaveGuard Monthly)',
      ...(cols.updated_at ? { updated_at: new Date() } : {}),
    });
};

exports.down = async function () {
  // Data cleanup only. Do not recreate retired SMS copy on rollback.
};
