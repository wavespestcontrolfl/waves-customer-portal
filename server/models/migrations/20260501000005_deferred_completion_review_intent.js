// Backfill deferred completion-SMS review intent columns for environments
// that already ran 20260501000002 before review gating was added.
exports.up = async (knex) => {
  const hasRequestReview = await knex.schema.hasColumn('scheduled_services', 'completion_sms_request_review');
  const hasReviewServiceRecord = await knex.schema.hasColumn('scheduled_services', 'completion_sms_review_service_record_id');

  await knex.schema.alterTable('scheduled_services', (t) => {
    if (!hasRequestReview) {
      t.boolean('completion_sms_request_review').notNullable().defaultTo(false);
    }
    if (!hasReviewServiceRecord) {
      t.uuid('completion_sms_review_service_record_id')
        .nullable()
        .references('id').inTable('service_records').onDelete('SET NULL');
    }
  });
};

exports.down = async (knex) => {
  const hasRequestReview = await knex.schema.hasColumn('scheduled_services', 'completion_sms_request_review');
  const hasReviewServiceRecord = await knex.schema.hasColumn('scheduled_services', 'completion_sms_review_service_record_id');

  await knex.schema.alterTable('scheduled_services', (t) => {
    if (hasReviewServiceRecord) t.dropColumn('completion_sms_review_service_record_id');
    if (hasRequestReview) t.dropColumn('completion_sms_request_review');
  });
};
