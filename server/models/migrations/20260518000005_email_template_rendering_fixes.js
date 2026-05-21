const {
  applyEmailTemplateRenderingFixes,
  revertEmailTemplateRenderingFixes,
  hasMigration,
} = require('./20260518000004_email_template_rendering_fixes');

exports.up = async function up(knex) {
  if (await hasMigration(knex, '20260518000004_email_template_rendering_fixes.js')) return;
  await applyEmailTemplateRenderingFixes(knex);
};

exports.down = async function down(knex) {
  if (await hasMigration(knex, '20260518000004_email_template_rendering_fixes.js')) return;
  await revertEmailTemplateRenderingFixes(knex);
};
