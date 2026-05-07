const TEMPLATES = [
  {
    template_key: 'autopay_pre_charge',
    name: 'Autopay - Pre-Charge Reminder',
    category: 'billing',
    body: 'Hello {first_name}! This is a friendly reminder from Waves that your WaveGuard auto-pay will process on {charge_date}.\n\nNeed to update your card or pause? Log into your Waves Customer Portal at portal.wavespestcontrol.com.\n\nQuestions or requests? Reply to this message.',
    variables: ['first_name', 'charge_date'],
    sort_order: 36,
  },
  {
    template_key: 'autopay_card_expired',
    name: 'Autopay - Card Expired',
    category: 'billing',
    body: 'Hello {first_name}, your {card_brand} card ending in {last_four} on file with Waves has expired ({exp_date}).\n\nPlease update it in your Waves Customer Portal at portal.wavespestcontrol.com to keep auto-pay active.\n\nQuestions or requests? Reply to this message.',
    variables: ['first_name', 'card_brand', 'last_four', 'exp_date'],
    sort_order: 37,
  },
  {
    template_key: 'autopay_card_expiring',
    name: 'Autopay - Card Expiring Soon',
    category: 'billing',
    body: 'Hello {first_name}! Your {card_brand} card ending in {last_four} on file with Waves expires {exp_date}.\n\nPlease update it in your Waves Customer Portal at portal.wavespestcontrol.com to avoid any auto-pay disruption.\n\nQuestions or requests? Reply to this message.',
    variables: ['first_name', 'card_brand', 'last_four', 'exp_date'],
    sort_order: 38,
  },
  {
    template_key: 'payment_method_expiry',
    name: 'Payment Method Expiry Notice',
    category: 'billing',
    body: 'Hello {first_name}! Your {card_brand} card ending in {last_four} expires {exp_date}.\n\nPlease update your payment method in your Waves Customer Portal at portal.wavespestcontrol.com to avoid any interruption in service.\n\nQuestions or requests? Reply to this message.',
    variables: ['first_name', 'card_brand', 'last_four', 'exp_date'],
    sort_order: 39,
  },
  {
    template_key: 'service_complete_prepaid',
    name: 'Service Complete + Paid',
    category: 'service',
    body: 'Hello {first_name}! Thanks for your payment today. Your {service_type} service report is ready: {portal_url}\n\nQuestions or requests? Reply to this message. Thank you for choosing Waves!',
    variables: ['first_name', 'service_type', 'portal_url'],
    sort_order: 5,
  },
  {
    template_key: 'reschedule_options_weather',
    name: 'Reschedule Options - Weather',
    category: 'service',
    body: 'Hello {first_name}, due to weather your {service_type} on {original_date} needs to move.\n\nWe have:\n1. {option_1}\n2. {option_2}\n\nReply 1 or 2, or suggest a day. Questions or requests? Reply to this message.',
    variables: ['first_name', 'service_type', 'original_date', 'option_1', 'option_2'],
    sort_order: 8,
  },
  {
    template_key: 'reschedule_options_access',
    name: 'Reschedule Options - Access Issue',
    category: 'service',
    body: 'Hello {first_name}, we stopped by for your {service_type} but {access_issue}. We can come back:\n\n1. {option_1}\n2. {option_2}\n\nReply 1 or 2. Questions or requests? Reply to this message.',
    variables: ['first_name', 'service_type', 'access_issue', 'option_1', 'option_2'],
    sort_order: 9,
  },
  {
    template_key: 'reschedule_options_general',
    name: 'Reschedule Options - General',
    category: 'service',
    body: 'Hello {first_name}, your {service_type} on {original_date} needs to be rescheduled.{reason_text}\n\n1. {option_1}\n2. {option_2}\n\nReply 1 or 2. Questions or requests? Reply to this message.',
    variables: ['first_name', 'service_type', 'original_date', 'reason_text', 'option_1', 'option_2'],
    sort_order: 10,
  },
  {
    template_key: 'reschedule_confirmed_sms_reply',
    name: 'Reschedule Confirmed - SMS Reply',
    category: 'service',
    body: "Confirmed! Your service is rescheduled for {date}, {time}.\n\nWe'll remind you the day before. Questions or requests? Reply to this message.",
    variables: ['date', 'time'],
    sort_order: 11,
  },
  {
    template_key: 'reschedule_call_requested',
    name: 'Reschedule - Call Requested Reply',
    category: 'service',
    body: "No problem! We'll give you a call shortly.\n\nQuestions or requests? Reply to this message.",
    variables: [],
    sort_order: 12,
  },
  {
    template_key: 'self_booking_confirmation',
    name: 'Self-Booking Confirmation',
    category: 'service',
    body: 'Hello {first_name}! Your Waves appointment is confirmed for {date}, {time} at {address}. Confirmation: {confirmation_code}.\n\nNeed to change it? Reply RESCHEDULE. Questions or requests? Reply to this message.',
    variables: ['first_name', 'date', 'time', 'address', 'confirmation_code'],
    sort_order: 13,
  },
  {
    template_key: 'appointment_series_cancelled',
    name: 'Appointment Series Cancelled',
    category: 'service',
    body: "Hello {first_name}! Your Waves {scope} for {service_type} has been cancelled.\n\nWant to reschedule? Reply to this message and we'll get you back on the calendar.",
    variables: ['first_name', 'scope', 'service_type'],
    sort_order: 14,
  },
  {
    template_key: 'onboarding_followup_24h',
    name: 'Onboarding Follow-Up - 24h',
    category: 'service',
    body: 'Hello {first_name}! Thanks again for choosing Waves. Just need a few quick details to get you on the schedule: {onboarding_url}\n\nQuestions or requests? Reply to this message.',
    variables: ['first_name', 'onboarding_url'],
    sort_order: 15,
  },
  {
    template_key: 'onboarding_followup_72h',
    name: 'Onboarding Follow-Up - 72h',
    category: 'service',
    body: "Hello {first_name}! Still here whenever you're ready. Wrap up your Waves setup here and we'll confirm your first service: {onboarding_url}\n\nQuestions or requests? Reply to this message.",
    variables: ['first_name', 'onboarding_url'],
    sort_order: 16,
  },
  {
    template_key: 'onboarding_followup_expiring',
    name: 'Onboarding Follow-Up - Expiring',
    category: 'service',
    body: 'Hello {first_name}! Heads up — your Waves onboarding link expires on {expires_at}. Lock in your WaveGuard {waveguard_tier} plan and first service here: {onboarding_url}\n\nQuestions or requests? Reply to this message.',
    variables: ['first_name', 'onboarding_url', 'expires_at', 'waveguard_tier'],
    sort_order: 17,
  },
  {
    template_key: 'waveguard_upsell',
    name: 'WaveGuard Plan Recommendation',
    category: 'retention',
    body: 'Hello {first_name}! Based on your recent services, our {tier_label} WaveGuard plan may be a better fit with unlimited coverage and predictable billing.\n\nReply INFO to learn more. Questions or requests? Reply to this message.',
    variables: ['first_name', 'tier_label'],
    sort_order: 47,
  },
  {
    template_key: 'renewal_reminder',
    name: 'Renewal Reminder',
    category: 'retention',
    body: "Hello {first_name}! Your {renewal_label} {urgency}.\n\nDon't let your coverage lapse - reply RENEW or call us to take care of it. Questions or requests? Reply to this message.",
    variables: ['first_name', 'renewal_label', 'urgency'],
    sort_order: 48,
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
      ...(cols.is_active ? { is_active: true } : {}),
      ...(cols.updated_at ? { updated_at: now } : {}),
    };
    const existing = await knex('sms_templates').where({ template_key: template.template_key }).first();
    if (existing) {
      await knex('sms_templates').where({ template_key: template.template_key }).update(row);
    } else {
      await knex('sms_templates').insert({
        ...row,
        ...(cols.created_at ? { created_at: now } : {}),
      });
    }
  }
};

exports.down = async function down() {};
