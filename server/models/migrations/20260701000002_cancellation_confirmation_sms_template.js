'use strict';

// A cancellation request is auto-processed (visits pulled + account churned), so
// the generic service_request_confirmation copy ("we'll text you when it has been
// assigned to a technician") is wrong for it. Seed a dedicated, accurate template.
const TEMPLATE = {
  template_key: 'service_cancellation_confirmation',
  name: 'Service Cancellation Confirmation',
  category: 'service',
  body: 'Hi {first_name}! We received your cancellation request. Our team will process it and follow up to confirm. Questions? Reply here.',
  variables: ['first_name'],
  sort_order: 32,
};

exports.up = async function up(knex) {
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
  };
  if (cols.updated_at) row.updated_at = now;

  const existing = await knex('sms_templates')
    .where({ template_key: TEMPLATE.template_key })
    .first();

  if (existing) {
    await knex('sms_templates').where({ template_key: TEMPLATE.template_key }).update(row);
    return;
  }

  await knex('sms_templates').insert({
    ...row,
    ...(cols.is_active ? { is_active: true } : {}),
    ...(cols.is_internal ? { is_internal: false } : {}),
    ...(cols.created_at ? { created_at: now } : {}),
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await knex('sms_templates').where({ template_key: TEMPLATE.template_key }).del();
};

exports.TEMPLATE = TEMPLATE;
