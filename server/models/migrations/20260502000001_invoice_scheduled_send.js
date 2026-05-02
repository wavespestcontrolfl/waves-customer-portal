exports.up = async function (knex) {
  const hasScheduledSendAt = await knex.schema.hasColumn('invoices', 'scheduled_send_at');
  if (!hasScheduledSendAt) {
    await knex.schema.alterTable('invoices', t => {
      t.timestamp('scheduled_send_at').nullable();
      t.integer('scheduled_send_attempts').notNullable().defaultTo(0);
      t.text('scheduled_send_error');
      t.boolean('scheduled_request_review').notNullable().defaultTo(false);
      t.integer('scheduled_review_delay_minutes');
      t.index(['status', 'scheduled_send_at']);
    });
  }
  const hasScheduledRequestReview = await knex.schema.hasColumn('invoices', 'scheduled_request_review');
  if (!hasScheduledRequestReview) {
    await knex.schema.alterTable('invoices', t => {
      t.boolean('scheduled_request_review').notNullable().defaultTo(false);
      t.integer('scheduled_review_delay_minutes');
    });
  }
};

exports.down = async function (knex) {
  const hasScheduledSendAt = await knex.schema.hasColumn('invoices', 'scheduled_send_at');
  if (hasScheduledSendAt) {
    await knex.schema.alterTable('invoices', t => {
      t.dropIndex(['status', 'scheduled_send_at']);
      t.dropColumn('scheduled_review_delay_minutes');
      t.dropColumn('scheduled_request_review');
      t.dropColumn('scheduled_send_error');
      t.dropColumn('scheduled_send_attempts');
      t.dropColumn('scheduled_send_at');
    });
  }
};
