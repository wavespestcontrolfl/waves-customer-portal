/**
 * Retire the legacy rain_out_moved template (cleanup after #2870).
 *
 * #2870 seeds rain_out_moved_v2 (forecast-grounded lead) and its code
 * renders v2 with the legacy row only as a rollback fallback. Once that
 * deploy is verified, the legacy row and its variants are dead weight in
 * the admin editor — deactivate them so operators can't edit copy that
 * no longer sends. MUST NOT merge before #2870 is deployed: deactivating
 * the legacy row while old code still serves would null its render and
 * skip the rain-out SMS entirely.
 */

const LEGACY_KEY = 'rain_out_moved';
const DESCRIPTION = 'Retired 2026-07-19 — superseded by rain_out_moved_v2 (forecast-grounded lead, PR #2870). Kept as the rollback fallback body; do not delete.';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const cols = await knex('sms_templates').columnInfo();
  await knex('sms_templates').where({ template_key: LEGACY_KEY }).update({
    ...(cols.is_active ? { is_active: false } : {}),
    ...(cols.description ? { description: DESCRIPTION } : {}),
    ...(cols.updated_at ? { updated_at: new Date() } : {}),
  });

  if (await knex.schema.hasTable('sms_template_variants')) {
    await knex('sms_template_variants')
      .where({ template_key: LEGACY_KEY, status: 'active' })
      .update({ status: 'retired' });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const cols = await knex('sms_templates').columnInfo();
  if (!cols.is_active) return;
  await knex('sms_templates').where({ template_key: LEGACY_KEY }).update({
    is_active: true,
    ...(cols.updated_at ? { updated_at: new Date() } : {}),
  });
};
