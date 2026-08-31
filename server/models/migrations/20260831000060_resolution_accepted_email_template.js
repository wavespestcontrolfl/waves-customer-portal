'use strict';

/**
 * Seed the accepted-resolution receipt email (cancel-flow C1).
 *
 * Sent alongside the confirmation SMS when a customer accepts the one
 * resolution card inside the cancel flow (Away Mode, hold, re-service,
 * retention offer, preferences, transfer, owner contact). The plan was NOT
 * cancelled — the copy confirms exactly what was set up and nothing more.
 * Structure mirrors 20260701000003 (cancellation_received).
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
  key: 'account.resolution_accepted',
  name: 'Cancel Flow Resolution Accepted',
  category: 'account',
  sensitivity: 'account',
  description:
    'Receipt sent when a customer accepts the resolution card inside the cancel flow — sent alongside the confirmation SMS. The plan stays; the email records exactly what was set up.',
  required: ['first_name', 'summary_line'],
  optional: ['reference', 'effects_text'],
  subject: 'Your plan stays — here is what we set up',
  preview: 'The change you accepted, in writing.',
  blocks: [
    { type: 'paragraph', content: 'Hello {{first_name}},' },
    { type: 'paragraph', content: '{{summary_line}}' },
    { type: 'paragraph', content: '{{effects_text}}' },
    { type: 'details', rows: [
      { label: 'Reference', value: '{{reference}}' },
    ] },
    { type: 'paragraph', content: 'This creates no term and no fee — you can still cancel any time from your portal. Questions, or did not make this change? Reply to this email or call us at {{company_phone}}.' },
    { type: 'signature', content: 'Thank you, The Waves Team' },
  ],
};

const PREVIEW_PAYLOAD = {
  first_name: 'Stan',
  customer_name: 'Stan Example',
  customer_portal_url: 'https://portal.wavespestcontrol.com/login',
  company_phone: '(941) 555-0000',
  company_email: SERVICE_FROM,
  reference: 'A1B2C3D4',
  summary_line: 'Lawn Care is on hold until December 1, 2026: no visits and no charges for it until then.',
  effects_text: 'Your WaveGuard level and prices stay locked; we text you 7 days before the restart so you can move the date or cancel.',
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
    content_sensitivity: t.sensitivity || 'account',
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

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  const existing = await knex('email_templates').where({ template_key: TEMPLATE.key }).first();
  let template = existing;
  const row = templateRow(TEMPLATE);
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
      subject: TEMPLATE.subject,
      preview_text: TEMPLATE.preview,
      blocks: JSON.stringify(TEMPLATE.blocks),
      text_body: null,
      published_at: new Date(),
      updated_at: new Date(),
    });
  } else {
    const latest = await knex('email_template_versions').where({ template_id: template.id }).max('version_number as max').first();
    [version] = await knex('email_template_versions').insert({
      template_id: template.id,
      version_number: Number(latest?.max || 0) + 1,
      status: 'active',
      subject: TEMPLATE.subject,
      preview_text: TEMPLATE.preview,
      blocks: JSON.stringify(TEMPLATE.blocks),
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

  if (await knex.schema.hasTable('email_template_fixtures')) {
    const fixture = await knex('email_template_fixtures').where({ template_id: template.id, is_default: true }).first();
    const payload = JSON.stringify(PREVIEW_PAYLOAD);
    if (fixture) {
      await knex('email_template_fixtures').where({ id: fixture.id }).update({ name: 'Happy path', payload, updated_at: new Date() });
    } else {
      await knex('email_template_fixtures').insert({
        template_id: template.id, name: 'Happy path', payload, is_default: true, created_at: new Date(), updated_at: new Date(),
      });
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  const template = await knex('email_templates').where({ template_key: TEMPLATE.key }).first('id');
  if (!template) return;
  // Retire rather than delete — versions/fixtures reference the row.
  await knex('email_templates').where({ id: template.id }).update({ status: 'archived', updated_at: new Date() });
};
