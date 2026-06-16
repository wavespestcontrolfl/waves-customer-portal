/**
 * Seed editable appointment email templates used as the SMS->email fallback for
 * appointment notifications (confirmation, 72h reminder, 24h reminder, en route).
 *
 * Appointment texts are SMS-first. When the SMS cannot be delivered (landline /
 * carrier-undeliverable / no mobile / blocked) the appointment flow falls back to
 * these emails so the customer still gets the information. They are treated as
 * required transactional notices (always delivered, bypassing marketing
 * unsubscribes) — see send_stream / suppression_group_key below.
 *
 * Mirrors the structure of 20260521000003_seed_account_membership_email_templates.js.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';

const SHARED_VARIABLES = [
  'first_name',
  'customer_name',
  'customer_portal_url',
  'company_phone',
  'company_email',
];

const PREVIEW_PAYLOAD = {
  first_name: 'Stan',
  customer_name: 'Stan Example',
  customer_portal_url: 'https://portal.wavespestcontrol.com/login',
  company_phone: '(941) 555-0000',
  company_email: SERVICE_FROM,
  service_type: 'Quarterly Pest Control',
  appointment_day: 'Tuesday',
  appointment_date: 'June 23, 2026',
  appointment_time: '9:00 AM',
  property_label: 'Primary property',
  tech_name: 'Adam',
  eta_minutes: '20',
  track_url: 'https://portal.wavespestcontrol.com/l/h24q8',
};

const TEMPLATES = [
  {
    key: 'appointment.confirmation',
    name: 'Appointment Confirmation',
    category: 'appointment',
    sensitivity: 'service',
    description: 'Email fallback sent when an appointment confirmation text cannot be delivered.',
    required: ['first_name', 'service_type'],
    optional: ['appointment_day', 'appointment_date', 'appointment_time', 'property_label'],
    subject: 'Your Waves appointment is confirmed',
    preview: 'Your Waves service appointment is confirmed.',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}},' },
      { type: 'paragraph', content: 'Your {{service_type}} appointment with Waves is confirmed.' },
      { type: 'details', rows: [
        { label: 'Service', value: '{{service_type}}' },
        { label: 'Day', value: '{{appointment_day}}' },
        { label: 'Date', value: '{{appointment_date}}' },
        { label: 'Scheduled start', value: '{{appointment_time}}' },
        { label: 'Property', value: '{{property_label}}' },
      ] },
      { type: 'paragraph', content: 'Your technician will arrive within a two-hour window of the scheduled start time.' },
      { type: 'small_note', content: 'Need to reschedule or have a question? Reply to this email or contact Waves and we will help.' },
      { type: 'cta', label: 'View appointment', url_variable: 'customer_portal_url' },
      { type: 'signature', content: 'Thank you for choosing Waves, The Waves Team' },
    ],
  },
  {
    key: 'appointment.reminder_72h',
    name: 'Appointment Reminder (72 hour)',
    category: 'appointment',
    sensitivity: 'service',
    description: 'Email fallback sent when a 72-hour appointment reminder text cannot be delivered.',
    required: ['first_name', 'service_type'],
    optional: ['appointment_day', 'appointment_date', 'appointment_time', 'property_label'],
    subject: 'Reminder: your Waves appointment is coming up',
    preview: 'A reminder about your upcoming Waves service appointment.',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}},' },
      { type: 'paragraph', content: 'This is a reminder that your {{service_type}} appointment with Waves is coming up.' },
      { type: 'details', rows: [
        { label: 'Service', value: '{{service_type}}' },
        { label: 'Day', value: '{{appointment_day}}' },
        { label: 'Date', value: '{{appointment_date}}' },
        { label: 'Scheduled start', value: '{{appointment_time}}' },
        { label: 'Property', value: '{{property_label}}' },
      ] },
      { type: 'paragraph', content: 'Expect your technician to arrive within a two-hour window of the scheduled start time.' },
      { type: 'small_note', content: 'Need to reschedule? Log into your customer portal, or reply to this email and we will help.' },
      { type: 'cta', label: 'View appointment', url_variable: 'customer_portal_url' },
      { type: 'signature', content: 'Thank you, The Waves Team' },
    ],
  },
  {
    key: 'appointment.reminder_24h',
    name: 'Appointment Reminder (24 hour)',
    category: 'appointment',
    sensitivity: 'service',
    description: 'Email fallback sent when a 24-hour appointment reminder text cannot be delivered.',
    required: ['first_name', 'service_type'],
    optional: ['appointment_time', 'property_label'],
    subject: 'Reminder: your Waves appointment is tomorrow',
    preview: 'Your Waves service appointment is scheduled for tomorrow.',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}},' },
      { type: 'paragraph', content: 'This is a reminder that your {{service_type}} appointment with Waves is scheduled for tomorrow.' },
      { type: 'details', rows: [
        { label: 'Service', value: '{{service_type}}' },
        { label: 'Scheduled start', value: '{{appointment_time}}' },
        { label: 'Property', value: '{{property_label}}' },
      ] },
      { type: 'paragraph', content: 'Expect your technician to arrive within a two-hour window of the scheduled start time. Your tech will message you when they are about 15 minutes out.' },
      { type: 'small_note', content: 'Questions or need help? Reply to this email and our team will be happy to help.' },
      { type: 'cta', label: 'View appointment', url_variable: 'customer_portal_url' },
      { type: 'signature', content: 'Thank you, The Waves Team' },
    ],
  },
  {
    key: 'appointment.en_route',
    name: 'Technician En Route',
    category: 'appointment',
    sensitivity: 'service',
    description: 'Email fallback sent when an en-route ("technician on the way") text cannot be delivered.',
    required: ['first_name'],
    optional: ['tech_name', 'eta_minutes', 'track_url'],
    subject: 'Your Waves technician is on the way',
    preview: 'Your Waves technician is on the way to your property.',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}},' },
      { type: 'paragraph', content: '{{tech_name}} is on the way to your property.' },
      { type: 'details', rows: [
        { label: 'Technician', value: '{{tech_name}}' },
        { label: 'Estimated arrival', value: '{{eta_minutes}} minutes' },
      ] },
      { type: 'cta', label: 'Track live', url_variable: 'track_url' },
      { type: 'small_note', content: 'Questions or requests? Reply to this email and our team will help.' },
      { type: 'signature', content: 'Thank you, The Waves Team' },
    ],
  },
];

function templateRow(t) {
  const allowed = [...new Set([...SHARED_VARIABLES, ...(t.required || []), ...(t.optional || [])])];
  const required = [...new Set(t.required || [])];
  const optional = allowed.filter((key) => !required.includes(key));
  return {
    template_key: t.key,
    name: t.name,
    description: t.description || null,
    mode: 'service',
    purpose: t.category,
    legal_classification: 'transactional_relationship',
    audience: 'customer',
    message_priority: 'normal',
    content_sensitivity: t.sensitivity || 'service',
    send_stream: 'transactional_required',
    suppression_group_key: 'transactional_required',
    layout_wrapper_id: 'service_default_v1',
    from_name: 'Waves Pest Control',
    from_email: SERVICE_FROM,
    reply_to: SERVICE_FROM,
    default_cta_label: null,
    default_cta_url_variable: null,
    allowed_variables: JSON.stringify(allowed),
    required_variables: JSON.stringify(required),
    optional_variables: JSON.stringify(optional),
    status: 'active',
    updated_at: new Date(),
  };
}

async function upsertTemplate(knex, t) {
  const existing = await knex('email_templates').where({ template_key: t.key }).first();
  let template = existing;
  const row = templateRow(t);

  if (template) {
    await knex('email_templates').where({ id: template.id }).update(row);
    template = await knex('email_templates').where({ id: template.id }).first();
  } else {
    [template] = await knex('email_templates').insert({ ...row, created_at: new Date() }).returning('*');
  }

  let version = template.active_version_id
    ? await knex('email_template_versions').where({ id: template.active_version_id }).first()
    : null;
  if (version) {
    await knex('email_template_versions').where({ id: version.id }).update({
      status: 'active',
      subject: t.subject,
      preview_text: t.preview || null,
      blocks: JSON.stringify(t.blocks || []),
      text_body: null,
      published_at: new Date(),
      updated_at: new Date(),
    });
  } else {
    const latest = await knex('email_template_versions')
      .where({ template_id: template.id })
      .max('version_number as max')
      .first();
    const nextVersion = Number(latest?.max || 0) + 1;
    [version] = await knex('email_template_versions').insert({
      template_id: template.id,
      version_number: nextVersion,
      status: 'active',
      subject: t.subject,
      preview_text: t.preview || null,
      blocks: JSON.stringify(t.blocks || []),
      text_body: null,
      published_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    }).returning('*');
  }

  await knex('email_templates').where({ id: template.id }).update({
    active_version_id: version?.id || template.active_version_id,
    last_published_at: new Date(),
    updated_at: new Date(),
  });

  const existingFixture = await knex('email_template_fixtures')
    .where({ template_id: template.id, is_default: true })
    .first();
  const payload = JSON.stringify(PREVIEW_PAYLOAD);
  if (existingFixture) {
    await knex('email_template_fixtures').where({ id: existingFixture.id }).update({
      name: 'Happy path',
      payload,
      updated_at: new Date(),
    });
  } else {
    await knex('email_template_fixtures').insert({
      template_id: template.id,
      name: 'Happy path',
      payload,
      is_default: true,
      created_at: new Date(),
      updated_at: new Date(),
    });
  }
}

exports.up = async function up(knex) {
  const hasTables = await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions')
    && await knex.schema.hasTable('email_template_fixtures');
  if (!hasTables) return;

  for (const template of TEMPLATES) {
    await upsertTemplate(knex, template);
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  await knex('email_templates')
    .whereIn('template_key', TEMPLATES.map((t) => t.key))
    .del();
};

exports.__private = {
  TEMPLATES,
  SHARED_VARIABLES,
  PREVIEW_PAYLOAD,
  templateRow,
};
