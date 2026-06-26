/**
 * (Re)seed the editable `tech_arrived` SMS template.
 *
 * The original tech_arrived template was deleted in
 * 20260615000001_sms_templates_remove_arrival_and_labels.js (bundled
 * with an onboarding-template cleanup), which left sendTechArrived()
 * dead — getTemplate('tech_arrived') returned null and the send was
 * skipped. The automated arrival notification (owner directive
 * 2026-06-25) re-lights it, fired from track-transitions markOnProperty.
 *
 * Copy is "arrived at your property" — no "on the way" (that's en-route),
 * no live-track link (the customer is already on site). Mirrors the
 * upsert shape of 20260507000001_update_tech_en_route_sms_template.js.
 */
const BODY = 'Hello {first_name}! {tech_name} has arrived at your property for your scheduled service.\n\nQuestions or requests? Reply to this message. Reply STOP to opt out.';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  const cols = await knex('sms_templates').columnInfo();
  const now = new Date();
  const row = {
    template_key: 'tech_arrived',
    name: 'Tech Arrived',
    category: 'service',
    body: BODY,
    variables: JSON.stringify(['first_name', 'tech_name']),
    sort_order: 4,
    ...(cols.is_active ? { is_active: true } : {}),
    ...(cols.updated_at ? { updated_at: now } : {}),
  };

  const existing = await knex('sms_templates')
    .where({ template_key: 'tech_arrived' })
    .first();

  if (existing) {
    await knex('sms_templates')
      .where({ template_key: 'tech_arrived' })
      .update(row);
  } else {
    await knex('sms_templates').insert({
      ...row,
      ...(cols.created_at ? { created_at: now } : {}),
    });
  }
};

exports.down = async function down(knex) {
  // Remove the seeded template on rollback so it restores the prior
  // (deleted/dead) state. This matters because the pre-PR code paths
  // (geofence-handler, tech-notifications) call sendTechArrived directly
  // and do NOT check GATE_TECH_ARRIVED_SMS — leaving the template active
  // after a rollback would re-enable ungated customer arrival texts.
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  if (await knex.schema.hasTable('sms_template_variants')) {
    await knex('sms_template_variants')
      .where({ template_key: 'tech_arrived' })
      .del();
  }
  await knex('sms_templates')
    .where({ template_key: 'tech_arrived' })
    .del();
};
