'use strict';

// This read-only preflight sorts before the immutable 000090 publisher on
// fresh installs. PR previews that already published 000090 are checked
// against its audited source version, so later staff edits remain untouched.
const { TEMPLATE: APP_V4 } = require('./20260708000011_app_intro_email_v4_track_reminders');

function assertOriginalTour(blocks) {
  for (const seed of APP_V4.blocks) {
    if (seed.type === 'signature' || ['app_store_url', 'play_store_url'].includes(seed.url_variable)
      || (seed.type === 'small_note' && seed.content?.startsWith('Already have the app?'))) continue;
    const key = `${seed.type}:${seed.content || seed.src || ''}`;
    if (!blocks.some(b => `${b.type}:${b.content || b.src || ''}` === key)) {
      throw new Error('App onboarding: edited app tour block; review the active template before publishing');
    }
  }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  const template = await knex('email_templates').where({ template_key: 'app_intro' }).first();
  if (!template?.active_version_id) return;
  const audit = await knex('audit_log').where({ action: 'migration:20260907000090:publish', resource_id: template.id }).first();
  const metadata = typeof audit?.metadata === 'string' ? JSON.parse(audit.metadata) : audit?.metadata;
  const version = await knex('email_template_versions').where({
    id: metadata?.prior_version_id || template.active_version_id, template_id: template.id,
  }).first();
  if (!version) throw new Error('App onboarding: source app tour version is missing');
  const blocks = typeof version.blocks === 'string' ? JSON.parse(version.blocks) : version.blocks;
  assertOriginalTour(blocks || []);
};

exports.down = async function down() {
  // Read-only validation; no data to revert.
};

exports.assertOriginalTour = assertOriginalTour;
