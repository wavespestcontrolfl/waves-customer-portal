// Lease marker for deferred completion-SMS review intent retries. The cron
// claims rows before creating review_requests so multiple workers/ticks do not
// race the same review intent.
exports.up = async (knex) => {
  const hasClaim = await knex.schema.hasColumn('scheduled_services', 'completion_sms_review_claim_at');
  if (!hasClaim) {
    await knex.schema.alterTable('scheduled_services', (t) => {
      t.timestamp('completion_sms_review_claim_at').nullable();
    });
  }
};

exports.down = async (knex) => {
  const hasClaim = await knex.schema.hasColumn('scheduled_services', 'completion_sms_review_claim_at');
  if (hasClaim) {
    await knex.schema.alterTable('scheduled_services', (t) => {
      t.dropColumn('completion_sms_review_claim_at');
    });
  }
};
