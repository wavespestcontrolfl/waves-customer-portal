'use strict';

/**
 * Seed the cancellation-request confirmation email template.
 *
 * Used as the FALLBACK when the dedicated cancellation SMS cannot be delivered
 * (no phone / landline / opted out): by that point the auto-processor has
 * churned the account (active=false), which blocks portal auth, so without
 * this email the customer would get no confirmation at all and could not see
 * the request in the portal either. Deliberately carries NO portal CTA — links
 * into the authenticated portal would be dead ends for an inactive account.
 * Copy mirrors the service_cancellation_confirmation SMS (20260701000002).
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';

// Same shared set the account/membership seed uses (20260521000003) — these
// are auto-injected by account-membership-email sendTemplate. The blocks below
// intentionally never reference customer_portal_url.
const SHARED_VARIABLES = [
  'first_name',
  'customer_name',
  'customer_portal_url',
  'company_phone',
  'company_email',
];

const TEMPLATE = {
  key: 'account.cancellation_received',
  name: 'Portal Cancellation Request Received',
  category: 'account',
  sensitivity: 'account',
  description:
    'Confirmation sent when a customer submits a cancellation request from the portal — fallback for an undeliverable cancellation SMS. No portal links: the account is inactive by the time this sends.',
  required: ['first_name'],
  optional: ['request_id', 'request_subject', 'submitted_at'],
  subject: 'We received your cancellation request',
  preview: 'Our team will follow up to confirm.',
  blocks: [
    { type: 'paragraph', content: 'Hello {{first_name}},' },
    { type: 'paragraph', content: 'We received your cancellation request and sent it to the Waves team. Our team will follow up to confirm the details with you.' },
    { type: 'details', rows: [
      { label: 'Request', value: '{{request_subject}}' },
      { label: 'Submitted', value: '{{submitted_at}}' },
    ] },
    { type: 'paragraph', content: 'If you have questions — or did not make this request — reply to this email or call us at {{company_phone}}.' },
    { type: 'signature', content: 'Thank you, The Waves Team' },
  ],
};

const PREVIEW_PAYLOAD = {
  first_name: 'Stan',
  customer_name: 'Stan Example',
  customer_portal_url: 'https://portal.wavespestcontrol.com/login',
  company_phone: '(941) 555-0000',
  company_email: SERVICE_FROM,
  request_id: 'REQ-1001',
  request_subject: 'Cancel my service',
  submitted_at: 'July 1, 2026',
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

  await upsertTemplate(knex, TEMPLATE);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  await knex('email_templates').where({ template_key: TEMPLATE.key }).del();
};

exports.__private = { TEMPLATE, templateRow };
