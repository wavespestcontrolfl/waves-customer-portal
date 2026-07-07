'use strict';

/**
 * Tech Arrived delivery channel + email template.
 *
 * The portal Settings page is gaining a delivery-channel dropdown
 * (Text / Email / Both) on the "Tech Arrived Alert" row, mirroring the
 * appointment-notification channels from 20260622000011. Two pieces:
 *
 *   1. notification_prefs.tech_arrived_channel — defaults to 'sms' so every
 *      existing customer sees no behavior change (SMS stays primary).
 *      (Tech En Route reuses the existing migration-104 en_route_channel
 *      column, so no new column is needed for it.)
 *
 *   2. email_templates row `appointment.tech_arrived` — the email twin of the
 *      tech_arrived SMS, sent when the customer chooses Email/Both. Follows
 *      the appointment-template conventions from 20260616000002 (service
 *      layout, transactional_required stream) and the footer-parity block
 *      order from 20260706000020 (content → signature → cta → small_note).
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';

const SHARED_VARIABLES = [
  'first_name',
  'customer_name',
  'customer_portal_url',
  'company_phone',
  'company_email',
];

const TEMPLATE = {
  key: 'appointment.tech_arrived',
  name: 'Technician Arrived',
  category: 'appointment',
  sensitivity: 'service',
  description: 'Email version of the "technician has arrived" text, sent when the customer prefers email delivery.',
  required: ['first_name'],
  optional: ['tech_name', 'property_label'],
  subject: 'Your Waves technician has arrived',
  preview: 'Your Waves technician has arrived at your property.',
  blocks: [
    { type: 'paragraph', content: 'Hello {{first_name}},' },
    { type: 'paragraph', content: '{{tech_name}} has arrived at your property and is getting started on your service.' },
    { type: 'details', rows: [
      { label: 'Technician', value: '{{tech_name}}' },
      { label: 'Property', value: '{{property_label}}' },
    ] },
    { type: 'signature', content: 'Thank you, The Waves Team' },
    { type: 'cta', label: 'View visit details', url_variable: 'customer_portal_url' },
    { type: 'small_note', content: 'Questions or requests? Reply to this email and our team will help.' },
  ],
};

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

  if (template) {
    // Re-run safety only — preserve any admin edits by not overwriting an
    // existing row's content; the template already exists, nothing to do.
    return;
  }
  const row = templateRow(t);
  [template] = await knex('email_templates').insert({ ...row, created_at: new Date() }).returning('*');

  const [version] = await knex('email_template_versions').insert({
    template_id: template.id,
    version_number: 1,
    status: 'active',
    subject: t.subject,
    preview_text: t.preview || null,
    blocks: JSON.stringify(t.blocks || []),
    text_body: null,
    published_at: new Date(),
    created_at: new Date(),
    updated_at: new Date(),
  }).returning('*');

  await knex('email_templates').where({ id: template.id }).update({
    active_version_id: version.id,
    last_published_at: new Date(),
    updated_at: new Date(),
  });
}

exports.up = async function up(knex) {
  const hasPrefs = await knex.schema.hasTable('notification_prefs');
  if (hasPrefs) {
    const hasCol = await knex.schema.hasColumn('notification_prefs', 'tech_arrived_channel');
    if (!hasCol) {
      await knex.schema.alterTable('notification_prefs', (t) => {
        t.string('tech_arrived_channel', 10).defaultTo('sms');
      });
    }
  }

  const hasTemplates = await knex.schema.hasTable('email_templates');
  const hasVersions = await knex.schema.hasTable('email_template_versions');
  if (hasTemplates && hasVersions) {
    await upsertTemplate(knex, TEMPLATE);
  }
};

exports.down = async function down(knex) {
  const hasPrefs = await knex.schema.hasTable('notification_prefs');
  if (hasPrefs) {
    const hasCol = await knex.schema.hasColumn('notification_prefs', 'tech_arrived_channel');
    if (hasCol) {
      await knex.schema.alterTable('notification_prefs', (t) => t.dropColumn('tech_arrived_channel'));
    }
  }

  const hasTemplates = await knex.schema.hasTable('email_templates');
  if (hasTemplates) {
    const template = await knex('email_templates').where({ template_key: TEMPLATE.key }).first();
    if (template) {
      const hasVersions = await knex.schema.hasTable('email_template_versions');
      // Break the templates→versions FK before deleting versions.
      await knex('email_templates').where({ id: template.id }).update({ active_version_id: null });
      if (hasVersions) {
        await knex('email_template_versions').where({ template_id: template.id }).del();
      }
      await knex('email_templates').where({ id: template.id }).del();
    }
  }
};
