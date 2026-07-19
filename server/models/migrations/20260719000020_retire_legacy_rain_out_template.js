/**
 * Retire the legacy rain_out_moved template (cleanup after #2870).
 *
 * #2870 seeds rain_out_moved_v2 (forecast-grounded lead) and its code
 * renders v2 with the legacy row only as a rollback fallback. Once that
 * deploy is verified, the legacy row and its variants are dead weight in
 * the admin editor — deactivate them so operators can't edit copy that
 * no longer sends.
 *
 * SELF-GUARDING against out-of-order merges: retiring the legacy row
 * while the deployed code still renders it would null every rain-out
 * SMS, so the up() no-ops unless rain_out_moved_v2 already exists in
 * this database (i.e. #2870's migration has run). Trade-off if merged
 * early anyway: this runs once as a no-op and the cleanup silently
 * never happens — detectable post-merge (legacy row still is_active)
 * and re-shippable, which beats blocking every deploy with a throw or
 * killing customer texts.
 */

const LEGACY_KEY = 'rain_out_moved';
const V2_KEY = 'rain_out_moved_v2';
const DESCRIPTION = 'Retired 2026-07-19 — superseded by rain_out_moved_v2 (forecast-grounded lead, PR #2870). Kept as the rollback fallback body; do not delete.';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  const v2 = await knex('sms_templates').where({ template_key: V2_KEY }).first('id');
  if (!v2) return;

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

// Deliberate no-op: is_active doubles as the operator send kill switch,
// and up() can't know whether the row was already off by admin choice —
// a rollback that blindly re-enables could resume texts an operator had
// intentionally suppressed. Re-enabling after a rollback is a one-click
// admin toggle.
exports.down = async function down() {};
