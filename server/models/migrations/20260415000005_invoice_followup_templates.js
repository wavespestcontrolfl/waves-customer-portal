/**
 * Register invoice-followup SMS bodies in sms_templates so admins can edit
 * them from the Communications → SMS Templates page and keep brand voice
 * consistent across every customer touchpoint.
 *
 * Existing hardcoded copy lives in server/config/invoice-followups.js. This
 * migration seeds the same copy into the template table using {variable}
 * syntax; the service reads from the table with the config as fallback.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  const templates = [
    {
      template_key: 'invoice_due_today',
      name: 'Invoice — Due Today',
      category: 'billing',
      body:
        'Hi {first_name}! Quick reminder from Waves — your invoice for {invoice_title} ' +
        '(${amount}) is due today. Pay here: {pay_url}\n\nAlready paid? Disregard — ' +
        'takes a few hours to clear. Reply with any questions. — Waves',
      variables: JSON.stringify(['first_name', 'invoice_title', 'amount', 'pay_url']),
      sort_order: 17,
    },
    {
      template_key: 'invoice_followup_3day',
      name: 'Invoice — 3-Day Friendly Nudge',
      category: 'billing',
      body:
        "Hi {first_name}, still showing an open balance on your invoice for {invoice_title} — " +
        "${amount}. Secure pay link: {pay_url}\n\nIf something's off, just reply and " +
        "we'll sort it. — Waves",
      variables: JSON.stringify(['first_name', 'invoice_title', 'amount', 'pay_url']),
      sort_order: 18,
    },
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
    {
      template_key: 'invoice_thank_you',
      name: 'Invoice — Thank You (Post-Payment)',
      category: 'billing',
      body:
        '{first_name}, got it — thank you for the payment! Your account is all caught up. ' +
        'See you at your next service. — Waves 🌊',
      variables: JSON.stringify(['first_name']),
      sort_order: 22,
    },
    {
      template_key: 'appointment_rescheduled',
      name: 'Appointment Rescheduled',
      category: 'service',
      body:
        'Hello {first_name}! Your {service_type} with Waves has been rescheduled to {day}, {date} at {time}.\n\n' +
        'Need to change it again? Log into your portal at portal.wavespestcontrol.com or reply here.\n\n' +
        'Thank you for choosing Waves!',
      variables: JSON.stringify(['first_name', 'service_type', 'day', 'date', 'time']),
      sort_order: 6,
    },
    {
      template_key: 'appointment_cancelled',
      name: 'Appointment Cancelled',
      category: 'service',
      body:
        'Hello {first_name}! Your {service_type} with Waves scheduled for {day}, {date} has been cancelled.\n\n' +
        "Want to reschedule? Reply here or call (941) 318-7612 and we'll get you back on the calendar.",
      variables: JSON.stringify(['first_name', 'service_type', 'day', 'date']),
      sort_order: 7,
    },
  ];

  for (const t of templates) {
    const exists = await knex('sms_templates').where({ template_key: t.template_key }).first();
    if (!exists) {
      await knex('sms_templates').insert(t);
    }
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await knex('sms_templates').whereIn('template_key', [
    'invoice_due_today',
    'invoice_followup_3day',
    'invoice_followup_7day',
    'invoice_followup_14day',
    'invoice_followup_30day',
    'invoice_thank_you',
    'appointment_rescheduled',
    'appointment_cancelled',
  ]).del();
};
