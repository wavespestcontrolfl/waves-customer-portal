'use strict';

/**
 * Cancellation confirmation SMS with an open balance (owner 2026-10-30): a
 * customer who still owes for completed visits hears the amount and gets the
 * pay link, instead of the generic "Completed visits are still payable."
 * One twin per base template; cancellation-confirmations.js renders the twin
 * only when the pay page's own balance authority reports a payable set, and
 * falls back to the base copy otherwise.
 *
 * Two segments rendered worst case (owner ruling 2026-08-31), GSM-7 only.
 * The end-of-coverage twin drops "and nothing is charged after that" to fit;
 * "won't renew" carries that fact.
 *
 * Guarded insert: only when the key is absent. Down removes a row only if it
 * still carries the seeded body.
 */
const TEMPLATES = [
  {
    template_key: 'service_cancellation_confirmation_balance',
    name: 'Cancellation Confirmation (open balance)',
    category: 'automations',
    body:
      "Hi {first_name}, your Waves plan is cancelled as of {effective_date}. Upcoming visits are off the calendar and autopay is off.\n\nYou have an open balance of {balance} for completed visits. Pay here: {pay_url}\n\nQuestions or change your mind? Reply here.",
    variables: ['first_name', 'effective_date', 'balance', 'pay_url'],
    sort_order: 124,
  },
  {
    template_key: 'service_cancellation_end_of_term_confirmation_balance',
    name: 'Cancellation Confirmation (end of paid coverage, open balance)',
    category: 'automations',
    body:
      "Hi {first_name}, your Waves plan is cancelled and won't renew. Paid visits stay on the calendar through {effective_date}.\n\nYou have an open balance of {balance} for completed visits. Pay here: {pay_url}\n\nQuestions or change your mind? Reply here.",
    variables: ['first_name', 'effective_date', 'balance', 'pay_url'],
    sort_order: 126,
  },
];

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

// The segment-budget test imports the exact seeded bodies.
exports.CANCELLATION_BALANCE_BODY = TEMPLATES[0].body;
exports.CANCELLATION_END_OF_TERM_BALANCE_BODY = TEMPLATES[1].body;
