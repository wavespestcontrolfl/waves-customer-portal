'use strict';

/**
 * Per-service (scoped) cancellation confirmation SMS — ruling C-3 (cancel
 * one, several, or all services) shipped in the cancel-flow C1 lane. The
 * whole-account template says "your plan is cancelled"; a scoped cancel
 * must say which service stopped and that the rest continue. Two segments
 * rendered (owner ruling 2026-08-31), GSM-7 only.
 *
 * Guarded insert: only when the key is absent. Down removes the row only
 * if it still carries the seeded body.
 */
const TEMPLATES = [
  {
    template_key: 'service_cancellation_scoped_confirmation',
    name: 'Cancellation Confirmation (one service)',
    category: 'automations',
    body:
      'Hello {first_name}! {service} is cancelled as of {effective_date}. {remaining} continue as before, and completed visits stay payable. Changed your mind or have a question? Reply here.',
    variables: ['first_name', 'service', 'effective_date', 'remaining'],
    sort_order: 122,
  },
  {
    // Accepted-resolution receipt (C1): the customer kept the plan and
    // accepted a card — confirm exactly what was set up, nothing more.
    template_key: 'service_resolution_confirmation',
    name: 'Resolution Accepted (cancel flow)',
    category: 'automations',
    body:
      'Hello {first_name}! Done: {summary} Reference {reference}. Nothing else about your plan changes. Questions? Reply here.',
    variables: ['first_name', 'summary', 'reference'],
    sort_order: 123,
  },
  {
    // 7-day restart text for a held service (C2, ruling C-4 — this text IS
    // the consent step before auto-resume).
    template_key: 'plan_hold_resume_reminder',
    name: 'Plan Hold Restart Reminder',
    category: 'automations',
    body:
      'Hello {first_name}! Your {service} hold ends {resume_date} and visits restart then. Want a different date, or to cancel instead? Reply here.',
    variables: ['first_name', 'service', 'resume_date'],
    sort_order: 124,
  },
];
const TEMPLATE = TEMPLATES[0];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const cols = await knex('sms_templates').columnInfo();
  for (const t of TEMPLATES) {
    const existing = await knex('sms_templates').where({ template_key: t.template_key }).first('id');
    if (existing) continue;
    const row = { template_key: t.template_key, name: t.name, body: t.body };
    if (cols.category) row.category = t.category;
    if (cols.variables) row.variables = JSON.stringify(t.variables);
    if (cols.sort_order) row.sort_order = t.sort_order;
    if (cols.is_active) row.is_active = true;
    if (cols.created_at) row.created_at = new Date();
    if (cols.updated_at) row.updated_at = new Date();
    await knex('sms_templates').insert(row);
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  for (const t of TEMPLATES) {
    await knex('sms_templates').where({ template_key: t.template_key, body: t.body }).del();
  }
};

module.exports.SCOPED_CONFIRMATION_BODY = TEMPLATE.body;
