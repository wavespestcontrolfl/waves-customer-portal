'use strict';

const { isDeepStrictEqual } = require('node:util');

const KEY = 'billing.notice';
const MIGRATION = '20260924010400_billing_notice_remove_duplicate_greeting';
const OLD_BLOCKS = [
  { type: 'heading', content: '{{category_label}}' },
  { type: 'paragraph', content: 'Hi {{first_name}},' },
  { type: 'paragraph', content: '{{notification_body}}' },
  { type: 'cta', label: 'Open billing', url_variable: 'billing_url' },
];
const NEW_BLOCKS = OLD_BLOCKS.filter((block) => block.content !== 'Hi {{first_name}},');
const OLD_FIXTURE = {
  first_name: 'Customer',
  category_label: 'Billing reminder',
  notification_body: 'Please review the billing update in your customer portal.',
  billing_url: 'https://portal.wavespestcontrol.com/?tab=billing',
};
const NEW_FIXTURE = { ...OLD_FIXTURE,
  notification_body: 'Hi Customer, please review the billing update in your customer portal.' };

function json(value, fallback) {
  if (value == null) return fallback;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

exports.up = async function up(knex) {
  for (const table of ['email_templates', 'email_template_versions', 'email_template_fixtures']) {
    if (!await knex.schema.hasTable(table)) return;
  }
  const template = await knex('email_templates').where({ template_key: KEY }).forUpdate().first();
  if (!template?.active_version_id) return;
  const active = await knex('email_template_versions')
    .where({ id: template.active_version_id, template_id: template.id }).first();
  if (!active) return;

  let publishedVersionId = null;
  const exactSeed = active.status === 'active'
    && active.subject === '{{category_label}} from Waves'
    && active.preview_text === '{{notification_body}}'
    && active.text_body == null
    && isDeepStrictEqual(json(active.blocks, []), OLD_BLOCKS);
  if (exactSeed) {
    const latest = await knex('email_template_versions').where({ template_id: template.id })
      .max('version_number as max').first();
    const [published] = await knex('email_template_versions').insert({
      template_id: template.id,
      version_number: Number(latest?.max || 0) + 1,
      status: 'active',
      subject: active.subject,
      preview_text: active.preview_text,
      blocks: JSON.stringify(NEW_BLOCKS),
      text_body: active.text_body,
      validation_snapshot: active.validation_snapshot,
      published_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    }).returning('id');
    publishedVersionId = published.id;
    await knex('email_template_versions').where({ id: active.id }).update({ status: 'archived', updated_at: new Date() });
    await knex('email_templates').where({ id: template.id }).update({
      active_version_id: published.id, last_published_at: new Date(), updated_at: new Date(),
    });
  }

  let fixtureCorrected = false;
  const fixtures = await knex('email_template_fixtures').where({ template_id: template.id });
  for (const fixture of fixtures) {
    if (!isDeepStrictEqual(json(fixture.payload, {}), OLD_FIXTURE)) continue;
    await knex('email_template_fixtures').where({ id: fixture.id }).update({
      payload: JSON.stringify(NEW_FIXTURE), updated_at: new Date(),
    });
    fixtureCorrected = true;
  }
  if ((publishedVersionId || fixtureCorrected) && await knex.schema.hasTable('audit_log')) {
    await require('../../services/audit-log').recordAuditEvent({
      actor_type: 'system',
      action: 'email_template.corrected',
      resource_type: 'email_template',
      resource_id: template.id,
      metadata: { templateKey: KEY, migration: MIGRATION, priorVersionId: active.id,
        publishedVersionId, fixtureCorrected },
      trx: knex,
      critical: true,
    });
  }
};

exports.down = async function down() {
  // Preserve published history, delivery references and subsequent operator edits.
};
