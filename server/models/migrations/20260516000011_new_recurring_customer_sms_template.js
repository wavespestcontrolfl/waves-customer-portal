const NEW_RECURRING_BODY = 'Hello {first_name}! Welcome to Waves!\n\nYou can also manage your account at portal.wavespestcontrol.com to view your upcoming appointments, reschedule services, request re-services, view invoices, and more.\n\nQuestions or requests? Reply here.';

const PREVIOUS_SMS_TEMPLATE_BODY = 'Hello {first_name}! Welcome to Waves. We just emailed your welcome guide for a safer, pest-free home.\n\nQuestions or requests? Reply here.';

const LEGACY_AUTOMATION_BODIES = [
  'Hello {first_name}! Welcome to a safer, pest-free home with Waves! Check your inbox, we just emailed you our welcome guide.\n\nIf you have any questions or need assistance, simply reply to this message.',
  PREVIOUS_SMS_TEMPLATE_BODY,
];

function smsTemplateRow(cols, now) {
  const row = {
    template_key: 'auto_new_recurring',
    name: 'New Recurring Customer',
    category: 'automations',
    body: NEW_RECURRING_BODY,
    variables: JSON.stringify(['first_name']),
    sort_order: 40,
  };

  if (cols.updated_at) row.updated_at = now;
  return row;
}

exports.up = async function up(knex) {
  const now = new Date();

  if (await knex.schema.hasTable('sms_templates')) {
    const cols = await knex('sms_templates').columnInfo();
    const row = smsTemplateRow(cols, now);
    const existing = await knex('sms_templates')
      .where({ template_key: 'auto_new_recurring' })
      .first();

    if (existing) {
      await knex('sms_templates')
        .where({ template_key: 'auto_new_recurring' })
        .update(row);
    } else {
      await knex('sms_templates').insert({
        ...row,
        ...(cols.is_active ? { is_active: true } : {}),
        ...(cols.is_internal ? { is_internal: false } : {}),
        ...(cols.created_at ? { created_at: now } : {}),
      });
    }
  }

  if (await knex.schema.hasTable('automation_templates')) {
    const automationCols = await knex('automation_templates').columnInfo();
    const automationUpdate = { sms_template: NEW_RECURRING_BODY };
    if (automationCols.updated_at) automationUpdate.updated_at = now;

    await knex('automation_templates')
      .where({ key: 'new_recurring' })
      .where(function replaceOnlyKnownDefaults() {
        this.whereNull('sms_template').orWhereIn('sms_template', LEGACY_AUTOMATION_BODIES);
      })
      .update(automationUpdate);
  }
};

exports.down = async function down(knex) {
  const now = new Date();

  if (await knex.schema.hasTable('sms_templates')) {
    const cols = await knex('sms_templates').columnInfo();
    const update = { body: PREVIOUS_SMS_TEMPLATE_BODY };
    if (cols.updated_at) update.updated_at = now;
    await knex('sms_templates')
      .where({ template_key: 'auto_new_recurring' })
      .update(update);
  }

  if (await knex.schema.hasTable('automation_templates')) {
    const automationCols = await knex('automation_templates').columnInfo();
    const automationUpdate = { sms_template: PREVIOUS_SMS_TEMPLATE_BODY };
    if (automationCols.updated_at) automationUpdate.updated_at = now;

    await knex('automation_templates')
      .where({ key: 'new_recurring', sms_template: NEW_RECURRING_BODY })
      .update(automationUpdate);
  }
};
