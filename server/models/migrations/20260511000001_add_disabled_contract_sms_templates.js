const TEMPLATES = [
  {
    template_key: 'autopay_authorization_request',
    name: 'Autopay - Authorization Request',
    category: 'billing',
    body: 'Hello {first_name}! Waves needs your electronic authorization before we keep a payment method on file for future service payments.\n\nReview and sign here: {contract_url}\n\nQuestions or requests? Reply to this message.',
    variables: ['first_name', 'contract_url'],
    sort_order: 40,
  },
  {
    template_key: 'autopay_authorization_cancelled',
    name: 'Autopay - Authorization Cancelled',
    category: 'billing',
    body: 'Hello {first_name}, your Waves auto-pay authorization has been cancelled as of {cancelled_date}.\n\nYour saved payment method will not be used for future automatic charges. You can still pay invoices in the customer portal: {portal_url}\n\nQuestions or requests? Reply to this message.',
    variables: ['first_name', 'cancelled_date', 'portal_url'],
    sort_order: 41,
  },
  {
    template_key: 'auto_renewal_30_60_day_notice',
    name: 'Auto-Renewal Notice - 30-60 Day',
    category: 'retention',
    body: 'Hello {first_name}! Your {service_name} agreement is set to renew on {renewal_date}.\n\nReview the renewal details and cancellation options here: {contract_url}\n\nNeed changes before {cancellation_deadline}? Reply to this message or call (941) 318-7612.',
    variables: ['first_name', 'service_name', 'renewal_date', 'contract_url', 'cancellation_deadline'],
    sort_order: 49,
  },
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const cols = await knex('sms_templates').columnInfo();
  const now = new Date();

  for (const template of TEMPLATES) {
    const row = {
      ...template,
      variables: JSON.stringify(template.variables),
      ...(cols.is_active ? { is_active: false } : {}),
      ...(cols.updated_at ? { updated_at: now } : {}),
    };

    const existing = await knex('sms_templates')
      .where({ template_key: template.template_key })
      .first();

    if (existing) {
      await knex('sms_templates')
        .where({ template_key: template.template_key })
        .update(row);
    } else {
      await knex('sms_templates').insert({
        ...row,
        ...(cols.created_at ? { created_at: now } : {}),
      });
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  await knex('sms_templates')
    .whereIn('template_key', TEMPLATES.map(template => template.template_key))
    .del();
};
