exports.up = async function (knex) {
  await removePersistedSequenceActions(knex);

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
    await preserveChurnSaveKillSwitch(knex);
    await knex('sms_templates').where({ template_key: 'churn_save_step1' }).del();
  }
};

exports.down = async function () {
  // Intentionally irreversible: the save-sequence feature and table are retired.
};

async function removePersistedSequenceActions(knex) {
  if (!(await knex.schema.hasTable('customer_health_alerts'))) return;
  if (!(await knex.schema.hasColumn('customer_health_alerts', 'recommended_actions'))) return;

  const rows = await knex('customer_health_alerts')
    .select('id', 'recommended_actions')
    .whereNotNull('recommended_actions');

  for (const row of rows) {
    const actions = parseActions(row.recommended_actions);
    if (!actions) continue;

    const filtered = actions.filter((action) => action?.type !== 'sequence' && !action?.sequenceType);
    if (filtered.length === actions.length) continue;

    await knex('customer_health_alerts')
      .where({ id: row.id })
      .update({
        recommended_actions: JSON.stringify(filtered),
        updated_at: new Date(),
      });
  }
}

function parseActions(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function preserveChurnSaveKillSwitch(knex) {
  const oldTemplate = await knex('sms_templates')
    .where({ template_key: 'churn_save_step1' })
    .first();
  if (!oldTemplate || oldTemplate.is_active !== false) return;

  await knex('sms_templates')
    .whereIn('template_key', ['health_retention_offer', 'seasonal_reactivation'])
    .update({ is_active: false, updated_at: new Date() });
}
