const ONBOARDING_EMAIL_TEMPLATE_KEYS = [
  'onboarding.24h_reminder',
  'onboarding.72h_reminder',
  'onboarding.expiring_notice',
];

const ONBOARDING_TRIGGER_KEYS = [
  'onboarding.created',
  'onboarding.expiring_soon',
];

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('email_template_automation_runs')) {
    await knex('email_template_automation_runs')
      .where((builder) => {
        builder
          .whereIn('trigger_event_key', ONBOARDING_TRIGGER_KEYS)
          .orWhereIn('template_key', ONBOARDING_EMAIL_TEMPLATE_KEYS);
      })
      .whereIn('status', ['queued', 'scheduled', 'retry_scheduled'])
      .update({
        status: 'skipped',
        exit_reason: 'Onboarding flow removed',
        completed_at: new Date(),
        updated_at: new Date(),
      });
  }

  if (await knex.schema.hasTable('email_template_automations')) {
    await knex('email_template_automations')
      .where((builder) => {
        builder
          .whereIn('trigger_event_key', ONBOARDING_TRIGGER_KEYS)
          .orWhereIn('template_key', ONBOARDING_EMAIL_TEMPLATE_KEYS);
      })
      .del();
  }

  if (!(await knex.schema.hasTable('email_templates'))) return;

  const rows = await knex('email_templates')
    .whereIn('template_key', ONBOARDING_EMAIL_TEMPLATE_KEYS)
    .select('id');
  const ids = rows.map((row) => row.id).filter(Boolean);
  if (!ids.length) return;

  if (await knex.schema.hasTable('email_template_fixtures')) {
    await knex('email_template_fixtures')
      .whereIn('template_id', ids)
      .del();
  }

  if (await knex.schema.hasTable('email_template_versions')) {
    await knex('email_template_versions')
      .whereIn('template_id', ids)
      .del();
  }

  await knex('email_templates')
    .whereIn('id', ids)
    .del();
};

exports.down = async function down() {
  // Removed onboarding automations/templates are intentionally not restored.
};
