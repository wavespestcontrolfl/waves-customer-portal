exports.up = async function (knex) {
  if (await knex.schema.hasTable('customer_save_sequences')) {
    await knex.schema.dropTable('customer_save_sequences');
  }

  if (
    await knex.schema.hasTable('retention_agent_reports')
    && await knex.schema.hasColumn('retention_agent_reports', 'sequences_enrolled')
  ) {
    await knex.schema.alterTable('retention_agent_reports', (t) => {
      t.dropColumn('sequences_enrolled');
    });
  }

  if (await knex.schema.hasTable('sms_templates')) {
    await knex('sms_templates').where({ template_key: 'churn_save_step1' }).del();
  }
};

exports.down = async function () {
  // Intentionally irreversible: the save-sequence feature and table are retired.
};
