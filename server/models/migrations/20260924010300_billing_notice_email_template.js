'use strict';

const KEY = 'billing.notice';
const SERVICE_FROM = process.env.SERVICE_EMAIL_FROM || 'contact@wavespestcontrol.com';

exports.up = async function up(knex) {
  for (const table of ['email_templates', 'email_template_versions', 'email_template_fixtures']) {
    if (!await knex.schema.hasTable(table)) return;
  }
  if (await knex('email_templates').where({ template_key: KEY }).first('id')) return;

  const [template] = await knex('email_templates').insert({
    template_key: KEY,
    name: 'Billing notice',
    mode: 'service',
    purpose: 'billing',
    description: 'Email delivery of existing automated billing notification copy.',
    legal_classification: 'transactional_relationship',
    audience: 'customer',
    message_priority: 'normal',
    content_sensitivity: 'financial',
    send_stream: 'transactional_required',
    suppression_group_key: 'transactional_required',
    layout_wrapper_id: 'service_default_v1',
    from_name: 'Waves Pest Control',
    from_email: SERVICE_FROM,
    reply_to: SERVICE_FROM,
    status: 'active',
    allowed_variables: JSON.stringify(['first_name', 'category_label', 'notification_body', 'billing_url']),
    required_variables: JSON.stringify(['first_name', 'category_label', 'notification_body', 'billing_url']),
    optional_variables: JSON.stringify([]),
    default_cta_label: 'Open billing',
    default_cta_url_variable: 'billing_url',
    created_at: new Date(),
    updated_at: new Date(),
  }).returning('id');

  const [version] = await knex('email_template_versions').insert({
    template_id: template.id,
    version_number: 1,
    status: 'active',
    subject: '{{category_label}} from Waves',
    preview_text: '{{notification_body}}',
    blocks: JSON.stringify([
      { type: 'heading', content: '{{category_label}}' },
      { type: 'paragraph', content: 'Hi {{first_name}},' },
      { type: 'paragraph', content: '{{notification_body}}' },
      { type: 'cta', label: 'Open billing', url_variable: 'billing_url' },
    ]),
    published_at: knex.fn.now(),
    created_at: new Date(),
    updated_at: new Date(),
  }).returning('id');

  await knex('email_templates').where({ id: template.id }).update({
    active_version_id: version.id,
    last_published_at: knex.fn.now(),
  });
  await knex('email_template_fixtures').insert({
    template_id: template.id,
    name: 'Billing reminder',
    is_default: true,
    payload: JSON.stringify({
      first_name: 'Customer',
      category_label: 'Billing reminder',
      notification_body: 'Please review the billing update in your customer portal.',
      billing_url: 'https://portal.wavespestcontrol.com/?tab=billing',
    }),
    created_at: new Date(),
    updated_at: new Date(),
  });
  if (await knex.schema.hasTable('audit_log')) {
    await require('../../services/audit-log').recordAuditEvent({
      actor_type: 'system',
      action: 'email_template.seeded',
      resource_type: 'email_template',
      resource_id: template.id,
      metadata: { templateKey: KEY, migration: '20260924010300_billing_notice_email_template' },
      trx: knex,
      critical: true,
    });
  }
};

// Template versions may have delivery history or operator edits. Preserve them.
exports.down = async function down() {};
