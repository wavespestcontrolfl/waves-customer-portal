/**
 * Auto Pay setup link SMS — lane-neutral charge unit.
 *
 * The seeded autopay_setup_link body said "each visit is paid automatically
 * after it is completed", but the link is offered to per-APPLICATION
 * customers too (billingLaneSupported), where the charge unit is the
 * application, not the visit (GH Codex #3812 r5 P1). Rewords only the
 * still-seeded body: an owner-edited template is never clobbered (the WHERE
 * pins the exact seeded text). Reversible.
 */
const TEMPLATE_KEY = 'autopay_setup_link';
const SEEDED = 'Hi {first_name}! Set up Auto Pay for your Waves service here: {secure_link}\nSave a payment method and each visit is paid automatically after it is completed. Nothing is charged today. We never take card numbers by phone. Reply STOP to opt out.';
const NEUTRAL = 'Hi {first_name}! Set up Auto Pay for your Waves service here: {secure_link}\nSave a payment method and each completed service is paid automatically. Nothing is charged today. We never take card numbers by phone. Reply STOP to opt out.';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await knex('sms_templates')
    .where({ template_key: TEMPLATE_KEY, body: SEEDED })
    .update({ body: NEUTRAL, updated_at: new Date() });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await knex('sms_templates')
    .where({ template_key: TEMPLATE_KEY, body: NEUTRAL })
    .update({ body: SEEDED, updated_at: new Date() });
};
