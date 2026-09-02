'use strict';

/**
 * End-of-coverage cancellation confirmation SMS (cancel-flow C3, ruling
 * C-6 end_at_term). The whole-account template says upcoming visits are off
 * the calendar — false for an end-of-coverage cancel, which deliberately
 * KEEPS paid visits through term_end. This copy names what actually
 * happens. Two segments rendered (owner ruling 2026-08-31), GSM-7 only.
 *
 * Guarded insert: only when the key is absent. Down removes the row only
 * if it still carries the seeded body.
 */
const TEMPLATE = {
  template_key: 'service_cancellation_end_of_term_confirmation',
  name: 'Cancellation Confirmation (end of paid coverage)',
  category: 'automations',
  // "Nothing new … charged" is future-service only — completed-visit
  // charges stay payable (the email says so; the SMS must not read as
  // forgiving an open balance). 275 chars rendered worst-case (GSM-7,
  // two segments).
  body:
    'Hello {first_name}! Your Waves plan is cancelled and will not renew. Paid-for visits stay on the calendar through {effective_date}; after that nothing new is scheduled or charged. Charges for completed visits remain payable. Changed your mind or have a question? Reply here.',
  variables: ['first_name', 'effective_date'],
  sort_order: 125,
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const cols = await knex('sms_templates').columnInfo();
  const existing = await knex('sms_templates').where({ template_key: TEMPLATE.template_key }).first('id');
  if (existing) return;
  const row = { template_key: TEMPLATE.template_key, name: TEMPLATE.name, body: TEMPLATE.body };
  if (cols.category) row.category = TEMPLATE.category;
  if (cols.variables) row.variables = JSON.stringify(TEMPLATE.variables);
  if (cols.sort_order) row.sort_order = TEMPLATE.sort_order;
  if (cols.is_active) row.is_active = true;
  if (cols.created_at) row.created_at = new Date();
  if (cols.updated_at) row.updated_at = new Date();
  await knex('sms_templates').insert(row);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await knex('sms_templates')
    .where({ template_key: TEMPLATE.template_key, body: TEMPLATE.body })
    .del();
};

// Segment-budget guard test imports the exact seeded body.
exports.CANCELLATION_END_OF_TERM_BODY = TEMPLATE.body;
