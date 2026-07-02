/**
 * Activate the prep.bed_bug / prep.cockroach email template automations.
 *
 * Both were seeded as draft in 20260518000001 while nothing emitted the
 * appointment.booked trigger. The appointment tagger now emits that trigger
 * for cockroach / bed bug bookings, so flip the two automations live.
 *
 * Only rows still in draft are touched — an operator-set active / paused /
 * archived status is preserved.
 */

const AUTOMATION_KEYS = ['prep.bed_bug', 'prep.cockroach'];

exports.AUTOMATION_KEYS = AUTOMATION_KEYS;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_template_automations'))) return;

  await knex('email_template_automations')
    .whereIn('automation_key', AUTOMATION_KEYS)
    .where({ status: 'draft' })
    .update({ status: 'active', updated_at: knex.fn.now() });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('email_template_automations'))) return;

  await knex('email_template_automations')
    .whereIn('automation_key', AUTOMATION_KEYS)
    .where({ status: 'active' })
    .update({ status: 'draft', updated_at: knex.fn.now() });
};
