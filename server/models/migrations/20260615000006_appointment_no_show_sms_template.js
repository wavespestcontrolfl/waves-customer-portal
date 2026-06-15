/**
 * Seed the appointment_no_show SMS template.
 *
 * Sent when an operator taps "Mark as no-show" on the dispatch
 * appointment sheet (admin-dispatch PUT /:id/status, status='no_show').
 * The tech's first name personalizes the greeting; {time} is the
 * appointment's scheduled start. Mirrors the seed pattern used for the
 * reschedule/cancel templates (20260506000007).
 */
const NO_SHOW_BODY =
  "Hi {first_name}, it's {tech_name} from Waves Pest Control. We missed you for your service today at {time}. "
  + "If you'd like to get back on the schedule, just reply to this message or give us a call and we'll find a new time.";

const TEMPLATE = {
  template_key: 'appointment_no_show',
  name: 'Appointment No-Show',
  category: 'service',
  body: NO_SHOW_BODY,
  variables: JSON.stringify(['first_name', 'tech_name', 'time']),
  sort_order: 8,
};

exports.up = async function up(knex) {
  const hasTemplates = await knex.schema.hasTable('sms_templates');
  if (!hasTemplates) return;

  const cols = await knex('sms_templates').columnInfo();
  const now = new Date();

  const existing = await knex('sms_templates')
    .where({ template_key: TEMPLATE.template_key })
    .first();

  const row = {
    ...TEMPLATE,
    ...(cols.updated_at ? { updated_at: now } : {}),
  };

  if (existing) {
    await knex('sms_templates')
      .where({ template_key: TEMPLATE.template_key })
      .update(row);
  } else {
    await knex('sms_templates').insert({
      ...row,
      ...(cols.is_active ? { is_active: true } : {}),
      ...(cols.created_at ? { created_at: now } : {}),
    });
  }
};

exports.down = async function down(knex) {
  const hasTemplates = await knex.schema.hasTable('sms_templates');
  if (!hasTemplates) return;
  await knex('sms_templates').where({ template_key: TEMPLATE.template_key }).del();
};
