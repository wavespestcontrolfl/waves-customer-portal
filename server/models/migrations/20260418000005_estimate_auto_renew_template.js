/**
 * Seed SMS template for auto-renewed estimates so billing-cron-style
 * copy edits can happen from the admin UI without a deploy.
 */

const TEMPLATE = {
  template_key: 'estimate_auto_renewed',
  name: 'Estimate — Auto-Renewed',
  category: 'sales',
  body: "Hey {first_name}! Your Waves estimate was about to expire so we extended it a few more days. Still good — take another look whenever you're ready:\n\n{estimate_url}\n\nQuestions? (941) 318-7612 🌊",
  variables: ['first_name', 'estimate_url'],
  sort_order: 30,
};

exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable('sms_templates');
  if (!hasTable) return;

  const row = {
    template_key: TEMPLATE.template_key,
    name: TEMPLATE.name,
    category: TEMPLATE.category,
    body: TEMPLATE.body,
    variables: JSON.stringify(TEMPLATE.variables),
    sort_order: TEMPLATE.sort_order,
  };
  const existing = await knex('sms_templates').where({ template_key: TEMPLATE.template_key }).first();
  if (existing) {
    await knex('sms_templates').where({ id: existing.id }).update(row);
  } else {
    await knex('sms_templates').insert(row);
  }
};

exports.down = async function (knex) {
  const hasTable = await knex.schema.hasTable('sms_templates');
  if (!hasTable) return;
  await knex('sms_templates').where({ template_key: TEMPLATE.template_key }).del();
};
