// Re-activate the appointment.tech_arrived email template version.
//
// #3247 (2026-08-06) retired the arrival EMAIL leg and the owner archived the
// template's active version by hand (email_templates row stayed `active`,
// its active_version_id kept pointing at the now-`archived` version). On the
// owner's 2026-09-06 go the email leg is restored (Text / Email / Both for
// Tech Arrived), so the version it renders from goes back to `active`.
//
// Data only, one row, no customer communications. `down` re-archives the
// same version so the retire state is reproducible.
const TEMPLATE_KEY = 'appointment.tech_arrived';

async function activeVersionFor(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return null;
  const template = await knex('email_templates').where({ template_key: TEMPLATE_KEY }).first('id', 'active_version_id');
  if (!template?.active_version_id) return null;
  return knex('email_template_versions').where({ id: template.active_version_id }).first('id', 'status');
}

exports.up = async function up(knex) {
  const version = await activeVersionFor(knex);
  if (!version) { console.log('[20260906000020] no appointment.tech_arrived active version — nothing to do'); return; }
  if (version.status === 'active') { console.log('[20260906000020] version already active'); return; }
  await knex('email_template_versions').where({ id: version.id }).update({ status: 'active', updated_at: new Date() });
  console.log(`[20260906000020] re-activated template version ${version.id} (was ${version.status})`);
};

exports.down = async function down(knex) {
  const version = await activeVersionFor(knex);
  if (!version || version.status !== 'active') return;
  await knex('email_template_versions').where({ id: version.id }).update({ status: 'archived', updated_at: new Date() });
  console.log(`[20260906000020] re-archived template version ${version.id}`);
};
