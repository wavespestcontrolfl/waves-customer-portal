// Adds a deferred-send queue for the post-completion customer SMS.
// When the tech checks "Schedule for later" on the Complete Service modal,
// the completion still happens immediately (status flip, service_record,
// products, audit log) — only the customer-facing notification is held
// until completion_sms_scheduled_at, at which point a 5-minute cron tick
// dispatches it via Twilio and stamps completion_sms_sent_at. The body is
// fully rendered at completion time (template choice depends on whether
// an invoice was created, whether the visit was prepaid, etc.) and stored
// here verbatim so the cron doesn't have to re-derive that branching.
exports.up = async (knex) => {
  await knex.schema.alterTable('scheduled_services', (t) => {
    t.timestamp('completion_sms_scheduled_at').nullable();
    t.text('completion_sms_body').nullable();
    t.string('completion_sms_message_type').nullable();
    t.timestamp('completion_sms_claimed_at').nullable();
    t.timestamp('completion_sms_sent_at').nullable();
    t.boolean('completion_sms_request_review').notNullable().defaultTo(false);
    t.uuid('completion_sms_review_service_record_id')
      .nullable()
      .references('id').inTable('service_records').onDelete('SET NULL');
  });
};

exports.down = async (knex) => {
  await knex.schema.alterTable('scheduled_services', (t) => {
    t.dropColumn('completion_sms_review_service_record_id');
    t.dropColumn('completion_sms_request_review');
    t.dropColumn('completion_sms_scheduled_at');
    t.dropColumn('completion_sms_body');
    t.dropColumn('completion_sms_message_type');
    t.dropColumn('completion_sms_claimed_at');
    t.dropColumn('completion_sms_sent_at');
  });
};
