const TEMPLATE = {
  template_key: 'estimate_accepted_annual_prepay',
  name: 'Estimate Accepted - Annual Prepay',
  category: 'estimates',
  body: 'Hello {first_name}! Your {waveguard_tier} WaveGuard plan is approved. Our team will review and send your annual prepay invoice{amount_text}.\n\nQuestions or requests? Reply here.',
  variables: ['first_name', 'waveguard_tier', 'amount_text'],
  is_active: true,
  sort_order: 34,
  updated_at: new Date(),
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await knex('sms_templates')
    .insert({ ...TEMPLATE, created_at: new Date() })
    .onConflict('template_key')
    .merge(TEMPLATE);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await knex('sms_templates')
    .where({ template_key: TEMPLATE.template_key })
    .del();
};
