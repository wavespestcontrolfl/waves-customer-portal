exports.up = async function up(knex) {
  const hasColumn = await knex.schema.hasColumn('sms_templates', 'trigger_event_key');
  if (!hasColumn) {
    await knex.schema.alterTable('sms_templates', (t) => {
      t.string('trigger_event_key', 120).nullable();
      t.index(['trigger_event_key']);
    });
  }

  const pairs = [
    ['estimate_sent', 'estimate.sent'],
    ['estimate_followup_unviewed', 'estimate.sent'],
    ['estimate_followup_viewed', 'estimate.viewed'],
    ['estimate_followup_expiring', 'estimate.expiring_soon'],
    ['estimate_followup_final', 'estimate.followup_final'],
    ['estimate_accepted_customer', 'onboarding.created'],
    ['estimate_auto_renewed', 'estimate.auto_renewed'],
    ['invoice_sent', 'invoice.sent'],
    ['invoice_receipt', 'invoice.paid'],
    ['payment_failed', 'payment.failed'],
    ['appointment_confirmation', 'appointment.booked'],
    ['service_complete', 'service_report.ready'],
    ['self_booking_confirmation', 'appointment.booked'],
    ['auto_new_recurring', 'customer.recurring_created'],
  ];

  for (const [templateKey, eventKey] of pairs) {
    await knex('sms_templates')
      .where({ template_key: templateKey })
      .update({ trigger_event_key: eventKey });
  }
};

exports.down = async function down(knex) {
  const hasColumn = await knex.schema.hasColumn('sms_templates', 'trigger_event_key');
  if (!hasColumn) return;
  await knex.schema.alterTable('sms_templates', (t) => {
    t.dropIndex(['trigger_event_key']);
    t.dropColumn('trigger_event_key');
  });
};
