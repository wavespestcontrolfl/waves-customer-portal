/**
 * Remove duplicate invoice follow-up templates. The 7-day, 14-day, and
 * 30-day overdue messages already exist as late_payment_7d / 14d / 30d
 * (seeded by the original sms_templates ensureTable). The follow-up engine
 * now points at the late_payment_* keys directly, so the duplicates are
 * dead weight.
 *
 * Kept: invoice_due_today, invoice_followup_3day, invoice_thank_you
 * (no equivalents in the late_payment_* set).
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  await knex('sms_templates')
    .whereIn('template_key', [
      'invoice_followup_7day',
      'invoice_followup_14day',
      'invoice_followup_30day',
    ])
    .del();
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  const templates = [
    {
      template_key: 'invoice_followup_7day',
      name: 'Invoice — 7-Day Follow-Up',
      category: 'billing',
      body:
        'Hello {first_name}, this is a reminder from Waves. Your invoice for {invoice_title}' +
        '{service_date_clause} is now 7 days overdue.\n\nPlease make your payment here: ' +
        '{pay_url}\n\nQuestions? Reply to this message. Thank you for choosing Waves!',
      variables: JSON.stringify(['first_name', 'invoice_title', 'service_date_clause', 'pay_url']),
      sort_order: 19,
    },
    {
      template_key: 'invoice_followup_14day',
      name: 'Invoice — 14-Day Urgent',
      category: 'billing',
      body:
        'Hello {first_name}, your invoice for {invoice_title}{service_date_clause} is now ' +
        '14 days overdue. Please make payment as soon as possible: {pay_url}\n\n' +
        'Questions? Reply to this message. — Waves',
      variables: JSON.stringify(['first_name', 'invoice_title', 'service_date_clause', 'pay_url']),
      sort_order: 20,
    },
    {
      template_key: 'invoice_followup_30day',
      name: 'Invoice — 30-Day Final Notice',
      category: 'billing',
      body:
        'Hello {first_name}, this is a final reminder. Your invoice for {invoice_title}' +
        '{service_date_clause} is 30 days overdue. Please pay immediately to avoid ' +
        'collections: {pay_url}\n\nReply to discuss or request a payment plan. — Waves',
      variables: JSON.stringify(['first_name', 'invoice_title', 'service_date_clause', 'pay_url']),
      sort_order: 21,
    },
  ];

  for (const t of templates) {
    const exists = await knex('sms_templates').where({ template_key: t.template_key }).first();
    if (!exists) await knex('sms_templates').insert(t);
  }
};
