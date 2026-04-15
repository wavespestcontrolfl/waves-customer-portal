/**
 * Move the hardcoded estimate-acceptance SMS bodies in
 * server/routes/estimate-public.js into sms_templates so operators can edit
 * them from the admin SMS templates page.
 *
 *  - estimate_accepted_customer → sent to the customer with onboarding link
 *  - estimate_accepted_office   → office notification to WAVES_OFFICE_PHONE
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  const templates = [
    {
      template_key: 'estimate_accepted_customer',
      name: 'Estimate Accepted — Customer Onboarding Link',
      category: 'estimates',
      body: 'Hello {first_name}! Thanks for approving your estimate. Complete your setup here so we can get you on the schedule: {onboarding_url}',
      variables: ['first_name', 'onboarding_url'],
      sort_order: 26,
    },
    {
      template_key: 'estimate_accepted_office',
      name: 'Estimate Accepted — Office Notification',
      category: 'estimates',
      body: '🎉 Estimate accepted! {customer_name} at {address} — {waveguard_tier} WaveGuard ${monthly_total}/mo. Onboarding link sent.',
      variables: ['customer_name', 'address', 'waveguard_tier', 'monthly_total'],
      sort_order: 27,
    },
  ];

  for (const t of templates) {
    const row = {
      template_key: t.template_key,
      name: t.name,
      category: t.category,
      body: t.body,
      variables: JSON.stringify(t.variables),
      sort_order: t.sort_order,
      updated_at: new Date(),
    };
    const existing = await knex('sms_templates').where({ template_key: t.template_key }).first();
    if (existing) {
      await knex('sms_templates').where({ template_key: t.template_key }).update(row);
    } else {
      await knex('sms_templates').insert({ ...row, created_at: new Date() });
    }
  }
};

exports.down = async function () {
  // no-op
};
