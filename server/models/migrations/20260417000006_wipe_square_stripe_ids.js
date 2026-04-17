exports.up = async (knex) => {
  await knex.transaction(async (trx) => {
    await trx('customers').update({
      stripe_customer_id: null,
      autopay_payment_method_id: null,
      autopay_enabled: false,
    });

    await trx('payment_methods').update({
      stripe_customer_id: null,
      stripe_payment_method_id: null,
      autopay_enabled: false,
    });

    // Reap zombie failed-payment rows. payments.status is a Postgres enum
    // (upcoming|processing|paid|failed|refunded) with no 'abandoned' value —
    // extending it would require a separate non-transactional migration.
    // Instead: keep status='failed', clear next_retry_at to pull them out of
    // the retry cron's query, and tag failure_reason so admin UIs can filter.
    await trx('payments')
      .where({ status: 'failed' })
      .update({
        failure_reason: 'square_to_stripe_migration',
        next_retry_at: null,
      });
  });
};

exports.down = async () => {
  // no-op, can't un-wipe
};
