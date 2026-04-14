/**
 * Add SMS templates for email automations so they're editable
 * from the SMS Templates admin panel.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  const templates = [
    {
      template_key: 'auto_new_recurring',
      name: 'New Recurring Customer',
      category: 'automations',
      body: 'Hello {first_name}! Welcome to a safer, pest-free home with Waves! Check your inbox, we just emailed you our welcome guide.\n\nIf you have any questions or need assistance, simply reply to this message.',
      variables: JSON.stringify(['first_name']),
      sort_order: 40,
    },
    {
      template_key: 'auto_lawn_service',
      name: 'Lawn Care Onboarding',
      category: 'automations',
      body: 'Hello {first_name}! Welcome to a better lawn with Waves! We just emailed your our lawn care welcome guide + expert tips for the best results for your lawn!\n\nIf you have any questions or need assistance, simply reply to this message.',
      variables: JSON.stringify(['first_name']),
      sort_order: 41,
    },
    {
      template_key: 'auto_new_appointment',
      name: 'New First-Time Appointment',
      category: 'automations',
      body: 'Hello {first_name}! We just emailed you a breakdown of what to expect with your upcoming service with Waves!\n\nIf you have any questions or need assistance, simply reply to this message.',
      variables: JSON.stringify(['first_name']),
      sort_order: 42,
    },
    {
      template_key: 'auto_bed_bug',
      name: 'Bed Bug Treatment',
      category: 'automations',
      body: "Hello {first_name}! Let's get your home bed bug-free. We just emailed your Waves treatment guide\u2014please review it to help us get the best results for your home!\n\nIf you have any questions or need assistance, simply reply to this message.",
      variables: JSON.stringify(['first_name']),
      sort_order: 43,
    },
    {
      template_key: 'auto_cockroach',
      name: 'Cockroach Control',
      category: 'automations',
      body: "Hello {first_name}! Let's get your home cockroach-free. We just emailed your Waves treatment guide\u2014please review it to help us get the best results for your home!\n\nIf you have any questions or need assistance, simply reply to this message.",
      variables: JSON.stringify(['first_name']),
      sort_order: 44,
    },
    {
      template_key: 'auto_new_lead',
      name: 'New Lead',
      category: 'automations',
      body: 'Hi {first_name}! Thanks for your interest in Waves Pest Control. We just sent you an email with more info about our services.\n\nReply here anytime if you have questions!',
      variables: JSON.stringify(['first_name']),
      sort_order: 45,
    },
    {
      template_key: 'auto_service_renewal',
      name: 'Service Renewal Reminder',
      category: 'automations',
      body: "Hi {first_name}! Your Waves service is coming up for renewal. We just emailed you the details \u2014 take a look when you get a chance.\n\nQuestions? Just reply here!",
      variables: JSON.stringify(['first_name']),
      sort_order: 46,
    },
  ];

  for (const t of templates) {
    const exists = await knex('sms_templates').where({ template_key: t.template_key }).first();
    if (!exists) await knex('sms_templates').insert(t);
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await knex('sms_templates').whereIn('template_key', [
    'auto_new_recurring', 'auto_lawn_service', 'auto_new_appointment',
    'auto_bed_bug', 'auto_cockroach', 'auto_new_lead', 'auto_service_renewal',
  ]).del();
};
