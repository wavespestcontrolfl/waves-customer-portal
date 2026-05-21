async function hasMigration(knex, name) {
  try {
    const row = await knex('knex_migrations').where({ name }).first();
    return !!row;
  } catch {
    return false;
  }
}

async function applyEmailTemplateRenderingFixes(knex) {
  await knex('email_preference_groups')
    .where({ key: 'service_operational' })
    .update({
      user_can_unsubscribe: false,
      updated_at: new Date(),
    });

  await knex('email_templates')
    .where('template_key', 'like', 'codex.smoke.%')
    .update({
      status: 'archived',
      updated_at: new Date(),
    });
}

async function revertEmailTemplateRenderingFixes(knex) {
  await knex('email_preference_groups')
    .where({ key: 'service_operational' })
    .update({
      user_can_unsubscribe: true,
      updated_at: new Date(),
    });
}

exports.up = async function up(knex) {
  if (await hasMigration(knex, '20260518000005_email_template_rendering_fixes.js')) return;
  await applyEmailTemplateRenderingFixes(knex);
};

exports.down = async function down(knex) {
  if (await hasMigration(knex, '20260518000005_email_template_rendering_fixes.js')) return;
  await revertEmailTemplateRenderingFixes(knex);
};

exports.applyEmailTemplateRenderingFixes = applyEmailTemplateRenderingFixes;
exports.revertEmailTemplateRenderingFixes = revertEmailTemplateRenderingFixes;
exports.hasMigration = hasMigration;
