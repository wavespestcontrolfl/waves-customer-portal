// Separate copy for a confirmed anchor whose later visits await placement.
// Existing templates and administrator edits are preserved.
const TEMPLATE = {
  template_key: 'appointment_recurring_placement_confirmed',
  name: 'Recurring Appointment Placement Confirmation',
  category: 'service',
  body: "Hello {first_name}! Your next Waves visit is set for {start_date}{window_text}. Later visits will be arranged within 3 days of each new due date. Existing commitments stay unchanged until we review them with you. Reply STOP to opt out.",
  variables: JSON.stringify(['first_name', 'start_date', 'window_text']),
  is_active: true,
  is_internal: false,
  sort_order: 20,
};

exports.TEMPLATE = TEMPLATE;
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const inserted = await knex('sms_templates').insert(TEMPLATE)
    .onConflict('template_key').ignore().returning('id');
  if (inserted.length && await knex.schema.hasTable('audit_log')) {
    await require('../../services/audit-log').recordAuditEvent({
      actor_type: 'system', action: 'sms_template.seeded', resource_type: 'sms_template',
      resource_id: inserted[0].id,
      metadata: { templateKey: TEMPLATE.template_key, migration: '20260906000040_recurring_dispatch_sms' },
      trx: knex, critical: true,
    });
  }
};

exports.down = async function down() {
  // Intentional no-op: a seeded template may now carry administrator edits.
};
