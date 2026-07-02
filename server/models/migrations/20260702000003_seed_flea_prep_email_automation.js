/**
 * Seed the prep.flea email template automation.
 *
 * The prep.flea template shipped with the prep guide library
 * (20260521000004 / 20260526000009) but, unlike prep.bed_bug and
 * prep.cockroach, never got an email_template_automations row. The
 * appointment tagger now emits appointment.booked for flea bookings, so
 * seed the automation active (mirroring 20260702000002, which activated
 * the bed bug / cockroach rows).
 *
 * Idempotent: skips if the row already exists or the template is missing.
 */

const AUTOMATION = {
  automation_key: 'prep.flea',
  name: 'Flea prep guide',
  description: 'Prep instructions before a flea treatment.',
  trigger_event_key: 'appointment.booked',
  trigger_description: 'Prep instructions before a flea treatment.',
  template_key: 'prep.flea',
  delay_minutes: 0,
  audience: 'customer',
  status: 'active',
  legal_classification: 'transactional_relationship',
  frequency_cap: 'once_per_appointment',
  idempotency_key_template: 'prep.flea:{scheduled_service_id}',
  conditions: JSON.stringify({ service_type_contains: ['flea'] }),
  exit_conditions: JSON.stringify({ stop_if: ['appointment.cancelled'] }),
  retry_policy: JSON.stringify({ max_attempts: 2, backoff_minutes: [15, 60] }),
  quiet_hours: JSON.stringify({ enabled: false }),
  timezone: 'America/New_York',
  owner: 'operations',
  dry_run_notes: 'Counts upcoming scheduled services with flea in the service type.',
};

exports.AUTOMATION = AUTOMATION;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_template_automations'))) return;

  const existing = await knex('email_template_automations')
    .where({ automation_key: AUTOMATION.automation_key })
    .first();
  if (existing) return;

  const template = await knex('email_templates')
    .where({ template_key: AUTOMATION.template_key })
    .first();
  if (!template) return;

  await knex('email_template_automations').insert({
    ...AUTOMATION,
    suppression_group_key: template.suppression_group_key || template.send_stream || null,
    last_published_at: new Date(),
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('email_template_automations'))) return;

  await knex('email_template_automations')
    .where({ automation_key: AUTOMATION.automation_key })
    .del();
};
