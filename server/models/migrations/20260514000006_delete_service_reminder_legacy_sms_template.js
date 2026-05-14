const TEMPLATE = {
  template_key: 'service_reminder_legacy',
  name: 'Service Reminder (Legacy 24h) (hardcoded)',
  category: 'service',
  body: 'Hello {first_name}! Your {service_type} is scheduled for tomorrow {time_window}.\n\nTechnician: {tech_name}\n\nPlease unlock gates and secure pets. Reply CONFIRM, or call (941) 318-7612 to reschedule.',
  variables: ['first_name', 'service_type', 'time_window', 'tech_name'],
  sort_order: 10,
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  await knex('sms_templates')
    .where({ template_key: TEMPLATE.template_key })
    .del();
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  const cols = await knex('sms_templates').columnInfo();
  const now = new Date();
  const row = {
    template_key: TEMPLATE.template_key,
    name: TEMPLATE.name,
    category: TEMPLATE.category,
    body: TEMPLATE.body,
    variables: JSON.stringify(TEMPLATE.variables),
    sort_order: TEMPLATE.sort_order,
    ...(cols.is_active ? { is_active: true } : {}),
    ...(cols.is_internal ? { is_internal: false } : {}),
    ...(cols.created_at ? { created_at: now } : {}),
    ...(cols.updated_at ? { updated_at: now } : {}),
  };

  await knex('sms_templates')
    .insert(row)
    .onConflict('template_key')
    .ignore();
};
