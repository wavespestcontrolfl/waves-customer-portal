const REMOVED_TEMPLATE_KEYS = [
  'auto_lawn_service',
  'estimate_accepted_customer',
  'onboarding_welcome',
  'onboarding_followup_24h',
  'onboarding_followup_72h',
  'onboarding_followup_expiring',
  'reschedule_confirmed_sms_reply',
  'reschedule_call_requested',
];

function cleanTemplateName(name) {
  return String(name || '')
    .replace(/\s*\(hardcoded\)/gi, '')
    .replace(/\bV[12]\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  if (await knex.schema.hasTable('sms_template_variants')) {
    await knex('sms_template_variants')
      .whereIn('template_key', REMOVED_TEMPLATE_KEYS)
      .del();
  }

  await knex('sms_templates')
    .whereIn('template_key', REMOVED_TEMPLATE_KEYS)
    .del();

  const cols = await knex('sms_templates').columnInfo();
  if (!cols.name) return;

  const rows = await knex('sms_templates').select('id', 'template_key', 'name');
  const now = new Date();
  for (const row of rows) {
    const name = cleanTemplateName(row.name);
    if (!name || name === row.name) continue;
    const update = {
      name,
      ...(cols.updated_at ? { updated_at: now } : {}),
    };
    const query = row.id
      ? knex('sms_templates').where({ id: row.id })
      : knex('sms_templates').where({ template_key: row.template_key });
    await query.update(update);
  }
};

exports.down = async function down() {
  // Removed copy/templates are intentionally not restored.
};
