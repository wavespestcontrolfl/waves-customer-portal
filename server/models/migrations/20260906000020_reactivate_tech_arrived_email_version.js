// Re-activate the appointment.tech_arrived email template (and its version).
//
// #3247 (2026-08-06) retired the arrival EMAIL leg and the owner archived the
// template's active version by hand (the email_templates row itself stayed
// `active`, its active_version_id still pointing at the now-`archived`
// version). On the owner's 2026-09-06 go the email leg is restored (Text /
// Email / Both for Tech Arrived), so both rows go to `active`.
//
// `down` is the global kill switch and must actually stop sends: the
// library's assertTemplateSendable checks email_templates.status (it follows
// active_version_id regardless of the version's own status), so rollback
// archives the TEMPLATE row as well as the version. The arrival sender then
// gets a deterministic email miss and falls back to / stays on SMS.
//
// Data only, two rows, no customer communications.
const TEMPLATE_KEY = 'appointment.tech_arrived';

async function templateAndVersion(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return {};
  const template = await knex('email_templates').where({ template_key: TEMPLATE_KEY }).first('id', 'status', 'active_version_id');
  if (!template) return {};
  const version = template.active_version_id
    ? await knex('email_template_versions').where({ id: template.active_version_id }).first('id', 'status')
    : null;
  return { template, version };
}

exports.up = async function up(knex) {
  const { template, version } = await templateAndVersion(knex);
  if (!template) { console.log('[20260906000020] no appointment.tech_arrived template — nothing to do'); return; }
  if (template.status !== 'active') {
    await knex('email_templates').where({ id: template.id }).update({ status: 'active', updated_at: new Date() });
  }
  if (version && version.status !== 'active') {
    await knex('email_template_versions').where({ id: version.id }).update({ status: 'active', updated_at: new Date() });
  }
  console.log(`[20260906000020] appointment.tech_arrived active (template was ${template.status}, version was ${version?.status || 'none'})`);
};

exports.down = async function down(knex) {
  const { template, version } = await templateAndVersion(knex);
  if (!template) return;
  await knex('email_templates').where({ id: template.id }).update({ status: 'archived', updated_at: new Date() });
  if (version) await knex('email_template_versions').where({ id: version.id }).update({ status: 'archived', updated_at: new Date() });
  console.log('[20260906000020] appointment.tech_arrived archived (template + version) — arrival emails stop');
};
