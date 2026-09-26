'use strict';

// Payment-receipt variant of billing.notice (20260924010300 + its two
// corrections, 010400/010500). A deposit `payment_receipt` send needs its
// own template key so withheldLinkPolicyForTemplate resolves 'rewrite'
// (estimate-annual-guard.js) instead of billing.notice's 'refuse' — the
// generic template made a receipt whose SMS twin carries a withheld
// estimate link get silently dropped instead of delivered with the link
// rewritten, same precedent as estimate-deposits.js's SMS receipt path.
// Seeded directly in the FINAL corrected shape billing.notice ended up in
// (no wrapper greeting, required variables without first_name) rather than
// replaying its two-step correction — there is no earlier deployed shape
// of this key to preserve.
const KEY = 'billing.receipt_notice';
const SERVICE_FROM = process.env.SERVICE_EMAIL_FROM || 'contact@wavespestcontrol.com';

exports.up = async function up(knex) {
  for (const table of ['email_templates', 'email_template_versions', 'email_template_fixtures']) {
    if (!await knex.schema.hasTable(table)) return;
  }
  if (await knex('email_templates').where({ template_key: KEY }).first('id')) return;

  const [template] = await knex('email_templates').insert({
    template_key: KEY,
    name: 'Billing receipt notice',
    mode: 'service',
    purpose: 'billing',
    description: 'Email delivery of automated payment-receipt billing notification copy (deposit/invoice payment_receipt category).',
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
    required_variables: JSON.stringify(['category_label', 'notification_body', 'billing_url']),
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
    name: 'Payment receipt',
    is_default: true,
    payload: JSON.stringify({
      first_name: 'Customer',
      category_label: 'Payment receipt',
      notification_body: 'Your payment was received. Thank you.',
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
      metadata: { templateKey: KEY, migration: '20260926000100_billing_receipt_notice_email_template' },
      trx: knex,
      critical: true,
    });
  }
};

// Template versions may have delivery history or operator edits. Preserve them.
exports.down = async function down() {};
