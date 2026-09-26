'use strict';

const { isDeepStrictEqual } = require('node:util');

const KEY = 'billing.notice';
const MIGRATION = '20260924010500_billing_notice_required_variables';
const OLD_REQUIRED = ['first_name', 'category_label', 'notification_body', 'billing_url'];
const NEW_REQUIRED = OLD_REQUIRED.filter((variable) => variable !== 'first_name');
const CORRECTED_BLOCKS = [
  { type: 'heading', content: '{{category_label}}' },
  { type: 'paragraph', content: '{{notification_body}}' },
  { type: 'cta', label: 'Open billing', url_variable: 'billing_url' },
];

function json(value, fallback) {
  if (value == null) return fallback;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

exports.up = async function up(knex) {
  for (const table of ['email_templates', 'email_template_versions']) {
    if (!await knex.schema.hasTable(table)) return;
  }
  const template = await knex('email_templates').where({ template_key: KEY }).forUpdate().first();
  if (!template?.active_version_id
    || !isDeepStrictEqual(json(template.required_variables, []), OLD_REQUIRED)) return;
  const active = await knex('email_template_versions')
    .where({ id: template.active_version_id, template_id: template.id }).first();
  const exactCorrection = active?.status === 'active'
    && active.subject === '{{category_label}} from Waves'
    && active.preview_text === '{{notification_body}}'
    && active.text_body == null
    && isDeepStrictEqual(json(active.blocks, []), CORRECTED_BLOCKS);
  if (!exactCorrection) return;

  await knex('email_templates').where({ id: template.id }).update({
    required_variables: JSON.stringify(NEW_REQUIRED), updated_at: new Date(),
  });
  if (await knex.schema.hasTable('audit_log')) {
    await require('../../services/audit-log').recordAuditEvent({
      actor_type: 'system',
      action: 'email_template.required_variables_corrected',
      resource_type: 'email_template',
      resource_id: template.id,
      metadata: { templateKey: KEY, migration: MIGRATION, activeVersionId: active.id },
      trx: knex,
      critical: true,
    });
  }
};

exports.down = async function down() {
  // Preserve corrected metadata and subsequent operator edits.
};
