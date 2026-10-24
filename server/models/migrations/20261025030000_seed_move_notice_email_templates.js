'use strict';

/**
 * Seed appointment.rescheduled and appointment.cancelled: the email version of
 * the reschedule and cancellation texts (GATE_MOVE_NOTICE_EMAIL, owner
 * 2026-10-24 "reschedule email").
 *
 * A customer whose line cannot take texts (a landline, or a number a carrier
 * bounced) hears nothing when a visit moves or is cancelled: those two notices
 * had no email version. With the gate on, services/appointment-reminders.js
 * deliverMoveNoticeEmail sends one of these when the text reached nobody.
 *
 * Same words as the two texts (sms_templates appointment_rescheduled /
 * appointment_cancelled), same stream and suppression group as the other
 * appointment emails (20260616000002): required transactional notices.
 *
 * Insert-only: an existing template is left alone, so a re-run never overwrites
 * an office edit. down() is a documented no-op: the templates may carry office
 * edits by then, and with the gate off nothing sends them. Retire them from the
 * template editor.
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
  appointment_day: 'Wednesday',
  appointment_date: 'November 4, 2026',
  arrival_window: 'between 4:00 PM and 6:00 PM',
  property_label: 'Primary property',
};

const TEMPLATES = [
  {
    key: 'appointment.rescheduled',
    name: 'Appointment Rescheduled',
    description: 'Email version of the reschedule text, sent when that text reached nobody (GATE_MOVE_NOTICE_EMAIL).',
    required: ['first_name', 'service_type', 'appointment_day', 'appointment_date', 'arrival_window'],
    optional: ['property_label'],
    subject: 'Your Waves appointment has a new time',
    preview: 'Your Waves service appointment has moved to a new time.',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}},' },
      { type: 'paragraph', content: 'Your {{service_type}} with Waves is now {{appointment_day}}, {{appointment_date}}, {{arrival_window}}.' },
      { type: 'details', rows: [
        { label: 'Service', value: '{{service_type}}' },
        { label: 'Day', value: '{{appointment_day}}' },
        { label: 'Date', value: '{{appointment_date}}' },
        { label: 'Arrival', value: '{{arrival_window}}' },
        { label: 'Property', value: '{{property_label}}' },
      ] },
      { type: 'small_note', content: 'Need a different time? Reply to this email or call {{company_phone}} and we will help.' },
      { type: 'cta', label: 'View appointment', url_variable: 'customer_portal_url' },
      { type: 'signature', content: 'Thank you, The Waves Team' },
    ],
  },
  {
    key: 'appointment.cancelled',
    name: 'Appointment Cancelled',
    description: 'Email version of the cancellation text, sent when that text reached nobody (GATE_MOVE_NOTICE_EMAIL).',
    required: ['first_name', 'service_type', 'appointment_day', 'appointment_date'],
    optional: ['property_label'],
    subject: 'Your Waves appointment is cancelled',
    preview: 'Your Waves service appointment is cancelled.',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}},' },
      { type: 'paragraph', content: 'Your {{service_type}} with Waves on {{appointment_day}}, {{appointment_date}} is cancelled.' },
      { type: 'details', rows: [
        { label: 'Service', value: '{{service_type}}' },
        { label: 'Day', value: '{{appointment_day}}' },
        { label: 'Date', value: '{{appointment_date}}' },
        { label: 'Property', value: '{{property_label}}' },
      ] },
      { type: 'small_note', content: 'Want a new time? Reply to this email or call {{company_phone}} and we will set it up.' },
      { type: 'cta', label: 'View your visits', url_variable: 'customer_portal_url' },
      { type: 'signature', content: 'Thank you, The Waves Team' },
    ],
  },
];

function templateRow(t) {
  const allowed = [...new Set([...SHARED_VARIABLES, ...t.required, ...t.optional])];
  const required = [...new Set(t.required)];
  const optional = allowed.filter((key) => !required.includes(key));
  return {
    template_key: t.key,
    name: t.name,
    description: t.description,
    mode: 'service',
    purpose: 'appointment',
    legal_classification: 'transactional_relationship',
    audience: 'customer',
    message_priority: 'normal',
    content_sensitivity: 'service',
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
  };
}

async function insertTemplate(trx, t, hasFixtures) {
  if (await trx('email_templates').where({ template_key: t.key }).first('id')) return;
  const now = new Date();
  const [template] = await trx('email_templates').insert({ ...templateRow(t), created_at: now, updated_at: now }).returning('*');
  const [version] = await trx('email_template_versions').insert({
    template_id: template.id,
    version_number: 1,
    status: 'active',
    subject: t.subject,
    preview_text: t.preview,
    blocks: JSON.stringify(t.blocks),
    text_body: null,
    published_at: now,
    created_at: now,
    updated_at: now,
  }).returning('*');
  await trx('email_templates').where({ id: template.id }).update({
    active_version_id: version.id,
    last_published_at: now,
    updated_at: now,
  });
  if (hasFixtures) {
    await trx('email_template_fixtures').insert({
      template_id: template.id, name: 'Happy path', payload: JSON.stringify(PREVIEW_PAYLOAD), is_default: true,
      created_at: now, updated_at: now,
    });
  }
}

exports.up = async function up(knex) {
  const hasTables = await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions');
  if (!hasTables) return;
  const hasFixtures = await knex.schema.hasTable('email_template_fixtures');
  await knex.transaction(async (trx) => {
    for (const t of TEMPLATES) await insertTemplate(trx, t, hasFixtures);
  });
};

exports.down = async function down() {
  // No-op on purpose (see the header): rollback must not delete admin-owned content.
};

exports.__private = { TEMPLATES, PREVIEW_PAYLOAD, templateRow };
