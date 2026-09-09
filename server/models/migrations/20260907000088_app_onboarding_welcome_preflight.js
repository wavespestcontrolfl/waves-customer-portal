'use strict';

// Read-only protection for the immutable 000090 publisher. Fresh deployments
// validate before publication; an already-published preview validates its
// audited source. Staff edits require review rather than a lossy replacement.
const WELCOME_PARAGRAPHS = [
  'On the first recurring visit, your technician will inspect the property, treat the service areas, and note anything that needs attention on future visits.',
  'After service, you can review reports, upcoming visits, invoices, and account details in the customer portal.',
];
const PREFIXES = ['On the first recurring visit,', 'After service, you can review reports,'];

function assertOriginalWelcome(blocks) {
  for (const [index, prefix] of PREFIXES.entries()) {
    const paragraph = blocks.find(block => block.type === 'paragraph' && block.content?.startsWith(prefix));
    if (paragraph?.content !== WELCOME_PARAGRAPHS[index]) {
      throw new Error('App onboarding: edited welcome paragraph; review the active template before publishing');
    }
  }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  const template = await knex('email_templates').where({ template_key: 'welcome.new_recurring' }).first();
  if (!template?.active_version_id) return;
  const audit = await knex('audit_log').where({ action: 'migration:20260907000090:publish', resource_id: template.id }).first();
  const metadata = typeof audit?.metadata === 'string' ? JSON.parse(audit.metadata) : audit?.metadata;
  const version = await knex('email_template_versions').where({
    id: metadata?.prior_version_id || template.active_version_id, template_id: template.id,
  }).first();
  if (!version) throw new Error('App onboarding: source welcome version is missing');
  const blocks = typeof version.blocks === 'string' ? JSON.parse(version.blocks) : version.blocks;
  assertOriginalWelcome(blocks || []);
};

exports.down = async function down() {
  // Read-only validation; no data to revert.
};

exports.assertOriginalWelcome = assertOriginalWelcome;
exports.WELCOME_PARAGRAPHS = WELCOME_PARAGRAPHS;
